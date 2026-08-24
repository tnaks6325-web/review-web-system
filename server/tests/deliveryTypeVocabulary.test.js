/**
 * 배송유형 5종 계약 — 실배송 · 빈박스 · 택배발송대행 · 회수 · 혼합 (사용자 확정 2026-08-24).
 *
 * 지키는 것:
 *   A. 어휘·판정 단일 출처(`utils/deliveryType`) — 회수·혼합은 **부속정보가 붙은 문장**으로 온다
 *   B. `LEGACY_DELIVERY_VALUES` 와 **분리** — `혼합` 이 섞이면 접수가 혼합 리뷰 탭을 파괴한다
 *   C. 작업표 — 혼합 행 배분 · 회수 부속 열 · **실배송/빈박스 오더 무회귀**
 *   D. 배분기 사본 0 — 리뷰 종류와 배송이 같은 `_allocByDateRatio` 를 쓴다
 *   E. 원장 배선 — INSERT 계수 정합 · 부속 컬럼 · 필드 화이트리스트
 *   F. 화면 — 프론트 어휘 ≡ 서버, 옛 어휘(회수건·빈택배) 부재
 *
 * 실행: node tests/deliveryTypeVocabulary.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const DT = require('../src/utils/deliveryType');
const DM = require('../src/utils/deliveryTypeMix');
const WP = require('../src/utils/worktablePlan');
const { LEGACY_DELIVERY_VALUES } = require('../src/utils/reviewType');

/* ══ A. 어휘·판정 ═══════════════════════════════════════════════════ */
console.log('A) 어휘·판정 단일 출처');

t('어휘는 5종', () => {
  assert.deepStrictEqual(DT.DELIVERY_TYPES, ['실배송', '빈박스', '택배발송대행', '회수', '혼합']);
});

t('회수 문장 → 기본형 + 부속정보', () => {
  const p = DT.parseDeliveryType('회수(회수택배사: CJ대한통운, 회수상품명칭: OO선크림 30ml)');
  assert.strictEqual(p.base, '회수');
  assert.deepStrictEqual(p.recall, { courier: 'CJ대한통운', product: 'OO선크림 30ml' });
  assert.strictEqual(p.mix, null);
});

t('혼합 문장 → 기본형 + 건수', () => {
  const p = DT.parseDeliveryType('혼합(실배송 20건, 빈박스 80건)');
  assert.strictEqual(p.base, '혼합');
  assert.deepStrictEqual(p.mix, { real: 20, empty: 80 });
});

t('부속 한쪽만 와도 읽는다', () => {
  assert.deepStrictEqual(DT.parseDeliveryType('회수(회수택배사: 로젠)').recall, { courier: '로젠', product: '' });
});

t('옛 표기는 읽을 때 접는다(저장값은 안 건드린다)', () => {
  assert.strictEqual(DT.deliveryBaseType('빈택배'), '빈박스');
  assert.strictEqual(DT.deliveryBaseType('회수건'), '회수');
  assert.strictEqual(DT.deliveryBaseType('믹스'), '혼합');
});

t('★ 판정 불가는 빈 값 — 추측하지 않는다', () => {
  assert.strictEqual(DT.deliveryBaseType('기타배송'), '');
  assert.strictEqual(DT.deliveryBaseType(''), '');
  assert.strictEqual(DT.deliveryBaseType(null), '');
});

t('★★ 부속정보가 있으면 저장값은 원문 보존 — 기본형만 남기면 회수택배사가 증발한다', () => {
  const raw = '회수(회수택배사: CJ대한통운, 회수상품명칭: A)';
  assert.strictEqual(DT.canonicalDeliveryValue(raw), raw);
  assert.strictEqual(DT.canonicalDeliveryValue('혼합(실배송 2건, 빈박스 3건)'), '혼합(실배송 2건, 빈박스 3건)');
});

t('맨 토큰만 표준형으로 접는다 / 모르는 값은 원문 통과', () => {
  assert.strictEqual(DT.canonicalDeliveryValue('빈택배'), '빈박스');
  assert.strictEqual(DT.canonicalDeliveryValue('회수건'), '회수');
  assert.strictEqual(DT.canonicalDeliveryValue('기타배송(박스)'), '기타배송(박스)');
});

