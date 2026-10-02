/**
 * campaignShortage.service — 어제 모집 부족 인원 처리 팝업 (사용자 확정 2026-10-02, migration 173)
 *
 * 로그인한 직원(공고 담당자 · 그 작업오더를 보낸 AE)에게 "어제 하루 인원을 다 못 채운 공고"를 알리고
 * 처리 방법을 고르게 한다.
 *  - extend : 모집 기간을 늘려 뒤에 붙이기 — 이 공고들은 이미 "종료일 뒤에 붙이기"라 정원은 그대로 두고,
 *             그 공고는 앞으로 묻지 않도록 표시만 남긴다(shortage_prompt_off_at).
 *  - today  : 오늘 모집에 부족 인원 더하기 — [📅 인원]과 **같은 저장 경로(savePlans)** 로 오늘 인원을 늘린다.
 *             그래서 카드·리뷰어 목록·참여 판정·작업보드 작업표가 기존 단일 경로로 함께 바뀐다(사본 0).
 *  - (1시간 뒤 다시 묻기는 서버를 부르지 않는다 — 누른 사람 화면에만 기억한다)
 *
 * ★★ 대상(사용자 확정): 참여형 · 게시 중 · 이월 방식 = 종료일 뒤에 붙이기(extend) · 이월 보류 아님.
 *   자동으로 더하는 방식(next/spread)은 시스템이 이미 다음 날에 얹으므로 묻지 않는다(이중 가산 금지).
 * ★★ 부족 인원 = **어제 하루** 기준(그날 열린 인원 − 그날 참여 확정). 하루에 한 번만 묻는다
 *   (그 날짜의 처리 기록이 있으면 다시 묻지 않는다). 누적 이월 숫자를 쓰지 않는다 — 오늘 더해 다 채워도
 *   누적 숫자는 줄지 않아 같은 질문이 매일 반복된다.
 * ★ 모르면 묻지 않는다: 어제 시작 전 · 어제 열린 적 없음(어제 이전 신청 0건) · 쉬는 날 · 정원 소진 · 조회 실패.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const st = require('./campaignState.service');
const { isWeekendClosedOn } = require('./campaignWeekend.service');
const { mapWorkManager } = require('../utils/workManager');

const ACTION = 'shortage_decision';

function _norm(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }

/** 이 사람이 그 공고의 받는 사람인가 — 공고 담당자(닉네임) 또는 연결 작업오더를 보낸 AE. */
function isRecipient(adminName, campaign, workOrder) {
  const me = _norm(adminName);
  if (!me) return false;
  const mgr = _norm(campaign && campaign.manager);
  if (mgr) {
    if (mgr === me) return true;
    const nick = _norm(mapWorkManager(adminName));
    if (nick && nick === mgr) return true;
  }
  if (workOrder) {
    // ★ 작업오더 쪽 받는 사람은 **보낸 AE(created_by) 하나** — manager_name 은 지난 담당 실명일 수 있어
    //   공고 담당이 바뀐 뒤에도 옛 담당에게 권한이 남는다(코덱스 리뷰).
    if (_norm(workOrder.created_by) && _norm(workOrder.created_by) === me) return true;
  }
  return false;
}

/**
 * 공고 하나의 어제 부족 계산(순수 함수).
 * @returns null(묻지 않음) | { shortage, yesterdayQuota, yesterdayConfirmed, left }
 */
