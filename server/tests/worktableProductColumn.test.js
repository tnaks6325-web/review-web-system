/**
 * worktableProductColumn.test.js — 회귀가드: 작업표 「상품」 열 (2026-08-25 실사고)
 * 실행: node tests/worktableProductColumn.test.js
 *
 * 사고(「업소용 간장」 · 상품 3종 · 22명 참여): 선택지가 "옵션 없는 상품"(unit_kind='product')이면
 *   제출 경로가 시트 옵션 칸에 쓸 값을 **일부러 비운다**(8/3 상품명이 작업지시 칸을 덮은 사고 규율).
 *   그런데 상품명을 적을 다른 칸이 없어 **고른 상품이 표·원장 어디에도 안 남았고 경고조차 없었다**
 *   (고른 값이 빈 값으로 넘어와 "안 골랐다"로 보였기 때문).
 *
 * 고정하는 것:
 *  A. 매퍼 — 정확일치 「상품」만 열고, 상품명·상품URL 은 계속 보호열. 값 없으면 **안 씀**(무회귀)
 *  B. 옵션 칸 판정 **불변** — 리뷰옵션은 여전히 옵션 칸(리뷰어 안내·검수 판정이 그 목록을 쓴다)
 *  C. 좌측 정렬 = 상품 > 옵션 > 리뷰옵션 (사용자 확정 2026-08-25)
 *  D. 원장 저장·재기록 재료 — 빠지면 재기록 한 번에 도로 사라진다
 *  E. blank-only + **조용한 누락 차단**(칸이 없으면 소리 내어 알린다)
 *  F. 작업표 생성이 상품 2종 이상이면 「상품」 열을 덧붙인다(문턱·무회귀 포함)
 *  G. 서비스 실제 실행 — 게이트 fail-closed · dryRun 쓰기 0 · 참여 기록 폴백 · 쓰기 표면 3곳
 *  H. 공고 저장 훅 배선(fail-soft)
 *  I. 스키마 프리플라이트 등록
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const LEDGER = require('../src/services/orderLedger.service');
const SVC = require('../src/services/worktableProductColumn.service');
const PLAN = require('../src/utils/worktablePlan');
const { buildRowPatch } = require('../src/services/sheetlessOrder.service');

/* ── A. 매퍼 규칙 ───────────────────────────────────────────────────────── */
console.log('\n[A] 매퍼 — 「상품」 정확일치만 열고 나머지 상품류는 보호열');
{
  const H = ['번호', '구매일자', '상품', '옵션', '리뷰옵션', '상품명', '상품URL', '상품아이디'];
  const m = LEDGER.mapOrderToSheetRow(H, { selectedProduct: '진간장 S', selectedOptKey: '13L' });
  ok('「상품」 칸에 고른 상품이 들어간다', m[2] === '진간장 S');
  ok('★ 상품명은 계속 관리자 보호열(안 씀)', m[5] === null);
  ok('★ 상품URL도 보호열', m[6] === null);
  ok('★ 상품아이디도 보호열', m[7] === null);

  const m0 = LEDGER.mapOrderToSheetRow(H, { selectedOptKey: '13L' });
  ok('★★ 상품 값이 없으면 「상품」 칸에 아무것도 안 쓴다(무회귀의 근거)', m0[2] === null);
  ok('★★ 빈 문자열이 아니다 — 빈 문자열은 그 칸을 지우는 쓰기가 된다', m0[2] !== '');

  ok('기입 칸 판정은 매퍼 파생', LEDGER.productWriteColumns(H).join(',') === '2');
  ok('「상품」 칸이 없으면 기입 칸도 없다', LEDGER.productWriteColumns(['번호', '옵션']).length === 0);
  ok('열 이름 단일 출처', LEDGER.PRODUCT_HEADER === '상품');
}

