// ═══════════════════════════════════════════════════════════
// written 사후검증 — "유령 written"(DB=성공, 시트=없음) 감지·자가치유 (7/24 이지유 사건 재발방지)
//
// 사건 요약: 구매양식이 DB에 정상 접수되고 시트에도 한 번 기록됐지만, 같은 시각 시트 수기 작업과의
//   경합(가드차단→해제→재배정) 끝에 기록 행이 다른 데이터로 덮였다. mirror_status='written'은
//   종결 상태라 기존 자동복구(reconcile)가 다시 보지 않아 3일간 잠복했다.
//
// 원리(전부 DB-only — 시트 API 0콜, 쿼터 무영향):
//   ① 신선도 게이트: RAW 미러가 그 주문의 쓰기보다 충분히 새로울 때만 판정(stale 미러 오탐 차단).
//   ② 기록 행의 신원(주문번호 > 연락처 끝8자리 > 수취인)이 주문과 일치 → 정상(row_verified_at 스탬프).
//   ③ 불일치 + 탭 안 다른 행에서 유일하게 발견 → 행 이동(중간 행 삽입/정렬 등) = DB 포인터만
//      자가보정(시트 무접촉). sheet_row_claims 도 함께 이동(충돌 시 자기 claim 삭제 폴백).
//   ④ 불일치 + 어디에도 없음 → 유령 written = critical 한글 로그(중요알림) + failed 강등
//      → 기존 reconcile 이 하단 재기록(비고 'system'). 같은 주문의 소실이 ORDER_LOST_MAX(2)회
//      반복되면 stuck_manual 전환(사람이 의도적으로 지운 행을 무한 재기록하는 루프 차단).
//   ⑤ 부속 감지: 구매캡쳐 미첨부(제출 20분 후에도 캡처 미연결), 시트 미반영 적체(stuck/failed).
//
// env: ORDER_WRITTEN_VERIFY(기본 on, '0'=off) · ORDER_WRITTEN_VERIFY_REASSIGN(기본 on, '0'=감지만)
//      ORDER_WRITTEN_VERIFY_DAYS(14) · ORDER_WRITTEN_VERIFY_FRESH_SEC(180) · ORDER_LOST_MAX(2)
// 회귀가드: tests/writtenVerify.test.js
// ═══════════════════════════════════════════════════════════
const { logger } = require('../utils/logger');
const { logReviewerEvent, autoResolveHealed } = require('./reviewerEventLog.service');

let _pool;
function getPool() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}
function __setPoolForTest(pool) { _pool = pool || null; }

// 탭 컨텍스트 로더 주입점(테스트용) — 기본은 orderLedger.loadRawTabContext(자가치유 헤더 재탐지 포함)
let _loadCtx = null;
function _loadTabContext(sheetId, gid, tabName) {
  if (_loadCtx) return _loadCtx(sheetId, gid, tabName);
  return require('./orderLedger.service').loadRawTabContext(sheetId, gid, tabName);
}
function __setLoadCtxForTest(fn) { _loadCtx = fn || null; }

const _digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');
const _norm = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, '');

function _findCol(headers, keywords, exact = []) {
  return (headers || []).findIndex((h) => {
    const key = String(h || '').toLowerCase().trim();
    return exact.includes(key) || keywords.some((kw) => key.includes(kw.toLowerCase()));
  });
}

