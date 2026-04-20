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
// GET /api/admin/dashboard — 대시보드 데이터 (GAS 호환 stats/grand 형식)
// 프론트엔드가 기대하는 형식:
//   { stats: [{ campaign, total, submitted, tabs:[...] }], grand: { total, submitted, pending }, closedTabs, indexBuiltAt }
// ═══════════════════════════════════════════════════════════
router.get('/dashboard', authMiddleware, async (req, res, next) => {
  try {
    // 1. 탭 통계 (index_master + tab_configs JOIN + review_index에서 시작일/종료일 추출)
    const { rows: tabs } = await pool.query(`
      SELECT
        im.sheet_id       AS "sheetId",
        im.tab_name       AS "tabName",
        im.campaign_name  AS "campaignName",
        im.row_count      AS "totalCount",
        im.submitted_count AS "submittedCount",
        im.built_at       AS "builtAt",
        tc.manager,
        tc.time_range     AS "timeRange",
        tc.review_type    AS "reviewType",
        tc.payment_type   AS "paymentType",
        tc.display_name   AS "displayName",
        tc.force_done     AS "forceDone",
        tc.is_closed      AS "isClosed",
        tc.folder_url     AS "folderUrl",
        tc.capture_folder_url AS "captureFolderUrl",
        tc.is_bulk        AS "isBulk",
        tc.delivery_type  AS "deliveryType",
        tc.round,
        tc.nc_mode        AS "ncMode",
        tc.deposit_name   AS "depositName",
        tc.transfer_bank  AS "transferBank",
        tc.income_type    AS "incomeType",
        tc.taekhap,
        tc.sheet_url      AS "sheetUrl",
        tc.campaign_name  AS "tcCampaignName",
        sd.start_date     AS "startDate",
        sd.end_date       AS "endDate"
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      LEFT JOIN LATERAL (
        SELECT MIN(ri.start_date) AS start_date, MAX(ri.end_date) AS end_date
        FROM review_index ri
        WHERE ri.sheet_id = im.sheet_id AND ri.tab_name = im.tab_name
          AND (ri.start_date IS NOT NULL OR ri.end_date IS NOT NULL)
      ) sd ON true
      WHERE im.status = 'active'
      ORDER BY im.built_at DESC NULLS LAST
    `);

    // 2. 마감 탭 목록 (is_closed=true인 tab_configs — 인덱스에 없을 수 있음)
    const { rows: closedConfigs } = await pool.query(`
      SELECT sheet_id AS "sheetId", tab_name AS "tabName", campaign_name AS "campaignName"
      FROM tab_configs WHERE is_closed = TRUE
    `);

    // 3. 최근 인덱스 빌드 시각
    const { rows: buildRows } = await pool.query(`
      SELECT MAX(built_at) AS "maxBuilt" FROM index_master
    `);
    const indexBuiltAt = buildRows[0]?.maxBuilt
      ? new Date(buildRows[0].maxBuilt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
      : null;

    // 4. sheetId(광고주 구글시트) 기준 그룹핑 → stats 배열 생성
    // 같은 sheetId의 탭들이 하나의 캠페인 블록으로 묶임
    const campMap = new Map(); // sheetId → { campaign, total, submitted, tabs:[] }
    let grandTotal = 0, grandSubmitted = 0;

    tabs.forEach(t => {
      const groupKey  = t.sheetId; // sheetId 기준 그룹핑
      const campName  = t.campaignName || t.tcCampaignName || '미분류';
      const total     = parseInt(t.totalCount) || 0;
      const submitted = parseInt(t.submittedCount) || 0;
      const pending   = total - submitted;

      if (!campMap.has(groupKey)) {
        campMap.set(groupKey, { campaign: campName, sheetId: groupKey, total: 0, submitted: 0, tabs: [], closedOnly: false });
      }
      const camp = campMap.get(groupKey);
      // 캠페인명 업데이트 (빈 문자열이 아닌 첫 번째 유효한 이름 사용)
      if ((!camp.campaign || camp.campaign === '미분류') && campName && campName !== '미분류') {
        camp.campaign = campName;
      }
      camp.total     += total;
      camp.submitted += submitted;
      grandTotal     += total;
      grandSubmitted += submitted;

      // 시작일/종료일 (review_index LATERAL JOIN에서 추출)
      const startDate = t.startDate || '';
      const endDate   = t.endDate || '';

      camp.tabs.push({
        sheetId:     t.sheetId,
        tab:         t.tabName,
        total,
        submitted,
        pending,
        forceDone:   !!t.forceDone,
        isClosed:    !!t.isClosed,
        displayName: t.displayName || '',
        manager:     t.manager || '',
        timeRange:   t.timeRange || '',
        reviewType:  t.reviewType || '',
        paymentType: t.paymentType || '',
        startDate:   startDate,
        endDate:     endDate,
        sheetUrl:    t.sheetUrl || '',
        taekhap:     !!t.taekhap,
        isBulk:      !!t.isBulk,
        deliveryType: t.deliveryType || '',
        round:       t.round || '',
        ncMode:      !!t.ncMode,
        depositName: t.depositName || '',
        transferBank: t.transferBank || '',
        incomeType:  t.incomeType || '',
        folderUrl:   t.folderUrl || '',
        captureFolderUrl: t.captureFolderUrl || '',
      });
    });

    // 5. 마감 탭 중 index_master에 없는 것도 closedTabs에 포함
    const closedTabs = closedConfigs.map(c => ({
      sheetId: c.sheetId,
      tab:     c.tabName,
    }));

    // 6. stats 배열 정렬 (캠페인명 순)
    const stats = Array.from(campMap.values()).sort((a, b) => a.campaign.localeCompare(b.campaign));

    res.json({
      stats,
      grand: {
        total:     grandTotal,
        submitted: grandSubmitted,
        pending:   grandTotal - grandSubmitted,
      },
      closedTabs,
      indexBuiltAt,
    });
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
