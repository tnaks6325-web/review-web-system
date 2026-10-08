'use strict';
/**
 * manualOrderOptionPick.test.js — 결정 211 회귀가드 (사용자 확정 2026-10-08)
 * 작업보드 [외부모집 수동제출]에서 상품(선택지)을 골라 주문 기록·작업표에 그대로 반영한다.
 *  - 목록: 탭에 연결된 공고가 하나로 정해질 때만, 남은 자리는 공고 화면과 같은 판정
 *  - 새 화면(optionAware): 상품 2개 이상이면 안 고른 줄은 거절 · 마감 상품은 확인 체크 필수
 *  - 옛 화면(캐시): 종전대로 접수(막지 않는다) · 상품 1개면 자동
 * 실행: node tests/manualOrderOptionPick.test.js
 */
const assert = require('assert');
let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

const poolMod = require('../src/db/pool');
const reviewerSvc = require('../src/services/reviewer.service');
reviewerSvc.registerReviewer = async () => ({ ok: true });
const svc = require('../src/services/manualOrder.service');

const NU = ['1. HA-600FHC (누쓰쓰)(배송메세지00<넣어서구매)', '5. HA-HD2200(배송메세지00<넣어서구매)'];
function db(routes) {
  const log = [];
  return { log, async query(sql, params) {
    const q = String(sql); log.push({ q, params });
    for (const [re, rows] of routes) if (re.test(q)) { if (rows instanceof Error) throw rows; return { rows: typeof rows === 'function' ? rows(params) : rows }; }
    return { rows: [] };
  } };
}
const OPT_ROWS = [
  { opt_key: NU[0], product_name: NU[0], unit_kind: 'product', recruit_total: 5, daily_limit: 3, status: 'active' },
  { opt_key: NU[1], product_name: NU[1], unit_kind: 'product', recruit_total: 30, daily_limit: 10, status: 'active' },
];