/** 탭 헤더에서 신원 판정 컬럼 인덱스(연락처/수취인/주문번호) */
function _identityCols(headers) {
  return {
    phoneCol: _findCol(headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']),
    recipCol: _findCol(headers, ['수취인', '받는분', 'recipient']),
    orderNumCol: _findCol(headers, ['주문번호']),
  };
}

/**
 * 행이 이 주문의 것인지 판정. 강한 키(주문번호·연락처) 우선, 수취인 단독은 강한 키 열이 없을 때만.
 * @returns 'mine' | 'other'  ('other'=빈 행 포함 — 내 데이터가 그 행에 없음)
 */
function _rowVerdict(cells, cols, os) {
  const osNum = _digits(os.orderNum);
  const osP8 = _digits(os.phone).slice(-8);
  const cellNum = cols.orderNumCol >= 0 ? _digits((cells || [])[cols.orderNumCol]) : '';
  const cellP8 = cols.phoneCol >= 0 ? _digits((cells || [])[cols.phoneCol]).slice(-8) : '';
  const cellRcp = cols.recipCol >= 0 ? _norm((cells || [])[cols.recipCol]) : '';
  if (osNum.length >= 6 && cellNum && cellNum === osNum) return 'mine';
  if (osP8.length === 8 && cellP8.length === 8 && cellP8 === osP8) return 'mine';
  if (cols.phoneCol < 0 && cols.orderNumCol < 0 && cellRcp && _norm(os.recipient) && cellRcp === _norm(os.recipient)) return 'mine';
  return 'other';
}

/** 탭 전체에서 이 주문의 행 후보 탐색(주문번호 정확일치 우선 → 연락처 끝8자리) */
function _searchRows(dataRows, cols, os) {
  const osNum = _digits(os.orderNum);
  const osP8 = _digits(os.phone).slice(-8);
  if (osNum.length >= 6 && cols.orderNumCol >= 0) {
    const byNum = (dataRows || []).filter((r) => _digits((r.cells || [])[cols.orderNumCol]) === osNum);
    if (byNum.length) return byNum;
  }
  if (osP8.length === 8 && cols.phoneCol >= 0) {
    return (dataRows || []).filter((r) => _digits((r.cells || [])[cols.phoneCol]).slice(-8) === osP8);
  }
  return [];
}

const _label = (os) => os.tabName || '';
const _who = (os) => String(os.recipient || os.orderer || '리뷰어').trim() || '리뷰어';

/** ② written 주문 행 검증 + ③행이동 보정 + ④유령 written 처리 */
async function verifyWrittenOrders({ limit = 400, maxTabs = 20 } = {}) {
  const db = getPool();
  const days = parseInt(process.env.ORDER_WRITTEN_VERIFY_DAYS || '14', 10);
  const freshSec = parseInt(process.env.ORDER_WRITTEN_VERIFY_FRESH_SEC || '180', 10);
  const lostMax = parseInt(process.env.ORDER_LOST_MAX || '2', 10);
  const reassignOn = process.env.ORDER_WRITTEN_VERIFY_REASSIGN !== '0';

  const { rows: orders } = await db.query(
    `SELECT os.id, os.sheet_id AS "sheetId", os.tab_name AS "tabName",
            COALESCE(NULLIF(os.tab_gid, ''), NULLIF(os.gid, '')) AS gid,
            os.sheet_row AS "sheetRow", os.recipient, os.orderer, os.phone,
            os.order_num AS "orderNum", os.sheet_written_at AS "writtenAt",
            os.row_verified_at AS "verifiedAt",
            RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) AS phone8
       FROM order_submissions os
      WHERE os.mirror_status = 'written' AND os.deleted_at IS NULL
        AND os.sheet_row IS NOT NULL AND os.sheet_written_at IS NOT NULL
        AND os.sheet_written_at > NOW() - ($1 || ' days')::interval
      ORDER BY os.sheet_id, os.tab_name, os.sheet_row
      LIMIT $2`,
    [days, limit]
  );

  const result = { scanned: orders.length, verified: 0, shifted: 0, lost: 0, lostManual: 0, ambiguous: 0, skippedStale: 0, skippedNoMeta: 0 };
  if (!orders.length) return result;

  // 탭별 그룹핑 — 탭당 컨텍스트 1회 로드
  const byTab = new Map();
  for (const o of orders) {
    const key = `${o.sheetId}||${o.tabName}`;
    if (!byTab.has(key)) byTab.set(key, []);
    byTab.get(key).push(o);
  }

  let tabCount = 0;
  for (const [, group] of byTab) {
    if (tabCount >= maxTabs) break;
    tabCount++;
    const { sheetId, tabName, gid } = group[0];

    let ctx = null;
    try { ctx = await _loadTabContext(sheetId, gid, tabName); } catch (_) {}
    if (!ctx || !ctx.headers || !ctx.headers.length) { result.skippedNoMeta += group.length; continue; }

    let mirroredAt = null;
    try {
      const { rows: mt } = await db.query(
        `SELECT mirrored_at FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2
          ORDER BY mirrored_at DESC NULLS LAST LIMIT 1`,
        [sheetId, ctx.tabGid]
      );
      mirroredAt = mt[0] && mt[0].mirrored_at ? new Date(mt[0].mirrored_at).getTime() : null;
    } catch (_) {}
    if (!mirroredAt) { result.skippedNoMeta += group.length; continue; }

    const cols = _identityCols(ctx.headers);
    if (cols.phoneCol < 0 && cols.orderNumCol < 0 && cols.recipCol < 0) { result.skippedNoMeta += group.length; continue; }

    const rowByIndex = new Map();
    for (const r of ctx.dataRows || []) rowByIndex.set(parseInt(r.rowIndex, 10), r);

    const okIds = [];
    for (const os of group) {
      // ① 신선도 게이트: 미러 스냅샷이 이 쓰기 이후여야만 판정(미러가 아직 못 본 쓰기 = 오탐)
      const writtenMs = new Date(os.writtenAt).getTime();
      if (!(mirroredAt > writtenMs + freshSec * 1000)) { result.skippedStale++; continue; }
      if (os.verifiedAt && new Date(os.verifiedAt).getTime() >= mirroredAt) continue; // 이 스냅샷은 이미 검증함

      const row = rowByIndex.get(parseInt(os.sheetRow, 10));
      if (_rowVerdict(row && row.cells, cols, os) === 'mine') { okIds.push(os.id); result.verified++; continue; }

      // ③ 행 이동 탐색 — 유일 매치면 포인터만 보정(시트 무접촉)
      const found = _searchRows(ctx.dataRows, cols, os).filter((r) => parseInt(r.rowIndex, 10) !== parseInt(os.sheetRow, 10));
      if (found.length === 1) {
        const newRow = parseInt(found[0].rowIndex, 10);
        const upd = await db.query(
          `UPDATE order_submissions SET sheet_row = $2, row_verified_at = NOW()
            WHERE id = $1 AND mirror_status = 'written' AND sheet_row = $3`,
          [os.id, newRow, os.sheetRow]
        );
        if (upd.rowCount > 0) {
          // 자기 claim 도 함께 이동(다른 stale claim 과 행 유니크 충돌 시 자기 것 삭제 폴백 —
          // claims 는 dedup 메모리라 written 주문에선 삭제가 안전측)
          try {
            await db.query(
              `UPDATE sheet_row_claims SET sheet_row = $3, updated_at = NOW()
                WHERE sheet_id = $1 AND tab_name = $2 AND order_id = $4`,
              [sheetId, tabName, newRow, os.id]
            );
          } catch (e) {
            if (e && e.code === '23505') {
              try {
                await db.query(
                  `DELETE FROM sheet_row_claims WHERE sheet_id = $1 AND tab_name = $2 AND order_id = $3`,
                  [sheetId, tabName, os.id]
                );
              } catch (_) {}
            }
          }
          result.shifted++;
          await logReviewerEvent({
            sheetId, tabName, tabGid: ctx.tabGid, reviewerName: _who(os), phone8: os.phone8,
            eventType: 'order_row_shifted', severity: 'info', resolved: true,
            message: `『${_label(os)}』 ${_who(os)} 리뷰어의 구매양식 기록 행이 ${os.sheetRow}→${newRow}행으로 이동되어 자동 보정했습니다(시트 중간 행 삽입/정렬 감지).`,
            context: { oldRow: os.sheetRow, newRow }, orderSubmissionId: os.id,
          });
        }
        continue;
      }
      if (found.length >= 2) {
        result.ambiguous++;
        await logReviewerEvent({
          sheetId, tabName, tabGid: ctx.tabGid, reviewerName: _who(os), phone8: os.phone8,
          eventType: 'order_row_ambiguous', severity: 'warn',
          message: `『${_label(os)}』 ${_who(os)} 리뷰어의 구매양식 기록 행(${os.sheetRow}행)이 실제 시트 내용과 달라졌는데, 같은 신원의 행이 ${found.length}개라 자동 보정하지 못했습니다. 시트 확인이 필요합니다.`,
          context: { row: os.sheetRow, candidates: found.map((r) => r.rowIndex).slice(0, 10) }, orderSubmissionId: os.id,
        });
        okIds.push(os.id); // 판정 보류 — 다음 미러에서 재검(스탬프로 같은 스냅샷 재작업 방지)
        continue;
      }

      // ④ 유령 written — 시트 어디에도 없음
      let priorLost = 0;
      try {
        const { rows: pl } = await db.query(
          `SELECT COUNT(*)::int AS n FROM reviewer_event_logs
            WHERE event_type = 'order_lost' AND order_submission_id = $1`,
          [os.id]
        );
        priorLost = (pl[0] && pl[0].n) || 0;
      } catch (_) {}

      if (reassignOn && priorLost < lostMax) {
        result.lost++;
        await logReviewerEvent({
          sheetId, tabName, tabGid: ctx.tabGid, reviewerName: _who(os), phone8: os.phone8,
          eventType: 'order_lost', severity: 'critical',
          message: `『${_label(os)}』에 ${_who(os)} 리뷰어가 제출한 구매양식이 시트에서 사라졌습니다(기록됐던 ${os.sheetRow}행이 다른 내용으로 바뀜). 자동 재기록을 진행합니다 — 반영되면 시트 하단 행 비고에 'system' 표기.`,
          context: { row: os.sheetRow, orderNum: os.orderNum || '' }, orderSubmissionId: os.id,
        });
        try {
          await db.query(
            `DELETE FROM sheet_row_claims WHERE sheet_id = $1 AND tab_name = $2 AND order_id = $3`,
            [sheetId, tabName, os.id]
          );
        } catch (_) {}
        await db.query(
          `UPDATE order_submissions
              SET sheet_row = NULL, mirror_status = 'failed', row_verified_at = NOW(),
                  sheet_error = 'ghost written — 사후검증: 기록 행이 다른 데이터로 바뀜(자동 재기록 대기)'
            WHERE id = $1 AND mirror_status = 'written'`,
          [os.id]
        );
      } else {
        result.lostManual++;
        await logReviewerEvent({
          sheetId, tabName, tabGid: ctx.tabGid, reviewerName: _who(os), phone8: os.phone8,
          eventType: 'order_lost_manual', severity: 'critical',
          message: `『${_label(os)}』 ${_who(os)} 리뷰어의 구매양식이 시트에서 반복 소실되어 자동 재기록을 중단했습니다. 수동 확인·입력이 필요합니다(관리자 대시보드 '구매주문 시트반영 현황' 참조).`,
          context: { row: os.sheetRow, priorLost, reassignOn }, orderSubmissionId: os.id,
        });
        await db.query(
          `UPDATE order_submissions
              SET mirror_status = 'stuck_manual', row_verified_at = NOW(),
                  sheet_error = 'ghost written — 소실 반복(자동 재기록 중단), 수동 입력 필요'
            WHERE id = $1 AND mirror_status = 'written'`,
          [os.id]
        );
      }
    }

    if (okIds.length) {
      await db.query(
        `UPDATE order_submissions SET row_verified_at = NOW() WHERE id = ANY($1::uuid[])`,
        [okIds]
      );
    }
  }
  return result;
}

/** ⑤a 구매캡쳐 미첨부 감지 — 제출 20분 후에도 캡처 미연결(컷오프 이후 제출분만) */
async function detectMissingCaptures({ limit = 50 } = {}) {
  const db = getPool();
  let cutoff = null;
  try {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'reviewer_log_capture_cutoff'`);
    cutoff = rows[0] && rows[0].value ? rows[0].value : null;
  } catch (_) {}
  if (!cutoff) return { flagged: 0, skipped: 'no_cutoff' };

  const { rows: orders } = await db.query(
    `SELECT os.id, os.sheet_id AS "sheetId", os.tab_name AS "tabName", os.tab_gid AS "tabGid",
            os.recipient, os.orderer,
            RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) AS phone8
       FROM order_submissions os
      WHERE os.deleted_at IS NULL AND os.capture_uploaded_at IS NULL
        AND os.submitted_at < NOW() - interval '20 minutes'
        AND os.submitted_at > GREATEST(NOW() - interval '3 days', $1::timestamptz)
      ORDER BY os.submitted_at DESC
      LIMIT $2`,
    [cutoff, limit]
  );

  let flagged = 0;
  for (const os of orders) {
    const r = await logReviewerEvent({
      sheetId: os.sheetId, tabName: os.tabName, tabGid: os.tabGid,
      reviewerName: _who(os), phone8: os.phone8,
      eventType: 'order_no_capture', severity: 'warn',
      message: `『${_label(os)}』에 ${_who(os)} 리뷰어가 구매양식을 제출했으나, 구매캡쳐를 첨부하지 않았습니다.`,
      context: {}, orderSubmissionId: os.id,
    });
    if (r.ok && !r.skipped) flagged++;
  }
  return { flagged, scanned: orders.length };
}

/** ⑤b 시트 미반영 적체 감지 — stuck_manual(수동 필요)=critical, 그 외 장기 미반영=warn */
async function detectStuckOrders({ limit = 50 } = {}) {
  const db = getPool();
  const { rows: orders } = await db.query(
    `SELECT os.id, os.sheet_id AS "sheetId", os.tab_name AS "tabName", os.tab_gid AS "tabGid",
            os.recipient, os.orderer, os.mirror_status AS "mirrorStatus",
            RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) AS phone8
       FROM order_submissions os
      WHERE os.deleted_at IS NULL
        AND os.submitted_at > NOW() - interval '3 days'
        AND ( os.mirror_status = 'stuck_manual'
           OR (os.mirror_status IN ('failed', 'pending_no_row') AND os.submitted_at < NOW() - interval '15 minutes')
           OR (os.mirror_status IN ('pending', 'queued') AND os.submitted_at < NOW() - interval '30 minutes') )
      ORDER BY os.submitted_at DESC
      LIMIT $1`,
    [limit]
  );

  let flagged = 0;
  for (const os of orders) {
    const manual = os.mirrorStatus === 'stuck_manual';
    const r = await logReviewerEvent({
      sheetId: os.sheetId, tabName: os.tabName, tabGid: os.tabGid,
      reviewerName: _who(os), phone8: os.phone8,
      eventType: 'order_unmirrored', severity: manual ? 'critical' : 'warn',
      message: manual
        ? `『${_label(os)}』에 ${_who(os)} 리뷰어가 구매양식을 제출했으나, 시트에 입력되지 못했습니다. 자동 재기록이 중단되어 수동 입력이 필요합니다(관리자 대시보드 '구매주문 시트반영 현황' 참조).`
        : `『${_label(os)}』에 ${_who(os)} 리뷰어가 구매양식을 제출했으나, 아직 시트에 입력되지 못했습니다(상태: ${os.mirrorStatus} — 자동복구 대기 중).`,
      context: { mirrorStatus: os.mirrorStatus }, orderSubmissionId: os.id,
    });
    if (r.ok && !r.skipped) flagged++;
  }
  return { flagged, scanned: orders.length };
}

/** 크론 진입점 — 자동해결 → 행 검증 → 캡처/적체 감지 */
async function runWrittenVerifyCycle(opts = {}) {
  const healed = await autoResolveHealed().catch((e) => { logger.warn(`[written-verify] autoResolve 실패(무시): ${e.message}`); return {}; });
  const verify = await verifyWrittenOrders(opts);
  const capture = await detectMissingCaptures(opts).catch((e) => { logger.warn(`[written-verify] 캡처감지 실패(무시): ${e.message}`); return {}; });
  const stuck = await detectStuckOrders(opts).catch((e) => { logger.warn(`[written-verify] 적체감지 실패(무시): ${e.message}`); return {}; });
  return { healed, verify, capture, stuck };
}

module.exports = {
  runWrittenVerifyCycle,
  verifyWrittenOrders,
  detectMissingCaptures,
  detectStuckOrders,
  _rowVerdict,
  _searchRows,
  _identityCols,
  __setPoolForTest,
  __setLoadCtxForTest,
};
