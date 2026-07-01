/**
 * Phase 2b — campaign_participants → 실제 구글시트 되쓰기(DB→시트 단방향 미러).
 *
 * ★ 기본 OFF: PARTICIPANTS_SHEET_MIRROR=1 게이트 + master 트리거에서만 작동. 배포만으로 시트 접촉 0.
 *   되쓰기는 큐(participant_mirror)에서 order_update/order_cancel의 검증된 가드로 처리:
 *   - 신원(연락처+수취인) 다중칸 재확인 후에만 그 행에 씀(교차오염 방어).
 *   - 빈칸-only 쓰기(사람이 손댄 셀은 conflict 보류 — 클로버 금지).
 *   - throttle busy면 양보(멱등이라 재큐 안전). gid/sheet_row 없는 행·수동추가(seq 900000+)는 MVP 제외.
 */
const { logger } = require('../utils/logger');

let _pool;
function getPool() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

function GATE() { return process.env.PARTICIPANTS_SHEET_MIRROR === '1'; }

// R2/R5: 제출/입금 셀 정규화(문구 다양성 동치 — 핑퐁/오탐 흡수).
function _normSubmitCell(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return '';
  if (['O', '완료', '제출', 'Y', 'YES', 'TRUE', 'V', '✓', '1'].includes(s)) return 'O';
  return s;
}
function _wantMark(flag) { return flag ? 'O' : ''; }

// 탭단위 미러 enqueue. 게이트 + sheet_row/gid/submit_col 있는 import 행만 대상(MVP 경계).
async function enqueueTabMirror({ sheetId, tabName, by = 'master' } = {}) {
  if (!GATE()) return { skipped: true, reason: 'gate_off' };
  if (!sheetId || !tabName) throw new Error('enqueueTabMirror: sheetId, tabName 필수');
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
        AND source='import' AND sheet_row IS NOT NULL AND tab_gid IS NOT NULL
        AND (submit_col IS NOT NULL OR submit_col2 IS NOT NULL)
      ORDER BY seq LIMIT 5000`,
    [sheetId, tabName]
  );
  if (!rows.length) return { enqueued: 0, reason: 'no_eligible_rows' };
  const ids = rows.map(r => r.id);
  const { enqueue } = require('./syncQueue.service'); // 지연 require(순환참조 안전)
  await enqueue('participant_mirror', { sheetId, tabName, ids, by });
  return { enqueued: ids.length };
}

module.exports = { enqueueTabMirror, _normSubmitCell, _wantMark, GATE, __setPoolForTest };
