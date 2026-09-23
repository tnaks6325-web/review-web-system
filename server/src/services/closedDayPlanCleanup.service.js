'use strict';

/**
 * 쉬는 날(주말·공휴일)에 시스템이 자동으로 적어 둔 모집 인원 정리 — 1회성 정리 도구(2026-09-23).
 *
 * 배경: 날짜별 계획(095)에 1명 이상이 저장된 날은 "사람이 연 날"로 읽혀 신청 관문이 연다
 *   (campaignWeekend.isWeekendClosedOn). 그런데 공고 발행 때 작업표 줄 수를 옮겨 적는 프리필
 *   (`작업표:`)과 줄 삭제 보충(`행삭제 이동:`·`행삭제 보충:`)이 **사람 확인 없이** 쉬는 날에 인원을
 *   적어 추석 모집이 열렸다. 앞으로는 두 경로가 쉬는 날에 적지 않고, 이미 적힌 값은 이 도구로 지운다.
 *
 * ★★ 대상(전부 만족해야 한다 — 하나라도 모르면 건드리지 않는다):
 *   ① 주말 제외 공고(skip_weekends=TRUE) · 보관되지 않음
 *   ② 오늘(KST) 이후 날짜 · 1명 이상
 *   ③ 작성자가 시스템(`작업표:` · `행삭제 이동:` · `행삭제 보충:` 접두) — **사람이 정한 값은 절대 무접촉**
 *   ④ 그날이 주말 또는 법정공휴일(판정 = isWeekendClosedOn, 계획 없이 판정 — 계획 자체가 정리 대상)
 * ★★ 미리보기(confirm!==true)는 쓰기 0건. 실행은 서버가 **다시 골라** 교집합만 지운다.
 * ★ 지운 값은 campaign_plan_events 에 남겨 되돌릴 수 있게 한다(action='closed_day_system_plan_cleanup').
 * ★ 작업표(작업보드) 줄은 건드리지 않는다 — 줄 정리는 [📅 인원]의 "공휴일 0명 확정" 버튼이 한다.
 */

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { isWeekendClosedOn, closedKindOn } = require('./campaignWeekend.service');
const { holidayName } = require('../utils/krHolidays');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

const SYSTEM_AUTHOR_PREFIXES = ['작업표:', '행삭제 이동:', '행삭제 보충:'];

function isSystemAuthor(by) {
  const s = String(by || '');
  return SYSTEM_AUTHOR_PREFIXES.some(p => s.startsWith(p));
}

async function _findTargets(db, todayStr) {
  const { rows } = await db.query(
    `SELECT p.campaign_id, rc.title, rc.skip_weekends,
            to_char(p.plan_date,'YYYY-MM-DD') AS date, p.planned_count, p.updated_by
       FROM campaign_daily_plans p
       JOIN recruit_campaigns rc ON rc.id = p.campaign_id
      WHERE rc.skip_weekends = TRUE
        AND rc.archived_at IS NULL
        AND p.plan_date >= $1::date
        AND p.planned_count > 0
        AND (p.updated_by LIKE '작업표:%' OR p.updated_by LIKE '행삭제 이동:%' OR p.updated_by LIKE '행삭제 보충:%')
      ORDER BY p.campaign_id, p.plan_date`, [todayStr]);
  return rows.filter(r => isSystemAuthor(r.updated_by)
    && isWeekendClosedOn({ skip_weekends: r.skip_weekends === true }, r.date, null));
}

function _group(targets) {
  const byCamp = new Map();
  for (const t of targets) {
    if (!byCamp.has(t.campaign_id)) byCamp.set(t.campaign_id, { campaignId: t.campaign_id, title: t.title || '', days: [] });
    const kind = closedKindOn({ skip_weekends: true }, t.date, null);
    byCamp.get(t.campaign_id).days.push({
      date: t.date, count: Number(t.planned_count) || 0, updatedBy: t.updated_by,
      kind, holidayName: kind === 'holiday' ? holidayName(t.date) : null,
    });
  }
  return [...byCamp.values()];
}

/**
 * @param {{confirm?:boolean, by?:string, today?:string}} o
 * @returns {Promise<{ok:true, dryRun:boolean, campaigns:Array, days:number, removed?:number}>}
 */
async function cleanupClosedDaySystemPlans({ confirm = false, by = 'admin', today = '' } = {}) {
  const todayStr = /^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))
    ? String(today) : require('./campaignState.service').kstTodayStr();
  const db = getPool();
  const targets = await _findTargets(db, todayStr);
  const campaigns = _group(targets);
  if (confirm !== true) {
    return { ok: true, dryRun: true, today: todayStr, campaigns, days: targets.length };
  }

  let removed = 0;
  const failed = [];
  for (const camp of campaigns) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [camp.campaignId]);
      const done = [];
      for (const d of camp.days) {
        // 조회 뒤 사람이 바꿨으면(작성자·인원 변경) 지우지 않는다 — 낙관적 조건.
        const r = await client.query(
          `DELETE FROM campaign_daily_plans
            WHERE campaign_id = $1 AND plan_date = $2::date
              AND planned_count = $3 AND updated_by = $4
          RETURNING planned_count`, [camp.campaignId, d.date, d.count, d.updatedBy]);
        if (r.rowCount) done.push(d);
      }
      if (done.length) {
        await client.query(
          `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail)
           VALUES ($1, $2, 'closed_day_system_plan_cleanup', $3::jsonb)`,
          [camp.campaignId, String(by).slice(0, 100), JSON.stringify({ removed: done })]);
      }
      await client.query('COMMIT');
      removed += done.length;
      camp.removed = done.length;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      logger.warn(`[closedDayPlanCleanup] ${camp.campaignId} 정리 실패: ${e.message}`);
      failed.push({ campaignId: camp.campaignId, title: camp.title, error: e.message });
    } finally {
      client.release();
    }
  }
  logger.info(`[closedDayPlanCleanup] 쉬는 날 시스템 인원 정리 ${removed}건 (공고 ${campaigns.length}개, 실패 ${failed.length})`);
  return { ok: true, dryRun: false, today: todayStr, campaigns, days: targets.length, removed, failed };
}

module.exports = { cleanupClosedDaySystemPlans, isSystemAuthor, SYSTEM_AUTHOR_PREFIXES, __setPoolForTest };
