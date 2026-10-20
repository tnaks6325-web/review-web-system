// ═══════════════════════════════════════════════════════════════════════════
// 양방향 4단계 — 리뷰웹 → 인트라넷 공유 글 칸 송신 (결정 263)
//
// 대기열(`shared_sync_outbox`)은 공유 저장(`applySharedPatch`)이 같은 트랜잭션에서 쌓는다. 여기서는 보내기만 한다.
// ★★ 보내는 값 = 보내는 순간의 작업오더 현재 상태(가장 새 버전) — 쌓인 줄이 여러 개여도 오더당 한 번만 보낸다.
//    그 오더의 더 옛 줄은 함께 정리한다(superseded). 인트라넷은 더 큰 버전만 받는다(같거나 작으면 stale).
// ★★ 서명 = 전용 비밀값 `BIDIR_RW_TO_IN_SECRET`(완화 금지) — CS 중계 키(`INTRANET_WEBHOOK_KEY`)는 외부로 실려
//    나가므로 그것만으로 인트라넷 데이터를 바꾸게 하지 않는다. 인트라넷은 받은 원문 그대로 서명을 검증한다.
//    비밀값·주소가 없으면 보내지 않는다(쌓이기만 — 테스트 서버가 운영 인트라넷으로 보내지 않게).
// ★ 응답별: applied/stale = delivered(+ 인트라넷이 이 버전을 안다고 적음) · held/busy·5xx·연결 실패 = 다시(점점 늦게) ·
//   receiver_off/observed/서명·권한 거부 = parked(사람이 켠 뒤 다시 보낸다) · 404(모르는 원본) = dead.
// ★ 송신 중(sending)이 5분 넘게 남아 있으면 다른 처리기가 다시 가져간다(중간에 끊긴 처리기). 한 번 돌기 최악 = 20줄 × 10초 = 200초라
//   그보다 길게 잡고, 보내기 직전에 그 오더 줄의 시각을 갱신한다. 같은 프로세스 안에서는 앞 실행이 안 끝났으면 건너뛴다(cron 은 겹쳐 돈다).
// ★ 보류(parked — 수신 꺼짐·관찰·서명/권한 거부)는 30분마다 다시 확인한다(켜진 뒤 저절로 간다). 보류 재확인은 시도 횟수에 넣지 않는다.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const getPool = () => require('../db/pool');
const { logger } = require('../utils/logger');
const { readBidirSwitch } = require('../utils/bidirSwitch');
const { readSharedState, PUSH_VIEW_KEYS } = require('./sharedPatch.service');

const BATCH = 20;
const MAX_ATTEMPTS = 60;
const SEND_TIMEOUT_MS = 10_000;

/** 다시 보낼 때까지 기다리는 시간 — 15초에서 두 배씩, 최대 10분. */
function backoffMs(attempts) {
  return Math.min(15_000 * 2 ** Math.max(0, Number(attempts || 1) - 1), 600_000);
}

/** 서명 머리 — `t=<ms>,v1=<hex HMAC-SHA256(secret, t + '.' + 본문)>`. */
function signBody(secret, rawBody, t = Date.now()) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** 인트라넷 응답 → 처리 결과. 판정은 이 한 곳에서만 한다. */
function classifyResponse(status, body) {
  const code = String(body && body.code || '');
  const result = String(body && body.result || '');
  if (status === 200 && body && body.ok === true && (result === 'applied' || result === 'stale')) return { next: 'delivered', ack: true, result };
  if (code === 'receiver_off' || result === 'observed') return { next: 'parked', result: code || result };
  if (status === 404) return { next: 'dead', result: code || 'unknown_source' };
  if (code === 'remote_mismatch') return { next: 'dead', result: code };   // 다른 작업오더에 붙은 원본 — 다시 보내도 안 맞는다
  if ([400, 401, 403].includes(status)) return { next: 'parked', result: code || `http_${status}` };
  return { next: 'retry', result: code || result || `http_${status}` };
}

/** 보낼 본문 — 3단계 글 칸 + 5단계 금액(리뷰비 · 상품 구성 · 결제합계 · 상품 요약 문장). 인트라넷 수정 창이 덮는 칸과 같다. */
function buildPushBody(wo) {
  const state = readSharedState(wo);
  const view = {};
  for (const k of PUSH_VIEW_KEYS) if (Object.prototype.hasOwnProperty.call(state, k)) view[k] = state[k];
  return { event: 'shared_state', source_review_order_id: String(wo.source_review_order_id || ''), work_order_id: wo.id, sync_version: Number(wo.sync_version), view };
}

async function _claim(db) {
  const { rows } = await db.query(
    `UPDATE shared_sync_outbox o SET status = 'sending', attempts = o.attempts + CASE WHEN o.status = 'parked' THEN 0 ELSE 1 END, updated_at = NOW()
      WHERE o.id IN (
        SELECT id FROM shared_sync_outbox
         WHERE (status = 'pending' AND next_at <= NOW())
            OR (status = 'sending' AND updated_at < NOW() - INTERVAL '5 minutes')
            OR (status = 'parked' AND updated_at < NOW() - INTERVAL '30 minutes')
         ORDER BY next_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING o.*`, [BATCH]);
  return rows;
}

