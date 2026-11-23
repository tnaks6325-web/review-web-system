'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// 결정 395 — 인트라넷 작업담당 「랜덤」 작업오더를 리뷰웹이 만두·망고 중 한쪽으로 자동 배정한다(사용자 확정 2026-11-23).
//
// ★ 고르는 법: **진행 중 작업오더가 적은 쪽**. 같으면 **마지막 자동 배정의 반대쪽**(기록이 없으면 만두=박세희부터).
//   진행 중 = 지워지지 않음 · 상태가 완료(done)·반려(rejected)가 아님 · 보관된 모집공고(정·역방향 연결)가 아님 ·
//   🏁 마감 보관함(trackb_tab_finished — 홈 판정 finishedTabsMap/isTabFinishedIn 단일 출처)에 없음.
//   = 홈 「미지정 담당자 질문」(결정 311)의 진행 중 판정과 같은 갈래. 사람은 오더의 work_manager 를
//   mapWorkManager 로 읽는다(만두=박세희 · 망고=박은비 · 랜덤·기타·모르는 이름은 어느 쪽도 아님).
//   진행 부하를 모르면(마감 조회 실패 등) **추측하지 않고 배정하지 않는다** — 종전처럼 미지정으로 남는다.
// ★★ 쓰기는 기존 공유 저장 `sharedPatch.applySharedPatch({origin:'rw_manager', managerOnly:true})` 하나뿐이다
//   (결정 306 — L1·오더 행 잠금·완료 보호·조건부 버전 쓰기·스냅숏·담당자 범위 전송 대기가 그 안에 있다).
//   두 번째 담당자 UPDATE·별도 전송 대기를 만들지 않는다. 원본 번호(source_revision)는 건드리지 않는다.
// ★★ 경합: 미리 고른 값을 잠금 안에서 **다시 세어** 확인한다. 잠금 = pg_advisory_xact_lock(자동 배정 전용 한 키)을
//   공유 저장의 preHook(L1·행 잠금 뒤)에서 잡는다 — 동시에 들어온 둘은 여기서 한 줄로 서고, 뒤의 것은 앞의 것이
//   커밋한 배정을 보고 다시 센다. 다르면 쓰기 0 으로 물러나 처음부터 다시 고른다(최대 3번).
//   마지막 자동 배정 기록(app_settings 'auto_work_manager_last')은 managerCommitHook — **같은 트랜잭션**에 쓴다.
// ★ 접수·원본 수정의 **커밋 뒤**에 따로 돈다. 실패해도 접수 응답은 이미 나갔다(fail-soft — 경고 로그만,
//   오더는 종전처럼 「랜덤」= 미지정으로 남아 홈 질문·입금관리 미지정 줄이 그대로 잡는다).
// ═══════════════════════════════════════════════════════════════════════════
const getPool = () => require('../db/pool');
const { logger } = require('../utils/logger');
const { mapWorkManager, isExactUndecidedWorkManager } = require('../utils/workManager');

