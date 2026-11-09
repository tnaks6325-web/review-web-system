'use strict';
/**
 * campaignHoldChain.service.js — 차례 타이머 단일 출처(결정 356 · 레드-블루-심판 최종안)
 *
 * D-P(예상 마감): 차례를 기다리는 명의도 status='applied' + 유한한 미래 expires_at(= 앞 명의 끝 + 자기 TTL, closesAt 에서 자름).
 *   I1 대기 행 = 'applied' + 미래 expires_at — 새 상태 없음(결정 138), NULL·자리표시 시각 없음 → 유효홀드 소비처 20+곳 무수정.
 *   I2 끝남 처리는 "당기기"만(시작·마감을 앞으로만) · 이미 시작한 명의(진행 중)는 손대지 않는다 · 멱등.
 *   I3 차례 줄 소속 = INSERT 때 turn_starts_at IS NOT NULL (뒤에 공고 설정이 바뀌어도 그대로). NULL = 종전(동시) 홀드 — 닻으로만 쓰고 고치지 않는다.
 *   I4 당기기 실패는 본 처리(제출 확정·취소)를 바꾸지 않는다(SAVEPOINT hold_chain) — 실패하면 예상 마감대로 흐른다(넉넉·유한).
 *   I5 만료(스윕)는 훅이 없다 — 다음 명의의 예상 시작이 곧 앞 명의 마감이다.
 * 잠금: 호출측이 recruit_campaigns 행 FOR UPDATE 를 이미 잡은 상태(apply·confirm·수동확정·외부확정·취소 모두 그 접두부).
 *   여기서는 그 뒤에 같은 소유자·공고의 신청 행만 잠근다 — owner/명의 advisory 는 잡지 않는다(순서 위반 없음).
 */
const { logger } = require('../utils/logger');

const MAIN_HOLD_TTL_DEFAULT_MIN = 20;       // R1 — migration 218 DEFAULT 와 같은 값. 서버의 본계정 TTL 폴백은 전부 이 상수.
const MIN_TURN_MS = 10 * 60000;                // R5 최소 차례 — 차례 시작 시 마감까지 10분 이상(답 18·24①)
const SLACK_MS = 5000;                       // 앱 시계(참여)와 DB 시계(당기기) 차이 흡수 — 5초 이내 차이는 고치지 않는다
const chainOn = () => process.env.CAMPAIGN_HOLD_CHAIN !== '0';
const pullOn = () => process.env.CAMPAIGN_HOLD_CHAIN_PULL !== '0';
const ms = v => (v == null ? NaN : (v instanceof Date ? v.getTime() : Date.parse(v)));

/** 공고 단위 자격(참여 화면 표시용 · /apply 는 여기에 Q&A·블로그를 더 본다). 동시진행(네이버+쿠팡)은 제외(RED-30). */
function chainEligibleCampaign(camp) {
  if (!chainOn() || !camp || camp.multi_account_mode !== true) return false;
  try { return !require('../utils/dualChannel').campaignHasDualChannels(camp); } catch (_) { return false; }
}

/** ★ 유일한 차례 규칙(사용자 확정 R5) — /apply 판정과 화면 어림(_chainPreview)이 같은 규칙.
 *  시작 = startMs · 마감 = min(시작 + TTL, closesAt) · 시작 ≥ cutoffAt(= closesAt − close_buffer_min) 이면 거절,
 *  기다리는 명의(시작 > now)는 시작 ≥ closesAt − 10분 이어도 거절(최소 차례 10분).
 *  시간창 없는 공고(closesAt 없음) = 자르기·거절 없음. */
function shapeLink({ startMs, ttlMin, closesMs, cutoffMs, nowMs }) {
  const full = Math.max(1, Number(ttlMin) || 1) * 60000;
  // ★ 사용자 확정(2026-11-09 답 24①): 마감 전 막기(close_buffer_min)를 0으로 둔 공고도 **기다리는 명의**의 차례는
  //   마감까지 최소 10분 남아야 한다. 거절 기준 = min(상태 엔진 cutoffAt, closesAt − 10분).
  //   지금 바로 시작하는 명의(startMs ≤ nowMs · 줄의 첫 명의)는 종전 cutoffAt 만 본다 — 한 명의 참여 동작 불변.
  let cut = cutoffMs;
  const waiting = Number.isFinite(nowMs) && startMs > nowMs;
  if (waiting && Number.isFinite(closesMs)) cut = Number.isFinite(cut) ? Math.min(cut, closesMs - MIN_TURN_MS) : closesMs - MIN_TURN_MS;
  if (Number.isFinite(cut) && !(startMs < cut)) return { refuse: true, turnStartsAt: new Date(startMs) };
  const end = Number.isFinite(closesMs) ? Math.min(startMs + full, closesMs) : startMs + full;
  return { refuse: false, turnStartsAt: new Date(startMs), expiresAt: new Date(end) };
}

