'use strict';

/**
 * 시스템이 옮겨 적은 날짜별 계획 정리 — 1회성 정리 도구(결정 182 4단계 · 사용자 확정 2026-09-26).
 *
 * 배경: 결정 182 이전(D3-a)에는 공고를 만들 때 작업표의 날짜별 줄 수를 **모든 날짜에** 계획으로 옮겨 적었다
 *   (`작업표:` 작성자). 095 규율상 계획이 있는 날 = 그 값이 그날의 전부라, 그 날들은 일건수·이월 방식·주말 설정을
 *   바꿔도 반영되지 않는다. 줄 삭제 보충(`행삭제 이동:`·`행삭제 보충:`)도 같은 식으로 날을 고정했다.
 *   3단계부터 두 경로는 더 이상 적지 않으므로, 이미 적힌 값만 이 도구로 지운다.
 *
 * ★★ 대상(전부 만족해야 한다):
 *   ① 보관되지 않은 공고
 *   ② **내일 이후** 날짜 — 지난 날 계획은 이월(066)·보류(098) 계산의 기준선이라 지우면 이월 숫자가 바뀌고,
 *      오늘 계획을 지우면 **지금 모집 중인 오늘 정원이 갑자기 바뀐다** → 둘 다 남긴다(내일부터는 규칙이 정한다).
 *   ③ 작성자가 고른 종류의 시스템 접두 — 기본 `작업표:` 만. `행삭제` 는 kinds 로 명시할 때만.
 *      **사람이 정한 값·인트라넷 오더 휴무일(`오더휴무:`)은 절대 무접촉.**
 * ★★ 미리보기(confirm!==true)는 쓰기 0건 · 공고별로 지울 날짜와 **예상 종료일 변화**를 보여 준다.
 * ★ 실행은 서버가 **다시 골라** 교집합만, 조회 뒤 바뀐 값(인원·작성자)은 지우지 않는다(낙관적 조건).
 * ★ 지운 값은 campaign_plan_events(action='system_plan_cleanup')에 남겨 되돌릴 수 있게 한다.
 * ★ 지운 뒤 그 공고의 작업표 빈 줄 날짜를 규칙에 맞춘다(relayCampaignWorktable — 커밋 뒤 · 실패해도 정리는 유지).
 */

const pool = require('../db/pool');
const { logger } = require('../utils/logger');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

const KIND_PREFIXES = {
  worktable: ['작업표:'],
  rowDelete: ['행삭제 이동:', '행삭제 보충:'],
};

function _prefixesFor(kinds) {
  const ks = (Array.isArray(kinds) && kinds.length ? kinds : ['worktable']).filter(k => KIND_PREFIXES[k]);
  const out = [];
  for (const k of (ks.length ? ks : ['worktable'])) out.push(...KIND_PREFIXES[k]);
  return out;
}
function _kindOf(by) {
  const s = String(by || '');
  for (const [k, ps] of Object.entries(KIND_PREFIXES)) if (ps.some(p => s.startsWith(p))) return k;
  return null;
}
function _addDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

async function _findTargets(db, fromDate, prefixes) {
  const likes = prefixes.map((_, i) => `p.updated_by LIKE $${i + 2}`).join(' OR ');
  const { rows } = await db.query(
    `SELECT p.campaign_id, rc.title, rc.status,
            to_char(p.plan_date,'YYYY-MM-DD') AS date, p.planned_count, p.updated_by
       FROM campaign_daily_plans p
       JOIN recruit_campaigns rc ON rc.id = p.campaign_id
      WHERE rc.archived_at IS NULL
        AND p.plan_date >= $1::date
        AND (${likes})
      ORDER BY p.campaign_id, p.plan_date`,
    [fromDate, ...prefixes.map(p => p.replace(/[%_\\]/g, '\\$&') + '%')]);
  // SQL LIKE 뒤에 JS 로 한 번 더 — 접두가 정확히 맞는 것만(와일드카드 오해 차단)
  return rows.filter(r => prefixes.some(p => String(r.updated_by || '').startsWith(p)));
}

