/**
 * sheetlessProductSlotMatch.test.js — 상품 단위 선택이 엉뚱한 상품 줄에 들어가던 사고 (2026-10-01)
 *
 * 사고: 작업표는 줄마다 상품을 미리 나눠 적어 두는데(V2 #1264), 주문은 상품을 보지 않고 아무 빈 줄에
 *   들어가고(#1349) 상품 칸은 blank-only 라, 미리 적힌 다른 상품이 그대로 남았다
 *   (친구사이 13 · 고양이사료 112 · 든든푸드 78 · 데일리 후드 21줄 — 업체 화면에도 그대로 노출).
 * 고정:
 *   [1] 표기 짝짓기 — 정확일치 → 포함 관계가 하나로 정해질 때만 · 애매하면 '' (추측 금지)
 *   [2] 그 상품으로 정해진 빈 줄을 먼저 · 동났으면 같은 리뷰옵션 줄 먼저 · 상품 표기 1종이면 종전 그대로
 *   [3] 처음 채우는 줄만 상품 칸을 덮는다(재기록은 blank-only 그대로)
 *   [4] 옵션 키가 있는 선택(1·2차 옵션 포함)은 이 경로를 타지 않는다
 * 실행: node tests/sheetlessProductSlotMatch.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/services/sheetlessOrder.service');

let failed = 0, n = 0;
const ok = (msg, cond) => { n++; if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };

const HEADERS = ['번호', '구매일자', '상품', '리뷰옵션', '수취인', '연락처'];
const row = (id, seq, prod, rv = '') => ({ id, seq, option_text: prod, row_json: { 구매일자: '', 상품: prod, 리뷰옵션: rv } });

function stubClient({ cands = [], labels = null, filled = [] } = {}) {
  const locked = new Set();
  const seen = [];
  return {
    seen,
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ');
      seen.push(q);
      if (/WHERE cp\.id = \$1/.test(q) && /FOR UPDATE SKIP LOCKED/.test(q)) {
        const r = cands.find(x => x.id === params[0]);
        if (!r || locked.has(r.id)) return { rows: [] };
        locked.add(r.id); return { rows: [r] };
      }
      if (/SELECT DISTINCT btrim\(option_text\) AS l/.test(q)) {
        const all = labels || [...new Set(cands.map(c => c.option_text).filter(Boolean))];
        return { rows: all.map(l => ({ l })) };
      }
      if (/LIMIT 500/.test(q)) return { rows: filled.filter(f => f.option_text === params[2]) };
      if (/ORDER BY cp\.seq LIMIT 3000/.test(q)) return { rows: cands };
      return { rows: [] };
    },
  };
}
const pick = (client, productPick, key = '') => S.__pickOpenSlotForTest(client, {
  sheetId: 'S', tabName: 'T', workboardId: null, scheduledOptionKey: key,
  orderSubmissionId: '00000000-0000-0000-0000-000000000001', headers: HEADERS, where: 'WHERE 1=1', productPick,
});

(async () => {
  console.log('[1] 표기 짝짓기');
  const R = S.resolveProductLabel;
  const L = ['HIA-1400HM / 옵션 : 누쓰쓰 응원특가', 'HA-HD2300L / 옵션 : 누쓰쓰 응원특가', 'HA-HD1500'];
  ok('정확일치', R('HA-HD1500', L) === 'HA-HD1500');
  ok('공백·대소문자 무시', R('ha-hd 1500', L) === 'HA-HD1500');
  ok('공고 표기가 작업표 표기를 품으면 짝', R('6.웜 블렌드 티셔츠 아이보리 - 결제금액 94,200원(3천원 쿠폰적용', ['웜 블렌드 티셔츠 아이보리', '웜 블렌드 티셔츠 블랙']) === '웜 블렌드 티셔츠 아이보리');
  ok('여럿이 걸리면 나머지를 품는 가장 긴 표기', R('웜 블렌드 티셔츠 블랙 세트', ['블랙', '웜 블렌드 티셔츠 블랙']) === '웜 블렌드 티셔츠 블랙');
  ok('★ 애매하면 짝짓지 않는다', R('티셔츠', ['티셔츠 블랙', '티셔츠 화이트']) === '');
  ok('공백만 다른 표기가 둘이면 어느 쪽인지 정할 수 없어 짝짓지 않는다', R('HA-HD1500', ['HA-HD1500', 'HA - HD1500']) === '');
  ok('표기가 없으면 짝짓지 않는다', R('A', []) === '' && R('', L) === '');

  console.log('[2] 빈 줄 고르기');
  {
    const c = stubClient({ cands: [row('a', 2, 'HIA-1400HM / 옵션 : 누쓰쓰 응원특가'), row('b', 3, 'HA-HD2300L / 옵션 : 누쓰쓰 응원특가'), row('c', 30, 'HA-HD1500')] });
    const r = await pick(c, 'HA-HD1500');
    ok('★ 고른 상품으로 정해진 빈 줄을 먼저(번호가 뒤여도)', r.rows[0] && r.rows[0].id === 'c' && r.productKey === 'HA-HD1500');
  }
  {
    const c = stubClient({
      cands: [row('a', 2, 'A', '텍스트'), row('b', 3, 'B', '포토')],
      labels: ['A', 'B', 'C'],
      filled: [row('f1', 9, 'C', '포토'), row('f2', 10, 'C', '포토')],
    });
    const r = await pick(c, 'C');
    ok('★ 그 상품 줄이 동났으면 같은 리뷰옵션 줄을 먼저', r.rows[0] && r.rows[0].id === 'b' && r.productKey === 'C');
  }
  {
    const c = stubClient({ cands: [row('a', 2, '쟈니베어 요가블럭 프리미엄'), row('b', 3, '쟈니베어 요가블럭 프리미엄')] });
    const r = await pick(c, '쿠팡 쟈니베어 요가블럭');
    ok('상품 표기가 1종뿐인 작업은 종전 그대로(짝짓지 않고 덮지도 않음)', r.productKey === '' && !r.productWrite && r.rows[0].id === 'a');
  }
  {
    const c = stubClient({ cands: [row('a', 2, '티셔츠 블랙'), row('b', 3, '티셔츠 화이트')] });
    const r = await pick(c, '티셔츠');
    ok('짝을 못 지으면 줄 고르기는 종전 그대로', r.productKey === '' && r.rows[0].id === 'a');
    ok('★ 그래도 상품 2종 이상이면 고른 상품 원문을 적는다(미리 적힌 다른 상품을 남기지 않음)', r.productWrite === '티셔츠');
  }
  {
    const c = stubClient({ cands: [row('a', 2, 'A'), row('b', 3, 'B')] });
    const r = await pick(c, 'B', '상품 · 블랙 · L');
    ok('[4] 옵션 키가 있는 선택은 상품 우선순위를 쓰지 않는다', r.productKey === '' && !c.seen.some(q => /SELECT DISTINCT btrim\(option_text\)/.test(q)));
  }

  console.log('[3] 상품 칸 덮기');
  {
    const out = S.buildRowPatch(HEADERS, { selectedProduct: 'HA-HD1500' }, { 상품: 'HIA-1400HM' }, { productOverwrite: true });
    ok('★ 처음 채우는 줄은 미리 적힌 상품을 실제 선택으로 덮는다', out.patch['상품'] === 'HA-HD1500' && !out.productSuppressed.length);
    const keep = S.buildRowPatch(HEADERS, { selectedProduct: 'HA-HD1500' }, { 상품: 'HIA-1400HM' });
    ok('재기록(옵션 없음)은 종전 blank-only 그대로', keep.patch['상품'] === undefined && keep.productSuppressed.length === 1);
  }

  console.log('[4] 배선');
  const sl = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sheetlessOrder.service.js'), 'utf8');
  ok('처음 고른 빈 줄일 때만 덮는다', /cur = picked\.rows;\s*freshClaim = cur\.length > 0;/.test(sl) && /const productOverwrite = freshClaim && !!claimedProductKey;/.test(sl));
  ok('덮는 값은 짝지은 작업표 표기(없으면 원문)', /selectedProduct: claimedProductKey/.test(sl) && /claimedProductKey = picked\.productWrite/.test(sl));
  ok('★ 슬롯 거르기(where)는 상품을 보지 않는다 — 우선순위만', !/\$4 = ''[\s\S]{0,200}selected_product/.test(sl) && /productPick: scheduledOptionKey \? '' :/.test(sl));
  ok('원장 selected_product 는 원문 그대로(작업표 표기로 바꾸지 않는다)', !/UPDATE order_submissions SET selected_product/.test(sl));

  console.log(`\n${failed ? '❌' : '✅'} sheetlessProductSlotMatch: ${n - failed}/${n}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
