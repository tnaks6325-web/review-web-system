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

/** dailyQuota — KST 일 시작 시점 고정 (§03-D). submittedBeforeToday = 전일까지의 누적확정 */
function dailyQuota(c, submittedBeforeToday) {
  const dl = Number(c.daily_limit) || 0;
  const rt = Number(c.recruit_total) || 0;
  if (rt <= 0) return dl; // 무제한 캠페인 가드(영구 daily_done 방지)
  return Math.max(0, Math.min(dl, rt - (Number(submittedBeforeToday) || 0)));
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
function computeCampaignState(c, counts, now = new Date()) {
  const base = { serverNow: now.toISOString() };
  if (!c || !c.participation_mode) return { ...base, state: 'legacy' };

  const quota = dailyQuota(c, counts.submittedBeforeToday);
  const todayCount = (Number(counts.todaySubmitted) || 0) + (Number(counts.todayActiveHolds) || 0);
  const opensAt = kstTodayAt(c.window_start, now);
  const closesAt = kstTodayAt(c.window_end, now);
  const bufferMin = Number(c.close_buffer_min ?? 10) || 0;
  const cutoffAt = closesAt ? new Date(closesAt.getTime() - bufferMin * 60 * 1000) : null;
  const payload = {
    ...base,
    todayCount,
    dailyQuota: quota,
    opensAt: opensAt ? opensAt.toISOString() : null,
    closesAt: closesAt ? closesAt.toISOString() : null,
    cutoffAt: cutoffAt ? cutoffAt.toISOString() : null,
  };

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
  const sd = dateOnlyStr(c.start_date);
  payload.startDate = sd;
  if (sd && kstTodayStr(now) < sd) {
    const openUtc = new Date(Date.parse(sd + 'T00:00:00+09:00') + (allDay ? 0 : startMin * 60000));
    return { ...payload, state: 'preopen', opensAt: openUtc.toISOString() };
  }

  const t = kstMinutesOfDay(now);
  if (!allDay && t < startMin) return { ...payload, state: 'preopen' };
  if (!allDay && t >= endMin) return { ...payload, state: 'daily_done' };

  if (todayCount >= quota) return { ...payload, state: 'daily_done' }; // 금일완료(홀드 만료 반환 시 open 복귀)

  const rt = Number(c.recruit_total) || 0;
  const usedAll = (Number(counts.submittedAll) || 0) + (Number(counts.activeHolds) || 0);
  if (rt > 0 && usedAll >= rt) return { ...payload, state: 'soft_full' }; // 잔여 대기 — 신청만 차단, 종착 아님

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
  for (const id of ids) {
    out.set(id, { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 });
  }
  if (!ids.length) return out;
  const dayStart = kstDayStartUtc(now).toISOString();
  const { rows } = await pool.query(
    `SELECT campaign_id,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW())                              AS active_holds,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW() AND applied_at >= $2)         AS today_active_holds,
            COUNT(*) FILTER (WHERE status='submitted')                                                     AS submitted_all,
            COUNT(*) FILTER (WHERE status='submitted' AND submitted_at >= $2)                              AS today_submitted,
            COUNT(*) FILTER (WHERE status='submitted' AND (submitted_at < $2 OR submitted_at IS NULL))     AS submitted_before_today
       FROM campaign_applications
      WHERE campaign_id = ANY($1)
      GROUP BY campaign_id`,
    [ids, dayStart]
  );
  for (const r of rows) {
    out.set(r.campaign_id, {
      activeHolds: Number(r.active_holds) || 0,
      todayActiveHolds: Number(r.today_active_holds) || 0,
      submittedAll: Number(r.submitted_all) || 0,
      todaySubmitted: Number(r.today_submitted) || 0,
      submittedBeforeToday: Number(r.submitted_before_today) || 0,
    });
  }
  return out;
}

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
    payAmount: Math.max(0, Number(opt.pay_amount) || 0),
    recruitTotal, dailyLimit,
    used, remaining, todayUsed, todayRemaining,
    status,
    selectable: status === 'open' && campOpen,
  };
}

module.exports = {
  computeCampaignState,
  fetchCampaignCounts,
  fetchOptionCounts,
  computeOptionView,
  dailyQuota,
  timeStrToMinutes,
  kstDayStartUtc,
  kstMinutesOfDay,
  kstTodayAt,
  kstTodayStr,
  dateOnlyStr,
  APPLY_BLOCK_REASON,
  KST_OFFSET_MS,
};
