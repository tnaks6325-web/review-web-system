'use strict';
/**
 * 카카오톡 아이디 정규화·검사 — 단일 출처(가입·내정보 저장·화면 안내가 같은 규칙을 쓴다).
 * 카카오톡 아이디는 영문·숫자·마침표·밑줄·하이픈으로 이루어진다. 앞의 '@' 는 떼어 준다
 * (프로필 화면에 @ 없이 보이지만 사람들이 붙여 적는 경우가 많다).
 * 판정 실패는 null — 추측해서 고치지 않는다.
 */
const KAKAO_ID_RE = /^[A-Za-z0-9._-]{2,30}$/;
const KAKAO_ID_HINT = '카카오톡 아이디는 영문·숫자·. _ - 로 2~30자입니다. (카톡 → 설정 → 프로필 관리에서 확인)';

function normalizeKakaoId(v) {
  const s = String(v == null ? '' : v).trim().replace(/^@+/, '');
  if (!s) return '';
  return KAKAO_ID_RE.test(s) ? s : null;
}

module.exports = { normalizeKakaoId, KAKAO_ID_RE, KAKAO_ID_HINT };
