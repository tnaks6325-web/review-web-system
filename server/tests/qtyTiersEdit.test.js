'use strict';
/**
 * qtyTiersEdit.test.js — 결정 391(R1) 판정 함수 · 쓰기 경로 열쇠 · 단일 출처 정적 가드.
 *   ① qtyTiersEditVerdict(스텁 q): 연결 꺼짐·옛 창·스위치·블로그 · 신청/채운 줄 숫자 · 조회 실패 = check_failed + 숫자 null(0 으로 꾸미지 않음) · 상한 2.5초
 *   ② writablePath — 단계 칸은 인트라넷 새 창(tiersCapable)만 · 옛 창/다른 출처/옵션 줄 = 종전 false
 *   ③ applyWrites — 단계 갈래(빈↔빈 = 변화 없음 · 전부 빼기 = 키 삭제 · J2 옵션 이름을 리뷰웹 짝 이름으로 · 짝 없음 = write_unmatched)
 *   ④ validateQuantities — 허락한 단계 상품만 통과 + 병합 결과 정규화 재검사(합 불일치 409)
 *   ⑤ 정적 — 잠금 순서(탭 잠금이 공고 행 FOR UPDATE 보다 앞) · copiesFor 단일 출처 4곳 · 조절 이력 라벨 두 곳 · 종류 판정에 상한 없음
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const svc = require('../src/services/qtyTiersEdit.service');
const SP = require('../src/services/sharedPatch.service');
const { ABSENT } = require('../src/utils/sharedPatchPlan');

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

const WO = (over = {}) => ({ id: 'wo1', bidir_state: 'on', work_kind: 'review', linked_campaign_id: 'c1', product_options_json: JSON.stringify([{ name: '가', product_mode: 'none', options: [], base: { pay: 1, count: 3 } }]), ...over });
const CAMP = { id: 'c1', linked_sheet_id: 's1', linked_tab_name: 't1' };
/** 스텁 q — SQL 글자로 갈라 숫자를 돌려준다(범위 의미는 r1QtyTiersPg·orderDeleteTabCleanupPg 가 실제 SQL 로 지킨다). */
const stubQ = ({ apps = 0, orders = 0, filled = 0, shared = 0, rounds = false, archived = false, throwOn = null } = {}) => async (sql) => {
  const t = String(sql);
  if (throwOn && throwOn.test(t)) throw new Error('가짜 조회 실패');
  if (/AS applications/.test(t)) return { rows: [{ applications: apps, campaign_orders: orders, filled_rows: filled }] };
  if (/COUNT\(\*\)::int AS n FROM recruit_campaigns/.test(t)) return { rows: [{ n: shared }] };
  if (/to_regclass/.test(t)) return { rows: [{ x: true }] };
  if (/FROM campaign_rounds/.test(t)) return { rows: rounds ? [{ '?column?': 1 }] : [] };
  if (/AS a,/.test(t)) return { rows: [{ a: 0, o: 0 }] };
  if (/archived_at IS NOT NULL/.test(t)) return { rows: archived ? [{ x: 1 }] : [] };
  return { rows: [] };
};

