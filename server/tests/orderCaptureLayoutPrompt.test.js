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
  /const EXTRACT_CACHE_VERSION = 'extract3'/.test(src)
  && /EXTRACT_CACHE_VERSION \+ ':' \+ sampleSig \+ ':' \+ base64Data/.test(src));

console.log('\n등록 예시의 실제 주문정보 추출 연결');
const diag = fs.readFileSync(path.join(__dirname, '../src/routes/diag.routes.js'), 'utf8');
const inspect = fs.readFileSync(path.join(__dirname, '../src/services/reviewInspect.service.js'), 'utf8');
ok('image-extract가 구매캡처 기준이미지를 로드해 추출 함수에 전달한다',
  /loadOrderExtractionSamples\(\)/.test(diag)
  && /extractOrderFromImage\(imageBase64,[\s\S]{0,120}\{ samples: extractionSamples \}/.test(diag));
ok('주문추출에는 구매확정 예시를 제외하고 최근 4장만 사용한다',
  /async function loadOrderExtractionSamples\(\)[\s\S]{0,500}filter\(s => s\.kind === 'order_capture'\)[\s\S]{0,300}_trimSamples\([\s\S]{0,80}, 4\)/.test(inspect));
ok('예시 개인정보 복사 금지와 마지막 대상만 판독하도록 구분한다',
  /예시 속 이름·전화번호·주소·주문번호·금액은 절대 답에 복사하지 마세요/.test(src)
  && /반환값은 마지막 \[판독 대상 이미지\]에서만 읽으세요/.test(src));
ok('유사 한글을 실제 획 기준으로 재확인한다',
  /비슷한 한글\(남\/낭, 혜\/해 등\)[\s\S]{0,100}실제 획 모양을 기준으로 두 번 확인/.test(src));
ok('대상 이미지까지 포함한 총 요청량 예산 안에서만 예시를 동봉한다',
  /const EXTRACT_INLINE_CHAR_BUDGET = 18 \* 1024 \* 1024/.test(src)
  && /EXTRACT_INLINE_CHAR_BUDGET - Buffer\.byteLength\(String\(targetBase64/.test(src)
  && /if \(size > remaining\) continue/.test(src)
  && /const samples = _fitExtractionSamples\(requestedSamples, cleanBase64\)/.test(src));

console.log(`\n${passed}개 규칙 통과`);
