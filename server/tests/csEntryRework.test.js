/**
 * csEntryRework.test.js — 1:1문의 시작 창구 개편 + 리뷰내역 카드 통일 회귀가드
 * 실행: node tests/csEntryRework.test.js
 *
 * 고정하는 불변식 4가지
 *  ① 문의 시작 창구는 **참여상품 정보 팝업 하나** — 캠페인 선택 팝업(피커)을 되살리면 진입 경로가
 *     둘이 되어 "문의한 목록"과 "문의 시작"이 다시 섞인다.
 *  ② 1:1문의 탭은 **인라인 목록**(#sectionCsInbox) — 탭 클릭이 오버레이를 열면 안 된다.
 *  ③ 리뷰내역 단건 카드는 **참여중·제출완료 공통 코드 한 벌**로 그린다(완료 전용 2줄 카드 부활 금지).
 *  ④ 누적 금액은 **입금완료된 건만** 합산한다(사용자 확정 기준) — 판정 규칙은
 *     search.service의 PAYMENT_COL_KEYWORDS 단일 출처에서 파생한다.
 *
 * ★ ④는 grep이 아니라 **실제 핸들러 실행**으로 검증한다(스텁 pool). SQL 문자열 grep은
 *   집계 분기(입금 여부에 따른 합산 대상)를 볼 수 없다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const routes = read('src/routes/reviewer.routes.js');
const searchSvc = read('src/services/search.service.js');
const indexHtml = read('../frontend/index.html');
const csJs = read('../frontend/js/reviewer-cs.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

console.log('\n① 문의 시작 창구 = 참여상품 정보 팝업 하나');
ok('cs.js: 캠페인 선택 팝업(피커) 부재 — 진입 경로 이중화 금지',
  !/function\s+openPicker|function\s+renderPicker|rcsPickerList/.test(csJs));
ok('cs.js: 탭 진입은 인라인 문의함으로 위임(openInbox → switchTab("cs"))',
  /function openInbox\(\)/.test(csJs) && /switchTab\("cs"\)/.test(csJs));
ok('cs.js: 뒤로가기는 문의함 목록 갱신(back: backToInbox)',
  /function backToInbox\(\)/.test(csJs) && /back:\s*backToInbox/.test(csJs));
ok('index: 참여상품 정보 팝업에 [1:1 문의하기] 버튼', /_partInfoCsBtnHtml/.test(indexHtml) && /1:1 문의하기/.test(indexHtml));
ok('index: 문의 문맥은 진행한 탭 기준(sheetId||tabName)',
  /_partInfoCsCtx\s*=\s*\(it\.sheetId && it\.tabName\)/.test(indexHtml) &&
  /campaignKey:\s*it\.sheetId \+ '\|\|' \+ it\.tabName/.test(indexHtml));
// 2026-08-19: 이름 폴백이 `_taskLabel`(내부 키 노출 금지 단일 출처)로 모였다 — 검사 의미는 그대로
// "상품명 우선, 그 다음 사람이 읽는 작업 이름. 시트제목은 쓰지 않는다".
ok('index: 문의 라벨에 시트제목 미사용(상품명 → 작업 이름만)',
  /campaignLabel:\s*\(it\.productName \|\| _taskLabel\(it, '문의'\)\)/.test(indexHtml));
ok('index: 팝업 버튼에 그 방의 미확인 수 표기(_csUnreadForKey)', /_csUnreadForKey\(_partInfoCsCtx\.campaignKey\)/.test(indexHtml));
ok('index: 이미지 확인·수정요청도 팝업 안(카드 겉면 통일) — 단건일 때만',
  /_partInfoReEditId = \(done && list\.length === 1\)/.test(indexHtml));
ok('index: 완료 카드 하단 통짜 버튼 제거(_reEditButtonEl·has-editfoot 부재)',
  !/_reEditButtonEl/.test(indexHtml) && !/has-editfoot/.test(indexHtml));
ok('index: 다건 그룹은 줄별 미니 수정요청 버튼 유지(행 단위 작업이라 팝업으로 못 옮김)',
  /_reEditBtnHtml\(item\)/.test(indexHtml));

console.log('\n② 1:1문의 탭 = 인라인 목록(팝업 없음)');
ok('index: 탭바 버튼이 오버레이가 아니라 탭 전환 호출',
  /id="tabBtnCs"[^>]*class="tab-cs"[^>]*onclick="switchTab\('cs'\)"/.test(indexHtml));
ok('index: 문의함 섹션 존재(#sectionCsInbox)', /id="sectionCsInbox"/.test(indexHtml));
ok('index: switchTab이 cs 키를 처리하고 섹션을 토글', /show\(csInbox,\s*key === 'cs'\)/.test(indexHtml));
ok('index: cs 탭 진입 시 목록 조회', /if \(key === 'cs'\) \{ try \{ loadCsInbox\(\)/.test(indexHtml));
ok('index: 진행 중 / 종료된 문의 분리', /진행 중인 문의/.test(indexHtml) && /종료된 문의/.test(indexHtml));
ok('index: 빈 상태에서 다음 행동 안내(리뷰 내역으로 이동)',
  /아직 남긴 문의가 없습니다/.test(indexHtml) && /onclick="switchTab\('review'\)"/.test(indexHtml));
ok('index: 방 열기는 배열 인덱스로 전달(따옴표·특수문자 이스케이프 사고 차단)',
  /onclick="csInboxOpen\(\$\{idx\}\)"/.test(indexHtml));
ok('index: 목록은 기존 무인증 phone8 스코프 API 재사용(신규 엔드포인트 0)',
  /action: 'csReviewerThreads', phone8/.test(indexHtml));
ok('index: 문의함 화면에서는 구매 캡처 보완 블록을 숨김(문의 목록만 보이게)',
  /if \(key === 'cs'\) mc\.style\.display = 'none'/.test(indexHtml));

console.log('\n③ 리뷰내역 단건 카드 = 참여중·제출완료 공통 한 벌');
ok('index: 완료 전용 2줄 카드(_doneRowHtml·result-avatar 분기) 부활 금지',
  !/_doneRowHtml/.test(indexHtml));
ok('index: 완료·대기 모두 썸네일 + 3줄(camp-thumb / c-meta / c-name / fee-line)',
  /<div class="camp-thumb">\$\{thumbHtml\}<\/div>/.test(indexHtml) &&
  /const metaHtml = `<div class="c-meta">/.test(indexHtml));
ok('index: 제출일은 첫 줄 꼬리로(줄 수 유지)', /const metaTail = doneDate \? ` <span class="c-tail">· 제출/.test(indexHtml));
ok('index: 입금완료 배지는 상태 배지 아랫줄(제목 잘림 완화)',
  /const subBadgeHtml = \(isDone && item\.isPaid\)/.test(indexHtml) && /\.result-right\.rr-col/.test(indexHtml));
ok('index: 완료 카드도 클릭 가능(팝업 진입) — cursor:default 무력화 CSS 제거',
  !/\.result-card\.done, \.result-group-card\.done \{ cursor:default/.test(indexHtml));
ok('index: 완료 카드는 그 행 1건만 팝업에 전달(다건 그룹과 혼동 금지)',
  /openPartInfoSheet\(isDone \? \[item\] : items, \{ done: isDone \}\)/.test(indexHtml));

console.log('\n④ 누적 금액 = 입금완료 건만 (판정 단일 출처)');
ok('search.service: 입금 키워드 목록을 내보냄(판정 드리프트 차단)',
  /module\.exports = \{[^}]*PAYMENT_COL_KEYWORDS/.test(searchSvc));
ok('routes: 그 목록에서 SQL 패턴을 파생(하드코딩 금지)',
  /PAYMENT_COL_KEYWORDS\.map\(k => '%' \+ k \+ '%'\)/.test(routes));
ok('routes: row_json 은 서버로 끌어오지 않고 SQL에서 판정(메모리 안전)',
  /jsonb_each_text\(COALESCE\(row_json, '\{\}'::jsonb\)\) kv/.test(routes) &&
  /kv\.key ILIKE ANY\(\$2\) AND btrim\(kv\.value\) <> ''/.test(routes));
ok('index: 완료 탭에서 같은 자리를 누적 금액으로 전환(블록 소실 금지)',
  /const t = isDone \? _reviewEarnings\.doneTotals : _reviewEarnings\.totals/.test(indexHtml) &&
  /🏆 누적 금액/.test(indexHtml));
ok('index: 미입금 제외 사실을 화면에 고지', /아직 입금되지 않은/.test(indexHtml));

// ── 런타임: 실제 핸들러 실행 ─────────────────────────────────────
const pool = require('../src/db/pool');
const RI_ROWS = [
  // 참여중 2건
  { sheetId: 'S1', tabName: 'T1', rowIndex: 11, isSubmitted: false, isPaid: false },
  { sheetId: 'S1', tabName: 'T1', rowIndex: 12, isSubmitted: false, isPaid: false },
  // 제출완료: 입금완료 2건 + 미입금 1건
  { sheetId: 'S1', tabName: 'T1', rowIndex: 21, isSubmitted: true, isPaid: true },
  { sheetId: 'S1', tabName: 'T1', rowIndex: 22, isSubmitted: true, isPaid: true },
  { sheetId: 'S1', tabName: 'T1', rowIndex: 23, isSubmitted: true, isPaid: false },
];
const PRICES = { 11: '20300', 12: '12400', 21: '18900', 22: '12400', 23: '9800' };
pool.query = async (sql) => {
  // ★ 무시트 주문원장 집계는 이 기존 시트행 전용 fixture에 포함하지 않는다.
  //   같은 주문을 review_index와 양쪽에서 돌려 이중 집계하는 것을 막는 경로다.
  //   ⚠ 이 분기는 `FROM review_index` 보다 **먼저** 와야 한다 — 그 쿼리의 이중집계 방지
  //     NOT EXISTS 안에 `FROM review_index ri` 가 들어 있어(2026-08-19 주문 id 매칭 추가)
  //     순서가 뒤면 명단 fixture 가 가로채 무시트 주문 5건으로 오인된다(스텁 매칭 함정).
  if (/FROM order_submissions os[\s\S]*LEFT JOIN campaign_participants cp[\s\S]*NOT EXISTS/.test(sql)) return { rows: [] };
  if (/FROM review_index/.test(sql)) return { rows: RI_ROWS };
  if (/FROM recruit_campaigns/.test(sql)) {
    return { rows: [{ sheetId: 'S1', tabName: 'T1', reviewFee: 1000, thumbnailUrl: 'https://x/y.png' }] };
  }
  if (/FROM order_submissions/.test(sql)) {
    return { rows: RI_ROWS.map(r => ({ sheetId: r.sheetId, tabName: r.tabName, sheetRow: r.rowIndex, price: PRICES[r.rowIndex] })) };
  }
  return { rows: [] };
};

const reviewerRouter = require('../src/routes/reviewer.routes');
function handlerFor(method, routePath) {
  const layer = reviewerRouter.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `라우트 없음: ${method.toUpperCase()} ${routePath}`);
  const st = layer.route.stack;
  return st[st.length - 1].handle;
}
async function call(method, routePath, req) {
  const handler = handlerFor(method, routePath);
  return await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ err }))).catch((err) => resolve({ err }));
  });
}

(async () => {
  console.log('\n⑤ 런타임: /review-earnings 집계 (스텁 pool로 실제 핸들러 호출)');
  const r = await call('get', '/review-earnings', { query: { phone8: '85926325' } });
  ok('런타임: ReferenceError 없이 실행', !(r.err instanceof ReferenceError));
  const b = r.body || {};
  ok('런타임: 응답에 totals·doneTotals·items 동봉', !!(b.totals && b.doneTotals && b.items));

  ok('받을 예정 = 참여중 2건만 집계(20300+12400=32700, 리뷰비 2000)',
    b.totals.count === 2 && b.totals.productTotal === 32700 && b.totals.reviewTotal === 2000 &&
    b.totals.grandTotal === 34700);
  ok('★ 누적 = 입금완료 2건만(18900+12400=31300, 리뷰비 2000) — 미입금 9800 미포함',
    b.doneTotals.count === 2 && b.doneTotals.productTotal === 31300 &&
    b.doneTotals.reviewTotal === 2000 && b.doneTotals.grandTotal === 33300);
  ok('누적: 제외된 미입금 건수를 함께 반환(화면 고지용)', b.doneTotals.unpaidCount === 1);
  ok('items: 완료 건도 상품비/리뷰비/썸네일을 받음(완료 카드 배지용)',
    !!b.items['S1||T1||21'] && b.items['S1||T1||21'].productPrice === 18900 &&
    b.items['S1||T1||21'].reviewFee === 1000 && !!b.items['S1||T1||21'].thumbnailUrl);
  ok('items: 참여중 건도 종전대로 유지(회귀 없음)',
    !!b.items['S1||T1||11'] && b.items['S1||T1||11'].productPrice === 20300);

  // 실패 폴백도 계약을 지켜야 프론트가 undefined를 만지지 않는다
  pool.query = async () => { throw new Error('boom'); };
  const f = await call('get', '/review-earnings', { query: { phone8: '85926325' } });
  ok('실패 폴백도 doneTotals 형태 유지(프론트 undefined 접근 방지)',
    f.body && f.body.ok === true && f.body.doneTotals && f.body.doneTotals.count === 0);

  console.log(`\n✅ csEntryRework: ${passed}개 통과\n`);
  process.exit(0);
})();