(async () => {
  await ok('① 판정 — 통과 · 신청·채운 줄 숫자 · 사유 순서', async () => {
    let v = await svc.qtyTiersEditVerdict(stubQ(), { wo: WO(), camp: CAMP, tiersCapable: true, active: true });
    assert.deepEqual(v.reasons, []); assert.equal(v.allowed, true); assert.equal(v.applicants, 0); assert.equal(v.locks_structure, true, '단계 없는 리뷰 오더 = 처음 넣으면 구조 잠김');
    v = await svc.qtyTiersEditVerdict(stubQ({ apps: 2, orders: 1, filled: 4 }), { wo: WO(), camp: CAMP, tiersCapable: true, active: true });
    assert.deepEqual(v.reasons, ['quantity_tiers_in_use', 'worktable_filled']); assert.equal(v.applicants, 3); assert.equal(v.filled_rows, 4);
    assert.match(svc.tierRejectText(v.reasons[0], v), /이미 신청한 분이 3명/);
    v = await svc.qtyTiersEditVerdict(stubQ({ shared: 1, rounds: true }), { wo: WO(), camp: CAMP, tiersCapable: true, active: true });
    assert.deepEqual(v.reasons, ['shared_worktable', 'rounds_exist']);
    v = await svc.qtyTiersEditVerdict(stubQ({ archived: true }), { wo: WO(), camp: null, tiersCapable: true, active: true });
    assert.deepEqual(v.reasons, ['quantity_tiers_archived']);
    v = await svc.qtyTiersEditVerdict(stubQ(), { wo: WO(), camp: null, tiersCapable: true, active: true });
    assert.deepEqual(v.reasons, ['no_campaign']);
  });
  await ok('① 판정 — 연결 꺼짐(active=false) 첫 사유 · 옛 창 · 블로그 · Q&A · 스위치 꺼짐 · 이미 단계 있음 = 구조 잠김 안내 없음', async () => {
    let v = await svc.qtyTiersEditVerdict(stubQ(), { wo: WO(), camp: CAMP, tiersCapable: false, active: false });
    assert.deepEqual(v.reasons.slice(0, 2), ['bidir_not_active', 'tiers_not_capable']); assert.equal(v.allowed, false);
    for (const k of ['blog', 'qna']) {
      v = await svc.qtyTiersEditVerdict(stubQ(), { wo: WO({ work_kind: k }), camp: CAMP, tiersCapable: true, active: true });
      assert.deepEqual(v.reasons, ['kind_no_tiers'], k);
    }
    process.env.CAMPAIGN_QTY_TIERS = '0';
    try { v = await svc.qtyTiersEditVerdict(stubQ(), { wo: WO(), camp: CAMP, tiersCapable: true, active: true }); assert.deepEqual(v.reasons, ['quantity_tiers_off']); }
    finally { delete process.env.CAMPAIGN_QTY_TIERS; }
    const withTiers = WO({ product_options_json: JSON.stringify([{ name: '가', product_mode: 'none', options: [], base: { pay: 1, count: 3 }, qty_tiers: { mode: 'common', rows: [{ qty: 1, people: 3, amount: 1 }] } }]) });
    v = await svc.qtyTiersEditVerdict(stubQ(), { wo: withTiers, camp: CAMP, tiersCapable: true, active: true });
    assert.equal(v.locks_structure, false, '이미 잠김');
    v = await svc.qtyTiersEditVerdict(stubQ(), { wo: WO({ delivery_type: '혼합' }), camp: CAMP, tiersCapable: true, active: true });
    assert.equal(v.locks_structure, false, '배송 혼합 = 이미 잠김');
  });
  await ok('① 판정 — 조회 실패 = check_failed · 숫자 null(0 으로 꾸미지 않음) · 상한 넘김 = check_failed', async () => {
    const v = await svc.qtyTiersEditVerdict(stubQ({ throwOn: /AS applications/ }), { wo: WO(), camp: CAMP, tiersCapable: true, active: true });
    assert.deepEqual(v.reasons, ['check_failed']); assert.equal(v.applicants, null); assert.equal(v.filled_rows, null); assert.equal(v.allowed, false);
    const t0 = Date.now();
    const slow = await svc.withDeadline(new Promise(r => setTimeout(() => r({ allowed: true, reasons: [] }), 400)), 50);
    assert.deepEqual(slow.reasons, ['check_failed']); assert.ok(Date.now() - t0 < 300);
    const fast = await svc.withDeadline(Promise.resolve({ allowed: true, reasons: [] }), 50);
    assert.equal(fast.allowed, true);
    assert.equal(svc.VERDICT_DEADLINE_MS, 2500);
  });

  await ok('② writablePath — 단계 칸은 인트라넷 새 창(tiersCapable)만 · 옛 창·다른 출처·옵션 줄 = false(289 「가」 종전)', async () => {
    const row = (extra = {}, parent = 'p:가') => ({ meta: { kind: 'leaf', key: 'qty_tiers', parent }, base: '{"a":1}', mine: '{"a":2}', ...extra });
    assert.equal(SP.writablePath(row(), 'intranet'), false, '옛 창');
    assert.equal(SP.writablePath(row({ tiersCapable: true }), 'intranet'), true, '새 창');
    for (const o of ['campaign', 'rw_admin', 'reconcile']) assert.equal(SP.writablePath(row({ tiersCapable: true }), o), false, o);
    assert.equal(SP.writablePath(row({ tiersCapable: true }, 'p:가|o:블랙'), 'intranet'), false, '옵션 줄 단계 칸은 없다');
    assert.equal(SP.writablePath(row({ tiersCapable: true, base: ABSENT }), 'intranet'), true, '처음 넣기');
    assert.equal(SP.writablePath(row({ tiersCapable: true, mine: ABSENT }), 'intranet'), true, '모두 빼기');
  });

  await ok('③ applyWrites — 단계 갈래 · 빈↔빈 = 변화 없음 · 전부 빼기 = 키 삭제 · J2 옵션 이름 다시 적기 · 짝 없음 = missed', async () => {
    const P = (tiers, labels = ['블랙', '화이트']) => JSON.stringify([{ name: '탈취제', product_mode: 'opt', base: {}, options: labels.map(l => ({ label: l, option_1: { name: '', value: l }, count: 2, pay: 1 })), ...(tiers ? { qty_tiers: tiers } : {}) }]);
    const w = { path: 'p:탈취제.qty_tiers', meta: { kind: 'leaf', key: 'qty_tiers', parent: 'p:탈취제' } };
    const T = rows => ({ mode: 'by_option', buy_method: 'qty', rows });
    let r = SP.applyWrites({ product_options_json: P(null) }, { product_options_json: P(T([{ option: '블랙', qty: 1, people: 2, amount: 1 }, { option: '화이트', qty: 1, people: 2, amount: 1 }])) }, [w]);
    assert.equal(r.tiersTouched, true); assert.deepEqual([...r.tierProducts], ['탈취제']); assert.ok(r.qtyProducts.has('탈취제')); assert.equal(r.quantityTouched, true);
    assert.equal(JSON.parse(r.next.product_options_json)[0].qty_tiers.rows.length, 2);
    r = SP.applyWrites({ product_options_json: P(T([{ option: '블랙', qty: 1, people: 2, amount: 1 }])) }, { product_options_json: P(null) }, [w]);
    assert.equal(r.tiersTouched, true); assert.equal(JSON.parse(r.next.product_options_json)[0].qty_tiers, undefined, '전부 빼기 = 키 삭제');
    r = SP.applyWrites({ product_options_json: P(null) }, { product_options_json: P({ mode: 'common', rows: [] }) }, [w]);
    assert.equal(r.tiersTouched, false, '빈 ↔ 빈 = 변화 없음'); assert.equal(r.productsTouched, false);
    // J2 — 보낸 단계 줄 옵션 이름이 띄어쓰기만 다름 → 리뷰웹 짝 옵션 이름으로
    r = SP.applyWrites({ product_options_json: P(null) }, { product_options_json: P(T([{ option: '블 랙', qty: 1, people: 2, amount: 1 }, { option: '화이트', qty: 1, people: 2, amount: 1 }])) }, [w]);
    assert.deepEqual(JSON.parse(r.next.product_options_json)[0].qty_tiers.rows.map(x => x.option), ['블랙', '화이트']);
    r = SP.applyWrites({ product_options_json: P(null) }, { product_options_json: P(T([{ option: '없는옵션', qty: 1, people: 2, amount: 1 }])) }, [w]);
    assert.deepEqual(r.missed, ['p:탈취제.qty_tiers'], '짝 없음 = write_unmatched');
  });

  await ok('④ validateQuantities — 허락한 단계 상품만 통과 · 병합 결과 정규화 재검사(합 불일치 = quantity_tiers_sum_mismatch)', async () => {
    const prod = (count, people) => [{ name: '세라', product_mode: 'none', option_schema_version: 2, options: [], base: { pay: 1, count },
      qty_tiers: { mode: 'common', buy_method: 'qty', rows: [{ option: null, qty: 2, people, amount: 2 }] } }];
    const V = SP.validateQuantities;
    assert.equal(V({ product_options_json: JSON.stringify(prod(10, 10)), recruit_count: 10 }, ['세라']).code, 'quantity_tiers_locked', '허락 없음 = 종전 막힘');
    assert.equal(V({ product_options_json: JSON.stringify(prod(10, 10)), recruit_count: 10 }, ['세라'], { tierProducts: new Set(['세라']) }), null, '허락 + 합 맞음 = 통과');
    const e = V({ product_options_json: JSON.stringify(prod(10, 12)), recruit_count: 10 }, ['세라'], { tierProducts: new Set(['세라']) });
    assert.equal(e.code, 'quantity_tiers_sum_mismatch'); assert.match(e.error, /인원 합\(12명\)이 모집인원\(10명\)과 다릅니다/);
  });

  await ok('⑤ 정적 — 잠금 순서 · copiesFor 단일 출처 · 이력 라벨 · 종류 판정 상한 없음 · 거절은 통째 되돌림 경로', async () => {
    const sp = read('src/services/sharedPatch.service.js');
    const fn = sp.slice(sp.indexOf('async function applySharedPatch('), sp.indexOf('async function linkSharedOrderInTx('));
    const lockAt = fn.indexOf("await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tierTabLock]);");
    const campAt = fn.indexOf("'SELECT * FROM recruit_campaigns WHERE id = $1 AND archived_at IS NULL FOR UPDATE'");
    const woAt = fn.indexOf("'SELECT * FROM work_orders WHERE id = $1 FOR UPDATE'");
    const l1At = fn.indexOf('await lrq.lockWorkOrderCampaigns(client, [p.workOrderId]);');
    assert.ok(l1At > 0 && woAt > l1At && lockAt > woAt && campAt > lockAt, 'L1 → 작업오더 행 → 탭 잠금 → 공고 행');
    const verdictAt = fn.indexOf('qtyTiersEditVerdict((t, x) => client.query(t, x)');
    assert.ok(verdictAt > campAt, '판정은 공고 행 잠금 뒤 같은 트랜잭션');
    assert.ok(fn.indexOf("code: 'quantity_tiers_stale_base'") > verdictAt && fn.indexOf("code: 'quantity_tiers_with_structure'") > verdictAt);
    assert.ok(fn.indexOf("campaignUseCounts((t, x) => client.query(t, x)") > fn.indexOf('campaign = await projectToCampaignInTx('), '반영 뒤 다시 센다');
    // 거절은 모두 _abort(ROLLBACK) — 원본 번호 UPDATE 와 같은 트랜잭션(결정 262)
    for (const c of ['quantity_tiers_stale_base', 'quantity_tiers_with_structure', 'quantity_tiers_pay_missing']) assert.match(fn, new RegExp(`return await _abort\\(client, 409, \\{ ok: false, code: '${c}'`), c);
    // copiesFor — 발행 · R1 판정 · R1 반영 · 보관 해제 4곳(복사 조건 사본 0)
    assert.match(read('src/routes/campaign.routes.js'), /if \(campaignQtyTiers\.copiesFor\(work_kind\)\)/);
    assert.match(read('src/services/qtyTiersEdit.service.js'), /qt\.copiesFor\(kind\)/);
    assert.match(sp, /if \(!qt\.copiesFor\(next\.work_kind\)\) return reject\('quantity_tiers_off'/);
    assert.match(read('src/services/campaignArchive.service.js'), /campaignQtyTiers\.copiesFor\(ck\[0\] && ck\[0\]\.work_kind\)/);
    assert.ok(!/campaignQtyTiers\.enabled\(\) && !\['blog', 'qna'\]/.test(read('src/routes/campaign.routes.js')), '발행 쪽 손글씨 조건 없음');
    // 조절 이력 행동 이름 → 라벨 두 곳(공고 조절 창 · 작업 활동 기록)
    assert.match(sp, /VALUES \(\$1, \$2, 'qty_tiers_changed', \$3::jsonb\)/);
    assert.match(read('../frontend/js/campaign-daily-plan.js'), /ev\.action === 'qty_tiers_changed'/);
    assert.match(read('src/services/tabActivityLog.service.js'), /qty_tiers_changed: '구매수량 단계 변경\(인트라넷\)'/);
    // /shared — 종류 판정(결정 332)은 상한 없이 그대로, R1 판정만 상한
    const routes = read('src/routes/order.routes.js');
    assert.match(routes, /kindChangeVerdict\(rows\[0\]\),\n\s*caps\.has\('tiers'\) \? qte\.withDeadline\(qte\.qtyTiersEditVerdict/);
    assert.ok(!/withDeadline\(kindChangeVerdict/.test(routes), '종류 판정에 상한 없음(N5)');
    // skip 창 — 조용히 버리지 않는다(Q7-d·e) · 안 고친 저장만 종전대로 상품 구성 무시
    const bid = routes.slice(routes.indexOf('async function _intakeSourceBidir('), routes.indexOf('const out = await applySharedPatch({', routes.indexOf('async function _intakeSourceBidir(')));
    assert.ok(bid.indexOf("code: 'products_unmatched_edit'") > 0 && bid.indexOf("code: 'quantity_tiers_unmatched_window'") > bid.indexOf("code: 'products_unmatched_edit'"));
    assert.ok(bid.indexOf('delete m.product_options_json; delete m.product_option; delete m.pay_amount;') > bid.indexOf("code: 'quantity_tiers_unmatched_window'"), '버리기는 두 검사 뒤');
    // 읽지 못하는 글자 = 「단계 없음」(깨진 데이터 오더의 종전 저장을 새로 막지 않는다)
    assert.match(bid, /qtyTiersPrint\(m\.product_options_json\) \|\| '\[\]', now = qtyTiersPrint\(current\.product_options_json\) \|\| '\[\]'/);
    const { qtyTiersPrint } = require('../src/services/productOptions.service');
    const t = { mode: 'common', rows: [{ qty: 2, people: 1, amount: 9 }, { qty: 1, people: 2, amount: 5 }] };
    assert.equal(qtyTiersPrint('옛 글자형 상품'), null); assert.equal(qtyTiersPrint(''), '[]'); assert.equal(qtyTiersPrint('[{"name":"가"}]'), '[]');
    assert.equal(qtyTiersPrint(JSON.stringify([{ name: '가', qty_tiers: t }])), qtyTiersPrint(JSON.stringify([{ name: '다른 이름', qty_tiers: { ...t, rows: [...t.rows].reverse() } }])), '상품 이름·줄 순서 무관');
    assert.notEqual(qtyTiersPrint(JSON.stringify([{ name: '가', qty_tiers: t }])), qtyTiersPrint(JSON.stringify([{ name: '가', qty_tiers: { ...t, rows: [{ qty: 2, people: 1, amount: 10 }, t.rows[1]] } }])), '금액이 다르면 다름');
    assert.equal(qtyTiersPrint(JSON.stringify([{ name: '가', qty_tiers: { mode: 'common', rows: [] } }])), '[]', '빈 단계 = 없음');
  });

  console.log(`qtyTiersEdit: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
