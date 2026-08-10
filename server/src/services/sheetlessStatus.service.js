/**
 * sheetlessStatus.service.js — 무시트 탭의 상태 칸 기록 (탈 구글시트 W3)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 왜 필요한가 — **재생성이 지우는 값** 이 있다.
 *
 *   무시트 탭의 장부(`review_index`)는 `sheetlessLedger.rebuildLedgers` 가
 *   **지우고 작업표에서 다시 만든다**. 그래서 시스템이 `review_index` 를 **직접 UPDATE** 한 값은
 *   **주문 한 건만 더 들어와도 통째로 증발**한다.
 *
 *     · 리뷰 제출 표시  `is_submitted = TRUE`      (submit.routes 캡처 제출 완료)
 *     · 입금 완료 표시  `is_submitted2 = 'PAID'`   (payment.routes 입금 완료 처리)
 *
 *   시트 기반 탭에서는 같은 값이 **시트 칸에도 써져서** 다음 빌드에 살아남는다.
 *   무시트 탭은 시트 쓰기가 막혀 있으므로(W2-a 4중 차단) **어디에도 안 남는다.**
 *
 * ★★ 해결 = 보존이 아니라 **작업표 칸에 쓴다**(진실원본 일원화).
 *   보존(스냅샷 복원)으로 처리하면 작업표에서 사람이 그 칸을 지워도 장부만 PAID 로 남아
 *   **작업표가 진실원본**이라는 W1 의 전제가 깨진다. 시트에 칸이 있는 값은 작업표 칸이 진실이다.
 *   (반대로 대표 리뷰 이미지처럼 **시트에 칸이 없는** 시스템 전용 값은 rebuildLedgers 가 보존한다.)
 *
 * ★★ 어느 칸이 리뷰제출·입금 열인가 = **파서가 감지해 둔 `review_index.submit_col/submit_col2`**
 *   판정 사본을 만들지 않는다. 그 값은 `parseTabRows` 가 그 탭에서 실제로 고른 헤더명이라,
 *   여기에 쓰면 다음 재생성 때 같은 파서가 그대로 읽어 낸다(왕복 일치가 구조적으로 보장).
 *
 * ★ 쓰는 값도 시트 경로와 같은 것을 쓴다 — 리뷰제출 `'O'`(Track B write-back 과 동일),
 *   입금은 호출부가 준 이체 시각 스탬프. 파서의 판정은 "값이 비어있지 않으면 참"이라
 *   형식이 달라도 판정은 같지만, **화면에 그대로 보이는 값**이므로 표기를 맞춘다.
 *
 * ★ fail-closed 가 아니라 **handled 신호**: 시트 기반 탭이면 `{handled:false}` 를 돌려주고
 *   호출부는 자기 기존 경로(시트 쓰기)를 그대로 탄다 — 기존 동작 무변경.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');
const pool = require('../db/pool');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 리뷰제출 칸에 쓰는 값 — Track B write-back(`_wantMark`)과 같은 표기 */
const SUBMIT_MARK = 'O';

/**
 * 무시트 탭의 상태 칸(리뷰제출·입금)에 값을 기록하고 장부를 다시 만든다.
 *
 * @param {object} o
 * @param {string} o.sheetId · o.tabName
 * @param {number} o.rowIndex            시트 실제 행 번호(= 작업표 seq)
 * @param {'submit'|'paid'} o.kind
 * @param {string} [o.value]             입금 스탬프 등. 미지정 시 kind 기본값
 * @param {string} [o.by='system']
 * @returns {Promise<{handled:boolean, ok?:boolean, reason?:string, column?:string}>}
 *   handled=false → 무시트 탭이 아님(호출부는 종전 경로 유지)
 */
async function markStatusCell({ sheetId, tabName, rowIndex, kind, value = '', by = 'system' } = {}) {
  if (!sheetId || !tabName || !rowIndex) return { handled: false };
  if (kind !== 'submit' && kind !== 'paid') return { handled: false };

  const db = getPool();

  // ── 무시트 판정은 단일 출처 ──
  let sheetless = false;
  try {
    sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName);
  } catch (_) {
    // 판정 실패 = 모른다 → 종전 경로(시트 쓰기)로 보낸다.
    // ★ 여기서 handled:true 로 접으면 시트 기반 탭의 입금 기록이 조용히 사라진다.
    return { handled: false };
  }
  if (!sheetless) return { handled: false };

  const col = kind === 'submit' ? 'submit_col' : 'submit_col2';
  const mark = String(value || '').trim() || (kind === 'submit' ? SUBMIT_MARK : '');
  if (!mark) return { handled: true, ok: false, reason: 'empty_value' };

  // ── 그 탭이 쓰는 상태 칸 헤더명(파서가 감지한 값) ──
  let header = '';
  try {
    const { rows } = await db.query(
      `SELECT ${col} AS h FROM review_index
        WHERE sheet_id = $1 AND tab_name = $2 AND COALESCE(${col}, '') <> ''
        LIMIT 1`, [sheetId, tabName]);
    header = rows.length ? String(rows[0].h || '').trim() : '';
  } catch (e) {
    return { handled: true, ok: false, reason: 'lookup_failed', message: e.message };
  }
  // ★ 조용히 성공으로 접지 않는다 — 그 작업표에 리뷰제출/입금 열이 없다는 뜻이고,
  //   담당자가 열을 추가해야 표시가 남는다(모르면 "왜 입금 표시가 안 뜨지"가 된다).
  if (!header) return { handled: true, ok: false, reason: 'no_status_column' };

  return _writeCellAndRebuild(db, { sheetId, tabName, rowIndex, header, value: mark, by });
}

