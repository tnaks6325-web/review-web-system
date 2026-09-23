'use strict';

// Historical manual payments must survive an arbitrary workboard rebuild.
// The marker stores an identity anchor rather than a row number because rows can
// be inserted/deleted while a campaign is running.
const { mergeDepositStamps } = require('../utils/depositStamp');

async function rehydrateManualPaymentMarks(client, { sheetId, tabName, by = 'system' } = {}) {
  if (!sheetId || !tabName) return { restored: 0 };
  const { rows } = await client.query(
    `SELECT m.anchor_type, m.anchor_value, m.deposit_col_key, m.stamp, m.paid_at
       FROM manual_payment_marks m
      WHERE m.sheet_id = $1 AND m.tab_name = $2
      ORDER BY m.created_at, m.id`, [sheetId, tabName]);
  let restored = 0;
  for (const mark of rows) {
    const { rows: targets } = await client.query(
      `SELECT id, COALESCE(row_json ->> $4, '') AS current_value
         FROM campaign_participants
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE
          AND (( $3 = 'order'    AND order_submission_id::text = $5)
            OR ( $3 = 'manual'   AND id::text = $5)
            OR ( $3 = 'identity' AND identity_key = $5))
        FOR UPDATE`, [sheetId, tabName, mark.anchor_type, mark.deposit_col_key, mark.anchor_value]);
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
  return { restored };
}

module.exports = { rehydrateManualPaymentMarks };
