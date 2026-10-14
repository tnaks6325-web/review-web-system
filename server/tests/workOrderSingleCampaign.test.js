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
  if (/FROM recruit_campaigns c\s+WHERE c\.archived_at IS NULL AND c\.id <> \$2/.test(sql)) return { rows: existing };
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
  const iChk = calls.findIndex(c => /FROM recruit_campaigns c\s+WHERE c\.archived_at IS NULL AND c\.id <> \$2/.test(c.sql));
  const iIns = calls.findIndex(c => /INSERT INTO recruit_campaigns/.test(c.sql));
  const iCommit = calls.findIndex(c => c.sql === 'COMMIT');
  ok('★ 잠금 → 확인 → 저장 → 커밋 순서', iLock > -1 && iLock < iChk && iChk < iIns && iIns < iCommit, { iLock, iChk, iIns, iCommit });
  ok('★ 저장은 잠금을 쥔 같은 연결에서', calls[iIns].via === 'client');
  ok('커밋 직후 연결 반납(뒤 단계까지 쥐고 있지 않는다)', calls[iCommit + 1] && calls[iCommit + 1].via === 'release');

  console.log('\n[C] 오더 없이 만드는 공고는 종전 그대로');
  calls = []; released = 0; existing = [{ id: 'camp_old', title: 'x' }];
  await run({ ...base });
  ok('잠금·확인 없음', !calls.some(c => /pg_advisory_xact_lock|c\.archived_at IS NULL AND c\.id <> \$2/.test(c.sql)));
  const iInsC = calls.findIndex(c => /INSERT INTO recruit_campaigns/.test(c.sql));
  ok('저장은 기존처럼 pool 로(저장 전에 연결을 따로 잡지 않는다)', iInsC > -1 && calls[iInsC].via === 'pool'
    && !calls.slice(0, iInsC).some(c => c.via !== 'pool'));

  console.log('\n[D] 짝짓기 — 정방향·역방향 둘 다, 보관된 공고는 세지 않는다');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'utf8');
  const lrqSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'linkedRecruitQuota.service.js'), 'utf8');
  const lrq = require('../src/services/linkedRecruitQuota.service');
  ok('★ 잠그고 확인한 정규화 값(_srcWoId)을 그대로 저장한다(Codex PR #1632)', /\n\s*_srcWoId,\s*\/\/ ★ 결정 246/.test(src)
    && !/\n\s*source_work_order_id \|\| '',\n/.test(src.slice(src.indexOf("router.post('/admin/create'"), src.indexOf("router.put('/admin/:id'"))));
  { const putSrc = src.slice(src.indexOf("router.put('/admin/:id', authMiddleware"), src.indexOf("router.delete('/admin/:id'"));
    ok('★ 수정(PUT)은 작업오더 연결을 바꾸지 않는다($31=null 유지 — Codex PR #1632)',
      /\n\s*null,\s*\/\/ \$31 ★ 결정 246/.test(putSrc) && !/source_work_order_id \?\? null/.test(putSrc)
      && /let woId = c0\.source_work_order_id \|\| '';/.test(putSrc)); }
  ok('생성은 단일 출처 잠금·확인을 쓴다', /_lrq\.lockWorkOrderCampaigns\(_insClient, \[_srcWoId\]\)/.test(src)
    && /_lrq\.liveCampaignForWorkOrders\(_insClient, \[_srcWoId\]\)/.test(src));
  const liveFn = lrqSrc.slice(lrqSrc.indexOf('async function liveCampaignForWorkOrders'), lrqSrc.indexOf('async function workOrderIdsForCampaign'));
  ok('★ 역방향 링크(work_orders.linked_campaign_id)까지 본다(LINKED_WO_ON — Codex PR #1632)', /\$\{LINKED_WO_ON\}/.test(liveFn)
    && /NULLIF\(c\.source_work_order_id, ''\) = ANY\(\$1::text\[\]\)/.test(liveFn));
  ok('보관된 공고는 세지 않는다(다시 모집할 길)', /c\.archived_at IS NULL/.test(liveFn));
  ok('잠금 키 한 곳', lrq.workOrderCampaignLockKey(' wo_1 ') === 'recruit_campaign_wo:wo_1');
  { const log = []; await lrq.lockWorkOrderCampaigns({ query: async (q, p) => { log.push(p[0]); return { rows: [] }; } }, ['wo_b', 'wo_a', 'wo_b', '']);
    ok('여러 오더는 정렬·중복 제거해 잠근다(교착 방지)', JSON.stringify(log) === JSON.stringify(['recruit_campaign_wo:wo_a', 'recruit_campaign_wo:wo_b']), log); }

  console.log('\n[D2] 보관 해제도 같은 검사·같은 잠금(생성 검사 우회 차단 — Codex PR #1632)');
  const arch = require('../src/services/campaignArchive.service');
  const mkDb = (woIds, live) => {
    const log = []; let rel = 0;
    const c = { query: async (sql) => { sql = String(sql); log.push(sql);
      if (/SELECT archived_at FROM recruit_campaigns WHERE id = \$1/.test(sql)) return { rows: [{ archived_at: '2026-10-01' }] };
      if (/UNION/.test(sql) && /source_work_order_id/.test(sql)) return { rows: woIds.map(id => ({ id })) };
      if (/c\.archived_at IS NULL AND c\.id <> \$2/.test(sql)) return { rows: live };
      if (/UPDATE recruit_campaigns SET archived_at = NULL/.test(sql)) return { rows: [{ id: 'c_old' }] };
      return { rows: [] }; }, release: () => { rel++; } };
    return { db: { connect: async () => c }, log, rel: () => rel };
  };
  let d = mkDb(['wo_1'], [{ id: 'c_new', title: '새 공고' }]);
  let out = await arch.unarchiveCampaign(d.db, 'c_old');
  ok('★ 같은 오더에 살아 있는 공고가 있으면 해제 거절(이름 안내)', out.ok === false && out.code === 'work_order_campaign_exists' && /새 공고/.test(out.error), out);
  ok('★ 해제 UPDATE 를 하지 않는다', !d.log.some(q => /SET archived_at = NULL/.test(q)));
  ok('잠금 → 확인 순서 · 되돌림 · 반납', d.log.findIndex(q => /pg_advisory_xact_lock/.test(q)) > -1
    && d.log.findIndex(q => /pg_advisory_xact_lock/.test(q)) < d.log.findIndex(q => /c\.id <> \$2/.test(q))
    && d.log.includes('ROLLBACK') && d.rel() === 1);
  ok('★ 해제 대상의 오더는 정방향·역방향 둘 다로 찾는다', d.log.some(q => /UNION/.test(q) && /JOIN work_orders w ON/.test(q)));
  d = mkDb(['wo_1'], []);
  out = await arch.unarchiveCampaign(d.db, 'c_old');
  ok('살아 있는 다른 공고가 없으면 해제 + 커밋', out.ok === true && d.log.includes('COMMIT') && d.rel() === 1
    && d.log.findIndex(q => /SET archived_at = NULL/.test(q)) < d.log.indexOf('COMMIT'));
  { // 이미 해제된 공고(재시도) — 검사·UPDATE 없이 즉시 already
    const log = []; const c = { query: async (sql) => { sql = String(sql); log.push(sql);
      if (/SELECT archived_at FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ archived_at: null }] };
      return { rows: [{ id: 'x' }] }; }, release: () => {} };
    const o = await arch.unarchiveCampaign({ connect: async () => c }, 'c_live');
    ok('★ 이미 해제된 공고는 즉시 already(UPDATE 없음 — 사이에 보관+새 공고가 끼어도 무검사 해제 불가)',
      o.ok === true && o.already === true && !log.some(q => /SET archived_at = NULL/.test(q)) && log.includes('ROLLBACK'), log);
    ok('해제 전 행 잠금(FOR UPDATE)', /FOR UPDATE/.test(log[1] || ''));
  }
  d = mkDb([], []);
  out = await arch.unarchiveCampaign(d.db, 'c_old');
  ok('오더 없는 공고는 잠금·확인 없이 종전 그대로', out.ok === true && !d.log.some(q => /pg_advisory_xact_lock|c\.id <> \$2/.test(q)));

  console.log('\n[E] 수정요청 창 — 파일 조회는 이 탭의 리뷰어 토큰을 직접 싣고, 공용 세션은 건드리지 않는다');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  const fnSrc = (name, prefix = 'async function ') => {
    const i = html.indexOf(prefix + name + '(');
    assert(i > -1, name + ' 없음');
    let depth = 0; const j = html.indexOf('{', i);
    for (let k = j; k < html.length; k++) { if (html[k] === '{') depth++; else if (html[k] === '}' && --depth === 0) return html.slice(i, k + 1); }
    throw new Error('본문 끝 못 찾음');
  };
  ok('파일 조회는 gasGet(공용 세션 토큰) 대신 _reEditFetchMyFiles', /const res = await _reEditFetchMyFiles\(c\);/.test(fnSrc('_reEditLoadFiles'))
    && !/action:'reviewEditMyFiles'/.test(html));
  ok('★ 공용 세션을 덮어쓰지 않는다(다른 탭이 반대로 틀어짐 — Codex PR #1632)', !/syncSearchSession/.test(fnSrc('_reEditFetchMyFiles'))
    && !/syncSearchSession/.test(fnSrc('openReviewEditModal')));

  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const futureTok = (sub) => 'h.' + Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64') + '.s';
  const fetched = [];
  const ctx = { localStorage: store(), sessionStorage: store(), JSON, Date, Number, String, URLSearchParams, API_BASE_URL: 'http://api',
    AbortController, clearTimeout, setTimeout: (fn, ms) => setTimeout(fn, ctx.__fastTimeout ? 5 : ms), Error,
    atob: (x) => Buffer.from(x, 'base64').toString('binary'),
    fetch: async (url, opts) => {
      if (ctx.__hang) return new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
      if (/\/api\/reviewer\/verify/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, name: 'A', reviewerToken: 'fresh' }) };
      fetched.push({ url, token: opts.headers['X-Reviewer-Token'] });
      return { status: fetched.length === 1 && ctx.__first401 ? 401 : 200, json: async () => ({ ok: true, files: [] }) }; } };
  ctx.localStorage.setItem('iad_reviewer_user', JSON.stringify({ name: 'A', phone8: '11110063', reviewerToken: futureTok('A') }));
  const shared = JSON.stringify({ name: 'B', phone8: '22229999', reviewerToken: futureTok('B') });
  ctx.localStorage.setItem('rapp_reviewer_auth', shared);
  vm.createContext(ctx);
  // ★ 갱신 함수는 스텁하지 않고 실제 본문을 돌린다(스텁하면 공용 세션 쓰기가 가려진다 — Codex PR #1632).
  vm.runInContext(`const USER_KEY="iad_reviewer_user"; const HOME_SESSION_KEY="iad_reviewer_home_session"; let synced = 0; var _reEditTabUser = null;
    function syncSearchSession(u){ synced++; localStorage.setItem("rapp_reviewer_auth", JSON.stringify({ phone8:u.phone8, reviewerToken:u.reviewerToken })); }`, ctx);
  vm.runInContext(fnSrc('_refreshReviewerHomeSession'), ctx);
  vm.runInContext(fnSrc('getSavedUser', 'function '), ctx);
  vm.runInContext(fnSrc('_reviewerTokenFresh', 'function '), ctx);
  vm.runInContext(fnSrc('_reEditFetchMyFiles'), ctx);
  const res = await vm.runInContext(`_reEditFetchMyFiles({ phone8:'11110063', sheetId:'s', tabName:'t', rowIndex:182 })`, ctx);
  ok('★ 화면의 리뷰어(A) 토큰으로 부른다', fetched.length === 1 && fetched[0].token === futureTok('A') && /\/api\/review-edit\/my-files\?/.test(fetched[0].url)
    && /phone8=11110063/.test(fetched[0].url) && /rowIndex=182/.test(fetched[0].url), fetched);
  ok('★ 공용 세션(B)은 그대로', ctx.localStorage.getItem('rapp_reviewer_auth') === shared);
  ok('응답을 돌려준다', res && res.ok === true);
  fetched.length = 0; ctx.__first401 = true;
  await vm.runInContext(`_reEditFetchMyFiles({ phone8:'11110063', sheetId:'s', tabName:'t', rowIndex:182 })`, ctx);
  ok('401 이면 토큰 갱신 후 한 번 다시', fetched.length === 2 && fetched[1].token === 'fresh', fetched);
  ok('★ 갱신해도 공용 세션(B)은 그대로 — syncShared:false', ctx.localStorage.getItem('rapp_reviewer_auth') === shared && vm.runInContext('synced', ctx) === 0);
  ok('저장소의 홈 신원은 건드리지 않는다(persist:false — 다른 탭 신원 보호)', JSON.parse(ctx.localStorage.getItem('iad_reviewer_user')).reviewerToken === futureTok('A'));
  // 만료 토큰으로 창을 열 때(선갱신)도 공용 세션 무접촉
  ctx.localStorage.setItem('iad_reviewer_user', JSON.stringify({ name: 'A', phone8: '11110063', reviewerToken: 'expired' }));
  fetched.length = 0; ctx.__first401 = false;
  await vm.runInContext(`_reEditFetchMyFiles({ phone8:'11110063', sheetId:'s', tabName:'t', rowIndex:182 })`, ctx);
  ok('★ 만료 토큰 선갱신도 공용 세션 무접촉', fetched[0].token === 'fresh' && ctx.localStorage.getItem('rapp_reviewer_auth') === shared && vm.runInContext('synced', ctx) === 0);
  // 다른 탭이 리뷰 내역에 B 로 로그인 → USER_KEY 가 B. 이 탭에 그려진 목록의 주인(A)으로 부른다.
  vm.runInContext(`_reEditTabUser = { name:'A', phone8:'11110063', reviewerToken:'expiredA' };`, ctx);
  ctx.localStorage.setItem('iad_reviewer_user', JSON.stringify({ name: 'B', phone8: '22229999', reviewerToken: futureTok('B') }));
  const userKeyB = ctx.localStorage.getItem('iad_reviewer_user');
  fetched.length = 0;
  await vm.runInContext(`_reEditFetchMyFiles({ phone8:'11110063', sheetId:'s', tabName:'t', rowIndex:182 })`, ctx);
  ok('★ 다른 탭 로그인(B)이 있어도 이 탭 목록의 주인(A) 신원으로 갱신·호출', fetched.length === 1 && fetched[0].token === 'fresh', fetched);
  ok('★ 갱신해도 공용 홈 신원(B)을 덮어쓰지 않는다(persist:false)', ctx.localStorage.getItem('iad_reviewer_user') === userKeyB);
  ok('창을 열 때도 이 탭 목록의 주인을 쓴다', /const user = _reEditTabUser \|\| getSavedUser\(\);/.test(fnSrc('openReviewEditModal')));
  ok('목록을 그린 신원을 기억한다', /_reEditTabUser = \{ \.\.\.user \};/.test(html));
  ctx.__hang = true; ctx.__fastTimeout = true;
  vm.runInContext(`_reEditTabUser = { name:'A', phone8:'11110063', reviewerToken:'${futureTok('A')}' };`, ctx);
  const hung = await vm.runInContext(`_reEditFetchMyFiles({ phone8:'11110063', sheetId:'s', tabName:'t', rowIndex:182 }).then(()=>'resolved', e=>e.message)`, ctx);
  ctx.__hang = false; ctx.__fastTimeout = false;
  ok('★ 응답이 끊기면 제한 시간 뒤 오류로 끝난다(무한 "불러오는 중" 방지)', /응답이 늦어지고/.test(hung), hung);
  ok('제한 시간은 gasGet 과 같은 30초', /setTimeout\(\(\) => ctl\.abort\(\), 30000\)/.test(fnSrc('_reEditFetchMyFiles')));
  ok('다른 화면의 갱신은 종전 그대로 공용 세션을 맞춘다(기본값)', /if \(!opts \|\| opts\.syncShared !== false\) syncSearchSession\(next\);/.test(html));

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
