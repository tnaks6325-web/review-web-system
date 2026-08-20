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
const { numberColumnKey, computeRenumberPlan, filledSql } = require('../utils/rowNumbering');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 한 번에 다루는 줄 수 상한 — 비정상 데이터로 트랜잭션이 폭발하는 것 방지. */
const MAX_ROWS = 5000;
/** 스윕 1회에 훑는 탭 수 상한. */
const SWEEP_TAB_CAP = 300;

/**
 * "채워진 줄" 판정 — 주문이 붙었거나 사람 정보가 하나라도 있는 줄.
 * ★★ 조각은 `utils/rowNumbering.filledSql` **한 곳**이 만든다 — 스캔(집계)·정리(대상 선정)에
 *   더해 작업보드 [진행 현황] 참여자 게이지(JS `isFilledRow`)까지 같은 기준을 봐야 한다.
 *   여기에 사본을 되살리면 "게이지는 134명인데 정리는 다른 줄을 빈 줄로 본다" 가 된다.
 */
const FILLED_SQL = filledSql('p');

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
    `SELECT p.id, p.seq, p.row_json, os.submitted_at AS submitted_at,
            ${FILLED_SQL} AS filled
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
  /* KST 오늘 — ⑤ "지나간 날짜의 빈 줄은 맨 아래" 판정 기준.
     ★ 판정 자체는 `utils/rowNumbering` 이 하고 여기서는 **오늘 날짜만** 넘긴다(판정 사본 0). */
  const _kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const todayIso = _kstNow.toISOString().slice(0, 10);

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
      iso = parseDateColumn(raw, { fallbackAnchor: { y: _kstNow.getUTCFullYear(), m: _kstNow.getUTCMonth() + 1 } });
    }
  }

  const plan = computeRenumberPlan(rows.map((r, i) => {
    const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
    return {
      id: r.id, seq: r.seq, iso: iso[i] || null, submittedAt: r.submitted_at || null,
      number: rj[numKey], filled: r.filled === true,
    };
  }), { hasNumberCol: true, today: todayIso });

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
async function renumberAllSheetless({ dryRun = true, by = 'admin', limit = SWEEP_TAB_CAP, cleanBlanks = false } = {}) {
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
  const out = { ok: true, dryRun: !!dryRun, tabs: list.length, truncated, changedTabs: 0, changedRows: 0,
                blankTabs: 0, blankRows: 0, failed: [], details: [] };
  for (const t of list) {
    try {
      /* ★★ 정리가 먼저 — 재번호가 번호를 유일하게 만들면 짝 신호가 사라진다(스윕과 같은 순서). */
      if (cleanBlanks) {
        try {
          const c = await cleanupPairedBlanks({ sheetId: t.sheetId, tabName: t.tabName, dryRun, by });
          if (c && c.ok && (dryRun ? c.matched : c.retired)) { out.blankTabs++; out.blankRows += (dryRun ? c.matched : c.retired); }
        } catch (e) { logger.warn(`[rowNumbering] 짝 빈 줄 정리 실패 tab=${t.tabName}: ${e.message}`); }
      }
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
    `WITH base AS (
       SELECT tc.sheet_id, tc.tab_name,
              COALESCE(NULLIF(btrim(tc.display_name), ''), tc.tab_name) AS display_name,
              p.id, btrim(COALESCE(n.val, '')) AS num,
              ${FILLED_SQL} AS filled
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
     ), marked AS (
       /* 같은 번호를 쓰는 줄 묶음에 **채워진 줄이 있는가** — 짝 빈 줄 판정의 근거.
          번호가 빈 줄끼리는 묶지 않는다(빈 번호는 짝을 정할 근거가 아니다). */
       SELECT b.*, bool_or(b.filled) FILTER (WHERE b.num <> '')
                     OVER (PARTITION BY b.sheet_id, b.tab_name, b.num) AS grp_filled
         FROM base b
     )
     SELECT sheet_id AS "sheetId", tab_name AS "tabName", display_name AS "displayName",
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE num = '')::int AS "blankNumber",
            /* 중복 번호 = 값 있는 줄 수 - 서로 다른 번호 수(= 같은 번호를 나눠 쓴 잉여 줄).
               중복 줄 정리 뒤 566,566,567,567 처럼 번호는 다 차 있는데 두 개씩인 표가 남는다.
               빈칸만 세면 그 표가 자동 스윕 대상에서 통째로 빠진다(실측 2026-08-19). */
            (COUNT(*) FILTER (WHERE num <> '')
             - COUNT(DISTINCT num) FILTER (WHERE num <> ''))::int AS "dupNumber",
            /* 짝 빈 줄 = 같은 번호를 쓰는 채워진 줄이 있는데 이 줄은 비어 있다(사용자 확정 조건). */
            COUNT(*) FILTER (WHERE NOT filled AND num <> '' AND grp_filled)::int AS "pairedBlank"
       FROM marked
      GROUP BY 1, 2, 3
      ORDER BY "pairedBlank" DESC, "blankNumber" DESC, "dupNumber" DESC, "tabName"
      LIMIT ${cap + 1}`,
    [NUMBER_KEYS.map(k => String(k).toLowerCase())]);
  const truncated = rows.length > cap;
  const items = rows.slice(0, cap);
  return {
    ok: true, truncated, tabs: items.length,
    needTabs: items.filter(r => r.blankNumber > 0 || r.dupNumber > 0 || r.pairedBlank > 0).length,
    blankNumberRows: items.reduce((s, r) => s + r.blankNumber, 0),
    dupNumberRows: items.reduce((s, r) => s + r.dupNumber, 0),
    pairedBlankRows: items.reduce((s, r) => s + r.pairedBlank, 0),
    items,
  };
}

/**
 * 짝 빈 줄 정리 — **채워진 줄과 번호가 겹치는 빈 줄만** 표에서 내린다(사용자 확정 2026-08-19).
 *
 * ★★ 왜 이 조건인가: 짝이 있다는 것 자체가 "그 자리는 이미 채워졌다"는 근거다. 날짜·모집량을
 *   보지 않으므로 **아직 안 팔린 미래 자리를 지우지 않는다**(모집 계획 파괴 금지).
 * ★★ **재번호보다 먼저 돌아야 한다** — 재번호가 번호를 1..N 로 유일하게 만들면 짝 신호가
 *   사라져 이 정리가 영영 성립하지 않는다(스윕 순서를 회귀가드가 고정한다).
 * ★ 지우는 것이 아니라 **내리는 것**(소프트) — 실행은 `sheetlessLedger.retireRows` 위임이라
 *   무시트 게이트·쓰기 소유자·"soft-delete → 장부 재생성" 순서 계약을 그대로 상속한다.
 * ★ fail-closed: 주문이 붙은 줄·이름/수취인/연락처가 있는 줄은 **조건에서 제외**(대상이 될 수 없다).
 */
async function cleanupPairedBlanks({ sheetId, tabName, dryRun = true, by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new Error('cleanupPairedBlanks: sheetId, tabName 필수');
  if (!enabled()) return { ok: false, reason: 'disabled' };
  const db = getPool();
  const { NUMBER_KEYS } = require('../utils/rowNumbering');
  const { rows } = await db.query(
    `WITH base AS (
       SELECT p.id, p.seq, btrim(COALESCE(n.val, '')) AS num, ${FILLED_SQL} AS filled
         FROM campaign_participants p
         LEFT JOIN LATERAL (
           SELECT p.row_json->>k AS val
             FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p.row_json) = 'object'
                                         THEN p.row_json ELSE '{}'::jsonb END) AS k
            WHERE lower(btrim(k)) = ANY($3::text[])
            LIMIT 1) n ON TRUE
        WHERE p.sheet_id = $1 AND p.tab_name = $2 AND p.deleted_at IS NULL AND p.active = TRUE
     ), marked AS (
       SELECT b.*, bool_or(b.filled) FILTER (WHERE b.num <> '') OVER (PARTITION BY b.num) AS grp_filled
         FROM base b
     )
     SELECT seq, num FROM marked
      WHERE NOT filled AND num <> '' AND grp_filled
      ORDER BY seq
      LIMIT ${MAX_ROWS}`,
    [sheetId, tabName, NUMBER_KEYS.map(k => String(k).toLowerCase())]);

  if (!rows.length) return { ok: true, matched: 0, retired: 0, dryRun: !!dryRun };
  const seqs = rows.map(r => Number(r.seq));
  const ledger = require('./sheetlessLedger.service');
  try {
    const r = await ledger.retireRows({ sheetId, tabName, seqs, dryRun: !!dryRun, by });
    return { ok: true, dryRun: !!dryRun, matched: seqs.length,
             retired: dryRun ? 0 : (r.retired || 0), sample: rows.slice(0, 10).map(x => ({ seq: Number(x.seq), number: x.num })),
             indexRows: r.indexRows, ledgerError: r.ledgerError };
  } catch (err) {
    /* 무시트 아님 등 게이트 거부는 사유를 그대로 올린다(조용한 성공 금지). */
    return { ok: false, reason: (err && err.code) || 'retire_failed', message: err && err.message, matched: seqs.length };
  }
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
  const need = (scan.items || []).filter(r => r.blankNumber > 0 || r.dupNumber > 0 || r.pairedBlank > 0);
  const targets = need.slice(0, limit);
  const out = { scanned: scan.tabs, need: need.length, tabs: targets.length,
                remaining: Math.max(0, need.length - targets.length), changedTabs: 0, changedRows: 0, failed: 0 };
  out.blankTabs = 0; out.blankRows = 0;
  for (const t of targets) {
    try {
      /* ★★ **정리가 먼저다** — 재번호가 번호를 1..N 로 유일하게 만들면 "채워진 줄과 겹치는 번호"라는
         짝 신호가 사라져 그 뒤로는 영영 정리되지 않는다(순서를 회귀가드가 고정한다).
         ★ 정리 실패는 재번호를 막지 않는다(둘은 독립된 일). */
      if (t.pairedBlank > 0) {
        try {
          const c = await cleanupPairedBlanks({ sheetId: t.sheetId, tabName: t.tabName, dryRun: false, by });
          if (c && c.ok && c.retired) { out.blankTabs++; out.blankRows += c.retired; }
        } catch (e) { logger.warn(`[rowNumbering] 짝 빈 줄 정리 실패 tab=${t.tabName}: ${e.message}`); }
      }
      const r = await renumberTab({ sheetId: t.sheetId, tabName: t.tabName, by });
      if (r && r.ok && r.changed) { out.changedTabs++; out.changedRows += r.changed; }
    } catch (err) {
      out.failed++;
      logger.warn(`[rowNumbering] 스윕 실패 tab=${t.tabName}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { renumberTab, renumberTabInTx, renumberAllSheetless, scanNumbering, cleanupPairedBlanks, sweepNumbering, enabled, __setPoolForTest };
