/**
 * campaignOptionRename.test.js — 선택지 이름 바꾸기(rename) 회귀가드 (2026-10-02 사용자 확정)
 * 실행: node tests/campaignOptionRename.test.js
 *
 * 사고: 모집공고에서 상품명(=선택지 이름)만 바꿨는데 옛 이름이 리뷰어 화면에 '마감'으로 남고,
 *       새 이름은 0명부터 다시 세어 정원보다 많이 모집될 수 있었다.
 * 고정: ① 화면이 원래 이름(prevOptKey)을 보낸다 ② 서버가 선택지·참여 기록의 이름을 함께 바꾼다
 *       ③ 주문 기록(selected_opt_key)은 건드리지 않는다(사용자 확정 (나)) ④ 애매하면 바꾸지 않는다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const routes = read('src/routes/campaign.routes.js');
const front = read('../frontend/js/index-recruit.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 서버 함수 추출 실행 ──
const start = routes.indexOf('function _planOptionRenames');
const end = routes.indexOf('async function _saveCampaignOptions');
assert(start > 0 && end > start, 'rename 함수 위치');
const sandbox = { logger: { info() {} }, Date };
vm.createContext(sandbox);
vm.runInContext(routes.slice(start, end) + '\nthis._plan=_planOptionRenames;this._apply=_applyOptionRenames;', sandbox);
const plan = (cur, opts) => sandbox._plan(cur, opts, new Set(opts.map(o => o.optKey)));

ok('단순 이름 변경 → 계획 1건', JSON.stringify(plan(['A', 'B'], [{ optKey: 'A2', prevOptKey: 'A' }, { optKey: 'B', prevOptKey: 'B' }])) === JSON.stringify([{ from: 'A', to: 'A2' }]));
ok('원래 이름 없으면 무동작(종전 동작)', plan(['A'], [{ optKey: 'A2', prevOptKey: '' }]).length === 0);
ok('원장에 없는 옛 이름은 무시', plan(['A'], [{ optKey: 'X2', prevOptKey: 'X' }]).length === 0);
ok('옛 이름이 이번 목록에도 남아 있으면 바꾸지 않음', plan(['A'], [{ optKey: 'A', prevOptKey: '' }, { optKey: 'A2', prevOptKey: 'A' }]).length === 0);
ok('같은 옛 이름을 두 줄이 주장하면 바꾸지 않음', plan(['A'], [{ optKey: 'A2', prevOptKey: 'A' }, { optKey: 'A3', prevOptKey: 'A' }]).length === 0);
ok('새 이름이 이미 살아 있는 다른 선택지면 바꾸지 않음', plan(['A', 'B'], [{ optKey: 'B', prevOptKey: 'A' }]).length === 0);
ok('맞바꾸기(A↔B)는 허용', plan(['A', 'B'], [{ optKey: 'B', prevOptKey: 'A' }, { optKey: 'A', prevOptKey: 'B' }]).length === 2);

(async () => {
  const calls = [];
  const client = { query: async (sql, p) => { calls.push({ sql, p }); return /^SELECT/.test(sql) ? { rows: [{ opt_key: 'A' }, { opt_key: 'B' }] } : { rowCount: 1 }; } };
  const opts = [{ optKey: 'B', prevOptKey: 'A' }, { optKey: 'A', prevOptKey: 'B' }];
  const done = await sandbox._apply(client, 'c1', opts, new Set(['A', 'B']));
  ok('맞바꾸기 실행 = 임시 이름 경유 두 단계', done.length === 2 && calls.filter(c => /campaign_options SET opt_key/.test(c.sql)).length === 4);
  ok('참여 기록(option_key)도 함께 변경', calls.filter(c => /UPDATE campaign_applications SET option_key/.test(c.sql)).length === 4);
  ok('주문 기록(selected_opt_key)은 건드리지 않음', !calls.some(c => /order_submissions/.test(c.sql)));
  const final = calls.filter(c => /UPDATE campaign_options/.test(c.sql)).slice(-2).map(c => c.p[2]).sort();
  ok('최종 이름 = 새 이름', JSON.stringify(final) === JSON.stringify(['A', 'B']));
  const none = [];
  await sandbox._apply({ query: async (s) => { none.push(s); return { rows: [] }; } }, 'c1', [{ optKey: 'A', prevOptKey: '' }], new Set(['A']));
  ok('바꿀 것 없으면 조회조차 안 함', none.length === 0);

  // ── 배선 ──
  ok('정규화가 prevOptKey 를 받는다', /prevOptKey: _normOptKey\(obj\.prevOptKey \?\? obj\.prev_opt_key\)/.test(routes));
  const save = routes.slice(routes.indexOf('async function _saveCampaignOptions'));
  ok('저장이 잠금 뒤·upsert 앞에서 이름 바꾸기를 먼저 한다',
    save.indexOf('FOR UPDATE') < save.indexOf('_applyOptionRenames') && save.indexOf('_applyOptionRenames') < save.indexOf('INSERT INTO campaign_options'));
  ok('화면: 불러온 선택지에 원래 이름을 싣는다', /savedOptKey: key/.test(front) && /row\.dataset\.origKey = String\(d\.savedOptKey\)/.test(front));
  ok('화면: 저장 시 prevOptKey 전송', /prevOptKey:\s+String\(r\.dataset\.origKey \|\| ""\)/.test(front));

  // ── 갈라진 선택지 합치기(merge) 라우트 실제 실행 ──
  const poolPath = require.resolve('../src/db/pool');
  const q = [];
  let opts2 = [{ opt_key: 'OLD', status: 'closed' }, { opt_key: 'NEW', status: 'active' }];
  const db = {
    async connect() { return { query: db.query, release() {} }; },
    async query(sql, p) {
      q.push(String(sql));
      if (/FROM recruit_campaigns WHERE id=\$1 FOR UPDATE/.test(sql)) return { rows: [{ id: 'c1' }] };
      if (/SELECT opt_key, status FROM campaign_options/.test(sql)) return { rows: opts2 };
      if (/GROUP BY status/.test(sql)) return { rows: [{ status: 'submitted', n: 3 }] };
      return { rows: [], rowCount: 1 };
    },
  };
  require.cache[poolPath] = { exports: db };
  const router = require('../src/routes/campaign.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/admin/:id/options/merge' && l.route.methods.post);
  ok('merge 라우트 존재 + 관리자 게이트', !!layer && layer.route.stack.some(s => s.name === 'adminOrMasterMiddleware'));
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = (body) => new Promise((resolve, reject) => {
    const res = { _s: 200, status(c) { this._s = c; return this; }, json(b) { resolve({ s: this._s, b }); } };
    handler({ params: { id: 'c1' }, body, admin: { name: 't' } }, res, reject);
  });
  q.length = 0;
  let r = await call({ pairs: [{ from: 'OLD', to: 'NEW' }] });
  ok('미리보기: 쓰기 0 + ROLLBACK + 참여 수 보고', r.b.dryRun && !q.some(s => /^\s*(UPDATE|DELETE)/.test(s)) && q.includes('ROLLBACK') && r.b.merged[0].applications.submitted === 3);
  q.length = 0;
  r = await call({ pairs: [{ from: 'OLD', to: 'NEW' }], confirm: true });
  ok('실행: 참여 기록 이전 + 옛 행 삭제 + COMMIT', q.some(s => /UPDATE campaign_applications SET option_key/.test(s)) && q.some(s => /DELETE FROM campaign_options/.test(s)) && q.includes('COMMIT'));
  ok('실행: 주문 기록은 건드리지 않음', !q.some(s => /order_submissions/.test(s)));
  opts2 = [{ opt_key: 'OLD', status: 'active' }, { opt_key: 'NEW', status: 'active' }];
  q.length = 0;
  r = await call({ pairs: [{ from: 'OLD', to: 'NEW' }], confirm: true });
  ok('옛 선택지가 마감이 아니면 거부(쓰기 0)', r.s === 409 && !q.some(s => /^\s*(UPDATE|DELETE)/.test(s)));
  opts2 = [{ opt_key: 'OLD', status: 'closed' }];
  r = await call({ pairs: [{ from: 'OLD', to: 'NEW' }], confirm: true });
  ok('새 선택지가 없으면 거부', r.s === 409);

  console.log(`\ncampaignOptionRename: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
