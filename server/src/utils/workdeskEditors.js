/**
 * 통합 작업대 편집 허용명단 — 작업오더·모집공고 탭.
 *
 * 배경: 두 탭은 **AE(staff)에게도 열려 있다**(사용자 확정). 그런데 작업오더 접수는
 *   시트/탭을 `tab_configs`·`campaigns` 에 등록하는 단일 관문이고, 모집공고 발행·수정은
 *   정원·금액을 바꾼다 — 보는 사람 전부에게 열 수는 없다.
 *   → **역할이 아니라 이름 명단**으로 편집 권한을 준다.
 *
 * 명단은 **master/admin 이 통합 작업대에서 직접 관리**하고(migration 079 `workdesk_editors`),
 * 후보는 **인트라넷 직원DB**에서 고른다(`GET /api/trackb/intranet/users` 자동완성).
 *
 * 대조 키 = JWT 의 `name`
 *   · 인트라넷 SSO  → display_name(실명)
 *   · 관리자 로그인 → username
 * 표기 흔들림(공백·전각)을 흡수하려고 공백 제거 후 비교한다.
 *
 * ★ master 는 명단과 무관하게 항상 허용 — 명단을 비우거나 잘못 넣어 **아무도 편집 못 하는
 *   잠금사고**를 막는 안전판.
 * ★ 명단에 없는 admin 은 이 화면에서 읽기 전용이 된다 — 기존 관리자 대시보드에서는
 *   종전대로 작업할 수 있다(권한을 뺏는 게 아니라 이 화면만 좁힌 것).
 * ★ 조회 실패(테이블 부재·DB 오류)는 **읽기 전용으로 수렴**한다(fail-closed).
 *   편집은 되돌리기 어려운 작업이라, 모르면 열지 않는다.
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

const CACHE_MS = 60 * 1000;      // 요청마다 조회하지 않도록 짧게 캐시(명단 변경은 즉시 무효화)
let _cache = null;               // { at, set:Set<정규화 이름> }

const _norm = s => String(s == null ? '' : s).replace(/\s+/g, '').normalize('NFC');

/** 캐시 무효화 — 명단을 바꾼 직후 호출(다음 요청부터 새 명단) */
function invalidate() { _cache = null; }

/** 활성 명단(정규화된 Set). 조회 실패는 null → 호출부가 fail-closed 처리 */
async function _loadSet() {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.set;
  try {
    const { rows } = await pool.query('SELECT name FROM workdesk_editors WHERE active');
    const set = new Set(rows.map(r => _norm(r.name)).filter(Boolean));
    _cache = { at: Date.now(), set };
    return set;
  } catch (e) {
    logger.warn(`[workdeskEditors] 명단 조회 실패(읽기 전용으로 처리): ${e.message}`);
    return null;
  }
}

/** 목록 조회(관리 UI용) — 원본 표기 그대로 */
async function listEditors() {
  const { rows } = await pool.query(
    `SELECT id, name, username, dept, active, added_by AS "addedBy", created_at AS "createdAt"
       FROM workdesk_editors ORDER BY active DESC, name ASC`);
  return rows;
}

async function addEditor({ name, username = '', dept = '', by = '' }) {
  const nm = String(name || '').trim();
  if (!nm) return { ok: false, error: '이름이 필요합니다.' };
  try {
    await pool.query(
      `INSERT INTO workdesk_editors (name, username, dept, added_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (REPLACE(name,' ','')) DO UPDATE
         SET active = TRUE, username = EXCLUDED.username, dept = EXCLUDED.dept`,
      [nm, String(username || ''), String(dept || ''), String(by || '')]);
  } catch (e) { return { ok: false, error: e.message }; }
  invalidate();
  return { ok: true };
}

/** 제거 = 소프트 비활성(누가 언제 넣었는지 이력 보존) */
async function removeEditor(id) {
  const { rowCount } = await pool.query('UPDATE workdesk_editors SET active = FALSE WHERE id = $1', [id]);
  invalidate();
  return rowCount ? { ok: true } : { ok: false, error: '해당 항목을 찾을 수 없습니다.' };
}

/**
 * 편집 가능 여부.
 * @param {{name?:string, role?:string}} admin  req.admin (JWT payload)
 */
async function canEdit(admin) {
  const role = (admin && admin.role) || '';
  if (role === 'master') return true;                 // 안전판 — 명단 오설정 잠금 방지
  if (role === 'advertiser' || !role) return false;   // 광고주는 이 탭 자체가 없음
  const me = _norm(admin && admin.name);
  if (!me) return false;
  const set = await _loadSet();
  if (!set) return false;                             // ★ fail-closed
  return set.has(me);
}

/** 라우트 가드 — 편집 계열 엔드포인트 앞에 둔다 */
async function editorOnlyMiddleware(req, res, next) {
  try {
    if (await canEdit(req.admin)) return next();
  } catch (e) { /* 아래 403 으로 수렴 */ }
  return res.status(403).json({
    ok: false, error: '이 화면에서는 편집 권한이 없습니다(관리자에게 명단 등록을 요청하세요).', readOnly: true,
  });
}

module.exports = { canEdit, editorOnlyMiddleware, listEditors, addEditor, removeEditor, invalidate };
