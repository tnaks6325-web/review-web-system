/**
 * Phase 8: SSE (Server-Sent Events) 모듈
 * 관리자 대시보드에 실시간 알림 전달
 *
 * 이벤트 유형:
 *   - review_submit:   리뷰 제출 완료
 *   - order_submit:    구매양식 제출 완료
 *   - order_update:    작업오더 인박스 수정 (인트라넷 동기화)
 *   - work_order_new:  작업오더 신규 제출/재제출 (관리자向)
 *   - image_extract:   AI 이미지 분석 완료
 *   - image_upload:    이미지 Drive 업로드 완료
 *   - index_build:     인덱스 빌드 완료
 *   - system:          시스템 알림 (에러 등)
 *   - cs_new_inquiry:  C/S 새 문의 (관리자向)
 *   - cs_message:      C/S 신규 메시지 (관리자向 / 리뷰어向 타깃)
 *
 * 클라이언트 메타(meta):
 *   { role: 'admin' }                 — 관리자 대시보드 (기본)
 *   { role: 'reviewer', phone8: '..' } — 리뷰어 본인 (C/S 실시간 답장 수신)
 */
const { logger } = require('./logger');

// ── 연결 풀 ──
const clients = new Map();  // id → { res, connectedAt, lastPing, meta }
let nextClientId = 1;

const MAX_CLIENTS = 200;      // 최대 동시 SSE 연결 (관리자 + 리뷰어 공용)
const HEARTBEAT_MS = 30000;   // 30초마다 ping

// ── 하트비트 (연결 유지) ──
const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    try {
      client.res.write(`:ping ${now}\n\n`);
      client.lastPing = now;
    } catch (err) {
      logger.warn(`[SSE] 클라이언트 ${id} ping 실패 — 제거`);
      clients.delete(id);
    }
  }
}, HEARTBEAT_MS);

// 프로세스 종료 시 타이머 정리
if (typeof process !== 'undefined') {
  process.on('SIGTERM', () => clearInterval(heartbeatTimer));
  process.on('SIGINT', () => clearInterval(heartbeatTimer));
}

/**
 * SSE 연결 등록 (Express 라우트 핸들러에서 호출)
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} [meta] - { role:'admin' } | { role:'reviewer', phone8 }
 */
