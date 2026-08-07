/**
 * campaignPlan.service.js — 모집공고 날짜별 모집 계획(조절) + 차수(물량 추가) 원장 (migration 095)
 *
 * 배경(실사고): 업체 요청으로 "오늘은 20명만" 줄이면 시스템이 미달로 오해해 다음날 60명을
 * 자동 이월했고, "오늘만 +10명"은 반영할 수단 자체가 없었다. 해결 = 날짜별 계획표
 * (campaign_daily_plans — 조절 = 그날 계획 자체의 변경 → 자동 이월은 "계획 대비 자연 미달"에만)
 * + 차수 원장(campaign_rounds — 총량을 늘리는 유일한 창구).
 * 시안 = frontend/docs/모집인원조절_이월차수_와이어프레임.html (사용자 확정 3건).
 *
 * ★ 판정(정원 계산) 단일 출처는 campaignState.service 의 dailyQuota — 여기는 조회·저장만.
 * ★ 시트 일정 캠페인(063 파생)은 시트가 진실원본이라 저장을 거부한다(읽기 전용, 확정 ③).
 * ★ 총량 불변식: 차수가 있는 공고의 recruit_total 은 차수 합계로만 바뀐다(campaign.routes 의
 *   PUT/스코프 편집이 rowsLockRecruitTotal 로 직접 수정을 무시).
 * ★ 쓰기 표면 = campaign_daily_plans / campaign_rounds / campaign_plan_events /
 *   recruit_campaigns.recruit_total(차수 합계 동기화) 뿐 — 홀드·주문원장·시트 무접촉.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { kstTodayStr, dateOnlyStr, isCarryHold, heldCarry, fetchCampaignCounts } = require('./campaignState.service');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PLAN_ENTRIES = 120;   // 한 번에 저장 가능한 날짜 수(오붙임 방어)
const MAX_DAY_COUNT = 9999;     // 하루 인원 상식 상한
const MAX_ROUND_COUNT = 100000; // 차수 건수 상식 상한

/** 시트 일정(063)이 이 캠페인의 정원을 이끄는지 — 이끌면 화면 조절은 읽기 전용(확정 ③). */
async function _scheduleFor(camp) {
  try {
    const { deriveSchedules, scheduleFor, tabsOfCampaigns } = require('./campaignSchedule.service');
    const m = await deriveSchedules(pool, tabsOfCampaigns([camp]));
    const sch = scheduleFor(m, camp);
    const { isUsableSchedule } = require('./campaignState.service');
    return isUsableSchedule(sch) ? sch : null;
  } catch (e) {
    // 일정 판정 실패 = 일정 없음으로 취급하지 않고 "모름"을 올린다 — 모르면 조절을 열지 않는
    // 쪽이 안전(시트 일정 캠페인에 조절을 저장하면 적용도 안 되는 값이 쌓여 화면만 어긋난다).
    logger.warn('[campaignPlan] 시트 일정 판정 실패: ' + e.message);
    const err = new Error('시트 일정 판정에 실패했습니다 — 잠시 후 다시 시도해주세요.');
    err.code = 'schedule_unknown';
    throw err;
  }
}

async function _loadCampaign(campaignId) {
  const { rows } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) { const e = new Error('캠페인을 찾을 수 없습니다.'); e.code = 'not_found'; throw e; }
  return rows[0];
}

