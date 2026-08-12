/**
 * paymentResultApply.test.js — 회귀가드: 리뷰비 입금 M2(이체결과 파일 반영)
 * 실행: node tests/paymentResultApply.test.js
 *
 * 고정하는 것(되돌리면 돈이 잘못 나가거나 두 번 나간다):
 *  A. 미리보기는 **쓰기 0** — 사람이 확인하기 전에는 아무것도 기록하지 않는다
 *  B. 멱등·이중입금 방지 — 처리 대상은 `pending` 뿐(같은 파일 두 번 올려도 두 번 입금되지 않는다)
 *  C. 결과 파일에 없는 건은 **pending 유지**(실패로 내리면 다음 회차에 다시 담겨 이중입금)
 *  D. 은행 실패 건만 `failed` → 잠금이 풀려 다음 회차로(재이체 경로)
 *  E. 입금 시각 = **결과 파일의 실제 이체시점**(지금이 아니다)
 *  F. 입금 기록 단일 출처 — paymentApply.service 재사용(사본 금지)
 *  G. 실패 안내 = 기본 켬 · 재전송 안 함(notified_at) · 은행 응답 원문 미노출
 *  H. 마이그레이션 100 · REQUIRED_SCHEMA · 라우트 · 화면 배선
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readF = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const RES = require('../src/services/paymentResult.service');
const APPLY = require('../src/services/paymentApply.service');
const { HANA_AOA } = require('./fixtures/paymentResultFixtures');
const XLSX = require('@e965/xlsx');

/* ── 픽스처: 하나은행 결과 파일(마스킹 AOA)을 실제 .xlsx 바이너리로 만들어 base64 로 넘긴다 ──
   ★ 파서 입구부터 태워야 "화면이 준 목록을 안 믿는다"는 계약이 실제로 지켜지는지 볼 수 있다. */
function aoaToB64(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}
/* ★ 실측 픽스처는 전건 '처리완료'다(실제 운영 파일도 195/195 · 207/207 성공이었다).
     실패 갈래를 검증하려면 실패 줄이 있어야 하므로 **마지막 줄의 처리상태만** '오류'로 바꾼 사본을 쓴다.
     ★ 픽스처 자체는 건드리지 않는다(실측 서식 그대로 보존 — 파서 가드가 그것을 고정한다). */
const { parseResultAoa, matchKey, digitsOnly } = require('../src/utils/paymentResultParse');
const ORIG = parseResultAoa(HANA_AOA, { expectBank: 'hana' });
assert(ORIG.ok, '픽스처 해석 실패: ' + ORIG.error);
/* ★ 실패로 바꿀 줄은 **계좌+금액이 유일한 줄**로 고른다 — 픽스처에는 같은 키가 2건인 그룹이 있어
     그 줄을 고르면 짝맞추기가 파일 순서대로 앞의 성공 줄을 집어 실패 갈래가 검증되지 않는다. */
const keyN = new Map();
for (const r of ORIG.rows) { const k = matchKey(r.accountDigits, r.amount); keyN.set(k, (keyN.get(k) || 0) + 1); }
const uniq = ORIG.rows.filter(r => keyN.get(matchKey(r.accountDigits, r.amount)) === 1);
assert(uniq.length >= 3, '유일 키 줄이 3건 이상 필요');
const AOA = HANA_AOA.map(r => r.slice());
{
  const target = AOA[uniq[uniq.length - 1].sheetRow - 1];
  const j = target.indexOf('처리완료');
  assert(j >= 0, '처리상태 칸을 찾지 못했다');
  target[j] = '오류';
}
const FILE_B64 = aoaToB64(AOA);

/* 결과 파일에서 성공/실패 줄을 뽑아 회차 항목을 구성한다(계좌 숫자만 + 금액으로 짝지어진다) */
const PARSED = parseResultAoa(AOA, { expectBank: 'hana' });
assert(PARSED.ok, '픽스처 해석 실패: ' + PARSED.error);
const uniqKey = r => keyN.get(matchKey(r.accountDigits, r.amount)) === 1;
const OKROWS = PARSED.rows.filter(r => r.success && uniqKey(r));   // 중복 키 줄은 짝맞추기 순서가 얽혀 제외
const BADROWS = PARSED.rows.filter(r => !r.success);
assert(OKROWS.length >= 2 && BADROWS.length >= 1, '픽스처에 성공/실패 줄이 모두 있어야 한다');

