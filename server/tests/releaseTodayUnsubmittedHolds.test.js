const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/trackB.routes.js'), 'utf8');
const body = (src.match(/router\.post\('\/campaigns\/release-today-unsubmitted-holds'[\s\S]*?\n\}\);/) || [''])[0];

assert.ok(body.includes("'camp_4c981df9de49'") && body.includes("'camp_bb0980ceddd4'"), '대상 공고가 정확히 고정돼야 합니다.');
assert.match(body, /status = 'applied'/, '미제출 홀드만 대상이어야 합니다.');
assert.doesNotMatch(body, /status = 'submitted'/, '제출완료 건을 해제하면 안 됩니다.');
assert.match(body, /applied_at >= date_trunc\('day', NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)/, '오늘(KST) 생성 홀드만 대상이어야 합니다.');
assert.match(body, /confirm !== 'release-today-unsubmitted-holds'/, '명시 확인값이 필요합니다.');
console.log('✓ today unsubmitted hold release is safely scoped');
