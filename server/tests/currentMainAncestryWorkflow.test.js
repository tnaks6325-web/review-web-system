/* Regression guard for the protected-main deployment rule.
   The workflow must check the PR head against a freshly fetched origin/main;
   comparing only to the checkout's stale remote-tracking ref is not safe. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'current-main-ancestry.yml'), 'utf8');
assert.match(workflow, /pull_request:/, 'PR에서 실행돼야 한다');
assert.match(workflow, /- main/, 'main 대상 PR만 검사해야 한다');
assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/, 'PR head 자체를 검사해야 한다');
assert.match(workflow, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/, '원격 main을 검사 직전에 다시 받아야 한다');
assert.match(workflow, /git merge-base --is-ancestor origin\/main HEAD/, '최신 main이 PR의 조상인지 실패형으로 검사해야 한다');
console.log('✅ currentMainAncestryWorkflow: 5 cases passed');
