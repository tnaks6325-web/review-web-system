/**
 * reviewPhotoRelink.service.js — 리뷰 사진을 "지금 그 사람의 줄"로 다시 잇는 일회성 정정 도구
 * (2026-10-02 · 결정 186 별건 "리뷰 사진이 다른 사람 줄에 붙어 있다" · migration 172)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 왜 있나
 *   시트 시절(5~8월) 시트에서 줄을 끼우거나 지우거나 정렬하면 사람 정보는 새 행 번호로 갔는데
 *   (indexBuilder·smartBuild·importTabFromIndex 가 행 번호 기준 upsert), 사진 연결
 *   (review_submissions.row_index · review_inspections.row_index · review_index.review_file_id)은
 *   **옛 번호에 남았다**. 그래서 작업보드·업체 화면에서 줄에 남의 리뷰 사진이 보이고,
 *   리뷰어 `/my-files` 는 지금 그 번호의 사람에게 남의 사진을 보여 준다.
 *
 * ★★ 대상은 "확정" 기준을 **모두** 통과한 사진만(레드팀 R1~R3·R6 반영 — 완화 금지)
 *   ① 리뷰 슬롯 · 휴지통 아님 · 2026-09-01 이전 업로드(시트 시절 상한 — 무시트 시대 정상 사진 제외)
 *   ② 지금 줄의 사람(작업표 이름·수취인)도, **지금 줄 주문의 주문자·수취인**도 사진 이름과 다르다
 *      (주문자=사진 이름이면 타계정 참여 — 본계정 이름으로 올라간 정상 사진)
 *   ③ 같은 작업의 **활성 줄 중 그 이름이 딱 하나** · 그 줄 주문의 주문자 또는 수취인이 사진 이름
 *   ④ 대상 줄에 같은 이름의 리뷰 사진이 아직 없다
 *   ⑤ 교체요청(old/new)에 걸린 파일 · 직원이 교체한 파일(staff_file_replacement) 제외
 *   ⑥ 시트 없이 도는 작업(tab_configs.sheetless)만 — 시트 작업은 smartBuild 가 행 번호로 다시 덮는다
 *
 * ★★ 실행 규율
 *   · 미리보기 = 쓰기 0. 실행은 confirm:true + 화면이 본 (파일·출발 줄·도착 줄) 세 값이
 *     트랜잭션 안에서 **다시 계산한 계획과 정확히 같을 때만**(R14).
 *   · 작업 하나 = 트랜잭션 하나. 하나라도 어긋나면 그 작업 전체를 되돌린다(R4).
 *   · 대표 이미지는 **옮긴 사진에 해당할 때만** 고친다(R8): 출발 줄 대표가 옮긴 사진이면
 *     남은 사진 중 최신(없으면 비움), 도착 줄 대표가 비었거나 거기서 옮겨 나간 사진이면 옮겨 온 사진.
 *     review_index 행이 없는 줄은 건드리지 않는다(R5 — 오류 아님).
 *   · 이력(review_photo_relinks)에 바꾸기 전 값을 남긴다. 되돌리기는 "아직 도착 줄에 있는 사진만"
 *     조건부로 출발 줄로 돌린다(R7 — 그 뒤 교체·정리된 사진은 건드리지 않는다).
 *   · is_submitted·입금·주문 연결은 건드리지 않는다.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const crypto = require('crypto');
const { logger } = require('../utils/logger');

let _pool = null;
function _db() { return _pool || (_pool = require('../db/pool')); }
function __setPoolForTest(p) { _pool = p || null; }

const SHEET_ERA_END = '2026-09-01';
const MAX_ITEMS = 1000;

class RelinkError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/* 계획 SQL — 확정 기준 ①~⑥. $1 sheetId · $2 tabName (둘 다 NULL 이면 전 작업 요약용). */
function planSql() {
  return `
  WITH cp AS (
    SELECT sheet_id, tab_name, seq, order_submission_id,
           REPLACE(COALESCE(reviewer_name,''),' ','') AS n1,
           REPLACE(COALESCE(recipient_name,''),' ','') AS n2
      FROM campaign_participants
     WHERE deleted_at IS NULL AND active = TRUE
       AND ($1::text IS NULL OR sheet_id = $1) AND ($2::text IS NULL OR tab_name = $2)
  ), rs AS (
    SELECT s.id AS rs_id, s.sheet_id, s.tab_name, s.row_index, s.file_id, s.review_index_id,
           REPLACE(COALESCE(s.reviewer_name,''),' ','') AS nm,
           COALESCE(s.uploaded_at, s.created_at) AS at
      FROM review_submissions s
      JOIN tab_configs tc ON tc.sheet_id = s.sheet_id AND tc.tab_name = s.tab_name AND tc.sheetless = TRUE
     WHERE COALESCE(s.slot_key, 'review') = 'review'
       AND s.row_index IS NOT NULL AND s.file_id IS NOT NULL
       AND COALESCE(s.reviewer_name, '') <> ''
       AND COALESCE(s.uploaded_at, s.created_at) < $3::timestamptz
       AND ($1::text IS NULL OR s.sheet_id = $1) AND ($2::text IS NULL OR s.tab_name = $2)
       AND NOT EXISTS (SELECT 1 FROM review_edit_requests er
                        WHERE er.old_file_id = s.file_id OR er.new_file_id = s.file_id)
       AND NOT EXISTS (SELECT 1 FROM review_inspections ins
                        WHERE ins.file_id = s.file_id
                          AND ins.checks -> 'replacement' ->> 'reason' = 'staff_file_replacement')
  ), here AS (
    SELECT rs.*, os.id AS here_os
      FROM rs
      JOIN cp h ON h.sheet_id = rs.sheet_id AND h.tab_name = rs.tab_name AND h.seq = rs.row_index
      JOIN order_submissions os ON os.id = h.order_submission_id
     WHERE h.n1 <> rs.nm AND h.n2 <> rs.nm
       AND REPLACE(COALESCE(os.orderer,''),' ','') <> rs.nm
       AND REPLACE(COALESCE(os.recipient,''),' ','') <> rs.nm
  ), uniq AS (
    SELECT here.*, (SELECT COUNT(*) FROM cp e
                     WHERE e.sheet_id = here.sheet_id AND e.tab_name = here.tab_name
                       AND (e.n1 = here.nm OR e.n2 = here.nm)) AS name_rows
      FROM here
  )
  SELECT u.rs_id, u.sheet_id AS "sheetId", u.tab_name AS "tabName", u.file_id AS "fileId",
         u.row_index AS "fromRow", e.seq AS "toRow", u.review_index_id AS "fromReviewIndexId",
         to_char(u.at, 'YYYY-MM-DD') AS "uploadedAt"
    FROM uniq u
    JOIN cp e ON e.sheet_id = u.sheet_id AND e.tab_name = u.tab_name AND (e.n1 = u.nm OR e.n2 = u.nm)
    JOIN order_submissions os2 ON os2.id = e.order_submission_id
   WHERE u.name_rows = 1
     AND e.seq <> u.row_index
     AND (REPLACE(COALESCE(os2.orderer,''),' ','') = u.nm OR REPLACE(COALESCE(os2.recipient,''),' ','') = u.nm)
     AND NOT EXISTS (SELECT 1 FROM review_submissions x
                      WHERE x.sheet_id = u.sheet_id AND x.tab_name = u.tab_name AND x.row_index = e.seq
                        AND COALESCE(x.slot_key, 'review') = 'review'
                        AND REPLACE(COALESCE(x.reviewer_name,''),' ','') = u.nm)
   ORDER BY u.row_index, u.file_id`;
}

