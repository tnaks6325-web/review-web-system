'use strict';

const pool = require('../db/pool');
const solapi = require('./solapi.service');
const { logger } = require('../utils/logger');

const TEMPLATE_NAMES = Object.freeze({
  1: '리뷰미작성_1차',
  2: '리뷰미작성_2차',
  3: '리뷰미작성_3차',
});

function _intEnv(name, fallback, min, max, env = process.env) {
  const parsed = Number.parseInt(String(env[name] == null ? '' : env[name]), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const DEFAULT_SCHEDULE_DAYS = [7, 13, 14];
function _scheduleDays(raw) {
  const arr = String(raw == null ? '' : raw).split(',').map(v => Number.parseInt(v.trim(), 10));
  const ok = arr.length === 3 && arr.every(n => Number.isInteger(n) && n >= 0 && n <= 90)
    && arr[0] < arr[1] && arr[1] < arr[2];
  return ok ? arr : DEFAULT_SCHEDULE_DAYS.slice();
}

function getReviewReminderConfig(env = process.env) {
  const provider = solapi.getSolapiStatus(env);
  return {
    enabled: env.REVIEW_REMINDER_ENABLED === '1',
    providerConfigured: provider.configured,
    missing: provider.missing,
    // ★ 발송 시점 = 구매일(구매양식 제출일, KST) 기준 1차·2차·3차 경과일(사용자 확정 2026-09-30: 7·13·14일).
    //   제출기한 = 구매일 + 마지막 값(14일)의 끝. 시트 마감일 칸(end_date)은 어떤 작업표에도 없어 쓰지 않는다.
    scheduleDays: _scheduleDays(env.REVIEW_REMINDER_SCHEDULE_DAYS),
    // 앞 회차가 늦게 나갔을 때 다음 회차와 너무 붙지 않게 하는 최소 간격(시간).
    minGapHours: _intEnv('REVIEW_REMINDER_MIN_GAP_HOURS', 12, 1, 72, env),
    finalGraceDays: _intEnv('REVIEW_REMINDER_FINAL_GRACE_DAYS', 1, 1, 30, env),
    retryHours: _intEnv('REVIEW_REMINDER_RETRY_HOURS', 6, 1, 24 * 7, env),
    dailyCap: _intEnv('REVIEW_REMINDER_DAILY_CAP', 40, 1, 10000, env),
    cycleLimit: _intEnv('REVIEW_REMINDER_CYCLE_LIMIT', 40, 1, 500, env),
    reviewLink: String(env.REVIEW_REMINDER_LINK || 'review-web-system.pages.dev/search.html')
      .trim().replace(/^https?:\/\//i, '').replace(/^\/+/, ''),
  };
}

function _validDateParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function _dateParts(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let match = text.match(/(20\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/);
  if (match) {
    const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), explicitYear: true };
    return _validDateParts(parts.year, parts.month, parts.day) ? parts : null;
  }
  match = text.match(/(?:^|\D)(\d{1,2})\s*[./-]\s*(\d{1,2})(?:\D|$)/);
  if (!match) return null;
  return { year: null, month: Number(match[1]), day: Number(match[2]), explicitYear: false };
}

function _kstParts(date) {
  const shifted = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function _kstEndOfDay(year, month, day) {
  if (!_validDateParts(year, month, day)) return null;
  return new Date(Date.UTC(year, month - 1, day, 14, 59, 59, 999));
}

/**
 * review_index.end_date를 KST 해당 날짜 23:59:59로 바꾼다.
 * 연도가 없는 시트 표기(예: `8 / 31 (월)`)는 주문일에 가장 가까운 연도를 택한다.
 */
function parseReviewDeadline(endDate, { startDate, orderedAt, now = new Date() } = {}) {
  const parts = _dateParts(endDate);
  if (!parts) return null;
  if (parts.explicitYear) return _kstEndOfDay(parts.year, parts.month, parts.day);

  const anchorParts = _dateParts(startDate);
  let anchor;
  if (anchorParts && anchorParts.explicitYear) {
    anchor = _kstEndOfDay(anchorParts.year, anchorParts.month, anchorParts.day);
  } else if (orderedAt && !Number.isNaN(new Date(orderedAt).getTime())) {
    anchor = new Date(orderedAt);
  } else {
    anchor = new Date(now);
  }
  const baseYear = _kstParts(anchor).year;
  const candidates = [baseYear - 1, baseYear, baseYear + 1]
    .map(year => _kstEndOfDay(year, parts.month, parts.day))
    .filter(Boolean)
    .sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
  return candidates[0] || null;
}

function formatKstDate(date) {
  const p = _kstParts(date);
  return `${p.year}.${String(p.month).padStart(2, '0')}.${String(p.day).padStart(2, '0')}`;
}

function _addHours(date, hours) {
  return new Date(new Date(date).getTime() + hours * 60 * 60 * 1000);
}

function _addKstDaysEnd(date, days) {
  const p = _kstParts(date);
  const noonUtc = new Date(Date.UTC(p.year, p.month - 1, p.day + days, 3, 0, 0));
  const out = _kstParts(noonUtc);
  return _kstEndOfDay(out.year, out.month, out.day);
}

function normalizeKoreanMobile(value) {
  let digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('82')) digits = '0' + digits.slice(2);
  if (!/^01\d{8,9}$/.test(digits)) return null;
  return digits;
}

function buildTemplateVariables(reminderNo, row, deadline, finalDue, reviewLink) {
  const common = {
    '#{상품명}': String(row.productName || row.campaignName || row.tabName || '리뷰 상품').trim(),
    '#{리뷰링크}': reviewLink,
  };
  if (reminderNo === 1) {
    common['#{리뷰어명}'] = String(row.reviewerName || '').trim();
    common['#{제출기한}'] = formatKstDate(deadline);
  } else if (reminderNo === 2) {
    common['#{제출기한}'] = formatKstDate(deadline);
  } else {
    common['#{최종기한}'] = formatKstDate(finalDue);
  }
  return common;
}

// 구매일(KST) + days 일의 0시(KST).
function _kstDayStart(date, days) {
  const end = _addKstDaysEnd(date, days - 1);
  return new Date(end.getTime() + 1);
}

/**
 * 구매일 기준 발송 창.
 *  - n 회차는 구매일 + scheduleDays[n-1] 일 0시부터 보낼 수 있다(크론이 10~18시에 돈다).
 *  - 앞 회차가 늦게 나갔으면 그 뒤 minGapHours 가 지나야 다음 회차.
 *  - ★ 마지막 회차 날(구매 +14일)이 끝나면 더 보내지 않는다 — 오래된 미작성 건에 1차부터 뒤늦게
 *    몰아 보내지 않기 위해서다(켜는 순간 지난 건 전체에 알림이 쏟아지는 것 방지).
 */
function reminderSchedule(orderedAt, config) {
  if (!orderedAt || Number.isNaN(new Date(orderedAt).getTime())) return null;
  const days = config.scheduleDays || DEFAULT_SCHEDULE_DAYS;
  const slots = days.map(d => _kstDayStart(orderedAt, d));
  return {
    purchaseDay: formatKstDate(orderedAt),
    slots,
    deadline: _addKstDaysEnd(orderedAt, days[2]),
    windowEnd: _addKstDaysEnd(orderedAt, days[2]),
  };
}

function _eligibleAt(row, sched, config) {
  const count = Number(row.reminderCount || 0);
  if (count >= 3) return null;
  let at = sched.slots[count];
  if (count > 0 && row.lastRemindedAt) {
    const gap = _addHours(row.lastRemindedAt, config.minGapHours || 12);
    if (gap > at) at = gap;
  }
  return at;
}

function _summarizePreview(rows, now, config) {
  const items = [];
  for (const row of rows) {
    const sched = reminderSchedule(row.orderedAt, config);
    const deadline = sched ? sched.deadline : null;
    const phone = normalizeKoreanMobile(row.orderPhone);
    const reminderNo = Number(row.reminderCount || 0) + 1;
    const eligibleAt = sched ? _eligibleAt(row, sched, config) : null;
    let reason = null;
    if (!sched) reason = 'purchase_date_unknown';
    else if (!phone) reason = 'participant_phone_invalid';
    else if (row.reviewStatus && row.reviewStatus !== 'pending') reason = row.reviewStatus;
    else if (Number(row.reminderCount || 0) >= 3) reason = 'all_reminders_delivered';
    else if (row.hasOpenAttempt) reason = 'provider_result_pending';
    else if (row.latestAttemptAt && _addHours(row.latestAttemptAt, config.retryHours) > now) reason = 'retry_cooldown';
    else if (now > sched.windowEnd) reason = 'schedule_passed';
    else if (eligibleAt && eligibleAt > now) reason = 'not_due';
    items.push({ row, deadline, phone, reminderNo, eligibleAt, reason });
  }
  return items;
}

function createReviewReminderService({ db = pool, provider = solapi } = {}) {
  async function closedStateForTarget({ sheetId, tabName, rowIndex }) {
    const { rows } = await db.query(`
      SELECT s.resolution_id AS "resolutionId", s.order_submission_id AS "orderSubmissionId", s.closed_at AS "closedAt",
             s.close_reason AS "closeReason"
        FROM review_closed_targets s
       WHERE s.sheet_id=$1 AND s.tab_name=$2 AND s.row_index=$3
         AND s.review_status='closed_no_review'
       ORDER BY s.closed_at DESC NULLS LAST LIMIT 1`,
    [sheetId, tabName, Number(rowIndex)]);
    const row = rows[0] || null;
    // 테스트 스텁이나 예기치 않은 빈 shape를 종결로 오인하지 않는다.
    return row && (row.resolutionId || row.orderSubmissionId) ? row : null;
  }

  async function loadCandidates(limit, config = getReviewReminderConfig(), target = null) {
    // 발송 창(구매 +마지막 회차일)보다 오래된 구매는 애초에 읽지 않는다(+1일 여유).
    // ★ 담당자 수동 발송(target)은 특정 줄을 지목하므로 기간 절을 끄고 그 줄만 읽는다.
    const lookbackDays = target ? null : (config.scheduleDays || DEFAULT_SCHEDULE_DAYS)[2] + 2;
    const tSheet = target ? String(target.sheetId || '') : null;
    const tTab = target ? String(target.tabName || '') : null;
    const tRows = target ? (target.rowIndexes || []).map(Number).filter(Number.isInteger) : null;
    const { rows } = await db.query(`
      SELECT ri.id AS "reviewIndexId", ri.sheet_id AS "sheetId", ri.tab_name AS "tabName",
             ri.row_index AS "rowIndex", ri.reviewer_name AS "reviewerName",
             ri.campaign_name AS "campaignName", ri.product_name AS "productName",
             ri.start_date AS "startDate", ri.end_date AS "endDate", ri.phone8,
             ord.id AS "orderSubmissionId", ord.phone AS "orderPhone", ord.submitted_at AS "orderedAt",
             COALESCE(s.review_status, 'pending') AS "reviewStatus",
             COALESCE(s.reminder_count, 0)::int AS "reminderCount",
             s.last_reminded_at AS "lastRemindedAt", s.final_due_at AS "finalDueAt",
             EXISTS (
               SELECT 1 FROM review_reminder_deliveries d
                WHERE d.order_submission_id = ord.id
                  AND d.reminder_no = COALESCE(s.reminder_count, 0) + 1
                  AND d.provider_status = 'accepted'
             ) AS "hasOpenAttempt",
             (SELECT MAX(d.requested_at) FROM review_reminder_deliveries d
               WHERE d.order_submission_id = ord.id
                 AND d.reminder_no = COALESCE(s.reminder_count, 0) + 1) AS "latestAttemptAt"
        FROM review_index ri
        JOIN LATERAL (
          SELECT picked.* FROM (
            SELECT os.*, 0 AS priority
              FROM campaign_participants cp
              JOIN order_submissions os ON os.id = cp.order_submission_id
             WHERE cp.sheet_id = ri.sheet_id AND cp.tab_name = ri.tab_name AND cp.seq = ri.row_index
               AND cp.active = TRUE AND cp.deleted_at IS NULL AND os.deleted_at IS NULL
            UNION ALL
            SELECT os.*, 1 AS priority
              FROM order_submissions os
             WHERE os.sheet_id = ri.sheet_id AND os.tab_name = ri.tab_name AND os.sheet_row = ri.row_index
               AND os.deleted_at IS NULL
               AND RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) = ri.phone8
          ) picked
          ORDER BY picked.priority, picked.submitted_at DESC, picked.id DESC
          LIMIT 1
        ) ord ON TRUE
        LEFT JOIN review_reminder_states s ON s.order_submission_id = ord.id
       WHERE ri.is_submitted = FALSE
         AND ${require('./reviewObligation.service').unfulfilledSql('ri')}
         AND ri.row_index IS NOT NULL
         AND ($2::int IS NULL OR ord.submitted_at >= NOW() - ($2::int * INTERVAL '1 day'))
         AND ($3::text IS NULL OR (ri.sheet_id = $3 AND ri.tab_name = $4 AND ri.row_index = ANY($5::int[])))
         AND COALESCE(s.review_status, 'pending') = 'pending'
         AND NOT EXISTS (SELECT 1 FROM review_closed_targets closed
           WHERE closed.sheet_id=ri.sheet_id AND closed.tab_name=ri.tab_name AND closed.row_index=ri.row_index)
         AND NOT EXISTS (
           SELECT 1 FROM workdesk_participant_deletions wd
            WHERE wd.order_submission_id = ord.id
               OR (wd.sheet_id = ri.sheet_id AND wd.tab_name = ri.tab_name AND wd.seq = ri.row_index)
         )
       ORDER BY ord.submitted_at, ri.sheet_id, ri.tab_name, ri.row_index
       LIMIT $1`, [limit, lookbackDays, tSheet, tTab, tRows]);
    return rows;
  }

  async function refreshSubmittedStates() {
    const { rowCount } = await db.query(`
      UPDATE review_reminder_states s
         SET review_status = 'submitted', review_index_id = ri.id, updated_at = NOW()
        FROM review_index ri
       WHERE ri.sheet_id = s.sheet_id AND ri.tab_name = s.tab_name AND ri.row_index = s.row_index
         AND ${require('./reviewObligation.service').submittedSql('ri.is_submitted','ri')} = TRUE
         AND s.review_status = 'pending'`);
    return rowCount;
  }

  async function closeDueStates(now) {
    const { rows } = await db.query(`
      UPDATE review_reminder_states s
         SET review_status = 'closed_no_review', closed_at = $1,
             close_reason = 'three_delivered_reminders_final_due_passed',
             review_index_id = ri.id, updated_at = $1
        FROM review_index ri
       WHERE ri.sheet_id = s.sheet_id AND ri.tab_name = s.tab_name AND ri.row_index = s.row_index
         AND ri.is_submitted = FALSE
         AND ${require('./reviewObligation.service').unfulfilledSql('ri')}
         AND s.review_status = 'pending' AND s.reminder_count = 3
         AND s.final_due_at IS NOT NULL AND s.final_due_at <= $1
         AND NOT EXISTS (
           SELECT 1 FROM workdesk_participant_deletions wd
            WHERE wd.order_submission_id = s.order_submission_id
               OR (wd.sheet_id = s.sheet_id AND wd.tab_name = s.tab_name AND wd.seq = s.row_index)
         )
      RETURNING s.order_submission_id`, [now]);
    return rows.length;
  }

  async function reconcileAccepted(now, limit = 100) {
    const { rows } = await db.query(`
      SELECT id, order_submission_id AS "orderSubmissionId", reminder_no AS "reminderNo",
             provider_message_id AS "messageId", final_due_at AS "finalDueAt"
        FROM review_reminder_deliveries
       WHERE provider_status = 'accepted' AND provider_message_id IS NOT NULL
       ORDER BY requested_at ASC LIMIT $1`, [limit]);
    const result = { checked: 0, delivered: 0, failed: 0, pending: 0, errors: 0 };
    for (const delivery of rows) {
      try {
        const current = await provider.getMessageStatus(delivery.messageId);
        result.checked++;
        if (!current.complete) { result.pending++; continue; }
        const resolvedAt = current.dateReceived || current.dateUpdated || now;
        const client = typeof db.connect === 'function' ? await db.connect() : db;
        try {
          await client.query('BEGIN');
          if (current.success) {
            const updated = await client.query(`
              UPDATE review_reminder_deliveries
                 SET provider_status='delivered', provider_status_code=$2, provider_reason=$3,
                     resolved_at=$4
               WHERE id=$1 AND provider_status='accepted'
               RETURNING order_submission_id`,
              [delivery.id, current.statusCode, current.reason || '', resolvedAt]);
            if (updated.rowCount) {
              await client.query(`
                UPDATE review_reminder_states s
                   SET reminder_count = $2,
                       last_reminded_at = $3,
                       final_due_at = CASE WHEN $2 = 3 THEN $4 ELSE s.final_due_at END,
                       review_status = CASE WHEN ri.is_submitted THEN 'submitted' ELSE s.review_status END,
                       review_index_id = ri.id,
                       updated_at = $3
                  FROM review_index ri
                 WHERE s.order_submission_id=$1
                   AND ri.sheet_id=s.sheet_id AND ri.tab_name=s.tab_name AND ri.row_index=s.row_index
                   AND s.reminder_count=$2 - 1`,
                [delivery.orderSubmissionId, delivery.reminderNo, resolvedAt, delivery.finalDueAt]);
              result.delivered++;
            }
          } else {
            const failed = await client.query(`
              UPDATE review_reminder_deliveries
                 SET provider_status='failed', provider_status_code=$2, provider_reason=$3, resolved_at=$4
               WHERE id=$1 AND provider_status='accepted'`,
              [delivery.id, current.statusCode, current.reason || '', resolvedAt]);
            if (failed.rowCount) result.failed++;
          }
          await client.query('COMMIT');
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
          throw err;
        } finally {
          if (client !== db && typeof client.release === 'function') client.release();
        }
      } catch (err) {
        result.errors++;
        logger.warn(`[review-reminder] SOLAPI 결과 확인 실패: ${err.message}`);
      }
    }
    return result;
  }

  async function countDailyAttempts(now) {
    const p = _kstParts(now);
    const start = new Date(Date.UTC(p.year, p.month - 1, p.day, -9, 0, 0));
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS n FROM review_reminder_deliveries
       WHERE requested_at >= $1 AND requested_at < $2`, [start, end]);
    return Number(rows[0] && rows[0].n) || 0;
  }

  async function ensureState(row, deadline, now) {
    await db.query(`
      INSERT INTO review_reminder_states
        (order_submission_id, review_index_id, sheet_id, tab_name, row_index, reviewer_name,
         phone8, product_name, review_deadline_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
      ON CONFLICT (order_submission_id) DO UPDATE SET
        review_index_id=EXCLUDED.review_index_id, sheet_id=EXCLUDED.sheet_id,
        tab_name=EXCLUDED.tab_name, row_index=EXCLUDED.row_index,
        reviewer_name=EXCLUDED.reviewer_name, phone8=EXCLUDED.phone8,
        product_name=EXCLUDED.product_name, review_deadline_at=EXCLUDED.review_deadline_at,
        updated_at=EXCLUDED.updated_at`,
      [row.orderSubmissionId, row.reviewIndexId, row.sheetId, row.tabName, row.rowIndex,
       row.reviewerName || '', row.phone8 || '', row.productName || row.campaignName || '', deadline, now]);
  }

  async function sendOne(item, config, now) {
    const { row, deadline, phone, reminderNo } = item;
    // 외부 호출 바로 전 제출 여부를 다시 확인한다.
    const { rows: fresh } = await db.query(
      'SELECT is_submitted FROM review_index WHERE id=$1 LIMIT 1', [row.reviewIndexId]);
    if (!fresh.length || fresh[0].is_submitted) {
      if (fresh.length && fresh[0].is_submitted) {
        await db.query(`UPDATE review_reminder_states SET review_status='submitted', updated_at=$2
                         WHERE order_submission_id=$1 AND review_status='pending'`,
        [row.orderSubmissionId, now]);
      }
      return { sent: false, reason: fresh.length ? 'submitted_before_send' : 'review_row_missing' };
    }

    if (await closedStateForTarget(row)) return { sent: false, reason: 'closed_before_send' };
    if (await require('./reviewObligation.service').isFulfilled(row,db)) return {sent:false,reason:'fulfilled_before_send'};
    if (!await require('./reviewObligation.service').canRemind(row,db)) return {sent:false,reason:'review_not_pending_before_send'};
    const cancelled = await db.query(`SELECT 1 FROM order_submissions WHERE id=$1 AND deleted_at IS NOT NULL`, [row.orderSubmissionId]);
    if (cancelled.rows.length) return { sent: false, reason: 'cancelled_before_send' };
    const finalDue = reminderNo === 3 ? _addKstDaysEnd(now, config.finalGraceDays) : null;
    const variables = buildTemplateVariables(reminderNo, row, deadline, finalDue, config.reviewLink);
    await ensureState(row, deadline, now);

    const { rows: attempts } = await db.query(`
      SELECT COALESCE(MAX(attempt_no),0)::int + 1 AS n
        FROM review_reminder_deliveries
       WHERE order_submission_id=$1 AND reminder_no=$2`, [row.orderSubmissionId, reminderNo]);
    const attemptNo = Number(attempts[0] && attempts[0].n) || 1;
    const templateId = provider._config ? provider._config().templateIds[reminderNo] : `configured-${reminderNo}`;
    const { rows: inserted } = await db.query(`
      INSERT INTO review_reminder_deliveries
        (order_submission_id, reminder_no, attempt_no, template_name, template_id,
         target_phone, template_variables, provider_status, final_due_at, requested_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'accepted',$8,$9)
      RETURNING id`,
      [row.orderSubmissionId, reminderNo, attemptNo, TEMPLATE_NAMES[reminderNo], templateId,
       phone, JSON.stringify(variables), finalDue, now]);
    const deliveryId = inserted[0].id;

    try {
      const response = await provider.sendReviewAlimTalk({
        to: phone,
        reminderNo,
        variables,
        customFields: {
          reminderDeliveryId: String(deliveryId),
          orderSubmissionId: String(row.orderSubmissionId),
          reminderNo: String(reminderNo),
        },
      });
      if (response.accepted && response.messageId) {
        await db.query(`
          UPDATE review_reminder_deliveries
             SET provider_message_id=$2, provider_group_id=$3,
                 provider_status_code=$4, provider_reason=$5, template_id=$6
           WHERE id=$1`,
          [deliveryId, response.messageId, response.groupId, response.statusCode,
           response.reason || '', response.templateId || templateId]);
        return { sent: true, accepted: true, reminderNo };
      }
      await db.query(`
        UPDATE review_reminder_deliveries
           SET provider_status='failed', provider_message_id=$2, provider_group_id=$3,
               provider_status_code=$4, provider_reason=$5, resolved_at=$6
         WHERE id=$1`,
        [deliveryId, response.messageId, response.groupId, response.statusCode,
         response.reason || 'SOLAPI_REJECTED', now]);
      return { sent: true, accepted: false, reminderNo, reason: response.reason || 'provider_rejected' };
    } catch (err) {
      // HTTP 4xx/5xx 응답은 미접수로 확정할 수 있다. 타임아웃/연결단절은 공급자가 받았을 수 있으므로
      // accepted+messageId NULL로 남겨 자동 재발송을 막고 관리자가 확인하게 한다.
      if (err && err.status) {
        await db.query(`UPDATE review_reminder_deliveries
                          SET provider_status='failed', provider_reason=$2, resolved_at=$3 WHERE id=$1`,
        [deliveryId, err.code || err.message, now]);
      } else {
        await db.query(`UPDATE review_reminder_deliveries
                          SET provider_reason=$2 WHERE id=$1`,
        [deliveryId, `UNCERTAIN:${err.code || err.message}`]);
      }
      return { sent: true, accepted: false, uncertain: !err.status, reminderNo, reason: err.code || err.message };
    }
  }

  async function run({ dryRun = false, now = new Date(), limit } = {}) {
    const config = getReviewReminderConfig();
    const candidateLimit = Math.max(1, Math.min(500, Number(limit) || config.cycleLimit));
    if (!dryRun && !config.enabled) return { ok: true, skipped: true, reason: 'disabled', config };
    if (!dryRun && !config.providerConfigured) {
      return { ok: false, skipped: true, reason: 'provider_not_configured', missing: config.missing };
    }

    if (dryRun) {
      const preview = _summarizePreview(await loadCandidates(candidateLimit, config), now, config);
      return {
        ok: true,
        dryRun: true,
        due: preview.filter(x => !x.reason).length,
        skipped: preview.reduce((acc, x) => {
          if (x.reason) acc[x.reason] = (acc[x.reason] || 0) + 1;
          return acc;
        }, {}),
        items: preview.filter(x => !x.reason).slice(0, candidateLimit).map(x => ({
          orderSubmissionId: x.row.orderSubmissionId,
          sheetId: x.row.sheetId,
          tabName: x.row.tabName,
          rowIndex: x.row.rowIndex,
          reviewerName: x.row.reviewerName,
          productName: x.row.productName || x.row.campaignName,
          reminderNo: x.reminderNo,
          deadline: formatKstDate(x.deadline),
          targetPhoneTail: x.phone.slice(-4),
        })),
        config: { ...config, missing: config.missing },
      };
    }

    const reconciled = await reconcileAccepted(now);
    const submitted = await refreshSubmittedStates();
    const closed = await closeDueStates(now);
    // 공급자 최종 실패도 계정 일일 한도를 소모할 수 있으므로 API 시도 행 전체를 센다.
    const usedToday = await countDailyAttempts(now);
    let remaining = Math.max(0, config.dailyCap - usedToday);
    if (!remaining) return { ok: true, reconciled, submitted, closed, sent: 0, dailyCapReached: true };

    const preview = _summarizePreview(await loadCandidates(Math.max(candidateLimit * 4, 100), config), now, config);
    const due = preview.filter(x => !x.reason).slice(0, Math.min(candidateLimit, remaining));
    const outcomes = [];
    for (const item of due) {
      if (remaining <= 0) break;
      const outcome = await sendOne(item, config, now);
      outcomes.push(outcome);
      if (outcome.sent) remaining--;
    }
    return {
      ok: true,
      reconciled,
      submitted,
      closed,
      due: due.length,
      sent: outcomes.filter(x => x.sent).length,
      accepted: outcomes.filter(x => x.accepted).length,
      uncertain: outcomes.filter(x => x.uncertain).length,
      failed: outcomes.filter(x => x.sent && !x.accepted).length,
      skippedBeforeSend: outcomes.filter(x => !x.sent).length,
      dailyUsedBeforeRun: usedToday,
    };
  }

  async function status() {
    const config = getReviewReminderConfig();
    let billing = { available: false };
    if (typeof provider.getAccountBilling === 'function') {
      try {
        billing = await provider.getAccountBilling();
      } catch (err) {
        logger.warn(`[review-reminder] SOLAPI 비용·잔액 조회 실패: ${err.message}`);
      }
    }
    const { rows } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE review_status='pending')::int AS pending,
             COUNT(*) FILTER (WHERE review_status='submitted')::int AS submitted,
             COUNT(*) FILTER (WHERE review_status='closed_no_review')::int AS closed,
             COUNT(*) FILTER (WHERE review_status='pending' AND reminder_count=3)::int AS awaiting_close
        FROM review_reminder_states`);
    const { rows: deliveries } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE provider_status='accepted')::int AS accepted,
             COUNT(*) FILTER (WHERE provider_status='delivered')::int AS delivered,
             COUNT(*) FILTER (WHERE provider_status='failed')::int AS failed,
             COUNT(*) FILTER (WHERE provider_status='accepted' AND provider_message_id IS NULL)::int AS uncertain
        FROM review_reminder_deliveries`);
    return { ok: true, config, billing, states: rows[0] || {}, deliveries: deliveries[0] || {} };
  }

  /**
   * 담당자 수동 알림톡 — 작업보드에서 고른 줄에 **다음 회차**를 지금 보낸다(사용자 확정 2026-09-30, 시안 A).
   * ★ 발송 실행부는 자동 알림과 같은 sendOne 한 벌 — 원장(review_reminder_deliveries)에 그 회차로 남아
   *   자동 알림이 같은 회차를 다시 보내지 않고, 3회 뒤 미작성 종결 흐름도 그대로 탄다.
   * ★ 날짜가 아직 안 된 회차(not_due)만 앞당겨 보낼 수 있다. 그 외 사유(제출함·3회 완료·결과 확인 중·
   *   번호 오류·알림 기간 지남)는 그대로 막고 사유를 말한다. 기간이 지난 건은 문자로 연락한다.
   * ★ 자동 스위치(REVIEW_REMINDER_ENABLED)와 무관 — 발송 업체 설정만 되어 있으면 된다. 하루 상한은 세지만 막지 않는다.
   */
  const MANUAL_OK = new Set([null, 'not_due']);
  const MANUAL_REASON = {
    purchase_date_unknown: '구매 기록이 없어 알림톡 회차를 정할 수 없습니다 — 문자로 보내세요',
    participant_phone_invalid: '주문 연락처가 휴대폰 번호가 아닙니다',
    all_reminders_delivered: '알림톡 3회를 이미 모두 보냈습니다',
    provider_result_pending: '앞서 보낸 알림톡의 도착 확인을 기다리는 중입니다',
    retry_cooldown: '방금 실패한 알림톡의 재시도 대기 중입니다(6시간)',
    schedule_passed: '알림톡 기간(구매 후 14일)이 지났습니다 — 문자로 보내세요',
    submitted: '리뷰를 이미 제출했습니다',
    closed_no_review: '미작성 종결된 줄입니다',
    cancelled: '취소된 주문입니다',
  };
  async function manualPreview({ sheetId, tabName, rowIndexes, now = new Date() }) {
    const config = getReviewReminderConfig();
    try { await reconcileAccepted(now); } catch (e) { logger.warn(`[review-reminder] 수동 미리보기 결과 확인 실패: ${e.message}`); }
    const rows = await loadCandidates(Math.min(500, (rowIndexes || []).length * 2 + 10), config, { sheetId, tabName, rowIndexes });
    const preview = _summarizePreview(rows, now, config);
    const byRow = new Map();
    for (const x of preview) {
      if (byRow.has(Number(x.row.rowIndex))) continue;   // 같은 줄에 주문이 둘이면 최신(LATERAL LIMIT 1)만
      const ok = MANUAL_OK.has(x.reason);
      byRow.set(Number(x.row.rowIndex), {
        ok, item: ok ? x : null,
        reminderNo: x.reminderNo, deadline: x.deadline ? formatKstDate(x.deadline) : '',
        phoneTail: x.phone ? x.phone.slice(-4) : '',
        reason: ok ? '' : (MANUAL_REASON[x.reason] || x.reason || '보낼 수 없습니다'),
      });
    }
    return { config, byRow };
  }
  async function sendManual({ sheetId, tabName, rowIndexes, now = new Date() }) {
    const { config, byRow } = await manualPreview({ sheetId, tabName, rowIndexes, now });
    if (!config.providerConfigured) return { ok: false, error: '알림톡 발송 설정이 비어 있습니다', results: [] };
    const results = [];
    for (const rowIndex of rowIndexes) {
      const p = byRow.get(Number(rowIndex));
      if (!p) { results.push({ rowIndex, sent: false, reason: '리뷰 미제출 상태의 구매 기록을 찾지 못했습니다' }); continue; }
      if (!p.ok) { results.push({ rowIndex, sent: false, reason: p.reason }); continue; }
      const out = await sendOne(p.item, config, now);
      results.push({ rowIndex, reminderNo: p.reminderNo, deadline: p.deadline, phoneTail: p.phoneTail,
        orderSubmissionId: p.item.row.orderSubmissionId, reviewerName: p.item.row.reviewerName,
        targetPhone: p.item.phone, ...out });
    }
    return { ok: true, results };
  }

  return { run, status, reconcileAccepted, manualPreview, sendManual, closeDueStates, refreshSubmittedStates, loadCandidates, closedStateForTarget };
}

const service = createReviewReminderService();

module.exports = {
  ...service,
  createReviewReminderService,
  getReviewReminderConfig,
  parseReviewDeadline,
  formatKstDate,
  normalizeKoreanMobile,
  buildTemplateVariables,
  TEMPLATE_NAMES,
  _dateParts,
  _kstParts,
  _summarizePreview,
  reminderSchedule,
};
