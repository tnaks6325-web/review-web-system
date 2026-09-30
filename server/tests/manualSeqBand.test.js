/**
 * manualSeqBand.test.js — 900000 대역(옛 수동 추가 줄) 방어 회귀가드
 *
 * participantAddSheetless.test.js(참여자 명단 편집기와 함께 결정 186 46번에서 제거)의 E·F 절을
 * 옮겨 왔다 — 편집기는 없어졌지만 아래 방어는 살아 있는 코드가 계속 쓴다.
 *   E. sheetlessLedger.buildValues 가 900000 대역 줄을 배열에 넣지 않고(90만 칸 배열 방어) 뺀 사실을 센다
 *   F. appendSlot·blogRegister·sheetlessApplicant 의 MAX(seq) 가 같은 대역 가드를 쓴다(상수 단일 출처)
 *
 * 실행: node tests/manualSeqBand.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/participants.service');
const ledger = require('../src/services/sheetlessLedger.service');

// ── E. buildValues 900000 대역 방어(실행) ──
const bv = ledger.buildValues({
  headers: ['수취인', '연락처'],
  rows: [
    { seq: 2, row_json: { 수취인: 'A' } },
    { seq: 900001, row_json: { 수취인: '값있는잔재' } },
    { seq: 900002, row_json: {} },
  ],
});
assert.ok(bv.values.length < 1000, `대역 줄이 배열 크기를 정하면 안 된다(실측 ${bv.values.length}칸 — 90만 칸 방어)`);
assert.equal(bv.manualBandSkipped, 2, '뺀 줄 수를 센다(조용한 누락 금지)');
assert.equal(bv.manualBandWithData, 1, '값이 있는 잔재 줄 수를 따로 센다(warn 재료)');
assert.deepEqual(bv.values[1], ['A', ''], '실제 대역 줄은 종전 그대로 실린다');
const bv0 = ledger.buildValues({ headers: ['수취인'], rows: [{ seq: 2, row_json: { 수취인: 'A' } }] });
assert.equal(bv0.manualBandSkipped, 0);
assert.equal(bv0.values.length, 2);
console.log('  E. buildValues 대역 방어 통과');

// ── F. 형제 경로들의 MAX(seq) 대역 가드(단일 출처) ──
const SRC = f => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
const FILTER_RE = /MAX\(seq\) FILTER \(WHERE seq < \$\{(?:_)?MANUAL_SEQ_BASE\}/;
for (const f of ['participants.service.js', 'blogRegister.service.js', 'sheetlessApplicant.service.js']) {
  assert.ok(FILTER_RE.test(SRC(f)), `${f}: MAX(seq) 대역 FILTER (상수 단일 출처)`);
}
const partSrc = SRC('participants.service.js');
const apIdx = partSrc.indexOf('async function appendSlot');
assert.ok(apIdx > -1, 'appendSlot 존재');
assert.ok(FILTER_RE.test(partSrc.slice(apIdx, apIdx + 1200)), 'appendSlot 의 MAX(seq) 도 대역 FILTER');
assert.equal(svc.MANUAL_SEQ_BASE, 900000, 'MANUAL_SEQ_BASE 단일 출처 export');
console.log('  F. 형제 경로 대역 가드 통과');

console.log('✅ manualSeqBand: 전부 통과');
process.exit(0);
