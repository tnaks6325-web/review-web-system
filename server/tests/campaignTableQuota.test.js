/**
 * campaignTableQuota.test.js — 모집 정원 표(주문 원장) 기준 전환 (2026-08-20)
 *
 * 1단계(표시): 관리자 카드 누적 = 작업보드 표 채워진 줄(archiveSuggest.filled — rowNumbering.filledSql
 *   단일 출처 합류). null/부재 = 종전(공고 확정) 폴백 + 툴팁이 그 사실을 말한다(0 위장 금지).
 * 2단계(게이트): CAMPAIGN_TABLE_QUOTA = off | observe(기본) | on.
 *   재료 = order_submissions(주문 원장) — 작업표 줄이 아니다(선기입 이름만 줄의 참여 소각·
 *   링크 오염·투영 지연 면역). observe 는 payload.tableQuota 만 싣고 상태 무변경.
 *   on 은 wouldClose 시 soft_full(stateReason:'table_over_total') — **비영속**(maybePersistClosed 무접촉).
 *
 * 고정하는 것:
 *   [1] 순수함수 — linked 부재/null/noTab = 종전과 동일 · observe 는 관측만 · sharedTab/rt=0 게이트 비활성
 *       · closed/preopen 카드에도 tableQuota 가 실린다(관측 가시성)
 *   [2] 모드 전환(자식 프로세스 — env 는 require 시점에 읽힌다): on=soft_full · 0/off=로더 쿼리 0
 *   [3] 로더 — 스텁 pool 실행: 깔때기 부착 · planMaps 뒤 순서(066 계약) · client SAVEPOINT 격리
 *       · 실패=null(기존 동작) · pool 캐시
 *   [4] SQL 불변식(스텁은 SQL 을 해석하지 않으므로 문장 고정)
 *   [5] archiveSuggestions = filledSql 단일 출처(★ 명시적 의미 변경 — 2칸 판정 폐기)
 *   [6] 프론트 vm 실행 — 누적 표기 전환·폴백·칩 조건
 *   [7] 배선 — admin/list 동봉 · 공개 뷰 미노출 · maybePersistClosed/dailyQuota 무접촉
 * 실행: node tests/campaignTableQuota.test.js
 */
// ★ PGTEST_URL 은 **require 보다 먼저** DATABASE_URL 로 옮긴다(pool 은 require 시점에 읽는다 — 레포 규율)
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const stateSrc = read('src/services/campaignState.service.js');
const archiveSrc = read('src/services/campaignArchive.service.js');
const routesSrc = read('src/routes/campaign.routes.js');
const holdSrc = read('src/services/campaignHold.service.js');
const cards = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-cards.js'), 'utf8');

