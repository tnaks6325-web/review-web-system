/**
 * 업체 직접 입금 스위치 저장 (결정 247 · 사용자 확정 2026-10-14 "모두 권장" · migration 189).
 * ★ payment.service(M1 본체)는 payment_* 표에만 쓴다는 규율(paymentBatch 회귀가드)을 지키려고 따로 둔다.
 *   읽는 쪽 = payment.service(_loadAdvertiserPayoutTabs · advertiserPayoutAccounts) · trackB.service(workdeskTab · setWorkdeskDepositDate).
 */
const pool = require('../db/pool');

/**
 * 업체 직접 입금 스위치 켜기/끄기(내부 관리자 전용 — 라우트가 adminOrMaster 로 막는다).
 * ★ 켤 때 막는 경우(막다른 길 방지 — 켜 놓고 아무도 못 쓰는 상태를 만들지 않는다):
 *   - 구글시트를 쓰는 작업(not_sheetless) — 입금 칸 기록 창구가 무시트 전용이다.
 *   - 소유 업체가 없는 작업(no_advertiser) — 계좌를 볼 업체가 없다.
 * ★ 끄면 업체 화면의 계좌 칸·입금 기록 창구가 바로 닫힌다(이미 기록된 입금일은 남는다).
 */
async function setAdvertiserPayout({ sheetId, tabName, enabled, by } = {}) {
  if (!sheetId || !tabName) return { ok: false, error: 'bad_request' };
  const on = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
  const { rows } = await pool.query(
    `SELECT COALESCE(tc.sheetless, FALSE) AS sheetless, tc.tab_gid AS "tabGid",
            (SELECT a.name FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
              WHERE ac.deleted_at IS NULL AND ac.sheet_id = tc.sheet_id
                AND (ac.tab_gid IS NULL OR ac.tab_gid::text = tc.tab_gid::text)
              ORDER BY (ac.tab_gid IS NOT NULL) DESC, ac.created_at LIMIT 1) AS "advertiserName"
       FROM tab_configs tc WHERE tc.sheet_id = $1 AND tc.tab_name = $2 LIMIT 1`,
    [sheetId, tabName]);
  if (!rows.length) return { ok: false, error: 'tab_not_found' };
  const t = rows[0];
  if (on && !t.sheetless) return { ok: false, error: 'not_sheetless' };
  if (on && !t.advertiserName) return { ok: false, error: 'no_advertiser' };
  await pool.query(
    `UPDATE tab_configs SET advertiser_payout = $3, advertiser_payout_by = $4, advertiser_payout_at = NOW(), updated_at = NOW()
      WHERE sheet_id = $1 AND tab_name = $2`,
    [sheetId, tabName, on, String(by || 'admin').slice(0, 100)]);
  return { ok: true, enabled: on, advertiserName: t.advertiserName || null };
}

module.exports = { setAdvertiserPayout };
