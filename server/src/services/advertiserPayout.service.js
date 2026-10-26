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
  no_tab: '업체입금(제품비 업체 포함)은 작업보드가 연결된 공고에서만 고를 수 있습니다.',
  tab_not_found: '이 작업의 설정을 찾지 못해 업체입금(제품비 업체 포함)을 고를 수 없습니다 — 새로고침 후 다시 시도해 주세요.',
  not_sheetless: '구글시트를 쓰는 작업이라 업체입금(제품비 업체 포함)을 고를 수 없습니다 — 업체 입금일 기록은 시트 없이 운영하는 작업에서만 됩니다.',
  no_advertiser: '이 작업에 연결된 업체가 없어 업체입금(제품비 업체 포함)을 고를 수 없습니다 — 업체관리에서 작업을 업체에 먼저 연결해 주세요.',
  // 결정 292 — 업체입금 ↔ 제품비 업체 직접 전환 막기(리뷰비 이중 지급)
  advertiser_recorded: '업체가 이미 입금일을 기록한 줄이 있어 「제품비 업체」로 바꿀 수 없습니다 — 업체입금에서는 업체가 리뷰비까지 보냈으므로, 바꾸면 그 줄에 우리가 리뷰비를 또 보냅니다.',
  fee_paid: '우리가 이미 리뷰비를 보낸(또는 보내는 중인) 줄이 있어 「업체입금」으로 바꿀 수 없습니다 — 바꾸면 업체가 그 줄에 리뷰비를 또 보냅니다.',
  lookup_failed: '이 작업의 입금 기록을 확인하지 못해 바꾸지 않았습니다 — 잠시 뒤 다시 시도해 주세요.',
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
/* 결정 292 — 제품비 업체 · 리뷰비 우리(split). 표기 판정은 payment.service 단일 출처(호출 시점 지연 require — 순환 방지). */
function _splitBank(v) { return require('./payment.service').splitBankOf(v); }
/* 제품비를 업체가 보내는 값인가(업체입금 · split) — 켜기 검사·끄기 확인의 기준 */
function _isGoodsAdv(v) { return _isAdv(v) || !!_splitBank(v); }
/* 같은 선택인가(표기 차이 무시) — 업체입금 ↔ split 전환도 "바꾸는" 쓰기로 본다 */
function _choiceKey(v) { return _isAdv(v) ? 'advertiser' : (_splitBank(v) ? 'split_' + _splitBank(v) : String(v == null ? '' : v).trim()); }
const KEPT_NOTICE = '이 작업은 이체은행이 「업체입금」(또는 「제품비 업체」)이라 그대로 두었습니다 — 바꾸려면 모집공고 설정이나 작업보드 › 작업 조건 › 이체은행에서 확인 후 바꿔 주세요.';

/**
 * 이체은행 쓰기 공통 규칙(결정 247 · Codex 리뷰) — **모든** 이체은행 저장 경로(모집공고 생성·수정 · 탭 설정 /api/tab/config ·
 * 탭 이체설정 transfer-setting)가 이 판정을 거친다.
 *  - 업체입금으로 **켜는** 쓰기 = 고를 수 있는 작업인지 검사(아니면 거부). 연결 작업이 바뀌어도 다시 검사(`recheck`).
 *  - 업체입금을 **끄는** 쓰기 = 화면이 확인을 받았다는 표시(`ack`)가 있을 때만. 없으면(업체입금을 모르는 옛 화면·다른 칸만 고친 저장)
 *    **업체입금을 그대로 둔다** — 조용히 꺼지면 업체가 이미 보낸 미기록 줄이 우리 입금 목록으로 돌아와 이중 입금이 된다.
 * @returns {Promise<{action:'write'}|{action:'keep', kept:string, notice:string}|{action:'reject', error:string, message:string}>}
 */
/* ★ Codex PR #1699 — 판정은 **저장 칸의 날값이 아니라 그 작업의 실제 입금 방식**(그 탭의 가장 최근 공고 → 탭, payoutModeFrom)으로 한다.
     예: 탭 = 업체입금, 최근 공고 = 제품비 업체. 공고를 「자동」으로 바꾸면 날값으로는 "끄기"지만 실제로는 업체입금으로 돌아간다
     (리뷰비를 이미 보낸 줄에 업체가 또 보낸다). slot = 이 쓰기가 바꾸는 칸: 'tab' | 'campaign'(campaignId) | 'campaign_new'.
     반환 코드 = 'advertiser' | 'split_kbank' | 'split_hana' | 'ours'. 조회 실패는 호출부가 거부로 접는다. */
