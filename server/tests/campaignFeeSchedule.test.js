/**
 * campaignFeeSchedule.test.js — 캠페인 기간별 리뷰비(082) 회귀가드.
 *
 * 막으려는 사고(2026-08 실측): 리뷰비를 1,000 → 1,500 으로 올리자
 *   **7월 참여자의 리뷰 내역 카드·누적 합계까지** 1,500원이 되어 문의가 발생했다.
 *
 * 고정하는 것
 *   ① 판정 순수함수 실행 — 스냅샷 최우선 · 날짜별 구간 · 구간 0개면 기존 값(무회귀)
 *   ② 리뷰 내역 API 가 **건별로** 판정한다(공고의 현재 값 일괄 적용 금지)
 *   ③ 참여(홀드) 시점에 금액을 새기고, 주문 원장으로 전파한다
 *   ④ 구간 저장은 배열 전달 시에만(미전달=유지), 잠금 계층은 옵션 저장과 동일
 *   ⑤ 프론트 배선(구간표 UI·프리필·저장 payload)
 *
 * 실행: node tests/campaignFeeSchedule.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const fee = require('../src/utils/campaignFee');
const camp = readS('routes/campaign.routes.js');
const rev = readS('routes/reviewer.routes.js');
const hold = readS('services/campaignHold.service.js');
const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '082_campaign_fee_schedules.sql'), 'utf8');
const modal = readF('js/recruit-modal.js');
const rec = readF('js/index-recruit.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ══ ① 판정 순수함수 — 사고 시나리오 그대로 ══ */
const SCHED = [
  { effectiveFrom: '2026-07-01', reviewFee: 1000 },
  { effectiveFrom: '2026-08-01', reviewFee: 1500 },
];

ok('7월 참여 건은 1,000원 — 8월 인상과 무관(이 사고의 본체)',
  fee.resolveReviewFee({ schedules: SCHED, fallback: 1500, orderDate: '2026-07-18' }).fee === 1000);
ok('8월 참여 건은 1,500원',
  fee.resolveReviewFee({ schedules: SCHED, fallback: 1500, orderDate: '2026-08-04' }).fee === 1500);
ok('구간 경계 당일(8/1)은 새 금액 — 시작일 포함',
  fee.resolveReviewFee({ schedules: SCHED, fallback: 0, orderDate: '2026-08-01' }).fee === 1500);
ok('구간 마지막 날(7/31)은 옛 금액',
  fee.resolveReviewFee({ schedules: SCHED, fallback: 0, orderDate: '2026-07-31' }).fee === 1000);

ok('★ 스냅샷이 있으면 무조건 스냅샷 — 구간표를 고쳐도 이미 참여한 건은 불변',
  fee.resolveReviewFee({ schedules: SCHED, fallback: 1500, snapshot: 1000, orderDate: '2026-08-04' }).fee === 1000
  && fee.resolveReviewFee({ schedules: SCHED, fallback: 1500, snapshot: 1000 }).source === 'snapshot');
ok('스냅샷 0원도 유효값 — 0을 "없음"으로 접으면 무상 건이 유상으로 바뀐다',
  fee.resolveReviewFee({ schedules: SCHED, fallback: 1500, snapshot: 0 }).fee === 0);

ok('★ 구간이 0개면 기존 review_fee 그대로 = 현재 동작 무회귀(opt-in)',
  fee.resolveReviewFee({ schedules: [], fallback: 2500, orderDate: '2026-07-18' }).fee === 2500
  && fee.resolveReviewFee({ fallback: 2500 }).source === 'fallback');
ok('첫 구간보다 이른 날짜는 폴백 + 사유 표기(조용한 0원 금지)',
  (() => { const r = fee.resolveReviewFee({ schedules: SCHED, fallback: 2500, orderDate: '2026-06-30' });
    return r.fee === 2500 && r.source === 'fallback_before_first'; })());

ok('기준일 우선순위 = 참여 스냅샷 → 주문일 → 시트 구매일자 → 오늘',
  fee.resolveReviewFee({ schedules: SCHED, fallback: 0, orderDate: '2026-08-04', sheetDate: '2026-07-10' }).fee === 1500
  && fee.resolveReviewFee({ schedules: SCHED, fallback: 0, sheetDate: '2026-07-10' }).fee === 1000
  && fee.resolveReviewFee({ schedules: SCHED, fallback: 0, today: '2026-08-04' }).fee === 1500);

