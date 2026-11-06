// ═══════════════════════════════════════════════════════════════════════════
// 결정 343 — 모집인원 조절 창에서 상품 일건수 바꾸기 (사용자 확정 2026-11-06)
//
// 공고 하루 몫은 상품(선택지) 일건수 합을 넘지 못한다(결정 210). 그래서 날짜별 조절에 40을 넣어도 상품 일건수가 20이면
// 20명만 열린다. 조절 창의 [상품 일건수 바꾸기] 팝업이 이 입구를 불러 **상품 일건수 · 공고 기본 일건수 ·
// (연결 공고면) 인트라넷 리뷰오더 일 진행 건수**를 함께 바꾼다.
//
// ★★ 연결 공고(`findBidirLink` · 스위치 campaign_edit='on') = 공고 창 인원 수정과 **같은 길**:
//    `planCampaignMoneyEdit`(공고 창과 같은 계획) → `applySharedPatch`(origin 'campaign') → 공고 칸은 투영이 따라 바꾼다.
//    ★ 옵션표는 **줄 전부**를 보낸다(결정 280 완화 금지 — 안 보낸 줄은 "지웠다"로 읽힌다). 인원·금액은 기준(오더) 값, 일건수만 새 값.
//    ★ fail-closed — 계획에 일건수 말고 다른 변경(구조·인원·금액·주소…)이 끼면 쓰지 않는다(오더·공고가 이미 갈라진 공고 등).
//    ★ 스위치 꺼짐 = 409(인원은 공유 칸 — 공고만 바꾸면 오더와 갈라진다 · countsBlockedWhileSwitchOff 와 같은 판정).
// ★ 연결 아닌 공고 = 공고 창(PUT /admin/:id)이 쓰는 두 칸만 한 트랜잭션에서(옵션 일건수 · 공고 daily_limit = 열린 줄 합).
// ★ 화면이 본 값(from)과 지금 값이 다르면 409(쓰기 0) — 그 사이 누가 바꿨으면 덮지 않는다.
// ★ 쓴 뒤 작업표 빈 줄 날짜를 다시 깐다(relayCampaignWorktable — 공고 창 저장·이월 방식 변경과 같은 함수).
// 날짜별로 사람이 정해 둔 인원(campaign_daily_plans)은 건드리지 않는다(결정 275 사용자 확정 가).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const getPool = () => require('../db/pool');
const { logger } = require('../utils/logger');

const MAX_DAILY = 9999;

const fail = (status, code, error, extra) => ({ status, body: { ok: false, code, error, ...(extra || {}) } });

/** 화면이 보낸 줄 → [{ optKey, dailyLimit, from }] | null(형식 오류) */
function parseRequest(body) {
  const list = body && Array.isArray(body.options) ? body.options : null;
  if (!list || !list.length || list.length > 200) return null;
  const out = [], seen = new Set();
  for (const o of list) {
    if (!o || typeof o !== 'object') return null;
    const optKey = String(o.optKey == null ? '' : o.optKey);
    const dl = Number(o.dailyLimit), from = Number(o.from);
    if (!optKey || seen.has(optKey)) return null;
    if (!Number.isInteger(dl) || dl < 1 || dl > MAX_DAILY) return null;
    if (!Number.isInteger(from) || from < 0) return null;
    seen.add(optKey);
    out.push({ optKey, dailyLimit: dl, from });
  }
  return out;
}

/** 화면이 본 값(from)이 지금 열린 줄과 같은가 → null(같음) | 409 option_daily_stale. 트랜잭션 안 재검사도 이 함수 하나. */
function staleAgainst(want, live) {
  const open = live.filter(r => String(r.status || 'active') === 'active');
  const byKey = new Map(open.map(r => [String(r.opt_key), r]));
  if (want.length !== open.length || want.some(w => !byKey.has(w.optKey))) {
    return fail(409, 'option_daily_stale', '그 사이 상품 구성이 바뀌었습니다. 새 값을 다시 불러왔으니 확인 후 다시 바꿔 주세요.');
  }
  if (want.some(w => (Number(byKey.get(w.optKey).daily_limit) || 0) !== w.from)) {
    return fail(409, 'option_daily_stale', '그 사이 다른 사람이 상품 일건수를 바꿨습니다. 새 값을 다시 불러왔으니 확인 후 다시 바꿔 주세요.');
  }
  return null;
}

/** 지금 열린 줄과 화면이 보낸 줄을 대조한다 → null(통과) | 실패 응답 */
function checkAgainstLive(want, live) {
  const open = live.filter(r => String(r.status || 'active') === 'active');
  if (!open.length) return fail(409, 'option_daily_no_options', '이 공고에는 상품 일건수가 없습니다. 모집공고 수정에서 확인해 주세요.');
  const st = staleAgainst(want, live);
  if (st) return st;
  if (want.every(w => w.dailyLimit === w.from)) return fail(400, 'option_daily_no_change', '바뀐 일건수가 없습니다.');
  return null;
}

