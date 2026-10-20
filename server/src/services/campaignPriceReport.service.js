/**
 * campaignPriceReport.service.js — 리뷰어 가격 신고 + 관리자 전원 팝업 + 금액 수정 이력 (결정 266 · 사용자 확정 2026-10-20)
 *
 * 사용자 확정:
 *   ① 신고 통로 = 취소 사유 "화면과 가격이 달라요"(리뷰어 화면 무접촉 — 새 버튼 없음).
 *   ② **다른 리뷰어 2명**이 신고하면 관리자 전원(마스터·관리자·AE)에게 팝업 — 1명은 작업조건 카드에 "신고 1명"만.
 *   ③ 금액은 **리뷰웹 모집공고에서만** 고친다(인트라넷 리뷰오더 무접촉) · 처리 결과(고침/그대로/보류)를 이력으로 남긴다.
 *
 * ★ 자동으로 아무것도 바꾸지 않는다 — 품절과 달리 "얼마가 맞는지"는 사람만 안다. 신고 2명 = 알림만.
 * ★ 품절(campaignOptionPause)과 표·통로를 나눈다 — 품절 멈춤/다시 열기는 상품의 열린 품절 알림을 전부 닫는다.
 *   같은 표면 품절 처리 한 번에 가격 알림이 조용히 닫힌다. 상품 판정(_resolveOrderTarget)만 품절 것을 그대로 쓴다(사본 0).
 * ★★ 금액 쓰기 규칙은 인트라넷 → 공고 금액 전파(campaignPayAmountSync · 결정 161)와 같다(완화 금지 규율 그대로):
 *   ㉮ 상품을 나눈 공고 → campaign_options.pay_amount(그 상품 한 칸)
 *   ㉯ 나누지 않은 공고 → work_detail.payAmount + productLines 글자 안 「결제금액 N원」(리뷰어 화면은 글자를 먼저 읽는다)
 *      ★ 글자 안 금액이 2종 이상이면 고치지 않는다(fail-closed) — 어느 글자를 바꿀지 근거가 없다 → 모집공고 수정으로 안내.
 *   ★ 1건당 금액만 다룬다 — 합계(work_orders.pay_amount)는 읽지도 쓰지도 않는다.
 * ★ 이미 참여한 사람의 결제금액(order_submissions.price)·리뷰비 스냅샷·입금 금액은 건드리지 않는다.
 * ★ 잠금 순서 = 공고 행 → 상품 행(품절과 같다) · 신고 처리는 취소 커밋 **뒤** 후처리(실패해도 취소는 유효).
 * ★ 알려진 한계: 인트라넷에서 그 리뷰오더의 상품 정보를 고치면 금액 전파(결정 161)가 리뷰웹에서 고친 금액을 덮는다(사용자 확정 — 리뷰웹에서만 고친다).
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const ALERT_REPORTERS = 2;           // 사용자 확정 2번 (나) — 다른 리뷰어 2명부터 팝업
const MAX_AMOUNT = 10000000;         // 1건당 1천만원 미만 — 합계를 잘못 넣는 실수(9,324만원 사고)를 막는 상한
const HISTORY_LIMIT = 5;
// 끄는 스위치 — 신고 세기·알림을 끈다(이미 고친 금액은 그대로). 금액 고치기는 열린 알림이 없으면 일어나지 않는다.
const ENABLED = process.env.CAMPAIGN_PRICE_REPORT !== '0';

function _emit(payload) {
  try {
    const { broadcast } = require('../utils/sse');
    // ★ 리뷰어·광고주에게는 가지 않는다 — 품절 알림과 같은 대상(관리자 대시보드·리뷰웹시스템 연결)만.
    //   이름·번호·상품명 없이 "알림이 바뀌었다"만 싣는다 — 내용은 화면이 권한 검사를 거쳐 다시 받는다.
    broadcast('price_alert', { message: '가격 신고 알림', ...payload }, (c) => {
      const role = c && c.meta && c.meta.role;
      return role === 'admin' || role === 'workdesk';
    });
  } catch (e) { logger.warn(`[price-report] 실시간 알림 실패(무시): ${(e && e.message) || e}`); }
}

function _sync() { return require('./campaignPayAmountSync.service'); }

function _parseWd(v) {
  let wd = v;
  if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
  return wd && typeof wd === 'object' && !Array.isArray(wd) ? wd : null;
}

/** 공고 전체(상품을 나누지 않은 공고)의 지금 금액 — work_detail 글자 우선. */
function _wholePrice(wd) {
  if (!wd) return { amount: null, editable: false, why: 'no_work_detail' };
  const amounts = _sync().distinctAmountsInText(wd.productLines);
  if (amounts.length > 1) return { amount: null, editable: false, why: 'multiple_amounts', amounts };
  const amount = amounts.length ? amounts[0] : (Number(wd.payAmount) > 0 ? Number(wd.payAmount) : null);
  return { amount, editable: true };
}

