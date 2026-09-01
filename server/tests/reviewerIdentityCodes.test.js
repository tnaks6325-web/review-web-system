/* 리뷰어 소유자·실참여자 코드 기반 회귀 가드.
   실행: NODE_PATH=<server node_modules> node tests/reviewerIdentityCodes.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const migration = read('migrations/142_reviewer_identity_codes.sql');
const campaign = read('src/routes/campaign.routes.js');
const reviewer = read('src/routes/reviewer.routes.js');
const trackB = read('src/routes/trackB.routes.js');
const ledger = read('src/services/orderLedger.service.js');
const participation = read('src/services/participation.service.js');
const reviewerService = read('src/services/reviewer.service.js');
const identity = require('../src/services/reviewerIdentity.service');

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; console.log('  ✓ ' + name); }

// 코드 표시와 seed 순서: 소유자=0001, 실제 참여자는 -0부터 고정.
ok('코드 형식: 소유자 4자리', identity.formatOwnerCode(1) === '0001');
ok('코드 형식: 본계정 실참여자 -0', identity.formatIdentityCode(1, 0) === '0001-0');
ok('코드 형식: 타계정은 배열 순서대로 -1/-2', identity.formatIdentityCode(1, 1) === '0001-1' && identity.formatIdentityCode(1, 2) === '0001-2');
const seeds = identity.buildIdentitySeeds({ name: '김수만', phone: '010-1111-2222', sub_accounts: [
  { name: '명지수', phone: '010-3333-4444' }, { name: '김가온', phone: '010-5555-6666' },
] });
ok('seed: 본계정+타계정 실제참여자 3개', seeds.issues.length === 0 && seeds.seeds.map(s => s.memberNo).join(',') === '0,1,2');
ok('seed: 같은 번호를 다른 실제참여자로 중복 등록 거부', identity.buildIdentitySeeds({ name: 'a', phone: '01011112222', sub_accounts: [{ name: 'b', phone: '01011112222' }] }).issues.some(x => x.code === 'duplicate_phone_in_owner'));

// 마이그레이션은 가산형+FK+별칭(과거 보존)이어야 한다.
ok('migration: reviewer_no와 identity/alias 테이블', /reviewer_no BIGINT/.test(migration) && /CREATE TABLE IF NOT EXISTS reviewer_identities/.test(migration) && /CREATE TABLE IF NOT EXISTS reviewer_identity_aliases/.test(migration));
ok('migration: 참여·제출·정산 기록에 두 FK를 모두 추가', ['campaign_applications', 'order_submissions', 'participation_links', 'campaign_participants', 'payment_batch_items'].every(t => new RegExp(`ALTER TABLE ${t}[\\s\\S]*?participant_identity_id UUID`).test(migration)));
ok('migration: 코드가 부여된 리뷰어 삭제는 RESTRICT', /owner_reviewer_id UUID NOT NULL REFERENCES reviewers\(id\) ON DELETE RESTRICT/.test(migration));

// 실제 참여 제한은 기존 명의 phone8 키를 유지하고, 코드 FK는 추가로만 고정한다.
const apply = campaign.slice(campaign.indexOf('async function _applyParticipation'), campaign.indexOf("router.post('/:id/apply'"));
ok('apply: 재참여 제한은 실제 참여 명의 holdP8를 계속 사용', /WHERE campaign_id = \$1 AND phone8 = \$2 AND status = 'submitted'[\s\S]*?\[id, holdP8\]/.test(apply));
ok('apply: 코드 쓰기 활성 시 실제 참여자 코드를 못 찾으면 fail-closed', /participant_identity_not_ready/.test(apply) && /resolveParticipantIdentity/.test(apply));
ok('apply: 코드 FK는 신청행에 함께 고정', /SET owner_reviewer_id = \$2, participant_identity_id = \$3/.test(apply));
ok('order ledger: 신청행의 코드 FK를 같은 트랜잭션으로 복사', /SET owner_reviewer_id = ca\.owner_reviewer_id,[\s\S]*participant_identity_id = ca\.participant_identity_id/.test(ledger));
ok('participation: 링크 upsert는 코드 FK를 비어있을 때만 보강', /COALESCE\(EXCLUDED\.participant_identity_id, participation_links\.participant_identity_id\)/.test(participation));

// owner 로그인은 모든 명의/별칭을 병합해 보되, apply 정책은 위의 실참여자 키와 분리된다.
ok('my-status: 코드 소유자 범위를 phone8 ANY로 조회', /getOwnerScopeByLoginPhone8[\s\S]*?ri\.phone8 = ANY\(\$1\)/.test(reviewer));
ok('my-applications: 이름 LIKE가 아니라 소유자 범위로 병합', /WHERE \(ca\.phone8 = ANY\(\$1\) OR ca\.owner_phone8 = ANY\(\$1\) OR ca\.owner_reviewer_id = \$2\)/.test(reviewer));
ok('admin: 전체 충돌 dry-run과 단일 bootstrap endpoint 존재', /identity-codes\/dry-run/.test(trackB) && /identity-codes\/:id\/bootstrap/.test(trackB));
ok('admin: 이름 및 번호 변경은 preview+confirm+환경승인', /identity-codes\/:id\/change/.test(trackB) && /REVIEWER_IDENTITY_CHANGE_ENABLED/.test(read('src/services/reviewerIdentity.service.js')));
// P1: 닫힌 별칭을 phone8 범위에 섞으면 번호 재사용 뒤 남의 이력이 보인다. 과거 행은 고정 UUID로만 병합한다.
ok('번호 재사용: 닫힌 alias를 phone8 조회 범위에 넣지 않음', !/alias_phone8/.test(read('src/services/reviewerIdentity.service.js').slice(read('src/services/reviewerIdentity.service.js').indexOf('async function getOwnerScopeByLoginPhone8'))));
ok('과거 코드 이력: my-status는 participation_links 소유자 FK로 병합', /pl\.owner_reviewer_id = \$2/.test(reviewer));
ok('타계정 배열 재정렬: 변경 전 identity 현재값과 name+phone8을 대조', /subs\[index\]\.name[\s\S]*?identity\.current_name[\s\S]*?subs\[index\]\.phone[\s\S]*?identity\.current_phone8/.test(read('src/services/reviewerIdentity.service.js')));
ok('코드 부여 뒤 profile 배열 일괄 변경은 차단', /identity_accounts_locked/.test(reviewerService) && /SELECT reviewer_no FROM reviewers/.test(reviewerService));

console.log(`\n✅ reviewerIdentityCodes: ${passed}개 통과`);
