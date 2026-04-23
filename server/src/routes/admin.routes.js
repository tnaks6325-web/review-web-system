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
        COALESCE(im.tab_gid, tc.tab_gid) AS "tabGid",
        im.campaign_name  AS "campaignName",
        im.row_count      AS "totalCount",
        im.submitted_count AS "submittedCount",
        im.built_at       AS "builtAt",
        tc.manager,
        tc.time_range     AS "timeRange",
        tc.review_type    AS "reviewType",
        tc.payment_type   AS "paymentType",
        tc.display_name   AS "displayName",
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
        tabGid:      t.tabGid || '',
        total,
        submitted,
        pending,
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

    // 7. 빌드 잠금 상태 + 다음 CRON 실행 시각
    let buildLock = { locked: false, elapsedSec: 0 };
    try {
      const { rows: lockRows } = await pool.query(
        "SELECT * FROM build_locks WHERE lock_key = 'INDEX_BUILD'"
      );
      if (lockRows.length > 0 && lockRows[0].is_locked) {
        const elapsed = lockRows[0].locked_at ? Date.now() - new Date(lockRows[0].locked_at).getTime() : 0;
        buildLock = { locked: true, elapsedSec: Math.round(elapsed / 1000) };
      }
    } catch (_) {}

    const { calcNextCronTimes } = require('../utils/cronCalc');
    const cron = calcNextCronTimes();

    res.json({
      stats,
      grand: {
        total:     grandTotal,
        submitted: grandSubmitted,
        pending:   grandTotal - grandSubmitted,
      },
      closedTabs,
      indexBuiltAt,
      buildLock,
      cron,
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

// ═══════════════════════════════════════════════════════════
// Phase 14: 인덱스 키워드 관리 API
// ═══════════════════════════════════════════════════════════

// GET /api/admin/keywords — 키워드 목록 조회
router.get('/keywords', authMiddleware, async (req, res, next) => {
  try {
    const { category } = req.query;
    let sql = 'SELECT id, category, keyword, active, created_at, created_by FROM index_keywords';
    const params = [];
    if (category) {
      sql += ' WHERE category = $1';
      params.push(category);
    }
    sql += ' ORDER BY category, keyword';
    const { rows } = await pool.query(sql, params);

    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r);
    });

    res.json({ ok: true, keywords: rows, grouped, total: rows.length });
  } catch (err) { next(err); }
});