function _canon(v) {
  if (Array.isArray(v)) return '[' + v.map(_canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + _canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
/** 상품 구성에서 일건수 칸만 지운 비교용 사본 */
function _withoutDaily(poj) {
  let arr = poj;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { return null; } }
  if (!Array.isArray(arr)) return null;
  return arr.map(p => {
    const q = JSON.parse(JSON.stringify(p || {}));
    if (q.base && typeof q.base === 'object') delete q.base.daily;
    (Array.isArray(q.options) ? q.options : []).forEach(o => { if (o && typeof o === 'object') delete o.daily; });
    return q;
  });
}

/**
 * 연결 공고 계획이 "일건수만" 바꾸는가(순수 함수 — 시험이 직접 부른다).
 * @returns {string|null} 막는 이유(null = 통과)
 */
function dailyOnlyViolation(plan, baseState) {
  if (!plan || (plan.unmappable || []).length) return 'unmappable';
  const allowed = new Set(['product_options_json', 'daily_count', 'recruit_count']);
  const extra = Object.keys(plan.mine || {}).filter(k => !allowed.has(k));
  if (extra.length) return 'extra:' + extra.join(',');
  const int = v => Math.max(0, Math.floor(Number(v) || 0));
  if (Object.prototype.hasOwnProperty.call(plan.mine, 'recruit_count') && int(plan.mine.recruit_count) !== int(baseState.recruit_count)) return 'recruit_count';
  if (Object.prototype.hasOwnProperty.call(plan.mine, 'product_options_json')) {
    const a = _withoutDaily(baseState.product_options_json), b = _withoutDaily(plan.mine.product_options_json);
    if (!a || !b || _canon(a) !== _canon(b)) return 'product_options_json';
  }
  return null;
}

/** 연결 공고 — 공고 창과 같은 계획으로 오더 공유 저장. → { applied:true, version } | 실패 응답 */
async function _applyLinked({ db, link, want, campOptions, actor }) {
  const base = Number(link.wo.sync_version) || 0;
  const { rows: snap } = await db.query('SELECT state FROM work_order_shared_snapshots WHERE work_order_id = $1 AND sync_version = $2', [link.wo.id, base]);
  if (!snap.length) return fail(409, 'edit_base_missing', '리뷰오더와 맞춰지는 공고인데 기준 정보를 찾지 못했습니다. 모집공고 수정에서 일건수를 바꿔 주세요.');
  const { projectOrderToCampaign } = require('../utils/orderToCampaignProjection');
  const baseRows = new Map(projectOrderToCampaign(snap[0].state).options.map(r => [r.key, r]));
  const wantBy = new Map(want.map(w => [w.optKey, w.dailyLimit]));
  const live = campOptions.filter(r => String(r.status || '') !== 'deleted');
  let daily = 0;
  // ★★ 줄 전부(결정 280) — 인원·금액은 기준(오더) 값, 상태(열림·마감)는 공고 값, 일건수만 새 값(열린 줄).
  const options = live.map(r => {
    const key = String(r.unit_kind || '') === 'product' ? `${r.opt_key}|` : `${r.product_name}|${r.opt_key}`;
    const br = baseRows.get(key);
    const closed = String(r.status || 'active') === 'closed';
    const dl = !closed && wantBy.has(String(r.opt_key)) ? wantBy.get(String(r.opt_key)) : (br ? br.daily_limit : r.daily_limit);
    if (!closed) daily += Number(dl) || 0;
    return {
      optKey: r.opt_key, unitKind: r.unit_kind, productName: r.product_name,
      status: closed ? 'closed' : 'active',
      recruitTotal: br ? br.recruit_total : r.recruit_total, dailyLimit: dl,
      payAmount: br ? br.pay_amount : r.pay_amount,
    };
  });
  const body = { options, daily_limit: daily };
  const { planCampaignMoneyEdit } = require('../utils/campaignSharedEdit');
  let plan;
  try { plan = planCampaignMoneyEdit({ baseState: snap[0].state, camp: link.camp, body, campOptions }); }
  catch (e) {   // 계획이 모양을 못 맞추면(동시진행 등) 막고 안내 — 500 으로 가리지 않는다
    logger.warn(`[option-daily] 연결 공고 계획 실패 camp=${link.camp.id}: ${e.message}`);
    return fail(409, 'option_daily_linked_mismatch', '리뷰오더와 맞춰지는 공고인데 여기서는 일건수를 바꿀 수 없는 모양입니다. 모집공고 수정에서 바꿔 주세요.');
  }
  const why = dailyOnlyViolation(plan, snap[0].state);
  if (why) {
    logger.warn(`[option-daily] 연결 공고 — 일건수 말고 다른 변경이 섞여 멈춤 camp=${link.camp.id} wo=${link.wo.id} why=${why} changed=${(plan.changed || []).join(',')}`);
    return fail(409, 'option_daily_linked_mismatch', '리뷰오더와 공고의 다른 칸이 서로 달라 여기서는 일건수만 바꿀 수 없습니다. 「오더·공고 다름」에서 먼저 맞추거나 모집공고 수정에서 바꿔 주세요.');
  }
  if (!Object.keys(plan.mine).length) return { applied: false, version: base };   // 리뷰오더는 이미 그 값 — 공고만 맞추면 된다(뒤 트랜잭션이 버전을 다시 본다)
  const sig = want.map(w => `${w.optKey}=${w.dailyLimit}`).join('&');
  const { applySharedPatch } = require('./sharedPatch.service');
  const out = await applySharedPatch({
    workOrderId: link.wo.id, mine: plan.mine, baseVersion: base, origin: 'campaign', conflictPolicy: 'last_writer',
    actor: `모집인원 조절(${actor || '직원'})`,
    // ★ 검토 2026-11-06: 판정(트랜잭션 밖)과 쓰기 사이에 인트라넷·공고 창이 일건수를 바꿨으면 덮지 않는다 —
    //   공유 저장의 잠금(공고 → 오더) 안에서 본 값(from)을 다시 대조한다(last_writer 가 조용히 덮지 않게).
    preHook: async (client) => {
      const { rows } = await client.query(`SELECT opt_key, daily_limit, status FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status, 'active') <> 'deleted'`, [link.camp.id]);
      return staleAgainst(want, rows);
    },
    opId: `option_daily_${link.camp.id}_${base}_${require('crypto').createHash('sha1').update(sig).digest('hex').slice(0, 16)}`,
  });
  if (out.status !== 200) return { status: out.status, body: { ok: false, ...(out.body || {}), error: (out.body && out.body.error) || '리뷰오더 일건수를 바꾸지 못했습니다. 모집공고 수정에서 바꿔 주세요.' } };
  return { applied: true, version: out.body && out.body.sync_version };
}

/** 공고 칸을 화면이 고른 값으로 맞춘다(연결 아님 · 또는 연결 공고에서 오더가 이미 그 값이라 투영이 쓸 게 없을 때). */
async function _writeCampaignInTx(client, campaignId, want) {
  for (const w of want) {
    await client.query(
      `UPDATE campaign_options SET daily_limit = $3, updated_at = NOW()
        WHERE campaign_id = $1 AND opt_key = $2 AND COALESCE(status, 'active') = 'active'`, [campaignId, w.optKey, w.dailyLimit]);
  }
  await client.query(
    `UPDATE recruit_campaigns SET daily_limit = (
        SELECT COALESCE(SUM(daily_limit), 0) FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status, 'active') = 'active'),
        updated_at = NOW()
      WHERE id = $1`, [campaignId]);
}

/**
 * POST /api/trackb/campaigns/:id/option-daily
 * @returns {Promise<{status:number, body:object}>}
 */
async function changeOptionDaily({ campaignId, body, actor = '', db } = {}) {
  const pool = db || getPool();
  const cid = String(campaignId || '');
  const want = parseRequest(body);
  if (!want) return fail(400, 'option_daily_bad_request', '일건수는 1명 이상 숫자로 적어 주세요.');
  const { rows: cr } = await pool.query('SELECT id, participation_mode, archived_at, daily_limit FROM recruit_campaigns WHERE id = $1', [cid]);
  const camp = cr[0];
  if (!camp || camp.archived_at) return fail(404, 'not_found', '공고를 찾을 수 없습니다.');
  if (camp.participation_mode !== true) return fail(409, 'not_participation', '참여형 공고만 여기서 일건수를 바꿀 수 있습니다.');
  if (await require('./qnaSlots.service').isQnaCampaign(cid)) {
    return fail(409, 'option_daily_qna_locked', 'Q&A 작업은 날짜별 자리표가 이미 깔려 있어 여기서 일건수를 바꾸지 않습니다.');
  }
  // 순차진행(결정 212·228) 공고는 상품 일건수를 쓰지 않는다(정원·일정표가 하루 몫을 정한다) — 바꿔도 효과가 없고 리뷰오더만 바뀐다
  if ((await require('./campaignState.service').fetchSequentialCampaignIds(pool, [cid])).has(cid)) {
    return fail(409, 'option_daily_sequential', '상품을 차례로 여는 작업이라 상품 일건수가 하루 인원을 정하지 않습니다. 모집공고 수정에서 확인해 주세요.');
  }
  const { rows: liveRows } = await pool.query(
    `SELECT * FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status, 'active') <> 'deleted'`, [cid]);
  const bad = checkAgainstLive(want, liveRows);
  if (bad) return bad;
  const prev = want.map(w => ({ optKey: w.optKey, from: w.from, to: w.dailyLimit }));

  const ss = require('./campaignSharedSave.service');
  const { readBidirSwitch } = require('../utils/bidirSwitch');
  let link = null;
  try { link = await ss.findBidirLink(pool, cid); }
  catch (e) {   // 연결 판정 실패 = 막음(fail-closed — 공고만 바꾸면 오더와 갈라질 수 있다)
    logger.warn(`[option-daily] 연결 판정 실패 — 막음 camp=${cid}: ${e.message}`);
    return fail(503, 'option_daily_link_unknown', '리뷰오더 연결 여부를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  let linked = null;
  if (link) {
    if ((await readBidirSwitch(pool)).campaign_edit !== 'on') {
      return fail(409, 'counts_link_paused', '리뷰오더와 연결된 공고의 일건수는 지금 이 화면에서 바꿀 수 없습니다 — 연결 저장이 잠시 꺼져 있습니다. 인트라넷 리뷰오더에서 바꿔 주세요.');
    }
    linked = await _applyLinked({ db: pool, link, want, campOptions: liveRows, actor });
    if (linked.status) return linked;
  }

  // 공고 칸(연결 공고는 투영이 이미 썼으면 같은 값 — 다시 확인하고 못 따라왔을 때만 맞춘다 · 오더는 이미 그 값)
  const client = await pool.connect();
  let campDaily = null, wroteCampaign = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [cid]);
    const { rows: now } = await client.query(
      `SELECT opt_key, daily_limit FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status, 'active') = 'active'`, [cid]);
    const nowBy = new Map(now.map(r => [String(r.opt_key), Number(r.daily_limit) || 0]));
    if (!link) {
      // 잠근 뒤 다시 본다 — 판정과 쓰기 사이에 누가 바꿨으면 덮지 않는다
      if (want.some(w => !nowBy.has(w.optKey) || nowBy.get(w.optKey) !== w.from) || now.length !== want.length) {
        await client.query('ROLLBACK');
        return fail(409, 'option_daily_stale', '그 사이 다른 사람이 상품 일건수를 바꿨습니다. 창을 닫고 다시 열어 주세요.');
      }
    }
    if (want.some(w => nowBy.get(w.optKey) !== w.dailyLimit)) {
      let mayWrite = !link;
      if (link) {
        // ★ 검토 2026-11-06: 공고만 맞추는 건 오더가 **우리가 쓴(또는 본) 버전 그대로**일 때만 — 그 사이 인트라넷이 바꿨으면 그 값이 이미 공고로 왔다(덮으면 갈라진다).
        //   잠금 순서는 공유 저장과 같다(공고 → 오더).
        const { rows: wv } = await client.query('SELECT sync_version FROM work_orders WHERE id = $1 FOR UPDATE', [link.wo.id]);
        mayWrite = wv.length > 0 && String(wv[0].sync_version) === String(linked.version);
        if (mayWrite) logger.warn(`[option-daily] 공유 저장 뒤 공고가 안 따라옴 — 공고만 오더 값으로 맞춤 camp=${cid}`);
        else logger.warn(`[option-daily] 공유 저장 뒤 오더가 또 바뀜 — 공고는 그 값(투영)에 맡긴다 camp=${cid}`);
      }
      if (mayWrite) { await _writeCampaignInTx(client, cid, want); wroteCampaign = true; }
    }
    const { rows: cd } = await client.query('SELECT daily_limit FROM recruit_campaigns WHERE id = $1', [cid]);
    campDaily = cd.length ? Number(cd[0].daily_limit) || 0 : null;
    await client.query(
      `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, 'option_daily', $3)`,
      [cid, String(actor || '').slice(0, 100), JSON.stringify({ options: prev, campaignDaily: campDaily, linked: !!link, orderVersion: linked ? linked.version : null })]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }

  const worktableRelay = await require('./campaignPlan.service').relayCampaignWorktable(cid, { by: actor || 'option-daily' });
  logger.info(`[option-daily] camp=${cid} ${prev.map(p => `${p.optKey}:${p.from}→${p.to}`).join(' ')} 공고=${campDaily} 연결=${!!link}${wroteCampaign ? ' 공고직접' : ''}`);
  return { status: 200, body: { ok: true, applied: { options: prev, campaignDaily: campDaily, intranet: !!link, orderVersion: linked ? linked.version : null }, worktableRelay } };
}

module.exports = { changeOptionDaily, parseRequest, checkAgainstLive, staleAgainst, dailyOnlyViolation, MAX_DAILY };
