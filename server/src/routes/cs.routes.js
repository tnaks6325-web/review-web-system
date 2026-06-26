/**
 * C/S 문의창구 — 관리자 API
 * 모든 라우트는 JWT(authMiddleware) + 관리자/마스터(adminOrMasterMiddleware) 전용.
 * staff(영업담당자)·리뷰어는 접근 불가.
 *
 * 동적 /:id 경로는 프론트 gasGet/gasPost 래퍼가 미지원이라, 전부 평면 경로 + body/query id 사용.
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { emitCsReplyToReviewer, broadcast } = require('../utils/sse');

// 이하 모든 라우트 보호
router.use(authMiddleware, adminOrMasterMiddleware);

// GET /api/cs/threads?status=open|closed|all&q=검색어 — 문의방 목록(리뷰어별 그룹은 프론트에서)
router.get('/threads', async (req, res, next) => {
  try {
    const status = (req.query.status || 'all').toString();
    const q = (req.query.q || '').toString().trim();

    const where = [];
    const params = [];
    if (status === 'open' || status === 'closed') {
      params.push(status);
      where.push(`t.status = $${params.length}`);
    }
    if (q) {
      params.push('%' + q + '%');
      where.push(`(t.reviewer_name ILIKE $${params.length} OR t.reviewer_phone8 LIKE $${params.length} OR t.campaign_label ILIKE $${params.length})`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT
        t.id,
        t.reviewer_phone8      AS "reviewerPhone8",
        t.reviewer_name        AS "reviewerName",
        t.campaign_key         AS "campaignKey",
        t.campaign_label       AS "campaignLabel",
        t.campaign_source      AS "campaignSource",
        t.status,
        t.last_message_at      AS "lastMessageAt",
        t.last_message_preview AS "lastMessagePreview",
        t.admin_unread_count   AS "adminUnread",
        t.created_at           AS "createdAt",
        rv.admin_memo          AS "adminMemo"
      FROM cs_threads t
      LEFT JOIN reviewers rv ON rv.phone8 = t.reviewer_phone8
      ${whereSql}
      ORDER BY (t.admin_unread_count > 0) DESC, COALESCE(t.last_message_at, t.created_at) DESC
      LIMIT 500
    `, params);

    const totalUnread = rows.reduce((s, r) => s + (r.adminUnread || 0), 0);
    res.json({ ok: true, threads: rows, total: rows.length, totalUnread });
  } catch (err) {
    next(err);
  }
});

// GET /api/cs/unread-count — 관리자 탭 뱃지용(미확인 메시지 보유 방 수 + 합계)
router.get('/unread-count', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(admin_unread_count),0)::int AS "totalUnread",
              COUNT(*) FILTER (WHERE admin_unread_count > 0)::int AS "unreadThreads"
       FROM cs_threads`
    );
    res.json({ ok: true, ...rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/cs/messages?threadId=XX — 대화 메시지 + 리뷰어 정보(관리자 메모 포함). 열람 시 미확인 리셋.
router.get('/messages', async (req, res, next) => {
  try {
    const threadId = (req.query.threadId || '').toString();
    if (!threadId) return res.status(400).json({ ok: false, error: 'threadId가 필요합니다.' });

    const { rows: tRows } = await pool.query(
      `SELECT id, reviewer_phone8 AS "reviewerPhone8", reviewer_name AS "reviewerName",
              campaign_key AS "campaignKey", campaign_label AS "campaignLabel",
              campaign_source AS "campaignSource", status
       FROM cs_threads WHERE id = $1 LIMIT 1`, [threadId]
    );
    if (tRows.length === 0) return res.status(404).json({ ok: false, error: '문의방을 찾을 수 없습니다.' });
    const thread = tRows[0];

    // 리뷰어 관리자 전용 메모 조회
    const { rows: rRows } = await pool.query(
      `SELECT admin_memo AS "adminMemo" FROM reviewers WHERE phone8 = $1 LIMIT 1`,
      [thread.reviewerPhone8]
    );
    thread.adminMemo = rRows[0] ? (rRows[0].adminMemo || '') : '';

    // 관리자 확인용 시트제목(업체) — campaign_key("sheetId||tabName")에서 역조회.
    //   리뷰어에게는 노출하지 않고 관리자 응대 화면에서만 보임.
    thread.companyLabel = '';
    const ck = (thread.campaignKey || '').toString();
    const sep = ck.indexOf('||');
    if (sep > -1) {
      const sheetId = ck.slice(0, sep);
      const tabName = ck.slice(sep + 2);
      const { rows: cn } = await pool.query(
        `SELECT campaign_name FROM review_index
          WHERE sheet_id = $1 AND tab_name = $2 AND COALESCE(campaign_name,'') <> ''
          LIMIT 1`, [sheetId, tabName]
      );
      if (cn[0]) thread.companyLabel = cn[0].campaign_name;
      if (!thread.companyLabel) {
        const { rows: cn2 } = await pool.query(
          `SELECT campaign_name FROM tab_configs
            WHERE sheet_id = $1 AND tab_name = $2 AND COALESCE(campaign_name,'') <> ''
            LIMIT 1`, [sheetId, tabName]
        );
        if (cn2[0]) thread.companyLabel = cn2[0].campaign_name;
      }
    }

    const { rows: messages } = await pool.query(
      `SELECT id, sender_role AS "senderRole", sender_name AS "senderName", content,
              created_at AS "createdAt"
       FROM cs_messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT 1000`,
      [threadId]
    );

    // 관리자가 열람 → 미확인(admin) 리셋
    await pool.query(`UPDATE cs_threads SET admin_unread_count = 0, updated_at = NOW() WHERE id = $1`, [threadId]);

    res.json({ ok: true, thread, messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/cs/reply { threadId, content } — 관리자 답장
router.post('/reply', async (req, res, next) => {
  try {
    const b = req.body || {};
    const threadId = (b.threadId || '').toString();
    const content = (b.content || '').toString().trim();
    if (!threadId) return res.status(400).json({ ok: false, error: 'threadId가 필요합니다.' });
    if (!content) return res.status(400).json({ ok: false, error: '메시지 내용이 비어 있습니다.' });

    const { rows: tRows } = await pool.query(
      `SELECT id, reviewer_phone8 AS "reviewerPhone8", campaign_label AS "campaignLabel"
       FROM cs_threads WHERE id = $1 LIMIT 1`, [threadId]
    );
    if (tRows.length === 0) return res.status(404).json({ ok: false, error: '문의방을 찾을 수 없습니다.' });
    const thread = tRows[0];
    const senderName = req.admin?.name || '관리자';

    const { rows: mRows } = await pool.query(
      `INSERT INTO cs_messages (thread_id, sender_role, sender_name, content)
       VALUES ($1, 'admin', $2, $3) RETURNING id, created_at AS "createdAt"`,
      [threadId, senderName, content]
    );
    const message = {
      id: mRows[0].id, threadId, senderRole: 'admin', senderName, content,
      createdAt: mRows[0].createdAt,
    };

    // 관리자 답장 → 리뷰어 미확인 +1, 방 갱신(닫혀있었어도 last_message는 갱신)
    await pool.query(
      `UPDATE cs_threads
         SET reviewer_unread_count = reviewer_unread_count + 1,
             last_message_at = NOW(),
             last_message_preview = $2,
             updated_at = NOW()
       WHERE id = $1`,
      [threadId, content.slice(0, 120)]
    );

    // 해당 리뷰어에게만 실시간 푸시 + 다른 관리자 세션 갱신용 브로드캐스트
    try { emitCsReplyToReviewer(thread.reviewerPhone8, { ...message, campaignLabel: thread.campaignLabel }); } catch (_) {}
    try { broadcast('cs_message', { threadId, senderRole: 'admin', reviewerPhone8: thread.reviewerPhone8 }); } catch (_) {}

    res.json({ ok: true, message });
  } catch (err) {
    next(err);
  }
});

// POST /api/cs/status { threadId, status } — 방 상태(open/closed)
router.post('/status', async (req, res, next) => {
  try {
    const b = req.body || {};
    const threadId = (b.threadId || '').toString();
    const status = (b.status || '').toString();
    if (!threadId) return res.status(400).json({ ok: false, error: 'threadId가 필요합니다.' });
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ ok: false, error: 'status는 open/closed 만 가능합니다.' });

    const { rowCount } = await pool.query(
      `UPDATE cs_threads SET status = $2, updated_at = NOW() WHERE id = $1`, [threadId, status]
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, error: '문의방을 찾을 수 없습니다.' });

    try { broadcast('cs_message', { threadId, statusChanged: status }); } catch (_) {}
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// POST /api/cs/memo { phone8, memo } — 리뷰어 관리자 전용 메모 저장(리뷰어정보로 영구 보존)
router.post('/memo', async (req, res, next) => {
  try {
    const b = req.body || {};
    const phone8 = (b.phone8 || '').toString().replace(/[^0-9]/g, '');
    const memo = (b.memo == null ? '' : b.memo).toString();
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8(8자리)이 필요합니다.' });

    const { rowCount } = await pool.query(
      `UPDATE reviewers SET admin_memo = $2 WHERE phone8 = $1`, [phone8, memo]
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, error: '해당 리뷰어를 찾을 수 없습니다.' });

    logger.info(`[cs] 관리자 메모 저장: phone8=${phone8} by ${req.admin?.name || ''}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
