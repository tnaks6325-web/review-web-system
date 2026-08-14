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

/** 첫 조절 직전의 작업표 날짜별 인원을 보존한다. 이후 행을 재배치해도 [기본으로]의 기준은 바뀌지 않는다. */
async function captureWorktableDefaults({ client, campaignId, sheetId, tabName, dates = [], today = '' } = {}) {
  if (!client || !campaignId || !sheetId || !tabName || !dates.length) return new Map();
  const { rows } = await client.query(
    `SELECT row_json FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE ORDER BY seq`, [sheetId, tabName]);
  const headers = [];
  for (const r of rows) for (const k of Object.keys(r.row_json || {})) if (k && !headers.includes(k)) headers.push(k);
  const { findDateColumnIndex } = require('./campaignSchedule.service');
  const idx = findDateColumnIndex(headers);
  const counts = new Map();
  if (idx >= 0) {
    const { parseDateColumn } = require('../utils/koreanDate');
    const anchor = String(today || '').match(/^(\d{4})-(\d{2})/);
    const parsed = parseDateColumn(rows.map(r => String((r.row_json || {})[headers[idx]] || '')), {
      fallbackAnchor: anchor ? { y: Number(anchor[1]), m: Number(anchor[2]) } : undefined,
    });
    parsed.forEach(d => { if (d) counts.set(d, (counts.get(d) || 0) + 1); });
  }
  for (const date of [...new Set(dates)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))) {
    await client.query(
      `INSERT INTO campaign_worktable_defaults (campaign_id, plan_date, default_count)
       VALUES ($1,$2::date,$3) ON CONFLICT (campaign_id,plan_date) DO NOTHING`,
      [campaignId, date, counts.get(date) || 0]);
  }
  return counts;
}

