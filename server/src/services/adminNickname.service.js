/**
 * adminNickname.service.js — 관리자 닉네임 (migration 078)
 *
 * 왜: C/S 1:1문의 답장의 `cs_messages.sender_name`이 로그인 계정명(=실명)이라 리뷰어 대화창에
 *     실명이 그대로 노출됐다. 관리자마다 닉네임을 정하고, **읽는 시점에** 그 닉네임으로 바꿔
 *     내보낸다(쓰기 경로는 종전대로 로그인명을 기록 → 닉네임을 바꾸면 과거 메시지까지 함께 바뀐다).
 *
 * ★ 안전 기본값(완화 금지): 닉네임 미설정 관리자의 **리뷰어 화면 표시는 '관리자'** 다.
 *   "설정 전까지 실명 노출"로 두면 이 기능이 막으려던 사고가 그대로 남는다.
 *   관리자 화면에서는 로그인명을 그대로 보여 내부 책임추적을 유지한다(외부/내부 표시 분리).
 */
const pool = require('../db/pool');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60 * 1000;
let _cache = null;          // { map: {loginName: nickname}, at: number }

function _invalidate() { _cache = null; }

/** 로그인명 → 닉네임 전체 맵(60초 캐시). 조회 실패는 빈 맵(fail-soft — 대화는 계속 떠야 한다). */
async function getNicknameMap() {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.map;
  try {
    const { rows } = await pool.query('SELECT login_name, nickname FROM admin_nicknames');
    const map = {};
    for (const r of rows) {
      const k = String(r.login_name || '').trim();
      const v = String(r.nickname || '').trim();
      if (k && v) map[k] = v;
    }
    _cache = { map, at: Date.now() };
    return map;
  } catch (err) {
    logger.warn('[adminNickname] 목록 조회 실패: ' + err.message);
    return _cache ? _cache.map : {};
  }
}

/** 내 닉네임(없으면 '') */
async function getNickname(loginName) {
  const map = await getNicknameMap();
  return map[String(loginName || '').trim()] || '';
}

/**
 * 리뷰어에게 보여줄 이름 — 닉네임 || '관리자'.
 * 이미 닉네임으로 저장된 옛 값(로그인명 키에 없는 값)은 실명이 아니므로 그대로 통과시키지 않는다:
 * 판단할 수 없는 값은 전부 '관리자'로 가린다(fail-closed).
 */
function toReviewerName(senderName, map) {
  const raw = String(senderName || '').trim();
  if (!raw) return '관리자';
  return (map && map[raw]) || '관리자';
}

/** 관리자에게 보여줄 이름 — 닉네임 || 로그인명(내부 책임추적 유지) */
function toAdminName(senderName, map) {
  const raw = String(senderName || '').trim();
  if (!raw) return '관리자';
  return (map && map[raw]) || raw;
}

/** 메시지 배열의 admin 발신자 이름을 대상 화면에 맞게 치환(리뷰어 메시지는 그대로) */
async function maskMessages(messages, audience) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return list;
  const map = await getNicknameMap();
  const conv = audience === 'reviewer' ? toReviewerName : toAdminName;
  return list.map(m => (m && m.senderRole === 'admin')
    ? { ...m, senderName: conv(m.senderName, map) }
    : m);
}

/** 닉네임 저장(본인 것). 빈 값이면 해제(= 리뷰어 화면에 '관리자'로 표시) */
async function setNickname(loginName, nickname, updatedBy = '') {
  const key = String(loginName || '').trim();
  const nick = String(nickname || '').trim().slice(0, 20);
  if (!key) throw new Error('로그인 계정을 확인할 수 없습니다.');
  if (nick) {
    await pool.query(
      `INSERT INTO admin_nicknames (login_name, nickname, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (login_name) DO UPDATE
         SET nickname = EXCLUDED.nickname, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, nick, String(updatedBy || key).slice(0, 60)]
    );
  } else {
    await pool.query('DELETE FROM admin_nicknames WHERE login_name = $1', [key]);
  }
  _invalidate();
  return nick;
}

module.exports = {
  getNicknameMap, getNickname, setNickname,
  toReviewerName, toAdminName, maskMessages,
  _invalidate,
};
