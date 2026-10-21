/**
 * 무시트 작업표의 **택배송장 칸 맞추기**(결정 263 7단계-④ ⑤ · 사용자 확정 2026-10-21 「1.나」).
 *
 * 배경: 송장 칸은 접수 때 작업오더가 택배발송대행이면 붙는다(`worktablePlan` — 옛 판 `택배송장번호` 맨 뒤 · 새 판 `송장번호` 비고 뒤).
 *   접수 뒤 배송을 바꾸는 양방향 저장(`sharedPatch._projectDeliveryInTx`)이 그 칸을 따라 맞춘다.
 *     · 택배발송대행으로 들어감 → 칸이 없으면 더한다(빈 칸 · 업체가 송장을 적는다).
 *     · 택배발송대행에서 나옴 → **송장이 하나도 없을 때만** 뺀다. 줄 값이나 업체·직원이 적은 송장(편집 기록)이 하나라도 있으면 그대로 둔다(지우지 않는다).
 * ★ 칸 이름·자리는 접수 경로와 같은 것을 쓴다(사본 금지 — `worktablePlan` 상수 · 분류기 `classifyHeaders`).
 * ★ 쓰기 표면 = `raw_sheet_tabs.headers/detected_headers` + (뺄 때) `campaign_participants.row_json` 의 그 키 — 배송 부속 칸(worktableDeliveryColumn)과 같다.
 * ★ 장부 재생성과 같은 잠금을 잡고, 끝나면 장부를 다시 만든다. 다른 살아 있는 공고와 같이 쓰는 탭은 건드리지 않는다.
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { isTrackingHeader } = require('../utils/trackingColumn');
const { classifyHeaders } = require('../utils/worktableTemplate');

const V1_HEADER = '택배송장번호';   // worktablePlan COURIER_PROXY_TRACKING_HEADER
const V2_HEADER = '송장번호';       // worktablePlan V2_COURIER_PROXY_TRACKING_HEADER

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

const _str = v => String(v == null ? '' : v).trim();

/** 송장 칸인가 — 옛 판 정규식(업체 편집 게이트와 같은 단일 출처) 또는 새 판 분류(tracking_number). */
function trackingHeaders(headers) {
  const roles = classifyHeaders(headers, {});
  return headers.filter((h, i) => isTrackingHeader(h) || (roles[i] && roles[i].role === 'tracking_number'));
}

/** 더할 자리 — 새 판은 비고(memo) 뒤(접수 경로 placeV2TrackingColumn 과 같은 자리), 옛 판·못 찾음은 맨 뒤. */
function withTrackingColumn(headers, v2) {
  const name = v2 ? V2_HEADER : V1_HEADER;
  const next = headers.slice();
  if (v2) {
    const roles = classifyHeaders(next, {});
    const at = roles.findIndex(r => r && r.role === 'memo');
    if (at >= 0) { next.splice(at + 1, 0, name); return { headers: next, name }; }
  }
  next.push(name);
  return { headers: next, name };
}

/**
 * @param {{sheetId:string, tabName:string, enable:boolean, by?:string}} p
 * @returns {Promise<{ok:boolean, action:string, reason?:string, header?:string}>}
 */
