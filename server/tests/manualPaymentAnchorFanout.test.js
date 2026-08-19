'use strict';
/*
 * 2026-08-19 조사 — 수동 입금 마커(8/11)가 **여러 줄에 번지던** 경로를 고정한다.
 *
 * 사고: `campaign_participants.order_submission_id` 는 유니크가 아니고 `identity_key` 는
 *   `num:<주문번호>` 라, 무시트 중복 줄 사고가 난 탭에서 마커 1건이 여러 줄을 가리켰다.
 *   `rehydrateManualPaymentMarks` 는 **장부 재생성마다** 돌면서 그 모든 줄에 입금일을 다시 찍었고
 *   (→ 리뷰 미작성 줄에 입금일), `_manual811Candidates` 는 그 줄마다 입금 원장을 만들었다
 *   (→ 실제 이체 1건인데 입금완료 N건).
 *
 * ★ 이 가드는 문자열 존재가 아니라 **스텁 DB 로 실제 실행**해 "2줄 이상이면 한 줄도 안 쓴다"를 본다
 *   (조건을 지워도 문자열은 남기 때문).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

/* ── 1. rehydrate: 앵커가 2줄을 가리키면 UPDATE 0회 ───────────────────────── */
const { rehydrateManualPaymentMarks } = require(path.join(root, 'src/services/manualPaymentLedger.service.js'));

function stubClient(targetRows) {
  const writes = [];
  return {
    writes,
    async query(sql, params) {
      if (/FROM manual_payment_marks/.test(sql)) {
        return { rows: [{ anchor_type: 'order', anchor_value: 'os-1', deposit_col_key: '입금', stamp: '8/11', paid_at: null }] };
      }
      if (/FROM campaign_participants/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: targetRows };
      if (/UPDATE campaign_participants/.test(sql)) { writes.push(params); return { rowCount: 1, rows: [] }; }
      throw new Error('unexpected query: ' + String(sql).slice(0, 60));
    },
  };
}

(async () => {
  // 두 줄을 가리키는 마커 → 한 줄도 쓰지 않는다
  const dup = stubClient([
    { id: 'a', seq: 179, current_value: '' },
    { id: 'b', seq: 189, current_value: '' },
  ]);
  const r1 = await rehydrateManualPaymentMarks(dup, { sheetId: 's', tabName: 't' });
  assert.equal(dup.writes.length, 0, '앵커가 여러 줄을 가리키면 입금일을 한 줄도 쓰면 안 된다');
  assert.equal(r1.restored, 0);
  assert.equal(r1.ambiguous, 1, '건너뛴 사실을 숫자로 알려야 한다');
  assert.deepEqual(r1.ambiguousMarks[0].rows, [179, 189], '어느 줄이 걸렸는지 말해야 한다');

  // 한 줄만 가리키는 정상 마커 → 종전대로 기록(무회귀)
  const one = stubClient([{ id: 'a', seq: 179, current_value: '' }]);
  const r2 = await rehydrateManualPaymentMarks(one, { sheetId: 's', tabName: 't' });
  assert.equal(one.writes.length, 1, '정상(유일) 마커는 종전대로 기록해야 한다');
  assert.equal(r2.restored, 1);
  assert.equal(r2.ambiguous, 0);

  console.log('manual payment anchor fan-out guard passed');
})().catch(e => { console.error(e); process.exit(1); });

/* ── 2. 복구 도구: 같은 앵커가 여러 행이면 그 앵커 전체를 후보에서 제외 ────── */
const repair = fs.readFileSync(path.join(root, 'src/services/manualDepositRepair.service.js'), 'utf8');
assert.match(repair, /perAnchor/, '복구 후보 산출에 앵커별 집계가 있어야 한다');
assert.match(repair, /=== 1\)/, '유일한 앵커만 후보로 남겨야 한다');
assert.match(repair, /_lastAmbiguous/, '제외한 행을 화면이 말할 수 있어야 한다');
assert.match(repair, /ambiguousRows/, '미리보기 응답이 제외 사유를 실어야 한다');

/* ── 3. 진단은 읽기 전용 ─────────────────────────────────────────────────── */
const anomalyStart = repair.indexOf('async function depositAnomalyReport');
assert.ok(anomalyStart > 0, '진단 함수가 있어야 한다');
const anomalyEnd = repair.indexOf('\nasync function ', anomalyStart + 10);
const anomalySrc = repair.slice(anomalyStart, anomalyEnd > 0 ? anomalyEnd : undefined);
assert.doesNotMatch(anomalySrc, /\b(INSERT|UPDATE|DELETE)\b/i, '진단은 쓰기 쿼리를 하면 안 된다');
assert.match(anomalySrc, /ambiguousUnavailable/, '조회 실패를 0 으로 꾸미지 않아야 한다');
assert.match(anomalySrc, /paidWithoutSubmitUnavailable/);
assert.match(anomalySrc, /duplicateLedgerUnavailable/);

