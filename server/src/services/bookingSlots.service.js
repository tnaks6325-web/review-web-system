/**
 * bookingSlots.service.js — 네이버예약리뷰 날짜별 자리표 저장·조회 (결정 404·407 · migration 227).
 *
 * 자리표 = 접수 때 작업오더에서 **한 번** 만든다(`utils/bookingCalendar` 순수 생성기 → 여기서 저장).
 * 작업표 줄(campaign_participants)은 그 사본을 칸으로 보여 줄 뿐이고, 3단계 신청 때 날짜를 고르는 기준은 이 표다.
 *
 * ★★ 이 표가 있거나 탭 종류가 booking 인 탭 = 예약 자리표 탭. 작업표를 손보는 자동 작업(빈 줄 날짜 옮기기·총건수 맞추기·
 *   빈 줄 정리·아무 빈 줄에나 주문 끼우기·줄 정리·날짜 고치기)은 이 판정으로 예약 탭을 건너뛴다 —
 *   업체가 정한 「12/5 토요일 1명」 자리가 다른 날로 옮겨지거나 지워지면 안 된다.
 * ★ 판정 실패는 **예약 탭으로 본다**(fail-closed) — 자동 작업 하나를 쉬는 것이 자리를 지우는 것보다 싸다.
 *   표 존재는 기동 필수 표 검사(index.js REQUIRED_TABLES)가 보장한다.
 * ★★ 트랜잭션 안에서도 불린다 — 조회 실패가 바깥 트랜잭션을 죽이지 않게 SAVEPOINT 로 감싼다(qnaSlots 와 같은 규율).
 * ★ Q&A 자리표(qna_slots)와 표를 나눈 이유: Q&A 판정(`isQnaTab` = 자리표 존재)이 예약 탭을 Q&A 로 읽으면
 *   Q&A 신청·캡처 기한 스윕·일정 끝 추가 모집이 예약 탭에 붙는다.
 */
'use strict';

const { logger } = require('../utils/logger');

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
    logger.warn(`[bookingSlots] ${what} 판정 실패 — 안전 쪽으로 봄(fail-closed): ${e.message}`);
    return onFail;
  }
}

/**
 * 자리표 저장 — 재접수·재시도에 안전(같은 자리는 ON CONFLICT DO NOTHING).
 * @param {Array} p.slots  bookingCalendar 슬롯 + `rowSeq`(작업표 줄 번호)
 */
async function insertCalendar({ db, workOrderId, sheetId, tabName, slots = [], by = 'system' } = {}) {
  if (!slots.length) return { inserted: 0 };
  const q = db || _pool();
  const c = { wo: [], seq: [], dt: [], ds: [], dl: [] };
  for (const s of slots) {
    c.wo.push(String(workOrderId || ''));
    c.seq.push(Number.isInteger(s.rowSeq) ? s.rowSeq : null);
    c.dt.push(String(s.date));
    c.ds.push(Number(s.dateSeq));
    c.dl.push(s.reviewDeadline ? String(s.reviewDeadline) : null);
  }
  const { rowCount } = await q.query(
    `INSERT INTO booking_slots (work_order_id, sheet_id, tab_name, seq, slot_date, date_seq, review_deadline, created_by)
     SELECT u.wo, $1, $2, u.seq, u.dt::date, u.ds, u.dl::date, $3
       FROM UNNEST($4::text[], $5::int[], $6::text[], $7::int[], $8::text[]) AS u(wo, seq, dt, ds, dl)
     ON CONFLICT DO NOTHING`,
    [sheetId, tabName, String(by || 'system').slice(0, 100), c.wo, c.seq, c.dt, c.ds, c.dl],
  );
  return { inserted: rowCount || 0 };
}

/* 판정 = 자리표가 있거나, 탭이 네이버예약리뷰로 등록돼 있다(자리표 저장이 실패한 예약 탭도 리뷰 탭처럼 정리되지 않게).
   탭 종류는 접수 때 tab_configs.work_kind 에 기록된다. */
const IS_BOOKING_TAB_SQL = `SELECT (EXISTS (SELECT 1 FROM booking_slots WHERE sheet_id = $1 AND tab_name = $2)
                                OR EXISTS (SELECT 1 FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 AND work_kind = 'booking')) AS b`;

