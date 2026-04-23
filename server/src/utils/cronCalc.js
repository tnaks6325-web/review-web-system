/**
 * 다음 CRON 실행 시각 계산 (KST 기준)
 * - Dirty+자동빌드: 월~토 09~19시 매 15분
 * - 인덱스 빌드: 하루 2회 (09시, 15시) — 환경변수 INDEX_CRON_SCHEDULE
 * - 전체 재빌드: 매일 새벽 4시
 * - 설정 동기화: 10분마다
 */
function calcNextCronTimes() {
  const cronExpr = process.env.INDEX_CRON_SCHEDULE || '0 9,15 * * 1-6';
  const fullRebuildExpr = '0 4 * * *';
  const dirtyExpr = '*/15 9-19 * * 1-6';

  const now = new Date();
  // KST = UTC+9
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const kstHour = kstNow.getUTCHours();
  const kstMin = kstNow.getUTCMinutes();

  // ── Dirty+자동빌드 (월~토 9~19시 매 15분) ──
  let nextDirtyMs = null;
  let nextDirtyStr = null;
  {
    const validDays = [1, 2, 3, 4, 5, 6]; // 월~토
    const startHour = 9, endHour = 19;
    const intervalMin = 15;

    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const candidate = new Date(kstNow.getTime());
      candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
      const candDay = candidate.getUTCDay();
      if (!validDays.includes(candDay)) continue;

      const hStart = (dayOffset === 0) ? Math.max(kstHour, startHour) : startHour;
      for (let h = hStart; h <= endHour; h++) {
        if (h < startHour) continue;
        for (let m = 0; m < 60; m += intervalMin) {
          if (dayOffset === 0) {
            if (h < kstHour) continue;
            if (h === kstHour && m <= kstMin) continue;
          }

          const nextKST = new Date(candidate.getTime());
          nextKST.setUTCHours(h, m, 0, 0);
          const diffMs = nextKST.getTime() - kstNow.getTime();
          if (diffMs <= 0) continue;

          nextDirtyMs = diffMs;
          const nextUTC = new Date(nextKST.getTime() - 9 * 60 * 60 * 1000);
          nextDirtyStr = nextUTC.toISOString();
          break;
        }
        if (nextDirtyMs !== null && nextDirtyMs > 0) break;
      }
      if (nextDirtyMs !== null && nextDirtyMs > 0) break;
    }
  }

  // ── 인덱스 전체 빌드 (하루 2회: 09시, 15시 KST) ──
  let nextAutoMs = null;
  let nextAutoStr = null;
  {
    const validDays = [1, 2, 3, 4, 5, 6];
    const buildHours = [9, 15];

    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      for (const h of buildHours) {
        const candidate = new Date(kstNow.getTime());
        candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
        const candDay = candidate.getUTCDay();
        if (!validDays.includes(candDay)) continue;

        candidate.setUTCHours(h, 0, 0, 0);
        const diffMs = candidate.getTime() - kstNow.getTime();
        if (diffMs > 0) {
          nextAutoMs = diffMs;
          const nextUTC = new Date(candidate.getTime() - 9 * 60 * 60 * 1000);
          nextAutoStr = nextUTC.toISOString();
          break;
        }
      }
      if (nextAutoMs !== null) break;
    }
  }

  // ── 전체 재빌드 (매일 새벽 4시 KST) ──
  let nextFullMs = null;
  let nextFullStr = null;
  {
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const candidate = new Date(kstNow.getTime());
      candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
      candidate.setUTCHours(4, 0, 0, 0);
      const diffMs = candidate.getTime() - kstNow.getTime();
      if (diffMs > 0) {
        nextFullMs = diffMs;
        const nextUTC = new Date(candidate.getTime() - 9 * 60 * 60 * 1000);
        nextFullStr = nextUTC.toISOString();
        break;
      }
    }
  }

  return {
    dirty: {
      schedule: dirtyExpr,
      description: '월~토 09~19시 매 15분 (변경감지+자동빌드)',
      nextRunAt: nextDirtyStr,
      nextRunInMs: nextDirtyMs,
      nextRunInSec: nextDirtyMs ? Math.round(nextDirtyMs / 1000) : null,
    },
    auto: {
      schedule: cronExpr,
      description: '월~토 하루 2회 (09시, 15시)',
      nextRunAt: nextAutoStr,
      nextRunInMs: nextAutoMs,
      nextRunInSec: nextAutoMs ? Math.round(nextAutoMs / 1000) : null,
    },
    full: {
      schedule: fullRebuildExpr,
      description: '매일 새벽 4시 전체 재빌드',
      nextRunAt: nextFullStr,
      nextRunInMs: nextFullMs,
      nextRunInSec: nextFullMs ? Math.round(nextFullMs / 1000) : null,
    },
    serverTimeKST: kstNow.toISOString().replace('T', ' ').substring(0, 19),
  };
}

module.exports = { calcNextCronTimes };
