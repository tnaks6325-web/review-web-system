/**
 * C/S 문의창구 — 내부 담당자 API
 * 모든 라우트는 JWT(authMiddleware) + 내부 역할(master/admin/staff) 전용.
 * 리뷰어·광고주는 접근 불가.
 *
 * 동적 /:id 경로는 프론트 gasGet/gasPost 래퍼가 미지원이라, 전부 평면 경로 + body/query id 사용.
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const adminNickname = require('../services/adminNickname.service');
const { logger } = require('../utils/logger');
const { authMiddleware } = require('../middleware/auth.middleware');
const { emitCsReplyToReviewer, broadcast } = require('../utils/sse');

// 이하 모든 라우트 보호. AE(staff)도 리뷰어 C/S를 조회·답변할 수 있다.
function internalMiddleware(req, res, next) {
  const role = req.user?.role;
  if (role === 'master' || role === 'admin' || role === 'staff') return next();
  return res.status(403).json({ ok: false, error: '권한 없음' });
}
router.use(authMiddleware, internalMiddleware);

// ── 첨부 이미지 URL 검증: 우리 서버의 guide-image 프록시 URL만 허용 ──
//   화면에 <img src>로 나가므로 자유 문자열 금지(외부 URL·스킴 주입 차단). 메시지당 최대 5장.
/** C/S 첨부 URL 화이트리스트 — 규칙은 `utils/csImageUrls` 단일 출처(사본 금지). */
const { sanitizeCsImageUrls: _sanitizeCsImageUrls } = require('../utils/csImageUrls');

