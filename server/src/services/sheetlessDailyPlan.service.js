/**
 * sheetlessDailyPlan.service.js — 작업표 날짜 분배 → 달력 프리필 (탈 구글시트 W2-b · D3-a)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 사용자 확정 **D3-a: 날짜별 정원 = `campaign_daily_plans`(달력) 일원화**.
 *
 *   시트 시절: 구매일자 칸의 날짜 개수 = 그날 정원 (063 이 시트를 읽어 파생)
 *   무시트   : 같은 날짜 분배를 **달력에 옮겨 담고**, 그 뒤로는 달력이 진실원본
 *              (그래서 [📅 인원] 조절 모달이 열린다 — 시트 일정 캠페인은 저장이 잠긴다)
 *
 * ★★ **날짜 재료는 작업표(`campaign_participants.row_json`)** — 접수 때 `planToSheetValues`
 *   가 넣은 `M / D (요일)` 그대로다. 날짜 컬럼 찾기·파싱은 **기존 단일 출처를 그대로 쓴다**
 *   (`campaignSchedule.findDateColumnIndex` + `utils/koreanDate.parseDateColumn`) —
 *   여기서 규칙을 다시 만들면 "작업표는 8/7 인데 달력은 8/8" 로 갈린다.
 *
 * ★★ **이미 있는 날짜는 절대 덮지 않는다**(`ON CONFLICT DO NOTHING`) — 관리자가 손으로 조절해
 *   둔 값을 공고 수정 한 번에 되돌리면 안 된다(095 의 "조절 = 계획 변경" 규율).
 * ★ **지난 날짜는 넣지 않는다** — `savePlans` 가 과거 날짜를 거부하므로 화면에서 지울 수도 없는
 *   행이 쌓인다.
 * ★ fail-soft: 실패해도 공고 발행은 성공한다(달력은 나중에 화면에서 채울 수 있다).
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');
const pool = require('../db/pool');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

const MAX_PLAN_DAYS = 400;   // 상한(비정상 데이터로 달력이 폭발하는 것 방지)

function _kstDateLabel(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${Number(m[2])}/${Number(m[3])} (${['일', '월', '화', '수', '목', '금', '토'][day]})`;
}

/**
 * 수동 조절한 미래 날짜를 작업표의 빈 준비 행에도 반영한다.
 * 참여자·주문이 있는 행은 절대 이동하지 않으며, 달력 저장 트랜잭션과 함께 실행한다.
 */
