#!/usr/bin/env node
/**
 * 구글드라이브 소유권(=용량 귀속) 점검·이전 CLI
 *
 * 구글드라이브 저장용량은 "파일 소유자" 계정에 귀속된다.
 * 구매캡처/리뷰 업로드는 OAuth(tnaks6325) 소유로 생성되도록 구현돼 있으나,
 * (a) DRIVE_OAUTH_REFRESH_TOKEN 이 다른 계정이거나
 * (b) 과거 GAS 가 만든 파일이 관리자(박세희/박은비) 소유로 남아 있으면
 * 관리자 용량이 차감된다. 이 스크립트로 현황을 확인하고 이전한다.
 *
 * 사용법 (server/ 디렉토리에서):
 *   # 1) 현재 OAuth 계정/쿼터 확인 (어느 계정에 용량이 잡히는지)
 *   node scripts/drive-ownership.js account
 *
 *   # 2) 소유자별 용량 집계 (읽기전용 — 안전)
 *   node scripts/drive-ownership.js audit
 *   node scripts/drive-ownership.js audit --closed     # 마감탭 포함
 *
 *   # 3) 소유권 이전 (기본 dry-run — 계획만 출력)
 *   node scripts/drive-ownership.js transfer
 *   node scripts/drive-ownership.js transfer --apply    # 실제 이전
 *   node scripts/drive-ownership.js transfer --apply --from=admin@gmail.com
 *   node scripts/drive-ownership.js transfer --apply --source-token=<관리자_refresh_token>
 *
 * Railway 에서: railway run -- node scripts/drive-ownership.js audit
 *
 * 옵션:
 *   --closed           마감(is_closed) 탭의 폴더도 포함
 *   --apply            (transfer) 실제 이전 수행. 미지정 시 dry-run
 *   --from=a,b         (transfer) 해당 이메일 소유 파일만 대상
 *   --source-token=T   (transfer) "현재 소유자(관리자)" 자격 refresh token.
 *                      관리자 소유 파일을 실제로 이전하려면 필요.
 *   --target=email     이전 대상 소유자 (기본 DRIVE_OWNER_EMAIL || tnaks6325@gmail.com)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const pool = require('../src/db/pool');
const driveService = require('../src/services/drive.service');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out.flags[k] = v === undefined ? true : v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function extractFolderId(url) {
  if (!url) return null;
  const m = String(url).match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function collectFolderIds(includeClosed) {
  const where = includeClosed ? '' : 'WHERE (is_closed = FALSE OR is_closed IS NULL)';
  const { rows } = await pool.query(`SELECT folder_url, capture_folder_url FROM tab_configs ${where}`);
  const ids = [];
  for (const r of rows) {
    const cap = extractFolderId(r.capture_folder_url);
    const rev = extractFolderId(r.folder_url);
    if (cap) ids.push(cap);
    if (rev) ids.push(rev);
  }
  return [...new Set(ids)];
}

function line() { console.log('═'.repeat(60)); }

async function cmdAccount() {
  line();
  console.log('  현재 Drive OAuth 계정/쿼터 (용량 귀속 계정)');
  line();
  const info = await driveService.getAccountDiagnostics();
  console.log(`  기대 소유자(DRIVE_OWNER_EMAIL): ${info.expectedOwnerEmail}`);
  console.log(`  서비스계정 이메일: ${info.serviceAccount.email || '(미설정)'}`);
  console.log('');
  console.log('  ▶ OAuth (업로드 용량이 귀속되는 계정):');
  if (!info.oauth.configured) {
    console.log('    ❌ OAuth 미설정 (DRIVE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN)');
  } else if (info.oauth.error) {
    console.log(`    ❌ 조회 실패: ${info.oauth.error}`);
  } else {
    const m = info.oauth.matchesExpectedOwner;
    console.log(`    계정: ${info.oauth.email} (${info.oauth.displayName || '-'})`);
    console.log(`    기대 소유자와 일치: ${m === true ? '✅ 예' : m === false ? '❌ 아니오 (←★ 용량이 이 계정에 잡힘)' : '?'}`);
    if (info.oauth.quota) {
      const q = info.oauth.quota;
      console.log(`    저장용량: ${q.usageHuman || '?'} / ${q.limitHuman}${q.usedPercent != null ? ` (${q.usedPercent}%)` : ''}`);
    }
  }
  line();
}

async function cmdAudit(args) {
  const includeClosed = !!args.flags.closed;
  const folderIds = await collectFolderIds(includeClosed);
  line();
  console.log(`  소유자별 용량 집계 — 폴더 ${folderIds.length}개${includeClosed ? ' (마감 포함)' : ''}`);
  line();
  if (folderIds.length === 0) { console.log('  감사할 폴더가 없습니다.'); return; }

  const r = await driveService.auditOwnership(folderIds);
  console.log(`  총 파일: ${r.totalFiles}개 / 총 용량: ${r.totalHuman}`);
  console.log('');
  console.log('  소유자별:');
  for (const o of r.owners) {
    console.log(`    - ${o.email}${o.displayName ? ` (${o.displayName})` : ''}: ${o.fileCount}개, ${o.totalHuman}`);
  }
  if (r.errors.length) {
    console.log('');
    console.log(`  ⚠️ 스캔 실패 폴더 ${r.errors.length}개:`);
    r.errors.slice(0, 10).forEach(e => console.log(`    - ${e.folderId}: ${e.error}`));
  }
  line();
}

async function cmdTransfer(args) {
  const includeClosed = !!args.flags.closed;
  const dryRun = !args.flags.apply;
  const fromOwners = args.flags.from ? String(args.flags.from).split(',').map(s => s.trim()).filter(Boolean) : [];
  const sourceRefreshToken = args.flags['source-token'] || undefined;
  const targetOwnerEmail = args.flags.target || undefined;

  const folderIds = await collectFolderIds(includeClosed);
  line();
  console.log(`  소유권 이전 ${dryRun ? '(DRY-RUN — 계획만)' : '(★ 실제 이전)'} — 폴더 ${folderIds.length}개`);
  line();
  if (folderIds.length === 0) { console.log('  대상 폴더가 없습니다.'); return; }

  const r = await driveService.transferOwnershipInFolders(folderIds, {
    targetOwnerEmail, dryRun, fromOwners, sourceRefreshToken,
  });

  console.log(`  대상 소유자: ${r.targetOwnerEmail}`);
  console.log(`  관리자 토큰(source) 사용: ${r.usedSourceToken ? '예' : '아니오'}`);
  console.log('');
  const s = r.summary;
  console.log(`  스캔: ${s.scanned} / 이미 대상소유: ${s.alreadyOwned} / 이전대상: ${s.toTransfer} / 건너뜀: ${s.skipped}`);
  if (!dryRun) console.log(`  ✅ 이전 성공: ${s.transferred} / ❌ 실패: ${s.failed}`);

  if (dryRun && r.actions.length) {
    console.log('');
    console.log(`  이전 예정 파일 (상위 20):`);
    r.actions.slice(0, 20).forEach(a => console.log(`    - ${a.name} (소유자=${a.currentOwner})`));
    if (r.actions.length > 20) console.log(`    ... 외 ${r.actions.length - 20}개`);
    console.log('');
    console.log('  실제 이전하려면 --apply 를 붙이세요.');
  }

  if (r.failures.length) {
    console.log('');
    console.log(`  ⚠️ 실패/주의 ${r.failures.length}건 (상위 10):`);
    r.failures.slice(0, 10).forEach(f => console.log(`    - ${f.name || f.folderId} (소유자=${f.currentOwner || '?'}): ${f.error}`));
    console.log('');
    console.log('  ※ 관리자 소유 파일이 403/권한오류로 실패하면, 그 관리자 계정의');
    console.log('    refresh token 을 --source-token 으로 주거나, 관리자가 직접 이전해야 합니다.');
  }
  line();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  try {
    if (cmd === 'account') {
      await cmdAccount();
    } else if (cmd === 'audit') {
      await cmdAudit(args);
    } else if (cmd === 'transfer') {
      await cmdTransfer(args);
    } else {
      console.log('사용법: node scripts/drive-ownership.js <account|audit|transfer> [옵션]');
      console.log('  account              현재 OAuth 계정/쿼터 확인');
      console.log('  audit  [--closed]    소유자별 용량 집계 (읽기전용)');
      console.log('  transfer [--apply] [--from=a,b] [--source-token=T] [--target=email] [--closed]');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('❌ 오류:', err.message);
    process.exitCode = 1;
  } finally {
    try { await pool.end(); } catch (_) {}
  }
}

main();
