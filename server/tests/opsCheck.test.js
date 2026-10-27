/**
 * opsCheck.test.js — 결정 302 「오늘 확인할 것」 계산·문장 규칙(DB 없이)
 *   ① 2026-10-27 #84 와 같은 모양: 19,800원 2명·20,900원 1명이 통장에 없음 + 1,000원 22건·332,200원 1건 기록 없이 나감
 *   ② 기본 문장 · ③ AI 문장 검사(지어낸 숫자·키 어긋남 거부) · ④ 처리 완료 판정 · ⑤ AI 실패 → 기본 문장
 */
'use strict';
const assert = require('assert');
const oc = require('../src/services/opsCheck.service');

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('  ✓ ' + name); }

const START = Date.parse('2026-10-27T12:41:46+09:00');
const rowsOf = (amount, n) => Array.from({ length: n }, (_, i) => ({ at: START + i * 100, amount, kind: 'bulk_out' }));
const cluster = { start: START, end: START + 19000, rows: [...rowsOf(19800, 16), ...rowsOf(20900, 15), ...rowsOf(5980, 15), ...rowsOf(1000, 22), ...rowsOf(332200, 1)] };
const openRec = {
  amounts: [
    { amount: 19800, count: 18, bank: 16, refunds: 0, failures: 2 },
    { amount: 20900, count: 16, bank: 15, refunds: 0, failures: 1 },
    { amount: 5980, count: 15, bank: 15, refunds: 0, failures: 0 },
  ],
  items: [
    ...Array.from({ length: 18 }, (_, i) => ({ id: 'a' + i, amount: 19800, status: 'pending', tabName: '탈모샴푸', reviewerName: '이름' + i })),
    ...Array.from({ length: 16 }, (_, i) => ({ id: 'b' + i, amount: 20900, status: 'pending', tabName: '바디워시', reviewerName: '이름' + i })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: 'c' + i, amount: 5980, status: 'pending', tabName: '군인핫팩', reviewerName: '이름' + i })),
  ],
};
const facts = oc.buildClusterFacts({
  cluster, rows: cluster.rows, openRec, batch: { id: 'b-84', seq: 84, createdBy: '박세희' },
  feeWorks: new Map([[1000, ['누룽칩2차']]]), refundWindowMs: 30 * 60 * 1000,
});