/** /apply — 캠페인 행·owner·명의 잠금 안. 꼬리 = 이 소유자의 이 공고 "지금 살아 있는" 홀드 최대 마감(종전 행 포함 · 유예 중 행 제외). */
async function planChainLink(client, { campaignId, ownerP8, ttlMin, now, closesAt, cutoffAt }) {
  const { rows } = await client.query(
    `SELECT MAX(expires_at) AS tail FROM campaign_applications
      WHERE campaign_id = $1 AND COALESCE(owner_phone8, phone8) = $2
        AND status = 'applied' AND expires_at > $3::timestamptz`,
    [campaignId, ownerP8, now.toISOString()]);
  const nowMs = now.getTime();
  const tailMs = rows[0] ? ms(rows[0].tail) : NaN;
  const startMs = Number.isFinite(tailMs) ? Math.max(nowMs, tailMs) : nowMs;
  return { ...shapeLink({ startMs, ttlMin, closesMs: ms(closesAt), cutoffMs: ms(cutoffAt), nowMs }), ttlMin: Math.max(1, Number(ttlMin) || 1) };
}

/** 순수 함수 — 살아 있는 행 집합만 보고 다시 계산(멱등). 진행 중·종전 행 불가침, 대기 행은 앞으로만. */
function computeChainDeadlines(rows, nowMs) {
  const live = rows.filter(r => r.status === 'applied' && ms(r.expires_at) > nowMs);
  let cursor = nowMs;
  for (const r of live) if (r.turn_starts_at == null) cursor = Math.max(cursor, ms(r.expires_at));   // 종전 행 = 닻
  const chained = live.filter(r => r.turn_starts_at != null)
    .sort((a, b) => (ms(a.turn_starts_at) - ms(b.turn_starts_at)) || (Number(a.id) - Number(b.id)));
  const changes = [];
  for (const r of chained) {
    const start = ms(r.turn_starts_at), end = ms(r.expires_at);
    if (start <= nowMs + SLACK_MS) { cursor = Math.max(cursor, end); continue; }          // 진행 중(또는 곧) — 안 건드림
    const ttlMs = Math.max(1, Number(r.chain_ttl_min) || 1) * 60000;
    const ns = Math.min(start, cursor);
    const ne = Math.min(end, ns + ttlMs);                                                  // end 는 이미 closesAt 이하 → 자르기 자동 유지
    if (start - ns > SLACK_MS || end - ne > SLACK_MS) {
      changes.push({ id: r.id, turnStartsAt: new Date(ns), expiresAt: new Date(ne), oldStartsAt: r.turn_starts_at, oldExpiresAt: r.expires_at });
      cursor = Math.max(cursor, ne);
    } else {
      cursor = Math.max(cursor, end);
    }
  }
  return changes;
}

/** 응답용 한 명의 상태(단일 정의): waiting = 차례 줄 + 시작 > now · 그 밖(진행 중·종전) = running. */
function linkView(r, nowMs) {
  const chained = r.turn_starts_at != null;
  return {
    applicationId: r.id,
    sequential: chained,
    state: chained && ms(r.turn_starts_at) > nowMs ? 'waiting' : 'running',
    startsAt: chained ? new Date(ms(r.turn_starts_at)).toISOString() : null,
    expiresAt: new Date(ms(r.expires_at)).toISOString(),
  };
}

/** 이 소유자의 이 공고 살아 있는 홀드 전부(토큰·이름·번호 없음) — work-detail 이 돌려준다. */
async function ownerChainView(db, { campaignId, ownerP8, now = new Date() }) {
  const { rows } = await db.query(
    `SELECT id, turn_starts_at, expires_at FROM campaign_applications
      WHERE campaign_id = $1 AND COALESCE(owner_phone8, phone8) = $2
        AND status = 'applied' AND expires_at > $3::timestamptz
      ORDER BY COALESCE(turn_starts_at, applied_at), id`,
    [campaignId, ownerP8, new Date(now).toISOString()]);
  const t = new Date(now).getTime();
  return rows.map(r => linkView(r, t));
}

/** 모든 끝남 지점(제출 확정·수동확정·외부확정·취소)의 유일한 입구 — 던지지 않는다(RED-03).
 *  호출 전제: 같은 트랜잭션이 recruit_campaigns 행 FOR UPDATE 를 이미 잡았고, 끝난 행의 status UPDATE 를 이미 했다. */
