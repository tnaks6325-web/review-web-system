const express = require('express');
const router = express.Router();
// Track B(trackB.routes.js)가 경로 문자열 대신 이름으로 부르는 핸들러 모음 — 맨 아래 router.handlers 로 내보낸다(결정 270).
const { lastRouteHandler } = require('../utils/routeHandlers');
const _handlers = {};
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const {
  loginAdmin, loginStaff, loginAdvertiser, loginIntranet,
} = require('../services/auth.service');
const adminNickname = require('../services/adminNickname.service');
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

// The test frontend can intentionally enter without typing credentials.
// This stays unavailable everywhere unless the test deployment explicitly
// opts in, and browsers must originate from that one frontend hostname.
const TEST_AUTO_LOGIN_ORIGIN = 'https://test-review-wdb-web-production.up.railway.app';
const TEST_PR_FRONTEND_ORIGIN = /^https:\/\/test-review-wdb-web-review-web-system-pr-\d+\.up\.railway\.app$/;
router.post('/test-auto-login', async (req, res, next) => {
  const origin = req.get('origin');
  if (process.env.TEST_AUTO_LOGIN !== '1' || (origin !== TEST_AUTO_LOGIN_ORIGIN && !TEST_PR_FRONTEND_ORIGIN.test(origin || ''))) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  try {
    const result = await loginAdmin(process.env.MASTER_ADMIN_NAME, process.env.MASTER_ADMIN_PW);
    if (!result || !result.success || !result.token) {
      return res.status(503).json({ success: false, error: 'Test automatic login is unavailable.' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json(result);
  } catch (err) {
    return next(err);
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
//   Track B 리뷰웹시스템[3버전] SSO: 인트라넷 서버에 자격 프록시 검증 후 review JWT(role='staff') 발급.
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

// POST /api/admin/advertiser-users(광고주 계정 CRUD 옛 입구 — 3버전은 /api/trackb/advertiser-account, 로직은 auth.service 공용) 은 2026-10-04 제거 — 결정 186 95번(화면 호출 0 · 9/2 이후 호출 0).

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
_handlers.myNicknameGet = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 270)

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
_handlers.myNicknameSet = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 270)

// (옛 관리자 대시보드 전용 입구 — 계정 관리 change-pw·change-master-pw·users·staff-users, 대시보드 dashboard,
//  키워드 keywords·unrecognized, 작업보드 열 너비 my-workboard-preferences(migration 151 표는 그대로), 공지 목록 GET /notices —
//  는 2026-10-22 제거 — 결정 270. 직원 공지·시스템 오류로그는 핸들러만 남겨 /api/trackb/* 가 이름으로 부른다.)

// (리뷰어 앱 "공고수정 허용 명단" GET/POST /api/admin/campaign-editors 는 2026-10-19 폐지 — 결정 257.
//  리뷰어 앱 공고수정은 인트라넷 관리자 로그인으로 연다: POST /api/reviewer/campaign-token-intranet.)

// (시트 시절 색인 수동 조작 — POST /release-lock · /smart-build/status·run·start·pause·resume·stop ·
//  POST /campaign-delete/:sheetId 는 2026-10-22 제거 — 결정 273 · 결정 186 88번. 스마트빌드 스케줄러(smartBuild.service)도 함께 삭제.)

// ═══════════════════════════════════════════════════════════
// 관리자 공지사항 CRUD
// ═══════════════════════════════════════════════════════════

// GET /api/admin/notices/all — 전체 공지 목록 (마스터 관리용, 만료 포함)
// (GET /api/admin/notices/all 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.noticesAll = async (req, res, next) => {
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
};

// POST /api/admin/notices — 공지 작성 (마스터 전용)
// (POST /api/admin/notices 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.noticeCreate = async (req, res, next) => {
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
};

// PUT /api/admin/notices/:id — 공지 수정 (마스터 전용)
// (PUT /api/admin/notices/:id 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.noticeUpdate = async (req, res, next) => {
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
};

// DELETE /api/admin/notices/:id — 공지 삭제 (마스터 전용)
// (DELETE /api/admin/notices/:id 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.noticeDelete = async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM admin_notices WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

// GET /api/admin/notices/unread — 현재 로그인한 관리자의 미읽은 공지
// (GET /api/admin/notices/unread 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.noticesUnread = async (req, res, next) => {
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
};

// POST /api/admin/notices/read — 공지 읽음 처리
// (POST /api/admin/notices/read 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.noticesRead = async (req, res, next) => {
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
};

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
// (GET /api/admin/error-logs 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.errorLogsList = async (req, res, next) => {
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
    // ── 관리자 대시보드에서 발생한 오류 제외(리뷰웹시스템[3버전] 전용 · opt-in) ──
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
};

// GET /api/admin/error-logs/detail?id= — 오류 상세 (분석 결과 포함, 비파괴)
// (GET /api/admin/error-logs/detail 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.errorLogDetail = async (req, res, next) => {
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
};

// POST /api/admin/error-logs/analyze — 오류검증 및 분석 (비파괴: 실제 수정/재현 안 함)
// body: { id }
// (POST /api/admin/error-logs/analyze 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.errorLogAnalyze = async (req, res, next) => {
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
};

// POST /api/admin/error-logs/status — 상태 변경 ({ id, status, note })
// status: new | investigating | resolved | ignored
// (POST /api/admin/error-logs/status 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.errorLogStatus = async (req, res, next) => {
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
};

// POST /api/admin/error-logs/resolve — (구버전 호환) 해결 처리 ({ id, note }) → status='resolved'
// (POST /api/admin/error-logs/resolve 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.errorLogResolve = async (req, res, next) => {
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
};

// ★ 이름을 빼거나 바꾸면 trackB 가 기동 시 바로 실패한다(fail-closed) — 옛 공개 경로를 지워도 Track B 는 그대로다.
router.handlers = Object.freeze(_handlers);

module.exports = router;
