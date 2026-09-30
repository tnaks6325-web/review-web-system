/**
 * 블로그체험단 M2 회귀가드 — 준비 행 기준 분기 + URL 열 하이재킹 차단
 *
 * 이 가드가 고정하는 것
 *   (1~4 의 준비 행 판독 readPreparedRows 는 sheetSlotSync.service 와 함께 결정 186 78번에서 제거 —
 *    소비처(시트 동기화 점검 77번·부팅 1회성 0804 동기화 78번)가 모두 없어졌다. 5~6 만 남는다.)
 *   1. **블로그 준비 행 = 값이 하나라도 있는 행**(구매일자 무관). 날짜 기준으로 세면 준비 행이
 *      통째로 0이 되어 **무음 누락**된다 — (주)바를참스킨 0804 사고가 정확히 이것.
 *   2. 총원(연결 작업오더 recruit_count)이 있으면 **앞에서부터 그 수까지만**. 총원이 시트 실체 행보다
 *      많아도 **자리를 지어내지 않는다**(seq 는 시트 실제 행 번호여야 한다) — 대신 shortOfTotal 고지.
 *   3. 판정 실패·미등록 탭은 **종전 동작(날짜 기준)** — 모른다고 블로그로 단정하면 리뷰 작업의
 *      준비 행 기준이 통째로 바뀐다(오탐이 훨씬 비싸다).
 *   4. 분기는 `readPreparedRows` **한 곳** — 호출부 4곳이 전부 `tabName` 을 넘긴다(안 넘기면
 *      종류를 판정할 수 없어 블로그 탭이 조용히 날짜 기준으로 떨어진다).
 *   5. **블로그URL·포스팅URL 이 상품URL 을 하이재킹하지 않는다** — urlKeywords 는 'url' 부분일치 +
 *      첫 매칭 승이라, 그 열이 왼쪽에 있으면 review_index.product_url 이 통째로 블로그 주소가 된다.
 *   6. 사본 금지: 공고 LATERAL(gid 폴백·값 있는 최신 공고) = utils/campaignTabLateral ·
 *      작업오더 링크 우선순위(ORDER BY link_rank) = utils/workOrderLink — 두 소비처가 같은 것을 쓴다.
 *
 * 실행: node tests/blogPreparedRows.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// (sheetlessCutover.service.js 는 탈시트 전환 화면 제거로 삭제 — 2026-09-28, 결정 186 2번)
const RES = R('src/services/columnResolver.js');
const WKC = R('src/services/workKindContext.service.js');
const LINK = R('src/utils/workOrderLink.js');
const LAT = R('src/utils/campaignTabLateral.js');
// ⚠ reviewTypeContext·reviewInspect 는 의도된 NUL(복합키 구분자)이 섞일 수 있어 이스케이프 표기로 제거하고 읽는다.
const SNUL = (p) => R(p).split(String.fromCharCode(0)).join('');
const RTC = SNUL('src/services/reviewTypeContext.service.js');
const RI = SNUL('src/services/reviewInspect.service.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };
const ta = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

const wkc = require('../src/services/workKindContext.service');
const { parseTabRows } = require('../src/services/columnResolver');
const { workOrderForTabSql } = require('../src/utils/workOrderLink');
const { campaignColLateral } = require('../src/utils/campaignTabLateral');

(async () => {

/* ══ 5) URL 열 하이재킹 차단 ═════════════════════════════════ */
console.log('\n5) 블로그URL·포스팅URL 이 상품URL 을 가로채지 않는다');

const KW = {
  NAME_KEYWORDS: ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'],
  SUBMIT_KEYWORDS: ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰'],
  DATA_TAB_KEYWORDS: ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'],
  SUBMITTED_VALUES: ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'],
};

t('★★ 블로그URL 이 상품URL 보다 왼쪽이어도 productUrl 은 상품 주소', () => {
  const v = [
    ['번호', '수취인', '블로그URL', '포스팅URL', '상품URL'],
    ['1', '홍길동', 'https://blog.naver.com/me', 'https://blog.naver.com/me/222', 'https://coupang.com/p/1'],
  ];
  const r = parseTabRows(v, 's', 't', 'g', null, KW);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].productUrl, 'https://coupang.com/p/1',
    '블로그·포스팅 주소가 상품URL 을 가로챘다 — 리뷰어 화면 "상품 페이지"가 남의 블로그로 나간다');
});

