/**
 * 자동 점검 러너의 시간초과는 강제로 끈다(결정 276 · 완화 금지).
 *   앱이 SIGTERM 리스너를 달면(utils/sse.js) 기본 종료가 꺼져, SIGTERM 시간초과는 무시되고 점검 전체가 무한 대기한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');
const opts = /execFile\(process\.execPath,[^]*?\{([^]*?)\}, \(error, stdout, stderr\)/.exec(src);
assert.ok(opts, '러너의 execFile 옵션을 찾지 못함');
assert.match(opts[1], /timeout: timeoutFor\(name\)/, '파일마다 시간초과가 있다');
// 결정 396: 기본 2분 · 이름으로 늘린 무거운 시험만 예외 · 상한 5분(시간초과를 사실상 끄는 값 금지)
assert.match(src, /const DEFAULT_TIMEOUT_MS = 120_000;/, '기본 시간초과 2분');
assert.match(src, /const MAX_TIMEOUT_MS = 300_000;/, '예외 상한 5분');
assert.match(src, /Math\.min\(MAX_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS\[name\] \|\| DEFAULT_TIMEOUT_MS\)/, '예외는 상한으로 자른다');
{
  const m = /const SLOW_TEST_TIMEOUT_MS = \{([^}]*)\}/.exec(src);
  assert.ok(m, '무거운 시험 목록');
  const names = [...m[1].matchAll(/'([^']+)'\s*:/g)].map(x => x[1]);
  assert.ok(names.length <= 5, '예외 목록은 작게 — 느린 시험은 고치는 게 먼저');
  for (const n of names) assert.ok(fs.existsSync(path.join(__dirname, n)), `없는 시험 이름: ${n}`);
}
assert.match(opts[1], /killSignal: 'SIGKILL'/, '★ 시간초과는 SIGKILL(SIGTERM 은 앱 리스너가 무시시킨다)');

// 실행 — SIGTERM 리스너를 단 채 멈춘 자식이 같은 옵션의 시간초과로 실제로 죽는다
const child = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const t0 = Date.now();
execFile(process.execPath, ['-e', child], { timeout: 300, killSignal: 'SIGKILL' }, (error) => {
  assert.ok(error && error.killed && error.signal === 'SIGKILL', JSON.stringify(error && { killed: error.killed, signal: error.signal }));
  assert.ok(Date.now() - t0 < 10000, '시간초과 직후 끝난다');
  console.log('runTestsKill: passed');
  process.exit(0);
});
setTimeout(() => { console.error('✗ 시간초과로 자식을 끄지 못함'); process.exit(1); }, 15000).unref();