t('혼합 조합 검증 = 합계가 총 건수와 같아야 한다(리뷰 혼합과 같은 규칙)', () => {
  const ok = DM.normalizeDeliveryTypeMix({ real: 20, empty: 80 });
  assert.strictEqual(DM.validateDeliveryTypeMix('혼합', ok, 100), null);
  assert.ok(/합계\(90건\)/.test(DM.validateDeliveryTypeMix('혼합', DM.normalizeDeliveryTypeMix({ real: 20, empty: 70 }), 100)));
});

t('★ 혼합이 아니면 조합을 검사하지 않는다(다른 유형 저장을 막지 않는다)', () => {
  assert.strictEqual(DM.validateDeliveryTypeMix('실배송', DM.normalizeDeliveryTypeMix({ real: 1, empty: 2 }), 100), null);
});

/* ══ B. LEGACY 분리 ════════════════════════════════════════════════ */
console.log('B) 리뷰타입 오염 판별 목록과의 분리');

t('★★★ 혼합은 LEGACY_DELIVERY_VALUES 에 없다 — 있으면 접수가 혼합 리뷰 탭의 리뷰타입을 갈아치운다', () => {
  assert.ok(!LEGACY_DELIVERY_VALUES.includes('혼합'));
  assert.deepStrictEqual(LEGACY_DELIVERY_VALUES, ['실배송', '빈박스', '택배발송대행']);
});

t('두 목록은 서로 다른 개념 — 어휘 목록이 오염 판별 목록을 대체하지 않는다', () => {
  assert.notDeepStrictEqual(DT.DELIVERY_TYPES, LEGACY_DELIVERY_VALUES);
  const ord = read('src/routes/order.routes.js');
  assert.ok(/LEGACY_DELIVERY_VALUES,\s*\/\/ \$12/.test(ord), '접수 업서트는 여전히 3종 목록을 쓴다');
});

/* ══ C. 작업표 ═════════════════════════════════════════════════════ */
console.log('C) 작업표 — 배분·열·무회귀');

const TPL = { core: ['번호', '구매일자', '주문자', '수취인', '연락처', '결제금액', '리뷰'], channels: { coupang: ['쿠팡ID'] } };
const plan = (wo) => WP.buildWorktablePlan({
  workOrder: Object.assign({ recruit_count: 5, daily_count: 5, start_date: '2026-09-01', product_url: 'https://www.coupang.com/vp/p/1' }, wo),
  template: TPL,
});

t('혼합 → 배송구분 열 자동 추가 + 행별 배분', () => {
  const p = plan({ delivery_type: '혼합(실배송 2건, 빈박스 3건)' });
  assert.ok(p.columns.some((c) => c.name === '배송구분'));
  assert.deepStrictEqual(p.rows.map((r) => r.deliveryKind), ['실배송', '실배송', '빈박스', '빈박스', '빈박스']);
  assert.deepStrictEqual(p.deliveryBuckets, [{ label: '실배송', count: 2 }, { label: '빈박스', count: 3 }]);
});

t('★ 배분 합계가 총 건수와 달라도 비율 유지 + 경고(조용한 보정 금지)', () => {
  const p = plan({ delivery_type: '혼합(실배송 4건, 빈박스 6건)' });   // 합 10 ≠ 총 5
  assert.strictEqual(p.rows.filter((r) => r.deliveryKind).length, 5);
  assert.ok(p.warnings.some((w) => w.code === 'delivery_mix_scaled'));
});

t('회수 → 부속 열 자동 추가 + 줄마다 채움', () => {
  const p = plan({ delivery_type: '회수(회수택배사: CJ대한통운, 회수상품명칭: OO선크림)' });
  assert.ok(p.columns.some((c) => c.name === '회수택배사'));
  assert.ok(p.columns.some((c) => c.name === '회수상품명칭'));
  assert.strictEqual(p.rows[0].recallCourier, 'CJ대한통운');
  assert.strictEqual(p.rows[4].recallProduct, 'OO선크림');
});

