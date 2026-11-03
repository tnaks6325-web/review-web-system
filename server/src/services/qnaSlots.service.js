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

module.exports = { insertCalendar, isQnaTab, isQnaCampaign, isBoundRow, boundSeqs, boundRowSql, calendarForTab, verifyRowsMatchPlan, repairCalendarIfMissing };