async function _effectiveChoice({ sheetId, tabName, slot, campaignId, incoming }) {
  const pay = require('./payment.service');
  const { rows: c } = await pool.query(
    `SELECT id, transfer_bank FROM recruit_campaigns WHERE linked_sheet_id=$1 AND linked_tab_name=$2
      ORDER BY created_at DESC LIMIT 1`, [sheetId, tabName]);
  const { rows: t } = await pool.query(
    `SELECT transfer_bank FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`, [sheetId, tabName]);
  const campV = c[0] ? c[0].transfer_bank : null, tabV = t[0] ? t[0].transfer_bank : null;
  let nCamp = campV, nTab = tabV;
  if (slot === 'tab') nTab = incoming;
  else if (slot === 'campaign_new') nCamp = incoming;
  else if (slot === 'campaign' && c[0] && String(c[0].id) === String(campaignId || '')) nCamp = incoming;
  const code = m => (m.mode === 'advertiser' ? 'advertiser' : m.mode === 'split' ? pay.SPLIT_PAYOUT[m.bank] : 'ours');
  return { cur: code(pay.payoutModeFrom(campV, tabV)), next: code(pay.payoutModeFrom(nCamp, nTab)) };
}

async function guardTransferBankWrite({ current, incoming, ack = false, sheetId, tabName, recheck = false, slot = null, campaignId = null } = {}) {
  if (incoming === undefined || incoming === null) return { action: 'write' };
  const rawCurrent = current;
  if (slot && sheetId && tabName) {
    try { const eff = await _effectiveChoice({ sheetId, tabName, slot, campaignId, incoming }); current = eff.cur; incoming = eff.next; }
    catch (_) { return { action: 'reject', error: 'lookup_failed', message: MESSAGES.lookup_failed }; }
  }
  /* 결정 292 — 「제품비 업체 · 리뷰비 우리」도 업체입금과 같은 규칙: 업체가 계좌를 보고 입금일을 적어야 하므로 켤 때 같은 검사,
     우리가 제품비를 다시 보내게 되는 쪽(우리 입금)으로 끌 때 같은 확인. 업체입금 ↔ 제품비 업체 사이 전환은 제품비 주체가 그대로라 확인 없이 쓴다. */
  const curAdv = _isGoodsAdv(current), inAdv = _isGoodsAdv(incoming);
  if (inAdv && (_choiceKey(current) !== _choiceKey(incoming) || recheck)) {
    const g = await checkAdvertiserPayoutAllowed({ sheetId, tabName });
    if (!g.ok) return { action: 'reject', error: g.error, message: g.message };
  }
  /* ★ 결정 292(레드팀) — 업체입금 ↔ 제품비 업체 사이는 **리뷰비를 누가 보내는지**가 바뀐다. 이미 그 방식으로 돈이 나간 줄이 있으면 막는다.
       업체입금 → 제품비 업체: 업체가 기록한 줄(= 리뷰비까지 받은 줄)에 우리가 리뷰비를 또 보낸다.
       제품비 업체 → 업체입금: 우리가 리뷰비를 보낸 줄에 업체가 리뷰비를 또 보낸다. 조회 실패 = 바꾸지 않는다(fail-closed). */
  const curKey = _choiceKey(current), inKey = _choiceKey(incoming);
  if (curAdv && inAdv && curKey !== inKey && sheetId && tabName) {
    const fromAdv = _isAdv(current), toAdv = _isAdv(incoming);
    if (fromAdv !== toAdv) {
      try {
        const n = fromAdv
          ? (await pool.query(
              `SELECT COUNT(*)::int AS n FROM participant_edits
                WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL AND left(created_by, 3) = '업체#'
                  AND (field LIKE 'col:%입금%' OR field LIKE 'col:%페이백%') AND btrim(COALESCE(value_text, '')) <> ''`,
              [sheetId, tabName])).rows[0].n
          : (await pool.query(
              `SELECT COUNT(*)::int AS n FROM payment_batch_items
                WHERE sheet_id=$1 AND tab_name=$2 AND status IN ('pending','paid')
                  AND ${require('./payment.service').feeOnlyItemSql()}`, [sheetId, tabName])).rows[0].n;
        if (n > 0) { const e = fromAdv ? 'advertiser_recorded' : 'fee_paid'; return { action: 'reject', error: e, message: MESSAGES[e] }; }
      } catch (_) { return { action: 'reject', error: 'lookup_failed', message: MESSAGES.lookup_failed }; }
    }
  }
  if (curAdv && !inAdv && !(ack === true || ack === 'true' || ack === 1 || ack === '1')) {
    return { action: 'keep', kept: String(rawCurrent), notice: KEPT_NOTICE };
  }
  return { action: 'write' };
}

module.exports = { checkAdvertiserPayoutAllowed, guardTransferBankWrite, ADVERTISER_PAYOUT_MESSAGES: MESSAGES };