/**
 * 지금 공고 금액(1건당)과 팝업에서 고칠 수 있는지.
 * @returns {{amount:number|null, editable:boolean, why?:string, gone?:boolean}}
 */
async function _currentPrice(db, campaignId, optKey) {
  const { rows: camp } = await db.query(
    `SELECT work_detail, archived_at,
            EXISTS (SELECT 1 FROM campaign_options lo WHERE lo.campaign_id = rc.id AND COALESCE(lo.status,'active') <> 'closed') AS has_live
       FROM recruit_campaigns rc WHERE rc.id = $1`, [campaignId]);
  if (!camp.length || camp[0].archived_at) return { amount: null, editable: false, gone: true };
  const wd = _parseWd(camp[0].work_detail);
  if (optKey === '') {
    // ★ 그사이 상품이 생긴 공고는 리뷰어가 상품별 금액을 본다 — 공고 전체 금액을 고쳐도 화면이 안 바뀐다(막다른 길) → 공고 수정으로.
    if (camp[0].has_live) return { amount: null, editable: false, why: 'has_options' };
    return _wholePrice(wd);
  }
  const { rows: opt } = await db.query(
    `SELECT pay_amount, status FROM campaign_options WHERE campaign_id = $1 AND opt_key = $2`, [campaignId, optKey]);
  if (!opt.length || String(opt[0].status || 'active') === 'closed') return { amount: null, editable: false, gone: true };
  const own = Number(opt[0].pay_amount) || 0;
  // 상품 금액 0 = 공고 공통 금액을 쓴다(061) — 지금 리뷰어가 보는 값은 공고 글의 금액이다. 고치면 이 상품에 금액을 적는다.
  return { amount: own > 0 ? own : _wholePrice(wd).amount, editable: true };
}

/** 열린 알림을 만들거나 신고 수를 올린다(같은 상품엔 하나). */
async function _upsertAlert(db, campaignId, optKey, reportCount) {
  const { rows } = await db.query(
    `INSERT INTO campaign_price_alerts (campaign_id, opt_key, report_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id, opt_key) WHERE resolved_at IS NULL
     DO UPDATE SET report_count = GREATEST(campaign_price_alerts.report_count, EXCLUDED.report_count), updated_at = NOW()
     RETURNING id`, [campaignId, optKey, reportCount]);
  return rows[0] || null;
}

/**
 * 리뷰어 가격 신고(취소 사유 price) — 커밋된 취소의 후처리. 예외를 던지지 않는다.
 * @returns {{ok:boolean, action:'reported'|'alerted'|'duplicate'|'unknown_option'|'no_campaign'|'disabled'|'error', reporters?:number}}
 */
