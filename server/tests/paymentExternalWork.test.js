/**
 * paymentExternalWork.test.js — 결정 317(방식 B) 「리뷰웹 밖 작업」 표시 회귀가드(스텁 · DB 없이)
 * 실행: node tests/paymentExternalWork.test.js
 *
 * 고정하는 것:
 *  1. 표시는 미확인 줄만 · 작업명 필수 · 같은 줄 두 번 쓰기 금지(paymentProof 검사를 먼저 통과) · 파일 원본에서 값을 다시 읽는다
 *  2. 분류 기록일 뿐 — 입금 기록·작업보드·회차 항목을 건드리지 않는다
 *  3. 표시한 줄은 미확인 목록·건수에서 빠지고, 승인 근거로 다시 쓰이지 않으며, '기록 없이 나간 돈'에서도 빠진다
 *  4. 리뷰웹 밖 줄이 섞인 통장 묶음은 통장으로 정하지 않는다(paymentBank 2f 와 짝)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('@e965/xlsx');
const proof = require('../src/services/paymentProof.service');
const EXT = require('../src/services/paymentExternalWork.service');
const { KBANK_AOA } = require('./fixtures/paymentResultFixtures');
const { parseResultAoa } = require('../src/utils/paymentResultParse');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const K = parseResultAoa(KBANK_AOA, {});
const blob = (() => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(KBANK_AOA), 'S'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); })();
const BATCH = '11111111-1111-4111-8111-111111111111', UP = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);

function stubDb({ unmatchedSeqs = [K.rows[8].seq, K.rows[9].seq], batchStatus = 'downloaded' } = {}) {
  const log = [];
  const client = {
    log,
    query: async (sql, params) => {
      log.push({ sql: String(sql), params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
      if (/FROM payment_result_uploads u JOIN payment_batches b/.test(sql)) {
        return { rows: [{ id: UP, bank: 'kbank', file_name: 'r.xlsx', file_blob: blob, batch_status: batchStatus,
          summary: { preview: { unmatchedResults: unmatchedSeqs.map(seq => ({ seq })) } } }] };
      }
      if (/INSERT INTO external_work_transfers/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error('unexpected: ' + String(sql).slice(0, 80));
    },
    release() {},
  };
  return { connect: async () => client, client };
}
function stubProof({ used = false } = {}) {
  const calls = [];
  proof.assertBatchNotHistoryOnly = async () => { calls.push('history'); };
  proof.lockUploadProof = async (db, p) => { calls.push('upload'); return { sha: SHA, uploadId: p.uploadId, batchId: p.batchId }; };
  proof.lockFileProof = async () => { calls.push('lock'); };
  proof.assertProofRowsUnused = async (db, p) => {
    calls.push('unused:' + p.resultSeqs.join(','));
    if (used) { const e = new Error('같은 이체 결과 행이 이미 처리되어 다시 사용할 수 없습니다.'); e.code = 'proof_already_used'; throw e; }
  };
  return calls;
}

(async () => {
  const realProof = { ...proof };
  await t('1 ★ 미확인 줄을 표시 — 잠금·중복 검사 순서 뒤 파일 원본 값으로 기록 · 입금 기록은 안 만든다', async () => {
    const calls = stubProof(); const db = stubDb(); EXT.__setPoolForTest(db);
    const seqs = [K.rows[8].seq, K.rows[9].seq];
    const r = await EXT.markExternalWork({ batchId: BATCH, uploadId: UP, seqs, workName: '  블로그) 한옥카페  소담 ', by: '망고' });
    assert.deepStrictEqual([r.ok, r.marked, r.workName], [true, 2, '블로그) 한옥카페 소담']);
    assert.deepStrictEqual(calls, ['history', 'upload', 'lock', 'unused:' + seqs.join(',')], '잠금 → 같은 줄 두 번 쓰기 검사 → 기록');
    const ins = db.client.log.filter(x => /INSERT INTO external_work_transfers/.test(x.sql));
    assert.strictEqual(ins.length, 2);
    const p = ins[0].params, src = K.rows[8];
    assert.deepStrictEqual([p[0], p[1], p[4], p[6], p[7], p[9]], [SHA, src.seq, 'kbank', src.amount, !!src.success, String(src.accountDigits).slice(-4)]);
    assert.ok(db.client.log.some(x => /^COMMIT/.test(x.sql)));
    assert.ok(!db.client.log.some(x => /payment_records|payment_batch_items|review_index|workboard/i.test(x.sql)), '분류 기록만');
  });
  await t('1b 작업명·줄 없으면 거부(DB 안 감) · 500줄 초과 거부', async () => {
    stubProof(); const db = stubDb(); EXT.__setPoolForTest(db);
    await assert.rejects(EXT.markExternalWork({ batchId: BATCH, uploadId: UP, seqs: [1], workName: '  ' }), e => e.code === 'bad_request');
    await assert.rejects(EXT.markExternalWork({ batchId: BATCH, uploadId: UP, seqs: [], workName: 'x' }), e => e.code === 'bad_request');
    await assert.rejects(EXT.markExternalWork({ batchId: BATCH, uploadId: UP, seqs: Array.from({ length: 501 }, (_, i) => i), workName: 'x' }), e => e.code === 'bad_request');
    assert.strictEqual(db.client.log.length, 0);
  });
  await t('1c ★ 대량이체 사람과 맞춰진 줄(미확인 아님)은 표시 거부 · 되돌림(ROLLBACK)', async () => {
    stubProof(); const db = stubDb({ unmatchedSeqs: [K.rows[9].seq] }); EXT.__setPoolForTest(db);
    await assert.rejects(EXT.markExternalWork({ batchId: BATCH, uploadId: UP, seqs: [K.rows[0].seq], workName: '블로그' }), e => e.code === 'not_unmatched');
    assert.ok(db.client.log.some(x => /^ROLLBACK/.test(x.sql)));
    assert.ok(!db.client.log.some(x => /INSERT INTO external_work_transfers/.test(x.sql)));
  });
  await t('1d ★ 이미 승인·반영·표시된 줄이면 표시 거부(proof_already_used) · 취소된 대량이체 거부', async () => {
    stubProof({ used: true }); let db = stubDb(); EXT.__setPoolForTest(db);
    await assert.rejects(EXT.markExternalWork({ batchId: BATCH, uploadId: UP, seqs: [K.rows[9].seq], workName: '블로그' }), e => e.code === 'proof_already_used');
    stubProof(); db = stubDb({ batchStatus: 'cancelled' }); EXT.__setPoolForTest(db);
    await assert.rejects(EXT.markExternalWork({ batchId: BATCH, uploadId: UP, seqs: [K.rows[9].seq], workName: '블로그' }), e => e.code === 'cancelled');
  });
  Object.assign(proof, realProof);
  EXT.__setPoolForTest(null);

  await t('2 ★ 같은 줄 두 번 쓰기 검사에 표시가 들어 있다 — 질의 수는 늘리지 않는다(같은 줄에 UNION)', () => {
    const src = read('src/services/paymentProof.service.js');
    assert.ok(/payment_amount_mismatch_reconciliations WHERE upload_id::text = ANY\(\$1::text\[\]\) AND result_seq = ANY\(\$2::int\[\]\)\s*UNION ALL\s*SELECT 1 FROM external_work_transfers e JOIN payment_result_uploads eu ON eu\.file_sha256 = e\.file_sha256/.test(src));
  });
  await t('3 표시한 줄은 미확인 목록(미리보기·작업 대조)과 대량이체 목록 건수에서 빠진다(파일 내용 기준)', () => {
    const res = read('src/services/paymentResult.service.js');
    assert.ok(/markedSeqsForUpload\(row\.id, _db\(\)\)\) reviewedSeqs\.add/.test(res), '미리보기');
    assert.ok(/markedSeqsForUpload\(uploadId, db\)\) reviewedSeqs\.add/.test(res), '작업 대조');
    const pay = read('src/services/payment.service.js');
    assert.ok(/UNION SELECT e\.result_seq FROM external_work_transfers e WHERE e\.file_sha256 = ru\.file_sha256\) AS result_resolved_seqs/.test(pay));
    assert.ok(/\.filter\(x => !resolved\.has\(Number\(x && x\.seq\)\)\)/.test(pay));
    const ext = read('src/services/paymentExternalWork.service.js');
    assert.ok(/JOIN payment_result_uploads u ON u\.file_sha256 = e\.file_sha256\s*WHERE u\.id = \$1/.test(ext), '다시 놓아도 유지');
  });
  await t('3b 표시한 성공 이체는 통장 「기록 없이 나간 돈」에서 빠진다', () => {
    const bank = read('src/services/paymentBank.service.js');
    assert.ok(/paidTransfersForBank\(bank,[\s\S]{0,120}\)[\s\S]{0,200}outsideTransfers\(rows, \[\.\.\.paid\.map\([\s\S]{0,80}\), \.\.\.external\]/.test(bank));
  });
  await t('4 ★ 섞인 묶음은 통장으로 정하지 않는다 — reconcileBatch 의 mixed 가 모든 금액을 모름으로', () => {
    const { reconcileBatch } = require('../src/services/paymentBank.service');
    const T = Date.parse('2026-11-02T05:00:00Z');
    const item = (id, a) => ({ id, amount: a, status: 'pending', resultStatus: '' });
    const row = (a, at) => ({ kind: 'bulk_out', amount: a, at });
    const r = reconcileBatch({ batch: { createdAt: T - 60000 }, items: [item('a', 10900), item('b', 10900)], rows: [row(10900, T), row(10900, T + 1), row(30000, T + 2)], now: T + 3600000 });
    assert.deepStrictEqual([r.state, r.mixed, r.amounts[0].failures], ['review', true, null]);
  });
  await t('5 라우트 — 관리자만 · 표시 POST · 목록 GET · 되돌리기 DELETE · 작업명 GET', () => {
    const tb = read('src/routes/trackB.routes.js');
    for (const re of [/router\.post\('\/payment\/batch\/:id\/external-work', authMiddleware, adminOrMasterMiddleware/,
      /router\.get\('\/payment\/batch\/:id\/external-work', authMiddleware, adminOrMasterMiddleware/,
      /router\.delete\('\/payment\/external-work\/:markId', authMiddleware, adminOrMasterMiddleware/,
      /router\.get\('\/payment\/external-work\/names', authMiddleware, adminOrMasterMiddleware/]) assert.ok(re.test(tb), String(re));
  });
  await t('5b 마이그레이션 208 — 파일 내용+줄 번호 유일 · 작업 탭 칸 없음(작업 삭제 분류 대상 아님)', () => {
    const mig = read('migrations/208_external_work_transfers.sql');
    assert.ok(/CREATE TABLE IF NOT EXISTS external_work_transfers/.test(mig) && /UNIQUE \(file_sha256, result_seq\)/.test(mig));
    assert.ok(!/\bsheet_id\b|\btab_name\b/.test(mig));
  });
  await t('6 화면 — 미확인 창에 「리뷰웹 밖 작업으로 표시」 · 작업명 필수 · 표시한 줄 되돌리기 · 섞인 묶음 안내', () => {
    const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
    assert.ok(/<div id="pmExtMark"><\/div><div class="pm-unconfirmed-search">/.test(wd));
    assert.ok(/api\('\/api\/trackb\/payment\/batch\/'\+R\.batch\.id\+'\/external-work',\{method:'POST'/.test(wd));
    assert.ok(/if\(!name\)\{ toast\('작업명을 적어 주세요/.test(wd));
    assert.ok(/_pmExtUndo\(/.test(wd) && /method:'DELETE'/.test(wd));
    assert.ok(/const groups=r\.mixed\?/.test(wd), '통장 대조 창 섞인 묶음 안내');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
