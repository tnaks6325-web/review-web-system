/**
 * campaignSequentialEnd.service.js — 순차진행 공고의 「정규 일정 끝」 팝업 (결정 228 · 사용자 확정 2026-10-12)
 *
 * 순차진행 일정표 공고는 못 채운 건을 다음 날로 넘기지 않는다(사용자 확정 — "첫날 은갈치가 3건만 팔리면 남은 2건은
 * 진행하지 않고, 정규 일정이 끝나는 시점에 모집을 할지 안 할지 그때 결정"). 그래서 일정표가 끝난 다음 날,
 * 공고 담당자와 그 작업오더를 보낸 AE 에게 「상품별 모자란 건수」를 보여 주고 고르게 한다.
 *   [추가 모집]      → 모자란 상품을 같은 순서로, 결정한 날의 다음 영업일부터 일정표에 이어 붙인다
 *                      (`campaign_plan_events.action='sequential_extra'` — 일정표 단일 출처가 이 기록을 읽는다).
 *   [그대로 끝내기]  → 공고를 마감한다(status='closed') + 기록(`sequential_finish`).
 *
 * ★ 판정 재료는 단일 출처 그대로 — 일정표 = `campaignState.fetchSequentialCampaignIds().plans`,
 *   상품별 사용량 = `fetchOptionCountsBatch`(공고 밖 주문 포함 — 210), 받는 사람 = `campaignShortage.isRecipient`.
 * ★ 같은 일정 끝(`detail.end`)에 대한 결정은 한 번만 — 공고 행을 잠근 뒤 기록을 다시 확인한다(담당자·AE 동시 반영).
 * ★ 모르면 묻지 않는다 — 일정표를 못 만든 공고 · 조회 실패 = 목록에서 뺀다.
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const st = require('./campaignState.service');
const { isRecipient } = require('./campaignShortage.service');

const ACTIONS = { extra: 'sequential_extra', finish: 'sequential_finish' };

async function _candidates(db) {
  const { rows } = await db.query(
    `SELECT id, title, thumbnail_url, manager, status
       FROM recruit_campaigns
      WHERE participation_mode AND status = 'active' AND archived_at IS NULL`);
  return rows;
}

async function _decided(db, ids) {
  const out = new Map();   // id → Set(end)
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT campaign_id, detail->>'end' AS end FROM campaign_plan_events
      WHERE campaign_id::text = ANY($1::text[]) AND action = $2`, [ids.map(String), ACTIONS.extra]);
  /* ★ 레드팀 P1-2: [그대로 끝내기]는 공고를 마감하므로 그 자체로 다시 묻지 않는다(게시 중만 대상). 관리자가 마감한 공고를
       **다시 게시**하면 같은 일정 끝을 다시 묻는다 — 끝내기 기록으로 막으면 "게시 중인데 영원히 0명"인 막다른 길이 된다. */
  for (const r of rows) {
    const k = String(r.campaign_id);
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(String(r.end || ''));
  }
  return out;
}

/**
 * 묻을 공고 목록.
 * @returns {{ok:true, items:Array<{campaignId,title,thumbnailUrl,end,regularEnd,shortages:Array<{optKey,n}>,total}>}}
 */
async function listSequentialEnds(admin, opts = {}) {
  const db = opts.db || pool;
  const now = opts.now || new Date();
  const today = st.kstTodayStr(now);
  let cands = await _candidates(db);
  if (opts.campaignIds) { const want = new Set(opts.campaignIds.map(String)); cands = cands.filter(c => want.has(String(c.id))); }
  if (!cands.length) return { ok: true, items: [] };
  const ids = cands.map(c => String(c.id));
  const seq = await st.fetchSequentialCampaignIds(db, ids);
  const seqCands = cands.filter(c => {
    const sch = seq.plans && seq.plans.get(String(c.id));
    return sch && sch.end && today > sch.end;
  });
  if (!seqCands.length) return { ok: true, items: [] };
  const sIds = seqCands.map(c => String(c.id));
  const { linkedWorkOrdersForCampaigns } = require('./linkedRecruitQuota.service');
  const [wos, decided, counts, optRows] = await Promise.all([
    linkedWorkOrdersForCampaigns(db, sIds, ['created_by']).catch(() => new Map()),
    _decided(db, sIds),
    st.fetchOptionCountsBatch(db, sIds, now),
    db.query(`SELECT campaign_id, opt_key, recruit_total, status, paused_at FROM campaign_options
               WHERE campaign_id::text = ANY($1::text[]) ORDER BY campaign_id, (status='closed'), sort_order, id`, [sIds]).then(r => r.rows),
  ]);
  const items = [];
  for (const c of seqCands) {
    const id = String(c.id);
    const sch = seq.plans.get(id);
    if ((decided.get(id) || new Set()).has(sch.end)) continue;
    // ★ 레드팀 P1-3: 마스터는 받는 사람이 아니어도 본다(담당자 칸이 비었거나 보낸 사람 이름이 직원과 다르면 아무도 못 정하는 공고가 남는다)
    if (!opts.skipRecipient && !(admin && admin.role === 'master') && !isRecipient(admin && admin.name, c, wos.get(c.id) || wos.get(id))) continue;
    const cm = counts.get(c.id) || counts.get(id) || new Map();
    const views = optRows.filter(o => String(o.campaign_id) === id && String(o.status || 'active') !== 'closed')
      .map(o => st.computeOptionView(o, cm.get(o.opt_key), null, { ignoreDailyLimit: true }));
    // ★ 결정 229(코드리뷰 P2): 품절로 멈춘 상품은 표시를 붙인다 — 그대로 추가 모집을 잡으면 그날은 아무도 고를 수 없다
    const shortages = views.filter(v => v.remaining !== null && v.remaining > 0).map(v => ({ optKey: v.optKey, n: v.remaining, ...(v.paused ? { paused: true } : {}) }));
    if (!shortages.length) continue;
    items.push({ campaignId: id, title: String(c.title || ''), thumbnailUrl: String(c.thumbnail_url || ''),
      end: sch.end, regularEnd: sch.regularEnd, shortages, total: shortages.reduce((a, x) => a + x.n, 0), optionOrder: sch.optionOrder });
  }
  return { ok: true, items, today };
}

