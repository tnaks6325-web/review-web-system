/**
 * qnaSlots.service.js — Q&A체험단 날짜별 자리표 저장·조회 (결정 321 · migration 210).
 *
 * 자리표 = 접수 때 작업오더에서 **한 번** 만든다(`utils/qnaCalendar` 순수 생성기 → 여기서 저장).
 * 작업표 줄(campaign_participants)은 그 사본을 칸으로 보여 줄 뿐이고, 신청 때 자리를 고르는 기준은 이 표다.
 *
 * ★★ 이 표가 있는 탭 = Q&A 자리표 탭. 작업표를 손보는 자동 작업(빈 줄 날짜 옮기기·총건수 맞추기·
 *   빈 줄 정리·아무 빈 줄에나 주문 끼우기)은 이 판정으로 Q&A 탭을 건너뛴다 — 정해 둔
 *   "3일째 공개글" 자리가 흩어지거나 지워지면 안 된다.
 * ★ 판정 실패는 **Q&A 탭으로 본다**(fail-closed) — 자동 작업 하나를 쉬는 것이 자리를 지우는 것보다 싸다.
 *   표 존재는 기동 필수 표 검사(index.js REQUIRED_TABLES)가 보장한다.
 * ★★ 트랜잭션 안에서도 불린다(행 삭제·정원 맞추기·주문 기록·날짜 맞추기) — 조회 실패가 바깥 트랜잭션을
 *   통째로 죽이지 않게 SAVEPOINT 로 감싼다(sharedPatch p7q_rounds 와 같은 규율).
 */
'use strict';

const { logger } = require('../utils/logger');

function _pool() { return require('../db/pool'); }

/**
 * 자리표 저장 — 재접수·재시도에 안전(같은 자리는 ON CONFLICT DO NOTHING).
 * @param {object} p
 * @param {Array}  p.slots  qnaCalendar 슬롯 + `rowSeq`(작업표 줄 번호)
 * @returns {Promise<{inserted:number}>}
 */
async function insertCalendar({ db, workOrderId, sheetId, tabName, slots = [], by = 'system' } = {}) {
  if (!slots.length) return { inserted: 0 };
  const q = db || _pool();
  const cols = { wo: [], seq: [], key: [], pn: [], o1: [], o2: [], ui: [], us: [], dt: [], vis: [], txt: [] };
  for (const s of slots) {
    cols.wo.push(String(workOrderId || ''));
    cols.seq.push(Number.isInteger(s.rowSeq) ? s.rowSeq : null);
    cols.key.push(String(s.unitKey));
    cols.pn.push(String(s.productName || ''));
    cols.o1.push(String(s.option1Value || ''));
    cols.o2.push(String(s.option2Value || ''));
    cols.ui.push(Number(s.unitIdx) || 0);
    cols.us.push(Number(s.unitSeq));
    cols.dt.push(String(s.date));
    cols.vis.push(s.visibility === 'public' ? 'public' : 'private');
    cols.txt.push(s.visibility === 'public' ? String(s.text || '') : '');
  }
  const { rowCount } = await q.query(
    `INSERT INTO qna_slots (work_order_id, sheet_id, tab_name, seq, unit_key, product_name, option1_value, option2_value,
                            unit_idx, unit_seq, slot_date, visibility, question_text, created_by)
     SELECT u.wo, $1, $2, u.seq, u.key, u.pn, u.o1, u.o2, u.ui, u.us, u.dt::date, u.vis, u.txt, $3
       FROM UNNEST($4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::text[], $10::int[], $11::int[],
                   $12::text[], $13::text[], $14::text[])
            AS u(wo, seq, key, pn, o1, o2, ui, us, dt, vis, txt)
     ON CONFLICT DO NOTHING`,
    [sheetId, tabName, String(by || 'system').slice(0, 100),
      cols.wo, cols.seq, cols.key, cols.pn, cols.o1, cols.o2, cols.ui, cols.us, cols.dt, cols.vis, cols.txt],
  );
  return { inserted: rowCount || 0 };
}

/**
 * 이 탭이 Q&A 자리표 탭인가.
 * @returns {Promise<boolean>} 조회 실패(표 없음 포함) = true(fail-closed — 자동 정리를 쉰다).
 */
/* 판정 = 자리표가 있거나, 탭이 Q&A체험단으로 등록돼 있다(자리표 저장이 실패했거나 1단계 시절에 접수된 Q&A 탭도
   리뷰 탭처럼 정리되지 않게). 탭 종류는 접수 때 tab_configs.work_kind 에 기록된다. */
const IS_QNA_TAB_SQL = `SELECT (EXISTS (SELECT 1 FROM qna_slots WHERE sheet_id = $1 AND tab_name = $2)
                            OR EXISTS (SELECT 1 FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 AND work_kind = 'qna')) AS q`;

async function isQnaTab(db, sheetId, tabName) {
  if (!sheetId || !tabName) return false;
  const q = db || _pool();
  const inTx = !!(db && typeof db.release === 'function');   // 풀에서 빌린 연결 = 트랜잭션 중일 수 있다
  let sp = false;
  try {
    if (inTx) {
      try { await q.query('SAVEPOINT qna_tab_probe'); sp = true; } catch (_) { sp = false; }   // 트랜잭션 밖이면 그냥 조회
    }
    const { rows } = await q.query(IS_QNA_TAB_SQL, [sheetId, tabName]);
    if (sp) await q.query('RELEASE SAVEPOINT qna_tab_probe');
    return !!(rows[0] && rows[0].q === true);
  } catch (e) {
    if (sp) await q.query('ROLLBACK TO SAVEPOINT qna_tab_probe').catch(() => {});
    logger.warn(`[qnaSlots] Q&A 탭 판정 실패 — 자동 정리를 건너뜀(fail-closed): ${e.message}`);
    return true;
  }
}

