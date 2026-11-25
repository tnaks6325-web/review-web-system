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

/* ══════════════════════════════════════════════════════════════════════════════
   3단계 — 리뷰어가 날짜를 골라 신청 · 자리 묶기 · 예약번호 (결정 409 · migration 228)
   ★ 자리가 비었는지 = 이 자리를 가리키는 신청이 「제출 완료」이거나 「살아 있는 홀드」가 아님(신청 표가 단일 출처 —
     자리표 status 는 신청·만료·취소 때 고치지 않는다). Q&A 211 과 같은 방식.
   ★ 한 자리에 둘 = 부분 유일 색인 `uq_campaign_apps_booking_slot` 이 받친다(동시 신청 과판매 구조적 차단).
   ★ 고를 수 있는 날 = **내일(KST)부터**(기본값 · 당일 예약 제외 — 그날 예약이 열려 있는지·업체가 받아 줄지 알 수 없다).
   ══════════════════════════════════════════════════════════════════════════════ */

/** 당일 예약을 받을지 — 기본 받지 않음(결정 409 기본값). 바꾸려면 이 값과 결정 문서를 함께 고친다. */
const BOOKING_SAME_DAY_OK = false;
const _DAY_MS = 86400000;
const _YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function _kstToday(now = new Date()) { return require('./qnaSlots.service').kstDateStr(now); }

/** 리뷰어가 고를 수 있는 첫날(YYYY-MM-DD, KST) — 기본 내일. */
function bookableFrom(now = new Date()) {
  return BOOKING_SAME_DAY_OK ? _kstToday(now) : _kstToday(new Date(now.getTime() + _DAY_MS));
}

/** SQL 조각 — 이 자리(alias)를 지금 쥐고 있는 신청이 있다(제출 완료 · 유예 안의 홀드). $grace 자리 번호를 받는다. */
function _heldSql(alias, graceParam) {
  return `EXISTS (SELECT 1 FROM campaign_applications ca
                   WHERE ca.booking_slot_id = ${alias}.id
                     AND (ca.status = 'submitted'
                          OR (ca.status = 'applied' AND (ca.expires_at IS NULL OR ca.expires_at > NOW() - make_interval(secs => ${graceParam})))))`;
}

/**
 * 날짜별 남은 자리 — 참여 전 화면·공고 정원의 재료(취소 자리 제외).
 * @returns {Promise<Array<{date,total,taken,left,bookable}>>}  left = 열린 자리 − 쥔 신청 · bookable = 내일부터
 */
async function seatsForTab(db, sheetId, tabName, now = new Date()) {
  const grace = require('./campaignHold.service').HOLD_GRACE_SEC;
  const { rows } = await (db || _pool()).query(
    `SELECT to_char(s.slot_date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE s.status = 'open' AND ${_heldSql('s', '$3')})::int AS taken,
            COUNT(*) FILTER (WHERE s.status = 'open' AND NOT ${_heldSql('s', '$3')})::int AS free
       FROM booking_slots s
      WHERE s.sheet_id = $1 AND s.tab_name = $2 AND s.status <> 'cancelled'
      GROUP BY s.slot_date ORDER BY s.slot_date`, [sheetId, tabName, grace]);
  const from = bookableFrom(now);
  return rows.map(r => ({ date: r.date, total: Number(r.total), taken: Number(r.taken), left: Number(r.free), bookable: r.date >= from }));
}

/**
 * 공고별 「고를 수 있는 날의 남은 자리 합」 — Map(campaignId → { free, total }). 예약 탭(자리표 있음)에 연결된 공고만 싣는다.
 * ★ 공고 정원의 단일 출처 재료 — `campaignState.fetchCampaignCounts` 가 맨 뒤에서 싣고 `computeCampaignState` 가
 *   `counts.bookingFree` 로 연다/닫는다(이용일자 칸을 시트 일정으로 읽지 않는다).
 * ★ 실패 = null(덮지 않음 — 표시는 종전). 실제 신청은 자리 묶기(`pickSlotInTx`)가 fail-closed 로 다시 막는다.
 */