function itemRow(i, r, status) {
  return {
    id: 'item-' + i, sheet_id: 'S1', tab_name: '탭A', row_index: 10 + i,
    reviewer_name: '리뷰어' + i, phone8: '1234567' + i,
    bank_name: '하나', bank_account: r.accountDigits, account_holder: r.holder,
    amount: r.amount, transfer_memo: '파우더망고', status: status || 'pending',
    notified_at: null,
  };
}

/* ── 스텁 pool ─────────────────────────────────────────────── */
function makePool(items, opts = {}) {
  const calls = [];
  const state = items.map(x => ({ ...x }));
  const previews = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params, tx: true });
      const s = String(sql);
      if (/SELECT \* FROM payment_batches WHERE id = \$1 FOR UPDATE/.test(s)) {
        return { rows: [{ id: 'B1', seq: 7, bank: 'hana', status: 'downloaded' }], rowCount: 1 };
      }
      if (/SELECT id FROM payment_batch_items[\s\S]*status = 'pending'[\s\S]*FOR UPDATE/.test(s)) {
        return { rows: state.filter(x => x.status === 'pending').map(x => ({ id: x.id })), rowCount: state.filter(x => x.status === 'pending').length };
      }
      if (/FROM payment_batch_items i[\s\S]*LEFT JOIN review_index r/.test(s)) {
        return { rows: state.filter(x => x.status === 'paid').map(x => ({ ...x, submit_col2: '입금', tab_gid: 'G1' })), rowCount: state.filter(x => x.status === 'paid').length };
      }
      if (/UPDATE payment_batch_items[\s\S]*status = 'paid'/.test(s)) {
        const it = state.find(x => x.id === params[0] && x.status === 'pending');
        if (!it) return { rows: [], rowCount: 0 };
        it.status = 'paid'; it.paid_at = params[1]; it.result_status = params[2];
        return { rows: [it], rowCount: 1 };
      }
      if (/UPDATE payment_batch_items[\s\S]*status = 'failed'/.test(s)) {
        const it = state.find(x => x.id === params[0] && x.status === 'pending');
        if (!it) return { rows: [], rowCount: 0 };
        it.status = 'failed'; it.result_status = params[1];
        return { rows: [{ notified_at: it.notified_at }], rowCount: 1 };
      }
      if (/COUNT\(\*\)::int AS n FROM payment_batch_items[\s\S]*status IN \('paid', 'failed'\)/.test(s)) {
        return { rows: [{ n: state.filter(x => x.status === 'paid' || x.status === 'failed').length }], rowCount: 1 };
      }
      if (/COUNT\(\*\)::int AS n FROM payment_batch_items/.test(s)) {
        return { rows: [{ n: state.filter(x => x.status === 'pending').length }], rowCount: 1 };
      }
      if (/FROM review_index/.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    calls, state,
    connect: async () => client,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params, tx: false });
      const s = String(sql);
      if (/INSERT INTO payment_result_uploads/.test(s)) {
        previews.push({ file_name: params[2], uploaded_at: '2026-08-12T06:04:00.000Z', summary: JSON.parse(params[8]) });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM payment_result_uploads/.test(s)) return { rows: previews.slice(-1), rowCount: previews.length ? 1 : 0 };
      if (/SELECT \* FROM payment_batches WHERE id = \$1$/.test(s.trim())) {
        return { rows: [{ id: 'B1', seq: 7, bank: opts.bank || 'hana', status: opts.batchStatus || 'downloaded' }], rowCount: 1 };
      }
      if (/SELECT \* FROM payment_batch_items WHERE batch_id/.test(s)) return { rows: state, rowCount: state.length };
      if (/UPDATE payment_batch_items SET notified_at/.test(s)) {
        const it = state.find(x => x.id === params[0]); if (it) it.notified_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const WRITE_RE = /\b(INSERT INTO|UPDATE|DELETE FROM)\b/i;

/* ══════════════════════════════════════════════════════════
   A. 미리보기는 이체 상태를 바꾸지 않는다
   ══════════════════════════════════════════════════════════ */
console.log('\n[A] 미리보기 — 마스킹 확인 이력');
(async () => {
  const items = OKROWS.slice(0, 2).map((r, i) => itemRow(i, r));
  const pool = makePool(items);
  RES.__setPoolForTest(pool);
  const out = await RES.previewResultFile({ batchId: 'B1', fileName: 'r.xlsx', base64: FILE_B64 });

  ok('미리보기가 결과를 짝지어 돌려준다', out.ok && out.summary.success === 2, JSON.stringify(out.summary));
  ok('★ 미리보기는 감사 이력만 쓰고 입금 상태는 바꾸지 않는다',
    pool.calls.filter(c => WRITE_RE.test(c.sql)).every(c => /INSERT INTO payment_result_uploads/.test(c.sql)), pool.calls.map(c => c.sql.slice(0, 40)).join(' | '));
  const previewWrite = pool.calls.find(c => /INSERT INTO payment_result_uploads/.test(c.sql));
  const archived = previewWrite && JSON.parse(previewWrite.params[8]).preview;
  ok('★ 미리보기 이력에는 원문 파일 대신 마스킹된 화면 데이터만 남긴다',
    archived && archived.items.every(x => !('bankAccount' in x) && (!x.accountTail || x.accountTail.length <= 4)));
  const saved = await RES.getLatestResultPreview('B1');
  ok('★ 저장된 미리보기는 원문 파일 선택 없이 다시 확인할 수 있다',
    saved.found === true && saved.persisted === true && saved.fileName === 'r.xlsx'
      && saved.items.length === out.items.length && saved.items.every(x => !x.accountTail || x.accountTail.length <= 4));
  ok('★ 트랜잭션을 열지 않는다', pool.calls.every(c => !c.tx));
  ok('★ 계좌는 뒤 4자리만 내려간다(확인 화면에 전체 계좌를 늘리지 않는다)',
    out.items.every(x => !x.accountTail || x.accountTail.length <= 4)
    && JSON.stringify(out.items).indexOf(items[0].bank_account) < 0);

  /* ══════════════════════════════════════════════════════════
     B~E. 반영 — 멱등 · 결과없음 유지 · 실패 처리 · 실제 이체시각
     ══════════════════════════════════════════════════════════ */
  console.log('\n[B~E] 반영 — 멱등 · 결과없음 유지 · 실패 처리 · 이체시각');
  {
    // 성공 2건 + 실패 1건 + 결과 파일에 없는 1건(계좌·금액이 파일과 안 맞는 건)
    const its = [
      itemRow(0, OKROWS[0]),
      itemRow(1, OKROWS[1]),
      itemRow(2, BADROWS[0]),
      { ...itemRow(3, OKROWS[0]), id: 'item-none', bank_account: '9999999999', amount: 12345 },
    ];
    const pool = makePool(its);
    RES.__setPoolForTest(pool);
    const notices = [];
    const csb = require('../src/services/csBridge.service');
    const origNotice = csb.postAdminNotice;
    csb.postAdminNotice = async (p) => { notices.push(p); return { threadId: 1, messageId: 2 }; };
    // 시트/작업표 쓰기는 이 가드의 대상이 아니다(별도 서비스) — 배경 호출만 무해화
    const origMark = APPLY.markDepositCells;
    APPLY.markDepositCells = async () => {};

    const r1 = await RES.applyResultFile({ batchId: 'B1', fileName: 'r.xlsx', base64: FILE_B64, by: '관리자A' });

    ok('성공 2건이 입금완료로 기록된다', r1.applied === 2, JSON.stringify(r1));
    ok('은행 실패 1건이 failed 로 내려간다', r1.failed === 1);
    ok('★ 결과 파일에 없는 건은 pending 그대로(실패로 내리지 않는다 = 이중입금 방지)',
      pool.state.find(x => x.id === 'item-none').status === 'pending');
    ok('★ 이대로 반영을 확정하면 결과없음이 남아도 회차 상태는 적용완료가 된다',
      pool.calls.some(c => /UPDATE payment_batches SET status = 'applied'/.test(c.sql)),
      pool.calls.filter(c => /UPDATE payment_batches/.test(c.sql)).map(c => c.sql).join(' | '));

    const reconcilePool = makePool([
      { ...itemRow(10, OKROWS[0]), id: 'already-paid', status: 'paid' },
      { ...itemRow(11, OKROWS[1]), id: 'still-pending', status: 'pending' },
    ]);
    RES.__setPoolForTest(reconcilePool);
    const reconciled = await RES.markBatchApplied({ batchId: 'B1', by: '관리자A' });
    ok('★ 과거에 반영된 회차는 입금 기록을 다시 쓰지 않고 적용완료 상태만 보정한다',
      reconciled.ok === true && reconciled.appliedItems === 1 && reconciled.remainingPending === 1
        && reconcilePool.calls.some(c => /UPDATE payment_batches SET status = 'applied'/.test(c.sql)),
      JSON.stringify(reconciled));
    RES.__setPoolForTest(pool);

    const stampPool = makePool([
      { ...itemRow(20, OKROWS[0]), id: 'paid-for-stamp', status: 'paid' },
      { ...itemRow(21, OKROWS[1]), id: 'pending-for-stamp', status: 'pending' },
    ]);
    const stampWrites = [];
    RES.__setPoolForTest(stampPool);
    APPLY.markDepositCells = async (items, opts) => { stampWrites.push({ items, opts }); };
    const stampBackfill = await RES.backfillPaidDepositStamp({ batchId: 'B1', stamp: '2026.8.11', by: '관리자A' });
    ok('★ 이미 입금 처리된 항목만 입금 칸에 지정 날짜를 기록하고 payment_records는 다시 만들지 않는다',
      stampBackfill.ok === true && stampBackfill.candidates === 1 && stampWrites.length === 1
        && stampWrites[0].items.length === 1 && stampWrites[0].opts.stamp === '2026.8.11'
        && !stampPool.calls.some(c => /INSERT INTO payment_records|UPDATE review_index SET is_submitted2/.test(c.sql)),
      JSON.stringify(stampBackfill));
    APPLY.markDepositCells = origMark;
    RES.__setPoolForTest(pool);

    const failurePool = makePool([
      { ...itemRow(30, OKROWS[0]), id: 'paid-before-confirm', status: 'paid' },
      { ...itemRow(31, OKROWS[1]), id: 'pending-before-confirm', status: 'pending' },
    ]);
    RES.__setPoolForTest(failurePool);
    const confirmedFailure = await RES.confirmOutstandingFailures({ batchId: 'B1', by: '관리자A' });
    ok('★ 확인된 이체실패만 pending에서 failed로 전환해 다음 회차 대상이 되게 한다',
      confirmedFailure.ok === true && confirmedFailure.failed === 1
        && failurePool.state.find(x => x.id === 'pending-before-confirm').status === 'failed',
      JSON.stringify(confirmedFailure));
    RES.__setPoolForTest(pool);

    const paidRows = pool.state.filter(x => x.status === 'paid');
    ok('★ 입금 시각 = 결과 파일의 실제 이체시점(지금이 아니다)',
      paidRows.length === 2 && paidRows.every(x => x.paid_at && OKROWS.some(o => o.transferredAtIso === x.paid_at)),
      paidRows.map(x => x.paid_at).join(','));
    ok('은행 응답 원문(result_status)을 근거로 남긴다',
      paidRows.every(x => typeof x.result_status === 'string' && x.result_status.length > 0));

    ok('★ 실패 안내는 기본으로 보낸다(사용자 확정 ⑤)', notices.length === 1 && r1.notified === 1);
    ok('★ 안내 문구에 은행 응답 원문을 싣지 않는다',
      notices[0].message === RES.FAIL_NOTICE
      && !/처리상태|오류|미입금/.test(notices[0].message.replace('처리되지 않았습니다', '')));
    ok('★ 안내는 그 행의 리뷰어에게만(phone8 스코프)', notices[0].phone8 === its[2].phone8);

    /* ── 같은 파일 재업로드(멱등) ──
       처리 대상이 pending 뿐이라 이미 끝난 건은 짝맞추기 대상에서 빠진다 →
       "반영할 결과 0건"으로 **거절**되고, 어느 쪽이든 **두 번 입금되지 않는다**. */
    notices.length = 0;
    const before = JSON.stringify(pool.state.map(x => [x.id, x.status, x.paid_at]));
    let r2 = null, r2err = null;
    try { r2 = await RES.applyResultFile({ batchId: 'B1', fileName: 'r.xlsx', base64: FILE_B64, by: '관리자A' }); }
    catch (e) { r2err = e; }
    ok('★★ 같은 파일을 다시 올려도 두 번 입금되지 않는다',
      (r2err ? r2err.code === 'empty' : r2.applied === 0)
      && JSON.stringify(pool.state.map(x => [x.id, x.status, x.paid_at])) === before,
      r2err ? r2err.code : JSON.stringify(r2));
    ok('★ 이미 안내한 실패 건에 다시 보내지 않는다', notices.length === 0);
    ok('★ 재반영해도 결과없음 건은 여전히 pending(다음 파일을 더 받을 수 있다)',
      pool.state.find(x => x.id === 'item-none').status === 'pending');

    /* ── 추가 파일 반영(결과없음 건이 뒤늦게 들어온 경우) ──
       ★ 이 경로가 막히면 "결과없음은 pending 유지" 규칙이 막다른 길이 된다. */
    {
      const rowFor = pool.state.find(x => x.id === 'item-none');
      const extra = ORIG.rows.find(r => uniqKey(r) && !OKROWS.slice(0, 2).includes(r) && r !== BADROWS[0]);
      rowFor.bank_account = extra.accountDigits; rowFor.amount = extra.amount;
      const r4 = await RES.applyResultFile({ batchId: 'B1', fileName: 'r2.xlsx', base64: FILE_B64, by: '관리자A' });
      ok('★ 뒤늦게 결과가 도착하면 그때 입금 기록된다(재반영 경로가 열려 있다)',
        r4.applied === 1 && rowFor.status === 'paid', JSON.stringify(r4));
    }

    // ── 안내 끄기 ──
    {
      const its2 = [itemRow(0, BADROWS[0])];
      const pool2 = makePool(its2);
      RES.__setPoolForTest(pool2);
      notices.length = 0;
      const r3 = await RES.applyResultFile({ batchId: 'B1', fileName: 'r.xlsx', base64: FILE_B64, by: 'A', notifyFailed: false });
      ok('★ 화면에서 끄면 안내를 보내지 않는다', notices.length === 0 && r3.notified === 0 && r3.failed === 1);
    }

    /* ── 이미 안내한 건에는 다시 보내지 않는다(notified_at) ──
       ★ 스텁만으로는 이 갈래에 닿지 않으므로(안내한 건은 이미 failed 라 pending 이 아니다)
         **pending 인데 notified_at 이 있는 상태**를 직접 만들어 확인한다 — 변이시험이 잡은 구멍. */
    {
      const its3 = [{ ...itemRow(0, BADROWS[0]), notified_at: new Date('2026-06-09T00:00:00Z') }];
      const pool3 = makePool(its3);
      RES.__setPoolForTest(pool3);
      notices.length = 0;
      const r5 = await RES.applyResultFile({ batchId: 'B1', fileName: 'r.xlsx', base64: FILE_B64, by: 'A' });
      ok('★ pending 이어도 이미 안내한 건이면 다시 보내지 않는다',
        r5.failed === 1 && notices.length === 0 && r5.notified === 0, JSON.stringify(r5));
    }

    csb.postAdminNotice = origNotice;
    APPLY.markDepositCells = origMark;
    RES.__setPoolForTest(null);
  }

  /* ══════════════════════════════════════════════════════════
     F. 입금 기록 단일 출처
     ══════════════════════════════════════════════════════════ */
  console.log('\n[F] 입금 기록 단일 출처 — paymentApply.service 한 벌');
  {
    const resSrc = noLineComments(read('src/services/paymentResult.service.js'));
    ok('★ 반영 서비스는 review_index·payment_records 에 직접 쓰지 않는다(사본 금지)',
      !/UPDATE review_index/i.test(resSrc) && !/INSERT INTO payment_records/i.test(resSrc));
    /* ★★ 스텁 DB 는 SQL 을 해석하지 않으므로 "조건이 SQL 에 있는가"는 **문장으로 고정**한다 —
         이 조건이 빠지면 이미 paid 인 건이 다시 paid 로 덮여 이중입금 경로가 열린다(변이시험이 잡은 구멍). */
    ok('★★ 모든 대기건 상태 변경 UPDATE가 `AND status = \'pending\'` 조건을 건다', (() => {
      const ups = resSrc.match(/UPDATE payment_batch_items[\s\S]*?`/g) || [];
      const gated = ups.filter(u => /WHERE id = \$1 AND status = 'pending'/.test(u));
      return gated.length === 3;
    })());
    ok('★ recordDeposits / markDepositCells 를 재사용한다',
      /require\('\.\/paymentApply\.service'\)/.test(resSrc)
      && /recordDeposits\(client,/.test(resSrc) && /markDepositCells\(/.test(resSrc));

    const routeSrc = noLineComments(read('src/routes/payment.routes.js'));
    ok('★ 기존 수동 처리(mark-done)도 같은 함수를 쓴다(사본이 남아 있지 않다)',
      /paymentApply\.service/.test(routeSrc)
      && !/UPDATE review_index SET is_submitted2/i.test(routeSrc)
      && !/INSERT INTO payment_records/i.test(routeSrc));

    const applySrc = noLineComments(read('src/services/paymentApply.service.js'));
    ok('★ 무시트 탭은 작업표 칸에 쓰고 시트·큐로 내려가지 않는다(W3-a)',
      /markStatusCell\(/.test(applySrc) && /if \(st\.handled\)/.test(applySrc) && /continue;/.test(applySrc));
    ok('★ 무시트 판정 실패는 fail-open(시트 경로로 진행)',
      /무시트 판정 예외/.test(applySrc));
    ok('★ 시각은 호출자가 준다(건별 stamp 우선)',
      /item\.stamp \|\| opts\.stamp/.test(applySrc) && /item\.paidAt \|\| opts\.paidAt/.test(applySrc));
    ok('★ paid_at 미지정이면 DEFAULT NOW()(종전 동작 보존)',
      /COALESCE\(\$7::timestamptz, NOW\(\)\)/.test(applySrc));
  }

  /* ══════════════════════════════════════════════════════════
     G. 파일·소스 위생
     ══════════════════════════════════════════════════════════ */
  console.log('\n[G] 소스 위생');
  {
    for (const f of ['src/services/paymentResult.service.js', 'src/services/paymentApply.service.js']) {
      ok(`★ ${f} 에 리터럴 NUL 없음(git 바이너리 취급 방지)`,
        fs.readFileSync(path.join(__dirname, '..', f)).indexOf(0) < 0);
    }
    const csb = noLineComments(read('src/services/csBridge.service.js'));
    ok('★ 실패 안내는 기존 실행부 재사용(사본 금지)', /const postAdminNotice = postInspectionReject;/.test(csb));
  }

  /* ══════════════════════════════════════════════════════════
     H. 마이그레이션 · 프리플라이트 · 라우트 · 화면
     ══════════════════════════════════════════════════════════ */
  console.log('\n[H] 마이그레이션 · 프리플라이트 · 라우트 · 화면');
  {
    const mig = read('migrations/100_payment_result_apply.sql');
    for (const c of ['applied_at', 'applied_by', 'result_status', 'result_seq', 'notified_at']) {
      ok(`100 이 ${c} 를 추가한다`, new RegExp('ADD COLUMN IF NOT EXISTS ' + c).test(mig));
    }
    ok('★ 100 은 컬럼 추가·신규 테이블만(기존 데이터 백필 0)',
      !/\bUPDATE\s+payment_/i.test(mig) && !/\bDELETE\s+FROM/i.test(mig));
    ok('감사 이력 테이블을 만든다', /CREATE TABLE IF NOT EXISTS payment_result_uploads/.test(mig));

    const idx = read('index.js');
    ok('★ REQUIRED_SCHEMA 에 100 컬럼 등록(없으면 반영이 통째로 42703)',
      /\['payment_batch_items', 'result_status'\]/.test(idx) && /\['payment_batches', 'applied_at'\]/.test(idx));

    const tb = noLineComments(read('src/routes/trackB.routes.js'));
    for (const p of ['result-preview', 'result-apply']) {
      const re = new RegExp("router\\.post\\('/payment/batch/:id/" + p + "', authMiddleware, adminOrMasterMiddleware");
      ok(`★ /${p} = adminOrMaster(계좌·금액 표면)`, re.test(tb));
    }
    ok('★ 저장된 결과 미리보기 조회도 adminOrMaster로 제한한다',
      /router\.get\('\/payment\/batch\/:id\/result-preview', authMiddleware, adminOrMasterMiddleware/.test(tb));
    ok('★ 반영은 confirm 없이는 실행되지 않는다', /b\.confirm !== true/.test(tb));
    ok('★ 42P01 은 not_ready 로 사유를 말한다(마스킹된 200 방지)', /code: 'not_ready'/.test(tb));
    ok('★ 안내 전송은 명시적으로 끈 경우만 끈다(기본 켬)', /notifyFailed: b\.notifyFailed !== false/.test(tb));

    const wd = readF('frontend/workdesk.html');
    ok('회차 줄에 [이체결과 확인] 버튼(인덱스만 전달)', /onclick="_pmOpenResult\(\$\{i\}\)"/.test(wd));
    ok('★ 이체결과 확인은 파일 선택 없이 저장된 미리보기를 조회한다',
      /function _pmOpenResult\(i\)[\s\S]{0,900}api\('\/api\/trackb\/payment\/batch\/'[\s\S]{0,100}result-preview/.test(wd)
      && !/function _pmOpenResult\(i\)[\s\S]{0,900}_pmPickResult\(i\)/.test(wd));
    ok('★ 미리보기 → 확인 팝업 → 반영 순서', /result-preview/.test(wd) && /result-apply/.test(wd)
      && wd.indexOf('result-preview') < wd.indexOf('result-apply'));
    ok('★ 반영 요청에 파일을 다시 보낸다(서버가 재해석)', /result-apply[\s\S]{0,240}base64:R\.file\.base64/.test(wd));
    ok('★ 순서 배정을 화면이 고지한다', /결과를 순서대로 배정/.test(wd));
    ok('★ 결과없음은 "대기 유지"라고 말한다', /그대로 대기 상태로 둡니다/.test(wd));
    ok('실패 안내 체크박스(기본 켬)', /id="pmNotifyFail"/.test(wd) && /계좌 확인 안내/.test(wd));
    ok('★ 확인 팝업은 body 직속', /document\.body\.appendChild\(el\);\s*\/\/ ★ body 직속/.test(wd));
    ok('★ Esc 리스너는 최상위 1회만', /_pmResultKeyBound/.test(wd));

    const brief = noLineComments(read('src/routes/reviewEdit.routes.js'));
    ok('★ 리뷰어 brief 에 입금 결과를 싣는다', /FROM payment_batch_items/.test(brief) && /payment,\s/.test(brief));
    ok('★★ 리뷰어 응답에 계좌번호·은행 응답 원문을 싣지 않는다', (() => {
      const i = brief.indexOf('let payment = null;');
      const blk = brief.slice(i, i + 1200);
      return /status, paid_at, amount, transfer_memo/.test(blk)
        && !/bank_account/.test(blk) && !/result_status/.test(blk) && !/fail_reason/.test(blk);
    })());

    const home = readF('frontend/index.html');
    ok('참여상품 정보 팝업이 입금 결과를 그린다', /brief\.payment/.test(home));
    ok('★ 실패는 다음 행동을 준다(내 계좌 정보 수정하기)', /_partInfoGoAccount/.test(home));
  }

  console.log(`\n✅ paymentResultApply 회귀가드 통과 — ${passed}케이스`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
