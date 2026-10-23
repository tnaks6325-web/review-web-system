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
    `SELECT opt_key, product_name, status, sole_until FROM campaign_options WHERE campaign_id = $1 ORDER BY sort_order, id`, [campaignId]);
  if (opts.length < 2) throw new CaptureFillError('not_multi_product', '상품이 둘 이상인 공고에서만 쓸 수 있습니다(하나면 고를 것이 없습니다).');
  return { camp: c, options: opts };
}

/**
 * 상품을 모르는(결정 210·232 귀속 실패) 신청 없는 주문 + 그 작업표 줄.
 * ★ 범위는 상품별 사용 수(_loadExternalOptionOrders)와 **같은 규칙**이어야 고칠 수 있는 것과 세는 것이 일치한다(Codex 리뷰):
 *   공고 좌표 ∪ 연결 탭 좌표(이름 또는 탭 번호 · 시작일 이후) · 공유 탭(활성 공고 둘 이상)의 탭 좌표 제외 ·
 *   취소된 주문도 살아 있는 줄이 가리키면 포함 · 늦은 구매로 확정된 주문 제외.
 * 줄마다 상태를 붙인다: dupRows(같은 주문이 여러 줄 — 어느 줄인지 모름) · filledUnmatched(칸에 값이 있으나 상품을 못 가름 — 덮지 않음).
 */
async function _loadTargets(db, camp, options, onlyOrderId = null) {
  const { rows } = await db.query(`
    SELECT os.id, os.capture_file_id, os.selected_opt_key, os.selected_product, os.submitted_at,
           (os.submitted_at AT TIME ZONE 'Asia/Seoul')::date::text AS day,
           cp.id AS row_id, cp.seq, cp.tab_name AS row_tab, cp.option_text, cp.row_json->>'상품' AS row_product,
           pe.value_text AS edited_product,
           COUNT(*) OVER (PARTITION BY os.id) AS row_count
      FROM recruit_campaigns rc
      JOIN LATERAL (
        SELECT COUNT(*) AS n FROM recruit_campaigns rc2
         WHERE rc2.participation_mode AND rc2.status = 'active' AND rc2.archived_at IS NULL
           AND rc2.linked_sheet_id = rc.linked_sheet_id
           AND (rc2.linked_tab_name = rc.linked_tab_name
                OR (NULLIF(rc.linked_tab_gid,'') IS NOT NULL AND NULLIF(rc2.linked_tab_gid,'') = NULLIF(rc.linked_tab_gid,'')))
      ) shared ON TRUE
      JOIN order_submissions os
        ON os.campaign_application_id IS NULL
       AND ((os.sheet_id = 'campaign:' || rc.id AND os.tab_name = 'campaign:' || rc.id)
         OR (shared.n <= 1
             AND os.sheet_id = rc.linked_sheet_id
             AND (os.tab_name = rc.linked_tab_name
                  OR (NULLIF(rc.linked_tab_gid,'') IS NOT NULL AND NULLIF(os.tab_gid,'') = NULLIF(rc.linked_tab_gid,'')))
             AND os.submitted_at >= COALESCE((rc.start_date::text || 'T00:00:00+09:00')::timestamptz, rc.created_at)))
      JOIN campaign_participants cp
        ON cp.order_submission_id = os.id AND cp.deleted_at IS NULL AND cp.active
       AND cp.sheet_id = rc.linked_sheet_id
       AND (cp.tab_name = rc.linked_tab_name
            OR (NULLIF(rc.linked_tab_gid,'') IS NOT NULL AND NULLIF(cp.tab_gid,'') = NULLIF(rc.linked_tab_gid,'')))
      LEFT JOIN LATERAL (
        SELECT pe0.value_text FROM participant_edits pe0
         WHERE pe0.sheet_id = cp.sheet_id AND pe0.tab_name = cp.tab_name
           AND pe0.anchor_type = 'order' AND pe0.anchor_value = os.id::text
           AND pe0.field = 'col:상품' AND pe0.reverted_at IS NULL
         ORDER BY pe0.created_at DESC, pe0.id DESC LIMIT 1
      ) pe ON TRUE
     WHERE rc.id = $1
       AND ($2::uuid IS NULL OR os.id = $2::uuid)
       AND NOT EXISTS (SELECT 1 FROM campaign_applications la WHERE la.late_order_id = os.id AND la.status = 'submitted')
     ORDER BY cp.seq, os.id`, [camp.id, onlyOrderId]);
  const { matchOrderOption } = require('./campaignState.service');
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    if (matchOrderOption(options, {
      editedProduct: r.edited_product, selectedOptKey: r.selected_opt_key, selectedProduct: r.selected_product,
      optionText: r.option_text, rowProduct: r.row_product, submittedAt: r.submitted_at,   // 결정 275 ⑤-2 원래 상품 줄 시각(정원 셈과 같은 규칙)
    })) continue;
    r.dupRows = Number(r.row_count) > 1;
    r.filledUnmatched = !!(String(r.row_product || '').trim() || String(r.edited_product || '').trim());
    out.push(r);
  }
  return out;
}

