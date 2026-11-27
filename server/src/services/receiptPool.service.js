/**
 * receiptPool.service.js — 영수증리뷰 영수증 묶음 저장·조회 + 비공개 영수증 사진 목록 (결정 418·420 · migration 230).
 *
 * 영수증 묶음 = 접수 때 작업오더 계약에서 **한 번** 만든다(`utils/receiptPool` 순수 생성기 → 여기서 저장).
 *   한 줄 = 영수증 한 장 = 리뷰어 한 명 자리. 작업표 줄(campaign_participants)은 그 자리를 칸(「영수증」 N번)으로 보여 줄 뿐이고,
 *   3단계 참여 때 「안 쓴 영수증 한 장」을 고르는 기준은 이 표다(campaign_applications.receipt_pool_id + 부분 유일 색인 — 3단계).
 *
 * ★★ 이 표가 있거나 탭 종류가 receipt 인 탭 = 영수증 탭. 작업표를 손보는 자동 작업(빈 줄 날짜 옮기기·총 건수 맞추기·
 *   빈 줄 정리·아무 빈 줄에나 주문 끼우기·줄 정리·날짜 고치기)은 이 판정으로 영수증 탭을 건너뛴다 —
 *   영수증 줄에 날짜를 지어 붙이거나(참여일자는 참여할 때 생긴다) 영수증 자리를 지우면 안 된다.
 * ★ 판정 실패는 **영수증 탭으로 본다**(fail-closed) — 자동 작업 하나를 쉬는 것이 자리를 지우는 것보다 싸다.
 *   표 존재는 기동 필수 표 검사(index.js REQUIRED_TABLES)가 보장한다.
 * ★★ 트랜잭션 안에서도 불린다 — 조회 실패가 바깥 트랜잭션을 죽이지 않게 SAVEPOINT 로 감싼다(qnaSlots·bookingSlots 와 같은 규율).
 * ★ 예약 자리표(booking_slots)·Q&A 자리표(qna_slots)와 표를 나눈 이유: 그 판정(`isBookingTab`·`isQnaTab` = 자리표 존재)이
 *   영수증 탭을 자기 탭으로 읽으면 날짜 신청·캡처 기한 스윕·추가 모집이 영수증 탭에 붙는다.
 *
 * ★★ 비공개 영수증 사진 목록(receipt_review_files) — 결정 352 사진 통로의 **거절 목록**(imageAllowlist.PRIVATE_SOURCES)이다.
 *   올리기(`POST /api/order/receipt-review-image`)가 주소를 돌려주기 전에 여기 적고, 접수는 계약의 파일 번호가 **전부** 여기 있을 때만
 *   묶음을 깐다(`insertPool` — 없으면 던진다). 그래서 직원·리뷰어 통로가 꺼내 주는 파일은 언제나 「영수증으로 올라온 사진」뿐이다.
 */
'use strict';

const { logger } = require('../utils/logger');
const { isReceiptFileId } = require('../utils/receiptPool');

function _pool() { return require('../db/pool'); }
const _inTx = db => !!(db && typeof db.release === 'function');   // 풀에서 빌린 연결 = 트랜잭션 중일 수 있다

/** 조회 하나를 SAVEPOINT 로 감싼다 — 실패하면 되돌리고 `onFail` 값을 돌려준다(던지지 않음). */
async function _probe(db, name, sql, params, read, onFail, what) {
  const q = db || _pool();
  let sp = false;
  try {
    if (_inTx(db)) {
      try { await q.query(`SAVEPOINT ${name}`); sp = true; } catch (_) { sp = false; }   // 트랜잭션 밖이면 그냥 조회
    }
    const r = await q.query(sql, params);
    if (sp) await q.query(`RELEASE SAVEPOINT ${name}`);
    return read(r && Array.isArray(r.rows) ? r.rows : []);
  } catch (e) {
    if (sp) await q.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    logger.warn(`[receiptPool] ${what} 판정 실패 — 안전 쪽으로 봄(fail-closed): ${e.message}`);
    return onFail;
  }
}

/* ── 비공개 영수증 사진 목록 ─────────────────────────────────────── */

/** 올린 영수증 사진을 비공개 목록에 적는다 — 실패하면 던진다(올리기 실패로 알린다 · 목록 밖 번호는 접수가 거절한다). */
async function registerReceiptUpload(fileId, { source = '', mimeType = '', by = '' } = {}, db = null) {
  const id = String(fileId || '');
  if (!isReceiptFileId(id)) throw Object.assign(new Error('영수증 파일 번호가 올바르지 않습니다.'), { code: 'receipt_file_invalid' });
  await (db || _pool()).query(
    `INSERT INTO receipt_review_files (file_id, source, mime_type, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (file_id) DO NOTHING`,
    [id, String(source || '').slice(0, 60), String(mimeType || '').slice(0, 100) || null, String(by || '').slice(0, 100) || null]);
}