t('★ 구조화 컬럼(135)이 문장 파싱을 이긴다', () => {
  const p = plan({
    delivery_type: '회수(회수택배사: 문장값)',
    recall_courier: '구조화값', recall_product: '구조화상품',
  });
  assert.strictEqual(p.rows[0].recallCourier, '구조화값');
  assert.strictEqual(p.rows[0].recallProduct, '구조화상품');
});

t('★★ 무회귀 — 실배송·빈박스 오더는 열·행이 그대로', () => {
  ['실배송', '빈박스'].forEach((v) => {
    const p = plan({ delivery_type: v });
    assert.ok(!p.columns.some((c) => c.name === '배송구분'), v + ': 배송구분 열을 만들지 않는다');
    assert.ok(!p.columns.some((c) => WP.RECALL_HEADERS.includes(c.name)), v + ': 회수 열을 만들지 않는다');
    assert.ok(p.rows.every((r) => !r.deliveryKind && !r.recallCourier), v + ': 행에 값을 적지 않는다');
  });
});

t('★ 한 종류뿐이면 행에 적지 않는다(옵션·리뷰 배분과 같은 규율)', () => {
  const p = plan({ delivery_type: '혼합(실배송 5건, 빈박스 0건)' });
  assert.ok(p.rows.every((r) => !r.deliveryKind));
});

t('트리거 — 기본형으로 판정 · 0건 유형의 열은 만들지 않는다', () => {
  const ev = (k, d) => WP.evalWorkTypeTrigger(k, { workOrder: { delivery_type: d } });
  assert.strictEqual(ev('delivery_real', '실배송'), true);
  assert.strictEqual(ev('delivery_empty', '빈박스'), true);
  assert.strictEqual(ev('delivery_recall', '회수(회수택배사: A)'), true);
  assert.strictEqual(ev('delivery_recall', '실배송'), false);
  assert.strictEqual(ev('delivery_real', '혼합(실배송 20건, 빈박스 80건)'), true);
  assert.strictEqual(ev('delivery_empty', '혼합(실배송 20건, 빈박스 80건)'), true);
  assert.strictEqual(ev('delivery_real', '혼합(실배송 0건, 빈박스 100건)'), false, '0건 유형은 안 켠다');
});

t('★ 조합을 못 읽으면 둘 다 켠다(모른다고 열을 빼면 배분이 갈 곳을 잃는다)', () => {
  const ev = (k) => WP.evalWorkTypeTrigger(k, { workOrder: { delivery_type: '혼합' } });
  assert.strictEqual(ev('delivery_real'), true);
  assert.strictEqual(ev('delivery_empty'), true);
});

t('작업유형 조건 목록에 회수가 있다(화면이 고를 수 있어야 한다)', () => {
  const svc = read('src/services/worktable.service.js');
  assert.match(svc, /\{ key: 'delivery_recall', label: '배송유형이 회수일 때' \}/);
});

t('시트 값 기입 — 배송구분·회수 부속이 실제로 행에 찍힌다', () => {
  const { planToSheetValues } = require('../src/services/worktableCreate.service');
  const mix = planToSheetValues(plan({ delivery_type: '혼합(실배송 2건, 빈박스 3건)' }));
  assert.ok(mix.body.some((r) => r.includes('실배송')) && mix.body.some((r) => r.includes('빈박스')));
  assert.strictEqual(mix.filled.deliveryKind, true);
  const rc = planToSheetValues(plan({ delivery_type: '회수(회수택배사: CJ대한통운, 회수상품명칭: A)' }));
  assert.ok(rc.body[0].includes('CJ대한통운'));
  assert.strictEqual(rc.filled.recall, true);
});

/* ══ D. 배분기 사본 0 ══════════════════════════════════════════════ */
console.log('D) 배분기 사본 0');

