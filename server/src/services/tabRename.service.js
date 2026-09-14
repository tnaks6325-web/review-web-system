'use strict';

/**
 * 탭 이름 변경 때 함께 움직여야 하는 현재 좌표 원장.
 * pool을 받으면 자체 transaction, 이미 열린 client를 받으면 호출 transaction에 합류한다.
 */
async function renameTabState(db, { sheetId, oldTabName, newTabName, tabGid = '', sheetUrl = '' } = {}) {
  if (!db || !sheetId || !oldTabName || !newTabName) throw new Error('탭 이름 변경 좌표가 필요합니다.');
  if (oldTabName === newTabName) return { reviewIndexUpdated: 0, indexMasterUpdated: 0, paymentItemsUpdated: 0 };

  const ownsTransaction = typeof db.connect === 'function';
  const client = ownsTransaction ? await db.connect() : db;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    const common = [newTabName, sheetId, oldTabName];
    const withGid = [newTabName, tabGid || null, sheetId, oldTabName];

    const ri = await client.query(
      `UPDATE review_index
          SET tab_name = $1, tab_gid = COALESCE(NULLIF($2, ''), tab_gid)
        WHERE sheet_id = $3 AND tab_name = $4`, withGid);
    await client.query(
      'UPDATE review_submissions SET tab_name = $1 WHERE sheet_id = $2 AND tab_name = $3', common);
    await client.query(
      'UPDATE review_inspections SET tab_name = $1 WHERE sheet_id = $2 AND tab_name = $3', common);
    await client.query(
      'UPDATE review_edit_requests SET tab_name = $1 WHERE sheet_id = $2 AND tab_name = $3', common);
    await client.query(
      'UPDATE review_report_links SET tab_name = $1 WHERE sheet_id = $2 AND tab_name = $3', common);

    // 아직 한 번도 내려받지 않은 회차만 현재 작업 좌표다. 이미 내려받은 회차는 당시 스냅샷을 보존한다.
    const payment = await client.query(
      `UPDATE payment_batch_items i
          SET tab_name = $1
         FROM payment_batches b
        WHERE i.batch_id = b.id
          AND i.sheet_id = $2 AND i.tab_name = $3
          AND i.status = 'pending'
          AND COALESCE(b.download_count, 0) = 0`, common);

    const im = await client.query(
      `UPDATE index_master
          SET tab_name = $1, tab_gid = COALESCE(NULLIF($2, ''), tab_gid)
        WHERE sheet_id = $3 AND tab_name = $4`, withGid);
    await client.query(
      `UPDATE tab_configs
          SET tab_name = $1,
              tab_gid = COALESCE(NULLIF($2, ''), tab_gid),
              sheet_url = COALESCE(NULLIF($3, ''), sheet_url),
              updated_at = NOW()
        WHERE sheet_id = $4 AND tab_name = $5`,
      [newTabName, tabGid || null, sheetUrl || null, sheetId, oldTabName]);

    const { renameCampaignLinkedTab } = require('../utils/campaignTabLateral');
    const campaignLinksUpdated = await renameCampaignLinkedTab(client, {
      sheetId, oldTabName, newTabName, tabGid,
    });
    if (ownsTransaction) await client.query('COMMIT');

    try {
      const { invalidateCashReceiptContext } = require('./cashReceiptContext.service');
      invalidateCashReceiptContext(sheetId, oldTabName);
      invalidateCashReceiptContext(sheetId, newTabName);
    } catch (_) {}
    return {
      reviewIndexUpdated: ri.rowCount || 0,
      indexMasterUpdated: im.rowCount || 0,
      paymentItemsUpdated: payment.rowCount || 0,
      campaignLinksUpdated: campaignLinksUpdated || 0,
    };
  } catch (e) {
    if (ownsTransaction) try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    if (ownsTransaction) client.release();
  }
}

module.exports = { renameTabState };