function computeShortage(c, counts, f, yesterday) {
  if (!c || !counts || !f) return null;
  const sd = st.dateOnlyStr(c.start_date);
  if (sd && sd > yesterday) return null;                       // 어제는 시작 전
  // 어제 열려 있었는가 — 게시 시각(173)이 오늘 이전이어야 한다. ★ 신청 기록 유무로 추측하지 않는다
  //   (어제 0명 참여가 가장 큰 부족이다 — 코덱스 리뷰). 게시 시각을 모르면(옛 행) 생성 시각으로 본다.
  const pub = c.published_at || c.created_at;
  const todayStartMs = Number(f.todayStartMs), yStartMs = todayStartMs - 86400000;
  const pubMs = pub ? new Date(pub).getTime() : NaN;
  if (!(pubMs < todayStartMs)) return null;
  // ★ 어제 처음 게시했는데 어제 신청 마감 시각 뒤였다면 어제는 아무도 신청할 수 없었다 → 묻지 않는다(코덱스 리뷰)
  if (pubMs >= yStartMs) {
    const we = String(c.window_end || '').trim(), ws = String(c.window_start || '').trim();
    const endMin = (ws && we) ? st.timeStrToMinutes(we) : null;
    const buf = Number(c.close_buffer_min != null ? c.close_buffer_min : 10) || 0;
    const cutoffMs = endMin != null ? yStartMs + (endMin - buf) * 60000 : todayStartMs;
    if (pubMs >= cutoffMs) return null;
  }
  // ★ 어제 이후 인원 규칙(일건수·총원·주말·시작일·신청 시간)이 바뀌었으면 어제 정원을 다시 계산할 수 없다 → 묻지 않는다
  //   (175 트리거가 남기는 시각 — 지금 설정으로 어제를 재구성하면 없는 부족이 생긴다 — 코덱스 리뷰)
  if (c.quota_rules_changed_at && new Date(c.quota_rules_changed_at).getTime() >= yStartMs) return null;
  // ★ 날짜별 계획 킬스위치가 꺼져 있으면 정원 판정(computeCampaignState)처럼 계획을 무시한다(코덱스 리뷰)
  const plans = (PLAN_ON() && counts.plans) || null;
  const eff = st.effectiveQuota(c, counts);
  // ★ 정원을 작업오더 값에서 빌려 쓰는 공고는 어제 값이 무엇이었는지 알 수 없다(작업오더 수정 이력 없음) → 묻지 않는다(코덱스 리뷰)
  if (eff.dailySource === 'work_order' || eff.totalSource === 'work_order') return null;
  const dl = eff.dailyLimit, rt = eff.recruitTotal;
  let q;
  const ov = plans && plans[yesterday] != null ? Math.max(0, Number(plans[yesterday]) || 0) : null;
  if (ov !== null) q = ov;
  else if (isWeekendClosedOn(c, yesterday, plans)) q = 0;
  else q = dl;
  if (rt > 0) q = Math.min(q, Math.max(0, rt - (Number(f.beforeYesterday) || 0)));
  const got = Number(f.yesterday) || 0;
  const shortage = Math.max(0, q - got);
  if (shortage <= 0) return null;
  // 지금 남은 자리로 자른다(진행 중 홀드 포함) — 정원을 넘겨 더하지 않는다.
  //   ★ 소비량은 정원 깔때기의 단일 판정(totalQuotaUsage — 신청·주문 원장 중 큰 값)을 쓴다.
  let left = null;
  if (rt > 0) {
    const used = f.used != null ? Number(f.used) : ((Number(f.allConfirmed) || 0) + (Number(counts.activeHolds) || 0));
    left = Math.max(0, rt - used);
    if (left <= 0) return null;
  }
  return { shortage: left === null ? shortage : Math.min(shortage, left), yesterdayQuota: q, yesterdayConfirmed: got, left };
}

/**
 * 오늘 인원을 늘리면 **오늘 실제로 모집이 다시 열리는가**(코덱스 리뷰) — 아니면 [오늘 더하기]를 막는다.
 *  열림 = 모집 중 · 오늘 시간 전(preopen) · 오늘 인원이 차서 닫힌 상태(daily_done, 사유 없음)이면서 신청 마감 시각 전.
 *  막힘 = 신청 마감 시각이 지났거나(cutoff·시간창 끝) · 0명 조절/쉬는 날(rest_day) · 종료·총원 충족.
 */
function _canRaiseToday(c, state, now) {
  if (!state) return { ok: false, why: '오늘 정원을 확인하지 못했습니다' };
  const s = state.state;
  if (s === 'cutoff') return { ok: false, why: '오늘 신청 마감 시각이 지나 오늘에 더할 수 없습니다' };
  if (!['open', 'preopen', 'daily_done'].includes(s) || state.stateReason) {
    return { ok: false, why: s === 'daily_done' ? '오늘은 모집을 열지 않는 날이라 오늘에 더할 수 없습니다' : '지금은 모집이 닫혀 있어 오늘에 더할 수 없습니다' };
  }
  const ws = String(c.window_start || '').trim(), we = String(c.window_end || '').trim();
  if (ws && we) {
    const endMin = st.timeStrToMinutes(we);
    const buf = Number(c.close_buffer_min != null ? c.close_buffer_min : 10) || 0;
    if (endMin != null && st.kstMinutesOfDay(now) >= endMin - buf) return { ok: false, why: '오늘 신청 마감 시각이 지나 오늘에 더할 수 없습니다' };
  }
  return { ok: true, why: '' };
}

/**
 * 오늘에 더할 수 있는 자리 — 저장 게이트(savePlans over_total)와 같은 재료: 총원 − 오늘 이전 확정 − 앞날에 이미 정해 둔 인원 − 오늘 정원.
 * ★ 앞날 계획을 빼지 않으면 버튼은 켜져 있는데 누르면 over_total 로 거절된다(코덱스 리뷰).
 */