/* 2단계 기준(2026-10-02 · 사용자 승인) — 1단계에서 근거 부족으로 빠진 사진용. 공통 조건은 같다:
   리뷰 슬롯·시트 시절·교체요청/직원 교체 제외 · 지금 줄 사람과 이름 다름 · 같은 이름 활성 줄 딱 하나 ·
   대상 줄에 같은 이름 사진 없음 · 타계정(지금 줄 주문자=사진 이름) 제외 · 시트 작업(sheetless=FALSE) 제외.
   여기에 근거 **하나 이상**:
     (가) 대상 줄 주문의 주문자·수취인 = 사진 이름 (지금 줄 주문은 사진 이름이 아님)
     (나) 리뷰 화면 작성자 이름(OCR)이 대상 줄 사람과 맞고 지금 줄 사람과는 다름
     (다) 그 작업 후보의 다수(≥10장·≥60%)가 같은 칸 수만큼 밀렸고 이 사진도 그 칸 수
   ★★ 반대 증거 제외(완화 금지): OCR 작성자가 **지금 줄 사람**과 맞으면 어떤 근거가 있어도 옮기지 않는다.
   ★ tab_configs 행이 아예 없는 작업도 포함 — smartBuild 는 tab_configs 로 대상을 고르므로 행 번호로 다시 덮이지 않는다. */
