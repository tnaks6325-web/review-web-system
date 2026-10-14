'use strict';

/**
 * 바로 구매 규칙 위반 표시 (결정 242 · 사용자 확정 2026-10-14 "2.가 — 표시만, 입금은 담당자가 정한다").
 *
 * 공고 참여 없이 바로 낸 구매가 들어온 직후(응답 뒤) 공고 참여 버튼과 **같은 규칙**을 판정해 order_submissions.rule_flags 에 남긴다.
 *   popular_no_credit  인기 공고인데 그 명의에 참여권이 없었다(결정 068·238 — popularCredit 단일 출처, 이 구매 직전 시각 기준)
 *   unregistered       연락처가 등록 리뷰어(본계정·활성 코드 신원)가 아니다
 *   repurchase_window  같은 작업에서 재참여 기간 안에 이미 산 명의다(repurchaseGuard.checkRepurchaseConflictAt)
 *   one_per_person     1인 1회 공고에서 같은 사람의 다른 명의(소유 증명된 명의만)가 기간 안에 이미 참여·구매했다
 *   daily_cap          그 명의의 그날 참여(공고 참여 제출 + 바로 구매)가 상한(기본 10) 이상인 뒤의 구매다
 *   option_full        (결정 252) 이 구매가 세어진 상품이 구매 시점에 이미 정원이 찬 뒤였다(상품 정원 셈 단일 출처 — 공고 참여 + 바로 구매)
 *
 * ★ 막지 않는다 · 판정 실패는 표시 없이 지나간다(NULL = 모름 — "위반 없음" '[]' 과 구분).
 * ★ 공고 = 그 작업표에 연결된 참여형 공고 중 구매 시점에 이미 있던 가장 최근 것(결정 238 참여권 이벤트와 같은 규칙).
 */

const { logger } = require('../utils/logger');

const OS_PHONE8 = `RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8)`;

const RULE_LABELS = Object.freeze({
  popular_no_credit: '참여권 없는 인기 공고 구매',
  unregistered: '등록 안 된 번호',
  repurchase_window: '재구매 기간 안 구매',
  one_per_person: '1인 1회 — 다른 명의로 이미 참여',
  daily_cap: '하루 참여 상한 초과',
  option_full: '정원 넘친 상품 구매',
});

function _dailyCap() {
  return parseInt(process.env.CAMPAIGN_DAILY_APPLY_CAP || '10', 10) || 10;
}

function _kstDayStart(at) {
  const t = new Date(at).getTime() + 9 * 3600 * 1000;
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 9 * 3600 * 1000);
}

/** 순수 판정 묶음 — DB 결과를 받아 위반 코드 배열을 만든다(테스트용으로 분리). */
function collectFlags({ registered, repurchaseBlocked, onePerPersonBlocked, popular, popularCredits, todayBefore, dailyCap, optionFull }) {
  const flags = [];
  if (popular && !(Number(popularCredits) >= 1)) flags.push('popular_no_credit');
  if (registered === false) flags.push('unregistered');
  if (repurchaseBlocked) flags.push('repurchase_window');
  if (onePerPersonBlocked) flags.push('one_per_person');
  if (Number(todayBefore) >= (Number(dailyCap) || 10)) flags.push('daily_cap');
  if (optionFull === true) flags.push('option_full');
  return flags.map(code => ({ code }));
}

/**
 * ★ 결정 252 — 이 바로 구매가 세어진 상품이 구매 시점에 이미 정원이 찼었나.
 *   상품 귀속·중복 제외는 정원 셈 단일 출처(`campaignState.loadExternalOptionOrders` — 참여 게이트·작업보드 팝업과 같은 셈)를 그대로 쓴다.
 *   그 셈에 안 들어간 주문(상품 모름 · 같은 구매 중복 · 공고 참여의 수동 중복)은 자리를 더 쓰지 않았으므로 false.
 *   이 구매 **앞에** 자리를 잡은 수 = 같은 상품의 먼저 들어온 바로 구매 + 먼저 신청한 공고 참여(제출 완료 · 아직 살아 있는 신청).
 *   정원은 지금 값(판정은 접수 직후라 그때 정원과 같다). 정원 0(무제한)은 false.
 * @returns {Promise<boolean>} 조회 실패는 throw — 판정 전체가 NULL(모름)로 남는다(모름을 "위반 없음"으로 적지 않는다).
 */