t('★ 리뷰 종류와 배송은 같은 _allocByDateRatio 를 쓴다(라벨만 주입)', () => {
  const src = read('src/utils/worktablePlan.js');
  assert.strictEqual((src.match(/function _allocByDateRatio\(/g) || []).length, 1, '배분기는 한 벌');
  assert.match(src, /function _allocByDateRatio\(rowIdxs, dateOf, mix, out, labelOf\)/);
  assert.match(src, /_allocByDateRatio\([\s\S]{0,200}DELIVERY_MIX_SHEET_LABELS/, '배송은 라벨을 주입해 같은 배분기를 쓴다');
});

t('★ 어휘 판정 사본 0 — worktablePlan 은 utils/deliveryType 을 쓴다', () => {
  const src = read('src/utils/worktablePlan.js');
  assert.match(src, /require\('\.\/deliveryType'\)/);
  assert.ok(!/\/\^실\\s\*배송\$\//.test(src), '배송유형 정규식을 여기서 다시 만들지 않는다');
});

/* ══ E. 원장 배선 ══════════════════════════════════════════════════ */
console.log('E) 작업오더 원장 배선');

const ORD = read('src/routes/order.routes.js');

t('판정을 유틸로 이관했다(어휘 사본 금지)', () => {
  assert.match(ORD, /require\('\.\.\/utils\/deliveryType'\)/);
  assert.match(ORD, /return canonicalDeliveryValue\(raw\);/);
  assert.match(ORD, /return isCourierProxyDelivery\(v\);/);
});

/* 최상위 콤마만 세어 배열 원소 수를 구한다(중첩 호출·문자열 안의 콤마는 제외). */
function _topLevelItems(src) {
  const clean = src.replace(/\/\/.*$/gm, '');
  let depth = 0, count = 1, quote = null;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) count++;
  }
  const body = clean.trim();
  if (!body) return 0;
  // ★ 마지막 원소 뒤 콤마(trailing comma)를 원소로 세지 않는다 — 1 차이로 조용히 빨개진다.
  return body.endsWith(',') ? count - 1 : count;
}

t('★★ INSERT — 컬럼 수 ≡ VALUES 항목 수 ≡ **파라미터 배열 개수**', () => {
  const m = ORD.match(/INSERT INTO work_orders\s*\n\s*\(([\s\S]*?)\)\s*\n\s*VALUES \(([^)]*)\)/);
  assert.ok(m, 'INSERT 문 추출');
  const cols = m[1].split(',').map((x) => x.trim()).filter(Boolean);
  const vals = m[2].split(',').map((x) => x.trim()).filter(Boolean);
  assert.strictEqual(cols.length, vals.length, '컬럼 수 ≡ VALUES 항목 수');
  ['delivery_type_mix', 'recall_courier', 'recall_product'].forEach((c) => assert.ok(cols.includes(c), c));

  /* ★★ 자리표시자만 세면 "컬럼은 늘렸는데 파라미터를 빠뜨린" 변이를 놓친다(변이시험 실측).
     실제 파라미터 배열 원소 수까지 세야 런타임 bind 오류를 커밋 전에 잡는다. */
  const ph = new Set(vals.filter((v) => v.startsWith('$')));
  const at = ORD.indexOf('     RETURNING *`,', ORD.indexOf('INSERT INTO work_orders'));
  const open = ORD.indexOf('[', at);
  const close = ORD.indexOf('\n    ]', open);
  assert.ok(open > 0 && close > open, '파라미터 배열 추출');
  assert.strictEqual(_topLevelItems(ORD.slice(open + 1, close)), ph.size, '파라미터 개수 ≡ 자리표시자 수');
});

t('★★ source revision UPDATE — 파라미터 개수 ≡ 자리표시자 수', () => {
  const at = ORD.indexOf('WHERE id = $1 AND source_review_order_id = $40');
  assert.ok(at > 0, 'source UPDATE 추출');
  const maxPh = Math.max(...[...ORD.slice(at - 1400, at + 80).matchAll(/\$(\d+)/g)].map((x) => +x[1]));
  const open = ORD.indexOf('[', at);
  const close = ORD.indexOf('\n      ]', open);
  assert.strictEqual(_topLevelItems(ORD.slice(open + 1, close)), maxPh);
});

