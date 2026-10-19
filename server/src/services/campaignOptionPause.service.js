/**
 * campaignOptionPause.service.js — 상품 품절 일시 멈춤 + 리뷰어 품절 신고 + 관리자 전원 알림 (결정 229 · 사용자 확정 2026-10-12)
 *
 * 사용자 확정:
 *   ① 스토어 품절을 자동으로 읽을 수 없다(스마트스토어 robots.txt 가 모든 수집을 막는다) → **담당자가 누르는 [품절로 멈추기]**.
 *   ② 리뷰어가 "품절이라 구매하지 못했어요"로 취소하면 신고로 센다. **다른 리뷰어 2명**이면 그 상품을 자동으로 멈춘다(1명은 알림만).
 *   ③ 알림은 리뷰어를 뺀 **관리자 전원**(마스터·관리자·AE) — 접속 중이면 바로(실시간 통로), 나중에 접속하면 처리될 때까지.
 *      한 사람이 처리하면 모두에게서 사라진다.
 *
 * ★★ 멈춤은 상태(status)와 **따로** 둔다(paused_at) — status 에 넣으면 공고 수정 창이 active/closed 만 저장해 멈춤이 풀린다.
 * ★★ 멈춘 상품은 "마감"이 아니다 — 공고가 상품을 고르는 공고라는 판정(liveOptions)은 그대로라, 상품이 전부 멈춰도
 *    상품 없이 참여되는 구멍이 생기지 않는다. 판정 단일 출처 = campaignState.computeOptionView(멈춤 = 고를 수 없음).
 * ★ 하루 인원·앞날 예상·작업표는 건드리지 않는다(일시 멈춤 — 다시 열면 그대로 이어진다). 순차진행은 멈춘 상품도 자기 날짜를 차지한다.
 * ★ 잠금 순서 = 공고 행 → 상품 행(180/184 트리거가 공고 행을 고친다 — 순서를 뒤집으면 공고 저장과 교착).
 * ★ 신고 처리는 취소가 끝난 **뒤** 후처리 — 실패해도 취소를 되돌리지 않는다(이미 끝난 일).
 *
 * ★★ 결정 259(사용자 확정 2026-10-19): **상품을 나누지 않은 공고도 멈춘다** — 상품 이름 '' = 공고 전체(WHOLE).
 *   멈춤 칸은 공고 행(recruit_campaigns.soldout_paused_*)에 있다 · 신고·알림 원장은 184 표 그대로(opt_key '').
 *   - 멈춤은 **참여 게이트에서만** 막는다(campaign.routes apply) — 상태 엔진(computeCampaignState)·하루 인원·앞날 예상은
 *     건드리지 않는다(상품 멈춤과 같은 규율 · 그 판정을 읽는 18곳이 흔들리지 않게).
 *   - [품절로 멈추기]는 살아 있는 상품이 없는 공고에서만 받는다(상품이 있으면 상품별로 멈춘다).
 *     ★ [다시 열기]는 언제나 받는다 — 멈춘 뒤 상품이 생겨도 풀 길이 사라지지 않게(카드도 그 줄을 계속 그린다).
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const AUTO_PAUSE_REPORTERS = 2;      // 사용자 확정 (나) — 다른 리뷰어 2명
const WHOLE = '';                    // 결정 259: 상품 이름 '' = 공고 전체(상품을 나누지 않은 공고)
// 끄는 스위치 — 신고·알림·멈추기를 끈다. 판정(campaignState.computeOptionView)도 같은 환경변수로 멈춤을 무시한다(= 전부 다시 열림).
// 다시 열기는 꺼져 있어도 허용한다(코드리뷰 P1).
const ENABLED = process.env.CAMPAIGN_OPTION_PAUSE !== '0';

function _emit(payload) {
  try {
    const { broadcast } = require('../utils/sse');
    // ★ 리뷰어·광고주에게는 가지 않는다 — 관리자 대시보드(admin)·리뷰웹시스템(workdesk = 내부 직원만 연결 가능) 연결만.
    //   이름·번호 없이 "알림이 바뀌었다"만 싣는다 — 내용은 화면이 권한 검사를 거쳐 다시 받는다.
    broadcast('option_alert', { message: '상품 품절 알림', ...payload }, (c) => {
      const role = c && c.meta && c.meta.role;
      return role === 'admin' || role === 'workdesk';
    });
  } catch (e) { logger.warn(`[option-pause] 실시간 알림 실패(무시): ${(e && e.message) || e}`); }
}

/** 취소된 주문 → {campaignId, optKey}. 신청 기록이 이름 바꾸기를 따라가므로 그쪽을 먼저 본다(주문의 옛 이름은 마지막). */
async function _resolveOrderTarget(db, orderSubmissionId) {
  const { rows } = await db.query(
    `SELECT COALESCE(NULLIF(substring(os.sheet_id from '^campaign:(.+)$'), ''), ca.campaign_id) AS campaign_id,
            app_opt.option_key AS app_key, os.selected_opt_key AS sel_key
       FROM order_submissions os
       LEFT JOIN campaign_applications ca ON ca.id = os.campaign_application_id
       LEFT JOIN LATERAL (
         SELECT app.option_key FROM campaign_applications app
          WHERE app.id = os.campaign_application_id OR app.order_submission_id = os.id
          ORDER BY (app.id = os.campaign_application_id) DESC, app.applied_at DESC NULLS LAST
          LIMIT 1
       ) app_opt ON TRUE
      WHERE os.id::text = $1
      LIMIT 1`, [String(orderSubmissionId)]);
  const r = rows[0];
  if (!r || !r.campaign_id) return null;
  // ★ 마감 상품까지 전부 읽는다(코드리뷰 P1) — 살아 있는 것만 읽으면 리뷰어 상품이 마감돼 목록에 없을 때
  //   "하나뿐이면 그것" 규칙으로 **남은 다른 상품**을 멈춘다.
  const { rows: opts } = await db.query(
    `SELECT opt_key, status FROM campaign_options WHERE campaign_id = $1`, [r.campaign_id]);
  const cid = String(r.campaign_id);
  if (!opts.length) return { campaignId: cid, optKey: '' };   // 상품을 나누지 않은 공고 — 알림만
  const byKey = new Map(opts.map(o => [o.opt_key, o]));
  const given = [r.app_key, r.sel_key].filter(Boolean);
  const k = given.find(x => byKey.has(x));
  if (k) return { campaignId: cid, optKey: String(byKey.get(k).status || 'active') === 'closed' ? null : k };   // 마감 상품 = 멈출 것 없음
  // 상품이 정말 하나뿐인 공고에서만, 그리고 주문·신청에 상품 이름이 **전혀 없을 때만** 그 상품으로 본다
  if (!given.length && opts.length === 1 && String(opts[0].status || 'active') !== 'closed') return { campaignId: cid, optKey: opts[0].opt_key };
  return { campaignId: cid, optKey: null };   // ★ 어느 상품인지 모른다 → 멈추지 않는다(알림도 짐작하지 않는다)
}