async function loadFreeByCampaign(db, campaignIds, now = new Date()) {
  const ids = (campaignIds || []).filter(Boolean).map(String);
  if (!ids.length) return new Map();
  const q = db || _pool();
  let sp = false;
  try {
    if (_inTx(db)) { try { await q.query('SAVEPOINT booking_free'); sp = true; } catch (_) { sp = false; } }
    const grace = require('./campaignHold.service').HOLD_GRACE_SEC;
    const { rows } = await q.query(
      `SELECT rc.id::text AS campaign_id,
              COUNT(*) FILTER (WHERE s.status <> 'cancelled')::int AS total,
              COUNT(*) FILTER (WHERE s.status = 'open' AND s.slot_date >= $2::date AND NOT ${_heldSql('s', '$3')})::int AS free
         FROM recruit_campaigns rc
         JOIN booking_slots s ON s.sheet_id = rc.linked_sheet_id AND s.tab_name = rc.linked_tab_name
        WHERE rc.id::text = ANY($1::text[])
        GROUP BY 1`, [ids, bookableFrom(now), grace]);
    if (sp) await q.query('RELEASE SAVEPOINT booking_free');
    const out = new Map();
    for (const r of rows) out.set(String(r.campaign_id), { free: Number(r.free) || 0, total: Number(r.total) || 0 });
    return out;
  } catch (e) {
    if (sp) await q.query('ROLLBACK TO SAVEPOINT booking_free').catch(() => {});
    logger.warn(`[bookingSlots] 남은 자리 조회 실패(표시는 종전 · 신청은 자리 묶기가 막는다): ${e.message}`);
    return null;
  }
}

/** 고른 날짜 검사(잠금 앞에서도 쓴다 — 자리 미점유). @returns {{ok:true,date}|{ok:false,reason}} */
function checkBookingDate(raw, now = new Date()) {
  const date = String(raw == null ? '' : raw).trim();
  if (!date) return { ok: false, reason: 'booking_date_required' };
  if (!_YMD_RE.test(date) || !require('../utils/bookingCalendar').isValidYmd(date)) return { ok: false, reason: 'booking_date_invalid' };
  if (date < bookableFrom(now)) return { ok: false, reason: 'booking_date_closed' };
  return { ok: true, date };
}

/**
 * 고른 날의 빈 자리 하나를 고른다(그날 순번 앞부터).
 * ★ 반드시 신청 트랜잭션 안·작업표 잠금(`camp_tab_daily`) 뒤에서 부른다 — 같은 작업표 신청이 한 줄로 서서 한 자리에 둘이 묶이지 않는다.
 * ★ 마감이 지났는데 아직 스윕이 정리하지 않은 홀드는 여기서 먼저 정리한다(부분 유일 색인이 그 신청을 살아 있다고 본다).
 */
async function pickSlotInTx(client, { sheetId, tabName, date, graceSec } = {}) {
  if (!client || !sheetId || !tabName || !date) return null;
  if (graceSec == null) graceSec = require('./campaignHold.service').HOLD_GRACE_SEC;
  await client.query(
    `UPDATE campaign_applications ca SET status = 'expired'
       FROM booking_slots s
      WHERE ca.booking_slot_id = s.id AND s.sheet_id = $1 AND s.tab_name = $2 AND s.slot_date = $3::date
        AND ca.status = 'applied' AND ca.expires_at <= NOW() - make_interval(secs => $4)`,
    [sheetId, tabName, date, graceSec]);
  const { rows } = await client.query(
    `SELECT s.id, s.seq, s.date_seq, to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date,
            to_char(s.review_deadline, 'YYYY-MM-DD') AS review_deadline
       FROM booking_slots s
      WHERE s.sheet_id = $1 AND s.tab_name = $2 AND s.slot_date = $3::date AND s.status = 'open'
        AND NOT EXISTS (SELECT 1 FROM campaign_applications ca
                         WHERE ca.booking_slot_id = s.id AND ca.status IN ('applied', 'submitted'))
      ORDER BY s.date_seq
      LIMIT 1
      FOR UPDATE OF s`, [sheetId, tabName, date]);
  return rows[0] || null;
}

/**
 * 신청 트랜잭션 안에서 고른 날의 자리 하나를 묶을 대상을 고른다.
 * @returns {Promise<{ok:true, slot}|{ok:false, reason}>} reason: booking_date_required|invalid|closed|full (fail-closed)
 */
async function bindSlotForApply(client, { sheetId, tabName, date, now = new Date() } = {}) {
  const chk = checkBookingDate(date, now);
  if (!chk.ok) return chk;
  if (!sheetId || !tabName) return { ok: false, reason: 'booking_date_full' };
  const slot = await pickSlotInTx(client, { sheetId, tabName, date: chk.date });
  return slot ? { ok: true, slot } : { ok: false, reason: 'booking_date_full' };
}

/** 신청에 묶인 자리(없으면 null). 참여 상세·제출 창구가 읽는다. */
async function slotForApplication(db, applicationId) {
  const { rows } = await (db || _pool()).query(
    `SELECT s.id, s.work_order_id, s.sheet_id, s.tab_name, s.seq, s.date_seq, s.status,
            to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date, to_char(s.review_deadline, 'YYYY-MM-DD') AS review_deadline,
            ca.booking_reservation_no
       FROM campaign_applications ca JOIN booking_slots s ON s.id = ca.booking_slot_id
      WHERE ca.id = $1 LIMIT 1`, [Number(applicationId) || 0]);
  return rows[0] || null;
}

