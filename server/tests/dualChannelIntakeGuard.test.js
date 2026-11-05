'use strict';

// 실제 처리기를 호출하되 DB는 메모리 대역으로 바꾼다. 실제 접속·발송은 하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ORDER_INTAKE_KEY = 'dual-channel-local-test';
process.env.JWT_SECRET = 'dual-channel-local-jwt';
const pool = require('../src/db/pool');
const router = require('../src/routes/order.routes');

const originalQuery = pool.query;
const originalConnect = pool.connect;
test.after(() => { pool.query = originalQuery; pool.connect = originalConnect; });

const products = () => JSON.stringify([{
  name: '가짜 동시진행 상품', product_mode: 'none', options: [],
  base: { pay: 19000, count: 3, daily: 1 },
  channels: {
    naver: { url: 'https://shop.example/naver', pay: 9000, inflow_type: 'link' },
    coupang: { url: 'https://shop.example/coupang', pay: 10000, inflow_type: 'link' },
  },
}]);
const current = { id: 'wo-dual-local', title: '가짜 오더', status: 'submitted', deleted_at: null,
  product_options_json: '', linked_campaign_id: '', linked_tab_gid: '', source_review_order_id: '',
  recruit_count: 3, daily_count: 1, pay_amount: 57000, memo_log: '[]' };

function route(method, path) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, '실제 처리기 경로가 있어야 한다: ' + path);
  return layer.route.stack.at(-1).handle;
}
const intake = route('post', '/intake');
const revision = route('put', '/intake/source/:sourceReviewOrderId');
const legacyEdit = route('put', '/intake/:id');
const adminEdit = router.handlers.orderAdminEdit;
const source = { source_system: 'inadd_intranet', source_review_order_id: 'ro_dual_local',
  source_revision: 1, idempotency_key: 'ro_dual_local:1:test' };

async function call(handler, body) {
  const writes = [];
  pool.query = async (sql) => {
    const s = String(sql);
    // 런타임 스키마 보강도 실제 DB에서는 실행하지 않는다.
    if (/^\s*(CREATE|ALTER)\b/i.test(s)) return { rows: [] };
    if (/\b(INSERT\s+INTO|UPDATE\s+work_orders|DELETE\s+FROM)\b/i.test(s)) {
      writes.push(s);
      throw new Error('동시진행 거부 전에 업무 데이터를 쓰려고 했습니다');
    }
    if (/SELECT[\s\S]*FROM work_orders/i.test(s)) return { rows: [{ ...current }] };
    return { rows: [] };
  };
  pool.connect = async () => { throw new Error('차단 대상 요청이 쓰기 연결을 열면 안 됩니다'); };
  const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
  let thrown;
  await handler({ body: { title: '가짜 오더', product_options_json: products(), ...body },
    params: { id: current.id, sourceReviewOrderId: source.source_review_order_id }, query: {},
    headers: { 'x-intake-key': process.env.ORDER_INTAKE_KEY }, admin: { name: '로컬 검사', role: 'admin' } },
  res, e => { thrown = e; });
  if (thrown) throw thrown;
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'dual_channel_not_ready');
  assert.equal(writes.length, 0, '상품 설정이 일반 오더로 축소 저장되면 안 된다');
}

test('원본 계약이 있는 신규 수신은 아직 지원하지 않는 설정을 저장하지 않는다', () => call(intake, source));
test('원본 번호를 가진 수정 수신도 준비중 차단을 따른다', () => call(revision, source));
test('출처 계약 없는 옛 신규 수신도 동시진행 설정을 우회 저장하지 못한다', () => call(intake, {}));
test('옛 작업오더 직접 수정도 동시진행 설정을 우회 저장하지 못한다', () => call(legacyEdit, {}));
test('직원 관리자 수정도 동시진행 설정을 우회 저장하지 못한다', () => call(adminEdit, { id: current.id }));
test('요청 본문의 true나 능력 표시만으로 준비중 차단을 해제하지 못한다', () => call(intake, {
  ...source, allowDualChannels: true, bidir: { dual_channel: 1 },
}));

test('외부가 위조한 내부 정규화 결과는 실제 INSERT 원문으로 사용하지 않는다', async () => {
  const forged = JSON.parse(products());
  forged[0].base.pay = 1;
  let inserted;
  pool.query = async (sql, params) => {
    if (/INSERT INTO work_orders/.test(String(sql))) {
      inserted = params[4];
      return { rows: [{ ...current, product_options_json: inserted }] };
    }
    return { rows: [] };
  };
  const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
  let thrown;
  await intake({ body: { title: '정상 빈 상품 원문', product_options_json: '[]',
    _normalized_product_options_json: JSON.stringify(forged) },
  headers: { 'x-intake-key': process.env.ORDER_INTAKE_KEY } }, res, e => { thrown = e; });
  if (thrown) throw thrown;
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(inserted, '[]', '본문의 숨은 값이 정식 상품 원문보다 앞서면 안 된다');
  assert.equal(res.body.data.product_options_json, '[]');
});
