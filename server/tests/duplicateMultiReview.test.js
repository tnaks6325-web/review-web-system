/**
 * duplicateMultiReview.test.js — "한 캡처에 여러 리뷰" 완화 회귀가드 (실사고 2026-08-06).
 *
 * 사고: 리뷰어가 두 작업(노티드 두바이 쫀득쿠키 / 노티드 슈가베어 우유크림 폭탄떡)에 동시에
 * 참여했고 쿠팡 리뷰관리 화면에 두 리뷰가 나란히 보여, 캡처 한 장으로 두 건을 냈다.
 * **리뷰어가 맞게 행동한 것**인데 검수는 "중복파일"로 불량 처리했다.
 *
 * 고정하는 불변식:
 *   A. 세 갈래 — ㉮ 같은 작업 재사용 = fail / ㉯ 다른 리뷰어 = fail(도용)
 *      ㉰ 같은 리뷰어 + 다른 작업 = warn, 근거(두 작업 상품명이 모두 읽힘) 있으면 pass
 *   B. 완화는 **근거가 있을 때만** pass — 근거 없으면 warn 까지(fail 로 되돌리지 않는다)
 *   C. 조회 실패는 판정을 바꾸지 않는다(모르면 완화하지 않는다)
 *   D. 배선 — 카드 유형·근거 문장·주 조치([✓ 정상])·제거 게이트(warn 허용)·리뷰어 안내
 *
 * 실행: node tests/duplicateMultiReview.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readFront = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

const RI = require('../src/services/reviewInspect.service');

/* 두 작업의 기대 상품명 — 다른 탭 조회는 loadTabExpectations 가 DB 를 타므로 스텁 pool 로 준다. */
const OTHER = ['노티드 두바이 쫀득쿠키 (냉동), 50g, 1개, 1개입'];
const HERE = ['노티드 슈가베어의 우유크림 폭탄떡 (냉동), 85g, 1개, 4개입'];
function stubExpectations(names) {
  RI.__setPoolForTest({
    query: async (sql) => {
      if (/tab_configs/.test(sql)) return { rows: [{ inspect_product_names: names, inspect_product_aliases: null }] };
      return { rows: [] };
    },
  });
}

const DUP = {
  verdict: 'fail', matchFileId: 'OTHERFILE', matchSheetId: 'S1', matchTab: '노티드_두바이쫀득쿠키 쿠팡',
  matchReviewer: '정주낭', matchRow: 12, matchAt: '2026-07-21T02:00:00Z',
};
const CTX = { sheetId: 'S1', tabName: '노티드_우유크림폭탄떡 쿠팡 200건(26년)', reviewerName: '정주낭' };