t('부속정보 파생 — 구조화 우선, 문장 폴백, 종류가 다르면 비운다', () => {
  assert.match(ORD, /function _deliveryMixJson/);
  assert.match(ORD, /function _recallFields/);
  assert.match(ORD, /if \(deliveryBaseType\(deliveryType\) !== '혼합'\) return '\[\]';/);
  assert.match(ORD, /if \(deliveryBaseType\(deliveryType\) !== '회수'\) return \{ courier: '', product: '' \};/);
});

t('★★ 배송유형을 바꾸면 부속정보도 다시 세운다 — 옛 조합이 남으면 작업표가 유령 배분을 돈다', () => {
  const hits = (ORD.match(/b\.delivery_type_mix = _deliveryMixJson\(b, deliveryType\);/g) || []).length;
  assert.strictEqual(hits, 3, '수정 경로 3곳(인트라넷 intake · AE · 관리자) 전부에 정리가 걸려야 한다');
  assert.strictEqual((ORD.match(/b\.recall_courier = _rc\.courier;/g) || []).length, 3);
});

t('수정 화이트리스트 3종(인트라넷 intake · 관리자)', () => {
  ['delivery_type_mix', 'recall_courier', 'recall_product'].forEach((f) => {
    assert.ok((ORD.match(new RegExp("'" + f + "'", 'g')) || []).length >= 2, f + ' 이 두 화이트리스트에 있다');
  });
  assert.match(ORD, /_SOURCE_JSON_COLUMNS = new Set\(\[[^\]]*'delivery_type_mix'/);
});

t('마이그레이션 135 + 부팅 프리플라이트 등록', () => {
  const mig = read('migrations/135_delivery_type_recall_mix.sql');
  ['work_orders', 'recruit_campaigns'].forEach((tb) => {
    ['delivery_type_mix', 'recall_courier', 'recall_product'].forEach((c) => {
      assert.ok(new RegExp('ALTER TABLE ' + tb + '\\s+ADD COLUMN IF NOT EXISTS ' + c).test(mig), tb + '.' + c);
    });
  });
  assert.ok(!/UPDATE|DELETE/i.test(mig), '★ 백필 0 — 배포 즉시 동작 불변');
  const idx = read('index.js');
  assert.match(idx, /\['work_orders', 'delivery_type_mix'\]/);
  assert.match(idx, /\['recruit_campaigns', 'delivery_type_mix'\]/);
});

/* ══ F. 화면 ═══════════════════════════════════════════════════════ */
console.log('F) 화면 어휘');

t('프론트 어휘 ≡ 서버 DELIVERY_TYPES', () => {
  const wod = read('../frontend/js/work-order-detail.js');
  const m = wod.match(/const WO_DELIVERY_TYPES = \[([^\]]*)\]/);
  assert.ok(m);
  assert.deepStrictEqual(m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean), DT.DELIVERY_TYPES);
});

t('모집공고 모달 선택지·토글 5종', () => {
  const rm = read('../frontend/js/recruit-modal.js');
  DT.DELIVERY_TYPES.forEach((v) => {
    assert.ok(rm.includes('<option value="' + v + '">' + v + '</option>'), 'option ' + v);
    assert.ok(rm.includes('data-rf-delivery="' + v + '"'), 'toggle ' + v);
  });
});

t('★ 옛 어휘(회수건·빈택배)는 어느 저장 경로에도 없다', () => {
  ['../frontend/js/recruit-modal.js', '../frontend/js/campaign-cards.js', '../frontend/admin-siand.html'].forEach((f) => {
    const src = read(f);
    assert.ok(!/<option value="회수건">/.test(src), f + ' 회수건');
    assert.ok(!/<option value="빈택배">/.test(src), f + ' 빈택배');
  });
});

t('★ 리뷰어 배지는 아는 어휘일 때만 접는다(모르는 값 삭제 금지)', () => {
  const cc = read('../frontend/js/campaign-cards.js');
  assert.match(cc, /const _DL_BASES = \['실배송', '빈박스', '택배발송대행', '회수', '혼합'\]/);
  assert.match(cc, /_DL_BASES\.indexOf\(head\) >= 0 \? head : raw/);
  assert.match(cc, /_esc\(_dlBadge\(c\.delivery_type\)\)/);
});

console.log('\n✅ deliveryTypeVocabulary: ' + n + '개 통과');
process.exit(0);
