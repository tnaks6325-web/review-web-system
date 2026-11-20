/**
 * campaignSourceDeletedBadge.test.js — 결정 388 회귀가드(RW-C)
 * 실행: node tests/campaignSourceDeletedBadge.test.js
 *
 * 사용자 확정(2026-11-20): 리뷰웹시스템[3버전] 직원 화면의 **모집공고 목록 카드**와 **공고 수정 창**에
 * 「원본 오더 삭제됨」 표시를 단다. 판정은 홈 작업 목록과 같은 단일 출처(trackB.sourceOrderDeletedMap · 결정 254).
 *
 * ★★ 위험(레드 4) = 공고 수정 창 서버 함수 getCampaignDetail 은 **로그인 없는 리뷰어 공고 상세**
 *   (`router.get('/:id', getCampaignDetail)`)와 같은 함수다. 표시는 관리자(내부 직원) 갈래에만 싣고,
 *   지운 직원 이름은 **어디에도** 싣지 않는다(사용자 확정: 이름 없음).
 * → 실제 HTTP 로 두드린다. DB 는 스텁이되 「원본 오더 삭제됨」 판정 SQL 은 **PGlite 에서 실제로 실행**한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:***@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'campaign-source-deleted-badge-secret';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const DELETER = '삭제한직원이름';   // 응답·화면 어디에도 나오면 안 되는 이름

/* ── 고정구: 공고 4개 ───────────────────────────────────────
   c-del    : 오더가 지워진 작업(s1/작업A) — 표시 대상
   c-live   : 살아 있는 오더가 있는 작업(s1/작업B) — 표시 없음
   c-gid    : 작업 이름이 바뀌었지만 gid 가 같은 작업(s1/옛이름 → 오더 쪽 gid 77) — gid 폴백으로 표시
   c-none   : 연결 작업 없음 — 표시 없음 */
const CAMPS = [
  { id: 'c-del', title: '지워진 오더 공고', linked_sheet_id: 's1', linked_tab_name: '작업A', linked_tab_gid: '' },
  { id: 'c-live', title: '살아 있는 오더 공고', linked_sheet_id: 's1', linked_tab_name: '작업B', linked_tab_gid: '' },
  { id: 'c-gid', title: '이름 바뀐 작업 공고', linked_sheet_id: 's1', linked_tab_name: '새이름', linked_tab_gid: '77' },
  { id: 'c-none', title: '연결 없는 공고', linked_sheet_id: '', linked_tab_name: '', linked_tab_gid: '' },
].map(c => ({
  status: 'active', participation_mode: false, archived_at: null, work_detail: { inflowType: 'link' },
  review_fee: 1000, recruit_total: 10, repurchase_days: null, created_at: '2026-11-01T00:00:00Z', ...c,
}));

