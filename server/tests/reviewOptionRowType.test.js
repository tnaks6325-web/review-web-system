/**
 * reviewOptionRowType.test.js — 리뷰옵션(행별 리뷰형태) 행 단위 검수 연동 회귀가드 (2026-08-19 사용자 확정).
 *
 * 지키는 것:
 *  ① **판정 단일 출처** — 행 값 추출은 `utils/reviewType.rowOptionReviewType`(리뷰옵션 칸 우선),
 *     어떤 칸을 읽을지는 `orderLedger.optionWriteColumns`(매퍼 파생). 키워드 사본 금지.
 *  ② **혼합 오더의 구매확정 행 인정** — 2차 검수·업로드 검수·1차 필터가 행 값을 우선 본다
 *     (`resolveReviewType` ① 행 우선). 탭/공고가 mixed 라 null 로 떨어지는 자리를 행이 메운다.
 *  ③ **fail-open** — 조회 실패·행 미연결·값 없음 = 탭/공고 판정 그대로(오늘 동작).
 *
 * 실행: node tests/reviewOptionRowType.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const RT = require('../src/utils/reviewType');
const { optionWriteColumns } = require('../src/services/orderLedger.service');

/* ── ① 순수함수: rowOptionReviewType — 실제 optionWriteColumns 로 실행한다 ── */
console.log('\n① 행 값 추출(rowOptionReviewType × optionWriteColumns 실제 실행)');
const rowType = (rowJson) => {
  const headers = Object.keys(rowJson);
  return RT.rowOptionReviewType(rowJson, optionWriteColumns(headers).map(i => headers[i]));
};
ok('리뷰옵션 칸의 구매확정을 읽는다(작업표 생성이 적는 표기)',
  rowType({ '번호': '1', '구매일자': '8 / 19 (수)', '리뷰옵션': '구매확정', '수취인': '' }) === 'confirm');
ok('포토리뷰·텍스트·별점 표기가 표준 key 로 돌아온다(왕복)',
  rowType({ '리뷰옵션': '포토리뷰' }) === 'photo'
  && rowType({ '리뷰옵션': '텍스트' }) === 'text'
  && rowType({ '리뷰옵션': '별점' }) === 'star');
ok('★★ 리뷰옵션 칸이 상품옵션 칸보다 먼저다 — 상품옵션 값("포토 카드지갑")이 행 판정을 가로채면 혼합 오더의 구매확정 행이 리뷰로 잘못 검수된다',
  rowType({ '옵션': '포토 카드지갑', '리뷰옵션': '구매확정' }) === 'confirm');
ok('시트 시절 손기입(제네릭 옵션 칸의 텍스트/포토리뷰)도 읽는다 — ㉯ 관행 무회귀',
  rowType({ '옵션': '텍스트', '수취인': '' }) === 'text');
ok('상품옵션 값(블랙 L)은 리뷰타입이 아니다 → null(= 탭/공고 판정 그대로)',
  rowType({ '옵션': '블랙 L' }) === null);
ok('★ 옵션금액(결제금액 칸)·비고(옵션확인) 값은 애초에 안 읽는다 — optionWriteColumns 매퍼 파생 판정',
  rowType({ '옵션금액': '구매확정', '비고(옵션확인)': '포토리뷰' }) === null);
ok('혼합·빈 값·행 없음은 null',
  rowType({ '리뷰옵션': '혼합' }) === null && rowType({ '리뷰옵션': '' }) === null
  && RT.rowOptionReviewType(null, []) === null);
ok('★ resolveReviewType ① 행 우선 — 행 값이 공고(mixed 아님)보다도 이긴다',
  RT.resolveReviewType({ rowOption: '구매확정', campaignType: 'photo' }) === 'confirm'
  && RT.resolveReviewType({ rowOption: null, campaignType: 'confirm' }) === 'confirm'
  && RT.resolveReviewType({ rowOption: null, campaignType: 'mixed' }) === null);

