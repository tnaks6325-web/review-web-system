/**
 * reviewerCampaignEditor.service.js
 * 리뷰어 앱(index.html)에서 "공고 수정"을 열어 줄 사람 = **인트라넷에서 관리자로 지정된 직원**(결정 257 · 2026-10-19).
 *   ⚠ 종전(결정 040)의 phone8 허용명단(`reviewer_campaign_editors`, 마스터가 옛 대시보드에서 관리)은 폐지됐다.
 *     표는 남겨 두지만(되돌리기·번호변경 이관 무접촉) 발급·검증 어디에서도 읽지 않는다.
 *
 * 보안 설계:
 *  - 발급 전제 = 인트라넷 아이디·비밀번호 실검증 + 관리자 판정. 판정 단일 출처 =
 *    auth.service.verifyIntranetIdentity(작업보드 인트라넷 로그인과 같은 INTRANET_SSO_ADMIN_USERS/_GROUPS 규칙).
 *    관리자가 아니면 미발급(일반 직원은 작업보드에서 공고를 고친다).
 *  - 토큰 = { role:'admin', via:'reviewer_campaign', iu, ia:true }, TTL 2h. role 은 항상 'admin' 하향 고정(최소권한).
 *  - authMiddleware 가 via:'reviewer_campaign' 을 **PUT /api/campaign/admin/:id + POST /api/product/preview** 로만
 *    격리(종전 그대로) — 이 토큰으로 다른 관리 API·작업보드에는 도달 불가. 넓은 8h 인트라넷 토큰은 발급하지 않는다.
 *  - 공고 저장 시점(campaign.routes `_scopedCampaignEdit`)은 `iu` + `ia===true` 를 요구한다 → 옛 phone8 토큰은 거절.
 */
const jwt = require('jsonwebtoken');

const TOKEN_TTL = process.env.REVIEWER_CAMPAIGN_TOKEN_TTL || '2h';
const NOT_ADMIN_MSG = '인트라넷에서 관리자로 지정된 계정만 리뷰어 앱에서 공고를 고칠 수 있어요. 작업보드에서 수정해 주세요.';

/**
 * 인트라넷 관리자 → 공고 전용 스코프 토큰.
 * @returns {ok:true, token, name} | {ok:false, error, reason?}
 */
async function issueCampaignTokenForIntranetAdmin(username, password, _fetch) {
  const { verifyIntranetIdentity } = require('./auth.service');
  const v = await verifyIntranetIdentity(username, password, _fetch);
  if (!v.ok) return { ok: false, error: v.error, ...(v.reason ? { reason: v.reason } : {}) };
  if (v.isAdmin !== true) return { ok: false, error: NOT_ADMIN_MSG, reason: 'not_admin' };
  const token = jwt.sign(
    { name: v.display, role: 'admin', via: 'reviewer_campaign', iu: v.username, ia: true },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
  return { ok: true, token, name: v.display };
}

/** 저장 시점 재확인 — 인트라넷 관리자 경로로 받은 토큰만 통과(옛 phone8 토큰 거절). */
function isIntranetAdminCampaignToken(claims) {
  return !!(claims && claims.via === 'reviewer_campaign' && claims.ia === true && String(claims.iu || '').trim());
}

module.exports = { issueCampaignTokenForIntranetAdmin, isIntranetAdminCampaignToken, NOT_ADMIN_MSG };