async function syncTrackingColumn({ sheetId, tabName, enable, by = 'system' } = {}) {
  if (!sheetId || !tabName) return { ok: false, action: 'none', reason: 'bad_request' };
  const db = getPool();
  const { rows: tc } = await db.query(
    `SELECT tab_gid, COALESCE(sheetless, FALSE) AS sheetless, workboard_schema_version FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`,
    [sheetId, tabName]);
  if (!tc.length || !tc[0].sheetless) return { ok: true, action: 'none', reason: 'not_sheetless' };
  const { rows: shared } = await db.query(
    `SELECT COUNT(*)::int AS n FROM recruit_campaigns WHERE participation_mode AND status = 'active' AND archived_at IS NULL AND linked_sheet_id = $1 AND linked_tab_name = $2`,
    [sheetId, tabName]);
  if (Number(shared[0] && shared[0].n) > 1) return { ok: true, action: 'none', reason: 'shared_worktable' };
  const tabGid = _str(tc[0].tab_gid);
  const v2 = Number(tc[0].workboard_schema_version) === 2;

  const client = await db.connect();
  let next = null, action = 'none', reason = '', header = '';
  try {
    await client.query('BEGIN');
    // 장부 재생성과 **같은 락** — 재생성 도중 헤더가 바뀌면 표가 한 칸씩 밀린다.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sheetless_ledger:${sheetId}:${tabName}`]);
    const { rows: rt } = await client.query(
      `SELECT detected_headers, headers FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1 FOR UPDATE`, [sheetId, tabGid]);
    const { rows: parts } = await client.query(
      `SELECT id, seq, row_json FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL ORDER BY seq FOR UPDATE`, [sheetId, tabName]);
    const { resolveHeaders } = require('./sheetlessLedger.service');
    const { headers: cur } = resolveHeaders({ storedHeaders: rt[0] && (rt[0].detected_headers || rt[0].headers), columns: null, rows: parts });
    if (!cur.length) { await client.query('ROLLBACK'); return { ok: true, action: 'none', reason: 'no_headers' }; }
    const have = trackingHeaders(cur);
    if (enable) {
      if (have.length) reason = 'already_has_column';
      else {
        const r = withTrackingColumn(cur, v2);
        next = r.headers; header = r.name; action = 'added';
      }
    } else if (!have.length) reason = 'no_column';
    else {
      // 송장이 하나라도 있으면(줄 값 · 되돌리지 않은 편집 기록) 칸을 남긴다 — 이미 적힌 송장을 지우지 않는다(사용자 확정 기본값 2026-10-21)
      const filled = parts.some(p => have.some(h => _str((p.row_json || {})[h])));
      let edited = false;
      if (!filled) {
        const { rows: ed } = await client.query(
          `SELECT 1 FROM participant_edits WHERE sheet_id = $1 AND tab_name = $2 AND field = ANY($3::text[]) AND reverted_at IS NULL
             AND NULLIF(btrim(COALESCE(value_text, '')), '') IS NOT NULL LIMIT 1`, [sheetId, tabName, have.map(h => 'col:' + h)]);
        edited = ed.length > 0;
      }
      if (filled || edited) { reason = 'has_values'; action = 'kept'; }
      else {
        next = cur.filter(h => !have.includes(h)); header = have.join(','); action = 'removed';
        for (const p of parts) {
          const rj = p.row_json && typeof p.row_json === 'object' ? p.row_json : {};
          if (!have.some(h => Object.prototype.hasOwnProperty.call(rj, h))) continue;
          await client.query(`UPDATE campaign_participants SET row_json = row_json - $2::text[], updated_at = NOW() WHERE id = $1`, [p.id, have]);
        }
      }
    }
    if (next) {
      const { rowCount } = await client.query(
        `UPDATE raw_sheet_tabs SET headers = $3::jsonb, detected_headers = $3::jsonb, col_count = $4 WHERE sheet_id = $1 AND tab_gid = $2`,
        [sheetId, tabGid, JSON.stringify(next), next.length]);
      if (!rowCount) logger.warn(`[trackingColumn] raw_sheet_tabs 행 없음 — 재생성이 헤더를 만든다 ${sheetId}/${tabName}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally { client.release(); }

  if (next) {
    try {
      const { rebuildLedgers } = require('./sheetlessLedger.service');
      await rebuildLedgers({ sheetId, tabName, columns: next, dryRun: false, by: `trackingcol:${by}` });
    } catch (e) { logger.warn(`[trackingColumn] 장부 재생성 실패 ${sheetId}/${tabName}: ${e.message}`); }
  }
  logger.info(`[trackingColumn] ${sheetId}/${tabName} 송장 칸 ${action}${header ? ' ' + header : ''}${reason ? ' (' + reason + ')' : ''} by=${by}`);
  return { ok: true, action, reason: reason || undefined, header: header || undefined };
}

module.exports = { syncTrackingColumn, trackingHeaders, withTrackingColumn, __setPoolForTest, V1_HEADER, V2_HEADER };
