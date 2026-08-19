/**
 * worktableDupWatch.service.js — 작업표 중복 줄 감시망 (2026-08-19)
 *
 * ★★ 왜 필요한가: 같은 구매가 표에 여러 줄로 늘어나는 사고(권정현 11줄)를 **아무도 몰랐다**.
 *   사람이 표를 보다 우연히 발견했다. 기록 경로의 방어(`sheetlessOrder` 2차 중복 판정)가
 *   최종 방어이지만, **그 방어가 또 뚫려도 알 길이 없는 상태**를 없앤다.
 *
 * ★ 판정을 **새로 만들지 않는다** — 표 주문번호는 `utils/tableOrderNum` 공유 조각(중복 정리·주문
 *   기록과 같은 값), "같은 구매"는 그 번호 + 명의(phone8)로 본다(중복 방어와 같은 키).
 * ★ **읽기 전용** — 줄을 내리지도 주문을 취소하지도 않는다. 사람에게 알리기만 한다.
 * ★ 대상은 **무시트 탭만** — 시트 기반 탭은 시트가 진실원본이라 같은 번호가 여러 줄인 것이
 *   담당자의 의도일 수 있고, 이 사고의 발생 경로(작업표 빈 슬롯 소비)도 무시트 전용이다.
 * ★ **늑대소년 방지** — 같은 상태가 이어지면 매 주기 알리지 않는다. 직전 스냅샷과 **달라졌을 때만**
 *   알린다(`app_settings.worktable_dup_watch`).
 */
const { tableOrderNumSql, MIN_ORDER_NUM_DIGITS } = require('../utils/tableOrderNum');
const { logger } = require('../utils/logger');

let _pool = null;
function getPool() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

const SETTING_KEY = 'worktable_dup_watch';
const GROUP_CAP = 200;          // 한 번에 보고할 묶음 상한(폭주 방지 — 초과는 건수로 고지)

/**
 * 같은 표 주문번호 + 같은 명의로 **살아있는 줄이 2개 이상**인 묶음을 찾는다. 읽기 전용.
 * ★ 무시트 탭만 · 표 주문번호가 판정 가능한(6자리 이상) 줄만 · 명의를 아는 줄만.
 *   모르는 것은 세지 않는다(빈 값끼리 뭉쳐 거짓 경보가 되는 것을 막는다).
 */
async function scanDuplicateRows({ limit = GROUP_CAP } = {}) {
  const db = getPool();
  const cap = Math.min(Math.max(parseInt(limit, 10) || GROUP_CAP, 1), 1000);
  const { rows } = await db.query(
    `SELECT cp.sheet_id AS "sheetId", cp.tab_name AS "tabName",
            ${tableOrderNumSql('cp')} AS "orderNum",
            cp.phone8,
            COUNT(*)::int AS rows,
            array_agg(cp.seq ORDER BY cp.seq) AS seqs,
            MIN(NULLIF(btrim(COALESCE(cp.recipient_name, '')), '')) AS name
       FROM campaign_participants cp
       JOIN tab_configs tc
         ON tc.sheet_id = cp.sheet_id AND tc.tab_name = cp.tab_name
        AND COALESCE(tc.sheetless, FALSE) = TRUE
      WHERE cp.deleted_at IS NULL
        AND length(COALESCE(cp.phone8, '')) >= 8
        AND length(${tableOrderNumSql('cp')}) >= $2
      GROUP BY 1, 2, 3, 4
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, 1, 2
      LIMIT $1`, [cap + 1, MIN_ORDER_NUM_DIGITS]);
  const capped = rows.length > cap;
  const groups = capped ? rows.slice(0, cap) : rows;
  const byTab = new Map();
  let extraRows = 0;
  for (const g of groups) {
    const k = `${g.sheetId} ${g.tabName}`;
    const cur = byTab.get(k) || { sheetId: g.sheetId, tabName: g.tabName, groups: 0, extraRows: 0 };
    cur.groups += 1; cur.extraRows += (g.rows - 1);   // 남길 한 줄을 뺀 나머지가 곧 군더더기
    byTab.set(k, cur);
    extraRows += (g.rows - 1);
  }
  return { ok: true, groups, tabs: [...byTab.values()], groupCount: groups.length, extraRows, capped };
}