async function _finish(db, ids, status, err, nextAt) {
  await db.query(
    `UPDATE shared_sync_outbox SET status = $2, last_error = $3, next_at = COALESCE($4::timestamptz, next_at), updated_at = NOW()
      WHERE id = ANY($1::bigint[]) AND status = 'sending'`,
    [ids, status, String(err || '').slice(0, 500), nextAt ? new Date(nextAt).toISOString() : null]);
}

/**
 * 한 번 돌린다(15초 cron). 반환 = 처리 요약.
 * @param {{ db?: object, fetchImpl?: Function, env?: object, now?: number }} [opts] 시험용
 */
let _running = false;

async function runSharedSyncPush(opts = {}) {
  if (_running) return { skipped: 'running' };
  _running = true;
  try { return await _runOnce(opts); } finally { _running = false; }
}

async function _runOnce(opts) {
  const db = opts.db || getPool();
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const sw = await readBidirSwitch(db, { env });
  if (sw.push !== 'on') return { skipped: 'switch_off' };
  const url = String(env.INTRANET_ORDER_DELETE_WEBHOOK_URL || '').trim();
  const secret = String(env.BIDIR_RW_TO_IN_SECRET || '').trim();
  if (!url || !secret) return { skipped: 'config' };

  const claimed = await _claim(db);
  if (!claimed.length) return { sent: 0 };
  const byWo = new Map();
  for (const r of claimed) { if (!byWo.has(r.work_order_id)) byWo.set(r.work_order_id, []); byWo.get(r.work_order_id).push(r); }
  const summary = { sent: 0, delivered: 0, retry: 0, parked: 0, dead: 0 };

  for (const [woId, rows] of byWo) {
    const ids = rows.map(r => Number(r.id));
    const attempts = Math.max(...rows.map(r => Number(r.attempts || 1)));
    try {
      const { rows: wos } = await db.query('SELECT * FROM work_orders WHERE id = $1', [woId]);
      const wo = wos[0];
      if (!wo || wo.deleted_at || wo.bidir_state !== 'on' || !String(wo.source_review_order_id || '').trim()) {
        await _finish(db, ids, 'dead', '연결이 끊겼거나 지워진 오더');
        summary.dead++; continue;
      }
      const body = buildPushBody(wo);
      const raw = JSON.stringify(body);
      // 보내기 직전 시각 갱신 — 앞 오더들이 오래 걸려도 다른 처리기가 이 줄을 "끊긴 줄" 로 다시 가져가지 않게.
      await db.query(`UPDATE shared_sync_outbox SET updated_at = NOW() WHERE id = ANY($1::bigint[]) AND status = 'sending'`, [ids]);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
      let status = 0, resBody = null;
      try {
        const resp = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Review-Key': env.INTRANET_WEBHOOK_KEY || '', 'X-Bidir-Signature': signBody(secret, raw) },
          body: raw, signal: ctrl.signal,
        });
        status = resp.status;
        try { resBody = await resp.json(); } catch (_) { resBody = null; }
      } catch (e) {
        resBody = { code: e && e.name === 'AbortError' ? 'timeout' : 'network' };
      } finally {
        clearTimeout(timer);
      }
      summary.sent++;
      const c = classifyResponse(status, resBody);
      if (c.next === 'delivered') {
        await _finish(db, ids, 'delivered', c.result === 'stale' ? '인트라넷이 이미 같거나 더 새 버전을 가짐' : '');
        // 이 버전까지는 인트라넷 사본이 같다 — 그 오더의 더 옛 대기 줄은 보낼 필요가 없다.
        await db.query(
          `UPDATE shared_sync_outbox SET status = 'superseded', updated_at = NOW()
            WHERE work_order_id = $1 AND sync_version <= $2 AND status IN ('pending', 'parked')`, [woId, body.sync_version]);
        if (c.result === 'applied') {
          await db.query(
            `UPDATE work_orders SET intranet_acked_version = GREATEST(COALESCE(intranet_acked_version, 0), $2::bigint) WHERE id = $1`,
            [woId, String(body.sync_version)]);
        }
        summary.delivered++;
      } else if (c.next === 'retry' && attempts < MAX_ATTEMPTS) {
        await _finish(db, ids, 'pending', c.result, (opts.now || Date.now()) + backoffMs(attempts));
        summary.retry++;
      } else if (c.next === 'parked') {
        await _finish(db, ids, 'parked', c.result);
        summary.parked++;
      } else {
        await _finish(db, ids, 'dead', c.result || '재시도 한도 초과');
        summary.dead++;
      }
    } catch (e) {
      logger.warn(`[bidir/push] ${woId} 송신 처리 실패(다시 시도): ${e.message}`);
      try { await _finish(db, ids, 'pending', e.message, (opts.now || Date.now()) + backoffMs(attempts)); } catch (_) { /* 2분 뒤 다시 가져간다 */ }
      summary.retry++;
    }
  }
  if (summary.sent) logger.info(`[bidir/push] 보냄 ${summary.sent} · 반영 ${summary.delivered} · 다시 ${summary.retry} · 보류 ${summary.parked} · 중단 ${summary.dead}`);
  return summary;
}

module.exports = { runSharedSyncPush, classifyResponse, buildPushBody, signBody, backoffMs, MAX_ATTEMPTS };
