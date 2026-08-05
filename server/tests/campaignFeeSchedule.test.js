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
/* ★★ 제출 시각 컬럼은 `submitted_at` 이다 — `order_submissions` 에는 created_at 컬럼이
   **아예 없다**(001:179~192). 옛 가드는 `created_at AS "orderedAt"` 를 고정하고 있었는데,
   그건 42703 으로 이 쿼리를 통째로 죽이던 **버그 쪽 컬럼명**이었다(#488 에서 수정).
   그 쿼리 실패는 fail-soft catch 에 삼켜져 리뷰어 카드 상품비·누적 금액이 **조용히 비었다**.
   가드가 낡은 채로 남으면 다음 사람이 "테스트를 통과시키려고" 코드를 버그로 되돌린다. */
ok('주문 조회가 스냅샷·제출일을 함께 읽는다(행별 근거 확보)',
  /review_fee_snapshot AS "feeSnapshot"/.test(rev) && /submitted_at AS "orderedAt"/.test(rev));
ok('review_index 에서 시트 구매일자(start_date)를 읽는다',
  /start_date AS "startDate"/.test(rev));
ok('구간 조회 실패는 fail-soft — 리뷰 내역이 통째로 안 뜨는 일은 없다',
  /catch \(e\) \{ logger\.warn\('\[review-earnings\] 리뷰비 구간 조회 실패/.test(rev));
/* ── created_at 재발 차단(#488 사고) ─────────────────────────
   패턴만 고치면 "그 한 줄"만 지켜진다 → **전제와 전 소스**를 함께 고정한다:
     ① order_submissions 에 created_at 컬럼이 없다(마이그레이션에서 직접 읽어 확인)
     ② 그 테이블을 지목하는 SQL 어디에서도 created_at 을 쓰지 않는다(src 전체 스캔)
   ②는 별칭(os.created_at)과 단일 테이블 쿼리의 무수식 created_at 을 잡는다.
   다중 조인에서 **다른 테이블의** created_at 은 정상이므로 건드리지 않는다(오탐 회피). */
ok('★★ order_submissions 에는 created_at 컬럼이 없다 — 시각은 submitted_at 하나(전제 고정)',
  (() => {
    const init = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_create_tables.sql'), 'utf8');
    const m = /CREATE TABLE IF NOT EXISTS order_submissions \(([\s\S]*?)\n\);/.exec(init);
    if (!m || !/\bsubmitted_at\b/.test(m[1]) || /\bcreated_at\b/.test(m[1])) return false;
    // 뒤 마이그레이션이 ALTER 로 몰래 추가하지도 않았는지
    const dir = path.join(__dirname, '..', 'migrations');
    return !fs.readdirSync(dir).filter(f => f.endsWith('.sql')).some(f =>
      /ALTER TABLE\s+order_submissions[\s\S]{0,300}?ADD COLUMN[^;]*\bcreated_at\b/i
        .test(fs.readFileSync(path.join(dir, f), 'utf8')));
  })());
ok('★★ order_submissions 를 읽는 SQL 어디에도 created_at 이 없다(전 소스 스캔 — 같은 사고 재발 차단)',
  (() => {
    const KW = new Set(['set', 'where', 'values', 'on', 'using', 'as', 'order', 'group', 'limit',
      'left', 'right', 'inner', 'join', 'select', 'returning']);
    const NUL = String.fromCharCode(0);   // NUL 이 있는 파일도 읽어 검사한다(grep 과 달리 안 막힌다)
    const walk = (d, a = []) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name);
        e.isDirectory() ? walk(q, a) : (q.endsWith('.js') && a.push(q));
      }
      return a;
    };
    return walk(path.join(__dirname, '..', 'src')).every(f => {
      const src = fs.readFileSync(f, 'utf8').split(NUL).join('');
      return (src.match(/`[^`]*`/g) || []).every(lit => {
        if (!/\border_submissions\b/i.test(lit)) return true;
        const m = /order_submissions\s+(?:AS\s+)?([a-zA-Z]\w*)/i.exec(lit);
        const alias = m && !KW.has(m[1].toLowerCase()) ? m[1] : null;
        if (alias && new RegExp('\\b' + alias + '\\.created_at\\b', 'i').test(lit)) return false;
        const tables = (lit.match(/\b(?:FROM|JOIN)\s+\w+/gi) || []).length;
        return !(tables <= 1 && /(?<![.\w])created_at\b/.test(lit));
      });
    });
  })());

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
  && /_listCache = \{ at: now\.getTime\(\), rows, countsMap, optionsMap, feeMap/.test(camp));   // crMap 등 뒤 필드 추가 허용(검사 의미 = feeMap 이 목록 캐시에 실림)
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

/* ══ ⑥ FK 타입 정합 — 이 가드가 없어서 실제로 사고가 났다(2026-08) ══
 *  082 가 campaign_id 를 UUID 로 선언했는데 recruit_campaigns.id 는 TEXT 라
 *  PG 가 42804 로 FK 생성을 거부 → 러너의 암묵 트랜잭션에서 **파일 전체 롤백**
 *  → ADD COLUMN review_fee_snapshot 2 개가 영영 안 생겼고, 42804 는 DUP 코드가
 *  아니라 _migrations 에도 미기록 → 배포마다 재시도·매번 실패인데 **서버는 정상 부팅**.
 *  결과 = 리뷰어 [참여하기] 전면 42703. 종전 가드는 REFERENCES **문자열만** 봐서 통과했다.
 *  → 문자열이 아니라 **타입을 참조 대상에서 읽어 대조**한다(전 마이그레이션 대상). */
const migDir = path.join(__dirname, '..', 'migrations');
const allMig = fs.readdirSync(migDir).filter(f => f.endsWith('.sql'))
  .map(f => ({ f, sql: fs.readFileSync(path.join(migDir, f), 'utf8') }));
const stripComments = (s) => s.replace(/--[^\n]*/g, '');

// recruit_campaigns.id 의 실제 선언 타입(하드코딩 금지 — 018 이 바뀌면 기대값도 따라가야 한다)
const campIdType = (() => {
  for (const { sql } of allMig) {
    const m = stripComments(sql).match(/CREATE TABLE (?:IF NOT EXISTS )?recruit_campaigns\s*\(([\s\S]*?)\n\s*\);/);
    if (!m) continue;
    const col = m[1].split('\n').map(s => s.trim()).find(s => /^id\s+\w/i.test(s));
    if (col) return col.split(/\s+/)[1].toUpperCase();
  }
  return null;
})();
ok('recruit_campaigns.id 선언 타입을 마이그레이션에서 읽어낸다(가드 자체가 살아 있는지)',
  campIdType === 'TEXT');

// 전 마이그레이션에서 recruit_campaigns(id) 를 참조하는 컬럼의 선언 타입을 모은다
const fkRefs = [];
for (const { f, sql } of allMig) {
  const re = /^\s*(\w+)\s+(\w+)[^\n]*REFERENCES\s+recruit_campaigns\s*\(\s*id\s*\)/gim;
  let m;
  while ((m = re.exec(stripComments(sql)))) fkRefs.push({ file: f, col: m[1], type: m[2].toUpperCase() });
}
ok('★★ recruit_campaigns(id) 참조 컬럼은 전부 참조 대상과 같은 타입 — 하나라도 다르면 그 파일 전체가 롤백된다',
  fkRefs.length >= 3 && fkRefs.every(r => r.type === campIdType),
  );
ok('082 의 campaign_id 도 TEXT(사고 당사자 — 되돌리지 말 것)',
  fkRefs.some(r => r.file.startsWith('082') && r.type === 'TEXT')
  && !/campaign_id\s+UUID/i.test(stripComments(mig)));

/* ══ ⑦ 부팅 프리플라이트 — "서버는 멀쩡한데 참여만 조용히 안 되는" 상태 차단 ══ */
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const reqBlock = (idx.match(/const REQUIRED_SCHEMA = \[([\s\S]*?)\];/) || [, ''])[1];
ok('★ REQUIRED_SCHEMA 에 campaign_applications.review_fee_snapshot 등록(없으면 apply 전면 42703)',
  /\['campaign_applications',\s*'review_fee_snapshot'\]/.test(reqBlock));
ok('★ REQUIRED_SCHEMA 에 order_submissions.review_fee_snapshot 등록(없으면 금액이 조용히 0원)',
  /\['order_submissions',\s*'review_fee_snapshot'\]/.test(reqBlock));

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
ok('구간 CSS 변수에 폴백이 있다(admin 테마 없는 리뷰웹시스템[3버전]에서도 테두리가 산다)',
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
