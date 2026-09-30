'use strict';

// Historical manual payments must survive an arbitrary workboard rebuild.
// The marker stores an identity anchor rather than a row number because rows can
// be inserted/deleted while a campaign is running.
//
// ★★ 앵커가 여러 줄을 가리키면 기록하지 않는다 (완화 금지 · 2026-08-19 실사고)
//   `campaign_participants.order_submission_id` 는 **유니크가 아니고**(sheetlessOrder.service 주석),
//   `identity_key` 는 주문번호가 6자리 이상이면 `num:<주문번호>` 라 **중복 줄이 같은 값**을 갖는다.
//   8/18~19 무시트 사고로 같은 주문이 여러 줄로 복제된 탭에서는, 이 함수가 `for (const target)`
//   로 **모든 줄에 입금일을 다시 찍어** ① 리뷰 미작성 줄에 입금일이 붙고 ② 실제 이체하지 않은
//   줄이 입금완료로 집계됐다. 게다가 이 함수는 **장부 재생성마다** 돌아 사람이 지워도 되살아났다.
//   → 대상이 2줄 이상이면 **아무 줄에도 쓰지 않는다**. 어느 줄이 진짜 이체 대상인지 시스템은
//     알 수 없고, 여기서 하나를 고르면 그 추측이 원장(입금완료)이 된다.
//   ★ 조용히 넘기지 않는다 — 사유를 반환·로그로 남겨 담당자가 중복 줄부터 정리하게 한다.
const { mergeDepositStamps } = require('../utils/depositStamp');
const { logger } = require('../utils/logger');

async function rehydrateManualPaymentMarks(client, { sheetId, tabName, by = 'system' } = {}) {
  if (!sheetId || !tabName) return { restored: 0, ambiguous: 0, ambiguousMarks: [] };
  const { rows } = await client.query(
    `SELECT m.anchor_type, m.anchor_value, m.deposit_col_key, m.stamp, m.paid_at
       FROM manual_payment_marks m
      WHERE m.sheet_id = $1 AND m.tab_name = $2
      ORDER BY m.created_at, m.id`, [sheetId, tabName]);
  let restored = 0;
  const ambiguousMarks = [];
  for (const mark of rows) {
    const { rows: targets } = await client.query(
      `SELECT id, seq, COALESCE(row_json ->> $4, '') AS current_value
         FROM campaign_participants
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE
          AND (( $3 = 'order'    AND order_submission_id::text = $5)
            OR ( $3 = 'manual'   AND id::text = $5)
            OR ( $3 = 'identity' AND identity_key = $5))
        FOR UPDATE`, [sheetId, tabName, mark.anchor_type, mark.deposit_col_key, mark.anchor_value]);
    // ★ 유일성 게이트 — 한 마커가 두 줄 이상을 가리키면 그 마커는 통째로 건너뛴다.
    if (targets.length > 1) {
      ambiguousMarks.push({
        anchorType: mark.anchor_type, anchorValue: mark.anchor_value,
        stamp: mark.stamp, rows: targets.map(t => Number(t.seq)),
      });
      logger.warn(`[manualPaymentLedger] 앵커가 ${targets.length}줄을 가리켜 입금일을 기록하지 않음 `
        + `tab=${tabName} anchor=${mark.anchor_type}:${mark.anchor_value} rows=${targets.map(t => t.seq).join(',')}`);
      continue;
    }
    for (const target of targets) {
      const value = mergeDepositStamps(target.current_value, mark.stamp);
      await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                updated_at = NOW(), updated_by = COALESCE(NULLIF($4,''), updated_by)
          WHERE id = $1`, [target.id, mark.deposit_col_key, value, by]);
      restored += 1;
    }
  }
  return { restored, ambiguous: ambiguousMarks.length, ambiguousMarks };
}

module.exports = { rehydrateManualPaymentMarks };
