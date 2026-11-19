/**
 * captureClassify.service.js — 옵션 없는(또는 옵션 1개) 「택1」 공고에서 구매캡처 옵션 글자로 리뷰어가 산 것(분류 후보)을
 * 작업보드 「분류」 칸에 적는다 (결정 383 · 사용자 확정 2026-11-18 「주문캡쳐본에서 구분이 가능하면 작업보드에서도 자동으로 집계분류」 → B안).
 *
 * 무엇:
 *   - 후보 = 직원이 공고 창 「분류 후보」에 적은 글(`recruit_campaigns.classify_candidates` · '' = 기능 꺼짐 = 종전 그대로).
 *   - 칸 = 그 공고 연결 작업표의 **추가 열** 「분류」(trackb_custom_columns · 시트·인트라넷·업체 화면 무접촉 · 내부 직원만 보고 고친다).
 *     값은 주문 앵커(`order:<주문 id>`)에 붙는다 → 작업표 줄이 아직 없어도(큐 반영 전) 적어 두면 줄이 생길 때 그대로 보인다.
 *   - 짝짓기 = `productCaptureMatch.classifyCaptureCandidate` 단일 출처(옵션 글자만 · 상품명은 옵션 줄이 없을 때 보조 · 둘 이상 = 모름).
 *
 * 세 길:
 *   ① 제출 순간(classifyFromSubmitCapture) — 리뷰어 화면이 제출 전에 이미 읽은 캡처 글자(productCaptureName/Option)로. **AI 추가 호출 0.**
 *      응답 뒤에 돌고 무엇이든 실패하면 조용히 건너뛴다(접수와 무관 · 응답 불변). 끄는 스위치 env CAPTURE_CLASSIFY_ON_SUBMIT=0.
 *   ② 지난 주문(previewCaptureClassify → applyCaptureClassify) — 결정 232 [📷 캡처로 상품 찾기]와 같은 길:
 *      드라이브 사진 → 주문당 AI 1회 미리보기(쓰기 0) → 사람이 표를 보고 [적용](AI 재실행 없음 · 사람이 본 값 그대로).
 *   ③ 공고 저장 때(ensureClassifyColumnForCampaign) — 후보를 적으면 연결 작업표에 「분류」 칸을 미리 만든다(빈 칸 = 미분류).
 *
 * ★★ 빈 칸에만 쓴다(결정 018) — 값 기록이 이미 있으면(직원이 고쳤거나 비워 둔 것 포함) 덮지 않는다(ON CONFLICT DO NOTHING).
 * ★★ 보관된 공고는 채우지 않는다(결정 237 — 정산·보고와 어긋나지 않게) · 옵션 2개 이상 공고는 대상 아님(그건 결정 232 상품 찾기).
 * ★ 이 값은 **작업보드 보기용** — 리뷰어 화면이 보낸 판독 글자라 조작될 수 있다. 정산·업체 보고의 근거로 쓰지 않는다.
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { parseClassifyCandidates, classifyCaptureCandidate, _norm } = require('../utils/productCaptureMatch');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

const CLASSIFY_COLUMN = '분류';

class ClassifyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const _fill = () => require('./captureProductFill.service');

/** 살아 있는(마감 정리 안 된) 공고 옵션 수 — 결정 042 `liveOptions` 와 같은 기준(status !== 'closed'). */
async function _liveOptionCount(db, campaignId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status, 'active') <> 'closed'`, [campaignId]);
  return Number(rows[0] && rows[0].n) || 0;
}

/** 분류할 수 있는 공고인가 — 아니면 ClassifyError(code). */
async function _loadClassifyCampaign(db, campaignId) {
  const { rows } = await db.query(
    `SELECT id, title, linked_sheet_id, linked_tab_name, linked_tab_gid, start_date, created_at, archived_at, classify_candidates
       FROM recruit_campaigns WHERE id = $1 LIMIT 1`, [campaignId]);
  const c = rows[0];
  if (!c) throw new ClassifyError('not_found', '공고를 찾을 수 없습니다.');
  if (c.archived_at) throw new ClassifyError('archived', '보관된 공고는 채우지 않습니다.');
  const candidates = parseClassifyCandidates(c.classify_candidates);
  if (candidates.length < 2) throw new ClassifyError('no_candidates', '공고 수정 창의 「분류 후보」에 후보를 두 개 이상 적어 주세요.');
  if (!c.linked_sheet_id || !c.linked_tab_name) throw new ClassifyError('no_worktable', '연결된 작업표가 없는 공고입니다.');
  if (await _liveOptionCount(db, c.id) >= 2) throw new ClassifyError('multi_option', '옵션이 둘 이상인 공고는 「캡처로 상품 찾기」를 쓰세요.');
  return { camp: c, candidates };
}

/** 작업표(시트·탭)에 연결된, 후보를 적어 둔 보관 안 된 공고 하나(둘 이상이면 진행 중 하나 · 그래도 여럿이면 null — 어느 공고인지 모른다). */
async function _campaignForTab(db, sheetId, tabName) {
  const { rows } = await db.query(
    `SELECT rc.id, rc.status FROM recruit_campaigns rc
       LEFT JOIN tab_configs tc ON tc.sheet_id = $1 AND tc.tab_name = $2
      WHERE rc.participation_mode AND rc.archived_at IS NULL AND COALESCE(rc.classify_candidates, '') <> ''
        AND rc.linked_sheet_id = $1
        AND (rc.linked_tab_name = $2 OR (COALESCE(tc.tab_gid, '') <> '' AND rc.linked_tab_gid = tc.tab_gid))`, [sheetId, tabName]);
  if (rows.length === 1) return rows[0].id;
  const act = rows.filter(r => r.status === 'active');
  return act.length === 1 ? act[0].id : null;
}

async function _findColumn(db, sheetId, tabName) {
  const { rows } = await db.query(
    `SELECT id FROM trackb_custom_columns WHERE sheet_id = $1 AND tab_name = $2 AND col_name = $3 AND deleted_at IS NULL
      ORDER BY sort_order, created_at LIMIT 1`, [sheetId, tabName, CLASSIFY_COLUMN]);
  return rows[0] ? String(rows[0].id) : null;
}

/** 「분류」 추가 열을 보장한다(이미 있으면 그것 · 동시 제출이 둘 만들지 않게 탭 단위 잠금). */
async function ensureClassifyColumn({ sheetId, tabName, by = 'system' } = {}, db = getPool()) {
  const found = await _findColumn(db, sheetId, tabName);
  if (found) return { id: found, created: false };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`classify_col:${sheetId}:${tabName}`]);
    const again = await _findColumn(client, sheetId, tabName);
    if (again) { await client.query('COMMIT'); return { id: again, created: false }; }
    const { rows: mx } = await client.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM trackb_custom_columns WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL`,
      [sheetId, tabName]);
    const { rows } = await client.query(
      `INSERT INTO trackb_custom_columns (sheet_id, tab_name, col_name, sort_order, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [sheetId, tabName, CLASSIFY_COLUMN, Number(mx[0] && mx[0].n) || 0, String(`분류 후보(${by})`).slice(0, 100)]);
    await client.query('COMMIT');
    logger.info(`[classify] 「분류」 칸 생성 ${sheetId}/${tabName}`);
    return { id: String(rows[0].id), created: true };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

/** 빈 칸에만 적는다 — 그 주문의 값 기록이 이미 있으면(사람이 고쳤거나 비워 둔 것 포함) 아무것도 안 한다. */
async function _writeBlankOnly(db, columnId, orderId, value, by) {
  const { rowCount } = await db.query(
    `INSERT INTO trackb_custom_column_values (column_id, anchor_type, anchor_value, value_text, updated_by)
     VALUES ($1, 'order', $2, $3, $4)
     ON CONFLICT (column_id, anchor_type, anchor_value) DO NOTHING`,
    [columnId, String(orderId), String(value).slice(0, 2000), String(by).slice(0, 100)]);
  return rowCount > 0;
}

/**
 * ③ 공고 저장 뒤 — 후보가 있고 분류할 수 있는 공고면 연결 작업표에 「분류」 칸을 미리 만든다. 실패·대상 아님 = 조용히 null.
 * @returns {{columnId:string, created:boolean}|null}
 */
async function ensureClassifyColumnForCampaign(campaignId, { by = 'system' } = {}) {
  const db = getPool();
  let loaded;
  try { loaded = await _loadClassifyCampaign(db, campaignId); } catch (e) { if (e instanceof ClassifyError) return null; throw e; }
  const col = await ensureClassifyColumn({ sheetId: loaded.camp.linked_sheet_id, tabName: loaded.camp.linked_tab_name, by }, db);
  return { columnId: col.id, created: col.created };
}

/**
 * ① 리뷰어 제출 순간 — 이미 읽은 캡처 글자로 후보 하나가 확실할 때만 「분류」 칸에 적는다(AI 호출·사진 내려받기 없음).
 * @param {{orderSubmissionId, campaignId?, sheetId?, tabName?, captureName?, captureOption?, by?}} p
 *   campaignId = 검증된 공고 참여(홀드)의 공고. 없으면 작업표(sheetId·tabName)에 연결된 후보 있는 공고 하나.
 * @returns {{written:boolean, skipped?:string, value?:string}}
 */
async function classifyFromSubmitCapture({ orderSubmissionId, campaignId = null, sheetId = '', tabName = '', captureName = '', captureOption = '', by = '제출 시' } = {}) {
  if (process.env.CAPTURE_CLASSIFY_ON_SUBMIT === '0') return { written: false, skipped: 'disabled' };
  const name = String(captureName || '').slice(0, 300).trim();
  const opt = String(captureOption || '').slice(0, 300).trim();
  if (!orderSubmissionId || (!name && !opt)) return { written: false, skipped: 'no_input' };
  const db = getPool();
  let cid = campaignId ? String(campaignId) : null;
  if (!cid && sheetId && tabName && !String(sheetId).startsWith('campaign:')) cid = await _campaignForTab(db, sheetId, tabName);
  if (!cid) return { written: false, skipped: 'no_campaign' };
  let loaded;
  try { loaded = await _loadClassifyCampaign(db, cid); }
  catch (e) { if (e instanceof ClassifyError) return { written: false, skipped: e.code }; throw e; }
  const value = classifyCaptureCandidate({ productName: name, productOption: opt }, loaded.candidates);
  if (!value) return { written: false, skipped: 'ambiguous' };
  const col = await ensureClassifyColumn({ sheetId: loaded.camp.linked_sheet_id, tabName: loaded.camp.linked_tab_name, by }, db);
  const ok = await _writeBlankOnly(db, col.id, orderSubmissionId, value, `AI 캡처판독(${String(by).slice(0, 60)})`);
  return ok ? { written: true, value } : { written: false, skipped: 'already_filled' };
}

/**
 * 「분류」 칸이 빈 이 공고의 주문 + 작업표 줄(한 주문 한 번). 범위 = 결정 232 대상과 같은 공고 좌표 규칙:
 *   공고 참여 주문(`campaign:<공고>` 좌표) ∪ 연결 탭(이름 또는 탭 번호 · 시작일 이후 · 공유 탭(활성 공고 둘 이상)이면 제외).
 */
async function _loadClassifyTargets(db, camp, columnId) {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (os.id) os.id, os.capture_file_id, os.submitted_at,
           (os.submitted_at AT TIME ZONE 'Asia/Seoul')::date::text AS day, cp.seq
      FROM recruit_campaigns rc
      JOIN LATERAL (
        SELECT COUNT(*) AS n FROM recruit_campaigns rc2
         WHERE rc2.participation_mode AND rc2.status = 'active' AND rc2.archived_at IS NULL
           AND rc2.linked_sheet_id = rc.linked_sheet_id
           AND (rc2.linked_tab_name = rc.linked_tab_name
                OR (NULLIF(rc.linked_tab_gid,'') IS NOT NULL AND NULLIF(rc2.linked_tab_gid,'') = NULLIF(rc.linked_tab_gid,'')))
      ) shared ON TRUE
      JOIN order_submissions os
        ON os.deleted_at IS NULL
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
     WHERE rc.id = $1
       AND ($2::uuid IS NULL OR NOT EXISTS (
             SELECT 1 FROM trackb_custom_column_values v
              WHERE v.column_id = $2::uuid AND v.anchor_type = 'order' AND v.anchor_value = os.id::text))
     ORDER BY os.id, cp.seq`, [camp.id, columnId || null]);
  return rows.sort((a, b) => (Number(a.seq) - Number(b.seq)) || String(a.id).localeCompare(String(b.id)));
}