/**
 * 무시트 탭의 **memo(비고 / 포스팅URL) 칸** 기록 — 블로그체험단 결과물이 여기 남는다(099 · M4).
 *
 * ★★ 왜 별도 경로인가: 시트 기반 탭은 `submit.routes` 배경 작업이 시트 칸에 memo 를 쓰지만,
 *   무시트 탭은 그 쓰기가 막혀 있어(W2-a) **어디에도 안 남는다**. 리뷰제출 표시와 같은 이유.
 * ★★ 열 고르기는 `utils/memoColumn` 단일 출처(시트 경로·큐 재시도와 같은 규칙) — 사본을 두면
 *   "시트 탭은 포스팅 칸, 무시트 탭은 비고 칸"으로 갈린다.
 * ★ 헤더 출처는 `detected_headers || headers` — `rebuildLedgers` 가 읽는 그 값(A1 행이 아니다).
 * ★ 시트 기반 탭이면 `{handled:false}` = 호출부 종전 경로. 판정 실패도 같다(fail-open).
 */
async function markSheetlessMemo({ sheetId, tabName, rowIndex, memo, blog = false, by = 'system' } = {}) {
  if (!sheetId || !tabName || !rowIndex) return { handled: false };
  const text = String(memo == null ? '' : memo).trim();
  if (!text) return { handled: false };                       // 쓸 값이 없으면 관여하지 않는다

  const db = getPool();
  let sheetless = false;
  try {
    sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName);
  } catch (_) { return { handled: false }; }
  if (!sheetless) return { handled: false };

  let headers = [];
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(detected_headers, headers) AS h FROM raw_sheet_tabs
        WHERE sheet_id = $1 AND tab_name = $2 ORDER BY mirrored_at DESC NULLS LAST LIMIT 1`,
      [sheetId, tabName]);
    headers = Array.isArray(rows[0] && rows[0].h) ? rows[0].h : [];
  } catch (e) {
    return { handled: true, ok: false, reason: 'lookup_failed', message: e.message };
  }
  const header = require('../utils/memoColumn').pickMemoColumnName(headers, { blog });
  // ★ 조용히 성공으로 접지 않는다 — 그 작업표에 비고/포스팅 열이 없다는 뜻이다.
  if (!header) return { handled: true, ok: false, reason: 'no_memo_column' };

  return _writeCellAndRebuild(db, { sheetId, tabName, rowIndex, header, value: text, by });
}

/** 작업표 한 칸 기록 + 장부 재생성 — 상태 칸·memo 칸 공용(쓰기 규율 사본 금지) */
async function _writeCellAndRebuild(db, { sheetId, tabName, rowIndex, header, value, by }) {
  try {
    const r = await db.query(
      `UPDATE campaign_participants
          SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($4::text, $5::text),
              updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL`,
      [sheetId, tabName, rowIndex, header, value]);
    if (!r.rowCount) return { handled: true, ok: false, reason: 'row_not_found', column: header };
  } catch (e) {
    return { handled: true, ok: false, reason: 'write_failed', message: e.message, column: header };
  }

  // ── 장부 재생성 — 이걸 빼면 화면(검색·리뷰내역·홈 통계)에 반영되지 않는다 ──
  try {
    await require('./sheetlessLedger.service').rebuildLedgers({ sheetId, tabName, by });
  } catch (e) {
    // 작업표에는 남았으므로 다음 재생성(주문 유입 등)에 자동 반영된다 → 실패해도 값은 안 잃는다.
    logger.warn(`[sheetlessStatus] 장부 재생성 실패(값은 작업표에 기록됨) tab=${tabName} row=${rowIndex}: ${e.message}`);
    return { handled: true, ok: true, deferred: true, reason: 'ledger_deferred', column: header };
  }

  return { handled: true, ok: true, column: header, value };
}

module.exports = { markStatusCell, markSheetlessMemo, SUBMIT_MARK, __setPoolForTest };