(async () => {
  await t('① 빠진 사람은 금액마다 · 작업명은 싣고 리뷰어 이름은 싣지 않는다', () => {
    assert.deepStrictEqual(facts.short.map(x => [x.amount, x.failures, x.jobs]), [[19800, 2, ['탈모샴푸']], [20900, 1, ['바디워시']]]);
    assert.ok(!JSON.stringify(facts).includes('이름'), '리뷰어 이름이 사실에 섞였다');
  });
  await t('① 기록 없이 나간 돈 = 묶음 − 대량이체 몫(통장에 있는 만큼) − 취소 반환', () => {
    assert.deepStrictEqual(facts.outside.map(o => [o.key, o.count]), [['out:332200', 1], ['out:1000', 22]]);
    assert.deepStrictEqual(facts.outsideTotal, { count: 23, sum: 354200 });
    assert.deepStrictEqual(facts.outside.find(o => o.amount === 1000).guess, { kind: 'fee_only_work', works: ['누룽칩2차'] });
    assert.strictEqual(facts.cluster.date, '10/27'); assert.strictEqual(facts.cluster.time, '12:41');
  });
  await t('① 취소로 돌아온 돈은 기록 없이 나간 돈에서 뺀다', () => {
    const rows = [...cluster.rows, { at: START + 60000, amount: 1000, kind: 'refund_in' }];
    const f = oc.buildClusterFacts({ cluster, rows, openRec, batch: null, refundWindowMs: 30 * 60 * 1000 });
    assert.strictEqual(f.outside.find(o => o.amount === 1000).count, 21);
  });
  await t('① 처리 끝난 대량이체(이체 완료 줄)는 그만큼 뺀다 · 같은 금액이 더 찍히면 통장만으로 모름', () => {
    const f = oc.buildClusterFacts({ cluster: { start: START, end: START, rows: rowsOf(7000, 3) }, rows: [], openRec: null, batch: null,
      paidElsewhere: [{ amount: 7000 }, { amount: 7000 }], refundWindowMs: 0 });
    assert.deepStrictEqual(f.outside.map(o => o.count), [1]);
    const g = oc.buildClusterFacts({ cluster: { start: START, end: START, rows: rowsOf(7000, 3) }, rows: [],
      openRec: { amounts: [{ amount: 7000, count: 2, bank: 3, refunds: 0, failures: null }], items: [] }, batch: null, refundWindowMs: 0 });
    assert.deepStrictEqual(g.shortUnknown, [{ amount: 7000, count: 2, bank: 3 }]);
    assert.deepStrictEqual(g.outside.map(o => [o.amount, o.count]), [[7000, 1]]);
  });
  await t('② 기본 문장 — 자리(키)와 뜻', () => {
    const l = oc.fallbackLines(facts);
    assert.deepStrictEqual(l.map(x => x.key), ['short', 'out', 'out:332200', 'out:1000']);
    assert.match(l[0].text, /통장에서 3명이 안 나갔습니다 — 탈모샴푸 19,800원 2명 \/ 바디워시 20,900원 1명/);
    assert.match(l[0].text, /이체 파일에서 뺀 것으로 보입니다/);
    assert.match(l[1].text, /23건 · 354,200원/);
    assert.match(l[3].text, /누룽칩2차/);
  });
  await t('③ AI 문장 — 사실 속 숫자만 쓰면 통과', () => {
    const ok = [
      { key: 'short', text: '#84 대량이체에서 3명이 통장에 없습니다(탈모샴푸 19,800원 2명, 바디워시 20,900원 1명). 파일에서 뺀 것으로 보입니다.' },
      { key: 'out', text: '리뷰웹 기록 없이 23건, 354,200원이 같이 나갔습니다.' },
      { key: 'out:332200', text: '332,200원 1건' },
      { key: 'out:1000', text: '1,000원 22건 — 누룽칩2차 리뷰비로 보입니다' },
    ];
    assert.strictEqual(oc.validateAiLines(facts, ok), true);
  });
  await t('③ AI 문장 — 지어낸 숫자 · 키 어긋남 · 개수 다름은 거부', () => {
    const base = oc.fallbackLines(facts);
    const bad1 = base.map(x => x.key === 'out' ? { ...x, text: '기록 없이 24건이 나갔습니다' } : x);
    assert.strictEqual(oc.validateAiLines(facts, bad1), false);
    const bad2 = base.map((x, i) => i === 0 ? { ...x, key: 'shortX' } : x);
    assert.strictEqual(oc.validateAiLines(facts, bad2), false);
    assert.strictEqual(oc.validateAiLines(facts, base.slice(1)), false);
  });
  await t('④ 처리 완료 = 빠진 사람 없음 + 금액 묶음마다 모르겠음 아닌 답', () => {
    assert.strictEqual(oc.isDone(facts, {}), false);
    const noShort = { ...facts, short: [] };
    assert.strictEqual(oc.isDone(noShort, { 'out:1000': { choice: 'direct' } }), false);
    assert.strictEqual(oc.isDone(noShort, { 'out:1000': { choice: 'direct' }, 'out:332200': { choice: 'unknown' } }), false);
    assert.strictEqual(oc.isDone(noShort, { 'out:1000': { choice: 'direct' }, 'out:332200': { choice: 'not_reviewer' } }), true);
    // Codex P2 — 통장만으로 모르는 금액이 남아 있으면 답을 다 해도 열린 채로
    assert.strictEqual(oc.isDone({ ...noShort, shortUnknown: [{ amount: 7000, count: 2, bank: 3 }] }, { 'out:1000': { choice: 'direct' }, 'out:332200': { choice: 'not_reviewer' } }), false);
  });
  await t('⑤ AI 가 숫자를 지어내거나 실패하면 기본 문장', async () => {
    oc.__setGenerateForTest(async () => JSON.stringify({ lines: oc.fallbackLines(facts).map(x => ({ ...x, text: x.text + ' 9999' })) }));
    let r = await oc.writeLines(facts);
    assert.strictEqual(r.source, 'fallback');
    oc.__setGenerateForTest(async () => { throw new Error('timeout'); });
    r = await oc.writeLines(facts);
    assert.strictEqual(r.source, 'fallback'); assert.strictEqual(r.lines.length, 4);
    oc.__setGenerateForTest(async () => '```json\n' + JSON.stringify({ lines: oc.fallbackLines(facts) }) + '\n```');
    r = await oc.writeLines(facts);
    assert.strictEqual(r.source, 'ai');
    oc.__setGenerateForTest(null);
  });
  await t('⑤ AI 에 보내는 글에 리뷰어 이름·계좌가 없다', async () => {
    let sent = '';
    oc.__setGenerateForTest(async p => { sent = p; return '{}'; });
    await oc.writeLines(facts);
    oc.__setGenerateForTest(null);
    assert.ok(sent && !/이름\d/.test(sent) && !/계좌번호/.test(sent));
  });
  console.log(`opsCheck: ${pass} passed`);
})().catch(e => { console.error(e); process.exit(1); });