/* ── B. 옵션 칸 판정 불변 ───────────────────────────────────────────────── */
console.log('\n[B] 옵션 칸 판정 불변 — 리뷰어 안내·검수가 이 목록을 함께 쓴다');
{
  const H = ['번호', '상품', '옵션', '리뷰옵션'];
  const optCols = LEDGER.optionWriteColumns(H).map(i => H[i]);
  ok('★ 리뷰옵션은 상품 옵션 기입처에서 제외한다(주문 옵션이 리뷰형태를 덮지 않는다)',
    !optCols.includes('리뷰옵션'), optCols.join(','));
  ok('「상품」 칸은 옵션 칸이 아니다', !optCols.includes('상품'), optCols.join(','));
  ok('옵션 칸 목록에 상품·리뷰옵션이 섞이지 않는다', optCols.join(',') === '옵션');
}

/* ── C. 좌측 정렬 우선순위 ──────────────────────────────────────────────── */
console.log('\n[C] 좌측 정렬 = 상품 > 옵션 > 리뷰옵션');
{
  const r = SVC.withProductColumn(['번호', '구매일자', '옵션', '리뷰옵션', '수취인']);
  ok('★ 「상품」은 옵션 칸 **바로 앞**', r.headers.join('|') === '번호|구매일자|상품|옵션|리뷰옵션|수취인', r.headers.join('|'));
  const r2 = SVC.withProductColumn(['번호', '구매일자', '수취인']);
  ok('옵션 칸이 없으면 자동 열 바로 뒤', r2.headers.join('|') === '번호|구매일자|상품|수취인');
  const r3 = SVC.withProductColumn(['번호', '리뷰옵션', '수취인']);
  ok('★ 리뷰옵션은 상품옵션 칸이 아니므로 그 앞으로 가지 않는다', r3.headers.join('|') === '번호|상품|리뷰옵션|수취인', r3.headers.join('|'));
  ok('이미 있으면 만들지 않는다', SVC.withProductColumn(['번호', '상품']).added === false);
  ok('만들지 않을 때 헤더 그대로', SVC.withProductColumn(['번호', '상품']).headers.join('|') === '번호|상품');
  const cells = SVC.productCellValues(r.headers, '진간장 S');
  ok('소급 값도 매퍼가 정한다', cells.get('상품') === '진간장 S' && cells.size === 1);
  ok('빈 선택은 아무 칸도 채우지 않는다', SVC.productCellValues(['상품'], '').size === 0);
}

/* ── D. 원장 저장·재기록 재료 ───────────────────────────────────────────── */
console.log('\n[D] 원장 저장 · 재기록 재료');
{
  const s = read('src/services/orderLedger.service.js');
  const m = /INSERT INTO order_submissions\s*\(([\s\S]*?)\)\s*VALUES \(([^)]*)\)/.exec(s);
  const cols = m[1].split(',').map(x => x.trim()).filter(Boolean);
  const vals = m[2].split(',').map(x => x.trim()).filter(Boolean);
  ok('★ INSERT 컬럼 수 ≡ VALUES 자리 수', cols.length === vals.length, `${cols.length} vs ${vals.length}`);
  ok('원장에 selected_product 를 넣는다', cols.includes('selected_product'));
  const pm = /const orderInsertParams = \[([\s\S]*?)\n  \];/.exec(s);
  const items = pm[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').split(',').map(x => x.trim()).filter(Boolean);
  const ph = vals.filter(v => v.startsWith('$')).length;
  ok('★ 자리표시자 수 ≡ 파라미터 수', items.length === ph, `${items.length} vs ${ph}`);
  ok('마지막 파라미터가 선택 상품', /selectedProduct/.test(items[items.length - 1]));

  ok('재기록 재료 ①(_osRowToOrderData)에 선택 상품', /selectedProduct: os\.selected_product/.test(s));
  ok('재기록 재료 ②(reconcile)에 선택 상품', /selectedProduct: row\.selected_product/.test(s));
  ok('reconcile SELECT 이 그 컬럼을 읽는다', /os\.selected_product/.test(s));
  const sl = read('src/services/sheetlessOrder.service.js');
  ok('재기록 재료 ③(무시트 복구)에 선택 상품', /selectedProduct: row\.selected_product/.test(sl));
  ok('무시트 복구 SELECT 이 그 컬럼을 읽는다', /os\.selected_product/.test(sl));

  const sub = read('src/routes/submit.routes.js');
  ok('제출이 홀드에서 상품명을 읽는다', /co\.product_name AS product_name/.test(sub));
  ok('★ 옵션 칸을 비우는 규율은 그대로', /unitKind === 'product'\) \? '' : effectiveOptKey/.test(sub));
  ok('제출이 상품을 실어 보낸다', /selectedProduct: \(holdCtx && holdCtx\.productName\)/.test(sub));
  const mo = read('src/services/manualOrder.service.js');
  ok('외부모집 수동제출도 같은 규칙', /selectedProduct: resolvedProduct/.test(mo) && /unit_kind, product_name/.test(mo));
}

