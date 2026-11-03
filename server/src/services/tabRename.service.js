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
    workOrdersUpdated: 0,
    workOrderLinksUpdated: 0,
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
    // Q&A 자리표(결정 321)는 작업표 줄 번호(seq)를 가리킨다 — 줄과 함께 옮기지 않으면 자리표가 사라진 탭이 되어
    // 자동 정리(빈 줄·날짜 옮기기)가 자리 줄을 리뷰 줄처럼 손댄다.
    await client.query(
      'UPDATE qna_slots SET tab_name = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3', common);

    // 입금 전 pending 항목은 다운로드 여부와 무관하게 현재 행의 동일성 좌표를 따라간다.
    // 이미 만든 이체 파일의 표시명은 그 파일 자체가 스냅샷으로 보존한다. DB 좌표를 옛 이름에
    // 남기면 활성 회차 제외 조인이 끊겨 같은 행을 두 번째 회차에 넣을 수 있다.
    // Ordinary paid snapshots stay immutable. Historical feeOnly paid rows additionally act as
    // the live payout lock: move only their current coordinates, never bank/amount/date evidence.
    const payment = await client.query(
      `UPDATE payment_batch_items
          SET tab_name = $1
        WHERE sheet_id = $2 AND tab_name = $3
          AND ((status = 'pending' AND NOT EXISTS (
                SELECT 1 FROM payment_batches b
                 WHERE b.id = payment_batch_items.batch_id
                   AND b.historical_key LIKE 'historical-fee:%'
              )) OR (status = 'paid' AND EXISTS (
                SELECT 1 FROM payment_batches b
                 WHERE b.id = payment_batch_items.batch_id
                   AND b.historical_key LIKE 'historical-fee:%'
              )))`, common);
    await client.query(
      `UPDATE payment_records pr
          SET tab_name = $1
        WHERE pr.sheet_id = $2 AND pr.tab_name = $3
          AND pr.status = 'PAID' AND pr.source_key LIKE 'historical-fee:%'
          AND EXISTS (
            SELECT 1 FROM payment_batch_items i JOIN payment_batches b ON b.id = i.batch_id
             WHERE i.sheet_id = pr.sheet_id AND i.tab_name = $1 AND i.row_index = pr.row_index
               AND i.status = 'paid' AND b.historical_key LIKE 'historical-fee:%'
          )`, common);

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

    // ★★ 결정 325 — 리뷰오더 연결 두 곳도 같은 트랜잭션에서 새 이름으로 옮긴다.
    //   안 옮기면 「그 탭의 리뷰오더」 조회(utils/workOrderLink.workOrderForTabSql — 이름으로만 찾는다)가
    //   새 이름에서 0건이 되어 정원·작업 조건 카드·업체 화면 총건수가 조용히 비고, 무시트 재접수는
    //   옛 이름(o.linked_tab_name)으로 탭을 다시 등록한다.
    //   ① 직접 연결 work_orders.linked_tab_name — **이름 칸만** 바꾼다. sync_version·updated_at·
    //      shared_sync_outbox 는 건드리지 않는다(인트라넷 전송 대상이 아니다 — 작업 삭제 workTabDelete 가
    //      linked_tab_* 를 직접 비우는 것과 같은 좌표 정리). gid 가 다르게 적힌 오더는 다른 탭 것이라 그대로 둔다.
    //      지운 오더도 옮긴다(「원본 오더 삭제됨」 표시가 새 이름에서도 잡히게 — 결정 254).
    const wo = await client.query(
      `UPDATE work_orders
          SET linked_tab_name = $1
        WHERE linked_tab_sheet_id = $3 AND linked_tab_name = $4
          AND (COALESCE(linked_tab_gid, '') = '' OR $2::text = '' OR linked_tab_gid = $2::text)`,
      [newTabName, String(tabGid == null ? '' : tabGid), sheetId, oldTabName]);
    //   ② 수동 발주 연결 trackb_work_order_links.tab_name — 지운 연결(이력)도 함께 옮긴다.
    //      새 이름에 이미 활성 연결이 있으면(드묾) 탭당 활성 1개 제약 때문에 옛 활성 연결은 그대로 두고 알린다.
    const links = await client.query(
      `UPDATE trackb_work_order_links l
          SET tab_name = $1
        WHERE l.sheet_id = $2 AND l.tab_name = $3
          AND (l.deleted_at IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM trackb_work_order_links x
                 WHERE x.sheet_id = $2 AND x.tab_name = $1 AND x.deleted_at IS NULL))`,
      [newTabName, sheetId, oldTabName]);
    const { rows: leftLinks } = await client.query(
      `SELECT work_order_id FROM trackb_work_order_links
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL LIMIT 1`, [sheetId, oldTabName]);
    if (leftLinks && leftLinks.length) {
      try {
        require('../utils/logger').logger.warn(
          `[tabRename] 새 이름 "${newTabName}" 에 이미 발주 연결이 있어 옛 이름 "${oldTabName}" 의 발주 연결(${leftLinks[0].work_order_id})은 옮기지 않음 — 작업보드에서 연결을 확인하세요`);
      } catch (_) { /* 로깅 실패는 무시 */ }
    }
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
      workOrdersUpdated: (wo && wo.rowCount) || 0,
      workOrderLinksUpdated: (links && links.rowCount) || 0,
    };
  } catch (e) {
    if (ownsTransaction) try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    if (ownsTransaction) client.release();
  }
}

module.exports = { renameTabState };
