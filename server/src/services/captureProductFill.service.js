/**
 * captureProductFill.service.js — 상품을 모르는 주문의 **구매 캡처를 AI 로 읽어** 작업표 「상품」 칸을 채운다
 * (결정 232 · 사용자 확정 2026-10-13 · 풍성에프엔비 간장 38건).
 *
 * 왜: 신청 기록 없이 들어온 주문(옛 외부모집 수동제출 등)은 고른 상품이 없어 상품별 사용 수에 안 잡힌다
 *   (결정 210 귀속 실패) → 공고 총원과 상품별 남은 자리가 어긋난다(결정 227 팝업). 그런데 구매 캡처에는
 *   산 상품 이름이 찍혀 있다. 시스템이 그것을 읽지 않았을 뿐이다.
 *
 * 두 단계:
 *   ① preview — 대상 주문마다 캡처를 내려받아 AI 로 읽고(gemini.extractOrderFromImage — 리뷰어 제출과 같은 판독),
 *      읽은 글자를 공고 상품 하나로 짝짓는다(productCaptureMatch.matchOption — 둘 이상 걸리면 모름 · 완화 금지).
 *      **쓰기 0건.**
 *   ② apply — 사람이 본 표(picks: [{orderId, optKey, source}])를 받아 그대로 적는다. AI 를 다시 돌리지 않는다
 *      (미리보기와 다른 결과가 적히지 않게 · 캡처 없는 줄은 사람이 고른 값으로 같은 길을 쓴다).
 *      - 「상품」 칸이 없는 작업표는 기존 ensureProductColumn 으로 칸부터 만든다(그 기능의 소급 채우기 포함).
 *      - 적는 곳 = 작업표 줄 「상품」 칸(blank-only) + 편집 기록(participant_edits — 작업 로그에 누가 채웠는지 남는다).
 *      - ★ 주문 원장의 "고른 상품"(selected_product)에는 쓰지 않는다 — 사람이 고른 값만 담는 칸이다(결정 018 역주입 금지).
 *        상품별 사용 수는 편집 기록(결정 232 귀속 1순위)으로 바로 맞춰진다.
 *      - 이미 상품을 아는 주문·이미 칸이 채워진 줄·이 공고 상품이 아닌 이름은 건너뛴다(조용한 덮어쓰기 금지).
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

const deps = {
  download: (id) => require('./drive.service').downloadFile(id),
  extract: (b64, mime, opts) => require('./gemini.service').extractOrderFromImage(b64, mime, opts),
  samples: async () => { try { return await require('./reviewInspect.service').loadOrderExtractionSamples(); } catch (_) { return []; } },
  ensureColumn: (o) => require('./worktableProductColumn.service').ensureProductColumn(o),
  rebuild: (o) => require('./sheetlessLedger.service').rebuildLedgers(o),
};
function __setDepsForTest(d) { Object.assign(deps, d); }

const PRODUCT_FIELD = () => 'col:' + require('./orderLedger.service').PRODUCT_HEADER;
const MAX_ITEMS = 200;
const AI_CONCURRENCY = 3;

class CaptureFillError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function _loadCampaign(db, campaignId) {
  const { rows } = await db.query(
    `SELECT id, title, linked_sheet_id, linked_tab_name, linked_tab_gid, start_date, created_at
       FROM recruit_campaigns WHERE id = $1 LIMIT 1`, [campaignId]);
  const c = rows[0];
  if (!c) throw new CaptureFillError('not_found', '공고를 찾을 수 없습니다.');
  if (!c.linked_sheet_id || !c.linked_tab_name) throw new CaptureFillError('no_worktable', '연결된 작업표가 없는 공고입니다.');
  const { rows: opts } = await db.query(
    `SELECT opt_key, product_name, status FROM campaign_options WHERE campaign_id = $1 ORDER BY sort_order, id`, [campaignId]);
  if (opts.length < 2) throw new CaptureFillError('not_multi_product', '상품이 둘 이상인 공고에서만 쓸 수 있습니다(하나면 고를 것이 없습니다).');
  return { camp: c, options: opts };
}

/** 상품을 모르는(결정 210·233 귀속 실패) 신청 없는 주문 + 그 작업표 줄. 범위는 _loadExternalOptionOrders 와 같다. */
async function _loadTargets(db, camp, options) {
  const { rows } = await db.query(`
    SELECT os.id, os.capture_file_id, os.selected_opt_key, os.selected_product,
           (os.submitted_at AT TIME ZONE 'Asia/Seoul')::date::text AS day,
           cp.id AS row_id, cp.seq, cp.option_text, cp.row_json->>'상품' AS row_product, pe.value_text AS edited_product
      FROM recruit_campaigns rc
      JOIN order_submissions os
        ON os.deleted_at IS NULL AND os.campaign_application_id IS NULL
       AND ((os.sheet_id = 'campaign:' || rc.id AND os.tab_name = 'campaign:' || rc.id)
         OR (os.sheet_id = rc.linked_sheet_id AND os.tab_name = rc.linked_tab_name
             AND os.submitted_at >= COALESCE((rc.start_date::text || 'T00:00:00+09:00')::timestamptz, rc.created_at)))
      JOIN campaign_participants cp
        ON cp.order_submission_id = os.id AND cp.deleted_at IS NULL AND cp.active
       AND cp.sheet_id = rc.linked_sheet_id AND cp.tab_name = rc.linked_tab_name
      LEFT JOIN LATERAL (
        SELECT pe0.value_text FROM participant_edits pe0
         WHERE pe0.sheet_id = rc.linked_sheet_id AND pe0.tab_name = rc.linked_tab_name
           AND pe0.anchor_type = 'order' AND pe0.anchor_value = os.id::text
           AND pe0.field = 'col:상품' AND pe0.reverted_at IS NULL
         ORDER BY pe0.created_at DESC, pe0.id DESC LIMIT 1
      ) pe ON TRUE
     WHERE rc.id = $1
       AND NOT EXISTS (SELECT 1 FROM campaign_applications la WHERE la.late_order_id = os.id AND la.status = 'submitted')
     ORDER BY cp.seq`, [camp.id]);
  const { matchOrderOption } = require('./campaignState.service');
  const seen = new Set();
  return rows.filter(r => {
    if (seen.has(String(r.id))) return false;
    seen.add(String(r.id));
    return !matchOrderOption(options, {
      editedProduct: r.edited_product, selectedOptKey: r.selected_opt_key, selectedProduct: r.selected_product,
      optionText: r.option_text, rowProduct: r.row_product,
    });
  });
}

