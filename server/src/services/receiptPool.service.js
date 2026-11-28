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
const IS_RECEIPT_POOL_TAB_SQL = `SELECT ${require('../utils/receiptTabSql').receiptTabSql('$1', '$2')} AS b`;   // 판정 조각 단일 출처(utils/receiptTabSql)

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

/* ═══ ★★ 결정 434 — 3단계: 참여 = 안 쓴 영수증 한 장 배정 (migration 232) ═══
   영수증이 비었는지 판정은 **이 SQL 조각 하나**(`receiptTakenSql`)다 — 배정(pickReceiptInTx)·남은 영수증 수(공고 카드·정원)가 함께 쓴다.
     쓴 영수증 = ㉮ 그 영수증으로 리뷰를 낸 적 있음(reviewed_at) 또는 ㉯ 살아 있는 신청(제출 확정 · 유예 안의 홀드)이 쥐고 있음.
   ★★ 「되돌리기」 쓰기가 따로 없다 — 신청 표가 단일 출처라, 신청이 취소·만료·줄 삭제로 살아 있지 않게 되는 순간
     (campaignHoldChainSites ① 표의 모든 status 변경 자리) 영수증이 저절로 다음 참여자에게 돌아간다(예약 228 과 같은 방식).
     리뷰를 이미 낸 영수증은 ㉮ 때문에 돌아가지 않는다(사용자 확정 2026-11-27). */

/** SQL 조각 — 이 영수증(alias)이 쓰였다(리뷰 냄 · 또는 살아 있는 신청이 쥠). graceParam = 홀드 유예 초 자리 번호. */
function receiptTakenSql(alias, graceParam) {
  return `(${alias}.reviewed_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM campaign_applications ca
                       WHERE ca.receipt_pool_id = ${alias}.id
                         AND (ca.status = 'submitted'
                              OR (ca.status = 'applied' AND (ca.expires_at IS NULL OR ca.expires_at > NOW() - make_interval(secs => ${graceParam}))))))`;
}

/** 탭의 남은 영수증 — { total(취소 제외), free(아직 아무에게도 안 간 장) }. */
async function freeCountsForTab(db, sheetId, tabName) {
  const grace = require('./campaignHold.service').HOLD_GRACE_SEC;
  const { rows } = await (db || _pool()).query(
    `SELECT COUNT(*) FILTER (WHERE p.status <> 'cancelled')::int AS total,
            COUNT(*) FILTER (WHERE p.status = 'open' AND p.seq IS NOT NULL AND NOT ${receiptTakenSql('p', '$3')})::int AS free
       FROM receipt_pool p WHERE p.sheet_id = $1 AND p.tab_name = $2`, [sheetId, tabName, grace]);
  return { total: Number(rows[0] ? rows[0].total : 0), free: Number(rows[0] ? rows[0].free : 0) };
}

/**
 * 공고별 남은 영수증 — Map(campaignId → { free, total }). 영수증 탭에 연결된 공고만 싣는다.
 * ★ 공고 정원의 단일 출처 재료 — `campaignState.fetchCampaignCounts` 가 맨 뒤에서 `counts.receiptFree` 로 싣는다.
 * ★ 실패 = null(덮지 않음 — 표시는 종전). 실제 참여는 배정(`pickReceiptInTx`)이 fail-closed 로 다시 막는다.
 */