function planSqlTier2() {
  const NM = (c) => `REPLACE(COALESCE(${c},''),' ','')`;
  const NAMEISH = (o) => `(${o} IS NOT NULL AND ${o} !~ '^[A-Za-z0-9_.*-]+$')`;
  const LIKE_NM = (o, p) => `(${p} IS NOT NULL AND ${p} <> '' AND left(${o},1)=left(${p},1) AND (right(${o},1)=right(${p},1) OR right(${o},1)='*'))`;
  return `
  WITH cp AS (
    SELECT sheet_id, tab_name, seq, order_submission_id,
           ${NM('reviewer_name')} AS n1, ${NM('recipient_name')} AS n2,
           REPLACE(COALESCE(NULLIF(recipient_name,''), reviewer_name, ''),' ','') AS disp
      FROM campaign_participants
     WHERE deleted_at IS NULL AND active = TRUE
       AND ($1::text IS NULL OR sheet_id = $1) AND ($2::text IS NULL OR tab_name = $2)
  ), rs AS (
    SELECT s.id AS rs_id, s.sheet_id, s.tab_name, s.row_index, s.file_id, s.review_index_id,
           ${NM('s.reviewer_name')} AS nm, COALESCE(s.uploaded_at, s.created_at) AS at,
           NULLIF(${NM('i.ocr_author')},'') AS ocr
      FROM review_submissions s
      LEFT JOIN review_inspections i ON i.file_id = s.file_id
     WHERE COALESCE(s.slot_key, 'review') = 'review'
       AND s.row_index IS NOT NULL AND s.file_id IS NOT NULL AND COALESCE(s.reviewer_name, '') <> ''
       AND COALESCE(s.uploaded_at, s.created_at) < $3::timestamptz
       AND ($1::text IS NULL OR s.sheet_id = $1) AND ($2::text IS NULL OR s.tab_name = $2)
       AND NOT EXISTS (SELECT 1 FROM tab_configs tc WHERE tc.sheet_id = s.sheet_id AND tc.tab_name = s.tab_name AND tc.sheetless IS FALSE)
       AND NOT EXISTS (SELECT 1 FROM review_edit_requests er WHERE er.old_file_id = s.file_id OR er.new_file_id = s.file_id)
       AND NOT EXISTS (SELECT 1 FROM review_inspections x WHERE x.file_id = s.file_id
                         AND x.checks -> 'replacement' ->> 'reason' = 'staff_file_replacement')
  ), c AS (
    SELECT rs.*, h.seq AS hseq, h.disp AS hdisp, h.order_submission_id AS hos,
           (SELECT COUNT(*) FROM cp e WHERE e.sheet_id = rs.sheet_id AND e.tab_name = rs.tab_name AND (e.n1 = rs.nm OR e.n2 = rs.nm)) AS name_rows
      FROM rs LEFT JOIN cp h ON h.sheet_id = rs.sheet_id AND h.tab_name = rs.tab_name AND h.seq = rs.row_index
     WHERE EXISTS (SELECT 1 FROM cp WHERE cp.sheet_id = rs.sheet_id AND cp.tab_name = rs.tab_name)
       AND NOT (h.seq IS NOT NULL AND (h.n1 = rs.nm OR h.n2 = rs.nm))
  ), t AS (
    SELECT c.*, e.seq AS tgt, e.disp AS tdisp, e.order_submission_id AS tos, (e.seq - c.row_index) AS shift
      FROM c JOIN cp e ON e.sheet_id = c.sheet_id AND e.tab_name = c.tab_name AND (e.n1 = c.nm OR e.n2 = c.nm)
     WHERE c.name_rows = 1 AND e.seq <> c.row_index
       AND NOT EXISTS (SELECT 1 FROM review_submissions x WHERE x.sheet_id = c.sheet_id AND x.tab_name = c.tab_name AND x.row_index = e.seq
                         AND COALESCE(x.slot_key, 'review') = 'review' AND ${NM('x.reviewer_name')} = c.nm)
       AND NOT EXISTS (SELECT 1 FROM order_submissions o WHERE o.id = c.hos AND ${NM('o.orderer')} = c.nm)
  ), ev AS (
    SELECT t.*,
      (t.tos IS NOT NULL
        AND EXISTS (SELECT 1 FROM order_submissions o WHERE o.id = t.tos AND (${NM('o.orderer')} = t.nm OR ${NM('o.recipient')} = t.nm))
        AND NOT EXISTS (SELECT 1 FROM order_submissions o WHERE o.id = t.hos AND (${NM('o.orderer')} = t.nm OR ${NM('o.recipient')} = t.nm))) AS ev_order,
      (${NAMEISH('t.ocr')} AND ${LIKE_NM('t.ocr', 't.tdisp')} AND NOT ${LIKE_NM('t.ocr', 't.hdisp')}) AS ev_ocr,
      (${NAMEISH('t.ocr')} AND ${LIKE_NM('t.ocr', 't.hdisp')} AND NOT ${LIKE_NM('t.ocr', 't.tdisp')}) AS contra,
      (SELECT MODE() WITHIN GROUP (ORDER BY t2.shift) FROM t t2 WHERE t2.sheet_id = t.sheet_id AND t2.tab_name = t.tab_name) AS mshift,
      (SELECT COUNT(*) FROM t t2 WHERE t2.sheet_id = t.sheet_id AND t2.tab_name = t.tab_name) AS tn
      FROM t
  ), ev2 AS (
    SELECT ev.*, (SELECT COUNT(*) FROM ev e3 WHERE e3.sheet_id = ev.sheet_id AND e3.tab_name = ev.tab_name AND e3.shift = ev.mshift) AS mcount
      FROM ev
  )
  SELECT rs_id, sheet_id AS "sheetId", tab_name AS "tabName", file_id AS "fileId",
         row_index AS "fromRow", tgt AS "toRow", review_index_id AS "fromReviewIndexId",
         to_char(at, 'YYYY-MM-DD') AS "uploadedAt",
         ev_order AS "evOrder", ev_ocr AS "evOcr", (shift = mshift AND mcount >= 10 AND mcount::float / tn >= 0.6) AS "evShift"
    FROM ev2
   WHERE NOT contra
     AND (ev_order OR ev_ocr OR (shift = mshift AND mcount >= 10 AND mcount::float / tn >= 0.6))
   ORDER BY row_index, file_id`;
}

