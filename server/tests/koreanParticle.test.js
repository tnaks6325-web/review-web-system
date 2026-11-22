'use strict';
/**
 * koreanParticle.test.js — 이름 뒤 조사(은/는) 고르기(utils/koreanParticle · 결정 394 안내 문구).
 *   ① 한글 끝 = 받침 있으면 「은」, 없으면 「는」
 *   ② 숫자 끝 = 읽는 소리(영·일·삼·육·칠·팔 / 십·백·천 = 받침)
 *   ③ 대문자 약자 끝(S·M·L·XL) = 알파벳 이름 소리(엘·엠·엔·알 = 받침)
 *   ④ 닫는 괄호·따옴표·공백은 건너뛰고 그 앞 글자로 판단
 *   ⑤ 모르는 끝(영문 낱말·기호·빈 값) = null → withTopic 은 조사 대신 「<이름> 옵션은」으로 바꿔 쓴다(틀린 조사를 지어내지 않는다)
 */
const assert = require('assert');
const { topicParticle, withTopic } = require('../src/utils/koreanParticle');

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

ok('① 한글 끝 받침', () => {
  for (const w of ['레몬', '사과', '복숭아 1박스', '대용량', '세트']) assert.ok(['은', '는'].includes(topicParticle(w)), w);
  assert.equal(topicParticle('레몬'), '은');
  assert.equal(topicParticle('대용량'), '은');
  assert.equal(topicParticle('피치'), '는');
  assert.equal(topicParticle('세트'), '는');
});

ok('② 숫자 끝 = 읽는 소리', () => {
  const want = { 0: '은', 1: '은', 2: '는', 3: '은', 4: '는', 5: '는', 6: '은', 7: '은', 8: '은', 9: '는' };
  for (const [d, p] of Object.entries(want)) assert.equal(topicParticle('옵션' + d), p, '옵션' + d);
  assert.equal(topicParticle('10'), '은', '십');
  assert.equal(topicParticle('100'), '은', '백');
  assert.equal(topicParticle('세트 12'), '는', '십이');
});

ok('③ 대문자 약자 끝 = 알파벳 이름 소리', () => {
  for (const w of ['L', 'M', 'N', 'R', 'XL', 'XXL', '2XL']) assert.equal(topicParticle(w), '은', w);
  for (const w of ['S', 'XS', 'A', 'B', 'K']) assert.equal(topicParticle(w), '는', w);
  assert.equal(topicParticle('티셔츠 XL'), '은');
});

ok('④ 닫는 괄호·따옴표·공백은 건너뛴다', () => {
  assert.equal(topicParticle('피치(대)'), '는');
  assert.equal(topicParticle('레몬 (1kg 박스)'), '는', '박스');
  assert.equal(topicParticle('「레몬」 '), '은');
  assert.equal(topicParticle('피치[소]'), '는');
});

ok('⑤ 모르는 끝 = null · withTopic 은 「옵션은」으로 바꿔 쓴다', () => {
  for (const w of ['Red', 'apple', 'Pink', '1kg', '피치!', '', null, undefined, '   ', '()']) assert.equal(topicParticle(w), null, String(w));
  assert.equal(withTopic('피치'), '피치는');
  assert.equal(withTopic('레몬'), '레몬은');
  assert.equal(withTopic('XL'), 'XL은');
  assert.equal(withTopic('Red'), 'Red 옵션은');
  assert.equal(withTopic('피치 1kg'), '피치 1kg 옵션은');
  assert.equal(withTopic(''), null, '이름 없음 = 호출부가 이름 없는 문장을 쓴다');
});

console.log(`koreanParticle: ${passed}/5 통과`);
