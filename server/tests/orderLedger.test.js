const assert = require('assert');
const { detectSheetHeader } = require('../src/utils/sheetHeader');
const {
  computeDedupKey,
  buildCandidateRows,
  mapOrderToSheetRow,
} = require('../src/services/orderLedger.service');

function run() {
  const rawRows = [
    ['캠페인명', '0612)네이버_멀티비타민_50건'],
    ['생성자(PM)', '이만수'],
    ['채널명', '네이버'],
    ['자동 - 입금수', '0'],
    ['번호', '담당자', '구매일자', '인애드명단', '주문자제출', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰제출', '입금', '주문번호', '비고(닉네임)'],
    ['1', '', '6 / 12 (금)', '김준석', '김준석', '김준석', 'izunia', '010-6342-4060', '서울 성동구', '국민', '123', '김준석', '26900'],
    ['2', '', '6 / 12 (금)', '신연호', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['3', '', '6 / 12 (금)', '다른사람', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];

  const detected = detectSheetHeader(rawRows);
  assert.equal(detected.headerRowIndex, 5);
  assert.equal(detected.dataStartRow, 6);
  assert.deepEqual(detected.headers.slice(0, 4), ['번호', '담당자', '구매일자', '인애드명단']);

  assert.equal(
    computeDedupKey({ orderNum: '2026061273521531', recipient: '신연호', phone: '010-2542-5118', dateStr: '6 / 24 (수)' }),
    'num:2026061273521531'
  );
  assert.equal(
    computeDedupKey({ orderNum: '', recipient: '신 연호', phone: '010-2542-5118', dateStr: '6 / 24 (수)', selectedOptKey: '블랙|L' }),
    'rcp:신연호|25425118|6/24(수)|블랙|L'
  );

  const candidates = buildCandidateRows({
    headers: detected.headers,
    dataRows: rawRows.slice(detected.dataStartRow - 1).map((cells, idx) => ({ rowIndex: detected.dataStartRow + idx, cells })),
    headerRowIndex: detected.headerRowIndex,
    orderData: { orderer: '신연호', selectedOptKey: '' },
  });
  assert.equal(candidates[0], 7);
  assert(candidates.includes(8));
  assert(candidates.includes(9));

  const mapped = mapOrderToSheetRow(detected.headers, {
    orderer: '신연호',
    recipient: '신연호',
    userId: 'dusgh5118',
    phone: '010-2542-5118',
    address: '서울 성북구',
    bank: '카카오뱅크',
    account: '3333',
    depositor: '차하민',
    price: '39000',
    dateStr: '6 / 24 (수)',
    orderNum: '26100199557831',
    memo: '메모',
  });
  assert.equal(mapped[0], null);
  assert.equal(mapped[3], null);
  assert.equal(mapped[4], '신연호');
  assert.equal(mapped[7], '010-2542-5118');
  assert.equal(mapped[15], '26100199557831');
}

run();
console.log('orderLedger tests passed');
