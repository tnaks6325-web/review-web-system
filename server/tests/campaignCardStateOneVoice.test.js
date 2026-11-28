/**
 * campaignCardStateOneVoice.test.js — 결정 432 회귀가드(모집안내 점검 M2 · M3 · L1)
 * 실행: node tests/campaignCardStateOneVoice.test.js
 *
 * M2  보관(내린) 공고를 링크로 열면 공고 화면이 「끝난 공고」여야 한다 — 서버 공개 상세가 state:'closed'
 *     (stateReason:'archived')로 보내고, 참여 거절(403 archived · 409 closed)을 받은 공고 화면은
 *     [참여하기]를 되살리지 않고 끝난 모습으로 바뀐다(옛 서버가 여전히 'open' 이라 해도).
 * M3  한 카드가 두 말을 하지 않는다 — 「지금 이 사람이 할 수 있는 일」은 CampCards.reviewerNow 한 함수.
 *     품절 멈춤·재참여 대기 카드는 사진 위 「● 지금 구매 가능」 띠를 그리지 않고, 정렬도 맨 위 묶음이 아니다.
 * L1  초록 「바로참여」는 지금 바로 참여할 수 있는 카드에만.
 * 관리자 카드·관리자 목록 상태는 종전 그대로(직원 화면 불변).
 *
 * A = 실제 라우터 HTTP(스텁 DB) · B = 카드 렌더러 vm 실행 · C = 홈 정렬 재료 순서 · D = 공고 화면 거절 처리(vm) · E = 버전 표.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'campaign-card-one-voice-secret';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const BASE = {
  status: 'active', reviewer_hidden: false, created_at: '2026-11-01T00:00:00Z',
  channel: '네이버', channel_custom: '', time_range: '', delivery_type: '실배송',
  review_fee: 3000, badges: '[]', sort_order: 0, deadline: null, is_popular: false,
  work_kind: 'review', carry_strategy: null, linked_tab_gid: '', manager: '망고', notes: '', chat_url: '',
  description: '', linked_sheet_id: '', linked_tab_name: '', max_slots: 0, current_slots: 0,
};
const PART = {
  ...BASE, participation_mode: true,
  daily_limit: 5, recruit_total: 50, window_start: null, window_end: null,
  close_buffer_min: 0, hold_ttl_min: 20, start_date: null, multi_account_mode: 'off', sub_hold_ttl_min: 10,
  carry_mode: 'auto', skip_weekends: false, cash_receipt_required: false, soldout_paused_at: null,
  thumbnail_url: '', delivery_review_fee_mix: null,
};
const ARCH_AT = '2026-11-26T03:00:00Z';
const CAMPS = [
  { ...PART, id: 'c-live', title: '열린 공고', archived_at: null },
  { ...PART, id: 'c-arch', title: '보관된 공고', archived_at: ARCH_AT, archived_by: '직원' },
  { ...BASE, id: 'c-legacy-arch', title: '보관된 옛 방식', participation_mode: false, archived_at: ARCH_AT, max_slots: 10, current_slots: 1 },
];

async function serverPart() {
  console.log('\nA. 서버 — 보관 공고 공개 상세는 「끝난 공고」 · 참여 거절은 그대로 · 직원 화면 불변');
  const pool = require('../src/db/pool');
  pool.query = async (sql, params) => {
    const s = String(sql);
    if (/SELECT \* FROM recruit_campaigns WHERE id = \$1/.test(s)) {
      return { rows: CAMPS.filter(c => c.id === (params || [])[0]).map(c => ({ ...c })) };
    }
    if (/FROM recruit_campaigns/.test(s) && /archived_at IS NOT NULL/.test(s) && /ORDER BY/.test(s)) {
      return { rows: CAMPS.filter(c => c.archived_at).map(c => ({ ...c })) };
    }
    if (/FROM recruit_campaigns/.test(s) && /archived_at IS NULL/.test(s) && /ORDER BY/.test(s)) {
      return { rows: CAMPS.filter(c => !c.archived_at).map(c => ({ ...c })) };
    }
    if (/COUNT\(\*\) AS n FROM recruit_campaigns WHERE archived_at IS NOT NULL/.test(s)) return { rows: [{ n: 2 }] };
    return { rows: [] };
  };
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const app = express(); app.use(express.json());
  app.use('/api/campaign', require('../src/routes/campaign.routes'));
  app.use((err, req, res, _next) => res.status(500).json({ ok: false, error: String(err && err.message) }));
  const srv = await new Promise(res => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const hit = async (p, tok, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = 'Bearer ' + jwt.sign(tok, process.env.JWT_SECRET);
    const r = await fetch(base + p, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    const text = await r.text();
    let b = null; try { b = JSON.parse(text); } catch (_) { /* noop */ }
    return { status: r.status, body: b, text };
  };
  const ADMIN = { role: 'admin', name: '관리자' };
  try {
    const live = await hit('/api/campaign/c-live');
    const lv = (live.body && live.body.data) || {};
    ok('A0 대조군: 보관 안 된 같은 공고는 열려 있다(state open)', live.status === 200 && lv.state === 'open', live.status + ' ' + live.text.slice(0, 160));
    const arc = await hit('/api/campaign/c-arch');
    const av = (arc.body && arc.body.data) || {};
    ok('A1 ★ 보관 공고를 링크로 열면 state 가 open 이 아니다 — closed', arc.status === 200 && av.state === 'closed', JSON.stringify({ state: av.state, reason: av.stateReason }));
    ok('A2 ★ 끝난 이유 = archived · 쉬운 말 한 줄', av.stateReason === 'archived' && /모집이 끝난 공고/.test(String(av.stateMessage || '')), JSON.stringify({ r: av.stateReason, m: av.stateMessage }));
    ok('A3 공개 칸은 늘지 않는다(결정 431 허용 목록 — 같은 키 집합 · archived_at 비공개)',
      JSON.stringify(Object.keys(av).sort()) === JSON.stringify(Object.keys(lv).sort()) && !('archived_at' in av) && !('archived_by' in av),
      'diff=' + Object.keys(av).filter(k => !(k in lv)).concat(Object.keys(lv).filter(k => !(k in av))).join(','));
    const la = await hit('/api/campaign/c-legacy-arch');
    const lav = (la.body && la.body.data) || {};
    ok('A4 옛 방식 보관 공고도 state closed(옛 화면이 status=active 로 「모집 중」이라 하지 않게)', la.status === 200 && lav.state === 'closed' && lav.stateReason === 'archived', JSON.stringify({ s: lav.state, r: lav.stateReason }));
    const ap = await hit('/api/campaign/c-arch/apply', null, { name: '김예시', phone: '00000000', phone8: '00000000' });
    ok('A5 참여는 종전대로 403 archived 「모집이 종료된 공고입니다.」', ap.status === 403 && ap.body && ap.body.reason === 'archived' && /모집이 종료된 공고/.test(ap.body.error || ''), ap.status + ' ' + ap.text.slice(0, 160));
    const ad = await hit('/api/campaign/admin/c-arch', ADMIN);
    const adv = (ad.body && ad.body.data) || {};
    ok('A6 직원 수정 창(/admin/:id)은 전체 행 그대로(archived_at 포함 · 공개 상태 덮기 없음)', ad.status === 200 && adv.archived_at && !('stateReason' in adv) && adv.status === 'active', ad.status + ' ' + ad.text.slice(0, 160));
    const al = await hit('/api/campaign/admin/list?archived=1', ADMIN);
    const row = (((al.body && al.body.data) || []).find(c => c.id === 'c-arch')) || {};
    ok('A7 직원 보관함 목록 카드 상태는 종전 그대로(상태엔진 결과 — 보관을 상태로 섞지 않는다 · 결정 048)', al.status === 200 && row.state === 'open', al.status + ' state=' + row.state);
  } finally { srv.close(); }

  const st = require('../src/services/campaignState.service');
  ok('A8 판정 한 곳: isArchivedCampaign · reviewerArchivedState 를 상태 서비스가 내보낸다',
    typeof st.isArchivedCampaign === 'function' && typeof st.reviewerArchivedState === 'function'
    && st.isArchivedCampaign({ archived_at: ARCH_AT }) === true && st.isArchivedCampaign({ archived_at: null }) === false
    && st.reviewerArchivedState({ archived_at: null }) === null);
  const routes = read('server/src/routes/campaign.routes.js');
  ok('A9 참여 관문도 같은 판정(isArchivedCampaign(camp))을 쓴다 — 화면 상태와 참여 관문이 갈리지 않게', /if \(isArchivedCampaign\(camp\)\) \{\s*return res\.status\(403\)\.json\(\{ ok: false, reason: 'archived'/.test(routes));
  const svc = read('server/src/services/campaignState.service.js');
  const cs = svc.slice(svc.indexOf('function computeCampaignState('), svc.indexOf('\nasync function fetchCampaignCounts('));
  ok('A10 상태엔진(computeCampaignState)은 보관을 보지 않는다 — 직원 목록·외부모집·부족 알림 등 17곳 불변', cs.length > 1000 && !/archived/.test(cs));
}

function cardsPart() {
  console.log('\nB. 카드 — 한 함수(reviewerNow)가 띠·버튼·정렬·「바로참여」를 정한다');
  const el = () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
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
  vm.runInContext(read('frontend/js/campaign-cards.js'), sb, { filename: 'campaign-cards.js' });
  const CC = sb.window.CampCards;
  CC.setServerNow('2026-11-27T02:00:00.000Z');
  const H = 3600e3, at = (h) => new Date(Date.parse('2026-11-27T02:00:00.000Z') + h * H).toISOString();
  const b = { participation_mode: true, status: 'active', dailyQuota: 20, todayCount: 8, opensAt: at(-3), closesAt: at(5), review_fee: 3000 };
  const LOCK = { accounts: [{ type: 'self', displayName: '김예시', status: 'locked', availableFrom: at(24 * 5) }] };
  const cards = {
    open: { ...b, id: 'open', title: '열림', state: 'open', cutoffAt: at(3) },
    rep: { ...b, id: 'rep', title: '재참여', state: 'open', cutoffAt: at(3), repurchase: LOCK },
    paused: { ...b, id: 'paused', title: '멈춤', state: 'open', cutoffAt: at(2), soldoutPaused: true },
    closed: { ...b, id: 'closed', title: '종료', state: 'closed' },
    arch: { ...b, id: 'arch', title: '보관', state: 'closed', stateReason: 'archived', stateMessage: '모집이 끝난 공고예요' },
    cut: { ...b, id: 'cut', title: '구매마감', state: 'cutoff', closesAt: at(1) },
    pre: { ...b, id: 'pre', title: '오픈전', state: 'preopen', opensAt: at(2) },
    daily: { ...b, id: 'daily', title: '오늘마감', state: 'daily_done', reopensAt: at(14), todayCount: 20 },
    full: { ...b, id: 'full', title: '잔여대기', state: 'soft_full', todayCount: 20 },
    qna: { ...b, id: 'qna', title: 'Q&A', state: 'open', work_kind: 'qna', cutoffAt: at(4) },
    blogClosed: { ...b, id: 'blogc', title: '블로그 끝', state: 'closed', work_kind: 'blog' },
  };
  const html = (k, o) => CC.cardHtml(cards[k], o);
  const LIVE = /지금 구매 가능|지금 참여 가능/;
  ok('B0 reviewerNow 를 CampCards 로 내보낸다', typeof CC.reviewerNow === 'function');
  if (typeof CC.reviewerNow === 'function') {
    const codes = Object.fromEntries(Object.keys(cards).map(k => [k, CC.reviewerNow(cards[k])]));
    ok('B1 판정 값: 열림=join · 재참여 잠금=repurchase_wait · 품절 멈춤=paused · 나머지=서버 상태',
      codes.open === 'join' && codes.rep === 'repurchase_wait' && codes.paused === 'paused' && codes.closed === 'closed'
      && codes.cut === 'cutoff' && codes.pre === 'preopen' && codes.daily === 'daily_done' && codes.qna === 'join', JSON.stringify(codes));
    ok('B2 관리자(admin) 판정은 종전대로 서버 상태만 — 품절 멈춤도 join(띠·배지 그대로)', CC.reviewerNow(cards.paused, { admin: true }) === 'join');
  }
  ok('B3 열린 카드: 「● 지금 구매 가능」 + 「바로참여」 + [참여하기] (종전 그대로)', /지금 구매 가능/.test(html('open')) && /바로참여/.test(html('open')) && />참여하기</.test(html('open')));
  ok('B4 ★ 재참여 대기 카드: 버튼 「재참여 대기 중」 · 사진 위 「지금 구매 가능」 없음', /재참여 대기 중/.test(html('rep')) && !LIVE.test(html('rep')), html('rep').match(/live-pill[^<]*<span[^>]*><\/span>[^<]*/) + '');
  ok('B5 ★ 품절 멈춤 카드: 버튼 「품절로 잠시 멈춤」 · 사진 위 「지금 구매 가능」 없음', /품절로 잠시 멈춤/.test(html('paused')) && !LIVE.test(html('paused')));
  ok('B6 ★ 재참여 대기·품절 멈춤 카드엔 「바로참여」 없음', !/바로참여/.test(html('rep')) && !/바로참여/.test(html('paused')));
  for (const k of ['closed', 'arch', 'cut', 'pre', 'daily', 'full']) {
    ok(`B7 ★ ${cards[k].title}(${cards[k].state}) 카드엔 초록 「바로참여」 없음`, !/바로참여/.test(html(k)));
  }
  ok('B8 Q&A 열린 카드: 「지금 참여 가능」 + 「바로참여」 (종전 그대로)', /지금 참여 가능/.test(html('qna')) && /바로참여/.test(html('qna')));
  ok('B9 블로그 카드는 종류 글자 「승인제」 그대로(상태와 무관한 종류 표시)', /승인제/.test(html('blogClosed')));
  ok('B10 보관(끝난) 공고 카드: 「모집 종료」 리본 · [참여하기] 없음 · 띠 없음', /모집 종료/.test(html('arch')) && !/>참여하기</.test(html('arch')) && !LIVE.test(html('arch')));
  const order = CC.sortByAvailability([cards.rep, cards.paused, cards.closed, cards.pre, cards.open, cards.daily]).map(c => c.id).join(',');
  ok('B11 ★ 정렬: 지금 참여 가능 → 곧 열림 → (재참여 대기·품절 멈춤·오늘 마감 = 같은 등급, 원래 순서) → 종료', order === 'open,pre,rep,paused,daily,closed', order);
  const noRep = CC.sortByAvailability([{ ...cards.rep, repurchase: undefined }, cards.open]).map(c => c.id).join(',');
  ok('B12 재참여 결과가 아직 없으면(조회 전·옛 서버) 종전처럼 열린 카드 등급', noRep === 'rep,open', noRep);
  // 관리자 카드 불변
  const ap = CC.cardHtml(cards.paused, { admin: true }), ac = CC.cardHtml(cards.closed, { admin: true });
  ok('B13 관리자 카드: 품절 멈춤이어도 띠 「지금 구매 가능」·「바로참여」 종전 그대로', /지금 구매 가능/.test(ap) && /바로참여/.test(ap));
  ok('B14 관리자 카드: 종료 카드의 「바로참여」도 종전 그대로(직원 화면 불변)', /바로참여/.test(ac));
  // 한 함수 배선(정적)
  const cc = read('frontend/js/campaign-cards.js');
  const card = cc.slice(cc.indexOf('function cardHtml('), cc.indexOf('function sortByAvailability('));
  const sortFn = cc.slice(cc.indexOf('function sortByAvailability('), cc.indexOf('function qnaFirst('));
  ok('B15 카드 그리기는 reviewerNow 를 한 번 부르고 띠·버튼·「바로참여」가 그 값을 본다',
    (card.match(/reviewerNow\(c, \{ admin \}\)/g) || []).length === 1
    && /now === 'join' && c\.cutoffAt/.test(card) && /now === 'paused'/.test(card) && /now === 'repurchase_wait'/.test(card)
    && /now === 'join' \? '<span class="pt-live">바로참여<\/span>'/.test(card));
  ok('B16 정렬도 같은 함수', /reviewerNow\(c\)/.test(sortFn) && !/_soldoutPaused\(c\)/.test(sortFn));
}

function homePart() {
  console.log('\nC. 홈 — 재참여 결과를 붙인 뒤에 정렬한다(정렬이 「재참여 대기」를 알아야 아래로 보낸다)');
  const ih = read('frontend/index.html');
  const fn = ih.slice(ih.indexOf('function _renderRecruitPreview('), ih.indexOf('function _renderRecruitPreview(') + 4000);
  const iAttach = fn.indexOf('c.repurchase = rs'), iSort = fn.indexOf('CampCards.sortByAvailability(');
  ok('C1 ★ c.repurchase 를 붙이는 줄이 정렬보다 앞', iAttach > 0 && iSort > 0 && iAttach < iSort, `attach=${iAttach} sort=${iSort}`);
  ok('C2 캐시된 옛 재참여 상태를 지우는 줄도 그대로(delete c.repurchase)', /else delete c\.repurchase;/.test(fn));
}

function campaignPagePart() {
  console.log('\nD. 공고 화면 — 「끝났다」 거절이면 끝난 모습으로 · [참여하기]를 되살리지 않는다');
  const ch = read('frontend/campaign.html');
  const grab = (sig) => { const a = ch.indexOf(sig); if (a < 0) return ''; const e = ch.indexOf('\n}\n', a); return ch.slice(a, e + 2); };
  const constLine = (ch.match(/const _ENDED_REFUSALS = \[[^\]]*\];/) || [''])[0];
  const src = constLine + '\nlet _endedMask = null;\n' + grab('function _isEndedRefusal(') + '\n' + grab('function _applyEndedMask(');
  ok('D0 판정·덮기 함수가 있다', !!constLine && /function _isEndedRefusal\(/.test(src) && /function _applyEndedMask\(/.test(src));
  if (constLine) {
    const x = {}; vm.createContext(x);
    vm.runInContext(src + '\nthis.isEnd = _isEndedRefusal; this.mask = (r, c) => { _endedMask = r; return _applyEndedMask(c); };', x);
    ok('D1 끝났다 거절 = archived · closed', x.isEnd({ reason: 'archived' }) && x.isEnd({ reason: 'closed' }));
    ok('D2 다시 열릴 수 있는 거절(오늘 마감·대기·멈춤·오픈 전·명의 사유)은 아니다',
      ['cutoff', 'daily_done', 'soft_full', 'campaign_paused', 'preopen', 'duplicate_hold', 'rate_limited'].every(r => !x.isEnd({ reason: r })) && !x.isEnd(null) && !x.isEnd({}));
    const c1 = x.mask('archived', { state: 'open', stateReason: '' });
    ok('D3 ★ 옛 서버가 여전히 open 이라 해도 덮으면 closed · archived', c1.state === 'closed' && c1.stateReason === 'archived', JSON.stringify(c1));
    const c2 = x.mask(null, { state: 'open' });
    ok('D4 거절이 없었으면 손대지 않는다', c2.state === 'open');
  }
  const load = grab('function loadCampaign(');
  ok('D5 다시 받아도(15초 갱신·카운트다운) 덮기 유지 — loadCampaign 이 _camp 를 받은 직후 _applyEndedMask', /_camp = j\.data;[\s\S]{0,400}_applyEndedMask\(_camp\)/.test(load));
  const apply = grab('async function _doApply(');
  const iEnd = apply.indexOf('_isEndedRefusal(j)'), iGeneric = apply.lastIndexOf('await loadCampaign(); // 카운터/상태 갱신');
  ok('D6 ★ 참여하기 거절 처리: 끝났다 거절이면 덮기 + 끝난 화면(일반 「다시 받기」 갈래보다 앞)', iEnd > 0 && iGeneric > 0 && iEnd < iGeneric
    && /if\(_isEndedRefusal\(j\)\)\{ _endedMask = j\.reason;[\s\S]{0,700}renderPre\(\)/.test(apply));
  ok('D7 ★ finally 가 열려 있지 않은 공고의 버튼을 회색 「참여하기」로 남기지 않는다(그 상태 말로 다시 그림)',
    /finally\{[\s\S]{0,700}if\(c && c\.state !== 'open'\) renderPre\(\);/.test(apply));
  // ★ #1895 리뷰(P2): 이미 참여해 구매·제출 화면을 보던 사람이 「타계정으로 추가참여」를 끝났다로 거절당해도
  //   보던 화면(vJoined)을 참여 전 화면으로 바꾸지 않는다 — loadCampaign 과 같은 「참여 전 화면일 때만」 가드.
  const endBranch = (apply.match(/if\(_isEndedRefusal\(j\)\)\{[\s\S]*?return; \}/) || [''])[0];
  ok('D11 ★ 끝났다 거절 갈래의 renderPre 는 참여 전 화면(vPre·vLoading)일 때만 — 참여 중 화면을 덮지 않는다',
    !!endBranch && /renderPre\(\)/.test(endBranch)
    && !/_applyEndedMask\(_camp\);\s*renderPre\(\)/.test(endBranch)
    && /\$\('vPre'\)\.style\.display !== 'none' \|\| \$\('vLoading'\)\.style\.display !== 'none'\)\s*renderPre\(\)/.test(endBranch), endBranch.slice(0, 300));
  const many = ch.slice(ch.indexOf('async function _applyMany('), ch.indexOf('async function _applyMany(') + 6000);
  ok('D8 여러 명의 참여도 끝났다 거절이면 나머지 명의를 보내지 않는다(목록에 archived)', /\['closed','archived','cutoff'/.test(many));
  ok('D9 거절 문구표에 archived(모집 종료와 같은 말)', /archived:'모집이 종료됐어요'/.test(ch));
  ok('D10 참여 전 화면 아래 안내: 보관 공고는 「모집이 끝난 공고예요」', /c\.stateReason==='archived' \? \(c\.stateMessage \|\| '모집이 끝난 공고예요'\)/.test(ch));
}

function versionPart() {
  console.log('\nE. 캐시 — 카드 파일 버전 표(공유 목록 recruit.html 은 다른 작업이 고치는 중이라 손대지 않음 · /js/* no-cache)');
  for (const f of ['frontend/index.html', 'frontend/campaign.html', 'frontend/workdesk.html']) {
    ok(`E1 ${f}: campaign-cards.js?v=20261127-onevoice`, read(f).includes('js/campaign-cards.js?v=20261127-onevoice'));
  }
  ok('E2 /js/* 는 no-cache(옛 버전 표를 단 화면도 새 파일을 다시 확인한다)', /\/js\/\*\s*\n\s*Cache-Control: no-cache/.test(read('frontend/_headers')));
}

(async () => {
  console.log('\n▶ 결정 432 — 한 카드는 한 말 · 보관 공고는 끝난 공고 · 바로참여는 지금 될 때만\n');
  await serverPart();
  cardsPart();
  homePart();
  campaignPagePart();
  versionPart();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
