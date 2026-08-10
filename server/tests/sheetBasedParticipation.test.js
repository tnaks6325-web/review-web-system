/**
 * sheetBasedParticipation.test.js — 참여현황 "표 기준" 표기 + 카드↔툴바 동기화 회귀가드
 * 실행: node tests/sheetBasedParticipation.test.js
 * 사용자 확정(2026-08-10, B안): 모집공고 카드와 작업보드 툴바를 **작업표 기준**(27/42)으로 표기.
 * 진단 문서: frontend/docs/design-participation-count-mismatch.html
 *
 * 이 표기가 깨지면 아픈 것 여섯.
 *  ① **두 화면이 또 갈린다** — 카드와 툴바가 각자 세면 "왜 카드와 표가 다르냐"가 방향만 바꿔 되돌아온다.
 *     계산은 `tabFilled.service` **한 곳**이어야 한다.
 *  ② **연도 없는 날짜** — 시트 표기는 `8 / 10 (월)` 로 연도가 없다. `parseDateColumn` 에
 *     `fallbackAnchor` 를 안 넘기면 전부 null 이 되어 **"오늘 0명"으로 조용히 죽는다**(W2-b F-2 실측).
 *  ③ **중복 탭 이중 계수** — 한 탭에 공고가 여럿(차수 재발행)이면 같은 키가 두 번 들어와
 *     JOIN 이 행을 두 번 매칭한다 → 줄 수가 배로 부풀어 "42/42 완료"로 보인다.
 *  ④ **0 으로 위장** — 조회 실패를 0 으로 접으면 "오늘 아무도 안 들어왔다"는 거짓 신호가 된다.
 *     못 세면 null → 화면은 종전 값으로 폴백하고 **그 사실을 말해야** 한다.
 *  ⑤ **리뷰어 카드까지 바꾸면 안 된다** — 참여 허용 판정은 여전히 공고 기준이라,
 *     리뷰어 게이지를 표 기준으로 바꾸면 "게이지는 찼는데 참여는 되는" 상태가 생긴다.
 *  ⑥ **차이가 숨는다** — 표 ≠ 공고 확정의 차이가 곧 지각 참여 확정 대기·수기 입력 신호다.
 *     표기를 바꿔도 그 신호는 툴팁으로 남아야 한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 참여현황 표 기준 표기 회귀가드\n');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const CC = F('js/campaign-cards.js');
const WD = F('workdesk.html');
const SVC = S('src/services/tabFilled.service.js');
const TB = S('src/services/trackB.service.js');
// campaign.routes.js 에는 **의도된 NUL**(복합키 구분자)이 있어 그대로 grep 하면 도구가 바이너리로 본다.
const ROUTES = S('src/routes/campaign.routes.js').split(String.fromCharCode(0)).join('~NUL~');

/* ══ 1) todayFilledMap — 스텁 db 로 실제 실행 ═══════════════════════════════ */
console.log('1) todayFilledMap (서비스 실행)');
const { todayFilledMap, todayFilledForTab, KEY } = require('../src/services/tabFilled.service');
const NOW = new Date('2026-08-10T05:00:00Z');   // KST 2026-08-10 14:00

let SQL = [];
const db = (rows, fail) => ({
  query: async (q, p) => { SQL.push({ q: String(q), p }); if (fail) throw new Error('boom'); return { rows }; },
});
const R = (startDate, n, tab = 'T1') => ({ sheetId: 'S1', tabName: tab, startDate, n });

