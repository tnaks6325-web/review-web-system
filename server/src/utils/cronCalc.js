/**
 * 다음 CRON 실행 시각 계산 (KST 기준)
 * - 자동 정시 빌드: 월~토 09~19시 매 정시 (환경변수 INDEX_CRON_SCHEDULE)
 * - 전체 재빌드: 6시간마다 (00, 06, 12, 18시)
 */
function calcNextCronTimes() {
  const cronExpr = process.env.INDEX_CRON_SCHEDULE || '0 9-19 * * 1-6';
  const fullRebuildExpr = '0 */6 * * *';

  const now = new Date();
  // KST = UTC+9
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const kstHour = kstNow.getUTCHours();
  const kstMin = kstNow.getUTCMinutes();

  // ── 자동 정시 빌드 (월~토 9~19시 매 정시) ──
  let nextAutoMs = null;
  let nextAutoStr = null;
  {
    const validDays = [1, 2, 3, 4, 5, 6]; // 월~토
    const startHour = 9, endHour = 19;

    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const candidate = new Date(kstNow.getTime());
      candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
      const candDay = candidate.getUTCDay();
      if (!validDays.includes(candDay)) continue;

      const hStart = (dayOffset === 0) ? kstHour : 0;
      for (let h = hStart; h <= endHour; h++) {
        if (h < startHour) continue;
        if (dayOffset === 0 && (h < kstHour || (h === kstHour && kstMin > 0))) continue;
        if (dayOffset === 0 && h === kstHour && kstMin === 0) continue;

        const nextKST = new Date(candidate.getTime());
        nextKST.setUTCHours(h, 0, 0, 0);
        nextAutoMs = nextKST.getTime() - kstNow.getTime();
        if (nextAutoMs <= 0) continue;
        const nextUTC = new Date(nextKST.getTime() - 9 * 60 * 60 * 1000);
        nextAutoStr = nextUTC.toISOString();
        break;
      }
      if (nextAutoMs !== null && nextAutoMs > 0) break;
    }
  }

  // ── 전체 재빌드 (6시간마다: 0, 6, 12, 18시 KST) ──
  let nextFullMs = null;
  let nextFullStr = null;
  {
    const fullHours = [0, 6, 12, 18];
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
      description: '월~토 09~19시 매 정시',
      nextRunAt: nextAutoStr,
      nextRunInMs: nextAutoMs,
      nextRunInSec: nextAutoMs ? Math.round(nextAutoMs / 1000) : null,
    },
    full: {
      schedule: fullRebuildExpr,
      description: '6시간마다 (00, 06, 12, 18시)',
      nextRunAt: nextFullStr,
      nextRunInMs: nextFullMs,
      nextRunInSec: nextFullMs ? Math.round(nextFullMs / 1000) : null,
    },
    serverTimeKST: kstNow.toISOString().replace('T', ' ').substring(0, 19),
  };
}

module.exports = { calcNextCronTimes };
