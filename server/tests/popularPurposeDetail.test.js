'use strict';
const assert = require('assert/strict');
const { calculatePopularCreditMatches } = require('../src/services/popularCredit.service');
const now = new Date('2026-11-05T10:00:00Z');
const event = (id, type, hour, phone8 = '90000001') => ({ id, event_type: type, event_at: new Date(now.getTime() - hour * 3600000), phone8 });

async function verifySql(loadPopularPurposeDetails) {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE recruit_campaigns(id text PRIMARY KEY, title text, participation_mode bool, linked_sheet_id text, linked_tab_name text, linked_tab_gid text, created_at timestamptz);
      CREATE TABLE order_submissions(id uuid PRIMARY KEY, selected_product text, selected_opt_key text, purchase_qty int, submitted_at timestamptz, deleted_at timestamptz, sheet_id text, tab_name text, tab_gid text);
      CREATE TABLE campaign_applications(id int PRIMARY KEY, campaign_id text, option_key text, purchase_qty int, order_submission_id uuid);
      CREATE TABLE campaign_participants(order_submission_id uuid, deleted_at timestamptz, active bool, sheet_id text, tab_name text, tab_gid text, seq int, product_name text, row_json jsonb);
      CREATE TABLE campaign_options(campaign_id text, opt_key text, product_name text);
      CREATE TABLE participant_edits(id bigint, sheet_id text, tab_name text, anchor_type text, anchor_value text, field text, value_text text, created_at timestamptz, reverted_at timestamptz);
      INSERT INTO recruit_campaigns VALUES
        ('n','가짜 일반 공고',true,'sheet-n','일반','1','2026-11-01T00:00:00Z'),
        ('p','가짜 인기 공고',true,'sheet-p','인기','2','2026-11-01T00:00:00Z'),
        ('future','나중에 만든 잘못된 공고',true,'sheet-p','인기','2','2026-11-06T00:00:00Z');
      INSERT INTO order_submissions VALUES
        ('00000000-0000-0000-0000-000000000001','가짜 신청 구매 상품','선택 옵션',3,'2026-11-05T07:00:00Z',null,'sheet-n','일반','1'),
        ('00000000-0000-0000-0000-000000000002','가짜 인기 바로 구매','인기 옵션',1,'2026-11-05T08:00:00Z',null,'sheet-p','인기','2'),
        ('00000000-0000-0000-0000-000000000003','','',null,'2026-11-05T07:30:00Z',null,'sheet-n','일반','1');
      INSERT INTO campaign_applications VALUES (1,'n','옛 옵션',2,'00000000-0000-0000-0000-000000000001'), (2,'p','인기 선택',null,null);
      INSERT INTO campaign_options VALUES ('p','인기 선택','가짜 인기 신청 상품');
      INSERT INTO campaign_participants VALUES
        ('00000000-0000-0000-0000-000000000003',null,true,'다른 작업표','일반','1',1,'다른 사람에게 보이면 안 됨','{}'),
        ('00000000-0000-0000-0000-000000000003',null,true,'sheet-n','일반','1',2,'가짜 작업표 상품','{}');
    `);
    const directNormal = 'os:00000000-0000-0000-0000-000000000003';
    const directPopular = 'os:00000000-0000-0000-0000-000000000002';
    const pairs = { matchedPairs: new Map([['1', directPopular], [directNormal, '2']]) };
    const result = await loadPopularPurposeDetails(db, pairs, ['1', directNormal], { onError: e => { throw e; } });
    assert.equal(result.get('1').purchase.product, '가짜 신청 구매 상품');
    assert.equal(result.get('1').purchase.option, '선택 옵션', 'order record wins over the old application option');
    assert.equal(result.get('1').purchase.quantity, 3);
    assert.equal(new Date(result.get('1').purchase.submittedAt).toISOString(), '2026-11-05T07:00:00.000Z');
    assert.equal(result.get('1').popularProduct, '가짜 인기 바로 구매');
    assert.equal(result.get('1').popularOption, '인기 옵션');
    assert.equal(result.get(directNormal).purchase.product, '가짜 작업표 상품', 'worktable fallback never crosses sheet scope');
    assert.equal(result.get(directNormal).purchase.quantity, null);
    assert.equal(result.get(directNormal).popularProduct, '가짜 인기 신청 상품', 'unsubmitted popular hold still has its chosen product');
    assert.equal(result.get(directNormal).popularOption, '인기 선택');
    const missing = await loadPopularPurposeDetails(db, { matchedPairs: new Map([['1', '999']]) }, ['1']);
    assert.deepEqual(missing.get('1'), { status: 'error' }, 'missing pair is not shown as a successful empty detail');
    await db.exec("INSERT INTO campaign_options VALUES ('p','인기 옵션','구매 당시 인기 상품'), ('future','인기 옵션','나중 공고 상품')");
    await db.exec("UPDATE order_submissions SET selected_product='' WHERE id='00000000-0000-0000-0000-000000000002'");
    const atPurchase = await loadPopularPurposeDetails(db, pairs, ['1']);
    assert.equal(atPurchase.get('1').popularProduct, '구매 당시 인기 상품', 'direct campaign resolution uses the same purchase-time order, not future reissue');
    await db.exec("UPDATE order_submissions SET selected_opt_key='' WHERE id='00000000-0000-0000-0000-000000000002'");
    const unknownProduct = await loadPopularPurposeDetails(db, pairs, ['1']);
    assert.equal(unknownProduct.get('1').popularProduct, '', 'campaign title is not proof of the purchased product name');
    await db.exec(`
      INSERT INTO campaign_participants VALUES
        ('00000000-0000-0000-0000-000000000001',null,true,'sheet-n','일반','1',3,'옛 작업표 상품','{}');
      INSERT INTO participant_edits VALUES
        (1,'sheet-n','일반','order','00000000-0000-0000-0000-000000000001','col:상품','담당자 정정 상품',NOW(),NULL),
        (2,'다른 작업표','일반','order','00000000-0000-0000-0000-000000000001','col:상품','다른 작업표 정정 노출 금지',NOW()+INTERVAL '1 hour',NULL),
        (3,'sheet-n','일반','order','00000000-0000-0000-0000-000000000009','col:상품','다른 주문 정정 노출 금지',NOW()+INTERVAL '1 hour',NULL);
    `);
    const corrected = await loadPopularPurposeDetails(db, pairs, ['1']);
    assert.equal(corrected.get('1').purchase.product, '담당자 정정 상품', 'same-order same-tab staff correction wins, as in the existing purchase list');
    await db.exec('UPDATE participant_edits SET reverted_at=NOW() WHERE id=1');
    const reverted = await loadPopularPurposeDetails(db, pairs, ['1']);
    assert.equal(reverted.get('1').purchase.product, '가짜 신청 구매 상품', 'reverting the staff correction restores the original purchase record');
    assert(!JSON.stringify([...result]).match(/phone|hold_token|orderId|campaignId/), 'detail response is an explicit display-only allowlist');
  } finally { await db.close(); }
}

async function verifyAdminFailure(adminSource, loadPopularPurposeDetails, matches) {
  const vm = require('vm');
  let handler;
  const ctx = {
    router: { get: (...args) => { handler = args[args.length - 1]; } },
    authMiddleware() {}, adminOrMasterMiddleware() {},
    pool: { query: async sql => {
      if (sql.includes('WITH keys AS')) throw Error('fake detail database failure');
      if (sql.includes('FROM campaign_applications ca')) return { rows: [{ id: 1, phone8: '90000001', status: 'submitted', applicant_name: '가상참여자' }] };
      return { rows: [] };
    } },
    loadPopularCreditMatches: async () => matches,
    fetchCampaignCounts: async () => new Map(),
    logger: { warn() {} },
    require: name => {
      if (name.endsWith('/popularPurposeDetail.service')) return { loadPopularPurposeDetails };
      if (name.endsWith('/quotaFloor.service')) return { confirmedWithDirect: () => ({ attributable: true, today: 1, total: 1, directToday: 1, direct: 1 }), optionDirectOrderStats: async () => new Map() };
      if (name.endsWith('/campaignState.service')) return { loadDirectOrderCounts: async () => new Map(), listDirectOrders: async () => [{ orderId: '2', phone8: '90000001', name: '가상바로구매자' }] };
      throw Error('Unexpected dependency: ' + name);
    },
  };
  vm.createContext(ctx); vm.runInContext(adminSource, ctx);
  let response;
  await handler({ params: { id: 'fake-campaign' } }, { json: data => { response = data; } }, err => { throw err; });
  assert.equal(response.ok, true, 'detail database failure cannot turn the entire list into an error');
  assert.equal(response.data.length, 1);
  assert.equal(response.data[0].popular_purpose, true);
  assert.equal(response.data[0].popular_purpose_detail.status, 'error');
  assert.equal(response.directSummary.rows[0].popularPurpose, true);
  assert.equal(response.directSummary.rows[0].popularPurposeDetail.status, 'error');
  assert(!('phone8' in response.directSummary.rows[0]), 'direct list phone stripping is preserved on failures');
}

function verifyPopup(ctx) {
  const documentEvents = new Map();
  const elements = [];
  const doc = {
    body: { style: { overflow: 'auto' }, appendChild: e => { elements.push(e); e.isConnected = true; } },
    addEventListener: (type, fn) => documentEvents.set(type, fn),
    removeEventListener: (type, fn) => { if (documentEvents.get(type) === fn) documentEvents.delete(type); },
    createElement: () => {
      const listeners = new Map();
      const closeButton = { listeners: new Map(), focus() { doc.activeElement = this; }, addEventListener(type, fn) { this.listeners.set(type, fn); } };
      const overlay = {
        style: {}, listeners, closeButton,
        querySelector: () => closeButton,
        addEventListener: (type, fn) => listeners.set(type, fn),
        contains: e => e === overlay || e === closeButton,
        remove() { this.isConnected = false; },
      };
      return overlay;
    },
  };
  const trigger = { isConnected: true, focus() { doc.activeElement = this; } };
  ctx.document = doc;
  ctx._campOpenPurposeDetail(0, trigger);
  const first = elements[0];
  assert(first.innerHTML.includes('role="dialog"') && first.innerHTML.includes('aria-modal="true"'));
  assert.equal(doc.activeElement, first.closeButton, 'opening moves keyboard focus into the popup');
  assert.equal(doc.body.style.overflow, 'hidden');
  const key = (key, shiftKey = false) => {
    const e = { key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    documentEvents.get('keydown')(e);
    return e;
  };
  assert(key('Tab').prevented && key('Tab', true).prevented, 'Tab and Shift+Tab cannot leave the popup');
  doc.activeElement = trigger;
  documentEvents.get('focusin')({ target: trigger });
  assert.equal(doc.activeElement, first.closeButton, 'programmatic background focus is also contained');
  assert(key('Escape').stopped, 'Escape closes only this popup');
  assert.equal(first.isConnected, false);
  assert.equal(doc.activeElement, trigger, 'close restores the original badge focus');
  assert.equal(doc.body.style.overflow, 'auto');
  assert.equal(documentEvents.size, 0, 'close cleans up document listeners');
  ctx._campOpenPurposeDetail(0, trigger);
  const second = elements[1];
  second.listeners.get('click')({ target: second.closeButton });
  assert.equal(second.isConnected, true, 'clicking popup contents is not a background dismissal');
  second.listeners.get('click')({ target: second });
  assert.equal(second.isConnected, false, 'background click closes');
  ctx._campOpenPurposeDetail(0, trigger);
  elements[2].closeButton.listeners.get('click')();
  assert.equal(elements[2].isConnected, false, 'close button closes');
  ctx._campOpenPurposeDetail(-1, trigger);
  assert.equal(elements.length, 3, 'invalid index cannot open unrelated data');
}

async function main() {
  const matches = calculatePopularCreditMatches([
    event('1', 'normal', 5), event('os:2', 'normal', 4), event('3', 'popular', 3), event('os:4', 'popular', 2),
    event('5', 'normal', 25), event('6', 'popular', 1, '90000002'),
  ], now);
  assert(matches.matchedPairs instanceof Map, 'exact FIFO pairs are exposed as a Map');
  assert.deepEqual([...matches.matchedPairs], [['1', '3'], ['os:2', 'os:4']]);
  assert.deepEqual([...matches.matchedNormalIds], ['1', 'os:2']);
  assert.equal(matches.states.get('90000001').credits, 0);
  const { loadPopularPurposeDetails } = require('../src/services/popularPurposeDetail.service');
  let calls = 0;
  const db = { query: async (sql, params) => {
    calls++;
    assert.deepEqual(params, [['1', '3', 'os:2', 'os:4']]);
    return { rows: [
      { event_id: '1', product: '가짜 일반 상품', option: '가짜 옵션', quantity: 3, submitted_at: now },
      { event_id: '3', product: '가짜 인기 상품' },
      { event_id: 'os:2', product: '가짜 바로 구매', quantity: null },
      { event_id: 'os:4', product: '가짜 인기 바로 구매' },
    ] };
  } };
  const details = await loadPopularPurposeDetails(db, matches, ['1', 'os:2', 'unmatched']);
  assert.equal(calls, 1, 'all pairs are loaded in one read');
  assert.deepEqual(details.get('1'), { status: 'ok', purchase: {
    product: '가짜 일반 상품', option: '가짜 옵션', quantity: 3, submittedAt: now,
  }, popularProduct: '가짜 인기 상품', popularOption: '' });
  assert.equal(details.get('os:2').purchase.quantity, null, 'unknown quantity must not become 1');
  assert.equal(details.get('os:2').popularProduct, '가짜 인기 바로 구매');
  assert.equal(details.has('unmatched'), false);
  assert.equal((await loadPopularPurposeDetails(db, matches, [])).size, 0);
  assert.equal(calls, 1, 'no unscoped read on an empty selection');
  const failed = await loadPopularPurposeDetails({ query: async () => { throw Error('fixture failure'); } }, matches, ['1']);
  assert.deepEqual(failed.get('1'), { status: 'error' }, 'detail failure stays separate from the purpose marker');
  const fs = require('fs');
  const path = require('path');
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
  const admin = routes.slice(routes.indexOf("router.get('/admin/:id/applications'"), routes.indexOf('_handlers.adminApplications ='));
  assert(admin.includes('popular_purpose_detail:'), 'application rows receive the admin-only detail');
  assert(admin.includes('r.popularPurposeDetail ='), 'direct rows receive the admin-only detail');
  assert.equal((routes.match(/loadPopularPurposeDetails\(/g) || []).length, 2, 'only the two admin list paths load details');
  const vm = require('vm');
  const ui = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-recruit.js'), 'utf8');
  const helperStart = ui.indexOf('let _campPurposeDetails =');
  assert(helperStart >= 0, 'badge detail helpers exist');
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(ui.slice(helperStart, ui.indexOf('/** 👥 소유자별 묶음표', helperStart)), ctx);
  const hostile = '<img src=x onerror="alert(1)">';
  const html = ctx._campPurposeContent({ status: 'ok', purchase: { product: hostile, option: hostile, quantity: null, submittedAt: 'invalid' }, popularProduct: hostile });
  assert(!html.includes('<img') && html.includes('&lt;img'), 'all record text is escaped');
  assert(html.includes('미확인') && html.includes('구매 기록 기준'));
  assert(ctx._campPurposeContent(null).includes('불러오지 못했습니다'), 'old server / failed detail shows failure, not empty success');
  const badge = ctx._campPurposeBadge({ status: 'ok', purchase: { product: hostile } }, true);
  assert(badge.includes('<button') && badge.includes('🔥 인기상품목적 참여건'));
  assert(badge.includes('data-camp-purpose="0"') && !badge.includes(hostile) && !badge.includes('onclick='), 'only a safe index enters badge markup');
  assert(ui.includes('_campPurposeBadge(r.popular_purpose_detail') && ui.includes('_campPurposeBadge(r.popularPurposeDetail'), 'both list kinds open the same popup');
  verifyPopup(ctx);
  await verifySql(loadPopularPurposeDetails);
  await verifyAdminFailure(admin, loadPopularPurposeDetails, matches);
  console.log('popularPurposeDetail: passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