async function _plan(q, sheetId, tabName, tier = 1) {
  const sql = Number(tier) === 2 ? planSqlTier2() : planSql();
  const { rows } = await q.query(sql, [sheetId || null, tabName || null, SHEET_ERA_END]);
  return rows;
}

/** 전 작업 요약 — 쓰기 0. 작업별 대상 장수. */
async function summary({ tier = 1 } = {}) {
  const rows = await _plan(_db(), null, null, tier);
  const by = new Map();
  for (const r of rows) {
    const k = `${r.sheetId}\t${r.tabName}`;
    if (!by.has(k)) by.set(k, { sheetId: r.sheetId, tabName: r.tabName, count: 0 });
    by.get(k).count++;
  }
  return { ok: true, tier: Number(tier) === 2 ? 2 : 1, total: rows.length, tabs: [...by.values()].sort((a, b) => b.count - a.count) };
}

/** 작업 하나 미리보기 — 쓰기 0. */
async function preview({ sheetId, tabName, tier = 1 } = {}) {
  if (!sheetId || !tabName) throw new RelinkError('bad_request', 'sheetId, tabName 이 필요합니다.');
  const items = (await _plan(_db(), sheetId, tabName, tier)).map(_view);
  return { ok: true, dryRun: true, tier: Number(tier) === 2 ? 2 : 1, sheetId, tabName, total: items.length, items };
}

