/**
 * 회귀가드 — 구매캡처 두 번째 장 (결정 255 · 사용자 확정 2026-10-16 "모두 권장" · migration 191)
 *
 * 배경: 아이폰 등은 구매내역이 한 화면에 다 담기지 않아 배송메세지가 잘렸다(시스템이 못 읽음). 리뷰어가 두 장으로 나눠 올릴 수 있게 한다.
 *
 * 고정하는 것:
 *   §1 저장 — 두 번째 장은 자기 칸(capture_file_id_2)에만, 같은 세션 검증·주문 잠금, 먼저 연결된 파일이 이긴다 · 첫 장 판정은 불변
 *   §2 업로드 라우트 — captureIndex 2 는 이름에 _2(첫 장을 지우지 않게) · 세션 "업로드 중"·실패 표시는 첫 장 전용
 *   §3 판독 — 두 번째 장은 배송메세지·상품만 있어도 성공 · 배송메세지는 첫 장 → 두 번째 장 순서 · 명의 확인은 첫 장만
 *   §4 소비처 — 미리보기 두 장 · 직원 교체 1/2 · 리뷰어 보기 · 정리·묘비·자동 연결이 두 번째 장을 안다
 *   §5 화면 — 리뷰어 카드의 2장째 칸 · 첫 장을 빼면 2장째도 빠진다 · 업로드는 첫 장 뒤에
 *
 * 실행: node tests/purchaseCaptureSecond.test.js
 */
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FRONT = p => fs.readFileSync(path.join(ROOT, '..', 'frontend', p), 'utf8');

