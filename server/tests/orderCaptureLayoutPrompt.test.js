'use strict';

/**
 * orderCaptureLayoutPrompt.test.js — 실제 4유형 구매캡처에서 확인한 구조 규칙 회귀가드.
 * 원본 캡처에는 이름·전화번호·주소가 있어 저장소에 넣지 않고, 판독 규칙만 고정한다.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../src/services/gemini.service.js'), 'utf8');
let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

console.log('\n구매캡처 4유형 판독 규칙');
ok('쿠팡 모바일은 라벨 없는 이름→주소→전화번호 묶음을 읽는다',
  /쿠팡 모바일:[\s\S]{0,220}첫 번째 짧은 한글 이름[\s\S]{0,160}우편번호·주소[\s\S]{0,80}010 전화번호/.test(src));
ok('쿠팡 PC는 받는사람 정보의 라벨과 값을 대응한다',
  /쿠팡 PC:[\s\S]{0,180}"받는사람"[\s\S]{0,80}"연락처"[\s\S]{0,80}"받는주소"[\s\S]{0,80}"배송요청사항"/.test(src));
ok('네이버 모바일·PC는 배송지 카드의 이름→전화번호→주소 순서를 읽는다',
  /네이버 모바일·PC:[\s\S]{0,180}"배송지"[\s\S]{0,120}이름\(배송지 별칭\), 전화번호, 주소/.test(src));
ok('네이버 배송지 별칭을 수취인 이름에서 분리한다',
  /"박윤정\(집\)"은 recipient="박윤정"/.test(src));

console.log('\n정확 판독 안전핀');
ok('이름을 자연스러운 이름으로 추정·교정하지 않는다', /자연스러운 이름으로 추정하거나 교정하지 말고/.test(src));
ok('가림 별표를 보존한다', /별표\(\*\)[\s\S]{0,100}그대로 보존/.test(src));
ok('보이지 않는 주문자를 수취인으로 복사하지 않는다', /주문자 이름이 따로 없으면[\s\S]{0,100}orderer를 빈 문자열/.test(src));
ok('실제 결제 총액을 우선한다', /실제 "총 결제금액" 또는 "주문금액"을 우선/.test(src));
ok('프롬프트 변경은 새 캐시 접두를 사용한다',
  /const EXTRACT_CACHE_VERSION = 'extract2'/.test(src)
  && /_getCacheKey\(EXTRACT_CACHE_VERSION \+ ':' \+ base64Data\)/.test(src));

console.log(`\n${passed}개 규칙 통과`);
