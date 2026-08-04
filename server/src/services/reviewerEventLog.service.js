// ═══════════════════════════════════════════════════════════
// 리뷰어 비정상 이벤트 — 캠페인별 한글 자연어 로그 원장 (migration 062)
//
// 소비처: 리뷰웹시스템[3버전](workdesk.html) "리뷰어 로그" 창 + 관리자 대시보드 중요알림 카드.
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

/** (sheetId,tabName) 화이트리스트 → SQL 조건 조각. scopeTabs=null이면 제한 없음(master/admin). */
function _scopeCond(scopeTabs, cond, params) {
  if (!Array.isArray(scopeTabs)) return true;
  if (!scopeTabs.length) return false;                    // 담당 탭 0 = 열람 대상 없음
  const pairs = scopeTabs.map((t) => {
    params.push(t.sheetId, t.tabName);
    return `(sheet_id = $${params.length - 1} AND tab_name = $${params.length})`;
  });
  cond.push(`(${pairs.join(' OR ')})`);
  return true;
}

/** 로그 목록 — 미해결 우선 + 최신순. 필터: sheetId/tabName/severity/eventType/unresolvedOnly/scopeTabs */
// ── 로그 한 문장(message) → 표 컬럼용 분해: 오류내용(problem) / 조치안내(action) ──
// ★ message 컬럼은 그대로 둔다(관리자 대시보드 중요알림·SSE가 그 문장을 그대로 쓴다).
//   여기서는 문장을 파싱하지 않고 event_type + context 로 다시 만든다 →
//   ① 과거에 쌓인 로그에도 똑같이 적용되고 ② 문구를 바꿔도 화면이 안 깨진다.
// 모르는 유형은 빈 값 → 프론트가 message 원문으로 폴백(새 유형이 생겨도 화면이 비지 않음).
function describeEvent(row = {}) {
  const t = row.eventType || row.event_type || '';
  const c = (row.context && typeof row.context === 'object') ? row.context : {};
  const sev = row.severity || 'warn';
  const at = (v) => (v === 0 || v ? String(v) : '');
  switch (t) {
    case 'order_lost':
      return {
        problem: `구매양식이 시트에서 사라짐${at(c.row) ? `(기록됐던 ${at(c.row)}행이 다른 내용으로 바뀜)` : ''}.`,
        action: '자동 재기록을 진행합니다 — 반영되면 시트 하단 행 비고에 [시스템 재기록 · 확인요망]으로 표기됩니다.',
      };
    case 'order_lost_manual':
      return {
        problem: `구매양식이 시트에서 반복 소실되어 자동 재기록을 중단함${at(c.row) ? `(마지막 기록 ${at(c.row)}행)` : ''}.`,
        action: "수동 확인·입력이 필요(관리자 대시보드 '구매주문 시트반영 현황' 참조).",
      };
    case 'order_row_shifted':
      return {
        problem: `기록 행이 ${at(c.oldRow) || '?'}→${at(c.newRow) || '?'}행으로 이동됨(시트 중간 행 삽입·정렬 감지).`,
        action: '자동 보정 완료 — 조치 불필요.',
      };
    case 'order_row_ambiguous':
      return {
        problem: `기록 행(${at(c.row) || '?'}행)이 실제 시트 내용과 달라졌으나, 같은 신원의 행이 여러 개라 자동 보정하지 못함.`,
        action: '시트 확인 필요.',
      };
    case 'order_unmirrored': {
      const manual = sev === 'critical' || c.mirrorStatus === 'stuck_manual';
      return manual
        ? {
          problem: '구매양식을 제출했으나, 시트에 입력되지 못함.',
          action: "자동 재기록이 중단되어 수동 입력이 필요(관리자 대시보드 '구매주문 시트반영 현황' 참조).",
        }
        : {
          problem: `구매양식을 제출했으나, 아직 시트에 입력되지 못함${at(c.mirrorStatus) ? `(상태: ${at(c.mirrorStatus)})` : ''}.`,
          action: '자동복구 대기 중 — 조치 불필요.',
        };
    }
    case 'order_no_capture':
      return { problem: '구매양식을 제출했으나, 구매캡쳐를 첨부하지 않았음.', action: '구매캡쳐 보완 필요.' };
    case 'capture_mismatch': {
      let slot = at(c.slotKey) || '캡처';
      try { slot = require('../utils/captureSlots').slotLabel(null, '', c.slotKey) || slot; } catch (_) { /* 라벨 실패는 key 그대로 */ }
      const pct = Number(c.confidence) > 0 ? `(AI 확신 ${Math.round(Number(c.confidence) * 100)}%)` : '';
      return {
        problem: `${slot} 캡처 자리에 다른 형식의 이미지가 올라옴${pct}.`,
        action: c.sure
          ? '리뷰어 화면에 재첨부 안내가 표시됨 — 확인 필요.'
          : '캡처 형식 확인 필요(확신도가 낮아 오탐일 수 있음).',
      };
    }
    default:
      return { problem: '', action: '' };
  }
}

