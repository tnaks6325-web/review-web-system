/**
 * productMismatchVerify.test.js — 결정 230 회귀가드: 고른 상품 ≠ 실제 산 상품
 *   ① 캡처가 다른 상품 하나를 가리키면 제출 전에 묻는다 · 고른 "실제로 산 상품"으로 옮긴다
 *   ② 그 상품 자리가 없으면 막는다(담당자 문의)
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
t('2b 리뷰어가 고른 상품을 그대로 확인 → keep / 다른 공고 상품 → switch / 지어낸 값 → none', async () => {
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD, captureText: 'HIA-1450HM', confirmedKey: 'HA-HD1590', db: stubDb(optRows) })).action, 'keep');
  const sw = await pv.decideAtSubmit({ holdCtx: HOLD, captureText: '', confirmedKey: FR[0].optKey, db: stubDb(optRows) });
  assert.deepStrictEqual(sw, { action: 'switch', newKey: FR[0].optKey });
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

// ── 3. 옮기기 = 구매 전 옵션 변경과 같은 판정(②) ──
function routesReturning(out) { const calls = []; return { calls, changeHoldOption: async (a) => { calls.push(a); if (out instanceof Error) throw out; return out; } }; }
t('3a 성공 → ok · change-option 과 같은 함수에 홀드 열쇠를 그대로 넘긴다', async () => {
  const r = routesReturning({ code: 200, body: { ok: true } });
  pv.__setCampaignRoutesForTest(r);
  const out = await pv.switchToActual({ holdCtx: HOLD, newKey: 'X' });
  assert.deepStrictEqual(out, { ok: true });
  assert.deepStrictEqual(r.calls[0], { id: 'camp_x', p8: '12345678', token: 'tok', newKey: 'X', via: 'order-actual-product' });
});
t('3b ★ ②(나) 자리 없음(정원·하루·멈춤·차례·마감) → blocked + 담당자 문의 문구', async () => {
  for (const reason of ['option_soldout', 'option_today_done', 'option_paused', 'option_waiting', 'option_closed', 'option_invalid']) {
    pv.__setCampaignRoutesForTest(routesReturning({ code: 409, body: { ok: false, reason } }));
    const out = await pv.switchToActual({ holdCtx: HOLD, newKey: '4. 킹' });
    assert.strictEqual(out.blocked, true, reason);
    assert.ok(/담당자에게 문의/.test(out.error) && /4\. 킹/.test(out.error));
  }
});
t('3c 만료·예외는 막지 않는다(blocked=false → 종전대로 접수)', async () => {
  pv.__setCampaignRoutesForTest(routesReturning({ code: 409, body: { ok: false, reason: 'not_changeable' } }));
  assert.strictEqual((await pv.switchToActual({ holdCtx: HOLD, newKey: 'X' })).blocked, false);
  pv.__setCampaignRoutesForTest(routesReturning(new Error('boom')));
  assert.strictEqual((await pv.switchToActual({ holdCtx: HOLD, newKey: 'X' })).blocked, false);
  pv.__setCampaignRoutesForTest(null);
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
t('5a 제출: 멱등 게이트 뒤·신원 게이트 앞에서 판정, PRODUCT_MISMATCH/PRODUCT_UNAVAILABLE, 옮긴 뒤 홀드 재조회', () => {
  const s = read('src/routes/submit.routes.js');
  const iIdem = s.indexOf('if (holdCtx && holdCtx.doneKind) {');
  const iPv = s.indexOf('pv.decideAtSubmit(');
  const iGate = s.indexOf('const _newIdentityGate =');
  assert.ok(iIdem > 0 && iPv > iIdem && iGate > iPv, '순서: 멱등 → 상품 확인 → 신원');
  const blk = s.slice(s.lastIndexOf('if (holdCtx && holdCtx.verified && holdCtx.optionKey)', iPv), iGate);
  assert.ok(/code: 'PRODUCT_MISMATCH'/.test(blk) && /code: 'PRODUCT_UNAVAILABLE'/.test(blk));
  assert.ok(/await _authoritativeHold\(holdCtx\)/.test(blk), '옮긴 상품을 단일 출처로 다시 읽는다');
  assert.ok(/b\.productCaptureOption/.test(blk) && /b\.confirmedProductKey/.test(blk));
});
t('5b change-option 라우트와 제출이 같은 함수(_changeHoldOption)를 탄다', () => {
  const s = read('src/routes/campaign.routes.js');
  assert.ok(/async function _changeHoldOption\(/.test(s));
  assert.ok(/router\.post\('\/:id\/change-option'[\s\S]{0,200}_changeHoldOption\(/.test(s));
  assert.ok(/router\.changeHoldOption = _changeHoldOption;/.test(s));
  assert.ok(/require\('\.\.\/routes\/campaign\.routes'\)\.changeHoldOption/.test(read('src/services/productMismatchVerify.service.js')));
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
t('5e 리뷰어 화면: 홀드 제출에만 판독값을 싣고, PRODUCT_MISMATCH 면 묻고 confirmedProductKey 로 다시 낸다', () => {
  const f = readFront('js/search-app.js');
  assert.ok(/productCaptureOption: \(bh \|\| \(_EMBED_CTX && _EMBED_CTX\.app\)\)/.test(f));
  const i = f.indexOf('res.code === "PRODUCT_MISMATCH"');
  assert.ok(i > 0);
  const blk = f.slice(i, i + 900);
  assert.ok(/await _pmvAsk\(/.test(blk) && /payload\.confirmedProductKey = picked/.test(blk));
  assert.ok(i < f.indexOf('res.code === "NEED_CONFIRM"'), '다시 낸 응답도 아래 신원 처리가 이어 받는다');
  assert.ok(/function _pmvAsk\(/.test(f));
  assert.ok(/_ofpOnExtracted\(cid, json\.productLabel \|\| "", json\.productName \|\| "", json\.productOption \|\| ""\)/.test(f));
});

(async () => {
  for (const [name, fn] of _queue) {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${fail ? '❌' : '✅'} productMismatchVerify: ${pass}개 통과 / ${fail}개 실패`);
  if (fail) process.exit(1);
})();
