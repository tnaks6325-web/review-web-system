/**
 * opsCheckPg.test.js — 결정 302 「오늘 확인할 것」 · **진짜 PG** 끝까지 검증
 * 실행: PGTEST_URL=postgres://... node tests/opsCheckPg.test.js   (★ 마이그레이션된 **복사본** DB 에서만 — 행을 넣는다)
 *
 *   ① 통장 받은 뒤 갱신 → 묶음 하나에 확인거리 1개(담당 만두 · 빠진 사람 19,800원 1명 · 기록 없는 돈 1,000원×3 · 332,200원×1 · 추정 작업)
 *   ② 같은 사실로 다시 갱신 → AI 를 다시 부르지 않는다 · 줄이 늘지 않는다
 *   ③ 답 저장 · 없는 키·잘못된 답 거부
 *   ④ 빠진 사람이 정해지면(이체 완료/실패 기록) 그 줄이 사라지고, 남은 답을 다 하면 처리 완료
 *   ⑤ 고르기 힌트 — 처음 받는 계좌 · 예전에 이체 실패 · 예금주가 리뷰어와 다름 · 같은 대량이체에 같은 계좌
 */
'use strict';

if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀 (계산 규칙은 opsCheck.test.js)');
  process.exit(0);
}

const pool = require('../src/db/pool');
const oc = require('../src/services/opsCheck.service');
const bank = require('../src/services/paymentBank.service');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); fail++; }
}
const SHEET = 'wt_opstest0000000001';
const NOW = Date.now();
const MIN = 60 * 1000;
const iso = ms => new Date(ms).toISOString();

async function cleanup() {
  await pool.query(`DELETE FROM ops_checks WHERE ref_key LIKE 'bank_cluster:%'`);
  await pool.query(`DELETE FROM payment_batch_items WHERE sheet_id = $1`, [SHEET]);
  await pool.query(`DELETE FROM payment_batches WHERE created_by IN ('박세희','ops-old')`);
  await pool.query(`DELETE FROM payment_bank_rows WHERE tid LIKE 'opstest-%'`);
  await pool.query(`DELETE FROM tab_configs WHERE sheet_id = $1`, [SHEET]);
}
async function batch(createdAt, by, status) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO payment_batches (bank, created_by, status, created_at) VALUES ('kbank',$1,$2,$3) RETURNING id, seq`, [by, status, iso(createdAt)]);
  return b;
}
async function item(b, row, { amount, acc, name, holder, status = 'pending', paidAt = null, tab = '탈모샴푸' }) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO payment_batch_items (batch_id, sheet_id, tab_name, row_index, reviewer_name, phone8, bank_name, bank_account, account_holder,
       product_price, review_fee, amount, status, transfer_memo, paid_at)
     VALUES ($1,$2,$3,$4,$5,'00000000','국민',$6,$7,$8,0,$8,$9,'시험',$10) RETURNING id`,
    [b.id, SHEET, tab, row, name, acc, holder || name, amount, status, paidAt ? iso(paidAt) : null]);
  return r.id;
}
async function bankRow(n, at, amount, kind = 'bulk_out') {
  await pool.query(`INSERT INTO payment_bank_rows (bank, tid, traded_at, amount, kind) VALUES ('kbank',$1,$2,$3,$4)`,
    [`opstest-${n}`, iso(at), amount, kind]);
}

