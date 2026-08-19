'use strict';
/*
 * "직원이 최초로 적은 입금일" 복원 — 판정·동작 회귀가드 (사용자 확정 2026-08-19).
 *
 *   목표 상태: 원래 줄(리뷰 제출된 줄)에는 직원이 친 값이 **그대로 남고**,
 *              번져 나간 줄에서는 **사라진다**.
 *   ★ 오버레이만으로는 중복 줄을 구분할 수 없으므로(합성 앵커가 같다) 원래 줄에 **실제로 새기고**
 *     오버레이는 이력으로 내린다.
 *   ★ 입금 원장이 있는 줄은 **지우지 않는다**(실제 이체일 수 있다 — fail-closed).
 *   ★ 제출된 줄이 0개·2개 이상이면 **보류**(자동 판단 금지).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const svcPath = path.join(root, 'src/services/manualDepositRepair.service.js');

function makePool(editRows, bank) {
  const writes = [];
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK|advisory_xact_lock/.test(s)) return { rows: [] };
      if (/FROM participant_edits pe/.test(s) && /JOIN campaign_participants/.test(s)) return { rows: editRows };
      // ★ 더 좁은 조건을 먼저 — uploads 쿼리 안에도 `payment_batch_items` EXISTS 가 들어 있어
      //   순서를 바꾸면 items 분기가 가로챈다(스텁 매칭 순서 함정, CLAUDE.md 규율).
      if (/FROM payment_result_uploads u/.test(s)) return { rows: (bank && bank.uploads) || [] };
      if (/FROM payment_batch_items i/.test(s) && /JOIN payment_batches b/.test(s)) {
        if (bank && bank.itemsThrow) throw new Error('items down');
        return { rows: (bank && bank.items) || [] };
      }
      writes.push({ s, params });
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { writes, client, async connect() { return client; }, async query(a, b) { return client.query(a, b); } };
}

function row(o) {
  return {
    editId: o.editId || 'e1', sheetId: 's', tabName: 'T',
    anchorType: 'order', anchorValue: 'os-1', stamp: o.stamp || '8/11',
    createdBy: '직원', createdAt: o.createdAt || null, depositColKey: '입금', sheetless: o.sheetless !== false,
    rowId: o.rowId, rowIndex: o.rowIndex, reviewerName: o.name || '박',
    paidValue: o.paidValue == null ? (o.stamp || '8/11') : o.paidValue,
    submitted: !!o.submitted, hasLedger: !!o.hasLedger,
    ledgerPaidAt: o.ledgerPaidAt || null, hasReviewFile: !!o.hasReviewFile,
    firstSeenAt: o.firstSeenAt || null, createdAt: o.createdAt || null,
  };
}

(async () => {
  const poolPath = require.resolve(path.join(root, 'src/db/pool'));
  const ledgerPath = require.resolve(path.join(root, 'src/services/sheetlessLedger.service'));
  const install = (p) => {
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: p };
    require.cache[ledgerPath] = { id: ledgerPath, filename: ledgerPath, loaded: true,
      exports: { rebuildLedgers: async () => ({ ok: true }) } };
    delete require.cache[require.resolve(svcPath)];
    return require(svcPath);
  };

  /* 1. 제출 1개 → 그 줄에 새기고 나머지에서 지운다 */
  let pool = makePool([
    row({ rowId: 'a', rowIndex: 38, submitted: true }),
    row({ rowId: 'b', rowIndex: 96, submitted: false }),
  ]);
  let svc = install(pool);
  let pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].keepRow, 38, '1a: 리뷰 제출된 줄이 원래 줄');
  assert.deepEqual(pv.items[0].clearRows, [96], '1b: 번진 줄만 지운다');
  assert.equal(pool.writes.length, 0, '1c: 미리보기는 쓰기 0');

  let out = await svc.applyOverlayFanoutFix({ by: 't' });
  const cw = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(cw.length, 2, '1d: 원래 줄 새김 + 번진 줄 제거');
  assert.equal(cw[0].params[0], 'a', '1e: 첫 쓰기는 원래 줄');
  assert.equal(cw[0].params[2], '8/11', '1f: 직원이 친 값을 그대로 새긴다');
  assert.ok(/is_paid = TRUE/.test(cw[0].s), '1g: 원래 줄은 입금완료로');
  assert.equal(cw[1].params[0], 'b');
  assert.equal(cw[1].params[2], '', '1h: 번진 줄에서는 값이 사라진다');
  const rv = pool.writes.filter(w => /UPDATE participant_edits SET reverted_at/.test(w.s));
  assert.equal(rv.length, 1, '1i: 오버레이를 이력으로 내린다');
  assert.ok(/field IN \('col:입금', 'is_paid'\)/.test(rv[0].s), '1j: 짝 is_paid 토글도 함께 — 집계가 어긋나지 않게');
  assert.equal(out.keptRows, 1); assert.equal(out.clearedRows, 1);

  /* 2. 입금 원장이 있는 줄은 지우지 않는다(fail-closed) */
  pool = makePool([
    row({ rowId: 'a', rowIndex: 38, submitted: true }),
    row({ rowId: 'b', rowIndex: 96, submitted: false, hasLedger: true }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.deepEqual(pv.items[0].clearRows, [], '2a: 원장 있는 줄은 지움 대상 아님');
  assert.deepEqual(pv.items[0].ledgerBlockedRows, [96], '2b: 보존 사유를 드러낸다');
  await svc.applyOverlayFanoutFix({});
  assert.ok(!pool.writes.some(w => /UPDATE campaign_participants/.test(w.s) && w.params[0] === 'b'),
    '2c: 원장 있는 줄은 건드리지 않는다');

  /* 3. 제출 0개·2개 이상 → 보류(쓰기 0) */
  for (const [rows, why] of [
    [[row({ rowId: 'a', rowIndex: 1 }), row({ rowId: 'b', rowIndex: 2 })], 'no_submitted_row'],
    [[row({ rowId: 'a', rowIndex: 1, submitted: true }), row({ rowId: 'b', rowIndex: 2, submitted: true })], 'multiple_submitted_rows'],
  ]) {
    pool = makePool(rows); svc = install(pool);
    pv = await svc.previewOverlayFanoutFix({});
    assert.equal(pv.items[0].hold, why, `3: ${why} 는 보류`);
    assert.equal(pv.items[0].keepRow, null, '3b: 원래 줄을 임의로 고르지 않는다');
    await assert.rejects(() => svc.applyOverlayFanoutFix({}), /복원할 대상이 없습니다/);
    assert.equal(pool.writes.length, 0, '3c: 보류는 쓰기 0');
  }

  /* 4. 시트 기반 탭은 보류 */
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, submitted: true, sheetless: false }),
    row({ rowId: 'b', rowIndex: 2, sheetless: false }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].hold, 'not_sheetless', '4a: 시트 기반은 보류');

  /* 5. 같은 칸의 다른 입금일은 보존 — 그 값만 뺀다 */
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, submitted: true, paidValue: '' }),
    row({ rowId: 'b', rowIndex: 2, paidValue: '8/3, 8/11' }),
  ]);
  svc = install(pool);
  await svc.applyOverlayFanoutFix({});
  const w5 = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(w5.find(w => w.params[0] === 'b').params[2], '8/3', '5a: 다른 입금일은 보존');

  /* 6. 날짜가 아닌 표기(계좌 오류)도 그대로 복원되고 번진 줄에서만 사라진다 */
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, submitted: true, stamp: '계좌 오류', paidValue: '' }),
    row({ rowId: 'b', rowIndex: 2, stamp: '계좌 오류', paidValue: '계좌 오류' }),
  ]);
  svc = install(pool);
  await svc.applyOverlayFanoutFix({});
  const w6 = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(w6.find(w => w.params[0] === 'a').params[2], '계좌 오류', '6a: 직원이 친 문구 그대로');
  assert.equal(w6.find(w => w.params[0] === 'b').params[2], '', '6b: 번진 줄에서는 사라진다');

  /* 7. 번지지 않은 표기(1줄)는 애초에 손대지 않는다 */
  pool = makePool([row({ rowId: 'a', rowIndex: 1, submitted: true })]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items.length, 0, '7a: 정상 표기는 대상이 아니다');

  /* 8. 8/11·8/12 가 섞여 있어도 각각 자기 값으로 처리된다 */
  pool = makePool([
    row({ editId: 'e1', rowId: 'a', rowIndex: 1, submitted: true, stamp: '8/11', paidValue: '' }),
    row({ editId: 'e1', rowId: 'b', rowIndex: 2, stamp: '8/11' }),
    row({ editId: 'e2', rowId: 'c', rowIndex: 3, submitted: true, stamp: '8/12', paidValue: '' }),
    row({ editId: 'e2', rowId: 'd', rowIndex: 4, stamp: '8/12' }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.summary.byStamp['8/11'].groups, 1, '8a: 날짜별로 센다');
  assert.equal(pv.summary.byStamp['8/12'].groups, 1);
  out = await svc.applyOverlayFanoutFix({});
  const w8 = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(w8.find(w => w.params[0] === 'a').params[2], '8/11');
  assert.equal(w8.find(w => w.params[0] === 'c').params[2], '8/12', '8b: 각 값이 자기 줄에 새겨진다');
  assert.equal(out.keptRows, 2); assert.equal(out.clearedRows, 2);

  /* 11. 보류건 판단 사다리 — 추천은 하되 자동 확정하지 않는다 */
  //  ① 입금 원장이 1줄에만
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, hasLedger: true, ledgerPaidAt: '2026-08-11T00:00:00Z' }),
    row({ rowId: 'b', rowIndex: 2 }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].hold, 'no_submitted_row', '11a: 자동 확정 규칙은 그대로(보류 유지)');
  assert.equal(pv.items[0].suggest.rowIndex, 1, '11b: 입금 원장 있는 줄을 추천');
  assert.equal(pv.items[0].suggest.basis, 'ledger');
  assert.equal(pool.writes.length, 0, '11c: 추천만으로는 아무것도 쓰지 않는다');

  //  ② 리뷰 캡처가 1줄에만
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1 }),
    row({ rowId: 'b', rowIndex: 2, hasReviewFile: true }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].suggest.basis, 'review_file', '11d: 캡처 원장으로 좁힌다');
  assert.equal(pv.items[0].suggest.rowIndex, 2);

  //  ③ 편집 시각 이전에 채워진 줄이 1개
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, firstSeenAt: '2026-08-05T00:00:00Z', createdAt: '2026-08-11T05:00:00Z' }),
    row({ rowId: 'b', rowIndex: 2, firstSeenAt: '2026-08-18T00:00:00Z', createdAt: '2026-08-11T05:00:00Z' }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].suggest.basis, 'filled_before_edit', '11e: 적은 시각 이전에 있던 줄');
  assert.equal(pv.items[0].suggest.rowIndex, 1);

  //  ④ 좁혀지지 않으면 추천하지 않는다(억지로 고르지 않는다)
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, hasLedger: true }),
    row({ rowId: 'b', rowIndex: 2, hasLedger: true }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].suggest, null, '11f: 근거가 2줄이면 추천 없음');

  //  ⑤ ★ 자동 확정 규칙은 사다리에 흔들리지 않는다 — 이미 확인한 미리보기가 배포로 달라지면 안 된다.
  //     (리뷰 제출된 줄은 1번인데 입금 원장은 2번에 있는 상황: keep 은 여전히 1번, 추천은 붙지 않는다)
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, submitted: true, paidValue: '' }),
    row({ rowId: 'b', rowIndex: 2, hasLedger: true, hasReviewFile: true }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].hold, null, '11g: 제출 1개면 자동 확정 그대로');
  assert.equal(pv.items[0].keepRow, 1, '11h: 사다리가 자동 확정을 덮지 않는다');
  assert.equal(pv.items[0].suggest, null, '11i: 자동 확정 건에는 추천을 붙이지 않는다(혼동 방지)');

  /* 12. 사람이 고른 줄로만 복원 — 서버가 그 그룹의 실제 줄인지 검증 */
  const holdRows = [
    row({ rowId: 'a', rowIndex: 1, paidValue: '' }),
    row({ rowId: 'b', rowIndex: 2 }),
  ];
  pool = makePool(holdRows); svc = install(pool);
  out = await svc.applyOverlayFanoutFix({ decisions: [{ editId: 'e1', rowId: 'a' }] });
  let cw2 = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(out.pickedByHuman, 1, '12a: 사람이 고른 건수를 보고한다');
  assert.equal(cw2[0].params[0], 'a', '12b: 고른 줄에 새긴다');
  assert.equal(cw2[0].params[2], '8/11');
  assert.equal(cw2[1].params[0], 'b', '12c: 나머지에서 지운다');
  assert.equal(cw2[1].params[2], '');

  //  그 그룹에 없는 줄을 보내면 무시(남의 줄에 쓰지 않는다)
  pool = makePool(holdRows); svc = install(pool);
  await assert.rejects(() => svc.applyOverlayFanoutFix({ decisions: [{ editId: 'e1', rowId: 'zzz' }] }),
    /복원할 대상이 없습니다/, '12d: 그룹 밖 rowId 는 무시하고 아무것도 하지 않는다');
  assert.equal(pool.writes.length, 0, '12e: 검증 실패 시 쓰기 0');

  //  시트 기반 보류는 사람이 골라도 열리지 않는다
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, sheetless: false, paidValue: '' }),
    row({ rowId: 'b', rowIndex: 2, sheetless: false }),
  ]);
  svc = install(pool);
  await assert.rejects(() => svc.applyOverlayFanoutFix({ decisions: [{ editId: 'e1', rowId: 'a' }] }),
    /복원할 대상이 없습니다/, '12f: 시트 기반은 선택으로도 우회 불가');

  /* 13. 보류건 은행 이체결과 대조 — 읽기 전용, PII 최소화, 실패는 사실대로 */
  pool = makePool(
    [row({ rowId: 'a', rowIndex: 60 }), row({ rowId: 'b', rowIndex: 178 })],
    { items: [{ sheetId: 's', tabName: 'T', rowIndex: 60, reviewerName: '박', accountHolder: '박',
                amount: 9900, status: 'paid', paidAt: '2026-08-11T02:00:00Z', failReason: null,
                bankAccount: '110425327484', batchSeq: 3, bank: 'kbank' }],
      uploads: [{ batchSeq: 3, bank: 'kbank', summary: { preview: { unmatchedResults: [
        { seq: 8, holder: '박', amount: 9900, accountTail: '7484', transferredAt: '2026.08.11 10:00', success: true, memo: 'X' },
        { seq: 9, holder: '다른사람', amount: 1000, accountTail: '1111', transferredAt: '', success: true, memo: 'Y' },
      ] } } }] });
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  const bk = pv.items[0].bank;
  assert.ok(bk, '13a: 보류건에 은행 이체결과를 붙인다');
  assert.equal(bk.matched.length, 1, '13b: 그 이름으로 나간 회차 항목');
  assert.equal(bk.matched[0].rowIndex, 60, '13c: 어느 줄에 기록됐는지가 핵심 정보다');
  assert.equal(bk.matched[0].accountTail, '7484', '13d: 계좌는 뒤 4자리만');
  assert.ok(!('bankAccount' in bk.matched[0]), '13e: 전체 계좌번호를 내보내지 않는다');
  assert.equal(bk.unmatched.length, 1, '13f: 다른 사람 이체는 섞이지 않는다');
  assert.equal(bk.unmatched[0].accountTail, '7484');
  assert.equal(pool.writes.length, 0, '13g: 미리보기는 여전히 쓰기 0');

  //  자동 확정 건에는 붙이지 않는다(보류건 판단용이다)
  pool = makePool([row({ rowId: 'a', rowIndex: 1, submitted: true, paidValue: '' }), row({ rowId: 'b', rowIndex: 2 })],
    { items: [{ sheetId: 's', tabName: 'T', rowIndex: 1, reviewerName: '박', accountHolder: '박',
                amount: 1, status: 'paid', paidAt: null, bankAccount: '1', batchSeq: 1, bank: 'kbank' }] });
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].bank, null, '13h: 자동 확정 건에는 은행 표를 붙이지 않는다');

  //  조회 실패는 사실대로(0건으로 꾸미지 않는다)
  pool = makePool([row({ rowId: 'a', rowIndex: 1 }), row({ rowId: 'b', rowIndex: 2 })], { itemsThrow: true });
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.ok(pv.items[0].bankUnavailable, '13i: 조회 실패를 드러낸다');
  assert.equal(pv.items[0].bank, null, '13j: 실패했는데 빈 표를 주지 않는다');

  //  ★ 그룹별 스코프 — 다른 참여자의 이체가 남의 보류건에 뜨면 안 된다
  pool = makePool(
    [row({ editId: 'e1', rowId: 'a', rowIndex: 60, name: '박' }), row({ editId: 'e1', rowId: 'b', rowIndex: 178, name: '박' }),
     row({ editId: 'e2', rowId: 'c', rowIndex: 70, name: '최' }), row({ editId: 'e2', rowId: 'd', rowIndex: 188, name: '최' })],
    { items: [
        { sheetId: 's', tabName: 'T', rowIndex: 60, reviewerName: '박', accountHolder: '박', amount: 1, status: 'paid', paidAt: null, bankAccount: '1111', batchSeq: 1, bank: 'kbank' },
        { sheetId: 's', tabName: 'T', rowIndex: 70, reviewerName: '최', accountHolder: '최', amount: 2, status: 'paid', paidAt: null, bankAccount: '2222', batchSeq: 1, bank: 'kbank' },
      ],
      uploads: [{ batchSeq: 1, bank: 'kbank', summary: { preview: { unmatchedResults: [
        { seq: 1, holder: '박', amount: 1, accountTail: '1111', transferredAt: '', success: true, memo: '' },
        { seq: 2, holder: '최', amount: 2, accountTail: '2222', transferredAt: '', success: true, memo: '' },
      ] } } }] });
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  const g박 = pv.items.find(x => x.reviewerName === '박');
  const g최 = pv.items.find(x => x.reviewerName === '최');
  assert.equal(g박.bank.matched.length, 1, '13k: 그 참여자 이체만');
  assert.equal(g박.bank.matched[0].rowIndex, 60);
  assert.equal(g박.bank.unmatched.length, 1);
  assert.equal(g박.bank.unmatched[0].name, '박', '13l: 남의 미확인 이체가 섞이면 안 된다');
  assert.equal(g최.bank.matched[0].rowIndex, 70, '13m: 각 그룹은 자기 참여자 것만 본다');
  assert.equal(g최.bank.unmatched[0].name, '최');

  console.log('deposit overlay bank evidence passed');
  console.log('deposit overlay hold-decision rules passed');
  console.log('deposit overlay restore rules passed');
})().catch(e => { console.error(e); process.exit(1); });

