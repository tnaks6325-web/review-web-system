/**
 * campaignState.service.js — 리뷰어 직접참여 캠페인 상태엔진 (PRD §03·§06-B)
 *
 * 원칙:
 *  - 상태는 저장하지 않고 매 요청 시 계산(드리프트·크론 누락 없음). 단 closed(종착)만은
 *    제출확정 트랜잭션이 recruit_campaigns.status='closed'로 영속화한다(비단조 플립 방지).
 *  - 유효 홀드 판정은 항상 시각 기준: status='applied' AND expires_at > now().
 *    만료 스윕(cron)은 정리용일 뿐 — 크론이 죽어도 카운터가 오염되지 않는다.
 *  - dailyQuota는 KST 일 시작 시점에 고정: min(daily_limit, recruit_total - 전일까지 누적확정).
 *    오늘 확정분이 분자·분모 양쪽에서 차감되는 이중차감을 막는다(recruit_total<=0 = 무제한 → daily_limit).
 *  - participation_mode=false(레거시 공고)는 이 엔진을 타지 않는다(현행 status+max_slots 로직 유지).
 */

const KST_OFFSET_MS = 9 * 3600 * 1000; // Asia/Seoul 고정 +9 (DST 없음)

/** 'HH:MM' | 'HH:MM:SS' → 자정 기준 분. 잘못된 값은 null */
function timeStrToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh === 24 && mm === 0) return 1440; // PG TIME '24:00:00' 허용(자정 종료 창) — 무신호 closed 위장 방지(레드 #10)
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** now의 KST 기준 자정(일 시작)을 UTC Date로 */
function kstDayStartUtc(now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST_OFFSET_MS);
}

/** now의 KST 기준 "자정 이후 경과 분" */
function kstMinutesOfDay(now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return k.getUTCHours() * 60 + k.getUTCMinutes();
}

/** 오늘(KST) 특정 TIME 문자열 시각 → UTC Date (없으면 null) */
function kstTodayAt(timeStr, now = new Date()) {
  const mins = timeStrToMinutes(timeStr);
  if (mins === null) return null;
  return new Date(kstDayStartUtc(now).getTime() + mins * 60 * 1000);
}

/**
 * 특정 KST 날짜('YYYY-MM-DD')의 오픈 시각 → UTC ISO. 시간창 없으면(자율주문) 그날 KST 자정.
 * daily_done 카드의 "다시 열릴 때까지" 카운트다운 기준값을 만드는 데 쓴다.
 */
function kstDateAtIso(isoDate, minutesOfDay) {
  if (!isoDate) return null;
  const base = Date.parse(isoDate + 'T00:00:00+09:00');
  if (Number.isNaN(base)) return null;
  return new Date(base + (minutesOfDay || 0) * 60000).toISOString();
}

/** 오늘(KST) 기준 내일 날짜 'YYYY-MM-DD' */
function kstTomorrowStr(now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS + 24 * 3600 * 1000);
  return k.toISOString().slice(0, 10);
}

/** DATE 값(문자열 'YYYY-MM-DD' 또는 pg Date 객체) → 'YYYY-MM-DD' 문자열. 무효/없음은 null */
function dateOnlyStr(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  return m ? m[1] : null;
}