async function listReviewerEvents({
  sheetId = '', tabName = '', severity = '', eventType = '',
  unresolvedOnly = false, limit = 100, offset = 0, scopeTabs = null,
} = {}) {
  const cond = ['1=1'];
  const params = [];
  const add = (sql, v) => { params.push(v); cond.push(sql.replace('?', `$${params.length}`)); };
  if (sheetId) add('sheet_id = ?', sheetId);
  if (tabName) add('tab_name = ?', tabName);
  if (severity) add('severity = ?', severity);
  if (eventType) add('event_type = ?', eventType);
  if (unresolvedOnly) cond.push('resolved_at IS NULL');
  if (!_scopeCond(scopeTabs, cond, params)) return [];
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  const limIdx = params.length;
  params.push(Math.max(parseInt(offset, 10) || 0, 0));
  const offIdx = params.length;

  const { rows } = await getPool().query(
    `SELECT id, occurred_at AS "occurredAt", sheet_id AS "sheetId", tab_name AS "tabName",
            tab_gid AS "tabGid",
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
  // 표 컬럼(오류내용/조치안내) 동봉 — message 원문은 그대로 두고 추가만 한다
  return rows.map(r => Object.assign(r, describeEvent(r)));
}

/** 미해결 카운트(전체/critical) — 관리자 배지·알림 카드용. scopeTabs 지정 시 그 탭들만. */
async function unresolvedCounts(scopeTabs = null) {
  const cond = ['resolved_at IS NULL'];
  const params = [];
  if (!_scopeCond(scopeTabs, cond, params)) return { total: 0, critical: 0, byTypeCritical: {} };
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical
       FROM reviewer_event_logs WHERE ${cond.join(' AND ')}`,
    params
  );
  // 미해결 critical을 event_type별로 집계 — 대시보드 유형별 요약 카드용(라이브 개수, 스코프 동일)
  const byTypeCritical = {};
  try {
    const { rows: t } = await getPool().query(
      `SELECT event_type AS "eventType", COUNT(*)::int AS n
         FROM reviewer_event_logs
        WHERE ${cond.join(' AND ')} AND severity = 'critical'
        GROUP BY event_type`,
      params
    );
    for (const r of t) byTypeCritical[r.eventType] = r.n;
  } catch (_) { /* 집계 실패는 요약만 비고 total/critical은 유지 */ }
  return Object.assign(rows[0] || { total: 0, critical: 0 }, { byTypeCritical });
}

// ★ "시트에서 지운 게 사실은 취소였다"를 1클릭으로 알려주는 경로의 대상 이벤트.
//   시스템은 시트만 봐서는 "사람이 의도로 지움" vs "사고로 사라짐"을 구별할 수 없어 기본이 '재기록'이다.
//   사람이 이 버튼을 누르는 것이 유일하게 신뢰 가능한 의도 신호다.
const CANCELABLE_EVENTS = new Set(['order_lost', 'order_lost_manual', 'order_unmirrored']);

/**
 * 알림에 걸린 주문을 취소로 확정 — 재기록(reconcile)·사후검증 대상에서 함께 빠진다
 * (둘 다 `deleted_at IS NULL` 필터라 소프트삭제만으로 되살아남이 멈춘다).
 * 시트에 행이 남아 있으면 기존 `order_cancel` 큐로 그 행을 비운다 — 큐의 신원검증이
 * "그 사이 다른 사람이 쓴 행"은 건드리지 않도록 막아준다(남의 데이터 파괴 불가).
 */
