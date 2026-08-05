'use strict';
/**
 * 회귀가드 — 작업오더 관리자 수정 (시안: frontend/docs/작업오더_관리자수정_와이어프레임.html)
 *
 * 실행: node tests/workOrderAdminEdit.test.js
 *
 * ★ 이 가드가 지키는 것:
 *   ① 편집 불가 3종 고정(완화 금지): status · 계약건(sales_id/contract_number/quote_id) ·
 *      work_sheet_url — 화이트리스트에 절대 들어가면 안 된다(guide_images 도 1차 제외)
 *   ② 서버 런타임(스텁 pool): 화이트리스트 밖 필드 무시 · 빈 값=변경 없음 ·
 *      같은 값=no-op(unchanged) · done/삭제 오더 409 · 바뀐 필드만 UPDATE + memo_log 기록
 *   ③ 라우터 실검사: PUT /api/order/admin/edit (auth+adminOrMaster) ·
 *      PUT /api/trackb/work-orders/edit (auth+internal+editorOnly 위임)
 *   ④ 공유 모달 한 벌(사본 금지) + 런타임 실행: 오더 값이 innerHTML 로 보간되지 않고
 *      .value 로만 주입(XSS) · 바뀐 필드만 save 로 전송 · 무변경이면 저장 안 함
 *   ⑤ 두 호스트 배선(admin=orderAdminEdit / workdesk=/api/trackb/work-orders/edit,
 *      workdesk 버튼은 _woEditActions 안 = 편집 허용명단 게이트 자동 상속)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const routesSrc = fs.readFileSync(path.join(ROOT, 'server/src/routes/order.routes.js'), 'utf8');
const trackBSrc = fs.readFileSync(path.join(ROOT, 'server/src/routes/trackB.routes.js'), 'utf8');
const wodSrc = fs.readFileSync(path.join(ROOT, 'frontend/js/work-order-detail.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'frontend/js/index-app.js'), 'utf8');
const wdSrc = fs.readFileSync(path.join(ROOT, 'frontend/workdesk.html'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'frontend/api.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') throw new Error('async 케이스는 run()에서'); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

console.log('\n[1] 화이트리스트 — 편집 불가 필드 고정');

const wl = (() => {
  const m = routesSrc.match(/const ADMIN_EDIT_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'ADMIN_EDIT_FIELDS 없음');
  return m[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
})();

t('① status/sales_id/contract_number/quote_id/work_sheet_url/guide_images 는 화이트리스트 밖', () => {
  ['status', 'sales_id', 'contract_number', 'quote_id', 'work_sheet_url', 'guide_images',
   'created_by', 'processed_by', 'linked_tab_gid', 'linked_campaign_id'].forEach(f =>
    assert.ok(!wl.includes(f), `편집 불가 필드가 화이트리스트에 들어감: ${f}`));
});

t('① 시안의 편집 가능 필드가 전부 있다', () => {
  ['title', 'start_date', 'purchase_time', 'manager_name', 'work_manager', 'recruit_count',
   'daily_count', 'delivery_type', 'courier_proxy', 'review_type', 'goods_cost_type',
   'product_url', 'product_option', 'pay_amount', 'inflow_type', 'inflow_keyword',
   'inflow_guide', 'review_guide', 'special_notes'].forEach(f =>
    assert.ok(wl.includes(f), `편집 가능 필드 누락: ${f}`));
});

console.log('\n[2] 라우터 실검사');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const orderRouter = require(path.join(ROOT, 'server/src/routes/order.routes.js'));
const trackBRouter = require(path.join(ROOT, 'server/src/routes/trackB.routes.js'));
const pool = require(path.join(ROOT, 'server/src/db/pool.js'));

function findRoute(router, method, p) {
  return (router.stack || []).find(l => l.route && l.route.path === p && l.route.methods[method]);
}

t('③ PUT /admin/edit 등록 + 미들웨어 3단(auth+adminOrMaster+handler)', () => {
  const layer = findRoute(orderRouter, 'put', '/admin/edit');
  assert.ok(layer, '라우트 없음');
  assert.ok(layer.route.stack.length >= 3, '미들웨어 체인 부족: ' + layer.route.stack.length);
});

t('③ PUT /work-orders/edit 위임 등록(trackB) + 미들웨어 4단', () => {
  const layer = findRoute(trackBRouter, 'put', '/work-orders/edit');
  assert.ok(layer, 'trackB 위임 라우트 없음');
  assert.ok(layer.route.stack.length >= 4, 'auth+internal+editorOnly+handler 체인 부족: ' + layer.route.stack.length);
  assert.ok(/_delegate\(_orderRoutes, 'put', '\/admin\/edit'\)/.test(trackBSrc), '_delegate 위임 아님(사본 금지)');
});

console.log('\n[3] 서버 런타임 — 스텁 pool 로 핸들러 실제 실행');

const editHandler = (() => {
  const layer = findRoute(orderRouter, 'put', '/admin/edit');
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}

const BASE_ORDER = {
  id: 'wo-1', title: '테스트 오더', status: 'reviewing', deleted_at: null,
  purchase_time: '09:00 ~ 14:00', recruit_count: 10, daily_count: 10, pay_amount: 28900,
  special_notes: '', work_sheet_url: 'https://docs.google.com/spreadsheets/d/x/edit#gid=1',
  sales_id: 'S-1', memo_log: '[]', created_by: '김AE', start_date: null, courier_proxy: false,
};

function stubPool(order, queries) {
  pool.query = async (sql, params) => {
    queries.push({ sql: String(sql), params });
    const s = String(sql);
    if (/SELECT \* FROM work_orders/.test(s)) return { rows: order ? [Object.assign({}, order)] : [] };
    if (/UPDATE work_orders SET/.test(s) && /RETURNING \*/.test(s)) {
      return { rows: [Object.assign({}, order, { memo_log: '[]' })] };
    }
    return { rows: [] };
  };
}

