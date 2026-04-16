const express = require('express');
const router = express.Router();
const { authMiddleware, masterOnlyMiddleware } = require('../middleware/auth.middleware');
const {
  loginAdmin, loginStaff,
  addAdminUser, editAdminUser, deleteAdminUser, listAdminUsers,
  addStaffUser, editStaffUser, deleteStaffUser, listStaffUsers,
  changePw, changeMasterPw,
} = require('../services/auth.service');
const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════
// POST /api/admin/login — 관리자 로그인 (GAS: adminLoginV2)
// ═══════════════════════════════════════════════════════════
router.post('/login', async (req, res, next) => {
  try {
    const { name, pw } = req.body;
    const result = await loginAdmin(name, pw);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/admin/staff-login — 영업담당자 로그인 (GAS: staffLogin)
// ═══════════════════════════════════════════════════════════
router.post('/staff-login', async (req, res, next) => {
  try {
    const { name, pw } = req.body;
    const result = await loginStaff(name, pw);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/admin/change-pw — 비밀번호 변경 (GAS: adminChangePw)
// ═══════════════════════════════════════════════════════════
router.post('/change-pw', authMiddleware, async (req, res, next) => {
  try {
    const { currentPw, newPw } = req.body;
    const result = await changePw(req.admin.name, currentPw, newPw);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/admin/change-master-pw — 마스터 비밀번호 변경 (GAS: changeMasterPw)
// ═══════════════════════════════════════════════════════════
router.post('/change-master-pw', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { masterPw, newPw } = req.body;
    const result = await changeMasterPw(masterPw, newPw);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/admin/users — 관리자 계정 CRUD (GAS: add/edit/delete/listAdminUser)
// ═══════════════════════════════════════════════════════════
router.post('/users', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { action, masterPw, name, pw, newPw, active } = req.body;

    // masterOnlyMiddleware에서 이미 role='master' 검증 완료
    // masterPw는 선택 사항 — GAS 호환용 (보내면 추가 검증)
    if (masterPw && masterPw !== process.env.MASTER_ADMIN_PW) {
      return res.json({ ok: false, error: '마스터 비밀번호가 틀렸습니다.' });
    }

    switch (action) {
      case 'add':
        if (!name || !pw) return res.json({ error: '이름과 비밀번호를 입력하세요.' });
        return res.json(await addAdminUser(name, pw));
      case 'edit':
        if (!name) return res.json({ error: '이름이 필요합니다.' });
        return res.json(await editAdminUser(name, newPw || pw, active));
      case 'delete':
        if (!name) return res.json({ error: '삭제할 계정 이름이 필요합니다.' });
        return res.json(await deleteAdminUser(name));
      case 'list':
        const users = await listAdminUsers();
        return res.json({ success: true, users });
      default:
        return res.json({ error: '알 수 없는 action: ' + action });
    }
  } catch (err) {
    // GAS 호환: error 필드로 반환
    res.json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/admin/staff-users — 영업담당자 계정 CRUD (GAS: add/edit/delete/listStaffUser)
// ═══════════════════════════════════════════════════════════
router.post('/staff-users', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { action, masterPw, name, pw, newPw, active } = req.body;

    // masterOnlyMiddleware에서 이미 role='master' 검증 완료
    if (masterPw && masterPw !== process.env.MASTER_ADMIN_PW) {
      return res.json({ error: '마스터 권한이 필요합니다.' });
    }

    switch (action) {
      case 'add':
        if (!name || !pw) return res.json({ error: '이름과 비밀번호를 입력하세요.' });
        return res.json(await addStaffUser(name, pw));
      case 'edit':
        if (!name) return res.json({ error: '이름이 필요합니다.' });
        return res.json(await editStaffUser(name, newPw || pw, active));
      case 'delete':
        if (!name) return res.json({ error: '삭제할 이름이 필요합니다.' });
        return res.json(await deleteStaffUser(name));
      case 'list':
        const users = await listStaffUsers();
        return res.json({ success: true, users });
      default:
        return res.json({ error: '알 수 없는 action: ' + action });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/admin/dashboard — 대시보드 데이터 (GAS: dashboard — staff.html)
// ═══════════════════════════════════════════════════════════
router.get('/dashboard', authMiddleware, async (req, res, next) => {
  try {
    // 탭 통계 (index_master 기반)
    const { rows: tabs } = await pool.query(`
      SELECT
        im.sheet_id AS "sheetId",
        im.tab_name AS "tabName",
        im.campaign_name AS "campaignName",
        im.row_count AS "totalCount",
        im.submitted_count AS "submittedCount",
        tc.manager,
        tc.force_done AS "forceDone",
        tc.is_closed AS "isClosed"
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      WHERE im.status = 'active'
      ORDER BY im.built_at DESC NULLS LAST
    `);

    // 캠페인 목록
    const { rows: campaigns } = await pool.query(`
      SELECT DISTINCT sheet_id AS "sheetId", campaign_name AS "campaignName", sheet_url AS "sheetUrl"
      FROM tab_configs
      WHERE campaign_name IS NOT NULL AND campaign_name != ''
      ORDER BY campaign_name
    `);

    // detailMap 구축 (GAS 호환 — tab_key 형식)
    const { rows: allConfigs } = await pool.query('SELECT * FROM tab_configs');
    const detailMap = {};
    allConfigs.forEach(r => {
      const key = `${r.sheet_id}||${r.tab_name}`;
      detailMap[key] = {
        manager: r.manager,
        timeRange: r.time_range,
        reviewType: r.review_type,
        taekhap: r.taekhap,
        paymentType: r.payment_type,
        displayName: r.display_name,
        forceDone: r.force_done,
        isClosed: r.is_closed,
        folderUrl: r.folder_url,
        captureFolderUrl: r.capture_folder_url,
        isBulk: r.is_bulk,
        deliveryType: r.delivery_type,
        round: r.round,
        ncMode: r.nc_mode,
        depositName: r.deposit_name,
        transferBank: r.transfer_bank,
        incomeType: r.income_type,
        campaignName: r.campaign_name,
        sheetUrl: r.sheet_url,
      };
    });

    res.json({ tabs, campaigns, detailMap });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/admin/release-lock — 빌드 잠금 해제 (GAS: releaseBuildLock)
// ═══════════════════════════════════════════════════════════
router.post('/release-lock', authMiddleware, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE build_locks SET is_locked = FALSE, locked_at = NULL, locked_by = NULL WHERE lock_key = 'INDEX_BUILD'`
    );
    res.json({ ok: true, message: '빌드 잠금이 해제되었습니다.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