async function syncAdjustedPlansToWorktable({ client, sheetId, tabName, set = [], today = '', by = 'system' } = {}) {
  if (!client || !sheetId || !tabName || !Array.isArray(set) || !set.length) {
    return { ok: true, skipped: true, reason: 'no_link_or_change', moved: 0, cleared: 0 };
  }
  const wanted = new Map();
  for (const x of set) {
    if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.date || ''))) continue;
    wanted.set(String(x.date), Math.max(0, Number(x.count) || 0));
  }
  if (!wanted.size) return { ok: true, skipped: true, reason: 'no_valid_change', moved: 0, cleared: 0 };

  const { rows } = await client.query(
    `SELECT id, seq, tab_gid, reviewer_name, recipient_name, phone8, order_submission_id, row_json
       FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE
      ORDER BY seq FOR UPDATE`, [sheetId, tabName]);
  if (!rows.length) return { ok: true, skipped: true, reason: 'no_worktable_rows', moved: 0, cleared: 0 };

  const { findDateColumnIndex } = require('./campaignSchedule.service');
  const headers = [];
  for (const r of rows) for (const k of Object.keys(r.row_json || {})) if (k && !headers.includes(k)) headers.push(k);
  const dateIdx = findDateColumnIndex(headers);
  if (dateIdx < 0) return { ok: true, skipped: true, reason: 'no_date_column', moved: 0, cleared: 0 };
  const dateHeader = headers[dateIdx];
  const { parseDateColumn } = require('../utils/koreanDate');
  const anchor = String(today || '').match(/^(\d{4})-(\d{2})/);
  const parsed = parseDateColumn(rows.map(r => String((r.row_json || {})[dateHeader] || '')), {
    fallbackAnchor: anchor ? { y: Number(anchor[1]), m: Number(anchor[2]) } : undefined,
  });
  const slots = rows.map((r, i) => ({ ...r, date: parsed[i] || '', empty: !String(r.reviewer_name || '').trim() && !String(r.recipient_name || '').trim() && !String(r.phone8 || '').trim() && !r.order_submission_id }));
  const editable = slots.filter(r => r.empty && (!r.date || !today || r.date >= today));
  const changed = [];
  let moved = 0, cleared = 0, created = 0;

  // 먼저 축소해 남는 빈 자리를 재사용 가능 상태로 만든다.
  for (const [date, count] of wanted) {
    const atDate = editable.filter(r => r.date === date);
    for (const row of atDate.slice(Math.max(0, count))) {
      row.date = '';
      changed.push({ id: row.id, value: '' });
      cleared++;
    }
  }
  // 증원은 날짜 없는 행을 우선하고, 부족하면 더 늦은 미래의 빈 준비 행만 당긴다.
  for (const [date, count] of [...wanted.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let need = Math.max(0, count - editable.filter(r => r.date === date).length);
    const donors = editable.filter(r => r.date !== date && (!r.date || r.date > date)).sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31') || a.seq - b.seq);
    for (const row of donors) {
      if (!need) break;
      row.date = date;
      changed.push({ id: row.id, value: _kstDateLabel(date) });
      moved++; need--;
    }
    if (need) {
      // 빈 준비 행이 모두 찼어도 날짜 조절 자체를 막지 않는다. 새 빈 작업표 행을
      // 같은 트랜잭션으로 만들어, 0명 날짜를 늘린 결과가 실제 표에도 보이게 한다.
      const maxSeq = rows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
      const blank = {};
      headers.forEach(h => { blank[h] = ''; });
      for (let i = 0; i < need; i++) {
        const value = _kstDateLabel(date);
        const rowJson = { ...blank, [dateHeader]: value };
        await client.query(
          `INSERT INTO campaign_participants
             (sheet_id, tab_gid, tab_name, seq, start_date, row_json, source, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'worktable', $7, NOW())`,
          [sheetId, rows[0].tab_gid || null, tabName, maxSeq + created + 1, value,
            JSON.stringify(rowJson), String(by).slice(0, 100)]);
        created++; moved++;
      }
    }
  }
  for (const c of changed) {
    await client.query(
      `UPDATE campaign_participants
          SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
              start_date = $3, updated_by = $4, updated_at = NOW()
        WHERE id = $1`, [c.id, dateHeader, c.value, String(by).slice(0, 100)]);
  }
  return { ok: true, dateHeader, moved, cleared, created, changed: changed.length };
}

/**
 * 작업표 날짜 분배를 읽는다(달력에 넣기 전 계산만).
 * @returns {Promise<{ok:boolean, byDate?:object, reason?:string}>}
 *   byDate = { 'YYYY-MM-DD': 그날 행 수 }
 */
