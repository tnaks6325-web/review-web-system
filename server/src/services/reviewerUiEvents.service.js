'use strict';
/* 결정 427 — 리뷰어 화면 사건 횟수(개인정보 0).
 *   허용 목록에 있는 사건·화면만 받는다. 이름·전화·사진·주문번호·리뷰어 id·인터넷 주소는 받지도 남기지도 않는다(완화 금지).
 *   기록은 기다리지 않고 실패는 삼킨다(표가 없어도·DB 가 잠깐 막혀도 화면·응답 무관). */
const { logger } = require('../utils/logger');

const UI_EVENTS = Object.freeze({
  photo_reattach_notice: Object.freeze({ screens: Object.freeze(['campaign', 'direct']) }),
});

/** 화면이 보낸 본문 → 저장할 한 줄(받지 않을 것이면 null). 모르는 칸은 버린다. */
function normalizeUiEvent(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const event = typeof b.event === 'string' ? b.event : '';
  const spec = Object.prototype.hasOwnProperty.call(UI_EVENTS, event) ? UI_EVENTS[event] : null;
  if (!spec) return null;
  const screen = typeof b.screen === 'string' ? b.screen : '';
  if (!spec.screens.includes(screen)) return null;
  const n = b.slots;   // 화면은 숫자로 보낸다 — 글자·소수·범위 밖은 받지 않는다
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 20) return null;
  return { event, screen, slots: n };
}

function _pool() { return require('../db/pool'); }

/** 한 줄 남기기 — Promise 를 돌려주지만 부르는 쪽은 기다리지 않는다. 실패는 경고 한 줄(내용 없이)로 삼킨다. */
function recordUiEvent(row, pool) {
  const p = pool || _pool();
  return Promise.resolve()
    .then(() => p.query('INSERT INTO reviewer_ui_events (event, screen, slots) VALUES ($1, $2, $3)', [row.event, row.screen, row.slots]))
    .then(() => true)
    .catch((err) => {
      try { logger.warn({ message: '[reviewerUiEvents] 기록 실패', code: err && err.code }); } catch (_) {}
      return false;
    });
}

module.exports = { UI_EVENTS, normalizeUiEvent, recordUiEvent };
