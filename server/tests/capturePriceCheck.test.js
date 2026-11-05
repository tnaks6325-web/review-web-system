/**
 * capturePriceCheck.test.js — 결정 319 회귀가드 (사용자 확정 2026-11-02)
 *   A. 순수 판정 — 쿠팡 30% 초과만 막음 · 쿠팡 밖 1,000원 초과만 알림 · 직원 확인 요청/확인 후 = 🚩 · 더 싸게 산 쿠팡은 통과
 *   B. 공고 금액 읽기(스텁 pool) — 단계 금액 → 고른 상품(신청 시각 금액) → 상품 글자(금액 하나일 때만) · 구매처 모름·조회 실패 = 판정 안 함 · 쓰기 0
 *   C. 배선 — 게이트 위치(필수 배송메세지 뒤 · 쓰기 전) · 「맞다」 답 🚩 · 원장 $23 · 스키마 · 작업보드 내부만 · 화면 처리
 *   D. (PGTEST_URL) 진짜 PG + 실제 제출 라우트 — 막힘 = 쓰기 0 · 확인/직원 확인 요청 → 접수 + capture_flags · 가격 신고 · 작업보드 내부만
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const cpc = require('../src/services/capturePriceCheck.service');

function stubDb(routes, opts = {}) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push(sql);
      if (opts.throws) throw new Error('db down');
      if (/\b(UPDATE|INSERT|DELETE)\b/i.test(sql)) throw new Error('쓰기 금지 — 판정은 쓰기 0');
      for (const [re, rows] of routes) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(sql, params) : rows };
      return { rows: [] };
    },
  };
}
const HOLD = (o = {}) => ({ verified: true, campaignId: 'camp_x', applicationId: 9, holdToken: 't', phone8: '12345678', ...o });

function pure() {
  const J = cpc.judge;
  // 쿠팡
  assert.equal(J({ kind: 'coupang', expected: 25000, paid: 25000 }).action, 'none');
  assert.equal(J({ kind: 'coupang', expected: 7730, paid: 9980 }).action, 'none', '로켓 변동(+29%)은 통과');
  assert.equal(J({ kind: 'coupang', expected: 25000, paid: 32500 }).action, 'none', '정확히 30% = 통과(넘을 때만)');
  assert.equal(J({ kind: 'coupang', expected: 25000, paid: 32510 }).action, 'block');
  assert.equal(J({ kind: 'coupang', expected: 25000, paid: 45000 }).action, 'block', '2개 구매');
  assert.equal(J({ kind: 'coupang', expected: 25000, paid: 12000 }).action, 'none', '더 싸게(쿠폰) = 통과');
  assert.equal(J({ kind: 'coupang', expected: 25000, paid: 45000, ack: true }).action, 'block', '쿠팡은 「그대로 제출」로 못 넘는다');
  const so = J({ kind: 'coupang', expected: 25000, paid: 45000, staffReview: true });
  assert.deepEqual([so.action, so.code, so.expected, so.paid], ['flag', 'price_over', 25000, 45000]);
  assert.ok(/45,000원/.test(J({ kind: 'coupang', expected: 25000, paid: 45000 }).error) && /25,000원/.test(J({ kind: 'coupang', expected: 25000, paid: 45000 }).error));
  // 차이 금액·비율까지 보인다(사용자 확정 2026-11-02)
  assert.equal(J({ kind: 'other', expected: 25000, paid: 43000 }).error.split(' 주문한')[0],
    '제출하신 구매캡처 속 결제금액(43,000원)이 작업 조건 결제금액(25,000원)보다 18,000원 더 비쌉니다(72% 초과).');
  assert.ok(/보다 5,000원 더 쌉니다\(20% 적음\)/.test(J({ kind: 'other', expected: 25000, paid: 20000 }).error));
  assert.ok(/보다 20,000원 더 비쌉니다\(80% 초과\)/.test(J({ kind: 'coupang', expected: 25000, paid: 45000 }).error));
  assert.ok(/7,510원 더 비쌉니다\(30\.0% 초과\)/.test(J({ kind: 'coupang', expected: 25000, paid: 32510 }).error), '30% 언저리는 소수 한 자리');
  assert.ok(/\(30\.4% 초과\)/.test(J({ kind: 'coupang', expected: 25000, paid: 32600 }).error));
  // 쿠팡 밖
  assert.equal(J({ kind: 'other', expected: 25000, paid: 26000 }).action, 'none', '1,000원 = 통과(넘을 때만)');
  assert.equal(J({ kind: 'other', expected: 25000, paid: 24000 }).action, 'none');
  assert.equal(J({ kind: 'other', expected: 25000, paid: 26001 }).action, 'warn');
  assert.equal(J({ kind: 'other', expected: 25000, paid: 43000 }).action, 'warn', '앰플 사례');
  assert.equal(J({ kind: 'other', expected: 25000, paid: 20000 }).action, 'warn', '더 싸게도 알린다(다른 상품일 수 있다)');
  const od = J({ kind: 'other', expected: 25000, paid: 43000, ack: true });
  assert.deepEqual([od.action, od.code], ['flag', 'price_diff']);
  // 모름 = 아무 일 없음
  for (const x of [{ kind: '', expected: 1, paid: 9 }, { kind: 'other', expected: 0, paid: 9000 }, { kind: 'coupang', expected: 9000, paid: 0 }]) {
    assert.equal(J(x).action, 'none');
  }
  assert.equal(cpc.channelKind('쿠팡'), 'coupang'); assert.equal(cpc.channelKind(' 쿠팡 로켓'), 'coupang');
  assert.equal(cpc.channelKind('네이버'), 'other'); assert.equal(cpc.channelKind('올리브영'), 'other'); assert.equal(cpc.channelKind('카카오메이커스'), 'other');
  assert.equal(cpc.channelKind(''), ''); assert.equal(cpc.channelKind(null), '');
  assert.equal(cpc.uniquePayFromProductLines('엘릭서 앰플 50ml - 결제금액 25,000원'), 25000);
  assert.equal(cpc.uniquePayFromProductLines('A - 결제금액 25,000원\nB - 결제금액 25000 원'), 25000, '같은 금액 두 줄 = 하나');
  assert.equal(cpc.uniquePayFromProductLines('A - 결제금액 25,000원\nB - 결제금액 30,000원'), 0, '2종 이상 = 모름');
  assert.equal(cpc.uniquePayFromProductLines(''), 0);
  // 리뷰어 화면(campaign-workdetail)과 같은 규칙 — 글자에 금액이 없으면 payAmount · 2종 이상이면 payAmount 가 있어도 모름(Codex 리뷰)
  assert.equal(cpc.wholeCampaignPay('앰플 50ml', 25000), 25000);
  assert.equal(cpc.wholeCampaignPay('앰플 - 결제금액 26,000원', 25000), 26000, '글자 금액이 먼저(화면이 보여 주는 값)');
  assert.equal(cpc.wholeCampaignPay('A 결제금액 1,000원 / B 결제금액 2,000원', 25000), 0);
  assert.equal(cpc.wholeCampaignPay('', null), 0);
}

async function stubs() {
  const camp = (channel, pl) => [/FROM recruit_campaigns/, [{ channel, pl }]];
  // 상품 글자 금액(상품 1개 공고 — 앰플 사례)
  let d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '43,000', db: stubDb([camp('네이버', '앰플 - 결제금액 25,000원')]) });
  assert.equal(d.action, 'warn'); assert.equal(d.expected, 25000); assert.equal(d.paid, 43000); assert.equal(d.paidSource, 'capture');
  // AI 값 우선 — 리뷰어가 적은 값이 공고 금액과 다르면 AI 값으로 본다
  d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '43000', typedPrice: '30000', db: stubDb([camp('네이버', '결제금액 25,000원')]) });
  assert.equal(d.action, 'warn'); assert.equal(d.paid, 43000); assert.equal(d.paidSource, 'capture');
  // ★ 결정 319 개정(사용자 확정 2026-11-05 「b」) — 양식 금액 = 공고 금액이면 캡처와 상관없이 통과(배송비 잘린 캡처)
  d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '9,900', typedPrice: '12,400', db: stubDb([camp('올리브영', '결제금액 12,400원')]) });
  assert.equal(d.action, 'none', '올리브영 배송비 잘린 캡처'); assert.equal(d.typedMatch, true);
  d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '45000', typedPrice: '25000', db: stubDb([camp('쿠팡', '결제금액 25,000원')]) });
  assert.equal(d.action, 'none', '쿠팡도 같다(사용자가 위험을 알고 고름)');
  d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '9900', typedPrice: '9,900', db: stubDb([camp('올리브영', '결제금액 12,400원')]) });
  assert.equal(d.action, 'warn', '양식도 9,900원이면 종전대로 알림');
  d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '9900', typedPrice: '', db: stubDb([camp('올리브영', '결제금액 12,400원')]) });
  assert.equal(d.action, 'warn', '양식 금액이 없으면 종전대로');
  // AI 값이 없으면 리뷰어가 적은 값
  d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '', typedPrice: '43,000', db: stubDb([camp('네이버', '결제금액 25,000원')]) });
  assert.equal(d.action, 'warn'); assert.equal(d.paidSource, 'typed');
  // 글자에 금액 없음 + payAmount (Codex 리뷰 재현: 화면엔 25,000원인데 43,000원이 그냥 통과하던 경우)
  d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '43000', db: stubDb([[/FROM recruit_campaigns/, [{ channel: '네이버', pl: '앰플 50ml', pay: '25000' }]]]) });
  assert.equal(d.action, 'warn'); assert.equal(d.expected, 25000);
  // 고른 상품 금액(신청 시각 금액 규칙 — productMismatchVerify 와 같은 함수)
  const opts = [/FROM campaign_options/, [{ id: 1, opt_key: 'A', pay_amount: 10000, status: 'active' }, { id: 2, opt_key: 'B', pay_amount: 20000, status: 'active' }]];
  d = await cpc.decideAtSubmit({ holdCtx: HOLD({ optionKey: 'B' }), capturePrice: '30000', db: stubDb([camp('쿠팡', ''), opts]) });
  assert.equal(d.action, 'block'); assert.equal(d.expected, 20000);
  d = await cpc.decideAtSubmit({ holdCtx: HOLD({ optionKey: 'B' }), capturePrice: '25000', db: stubDb([camp('쿠팡', ''), opts]) });
  assert.equal(d.action, 'none', '쿠팡 +25% 통과');
  // 단계 금액이 가장 먼저
  d = await cpc.decideAtSubmit({ holdCtx: HOLD({ optionKey: 'B', qtyTierAmount: 40000 }), capturePrice: '40000', db: stubDb([camp('쿠팡', ''), opts]) });
  assert.equal(d.action, 'none', '2개 단계를 고른 사람의 2개 금액은 정상');
  // 상품 글자 금액 2종 이상 · 옵션 없음 = 모름
  d = await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '99000', db: stubDb([camp('네이버', '결제금액 1,000원 / 결제금액 2,000원')]) });
  assert.equal(d.action, 'none');
  // 구매처 모름 · 공고 없음 · 조회 실패 · 미검증 홀드 · 이미 접수된 홀드 · 스위치 = 판정 안 함
  assert.equal((await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '99000', db: stubDb([camp('', '결제금액 1,000원')]) })).action, 'none');
  assert.equal((await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '99000', db: stubDb([]) })).action, 'none');
  assert.equal((await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '99000', db: stubDb([], { throws: true }) })).action, 'none', 'fail-open');
  assert.equal((await cpc.decideAtSubmit({ holdCtx: HOLD({ verified: false }), capturePrice: '99000', db: stubDb([camp('네이버', '결제금액 1,000원')]) })).action, 'none');
  assert.equal((await cpc.decideAtSubmit({ holdCtx: HOLD({ doneKind: 'confirmed' }), capturePrice: '99000', db: stubDb([camp('네이버', '결제금액 1,000원')]) })).action, 'none');
  assert.equal((await cpc.decideAtSubmit({ holdCtx: null, capturePrice: '99000', db: stubDb([camp('네이버', '결제금액 1,000원')]) })).action, 'none');
  process.env.CAPTURE_PRICE_CHECK = '0';
  assert.equal((await cpc.decideAtSubmit({ holdCtx: HOLD(), capturePrice: '99000', db: stubDb([camp('네이버', '결제금액 1,000원')]) })).action, 'none', '스위치');
  delete process.env.CAPTURE_PRICE_CHECK;
}

function wiring() {
  const sr = read('server/src/routes/submit.routes.js');
  const iMemo = sr.indexOf("code: 'DELIVERY_MEMO_REQUIRED'");
  const iGate = sr.indexOf("require('../services/capturePriceCheck.service')");
  const iLedger = sr.indexOf('const ledger = await createOrderLedgerEntry(');
  assert.ok(iMemo > 0 && iGate > iMemo && iLedger > iGate, '게이트 = 필수 배송메세지 뒤 · 원장 쓰기 전');
  const gate = sr.slice(iGate, iLedger);
  assert.ok(/CAPTURE_PRICE_OVER/.test(gate) && /CAPTURE_PRICE_DIFF/.test(gate));
  assert.ok(/capturePrice: b\.productCapturePrice, typedPrice: price/.test(gate), 'AI 판독값 우선 · 적은 값 폴백');
  assert.ok(/orderData\.captureFlags = captureFlags/.test(gate));
  const iDecl = sr.indexOf('const captureFlags = [];');
  assert.ok(iDecl > 0 && iDecl < sr.indexOf("code: 'PRODUCT_MISMATCH'"), '플래그 그릇은 상품 판정 앞');
  assert.ok(/captureFlags\.push\(\{ code: 'product_differs'/.test(sr) && /captureFlags\.push\(\{ code: 'qty_differs'/.test(sr), '「맞다」 답 🚩');
  assert.ok(/recordPriceReport\(\{ orderSubmissionId: _osid/.test(sr), '가격 신고 연동');
  const ol = read('server/src/services/orderLedger.service.js');
  const m = ol.match(/const ORDER_INSERT_SQL = `INSERT INTO order_submissions\s*\(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)\s*RETURNING id`/);
  const cols = m[1].split(',').map(s => s.trim()); const vals = m[2].split(',').map(s => s.trim());
  assert.equal(cols.length, vals.length);
  assert.equal(vals[cols.indexOf('capture_flags')], '$23::jsonb');
  assert.ok(/ADD COLUMN IF NOT EXISTS capture_flags JSONB/.test(read('server/migrations/209_order_capture_flags.sql')));
  assert.ok(/\['order_submissions', 'capture_flags'\]/.test(read('server/index.js')), '필수 스키마');
  const tb = read('server/src/services/trackB.service.js');
  assert.ok(/NULL::jsonb AS "captureFlags"/.test(tb) && /purpose_order\.capture_flags AS "captureFlags"/.test(tb), '두 명단 쿼리');
  assert.ok(/if \(showEdits\) \{\s*const cf = _captureCheckLabels\(r\.captureFlags\);/.test(tb), '내부만');
  const wd = read('frontend/workdesk.html');
  assert.ok(/🚩 캡처 확인 필요/.test(wd) && /\$\{capMark\}/.test(wd) && /r\.captureCheck\)\?r\.captureCheck:\[\]\)\.map/.test(wd), '작업보드 3곳');
  const sa = read('frontend/js/search-app.js');
  assert.ok(/res\.code === "CAPTURE_PRICE_DIFF" \|\| res\.code === "CAPTURE_PRICE_OVER"/.test(sa));
  assert.ok(/payload\.capturePriceAck = "true"/.test(sa) && /payload\.capturePriceStaffReview = "true"/.test(sa));
  assert.ok(/cpoN >= 2/.test(sa), '쿠팡 직원 확인 요청은 두 번째부터');
  // 라벨
  const lab = require('../src/services/trackB.service')._captureCheckLabels;
  if (lab) {
    assert.deepEqual(lab(null), []); assert.deepEqual(lab({ flags: [{ code: 'zzz' }] }), []);
    assert.ok(/43,000원/.test(lab({ flags: [{ code: 'price_diff', expected: 25000, paid: 43000 }] })[0]));
  }
}

async function pg() {
  process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const tb = require('../src/services/trackB.service');
  const stamp = Date.now();
  const srv = app.listen(0);
  const cids = [];
  try {
    const port = srv.address().port;
    const post = async (body) => (await fetch(`http://127.0.0.1:${port}/api/submit/order`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    let n = 0;
    const mk = async (channel) => {
      const cid = `camp_cpc_${channel === '쿠팡' ? 'c' : 'n'}_${stamp}`;
      cids.push(cid);
      await pool.query(`INSERT INTO recruit_campaigns (id, title, channel, work_detail, participation_mode) VALUES ($1, '가짜 앰플', $2, $3::jsonb, TRUE)`,
        [cid, channel, JSON.stringify({ productLines: '가짜 앰플 50ml - 결제금액 25,000원' })]);
      return cid;
    };
    const hold = async (cid) => {
      n += 1;
      const p8 = String(90000000 + n);
      const tok = `tok_${stamp}_${n}`;
      const { rows } = await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, hold_token, expires_at)
        VALUES ($1, '가짜', $2, 'applied', $3, NOW() + INTERVAL '1 hour') RETURNING id`, [cid, p8, tok]);
      return { campaignId: cid, campaignApplicationId: String(rows[0].id), holdToken: tok, holdPhone8: p8 };
    };
    const base = { orderer: '가짜', recipient: '가짜', phone: '010-0000-0000', address: '가짜주소' };
    const count = async (cid) => (await pool.query(`SELECT COUNT(*)::int n FROM order_submissions WHERE tab_name=$1`, ['campaign:' + cid])).rows[0].n;

    // 네이버 — 43,000원: 알림(쓰기 0) → 「그대로 제출」 → 접수 + 🚩 price_diff
    const N = await mk('네이버');
    const hN = await hold(N);
    const r1 = await post({ ...base, ...hN, sheetId: 'campaign:' + N, tabName: 'campaign:' + N, orderNum: 'N1', productCapturePrice: '43,000', price: '43000' });
    assert.equal(r1.code, 'CAPTURE_PRICE_DIFF', JSON.stringify(r1)); assert.equal(r1.expected, 25000); assert.equal(r1.paid, 43000);
    assert.equal(await count(N), 0, '알림 = 쓰기 0');
    const r2 = await post({ ...base, ...hN, sheetId: 'campaign:' + N, tabName: 'campaign:' + N, orderNum: 'N1', productCapturePrice: '43,000', price: '43000', capturePriceAck: 'true' });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    // 네이버 — 25,500원(차이 500원) = 그냥 접수 · 🚩 없음
    const hN2 = await hold(N);
    const r3 = await post({ ...base, ...hN2, sheetId: 'campaign:' + N, tabName: 'campaign:' + N, orderNum: 'N2', productCapturePrice: '25,500', price: '25500' });
    assert.equal(r3.ok, true, JSON.stringify(r3));
    // ★ 결정 319 개정 — 배송비 잘린 캡처(22,500원)라도 양식 금액이 공고 금액(25,000원)이면 알림 없이 접수 · 🚩·가격 신고 없음
    const hN3 = await hold(N);
    const r4 = await post({ ...base, ...hN3, sheetId: 'campaign:' + N, tabName: 'campaign:' + N, orderNum: 'N3', productCapturePrice: '22,500', price: '25000' });
    assert.equal(r4.ok, true, JSON.stringify(r4));
    const rowsN = (await pool.query(`SELECT id, order_num, capture_flags FROM order_submissions WHERE tab_name=$1 ORDER BY order_num`, ['campaign:' + N])).rows;
    assert.deepEqual(rowsN.map(r => [r.order_num, r.capture_flags && r.capture_flags.flags[0].code]), [['N1', 'price_diff'], ['N2', null], ['N3', null]]);
    assert.deepEqual(rowsN[0].capture_flags.flags[0], { code: 'price_diff', expected: 25000, paid: 43000 });

    // 쿠팡 — 45,000원: 막힘(쓰기 0) · 「그대로 제출」로 못 넘음 · 직원 확인 요청 → 접수 + 🚩 price_over · 30,000원(+20%) = 그냥 접수
    const C = await mk('쿠팡');
    const hC = await hold(C);
    const c1 = await post({ ...base, ...hC, sheetId: 'campaign:' + C, tabName: 'campaign:' + C, orderNum: 'C1', productCapturePrice: '45000', price: '45000' });
    assert.equal(c1.code, 'CAPTURE_PRICE_OVER', JSON.stringify(c1));
    const c2 = await post({ ...base, ...hC, sheetId: 'campaign:' + C, tabName: 'campaign:' + C, orderNum: 'C1', productCapturePrice: '45000', price: '45000', capturePriceAck: 'true' });
    assert.equal(c2.code, 'CAPTURE_PRICE_OVER', 'ack 로는 못 넘는다');
    assert.equal(await count(C), 0, '막힘 = 쓰기 0');
    const c3 = await post({ ...base, ...hC, sheetId: 'campaign:' + C, tabName: 'campaign:' + C, orderNum: 'C1', productCapturePrice: '45000', price: '45000', capturePriceStaffReview: 'true' });
    assert.equal(c3.ok, true, JSON.stringify(c3));
    const hC2 = await hold(C);
    const c4 = await post({ ...base, ...hC2, sheetId: 'campaign:' + C, tabName: 'campaign:' + C, orderNum: 'C2', productCapturePrice: '30000', price: '30000' });
    assert.equal(c4.ok, true);
    const rowsC = (await pool.query(`SELECT id, order_num, capture_flags FROM order_submissions WHERE tab_name=$1 ORDER BY order_num`, ['campaign:' + C])).rows;
    assert.deepEqual(rowsC.map(r => [r.order_num, r.capture_flags && r.capture_flags.flags[0].code]), [['C1', 'price_over'], ['C2', null]]);

    // 가격 신고(결정 266)에 센다 — 응답 뒤라 잠깐 기다린다
    await new Promise(r => setTimeout(r, 400));
    const rep = (await pool.query(`SELECT order_submission_id FROM campaign_price_reports WHERE campaign_id = ANY($1)`, [cids])).rows.map(r => r.order_submission_id).sort();
    assert.deepEqual(rep, [rowsN[0].id, rowsC[0].id].map(String).sort(), '🚩 금액 주문만 가격 신고');

    // 작업보드 — 내부만 🚩
    const sid = 'cpc-wd-' + stamp, tab = '캡처확인탭';
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name) VALUES ($1,$2,'1','가짜')`, [sid, tab]);
    await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, reviewer_name, order_submission_id, active) VALUES ($1,$2,1,'가짜',$3,TRUE),($1,$2,2,'가짜',$4,TRUE)`,
      [sid, tab, rowsN[0].id, rowsN[1].id]);
    const cc = (res) => Object.fromEntries((res.roster || []).map(r => [r.seq, r.captureCheck ? r.captureCheck.length : 0]));
    assert.deepEqual(cc(await tb.workdeskTab({ sheetId: sid, tabName: tab, role: 'master' })), { 1: 1, 2: 0 }, '내부 = 🚩 한 줄');
    assert.deepEqual(cc(await tb.workdeskTab({ sheetId: sid, tabName: tab, role: 'advertiser', advertiserId: 'cpc-adv', allowAllWorkdesk: true })), { 1: 0, 2: 0 }, '업체 = 안 보임');
    await pool.query(`DELETE FROM campaign_participants WHERE sheet_id=$1`, [sid]);
    await pool.query(`DELETE FROM tab_configs WHERE sheet_id=$1`, [sid]);
    console.log('capturePriceCheck: PG passed');
  } finally {
    srv.close();
    for (const cid of cids) {
      await pool.query(`DELETE FROM campaign_price_reports WHERE campaign_id=$1`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM campaign_price_alerts WHERE campaign_id=$1`, [cid]).catch(() => {});
      await pool.query(`UPDATE campaign_applications SET order_submission_id=NULL, late_order_id=NULL WHERE campaign_id=$1`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM order_submissions WHERE tab_name=$1`, ['campaign:' + cid]).catch(() => {});
      await pool.query(`DELETE FROM campaign_applications WHERE campaign_id=$1`, [cid]).catch(() => {});
      await pool.query(`DELETE FROM recruit_campaigns WHERE id=$1`, [cid]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
}

(async () => {
  pure();
  await stubs();
  wiring();
  if (process.env.PGTEST_URL) await pg();
  console.log('capturePriceCheck: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
