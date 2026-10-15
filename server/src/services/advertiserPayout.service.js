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

/* 업체입금 판정(공고·탭 값 어떤 표기든) — payment.service 와 같은 규칙. 순환 require 를 피하려고 여기 둔다. */
function _isAdv(v) {
  const s = String(v == null ? '' : v).replace(/\s/g, '').toLowerCase();
  return s === 'advertiser' || s === '업체입금';
}
const KEPT_NOTICE = '이 작업은 이체은행이 「업체입금」이라 그대로 두었습니다 — 바꾸려면 모집공고 설정이나 작업보드 › 작업 조건 › 이체은행에서 확인 후 바꿔 주세요.';

/**
 * 이체은행 쓰기 공통 규칙(결정 247 · Codex 리뷰) — **모든** 이체은행 저장 경로(모집공고 생성·수정 · 탭 설정 /api/tab/config ·
 * 탭 이체설정 transfer-setting)가 이 판정을 거친다.
 *  - 업체입금으로 **켜는** 쓰기 = 고를 수 있는 작업인지 검사(아니면 거부). 연결 작업이 바뀌어도 다시 검사(`recheck`).
 *  - 업체입금을 **끄는** 쓰기 = 화면이 확인을 받았다는 표시(`ack`)가 있을 때만. 없으면(업체입금을 모르는 옛 화면·다른 칸만 고친 저장)
 *    **업체입금을 그대로 둔다** — 조용히 꺼지면 업체가 이미 보낸 미기록 줄이 우리 입금 목록으로 돌아와 이중 입금이 된다.
 * @returns {Promise<{action:'write'}|{action:'keep', kept:string, notice:string}|{action:'reject', error:string, message:string}>}
 */
async function guardTransferBankWrite({ current, incoming, ack = false, sheetId, tabName, recheck = false } = {}) {
  if (incoming === undefined || incoming === null) return { action: 'write' };
  const curAdv = _isAdv(current), inAdv = _isAdv(incoming);
  if (inAdv && (!curAdv || recheck)) {
    const g = await checkAdvertiserPayoutAllowed({ sheetId, tabName });
    if (!g.ok) return { action: 'reject', error: g.error, message: g.message };
  }
  if (curAdv && !inAdv && !(ack === true || ack === 'true' || ack === 1 || ack === '1')) {
    return { action: 'keep', kept: String(current), notice: KEPT_NOTICE };
  }
  return { action: 'write' };
}

module.exports = { checkAdvertiserPayoutAllowed, guardTransferBankWrite, ADVERTISER_PAYOUT_MESSAGES: MESSAGES };
