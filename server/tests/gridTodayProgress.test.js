/**
 * gridTodayProgress.test.js — 작업보드 표 툴바 "오늘 참여현황" 표기 회귀가드
 * 실행: node tests/gridTodayProgress.test.js
 * 시안: frontend/docs/design-grid-today-progress.html (사용자 확정 = C안 도넛 + B안 파란 날짜)
 *
 * 이 표기가 깨지면 아픈 것 여섯. 전부 "숫자가 조용히 틀리는" 종류다.
 *  ① **정원 판정 사본** — 툴바가 "일건수 + 이월" 로 되계산하면 066 이월 상한·095 날짜별 조절·
 *     098 이월 보류·총량 clamp 를 모르는 두 번째 기준이 생겨 **카드·[📅 인원] 과 숫자가 갈린다**.
 *     → `computeCampaignState` 를 실제로 태우는지 **실행으로** 고정(총량 clamp 케이스로 검출).
 *  ② **분자에 홀드 혼입** — 확정+진행중을 한 숫자로 합치면 홀드 만료 때 **숫자가 줄어든다**
 *     ("12명이었는데 10명이 됐다"). 분자는 `todaySubmitted` 뿐이고 홀드는 따로 싣는다.
 *  ③ **0 으로 위장** — 조회 실패·공고 없음을 `0/0` 으로 그리면 "오늘 할 일 없음"으로 읽힌다.
 *     "없다(정원 0)"와 "모른다(공고 없음·실패)"는 화면에서 다른 모양이어야 한다.
 *  ④ **클라이언트 gid 신뢰** — 낡은 화면이 보낸 gid 로 공고를 찾으면 **같은 시트 다른 탭의 정원**이
 *     이 표에 뜬다. gid 는 서버가 `tab_configs` 에서 다시 구한다(스코프 판정과 같은 규율).
 *  ⑤ **광고주 노출** — 정원·모집 기준은 내부 운영값이다. 광고주 응답에 실리면 안 된다.
 *  ⑥ **툴바 높이 증가** — 칩이 다른 컨트롤보다 높으면 툴바가 늘어 표가 아래로 밀린다(28px 계약).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 작업보드 "오늘 참여현황" 표기 회귀가드\n');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const WD = F('workdesk.html');
const SVC_SRC = S('src/services/trackB.service.js');

/* ══ 1) 서비스 — 스텁 pool 로 실제 실행 ═══════════════════════════════════════ */
console.log('1) tabTodayProgress (서비스 실행)');
const pool = require('../src/db/pool');
const svc = require('../src/services/trackB.service');

const CAMP = (o) => Object.assign({
  id: 'c1', title: '공고A', status: 'active', participation_mode: true,
  linked_sheet_id: 'S1', linked_tab_name: 'T1', linked_tab_gid: '111',
  daily_limit: 20, recruit_total: 0, hold_ttl_min: 15, close_buffer_min: 10,
  window_start: null, window_end: null, start_date: null, carry_mode: 'auto',
  created_at: new Date('2026-08-01T00:00:00Z'),
}, o);

// SQL 갈래별 스텁. 반환 못 정한 쿼리는 빈 행(= 계획·기준선 없음 = 기존 동작).
let SQL = [];
const stub = ({ camps = [], gid = '111', counts = null, fail = null } = {}) => {
  SQL = [];
  pool.query = async (q, p) => {
    const s = String(q); SQL.push({ q: s, p });
    if (fail && fail(s)) throw new Error('boom');
    if (/FROM recruit_campaigns/.test(s)) return { rows: camps };
    if (/FROM tab_configs/.test(s)) return { rows: gid === null ? [] : [{ gid }] };
    if (/FROM campaign_applications/.test(s)) return { rows: counts || [] };
    return { rows: [] };
  };
};
const CNT = (id, o) => Object.assign({
  campaign_id: id, active_holds: 0, today_active_holds: 0, submitted_all: 0,
  today_submitted: 0, submitted_before_today: 0, submitted_since_carry: 0, submitted_since_hold: 0,
}, o);