/* ── 9. 라우트·화면 배선 ────────────────────────────────────────────────── */
const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
assert.match(routes, /router\.get\('\/payment\/repair\/deposit-overlay-fix', authMiddleware, adminOrMasterMiddleware/);
assert.match(routes, /router\.post\('\/payment\/repair\/deposit-overlay-fix', authMiddleware, adminOrMasterMiddleware/);
const ps = routes.indexOf("router.post('/payment/repair/deposit-overlay-fix'");
assert.match(routes.slice(ps, routes.indexOf('\nrouter.', ps + 10)), /confirm !== true/, '실행은 confirm 필수');

const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');
assert.match(workdesk, /onclick="_pmOpenOverlayFix\(\)"/, '점검 화면 ④ 아래에 복원 진입점');
const as = workdesk.indexOf('async function _pmApplyOverlayFix');
const asrc = workdesk.slice(as, as + 1500);
assert.match(asrc, /confirm\(/, '실행 전 확인창');
assert.match(asrc, /되돌릴 수 없습니다/);
assert.doesNotMatch(asrc, /submitted|keepRow\s*=/, '화면에서 원래 줄을 다시 정하면 안 된다');

/* ── 10. 복원 모달을 가짜 DOM 위에서 실제 실행 ────────────────────────── */
{
  const vm = require('vm');
  const st = workdesk.indexOf('async function _pmOpenOverlayFix');
  const en = workdesk.indexOf('/* 번진 입금일 정리 — 미리보기');
  assert.ok(st > 0 && en > st, '복원 모달 블록을 찾아야 한다');
  const mk = () => ({ id: '', className: '', innerHTML: '', value: '', addEventListener() {}, appendChild() {}, remove() {} });
  const ov = mk(); const bd = mk();
  let posted = null; let confirmed = true; const toasts = [];
  let picks = [];
  const sandbox = {
    STATE: { cur: { sheetId: 'sh', tabName: 'T' } },
    esc: v => String(v == null ? '' : v),
    document: { createElement: () => ov, body: { appendChild() {} },
      getElementById: id => (id === 'pmovfixbd' ? bd : (id === 'pmovfixov' ? ov : null)),
      // 보류건 라디오 — 사람이 고른 값을 읽는 경로
      querySelectorAll: () => picks },
    api: null, toast: m => toasts.push(m), confirm: () => confirmed,
    _pmNum: n => String(n), _pmLoad: async () => {}, _pmOpenDepositAnomalies: async () => {}, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(workdesk.slice(st, en), sandbox);

  (async () => {
    sandbox.api = async (u, opt) => {
      if (opt && opt.method === 'POST') { posted = JSON.parse(opt.body); return { ok: true, keptRows: 2, clearedRows: 2, revertedEdits: 4 }; }
      return { ok: true, dryRun: true,
        summary: { groups: 3, actionableGroups: 2, keepRows: 2, clearRows: 2, ledgerBlockedRows: 1, holdGroups: 1,
          byStamp: { '8/11': { groups: 2, hold: 1 }, '8/12': { groups: 1, hold: 0 } } },
        items: [
          { tabName: 'T', reviewerName: 'A', stamp: '8/11', rows: [38, 96], keepRow: 38, clearRows: [96], ledgerBlockedRows: [], submittedCount: 1, hold: null },
          { tabName: 'T', reviewerName: 'B', stamp: '8/11', rows: [118, 119], keepRow: 118, clearRows: [], ledgerBlockedRows: [119], submittedCount: 1, hold: null },
          { tabName: 'T', reviewerName: 'C', stamp: '8/12', rows: [295, 296], keepRow: null, clearRows: [], submittedCount: 0,
            hold: 'no_submitted_row', holdReason: '리뷰 제출된 줄이 없습니다',
            candidates: [{ rowId: 'r1', rowIndex: 295 }, { rowId: 'r2', rowIndex: 296 }],
            bank: { matched: [{ batchSeq: 3, name: 'C', amount: 9900, accountTail: '7484',
                                paidAt: '2026-08-11T02:00:00Z', status: 'paid', rowIndex: 295 }],
                    unmatched: [{ batchSeq: 3, name: 'C', amount: 9900, accountTail: '7484',
                                  transferredAt: '2026.08.11 10:00', success: true }] } },
        ] };
    };
    await sandbox._pmOpenOverlayFix();
    assert.ok(bd.innerHTML.includes('8/11') && bd.innerHTML.includes('8/12'), '10a: 날짜별로 규모를 보여준다');
    assert.ok(bd.innerHTML.includes('<td>38</td>') && bd.innerHTML.includes('<td>96</td>'), '10b: 남길 줄·지울 줄');
    assert.ok(bd.innerHTML.includes('<td>119</td>'), '10c: 원장 있어 보존하는 줄을 드러낸다');
    assert.ok(bd.innerHTML.includes('리뷰 제출된 줄이 없습니다'), '10d: 보류 사유');
    assert.ok(bd.innerHTML.includes('이대로 복원 (2건)'), '10e: 실행 건수를 버튼에 적는다');
    assert.ok(bd.innerHTML.includes('type="radio"'), '10e2: 보류건은 줄을 고를 수 있게 그린다');
    assert.ok(bd.innerHTML.includes('그대로 보류'), '10e3: 고르지 않는 선택지도 준다');
    assert.ok(bd.innerHTML.includes('은행 이체결과'), '10e5: 보류건에 은행 이체결과 표를 그린다');
    assert.ok(bd.innerHTML.includes('295번</b>에 기록'), '10e6: 그 이체가 어느 줄에 붙었는지 말한다');
    assert.ok(bd.innerHTML.includes('어느 줄에도 안 붙음'), '10e7: 미확인 이체를 구분해 보여준다');
    assert.ok(bd.innerHTML.includes('…7484'), '10e8: 계좌는 뒤 4자리만');

    // 사람이 고른 값이 그대로 서버로 간다
    picks = [{ dataset: { edit: 'e9', row: 'r9' } }, { dataset: { edit: 'e8', row: '' } }];
    await sandbox._pmApplyOverlayFix();
    assert.deepEqual(posted.decisions, [{ editId: 'e9', rowId: 'r9' }],
      '10e4: 고른 것만 보내고, 고르지 않은 건은 보내지 않는다');
    picks = [];

    await sandbox._pmApplyOverlayFix();
    assert.equal(posted && posted.confirm, true, '10f: confirm 을 보낸다');
    assert.ok(toasts.some(t => /복원 완료/.test(t)), '10g: 결과를 사실대로 말한다');

    posted = null; confirmed = false;
    await sandbox._pmApplyOverlayFix();
    assert.equal(posted, null, '10h: 확인창 취소 시 아무것도 보내지 않는다');

    confirmed = true;
    sandbox.api = async () => ({ ok: true, summary: { actionableGroups: 0, keepRows: 0, clearRows: 0, holdGroups: 3, byStamp: {} }, items: [] });
    await sandbox._pmOpenOverlayFix();
    assert.ok(/disabled/.test(bd.innerHTML), '10i: 복원할 것이 없으면 버튼을 잠근다');
    console.log('deposit overlay restore modal runtime guard passed');
  })().catch(e => { console.error(e); process.exit(1); });
}

console.log('deposit overlay restore wiring passed');