// POST /api/admin/keywords — 키워드 추가
router.post('/keywords', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { category, keyword } = req.body;
    if (!category || !keyword) return res.json({ error: 'category와 keyword 필요' });

    const validCategories = ['data_tab', 'name', 'submit', 'product', 'url', 'phone', 'start_date', 'end_date', 'round', 'system_tab'];
    if (!validCategories.includes(category)) return res.json({ error: '유효하지 않은 category: ' + category });

    const { rows } = await pool.query(
      `INSERT INTO index_keywords (category, keyword, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (category, keyword) DO UPDATE SET active = TRUE
       RETURNING id, category, keyword, active`,
      [category, keyword.trim(), req.user?.name || 'admin']
    );
    res.json({ ok: true, keyword: rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/admin/keywords/:id — 키워드 활성/비활성 토글
router.put('/keywords/:id', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { active } = req.body;
    if (typeof active !== 'boolean') return res.json({ error: 'active 필드 필요 (boolean)' });

    const { rowCount } = await pool.query('UPDATE index_keywords SET active = $1 WHERE id = $2', [active, id]);
    if (rowCount === 0) return res.json({ error: '키워드를 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/keywords/:id — 키워드 삭제
router.delete('/keywords/:id', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM index_keywords WHERE id = $1', [id]);
    if (rowCount === 0) return res.json({ error: '키워드를 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// Phase 14: 인식 실패 탭 진단 API
// ═══════════════════════════════════════════════════════════

// GET /api/admin/unrecognized — 인식 실패 탭 목록
// no_data (헤더 정상 / 데이터 미입력 = 진행 중인 탭)는 기본적으로 제외
// ?include_no_data=true 로 포함 가능
router.get('/unrecognized', authMiddleware, async (req, res, next) => {
  try {
    const { status, include_no_data } = req.query;
    const conditions = [];
    const params = [];

    // no_data 제외 (진행 중인 탭이므로 인식 실패가 아님)
    if (include_no_data !== 'true') {
      conditions.push(`reason != 'no_data'`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    let sql = `SELECT id, sheet_id, tab_name, tab_gid, campaign_name, sample_rows, reason, status, ignored_by, ignored_at, detected_at
               FROM unrecognized_tabs`;
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY detected_at DESC';
    const { rows } = await pool.query(sql, params);

    const pendingCount = rows.filter(r => r.status === 'pending').length;
    res.json({ ok: true, tabs: rows, total: rows.length, pendingCount });
  } catch (err) { next(err); }
});

// POST /api/admin/unrecognized/ignore — 탭 무시 처리
router.post('/unrecognized/ignore', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.json({ error: 'ids 배열 필요' });

    const { rowCount } = await pool.query(
      `UPDATE unrecognized_tabs SET status = 'ignored', ignored_by = $1, ignored_at = NOW()
       WHERE id = ANY($2) AND status = 'pending'`,
      [req.user?.name || 'admin', ids]
    );
    res.json({ ok: true, updated: rowCount });
  } catch (err) { next(err); }
});

// POST /api/admin/unrecognized/resolve — 탭 해결됨 처리
router.post('/unrecognized/resolve', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.json({ error: 'ids 배열 필요' });

    const { rowCount } = await pool.query(
      `UPDATE unrecognized_tabs SET status = 'resolved', ignored_by = $1, ignored_at = NOW()
       WHERE id = ANY($2)`,
      [req.user?.name || 'admin', ids]
    );
    res.json({ ok: true, updated: rowCount });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// ★ 스마트 빌드 (Drive API + Sheets batchGet 기반 — 기존 인덱스빌드와 별개)
// ═══════════════════════════════════════════════════════════
const {
  runSmartBuild,
  startSmartBuild,
  stopSmartBuild,
  getSmartBuildStatus,
  resetSmartBuildCache,
} = require('../services/smartBuild.service');

// GET /api/admin/smart-build/status — 스마트 빌드 상태 조회
router.get('/smart-build/status', authMiddleware, async (req, res, next) => {
  try {
    const status = getSmartBuildStatus();
    res.json({ ok: true, ...status });
  } catch (err) { next(err); }
});

// POST /api/admin/smart-build/run — 스마트 빌드 1회 수동 실행
router.post('/smart-build/run', authMiddleware, async (req, res, next) => {
  try {
    // 비동기 실행: 즉시 "시작됨" 응답 → 백그라운드 처리
    const statusBefore = getSmartBuildStatus();
    if (statusBefore.running) {
      return res.json({ ok: false, error: '이미 스마트 빌드가 실행 중입니다.' });
    }

    // 백그라운드 실행
    runSmartBuild().then(result => {
      const { broadcast } = require('../utils/sse');
      broadcast('smart_build_done', {
        message: `스마트빌드 완료: ${result.tabsUpdated}탭 갱신, ${result.tabsSkipped}탭 스킵, ${result.errors}건 오류`,
        ...result,
      });
    }).catch(err => {
      const { logger } = require('../utils/logger');
      logger.error(`[smartBuild] 수동 실행 오류: ${err.message}`);
    });

    res.json({ ok: true, message: '스마트 빌드를 시작했습니다. 완료 시 SSE로 알림됩니다.' });
  } catch (err) { next(err); }
});

// POST /api/admin/smart-build/start — 스케줄러 시작 (5분 주기)
router.post('/smart-build/start', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const started = startSmartBuild();
    res.json({ ok: true, started, status: getSmartBuildStatus() });
  } catch (err) { next(err); }
});

// POST /api/admin/smart-build/stop — 스케줄러 정지
router.post('/smart-build/stop', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const stopped = stopSmartBuild();
    res.json({ ok: true, stopped, status: getSmartBuildStatus() });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/db-rebuild — DB 전체 초기화 + 탭목록에서 재등록 + 스마트빌드
// 단계: ① 4테이블 TRUNCATE ② 캐시 리셋 ③ syncTabListToDB ④ smartBuild
// ══════════════════════════════════════════════════════════════
router.post('/db-rebuild', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  const { logger } = require('../utils/logger');
  const { broadcast } = require('../utils/sse');

  try {
    const { confirm } = req.body;
    if (confirm !== 'REBUILD_DB') {
      return res.status(400).json({
        error: '확인 코드가 올바르지 않습니다. confirm: "REBUILD_DB" 필요'
      });
    }

    // 스마트빌드 실행 중이면 거부
    const sbStatus = getSmartBuildStatus();
    if (sbStatus.running) {
      return res.status(409).json({
        error: '스마트빌드가 실행 중입니다. 완료 후 다시 시도하세요.'
      });
    }

    const startTime = Date.now();
    const steps = [];

    // ── Step 1: 4개 테이블 TRUNCATE ──
    logger.warn(`[db-rebuild] ⚠ DB 전체 초기화 시작 — by ${req.admin?.name || 'unknown'}`);
    broadcast('db_rebuild_progress', { step: 1, message: 'DB 테이블 초기화 중...' });

    const client = await pool.connect();
    const deleted = {};
    try {
      await client.query('BEGIN');
      const tables = ['review_index', 'index_master', 'tab_configs', 'campaigns'];
      for (const table of tables) {
        const r = await client.query(`DELETE FROM ${table}`);
        deleted[table] = r.rowCount;
      }
      // build_history, smart build 로그도 초기화
      const r2 = await client.query('DELETE FROM build_history');
      deleted.build_history = r2.rowCount;

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    steps.push({ step: 1, action: 'TRUNCATE', deleted, elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s` });
    logger.info(`[db-rebuild] Step1 완료: ${JSON.stringify(deleted)}`);

    // ── Step 2: 스마트빌드 캐시 리셋 ──
    broadcast('db_rebuild_progress', { step: 2, message: '캐시 리셋 중...' });
    const cacheReset = resetSmartBuildCache();
    steps.push({ step: 2, action: 'CACHE_RESET', ...cacheReset });
    logger.info(`[db-rebuild] Step2 캐시 리셋: ${JSON.stringify(cacheReset)}`);

    // ── Step 3a: 시트DB에서 전체 탭 스캔 (시트DB → 각 시트 탭 파싱 → 탭목록 시트 기록) ──
    broadcast('db_rebuild_progress', { step: '3a', message: '시트DB에서 전체 탭 스캔 중... (시간 소요)' });
    const { runIndexScan, syncTabListToDB } = require('../services/indexScan.service');
    const scanResult = await runIndexScan(false);  // dryRun=false: 탭목록 시트에 기록 + 캐시 저장
    steps.push({ step: '3a', action: 'INDEX_SCAN', sheets: scanResult.sheetsScanned, tabs: scanResult.totalTabs, errors: scanResult.errors, errorDetails: scanResult.errorDetails, elapsed: scanResult.elapsed });
    logger.info(`[db-rebuild] Step3a 인덱스 스캔 완료: ${scanResult.sheetsScanned}시트, ${scanResult.totalTabs}탭, 오류 ${scanResult.errors}건 (${scanResult.elapsed})`);

    // ── Step 3b: 스캔 캐시를 DB에 반영 (campaigns + tab_configs + index_master 재등록) ──
    broadcast('db_rebuild_progress', { step: '3b', message: '스캔 결과를 DB에 등록 중...' });
    const syncResult = await syncTabListToDB({ dryRun: false, fromCache: true });
    steps.push({ step: '3b', action: 'SYNC_TAB_LIST', ...syncResult });
    logger.info(`[db-rebuild] Step3b DB 동기화: ${syncResult.message}`);

    // ── Step 4: 스마트빌드 1회 실행 (백그라운드) ──
    broadcast('db_rebuild_progress', { step: 4, message: '스마트빌드 실행 시작... (백그라운드)' });

    // 백그라운드로 스마트빌드 실행
    runSmartBuild().then(result => {
      const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`[db-rebuild] Step4 스마트빌드 완료: ${result.tabsUpdated}탭 갱신, ${result.tabsSkipped}탭 스킵`);
      broadcast('db_rebuild_done', {
        message: `DB 재구축 완료 (${totalElapsed}s): ${result.tabsUpdated}탭 갱신`,
        steps: [...steps, { step: 4, action: 'SMART_BUILD', ...result }],
        totalElapsed: `${totalElapsed}s`,
      });
    }).catch(err => {
      logger.error(`[db-rebuild] Step4 스마트빌드 오류: ${err.message}`);
      broadcast('db_rebuild_done', {
        message: `DB 재구축 부분 완료 (스마트빌드 오류): ${err.message}`,
        steps,
        error: err.message,
      });
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    res.json({
      ok: true,
      message: `DB 초기화 + 탭목록 재등록 완료 (${elapsed}s). 스마트빌드가 백그라운드에서 실행 중입니다.`,
      steps,
      elapsed: `${elapsed}s`,
    });

  } catch (err) {
    logger.error(`[db-rebuild] 오류: ${err.message}`);
    next(err);
  }
});

module.exports = router;