/** ② 미리보기 — 「분류」가 빈 주문의 캡처를 읽어 후보를 제안한다. **쓰기 0건**(칸도 만들지 않는다). */
async function previewCaptureClassify({ campaignId, limit, offset = 0 } = {}) {
  const db = getPool();
  const { camp, candidates } = await _loadClassifyCampaign(db, campaignId);
  const columnId = await _findColumn(db, camp.linked_sheet_id, camp.linked_tab_name);
  const targets = await _loadClassifyTargets(db, camp, columnId);
  const MAX = _fill().MAX_ITEMS;
  const lim = Math.min(Math.max(parseInt(limit, 10) || MAX, 1), MAX);
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const work = targets.slice(off, off + lim);
  const samples = work.some(t => t.capture_file_id) ? await _fill().loadSamples() : [];
  const items = new Array(work.length);
  let next = 0;
  const readOne = async (t) => {
    const base = { orderId: String(t.id), seq: Number(t.seq), day: t.day };
    if (!t.capture_file_id) return { ...base, status: 'no_capture' };
    const rd = await _fill().readCaptureText(t.capture_file_id, samples);
    if (rd.status !== 'read') return { ...base, ...rd };
    const value = classifyCaptureCandidate({ productName: rd.name, productOption: rd.opt }, candidates);
    return value ? { ...base, status: 'matched', read: rd.read, optKey: value, product: value } : { ...base, status: 'ambiguous', read: rd.read };
  };
  const runner = async () => { while (next < work.length) { const i = next++; items[i] = await readOne(work[i]); } };
  await Promise.all(Array.from({ length: Math.min(_fill().AI_CONCURRENCY, work.length) }, runner));
  const count = (s) => items.filter(x => x.status === s).length;
  return {
    ok: true, target: 'classify', campaignId: camp.id, title: camp.title, column: CLASSIFY_COLUMN,
    // 결정 232 화면 표(고르는 칸)를 그대로 쓰도록 같은 모양 — 후보가 곧 선택지다.
    options: candidates.map(c => ({ optKey: c, productName: c, status: 'active' })),
    total: targets.length, offset: off, scanned: work.length,
    truncated: Math.max(0, targets.length - off - work.length),
    nextOffset: off + work.length < targets.length ? off + work.length : null,
    matched: count('matched'),
    needsHuman: work.length - count('matched'),
    items,
  };
}