let n = 0;
const ok = (name, cond, extra) => {
  assert(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  n++; console.log('  ✓ ' + name);
};

(async () => {
  const S = require('../src/services/campaignState.service');

  // ── [1] 순수함수 — computeCampaignState (이 프로세스 = 기본 observe) ──
  console.log('[1] computeCampaignState — observe 기본');
  ok('기본 모드는 observe', S.TABLE_QUOTA_MODE === 'observe', S.TABLE_QUOTA_MODE);
  const C = { id: 'c1', participation_mode: true, status: 'active', window_start: null, window_end: null,
    daily_limit: 20, recruit_total: 9, hold_ttl_min: 15, close_buffer_min: 10 };
  const NOW = new Date('2026-08-20T10:00:00+09:00');
  const cnt = (o) => Object.assign({ activeHolds: 0, todayActiveHolds: 0, submittedAll: 0,
    todaySubmitted: 0, submittedBeforeToday: 0, carry: null, hold: null, plans: null, linked: null }, o);

  {
    const a = S.computeCampaignState(C, cnt({ submittedAll: 5 }), NOW);
    ok('linked 없음(null) = tableQuota 미부착 + 종전 판정', a.state === 'open' && !('tableQuota' in a), a.state);
    const b = S.computeCampaignState(C, cnt({ submittedAll: 5, linked: { ok: true, noTab: true } }), NOW);
    ok('noTab(연결 없음) = tableQuota 미부착("없다"와 "모른다" 모두 카드에 표 문구 없음)', !('tableQuota' in b));
    const c = S.computeCampaignState(C, cnt({ submittedAll: 5, activeHolds: 2,
      linked: { ok: true, orders: 7, ordersAll: 7, sharedTab: false } }), NOW);
    ok('★★ observe = wouldClose:true 여도 state 는 open(참여 무변경)',
      c.state === 'open' && c.tableQuota && c.tableQuota.wouldClose === true, c.tableQuota);
    ok('max(확정,주문)+홀드 판정(5,7 → 7+2=9 ≥ rt 9)', c.tableQuota.mode === 'observe' && c.tableQuota.orders === 7);
    const d = S.computeCampaignState(C, cnt({ submittedAll: 5,
      linked: { ok: true, orders: 7, ordersAll: 7, sharedTab: false } }), NOW);
    ok('홀드 없으면 7 < 9 = wouldClose:false(이중계수 없음 검증)', d.tableQuota.wouldClose === false);
    const e = S.computeCampaignState(C, cnt({ submittedAll: 5, activeHolds: 2,
      linked: { ok: true, orders: 7, ordersAll: 7, sharedTab: true } }), NOW);
    ok('★ sharedTab(한 탭 다중 공고) = 게이트 비활성(이중 차단 방지)', e.tableQuota.wouldClose === false);
    const f = S.computeCampaignState({ ...C, recruit_total: 0 }, cnt({ submittedAll: 5, activeHolds: 9,
      linked: { ok: true, orders: 999, ordersAll: 999, sharedTab: false } }), NOW);
    ok('rt=0(무제한)은 표 기준으로도 안 닫힌다', f.tableQuota.wouldClose === false && f.state === 'open');
    const g = S.computeCampaignState({ ...C, status: 'draft' }, cnt({ submittedAll: 0,
      linked: { ok: true, orders: 12, ordersAll: 12, sharedTab: false } }), NOW);
    ok('★ closed(미게시) 반환에도 tableQuota 가 실린다(observe 의 관측 가시성)',
      g.state === 'closed' && g.tableQuota && g.tableQuota.wouldClose === true);
    const h = S.computeCampaignState(C, cnt({ submittedAll: 9 }), NOW);
    ok('종전 soft_full(공고 기준)은 그대로(무회귀)', h.state === 'soft_full' && h.stateReason === undefined);
  }

  // ── [2] 모드 전환 — 자식 프로세스(campaignQuotaBasis 관용구) ──
  console.log('\n[2] 모드 전환(자식 프로세스)');
  const probe = `
    const S = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'campaignState.service.js'))});
    const C = { id:'c1', participation_mode:true, status:'active', window_start:null, window_end:null,
      daily_limit:20, recruit_total:9, hold_ttl_min:15, close_buffer_min:10 };
    // linked 는 로더 산출물이다 — off 모드에선 로더가 안 돌아 항상 null(현실 조건 그대로 재현)
    const linked = S.TABLE_QUOTA_MODE === 'off' ? null : { ok:true, orders:9, ordersAll:9, sharedTab:false };
    const counts = { activeHolds:0, todayActiveHolds:0, submittedAll:5, todaySubmitted:0,
      submittedBeforeToday:0, carry:null, hold:null, plans:null, linked };
    const st = S.computeCampaignState(C, counts, new Date('2026-08-20T10:00:00+09:00'));
    (async () => {
      const qs = [];
      const pool = { query: async (t) => { qs.push(String(t)); return { rows: [] }; } };
      await S.fetchCampaignCounts(pool, ['c1']);
      process.stdout.write(JSON.stringify({ mode: S.TABLE_QUOTA_MODE, state: st.state,
        reason: st.stateReason || null, wc: st.tableQuota ? st.tableQuota.wouldClose : null,
        loaderQ: qs.filter(t => /order_submissions/.test(t)).length }));
    })();
  `;
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['-e', probe], {
    env: Object.assign({}, process.env, env), encoding: 'utf8',
  }));
  const on = run({ CAMPAIGN_TABLE_QUOTA: 'on' });
  ok('★★ on = wouldClose 시 soft_full + stateReason:table_over_total',
    on.mode === 'on' && on.state === 'soft_full' && on.reason === 'table_over_total', on);
  const off = run({ CAMPAIGN_TABLE_QUOTA: '0' });
  ok('★★ CAMPAIGN_TABLE_QUOTA=0 은 off(운영자가 껐다고 믿는데 켜져 있는 상태 금지)',
    off.mode === 'off', off);
  ok('★ off = 로더 쿼리 0건(완전 킬스위치)', off.loaderQ === 0, off);
  ok('off 는 판정도 종전 그대로(open)', off.state === 'open' && off.wc === null, off);
  const obs = run({ CAMPAIGN_TABLE_QUOTA: '' });
  ok('미설정 = observe + 로더 쿼리가 나간다', obs.mode === 'observe' && obs.loaderQ === 1, obs);

  // ── [3] 로더 — 스텁 pool 실제 실행 ──
  console.log('\n[3] 로더 실행(스텁 pool)');
  S.__resetTableQuotaCacheForTest();
  {
    const calls = [];
    const pool = { query: async (text, params) => {
      calls.push(String(text));
      if (/order_submissions/.test(text)) {
        return { rows: [{ id: 'c1', orders: '169', orders_all: '170', live_campaigns: '1' }] };
      }
      return { rows: [] };
    } };
    const out = await S.fetchCampaignCounts(pool, ['c1', 'c2']);
    const l1 = out.get('c1').linked, l2 = out.get('c2').linked;
    ok('★★ 깔때기(counts.linked)에 실린다 — 별도 인자 금지', l1 && l1.ok && l1.orders === 169 && l1.sharedTab === false, l1);
    ok('행이 없는 공고 = noTab(연결 없음/비참여형)', l2 && l2.noTab === true, l2);
    const iPlan = calls.findIndex(t => /campaign_daily_plans/.test(t));
    const iLinked = calls.findIndex(t => /order_submissions/.test(t));
    ok('★ 로더는 planMaps 뒤(066 q[0]/q[1] 쿼리 순서 계약 보존)',
      iPlan >= 0 && iLinked >= 0 && iPlan < iLinked, [iPlan, iLinked]);
  }
  S.__resetTableQuotaCacheForTest();
  {
    // client(release 보유) + 로더 쿼리 실패 → SAVEPOINT 격리 + linked=null + 이후 쿼리 생존
    const calls = [];
    const client = { release: () => {}, query: async (text) => {
      calls.push(String(text));
      if (/order_submissions/.test(text)) throw new Error('boom');
      return { rows: [] };
    } };
    const out = await S.fetchCampaignCounts(client, ['c1']);
    ok('★★ client 실패 = linked null(모른다 = 기존 동작 — 정원을 좁히지 않는다)',
      out.get('c1').linked === null);
    ok('★★ SAVEPOINT ctq_orders 로 격리(25P02 로 apply tx 를 죽이지 않는다)',
      calls.some(t => t === 'SAVEPOINT ctq_orders') && calls.some(t => /ROLLBACK TO SAVEPOINT ctq_orders/.test(t)), calls);
    // 실패 뒤에도 같은 client 로 후속 쿼리 가능(스텁이라 실제 25P02 는 PG 검증 항목)
    const again = await client.query('SELECT 1');
    ok('실패 후 후속 쿼리 경로 생존', !!again);
  }
  S.__resetTableQuotaCacheForTest();
  {
    // pool 경로 10초 캐시 — 같은 id 재호출 시 로더 쿼리 1회
    let loaderHits = 0;
    const pool = { query: async (text) => {
      if (/order_submissions/.test(text)) { loaderHits++; return { rows: [{ id: 'c1', orders: '3', orders_all: '3', live_campaigns: '1' }] }; }
      return { rows: [] };
    } };
    await S.fetchCampaignCounts(pool, ['c1']);
    await S.fetchCampaignCounts(pool, ['c1']);
    ok('★ pool 캐시(10초) — 재호출에 로더 쿼리 1회', loaderHits === 1, loaderHits);
    S.__resetTableQuotaCacheForTest();
    await S.fetchCampaignCounts(pool, ['c1']);
    ok('__resetTableQuotaCacheForTest 로 캐시 초기화', loaderHits === 2, loaderHits);
  }

  // ── [4] SQL 불변식(스텁은 SQL 을 해석하지 않는다 — 문장으로 고정) ──
  console.log('\n[4] SQL 불변식');
  const loaderBody = stateSrc.slice(stateSrc.indexOf('async function _loadLinkedOrderCounts'),
    stateSrc.indexOf('function __resetTableQuotaCacheForTest'));
  ok('로더 존재 + 본문 확보', loaderBody.length > 500);
  ok('★ DISTINCT os.id(중복 조인 배증 방지)', /COUNT\(DISTINCT os\.id\)/.test(loaderBody));
  ok('★ 소프트삭제 주문 제외(os.deleted_at IS NULL)', /os\.deleted_at IS NULL/.test(loaderBody));
  ok("★ 앵커 = start_date(KST) ?? created_at(탭 재사용 과거 블록 배제)",
    /submitted_at >= COALESCE\(\(rc\.start_date::text \|\| 'T00:00:00\+09:00'\)::timestamptz, rc\.created_at\)/.test(loaderBody));
  ok("★ 빈 gid 는 절을 켜지 않는다(NULLIF 게이트)",
    /NULLIF\(rc\.linked_tab_gid,''\) IS NOT NULL/.test(loaderBody));
  ok("★★ 주문 좌표 합집합 — 공고 경유(campaign:<id>) + 연결 탭 두 계열을 다 센다(탭만 보면 확정 67에 orders 0)",
    /os\.sheet_id = 'campaign:' \|\| rc\.id AND os\.tab_name = 'campaign:' \|\| rc\.id/.test(loaderBody));
  ok("★ 앵커는 탭 좌표에만(campaign: 좌표는 귀속 자명 — 자르면 공고 경유 확정 과소집계)",
    /WHERE os\.sheet_id = 'campaign:' \|\| rc\.id\n\s+OR os\.submitted_at >= COALESCE/.test(loaderBody));
  ok('★★ 게이트 재료에 작업표 줄 없음(campaign_participants 참조 0 — 선기입·링크 오염 면역)',
    !/campaign_participants/.test(loaderBody));
  ok('★ 시트 API 호출 0', !/sheets|spreadsheet|googleapis/i.test(loaderBody));
  ok('★ 캐시는 성공 결과만(catch 에서 캐시 기록 없음)',
    !/catch[\s\S]{0,200}_ctqCache\.set/.test(loaderBody));
  ok('★ 캐시 크기 캡(무한 성장 방지)', /CTQ_CACHE_MAX/.test(loaderBody) && /_ctqCache\.size > CTQ_CACHE_MAX/.test(stateSrc));

  // ── [5] archiveSuggestions = filledSql 단일 출처(명시적 의미 변경) ──
  console.log('\n[5] 채워진 줄 판정 단일 출처');
  ok("★★ filledSql 합류(rowNumbering 단일 출처 — 작업보드 게이지와 같은 판정)",
    /require\('\.\.\/utils\/rowNumbering'\)/.test(archiveSrc) && /\$\{filledSql\('p'\)\}/.test(archiveSrc));
  ok('★ 옛 2칸 판정(COALESCE(NULLIF(TRIM(phone8…) 폐기 — 사본 부활 금지',
    !/NULLIF\(TRIM\(phone8\)/.test(archiveSrc));

  // ── [6] 프론트 vm 실행 ──
  console.log('\n[6] 카드 렌더 실행');
  {
    const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
      getBoundingClientRect: () => ({}), querySelector: () => null, querySelectorAll: () => [],
      insertAdjacentHTML() {}, remove() {}, contains: () => true, innerHTML: '', textContent: '' });
    const win = { location: { hostname: 'x' }, addEventListener() {},
      sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null }, confirm: () => true };
    const doc = { head: el(), body: el(), createElement: () => el(), getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
    const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout,
      fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }), API_BASE_URL: '' };
    sb.globalThis = sb; win.document = doc;
    vm.createContext(sb);
    vm.runInContext(cards, sb, { filename: 'campaign-cards.js' });
    const CC = sb.window.CampCards;
    const base = { id: 'c1', title: 'T', participation_mode: true, status: 'active', state: 'open',
      recruit_total: 200, daily_limit: 10, dailyQuota: 10, todayCount: 0,
      ops: { totalConfirmed: 49, holdNow: 0 } };
    const hTf = CC.cardHtml({ ...base, archiveSuggest: { total: 200, filled: 169, full: false } }, { admin: true });
    ok('★★ 1단계 — 누적 분자 = 표 채워진 줄(169) + [표] 출처 배지',
      /총 <b>169<\/b>\/200명/.test(hTf) && /sp-src/.test(hTf));
    ok('★ 툴팁이 공고 확정(49명)을 병기(차이 = 신호를 잃지 않는다)',
      /공고를 거쳐 확정된 건 49명/.test(hTf));
    const hNo = CC.cardHtml({ ...base }, { admin: true });
    ok('★ 재료 부재 = 종전(49) 폴백 + 폴백 사실을 툴팁으로("표" 배지 없음 — 거짓 표 기준 표기 금지)',
      /총 <b>49<\/b>\/200명/.test(hNo) && !/sp-src/.test(hNo) && /공고 확정 기준으로 표기 중/.test(hNo));
    const hObs = CC.cardHtml({ ...base, archiveSuggest: { total: 200, filled: 40, full: false },
      tableQuota: { mode: 'observe', orders: 40, ordersAll: 40, sharedTab: false, wouldClose: true } }, { admin: true });
    ok('★ observe 칩 = "표 기준이면 마감"(참여는 안 막는다는 문구)',
      /pg-tq(?!\s+on)/.test(hObs) && /표 기준이면 마감/.test(hObs) && /표시만 하고 참여는 막지 않습니다/.test(hObs));
    const hOn = CC.cardHtml({ ...base, tableQuota: { mode: 'on', orders: 40, ordersAll: 40, sharedTab: false, wouldClose: true } }, { admin: true });
    ok('★ on 칩 = "표 기준 마감" + 비영속(자동 재오픈) 설명',
      /pg-tq on/.test(hOn) && /표 기준 마감/.test(hOn) && /자동 재오픈/.test(hOn));
    const hQuiet = CC.cardHtml({ ...base, tableQuota: { mode: 'observe', orders: 3, ordersAll: 3, sharedTab: false, wouldClose: false } }, { admin: true });
    ok('wouldClose:false 면 칩 없음(신호 아닌 것에 색을 쓰지 않는다)', !/pg-tq/.test(hQuiet));
    const hRv = CC.cardHtml({ ...base, archiveSuggest: { total: 200, filled: 169, full: false },
      tableQuota: { mode: 'observe', orders: 169, ordersAll: 169, sharedTab: false, wouldClose: true } }, { admin: false });
    ok('★★ 리뷰어 카드에는 표 기준 표기·칩이 없다(관리자 분기 전용)', !/sp-src|pg-tq/.test(hRv));
    ok('CSS 주입(.pg-tq/.sp-src)', /\.pcard \.pg-tq\{/.test(cards) && /\.pcard \.sp-src\{/.test(cards));
    ok('★ _roundsLine 은 공고 기준 유지(차수 차오름은 시간 순서 전제 — filled 에는 시간축이 없다)',
      /_roundsLine/.test(cards) && /ops && Number\(c\.ops\.totalConfirmed\)\) \|\| 0;\n    const prev/.test(cards.replace(/\r/g, '')) ||
      /function _roundsLine[\s\S]{0,400}totalConfirmed/.test(cards));
  }

  // ── [7] 배선 ──
  console.log('\n[7] 배선');
  ok('admin/list 가 tableQuota 를 동봉', /tableQuota: st\.tableQuota \|\| null/.test(routesSrc));
  {
    const pv = routesSrc.slice(routesSrc.indexOf('function _publicView'), routesSrc.indexOf('function _publicView') + 4000);
    ok('★★ 공개 화이트리스트(_publicView)에 tableQuota 없음(리뷰어 미노출)', !/tableQuota/.test(pv));
  }
  ok('★★ maybePersistClosed 무접촉(표 기준 마감은 비영속 — 자동 영속 금지)',
    !/TABLE_QUOTA|tableQuota|linked/.test(holdSrc.slice(holdSrc.indexOf('maybePersistClosed'), holdSrc.indexOf('maybePersistClosed') + 2500)));
  {
    const dq = stateSrc.slice(stateSrc.indexOf('function dailyQuota'), stateSrc.indexOf('function computeCampaignState'));
    ok('★ dailyQuota(이월·계획·clamp)는 공고 기준 유지(표 기준 참조 0 — 시간축 부재)', !/linked|tableQuota/.test(dq));
  }
  ok('★ 게이트는 observe 에서 상태를 바꾸지 않는다(코드 형태 고정)',
    /TABLE_QUOTA_MODE === 'on' && payload\.tableQuota && payload\.tableQuota\.wouldClose/.test(stateSrc));
  ok('★ exports(TABLE_QUOTA_MODE·리셋)', typeof S.TABLE_QUOTA_MODE === 'string' && typeof S.__resetTableQuotaCacheForTest === 'function');
  ok('★ 소스에 리터럴 NUL 0(가드 무력화 방지)',
    !fs.readFileSync(path.join(__dirname, '..', 'src/services/campaignState.service.js')).includes(0x00));

  // ── [8] 진짜 PG16(PGTEST_URL 있을 때만) — 스텁으로 못 잡는 것: SQL 실행·SAVEPOINT 의 실제 tx 격리 ──
  if (process.env.PGTEST_URL) {
    console.log('\n[8] 진짜 PG16 실행 검증');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.PGTEST_URL });
    await pool.query(`DROP TABLE IF EXISTS recruit_campaigns, order_submissions, campaign_daily_plans, campaign_applications, app_settings CASCADE`);
    await pool.query(`CREATE TABLE recruit_campaigns(
      id TEXT PRIMARY KEY, participation_mode BOOL DEFAULT TRUE, status TEXT DEFAULT 'active',
      archived_at TIMESTAMPTZ, linked_sheet_id TEXT DEFAULT '', linked_tab_name TEXT DEFAULT '',
      linked_tab_gid TEXT DEFAULT '', start_date DATE, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE order_submissions(
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY, sheet_id TEXT, tab_name TEXT, tab_gid TEXT DEFAULT '',
      submitted_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ)`);
    await pool.query(`CREATE TABLE campaign_daily_plans(campaign_id TEXT, plan_date DATE, planned_count INT)`);
    await pool.query(`CREATE TABLE campaign_applications(id SERIAL PRIMARY KEY, campaign_id TEXT, status TEXT,
      phone8 TEXT, expires_at TIMESTAMPTZ, applied_at TIMESTAMPTZ DEFAULT NOW(), submitted_at TIMESTAMPTZ)`);
    await pool.query(`CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT)`);
    await pool.query(`INSERT INTO recruit_campaigns(id, linked_sheet_id, linked_tab_name, linked_tab_gid, start_date)
      VALUES ('c1','S1','탭A','777','2026-08-01')`);
    await pool.query(`INSERT INTO order_submissions(sheet_id, tab_name, tab_gid, submitted_at) VALUES
      ('S1','탭A','','2026-07-20T03:00:00Z'), ('S1','탭A','','2026-07-25T03:00:00Z'),
      ('S1','탭A','','2026-08-05T03:00:00Z'), ('S1','탭A','','2026-08-10T03:00:00Z'),
      ('S1','리네임된탭','777','2026-08-12T03:00:00Z')`); // gid 폴백으로만 잡히는 주문
    await pool.query(`INSERT INTO order_submissions(sheet_id, tab_name, submitted_at, deleted_at) VALUES
      ('S1','탭A','2026-08-06T03:00:00Z','2026-08-07T00:00:00Z')`);
    await pool.query(`INSERT INTO recruit_campaigns(id, linked_sheet_id, linked_tab_name, created_at)
      VALUES ('c2','S2','탭B','2026-01-01T00:00:00Z')`);
    await pool.query(`INSERT INTO order_submissions(sheet_id, tab_name, submitted_at) VALUES ('S2','탭B','2026-06-01T00:00:00Z')`);
    await pool.query(`INSERT INTO recruit_campaigns(id, linked_sheet_id, linked_tab_name) VALUES ('c3','S3','탭C')`);
    await pool.query(`INSERT INTO recruit_campaigns(id, linked_sheet_id, linked_tab_name) VALUES ('c4','S4','탭D'), ('c5','S4','탭D')`);
    await pool.query(`INSERT INTO recruit_campaigns(id) VALUES ('c6')`);

    S.__resetTableQuotaCacheForTest();
    const out = await S.fetchCampaignCounts(pool, ['c1','c2','c3','c4','c5','c6']);
    const L = id => out.get(id).linked;
    // 미삭제 5건 = 앵커(8/1 KST) 전 2 + 후 2 + gid폴백(리네임 탭) 1 · 삭제 1건 제외
    ok('PG: 앵커 절단 — start_date(KST) 이후만 orders=3', L('c1').orders === 3, L('c1'));
    ok('PG: ★ 삭제 주문 제외 — ordersAll=5(6이면 삭제분 포함)', L('c1').ordersAll === 5, L('c1'));
    ok('PG: ★ gid 폴백 — 리네임 탭 주문 포함(빠지면 4)', L('c1').ordersAll === 5);
    ok('PG: start_date NULL → created_at 폴백', L('c2').orders === 1 && L('c2').ordersAll === 1, L('c2'));
    ok('PG: 주문 0건 탭 = orders 0(LEFT JOIN)', L('c3') && L('c3').orders === 0 && !L('c3').noTab, L('c3'));
    ok('PG: ★ sharedTab — 같은 탭 활성 공고 2개면 양쪽 다 true', L('c4').sharedTab === true && L('c5').sharedTab === true);
    ok('PG: 미연결 = noTab', L('c6') && L('c6').noTab === true, L('c6'));

    // ★★ 좌표 합집합(프로덕션 실측 회귀) — c1 에 공고 경유 주문 2건(campaign: 좌표, 앵커 이전
    //   시각이어도 orders 에 포함) 추가 → orders 3+2=5 · ordersAll 5+2=7. 같은 주문이 두 절에
    //   동시에 걸릴 수 없는 좌표라 DISTINCT 로 이중계수 0.
    await pool.query(`INSERT INTO order_submissions(sheet_id, tab_name, submitted_at) VALUES
      ('campaign:c1','campaign:c1','2026-07-10T00:00:00Z'), ('campaign:c1','campaign:c1','2026-08-15T00:00:00Z')`);
    S.__resetTableQuotaCacheForTest();
    const out2 = await S.fetchCampaignCounts(pool, ['c1']);
    const L1b = out2.get('c1').linked;
    ok('PG: ★★ 공고 경유(campaign: 좌표) 주문 합류 — orders 5(탭 3 + 공고 2, 앵커는 탭에만)',
      L1b.orders === 5 && L1b.ordersAll === 7, L1b);

    // ★★ apply 잠금 tx — **로더 쿼리에만** 진짜 PG 오류(42P01)를 주입해 tx 를 실제로 오염시키고,
    //   SAVEPOINT ROLLBACK 이 그 오염을 걷어내 같은 tx 의 참여 INSERT 가 사는지(25P02 격리 실증).
    //   JS throw 흉내로는 이 검증이 성립하지 않는다(스텁은 tx 를 abort 시키지 못한다).
    const raw = await pool.connect();
    const client = {
      release: () => raw.release(),
      query: (text, params) => /order_submissions/.test(String(text))
        ? raw.query('SELECT * FROM nonexistent_table_for_ctq_test')
        : raw.query(text, params),
    };
    try {
      await raw.query('BEGIN');
      await raw.query(`SELECT * FROM recruit_campaigns WHERE id='c1' FOR UPDATE`);
      S.__resetTableQuotaCacheForTest();
      const counts = await S.fetchCampaignCounts(client, ['c1']);
      ok('PG: ★★ tx 안 로더 42P01 → linked=null(fail-open)', counts.get('c1').linked === null);
      const ins = await raw.query(`INSERT INTO campaign_applications(campaign_id, status, phone8, expires_at)
        VALUES ('c1','applied','12345678', NOW() + interval '15 min') RETURNING id`);
      ok('PG: ★★ 로더 실패 후 같은 tx 에서 참여 INSERT 생존(SAVEPOINT 격리)', ins.rows.length === 1);
      await raw.query('COMMIT');
    } finally { raw.release(); }
    await pool.end();
  } else {
    console.log('\n[8] PGTEST_URL 없음 — 진짜 PG 검증 생략(스텁 검증만)');
  }

  console.log(`\n✅ campaignTableQuota: ${n}개 통과`);
  process.exit(0);
})().catch(e => { console.error('❌ 실패:', e.message); process.exit(1); });
