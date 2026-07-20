/**
 * reviewerCampaignEditor.service.js
 * 리뷰어 앱(무비밀번호 로그인)에서 "공고 수정" 권한을 가질 사람을 마스터가 phone8로 관리하고,
 * 허용된 리뷰어에게만 **공고 경로 전용·단기** 스코프 토큰을 발급한다.
 *
 * 보안 설계(레드팀 반영):
 *  - 발급 전제 = verifyReviewer(name, phone8)로 "실제 리뷰어 신원"을 재검증(리뷰어 로그인과 동일 강도)
 *    AND 이 표에 active 등록된 phone8. 둘 중 하나라도 실패면 미발급.
 *  - 토큰 = { role:'admin', via:'reviewer_campaign' }, TTL 2h. role은 항상 'admin'으로 하향 고정
 *    (마스터(김수만)라도 이 경로에선 admin 스코프만 — 최소권한).
 *  - authMiddleware가 via:'reviewer_campaign'을 **PUT /api/campaign/admin/:id[/status]** 로만 격리
 *    (create/delete/confirm·타 관리자 API 전부 차단). 명단 관리(/api/admin/*)에는 도달 불가.
 *  - phone8은 숫자 8자리로 정규화해 저장/조회(입력 흔들림 방지).
 */
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const TOKEN_TTL = process.env.REVIEWER_CAMPAIGN_TOKEN_TTL || '2h';

function _norm8(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  return d.length >= 8 ? d.slice(-8) : d;
}

async function listEditors() {
  const { rows } = await pool.query(
    'SELECT phone8, label, active, added_by, created_at, updated_at FROM reviewer_campaign_editors ORDER BY created_at DESC'
  );
  return rows;
}

// phone8이 active 허용 명단에 있는지 (토큰 발급 게이트)
async function isActiveEditor(phone8) {
  const p8 = _norm8(phone8);
  if (p8.length !== 8) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM reviewer_campaign_editors WHERE phone8 = $1 AND active = TRUE LIMIT 1', [p8]
  );
  return rows.length > 0;
}

async function addEditor(phone8, label, addedBy) {
  const p8 = _norm8(phone8);
  if (p8.length !== 8) return { ok: false, error: '전화번호 뒤 8자리를 정확히 입력하세요.' };
  await pool.query(
    `INSERT INTO reviewer_campaign_editors (phone8, label, active, added_by, updated_at)
     VALUES ($1, $2, TRUE, $3, NOW())
     ON CONFLICT (phone8) DO UPDATE SET
       label = EXCLUDED.label, active = TRUE, added_by = EXCLUDED.added_by, updated_at = NOW()`,
    [p8, String(label || '').trim(), String(addedBy || '').trim()]
  );
  return { ok: true, phone8: p8 };
}

async function removeEditor(phone8) {
  const p8 = _norm8(phone8);
  const r = await pool.query('DELETE FROM reviewer_campaign_editors WHERE phone8 = $1', [p8]);
  return { ok: true, removed: r.rowCount };
}

async function setEditorActive(phone8, active) {
  const p8 = _norm8(phone8);
  const r = await pool.query(
    'UPDATE reviewer_campaign_editors SET active = $2, updated_at = NOW() WHERE phone8 = $1', [p8, active === true]
  );
  if (r.rowCount === 0) return { ok: false, error: '해당 번호가 명단에 없습니다.' };
  return { ok: true };
}

/**
 * 리뷰어 신원 확인 + 허용명단 검사 → 통과 시 공고 전용 스코프 토큰 발급.
 * ★ 레드팀 #1 방어: **직접(메인) 계정 정확 일치만** 인정한다. verifyReviewer의 sub_account
 *   분기는 무증명 등록(`/register`가 기존 번호에 임의 이름을 sub_account로 추가 허용)으로
 *   이름 게이트가 "번호 지식"만으로 우회되므로 사용하지 않는다. 이로써 발급 강도는
 *   "정확한 등록 이름 + phone8"(리뷰어 로그인 본연의 강도)로 복원된다.
 * ★ 레드팀 #3 방어: 토큰에 phone8을 실어 사용 시점(공고 PUT)에 명단 재검증 → 근실시간 폐기.
 * @returns {ok:true, token, name} | {ok:false, error}
 */
async function issueCampaignToken(name, phone8) {
  const p8 = _norm8(phone8);
  const n = String(name == null ? '' : name).trim();
  if (p8.length !== 8 || !n) return { ok: false, error: '권한이 없습니다.' };

  // 1) 직접 메인 계정 정확 일치(sub_account 경로 배제)
  const { rows } = await pool.query(
    'SELECT name FROM reviewers WHERE phone8 = $1 AND name = $2 LIMIT 1', [p8, n]
  );
  if (rows.length === 0) return { ok: false, error: '권한이 없습니다.' };

  // 2) 허용 명단(active)
  if (!(await isActiveEditor(p8))) return { ok: false, error: '권한이 없습니다.' };

  // 3) 최소권한 스코프 토큰(admin 하향 고정 · via 격리 · phone8 재검증키 · 단기)
  const token = jwt.sign(
    { name: rows[0].name, role: 'admin', via: 'reviewer_campaign', phone8: p8 },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
  return { ok: true, token, name: rows[0].name };
}

module.exports = {
  listEditors, isActiveEditor, addEditor, removeEditor, setEditorActive, issueCampaignToken, _norm8,
};
