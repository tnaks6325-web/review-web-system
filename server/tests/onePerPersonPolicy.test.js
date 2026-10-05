/**
 * onePerPersonPolicy.test.js — 공고 참여 방식 = 「1인 1회」/「타계정 허용」 두 가지 (사용자 확정 2026-10-05)
 *
 * 사고(박윤미 건): 같은 번호 타계정 이름으로 로그인한 리뷰어가 「타계정 금지」 공고에 참여는 통과(번호로
 *   본인 판정)했는데, 구매양식 제출에서 이름으로 다시 찾아 "타계정"으로 막혀 결제 후 자리가 만료됐다.
 * 고정:
 *   [1] 「타계정 금지」 폐지 — 1인 1회(false)도 타계정 이름 참여 허용, 제출 단계는 막지 않는다
 *   [2] 1인 1회 게이트 — 소유자 기준 다른 명의의 진행 중·기간 내 제출이 있으면 참여 단계에서 막는다(fail-open)
 *   [3] 재참여 상태 — 1인 1회는 전 명의를 보고, 한 명의가 잠기면 나머지도 잠근다
 *   [4] 화면 — 관리자 「참여 방식: 1인 1회 / 타계정 허용」, 리뷰어 명의 고르기 공통
 */
'use strict';
const fs = require('fs');
const path = require('path');
let failed = 0, n = 0;
const ok = (m, c) => { n++; if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const routes = rd('src', 'routes', 'campaign.routes.js');
const ident = rd('src', 'services', 'reviewerOrderIdentity.service.js');
const camp = rd('..', 'frontend', 'campaign.html');
const modal = rd('..', 'frontend', 'js', 'recruit-modal.js');
const wd = rd('..', 'frontend', 'workdesk.html');

console.log('[1] 타계정 금지 폐지');
ok('참여 단계에 multi_disabled 거절이 없다', !/reason: 'multi_disabled'/.test(routes));
ok('제출 단계가 공고 설정으로 타계정을 막지 않는다', !/selected\.type === 'sub' && !app\.multi_account_mode/.test(ident));
ok('타계정 하루 한도는 타계정 허용 공고에만', /if \(isSubApply && !onePerPerson && Number\(camp\.multi_daily_limit\) > 0\)/.test(routes));

console.log('[2] 1인 1회 게이트');
const i = routes.indexOf('if (onePerPerson) {');
const g = routes.slice(i, routes.indexOf('// ★ 재참여(재구매) 기간 제한', i));
ok('판정 = multi_account_mode !== true', /const onePerPerson = camp\.multi_account_mode !== true;/.test(routes));
ok('소유자 기준 · 다른 명의만', /phone8 <> \$3/.test(g) && /\(COALESCE\(owner_phone8, phone8\) = \$2 OR owner_reviewer_id = \$4::uuid\)/.test(g) && /\[id, p8, holdP8, reg\.rows\[0\]\.id\]/.test(g));
ok('진행 중(유효 홀드·블로그 대기)은 막는다', /status = 'applied' AND expires_at > NOW\(\)/.test(g) && /status = 'blog_pending'/.test(g) && /let blocked = o\.status !== 'submitted'/.test(g));
ok('제출완료는 같은 명의와 같은 재참여 기간으로 판정', /repurchaseWindowFromSubmittedAt\(o\.submitted_at, camp\.repurchase_days/.test(g));
ok('취소된 주문은 세지 않는다', /os1\.deleted_at IS NULL/.test(g));
ok('SAVEPOINT 격리 + fail-open', /SAVEPOINT one_per_person/.test(g) && /ROLLBACK TO SAVEPOINT one_per_person/.test(g) && /fail-open/.test(g));
ok('사유 one_per_person 으로 409', /reason: 'one_per_person'/.test(g));
ok('게이트는 재참여 기간 판정보다 앞(홀드 생성 전 = 자리 미점유)', i > 0 && i < routes.indexOf("reason: 'repurchase_window'"));

console.log('[3] 재참여 상태');
ok('1인 1회도 전 명의를 본다', !/setting\.multiAccountMode \? historyAccounts : historyAccounts\.filter/.test(routes));
ok('한 명의가 잠기면 나머지 ready 도 잠근다', /if \(!setting\.multiAccountMode\) \{\s*const lockedOne = states\.find\(a => a\.status === 'locked'\)/.test(routes));
ok('신원 미확인(unknown) 명의도 함께 잠근다', /states\.map\(a => \(a\.status === 'ready' \|\| a\.status === 'unknown'\)/.test(routes));

console.log('[4] 화면');
ok('관리자: 참여 방식 = 1인 1회 / 타계정 허용', /<span class="form-label">참여 방식<\/span>/.test(modal) && />1인 1회<\/button>/.test(modal) && />타계정 허용<\/button>/.test(modal) && !/>미허용<\/button>/.test(modal));
ok('작업보드 작업 조건 표기', /\['참여 방식','camp'/.test(wd) && /:'1인 1회'\)\]/.test(wd));
ok('리뷰어: 명의 고르기 공통 · 추가참여는 타계정 허용만', /if\(acctChoiceEnabled\(\)\) \{/.test(camp) && /addBtn\.style\.display = \(multiEnabled\(\) &&/.test(camp));
ok('리뷰어: 1인 1회 안내 문구', /이 공고는 <b>1인 1회<\/b>예요/.test(camp));

console.log(`\n${failed ? '❌' : '✅'} onePerPersonPolicy: ${n - failed}/${n}`);
process.exit(failed ? 1 : 0);