(async () => {
  await cleanup();
  // 옛 대량이체 — A·B 계좌는 받은 적 있음, D 계좌는 실패한 적 있음
  const old = await batch(NOW - 3 * 24 * 60 * MIN, 'ops-old', 'applied');
  await item(old, 1, { amount: 5000, acc: '111-1', name: '가', status: 'paid', paidAt: NOW - 3 * 24 * 60 * MIN });
  await item(old, 2, { amount: 5000, acc: '222-2', name: '나', status: 'paid', paidAt: NOW - 3 * 24 * 60 * MIN });
  await item(old, 3, { amount: 5000, acc: '444-4', name: '라', status: 'failed' });
  // 오늘 대량이체(만두) — 19,800×3 · 20,900×2
  const b = await batch(NOW - 60 * MIN, '박세희', 'downloaded');
  const A = await item(b, 11, { amount: 19800, acc: '111-1', name: '가' });
  const B = await item(b, 12, { amount: 19800, acc: '222-2', name: '나' });
  const C = await item(b, 13, { amount: 19800, acc: '333-3', name: '다', holder: '다른사람' });
  const D = await item(b, 14, { amount: 20900, acc: '444-4', name: '라', tab: '바디워시' });
  const E = await item(b, 15, { amount: 20900, acc: '111-1', name: '가', tab: '바디워시' });
  await pool.query(`UPDATE payment_batches SET item_count = 5, total_amount = 19800*3 + 20900*2 WHERE id = $1`, [b.id]);
  // 통장 — 19,800×2(1명 빠짐) · 20,900×2 · 기록 없는 1,000×3 · 332,200×1
  const T = NOW - 40 * MIN; let n = 0;
  for (const a of [19800, 19800, 20900, 20900, 1000, 1000, 1000, 332200]) await bankRow(++n, T + n * 1000, a);
  await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheetless, transfer_bank, review_fee, display_name)
    VALUES ($1,'누룽칩2차탭','900000301','누룽칩2차',TRUE,'제품비업체·리뷰비케이뱅크',1000,'누룽칩2차')`, [SHEET]);

  let calls = 0;
  oc.__setGenerateForTest(async () => { calls++; return '{"lines":[]}'; });   // 틀린 답 → 기본 문장
  let r = await oc.refreshBankChecks({ now: NOW, by: 'tester' });
  let { rows } = await pool.query(`SELECT * FROM ops_checks WHERE ref_key LIKE 'bank_cluster:%'`);
  ok('① 묶음 하나에 확인거리 1개', r.created === 1 && rows.length === 1, r);
  const c = rows[0];
  ok('① 담당 = 대량이체 만든 사람(박세희 → 만두)', c && c.manager === '만두', c && c.manager);
  ok('① 빠진 사람 19,800원 1명 · 작업명 탈모샴푸', c && JSON.stringify(c.facts.short.map(x => [x.amount, x.failures, x.jobs])) === JSON.stringify([[19800, 1, ['탈모샴푸']]]), c && c.facts.short);
  ok('① 기록 없는 돈 1,000원×3 · 332,200원×1', c && JSON.stringify(c.facts.outside.map(o => [o.amount, o.count])) === JSON.stringify([[332200, 1], [1000, 3]]), c && c.facts.outside);
  ok('① 1,000원 = 리뷰비만 보내는 작업(누룽칩2차) 추정', c && (c.facts.outside.find(o => o.amount === 1000).guess || {}).works?.includes('누룽칩2차'));
  ok('① AI 가 틀리면 기본 문장', c && c.text_source === 'fallback' && c.lines.length === 4, c && c.lines);
  ok('① 대량이체 #번호가 사실에 있다', c && c.facts.batch && Number(c.facts.batch.seq) === Number(b.seq));

  r = await oc.refreshBankChecks({ now: NOW + 1000, by: 'tester' });
  ok('② 같은 사실이면 AI 를 다시 부르지 않는다', calls === 1, calls);
  ({ rows } = await pool.query(`SELECT count(*)::int n FROM ops_checks`));
  ok('② 줄이 늘지 않는다', rows[0].n === 1);

  let err = null;
  try { await oc.answerCheck({ id: c.id, key: 'out:9999', choice: 'direct', by: 't' }); } catch (e) { err = e; }
  ok('③ 없는 금액 묶음은 거부', err && err.code === 'bad_key');
  err = null;
  try { await oc.answerCheck({ id: c.id, key: 'out:1000', choice: 'maybe', by: 't' }); } catch (e) { err = e; }
  ok('③ 정해진 답이 아니면 거부', err && err.code === 'bad_choice');
  let v = await oc.answerCheck({ id: c.id, key: 'out:1000', choice: 'direct', memo: '누룽칩 리뷰비', by: '망고' });
  ok('③ 답 저장 · 아직 처리 중(빠진 사람·332,200원 남음)', v.status === 'open' && v.answers['out:1000'].memo === '누룽칩 리뷰비' && v.answers['out:1000'].by === '망고');

  // ⑤ 힌트(③ 확정 전 — 처리 전 줄)
  const hints = await bank.itemHints(b.id, [A, B, C, D, E]);
  ok('⑤ 받은 적 있는 계좌는 「처음 받는 계좌」 아님', !hints[A].includes('처음 받는 계좌') && !hints[B].includes('처음 받는 계좌'), hints);
  ok('⑤ C = 처음 받는 계좌 + 예금주가 리뷰어와 다름', hints[C].includes('처음 받는 계좌') && hints[C].includes('예금주가 리뷰어와 다름'), hints[C]);
  ok('⑤ D = 예전에 이체 실패', hints[D].includes('예전에 이체 실패'), hints[D]);
  ok('⑤ A·E 같은 계좌 = 같은 날 다른 작업에도 있음', hints[A].includes('같은 날 다른 작업에도 있음') && hints[E].includes('같은 날 다른 작업에도 있음'));

  // ④ 빠진 사람이 C 로 정해짐(통장 확정과 같은 결과를 직접 기록) → 갱신하면 빠진 사람 줄이 사라진다
  await pool.query(`UPDATE payment_batch_items SET status='paid', paid_at=$2 WHERE batch_id=$1 AND id <> $3`, [b.id, iso(T + 1000), C]);
  await pool.query(`UPDATE payment_batch_items SET status='failed' WHERE id=$1`, [C]);
  oc.__setGenerateForTest(async () => { calls++; throw new Error('down'); });
  await oc.refreshBankChecks({ now: NOW + 2000, by: 'tester' });
  ({ rows } = await pool.query(`SELECT * FROM ops_checks WHERE id = $1`, [c.id]));
  ok('④ 빠진 사람 줄이 사라지고 기록 없는 돈은 그대로 · 받은 답도 그대로', rows[0].facts.short.length === 0
    && rows[0].facts.outside.length === 2 && rows[0].answers['out:1000'] && rows[0].status === 'open', rows[0].facts);
  v = await oc.answerCheck({ id: c.id, key: 'out:332200', choice: 'not_reviewer', memo: '업체 환불', by: '망고' });
  ok('④ 남은 답을 다 하면 처리 완료', v.status === 'done' && v.doneBy === '망고', v);
  const list = await oc.listChecks({});
  ok('④ 목록에 방금 끝난 것도 보인다(최근 2일)', list.some(x => x.id === Number(c.id) && x.status === 'done'));

  // ⑥ Codex P2 — AI 를 기다리는 사이 저장한 답이 갱신에 지워지지 않는다
  await pool.query(`DELETE FROM ops_checks`);
  await bankRow(++n, T + 30000, 1000);   // 사실이 바뀌게(1,000원 하나 더)
  oc.__setGenerateForTest(null);
  await oc.refreshBankChecks({ now: NOW + 3000, by: 'tester' });
  ({ rows } = await pool.query(`SELECT * FROM ops_checks WHERE ref_key LIKE 'bank_cluster:%'`));
  const c2 = rows[0];
  await bankRow(++n, T + 31000, 1000);
  oc.__setGenerateForTest(async () => { await oc.answerCheck({ id: c2.id, key: 'out:1000', choice: 'direct', memo: '중간 저장', by: '만두' }); throw new Error('slow'); });
  await oc.refreshBankChecks({ now: NOW + 4000, by: 'tester' });
  ({ rows } = await pool.query(`SELECT * FROM ops_checks WHERE id = $1`, [c2.id]));
  ok('⑥ 갱신 중 저장한 답이 남는다', rows[0].answers['out:1000'] && rows[0].answers['out:1000'].memo === '중간 저장'
    && rows[0].facts.outside.find(o => o.amount === 1000).count === 5, rows[0].answers);

  oc.__setGenerateForTest(null);
  await cleanup();
  await pool.end();
  console.log(`\nopsCheckPg: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); try { await pool.end(); } catch (_) {} process.exit(1); });