/**
 * ② 적용 — 사람이 본 picks 를 그대로 적는다(AI 재실행 없음). 서버 재확인: 이 공고 주문인가 · 「분류」가 아직 빈가 · 후보에 있는 값인가.
 * @param picks [{orderId, optKey(=후보), source:'capture'|'manual'}]
 */
async function applyCaptureClassify({ campaignId, picks = [], by = 'system' } = {}) {
  const db = getPool();
  const { camp, candidates } = await _loadClassifyCampaign(db, campaignId);
  // ★ Codex 리뷰 #1843: 고른 줄을 전부 적는다(200건 뒤를 말없이 버리지 않는다) — 지나치게 큰 요청만 통째로 거절(결정 232 와 같은 상한).
  const APPLY_MAX = _fill().APPLY_MAX;
  const raw = Array.isArray(picks) ? picks : [];
  if (raw.length > APPLY_MAX) throw new ClassifyError('too_many', `한 번에 ${APPLY_MAX}건까지만 적용합니다 — 나눠서 적용해 주세요.`);
  const list = raw
    .map(p => ({ orderId: String((p && p.orderId) || ''), optKey: String((p && p.optKey) || ''), source: p && p.source === 'manual' ? 'manual' : 'capture' }))
    .filter(p => p.orderId && p.optKey);
  if (!list.length) throw new ClassifyError('no_picks', '적용할 줄이 없습니다.');
  const byNorm = new Map(candidates.map(c => [_norm(c.normalize('NFKC')), c]));
  const existing = await _findColumn(db, camp.linked_sheet_id, camp.linked_tab_name);
  const targets = new Set((await _loadClassifyTargets(db, camp, existing)).map(t => String(t.id)));
  const results = [];
  const todo = [];
  for (const p of list) {
    const value = byNorm.get(_norm(p.optKey.normalize('NFKC')));
    if (!value) { results.push({ ...p, ok: false, reason: 'unknown_candidate', message: '분류 후보에 없는 값입니다' }); continue; }
    if (!targets.has(p.orderId)) { results.push({ ...p, ok: false, reason: 'not_target', message: '이미 분류가 적혀 있거나 이 공고 주문이 아닙니다' }); continue; }
    todo.push({ ...p, value });
  }
  if (!todo.length) return { ok: true, target: 'classify', campaignId: camp.id, written: 0, results };
  const col = await ensureClassifyColumn({ sheetId: camp.linked_sheet_id, tabName: camp.linked_tab_name, by }, db);
  let written = 0;
  for (const p of todo) {
    const who = (p.source === 'manual' ? `수동지정(${String(by).slice(0, 60)})` : `AI 캡처판독(${String(by).slice(0, 60)})`);
    if (await _writeBlankOnly(db, col.id, p.orderId, p.value, who)) { results.push({ orderId: p.orderId, optKey: p.value, source: p.source, ok: true }); written++; }
    else results.push({ orderId: p.orderId, optKey: p.value, source: p.source, ok: false, reason: 'already_filled', message: '분류가 이미 적혀 있어 덮지 않았습니다' });
  }
  logger.info(`[classify] ${camp.id} 적용 ${written}/${list.length} by=${by}`);
  return { ok: true, target: 'classify', campaignId: camp.id, written, columnAdded: col.created, results };
}

/**
 * 작업보드 응답용 — 이 작업표가 분류 공고의 작업표면 { campaignId, columnId, candidates } (내부 화면이 「분류」 칸 머리글 메뉴에 쓴다).
 * 조회 실패·대상 아님 = null(종전 화면 그대로).
 */
async function classifyColumnForTab(db, { sheetId, tabName, customColumns = [] } = {}) {
  if (!sheetId || !tabName) return null;
  const cid = await _campaignForTab(db, sheetId, tabName);
  if (!cid) return null;
  let loaded;
  try { loaded = await _loadClassifyCampaign(db, cid); } catch (e) { if (e instanceof ClassifyError) return null; throw e; }
  const col = (customColumns || []).find(c => c && (c.colName === CLASSIFY_COLUMN || c.col_name === CLASSIFY_COLUMN));
  return { campaignId: loaded.camp.id, columnId: col ? String(col.id) : null, column: CLASSIFY_COLUMN, candidates: loaded.candidates };
}

module.exports = {
  CLASSIFY_COLUMN, ClassifyError,
  ensureClassifyColumn, ensureClassifyColumnForCampaign, classifyFromSubmitCapture,
  previewCaptureClassify, applyCaptureClassify, classifyColumnForTab,
  __setPoolForTest,
};
