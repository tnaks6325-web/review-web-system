/**
 * productMismatchVerify.test.js — 결정 230 회귀가드: 고른 상품 ≠ 실제 산 상품
 *   ① 캡처가 다른 상품 하나를 가리키면 제출 전에 "잘못 구매한 것 같아요"로 묻는다
 *   ② 리뷰어가 고른 상품과 다른 상품을 샀다고 답하면 = 잘못 구매 → 제출 불가 / 고른 상품이면 접수
 *   ③ 작업표 상품 칸을 고치면 참여 기록도 따라간다(원장은 무접촉 — 결정 018)
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

const m = require('../src/utils/productCaptureMatch');
const mk = (a) => a.map(k => ({ optKey: k, productName: k }));
const MAT = mk(['1. 미니싱글/배송메세지00<<넣어서구매', '2. 슈퍼싱글배송메세지00<<넣어서구매', '3. 퀸더블배송메세지00<<넣어서구매', '4. 킹(분리난방)배송메세지00<<넣어서구매']);
const HUM = mk(['1. HA-600FHC (누쓰쓰)(배송메세지00<넣어서구매)', '2. HA-MP600R (누쓰쓰)(배송메세지00<넣어서구매)', '3. HA-200FH (누쓰쓰)(배송메세지00<넣어서구매)', '4. HA-700FH (누쓰쓰)(배송메세지00<넣어서구매)', '5. HA-HD2200(배송메세지00<넣어서구매)']);
const FR = mk(['HIA-1450HM / 옵션 : 누쓰쓰 응원특가', 'HA-HD2390L / 옵션 : 누쓰쓰 응원특가', 'HA-8000FS / 옵션 : 누쓰쓰 응원특가', 'HA-HD1590']);

// ── 1. 글자 → 상품(확신할 때만 하나) ──
t('1a 사이즈 알맹이(꼬리 붙은 이름)로 맞춘다 — 퀸더블·킹(분리난방)', () => {
  assert.strictEqual(m.matchOption('곰표한일 탄소매트 옵션: 퀸더블', MAT), MAT[2].optKey);
  assert.strictEqual(m.matchOption('곰표한일 탄소매트 킹(분리난방)', MAT), MAT[3].optKey);
  assert.strictEqual(m.matchOption('슈퍼싱글', MAT), MAT[1].optKey);
});
t('1b 모델 번호로 맞춘다(하이픈·대소문자 무관)', () => {
  assert.strictEqual(m.matchOption('한일 가습기 ha-hd2200', HUM), HUM[4].optKey);
  assert.strictEqual(m.matchOption('한일 HIA-1450HM 히터 / 누쓰쓰 응원특가', FR), FR[0].optKey);
  assert.strictEqual(m.matchOption('HA-8000FS', FR), FR[2].optKey);
});
t('1c ★ 못 가리면 "" — 상품명만·공통 꼬리만·옛 모델명·한 글자 다른 말 속', () => {
  assert.strictEqual(m.matchOption('곰표한일 탄소매트', MAT), '');
  assert.strictEqual(m.matchOption('누쓰쓰 응원특가', HUM), '');
  assert.strictEqual(m.matchOption('한일 HA-HD1500 가습기', FR), '');   // 이름 바꾸기 전 옛 모델 — 묻지 않는다
  assert.strictEqual(m.matchOption('탄소매트 킹사이즈', MAT), '');
  assert.strictEqual(m.matchOption('', MAT), '');
});
t('1d ★ 둘 이상 걸리면 "" (장바구니 여러 상품)', () => {
  assert.strictEqual(m.matchOption('HIA-1450HM 1개, HA-HD1590 1개', FR), '');
});
t('1e 작업표 칸의 짧은 값(번호+알맹이)도 맞춘다', () => {
  assert.strictEqual(m.matchOption('4. 킹(분리난방)', MAT), MAT[3].optKey);
  assert.strictEqual(m.matchOption('5. HA-HD2200', HUM), HUM[4].optKey);
});
t('1f capturedOtherOption — 고른 상품도 보이면 묻지 않는다 / 같은 상품이면 ""', () => {
  assert.strictEqual(m.capturedOtherOption('한일 HIA-1450HM 히터', FR, 'HA-HD1590'), FR[0].optKey);
  assert.strictEqual(m.capturedOtherOption('HIA-1450HM, HA-HD1590 2건', FR, 'HA-HD1590'), '');
  assert.strictEqual(m.capturedOtherOption('HA-HD1590', FR, 'HA-HD1590'), '');
});
t('1h ★ 약한 이름(L·100·킹)은 다른 말 속 글자로 걸리지 않는다 — 옵션 글자에서 낱말 일치만(코드리뷰 Blocker)', () => {
  const SML = ['S', 'M', 'L'].map(k => ({ optKey: k, productName: 'Polo 셔츠' }));
  const NUM = ['90', '95', '100', '105'].map(k => ({ optKey: k, productName: '슬림핏 셔츠' }));
  assert.strictEqual(m.matchOption('Polo 셔츠', SML), '');                       // polo 의 l
  assert.strictEqual(m.matchOption('Polo 셔츠 블루 / 사이즈: M', SML, { shortText: '사이즈: M' }), 'M');
  assert.strictEqual(m.matchOption('슬림핏 셔츠 KS-100', NUM, { shortText: '' }), '');   // 상품명 속 모델번호
  assert.strictEqual(m.matchOption('슬림핏 셔츠', NUM, { shortText: '100' }), '100');
  assert.strictEqual(m.capturedOtherOption('Polo 셔츠 블루', SML, 'M', { shortText: '' }), '');
  assert.strictEqual(m.matchOption('탄소매트 킹', MAT, { shortText: '킹' }), MAT[3].optKey);
  assert.strictEqual(m.matchOption('탄소매트 킹사이즈', MAT, { shortText: '킹사이즈' }), '');
});
t('1g 선택지가 1개면 아무것도 가리키지 않는다', () => {
  assert.strictEqual(m.matchOption('HA-HD1590', mk(['HA-HD1590'])), '');
});

// ── 2. 제출 판정(쓰기 0) ──
const pv = require('../src/services/productMismatchVerify.service');
const optRows = FR.map(o => ({ opt_key: o.optKey, product_name: o.productName, status: 'active' }));
function stubDb(rows, opts = {}) {
  return { query: async (sql) => { if (opts.throws) throw new Error('db down'); if (/FROM campaign_options/.test(sql)) return { rows }; return { rows: [] }; } };
}
const HOLD = { verified: true, optionKey: 'HA-HD1590', campaignId: 'camp_x', phone8: '12345678', holdToken: 'tok', applicationId: 7 };
t('2a 캡처가 다른 상품 하나 → prompt(고른·캡처 상품 키)', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: HOLD, captureText: '한일 HIA-1450HM 히터', db: stubDb(optRows) });
  assert.strictEqual(d.action, 'prompt');
  assert.strictEqual(d.chosen.key, 'HA-HD1590');
  assert.strictEqual(d.captured.key, FR[0].optKey);
});
t('2b ★ 리뷰어 답: 고른 상품 → keep(접수) / 다른 공고 상품 → wrong(잘못 구매 · 제출 불가 문구) / 지어낸 값 → none', async () => {
  const k = await pv.decideAtSubmit({ holdCtx: HOLD, captureText: 'HIA-1450HM', confirmedKey: 'HA-HD1590', db: stubDb(optRows) });
  assert.strictEqual(k.action, 'keep');
  assert.strictEqual(k.capturedKey, FR[0].optKey, '담당자 확인 기록에 캡처 상품을 남긴다');
  const w = await pv.decideAtSubmit({ holdCtx: HOLD, captureText: '', confirmedKey: FR[0].optKey, db: stubDb(optRows) });
  assert.strictEqual(w.action, 'wrong');
  assert.strictEqual(w.chosen.key, 'HA-HD1590');
  assert.strictEqual(w.bought.key, FR[0].optKey);
  assert.ok(/잘못 구매/.test(w.error) && /제출할 수 없어요/.test(w.error) && /담당자에게 문의/.test(w.error));
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD, confirmedKey: '없는 상품', db: stubDb(optRows) })).action, 'none');
});
t('2c ★ fail-open — 판독 없음·홀드 미확인·이미 접수·선택지 1개·조회 실패·스위치 꺼짐 = none', async () => {
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD, captureText: '', db: stubDb(optRows) })).action, 'none');
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: { ...HOLD, verified: false }, captureText: 'HIA-1450HM', db: stubDb(optRows) })).action, 'none');
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: { ...HOLD, doneKind: 'confirmed' }, captureText: 'HIA-1450HM', db: stubDb(optRows) })).action, 'none');
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD, captureText: 'HIA-1450HM', db: stubDb(optRows.slice(3)) })).action, 'none');
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD, captureText: 'HIA-1450HM', db: stubDb(optRows, { throws: true }) })).action, 'none');
  process.env.CAMPAIGN_PRODUCT_VERIFY = '0';
  try { assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD, captureText: 'HIA-1450HM', db: stubDb(optRows) })).action, 'none'); }
  finally { delete process.env.CAMPAIGN_PRODUCT_VERIFY; }
});

// ── 3. 운영 캡처 실측 사례(2026-10-12 · 117건 · 상품 글자만 옮김 — 개인정보 없음) ──
const MATP = MAT.map((o, i) => ({ opt_key: o.optKey, product_name: o.productName, status: 'active', pay_amount: [49800, 59800, 69800, 94800][i] }));
const FRP = FR.map((o, i) => ({ opt_key: o.optKey, product_name: o.productName, status: 'active', pay_amount: [31900, 23900, 21900, 99900][i] }));
const SOY = ['풍성한 진간장 13L x 1통', '풍성한 진간장 S 13L x 1통', '풍성한 진간장 F 13L x 1통'].map((k, i) => ({ opt_key: k, product_name: '', status: 'active', pay_amount: [17400, 14300, 18000][i] }));
const CLO = [['1.데일리 후드 점퍼 셔츠 블랙 - 결제금액 178,200원(3천원 쿠폰적용', 178200], ['11.이지 플로우 밴딩 팬츠 브라운 - 결제금액 175,200원(3천원 쿠폰적용', 175200],
             ['12.이지 플로우 밴딩 팬츠 딥네이비 - 결제금액 175,200원(3천원 쿠폰적용', 175200], ['4.드로우 스트링 티셔츠 세피아 - 결제금액 88,200원(3천원 쿠폰적용', 88200], ['5.드로우 스트링 티셔츠 차콜 - 결제금액 85,200원(3천원 쿠폰적용', 85200]]
  .map(([k, p]) => ({ opt_key: k, product_name: '', status: 'active', pay_amount: p }));
const hold = (k) => ({ ...HOLD, optionKey: k });
t('3a 모델번호 표기 차이(HAD1590 ↔ HA-HD1590) — 8000FS 골랐는데 HD1590 캡처 → 경고', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: hold(FR[2].optKey), captureText: '한경희 5초 간편세척 스텐316 초음파 가습기 모델명: 초음파 가습기 HAD1590', captureOption: '모델명: 초음파 가습기 HAD1590', capturePrice: '99,900', db: stubDb(FRP) });
  assert.strictEqual(d.action, 'prompt'); assert.strictEqual(d.basis, 'text'); assert.strictEqual(d.captured.key, 'HA-HD1590');
});
t('3b 옵션 칸이 비어도 상품명 속 "F" — 진간장 S 골랐는데 F 캡처 → 경고(담당자도 놓친 실제 사례)', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: hold(SOY[1].opt_key), captureText: '풍성한 진간장 F, 1개, 13L', captureOption: '', capturePrice: '18,000', db: stubDb(SOY) });
  assert.strictEqual(d.action, 'prompt'); assert.strictEqual(d.captured.key, SOY[2].opt_key);
});
t('3c 글자로 못 정하면 결제금액 — 퀸더블 골랐는데 94,800원(킹 가격) → 경고(basis=price)', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: hold(MAT[2].optKey), captureText: '곰표한일전자 탄소매트 그레이딩 전자파없는 E... 그레이 (블러쉬블루) : 1개 (+45,000원)', captureOption: '그레이 (블러쉬블루) : 1개 (+45,000원)', capturePrice: '94,800', db: stubDb(MATP) });
  assert.strictEqual(d.action, 'prompt'); assert.strictEqual(d.basis, 'price'); assert.strictEqual(d.paid, 94800); assert.strictEqual(d.captured.key, MAT[3].optKey);
});
t('3d ★ 글자가 고른 상품을 말하면 금액은 보지 않는다 — 쿠폰으로 다른 상품 가격과 같아진 정상 주문(실측 5건) 경고 0', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: hold(CLO[0].opt_key), captureText: '데일리 후드 점퍼 셔츠 블랙 SIZE: FREE', captureOption: 'SIZE: FREE', capturePrice: '175,200', db: stubDb(CLO) });
  assert.strictEqual(d.action, 'none');
  const d2 = await pv.decideAtSubmit({ holdCtx: hold(CLO[2].opt_key), captureText: '이지 플로우 밴딩 팬츠 딥네이비 옵션 SIZE: 2', captureOption: '옵션 SIZE: 2', capturePrice: '175,200', db: stubDb(CLO) });
  assert.strictEqual(d2.action, 'none', '고른 상품 그대로(작업표 수정이 틀렸던 실측 사례)');
  const d3 = await pv.decideAtSubmit({ holdCtx: hold(CLO[3].opt_key), captureText: '드로우 스트링 티셔츠 세피아 SIZE: FREE', captureOption: 'SIZE: FREE', capturePrice: '85,200', db: stubDb(CLO) });
  assert.strictEqual(d3.action, 'none', '세피아(88,200) 골라 쿠폰으로 85,200 — 차콜 가격과 같아도 글자가 세피아면 경고 0(실측)');
});
t('3e ★ 금액 규칙은 좁게 — 같은 가격 상품이 둘·고른 상품 가격과 같음·가격이 다 같음·금액 없음 → 경고 0', async () => {
  const twin = CLO.map(o => o);   // 11·12 가 같은 175,200
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: hold(CLO[4].opt_key), captureText: '알 수 없는 상품', capturePrice: '175,200', db: stubDb(twin) })).action, 'none');
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: hold(MAT[2].optKey), captureText: '탄소매트', capturePrice: '69,800', db: stubDb(MATP) })).action, 'none');
  const flat = MATP.map(o => ({ ...o, pay_amount: 50000 }));
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: hold(MAT[2].optKey), captureText: '탄소매트', capturePrice: '50,000', db: stubDb(flat) })).action, 'none');
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: hold(MAT[2].optKey), captureText: '탄소매트', capturePrice: '', db: stubDb(MATP) })).action, 'none');
});

// ── 4. 작업표 상품 칸 → 참여 기록(③) ──
function syncPool({ editValue = null, base = '3. 퀸더블', appKey = MAT[2].optKey, updRows = 1, apps = 1 } = {}) {
  const log = [];
  const client = {
    query: async (sql, params) => {
      log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM campaign_participants/.test(sql)) return { rows: [{ id: 'row1', order_submission_id: 'os1', row_json: { 상품: base } }] };
      if (/FROM campaign_applications/.test(sql)) return { rows: Array.from({ length: apps }, (_, i) => ({ id: 10 + i, campaign_id: 'camp_m', option_key: appKey })) };
      if (/FROM participant_edits/.test(sql)) return { rows: editValue == null ? [] : [{ anchor_type: 'order', value_text: editValue }] };
      if (/FROM campaign_options/.test(sql)) return { rows: MAT.map(o => ({ opt_key: o.optKey, product_name: o.productName, status: 'active' })) };
      if (/^UPDATE campaign_applications/.test(sql.trim())) return { rows: Array.from({ length: updRows }, () => ({ id: 10 })) };
      return { rows: [] };
    },
    release() {},
  };
  return { log, pool: { connect: async () => client } };
}
t('4a 「상품」 칸을 킹으로 고치면 참여 기록이 퀸더블 → 킹 (공고 행 잠금 뒤 조건부 UPDATE)', async () => {
  const { log, pool } = syncPool({ editValue: '4. 킹(분리난방)' });
  const out = await pv.syncApplicationFromWorkboard({ sheetId: 's', tabName: 't', rowId: 'row1', field: 'col:상품', db: pool });
  assert.strictEqual(out.synced, true);
  assert.strictEqual(out.to, MAT[3].optKey);
  const iLock = log.findIndex(x => /FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(x.sql));
  const iUpd = log.findIndex(x => /^UPDATE campaign_applications SET option_key = \$3/.test(x.sql));
  assert.ok(iLock >= 0 && iUpd > iLock, '잠금 순서: 공고 행 → 신청 행');
  const iEdit = log.findIndex(x => /FROM participant_edits/.test(x.sql));
  const iApp = log.findIndex((x, k) => k > iLock && /FROM campaign_applications[\s\S]*FOR UPDATE/.test(x.sql));
  assert.ok(iEdit > iLock && iApp > iLock, '★ 지금 보이는 값·참여 기록은 잠근 뒤에 읽는다(동시 편집 시 마지막 편집을 따른다 — Codex P2)');
  assert.deepStrictEqual(log[iUpd].params, [10, MAT[2].optKey, MAT[3].optKey]);
  assert.ok(/AND option_key = \$2 AND status = 'submitted'/.test(log[iUpd].sql), '그 사이 바뀌었으면 덮지 않는다');
});
t('4b 되돌려 원래 값이 보이면 원래 상품으로 / 같은 상품이면 쓰기 0', async () => {
  const back = syncPool({ editValue: null, base: '3. 퀸더블', appKey: MAT[3].optKey });
  const o1 = await pv.syncApplicationFromWorkboard({ sheetId: 's', tabName: 't', rowId: 'row1', field: 'col:상품', db: back.pool });
  assert.strictEqual(o1.to, MAT[2].optKey);
  const same = syncPool({ editValue: '3. 퀸더블' });
  const o2 = await pv.syncApplicationFromWorkboard({ sheetId: 's', tabName: 't', rowId: 'row1', field: 'col:상품', db: same.pool });
  assert.strictEqual(o2.reason, 'same');
  assert.ok(!same.log.some(x => /^UPDATE/.test(x.sql)));
});
t('4c ★ 못 가리는 값·상품 아닌 칸·리뷰옵션 칸·참여 기록 둘 이상 → 쓰기 0', async () => {
  const un = syncPool({ editValue: '탄소매트' });
  assert.strictEqual((await pv.syncApplicationFromWorkboard({ sheetId: 's', tabName: 't', rowId: 'row1', field: 'col:상품', db: un.pool })).reason, 'unmatched');
  assert.ok(!un.log.some(x => /^UPDATE/.test(x.sql)));
  for (const f of ['col:주문번호', 'col:결제금액', 'col:리뷰옵션', 'reviewer_name']) {
    const p = syncPool({ editValue: '4. 킹(분리난방)' });
    assert.strictEqual((await pv.syncApplicationFromWorkboard({ sheetId: 's', tabName: 't', rowId: 'row1', field: f, db: p.pool })).synced, false, f);
    assert.strictEqual(p.log.length, 0, f + ' 는 DB 를 읽지도 않는다');
  }
  const two = syncPool({ editValue: '4. 킹(분리난방)', apps: 2 });
  assert.strictEqual((await pv.syncApplicationFromWorkboard({ sheetId: 's', tabName: 't', rowId: 'row1', field: 'col:상품', db: two.pool })).reason, 'ambiguous_application');
});
t('4d ★ 주문 원장(order_submissions)은 건드리지 않는다(결정 018 역주입 금지)', () => {
  const src = read('src/services/productMismatchVerify.service.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/UPDATE\s+order_submissions/i.test(code));
  assert.ok(!/selected_opt_key|selected_product/.test(code));
});

// ── 5. 배선 ──
t('5a 제출: 멱등 게이트 뒤·신원 게이트 앞에서 판정 · PRODUCT_MISMATCH / PRODUCT_WRONG_PURCHASE(막음) · 홀드 상품은 바꾸지 않음', () => {
  const s = read('src/routes/submit.routes.js');
  const iIdem = s.indexOf('if (holdCtx && holdCtx.doneKind) {');
  const iPv = s.indexOf('pv.decideAtSubmit(');
  const iGate = s.indexOf('const _newIdentityGate =');
  assert.ok(iIdem > 0 && iPv > iIdem && iGate > iPv, '순서: 멱등 → 상품 확인 → 신원');
  const blk = s.slice(s.lastIndexOf('if (holdCtx && holdCtx.verified && holdCtx.optionKey)', iPv), iGate);
  assert.ok(/code: 'PRODUCT_MISMATCH'/.test(blk));
  assert.ok(/if \(decision\.action === 'wrong'\) \{\s*return res\.json\(\{ ok: false, code: 'PRODUCT_WRONG_PURCHASE'/.test(blk), '잘못 구매는 곧바로 응답으로 막는다(접수 경로로 내려가지 않는다)');
  assert.ok(/step: decision\.action === 'wrong' \? 'wrong_product_purchase'/.test(blk), '담당자 확인용 이상로그');
  assert.ok(!/changeHoldOption|switchToActual|UPDATE campaign_applications/.test(blk), '홀드 상품을 옮기지 않는다');
  assert.ok(/b\.productCaptureOption/.test(blk) && /b\.confirmedProductKey/.test(blk) && /captureOption/.test(blk) && /capturePrice: b\.productCapturePrice/.test(blk));
});
t('5b 상품 바꾸기 경로가 없다(참여 기록·원장 상품 = 참여할 때 고른 상품)', () => {
  const src = read('src/services/productMismatchVerify.service.js');
  assert.ok(!/changeHoldOption|switchToActual/.test(src));
  assert.ok(!/router\.changeHoldOption/.test(read('src/routes/campaign.routes.js')));
});
t('5c 작업표 편집·되돌리기 둘 다 커밋 뒤 참여 기록을 맞추고, 내부 직원만', () => {
  const s = read('src/routes/trackB.routes.js');
  const ed = s.slice(s.indexOf("router.post('/workdesk/edit'"), s.indexOf("router.post('/workdesk/revert'"));
  const rv = s.slice(s.indexOf("router.post('/workdesk/revert'"), s.indexOf("router.post('/workdesk/revert'") + 1500);
  for (const [nm, blk] of [['edit', ed], ['revert', rv]]) {
    assert.ok(/syncApplicationFromWorkboard\(/.test(blk), nm);
    assert.ok(/role === 'master' \|\| role === 'admin' \|\| role === 'staff'/.test(blk), nm + ' 역할 제한');
  }
  assert.ok(ed.indexOf('svc.editWorkdeskRow(') < ed.indexOf('syncApplicationFromWorkboard('), '편집 커밋 뒤');
});
t('5d 캡처 AI 가 옵션 칸을 읽고 캐시 접두를 올렸다', () => {
  const g = read('src/services/gemini.service.js');
  assert.ok(/"productOption":/.test(g));
  assert.ok(/EXTRACT_CACHE_VERSION = 'extract4'/.test(g));
});
t('5e 리뷰어 화면: 홀드 제출에만 판독값 · PRODUCT_MISMATCH 면 경고 창 → confirmedProductKey 로 다시 · PRODUCT_WRONG_PURCHASE 면 제출 안 함', () => {
  const f = readFront('js/search-app.js');
  assert.ok(/productCaptureOption: \(bh \|\| \(_EMBED_CTX && _EMBED_CTX\.app\)\)/.test(f));
  assert.ok(/productCapturePrice:  \(bh \|\| \(_EMBED_CTX && _EMBED_CTX\.app\)\)/.test(f), '캡처 금액도 홀드 제출에만');
  const i = f.indexOf('res.code === "PRODUCT_MISMATCH"');
  assert.ok(i > 0);
  const blk = f.slice(i, i + 3400);   // 결정 236: 사이에 결제금액 다시 묻기 블록이 들어와 범위만 넓힘(검사 의미 불변)
  assert.ok(/await _pmvAsk\(/.test(blk) && /payload\.confirmedProductKey = picked/.test(blk));
  assert.ok(/res\.code === "PRODUCT_WRONG_PURCHASE"[\s\S]{0,500}continue;/.test(blk), '잘못 구매는 실패로 남기고 다음 주문으로');
  assert.ok(i < f.indexOf('res.code === "NEED_CONFIRM"'), '다시 낸 응답도 아래 신원 처리가 이어 받는다');
  assert.ok(/function _pmvAsk\(/.test(f) && /잘못 구매한 것 같아요/.test(f) && /function _pmvPlace\(/.test(f));
  assert.ok(/typeof json\.productOption === "string"/.test(f), '판독값이 글자가 아니면 버린다');
});

(async () => {
  for (const [name, fn] of _queue) {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${fail ? '❌' : '✅'} productMismatchVerify: ${pass}개 통과 / ${fail}개 실패`);
  if (fail) process.exit(1);
})();
