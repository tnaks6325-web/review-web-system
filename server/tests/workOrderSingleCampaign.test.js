/**
 * 결정 246 — 작업오더 하나에 살아 있는 모집공고는 하나 + 수정요청 창 세션 맞춤.
 *
 * 사고(2026-10-13): 두 담당자가 같은 오더 화면을 열어 둔 채 1분 사이에 둘 다 [공고 만들기] →
 *   같은 작업표를 가리키는 공고 두 장(게시 1 · 임시저장 1). 화면의 버튼 숨김은 열어 둔 옛 화면을 못 막는다.
 * 사고(2026-10-14): 리뷰 내역은 A 로 보이는데 수정요청 창은 다른 탭에서 바뀐 공용 세션(B)으로
 *   서버를 불러 "로그인한 리뷰어의 제출 내역만 조회할 수 있습니다"(403).
 *
 * 실행: node tests/workOrderSingleCampaign.test.js
 *   (선택) 동시 생성 실검증: PGTEST_URL=postgres://... node tests/workOrderSingleCampaign.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); passed++; console.log('  ✓ ' + name); };

/* ── 스텁 pool — 생성 라우트를 실제로 실행한다 ── */
const _poolPath = require.resolve('../src/db/pool');
let calls = [];          // [{via:'pool'|'client', sql}]
let existing = [];       // 같은 오더로 이미 있는 공고
let released = 0;
const answer = (sql) => {
  if (/FROM recruit_campaigns\s+WHERE source_work_order_id = \$1 AND archived_at IS NULL/.test(sql)) return { rows: existing };
  if (/INSERT INTO recruit_campaigns/.test(sql)) return { rows: [{ id: 'camp_new', status: 'draft', recruit_total: 60, linked_sheet_id: '', linked_tab_name: '' }] };
  return { rows: [] };
};
const client = {
  query: async (sql) => { calls.push({ via: 'client', sql: String(sql) }); return answer(String(sql)); },
  release: () => { released++; calls.push({ via: 'release', sql: '' }); },
};
require.cache[_poolPath] = {
  id: _poolPath, filename: _poolPath, loaded: true,
  exports: {
    query: async (sql) => { calls.push({ via: 'pool', sql: String(sql) }); return answer(String(sql)); },
    connect: async () => client,
  },
};

const router = require('../src/routes/campaign.routes');
const layer = router.stack.find(l => l.route && l.route.path === '/admin/create' && l.route.methods.post);
assert(layer, '생성 라우트를 찾지 못함');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

function run(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    // 생성 뒤의 후속 단계(정원 동기화 등)는 스텁이 끝까지 못 간다 — 저장 단계까지만 본다.
    handler({ body, admin: { name: '테스트', role: 'admin' }, query: {}, params: {} }, res, (err) => resolve({ status: 'next', err }));
  });
}
const base = { title: '10/14 테스트 공고', status: 'draft' };