/* ── ② reviewTypeForRow — 스텁 pool 로 실제 실행 ── */
console.log('\n② reviewTypeForRow(스텁 pool 실행)');
(async () => {
  const ctx = require('../src/services/reviewTypeContext.service');

  const mkPool = (impl) => ({ query: impl });
  // 정상: row_json 에서 confirm
  ctx.__setPoolForTest(mkPool(async (sql, params) => {
    assert(/FROM review_index/.test(sql) && /row_index = \$3/.test(sql), 'review_index 행 조회');
    assert.deepStrictEqual(params, ['s1', 't1', 7]);
    return { rows: [{ row_json: { '번호': '7', '리뷰옵션': '구매확정' } }] };
  }));
  ok('행의 리뷰옵션 값을 표준 key 로 돌려준다',
    (await ctx.reviewTypeForRow({ sheetId: 's1', tabName: 't1', rowIndex: '7' })) === 'confirm');

  // 행 없음 → null
  ctx.__setPoolForTest(mkPool(async () => ({ rows: [] })));
  ok('행이 없으면 null(= 오늘 동작)', (await ctx.reviewTypeForRow({ sheetId: 's1', tabName: 't1', rowIndex: 7 })) === null);

  // 조회 실패 → null (throw 금지 — 검수·업로드가 행 판정 때문에 죽으면 안 된다)
  ctx.__setPoolForTest(mkPool(async () => { throw new Error('42P01'); }));
  ok('★ 조회 실패는 null — throw 하지 않는다(fail-open)',
    (await ctx.reviewTypeForRow({ sheetId: 's1', tabName: 't1', rowIndex: 7 })) === null);

  // 입력 미비 → 쿼리 자체를 안 보낸다
  let called = 0;
  ctx.__setPoolForTest(mkPool(async () => { called++; return { rows: [] }; }));
  const r1 = await ctx.reviewTypeForRow({ sheetId: 's1', tabName: 't1' });
  const r2 = await ctx.reviewTypeForRow({ sheetId: 's1', tabName: 't1', rowIndex: 'abc' });
  ok('rowIndex 없음·비숫자는 조회 0회 + null', r1 === null && r2 === null && called === 0);
  ctx.__setPoolForTest(null);

  /* ── ③ 소비처 배선(문자열 고정 — 스코프는 함수 본문으로 자른다) ── */
  console.log('\n③ 소비처 배선');
  const inspectSrc = readS('services/reviewInspect.service.js');
  const inspBody = inspectSrc.slice(inspectSrc.indexOf('async function inspectSubmission'));
  ok('2차 검수: 행 우선 유효 리뷰타입으로 형식 판정(_okKinds)',
    /reviewTypeForRow\(\{ sheetId, tabName, rowIndex \}\)/.test(inspBody)
    && /resolveReviewType\(\{ rowOption: _rowType, campaignType: exp\.reviewType \}\)/.test(inspBody)
    && /effReviewType === 'confirm' \? \['review', 'purchase_confirm'\] : \['review'\]/.test(inspBody));
  const diagSrc = readS('routes/diag.routes.js');
  const preBody = diagSrc.slice(diagSrc.indexOf("router.post('/review-precheck'"), diagSrc.indexOf("router.post('/review-upload'"));
  ok('1차 필터: 행을 알면(rowIndex) 행 값이 탭 값을 덮는다 — 혼합 탭 구매확정 행의 안전핀',
    /reviewTypeForRow\(\{ sheetId, tabName, rowIndex \}\)/.test(preBody)
    && /if \(rt\) reviewType = rt;/.test(preBody));
  ok('★ 1차 필터의 행 판정도 fail-open(try/catch — 조회 실패가 첨부를 막지 않는다)',
    /if \(rowIndex\) \{\s*try \{[\s\S]{0,220}reviewTypeForRow[\s\S]{0,120}\} catch \(_\) \{\}/.test(preBody));
  const upBody = diagSrc.slice(diagSrc.indexOf("router.post('/review-upload'"), diagSrc.indexOf('// STEP 3') > 0 ? diagSrc.length : diagSrc.length);
  ok('업로드 검수: verifyCapture 는 행 우선(_effReviewType) · 폴더 라벨(slotLabelOf)은 탭 값 그대로',
    /const _effReviewType = _rowReviewType \|\| _tabReviewType/.test(upBody)
    && /reviewType: _effReviewType/.test(upBody)
    && /slotLabelOf\(tabRows\[0\]\?\.capture_slots, tabRows\[0\]\?\.income_type, slot, _tabReviewType\)/.test(upBody));

  console.log(`\n✅ reviewOptionRowType: ${n}개 통과`);
  process.exit(0);
})().catch(e => { console.error('❌ 실패:', e && e.message); process.exit(1); });
