/**
 * 상품형 주문은 작업표 슬롯의 option_text(표시용 상품명)와 모집공고 상품명이 달라도
 * 빈 슬롯을 사용해야 한다. 상품명은 슬롯 선택 키가 아니라 `상품` 열 기록값이다.
 * 실행: node tests/sheetlessProductNameSlot.test.js
 */
'use strict';

const assert = require('assert');
const orderSvc = require('../src/services/sheetlessOrder.service');
const ledgerSvc = require('../src/services/orderLedger.service');
const rowNumbering = require('../src/services/rowNumbering.service');
const sheetlessLedger = require('../src/services/sheetlessLedger.service');
const participation = require('../src/services/participation.service');

async function run() {
  const originals = {
    loadRawTabContext: ledgerSvc.loadRawTabContext,
    markOrderWritten: ledgerSvc.markOrderWritten,
    recordReviewIdentity: ledgerSvc.recordReviewIdentity,
    renumberTabInTx: rowNumbering.renumberTabInTx,
    rebuildLedgers: sheetlessLedger.rebuildLedgers,
    recordParticipationLink: participation.recordParticipationLink,
  };
  const seen = [];
  const slotProductLabel = '작업지시서의 긴 상품명';
  const selectedProduct = '모집공고의 짧은 상품명';
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      seen.push({ text, params });
      if (/^BEGIN|^COMMIT|^ROLLBACK|pg_advisory_xact_lock/.test(text)) return { rows: [], rowCount: 0 };
      if (/order_submission_id = \$3::uuid/.test(text) && /FOR UPDATE/.test(text)) return { rows: [], rowCount: 0 };
      if (/order_submission_id IS NULL/.test(text) && /FOR UPDATE SKIP LOCKED/.test(text)) {
        return { rows: [{ id: 'slot-1', seq: 1, option_text: slotProductLabel, row_json: { 상품: '' } }], rowCount: 1 };
      }
      if (/^UPDATE campaign_participants/.test(text)) return { rows: [], rowCount: 1 };
      if (/SELECT id FROM campaign_participants/.test(text)) return { rows: [{ id: 'slot-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const db = {
    connect: async () => client,
    query: async () => ({ rows: [{}], rowCount: 1 }),
  };

  ledgerSvc.loadRawTabContext = async () => ({ headers: ['상품', '수취인', '연락처'], tabGid: '1' });
  ledgerSvc.markOrderWritten = async () => {};
  ledgerSvc.recordReviewIdentity = async () => {};
  rowNumbering.renumberTabInTx = async () => {};
  sheetlessLedger.rebuildLedgers = async () => ({ ok: true });
  participation.recordParticipationLink = async () => {};
  orderSvc.__setPoolForTest(db);

  try {
    const result = await orderSvc.writeOrderToWorktable({
      sheetId: 'S', tabName: 'T', orderSubmissionId: '00000000-0000-0000-0000-000000000001',
      orderData: {
        selectedOptKey: '', selectedProduct,
        orderer: '구매자', recipient: '수취인', phone: '010-1234-5678', orderNum: '',
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.written, true, JSON.stringify(result));

    const claim = seen.find(c => /FOR UPDATE SKIP LOCKED/.test(c.text));
    assert.ok(claim, '빈 슬롯 선점 쿼리가 실행돼야 한다');
    assert.equal(claim.params[3], '', '상품명은 슬롯 선택 파라미터로 전달하면 안 된다');

    const update = seen.find(c => /^UPDATE campaign_participants/.test(c.text));
    assert.ok(update, '선점한 슬롯을 갱신해야 한다');
    assert.equal(update.params[7], '', '상품명을 option_text에 기록하면 안 된다');
    assert.equal(JSON.parse(update.params[3]).상품, selectedProduct, '선택 상품은 상품 열에 기록해야 한다');
  } finally {
    orderSvc.__setPoolForTest(null);
    Object.assign(ledgerSvc, {
      loadRawTabContext: originals.loadRawTabContext,
      markOrderWritten: originals.markOrderWritten,
      recordReviewIdentity: originals.recordReviewIdentity,
    });
    rowNumbering.renumberTabInTx = originals.renumberTabInTx;
    sheetlessLedger.rebuildLedgers = originals.rebuildLedgers;
    participation.recordParticipationLink = originals.recordParticipationLink;
  }
  console.log('sheetless product-name-independent slot checks passed');
}

run().catch(err => { console.error(err); process.exit(1); });