function addClient(req, res, meta = { role: 'admin' }) {
  // 연결 수 제한 — 초과 시 가장 오래된 '리뷰어' 연결부터 제거(관리자 우선 보호)
  if (clients.size >= MAX_CLIENTS) {
    const sorted = [...clients.entries()].sort((a, b) => a[1].connectedAt - b[1].connectedAt);
    const victim = sorted.find(([, c]) => c.meta && c.meta.role === 'reviewer') || sorted[0];
    if (victim) {
      try { victim[1].res.end(); } catch (_) {}
      clients.delete(victim[0]);
      logger.info(`[SSE] 최대 연결 초과 — 클라이언트 ${victim[0]} 해제`);
    }
  }

  const clientId = nextClientId++;
  
  // SSE 헤더 설정
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',          // Nginx 프록시 버퍼링 방지
    'Access-Control-Allow-Origin': '*',
  });

  // 초기 연결 메시지
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId, ts: Date.now() })}\n\n`);

  clients.set(clientId, {
    res,
    connectedAt: Date.now(),
    lastPing: Date.now(),
    ip: req.ip,
    meta: meta || { role: 'admin' },
  });

  logger.info(`[SSE] 클라이언트 ${clientId} 연결 (현재 ${clients.size}명)`);

  // 연결 종료 처리
  req.on('close', () => {
    clients.delete(clientId);
    logger.info(`[SSE] 클라이언트 ${clientId} 연결 해제 (현재 ${clients.size}명)`);
  });

  return clientId;
}

/**
 * 연결된 클라이언트에 이벤트 브로드캐스트
 * @param {string} eventType - 이벤트 유형 (event: 필드)
 * @param {object} data - 이벤트 데이터
 * @param {(client:object)=>boolean} [filterFn] - 수신 대상 필터.
 *        미지정 시 기본은 관리자(role==='admin') 전용 — 리뷰어에게 관리자 알림이 새지 않도록.
 */
function broadcast(eventType, data, filterFn) {
  const payload = JSON.stringify({
    type: eventType,
    ts: Date.now(),
    ...data,
  });

  const match = typeof filterFn === 'function'
    ? filterFn
    : (client) => !client.meta || client.meta.role === 'admin';

  const message = `event: ${eventType}\ndata: ${payload}\n\n`;
  let sent = 0;
  const failed = [];

  for (const [id, client] of clients) {
    if (!match(client)) continue;
    try {
      client.res.write(message);
      sent++;
    } catch (err) {
      failed.push(id);
    }
  }

  // 실패한 연결 정리
  for (const id of failed) {
    clients.delete(id);
  }

  if (sent > 0 || failed.length > 0) {
    logger.debug(`[SSE] broadcast "${eventType}" → ${sent}명 전송, ${failed.length}명 실패`);
  }
}

/**
 * 현재 SSE 연결 상태 반환 (디버그/메트릭용)
 */
function getStatus() {
  return {
    activeConnections: clients.size,
    maxConnections: MAX_CLIENTS,
    clients: [...clients.entries()].map(([id, c]) => ({
      id,
      connectedAt: new Date(c.connectedAt).toISOString(),
      lastPing: new Date(c.lastPing).toISOString(),
      ip: c.ip,
    })),
  };
}

// ── 편의 함수: 자주 사용하는 이벤트 ──

function emitReviewSubmit(data) {
  broadcast('review_submit', {
    message: `리뷰 제출: ${data.tabName || ''} — ${data.reviewer || ''}`,
    ...data,
  });
}

function emitOrderSubmit(data) {
  broadcast('order_submit', {
    message: `구매양식 제출: ${data.tabName || ''} — ${data.orderer || ''}`,
    ...data,
  });
}

function emitOrderUpdate(data) {
  broadcast('order_update', {
    message: `작업오더 수정: ${data.title || ''}`,
    ...data,
  });
}

// 작업오더 신규 제출(AE submit / 인트라넷 intake) + 보완 재제출(revision→submitted)
function emitWorkOrderNew(data) {
  broadcast('work_order_new', {
    message: `새 작업오더: ${data.title || ''} — ${data.created_by || ''}${data.resubmitted ? ' (재제출)' : ''}`,
    ...data,
  });
}

// ── 주문 원장(order ledger) — 편집/취소/수동추가/큐 상태변경 단일 이벤트(PR-B) ──
//   PII 차단: action/orderSubmissionId/mirror_status/field 만. newValue·oldValue·phone·address 절대 미포함.
//   ('order_update' 이벤트명은 작업오더가 점유 → 'order_ledger' 신규명 사용)
function emitOrderLedger(data) {
  broadcast('order_ledger', {
    action: data.action || '',
    orderSubmissionId: data.orderSubmissionId || null,
    mirror_status: data.mirror_status || null,
    field: data.field || null,
  });
}

function emitImageExtract(data) {
  broadcast('image_extract', {
    message: `AI 분석 완료: ${data.fileName || '이미지'}`,
    ...data,
  });
}

function emitImageUpload(data) {
  broadcast('image_upload', {
    message: `이미지 업로드: ${data.fileName || '파일'}`,
    ...data,
  });
}

function emitIndexBuild(data) {
  broadcast('index_build', {
    message: `인덱스 빌드 완료: ${data.rebuilt || 0}건 갱신`,
    ...data,
  });
}

function emitSystem(message, level = 'info') {
  broadcast('system', { message, level });
}

// ── C/S 문의 ──

/** 리뷰어가 새 메시지/문의를 남김 → 관리자 전원에게 알림 */
function emitCsInquiry(data) {
  // 새 스레드면 cs_new_inquiry, 기존 스레드면 cs_message — 둘 다 관리자向(기본 필터)
  const evt = data.isNew ? 'cs_new_inquiry' : 'cs_message';
  broadcast(evt, {
    message: `C/S 문의: ${data.reviewerName || ''} — ${data.campaignLabel || ''}`,
    ...data,
  });
}

/** 관리자가 답장 → 해당 리뷰어(phone8) 연결에만 타깃 전송 */
function emitCsReplyToReviewer(phone8, data) {
  broadcast('cs_message', data, (c) => c.meta && c.meta.role === 'reviewer' && c.meta.phone8 === phone8);
}

module.exports = {
  addClient,
  broadcast,
  getStatus,
  emitReviewSubmit,
  emitOrderSubmit,
  emitOrderUpdate,
  emitWorkOrderNew,
  emitOrderLedger,
  emitImageExtract,
  emitImageUpload,
  emitIndexBuild,
  emitSystem,
  emitCsInquiry,
  emitCsReplyToReviewer,
};
