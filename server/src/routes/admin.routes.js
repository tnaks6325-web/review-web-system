const express = require('express');
const router = express.Router();
const { authMiddleware, masterOnlyMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const {
  loginAdmin, loginStaff, loginAdvertiser, loginIntranet,
  addAdminUser, editAdminUser, deleteAdminUser, listAdminUsers,
  addStaffUser, editStaffUser, deleteStaffUser, listStaffUsers,
  addAdvertiserUser, editAdvertiserUser, deleteAdvertiserUser, listAdvertiserUsers,
  changePw, changeMasterPw,
} = require('../services/auth.service');
const adminNickname = require('../services/adminNickname.service');
const {
  listEditors, addEditor, removeEditor, setEditorActive,
} = require('../services/reviewerCampaignEditor.service');
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
// POST /api/admin/intranet-login — 인트라넷(inadd) 계정으로 AE(staff) 로그인
//   Track B 통합작업대 SSO: 인트라넷 서버에 자격 프록시 검증 후 review JWT(role='staff') 발급.
//   인트라넷 로그인 성공 시점에 이 엔드포인트로 받은 토큰을 #sso 프래그먼트로 이어받는다.
// ═══════════════════════════════════════════════════════════
const { intranetLoginLimiter } = require('../middleware/rateLimit.middleware');
router.post('/intranet-login', intranetLoginLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await loginIntranet(b.name || b.username, b.pw || b.password));
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/admin/advertiser-login — 광고주(거래처) 로그인 (업무포털)
// ═══════════════════════════════════════════════════════════
router.post('/advertiser-login', async (req, res, next) => {
  try {
    const { name, pw } = req.body;
    const result = await loginAdvertiser(name, pw);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/admin/advertiser-users — 광고주 계정 CRUD (master/admin 전용)
// body: { action: 'add'|'edit'|'delete'|'list', name, pw, newPw, active, advertiserId }
// ═══════════════════════════════════════════════════════════
router.post('/advertiser-users', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { action, name, pw, newPw, active, advertiserId } = req.body;

    switch (action) {
      case 'add':
        if (!name || !pw) return res.json({ error: '이름과 비밀번호를 입력하세요.' });
        return res.json(await addAdvertiserUser(name, pw, advertiserId));
      case 'edit':
        if (!name) return res.json({ error: '이름이 필요합니다.' });
        return res.json(await editAdvertiserUser(name, newPw || pw, active));
      case 'delete':
        if (!name) return res.json({ error: '삭제할 이름이 필요합니다.' });
        return res.json(await deleteAdvertiserUser(name));
      case 'list':
        return res.json({ success: true, users: await listAdvertiserUsers() });
      default:
        return res.json({ error: '알 수 없는 action: ' + action });
    }
  } catch (err) {
    res.json({ error: err.message });
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
// 내 닉네임 (1:1문의에서 리뷰어에게 보일 이름) — migration 078
//   · 본인 것만 조회/저장(로그인 계정 기준). 마스터·인트라넷 SSO 계정도 같은 경로를 쓴다.
//   · 미설정이면 리뷰어 화면엔 '관리자'로 나간다(실명 노출 없음) — 설정은 "누가 답했는지
//     리뷰어가 구분하게" 하려는 용도이지, 실명 차단의 전제조건이 아니다.
//   · /api/admin/* 경로라 via:'intranet'·'reviewer_campaign' 스코프 토큰은 도달 불가.
// ═══════════════════════════════════════════════════════════
router.get('/my-nickname', authMiddleware, async (req, res, next) => {
  try {
    const loginName = req.admin?.name || '';
    const nickname = await adminNickname.getNickname(loginName);
    res.json({ ok: true, loginName, nickname });
  } catch (err) {
    next(err);
  }
});

router.post('/my-nickname', authMiddleware, async (req, res, next) => {
  try {
    const loginName = req.admin?.name || '';
    if (!loginName) return res.status(400).json({ ok: false, error: '로그인 계정을 확인할 수 없습니다.' });
    const raw = String((req.body || {}).nickname || '').trim();
    // 실명을 그대로 닉네임으로 쓰면 기능의 목적(실명 비노출)이 사라진다 → 막고 안내
    if (raw && raw === loginName) {
      return res.status(400).json({ ok: false, error: '로그인 계정명과 다른 닉네임을 사용해주세요.' });
    }
    if (raw.length > 20) return res.status(400).json({ ok: false, error: '닉네임은 20자 이내로 입력해주세요.' });
    const nickname = await adminNickname.setNickname(loginName, raw, loginName);
    res.json({ ok: true, loginName, nickname });
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
// 리뷰어 앱 "공고수정 허용 명단" — 마스터 전용 관리
//   리뷰어 화면(무비밀번호 로그인)에서 공고를 수정할 수 있는 사람을 phone8로 명시 허용.
//   /api/admin/* 경로라 via:'reviewer_campaign' 스코프 토큰은 도달 불가(경로 격리) + masterOnly.
// ═══════════════════════════════════════════════════════════
router.get('/campaign-editors', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    res.json({ ok: true, editors: await listEditors() });
  } catch (err) { next(err); }
});

router.post('/campaign-editors', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { action, phone8, label, active } = req.body || {};
    const by = (req.admin && req.admin.name) || '';
    if (action === 'add')    return res.json(await addEditor(phone8, label, by));
    if (action === 'remove') return res.json(await removeEditor(phone8));
    if (action === 'toggle') return res.json(await setEditorActive(phone8, active === true));
    return res.status(400).json({ ok: false, error: '알 수 없는 action: ' + action });
  } catch (err) { next(err); }
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
//   { stats: [{ campaign, total, submitted, tabs:[{ ..., tuip, chuihap, roundList }] }],
//     grand: { total, submitted, pending }, closedTabs, indexBuiltAt }
//
// ★ Phase 15: 투입중/취합중 + 차수별 집계 추가
//   - 작업 컬럼 그룹(WORK_COL_GROUPS): row_json 키를 그룹 매칭하여 filledCount 계산
//   - filledCount < 4 → 투입중(tuip), >= 4 → 취합중(chuihap)
//   - is_submitted=true인 행은 투입/취합에서 제외 (이미 완료)
//   - round별 그룹핑 → roundList 배열 생성
// ═══════════════════════════════════════════════════════════

// ── 작업 컬럼 그룹 정의 ──
// 각 그룹의 키워드 중 하나라도 row_json 키에 매칭되면 해당 그룹은 "채워짐"으로 판정
// 유사 컬럼명을 하나의 그룹으로 묶어 1개로 카운트
// 구매일자, 입금, 담당자, 리뷰제출, 비고, 차수 등은 제외
const WORK_COL_GROUPS = [
  { name: 'recipient',  keywords: ['수취인', '주문자'] },
  { name: 'phone',      keywords: ['연락처', '전화번호', '핸드폰', '휴대폰'] },
  { name: 'address',    keywords: ['주소'] },
  { name: 'bank',       keywords: ['은행'] },
  { name: 'account',    keywords: ['계좌번호', '계좌'] },
  { name: 'holder',     keywords: ['예금주'] },
  { name: 'amount',     keywords: ['결제금액', '결제', '금액'] },
  { name: 'orderNum',   keywords: ['주문번호'] },
  { name: 'orderer',    keywords: ['주문자제출'] },
  { name: 'userId',     keywords: ['쿠팡id', '네이버아이디', 'id', '네이버&쿠팡id'] },
];
const WORK_COL_THRESHOLD = 4; // filledCount >= 4 → 취합중

/**
 * row_json 객체에서 작업 컬럼 그룹 중 값이 채워진 그룹 수를 계산
 * @param {object} rowJson - review_index.row_json
 * @returns {number} filledCount (0 ~ WORK_COL_GROUPS.length)
 */
function _countFilledWorkGroups(rowJson) {
  if (!rowJson || typeof rowJson !== 'object') return 0;
  let filled = 0;
  for (const group of WORK_COL_GROUPS) {
    const isFilled = group.keywords.some(kw => {
      // row_json 키에서 kw를 포함하는 키를 찾고, 그 값이 비어있지 않은지 확인
      for (const key of Object.keys(rowJson)) {
        if (key.toLowerCase().includes(kw.toLowerCase())) {
          const val = String(rowJson[key] || '').trim();
          if (val.length > 0) return true;
        }
      }
      return false;
    });
    if (isFilled) filled++;
  }
  return filled;
}

// ── 입금 컬럼 키워드 (row_json에서 입금 값 존재 여부 판별) ──
const PAYMENT_COL_KEYWORDS = ['입금', '페이백', '입금완료', '입금확인', '입금여부'];

/**
 * row_json에서 입금 관련 컬럼에 값이 있는지 확인
 * @param {object} rowJson - review_index.row_json
 * @returns {boolean} 입금 값 존재 여부
 */
function _hasPaymentValue(rowJson) {
  if (!rowJson || typeof rowJson !== 'object') return false;
  for (const key of Object.keys(rowJson)) {
    const lk = key.toLowerCase();
    if (PAYMENT_COL_KEYWORDS.some(kw => lk.includes(kw.toLowerCase()))) {
      const val = String(rowJson[key] || '').trim();
      if (val.length > 0) return true;
    }
  }
  return false;
}

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
        tc.provider_memo  AS "providerMemo",
        tc.taekhap,
        tc.sheet_url      AS "sheetUrl",
        tc.campaign_name  AS "tcCampaignName",
        tc.closed_rounds  AS "closedRounds",
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

    // ★ Phase 15: 투입/취합 + 차수별 집계를 위해 review_index 행 데이터 로드
    // 활성 탭의 미제출 행만 가져옴 (is_submitted=true는 투입/취합 대상 아님)
    const activeSheetTabs = tabs.map(t => `${t.sheetId}||${t.tabName}`);
    let workStatusMap = {}; // "sheetId||tabName" → { tuip, chuihap }
    let roundDataMap = {};  // "sheetId||tabName" → { rounds: { "1차": { total, submitted, pending, tuip, chuihap, startDate }, ... } }

    // ★ 차수 단위 아카이브 방어: 대시보드 차수별 집계에서 아카이브된 차수 제외
    const archivedRoundsMap = {}; // "sheetId||tabName" → Set<round>
    const { rows: arRoundsRows } = await pool.query(
      "SELECT sheet_id, tab_name, archived_rounds FROM tab_configs WHERE archived_rounds IS NOT NULL AND archived_rounds != ''"
    );
    for (const r of arRoundsRows) {
      const rounds = r.archived_rounds.split(',').map(s => s.trim()).filter(Boolean);
      if (rounds.length > 0) {
        archivedRoundsMap[`${r.sheet_id}||${r.tab_name}`] = new Set(rounds);
      }
    }

    if (activeSheetTabs.length > 0) {
      // 미제출 행의 row_json + round를 가져와서 JS에서 집계
      // (활성 탭만 대상, is_submitted=false만 투입/취합 계산)
      const { rows: reviewRows } = await pool.query(`
        SELECT ri.sheet_id AS "sheetId", ri.tab_name AS "tabName",
               ri.is_submitted AS "isSubmitted", ri.round,
               ri.row_json AS "rowJson", ri.start_date AS "startDate",
               ri.is_submitted2 AS "isSubmitted2"
        FROM review_index ri
        INNER JOIN index_master im ON ri.sheet_id = im.sheet_id AND ri.tab_name = im.tab_name
        WHERE im.status = 'active'
      `);

      // 탭별 + 차수별 집계
      for (const row of reviewRows) {
        const tabKey = `${row.sheetId}||${row.tabName}`;
        const roundVal = (row.round || '').trim();

        // ★ 아카이브된 차수의 행은 집계에서 제외 (방어적 필터)
        if (roundVal && archivedRoundsMap[tabKey]?.has(roundVal)) continue;

        // ── 탭 레벨 투입/취합 ──
        if (!workStatusMap[tabKey]) {
          workStatusMap[tabKey] = { tuip: 0, chuihap: 0 };
        }
        if (!row.isSubmitted) {
          const filledCount = _countFilledWorkGroups(row.rowJson);
          if (filledCount >= WORK_COL_THRESHOLD) {
            workStatusMap[tabKey].chuihap++;
          } else {
            workStatusMap[tabKey].tuip++;
          }
        }

        // ── 차수별 집계 ──
        if (roundVal) {
          if (!roundDataMap[tabKey]) roundDataMap[tabKey] = {};
          if (!roundDataMap[tabKey][roundVal]) {
            roundDataMap[tabKey][roundVal] = {
              total: 0, submitted: 0, pending: 0,
              tuip: 0, chuihap: 0, paid: 0, startDate: null,
            };
          }
          const rd = roundDataMap[tabKey][roundVal];
          rd.total++;
          if (row.isSubmitted) {
            rd.submitted++;
          } else {
            rd.pending++;
            const filledCount = _countFilledWorkGroups(row.rowJson);
            if (filledCount >= WORK_COL_THRESHOLD) {
              rd.chuihap++;
            } else {
              rd.tuip++;
            }
          }
          // ★ 입금 완료 집계: is_submitted2='PAID' 또는 row_json에서 입금 키워드 컬럼 값 존재
          if (row.isSubmitted2 === 'PAID' || _hasPaymentValue(row.rowJson)) {
            rd.paid++;
          }
          // 차수별 최소 시작일
          if (row.startDate) {
            if (!rd.startDate || row.startDate < rd.startDate) {
              rd.startDate = row.startDate;
            }
          }
        }
      }
    }

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

      // ★ Phase 15: 투입/취합 + 차수별 roundList 추가
      const tabKey = `${t.sheetId}||${t.tabName}`;
      const ws = workStatusMap[tabKey] || { tuip: 0, chuihap: 0 };
      const tcRound = t.round || '';

      // roundList 구성: 차수 데이터가 있는 탭만
      let roundList = [];
      const rdMap = roundDataMap[tabKey];
      if (rdMap && Object.keys(rdMap).length > 0) {
        roundList = Object.entries(rdMap)
          .map(([roundVal, rd]) => ({
            round:     roundVal,
            total:     rd.total,
            submitted: rd.submitted,
            pending:   rd.pending,
            tuip:      rd.tuip,
            chuihap:   rd.chuihap,
            paid:      rd.paid,
            startDate: rd.startDate || '',
          }))
          .sort((a, b) => {
            // 숫자 추출하여 정렬 (예: "1차" → 1, "2차" → 2)
            const numA = parseInt(a.round.replace(/[^0-9]/g, '')) || 0;
            const numB = parseInt(b.round.replace(/[^0-9]/g, '')) || 0;
            return numA - numB;
          });
      }

      camp.tabs.push({
        sheetId:     t.sheetId,
        tab:         t.tabName,
        tabGid:      t.tabGid || '',
        total,
        submitted,
        pending,
        tuip:        ws.tuip,
        chuihap:     ws.chuihap,
        tcRound,
        roundList,
        isClosed:    !!t.isClosed,
        closedRounds: t.closedRounds || '',
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
        providerMemo: t.providerMemo || '',
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
  pauseSmartBuild,
  resumeSmartBuild,
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

    // force=true 파라미터가 있으면 체크섬 캐시 초기화 후 실행 (강제 전체 갱신)
    const force = req.body?.force === true || req.query?.force === 'true';
    if (force) {
      const cacheResult = resetSmartBuildCache();
      const { logger: log } = require('../utils/logger');
      log.info(`[smartBuild] 강제 실행 — 캐시 리셋: ${JSON.stringify(cacheResult)}`);
    }

    // 백그라운드 실행 — 강제(force) 실행은 시트 lane 양보 없이 완주(부분완료 보고 방지)
    runSmartBuild({ noYield: force }).then(result => {
      const { broadcast } = require('../utils/sse');
      const deferredNote = (result.sheetsDeferred || 0) > 0 ? `, ${result.sheetsDeferred}시트 연기(다음 주기 처리)` : '';
      broadcast('smart_build_done', {
        message: `스마트빌드 완료: ${result.tabsUpdated}탭 갱신, ${result.tabsSkipped}탭 스킵, ${result.errors}건 오류${deferredNote}`,
        ...result,
      });
    }).catch(err => {
      const { logger } = require('../utils/logger');
      logger.error(`[smartBuild] 수동 실행 오류: ${err.message}`);
    });

    res.json({ ok: true, message: '스마트 빌드를 시작했습니다. 완료 시 SSE로 알림됩니다.' });
  } catch (err) { next(err); }
});

// POST /api/admin/smart-build/start — 스케줄러 시작 (5분 주기). async라 await(심판 수정2).
router.post('/smart-build/start', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const started = await startSmartBuild();
    res.json({ ok: true, started, status: getSmartBuildStatus() });
  } catch (err) { next(err); }
});

// POST /api/admin/smart-build/pause { minutes? } — 관리자 일시정지(영속·자동재개). 라이브 이벤트 중 쿼터 회복용.
//   stop과 달리 interval은 유지하고 pausedUntil까지 tick만 스킵 → 만료 시 자동 재개(끈 채 방치 방지).
router.post('/smart-build/pause', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const minutes = parseInt((req.body && req.body.minutes), 10);
    const out = await pauseSmartBuild(Number.isFinite(minutes) ? minutes : undefined);
    res.json({ ok: true, ...out, status: getSmartBuildStatus() });
  } catch (err) { next(err); }
});

// POST /api/admin/smart-build/resume — 관리자 수동 재개(pause 해제)
router.post('/smart-build/resume', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const out = await resumeSmartBuild();
    res.json({ ok: true, ...out, status: getSmartBuildStatus() });
  } catch (err) { next(err); }
});

