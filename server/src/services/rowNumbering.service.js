/**
 * rowNumbering.service.js — 작업표 `번호`·`담당자` 자동 채움 + 구매일자 기준 재번호
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 왜 필요한가(2026-08-19 「0729)위드프렌즈_면마스크」 실측):
 *   준비된 줄(작업표 생성 시 `planToSheetValues` 가 번호를 매긴 줄)을 다 쓰고 나면,
 *   주문이 들어올 때 `appendSlot` 이 **빈 `row_json` 으로** 줄을 이어붙인다. 매퍼
 *   (`mapOrderToSheetRow`)는 `번호`·`담당자` 칸을 **쓰지 않으므로**(둘 다 `null` 반환)
 *   그 줄은 영구히 번호·담당자가 빈칸으로 남았다.
 *
 * 무엇을 하는가:
 *   ① 그 탭의 활성 줄을 **구매일자 → 주문 제출 시각 → seq** 순으로 정렬해 `번호` 를 1..N 로 다시 매긴다
 *      (그래서 "8/18 이 145 번인데 아래에 8/5 주문건이 있으면 그 건이 위로 오고 145 가 146 이 된다")
 *   ② `담당자` 가 빈 줄에 `tab_configs.manager`(접수 때 만두/망고 매핑)를 **blank-only** 로 채운다
 *
 * ★★ **DB `seq` 는 건드리지 않는다** — 이유는 `utils/rowNumbering` 머리말 참조(주문·리뷰·입금·
 *   투영·오버레이 앵커가 전부 그 번호에 매달려 있다). 바꾸는 것은 `row_json` 의 표시 칸뿐이다.
 * ★★ **무시트 탭 전용**(fail-closed) — 시트 기반 탭은 10 분 투영(`importTabFromIndex`)이
 *   `row_json = EXCLUDED.row_json` 으로 통째 덮으므로, 여기서 고쳐 봤자 다음 주기에 되돌아간다.
 *   "고쳤는데 조용히 되돌아가는" 상태를 만들지 않기 위해 사유(`not_sheetless`)를 말하고 멈춘다.
 * ★★ 판정 사본 0 — 순서·칸 이름은 `utils/rowNumbering`, 날짜 칸은
 *   `campaignSchedule.findDateColumnIndex`, 파싱은 `utils/koreanDate.parseDateColumn`.
 * ★ 쓰기 표면은 `campaign_participants.row_json`(+ `updated_by/at`) **한 곳**뿐 —
 *   시트·주문 원장·장부·정원 어디에도 쓰지 않는다.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');
const pool = require('../db/pool');
const {
  numberColumnKey, managerColumnKey, computeRenumberPlan,
} = require('../utils/rowNumbering');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 한 번에 다루는 줄 수 상한 — 비정상 데이터로 트랜잭션이 폭발하는 것 방지. */
const MAX_ROWS = 5000;
/** 스윕 1회에 훑는 탭 수 상한. */
const SWEEP_TAB_CAP = 300;

/** 이 기능 전체 킬스위치 — 문제가 생기면 Railway 에서 `WORKTABLE_AUTO_NUMBER=0`. */
function enabled() { return process.env.WORKTABLE_AUTO_NUMBER !== '0'; }

/** row_json 키 모음(첫 줄 순서를 살리고, 뒤 줄에만 있는 키를 이어 붙인다). */
function _collectKeys(rows) {
  const keys = [];
  for (const r of rows) {
    const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : null;
    if (!rj) continue;
    for (const k of Object.keys(rj)) if (k && keys.indexOf(k) < 0) keys.push(k);
  }
  return keys;
}

/**
 * 한 탭의 번호·담당자를 다시 매긴다.
 *
 * @param {object} o
 * @param {string} o.sheetId · o.tabName
 * @param {boolean} [o.dryRun=false]  true = 쓰기 0, 계획만
 * @param {string}  [o.by='auto']
 * @param {object}  [o.client]        호출부의 트랜잭션 커넥션(주문 기록과 같은 tx 안에서 돌 때)
 * @returns {Promise<{ok:boolean, reason?:string, changed?:number, total?:number, sample?:Array}>}
 */