ok('구간 정규화: 형식 오류·빈 금액은 버리고 시작일 오름차순 정렬',
  (() => {
    const out = fee.normalizeFeeSchedules([
      { effectiveFrom: '2026-08-01', reviewFee: 1500 },
      { effectiveFrom: '2026-7-1', reviewFee: 900 },       // 형식 오류 → 제외
      { effectiveFrom: '2026-07-01', reviewFee: 1000 },
      { effectiveFrom: '2026-09-01', reviewFee: '' },       // 금액 없음 → 제외
    ]);
    return out.length === 2 && out[0].effectiveFrom === '2026-07-01' && out[1].reviewFee === 1500;
  })());
ok('미전달(배열 아님)은 null = 변경 없음(옵션표와 같은 계약)',
  fee.normalizeFeeSchedules(undefined) === null && fee.normalizeFeeSchedules(null) === null);
ok('같은 날짜 중복은 뒤엣것 하나로 접힌다(DB UNIQUE 위반으로 500 나지 않게)',
  fee.normalizeFeeSchedules([
    { effectiveFrom: '2026-07-01', reviewFee: 1000 },
    { effectiveFrom: '2026-07-01', reviewFee: 1200 },
  ]).length === 1);

ok('시트 구매일자 파싱: 연도 없는 표기는 앵커로 추론, 실패는 null(억지 판정 금지)',
  fee.sheetDateToIso('7 / 18 (금)', '2026-07-01') === '2026-07-18'
  && fee.sheetDateToIso('26.7.28(화)', '2026-07-01') === '2026-07-28'
  && fee.sheetDateToIso('미정', '2026-07-01') === null
  && fee.sheetDateToIso('', '2026-07-01') === null);

ok('킬스위치 CAMPAIGN_FEE_SCHEDULE=0 → 전건 기존 review_fee 로 즉시 복귀',
  (() => {
    process.env.CAMPAIGN_FEE_SCHEDULE = '0';
    const off = fee.resolveReviewFee({ schedules: SCHED, fallback: 2500, orderDate: '2026-07-18' }).fee;
    delete process.env.CAMPAIGN_FEE_SCHEDULE;
    const on = fee.resolveReviewFee({ schedules: SCHED, fallback: 2500, orderDate: '2026-07-18' }).fee;
    return off === 2500 && on === 1000;
  })());

ok('currentReviewFee = 오늘 기준 구간(카드·목록 표시용)',
  fee.currentReviewFee(SCHED, 999, new Date('2026-08-04T01:00:00Z')) === 1500
  && fee.currentReviewFee([], 999, new Date('2026-08-04T01:00:00Z')) === 999);
ok('KST 기준 날짜 — UTC 로 판정하면 자정~09시 참여가 전날 구간에 들어간다',
  fee.kstDateStr(new Date('2026-08-01T00:30:00Z')) === '2026-08-01'   // KST 09:30
  && fee.kstDateStr(new Date('2026-07-31T23:00:00Z')) === '2026-08-01'); // KST 익일 08:00