async function _readOne(t, options, samples) {
  const base = { orderId: String(t.id), seq: Number(t.seq), day: t.day };
  if (!t.capture_file_id) return { ...base, status: 'no_capture' };
  let file;
  try { file = await deps.download(String(t.capture_file_id)); }
  catch (e) { return { ...base, status: 'download_failed', error: String(e && e.message || e).slice(0, 120) }; }
  let ex;
  try {
    const b64 = Buffer.from(file.buffer).toString('base64');
    ex = await deps.extract(b64, file.mimeType || 'image/jpeg', { samples });
  } catch (e) { return { ...base, status: 'read_failed', error: String(e && e.message || e).slice(0, 120) }; }
  const name = String((ex && ex.productName) || '').trim();
  const opt = String((ex && ex.productOption) || '').trim();
  const read = [name, opt].filter(Boolean).join(' / ');
  if (!name && !opt) return { ...base, status: 'no_product_text', read: '' };
  const { matchOption } = require('../utils/productCaptureMatch');
  const key = matchOption(`${name} ${opt}`.trim(), options, { shortText: opt });
  if (!key) return { ...base, status: 'ambiguous', read };
  const o = options.find(x => x.opt_key === key);
  return { ...base, status: 'matched', read, optKey: key, product: (o && o.product_name) || key };
}

/** ① 미리보기 — 쓰기 0건. */
async function previewCaptureProducts({ campaignId, limit = MAX_ITEMS } = {}) {
  const db = getPool();
  const { camp, options } = await _loadCampaign(db, campaignId);
  const targets = await _loadTargets(db, camp, options);
  const lim = Math.min(Math.max(parseInt(limit, 10) || MAX_ITEMS, 1), MAX_ITEMS);
  const work = targets.slice(0, lim);
  const samples = work.some(t => t.capture_file_id) ? await deps.samples() : [];
  const items = new Array(work.length);
  let next = 0;
  const runner = async () => { while (next < work.length) { const i = next++; items[i] = await _readOne(work[i], options, samples); } };
  await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, work.length) }, runner));
  const count = (s) => items.filter(x => x.status === s).length;
  return {
    ok: true, campaignId: camp.id, title: camp.title,
    options: options.map(o => ({ optKey: o.opt_key, productName: o.product_name || o.opt_key, status: o.status || 'active' })),
    total: targets.length, scanned: work.length, truncated: Math.max(0, targets.length - work.length),
    matched: count('matched'),
    needsHuman: work.length - count('matched'),
    items,
  };
}

/**
 * ② 적용 — picks 를 그대로 적는다(AI 재실행 없음). 서버가 다시 확인하는 것:
 *   주문이 지금도 상품 모르는 대상인가 · optKey 가 이 공고 상품인가 · 줄의 「상품」 칸이 비었는가.
 * @param picks [{orderId, optKey, source:'capture'|'manual'}]
 */