async function readWorktableDates({ sheetId, tabName }) {
  if (!sheetId || !tabName) return { ok: false, reason: 'bad_request' };
  const db = getPool();

  let rows;
  try {
    const r = await db.query(
      `SELECT row_json FROM campaign_participants
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
        ORDER BY seq`, [sheetId, tabName]);
    rows = r.rows;
  } catch (e) {
    return { ok: false, reason: 'query_failed', message: e.message };
  }
  if (!rows.length) return { ok: false, reason: 'no_rows' };

  // 열 이름은 row_json 키 — 날짜 컬럼 판정은 **기존 함수**(사본 금지)
  const { findDateColumnIndex } = require('./campaignSchedule.service');
  const headers = [];
  for (const r of rows) {
    const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
    for (const k of Object.keys(rj)) if (k && headers.indexOf(k) < 0) headers.push(k);
  }
  const idx = findDateColumnIndex(headers);
  if (idx < 0) return { ok: false, reason: 'no_date_column' };
  const dateHeader = headers[idx];

  const raw = rows.map(r => {
    const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
    const v = rj[dateHeader];
    return v == null ? '' : String(v);
  });

  /* 연도 추론까지 **기존 파서**가 한다(`7 / 23 (목)` 처럼 연도 없는 표기가 실측상 흔하다).
     ★★ `fallbackAnchor` 는 선택이 아니다 — 작업표의 구매일자는 `planToSheetValues` 가
     **전부 `M / D (요일)`** 로 쓰므로 열 안에 연도가 **하나도 없다**. 앵커가 없으면
     `parseDateColumn` 이 전 행 null 을 돌려주고 프리필이 `unparsable` 로 조용히 죽는다
     (프로덕션 E2E 로 실측 — 무시트 공고의 달력 프리필이 한 번도 성공한 적이 없었다).
     다른 소비처(063 시트 일정·시트 우위 점검)는 이미 같은 앵커를 넘긴다 — 여기만 빠져 있었다. */
  const { parseDateColumn } = require('../utils/koreanDate');
  const kstToday = new Date(Date.now() + 9 * 3600 * 1000);
  const iso = parseDateColumn(raw, {
    fallbackAnchor: { y: kstToday.getUTCFullYear(), m: kstToday.getUTCMonth() + 1 },
  });

  const byDate = {};
  let parsed = 0;
  iso.forEach(d => { if (d) { byDate[d] = (byDate[d] || 0) + 1; parsed++; } });
  if (!parsed) return { ok: false, reason: 'unparsable', dateHeader };

  return { ok: true, byDate, dateHeader, parsedRows: parsed, totalRows: rows.length };
}

/**
 * 작업표 날짜 분배를 캠페인 달력에 프리필.
 *
 * @param {object} o
 * @param {string} o.campaignId · o.sheetId · o.tabName
 * @param {string} [o.today]   'YYYY-MM-DD'(KST) — 미지정 시 서버가 계산
 * @param {string} [o.by]
 * @returns {Promise<{ok:boolean, inserted?:number, skipped?:number, reason?:string}>}
 *   skipped = 이미 계획이 있거나 지난 날짜라 넣지 않은 날 수
 */
async function prefillFromWorktable({ campaignId, sheetId, tabName, today = '', by = 'system' } = {}) {
  if (!campaignId) return { ok: false, reason: 'bad_request' };
  const read = await readWorktableDates({ sheetId, tabName });
  if (!read.ok) return read;

  let todayStr = String(today || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayStr)) {
    // ★ KST 파생은 사본을 만들지 않는다(날짜 규칙이 두 벌이면 갈린다)
    try { todayStr = require('./campaignState.service').kstTodayStr(); } catch (_) { todayStr = ''; }
  }

  const dates = Object.keys(read.byDate).sort();
  const db = getPool();
  let inserted = 0, skipped = 0;
  for (const d of dates.slice(0, MAX_PLAN_DAYS)) {
    if (todayStr && d < todayStr) { skipped++; continue; }   // 지난 날짜는 화면에서 지울 수도 없다
    try {
      const r = await db.query(
        `INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count, updated_by, updated_at)
         VALUES ($1, $2::date, $3, $4, NOW())
         ON CONFLICT (campaign_id, plan_date) DO NOTHING`,
        [campaignId, d, read.byDate[d], `작업표:${by}`.slice(0, 100)]);
      if (r.rowCount) inserted++; else skipped++;             // 이미 사람이 조절해 둔 날 = 보존
    } catch (e) {
      // 42P01(095 미적용) 등 — 조용히 넘기지 않고 사유를 올린다
      return { ok: false, reason: 'insert_failed', message: e.message, inserted, skipped };
    }
  }
  if (dates.length > MAX_PLAN_DAYS) skipped += dates.length - MAX_PLAN_DAYS;

  logger.info(`[sheetlessDailyPlan] 달력 프리필 camp=${campaignId} tab=${tabName} 신규 ${inserted}일 · 유지 ${skipped}일`);
  return { ok: true, inserted, skipped, days: dates.length, dateHeader: read.dateHeader };
}

module.exports = {
  readWorktableDates,
  prefillFromWorktable,
  syncAdjustedPlansToWorktable,
  MAX_PLAN_DAYS,
  __setPoolForTest,
};