async function _readOne(t, options, samples) {
  const base = { orderId: String(t.id), seq: Number(t.seq), day: t.day };
  // ★ 적용할 수 없는 줄은 AI 를 돌리지 않고 그렇게 말한다(미리보기에서 고른 것이 적용에서 거절되는 막다른 길 방지 — Codex 리뷰)
  if (t.dupRows) return { ...base, status: 'duplicate_rows', applicable: false };
  if (t.filledUnmatched) return { ...base, status: 'filled_unmatched', applicable: false, read: String(t.edited_product || t.row_product || '') };
  if (!t.capture_file_id) return { ...base, status: 'no_capture' };
  let file;
  try { file = await deps.download(String(t.capture_file_id)); }
  catch (e) { return { ...base, status: 'download_failed', error: String(e && e.message || e).slice(0, 120) }; }
  let ex;
  try {
    const b64 = Buffer.from(file.buffer).toString('base64');
    ex = await deps.extract(b64, file.mimeType || 'image/jpeg', { samples, allowProductOnly: true });
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
async function previewCaptureProducts({ campaignId, limit = MAX_ITEMS, offset = 0 } = {}) {
  const db = getPool();
  const { camp, options } = await _loadCampaign(db, campaignId);
  const targets = await _loadTargets(db, camp, options);
  const lim = Math.min(Math.max(parseInt(limit, 10) || MAX_ITEMS, 1), MAX_ITEMS);
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const work = targets.slice(off, off + lim);
  const samples = work.some(t => t.capture_file_id) ? await deps.samples() : [];
  const items = new Array(work.length);
  let next = 0;
  const runner = async () => { while (next < work.length) { const i = next++; items[i] = await _readOne(work[i], options, samples); } };
  await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, work.length) }, runner));
  const count = (s) => items.filter(x => x.status === s).length;
  return {
    ok: true, campaignId: camp.id, title: camp.title,
    options: options.map(o => ({ optKey: o.opt_key, productName: o.product_name || o.opt_key, status: o.status || 'active' })),
    total: targets.length, offset: off, scanned: work.length,
    truncated: Math.max(0, targets.length - off - work.length),
    nextOffset: off + work.length < targets.length ? off + work.length : null,   // 다음 묶음(앞쪽 미해결 줄이 뒤를 막지 않게 — Codex 리뷰)
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
    if (t.dupRows) { results.push({ ...p, ok: false, reason: 'duplicate_rows', message: '같은 주문이 작업표 여러 줄에 있어 어느 줄인지 정할 수 없습니다(중복 정리 먼저)' }); continue; }
    if (t.filledUnmatched) {
      results.push({ ...p, ok: false, reason: 'already_filled', message: '상품 칸이 이미 채워져 있어 덮지 않았습니다' }); continue;
    }
    // ★ 같은 상품 이름을 여러 선택지가 쓰면(옵션 단위) 편집 기록에는 선택지를 하나로 가리키는 값(opt_key)을 남긴다 —
    //   상품 이름만 남기면 귀속이 둘 이상에 걸려 "모름"이 된다(Codex 리뷰). 표의 「상품」 칸에는 상품 이름을 적는다.
    const sharedName = o.product_name && options.filter(x => x.product_name === o.product_name).length > 1;
    todo.push({ ...p, seq: Number(t.seq), rowId: t.row_id, rowTab: t.row_tab,
      product: o.product_name || o.opt_key, editValue: sharedName ? o.opt_key : (o.product_name || o.opt_key) });
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
            AND order_submission_id = $4::uuid FOR UPDATE`, [p.rowId, sheetId, p.rowTab || tabName, p.orderId]);
      if (!rows.length) { results.push({ ...p, ok: false, reason: 'row_gone', message: '작업표 줄이 바뀌어 적지 않았습니다' }); continue; }
      const rj = (rows[0].row_json && typeof rows[0].row_json === 'object') ? rows[0].row_json : {};
      const patch = {};
      for (const [h, v] of productCellValues(headers, p.product)) {
        if (String(rj[h] == null ? '' : rj[h]).trim()) continue;   // blank-only
        patch[h] = v;
      }
      const { rows: ed } = await client.query(
        `SELECT 1 FROM participant_edits WHERE sheet_id=$1 AND tab_name=$2 AND anchor_type='order' AND anchor_value=$3
            AND field=$4 AND reverted_at IS NULL LIMIT 1`, [sheetId, p.rowTab || tabName, p.orderId, field]);
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
        [sheetId, p.rowTab || tabName, p.orderId, field, p.editValue,
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

/**
 * 결정 237 — 리뷰어 제출 순간: 상품을 고르지 않은 주문이면 **제출 때 이미 읽은 캡처 상품 글자**로 한 상품이 확실할 때만 채운다.
 *   추가 AI 호출·사진 내려받기 없음(화면이 제출 전에 판독한 값). 사람이 고른 값이 있으면 대상이 아니다(_loadTargets 귀속 판정).
 *   적는 곳 = 편집 기록 1건(작업 로그 'AI 캡처판독(제출 시)') — 작업표 표시·상품별 사용 수가 이 기록을 본다.
 *   row_json·장부 재생성은 하지 않는다(제출마다 장부를 다시 만들지 않게). 원장 selected_product 무접촉(결정 018).
 * ★ 무엇이든 실패하면 조용히 건너뛴다(접수와 무관 · 응답 뒤에 돈다). 끄는 스위치 env CAPTURE_PRODUCT_ON_SUBMIT=0.
 * @returns {{written:boolean, skipped?:string, optKey?:string}}
 */
async function fillFromSubmitCapture({ orderSubmissionId, sheetId, tabName, captureName = '', captureOption = '', by = '제출 시' } = {}) {
  if (process.env.CAPTURE_PRODUCT_ON_SUBMIT === '0') return { written: false, skipped: 'disabled' };
  const name = String(captureName || '').slice(0, 300).trim();
  const opt = String(captureOption || '').slice(0, 300).trim();
  if (!orderSubmissionId || !sheetId || !tabName || (!name && !opt)) return { written: false, skipped: 'no_input' };
  const db = getPool();
  const ctx = await require('./manualOrder.service').tabOptionChoices(db, { sheetId, tabName });
  if (!ctx || !ctx.campaignId) return { written: false, skipped: 'no_campaign' };
  let loaded;
  try { loaded = await _loadCampaign(db, ctx.campaignId); } catch (_) { return { written: false, skipped: 'not_multi_product' }; }
  const { camp, options } = loaded;
  const t = (await _loadTargets(db, camp, options, String(orderSubmissionId)))[0];
  if (!t) return { written: false, skipped: 'not_target' };            // 이미 상품을 앎 · 줄 아직 없음 등
  if (t.dupRows || t.filledUnmatched) return { written: false, skipped: t.dupRows ? 'duplicate_rows' : 'filled_unmatched' };
  const { matchOption } = require('../utils/productCaptureMatch');
  const key = matchOption(`${name} ${opt}`.trim(), options, { shortText: opt });
  if (!key) return { written: false, skipped: 'ambiguous' };
  const o = options.find(x => x.opt_key === key);
  const sharedName = o.product_name && options.filter(x => x.product_name === o.product_name).length > 1;
  const value = sharedName ? o.opt_key : (o.product_name || o.opt_key);
  const field = PRODUCT_FIELD();
  const { rowCount } = await db.query(
    `INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_bool, value_text, created_by)
     SELECT $1,$2,'order',$3,$4,'text',NULL,$5,$6
      WHERE NOT EXISTS (SELECT 1 FROM participant_edits WHERE sheet_id=$1 AND tab_name=$2 AND anchor_type='order'
                          AND anchor_value=$3 AND field=$4 AND reverted_at IS NULL)`,
    [sheetId, t.row_tab || tabName, String(orderSubmissionId), field, value, `AI 캡처판독(${String(by).slice(0, 60)})`.slice(0, 100)]);
  return rowCount ? { written: true, optKey: key } : { written: false, skipped: 'already_filled' };
}

module.exports = { previewCaptureProducts, applyCaptureProducts, fillFromSubmitCapture, CaptureFillError, __setPoolForTest, __setDepsForTest };
