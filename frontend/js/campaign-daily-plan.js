/* ══════════════════════════════════════════════════════════════════════════
   campaign-daily-plan.js — 모집공고 날짜별 모집인원 조절 + 차수(물량 추가) 공유 모달
   (migration 095 · 시안 frontend/docs/모집인원조절_이월차수_와이어프레임.html)

   관리자 대시보드(admin.html)·리뷰웹시스템[3버전](workdesk.html)이 **이 한 벌**을 쓴다
   (모달 사본을 두면 두 화면이 계속 어긋난다 — campaign-reviewer-gate.js 와 같은 규율).

   시안에서 브라우저 검증으로 확정한 규칙 2건이 여기 그대로 산다:
   ★ "빠진 인원 처리" 질문은 조절 한 묶음당 한 번(0.7초 디바운스) — 클릭마다 팝업이 뜨면
     연속 조절이 불가능하다(실측).
   ★ "남은 날 분산"의 범위 = 축소 전 종료일까지의 남은 진행일 — 그 밖의 날까지 나누면
     얹는 의미가 없어 종료일이 그대로 밀린다(실측).

   ★ 조절은 [확정 저장]을 눌러야 서버 반영(드래그·버튼만으로는 저장 안 됨 — 오조작 방어).
     차수 추가/제거는 총량 변경이라 건별 confirm 후 즉시 반영.
   ★ onclick 에는 배열 인덱스·고정 문자열만(XSS 규율). 마운트는 body 직속 + var() 폴백.
   ★ 경로는 /api/trackb/* 하나 — admin_token·인트라넷 SSO 양쪽에서 그대로 닿는다
     (호스트별 재기준 불필요, 리뷰어 게이트와 같은 판단).
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var EP = '/api/trackb/campaigns/';           // + <id>/daily-plan | <id>/rounds
  var SETTLE_MS = 700;                          // 조절 멈춤 판정(질문은 한 묶음당 한 번)
  var ROW_DAYS = 14;                            // 기본 표시 일수(오늘 포함) — 조절된 날은 그 밖이어도 표시

  var S = null; // { campId, title, data, plan:{d:n}, base:{d:n}, notes:[], sessions:{d:{start,timer}}, choice, saving }

  function _apiBase() {
    return (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : '';
  }
  function _headers() {
    var token = sessionStorage.getItem('admin_token') || localStorage.getItem('admin_token');
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  async function _req(method, path, body) {
    var opt = { method: method, headers: _headers() };
    if (body !== undefined) opt.body = JSON.stringify(body || {});
    var r = await fetch(_apiBase() + path, opt);
    var j = await r.json().catch(function () { return null; });
    if (!j) throw new Error('HTTP ' + r.status);
    if (!j.ok) { var e = new Error(j.error || 'HTTP ' + r.status); e.code = j.code; e.floor = j.floor; throw e; }
    return j;
  }

  /* ── 날짜 유틸(문자열 산술 — 타임존 무관) ── */
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  function addDays(iso, n) {
    var t = Date.parse(iso + 'T00:00:00Z') + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }
  function fmtMD(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    var d = new Date(Date.parse(iso + 'T00:00:00Z'));
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' (' + DOW[d.getUTCDay()] + ')';
  }

  /* ── 법정공휴일(대한민국) ─────────────────────────────────────────
     ★★ **양력 고정일만 계산으로 뽑고, 음력·대체공휴일은 표로 둔다** — 설·추석·부처님오신날은
       음력이라 계산식으로 만들 수 없고, 대체공휴일은 해마다 정부가 확정한다. 추측으로 칠하면
       "빨간 날이 아닌데 빨갛다"가 되어 배분 계획을 잘못 세우게 된다(틀린 값 > 빈 값).
     ★ 표에 없는 연도는 **고정일만** 빨갛게 칠하고 음력 공휴일은 표시하지 않는다 —
       "모르는 것을 아는 척하지 않는다"(연도가 넘어가면 아래 표에 한 줄 추가). */
  var FIXED_HOLIDAYS = {                     // MM-DD → 이름 (매년 같은 날)
    '01-01': '신정', '03-01': '삼일절', '05-05': '어린이날', '06-06': '현충일',
    '08-15': '광복절', '10-03': '개천절', '10-09': '한글날', '12-25': '성탄절',
  };
  var LUNAR_HOLIDAYS = {                     // 음력 기반 + 대체공휴일(연도별 확정값)
    '2026-02-16': '설날 연휴', '2026-02-17': '설날', '2026-02-18': '설날 연휴',
    '2026-03-02': '삼일절 대체', '2026-05-24': '부처님오신날', '2026-05-25': '부처님오신날 대체',
    '2026-09-24': '추석 연휴', '2026-09-25': '추석', '2026-09-26': '추석 연휴',
    '2027-02-05': '설날 연휴', '2027-02-06': '설날', '2027-02-07': '설날 연휴', '2027-02-08': '설날 대체',
    '2027-05-13': '부처님오신날', '2027-06-07': '현충일 대체', '2027-08-16': '광복절 대체',
    '2027-09-14': '추석 연휴', '2027-09-15': '추석', '2027-09-16': '추석 연휴',
    '2027-10-04': '개천절 대체', '2027-10-11': '한글날 대체', '2027-12-27': '성탄절 대체',
  };
  /** 그날의 공휴일 이름 — 없으면 '' */
  function holidayName(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    return LUNAR_HOLIDAYS[iso] || FIXED_HOLIDAYS[iso.slice(5)] || '';
  }
  /** 날짜 색 구분 — 'hol'(공휴일·일요일 = 빨강) | 'sat'(토요일 = 파랑) | '' */
  function dayKind(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    var w = new Date(Date.parse(iso + 'T00:00:00Z')).getUTCDay();
    if (w === 0 || holidayName(iso)) return 'hol';
    if (w === 6) return 'sat';
    return '';
  }

  /** 시트 일정 공고의 그날 시트 계획(구매일자 행 수) — 없는 날 = 0(그날은 진행일이 아님). */
  function sheetFor(d) {
    if (!S.data._schMap) {
      var m = {};
      (S.data.scheduleDates || []).forEach(function (x) { m[x.date] = Number(x.slots) || 0; });
      S.data._schMap = m;   // applyOverview 가 S.data 를 통째로 갈아끼우므로 캐시는 자동 무효화
    }
    return S.data._schMap[d] || 0;
  }
  /** 무시트 작업표의 실제 날짜별 준비 행 수. 날짜가 없으면 0명이다.
   *  기본 일건수를 빈 날짜에 다시 채우면, 작업표에는 없는 주말/휴무일이 40명으로
   *  꾸며져 조절 화면과 작업표가 다시 갈린다. */
  /** 그날 **이미 참여·주문이 있는 줄** 수 — 재배분이 그 아래로 못 내려가는 하한.
   *  ★ 서버 rebuildAdjustedPlansToWorktable 이 이 수보다 적은 계획을 거부한다
   *    (worktable_rebuild_below_used) — 화면이 애초에 그런 값을 만들지 않게 한다.
   *  ★ 값을 못 받으면(구버전 백엔드) 0 = 종전 동작(서버가 최종 방어하고 사유를 말한다). */
  function worktableFilledFor(d) {
    if (!S.data._wtFill) {
      var m = {};
      (S.data.worktableDates || []).forEach(function (x) { m[x.date] = Number(x.filled) || 0; });
      S.data._wtFill = m;
    }
    return S.data._wtFill[d] || 0;
  }
  function worktableFor(d) {
    if (!S.data._wtMap) {
      var m = {};
      (S.data.worktableDates || []).forEach(function (x) { m[x.date] = Number(x.slots) || 0; });
      S.data._wtMap = m;
    }
    return S.data._wtMap[d] || 0;
  }
  /** 그날 조절이 없을 때의 기본 정원 — 시트 일정 공고는 **시트가**, 아니면 기본 일건수가 정한다.
   *  ★ 이 한 곳이 게이지·"기본 N" 표기·예상 종료일 계산의 공통 기준(사본을 두면 화면이 갈린다). */
  /** 이 공고의 **주말 정책이 그날을 닫는가**(주말 제외 = 토·일·공휴일).
   *  ★ baseFor 와 재배분이 같은 판정을 쓴다(사본을 두면 "표는 0인데 재배분은 30"이 된다). */
  function policyClosed(d) {
    if (!S || !S.data || S.data.skipWeekends !== true) return false;
    // 공고의 기본 주말 제외보다 이 화면에서 확정할 날짜별 인원 계획이 우선한다.
    // 0명은 기존대로 휴무이며, 1명 이상인 주말만 모집을 연다.
    if (S.plan && Number(S.plan[d]) > 0) return false;
    var k = dayKind(d);
    return k === 'sat' || k === 'hol';
  }
  function baseFor(d) {
    if (policyClosed(d)) return 0;
    if (S.data.scheduleDriven === true) return sheetFor(d);
    // worktableDates 가 있으면 이 공고는 무시트 작업표 연결 공고다. 없는 날짜는
    // "기본 일건수"가 아니라 실제로는 아직 행이 없는 0명으로 보여야 한다.
    if (Array.isArray(S.data.worktableDates)) return worktableFor(d);
    return S.data.defaultDaily || 0;
  }
  function planFor(d) {
    return (S.plan[d] != null) ? S.plan[d] : baseFor(d);
  }
  /** 조절·투영의 기준일 — 시작일이 미래면 그날부터(Codex P2: 오픈 전 날짜를 소진하는 것처럼
   *  계산하면 예상 종료일이 앞당겨 보이고, 분산이 오픈 전 날짜에 계획을 얹는다). */
  function baseDate() {
    var sd = S.data.startDate;
    return (sd && sd > S.data.today) ? sd : S.data.today;
  }
  /** 이 공고의 총량 — 시트 일정 공고는 **시트 행 수**가 실제 총량이다(서버 판정과 같은 값).
   *  recruit_total 을 쓰면 화면 숫자가 서버와 갈리고 예상 종료일도 어긋난다(코드리뷰 #4). */
  function totalFor() {
    if (S.data.scheduleDriven === true && S.data.scheduleTotal != null) return Number(S.data.scheduleTotal) || 0;
    return Number(S.data.recruitTotal) || 0;
  }
  /* ══ 총량 균형(요구 ①⑥) · 이월 배치(요구 ④) ═══════════════════════════════
     시안 = frontend/docs/design-recruit-quota-balance.html (사용자 확정).

     ★★ 모델: 모달을 열면 **오늘 ~ 예상 종료일** 구간의 날짜별 인원을 실제 값으로 펼쳐 두고,
       그 합계가 "배분해야 할 인원"(총량 − 어제까지 확정)과 **정확히 같을 때만** 저장한다.
       저장하면 그 구간이 명시 계획으로 확정되므로 **화면에서 본 대로 열린다**(자동 이월이
       조용히 더 열지 않는다 — 이월은 아래 3종 방식으로 사람이 배치한다).
     ★ 구간이 너무 길어(저장 상한 초과) 펼칠 수 없으면 균형 모드를 **끄고 종전 동작**으로 둔다
       (반쪽짜리 균형 표시로 잘못된 확신을 주지 않는다). */
  var MAX_ROWS = 120;             // 서버 savePlans 의 MAX_PLAN_ENTRIES 와 같은 값
  var CARRY_MODES = ['next', 'spread', 'extend'];
  /* ★★ 기본 이월 방식 = **종료일 뒤에 붙이기**(사용자 확정 2026-08-19 2차 — 종전 `spread` 에서
     뒤집혔다). 뜻 = **각 날 인원은 건드리지 않고** 못 채운 몫만 종료일 뒤로 넘긴다(총량 불변,
     종료일만 밀린다). 하루에 몰아넣지 않으므로 066 하루 상한을 넘겨 여는 일이 구조적으로 없다.
     ★ `next`(다음날에 더하기)를 기본으로 두지 않는 이유 = 위프 800건에서 이월이 625명까지
       쌓였는데 그대로 배치하면 **다음 진행일 하루에 625명**이 열린다(리뷰어 화면에도 그 숫자가
       그대로 나간다). `spread` 도 각 날 인원을 말없이 늘리므로 기본값에서 내렸다.
     ★ 이 값이 단일 출처다 — 폴백·되돌리기·'기본' 배지가 전부 이것을 본다(사본 금지). */
  var DEFAULT_CARRY_MODE = 'extend';

  /** 어제까지 확정 — 전체 확정에서 오늘 확정을 뺀다(오늘분은 오늘 줄 안에 들어 있다) */
  function doneBefore() {
    var all = Number(S.data.submittedAll) || 0;
    var td = Number(S.data.todaySubmitted != null ? S.data.todaySubmitted
      : (S.data.byDateSubmitted || {})[S.data.today]) || 0;
    return Math.max(0, all - td);
  }
  /** 배분해야 할 인원 = 총량 − 어제까지 확정 (오늘 줄부터 종료일까지의 합계 목표) */
  function targetTotal() { return Math.max(0, totalFor() - doneBefore()); }
  /** 이월(미달) 인원 — 서버 계산값 그대로. null = 계산 불가(0 으로 꾸미지 않는다).
   *  ★ 저장해 둔 앞 날짜 계획을 여기서 빼지 않는다 — "이월 배치"와 "무관한 상향 조절"을
   *    구분할 수 없어, 무관한 +N 이 실제로 남아 있는 이월을 **0으로 숨겨** 배치 창구가
   *    사라진다(코드리뷰). 재제안이 걱정될 자리는 아래 naturalFor 가 서버값이라 막혀 있다. */
  function carryAmt() {
    var v = S.data.carryPending;
    return (v == null) ? null : Math.max(0, Number(v) || 0);
  }
  /** 그날 **손대지 않았을 때의 값** — 이 값과 같으면 저장할 필요가 없다(불필요한 고정 방지).
   *  ★★ 구간 전체를 무조건 저장하면, 아무것도 안 건드리고 [확정 저장]만 눌러도 앞으로의 모든
   *    날짜가 리뷰웹 값으로 굳어 **시트 일정 공고의 시트 우선권이 통째로 사라진다**(코드리뷰).
   *  ★★ 오늘 값은 **서버가 준 `todayNaturalQuota`(computeCampaignState 판정)** 을 그대로 쓴다 —
   *    `기본 + 이월` 로 다시 계산하면 066 의 이월 상한(2배)·킬스위치·총량 clamp 를 프론트가
   *    몰라 이월이 하루치를 넘는 흔한 경우부터 화면 숫자가 서버와 갈린다. */
  function naturalFor(d) {
    if (d === S.data.today && S.data.todayNaturalQuota != null) return Number(S.data.todayNaturalQuota) || 0;
    if (S.base[d] != null) return S.base[d];         // 이미 저장된 조절 = 그 값이 그날의 전부(095)
    return baseFor(d);
  }
  function balanceOn() { return !!(S && S.balance); }
  function sumPlan() {
    if (!S.horiz) return 0;
    return S.horiz.reduce(function (s, d) { return s + planFor(d); }, 0);
  }
  function diffPlan() { return sumPlan() - targetTotal(); }

  /** 구간을 펼칠 때의 그날 출발값 — **이미 저장된 조절이 있으면 그 값**이 출발선이다.
   *  ★ baseFor 로 펼치면 관리자가 저장해 둔 조절("8/10 은 5명만")이 모달을 여는 순간 조용히
   *    기본값으로 덮인다 — 이월은 그 위에 얹는 것이지 지우고 다시 까는 것이 아니다. */
  function effBase(d) {
    return (S.base[d] != null) ? S.base[d] : baseFor(d);
  }
  // 일정/작업표가 유한한 공고는 마지막 실제 날짜 뒤에도 짧은 조절 창을 남긴다.
  // 이 창의 날짜는 0명으로 표시되어, 원래 없던 주말·휴무일에도 직접 인원을 배정할 수 있다.
  // 반대로 400일치 0명 행을 만들면 "시트 자리가 부족한 공고"가 MAX_ROWS에 걸려
  // 조절 모달 자체가 닫히므로 여기서 경계를 둔다.
  function finitePlanLimit() {
    var src = S.data.scheduleDriven === true ? S.data.scheduleDates : S.data.worktableDates;
    if (!Array.isArray(src) || !src.length) return '';
    var last = src.map(function (x) { return x && x.date || ''; }).filter(Boolean).sort().pop();
    return last ? addDays(last, 13) : ''; // 기본 표시 창과 같은 14일(마지막 실제 날짜 포함)
  }
  /** 이월을 얹지 않았을 때의 진행 구간 — { days:[{date,base,v}], sum, short }.
   *  ★ 출발값이 0인 날도 달력 행에는 남긴다. 그래야 주말 제외·작업표 미배정일을
   *    0명에서 직접 늘릴 수 있고, 저장 시 작업표와 동기화할 수 있다.
   *  ★★ 400일 안에 목표를 못 채워도(`short`) **모아 둔 진행일을 그대로 돌려준다** — 그 상태가
   *    바로 균형 바의 "부족(파랑)"이고, 사람이 날짜별 인원을 올리면 초록이 된다. */
  function walkDays(target) {
    var out = [], sum = 0, d = baseDate(), guard = 0, finiteLimit = finitePlanLimit();
    while (sum < target && guard++ < 400) {
      var b = effBase(d);
      var v = b > 0 ? Math.min(b, target - sum) : 0;
      if (b <= 0 && finiteLimit && d > finiteLimit) break;
      out.push({ date: d, base: b, v: v });
      sum += v;
      d = addDays(d, 1);
    }
    S.capAhead = sum;                                 // 못 채웠을 때 "얼마나 모자란지"를 말하는 재료
    return { days: out, sum: sum, short: sum < target };
  }

  /**
   * 오늘~종료일 구간을 방식대로 펼친다. 반환 = { dates:[], plan:{d:n}, carry:{d:n} } 또는 null(불가).
   *   next   : 첫 진행일에 이월 전액   spread : 진행일에 고르게   extend : 얹지 않음(종료일이 밀린다)
   * ★ 마지막 날은 목표에 맞춰 남은 만큼만 — 그래서 펼친 합계가 정확히 목표가 된다.
   */
  function buildHorizon(mode) {
    var target = targetTotal();
    S.balanceOff = null;
    // ★★ 균형 모드를 못 켜는 이유는 **반드시 기록**한다 — 조용히 종전 화면으로 떨어지면
    //   담당자는 "요구했던 균형 표가 왜 없는지"를 알 수 없다(코드리뷰 🟡2).
    if (target <= 0) { S.balanceOff = totalFor() <= 0 ? 'unlimited' : 'full'; return null; }
    // ★★ 오늘 하한(확정·진행 인원)이 배분해야 할 인원보다 크면 **어떤 배치도 합계를 맞출 수 없다**
    //   (총량 초과 확정·소진 직전 홀드에서 도달). 그대로 켜면 균형 바가 영원히 "초과 — 저장불가"
    //   이고 [자동 맞춤]은 하한에 막혀 아무 일도 안 하는 죽은 버튼이 된다 → 균형 모드를 끈다.
    if (minFor(baseDate()) > target) { S.balanceOff = 'today_over'; return null; }
    // ★ 저장 판정의 기준값(서버 판정 오늘 정원)이 없으면 균형 모드를 켜지 않는다 —
    //   잘못된 기준으로 "손 안 댔다"를 판정하면 조용히 아무것도 저장하지 않는 화면이 된다.
    if (S.data.todayNaturalQuota == null) { S.balanceOff = 'no_baseline'; return null; }
    var wd = walkDays(target);
    // ★★ 앞으로 진행일이 **아예 없을 때만** 균형 모드를 끈다. 시트 계획이 목표보다 적은 것은
    //   기능 불가가 아니라 **"부족(파랑) — 저장불가"** 그 자체다(요구 ⑥). 종전엔 이때 균형 모드를
    //   통째로 꺼 놓고 안내문만 "어느 날의 인원을 늘려주세요"라고 말해, 시키는 대로 늘려도 아무
    //   변화가 없는 **막다른 길**이었다(사용자 신고 2026-08-07 · 시트 800명 공고).
    if (!wd.days.some(function (x) { return x.base > 0; })) { S.balanceOff = 'no_room'; return null; }
    var carry = (mode === 'extend') ? 0 : (carryAmt() || 0);
    // 첫 진행일에 이미 저장된 계획이 있으면 그 값은 서버가 실제 정원으로 쓰는
    // 완성값이다. 여기에 pending carry를 다시 얹으면, 저장 후 모달을 재오픈할 때
    // 카드(81명)와 모달(81 + 이월 40 = 121명)이 갈린다. 날짜 범위가 시작일 등으로
    // 오늘과 다르게 잡혀도 저장된 계획을 놓치지 않도록, 오늘 이후 명시 계획이 하나라도
    // 있으면 자동 이월을 다시 제안하지 않고 저장값을 그대로 연다.
    // S.base는 화면에 표시할 수 있는 저장된 일자 계획만 모아 둔 상태다. 하나라도
    // 있으면 사용자가 확정한 배치이므로 pending carry를 별도로 얹지 않는다. 응답의
    // 날짜 표기 방식과 무관하게 카드와 재오픈 모달이 같은 정원을 보게 한다.
    if (Object.keys(S.base).length) carry = 0;
    // ★ 나눌 대상 = 이월 없이도 **온전히** 채워지는 진행일(마지막 부분일 제외) — 부분일까지 세면
    //   그 몫이 총량 맞추기에서 잘려 "이월 30명인데 29명만 얹혔다"가 된다(시안 실측).
    var slots = Math.max(1, wd.days.filter(function (x) { return x.v >= x.base; }).length);
    var per = (mode === 'spread') ? Math.floor(carry / slots) : 0;
    var rem = (mode === 'spread') ? (carry % slots) : 0;
    var dates = [], plan = {}, cmap = {}, sum = 0, left = carry, si = 0;
    for (var i = 0; i < wd.days.length; i++) {
      if (dates.length >= MAX_ROWS) { S.balanceOff = 'too_long'; return null; }   // 너무 길다
      var d = wd.days[i].date, base = wd.days[i].base, add = 0;
      if (left > 0) {
        add = (mode === 'next') ? left : Math.min(left, per + (si < rem ? 1 : 0));
        left -= add;
      }
      si++;
      // ★ 오늘은 이미 확정·진행 중인 인원 아래로 잡히면 안 된다 — 저장된 조절이 그 사이 늘어난
      //   확정 인원보다 작을 수 있고, 그대로 보내면 서버가 below_used 로 거절한다(막다른 길).
      var v = Math.max(minFor(d), Math.min(base + add, target - sum, MAX_DAY));
      dates.push(d); plan[d] = v; cmap[d] = Math.max(0, Math.min(add, v - base));
      sum += v;
      if (sum >= target) break;   // 목표를 채웠으면 그 뒤 날은 구간에 넣지 않는다
    }
    /* ★★ 구간 뒤에 남아 있는 **작업표 준비 줄**도 0 명으로 표에 올린다(2026-08-24).
       walkDays 는 목표를 채우면 멈추므로, 그 뒤 날짜의 빈 줄은 화면에 아예 없었고 그래서
       "총건수보다 많은 줄"을 내릴 창구가 없었다(신고: 총건수 500인데 작업표 581줄).
       ★ 값이 0 이라 **합계는 그대로**다 — 균형 바가 초록이면 초록으로 남는다.
       ★ 무시트 작업표 공고만 — 시트 일정 공고에 0 을 박으면 시트 우선권이 사라진다.
       ★ **저장된 계획이 있는 날은 넣지 않는다** — 그건 applyCarryMode 의 S.outside 규율
         ("구간 밖 저장 계획은 합계에 넣지도 지우지도 않는다")이 담당한다. 여기서 0 으로 덮으면
         사람이 정해 둔 계획이 조용히 지워진다.
       ★ **이미 채워진 줄이 있는 날도 넣지 않는다** — 0 으로 올리면 minFor 하한을 깨고 합계도 흔든다. */
    if (S.data.scheduleDriven !== true && Array.isArray(S.data.worktableDates)) {
      var have = {}; dates.forEach(function (x) { have[x] = 1; });
      var from2 = baseDate();
      S.data.worktableDates.forEach(function (x) {
        var dd = String((x && x.date) || '').slice(0, 10);
        if (!dd || dd < from2 || have[dd]) return;
        if (S.base[dd] != null) return;
        if ((Number(x.slots) || 0) <= 0) return;
        if (worktableFilledFor(dd) > 0) return;
        if (dates.length >= MAX_ROWS) return;
        dates.push(dd); plan[dd] = 0; cmap[dd] = 0; have[dd] = 1;
      });
      dates.sort();
    }
    // 부족분 = 지금 구간의 시트/저장 계획만으로는 모자라는 인원(0이면 정확히 맞는다)
    return { dates: dates, plan: plan, carry: cmap, shortBy: Math.max(0, target - sum) };
  }

  /** 그 날에 아직 얹혀 있는 이월분 — 배정량(S.carryMap)을 넘지 않는다.
   *  ★ plan−base 로 되계산하면 **사람이 손으로 올린 인원**까지 이월로 부르게 된다(시안 실측). */
  function carryOn(d) {
    var assigned = (S.carryMap && S.carryMap[d]) || 0;
    return Math.max(0, Math.min(assigned, planFor(d) - effBase(d)));
  }

  /** 이월 방식 세그먼트 버튼 한 칸 — mode 는 CARRY_MODES 의 고정 문자열만 넘긴다(보간 금지) */
  function segBtn(m, label, desc) {
    if (CARRY_MODES.indexOf(m) < 0) return '';   // 화이트리스트 밖 값은 그리지 않는다(보간 사고 차단)
    return '<button type="button" onclick="CampaignDailyPlan._mode(\'' + m + '\')"'
      + (S.carryMode === m ? ' class="on"' : '') + '>' + label
      + (m === DEFAULT_CARRY_MODE ? '<span class="df">기본</span>' : '')
      + '<small>' + desc + '</small></button>';
  }

  /** 방식 적용 — 구간·계획·이월 배치를 그 방식으로 다시 깐다(실패하면 균형 모드 해제) */
  function applyCarryMode(mode) {
    var h = buildHorizon(mode);
    if (!h) { S.balance = false; S.horiz = null; S.carryMap = null; return false; }
    var plan = {};
    h.dates.forEach(function (d) { plan[d] = h.plan[d]; });
    // ★ 이미 저장돼 있는 계획일이 구간 밖(휴무일·종료일 이후)이면 **그대로 살려** 합계에 넣는다 —
    //   화면에서 지우면 저장 시 remove 로 나가 사람이 정해 둔 계획이 조용히 사라진다.
    // ★ 기준은 baseDate 가 아니라 **오늘** — 시작일이 미래인 공고에서 baseDate 로 자르면
    //   today ≤ d < 시작일 구간의 저장된 계획이 화면에서 빠져 저장 시 remove 로 삭제된다(코드리뷰).
    var from = S.data.today, outside = [];
    Object.keys(S.base).forEach(function (d) {
      if (d >= from && plan[d] == null) { plan[d] = S.base[d]; outside.push(d); }
    });
    S.carryMode = mode;
    // ★★ 구간 밖(시작일 이전·예상 종료일 이후)에 저장된 계획은 **합계에 넣지 않는다** — 넣으면
    //   모달을 열자마자 사람이 만들지도 않은 "초과 N명"이 뜨고 [자동 맞춤]이 그 계획을 0으로
    //   깎아 버린다. 총량 clamp 때문에 종료일 이후 계획은 어차피 열리지 않는(무해한) 값이다.
    //   S.plan 에는 남겨 두므로 저장 시 remove 로 나가지도 않는다(그대로 유지).
    S.outside = outside.sort();
    // ★ 부족분은 **적용한 방식의 결과**에서 읽는다 — 렌더 중 방식별 종료일 비교(`em()`)가
    //   buildHorizon 을 다시 부르므로 S 에 흘려 두면 다른 방식의 값으로 덮인다.
    S.shortBy = h.shortBy || 0;
    S.horiz = h.dates.slice();
    S.carryMap = h.carry;
    S.plan = plan;
    // 열었을 때 값(닫기 확인·변경 판정 기준)은 **처음 한 번만** 잡는다 — 방식 전환마다 다시 잡으면
    // 전환 자체가 "변경 없음"이 되어 닫을 때 경고가 안 뜬다.
    if (!S.openPlan) S.openPlan = JSON.parse(JSON.stringify(plan));
    // ★ 「조절」 배지 기준 = 이 방식이 방금 깐 배치. openPlan 으로 재면 방식을 바꾸는 순간
    //   전 줄에 배지가 붙어(시스템 배치인데 사람이 손댄 것처럼) 신호가 죽는다(실측).
    S.modePlan = JSON.parse(JSON.stringify(plan));
    S.balance = true;
    return true;
  }
  /** 열었을 때 대비 사용자가 실제로 바꾼 날 — 닫기 확인·저장 버튼 판정(균형 모드) */
  function changedFromOpen() {
    if (!S.openPlan) return false;
    var ks = {};
    Object.keys(S.plan).forEach(function (d) { ks[d] = 1; });
    Object.keys(S.openPlan).forEach(function (d) { ks[d] = 1; });
    return Object.keys(ks).some(function (d) { return (S.plan[d] || 0) !== (S.openPlan[d] || 0); });
  }
  /** 지금 계획에 실제로 얹혀 있는 이월 합계(줄이면 그만큼 줄어든다) */
  function carryPlaced() {
    return (S.horiz || []).reduce(function (s, d) { return s + carryOn(d); }, 0);
  }
  function carryDays() {
    return (S.horiz || []).filter(function (d) { return carryOn(d) > 0; });
  }
  /** 한 날의 절대 상한 = 배분해야 할 인원(요구 ① — 총원까지 남은 건수 안에서만).
   *  ★ 서버 MAX_DAY_COUNT(9999)를 넘기면 savePlans 가 bad_count 로 **저장 전체를 거부**한다. */
  var MAX_DAY = 9999;
  function dayCeil() { return balanceOn() ? Math.min(MAX_DAY, Math.max(1, targetTotal())) : MAX_DAY; }
  /** ★★ 사람이 조절할 때의 상한 = **그 날 값 + 아직 남은 배분수**(사용자 확정 2026-08-19).
   *   합계가 총건수를 넘는 값은 **경고가 아니라 아예 들어가지 않는다** — 게이지 드래그·[＋]·숫자
   *   직접 입력 세 창구가 전부 commitValue/dragTo 를 거치므로 이 함수 하나가 단일 출처다.
   *  ★ 이미 초과 상태로 열린 공고(작업표 프리필이 총량을 안 보고 심은 계획 등)는 여유가 음수라
   *    상한 = 지금 값 → **늘리기만 막히고 줄이는 것은 언제나 가능**하다(되돌릴 길을 없애지 않는다).
   *  ★ 균형 모드가 아니면 합계 개념 자체가 없다(성긴 14일 표) → 종전대로 MAX_DAY. */
  function maxFor(d) {
    if (!balanceOn()) return MAX_DAY;
    var cur = (d == null) ? 0 : planFor(d);
    var room = targetTotal() - sumPlan();               // 남은 배분수(음수 = 이미 초과)
    return Math.min(MAX_DAY, Math.max(minFor(d), cur + Math.max(0, room)));
  }

  /* ══ 주말 정책 재배분 (사용자 요청 2026-08-21 ①②) ═══════════════════════
     주말 포함/제외를 바꾸면 그 설정에 맞게 **오늘 이후 날짜별 인원을 다시 깐다**.
     ★★ 총량은 변하지 않는다 — 목표(총량 − 어제까지 확정)를 채울 때까지 "여는 날"에 기본
       일건수씩 깔고 마지막 날은 남은 만큼만. 그래서 **주말을 닫으면 종료일이 뒤로 밀리고,
       주말을 열면 뒤에 붙어 있던 날이 0으로 닫히며 종료일이 앞당겨진다**(양방향 대칭).
     ★★ **제안까지만 — 반영은 사람이 [확정 저장]을 누를 때** 기존 저장 경로(savePlans →
       작업표 재구성)로 일어난다. 조용한 자동수정 금지(레포 규율) + 이미 채워진 줄·오늘
       확정분은 서버가 최종 방어한다.
     ★ 구간 뒤에 남는 자리는 **해제(remove)가 아니라 명시 0** 으로 닫는다 — 해제하면 작업표
       행 수가 다시 기준이 되어 그 날이 계속 열린다(= 종료일이 안 당겨진다). */

  /** 재배분 대상이 아닌 사유(대상이면 null) — 화면이 이 값으로 사유를 말한다. */
  function rebalanceReason() {
    if (!S || !S.data) return 'no_data';
    var j = S.data;
    if (j.planEnabled === false) return 'plan_off';
    // 시트 일정 공고는 날짜를 시트가 정한다 — 여기서 다시 깔면 시트 우선권을 통째로 뺏는다.
    if (j.scheduleDriven === true) return 'schedule_driven';
    if ((Number(j.defaultDaily) || 0) <= 0) return 'no_daily';
    var tot = totalFor();
    if (tot <= 0) return 'unlimited';
    // 하루에 전량을 여는 공고(블로그 등)는 날짜 배분 개념이 없다.
    if (tot <= (Number(j.defaultDaily) || 0)) return 'single_day';
    if (targetTotal() <= 0) return 'full';
    if (minFor(j.today) > targetTotal()) return 'today_over';
    return null;
  }
  var REBAL_WHY = {
    plan_off: '날짜별 조절 기능이 꺼져 있어 재배분할 수 없습니다',
    schedule_driven: '시트 일정 공고는 시트가 날짜를 정합니다 — 시트에서 진행 날짜를 조정해주세요',
    no_daily: '하루 진행 인원(일건수)이 없어 재배분할 수 없습니다 — 공고 수정에서 먼저 입력해주세요',
    unlimited: '총 모집인원이 무제한이라 재배분할 것이 없습니다',
    single_day: '하루에 전량을 여는 공고라 날짜 배분이 없습니다',
    full: '이미 총 모집인원을 다 채웠습니다',
    today_over: '오늘 확정·진행 인원이 남은 배분수보다 많아 재배분할 수 없습니다',
    too_long: '재배분 구간이 한 번에 저장 가능한 ' + MAX_ROWS + '일을 넘습니다 — 아래에서 날짜별로 조절해주세요',
  };

  /** 재배분 계산(순수) — 상태를 읽지 않고 인자만 본다(테스트·사본 방지).
   *  o = { from, today, target, daily, floor, closed(d), keep:{d:n}, tail:[d…], maxRows }
   *  반환 = { plan:{d:n}, dates:[d…], last, open:[d…], shut:[d…] } | null(상한 안에서 총량 미달) */
  function planWeekendSpread(o) {
    var plan = {}, dates = [], sum = 0, d = o.from, guard = 0;
    var target = Math.max(0, Number(o.target) || 0);
    var daily = Math.max(0, Number(o.daily) || 0);
    var floor = Math.max(0, Number(o.floor) || 0);
    var maxRows = Number(o.maxRows) || MAX_ROWS;
    var floorFor = (typeof o.floorFor === 'function') ? o.floorFor : function () { return 0; };
    var kept = [];   // 이미 채워져 있어 닫지 못한 날(화면이 사실대로 말한다)
    while (guard++ < 400 && dates.length < maxRows) {
      // ★★ 그날 하한 = 오늘 확정·진행 인원(오늘) 또는 **이미 채워진 작업표 줄 수**(미래 날짜).
      //   이 아래로 내려간 계획은 서버 재구성이 통째로 거부한다(worktable_rebuild_below_used).
      var lo = (d === o.today) ? Math.max(floor, floorFor(d)) : floorFor(d);
      var cap = o.closed(d) ? 0 : daily;
      if (cap < lo) cap = lo;
      var v = Math.min(cap, Math.max(0, target - sum));
      if (v < lo) v = lo;                              // 하한은 목표보다 우선(줄일 수 없다)
      if (o.closed(d) && v > 0) kept.push(d);          // 닫으려 했으나 이미 사람이 있는 날
      plan[d] = v; dates.push(d); sum += v;
      if (sum >= target) break;
      d = addDays(d, 1);
    }
    if (sum < target) return null;                     // 상한 안에서 총량을 못 채운다
    var last = dates[dates.length - 1];
    // 구간 뒤에 남은 자리는 명시 0 으로 닫는다(위 규율)
    var shut = [];
    (o.tail || []).forEach(function (x) {
      if (x <= last || plan[x] != null) return;
      var lo = floorFor(x);                            // 이미 채워진 줄은 닫을 수 없다(위와 같은 하한)
      plan[x] = lo; dates.push(x);
      if (lo === 0) shut.push(x); else kept.push(x);
    });
    // 시작일이 미래인 공고의 today ≤ d < 시작일 구간에 저장된 계획은 **손대지 않는다**
    // (화면에서 빼면 저장 시 remove 로 나가 사람이 정해 둔 계획이 조용히 사라진다).
    Object.keys(o.keep || {}).forEach(function (x) {
      if (plan[x] == null) { plan[x] = o.keep[x]; dates.push(x); }
    });
    dates.sort();
    return { plan: plan, dates: dates, last: last, shut: shut, kept: kept };
  }

  /** 지금 상태로 재배분안을 만든다(대상 아님·불가면 null) */
  function buildWeekendPlan() {
    if (rebalanceReason()) return null;
    var j = S.data, today = j.today;
    var tail = {};
    Object.keys(S.base).forEach(function (x) { if (x >= today) tail[x] = 1; });
    (j.worktableDates || []).forEach(function (x) {
      var dd = String(x.date || '').slice(0, 10);
      if (dd >= today && (Number(x.slots) || 0) > 0) tail[dd] = 1;
    });
    var keep = {};
    var from = baseDate();
    Object.keys(S.base).forEach(function (x) { if (x >= today && x < from) keep[x] = S.base[x]; });
    return planWeekendSpread({
      from: from, today: today, target: targetTotal(),
      daily: Number(j.defaultDaily) || 0, floor: minFor(today),
      closed: policyClosed, floorFor: minFor,
      keep: keep, tail: Object.keys(tail).sort(), maxRows: MAX_ROWS,
    });
  }

  /** 주말 정책과 어긋난 날 — 주말 제외인데 인원이 배정된 오늘 이후 날짜(그 날은 신청이 막힌다).
   *  ★ 주말 **포함** 쪽은 감지하지 않는다(토/일 0 이 의도일 수 있다 — 구분 불가). */
  function weekendConflicts() {
    if (!S || !S.data || S.data.skipWeekends !== true) return [];
    var today = S.data.today, seen = {}, out = [];
    (S.horiz || []).concat(Object.keys(S.plan)).forEach(function (d) {
      if (seen[d] || d < today) return;
      seen[d] = 1;
      if (policyClosed(d) && planFor(d) > 0) out.push(d);
    });
    return out.sort();
  }

  /** 재배분안을 화면에 펼친다(저장하지 않는다) — 반환 = 요약 | null */
  function applyWeekendPlan() {
    var r = buildWeekendPlan();
    if (!r) return null;
    S.plan = r.plan;
    S.horiz = r.dates.slice();
    S.balance = true;
    S.balanceOff = null;
    S.shortBy = 0;
    S.outside = null;
    // ★ 이월은 재배분에 이미 녹아 있다(목표 = 총량 − 어제까지 확정) — 이월 배치 블록을
    //   그대로 두면 "이월 N명이 어디에도 얹혀 있지 않습니다"라는 거짓 문구가 남는다.
    S.carryMap = {};
    S.rebalanced = { last: r.last, shut: r.shut.length, kept: (r.kept || []).slice(0, 6),
      keptN: (r.kept || []).length,
      days: r.dates.filter(function (d) { return r.plan[d] > 0; }).length };
    S.modePlan = JSON.parse(JSON.stringify(r.plan));
    render();
    return S.rebalanced;
  }

  /* 자동 맞춤 — 부족/초과분만 고른 방식대로 메운다(전체 재배치가 아니라 **차이만** 손댄다).
     ★ 남는 부족분은 종료일 뒤에 새 진행일을 붙여 흡수한다 — 총량은 어떤 조절로도 변하지 않는다. */
  function autoFit() {
    if (!balanceOn()) return;
    var need = -diffPlan();                 // +면 채워야 함, −면 줄여야 함
    if (!need) return;
    var ds = (S.horiz || []).filter(function (d) { return baseFor(d) > 0 || planFor(d) > 0; });
    var cap = dayCeil(), guard = 0;
    var extendEnd = null;
    // 종료일 연장은 기존 작업표의 0명 행에 막히지 않고, 기본 일건수 단위로 새 날짜를 연다.
    // 단, 주말 제외 공고는 명시 계획이 있는 주말(baseFor>0)만 열 수 있다.
    var extendSlot = function (d) {
      var base = baseFor(d);
      if (base > 0) return Math.min(cap, base);
      if (S.data.skipWeekends === true && dayKind(d)) return 0;
      return Math.min(cap, Math.max(0, Number(S.data.defaultDaily) || 0));
    };
    if (need > 0 && S.carryMode === 'extend') {
      // 종료일 연장은 과거/오늘을 절대 건드리지 않는다. 마지막 진행일의 부분 수량만
      // 기본 일건수까지 채운 뒤, 그 다음 날짜부터 새 수량을 붙인다.
      var filledDays = (S.horiz || []).filter(function (d) { return planFor(d) > 0; });
      extendEnd = filledDays.length ? filledDays[filledDays.length - 1] : null;
      if (extendEnd && extendEnd !== S.data.today) {
        var exSlot = extendSlot(extendEnd);
        var exPut = Math.min(Math.max(0, exSlot - planFor(extendEnd)), need);
        if (exPut > 0) { S.plan[extendEnd] = planFor(extendEnd) + exPut; need -= exPut; }
      }
    }
    if (S.carryMode === 'spread') {
      // ★ 한 명씩 돌리는 루프(최악 240만 회)는 큰 부족분에서 화면을 얼린다 — 몫/나머지로 한 번에.
      //   여력이 모자란 날이 있으면 남은 몫만 다시 돌린다(최대 몇 회).
      var sign = need > 0 ? 1 : -1, left = Math.abs(need);
      while (left > 0 && guard++ < 50) {
        var room = ds.map(function (d) {
          return sign > 0 ? Math.max(0, cap - planFor(d)) : Math.max(0, planFor(d) - minFor(d));
        });
        var avail = room.reduce(function (a, b2) { return a + b2; }, 0);
        if (avail <= 0) break;
        var take = Math.min(left, avail), per = Math.floor(take / ds.length), rem2 = take % ds.length, put0 = 0;
        for (var i = 0; i < ds.length && put0 < take; i++) {
          var want = Math.min(room[i], per + (i < rem2 ? 1 : 0), take - put0);
          if (want > 0) { S.plan[ds[i]] = planFor(ds[i]) + sign * want; put0 += want; }
        }
        if (put0 <= 0) break;
        left -= put0;
      }
      need = sign * left;
    } else {
      // next = 이른 날부터 채우고 / extend = 늦은 날부터 채운다. 초과는 어느 방식이든 뒤에서 덜어낸다.
      var order = (need > 0 && S.carryMode === 'next') ? ds.slice() : ds.slice().reverse();
      for (var k = 0; k < order.length && need !== 0; k++) {
        var d2 = order[k];
        if (need > 0) {
          // ★★ "종료일 뒤에 붙이기"는 **각 날 인원을 그대로 두는** 방식이다 — 부족분을 기존 날에
          //   얹으면(특히 마지막 날에 쌓으면) 고른 방식과 정반대가 되고, 사람이 방금 줄여 둔 날을
          //   되돌려 놓기까지 한다. 그래서 이 방식의 부족분은 전부 아래 **새 진행일**로 흘려보낸다.
          if (S.carryMode === 'extend') continue;
          var put = Math.min(cap - planFor(d2), need);
          if (put > 0) { S.plan[d2] = planFor(d2) + put; need -= put; }
        } else {
          var cut = Math.min(planFor(d2) - minFor(d2), -need);
          if (cut > 0) { S.plan[d2] = planFor(d2) - cut; need += cut; }
        }
      }
    }
    if (need > 0) {
      /* ★ 구간에 이미 올라와 있는 **0 명 준비일**(작업표에 빈 줄이 남은 날)을 먼저 채운다 —
         건너뛰고 새 날을 만들면 준비된 줄을 두고 뒤에 줄을 더 만드는 꼴이 된다.
         next·spread 는 위 루프가 이미 채웠으므로 여기서는 no-op 이다(extend 전용 경로). */
      (S.horiz || []).filter(function (dz) {
        return S.carryMode !== 'extend' || !extendEnd || dz > extendEnd;
      }).forEach(function (dz) {
        if (need <= 0 || planFor(dz) > 0) return;
        var bz = S.carryMode === 'extend' ? extendSlot(dz) : baseFor(dz); if (bz <= 0) return;
        var putz = Math.min(bz, need, cap);
        if (putz > 0) { S.plan[dz] = putz; need -= putz; }
      });
    }
    if (need > 0) {
      var d3 = (S.carryMode === 'extend' && extendEnd)
        ? addDays(extendEnd, 1)
        : (S.horiz.length ? addDays(S.horiz[S.horiz.length - 1], 1) : baseDate()), g2 = 0;
      while (need > 0 && g2++ < 400 && S.horiz.length < MAX_ROWS) {
        var b = S.carryMode === 'extend' ? extendSlot(d3) : baseFor(d3);
        if (b > 0) { var v = Math.min(b, need); S.plan[d3] = v; S.horiz.push(d3); need -= v; }
        d3 = addDays(d3, 1);
      }
    }
    render();
    // 하한·상한에 막혀 다 못 메웠으면 **말한다** — 눌러도 아무 일 없는 버튼을 두지 않는다
    if (diffPlan() !== 0) {
      toast(diffPlan() > 0
        ? '오늘 확정·진행 인원 아래로는 줄일 수 없어 ' + diffPlan() + '명이 남았습니다'
        : (-diffPlan()) + '명을 더 열 자리가 없습니다 — 한 날 최대(' + dayCeil() + '명)·저장 상한('
          + MAX_ROWS + '일)·남은 진행일을 확인해주세요');
    }
  }

  /** 예상 종료일: 기준일부터 계획값대로 채운다고 가정(최대 400일 탐색). 무제한이면 null */
  function endDate() {
    var total = totalFor();
    if (total <= 0) return null;
    var todaySub = S.data.byDateSubmitted[S.data.today] || 0;
    var remain = total - Math.max(0, (S.data.submittedAll || 0) - todaySub);
    if (remain <= 0) return S.data.today;
    var d = baseDate();
    for (var i = 0; i < 400; i++) {
      remain -= planFor(d);
      if (remain <= 0) return d;
      d = addDays(d, 1);
    }
    return null; // 계획이 전부 0이거나 도달 불가 — '계산 불가'로 표기
  }

  /* ── 마운트(body 직속) ───────────────────────────────────── */
  var CSS = ''
    + '#cdpModal{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55)}'
    + '#cdpModal .cdp-box{background:var(--card,#fff);color:var(--t1,#1f2937);width:min(920px,94vw);max-height:92vh;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.28);overflow:hidden}'
    + '#cdpModal .cdp-hd{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--border,#e5e7eb);background:var(--bg2,#f9fafb);font-weight:800;font-size:.85rem}'
    + '#cdpModal .cdp-x{margin-left:auto;border:0;background:none;font-size:1.05rem;cursor:pointer;color:var(--t3,#9ca3af)}'
    /* ★★ 위(안내·현황·이월 방식·균형 바·표 머리)는 **고정**, 스크롤은 날짜 목록부터
         (사용자 확정 2026-08-07 — "행고정하듯이"). 그래서 본문 자체는 스크롤하지 않고
         내부에 고정 영역(.cdp-fix)과 스크롤 영역(.cdp-sc) 둘을 둔다.
       ★ flex 자식은 기본 `min-height:auto` 라 **`min-height:0` 이 없으면 스크롤이 안 생기고**
         내용만큼 늘어난다(업체관리 도구줄 sticky 가 죽었던 것과 같은 함정). */
    + '#cdpModal .cdp-bd{padding:0;overflow:hidden;font-size:.8rem;flex:1;min-height:0;display:flex;flex-direction:column}'
    + '#cdpModal .cdp-fix{padding:14px 18px 0;flex:0 0 auto}'
    + '#cdpModal .cdp-sc{padding:0 18px 14px;overflow-y:auto;flex:1 1 auto;min-height:0}'
    + '#cdpModal .cdp-sub{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px;margin-bottom:8px;font-size:.72rem;color:var(--t3,#6b7280)}'
    + '#cdpModal .cdp-sub b{color:#1b64da}'
    + '#cdpModal .cdp-note{background:var(--bg2,#f9fafb);border:1px solid var(--border,#e5e7eb);border-left:4px solid #94a3b8;border-radius:8px;padding:8px 12px;font-size:.72rem;margin:8px 0;color:var(--t2,#475569)}'
    + '#cdpModal .cdp-note.warn{border-left-color:#f59e0b;background:#fffbeb;color:#92400e}'
    + '#cdpModal .cdp-note.err{border-left-color:#dc2626;background:#fef2f2;color:#991b1b}'
    /* ── ① 진행 현황(요구 ②③) ── */
    + '#cdpModal .cdp-stat{box-sizing:border-box;border:1px solid var(--border,#dde3ee);border-radius:11px;padding:11px 13px;margin-bottom:10px;background:var(--bg2,#fbfcff)}'
    + '#cdpModal .cdp-stat .r1{display:flex;align-items:center;gap:9px;flex-wrap:wrap}'
    + '#cdpModal .cdp-stat .big{font-size:.98rem;font-weight:800;letter-spacing:-.3px}'
    + '#cdpModal .cdp-stat .big em{font-style:normal;color:#2f6fed}'
    + '#cdpModal .cdp-cb{background:#fff7ed;border:1px solid #fdba74;color:#9a3412;font-size:.7rem;font-weight:800;padding:2px 9px;border-radius:999px}'
    + '#cdpModal .cdp-cb.un{background:#f1f5f9;border-color:#cbd5e1;color:#64748b}'
    + '#cdpModal .cdp-stat .bar{height:8px;border-radius:5px;background:#e6ebf4;margin:9px 0 8px;overflow:hidden}'
    + '#cdpModal .cdp-stat .bar i{display:block;height:100%;background:linear-gradient(90deg,#4b87f5,#2f6fed);border-radius:5px}'
    + '#cdpModal .cdp-stat .kv{display:flex;gap:15px;flex-wrap:wrap;font-size:.72rem;color:var(--t2,#4d5768)}'
    + '#cdpModal .cdp-stat .kv b{color:var(--t1,#1f2430)}'
    + '#cdpModal .cdp-stat .kv .end{color:#b45309}'
    /* ── ② 이월 보충 투입 방식(요구 ④) ── */
    + '#cdpModal .cdp-carry{box-sizing:border-box;border:1px solid #fcd9a8;background:#fffdf8;border-radius:11px;padding:11px 13px;margin-bottom:10px;color:#3f3524}'
    + '#cdpModal .cdp-carry .t{font-size:.77rem;font-weight:800;margin-bottom:3px}'
    + '#cdpModal .cdp-carry .t b{color:#b45309}'
    + '#cdpModal .cdp-carry .d{font-size:.68rem;color:#7b6a52;line-height:1.55;margin-bottom:9px}'
    + '#cdpModal .cdp-seg{display:grid;grid-template-columns:repeat(3,1fr);gap:0;background:#f3ede3;border-radius:9px;padding:3px}'
    + '#cdpModal .cdp-seg button{border:0;background:none;padding:8px 5px;border-radius:7px;cursor:pointer;font-family:inherit;font-size:.71rem;font-weight:700;color:#6b6152;line-height:1.35}'
    + '#cdpModal .cdp-seg button.on{background:#eef4ff;border-color:#5d83e6;color:#315aba;box-shadow:0 1px 4px rgba(60,40,10,.12)}'
    + '#cdpModal .cdp-seg button small{display:block;font-weight:600;font-size:.6rem;color:#a1937f;margin-top:2px}'
    + '#cdpModal .cdp-seg button.on small{color:#5875b7}'
    + '#cdpModal .cdp-seg .df{display:inline-block;font-size:.54rem;background:#fde68a;color:#78350f;border-radius:4px;padding:0 4px;margin-left:3px;vertical-align:1px}'
    + '#cdpModal .cdp-carry .where{margin-top:9px;font-size:.7rem;line-height:1.6;color:#7c3d09;background:#fff3e2;border:1px solid #f8d5aa;border-radius:8px;padding:8px 11px}'
    + '#cdpModal .cdp-carry .cmp{margin-top:7px;font-size:.66rem;color:#8a7a63}'
    + '#cdpModal .cdp-carry .cmp b{color:#7c3d09}'
    /* 시안과 같은 두 칼럼 구조: 좌측은 요약·배정 방식, 우측만 날짜별 계획을 조절한다. */
    + '#cdpModal .cdp-bd{padding:0}#cdpModal .cdp-layout{display:grid;grid-template-columns:205px minmax(0,1fr);flex:1;min-height:0}'
    + '#cdpModal .cdp-side{padding:18px;border-right:1px solid var(--border,#e5e7eb);background:var(--bg2,#f8fafc);overflow-y:auto}'
    + '#cdpModal .cdp-main{padding:24px 28px 0;display:flex;flex-direction:column;min-height:0}'
    + '#cdpModal .cdp-fix{padding:0;flex:0 0 auto}#cdpModal .cdp-sc{padding:0 0 14px;overflow-y:auto;flex:1 1 auto;min-height:0}'
    + '#cdpModal .cdp-stat{margin:0 0 16px;padding:0;border:0;background:none}#cdpModal .cdp-stat .bar{display:block}'
    + '#cdpModal .cdp-stat .kv{display:block;margin-top:13px}#cdpModal .cdp-stat .kv span{display:block;padding:8px 0;border-bottom:1px solid var(--border,#e5e7eb)}'
    + '#cdpModal .cdp-carry{margin:0;padding:0;border:0;background:none}.cdp-carry .d,#cdpModal .cdp-carry .where,#cdpModal .cdp-carry .cmp{display:none}'
    + '#cdpModal .cdp-seg{grid-template-columns:1fr;gap:5px;padding:0;background:none}#cdpModal .cdp-seg button{border:1px solid #d5e0ef;background:#fff;padding:8px;text-align:left}#cdpModal .cdp-seg button small{display:block}'
    + '#cdpModal .cdp-side .cdp-carry .d,#cdpModal .cdp-side .cdp-carry .where,#cdpModal .cdp-side .cdp-carry .cmp{display:none!important}'
    + '#cdpModal .cdp-side>.cdp-note{margin:16px 0 0;border:0;background:#fff8e5;padding:10px;font-size:.68rem;color:#99500d}'
    /* 기본 화면은 현황·배정방식·날짜 조절만 보여 준다. 이력/복구/설명은 접어서 필요할 때만 연다. */
    + '#cdpModal .cdp-more{margin:10px 0 14px;border-top:1px solid var(--border,#e5e7eb);color:var(--t2,#4d5768)}'
    + '#cdpModal .cdp-more summary{cursor:pointer;padding:10px 0;font-size:.7rem;font-weight:700;color:#68778f}'
    + '#cdpModal .cdp-more[open] summary{color:var(--t1,#1f2430)}'
    + '#cdpModal .cdp-more .cdp-note{margin:0 0 8px}.cdp-more .cdp-sec{margin-top:8px}.cdp-more .cdp-hist{margin-top:10px}'
    + '#cdpModal .cdp-publish{margin:0 0 10px;padding:9px 12px;border-left:3px solid #f59e0b;background:#fffbeb;color:#925b13;font-size:.72rem;line-height:1.45}'
    /* ── ③ 배분 균형 바(요구 ⑥) — 높이는 "일치(초록)" 기준 41px 로 고정한다.
          상태마다 바가 커졌다 작아지면 아래 표가 위아래로 흔들려 조절하던 줄을 놓친다(사용자 확정). */
    + '#cdpModal .cdp-bal{box-sizing:border-box;position:sticky;top:0;z-index:5;border-radius:11px;height:41px;padding:0 13px;margin-bottom:11px;border:1.5px solid;display:flex;align-items:center;gap:11px;flex-wrap:nowrap;overflow:hidden}'
    + '#cdpModal .cdp-bal .ico{font-size:1.02rem;line-height:1;flex:0 0 auto}'
    + '#cdpModal .cdp-bal .txt{flex:1;min-width:0}'
    + '#cdpModal .cdp-bal .cdp-btn{flex:0 0 auto;padding:5px 10px;font-size:.68rem}'
    + '#cdpModal .cdp-bal .l1{font-size:.79rem;font-weight:800;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '#cdpModal .cdp-bal .num{font-variant-numeric:tabular-nums}'
    + '#cdpModal .cdp-bal.ok{background:#ecfdf3;border-color:#86dfae;color:#14653a}'
    + '#cdpModal .cdp-bal.over{background:#fef2f2;border-color:#f4a9a9;color:#a81f1f}'
    + '#cdpModal .cdp-bal.under{background:#eff5ff;border-color:#a9c6f6;color:#1b46a8}'
    + '@media (max-width:700px){#cdpModal .cdp-layout{display:block}#cdpModal .cdp-side{border-right:0;border-bottom:1px solid var(--border,#e5e7eb)}#cdpModal .cdp-main{padding:16px}#cdpModal .cdp-stat .kv{display:flex;gap:8px;flex-wrap:wrap}#cdpModal .cdp-stat .kv span{width:auto;border:0;padding:0}#cdpModal .cdp-carry .d,#cdpModal .cdp-carry .where,#cdpModal .cdp-carry .cmp{display:block}#cdpModal .cdp-seg{grid-template-columns:1fr}#cdpModal .cdp-colhead,#cdpModal .cdp-row{grid-template-columns:88px 44px 42px minmax(120px,1fr);column-gap:7px}#cdpModal .cdp-row{padding:6px 2px}#cdpModal .cdp-ctl{gap:4px}#cdpModal .cdp-st{width:24px;height:24px}#cdpModal .cdp-d{font-size:.68rem}#cdpModal .cdp-state{font-size:.6rem}}'
    + '@media (max-width:560px){#cdpModal .cdp-bal{height:auto;min-height:41px;padding:9px 12px;flex-wrap:wrap}'
    + '#cdpModal .cdp-bal .l1{white-space:normal}#cdpModal .cdp-seg{grid-template-columns:1fr}}'
    /* 날짜별 계획표: 시안의 날짜·상태·일 건수·조절 4열을 공용 모달의 실제 행 구조로 쓴다. */
    + '#cdpModal .cdp-colhead,#cdpModal .cdp-row{display:grid;grid-template-columns:148px 72px 66px minmax(190px,1fr);align-items:center;column-gap:12px}'
    + '#cdpModal .cdp-colhead{height:37px;border-bottom:1px solid var(--border,#e5e7eb);font-size:.68rem;color:var(--t3,#718096)}'
    + '#cdpModal .cdp-colhead .n{text-align:right}'
    + '#cdpModal .cdp-row{min-height:54px;padding:6px 8px;border-bottom:1px solid var(--border,#edf1f5)}'
    + '#cdpModal .cdp-row.hascarry{background:#fffaf2;border-radius:8px}'
    + '#cdpModal .cdp-row.today{background:var(--bg2,#f0f7ff);border-radius:8px}'
    + '#cdpModal .cdp-row.zero{opacity:.72}'
    + '#cdpModal .cdp-d{font-size:.76rem;font-weight:800;color:var(--t2,#334155)}'
    + '#cdpModal .cdp-tag{display:inline-block;font-size:.6rem;font-weight:800;border-radius:999px;padding:0 6px;margin-left:4px;vertical-align:1px}'
    + '#cdpModal .cdp-tag.tdy{color:#1d4ed8;background:#dbeafe}'
    + '#cdpModal .cdp-tag.adj{color:#92400e;background:#fef3c7}'
    + '#cdpModal .cdp-tag.rst{color:#7c8698;background:#eef1f7}'
    // 공휴일·일요일 = 빨강 / 토요일 = 파랑(달력 관용) — 색은 리터럴(테마 없는 호스트에도 얹힌다)
    + '#cdpModal .cdp-d.hol{color:#dc2626;font-weight:800}'
    + '#cdpModal .cdp-d.sat{color:#2563eb;font-weight:800}'
    + '#cdpModal .cdp-tag.hol{color:#b91c1c;background:#fee2e2;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#cdpModal .cdp-state{font-size:.68rem;color:var(--t3,#7b8799)}#cdpModal .cdp-state.open{color:#3866c9;font-weight:700}'
    + '#cdpModal .cdp-g{position:relative;height:8px;border-radius:8px;background:var(--bg2,#f1f5f9);cursor:ew-resize;user-select:none;touch-action:none;flex:1}'
    + '#cdpModal .cdp-g .f{position:absolute;left:0;top:0;bottom:0;border-radius:12px;background:linear-gradient(90deg,#60a5fa,#3b82f6)}'
    // 이월분은 같은 막대 안에서 주황으로 이어 붙여 "여기에 이월이 얹혔다"를 눈으로 보여준다
    + '#cdpModal .cdp-g .cy{position:absolute;top:0;bottom:0;border-radius:0 12px 12px 0;background:linear-gradient(90deg,#fbbf24,#f59e0b);pointer-events:none}'
    + '#cdpModal .cdp-g .c{position:absolute;left:0;top:0;bottom:0;border-radius:12px 0 0 12px;background:#1d4ed8;opacity:.5;pointer-events:none}'
    + '#cdpModal .cdp-g .b{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--t3,#94a3b8);pointer-events:none}'
    + '#cdpModal .cdp-g .k{position:absolute;top:50%;transform:translate(-50%,-50%);width:15px;height:15px;border-radius:50%;background:#fff;border:3px solid #2563eb;box-shadow:0 1px 4px rgba(15,23,42,.25);pointer-events:none}'
    + '#cdpModal .cdp-ctl{display:flex;align-items:center;gap:9px;min-width:0}'
    + '#cdpModal .cdp-num{text-align:right;font-weight:800;font-size:.92rem;font-variant-numeric:tabular-nums}'
    + '#cdpModal .cdp-num small{display:none}'
    + '#cdpModal .cdp-num small i,#cdpModal .cdp-num small em{font-style:normal;white-space:nowrap}'
    /* ★ 라벨은 말줄임이 아니라 **줄바꿈**한다 — 오늘 줄의 "＋이월 N"이 잘리면 이월이 어디에
       얹혔는지가 화면에서 사라진다(주황 막대만 남아 숫자를 못 읽는다). 줄 높이가 조금 늘 뿐이다. */
    + '#cdpModal .cdp-num small em{font-style:normal;color:#b45309;font-weight:800}'
    + '#cdpModal .cdp-in{box-sizing:border-box;width:100%;border:1px solid transparent;background:none;text-align:center;font-family:inherit;font-size:.84rem;font-weight:800;color:var(--t1,#1f2430);padding:1px 2px;border-radius:5px;font-variant-numeric:tabular-nums}'
    + '#cdpModal .cdp-in:focus{border-color:#2f6fed;background:var(--card,#fff);outline:none}'
    + '#cdpModal .cdp-st{width:27px;height:27px;flex:0 0 auto;border-radius:7px;border:1px solid var(--border,#cbd5e1);background:var(--card,#fff);color:var(--t1,#334155);font-size:.9rem;font-weight:800;cursor:pointer;line-height:1}'
    + '#cdpModal .cdp-reset{border:0;background:none;color:var(--t3,#94a3b8);font-size:.62rem;cursor:pointer;text-decoration:underline;padding:0}'
    + '#cdpModal .cdp-end{margin-top:10px;background:var(--bg2,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:9px 13px;font-size:.76rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}'
    + '#cdpModal .cdp-end b{color:#1b64da}'
    + '#cdpModal .cdp-end .chg{color:#b45309;font-weight:700;font-size:.68rem}'
    + '#cdpModal .cdp-heldblk{border:1.5px solid #DDD6FE;background:#F5F3FF;border-radius:12px;padding:11px 13px;margin-bottom:12px}'
    + '#cdpModal .cdp-heldblk .hh{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px}'
    + '#cdpModal .cdp-heldblk .hh b{font-size:.8rem;color:#5B21B6}'
    + '#cdpModal .cdp-heldblk .hn{font-size:1.05rem;font-weight:800;color:#6D28D9}'
    + '#cdpModal .cdp-heldblk .hn small{font-size:.62rem;font-weight:700;color:#7C3AED}'
    + '#cdpModal .cdp-heldblk .hb{display:flex;gap:6px;flex-wrap:wrap}'
    + '#cdpModal .cdp-heldblk .cdp-btn{border-color:#C4B5FD;color:#5B21B6}'
    + '#cdpModal .cdp-heldblk .cdp-btn.hpri{background:#7C3AED;border-color:#7C3AED;color:#fff}'
    + '#cdpModal .cdp-heldblk .hs{font-size:.64rem;color:#6D28D9;margin-top:6px}'
    + '#cdpModal .cdp-sec{margin-top:14px;border-top:1px solid var(--border,#e2e8f0);padding-top:11px}'
    + '#cdpModal .cdp-sec .h{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-weight:800;font-size:.76rem}'
    + '#cdpModal .cdp-rr{display:flex;align-items:center;gap:9px;font-size:.73rem;padding:4px 2px}'
    + '#cdpModal .cdp-rno{font-weight:800;background:#e0e7ff;color:#3730a3;border-radius:6px;padding:1px 7px;font-size:.64rem}'
    + '#cdpModal .cdp-rmeta{color:var(--t3,#64748b)}'
    + '#cdpModal .cdp-rprog{margin-left:auto;font-weight:700}'
    + '#cdpModal .cdp-btn{border:1px solid var(--border,#d1d5db);background:var(--card,#fff);color:var(--t1,#374151);border-radius:8px;padding:6px 12px;font-size:.72rem;font-weight:700;cursor:pointer}'
    + '#cdpModal .cdp-btn.pri{background:#2563eb;border-color:#2563eb;color:#fff}'
    + '#cdpModal .cdp-btn:disabled{opacity:.45;cursor:default}'
    + '#cdpModal .cdp-radd{display:none;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px}'
    + '#cdpModal .cdp-radd.on{display:flex}'
    + '#cdpModal .cdp-radd input{border:1px solid var(--border,#d1d5db);border-radius:8px;padding:6px 9px;font-size:.74rem;background:var(--card,#fff);color:var(--t1,#111827)}'
    + '#cdpModal .cdp-hist{list-style:none;padding:0;margin:6px 0 0;font-size:.68rem;color:var(--t2,#475569);max-height:150px;overflow:auto}'
    + '#cdpModal .cdp-hist li{padding:3px 8px;border-left:3px solid #c7d2fe;margin-bottom:3px;background:var(--bg2,#f8fafc);border-radius:0 6px 6px 0}'
    + '#cdpModal .cdp-ft{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:11px 18px;border-top:1px solid var(--border,#e5e7eb);background:var(--bg2,#f8fafc)}'
    + '#cdpModal .cdp-hint{font-size:.64rem;color:var(--t3,#64748b)}'
    /* (구 읽기전용 블록 .cdp-ro 는 시트 일정 공고 조절 허용(2026-08-07)으로 제거됐다) */
    + '#cdpChoice{position:fixed;inset:0;z-index:10060;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);padding:16px}'
    + '#cdpChoice .ch-box{width:440px;max-width:100%;background:var(--card,#fff);color:var(--t1,#1f2937);border-radius:14px;padding:18px;box-shadow:0 12px 40px rgba(15,23,42,.3)}'
    + '#cdpChoice h4{font-size:.84rem;margin:0 0 5px}'
    + '#cdpChoice .cd{font-size:.74rem;color:var(--t3,#475569);margin-bottom:12px}'
    + '#cdpChoice .op{display:block;width:100%;text-align:left;border:1.5px solid var(--border,#cbd5e1);border-radius:10px;background:var(--card,#fff);color:var(--t1,#1f2937);padding:10px 13px;margin-bottom:7px;cursor:pointer;font-size:.74rem}'
    + '#cdpChoice .op:hover{border-color:#2563eb}'
    + '#cdpChoice .op b{display:block;font-size:.76rem;margin-bottom:2px}'
    + '#cdpChoice .op small{color:var(--t3,#64748b);font-size:.68rem;line-height:1.45;display:block}'
    + '#cdpChoice .op:disabled{opacity:.45;cursor:default}'
    + '#cdpChoice .cx{display:block;margin:5px auto 0;border:0;background:none;color:var(--t3,#94a3b8);font-size:.7rem;cursor:pointer;text-decoration:underline}';

  function ensureMount() {
    if (document.getElementById('cdpModal')) return;
    var st = document.createElement('style');
    st.id = 'cdpModalCss';
    st.textContent = CSS;
    document.head.appendChild(st);
    var ov = document.createElement('div');
    ov.id = 'cdpModal';
    ov.style.display = 'none';
    ov.innerHTML = '<div class="cdp-box">'
      + '<div class="cdp-hd">📅 <span id="cdpTitle"></span><button type="button" class="cdp-x" onclick="CampaignDailyPlan.close()">✕</button></div>'
      + '<div class="cdp-bd" id="cdpBody"></div>'
      + '<div class="cdp-ft"><span class="cdp-hint" id="cdpHint"></span>'
      + '<span><button type="button" class="cdp-btn" id="cdpRebuildBtn" onclick="CampaignDailyPlan._rebuildWorktable()">작업표 재구성</button> '
      + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan.close()">닫기</button> '
      + '<button type="button" class="cdp-btn pri" id="cdpSaveBtn" onclick="CampaignDailyPlan._save()">확정 저장</button></span></div>'
      + '</div>';
    document.body.appendChild(ov);
    // 오버레이 바깥 클릭으로 닫지 않는다 — 조절해 둔 값이 실수 클릭 한 번에 날아가지 않게(리뷰검수 팝업 규율).
    var ch = document.createElement('div');
    ch.id = 'cdpChoice';
    ch.style.display = 'none';
    ch.innerHTML = '<div class="ch-box"><h4 id="cdpChTitle"></h4><div class="cd" id="cdpChDesc"></div>'
      + '<button type="button" class="op" id="cdpChExtend" onclick="CampaignDailyPlan._chExtend()"><b>㉮ 종료일 연장 (계획 유지)</b><small id="cdpChExtendDesc"></small></button>'
      + '<button type="button" class="op" id="cdpChSpread" onclick="CampaignDailyPlan._chSpread()"><b>㉯ 남은 날 분산 (종료일 유지)</b><small id="cdpChSpreadDesc"></small></button>'
      + '<button type="button" class="cx" onclick="CampaignDailyPlan._chCancel()">취소 (원래 인원으로 되돌리기)</button></div>';
    document.body.appendChild(ch);
  }

  /* ── 열기/닫기 ───────────────────────────────────────────── */
  async function open(campId) {
    ensureMount();
    S = { campId: String(campId), title: '', data: null, plan: {}, base: {}, notes: [],
          sessions: {}, choice: null, saving: false, baseEnd: null, error: null, carryStage: 0 };
    document.getElementById('cdpModal').style.display = 'flex';
    document.getElementById('cdpTitle').textContent = '모집인원 조절';
    document.getElementById('cdpBody').innerHTML = '<div class="cdp-note">불러오는 중…</div>';
    document.getElementById('cdpSaveBtn').disabled = true;
    try {
      applyOverview(await _req('GET', EP + encodeURIComponent(S.campId) + '/daily-plan'));
    } catch (e) {
      // 로딩 자리표시자를 깐 함수는 어떤 예외에도 화면을 종결시킨다(무한로딩 금지)
      document.getElementById('cdpBody').innerHTML =
        '<div class="cdp-note err">불러오지 못했습니다: ' + _esc(e.message || e) + '</div>'
        + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan._retry()">다시 시도</button>';
    }
  }
  function _retry() { if (S) open(S.campId); }

  /** 주말 설정을 바꿔 저장한 직후 호출 — 조절 모달을 열고 **재배분안을 펼쳐 보여준다**.
   *  ★ 저장하지 않는다(제안까지만) · 로드 실패면 open 이 이미 사유를 그렸으므로 조용히 끝낸다. */
  async function openWeekendRebalance(campId) {
    await open(campId);
    if (!S || !S.data) return;
    S.wkPrompt = true;
    var why = rebalanceReason();
    if (why) { render(); toast(REBAL_WHY[why] || '재배분 대상이 아닙니다'); return; }
    if (!applyWeekendPlan()) { render(); toast(REBAL_WHY.too_long); return; }
    toast('주말 설정에 맞춰 다시 배분했습니다 — 확인 후 [확정 저장]을 눌러주세요');
  }
  /** 배너 버튼 — 사람이 누를 때만 편다(조용한 자동수정 금지) */
  function _rebalance() {
    if (!S || !S.data) return;
    var why = rebalanceReason();
    if (why) { toast(REBAL_WHY[why] || '재배분 대상이 아닙니다'); return; }
    if (!applyWeekendPlan()) { toast(REBAL_WHY.too_long); return; }
    toast('주말 설정에 맞춰 다시 배분했습니다 — 확인 후 [확정 저장]을 눌러주세요');
  }
  function close() {
    // ★ 균형 모드는 열자마자 구간을 펼쳐 두므로 dirty 가 항상 크다 — "사람이 실제로 바꾼 게 있나"로
    //   판정해야 아무것도 안 건드리고 닫을 때 매번 경고가 뜨지 않는다.
    var touched = S && S.data && (balanceOn() ? changedFromOpen() : dirtyDates().length > 0);
    if (touched && !window.confirm('저장하지 않은 조절이 있습니다. 닫을까요?')) return;
    var m = document.getElementById('cdpModal');
    if (m) m.style.display = 'none';
    var c = document.getElementById('cdpChoice');
    if (c) c.style.display = 'none';
    S = null;
  }

  /* 고른 이월 방식 기억 — **화면 상태일 뿐**(서버 저장값은 날짜별 계획이다).
     ★ 실패는 조용히 무시한다(사생활 보호 모드에서 sessionStorage 접근이 막힌다). */
  var MODE_KEY = 'cdp_carry_mode_';
  function _loadMode() {
    try {
      var v = window.sessionStorage.getItem(MODE_KEY + S.campId);
      return CARRY_MODES.indexOf(v) >= 0 ? v : null;
    } catch (_) { return null; }
  }
  function _saveMode(m) {
    try { window.sessionStorage.setItem(MODE_KEY + S.campId, m); } catch (_) {}
  }

  function applyOverview(j) {
    S.data = j;
    S.title = j.title || '';
    S.plan = {};
    S.base = {};
    S.carryStage = 0;   // 이월 반영 스테이징은 저장/재조회 시 초기화(서버 잔량이 진실)
    // ★ 재배분 배너는 "아직 저장 전"이라는 뜻이다 — 저장·재조회하면 그 말이 거짓이 되므로 지운다.
    S.rebalanced = null; S.wkPrompt = false;
    // API의 today에는 시각이 붙을 수 있지만 계획 날짜는 YYYY-MM-DD다. 원문을
    // 비교하면 오늘의 저장 계획이 과거로 오인되어 S.base에 들어가지 않고, 재오픈할
    // 때 이월분이 또 더해진다. 날짜 키만 맞춰 비교한다.
    var todayKey = String(j.today || '').slice(0, 10);
    (j.plans || []).forEach(function (p) {
      var planKey = String(p.date || '').slice(0, 10);
      if (planKey >= todayKey) { S.plan[p.date] = p.count; S.base[p.date] = p.count; }
    });
    S.baseEnd = null;
    S.balance = false; S.horiz = null; S.carryMap = null; S.openPlan = null; S.outside = null;
    // ★ 기본 보충 방식 = "다음날(첫 진행일) 정원에 더하기"(사용자 확정) — 펼치지 못하면(총량 무제한·
    //   구간이 저장 상한 초과 등) 균형 모드를 끄고 종전 동작(14일 성긴 표)으로 둔다.
    // ★★ **고른 방식은 저장·재조회·재오픈에도 유지한다**(사용자 신고 2026-08-07 — "종료일 뒤에
    //   붙이기로 저장이 됐는데 게이지가 조절 전으로 되돌아간다"). 저장하면 이 함수가 다시 도는데
    //   무조건 'next' 로 깔면 이월이 오늘에 다시 얹힌 배치가 그려져 **저장이 되돌아간 것처럼 보인다**
    //   (실제 저장값은 그대로다 — 화면만 다른 방식으로 다시 제안한 것). 기억은 화면 상태일 뿐이라
    //   sessionStorage 에 담고, 실패해도 무시한다(사생활 보호 모드 등).
    var want = S.carryMode || _loadMode() || DEFAULT_CARRY_MODE;
    /* ★ 고른 방식으로 못 펼치면 기본값 → 그것도 안 되면 next(가장 단순한 배치)로 접는다 —
         어떤 경우에도 균형 표가 통째로 비지 않게. */
    if (!applyCarryMode(want) && want !== DEFAULT_CARRY_MODE) applyCarryMode(DEFAULT_CARRY_MODE);
    if (!S.carryMode) applyCarryMode('next');
    document.getElementById('cdpTitle').textContent = '모집인원 조절 — ' + (S.title || S.campId);
    render();
  }

  function dirtyDates() {
    if (!S || !S.data) return [];
    if (balanceOn()) { var pl = payload(); return pl.set.map(function (x) { return x.date; }).concat(pl.remove).sort(); }
    var out = [];
    var ds = {};
    Object.keys(S.plan).forEach(function (d) { ds[d] = 1; });
    Object.keys(S.base).forEach(function (d) { ds[d] = 1; });
    Object.keys(ds).forEach(function (d) {
      var a = S.plan[d], b = S.base[d];
      if ((a == null) !== (b == null) || (a != null && a !== b)) out.push(d);
    });
    return out.sort();
  }

  /** 균형 모드의 저장 payload — ★★ **손대지 않은 날은 보내지 않는다**.
   *  구간 전체를 무조건 저장하면 ① 아무것도 안 건드리고 [확정 저장]만 눌러도 앞으로의 전 날짜가
   *  리뷰웹 값으로 굳어 **시트 일정 공고의 시트 우선권이 사라지고** ② 자동 이월 공고에서는 서버가
   *  이미 얹고 있는 오늘 이월까지 명시 계획으로 박아 이월이 영영 정산되지 않는다(코드리뷰). */
  function payload() {
    var set = [], remove = [], ds = {}, from = S.data.today, target = targetTotal(), cum = 0;
    // ★★★ **이월을 얹지 않는 방식(extend·spread)은 "저장하지 않으면 성립하지 않는다"**
    //   (사용자 신고 2026-08-07 — "종료일 뒤에 붙이기 선택하였는데 저장이안됨").
    //   `naturalFor` 는 **오늘**만 서버 판정값을 알고 앞날은 기본 일건수로 본다. 그런데 서버의
    //   자동 이월(066)은 **내일도 모레도** 그날 정원에 미달분을 얹으므로, 앞날을 명시 계획으로
    //   고정하지 않으면 사람이 고른 "각 날 인원은 그대로"가 다음 날 그대로 무너진다
    //   (095 규율 = 명시 조절일은 그 값이 그날의 전부 → 자동 가산이 얹히지 않는다).
    //   그래서 **이월이 있고 next 가 아닌 방식**일 때만 구간을 고정한다 — next 는 서버가 이미
    //   같은 일을 하므로 종전대로 보낼 것이 없고(유령 이월 방지), 이월이 없으면 고정할 이유도 없다.
    //   ★ 보류(carry_mode='hold') 공고는 서버가 애초에 얹지 않으므로 억제할 것이 없다 → 고정 안 함.
    /* ★★★ 주말 재배분은 **구간 전체를 명시 계획으로 확정한다**(실브라우저가 잡은 결함).
       종전 규칙("손대지 않은 값은 안 보낸다")대로 두면 **주말이 통째로 빠진다** —
       주말 제외 공고의 토요일은 `baseFor` 가 정책상 0 이라 "0 으로 바꿔도 변경 없음"이 되는데,
       작업표에는 그날 빈 줄 30 개가 그대로 남아 있다. 그 날짜가 저장 계획에 없으면
       rebuildAdjustedPlansToWorktable 의 재구성 풀(managed)에 들어가지 못해 **줄이 옮겨지지
       않고 뒤 날짜에 새 줄만 생겨 총 줄 수가 늘어난다.** 목적지 날짜도 같은 이유로 필요하다.
       ★ 재배분 대상은 시트 일정 공고를 제외했으므로 "시트 우선권 상실" 우려는 없다. */
    var pinAll = !!S.rebalanced || !!(S.carryMode && S.carryMode !== 'next' && (carryAmt() || 0) > 0
      && S.data.carryMode !== 'hold');
    Object.keys(S.plan).forEach(function (d) { if (d >= from) ds[d] = 1; });
    Object.keys(S.base).forEach(function (d) { if (d >= from) ds[d] = 1; });
    Object.keys(ds).sort().forEach(function (d) {
      var v = S.plan[d];
      if (v == null) { if (S.base[d] != null) remove.push(d); return; }
      var nat = naturalFor(d), residual = Math.max(0, target - cum);
      cum += v;
      // ★ 마지막 부분일(총량에 맞춰 남은 만큼만 연 날)은 고정할 필요가 없다 — 서버도 같은
      //   총량 clamp 를 걸고, 고정하지 않으면 앞 날이 미달했을 때 그날이 온전히 열린다(더 안전).
      // ★ **시스템이 깐 값 그대로일 때만** 건너뛴다 — 그냥 `v === residual` 로 두면 균형이 맞은
      //   상태의 마지막 날은 항상 residual 이라 **사람이 의도적으로 줄인 마지막 날이 조용히 누락**된다.
      /* ★ **목표를 이미 채운 뒤(residual === 0)는 이 규칙을 적용하지 않는다** — 그때 v 는 0 이고,
         그 0 은 '남은 만큼만 연 마지막 부분일'이 아니라 **작업표 빈 줄을 닫으려고 명시한 0** 이다.
         걸러내면 구간 뒤 자리를 닫는 저장이 통째로 빠져 줄이 그대로 남는다(2026-08-24 실측). */
      if (residual > 0 && v < nat && v === residual && S.base[d] == null && S.modePlan && v === S.modePlan[d]) return;
      // ★ 고정 모드라도 **이미 같은 값으로 저장돼 있는 날은 보내지 않는다** — 그 날은 이미 명시
      //   계획이라 자동 이월이 얹히지 않는다. 안 걸러내면 저장 직후에도 [확정 저장]이 계속 열려
      //   있어 "저장이 안 됐나?"로 오독된다.
      if (pinAll && S.base[d] === v) return;
      if (!pinAll && v === nat) return;                      // 손대지 않은 값 = 보낼 필요 없음
      // 기본값으로 되돌린 저장분은 "고정"이 아니라 **해제**로 보낸다(시트/일건수 우선권 복귀).
      // ★ 단 pinAll(이월 억제)일 때는 해제하면 안 된다 — 해제 = 자동 이월 복귀 = 고른 방식 무효.
      if (!pinAll && S.base[d] != null && v === baseFor(d)) remove.push(d);
      else set.push({ date: d, count: v });
      return;
    });
    return { set: set, remove: remove };
  }

  /* ── 렌더 ───────────────────────────────────────────────── */
  function rowDates() {
    // 균형 모드 = 오늘~종료일 구간 전부(합계를 총량과 맞춰야 하므로 성긴 표로는 셀 수 없다)
    if (balanceOn()) return S.horiz;
    var ds = {};
    var base = baseDate();   // 오픈 전 캠페인은 시작일부터 — 오픈 전 날짜 조절은 무의미(런타임 preopen)
    for (var i = 0; i < ROW_DAYS; i++) ds[addDays(base, i)] = 1;
    Object.keys(S.plan).forEach(function (d) { if (d >= base) ds[d] = 1; });
    return Object.keys(ds).sort();
  }

  function render() {
    var j = S.data;
    var bd = document.getElementById('cdpBody');
    var save = document.getElementById('cdpSaveBtn');
    var hint = document.getElementById('cdpHint');

    // ★★ 시트 일정 공고도 조절 가능(사용자 확정 2026-08-07 — 종전 읽기 전용 잠금 해제).
    //   규칙은 "조절한 날짜만 시스템이 이긴다" — 그래서 잠그는 대신 **시트 계획을 기준선으로**
    //   보여주고(baseFor/sheetFor), 조절하지 않은 날은 계속 시트를 따른다고 문장으로 말한다.
    /* ★ 지금은 모든 작업이 무시트 작업표다 — 연결이 무시트가 아니면 조절이 **정원만** 바꾸고
       작업표의 줄은 그대로다. 그 상태를 조용히 두면 "조절했는데 표에 줄이 안 생긴다"가 된다. */
    var wtNote = (j.worktableLinked === false)
      ? '<div class="cdp-note" style="border-color:#FCA5A5;background:#FEF2F2;color:#B42318">'
        + '⚠ 이 작업은 <b>무시트 작업표로 전환되지 않은 상태</b>입니다 — 여기서 조절하면 '
        + '<b>정원만 바뀌고 작업표의 줄은 그대로</b>입니다. 표까지 맞추려면 먼저 탈시트 전환을 확인해주세요.'
        + '</div>'
      : '';
    var schNote = '';
    if (j.scheduleDriven === true) {
      var up = (j.scheduleDates || []).filter(function (x) { return x.date >= j.today; });
      var head = up.slice(0, 6).map(function (x) { return _esc(fmtMD(x.date)) + ' ' + x.slots + '명'; }).join(' · ');
      schNote = '<div class="cdp-note">📄 이 공고의 날짜별 <b>기본 정원은 시트의 구매일자 컬럼</b>에서 읽어옵니다'
        + (head ? ' — 앞으로: ' + head + (up.length > 6 ? ' 외 ' + (up.length - 6) + '일' : '') : '')
        + '. <b>여기서 조절한 날짜만 시스템 값이 우선</b>하고, 조절하지 않은 날은 계속 시트를 따릅니다'
        + '([기본으로]를 누르면 그 날은 다시 시트 값으로 돌아갑니다). '
        + '<b>총량(차수)은 시트 행 수가 기준</b>이라 아래 차수 등록은 이 공고의 정원에 영향을 주지 않습니다.</div>';
    } else if (j.scheduleDriven === null) {
      // 판정 실패 = 잠그지 않는다(조절은 어느 쪽이든 저장한 날짜에 그대로 적용된다) — 다만
      // 아래 "기본" 표시가 실제와 다를 수 있다는 사실을 말한다(조용한 오표시 금지).
      schNote = '<div class="cdp-note warn">⚠ 시트 일정 여부를 판정하지 못했습니다 — 아래 <b>기본</b> 표시가 실제와 다를 수 있습니다. '
        + '저장한 날짜의 인원은 그대로 적용됩니다.</div>';
    }

    var killOff = j.planEnabled === false;
    var scale = gaugeScale();
    var bal = balanceOn();
    var rows = rowDates().map(function (d, i) {
      var v = planFor(d);
      var isToday = d === j.today;
      var adjusted = bal
        ? (S.base[d] != null || (S.modePlan && v !== (S.modePlan[d] || 0)))
        : (S.plan[d] != null);
      var conf = isToday ? (j.todayUsed || 0) : 0;
      var cy = bal ? carryOn(d) : 0;
      var eb = bal ? effBase(d) : baseFor(d);   // 이월이 얹히는 출발선(저장된 조절이 있으면 그 값)
      var pw = Math.min(100, scale ? (v / scale * 100) : 0);
      var fw = Math.min(100, scale ? ((v - cy) / scale * 100) : 0);      // 파랑 = 이월이 아닌 인원
      var cw = Math.min(100, scale ? (conf / scale * 100) : 0);
      var bw = Math.min(100, scale ? (baseFor(d) / scale * 100) : 0);   // "기본" 눈금선도 그날 기준선
      var rest = baseFor(d) === 0 && v === 0;
      // ★ 각 조각은 통째로 nowrap — 안 그러면 "＋이" / "월 30" 처럼 토큰 한가운데서 줄이 나뉜다(실측)
      var parts = [];
      if (isToday && conf > 0) parts.push('<i>확정 ' + conf + '</i>');
      if (bal) {
        parts.push('<i>' + (eb === baseFor(d) ? '기본 ' : '조절 ') + eb + '</i>');
        if (cy > 0) parts.push('<em>＋이월 ' + cy + '</em>');
      } else if (S.plan[d] != null) {
        if (!parts.length) parts.push('<button type="button" class="cdp-reset" data-i="' + i + '">기본으로</button>');
      } else if (!parts.length) {
        parts.push('기본 ' + baseFor(d));
      }
      var rowLabel = parts.join(' ');
      var rowLabelPlain = rowLabel.replace(/<[^>]*>/g, '');
      // ★ 공휴일·일요일 = 빨강 / 토요일 = 파랑 — 배분을 짤 때 쉬는 날이 한눈에 보여야 한다.
      //   공휴일 이름은 title 로만(줄이 길어지면 게이지가 밀린다).
      var dk = dayKind(d), hol = holidayName(d);
      var weekendOpen = !!dk && v > 0;
      var stateText = weekendOpen ? '모집 오픈' : (rest ? '휴무' : (isToday ? '오늘' : (adjusted ? '조절' : '기본')));
      return '<div class="cdp-row' + (isToday ? ' today' : '') + (cy > 0 ? ' hascarry' : '') + (rest ? ' zero' : '') + '">'
        + '<span class="cdp-d' + (dk ? ' ' + dk : '') + '"' + (hol ? ' title="' + _esc(hol) + '"' : '') + '>' + _esc(fmtMD(d))
        + (hol ? '<span class="cdp-tag hol">' + _esc(hol) + '</span>' : '')
        + '</span>'
        + '<span class="cdp-state' + (weekendOpen ? ' open' : '') + '" title="' + _esc(rowLabelPlain || stateText) + '">' + stateText + '</span>'
        + '<span class="cdp-num">'
        + (bal
          ? '<input type="text" inputmode="numeric" class="cdp-in" data-i="' + i + '" value="' + v + '"' + (killOff ? ' disabled' : '') + '>'
          : v)
        + '<small>' + rowLabel + '</small></span>'
        + '<div class="cdp-ctl">'
        + '<button type="button" class="cdp-st" data-i="' + i + '" data-d="-1"' + (killOff ? ' disabled' : '') + '>−</button>'
        + '<div class="cdp-g" data-i="' + i + '" aria-label="' + _esc(fmtMD(d)) + ' 모집인원 조절">'
        + '<div class="f" style="width:' + fw + '%"></div>'
        + (cy > 0 ? '<div class="cy" style="left:' + fw + '%;width:' + Math.max(0, pw - fw) + '%"></div>' : '')
        + (conf > 0 ? '<div class="c" style="width:' + cw + '%"></div>' : '')
        + '<div class="b" style="left:' + bw + '%"></div>'
        + '<div class="k" style="left:' + pw + '%"></div>'
        + '</div>'
        + '<button type="button" class="cdp-st" data-i="' + i + '" data-d="1"' + (killOff ? ' disabled' : '') + '>＋</button>'
        + '</div></div>';
    }).join('');

    var e = endDate();
    var endTxt = totalFor() <= 0 ? '무제한(총모집 미설정)' : (e ? fmtMD(e) : '계산 불가');
    if (S.baseEnd === null) S.baseEnd = endTxt;

    /* ── ① 진행 현황(요구 ②③) — 조절 시점의 현재모집인원/총건수·이월·종료일 ── */
    var done = Number(j.submittedAll) || 0, tot = totalFor(), carry = carryAmt();
    // 배지와 [자동 채우기]는 같은 "현재 계획의 부족 수량"을 말해야 한다.
    // 과거 미달(carryPending)보다 현재 부족분이 크면 그 값을 우선 보여 준다.
    var carryNeed = carry === null ? null
      : (bal ? Math.max(carry, Math.max(0, -diffPlan())) : carry);
    var workLeft = (S.horiz || []).filter(function (d) { return planFor(d) > 0; }).length;
    var statBlk = '<div class="cdp-stat"><div class="r1">'
      + '<span class="big">모집 현황 <em>' + done + '</em> / ' + (tot > 0 ? tot : '무제한') + (tot > 0 ? '명' : '') + '</span>'
      // ★ 시트 일정 공고는 그날 정원을 시트가 정해 **이월 개념이 적용되지 않는다** — 여기서 "?"를
      //   띄우면 담당자가 "조회 실패"로 오독해 원인을 엉뚱한 데서 찾는다(heldBlk '해당 없음'과 같은 규율).
      + (j.scheduleDriven === true ? ''
        : carryNeed === null
          ? '<span class="cdp-cb un" title="기준선 조회 실패 등으로 이월 인원을 계산하지 못했습니다">↩ 이월 ?</span>'
          : (carryNeed > 0
            ? '<span class="cdp-cb" title="현재 계획에서 추가 배정이 필요한 수량입니다">↩ 이월 ' + carryNeed + '명</span>'
            : ''))
      + '</div>'
      + (tot > 0 ? '<div class="bar"><i style="width:' + Math.min(100, done / tot * 100).toFixed(1) + '%"></i></div>' : '')
      + '<div class="kv">'
      + (tot > 0 ? '<span>남은 모집 <b>' + Math.max(0, tot - done) + '</b>명</span>' : '')
      + '<span>예상 종료일 <b class="end">' + _esc(endTxt) + '</b></span>'
      + (bal ? '<span>남은 진행일 <b>' + workLeft + '</b>일</span>' : '')
      + '<span>총량 기준 <b>' + (j.scheduleDriven === true ? '시트 행 수' : '차수 합계') + '</b></span>'
      + '</div></div>';

    /* ── ② 이월 보충 투입 방식(요구 ④) — 종료일 고정(얹기) vs 종료일 연장(안 얹기) ── */
    // ★ 균형 모드가 꺼졌으면 **왜인지와 다음 행동**을 말한다(조용한 기능 소실 금지 — 코드리뷰 🟡2)
    var offNote = '';
    if (!bal && S.balanceOff && S.balanceOff !== 'unlimited' && S.balanceOff !== 'full') {
      var offMsg = {
        today_over: '오늘 이미 확정·진행 중인 인원이 남은 배분수보다 많아 배분 표를 만들 수 없습니다 — 총량(차수)을 늘리거나 오늘이 지난 뒤 다시 조절해주세요.',
        no_baseline: '오늘 기준 정원을 서버에서 받지 못해 배분 표를 만들 수 없습니다 — 잠시 후 다시 열어주세요(아래 날짜별 조절은 그대로 씁니다).',
        // ★ `target` 은 아래에서 var 선언되므로 여기서는 undefined 다(호이스팅) — 함수를 직접 부른다
        no_room: '앞으로 진행할 날이 없어 배분 표를 만들 수 없습니다'
          + (j.scheduleDriven === true ? ' — <b>시트에 진행 날짜를 더 넣어주세요.</b>' : ' — 일 모집인원을 확인해주세요.'),
        too_long: '남은 기간이 ' + MAX_ROWS + '일을 넘어 배분 표를 만들 수 없습니다 — 아래에서 날짜별로 조절해주세요.',
      }[S.balanceOff];
      if (offMsg) offNote = '<div class="cdp-note warn">⚠ ' + offMsg + '</div>';
    }
    // ★ 균형 모드는 켜졌지만 지금 계획만으로는 목표에 못 미치는 상태 — **왜 파랑(부족)인지**와
    //   다음 행동을 말한다. 여기서 인원을 늘리면 그대로 초록(저장가능)이 된다.
    // ★ 아직 **지금도** 모자랄 때만 — 사람이 채워 합계가 맞았는데 "130명이 모자랍니다"가 남아
    //   균형 바(딱 맞습니다)와 정면으로 어긋나던 것을 막는다(실브라우저가 잡음).
    if (bal && S.shortBy > 0 && diffPlan() < 0) {
      offNote = '<div class="cdp-note warn">⚠ 지금 <b>' + (j.scheduleDriven === true ? '시트' : '기본') + ' 계획</b>만으로는 배분해야 할 인원보다 <b>'
        + S.shortBy + '명</b>이 모자랍니다 — 아래에서 날짜별 인원을 늘리면(또는 <b>[자동 맞춤]</b>) 합계가 맞는 순간 저장할 수 있습니다'
        + (j.scheduleDriven === true ? '. 시트에 진행 날짜를 더 넣어도 됩니다.' : '.') + '</div>';
    }

    /* ── 주말 정책 재배분 배너(①②) ─────────────────────────────
       ㉮ 방금 재배분한 상태 = 무엇이 어떻게 바뀌는지 + [확정 저장] 안내(초록)
       ㉯ 주말 제외인데 주말에 인원이 남아 있음 = 그 날은 신청이 막힌다 → 제안(앰버)
       ★ 주말 **포함** 전환은 감지하지 않는다 — 토/일 0 이 관리자의 의도일 수 있어
         구분할 수 없다. 그래서 제안은 "주말 설정을 방금 바꿨을 때"만 자동으로 뜬다. */
    var wkNote = '';
    if (S.rebalanced) {
      wkNote = '<div class="cdp-note" style="border-color:#86EFAC;background:#F0FDF4;color:#166534">'
        + '↺ <b>주말 ' + (j.skipWeekends === true ? '제외' : '포함') + '</b> 설정에 맞춰 오늘 이후 일정을 다시 배분했습니다 — '
        + '진행일 <b>' + S.rebalanced.days + '일</b> · 예상 종료일 <b>' + _esc(fmtMD(S.rebalanced.last)) + '</b>'
        + (S.rebalanced.shut ? ' · 뒤에 남아 있던 <b>' + S.rebalanced.shut + '일</b>은 0명으로 닫음' : '')
        + (S.rebalanced.keptN
          ? ' · <b>' + S.rebalanced.keptN + '일</b>('
            + _esc(S.rebalanced.kept.map(fmtMD).join(' · ')) + (S.rebalanced.keptN > S.rebalanced.kept.length ? ' 외' : '')
            + ')은 <b>이미 참여·주문이 있어 닫지 못했습니다</b>'
          : '')
        + '. <b>총 모집인원은 변하지 않습니다.</b> 아래 표를 확인하고 <b>[확정 저장]</b>을 눌러야 작업표까지 반영됩니다'
        + '(저장하지 않고 닫으면 아무것도 바뀌지 않습니다).</div>';
    } else if (S.wkPrompt) {
      var _why = rebalanceReason();
      wkNote = '<div class="cdp-note warn">⚠ <b>주말 ' + (j.skipWeekends === true ? '제외' : '포함') + '</b>로 바꿨습니다 — '
        + (_why
          ? '자동 재배분은 하지 않았습니다: ' + _esc(REBAL_WHY[_why] || '대상이 아닙니다')
          : '아래에서 <b>[주말 기준으로 재배분]</b>을 누르면 오늘 이후 일정을 새 설정으로 다시 깝니다(총량 유지).')
        + '</div>';
    } else {
      var _wkOpen = (S.horiz || []).filter(function (d) {
        return (dayKind(d) === 'sat' || dayKind(d) === 'hol') && Number(S.plan[d]) > 0;
      });
      // 주말에 계획 인원이 있으면 해당 날짜는 일반 진행일처럼 모집된다.
      // 같은 사실을 사이드바에 반복 안내하지 않는다.
    }

    var carryBlk = '';
    // ★ 재배분 직후에는 이월 배치 블록을 그리지 않는다 — 이월은 재배분에 이미 녹아 있어
    //   "이월 N명이 어디에도 얹혀 있지 않습니다"가 거짓 문구가 된다(창구도 둘이 된다).
    if (bal && !S.rebalanced && carryNeed !== null && carryNeed > 0) {
      var placed = carryPlaced(), cds = carryDays(), where = '';
      if (S.carryMode === 'extend') {
        var lastD = null;
        for (var li = S.horiz.length - 1; li >= 0; li--) if (planFor(S.horiz[li]) > 0) { lastD = S.horiz[li]; break; }
        // ★ 숫자는 실제 마지막 진행일에서 읽는다 — 기본 일건수를 문구에 박으면 표의 그 줄과 어긋난다
        where = '이월 <b>' + carry + '명</b>을 <b>종료일 연장</b>으로 넘겼습니다 — 추가된 종료일 <b>'
          + _esc(lastD ? fmtMD(lastD) : '-') + '</b>에 <b>' + (lastD ? planFor(lastD) : 0) + '명</b> 늘어납니다.';
      } else if (!cds.length) {
        where = '이월 <b>' + carry + '명</b>이 지금 어느 날에도 얹혀 있지 않습니다 — [자동 맞춤]으로 배치하세요.';
      } else if (cds.length === 1 && cds[0] === j.today && planFor(cds[0]) > Number(j.todayNaturalQuota || 0)) {
        // ★ 서버 자동 이월은 하루 상한(066 CARRY_CAP_MULT)에서 잘리는데, 명시 계획으로 저장하면
        //   095 규율상 그 값이 그날의 전부라 **상한을 넘겨 열린다**. 막지는 않되(사용자가 고른
        //   방식) 그 사실과 대안을 말한다 — 066 이 막으려던 것이 바로 이 하루 버스트다.
        where = '이월 <b>' + placed + '명</b>이 <b>' + _esc(fmtMD(cds[0])) + '</b> 정원에 얹혀 있습니다 — 기본 '
          + baseFor(cds[0]) + ' → <b>' + planFor(cds[0]) + '명</b>.'
          + '<br>⚠ 자동 이월이었다면 오늘은 <b>' + Number(j.todayNaturalQuota || 0) + '명</b>까지만 열립니다 — '
          + '이 방식은 그 상한을 넘겨 하루에 <b>' + planFor(cds[0]) + '명</b>을 엽니다. '
          + '부담되면 <b>[남은 날에 나눠 담기]</b>를 고르세요.';
      } else if (cds.length === 1) {
        where = '이월 <b>' + placed + '명</b>이 <b>' + _esc(fmtMD(cds[0])) + '</b> 정원에 얹혀 있습니다 — 기본 '
          + baseFor(cds[0]) + ' → <b>' + planFor(cds[0]) + '명</b>.';
      } else {
        var ons = cds.map(carryOn);
        where = '이월 <b>' + placed + '명</b>이 <b>' + cds.length + '일</b>에 나뉘어 얹혀 있습니다 — '
          + _esc(fmtMD(cds[0])) + ' ~ ' + _esc(fmtMD(cds[cds.length - 1])) + ' (하루 +'
          + Math.min.apply(null, ons) + '~' + Math.max.apply(null, ons) + '명).';
      }
      /* ★★ **부족(short)일 때 마지막 날을 종료일이라고 말하지 않는다** — `walkDays` 는 목표를
         못 채워도 모아 둔 날을 그대로 돌려주고, 탐색은 `finitePlanLimit()`(작업표/시트 마지막
         날 + 13일)에서 끊긴다. 그 컷오프를 종료일로 찍으면 ① 헤더의 '계산 불가'와 정면으로
         어긋나고 ② 세 방식이 전부 같은 날로 보여 **"뒤에 붙여도 종료일이 안 밀린다"** 는
         잘못된 판단 근거가 된다(위프 800건 실측). 부족은 부족이라고 말한다. */
      var em = function (m) {
        var h = buildHorizon(m);
        if (!h || !h.dates.length) return '-';
        if (h.shortBy > 0) return '계산 불가';   // buildHorizon 은 short 가 아니라 shortBy(모자란 인원)를 준다
        /* ★ 종료일 = **실제로 사람을 받는 마지막 날**. 구간 끝에는 작업표 빈 줄을 닫으려고 올려 둔
           0 명 날이 붙을 수 있어, 마지막 날을 그대로 쓰면 헤더의 예상 종료일(endDate)과 갈린다.
           바로 위 extend 안내가 쓰는 것과 **같은 관용구**(사본이 아니라 같은 규칙). */
        for (var li = h.dates.length - 1; li >= 0; li--) if (h.plan[h.dates[li]] > 0) return fmtMD(h.dates[li]);
        return '-';
      };
      carryBlk = '<div class="cdp-carry"><div class="t">이월 보충 투입 방식</div>'
        + '<div class="d">어제까지 못 채운 <b>' + carry + '명</b>을 어느 날에 얹을지 정합니다. 총량은 어느 방식에서도 변하지 않고, <b>종료일만 달라집니다</b>.'
        + (j.carryMode === 'hold' ? ' 이 공고는 <b>이월 보류</b> 설정이라 저장하기 전까지는 자동으로 얹히지 않습니다.' : '')
        + '</div>'
        + '<div class="cdp-seg">'
        // ★ '기본' 배지는 DEFAULT_CARRY_MODE 에서 파생한다 — 배지를 손으로 달아 두면 기본값을
        //   바꿀 때 화면과 코드가 갈린다(사본 금지). onclick 인자는 전부 **고정 문자열**(XSS 규율).
        + segBtn('next', '다음날에 더하기', '바로 다음 진행일에 몰아서')
        + segBtn('spread', '남은 날에 나눠 담기', '진행일에 고르게')
        + segBtn('extend', '종료일 뒤에 붙이기', '각 날 인원은 그대로')
        + '</div><div class="where">' + where + '</div>'
        + '<div class="cmp">방식별 종료일 — 다음날에 <b>' + _esc(em('next')) + '</b> · 나눠 담기 <b>' + _esc(em('spread'))
        + '</b> · 뒤에 붙이기 <b>' + _esc(em('extend')) + '</b></div></div>';
    }

    /* ── ③ 배분 균형 바(요구 ⑥) — 초과=빨강 / 부족=파랑 / 일치=초록, 일치일 때만 저장 ── */
    var balBlk = '', diff = 0, target = targetTotal();
    if (bal) {
      diff = diffPlan();
      var cls = diff === 0 ? 'ok' : (diff > 0 ? 'over' : 'under');
      var ico = diff === 0 ? '✓' : (diff > 0 ? '▲' : '▼');
      // ★ 문구는 한 줄(사용자 확정) — 상태·숫자·저장 가능 여부만 말한다.
      // ★ 사용자 확정(2026-08-19): **초과만 막고, 부족은 저장한다** — 부족하게 저장하면
      //   그만큼만 모집하고 작업표의 줄도 그 수로 줄어든다(총건수 축소가 실제로 반영된다).
      // ★★ "총량 410명" 은 거짓말이다(사용자 신고 2026-08-19) — 이 공고의 총원은 500명이고
      //   410 은 **남은 건수**(총원 − 확정)다. 그래서 진행 현황과 남은건수를 함께 말한다.
      var pre = '<span class="num">' + done + '</span> / ' + tot + '건 진행중 · 남은건수 <span class="num">' + target + '</span>건';
      var l1 = diff === 0
        ? pre + ' 일치합니다. — <b>저장가능</b>'
        : diff > 0
          ? pre + '보다 <span class="num">' + diff + '</span>건 초과입니다. — <b>저장불가</b>'
          : pre + '보다 <span class="num">' + (-diff) + '</span>건 적게 모집합니다. — <b>저장가능</b>';
      balBlk = '<div class="cdp-bal ' + cls + '"><div class="ico">' + ico + '</div>'
        + '<div class="txt"><div class="l1">' + l1 + '</div></div>'
        + (diff === 0 ? ''
          : '<button type="button" class="cdp-btn sm" onclick="CampaignDailyPlan._autoFit()">자동으로 '
            + Math.abs(diff) + '건 ' + (diff > 0 ? '줄이기' : '채우기') + '</button>')
        + '</div>';
    }

    var roundsHtml = (j.rounds || []).map(function (r, i) {
      var prev = (j.rounds || []).slice(0, i).reduce(function (s, x) { return s + (x.count || 0); }, 0);
      var got = Math.max(0, Math.min(r.count || 0, (j.submittedAll || 0) - prev));
      var done = got >= (r.count || 0);
      return '<div class="cdp-rr"><span class="cdp-rno">' + r.roundNo + '차</span>'
        + '<span>' + (r.count || 0) + '건</span>'
        + '<span class="cdp-rmeta">' + _esc((r.startDate ? fmtMD(r.startDate) + ' 시작' : '시작일 없음') + (r.label ? ' · ' + r.label : '')) + '</span>'
        + '<span class="cdp-rprog" style="color:' + (done ? '#16a34a' : '#1b64da') + '">' + got + '/' + (r.count || 0) + (done ? ' 완료' : '') + '</span></div>';
    }).join('');

    // ★ 098 보류 이월 블록(보류 공고만) — 잔량 표시 + [오늘/내일/분산] 반영(계획 스테이징).
    //   잔량 null = "조회 실패"를 말하고 반영을 잠근다(숫자를 지어내지 않는다 — 시안 확정).
    let heldBlk = '';
    if (bal) {
      // 균형 모드에서는 위 "이월 보충 투입 방식"이 반영 창구다(같은 일을 두 곳에서 하면 이중 반영이 된다)
      heldBlk = '';
    } else if (S.data.carryMode === 'hold' && S.data.scheduleDriven === true) {
      // ★ 시트 일정 공고에는 '이월 보류'가 적용되지 않는다(정원을 시트 계획이 정하므로 자동
      //   이월 가산 자체가 없다). "조회 실패"로 뭉뚱그리면 담당자가 원인을 잘못 찾는다.
      heldBlk = '<div class="cdp-heldblk"><div class="hh"><b>⏸ 보류된 이월</b><span class="hn">해당 없음</span></div>'
        + '<div class="hs">시트 일정 공고는 날짜별 정원을 시트가 정하므로 <b>이월 보류 설정이 적용되지 않습니다</b> — '
        + '인원 조절은 아래 날짜별 계획에서 바로 하세요.</div></div>';
    } else if (S.data.carryMode === 'hold') {
      const heldRaw = S.data.carryHeld;
      const avail = heldRaw == null ? null : Math.max(0, Number(heldRaw) - S.carryStage);
      const dis = killOff || avail === null || avail <= 0;
      heldBlk = '<div class="cdp-heldblk">'
        + '<div class="hh"><b>⏸ 보류된 이월</b><span class="hn">'
        + (heldRaw == null ? '조회 실패' : avail + '명' + (S.carryStage > 0 ? ' <small>(반영 대기 +' + S.carryStage + ')</small>' : ''))
        + '</span></div>'
        + '<div class="hb">'
        + '<button type="button" class="cdp-btn hpri" onclick="CampaignDailyPlan._heldApply(\'today\')"' + (dis ? ' disabled' : '') + '>오늘 정원에 +' + (avail || 0) + ' 반영</button>'
        + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan._heldApply(\'tomorrow\')"' + (dis ? ' disabled' : '') + '>내일에 반영</button>'
        + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan._heldApply(\'spread\')"' + (dis ? ' disabled' : '') + '>남은 날 분산</button>'
        + '</div>'
        + '<div class="hs">'
        + (heldRaw == null
          ? '잔량을 계산하지 못했습니다(기준선 조회 실패) — 잠시 후 다시 열어주세요.'
          : '반영하지 않아도 물량은 사라지지 않습니다 — 총량까지 기본 일건수로 계속 모집되고 종료일만 뒤로 밀립니다. 반영은 아래 계획에 얹혀 [확정 저장]으로 확정됩니다.')
        + '</div></div>';
    }

    // 좌측 고정 요약/방식 + 우측 날짜별 계획. 목록·작업보드가 같은 공용 모달을 쓴다.
    bd.innerHTML =
      '<div class="cdp-layout"><aside class="cdp-side">'
      + statBlk
      + carryBlk
      + wkNote
      + '</aside><section class="cdp-main"><div class="cdp-fix">'
      + (killOff ? '<div class="cdp-note err">킬스위치(CAMPAIGN_DAILY_PLAN=0)로 날짜별 계획이 꺼져 있습니다 — 저장해도 정원에 반영되지 않아 조절을 잠갔습니다.</div>' : '')
      + (j.status !== 'active'
        ? '<div class="cdp-publish">현재 <b>' + (j.status === 'closed' ? '마감' : '임시저장') + '</b> 상태입니다. 모집을 다시 열려면 공고 카드에서 게시를 켜세요.</div>'
        : '')
      + balBlk
      + '<div class="cdp-sub"><span>날짜별 모집 계획 — 게이지 드래그 또는 −/＋' + (bal ? ' · 숫자 직접 입력' : '') + '</span>'
      + '<span>' + (j.scheduleDriven === true ? '기본 <b>시트 구매일자 기준</b>' : '기본 일건수 <b>' + (j.defaultDaily || 0) + '명</b>')
      + (bal ? ' · 한 날 최대 <b>' + target + '명</b>' : ' · 총량 <b>' + (tot > 0 ? tot + '명' : '무제한') + '</b>'
        + (j.scheduleDriven === true ? '<small>(시트 행 수)</small>' : ''))
      + ' · 확정 <b>' + done + '명</b></span></div>'
      + '</div><div class="cdp-sc">'
      + '<div class="cdp-colhead"><span>날짜</span><span>상태</span><span class="n">일 건수</span><span>조절</span></div>'
      + '<div id="cdpRows">' + rows + '</div>'
      + '<div class="cdp-end"><span>예상 종료일: <b>' + _esc(endTxt) + '</b> '
      + (endTxt !== S.baseEnd ? '<span class="chg">(원래 ' + _esc(S.baseEnd) + ' → 변경됨)</span>' : '') + '</span>'
      + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan._revert()" style="padding:5px 10px;font-size:.66rem">'
      + (bal ? '이 방식의 기본 배치로 되돌리기' : '조절 전으로 되돌리기') + '</button></div>'
      + '<details class="cdp-more"><summary>추가 설정 및 조정 이력</summary>'
      + wtNote + schNote + offNote + heldBlk
      + (bal && S.outside && S.outside.length
        ? '<div class="cdp-note">이 구간 밖(시작일 이전·예상 종료일 이후)에 저장해 둔 계획이 <b>' + S.outside.length + '일</b> 있습니다. 아래 날짜 목록에는 표시하지 않지만 그대로 유지됩니다.</div>'
        : '')
      + '<div class="cdp-note">' + (bal
        ? '주황 막대는 <b>이월분</b>입니다. 배분 합계가 남은 배분수와 같을 때 저장할 수 있습니다.'
        : '총량은 일 건수 조절로 바뀌지 않습니다. 총량 변경은 차수 추가에서만 할 수 있습니다.')
      + '</div>'
      + '<div class="cdp-sec"><div class="h"><span>차수 (물량 추가 이력)</span>'
      + '<span><button type="button" class="cdp-btn" onclick="CampaignDailyPlan._roundForm()">＋ 차수 추가</button>'
      + ((j.rounds || []).length >= 2 ? ' <button type="button" class="cdp-btn" onclick="CampaignDailyPlan._roundRemove()" title="마지막 차수 제거(오등록 복구)">− 마지막 차수 제거</button>' : '')
      + '</span></div>'
      + (roundsHtml || '<div class="cdp-rmeta" style="font-size:.7rem">아직 차수가 없습니다 — 물량이 추가되면 [＋ 차수 추가]로 등록하세요(총량 ' + ((j.recruitTotal || 0) > 0 ? j.recruitTotal + '건이 1차(초도)로 흡수됩니다' : '이 추가 건수로 설정됩니다') + ').</div>')
      + '<div class="cdp-radd" id="cdpRoundForm">'
      + '<input id="cdpRfCount" type="number" min="1" placeholder="추가 건수" style="width:90px">'
      + '<input id="cdpRfDate" type="date" title="시작일(선택)">'
      + '<input id="cdpRfLabel" type="text" maxlength="40" placeholder="메모(선택)" style="width:120px">'
      + '<button type="button" class="cdp-btn pri" onclick="CampaignDailyPlan._roundAdd()">추가</button></div>'
      + (j.roundsDrift ? '<div class="cdp-note warn">⚠ 총모집(' + (j.recruitTotal || 0) + ')이 차수 합계(' + (j.roundsTotal || 0) + ')와 다릅니다 — 다른 창구에서 총모집이 바뀐 흔적입니다. 차수를 추가/제거하면 합계로 다시 맞춰집니다.</div>' : '')
      + '</div>'
      + histHtml()
      + '</details>'
      + '</div></section></div>';   // .cdp-sc · .cdp-main · .cdp-layout 닫기

    // ★★ 스크롤 위치 복원 — render 가 본문을 통째로 갈아치우므로 스크롤 컨테이너도 새로 만들어진다.
    //   복원하지 않으면 −/＋ 한 번에 목록이 맨 위로 튀어 **조절하던 줄을 놓친다**(종전에는 본문
    //   자체가 스크롤 컨테이너라 이 문제가 없었다).
    var sc = bd.querySelector('.cdp-sc');
    if (sc && S._scrollTop) sc.scrollTop = S._scrollTop;
    if (sc && !sc._bound) {
      sc._bound = true;
      sc.addEventListener('scroll', function () { S._scrollTop = sc.scrollTop; });
    }

    bindRowEvents();
    var dirty = dirtyDates().length;
    if (bal) {
      // ★ 균형 모드의 저장 게이트 = 합계 일치 AND 실제 저장할 것이 있음(요구 ⑥)
      //   + 서버 저장 상한(한 번에 120일)을 넘으면 통째로 거부되므로 미리 잠그고 **사유를 말한다**.
      var over = dirty > MAX_ROWS;
      // ★ 초과만 잠근다(총건수는 넘을 수 없다). 부족은 "그만큼만 모집"이라 저장 가능.
      save.disabled = killOff || S.saving || diff > 0 || !dirty || over;
      hint.textContent = over
        ? '저장할 날짜가 ' + dirty + '일로 한 번에 저장 가능한 ' + MAX_ROWS + '일을 넘었습니다 — 구간을 나눠 저장해주세요'
        : diff > 0 ? '초과 ' + diff + '건 — 저장불가'
        : diff < 0 ? '총량보다 ' + (-diff) + '명 적게 모집합니다 — 저장하면 작업표도 그 수로 줄어듭니다'
        : dirty ? '남은건수와 딱 맞습니다 — [확정 저장]을 누르면 반영됩니다'
        // ★ "저장할 것 없음"을 그냥 말하면 화면에 이월이 얹혀 보이는데 저장이 잠겨 있어
        //   "반영이 안 된 것"으로 오독된다 — 이미 그렇게 돌고 있다는 사실을 말한다.
        : (carry > 0 && S.carryMode === 'next' && j.carryMode !== 'hold')
          ? '이월 ' + carry + '명은 이미 오늘 정원에 반영되어 있습니다 — 바꾸려면 위에서 다른 방식을 고르세요'
        // ★ 이월이 없으면 방식을 바꿔도 배치가 달라지지 않는다 — "저장이 안 된다"로 오독되지 않게
        //   그 사실을 말한다(사용자 신고: 방식을 골랐는데 저장 버튼이 잠겨 있다).
        : (!carry && S.carryMode && S.carryMode !== 'next')
          ? '지금은 이월 인원이 없어 방식별로 달라지는 것이 없습니다 — 저장할 변경이 없습니다'
          : '남은건수와 딱 맞습니다 — 저장할 변경이 없습니다';
    } else {
      save.disabled = killOff || S.saving || !dirty;
      hint.textContent = dirty
        ? '조절 ' + dirty + '일 — [확정 저장]을 눌러야 반영됩니다'
        : '조절은 [확정 저장]을 눌러야 반영됩니다 · 차수는 즉시 반영';
    }
    syncRebuildBtn();
  }

  function histHtml() {
    var evs = (S.data.events || []);
    if (!evs.length) return '';
    var lis = evs.map(function (ev) {
      var t = '';
      try { t = new Date(ev.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) {}
      return '<li>' + _esc(t + ' · ' + (ev.actor || '?') + ' — ' + evText(ev)) + '</li>';
    }).join('');
    return '<div class="cdp-sec"><div class="h"><span>조절 이력</span></div><ul class="cdp-hist">' + lis + '</ul></div>';
  }
  function evText(ev) {
    var d = ev.detail || {};
    if (ev.action === 'round_add') return (d.roundNo || '?') + '차 추가 +' + (d.count || 0) + '건' + (d.startDate ? ' (' + fmtMD(d.startDate) + ' 시작)' : '') + ' · 총량 ' + (d.newTotal || '?');
    if (ev.action === 'round_remove') return (d.roundNo || '?') + '차 제거 −' + (d.count || 0) + '건 · 총량 ' + (d.newTotal || '?');
    if (ev.action === 'plan_save') {
      var parts = (d.set || []).map(function (x) { return fmtMD(x.date) + ' ' + x.count + '명'; })
        .concat((d.remove || []).map(function (x) { return fmtMD(x) + ' 기본으로'; }));
      return '계획 저장: ' + parts.join(', ') + (d.note ? ' · ' + d.note : '');
    }
    return ev.action;
  }

  /* ── 값 변경(세션 디바운스 — 질문은 조절 한 묶음당 한 번) ── */
  function gaugeScale() {
    var mx = (S.data.defaultDaily || 0) * 2;
    // 시트 일정 공고는 기본 일건수가 무의미하므로 그날 시트 계획도 눈금 후보에 넣는다
    rowDates().forEach(function (d) { mx = Math.max(mx, planFor(d), baseFor(d) * 2); });
    return Math.max(10, mx);
  }
  /** 그날 아래로 내려갈 수 없는 인원 — 오늘은 확정·진행 인원, 어느 날이든 **이미 채워진
   *  작업표 줄** 수. 후자를 빼면 서버 재구성이 worktable_rebuild_below_used 로 통째로 거부해
   *  "조절은 저장됐는데 표는 안 바뀐다"가 된다(막다른 길). 드래그·−/＋·자동 맞춤·주말 재배분이
   *  전부 이 함수 하나를 본다(판정 사본 0). */
  function minFor(d) {
    return Math.max(d === S.data.today ? (S.data.todayUsed || 0) : 0, worktableFilledFor(d));
  }

  function commitValue(d, next) {
    if (S.data.planEnabled === false) return;
    var cur = planFor(d), want = Math.round(next), cap = maxFor(d);
    // ★ 합계가 총건수를 넘는 값은 들어가지 않는다(경고가 아니라 차단 — 사용자 확정)
    next = Math.max(minFor(d), Math.min(cap, want));
    if (next === cur) {
      if (next === minFor(d) && d === S.data.today && minFor(d) > 0) {
        toast('이미 확정·진행 중인 ' + minFor(d) + '명 아래로는 줄일 수 없습니다');
      } else if (want > cap && balanceOn()) {
        // ★ 막고 끝내지 않는다 — 왜 안 올라가는지와 다음 행동을 말한다(죽은 조작 금지)
        toast('총 ' + totalFor() + '건을 넘길 수 없습니다 — 남은건수 '
          + Math.max(0, targetTotal() - sumPlan()) + '건. 다른 날을 줄이거나 [차수 추가]로 총량을 늘려주세요');
      }
      if (S.sessions[d]) scheduleSettle(d);
      return;
    }
    if (!S.sessions[d]) S.sessions[d] = { start: cur, timer: null };
    setPlan(d, next);
    render();
    scheduleSettle(d);
  }
  function setPlan(d, v) {
    // ★ "기본값 복귀 = 조절 없음" 판정도 baseFor 단일 출처를 써야 한다 — defaultDaily 로 비교하면
    //   시트 15명인 날을 의도적으로 20(= daily_limit)으로 올렸을 때 **조절이 조용히 삭제**되어
    //   드래그가 되돌아가고 저장해도 아무 일이 안 일어난다(코드리뷰 #3).
    if (v === baseFor(d) && S.base[d] == null) delete S.plan[d];
    else S.plan[d] = v;
  }
  function scheduleSettle(d) {
    var s = S.sessions[d];
    clearTimeout(s.timer);
    s.timer = setTimeout(function () { settle(d); }, SETTLE_MS);
  }
  function settle(d) {
    if (!S || !S.data) return;   // 조절 직후 0.7초 안에 모달을 닫으면 타이머가 늦게 발화한다(코드리뷰 m1)
    var s = S.sessions[d];
    if (!s) return;
    delete S.sessions[d];
    var start = s.start, fin = planFor(d);
    // ★ 그날의 "평소 인원" — 시트 일정 공고는 시트 행 수가 기준이다(defaultDaily 로 비교하면
    //   시트 30인 날을 22로 줄여도 22 < 20 이 거짓이라 「빠진 인원 처리」 질문이 아예 안 뜬다).
    var dl = baseFor(d);
    if (fin === start) return;
    // ★ 균형 모드에서는 「빠진 인원 처리」 팝업을 띄우지 않는다 — 부족/초과는 위 균형 바가
    //   한 곳에서 말하고(판정 단일 출처) [자동 맞춤]이 고른 방식대로 되돌린다. 두 창구가 겹치면
    //   팝업이 계획을 바꾼 직후 균형 바가 또 다른 숫자를 말해 사람이 무엇을 믿을지 모른다.
    if (balanceOn()) { S.notes.push(fmtMD(d) + ' ' + start + '→' + fin); render(); return; }
    if (fin < start && fin < dl) {
      // 축소 → 처리 방식 선택(한 묶음당 한 번). 분산 범위 = 축소 전 종료일까지(시안 실측 규칙).
      var missing = Math.max(0, Math.min(start, dl) - fin);
      var saved = S.plan[d];
      setPlan(d, start);
      var prevEnd = endDate();
      if (saved == null) delete S.plan[d]; else S.plan[d] = saved;
      var untilN = prevEnd ? Math.max(0, Math.round((Date.parse(prevEnd) - Date.parse(d)) / 86400000)) : 0;
      S.choice = { date: d, prev: start, next: fin, missing: missing, until: prevEnd, untilN: untilN };
      document.getElementById('cdpChTitle').textContent = fmtMD(d) + ' 인원을 ' + fin + '명으로 줄였습니다 — 빠진 ' + missing + '명은 어떻게 할까요?';
      document.getElementById('cdpChDesc').textContent = '총량 ' + (totalFor() > 0 ? totalFor() + '명' : '') + '은 그대로 지켜집니다 — 빠진 인원을 언제 모집할지만 고릅니다.';
      document.getElementById('cdpChExtendDesc').textContent = '이후 날들은 계획 그대로(그날 기본 인원) 진행하고, 종료일이 뒤로 밀립니다.';
      var sp = document.getElementById('cdpChSpread');
      if (untilN > 110) {
        // 서버 저장 상한(한 번에 120일)을 분산이 넘기면 통째로 거부된다 — 미리 잠근다(코드리뷰 m6)
        sp.disabled = true;
        document.getElementById('cdpChSpreadDesc').textContent = '남은 진행일이 ' + untilN + '일로 너무 많아 분산할 수 없습니다 — 종료일 연장을 선택하거나 날짜별로 직접 조절해주세요.';
      } else if (untilN > 0) {
        sp.disabled = false;
        document.getElementById('cdpChSpreadDesc').textContent = '종료일(' + fmtMD(prevEnd) + ')까지 남은 ' + untilN + '일에 약 +' + Math.ceil(missing / untilN) + '명씩 얹어 종료일을 유지합니다.';
      } else {
        sp.disabled = true;
        document.getElementById('cdpChSpreadDesc').textContent = '남은 진행일이 없어 이 선택지는 쓸 수 없습니다.';
      }
      document.getElementById('cdpChoice').style.display = 'flex';
    } else if (fin > start && fin > dl) {
      toast('이 날만 ' + fin + '명으로 늘립니다 — 다른 날은 그대로, 총량은 변하지 않습니다');
      S.notes.push(fmtMD(d) + ' ' + start + '→' + fin + ' (증가)');
      render();
    } else {
      S.notes.push(fmtMD(d) + ' ' + start + '→' + fin);
      render();
    }
  }
  function _chExtend() {
    if (!S || !S.choice) return;
    S.notes.push(fmtMD(S.choice.date) + ' ' + S.choice.prev + '→' + S.choice.next + ' (빠진 ' + S.choice.missing + '명: 종료일 연장)');
    document.getElementById('cdpChoice').style.display = 'none';
    S.choice = null;
    render();
  }
  function _chSpread() {
    if (!S || !S.choice) return;
    var c = S.choice;
    if (!c.untilN || c.untilN > 110) return;
    var per = Math.floor(c.missing / c.untilN), extra = c.missing % c.untilN;
    for (var k = 1; k <= c.untilN; k++) {
      var d2 = addDays(c.date, k);
      var add = per + (k <= extra ? 1 : 0);
      if (add > 0) S.plan[d2] = planFor(d2) + add;
    }
    S.notes.push(fmtMD(c.date) + ' ' + c.prev + '→' + c.next + ' (빠진 ' + c.missing + '명: 남은 ' + c.untilN + '일 분산)');
    document.getElementById('cdpChoice').style.display = 'none';
    S.choice = null;
    render();
  }
  function _chCancel() {
    if (S && S.choice) setPlan(S.choice.date, S.choice.prev);
    document.getElementById('cdpChoice').style.display = 'none';
    if (S) S.choice = null;
    render();
  }
  function _revert() {
    if (!S || !S.data) return;
    if (balanceOn()) {
      // 균형 모드 = "이 방식의 기본 배치로" — 지금 고른 방식대로 다시 깐다(합계는 항상 딱 맞는다)
      applyCarryMode(S.carryMode || DEFAULT_CARRY_MODE);
      S.notes = [];
      render();
      return;
    }
    S.plan = {};
    Object.keys(S.base).forEach(function (d) { S.plan[d] = S.base[d]; });
    S.notes = [];
    S.carryStage = 0;   // 이월 반영 스테이징도 함께 되돌림(계획에 얹은 값이 사라지므로)
    S.baseEnd = null;
    render();
  }
  /** 이월 보충 투입 방식 전환(요구 ④) — 고른 방식대로 이월을 재배치한다 */
  function _mode(m) {
    if (!S || !S.data || !balanceOn() || CARRY_MODES.indexOf(m) < 0) return;
    if (S.data.planEnabled === false || m === S.carryMode) return;
    if (!applyCarryMode(m)) { toast('이 방식으로는 구간을 펼치지 못했습니다'); return; }
    _saveMode(m);        // 저장·재조회·재오픈에도 고른 방식이 유지되게(화면 상태만)
    var e = endDate();
    toast(m === 'next' ? '이월을 다음 진행일에 얹었습니다 — 종료일 ' + (e ? fmtMD(e) : '-')
      : m === 'spread' ? '이월을 진행일에 나눠 담았습니다 — 종료일 ' + (e ? fmtMD(e) : '-')
      : '이월을 종료일 뒤로 넘겼습니다 — 종료일 ' + (e ? fmtMD(e) : '-'));
    render();
  }
  function _autoFit() { if (S && S.data) autoFit(); }

  /* ── 보류 이월 반영(098) — 계획에 얹는 스테이징. 저장 시 carryApply 로 잔량 차감 기록 ── */
  function _heldApply(mode) {
    if (!S || !S.data || S.data.carryMode !== 'hold' || S.data.planEnabled === false) return;
    if (S.data.carryHeld == null) return;   // 잔량 모름 = 반영 잠금(숫자를 지어내지 않는다)
    var avail = Math.max(0, Number(S.data.carryHeld) - S.carryStage);
    if (avail <= 0) return;
    if (mode === 'today') {
      S.plan[S.data.today] = planFor(S.data.today) + avail;
      S.notes.push('이월 반영 +' + avail + ' → 오늘');
    } else if (mode === 'tomorrow') {
      var t1 = addDays(S.data.today, 1);
      S.plan[t1] = planFor(t1) + avail;
      S.notes.push('이월 반영 +' + avail + ' → ' + fmtMD(t1));
    } else {
      // 남은 날 분산 = 내일부터 예상 종료일까지(없으면 7일) 고르게 — 축소-분산과 같은 규칙
      var e = endDate();
      var n = e ? Math.max(1, Math.round((Date.parse(e) - Date.parse(S.data.today)) / 86400000)) : 7;
      n = Math.min(n, 110);   // 서버 저장 상한(120일) 선반영
      var per = Math.floor(avail / n), extra = avail % n;
      for (var k = 1; k <= n; k++) {
        var d2 = addDays(S.data.today, k);
        var add = per + (k <= extra ? 1 : 0);
        if (add > 0) S.plan[d2] = planFor(d2) + add;
      }
      S.notes.push('이월 반영 +' + avail + ' → 남은 ' + n + '일 분산');
    }
    S.carryStage += avail;
    render();
    toast('반영을 계획에 얹었습니다 — [확정 저장]을 눌러야 확정됩니다');
  }

  /* ── 카드 ⏸ 칩 원클릭 반영(098 · 확정 ②) — 확인창 1개 + 즉시 저장(세부는 [📅 인원]로) ── */
  var Q = null;   // { campId, held, today, todayPlan, title }
  function ensureQuickMount() {
    if (document.getElementById('cdpQuick')) return;
    ensureMount();
    var ov = document.createElement('div');
    ov.id = 'cdpQuick';
    ov.style.cssText = 'position:fixed;inset:0;z-index:10060;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.45);padding:16px';
    ov.innerHTML = '<div style="width:430px;max-width:100%;background:var(--card,#fff);color:var(--t1,#1f2937);border-radius:14px;padding:18px;box-shadow:0 12px 40px rgba(15,23,42,.3)">'
      + '<h4 id="cdpQTitle" style="font-size:.86rem;margin:0 0 5px"></h4>'
      + '<div id="cdpQDesc" style="font-size:.74rem;color:var(--t3,#475569);margin-bottom:12px"></div>'
      + '<button type="button" class="cdp-btn" id="cdpQGo" onclick="CampaignDailyPlan._quickDo()" style="display:block;width:100%;text-align:left;margin-bottom:7px;padding:10px 13px;background:#7C3AED;border-color:#7C3AED;color:#fff;font-size:.76rem">✅ <b id="cdpQGoTx"></b></button>'
      + '<button type="button" class="cdp-btn" onclick="CampaignDailyPlan._quickDetail()" style="display:block;width:100%;text-align:left;margin-bottom:7px;padding:10px 13px;font-size:.74rem">📅 세부 선택 (날짜 골라 · 분산) — [📅 인원] 열기</button>'
      + '<button type="button" onclick="CampaignDailyPlan._quickClose()" style="display:block;margin:4px auto 0;border:0;background:none;color:var(--t3,#94a3b8);font-size:.7rem;cursor:pointer;text-decoration:underline">그대로 두기 (반영하지 않음 — 물량은 사라지지 않습니다)</button>'
      + '</div>';
    document.body.appendChild(ov);
  }
  async function quickApplyHeld(campId) {
    ensureQuickMount();
    try {
      var j = await _req('GET', EP + encodeURIComponent(String(campId)) + '/daily-plan');
      if (j.carryMode !== 'hold') { toast('이월 보류 공고가 아닙니다'); return; }
      // ★ 시트 일정 공고는 보류가 적용되지 않는다(정원을 시트가 정한다) — "잔량 조회 실패"로
      //   뭉뚱그리면 담당자가 원인을 잘못 찾는다. 사유를 정확히 말하고 갈 곳을 알려준다.
      if (j.scheduleDriven === true) { toast('시트 일정 공고에는 이월 보류가 적용되지 않습니다 — [📅 인원]에서 날짜별로 조절하세요'); return; }
      if (j.carryHeld == null) { toast('보류 잔량을 계산하지 못했습니다 — [📅 인원]에서 확인해주세요'); return; }
      var held = Math.max(0, Number(j.carryHeld) || 0);
      if (held <= 0) { toast('반영할 보류 이월이 없습니다'); return; }
      if (j.planEnabled === false) { toast('킬스위치(CAMPAIGN_DAILY_PLAN=0)로 계획이 꺼져 있어 반영할 수 없습니다'); return; }
      // ※ 시트 일정 true 는 위에서(사유 문구와 함께) 걸렀고, 판정 실패(null)는 서버가 잔량을
      //   null 로 내려주므로 바로 위 carryHeld 검사에서 걸린다 — 여기서 다시 볼 필요가 없다.
      var todayPlan = (j.plans || []).reduce(function (v, p) { return p.date === j.today ? p.count : v; }, null);
      if (todayPlan == null) todayPlan = j.defaultDaily || 0;
      Q = { campId: String(campId), held: held, today: j.today, todayPlan: todayPlan, title: j.title || '' };
      document.getElementById('cdpQTitle').textContent = '보류된 이월 ' + held + '명을 오늘 반영할까요?';
      // 게시 꺼짐(closed 영속 포함) 고지 — 반영해도 게시 토글을 켜기 전엔 모집이 재개되지 않는다(차수 추가 M1 과 같은 규율)
      var statusNote = (j.status && j.status !== 'active') ? ' ⚠ 공고가 게시 상태가 아니라 반영 후 게시 토글을 켜야 모집이 재개됩니다.' : '';
      document.getElementById('cdpQDesc').textContent = (Q.title ? '「' + Q.title + '」 — ' : '') + '오늘 정원 ' + todayPlan + '명 → ' + (todayPlan + held) + '명. 총량은 변하지 않습니다.' + statusNote;
      document.getElementById('cdpQGoTx').textContent = '오늘 정원에 +' + held + ' 반영';
      document.getElementById('cdpQuick').style.display = 'flex';
    } catch (e) {
      toast('보류 정보를 불러오지 못했습니다: ' + (e.message || e));
    }
  }
  async function _quickDo() {
    if (!Q) return;
    var q = Q;
    _quickClose();
    try {
      await _req('POST', EP + encodeURIComponent(q.campId) + '/daily-plan', {
        set: [{ date: q.today, count: q.todayPlan + q.held }],
        remove: [],
        carryApply: q.held,
        note: '이월 반영 +' + q.held + ' → 오늘 (원클릭)',
      });
      toast('오늘 정원에 +' + q.held + ' 반영했습니다 — 카드·리뷰어 화면에 바로 표시됩니다');
      refreshHost();
    } catch (e) {
      toast('반영 실패: ' + (e.message || e));
    }
  }
  function _quickDetail() {
    var q = Q;
    _quickClose();
    if (q) open(q.campId);
  }
  function _quickClose() {
    var ov = document.getElementById('cdpQuick');
    if (ov) ov.style.display = 'none';
    Q = null;
  }

  /* ── 게이지 드래그 + −/＋ (렌더마다 위임 재바인딩 — #cdpRows 는 render 가 갈아치운다) ── */
  var drag = null;
  function bindRowEvents() {
    var wrap = document.getElementById('cdpRows');
    if (!wrap) return;
    var dates = rowDates();
    wrap.addEventListener('pointerdown', function (ev) {
      var g = ev.target.closest('.cdp-g');
      if (!g || !S || S.data.planEnabled === false) return;
      var d = dates[Number(g.dataset.i)];
      drag = { d: d, el: g, start: planFor(d), scale: gaugeScale() };   // 눈금은 드래그 시작 시 1회만
      try { g.setPointerCapture(ev.pointerId); } catch (_) {}
      dragTo(ev);
    });
    wrap.addEventListener('pointermove', function (ev) { if (drag) dragTo(ev); });
    wrap.addEventListener('pointerup', function () {
      if (!drag) return;
      var d = drag.d, live = planFor(d);
      setPlan(d, drag.start);         // 확정은 commitValue 가 담당(세션·질문 트리거 포함)
      drag = null;
      commitValue(d, live);
    });
    wrap.addEventListener('pointercancel', function () {
      if (drag) { setPlan(drag.d, drag.start); drag = null; render(); }
    });
    // 숫자 직접 입력(균형 모드) — ★ change(=확정/blur)에서만 반영한다. keyup 마다 재렌더하면
    //   입력칸 DOM 이 다시 만들어져 한글 IME 조합·캐럿이 깨진다(홈 목록 검색 `ㅁ며면면` 실측 계열).
    wrap.addEventListener('change', function (ev) {
      var inp = ev.target.closest('.cdp-in');
      if (!inp || !S) return;
      var d = dates[Number(inp.dataset.i)];
      var n = parseInt(String(inp.value).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n)) { render(); return; }   // 숫자가 아니면 원래 값으로 되돌린다
      commitValue(d, n);
      if (planFor(d) !== n) {
        // ★★ 거절된 입력은 **칸에 남겨두지 않는다** — commitValue 는 값이 안 바뀌면 재렌더하지
        //   않으므로, 친 숫자(999)가 칸에 그대로 남아 "들어간 것처럼" 보인다(실브라우저 실측).
        render();
        // 상한에 막힌 경우의 사유는 commitValue 가 총건수 기준으로 말한다(중복 토스트 금지)
        if (n <= maxFor(d)) toast('최소 ' + minFor(d) + '명 안에서만 조절됩니다');
      }
    });
    wrap.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && ev.target.closest('.cdp-in')) { ev.preventDefault(); ev.target.blur(); }
    });
    wrap.addEventListener('click', function (ev) {
      var st = ev.target.closest('.cdp-st');
      if (st) {
        var d = dates[Number(st.dataset.i)];
        commitValue(d, planFor(d) + Number(st.dataset.d));
        return;
      }
      var rs = ev.target.closest('.cdp-reset');
      if (rs) {
        var d2 = dates[Number(rs.dataset.i)];
        commitValue(d2, baseFor(d2));   // 그날 기준선(시트 공고 = 시트 행 수)으로 되돌린다
        // "기본으로" = 조절 해제 의도 — 값이 기본과 같아도 base 에 있으면 remove 로 저장된다
        if (S.plan[d2] === baseFor(d2) && S.base[d2] != null) { delete S.plan[d2]; render(); }
      }
    });
  }
  function dragTo(ev) {
    if (!drag) return;
    var rect = drag.el.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    var sc = drag.scale || gaugeScale();
    var v = Math.round(ratio * sc);
    v = Math.max(minFor(drag.d), Math.min(maxFor(drag.d), v));
    if (v !== planFor(drag.d)) {
      S.plan[drag.d] = v;   // 드래그 중에는 그 줄만 가볍게 갱신(전체 재렌더 금지 — 드래그 끊김)
      var pw = Math.min(100, v / sc * 100);
      drag.el.querySelector('.f').style.width = pw + '%';
      drag.el.querySelector('.k').style.left = pw + '%';
      var cy = drag.el.querySelector('.cy');
      if (cy) cy.style.display = 'none';   // 드래그 중에는 이월 구간 재계산을 미룬다(놓으면 재렌더)
      var num = drag.el.parentElement.querySelector('.cdp-num');
      if (!num) return;
      var inp = num.querySelector('.cdp-in');
      if (inp) inp.value = v; else if (num.firstChild) num.firstChild.textContent = v;
    }
  }

  /* ── 저장 ───────────────────────────────────────────────── */
  async function _save() {
    if (!S || !S.data || S.saving) return;
    var set, remove;
    if (balanceOn()) { var pl = payload(); set = pl.set; remove = pl.remove; }   // 게이트와 같은 판정
    else {
      set = []; remove = [];
      dirtyDates().forEach(function (d) {
        if (S.plan[d] != null) set.push({ date: d, count: S.plan[d] });
        else remove.push(d);
      });
    }
    if (!set.length && !remove.length) return;
    // 균형 모드 저장 게이트(버튼 우회 방어) — **초과**·저장 상한 초과는 보내지 않는다.
    //   ★ 부족은 보낸다(2026-08-19 확정: 그만큼만 모집하고 작업표도 그 수로 줄어든다).
    if (balanceOn() && (diffPlan() > 0 || set.length + remove.length > MAX_ROWS)) return;
    // [확정 저장] 자체가 의도적인 최종 동작이다. 브라우저 확인창을 한 번 더 띄우지 않고
    // 즉시 저장한 뒤, 결과(성공·실패·작업표 동기화 상태)는 화면 토스트로만 알린다.
    // 098 보류 잔량 차감 — 균형 모드는 "지금 계획에 실제로 얹혀 있는 이월"이 곧 반영량이다
    var apply = balanceOn()
      ? (S.data.carryMode === 'hold' ? carryPlaced() : 0)
      : S.carryStage;
    S.saving = true;
    document.getElementById('cdpSaveBtn').disabled = true;
    try {
      var j = await _req('POST', EP + encodeURIComponent(S.campId) + '/daily-plan',
        { set: set, remove: remove, note: S.notes.join(' / ').slice(0, 500),
          ...(apply > 0 ? { carryApply: apply } : {}) });
      S.notes = [];
      applyOverview(j);
      if (j.worktableProjection && j.worktableProjection.ok === false) {
        toast('모집계획은 저장됐지만 작업보드 갱신에 실패했습니다 — 다시 저장해 재시도해주세요', 'warning');
      } else if (j.worktableSync && j.worktableSync.warn) {
        /* ★ 작업표의 줄이 안 바뀐 경우를 "저장 완료"로 뭉뚱그리지 않는다 —
           지금은 모든 작업이 무시트라 이 상태 자체가 이상 신호(전환 누락)다. */
        toast(j.worktableSync.message || '정원만 조절됐습니다 — 작업표의 줄은 바뀌지 않았습니다', 'warning');
      } else if (j.worktableSync && j.worktableSync.rebuild && j.worktableSync.rebuild.ok === false
                 && j.worktableSync.rebuild.reason !== 'worktable_rebuild_empty') {
        /* ★ 저장 후 자동 재구성(오늘 이후 전체)이 실패한 경우 — 조절은 저장됐지만 미래 자리는
           그대로다. 조용히 "저장 완료"라고 말하면 "왜 스케줄이 안 바뀌지"가 원인 불명으로 남는다. */
        toast('조절은 저장됐지만 오늘 이후 자리 재구성에 실패했습니다 — '
              + (j.worktableSync.rebuild.message || '[작업표 재구성]으로 다시 시도해주세요'), 'warning');
      } else if (j.worktableSync && j.worktableSync.rowAudit) {
        /* ★ 작업표 줄이 총건수보다 많은 상태 — 이번 조절이 만든 것이 아닐 수 있어 저장은 막지
           않지만(서버도 거부하지 않는다), 조용히 "저장 완료"로 넘기면 홈 목록의 인원 숫자가
           총건수와 다른 이유를 아무도 모른다(2026-08-24 신고). 사실만 말한다. */
        toast('저장했습니다 — 다만 ' + (j.worktableSync.rowAudit.message || '작업표 줄이 총건수보다 많습니다'), 'warning');
      } else {
        toast('저장했습니다 — 작업보드·카드·리뷰어 화면에 바로 반영됩니다');
      }
      refreshHost();
    } catch (e) {
      toast('저장 실패: ' + (e.message || e));
      if (S) S.saving = false;
      render();   // 저장 버튼 되살림(스테이징 유지 — 다시 시도 가능)
    } finally {
      if (S) S.saving = false;
    }
  }

  /** [작업표 재구성] 상태 — 무시트 작업표가 아니면 눌러도 409 라 비활성 + 사유를 붙인다.
   *  ★ 눌러도 아무 일 없는(또는 오류만 나는) 버튼을 두지 않는다. */
  function syncRebuildBtn() {
    var btn = document.getElementById('cdpRebuildBtn');
    if (!btn || !S || !S.data) return;
    var linked = S.data.worktableLinked;
    btn.disabled = (linked === false);
    btn.title = linked === false
      ? '이 작업은 아직 무시트 작업표로 전환되지 않아 재구성할 수 없습니다 — 조절은 정원만 바꿉니다'
      : (linked === true
        // ★ 실제 동작 그대로 적는다 — "빈 줄만 다시 배치"로 줄이면 **부족분 줄 추가**와
        //   **남는 빈 줄 날짜 비우기**가 안 보여, 표의 줄 수가 바뀐 것을 사고로 오해한다.
        ? '저장된 오늘 이후 계획에 맞춰 작업표의 빈 줄을 다시 배열합니다 — 날짜 이동 · 모자란 만큼 줄 추가 · 남는 빈 줄 날짜 비우기(참여·주문 있는 줄은 그대로)'
        : '작업표 연결 상태를 확인하지 못했습니다 — 실행하면 서버가 다시 판정합니다');
  }

  async function _rebuildWorktable() {
    if (!S || !S.data || S.saving) return;
    /* ★ 확인창은 실제로 일어나는 일을 전부 말한다(줄 수가 늘거나 줄 수 있다는 사실 포함) —
       "빈 줄만 다시 배치"로 뭉뚱그리면 사람이 예상하지 못한 변화가 남는다. */
    if (!window.confirm('저장된 날짜별 모집계획(오늘 이후)에 맞춰 작업표의 빈 줄을 다시 배열할까요?\n\n'
      + '· 빈 줄의 구매일자를 계획일로 옮깁니다(과거·날짜 없는 줄 포함)\n'
      + '· 계획 인원이 모자라면 빈 줄을 새로 만듭니다\n'
      + '· 어느 계획일에도 필요 없는 빈 줄은 구매일자를 비웁니다\n'
      + '· 참여자·연락처·주문이 있는 줄과, 계획에 없는 미래 날짜의 준비 줄은 건드리지 않습니다')) return;
    S.saving = true;
    var btn = document.getElementById('cdpRebuildBtn'); if (btn) btn.disabled = true;
    try {
      var j = await _req('POST', EP + encodeURIComponent(S.campId) + '/worktable-rebuild', {});
      applyOverview(j);
      toast('작업표를 재구성했습니다 — 빈 준비 행만 날짜별 계획에 맞췄습니다');
      refreshHost();
    } catch (e) {
      toast('작업표 재구성 실패: ' + (e.message || e));
    } finally {
      if (S) { S.saving = false; if (btn) btn.disabled = false; }
    }
  }

  /* ── 차수 ───────────────────────────────────────────────── */
  function _roundForm() {
    var f = document.getElementById('cdpRoundForm');
    if (f) f.classList.toggle('on');
  }
  async function _roundAdd() {
    if (!S || !S.data) return;
    var count = Number((document.getElementById('cdpRfCount') || {}).value);
    var startDate = String((document.getElementById('cdpRfDate') || {}).value || '');
    var label = String((document.getElementById('cdpRfLabel') || {}).value || '');
    if (!Number.isInteger(count) || count <= 0) { toast('추가 건수를 입력해주세요'); return; }
    var curTotal = S.data.recruitTotal || 0;
    var nextNo = (S.data.rounds || []).length ? Math.max.apply(null, S.data.rounds.map(function (r) { return r.roundNo; })) + 1 : (curTotal > 0 ? 2 : 1);
    if (!window.confirm(nextNo + '차로 ' + count + '건을 추가할까요?\n총량 ' + (curTotal > 0 ? curTotal : '무제한') + ' → ' + (curTotal + count) + '건'
      + (curTotal <= 0 ? '\n(무제한 공고가 총량 관리로 전환됩니다)' : ''))) return;
    try {
      var j = await _req('POST', EP + encodeURIComponent(S.campId) + '/rounds', { count: count, startDate: startDate || undefined, label: label || undefined });
      applyOverview(j);
      // ★ 코드리뷰 M1: 마감(영속)·임시저장 상태면 차수만으로는 모집이 재개되지 않는다 — 즉시 고지
      toast(j.roundNo + '차 +' + count + '건 — 총량 ' + j.newTotal + '건'
        + (j.status && j.status !== 'active' ? ' · ⚠ 게시를 켜야 모집이 재개됩니다' : ''));
      refreshHost();
    } catch (e) { toast('차수 추가 실패: ' + (e.message || e)); }
  }
  async function _roundRemove() {
    if (!S || !S.data) return;
    var rs = S.data.rounds || [];
    if (rs.length < 2) return;
    var last = rs[rs.length - 1];
    if (!window.confirm(last.roundNo + '차(' + last.count + '건)를 제거할까요?\n총량 ' + (S.data.recruitTotal || 0) + ' → ' + ((S.data.recruitTotal || 0) - last.count) + '건')) return;
    try {
      var j = await _req('DELETE', EP + encodeURIComponent(S.campId) + '/rounds');
      applyOverview(j);
      toast(j.removedRoundNo + '차 제거 — 총량 ' + j.newTotal + '건');
      refreshHost();
    } catch (e) { toast('차수 제거 실패: ' + (e.message || e)); }
  }

  /* ── 호스트 목록 갱신(별표 토글과 같은 순서) ── */
  function refreshHost() {
    try {
      if (typeof window.loadRecruitList === 'function') window.loadRecruitList();
      else if (typeof window.loadRecruitPreview === 'function') window.loadRecruitPreview();
      // 작업보드에서 같은 공용 모달을 열었을 때는 카드만 갱신해서는 안 된다.
      // 저장 API가 무시트 작업표의 미배정 행을 재배치·투영한 뒤이므로, 열린 작업보드도
      // 즉시 다시 읽어 날짜/행을 같은 결과로 보여 준다. 호출부가 없으면 기존 화면은 무영향.
      if (typeof window.CAMPAIGN_DAILY_PLAN_SAVED === 'function') {
        window.CAMPAIGN_DAILY_PLAN_SAVED({ campaignId: S && S.campId ? String(S.campId) : '' });
      }
    } catch (_) {}
  }

  function toast(msg) {
    var t = document.getElementById('cdpToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'cdpToast';
      t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e293b;color:#fff;font-size:.76rem;padding:9px 17px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s;z-index:10070;max-width:92vw;text-align:center';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '.96';
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.style.opacity = '0'; }, 2600);
  }

  window.CampaignDailyPlan = {
    open: open, close: close,
    openWeekendRebalance: openWeekendRebalance, _rebalance: _rebalance,
    // 회귀가드용 — 순수 배분 함수(상태 미참조)
    _wkSpread: planWeekendSpread,
    _save: _save, _rebuildWorktable: _rebuildWorktable, _retry: _retry, _revert: _revert, _mode: _mode, _autoFit: _autoFit,
    _chExtend: _chExtend, _chSpread: _chSpread, _chCancel: _chCancel,
    _roundForm: _roundForm, _roundAdd: _roundAdd, _roundRemove: _roundRemove,
    _heldApply: _heldApply,
    quickApplyHeld: quickApplyHeld, _quickDo: _quickDo, _quickDetail: _quickDetail, _quickClose: _quickClose,
  };
})();