async function loadWorktableDefaults({ client, campaignId, dates = [] } = {}) {
  if (!client || !campaignId || !dates.length) return new Map();
  const { rows } = await client.query(
    `SELECT to_char(plan_date,'YYYY-MM-DD') AS date, default_count
       FROM campaign_worktable_defaults WHERE campaign_id=$1 AND plan_date = ANY($2::date[])`,
    [campaignId, dates]);
  return new Map(rows.map(r => [r.date, Number(r.default_count) || 0]));
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
 * 날짜가 꼬인 기존 작업표를 조절 계획으로 다시 배열한다.
 *
 * 이미 참여자·수취인·연락처·주문이 있는 행은 절대 이동하지 않는다. 조절된 미래 날짜와
 * 빈 준비 행만 다루므로, 과거에 남은 "26.8.11" 같은 빈 행은 비워서 가장 이른 조절일에
 * 재사용할 수 있다. 이것은 일반 저장의 증분 동기화가 아니라, 관리자가 명시적으로 누르는
 * 복구 동작이다.
 */
async function rebuildAdjustedPlansToWorktable({ client, sheetId, tabName, plans = [], today = '', by = 'system' } = {}) {
  if (!client || !sheetId || !tabName) {
    const e = new Error('연결된 작업표가 없습니다.'); e.code = 'worktable_not_linked'; throw e;
  }
  const wanted = new Map();
  for (const x of plans || []) {
    const date = String(x && x.date || '');
    if (date >= today && /^\d{4}-\d{2}-\d{2}$/.test(date)) wanted.set(date, Math.max(0, Number(x.count) || 0));
  }
  if (!wanted.size) {
    const e = new Error('오늘 이후의 조절된 모집계획이 없어 재구성할 대상이 없습니다.'); e.code = 'worktable_rebuild_empty'; throw e;
  }
  const { rows } = await client.query(
    `SELECT id, seq, tab_gid, reviewer_name, recipient_name, phone8, order_submission_id, row_json
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
      ORDER BY seq FOR UPDATE`, [sheetId, tabName]);
  if (!rows.length) {
    const e = new Error('작업표 행이 없습니다.'); e.code = 'no_worktable_rows'; throw e;
  }
  const { findDateColumnIndex } = require('./campaignSchedule.service');
  const headers = [];
  for (const r of rows) for (const k of Object.keys(r.row_json || {})) if (k && !headers.includes(k)) headers.push(k);
  const dateIdx = findDateColumnIndex(headers);
  if (dateIdx < 0) {
    const e = new Error('작업표에서 구매일자 컬럼을 찾지 못했습니다.'); e.code = 'no_date_column'; throw e;
  }
  const dateHeader = headers[dateIdx];
  const { parseDateColumn } = require('../utils/koreanDate');
  const anchor = String(today || '').match(/^(\d{4})-(\d{2})/);
  const parsed = parseDateColumn(rows.map(r => String((r.row_json || {})[dateHeader] || '')), {
    fallbackAnchor: anchor ? { y: Number(anchor[1]), m: Number(anchor[2]) } : undefined,
  });
  const slots = rows.map((r, i) => ({ ...r, date: parsed[i] || '', rawDate: String((r.row_json || {})[dateHeader] || ''),
    empty: !String(r.reviewer_name || '').trim() && !String(r.recipient_name || '').trim() && !String(r.phone8 || '').trim() && !r.order_submission_id }));
  const fixedByDate = new Map();
  for (const r of slots) if (!r.empty && r.date) fixedByDate.set(r.date, (fixedByDate.get(r.date) || 0) + 1);
  for (const [date, count] of wanted) {
    const fixed = fixedByDate.get(date) || 0;
    if (fixed > count) {
      const e = new Error(`${date}에는 이미 참여·주문 행이 ${fixed}개 있어 ${count}명으로 재구성할 수 없습니다.`);
      e.code = 'worktable_rebuild_below_used'; e.date = date; e.floor = fixed; throw e;
    }
  }
  const managed = new Set(wanted.keys());
  // 조절 대상 날짜, 날짜가 비어/해석되지 않는 행, 과거 날짜의 빈 행만 재구성 풀에 넣는다.
  // 다른 미래 날짜의 준비 행은 별도 계획일 수 있어 손대지 않는다.
  const pool = slots.filter(r => r.empty && (!r.date || r.date < today || managed.has(r.date))).sort((a, b) => a.seq - b.seq);
  const assignments = [];
  for (const [date, count] of [...wanted.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let need = count - (fixedByDate.get(date) || 0);
    while (need > 0 && pool.length) { assignments.push({ row: pool.shift(), date }); need--; }
    while (need-- > 0) assignments.push({ row: null, date });
  }
  const changed = [];
  for (const a of assignments) {
    if (a.row && a.row.rawDate !== _kstDateLabel(a.date)) changed.push({ id: a.row.id, value: _kstDateLabel(a.date) });
  }
  // 남은 관리 풀은 어떤 조절 날짜에도 필요하지 않은 빈 행이다. 과거/꼬인 날짜만 지워
  // 다음 재구성에서 안전하게 재사용한다. 다른 미래 날짜는 pool에 들어오지 않는다.
  for (const r of pool) if (r.rawDate) changed.push({ id: r.id, value: '' });
  for (const c of changed) {
    await client.query(
      `UPDATE campaign_participants
          SET row_json=COALESCE(row_json,'{}'::jsonb) || jsonb_build_object($2::text,$3::text),
              start_date=$3, updated_by=$4, updated_at=NOW() WHERE id=$1`,
      [c.id, dateHeader, c.value, String(by).slice(0, 100)]);
  }
  const maxSeq = rows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
  const blank = {}; headers.forEach(h => { blank[h] = ''; });
  const inserts = assignments.filter(a => !a.row);
  for (let i = 0; i < inserts.length; i++) {
    const value = _kstDateLabel(inserts[i].date);
    await client.query(
      `INSERT INTO campaign_participants
         (sheet_id, tab_gid, tab_name, seq, start_date, row_json, source, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'worktable',$7,NOW())`,
      [sheetId, rows[0].tab_gid || null, tabName, maxSeq + i + 1, value,
        JSON.stringify({ ...blank, [dateHeader]: value }), String(by).slice(0, 100)]);
  }
  return { ok: true, dateHeader, plannedDates: wanted.size, reassigned: changed.filter(c => c.value).length,
    cleared: changed.filter(c => !c.value).length, created: inserts.length, protectedRows: [...fixedByDate.values()].reduce((a, n) => a + n, 0) };
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
  rebuildAdjustedPlansToWorktable,
  captureWorktableDefaults,
  loadWorktableDefaults,
  MAX_PLAN_DAYS,
  __setPoolForTest,
};
