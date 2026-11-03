/**
 * capturePriceCheck.service.js — 구매캡처 결제금액 ≠ 공고 결제금액 (결정 319 · 사용자 확정 2026-11-02)
 *
 * 발단(운영 2026-11-02): 네이버 「엘릭서 앰플 50ml」 공고(1건 25,000원)에 결제금액 43,000원 주문이 그대로 접수됐다.
 *   상품이 하나뿐인 공고는 결정 230·236 의 「다른 상품 가격」 판정 대상이 아니어서 결제금액을 아무도 보지 않았다.
 *   (10/13 이후 공고 주문 2,996건 중 2,300건이 상품 1개 공고 — 금액 검사가 0이었다.)
 *
 * 사용자 확정(2026-11-02):
 *   · 쿠팡 = 로켓 가격 추적으로 금액이 자주 바뀐다 → 공고 금액보다 **30% 넘게 비쌀 때만 막는다**(다른 상품·2개 구매).
 *     60일 실측: 10~30% 비쌈 481건(대부분 핫팩 공고의 로켓 변동) · 30% 초과 4건.
 *     같은 주문번호로 두 번째부터는 「직원 확인 요청」으로 받는다(작업보드 🚩 · 직원이 캡처를 보고 반려) — 결정 260 과 같은 탈출구.
 *   · 쿠팡 밖(네이버·올리브영·카카오·직접입력) = 판매자가 직접 관리해 금액이 잘 안 바뀐다 → **1,000원 넘게 다르면** 막지 않고
 *     리뷰어에게 한 번 알린 뒤(그대로 제출 가능) 작업보드 🚩. 60일 실측 네이버 1,735건 중 31건.
 *   · 금액 차이로 받은 주문은 그 공고의 「가격 신고」(결정 266)에도 센다 — 다른 리뷰어 2명이면 관리자 팝업으로 공고 금액을 고친다.
 *
 * ★ 판정 재료
 *   · 공고 금액 = 고른 개수의 단계 금액(289) → 고른 상품의 금액(신청 시각 금액 · 275) → 공고 상품 글자의 `결제금액 N원`
 *     (글자 안 금액이 **하나일 때만** — 2종 이상이면 무엇이 정답인지 모르므로 보지 않는다 · 글자에 금액이 없으면 work_detail.payAmount — 리뷰어 화면과 같은 규칙).
 *   · 결제금액 = 캡처에서 AI 가 읽은 금액(리뷰어가 고칠 수 없는 값) → 없으면 리뷰어가 적은 결제금액.
 *   · 구매처 = 공고의 구매처(recruit_campaigns.channel) — 리뷰어 캡처가 아니라 공고 설정으로 정한다.
 * ★ fail-open — 공고·금액·구매처를 모르거나 조회가 실패하면 아무 일도 하지 않는다(모르는 것으로 사람을 막지 않는다).
 * ★ 판정은 **쓰기 전**(제출 라우트의 필수 배송메세지 게이트 바로 뒤).
 * 끄는 스위치(env): `CAPTURE_PRICE_CHECK=0`.
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const _won = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const _wonText = (n) => Number(n || 0).toLocaleString('ko-KR');

/** 쿠팡: 공고 금액보다 이 비율 **넘게** 비싸면 막는다(사용자 확정 2026-11-02 「30%」). */
const COUPANG_OVER_RATIO = 0.3;
/** 쿠팡 밖: 이 금액 **넘게** 다르면 알린다(사용자 확정 2026-11-02 「1,000원」 — 포인트·쿠폰 몇백 원 차이는 정상). */
const OTHER_DIFF_WON = 1000;

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }
function isEnabled() { return String(process.env.CAPTURE_PRICE_CHECK || '').trim() !== '0'; }

/** 공고 구매처 → 'coupang' | 'other' | ''(모름 — 판정 안 함). */
function channelKind(channel) {
  const c = String(channel == null ? '' : channel).replace(/\s/g, '');
  if (!c) return '';
  return /쿠팡|coupang/i.test(c) ? 'coupang' : 'other';
}

/** 공고 상품 글자의 `결제금액 N원` — 서로 다른 금액이 **하나일 때만** 그 금액(2종 이상·없음 = 0). */
function uniquePayFromProductLines(text) {
  const amts = _payAmountsInText(text);
  return amts.size === 1 ? [...amts][0] : 0;
}

/** 글자 안 서로 다른 `결제금액 N원` 금액들. */
function _payAmountsInText(text) {
  const amts = new Set();
  const re = /결제금액\s*([\d,]+)\s*원/g;
  let m;
  const s = String(text == null ? '' : text);
  while ((m = re.exec(s))) { const v = _won(m[1]); if (v) amts.add(v); }
  return amts;
}

/**
 * 상품을 나누지 않은 공고의 1건 금액 — 리뷰어 화면(`campaign-workdetail.js` 작업 조건)과 **같은 규칙**:
 *   글자 안 금액이 하나 = 그 금액 · 글자에 금액이 없음 = `work_detail.payAmount` · 2종 이상 = 모름(0).
 */
function wholeCampaignPay(productLines, payAmount) {
  const amts = _payAmountsInText(productLines);
  if (amts.size === 1) return [...amts][0];
  if (amts.size === 0) return _won(payAmount);
  return 0;
}