/** 열린 알림을 만들거나 올린다(같은 상품엔 하나). kind 는 낮은 단계로 내려가지 않는다. */
async function _upsertAlert(db, campaignId, optKey, kind, reportCount) {
  const { rows } = await db.query(
    `INSERT INTO campaign_option_alerts (campaign_id, opt_key, kind, report_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (campaign_id, opt_key) WHERE resolved_at IS NULL
     DO UPDATE SET kind = CASE WHEN campaign_option_alerts.kind = 'auto_paused' THEN 'auto_paused' ELSE EXCLUDED.kind END,
                   report_count = GREATEST(campaign_option_alerts.report_count, EXCLUDED.report_count),
                   updated_at = NOW()
     RETURNING id, kind`, [campaignId, optKey, kind, reportCount]);
  return rows[0] || null;
}

/**
 * 리뷰어 품절 신고(취소 사유 soldout) 처리 — 커밋된 취소의 후처리. 실패해도 예외를 던지지 않는다.
 * @returns {{ok:boolean, action?:'reported'|'auto_paused'|'already_paused'|'unknown_option'|'duplicate', reporters?:number}}
 */
async function recordSoldoutReport({ orderSubmissionId, phone8 = '', pool: dbPool } = {}) {
  if (!ENABLED || !orderSubmissionId) return { ok: false, action: 'disabled' };
  const db = dbPool || pool;
  let client;
  try {
    const tgt = await _resolveOrderTarget(db, orderSubmissionId);
    if (!tgt) return { ok: false, action: 'no_campaign' };
    if (tgt.optKey === null) {
      logger.warn(`[option-pause] 품절 신고 상품 판정 불가(멈추지 않음) order=${orderSubmissionId} camp=${tgt.campaignId}`);
      return { ok: false, action: 'unknown_option' };
    }
    client = await db.connect();
    await client.query('BEGIN');
    // ★ 공고 행 먼저 잠근다 — 같은 상품에 신고 두 건이 동시에 와도 한 번만 멈추고 알림도 하나다.
    const { rows: camp } = await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [tgt.campaignId]);
    if (!camp.length) { await client.query('ROLLBACK'); return { ok: false, action: 'no_campaign' }; }
    const ins = await client.query(
      `INSERT INTO campaign_option_soldout_reports (campaign_id, opt_key, order_submission_id, reporter)
       VALUES ($1, $2, $3, $4) ON CONFLICT (order_submission_id) DO NOTHING RETURNING id`,
      [tgt.campaignId, tgt.optKey, String(orderSubmissionId), String(phone8 || '').slice(-8)]);
    if (!ins.rows.length) { await client.query('ROLLBACK'); return { ok: true, action: 'duplicate' }; }
    const { rows: cnt } = await client.query(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(reporter, ''), 'order:' || order_submission_id)) AS who
         FROM campaign_option_soldout_reports
        WHERE campaign_id = $1 AND opt_key = $2 AND cleared_at IS NULL`, [tgt.campaignId, tgt.optKey]);
    // 같은 리뷰어(번호 끝 8자리)의 신고는 한 명으로 센다 · 번호를 모르는 신고는 주문마다 한 명(모르는 것을 같은 사람으로 접지 않는다)
    const reporters = Number(cnt[0].who) || 0;
    let action = 'reported';
    // ★ 코드리뷰 P2: 이미 멈춘 상품(손으로 멈춤 포함)이면 신고 수와 무관하게 다시 알리지 않는다 — 신고는 쌓아 둔다
    //   ★ 결정 259: 상품을 나누지 않은 공고(optKey '')는 공고 행의 멈춤 칸을 본다.
    const pausedNow = tgt.optKey === WHOLE
      ? (await client.query(
        `SELECT 1 FROM recruit_campaigns WHERE id = $1 AND soldout_paused_at IS NOT NULL`, [tgt.campaignId])).rows.length > 0
      : (await client.query(
        `SELECT 1 FROM campaign_options WHERE campaign_id = $1 AND opt_key = $2 AND paused_at IS NOT NULL`, [tgt.campaignId, tgt.optKey])).rows.length > 0;
    if (pausedNow) action = 'already_paused';
    else if (reporters >= AUTO_PAUSE_REPORTERS) {
      const up = tgt.optKey === WHOLE
        ? await _pauseWholeRow(client, tgt.campaignId, 'auto_soldout', 'system:soldout-report')
        : await client.query(
          `UPDATE campaign_options SET paused_at = NOW(), paused_reason = 'auto_soldout', paused_by = 'system:soldout-report', updated_at = NOW()
            WHERE campaign_id = $1 AND opt_key = $2 AND paused_at IS NULL AND COALESCE(status,'active') <> 'closed'
            RETURNING id`, [tgt.campaignId, tgt.optKey]);
      action = up.rows.length ? 'auto_paused' : 'already_paused';
    }
    // 이미 멈춰 있는 상품에 들어온 신고는 새 알림을 띄우지 않는다(멈춘 걸 다시 알릴 일이 없다 — 다시 열 때 신고는 정리된다).
    let alert = null;
    if (action !== 'already_paused') {
      alert = await _upsertAlert(client, tgt.campaignId, tgt.optKey, action === 'auto_paused' ? 'auto_paused' : 'soldout_report', reporters);
    }
    await client.query('COMMIT');
    logger.info(`[option-pause] 품절 신고 camp=${tgt.campaignId} opt=${tgt.optKey || '-'} 신고자=${reporters} → ${action}`);
    if (alert) _emit({ alertId: alert.id, kind: alert.kind, campaignId: tgt.campaignId });
    return { ok: true, action, reporters };
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* noop */ } }
    logger.warn(`[option-pause] 품절 신고 처리 실패(취소는 유효): ${(e && e.message) || e}`);
    return { ok: false, action: 'error' };
  } finally {
    if (client) client.release();
  }
}

/**
 * 결정 259: 공고 전체 멈춤 쓰기(공고 행 — 호출자가 이미 잠갔다). 이미 멈춰 있으면 0행.
 * ★ 인원 규칙 변경 시각도 남긴다 — 멈춰서 못 채운 어제 인원을 "어제 부족" 팝업(결정 202)이 따로 묻지 않게(184 트리거와 같은 뜻).
 * ★ updated_at 은 건드리지 않는다(공고 수정 충돌 판정·동기화가 그 값을 본다 — 멈춤은 공고 설정 변경이 아니다).
 */
function _pauseWholeRow(client, cid, reason, who) {
  return client.query(
    `UPDATE recruit_campaigns SET soldout_paused_at = NOW(), soldout_paused_reason = $2, soldout_paused_by = $3, quota_rules_changed_at = NOW()
      WHERE id = $1 AND soldout_paused_at IS NULL RETURNING id`, [cid, reason, who]);
}

/** 결정 259: 살아 있는(마감 아닌) 상품이 있는 공고인가 — 있으면 공고 전체가 아니라 상품별로 멈춘다. */
async function _hasLiveOptions(db, cid) {
  const { rows } = await db.query(
    `SELECT 1 FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'closed' LIMIT 1`, [cid]);
  return rows.length > 0;
}

/** 결정 259: 공고 전체 멈춤·다시 열기 — _setPausedInTx 의 '' 갈래(같은 트랜잭션·같은 정리 규칙). */
async function _setWholePausedInTx(client, cid, op, who) {
  let changed = false;
  if (op === 'pause') {
    if (await _hasLiveOptions(client, cid)) {
      return { ok: false, code: 409, error: '상품을 나눈 공고예요. 상품별로 멈춰 주세요(새로고침하면 상품 줄이 보여요).' };
    }
    changed = (await _pauseWholeRow(client, cid, 'manual', who)).rows.length > 0;
  } else {
    const r = await client.query(
      `UPDATE recruit_campaigns SET soldout_paused_at = NULL, soldout_paused_reason = '', soldout_paused_by = '', quota_rules_changed_at = NOW()
        WHERE id = $1 AND soldout_paused_at IS NOT NULL RETURNING id`, [cid]);
    changed = r.rows.length > 0;
    await client.query(
      `UPDATE campaign_option_soldout_reports SET cleared_at = NOW() WHERE campaign_id = $1 AND opt_key = '' AND cleared_at IS NULL`, [cid]);
  }
  const a = await client.query(
    `UPDATE campaign_option_alerts SET resolved_at = NOW(), resolved_by = $2, resolution = $3, updated_at = NOW()
      WHERE campaign_id = $1 AND opt_key = '' AND resolved_at IS NULL`, [cid, who, op === 'pause' ? 'paused' : 'reopened']);
  if (changed) {
    await client.query('SAVEPOINT camp_pause_log');
    try {
      await client.query(
        `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)`,
        [cid, who, op === 'pause' ? 'campaign_paused' : 'campaign_resumed', JSON.stringify({ whole: true })]);
      await client.query('RELEASE SAVEPOINT camp_pause_log');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT camp_pause_log');
      logger.warn(`[option-pause] 기록 실패(멈춤은 유효): ${(e && e.message) || e}`);
    }
  }
  return { ok: true, changed, alertsClosed: a.rowCount || 0, paused: op === 'pause' };
}

/** 멈춤·다시 열기 본체 — 호출자가 공고 행을 잠근 트랜잭션 안에서 부른다(잠금 순서: 공고 → 상품). */
async function _setPausedInTx(client, cid, key, op, who) {
  if (key === WHOLE) return _setWholePausedInTx(client, cid, op, who);   // 결정 259
  const { rows: opt } = await client.query(
    `SELECT opt_key, status, paused_at FROM campaign_options WHERE campaign_id = $1 AND opt_key = $2 FOR UPDATE`, [cid, key]);
  if (!opt.length) return { ok: false, code: 404, error: '상품을 찾을 수 없어요. 새로고침 후 다시 확인해주세요.' };
  if (String(opt[0].status || 'active') === 'closed') {
    return { ok: false, code: 409, error: '마감된 상품이에요. 다시 받으려면 공고 수정에서 상품을 진행으로 바꿔주세요.' };
  }
  let changed = false, alertsClosed = 0;
  if (op === 'pause') {
    const r = await client.query(
      `UPDATE campaign_options SET paused_at = NOW(), paused_reason = 'manual', paused_by = $3, updated_at = NOW()
        WHERE campaign_id = $1 AND opt_key = $2 AND paused_at IS NULL RETURNING id`, [cid, key, who]);
    changed = r.rows.length > 0;
    const a = await client.query(
      `UPDATE campaign_option_alerts SET resolved_at = NOW(), resolved_by = $3, resolution = 'paused', updated_at = NOW()
        WHERE campaign_id = $1 AND opt_key = $2 AND resolved_at IS NULL`, [cid, key, who]);
    alertsClosed = a.rowCount || 0;
  } else {
    const r = await client.query(
      `UPDATE campaign_options SET paused_at = NULL, paused_reason = '', paused_by = '', updated_at = NOW()
        WHERE campaign_id = $1 AND opt_key = $2 AND paused_at IS NOT NULL RETURNING id`, [cid, key]);
    changed = r.rows.length > 0;
    await client.query(
      `UPDATE campaign_option_soldout_reports SET cleared_at = NOW() WHERE campaign_id = $1 AND opt_key = $2 AND cleared_at IS NULL`, [cid, key]);
    const a = await client.query(
      `UPDATE campaign_option_alerts SET resolved_at = NOW(), resolved_by = $3, resolution = 'reopened', updated_at = NOW()
        WHERE campaign_id = $1 AND opt_key = $2 AND resolved_at IS NULL`, [cid, key, who]);
    alertsClosed = a.rowCount || 0;
  }
  if (changed) {
    // 기록 실패가 멈춤 자체를 되돌리지 않게 SAVEPOINT 로 격리한다(실패한 문장이 tx 를 깨뜨리면 COMMIT 이 통째로 취소된다).
    await client.query('SAVEPOINT opt_pause_log');
    try {
      await client.query(
        `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)`,
        [cid, who, op === 'pause' ? 'option_paused' : 'option_resumed', JSON.stringify({ optKey: key })]);
      await client.query('RELEASE SAVEPOINT opt_pause_log');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT opt_pause_log');
      logger.warn(`[option-pause] 기록 실패(멈춤은 유효): ${(e && e.message) || e}`);
    }
  }
  return { ok: true, changed, alertsClosed, paused: op === 'pause' };
}

/**
 * 담당자가 상품을 멈추거나 다시 연다(작업보드 작업조건 카드).
 * @param {'pause'|'resume'} op
 * @param {boolean} whole 결정 259 — true 면 공고 전체(상품을 나누지 않은 공고). ★ 명시해야만 공고 전체다
 *   (상품 이름이 빠진 요청이 공고를 통째로 멈추지 않게 — 빈 이름은 종전처럼 거절).
 * ★ 다시 열면 그 상품의 쌓인 신고·열린 알림을 정리한다(다음 품절은 처음부터 다시 센다).
 * ★ 멈추면 그 상품의 열린 알림도 정리한다(담당자가 이미 판단했다).
 * ★ 끄는 스위치가 꺼져 있어도 **다시 열기는 허용**한다(코드리뷰 P1 — 이미 멈춘 상품을 풀 길이 사라지지 않게).
 */
async function setOptionPaused({ campaignId, optKey, op, whole = false, by = '', pool: dbPool } = {}) {
  if (!ENABLED && op !== 'resume') return { ok: false, code: 400, error: '지금은 품절 멈춤 기능이 꺼져 있어요.' };
  const cid = String(campaignId || '').trim();
  const key = whole === true ? WHOLE : String(optKey == null ? '' : optKey);
  if (!cid || (!key && whole !== true) || (op !== 'pause' && op !== 'resume')) return { ok: false, code: 400, error: '잘못된 요청입니다.' };
  const db = dbPool || pool;
  const who = String(by || '').slice(0, 100);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: camp } = await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [cid]);
    if (!camp.length) { await client.query('ROLLBACK'); return { ok: false, code: 404, error: '공고를 찾을 수 없어요.' }; }
    const out = await _setPausedInTx(client, cid, key, op, who);
    if (!out.ok) { await client.query('ROLLBACK'); return out; }
    await client.query('COMMIT');
    if (out.changed || out.alertsClosed) _emit({ campaignId: cid, kind: op === 'pause' ? 'paused' : 'resumed' });
    logger.info(`[option-pause] ${op} camp=${cid} opt=${key || '(공고 전체)'} by=${who} changed=${out.changed}`);
    return { ok: true, changed: out.changed, paused: out.paused };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 열린 알림 목록(관리자 전원 공용). 상품이 사라졌거나 마감된 알림은 정리한다(보여줄 대상이 없다).
 * @returns {{ok:true, items:Array}}
 */
async function listOpenAlerts({ pool: dbPool } = {}) {
  if (!ENABLED) return { ok: true, items: [], disabled: true };
  const db = dbPool || pool;
  const { rows } = await db.query(
    `SELECT a.id, a.campaign_id, a.opt_key, a.kind, a.report_count, a.created_at, a.updated_at,
            rc.title, rc.thumbnail_url, rc.manager, rc.linked_tab_name, rc.status AS camp_status, rc.archived_at,
            rc.soldout_paused_at, rc.soldout_paused_reason,
            (a.opt_key = '' AND EXISTS (SELECT 1 FROM campaign_options lo WHERE lo.campaign_id = a.campaign_id
                                          AND COALESCE(lo.status,'active') <> 'closed')) AS whole_has_live,
            co.status AS opt_status, co.paused_at, co.paused_reason, co.thumbnail_url AS opt_thumb,
            (co.id IS NOT NULL) AS opt_exists
       FROM campaign_option_alerts a
       LEFT JOIN recruit_campaigns rc ON rc.id = a.campaign_id
       LEFT JOIN campaign_options co ON co.campaign_id = a.campaign_id AND co.opt_key = a.opt_key AND a.opt_key <> ''
      WHERE a.resolved_at IS NULL
      ORDER BY a.created_at DESC
      LIMIT 50`);
  const gone = [];
  const items = [];
  for (const r of rows) {
    const vanished = !r.title || r.archived_at || (r.opt_key !== '' && (!r.opt_exists || String(r.opt_status || 'active') === 'closed'));
    if (vanished) { gone.push(r.id); continue; }
    items.push({
      id: Number(r.id), campaignId: String(r.campaign_id), optKey: r.opt_key, kind: r.kind,
      reportCount: Number(r.report_count) || 0, createdAt: r.created_at, updatedAt: r.updated_at,
      title: r.title || '', thumbnailUrl: r.opt_thumb || r.thumbnail_url || '', manager: r.manager || '',
      tabName: r.linked_tab_name || '', campaignActive: r.camp_status === 'active',
      paused: r.opt_key === '' ? !!r.soldout_paused_at : !!r.paused_at,
      pausedReason: (r.opt_key === '' ? r.soldout_paused_reason : r.paused_reason) || '',
      hasOptions: r.opt_key !== '',
      // ★ 결정 259: 상품을 나누지 않은 공고 = 공고 전체를 멈출 수 있다(화면이 [품절로 멈추기]/[다시 열기]를 그린다).
      //   그사이 상품이 생긴 공고는 공고 전체로 멈추지 않는다 → 종전 [확인했어요]. 옛 화면은 이 필드를 몰라 종전대로 [확인했어요].
      wholeCampaign: r.opt_key === '' && !r.whole_has_live,
    });
  }
  if (gone.length) {
    db.query(`UPDATE campaign_option_alerts SET resolved_at = NOW(), resolved_by = 'system', resolution = 'gone', updated_at = NOW()
               WHERE id = ANY($1::bigint[]) AND resolved_at IS NULL`, [gone]).catch(() => {});
  }
  return { ok: true, items };
}

/**
 * 알림 처리. action:
 *   reopen      — 다시 열기(멈춤 해제 + 신고 정리)        ← 자동 멈춤 알림
 *   keep        — 멈춘 채로 두기(알림만 닫기)             ← 자동 멈춤 알림
 *   pause       — [품절로 멈추기]                         ← 신고 알림
 *   not_soldout — 품절 아님(신고 정리 · 알림 닫기)        ← 신고 알림
 *   ack         — 확인(상품을 나누지 않은 공고 — 멈출 상품이 없다)
 * ★★ 코드리뷰 P1: 버튼은 **지금 알림 종류**에 맞아야 한다 — 화면이 늦게 갱신돼 "신고 1명" 화면에서 [품절 아님]을 눌렀는데
 *   그사이 두 번째 신고로 자동 멈춤이 됐으면, 알림만 닫히고 상품은 아무도 모르게 멈춘 채 남는다.
 *   공고 행을 잠근 뒤 다시 읽고(신고 처리와 줄 세움), 종류가 안 맞으면 "상황이 바뀌었어요"로 거절한다(changed=true → 화면이 다시 읽는다).
 */
const ACTIONS_BY_KIND = { soldout_report: ['pause', 'not_soldout'], auto_paused: ['reopen', 'keep'] };
async function resolveAlert({ id, action, by = '', pool: dbPool } = {}) {
  const db = dbPool || pool;
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid <= 0) return { ok: false, code: 400, error: '잘못된 요청입니다.' };
  if (!['reopen', 'keep', 'pause', 'not_soldout', 'ack'].includes(action)) return { ok: false, code: 400, error: '잘못된 요청입니다.' };
  const who = String(by || '').slice(0, 100);
  const { rows: pre } = await db.query(`SELECT campaign_id FROM campaign_option_alerts WHERE id = $1`, [aid]);
  if (!pre.length) return { ok: false, code: 404, error: '알림을 찾을 수 없어요.' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [pre[0].campaign_id]);
    const { rows } = await client.query(
      `SELECT id, campaign_id, opt_key, kind, resolved_at, resolved_by, resolution FROM campaign_option_alerts WHERE id = $1 FOR UPDATE`, [aid]);
    const a = rows[0];
    if (!a) { await client.query('ROLLBACK'); return { ok: false, code: 404, error: '알림을 찾을 수 없어요.' }; }
    if (a.resolved_at) { await client.query('ROLLBACK'); return { ok: true, already: true, resolvedBy: a.resolved_by || '', resolution: a.resolution || '' }; }
    // ★ 결정 259: 공고 전체 알림도 종류별 버튼을 받는다 · [확인했어요]는 옛 화면(배포 순간)을 위해 계속 받는다.
    const allowed = a.opt_key ? (ACTIONS_BY_KIND[a.kind] || []) : [...(ACTIONS_BY_KIND[a.kind] || []), 'ack'];
    if (!allowed.includes(action)) {
      await client.query('ROLLBACK');
      return { ok: false, code: 409, stale: true, error: a.kind === 'auto_paused'
        ? '그사이 신고가 더 들어와 자동으로 멈췄어요. 목록을 다시 확인해 주세요.' : '상황이 바뀌었어요. 목록을 다시 확인해 주세요.' };
    }
    let out = { ok: true, changed: false };
    if (action === 'reopen' || action === 'pause') {
      if (!ENABLED && action === 'pause') { await client.query('ROLLBACK'); return { ok: false, code: 400, error: '지금은 품절 멈춤 기능이 꺼져 있어요.' }; }
      out = await _setPausedInTx(client, String(a.campaign_id), a.opt_key, action === 'reopen' ? 'resume' : 'pause', who);
      if (!out.ok) { await client.query('ROLLBACK'); return out; }
      out = { ok: true, changed: true };
    } else {
      await client.query(
        `UPDATE campaign_option_alerts SET resolved_at = NOW(), resolved_by = $2, resolution = $3, updated_at = NOW() WHERE id = $1`,
        [aid, who, action === 'keep' ? 'kept_paused' : action]);
      if (action === 'not_soldout') {
        await client.query(
          `UPDATE campaign_option_soldout_reports SET cleared_at = NOW() WHERE campaign_id = $1 AND opt_key = $2 AND cleared_at IS NULL`,
          [a.campaign_id, a.opt_key]);
      }
      out = { ok: true, changed: true };
    }
    await client.query('COMMIT');
    _emit({ alertId: aid, kind: 'resolved', campaignId: String(a.campaign_id) });
    logger.info(`[option-pause] 알림 처리 id=${aid} ${action} camp=${a.campaign_id} opt=${a.opt_key || '-'} by=${who}`);
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 상품이 지워졌거나 마감된 뒤 남은 신고·알림 정리(코드리뷰 P2) — 공고 저장·상품 합치기 트랜잭션 안에서 부른다.
 * 안 하면 같은 이름으로 다시 열었을 때 옛 신고 1건이 살아 있어 새 신고 1건만으로 자동 멈춤되고,
 * 지운 상품의 열린 알림이 남아 다른 상품을 그 이름으로 바꿀 때 "알림은 상품마다 하나" 규칙에 걸려 저장이 실패한다.
 */
async function closeStaleForCampaign(client, campaignId) {
  const gone = `NOT EXISTS (SELECT 1 FROM campaign_options co WHERE co.campaign_id = x.campaign_id AND co.opt_key = x.opt_key
                             AND COALESCE(co.status,'active') <> 'closed')`;
  await client.query(
    `UPDATE campaign_option_alerts x SET resolved_at = NOW(), resolved_by = 'system', resolution = 'gone', updated_at = NOW()
      WHERE x.campaign_id = $1 AND x.resolved_at IS NULL AND x.opt_key <> '' AND ${gone}`, [campaignId]);
  await client.query(
    `UPDATE campaign_option_soldout_reports x SET cleared_at = NOW()
      WHERE x.campaign_id = $1 AND x.cleared_at IS NULL AND x.opt_key <> '' AND ${gone}`, [campaignId]);
}

/**
 * 작업조건 카드용 상품 판매 상태(살아 있는 상품만). 실패 = null(카드는 그 줄을 그리지 않는다).
 * ★ 결정 259: 살아 있는 상품이 없는 공고 — 또는 공고 전체가 멈춰 있는 공고 — 는 맨 앞에 **공고 전체 줄**
 *   ({ optKey: '', whole: true })을 싣는다. 멈춘 뒤 상품이 생겨도 그 줄이 남아 [다시 열기]가 사라지지 않는다.
 */
async function optionSalesForCampaign(db, campaignId) {
  if (!ENABLED || !campaignId) return null;
  try {
    const q = (db || pool);
    const { rows: camp } = await q.query(
      `SELECT rc.soldout_paused_at, rc.soldout_paused_reason, rc.soldout_paused_by,
              (SELECT COUNT(*) FROM campaign_option_soldout_reports r
                WHERE r.campaign_id = rc.id AND r.opt_key = '' AND r.cleared_at IS NULL) AS reports
         FROM recruit_campaigns rc WHERE rc.id = $1`, [campaignId]);
    const { rows } = await q.query(
      `SELECT co.opt_key, co.paused_at, co.paused_reason, co.paused_by,
              (SELECT COUNT(*) FROM campaign_option_soldout_reports r
                WHERE r.campaign_id = co.campaign_id AND r.opt_key = co.opt_key AND r.cleared_at IS NULL) AS reports
         FROM campaign_options co
        WHERE co.campaign_id = $1 AND COALESCE(co.status,'active') <> 'closed'
        ORDER BY co.sort_order, co.id`, [campaignId]);
    const list = rows.map(r => ({
      optKey: r.opt_key, paused: !!r.paused_at, pausedAt: r.paused_at || null,
      pausedReason: r.paused_reason || '', pausedBy: r.paused_by || '', reports: Number(r.reports) || 0,
    }));
    const c = camp[0];
    if (c && (!list.length || c.soldout_paused_at)) {
      list.unshift({
        optKey: WHOLE, whole: true, paused: !!c.soldout_paused_at, pausedAt: c.soldout_paused_at || null,
        pausedReason: c.soldout_paused_reason || '', pausedBy: c.soldout_paused_by || '', reports: Number(c.reports) || 0,
      });
    }
    return list;
  } catch (e) {
    logger.warn(`[option-pause] 상품 판매 상태 조회 실패(카드 줄 생략): ${(e && e.message) || e}`);
    return null;
  }
}

module.exports = {
  AUTO_PAUSE_REPORTERS,
  ENABLED,
  WHOLE,
  recordSoldoutReport,
  setOptionPaused,
  closeStaleForCampaign,
  listOpenAlerts,
  resolveAlert,
  optionSalesForCampaign,
  _resolveOrderTarget,
};
