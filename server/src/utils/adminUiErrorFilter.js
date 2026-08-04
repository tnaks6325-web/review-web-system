/**
 * 관리자 대시보드에서 발생한 오류 제외 규칙 — 단일 출처
 * ══════════════════════════════════════════════════════════════
 * 배경(2026-08 사용자 확정): **통합 작업대가 메인**이고 관리자 대시보드는 폐기 대상이다.
 * 없어질 화면에서 난 오류가 작업대 「시스템 오류로그」를 채우면 정작 손봐야 할 게 묻히므로
 * 목록에서 제외한다.
 *
 * ★ 판정 기준 = 요청 경로. 서버는 이미 `/api/admin/*` 에서 난 오류를 `flow='admin'` 으로
 *   기록한다(error.middleware.js 의 PATH_FLOW_MAP). 그 표면은 **관리자 대시보드만 쓰므로**
 *   그 한 줄이 곧 "대시보드에서 난 오류"다 — 인트라넷 SSO 토큰(`via:'intranet'`)은
 *   authMiddleware 가 `/api/trackb/*` 로 격리해 `/api/admin/*` 에 도달 자체가 불가능하다.
 *
 * ★★ 단, **로그인 4경로는 예외로 남긴다(완화 금지)** — 이름만 admin 이지
 *   통합 작업대가 직접 호출하는 로그인 경로다(workdesk.html 의 로그인 폴백 4단). 통째로
 *   걸러내면 **작업대 로그인·인트라넷 SSO 장애가 어느 화면에도 안 뜨는 무신호 상태**가 된다.
 *   (막으려던 것보다 큰 손실 — 캡처 검수 fail-open·옵션 감사 경고전용과 같은 판단.)
 *
 * ★ 공용 인프라 오류(시트·Drive·AI·DB·큐·리뷰어 제출 등)는 flow 가 admin 이 아니므로
 *   그대로 남는다 — 관리자 대시보드에서 눌러 났든 작업대에서 눌러 났든 같은 기능의 같은
 *   고장이라 가려내면 손해다.
 *
 * ★ 제외는 조용히 하지 않는다 — 소비처가 `excludedCount` 를 함께 반환해 화면이
 *   "관리자 대시보드 경로 N건 제외"를 표기하고 포함해 볼 수 있게 한다(조용한 누락 금지).
 */

/** error.middleware.js 의 PATH_FLOW_MAP 이 `/api/admin/*` 에 부여하는 flow 값 */
const ADMIN_UI_FLOW = 'admin';

/**
 * `/api/admin/*` 이지만 **통합 작업대가 쓰는** 경로 — 제외 대상에서 뺀다.
 * (workdesk.html 로그인 폴백: 자체 계정 → AE → 광고주 → 인트라넷 SSO 순)
 */
const WORKDESK_ADMIN_PATHS = [
  '/api/admin/login',
  '/api/admin/staff-login',
  '/api/admin/advertiser-login',
  '/api/admin/intranet-login',
];

/**
 * 그 오류 1건이 "관리자 대시보드에서 난 것"인지 판정(순수함수 — 테스트·화면 공용).
 * @param {{flow?:string, context?:object}} row error_logs 행(또는 그 일부)
 * @returns {boolean} true = 제외 대상
 */
function isAdminUiError(row) {
  if (!row || row.flow !== ADMIN_UI_FLOW) return false;
  const ctx = (row.context && typeof row.context === 'object') ? row.context : {};
  const path = String(ctx.path || '');
  return !WORKDESK_ADMIN_PATHS.includes(path);
}

/**
 * WHERE 절 조각 생성 — 위 판정과 **같은 규칙**을 SQL 로 표현한다(사본 아님: 목록은 페이징·
 * 카운트가 있어 JS 필터로는 total 이 어긋난다).
 *
 * @param {any[]} params 바인딩 배열(호출부가 이어서 쓰는 그 배열 — 뒤에 push 한다)
 * @param {boolean} [negate] true 면 "제외 대상인 행만"(= 제외 건수 세기용)
 * @returns {string} SQL 조건식
 */
function adminUiWhereSql(params, negate) {
  params.push(ADMIN_UI_FLOW);
  const flowIdx = params.length;
  params.push(WORKDESK_ADMIN_PATHS);
  const pathIdx = params.length;
  // "관리자 대시보드에서 난 오류" = flow=admin AND 경로가 작업대 경로 목록에 없음
  const isAdminUi = `(flow = $${flowIdx} AND COALESCE(context->>'path','') <> ALL($${pathIdx}::text[]))`;
  return negate ? isAdminUi : `NOT ${isAdminUi}`;
}

/** 쿼리스트링 값 → 제외 적용 여부(기본 미적용 = 기존 소비처 동작 불변) */
function wantsExclusion(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

module.exports = {
  ADMIN_UI_FLOW,
  WORKDESK_ADMIN_PATHS,
  isAdminUiError,
  adminUiWhereSql,
  wantsExclusion,
};
