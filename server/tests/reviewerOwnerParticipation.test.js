'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const search = read('src/services/search.service.js');
const reviewerRoutes = read('src/routes/reviewer.routes.js');
const payment = read('src/services/payment.service.js');
const indexRoutes = read('src/routes/index.routes.js');
const targetOwnership = read('src/services/reviewerTargetOwnership.service.js');
const home = read('../frontend/index.html');
const migration = read('migrations/159_reviewer_owner_participation_backfill.sql');
const occurrences = (text, needle) => text.split(needle).length - 1;

const checks = [
  ['홈 검색은 명시한 ownerScope에만 로그인 토큰을 요구한다',
    /ownerScope === '1'[\s\S]*verifyReviewerSession\(token\)/.test(indexRoutes)],
  ['홈 검색과 예상금액 요청에 리뷰어 토큰을 보낸다',
    /includeSubmitted: "1", ownerScope: "1"/.test(home)
      && /review-earnings[\s\S]{0,180}headers: \{ \.\.\._getAuthHeaders\(\) \}/.test(home)],
  ['현재 참여행 owner UUID가 행 phone8보다 우선한다',
    /cp\.owner_reviewer_id = \$1[\s\S]*cp\.owner_reviewer_id IS NULL/.test(search)
      && /cp\.owner_reviewer_id = \$3[\s\S]*cp\.owner_reviewer_id IS NULL/.test(reviewerRoutes)],
  ['현재 소유자 링크는 행 번호보다 우선하고 레거시 링크는 정확한 현재 계좌 뒤로 둔다',
    /safeOwnerAcct && safeOwnerAcct\.source !== 'owner_link'[\s\S]*directAcct \|\| safeOwnerAcct/.test(payment)],
  ['입금 회차에 owner UUID와 participant identity를 박제한다',
    /owner_reviewer_id, participant_identity_id/.test(payment)
      && /it\.ownerReviewerId \|\| null, it\.participantIdentityId \|\| null/.test(payment)],
  ['백필은 이름을 쓰지 않고 유일한 owner_phone8과 기존 UUID 링크만 따른다',
    /HAVING COUNT\(DISTINCT c\.reviewer_id\) = 1/.test(migration)
      && /jsonb_array_elements[\s\S]*sub->>'phone'/.test(migration)
      && /ca\.owner_phone8 = u\.phone8/.test(migration)
      && !/reviewer_name|applicant_name\s*=|current_name\s*=/.test(migration)],
  ['등록DB에서 확정된 소유자는 오래된 링크·이름 불일치여도 본계정 범위에 포함한다',
    !/pl\.updated_at >= cp\.updated_at/.test(migration)
      && !/pl\.updated_at >= cp\.updated_at/.test(targetOwnership)
      && !/LEFT JOIN reviewers ro ON ro\.id = \$1/.test(search)
      && !/LEFT JOIN reviewers ro ON ro\.id = \$3/.test(reviewerRoutes)],
  ['현재 행 연락처가 다른 등록 소유자에게 연결되면 과거 링크를 차단한다',
    /NOT EXISTS \([\s\S]*current_owner\.id <> \$1[\s\S]*current_owner\.phone8 = cp\.phone8/.test(search)
      && /NOT EXISTS \([\s\S]*current_owner\.id <> \$3[\s\S]*current_owner\.phone8 = cp\.phone8/.test(reviewerRoutes)
      && /current_owner\.id <> \$4::uuid[\s\S]*current_owner\.phone8 = cp\.phone8/.test(targetOwnership)],
  ['과거 신청의 참여자 명의는 신청시각에 유효했던 alias로만 백필한다',
    /reviewer_identity_aliases[\s\S]*a\.valid_from <= ca\.applied_at[\s\S]*ca\.applied_at < a\.valid_to/.test(migration)
      && !/current_phone8, MIN\(id::text\)::uuid AS identity_id/.test(migration)],
  ['코드 도입 전 신청은 소유자 안에서 유일한 최초 initial alias만 과거로 확장한다',
    /ca\.applied_at < a\.valid_from[\s\S]*a\.reason = 'initial'[\s\S]*earlier\.identity_id = a\.identity_id/.test(migration)
      && /HAVING COUNT\(DISTINCT identity_id\) = 1/.test(migration)],
  ['다른 소유자가 과거에 쓴 번호는 현재 번호 소유자로 자동 승격하지 않는다',
    /reviewer_phone_changes rpc[\s\S]*rpc\.old_phone8 = c\.phone8[\s\S]*rpc\.reviewer_id <> c\.reviewer_id/.test(migration)
      && /movedPhoneOwners[\s\S]*historicalOwners/.test(payment)],
  ['과거 신청 owner_phone8도 번호 변경 이력이 있으면 현재 번호 보유자에게 노출하지 않는다',
    occurrences(search, 'rpc.old_phone8 = ca.owner_phone8') === 2
      && occurrences(reviewerRoutes, 'rpc.old_phone8 = ca.owner_phone8') === 5
      && /rpc\.old_phone8 = ca\.owner_phone8 AND rpc\.reviewer_id <> \$1/.test(search)
      && /rpc\.old_phone8 = ca\.owner_phone8 AND rpc\.reviewer_id <> \$3/.test(search)
      && /rpc\.old_phone8 = ca\.owner_phone8[\s\S]{0,100}\$2::uuid IS NULL OR rpc\.reviewer_id <> \$2/.test(reviewerRoutes)
      && /rpc\.old_phone8 = ca\.owner_phone8[\s\S]{0,100}\$3::uuid IS NULL OR rpc\.reviewer_id <> \$3/.test(reviewerRoutes)],
  ['주문 owner UUID가 있으면 충돌하는 신청 owner와 owner_phone8을 조회하지 않는다',
    /os\.owner_reviewer_id = \$1\s+OR \(os\.owner_reviewer_id IS NULL AND \(\s+ca\.owner_reviewer_id = \$1/.test(search)
      && /os\.owner_reviewer_id = \$3\s+OR \(os\.owner_reviewer_id IS NULL AND \(\s+ca\.owner_reviewer_id = \$3/.test(reviewerRoutes)
      && /ca\.owner_reviewer_id IS NULL AND ca\.owner_phone8 = ANY/.test(search)
      && /ca\.owner_reviewer_id IS NULL AND ca\.owner_phone8 = ANY/.test(reviewerRoutes)],
  ['참여현황 주문 보강도 owner UUID가 있으면 충돌하는 현재 번호로 가져오지 않는다',
    /\$2::uuid IS NULL AND RIGHT\(regexp_replace\(COALESCE\(os\.phone[\s\S]*OR os\.owner_reviewer_id = \$2[\s\S]*OR \(os\.owner_reviewer_id IS NULL[\s\S]*os\.phone/.test(reviewerRoutes)],
  ['동일 번호 등록 소유자가 여러 명이면 오래된 제출 링크 계좌도 사용하지 않는다',
    /ambiguousPhone8s\.has\(r\.phone8\)[\s\S]*\? null : ownerAcct/.test(payment)
      && /ownerIds\.size > 1[\s\S]*ambiguousPhone8s\.add/.test(payment)],
  ['입금은 코드 참여자 UUID로 현재 타계정 배열 위치를 찾아 이름·번호 변경을 견딘다',
    /member_no AS "memberNo"[\s\S]*FROM reviewer_identities/.test(payment)
      && /identityById\.get\(String\(link\.participantIdentityId\)\)/.test(payment)
      && /const sub = arr\[memberNo - 1\]/.test(payment)
      && /!participant\.ok\) \{ delete out\[k\]; continue; \}/.test(payment)],
  ['주문·신청 소유자가 충돌하면 신청 participant identity와 phone을 주문 소유자에 섞지 않는다',
    /CASE WHEN os\.owner_reviewer_id IS NULL OR os\.owner_reviewer_id = ca\.owner_reviewer_id[\s\S]*COALESCE\(os\.participant_identity_id, ca\.participant_identity_id\)[\s\S]*ELSE os\.participant_identity_id END/.test(payment)
      && /CASE WHEN os\.owner_reviewer_id IS NULL OR os\.owner_reviewer_id = ca\.owner_reviewer_id[\s\S]*THEN ca\.phone8 ELSE NULL END/.test(payment)],
  ['무시트 예상금액은 변경된 번호가 아니라 주문·참여행 좌표로 기존 카드와 중복 제거한다',
    /AND NOT EXISTS \([\s\S]*FROM review_index ri\s+WHERE \(\(ri\.sheet_id = os\.sheet_id[\s\S]*ri\.row_index = cp\.seq/.test(reviewerRoutes)
      && !/FROM review_index ri\s+WHERE ri\.phone8 = ANY\(\$1\)\s+AND \(\(ri\.sheet_id = os\.sheet_id/.test(reviewerRoutes)],
  ['레거시 링크 owner UUID는 이름 변경 뒤에도 이름 대조 없이 참여현황에 포함한다',
    /pl\.owner_reviewer_id = \$2\s+OR \(pl\.owner_reviewer_id IS NULL AND pl\.phone8 = ANY\(\$1\)[\s\S]*regexp_replace/.test(reviewerRoutes)],
  ['만료·위조 리뷰어 토큰은 참여현황과 예상금액 모두 401 코드로 응답한다',
    /function sendReviewerSessionError[\s\S]*REVIEWER_SESSION_EXPIRED[\s\S]*REVIEWER_AUTH_INVALID/.test(reviewerRoutes)
      && occurrences(reviewerRoutes, 'if (sendReviewerSessionError(res, err)) return;') === 2],
  ['현재 참여행 owner UUID는 충돌하는 과거 링크보다 우선한다',
    /cp\.owner_reviewer_id = \$1[\s\S]*cp\.owner_reviewer_id IS NULL/.test(search)
      && /cp\.owner_reviewer_id = \$3[\s\S]*cp\.owner_reviewer_id IS NULL/.test(reviewerRoutes)],
  ['링크 단독 입금은 타계정 이름을 추측하지 않고 소유자 본계좌를 쓴다',
    /for \(const x of viaLink\)[\s\S]{0,500}resolveParticipant\(owner, x, nameByRow\.get\(k\), false\)[\s\S]{0,180}pack\(owner, participant\.sub, 'owner_link', x\)/.test(payment)],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (ok) console.log('  ✓ ' + name);
  else { console.error('  ✗ ' + name); failed++; }
}
assert.strictEqual(failed, 0, `${failed} owner participation guard(s) failed`);
console.log(`✅ reviewerOwnerParticipation: ${checks.length}개 통과`);