// POST /api/admin/smart-build/stop — 스케줄러 정지(프로세스성 clearInterval; 재부팅 시 복원됨).
//   ⚠️ 오래 끄려면 pause를 쓸 것(stop은 재배포/재부팅에 리셋됨).
router.post('/smart-build/stop', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const stopped = stopSmartBuild();
    res.json({ ok: true, stopped, note: '재부팅 시 재기동됨. 오래 정지하려면 /smart-build/pause 사용', status: getSmartBuildStatus() });
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
    // ★ allowNewTabs:true — DB 재구축은 "현 상태 복원"(재해복구)이므로 등록 단일경로 게이트 예외
    broadcast('db_rebuild_progress', { step: '3b', message: '스캔 결과를 DB에 등록 중...' });
    const syncResult = await syncTabListToDB({ dryRun: false, fromCache: true, allowNewTabs: true });
    steps.push({ step: '3b', action: 'SYNC_TAB_LIST', ...syncResult });
    logger.info(`[db-rebuild] Step3b DB 동기화: ${syncResult.message}`);

    // ── Step 4: 스마트빌드 1회 실행 (백그라운드) ──
    broadcast('db_rebuild_progress', { step: 4, message: '스마트빌드 실행 시작... (백그라운드)' });

    // 백그라운드로 스마트빌드 실행 — DB 재구축은 양보 없이 완주("완료" 보고가 부분완료가 되지 않게)
    runSmartBuild({ noYield: true }).then(result => {
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

// ═══════════════════════════════════════════════════════════
// POST /api/admin/campaign-delete/:sheetId — 오류 시트(캠페인) DB 일괄 삭제
//   시스템 모니터링에서 접근 불가 시트를 관리자가 직접 정리할 때 사용
//   campaigns, tab_configs, index_master, review_index 4개 테이블에서 삭제
// ═══════════════════════════════════════════════════════════
router.post('/campaign-delete/:sheetId', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  const { logger } = require('../utils/logger');
  try {
    const { sheetId } = req.params;
    logger.info(`[campaign-delete] 요청: ${sheetId}`);
    if (!sheetId || sheetId.length < 10) {
      return res.status(400).json({ ok: false, error: 'sheetId가 유효하지 않습니다.' });
    }

    const r1 = await pool.query('DELETE FROM review_index WHERE sheet_id = $1', [sheetId]);
    const r2 = await pool.query('DELETE FROM index_master WHERE sheet_id = $1', [sheetId]);
    const r3 = await pool.query('DELETE FROM tab_configs WHERE sheet_id = $1', [sheetId]);
    const r4 = await pool.query('DELETE FROM campaigns WHERE sheet_id = $1', [sheetId]);

    const deleted = {
      review_index: r1.rowCount,
      index_master: r2.rowCount,
      tab_configs: r3.rowCount,
      campaigns: r4.rowCount,
    };
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);

    logger.info(`[campaign-delete] 시트 ${sheetId.substring(0, 15)}... 삭제 완료: ${JSON.stringify(deleted)}`);

    res.json({
      ok: true,
      sheetId,
      deleted,
      totalDeleted: total,
      message: `시트 데이터 ${total}건 삭제 완료`,
    });
  } catch (err) {
    logger.error(`[campaign-delete] 오류: ${err.message}`);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 관리자 공지사항 CRUD
// ═══════════════════════════════════════════════════════════

// GET /api/admin/notices — 활성 공지 목록 (관리자용, 만료되지 않은 것만)
router.get('/notices', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, content, display_days, target_names, created_by, created_at, expires_at, is_active
      FROM admin_notices
      WHERE is_active = true AND expires_at > NOW()
      ORDER BY created_at DESC
    `);
    res.json({ success: true, notices: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: '[notices/list] ' + err.message });
  }
});

// GET /api/admin/notices/all — 전체 공지 목록 (마스터 관리용, 만료 포함)
router.get('/notices/all', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, content, display_days, target_names, created_by, created_at, expires_at, is_active
      FROM admin_notices
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json({ success: true, notices: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: '[notices/all] ' + err.message });
  }
});

// POST /api/admin/notices — 공지 작성 (마스터 전용)
router.post('/notices', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { title, content, display_days = 7, target_names = [] } = req.body;
    if (!title || !content) return res.status(400).json({ success: false, error: '제목과 내용을 입력하세요.' });
    const days = Math.max(1, Math.min(365, Number(display_days) || 7));
    const targets = Array.isArray(target_names) ? target_names : [];
    // ★ $3을 INTEGER(컬럼)와 ::text(interval 조립)로 동시에 쓰면 pg가 파라미터 타입을
    //   추론 못해 "inconsistent types deduced for parameter $3"로 항상 실패한다 → make_interval로 통일.
    const { rows } = await pool.query(`
      INSERT INTO admin_notices (title, content, display_days, target_names, created_by, expires_at)
      VALUES ($1, $2, $3::int, $4::text[], $5, NOW() + make_interval(days => $3::int))
      RETURNING *
    `, [title, content, days, targets, req.admin.name]);
    res.json({ success: true, notice: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: '[notices/create] ' + err.message });
  }
});

// PUT /api/admin/notices/:id — 공지 수정 (마스터 전용)
router.put('/notices/:id', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, content, display_days, target_names } = req.body;
    if (!title || !content) return res.status(400).json({ success: false, error: '제목과 내용을 입력하세요.' });
    const days = Math.max(1, Math.min(365, Number(display_days) || 7));
    const targets = Array.isArray(target_names) ? target_names : [];
    // ★ INSERT와 동일한 $3 타입 추론 충돌 방지(make_interval)
    const { rows } = await pool.query(`
      UPDATE admin_notices
      SET title = $1, content = $2, display_days = $3::int, target_names = $4::text[],
          expires_at = created_at + make_interval(days => $3::int)
      WHERE id = $5
      RETURNING *
    `, [title, content, days, targets, id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: '공지를 찾을 수 없습니다.' });
    res.json({ success: true, notice: rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/admin/notices/:id — 공지 삭제 (마스터 전용)
router.delete('/notices/:id', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM admin_notices WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/notices/unread — 현재 로그인한 관리자의 미읽은 공지
router.get('/notices/unread', authMiddleware, async (req, res, next) => {
  try {
    const adminName = req.admin.name;
    const { rows } = await pool.query(`
      SELECT n.id, n.title, n.content, n.display_days, n.created_by, n.created_at, n.expires_at
      FROM admin_notices n
      WHERE n.is_active = true
        AND n.expires_at > NOW()
        AND (n.target_names = '{}' OR $1 = ANY(n.target_names))
        AND NOT EXISTS (
          SELECT 1 FROM admin_notice_reads r
          WHERE r.notice_id = n.id AND r.admin_name = $1
        )
      ORDER BY n.created_at DESC
    `, [adminName]);
    res.json({ success: true, notices: rows });
  } catch (err) { next(err); }
});

// POST /api/admin/notices/read — 공지 읽음 처리
router.post('/notices/read', authMiddleware, async (req, res, next) => {
  try {
    const { notice_id } = req.body;
    const adminName = req.admin.name;
    if (!notice_id) return res.status(400).json({ success: false, error: 'notice_id 필요' });
    await pool.query(`
      INSERT INTO admin_notice_reads (notice_id, admin_name)
      VALUES ($1, $2)
      ON CONFLICT (notice_id, admin_name) DO NOTHING
    `, [notice_id, adminName]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// 오류디버깅(Error Debugging) — error_logs (마이그레이션 026/028)
// 프로토콜: 수집 → 오류검증 → 다중에이전트 분석 → 결정자 → 이행요청 → 수정 → 재검증
// staff 차단(adminOrMasterMiddleware): 시스템 운영 정보
// ═══════════════════════════════════════════════════════════
const errorDebug = require('../services/errorDebug.service');
const { adminUiWhereSql, wantsExclusion } = require('../utils/adminUiErrorFilter');

// status 동기화 헬퍼: status 와 backward-compat 한 resolved 불리언을 함께 갱신
const VALID_STATUSES = ['new', 'investigating', 'resolved', 'ignored'];

// GET /api/admin/error-logs — 오류 목록 (필터·페이징·요약)
// 쿼리: category, severity, flow, status(new/investigating/resolved/ignored/open/all)
//       resolved(true/false/all) — 구버전 호환, page, limit
router.get('/error-logs', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { category, severity, flow, source } = req.query;
    const statusParam = (req.query.status || '').toLowerCase();
    const resolvedParam = (req.query.resolved || '').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    // 상태 필터: status 우선, 없으면 구버전 resolved 파라미터 해석(기본=미해결)
    if (VALID_STATUSES.includes(statusParam)) {
      params.push(statusParam); where.push(`status = $${params.length}`);
    } else if (statusParam === 'open') {
      where.push(`status IN ('new','investigating')`);
    } else if (statusParam === 'all' || resolvedParam === 'all') {
      // 전체 — 필터 없음
    } else if (resolvedParam === 'true') {
      where.push(`status = 'resolved'`);
    } else {
      where.push(`status IN ('new','investigating')`); // 기본: 미해결(신규+확인중)
    }
    if (category) { params.push(category); where.push(`category = $${params.length}`); }
    if (severity) { params.push(severity); where.push(`severity = $${params.length}`); }
    if (flow)     { params.push(flow);     where.push(`flow = $${params.length}`); }
    if (source)   { params.push(source);   where.push(`source = $${params.length}`); }
    // ── 관리자 대시보드에서 발생한 오류 제외(통합 작업대 전용 · opt-in) ──
    //   규칙 단일 출처 = utils/adminUiErrorFilter. 기본은 미적용이라 다른 소비처 동작 불변.
    //   ★ 제외 건수를 함께 세어 화면이 "N건 제외"를 표기한다(조용한 누락 금지).
    const excludeAdminUi = wantsExclusion(req.query.excludeAdminUi);
    const statusWhere = where.slice();            // 제외 건수도 같은 상태 필터 기준으로 센다
    const statusParams = params.slice();
    if (excludeAdminUi) where.push(adminUiWhereSql(params));
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const listParams = params.slice();
    listParams.push(limit); const limIdx = listParams.length;
    listParams.push(offset); const offIdx = listParams.length;

    const { rows: logs } = await pool.query(
      `SELECT id, created_at, severity, flow, flow_ko, step, step_ko, category, source,
              message_ko, message_raw, error_code, occurrence_count,
              first_seen_at, last_seen_at, status, verify_verdict, decider_verdict,
              analyzed_at, (analysis ? 'summary_ko') AS has_analysis,
              resolved, resolved_at, resolved_by, context
       FROM error_logs
       ${whereSql}
       ORDER BY last_seen_at DESC, occurrence_count DESC
       LIMIT $${limIdx} OFFSET $${offIdx}`,
      listParams
    );

    const { rows: cntRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM error_logs ${whereSql}`, params);
    const total = cntRows[0]?.total || 0;

    // 요약: 상태별 분포 + 미해결(신규+확인중) 카테고리/심각도 분포
    // ★ 제외를 적용했으면 요약도 같은 기준으로 센다 — 목록엔 없는 건이 헤더 뱃지에만 잡히면
    //   "미해결 12인데 표는 2줄"이 되어 화면이 거짓말을 한다.
    const sumParams = [];
    const sumCond = excludeAdminUi ? ' WHERE ' + adminUiWhereSql(sumParams) : '';
    const { rows: stRows } = await pool.query(
      `SELECT status, COUNT(*)::int AS cnt FROM error_logs${sumCond} GROUP BY status`, sumParams);
    const byStatus = { new: 0, investigating: 0, resolved: 0, ignored: 0 };
    for (const r of stRows) byStatus[r.status] = r.cnt;

    const sevParams = [];
    const sevCond = excludeAdminUi ? ' AND ' + adminUiWhereSql(sevParams) : '';
    const { rows: sumRows } = await pool.query(
      `SELECT category, severity, COUNT(*)::int AS cnt, SUM(occurrence_count)::int AS occ
       FROM error_logs WHERE status IN ('new','investigating')${sevCond} GROUP BY category, severity`, sevParams);
    const summary = { openCount: byStatus.new + byStatus.investigating, byStatus, byCategory: {}, bySeverity: {} };
    for (const r of sumRows) {
      summary.byCategory[r.category] = (summary.byCategory[r.category] || 0) + r.cnt;
      summary.bySeverity[r.severity] = (summary.bySeverity[r.severity] || 0) + r.cnt;
    }

    // 제외 적용 시에만 "몇 건을 가렸는지" 센다(미적용이면 쿼리 순증 0)
    let excludedCount = 0;
    if (excludeAdminUi) {
      statusWhere.push(adminUiWhereSql(statusParams, true));
      const { rows: exRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM error_logs WHERE ${statusWhere.join(' AND ')}`, statusParams);
      excludedCount = exRows[0]?.n || 0;
    }

    res.json({ ok: true, logs, total, page, limit, summary, excludeAdminUi, excludedCount });
  } catch (err) { next(err); }
});

// GET /api/admin/error-logs/detail?id= — 오류 상세 (분석 결과 포함, 비파괴)
router.get('/error-logs/detail', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return res.json({ error: 'id 필요' });
    const { rows } = await pool.query(`SELECT * FROM error_logs WHERE id = $1`, [id]);
    if (!rows.length) return res.json({ error: '대상을 찾을 수 없습니다.' });
    const log = rows[0];
    const analysis = log.analysis && Object.keys(log.analysis).length ? log.analysis : null;
    // 이행요청 게이트(문서 10장) 재계산 — 항상 최신 규칙 반영
    let transfer_blockers = ['아직 오류검증 및 분석을 실행하지 않음'];
    if (analysis) transfer_blockers = errorDebug.transferGate(analysis, log.verify_verdict, log.decider_verdict);
    res.json({ ok: true, log, analysis, transfer_blockers, transfer_allowed: transfer_blockers.length === 0 });
  } catch (err) { next(err); }
});

// POST /api/admin/error-logs/analyze — 오류검증 및 분석 (비파괴: 실제 수정/재현 안 함)
// body: { id }
router.post('/error-logs/analyze', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.body.id, 10);
    if (!id) return res.json({ error: 'id 필요' });
    const { rows } = await pool.query(`SELECT * FROM error_logs WHERE id = $1`, [id]);
    if (!rows.length) return res.json({ error: '대상을 찾을 수 없습니다.' });

    const result = await errorDebug.runAnalysis(rows[0]);

    await pool.query(
      `UPDATE error_logs
       SET analysis = $1::jsonb, verify_verdict = $2, decider_verdict = $3,
           analyzed_at = NOW(), analyzed_by = $4
       WHERE id = $5`,
      [JSON.stringify(result.analysis), result.verify_verdict, result.decider_verdict,
       req.admin?.name || 'admin', id]
    );

    res.json({
      ok: true,
      analysis: result.analysis,
      verify_verdict: result.verify_verdict,
      decider_verdict: result.decider_verdict,
      transfer_blockers: result.transfer_blockers,
      transfer_allowed: result.transfer_blockers.length === 0,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/error-logs/status — 상태 변경 ({ id, status, note })
// status: new | investigating | resolved | ignored
router.post('/error-logs/status', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.body.id, 10);
    const status = String(req.body.status || '').toLowerCase();
    const note = String(req.body.note || '').slice(0, 500);
    if (!id) return res.json({ error: 'id 필요' });
    if (!VALID_STATUSES.includes(status)) return res.json({ error: '유효하지 않은 상태값' });

    const who = req.admin?.name || 'admin';
    // resolved 불리언/시각은 backward-compat(크론 보존정리·구버전 조회)용으로 동기화
    const resolved = status === 'resolved';
    const { rows } = await pool.query(
      `UPDATE error_logs SET
         status = $1,
         status_updated_at = NOW(), status_updated_by = $2,
         resolved   = $3,
         resolved_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
         resolved_by = CASE WHEN $3 THEN $2 ELSE '' END,
         resolve_note = CASE WHEN $4 <> '' THEN $4 ELSE resolve_note END
       WHERE id = $5
       RETURNING id, status`,
      [status, who, resolved, note, id]
    );
    if (!rows.length) return res.json({ error: '대상을 찾을 수 없습니다.' });
    res.json({ ok: true, status: rows[0].status });
  } catch (err) { next(err); }
});

// POST /api/admin/error-logs/resolve — (구버전 호환) 해결 처리 ({ id, note }) → status='resolved'
router.post('/error-logs/resolve', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id, note } = req.body;
    if (!id) return res.json({ error: 'id 필요' });
    const { rowCount } = await pool.query(
      `UPDATE error_logs
       SET status = 'resolved', status_updated_at = NOW(), status_updated_by = $1,
           resolved = TRUE, resolved_at = NOW(), resolved_by = $1, resolve_note = $2
       WHERE id = $3 AND status <> 'resolved'`,
      [req.admin?.name || 'admin', (note || '').slice(0, 500), id]
    );
    if (rowCount === 0) return res.json({ error: '대상을 찾을 수 없거나 이미 해결된 항목입니다.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