/** now의 KST 날짜 문자열 'YYYY-MM-DD' */
function kstTodayStr(now = new Date()) {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 시트 일정에서 오늘까지(포함) 누적 계획 건수 — 미달분 이월의 분모 */
function plannedThrough(schedule, isoDate) {
  let sum = 0;
  for (const { date, slots } of schedule.dates) {
    if (date <= isoDate) sum += slots;
    else break;                       // dates는 오름차순 정렬 계약
  }
  return sum;
}

/** isoDate 다음의 첫 진행일(없으면 null) — 휴무일 안내용 */
function nextWorkDate(schedule, isoDate) {
  for (const { date } of schedule.dates) if (date > isoDate) return date;
  return null;
}

/** 시트 일정으로 볼 수 있는 값인지(날짜 2종 이상 + 정렬된 dates 보유) */
function isUsableSchedule(s) {
  return !!(s && s.ok && Array.isArray(s.dates) && s.dates.length >= 2 && s.byDate);
}

// ── 일 모집한도 미달분 이월(066) ──
// 어제 5명 부족하면 오늘 한도를 그만큼 올리고, 다 채우면 내일 원래 한도로 돌아온다
// (관리자가 손으로 20↔25를 오가던 작업의 자동화).
const CARRY_ENABLED = process.env.CAMPAIGN_DAILY_CARRY !== '0';
// ── 날짜별 모집 계획(095) ──
// 관리자가 특정 날짜의 모집 인원을 조절하면(campaign_daily_plans) 그 값이 그날의 계획이 된다.
// 계획 행이 없는 캠페인/날짜 = 기본 일건수(daily_limit) — 옵트인이라 기존 동작 100% 불변.
// 킬스위치: CAMPAIGN_DAILY_PLAN=0 이면 계획표 전체 무시(전건 기존 동작 즉시 복귀).
const PLAN_ENABLED = process.env.CAMPAIGN_DAILY_PLAN !== '0';

// ── 표(주문 원장) 기준 총량 게이트(2단계) ──
// 'off' | 'observe'(기본) | 'on'. off = 집계 쿼리 0(완전 킬스위치 · 되돌리기 = env 만).
// observe = counts.linked 만 싣고 게이트 무변경 — 관제·카드가 "표 기준이면 마감"을 먼저 관측한다
// (AUTO_FILE_ROUTE dry 와 같은 규율: 관측 후 출시 결정은 사람이).
// on = soft_full 게이트 반영(stateReason:'table_over_total' · 비영속 — maybePersistClosed 무접촉).
// ★★ 게이트 재료는 campaign_participants(작업표 줄)가 아니라 order_submissions(주문 원장) —
//   선기입 이름만 줄(참여 소각)·링크 오염·투영 지연이 정원 계산에 못 들어오게 하는 구조적 선택.
//   표시(카드 누적)는 작업표 줄(archiveSuggest.filled)이 맡는다 — 두 재료의 용도가 다르다.
const TABLE_QUOTA_MODE = (() => {
  const v = String(process.env.CAMPAIGN_TABLE_QUOTA || 'observe').toLowerCase();
  if (['0', 'false', 'off'].includes(v)) return 'off';
  if (['1', 'true', 'on'].includes(v)) return 'on';
  return 'observe';
})();

/** 그날의 명시 조절값(없으면 null) — dailyQuota 와 computeCampaignState 표시 재료가
 *  **같은 판정**을 쓴다(사본을 두면 정원과 표시가 갈린다). 킬스위치도 여기서 함께 판정. */
function planOverrideFor(plans, dateStr) {
  if (!PLAN_ENABLED || !plans || !dateStr || plans[dateStr] == null) return null;
  return Math.max(0, Number(plans[dateStr]) || 0);
}

/**
 * 시트 일정(063) 경로의 **조절 증감분 누적** — 오늘까지의 조절일들이 시트 계획과 얼마나 달랐는지의 합.
 * ★★ 이 항이 없으면 095 의 핵심 불변식이 깨진다(코드리뷰가 잡은 실측 회귀): `plannedThrough` 는
 *   시트 값 그대로 누적되는데 확정만 적으니, "오늘은 5명만"으로 줄인 15명이 **다음 날 자동 이월**
 *   되어(시트 20 → 35) 축소가 통째로 무력화된다. 반대로 늘린 날은 다음 날에서 그만큼 빼앗는다.
 *   일건수 경로의 `planned += ov − dl`(dailyQuota)과 같은 항을 **시트 계획을 기준선으로** 계산한 것.
 * ★ 미래 조절(d > 오늘)은 오늘 정원에 영향을 주지 않는다(일건수 경로와 같은 규칙).
 */
function planDeltaThrough(sch, plans, todayStr) {
  if (!PLAN_ENABLED || !sch || !plans || !todayStr) return 0;
  let delta = 0;
  for (const d of Object.keys(plans)) {
    if (d > todayStr) continue;
    const ov = planOverrideFor(plans, d);
    if (ov === null) continue;
    delta += ov - (Number(sch.byDate && sch.byDate[d]) || 0);
  }
  return delta;
}
// ── 이월 보류(098) ──
// carry_mode='hold' 공고는 자동 이월 가산을 멈추고(기본 일건수 + 날짜별 계획만),
// 미달분은 "보류 잔량"으로 표시되어 관리자가 골라 반영한다(반영 = 날짜별 계획에 얹기).
// 킬스위치 CAMPAIGN_CARRY_HOLD=0 = 전건 자동(현행)으로 즉시 복귀.
const CARRY_HOLD_ENABLED = process.env.CAMPAIGN_CARRY_HOLD !== '0';
/** 이 공고가 이월 보류인가 — dailyQuota 게이트·잔량 계산·카드 칩이 같은 판정을 쓴다(사본 금지). */
function isCarryHold(c) {
  return CARRY_HOLD_ENABLED && String((c && c.carry_mode) || 'auto') === 'hold';
}
// ★ 상한 — 이월이 아무리 쌓여도 하루 한도의 이 배수를 넘지 않는다.
//   상한이 없으면 오래 미달한 캠페인이 어느 날 갑자기 수십 건을 한꺼번에 열어
//   시트 기입·검수 인력이 감당 못 하는 버스트가 난다.
const CARRY_CAP_MULT = Math.max(1, Number(process.env.CAMPAIGN_DAILY_CARRY_CAP || 2));

/** 'YYYY-MM-DD' 두 개의 날짜 차이(일). b - a */
function _dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * dailyQuota — KST 일 시작 시점 고정 (§03-D). submittedBeforeToday = 전일까지의 누적확정
 *
 * carry = { startDate, today, submittedSince } 가 주어지면 미달분 이월을 적용한다.
 *   기준일 = max(캠페인 시작일, 이월 기준선)  ← 기준선은 066이 배포 시각에 고정(소급 방지)
 *   그날 정원 = daily_limit × 경과일수 − 기준일 이후 누적확정
 *
 * ★★ 두 가지 불변식(완화 금지):
 *   ① **절대 줄어들지 않는다** — 계산값이 daily_limit 미만이어도 daily_limit을 쓴다.
 *      이월은 "더 열어주는" 기능이지 한도를 조이는 기능이 아니다(기존 대비 축소 = 회귀).
 *   ② **총 모집인원은 그대로** — 마지막 clamp(rt - submittedBeforeToday)가 유지되므로
 *      이월이 총원을 넘겨 모집하는 일은 구조적으로 불가능하다.
 */
function dailyQuota(c, submittedBeforeToday, carry, planCtx) {
  const dl = Number(c.daily_limit) || 0;
  const rt = Number(c.recruit_total) || 0;
  const before = Number(submittedBeforeToday) || 0;

  // ── 날짜별 계획(095): planCtx = { today, plans:{'YYYY-MM-DD': n} } ──
  // ★★ 명시 조절일 = 그 값이 그날의 전부. "오늘은 20명만"의 의미는 이월분을 포함한 총 오픈이
  //    20이라는 것이므로, 조절일에는 자연 이월을 얹지도(축소 무력화) 빼지도(추가 축소) 않는다.
  //    전일까지의 자연 미달분은 사라지지 않고 다음 "조절 없는 날"의 plannedThrough 계산에 남는다.
  const plans = (PLAN_ENABLED && planCtx && planCtx.plans) || null;
  const todayStr = (planCtx && planCtx.today) || (carry && carry.today) || null;
  const ov = planOverrideFor(plans, todayStr);

  let q;
  if (ov !== null) {
    q = ov;
  } else {
    q = dl;
    // ★ 098: 보류 공고는 자동 이월을 얹지 않는다 — 미달분은 보류 잔량(heldCarry)으로 쌓이고
    //   관리자가 날짜별 계획으로 골라 반영한다. 총량 clamp 는 그대로라 물량 소실은 없다.
    if (!isCarryHold(c) && CARRY_ENABLED && carry && carry.startDate && carry.today && dl > 0) {
      const sd = dateOnlyStr(c.start_date);
      const anchor = (sd && sd > carry.startDate) ? sd : carry.startDate;   // 늦게 시작한 캠페인은 자기 시작일부터
      const days = _dayDiff(anchor, carry.today) + 1;                        // 오늘 포함 경과일수
      if (days > 1) {
        // 계획 누적 = 기본 일건수 × 경과일수 + (조절된 날들의 증감분). 계획 없으면 종전 식 그대로.
        // ★ 조절 = 계획 변경이므로, 축소한 날의 미달분은 여기서 애초에 "계획"에 안 잡힌다
        //   (사례 1: 40→20 조절 후 20명 참여 = 미달 0 → 다음날 40 그대로).
        let planned = dl * days;
        if (plans) {
          for (const d of Object.keys(plans)) {
            if (d >= anchor && d <= carry.today) planned += Math.max(0, Number(plans[d]) || 0) - dl;
          }
        }
        const done = Number(carry.submittedSince) || 0;
        q = Math.min(planned - done, dl * CARRY_CAP_MULT);
        if (q < dl) q = dl;   // ★ 불변식 ① — 이월은 그날 계획(기본 일건수)을 줄이지 않는다
      }
    }
  }

  if (rt <= 0) return Math.max(0, q); // 무제한 캠페인 가드(영구 daily_done 방지)
  return Math.max(0, Math.min(q, rt - before));   // ★ 불변식 ② — 총원 초과 불가
}

/**
 * 상태 판정 (순수 함수 — DB 없이 테스트 가능)
 * @param c      recruit_campaigns 행 (participation_mode, status, window_start, window_end,
 *               close_buffer_min, hold_ttl_min, daily_limit, recruit_total)
 * @param counts { activeHolds, todayActiveHolds, submittedAll, todaySubmitted, submittedBeforeToday }
 *               (유효 홀드 = applied AND expires_at>now 로 이미 집계된 값)
 * @param now    Date
 * @returns { state, todayCount, dailyQuota, serverNow, opensAt, closesAt, cutoffAt }
 *   state: 'legacy' | 'closed' | 'preopen' | 'open' | 'cutoff' | 'daily_done' | 'soft_full'
 */
function computeCampaignState(c, counts, now = new Date(), schedule = null) {
  const base = { serverNow: now.toISOString() };
  if (!c || !c.participation_mode) return { ...base, state: 'legacy' };

  // ★ 시트 일정(구매일자 컬럼 파생)이 있으면 시작일·마감일·정원의 진실원천이 된다.
  //   정원 = "오늘까지 누적 계획 − 전일까지 확정" → 못 채운 물량이 다음 진행일로 이월된다.
  //   일정이 없으면(못 읽으면) 기존 발행폼 값(daily_limit·recruit_total·start_date)으로 동작.
  const sch = isUsableSchedule(schedule) ? schedule : null;
  const todayStr = kstTodayStr(now);
  const submittedBefore = Number(counts.submittedBeforeToday) || 0;

  // 시트 일정이 있으면 그 일정이 이월까지 계산한다(063). 없으면 daily_limit 경로가 이월(066)
  // + 날짜별 계획 조절(095 — counts.plans). ★ 2026-08-07부터 **시트 일정 캠페인에도 적용**된다
  //   (조절한 날짜만 — 아래 ovToday 주석 참조).
  // 오늘이 명시 조절일인지 — 판정은 dailyQuota 와 같은 planOverrideFor 하나(사본 금지: 정원과
  //   표시가 갈리면 "카드는 20인데 참여는 40" 이 된다).
  // ★★ 시트 일정 캠페인도 포함한다(사용자 확정 2026-08-07): **조절한 날짜만** 리뷰웹이 이기고
  //   조절하지 않은 날은 종전대로 시트가 정한다 — 진실원본이 통째로 넘어오지 않아, 시트를 계속
  //   고쳐 쓰는 운영과 공존한다. 조절을 해제하면 그 날은 즉시 시트 값으로 복귀한다.
  const ovToday = planOverrideFor(counts.plans || null, todayStr);
  const quota = sch
    ? (ovToday !== null
        // 명시 조절일 = 그 값이 그날의 전부(095 규율 — 이월을 얹지도 빼지도 않는다).
        //   ★ 총량 clamp 는 유지: 시트 총건수를 넘겨 열 수는 없다(095 불변식 ②).
        ? Math.max(0, Math.min(ovToday, (Number(sch.totalSlots) || 0) - submittedBefore))
        // ★★ 조절 증감분(planDeltaThrough)을 계획 누적에 반영해야 "오늘은 5명만"의 축소분이
        //   다음 날 자동 이월되지 않는다(095 불변식 — 없으면 시트 20인 다음 날이 35로 열린다).
        : Math.max(0, Math.min(plannedThrough(sch, todayStr) + planDeltaThrough(sch, counts.plans || null, todayStr),
            sch.totalSlots) - submittedBefore))
    : dailyQuota(c, submittedBefore, counts.carry && { ...counts.carry, today: todayStr },
        { today: todayStr, plans: counts.plans || null });
  const todayCount = (Number(counts.todaySubmitted) || 0) + (Number(counts.todayActiveHolds) || 0);
  const opensAt = kstTodayAt(c.window_start, now);
  const closesAt = kstTodayAt(c.window_end, now);
  const bufferMin = Number(c.close_buffer_min ?? 10) || 0;
  const cutoffAt = closesAt ? new Date(closesAt.getTime() - bufferMin * 60 * 1000) : null;
  const payload = {
    ...base,
    todayCount,
    dailyQuota: quota,
    // 이월로 오늘 얼마나 더 열렸는지(관리자 표시용) — 0이면 평소와 같음.
    // 이 값이 없으면 "일건수를 20으로 설정했는데 25로 보인다"가 버그로 오해된다.
    // ★ 095: 명시 조절일은 이월이 아니라 "계획 자체"라 carryAdded=0 — 대신 todayPlanned로 말한다
    //   (조절 50을 "+10 이월"로 표기하면 관리자가 이월 사고로 오해).
    // ★ 기준선은 그 공고의 "평소 그날 인원" — 시트 일정 공고는 **시트의 그날 행 수**이지
    //   daily_limit 이 아니다(둘은 아무 관계가 없어 근거 없는 "+15 이월" 칩이 뜬다).
    carryAdded: ovToday !== null ? 0
      : Math.max(0, quota - (sch ? (Number(sch.byDate[todayStr]) || 0) : (Number(c.daily_limit) || 0))),
    todayPlanned: ovToday,                 // 오늘의 명시 조절값(없으면 null)
    planAdjusted: ovToday !== null,        // 카드 "조절됨" 표시 재료(관리자 전용 소비)
    // 카드가 "기본 N" 을 시트 기준으로 말할 수 있게 그날 시트 계획을 함께 싣는다(시트 공고만).
    todayBaseline: sch ? (Number(sch.byDate[todayStr]) || 0) : (Number(c.daily_limit) || 0),
    opensAt: opensAt ? opensAt.toISOString() : null,
    closesAt: closesAt ? closesAt.toISOString() : null,
    cutoffAt: cutoffAt ? cutoffAt.toISOString() : null,
  };

  // ★★ 표(주문 원장) 기준 소비량(2단계) — payload 에 먼저 싣는다: closed·preopen·daily_done 로
  //   반환되는 카드에도 관측 칩이 떠야 observe 가 관측 구실을 한다. 게이트 판정(wouldClose)은
  //   아래 soft_full 지점에서만 상태를 바꾼다.
  // ★ rt 공식은 여기서 한 번만 계산해 아래 soft_full 판정과 공유한다(판정 사본 0).
  const rtTotal = sch ? (Number(sch.totalSlots) || 0) : (Number(c.recruit_total) || 0);
  {
    const L = counts.linked;
    if (L && L.ok && !L.noTab) {
      // ★ max() = 이중계수 없음: 주문 행은 제출 완료 순간에만 생기고 그때 신청은 submitted(≠applied)라
      //   activeHolds 와 교집합이 없다(승인제 blog 홀드도 구매 전 = 주문 없음).
      //   잔여 엣지 = 홀드확정 SAVEPOINT 실패 직후 ≤TTL 동안 1건 이중계수(과차단 방향·자연 해소).
      const usedTable = Math.max(Number(counts.submittedAll) || 0, Number(L.orders) || 0)
                      + (Number(counts.activeHolds) || 0);
      payload.tableQuota = {
        mode: TABLE_QUOTA_MODE, orders: L.orders, ordersAll: L.ordersAll, sharedTab: !!L.sharedTab,
        // ★ sharedTab(한 탭에 살아있는 참여형 공고 2개↑)은 게이트 비활성 — 같은 주문을 두 공고
        //   rt 에 각각 얹으면 이중 차단(귀속 배분은 범위 밖, 관제가 사실을 말한다).
        wouldClose: rtTotal > 0 && !L.sharedTab && usedTable >= rtTotal,
      };
    }
  }

  if (c.status !== 'active') return { ...payload, state: 'closed' }; // closed는 영속값(제출확정 도달 시 저장)

  const startMin = timeStrToMinutes(c.window_start);
  const endMin = timeStrToMinutes(c.window_end);
  // ★ 자율주문(종일 오픈): 시간창 양쪽 모두 "명시적 미설정"이면 시간 게이트 없이 운영
  //   (preopen·cutoff·시간 daily_done 없음 — 일일한도·총모집·closed 게이트는 동일 작동).
  //   한쪽만 설정/역전은 여전히 설정 오류로 차단(무신호 장애 방지).
  const allDay = !c.window_start && !c.window_end;
  payload.allDay = allDay;
  if (!allDay && (startMin === null || endMin === null || endMin <= startMin)) {
    // 시간창 오설정/역전(활성화 게이트가 막지만 SQL 직생성 방어) — 참여 불가 + 원인 신호(관리자 식별용)
    return { ...payload, state: 'closed', stateReason: 'window_invalid' };
  }

  // ★ 시작일(start_date, migration 062): KST 오늘이 시작일 전이면 날짜 preopen(D-day 카운트다운).
  //   opensAt = 시작일의 오픈 시각(시간창 있으면 그날 window_start, 자율주문은 그날 KST 자정).
  //   NULL·과거·오늘 시작일은 이 분기를 타지 않음(기존 동작 불변).
  // 시작일: 시트 일정이 있으면 그 최소 날짜가 우선(관리자 입력 start_date는 폴백)
  const sd = sch ? sch.firstDate : dateOnlyStr(c.start_date);
  payload.startDate = sd;
  if (sch) {
    payload.scheduleSource = sch.source || 'sheet';
    payload.endDate = sch.lastDate;
    payload.totalSlots = sch.totalSlots;
    payload.todaySlots = sch.byDate[todayStr] || 0;
  }
  if (sd && todayStr < sd) {
    const openUtc = new Date(Date.parse(sd + 'T00:00:00+09:00') + (allDay ? 0 : startMin * 60000));
    return { ...payload, state: 'preopen', opensAt: openUtc.toISOString() };
  }
  // 마감일 경과 = 종료. ★ status에 영속하지 않는다 — 시트에 날짜가 추가되면 자동 재개.
  // ★★ 오늘 명시 조절값(1명 이상)이 있으면 그것이 우선한다 — 사람이 그날 인원을 정했는데
  //   화면이 조용히 무시하면 "저장했는데 안 열린다"(조용한 no-op)가 된다. 0명 조절은 '안 연다'는
  //   뜻이므로 그대로 종료 표기를 유지한다.
  if (sch && todayStr > sch.lastDate && !(ovToday > 0)) {
    return { ...payload, state: 'closed', stateReason: 'schedule_ended' };
  }

  // ★ daily_done 카드의 "다시 열릴 때까지" 카운트다운 기준.
  //   기존 `opensAt`은 **오늘의** window_start(=이미 지난 시각)이고 자율주문은 아예 null이라
  //   그대로 쓰면 카운트다운이 0에 붙는다 → 다음 오픈 시각을 별도 필드로 준다.
  //   다음 오픈일 = 시트 일정이 있으면 다음 진행일, 없으면 내일. 시각 = window_start(자율주문은 자정).
  const _reopenIso = () => kstDateAtIso(
    sch ? nextWorkDate(sch, todayStr) : kstTomorrowStr(now),
    allDay ? 0 : startMin);

  const t = kstMinutesOfDay(now);
  if (!allDay && t < startMin) return { ...payload, state: 'preopen' };
  if (!allDay && t >= endMin) return { ...payload, state: 'daily_done', reopensAt: _reopenIso() };

  // 휴무일(시트에 그 날짜 행이 0개) = 그날은 열지 않음. 못 채운 물량은 사라지지 않고
  // 다음 진행일 정원에 합산된다(plannedThrough가 휴무일엔 증가하지 않기 때문).
  // ★ 위 종료 판정과 같은 규율 — 오늘 명시 조절값(1명 이상)이 있으면 휴무일이어도 연다
  //   ("오늘은 진행일이 아니지만 10명만 더 받자"가 [📅 인원]의 정상 사용례).
  if (sch && !sch.byDate[todayStr] && !(ovToday > 0)) {
    const nw = nextWorkDate(sch, todayStr);
    // 다음 진행일까지 카운트다운을 줄 수 있게 opensAt을 그날 오픈 시각으로 —
    // 주말 하루 공백이든, 종료 후 새 블록이 붙은 긴 공백이든 같은 표기로 "다시 열림"이 보인다.
    const openUtc = nw ? new Date(Date.parse(nw + 'T00:00:00+09:00') + (allDay ? 0 : startMin * 60000)) : null;
    return {
      ...payload, state: 'daily_done', stateReason: 'rest_day', nextWorkDate: nw,
      opensAt: openUtc ? openUtc.toISOString() : payload.opensAt,
      reopensAt: openUtc ? openUtc.toISOString() : null,
    };
  }

  // ★★ 총 모집 충족을 **일일 마감보다 먼저** 본다(순서 고정).
  //   반대로 두면 총원이 차는 순간 dailyQuota가 0이 되어 `todayCount(0) >= quota(0)`이
  //   먼저 참이 되고, 다 모집한 캠페인이 매일 daily_done("내일 다시 오픈")으로 보인다.
  //   apply 게이트는 soft_full·daily_done 둘 다 차단이라 **참여 동작은 이 순서와 무관**하다
  //   (바뀌는 것은 관리자·리뷰어에게 보이는 상태 문구뿐).
  //   ★ soft_full 에는 reopensAt 을 싣지 않는다 — 총원이 찼으니 "다시 열림"이 아니다.
  const rt = rtTotal;   // (payload 부착 지점에서 한 번만 계산 — 표 기준 게이트와 같은 값)
  const usedAll = (Number(counts.submittedAll) || 0) + (Number(counts.activeHolds) || 0);
  if (rt > 0 && usedAll >= rt) return { ...payload, state: 'soft_full' }; // 총원 충족 — 신청 차단

  // ★★ 표(주문 원장) 기준 총량 게이트(2단계) — 공고를 안 거친 실구매(외부모집 수동제출·수기 원장
  //   기록·지각 구매)가 총량을 소비했으면 신규 신청을 닫는다. observe 는 payload 만 싣고 통과.
  //   ★ 영속하지 않는다(maybePersistClosed 무접촉) — 주문 취소·앵커 정정 시 자동 재오픈.
  //   ★ soft_full 규율 그대로 reopensAt 없음. noTab·null(모름)은 종전 판정(정원을 좁히지 않는다).
  if (TABLE_QUOTA_MODE === 'on' && payload.tableQuota && payload.tableQuota.wouldClose) {
    return { ...payload, state: 'soft_full', stateReason: 'table_over_total' };
  }

  // 금일완료(홀드 만료 반환 시 open 복귀)
  if (todayCount >= quota) return { ...payload, state: 'daily_done', reopensAt: _reopenIso() };

  if (!allDay && t >= endMin - bufferMin) return { ...payload, state: 'cutoff' }; // 신규 신청만 차단

  return { ...payload, state: 'open' };
}

/** state → apply 409 사유 코드 (open만 신청 가능) */
const APPLY_BLOCK_REASON = {
  legacy: 'legacy',
  closed: 'closed',
  preopen: 'preopen',
  daily_done: 'daily_done',
  soft_full: 'soft_full',
  cutoff: 'cutoff',
};

/**
 * 캠페인 N개의 카운트 일괄 집계 (1쿼리).
 * 유효 홀드 = status='applied' AND expires_at > NOW() (시각 기준 — 스윕 미실행에도 정확).
 * 레거시 'confirmed'/'cancelled'/'expired'는 어떤 카운트에도 포함되지 않는다.
 */
async function fetchCampaignCounts(pool, campaignIds, now = new Date()) {
  const out = new Map();
  const ids = (campaignIds || []).filter(Boolean);
  const carryStart = await _carryStartDate(pool);   // 이월 기준선(066) — 실패 시 null=이월 미적용
  const holdStart = await _holdStartDate(pool);     // 보류 잔량 기준선(098) — 실패 시 null=잔량 계산 불가
  const blank = () => ({
    activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0,
    carry: carryStart ? { startDate: carryStart, submittedSince: 0 } : null,
    hold: holdStart ? { startDate: holdStart, submittedSince: 0 } : null,
    plans: null,
    linked: null,
  });
  for (const id of ids) out.set(id, blank());
  if (!ids.length) return out;
  const dayStart = kstDayStartUtc(now).toISOString();
  // 기준선 00:00 KST — 이 시각 이후 ~ 오늘 이전의 확정만 이월 계산에 쓴다.
  //   ★ 캠페인은 자기 시작일 전에 확정이 있을 수 없으므로, 전역 기준선 하나로 세도
  //     max(시작일, 기준선) 기준으로 센 것과 같은 값이 나온다(쿼리 1개 유지).
  const carryFromUtc = carryStart ? new Date(Date.parse(carryStart + 'T00:00:00+09:00')).toISOString() : dayStart;
  const holdFromUtc = holdStart ? new Date(Date.parse(holdStart + 'T00:00:00+09:00')).toISOString() : dayStart;
  const { rows } = await pool.query(
    `SELECT campaign_id,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW())                              AS active_holds,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW() AND applied_at >= $2)         AS today_active_holds,
            COUNT(*) FILTER (WHERE status='submitted')                                                     AS submitted_all,
            COUNT(*) FILTER (WHERE status='submitted' AND submitted_at >= $2)                              AS today_submitted,
            COUNT(*) FILTER (WHERE status='submitted' AND (submitted_at < $2 OR submitted_at IS NULL))     AS submitted_before_today,
            COUNT(*) FILTER (WHERE status='submitted' AND submitted_at >= $3 AND submitted_at < $2)        AS submitted_since_carry,
            COUNT(*) FILTER (WHERE status='submitted' AND submitted_at >= $4 AND submitted_at < $2)        AS submitted_since_hold
       FROM campaign_applications
      WHERE campaign_id = ANY($1)
      GROUP BY campaign_id`,
    [ids, dayStart, carryFromUtc, holdFromUtc]
  );
  for (const r of rows) {
    out.set(r.campaign_id, {
      activeHolds: Number(r.active_holds) || 0,
      todayActiveHolds: Number(r.today_active_holds) || 0,
      submittedAll: Number(r.submitted_all) || 0,
      todaySubmitted: Number(r.today_submitted) || 0,
      submittedBeforeToday: Number(r.submitted_before_today) || 0,
      carry: carryStart
        ? { startDate: carryStart, submittedSince: Number(r.submitted_since_carry) || 0 }
        : null,
      hold: holdStart
        ? { startDate: holdStart, submittedSince: Number(r.submitted_since_hold) || 0 }
        : null,
      plans: null,
    });
  }
  // 날짜별 계획(095) — 실패 시 null=계획 미적용(기존 동작). 이 단일 깔때기에 실어야
  // 목록/상세/apply 게이트가 전부 같은 계획을 본다(화면마다 다른 정원 = "카드는 열렸는데 참여 거부").
  // ★ 카운트 쿼리 뒤에 둔다 — 쿼리 순서를 보는 기존 회귀가드(066)의 계약을 흔들지 않는다.
  const planMaps = await _loadPlanMaps(pool, ids);
  if (planMaps) {
    for (const id of ids) {
      const o = out.get(id);
      if (o) o.plans = planMaps.get(id) || null;
    }
  }
  // ★ 표(주문 원장) 기준 소비량(2단계) — **반드시 이 깔때기에 싣는다**(목록/상세/apply/외부접수가
  //   같은 정원을 본다 — 별도 인자로 흩으면 "카드는 열렸는데 참여 거부"). 시그니처 무변경 =
  //   소비처 4파일(campaign.routes·trackB·manualOrder·campaignPlan) 호출부 변경 0.
  //   ★ planMaps 뒤에 둔다 — 쿼리 순서를 보는 기존 회귀가드(066 q[0]/q[1])의 계약을 흔들지 않는다.
  const linkedMap = await _loadLinkedOrderCounts(pool, ids, now);
  if (linkedMap) {
    for (const id of ids) {
      const o = out.get(id);
      if (o) o.linked = linkedMap.get(id) || null;
    }
  }
  return out;
}

/**
 * 보류 잔량(098) — 누적 미달(보류 기준선 이후 ~ 어제) − 이미 반영한 합(appliedSum, 이력 원장).
 * 재료는 dailyQuota 와 같은 counts(hold 창·plans) — 계산이 갈리면 "칩은 5인데 반영하니 3"이 된다.
 * ★ null = "계산 불가"(보류 아님·기준선 모름·일건수 0) — 화면은 0으로 꾸미지 않고 칩을 숨기거나
 *   "조회 실패"를 말한다. 잔량은 표시·반영 참고값일 뿐, 정원 자체는 dailyQuota(계획표)가 정한다.
 */
/**
 * 이월(미달) 인원 — 기준선 이후 ~ **어제까지**의 계획 누적 − 실제 확정.
 * `win` = 세는 창: `counts.carry`(066 자동 이월 기준선) 또는 `counts.hold`(098 보류 기준선).
 * ★ 재료는 dailyQuota 와 같은 counts(plans 포함) — 계산이 갈리면 화면과 정원이 어긋난다.
 * ★ null = 계산 불가(기준선 모름 · 일건수 0 · 시트 일정) — 화면은 0 으로 꾸미지 않는다.
 */
function pendingCarry(c, counts, todayStr, win, schedule = null) {
  // ★★ 시트 일정 캠페인(063)은 정원을 시트 계획(plannedThrough)이 정하므로 자동 이월 자체가
  //   없다 = 이월 개념이 없다. 숫자를 돌려주면 화면에 **효과 없는** 이월 표시가 떠 막다른 길이 된다.
  if (isUsableSchedule(schedule)) return null;
  const dl = Number(c.daily_limit) || 0;
  if (!win || !win.startDate || !todayStr || dl <= 0) return null;
  const sd = dateOnlyStr(c.start_date);
  const anchor = (sd && sd > win.startDate) ? sd : win.startDate;
  const daysBefore = _dayDiff(anchor, todayStr);   // 오늘 제외 경과일수(소급 없음 — 기준선)
  if (daysBefore <= 0) return 0;
  // 어제까지의 계획 누적 = 기본 일건수 × 일수 + 조절 증감분(095 계획표 — dailyQuota 와 같은 재료)
  let planned = dl * daysBefore;
  const plans = (PLAN_ENABLED && counts.plans) || null;
  if (plans) {
    for (const d of Object.keys(plans)) {
      if (d >= anchor && d < todayStr) planned += Math.max(0, Number(plans[d]) || 0) - dl;
    }
  }
  return Math.max(0, planned - (Number(win.submittedSince) || 0));
}

/**
 * 보류 잔량(098) — 이월(pendingCarry, 보류 창) − 이미 반영한 합(appliedSum, 이력 원장).
 * ★ 보류 공고가 아니면 null(잔량 개념 없음). 나머지 규율은 pendingCarry 와 같다.
 */
function heldCarry(c, counts, todayStr, appliedSum = 0, schedule = null) {
  if (!isCarryHold(c)) return null;
  const base = pendingCarry(c, counts, todayStr, counts && counts.hold, schedule);
  if (base === null) return null;
  return Math.max(0, base - Math.max(0, Number(appliedSum) || 0));
}

/**
 * 날짜별 모집 계획 일괄 로드(095) → Map(campaignId → { 'YYYY-MM-DD': planned_count }).
 * ★ fail-open: 테이블 부재(42P01)·조회 실패 = null(계획 미적용 = 기존 동작) — 막는 기능의
 *   오류가 목록/참여를 죽이면 안 된다. 42P01은 5분 네거티브 캐시(마이그레이션 전 배포 로그 도배 방지).
 * ★★ apply/change-option은 잠금 트랜잭션의 client로 이 함수를 부른다 — tx 안에서는 실패한 쿼리
 *   하나가 tx 전체를 abort(25P02)시키므로(082 실증) SAVEPOINT로 격리한다. 커넥션이 pool이면
 *   (release 함수 없음) SAVEPOINT 없이 plain 쿼리(pool은 문장마다 다른 커넥션이라 SAVEPOINT 무의미).
 */
let _planTableMissingAt = 0;
const _PLAN_MISSING_TTL_MS = 5 * 60 * 1000;
async function _loadPlanMaps(db, ids) {
  if (!PLAN_ENABLED || !ids || !ids.length || !db || typeof db.query !== 'function') return null;
  if (Date.now() - _planTableMissingAt < _PLAN_MISSING_TTL_MS) return null;
  const inClient = typeof db.release === 'function';   // 체크아웃된 클라이언트 = 잠금 tx 가능성
  let sp = false;
  if (inClient) {
    try { await db.query('SAVEPOINT cdp_plans'); sp = true; } catch (_) { /* tx 밖 클라이언트 */ }
  }
  try {
    const { rows } = await db.query(
      `SELECT campaign_id, to_char(plan_date, 'YYYY-MM-DD') AS d, planned_count
         FROM campaign_daily_plans
        WHERE campaign_id = ANY($1)`,
      [ids]
    );
    if (sp) { try { await db.query('RELEASE SAVEPOINT cdp_plans'); } catch (_) {} }
    const m = new Map();
    for (const r of rows) {
      let o = m.get(r.campaign_id);
      if (!o) { o = {}; m.set(r.campaign_id, o); }
      o[r.d] = Math.max(0, Number(r.planned_count) || 0);
    }
    return m;
  } catch (e) {
    if (sp) { try { await db.query('ROLLBACK TO SAVEPOINT cdp_plans'); } catch (_) {} }
    if (e && e.code === '42P01') _planTableMissingAt = Date.now();
    return null;
  }
}
function __resetPlanCacheForTest() { _planTableMissingAt = 0; }

/**
 * 연결 탭의 "실구매 소비량"(주문 원장 기준) 일괄 로드 (2단계 표 기준 게이트 재료)
 *   → Map(campaignId → {ok:true, orders, ordersAll, sharedTab} | {ok:true, noTab:true}) | null
 * ★ 재료는 order_submissions 뿐 — 작업표 줄(campaign_participants)·order_submission_id 링크를
 *   읽지 않는다(선기입 이름만 줄·링크 오염·투영 지연 면역). 시트 API 호출 0.
 * ★ 앵커 = start_date(KST 자정) ?? created_at — 재사용 탭의 과거 블록 주문 배제.
 *   (`NULL::text || '…' = NULL` → COALESCE 가 created_at 으로 폴백한다.)
 * ★ fail 방향: off·조회 실패 = null = counts.linked 미부착 = 기존 동작 100%.
 *   "없다"(noTab = 연결 탭 없음)와 "모른다"(null)를 구분해 화면이 다르게 말한다.
 * ★★ 잠금 tx(client)에서는 SAVEPOINT 격리 — 실패 쿼리 하나가 apply tx 를 25P02 로 죽이면
 *   참여 INSERT 가 전멸한다(_loadPlanMaps 와 같은 자리·같은 이유·같은 판정식).
 * ★ 캐시는 pool 경로 전용 + 성공 결과만 담는다(client 게이트는 항상 신선 조회 = 잠금 안 최신 판정).
 */
let _ctqCache = new Map();               // campaignId → {at, val}
const CTQ_CACHE_MS = 10 * 1000;
const CTQ_CACHE_MAX = 800;               // 무한 성장 방지(넘으면 통째 비움 — LRU 불필요한 규모)
async function _loadLinkedOrderCounts(db, ids, now = new Date()) {
  if (TABLE_QUOTA_MODE === 'off' || !ids || !ids.length || !db || typeof db.query !== 'function') return null;
  const inClient = typeof db.release === 'function';   // 체크아웃된 클라이언트 = 잠금 tx 가능성
  if (!inClient && ids.every(id => { const c = _ctqCache.get(id); return c && now.getTime() - c.at < CTQ_CACHE_MS; })) {
    return new Map(ids.map(id => [id, _ctqCache.get(id).val]));
  }
  let sp = false;
  if (inClient) {
    try { await db.query('SAVEPOINT ctq_orders'); sp = true; } catch (_) { /* tx 밖 클라이언트 */ }
  }
  try {
    // ★★ 주문 좌표는 두 계열이다(프로덕션 실측 2026-08-20): 공고 경유(홀드 확정) 주문은
    //   `campaign:<공고ID>` 좌표(submit.routes._resolveCampaignOrderScope), 공고 미경유
    //   (외부모집 수동제출·직접 제출·시트 시절)는 연결 탭 좌표. 탭 좌표만 보면 공고 경유분이
    //   통째로 빠져(확정 67인데 orders 0) 관측·게이트가 과소해진다 → **합집합**으로 센다.
    //   `DISTINCT os.id` 라 과거 시트 시절(공고 경유도 탭 좌표) 겹침도 이중계수가 없다.
    // ★ 앵커(start_date 절단)는 **탭 좌표에만** 건다 — campaign: 좌표는 그 공고 귀속이 자명해
    //   재사용 탭의 과거 블록 문제가 없고, 잘라내면 공고 경유 확정이 과소집계된다.
    const { rows } = await db.query(`
      SELECT rc.id,
             COUNT(DISTINCT os.id) FILTER (
               WHERE os.sheet_id = 'campaign:' || rc.id
                  OR os.submitted_at >= COALESCE((rc.start_date::text || 'T00:00:00+09:00')::timestamptz, rc.created_at)
             )::int AS orders,
             COUNT(DISTINCT os.id)::int AS orders_all,
             shared.n::int AS live_campaigns
        FROM recruit_campaigns rc
        JOIN LATERAL (
          SELECT COUNT(*) AS n FROM recruit_campaigns rc2
           WHERE rc2.participation_mode AND rc2.status = 'active' AND rc2.archived_at IS NULL
             AND rc2.linked_sheet_id = rc.linked_sheet_id
             AND (rc2.linked_tab_name = rc.linked_tab_name
                  OR (NULLIF(rc.linked_tab_gid,'') IS NOT NULL
                      AND NULLIF(rc2.linked_tab_gid,'') = NULLIF(rc.linked_tab_gid,'')))
        ) shared ON TRUE
        LEFT JOIN order_submissions os
          ON os.deleted_at IS NULL
         AND (
              (os.sheet_id = 'campaign:' || rc.id AND os.tab_name = 'campaign:' || rc.id)
           OR (os.sheet_id = rc.linked_sheet_id
               AND (os.tab_name = rc.linked_tab_name
                    OR (NULLIF(rc.linked_tab_gid,'') IS NOT NULL
                        AND NULLIF(os.tab_gid,'') = NULLIF(rc.linked_tab_gid,''))))
         )
       WHERE rc.id = ANY($1) AND rc.participation_mode
         AND NULLIF(rc.linked_sheet_id,'') IS NOT NULL AND NULLIF(rc.linked_tab_name,'') IS NOT NULL
       GROUP BY rc.id, shared.n`, [ids]);
    if (sp) { try { await db.query('RELEASE SAVEPOINT ctq_orders'); } catch (_) {} }
    const m = new Map();
    for (const r of rows) {
      if (!r || r.id == null) continue;   // 범용 스텁 폴백 행 방어(id 없는 행은 재료가 아니다)
      m.set(r.id, { ok: true, orders: Number(r.orders) || 0, ordersAll: Number(r.orders_all) || 0,
                    sharedTab: Number(r.live_campaigns) > 1 });
    }
    for (const id of ids) if (!m.has(id)) m.set(id, { ok: true, noTab: true });
    if (!inClient) {
      if (_ctqCache.size > CTQ_CACHE_MAX) _ctqCache = new Map();
      for (const [id, val] of m) _ctqCache.set(id, { at: now.getTime(), val });
    }
    return m;
  } catch (e) {
    if (sp) { try { await db.query('ROLLBACK TO SAVEPOINT ctq_orders'); } catch (_) {} }
    return null;   // 모른다 = 미부착 = 게이트·표시 전부 종전 동작(모른다고 정원을 좁히지 않는다)
  }
}
function __resetTableQuotaCacheForTest() { _ctqCache = new Map(); }

/**
 * 이월 기준선(app_settings.campaign_carry_start, 066) — 프로세스 캐시.
 * ★ 조회 실패·미설정은 **null = 이월 미적용**(종전 동작). 알 수 없을 때 이월을 켜면
 *   기준을 모르는 채로 한도를 늘리게 되므로, 모르면 안 늘리는 쪽이 안전하다.
 */
let _blCache = { at: 0, carry: null, hold: null };
const CARRY_CACHE_MS = 5 * 60 * 1000;
/** 기준선 2종(이월 066 · 보류 잔량 098)을 **한 쿼리**로 읽는다 — 따로 읽으면 fetchCampaignCounts 의
 *  쿼리 순서가 밀려 "카운트 쿼리는 두 번째"라는 기존 회귀가드 계약(066)이 깨진다. */
async function _baselines(pool) {
  if (!pool || typeof pool.query !== 'function') return { carry: null, hold: null };
  if (Date.now() - _blCache.at < CARRY_CACHE_MS) return _blCache;
  const next = { at: Date.now(), carry: null, hold: null };
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('campaign_carry_start', 'campaign_carry_hold_start')`);
    for (const r of rows) {
      const v = /^(\d{4}-\d{2}-\d{2})/.exec(String(r.value || ''));
      if (!v) continue;
      if (r.key === 'campaign_carry_start') next.carry = v[1];
      else if (r.key === 'campaign_carry_hold_start') next.hold = v[1];
    }
  } catch (_) { /* 실패 = 둘 다 null(이월 미적용·잔량 계산 불가 — 모르면 안 늘리고 안 지어낸다) */ }
  _blCache = next;
  return _blCache;
}
async function _carryStartDate(pool) {
  if (!CARRY_ENABLED) return null;
  return (await _baselines(pool)).carry;
}
async function _holdStartDate(pool) {
  if (!CARRY_HOLD_ENABLED) return null;
  return (await _baselines(pool)).hold;
}
function __resetCarryCacheForTest() { _blCache = { at: 0, carry: null, hold: null }; }
function __resetHoldCacheForTest() { _blCache = { at: 0, carry: null, hold: null }; }

// ═══════════════════════════════════════════════════════════
// 상품옵션(campaign_options) — 옵션별 자리 계산 (061, PRD v1.1 §07)
//   ★ 동시성: apply/change-option/confirm 은 모두 recruit_campaigns 행 FOR UPDATE 안에서
//     옵션 카운트를 재집계하므로(캠페인 단위 직렬화), 옵션별 계산은 write-skew 없이 정확하다.
//   유효 홀드 = status='applied' AND expires_at>now (시각 기준 — 스윕 미실행 무해, 캠페인 카운트와 동일 계약).
// ═══════════════════════════════════════════════════════════

/**
 * 한 캠페인의 옵션별 카운트 집계 (option_key GROUP BY, 1쿼리).
 * @returns Map optKey → { activeHolds, todayActiveHolds, submitted, todaySubmitted }
 */
async function fetchOptionCounts(db, campaignId, now = new Date()) {
  const out = new Map();
  if (!campaignId) return out;
  const dayStart = kstDayStartUtc(now).toISOString();
  const { rows } = await db.query(
    `SELECT option_key,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW())                      AS active_holds,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW() AND applied_at >= $2)  AS today_active_holds,
            COUNT(*) FILTER (WHERE status='submitted')                                              AS submitted,
            COUNT(*) FILTER (WHERE status='submitted' AND submitted_at >= $2)                       AS today_submitted
       FROM campaign_applications
      WHERE campaign_id = $1 AND option_key IS NOT NULL
      GROUP BY option_key`,
    [campaignId, dayStart]
  );
  for (const r of rows) {
    out.set(r.option_key, {
      activeHolds: Number(r.active_holds) || 0,
      todayActiveHolds: Number(r.today_active_holds) || 0,
      submitted: Number(r.submitted) || 0,
      todaySubmitted: Number(r.today_submitted) || 0,
    });
  }
  return out;
}

/**
 * 옵션 1개의 표시/판정 뷰 (순수 함수 — DB 없이 테스트 가능).
 * @param opt   campaign_options 행 { opt_key, pay_amount, recruit_total, daily_limit, status }
 * @param cnt   fetchOptionCounts 의 해당 옵션 값(없으면 0으로 처리)
 * @param campState computeCampaignState 결과(캠페인 게이트 반영 — 옵션이 열려도 캠페인이 닫히면 못 뽑음)
 * @returns { optKey, payAmount, recruitTotal, dailyLimit,
 *            used, remaining(null=무제한), todayUsed, todayRemaining(null=제한없음),
 *            status: 'open'|'soldout'|'today_done'|'closed', selectable }
 */
function computeOptionView(opt, cnt, campState) {
  const c = cnt || { activeHolds: 0, todayActiveHolds: 0, submitted: 0, todaySubmitted: 0 };
  const recruitTotal = Math.max(0, Number(opt.recruit_total) || 0);
  const dailyLimit = Math.max(0, Number(opt.daily_limit) || 0);
  const used = (Number(c.submitted) || 0) + (Number(c.activeHolds) || 0);
  const todayUsed = (Number(c.todaySubmitted) || 0) + (Number(c.todayActiveHolds) || 0);
  const remaining = recruitTotal > 0 ? Math.max(0, recruitTotal - used) : null;       // null=무제한
  const todayRemaining = dailyLimit > 0 ? Math.max(0, dailyLimit - todayUsed) : null;  // null=옵션 일일제한 없음

  let status;
  if (String(opt.status || 'active') === 'closed') status = 'closed';          // 수동 마감
  else if (remaining !== null && remaining <= 0) status = 'soldout';           // 정원 소진
  else if (todayRemaining !== null && todayRemaining <= 0) status = 'today_done'; // 오늘 소진(내일 재개)
  else status = 'open';

  // 실제 선택 가능 = 옵션 open AND 캠페인 상태가 신청 가능(open) — 캠페인이 닫히면 옵션도 못 뽑음
  const campOpen = !campState || campState.state === 'open';
  return {
    optKey: opt.opt_key,
    // 참여 후 작업가이드에서 선택한 상품의 링크를 열 수 있도록 옵션 URL도 보존한다.
    optionUrl: String(opt.option_url || ''),
    payAmount: Math.max(0, Number(opt.pay_amount) || 0),
    recruitTotal, dailyLimit,
    used, remaining, todayUsed, todayRemaining,
    status,
    selectable: status === 'open' && campOpen,
  };
}

/**
 * ★★ "이 공고는 옵션 공고인가" 판정의 **단일 출처** — 살아있는(마감 아닌) 옵션만 센다.
 *
 *  왜 필요한가(2026-08-07 우레온 건): 참여자가 붙은 옵션은 삭제 대신 `closed` 로 보존되는데
 *  (참여 기록 보호 — 올바른 규칙), 종전 apply 게이트는 **closed 포함 전체 행 수**로 옵션 공고를
 *  판정해 "관리자가 잘못 생긴 옵션을 정리(마감)하면 공고가 영구 잠기는" 상태를 만들었다.
 *  옵션 구조를 정리한 공고는 **옵션 없는 공고**로 봐야 한다.
 *
 *  ★ 완화 금지: `soldout`(active 인데 자리 소진)·`today_done` 은 **살아있는 옵션**으로 남긴다 —
 *    "전부 마감이어도 옵션 없이 우회 참여 금지" 원칙의 '마감'은 자리 소진(soldout)이고,
 *    여기서 여는 것은 **관리자가 옵션 구조 자체를 정리한 경우**뿐이다.
 *
 *  @param rows `campaign_options` 원본 행 배열 **또는** `computeOptionView` 결과 배열
 *              (둘 다 `status` 를 갖고, `'closed'` 는 오직 DB status='closed' 에서만 나온다)
 */
function liveOptions(rows) {
  return (rows || []).filter(o => o && String(o.status || 'active') !== 'closed');
}

module.exports = {
  computeCampaignState,
  fetchCampaignCounts,
  fetchOptionCounts,
  computeOptionView,
  liveOptions,
  dailyQuota,
  timeStrToMinutes,
  kstDayStartUtc,
  kstMinutesOfDay,
  kstTodayAt,
  kstTodayStr,
  dateOnlyStr,
  plannedThrough,
  nextWorkDate,
  isUsableSchedule,
  APPLY_BLOCK_REASON,
  KST_OFFSET_MS,
  CARRY_CAP_MULT,
  isCarryHold,
  pendingCarry,
  heldCarry,
  __resetCarryCacheForTest,
  __resetPlanCacheForTest,
  TABLE_QUOTA_MODE,
  __resetTableQuotaCacheForTest,
  __resetHoldCacheForTest,
};