function _roomToday(c, counts, todayQuota, today, schedule) {
  // ★ 저장 게이트(savePlans over_total/quota_unknown)와 **같은 식**: need = (전체 소비 − 오늘 소비) + 오늘 + 앞날 계획 ≤ 총원.
  //   소비량은 totalQuotaUsage(신청·주문 원장·진행 중) — 오늘 들어온 외부 주문도 센다(코덱스 리뷰).
  const usage = st.totalQuotaUsage(c, counts || {}, schedule || null);
  const cap = Number(usage.cap) || 0;
  if (!(cap > 0)) return Infinity;
  if (!usage.known) return 0;                                   // 원장 총량을 모르면 늘리지 않는다(게이트도 거부)
  const usedAll = Number(usage.used) || 0;
  const usedToday = (Number(counts && counts.todaySubmitted) || 0) + (Number(counts && counts.todayActiveHolds) || 0);
  let future = 0;
  const plans = (counts && counts.plans) || {};
  for (const d of Object.keys(plans)) if (d > today) future += Math.max(0, Number(plans[d]) || 0);
  const base = Math.max(0, usedAll - usedToday) + future;
  return Math.max(0, cap - base - Math.max(Number(todayQuota) || 0, usedToday));
}

const MAX_DAY_COUNT = 9999;   // campaignPlan.savePlans 의 하루 인원 상한과 같은 값
const PLAN_ON = () => process.env.CAMPAIGN_DAILY_PLAN !== '0';   // campaignPlan.getPlanOverview.planEnabled 와 같은 기준

/**
 * 상품(옵션)별 하루 한도가 걸린 공고 — 공고 전체 오늘 인원을 늘려도 옵션 한도가 그대로라
 * 늘린 자리를 아무도 고를 수 없다 → 그런 공고는 "오늘에 더하기"를 막는다(코덱스 리뷰).
 * ★ 조회 실패 = null(모름) → 호출부가 막는 쪽으로 접는다(조용한 무동작 금지).
 */
