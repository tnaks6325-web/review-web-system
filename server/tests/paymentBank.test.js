/**
 * paymentBank.test.js — 결정 293 통장 자동 대조 회귀가드(스텁 · DB 없이)
 * 끝까지 실제 PG 로 도는 검증은 paymentBankPg.test.js(PGTEST_URL 필요).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}

const MIN = 60 * 1000;
const T = Date.parse('2026-10-26T03:39:00Z');   // 10/26 12:39 KST
const row = (amount, at, kind = 'bulk_out') => ({ tid: `${kind}-${amount}-${at}`, at, amount, kind });
const item = (id, amount, status = 'pending', resultStatus = '') => ({ id, amount, status, resultStatus });

(async () => {
  const bank = require('../src/services/paymentBank.service');
  const { reconcileBatch, planConfirm, outsideTransfers, toBankRow } = bank;

  console.log('§1 거래 한 줄 → 저장 모양');
  await t('1a 이름·적요는 버리고 시각·금액·구분만 · 한국 시간 해석', () => {
    const r = toBankRow({ tradeDT: '20261026123901', tradeAmt: 24000, tran_type: 'withdraw', remark1: '대량이체', remark3: '대량이체', balance: 100, tid: 'X1' });
    assert.deepStrictEqual(r, { tid: 'X1', at: Date.parse('2026-10-26T12:39:01+09:00'), amount: 24000, kind: 'bulk_out', balance: 100 });
    const back = toBankRow({ tradeDT: '20261026123930', tradeAmt: 24000, tran_type: 'deposit', remark1: '대량이체', remark3: '취소', tid: 'X2' });
    assert.strictEqual(back.kind, 'refund_in');
    const named = toBankRow({ tradeDT: '20261026130000', tradeAmt: 30000, tran_type: 'withdraw', remark1: '홍길동', remark3: '즉시이체', tid: 'X3' });
    assert.strictEqual(named.kind, 'other_out');
    assert.ok(!JSON.stringify(named).includes('홍길동'), '받는 사람 이름이 남으면 안 된다');
    assert.strictEqual(toBankRow({ tradeDT: '', tradeAmt: 1 }), null);
    assert.strictEqual(toBankRow({ tradeDT: '20261026130000', tradeAmt: 0 }), null);
  });
  await t('1b 거래번호가 없으면 시각·금액·잔액으로 대신 만든다(같은 거래를 두 번 담지 않게)', () => {
    const a = toBankRow({ tradeDT: '20261026130000', tradeAmt: 5000, tran_type: 'withdraw', remark3: '대량이체', balance: 7 });
    assert.strictEqual(a.tid, 'dt:20261026130000:5000:7:bulk_out');
  });

  console.log('§2 회차 대조');
  const batch = { createdAt: T - 10 * MIN };
  await t('2a 같은 시각 같은 건수 · 10분 지남 → clean', () => {
    const r = reconcileBatch({ batch, items: [item('a', 5980), item('b', 5980), item('c', 3000)],
      rows: [row(5980, T), row(5980, T + 5000), row(3000, T + 9000)], now: T + 20 * MIN });
    assert.strictEqual(r.state, 'clean');
    assert.deepStrictEqual(r.outside, { count: 0, sum: 0 });
  });
  await t('2b ★ 이체 직후(10분 안)는 확정하지 않는다(취소 반환 대기)', () => {
    const r = reconcileBatch({ batch, items: [item('a', 5980)], rows: [row(5980, T)], now: T + 5 * MIN });
    assert.strictEqual(r.state, 'settling');
  });
  await t('2c 통장 부족 → review · 부족 건수만큼 실패', () => {
    const r = reconcileBatch({ batch, items: [item('a', 9800), item('b', 9800), item('c', 3000)],
      rows: [row(9800, T), row(3000, T + 1000)], now: T + 20 * MIN });
    assert.strictEqual(r.state, 'review');
    assert.strictEqual(r.amounts.find(x => x.amount === 9800).failures, 1);
    assert.strictEqual(r.amounts.find(x => x.amount === 3000).failures, 0);
  });
  await t('2d 출금 뒤 취소 반환(82회차 실측: 같은 분) → 그 금액 실패 1', () => {
    const r = reconcileBatch({ batch, items: [item('a', 24000), item('b', 7000)],
      rows: [row(24000, T), row(7000, T + 1000), row(24000, T + 30 * 1000, 'refund_in')], now: T + 20 * MIN });
    const a = r.amounts.find(x => x.amount === 24000);
    assert.deepStrictEqual([r.state, a.refunds, a.failures], ['review', 1, 1]);
  });
  await t('2e ★ 같은 금액이 회차보다 더 찍히면(회차 밖 줄 섞임) 통장으로 정하지 않는다', () => {
    const r = reconcileBatch({ batch, items: [item('a', 5980), item('b', 5980)],
      rows: [row(5980, T), row(5980, T + 1000), row(5980, T + 2000)], now: T + 20 * MIN });
    assert.strictEqual(r.state, 'review');
    assert.strictEqual(r.amounts[0].failures, null);
    assert.deepStrictEqual(r.outside, { count: 1, sum: 5980 });
  });
  await t('2f 회차 밖 다른 금액 줄은 회차 확정을 막지 않고 회차 밖으로 센다', () => {
    const r = reconcileBatch({ batch, items: [item('a', 5980)], rows: [row(5980, T), row(39900, T + 1000)], now: T + 20 * MIN });
    assert.deepStrictEqual([r.state, r.outside.count, r.outside.sum], ['clean', 1, 39900]);
  });
  await t('2g 통장에 이 회차 이체가 없으면 not_found · 절반도 안 맞아도 not_found', () => {
    assert.strictEqual(reconcileBatch({ batch, items: [item('a', 5980)], rows: [], now: T + 20 * MIN }).state, 'not_found');
    const r = reconcileBatch({ batch, items: [item('a', 1), item('b', 2), item('c', 3)], rows: [row(1, T)], now: T + 20 * MIN });
    assert.strictEqual(r.state, 'not_found');
  });
  await t('2h ★ 다른 회차가 이미 완료한 묶음은 이 회차 것으로 보지 않는다', () => {
    const r = reconcileBatch({ batch, items: [item('a', 5980)], rows: [row(5980, T)], claimedTimes: [T + 30 * 1000], now: T + 20 * MIN });
    assert.strictEqual(r.state, 'not_found');
  });
  await t('2i 회차 만들기 전 이체는 후보가 아니다', () => {
    const r = reconcileBatch({ batch: { createdAt: T + 10 * MIN }, items: [item('a', 5980)], rows: [row(5980, T)], now: T + 30 * MIN });
    assert.strictEqual(r.state, 'not_found');
  });
  await t('2j ★ 결과 파일로 처리된 건이 있으면 통장으로 덮지 않는다(file) · 다 끝났으면 done', () => {
    assert.strictEqual(reconcileBatch({ batch, items: [item('a', 5980, 'paid', ''), item('b', 5980)], rows: [row(5980, T)], now: T + 20 * MIN }).state, 'file');
    assert.strictEqual(reconcileBatch({ batch, items: [item('a', 5980, 'paid', '통장 확인')], rows: [row(5980, T)], now: T + 20 * MIN }).state, 'done');
    assert.notStrictEqual(reconcileBatch({ batch, items: [item('a', 5980, 'failed', '통장 확인: 실패'), item('b', 3000)], rows: [row(3000, T)], now: T + 20 * MIN }).state, 'file');
  });

  console.log('§3 확정 계획(고른 실패자)');
  const rec = reconcileBatch({ batch, items: [item('a', 9800), item('b', 9800), item('c', 3000)],
    rows: [row(9800, T), row(3000, T + 1000)], now: T + 20 * MIN });
  const its = [item('a', 9800), item('b', 9800), item('c', 3000)];
  await t('3a 고르지 않으면 맞는 금액만 완료 · 나머지는 그대로', () => {
    const p = planConfirm(rec, its, []);
    assert.deepStrictEqual(p.paid.map(x => x.item.id), ['c']);
    assert.deepStrictEqual(p.failed, []);
    assert.strictEqual(p.unresolved[0].amount, 9800);
  });
  await t('3b 부족 건수만큼 고르면 고른 사람 실패 · 나머지 완료(이체 시각 = 통장 시각)', () => {
    const p = planConfirm(rec, its, ['b']);
    assert.deepStrictEqual(p.paid.map(x => x.item.id).sort(), ['a', 'c']);
    assert.deepStrictEqual(p.failed.map(x => x.item.id), ['b']);
    assert.ok(p.paid.every(x => Number.isFinite(x.at)));
  });
  await t('3c ★ 건수가 틀리거나 · 맞는 금액·다른 회차 사람을 고르면 거부', () => {
    assert.throws(() => planConfirm(rec, its, ['a', 'b']), e => e.code === 'pick_count');
    assert.throws(() => planConfirm(rec, its, ['c']), e => e.code === 'bad_pick');
    assert.throws(() => planConfirm(rec, its, ['zz']), e => e.code === 'bad_pick');
  });
  await t('3d 같은 금액이 더 찍힌 금액은 고를 수 없다(결과 파일로)', () => {
    const r2 = reconcileBatch({ batch, items: [item('a', 5980), item('b', 5980)], rows: [row(5980, T), row(5980, T + 1), row(5980, T + 2)], now: T + 20 * MIN });
    assert.throws(() => planConfirm(r2, [item('a', 5980), item('b', 5980)], ['a']), e => e.code === 'bad_pick');
    assert.deepStrictEqual(planConfirm(r2, [item('a', 5980), item('b', 5980)], []).paid, []);
  });

  console.log('§4 회차 밖으로 나간 돈');
  await t('4a 묶음 − 회차 완료(같은 금액·±2분) − 취소 반환 = 회차 밖', () => {
    const rows = [row(5980, T), row(5980, T + 1000), row(12345, T + 2000), row(24000, T + 3000), row(24000, T + 5000, 'refund_in')];
    const o = outsideTransfers(rows, [{ at: T + 500, amount: 5980 }, { at: T + 600, amount: 5980 }], [], T + 30 * MIN);
    assert.deepStrictEqual([o.count, o.sum], [1, 12345]);
    assert.strictEqual(o.days[0].date, '2026-10-26');
  });
  await t('4b 처리 전 회차가 차지한 묶음·이체 직후 묶음은 아직 세지 않는다(거짓 알림 방지)', () => {
    const rows = [row(5980, T)];
    assert.strictEqual(outsideTransfers(rows, [], [{ start: T, end: T }], T + 30 * MIN).count, 0);
    assert.strictEqual(outsideTransfers(rows, [], [], T + 2 * MIN).count, 0);
    assert.strictEqual(outsideTransfers(rows, [], [], T + 30 * MIN).count, 1);
  });

  console.log('§5 통장 받기(중계 서버)');
  await t('5a 설정이 없으면 받지 않는다(not_configured)', async () => {
    const r = await bank.syncBank({ env: {} });
    assert.strictEqual(r.code, 'not_configured');
  });
  await t('5b 서버 열쇠(X-Relay-Key)를 붙이고 · 모든 쪽 + 덜 받음/모으는 중이면 저장하지 않는다', async () => {
    const calls = [];
    const queries = [];
    const stubPool = {
      query: async (sql, params) => { queries.push(sql); if (/UPDATE payment_bank_sync SET last_synced_at/.test(sql)) return { rows: [{ bank: 'kbank' }] }; return { rows: [] }; },
      connect: async () => ({ query: async (sql) => { queries.push(sql); return { rows: [] }; }, release() {} }),
    };
    bank.__setPoolForTest(stubPool);
    let reply = { success: true, allPages: true, truncated: false, list: [
      { tradeDT: '20261026123901', tradeAmt: 5980, tran_type: 'withdraw', remark1: '대량이체', remark3: '대량이체', tid: 'k1', balance: 1 },
      { tradeDT: '20261026130000', tradeAmt: 30000, tran_type: 'withdraw', remark1: '홍길동', remark3: '즉시이체', tid: 'k2', balance: 2 },
    ] };
    bank.__setFetchForTest(async (url, init) => {
      calls.push({ url, key: init && init.headers && init.headers['X-Relay-Key'], body: init && init.body });
      if (url.endsWith('/api/bank/accounts')) return { status: 200, ok: true, json: async () => ({ accounts: [{ bankCode: '0089', accountNumber: '700' }] }) };
      if (reply.__status) return { status: reply.__status, ok: false, json: async () => reply };
      return { status: 200, ok: true, json: async () => reply };
    });
    const env = { POPBILL_RELAY_URL: 'http://relay.test/', POPBILL_RELAY_KEY: 'rk' };
    const r = await bank.syncBank({ by: 'u', force: true, env, now: T + 60 * MIN });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.fetched, 2);
    assert.ok(calls.every(c => c.key === 'rk'), '모든 호출에 열쇠');
    assert.strictEqual(JSON.parse(calls[1].body).allPages, true);
    const inserts = queries.filter(q => /INSERT INTO payment_bank_rows/.test(q));
    assert.strictEqual(inserts.length, 2);
    for (const [bad, code] of [[{ success: true, allPages: true, truncated: true, list: [] }, 'truncated'],
      [{ success: true, list: [] }, 'relay_old'], [{ __status: 202 }, 'collecting'], [{ __status: 401, error: 'no_key' }, 'relay_failed']]) {
      reply = bad; queries.length = 0;
      const x = await bank.syncBank({ by: 'u', force: true, env, now: T + 60 * MIN });
      assert.strictEqual(x.code, code, JSON.stringify(x));
      assert.ok(!queries.some(q => /INSERT INTO payment_bank_rows/.test(q)), code + ' 이면 저장하지 않는다');
    }
    bank.__setPoolForTest(null); bank.__setFetchForTest(null);
  });

  console.log('§6 배선 · 단일 출처');
  const svc = read('src/services/paymentBank.service.js');
  const res = read('src/services/paymentResult.service.js');
  await t('6a ★ 통장 확정은 결과 파일 반영과 같은 _commitBatchOutcome 으로만 기록한다(사본 금지)', () => {
    assert.match(svc, /result\._commitBatchOutcome\(\{/);
    assert.doesNotMatch(svc, /UPDATE payment_batch_items/);
    assert.doesNotMatch(svc, /INSERT INTO payment_records|recordDeposits\(/);
    assert.match(res, /const \{ paidItems, board, notified, notifyTargets \} = await _commitBatchOutcome\(\{/);
  });
  await t('6b 통장 확정은 남은 건이 있으면 회차를 반영완료로 바꾸지 않는다', () => {
    assert.match(svc, /markApplied: 'when_done'/);
    assert.match(res, /markApplied === 'when_done' && remaining === 0/);
  });
  await t('6c 파일 미리보기는 통장 기록 줄을 고르지 않는다 · 회차 목록은 출처를 구분한다', () => {
    assert.match(res, /COALESCE\(file_format, ''\) <> 'bank'/);
    assert.match(read('src/services/payment.service.js'), /result_summary\.source === 'bank'/);
  });
  await t('6d 라우트 4개 · 관리자 전용', () => {
    const r = read('src/routes/trackB.routes.js');
    for (const p of ["router.get('/payment/bank',", "router.post('/payment/bank/sync',", "router.get('/payment/batch/:id/bank',", "router.post('/payment/batch/:id/bank-confirm',"]) {
      const at = r.indexOf(p);
      assert.ok(at > 0, p);
      assert.match(r.slice(at, at + 160), /authMiddleware, adminOrMasterMiddleware/);
    }
  });
  await t('6e 마이그레이션 203 = 필수 표', () => {
    const idx = read('index.js');
    assert.match(idx, /'payment_bank_rows',/);
    assert.match(idx, /'payment_bank_sync',/);
    assert.match(read('migrations/203_payment_bank_rows.sql'), /PRIMARY KEY \(bank, tid\)/);
  });

  console.log('§7 다른 회차 결과 파일 막기');
  const result = require('../src/services/paymentResult.service');
  await t('7a ★ 이 회차와 절반도 안 맞고 다른 회차와 80% 이상 맞으면 거부 · 두 회차 섞인 파일은 통과', async () => {
    const acct = n => '1100' + String(n).padStart(6, '0');
    const fileRows = Array.from({ length: 10 }, (_, i) => ({ accountDigits: acct(i), amount: 1000 + i }));
    const otherItems = fileRows.map(r => ({ id: 'o', seq: 78, bank_account: r.accountDigits, amount: r.amount }));
    result.__setPoolForTest({ query: async () => ({ rows: otherItems }) });
    const b = { id: 'b76', bank: 'kbank', created_at: new Date(T) };
    await assert.rejects(result.__assertFileBelongsToBatchForTest(b, [], fileRows), e => e.code === 'wrong_batch' && /#78/.test(e.message));
    const half = fileRows.slice(0, 5).map(r => ({ bankAccount: r.accountDigits, amount: r.amount }));
    await result.__assertFileBelongsToBatchForTest(b, half, fileRows);   // 절반 맞으면 통과
    await result.__assertFileBelongsToBatchForTest(b, [], fileRows.slice(0, 4));   // 4줄은 판단 안 함
    result.__setPoolForTest(null);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
