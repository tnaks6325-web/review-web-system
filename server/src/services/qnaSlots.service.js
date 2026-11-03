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
 *   단, 표가 아직 없는 환경(42P01)은 Q&A 탭이 하나도 없다는 뜻이라 false.
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
 * @returns {Promise<boolean>} 조회 실패 = true(fail-closed — 자동 정리를 쉰다). 표 없음(42P01) = false.
 */
async function isQnaTab(db, sheetId, tabName) {
  if (!sheetId || !tabName) return false;
  try {
    const { rows } = await (db || _pool()).query(
      'SELECT 1 FROM qna_slots WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1', [sheetId, tabName]);
    return rows.length > 0;
  } catch (e) {
    if (e && e.code === '42P01') return false;
    logger.warn(`[qnaSlots] Q&A 탭 판정 실패 — 자동 정리를 건너뜀(fail-closed): ${e.message}`);
    return true;
  }
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

module.exports = { insertCalendar, isQnaTab, boundRowSql, calendarForTab };
