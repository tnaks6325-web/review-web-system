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
 *   그 탭의 활성 줄을 **구매일자 → 주문 제출 시각 → seq** 순으로 정렬해 `번호` 를 1..N 로 다시 매긴다
 *   (그래서 "8/18 이 145 번인데 아래에 8/5 주문건이 있으면 그 건이 위로 오고 145 가 146 이 된다").
 *
 * ★★ **`담당자` 칸은 건드리지 않는다**(사용자 확정 2026-08-19) — 담당자는 작업보드 좌측 상단
 *   [작업 조건]에 이미 표기되므로 줄마다 반복할 이유가 없다. 이미 적혀 있는 값도 그대로 둔다.
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
const { numberColumnKey, computeRenumberPlan } = require('../utils/rowNumbering');

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
    `SELECT COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tc.length) return { ok: false, reason: 'tab_not_registered' };
  /* ★ 시트 기반 탭은 거부 — 투영이 row_json 을 덮어 조용히 되돌아간다(위 머리말). */
  if (!tc[0].sheetless) return { ok: false, reason: 'not_sheetless' };

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
  /* 번호 칸이 없는 표라면 할 일이 없다 — 없는 칸을 새로 만들지 않는다
     (열 구성은 `설정 › 작업표 표준 열`이 정한다. 여기서 열을 만들면 두 곳이 열을 정하게 된다). */
  if (!numKey) return { ok: true, changed: 0, total: rows.length, reason: 'no_target_column' };

  /* 구매일자 — 칸 찾기·파싱 모두 기존 단일 출처.
     ★★ `fallbackAnchor` 는 선택이 아니다: 작업표의 구매일자는 `M / D (요일)` 라 **연도가 하나도 없다**.
        앵커가 없으면 전 행 null 이 되어 재번호가 "전부 날짜 없음"으로 조용히 무너진다
        (탈시트 W2-b F-2 와 같은 자리). */
  let iso = rows.map(() => null);
  {
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
      number: rj[numKey],
    };
  }), { hasNumberCol: true });

  const sample = plan.changes.slice(0, 20).map(c => ({ seq: c.seq, from: c.numberFrom || null, to: c.numberTo }));
  if (dryRun) {
    return { ok: true, dryRun: true, total: rows.length, changed: plan.changes.length,
             numberColumn: numKey, sample };
  }
  if (!plan.changes.length) {
    return { ok: true, changed: 0, total: rows.length, numberColumn: numKey };
  }

  /* 한 문장으로 일괄 갱신 — 줄 수만큼 왕복하면 주문 1건마다 수백 왕복이 된다.
     ★ 바뀌는 줄만 실린다(계획이 이미 걸러냈다). ★ **`번호` 칸 외에는 손대지 않는다.** */
  const ids = plan.changes.map(c => c.id);
  const nums = plan.changes.map(c => c.numberTo);
  const { rowCount } = await db.query(
    `UPDATE campaign_participants p
        SET row_json = jsonb_set(COALESCE(p.row_json, '{}'::jsonb), ARRAY[$3::text], to_jsonb(u.num), TRUE),
            updated_by = $4, updated_at = NOW()
       FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, num)) u
      WHERE p.id = u.id AND p.deleted_at IS NULL AND p.active = TRUE`,
    [ids, nums, numKey, String(by).slice(0, 100)]);

  return { ok: true, changed: rowCount, planned: plan.changes.length, total: rows.length,
           numberColumn: numKey, sample };
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

/**
 * 전체 무시트 작업 스캔 — **어느 작업에 번호·담당자 빈칸이 있는지**를 한 쿼리로 센다.
 *
 * ★★ 왜 dry-run 을 전 탭에 돌리지 않는가: `renumberTab({dryRun})` 은 그 탭의 **모든 줄과
 *   `row_json` 을 통째로 읽는다**. 무시트 작업이 수백 개면 수백 MB 를 끌어오게 되어
 *   조회 한 번이 서버를 흔든다. 그래서 목록은 **DB 안에서 세고 숫자만** 돌려준다
 *   (정밀 미리보기는 사람이 그 작업을 고를 때 종전 경로로 한 번만 돈다).
 * ★★ 칸 이름 후보는 `utils/rowNumbering` 의 목록을 **그대로 파라미터로** 넘긴다 —
 *   SQL 에 이름을 적어 두면 판정이 두 벌이 된다(같은 이유로 정규식도 그 목록에서 만든다).
 * ★ 읽기 전용(쓰기 쿼리 0) · 정렬 어긋남은 여기서 판정하지 않는다(날짜 파싱이 필요해 비싸다) —
 *   화면이 그 사실을 말하고, 정확한 변경 줄 수는 작업별 미리보기가 보여준다.
 */
async function scanNumbering({ limit = SWEEP_TAB_CAP } = {}) {
  const db = getPool();
  const cap = Math.min(Math.max(parseInt(limit, 10) || SWEEP_TAB_CAP, 1), SWEEP_TAB_CAP);
  const { NUMBER_KEYS } = require('../utils/rowNumbering');
  const { rows } = await db.query(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
            COALESCE(NULLIF(btrim(tc.display_name), ''), tc.tab_name) AS "displayName",
            COUNT(p.id)::int AS total,
            COUNT(p.id) FILTER (WHERE btrim(COALESCE(n.val, '')) = '')::int AS "blankNumber",
            /* 중복 번호 = 값 있는 줄 수 - 서로 다른 번호 수(= 같은 번호를 나눠 쓴 잉여 줄).
               중복 줄 정리 뒤 566,566,567,567 처럼 번호는 다 차 있는데 두 개씩인 표가 남는다.
               빈칸만 세면 그 표가 자동 스윕 대상에서 통째로 빠진다(실측 2026-08-19). */
            (COUNT(p.id) FILTER (WHERE btrim(COALESCE(n.val, '')) <> '')
             - COUNT(DISTINCT btrim(n.val)) FILTER (WHERE btrim(COALESCE(n.val, '')) <> ''))::int AS "dupNumber"
       FROM tab_configs tc
       JOIN campaign_participants p
         ON p.sheet_id = tc.sheet_id AND p.tab_name = tc.tab_name
        AND p.deleted_at IS NULL AND p.active = TRUE
       LEFT JOIN LATERAL (
         SELECT p.row_json->>k AS val
           FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p.row_json) = 'object'
                                       THEN p.row_json ELSE '{}'::jsonb END) AS k
          WHERE lower(btrim(k)) = ANY($1::text[])
          LIMIT 1) n ON TRUE
      WHERE COALESCE(tc.sheetless, FALSE) = TRUE
      GROUP BY 1, 2, 3
      ORDER BY "blankNumber" DESC, "dupNumber" DESC, "tabName"
      LIMIT ${cap + 1}`,
    [NUMBER_KEYS.map(k => String(k).toLowerCase())]);
  const truncated = rows.length > cap;
  const items = rows.slice(0, cap);
  return {
    ok: true, truncated, tabs: items.length,
    needTabs: items.filter(r => r.blankNumber > 0 || r.dupNumber > 0).length,
    blankNumberRows: items.reduce((s, r) => s + r.blankNumber, 0),
    dupNumberRows: items.reduce((s, r) => s + r.dupNumber, 0),
    items,
  };
}