/** 스냅샷 지문 — 탭·번호·명의·줄수까지 같아야 "그대로"로 본다(줄이 하나 더 늘면 다시 알린다). */
function fingerprint(groups) {
  return (groups || [])
    .map(g => `${g.sheetId} ${g.tabName} ${g.orderNum} ${g.phone8} ${g.rows}`)
    .sort().join('\n');
}

async function _loadSnapshot(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [SETTING_KEY]);
    if (!rows.length) return null;
    const v = rows[0].value;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (_) { return null; }   // ★ 못 읽으면 "달라졌다"로 본다 — 놓치는 쪽보다 한 번 더 알리는 쪽.
}

async function _saveSnapshot(db, snap) {
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [SETTING_KEY, JSON.stringify(snap)]);
  } catch (e) { logger.warn(`[dupWatch] 스냅샷 저장 실패(무시): ${e.message}`); }
}

/**
 * 감시 1회 — 찾고, **달라졌을 때만** 알린다.
 * ★ 절대 throw 하지 않는다(크론 보호). 실패는 사유를 담아 돌려준다.
 * @param {boolean} record  스냅샷 갱신 여부(크론=true, 사람이 눌러 보는 조회=false)
 */
async function watchDuplicateRows({ by = 'cron', record = true } = {}) {
  const db = getPool();
  let scan;
  try {
    scan = await scanDuplicateRows({});
  } catch (e) {
    logger.warn(`[dupWatch] 조회 실패: ${e.message}`);
    return { ok: false, reason: 'scan_failed', message: e.message };
  }
  const fp = fingerprint(scan.groups);
  const prev = await _loadSnapshot(db);
  const changed = !prev || prev.fingerprint !== fp;

  if (scan.groupCount > 0 && changed) {
    /* ★ 알림은 **한 건**으로 묶는다 — 묶음마다 띄우면 그 자체가 도배가 된다.
       ★ 리뷰어 비정상로그가 아니라 시스템 오류로그(warn) — 리뷰어 개인의 문제가 아니라
         데이터 정합 문제이고, 담당 스코프로 나눌 성질도 아니다. */
    const top = scan.tabs.slice(0, 10)
      .map(t => `${t.tabName}(묶음 ${t.groups} · 군더더기 ${t.extraRows}줄)`).join(' · ');
    try {
      require('./errorLog.service').logAbnormal({
        flow: 'cron', step: 'worktable_dup_watch', severity: 'warn',
        error: new Error(
          `작업표에 같은 구매가 여러 줄로 있습니다 — 묶음 ${scan.groupCount}개 · 군더더기 ${scan.extraRows}줄. ` +
          `${top}${scan.capped ? ' · (상한 초과분은 표시 생략)' : ''}`),
        context: {
          job: 'worktable_dup_watch', groups: scan.groupCount, extraRows: scan.extraRows,
          capped: scan.capped, tabs: scan.tabs.slice(0, 20),
        },
      });
    } catch (e) { logger.warn(`[dupWatch] 알림 기록 실패(무시): ${e.message}`); }
    logger.warn(`[dupWatch] 중복 묶음 ${scan.groupCount}개 · 군더더기 ${scan.extraRows}줄 — ${top}`);
  }

  if (record) {
    await _saveSnapshot(db, {
      fingerprint: fp, groupCount: scan.groupCount, extraRows: scan.extraRows,
      at: new Date().toISOString(), by: String(by).slice(0, 100),
    });
  }
  return { ok: true, groupCount: scan.groupCount, extraRows: scan.extraRows, capped: scan.capped,
           changed, alerted: scan.groupCount > 0 && changed, tabs: scan.tabs, groups: scan.groups };
}

module.exports = { scanDuplicateRows, watchDuplicateRows, fingerprint, SETTING_KEY, __setPoolForTest };