async function renumberTab({ sheetId, tabName, dryRun = false, by = 'auto', client = null } = {}) {
  if (!sheetId || !tabName) throw new Error('renumberTab: sheetId, tabName 필수');
  if (!enabled()) return { ok: false, reason: 'disabled' };
  const db = client || getPool();

  const { rows: tc } = await db.query(
    `SELECT COALESCE(sheetless, FALSE) AS sheetless, COALESCE(manager, '') AS manager
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tc.length) return { ok: false, reason: 'tab_not_registered' };
  /* ★ 시트 기반 탭은 거부 — 투영이 row_json 을 덮어 조용히 되돌아간다(위 머리말). */
  if (!tc[0].sheetless) return { ok: false, reason: 'not_sheetless' };
  const manager = String(tc[0].manager || '').trim();

  /* 활성 줄 + 그 줄의 주문 제출 시각.
     ★ 주문이 취소(soft-delete)된 줄은 시각을 쓰지 않는다 — 살아 있는 주문만 순서의 근거다. */
  const { rows } = await db.query(
    `SELECT p.id, p.seq, p.row_json, os.submitted_at AS submitted_at
       FROM campaign_participants p
       LEFT JOIN order_submissions os
              ON os.id = p.order_submission_id AND os.deleted_at IS NULL
      WHERE p.sheet_id = $1 AND p.tab_name = $2 AND p.deleted_at IS NULL AND p.active = TRUE
      ORDER BY p.seq
      LIMIT ${MAX_ROWS}`, [sheetId, tabName]);
  if (!rows.length) return { ok: true, changed: 0, total: 0, reason: 'empty' };

  const keys = _collectKeys(rows);
  const numKey = numberColumnKey(keys);
  const mgrKey = managerColumnKey(keys);
  /* 번호 칸도 담당자 칸도 없는 표라면 할 일이 없다 — 없는 칸을 새로 만들지 않는다
     (열 구성은 `설정 › 작업표 표준 열`이 정한다. 여기서 열을 만들면 두 곳이 열을 정하게 된다). */
  if (!numKey && !mgrKey) return { ok: true, changed: 0, total: rows.length, reason: 'no_target_column' };

  /* 구매일자 — 칸 찾기·파싱 모두 기존 단일 출처.
     ★★ `fallbackAnchor` 는 선택이 아니다: 작업표의 구매일자는 `M / D (요일)` 라 **연도가 하나도 없다**.
        앵커가 없으면 전 행 null 이 되어 재번호가 "전부 날짜 없음"으로 조용히 무너진다
        (탈시트 W2-b F-2 와 같은 자리). */
  let iso = rows.map(() => null);
  if (numKey) {
    const { findDateColumnIndex } = require('./campaignSchedule.service');
    const di = findDateColumnIndex(keys);
    if (di >= 0) {
      const dateKey = keys[di];
      const raw = rows.map(r => {
        const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
        return rj[dateKey] == null ? '' : String(rj[dateKey]);
      });
      const { parseDateColumn } = require('../utils/koreanDate');
      const kst = new Date(Date.now() + 9 * 3600 * 1000);
      iso = parseDateColumn(raw, { fallbackAnchor: { y: kst.getUTCFullYear(), m: kst.getUTCMonth() + 1 } });
    }
  }

  const plan = computeRenumberPlan(rows.map((r, i) => {
    const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
    return {
      id: r.id, seq: r.seq, iso: iso[i] || null, submittedAt: r.submitted_at || null,
      number: numKey ? rj[numKey] : '', manager: mgrKey ? rj[mgrKey] : '',
    };
  }), { manager, hasNumberCol: !!numKey, hasManagerCol: !!mgrKey });

  const sample = plan.changes.slice(0, 20).map(c => ({
    seq: c.seq, from: c.numberFrom || null, to: c.numberTo, manager: c.managerTo || undefined,
  }));
  if (dryRun) {
    return { ok: true, dryRun: true, total: rows.length, changed: plan.changes.length,
             numberColumn: numKey, managerColumn: mgrKey, manager: manager || null, sample };
  }
  if (!plan.changes.length) {
    return { ok: true, changed: 0, total: rows.length, numberColumn: numKey, managerColumn: mgrKey };
  }

  /* 한 문장으로 일괄 갱신 — 줄 수만큼 왕복하면 주문 1건마다 수백 왕복이 된다.
     ★ 바뀌는 줄만 실린다(계획이 이미 걸러냈다). ★ `번호`·`담당자` 두 칸 외에는 손대지 않는다. */
  const ids = plan.changes.map(c => c.id);
  const nums = plan.changes.map(c => c.numberTo);        // null = 이 줄은 번호 변경 없음
  const mgrs = plan.changes.map(c => c.managerTo);       // null = 담당자 변경 없음
  const { rowCount } = await db.query(
    `UPDATE campaign_participants p
        SET row_json = CASE WHEN u.mgr IS NULL THEN
                         CASE WHEN u.num IS NULL THEN COALESCE(p.row_json, '{}'::jsonb)
                              ELSE jsonb_set(COALESCE(p.row_json, '{}'::jsonb), ARRAY[$4::text], to_jsonb(u.num), TRUE) END
                       ELSE
                         CASE WHEN u.num IS NULL
                              THEN jsonb_set(COALESCE(p.row_json, '{}'::jsonb), ARRAY[$5::text], to_jsonb(u.mgr), TRUE)
                              ELSE jsonb_set(jsonb_set(COALESCE(p.row_json, '{}'::jsonb), ARRAY[$4::text], to_jsonb(u.num), TRUE),
                                             ARRAY[$5::text], to_jsonb(u.mgr), TRUE) END
                       END,
            updated_by = $6, updated_at = NOW()
       FROM (SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[]) AS t(id, num, mgr)) u
      WHERE p.id = u.id AND p.deleted_at IS NULL AND p.active = TRUE`,
    [ids, nums, mgrs, numKey || '번호', mgrKey || '담당자', String(by).slice(0, 100)]);

  return { ok: true, changed: rowCount, planned: plan.changes.length, total: rows.length,
           numberColumn: numKey, managerColumn: mgrKey, manager: manager || null, sample };
}

/**
 * 주문 기록 트랜잭션 안에서 부르는 자동 경로.
 * ★★ **SAVEPOINT 격리** — PG 는 실패한 쿼리 하나가 트랜잭션 전체를 abort(25P02) 시킨다.
 *   번호 매기기 때문에 **주문 기록이 통째로 죽으면 안 된다**(082 apply 규율과 같은 자리).
 * ★ 어떤 실패도 throw 하지 않는다 — 번호는 나중에 [🔢 번호 정리]로 다시 맞출 수 있지만,
 *   주문은 그 자리에서 잃으면 되돌릴 수 없다.
 */
async function renumberTabInTx(client, { sheetId, tabName, by = 'auto-order' } = {}) {
  if (!client || !enabled()) return { ok: false, reason: 'skipped' };
  try {
    await client.query('SAVEPOINT rn_renumber');
    const out = await renumberTab({ sheetId, tabName, by, client });
    await client.query('RELEASE SAVEPOINT rn_renumber');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK TO SAVEPOINT rn_renumber'); } catch (_) { /* noop */ }
    try { await client.query('RELEASE SAVEPOINT rn_renumber'); } catch (_) { /* noop */ }
    logger.warn(`[rowNumbering] 자동 번호 매기기 실패(주문 기록은 유지) tab=${tabName}: ${err.message}`);
    return { ok: false, reason: 'failed', message: err.message };
  }
}

/**
 * 무시트 탭 전체 소급 정리 — 관리자가 [미리보기] 후 실행한다.
 * ★ 실패한 탭이 나머지를 죽이지 않는다(건별 독립) — 사유를 그대로 보고한다.
 */
async function renumberAllSheetless({ dryRun = true, by = 'admin', limit = SWEEP_TAB_CAP } = {}) {
  const db = getPool();
  const cap = Math.min(Math.max(parseInt(limit, 10) || SWEEP_TAB_CAP, 1), SWEEP_TAB_CAP);
  const { rows: tabs } = await db.query(
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName"
       FROM tab_configs
      WHERE COALESCE(sheetless, FALSE) = TRUE
      ORDER BY sheet_id, tab_name
      LIMIT ${cap + 1}`);
  const truncated = tabs.length > cap;
  const list = tabs.slice(0, cap);
  const out = { ok: true, dryRun: !!dryRun, tabs: list.length, truncated, changedTabs: 0, changedRows: 0, failed: [], details: [] };
  for (const t of list) {
    try {
      const r = await renumberTab({ sheetId: t.sheetId, tabName: t.tabName, dryRun, by });
      if (r.ok && r.changed) { out.changedTabs++; out.changedRows += r.changed; }
      out.details.push({ tabName: t.tabName, changed: r.changed || 0, reason: r.reason || null });
    } catch (err) {
      out.failed.push({ tabName: t.tabName, message: err.message });
    }
  }
  return out;
}

module.exports = { renumberTab, renumberTabInTx, renumberAllSheetless, enabled, __setPoolForTest };
