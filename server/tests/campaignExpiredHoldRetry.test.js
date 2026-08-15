const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'campaign.html'), 'utf8');
assert.match(source, /async function releaseExpiredHold\(h\)/, '만료 홀드 해제 함수가 필요합니다.');
assert.match(source, /clearHold\(h && h\.phone8\)/, '만료된 명의의 로컬 홀드만 제거해야 합니다.');
assert.match(source, /if\(j\.reason === 'expired'\)\{ await releaseExpiredHold\(h\); return; \}/, '초기 복원 만료도 참여 전 화면으로 돌려야 합니다.');
assert.match(source, /else if\(j\.reason === 'expired'\)\{ await releaseExpiredHold\(h\); \}/, '폴링 중 만료도 같은 경로를 사용해야 합니다.');
console.log('✓ expired hold returns the reviewer to rejoin state');