(async () => {
  console.log('\n▶ 결정 388 — 「원본 오더 삭제됨」은 직원 화면(관리자 갈래)에만 · 지운 직원 이름 없음\n');

  const db = new PGlite();
  await db.exec(`
    CREATE TABLE work_orders(id text PRIMARY KEY, linked_tab_sheet_id text, linked_tab_name text, linked_tab_gid text,
      deleted_at timestamptz, deleted_by text, deleted_by_name text);
    CREATE TABLE trackb_work_order_links(work_order_id text, sheet_id text, tab_name text, deleted_at timestamptz);
    INSERT INTO work_orders VALUES
      ('wo-del','s1','작업A','', '2026-11-18T03:00:00Z','u9','${DELETER}'),
      ('wo-dead-b','s1','작업B','', '2026-11-17T03:00:00Z','u9','${DELETER}'),
      ('wo-live-b','s1','작업B','', NULL, NULL, NULL),
      ('wo-gid','s1','옛이름','77', '2026-11-16T03:00:00Z','u9','${DELETER}');
  `);
  let sodDown = false;
  const pool = require('../src/db/pool');
  pool.query = async (sql, params) => {
    const s = String(sql);
    // 「원본 오더 삭제됨」 판정 SQL = PGlite 에서 그대로 실행(글자 검사 아님)
    if (/trackb_work_order_links/.test(s) && /deleted_at IS NOT NULL/.test(s)) {
      if (sodDown) throw new Error('sod down (test)');
      return db.query(s, params);
    }
    if (/SELECT \* FROM recruit_campaigns WHERE id = \$1/.test(s)) {
      return { rows: CAMPS.filter(c => c.id === (params || [])[0]).map(c => ({ ...c })) };
    }
    if (/FROM recruit_campaigns/.test(s) && /archived_at IS NULL/.test(s) && /ORDER BY/.test(s)) return { rows: CAMPS.map(c => ({ ...c })) };
    if (/FROM recruit_campaigns/.test(s) && /status/.test(s) && !/COUNT/.test(s)) return { rows: CAMPS.map(c => ({ ...c })) };
    return { rows: [] };
  };

  /* ── A. 서비스: 공고(연결 탭)용 표시 값 — 키 규칙 단일 출처 · 이름 없음 ─────── */
  console.log('A. trackB.sourceOrderDeletedForTab');
  const tb = require('../src/services/trackB.service');
  ok('A0 trackB.service 가 sourceOrderDeletedForTab 를 내보낸다', typeof tb.sourceOrderDeletedForTab === 'function');
  if (typeof tb.sourceOrderDeletedForTab === 'function') {
    const sod = await tb.sourceOrderDeletedMap();
    ok('A1 판정 SQL 이 PGlite 에서 실제로 돈다(ok:true)', sod && sod.ok === true, JSON.stringify(sod));
    const v = tb.sourceOrderDeletedForTab(sod.map, 's1', '작업A', '');
    ok('A2 지워진 오더만 남은 작업 → { deletedAt } 만', !!v && !!v.deletedAt && Object.keys(v).join(',') === 'deletedAt', JSON.stringify(v));
    ok('A3 살아 있는 오더가 있는 작업 → null', tb.sourceOrderDeletedForTab(sod.map, 's1', '작업B', '') === null);
    ok('A4 이름이 바뀌어도 gid 로 찾는다(홈 목록과 같은 키 규칙)', !!tb.sourceOrderDeletedForTab(sod.map, 's1', '새이름', '77'));
    ok('A5 빈 gid·빈 시트·빈 맵·맵 없음 → null(전부 매칭되는 사고 방지)',
      tb.sourceOrderDeletedForTab(sod.map, 's1', '새이름', '') === null
      && tb.sourceOrderDeletedForTab(sod.map, '', '', '') === null
      && tb.sourceOrderDeletedForTab({}, 's1', '작업A', '') === null
      && tb.sourceOrderDeletedForTab(null, 's1', '작업A', '') === null);
    ok('A6 isTabFinishedIn(마감 판정)은 종전 의미 그대로 — 이름 → gid 폴백 · 빈 gid 무시',
      tb.isTabFinishedIn({ 's\tt': { x: 1 } }, 's', 't', '') === true
      && tb.isTabFinishedIn({ 's\tgid:9': { x: 1 } }, 's', '다른이름', '9') === true
      && tb.isTabFinishedIn({ 's\tgid:9': { x: 1 } }, 's', '다른이름', '') === false
      && tb.isTabFinishedIn(null, 's', 't', '') === false);
  }

  /* ── B. 실제 HTTP ──────────────────────────────────────── */
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json());
  app.use('/api/campaign', require('../src/routes/campaign.routes'));
  app.use('/api/trackb', require('../src/routes/trackB.routes'));
  app.use((err, req, res, _next) => res.status(500).json({ ok: false, error: String(err && err.message) }));
  const srv = await new Promise(res => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const hit = async (p, tok) => {
    const headers = {};
    if (tok) headers.Authorization = 'Bearer ' + jwt.sign(tok, process.env.JWT_SECRET);
    const r = await fetch(base + p, { headers });
    const text = await r.text();
    let b = null; try { b = JSON.parse(text); } catch (_) { /* noop */ }
    return { status: r.status, body: b, text };
  };
  const T = {
    master: { role: 'master', name: '마스터' },
    admin: { role: 'admin', name: '관리자' },
    outStaff: { role: 'staff', via: 'intranet', ae: false, name: '명단밖직원' },
    adv: { role: 'advertiser', name: '광고주', advertiser_id: 1 },
    advLink: { role: 'advertiser', name: '광고주', advertiser_id: 1, via: 'link' },
    reviewerCamp: { role: 'admin', via: 'reviewer_campaign', iu: 'rv', ia: true, name: '리뷰어관리' },
    reviewerApp: { role: 'staff', aud: 'reviewer-app', name: '리뷰어' },
  };
  const noBadge = (text) => !/sourceOrderDeleted|source_order_deleted/.test(text) && !text.includes(DELETER);
  try {
    console.log('\nB. 공고 수정 창(상세) — 관리자 갈래에만');
    const a1 = await hit('/api/trackb/campaigns/c-del', T.outStaff);
    ok('B1 작업보드 수정 창(명단 밖 직원 · 전체 편집 뷰) → sourceOrderDeleted.deletedAt',
      a1.status === 200 && a1.body && a1.body.sourceOrderDeleted && !!a1.body.sourceOrderDeleted.deletedAt, a1.status + ' ' + a1.text.slice(0, 200));
    ok('B2 그 응답 어디에도 지운 직원 이름·deletedBy 없음', !a1.text.includes(DELETER) && !/deletedBy|deleted_by/.test(JSON.stringify(a1.body && a1.body.sourceOrderDeleted || {})));
    const a2 = await hit('/api/campaign/admin/c-del', T.admin);
    ok('B3 관리자 수정 창(/api/campaign/admin/:id) → 표시 있음 · 이름 없음',
      a2.status === 200 && a2.body && a2.body.sourceOrderDeleted && !a2.text.includes(DELETER), a2.status + ' ' + a2.text.slice(0, 200));
    const a3 = await hit('/api/trackb/campaigns/c-gid', T.master);
    ok('B4 작업 이름이 바뀐 공고도 gid 로 표시', a3.status === 200 && a3.body && !!a3.body.sourceOrderDeleted);
    const a4 = await hit('/api/trackb/campaigns/c-live', T.master);
    ok('B5 살아 있는 오더가 있는 공고 → 칸 자체가 없음', a4.status === 200 && a4.body && a4.body.ok === true && noBadge(a4.text));
    const a5 = await hit('/api/trackb/campaigns/c-none', T.master);
    ok('B6 연결 작업 없는 공고 → 칸 없음', a5.status === 200 && a5.body && a5.body.ok === true && noBadge(a5.text));
    sodDown = true;
    const a6 = await hit('/api/trackb/campaigns/c-del', T.master);
    sodDown = false;
    ok('B7 판정 조회 실패 → 수정 창은 그대로 열리고 표시만 없음(모름을 꾸미지 않음)',
      a6.status === 200 && a6.body && a6.body.ok === true && Object.prototype.hasOwnProperty.call(a6.body.data || {}, 'work_detail') && noBadge(a6.text), a6.status + ' ' + a6.text.slice(0, 160));

    console.log('\nB. 공개·리뷰어·업체 응답 — 칸 없음(레드 4)');
    const p1 = await hit('/api/campaign/c-del');
    ok('B8 로그인 없는 리뷰어 공고 상세 GET /api/campaign/:id → 칸·이름 없음', p1.status === 200 && p1.body && p1.body.ok === true && noBadge(p1.text), p1.status + ' ' + p1.text.slice(0, 160));
    const p2 = await hit('/api/campaign/c-del', T.reviewerCamp);
    ok('B9 리뷰어 앱 공고수정 토큰(스코프 뷰) → 칸·이름 없음', p2.status === 200 && p2.body && p2.body.ok === true && noBadge(p2.text), p2.status + ' ' + p2.text.slice(0, 160));
    const p3 = await hit('/api/campaign/c-del', T.reviewerApp);
    ok('B10 리뷰어 앱 로그인 토큰 → 칸·이름 없음', p3.status === 200 && noBadge(p3.text));
    for (const [k, tok] of [['업체 계정', T.adv], ['업체 링크', T.advLink]]) {
      const q = await hit('/api/campaign/c-del', tok);
      ok(`B11 ${k} 토큰으로 공개 상세 → 칸·이름 없음`, q.status === 200 && noBadge(q.text));
      const q2 = await hit('/api/trackb/campaigns/c-del', tok);
      ok(`B12 ${k} 토큰으로 작업보드 상세 → 막힘(403) · 칸 없음`, q2.status === 403 && noBadge(q2.text), 'status=' + q2.status);
      const q3 = await hit('/api/trackb/campaigns/list', tok);
      ok(`B13 ${k} 토큰으로 작업보드 공고 목록 → 막힘(403) · 칸 없음`, q3.status === 403 && noBadge(q3.text), 'status=' + q3.status);
    }
    const p4 = await hit('/api/campaign/list');
    ok('B14 공개 공고 목록 GET /api/campaign/list → 칸·이름 없음', p4.status === 200 && noBadge(p4.text), p4.status + ' ' + p4.text.slice(0, 160));

    console.log('\nB. 모집공고 목록(관리자) — 공고마다');
    const l1 = await hit('/api/trackb/campaigns/list', T.outStaff);
    const byId = new Map(((l1.body && l1.body.data) || []).map(c => [c.id, c]));
    ok('B15 목록 응답 200 · 공고 4개', l1.status === 200 && byId.size === 4, l1.status + ' ' + l1.text.slice(0, 200));
    ok('B16 지워진 오더 공고·이름 바뀐 공고에만 { deletedAt }',
      !!(byId.get('c-del') || {}).sourceOrderDeleted && !!(byId.get('c-gid') || {}).sourceOrderDeleted
      && !(byId.get('c-live') || {}).sourceOrderDeleted && !(byId.get('c-none') || {}).sourceOrderDeleted);
    ok('B17 목록 어디에도 지운 직원 이름 없음 · 값은 deletedAt 하나뿐',
      !l1.text.includes(DELETER) && Object.keys((byId.get('c-del') || {}).sourceOrderDeleted || { x: 1 }).join(',') === 'deletedAt');
    const l2 = await hit('/api/campaign/admin/list', T.admin);
    ok('B18 관리자 목록(/api/campaign/admin/list)도 같은 판정', l2.status === 200 && ((l2.body && l2.body.data) || []).some(c => c.id === 'c-del' && c.sourceOrderDeleted));
    sodDown = true;
    const l3 = await hit('/api/trackb/campaigns/list', T.outStaff);
    sodDown = false;
    ok('B19 판정 조회 실패 → 목록은 그대로 · 표시만 없음', l3.status === 200 && ((l3.body && l3.body.data) || []).length === 4 && noBadge(l3.text));
  } finally {
    srv.close();
  }

  /* ── C. 정적 — 공개 뷰 함수에 칸이 들어가면 실패 ─────────── */
  console.log('\nC. 정적 배선');
  const routes = read('server/src/routes/campaign.routes.js');
  const fnBody = (src, sig, end) => { const i = src.indexOf(sig); return i < 0 ? '' : src.slice(i, end ? src.indexOf(end, i + sig.length) : undefined); };
  const pub = fnBody(routes, 'function _publicView(', '\nfunction ');
  const scoped = fnBody(routes, 'function _scopedEditorView(', '\n}\n');
  const pubList = fnBody(routes, "router.get('/list', async", '\nrouter.');
  ok('C1 _publicView · _scopedEditorView · 공개 목록에 표시 칸이 없다',
    pub && scoped && pubList && ![pub, scoped, pubList].some(b => /sourceOrderDeleted|source_order_deleted/.test(b)));
  const det = fnBody(routes, 'async function getCampaignDetail(', '\n// 관리자 수정 모달은');
  const adminStart = det.indexOf('if (isAdminDetail) {');
  const adminEnd = det.indexOf('const now = new Date();', adminStart);
  const firstUse = det.indexOf('sourceOrderDeleted');
  const lastUse = det.lastIndexOf('sourceOrderDeleted');
  ok('C2 상세에서는 관리자 갈래(if (isAdminDetail) { … }) 안에서만 쓴다',
    adminStart > 0 && firstUse > adminStart && lastUse < adminEnd, `admin=${adminStart} first=${firstUse} last=${lastUse} end=${adminEnd}`);
  ok('C3 판정은 단일 출처(sourceOrderDeletedMap + sourceOrderDeletedForTab) — 공고 쪽 SQL 사본 없음',
    /sourceOrderDeletedMap\(\)/.test(det) && /sourceOrderDeletedForTab\(/.test(routes)
    && !/deleted_by_name/.test(routes));

  /* ── D. 화면 — 카드(관리자만) · 수정 창 · 표시 없을 때 불변 ───── */
  console.log('\nD. 화면');
  const cards = read('frontend/js/campaign-cards.js');
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
  const c0 = { id: 'c1', title: '테스트 공고', participation_mode: true, status: 'active' };
  const sodV = { deletedAt: '2026-11-18T03:00:00Z' };
  const hAdm = CC.cardHtml({ ...c0, sourceOrderDeleted: sodV }, { admin: true });
  const hAdmNone = CC.cardHtml({ ...c0 }, { admin: true });
  const hRev = CC.cardHtml({ ...c0, sourceOrderDeleted: sodV }, { admin: false });
  const hRevNone = CC.cardHtml({ ...c0 }, { admin: false });
  ok('D1 관리자 카드에 「원본 오더 삭제됨」(홈 작업 목록과 같은 글자)', hAdm.includes('>원본 오더 삭제됨<'));
  ok('D2 마우스를 올리면 날짜와 설명(인트라넷 수정이 더 반영되지 않음 · 보관 안내) · 이름 없음',
    /title="이 공고의 원본 오더가 삭제됐습니다\(11\/18\)\.[^"]*인트라넷[^"]*반영되지 않습니다[^"]*보관/.test(hAdm) && !hAdm.includes(DELETER), (hAdm.match(/title="이 공고의 원본[^"]*"/) || [''])[0]);
  ok('D3 리뷰어 카드(admin:false)는 값이 와도 그리지 않는다(두 번째 잠금)', !hRev.includes('원본 오더 삭제됨') && hRev === hRevNone);
  ok('D4 값이 없으면 관리자 카드는 종전과 한 글자도 다르지 않다', hAdmNone === CC.cardHtml({ ...c0, sourceOrderDeleted: null }, { admin: true }) && !hAdmNone.includes('원본 오더 삭제됨'));
  ok('D5 보관된 공고에는 「보관하세요」 안내를 붙이지 않는다',
    (() => { const h = CC.cardHtml({ ...c0, archived_at: '2026-11-19', sourceOrderDeleted: sodV }, { admin: true }); return h.includes('>원본 오더 삭제됨<') && !/title="이 공고의 원본[^"]*보관으로/.test(h); })());
  ok('D6 표시 조각을 CampCards 로 내보낸다(수정 창이 같은 조각을 쓴다 — 문구 사본 0)', typeof CC.sourceOrderDeletedHtml === 'function');
  ok('D7 링크 화살표(↗)·이니셜 아바타 없음', !/↗/.test(typeof CC.sourceOrderDeletedHtml === 'function' ? CC.sourceOrderDeletedHtml(sodV) : '↗'));

  const recruit = read('frontend/js/index-recruit.js');
  const modal = read('frontend/js/recruit-modal.js');
  ok('D8 수정 창 자리(rf_order_deleted · 처음엔 숨김)가 「리뷰오더 고유 항목」 머리에 있다',
    /<h3>리뷰오더 고유 항목<\/h3>[\s\S]{0,400}id="rf_order_deleted"[^>]*hidden/.test(modal));
  const fnSrc = (() => { const i = recruit.indexOf('function _rfApplySourceOrderDeleted('); return i < 0 ? '' : recruit.slice(i, recruit.indexOf('\n}\n', i) + 2); })();
  ok('D9 수정 창 그리기 함수가 있다', !!fnSrc);
  if (fnSrc) {
    const slot = { hidden: true, innerHTML: '' };
    const sb2 = { document: { getElementById: (id) => (id === 'rf_order_deleted' ? slot : null) }, window: { CampCards: CC } };
    vm.createContext(sb2); vm.runInContext(fnSrc, sb2);
    sb2._rfApplySourceOrderDeleted(sodV, null);
    ok('D10 값이 오면 보이고 카드와 같은 조각을 그린다', slot.hidden === false && slot.innerHTML === CC.sourceOrderDeletedHtml(sodV, { archived: false }));
    sb2._rfApplySourceOrderDeleted(null, null);
    ok('D11 값이 없으면(옛 서버·조회 실패·다른 공고) 비우고 숨긴다 — 앞 공고 표시가 남지 않는다', slot.hidden === true && slot.innerHTML === '');
  }
  ok('D12 수정 창을 열 때 상세 응답의 sourceOrderDeleted 로 부른다',
    /_rfApplySourceOrderDeleted\(json && json\.sourceOrderDeleted \|\| null, c\.archived_at \|\| null\)/.test(recruit));
  ok('D13 새 공고 창(초기화)에서도 비운다', /_rfApplySourceOrderDeleted\(null, null\)/.test(recruit));

  console.log(`\n${fail ? '❌' : '✅'} campaignSourceDeletedBadge: ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