/* ── E. blank-only · 조용한 누락 차단 ───────────────────────────────────── */
console.log('\n[E] blank-only · 칸이 없으면 소리 내어 알린다');
{
  const H = ['번호', '상품', '옵션', '수취인'];
  const a = buildRowPatch(H, { selectedProduct: '진간장 S' }, {});
  ok('빈 칸에는 기입한다', a.patch['상품'] === '진간장 S');
  ok('기입했으면 누락 신호 없음', a.productUnmapped === '');

  const b = buildRowPatch(H, { selectedProduct: '진간장 S' }, { 상품: '관리자가 적어둔 값' });
  ok('★ 값이 있는 칸은 덮지 않는다(blank-only)', b.patch['상품'] === undefined);
  ok('보존한 사실을 말한다', b.productSuppressed.length === 1);
  ok('보존은 누락이 아니다(다른 신호)', b.productUnmapped === '');

  const c = buildRowPatch(['번호', '옵션', '수취인'], { selectedProduct: '진간장 S' }, {});
  ok('★★ 「상품」 칸이 없으면 누락을 알린다(이번 사고가 침묵했던 자리)', c.productUnmapped === '진간장 S');

  const d = buildRowPatch(H, { selectedOptKey: '13L' }, {});
  ok('★ 고른 상품이 없으면 상품 칸을 건드리지 않는다(무회귀)', d.patch['상품'] === undefined && d.productUnmapped === '');

  ok('옵션 누락 신호는 그대로', buildRowPatch(['번호'], { selectedOptKey: '13L' }, {}).optionUnmapped === '13L');
  const src = read('src/services/sheetlessOrder.service.js');
  ok('누락은 시스템 오류로그로도 남는다', /step: 'product_column_missing'/.test(src));
}

/* ── F. 작업표 생성 ─────────────────────────────────────────────────────── */
console.log('\n[F] 작업표 생성 — 상품 2종 이상이면 열을 덧붙인다');
{
  const template = { core: ['번호', '구매일자', '수취인', '연락처', '주소', '결제금액', '주문번호', '리뷰', '입금', '비고'], channels: {}, workTypes: [] };
  const plan = (poj, extra) => PLAN.buildWorktablePlan({
    workOrder: Object.assign({ recruit_count: 70, start_date: '2026-08-24', product_options_json: poj, product_url: 'https://www.coupang.com/x' }, extra || {}),
    template,
  });
  const names = p => p.columns.map(c => c.name).join('|');

  const a = plan(JSON.stringify([{ name: '진간장 F', options: [] }, { name: '진간장', options: [] }, { name: '진간장 S', options: [] }]));
  ok('★★ 상품 3개(옵션 0개)면 「상품」 열이 생긴다 — 이번 사고의 모양', /\|상품\|/.test(names(a)), names(a));
  ok('생성 사실을 말한다(조용한 자동 추가 금지)', (a.warnings || []).some(w => w.code === 'product_column_added'));

  const b = plan(JSON.stringify([{ name: '제주 세트', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }]));
  ok('★ 상품 1개면 만들지 않는다(고를 여지가 없다)', !/\|상품\|/.test(names(b)), names(b));
  ok('옵션 열은 종전대로 생긴다(무회귀)', /\|옵션\|/.test(names(b)));

  const c = plan(JSON.stringify([
    { name: '상품A', options: [{ label: '옵1', count: 20, review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] }, { label: '옵2', count: 20, review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] }] },
    { name: '상품B', options: [{ label: '옵3', count: 20, review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] }, { label: '옵4', count: 20, review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] }] },
  ]), { review_type: '혼합', recruit_count: 80 });
  const cn = c.columns.map(x => x.name);
  ok('★★ 최대 조합(상품2 x 옵션2 x 리뷰혼합) 순서 = 상품 > 옵션 > 리뷰옵션',
    cn.indexOf('상품') < cn.indexOf('옵션') && cn.indexOf('옵션') < cn.indexOf('리뷰옵션'), cn.join('|'));

  const d = plan('');
  ok('★ 상품 정보가 없으면 종전 그대로(무회귀)', !/상품/.test(names(d)), names(d));

  ok('상품 축 판정은 옵션과 별개 함수', typeof PLAN.productKeysFromWorkOrder === 'function');
  ok('옵션 없는 상품도 센다', PLAN.productKeysFromWorkOrder({ product_options_json: JSON.stringify([{ name: 'A', options: [] }, { name: 'B', options: [] }]) }).length === 2);
  ok('깨진 JSON 은 빈 배열(칸 안 만듦)', PLAN.productKeysFromWorkOrder({ product_options_json: '{{' }).length === 0);
  ok('같은 상품 이름은 한 번만', PLAN.productKeysFromWorkOrder({ product_options_json: JSON.stringify([{ name: 'A' }, { name: 'a' }]) }).length === 1);
}

