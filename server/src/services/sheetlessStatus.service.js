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
const { mergeDepositStamps } = require('../utils/depositStamp');
const { findPaymentColumnIndex } = require('./columnResolver');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 리뷰제출 칸에 쓰는 값 — Track B write-back(`_wantMark`)과 같은 표기 */
const SUBMIT_MARK = 'O';

/**
 * 그 탭이 쓰는 상태 칸(리뷰제출·입금) 헤더명 — **줄이 아니라 탭 단위**로 해석한다.
 * ★ 소비처가 둘이다: 무시트 상태 기록(markStatusCell)과 **관리자 수동 리뷰제출**
 *   (수동/작업표로 추가한 줄은 `campaign_participants.submit_col` 이 비어 있다 —
 *    그 칸은 `review_index` 복제 경로에서만 채워진다). 각자 SQL 을 쓰면 "장부는 A 칸에
 *    쓰는데 수동 제출은 B 칸에 쓰는" 상태가 된다.
 * @param {object} db  pool 또는 **트랜잭션 client**(잠근 tx 안에서 부를 수 있어야 한다)
 */
async function statusHeaderForTab(db, { sheetId, tabName, kind = 'submit' } = {}) {
  if (!db || !sheetId || !tabName) return '';
  const col = kind === 'paid' ? 'submit_col2' : 'submit_col';
  return _resolveStatusHeader(db, { sheetId, tabName, col, kind });
}

async function _v2StatusHeaders(db, { sheetId, tabName }) {
  const { rows: configs } = await db.query(
    `SELECT tab_gid, workboard_schema_version FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`, [sheetId, tabName]
  );
  if (Number(configs[0] && configs[0].workboard_schema_version) !== 2) return null;
  const { rows: tabRows } = await db.query(
    `SELECT COALESCE(detected_headers, headers) AS h FROM raw_sheet_tabs
      WHERE sheet_id=$1 AND tab_name=$2 ORDER BY mirrored_at DESC NULLS LAST LIMIT 1`, [sheetId, tabName]
  );
  const headers = Array.isArray(tabRows[0] && tabRows[0].h) ? tabRows[0].h : [];
  const bindings = await require('./statusColumnBinding.service').loadV2StatusBindings(db, {
    sheetId, tabGid: configs[0] && configs[0].tab_gid, headers,
  });
  return { submit: bindings.review_submit.header, paid: bindings.payment_status.header };
}

async function _resolveStatusHeader(db, { sheetId, tabName, col, kind }) {
  const { rows } = await db.query(
    `SELECT ${col} AS h FROM review_index
      WHERE sheet_id = $1 AND tab_name = $2 AND COALESCE(${col}, '') <> ''
      LIMIT 1`, [sheetId, tabName]);
  let header = rows.length ? String(rows[0].h || '').trim() : '';
  if (header || kind !== 'paid') return header;

  // 이전 빌드가 입금 헤더를 저장하지 못한 무시트 탭도, 작업보드가 보관한 실제 헤더에서 복구한다.
  const { rows: tabRows } = await db.query(
    `SELECT COALESCE(detected_headers, headers) AS h FROM raw_sheet_tabs
      WHERE sheet_id = $1 AND tab_name = $2 ORDER BY mirrored_at DESC NULLS LAST LIMIT 1`,
    [sheetId, tabName]);
  const headers = Array.isArray(tabRows[0] && tabRows[0].h) ? tabRows[0].h : [];
  const index = findPaymentColumnIndex(headers);
  return index >= 0 ? String(headers[index] || '').trim() : '';
}

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
async function markStatusCell({ sheetId, tabName, rowIndex, kind, value = '', by = 'system', deferRebuild = false } = {}) {
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

  let v2Headers = null;
  try { v2Headers = await _v2StatusHeaders(db, { sheetId, tabName }); }
  catch (e) { return { handled: true, ok: false, reason: e.code || 'status_binding_failed', message: e.message }; }
  const col = kind === 'submit' ? 'submit_col' : 'submit_col2';
  const mark = String(value || '').trim() || (kind === 'submit' ? (v2Headers ? '제출' : SUBMIT_MARK) : '');
  if (!mark) return { handled: true, ok: false, reason: 'empty_value' };

  // ── 그 탭이 쓰는 상태 칸 헤더명(파서가 감지한 값) ──
  let header = '';
  try {
    header = v2Headers ? v2Headers[kind] : await _resolveStatusHeader(db, { sheetId, tabName, col, kind });
  } catch (e) {
    return { handled: true, ok: false, reason: 'lookup_failed', message: e.message };
  }
  // ★ 조용히 성공으로 접지 않는다 — 그 작업표에 리뷰제출/입금 열이 없다는 뜻이고,
  //   담당자가 열을 추가해야 표시가 남는다(모르면 "왜 입금 표시가 안 뜨지"가 된다).
  if (!header) return { handled: true, ok: false, reason: 'no_status_column' };

  return _writeCellAndRebuild(db, { sheetId, tabName, rowIndex, header, value: mark, by,
    mergeDeposit: kind === 'paid', deferRebuild });
}