async function recordPriceReport({ orderSubmissionId, phone8 = '', pool: dbPool } = {}) {
  if (!ENABLED || !orderSubmissionId) return { ok: false, action: 'disabled' };
  const db = dbPool || pool;
  let client;
  try {
    // 상품 판정 = 품절 신고와 같은 함수(신청 기록 → 주문의 옛 이름 → 하나뿐이면 그것 → 모르면 짐작하지 않는다)
    const tgt = await require('./campaignOptionPause.service')._resolveOrderTarget(db, orderSubmissionId);
    if (!tgt) return { ok: false, action: 'no_campaign' };
    if (tgt.optKey === null) {
      logger.warn(`[price-report] 가격 신고 상품 판정 불가(세지 않음) order=${orderSubmissionId} camp=${tgt.campaignId}`);
      return { ok: false, action: 'unknown_option' };
    }
    client = await db.connect();
    await client.query('BEGIN');
    // ★ 공고 행 먼저 잠근다 — 같은 상품에 신고 두 건이 동시에 와도 알림은 하나다.
    const { rows: camp } = await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [tgt.campaignId]);
    if (!camp.length) { await client.query('ROLLBACK'); return { ok: false, action: 'no_campaign' }; }
    // 이 리뷰어가 이미 세어진 사람인가(같은 사람의 두 번째 주문은 사람 수를 늘리지 않는다)
    const who8 = String(phone8 || '').slice(-8);
    const seen = who8 ? (await client.query(
      `SELECT 1 FROM campaign_price_reports WHERE campaign_id = $1 AND opt_key = $2 AND cleared_at IS NULL AND reporter = $3 LIMIT 1`,
      [tgt.campaignId, tgt.optKey, who8])).rows.length > 0 : false;
    const ins = await client.query(
      `INSERT INTO campaign_price_reports (campaign_id, opt_key, order_submission_id, reporter)
       VALUES ($1, $2, $3, $4) ON CONFLICT (order_submission_id) DO NOTHING RETURNING id`,
      [tgt.campaignId, tgt.optKey, String(orderSubmissionId), who8]);
    if (!ins.rows.length) { await client.query('ROLLBACK'); return { ok: true, action: 'duplicate' }; }
    // 같은 리뷰어(번호 끝 8자리)는 한 명 · 번호를 모르는 신고는 주문마다 한 명(모르는 것을 같은 사람으로 접지 않는다)
    const { rows: cnt } = await client.query(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(reporter, ''), 'order:' || order_submission_id)) AS who
         FROM campaign_price_reports
        WHERE campaign_id = $1 AND opt_key = $2 AND cleared_at IS NULL`, [tgt.campaignId, tgt.optKey]);
    const reporters = Number(cnt[0].who) || 0;
    let alert = null;
    if (reporters >= ALERT_REPORTERS) {
      // ★ 코드리뷰 P2: [결정 보류]로 닫은 뒤에는 **새 리뷰어**가 신고해야 다시 띄운다 — 이미 센 사람이 또 취소해도
      //   "한 명이 더 신고하면 다시 뜬다"는 약속과 달리 같은 2명으로 다시 뜨면 안 된다. 열린 알림이 있으면 수만 맞춘다.
      const { rows: openA } = await client.query(
        `SELECT 1 FROM campaign_price_alerts WHERE campaign_id = $1 AND opt_key = $2 AND resolved_at IS NULL`, [tgt.campaignId, tgt.optKey]);
      if (openA.length || !seen) alert = await _upsertAlert(client, tgt.campaignId, tgt.optKey, reporters);
    }
    await client.query('COMMIT');
    logger.info(`[price-report] 가격 신고 camp=${tgt.campaignId} opt=${tgt.optKey || '-'} 신고자=${reporters}${alert ? ` → 알림 ${alert.id}` : ''}`);
    if (alert) _emit({ alertId: alert.id, kind: 'report', campaignId: tgt.campaignId });
    return { ok: true, action: alert ? 'alerted' : 'reported', reporters };
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* noop */ } }
    logger.warn(`[price-report] 가격 신고 처리 실패(취소는 유효): ${(e && e.message) || e}`);
    return { ok: false, action: 'error' };
  } finally {
    if (client) client.release();
  }
}

/**
 * 열린 알림 목록(관리자 전원 공용). 공고·상품이 사라졌거나 마감·보관된 알림은 정리한다.
 * @returns {{ok:true, items:Array}}
 */
async function listOpenAlerts({ pool: dbPool } = {}) {
  if (!ENABLED) return { ok: true, items: [], disabled: true };
  const db = dbPool || pool;
  const { rows } = await db.query(
    `SELECT a.id, a.campaign_id, a.opt_key, a.report_count, a.created_at, a.updated_at,
            rc.title, rc.thumbnail_url, rc.manager, rc.linked_tab_name, co.thumbnail_url AS opt_thumb
       FROM campaign_price_alerts a
       LEFT JOIN recruit_campaigns rc ON rc.id = a.campaign_id
       LEFT JOIN campaign_options co ON co.campaign_id = a.campaign_id AND co.opt_key = a.opt_key AND a.opt_key <> ''
      WHERE a.resolved_at IS NULL
      ORDER BY a.created_at DESC
      LIMIT 50`);
  const gone = [];
  const items = [];
  for (const r of rows) {
    const cur = r.title ? await _currentPrice(db, r.campaign_id, r.opt_key) : { gone: true };
    if (cur.gone) { gone.push(r.id); continue; }
    items.push({
      id: Number(r.id), campaignId: String(r.campaign_id), optKey: r.opt_key, hasOptions: r.opt_key !== '',
      reportCount: Number(r.report_count) || 0, createdAt: r.created_at, updatedAt: r.updated_at,
      title: r.title || '', thumbnailUrl: r.opt_thumb || r.thumbnail_url || '', manager: r.manager || '',
      tabName: r.linked_tab_name || '',
      currentAmount: cur.amount == null ? null : Number(cur.amount),
      editable: !!cur.editable, notEditableWhy: cur.editable ? '' : (cur.why || ''),
    });
  }
  if (gone.length) _closeGone(db, gone).catch(() => {});
  return { ok: true, items };
}

/**
 * 공고·상품이 사라졌거나 마감·보관된 알림을 닫고 **그 상품의 쌓인 신고도 정리**한다(코드리뷰 P2) —
 * 신고만 남으면 카드에 계속 "신고 N명"이 보이고, 같은 이름으로 다시 열었을 때 옛 신고까지 센다.
 */
async function _closeGone(db, ids) {
  const { rows } = await db.query(
    `UPDATE campaign_price_alerts SET resolved_at = NOW(), resolved_by = 'system', resolution = 'gone', updated_at = NOW()
      WHERE id = ANY($1::bigint[]) AND resolved_at IS NULL RETURNING campaign_id, opt_key`, [ids]);
  for (const r of rows) {
    await db.query(`UPDATE campaign_price_reports SET cleared_at = NOW() WHERE campaign_id = $1 AND opt_key = $2 AND cleared_at IS NULL`, [r.campaign_id, r.opt_key]);
  }
}

/** 금액 쓰기 — 호출자가 공고 행을 잠근 트랜잭션 안에서 부른다(잠금 순서: 공고 → 상품). */
async function _writePriceInTx(client, cid, optKey, amount) {
  if (optKey !== '') {
    const r = await client.query(
      `UPDATE campaign_options SET pay_amount = $3, updated_at = NOW()
        WHERE campaign_id = $1 AND opt_key = $2 AND COALESCE(status,'active') <> 'closed' RETURNING id`, [cid, optKey, amount]);
    if (!r.rows.length) return { ok: false, code: 409, error: '상품이 마감됐거나 사라졌어요. 새로고침 후 다시 확인해주세요.' };
    // ★ 실측(2026-10-21): 리뷰어 공고 화면은 선택 상품 금액과 함께 안내 글(상품별 「결제금액 N원」 줄)도 보여 준다 —
    //   그 상품 줄도 같이 고친다(안 고치면 한 화면에 8,500원·9,190원이 같이 뜬다). 규칙은 인트라넷 금액 전파와 같은 함수.
    const { rows: wr } = await client.query('SELECT work_detail FROM recruit_campaigns WHERE id = $1', [cid]);
    const wdo = _parseWd(wr[0] && wr[0].work_detail);
    if (wdo) {
      const before = String(wdo.productLines == null ? '' : wdo.productLines);
      const after = _sync().replaceOptionAmountInProductLines(before, optKey, amount);
      if (after !== before) {
        await client.query('UPDATE recruit_campaigns SET work_detail = $2::jsonb, updated_at = NOW() WHERE id = $1',
          [cid, JSON.stringify(Object.assign({}, wdo, { productLines: after }))]);
      }
    }
    return { ok: true };
  }
  const { rows } = await client.query('SELECT work_detail FROM recruit_campaigns WHERE id = $1', [cid]);
  const wd = _parseWd(rows[0] && rows[0].work_detail);
  if (!wd) return { ok: false, code: 409, error: '공고 내용을 읽지 못했어요. 모집공고 수정에서 고쳐 주세요.' };
  const lines = String(wd.productLines == null ? '' : wd.productLines);
  const inText = _sync().distinctAmountsInText(lines);
  if (inText.length > 1) return { ok: false, code: 409, error: '공고 글에 금액이 여러 개라 여기서 고칠 수 없어요. 모집공고 수정에서 고쳐 주세요.' };
  const nextWd = Object.assign({}, wd, {
    payAmount: amount,
    productLines: inText.length === 1 ? _sync().replaceAmountInProductLines(lines, amount) : lines,
  });
  await client.query('UPDATE recruit_campaigns SET work_detail = $2::jsonb, updated_at = NOW() WHERE id = $1', [cid, JSON.stringify(nextWd)]);
  return { ok: true };
}

/**
 * 알림 처리. action:
 *   edit  — [금액 고치기] 공고 금액을 amount 로 바꾸고 신고 정리 · 이력 'edited'(전 → 후)
 *   keep  — [금액 맞음 — 그대로 두기] 신고 정리 · 이력 'kept'
 *   defer — [결정 보류] 알림만 닫는다 · **신고는 남긴다**(다음 신고 1건이면 다시 뜬다) · 이력 'deferred'
 * ★ 공고 행을 잠근 뒤 알림을 다시 읽는다 — 두 사람이 동시에 누르면 늦은 쪽은 "이미 처리됨 · 처리한 사람".
 */
async function resolveAlert({ id, action, amount, by = '', pool: dbPool } = {}) {
  const db = dbPool || pool;
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid <= 0) return { ok: false, code: 400, error: '잘못된 요청입니다.' };
  if (!['edit', 'keep', 'defer'].includes(action)) return { ok: false, code: 400, error: '잘못된 요청입니다.' };
  let next = null;
  if (action === 'edit') {
    // ★ 코드리뷰 P2: 끄는 스위치가 꺼져 있으면 금액을 바꾸지 않는다(남아 있던 팝업·직접 호출 포함). 그대로/보류는 받는다(알림 정리).
    if (!ENABLED) return { ok: false, code: 400, error: '지금은 가격 신고 기능이 꺼져 있어요. 금액은 모집공고 수정에서 고쳐 주세요.' };
    next = Number(amount);
    if (!Number.isInteger(next) || next <= 0 || next >= MAX_AMOUNT) {
      return { ok: false, code: 400, error: '금액은 1원부터 9,999,999원 사이의 숫자로 적어 주세요(1건당 금액).' };
    }
  }
  const who = String(by || '').slice(0, 100);
  const { rows: pre } = await db.query(`SELECT campaign_id FROM campaign_price_alerts WHERE id = $1`, [aid]);
  if (!pre.length) return { ok: false, code: 404, error: '알림을 찾을 수 없어요.' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [pre[0].campaign_id]);
    const { rows } = await client.query(
      `SELECT id, campaign_id, opt_key, resolved_at, resolved_by, resolution FROM campaign_price_alerts WHERE id = $1 FOR UPDATE`, [aid]);
    const a = rows[0];
    if (!a) { await client.query('ROLLBACK'); return { ok: false, code: 404, error: '알림을 찾을 수 없어요.' }; }
    if (a.resolved_at) { await client.query('ROLLBACK'); return { ok: true, already: true, resolvedBy: a.resolved_by || '', resolution: a.resolution || '' }; }
    const cid = String(a.campaign_id);
    const cur = await _currentPrice(client, cid, a.opt_key);
    if (cur.gone) {
      await _closeGone(client, [aid]);
      await client.query('COMMIT');
      _emit({ alertId: aid, kind: 'resolved', campaignId: cid });
      return { ok: false, code: 409, error: '공고나 상품이 마감·보관돼 알림을 닫았어요.' };
    }
    if (action === 'edit') {
      if (!cur.editable) {
        await client.query('ROLLBACK');
        return { ok: false, code: 409, error: cur.why === 'has_options'
          ? '그사이 상품이 나뉜 공고예요. 모집공고 수정에서 상품별 금액을 고쳐 주세요.'
          : '공고 글에 금액이 여러 개라 여기서 고칠 수 없어요. 모집공고 수정에서 고쳐 주세요.' };
      }
      if (cur.amount != null && Number(cur.amount) === next) {
        await client.query('ROLLBACK');
        return { ok: false, code: 400, error: '지금 금액과 같아요. 금액이 맞으면 [금액 맞음 — 그대로 두기]를 눌러 주세요.' };
      }
      const w = await _writePriceInTx(client, cid, a.opt_key, next);
      if (!w.ok) { await client.query('ROLLBACK'); return w; }
    }
    const resolution = action === 'edit' ? 'edited' : (action === 'keep' ? 'kept' : 'deferred');
    await client.query(
      `UPDATE campaign_price_alerts SET resolved_at = NOW(), resolved_by = $2, resolution = $3, old_amount = $4, new_amount = $5, updated_at = NOW()
        WHERE id = $1`, [aid, who, resolution, cur.amount == null ? null : Number(cur.amount), next]);
    if (action !== 'defer') {
      // 고쳤거나 맞다고 판단했다 → 쌓인 신고를 정리한다(다음 가격 신고는 처음부터 센다)
      await client.query(
        `UPDATE campaign_price_reports SET cleared_at = NOW() WHERE campaign_id = $1 AND opt_key = $2 AND cleared_at IS NULL`, [cid, a.opt_key]);
    }
    if (action === 'edit') {
      // 공고 활동 기록 — 실패가 금액 수정을 되돌리지 않게 SAVEPOINT 로 격리
      await client.query('SAVEPOINT price_edit_log');
      try {
        await client.query(
          `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)`,
          [cid, who, 'price_edited', JSON.stringify({ optKey: a.opt_key, from: cur.amount, to: next, via: 'price_report' })]);
        await client.query('RELEASE SAVEPOINT price_edit_log');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT price_edit_log');
        logger.warn(`[price-report] 기록 실패(금액 수정은 유효): ${(e && e.message) || e}`);
      }
    }
    await client.query('COMMIT');
    _emit({ alertId: aid, kind: 'resolved', campaignId: cid });
    logger.info(`[price-report] 알림 처리 id=${aid} ${resolution} camp=${cid} opt=${a.opt_key || '-'} ${cur.amount}→${next == null ? '-' : next} by=${who}`);
    return { ok: true, resolution, oldAmount: cur.amount, newAmount: next };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 작업조건 카드용 — 상품별 쌓인 가격 신고 수 + 최근 처리 이력. 실패 = null(카드는 그 줄을 그리지 않는다).
 * @returns {{open:Array<{optKey,reports}>, history:Array<{optKey,resolution,oldAmount,newAmount,by,at}>}|null}
 */
async function priceReportsForCampaign(db, campaignId) {
  if (!campaignId) return null;
  try {
    const q = db || pool;
    // ★ 살아 있는 상품(또는 상품이 없을 때 공고 전체)의 신고만 — 마감·삭제된 상품의 남은 신고를 카드에 띄우지 않는다
    const { rows: open } = await q.query(
      `SELECT r.opt_key, COUNT(DISTINCT COALESCE(NULLIF(r.reporter, ''), 'order:' || r.order_submission_id)) AS who
         FROM campaign_price_reports r
        WHERE r.campaign_id = $1 AND r.cleared_at IS NULL
          AND (EXISTS (SELECT 1 FROM campaign_options co WHERE co.campaign_id = r.campaign_id AND co.opt_key = r.opt_key AND COALESCE(co.status,'active') <> 'closed')
               OR (r.opt_key = '' AND NOT EXISTS (SELECT 1 FROM campaign_options lo WHERE lo.campaign_id = r.campaign_id AND COALESCE(lo.status,'active') <> 'closed')))
        GROUP BY r.opt_key ORDER BY r.opt_key`, [campaignId]);
    const { rows: hist } = await q.query(
      `SELECT opt_key, resolution, old_amount, new_amount, resolved_by, resolved_at
         FROM campaign_price_alerts
        WHERE campaign_id = $1 AND resolved_at IS NOT NULL AND resolution IN ('edited','kept','deferred')
        ORDER BY resolved_at DESC LIMIT ${HISTORY_LIMIT}`, [campaignId]);
    return {
      open: open.map(r => ({ optKey: r.opt_key, reports: Number(r.who) || 0 })).filter(r => r.reports > 0),
      history: hist.map(r => ({
        optKey: r.opt_key, resolution: r.resolution,
        oldAmount: r.old_amount == null ? null : Number(r.old_amount), newAmount: r.new_amount == null ? null : Number(r.new_amount),
        by: r.resolved_by || '', at: r.resolved_at,
      })),
    };
  } catch (e) {
    logger.warn(`[price-report] 가격 신고 이력 조회 실패(카드 줄 생략): ${(e && e.message) || e}`);
    return null;
  }
}

module.exports = {
  ALERT_REPORTERS,
  MAX_AMOUNT,
  ENABLED,
  recordPriceReport,
  listOpenAlerts,
  resolveAlert,
  priceReportsForCampaign,
  _currentPrice,
};
