/**
 * ═══════════════════════════════════════════════════════════
 * Job Lock — PostgreSQL advisory lock 기반 작업 직렬화 (#1)
 *
 * 멀티인스턴스(또는 잦은 rolling 배포로 old+new 인스턴스가 30~60초 공존)
 * 환경에서 reconcile 같은 작업이 동시에 돌면 같은 막힌 주문을 두 패스가
 * 동시에 행배정하려 경합한다. claimRow의 sheet_row_claims 유니크가
 * "한 행 = 한 주문"은 보장하지만, 동시 reconcile은 후보행 충돌 →
 * 일부 주문이 그 라운드에 pending_no_row로 떨어져 churn/stall이 난다.
 *
 * withJobLock은 pg_try_advisory_lock(세션 레벨)을 한 번에 하나만 잡아
 * 같은 이름의 작업을 프로세스/인스턴스 경계를 넘어 직렬화한다.
 *   - 락을 못 잡으면(다른 인스턴스가 보유 중) 즉시 양보(skip) — 대기 없음.
 *   - 세션 레벨 락은 같은 커넥션에서 lock/unlock 해야 하므로 전용 client 사용.
 *   - finally에서 항상 unlock + release (예외/크래시 시엔 커넥션 종료로 자동 해제).
 * ═══════════════════════════════════════════════════════════
 */

const { logger } = require('./logger');

// 작업 이름(문자열) → 두 개의 32-bit 정수 키(64-bit advisory lock).
//   안정적·결정적 해시여야 인스턴스 간 같은 이름이 같은 키로 매핑된다.
//   ⚠️ 향후 락 이름을 추가할 때 주의: 서로 다른 이름이 같은 키로 해시 충돌하면
//   무관한 두 작업이 조용히 직렬화된다(한쪽이 다른쪽 보유 중 항상 양보). 현재는
//   'order_reconcile' 한 개뿐이라 무해. 이름이 늘면 충돌 없는 고정 상수 키 권장.
function _lockKeys(name) {
  let h1 = 0x12345678 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    h1 = (Math.imul(h1, 33) ^ c) | 0;
    h2 = (Math.imul(h2, 31) ^ c) | 0;
  }
  return [h1, h2];
}

/**
 * 이름이 같은 작업을 advisory lock으로 직렬화하여 fn을 실행한다.
 * @param {string} name  락 이름 (예: 'order_reconcile')
 * @param {() => Promise<any>} fn  락을 잡은 동안 실행할 작업
 * @param {object} [opts]
 * @param {() => any} [opts.onBusy]  락을 못 잡았을 때 호출(없으면 skip 객체 반환)
 * @returns fn의 반환값, 또는 락 경합 시 onBusy()/skip 객체
 */
async function withJobLock(name, fn, { onBusy } = {}) {
  const pool = require('../db/pool'); // 지연 require: 테스트/순환참조 안전
  const [k1, k2] = _lockKeys(name);
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [k1, k2]);
    locked = !!(rows[0] && rows[0].ok === true);
    if (!locked) {
      logger.debug(`[jobLock] '${name}' busy — 다른 인스턴스/프로세스가 보유 중, 양보`);
      if (typeof onBusy === 'function') return onBusy();
      return { skipped: true, reason: 'lock_busy', lock: name };
    }
    return await fn();
  } finally {
    let unlockFailed = false;
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [k1, k2]);
      } catch (e) {
        // unlock 실패 시 같은 커넥션을 풀에 돌려주면 advisory lock이 그 커넥션에 계속 걸려있어
        //   다음 작업이 영구히 양보(skip)된다 → 커넥션을 폐기(destroy)해 세션 종료=락 자동 해제.
        unlockFailed = true;
        logger.warn(`[jobLock] '${name}' unlock 실패 → 커넥션 폐기로 락 강제 해제: ${e.message}`);
      }
    }
    try { client.release(unlockFailed ? new Error('jobLock unlock failed; destroy connection') : undefined); }
    catch (_) { /* noop */ }
  }
}

module.exports = { withJobLock, _lockKeys };