async function pullChainEarlierSafe(client, { campaignId, endedIds, cause, actor } = {}) {
  if (!pullOn()) return { skipped: 'off' };
  const ids = (endedIds || []).map(n => parseInt(n, 10)).filter(Boolean);
  if (!campaignId || !ids.length) return { changed: 0 };
  let sp = false, prevLock = null;
  try {
    await client.query('SAVEPOINT hold_chain'); sp = true;
    // ① 잠그지 않고 먼저 본다(한 왕복) — 기다리는 차례 명의가 없는 소유자는 잠금 0으로 끝(RED-30). 시계도 여기서 한 번(RED-34).
    const { rows: [h] } = await client.query(
      `SELECT clock_timestamp() AS now, ARRAY(
         SELECT DISTINCT COALESCE(a.owner_phone8, a.phone8) FROM campaign_applications a
          WHERE a.id = ANY($1::int[]) AND a.campaign_id = $2
            AND EXISTS (SELECT 1 FROM campaign_applications w
                         WHERE w.campaign_id = a.campaign_id
                           AND COALESCE(w.owner_phone8, w.phone8) = COALESCE(a.owner_phone8, a.phone8)
                           AND w.status = 'applied' AND w.turn_starts_at > clock_timestamp()
                           AND w.expires_at > clock_timestamp())) AS owners`,
      [ids, campaignId]);
    const now = h.now, owners = h.owners || [];
    let changed = 0;
    if (owners.length) {
      // ② 잠글 일이 있을 때만 잠금 대기 상한 2초(확정을 오래 붙잡지 않는다) — 트랜잭션 범위 값이라 RELEASE 전에 되돌린다
      prevLock = (await client.query("SELECT current_setting('lock_timeout') AS v, set_config('lock_timeout', '2s', true)")).rows[0].v;
      for (const o of owners) {
        const { rows } = await client.query(
          `SELECT id, status, expires_at, turn_starts_at, chain_ttl_min FROM campaign_applications
            WHERE campaign_id = $1 AND COALESCE(owner_phone8, phone8) = $2
              AND status = 'applied' AND expires_at > $3::timestamptz
            ORDER BY id FOR UPDATE`, [campaignId, o, now]);
        for (const c of computeChainDeadlines(rows, ms(now))) {
          const u = await client.query(
            `UPDATE campaign_applications SET turn_starts_at = $2::timestamptz, expires_at = $3::timestamptz
              WHERE id = $1 AND campaign_id = $5 AND status = 'applied' AND turn_starts_at IS NOT NULL
                AND turn_starts_at > $4::timestamptz AND $3::timestamptz > $4::timestamptz
                AND turn_starts_at >= $2::timestamptz AND expires_at >= $3::timestamptz
                AND (turn_starts_at > $2::timestamptz OR expires_at > $3::timestamptz)`,                // 대기 행만 · 앞으로만 · 멱등
            [c.id, c.turnStartsAt, c.expiresAt, now, campaignId]);
          if (u.rowCount) {
            changed++;
            logger.info(`[holdChain] pull camp=${campaignId} app=${c.id} start ${new Date(ms(c.oldStartsAt)).toISOString()}→${c.turnStartsAt.toISOString()} ` +
              `end ${new Date(ms(c.oldExpiresAt)).toISOString()}→${c.expiresAt.toISOString()} cause=${cause} by=${actor || '-'}`);
          }
        }
      }
      await client.query("SELECT set_config('lock_timeout', $1, true)", [prevLock]);
    }
    await client.query('RELEASE SAVEPOINT hold_chain');
    return { changed };
  } catch (e) {
    if (sp) { try { await client.query('ROLLBACK TO SAVEPOINT hold_chain'); await client.query('RELEASE SAVEPOINT hold_chain'); } catch (_) { /* noop */ } }
    logger.warn(`[holdChain] 당기기 실패(본 처리 유지 · 예상 마감대로 진행) camp=${campaignId} cause=${cause}: ${e.code || ''} ${e.message}`);
    return { error: e.code || 'error' };
  }
}

/** 읽기 전용 불변식 점검(RED-32) — 0 이 아니면 경고. */
async function auditChains(pool) {
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM (SELECT 1 FROM campaign_applications
          WHERE status = 'applied' AND turn_starts_at IS NOT NULL AND turn_starts_at <= NOW() AND expires_at > NOW()
          GROUP BY campaign_id, COALESCE(owner_phone8, phone8) HAVING COUNT(*) > 1) x) AS overlap_owners,
       (SELECT COUNT(*) FROM campaign_applications
          WHERE status = 'applied' AND turn_starts_at IS NOT NULL AND expires_at <= turn_starts_at) AS zero_turn`);
  if (Number(r.overlap_owners) > 0 || Number(r.zero_turn) > 0) {
    logger.warn(`[holdChain] 불변식 경고 overlap_owners=${r.overlap_owners} zero_turn=${r.zero_turn}`);
  }
  return r;
}

module.exports = {
  MAIN_HOLD_TTL_DEFAULT_MIN, MIN_TURN_MS, SLACK_MS, chainOn, chainEligibleCampaign, shapeLink, planChainLink,
  computeChainDeadlines, linkView, ownerChainView, pullChainEarlierSafe, auditChains,
};