(async () => {
  /* ═══ A. 세 갈래 ═══ */
  console.log('\nA) 같은 지문이라고 다 중복이 아니다');
  {
    // ㉮ 같은 작업 안 재사용 → fail 그대로
    stubExpectations(OTHER);
    let r = await RI.classifyDuplicateContext({
      dup: { ...DUP, matchTab: CTX.tabName }, cls: null, exp: { productNames: HERE }, ...CTX });
    assert.strictEqual(r.verdict, 'fail', '★ 같은 작업 재사용은 완화하지 않는다');
    assert.ok(!r.sameReviewerOtherTab && !r.multiReview);
    ok('A1: ㉮ 같은 작업 안 재사용 = fail(완화 금지)');

    // ㉯ 다른 리뷰어 → fail 그대로(도용)
    r = await RI.classifyDuplicateContext({
      dup: { ...DUP, matchReviewer: '다른사람' }, cls: null, exp: { productNames: HERE }, ...CTX });
    assert.strictEqual(r.verdict, 'fail', '★ 타인 도용은 완화하지 않는다');
    ok('A2: ㉯ 다른 리뷰어 = fail(도용 — 완화 금지)');

    // ㉰ 같은 리뷰어 + 다른 작업, 근거 없음 → warn
    stubExpectations(OTHER);
    r = await RI.classifyDuplicateContext({
      dup: DUP, cls: { productName: '', reviewText: '' }, exp: { productNames: HERE }, ...CTX });
    assert.strictEqual(r.verdict, 'warn');
    assert.strictEqual(r.sameReviewerOtherTab, true);
    assert.strictEqual(r.matchFileId, DUP.matchFileId, '근거(matchFileId)는 그대로 남는다');
    ok('A3: ㉰ 같은 리뷰어 + 다른 작업 = warn(사람이 본다 — 자동 불량 아님)');

    // ㉰ + 근거(두 작업 상품명이 모두 캡처에서 읽힘) → pass
    stubExpectations(OTHER);
    r = await RI.classifyDuplicateContext({
      dup: DUP,
      cls: {
        productName: '노티드 두바이 쫀득쿠키 (냉동), 50g, 1개, 1개입',
        reviewText: '벌써 두번째인데… 노티드 슈가베어의 우유크림 폭탄떡 (냉동), 85g, 1개, 4개입 정말 맛있어요',
      },
      exp: { productNames: HERE }, ...CTX });
    assert.strictEqual(r.verdict, 'pass', '★ 두 작업 상품이 모두 읽히면 자동 통과');
    assert.strictEqual(r.multiReview, true);
    assert.strictEqual(r.products.length, 2);
    ok('A4: ★ ㉰ + 두 작업 상품명 모두 읽힘 = pass(근거 있는 자동 통과)');
  }

  /* ═══ B·C. 완화의 한계 ═══ */
  console.log('\nB) 완화는 근거가 있을 때만 · 모르면 완화하지 않는다');
  {
    // 같은 상품(재참여 차수)이면 근거로 쓰지 않는다 — 한 화면 두 리뷰가 아니라 재사용일 수 있다
    stubExpectations(HERE);
    const r = await RI.classifyDuplicateContext({
      dup: DUP, cls: { productName: HERE[0], reviewText: HERE[0] }, exp: { productNames: HERE }, ...CTX });
    assert.strictEqual(r.verdict, 'warn', '★ 두 작업의 상품이 같으면 자동 통과하지 않는다');
    ok('B1: ★ 같은 상품(차수 재참여)은 자동 통과 금지 — warn 까지');

    // 다른 작업 기대값 조회 실패 → warn(판정을 pass 로 바꾸지 않는다)
    RI.__setPoolForTest({ query: async () => { throw new Error('db down'); } });
    const r2 = await RI.classifyDuplicateContext({
      dup: DUP, cls: { productName: OTHER[0], reviewText: HERE[0] }, exp: { productNames: HERE }, ...CTX });
    assert.strictEqual(r2.verdict, 'warn', '★ 모르면 완화하지 않는다(fail 로도 되돌리지 않는다)');
    ok('B2: ★ 조회 실패 = warn(모르면 통과시키지 않음 · 불량으로도 몰지 않음)');

    // 입력이 없거나 이미 pass 인 판정은 손대지 않는다
    RI.__setPoolForTest(null);
    assert.strictEqual((await RI.classifyDuplicateContext({ dup: { verdict: 'pass' }, ...CTX })).verdict, 'pass');
    assert.strictEqual(await RI.classifyDuplicateContext({ dup: null, ...CTX }), null);
    ok('B3: 중복 아님·입력 없음은 무접촉');
  }

  /* ═══ D. 배선 ═══ */
  console.log('\nD) 배선');
  {
    const svc = read('src/services/reviewInspect.service.js');
    assert.ok(/checks\.duplicate = await classifyDuplicateContext\(\{[\s\S]{0,200}dup: await findDuplicate\(/.test(svc),
      '2차 검수가 findDuplicate 결과를 그대로 완화기에 통과시킨다(사본 금지)');
    assert.ok(/matchSheetId: m\.sheet_id/.test(svc), '다른 작업 판정에 필요한 sheet_id 동봉');
    ok('D1: inspectSubmission 배선 + matchSheetId');

    const fr = read('src/services/fileRoute.service.js');
    assert.ok(/\['fail', 'warn'\]\.includes\(dup\.verdict\)/.test(fr) && /!dup\.matchFileId/.test(fr),
      "★ 제거 게이트 = 근거(matchFileId) 존재 — 심각도는 게이트가 아니다(완화되면 warn 이 된다)");
    ok('D2: ★ [🗑 중복파일 제거]는 warn 에서도 가능(근거는 여전히 필수)');

    const wd = readFront('workdesk.html');
    assert.ok(/c\.duplicate\.verdict==='fail'\|\|c\.duplicate\.verdict==='warn'/.test(wd),
      'warn 도 중복 유형으로 보여 목록·필터에서 사라지지 않는다');
    assert.ok(/같은 리뷰어가 다른 작업\(\$\{c\.duplicate\.matchTab\|\|''\}\)에도 같은 캡처를 냈습니다/.test(wd)
      && /한 화면에 여러 리뷰가 보이는 캡처일 수 있습니다/.test(wd),
      '★ 근거 문장이 사정을 설명한다(그냥 "중복"이라고 단정하지 않는다)');
    assert.ok(/if\(c\.duplicate&&c\.duplicate\.sameReviewerOtherTab\)[\s\S]{0,160}A\.ok,t:'✓ 정상 — 한 캡처에 여러 리뷰'/.test(wd),
      '★★ 그 경우 주 조치는 [✓ 정상] — 제거를 주 조치로 두면 정상 제출을 지우는 쪽으로 손이 간다');
    assert.ok(/subs:\[A\.dedup,A\.bad\]/.test(wd), '제거는 보조로 남긴다(사람이 고를 수 있게)');
    assert.ok(/\['fail','warn'\]\.includes\(dup\.verdict\)/.test(wd), '제거 팝업도 warn 허용(서버 게이트와 1:1)');
    ok('D3: ★★ 카드 — 유형 유지 · 사정 설명 · 주 조치 뒤집기 · 제거는 보조');

    const sa = readFront('js/search-app.js');
    assert.ok(/d\.sameTab \? ''/.test(sa) && /한 화면에 두 리뷰가 같이 보이는 캡처/.test(sa),
      '★ 첨부 즉시 안내도 다른 작업 건은 "그대로 제출해도 된다"를 말한다(맞게 한 리뷰어가 헤매지 않게)');
    ok('D4: ★ 리뷰어 첨부 안내 — 다른 작업 건은 정상일 수 있음을 함께 안내');
  }

  console.log(`\n✅ duplicateMultiReview 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
