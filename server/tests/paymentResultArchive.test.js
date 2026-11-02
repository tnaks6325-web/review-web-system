/**
 * paymentResultArchive.test.js — 결정 316 이체결과 파일 드라이브 보관 회귀가드(스텁 · DB·드라이브 없이)
 * 실행: node tests/paymentResultArchive.test.js
 *
 * 고정하는 것:
 *  1. 같은 파일(sha256)은 한 번만 · 내부전용 폴더/월 폴더 · 공개 링크를 만들지 않는다(shareAnyone:false)
 *  2. ★ 폴더가 공개(anyone·domain)면 올리지 않는다(blocked) · 공유 상태를 모르면 올리지 않는다(failed)
 *  3. 한 파일이 실패해도 다음 파일은 계속 · 실패는 그 파일만 기록 · 끄는 스위치 · 루트 없으면 아무것도 안 함
 *  4. 배선 — 반영 경로(autoApplyResultFile) 안에서 올리지 않는다 · 결과 놓기 응답 뒤 kickSoon · 보관 현황은 GET 만
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AR = require('../src/services/paymentResultArchive.service');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}

function stubPool(cands) {
  const marks = [];
  const calls = [];
  return { marks, calls, query: async (sql, params) => {
    calls.push({ sql, params });
    if (/DISTINCT ON \(u\.file_sha256\)/.test(sql)) return { rows: cands.slice(0, params[0]) };
    if (/SELECT file_blob FROM payment_result_uploads/.test(sql)) return { rows: [{ file_blob: Buffer.from('xlsx-bytes-' + params[0]) }] };
    if (/INSERT INTO payment_result_drive_archive/.test(sql)) { marks.push({ sha: params[0], status: params[2], driveFileId: params[3], error: params[7] }); return { rows: [] }; }
    if (/UPDATE payment_result_drive_archive SET root_folder_id/.test(sql)) return { rows: [] };
    return { rows: [] };
  } };
}
function stubDrive({ perms = ['user'], failUploadFor = null } = {}) {
  const ups = [], paths = [];
  return { ups, paths,
    ensureFolderPath: async (root, names) => { paths.push([root, ...names]); return { id: 'F_' + names.join('/') }; },
    findFolderPath: async (root, names) => ({ id: 'TOP_' + names.join('/') }),
    listPermissionTypes: async () => perms,
    uploadFileBase64: async (b64, name, mime, folderId, opts) => {
      if (failUploadFor && name.includes(failUploadFor)) throw new Error('drive 500');
      ups.push({ name, mime, folderId, opts, bytes: Buffer.from(b64, 'base64').toString() });
      return { id: 'D' + ups.length };
    } };
}
const C = (id, sha, at, seq, fileName = 'kbank_result.xlsx') => ({ id, sha, fileName, uploadedAt: at, bank: 'kbank', seq });

(async () => {
  const envBak = { ...process.env };
  process.env.AI_REVIEW_FOLDER_ID = 'ROOT'; delete process.env.PAYMENT_RESULT_FOLDER_ID; delete process.env.PAYMENT_RESULT_DRIVE;

  await t('0 파일명 = KST 시각_#회차_은행_원래이름 · 위험 문자 제거', () => {
    assert.strictEqual(AR.driveName({ uploadedAt: '2026-11-02T05:30:00Z', seq: 89, bank: 'kbank', fileName: 'a/b:c.xlsx' }), '20261102_1430_#89_케이뱅크_a_b_c.xlsx');
    assert.strictEqual(AR.driveName({ uploadedAt: '2026-10-31T15:05:00Z', seq: null, bank: 'hana', fileName: '' }), '20261101_0005_하나은행_이체결과.xlsx');
  });

  await t('1 ★ 내부전용/월 폴더에 비공개로 올리고 done 기록 · 월이 다르면 폴더도 다르다', async () => {
    const pool = stubPool([C('u1', 's1', '2026-10-30T07:00:00Z', 87), C('u2', 's2', '2026-11-02T05:30:00Z', 89)]);
    const dv = stubDrive();
    AR.__setPoolForTest(pool); AR.__setDriveForTest(dv);
    const r = await AR.archivePending();
    assert.deepStrictEqual([r.done, r.failed, r.blocked], [2, 0, 0]);
    assert.deepStrictEqual(dv.paths, [['ROOT', AR.PRIVATE_PREFIX, '2026-10'], ['ROOT', AR.PRIVATE_PREFIX, '2026-11']]);
    assert.ok(dv.ups.every(u => u.opts && u.opts.shareAnyone === false), '공개 링크 금지');
    assert.strictEqual(dv.ups[0].mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.strictEqual(dv.ups[0].bytes, 'xlsx-bytes-u1', 'DB 원본 그대로');
    assert.deepStrictEqual(pool.marks.map(m => [m.sha, m.status]), [['s1', 'done'], ['s2', 'done']]);
  });

  await t('1b 같은 파일(sha) 한 번만 — 후보 SQL 이 sha 로 묶고 이미 done 인 sha 는 다시 고르지 않는다', async () => {
    const pool = stubPool([]); AR.__setPoolForTest(pool); AR.__setDriveForTest(stubDrive());
    await AR.archivePending();
    const sql = pool.calls[0].sql;
    assert.ok(/DISTINCT ON \(u\.file_sha256\)/.test(sql));
    assert.ok(/a\.file_sha256 IS NULL/.test(sql) && !/a\.status = 'done'/.test(sql), 'done 은 재시도 대상 아님');
    assert.ok(/u\.file_blob IS NOT NULL/.test(sql), '통장 확인 줄(파일 없음)은 제외');
    assert.ok(/u\.applied DESC/.test(sql), '반영된 줄을 대표로(회차 번호)');
  });

  await t('2 ★ 폴더가 링크 공개(anyone)면 올리지 않고 blocked · 이번 회차 멈춤', async () => {
    const pool = stubPool([C('u1', 's1', '2026-11-02T05:30:00Z', 89), C('u2', 's2', '2026-11-02T06:00:00Z', 90)]);
    const dv = stubDrive({ perms: ['user', 'anyone'] });
    AR.__setPoolForTest(pool); AR.__setDriveForTest(dv);
    const r = await AR.archivePending();
    assert.strictEqual(dv.ups.length, 0);
    assert.deepStrictEqual(pool.marks.map(m => [m.sha, m.status]), [['s1', 'blocked']]);
    assert.ok(/링크 공개/.test(pool.marks[0].error)); assert.strictEqual(r.blocked, 1);
  });
  await t('2b 도메인 공개도 막는다 · 공유 상태를 모르면(null) 올리지 않는다(failed)', async () => {
    for (const [perms, st] of [[['domain'], 'blocked'], [null, 'failed']]) {
      const pool = stubPool([C('u1', 's1', '2026-11-02T05:30:00Z', 89)]);
      const dv = stubDrive({ perms });
      AR.__setPoolForTest(pool); AR.__setDriveForTest(dv);
      await AR.archivePending();
      assert.strictEqual(dv.ups.length, 0, String(perms));
      assert.strictEqual(pool.marks[0].status, st);
    }
  });

  await t('3 한 파일 업로드 실패 → 그 파일만 failed · 다음 파일은 계속', async () => {
    const pool = stubPool([C('u1', 's1', '2026-11-02T05:30:00Z', 89, 'bad.xlsx'), C('u2', 's2', '2026-11-02T06:00:00Z', 90, 'good.xlsx')]);
    const dv = stubDrive({ failUploadFor: 'bad' });
    AR.__setPoolForTest(pool); AR.__setDriveForTest(dv);
    const r = await AR.archivePending();
    assert.deepStrictEqual([r.done, r.failed], [1, 1]);
    assert.deepStrictEqual(pool.marks.map(m => [m.sha, m.status]), [['s1', 'failed'], ['s2', 'done']]);
    assert.ok(/drive 500/.test(pool.marks[0].error));
  });

  await t('3b 끄는 스위치 · 루트 폴더 없음 → 아무것도 안 함 · 전용 폴더 지정 시 내부전용 접두 없이', async () => {
    const pool = stubPool([C('u1', 's1', '2026-11-02T05:30:00Z', 89)]); const dv = stubDrive();
    AR.__setPoolForTest(pool); AR.__setDriveForTest(dv);
    process.env.PAYMENT_RESULT_DRIVE = '0';
    assert.deepStrictEqual(await AR.archivePending(), { ran: false, reason: 'disabled' });
    delete process.env.PAYMENT_RESULT_DRIVE;
    delete process.env.AI_REVIEW_FOLDER_ID; delete process.env.DRIVE_ROOT_FOLDER_ID;
    assert.deepStrictEqual(await AR.archivePending(), { ran: false, reason: 'no_folder' });
    assert.strictEqual(pool.calls.length, 0);
    process.env.PAYMENT_RESULT_FOLDER_ID = 'OWN';
    await AR.archivePending();
    assert.deepStrictEqual(dv.paths[0], ['OWN', '2026-11']);
    delete process.env.PAYMENT_RESULT_FOLDER_ID; process.env.AI_REVIEW_FOLDER_ID = 'ROOT';
  });

  const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  await t('4 ★ 반영 경로 안에서 올리지 않는다 — paymentResult/payment 서비스는 보관 서비스를 모른다', () => {
    for (const f of ['src/services/paymentResult.service.js', 'src/services/payment.service.js', 'src/services/paymentBank.service.js']) {
      assert.ok(!/paymentResultArchive|uploadFileBase64/.test(read(f)), f);
    }
  });
  await t('4b 결과 놓기 두 입구 모두 응답 뒤 kickSoon · 보관 현황 라우트는 GET 하나', () => {
    const tb = read('src/routes/trackB.routes.js');
    for (const re of [/router\.post\('\/payment\/batch\/:id\/result-auto-apply'[\s\S]*?\n\}\);/, /router\.post\('\/payment\/result-auto-apply'[\s\S]*?\n\}\);/]) {
      const m = tb.match(re); assert.ok(m, String(re));
      assert.ok(/res\.json\([\s\S]*\);\n\s*_archiveSoon\(\);/.test(m[0]), '응답 뒤에 당긴다');
    }
    assert.ok(/router\.get\('\/payment\/result-archive', authMiddleware, adminOrMasterMiddleware/.test(tb));
    assert.ok(!/router\.(post|put|delete)\('\/payment\/result-archive/.test(tb), '보관을 직접 시키는 쓰기 입구 없음');
    assert.ok(/function _archiveSoon\(\) \{ try \{ paymentResultArchiveSvc\.kickSoon\(\); \} catch/.test(tb), '보관 실패가 응답을 깨지 않는다');
  });
  await t('4c 서비스 — 공개 링크 금지 문자열 · 마이그레이션 207(sha 기본키)', () => {
    const src = read('src/services/paymentResultArchive.service.js');
    assert.ok(/shareAnyone: false/.test(src) && !/shareAnyone: true/.test(src) && !/setFolderAnyoneReader/.test(src));
    const mig = read('migrations/207_payment_result_drive_archive.sql');
    assert.ok(/CREATE TABLE IF NOT EXISTS payment_result_drive_archive/.test(mig) && /file_sha256\s+TEXT PRIMARY KEY/.test(mig));
    assert.ok(/CHECK \(status IN \('done', 'failed', 'blocked'\)\)/.test(mig));
    assert.ok(!/sheet_id|tab_name/.test(mig), '작업 탭과 무관한 표(작업 삭제 분류 대상 아님)');
  });
  await t('4d 화면 — 보관 줄은 대량이체 칸 안 · 읽기만 · 대각선 화살표 없음', () => {
    const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
    assert.ok(/\$\{_pmResultDropHtml\(\)\}\n\s*<div id="pmArchiveLine">\$\{_pmArchiveHtml\(\)\}<\/div>/.test(wd));
    assert.ok(/api\('\/api\/trackb\/payment\/result-archive'\)/.test(wd));
    const fn = wd.match(/function _pmArchiveHtml\(\)\{[\s\S]*?\n\}/)[0];
    assert.ok(/드라이브 보관함 열기/.test(fn) && !/[↗⬈]|external-link|arrow-up-right/.test(fn));
    assert.ok(/catch\(_\)\{ STATE\.pmArchive=null; \}/.test(wd), '못 받으면 그 줄만 숨김');
  });

  AR.__setPoolForTest(null); AR.__setDriveForTest(null);
  Object.assign(process.env, envBak);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