/** 주어진 번호 중 비공개 목록에 없는 것. 조회 실패는 던진다(호출부가 접수를 멈춘다 — fail-closed). */
async function unregisteredFiles(db, fileIds = []) {
  const list = [...new Set((fileIds || []).map(String))];
  if (!list.length) return [];
  const { rows } = await (db || _pool()).query('SELECT file_id FROM receipt_review_files WHERE file_id = ANY($1::text[])', [list]);
  const have = new Set(rows.map(r => String(r.file_id)));
  return list.filter(id => !have.has(id));
}

/** 비공개 목록에 있는 영수증 사진인가(인트라넷 미리보기 통로). 조회 실패는 던진다(호출부가 500 — 내주지 않음). */
async function isRegisteredReceiptFile(fileId, db = null) {
  if (!isReceiptFileId(String(fileId || ''))) return false;
  const { rows } = await (db || _pool()).query('SELECT 1 FROM receipt_review_files WHERE file_id = $1 LIMIT 1', [String(fileId)]);
  return rows.length > 0;
}

/* ── 영수증 묶음 ─────────────────────────────────────────────────── */

/**
 * 묶음 저장 — 재접수·재시도에 안전(같은 자리는 ON CONFLICT DO NOTHING).
 * ★★ 파일 번호가 전부 비공개 목록에 있어야 한다 — 하나라도 없으면 아무것도 쓰지 않고 던진다(code receipt_file_unregistered).
 * @param {Array} p.slots  receiptPool 슬롯 + `rowSeq`(작업표 줄 번호)
 */
async function insertPool({ db, workOrderId, sheetId, tabName, slots = [], by = 'system' } = {}) {
  if (!slots.length) return { inserted: 0 };
  const q = db || _pool();
  const missing = await unregisteredFiles(q, slots.map(s => s.fileId));
  if (missing.length) {
    throw Object.assign(new Error(`영수증 ${missing.length}장이 영수증 올리기로 올라온 사진이 아닙니다 — 인트라넷에서 그 영수증을 다시 올려 보내 주세요.`),
      { code: 'receipt_file_unregistered', missing: missing.length });
  }
  const c = { seq: [], ps: [], fid: [] };
  for (const s of slots) {
    c.seq.push(Number.isInteger(s.rowSeq) ? s.rowSeq : null);
    c.ps.push(Number(s.poolSeq));
    c.fid.push(String(s.fileId));
  }
  const { rowCount } = await q.query(
    `INSERT INTO receipt_pool (work_order_id, sheet_id, tab_name, seq, pool_seq, file_id, created_by)
     SELECT $1, $2, $3, u.seq, u.ps, u.fid, $4
       FROM UNNEST($5::int[], $6::int[], $7::text[]) AS u(seq, ps, fid)
     ON CONFLICT DO NOTHING`,
    [String(workOrderId || ''), sheetId, tabName, String(by || 'system').slice(0, 100), c.seq, c.ps, c.fid],
  );
  return { inserted: rowCount || 0 };
}

/* 판정 = 묶음이 있거나, 탭이 영수증리뷰로 등록돼 있다(묶음 저장이 실패한 영수증 탭도 리뷰 탭처럼 정리되지 않게).
   탭 종류는 접수 때 tab_configs.work_kind 에 기록된다. */
const IS_RECEIPT_POOL_TAB_SQL = `SELECT (EXISTS (SELECT 1 FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2)
                                     OR EXISTS (SELECT 1 FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 AND work_kind = 'receipt')) AS b`;

/**
 * 이 탭이 영수증 탭인가.
 * @returns {Promise<boolean>} 조회 실패(표 없음 포함) = true(fail-closed — 자동 정리를 쉰다)
 */
async function isReceiptPoolTab(db, sheetId, tabName) {
  if (!sheetId || !tabName) return false;
  return _probe(db, 'receipt_pool_tab_probe', IS_RECEIPT_POOL_TAB_SQL, [sheetId, tabName], rows => !!(rows[0] && rows[0].b === true), true, '영수증 탭');
}

/**
 * 이 줄(seq)이 영수증 자리인가.
 * @returns {Promise<boolean>} 조회 실패 = true(묶인 것으로 본다 — 호출부가 안전 쪽으로 접는다)
 */