/**
 * Verify the value that is actually rendered by a sheetless workboard after
 * its ledger has been rebuilt.  A successful UPDATE alone is not enough:
 * the workboard reads the rebuilt raw mirror, not the transient request.
 */
async function verifyStatusCell({ sheetId, tabName, rowIndex, kind, value = '' } = {}) {
  if (!sheetId || !tabName || !rowIndex) return { handled: false };
  if (kind !== 'submit' && kind !== 'paid') return { handled: false };

  const db = getPool();
  let sheetless = false;
  try {
    sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName);
  } catch (_) {
    return { handled: false };
  }
  if (!sheetless) return { handled: false };

  let v2Headers = null;
  try { v2Headers = await _v2StatusHeaders(db, { sheetId, tabName }); }
  catch (e) { return { handled: true, ok: false, reason: e.code || 'status_binding_failed', message: e.message }; }
  const col = kind === 'submit' ? 'submit_col' : 'submit_col2';
  const header = v2Headers ? v2Headers[kind] : await _resolveStatusHeader(db, { sheetId, tabName, col, kind });
  if (!header) return { handled: true, ok: false, reason: 'no_status_column' };

  // `workdeskTab` renders campaign_participants.row_json directly.  The RAW
  // mirror is a derived ledger and can be stale while the board is already
  // showing different data, so it must not be used as this confirmation's
  // source of truth.
  const { rows } = await db.query(
    `SELECT COALESCE(row_json ->> $4, '') AS value
       FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3
        AND deleted_at IS NULL AND active = TRUE
      LIMIT 1`, [sheetId, tabName, rowIndex, header]);
  if (!rows.length) return { handled: true, ok: false, reason: 'workboard_row_not_found', column: header };
  const observed = String(rows[0].value || '').trim();
  const normalized = mergeDepositStamps(observed, '');
  const expected = mergeDepositStamps(observed, value);
  return {
    handled: true,
    ok: normalized === expected,
    reason: normalized === expected ? undefined : 'workboard_value_missing',
    column: header,
    observed,
  };
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

/** 127: 포스팅제출일 자동 기록(blog 제출 완료 시) — memo 기록과 같은 규율·같은 실행부.
 *  열 고르기는 utils/memoColumn.pickPostDateColumnName 단일 출처(시트 경로·큐 재시도와 동일). */
async function markSheetlessPostDate({ sheetId, tabName, rowIndex, date, by = 'system' } = {}) {
  if (!sheetId || !tabName || !rowIndex) return { handled: false };
  const text = String(date == null ? '' : date).trim();
  if (!text) return { handled: false };

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
  const header = require('../utils/memoColumn').pickPostDateColumnName(headers);
  if (!header) return { handled: true, ok: false, reason: 'no_post_date_column' };

  return _writeCellAndRebuild(db, { sheetId, tabName, rowIndex, header, value: text, by });
}

/**
 * 무시트 탭의 **구매일자 칸**에 날짜를 기록한다 (2026-08-21 · 달력 편집 창구).
 *
 * ★ 어느 칸인가 = `campaignSchedule.findDateColumnIndex` 단일 출처(재번호·일정 인식과 같은 판정).
 * ★ 표기 = `worktablePlan.sheetDateStr`(`M / D (요일)`) — 재번호 파서(parseDateColumn)가 그대로 읽는다.
 * ★ 시트 기반 탭은 handled:false(시트가 진실원본 — 그쪽 편집은 시트에서).
 * @param {string} o.dateYmd 'YYYY-MM-DD'
 */