/**
 * 결정 반영 — decisions: [{campaignId, action:'extra'|'finish', end}]
 * ★ 서버가 다시 계산한 값으로만 반영(화면 숫자 불신) · 받는 사람이 아닌 공고는 거절 · 공고마다 독립 트랜잭션.
 */
async function applySequentialEnds(admin, decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  if (!list.length) { const e = new Error('반영할 결정이 없습니다.'); e.code = 'empty'; throw e; }
  // ★ Codex P2: 조용히 자르지 않는다 — 화면은 50개씩 나눠 보낸다(어제 부족 팝업과 같은 규율)
  if (list.length > 50) { const e = new Error('한 번에 50개까지 반영할 수 있습니다.'); e.code = 'too_many'; throw e; }
  const results = [];
  for (const d of list) {
    const campaignId = String((d && d.campaignId) || '');
    const action = d && ACTIONS[d.action] ? d.action : null;
    if (!campaignId || !action) { results.push({ campaignId, ok: false, error: '잘못된 결정입니다.' }); continue; }
    const cur = await listSequentialEnds(admin, { campaignIds: [campaignId] });
    const it = (cur.items || [])[0];
    if (!it) { results.push({ campaignId, ok: false, error: '이미 처리됐거나 물을 대상이 아닙니다.' }); continue; }
    if (d.end && String(d.end) !== it.end) { results.push({ campaignId, ok: false, error: '일정이 바뀌었습니다 — 다시 확인해 주세요.' }); continue; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lock } = await client.query('SELECT id, status FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
      if (!lock.length || lock[0].status !== 'active') throw Object.assign(new Error('게시 중인 공고가 아닙니다.'), { code: 'not_active' });
      // 같은 일정 끝의 [추가 모집]은 한 번만(담당자·AE 동시 반영) — [끝내기]의 중복은 위 게시 중 확인이 막는다
      /* ★ Codex P2: 잠근 **뒤** 모자란 건수를 다시 센다 — 잠그기 전 계산과 사이에 들어온 구매·수기 주문을 반영
           (낡은 큰 숫자로 추가 모집을 넘치게 잡지 않는다). 일정 끝이 바뀌었으면 거절. */
      const fresh = ((await listSequentialEnds(admin, { db: client, campaignIds: [campaignId] })).items || [])[0];
      if (!fresh || fresh.end !== it.end) throw Object.assign(new Error('그사이 상황이 바뀌었습니다 — 다시 확인해 주세요.'), { code: 'changed' });
      it.shortages = fresh.shortages; it.total = fresh.total;
      const { rows: dup } = await client.query(
        `SELECT 1 FROM campaign_plan_events WHERE campaign_id = $1 AND action = $2 AND detail->>'end' = $3 LIMIT 1`,
        [campaignId, ACTIONS.extra, it.end]);
      if (dup.length) throw Object.assign(new Error('다른 담당자가 방금 처리했습니다.'), { code: 'already' });
      const actor = String((admin && admin.name) || 'admin').slice(0, 100);
      // ★ Codex P1: 상품 순번(idx)도 남긴다 — 나중에 상품 이름이 바뀌어도 일정표가 같은 상품을 찾는다
      const order = (fresh.optionOrder || []);
      const shortages = it.shortages.map(x => ({ ...x, idx: order.indexOf(x.optKey) }));
      const detail = action === 'extra'
        ? { end: it.end, after: st.kstTodayStr(), shortages }
        : { end: it.end, shortages };
      await client.query(
        `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1,$2,$3,$4::jsonb)`,
        [campaignId, actor, ACTIONS[action], JSON.stringify(detail)]);
      if (action === 'finish') {
        await client.query(`UPDATE recruit_campaigns SET status = 'closed', updated_at = NOW() WHERE id = $1`, [campaignId]);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      results.push({ campaignId, ok: false, error: e.code ? e.message : '반영에 실패했습니다.' });
      if (!e.code) logger.warn(`[sequentialEnd] 반영 실패 camp=${campaignId}: ${e.message}`);
      client.release();
      continue;
    }
    client.release();
    // 공고 목록 5초 기억을 비운다 — 반영 직후 카드가 옛 상태로 다시 그려지지 않게(어제 부족 인원 팝업과 같은 규율)
    try { const cr = require('../routes/campaign.routes'); if (cr && typeof cr.invalidateListCache === 'function') cr.invalidateListCache(); } catch (_) { /* 무관 */ }
    // 추가 모집이면 작업표 빈 줄 날짜·상품을 새 일정표에 맞춘다(커밋 뒤 · 절대 throw 없음)
    let relay = null;
    if (action === 'extra') {
      try { relay = await require('./campaignPlan.service').relayCampaignWorktable(campaignId, { by: `sequential-extra:${(admin && admin.name) || ''}`.slice(0, 100) }); }
      catch (e) { relay = { ok: false, message: e.message }; }
    }
    results.push({ campaignId, ok: true, action, title: it.title, total: it.total, relay: relay ? { ok: relay.ok !== false } : null });
  }
  return { ok: true, results };
}

/**
 * ★★ 지난 날 고정(레드팀 P0 — 결정 228) — 순차진행 공고마다 **어제까지**의 「그날 상품」을 기록한다
 *   (`campaign_plan_events.action='sequential_frozen'`, detail `{date, optKey, base, amount, idx}`). 일정표 단일 출처가 이 기록을 읽어
 *   지난 날은 그대로 쓰고 그 뒤부터만 지금 설정으로 다시 깐다 — 다 팔린 앞 상품 마감·총원 변경이 지난 날을 당기거나 끝난 상품을 다시 열지 않게.
 * ★ 매일 0시 5분(KST)과 서버가 켜질 때 돈다. 빠져도 일정표는 종전처럼 설정으로 계산된다(안전한 쪽 — 기록은 보호막이다).
 * ★ 공고마다 독립 트랜잭션 + 공고별 잠금 + 이미 기록한 날은 건너뜀(멱등). 게시 중·멈춤(임시저장) 공고 모두(멈춘 동안에도 날은 지나간다).
 */
async function freezeSequentialPast({ db = pool, now = new Date() } = {}) {
  const today = st.kstTodayStr(now);
  const { rows: camps } = await db.query(
    `SELECT id FROM recruit_campaigns WHERE participation_mode AND archived_at IS NULL AND status IN ('active','draft')`);
  if (!camps.length) return { ok: true, campaigns: 0, frozen: 0 };
  const seq = await st.fetchSequentialCampaignIds(db, camps.map(c => String(c.id)));
  let frozen = 0, failed = 0, touched = 0;
  for (const id of seq) {
    const sch = seq.plans && seq.plans.get(id);
    if (!sch) continue;
    // ★ Codex P1: 추가 모집으로 지나간 날도 고정한다(extra 표시) — 하루 건수를 나중에 고쳐도 끝난 추가 날이 다시 나뉘지 않게
    const want = sch.days.filter(d => d.date < today && !d.frozen);
    if (!want.length) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['seq_freeze:' + id]);
      const { rows: have } = await client.query(
        `SELECT detail->>'date' AS d FROM campaign_plan_events WHERE campaign_id = $1 AND action = 'sequential_frozen'`, [id]);
      const seen = new Set(have.map(r => r.d));
      let n = 0;
      for (const d of want) {
        if (seen.has(d.date)) continue;
        await client.query(
          `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1,'system','sequential_frozen',$2::jsonb)`,
          [id, JSON.stringify({ date: d.date, optKey: d.optKey, base: d.base, amount: d.amount, idx: sch.optionOrder.indexOf(d.optKey), ...(d.extra ? { extra: true } : {}) })]);
        n++;
      }
      await client.query('COMMIT');
      frozen += n; if (n) touched++;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      failed++;
      logger.warn(`[sequentialFreeze] 고정 실패 camp=${id}: ${e.message}`);
    } finally { client.release(); }
  }
  return { ok: true, campaigns: touched, frozen, failed };
}

module.exports = { listSequentialEnds, applySequentialEnds, freezeSequentialPast, ACTIONS };