/** 오늘(KST) 사용량 = 오늘 확정 + 유효 홀드 — 오늘 계획의 하한(원칙 ⑤: 확정·진행분 아래로 못 줄임). */
async function _todayUsed(db, campaignId, dayStartUtcIso) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='submitted' AND submitted_at >= $2)                    AS today_submitted,
            COUNT(*) FILTER (WHERE status='applied' AND expires_at > NOW() AND applied_at >= $2) AS today_holds
       FROM campaign_applications WHERE campaign_id = $1`,
    [campaignId, dayStartUtcIso]);
  const r = rows[0] || {};
  return (Number(r.today_submitted) || 0) + (Number(r.today_holds) || 0);
}

/* ── 조회(모달 재료) ─────────────────────────────────────── */
async function getPlanOverview(campaignId) {
  const camp = await _loadCampaign(campaignId);
  if (!camp.participation_mode) { const e = new Error('참여형 공고만 인원 조절을 지원합니다.'); e.code = 'not_participation'; throw e; }
  const today = kstTodayStr();

  let schedule = null;
  try { schedule = await _scheduleFor(camp); } catch (_) { schedule = 'unknown'; }

  const [plansQ, roundsQ, eventsQ, byDateQ] = await Promise.all([
    pool.query(
      `SELECT to_char(plan_date,'YYYY-MM-DD') AS date, planned_count AS count, updated_by, updated_at
         FROM campaign_daily_plans WHERE campaign_id = $1 ORDER BY plan_date`, [campaignId]),
    pool.query(
      `SELECT round_no, slot_count, to_char(start_date,'YYYY-MM-DD') AS start_date, label, created_by, created_at
         FROM campaign_rounds WHERE campaign_id = $1 ORDER BY round_no`, [campaignId]),
    pool.query(
      `SELECT actor, action, detail, created_at FROM campaign_plan_events
        WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 30`, [campaignId]),
    // 날짜별 확정 수(KST) — 모달의 "그날 실제 채움" 표시 + 과거 날짜 참고용
    pool.query(
      `SELECT to_char(submitted_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS d, COUNT(*) AS n
         FROM campaign_applications
        WHERE campaign_id = $1 AND status = 'submitted' AND submitted_at IS NOT NULL
        GROUP BY 1`, [campaignId]),
  ]);
  const { kstDayStartUtc } = require('./campaignState.service');
  const todayUsed = await _todayUsed(pool, campaignId, kstDayStartUtc().toISOString());
  // 확정 총계는 별도 COUNT — byDateSubmitted 는 submitted_at 있는 행만 세므로(날짜별 표시용)
  // 합산으로 대신하면 수동확정 등 시각 없는 행이 빠져 "예상 종료일"이 뒤로 밀려 보인다.
  const { rows: allQ } = await pool.query(
    `SELECT COUNT(*) AS n FROM campaign_applications WHERE campaign_id = $1 AND status = 'submitted'`,
    [campaignId]);

  const byDateSubmitted = {};
  for (const r of byDateQ.rows) byDateSubmitted[r.d] = Number(r.n) || 0;
  // 이월 보류(098): 모드 + 잔량. ★ 잔량 계산 실패는 null — 화면이 "조회 실패"를 말한다(0 위장 금지).
  let carryHeld = null, carryAppliedSum = 0;
  if (isCarryHold(camp)) {
    try {
      const counts = (await fetchCampaignCounts(pool, [camp.id])).get(camp.id);
      const sums = await fetchCarryAppliedSums(pool, [camp.id]);
      if (sums !== null) {   // null = 반영 합계 모름 → 잔량도 모름(부풀린 숫자 금지 — 코드리뷰 M3)
        carryAppliedSum = sums.get(camp.id) || 0;
        carryHeld = heldCarry(camp, counts, today, carryAppliedSum);
      }
    } catch (e) {
      logger.warn('[campaignPlan] 보류 잔량 계산 실패(fail-soft): ' + e.message);
      carryHeld = null;
    }
  }

  const rounds = roundsQ.rows.map(r => ({
    roundNo: r.round_no, count: Number(r.slot_count) || 0, startDate: r.start_date,
    label: r.label || '', createdBy: r.created_by || '', createdAt: r.created_at,
  }));
  const roundsTotal = rounds.reduce((s, r) => s + r.count, 0);

  return {
    campaignId: camp.id,
    title: camp.title || '',
    status: camp.status,
    defaultDaily: Number(camp.daily_limit) || 0,
    recruitTotal: Number(camp.recruit_total) || 0,
    startDate: dateOnlyStr(camp.start_date),
    today,
    planEnabled: process.env.CAMPAIGN_DAILY_PLAN !== '0',
    // 이월 보류(098) — carryHeld: null=계산 불가(조회 실패·기준선 없음), 숫자=잔여 보류 인원
    carryMode: isCarryHold(camp) ? 'hold' : 'auto',
    carryHeld,
    carryAppliedSum,
    // 시트 일정 캠페인 = 읽기 전용(확정 ③). 'unknown' = 판정 실패(조절 잠금 + 사유 표시).
    scheduleDriven: schedule === 'unknown' ? null : !!schedule,
    scheduleDates: (schedule && schedule !== 'unknown')
      ? schedule.dates.map(d => ({ date: d.date, slots: d.slots })) : null,
    plans: plansQ.rows.map(r => ({
      date: r.date, count: Number(r.count) || 0, updatedBy: r.updated_by || '', updatedAt: r.updated_at,
    })),
    byDateSubmitted,
    todayUsed,
    submittedAll: Number(allQ[0] && allQ[0].n) || 0,
    rounds,
    roundsTotal,
    // 차수 합계 ≠ 총모집 = 드리프트(다른 창구가 총모집을 고친 흔적) — 화면이 경고한다.
    roundsDrift: rounds.length > 0 && roundsTotal !== (Number(camp.recruit_total) || 0),
    events: eventsQ.rows.map(r => ({ actor: r.actor || '', action: r.action, detail: r.detail || null, at: r.created_at })),
  };
}

/* ── 계획 저장 ───────────────────────────────────────────── */
/**
 * @param body { set: [{date, count}], remove: [date...], note? }
 *   set = 조절(업서트), remove = 조절 해제(기본 일건수로 복귀). note = 이력에 남길 처리 방식 설명
 *   (예: "8/6 40→20 · 빠진 20명: 남은 날 분산"). 분산의 결과 날짜들도 set 에 실려 온다 —
 *   서버는 날짜별 계획값만 저장하고, 연장/분산은 저장 시점에 계획 행으로 풀린 상태로 받는다
 *   (런타임 분기 최소화 — 시안의 확정 저장 계약).
 */
async function savePlans(campaignId, body, actor) {
  // ※ 킬스위치(CAMPAIGN_DAILY_PLAN=0)는 **판정만** 끈다 — 저장 원장은 유지해 재활성 시
  //   조절이 그대로 되살아난다(프론트가 planEnabled=false 로 저장을 잠가 실수 저장은 없다).
  const b = body || {};
  const rawSet = Array.isArray(b.set) ? b.set : [];
  const rawRemove = Array.isArray(b.remove) ? b.remove : [];
  if (!rawSet.length && !rawRemove.length) { const e = new Error('변경할 내용이 없습니다.'); e.code = 'empty'; throw e; }
  if (rawSet.length + rawRemove.length > MAX_PLAN_ENTRIES) { const e = new Error(`한 번에 ${MAX_PLAN_ENTRIES}일까지만 저장할 수 있습니다.`); e.code = 'too_many'; throw e; }

  const camp = await _loadCampaign(campaignId);
  if (!camp.participation_mode) { const e = new Error('참여형 공고만 인원 조절을 지원합니다.'); e.code = 'not_participation'; throw e; }
  // 확정 ③: 시트 일정 캠페인은 시트가 진실원본 — 저장 거부(적용도 안 되는 값이 쌓여 화면만 어긋남).
  const schedule = await _scheduleFor(camp);   // 판정 실패는 schedule_unknown throw(fail-closed)
  if (schedule) { const e = new Error('이 캠페인의 날짜별 정원은 시트에서 자동으로 읽어옵니다 — 조절은 시트에서(그날 행 수 변경) 해주세요.'); e.code = 'schedule_driven'; throw e; }

  const today = kstTodayStr();
  const seen = new Set();
  const set = rawSet.map(x => {
    const date = String((x && x.date) || '').trim();
    const count = Number(x && x.count);
    if (!DATE_RE.test(date)) { const e = new Error(`날짜 형식이 올바르지 않습니다: ${date}`); e.code = 'bad_date'; throw e; }
    if (date < today) { const e = new Error(`지난 날짜(${date})는 조절할 수 없습니다.`); e.code = 'past_date'; throw e; }
    if (!Number.isInteger(count) || count < 0 || count > MAX_DAY_COUNT) { const e = new Error(`인원 값이 올바르지 않습니다: ${date}`); e.code = 'bad_count'; throw e; }
    if (seen.has(date)) { const e = new Error(`같은 날짜가 두 번 들어 있습니다: ${date}`); e.code = 'dup_date'; throw e; }
    seen.add(date);
    return { date, count };
  });
  const remove = rawRemove.map(x => {
    const date = String(x || '').trim();
    if (!DATE_RE.test(date)) { const e = new Error(`날짜 형식이 올바르지 않습니다: ${date}`); e.code = 'bad_date'; throw e; }
    if (date < today) { const e = new Error(`지난 날짜(${date})의 조절 기록은 해제할 수 없습니다.`); e.code = 'past_date'; throw e; }
    if (seen.has(date)) { const e = new Error(`같은 날짜가 set/remove 양쪽에 있습니다: ${date}`); e.code = 'dup_date'; throw e; }
    seen.add(date);
    return date;
  });
  const note = String(b.note || '').slice(0, 500);

  // 이월 반영(098): 반영량을 이력 원장에 남겨 보류 잔량에서 차감한다 — 반영 자체는 위 set(계획
  // 얹기)이 수행하고, 이 값은 회계용. ★ 보류 공고에서만 의미(자동 공고에 기록하면 잔량 개념이 없다).
  let carryApply = 0;
  if (b.carryApply !== undefined && b.carryApply !== null) {
    carryApply = Number(b.carryApply);
    if (!Number.isInteger(carryApply) || carryApply <= 0 || carryApply > 100000) {
      const e = new Error('이월 반영량이 올바르지 않습니다.'); e.code = 'bad_carry'; throw e;
    }
    if (!isCarryHold(camp)) { const e = new Error('이월 보류 공고가 아닙니다 — 반영할 보류분이 없습니다.'); e.code = 'carry_not_hold'; throw e; }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 캠페인 행 잠금 — apply 게이트(잠금 후 재집계)와 직렬화: "오늘 정원 축소"와 "신청"이
    // 동시에 달리면 축소 하한(확정+홀드) 검사가 낡은 값을 보게 되는 write-skew 차단.
    await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);

    // 원칙 ⑤: 오늘 계획은 "오늘 확정 + 유효 홀드" 아래로 못 내린다(참여 취소는 이 기능의 일이 아님).
    // 해제(remove)로 기본값 복귀해도 결과가 하한 밑이면 같은 이유로 거부(모순된 화면 방지).
    const { kstDayStartUtc } = require('./campaignState.service');
    const todaySet = set.find(x => x.date === today);
    const todayRemove = remove.includes(today);
    if (todaySet || todayRemove) {
      const used = await _todayUsed(client, campaignId, kstDayStartUtc().toISOString());
      // 해제(remove)의 비교값은 기본 일건수 — 이월분을 계산에 안 넣어 보수적으로 거부될 수
      // 있으나(이월 포함 실정원 25 ≥ 사용 23 인데 dl 20 < 23 이라 거부) fail-closed 방향이고
      // 오류 문구가 사유(사용 수)를 말하므로 의도된 단순화다.
      const effective = todaySet ? todaySet.count : (Number(camp.daily_limit) || 0);
      if (effective < used) {
        const e = new Error(`오늘은 이미 ${used}명이 확정·진행 중이라 ${effective}명으로 줄일 수 없습니다.`);
        e.code = 'below_used'; e.floor = used; throw e;
      }
    }

    // ★★ 이월 반영 잔량 재검증(코드리뷰 M2 — 캠페인 행 잠금 **안**에서): 두 관리자가 동시에
    //   원클릭을 누르면 둘 다 낡은 잔량 H 를 들고 오는데, 첫 커밋이 carry_apply 를 남기므로
    //   두 번째는 여기서 잔량 0 을 다시 계산해 carry_stale 로 거부된다(이중 반영·원장 과차감 차단).
    //   ★ 잔량을 모르면(조회 실패) 반영을 거부한다(fail-closed — 모르는 채 원장에 기록하지 않는다).
    //   SAVEPOINT 격리(082 규율) — 재계산 쿼리 실패가 tx 전체를 abort 시키지 않게.
    if (carryApply > 0) {
      let held = null, sp = false;
      try { await client.query('SAVEPOINT cap_check'); sp = true; } catch (_) {}
      try {
        const counts = (await fetchCampaignCounts(client, [campaignId])).get(campaignId);
        const sums = await fetchCarryAppliedSums(client, [campaignId]);
        if (sums !== null) held = heldCarry(camp, counts, today, sums.get(campaignId) || 0);
        if (sp) await client.query('RELEASE SAVEPOINT cap_check');
      } catch (_) {
        if (sp) { try { await client.query('ROLLBACK TO SAVEPOINT cap_check'); } catch (_) {} }
        held = null;
      }
      if (held === null) {
        const e = new Error('보류 잔량을 확인하지 못해 반영할 수 없습니다 — 잠시 후 다시 시도해주세요.');
        e.code = 'carry_unknown'; throw e;
      }
      if (carryApply > held) {
        const e = new Error(`남은 보류 이월(${held}명)보다 많이 반영할 수 없습니다 — 다른 관리자가 방금 반영했을 수 있어요. 화면을 새로고침해주세요.`);
        e.code = 'carry_stale'; e.held = held; throw e;
      }
    }

    for (const x of set) {
      await client.query(
        `INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count, updated_by, updated_at)
         VALUES ($1, $2::date, $3, $4, NOW())
         ON CONFLICT (campaign_id, plan_date)
         DO UPDATE SET planned_count = EXCLUDED.planned_count, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [campaignId, x.date, x.count, actor || null]);
    }
    if (remove.length) {
      await client.query(
        `DELETE FROM campaign_daily_plans WHERE campaign_id = $1 AND plan_date = ANY($2::date[])`,
        [campaignId, remove]);
    }
    await client.query(
      `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, 'plan_save', $3)`,
      [campaignId, actor || null, JSON.stringify({ set, remove, note: note || undefined })]);
    if (carryApply > 0) {
      await client.query(
        `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, 'carry_apply', $3)`,
        [campaignId, actor || null, JSON.stringify({ amount: carryApply, note: note || undefined })]);
    }
    await client.query('COMMIT');
    logger.info(`[campaignPlan] ${actor || '?'} 가 공고 ${campaignId} 계획 저장 — set ${set.length} / remove ${remove.length}`);
    return { applied: set.length + remove.length };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

