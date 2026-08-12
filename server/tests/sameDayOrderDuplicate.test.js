const assert = require('assert');
const fs = require('fs');
const path = require('path');

// RED: 구매양식의 "같은 날 · 같은 캠페인 · 같은 정보" 판정을 서버의 순수 규칙으로 고정한다.
const {
  normalizeSameDayOrder,
  isSameDayOrderDuplicate,
} = require('../src/services/orderDuplicate.service');

const base = {
  orderer: '임 혜 연', recipient: '임혜연', userId: 'lovelevel',
  phone: '010-3220-5501', address: '경기도 의왕시 안양판교로 100 101-1301',
  bank: '국민', account: '059401040967', depositor: '임혜연',
  price: '12,000원', dateStr: '2026-08-12', orderNum: '20260812-01',
  memo: '문 앞', selectedOptKey: '화이트/260', blogUrl: 'https://blog.naver.com/lovelevel',
};

assert.deepStrictEqual(normalizeSameDayOrder(base), {
  orderer: '임혜연', recipient: '임혜연', userId: 'lovelevel',
  phone: '01032205501', address: '경기도의왕시안양판교로100101-1301',
  bank: '국민', account: '059401040967', depositor: '임혜연',
  price: '12000', dateStr: '2026-08-12', orderNum: '2026081201',
  memo: '문앞', selectedOptKey: '화이트/260', blogUrl: 'https://blog.naver.com/lovelevel',
});

assert.strictEqual(isSameDayOrderDuplicate(base, {
  ...base,
  orderer: '임혜연', phone: '010 3220 5501', price: '12000', memo: '문   앞',
}), true, '표기만 다른 동일 구매양식은 중복이다');

assert.strictEqual(isSameDayOrderDuplicate(base, { ...base, orderNum: '20260812-02' }), false,
  '주문번호가 다르면 같은 행으로 오인하지 않는다');

const ledger = fs.readFileSync(path.join(__dirname, '..', 'src/services/orderLedger.service.js'), 'utf8');
const submit = fs.readFileSync(path.join(__dirname, '..', 'src/routes/submit.routes.js'), 'utf8');
assert.match(ledger, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/, '동시 제출은 트랜잭션 잠금으로 직렬화한다');
assert.match(ledger, /findSameDayDuplicateInTx/, '원장 INSERT 전에 당일 동일 제출을 확인한다');
assert.match(submit, /DUPLICATE_SAME_DAY/, '구매양식 제출 경로가 중복을 명시적으로 응답한다');

console.log('✓ same-day duplicate normalization');