(async () => {
  await ok('목록: 연결 공고 1개 → 선택지와 남은 자리(신청 5 → 1번 상품 마감)', async () => {
    const d = db([
      [/FROM recruit_campaigns rc/, [{ id: 'c1', status: 'draft' }]],
      [/GROUP BY campaign_id, option_key/, [{ campaign_id: 'c1', option_key: NU[0], active_holds: 0, today_active_holds: 0, submitted: 5, today_submitted: 3 }]],
      [/SELECT opt_key, product_name, unit_kind, recruit_total/, OPT_ROWS],
    ]);
    const r = await svc.tabOptionChoices(d, { sheetId: 'wt_1', tabName: 'T' }, new Date('2026-10-08T03:00:00Z'));
    assert.equal(r.campaignId, 'c1');
    assert.equal(r.choices.length, 2);
    assert.equal(r.choices[0].status, 'soldout'); assert.equal(r.choices[0].used, 5);
    assert.equal(r.choices[1].remaining, 30);
  });
  await ok('목록: 연결 공고가 여럿이면 active 하나만 고른다 · 못 정하면 null(고르는 칸 없음 = 종전)', async () => {
    const two = db([[/FROM recruit_campaigns rc/, [{ id: 'c1', status: 'draft' }, { id: 'c2', status: 'active' }]],
      [/SELECT opt_key, product_name, unit_kind, recruit_total/, OPT_ROWS]]);
    assert.equal((await svc.tabOptionChoices(two, { sheetId: 'S', tabName: 'T' })).campaignId, 'c2');
    const amb = db([[/FROM recruit_campaigns rc/, [{ id: 'c1', status: 'active' }, { id: 'c2', status: 'active' }]]]);
    assert.equal(await svc.tabOptionChoices(amb, { sheetId: 'S', tabName: 'T' }), null);
    assert.equal(await svc.tabOptionChoices(db([]), { sheetId: 'S', tabName: 'T' }), null);
  });
  await ok('목록: 조회 실패 = null(접수는 종전대로)', async () => {
    assert.equal(await svc.tabOptionChoices(db([[/FROM recruit_campaigns rc/, new Error('boom')]]), { sheetId: 'S', tabName: 'T' }), null);
    assert.equal(await svc.tabOptionChoices(db([]), { sheetId: '', tabName: 'T' }), null);
  });

  // ── 제출 라우트: 서비스 두 함수를 바꿔 끼운 뒤 라우트를 새로 읽는다(구조분해 캡처) ──
  const calls = [];
  let choices = null;
  const realSubmit = svc.submitExternalOrder, realTab = svc.tabOptionChoices;
  svc.submitExternalOrder = async (a) => { calls.push(a); return { ok: true, warnings: [] }; };
  svc.tabOptionChoices = async () => choices;
  const realQuery = poolMod.query;
  poolMod.query = async () => ({ rows: [] });
  delete require.cache[require.resolve('../src/routes/manualOrder.routes')];
  const router = require('../src/routes/manualOrder.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/submit');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const F = { recipient: '김하늘', phone: '010-1234-0001', address: '서울', bank: '신한', account: '1', depositor: '김하늘' };
  const post = async (body) => { let out; await handler({ body: { sheetId: 'S', tabName: 'T', allowRepurchase: true, ...body }, admin: { name: 'A' } },
    { json: v => { out = v; }, status() { return this; } }, e => { throw e; }); return out; };
  const C2 = { campaignId: 'c1', choices: [
    { optKey: NU[0], productName: NU[0], status: 'soldout', used: 5, recruitTotal: 5, remaining: 0 },
    { optKey: NU[1], productName: NU[1], status: 'open', used: 29, recruitTotal: 30, remaining: 1 } ] };

  await ok('새 화면: 상품 2개 이상인데 안 고른 줄은 거절(쓰기 없음)', async () => {
    choices = C2; calls.length = 0;
    const r = await post({ optionAware: true, items: [{ fields: F, optionKey: '' }] });
    assert.equal(r.results[0].reason, 'option_required'); assert.equal(calls.length, 0);
  });
  await ok('새 화면: 마감 상품은 확인 체크 없으면 거절 · 체크하면 접수 + 결과에 초과 경고', async () => {
    choices = C2; calls.length = 0;
    const r1 = await post({ optionAware: true, items: [{ fields: F, optionKey: NU[0] }] });
    assert.equal(r1.results[0].reason, 'option_full_confirm'); assert.equal(calls.length, 0);
    const r2 = await post({ optionAware: true, items: [{ fields: F, optionKey: NU[0], optionFullAck: true }] });
    assert.equal(r2.results[0].ok, true);
    assert.equal(calls[0].optionKey, NU[0]); assert.equal(calls[0].optionCampaignId, 'c1'); assert.equal(calls[0].campaignId, null);
    assert(r2.results[0].warnings.some(w => /정원을 넘겨/.test(w)));
  });
  await ok('새 화면: 한 묶음에서 남은 자리(1)를 넘는 둘째 줄은 확인을 받는다(Codex 리뷰)', async () => {
    choices = C2; calls.length = 0;
    const r = await post({ optionAware: true, items: [{ fields: F, optionKey: NU[1] }, { fields: F, optionKey: NU[1] }] });
    assert.equal(r.results[0].ok, true); assert.equal(r.results[1].reason, 'option_full_confirm'); assert.equal(calls.length, 1);
    calls.length = 0;
    const r2 = await post({ optionAware: true, items: [{ fields: F, optionKey: NU[1] }, { fields: F, optionKey: NU[1], optionFullAck: true }] });
    assert.equal(r2.okCount, 2); assert(r2.results[1].warnings.some(w => /정원을 넘겨/.test(w)));
  });
  await ok('고른 상품이 그사이 사라지면 남은 하나로 바꿔 넣지 않는다(Codex 리뷰)', async () => {
    choices = { campaignId: 'c1', choices: [{ optKey: 'B', productName: 'B', status: 'open', used: 0, recruitTotal: 10, remaining: 10 }] }; calls.length = 0;
    const r = await post({ optionAware: true, items: [{ fields: F, optionKey: 'A' }] });
    assert.equal(r.results[0].reason, 'option_unavailable'); assert.equal(calls.length, 0);
    await post({ items: [{ fields: F, optionKey: 'A' }] });
    assert.equal(calls[0].optionKey, '', '옛 화면은 접수하되 확인 못 한 이름은 버린다');
  });
  await ok('접수 때 상품 목록을 못 읽으면 화면 값을 쓰지 않는다(종전 = 빈 값 · Codex 리뷰)', async () => {
    choices = null; calls.length = 0;
    await post({ optionAware: true, items: [{ fields: F, optionKey: NU[0] }] });
    assert.equal(calls[0].optionKey, ''); assert.equal(calls[0].optionCampaignId, null);
  });
  await ok('새 화면: 남은 상품을 고르면 그 이름 + 연결 공고로 넘긴다(정원 차감·신청 생성 경로 아님)', async () => {
    choices = C2; calls.length = 0;
    await post({ optionAware: true, items: [{ fields: F, optionKey: NU[1] }] });
    assert.equal(calls[0].optionKey, NU[1]); assert.equal(calls[0].campaignId, null);
  });
  await ok('옛 화면(optionAware 없음): 막지 않고 종전대로 접수 · 모르는 이름은 버린다', async () => {
    choices = C2; calls.length = 0;
    const r = await post({ items: [{ fields: F, optionKey: '' }, { fields: F, optionKey: '엉뚱한값' }] });
    assert.equal(r.okCount, 2); assert.equal(calls[0].optionKey, ''); assert.equal(calls[1].optionKey, '');
  });
  await ok('상품 1개 공고: 고르지 않아도 자동으로 그 상품', async () => {
    choices = { campaignId: 'c9', choices: [{ optKey: 'X', productName: 'X', status: 'open', used: 0, recruitTotal: 10, remaining: 10 }] }; calls.length = 0;
    await post({ optionAware: true, items: [{ fields: F }] });
    assert.equal(calls[0].optionKey, 'X'); assert.equal(calls[0].optionCampaignId, 'c9');
  });
  await ok('연결 공고 없음: 종전 그대로(상품 칸 값 그대로 · 연결 공고 null)', async () => {
    choices = null; calls.length = 0;
    await post({ optionAware: false, items: [{ fields: F, optionKey: '' }] });
    assert.equal(calls[0].optionKey, ''); assert.equal(calls[0].optionCampaignId, null);
  });
  await ok('공고 화면 경로(campaignId)는 목록을 찾지 않는다(신청 선택이 옵션을 정함)', async () => {
    let asked = 0; svc.tabOptionChoices = async () => { asked++; return C2; };
    delete require.cache[require.resolve('../src/routes/manualOrder.routes')];
    const r2 = require('../src/routes/manualOrder.routes');
    const h2 = r2.stack.find(l => l.route && l.route.path === '/submit').route.stack.slice(-1)[0].handle;
    calls.length = 0;
    await h2({ body: { sheetId: 'S', tabName: 'T', campaignId: 'cX', allowRepurchase: true, allowOverDaily: true, optionAware: true, items: [{ fields: F, optionKey: '' }] }, admin: {} },
      { json() {}, status() { return this; } }, e => { throw e; });
    assert.equal(asked, 0); assert.equal(calls[0].optionCampaignId, null);
  });
  svc.submitExternalOrder = realSubmit; svc.tabOptionChoices = realTab;

  await ok('서비스: 고른 이름을 연결 공고에서 풀이한다(상품 단위 → 상품 칸, 옵션 칸 비움)', async () => {
    const seen = [];
    poolMod.query = async (sql, params) => {
      const q = String(sql); seen.push({ q, params });
      if (/SELECT unit_kind, product_name FROM campaign_options/.test(q)) return { rows: [{ unit_kind: 'product', product_name: NU[0] }] };
      return { rows: [] };
    };
    try {
      await svc.submitExternalOrder({ sheetId: 'S', tabName: 'T', gid: '', fields: F, campaignId: null, optionCampaignId: 'c1',
        optionKey: NU[0], adminName: 'A', force: true, allowRepurchase: true });
    } catch (_) { /* 원장 기록(실제 DB)에서 멈춘다 — 그 전 단계만 본다 */ }
    const lk = seen.find(x => /SELECT unit_kind, product_name FROM campaign_options/.test(x.q));
    assert(lk, '연결 공고에서 상품을 찾았다'); assert.deepEqual(lk.params, ['c1', NU[0]]);
  });
  poolMod.query = realQuery;

  await ok('무시트 작업표는 리뷰어 제출과 같은 길로 줄을 고른다 — 원장이 옛 시트 방식으로 줄을 먼저 잡지 않는다(결정 213)', async () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/services/manualOrder.service.js'), 'utf8');
    const iSl = src.indexOf("isSheetless(require('../db/pool'), sheetId, tabName)");
    const iLedger = src.indexOf('const ledger = await createOrderLedgerEntry(');
    assert(iSl > 0 && iSl < iLedger, '무시트 판정이 원장 기록보다 먼저');
    assert(/skipSheetMirror: queuedWorkboardApply \|\| isSl,/.test(src));
    assert(/if \(!sheetlessDone\.ok\) \{\s*\/\/[^\n]*\n\s*try \{ await markOrderMirrorFailed\(ledger\.orderSubmissionId/.test(src), '작업표 기록 실패는 자동복구 대상으로 표시');
  });

  await ok('작업표 기록이 실패한 작업보드 수동제출(신청·줄 번호 없음)도 자동복구가 다시 쓴다(결정 213 · Codex 리뷰)', async () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/services/sheetlessOrder.service.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function recoverUnwrittenSheetlessOrders('), src.indexOf('const result = {', src.indexOf('async function recoverUnwrittenSheetlessOrders(')));
    assert(/UNION ALL/.test(fn), '신청 기준 갈래 + 수동제출 갈래');
    assert(/os\.source = 'admin_external'/.test(fn) && /os\.campaign_application_id IS NULL/.test(fn) && /os\.sheet_row IS NULL/.test(fn));
    assert(/COALESCE\(tc\.sheetless, FALSE\) = TRUE[\s\S]*JOIN workboards w ON w\.id = tc\.workboard_id AND w\.state = 'active'/.test(fn), '무시트·작업보드 연결 탭만');
    assert(/ORDER BY submitted_at ASC\s*LIMIT \$1/.test(fn), '두 갈래를 합친 뒤 오래된 순 상한');
  });

  // ── 화면 배선(정적) ──
  const fs = require('fs'), path = require('path');
  const mo = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/manual-order.js'), 'utf8');
  await ok('화면: 미리보기 요청에 작업 좌표를 싣고, 공고 화면 경로에서는 상품 칸을 띄우지 않는다', async () => {
    assert(/JSON\.stringify\(\{ text, sheetId: CTX\.sheetId, tabName: CTX\.tabName/.test(mo));
    assert(/OPTS = \(!CTX\.campaignId && Array\.isArray\(r\.optionChoices\)\)/.test(mo));
  });
  await ok('화면: 제출은 고를 수 있는 줄만 · optionAware·optionFullAck 를 보낸다', async () => {
    assert(/filter\(x => submittable\(x\.r\)\)/.test(mo));
    assert(/optionAware: OPTS\.length > 0/.test(mo) && /optionFullAck: x\.r\.optFullAck === true/.test(mo));
    assert(/pickOption, ackOption/.test(mo));
  });
  await ok('화면: 옵션 단위는 옵션 이름으로 보이고, 상품 1개여도 남은 자리 초과 확인 체크가 나온다(Codex 리뷰)', async () => {
    assert(/o\.unitKind === 'option' \? o\.optKey : \(o\.productName \|\| o\.optKey\)/.test(mo));
    const cell = mo.slice(mo.indexOf('function optCell('), mo.indexOf('function pickOption('));
    assert(cell.indexOf('_optOver(it)') < cell.indexOf('OPTS.length === 1'), '확인 체크 판단이 자동 표시보다 먼저');
    assert(/if \(!OPTS\.length\) return '';\s*if \(!_optOf\(it\)\) return 'need';/.test(mo));
  });
  console.log(`\n✅ manualOrderOptionPick: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
