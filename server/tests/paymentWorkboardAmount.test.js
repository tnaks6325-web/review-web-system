'use strict';
const assert = require('assert');
const fs = require('fs');
const svc = require('../src/services/paymentWorkboardAmount.service');

const direct = svc.resolveDisplayedAmount({
  fallbackRowJson: { 결제금액: '18,950' },
  participantRowJson: { 결제금액: '18,950' },
  manualEdits: { 'col:결제금액': '10,000' },
  anchorEdits: { 'col:결제금액': '7,650' },
});
assert.equal(direct.amount, 7650, '현재 앵커 편집이 물리행 편집과 원본값보다 우선해야 한다');
assert.equal(direct.source, 'workboard_edit');

const physical = svc.resolveDisplayedAmount({ participantRowJson: { 결제금액: '7,650원' } });
assert.equal(physical.amount, 7650);
assert.equal(physical.source, 'workboard');

(async () => {
  let sql = '';
  const db = { query: async text => {
    sql = String(text);
    return { rows: [{
      sheetId: 'S1', tabName: 'T1', rowIndex: 11,
      participantRowJson: { 결제금액: '18,950' },
      manualEdits: {}, anchorEdits: { 'col:결제금액': '7,650' },
    }] };
  } };
  const result = await svc.loadWorkboardAmounts(db, [{
    sheetId: 'S1', tabName: 'T1', rowIndex: 11, rowJson: { 결제금액: '18,950' },
  }]);
  assert.equal(result.get('S1\tT1\t11').amount, 7650,
    '입금관리 공용 로더가 관리자 셀 편집 7,650원을 반환해야 한다');
  assert.match(sql, /participant_edits/);
  assert.match(sql, /COUNT\(\*\).*campaign_participants/s,
    '중복 order/identity 앵커에는 편집을 번지게 하지 않는 유일성 게이트가 필요하다');

  const source = fs.readFileSync(require.resolve('../src/services/payment.service'), 'utf8');
  assert.match(source, /const productPrice = workboardPrice \|\| orderPrice/,
    '작업보드 표시값이 주문 원장보다 우선이어야 한다');
  console.log('payment workboard amount tests passed');
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