function _view(r) {
  const v = { fileId: r.fileId, fromRow: Number(r.fromRow), toRow: Number(r.toRow), uploadedAt: r.uploadedAt };
  if (r.evOrder !== undefined) v.evidence = { order: !!r.evOrder, reviewName: !!r.evOcr, shift: !!r.evShift };
  return v;
}
const _key = (x) => `${x.fileId}|${Number(x.fromRow)}|${Number(x.toRow)}`;

async function _repOf(c, sheetId, tabName, row) {
  const { rows } = await c.query(
    `SELECT review_file_id FROM review_index WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 LIMIT 1`,
    [sheetId, tabName, row]);
  return rows.length ? { exists: true, rep: rows[0].review_file_id || null } : { exists: false, rep: null };
}

/* 줄의 대표 이미지를 정한다 — preferFileId 가 있으면 그것, 없으면 남은 리뷰 사진 중 최신(없으면 비움). */
async function _setRep(c, sheetId, tabName, row, preferFileId) {
  const { rows } = await c.query(
    `SELECT file_id, file_url, file_name, COALESCE(uploaded_at, created_at) AS at
       FROM review_submissions
      WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND COALESCE(slot_key,'review')='review'
      ORDER BY COALESCE(uploaded_at, created_at) DESC NULLS LAST`, [sheetId, tabName, row]);
  const pick = (preferFileId && rows.find(r => r.file_id === preferFileId)) || rows[0] || null;
  const res = pick
    ? await c.query(
        `UPDATE review_index SET review_file_id=$1, review_file_url=$2, review_file_name=$3,
                review_file_count=$4, review_file_at=COALESCE($5, review_file_at)
          WHERE sheet_id=$6 AND tab_name=$7 AND row_index=$8`,
        [pick.file_id, pick.file_url, pick.file_name, rows.length, pick.at, sheetId, tabName, row])
    : await c.query(
        `UPDATE review_index SET review_file_id=NULL, review_file_url=NULL, review_file_name=NULL, review_file_count=0
          WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3`, [sheetId, tabName, row]);
  return res.rowCount;
}

/* 대표 이미지가 "다른 줄로 가 버린 사진"을 가리키는가 — 원장(rs)에 그 파일이 있고 그 줄이 아니면 true.
   ★ 원장(032) 이전의 옛 대표 이미지(rs 에 행 없음)는 false — 그것까지 낡았다고 보면 유일한 증빙을 덮는다(R8-d). */
async function _repElsewhere(c, sheetId, tabName, row, rep) {
  if (!rep) return false;
  const { rows } = await c.query(
    `SELECT 1 FROM review_submissions WHERE file_id=$1 AND sheet_id=$2 AND tab_name=$3
        AND (row_index IS DISTINCT FROM $4 OR COALESCE(slot_key,'review') <> 'review') LIMIT 1`,
    [rep, sheetId, tabName, row]);
  return rows.length > 0;
}

