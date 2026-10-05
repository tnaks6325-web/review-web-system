'use strict';
/**
 * 작업보드 [🖼 리뷰캡처 교체] 회귀가드 (사용자 확정 2026-10-01)
 *  A. 서비스 실제 실행(스텁 pool·drive) — 고른 한 장만 교체 · 대기 교체요청 거부 · 그 사이 바뀜 거부
 *     · 옛 사진 휴지통(사용 중이면 보존) · 검수 재대기 · 옛 사진 검수 카드 종결 · 작업 로그
 *  B. 배선 — 승인(/approve)과 같은 3문장 · 같은 폴더 판정 · 권한 게이트 · 화면 규율 · 리뷰어 통지 없음
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pool = require('../src/db/pool');
const drive = require('../src/services/drive.service');
const eventLog = require('../src/services/reviewerEventLog.service');
const svc = require('../src/services/reviewCaptureReplace.service');
const reviewEditRoutes = require('../src/routes/reviewEdit.routes');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
}
const A = 'REVFILE_A_aaaaaaaaaaaaaaaa', B = 'REVFILE_B_bbbbbbbbbbbbbbbb', NEW = 'NEWREV_cccccccccccccccccc';

function makeDb(opts = {}) {
  const calls = [];
  const subs = opts.subs || [{ file_id: A }, { file_id: B }];
  const q = async (sql, params) => {
    sql = String(sql); calls.push({ sql, params });
    if (/FROM campaign_participants/.test(sql)) return { rows: opts.noRow ? [] : [{ id: 'r1', seq: 49, reviewer_name: '김선미', recipient_name: '김선미' }] };
    if (/FROM review_submissions\s+WHERE sheet_id=\$1/.test(sql)) return { rows: subs };
    if (/SELECT review_file_id, review_file_at FROM review_index/.test(sql)) return { rows: opts.idx || [] };
    if (/FROM review_edit_requests/.test(sql)) { if (opts.reqThrows) { const e = new Error('x'); e.code = opts.reqThrows; throw e; } return { rows: opts.pending ? [{ id: 1 }] : [] }; }
    if (/UNION ALL[\s\S]*row_index=\$4/.test(sql)) return { rows: opts.raceGone ? [] : [{ '?column?': 1 }] };
    if (/UNION ALL SELECT 1 FROM review_index WHERE review_file_id=\$1/.test(sql)) {
      if (opts.oldCheckThrows) throw new Error('boom');
      return { rows: opts.oldInUse ? [{ x: 1 }] : [] };
    }
    if (/FROM tab_configs/.test(sql)) return { rows: [{ folder_url: 'https://drive.google.com/drive/folders/RV', campaign_name: 'C', display_name: 'D' }] };
    if (/INSERT INTO reviewer_event_logs/.test(sql)) return { rows: [{ id: 7 }] };
    return { rows: [], rowCount: 1 };
  };
  return { db: { query: q, connect: async () => ({ query: q, release() {} }) }, calls };
}
function stubDrive() {
  const log = [];
  drive.extractFolderIdFromUrl = () => 'RVFOLDER';
  drive.getOrCreateSubFolder = async () => ({ id: 'STAGING' });
  drive.uploadFileBase64 = async (b64, name, mime, folder) => { log.push(['upload', name, mime, folder]); return { id: NEW, name, webViewLink: 'v' }; };
  drive.trashFiles = async files => { log.push(['trash', files.map(f => f.id)]); return { success: files.length, failed: 0 }; };
  return log;
}
async function withDb(opts, fn) {
  const { db, calls } = makeDb(opts);
  const origQ = pool.query;
  pool.query = db.query;            // reviewEdit.routes._resolveFolders · recipientNameForRow 는 pool 모듈을 쓴다
  svc.__setPoolForTest(db); eventLog.__setPoolForTest(db);
  const dlog = stubDrive();
  process.env.AI_REVIEW_FOLDER_ID = 'ROOT';
  try { return await fn({ calls, dlog }); }
  finally { pool.query = origQ; svc.__setPoolForTest(null); eventLog.__setPoolForTest(null); }
}
const IMG = Buffer.from('fake-image').toString('base64');
const base = { sheetId: 'S1', tabName: 'T1', rowId: 'r1', imageBase64: IMG, mimeType: 'image/png', by: '만두' };

(async () => {
  console.log('A. 서비스 실행');
  await t('고른 한 장(B)만 바꾼다 · 승인과 같은 3문장 · 옛 사진 휴지통 · 로그', () => withDb({}, async ({ calls, dlog }) => {
    const out = await svc.replaceReviewCapture({ ...base, oldFileId: B });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    const up = calls.find(c => /UPDATE review_submissions/.test(c.sql));
    assert.ok(up && up.params[0] === NEW && up.params[3] === B, '고른 파일을 바꾸지 않았다');
    assert.ok(calls.some(c => /INSERT INTO review_inspections/.test(c.sql) && c.params[0] === NEW), '새 사진 재검수 대기 없음');
    assert.ok(calls.some(c => /UPDATE review_index[\s\S]*review_file_id = \$7/.test(c.sql)), '대표 이미지 갱신 없음');
    assert.ok(calls.some(c => /UPDATE review_inspections SET status='resolved'/.test(c.sql) && c.params[0] === B), '옛 사진 검수 카드 종결 없음');
    assert.deepStrictEqual(dlog.filter(x => x[0] === 'trash').map(x => x[1]), [[B]]);
    assert.strictEqual(dlog.find(x => x[0] === 'upload')[3], 'RVFOLDER', '[리뷰] 폴더에 올리지 않음');
    assert.ok(calls.some(c => /INSERT INTO reviewer_event_logs/.test(c.sql) && c.params.includes('review_capture_replaced')));
  }));
  await t('★ 대표 이미지만 있는 과거 행도 바꿀 수 있다', () => withDb({ subs: [], idx: [{ review_file_id: A }] }, async () => {
    const pv = await svc.previewReviewReplace({ sheetId: 'S1', tabName: 'T1', rowId: 'r1' });
    assert.deepStrictEqual(pv.files.map(f => f.fileId), [A]);
    const out = await svc.replaceReviewCapture({ ...base, oldFileId: A });
    assert.strictEqual(out.ok, true);
  }));
  await t('★ 그 줄에 없는 파일은 거부(업로드 0)', () => withDb({}, async ({ dlog }) => {
    const out = await svc.replaceReviewCapture({ ...base, oldFileId: 'OTHERFILE_xxxxxxxxxxxx' });
    assert.strictEqual(out.error, 'capture_changed'); assert.ok(!dlog.length);
  }));
  await t('★ 리뷰어 교체요청이 대기 중이면 거부(업로드 0)', () => withDb({ pending: true }, async ({ dlog }) => {
    const out = await svc.replaceReviewCapture({ ...base, oldFileId: A });
    assert.strictEqual(out.error, 'pending_edit_request'); assert.ok(!dlog.length);
    const pv = await svc.previewReviewReplace({ sheetId: 'S1', tabName: 'T1', rowId: 'r1' });
    assert.strictEqual(pv.pendingEditRequest, true);
  }));
  await t('교체요청 표가 없는 환경(42P01)은 대기 요청 없음으로 본다', () => withDb({ reqThrows: '42P01' }, async () => {
    const out = await svc.replaceReviewCapture({ ...base, oldFileId: A });
    assert.strictEqual(out.ok, true);
  }));
  await t('★ 확정 순간에 옛 파일이 사라졌으면 UPDATE 0 + 새 파일 휴지통', () => withDb({ raceGone: true }, async ({ calls, dlog }) => {
    const out = await svc.replaceReviewCapture({ ...base, oldFileId: A });
    assert.strictEqual(out.error, 'capture_changed');
    assert.ok(!calls.some(c => /UPDATE review_submissions/.test(c.sql)));
    assert.deepStrictEqual(dlog.filter(x => x[0] === 'trash').map(x => x[1]), [[NEW]]);
  }));
  await t('★ 옛 사진을 다른 곳이 쓰면 지우지 않는다', () => withDb({ oldInUse: true }, async ({ dlog }) => {
    const out = await svc.replaceReviewCapture({ ...base, oldFileId: A });
    assert.strictEqual(out.ok, true); assert.strictEqual(out.oldKept, 'in_use');
    assert.ok(!dlog.some(x => x[0] === 'trash'));
  }));
  await t('★ 사용 여부 확인 실패 = 지우지 않는다', () => withDb({ oldCheckThrows: true }, async ({ dlog }) => {
    const out = await svc.replaceReviewCapture({ ...base, oldFileId: A });
    assert.strictEqual(out.ok, true); assert.ok(!dlog.some(x => x[0] === 'trash'));
  }));
  await t('이미지 아님 · 잘못된 파일ID 거부(쿼리 0)', () => withDb({}, async ({ calls }) => {
    assert.strictEqual((await svc.replaceReviewCapture({ ...base, oldFileId: A, mimeType: 'text/plain' })).error, 'not_image');
    assert.strictEqual((await svc.replaceReviewCapture({ ...base, oldFileId: "a'b" })).error, 'bad_request');
    assert.strictEqual(calls.length, 0);
  }));
  await t('미리보기는 쓰기 0', () => withDb({}, async ({ calls, dlog }) => {
    const pv = await svc.previewReviewReplace({ sheetId: 'S1', tabName: 'T1', rowId: 'r1' });
    assert.strictEqual(pv.ok, true); assert.strictEqual(pv.files.length, 2);
    assert.ok(!calls.some(c => /\b(UPDATE|INSERT|DELETE)\b/.test(c.sql))); assert.ok(!dlog.length);
  }));

  console.log('B. 배선');
  const root = path.join(__dirname, '..', '..');
  const read = p => fs.readFileSync(path.join(root, p), 'utf8');
  const SVC = read('server/src/services/reviewCaptureReplace.service.js');
  const RE = read('server/src/routes/reviewEdit.routes.js');
  const TB = read('server/src/routes/trackB.routes.js');
  const WD = read('frontend/workdesk.html');
  const norm = s => s.replace(/\s+/g, ' ');
  await t('★★ 포인터 교체 3문장이 승인(/approve)과 같다(review_submissions·review_index)', () => {
    const sub = /UPDATE review_submissions\s+SET file_id = \$1, file_url = \$2, file_name = \$3, file_hash = NULL\s+WHERE file_id = \$4 AND sheet_id = \$5 AND tab_name = \$6 AND row_index = \$7/;
    const idx = /UPDATE review_index\s+SET review_file_id = \$1, review_file_url = \$2, review_file_name = \$3\s+WHERE sheet_id = \$4 AND tab_name = \$5 AND row_index = \$6 AND review_file_id = \$7/;
    assert.ok(sub.test(SVC) && sub.test(RE), 'review_submissions 문장 불일치');
    assert.ok(idx.test(SVC) && idx.test(RE), 'review_index 문장 불일치');
    assert.ok(/INSERT INTO review_inspections[\s\S]{0,200}'pending'/.test(SVC));
  });
  await t('★ 폴더 판정은 승인과 같은 함수(사본 금지)', () => {
    assert.strictEqual(typeof reviewEditRoutes._resolveFolders, 'function');
    assert.ok(/reviewEdit\.routes'\)\._resolveFolders/.test(SVC));
    assert.ok(!/ensureReviewFolderPath/.test(SVC));
  });
  await t('★ 리뷰어에게 알리지 않는다(사용자 확정) · 영구삭제 없음', () => {
    assert.ok(!/csBridge|postReviewEdit|postAdminNotice/.test(SVC));
    assert.ok(!/files\.delete/.test(SVC));
  });
  await t('★ 라우트 = 내부 직원(광고주 차단)', () => {
    assert.ok(/router\.get\('\/workdesk\/review-capture', authMiddleware, internalMiddleware,/.test(TB));
    assert.ok(/router\.post\('\/workdesk\/review-capture\/replace', authMiddleware, internalMiddleware, imageApiLimiter,/.test(TB));
  });
  await t('★ 화면: 구매캡처와 같은 팝오버 한 벌 · 파일 탐색기 없음 · 고른 한 장을 보낸다', () => {
    const a = WD.indexOf('/* ── 🛒 구매캡처 교체'), b = WD.indexOf('// 우클릭 [행 삭제]는', a);
    const seg = WD.slice(a, b);
    assert.ok(a > 0 && b > a);
    assert.ok(/rev:\{icon:'🖼',label:'리뷰캡처',get:'\/api\/trackb\/workdesk\/review-capture'/.test(seg));
    assert.ok(/body\.oldFileId=_capCurrent\(st\)/.test(seg));
    assert.ok(!/type="file"/.test(seg));
    assert.ok((WD.match(/id='wdCapPop'|id="wdCapPop"/g) || []).length <= 1, '팝오버 사본');
  });
  await t('★ 화면: 두 창구 모두 내부 직원에게만', () => {
    assert.ok(/one&&selectedRow&&_isInternalRole\(\)\?row\('🖼','리뷰캡처 교체'/.test(WD));
    assert.ok(/kind==='rev'&&n&&_isInternalRole\(\)\)\?`<button type="button" class="rvcaprep" onclick="openReviewReplaceFromPane\(this\)"/.test(WD));
  });
  await t('작업 로그 문구', () => assert.ok(/case 'review_capture_replaced':/.test(read('server/src/services/reviewerEventLog.service.js'))));

  console.log(`\n${fail ? '❌' : '✅'} reviewCaptureReplace: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
