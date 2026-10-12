/**
 * reviewerSubAccountRegistrationMessage.test.js
 * 공개 리뷰어 등록 화면에서 타계정 번호 충돌을 안내한다 — 그 번호에 등록된 이름(서버 error)만 보이고,
 * 그 타계정을 올린 본계정 이름(mainName)은 보이지 않는다(결정 226 C · 사용자 확정 2026-10-12).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../frontend/js/search-app.js'),
  'utf8'
);

const branch = source.match(
  /else if \(data && \(data\.reason === "phone_registered_as_sub_account" \|\| data\.reason === "phone_registered_other_name"\)\) \{([\s\S]*?)\}\s*else if \(data && data\.isDuplicate\)/
);

assert(branch, '타계정 충돌·다른 이름 가입 분기가 중복번호 분기보다 먼저 있어야 합니다.');
assert(
  branch[1].includes('"다른 리뷰어의 타계정으로 이미 등록된 번호입니다."') && /_showLoginErr\(_regMsg\)/.test(branch[1]),
  '타계정 충돌은 서버 안내(그 번호의 이름)를, 없으면 확정된 안전 문구를 표시해야 합니다.'
);
assert(
  !/\$\{[^}]*mainName|data\.mainName/.test(branch[1]),
  '공개 등록 화면에서 연결된 리뷰어 이름을 노출하면 안 됩니다.'
);

console.log('✅ reviewerSubAccountRegistrationMessage: 3 cases passed');