/**
 * 리뷰어에게 보일 차이 문장 — 얼마나·몇 % 다른지까지(사용자 확정 2026-11-02: 「차이가 나요」만으로는 부족).
 * 예) 제출하신 구매캡처 속 결제금액(43,000원)이 작업 조건 결제금액(25,000원)보다 18,000원 더 비쌉니다(72% 초과).
 * ★ 비율은 반올림 정수 — 단 쿠팡 막힘 기준(30%) 언저리에서 반올림이 「30%」가 되면 소수 한 자리로 보인다(「30% 초과」로 막혔는데 30%로 읽히지 않게).
 */
function diffSentence(expected, paid) {
  const e = _won(expected), p = _won(paid);
  const diff = Math.abs(p - e);
  const pct = e ? (diff / e) * 100 : 0;
  let pctText = String(Math.round(pct));
  if (Math.round(pct) === Math.round(COUPANG_OVER_RATIO * 100) && pct !== Math.round(pct)) pctText = pct.toFixed(1);
  return p > e
    ? `제출하신 구매캡처 속 결제금액(${_wonText(p)}원)이 작업 조건 결제금액(${_wonText(e)}원)보다 ${_wonText(diff)}원 더 비쌉니다(${pctText}% 초과).`
    : `제출하신 구매캡처 속 결제금액(${_wonText(p)}원)이 작업 조건 결제금액(${_wonText(e)}원)보다 ${_wonText(diff)}원 더 쌉니다(${pctText}% 적음).`;
}

/**
 * 순수 판정 — 쓰기 0 · 예외 없음.
 * @returns {{action:'none'}|{action:'block',kind,expected,paid,error}|{action:'warn',kind,expected,paid,error}|{action:'flag',kind,expected,paid,code}}
 *   block = 쿠팡 30% 초과(직원 확인 요청이 없으면 막는다) · warn = 쿠팡 밖 1,000원 초과(리뷰어 확인 전) · flag = 접수 + 🚩
 */
function judge({ kind, expected, paid, staffReview = false, ack = false }) {
  const e = _won(expected), p = _won(paid);
  if (!kind || !e || !p || e === p) return { action: 'none' };
  if (kind === 'coupang') {
    if (p <= e * (1 + COUPANG_OVER_RATIO)) return { action: 'none' };
    if (staffReview) return { action: 'flag', kind, expected: e, paid: p, code: 'price_over' };
    return {
      action: 'block', kind, expected: e, paid: p,
      error: `${diffSentence(e, p)} `
        + `다른 상품이나 다른 개수를 구매하지 않았는지 주문 내역을 확인하고, 맞는 구매캡처를 다시 올려 주세요.`,
    };
  }
  if (Math.abs(p - e) <= OTHER_DIFF_WON) return { action: 'none' };
  if (ack) return { action: 'flag', kind, expected: e, paid: p, code: 'price_diff' };
  return {
    action: 'warn', kind, expected: e, paid: p,
    error: `${diffSentence(e, p)} 주문한 상품·개수·옵션이 맞는지 확인해 주세요.`,
  };
}

/**
 * 공고 금액 · 구매처를 읽는다(검증된 홀드만). 모르면 null.
 * @returns {Promise<null|{kind:string, expected:number, channel:string}>}
 */
async function loadExpected({ holdCtx, db = getPool() }) {
  if (!holdCtx || !holdCtx.verified || !holdCtx.campaignId) return null;
  const { rows } = await db.query(
    `SELECT channel, work_detail->>'productLines' AS pl, work_detail->>'payAmount' AS pay FROM recruit_campaigns WHERE id = $1 LIMIT 1`,
    [String(holdCtx.campaignId)]);
  if (!rows.length) return null;
  const kind = channelKind(rows[0].channel);
  if (!kind) return null;
  let expected = _won(holdCtx.qtyTierAmount);
  if (!expected && holdCtx.optionKey) {
    const opts = await require('./productMismatchVerify.service').loadOptionsAt(db, holdCtx.campaignId, holdCtx.appliedAt || null);
    const o = opts.find(x => x.opt_key === String(holdCtx.optionKey));
    expected = o ? _won(o.pay_amount) : 0;
  }
  if (!expected) expected = wholeCampaignPay(rows[0].pl, rows[0].pay);
  if (!expected) return null;
  return { kind, expected, channel: String(rows[0].channel || '') };
}

/**
 * 제출 때 판정 — 쓰기 0. 실패 = none(fail-open).
 * @param {{holdCtx, capturePrice, typedPrice, staffReview, ack}} p
 */
async function decideAtSubmit({ holdCtx, capturePrice = '', typedPrice = '', staffReview = false, ack = false, db = getPool() } = {}) {
  if (!isEnabled()) return { action: 'none' };
  if (!holdCtx || !holdCtx.verified || holdCtx.doneKind) return { action: 'none' };
  const paid = _won(capturePrice) || _won(typedPrice);
  if (!paid) return { action: 'none' };
  try {
    const ex = await loadExpected({ holdCtx, db });
    if (!ex) return { action: 'none' };
    const d = judge({ kind: ex.kind, expected: ex.expected, paid, staffReview, ack });
    return d.action === 'none' ? d : { ...d, paidSource: _won(capturePrice) ? 'capture' : 'typed' };
  } catch (e) {
    logger.warn(`[capture-price] 판정 실패 — 종전대로 접수: ${(e && e.message) || e}`);
    return { action: 'none' };
  }
}

module.exports = {
  COUPANG_OVER_RATIO, OTHER_DIFF_WON,
  isEnabled, channelKind, diffSentence, uniquePayFromProductLines, wholeCampaignPay, judge, loadExpected, decideAtSubmit, __setPoolForTest,
};
