/**
 * Phase 8: SSE (Server-Sent Events) 모듈
 * 관리자 대시보드에 실시간 알림 전달
 *
 * 이벤트 유형:
 *   - review_submit:   리뷰 제출 완료
 *   - order_submit:    구매양식 제출 완료
 *   - image_extract:   AI 이미지 분석 완료
 *   - image_upload:    이미지 Drive 업로드 완료
 *   - index_build:     인덱스 빌드 완료
 *   - system:          시스템 알림 (에러 등)
 */
const { logger } = require('./logger');

// ── 연결 풀 ──
const clients = new Map();  // id → { res, connectedAt, lastPing }
let nextClientId = 1;

const MAX_CLIENTS = 50;       // 최대 동시 SSE 연결
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
 */
function addClient(req, res) {
  // 연결 수 제한
  if (clients.size >= MAX_CLIENTS) {
    // 가장 오래된 연결 제거
    const oldest = [...clients.entries()].sort((a, b) => a[1].connectedAt - b[1].connectedAt)[0];
    if (oldest) {
      try { oldest[1].res.end(); } catch (_) {}
      clients.delete(oldest[0]);
      logger.info(`[SSE] 최대 연결 초과 — 클라이언트 ${oldest[0]} 해제`);
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
 * 모든 연결된 클라이언트에 이벤트 브로드캐스트
 * @param {string} eventType - 이벤트 유형 (event: 필드)
 * @param {object} data - 이벤트 데이터
 */
function broadcast(eventType, data) {
  const payload = JSON.stringify({
    type: eventType,
    ts: Date.now(),
    ...data,
  });

  const message = `event: ${eventType}\ndata: ${payload}\n\n`;
  let sent = 0;
  const failed = [];

  for (const [id, client] of clients) {
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

module.exports = {
  addClient,
  broadcast,
  getStatus,
  emitReviewSubmit,
  emitOrderSubmit,
  emitImageExtract,
  emitImageUpload,
  emitIndexBuild,
  emitSystem,
};