async function markSheetlessPurchaseDate({ sheetId, tabName, rowIndex, dateYmd, by = 'system' } = {}) {
  if (!sheetId || !tabName || !rowIndex) return { handled: false };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateYmd || '').trim());
  if (!m) return { handled: true, ok: false, reason: 'bad_date' };
  const o = { y: +m[1], m: +m[2], d: +m[3] };
  const chk = new Date(Date.UTC(o.y, o.m - 1, o.d));
  if (chk.getUTCFullYear() !== o.y || chk.getUTCMonth() + 1 !== o.m || chk.getUTCDate() !== o.d) {
    return { handled: true, ok: false, reason: 'bad_date' };
  }

  const db = getPool();
  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName); }
  catch (_) { return { handled: false }; }
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
  const di = require('./campaignSchedule.service').findDateColumnIndex(headers);
  if (di < 0) return { handled: true, ok: false, reason: 'no_date_column' };
  const header = String(headers[di] || '').trim();

  const value = require('../utils/worktablePlan').sheetDateStr(o);
  return _writeCellAndRebuild(db, { sheetId, tabName, rowIndex, header, value, by });
}

/**
 * 무시트 탭의 **주문자·수취인 칸**에 이름을 기록한다 (2026-08-24 · 리뷰내역 반영 창구).
 *
 * ★★ 왜 필요한가 — 리뷰어 홈 "리뷰 내역" 카드(`search.service`)의 이름은 `review_index.reviewer_name`
 *   이고, 그 값은 **작업표의 '주문자' 계열 칸**(`orderLedger._fieldToCol(headers,'orderer')`가 찾는
 *   헤더 — 흔히 '주문자제출')에서 온다. `review_index.recipient_name`(작업표 '수취인' 칸)은
 *   현재 리뷰어 화면 어디에도 표시되지 않는다 — 그래도 참고용으로 함께 실제 반영시킨다.
 * ★ 어느 칸이 주문자/수취인인가 = **`orderLedger._fieldToCol` 단일 출처**(관리자 주문 편집이 이미
 *   쓰는 판정 — 사본을 두면 "주문 편집은 이 칸에 쓰는데 여기는 저 칸을 찾는" 드리프트가 생긴다).
 * ★ 이 행에 연결된 주문(`order_submissions`)이 있으면 이 함수를 부르지 않는다 — 그 경우는
 *   원장을 먼저 고치고 `writeOrderToWorktable`로 재기록해야 다음 주문 편집에 안 덮인다
 *   (호출부 `trackB.service.setWorkdeskIdentityField` 가 분기).
 */
async function markSheetlessIdentityName({ sheetId, tabName, rowIndex, field, name, by = 'system' } = {}) {
  if (!sheetId || !tabName || !rowIndex) return { handled: false };
  if (field !== 'orderer' && field !== 'recipient') return { handled: false };
  const text = String(name == null ? '' : name).trim();
  if (!text) return { handled: true, ok: false, reason: 'empty_value' };

  const db = getPool();
  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName); }
  catch (_) { return { handled: false }; }
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
  const { _fieldToCol } = require('./orderLedger.service');
  const idx = _fieldToCol(headers, field);
  if (idx < 0) return { handled: true, ok: false, reason: field === 'orderer' ? 'no_orderer_column' : 'no_recipient_column' };
  const header = String(headers[idx] || '').trim();

  return _writeCellAndRebuild(db, { sheetId, tabName, rowIndex, header, value: text, by });
}