(async () => {
  console.log('\n[A] 같은 오더로 살아 있는 공고가 있으면 만들지 않는다');
  calls = []; released = 0; existing = [{ id: 'camp_old', title: '먼저 만든 공고' }];
  const r1 = await run({ ...base, source_work_order_id: 'wo_1' });
  ok('409 + 이유 코드', r1.status === 409 && r1.body && r1.body.code === 'WORK_ORDER_CAMPAIGN_EXISTS', r1);
  ok('기존 공고 이름을 알려 준다(어느 걸 고치면 되는지)', /먼저 만든 공고/.test(r1.body.error) && r1.body.campaignId === 'camp_old');
  ok('★ 저장하지 않는다', !calls.some(c => /INSERT INTO recruit_campaigns/.test(c.sql)));
  ok('같은 오더끼리 잠금을 잡고 확인한다', calls.some(c => c.via === 'client' && /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(c.sql)));
  ok('되돌리고 연결을 반납한다', calls.some(c => c.sql === 'ROLLBACK') && released === 1 && calls[calls.length - 1].via === 'release');

  console.log('\n[B] 없으면 같은 잠금 안에서 저장한다');
  calls = []; released = 0; existing = [];
  await run({ ...base, source_work_order_id: 'wo_1' });
  const iLock = calls.findIndex(c => /pg_advisory_xact_lock/.test(c.sql));
  const iChk = calls.findIndex(c => /WHERE source_work_order_id = \$1 AND archived_at IS NULL/.test(c.sql));
  const iIns = calls.findIndex(c => /INSERT INTO recruit_campaigns/.test(c.sql));
  const iCommit = calls.findIndex(c => c.sql === 'COMMIT');
  ok('★ 잠금 → 확인 → 저장 → 커밋 순서', iLock > -1 && iLock < iChk && iChk < iIns && iIns < iCommit, { iLock, iChk, iIns, iCommit });
  ok('★ 저장은 잠금을 쥔 같은 연결에서', calls[iIns].via === 'client');
  ok('커밋 직후 연결 반납(뒤 단계까지 쥐고 있지 않는다)', calls[iCommit + 1] && calls[iCommit + 1].via === 'release');

  console.log('\n[C] 오더 없이 만드는 공고는 종전 그대로');
  calls = []; released = 0; existing = [{ id: 'camp_old', title: 'x' }];
  await run({ ...base });
  ok('잠금·확인 없음', !calls.some(c => /pg_advisory_xact_lock|archived_at IS NULL/.test(c.sql)));
  const iInsC = calls.findIndex(c => /INSERT INTO recruit_campaigns/.test(c.sql));
  ok('저장은 기존처럼 pool 로(저장 전에 연결을 따로 잡지 않는다)', iInsC > -1 && calls[iInsC].via === 'pool'
    && !calls.slice(0, iInsC).some(c => c.via !== 'pool'));

  console.log('\n[D] 보관된 공고는 세지 않는다(다시 모집할 길을 막지 않음)');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'utf8');
  ok('확인 조건에 archived_at IS NULL', /WHERE source_work_order_id = \$1 AND archived_at IS NULL/.test(src));

  console.log('\n[E] 수정요청 창 — 부르기 직전에 이 탭의 리뷰어로 세션을 맞춘다');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  const fnSrc = (name) => {
    const i = html.indexOf('async function ' + name + '(');
    assert(i > -1, name + ' 없음');
    let depth = 0, j = html.indexOf('{', i);
    for (let k = j; k < html.length; k++) { if (html[k] === '{') depth++; else if (html[k] === '}' && --depth === 0) return html.slice(i, k + 1); }
    throw new Error('본문 끝 못 찾음');
  };
  const open = fnSrc('openReviewEditModal');
  const load = fnSrc('_reEditLoadFiles');
  ok('창을 열 때 맞춘 리뷰어로 phone8 을 정한다', /const user = await _reEditSyncSession\(\);/.test(open));
  ok('★ 서버 호출 직전에 다시 맞춘다(창을 연 뒤 다른 탭 로그인 대비)',
    load.indexOf('await _reEditSyncSession()') > -1 && load.indexOf('await _reEditSyncSession()') < load.indexOf("action:'reviewEditMyFiles'"));

  // 실행 — 공용 세션이 다른 사람(B)이어도 맞춘 뒤엔 화면의 리뷰어(A) 토큰이 된다.
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = { localStorage: store(), sessionStorage: store(), JSON, Date, Number, String, atob: (s) => Buffer.from(s, 'base64').toString('binary') };
  const futureTok = (sub) => 'h.' + Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64') + '.s';
  ctx.localStorage.setItem('iad_reviewer_user', JSON.stringify({ name: 'A', phone8: '11110063', reviewerToken: futureTok('A') }));
  ctx.localStorage.setItem('rapp_reviewer_auth', JSON.stringify({ name: 'B', phone8: '22229999', reviewerToken: futureTok('B') }));
  vm.createContext(ctx);
  vm.runInContext(`const USER_KEY="iad_reviewer_user"; const HOME_SESSION_KEY="iad_reviewer_home_session";
    function _prepareReviewerLocalSession(){ sessionStorage.removeItem("rapp_reviewer_auth"); sessionStorage.removeItem(HOME_SESSION_KEY); }
    let refreshed = 0; async function _refreshReviewerHomeSession(u){ refreshed++; return null; }`, ctx);
  for (const name of ['getSavedUser', '_reviewerTokenFresh', 'syncSearchSession']) {
    const i = html.indexOf('function ' + name + '(');
    let depth = 0, j = html.indexOf('{', i), body;
    for (let k = j; k < html.length; k++) { if (html[k] === '{') depth++; else if (html[k] === '}' && --depth === 0) { body = html.slice(i, k + 1); break; } }
    vm.runInContext(body, ctx);
  }
  vm.runInContext(fnSrc('_reEditSyncSession'), ctx);
  const u = await vm.runInContext('_reEditSyncSession()', ctx);
  const auth = JSON.parse(ctx.localStorage.getItem('rapp_reviewer_auth'));
  ok('★ 공용 세션이 화면의 리뷰어(A)로 바뀐다', auth.phone8 === '11110063' && auth.reviewerToken === futureTok('A'), auth);
  ok('돌려준 리뷰어도 A', u && u.phone8 === '11110063');
  ok('유효한 토큰이면 새로 발급받지 않는다', vm.runInContext('refreshed', ctx) === 0);

  console.log(`\nworkOrderSingleCampaign: ${passed} passed`);

  /* ── (선택) 진짜 PG — 같은 오더 동시 생성 두 건 중 하나만 들어간다 ── */
  if (process.env.PGTEST_URL) {
    const { Pool } = require('pg');
    const pg = new Pool({ connectionString: process.env.PGTEST_URL });
    const tbl = 'wo_single_campaign_probe';
    await pg.query(`DROP TABLE IF EXISTS ${tbl}; CREATE TABLE ${tbl} (id text primary key, source_work_order_id text, archived_at timestamptz, created_at timestamptz default now())`);
    const attempt = async (id) => {
      const c = await pg.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['recruit_campaign_wo:wo_race']);
        const { rows } = await c.query(`SELECT id FROM ${tbl} WHERE source_work_order_id = $1 AND archived_at IS NULL LIMIT 1`, ['wo_race']);
        if (rows.length) { await c.query('ROLLBACK'); return 'blocked'; }
        await new Promise(r => setTimeout(r, 150));   // 확인과 저장 사이를 벌려 경합을 키운다
        await c.query(`INSERT INTO ${tbl} (id, source_work_order_id) VALUES ($1, 'wo_race')`, [id]);
        await c.query('COMMIT'); return 'inserted';
      } finally { c.release(); }
    };
    const out = await Promise.all([attempt('a'), attempt('b'), attempt('c')]);
    const { rows } = await pg.query(`SELECT count(*)::int n FROM ${tbl}`);
    await pg.query(`DROP TABLE ${tbl}`); await pg.end();
    assert.strictEqual(rows[0].n, 1, '동시 생성 3건 중 1건만 저장돼야 함: ' + JSON.stringify(out));
    console.log('  ✓ [PG] 동시 생성 3건 → 1건 저장 · 2건 거절', JSON.stringify(out));
  }
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
