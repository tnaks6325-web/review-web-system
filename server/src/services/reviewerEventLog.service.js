// ═══════════════════════════════════════════════════════════
// 리뷰어 비정상 이벤트 — 캠페인별 한글 자연어 로그 원장 (migration 062)
//
// 소비처: 통합작업대(workdesk.html) "리뷰어 로그" 창 + 관리자 대시보드 중요알림 카드.
// 설계:
//   - append-only + resolved_at 확인처리(서버 상태가 진실원본 — 로컬 seen 저장 불필요).
//   - 미해결 (event_type, order_submission_id) 부분유니크 → 주기 감지 크론이 같은 건을
//     도배하지 않는다(ON CONFLICT DO NOTHING, 해결 후 재발하면 새 로그 = 이력 보존).
//   - severity='critical' 신규 삽입 시 SSE 'reviewer_alert' 발신(관리자 실시간 알림, best-effort).
//   - 메시지는 한글 자연어 문장 그대로 저장·표시(예: "『0721)장수돌침대…』에 이지유 리뷰어가
//     구매양식을 제출했으나, 시트에 입력되지 못했습니다.").
// ═══════════════════════════════════════════════════════════
const { logger } = require('../utils/logger');

let _pool;
function getPool() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}
function __setPoolForTest(pool) { _pool = pool || null; }

/** 표시용 캠페인/탭 라벨 해석 — display_name > campaign_name > tab_name (best-effort) */
async function _resolveCampaignLabel(sheetId, tabName) {
  if (!sheetId || !tabName) return tabName || '';
  try {
    const { rows } = await getPool().query(
      `SELECT display_name, campaign_name FROM tab_configs
        WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`,
      [sheetId, tabName]
    );
    const tc = rows[0];
    return (tc && (tc.display_name || tc.campaign_name)) || tabName;
  } catch (_) {
    return tabName;
  }
}

/**
 * 한글 자연어 이벤트 로그 기록.
 * @returns {ok, id?, skipped?} — skipped=true 는 미해결 중복(부분유니크)으로 새로 쌓지 않은 경우.
 */
async function logReviewerEvent({
  sheetId = '', tabName = '', tabGid = null,
  reviewerName = '', phone8 = '',
  eventType, severity = 'warn', message,
  context = {}, orderSubmissionId = null,
  resolved = false, // info성(자동 보정 완료 등)은 처음부터 해결 처리 = 이력에만 남김
} = {}) {
  if (!eventType || !message) return { ok: false, error: 'eventType/message 필수' };
  const campaignName = await _resolveCampaignLabel(sheetId, tabName);
  const { rows } = await getPool().query(
    `INSERT INTO reviewer_event_logs
       (sheet_id, tab_name, tab_gid, campaign_name, reviewer_name, phone8,
        event_type, severity, message, context, order_submission_id, resolved_at, resolved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,
             CASE WHEN $12 THEN NOW() ELSE NULL END,
             CASE WHEN $12 THEN 'auto' ELSE NULL END)
     ON CONFLICT (event_type, order_submission_id)
       WHERE resolved_at IS NULL AND order_submission_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [sheetId, tabName, tabGid, campaignName, reviewerName, String(phone8 || ''),
     eventType, severity, message, JSON.stringify(context || {}), orderSubmissionId, !!resolved]
  );
  if (!rows.length) return { ok: true, skipped: true };

  // critical 신규 → 관리자 실시간 알림(SSE). 실패해도 로그 기록은 유효(best-effort).
  if (severity === 'critical' && !resolved) {
    try {
      const sse = require('../utils/sse');
      if (typeof sse.emitReviewerAlert === 'function') {
        sse.emitReviewerAlert({
          id: rows[0].id, eventType, severity,
          campaignName, tabName, reviewerName,
          message,
        });
      }
    } catch (e) {
      logger.warn(`[reviewer-log] SSE 알림 실패(무시): ${e.message}`);
    }
  }
  return { ok: true, id: rows[0].id };
}

/** 로그 목록 — 미해결 우선 + 최신순. 필터: sheetId/tabName/severity/eventType/unresolvedOnly */
async function listReviewerEvents({
  sheetId = '', tabName = '', severity = '', eventType = '',
  unresolvedOnly = false, limit = 100, offset = 0,
} = {}) {
  const cond = ['1=1'];
  const params = [];
  const add = (sql, v) => { params.push(v); cond.push(sql.replace('?', `$${params.length}`)); };
  if (sheetId) add('sheet_id = ?', sheetId);
  if (tabName) add('tab_name = ?', tabName);
  if (severity) add('severity = ?', severity);
  if (eventType) add('event_type = ?', eventType);
  if (unresolvedOnly) cond.push('resolved_at IS NULL');
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const limIdx = params.length;
  params.push(Math.max(parseInt(offset, 10) || 0, 0));
  const offIdx = params.length;

  const { rows } = await getPool().query(
    `SELECT id, occurred_at AS "occurredAt", sheet_id AS "sheetId", tab_name AS "tabName",
            campaign_name AS "campaignName", reviewer_name AS "reviewerName", phone8,
            event_type AS "eventType", severity, message, context,
            order_submission_id AS "orderSubmissionId",
            resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"
       FROM reviewer_event_logs
      WHERE ${cond.join(' AND ')}
      ORDER BY (resolved_at IS NULL) DESC, occurred_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );
  return rows;
}

/** 미해결 카운트(전체/critical) — 관리자 배지·알림 카드용 */
async function unresolvedCounts() {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical
       FROM reviewer_event_logs WHERE resolved_at IS NULL`
  );
  return rows[0] || { total: 0, critical: 0 };
}

/** 확인(해결) 처리 — 이미 해결된 로그는 no-op */
async function resolveReviewerEvent(id, by = 'admin') {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'id 필요' };
  const { rowCount } = await getPool().query(
    `UPDATE reviewer_event_logs SET resolved_at = NOW(), resolved_by = $2
      WHERE id = $1 AND resolved_at IS NULL`,
    [n, String(by || 'admin').slice(0, 100)]
  );
  return { ok: true, resolved: rowCount > 0 };
}

/**
 * 자동 해결 — 원인이 소멸된 미해결 로그를 정리해 알림 창을 "지금 문제만" 보이게 유지.
 *   - order_lost/order_unmirrored: 주문이 written 복귀(재기록 성공) 시
 *   - order_no_capture: 캡처가 뒤늦게 연결된 경우
 */
async function autoResolveHealed() {
  const db = getPool();
  const r1 = await db.query(
    `UPDATE reviewer_event_logs l SET resolved_at = NOW(), resolved_by = 'auto:written'
      WHERE l.resolved_at IS NULL AND l.event_type IN ('order_lost','order_unmirrored')
        AND l.order_submission_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM order_submissions os
                     WHERE os.id = l.order_submission_id AND os.mirror_status = 'written')`
  );
  const r2 = await db.query(
    `UPDATE reviewer_event_logs l SET resolved_at = NOW(), resolved_by = 'auto:capture'
      WHERE l.resolved_at IS NULL AND l.event_type = 'order_no_capture'
        AND l.order_submission_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM order_submissions os
                     WHERE os.id = l.order_submission_id AND os.capture_uploaded_at IS NOT NULL)`
  );
  return { healedWritten: r1.rowCount || 0, healedCapture: r2.rowCount || 0 };
}

module.exports = {
  logReviewerEvent,
  listReviewerEvents,
  unresolvedCounts,
  resolveReviewerEvent,
  autoResolveHealed,
  __setPoolForTest,
};