async function _lockRows(c, sheetId, tabName, rowsSet) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sheetless_ledger:${sheetId}:${tabName}`]);
  for (const row of [...rowsSet].sort((a, b) => a - b)) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`review_file:${sheetId}|${tabName}|${row}`]);
  }
}

/**
 * 실행 — confirm:true + items(화면이 본 파일·출발·도착)가 다시 계산한 계획과 정확히 같아야 한다.
 * @returns {{ok, runId, moved, repChanged}}
 */
async function apply({ sheetId, tabName, items, confirm = false, by = '', tier = 1 } = {}) {
  if (!sheetId || !tabName) throw new RelinkError('bad_request', 'sheetId, tabName 이 필요합니다.');
  if (confirm !== true) throw new RelinkError('confirm_required', '미리보기로 확인한 뒤 confirm:true 로 실행하세요.');
  const want = Array.isArray(items) ? items : [];
  if (!want.length) throw new RelinkError('empty', '옮길 사진(items)을 지정하세요.');
  if (want.length > MAX_ITEMS) throw new RelinkError('too_many', `한 번에 ${MAX_ITEMS}장까지만 처리합니다.`);

  const pool = _db();
  const c = await pool.connect();
  const runId = crypto.randomUUID();
  let committed = false;
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '5s'`);
    const rowsSet = new Set();
    want.forEach(x => { rowsSet.add(Number(x.fromRow)); rowsSet.add(Number(x.toRow)); });
    await _lockRows(c, sheetId, tabName, rowsSet);

    // ★ 잠금 뒤 다시 계산 — 화면이 본 세 값과 하나라도 다르면 전체 거부(R14)
    const plan = await _plan(c, sheetId, tabName, tier);
    const planMap = new Map(plan.map(p => [_key(p), p]));
    const stale = want.filter(x => !planMap.has(_key(x)));
    if (stale.length) {
      throw new RelinkError('plan_changed',
        `미리보기 뒤 상황이 바뀐 사진이 ${stale.length}장 있습니다 — 미리보기를 다시 불러 확인해 주세요.`, 409);
    }
    const chosen = want.map(x => planMap.get(_key(x)));

    // 대표 이미지 — 적용 전 값을 먼저 읽어 둔다
    const repBefore = new Map();
    for (const row of rowsSet) repBefore.set(row, await _repOf(c, sheetId, tabName, row));

    const movedOut = new Map();   // row → Set(fileId) 옮겨 나간 것
    const movedIn = new Map();    // row → [fileId] 옮겨 온 것
    for (const p of chosen) {
      const from = Number(p.fromRow), to = Number(p.toRow);
      await c.query(
        `INSERT INTO review_photo_relinks
           (run_id, sheet_id, tab_name, rs_id, file_id, from_row, to_row, from_review_index_id,
            from_rep_before, to_rep_before, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [runId, sheetId, tabName, p.rs_id, p.fileId, from, to, p.fromReviewIndexId || null,
          repBefore.get(from).rep, repBefore.get(to).rep, String(by || '').slice(0, 100)]);
      const upd = await c.query(
        `UPDATE review_submissions
            SET row_index = $1,
                review_index_id = (SELECT id FROM review_index WHERE sheet_id=$2 AND tab_name=$3 AND row_index=$1 LIMIT 1)
          WHERE id = $4 AND file_id = $5 AND row_index = $6 AND sheet_id = $2 AND tab_name = $3`,
        [to, sheetId, tabName, p.rs_id, p.fileId, from]);
      if (upd.rowCount !== 1) throw new RelinkError('row_moved', `사진 ${p.fileId} 이(가) 그 사이 바뀌었습니다.`, 409);
      await c.query(
        `UPDATE review_inspections SET row_index = $1, updated_at = NOW()
          WHERE file_id = $2 AND sheet_id = $3 AND tab_name = $4`, [to, p.fileId, sheetId, tabName]);
      if (!movedOut.has(from)) movedOut.set(from, new Set());
      movedOut.get(from).add(p.fileId);
      if (!movedIn.has(to)) movedIn.set(to, []);
      movedIn.get(to).push(p.fileId);
    }

    // 대표 이미지 — 옮긴 사진에 해당하는 줄만(R8). 행이 없으면 건드리지 않는다(R5).
    let repChanged = 0;
    for (const row of rowsSet) {
      const b = repBefore.get(row);
      if (!b.exists) continue;
      const outHere = movedOut.get(row) || new Set();
      const inHere = movedIn.get(row) || [];
      const repLeft = !!b.rep && (outHere.has(b.rep) || await _repElsewhere(c, sheetId, tabName, row, b.rep));
      if (inHere.length && (!b.rep || repLeft)) {
        repChanged += await _setRep(c, sheetId, tabName, row, inHere[inHere.length - 1]);
      } else if (repLeft) {
        repChanged += await _setRep(c, sheetId, tabName, row, null);
      }
    }

    await c.query('COMMIT');
    committed = true;
    logger.info(`[reviewPhotoRelink] apply run=${runId} tab=${tabName} moved=${chosen.length} rep=${repChanged} by=${String(by).slice(0, 40)}`);
    return { ok: true, runId, moved: chosen.length, repChanged };
  } catch (err) {
    if (!committed) { try { await c.query('ROLLBACK'); } catch (_) { /* noop */ } }
    if (err && err.code === '42P01') throw new RelinkError('not_ready', '재연결 이력 표(migration 172)가 아직 없습니다 — 배포 완료 후 다시 시도하세요.', 503);
    if (err && err.code === '55P03') throw new RelinkError('busy', '그 작업에서 다른 처리가 진행 중입니다 — 잠시 후 다시 시도하세요.', 409);
    throw err;
  } finally {
    c.release();
  }
}

/** 되돌리기 — 아직 도착 줄에 있는 사진만 출발 줄로(R7). confirm:true 필수. */
async function revert({ runId, confirm = false, by = '' } = {}) {
  if (!runId) throw new RelinkError('bad_request', 'runId 가 필요합니다.');
  if (confirm !== true) throw new RelinkError('confirm_required', 'confirm:true 로 실행하세요.');
  const pool = _db();
  const c = await pool.connect();
  let committed = false;
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '5s'`);
    const { rows: logs } = await c.query(
      `SELECT * FROM review_photo_relinks WHERE run_id = $1 AND reverted_at IS NULL ORDER BY id`, [runId]);
    if (!logs.length) { await c.query('ROLLBACK'); return { ok: true, runId, reverted: 0, skipped: 0 }; }
    const { sheet_id: sheetId, tab_name: tabName } = logs[0];
    const rowsSet = new Set();
    logs.forEach(l => { rowsSet.add(l.from_row); rowsSet.add(l.to_row); });
    await _lockRows(c, sheetId, tabName, rowsSet);

    let reverted = 0, skipped = 0;
    const back = new Map();   // from_row → [fileId]
    const away = new Map();   // to_row → Set(fileId)
    for (const l of logs) {
      const upd = await c.query(
        `UPDATE review_submissions
            SET row_index = $1,
                review_index_id = (SELECT id FROM review_index WHERE sheet_id=$2 AND tab_name=$3 AND row_index=$1 LIMIT 1)
          WHERE id = $4 AND file_id = $5 AND row_index = $6`,
        [l.from_row, sheetId, tabName, l.rs_id, l.file_id, l.to_row]);
      if (upd.rowCount !== 1) { skipped++; continue; }   // 그 뒤 바뀐 사진은 건드리지 않는다
      await c.query(
        `UPDATE review_inspections SET row_index = $1, updated_at = NOW() WHERE file_id = $2 AND row_index = $3`,
        [l.from_row, l.file_id, l.to_row]);
      await c.query(`UPDATE review_photo_relinks SET reverted_at = NOW(), reverted_by = $2 WHERE id = $1`,
        [l.id, String(by || '').slice(0, 100)]);
      reverted++;
      if (!back.has(l.from_row)) back.set(l.from_row, []);
      back.get(l.from_row).push(l.file_id);
      if (!away.has(l.to_row)) away.set(l.to_row, new Set());
      away.get(l.to_row).add(l.file_id);
    }
    for (const row of rowsSet) {
      const b = await _repOf(c, sheetId, tabName, row);
      if (!b.exists) continue;
      const inHere = back.get(row) || [];
      const leftHere = !!b.rep && ((away.get(row) || new Set()).has(b.rep) || await _repElsewhere(c, sheetId, tabName, row, b.rep));
      if (inHere.length && (!b.rep || leftHere)) await _setRep(c, sheetId, tabName, row, inHere[inHere.length - 1]);
      else if (leftHere) await _setRep(c, sheetId, tabName, row, null);
    }
    await c.query('COMMIT');
    committed = true;
    logger.info(`[reviewPhotoRelink] revert run=${runId} reverted=${reverted} skipped=${skipped}`);
    return { ok: true, runId, reverted, skipped };
  } catch (err) {
    if (!committed) { try { await c.query('ROLLBACK'); } catch (_) { /* noop */ } }
    if (err && err.code === '42P01') throw new RelinkError('not_ready', '재연결 이력 표(migration 172)가 아직 없습니다.', 503);
    if (err && err.code === '55P03') throw new RelinkError('busy', '그 작업에서 다른 처리가 진행 중입니다 — 잠시 후 다시 시도하세요.', 409);
    throw err;
  } finally {
    c.release();
  }
}

module.exports = { summary, preview, apply, revert, RelinkError, SHEET_ERA_END, __setPoolForTest, __planSqlForTest: planSql, __planSqlTier2ForTest: planSqlTier2 };