async function isPoolBoundRow(db, sheetId, tabName, seq) {
  return _probe(db, 'receipt_pool_bound_probe', 'SELECT 1 FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 LIMIT 1',
    [sheetId, tabName, Number(seq)], rows => rows.length > 0, true, '영수증 자리 묶임');
}

/**
 * 이 모집공고가 영수증 탭에 연결돼 있나(차수 같은 인원 조작을 막는 데 쓴다).
 * @returns {Promise<boolean>} 공고 없음/연결 없음 = false · 조회 실패 = true(fail-closed)
 */
async function isReceiptPoolCampaign(campaignId) {
  try {
    const { rows } = await _pool().query('SELECT linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id = $1', [String(campaignId)]);
    if (!rows.length || !rows[0].linked_sheet_id || !rows[0].linked_tab_name) return false;
    return await isReceiptPoolTab(null, rows[0].linked_sheet_id, rows[0].linked_tab_name);
  } catch (e) {
    logger.warn(`[receiptPool] 공고 영수증 판정 실패 — 막음(fail-closed): ${e.message}`);
    return true;
  }
}

/** 주어진 줄 번호 중 영수증 자리에 묶인 것. 조회 실패는 던진다(호출부가 정리를 멈춘다 — fail-closed). */
async function poolBoundSeqs(db, sheetId, tabName, seqs = []) {
  const list = [...new Set((seqs || []).map(n => parseInt(n, 10)).filter(Number.isFinite))];
  if (!list.length) return [];
  const { rows } = await (db || _pool()).query(
    'SELECT seq FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2 AND seq = ANY($3::int[]) ORDER BY seq',
    [sheetId, tabName, list]);
  return rows.map(r => Number(r.seq));
}

/** SQL 조각 — 이 줄(seq)이 영수증 자리에 묶여 있으면 참. 자동 삭제에서 `NOT (…)` 로 쓴다. */
function poolBoundRowSql(alias) {
  return `EXISTS (SELECT 1 FROM receipt_pool rcp WHERE rcp.sheet_id = ${alias}.sheet_id AND rcp.tab_name = ${alias}.tab_name AND rcp.seq = ${alias}.seq)`;
}

/** 탭의 묶음 전체 — 영수증 번호 순. ★ 파일 번호가 들어 있다 — 화면 응답에 그대로 싣지 말 것(직원 보기 통로만 쓴다). */
async function poolForTab(db, sheetId, tabName) {
  const { rows } = await (db || _pool()).query(
    `SELECT id, work_order_id, seq, pool_seq, file_id, status
       FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2
      ORDER BY pool_seq`, [sheetId, tabName]);
  return rows.map(r => ({ ...r, id: Number(r.id), seq: r.seq == null ? null : Number(r.seq), pool_seq: Number(r.pool_seq) }));
}

/**
 * 영수증 수 — 3단계 참여 화면의 재료(취소 제외).
 * ★ 2단계에는 신청 묶기가 없어 open = total 이다. 3단계가 신청 묶기(receipt_pool_id)를 더하면
 *   남은 영수증 = open − 묶인 살아 있는 신청 — 그 계산은 3단계가 잠금 안에서 한다(여기 값으로 넘침을 막지 않는다).
 */