/** 작업표 한 칸 기록 + 장부 재생성 — 상태 칸·memo 칸 공용(쓰기 규율 사본 금지) */
async function _writeCellAndRebuild(db, { sheetId, tabName, rowIndex, header, value, by, mergeDeposit = false, deferRebuild = false }) {
  let nextValue = value;
  if (mergeDeposit) {
    try {
      const { rows } = await db.query(
        `SELECT COALESCE(row_json ->> $4, '') AS value
           FROM campaign_participants
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL
          LIMIT 1`, [sheetId, tabName, rowIndex, header]);
      nextValue = mergeDepositStamps(rows[0] && rows[0].value, value);
    } catch (e) {
      return { handled: true, ok: false, reason: 'lookup_failed', message: e.message, column: header };
    }
  }
  try {
    const r = await db.query(
      `UPDATE campaign_participants
          SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($4::text, $5::text),
              updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL`,
      [sheetId, tabName, rowIndex, header, nextValue]);
    if (!r.rowCount) return { handled: true, ok: false, reason: 'row_not_found', column: header };
  } catch (e) {
    return { handled: true, ok: false, reason: 'write_failed', message: e.message, column: header };
  }

  // ── 장부 재생성 — 이걸 빼면 화면(검색·리뷰내역·홈 통계)에 반영되지 않는다 ──
  if (deferRebuild) return { handled: true, ok: true, deferred: true, column: header, value: nextValue };

  try {
    await require('./sheetlessLedger.service').rebuildLedgers({ sheetId, tabName, by });
  } catch (e) {
    // 작업표에는 남았으므로 다음 재생성(주문 유입 등)에 자동 반영된다 → 실패해도 값은 안 잃는다.
    logger.warn(`[sheetlessStatus] 장부 재생성 실패(값은 작업표에 기록됨) tab=${tabName} row=${rowIndex}: ${e.message}`);
    return { handled: true, ok: true, deferred: true, reason: 'ledger_deferred', column: header };
  }

  return { handled: true, ok: true, column: header, value: nextValue };
}

/*
 * 기존 버그로 남은 작업표의 `O`를 원장상 실제 리뷰 파일 업로드 시각으로 교체한다.
 *
 * 범위는 의도적으로 매우 좁다.
 * - 시트리스 탭만 (시트 기반 작업은 절대 건드리지 않음)
 * - 작업표 값이 지금도 정확히 `O`인 행만
 * - review_index가 제출 완료이고 최근 5일에 리뷰 파일 원장이 있는 행만
 *
 * 여러 캡처 슬롯이 있을 수 있으므로 마지막 파일 업로드 시각을 사용한다. 이는
 * 최종 제출 버튼 시각 자체는 아니지만, 과거 O 값에서 복원 가능한 가장 가까운
 * 제출 근거다.
 */
const REVIEW_SUBMIT_TIME_BACKFILL_DAYS = 5;
const REVIEW_SUBMIT_TIME_BACKFILL_LIMIT = 5000;

async function _reviewSubmitTimeBackfillCandidates(db, { days = REVIEW_SUBMIT_TIME_BACKFILL_DAYS, limit = REVIEW_SUBMIT_TIME_BACKFILL_LIMIT } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || REVIEW_SUBMIT_TIME_BACKFILL_DAYS, 1), REVIEW_SUBMIT_TIME_BACKFILL_DAYS);
  const safeLimit = Math.min(Math.max(Number(limit) || REVIEW_SUBMIT_TIME_BACKFILL_LIMIT, 1), REVIEW_SUBMIT_TIME_BACKFILL_LIMIT);
  const { rows } = await db.query(
    `SELECT cp.sheet_id AS "sheetId", cp.tab_name AS "tabName", cp.seq AS "rowIndex",
            cp.reviewer_name AS "reviewerName", ri.submit_col AS "submitCol",
            MAX(COALESCE(rs.uploaded_at, rs.created_at)) AS "sourceAt",
            to_char(MAX(COALESCE(rs.uploaded_at, rs.created_at)) AT TIME ZONE 'Asia/Seoul', 'FMMM/FMDD HH24:MI') AS "submitValue"
       FROM campaign_participants cp
       JOIN tab_configs tc
         ON tc.sheet_id = cp.sheet_id AND tc.tab_name = cp.tab_name
       JOIN review_index ri
         ON ri.sheet_id = cp.sheet_id AND ri.tab_name = cp.tab_name AND ri.row_index = cp.seq
       JOIN review_submissions rs
         ON rs.sheet_id = cp.sheet_id AND rs.tab_name = cp.tab_name AND rs.row_index = cp.seq
      WHERE cp.deleted_at IS NULL
        AND cp.active = TRUE
        AND COALESCE(tc.sheetless, FALSE) = TRUE
        AND ri.is_submitted = TRUE
        AND COALESCE(ri.submit_col, '') <> ''
        AND COALESCE(cp.row_json ->> ri.submit_col, '') = 'O'
        AND COALESCE(rs.uploaded_at, rs.created_at) >= (
          (NOW() AT TIME ZONE 'Asia/Seoul') - make_interval(days => $1::int)
        ) AT TIME ZONE 'Asia/Seoul'
      GROUP BY cp.sheet_id, cp.tab_name, cp.seq, cp.reviewer_name, ri.submit_col
      ORDER BY MAX(COALESCE(rs.uploaded_at, rs.created_at)) DESC, cp.sheet_id, cp.tab_name, cp.seq
      LIMIT $2`,
    [safeDays, safeLimit]
  );
  return rows;
}

