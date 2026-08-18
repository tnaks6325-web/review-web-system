/**
 * 테스트 프론트가 본서버 API가 아닌 test-review-wdb API로 연결되는지 고정한다.
 * 실행: node tests/testFrontendApiBase.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const apiSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'api.js'), 'utf8');

assert.match(
  apiSource,
  /window\.location\.hostname === 'test-review-wdb-web-production\.up\.railway\.app'[\s\S]{0,180}return 'https:\/\/test-review-wdb-production\.up\.railway\.app';/,
  '테스트 프론트는 test-review-wdb API를 사용해야 합니다.'
);

assert.match(
  apiSource,
  /test-review-wdb-web-review-web-system-pr-\(\\d\+\)[\s\S]{0,260}test-review-wdb-review-web-system-pr-' \+ pr\[1\]/,
  'Railway PR 테섭 프론트는 같은 PR 번호의 test-review-wdb API를 사용해야 합니다.'
);

console.log('✅ testFrontendApiBase: 테스트 프론트 API 연결 통과');
