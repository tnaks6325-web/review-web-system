'use strict';
/**
 * 회귀가드 — 원본 수정 잠금 정보 전달 + 모집공고 썸네일 (사용자 확정 2026-09-21)
 *
 * 실행: node tests/sourceEditLockContract.test.js
 *
 * ★★ 배경: 인트라넷은 그 오더가 잠겼는지 **알 길이 없어** 저장해 보고 409 를 받아야 했다
 *   (목록 SELECT 에 `advertiser_id`·`deleted_at` 이 없었다). 판정을 인트라넷이 따라 만들면
 *   규칙이 두 벌이 되므로, 리뷰웹이 **판정 결과를 그대로 내려준다**.
 *
 * ★ 이 가드가 지키는 것:
 *   ① 잠금 판정은 **함수 하나**(`isSourceEditLocked`) — 라우트도 목록도 그것을 쓴다
 *   ② 목록·상세 응답이 판정 결과를 싣는다(둘이 갈리면 화면이 창을 열 때와 목록에서 다른 잠금을 본다)
 *   ③ 잠기지 않은 오더는 `source_editable` 이 null — "전부 가능" 과 구분된다
 *   ④ 썸네일: 우리 프록시 절대 URL만 · 빈 값이면 공고를 안 건드린다 · 접수 뒤에도 고칠 수 있다
 *   ⑤ INSERT 컬럼 수 ≡ 자리 수 ≡ 파라미터 수(칸을 중간에 더할 때 가장 흔히 깨지는 자리)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ORDER_INTAKE_KEY = 'test-intake-key';

const pool = require(path.join(ROOT, 'src/db/pool.js'));
const orderRouter = require(path.join(ROOT, 'src/routes/order.routes.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'src/routes/order.routes.js'), 'utf8');
const SYNC = fs.readFileSync(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'), 'utf8');
const BOOT = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

const route = (p, m) => {
  const l = (orderRouter.stack || []).find(x => x.route && x.route.path === p && x.route.methods[m]);
  assert.ok(l, `${m.toUpperCase()} ${p} 라우트 없음`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const listHandler = route('/intake/list', 'get');
const detailHandler = route('/intake/:id', 'get');

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}
async function call(handler, rows, req = {}) {
  pool.query = async () => ({ rows });
  const res = makeRes();
  await handler(Object.assign({ headers: { 'x-intake-key': 'test-intake-key' }, query: {}, params: {} }, req),
    res, e => { throw e; });
  return res;
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

const OPEN = { id: 'wo_1', title: 'T', status: 'submitted', linked_campaign_id: null, advertiser_id: null, deleted_at: null };
const LOCKED = Object.assign({}, OPEN, { id: 'wo_2', advertiser_id: 'adv_1' });

async function run() {
  console.log('\n원본 수정 잠금 정보 전달 + 공고 썸네일');

  await t('① 잠금 판정은 함수 하나 — 라우트가 그것을 쓴다(사본 0)', () => {
    assert.match(SRC, /function isSourceEditLocked\(order\)/, '판정 함수가 없다');
    assert.match(SRC, /const sourceEditLocked = isSourceEditLocked\(current\)/,
      '라우트가 인라인 식을 따로 쓴다 — 목록과 갈린다');
    const body = SRC.slice(SRC.indexOf('function isSourceEditLocked'), SRC.indexOf('\n}', SRC.indexOf('function isSourceEditLocked')));
    ['deleted_at', "=== 'done'", "=== 'published'", 'linked_campaign_id', 'advertiser_id'].forEach(w =>
      assert.ok(body.includes(w), '판정 조건이 빠졌다: ' + w));
  });

  await t('② 목록이 판정 재료와 결과를 함께 싣는다', async () => {
    assert.match(SRC, /advertiser_id, deleted_at/, '목록 SELECT 에 판정 재료가 없다');
    const res = await call(listHandler, [Object.assign({}, OPEN), Object.assign({}, LOCKED)]);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const [open, locked] = res.body.data;
    assert.strictEqual(open.source_edit_locked, false, '안 잠긴 오더를 잠겼다고 한다');
    assert.strictEqual(locked.source_edit_locked, true, '접수된 오더를 안 잠겼다고 한다');
  });

  await t('② 상세도 같은 판정을 싣는다(목록과 갈리면 안 된다)', async () => {
    const res = await call(detailHandler, [Object.assign({}, LOCKED)], { params: { id: 'wo_2' } });
    assert.strictEqual(res.body.data.source_edit_locked, true, JSON.stringify(res.body));
    assert.ok(res.body.data.source_editable, '고칠 수 있는 칸 목록이 없다');
  });

  await t('③ 잠기지 않은 오더는 목록이 null — "전부 가능" 과 구분된다', async () => {
    const res = await call(listHandler, [Object.assign({}, OPEN)]);
    assert.strictEqual(res.body.data[0].source_editable, null,
      '안 잠긴 오더에 목록을 실으면 화면이 나머지를 잠근다');
  });

  await t('③ 고칠 수 있는 칸 목록은 서버 허용 목록 그대로다', async () => {
    const res = await call(listHandler, [Object.assign({}, LOCKED)]);
    const ed = res.body.data[0].source_editable;
    ['title', 'manager_name', 'product_url', 'inflow_keyword', 'inflow_guide',
      'guide_images', 'review_guide', 'special_notes', 'pay_amount', 'thumbnail_url'].forEach(f =>
      assert.ok(ed.fields.includes(f), '허용 칸이 빠졌다: ' + f));
    assert.deepStrictEqual(ed.productOptionKeys.slice().sort(), ['guide', 'pay', 'url'],
      '상품 구성에서 고칠 수 있는 키가 달라졌다');
    // 잠긴 칸이 섞이면 화면이 그 칸을 열어 준다 → 저장해야 막히는 막다른 길
    ['recruit_count', 'daily_count', 'start_date', 'purchase_channel', 'review_type',
      'delivery_type', 'work_kind', 'review_fee', 'work_sheet_url'].forEach(f =>
      assert.ok(!ed.fields.includes(f), '잠겨야 하는 칸이 허용 목록에 있다: ' + f));
  });

  await t('④ 썸네일은 우리 프록시 절대 URL만 통과한다', () => {
    const m = SRC.match(/function _thumbnailUrl[\s\S]*?\n}/);
    assert.ok(m, '_thumbnailUrl 이 없다');
    // eslint-disable-next-line no-eval
    const f = eval('(' + m[0].replace(/^function /, 'function ') + ')');
    assert.strictEqual(f('https://api.x.com/api/order/guide-image/1AbCdEfGhIjKl'),
      'https://api.x.com/api/order/guide-image/1AbCdEfGhIjKl');
    ['https://evil.com/x.jpg', 'https://drive.google.com/file/d/abc/view', 'javascript:alert(1)', '', null]
      .forEach(v => assert.strictEqual(f(v), '', '형식 밖 값을 통과시켰다: ' + v));
  });

  await t('④ 썸네일은 접수 뒤에도 고칠 수 있다(표·정원과 무관)', () => {
    const line = SRC.match(/const SOURCE_EDIT_AFTER_ACCEPT = \[([\s\S]*?)\];/);
    assert.ok(line && line[1].includes('thumbnail_url'), '허용 목록에 없다');
    assert.match(SRC, /\.\.\.\(b\.thumbnail_url === undefined \? \{\} : \{ thumbnail_url:/,
      '미전송 예외가 없다 — 구버전 인트라넷의 계약 매칭이 막힌다');
  });

  await t('④ 빈 값이면 공고 썸네일을 건드리지 않는다(blank-only)', async () => {
    const svc = require(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'));
    let connected = false;
    svc.__setPoolForTest({ connect: async () => { connected = true; throw new Error('연결하면 안 된다'); } });
    const out = await svc.syncCampaignThumbnail({ workOrderId: 'wo_1', thumbnailUrl: '' });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'empty');
    assert.strictEqual(connected, false, '빈 값인데 DB 를 열었다');
  });

  await t('④ 썸네일 전파는 그 칸 하나만 쓰고 throw 하지 않는다', async () => {
    const svc = require(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'));
    const q = [];
    svc.__setPoolForTest({ connect: async () => ({
      query: async (sql) => {
        const s = String(sql); q.push(s);
        if (/FROM work_orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: 'wo_1', linked_campaign_id: 'c1' }] };
        if (/FROM recruit_campaigns\s+WHERE \(id = \$1/.test(s)) return { rows: [{ id: 'c1' }] };
        return { rows: [], rowCount: 1 };
      }, release: () => {},
    }) });
    const out = await svc.syncCampaignThumbnail({ workOrderId: 'wo_1', thumbnailUrl: 'https://x/api/order/guide-image/abcdefghijkl' });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    const writes = q.filter(s => /^\s*UPDATE|INSERT|DELETE/i.test(s));
    assert.strictEqual(writes.length, 1, '쓰기가 여러 번이다');
    assert.match(writes[0], /UPDATE recruit_campaigns SET thumbnail_url/, '다른 칸을 건드린다');
    // 실패해도 throw 하지 않는다
    svc.__setPoolForTest({ connect: async () => { throw new Error('boom'); } });
    const out2 = await svc.syncCampaignThumbnail({ workOrderId: 'wo_1', thumbnailUrl: 'https://x/api/order/guide-image/abcdefghijkl' });
    assert.strictEqual(out2.applied, false);
    assert.strictEqual(out2.reason, 'db_unavailable');
  });

  await t('⑤ INSERT 컬럼 수 ≡ 자리 수 ≡ 파라미터 수', () => {
    const m = SRC.match(/INSERT INTO work_orders\s*\(([\s\S]*?)\)\s*VALUES \(([^)]*)\)/);
    assert.ok(m, 'INSERT 를 못 찾았다');
    const cols = m[1].split(',').map(x => x.trim()).filter(Boolean);
    const vals = m[2].split(',').map(x => x.trim()).filter(Boolean);
    assert.strictEqual(cols.length, vals.length, `컬럼 ${cols.length} ≠ 자리 ${vals.length}`);
    const nums = vals.filter(v => v.startsWith('$')).map(v => Number(v.slice(1)));
    assert.strictEqual(Math.max(...nums), nums.length, '파라미터 번호가 건너뛴다');
    assert.ok(cols.includes('thumbnail_url'), '썸네일 칸이 INSERT 에 없다');
  });

  await t('⑤ 실제로 접수해 보면 파라미터 수가 자리 수와 맞는다(정적 계수로는 못 잡는다)', async () => {
    const insert = route('/intake', 'post');
    let seen = null;
    pool.query = async (sql, params) => {
      const t2 = String(sql);
      if (/INSERT INTO work_orders/.test(t2)) { seen = { sql: t2, params }; return { rows: [{ id: 'wo_new' }] }; }
      return { rows: [] };
    };
    const res = makeRes();
    await insert({
      headers: { 'x-intake-key': 'test-intake-key' },
      body: {
        intakeKey: 'test-intake-key', title: 'T', source_review_order_id: 'ro_n', source_revision: 1,
        idempotency_key: 'ro_n:1', requester_name: 'AE', sales_id: 's', contract_number: 'c', quote_id: 'q',
        intranet_advertiser_id: 'adv', intranet_advertiser_name: 'N',
        thumbnail_url: 'https://x/api/order/guide-image/abcdefghijkl',
      },
      query: {}, params: {},
    }, res, e => { throw e; });
    assert.ok(seen, '접수가 INSERT 까지 가지 못했다: ' + JSON.stringify(res.body));
    const nums = (seen.sql.match(/\$\d+/g) || []).map(v => Number(v.slice(1)));
    assert.strictEqual(seen.params.length, Math.max(...nums),
      `파라미터 ${seen.params.length}개인데 자리는 ${Math.max(...nums)}개 — 접수가 통째로 죽는다`);
    assert.ok(seen.params.includes('https://x/api/order/guide-image/abcdefghijkl'),
      '썸네일 값이 INSERT 에 실리지 않았다');
  });

  await t('⑤ 부팅 프리플라이트에 등록됐다(없으면 접수가 전면 42703)', () => {
    assert.match(BOOT, /\['work_orders', 'thumbnail_url'\]/, '프리플라이트에 없다');
  });

  await t('⑤ 마이그레이션은 컬럼 추가만(백필·CHECK 0)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'migrations/163_work_order_thumbnail.sql'), 'utf8');
    const sql = raw.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS thumbnail_url TEXT/, '컬럼 추가문이 없다');
    [/\bUPDATE\s+\w/i, /\bCHECK\s*\(/i, /\bREFERENCES\b/i, /\bDELETE\s+FROM\b/i, /\bNOT\s+NULL\b/i]
      .forEach(re => assert.ok(!re.test(sql), '배포 즉시 동작이 바뀐다: ' + re));
  });

  console.log(`\nsourceEditLockContract: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
