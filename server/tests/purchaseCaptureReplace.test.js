'use strict';
/**
 * 작업보드 [🛒 구매캡처 교체] 회귀가드 (사용자 확정 2026-09-30)
 *  A. 서비스 실제 실행(스텁 pool·drive) — 줄→주문 판정 · 그 사이 바뀜 거부 · 옛 사진 휴지통/보존 · 작업 로그
 *  B. 배선 — 폴더 단일 출처 · 같은 잠금 키 · 권한 게이트 · 화면 규율(붙여넣기 전용 · 업체 미노출)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pool = require('../src/db/pool');
const drive = require('../src/services/drive.service');
const eventLog = require('../src/services/reviewerEventLog.service');
const svc = require('../src/services/purchaseCaptureReplace.service');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
}

const OLD = 'OLDFILE_aaaaaaaaaaaaaaaaaaaa';
const NEW = 'NEWFILE_bbbbbbbbbbbbbbbbbbbb';

function makeDb(opts = {}) {
  const calls = [];
  const cands = opts.cands || [{ id: 'os-1', capture_file_id: OLD, recipient: '김선미', orderer: '김선미' }];
  const q = async (sql, params) => {
    sql = String(sql); calls.push({ sql, params });
    if (/FROM campaign_participants/.test(sql)) {
      return { rows: opts.noRow ? [] : [{ id: 'r1', seq: 49, order_submission_id: opts.link || null, reviewer_name: '김선미', recipient_name: '김선미' }] };
    }
    if (/FROM tab_configs WHERE sheet_id=\$1 AND tab_name=\$2 LIMIT 1/.test(sql) && /tab_gid/.test(sql)) return { rows: [{ gid: '123' }] };
    if (/FROM order_submissions os/.test(sql)) return { rows: cands };
    if (/SELECT capture_folder_url/.test(sql)) return { rows: [{ capture_folder_url: 'https://drive.google.com/drive/folders/FOLDER' }] };
    if (/SELECT capture_file_id FROM order_submissions WHERE id=\$1/.test(sql)) {
      return { rows: [{ capture_file_id: opts.raceTo !== undefined ? opts.raceTo : cands[0].capture_file_id }] };
    }
    if (/UNION ALL/.test(sql) && /review_submissions/.test(sql)) {
      if (opts.oldCheckThrows) throw new Error('boom');
      return { rows: opts.oldInUse ? [{ '?column?': 1 }] : [] };
    }
    if (/INSERT INTO reviewer_event_logs/.test(sql)) return { rows: [{ id: 99 }] };
    return { rows: [], rowCount: 1 };
  };
  const db = { query: q, connect: async () => ({ query: q, release() {} }) };
  return { db, calls };
}

function stubDrive() {
  const log = [];
  drive.extractFolderIdFromUrl = () => 'FOLDER';
  drive.uploadFileBase64 = async (b64, name, mime, folder) => { log.push(['upload', name, mime, folder]); return { id: NEW, name }; };
  drive.trashFiles = async files => { log.push(['trash', files.map(f => f.id)]); return { success: files.length, failed: 0 }; };
  return log;
}

async function withDb(opts, fn) {
  const { db, calls } = makeDb(opts);
  const origQ = pool.query;
  pool.query = db.query;             // captureFolder.service 는 pool 모듈을 직접 쓴다
  svc.__setPoolForTest(db);
  eventLog.__setPoolForTest(db);
  const dlog = stubDrive();
  process.env.AI_REVIEW_FOLDER_ID = 'ROOT';
  try { return await fn({ calls, dlog }); }
  finally { pool.query = origQ; svc.__setPoolForTest(null); eventLog.__setPoolForTest(null); }
}

const IMG = Buffer.from('fake-image-bytes').toString('base64');
const base = { sheetId: 'S1', tabName: 'T1', rowId: 'r1', imageBase64: IMG, mimeType: 'image/png', by: '만두' };

(async () => {
  console.log('A. 서비스 실행');
  await t('교체: 업로드 → 확정 UPDATE → 옛 사진 휴지통 → 작업 로그', () => withDb({}, async ({ calls, dlog }) => {
    const out = await svc.replaceCapture({ ...base, expectFileId: OLD });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.fileId, NEW);
    assert.strictEqual(out.replaced, true);
    assert.strictEqual(out.oldTrashed, true);
    assert.ok(calls.some(c => /UPDATE order_submissions/.test(c.sql) && c.params[1] === NEW), 'UPDATE 없음');
    assert.deepStrictEqual(dlog.filter(x => x[0] === 'trash').map(x => x[1]), [[OLD]]);
    assert.ok(calls.some(c => /INSERT INTO reviewer_event_logs/.test(c.sql) && c.params.includes('capture_replaced')), '로그 없음');
    assert.ok(dlog.find(x => x[0] === 'upload')[3] === 'FOLDER', '구매캡처 폴더에 올리지 않음');
  }));
  await t('캡처 없는 주문엔 새로 올린다(휴지통 호출 0)', () => withDb({ cands: [{ id: 'os-1', capture_file_id: null, recipient: '김' }] }, async ({ dlog }) => {
    const out = await svc.replaceCapture({ ...base, expectFileId: '' });
    assert.strictEqual(out.ok, true); assert.strictEqual(out.replaced, false);
    assert.ok(!dlog.some(x => x[0] === 'trash'));
  }));
  await t('★ 연 뒤 캡처가 바뀌었으면 업로드 전에 거부(파일 0)', () => withDb({}, async ({ dlog, calls }) => {
    const out = await svc.replaceCapture({ ...base, expectFileId: 'SOMETHING_ELSE_xxxxxxxxxxx' });
    assert.strictEqual(out.error, 'capture_changed');
    assert.ok(!dlog.some(x => x[0] === 'upload'), '업로드되면 안 된다');
    assert.ok(!calls.some(c => /UPDATE order_submissions/.test(c.sql)));
  }));
  await t('★ 확정 순간에 바뀌었으면 UPDATE 0 + 새 파일 휴지통', () => withDb({ raceTo: 'RIVAL_cccccccccccccccccccc' }, async ({ dlog, calls }) => {
    const out = await svc.replaceCapture({ ...base, expectFileId: OLD });
    assert.strictEqual(out.error, 'capture_changed');
    assert.ok(!calls.some(c => /UPDATE order_submissions/.test(c.sql)), 'UPDATE 되면 안 된다');
    assert.deepStrictEqual(dlog.filter(x => x[0] === 'trash').map(x => x[1]), [[NEW]]);
  }));
  await t('★ 옛 사진을 다른 곳이 쓰면 지우지 않는다', () => withDb({ oldInUse: true }, async ({ dlog }) => {
    const out = await svc.replaceCapture({ ...base, expectFileId: OLD });
    assert.strictEqual(out.ok, true); assert.strictEqual(out.oldTrashed, false); assert.strictEqual(out.oldKept, 'in_use');
    assert.ok(!dlog.some(x => x[0] === 'trash'));
  }));
  await t('★ 사용 여부 확인 실패 = 지우지 않는다(fail-closed)', () => withDb({ oldCheckThrows: true }, async ({ dlog }) => {
    const out = await svc.replaceCapture({ ...base, expectFileId: OLD });
    assert.strictEqual(out.ok, true); assert.strictEqual(out.oldTrashed, false);
    assert.ok(!dlog.some(x => x[0] === 'trash'));
  }));
  await t('주문 없음 = no_order', () => withDb({ cands: [] }, async ({ dlog }) => {
    const out = await svc.replaceCapture({ ...base, expectFileId: '' });
    assert.strictEqual(out.error, 'no_order'); assert.ok(!dlog.length);
  }));
  await t('★ 주문이 겹치고 링크로도 못 좁히면 거부', () => withDb({ cands: [{ id: 'a', capture_file_id: OLD }, { id: 'b', capture_file_id: null }] }, async () => {
    const out = await svc.previewReplace({ sheetId: 'S1', tabName: 'T1', rowId: 'r1' });
    assert.strictEqual(out.error, 'ambiguous_order');
  }));
  await t('겹쳐도 줄의 링크가 후보 중 하나면 그것', () => withDb({ link: 'b', cands: [{ id: 'a', capture_file_id: OLD }, { id: 'b', capture_file_id: null }] }, async () => {
    const out = await svc.previewReplace({ sheetId: 'S1', tabName: 'T1', rowId: 'r1' });
    assert.strictEqual(out.ok, true); assert.strictEqual(out.orderSubmissionId, 'b'); assert.strictEqual(out.currentFileId, '');
  }));
  await t('이미지가 아니면 거부(쿼리 0)', () => withDb({}, async ({ calls }) => {
    const out = await svc.replaceCapture({ ...base, mimeType: 'application/pdf', expectFileId: OLD });
    assert.strictEqual(out.error, 'not_image'); assert.strictEqual(calls.length, 0);
  }));
  await t('8MB 초과 거부', () => withDb({}, async () => {
    const big = Buffer.alloc(svc.MAX_IMAGE_BYTES + 1).toString('base64');
    const out = await svc.replaceCapture({ ...base, imageBase64: big, expectFileId: OLD });
    assert.strictEqual(out.error, 'too_large');
  }));
  await t('미리보기는 쓰기 0', () => withDb({}, async ({ calls, dlog }) => {
    const out = await svc.previewReplace({ sheetId: 'S1', tabName: 'T1', rowId: 'r1' });
    assert.strictEqual(out.ok, true); assert.strictEqual(out.currentFileId, OLD);
    assert.ok(!calls.some(c => /\b(UPDATE|INSERT|DELETE)\b/.test(c.sql))); assert.ok(!dlog.length);
  }));

  console.log('B. 배선');
  const root = path.join(__dirname, '..', '..');
  const read = p => fs.readFileSync(path.join(root, p), 'utf8');
  const SVC = read('server/src/services/purchaseCaptureReplace.service.js');
  const SESS = read('server/src/services/purchaseSubmissionSession.service.js');
  const DIAG = read('server/src/routes/diag.routes.js');
  const TB = read('server/src/routes/trackB.routes.js');
  const WD = read('frontend/workdesk.html');
  await t('★ 폴더 판정 단일 출처 — 리뷰어 업로드도 captureFolder.service 를 쓴다', () => {
    const seg = DIAG.slice(DIAG.indexOf("router.post('/image-upload'"), DIAG.indexOf("router.post('/review-precheck'"));
    assert.ok(/captureFolder\.service/.test(seg) && /resolveCaptureFolder/.test(seg));
    assert.ok(!/ensureCaptureFolderPath/.test(seg), '업로드 라우트에 폴더 생성 사본이 남았다');
    assert.ok(/captureFolder\.resolveCaptureFolder/.test(SVC));
  });
  await t('★ 리뷰어 업로드와 같은 잠금 키', () => {
    assert.ok(/`purchase_capture:\$\{orderSubmissionId\}`/.test(SESS));
    assert.ok(/LOCK_PREFIX = 'purchase_capture:'/.test(SVC));
  });
  await t('★ 영구삭제 없음 — 휴지통만', () => { assert.ok(!/files\.delete|\.delete\(\{ *fileId/.test(SVC)); });
  await t('★ 라우트 = 내부 직원(광고주 차단)', () => {
    assert.ok(/router\.get\('\/workdesk\/purchase-capture', authMiddleware, internalMiddleware,/.test(TB));
    assert.ok(/router\.post\('\/workdesk\/purchase-capture\/replace', authMiddleware, internalMiddleware, imageApiLimiter,/.test(TB));
  });
  await t('★ 화면: 파일 탐색기 창구 없음 · 붙여넣기/끌어놓기가 _capTake 하나로', () => {
    const a = WD.indexOf('/* ── 🛒 구매캡처 교체'), b = WD.indexOf('// 우클릭 [행 삭제]는', a);
    const seg = WD.slice(a, b);
    assert.ok(a > 0 && b > a);
    assert.ok(!/type="file"|type=\\"file\\"/.test(seg), '파일 선택 창구가 생겼다');
    assert.ok((seg.match(/_capTake\(/g) || []).length >= 3);
    assert.ok(/expectFileId:String\(st\.pre\.currentFileId/.test(seg), '지금 사진 대조값을 보내지 않는다');
    assert.ok(!/_capTake\([^)]*\)[^;]*_capSubmit\(/.test(seg));
  });
  await t('★ 화면: 두 창구 모두 내부 직원에게만', () => {
    assert.ok(/one&&selectedRow&&_isInternalRole\(\)\?row\('🛒','구매캡처 교체'/.test(WD));
    assert.ok(/const capBtn=\(kind==='cap'&&_isInternalRole\(\)\)/.test(WD));
  });
  await t('작업 로그 문구 있음', () => {
    assert.ok(/case 'capture_replaced':/.test(read('server/src/services/reviewerEventLog.service.js')));
  });

  console.log(`\n${fail ? '❌' : '✅'} purchaseCaptureReplace: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