async function loadFreeByCampaign(db, campaignIds) {
  const ids = (campaignIds || []).filter(Boolean).map(String);
  if (!ids.length) return new Map();
  const q = db || _pool();
  let sp = false;
  try {
    if (_inTx(db)) { try { await q.query('SAVEPOINT receipt_free'); sp = true; } catch (_) { sp = false; } }
    const grace = require('./campaignHold.service').HOLD_GRACE_SEC;
    const { rows } = await q.query(
      `SELECT rc.id::text AS campaign_id,
              COUNT(*) FILTER (WHERE p.status <> 'cancelled')::int AS total,
              COUNT(*) FILTER (WHERE p.status = 'open' AND p.seq IS NOT NULL AND NOT ${receiptTakenSql('p', '$2')})::int AS free
         FROM recruit_campaigns rc
         JOIN receipt_pool p ON p.sheet_id = rc.linked_sheet_id AND p.tab_name = rc.linked_tab_name
        WHERE rc.id::text = ANY($1::text[])
        GROUP BY 1`, [ids, grace]);
    if (sp) await q.query('RELEASE SAVEPOINT receipt_free');
    const out = new Map();
    for (const r of rows) out.set(String(r.campaign_id), { free: Number(r.free) || 0, total: Number(r.total) || 0 });
    return out;
  } catch (e) {
    if (sp) await q.query('ROLLBACK TO SAVEPOINT receipt_free').catch(() => {});
    logger.warn(`[receiptPool] 남은 영수증 조회 실패(표시는 종전 · 참여는 배정이 막는다): ${e.message}`);
    return null;
  }
}

/**
 * 안 쓴 영수증 한 장을 고른다(영수증 번호 앞부터).
 * ★ 반드시 신청 트랜잭션 안·작업표 잠금(`camp_tab_daily`) 뒤에서 부른다. 고른 줄은 `FOR UPDATE SKIP LOCKED` —
 *   다른 트랜잭션이 막 쥔 장은 건너뛰고 다음 장을 본다. 마지막 장을 둘이 노리면 하나만 받는다(뒤에는 부분 유일 색인 232 이 받친다).
 * ★ 마감이 지났는데 아직 스윕이 정리하지 않은 홀드는 먼저 정리한다(부분 유일 색인이 그 신청을 살아 있다고 본다).
 */
async function pickReceiptInTx(client, { sheetId, tabName, graceSec } = {}) {
  if (!client || !sheetId || !tabName) return null;
  if (graceSec == null) graceSec = require('./campaignHold.service').HOLD_GRACE_SEC;
  await client.query(
    `UPDATE campaign_applications ca SET status = 'expired'
       FROM receipt_pool p
      WHERE ca.receipt_pool_id = p.id AND p.sheet_id = $1 AND p.tab_name = $2
        AND ca.status = 'applied' AND ca.expires_at <= NOW() - make_interval(secs => $3)`,
    [sheetId, tabName, graceSec]);
  const { rows } = await client.query(
    `SELECT p.id, p.work_order_id, p.seq, p.pool_seq
       FROM receipt_pool p
      WHERE p.sheet_id = $1 AND p.tab_name = $2 AND p.status = 'open' AND p.seq IS NOT NULL
        AND p.reviewed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM campaign_applications ca
                         WHERE ca.receipt_pool_id = p.id AND ca.status IN ('applied', 'submitted'))
      ORDER BY p.pool_seq
      LIMIT 1
      FOR UPDATE OF p SKIP LOCKED`, [sheetId, tabName]);
  return rows[0] ? { ...rows[0], id: Number(rows[0].id), seq: Number(rows[0].seq), pool_seq: Number(rows[0].pool_seq) } : null;
}

/** 오늘(KST) YYYY-MM-DD — 서버 시계(휴대폰 시계 안 씀 · 결정 415·422 와 같은 방향). */
function _kstToday(now = new Date()) { return require('./qnaSlots.service').kstDateStr(now); }

/** 참여일 → { joinedDate, joinedLabel, reviewDeadline, reviewDeadlineLabel } (달력 날 · 날짜 더하기 단일 출처 = bookingCalendar.reviewDeadlineOf). */
function joinDatesFor(joinYmd, days) {
  const { reviewDeadlineOf } = require('../utils/bookingCalendar');
  const j = reviewDeadlineOf(joinYmd, 0);
  const d = reviewDeadlineOf(joinYmd, days);
  if (!j || !d) return null;
  return { joinedDate: j.date, joinedLabel: j.label, reviewDeadline: d.date, reviewDeadlineLabel: d.label };
}

/**
 * 매장 안내(매장 이름·주소·네이버 플레이스 주소·리뷰 마감 N일) — 작업오더 계약(`receiptReviewSpecFromWorkOrder`) 단일 출처.
 * ★ 파일 번호는 싣지 않는다. 오더를 못 읽으면 null(호출부가 참여를 막는다 — fail-closed).
 */
