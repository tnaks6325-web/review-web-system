const assert = require('assert');
const { detectSheetHeader } = require('../src/utils/sheetHeader');
const {
  computeDedupKey,
  buildCandidateRows,
  mapOrderToSheetRow,
  buildMirrorGuardRange,
  createOrderLedgerEntry,
  __setPoolForTest,
} = require('../src/services/orderLedger.service');

const K = {
  no: '\uBC88\uD638',
  manager: '\uB2F4\uB2F9\uC790',
  purchaseDate: '\uAD6C\uB9E4\uC77C\uC790',
  inad: '\uC778\uC560\uB4DC\uBA85\uB2E8',
  ordererSubmit: '\uC8FC\uBB38\uC790\uC81C\uCD9C',
  recipient: '\uC218\uCDE8\uC778',
  phone: '\uC5F0\uB77D\uCC98',
  address: '\uC8FC\uC18C',
  bank: '\uC740\uD589',
  account: '\uACC4\uC88C\uBC88\uD638',
  depositor: '\uC608\uAE08\uC8FC',
  price: '\uACB0\uC81C\uAE08\uC561',
  reviewSubmit: '\uB9AC\uBDF0\uC81C\uCD9C',
  deposit: '\uC785\uAE08',
  orderNum: '\uC8FC\uBB38\uBC88\uD638',
  memo: '\uBE44\uACE0',
};

async function run() {
  const headers = [
    K.no, K.manager, K.purchaseDate, K.inad, K.ordererSubmit, K.recipient,
    'id', K.phone, K.address, K.bank, K.account, K.depositor, K.price,
    K.reviewSubmit, K.deposit, K.orderNum, K.memo,
  ];
  const rawRows = [
    ['campaign', 'meta'],
    ['createdBy', 'pm'],
    ['channel', 'naver'],
    ['autoDeposit', '0'],
    headers,
    ['1', '', '6 / 12', 'Kim', 'Kim', 'Kim', 'kim1', '010-1111-2222', 'Seoul', 'KB', '123', 'Kim', '26900'],
    ['2', '', '6 / 12', 'Yeon', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['3', '', '6 / 12', 'Other', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];

  const detected = detectSheetHeader(rawRows);
  assert.equal(detected.headerRowIndex, 5);
  assert.equal(detected.dataStartRow, 6);
  assert.deepEqual(detected.headers.slice(0, 4), [K.no, K.manager, K.purchaseDate, K.inad]);

  assert.equal(
    computeDedupKey({ orderNum: '2026061273521531', recipient: 'Yeon', phone: '010-2542-5118', dateStr: '6 / 24' }),
    'num:2026061273521531'
  );
  assert.equal(
    computeDedupKey({ orderNum: '', recipient: 'Yeon', phone: '010-2542-5118', dateStr: '6 / 24', selectedOptKey: 'Black|L' }),
    'rcp:Yeon|25425118|6/24|Black|L'
  );

  const candidates = buildCandidateRows({
    headers: detected.headers,
    dataRows: rawRows.slice(detected.dataStartRow - 1).map((cells, idx) => ({ rowIndex: detected.dataStartRow + idx, cells })),
    headerRowIndex: detected.headerRowIndex,
    orderData: { orderer: 'Yeon', selectedOptKey: '' },
  });
  assert.equal(candidates[0], 7);
  assert(candidates.includes(8));
  assert(candidates.includes(9));

  const mapped = mapOrderToSheetRow(detected.headers, {
    orderer: 'Yeon',
    recipient: 'Yeon',
    userId: 'dusgh5118',
    phone: '010-2542-5118',
    address: 'Seoul',
    bank: 'KakaoBank',
    account: '3333',
    depositor: 'Cha',
    price: '39000',
    dateStr: '6 / 24',
    orderNum: '26100199557831',
    memo: 'memo',
  });
  assert.equal(mapped[0], null);
  assert.equal(mapped[3], null);
  assert.equal(mapped[4], 'Yeon');
  assert.equal(mapped[7], '010-2542-5118');
  assert.equal(mapped[15], '26100199557831');

  const guard = buildMirrorGuardRange({
    tabName: 'Orders',
    headers: ['no', 'orderer', 'phone', 'address'],
    targetRow: 12,
    orderData: { orderer: 'Kim', phone: '01012345678', address: 'Seoul' },
  });
  assert.deepEqual(guard, { range: "'Orders'!C12", col: 2, header: 'phone' });

  const calls = [];
  const fakeClient = {
    query: async (sql) => {
      calls.push({ scope: 'client', sql });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM sheet_row_claims')) throw new Error('deadlock while claiming row');
      throw new Error(`unexpected client query: ${sql}`);
    },
    release: () => calls.push({ scope: 'client', sql: 'release' }),
  };
  const fakePool = {
    query: async (sql) => {
      calls.push({ scope: 'pool', sql });
      if (sql.includes('INSERT INTO order_submissions')) return { rows: [{ id: 'order-1' }] };
      if (sql.includes('FROM raw_sheet_tabs')) {
        return {
          rows: [{
            tab_gid: '123',
            tab_name: 'Orders',
            headers: ['orderer', 'phone', 'address'],
            detected_headers: ['orderer', 'phone', 'address'],
            header_row_index: 1,
            data_start_row: 2,
          }],
        };
      }
      if (sql.includes('FROM raw_sheet_rows')) {
        return { rows: [{ rowIndex: 2, cells: ['', '', ''] }] };
      }
      if (sql.includes('UPDATE order_submissions')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    connect: async () => fakeClient,
  };

  __setPoolForTest(fakePool);
  try {
    const ledger = await createOrderLedgerEntry({
      sheetId: 'sheet-1',
      tabName: 'Orders',
      gid: '123',
      orderData: { orderer: 'Kim', recipient: 'Lee', phone: '01012345678', address: 'Seoul', dateStr: '2026-06-26' },
    });
    assert.equal(ledger.orderSubmissionId, 'order-1');
    assert.equal(ledger.sheetRow, null);
    assert.equal(ledger.claim.error, 'claim_failed');
    assert(calls.some(c => c.scope === 'pool' && c.sql.includes('INSERT INTO order_submissions')));
    assert(calls.some(c => c.scope === 'pool' && c.sql.includes("mirror_status = 'pending_no_row'")));
  } finally {
    __setPoolForTest(null);
  }
}

run()
  .then(() => console.log('orderLedger tests passed'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
