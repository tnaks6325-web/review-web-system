'use strict';
/**
 * 작업보드 우클릭 "리뷰어 정보" — 줄 → 본계정 리뷰어의 연락처·카카오톡 아이디.
 *
 * ★★ 누구의 정보인지는 `csRecipient.resolveRecipients` 가 정한다(리뷰어에게 메시지 보내기와 **같은 판정**).
 *   여기서 판정을 새로 세우면 "메시지는 A에게 가는데 카톡 아이디는 B의 것"으로 갈린다.
 * ★ 카카오톡 아이디 조회는 따로 한다 — 이 조회가 실패해도 메시지 판정(연락처)은 살아 있어야 하고,
 *   실패는 `kakaoKnown:false`(모름)로 내려 화면이 "미등록"으로 꾸미지 않게 한다.
 * ★ 읽기 전용(쓰기 0건).
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { resolveRecipients } = require('./csRecipient.service');

const CHUNK = 200;          // resolveRecipients 1회 상한
const MAX_IDS = 2000;       // 한 번에 받을 줄 수 상한(작업표 최대 크기 여유분)

async function reviewerContactsForRows({ sheetId, tabName, participantIds } = {}) {
  const ids = [...new Set((participantIds || []).map(v => String(v || '').trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (!sheetId || !tabName || !ids.length) return { items: [], kakaoUnavailable: false };

  const resolved = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    resolved.push(...await resolveRecipients({ sheetId, tabName, participantIds: ids.slice(i, i + CHUNK) }));
  }

  const p8s = [...new Set(resolved.filter(r => r.ok && r.phone8).map(r => r.phone8))];
  const kakaoByP8 = new Map();
  let kakaoUnavailable = false;
  if (p8s.length) {
    try {
      const { rows } = await pool.query(
        `SELECT phone8, COALESCE(kakao_id,'') AS kakao FROM reviewers WHERE phone8 = ANY($1::text[])`, [p8s]);
      const tmp = new Map();
      for (const r of rows) {
        if (!tmp.has(r.phone8)) tmp.set(r.phone8, new Set());
        if (r.kakao) tmp.get(r.phone8).add(r.kakao);
      }
      // ★ 같은 뒤 8자리를 쓰는 행이 둘이고 아이디가 서로 다르면 어느 쪽인지 모른다 → 비운다(추측 금지).
      for (const [p8, set] of tmp) kakaoByP8.set(p8, set.size === 1 ? [...set][0] : '');
    } catch (e) {
      kakaoUnavailable = true;
      logger.warn(`[reviewerContact] 카톡 아이디 조회 실패: ${e.message}`);
    }
  }

  const items = resolved.map(r => {
    const base = {
      participantId: r.participantId, ok: !!r.ok, reason: r.reason || '',
      rowName: r.rowName || '',
    };
    if (!r.ok) return base;
    return {
      ...base,
      name: r.name || '', phoneFull: r.phoneFull || '', phone8: r.phone8,
      isSub: !!r.isSub, viaLabel: r.viaLabel || '',
      kakaoKnown: !kakaoUnavailable,
      kakaoId: kakaoUnavailable ? '' : (kakaoByP8.get(r.phone8) || ''),
    };
  });
  return { items, kakaoUnavailable };
}

module.exports = { reviewerContactsForRows, MAX_IDS };