/* ── 차수(물량 추가) ─────────────────────────────────────── */
/**
 * 차수 추가 = 총량을 늘리는 유일한 창구. 첫 추가 시 기존 recruit_total(>0)을 1차(초도)로 흡수.
 * recruit_total 은 차수 합계로 동기화(캠페인 행 FOR UPDATE 안 — apply 정원 판정과 직렬화).
 */
async function addRound(campaignId, body, actor) {
  const b = body || {};
  const count = Number(b.count);
  if (!Number.isInteger(count) || count <= 0 || count > MAX_ROUND_COUNT) { const e = new Error('추가 건수가 올바르지 않습니다.'); e.code = 'bad_count'; throw e; }
  const startDate = String(b.startDate || '').trim();
  if (startDate && !DATE_RE.test(startDate)) { const e = new Error('시작일 형식이 올바르지 않습니다.'); e.code = 'bad_date'; throw e; }
  const label = String(b.label || '').trim().slice(0, 40);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
    if (!cRows.length) { const e = new Error('캠페인을 찾을 수 없습니다.'); e.code = 'not_found'; throw e; }
    const camp = cRows[0];
    if (!camp.participation_mode) { const e = new Error('참여형 공고만 차수를 지원합니다.'); e.code = 'not_participation'; throw e; }

    const { rows: rRows } = await client.query(
      'SELECT round_no, slot_count FROM campaign_rounds WHERE campaign_id = $1 ORDER BY round_no', [campaignId]);
    let rounds = rRows.map(r => ({ roundNo: r.round_no, count: Number(r.slot_count) || 0 }));

    // 첫 차수 추가 = 기존 총모집을 1차(초도)로 흡수. 총모집 0(무제한) 공고는 흡수할 초도가 없어
    // 추가분이 곧 1차가 되고 캠페인이 "무제한 → 총량 관리"로 전환된다(화면이 미리 고지).
    if (!rounds.length && (Number(camp.recruit_total) || 0) > 0) {
      await client.query(
        `INSERT INTO campaign_rounds (campaign_id, round_no, slot_count, start_date, label, created_by)
         VALUES ($1, 1, $2, $3::date, '초도', $4)`,
        [campaignId, Number(camp.recruit_total), dateOnlyStr(camp.start_date), actor || null]);
      rounds = [{ roundNo: 1, count: Number(camp.recruit_total) }];
    }

    const roundNo = rounds.length ? Math.max(...rounds.map(r => r.roundNo)) + 1 : 1;
    await client.query(
      `INSERT INTO campaign_rounds (campaign_id, round_no, slot_count, start_date, label, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [campaignId, roundNo, count, startDate || null, label || null, actor || null]);
    const newTotal = rounds.reduce((s, r) => s + r.count, 0) + count;
    await client.query('UPDATE recruit_campaigns SET recruit_total = $2, updated_at = NOW() WHERE id = $1', [campaignId, newTotal]);
    await client.query(
      `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, 'round_add', $3)`,
      [campaignId, actor || null, JSON.stringify({ roundNo, count, startDate: startDate || null, label: label || null, newTotal })]);
    await client.query('COMMIT');
    logger.info(`[campaignPlan] ${actor || '?'} 가 공고 ${campaignId} ${roundNo}차 +${count}건 — 총량 ${newTotal}`);
    // ★ status 동봉(코드리뷰 M1): 총원이 차면 closed 가 **영속**되어 있어(maybePersistClosed)
    //   차수를 추가해도 게시를 켜기 전에는 모집이 재개되지 않는다 — 자동 재오픈은 수동 마감
    //   (관리자 의도)과 구분할 수 없어 하지 않고, 화면이 이 값으로 "게시를 켜야 한다"를 말한다.
    return { roundNo, newTotal, status: camp.status };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 마지막 차수 제거(오등록 복구용). 초도(1차)는 제거 불가 — 차수 해체가 아니라 정정 수단.
 * 제거 후 총량이 이미 확정된 수 아래로 내려가면 거부(원칙 ①: 확정분은 건드리지 않는다).
 */
async function removeLastRound(campaignId, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
    if (!cRows.length) { const e = new Error('캠페인을 찾을 수 없습니다.'); e.code = 'not_found'; throw e; }
    const { rows: rRows } = await client.query(
      'SELECT round_no, slot_count FROM campaign_rounds WHERE campaign_id = $1 ORDER BY round_no', [campaignId]);
    if (rRows.length < 2) { const e = new Error('제거할 추가 차수가 없습니다(초도는 제거할 수 없습니다).'); e.code = 'no_round'; throw e; }
    const last = rRows[rRows.length - 1];
    const newTotal = rRows.slice(0, -1).reduce((s, r) => s + (Number(r.slot_count) || 0), 0);
    // ★ 유효 홀드도 사용량이다(Codex P1): 홀드는 confirmHoldInTx 가 정원 재검사 없이 submitted 로
    //   전환되므로, 확정만 세면 "제거 후 총량 < 확정+홀드"가 허용되어 총량 초과가 생긴다.
    const { rows: subQ } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'submitted')                                  AS submitted,
              COUNT(*) FILTER (WHERE status = 'applied' AND expires_at > NOW())              AS holds
         FROM campaign_applications WHERE campaign_id = $1`, [campaignId]);
    const used = (Number(subQ[0] && subQ[0].submitted) || 0) + (Number(subQ[0] && subQ[0].holds) || 0);
    if (newTotal < used) {
      const e = new Error(`이미 ${used}명이 확정·진행 중이라 ${last.round_no}차를 제거할 수 없습니다(제거 후 총량 ${newTotal}).`);
      e.code = 'below_confirmed'; throw e;
    }
    await client.query('DELETE FROM campaign_rounds WHERE campaign_id = $1 AND round_no = $2', [campaignId, last.round_no]);
    await client.query('UPDATE recruit_campaigns SET recruit_total = $2, updated_at = NOW() WHERE id = $1', [campaignId, newTotal]);
    await client.query(
      `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, 'round_remove', $3)`,
      [campaignId, actor || null, JSON.stringify({ roundNo: last.round_no, count: Number(last.slot_count) || 0, newTotal })]);
    await client.query('COMMIT');
    logger.info(`[campaignPlan] ${actor || '?'} 가 공고 ${campaignId} ${last.round_no}차 제거 — 총량 ${newTotal}`);
    return { removedRoundNo: last.round_no, newTotal };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 차수가 있는 공고인지(총모집 직접 수정 잠금 판정 — campaign.routes PUT/스코프 편집이 사용).
 * ★ fail-soft: 테이블 부재·조회 실패 = false(기존 동작 — 잠금은 부가 방어이지 기능 게이트가 아니다).
 */
