'use strict';
/**
 * captureProductOnSubmit.test.js — 결정 237: 리뷰어 제출 순간 캡처 상품 글자로 상품 채우기
 * 실행: node tests/captureProductOnSubmit.test.js
 */
const assert = require('assert'), fs = require('fs'), path = require('path');
const fill = require('../src/services/captureProductFill.service');
const mo = require('../src/services/manualOrder.service');
let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const OPTS = ['풍성한 진간장 F 13L x 1통', '풍성한 진간장 13L x 1통', '풍성한 진간장 S 13L x 1통'].map((k, i) => ({ opt_key: k, product_name: k, status: 'active', sort_order: i }));
function pool(targets, log) {
  return { async query(sql, params) {
    const s = String(sql); log.push({ s, params });
    if (/FROM recruit_campaigns WHERE id = \$1/.test(s)) return { rows: [{ id: 'c1', linked_sheet_id: 'wt', linked_tab_name: 'T' }] };
    if (/FROM campaign_options WHERE campaign_id/.test(s)) return { rows: OPTS };
    if (/JOIN campaign_participants cp/.test(s)) return { rows: targets.filter(t => !params[1] || t.id === params[1]) };
    if (/INSERT INTO participant_edits/.test(s)) return { rowCount: 1, rows: [] };
    return { rows: [] };
  } };
}
const T = (id, x = {}) => ({ id, seq: 1, row_tab: 'T', row_count: 1, option_text: null, row_product: null, edited_product: null, selected_opt_key: '', selected_product: '', ...x });
const realTab = mo.tabOptionChoices;
mo.tabOptionChoices = async () => ({ campaignId: 'c1', choices: [] });

(async () => {
  await ok('상품 안 고른 제출 + 캡처가 F 하나로 확실 → 편집 기록 1건(AI 캡처판독(제출 시)) · 사진 내려받기·AI 호출 없음', async () => {
    const log = [];
    fill.__setPoolForTest(pool([T('o1')], log));
    fill.__setDepsForTest({ download: async () => { throw new Error('호출되면 안 됨'); }, extract: async () => { throw new Error('호출되면 안 됨'); } });
    const r = await fill.fillFromSubmitCapture({ orderSubmissionId: 'o1', sheetId: 'wt', tabName: 'T', captureName: '풍성한 진간장F, 1개, 13L' });
    assert.deepEqual(r, { written: true, optKey: OPTS[0].opt_key });
    const ins = log.find(x => /INSERT INTO participant_edits/.test(x.s));
    assert.equal(ins.params[4], OPTS[0].opt_key); assert(/AI 캡처판독\(제출 시\)/.test(ins.params[5]));
    assert(/WHERE NOT EXISTS/.test(ins.s), '이미 채워진 칸은 덮지 않음');
    assert(!log.some(x => /UPDATE (order_submissions|campaign_participants)/.test(x.s)), '원장·줄 값은 건드리지 않음');
  });
  await ok('애매(구분 글자 없음)·대상 아님(이미 상품 앎)·같은 주문 여러 줄 → 아무것도 안 함', async () => {
    for (const [targets, cap, why] of [[[T('o1')], '풍성한 진간장 13L, 1개', 'ambiguous'], [[], '풍성한 진간장 F', 'not_target'], [[T('o1', { row_count: 2 })], '풍성한 진간장 F', 'duplicate_rows']]) {
      const log = [];
      fill.__setPoolForTest(pool(targets, log));
      const r = await fill.fillFromSubmitCapture({ orderSubmissionId: 'o1', sheetId: 'wt', tabName: 'T', captureName: cap });
      assert.equal(r.written, false); assert.equal(r.skipped, why);
      assert(!log.some(x => /INSERT/.test(x.s)));
    }
  });
  await ok('연결 공고 없음·입력 없음·끄는 스위치 → 건너뜀', async () => {
    mo.tabOptionChoices = async () => null;
    assert.equal((await fill.fillFromSubmitCapture({ orderSubmissionId: 'o1', sheetId: 'wt', tabName: 'T', captureName: 'F' })).skipped, 'no_campaign');
    mo.tabOptionChoices = async () => ({ campaignId: 'c1', choices: [] });
    assert.equal((await fill.fillFromSubmitCapture({ orderSubmissionId: 'o1', sheetId: 'wt', tabName: 'T' })).skipped, 'no_input');
    process.env.CAPTURE_PRODUCT_ON_SUBMIT = '0';
    assert.equal((await fill.fillFromSubmitCapture({ orderSubmissionId: 'o1', sheetId: 'wt', tabName: 'T', captureName: 'F' })).skipped, 'disabled');
    delete process.env.CAPTURE_PRODUCT_ON_SUBMIT;
  });
  await ok('제출 경로: 홀드·화면 선택이 없을 때만 · 응답 뒤(setImmediate)에 · 실패는 무시', async () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/submit.routes.js'), 'utf8');
    const i = src.indexOf('fillFromSubmitCapture(_cap)');
    assert(i > 0);
    const blk = src.slice(src.lastIndexOf('결정 237', i), i + 400);
    assert(/!\(holdCtx && \(holdCtx\.productName \|\| holdCtx\.optionKey\)\) && !formPickedProduct/.test(blk));
    assert(/setImmediate\(/.test(blk) && /\.catch\(/.test(blk));
    assert(src.indexOf('fillFromSubmitCapture(_cap)') < src.indexOf('res.json({\n      ok: true,\n      dbSaved: true'), '응답 직전에 예약(처리는 응답 뒤)');
  });
  mo.tabOptionChoices = realTab;
  console.log(`\n✅ captureProductOnSubmit: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