/* ── G. 서비스 실제 실행 ────────────────────────────────────────────────── */
const OID = '11111111-1111-1111-1111-111111111111';
const OID2 = '22222222-2222-2222-2222-222222222222';
function makePool({ sheetless = true, registered = true, headers = ['번호', '구매일자', '옵션', '수취인'],
  parts = [], orders = [], apps = [], liveProducts = [{ product_name: '진간장 F' }, { product_name: '진간장 S' }], liveThrows = false } = {}) {
  const seen = [];
  const client = {
    query: async (sql, params) => { seen.push({ q: String(sql).replace(/\s+/g, ' '), params }); return { rows: [], rowCount: 1 }; },
    release: () => {},
  };
  const query = async (sql, params) => {
    const q = String(sql).replace(/\s+/g, ' ');
    seen.push({ q, params });
    if (/FROM tab_configs/.test(q)) return { rows: registered ? [{ tab_gid: '1', sheetless }] : [] };
    if (/FROM raw_sheet_tabs/.test(q)) return { rows: [{ detected_headers: headers, headers }] };
    // ★ 더 좁은 조건을 먼저 — 참여 기록 조인이 아래 일반 분기에 가로채이면 폴백 검사가 공허해진다
    if (/FROM campaign_applications/.test(q)) return { rows: apps };
    if (/FROM recruit_campaigns/.test(q)) { if (liveThrows) throw new Error('boom'); return { rows: liveProducts }; }
    if (/FROM campaign_participants/.test(q)) return { rows: parts };
    if (/FROM order_submissions/.test(q)) return { rows: orders };
    return { rows: [] };
  };
  return { seen, query, connect: async () => client };
}