/**
 * 이 줄(seq)이 자리표의 자리인가. 트랜잭션 안에서 불려도 바깥을 죽이지 않게 SAVEPOINT 로 감싼다.
 * @returns {Promise<boolean>} 조회 실패 = true(묶인 것으로 본다 — 호출부가 안전 쪽으로 접는다)
 */
async function isBoundRow(db, sheetId, tabName, seq) {
  const q = db || _pool();
  const inTx = !!(db && typeof db.release === 'function');
  let sp = false;
  try {
    if (inTx) {
      try { await q.query('SAVEPOINT qna_bound_probe'); sp = true; } catch (_) { sp = false; }
    }
    const { rows } = await q.query('SELECT 1 FROM qna_slots WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 LIMIT 1',
      [sheetId, tabName, Number(seq)]);
    if (sp) await q.query('RELEASE SAVEPOINT qna_bound_probe');
    return rows.length > 0;
  } catch (e) {
    if (sp) await q.query('ROLLBACK TO SAVEPOINT qna_bound_probe').catch(() => {});
    logger.warn(`[qnaSlots] 자리 묶임 판정 실패 — 묶인 것으로 봄: ${e.message}`);
    return true;
  }
}

/**
 * 이 모집공고가 Q&A 자리표 탭에 연결돼 있나(차수 추가·삭제 같은 인원 조작을 막는 데 쓴다).
 * @returns {Promise<boolean>} 공고 없음/연결 없음 = false · 조회 실패 = true(fail-closed — 막는 쪽)
 */
async function isQnaCampaign(campaignId) {
  try {
    const { rows } = await _pool().query('SELECT linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id = $1', [String(campaignId)]);
    if (!rows.length || !rows[0].linked_sheet_id || !rows[0].linked_tab_name) return false;
    return await isQnaTab(null, rows[0].linked_sheet_id, rows[0].linked_tab_name);
  } catch (e) {
    logger.warn(`[qnaSlots] 공고 Q&A 판정 실패 — 막음(fail-closed): ${e.message}`);
    return true;
  }
}

/** 주어진 줄 번호 중 자리표에 묶인 것. 조회 실패는 던진다(호출부가 정리를 멈춘다 — fail-closed). */
async function boundSeqs(db, sheetId, tabName, seqs = []) {
  const list = [...new Set((seqs || []).map(n => parseInt(n, 10)).filter(Number.isFinite))];
  if (!list.length) return [];
  const { rows } = await (db || _pool()).query(
    'SELECT seq FROM qna_slots WHERE sheet_id = $1 AND tab_name = $2 AND seq = ANY($3::int[]) ORDER BY seq',
    [sheetId, tabName, list]);
  return rows.map(r => Number(r.seq));
}

/**
 * SQL 조각 — 이 줄(seq)이 자리표에 묶여 있으면 참. 빈 줄 정리 같은 자동 삭제에서 `NOT (…)` 로 쓴다.
 * @param {string} alias  campaign_participants 별칭
 */
function boundRowSql(alias) {
  return `EXISTS (SELECT 1 FROM qna_slots qs WHERE qs.sheet_id = ${alias}.sheet_id AND qs.tab_name = ${alias}.tab_name AND qs.seq = ${alias}.seq)`;
}

/** 탭의 자리표 전체 — 날짜 · 상품 순. */
async function calendarForTab(db, sheetId, tabName) {
  const { rows } = await (db || _pool()).query(
    `SELECT id, seq, unit_key, product_name, option1_value, option2_value, unit_idx, unit_seq,
            to_char(slot_date, 'YYYY-MM-DD') AS slot_date, visibility, question_text, round, status
       FROM qna_slots WHERE sheet_id = $1 AND tab_name = $2
      ORDER BY slot_date, unit_idx, unit_seq`, [sheetId, tabName]);
  return rows;
}

/**
 * 이미 깔린 작업표 줄이 이 계획 줄과 **줄마다 같은가** — 자리표를 그 줄 번호에 붙여도 되는지.
 * 비교 = 줄 번호마다 선택지·진행일자·공개여부·문의문구(자리표를 정하는 칸만).
 * @param {Array<{seq,optionText,startDate,rowJson}>} planRows  `createSheetlessWorktable().rows`
 * @returns {Promise<{ok:boolean, mismatches:number[]}>}  mismatches = 다른(또는 없는) 줄 번호
 */