(async () => {
  const call = () => svc.tabTodayProgress(pool, { sheetId: 'S1', tabName: 'T1' });

  // ── 연결 공고 0건 = "정원을 정할 수 없음". 0/0 으로 꾸미지 않는다.
  stub({ camps: [] });
  let r = await call();
  t('연결 공고 없음 → quota null + reason no_campaign (0 으로 위장 금지)',
    r.ok === true && r.quota === null && r.reason === 'no_campaign', JSON.stringify(r));
  t('오늘 날짜(KST)를 함께 준다', /^\d{4}-\d{2}-\d{2}$/.test(r.dateStr), r.dateStr);

  // ── 게시 전(draft)·레거시는 "오늘 사람을 받는 공고"가 아니다.
  stub({ camps: [CAMP({ status: 'draft' })] });
  t('게시 전 공고 → no_live_campaign', (await call()).reason === 'no_live_campaign');
  stub({ camps: [CAMP({ participation_mode: false })] });
  t('레거시(카톡 신청) 공고 → no_live_campaign (정원 개념 없음)', (await call()).reason === 'no_live_campaign');

  // ── ★★ 핵심: 분자는 확정만, 홀드는 따로.
  stub({ camps: [CAMP()], counts: [CNT('c1', { today_submitted: 12, today_active_holds: 2 })] });
  r = await call();
  t('정원 20 · 구매 완료 12', r.quota === 20 && r.done === 12, JSON.stringify(r));
  t('★ 분자에 진행 중(홀드)을 섞지 않는다 — 만료 때 숫자가 줄어든다', r.done === 12 && r.holds === 2);
  t('공고 1개', r.campaignCount === 1);

  // ── ★★ 판정이 computeCampaignState 를 실제로 태우는지: 총량 clamp 로 검출.
  //    (일건수만 베껴 쓰면 20 이 나온다 — 남은 자리는 1 이다.)
  stub({ camps: [CAMP({ recruit_total: 5 })], counts: [CNT('c1', { submitted_before_today: 4, today_submitted: 0 })] });
  r = await call();
  t('★ 총량 clamp 반영 — 남은 자리만 연다(정원 판정 사본 금지)', r.quota === 1, 'quota=' + r.quota);

  // ── 총원 충족 = "오늘 열린 자리 0"(있는 사실). 모름과 다른 상태여야 한다.
  stub({ camps: [CAMP({ recruit_total: 5 })], counts: [CNT('c1', { submitted_before_today: 5 })] });
  r = await call();
  t('총원 충족 → quota 0 (null 아님 = "없다"와 "모른다"의 구분)', r.quota === 0 && r.reason === null);

  // ── 차수 재발행 등으로 살아있는 공고가 여럿이면 합산하고 그 사실을 말한다.
  stub({
    camps: [CAMP({ id: 'c1' }), CAMP({ id: 'c2', daily_limit: 10 })],
    counts: [CNT('c1', { today_submitted: 12 }), CNT('c2', { today_submitted: 3 })],
  });
  r = await call();
  t('공고 여럿 → 합산(하나만 골라 쓰면 나머지 물량이 조용히 빠진다)', r.quota === 30 && r.done === 15);
  t('합산했다는 사실을 campaignCount 로 말한다', r.campaignCount === 2);

  // ── ④ gid 는 서버가 다시 구한다 + 이름이 바뀌어도 gid 로 찾는다.
  const campSql = SQL.find(x => /FROM recruit_campaigns/.test(x.q));
  t('★ 공고 조회에 gid 폴백이 있다(탭 리네임으로 연결이 조용히 풀리지 않게)',
    /linked_tab_gid/.test(campSql.q));
  t('★ gid 는 tab_configs 에서 읽는다(클라이언트 값 미신뢰)',
    SQL.some(x => /FROM tab_configs/.test(x.q) && /tab_gid/.test(x.q)));
  // ★ **선언부만** 본다 — 호출부(`tabTodayProgress(db, { sheetId, tabName })`)까지 허용하면
  //   선언에 tabGid 를 되살려도 호출부 문자열이 대신 통과시킨다(변이시험이 실제로 뚫었다).
  const TP_DECL = /async function tabTodayProgress\(db, \{([^}]*)\}/.exec(SVC_SRC);
  t('선언부를 찾았다', !!TP_DECL, SVC_SRC.slice(SVC_SRC.indexOf('async function tabTodayProgress'), SVC_SRC.indexOf('async function tabTodayProgress') + 90));
  t('★ 시그니처가 tabGid 를 받지 않는다(받으면 낡은 화면이 남의 탭 정원을 띄운다)',
    !/tabGid/.test(TP_DECL[1]), TP_DECL[1]);
  // ★ 빈 gid 는 조건을 만들지 않는다 — 만들면 gid 없는 공고가 전부 이 탭에 매칭된다.
  //   (스텁은 SQL 을 해석하지 않으므로 쿼리문·바인딩으로 고정한다.)
  t("★ 빈 gid 는 gid 절을 켜지 않는다($3 <> '' 가드)", /\$3 <> ''/.test(campSql.q), campSql.q);
  stub({ camps: [], gid: '' });
  await call();
  const campSql2 = SQL.find(x => /FROM recruit_campaigns/.test(x.q));
  t('gid 미보유 탭은 빈 문자열로 바인딩된다(NULL 매칭 사고 방지)', campSql2.p[2] === '', JSON.stringify(campSql2.p));

  // ── ⑦ 어떤 실패도 throw 하지 않는다(작업보드 로딩을 죽이지 않는다) + ok:false 로 말한다.
  stub({ fail: s => /FROM recruit_campaigns/.test(s) });
  r = await call();
  t('조회 실패 → throw 없이 ok:false (0/0 으로 위장하지 않는다)', r.ok === false && r.quota === null);

  /* ══ 2) 배선 · 노출 범위 ══════════════════════════════════════════════════ */
  console.log('\n2) workdeskTab 배선 · 노출 범위');
  const wdBlock = SVC_SRC.slice(SVC_SRC.indexOf('async function workdeskTab('), SVC_SRC.indexOf('function tabTodayProgress') > 0 ? SVC_SRC.length : undefined);
  const showEditsBlock = SVC_SRC.slice(SVC_SRC.indexOf('if (showEdits) {\n    res.hiddenRows'), SVC_SRC.indexOf('else if (role === \'advertiser\')'));
  t('★ todayProgress 는 showEdits(내부인) 분기 안에서만 실린다 — 광고주 응답 미동봉',
    /res\.todayProgress = await tabTodayProgress\(/.test(showEditsBlock));
  t('광고주 분기에는 없다', !/todayProgress/.test(SVC_SRC.slice(SVC_SRC.indexOf("else if (role === 'advertiser') { res.headers"), SVC_SRC.indexOf("else if (role === 'advertiser') { res.headers") + 220)));
  t('export 되어 있다(가드·호출부가 쓴다)', typeof svc.tabTodayProgress === 'function');
  // ★ 함수 본문을 그 함수 범위로 잘라서 본다 — 고정 길이 슬라이스는 함수가 자라면 조용히 빗나간다.
  const TP_BODY = SVC_SRC.slice(SVC_SRC.indexOf('async function tabTodayProgress('),
    SVC_SRC.indexOf('// ══ M2: 열린 작업 줄'));
  t('본문을 실제로 잘라냈다', TP_BODY.length > 500 && /computeCampaignState/.test(TP_BODY));
  t('쓰기 쿼리 0 — 이 함수는 읽기 전용', !/\b(INSERT|UPDATE|DELETE)\b/i.test(TP_BODY));
  t('시트 API 무접촉', !/sheets|readSheet|writeSheet/i.test(TP_BODY));
  t('★ 정원은 computeCampaignState 의 dailyQuota 를 그대로 쓴다(사본 금지)',
    /st\.dailyQuota/.test(TP_BODY) && !/daily_limit/.test(TP_BODY));
  t('★ 분자는 todaySubmitted 뿐(홀드 미포함)',
    /done \+= Number\(counts\.todaySubmitted\)/.test(TP_BODY) && /holds \+= Number\(counts\.todayActiveHolds\)/.test(TP_BODY));

  /* ══ 3) 프론트 렌더러 — vm 으로 실제 실행 ════════════════════════════════ */
  console.log('\n3) _tpHtml (렌더러 실행)');
  const cut = (from, to) => WD.slice(WD.indexOf(from), WD.indexOf(to));
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(
    'const esc=' + /const esc=(s=>[\s\S]*?);\n/.exec(WD)[1] + ';\n'
    + cut('function _fmtKDate(v){', '// 입금 컬럼:')
    + cut('function _tpHtml(tp){', '// 시트형 그리드:'), sandbox);
  const tp = (o) => sandbox._tpHtml(o);
  const TODAY = '2026-08-10';   // 월요일

  t('필드 자체가 없으면 아무것도 그리지 않는다(광고주·구버전 백엔드)', tp(undefined) === '' && tp(null) === '');

  let h = tp({ ok: true, dateStr: TODAY, quota: 20, done: 12, holds: 2, campaignCount: 1 });
  t('진행 중 — 날짜·라벨·숫자', /8\/10 \(월\)/.test(h) && /참여현황/.test(h) && />12</.test(h) && /\/20명/.test(h), h);
  t('달성률이 도넛 각도로 들어간다', /--p:60/.test(h), h);
  t('진행 중은 상태 클래스 없음(파랑 기본)', /class="tprog "/.test(h), h);
  t('진행 중 인원을 툴팁으로 알린다(분자에는 안 섞고)', /진행 중 2명/.test(h));

  h = tp({ ok: true, dateStr: TODAY, quota: 20, done: 20, holds: 0, campaignCount: 1 });
  t('달성 → done 클래스 + [달성] 배지', /class="tprog done"/.test(h) && /달성/.test(h) && /--p:100/.test(h));

  h = tp({ ok: true, dateStr: TODAY, quota: 20, done: 23, holds: 0, campaignCount: 1 });
  t('초과 → over 클래스 + +3 (감추지 않는다)', /class="tprog over"/.test(h) && /\+3/.test(h));

  h = tp({ ok: true, dateStr: TODAY, quota: 0, done: 0, holds: 0, state: 'daily_done', stateReason: 'rest_day' });
  t('정원 0 → zero 클래스 + "오늘 모집 없음"', /class="tprog zero"/.test(h) && /오늘 모집 없음/.test(h));
  t('사유를 툴팁으로 말한다(휴무일)', /휴무일/.test(h), h);

  h = tp({ ok: true, dateStr: TODAY, quota: null, done: 12, reason: 'no_campaign' });
  t('★ 기준 모름 → unk(점선) + "모집 기준 없음" · 분모만 ?', /class="tprog unk"/.test(h) && /모집 기준 없음/.test(h) && /\/ \?명/.test(h));
  t('★ 구매한 인원은 사실이므로 그대로 보여준다', />12</.test(h), h);

  h = tp({ ok: false, dateStr: TODAY, quota: null, done: 0 });
  t('★ 조회 실패 → "불러오지 못함" (0/0 위장 금지)', /불러오지 못함/.test(h) && /\? \/ \?명/.test(h) && !/0\/0/.test(h));

  // 비정형 날짜는 _fmtKDate 가 원본을 유지하므로(설계), escape 가 유일한 방어다.
  h = tp({ ok: true, dateStr: 'x"><img src=x onerror=alert(1)>', quota: 20, done: 1 });
  t('★ 서버 문자열은 escape 된다(속성 탈출 금지)', !/<img/.test(h) && /&quot;/.test(h) && /&lt;img/.test(h), h);

  /* ══ 4) 툴바 배선 · CSS 계약 ═════════════════════════════════════════════ */
  console.log('\n4) 툴바 배선 · CSS 계약');
  t('★ 칩은 툴바 맨 앞 = 검색창 왼쪽(사용자 지시)',
    /<div class="gridbar">\s*\$\{_tpHtml\(wd\.todayProgress\)\}\s*<div class="gsearch">/.test(WD));
  t('★ 칩 높이 28px — 툴바의 다른 컨트롤과 같다(표가 아래로 안 밀린다)',
    /\.tprog\{[^}]*height:28px/.test(WD));
  t('도넛은 conic-gradient(외부 이미지·SVG 0)', /\.tprog \.ring\{[^}]*conic-gradient/.test(WD));
  t('★ 날짜 텍스트는 파랑(B안 믹스 — 사용자 확정)', /\.tprog \.d\{[^}]*color:var\(--accent-deep\)/.test(WD));
  t('상태 4색이 전부 정의돼 있다(진행·달성·초과·없음)',
    /\.tprog\.done /.test(WD) && /\.tprog\.over /.test(WD) && /\.tprog\.zero /.test(WD) && /\.tprog\.unk\{/.test(WD));
  t('★ 클래스는 tprog 접두로 스코프 — 맨몸 .ring 규칙 금지(남의 화면 오염)',
    !/^\s*\.ring\{/m.test(WD));
  t('좁은 화면에서 라벨만 접고 숫자는 남긴다', /@media\(max-width:720px\)\{\.tprog \.lbl\{display:none\}/.test(WD));
  t('표기 단일 출처 — 날짜는 _fmtKDate 를 쓴다(사본 금지)',
    /_fmtKDate\(String\(tp\.dateStr/.test(WD));
  t('★ 프론트에 정원 재계산 사본이 없다(daily_limit·이월을 다시 더하지 않는다)',
    !/todayProgress[\s\S]{0,400}(carryAdded|daily_limit|dailyLimit)/.test(WD));
  t('클릭 동작 없음 = 읽기 전용 표기', !/tprog[^>]*onclick/.test(WD));
  // 지금 tip 은 숫자·고정문구뿐이라 escape 를 빼도 당장은 안 터진다 — 그래서 **규칙 자체를 고정**한다.
  // (나중에 공고 제목 같은 외부 문자열을 툴팁에 넣는 순간 속성 탈출이 된다.)
  // ★★ 반드시 _tpHtml **본문 안에서** 볼 것 — `title="${esc(tip)}"` 는 이 파일의 다른 기능에도
  //   4곳 더 있어서, 파일 전체를 보면 여기서 esc 를 빼도 남의 것이 대신 통과시킨다(변이시험 실측).
  const TP_FN = cut('function _tpHtml(tp){', '// 시트형 그리드:');
  t('★ title 속성도 escape 를 거친다(외부 문자열이 들어와도 안전하게)', /title="\$\{esc\(tip\)\}"/.test(TP_FN));

  console.log(`\n✅ 통과 ${pass}건\n`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message + '\n'); process.exit(1); });
