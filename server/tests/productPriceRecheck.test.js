/**
 * productPriceRecheck.test.js — 결정 236 회귀가드 (사용자 확정 2026-10-13 · 위드프렌즈 재현 뒤 남은 틈 두 개)
 *   ④ 리뷰어가 "고른 상품이 맞다"고 했는데 결제금액이 다른 상품 하나의 가격 → 한 번 더 묻는다(PRODUCT_PRICE_RECHECK · 쓰기 0)
 *      다시 확인하고도 맞다(priceRecheckAck) → (가) 접수 + 이상로그 capture_price_mismatch_confirmed
 *   ⑤ 담당자 수동 입력도 상품 확인(결제금액·붙인 캡처·그 연락처의 최근 참여 신청) → 쓰기 0으로 확인 → (가) 확인하면 접수 + 이상로그
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const _queue = [];
function t(name, fn) { _queue.push([name, fn]); }
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const readFront = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', rel), 'utf8');

const pv = require('../src/services/productMismatchVerify.service');
// 위드프렌즈 실제 공고의 상품·가격(개인정보 없음)
const MAT = ['1. 미니싱글/배송메세지00<<넣어서구매', '2. 슈퍼싱글배송메세지00<<넣어서구매', '3. 퀸더블배송메세지00<<넣어서구매', '4. 킹(분리난방)배송메세지00<<넣어서구매']
  .map((k, i) => ({ opt_key: k, product_name: k, status: 'active', pay_amount: [49800, 59800, 69800, 94800][i] }));
const FR = ['HIA-1450HM / 옵션 : 누쓰쓰 응원특가', 'HA-HD2390L / 옵션 : 누쓰쓰 응원특가', 'HA-8000FS / 옵션 : 누쓰쓰 응원특가', 'HA-HD1590']
  .map((k, i) => ({ opt_key: k, product_name: k, status: 'active', pay_amount: [31900, 23900, 21900, 99900][i] }));
const SUPER = MAT[1].opt_key, QUEEN = MAT[2].opt_key, KING = MAT[3].opt_key;

/** 질의 모양 → 돌려줄 줄. 함수면 (sql, params) 로 부른다. */
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
const optsDb = (rows) => stubDb([[/FROM campaign_options/, rows]]);
const HOLD = (key) => ({ verified: true, optionKey: key, campaignId: 'camp_mat', phone8: '12345678', holdToken: 'tok', applicationId: 7 });

// ── 1. 결제금액 근거 — 단일 출처 ──
t('1a priceOtherOption: 고른 상품 가격과 다르고 다른 상품 하나의 가격과 정확히 같을 때만', () => {
  assert.deepStrictEqual(pv.priceOtherOption(MAT, SUPER, '69,800'), { key: QUEEN, paid: 69800, heldPay: 59800 });
  assert.strictEqual(pv.priceOtherOption(MAT, SUPER, '59,800원'), null, '고른 상품 가격이면 근거 없음');
  assert.strictEqual(pv.priceOtherOption(MAT, SUPER, '57,800'), null, '어느 가격과도 안 맞음(쿠폰 등)');
  const twin = MAT.map((o, i) => ({ ...o, pay_amount: i === 0 ? 59800 : o.pay_amount }));
  assert.strictEqual(pv.priceOtherOption(twin, SUPER, '59,800'), null, '고른 상품 가격과 같으면 다른 상품도 그 가격이어도 근거 없음');
  assert.strictEqual(pv.priceOtherOption(MAT, SUPER, ''), null);
  const same = MAT.map((o, i) => ({ ...o, pay_amount: i === 3 ? 69800 : o.pay_amount }));
  assert.strictEqual(pv.priceOtherOption(same, SUPER, '69800'), null, '같은 가격 상품이 둘이면 어느 것인지 모른다');
  assert.strictEqual(pv.priceOtherOption(MAT.map(o => ({ ...o, pay_amount: 50000 })), SUPER, '50000'), null, '가격이 다 같으면 막을 방법이 없다');
  assert.strictEqual(pv.priceOtherOption(MAT.map((o, i) => ({ ...o, pay_amount: i === 1 ? 0 : o.pay_amount })), SUPER, '69800'), null, '고른 상품 가격 모름');
});