async function roundsLockRecruitTotal(campaignId) {
  try {
    const { rows } = await pool.query('SELECT 1 FROM campaign_rounds WHERE campaign_id = $1 LIMIT 1', [campaignId]);
    return rows.length > 0;
  } catch (_) { return false; }
}

/**
 * 총모집 자가치유(Codex P1 — 잠금 검사↔UPDATE 사이 경합 봉합): 수정 저장이 "차수 없음"을 보고
 * recruit_total 을 썼는데 그 사이 첫 차수가 생겼으면, 차수 합계로 되돌린다. addRound 는 캠페인
 * 행 FOR UPDATE 안에서 합계를 쓰므로 이 보정과 어느 순서로 겹쳐도 같은 값(합계)으로 수렴한다.
 * ★ fail-soft: 실패 = 무보정(치유는 부가 방어 — 저장 자체를 죽이면 안 된다).
 * @returns 보정했으면 새 총량, 아니면 null
 */
async function repairRecruitTotalFromRounds(campaignId) {
  try {
    const { rows } = await pool.query(
      `UPDATE recruit_campaigns c
          SET recruit_total = s.total, updated_at = NOW()
         FROM (SELECT COALESCE(SUM(slot_count), 0)::int AS total, COUNT(*) AS n
                 FROM campaign_rounds WHERE campaign_id = $1) s
        WHERE c.id = $1 AND s.n > 0 AND c.recruit_total IS DISTINCT FROM s.total
        RETURNING s.total`, [campaignId]);
    return rows.length ? Number(rows[0].total) : null;
  } catch (_) { return null; }
}