/**
 * @param {{dryRun?:boolean, by?:string}} o
 * @returns {Promise<{ok:boolean,dryRun:boolean,windowDays:number,candidates?:object[],updated?:number,rebuiltTabs?:number,deferredTabs?:object[]}>}
 */
async function backfillReviewSubmitTimes({ dryRun = true, by = 'system' } = {}) {
  const db = getPool();
  const candidates = await _reviewSubmitTimeBackfillCandidates(db);
  const base = {
    ok: true,
    dryRun: dryRun !== false,
    windowDays: REVIEW_SUBMIT_TIME_BACKFILL_DAYS,
    candidates,
    candidateCount: candidates.length,
  };
  if (dryRun !== false || !candidates.length) return base;

  // 계획값을 파라미터로만 다시 넘긴다. 헤더명·표시값을 SQL 문자열로 조립하지 않아
  // 열 이름/문자열에 의한 SQL 주입이나 다른 열 갱신이 일어나지 않는다.
  const plan = candidates.map(c => ({
    sheet_id: c.sheetId,
    tab_name: c.tabName,
    row_index: c.rowIndex,
    submit_col: c.submitCol,
    submit_value: c.submitValue,
  }));
  const { rows: changed } = await db.query(
    `UPDATE campaign_participants cp
        SET row_json = COALESCE(cp.row_json, '{}'::jsonb)
                      || jsonb_build_object(c.submit_col, c.submit_value),
            updated_at = NOW(), updated_by = $2
       FROM jsonb_to_recordset($1::jsonb) AS c(
         sheet_id text, tab_name text, row_index integer, submit_col text, submit_value text
       )
      WHERE cp.sheet_id = c.sheet_id
        AND cp.tab_name = c.tab_name
        AND cp.seq = c.row_index
        AND cp.deleted_at IS NULL
        AND cp.active = TRUE
        AND COALESCE(cp.row_json ->> c.submit_col, '') = 'O'
      RETURNING cp.sheet_id AS "sheetId", cp.tab_name AS "tabName", cp.seq AS "rowIndex"`,
    [JSON.stringify(plan), String(by || 'system').slice(0, 100)]
  );

  const tabs = new Map();
  for (const row of changed) tabs.set(`${row.sheetId}\t${row.tabName}`, row);
  let rebuiltTabs = 0;
  const deferredTabs = [];
  for (const tab of tabs.values()) {
    try {
      await require('./sheetlessLedger.service').rebuildLedgers({ sheetId: tab.sheetId, tabName: tab.tabName, by });
      rebuiltTabs++;
    } catch (e) {
      deferredTabs.push({ sheetId: tab.sheetId, tabName: tab.tabName, reason: e.message });
      logger.warn(`[sheetlessStatus] review submit time backfill ledger deferred tab=${tab.tabName}: ${e.message}`);
    }
  }
  return Object.assign(base, { updated: changed.length, rebuiltTabs, deferredTabs });
}

module.exports = {
  markStatusCell,
  statusHeaderForTab,
  verifyStatusCell,
  markSheetlessMemo,
  markSheetlessPostDate,
  markSheetlessPurchaseDate,
  markSheetlessIdentityName,
  backfillReviewSubmitTimes,
  REVIEW_SUBMIT_TIME_BACKFILL_DAYS,
  SUBMIT_MARK,
  __setPoolForTest,
};