/* ══ ② 리뷰 내역 API — 건별 판정 ══ */
ok('리뷰비 판정은 단일 출처 유틸만 부른다(화면별 사본 금지)',
  /require\('\.\.\/utils\/campaignFee'\)/.test(rev) && /resolveReviewFee\(\{/.test(rev));
ok('★ 공고의 현재 review_fee 를 전건에 일괄 적용하던 코드가 사라졌다',
  !/const reviewFee = camp\.reviewFee \|\| 0;/.test(rev));
ok('건별 근거를 전부 넘긴다(스냅샷·주문일·시트 구매일자)',
  /snapshot: of\.snapshot/.test(rev) && /orderDate: of\.orderDate/.test(rev)
  && /sheetDate: sheetDateToIso\(r\.startDate/.test(rev));
ok('주문 조회가 스냅샷·제출일을 함께 읽는다(행별 근거 확보)',
  /review_fee_snapshot AS "feeSnapshot"/.test(rev) && /created_at AS "orderedAt"/.test(rev));
ok('review_index 에서 시트 구매일자(start_date)를 읽는다',
  /start_date AS "startDate"/.test(rev));
ok('구간 조회 실패는 fail-soft — 리뷰 내역이 통째로 안 뜨는 일은 없다',
  /catch \(e\) \{ logger\.warn\('\[review-earnings\] 리뷰비 구간 조회 실패/.test(rev));
ok('신청 이력 API 도 참여 시점 금액 우선',
  /COALESCE\(ca\.review_fee_snapshot, rc\.review_fee\) AS "reviewFee"/.test(rev));

/* ══ ③ 스냅샷 기록·전파 ══ */
ok('참여(홀드) INSERT 에 review_fee_snapshot 을 함께 기록한다',
  /INSERT INTO campaign_applications[\s\S]{0,300}review_fee_snapshot/.test(camp)
  && /feeSnapshot = currentReviewFee\(sched, camp\.review_fee, now\)/.test(camp));
ok('★ 스냅샷 조회는 SAVEPOINT 로 격리 — tx 안의 쿼리 하나가 실패하면 PG 는 tx 전체를 abort(25P02) 하므로,'
  + ' 격리가 없으면 구간 조회 실패가 참여 INSERT 를 통째로 죽인다(진짜 PG로 재현·확인)',
  /SAVEPOINT fee_snap/.test(camp) && /ROLLBACK TO SAVEPOINT fee_snap/.test(camp)
  && /RELEASE SAVEPOINT fee_snap/.test(camp));
ok('스냅샷 조회 실패는 null 폴백 = 날짜 기준 판정으로 수렴(참여를 막지 않는다)',
  /feeSnapshot = null;\s*\n\s*try \{ await client\.query\('ROLLBACK TO SAVEPOINT fee_snap'\)/.test(camp));
ok('홀드 확정 시 주문 원장으로 전파 — 있는 값은 안 덮는다(COALESCE)',
  /review_fee_snapshot = COALESCE\(os\.review_fee_snapshot, ca\.review_fee_snapshot\)/.test(hold));
ok('전파 쿼리의 소유권 검증(campaign_id·phone8·hold_token)은 그대로다',
  /ca\.id = \$2 AND ca\.campaign_id = \$3 AND ca\.phone8 = \$4/.test(hold)
  && /ca\.hold_token = \$5 AND ca\.hold_token <> ''/.test(hold));

/* ══ ④ 구간 저장 ══ */
ok('구간 저장은 배열 전달 시에만(미전달=기존 구간 유지)',
  /if \(!Array\.isArray\(schedules\)\) return;/.test(camp)
  && /const normFees = normalizeFeeSchedules\(fee_schedules\);/.test(camp));
ok('저장은 캠페인 행 FOR UPDATE 안에서 — apply 와 같은 잠금 계층(중간 상태 관측 차단)',
  /_saveFeeSchedules[\s\S]{0,600}SELECT id FROM recruit_campaigns WHERE id=\$1 FOR UPDATE/.test(camp));
ok('구간 저장 실패가 공고 저장을 통째로 막지 않는다(경고 표면화)',
  /feeWarning = '리뷰비 구간 저장 실패: '/.test(camp) && /\.\.\.\(feeWarning \? \{ feeWarning \} : \{\}\)/.test(camp));
ok('관리자 상세 응답에 구간 동봉(수정 모달 프리필)',
  /feeSchedules: await _loadFeeSchedules\(pool, id\)/.test(camp));
ok('목록·상세의 카드 리뷰비는 오늘 구간으로 표시(카드와 참여 화면 불일치 차단)',
  /_applyCurrentFee\(view, feeMap && feeMap\.get\(r\.id\), now\)/.test(camp)
  && /_applyCurrentFee\(view, await _loadFeeSchedules\(pool, id\), now\)/.test(camp));
ok('목록 구간 조회는 배치 1쿼리 + 목록 캐시에 실려 상각된다',
  /_fetchFeeSchedulesFor\(pool, rows\.map\(r => r\.id\)\)/.test(camp)
  && /_listCache = \{ at: now\.getTime\(\), rows, countsMap, optionsMap, feeMap \}/.test(camp));
ok('구간 조회 실패는 [] 폴백(fail-soft) — 공고 목록이 죽지 않는다',
  /async function _loadFeeSchedules[\s\S]{0,600}catch \(_\) \{\s*\n\s*return \[\];/.test(camp));

/* ══ 마이그레이션 ══ */
ok('신규 테이블 + 컬럼 추가만(파괴적 변경 없음)',
  /CREATE TABLE IF NOT EXISTS campaign_fee_schedules/.test(mig)
  && /ADD COLUMN IF NOT EXISTS review_fee_snapshot INTEGER/.test(mig)
  && !/DROP (TABLE|COLUMN)/.test(mig));
ok('★ 종료일 컬럼 없음 — 시작일만 받아 빈틈·겹침을 구조적으로 막는다',
  !/effective_to|end_date/.test(mig));
ok('같은 날 두 금액은 DB 가 막는다(UNIQUE)',
  /UNIQUE \(campaign_id, effective_from\)/.test(mig));
ok('공고 삭제 시 구간도 함께 정리(고아 행 방지)',
  /REFERENCES recruit_campaigns\(id\) ON DELETE CASCADE/.test(mig));

/* ══ ⑤ 프론트 배선 ══ */
ok('모달에 구간표 UI(스위치·행 컨테이너·자동점검)가 있다',
  /id="rf_fee_sched_on"/.test(modal) && /id="rf_fee_rows"/.test(modal)
  && /id="rf_fee_check"/.test(modal) && /id="rf_fee_summary"/.test(modal));
ok('기존 리뷰비 입력(rf_review_fee)은 그대로 살아 있다 — 구간 미사용 공고 동작 불변',
  /id="rf_review_fee"/.test(modal));
ok('구간표에 종료일 입력칸이 없다(서버 모델과 1:1 — 빈틈·겹침 원천 차단)',
  (() => {
    // 구간표 블록만 잘라 본다(모달 전체엔 공고 '종료일'(rf_deadline)이 정상적으로 존재한다)
    const i = modal.indexOf('rf-fee-head');
    const j = modal.indexOf('rf_fee_check');
    const block = i >= 0 && j > i ? modal.slice(i, j) : '';
    return !!block && !/rf_fee_to|종료일/.test(block);
  })());
ok('모달 CSS 는 #recruitModal 로 스코프된다(호스트 화면 오염 금지)',
  /#recruitModal \.rf-fee-box\{/.test(modal) && /#recruitModal \.rf-fee-row\{/.test(modal));
ok('구간 CSS 변수에 폴백이 있다(admin 테마 없는 통합 작업대에서도 테두리가 산다)',
  /#recruitModal \.rf-fee-head\{[^}]*var\(--t3,#94A3B8\)/.test(modal));

ok('행 추가·읽기·렌더·점검 함수가 전부 있다',
  /function addFeeRow\(/.test(rec) && /function readFeeRows\(/.test(rec)
  && /function renderFeeRows\(/.test(rec) && /function renderFeeSchedule\(/.test(rec)
  && /function onFeeScheduleToggle\(/.test(rec));
ok('신규 공고는 구간이 항상 비어 시작한다(이전 편집값 누수 금지)',
  /renderFeeRows\(\[\]\);\s*\/\/ 📅 기간별 리뷰비 초기화\(082\)/.test(rec));
ok('수정 모달은 서버 구간으로 프리필한다',
  /renderFeeRows\(json\.feeSchedules \|\| \[\]\)/.test(rec));
ok('★ 구간표 UI 가 있는 화면에서만 전송 — 축약 화면 저장이 구간을 지우지 않는다',
  /if \(document\.getElementById\("rf_fee_rows"\)\) \{[\s\S]{0,400}payload\.fee_schedules/.test(rec));
ok('스위치를 끄면 빈 배열 전송 = 구간 제거(기본 리뷰비로 복귀)',
  /payload\.fee_schedules = document\.getElementById\("rf_fee_sched_on"\)\?\.checked \? readFeeRows\(\) : \[\]/.test(rec));
ok('시작일 중복은 저장 전에 막는다(서버 UNIQUE 위반 전에 사람 말로 안내)',
  /_feeChk\.dup.*\n?.*리뷰비 구간의 시작일이 중복/.test(rec) || /if \(_feeChk\.dup\)/.test(rec));
ok('카드 미리보기도 오늘 구간 금액을 쓴다(모달 미리보기 ≠ 실제 카드 방지)',
  /review_fee: _feePreviewToday\(/.test(rec));
ok('오늘 판정은 KST — 프론트도 서버와 같은 기준',
  /Date\.now\(\) \+ 9 \* 3600 \* 1000/.test(rec));
ok('참여 시점 고정을 관리자에게 화면에서 알린다(조용한 소급 변경 오해 방지)',
  /영구 고정/.test(rec));

console.log('\n✅ campaignFeeSchedule: ' + n + ' cases passed');