// ── 2. 리뷰어 제출 ④ ──
t('2a ★ "고른 상품이 맞다" + 결제금액이 다른 상품 가격 → recheck(문구: ○○를 주문했다고 하셨지만 결제금액 N원은 △△ 결제금액)', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: HOLD(SUPER), captureText: '곰표한일 탄소매트', capturePrice: '69,800', confirmedKey: SUPER, db: optsDb(MAT) });
  assert.strictEqual(d.action, 'recheck');
  assert.strictEqual(d.chosen.key, SUPER); assert.strictEqual(d.captured.key, QUEEN); assert.strictEqual(d.paid, 69800);
  assert.ok(/주문했다고 하셨지만/.test(d.error) && /결제금액 69,800원은 「3\. 퀸더블/.test(d.error) && /잘못 구매한 것으로 보여요/.test(d.error), d.error);
});
t('2b ★ 다시 확인하고도 맞다(priceAck) → keep(접수) + priceOther 로 담당자 확인 기록', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: HOLD(SUPER), capturePrice: '69800', confirmedKey: SUPER, priceAck: true, db: optsDb(MAT) });
  assert.strictEqual(d.action, 'keep'); assert.strictEqual(d.priceOther, QUEEN); assert.strictEqual(d.paid, 69800);
});
t('2c 결제금액이 고른 상품 가격·어느 가격과도 안 맞음·금액 없음 → 다시 묻지 않고 keep(종전)', async () => {
  for (const price of ['59,800', '56,800', '']) {
    const d = await pv.decideAtSubmit({ holdCtx: HOLD(SUPER), captureText: '킹(분리난방)', captureOption: '킹(분리난방)', capturePrice: price, confirmedKey: SUPER, db: optsDb(MAT) });
    assert.strictEqual(d.action, 'keep', price); assert.strictEqual(d.priceOther, '', price);
  }
});
t('2d 위드프렌즈 10/1 — 1450HM 이 맞다고 했는데 21,900원(8000FS 가격) → recheck · 다른 상품을 샀다고 하면 여전히 wrong(제출 불가)', async () => {
  const H = { ...HOLD(FR[0].opt_key), campaignId: 'camp_fr' };
  const r = await pv.decideAtSubmit({ holdCtx: H, captureText: '보풀제거기', capturePrice: '21900', confirmedKey: FR[0].opt_key, db: optsDb(FR) });
  assert.strictEqual(r.action, 'recheck'); assert.strictEqual(r.captured.key, FR[2].opt_key);
  const w = await pv.decideAtSubmit({ holdCtx: H, capturePrice: '21900', confirmedKey: FR[2].opt_key, db: optsDb(FR) });
  assert.strictEqual(w.action, 'wrong');
});
t('2e ① 결제금액 근거 prompt 는 종전 그대로(글자로 못 정했을 때만)', async () => {
  const p = await pv.decideAtSubmit({ holdCtx: HOLD(QUEEN), captureText: '탄소매트 그레이', captureOption: '그레이', capturePrice: '94,800', db: optsDb(MAT) });
  assert.strictEqual(p.action, 'prompt'); assert.strictEqual(p.basis, 'price'); assert.strictEqual(p.captured.key, KING);
  const n = await pv.decideAtSubmit({ holdCtx: HOLD(QUEEN), captureText: '탄소매트 퀸더블', captureOption: '퀸더블', capturePrice: '94,800', db: optsDb(MAT) });
  assert.strictEqual(n.action, 'none', '글자가 고른 상품을 말하면 금액은 보지 않는다');
});
t('2f 스위치 꺼짐·조회 실패 → none(종전)', async () => {
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD(SUPER), capturePrice: '69800', confirmedKey: SUPER, db: stubDb([], { throws: true }) })).action, 'none');
  process.env.CAMPAIGN_PRODUCT_VERIFY = '0';
  try { assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD(SUPER), capturePrice: '69800', confirmedKey: SUPER, db: optsDb(MAT) })).action, 'none'); }
  finally { delete process.env.CAMPAIGN_PRODUCT_VERIFY; }
});
t('2g 제출 라우트: recheck 는 아무것도 쓰기 전에 PRODUCT_PRICE_RECHECK · priceRecheckAck 는 "true"만 · 다시 확인 뒤 접수는 따로 기록(신청 번호 포함)', () => {
  const s = read('src/routes/submit.routes.js');
  const i = s.indexOf('pv.decideAtSubmit(');
  const blk = s.slice(i, i + 3200);
  assert.ok(/priceAck: b\.priceRecheckAck === true \|\| b\.priceRecheckAck === 'true'/.test(blk));
  assert.ok(/decision\.action === 'recheck'\) \{\s*\/\/[^\n]*\n\s*return res\.json\(\{\s*ok: false, code: 'PRODUCT_PRICE_RECHECK'/.test(blk));
  assert.ok(blk.indexOf("'PRODUCT_PRICE_RECHECK'") < blk.indexOf('logAbnormal('), '다시 묻기는 기록·접수보다 먼저 돌려준다');
  assert.ok(/'capture_price_mismatch_confirmed'/.test(blk) && /신청 #\$\{holdCtx\.applicationId\}/.test(blk));
  assert.ok(i < s.indexOf('const _newIdentityGate'), '신원 게이트 앞(쓰기 전)');
});
t('2h 리뷰어 화면: PRODUCT_PRICE_RECHECK → 같은 창(recheck) · 맞다 = priceRecheckAck · 다른 상품 = 그 키(서버가 막음) · 닫기 = 제출 안 함 · 잘못 구매 처리보다 앞', () => {
  const f = readFront('js/search-app.js');
  const i = f.indexOf('res.code === "PRODUCT_PRICE_RECHECK"');
  assert.ok(i > f.indexOf('res.code === "PRODUCT_MISMATCH"') && i < f.indexOf('res.code === "PRODUCT_WRONG_PURCHASE"'));
  const blk = f.slice(i, i + 1400);
  assert.ok(/await _pmvAsk\(res, [^\n]*, "recheck"\)/.test(blk));
  assert.ok(/if \(!again\) \{[\s\S]{0,400}continue;/.test(blk), '닫으면 이 주문은 제출하지 않는다');
  assert.ok(/again === res\.chosen\.key\) payload\.priceRecheckAck = "true"/.test(blk) && /else payload\.confirmedProductKey = again/.test(blk));
  assert.ok(/function _pmvAsk\(res, orderNo, mode\)/.test(f) && /결제금액을 다시 확인해 주세요/.test(f) && /주문했다고 하셨지만/.test(f) && /다시 확인할게요/.test(f));
});

t('2i ★ 공고에 없는 "확인한 상품" 값은 답이 아닌 것으로 본다 — 경고·다시 묻기를 기록 없이 건너뛰지 못한다(코드리뷰)', async () => {
  const p1 = await pv.decideAtSubmit({ holdCtx: HOLD(QUEEN), captureText: '탄소매트', captureOption: '그레이', capturePrice: '94800', confirmedKey: '지어낸 값', db: optsDb(MAT) });
  assert.strictEqual(p1.action, 'prompt'); assert.strictEqual(p1.captured.key, KING);
  const p2 = await pv.decideAtSubmit({ holdCtx: HOLD(QUEEN), captureText: '탄소매트 킹(분리난방)', captureOption: '킹(분리난방)', confirmedKey: '지어낸 값', db: optsDb(MAT) });
  assert.strictEqual(p2.action, 'prompt');
});

// ── 3. 담당자 수동 입력 ⑤ ──
const manualDb = (apps = [], target = null) => stubDb([
  [/FROM campaign_options/, MAT],
  [/FROM campaign_applications WHERE id = \$1/, target ? [target] : []],
  [/FROM campaign_applications a JOIN recruit_campaigns/, apps],
]);
const base = { index: 0, name: '가짜', chosenKey: KING, price: '94800', phone8: '12345678' };
t('3a ★ 결제금액: 킹을 골랐는데 69,800원(퀸더블 가격) → 걸림 · 이유 문구 · 바꿀 상품 제안 (10/8 탄소매트 수동 입력 사례)', async () => {
  const r = await pv.checkManualEntries({ campaignId: 'camp_mat', items: [{ ...base, price: '69,800' }], db: manualDb() });
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].suggestKey, QUEEN); assert.strictEqual(r[0].chosen, KING); assert.deepStrictEqual(r[0].kinds, ['price']);
  assert.ok(/결제금액 69,800원은 「3\. 퀸더블/.test(r[0].notes[0]) && /94,800원/.test(r[0].notes[0]), r[0].notes[0]);
});
t('3b 붙인 캡처 글자가 다른 상품 → 걸림', async () => {
  const r = await pv.checkManualEntries({ campaignId: 'camp_mat', items: [{ ...base, captureName: '곰표한일 탄소매트', captureOption: '육각 그레이 퀸더블' }], db: manualDb() });
  assert.strictEqual(r.length, 1); assert.ok(/구매 캡처에는 「3\. 퀸더블/.test(r[0].notes[0]));
});
t('3c ★ 참여 신청 기록: 최근 다른 공고(탄소매트 미니싱글)에 신청한 연락처를 가습기로 넣으면 걸림 (조○○ 사례)', async () => {
  const apps = [{ campaign_id: 'camp_other', option_key: '1. 미니싱글/배송메세지00<<넣어서구매', applied_at: new Date('2026-10-12T05:04:00Z'), title: '곰표 탄소매트 26건' }];
  const r = await pv.checkManualEntries({ campaignId: 'camp_mat', items: [base], db: manualDb(apps) });
  assert.strictEqual(r.length, 1); assert.ok(/10\/12 14:04 다른 공고 「곰표 탄소매트 26건」에 「1\. 미니싱글/.test(r[0].notes[0]), r[0].notes[0]);
  assert.deepStrictEqual(r[0].kinds, ['application']);
  const same = [{ campaign_id: 'camp_mat', option_key: QUEEN, applied_at: new Date(), title: 'x' }];
  const r2 = await pv.checkManualEntries({ campaignId: 'camp_mat', items: [base], db: manualDb(same) });
  assert.ok(/참여 신청 때 「3\. 퀸더블/.test(r2[0].notes[0]));
});
t('3c2 ★ 신청 기록은 최근 12시간만 본다(운영 실측: 3일이면 수동 입력 10%가 무관한 만료 신청으로 걸림)', async () => {
  const db = manualDb([]);
  await pv.checkManualEntries({ campaignId: 'camp_mat', items: [base], db });
  const q = db.seen.find(x => /FROM campaign_applications a JOIN recruit_campaigns/.test(x));
  assert.ok(/interval '12 hours'/.test(q) && /status IN \('applied','expired'\)/.test(q), q);
});
t('3c3 고른 상품이 공고 목록에 없으면 금액·캡처 근거는 보지 않는다(접수 단계가 거른다)', async () => {
  const r = await pv.checkManualEntries({ campaignId: 'camp_mat', items: [{ ...base, chosenKey: '삭제된 상품', price: '69800', captureOption: '퀸더블' }], db: manualDb() });
  assert.deepStrictEqual(r, []);
});
t('3d 맞는 경우는 걸지 않는다 — 금액이 고른 상품 가격 · 신청이 이 공고·이 상품 · 신청 기록 없음', async () => {
  const fit = [{ campaign_id: 'camp_mat', option_key: KING, applied_at: new Date(), title: 'x' }, { campaign_id: 'camp_other', option_key: 'z', applied_at: new Date(), title: 'y' }];
  assert.deepStrictEqual(await pv.checkManualEntries({ campaignId: 'camp_mat', items: [base], db: manualDb(fit) }), []);
  assert.deepStrictEqual(await pv.checkManualEntries({ campaignId: 'camp_mat', items: [base], db: manualDb([]) }), []);
});
t('3e 공고 화면에서 신청을 골라 확정(targetApplicationId)하면 그 신청의 상품이 고른 상품 · 신청 기록 대조는 하지 않는다', async () => {
  const apps = [{ campaign_id: 'camp_other', option_key: 'z', applied_at: new Date(), title: 'y' }];
  const r = await pv.checkManualEntries({ campaignId: 'camp_mat', items: [{ ...base, chosenKey: '', targetApplicationId: 9, price: '94,800' }], db: manualDb(apps, { option_key: QUEEN }) });
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].chosen, QUEEN); assert.strictEqual(r[0].notes.length, 1, '금액 근거만');
  assert.ok(/「4\. 킹/.test(r[0].notes[0]));
});
t('3f ★ fail-open — 조회 실패·스위치 꺼짐·공고 모름 → [] · 판정은 쓰기 0', async () => {
  assert.deepStrictEqual(await pv.checkManualEntries({ campaignId: 'camp_mat', items: [{ ...base, price: '69800' }], db: stubDb([], { throws: true }) }), []);
  assert.deepStrictEqual(await pv.checkManualEntries({ campaignId: '', items: [{ ...base, price: '69800' }], db: manualDb() }), []);
  process.env.CAMPAIGN_PRODUCT_VERIFY = '0';
  try { assert.deepStrictEqual(await pv.checkManualEntries({ campaignId: 'camp_mat', items: [{ ...base, price: '69800' }], db: manualDb() }), []); }
  finally { delete process.env.CAMPAIGN_PRODUCT_VERIFY; }
});