async function callEdit(order, body) {
  const queries = [];
  stubPool(order, queries);
  const res = makeRes();
  await editHandler({ body, admin: { name: '테스트관리자' } }, res, e => { throw e; });
  return { res, queries };
}

async function run() {
  delete process.env.INTRANET_MEMO_WEBHOOK_URL;

  await ta('② 화이트리스트 밖 필드(status·work_sheet_url·sales_id)는 UPDATE 에 못 들어간다', async () => {
    const { res, queries } = await callEdit(BASE_ORDER, {
      id: 'wo-1', status: 'done', work_sheet_url: 'https://evil', sales_id: 'S-999',
      purchase_time: '09:00 ~ 15:00',
    });
    assert.strictEqual(res.body && res.body.ok, true, JSON.stringify(res.body));
    const upd = queries.find(q => /UPDATE work_orders SET/.test(q.sql) && /RETURNING/.test(q.sql));
    assert.ok(upd, 'UPDATE 없음');
    assert.ok(!/status =/.test(upd.sql), 'status 가 SET 에 들어감');
    assert.ok(!/work_sheet_url/.test(upd.sql), 'work_sheet_url 이 SET 에 들어감');
    assert.ok(!/sales_id/.test(upd.sql), 'sales_id 가 SET 에 들어감');
    assert.deepStrictEqual(res.body.changed, ['purchase_time']);
  });

  await ta('② 같은 값·빈 값은 변경 없음 → unchanged:true + UPDATE 0회', async () => {
    const { res, queries } = await callEdit(BASE_ORDER, {
      id: 'wo-1', purchase_time: '09:00 ~ 14:00', special_notes: '', title: '   ',
    });
    assert.strictEqual(res.body && res.body.unchanged, true, JSON.stringify(res.body));
    assert.ok(!queries.some(q => /UPDATE work_orders SET/.test(q.sql)), '무변경인데 UPDATE 실행됨');
  });

  await ta('② done 오더는 409 (intake 와 같은 규칙)', async () => {
    const { res } = await callEdit(Object.assign({}, BASE_ORDER, { status: 'done' }), { id: 'wo-1', title: '변경' });
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
  });

  await ta('② 삭제된 오더는 409', async () => {
    const { res } = await callEdit(Object.assign({}, BASE_ORDER, { deleted_at: '2026-08-01' }), { id: 'wo-1', title: '변경' });
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
  });

  await ta('② 수정 성공 시 memo_log 에 diff 요약이 남는다(수정 이력 = 인트라넷 알림과 같은 문장)', async () => {
    const { res, queries } = await callEdit(BASE_ORDER, { id: 'wo-1', purchase_time: '09:00 ~ 15:00' });
    assert.strictEqual(res.body.ok, true);
    const memoUpd = queries.find(q => /UPDATE work_orders SET memo_log/.test(q.sql));
    assert.ok(memoUpd, 'memo_log 기록 없음');
    const logged = JSON.parse(memoUpd.params[1]);
    assert.ok(/구매시간대: 09:00 ~ 14:00 → 09:00 ~ 15:00/.test(logged[logged.length - 1].memo), 'diff 문장 없음: ' + logged[logged.length - 1].memo);
    assert.strictEqual(logged[logged.length - 1].kind, 'admin_edit');
  });

  console.log('\n[4] 공유 모달 — 런타임 실행(XSS·diff 전송)');

  function makeStubDoc(log) {
    function el(tag) {
      const node = {
        tag, children: [], listeners: {}, style: { cssText: '' }, dataset: {},
        value: '', type: '', disabled: false, _text: '', _html: '',
        set textContent(v) { node._text = String(v); },
        get textContent() { return node._text; },
        set innerHTML(v) { node._html = String(v); log.htmlSets.push(String(v)); },
        get innerHTML() { return node._html; },
        appendChild(c) { node.children.push(c); return c; },
        addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
        remove() { node.removed = true; },
      };
      log.created.push(node);
      return node;
    }
    return { getElementById: () => null, createElement: t2 => el(t2), body: { appendChild(n) { log.mounted = n; } } };
  }

  function runModal(order, opts, log) {
    const sandbox = { window: {}, console, document: makeStubDoc(log), alert: m => log.alerts.push(m), confirm: () => true, Promise };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(wodSrc, sandbox);
    assert.strictEqual(typeof sandbox.woAdminEditModal, 'function', 'woAdminEditModal 전역 공개 안 됨');
    sandbox.woAdminEditModal(order, opts);
    return sandbox;
  }

  const EVIL = '"><img src=x onerror=alert(1)>\'),alert(2),(\'';

  await ta('④ 악성 오더 값이 innerHTML 로 보간되지 않는다(.value/textContent 만)', async () => {
    const log = { created: [], htmlSets: [], alerts: [], mounted: null };
    runModal({ id: 'wo-1', title: EVIL, purchase_time: EVIL, special_notes: EVIL, status: 'reviewing' }, { save: async () => ({ ok: true }) }, log);
    const leaked = log.htmlSets.filter(h => h.includes('onerror') || h.includes('alert(2)'));
    assert.strictEqual(leaked.length, 0, '오더 값이 innerHTML 에 보간됨: ' + leaked[0]);
    const titleInput = log.created.find(n => n.tag === 'input' && n.value === EVIL);
    assert.ok(titleInput, '값이 .value 로 주입되지 않음');
  });

  await ta('④ 바뀐 필드만 save 로 전송(첫 입력=작업명 변경 시 title 만)', async () => {
    const log = { created: [], htmlSets: [], alerts: [], mounted: null };
    let sent = null;
    runModal({ id: 'wo-1', title: '원래 제목', purchase_time: '09:00', status: 'reviewing' },
      { save: async f => { sent = f; return { ok: true }; } }, log);
    const firstInput = log.created.find(n => n.tag === 'input');
    assert.strictEqual(firstInput.value, '원래 제목');
    firstInput.value = '고친 제목';
    const saveBtn = log.created.filter(n => n.tag === 'button' && n._text === '저장').pop();
    assert.ok(saveBtn, '저장 버튼 없음');
    await Promise.all(saveBtn.listeners.click.map(fn => fn({})));
    await new Promise(r => setImmediate(r));
    assert.ok(sent, 'save 미호출');
    assert.deepStrictEqual(Object.keys(sent), ['title'], '바뀐 필드만 전송 아님: ' + JSON.stringify(sent));
    assert.strictEqual(sent.title, '고친 제목');
  });

  await ta('④ 무변경이면 save 를 부르지 않는다', async () => {
    const log = { created: [], htmlSets: [], alerts: [], mounted: null };
    let called = 0;
    runModal({ id: 'wo-1', title: '제목', status: 'reviewing' }, { save: async () => { called++; return { ok: true }; } }, log);
    const saveBtn = log.created.filter(n => n.tag === 'button' && n._text === '저장').pop();
    await Promise.all(saveBtn.listeners.click.map(fn => fn({})));
    await new Promise(r => setImmediate(r));
    assert.strictEqual(called, 0, '무변경인데 save 호출됨');
    assert.ok(log.alerts.some(m => /변경된 내용이 없습니다/.test(m)), '무변경 안내 없음');
  });

  console.log('\n[5] 호스트 배선');

  t('⑤ 모달 정의는 공유 모듈 한 곳뿐(사본 금지)', () => {
    assert.strictEqual((wodSrc.match(/function woAdminEditModal/g) || []).length, 1);
    assert.ok(!/function woAdminEditModal/.test(appSrc), 'index-app.js 에 사본');
    assert.ok(!/function woAdminEditModal/.test(wdSrc), 'workdesk.html 에 사본');
  });

  t('⑤ admin: woAdminEdit → orderAdminEdit + 목록 재조회', () => {
    assert.ok(/action: "orderAdminEdit", id, \.\.\.fields/.test(appSrc), 'orderAdminEdit 저장 경로 없음');
    assert.ok(/woAdminEdit\('\$\{o\.id\}'\)/.test(appSrc), '관리자 수정 버튼 없음');
    assert.ok(/'orderAdminEdit':\s*\{ method: 'PUT',\s*path: '\/api\/order\/admin\/edit' \}/.test(apiSrc), 'api.js 매핑 없음');
  });

  t('⑤ workdesk: _woAdminEdit → /api/trackb/work-orders/edit + 버튼은 _woEditActions 안(허용명단 게이트 상속)', () => {
    assert.ok(/api\('\/api\/trackb\/work-orders\/edit',\{method:'PUT'/.test(wdSrc), 'trackb 저장 경로 없음');
    const fnBody = wdSrc.match(/function _woEditActions\(o\)\{[\s\S]*?\n\}/);
    assert.ok(fnBody && /_woAdminEdit\('\$\{id\}'\)/.test(fnBody[0]), '버튼이 _woEditActions 밖에 있음');
  });

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
