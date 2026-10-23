/**
 * 결정 245 — 구매캡처 배송메세지(배송요청사항·배송메모)를 AI 가 읽어 주문에 남기고 작업보드 미리보기에 보인다.
 *   A. 순수 — 서명 발급·읽기(바꿔치기·만료·다른 용도 서명은 '' · 제출을 막지 않는다)
 *   B. 배선 — 판독 칸·캐시 접두·판독 응답·제출·원장 INSERT·교체 시 비움·명단(업체는 주문 줄이 맞을 때만)·화면
 *   C. PGTEST_URL(전체 마이그레이션 DB) 있으면 진짜 PG: 원장 저장 → workdeskTab(내부·업체) → 구매캡처 교체 시 비움
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const roi = require('../src/services/reviewerOrderIdentity.service');

// ── A. 서명 ──
{
  const t = roi.issueDeliveryMemoProof('  문 앞에 놓아주세요\n공동현관 #1234  ', '2026101412345');
  assert.ok(t, 'memo → token');
  assert.equal(roi.readDeliveryMemoProof(t, '2026101412345'), '문 앞에 놓아주세요 공동현관 #1234', 'control chars/space folded');
  assert.equal(roi.readDeliveryMemoProof(t, ' 2026-1014-12345 '), '문 앞에 놓아주세요 공동현관 #1234', 'order number compared by letters/digits only');
  assert.equal(roi.readDeliveryMemoProof(t, '2026101499999'), '', 'token from another capture (different order) → blank');
  assert.equal(roi.readDeliveryMemoProof(t, ''), '', 'no order number on submit → blank');
  assert.equal(roi.issueDeliveryMemoProof('문 앞', ''), '', 'capture without order number → no token (nothing to bind)');
  assert.equal(roi.issueDeliveryMemoProof('', '1'), '', 'blank memo → no token');
  assert.equal(roi.issueDeliveryMemoProof(null, '1'), '');
  assert.equal(roi.readDeliveryMemoProof('', '1'), '', 'no token → blank (old screen)');
  assert.equal(roi.readDeliveryMemoProof(t.slice(0, -3) + 'abc', '2026101412345'), '', 'tampered → blank');
  assert.equal(roi.readDeliveryMemoProof('not-a-jwt', '1'), '', 'garbage → blank, never throws');
  const extractTok = roi.issueExtractionProof({ imageHash: 'h', extracted: {}, ok: true }).extractToken;
  assert.equal(roi.readDeliveryMemoProof(extractTok, '1'), '', 'other purpose token → blank');
  const long = roi.readDeliveryMemoProof(roi.issueDeliveryMemoProof('가'.repeat(500), 'A1'), 'a-1');
  assert.equal(long.length, 200, 'capped at 200');
  // 명의 확인 해시(7칸)는 배송메세지와 무관 — 새로고침 안 한 화면이 EXTRACT_FIELDS_TAMPERED 로 막히지 않는다
  assert.equal(roi.fieldsHash({ recipient: 'a' }), roi.fieldsHash({ recipient: 'a', deliveryMemo: 'x' }));
}

// ── B. 배선 ──
{
  const g = read('server/src/services/gemini.service.js');
  assert.ok(/"deliveryMemo": "배송요청사항\/배송메모/.test(g), 'prompt asks for deliveryMemo');
  assert.ok(/const EXTRACT_CACHE_VERSION = 'extract5';/.test(g), 'cache prefix bumped (old cache lacks the field)');
  const d = read('server/src/routes/diag.routes.js');
  assert.ok(/issueDeliveryMemoProof\(result\.deliveryMemo, result\.orderNumber\)/.test(d) && /productLabel, deliveryMemoToken \}\)/.test(d), 'extract response carries signed memo');
  const sr = read('server/src/routes/submit.routes.js');
  assert.ok(/deliveryMemo: reviewerOrderIdentity\.readDeliveryMemoProof\(b\.deliveryMemoToken, orderNum\)/.test(sr), 'submit takes memo only from the signature');
  const ol = read('server/src/services/orderLedger.service.js');
  const m = ol.match(/const ORDER_INSERT_SQL = `INSERT INTO order_submissions\s*\(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)\s*RETURNING id`/);
  assert.ok(m, 'insert sql found');
  const cols = m[1].split(',').map(s => s.trim());
  const vals = m[2].split(',').map(s => s.trim());
  assert.equal(cols.length, vals.length, 'insert columns == values');
  assert.equal(vals[cols.indexOf('delivery_memo')], '$21', 'delivery_memo bound to $21');
  // 결정 260: 뒤에 $22(deliveryMemoCheck)가 붙을 수 있다 — deliveryMemo 가 source 바로 다음($21)이라는 검사 의미는 그대로.
  assert.ok(/source \|\| 'order_submit',\n[^\n]*\n\s*orderData\.deliveryMemo \|\| '',\n(?:[^\n]*\n\s*orderData\.deliveryMemoCheck \|\| '',\n)?  \];/.test(ol), '$21 param is deliveryMemo (after source)');
  assert.ok(/delivery_memo=''/.test(read('server/src/services/purchaseCaptureReplace.service.js')), 'capture replace clears memo');
  assert.ok(/ADD COLUMN IF NOT EXISTS delivery_memo TEXT NOT NULL DEFAULT ''/.test(read('server/migrations/188_order_delivery_memo.sql')));
  assert.ok(/\['order_submissions', 'delivery_memo'\]/.test(read('server/index.js')), 'schema preflight');
  const tb = read('server/src/services/trackB.service.js');
  assert.ok(/if \(\(showEdits \|\| \(advertiserOrder && _sameSheetRow\(r\.seq, advertiserOrder\.sheetRow\) && await advOwnsTab\(\)\)\)/.test(tb), 'advertiser only on own tab and on this exact order row');
  assert.ok(/if \(_advOwns && brandId\) _advOwns = await brandTabAllowed\(\{ brandId, advertiserId, sheetId, tabName \}\)\.catch\(\(\) => false\);/.test(tb), 'brand session: assigned tabs only');
  assert.ok(/await canAccessTab\(\{ role, staffName, advertiserId, sheetId, tabName \}\)\.catch\(\(\) => false\)/.test(tb), 'ownership lookup failure = hidden');
  // 판독 응답이 JSON 으로 안 풀려도 배송메세지를 건진다
  const fbStart = g.indexOf('function _fallbackParse');
  const fbSrc = g.slice(fbStart, g.indexOf('\n}\n', fbStart) + 2);
  assert.ok(/deliveryMemo: ''/.test(fbSrc) && /deliveryMemo: \/\["'\]\?deliveryMemo/.test(fbSrc), 'fallback parser covers deliveryMemo');
  const fbFn = new Function(fbSrc + '; return _fallbackParse;')();
  assert.equal(fbFn('{"orderNumber": "1", "deliveryMemo": "경비실에 맡겨주세요", oops').deliveryMemo, '경비실에 맡겨주세요');
  // 옛 관리자 대시보드 폐기(결정 267) — 옛 구매양식(admin.html ?mode=form)은 search.html 로 넘어가므로 그 검사는 아래 search-app 검사가 맡는다.
  // 구매캡처 교체 뒤 화면 명단에서도 지운다(명단을 다시 받지 않으므로)
  assert.ok(/if\(!isRev&&rowId\)\{ const rr=\(STATE\.wd&&STATE\.wd\.roster\|\|\[\]\)\.find\(x=>String\(x\.id\)===String\(rowId\)\); if\(rr\) delete rr\.deliveryMemo; \}/.test(read('frontend/workdesk.html')), 'replace clears memo in the open preview');
  assert.ok(/NULL::text AS "deliveryMemo"/.test(tb) && /purpose_order\.delivery_memo AS "deliveryMemo"/.test(tb), 'both roster queries carry the column');
  const sa = read('frontend/js/search-app.js');
  assert.ok(/st\.deliveryMemoToken = json\.deliveryMemoToken \|\| "";/.test(sa));
  assert.ok(/deliveryMemoToken:  o\.deliveryMemoToken \|\| "",/.test(sa), 'submit payload');
  assert.equal((sa.match(/deliveryMemoToken ?= ?""/g) || []).length, 2, 'cleared on new analysis and on image removal');
}

// ── B2. 화면 — 미리보기 한 줄(실행) ──
{
  const wd = read('frontend/workdesk.html');
  const start = wd.indexOf('function _rvRender2(pane){');
  const end = wd.indexOf('\n}\n', start) + 3;
  const fnSrc = wd.slice(start, end);
  const outs = [];
  const ctx = {
    STATE: { rvImgs: {}, rvSel: 'r1', wd: { roster: [] } },
    _rvReceiptActive: () => false, _rvStatHtml: () => '', _rvNoHtml: () => '', _rvWho: (r) => r.name,
    _rvFill: (p, h) => outs.push(h), _rvKindFiles: () => [], _rvUrl: () => '', _thumbAttrs: () => '',
    _isInternalRole: () => false, _rvReceiptApplies: () => false,
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc, ctx);
  ctx.STATE.wd.roster = [{ id: 'r1', seq: 1, name: '홍', submitted: true, deliveryMemo: '<b>문 앞</b>' }];
  ctx._rvRender2({});
  assert.ok(/class="rvmemo"/.test(outs[0]) && /&lt;b&gt;문 앞&lt;\/b&gt;/.test(outs[0]), 'memo line shown, escaped');
  ctx.STATE.wd.roster = [{ id: 'r1', seq: 1, name: '홍', submitted: true }];
  ctx._rvRender2({});
  assert.ok(!/rvmemo/.test(outs[1]), 'no memo → no line (old server/old orders)');
}

async function pg() {
  const pool = require('../src/db/pool');
  const tb = require('../src/services/trackB.service');
  const sid = 'dm-test-' + Date.now(), tab = '배송메세지탭';
  try {
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name) VALUES ($1,$2,'1','배송메세지 테스트')`, [sid, tab]);
    const ins = async (row, memo) => (await pool.query(
      `INSERT INTO order_submissions (sheet_id, tab_name, gid, tab_gid, recipient, phone, price, sheet_row, delivery_memo, capture_file_id)
       VALUES ($1,$2,'1','1','가짜수취인','010-0000-0000','10000',$3,$4,'old-file') RETURNING id`, [sid, tab, row, memo])).rows[0].id;
    const o1 = await ins(1, '문 앞에 놓아주세요');
    const o2 = await ins(99, '경비실에 맡겨주세요');   // 업체: 기록된 줄(99)과 명단 줄(2)이 다르다 → 싣지 않는다
    const o3 = await ins(3, '');
    // 4번 줄 = 1번 주문이 옛 중복으로 함께 연결된 줄(기록 행은 1) — 업체에는 1번 줄에만 보여야 한다
    for (const [seq, oid] of [[1, o1], [2, o2], [3, o3], [4, o1]]) {
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, reviewer_name, order_submission_id, active)
                        VALUES ($1,$2,$3,$5,$4,TRUE)`, [sid, tab, seq, oid, '가짜' + seq]);
    }
    const memoBySeq = (res) => Object.fromEntries((res.roster || []).map(r => [r.seq, r.deliveryMemo]));
    const inner = memoBySeq(await tb.workdeskTab({ sheetId: sid, tabName: tab, role: 'master' }));
    assert.deepEqual(inner, { 1: '문 앞에 놓아주세요', 2: '경비실에 맡겨주세요', 3: undefined, 4: '문 앞에 놓아주세요' }, 'internal sees memo; blank → absent');
    const other = memoBySeq(await tb.workdeskTab({ sheetId: sid, tabName: tab, role: 'advertiser', advertiserId: 'dm-adv-other', allowAllWorkdesk: true }));
    assert.deepEqual(other, { 1: undefined, 2: undefined, 3: undefined, 4: undefined }, 'another advertiser (not owner) sees no memo');
    await pool.query(`INSERT INTO advertisers (id, name) VALUES ('dm-adv-own','가짜업체') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO advertiser_campaigns (advertiser_id, sheet_id) VALUES ('dm-adv-own',$1)`, [sid]);
    const adv = memoBySeq(await tb.workdeskTab({ sheetId: sid, tabName: tab, role: 'advertiser', advertiserId: 'dm-adv-own', allowAllWorkdesk: true }));
    assert.deepEqual(adv, { 1: '문 앞에 놓아주세요', 2: undefined, 3: undefined, 4: undefined }, 'owner advertiser only on the exact order row (not the stale duplicate)');
    // 브랜드 링크 세션 — 같은 업체라도 그 브랜드에 배정된 탭만
    const brandView = async (brandId) => memoBySeq(await tb.workdeskTab({ sheetId: sid, tabName: tab, role: 'advertiser', advertiserId: 'dm-adv-own', brandId, allowAllWorkdesk: true }));
    assert.deepEqual(await brandView('dm-brand-b'), { 1: undefined, 2: undefined, 3: undefined, 4: undefined }, 'unassigned brand sees no memo');
    await pool.query(`INSERT INTO trackb_brand_tab_map (brand_id, advertiser_id, sheet_id, tab_name) VALUES ('dm-brand-a','dm-adv-own',$1,$2)`, [sid, tab]);
    assert.deepEqual(await brandView('dm-brand-a'), adv, 'assigned brand = owner view');
    // 구매캡처 교체 — 같은 UPDATE 를 실제 DB 에 실행(드라이브 없이 SQL 만)
    const svcSrc = read('server/src/services/purchaseCaptureReplace.service.js');
    const upd = svcSrc.match(/`(UPDATE order_submissions\s+SET capture_file_id=\$2[\s\S]*?)`/)[1].replace(/--[^\n]*/g, '');
    await pool.query(upd, [o1, 'new-file']);
    const after = (await pool.query(`SELECT delivery_memo, capture_file_id FROM order_submissions WHERE id=$1`, [o1])).rows[0];
    assert.deepEqual(after, { delivery_memo: '', capture_file_id: 'new-file' }, 'replace clears memo');
    console.log('deliveryMemoCapture: PG passed');
  } finally {
    await pool.query(`DELETE FROM campaign_participants WHERE sheet_id=$1`, [sid]).catch(() => {});
    await pool.query(`DELETE FROM order_submissions WHERE sheet_id=$1`, [sid]).catch(() => {});
    await pool.query(`DELETE FROM tab_configs WHERE sheet_id=$1`, [sid]).catch(() => {});
    await pool.query(`DELETE FROM advertiser_campaigns WHERE sheet_id=$1`, [sid]).catch(() => {});
    await pool.query(`DELETE FROM trackb_brand_tab_map WHERE sheet_id=$1`, [sid]).catch(() => {});
    await pool.query(`DELETE FROM advertisers WHERE id='dm-adv-own'`).catch(() => {});
    await pool.end().catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) await pg();
  console.log('deliveryMemoCapture: passed');
})().catch((e) => { console.error(e); process.exit(1); });
