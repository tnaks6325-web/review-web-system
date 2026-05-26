const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');
const { appendSheet, readSheet } = require('../services/sheets.service');
const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
// 공개 API (로그인 불필요)
// ═══════════════════════════════════════════════════════════

// GET /api/campaign/list — 공개 캠페인 목록 (active 우선, closed 하단)
router.get('/list', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, channel, channel_custom, manager, time_range,
             delivery_type, review_fee, badges, notes, chat_url,
             status, sort_order, max_slots, current_slots, deadline,
             description, linked_sheet_id, linked_tab_name,
             created_at
      FROM campaigns
      WHERE status IN ('active', 'closed')
      ORDER BY 
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        sort_order ASC,
        created_at DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/:id — 캠페인 상세
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/:id/applications — 캠페인 참여자 목록 (공개)
router.get('/:id/applications', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT applicant_name, applied_at FROM campaign_applications 
       WHERE campaign_id = $1 AND status = 'confirmed' 
       ORDER BY applied_at ASC`,
      [id]
    );
    res.json({ ok: true, data: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/:id/apply — 참여 신청
router.post('/:id/apply', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, inad } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: '이름을 입력해주세요.' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ ok: false, error: '연락처를 입력해주세요.' });
    }

    const trimName = name.trim();
    const trimPhone = phone.trim();
    const trimInad = (inad || '').trim();

    // 1. 캠페인 존재 + 상태 확인
    const { rows: campRows } = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1',
      [id]
    );
    if (campRows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    const camp = campRows[0];

    if (camp.status !== 'active') {
      return res.status(400).json({ ok: false, error: '모집이 마감된 캠페인입니다.' });
    }

    // 2. 정원 초과 확인
    if (camp.max_slots > 0 && camp.current_slots >= camp.max_slots) {
      // 자동 마감 처리
      await pool.query("UPDATE campaigns SET status = 'closed', updated_at = NOW() WHERE id = $1", [id]);
      return res.status(400).json({ ok: false, error: '정원이 초과되어 모집이 마감되었습니다.' });
    }

    // 3. 중복 신청 확인
    const { rows: dupRows } = await pool.query(
      `SELECT id FROM campaign_applications 
       WHERE campaign_id = $1 AND applicant_name = $2 AND applicant_phone = $3 AND status = 'confirmed'`,
      [id, trimName, trimPhone]
    );
    if (dupRows.length > 0) {
      return res.status(400).json({ ok: false, error: '이미 참여 신청한 캠페인입니다.' });
    }

    // 4. 참여 기록 저장
    await pool.query(
      `INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, applicant_inad, status)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [id, trimName, trimPhone, trimInad]
    );

    // 5. current_slots 증가
    const { rows: updatedRows } = await pool.query(
      `UPDATE campaigns SET current_slots = current_slots + 1, updated_at = NOW() WHERE id = $1 RETURNING current_slots, max_slots`,
      [id]
    );
    const updatedCamp = updatedRows[0];

    // 6. 정원 꽉 찬 경우 자동 마감
    if (updatedCamp.max_slots > 0 && updatedCamp.current_slots >= updatedCamp.max_slots) {
      await pool.query("UPDATE campaigns SET status = 'closed', updated_at = NOW() WHERE id = $1", [id]);
    }

    // 7. 스프레드시트에 행 자동 추가 (비동기 — 실패해도 참여 확정됨)
    if (camp.linked_sheet_id && camp.linked_tab_name) {
      setImmediate(async () => {
        try {
          await _addApplicationToSheet(camp, { name: trimName, phone: trimPhone, inad: trimInad });
          // 시트 추가 성공 기록
          await pool.query(
            `UPDATE campaign_applications SET sheet_row_added = TRUE 
             WHERE campaign_id = $1 AND applicant_name = $2 AND applicant_phone = $3`,
            [id, trimName, trimPhone]
          );
          logger.info(`[campaign/apply] 시트 행 추가 성공: ${camp.title} - ${trimName}`);
        } catch (sheetErr) {
          logger.error(`[campaign/apply] 시트 행 추가 실패: ${sheetErr.message}`);
        }
      });
    }

    res.json({
      ok: true,
      message: '참여 신청이 완료되었습니다!',
      currentSlots: updatedCamp.current_slots,
      maxSlots: updatedCamp.max_slots,
    });
  } catch (err) {
    // 유니크 제약 위반 (동시 요청 방어)
    if (err.code === '23505') {
      return res.status(400).json({ ok: false, error: '이미 참여 신청한 캠페인입니다.' });
    }
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 관리자 API (인증 필요)
// ═══════════════════════════════════════════════════════════

// GET /api/campaign/admin/list — 관리자 전체 목록 (draft 포함)
router.get('/admin/list', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM campaigns
      ORDER BY 
        CASE WHEN status = 'active' THEN 0 WHEN status = 'draft' THEN 1 ELSE 2 END,
        sort_order ASC,
        created_at DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/admin/create — 캠페인 생성
router.post('/admin/create', authMiddleware, async (req, res, next) => {
  try {
    const {
      title, channel, channel_custom, manager, time_range,
      delivery_type, review_fee, badges, notes, chat_url,
      status, sort_order, max_slots, deadline, description,
      linked_sheet_id, linked_tab_name, linked_tab_gid,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ ok: false, error: '공고 제목을 입력해주세요.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO campaigns 
       (title, channel, channel_custom, manager, time_range, delivery_type,
        review_fee, badges, notes, chat_url, status, sort_order,
        max_slots, deadline, description, linked_sheet_id, linked_tab_name, linked_tab_gid,
        created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        title.trim(),
        channel || '',
        channel_custom || '',
        manager || '',
        time_range || '',
        delivery_type || '',
        review_fee || 0,
        JSON.stringify(badges || []),
        notes || '',
        chat_url || '',
        status || 'draft',
        sort_order || 0,
        max_slots || 0,
        deadline || null,
        description || '',
        linked_sheet_id || '',
        linked_tab_name || '',
        linked_tab_gid || '',
        req.admin?.name || '',
      ]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaign/admin/:id — 캠페인 수정
router.put('/admin/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      title, channel, channel_custom, manager, time_range,
      delivery_type, review_fee, badges, notes, chat_url,
      status, sort_order, max_slots, deadline, description,
      linked_sheet_id, linked_tab_name, linked_tab_gid,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE campaigns SET
        title = COALESCE($2, title),
        channel = COALESCE($3, channel),
        channel_custom = COALESCE($4, channel_custom),
        manager = COALESCE($5, manager),
        time_range = COALESCE($6, time_range),
        delivery_type = COALESCE($7, delivery_type),
        review_fee = COALESCE($8, review_fee),
        badges = COALESCE($9, badges),
        notes = COALESCE($10, notes),
        chat_url = COALESCE($11, chat_url),
        status = COALESCE($12, status),
        sort_order = COALESCE($13, sort_order),
        max_slots = COALESCE($14, max_slots),
        deadline = $15,
        description = COALESCE($16, description),
        linked_sheet_id = COALESCE($17, linked_sheet_id),
        linked_tab_name = COALESCE($18, linked_tab_name),
        linked_tab_gid = COALESCE($19, linked_tab_gid),
        updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        title, channel, channel_custom, manager, time_range,
        delivery_type, review_fee || 0,
        badges ? JSON.stringify(badges) : null,
        notes, chat_url, status, sort_order || 0,
        max_slots || 0, deadline || null, description,
        linked_sheet_id, linked_tab_name, linked_tab_gid,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/campaign/admin/:id — 캠페인 삭제
router.delete('/admin/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM campaigns WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, message: '삭제되었습니다.' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaign/admin/:id/status — 상태 변경 (active/closed/draft)
router.put('/admin/:id/status', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['draft', 'active', 'closed'].includes(status)) {
      return res.status(400).json({ ok: false, error: '유효하지 않은 상태입니다.' });
    }
    const { rows } = await pool.query(
      `UPDATE campaigns SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/admin/:id/applications — 관리자: 참여자 전체 목록
router.get('/admin/:id/applications', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM campaign_applications 
       WHERE campaign_id = $1 
       ORDER BY applied_at ASC`,
      [id]
    );
    res.json({ ok: true, data: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 내부: 시트 행 자동 추가
// ═══════════════════════════════════════════════════════════

/**
 * 캠페인 참여 시 연결된 시트 탭에 행 추가
 * 헤더를 읽어서 매핑 후 appendSheet 사용
 */
async function _addApplicationToSheet(campaign, applicant) {
  const { linked_sheet_id, linked_tab_name, linked_tab_gid } = campaign;
  if (!linked_sheet_id || !linked_tab_name) return;

  const opts = linked_tab_gid ? { gid: linked_tab_gid } : {};
  const escapedTab = linked_tab_name.replace(/'/g, "''");

  // 상위 50행 읽어서 헤더 탐색
  const allRows = await readSheet(linked_sheet_id, `'${escapedTab}'!A1:ZZ50`, opts);
  if (!allRows || allRows.length === 0) {
    throw new Error('시트 데이터를 읽을 수 없습니다.');
  }

  // 헤더 행 감지
  const HEADER_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호', '아이디', '주소'];
  let headerRow = null;
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(allRows.length, 50); i++) {
    const cells = (allRows[i] || []).map(c => String(c || '').trim());
    let matchCount = 0;
    for (const kw of HEADER_KEYWORDS) {
      if (cells.some(c => c.includes(kw))) {
        matchCount++;
        if (matchCount >= 2) { headerRow = cells; headerRowIdx = i; break; }
      }
    }
    if (headerRow) break;
  }

  if (!headerRow) {
    throw new Error('시트에서 헤더 행을 감지할 수 없습니다.');
  }

  // 헤더 매핑: 이름/연락처/인애드명 컬럼 찾기
  const NAME_ALIASES = ['수취인', '수취인명', '주문자', '성함', '이름', '성명', '신청자'];
  const PHONE_ALIASES = ['연락처', '전화번호', '전번뒷자리', '핸드폰', '휴대폰'];
  const INAD_ALIASES = ['인애드', '인애드명', '인애드제출', '카톡', '카카오', '닉네임'];
  const NUM_ALIASES = ['번호', 'No', 'NO', 'no'];

  const findCol = (aliases) => {
    for (const alias of aliases) {
      const idx = headerRow.findIndex(h => h.includes(alias));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const nameColIdx = findCol(NAME_ALIASES);
  const phoneColIdx = findCol(PHONE_ALIASES);
  const inadColIdx = findCol(INAD_ALIASES);
  const numColIdx = findCol(NUM_ALIASES);

  if (nameColIdx < 0) {
    throw new Error('시트에서 이름 컬럼을 찾을 수 없습니다.');
  }

  // 현재 데이터 행 수 파악 (번호 자동 부여용)
  const dataRows = allRows.slice(headerRowIdx + 1);
  const nextNum = dataRows.length + 1;

  // 새 행 구성 (헤더 길이만큼 빈 셀로 채운 후 매핑)
  const newRow = new Array(headerRow.length).fill('');
  
  if (numColIdx >= 0) newRow[numColIdx] = nextNum;
  newRow[nameColIdx] = applicant.name;
  if (phoneColIdx >= 0 && applicant.phone) newRow[phoneColIdx] = applicant.phone;
  if (inadColIdx >= 0 && applicant.inad) newRow[inadColIdx] = applicant.inad;

  // appendSheet로 행 추가
  await appendSheet(
    linked_sheet_id,
    `'${escapedTab}'!A1`,
    [newRow],
    opts
  );

  logger.info(`[campaign/sheet] 행 추가 완료: ${linked_tab_name} - ${applicant.name} (행 ${headerRowIdx + 1 + nextNum})`);
}

module.exports = router;