async function applyCaptureProducts({ campaignId, picks = [], by = 'system' } = {}) {
  const db = getPool();
  const { camp, options } = await _loadCampaign(db, campaignId);
  const list = (Array.isArray(picks) ? picks : []).slice(0, MAX_ITEMS)
    .map(p => ({ orderId: String((p && p.orderId) || ''), optKey: String((p && p.optKey) || ''), source: p && p.source === 'manual' ? 'manual' : 'capture' }))
    .filter(p => p.orderId && p.optKey);
  if (!list.length) throw new CaptureFillError('no_picks', '적용할 줄이 없습니다.');
  const targets = new Map((await _loadTargets(db, camp, options)).map(t => [String(t.id), t]));
  const optByKey = new Map(options.map(o => [o.opt_key, o]));

  const results = [];
  const todo = [];
  for (const p of list) {
    const t = targets.get(p.orderId);
    const o = optByKey.get(p.optKey);
    if (!t) { results.push({ ...p, ok: false, reason: 'not_target', message: '이미 상품을 아는 주문이거나 이 공고 주문이 아닙니다' }); continue; }
    if (!o) { results.push({ ...p, ok: false, reason: 'unknown_option', message: '이 공고 상품이 아닙니다' }); continue; }
    if (String(t.row_product || '').trim() || String(t.edited_product || '').trim()) {
      results.push({ ...p, ok: false, reason: 'already_filled', message: '상품 칸이 이미 채워져 있어 덮지 않았습니다' }); continue;
    }
    todo.push({ ...p, seq: Number(t.seq), rowId: t.row_id, product: o.product_name || o.opt_key });
  }
  if (!todo.length) return { ok: true, campaignId: camp.id, written: 0, results };

  // 「상품」 칸이 없으면 기존 기능으로 칸부터 만든다(소급 채우기 포함 — 그 기능의 규칙 그대로).
  const sheetId = camp.linked_sheet_id, tabName = camp.linked_tab_name;
  const col = await deps.ensureColumn({ sheetId, tabName, dryRun: false, backfill: true, by: `capture-fill:${by}` });
  const headers = (col && col.headers) || [];
  const { productCellValues } = require('./worktableProductColumn.service');
  const field = PRODUCT_FIELD();
  const actor = `AI 캡처판독(${String(by).slice(0, 60)})`;

  const client = await db.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sheetless_ledger:${sheetId}:${tabName}`]);
    for (const p of todo) {
      const { rows } = await client.query(
        `SELECT id, row_json FROM campaign_participants
          WHERE id = $1 AND sheet_id = $2 AND tab_name = $3 AND deleted_at IS NULL AND active
            AND order_submission_id = $4::uuid FOR UPDATE`, [p.rowId, sheetId, tabName, p.orderId]);
      if (!rows.length) { results.push({ ...p, ok: false, reason: 'row_gone', message: '작업표 줄이 바뀌어 적지 않았습니다' }); continue; }
      const rj = (rows[0].row_json && typeof rows[0].row_json === 'object') ? rows[0].row_json : {};
      const patch = {};
      for (const [h, v] of productCellValues(headers, p.product)) {
        if (String(rj[h] == null ? '' : rj[h]).trim()) continue;   // blank-only
        patch[h] = v;
      }
      const { rows: ed } = await client.query(
        `SELECT 1 FROM participant_edits WHERE sheet_id=$1 AND tab_name=$2 AND anchor_type='order' AND anchor_value=$3
            AND field=$4 AND reverted_at IS NULL LIMIT 1`, [sheetId, tabName, p.orderId, field]);
      if (ed.length) { results.push({ ...p, ok: false, reason: 'already_filled', message: '상품 칸이 이미 채워져 있어 덮지 않았습니다' }); continue; }
      if (Object.keys(patch).length) {
        await client.query(
          `UPDATE campaign_participants SET row_json = COALESCE(row_json, '{}'::jsonb) || $2::jsonb,
                  updated_by = $3, updated_at = NOW() WHERE id = $1`,
          [p.rowId, JSON.stringify(patch), `capture-fill:${String(by).slice(0, 80)}`]);
      }
      // 작업 로그(편집 기록) — 누가 어떤 근거로 채웠는지. 상품별 사용 수도 이 기록을 1순위로 본다(결정 232).
      await client.query(
        `INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_bool, value_text, created_by)
         VALUES ($1,$2,'order',$3,$4,'text',NULL,$5,$6)`,
        [sheetId, tabName, p.orderId, field, p.product,
         (p.source === 'manual' ? `수동지정(${String(by).slice(0, 60)})` : actor).slice(0, 100)]);
      results.push({ ...p, ok: true });
      written++;
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }

  let rebuildError = null;
  try { await deps.rebuild({ sheetId, tabName, columns: headers.length ? headers : null, dryRun: false, by: `capture-fill:${by}` }); }
  catch (e) { rebuildError = (e && e.message) || String(e); logger.warn(`[captureFill] 장부 재생성 실패 ${sheetId}/${tabName}: ${rebuildError}`); }
  logger.info(`[captureFill] ${camp.id} 적용 ${written}/${list.length} by=${by}`);
  return { ok: true, campaignId: camp.id, written, columnAdded: !!(col && col.headerAdded), backfilled: (col && col.backfillCount) || 0, rebuildError, results };
}

module.exports = { previewCaptureProducts, applyCaptureProducts, CaptureFillError, __setPoolForTest, __setDepsForTest };
