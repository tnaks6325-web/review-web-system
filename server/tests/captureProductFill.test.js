'use strict';
/**
 * captureProductFill.test.js — 결정 232 (구매 캡처 AI 판독으로 상품 칸 채우기 · 사람이 고친 상품 칸 귀속)
 * 실행: node tests/captureProductFill.test.js
 */
const assert = require('assert');
const st = require('../src/services/campaignState.service');
const fill = require('../src/services/captureProductFill.service');
let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

const F = '풍성한 진간장 F 13L x 1통', P = '풍성한 진간장 13L x 1통', S = '풍성한 진간장 S 13L x 1통';
const OPTS = [F, P, S].map((k, i) => ({ opt_key: k, product_name: k, status: 'active', sort_order: i }));

function stubPool(targetRows, log) {
  const q = async (sql, params) => {
    const s = String(sql); log && log.push({ s, params });
    if (/FROM recruit_campaigns WHERE id = \$1/.test(s)) return { rows: [{ id: 'c1', title: '간장', linked_sheet_id: 'wt', linked_tab_name: 'T', start_date: '2026-08-24' }] };
    if (/FROM campaign_options WHERE campaign_id/.test(s)) return { rows: OPTS };
    if (/JOIN campaign_participants cp/.test(s)) return { rows: targetRows };
    if (/SELECT id, row_json FROM campaign_participants/.test(s)) return { rows: [{ id: params[0], row_json: {} }] };
    if (/SELECT 1 FROM participant_edits/.test(s)) return { rows: [] };
    return { rows: [], rowCount: 1 };
  };
  return { query: q, connect: async () => ({ query: q, release() {} }) };
}
const T = (id, extra = {}) => ({ id, capture_file_id: 'f' + id, selected_opt_key: '', selected_product: '', day: '2026-09-03', row_id: 'r' + id, seq: Number(id), option_text: null, row_product: null, edited_product: null, ...extra });

(async () => {
  await ok('귀속: 사람이 작업보드에서 고친 상품 칸(편집 기록)이 맨 앞 — 줄 계획 표기보다 앞선다', async () => {
    assert.equal(st.matchOrderOption(OPTS, { editedProduct: S, optionText: F, rowProduct: F }), S);
    assert.equal(st.matchOrderOption(OPTS, { editedProduct: '', rowProduct: '' }), null);
  });

  await ok('미리보기: 캡처 판독 → 상품 하나로 짝지음 / 애매·캡처 없음·읽기 실패는 사람 확인 / 이미 아는 주문은 대상 아님 / 쓰기 0', async () => {
    const log = [];
    fill.__setPoolForTest(stubPool([
      T('1'), T('2'), T('3', { capture_file_id: null }), T('4'), T('5', { edited_product: F }),
    ], log));
    const reads = { f1: { productName: '풍성한 진간장 F, 1개, 13L', productOption: '' }, f2: { productName: '풍성한 진간장 13L, 1개', productOption: '' } };
    fill.__setDepsForTest({
      samples: async () => [],
      download: async (id) => { if (id === 'f4') throw new Error('drive 403'); return { buffer: Buffer.from(id), mimeType: 'image/png' }; },
      extract: async (b64) => reads[Buffer.from(b64, 'base64').toString()],
    });
    const r = await fill.previewCaptureProducts({ campaignId: 'c1' });
    const by = Object.fromEntries(r.items.map(i => [i.orderId, i]));
    assert.equal(r.total, 4, '5번(사람이 이미 고침)은 대상 아님');
    assert.equal(by['1'].status, 'matched'); assert.equal(by['1'].optKey, F);
    assert.equal(by['2'].status, 'ambiguous', '13L 만으로는 셋 다 걸린다 → 모름(완화 금지)');
    assert.equal(by['3'].status, 'no_capture'); assert.equal(by['4'].status, 'download_failed');
    assert.equal(r.matched, 1); assert.equal(r.needsHuman, 3);
    assert(!log.some(x => /^\s*(UPDATE|INSERT|DELETE)/i.test(x.s)), '미리보기는 쓰기 0');
  });

  await ok('적용: picks 를 그대로 적는다 — 줄 상품 칸(blank-only) + 편집 기록(작업 로그) · 원장 selected_product 는 안 건드림', async () => {
    const log = [];
    fill.__setPoolForTest(stubPool([T('1'), T('3', { capture_file_id: null }), T('6', { row_product: '' })], log));
    let ensured = null, rebuilt = null;
    fill.__setDepsForTest({
      ensureColumn: async (o) => { ensured = o; return { headers: ['번호', '구매일자', '상품', '옵션'], headerAdded: true, backfillCount: 3 }; },
      rebuild: async (o) => { rebuilt = o; },
    });
    const r = await fill.applyCaptureProducts({ campaignId: 'c1', by: '박세희', picks: [
      { orderId: '1', optKey: F, source: 'capture' },
      { orderId: '3', optKey: S, source: 'manual' },
      { orderId: '9', optKey: F },                 // 대상 아님
      { orderId: '6', optKey: '없는상품' },          // 이 공고 상품 아님
    ] });
    assert.equal(r.written, 2);
    assert.equal(r.results.find(x => x.orderId === '9').reason, 'not_target');
    assert.equal(r.results.find(x => x.orderId === '6').reason, 'unknown_option');
    assert(ensured && ensured.dryRun === false, '상품 칸이 없으면 기존 기능으로 칸부터');
    assert(rebuilt, '장부 재생성');
    const upd = log.filter(x => /UPDATE campaign_participants SET row_json/.test(x.s));
    assert.equal(upd.length, 2); assert.deepEqual(JSON.parse(upd[0].params[1]), { '상품': F });
    const ins = log.filter(x => /INSERT INTO participant_edits/.test(x.s));
    assert.equal(ins.length, 2); assert.equal(ins[0].params[3], 'col:상품');
    assert(/AI 캡처판독/.test(ins[0].params[5]) && /수동지정/.test(ins[1].params[5]), '작업 로그에 근거가 남는다');
    assert(!log.some(x => /UPDATE order_submissions/.test(x.s)), '원장 selected_product 는 쓰지 않는다(결정 018)');
    assert(log.some(x => /pg_advisory_xact_lock/.test(x.s)), '장부와 같은 잠금');
  });

  await ok('적용: 이미 채워진 줄은 덮지 않는다(조용한 덮어쓰기 금지)', async () => {
    fill.__setPoolForTest(stubPool([T('7', { row_product: '' })], []));
    fill.__setDepsForTest({ ensureColumn: async () => ({ headers: ['상품'] }), rebuild: async () => {} });
    // 대상 판정은 통과했지만 줄에 사람이 이미 적은 경우(편집 기록 있음)
    const p = stubPool([T('7')], []);
    const q0 = p.query;
    p.query = async (sql, params) => (/SELECT 1 FROM participant_edits/.test(String(sql)) ? { rows: [{ '?column?': 1 }] } : q0(sql, params));
    p.connect = async () => ({ query: p.query, release() {} });
    fill.__setPoolForTest(p);
    const r = await fill.applyCaptureProducts({ campaignId: 'c1', picks: [{ orderId: '7', optKey: F }] });
    assert.equal(r.written, 0); assert.equal(r.results[0].reason, 'already_filled');
  });

  await ok('라우트: 관리자 전용 · 적용은 confirm:true 필수', async () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
    assert(/router\.post\('\/campaigns\/:id\/capture-product-fill', authMiddleware, adminOrMasterMiddleware/.test(src));
    assert(/b\.mode === 'apply'[\s\S]{0,120}b\.confirm !== true/.test(src));
  });
  console.log(`\n✅ captureProductFill: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