async function placeInfoForTab(db, sheetId, tabName) {
  const { rows } = await (db || _pool()).query(
    `SELECT wo.id, wo.work_kind, wo.workboard_schema_version, wo.recruit_count, wo.pay_amount, wo.product_url, wo.product_options_json, wo.review_fee
       FROM receipt_pool p JOIN work_orders wo ON wo.id::text = p.work_order_id::text
      WHERE p.sheet_id = $1 AND p.tab_name = $2 ORDER BY p.pool_seq LIMIT 1`, [sheetId, tabName]);
  if (!rows.length) return null;
  const { spec } = require('../utils/receiptPool').receiptReviewSpecFromWorkOrder(rows[0]);
  if (!spec) return null;
  return { placeName: spec.placeName, placeAddress: spec.placeAddress, placeUrl: spec.placeUrl, reviewDeadlineDays: spec.reviewDeadlineDays };
}

/**
 * 신청 트랜잭션 안에서 영수증 한 장을 이 신청에 묶는다 — 고르기 · 신청 행에 새기기 · 참여일·리뷰마감일 새기기(같은 트랜잭션).
 * @returns {Promise<{ok:true, pool, dates}|{ok:false, reason:'receipt_sold_out'|'receipt_place_unknown'}>}
 *   ★ 못 고르면·오더 계약을 못 읽으면 묶지 않는다(fail-closed — 영수증 없는 참여는 할 일이 없다).
 */
async function bindReceiptForApply(client, { sheetId, tabName, applicationId, now = new Date() } = {}) {
  if (!sheetId || !tabName || !applicationId) return { ok: false, reason: 'receipt_sold_out' };
  const place = await placeInfoForTab(client, sheetId, tabName);
  if (!place) return { ok: false, reason: 'receipt_place_unknown' };
  const picked = await pickReceiptInTx(client, { sheetId, tabName });
  if (!picked) return { ok: false, reason: 'receipt_sold_out' };
  const dates = joinDatesFor(_kstToday(now), place.reviewDeadlineDays);
  if (!dates) return { ok: false, reason: 'receipt_place_unknown' };
  // 새기기 — 그 사이 다른 신청이 같은 장을 쥐었으면 0줄(조건) · 진짜 동시면 부분 유일 색인이 23505 로 막는다.
  //   ★ 둘 다 「마감」으로 접는다 — 호출부(신청)가 곧바로 ROLLBACK 하므로 깨진 트랜잭션을 이어 쓰지 않는다(SAVEPOINT 불필요).
  let upd;
  try {
    upd = await client.query(
      `UPDATE campaign_applications SET receipt_pool_id = $2
        WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM campaign_applications o
                           WHERE o.receipt_pool_id = $2 AND o.id <> $1 AND o.status IN ('applied', 'submitted'))`,
      [applicationId, picked.id]);
  } catch (e) {
    if (e && e.code === '23505') return { ok: false, reason: 'receipt_sold_out' };   // 부분 유일 색인 — 같은 장을 다른 신청이 먼저 쥠
    throw e;
  }
  if (!upd || !(upd.rowCount > 0)) return { ok: false, reason: 'receipt_sold_out' };
  await client.query(
    `UPDATE receipt_pool SET joined_date = $2::date, review_deadline = $3::date, updated_at = NOW() WHERE id = $1`,
    [picked.id, dates.joinedDate, dates.reviewDeadline]);
  return { ok: true, pool: picked, dates, place };
}

/** 신청에 배정된 영수증(없으면 null). 참여 상세·참여 확정·영수증 보기 통로가 읽는다. ★ file_id 는 서버 안에서만 쓴다(응답에 싣지 말 것). */
async function poolForApplication(db, applicationId) {
  const { rows } = await (db || _pool()).query(
    `SELECT p.id, p.work_order_id, p.sheet_id, p.tab_name, p.seq, p.pool_seq, p.file_id, p.status,
            to_char(p.joined_date, 'YYYY-MM-DD') AS joined_date, to_char(p.review_deadline, 'YYYY-MM-DD') AS review_deadline,
            p.reviewed_at
       FROM campaign_applications ca JOIN receipt_pool p ON p.id = ca.receipt_pool_id
      WHERE ca.id = $1 LIMIT 1`, [Number(applicationId) || 0]);
  return rows[0] ? { ...rows[0], id: Number(rows[0].id), seq: rows[0].seq == null ? null : Number(rows[0].seq) } : null;
}

