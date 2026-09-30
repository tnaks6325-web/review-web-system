/**
 * reviewerSubAccountRegistrationMessage.test.js
 * 공개 리뷰어 등록 화면에서 타계정 번호 충돌을 이름 노출 없이 안내한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../frontend/js/search-app.js'),
  'utf8'
);

const branch = source.match(
  /else if \(data && data\.reason === "phone_registered_as_sub_account"\) \{([\s\S]*?)\}\s*else if \(data && data\.isDuplicate\)/
);

assert(branch, '타계정 충돌 전용 분기가 중복번호 분기보다 먼저 있어야 합니다.');
assert(
  branch[1].includes('_showRegErr("다른 리뷰어의 타계정으로 이미 등록된 번호입니다.")'),
  '타계정 충돌은 확정된 안전 문구로 표시해야 합니다.'
);
assert(
  !/\$\{[^}]*mainName|data\.mainName/.test(branch[1]),
  '공개 등록 화면에서 연결된 리뷰어 이름을 노출하면 안 됩니다.'
);

console.log('✅ reviewerSubAccountRegistrationMessage: 3 cases passed');