t('★ 상품URL 이 아예 없으면 빈 값 — 포스팅 주소를 상품 주소로 내보내지 않는다', () => {
  const v = [
    ['번호', '수취인', '포스팅URL'],
    ['1', '홍길동', 'https://blog.naver.com/me/222'],
  ];
  const r = parseTabRows(v, 's', 't', 'g', null, KW);
  assert.strictEqual(r[0].productUrl, '', '틀린 값을 채웠다 — 빈 값이 맞다');
});

t('무회귀: 평범한 상품URL·상품링크는 그대로 잡힌다', () => {
  const v1 = [['번호', '수취인', '상품URL'], ['1', '홍길동', 'https://a.com/1']];
  assert.strictEqual(parseTabRows(v1, 's', 't', 'g', null, KW)[0].productUrl, 'https://a.com/1');
  const v2 = [['번호', '수취인', '상품링크'], ['1', '홍길동', 'https://b.com/2']];
  assert.strictEqual(parseTabRows(v2, 's', 't', 'g', null, KW)[0].productUrl, 'https://b.com/2');
});

t('★ 제외 낱말은 둘뿐 — 넓히면 멀쩡한 상품열이 빈 값이 된다', () => {
  const m = RES.match(/const URL_EXCLUDE_PATTERNS = \[([^\]]*)\]/);
  assert.ok(m, 'URL_EXCLUDE_PATTERNS 가 없다');
  const list = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepStrictEqual(list, ['블로그', '포스팅'], '제외 목록이 바뀌었다: ' + list.join('|'));
});

/* ══ 6) 공유 조각 — 사본 금지 ════════════════════════════════ */
console.log('\n6) 공유 조각(공고 LATERAL · 작업오더 링크)');