async function verifyRowsMatchPlan({ db, sheetId, tabName, planRows = [] } = {}) {
  const { QNA_VISIBILITY_HEADER, QNA_TEXT_HEADER } = require('../utils/worktablePlan');
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
      && t(cur.option_text) === t(pr.optionText).slice(0, 200) && t(cur.start_date) === t(pr.startDate).slice(0, 100)   // 저장 때 자르는 길이 그대로
      && t(rj[QNA_VISIBILITY_HEADER]) === t(pj[QNA_VISIBILITY_HEADER])
      && t(rj[QNA_TEXT_HEADER]) === t(pj[QNA_TEXT_HEADER]);
    if (!same) mismatches.push(Number(pr.seq));
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * ★ 자리표 복구 — 접수 때 작업표 줄은 깔렸는데 자리표 저장만 실패한 Q&A 탭을 **재접수**로 되살린다.
 *   지금 오더 값으로 계획을 다시 만들고(같은 오더 = 같은 자리표 — 결정적 생성), 깔린 줄과 줄마다 같을 때만 저장한다.
 *   ★ 하나라도 다르면 저장하지 않는다(fail-closed) — 줄과 어긋난 자리표는 없는 것보다 나쁘다.
 *   접수 뒤에는 오더의 자리표 칸이 잠겨(`_qnaCalendarLocked` — 작업표 연결만으로 잠김) 보통은 같다.
 * @returns {Promise<{ok:boolean, repaired:boolean, inserted?:number, reason?:string, error?:string}>}
 */
async function repairCalendarIfMissing({ workOrder, sheetId, tabName, by = 'admin' } = {}) {
  const q = _pool();
  const { rows: have } = await q.query('SELECT 1 FROM qna_slots WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1', [sheetId, tabName]);
  if (have.length) return { ok: true, repaired: false, reason: 'present' };
  const { createSheetlessWorktable } = require('./sheetlessAccept.service');
  const made = await createSheetlessWorktable({ workOrder, tabName, by });
  if (!made.ok || !Array.isArray(made.qnaSlots) || !made.qnaSlots.length) {
    return { ok: false, repaired: false, reason: 'plan_failed', error: made.error || 'Q&A 자리표 계획을 만들 수 없습니다.' };
  }
  if (made.sheetId !== sheetId) return { ok: false, repaired: false, reason: 'sheet_mismatch', error: '작업표 위치가 오더와 다릅니다.' };
  const v = await verifyRowsMatchPlan({ db: q, sheetId, tabName, planRows: made.rows });
  if (!v.ok) {
    return { ok: false, repaired: false, reason: 'rows_mismatch',
      error: `작업표 줄 ${v.mismatches.length}개가 지금 오더로 만든 자리표와 달라 자리표를 다시 깔 수 없습니다(줄 ${v.mismatches.slice(0, 5).join(', ')}).` };
  }
  const r = await insertCalendar({ workOrderId: workOrder.id, sheetId, tabName, slots: made.qnaSlots, by: `reaccept:${by}` });
  logger.info(`[qnaSlots] 자리표 복구 ${r.inserted}/${made.qnaSlots.length}칸 tab=${tabName}`);
  return { ok: true, repaired: true, inserted: r.inserted };
}

/* ══════════════════════════════════════════════════════════════════════════════
   3단계 — 리뷰어 신청 ↔ 자리 (사용자 확정 2026-11-03 「전부 권장」 · migration 211)
   ══════════════════════════════════════════════════════════════════════════════ */

const DAY_MS = 86400000;
const KST_MS = 9 * 3600000;
/** 신청 뒤 제출 기한(분) — 신청 후 1시간과 그날 자정 중 빠른 쪽. */
const QNA_SUBMIT_MIN = 60;
/** 새 신청을 받지 않기 시작하는 시각(KST 분) — 23:50. 자정 직전에 묶여 10분 안에 못 쓰고 풀리는 자리를 만들지 않는다. */
const QNA_APPLY_CUTOFF_MIN = 23 * 60 + 50;

/** KST 기준 오늘 날짜(YYYY-MM-DD). */
function kstDateStr(now = new Date()) {
  return new Date(now.getTime() + KST_MS).toISOString().slice(0, 10);
}
/** 다음 KST 자정(= 오늘 자리의 마지막 순간). */
function nextKstMidnight(now = new Date()) {
  const k = now.getTime() + KST_MS;
  return new Date(Math.floor(k / DAY_MS) * DAY_MS + DAY_MS - KST_MS);
}
/** 신청 홀드 마감 = min(신청 + 1시간, 그날 자정). */
function qnaHoldExpiry(now = new Date()) {
  return new Date(Math.min(now.getTime() + QNA_SUBMIT_MIN * 60000, nextKstMidnight(now).getTime()));
}
/** 오늘 새 신청 마감(23:50 KST)이 지났나. */
function qnaApplyClosed(now = new Date()) {
  const k = new Date(now.getTime() + KST_MS);
  return k.getUTCHours() * 60 + k.getUTCMinutes() >= QNA_APPLY_CUTOFF_MIN;
}
/** 오늘 새 신청 마감 시각(Date) — 공고 상태의 마감 표시에 쓴다. */
function qnaApplyCutoffAt(now = new Date()) {
  return new Date(nextKstMidnight(now).getTime() - DAY_MS + QNA_APPLY_CUTOFF_MIN * 60000);
}

/**
 * 공고 선택지 키(campaign_options.opt_key) → 자리표 단위 키(unit_key).
 * ★ 공고 선택지는 작업오더에서 `_woOptionRows`(공고 프리필 단일 출처)로 만들어진다 — 같은 함수 결과를 **같은 순서로**
 *   상품·옵션에 짝지어 그 줄이 가리키는 (상품, 옵션)의 `selectionKey` 를 붙인다(이름 규칙 사본 0).
 *   옵션 없는 상품 줄은 공고에 **상품 이름이 키로** 저장된다(운영 실측 2026-11-03: unit_kind='product' 92건 전부 opt_key = product_name).
 * ★ 못 짝지으면 그 선택지는 표에 없다 — 부르는 쪽이 "오늘 자리 없음"으로 접는다(fail-closed).
 * @returns {Map<string,string>}
 */
function qnaOptKeyMap(workOrder) {
  const out = new Map();
  let arr;
  try { arr = JSON.parse((workOrder && workOrder.product_options_json) || '[]'); } catch (_) { arr = null; }
  if (!Array.isArray(arr)) return out;
  const { _woOptionRows } = require('../utils/woCampaignPrefill.generated');
  const { selectionKey } = require('./productOptions.service');
  const rows = _woOptionRows(workOrder) || [];
  const clean = v => String(v == null ? '' : v).replace(/\|/g, '').trim();
  let i = 0;
  for (const prod of arr) {
    const name = String((prod && prod.name) || '').trim();
    // ★ 자리 단위는 자리표(qnaCalendar.qnaUnitsFromWorkOrder)와 **같은 기준** = 상품의 product_mode.
    //   선택지 행의 unitKind 로 정하면 「단일」·「없음」 같은 옵션 이름이 상품 선택지로 접혀 자리표에 없는 단위를 가리킨다.
    const optMode = String((prod && prod.product_mode) || '').trim() === 'opt';
    const opts = Array.isArray(prod && prod.options) ? prod.options : [];
    const units = opts.length ? opts : (clean(prod && prod.name) ? [null] : []);
    for (const op of units) {
      const r = rows[i++];
      if (!r) continue;
      const key = clean(r.optKey) || clean(r.productName);
      const unit = (op && optMode)
        ? selectionKey(name, String((op.option_1 && op.option_1.value) || '').trim(), String((op.option_2 && op.option_2.value) || '').trim())
        : selectionKey(name, '', '');
      if (key && !out.has(key)) out.set(key, unit);
    }
  }
  return out;
}

/**
 * 공고별 오늘 자리 수 — Map(campaignId → { total, byOpt: Map(opt_key → n) }). Q&A 공고(연결 작업표에 자리표가 있는 공고)만 싣는다.
 * ★ 「오늘 남은 자리」의 단일 출처 재료 — `campaignState.fetchCampaignCounts`(공고 정원)·`fetchOptionCountsBatch`(상품별)가 싣는다.
 *   오늘 자리 수 = 오늘 날짜 자리(취소 제외) — 쓴 수(제출·유효 홀드)는 종전 집계가 뺀다(같은 신청 표).
 * ★ 실패 = null(덮지 않음 — 표시는 종전). 실제 신청은 자리 묶기(`pickSlotInTx`)가 fail-closed 로 다시 막는다.
 */
async function loadTodayByCampaign(db, campaignIds, now = new Date()) {
  const ids = (campaignIds || []).filter(Boolean).map(String);
  if (!ids.length) return new Map();
  const q = db || _pool();
  const inTx = !!(db && typeof db.release === 'function');
  let sp = false;
  try {
    if (inTx) { try { await q.query('SAVEPOINT qna_today'); sp = true; } catch (_) { sp = false; } }
    const { rows } = await q.query(
      `SELECT rc.id::text AS campaign_id, s.work_order_id, s.unit_key,
              COUNT(*) FILTER (WHERE s.slot_date = $2::date AND s.status <> 'cancelled')::int AS today_n
         FROM recruit_campaigns rc
         JOIN qna_slots s ON s.sheet_id = rc.linked_sheet_id AND s.tab_name = rc.linked_tab_name
        WHERE rc.id::text = ANY($1::text[])
        GROUP BY 1, 2, 3`, [ids, kstDateStr(now)]);
    const woIds = [...new Set(rows.map(r => r.work_order_id).filter(Boolean))];
    const woMap = new Map();
    if (woIds.length) {
      const { rows: wos } = await q.query('SELECT id, product_options_json FROM work_orders WHERE id = ANY($1::text[])', [woIds]);
      for (const w of wos) woMap.set(String(w.id), w);
    }
    if (sp) await q.query('RELEASE SAVEPOINT qna_today');
    const out = new Map();
    const byCamp = new Map();
    for (const r of rows) {
      if (!byCamp.has(r.campaign_id)) byCamp.set(r.campaign_id, []);
      byCamp.get(r.campaign_id).push(r);
    }
    for (const [cid, list] of byCamp) {
      const unitToday = new Map(list.map(r => [r.unit_key, Number(r.today_n) || 0]));
      const wo = woMap.get(String(list[0].work_order_id));
      const byOpt = new Map();
      for (const [optKey, unitKey] of qnaOptKeyMap(wo)) byOpt.set(optKey, unitToday.get(unitKey) || 0);
      out.set(cid, { total: list.reduce((a, r) => a + (Number(r.today_n) || 0), 0), byOpt });
    }
    return out;
  } catch (e) {
    if (sp) await q.query('ROLLBACK TO SAVEPOINT qna_today').catch(() => {});
    logger.warn(`[qnaSlots] 오늘 자리 수 조회 실패(표시는 종전 · 신청은 자리 묶기가 막는다): ${e.message}`);
    return null;
  }
}

/**
 * 오늘 빈 자리 하나를 고른다(그 상품의 그날 앞 자리부터 — 공개 자리가 그날 첫 자리라 먼저 찬다 · 확정 1).
 * ★ 반드시 신청 트랜잭션 안·작업표 잠금(`camp_tab_daily`) 뒤에서 부른다 — 같은 작업표 신청이 한 줄로 서서 한 자리에 둘이 묶이지 않는다.
 * ★ 마감이 지났는데 아직 스윕이 정리하지 않은 신청은 여기서 먼저 정리한다(부분 유일 색인이 그 신청을 살아 있다고 본다).
 * @returns {Promise<null|{id,seq,unit_key,unit_seq,slot_date,visibility,question_text}>}
 */
async function pickSlotInTx(client, { sheetId, tabName, unitKey, now = new Date(), graceSec } = {}) {
  if (!client || !sheetId || !tabName || !unitKey) return null;
  // 유예 = 신청 홀드와 같은 값(확정·만료 경계가 갈리지 않게 — 단일 출처)
  if (graceSec == null) graceSec = require('./campaignHold.service').HOLD_GRACE_SEC;
  const day = kstDateStr(now);
  await client.query(
    `UPDATE campaign_applications ca SET status = 'expired'
       FROM qna_slots s
      WHERE ca.qna_slot_id = s.id AND s.sheet_id = $1 AND s.tab_name = $2 AND s.unit_key = $3 AND s.slot_date = $4::date
        AND ca.status = 'applied' AND ca.expires_at <= NOW() - make_interval(secs => $5)`,
    [sheetId, tabName, unitKey, day, graceSec]);
  const { rows } = await client.query(
    `SELECT s.id, s.seq, s.unit_key, s.unit_seq, to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date, s.visibility, s.question_text
       FROM qna_slots s
      WHERE s.sheet_id = $1 AND s.tab_name = $2 AND s.unit_key = $3 AND s.slot_date = $4::date AND s.status = 'open'
        AND NOT EXISTS (SELECT 1 FROM campaign_applications ca
                         WHERE ca.qna_slot_id = s.id AND ca.status IN ('applied', 'submitted'))
      ORDER BY (s.visibility <> 'public'), s.unit_seq   -- 공개 자리가 먼저 찬다(확정 1 — 추가 모집으로 순서가 섞여도)
      LIMIT 1
      FOR UPDATE OF s`, [sheetId, tabName, unitKey, day]);
  return rows[0] || null;
}

/** 신청에 묶인 자리(없으면 null). 화면 카드·제출이 읽는다. */
/**
 * 신청 트랜잭션 안에서 이 공고·선택지의 오늘 자리 하나를 묶을 대상을 고른다(`pickSlotInTx` 앞의 선택지→자리 단위 짝짓기).
 * ★ 선택지 없는 공고는 자리 단위가 하나뿐일 때만 그 단위로 본다(여럿이면 고를 근거가 없다 → null).
 * @returns {Promise<null|{slot, unitKey}>} null = 오늘 묶을 자리 없음(fail-closed — 부르는 쪽이 신청을 막는다)
 */
async function bindSlotForApply(client, { sheetId, tabName, optKey = null, now = new Date() } = {}) {
  const { rows: w } = await client.query(
    `SELECT wo.id, wo.product_options_json
       FROM qna_slots s JOIN work_orders wo ON wo.id = s.work_order_id
      WHERE s.sheet_id = $1 AND s.tab_name = $2
      ORDER BY s.id LIMIT 1`, [sheetId, tabName]);
  if (!w.length) return null;
  const map = qnaOptKeyMap(w[0]);
  let unitKey = null;
  if (optKey) unitKey = map.get(String(optKey).trim()) || null;
  else {
    const units = [...new Set(map.values())];
    if (units.length === 1) unitKey = units[0];
  }
  if (!unitKey) return null;
  const slot = await pickSlotInTx(client, { sheetId, tabName, unitKey, now });
  return slot ? { slot, unitKey } : null;
}

/**
 * 리뷰어 화면에 내보내는 자리 정보(내부 번호·작업표 위치는 빼고 할 일만).
 * deadline = 이 신청의 제출 기한(신청 홀드 마감).
 */
function publicSlotView(slot, deadline) {
  if (!slot) return null;
  const pub = slot.visibility === 'public';
  return {
    date: slot.slot_date || null,
    visibility: pub ? 'public' : 'private',
    questionText: pub ? String(slot.question_text || '') : '',
    deadline: deadline ? new Date(deadline).toISOString() : null,
  };
}

async function slotForApplication(db, applicationId) {
  const { rows } = await (db || _pool()).query(
    `SELECT s.id, s.sheet_id, s.tab_name, s.seq, s.unit_key, s.product_name, s.option1_value, s.option2_value,
            to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date, s.visibility, s.question_text, s.status
       FROM campaign_applications ca JOIN qna_slots s ON s.id = ca.qna_slot_id
      WHERE ca.id = $1 LIMIT 1`, [Number(applicationId) || 0]);
  return rows[0] || null;
}

/* ══════════════════════════════════════════════════════════════════════════════
   3단계 — 일정 끝 「추가 모집 / 그대로 끝내기」 (사용자 확정 5 · 결정 321)
   마지막 자리 날짜가 지난 Q&A 공고에 못 채운 자리가 있으면, 순차진행 끝 팝업(campaignSequentialEnd)과 **같은 창**에서 묻는다.
   [추가 모집] = 못 채운 자리를 **같은 공개 여부·문구 그대로** 다음 영업일부터 그 상품의 하루 건수로 다시 깐다
                (자리·작업표 줄을 새로 만들지 않고 그 줄의 진행일자만 옮긴다 — 줄 수·총원 불변).
   [그대로 끝내기] = 못 채운 자리를 닫고(lapsed) 공고를 마감한다.
   ★ 같은 일정 끝(end)에 대한 [추가 모집]은 한 번만(공고 행 잠금 뒤 기록 재확인).
   ══════════════════════════════════════════════════════════════════════════════ */
const QNA_END_ACTIONS = { extra: 'qna_extra', finish: 'qna_finish' };

/** 못 채운 자리 = 그 날짜가 지났고(<= end) 열려 있고 제출된 신청이 없는 자리. */
function _unfilledSql(alias) {
  /* ★ 줄 기준으로도 본다 — 자리 줄에 주문이 앉아 있으면(신청 상태와 어긋난 경우 포함) 채운 자리다.
       줄이 지워진 자리(seq 가 가리키는 살아 있는 줄 없음)는 옮길 줄이 없어 묻지도 옮기지도 않는다. */
  return `${alias}.status = 'open'
      AND NOT EXISTS (SELECT 1 FROM campaign_applications ca2 WHERE ca2.qna_slot_id = ${alias}.id AND ca2.status = 'submitted')
      AND (${alias}.seq IS NULL OR EXISTS (
            SELECT 1 FROM campaign_participants cp2
             WHERE cp2.sheet_id = ${alias}.sheet_id AND cp2.tab_name = ${alias}.tab_name AND cp2.seq = ${alias}.seq
               AND cp2.deleted_at IS NULL AND cp2.order_submission_id IS NULL))`;
}

/**
 * 물을 Q&A 공고 — [{campaignId,title,thumbnailUrl,manager,end,sheetId,tabName,workOrderId,unfilled:[slot...]}]
 * ★ 모르면 묻지 않는다 — 조회 실패는 부르는 쪽이 빈 목록으로 접는다.
 */
async function listQnaEnds(db, { campaignIds = null, now = new Date() } = {}) {
  const q = db || _pool();
  const today = kstDateStr(now);
  const params = [today];
  let idClause = '';
  if (Array.isArray(campaignIds)) { params.push(campaignIds.map(String)); idClause = 'AND rc.id::text = ANY($2::text[])'; }
  const { rows: camps } = await q.query(
    `SELECT rc.id::text AS campaign_id, rc.title, rc.thumbnail_url, rc.manager, rc.linked_sheet_id AS sheet_id, rc.linked_tab_name AS tab_name,
            MIN(s.work_order_id) AS work_order_id,
            to_char(MAX(s.slot_date) FILTER (WHERE s.status <> 'cancelled'), 'YYYY-MM-DD') AS end_date
       FROM recruit_campaigns rc
       JOIN qna_slots s ON s.sheet_id = rc.linked_sheet_id AND s.tab_name = rc.linked_tab_name
      WHERE rc.participation_mode AND rc.status = 'active' AND rc.archived_at IS NULL ${idClause}
      GROUP BY rc.id, rc.title, rc.thumbnail_url, rc.manager, rc.linked_sheet_id, rc.linked_tab_name
     HAVING MAX(s.slot_date) FILTER (WHERE s.status <> 'cancelled') < $1::date`, params);
  if (!camps.length) return [];
  const out = [];
  for (const c of camps) {
    const { rows: un } = await q.query(
      `SELECT s.id, s.seq, s.unit_key, s.unit_seq, s.visibility, s.round, to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date
         FROM qna_slots s
        WHERE s.sheet_id = $1 AND s.tab_name = $2 AND s.slot_date <= $3::date AND ${_unfilledSql('s')}
        ORDER BY s.slot_date, s.unit_key, s.unit_seq`, [c.sheet_id, c.tab_name, c.end_date]);
    if (!un.length) continue;
    out.push({ campaignId: c.campaign_id, title: c.title || '', thumbnailUrl: c.thumbnail_url || '', manager: c.manager || '',
      end: c.end_date, sheetId: c.sheet_id, tabName: c.tab_name, workOrderId: c.work_order_id, unfilled: un });
  }
  return out;
}

/** 팝업에 보일 상품별 모자란 건수 — 이름은 공고 선택지 이름(없으면 자리 단위 이름). */
function qnaShortages(item, workOrder) {
  const back = new Map();
  for (const [optKey, unit] of qnaOptKeyMap(workOrder)) if (!back.has(unit)) back.set(unit, optKey);
  const by = new Map();
  for (const s of item.unfilled) by.set(s.unit_key, (by.get(s.unit_key) || 0) + 1);
  return [...by].map(([unit, n]) => ({ optKey: back.get(unit) || unit, n }));
}

/**
 * 결정 하나 반영(공고마다 독립 트랜잭션 — 부르는 쪽이 BEGIN/COMMIT 하지 않는다).
 * @returns {{ok:true, moved?:number, lapsed?:number}}  실패는 throw(e.code 있음 = 사람에게 보일 말)
 */
async function applyQnaEnd({ campaignId, action, end, actor = 'admin', now = new Date() } = {}) {
  if (!QNA_END_ACTIONS[action]) throw Object.assign(new Error('잘못된 결정입니다.'), { code: 'bad_action' });
  const client = await _pool().connect();
  try {
    await client.query('BEGIN');
    /* ★ 잠금 순서 = 작업표 → 공고(다른 경로와 같은 순서 — 반대로 잡으면 교착 40P01).
         어느 작업표인지는 잠그지 않고 먼저 읽고, 공고를 잠근 뒤 그 연결이 그대로인지 다시 본다. */
    const { rows: pre } = await client.query('SELECT linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id = $1', [campaignId]);
    if (!pre.length || !pre[0].linked_sheet_id || !pre[0].linked_tab_name) throw Object.assign(new Error('게시 중인 공고가 아닙니다.'), { code: 'not_active' });
    // 작업표 줄 기록(Q&A 제출)과 같은 잠금 — 옮기는 사이 그 줄에 제출이 끼지 않는다
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sheetless_worktable:${pre[0].linked_sheet_id}:${pre[0].linked_tab_name}`]);
    const { rows: lock } = await client.query('SELECT id, status, linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
    if (!lock.length || lock[0].status !== 'active') throw Object.assign(new Error('게시 중인 공고가 아닙니다.'), { code: 'not_active' });
    if (lock[0].linked_sheet_id !== pre[0].linked_sheet_id || lock[0].linked_tab_name !== pre[0].linked_tab_name) {
      throw Object.assign(new Error('그사이 상황이 바뀌었습니다 — 다시 확인해 주세요.'), { code: 'changed' });
    }
    const it = (await listQnaEnds(client, { campaignIds: [campaignId], now }))[0];
    if (!it || (end && String(end) !== it.end)) throw Object.assign(new Error('그사이 상황이 바뀌었습니다 — 다시 확인해 주세요.'), { code: 'changed' });
    const { rows: dup } = await client.query(
      `SELECT 1 FROM campaign_plan_events WHERE campaign_id = $1 AND action = $2 AND detail->>'end' = $3 LIMIT 1`,
      [campaignId, QNA_END_ACTIONS.extra, it.end]);
    if (dup.length) throw Object.assign(new Error('다른 담당자가 방금 처리했습니다.'), { code: 'already' });
    const { rows: wos } = await client.query('SELECT * FROM work_orders WHERE id = $1', [it.workOrderId]);
    const wo = wos[0] || {};
    const shortages = qnaShortages(it, wo);
    let moved = 0, lapsed = 0;
    if (action === 'extra') {
      const { businessDays, normalizeHolidayList, QNA_DATE_HEADER } = require('../utils/worktablePlan');
      // 그 상품의 하루 건수 = 처음 자리표에서 하루에 가장 많이 깔린 수(확정 5 — 같은 하루 건수)
      const { rows: per } = await client.query(
        `SELECT unit_key, MAX(n)::int AS per FROM (
           SELECT unit_key, slot_date, COUNT(*) AS n FROM qna_slots
            WHERE sheet_id = $1 AND tab_name = $2 AND status <> 'cancelled' GROUP BY unit_key, slot_date) t
          GROUP BY unit_key`, [it.sheetId, it.tabName]);
      const perDay = new Map(per.map(r => [r.unit_key, Math.max(1, r.per || 1)]));
      const tomorrow = kstDateStr(new Date(now.getTime() + DAY_MS));
      const holidays = normalizeHolidayList(wo.holidays);
      const byUnit = new Map();
      for (const s of it.unfilled) { if (!byUnit.has(s.unit_key)) byUnit.set(s.unit_key, []); byUnit.get(s.unit_key).push(s); }
      for (const [unit, list] of byUnit) {
        const pd = perDay.get(unit) || 1;
        // 공개 자리가 그날 첫 자리라 먼저 찬다(확정 1) — 다시 깔 때도 그날 안에서 공개를 앞에 둔다
        const days = businessDays({ count: Math.ceil(list.length / pd), startDate: tomorrow, skipWeekends: wo.skip_weekends !== false, holidays });
        if (days.length * pd < list.length) throw Object.assign(new Error('다시 깔 날짜를 만들지 못했습니다.'), { code: 'no_days' });
        for (let d = 0; d < days.length; d++) {
          const chunk = list.slice(d * pd, (d + 1) * pd).sort((a, b) => (a.visibility === 'public' ? 0 : 1) - (b.visibility === 'public' ? 0 : 1) || a.unit_seq - b.unit_seq);
          for (const s of chunk) {
            await client.query(`UPDATE qna_slots SET slot_date = $2::date, round = round + 1, updated_at = NOW() WHERE id = $1`, [s.id, days[d].date]);
            if (s.seq != null) {
              const mv = await client.query(
                `UPDATE campaign_participants
                    SET start_date = $4, row_json = jsonb_set(COALESCE(row_json, '{}'::jsonb), ARRAY[$5::text], to_jsonb($4::text), true),
                        updated_by = 'qna-extra', updated_at = NOW()
                  WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL AND order_submission_id IS NULL`,
                [it.sheetId, it.tabName, s.seq, days[d].label, QNA_DATE_HEADER]);
              // 못 채운 자리 = 빈 줄이 살아 있는 자리(위 판정) — 잠금 안에서 줄이 안 움직이면 상황이 바뀐 것이다(전부 되돌린다)
              if (mv.rowCount !== 1) throw Object.assign(new Error('그사이 상황이 바뀌었습니다 — 다시 확인해 주세요.'), { code: 'changed' });
            }
            moved++;
          }
        }
      }
    } else {
      const r = await client.query(
        `UPDATE qna_slots s SET status = 'lapsed', updated_at = NOW()
          WHERE s.id = ANY($1::bigint[]) AND ${_unfilledSql('s')}`, [it.unfilled.map(s => s.id)]);
      lapsed = r.rowCount;
      await client.query(`UPDATE recruit_campaigns SET status = 'closed', updated_at = NOW() WHERE id = $1`, [campaignId]);
    }
    await client.query(
      `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1,$2,$3,$4::jsonb)`,
      [campaignId, String(actor).slice(0, 100), QNA_END_ACTIONS[action],
       JSON.stringify({ end: it.end, after: kstDateStr(now), shortages, moved, lapsed })]);
    await client.query('COMMIT');
    if (action === 'extra') {
      // 작업보드 장부를 새 날짜로 다시 만든다(커밋 뒤 · 실패해도 결정은 유효 — 다음 갱신이 맞춘다)
      try { await require('./sheetlessLedger.service').rebuildLedgers({ sheetId: it.sheetId, tabName: it.tabName, by: 'qna-extra' }); }
      catch (e) { logger.warn(`[qnaSlots] 추가 모집 뒤 장부 갱신 실패(다음 갱신이 맞춘다): ${e.message}`); }
    }
    logger.info(`[qnaSlots] 일정 끝 ${action} camp=${campaignId} end=${it.end} moved=${moved} lapsed=${lapsed}`);
    return { ok: true, moved, lapsed, title: it.title, total: it.unfilled.length };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   3단계 — 캡처 기한 넘긴 신청 정리 (사용자 확정 7 · 결정 321)
   제출 버튼(줄 기록)은 캡처 전에 신청을 확정한다(그래야 캡처를 올릴 줄이 생긴다). 그래서 기한까지 캡처를 안 올리면
   확정된 채 자리를 쥐고 있게 된다 → 기한(+유예 30초 +여유 2분)이 지나도 캡처가 없으면 「줄 삭제」와 같은 길로 푼다:
   주문 취소 + 신청 취소 + 그 줄 삭제 + **같은 날·같은 자리의 빈 줄 보충**(자리표가 새 줄을 가리킴 — trackB.hideWorkdeskRow).
   ★ 판정 = 그 줄의 캡처 제출 여부 — 작업표 줄(campaign_participants.is_submitted · 진실원본)과 색인(review_index) 중
     **하나라도** 냈다고 하면 낸 것(안전한 쪽 — 낸 사람의 자리를 푸는 것이 가장 나쁘다). 리뷰어 화면 captureDone 과 같은 기준.
   ★ 줄 리비전을 넘긴다 — 목록을 읽은 뒤 그 줄이 바뀌었으면(캡처 반영 등) 건너뛴다(다음 주기에 다시 본다).
   ★ 끄는 스위치 `QNA_CAPTURE_SWEEP=0`(자리를 풀지 않을 뿐 — 다른 동작 불변).
   ══════════════════════════════════════════════════════════════════════════════ */
const QNA_CAPTURE_SWEEP_BUFFER_SEC = 120;

async function listQnaCaptureTimeouts(db, { limit = 20 } = {}) {
  const grace = require('./campaignHold.service').HOLD_GRACE_SEC;
  const { rows } = await (db || _pool()).query(
    `SELECT ca.id AS app_id, ca.order_submission_id::text AS order_submission_id,
            cp.id AS row_id, cp.updated_at::text AS revision, s.sheet_id, s.tab_name, s.seq
       FROM campaign_applications ca
       JOIN qna_slots s ON s.id = ca.qna_slot_id
       JOIN campaign_participants cp
         ON cp.sheet_id = s.sheet_id AND cp.tab_name = s.tab_name AND cp.seq = s.seq
        AND cp.deleted_at IS NULL AND cp.order_submission_id = ca.order_submission_id
      WHERE ca.status = 'submitted' AND ca.qna_slot_id IS NOT NULL
        AND ca.expires_at <= NOW() - make_interval(secs => $1)
        AND cp.is_submitted IS NOT TRUE   -- 캡처 제출의 진실원본 = 작업표 줄(색인은 재생성 때 지워질 수 있다)
        AND NOT EXISTS (SELECT 1 FROM review_index ri
                         WHERE ri.sheet_id = s.sheet_id AND ri.tab_name = s.tab_name AND ri.row_index = s.seq
                           AND ri.is_submitted = TRUE)
      ORDER BY ca.id
      LIMIT $2`, [grace + QNA_CAPTURE_SWEEP_BUFFER_SEC, Math.max(1, Number(limit) || 20)]);
  return rows;
}

async function sweepQnaCaptureTimeouts({ db = null, limit = 20 } = {}) {
  if (process.env.QNA_CAPTURE_SWEEP === '0') return { off: true, released: 0 };
  const due = await listQnaCaptureTimeouts(db, { limit });
  let released = 0, failed = 0;   // ★ 'skipped' 는 withJobLock 의 「잠금 양보」 표식과 겹쳐 쓰지 않는다
  for (const r of due) {
    try {
      const out = await require('./trackB.service').hideWorkdeskRow({
        sheetId: r.sheet_id, tabName: r.tab_name, rowId: r.row_id, by: 'qna-capture-timeout', expectedRevision: r.revision });
      if (out && out.ok) {
        released++;
        logger.info(`[qnaSlots] 캡처 기한 넘김 — 자리 풀기 app=${r.app_id} os=${r.order_submission_id} tab=${r.tab_name} seq=${r.seq} → 새 줄 ${out.replacementSeq || '-'}`);
      } else {
        failed++;
        logger.warn(`[qnaSlots] 캡처 기한 넘김 정리 건너뜀 app=${r.app_id} seq=${r.seq}: ${(out && out.error) || 'unknown'}`);
      }
    } catch (e) {
      failed++;
      logger.warn(`[qnaSlots] 캡처 기한 넘김 정리 실패 app=${r.app_id} seq=${r.seq}: ${e.message}`);
    }
  }
  return { released, failed };
}

module.exports = { insertCalendar, isQnaTab, isQnaCampaign, isBoundRow, boundSeqs, boundRowSql, calendarForTab, verifyRowsMatchPlan, repairCalendarIfMissing,
  QNA_SUBMIT_MIN, QNA_APPLY_CUTOFF_MIN, kstDateStr, nextKstMidnight, qnaHoldExpiry, qnaApplyClosed, qnaApplyCutoffAt,
  qnaOptKeyMap, loadTodayByCampaign, pickSlotInTx, bindSlotForApply, publicSlotView, slotForApplication,
  QNA_END_ACTIONS, listQnaEnds, qnaShortages, applyQnaEnd,
  QNA_CAPTURE_SWEEP_BUFFER_SEC, listQnaCaptureTimeouts, sweepQnaCaptureTimeouts };