/**
 * 이 탭이 예약 자리표 탭인가.
 * @returns {Promise<boolean>} 조회 실패(표 없음 포함) = true(fail-closed — 자동 정리를 쉰다)
 */
async function isBookingTab(db, sheetId, tabName) {
  if (!sheetId || !tabName) return false;
  return _probe(db, 'booking_tab_probe', IS_BOOKING_TAB_SQL, [sheetId, tabName], rows => !!(rows[0] && rows[0].b === true), true, '예약 탭');
}

/**
 * 이 줄(seq)이 자리표의 자리인가.
 * @returns {Promise<boolean>} 조회 실패 = true(묶인 것으로 본다 — 호출부가 안전 쪽으로 접는다)
 */
async function isBoundRow(db, sheetId, tabName, seq) {
  return _probe(db, 'booking_bound_probe', 'SELECT 1 FROM booking_slots WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 LIMIT 1',
    [sheetId, tabName, Number(seq)], rows => rows.length > 0, true, '자리 묶임');
}

/**
 * 이 모집공고가 예약 자리표 탭에 연결돼 있나(차수 같은 인원 조작을 막는 데 쓴다).
 * @returns {Promise<boolean>} 공고 없음/연결 없음 = false · 조회 실패 = true(fail-closed)
 */
async function isBookingCampaign(campaignId) {
  try {
    const { rows } = await _pool().query('SELECT linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id = $1', [String(campaignId)]);
    if (!rows.length || !rows[0].linked_sheet_id || !rows[0].linked_tab_name) return false;
    return await isBookingTab(null, rows[0].linked_sheet_id, rows[0].linked_tab_name);
  } catch (e) {
    logger.warn(`[bookingSlots] 공고 예약 판정 실패 — 막음(fail-closed): ${e.message}`);
    return true;
  }
}

/** 주어진 줄 번호 중 자리표에 묶인 것. 조회 실패는 던진다(호출부가 정리를 멈춘다 — fail-closed). */
async function boundSeqs(db, sheetId, tabName, seqs = []) {
  const list = [...new Set((seqs || []).map(n => parseInt(n, 10)).filter(Number.isFinite))];
  if (!list.length) return [];
  const { rows } = await (db || _pool()).query(
    'SELECT seq FROM booking_slots WHERE sheet_id = $1 AND tab_name = $2 AND seq = ANY($3::int[]) ORDER BY seq',
    [sheetId, tabName, list]);
  return rows.map(r => Number(r.seq));
}

/** SQL 조각 — 이 줄(seq)이 예약 자리표에 묶여 있으면 참. 자동 삭제에서 `NOT (…)` 로 쓴다. */
function boundRowSql(alias) {
  return `EXISTS (SELECT 1 FROM booking_slots bks WHERE bks.sheet_id = ${alias}.sheet_id AND bks.tab_name = ${alias}.tab_name AND bks.seq = ${alias}.seq)`;
}

/** 탭의 자리표 전체 — 날짜 · 그날 순번 순. */
async function calendarForTab(db, sheetId, tabName) {
  const { rows } = await (db || _pool()).query(
    `SELECT id, work_order_id, seq, to_char(slot_date, 'YYYY-MM-DD') AS slot_date, date_seq,
            to_char(review_deadline, 'YYYY-MM-DD') AS review_deadline, status
       FROM booking_slots WHERE sheet_id = $1 AND tab_name = $2
      ORDER BY slot_date, date_seq`, [sheetId, tabName]);
  return rows.map(r => ({ ...r, seq: r.seq == null ? null : Number(r.seq), date_seq: Number(r.date_seq) }));
}

/**
 * 날짜별 자리 수 — 3단계 신청 화면·자리 고르기의 재료(취소 자리 제외).
 * ★ 2단계에는 신청 묶기가 없어 open = total(취소 제외)이다. 3단계가 신청 묶기(booking_slot_id)를 더하면
 *   남은 자리 = open − 묶인 신청 — 그 계산은 3단계가 잠금 안에서 한다(여기 값으로 과판매를 막지 않는다).
 */