t('★★ 공고 LATERAL 은 utils/campaignTabLateral 한 벌 — 리뷰타입·체험단 종류가 같은 걸 쓴다', () => {
  assert.ok(/campaignColLateral\('review_type'/.test(RTC), 'reviewTypeContext 가 공유 조각을 안 쓴다');
  assert.ok(/campaignColLateral\('work_kind'/.test(WKC), 'workKindContext 가 공유 조각을 안 쓴다');
  [RTC, WKC].forEach((src, i) => assert.ok(!/FROM recruit_campaigns\s*\n\s*WHERE linked_sheet_id/.test(src),
    `LATERAL 사본이 남아 있다(${i === 0 ? 'reviewTypeContext' : 'workKindContext'})`));
});

t('★★ 공유 LATERAL 이 gid 폴백 + "값이 있는 최신 공고" 규칙을 지킨다', () => {
  const sql = campaignColLateral('work_kind', 'wk');
  assert.ok(/linked_tab_name = c\.tab_name/.test(sql), '이름 매칭이 없다');
  assert.ok(/COALESCE\(c\.tab_gid, ''\) <> ''\s*AND linked_tab_gid = c\.tab_gid/.test(sql),
    'gid 폴백이 없다 — 리네임하면 설정이 조용히 풀린다(★ 빈 gid 는 키를 만들면 안 된다)');
  assert.ok(/COALESCE\(work_kind, ''\) <> ''/.test(sql),
    '값이 있는 최신 공고 조건이 없다 — 차수 재발행 시 최신 공고의 빈 값이 옛 설정을 가린다');
  assert.throws(() => campaignColLateral('status; DROP TABLE x', 'a'), '칸 이름 허용목록이 없다');
});

t('★★ 작업오더 링크는 ORDER BY link_rank — OR 로만 묶으면 최신 폴백 오더가 이긴다', () => {
  const sql = workOrderForTabSql(['recruit_count']);
  assert.ok(/ORDER BY link_rank, w\.created_at DESC/.test(sql), '우선순위를 ORDER BY 로 명시하지 않았다');
  assert.ok(/CASE WHEN EXISTS/.test(sql) && /trackb_work_order_links/.test(sql), '링크 판정이 없다');
  assert.ok(/w\.deleted_at IS NULL/.test(sql), '소프트 삭제된 오더를 거르지 않는다');
  assert.throws(() => workOrderForTabSql(['x; DROP TABLE y']), '칸 이름 검사가 없다');
});

t('★ reviewInspect 도 같은 공유 SQL 을 쓴다(사본 0)', () => {
  assert.ok(/workOrderForTabSql\(\[/.test(RI), 'reviewInspect 가 공유 SQL 을 안 쓴다');
  // ★ 줄 주석은 걷어내고 본다 — 설명에 규칙 이름이 나오는 것은 사본이 아니다.
  assert.ok(!/ORDER BY link_rank/.test(RI.replace(/\/\/.*$/gm, '')), '링크 SQL 사본이 남아 있다');
});

/* ══ 7) 위생 ═════════════════════════════════════════════════ */
console.log('\n7) 소스 위생');

t('★ 리터럴 NUL 없음(git 이 바이너리로 취급하면 grep 가드가 무력화된다)', () => {
  [['workKindContext', WKC], ['workOrderLink', LINK],
   ['campaignTabLateral', LAT], ['columnResolver', RES]].forEach(([n, s]) =>
    assert.ok(!s.includes(String.fromCharCode(0)), `${n} 에 리터럴 NUL 이 있다`));
});

t('★ 읽기 전용 — 준비 행 판독 경로에 쓰기 SQL 0', () => {
  [['workKindContext', WKC], ['workOrderLink', LINK]].forEach(([n, s]) => {
    const body = s.replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(body), `${n} 에 쓰기 SQL 이 있다`);
  });
});

/* ★★ campaignTabLateral 은 **파일 전체가 아니라 판독 조각만** 본다 (2026-08-24)
   ────────────────────────────────────────────────────────────────────────
   그 파일은 성격이 둘로 갈렸다: `campaignColLateral`(판독 경로가 쓰는 읽기 SQL 조각)과
   `renameCampaignLinkedTab`(탭 리네임 자가치유의 UPDATE — indexBuilder·indexScan 전용,
   준비 행 판독과 무관, 전용 가드 `campaignLinkFollowRename` 가 지킨다).
   파일 전체를 훑던 종전 검사는 그 쓰기 함수가 합류한 순간(#1134) 빨개졌다 — 판독 경로는
   그대로 읽기 전용인데도. 그래서 **판독 함수 본문으로 좁히고**, 대신 "그 파일의 쓰기는
   renameCampaignLinkedTab 안에만 있다"를 함께 고정한다(검사 의미는 더 강해진다). */
function _fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  // ★ 매개변수 목록을 먼저 건너뛴다 — `({ sheetId, ... } = {})` 같은 구조분해의 중괄호를
  //   본문 시작으로 세면 시그니처만 잘라 내고 "쓰기 0" 을 거짓으로 통과시킨다(실측).
  let p = src.indexOf('(', i), pd = 0, bodyStart = -1;
  for (let j = p; j < src.length; j++) {
    if (src[j] === '(') pd++;
    else if (src[j] === ')') { pd--; if (pd === 0) { bodyStart = src.indexOf('{', j); break; } }
  }
  if (bodyStart < 0) return null;
  let d = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1); }
  }
  return null;
}

t('★ 읽기 전용 — campaignTabLateral 의 판독 조각(campaignColLateral)에 쓰기 SQL 0', () => {
  const read = _fnBody(LAT, 'campaignColLateral');
  assert.ok(read, 'campaignColLateral 함수를 찾지 못했다(이름이 바뀌었으면 이 가드를 함께 고칠 것)');
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(read.replace(/\/\/.*$/gm, '')),
    'campaignColLateral 에 쓰기 SQL 이 있다');
});

t('★ campaignTabLateral 의 쓰기는 renameCampaignLinkedTab 안에만 있다(딴 곳에 새 쓰기가 생기면 잡힌다)', () => {
  const body = LAT.replace(/\/\/.*$/gm, '');
  const total = (body.match(/\b(INSERT|UPDATE|DELETE)\b/gi) || []).length;
  const write = _fnBody(LAT, 'renameCampaignLinkedTab') || '';
  const inWrite = (write.replace(/\/\/.*$/gm, '').match(/\b(INSERT|UPDATE|DELETE)\b/gi) || []).length;
  assert.ok(total > 0 && total === inWrite,
    `쓰기 SQL ${total}개 중 ${inWrite}개만 renameCampaignLinkedTab 안에 있다`);
});

console.log(`\n✅ 블로그체험단 M2 회귀가드 통과 — ${pass}건`);
process.exit(0);
})();
