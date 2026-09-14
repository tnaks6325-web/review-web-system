'use strict';

/**
 * 탭 이름 변경 때 함께 움직여야 하는 현재 좌표 원장.
 * pool을 받으면 자체 transaction, 이미 열린 client를 받으면 호출 transaction에 합류한다.
 */
async function renameTabState(db, { sheetId, oldTabName, newTabName, tabGid = '', sheetUrl = '' } = {}) {
  if (!db || !sheetId || !oldTabName || !newTabName) throw new Error('탭 이름 변경 좌표가 필요합니다.');
  if (oldTabName === newTabName) return {
    reviewIndexUpdated: 0,
    indexMasterUpdated: 0,
    orderSubmissionsUpdated: 0,
    campaignParticipantsUpdated: 0,
    paymentItemsUpdated: 0,
  };

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

    // 지급 게이트의 공고 provenance도 현재 탭 좌표를 기준으로 조인한다. 이름만 바뀐 뒤
    // 이 두 원장을 옛 좌표에 남기면 exact campaign을 잃고, 같은 탭을 재사용한 공고들의
    // 현금영수증 설정을 합친 보수적 폴백으로 잘못 차단될 수 있다.
    const orders = await client.query(
      `UPDATE order_submissions
          SET tab_name = $1,
              tab_gid = COALESCE(NULLIF($2, ''), tab_gid),
              gid = COALESCE(NULLIF($2, ''), gid)
        WHERE sheet_id = $3 AND tab_name = $4`, withGid);
    const participants = await client.query(
      `UPDATE campaign_participants
          SET tab_name = $1,
              tab_gid = COALESCE(NULLIF($2, ''), tab_gid),
              updated_at = NOW()
        WHERE sheet_id = $3 AND tab_name = $4`, withGid);

    // 입금 전 pending 항목은 다운로드 여부와 무관하게 현재 행의 동일성 좌표를 따라간다.
    // 이미 만든 이체 파일의 표시명은 그 파일 자체가 스냅샷으로 보존한다. DB 좌표를 옛 이름에
    // 남기면 활성 회차 제외 조인이 끊겨 같은 행을 두 번째 회차에 넣을 수 있다.
    const payment = await client.query(
      `UPDATE payment_batch_items
          SET tab_name = $1
        WHERE sheet_id = $2 AND tab_name = $3
          AND status = 'pending'`, common);

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
      orderSubmissionsUpdated: orders.rowCount || 0,
      campaignParticipantsUpdated: participants.rowCount || 0,
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