/**
 * 관리자 목록 카드용 차수 요약 일괄 조회 → Map(campaignId → [{roundNo, count, startDate, label}]).
 * ★ fail-soft: 실패 = 빈 Map(카드에 차수 줄만 안 뜸 — 목록은 뜬다).
 */
async function fetchRoundsSummary(db, campaignIds) {
  const out = new Map();
  const ids = (campaignIds || []).filter(Boolean);
  if (!ids.length) return out;
  try {
    const { rows } = await db.query(
      `SELECT campaign_id, round_no, slot_count, to_char(start_date,'YYYY-MM-DD') AS start_date, label
         FROM campaign_rounds WHERE campaign_id = ANY($1) ORDER BY campaign_id, round_no`, [ids]);
    for (const r of rows) {
      if (!out.has(r.campaign_id)) out.set(r.campaign_id, []);
      out.get(r.campaign_id).push({
        roundNo: r.round_no, count: Number(r.slot_count) || 0, startDate: r.start_date, label: r.label || '',
      });
    }
  } catch (e) {
    if (!(e && e.code === '42P01')) logger.warn('[campaignPlan] 차수 요약 조회 실패(fail-soft): ' + e.message);
  }
  return out;
}

/**
 * 이월 반영 누적 합(098) 일괄 조회 → Map(campaignId → 반영 합계) | **실패 시 null**.
 * ★★ 실패를 빈 Map 으로 접으면 호출부의 `|| 0`이 "반영 0"으로 오독해 **이미 반영한 인원까지
 *   잔량에 다시 잡힌다**(부풀린 칩 → 원클릭 이중 반영 유도 — 코드리뷰 M3). 모르면 null 을 돌려
 *   호출부가 잔량 자체를 null(계산 불가)로 수렴시킨다 — 숫자를 지어내지 않는다.
 *   detail.amount 는 우리가 정수로 기록하지만, 손상 행 방어로 숫자 형태만 합산한다.
 */