(async function main() {
  console.log('\n§1 저장 — 두 번째 장은 자기 칸에만');
  const svc = require('../src/services/purchaseSubmissionSession.service');
  function pool(o) {
    const q = [];
    const query = async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
      if (/^BEGIN|^COMMIT|^ROLLBACK|pg_advisory_xact_lock/.test(s)) return { rows: [] };
      if (/FROM purchase_submission_sessions ps JOIN order_submissions os/.test(s) && /capture_file_id_2 AS "orderFileId2"/.test(s) && /FOR UPDATE OF os/.test(s)) {
        return { rows: o.invalid ? [] : [{ id: 'ps1', orderFileId2: o.cur2 || null }] };
      }
      if (/FROM purchase_submission_sessions ps JOIN order_submissions os/.test(s)) {
        return { rows: o.invalid ? [] : [{ id: 'ps1', status: 'completed', captureSheetId: 'S', captureTabName: 'T', sessionFileId: o.sess || null,
          orderSubmissionId: 'os1', orderFileId: o.cur1 || null, orderFileId2: o.cur2 || null }] };
      }
      return { rows: [], rowCount: 1 };
    };
    return { q, query, connect: async () => ({ query, release() {} }) };
  }
  await ta('1a 두 번째 장 조회는 그 칸만 본다 — 첫 장이 이미 있어도 막지 않는다', async () => {
    const p = pool({ cur1: 'F1' }); svc.__setPoolForTest(p);
    const a = await svc.inspectForUpload({ sessionId: 's', sessionToken: 't', orderSubmissionId: 'os1', captureIndex: 2 });
    assert.strictEqual(a.alreadyCompleted, false);
    const b = await svc.inspectForUpload({ sessionId: 's', sessionToken: 't', orderSubmissionId: 'os1' });
    assert.strictEqual(b.alreadyCompleted, true, '첫 장 판정은 종전 그대로');
    assert.strictEqual(b.captureFileId, 'F1');
  });
  await ta('1b 두 번째 장이 이미 있으면 그 파일을 돌려준다(새로 저장하지 않음)', async () => {
    svc.__setPoolForTest(pool({ cur1: 'F1', cur2: 'F2' }));
    const a = await svc.inspectForUpload({ sessionId: 's', sessionToken: 't', orderSubmissionId: 'os1', captureIndex: 2 });
    assert.strictEqual(a.alreadyCompleted, true); assert.strictEqual(a.captureFileId, 'F2');
  });
  await ta('1c ★ 두 번째 장 연결 — 주문 잠금 · 자기 칸만 UPDATE · 세션 상태·첫 장 업로드 시각은 건드리지 않는다', async () => {
    const p = pool({ cur1: 'F1' }); svc.__setPoolForTest(p);
    const r = await svc.completeCapture2({ sessionId: 'ps1', sessionToken: 't', orderSubmissionId: 'os1', captureFileId: 'N2' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.captureFileId, 'N2');
    assert.ok(p.q.some(x => /pg_advisory_xact_lock/.test(x.s) && x.params[0] === 'purchase_capture:os1'), '첫 장과 같은 주문 잠금 키');
    const up = p.q.find(x => /^UPDATE order_submissions/.test(x.s));
    assert.ok(/SET capture_file_id_2=\$2, capture2_uploaded_at=/.test(up.s));
    assert.ok(!/capture_file_id=\$2|capture_uploaded_at/.test(up.s.replace('capture2_uploaded_at', '')), '첫 장 칸을 건드리지 않는다');
    assert.ok(!p.q.some(x => /UPDATE purchase_submission_sessions/.test(x.s)), '세션 상태는 첫 장 전용');
  });
  await ta('1d 두 번째 장이 먼저 연결돼 있으면 덮지 않는다 · 세션이 틀리면 거부', async () => {
    svc.__setPoolForTest(pool({ cur2: 'OLD2' }));
    const r = await svc.completeCapture2({ sessionId: 'ps1', sessionToken: 't', orderSubmissionId: 'os1', captureFileId: 'N2' });
    assert.strictEqual(r.alreadyCompleted, true); assert.strictEqual(r.captureFileId, 'OLD2');
    svc.__setPoolForTest(pool({ invalid: true }));
    const r2 = await svc.completeCapture2({ sessionId: 'ps1', sessionToken: 'bad', orderSubmissionId: 'os1', captureFileId: 'N2' });
    assert.strictEqual(r2.code, 'capture_session_invalid');
    svc.__setPoolForTest(null);
  });

  console.log('\n§2 업로드 라우트');
  const diag = read('src/routes/diag.routes.js');
  const up = diag.slice(diag.indexOf("router.post('/image-upload'"), diag.indexOf("// POST /api/image/review-precheck"));
  await ta('2a captureIndex 2 = 이름에 _2(같은 이름이면 중복 정리가 첫 장을 휴지통으로 보낸다) · 자기 연결 함수', () => {
    assert.match(up, /const captureIndex = Number\(req\.body\.captureIndex\) === 2 \? 2 : 1;/);
    assert.match(up, /\$\{baseName\}\$\{second \? '_2' : ''\}__/);
    assert.match(up, /purchaseSessions\[second \? 'completeCapture2' : 'completeCapture'\]/);
    assert.match(up, /captureIndex,\n\s*\}\);/, '세션 조회에 칸 번호를 넘긴다');
  });
  await ta('2b 세션 "업로드 중"·실패 표시는 첫 장 전용(두 번째 장이 첫 장 상태를 망치지 않게)', () => {
    assert.match(up, /const claimed = second \? true : await purchaseSessions\.markUploading/);
    assert.match(up, /if \(!second\) await purchaseSessions\.markFailed/);
    assert.match(up, /if \(!\(req\.body && Number\(req\.body\.captureIndex\) === 2\)\) await purchaseSessions\.markFailed/);
  });
  await ta('2c 부팅 필수 목록 · 마이그레이션', () => {
    assert.match(read('index.js'), /\['order_submissions', 'capture_file_id_2'\]/);
    assert.ok(fs.existsSync(path.join(ROOT, 'migrations', '191_order_capture_second.sql')));
  });

  console.log('\n§3 판독');
  await ta('3a 두 번째 장은 배송메세지·상품만 있어도 성공(그 호출만) · 캐시에 넣지 않는다', () => {
    const g = read('src/services/gemini.service.js');
    assert.match(g, /const secondOnly = allBlank && opts\.allowSecondCapture === true && \(_v\('deliveryMemo'\) \|\| _v\('productName'\) \|\| _v\('productOption'\)\);/);
    assert.match(g, /if \(!productOnly && !secondOnly\) _putToCache/);
    assert.match(diag, /allowSecondCapture: secondCapture/);
  });
  await ta('3b 두 번째 장 배송메세지 서명은 주문번호가 없을 때만 화면이 보낸 주문번호에 묶는다(제출 때 주문번호 일치 검사 그대로)', () => {
    assert.match(diag, /const memoOrder = result\.orderNumber \|\| \(secondCapture \? String\(\(req\.body && req\.body\.orderNumberHint\) \|\| ''\)\.trim\(\) : ''\);/);
  });
  await ta('3c ★ 제출 — 배송메세지는 첫 장 서명 → 없으면 두 번째 장 서명', () => {
    const sub = read('src/routes/submit.routes.js');
    assert.match(sub, /readDeliveryMemoProof\(b\.deliveryMemoToken, orderNum\)\s*\n\s*\|\| reviewerOrderIdentity\.readDeliveryMemoProof\(b\.deliveryMemoToken2, orderNum\)/);
  });
  await ta('3d 실제 실행 — 두 번째 장 서명은 묶인 주문번호와 제출 주문번호가 같을 때만 읽힌다', () => {
    const roi = require('../src/services/reviewerOrderIdentity.service');
    const tok = roi.issueDeliveryMemoProof('문 앞에 놓아주세요', '2026101463729161');
    assert.strictEqual(roi.readDeliveryMemoProof(tok, '2026101463729161'), '문 앞에 놓아주세요');
    assert.strictEqual(roi.readDeliveryMemoProof(tok, '9999999999999999'), '', '다른 주문에는 못 붙인다');
  });

  console.log('\n§4 소비처');
  const tb = read('src/services/trackB.service.js');
  await ta('4a 제출물 미리보기 — 두 번째 장도 같은 줄에 이어 싣는다(첫 장 → 두 번째 장)', () => {
    assert.match(tb, /os\.capture_file_id_2, os\.capture2_uploaded_at,/);
    assert.match(tb, /\(os\.capture_file_id IS NOT NULL OR os\.capture_file_id_2 IS NOT NULL\)/);
    assert.match(tb, /if \(o\.capture_file_id\) push\(seq, o\.capture_file_id, 'order_capture'[\s\S]{0,80}\n\s*if \(o\.capture_file_id_2\) push\(seq, o\.capture_file_id_2, 'order_capture'/);
  });
  await ta('4b 직원 교체 — 2장째는 그 칸만 바꾸고 배송메세지를 안 비운다 · 실제 실행', async () => {
    const rep = require('../src/services/purchaseCaptureReplace.service');
    const drive = require('../src/services/drive.service');
    const cf = require('../src/services/captureFolder.service');
    const real = { up: drive.uploadFileBase64, trash: drive.trashFiles, folder: cf.resolveCaptureFolder };
    drive.uploadFileBase64 = async () => ({ id: 'NEW2', name: 'n' });
    drive.trashFiles = async () => ({ success: true });
    cf.resolveCaptureFolder = async () => ({ folderId: 'fold' });
    process.env.AI_REVIEW_FOLDER_ID = process.env.AI_REVIEW_FOLDER_ID || 'root';
    const q = [];
    const query = async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
      if (/FROM campaign_participants cp WHERE cp\.id=\$1/.test(s)) return { rows: [{ id: 'r1', seq: 3, order_submission_id: 'os1', reviewer_name: '김혜진', recipient_name: '김혜진', phone8: '83540507', table_order_num: '' }] };
      if (/FROM tab_configs/.test(s)) return { rows: [{ gid: '1' }] };
      if (/FROM order_submissions os WHERE os\.deleted_at IS NULL/.test(s)) return { rows: [{ id: 'os1', capture_file_id: 'F1', capture_file_id_2: 'F2', recipient: '김혜진', orderer: '김혜진', phone: '010-8354-0507', order_num: '' }] };
      if (/SELECT capture_file_id, capture_file_id_2 FROM order_submissions WHERE id=\$1/.test(s)) return { rows: [{ capture_file_id: 'F1', capture_file_id_2: 'F2' }] };
      if (/SELECT 1 FROM order_submissions WHERE \(capture_file_id=\$1 OR capture_file_id_2=\$1\)/.test(s)) return { rows: [] };
      return { rows: [], rowCount: 1 };
    };
    rep.__setPoolForTest({ query, connect: async () => ({ query, release() {} }) });
    try {
      const out = await rep.replaceCapture({ sheetId: 'S', tabName: 'T', rowId: 'r1', imageBase64: Buffer.from('xx').toString('base64'), mimeType: 'image/png', expectFileId: 'F2', captureIndex: 2, by: '망고' });
      assert.strictEqual(out.ok, true, JSON.stringify(out)); assert.strictEqual(out.captureIndex, 2);
      const upd = q.find(x => /^UPDATE order_submissions/.test(x.s));
      assert.ok(/SET capture_file_id_2=\$2/.test(upd.s)); assert.ok(!/delivery_memo/.test(upd.s), '2장째 교체는 배송메세지를 안 비운다');
      const bad = await rep.replaceCapture({ sheetId: 'S', tabName: 'T', rowId: 'r1', imageBase64: Buffer.from('xx').toString('base64'), mimeType: 'image/png', expectFileId: 'F1', captureIndex: 2 });
      assert.strictEqual(bad.error, 'capture_changed', '2장째 대조값은 2장째 칸과 비교');
    } finally { drive.uploadFileBase64 = real.up; drive.trashFiles = real.trash; cf.resolveCaptureFolder = real.folder; rep.__setPoolForTest(null); }
  });
  await ta('4c 리뷰어 구매내역 보기 · 정리·묘비·자동 연결·다른 교체가 두 번째 장을 안다', () => {
    assert.match(read('src/routes/reviewEdit.routes.js'), /fileId2: String\(caps\[0\]\.capture_file_id_2 \|\| ''\)/);
    const oc = read('src/services/orphanCaptureCleanup.service.js');
    assert.strictEqual((oc.match(/capture_file_id_2/g) || []).length >= 5, true, '고아 정리 후보·제외·폴더 아는 파일 모두');
    assert.match(read('src/services/workTabDelete.service.js'), /os\.capture_file_id_2 IS NOT NULL/);
    assert.match(read('src/services/reviewCaptureReplace.service.js'), /capture_file_id=\$1 OR capture_file_id_2=\$1/);
    assert.match(read('src/services/captureLinkBackfill.service.js'), /OR capture_file_id_2 = \$1\) LIMIT 1/);
  });

  console.log('\n§5 화면');
  const sa = FRONT('js/search-app.js');
  await ta('5a 사진 칸 하나에서 한 번에 두 장(별도 추가 버튼 없음 · 사용자 요청) · 2장째 칸은 둘째 장이 있을 때만 · 첫 장을 빼면 2장째도 빠진다', () => {
    assert.strictEqual((sa.match(/<input type="file" accept="image\/\*" multiple id="\$\{cid\}_imgInput"/g) || []).length, 2, '두 카드 모양 모두 여러 장 선택');
    assert.strictEqual((sa.match(/id="\$\{cid\}_img2Box"/g) || []).length, 2);
    assert.ok(!/_img2Add|_img2Input/.test(sa), '별도 추가 버튼·입력칸이 없다');
    assert.match(sa, /if \(imgs\.length > 2\) showToast\(/, '세 장 이상은 앞의 두 장만');
    assert.match(sa, /_takeCardImgFiles\(\[\.\.\.input\.files\], cid\)/);
    assert.match(sa, /_takeCardImgFiles\(files, cid\);/, '끌어놓기도 같은 규칙');
    assert.match(sa, /removeCardImg2\(cid\); \{ const b2 = document\.getElementById\(cid \+ "_img2Box"\); if \(b2\) b2\.style\.display = "none"; \}/);
  });
  await ta('5a2 둘째 장 판독은 첫 장 판독이 끝난 뒤(주문번호에 배송메세지 서명을 묶기 위해)', () => {
    assert.match(sa, /_setCardImg2\(imgs\[1\], cid, \{ deferAi: true \}\);/);
    assert.match(sa, /_processCardImgFile\(imgs\[0\], cid\)\.then\(/);
  });
  await ta('5b 2장째 판독은 명의 증명을 건드리지 않는다(첫 장 증명만 제출) · 상품명은 첫 장에 없을 때만', () => {
    const f = sa.slice(sa.indexOf('async function _callCardExtractAi2('), sa.indexOf('/** ★ Promise 반환'));
    assert.ok(!/approvalToken|extractToken|imageHash|identity/.test(f), '2장째 판독이 명의 확인 상태를 바꾸면 안 된다');
    assert.match(f, /captureIndex: 2, orderNumberHint: orderHint/);
    assert.match(f, /!_OFP\.capName\[cid\] && json\.productName/);
  });
  await ta('5c 제출 — 2장째 사진·서명을 싣고, 업로드는 첫 장 뒤에 captureIndex 2 로', () => {
    assert.match(sa, /deliveryMemoToken2: _cardAiState\[cid\]\?\.img2\?\.memoToken \|\| ""/);
    assert.match(sa, /deliveryMemoToken2: o\.deliveryMemoToken2 \|\| ""/);
    const q = sa.slice(sa.indexOf('window._capUploadChain = (window._capUploadChain'), sa.indexOf('}).catch(() => {});   // 한 건의 예외가 큐를 끊지 않게'));
    assert.ok(q.indexOf('_runCapUpload(_imgCtx, 1)') < q.indexOf('}, 2);'), '첫 장 다음에 두 번째 장');
    assert.match(sa, /captureSessionToken:_capSession\.token, captureIndex \};/);
  });
  await ta('5d 직원 교체 창 — 1장째/2장째 고르기 · 미리보기에서 보던 장으로 열기', () => {
    const wd = FRONT('workdesk.html');
    assert.match(wd, /바꿀 사진을 고르세요 \(구매캡처는 최대 2장\)/);
    assert.match(wd, /_capState\.wantFid&&String\(r\.currentFileId2\|\|''\)===_capState\.wantFid\) _capState\.pick=1;/);
  });
  await ta('5e 리뷰어 구매내역 보기 — 두 번째 장을 이어서 보여 준다', () => {
    const ix = FRONT('index.html');
    assert.match(ix, /fileId2:pc\.fileId2 \? String\(pc\.fileId2\) : ''/);
    assert.match(ix, /capture\.fileId2 \? '<div class="part-info-capture-meta" style="margin-top:10px">2장째<\/div>/);
  });

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
