/**
 * searchByName includeSubmitted 보안 가드 회귀 테스트
 *   리뷰어 홈 "제출대기/제출완료" 탭용 includeSubmitted 옵션이:
 *   1) 미지정 시 기존과 동일한 쿼리(is_submitted=FALSE, LIMIT 200)를 유지하고
 *   2) 지정 시에도 제출완료 행은 강한 신원키(phone8/participation_links 정확 일치)로만 열리며
 *   3) 이름 단독 검색(무인증 이름 스크래핑 벡터)에서는 항상 무시되고
 *   4) 제출완료 행의 row(행 전체 JSON)는 비워 반환(데이터 최소화)하는지 고정한다.
 * 실행: node tests/searchSubmittedGuard.test.js
 */
const assert = require('assert');
const path = require('path');

// ── pool 모킹 (require 캐시 주입 — search.service가 로드하기 전에) ──
const poolPath = require.resolve('../src/db/pool');
const captured = { queries: [] };
let reviewRows = [];
let forceTrgm = false;   // true면 본검색(= ANY) 강제실패 → pg_trgm fallback(searchByNameFallback) 경로 진입

const fakePool = {
  query: async (sql, params) => {
    captured.queries.push({ sql, params });
    if (/FROM reviewers/.test(sql)) return { rows: [] };            // 프로필(타계정) 없음
    if (/set_limit/.test(sql)) return { rows: [] };
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: '0', built_at: null }] };
    if (/FROM review_submissions/.test(sql)) return { rows: [] };
    // 본검색(= ANY)만 강제실패 → searchByName catch → searchByNameFallback(= $) 재실행
    if (forceTrgm && /FROM review_index/.test(sql) && /= ANY\(\$/.test(sql)) {
      throw new Error('operator does not exist: % boolean');
    }
    if (/FROM review_index/.test(sql)) return { rows: reviewRows };
    return { rows: [] };
  },
};
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: fakePool,
};

const { searchByName } = require('../src/services/search.service');

function mainSql() {
  const q = captured.queries.find(x => /FROM review_index/.test(x.sql));
  assert.ok(q, 'review_index 쿼리가 실행되어야 함');
  return q.sql;
}

function makeRow(over = {}) {
  return {
    idxName: '홍길동', recipientName: '', campaignName: '캠', tcCampaignName: null,
    tabName: '탭', sheetId: 'S', gid: '1', rowIndex: 2,
    isSubmitted: false, productName: '', productUrl: '', startDate: '7/1', endDate: '',
    round: '', rowJson: '{"연락처":"010-1234-5678","주소":"서울"}', submitCol: '리뷰제출',
    isSubmitted2: null,
    reviewFileAt: null, manager: null, timeRange: null, reviewType: null, taekhap: null,
    isClosed: false, deliveryType: null, isBulk: null, incomeType: null,
    displayName: null, ncMode: null, folderUrl: null, captureFolderUrl: null,
    captureSlots: null, archivedRounds: null, score: 1.0,
    ...over,
  };
}