async function cancelOrderFromEvent({ id, by = 'admin' } = {}) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'id 필요' };
  const db = getPool();
  const { rows: lg } = await db.query(
    `SELECT id, event_type, order_submission_id FROM reviewer_event_logs WHERE id = $1`, [n]
  );
  if (!lg.length) return { ok: false, error: '알림을 찾을 수 없습니다.' };
  const log = lg[0];
  if (!log.order_submission_id) return { ok: false, error: '연결된 주문이 없는 알림입니다.' };
  if (!CANCELABLE_EVENTS.has(log.event_type)) return { ok: false, error: '이 알림은 주문취소 대상이 아닙니다.' };

  const osId = log.order_submission_id;
  const canceledBy = String(by || 'admin').slice(0, 100);
  const { withJobLock } = require('../utils/jobLock');
  const out = await withJobLock('order_ledger:' + osId, async () => {
    const { rows } = await db.query(
      `UPDATE order_submissions SET deleted_at = NOW(), canceled_by = $2, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
      RETURNING sheet_row, mirror_status`,
      [osId, canceledBy]
    );
    if (!rows.length) return { already: true };
    return { sheetRow: rows[0].sheet_row };
  });
  if (out && out.skipped) return { ok: false, error: '다른 편집/취소가 진행 중입니다. 잠시 후 다시 시도해주세요.' };

  if (out && !out.already) {
    // 시트 행이 남아 있고 시트쓰기가 켜져 있으면 그 행 비우기를 큐에 위임(신원검증은 큐가 수행).
    // 그 외(행 없음·쓰기 비활성)는 DB 상태만 확정 — 취소 자체는 항상 성립해야 한다(되살아남 중단이 목적).
    if (out.sheetRow && process.env.ORDER_LEDGER_WRITE_ENABLED === 'true') {
      try {
        await require('./syncQueue.service').enqueue('order_cancel', { orderSubmissionId: osId });
        require('../jobs/queuePump').kickQueuePump();
      } catch (e) {
        logger.warn(`[reviewer-log] 취소 시트반영 큐 등록 실패(무시, DB취소는 확정): ${e.message}`);
      }
    } else {
      await db.query(
        `UPDATE order_submissions SET mirror_status = 'canceled' WHERE id = $1 AND mirror_status <> 'canceled'`,
        [osId]
      );
    }
  }

  // 이 알림 + 같은 주문의 다른 미해결 알림을 함께 정리(원인이 소멸했으므로).
  await db.query(
    `UPDATE reviewer_event_logs SET resolved_at = NOW(), resolved_by = $2
      WHERE id = $1 AND resolved_at IS NULL`,
    [n, ('취소처리:' + canceledBy).slice(0, 100)]
  );
  await db.query(
    `UPDATE reviewer_event_logs SET resolved_at = NOW(), resolved_by = 'auto:canceled'
      WHERE order_submission_id = $1 AND resolved_at IS NULL`,
    [osId]
  );
  return { ok: true, canceled: !(out && out.already), alreadyCanceled: !!(out && out.already) };
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
  // 취소·삭제된 주문의 로그는 원인 자체가 소멸 → 수동 [확인] 없이 정리(잔존 노이즈 방지)
  const r3 = await db.query(
    `UPDATE reviewer_event_logs l SET resolved_at = NOW(), resolved_by = 'auto:canceled'
      WHERE l.resolved_at IS NULL AND l.order_submission_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM order_submissions os
                     WHERE os.id = l.order_submission_id
                       AND (os.deleted_at IS NOT NULL OR os.mirror_status = 'canceled'))`
  );
  return { healedWritten: r1.rowCount || 0, healedCapture: r2.rowCount || 0, healedCanceled: r3.rowCount || 0 };
}

module.exports = {
  logReviewerEvent,
  listReviewerEvents,
  describeEvent,
  unresolvedCounts,
  resolveReviewerEvent,
  cancelOrderFromEvent,
  CANCELABLE_EVENTS,
  autoResolveHealed,
  __setPoolForTest,
};