async function fetchCarryAppliedSums(db, campaignIds) {
  const out = new Map();
  const ids = (campaignIds || []).filter(Boolean);
  if (!ids.length) return out;
  try {
    const { rows } = await db.query(
      `SELECT campaign_id, SUM((detail->>'amount')::bigint) AS s
         FROM campaign_plan_events
        WHERE action = 'carry_apply' AND campaign_id = ANY($1)
          AND detail ? 'amount' AND detail->>'amount' ~ '^[0-9]+$'
        GROUP BY campaign_id`, [ids]);
    for (const r of rows) out.set(r.campaign_id, Number(r.s) || 0);
    return out;
  } catch (e) {
    if (!(e && e.code === '42P01')) logger.warn('[campaignPlan] 이월 반영 합계 조회 실패(→잔량 계산 불가): ' + e.message);
    return null;
  }
}

module.exports = {
  getPlanOverview,
  savePlans,
  addRound,
  removeLastRound,
  roundsLockRecruitTotal,
  // ★ 병합 중 유실 복구: 미export 면 campaign.routes 의 경합 자가치유가 TypeError→fail-soft 로
  //   조용히 무력화된다(회귀가드가 export 존재를 고정).
  repairRecruitTotalFromRounds,
  fetchRoundsSummary,
  fetchCarryAppliedSums,
};
