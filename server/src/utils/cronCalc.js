/**
 * 다음 CRON 실행 시각 계산 (KST 기준)
 * - 자동 빌드: 월~토 09~19시 매 15분 (환경변수 INDEX_CRON_SCHEDULE)
 * - 전체 재빌드: 4시간마다 (00, 04, 08, 12, 16, 20시)
 */
function calcNextCronTimes() {
  const cronExpr = process.env.INDEX_CRON_SCHEDULE || '*/15 9-19 * * 1-6';
  const fullRebuildExpr = '0 */4 * * *';

  const now = new Date();
  // KST = UTC+9
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const kstHour = kstNow.getUTCHours();
  const kstMin = kstNow.getUTCMinutes();

  // ── 자동 빌드 (월~토 9~19시 매 15분) ──
  let nextAutoMs = null;
  let nextAutoStr = null;
  {
    const validDays = [1, 2, 3, 4, 5, 6]; // 월~토
    const startHour = 9, endHour = 19;
    const intervalMin = 15; // 15분 간격

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
            // 오늘: 현재 시각 이후만
            if (h < kstHour) continue;
            if (h === kstHour && m <= kstMin) continue;
          }

          const nextKST = new Date(candidate.getTime());
          nextKST.setUTCHours(h, m, 0, 0);
          const diffMs = nextKST.getTime() - kstNow.getTime();
          if (diffMs <= 0) continue;

          nextAutoMs = diffMs;
          const nextUTC = new Date(nextKST.getTime() - 9 * 60 * 60 * 1000);
          nextAutoStr = nextUTC.toISOString();
          break;
        }
        if (nextAutoMs !== null && nextAutoMs > 0) break;
      }
      if (nextAutoMs !== null && nextAutoMs > 0) break;
    }
  }

  // ── 전체 재빌드 (4시간마다: 0, 4, 8, 12, 16, 20시 KST) ──
  let nextFullMs = null;
  let nextFullStr = null;
  {
    const fullHours = [0, 4, 8, 12, 16, 20];
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      for (const h of fullHours) {
        const candidate = new Date(kstNow.getTime());
        candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
        candidate.setUTCHours(h, 0, 0, 0);
        const diffMs = candidate.getTime() - kstNow.getTime();
        if (diffMs > 0) {
          nextFullMs = diffMs;
          const nextUTC = new Date(candidate.getTime() - 9 * 60 * 60 * 1000);
          nextFullStr = nextUTC.toISOString();
          break;
        }
      }
      if (nextFullMs !== null) break;
    }
  }

  return {
    auto: {
      schedule: cronExpr,
      description: '월~토 09~19시 매 15분',
      nextRunAt: nextAutoStr,
      nextRunInMs: nextAutoMs,
      nextRunInSec: nextAutoMs ? Math.round(nextAutoMs / 1000) : null,
    },
    full: {
      schedule: fullRebuildExpr,
      description: '4시간마다 (00, 04, 08, 12, 16, 20시)',
      nextRunAt: nextFullStr,
      nextRunInMs: nextFullMs,
      nextRunInSec: nextFullMs ? Math.round(nextFullMs / 1000) : null,
    },
    serverTimeKST: kstNow.toISOString().replace('T', ' ').substring(0, 19),
  };
}

module.exports = { calcNextCronTimes };
