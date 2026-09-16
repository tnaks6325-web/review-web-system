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

function getReviewReminderConfig(env = process.env) {
  const provider = solapi.getSolapiStatus(env);
  return {
    enabled: env.REVIEW_REMINDER_ENABLED === '1',
    providerConfigured: provider.configured,
    missing: provider.missing,
    firstOffsetDays: _intEnv('REVIEW_REMINDER_FIRST_OFFSET_DAYS', 0, -30, 90, env),
    intervalHours: _intEnv('REVIEW_REMINDER_INTERVAL_HOURS', 24, 1, 24 * 30, env),
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

function _eligibleAt(row, deadline, config) {
  const count = Number(row.reminderCount || 0);
  if (count === 0) return _addHours(deadline, config.firstOffsetDays * 24);
  if (count < 3 && row.lastRemindedAt) {
    // 운영자가 마감일을 연장하면 앞선 알림 시각만 보고 다음 차수를 보내지 않는다.
    const afterLastDelivery = _addHours(row.lastRemindedAt, config.intervalHours);
    const afterCurrentDeadline = _addHours(deadline, config.firstOffsetDays * 24);
    return afterLastDelivery > afterCurrentDeadline ? afterLastDelivery : afterCurrentDeadline;
  }
  return null;
}

function _summarizePreview(rows, now, config) {
  const items = [];
  for (const row of rows) {
    const deadline = parseReviewDeadline(row.endDate, {
      startDate: row.startDate,
      orderedAt: row.orderedAt,
      now,
    });
    const phone = normalizeKoreanMobile(row.orderPhone);
    const reminderNo = Number(row.reminderCount || 0) + 1;
    const eligibleAt = deadline ? _eligibleAt(row, deadline, config) : null;
    let reason = null;
    if (!deadline) reason = 'deadline_unparseable';
    else if (!phone) reason = 'participant_phone_invalid';
    else if (row.reviewStatus && row.reviewStatus !== 'pending') reason = row.reviewStatus;
    else if (Number(row.reminderCount || 0) >= 3) reason = 'all_reminders_delivered';
    else if (row.hasOpenAttempt) reason = 'provider_result_pending';
    else if (row.latestAttemptAt && _addHours(row.latestAttemptAt, config.retryHours) > now) reason = 'retry_cooldown';
    else if (eligibleAt && eligibleAt > now) reason = 'not_due';
    items.push({ row, deadline, phone, reminderNo, eligibleAt, reason });
  }
  return items;
}

function createReviewReminderService({ db = pool, provider = solapi } = {}) {
  async function closedStateForTarget({ sheetId, tabName, rowIndex }) {
    const { rows } = await db.query(`
      SELECT s.order_submission_id AS "orderSubmissionId", s.closed_at AS "closedAt",
             s.close_reason AS "closeReason"
        FROM review_index ri
        JOIN review_reminder_states s ON s.review_index_id = ri.id
       WHERE ri.sheet_id=$1 AND ri.tab_name=$2 AND ri.row_index=$3
         AND s.review_status='closed_no_review'
       ORDER BY s.closed_at DESC NULLS LAST LIMIT 1`,
    [sheetId, tabName, Number(rowIndex)]);
    const row = rows[0] || null;
    // 테스트 스텁이나 예기치 않은 빈 shape를 종결로 오인하지 않는다.
    return row && row.orderSubmissionId ? row : null;
  }

  async function loadCandidates(limit) {
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
         AND ri.row_index IS NOT NULL
         AND COALESCE(ri.end_date, '') <> ''
         AND NOT EXISTS (
           SELECT 1 FROM workdesk_participant_deletions wd
            WHERE wd.order_submission_id = ord.id
               OR (wd.sheet_id = ri.sheet_id AND wd.tab_name = ri.tab_name AND wd.seq = ri.row_index)
         )
       ORDER BY ri.end_date, ri.sheet_id, ri.tab_name, ri.row_index
       LIMIT $1`, [limit]);
    return rows;
  }

  async function refreshSubmittedStates() {
    const { rowCount } = await db.query(`
      UPDATE review_reminder_states s
         SET review_status = 'submitted', updated_at = NOW()
        FROM review_index ri
       WHERE ri.id = s.review_index_id AND ri.is_submitted = TRUE
         AND s.review_status = 'pending'`);
    return rowCount;
  }

  async function closeDueStates(now) {
    const { rows } = await db.query(`
      UPDATE review_reminder_states s
         SET review_status = 'closed_no_review', closed_at = $1,
             close_reason = 'three_delivered_reminders_final_due_passed', updated_at = $1
        FROM review_index ri
       WHERE ri.id = s.review_index_id AND ri.is_submitted = FALSE
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
                       updated_at = $3
                  FROM review_index ri
                 WHERE s.order_submission_id=$1 AND ri.id=s.review_index_id
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
      const preview = _summarizePreview(await loadCandidates(candidateLimit), now, config);
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

    const preview = _summarizePreview(await loadCandidates(Math.max(candidateLimit * 4, 100)), now, config);
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
    return { ok: true, config, states: rows[0] || {}, deliveries: deliveries[0] || {} };
  }

  return { run, status, reconcileAccepted, closeDueStates, refreshSubmittedStates, loadCandidates, closedStateForTarget };
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
};
