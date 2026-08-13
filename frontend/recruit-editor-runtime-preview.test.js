const assert = require('assert');
const fs = require('fs');
const path = require('path');

const preview = fs.readFileSync(path.join(__dirname, 'recruit-editor-runtime-preview.html'), 'utf8');

assert.match(
  preview,
  /className\s*=\s*'rf-opt-row rf-preview-product-row'/,
  '옵션 없는 작업의 프리뷰 행은 식별 가능한 상품 행이어야 합니다.'
);
assert.match(preview, /rf-opt-prod/, '상품명 입력란 클래스가 필요합니다.');
assert.match(preview, /rf-opt-pay/, '결제금액 입력란 클래스가 필요합니다.');
assert.match(preview, /rf-opt-rt/, '모집인원 입력란 클래스가 필요합니다.');
assert.match(preview, /rf-opt-dl/, '일건수 입력란 클래스가 필요합니다.');
assert.match(
  preview,
  /wrap\.classList\.toggle\('rf-pm-none',\s*selected !== 'opt'\)/,
  '작업 종류를 전환할 때 옵션 없는 작업의 열 구성이 복구되어야 합니다.'
);

console.log('runtime preview product row guard passed');