/** 리뷰어 화면에 내보내는 자리 정보(작업표 위치·내부 번호는 빼고 할 일만). deadline = 예약내역 제출 기한(홀드 마감). */
function publicSlotView(slot, deadline) {
  if (!slot) return null;
  return {
    date: slot.slot_date || null,
    reviewDeadline: slot.review_deadline || null,
    deadline: deadline ? new Date(deadline).toISOString() : null,
  };
}

/**
 * 매장 안내(매장 이름·주소·네이버 예약 주소·돈 방식·리뷰 기한) — 작업오더 계약(`bookingSpecFromWorkOrder`) 단일 출처.
 * ★ 공고 사본을 쓰지 않는다(오더가 고쳐지면 갈린다). 오더를 못 읽으면 null(화면은 신청을 막는다 — fail-closed).
 */
async function placeInfoForTab(db, sheetId, tabName) {
  const { rows } = await (db || _pool()).query(
    `SELECT wo.id, wo.work_kind, wo.workboard_schema_version, wo.recruit_count, wo.pay_amount, wo.product_url, wo.product_options_json
       FROM booking_slots s JOIN work_orders wo ON wo.id = s.work_order_id
      WHERE s.sheet_id = $1 AND s.tab_name = $2 ORDER BY s.id LIMIT 1`, [sheetId, tabName]);
  if (!rows.length) return null;
  const { spec } = require('../utils/bookingCalendar').bookingSpecFromWorkOrder(rows[0]);
  if (!spec) return null;
  return {
    placeName: spec.placeName, placeAddress: spec.placeAddress, bookingUrl: spec.bookingUrl,
    payMode: spec.payMode, payModeLabel: spec.payModeLabel, pay: spec.pay, reviewDeadlineDays: spec.reviewDeadlineDays,
  };
}

/**
 * 참여 전 공고 상세의 예약 안내 — 매장 이름·주소·돈 방식·리뷰 기한 + 날짜별 남은 자리. 예약 탭이 아니면 null.
 * ★ 네이버 예약 주소·결제금액은 **참여 후**(참여 상세 bookingSlot.place)에만 싣는다 — 작업내용·금액은 참여 후 공개(결정 041)이고,
 *   자리 없이 먼저 예약해 버리는 길을 열지 않는다. 작업표 위치·자리 번호도 내보내지 않는다.
 */
async function bookingPublicView(db, camp, now = new Date()) {
  if (!camp || !camp.linked_sheet_id || !camp.linked_tab_name) return null;
  const seats = await seatsForTab(db, camp.linked_sheet_id, camp.linked_tab_name, now);
  if (!seats.length) return null;
  const place = await placeInfoForTab(db, camp.linked_sheet_id, camp.linked_tab_name);
  return {
    placeName: place ? place.placeName : '', placeAddress: place ? place.placeAddress : '',
    payMode: place ? place.payMode : '', payModeLabel: place ? place.payModeLabel : '',
    reviewDeadlineDays: place ? place.reviewDeadlineDays : null,
    placeKnown: !!place,
    bookableFrom: bookableFrom(now),
    dates: seats.map(s => ({ date: s.date, total: s.total, left: s.left, bookable: s.bookable })),
    free: seats.filter(s => s.bookable).reduce((n, s) => n + s.left, 0),
  };
}

/**
 * 예약번호 정규화 — 띄어쓰기 제거 · 영문 대문자 · 숫자/영문/하이픈만 · 4~40자.
 * @returns {{ok:true,value}|{ok:false,reason:'booking_resv_required'|'booking_resv_invalid'}}
 */
function normalizeReservationNo(raw) {
  const v = String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase();
  if (!v) return { ok: false, reason: 'booking_resv_required' };
  if (!/^[0-9A-Z-]{4,40}$/.test(v)) return { ok: false, reason: 'booking_resv_invalid' };
  return { ok: true, value: v };
}

module.exports = {
  insertCalendar, isBookingTab, isBookingCampaign, isBoundRow, boundSeqs, boundRowSql,
  calendarForTab, seatsByDate, verifyRowsMatchPlan, repairCalendarIfMissing,
  // 3단계(결정 409)
  BOOKING_SAME_DAY_OK, bookableFrom, seatsForTab, loadFreeByCampaign, checkBookingDate, pickSlotInTx, bindSlotForApply,
  slotForApplication, publicSlotView, placeInfoForTab, bookingPublicView, normalizeReservationNo,
};
