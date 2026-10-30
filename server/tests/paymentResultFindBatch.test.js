/**
 * paymentResultFindBatch.test.js — 결정 308 결과 파일 한 곳에 놓기 회귀가드(스텁 · DB 없이)
 * 실행: node tests/paymentResultFindBatch.test.js
 *
 * 고정하는 것:
 *  1. 대량이체를 고르지 않아도 파일 줄의 계좌+금액으로 그 대량이체를 찾는다(은행은 파일 모양으로)
 *  2. 모르면 반영하지 않는다 — 절반 넘게 맞는 대량이체가 없거나, 두 대량이체가 비슷하면 거부
 *  3. 이미 다 처리된 대량이체(통장으로 먼저 완료)도 찾되 pending 0 을 알려 준다(라우트가 쓰지 않는다)
 *  4. 라우트·화면 배선 — 반영은 기존 autoApplyResultFile 하나 · 화면 전체 놓기는 다른 칸과 두 번 올라가지 않는다
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('@e965/xlsx');
const RES = require('../src/services/paymentResult.service');
const { KBANK_AOA, HANA_AOA } = require('./fixtures/paymentResultFixtures');
const { parseResultAoa, digitsOnly } = require('../src/utils/paymentResultParse');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}
const b64 = aoa => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S'); return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }); };
const K = parseResultAoa(KBANK_AOA, {}); assert(K.ok && K.bank === 'kbank', 'kbank 픽스처');
const H = parseResultAoa(HANA_AOA, {}); assert(H.ok && H.bank === 'hana', 'hana 픽스처');
const itemsOf = (rows, status = 'pending') => rows.map(r => ({ bank_account: r.accountDigits, amount: r.amount, item_status: status }));

function stubPool(batches) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    const out = [];
    for (const b of batches) {
      if (b.bank !== params[0]) continue;
      for (const it of b.items) out.push({ id: b.id, seq: b.seq, status: 'downloaded', ...it });
    }
    return { rows: out };
  } };
}

(async () => {
  const kFile = b64(KBANK_AOA);
  await t('1 케이뱅크 파일 → 그 대량이체를 찾는다 · 다른 은행 대량이체는 보지 않는다', async () => {
    const pool = stubPool([
      { id: 'A', seq: 87, bank: 'kbank', items: itemsOf(K.rows) },
      { id: 'B', seq: 86, bank: 'kbank', items: itemsOf(K.rows.slice(0, 2)) },
      { id: 'H', seq: 13, bank: 'hana', items: itemsOf(K.rows) },
    ]);
    RES.__setPoolForTest(pool);
    const f = await RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: kFile });
    assert.deepStrictEqual([f.batchId, f.seq, f.bank, f.matchedRows, f.fileRows], ['A', 87, 'kbank', K.rows.length, K.rows.length]);
    assert.strictEqual(pool.calls[0].params[0], 'kbank');
  });
  await t('1b 하나은행 파일도 같은 입구', async () => {
    RES.__setPoolForTest(stubPool([{ id: 'H', seq: 13, bank: 'hana', items: itemsOf(H.rows) }]));
    const f = await RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: b64(HANA_AOA) });
    assert.deepStrictEqual([f.batchId, f.bank], ['H', 'hana']);
  });
  await t('1c 계좌 오류로 빠진 사람(파일에 없음)이 있어도 그 대량이체 — 파일 줄이 다 그 대량이체 안에 있다', async () => {
    const extra = [{ bank_account: '99990000111', amount: 5980, item_status: 'pending' }, { bank_account: '99990000222', amount: 5980, item_status: 'pending' }];
    RES.__setPoolForTest(stubPool([{ id: 'A', seq: 87, bank: 'kbank', items: [...itemsOf(K.rows), ...extra] }]));
    const f = await RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: kFile });
    assert.strictEqual(f.batchId, 'A'); assert.strictEqual(f.pending, K.rows.length + 2);
  });
  await t('2 ★ 절반 넘게 맞는 대량이체가 없으면 거부(no_batch)', async () => {
    const half = Math.floor(K.rows.length / 2);
    RES.__setPoolForTest(stubPool([{ id: 'A', seq: 87, bank: 'kbank', items: itemsOf(K.rows.slice(0, half)) }]));
    await assert.rejects(RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: kFile }), e => e.code === 'no_batch' && /#87/.test(e.message));
    RES.__setPoolForTest(stubPool([]));
    await assert.rejects(RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: kFile }), e => e.code === 'no_batch');
  });
  await t('2b ★ 두 대량이체가 비슷하게 맞으면 거부(ambiguous) — 둘째가 첫째의 80% 이상', async () => {
    RES.__setPoolForTest(stubPool([
      { id: 'A', seq: 87, bank: 'kbank', items: itemsOf(K.rows) },
      { id: 'B', seq: 88, bank: 'kbank', items: itemsOf(K.rows) },
    ]));
    await assert.rejects(RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: kFile }), e => e.code === 'ambiguous' && /#87/.test(e.message) && /#88/.test(e.message));
  });
  await t('2c 은행 결과 파일이 아니면 거부(parse_failed) · 빈 파일 거부', async () => {
    RES.__setPoolForTest(stubPool([]));
    await assert.rejects(RES.findBatchForResultFile({ fileName: 'x.xlsx', base64: b64([['이름', '전화'], ['가', '010']]) }), e => e.code === 'parse_failed');
    await assert.rejects(RES.findBatchForResultFile({ fileName: 'x.xlsx', base64: '' }), e => e.code === 'bad_request');
  });
  await t('3 이미 다 처리된 대량이체도 찾는다(pending 0)', async () => {
    RES.__setPoolForTest(stubPool([{ id: 'A', seq: 86, bank: 'kbank', items: itemsOf(K.rows, 'paid') }]));
    const f = await RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: kFile });
    assert.deepStrictEqual([f.batchId, f.pending], ['A', 0]);
  });
  await t('3a ★ 파일 이체 시각보다 뒤에 만든 대량이체는 후보가 아니다(옛 파일이 새 대량이체로 가지 않게)', async () => {
    const pool = stubPool([{ id: 'A', seq: 87, bank: 'kbank', items: itemsOf(K.rows) }]);
    RES.__setPoolForTest(pool);
    await RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: kFile });
    const cut = Date.parse(pool.calls[0].params[2]);
    const first = Math.min(...K.rows.map(r => Date.parse(r.transferredAtIso)));
    assert.ok(/b\.created_at <= \$3::timestamptz/.test(pool.calls[0].sql));
    assert.strictEqual(cut - first, 10 * 60 * 1000, '가장 이른 이체 + 10분');
  });
  await t('3b 계좌는 숫자만 비교(은행 이름·하이픈 무시)', async () => {
    const dashed = K.rows.map(r => ({ bank_account: String(digitsOnly(r.accountDigits)).replace(/(\d{3})(\d+)/, '$1-$2'), amount: r.amount, item_status: 'pending' }));
    RES.__setPoolForTest(stubPool([{ id: 'A', seq: 87, bank: 'kbank', items: dashed }]));
    assert.strictEqual((await RES.findBatchForResultFile({ fileName: 'r.xlsx', base64: kFile })).batchId, 'A');
  });
  RES.__setPoolForTest(null);

  await t('4 라우트 = adminOrMaster · 반영은 autoApplyResultFile 하나 · 다 처리됐으면 쓰지 않는다', () => {
    const tb = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
    const m = tb.match(/router\.post\('\/payment\/result-auto-apply', authMiddleware, adminOrMasterMiddleware[\s\S]*?\n\}\);/);
    assert.ok(m, '라우트');
    assert.ok(/findBatchForResultFile/.test(m[0]));
    assert.ok(/res\.json\(\{ \.\.\.out, found, alreadyDone: !found\.pending \}\);/.test(m[0]), '다 처리됐어도 같은 입구(쓰기는 no_pending_items 로 막힘 · 미확인은 보임)');
    assert.ok(/paymentResultSvc\.autoApplyResultFile\(\{\s*batchId: found\.batchId/.test(m[0]));
    assert.ok(!/applyResultFile\(|_commitBatchOutcome/.test(m[0].replace(/autoApplyResultFile/g, '')), '다른 반영 경로 없음');
  });
  await t('4b 화면 — 한 곳 놓기 · 화면 전체 놓기는 입금관리일 때만 · 다른 칸이 받았으면 안 올린다 · 줄 칸은 전파 막음', () => {
    const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
    assert.ok(/<div id="pmBankBar">\$\{_pmBankBarHtml\(\)\}<\/div>\n\s*\$\{_pmResultDropHtml\(\)\}/.test(wd));
    assert.ok(/api\('\/api\/trackb\/payment\/result-auto-apply', \{ method:'POST'/.test(wd));
    assert.ok(/document\.addEventListener\('drop', e=>\{[\s\S]{0,80}if\(e\.defaultPrevented \|\| !_pmDragHasFiles\(e\) \|\| !_pmPageDropOn\(\)\) return;/.test(wd));
    assert.ok(/function _pmPageDropOn\(\)\{ return STATE\.view==='payment' && !document\.querySelector\('\.pmrov'\) && !!document\.getElementById\('pmAnyDrop'\); \}/.test(wd));
    assert.ok(/function _pmResultDrop\(event, i\)\{\n  event\.preventDefault\(\);\n  event\.stopPropagation\(\);/.test(wd));
    assert.ok(/function _pmAnyDrop\(event\)\{\n  event\.preventDefault\(\);\n  event\.stopPropagation\(\);/.test(wd));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