async function _optionCappedIds(db, ids) {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT campaign_id FROM campaign_options
        WHERE campaign_id = ANY($1::text[]) AND COALESCE(status,'active') <> 'closed'
          AND COALESCE(daily_limit,0) > 0`, [ids.map(String)]);
    return new Set(rows.map(r => String(r.campaign_id)));
  } catch (e) {
    if (e && e.code === '42P01') return new Set();
    logger.warn(`[campaignShortage] 옵션 한도 조회 실패: ${e.message}`);
    return null;
  }
}

/** 잠근 행으로 다시 보는 후보 조건 — 후보 조회 SQL·필터와 같은 기준(그 사이 정책이 바뀌었으면 거절 — 코덱스 리뷰) */
function _stillEligible(c) {
  return !!c && c.participation_mode === true && c.status === 'active' && !c.archived_at && !c.shortage_prompt_off_at
    && !c.reviewer_hidden && (c.carry_strategy || 'next') === 'extend' && (c.work_kind || '') !== 'blog' && !st.isCarryHold(c);
}

async function _loadCandidates(db) {
  const { rows } = await db.query(
    `SELECT * FROM recruit_campaigns
      WHERE participation_mode = TRUE AND status = 'active'
        AND archived_at IS NULL AND shortage_prompt_off_at IS NULL
        AND COALESCE(reviewer_hidden, FALSE) = FALSE
        AND COALESCE(carry_strategy,'next') = 'extend'
        AND COALESCE(work_kind,'') <> 'blog'`);   // 블로그는 하루 인원 개념이 없다(일건수 = 총원 보정값)
  // ★ 리뷰어 숨김(테스트) 공고는 운영 팝업에 올리지 않는다(코덱스 리뷰).
  // ★ 이월 보류 판정은 정원 판정과 같은 isCarryHold 단일 출처(킬스위치 CAMPAIGN_CARRY_HOLD=0 반영 — SQL 사본 금지).
  return rows.filter(c => !st.isCarryHold(c));
}

/**
 * 어제 하루 확정 수 — ★★ 정원 깔때기(fetchCampaignCounts)를 **오늘 기준·어제 기준으로 두 번** 태워
 *   "오늘 이전 확정 − 어제 이전 확정"으로 센다(코덱스 리뷰). 신청 표만 세면 외부모집 수동제출·지각 주문처럼
 *   신청 기록 없이 작업표에 들어온 구매를 빠뜨려 **채워진 날을 부족으로 오인**한다. 깔때기는 신청·주문 원장 중
 *   큰 값을 쓰므로(결정 184) 화면 정원 판정과 같은 숫자다. 경계도 같은 now 에서 나온다(자정 경계 어긋남 방지).
 */
async function _loadFacts(db, ids, now, countsNow) {
  const prevNow = new Date(st.kstDayStartUtc(now).getTime() - 1000);   // 어제 23:59:59 KST
  const prev = await st.fetchCampaignCounts(db, ids, prevNow);
  const m = new Map();
  for (const id of ids) {
    const cn = countsNow.get(id), cp = prev.get(id);
    if (!cn || !cp) continue;
    const beforeToday = Number(cn.submittedBeforeToday) || 0;
    const beforeYesterday = Number(cp.submittedBeforeToday) || 0;
    // ★ 어제 구간 = 신청 구간 수와 주문 원장 구간 수 중 **큰 값**(결정 184 "구간마다 큰 값" — 깔때기와 같은 규칙).
    //   합쳐진 누계끼리 빼면 기준이 날마다 달라져(그제는 신청, 어제는 주문) 어제 수가 줄어든다(실측).
    const raw = (o) => (o && o.applications ? Number(o.applications.submittedBeforeToday) || 0 : Number(o && o.submittedBeforeToday) || 0);
    const appsY = Math.max(0, raw(cn) - raw(cp));
    const ln = cn.linked, lp = cp.linked;
    // ★ 주문 원장은 깔때기가 실제로 합쳤을 때만(countBasis='max') 쓴다 — 운영 되돌리기 스위치
    //   (CAMPAIGN_COUNT_BASIS=applications · 표 기준 observe)를 따른다(코덱스 리뷰).
    const ordersY = (cn.countBasis === 'max' && cp.countBasis === 'max'
        && ln && lp && ln.ok && lp.ok && !ln.noTab && !ln.sharedTab && Number.isFinite(ln.ordersBefore) && Number.isFinite(lp.ordersBefore))
      ? Math.max(0, ln.ordersBefore - lp.ordersBefore) : 0;
    m.set(id, { beforeToday, beforeYesterday, yesterday: Math.max(appsY, ordersY),
      todayStartMs: st.kstDayStartUtc(now).getTime(), used: null });
  }
  return m;
}

async function _decidedFor(db, ids, date) {
  const { rows } = await db.query(
    `SELECT DISTINCT campaign_id FROM campaign_plan_events
      WHERE campaign_id = ANY($1) AND action = $2 AND detail->>'date' = $3`, [ids, ACTION, date]);
  return new Set(rows.map(r => r.campaign_id));
}

/**
 * 이 사람에게 띄울 어제 부족 공고 목록. 실패는 빈 목록 + 사유(fail-soft — 팝업이 안 뜰 뿐, 화면은 정상).
 * @param campaignIds 지정하면 그 공고들만(반영 직전 재검증용)
 */
async function listShortages(admin, opts = {}) {
  const db = opts.db || pool;
  const now = opts.now || new Date();
  const today = st.kstTodayStr(now);
  const yesterday = st.addIsoDays(today, -1);
  let cands;
  try { cands = await _loadCandidates(db); }
  catch (e) {
    if (e && e.code === '42703') return { ok: true, items: [], date: yesterday, notReady: true };
    throw e;
  }
  if (opts.campaignIds) { const want = new Set(opts.campaignIds.map(String)); cands = cands.filter(c => want.has(String(c.id))); }
  if (!cands.length) return { ok: true, items: [], date: yesterday };
  const ids = cands.map(c => c.id);
  const { linkedWorkOrdersForCampaigns } = require('./linkedRecruitQuota.service');
  const [wos, decided, countsMap, optCapped] = await Promise.all([
    linkedWorkOrdersForCampaigns(db, ids, ['created_by']).catch(() => new Map()),
    _decidedFor(db, ids, yesterday),
    st.fetchCampaignCounts(db, ids, now),
    _optionCappedIds(db, ids),
  ]);
  const facts = await _loadFacts(db, ids, now, countsMap);
  // ★ 시트 일정 공고(063, CAMPAIGN_SHEET_SCHEDULE=1)는 정원을 시트가 정한다 — 이월 개념이 없어 묻지 않는다(코덱스 리뷰).
  //   deriveSchedules 는 실패해도 throw 하지 않고 그 탭을 맵에서 **빼고** 돌려준다(일정 없음 = 키는 있고 값 null).
  //   → 기능이 켜져 있는데 키가 없으면 "모름"으로 보고 묻지 않는다(코덱스 리뷰).
  const sheetScheduleOn = process.env.CAMPAIGN_SHEET_SCHEDULE === '1';
  let schMap = new Map();
  try { const cs = require('./campaignSchedule.service'); schMap = await cs.deriveSchedules(db, cs.tabsOfCampaigns(cands), now); }
  catch (_) { schMap = null; }
  const { scheduleFor } = require('./campaignSchedule.service');
  //   ★ deriveSchedules 는 조회·해석 실패도 "일정 없음"과 같은 null 로 남긴다 → 둘을 구분할 수 없으므로,
  //     시트 일정 기능이 켜져 있으면 **시트에 연결된 공고는 일정을 확인한 경우(usable)든 아니든 묻지 않는다**
  //     (모르는 채로 일건수 기준 정원을 바꾸지 않는다 — 코덱스 리뷰). 기능은 기본 꺼짐(사용자 확정 2026-08-07).
  const scheduleUnknown = (c) => sheetScheduleOn && !!(c.linked_sheet_id && c.linked_tab_gid)
    && (schMap === null || !st.isUsableSchedule(scheduleFor(schMap, c)));
  const items = [];
  for (const c of cands) {
    if (decided.has(c.id)) continue;
    // ★ 상품별 하루 한도가 걸린 공고는 어제 실제로 열 수 있던 인원이 공고 전체 인원보다 적을 수 있다 → 묻지 않는다.
    //   한도 조회 실패(null)도 모름이라 묻지 않는다(코덱스 리뷰).
    if (optCapped === null || optCapped.has(String(c.id))) continue;
    if (!opts.skipRecipient && !isRecipient(admin && admin.name, c, wos.get(c.id))) continue;
    if (scheduleUnknown(c) || (schMap && st.isUsableSchedule(scheduleFor(schMap, c)))) continue;
    const counts = countsMap.get(c.id);
    const fx = facts.get(c.id);
    // ★ 원장 총량을 모르면(연결 주문 조회 실패) 묻지 않는다 — 어제가 실제로는 다 찼을 수 있다(코덱스 리뷰)
    let usage = null;
    try { usage = st.totalQuotaUsage(c, counts); } catch (_) { usage = null; }
    if (!usage || !usage.known) continue;
    if (fx) fx.used = usage.used;
    const s = computeShortage(c, counts, fx, yesterday);
    if (!s) continue;
    let state = null, todayQuota = null, endDate = null;
    try {
      state = st.computeCampaignState(c, counts, now, null);
      todayQuota = Number(state.dailyQuota) || 0;
    } catch (_) { /* 모름 — 오늘 더하기만 막는다 */ }
    try { const p = st.projectDailyQuotas(c, counts, { now, maxDays: 180 }); endDate = p && p.endDate || null; } catch (_) { /* 표시만 생략 */ }
    const todayClosed = isWeekendClosedOn(c, today, counts && counts.plans);
    const reopenable = _canRaiseToday(c, state, now);
    // 오늘에 더할 수 있는 인원 — 오늘 정원 + 더한 값이 남은 총원(오늘 이전 확정 제외)을 넘지 않게.
    //   넘기면 저장 게이트(over_total)가 거부한다. 총원 무제한이면 부족 인원 그대로.
    const rt = st.effectiveQuota(c, counts).recruitTotal;
    let addable = s.shortage;
    if (rt > 0 && todayQuota !== null) addable = Math.min(addable, _roomToday(c, counts, todayQuota, today, null));
    // ★ 하루 인원 상한(9999 — [📅 인원] 저장 규칙)을 넘기면 저장이 통째로 거절된다 → 그 안에서만 더한다(코덱스 리뷰)
    if (todayQuota !== null) addable = Math.max(0, Math.min(addable, MAX_DAY_COUNT - todayQuota));
    items.push({
      campaignId: c.id, title: c.title || '', thumbnailUrl: c.thumbnail_url || '',
      manager: c.manager || '', shortage: s.shortage,
      yesterdayQuota: s.yesterdayQuota, yesterdayConfirmed: s.yesterdayConfirmed,
      todayQuota, endDate,
      addable,
      linkedSheetId: c.linked_sheet_id || '', linkedTabName: c.linked_tab_name || '',
      canAddToday: PLAN_ON() && optCapped !== null && !optCapped.has(String(c.id)) && todayQuota !== null && !todayClosed && addable > 0 && reopenable.ok,
      // ★ 날짜별 계획 킬스위치가 꺼져 있으면 저장해도 정원에 안 먹는다 → 오늘 더하기를 막는다(조용한 무동작 금지 · 코덱스 리뷰)
      todayBlockedReason: !PLAN_ON() ? '날짜별 인원 조절이 지금 꺼져 있어 오늘에 더할 수 없습니다'
        : optCapped === null ? '상품별 하루 한도를 확인하지 못해 오늘에 더할 수 없습니다'
        : optCapped.has(String(c.id)) ? '상품별 하루 한도가 정해진 공고라 오늘에 더할 수 없습니다 — 기간을 늘리거나 [📅 인원]·공고 수정에서 상품별 한도를 조절해 주세요'
        : todayClosed ? '오늘은 쉬는 날이라 오늘에 더할 수 없습니다'
        : (todayQuota === null ? '오늘 정원을 확인하지 못했습니다'
          : (!reopenable.ok ? reopenable.why
            : (addable <= 0 ? '남은 인원이 이미 오늘 모집에 모두 열려 있습니다' : ''))),
    });
  }
  return { ok: true, items, date: yesterday, today };
}

/** 작업표 반영 결과를 화면에 말할 형태로 — 실패·경고(무시트 아님·줄 수 초과 등)를 버리지 않는다(코덱스 리뷰). */
function _worktableNote(ws) {
  if (!ws) return null;
  const rb = ws.rebuild;
  // ★ 다른 공고와 작업표를 함께 쓰면 표를 건드리지 않는다(savePlans 의도) — 그 사실을 경고로 말한다(코덱스 리뷰)
  if ((ws.slotCap && ws.slotCap.reason === 'shared_worktable') || (rb && rb.reason === 'shared_worktable')) {
    return { ok: true, warn: true, reason: '다른 공고와 함께 쓰는 작업표라 작업보드 줄은 그대로입니다 — 작업보드에서 확인해 주세요' };
  }
  if (ws.ok === false || (rb && rb.ok === false)) return { ok: false, reason: (rb && (rb.message || rb.reason)) || ws.message || '작업표 맞추기 실패' };
  if (ws.warn || ws.rowAudit) {
    const ra = ws.rowAudit;
    const msg = ws.message || (ra ? (ra.message || `작업표 줄이 총인원보다 ${ra.over != null ? ra.over + '줄 ' : ''}많습니다 — [📅 인원]에서 확인해 주세요`) : '작업표는 바뀌지 않았습니다');
    return { ok: true, warn: true, reason: msg };
  }
  return { ok: true };
}

/**
 * 잠근 공고 행으로 다시 확인(두 갈래 공용 — 사본 금지). 그 사이 바뀐 것이 있으면 거절하고 다시 묻는다(코덱스 리뷰):
 *   후보 조건 전체 · 받는 사람(담당자·작업오더 보낸 AE) · 날짜(자정 경과) · 어제 부족 인원.
 * 돌려주는 값 = 잠근 순간의 { lockNow, counts } (오늘 더하기 갈래가 이어서 쓴다).
 */
async function _lockedRecheck(client, camp, d, it, cur, admin, opts) {
  const err = (msg, code) => Object.assign(new Error(msg), { code });
  if (!_stillEligible(camp)) throw err('그 사이 공고가 보관·게시 해제되었거나 이미 처리됐습니다', 'not_eligible');
  const capNow = await _optionCappedIds(client, [d.campaignId]);
  if (capNow === null || capNow.has(String(d.campaignId))) throw err('상품별 하루 한도가 정해진 공고라 처리할 수 없습니다', 'not_eligible');
  if (!opts.skipRecipient) {
    const { linkedWorkOrdersForCampaigns } = require('./linkedRecruitQuota.service');
    let wo = null;
    try { wo = (await linkedWorkOrdersForCampaigns(client, [d.campaignId], ['created_by'])).get(d.campaignId) || null; } catch (_) { wo = null; }
    if (!isRecipient(admin && admin.name, camp, wo)) throw err('그 사이 공고 담당자가 바뀌어 처리할 수 없습니다', 'not_recipient');
  }
  const lockNow = new Date();
  if (st.kstTodayStr(lockNow) !== cur.today) throw err('날짜가 바뀌었습니다 — 다시 확인해 주세요', 'day_changed');
  const counts = (await st.fetchCampaignCounts(client, [d.campaignId], lockNow)).get(d.campaignId);
  const fxNow = (await _loadFacts(client, [d.campaignId], lockNow, new Map([[d.campaignId, counts]]))).get(d.campaignId);
  let usageNow = null; try { usageNow = st.totalQuotaUsage(camp, counts); } catch (_) { usageNow = null; }
  if (!fxNow || !usageNow || !usageNow.known) throw err('어제 참여 수를 다시 확인하지 못했습니다 — 잠시 뒤 다시 골라 주세요', 'stale_shortage');
  fxNow.used = usageNow.used;
  const sNow = computeShortage(camp, counts, fxNow, cur.date);
  if (!sNow || sNow.shortage !== it.shortage) throw err(`그 사이 어제 부족 인원이 ${it.shortage}명 → ${sNow ? sNow.shortage : 0}명으로 바뀌었습니다 — 다시 확인해 주세요`, 'stale_shortage');
  return { lockNow, counts };
}

/**
 * 결정 반영 — 고른 것만, 공고마다 독립 처리(하나가 실패해도 나머지는 반영). 서버가 다시 계산해 그 값으로 반영한다
 * (화면이 보낸 숫자는 믿지 않는다 — 그 사이 참여가 늘었을 수 있다).
 */
async function applyDecisions(admin, decisions, opts = {}) {
  const list = (Array.isArray(decisions) ? decisions : [])
    .map(d => ({ campaignId: String(d && d.campaignId || ''), choice: String(d && d.choice || '') }))
    .filter(d => d.campaignId && (d.choice === 'extend' || d.choice === 'today'));
  if (!list.length) { const e = new Error('반영할 선택이 없습니다.'); e.code = 'empty'; throw e; }
  if (list.length > 50) { const e = new Error('한 번에 50건까지 반영할 수 있습니다.'); e.code = 'too_many'; throw e; }
  const db = opts.db || pool;
  const actor = (admin && admin.name) || '';
  const now = opts.now || new Date();
  const cur = await listShortages(admin, { db, now, campaignIds: list.map(d => d.campaignId) });
  // ★ 화면이 보여준 날짜(어제)와 지금 서버의 어제가 다르면 통째로 거절 — 자정을 넘긴 팝업이
  //   다른 날의 부족 인원을 반영·기록하지 않게(코덱스 리뷰). 날짜를 안 보내는 옛 화면은 종전대로.
  if (opts.date && String(opts.date) !== cur.date) { const e = new Error('날짜가 바뀌었습니다 — 새 목록으로 다시 골라 주세요'); e.code = 'day_changed'; throw e; }
  const byId = new Map(cur.items.map(i => [String(i.campaignId), i]));
  const savePlans = opts.savePlans || require('./campaignPlan.service').savePlans;
  const results = [];
  for (const d of list) {
    const it = byId.get(d.campaignId);
    let saved = null;
    if (!it) { results.push({ campaignId: d.campaignId, ok: false, reason: '이미 처리됐거나 처리할 부족 인원이 없습니다' }); continue; }
    /* ★★ 결정 기록과 변경은 **한 트랜잭션**(코덱스 리뷰): 같은 공고·같은 날짜 결정은 부분 유니크
       (uq_cpe_shortage_decision)가 하나만 허용하므로, 담당자·AE가 동시에 [반영]해도 두 번째는 23505 로
       통째로 되돌아간다. 프로세스가 중간에 죽어도 기록만 남거나 변경만 남는 상태가 없다.
       ★ 오늘 인원은 **잠근 그 순간 다시 계산**한다 — 그 사이 다른 사람이 [📅 인원]에서 바꿨으면 거절하고
       다시 묻는다(낡은 값으로 덮어 사람의 조절을 지우지 않는다). */
    const record = (client, amount, extra) => client.query(
      `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, $3, $4)`,
      [d.campaignId, actor, ACTION, JSON.stringify(Object.assign({ date: cur.date, choice: d.choice, shortage: it.shortage, amount }, extra || {}))]);
    try {
      let amount = 0, from = it.todayQuota;
      if (d.choice === 'today') {
        if (!it.canAddToday) throw Object.assign(new Error(it.todayBlockedReason || '오늘에 더할 수 없습니다'), { code: 'today_blocked' });
        saved = await savePlans(d.campaignId, {
          set: [{ date: cur.today, count: it.todayQuota + it.addable }],
          note: `어제(${cur.date}) 부족 ${it.shortage}명 오늘 반영`,
        }, actor, {
          afterLock: async (client, camp, schedule) => {
            // ★ 잠근 행으로 후보 조건·받는 사람·날짜·어제 부족 인원을 다시 본다(두 갈래 공용)
            const { lockNow, counts } = await _lockedRecheck(client, camp, d, it, cur, admin, opts);
            const stNow = st.computeCampaignState(camp, counts, lockNow, st.isUsableSchedule(schedule) ? schedule : null);
            // ★ 잠근 그 순간에도 오늘 다시 열 수 있는지 다시 본다 — 그 사이 마감 시각이 지났거나 공고가 닫혔으면 거절(코덱스 리뷰)
            const again = _canRaiseToday(camp, stNow, lockNow);
            if (!again.ok || isWeekendClosedOn(camp, cur.today, counts && counts.plans)) throw Object.assign(new Error(again.why || '오늘은 쉬는 날이라 오늘에 더할 수 없습니다'), { code: 'today_blocked' });
            const q = Number(stNow.dailyQuota) || 0;
            if (q !== it.todayQuota) throw Object.assign(new Error(`그 사이 오늘 인원이 ${it.todayQuota}명 → ${q}명으로 바뀌었습니다 — 다시 확인해 주세요`), { code: 'stale_today' });
            amount = Math.min(it.addable, _roomToday(camp, counts, q, cur.today, st.isUsableSchedule(schedule) ? schedule : null));
            if (!(amount > 0)) throw Object.assign(new Error('남은 인원이 없어 오늘에 더할 수 없습니다'), { code: 'no_room' });
            from = q;
            return { todayCount: q + amount };
          },
          beforeCommit: (client) => record(client, amount, { todayFrom: from, todayTo: from + amount }),
        });
      } else {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const { rows: lk } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [d.campaignId]);
          if (!lk.length) throw Object.assign(new Error('공고를 찾을 수 없습니다'), { code: 'not_eligible' });
          // ★ 잠근 행으로 후보 조건·받는 사람·날짜·어제 부족 인원을 다시 본다(오늘 더하기와 같은 함수)
          await _lockedRecheck(client, lk[0], d, it, cur, admin, opts);
          await record(client, 0);
          await client.query(
            `UPDATE recruit_campaigns SET shortage_prompt_off_at = NOW(), shortage_prompt_off_by = $2 WHERE id = $1`,
            [d.campaignId, actor]);
          await client.query('COMMIT');
        } catch (e) { try { await client.query('ROLLBACK'); } catch (_) { /* noop */ } throw e; }
        finally { client.release(); }
      }
      results.push({ campaignId: d.campaignId, ok: true, choice: d.choice, title: it.title, shortage: it.shortage,
        amount, linkedSheetId: it.linkedSheetId, linkedTabName: it.linkedTabName,
        todayFrom: from, todayTo: d.choice === 'today' ? from + amount : from,
        // 작업보드 작업표 반영 결과(같은 저장 경로가 표의 줄도 맞춘다) — 실패 사유를 화면이 말한다
        worktable: _worktableNote(saved && saved.worktableSync) });
    } catch (e) {
      // ★ 계획과 결정 기록은 이미 커밋됐고 작업보드 갱신만 실패한 경우 — "반영됨 + 작업표 경고"로 말한다(코덱스 리뷰).
      //   실패로 말하면 다시 고를 길도 없다(결정 기록 때문에 목록에서 빠진다).
      if (e && e.code === 'worktable_projection_failed') {
        results.push({ campaignId: d.campaignId, ok: true, choice: d.choice, title: it.title, shortage: it.shortage,
          amount: null, linkedSheetId: it.linkedSheetId, linkedTabName: it.linkedTabName, todayFrom: it.todayQuota, todayTo: null,
          worktable: { ok: false, reason: '오늘 인원은 반영됐지만 작업보드 표 갱신에 실패했습니다 — 작업보드를 새로고침하거나 [📅 인원]에서 다시 저장해 주세요' } });
        continue;
      }
      // ★ 처리 기록 유니크 충돌만 "이미 처리됨" — 다른 유니크 충돌(작업표 줄 번호 등)은 일반 실패로 말한다(코덱스 리뷰)
      if (e && e.code === '23505' && e.constraint === 'uq_cpe_shortage_decision') {
        results.push({ campaignId: d.campaignId, ok: false, code: 'already_decided', reason: '다른 담당자가 방금 처리했습니다' });
        continue;
      }
      logger.warn(`[campaignShortage] 반영 실패 camp=${d.campaignId} choice=${d.choice}: ${e.message}`);
      results.push({ campaignId: d.campaignId, ok: false, reason: e.message, code: e.code || null });
    }
  }
  // ★ 오늘 인원을 바꿨으면 공고 목록 캐시를 비운다 — 안 비우면 반영 직후 다시 그린 카드가 옛 숫자를 보인다(코덱스 리뷰)
  if (results.some(r => r.ok && r.choice === 'today')) {
    try { const cr = require('../routes/campaign.routes'); if (cr && typeof cr.invalidateListCache === 'function') cr.invalidateListCache(); } catch (_) { /* 캐시 비우기 실패는 반영과 무관 */ }
  }
  return { ok: true, date: cur.date, results };
}

module.exports = { listShortages, applyDecisions, computeShortage, isRecipient, ACTION };
