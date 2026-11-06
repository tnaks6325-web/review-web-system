'use strict';
// 동시진행 구매 조건의 「현금영수증 필요」는 리뷰어가 보는 구매 안내(campaign.routes _cashReceiptInfo)와
// 같은 기준이어야 한다: 공고 직접 설정 OR 연결 작업표 진행방식(income_type)에 '현영'.
// 갈리면 안내에는 "현금영수증 필요"가 뜨는데 지급 판정은 영수증 없이 지급한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/dualSubmitFixture');

async function snapshotFor(setup) {
  const f = await h.bundleFixture();
  h.usePool(f.db);
  try {
    await setup(f.db);
    await f.stage('naver');
    const proof = require('../src/services/dualPurchaseProof.service');
    const product = (await f.db.query(`SELECT work_detail FROM recruit_campaigns WHERE id='camp'`)).rows[0].work_detail.dualChannelProduct;
    const stored = (await f.db.query('SELECT condition_snapshot_hash FROM purchase_capture_artifacts')).rows[0].condition_snapshot_hash;
    if (stored === proof.hash({ ...product, cashReceiptRequired: true })) return true;
    if (stored === proof.hash({ ...product, cashReceiptRequired: false })) return false;
    throw new Error('condition snapshot hash matches neither shape');
  } finally { await f.close(); }
}

test('worktab income type 현영 makes the dual purchase condition receipt-required', async () => {
  assert.equal(await snapshotFor(db => db.query(`INSERT INTO tab_configs(sheet_id,tab_name,income_type) VALUES('sheet','작업','현영')`)), true);
});

test('campaign flag alone still makes it receipt-required; neither = not required', async () => {
  assert.equal(await snapshotFor(db => db.query(`UPDATE recruit_campaigns SET cash_receipt_required=true WHERE id='camp'`)), true);
  assert.equal(await snapshotFor(db => db.query(`INSERT INTO tab_configs(sheet_id,tab_name,income_type) VALUES('sheet','작업','일반')`)), false);
});