console.log('\n[G] 서비스 실제 실행 — 게이트 · 미리보기 · 소급');
(async () => {
  {
    const p = makePool({ sheetless: false });
    SVC.__setPoolForTest(p);
    let err = null;
    try { await SVC.ensureProductColumn({ sheetId: 's', tabName: 't' }); } catch (e) { err = e; }
    ok('★ 시트 기반 탭은 거부(fail-closed)', err && err.code === 'not_sheetless');
    ok('거부 시 쓰기 0', !p.seen.some(s => /UPDATE |INSERT |DELETE /i.test(s.q)));
  }
  {
    const p = makePool({ registered: false });
    SVC.__setPoolForTest(p);
    let err = null;
    try { await SVC.ensureProductColumn({ sheetId: 's', tabName: 't' }); } catch (e) { err = e; }
    ok('미등록 탭은 거부', err && err.code === 'tab_not_registered');
  }
  {
    const p = makePool({ liveProducts: [] });
    SVC.__setPoolForTest(p);
    let err = null;
    try { await SVC.ensureProductColumn({ sheetId: 's', tabName: 't' }); } catch (e) { err = e; }
    ok('★★ 상품 구분이 없는 작업은 칸을 만들지 않는다', err && err.code === 'no_live_products');
  }
  {
    const p = makePool({ liveThrows: true });
    SVC.__setPoolForTest(p);
    let err = null;
    try { await SVC.ensureProductColumn({ sheetId: 's', tabName: 't' }); } catch (e) { err = e; }
    ok('★ 조회 실패도 거부(모르는 채로 값을 박지 않는다)', err && err.code === 'live_products_unknown');
    ok('거부 시 쓰기 0', !p.seen.some(s => /UPDATE |INSERT |DELETE /i.test(s.q)));
  }
  {
    // ★★ 이번 사고의 모양 — 원장은 비어 있고 참여 기록에만 선택이 남아 있다
    const p = makePool({
      parts: [{ seq: 1, row_json: { 번호: '1' }, order_submission_id: OID }],
      orders: [],                                            // 원장 selected_product 가 빈 상태
      apps: [{ oid: OID, product_name: '진간장 S' }],
    });
    SVC.__setPoolForTest(p);
    const r = await SVC.ensureProductColumn({ sheetId: 's', tabName: 't' });
    ok('★ 기본이 미리보기(dryRun)', r.dryRun === true);
    ok('미리보기는 쓰기 0', !p.seen.some(s => /UPDATE |INSERT |DELETE /i.test(s.q)));
    ok('「상품」 칸을 만든다고 말한다', r.headerAdded === true && r.headerName === '상품');
    ok('★★ 원장이 비어도 참여 기록에서 되살린다(22명 구제 경로)', r.backfillCount === 1 && r.rows[0].product === '진간장 S');
    ok('상품 칸이 옵션 앞에 들어간다', r.headers.join('|') === '번호|구매일자|상품|옵션|수취인', r.headers.join('|'));
    ok('이 공고의 상품 목록을 함께 알려준다', (r.liveProductNames || []).length === 2);
  }
  {
    const p = makePool({
      headers: ['번호', '상품', '옵션'],
      parts: [
        { seq: 1, row_json: { 상품: '관리자가 적어둔 값' }, order_submission_id: OID },
        { seq: 2, row_json: {}, order_submission_id: null },
        { seq: 3, row_json: {}, order_submission_id: OID2 },
      ],
      orders: [{ id: OID, selected_product: '진간장 S' }, { id: OID2, selected_product: '남의 상품' }],
    });
    SVC.__setPoolForTest(p);
    const r = await SVC.ensureProductColumn({ sheetId: 's', tabName: 't' });
    ok('이미 칸이 있으면 만들지 않는다', r.headerAdded === false && r.alreadyHadColumn === true);
    ok('★ 값이 있는 칸은 덮지 않는다(blank-only)', r.skippedAlreadyFilled === 1);
    ok('선택 기록 없는 줄은 건너뛴다', r.skippedNoOrderProduct === 1);
    ok('★★ 그 공고의 상품 목록에 없는 값은 넣지 않고 건수를 말한다', r.skippedNotAProduct === 1);
    ok('결국 소급 대상 0', r.backfillCount === 0);
  }
  {
    // 원장에 값이 있으면 그것이 이긴다(참여 기록은 폴백)
    const p = makePool({
      parts: [{ seq: 1, row_json: {}, order_submission_id: OID }],
      orders: [{ id: OID, selected_product: '진간장 F' }],
      apps: [{ oid: OID, product_name: '진간장 S' }],
    });
    SVC.__setPoolForTest(p);
    const r = await SVC.ensureProductColumn({ sheetId: 's', tabName: 't' });
    ok('★ 원장 값이 참여 기록보다 우선', r.rows[0].product === '진간장 F');
  }
  {
    // 실행 — 쓰기 표면 3곳
    const p = makePool({
      parts: [{ seq: 1, row_json: {}, order_submission_id: OID }],
      orders: [],
      apps: [{ oid: OID, product_name: '진간장 S' }],
    });
    SVC.__setPoolForTest(p);
    await SVC.ensureProductColumn({ sheetId: 's', tabName: 't', dryRun: false });
    const writes = p.seen.filter(s => /UPDATE |INSERT |DELETE /i.test(s.q)).map(s => s.q);
    const tables = new Set(writes.map(q => (/(UPDATE|INSERT INTO|DELETE FROM)\s+(\w+)/i.exec(q) || [])[2]).filter(Boolean));
    ok('★ 쓰기 표면은 3곳뿐', [...tables].sort().join(',') === 'campaign_participants,order_submissions,raw_sheet_tabs', [...tables].join(','));
    ok('★ 시트·정원·홀드 무접촉', !writes.some(q => /campaign_options|recruit_campaigns|campaign_applications|tab_configs/i.test(q)));
    ok('★ 원장 백필도 blank-only', writes.some(q => /UPDATE order_submissions/i.test(q) && /COALESCE\(selected_product, ''\) = ''/.test(q)));
    ok('장부 재생성 락을 잡는다', p.seen.some(s => /pg_advisory_xact_lock/.test(s.q)));
  }
  {
    const p = makePool({ headers: ['번호', '상품'], parts: [], orders: [] });
    SVC.__setPoolForTest(p);
    const r = await SVC.ensureProductColumn({ sheetId: 's', tabName: 't', dryRun: false });
    ok('할 일이 없으면 아무것도 안 한다', r.noop === true);
    ok('그때도 쓰기 0', !p.seen.some(s => /UPDATE |INSERT |DELETE /i.test(s.q)));
  }
  SVC.__setPoolForTest(null);

  /* ── H. 공고 저장 훅 ─────────────────────────────────────────────────── */
  console.log('\n[H] 공고 저장 훅 — 실행부는 서비스 한 벌 · fail-soft');
  {
    const s = read('src/routes/campaign.routes.js');
    ok('훅이 있다', /async function _ensureLinkedWorktableProductColumn/.test(s));
    ok('★ 실행부는 서비스 한 벌(사본 0)', /require\('\.\.\/services\/worktableProductColumn\.service'\)/.test(s));
    ok('★ 컬럼명은 linked_sheet_id(2026-08-23 오타 사고 자리)',
      /_ensureLinkedWorktableProductColumn[\s\S]{0,700}c\.linked_sheet_id AS "sheetId"/.test(s));
    ok('★ 문턱 = 상품 2종 이상', /_ensureLinkedWorktableProductColumn[\s\S]{0,900}liveProducts \|\| 0\) < 2/.test(s));
    ok('★ 절대 throw 하지 않는다(공고 저장을 죽이면 안 된다)',
      /_ensureLinkedWorktableProductColumn[\s\S]{0,1400}catch \(e\) \{[\s\S]{0,300}return null;/.test(s));
    ok('발행에서 부른다', /_ensureLinkedWorktableProductColumn\(rows\[0\]\.id, 'create'\)/.test(s));
    ok('수정에서 부른다', /_ensureLinkedWorktableProductColumn\(id, 'update'\)/.test(s));
    ok('★ 옵션 칸 훅은 그대로 있다(대체가 아니라 추가)', /_ensureLinkedWorktableOptionColumn\(id, 'update'\)/.test(s));
  }

  /* ── I. 스키마 프리플라이트 ──────────────────────────────────────────── */
  console.log('\n[I] 마이그레이션 · 프리플라이트');
  {
    const mig = read('migrations/138_order_selected_product.sql');
    ok('컬럼 추가만(백필 0)', /ADD COLUMN IF NOT EXISTS selected_product/.test(mig) && !/UPDATE |INSERT /i.test(mig));
    ok('★ 재실행 안전(IF NOT EXISTS)', /IF NOT EXISTS/.test(mig));
    ok('★ 프리플라이트 등록 — 없으면 제출이 전면 42703',
      /\['order_submissions', 'selected_product'\]/.test(read('index.js')));
  }

  console.log(`\n✅ worktableProductColumn — ${passed} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error('\n❌', e && e.message); process.exit(1); });
