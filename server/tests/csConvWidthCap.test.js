/**
 * csConvWidthCap.test.js — C/S 문의창구 대화창(#csConvPane) 너비 상한 회귀가드.
 *
 * 배경: 좌측 문의방 목록(#csRoomListWrap, 360px 고정)을 뺀 나머지 폭을 대화창이 전부
 * 차지해, QHD 이상 화면에서는 말풍선 사이 여백만 벌어지고 한 줄이 과하게 길어졌다.
 *
 * 확정 방식(사용자 확정): 대화창만 max-width:860px 로 상한 — 목록 옆에 그대로 붙이고
 * 남는 폭은 오른쪽 여백으로 흘려보낸다. 별도 스페이서/가운데 정렬 없음(요청 그대로).
 * 모듈이 admin.html·workdesk.html 공용이라(사본 금지 규율) 여기 하나만 고치면 두 화면에
 * 동시 반영된다 — 그래서 이 가드도 모듈 하나만 본다.
 *
 * 실행: node server/tests/csConvWidthCap.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'cs-inquiry.js'), 'utf8');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

ok('★ 스크립트 문법이 유효하다(문자열 리터럴 안 편집 실수 방지)', (() => {
  try { new Function(src); return true; } catch (e) { console.error(e.message); return false; }
})());

ok('#csConvPane 에 max-width:860px 가 있다',
  /id=\\"csConvPane\\"[^>]*max-width:860px/.test(src));
ok('★ 대화창은 여전히 flex:1;min-width:0 — max-width 만 추가(비율 성장은 유지, 상한만 걸림)',
  /id=\\"csConvPane\\"[^>]*flex:1;min-width:0;max-width:860px/.test(src));
ok('목록(#csRoomListWrap)은 고정 360px 그대로(이번 변경 대상 아님)',
  /id=\\"csRoomListWrap\\"[^>]*width:360px;flex-shrink:0/.test(src));
ok('★ 별도 스페이서/가운데 정렬 요소를 추가하지 않았다(목록 옆에 붙고 여백은 자동)', (() => {
  const i = src.indexOf('id=\\"tab-cs-inquiry\\"');
  const wrapper = src.slice(i, i + 4000);   // 문의방 목록+대화창을 감싸는 flex row 전체
  return !/csGutter|conv-center|justify-content:center/.test(wrapper);
})());

console.log(`\n✅ csConvWidthCap: ${n} cases passed`);