function _group(targets) {
  const byCamp = new Map();
  for (const t of targets) {
    if (!byCamp.has(t.campaign_id)) {
      byCamp.set(t.campaign_id, { campaignId: t.campaign_id, title: t.title || '', status: t.status || '', days: [] });
    }
    byCamp.get(t.campaign_id).days.push({
      date: t.date, count: Number(t.planned_count) || 0, updatedBy: t.updated_by, kind: _kindOf(t.updated_by),
    });
  }
  return [...byCamp.values()];
}

/** 미리보기용 — 지우기 전·후 예상 종료일(계산 실패는 null — 지어내지 않는다) */
async function _endDates(campaignId, dates) {
  try {
    const cp = require('./campaignPlan.service');
    const before = (await cp.previewPlanProjection(campaignId, {})).projection;
    const after = (await cp.previewPlanProjection(campaignId, { remove: dates })).projection;
    return { endBefore: (before && before.endDate) || null, endAfter: (after && after.endDate) || null };
  } catch (e) {
    return { endBefore: null, endAfter: null, endError: e.code || e.message };
  }
}

/**
 * @param {{confirm?:boolean, by?:string, today?:string, kinds?:string[], campaignIds?:string[]}} o
 *   kinds = ['worktable'](기본) | ['worktable','rowDelete'] · campaignIds = 이 공고들만(생략 = 전부)
 */
async function cleanupSystemPlans({ confirm = false, by = 'admin', today = '', kinds, campaignIds } = {}) {
  const todayStr = /^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))
    ? String(today) : require('./campaignState.service').kstTodayStr();
  const fromDate = _addDays(todayStr, 1);   // ★ 내일부터(위 ② 참고)
  const prefixes = _prefixesFor(kinds);
  const only = Array.isArray(campaignIds) && campaignIds.length ? new Set(campaignIds.map(String)) : null;
  const db = getPool();
  const targets = (await _findTargets(db, fromDate, prefixes)).filter(t => !only || only.has(String(t.campaign_id)));
  const campaigns = _group(targets);

  if (confirm !== true) {
    for (const c of campaigns) Object.assign(c, await _endDates(c.campaignId, c.days.map(d => d.date)));
    return { ok: true, dryRun: true, today: todayStr, from: fromDate, prefixes, campaigns, days: targets.length };
  }

  let removed = 0;
  const failed = [];
  for (const camp of campaigns) {
    const client = await db.connect();
    let done = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [camp.campaignId]);
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
           VALUES ($1, $2, 'system_plan_cleanup', $3::jsonb)`,
          [camp.campaignId, String(by).slice(0, 100), JSON.stringify({ removed: done, from: fromDate })]);
      }
      await client.query('COMMIT');
    } catch (e) {
      done = [];
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      logger.warn(`[systemPlanCleanup] ${camp.campaignId} 정리 실패: ${e.message}`);
      failed.push({ campaignId: camp.campaignId, title: camp.title, error: e.message });
    } finally {
      client.release();
    }
    camp.removed = done.length;
    removed += done.length;
    if (done.length) {
      // 커밋 뒤 — 작업표 빈 줄 날짜를 규칙에 맞춘다(절대 throw 없음 · 실패해도 정리는 유지 · 새벽 실행이 다시 맞춘다)
      camp.worktableRelay = await require('./campaignPlan.service')
        .relayCampaignWorktable(camp.campaignId, { by: `system-plan-cleanup:${by}` });
    }
  }
  logger.info(`[systemPlanCleanup] 시스템 계획 정리 ${removed}건 (공고 ${campaigns.length}개, 실패 ${failed.length})`);
  return { ok: true, dryRun: false, today: todayStr, from: fromDate, prefixes, campaigns, days: targets.length, removed, failed };
}

module.exports = { cleanupSystemPlans, KIND_PREFIXES, __setPoolForTest };