/**
 * 주기 자동 스윕 — **번호가 빈 줄이 있는 작업만** 골라 다시 매긴다(크론).
 *
 * ★★ 왜 스캔부터 하는가: 전 탭에 재번호를 돌리면 그 탭의 모든 줄과 `row_json` 을 읽는다.
 *   대부분의 작업은 이미 정리돼 있으므로 **한 쿼리로 대상만 추려** 그것만 연다
 *   (정리가 끝난 뒤에는 매 사이클 쿼리 1번으로 끝난다).
 * ★ 사이클당 상한(`cap`) — 한 번에 다 돌면 업무 시간에 DB 를 흔든다. 남은 것은 다음 사이클이 맡는다.
 * ★ 건별 독립 — 한 작업의 실패가 나머지를 죽이지 않는다. 어떤 실패도 throw 하지 않는다(크론 보호).
 * ★★ 대상 = **번호 빈칸 또는 중복 번호**. "번호가 다 차 있고 중복도 없는데 순서만 어긋난" 작업만
 *   여기서 안 잡히는데, 그건 **주문이 들어올 때 그 자리에서** 다시 매겨지므로 쌓이지 않는다.
 */
async function sweepNumbering({ cap = 12, by = 'cron' } = {}) {
  if (!enabled()) return { skipped: true, reason: 'disabled' };
  const limit = Math.min(Math.max(parseInt(cap, 10) || 12, 1), 60);
  let scan;
  try { scan = await scanNumbering({}); }
  catch (err) {
    logger.warn(`[rowNumbering] 스윕 스캔 실패: ${err.message}`);
    return { skipped: true, reason: 'scan_failed', message: err.message };
  }
  /* ★ 빈칸뿐 아니라 **중복 번호**도 대상 — 중복 줄 정리 뒤 남는 `566,566,567,567…` 표는
       빈칸이 0 이라 종전 조건으로는 영영 안 잡혔다(실측). */
  const need = (scan.items || []).filter(r => r.blankNumber > 0 || r.dupNumber > 0);
  const targets = need.slice(0, limit);
  const out = { scanned: scan.tabs, need: need.length, tabs: targets.length,
                remaining: Math.max(0, need.length - targets.length), changedTabs: 0, changedRows: 0, failed: 0 };
  for (const t of targets) {
    try {
      const r = await renumberTab({ sheetId: t.sheetId, tabName: t.tabName, by });
      if (r && r.ok && r.changed) { out.changedTabs++; out.changedRows += r.changed; }
    } catch (err) {
      out.failed++;
      logger.warn(`[rowNumbering] 스윕 실패 tab=${t.tabName}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { renumberTab, renumberTabInTx, renumberAllSheetless, scanNumbering, sweepNumbering, enabled, __setPoolForTest };