const ACTOR = '자동배정';
const LAST_KEY = 'auto_work_manager_last';
const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('auto_work_manager'))`;
const SIDES = ['박세희', '박은비'];          // 만두 · 망고 (인트라넷 원래 이름 — 공유 저장·전송이 쓰는 값)
const NICK_TO_SIDE = { '만두': '박세희', '망고': '박은비' };
const MAX_TRIES = 3;

/** 진행 중 작업오더 수 — { 박세희: n, 박은비: m }. 마감 조회를 못 하면 throw(추측 금지). */
async function countLoad(db) {
  const { rows } = await db.query(
    `SELECT w.work_manager, w.linked_tab_sheet_id, w.linked_tab_name, w.linked_tab_gid
       FROM work_orders w
      WHERE w.deleted_at IS NULL
        AND COALESCE(w.status, '') NOT IN ('done', 'rejected')
        AND NOT EXISTS (SELECT 1 FROM recruit_campaigns c WHERE c.archived_at IS NOT NULL
              AND (c.id = NULLIF(w.linked_campaign_id, '') OR NULLIF(c.source_work_order_id, '') = w.id))`);
  const tabs = require('./trackB.service');
  const fin = await tabs.finishedTabsMap(db);
  if (!fin.ok) throw new Error('마감 작업을 확인하지 못해 진행 중 작업 수를 셀 수 없습니다');
  const load = { '박세희': 0, '박은비': 0 };
  for (const r of rows) {
    const side = NICK_TO_SIDE[mapWorkManager(r.work_manager)];
    if (!side) continue;
    if (r.linked_tab_sheet_id && r.linked_tab_name
        && tabs.isTabFinishedIn(fin.map, r.linked_tab_sheet_id, r.linked_tab_name, r.linked_tab_gid)) continue;
    load[side] += 1;
  }
  return load;
}

/** 적은 쪽 · 같으면 마지막 자동 배정의 반대쪽(기록 없음 = 박세희). */
function pickSide(load, last) {
  const a = Number(load && load['박세희']) || 0, b = Number(load && load['박은비']) || 0;
  if (a < b) return '박세희';
  if (b < a) return '박은비';
  return String(last || '').trim() === '박세희' ? '박은비' : '박세희';
}

async function _decide(db) {
  const load = await countLoad(db);
  const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [LAST_KEY]);
  const last = rows[0] ? String(rows[0].value || '') : '';
  return { load, last, target: pickSide(load, last) };
}

/**
 * 한 오더를 자동 배정한다(지금 「랜덤」일 때만). 반환 = { applied, target?, reason, load? }. throw 하지 않는다.
 * @param {{ workOrderId: string, db?: object, reason?: string }} p  db = pool 모양({query, connect}) — 시험용
 */
async function autoAssignUndecided({ workOrderId, db, reason } = {}) {
  const pool = db || getPool();
  const { applySharedPatch } = require('./sharedPatch.service');
  let lastBody = null;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const { rows } = await pool.query(
      `SELECT id, work_manager, sync_version, source_review_order_id, status, deleted_at FROM work_orders WHERE id = $1`, [workOrderId]);
    const wo = rows[0];
    if (!wo || wo.deleted_at) return { applied: false, reason: 'not_found' };
    if (!isExactUndecidedWorkManager(wo.work_manager)) return { applied: false, reason: 'not_undecided' };
    if (!String(wo.source_review_order_id || '').trim()) return { applied: false, reason: 'unlinked' };
    let plan;
    try { plan = await _decide(pool); }
    catch (e) { return { applied: false, reason: 'load_unknown', error: e.message }; }
    const out = await applySharedPatch({
      db: pool,
      workOrderId: wo.id,
      mine: { work_manager: plan.target },
      baseVersion: Number(wo.sync_version || 0),
      origin: 'rw_manager',
      managerOnly: true,
      actor: ACTOR,
      // L1·오더 행 잠금 아래: 아직 랜덤인지 → 자동 배정 잠금 → 다시 세어 같은 쪽인지
      preHook: async (client, locked) => {
        if (!isExactUndecidedWorkManager(locked.work_manager)) {
          return { status: 409, body: { ok: false, code: 'auto_manager_not_needed', error: '이미 다른 담당자로 정해졌습니다.' } };
        }
        await client.query(LOCK_SQL);
        let again;
        try { again = await _decide(client); }
        catch (e) { return { status: 409, body: { ok: false, code: 'auto_manager_load_unknown', error: e.message } }; }
        if (again.target !== plan.target) {
          return { status: 409, body: { ok: false, code: 'auto_manager_recheck', error: '동시에 다른 자동 배정이 있어 다시 고릅니다.' } };
        }
        plan = again;
        return null;
      },
      managerCommitHook: async (client) => {
        await client.query(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [LAST_KEY, plan.target]);
      },
    });
    lastBody = out && out.body;
    if (out && out.status === 200 && out.body && out.body.ok && !out.body.noop) {
      return { applied: true, target: plan.target, load: plan.load, reason: reason || '', sync_version: Number(out.body.sync_version || 0) };
    }
    const code = String(out && out.body && out.body.code || '');
    if (code === 'auto_manager_not_needed') return { applied: false, reason: 'not_undecided' };
    // 동시 자동 배정·그 사이 다른 저장으로 버전이 바뀜 = 처음부터 다시 고른다. 그 밖(완료·연결 없음·비상 정지 등)은 그만둔다.
    if (code !== 'auto_manager_recheck' && code !== 'manager_version_conflict') {
      return { applied: false, reason: code || `http_${out && out.status}`, error: out && out.body && out.body.error };
    }
  }
  return { applied: false, reason: 'retry_exhausted', error: lastBody && lastBody.error };
}

const _inflight = new Set();
const QUIET = new Set(['not_undecided', 'not_found']);

/**
 * 커밋 뒤에 자동 배정을 건다(기다리지 않는다 · 절대 throw 하지 않는다). 호출부 응답은 바뀌지 않는다.
 * @returns {Promise<object>} 시험·로그용 결과
 */
function scheduleAutoAssign(workOrderId, { reason = '' } = {}) {
  const p = new Promise(resolve => setImmediate(resolve))
    .then(() => autoAssignUndecided({ workOrderId, reason }))
    .then(out => {
      if (out.applied) {
        logger.info(`[order/auto-manager] ${workOrderId} 랜덤 → ${out.target} 자동 배정(${reason}) · 진행 중 박세희 ${out.load['박세희']} / 박은비 ${out.load['박은비']}`);
      } else if (!QUIET.has(out.reason)) {
        logger.warn(`[order/auto-manager] ${workOrderId} 자동 배정 안 함(${reason}) — ${out.reason}${out.error ? `: ${out.error}` : ''} · 미지정으로 남음`);
      }
      return out;
    })
    .catch(e => {
      logger.warn(`[order/auto-manager] ${workOrderId} 자동 배정 실패(${reason}) — 미지정으로 남음: ${e && e.message}`);
      return { applied: false, reason: 'error', error: e && e.message };
    })
    .finally(() => { _inflight.delete(p); });
  _inflight.add(p);
  return p;
}

/** 시험용 — 걸어 둔 자동 배정이 모두 끝날 때까지 기다린다. */
async function _drainForTest() {
  while (_inflight.size) await Promise.all([..._inflight]);
}

/** 원본 수정이 작업담당을 「정해진 값 → 랜덤」으로 바꿨는가(이미 랜덤·빈 값이던 오더는 소급하지 않는다). */
function changedToUndecided(before, after) {
  const prev = String(before == null ? '' : before).trim();
  return !!prev && !isExactUndecidedWorkManager(prev) && isExactUndecidedWorkManager(after);
}

module.exports = {
  ACTOR, LAST_KEY, SIDES,
  countLoad, pickSide, autoAssignUndecided, scheduleAutoAssign, changedToUndecided, _drainForTest,
};