// ★ 교차노출 게이트 회귀가드(구조 불변식):
//   pl(확정신원)을 신원키로 쓰는 모든 곳은 반드시 'ri.phone8 IS NULL AND ...' 게이트 뒤에만 온다.
//   미게이트 'OR pl.phone8 = ANY(' 가 재도입되면(=stale pl 교차노출 버그 부활) 실패시킨다.
function assertPlGated(sql, label) {
  const all   = (sql.match(/pl\.phone8 = ANY\(/g) || []).length;
  const gated = (sql.match(/ri\.phone8 IS NULL AND pl\.phone8 = ANY\(/g) || []).length;
  assert.ok(all > 0, `${label}: pl.phone8 신원키가 존재해야 함`);
  assert.strictEqual(all, gated, `${label}: 모든 pl.phone8 = ANY 는 ri.phone8 IS NULL 게이트 뒤에만(미게이트 pl 금지)`);
  assert.ok(!/OR pl\.phone8 = ANY\(/.test(sql), `${label}: 미게이트 'OR pl.phone8 = ANY(' 재도입 금지`);
}
// fallback(= $ 단일 파라미터)도 동일 게이트
function assertPlGatedFallback(sql, label) {
  const all   = (sql.match(/pl\.phone8 = \$/g) || []).length;
  const gated = (sql.match(/ri\.phone8 IS NULL AND pl\.phone8 = \$/g) || []).length;
  assert.ok(all > 0, `${label}: fallback pl.phone8 신원키가 존재해야 함`);
  assert.strictEqual(all, gated, `${label}: fallback pl 신원키도 모두 ri.phone8 IS NULL 게이트 뒤`);
  assert.ok(!/OR pl\.phone8 = \$/.test(sql), `${label}: 미게이트 'OR pl.phone8 = $' 재도입 금지`);
}

async function run() {
  // ── 1) 기본(옵션 미지정) = 기존과 동일: FALSE 필터 + LIMIT 200 + ASC 프리픽스 없음 ──
  captured.queries = [];
  reviewRows = [makeRow()];
  await searchByName('홍길동', '12345678');
  let sql = mainSql();
  assert.ok(sql.includes('ri.is_submitted = FALSE'), '1: 기본은 is_submitted=FALSE 필터');
  assert.ok(!sql.includes('is_submitted ASC'), '1: 기본은 정렬 프리픽스 없음');
  assert.ok(sql.includes('LIMIT 200'), '1: 기본 LIMIT 200');
  console.log('  1. 기본(옵션 미지정) 기존 쿼리 불변 ✓');

  // ── 2) 이름+phone8 + includeSubmitted: 제출완료는 강한 신원키로만 ──
  captured.queries = [];
  reviewRows = [
    makeRow(),
    makeRow({ rowIndex: 3, isSubmitted: true, isSubmitted2: 'PAID', reviewFileAt: '2026-06-21T09:30:00Z' }),
  ];
  const r2 = await searchByName('홍길동', '12345678', { includeSubmitted: true });
  sql = mainSql();
  assert.ok(
    sql.includes('(ri.is_submitted = FALSE OR ri.phone8 = ANY('),
    '2: 제출완료 행은 phone8/확정신원 일치 시에만 (이름/근접 매칭엔 미개방)'
  );
  assertPlGated(sql, '2 이름+phone8');   // pl 신원키는 stale 교차노출 차단 게이트 뒤에만
  assert.ok(!/WHERE TRUE/.test(sql), '2: 하이브리드 분기에 무조건 TRUE 해제 금지');
  assert.ok(sql.includes('ORDER BY ri.is_submitted ASC'), '2: 미제출 우선 정렬(대기 건 LIMIT 보호)');
  assert.ok(sql.includes('LIMIT 400'), '2: 완료 포함 시 LIMIT 상향');
  // 데이터 최소화: 제출완료 행 row 비움 + 대기 행 row 유지
  const pending = r2.results.find(x => !x.isSubmitted);
  const done = r2.results.find(x => x.isSubmitted);
  assert.deepEqual(done.row, {}, '2: 제출완료 행 row(행 JSON) 비움');
  assert.equal(done.submitCol, null, '2: 제출완료 행 submitCol 비움');
  assert.equal(done.reviewFileAt, '2026-06-21T09:30:00Z', '2: reviewFileAt 전달');
  assert.equal(pending.row['주소'], '서울', '2: 대기 행 row는 기존대로 유지');
  // 입금완료 배지: is_submitted2='PAID' → isPaid (row 비우기 전 판정)
  assert.equal(done.isPaid, true, '2: PAID → isPaid=true');
  assert.equal(pending.isPaid, false, '2: 입금 데이터 없으면 isPaid=false');
  console.log('  2. 이름+phone8 — 강한 신원키 가드 + row 최소화 + isPaid ✓');

  // ── 3) 이름 단독 + includeSubmitted: 항상 무시(대기 건만) ──
  captured.queries = [];
  reviewRows = [makeRow()];
  await searchByName('홍길동', '', { includeSubmitted: true });
  sql = mainSql();
  assert.ok(sql.includes('ri.is_submitted = FALSE'), '3: 이름 단독은 항상 FALSE 필터');
  assert.ok(!sql.includes('is_submitted ASC') && !/WHERE TRUE/.test(sql), '3: 이름 단독은 완료 미개방');
  assert.ok(sql.includes('LIMIT 200'), '3: 이름 단독 LIMIT 200 유지');
  console.log('  3. 이름 단독 — includeSubmitted 무시 ✓');

  // ── 4) phone8 단독 + includeSubmitted: 매칭 자체가 강한 키 → 필터만 해제 ──
  captured.queries = [];
  // 입금칸 미감지(isSubmitted2=null) 탭이라도 row_json의 입금 키워드 컬럼에 값이 있으면 완료(대시보드 폴백 동일)
  reviewRows = [makeRow({ isSubmitted: true, rowJson: '{"입금":"6/25","주소":"서울"}' })];
  const r4 = await searchByName('', '12345678', { includeSubmitted: true });
  sql = mainSql();
  assert.ok(/WHERE TRUE/.test(sql), '4: phone8 단독 분기는 필터 해제');
  assert.ok(sql.includes('ri.phone8 = ANY('), '4: 매칭은 phone8/확정신원 한정');
  assertPlGated(sql, '4 phone8단독');
  assert.ok(sql.includes('LIMIT 400') && sql.includes('ri.is_submitted ASC'), '4: LIMIT 상향 + 대기 우선');
  assert.equal(r4.results[0].isPaid, true, '4: 입금 키워드 컬럼 값 존재 → isPaid=true (폴백)');
  assert.deepEqual(r4.results[0].row, {}, '4: isPaid 판정 후에도 완료 행 row는 비움');
  console.log('  4. phone8 단독 — 필터 해제(강한 키 매칭) + isPaid 폴백 ✓');

  // ── 5) pg_trgm 미설치 fallback 경로(searchByNameFallback)도 동일 pl 게이트 ──
  captured.queries = []; forceTrgm = true; reviewRows = [makeRow()];
  await searchByName('홍길동', '12345678', { includeSubmitted: true });
  forceTrgm = false;
  const fbSql = captured.queries
    .filter(x => /FROM review_index/.test(x.sql))
    .map(x => x.sql)
    .find(s => /pl\.phone8 = \$/.test(s));   // fallback은 '= $'(본검색 '= ANY(' 와 구분)
  assert.ok(fbSql, '5: pg_trgm fallback review_index 쿼리가 실행되어야 함');
  assertPlGatedFallback(fbSql, '5 fallback');
  console.log('  5. pg_trgm fallback 경로 pl 게이트 ✓');

  // ── 6) 게이트 시맨틱 고정: stale pl(재배정 전 주인)은 미개방 / 현재주인(ri.phone8)은 개방 ──
  //   ri.phone8(현재 시트 소유자)이 채워진 행에서는 stale pl 이 그 행을 절대 못 연다
  //   (양미경 정상사용 r78 → 박은비 미노출). 현재주인은 첫 disjunct 'ri.phone8 = ANY' 로 개방.
  captured.queries = []; reviewRows = [makeRow()];
  await searchByName('', '82217191', { includeSubmitted: true });   // 박은비 phone8 단독
  const s6 = mainSql();
  assertPlGated(s6, '6 stale-pl 미개방');
  assert.ok(/ri\.phone8 = ANY\(/.test(s6), '6: 현재주인(ri.phone8)은 첫 disjunct 로 개방');
  console.log('  6. stale pl 미개방 / 현재주인 개방 구조 고정 ✓');

  console.log('✅ searchSubmittedGuard 테스트 전체 통과');
}

run().catch(err => {
  console.error('❌ 테스트 실패:', err.message);
  process.exit(1);
});