// GET /api/cs/threads?status=open|closed|all&q=검색어 — 문의방 목록(리뷰어별 그룹은 프론트에서)
router.get('/threads', async (req, res, next) => {
  try {
    const status = (req.query.status || 'all').toString();
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);

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
        rv.admin_memo          AS "adminMemo",
        -- 목록의 업체명 검색도 대화 상세와 같은 출처·우선순위를 쓴다.
        -- campaign_key는 sheetId||tabName 형식이며 tabName 안의 || 는 첫 구분자 뒤에
        -- 그대로 남겨 상세 조회의 split 규칙과 일치한다.
        COALESCE(
          (SELECT ri.campaign_name FROM review_index ri
            WHERE ri.sheet_id = split_part(t.campaign_key, '||', 1)
              AND ri.tab_name = substring(t.campaign_key FROM position('||' IN t.campaign_key) + 2)
              AND COALESCE(ri.campaign_name, '') <> ''
            LIMIT 1),
          (SELECT tc.campaign_name FROM tab_configs tc
            WHERE tc.sheet_id = split_part(t.campaign_key, '||', 1)
              AND tc.tab_name = substring(t.campaign_key FROM position('||' IN t.campaign_key) + 2)
              AND COALESCE(tc.campaign_name, '') <> ''
            LIMIT 1),
          '') AS "companyLabel"
      FROM cs_threads t
      LEFT JOIN reviewers rv ON rv.phone8 = t.reviewer_phone8
      ${whereSql}
      ORDER BY (t.admin_unread_count > 0) DESC, COALESCE(t.last_message_at, t.created_at) DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const totalUnread = rows.reduce((s, r) => s + (r.adminUnread || 0), 0);
    res.json({ ok: true, threads: rows, total: rows.length, totalUnread, hasMore: rows.length === limit });
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
              image_urls AS "imageUrls", created_at AS "createdAt",
              msg_type AS "msgType", meta
       FROM cs_messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT 1000`,
      [threadId]
    );

    // 관리자가 열람 → 미확인(admin) 리셋
    await pool.query(`UPDATE cs_threads SET admin_unread_count = 0, updated_at = NOW() WHERE id = $1`, [threadId]);

    // 관리자 화면 = 닉네임 || 로그인명(내부 책임추적 유지)
    const shown = await adminNickname.maskMessages(messages, 'admin');
    res.json({ ok: true, thread, messages: shown });
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
    const imageUrls = _sanitizeCsImageUrls(b.imageUrls);
    if (!threadId) return res.status(400).json({ ok: false, error: 'threadId가 필요합니다.' });
    if (!content && imageUrls.length === 0) return res.status(400).json({ ok: false, error: '메시지 내용이 비어 있습니다.' });

    const { rows: tRows } = await pool.query(
      `SELECT id, reviewer_phone8 AS "reviewerPhone8", campaign_label AS "campaignLabel"
       FROM cs_threads WHERE id = $1 LIMIT 1`, [threadId]
    );
    if (tRows.length === 0) return res.status(404).json({ ok: false, error: '문의방을 찾을 수 없습니다.' });
    const thread = tRows[0];
    // ★ 저장은 로그인명 그대로 — 닉네임은 읽는 시점에 붙인다(닉네임을 바꾸면 과거 답장까지 함께 바뀜)
    const senderName = req.admin?.name || '관리자';
    const nickMap = await adminNickname.getNicknameMap();

    const { rows: mRows } = await pool.query(
      `INSERT INTO cs_messages (thread_id, sender_role, sender_name, content, image_urls)
       VALUES ($1, 'admin', $2, $3, $4::jsonb) RETURNING id, created_at AS "createdAt"`,
      [threadId, senderName, content, JSON.stringify(imageUrls)]
    );
    const message = {
      id: mRows[0].id, threadId, senderRole: 'admin',
      senderName: adminNickname.toAdminName(senderName, nickMap),   // 관리자 화면
      content, imageUrls, createdAt: mRows[0].createdAt,
    };

    // 관리자 답장 → 리뷰어 미확인 +1, 방 갱신(닫혀있었어도 last_message는 갱신)
    await pool.query(
      `UPDATE cs_threads
         SET reviewer_unread_count = reviewer_unread_count + 1,
             last_message_at = NOW(),
             last_message_preview = $2,
             updated_at = NOW()
       WHERE id = $1`,
      [threadId, (content || `사진 ${imageUrls.length}장`).slice(0, 120)]
    );

    // 해당 리뷰어에게만 실시간 푸시 + 다른 관리자 세션 갱신용 브로드캐스트
    // ★ 리뷰어에게 가는 실시간 푸시는 반드시 리뷰어용 이름으로(실명 유출 경로가 여기에도 있다)
    try {
      emitCsReplyToReviewer(thread.reviewerPhone8, {
        ...message,
        senderName: adminNickname.toReviewerName(senderName, nickMap),
        campaignLabel: thread.campaignLabel,
      });
    } catch (_) {}
    try { broadcast('cs_message', { threadId, senderRole: 'admin', reviewerPhone8: thread.reviewerPhone8 }); } catch (_) {}

    res.json({ ok: true, message });
  } catch (err) {
    next(err);
  }
});

// POST /api/cs/upload { imageBase64, mimeType?, fileName? } — 관리자 답장 첨부 이미지 업로드
//   리뷰어측 POST /api/reviewer/cs/upload와 동일 인프라(guide-image Drive+무인증 프록시) 재사용,
//   신규 저장소 0. 인증 계층만 다름(여긴 authMiddleware+adminOrMaster, 그쪽은 phone8 스코프).
router.post('/upload', async (req, res, next) => {
  try {
    const b = req.body || {};
    let data = String(b.imageBase64 || '');
    if (!data.trim()) return res.status(400).json({ ok: false, error: '이미지 데이터가 없습니다.' });
    let mime = (b.mimeType || '').toString();
    const m = data.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) { mime = mime || m[1]; data = m[2]; }
    if (!/^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mime || 'image/png')) {
      return res.status(400).json({ ok: false, error: '이미지 파일만 첨부할 수 있습니다.' });
    }
    // 용량 제한 8MB (base64 → 원본 약 3/4) — 리뷰어측과 동일 상한
    if (data.length * 0.75 > 8 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: '이미지가 너무 큽니다 (8MB 이하).' });
    }

    const drive = require('../services/drive.service');
    let folderId = process.env.CS_UPLOAD_FOLDER_ID || process.env.GUIDE_FOLDER_ID;
    if (!folderId) {
      const root = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
      if (!root) return res.status(503).json({ ok: false, error: '저장 폴더가 설정되지 않았습니다.' });
      const folder = await drive.ensureFolderPath(root, ['[문의첨부]']);
      folderId = folder.id;
    }
    const ext = ((mime || 'image/png').split('/')[1] || 'png').split('+')[0];
    const who = (req.admin?.name || 'admin').replace(/[^\w가-힣-]/g, '');
    let name = (b.fileName || `cs_admin_${who}_${Date.now()}`).toString().replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.' + ext;

    const up = await drive.uploadFileBase64(data, name, mime || 'image/png', folderId, { shareAnyone: true });
    const base = (process.env.PUBLIC_API_URL || ('https://' + req.get('host'))).replace(/\/+$/, '');
    res.json({ ok: true, url: `${base}/api/order/guide-image/${up.id}` });
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

// ── row_json에서 금액류 값 찾아내기(시트마다 헤더명이 달라 키워드 매칭, 표시 전용) ──
function _pickAmount(rowJson) {
  if (!rowJson || typeof rowJson !== 'object') return '';
  for (const [k, v] of Object.entries(rowJson)) {
    if (!v) continue;
    const key = String(k);
    if (!/금액|결제|가격/.test(key)) continue;
    if (/은행|계좌|예금|입금자/.test(key)) continue;   // 계좌/입금자명 계열 제외
    const s = String(v).trim();
    if (s && /[0-9]/.test(s)) return s;
  }
  return '';
}

// GET /api/cs/order-context?threadId= — 문의가 걸린 캠페인에서 그 리뷰어의 주문정보·참여이력
//   관리자가 대화를 열 때 "미리 보는 정보"용. 기존 원장에서 조립만 하고 새로 쓰는 값은 없음(읽기 전용).
router.get('/order-context', async (req, res, next) => {
  try {
    const threadId = (req.query.threadId || '').toString();
    if (!threadId) return res.status(400).json({ ok: false, error: 'threadId가 필요합니다.' });

    const { rows: tRows } = await pool.query(
      `SELECT reviewer_phone8 AS p8, reviewer_name AS nm, campaign_key AS ck
       FROM cs_threads WHERE id = $1 LIMIT 1`, [threadId]
    );
    if (tRows.length === 0) return res.status(404).json({ ok: false, error: '문의방을 찾을 수 없습니다.' });
    const p8 = tRows[0].p8;
    const ck = (tRows[0].ck || '').toString();

    // campaign_key = "sheetId||tabName" (일반 문의는 빈 값 → 주문정보 없음)
    let sheetId = null, tabName = null;
    const sep = ck.indexOf('||');
    if (sep > -1) { sheetId = ck.slice(0, sep); tabName = ck.slice(sep + 2); }

    let order = null, sheet = null;
    if (sheetId && tabName) {
      // 구매양식 제출 내용 (최근 1건)
      const { rows: oRows } = await pool.query(
        `SELECT order_num AS "orderNum", orderer, recipient, phone, address,
                selected_opt_key AS "option", date_str AS "dateStr",
                sheet_row AS "sheetRow", mirror_status AS "mirrorStatus",
                capture_file_id AS "captureFileId", submitted_at AS "submittedAt"
         FROM order_submissions
         WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
           AND RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 8) = $3
         ORDER BY submitted_at DESC LIMIT 1`, [sheetId, tabName, p8]
      );
      if (oRows.length) order = oRows[0];

      // 작업 시트 명단 (상품명·차수·리뷰제출·입금 + 금액 표시값)
      const { rows: rRows } = await pool.query(
        `SELECT product_name AS "productName", round, is_submitted AS "isSubmitted",
                is_submitted2 AS "paymentStatus", row_index AS "rowIndex", row_json AS "rowJson"
         FROM review_index
         WHERE sheet_id = $1 AND tab_name = $2 AND phone8 = $3
         ORDER BY built_at DESC LIMIT 1`, [sheetId, tabName, p8]
      );
      if (rRows.length) {
        const r = rRows[0];
        let rj = r.rowJson;
        if (typeof rj === 'string') { try { rj = JSON.parse(rj); } catch (_) { rj = null; } }
        sheet = {
          productName: r.productName || '',
          round: r.round || '',
          isSubmitted: !!r.isSubmitted,
          isPaid: r.paymentStatus === 'PAID',
          rowIndex: r.rowIndex,
          payAmount: _pickAmount(rj),
        };
      }
    }

    // 참여 이력(전체) + 문의 이력
    const { rows: hRows } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_submitted)::int AS submitted,
              COUNT(*) FILTER (WHERE is_submitted2 = 'PAID')::int AS paid
       FROM review_index WHERE phone8 = $1`, [p8]
    );
    const { rows: iRows } = await pool.query(
      `SELECT COUNT(*)::int AS threads,
              COUNT(DISTINCT campaign_key)::int AS campaigns
       FROM cs_threads WHERE reviewer_phone8 = $1`, [p8]
    );
    // 이 캠페인 참여 횟수
    let campaignJoins = 0;
    if (sheetId && tabName) {
      const { rows: cRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM review_index
         WHERE sheet_id = $1 AND tab_name = $2 AND phone8 = $3`, [sheetId, tabName, p8]
      );
      campaignJoins = cRows[0] ? cRows[0].n : 0;
    }

    res.json({
      ok: true, order, sheet,
      history: {
        total: hRows[0].total, submitted: hRows[0].submitted, paid: hRows[0].paid,
        campaignJoins,
        inquiryThreads: iRows[0].threads, inquiryCampaigns: iRows[0].campaigns,
      },
    });
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
