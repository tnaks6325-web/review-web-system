/**
 * campaignHoldGuards.test.js — 참여형 홀드 방어 구조 회귀가드 (레드-블루-심판 최종안 고정)
 * 실행: node tests/campaignHoldGuards.test.js
 * 방식: 소스 grep (driveLaneCallsites 스타일 — DB/서버 기동 불필요)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const mig = read('migrations/045_reviewer_participation.sql');
const routes = read('src/routes/campaign.routes.js');
const hold = read('src/services/campaignHold.service.js');
const ledger = read('src/services/orderLedger.service.js');
const rl = read('src/middleware/rateLimit.middleware.js');
const state = read('src/services/campaignState.service.js');
const appJs = read('src/app.js');
const rejoinMigration = read('migrations/113_campaign_expired_hold_rejoin.sql');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// 심판 J1: order_submissions.id=UUID — BIGINT 링크 금지
ok('045: order_submission_id UUID', /order_submission_id UUID/.test(mig));
ok('045: late_order_id UUID', /late_order_id\s+UUID/.test(mig));
ok('045: hold_token 기본값 없음(NULL — 빈문자 매칭함정 금지)', !/hold_token\s+TEXT\s+DEFAULT/.test(mig));
// 레드 #1: 레거시(confirmed) 부분 유니크 복원 — 구 UNIQUE DROP의 동시성 방어 회귀 차단
ok('045: uq_campaign_apps_legacy(confirmed) 존재', /uq_campaign_apps_legacy[\s\S]*?WHERE status = 'confirmed'/.test(mig));
ok('045: submitted_at CHECK 존재(분모 오염 → 시끄러운 에러)', /campaign_apps_submitted_at_check/.test(mig));
ok('045: 스윕 부분 인덱스 존재', /idx_campaign_apps_sweep[\s\S]*?WHERE status = 'applied'/.test(mig));
// 레드 #3: apply 잠금 계층(캠페인 행 직렬화 → write-skew 차단)
ok('apply: 캠페인 행 FOR UPDATE', /_applyParticipation[\s\S]*?FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(routes));
ok('apply: phone8 advisory xact lock', /pg_advisory_xact_lock\(hashtext\('camp_hold_phone:/.test(routes));
// 공유 작업표의 재발행 공고끼리도 일일 정원 판정을 직렬화한다. PostgreSQL text에는
// NUL(0x00)을 넣을 수 없으므로, 두 int-key advisory lock으로 식별한다.
const tabDailyLockStart = routes.indexOf("pg_advisory_xact_lock(hashtext('camp_tab_daily:'");
const tabDailyLock = tabDailyLockStart < 0 ? '' : routes.slice(tabDailyLockStart, tabDailyLockStart + 260);
ok('apply: 공유 작업표 일일 정원 advisory lock',
  tabDailyLock.includes("pg_advisory_xact_lock(hashtext('camp_tab_daily:' || $1::text), hashtext($2::text))"));
ok('apply: 작업표 잠금 SQL에 NUL 구분자를 만들지 않음',
  !tabDailyLock.includes("E'\\\\000'") && !tabDailyLock.includes('\u0000'));
ok('apply: 23505 백스톱(duplicate_hold)', /duplicate_hold/.test(routes));
ok('apply: 재참여 전 만료 applied 홀드를 같은 grace 경계로 정리',
  /UPDATE campaign_applications[\s\S]*?SET status = 'expired'[\s\S]*?expires_at <= NOW\(\) - make_interval[\s\S]*?HOLD_GRACE_SEC/.test(routes));
ok('113: 중복 인덱스는 살아 있는 applied 홀드만 보호',
  /DROP INDEX IF EXISTS uq_campaign_apps_active_hold[\s\S]*?WHERE status = 'applied'/.test(rejoinMigration));
ok('apply: 미제출 홀드는 당일 제한에 미포함(제출완료만 차단)',
  /status = 'submitted'/.test(routes) && /today_submitted/.test(routes) && !/already_today/.test(routes));
// 레드 #5·심판 J2: 확정과 스윕의 grace 경계 단일 출처 + SAVEPOINT 격리(주문 손실 0)
ok('hold: HOLD_GRACE_SEC 단일 정의', (hold.match(/const HOLD_GRACE_SEC = /g) || []).length === 1);
ok('hold: confirm은 applied+grace 경계', /status = 'applied'[\s\S]*?expires_at > NOW\(\) - make_interval/.test(hold));
ok('hold: sweep SKIP LOCKED(확정 tx와 교착 0)', /FOR UPDATE SKIP LOCKED/.test(hold));
ok('ledger: SAVEPOINT hold_confirm(주문 손실 0)', /SAVEPOINT hold_confirm/.test(ledger) && /ROLLBACK TO SAVEPOINT hold_confirm/.test(ledger));
ok('ledger: 비참여 경로 무트랜잭션 유지', /비참여 주문: 기존 경로 그대로/.test(ledger));
// 레드 #2: 공개 화이트리스트에 비밀 필드 부재
{
  const m = routes.match(/PUBLIC_FIELDS_PARTICIPATION = \[[\s\S]*?\];/);
  for (const secret of ['work_detail', 'chat_url', 'landing_url', 'recruit_total', 'max_slots', 'current_slots', 'notes', 'description']) {
    ok(`publicFields(참여형): ${secret} 미포함`, m && !m[0].includes(`'${secret}'`));
  }
}
// 레드 #11: work-detail·cancel 게이트에 hold_token 빈값 벨트
ok('work-detail: hold_token <> \'\' 벨트', /work-detail[\s\S]{0,2000}hold_token = \$3 AND hold_token <> ''/.test(routes));
// 심판 J4: 전역 리미터 skip은 baseUrl+path 판정(마운트 스트리핑 함정)
ok('rateLimit: baseUrl+path 판정', /req\.baseUrl/.test(rl));
// 레드 #4: trust proxy 1홉(공용버킷 방지) + 참여 리미터 phone8 키
ok('app: trust proxy 설정', /app\.set\('trust proxy', 1\)/.test(appJs));
ok('routes: 리미터 phone8 keyGenerator', /keyGenerator: _p8Key/.test(routes));
// 레드 #10: 24:00 허용 + window_invalid 신호
ok("state: '24:00' → 1440", /hh === 24 && mm === 0/.test(state));
ok("state: stateReason 'window_invalid'", /window_invalid/.test(state));
// 심판 J7: COALESCE 편집 활성화 우회 차단(양 라우트 게이트)
ok('활성화 게이트: 2개 라우트 적용', (routes.match(/_participationActivationErrors\(/g) || []).length >= 3); // 정의 1 + 호출 2
// 레드 #7: 수동확정 선-취소 + 이중확정 거부
ok('수동확정: applied 선-취소', /admin\/:id\/confirm[\s\S]*?SET status = 'cancelled'\s+WHERE campaign_id = \$1 AND phone8 = \$2 AND id <> \$3 AND status = 'applied'/.test(routes));
// 코드리뷰 #1: provenance 링크는 소유권(campaign+phone8+holdToken) 검증 통과 신청에만 — 위조 applicationId 오염 차단
// ★ 082: 참여 시점 리뷰비 스냅샷을 함께 전파하려고 EXISTS 서브쿼리 → FROM 조인으로 바꿨다.
//   검사 의미는 그대로 — **소유권 3조건(campaign_id·phone8·hold_token)** 이 링크의 전제여야 한다.
ok('provenance: 소유권(campaign+phone8+holdToken) 검증 통과 신청에만 링크',
  /SET campaign_application_id = ca\.id[\s\S]*?FROM campaign_applications ca[\s\S]*?ca\.campaign_id = \$3 AND ca\.phone8 = \$4[\s\S]*?ca\.hold_token = \$5/.test(hold));
// 코드리뷰 #6: env NaN 가드
ok('grace: NaN 폴백 30', /Number\.isFinite\(_grace\)/.test(hold));
// 레드 #8③: closed 영속 3소비처(자동확정·수동확정·스윕)
ok('closed 영속: confirmHoldInTx → maybePersistClosed', /maybePersistClosed\(client, campaignId\)/.test(hold));
ok('closed 영속: 수동확정 → maybePersistClosed', /maybePersistClosed\(client, id\)/.test(routes));
ok('closed 영속: 스윕 백스톱', /closed 영속 백스톱/.test(hold));

console.log(`\n✅ campaignHoldGuards: ${passed}개 통과`);
