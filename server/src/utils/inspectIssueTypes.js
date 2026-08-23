/**
 * 리뷰검수 오류유형 판정 — **단일 출처**.
 *
 * ★★ 이 파일이 "무엇이 어떤 유형인가"를 혼자 소유한다. 종전에는 판정이 화면
 *   (`workdesk.html` `_riIssueTypes`) 한 곳에만 있었고, 그래서 **유형별 건수는
 *   불러온 200건(목록 LIMIT)만 셀 수 있었다** — 3,334건짜리 화면에서 칩이
 *   "전체 유형 200"으로 뜨는 것이 그 증상이다. 전체 집계를 서버에서 하려면
 *   DB 안에서도 같은 판정이 필요한데, 그 규칙을 SQL 에 따로 적으면 사본이 되어
 *   **"칩 건수 ≠ 카드 문장"** 으로 갈린다(이 저장소의 반복된 사고).
 *   → 규칙표(`ISSUE_RULES`) 하나에서 **JS 판정과 SQL 집계 조각을 함께 파생**한다.
 *
 * ★ 화면의 `_riIssueTypes` 는 카드 필터(로드된 행)용으로 남아 있고, 회귀가드가
 *   두 구현을 같은 픽스처로 실행해 **결과 동일**함을 고정한다(workManager 사본 규율).
 *
 * ★ 완화 금지: 여기서 유형을 넓히거나 좁히면 카드에 적히는 근거 문장(`_riReasons`)과
 *   갈린다. 규칙을 바꿀 때는 화면 판정·근거 문장을 함께 바꾼다.
 */

/** 유형 키 순서 = 화면 칩 순서(RI_TYPES)와 같아야 한다 — 회귀가드가 고정. */
const ISSUE_RULES = [
  {
    key: 'cancel',
    /* ★★ 주문취소 — 리뷰어가 그 작업을 취소한 신호(2026-08-23 신고).
         `format_fail` 과 **겹쳐서** 세어진다(둘 다 fail) — 의도한 것이다: 담당자에게
         "리뷰 화면이 아님"보다 "취소됨"이 먼저 읽혀야 하고, 칩은 원래 중복 계수다
         (화면 안내문이 그 사실을 말한다). 화면 주 이슈 판정도 이 축을 먼저 본다.
       ★ verdict 를 보지 않는다 — 취소 화면은 어느 작업에서도 정상 제출이 아니므로
         판정이 무엇이든 담당자가 봐야 한다. */
    js: (c) => !!(c.format && (c.format.got || c.format.kind) === 'order_cancel'),
    sql: (a) => `COALESCE(${a}->'format'->>'got', ${a}->'format'->>'kind') = 'order_cancel'`,
  },
  {
    key: 'format_fail',
    // 리뷰 화면이 아님(확신 판정) — 유일한 fail 축
    js: (c) => !!(c.format && c.format.verdict === 'fail'),
    sql: (a) => `${a}->'format'->>'verdict' = 'fail'`,
  },
  {
    key: 'channel',
    // 채널 다름 — 기대 채널이 있을 때의 format warn 만(기대값이 없으면 판정 근거가 없다)
    js: (c) => !!(c.format && c.format.verdict === 'warn' && c.format.expectedChannel),
    sql: (a) => `${a}->'format'->>'verdict' = 'warn'
                 AND COALESCE(${a}->'format'->>'expectedChannel', '') <> ''`,
  },
  {
    key: 'product',
    js: (c) => !!(c.product && c.product.verdict === 'warn'),
    sql: (a) => `${a}->'product'->>'verdict' = 'warn'`,
  },
  {
    key: 'duplicate',
    // 같은 파일 — fail(같은 작업 재사용·타인 도용)과 warn(한 화면에 여러 리뷰) 둘 다
    js: (c) => !!(c.duplicate && (c.duplicate.verdict === 'fail' || c.duplicate.verdict === 'warn')),
    sql: (a) => `${a}->'duplicate'->>'verdict' IN ('fail','warn')`,
  },
  {
    key: 'similarity',
    js: (c) => !!(c.similarity && c.similarity.verdict === 'warn'),
    sql: (a) => `${a}->'similarity'->>'verdict' = 'warn'`,
  },
  {
    key: 'author',
    js: (c) => !!(c.author && c.author.verdict === 'warn'),
    sql: (a) => `${a}->'author'->>'verdict' = 'warn'`,
  },
];

const ISSUE_KEYS = ISSUE_RULES.map(r => r.key);

/** 한 건이 여러 유형이면 전부 반환(칩은 중복 계수 — 화면 안내문이 그 사실을 말한다). */
function issueTypesOf(row) {
  const c = (row && (row.checks || row)) || {};
  const out = [];
  for (const r of ISSUE_RULES) if (r.js(c)) out.push(r.key);
  return out;
}

/**
 * 유형별 `COUNT(*) FILTER (...)` 목록 — SELECT 안에 그대로 끼워 넣는다.
 * @param {string} col checks 컬럼 표현식(예: 'i.checks')
 */
function issueTypeCountSql(col = 'checks') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(String(col))) {
    throw new Error('invalid checks column');            // 문자열 조립 — 주입 차단
  }
  return ISSUE_RULES
    .map(r => `COUNT(*) FILTER (WHERE ${r.sql(col)})::int AS ${r.key}`)
    .join(',\n           ');
}

module.exports = { ISSUE_RULES, ISSUE_KEYS, issueTypesOf, issueTypeCountSql };
