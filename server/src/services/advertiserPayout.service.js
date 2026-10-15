/**
 * 업체 직접 입금(업체입금) 선택 가능 여부 (결정 247 · 2026-10-15 변경: 스위치 → 이체은행 선택지).
 *
 * ★ 저장소는 따로 없다 — 모집공고/탭 설정의 **이체은행 = 업체입금**(`recruit_campaigns.transfer_bank='advertiser'`,
 *   탭은 한글 라벨 `tab_configs.transfer_bank='업체입금'`)이 곧 업체 직접 입금이다. 판정은 payment.service
 *   `advertiserPaysFrom`(공고 → 탭, 이체은행과 같은 순서) 단일 출처.
 * ★ 이 파일은 "업체입금을 고를 수 있는가"만 판정한다(막다른 길 방지 — 고르고 나서 아무도 못 쓰는 상태를 만들지 않는다).
 *   소비처 = 모집공고 생성·수정(campaign.routes) · 탭 이체설정(payment.saveTransferSetting).
 */
const pool = require('../db/pool');

const MESSAGES = {
  no_tab: '업체입금은 작업보드가 연결된 공고에서만 고를 수 있습니다.',
  tab_not_found: '이 작업의 설정을 찾지 못해 업체입금을 고를 수 없습니다 — 새로고침 후 다시 시도해 주세요.',
  not_sheetless: '구글시트를 쓰는 작업이라 업체입금을 고를 수 없습니다 — 업체 입금일 기록은 시트 없이 운영하는 작업에서만 됩니다.',
  no_advertiser: '이 작업에 연결된 업체가 없어 업체입금을 고를 수 없습니다 — 업체관리에서 작업을 업체에 먼저 연결해 주세요.',
};

/**
 * @returns {Promise<{ok:true, advertiserName:string}|{ok:false, error:string, message:string}>}
 * ★ 주인 업체 = trackB.advertiserForTab(탭 지정 > 시트 전체) — 계좌를 보고 입금일을 적는 쪽과 **같은 판정**.
 */
async function checkAdvertiserPayoutAllowed({ sheetId, tabName } = {}) {
  const fail = (error) => ({ ok: false, error, message: MESSAGES[error] });
  if (!sheetId || !tabName) return fail('no_tab');
  const { rows } = await pool.query(
    `SELECT COALESCE(sheetless, FALSE) AS sheetless FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`,
    [sheetId, tabName]);
  if (!rows.length) return fail('tab_not_found');
  if (!rows[0].sheetless) return fail('not_sheetless');
  const owner = await require('./trackB.service').advertiserForTab({ sheetId, tabName });
  if (!owner || !owner.id) return fail('no_advertiser');
  return { ok: true, advertiserName: owner.name || '' };
}

module.exports = { checkAdvertiserPayoutAllowed, ADVERTISER_PAYOUT_MESSAGES: MESSAGES };
