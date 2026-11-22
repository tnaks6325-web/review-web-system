'use strict';
/**
 * koreanParticle — 이름 뒤 조사 「은/는」 고르기(사람이 읽는 안내 문구용 · 결정 394).
 *   한글 끝 = 받침 유무 · 숫자 끝 = 읽는 소리(영·일·삼·육·칠·팔, 끝이 0 이면 십·백·천·만 = 받침)
 *   대문자 약자 끝(S·M·XL) = 알파벳 이름 소리(엘·엠·엔·알 = 받침)
 *   닫는 괄호·따옴표·공백은 건너뛰고 그 앞 글자로 판단한다.
 *   ★ 모르는 끝(영문 낱말 「Red」·단위 「1kg」·기호)은 null — 틀린 조사를 지어내지 않는다.
 *     withTopic 은 그때 「<이름> 옵션은」으로 바꿔 쓴다(「옵션」은 받침이 있어 「은」이 늘 맞다).
 */
const TRAIL_SKIP = /[\s)\]}」』》〉"'’”]+$/u;
const DIGIT_FINAL = new Set(['0', '1', '3', '6', '7', '8']); // 영·일·삼·육·칠·팔 (0 = 십·백·천·만·영 모두 받침)
const LETTER_FINAL = new Set(['L', 'M', 'N', 'R']);           // 엘·엠·엔·알

/** '은' | '는' | null(모름) */
function topicParticle(word) {
  const s = String(word == null ? '' : word).replace(TRAIL_SKIP, '');
  if (!s) return null;
  const ch = s.slice(-1);
  const code = ch.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) return (code - 0xAC00) % 28 ? '은' : '는';
  if (/[0-9]/.test(ch)) return DIGIT_FINAL.has(ch) ? '은' : '는';
  // 대문자 약자(앞이 영문 소문자가 아닌 대문자 1~4자 덩어리 — 「XL」「2XL」「S」) = 알파벳 이름으로 읽는다
  const m = s.match(/(?:^|[^A-Za-z])([A-Z]{1,4})$/);
  if (m) return LETTER_FINAL.has(ch) ? '은' : '는';
  return null;
}

/** 「피치는」 · 「레몬은」 · 모르면 「Red 옵션은」 · 이름이 비면 null(호출부가 이름 없는 문장을 쓴다) */
function withTopic(word, noun = '옵션') {
  const w = String(word == null ? '' : word).trim();
  if (!w) return null;
  const p = topicParticle(w);
  return p ? w + p : `${w} ${noun}${topicParticle(noun) || '은'}`;
}

module.exports = { topicParticle, withTopic };