// ── 4. 수동 입력 라우트(서비스를 바꿔 끼워 실제 핸들러를 돌린다) ──
t('4a ★ 새 화면: 걸린 줄이 있으면 쓰기 0으로 needConfirm:product_check · 확인(allowProductMismatch)하면 접수 + 결과 경고 + 이상로그 · 옛 화면은 종전', async () => {
  const svc = require('../src/services/manualOrder.service');
  const elog = require('../src/services/errorLog.service');
  const poolMod = require('../src/db/pool');
  const real = { sub: svc.submitExternalOrder, tab: svc.tabOptionChoices, chk: pv.checkManualEntries, q: poolMod.query, log: elog.logAbnormal };
  const calls = [], logs = [], checks = [];
  svc.submitExternalOrder = async (a) => { calls.push(a); return { ok: true, warnings: [], orderSubmissionId: 'os1' }; };
  svc.tabOptionChoices = async () => ({ campaignId: 'camp_mat', choices: MAT.map(o => ({ optKey: o.opt_key, productName: o.opt_key, status: 'open', remaining: 10 })) });
  pv.checkManualEntries = async (a) => { checks.push(a); return a.items.filter(x => x.price === '69800').map(x => ({ index: x.index, name: x.name, chosen: x.chosenKey, notes: ['결제금액 69,800원은 「퀸더블」 가격입니다'], suggestKey: QUEEN })); };
  poolMod.query = async () => ({ rows: [] });
  elog.logAbnormal = (p) => { logs.push(p); };
  try {
    delete require.cache[require.resolve('../src/routes/manualOrder.routes')];
    const router = require('../src/routes/manualOrder.routes');
    const layer = router.stack.find(l => l.route && l.route.path === '/submit');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const F = (price) => ({ recipient: '가짜', phone: '010-1234-0001', address: '서울', bank: '신한', account: '1', depositor: '가짜', price });
    const post = async (body) => { let out; await handler({ body: { sheetId: 'S', tabName: 'T', allowRepurchase: true, optionAware: true, ...body }, admin: { name: 'A' } },
      { json: v => { out = v; }, status() { return this; } }, e => { throw e; }); return out; };
    const items = [{ fields: F('94800'), optionKey: KING }, { fields: F('69800'), optionKey: KING, captureName: '탄소매트', captureOption: '퀸더블' }];
    await post({ productCheck: true, items: [{ fields: { ...F('69800'), address: '' }, optionKey: KING }, { fields: { ...F('69800'), phone: '010-12' }, optionKey: KING }] });
    assert.strictEqual(checks[0].items.length, 0, '어차피 거절될 줄(필수 칸 빔·전화 자릿수)은 확인창에 올리지 않는다');
    checks.length = 0; calls.length = 0;
    const r1 = await post({ productCheck: true, items });
    assert.strictEqual(r1.needConfirm, 'product_check'); assert.strictEqual(r1.flagged.length, 1); assert.strictEqual(r1.flagged[0].index, 1);
    assert.strictEqual(calls.length, 0, '확인 전에는 한 줄도 쓰지 않는다(부분 처리 없음)');
    assert.strictEqual(checks[0].campaignId, 'camp_mat', '작업보드 경로 = 연결 공고로 판정');
    assert.strictEqual(checks[0].items[1].captureOption, '퀸더블'); assert.strictEqual(checks[0].items[1].phone8, '12340001');
    const r2 = await post({ productCheck: true, allowProductMismatch: true, items });
    assert.strictEqual(r2.okCount, 2); assert.strictEqual(calls.length, 2);
    assert.ok(r2.results[1].warnings.some(w => /상품 확인 경고를 확인하고 접수/.test(w)));
    assert.ok(!r2.results[0].warnings.some(w => /상품 확인/.test(w)));
    assert.strictEqual(logs.length, 1); assert.strictEqual(logs[0].step, 'manual_product_mismatch_confirmed');
    calls.length = 0; checks.length = 0;
    const r3 = await post({ items });
    assert.strictEqual(r3.okCount, 2); assert.strictEqual(checks.length, 0, '옛 화면(productCheck 없음)은 판정하지 않는다 — 결정 211 규율');
  } finally {
    svc.submitExternalOrder = real.sub; svc.tabOptionChoices = real.tab; pv.checkManualEntries = real.chk; poolMod.query = real.q; elog.logAbnormal = real.log;
    delete require.cache[require.resolve('../src/routes/manualOrder.routes')];
  }
});
t('4b 수동 입력 화면: productCheck·allowProductMismatch·캡처 글자를 보내고, product_check 면 확인창 · 취소하면 그 줄에 이유를 붙여 표로 돌아간다', () => {
  const f = readFront('js/manual-order.js');
  assert.ok(/productCheck: true/.test(f) && /allowProductMismatch: _productOk/.test(f));
  assert.ok(/captureName: \(x\.r\.extract && x\.r\.extract\.productName\)/.test(f));
  const i = f.indexOf("out.needConfirm === 'product_check'");
  assert.ok(i > f.indexOf("out.needConfirm === 'over_daily'"));
  const blk = f.slice(i, i + 1500);
  assert.ok(/confirm\(/.test(blk) && /productWarn = /.test(blk) && /renderPreview\(\);\s*return;/.test(blk) && /_productOk = true;/.test(blk));
  assert.ok(/it\.productWarn \|\| \[\]/.test(f), '취소한 줄은 표에 이유가 보인다');
  assert.ok(/onlyApp/.test(blk) && /방금 다른 상품·공고로 참여 신청한 연락처예요/.test(blk), '신청 기록만 걸리면 "다른 상품을 샀다"고 단정하지 않는다');
  assert.ok(/row\.targetApplicationId = id \|\| ''; row\.productWarn = null;/.test(f) && /row\.productWarn = null;   \/\/ 캡처가 바뀌면/.test(f));
  assert.ok(/manual-order\.js\?v=20261013-prodcheck/.test(readFront('workdesk.html')), '옛 파일을 재사용하지 않게 판 올림');
});
t('4d ★ 확인 기록 지문: key 가 있으면 숫자가 달라도 따로(신청·주문마다) · key 가 없으면 종전과 같은 지문(기존 활성 기록 불변)', () => {
  const { fingerprint } = require('../src/services/errorLog.service');
  const base = { flow: 'order_submit', step: 'capture_price_mismatch_confirmed', category: 'validation', source: 'server', message_raw: '고른 「퀸」 · 신청 #7' };
  assert.notStrictEqual(fingerprint({ ...base, key: 'app-7' }), fingerprint({ ...base, message_raw: '고른 「퀸」 · 신청 #99', key: 'app-99' }));
  const crypto = require('crypto');
  const old = crypto.createHash('sha1').update(['order_submit', 'capture_price_mismatch_confirmed', 'validation', 'server', '고른 「퀸」 · 신청 ##'].join('|')).digest('hex').slice(0, 16);
  assert.strictEqual(fingerprint(base), old, 'key 없으면 종전 지문');
  assert.strictEqual(fingerprint({ ...base, key: '' }), old);
  const s = read('src/routes/submit.routes.js');
  assert.ok(/fingerprintKey: decision\.action === 'wrong' \? '' : 'app-' \+ holdCtx\.applicationId/.test(s));
  assert.ok(/fingerprintKey: 'os-' \+ \(r\.orderSubmissionId/.test(read('src/routes/manualOrder.routes.js')));
  assert.ok(/key: p\.fingerprintKey/.test(read('src/services/errorLog.service.js')));
});
t('4e 신청 기록 대조: 주문이 붙은 신청(order_submission_id·late_order_id)은 빼고 · 12시간 창 전체(LIMIT 없음)', async () => {
  const db = manualDb([]);
  await pv.checkManualEntries({ campaignId: 'camp_mat', items: [base], db });
  const q = db.seen.find(x => /FROM campaign_applications a JOIN recruit_campaigns/.test(x));
  assert.ok(/a\.order_submission_id IS NULL AND a\.late_order_id IS NULL/.test(q) && !/LIMIT/.test(q), q);
});
t('4f 수동 입력 화면: 확인 단계를 순서와 무관하게 반복 처리 · 제출 전 캡처 판독을 기다린다(Codex 리뷰)', () => {
  const f = readFront('js/manual-order.js');
  assert.ok(/for \(let _gate = 0; out && out\.needConfirm && _gate < 6; _gate\+\+\)/.test(f));
  assert.ok(/needConfirm === 'repurchase_window' && !_repurchaseOk/.test(f) && /needConfirm === 'over_daily' && !_overDailyOk/.test(f) && /needConfirm === 'product_check' && !_productOk/.test(f));
  assert.ok(/await awaitCaptureReads\(targets\.map\(x => x\.r\)\);/.test(f) && /function readCapture\(row\)/.test(f));
  assert.ok(f.indexOf('await awaitCaptureReads(') < f.indexOf('out = await post(false, false);'), '판독을 기다린 뒤 보낸다');
  assert.ok(/\/\^⚠ 상품 확인:\/\.test\(el\.textContent\)/.test(f), '금액·연락처를 고치면 상품 칸 문구도 지운다');
});
t('4c 이상로그 단계 이름표', () => {
  const { STEP_LABELS } = require('../src/services/errorLog.service');
  for (const k of ['wrong_product_purchase', 'capture_product_differs_confirmed', 'capture_price_mismatch_confirmed', 'manual_product_mismatch_confirmed']) assert.ok(STEP_LABELS[k], k);
});

(async () => {
  for (const [name, fn] of _queue) {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${fail ? '❌' : '✅'} productPriceRecheck: ${pass}개 통과 / ${fail}개 실패`);
  if (fail) process.exit(1);
})();