async function seatsByDate(db, sheetId, tabName) {
  const { rows } = await (db || _pool()).query(
    `SELECT to_char(slot_date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'open')::int AS open
       FROM booking_slots WHERE sheet_id = $1 AND tab_name = $2 AND status <> 'cancelled'
      GROUP BY slot_date ORDER BY slot_date`, [sheetId, tabName]);
  return rows.map(r => ({ date: r.date, total: Number(r.total), open: Number(r.open) }));
}

/**
 * 이미 깔린 작업표 줄이 이 계획 줄과 **줄마다 같은가** — 자리표를 그 줄 번호에 붙여도 되는지.
 * 비교 = 줄 번호마다 선택지(매장)·이용일자·리뷰마감일(자리표를 정하는 칸만).
 * @returns {Promise<{ok:boolean, mismatches:number[]}>}
 */
async function verifyRowsMatchPlan({ db, sheetId, tabName, planRows = [] } = {}) {
  const { BOOKING_DEADLINE_HEADER } = require('../utils/worktablePlan');
  const { rows } = await (db || _pool()).query(
    `SELECT seq, option_text, start_date, row_json FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND seq = ANY($3::int[])`,
    [sheetId, tabName, planRows.map(r => r.seq)]);
  const bySeq = new Map(rows.map(r => [Number(r.seq), r]));
  const t = v => String(v == null ? '' : v).trim();
  const mismatches = [];
  for (const pr of planRows) {
    const cur = bySeq.get(Number(pr.seq));
    const rj = (cur && cur.row_json && typeof cur.row_json === 'object') ? cur.row_json : {};
    const pj = pr.rowJson || {};
    const same = cur
      && t(cur.option_text) === t(pr.optionText).slice(0, 200) && t(cur.start_date) === t(pr.startDate).slice(0, 100)
      && t(rj[BOOKING_DEADLINE_HEADER]) === t(pj[BOOKING_DEADLINE_HEADER]);
    if (!same) mismatches.push(Number(pr.seq));
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * ★ 자리표 복구 — 작업표 줄은 깔렸는데 자리표 저장만 실패한 예약 탭을 **재접수**로 되살린다.
 *   지금 오더 값으로 계획을 다시 만들고(같은 오더 = 같은 자리표), 깔린 줄과 줄마다 같을 때만 저장한다(fail-closed).
 */
async function repairCalendarIfMissing({ workOrder, sheetId, tabName, by = 'admin' } = {}) {
  const q = _pool();
  const { rows: have } = await q.query('SELECT 1 FROM booking_slots WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1', [sheetId, tabName]);
  if (have.length) return { ok: true, repaired: false, reason: 'present' };
  const { createSheetlessWorktable } = require('./sheetlessAccept.service');
  const made = await createSheetlessWorktable({ workOrder, tabName, by });
  if (!made.ok || !Array.isArray(made.bookingSlots) || !made.bookingSlots.length) {
    return { ok: false, repaired: false, reason: 'plan_failed', error: made.error || '예약 자리표 계획을 만들 수 없습니다.' };
  }
  if (made.sheetId !== sheetId) return { ok: false, repaired: false, reason: 'sheet_mismatch', error: '작업표 위치가 오더와 다릅니다.' };
  const v = await verifyRowsMatchPlan({ db: q, sheetId, tabName, planRows: made.rows });
  if (!v.ok) {
    return { ok: false, repaired: false, reason: 'rows_mismatch',
      error: `작업표 줄 ${v.mismatches.length}개가 지금 오더로 만든 자리표와 달라 자리표를 다시 깔 수 없습니다(줄 ${v.mismatches.slice(0, 5).join(', ')}).` };
  }
  const r = await insertCalendar({ workOrderId: workOrder.id, sheetId, tabName, slots: made.bookingSlots, by: `reaccept:${by}` });
  logger.info(`[bookingSlots] 자리표 복구 ${r.inserted}/${made.bookingSlots.length}칸 tab=${tabName}`);
  return { ok: true, repaired: true, inserted: r.inserted };
}

module.exports = {
  insertCalendar, isBookingTab, isBookingCampaign, isBoundRow, boundSeqs, boundRowSql,
  calendarForTab, seatsByDate, verifyRowsMatchPlan, repairCalendarIfMissing,
};