/* ── 4. 라우트: 관리자 전용 GET, 라우터 스택 실검사 ─────────────────────── */
const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
assert.match(routes,
  /router\.get\('\/payment\/repair\/deposit-anomalies', authMiddleware, adminOrMasterMiddleware/,
  '진단 조회는 authMiddleware + adminOrMaster 여야 한다');

/* ── 5. 화면 배선 ───────────────────────────────────────────────────────── */
const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');
assert.match(workdesk, /onclick="_pmOpenDepositAnomalies\(\)"/, '입금관리에 점검 버튼이 있어야 한다');
assert.match(workdesk, /payment\/repair\/deposit-anomalies/, '화면이 진단 경로를 호출해야 한다');
assert.match(workdesk, /조회 실패/, '항목별 조회 실패를 사실대로 표기해야 한다');

/* ── 6. 점검 모달을 가짜 DOM 위에서 실제 실행 ──────────────────────────────
   ★ 문자열 검사로는 못 잡는 것: 프리변수(다른 함수 스코프의 const 참조)·템플릿 오류·
     "조회 실패를 0 으로 꾸미기". sandbox 에 전역을 일부러 최소로만 둔다. */
const vm = require('vm');
{
  const start = workdesk.indexOf('async function _pmOpenDepositAnomalies');
  const end = workdesk.indexOf('\nfunction _pmOpenDepositDateCorrection');
  assert.ok(start > 0 && end > start, '점검 모달 블록을 찾아야 한다');
  const src = workdesk.slice(start, end);
  const mk = () => ({ id: '', className: '', innerHTML: '', addEventListener() {}, appendChild() {} });
  const ov = mk(); const bd = mk();
  const sandbox = {
    STATE: { cur: { sheetId: 'sh', tabName: '\ud0ed' } },
    esc: v => String(v == null ? '' : v),
    document: { createElement: () => ov, body: { appendChild() {} },
      getElementById: id => (id === 'pmanomalybd' ? bd : null) },
    api: null, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  (async () => {
    let url = '';
    sandbox.api = async u => { url = u; return { ok: true,
      ambiguousMarkCount: 3, ambiguousRowCount: 5,
      ambiguousMarks: [{ tabName: 'T', anchorType: 'order', stamp: '8/11', rowCount: 3, rows: [179, 189, 199] }],
      paidWithoutSubmitCount: 24, paidWithoutSubmit: [{ tabName: 'T', rowIndex: 189, reviewerName: 'A' }],
      duplicateLedgerCount: 2, duplicateLedger: [{ tabName: 'T', reviewerName: 'A', paidDate: '2026-08-11', records: 3, rows: [179, 189, 199] }] }; };
    await sandbox._pmOpenDepositAnomalies();
    assert.ok(url.startsWith('/api/trackb/payment/repair/deposit-anomalies?'), '열려 있는 작업으로 스코프해야 한다');
    assert.ok(/<b>3<\/b>\uac74/.test(bd.innerHTML) && /<b>24<\/b>\uac74/.test(bd.innerHTML), '건수를 그려야 한다');
    assert.ok(bd.innerHTML.includes('179, 189, 199'), '어느 줄이 번졌는지 보여야 한다');

    sandbox.api = async () => ({ ok: true, ambiguousUnavailable: 'boom',
      paidWithoutSubmitCount: 0, paidWithoutSubmit: [], duplicateLedgerCount: 0, duplicateLedger: [] });
    await sandbox._pmOpenDepositAnomalies();
    assert.ok(bd.innerHTML.includes('\uc870\ud68c \uc2e4\ud328'), '조회 실패를 0 건으로 꾸미면 안 된다');

    sandbox.api = async () => { throw new Error('net'); };
    await sandbox._pmOpenDepositAnomalies();
    assert.ok(bd.innerHTML.includes('\ub2e4\uc2dc \uc2dc\ub3c4'), '실패해도 화면을 종결해야 한다(무한 로딩 금지)');
    console.log('deposit anomaly modal runtime guard passed');
  })().catch(e => { console.error(e); process.exit(1); });
}

console.log('deposit anomaly diagnostic contract passed');