(async () => {
  SQL = [];
  // ★★ 연도가 없는 시트 표기 — 이게 안 세어지면 이 기능이 통째로 죽는다.
  let r = await todayFilledMap(db([R('8 / 10 (월)', 27), R('8 / 9 (일)', 41), R('8 / 11 (화)', 3)]),
    [{ sheetId: 'S1', tabName: 'T1' }], NOW);
  t('★ 연도 없는 표기(8 / 10 (월))도 오늘로 인식한다(fallbackAnchor 계약)',
    r.ok && r.map.get(KEY('S1', 'T1')) === 27, JSON.stringify([...r.map]));
  t('다른 날짜는 세지 않는다(오늘만)', r.map.get(KEY('S1', 'T1')) === 27);
  t('오늘 날짜 문자열을 함께 준다', r.todayStr === '2026-08-10', r.todayStr);

  r = await todayFilledMap(db([R('2026-08-10', 12), R('2026-08-09', 30)]), [{ sheetId: 'S1', tabName: 'T1' }], NOW);
  t('ISO 표기도 인식한다', r.map.get(KEY('S1', 'T1')) === 12);

  r = await todayFilledMap(db([]), [{ sheetId: 'S1', tabName: 'T1' }], NOW);
  t('★ 오늘 줄이 없으면 0 — 이건 사실이므로 null 이 아니다', r.ok && r.map.get(KEY('S1', 'T1')) === 0);

  // ③ 중복 키
  SQL = [];
  await todayFilledMap(db([R('8 / 10 (월)', 27)]),
    [{ sheetId: 'S1', tabName: 'T1' }, { sheetId: 'S1', tabName: 'T1' }, { sheetId: 'S1', tabName: 'T2' }], NOW);
  const q = SQL[0];
  t('★ 같은 탭이 두 번 들어와도 한 번만 조회한다(JOIN 이중 계수 = 숫자 2배)',
    q.p[0].length === 2 && q.p[1].length === 2, JSON.stringify(q.p));

  // ④ 실패
  r = await todayFilledMap(db([], true), [{ sheetId: 'S1', tabName: 'T1' }], NOW);
  t('★ 조회 실패 → throw 없이 ok:false (0 으로 위장하지 않는다)', r.ok === false && r.map.size === 0);
  const one = await todayFilledForTab(db([], true), 'S1', 'T1', NOW);
  t('★ 단일 래퍼도 실패 시 null(0 과 구분)', one === null);
  t('빈 목록은 조회조차 하지 않는다', (await todayFilledMap(db([]), [], NOW)).ok === true);

  /* ══ 2) 세는 대상 · 위생 ══════════════════════════════════════════════════ */
  console.log('\n2) 세는 대상 · 위생');
  t('★ review_index 를 센다(= 이름 있는 행만 = "채워진 줄", 빈 슬롯 자동 제외)',
    /FROM review_index/.test(SVC) && !/FROM campaign_participants/.test(SVC));
  t('★ 날짜 해석은 koreanDate.parseDateColumn 단일 출처(사본 금지)',
    /require\('\.\.\/utils\/koreanDate'\)/.test(SVC) && !/function\s+parseDate/.test(SVC));
  t('★ fallbackAnchor 를 넘긴다(연도 없는 표기가 통째로 죽지 않게)', /fallbackAnchor:\s*\{\s*y:/.test(SVC));
  t('오늘 판정은 campaignState.kstTodayStr 재사용(날짜 규칙 사본 금지)', /kstTodayStr/.test(SVC));
  t('쓰기 쿼리 0 · 시트 무접촉', !/\b(INSERT|UPDATE|DELETE)\b/i.test(SVC) && !/sheets|readSheet|writeSheet/i.test(SVC));
  t('날짜 값별로 접어서 받는다(900행 작업에서도 전송량 일정)', /GROUP BY 1, 2, 3/.test(SVC));
  // ★ 스텁은 SQL 을 해석하지 않는다 → WHERE 절은 **쿼리문으로** 고정한다.
  //   구매일자가 빈 행까지 끌어오면 날짜 해석 대상이 통째로 늘어 오탐·전송량이 함께 커진다.
  t("★ 구매일자가 빈 행은 애초에 안 가져온다(COALESCE(start_date,'') <> '')",
    /WHERE COALESCE\(ri\.start_date, ''\) <> ''/.test(SVC));

  /* ══ 3) 두 소비처가 같은 함수를 쓴다 ═════════════════════════════════════ */
  console.log('\n3) 카드 ↔ 툴바 동기화(같은 함수)');
  t('★ 작업보드 툴바가 tabFilled.service 를 쓴다', /require\('\.\/tabFilled\.service'\)/.test(TB));
  t('★ 모집공고 카드 목록도 같은 서비스를 쓴다(사본 금지)',
    /require\('\.\.\/services\/tabFilled\.service'\)/.test(ROUTES));
  t('카드 응답에 todayFilled 가 실린다', /todayFilled:/.test(ROUTES));
  t('★ 카드 집계 실패는 목록을 죽이지 않고 null 로 폴백', /표 기준 집계 실패/.test(ROUTES));
  t('★ 연결 탭이 없는 공고는 null(0 으로 꾸미지 않는다)',
    /_filled && r\.linked_sheet_id && r\.linked_tab_name/.test(ROUTES));
  // ★★ `/sheetFilled/` 만 보면 안 된다 — base 객체 리터럴의 `sheetFilled: null` 이 대신 통과시킨다.
  //   **값을 채우는 호출**을 지목한다(변이시험이 실제로 뚫었다).
  const _tbCall = TB.indexOf('base.sheetFilled = await todayFilledForTab');
  t('툴바 응답에 sheetFilled 를 실제로 채운다', _tbCall >= 0);
  // ★★ 그리고 `-1 < n` 은 언제나 참이다 — 존재 확인을 먼저 하지 않으면 순서 단언이 공짜로 통과한다.
  t('★ 공고를 못 찾아도(no_campaign) 표 기준 값은 구한다(사실이므로)',
    _tbCall >= 0 && _tbCall < TB.indexOf("reason: rows.length ? 'no_live_campaign'"));

  /* ══ 4) 화면 규칙 ════════════════════════════════════════════════════════ */
  console.log('\n4) 화면 규칙');
  t('★ 툴바는 표 기준을 우선 표시하고, 없으면 종전 값으로 폴백',
    /const done = sheetOk \? \(Number\(tp\.sheetFilled\)\|\|0\) : confirmed;/.test(WD));
  t('★ 폴백했다는 사실을 말한다', /표 기준으로 세지 못해 공고 확정 수로 표시합니다/.test(WD));
  t('★ 차이(지각·수기 입력 신호)를 툴팁으로 남긴다', /공고를 거쳐 확정된 건 \$\{confirmed\}명/.test(WD));
  const admBlock = CC.slice(CC.indexOf('if (quota > 0 && !isPre) {'), CC.indexOf('} else {', CC.indexOf('if (quota > 0 && !isPre) {')));
  t('★ 관리자 카드 숫자 = 표 기준(있으면)', /const shownN = \(todayFilled != null\) \? todayFilled : /.test(admBlock));
  t('게이지 채움·완료 판정도 같은 값을 따라간다(숫자와 색이 어긋나지 않게)',
    /shownN \/ quota/.test(admBlock) && /const shownFull = quota > 0 && shownN >= quota/.test(admBlock));
  t('★ 차이를 카드 툴팁으로 남긴다', /지각 참여 확정 대기 또는 수기 입력/.test(admBlock));
  // ★★ 홈 모집공고 카드도 같은 숫자를 쓴다(사용자 확정 2026-08-10) — 단 **보는 사람이 관리자일 때만**.
  //   일반 리뷰어에게는 종전(공고 기준) 그대로여야 한다: 참여 허용 판정이 공고 기준이라
  //   리뷰어 화면까지 표 기준으로 바꾸면 "게이지는 찼는데 참여는 되는" 상태가 생긴다.
  // ★ 게이트 범위 = `✏️ 관리자 수정` 칩과 **같다**(`_adminTok` = 진짜 admin_token 또는 공고수정
  //   허용명단 스코프 토큰). `_realAdminTok`(진짜 토큰만)으로 좁히면 스코프 토큰으로 홈을 보는
  //   담당자에게 카드만 옛 숫자로 남는다(실측 신고 2026-08-10).
  t('★★ 표 기준은 운영자 게이트 뒤에만(일반 리뷰어는 종전 동작)',
    /const _seeFilled = admin \|\| _adminTok\(\);/.test(CC)
    && /const todayFilled = \(!_seeFilled \|\| c\.todayFilled == null\) \? null :/.test(CC));
  t('★ 그 게이트는 `관리자 수정` 칩과 같은 범위(스코프 토큰 포함)', (() => {
    const edit = /const editChip = \(!admin && (_\w+)\(\)\)/.exec(CC);
    const seen = /const _seeFilled = admin \|\| (_\w+)\(\);/.exec(CC);
    return edit && seen && edit[1] === seen[1];
  })());
  t('비관리자 게이지도 같은 값을 쓴다(관리자 계정으로 홈을 볼 때 카드=작업보드)',
    /const pubN = \(todayFilled != null\) \? todayFilled : today;/.test(CC));
  t('★ 홈 카드도 완료 판정·채움을 표시 숫자에 맞춘다(39/42 인데 "완료"로 칠해지지 않게)',
    /const pubFull = quota > 0 && pubN >= quota;/.test(CC) && /pubN \/ quota/.test(CC)
    && /class="pgauge\$\{pubFull \? ' full' : ''\}"/.test(CC));
  t('★ 공개 목록 API 가 재료를 싣는다(홈 카드의 유일한 출처)',
    /view\.todayFilled = filledMap\.map\.get\(_k\)/.test(ROUTES) && /_listCache = \{ at: now\.getTime\(\)[^}]*filledMap \}/.test(ROUTES));
  t('★ 목록 캐시(5초) 안에서 계산한다(요청마다 돌지 않게)',
    ROUTES.indexOf('const { todayFilledMap, KEY: _fKey }') > ROUTES.indexOf("router.get('/list'"));
  t('★ 구버전 백엔드(필드 부재)는 종전 동작 — null 로 접어 폴백',
    /c\.todayFilled == null\) \? null : \(Number\(c\.todayFilled\) \|\| 0\)/.test(CC));

  console.log(`\n✅ 통과 ${pass}건\n`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message + '\n'); process.exit(1); });