async function optionFullAtPurchase(db, campaignId, order) {
  if (process.env.DIRECT_PURCHASE_OPTION_FULL_FLAG === '0') return false;
  const st = require('./campaignState.service');
  // 정원 엔진이 바로 구매를 상품에 세지 않게 꺼져 있으면(결정 210 스위치) 이 항목만 빠진다 — 다른 위반 표시까지 NULL 로 만들지 않는다(코드리뷰)
  if (!st.externalOptionCountEnabled()) return false;
  const { rows: optRows } = await db.query(
    'SELECT opt_key, recruit_total FROM campaign_options WHERE campaign_id = $1', [campaignId]);
  if (!optRows.length) return false;
  const collected = [];
  const ext = await st.loadExternalOptionOrders(db, [campaignId], new Date(), { collectOrders: collected });
  if (ext === null) throw new Error('상품 정원 셈 조회 실패');
  const mine = collected.find(x => x.orderId === String(order.id));
  if (!mine) return false;
  const opt = optRows.find(r => r.opt_key === mine.key);
  const cap = Number(opt && opt.recruit_total) || 0;
  if (!(cap > 0)) return false;
  const at = new Date(order.submitted_at).getTime();
  // 같은 시각이면 주문 id 순 — 같은 ms 의 두 주문이 서로를 "앞"으로 세지 않는 일이 없게(결정적 순서)
  const isBefore = x => { const t = new Date(x.submittedAt).getTime(); return t < at || (t === at && x.orderId < mine.orderId); };
  const extBefore = collected.filter(x => x.key === mine.key && x.orderId !== mine.orderId && isBefore(x)).length;
  // 이 구매자 본인이 잡아 둔 살아 있는 자리(같은 연락처의 applied)는 "앞선 다른 사람 자리"가 아니다 — 자기 자리로 오탐하지 않게(코드리뷰)
  // 구매 **시각 기준**으로 자리를 센다 — 판정은 응답 뒤라 그사이 만료·정리된 자리를 빠뜨리지 않게(Codex PR #1641):
  //   제출 완료 + 구매 시각에 아직 살아 있던 신청(applied·expired 중 expires_at > 구매 시각). 취소는 언제 됐는지 몰라 세지 않는다(모르면 넘침이 아님).
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM campaign_applications
      WHERE campaign_id = $1 AND option_key = $2 AND applied_at < $3
        AND (status = 'submitted'
             OR (status IN ('applied', 'expired') AND expires_at > $3 AND NOT (phone8 = $4 AND $4 <> '')))`,
    [campaignId, mine.key, order.submitted_at, String(order.phone8 || '')]);
  return extBefore + (Number(rows[0] && rows[0].n) || 0) >= cap;
}

/**
 * 한 주문을 판정해 rule_flags 를 쓴다. 공고 참여 주문·취소 주문·참여형 공고 없는 작업표는 건드리지 않는다.
 * @returns {Promise<{judged:boolean, flags?:Array, reason?:string}>}
 */
async function judgeDirectPurchase(db, orderSubmissionId) {
  if (!orderSubmissionId) return { judged: false, reason: 'no_id' };
  const { rows: oRows } = await db.query(
    `SELECT os.id, os.sheet_id, os.tab_name, os.submitted_at, os.campaign_application_id, os.deleted_at,
            ${OS_PHONE8} AS phone8
       FROM order_submissions os WHERE os.id = $1::uuid`, [orderSubmissionId]);
  const o = oRows[0];
  if (!o) return { judged: false, reason: 'not_found' };
  if (o.campaign_application_id || o.deleted_at) return { judged: false, reason: 'not_direct' };
  // ★ 결정 252(Codex PR #1641): 공고 참여 좌표(campaign:<id>)에 남은 바로 구매(홀드 확정 실패)는 그 공고로 바로 찾는다 —
  //   정원 셈(loadExternalOptionOrders)이 이 좌표를 그 공고 주문으로 세므로 판정도 같은 공고를 본다.
  const _vm = /^campaign:(.+)$/.exec(String(o.sheet_id || ''));
  const { rows: cRows } = (_vm && o.tab_name === o.sheet_id)
    ? await db.query(
      `SELECT rc.id, rc.is_popular, rc.multi_account_mode, rc.repurchase_days, rc.linked_sheet_id, rc.linked_tab_name
         FROM recruit_campaigns rc WHERE rc.id = $1 AND rc.participation_mode IS TRUE LIMIT 1`, [_vm[1]])
    : await db.query(
      `SELECT rc.id, rc.is_popular, rc.multi_account_mode, rc.repurchase_days, rc.linked_sheet_id, rc.linked_tab_name
         FROM recruit_campaigns rc
        WHERE rc.participation_mode IS TRUE AND rc.linked_sheet_id = $1 AND rc.linked_tab_name = $2
        ORDER BY ${require('./directPurchaseParticipation.service').campaignAtPurchaseOrderSql('$3')}
        LIMIT 1`, [o.sheet_id, o.tab_name, o.submitted_at]);
  const camp = cRows[0];
  if (!camp) return { judged: false, reason: 'no_campaign' };

  const p8 = String(o.phone8 || '');
  const validPhone = /^\d{8}$/.test(p8);
  const at = new Date(o.submitted_at);

  // 등록 리뷰어 = 본계정 번호 또는 활성 코드 신원(소유자도 함께 알아 둔다 — 1인 1회 판정용)
  let ownerId = null; let ownerP8 = null; let registered = false;
  if (validPhone) {
    const { rows } = await db.query(
      `SELECT r.id, r.phone8 FROM reviewers r WHERE r.phone8 = $1
       UNION ALL
       SELECT r.id, r.phone8 FROM reviewer_identities ri JOIN reviewers r ON r.id = ri.owner_reviewer_id
        WHERE ri.current_phone8 = $1 AND ri.status = 'active'
       LIMIT 1`, [p8]);
    if (rows[0]) { registered = true; ownerId = rows[0].id; ownerP8 = String(rows[0].phone8 || ''); }
  }

  const guard = require('../utils/repurchaseGuard');
  let repurchaseBlocked = false;
  if (validPhone) {
    const r = await guard.checkRepurchaseConflictAt(db, {
      sheetId: o.sheet_id, tabName: o.tab_name, campaignId: camp.id, phone8: p8, days: camp.repurchase_days,
      targetSubmittedAt: o.submitted_at, excludeOrderSubmissionId: o.id, onlyBefore: true,
    });
    repurchaseBlocked = !!(r && r.blocked);
  }

  let onePerPersonBlocked = false;
  if (validPhone && registered && camp.multi_account_mode !== true) {
    const { loadVerifiedOwnerPhones } = require('./directPurchaseParticipation.service');
    const others = (await loadVerifiedOwnerPhones(db, { ownerPhone8: ownerP8, ownerReviewerId: ownerId })).filter(x => x !== p8);
    for (const other of others) {
      const r = await guard.checkRepurchaseConflictAt(db, {
        sheetId: o.sheet_id, tabName: o.tab_name, campaignId: camp.id, phone8: other, days: camp.repurchase_days,
        targetSubmittedAt: o.submitted_at, excludeOrderSubmissionId: o.id, onlyBefore: true,
      });
      // 다른 명의의 **이전** 참여·구매만 이 구매의 위반이다(뒤에 온 것은 그 구매 쪽에서 판정된다)
      if (r && r.blocked) { onePerPersonBlocked = true; break; }
    }
  }

  let popularCredits = null;
  if (camp.is_popular === true && validPhone) {
    const { loadPopularCreditState } = require('./popularCredit.service');
    const st = await loadPopularCreditState(db, p8, { evaluatedAt: new Date(at.getTime() - 1) });
    popularCredits = Number(st && st.credits) || 0;
  }

  let todayBefore = 0;
  if (validPhone) {
    const dayStart = _kstDayStart(at);
    const { rows } = await db.query(
      `SELECT (SELECT COUNT(*) FROM campaign_applications ca
                WHERE ca.phone8 = $1 AND ca.status = 'submitted' AND ca.submitted_at >= $2 AND ca.submitted_at < $3)
            + (SELECT COUNT(*) FROM order_submissions os
                WHERE os.campaign_application_id IS NULL AND os.deleted_at IS NULL AND os.id <> $4::uuid
                  AND os.submitted_at >= $2 AND os.submitted_at < $3 AND ${OS_PHONE8} = $1
                  -- 참여 버튼의 하루 상한과 같은 셈(결정 238 countDirectPurchasesSince): 참여형 공고가 연결된 작업표의 구매만
                  AND EXISTS (SELECT 1 FROM recruit_campaigns rc2 WHERE rc2.participation_mode IS TRUE
                               AND rc2.linked_sheet_id = os.sheet_id AND rc2.linked_tab_name = os.tab_name)) AS n`,
      [p8, dayStart, at, o.id]);
    todayBefore = Number(rows[0] && rows[0].n) || 0;
  }

  const optionFull = await optionFullAtPurchase(db, camp.id, o);

  const flags = collectFlags({
    registered: validPhone ? registered : false,
    repurchaseBlocked, onePerPersonBlocked,
    popular: camp.is_popular === true,
    popularCredits: validPhone ? popularCredits : 0,
    todayBefore, dailyCap: _dailyCap(), optionFull,
  });
  // 어느 공고 기준으로 판정했는지 함께 남긴다 — 작업표를 다시 쓰는 옛 공고 카드·목록에 새 공고 기준 위반이 보이지 않게(Codex PR #1628).
  await db.query('UPDATE order_submissions SET rule_flags = $2::jsonb WHERE id = $1::uuid AND campaign_application_id IS NULL',
    [o.id, JSON.stringify({ campaignId: camp.id, flags })]);
  return { judged: true, flags, campaignId: camp.id };
}

/** 응답 뒤에 돌린다 — 실패는 로그만(접수와 무관). */
function judgeLater(orderSubmissionId, tag = '') {
  if (!orderSubmissionId || process.env.DIRECT_PURCHASE_RULE_FLAGS === '0') return;
  setImmediate(() => {
    const pool = require('../db/pool');
    judgeDirectPurchase(pool, orderSubmissionId)
      .then(r => { if (r && r.judged && r.flags.length) logger.info(`[directRules] ${tag} os=${orderSubmissionId} 위반 ${r.flags.map(f => f.code).join(',')}`); })
      .catch(e => logger.warn(`[directRules] ${tag} 판정 실패(표시 없음) os=${orderSubmissionId}: ${e.message}`));
  });
}

module.exports = { RULE_LABELS, collectFlags, optionFullAtPurchase, judgeDirectPurchase, judgeLater };
