const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src');
const quota = fs.readFileSync(path.join(root, 'services', 'linkedRecruitQuota.service.js'), 'utf8');
const cron = fs.readFileSync(path.join(root, 'jobs', 'cron.js'), 'utf8');

assert.match(quota, /cp\.deleted_at IS NULL AND cp\.active = TRUE/, '자동 대상은 화면에 보이는 활성 행만 센다.');
assert.match(quota, /rc\.participation_mode AND rc\.status = 'active' AND rc\.archived_at IS NULL/, '보관·비활성 공고는 자동 정리하지 않는다.');
assert.match(quota, /NOT EXISTS \(\s*SELECT 1 FROM recruit_campaigns shared/, '공유 작업표는 후보 단계에서 제외해 자동 스윕을 독점하지 않는다.');
assert.match(quota, /MAX_RENUMBER_ROWS/, '대형 작업표는 부분 번호정리 대신 자동 정리 대상에서 제외한다.');
assert.match(quota, /const \{ renumberTab \} = require\('\.\/rowNumbering\.service'\)/, '자동 정리는 번호 재정렬을 함께 실행한다.');
assert.match(quota, /rebuildWorktableProjection\(changed, by, retryProjection\)/, '번호 정렬 뒤 원장 투영을 재생성한다.');
assert.match(cron, /WORKTABLE_CAP_AUTOFIX !== '0'/, '자동 복구는 기본 활성이고 환경변수로만 끈다.');
assert.match(cron, /setTimeout\(\(\) => \{ void runCapRepair\('boot'\); \}, capRepairBootDelay\)/, '배포 후 수동 버튼 없이 즉시 백스톱을 실행한다.');
assert.match(cron, /withJobLock\('worktable_cap_autofix'/, '다중 인스턴스에서 자동 정리가 중복 실행되지 않는다.');
assert.match(cron, /cleanupOverflowEmptyWorktableSlots\(\{\s*dryRun: false/, '자동 복구는 같은 안전 정리 서비스의 실제 실행 경로를 쓴다.');
assert.match(cron, /const failures = \(r && r\.items \|\| \[\]\)\.filter/, '자동 정리 실패는 운영 로그에 남긴다.');

console.log('worktableAutoCapRepair: 11 passed');