/**
 * 참여 전 공고 상세의 영수증리뷰 안내 — 매장 이름·주소·리뷰 기한 + 남은 영수증 수. 영수증 탭이 아니면 null.
 * ★ 네이버 플레이스 주소·영수증 사진(파일 번호)은 **참여 후**에만(결정 041 · 431 공개 칸 허용목록 밖).
 */
async function receiptPublicView(db, camp) {
  if (!camp || !camp.linked_sheet_id || !camp.linked_tab_name) return null;
  const c = await freeCountsForTab(db, camp.linked_sheet_id, camp.linked_tab_name);
  if (!c.total) return null;
  const place = await placeInfoForTab(db, camp.linked_sheet_id, camp.linked_tab_name);
  return {
    placeName: place ? place.placeName : '', placeAddress: place ? place.placeAddress : '',
    reviewDeadlineDays: place ? place.reviewDeadlineDays : null,
    placeKnown: !!place, total: c.total, free: c.free,
  };
}

/** 참여 상세(work-detail)의 영수증 칸 — 할 일·마감만(작업표 위치·파일 번호 없음). 마감 안내 = bookingSlots.reviewerDeadlineView 하나(결정 422). */
function reviewerSeatView(poolRow, place, now = new Date()) {
  if (!poolRow) return null;
  const dl = require('./bookingSlots.service').reviewerDeadlineView(poolRow.review_deadline || null, now);
  return {
    receiptNo: Number(poolRow.pool_seq) || null,
    joinedDate: poolRow.joined_date || null,
    reviewDeadline: dl.reviewDeadline, reviewDeadlineState: dl.reviewDeadlineState, reviewDeadlineNotice: dl.reviewDeadlineNotice,
    place: place ? { placeName: place.placeName, placeAddress: place.placeAddress, placeUrl: place.placeUrl, reviewDeadlineDays: place.reviewDeadlineDays } : null,
  };
}

/**
 * 리뷰 캡처가 제출된 영수증 줄에 「리뷰 냄」을 새긴다 — 그 뒤 신청이 취소돼도 영수증을 다시 주지 않는 근거.
 * ★ 리뷰 제출을 막지 않는다(실패 = 경고만 · 판정 ㉯는 제출 확정 신청이 그대로 쥐고 있어 그 사이 다른 사람에게 가지 않는다).
 */
async function markReviewedRow(db, sheetId, tabName, seq) {
  const n = parseInt(seq, 10);
  if (!sheetId || !tabName || !Number.isInteger(n)) return 0;
  try {
    const r = await (db || _pool()).query(
      `UPDATE receipt_pool SET reviewed_at = NOW(), updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND reviewed_at IS NULL`, [sheetId, tabName, n]);
    return r.rowCount || 0;
  } catch (e) {
    logger.warn(`[receiptPool] 리뷰 낸 영수증 표시 실패(리뷰 제출은 그대로) tab=${tabName} seq=${n}: ${e.message}`);
    return 0;
  }
}

module.exports = {
  registerReceiptUpload, unregisteredFiles, isRegisteredReceiptFile,
  insertPool, isReceiptPoolTab, isReceiptPoolCampaign, isPoolBoundRow, poolBoundSeqs, poolBoundRowSql,
  poolForTab, poolCounts, fileForRow, verifyRowsMatchPool, repairPoolIfMissing, sendReceiptImage,
  // 3단계(결정 434)
  receiptTakenSql, freeCountsForTab, loadFreeByCampaign, pickReceiptInTx, joinDatesFor, placeInfoForTab,
  bindReceiptForApply, poolForApplication, receiptPublicView, reviewerSeatView, markReviewedRow,
};
