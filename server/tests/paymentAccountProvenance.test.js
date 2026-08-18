'use strict';
const assert = require('assert');
const fs = require('fs');
const payment = require('../src/services/payment.service');

assert.equal(typeof payment.accountFingerprint, 'function',
  '계좌 감사용 지문 함수가 제공되어야 한다');
assert.equal(typeof payment.compareAccountSnapshot, 'function',
  '다운로드 전 계좌 스냅샷 비교 함수가 제공되어야 한다');

const snapshot = {
  id: 'item-1', reviewerName: '원지웅', bankAccount: '100-240-066895',
  accountReviewerId: '11111111-1111-1111-1111-111111111111', accountSource: 'self', accountSubPhone8: '',
};
assert.equal(payment.accountFingerprint('100-240-066895'), payment.accountFingerprint('100240066895'),
  '서식 차이는 같은 계좌로 본다');
assert.notEqual(payment.accountFingerprint('1002400066895'), payment.accountFingerprint('100240066895'),
  '다른 계좌는 다른 감사 지문이어야 한다');
assert.deepEqual(payment.compareAccountSnapshot(snapshot, {
  reviewerId: snapshot.accountReviewerId, isSub: false, bankAccount: '100240066895',
}), { state: 'match', itemId: 'item-1' }, '같은 식별자·같은 계좌는 다운로드를 허용한다');
assert.deepEqual(payment.compareAccountSnapshot(snapshot, {
  reviewerId: snapshot.accountReviewerId, isSub: false, bankAccount: '100190950172',
}), { state: 'mismatch', itemId: 'item-1' }, '같은 리뷰어라도 계좌가 바뀌면 첫 다운로드를 막는다');
assert.deepEqual(payment.compareAccountSnapshot({ ...snapshot, bankName: '토스뱅크', accountHolder: '원지웅' }, {
  reviewerId: snapshot.accountReviewerId, isSub: false, bankName: '다른은행', bankAccount: '100240066895', accountHolder: '원지웅',
}), { state: 'mismatch', itemId: 'item-1' }, '계좌번호가 같아도 은행 또는 예금주가 바뀌면 첫 다운로드를 막는다');
assert.deepEqual(payment.compareAccountSnapshot({ ...snapshot, accountReviewerId: '', accountSource: '' }, null),
  { state: 'unverifiable', itemId: 'item-1' }, '기존 회차처럼 출처가 없으면 자동 변경·차단하지 않는다');

const batch8Items = [{
  id: 'batch-8-item', reviewer_name: '원지웅', bank_account: '100240066895',
  account_reviewer_id: snapshot.accountReviewerId, account_source: 'self', account_sub_phone8: '',
  account_fingerprint: payment.accountFingerprint('100240066895'),
}];
const batch8Owners = new Map([[snapshot.accountReviewerId, {
  reviewerId: snapshot.accountReviewerId, bankAccount: '100190950172', subAccounts: [],
}]]);
assert.deepEqual(payment.reconcileAccountSnapshots(batch8Items, batch8Owners), {
  ok: false,
  mismatches: [{ itemId: 'batch-8-item', reviewerName: '원지웅', accountTail: '6895' }],
  unverifiable: 0,
}, '#8 사고처럼 현재 등록계좌가 다르면 첫 다운로드를 차단할 대상이 정확히 식별되어야 한다');

batch8Owners.set(snapshot.accountReviewerId, {
  reviewerId: snapshot.accountReviewerId, bankAccount: '100240066895', subAccounts: [],
});
assert.deepEqual(payment.reconcileAccountSnapshots(batch8Items, batch8Owners), {
  ok: true, mismatches: [], unverifiable: 0,
}, '스냅샷과 현재 등록계좌가 같으면 회차 다운로드를 허용해야 한다');
assert.deepEqual(payment.reconcileAccountSnapshots(batch8Items, new Map()), {
  ok: false,
  mismatches: [{ itemId: 'batch-8-item', reviewerName: '원지웅', accountTail: '6895' }],
  unverifiable: 1,
}, '계좌 출처를 검증할 수 없는 회차도 다운로드를 차단해야 한다');

const subItem = [{
  id: 'sub-item', reviewer_name: '타계정', bank_account: '33334444',
  account_reviewer_id: snapshot.accountReviewerId, account_source: 'sub', account_sub_phone8: '12345678',
  account_fingerprint: payment.accountFingerprint('33334444'),
}];
const subOwners = new Map([[snapshot.accountReviewerId, {
  reviewerId: snapshot.accountReviewerId, bankAccount: '100240066895',
  subAccounts: [{ phone: '010-1234-5678', bankAccount: '33334444' }],
}]]);
assert.deepEqual(payment.reconcileAccountSnapshots(subItem, subOwners), {
  ok: true, mismatches: [], unverifiable: 0,
}, '타계정은 소유자 본계좌가 아니라 동일 전화번호의 타계정만 비교해야 한다');

const migration = fs.readFileSync(require.resolve('../migrations/120_payment_account_provenance.sql'), 'utf8');
assert.match(migration, /account_reviewer_id UUID/);
assert.match(migration, /account_source TEXT/);
assert.match(migration, /reviewer_account_change_audit/);
assert.match(migration, /changed_by TEXT/);
assert.match(migration, /trg_reviewer_account_change_audit/);

console.log('payment account provenance tests passed');
