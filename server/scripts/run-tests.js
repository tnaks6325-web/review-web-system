'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const SERVER_DIR = path.resolve(__dirname, '..');
const TEST_DIR = path.join(SERVER_DIR, 'tests');
const TEST_BOOTSTRAP = path.join(__dirname, 'test-bootstrap.js');
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const failFast = args.includes('--fail-fast');
const verbose = args.includes('--verbose');
const compact = args.includes('--compact');
const matchAt = args.indexOf('--match');
const match = matchAt >= 0 ? String(args[matchAt + 1] || '').toLowerCase() : '';
const jobsAt = args.indexOf('--jobs');
const requestedJobs = jobsAt >= 0 ? Number(args[jobsAt + 1]) : Number(process.env.TEST_JOBS || 0);
const jobs = Math.max(1, Math.min(8,
  Number.isInteger(requestedJobs) && requestedJobs > 0 ? requestedJobs : Math.min(4, os.cpus().length)));

const files = fs.readdirSync(TEST_DIR)
  .filter(name => name.endsWith('.test.js'))
  .filter(name => !match || name.toLowerCase().includes(match))
  .sort((a, b) => a.localeCompare(b, 'en'));

if (listOnly) {
  files.forEach(name => console.log(name));
  process.exit(0);
}

if (!files.length) {
  console.error(match ? `No test files matched: ${match}` : 'No .test.js files found.');
  process.exit(1);
}

const childEnv = { ...process.env, NODE_ENV: 'test', TEST_SUITE: '1' };
// `npm test` must never discover a developer's or Railway's live credentials by accident.
// Explicit integration jobs can opt in and provide their own isolated credentials.
if (process.env.TEST_LIVE_SERVICES !== '1') {
  for (const key of [
    'DATABASE_URL', 'DATABASE_PUBLIC_URL', 'PGTEST_URL',
    'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY',
    'DRIVE_OAUTH_CLIENT_ID', 'DRIVE_OAUTH_CLIENT_SECRET', 'DRIVE_OAUTH_REFRESH_TOKEN',
    'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'SENTRY_DSN',
    'JWT_SECRET', 'MASTER_ADMIN_PW', 'ORDER_INTAKE_KEY',
    'INTRANET_API_KEY', 'INTRANET_WEBHOOK_KEY', 'INTRANET_API_BASE',
    'INTRANET_MEMO_WEBHOOK_URL', 'INTRANET_ORDER_DELETE_WEBHOOK_URL',
    'CS_INQUIRY_WEBHOOK_URL', 'TEST_AUTO_LOGIN',
  ]) childEnv[key] = '';
}

let passed = 0;
const failures = [];
const startedAt = Date.now();
const results = new Map();
let nextIndex = 0;
let stopScheduling = false;

function runOne(name) {
  return new Promise(resolve => {
    execFile(process.execPath, ['--require', TEST_BOOTSTRAP, path.join(TEST_DIR, name)], {
      cwd: SERVER_DIR,
      env: childEnv,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`;
      if (!error) return resolve({ name, ok: true, output });
      const reason = error.killed && error.signal
        ? `timed out after 120 seconds (${error.signal})`
        : (error.code != null ? `exit ${error.code}` : error.message);
      resolve({ name, ok: false, reason, output });
    });
  });
}

async function worker() {
  while (!stopScheduling) {
    const index = nextIndex++;
    if (index >= files.length) return;
    const result = await runOne(files[index]);
    results.set(index, result);
    if (!result.ok && failFast) stopScheduling = true;
  }
}

async function main() {
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, () => worker()));

  for (const [index, result] of [...results.entries()].sort((a, b) => a[0] - b[0])) {
    if (result.ok) {
      passed += 1;
      if (verbose) process.stdout.write(`PASS ${result.name}\n${result.output}`);
      else process.stdout.write('.');
    } else {
      failures.push(result);
      process.stdout.write('F');
    }
  }

  process.stdout.write('\n');
  for (const failure of failures) {
    console.error(`\nFAIL ${failure.name} (${failure.reason})`);
    if (compact) {
      const lines = failure.output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const signal = lines.find(line => /AssertionError|ReferenceError|TypeError|Cannot find module|unexpected query|NOT OK|❌|FAILED|Error:/.test(line));
      console.error(signal || lines[0] || '(no output)');
      const location = lines.find(line => /\bat .+tests[\\/].+\.test\.js:\d+:\d+/.test(line));
      if (location) console.error(location);
    } else {
      console.error(failure.output.trim() || '(no output)');
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nTest files: ${passed} passed, ${failures.length} failed, ${results.size} run with ${jobs} jobs (${elapsedSeconds}s)`);
  process.exit(failures.length ? 1 : 0);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