async function poolCounts(db, sheetId, tabName) {
  const { rows } = await (db || _pool()).query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS total, COUNT(*) FILTER (WHERE status = 'open')::int AS open
       FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2`, [sheetId, tabName]);
  return { total: Number(rows[0] ? rows[0].total : 0), open: Number(rows[0] ? rows[0].open : 0) };
}

/** 작업표 줄 → 그 자리의 영수증 파일 번호(취소된 자리·없는 줄 = null). 직원 작업보드 보기 통로가 쓴다. */
async function fileForRow(db, sheetId, tabName, seq) {
  const n = parseInt(seq, 10);
  if (!sheetId || !tabName || !Number.isInteger(n)) return null;
  const { rows } = await (db || _pool()).query(
    `SELECT file_id FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND status <> 'cancelled' LIMIT 1`,
    [sheetId, tabName, n]);
  return rows.length ? String(rows[0].file_id) : null;
}

/**
 * 이미 깔린 작업표 줄이 이 계획 줄과 **줄마다 같은가** — 묶음을 그 줄 번호에 붙여도 되는지.
 * 비교 = 줄 번호마다 선택지(매장)·영수증 칸(묶음을 정하는 칸만 · 참여일자는 3단계에 채워지는 값이라 보지 않는다).
 * @returns {Promise<{ok:boolean, mismatches:number[]}>}
 */
async function verifyRowsMatchPool({ db, sheetId, tabName, planRows = [] } = {}) {
  const { RECEIPT_POOL_HEADER } = require('../utils/worktablePlan');
  const { rows } = await (db || _pool()).query(
    `SELECT seq, option_text, row_json FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND seq = ANY($3::int[])`,
    [sheetId, tabName, planRows.map(r => r.seq)]);
  const bySeq = new Map(rows.map(r => [Number(r.seq), r]));
  const t = v => String(v == null ? '' : v).trim();
  const mismatches = [];
  for (const pr of planRows) {
    const cur = bySeq.get(Number(pr.seq));
    const rj = (cur && cur.row_json && typeof cur.row_json === 'object') ? cur.row_json : {};
    const pj = pr.rowJson || {};
    const same = cur && t(cur.option_text) === t(pr.optionText).slice(0, 200) && t(rj[RECEIPT_POOL_HEADER]) === t(pj[RECEIPT_POOL_HEADER]);
    if (!same) mismatches.push(Number(pr.seq));
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * ★ 묶음 복구 — 작업표 줄은 깔렸는데 묶음 저장만 실패한 영수증 탭을 **재접수**로 되살린다.
 *   지금 오더 값으로 계획을 다시 만들고(같은 오더 = 같은 묶음), 깔린 줄과 줄마다 같을 때만 저장한다(fail-closed).
 */
async function repairPoolIfMissing({ workOrder, sheetId, tabName, by = 'admin' } = {}) {
  const q = _pool();
  const { rows: have } = await q.query('SELECT 1 FROM receipt_pool WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1', [sheetId, tabName]);
  if (have.length) return { ok: true, repaired: false, reason: 'present' };
  const { createSheetlessWorktable } = require('./sheetlessAccept.service');
  const made = await createSheetlessWorktable({ workOrder, tabName, by });
  if (!made.ok || !Array.isArray(made.receiptPoolSlots) || !made.receiptPoolSlots.length) {
    return { ok: false, repaired: false, reason: 'plan_failed', error: made.error || '영수증 묶음 계획을 만들 수 없습니다.' };
  }
  if (made.sheetId !== sheetId) return { ok: false, repaired: false, reason: 'sheet_mismatch', error: '작업표 위치가 오더와 다릅니다.' };
  const v = await verifyRowsMatchPool({ db: q, sheetId, tabName, planRows: made.rows });
  if (!v.ok) {
    return { ok: false, repaired: false, reason: 'rows_mismatch',
      error: `작업표 줄 ${v.mismatches.length}개가 지금 오더로 만든 영수증 묶음과 달라 다시 깔 수 없습니다(줄 ${v.mismatches.slice(0, 5).join(', ')}).` };
  }
  const r = await insertPool({ workOrderId: workOrder.id, sheetId, tabName, slots: made.receiptPoolSlots, by: `reaccept:${by}` });
  logger.info(`[receiptPool] 영수증 묶음 복구 ${r.inserted}/${made.receiptPoolSlots.length}장 tab=${tabName}`);
  return { ok: true, repaired: true, inserted: r.inserted };
}

/**
 * 영수증 사진 내보내기(직원·인트라넷 통로 공용) — 드라이브에서 받아 **사진일 때만** 보낸다.
 * ★ 캐시 금지(private, no-store) · 구글 썸네일로 돌리지 않는다(비공개 파일 — 돌리면 주소가 새로 생긴다).
 */
async function sendReceiptImage(res, fileId) {
  const drive = require('./drive.service');
  let f;
  try { f = await drive.downloadFile(fileId); } catch (e) {
    logger.warn(`[receiptPool] 영수증 사진 읽기 실패: ${e.message}`);
    res.set('Cache-Control', 'no-store');
    return res.status(502).json({ ok: false, error: '영수증 사진을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
  if (!/^image\//i.test(String(f && f.mimeType || ''))) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).send('not found');
  }
  res.set('Content-Type', f.mimeType);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  return res.send(f.buffer);
}

module.exports = {
  registerReceiptUpload, unregisteredFiles, isRegisteredReceiptFile,
  insertPool, isReceiptPoolTab, isReceiptPoolCampaign, isPoolBoundRow, poolBoundSeqs, poolBoundRowSql,
  poolForTab, poolCounts, fileForRow, verifyRowsMatchPool, repairPoolIfMissing, sendReceiptImage,
};
