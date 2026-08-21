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
  // ★★ 표기는 **작업표를 처음 만든 함수와 같은 것**을 쓴다(`worktablePlan.sheetDateStr`) —
  //   종전엔 여기만 `8/19 (수)`(공백 없음)를 써서 같은 열에 `8 / 19 (수)` 와 두 표기가 섞였다(실측).
  //   파서는 둘 다 읽지만 사람이 보는 표·CSV 가 갈리므로 사본을 두지 않는다.
  const { sheetDateStr } = require('../utils/worktablePlan');
  return sheetDateStr({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
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
/** 새 작업표 행에 쓸 **다음 번호**(seq) — 활성 행만 보면 안 된다.
 *  ★★ `uq_participants_seq(sheet_id, tab_name, seq)` 에는 **소프트 삭제·비활성 행도 그대로 들어 있고**,
 *    116 의 삭제 표식(workdesk_participant_deletions)은 "그 번호를 되살리지 말라"는 기록이다.
 *    활성 행 기준으로 번호를 매기면 [🧹 줄 정리]로 **뒤쪽 줄을 지운 탭**에서 인원을 늘리는 순간
 *    지운 번호를 다시 써 23505 로 **조절 저장이 통째로 실패**하고, 운 좋게 안 겹쳐도 삭제한 줄이
 *    같은 번호로 되살아난다(삭제 표식의 목적 위반). 그래서 **지운 것까지 포함한 최대값 + 1** 에서 시작한다. */
async function _nextSeqStart(client, sheetId, tabName) {
  const { rows } = await client.query(
    `SELECT GREATEST(
              COALESCE((SELECT MAX(seq) FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2), 0),
              COALESCE((SELECT MAX(seq) FROM workdesk_participant_deletions WHERE sheet_id=$1 AND tab_name=$2), 0)
            ) AS max_seq`,
    [sheetId, tabName]);
  return (Number(rows[0] && rows[0].max_seq) || 0) + 1;
}

async function syncAdjustedPlansToWorktable({ client, sheetId, tabName, set = [], planned = null, today = '', by = 'system' } = {}) {
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
  /* ★★ 그날 **이미 채워진 줄(참여·주문)** 도 그날 계획에 포함해서 센다 — 재구성 경로와 같은 규칙.
     종전엔 빈 줄만 세어 "오늘 12명" 계획에 확정 3명이 있으면 빈 줄을 12개 더 만들어
     표가 15줄이 됐다(계획보다 3줄 많음, 실측). 계획 = 그날 표의 줄 수여야 총건수가 맞는다. */
  const fixedByDate = new Map();
  for (const r of slots) if (!r.empty && r.date) fixedByDate.set(r.date, (fixedByDate.get(r.date) || 0) + 1);
  /** 그 줄이 "여분"인가 — 계획 없는 날짜이거나, 그날 계획보다 많은 초과분일 때만 다른 날로 옮긴다. */
  const _planFor = (dt) => {
    if (wanted.has(dt)) return wanted.get(dt);
    if (planned && Object.prototype.hasOwnProperty.call(planned, dt)) return Number(planned[dt]) || 0;
    return null;   // 계획 없음 = 여분
  };
  const _spareLeft = new Map();   // 날짜별 남은 여분(초과분) 수
  const _isSpare = (r) => {
    if (!r.date) return true;                       // 날짜 없는 준비 행
    const p = _planFor(r.date);
    if (p === null) return true;                    // 계획이 없는 날짜
    if (!_spareLeft.has(r.date)) {
      const have = editable.filter(x => x.date === r.date).length + (fixedByDate.get(r.date) || 0);
      _spareLeft.set(r.date, Math.max(0, have - p));
    }
    const left = _spareLeft.get(r.date);
    if (left <= 0) return false;                    // 계획을 지켜야 하는 줄
    _spareLeft.set(r.date, left - 1);
    return true;
  };
  const changed = [];
  const freed = [];   // 이번 저장에서 비운(=계획 밖이 된) 빈 줄 — 재사용되지 않으면 정리한다
  let moved = 0, cleared = 0, created = 0, nextSeq = 0;

  // 먼저 축소해 남는 빈 자리를 재사용 가능 상태로 만든다.
  for (const [date, count] of wanted) {
    const keep = Math.max(0, count - (fixedByDate.get(date) || 0));   // 확정분이 먼저 자리를 차지한다
    const atDate = editable.filter(r => r.date === date);
    for (const row of atDate.slice(keep)) {
      row.date = '';
      row._freed = true;
      freed.push(row);
      cleared++;
    }
  }
  // 증원은 날짜 없는 행을 우선하고, 부족하면 더 늦은 미래의 빈 준비 행만 당긴다.
  for (const [date, count] of [...wanted.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let need = Math.max(0, count - (fixedByDate.get(date) || 0) - editable.filter(r => r.date === date).length);
    /* ★★ 다른 날짜의 빈 줄을 당겨올 때 **그 날짜의 계획을 깨뜨리면 안 된다** —
       종전엔 미래의 빈 줄을 무조건 가져와, 뺏긴 날짜는 계획 20인데 표가 18줄이 됐다(실측).
       그래서 도너 = ① 날짜 없는 빈 줄 ② 계획에 없는 날짜의 빈 줄 ③ 계획보다 많은 잉여분. */
    const donors = editable
      .filter(r => r.date !== date && (!r.date || r.date > date) && _isSpare(r))
      .sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31') || a.seq - b.seq);
    for (const row of donors) {
      if (!need) break;
      row.date = date;
      row._freed = false;   // 재사용됐다 — 정리 대상이 아니다
      changed.push({ id: row.id, value: _kstDateLabel(date) });
      moved++; need--;
    }
    if (need) {
      // 빈 준비 행이 모두 찼어도 날짜 조절 자체를 막지 않는다. 새 빈 작업표 행을
      // 같은 트랜잭션으로 만들어, 0명 날짜를 늘린 결과가 실제 표에도 보이게 한다.
      // ★ 번호는 **함수 시작에 한 번** 구해 이어 쓴다 — 날짜마다 다시 구하면서 누적 카운터를
      //   더하면 번호가 건너뛰며 폭주한다(실측: 200줄짜리 표에 seq 1100).
      if (nextSeq === 0) nextSeq = await _nextSeqStart(client, sheetId, tabName);
      const blank = {};
      headers.forEach(h => { blank[h] = ''; });
      for (let i = 0; i < need; i++) {
        const value = _kstDateLabel(date);
        const rowJson = { ...blank, [dateHeader]: value };
        await client.query(
          `INSERT INTO campaign_participants
             (sheet_id, tab_gid, tab_name, seq, start_date, row_json, source, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'worktable', $7, NOW())`,
          [sheetId, rows[0].tab_gid || null, tabName, nextSeq, value,
            JSON.stringify(rowJson), String(by).slice(0, 100)]);
        nextSeq++; created++; moved++;
      }
    }
  }
  /* ★★ 계획을 줄여 비게 된 빈 줄은 **표에서 내린다**(사용자 확정 2026-08-19 —
     "총건수보다 부족하게 저장하면 작업보드에도 줄어듦이 반영되도록").
     ★ 참여자·주문이 붙은 줄은 애초에 editable 이 아니라 여기 올 수 없다.
     ★ 소프트 삭제라 되돌릴 수 있고, 다시 늘리면 새 줄이 생긴다(seq 는 _nextSeqStart 가 뒤에서 준다). */
  const trim = freed.filter(r => r._freed);
  if (trim.length) {
    await client.query(
      `UPDATE campaign_participants
          SET deleted_at = NOW(), active = FALSE, updated_by = $2, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND order_submission_id IS NULL`,
      [trim.map(r => r.id), String(by).slice(0, 100)]);
  }
  for (const c of changed) {
    await client.query(
      `UPDATE campaign_participants
          SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
              start_date = $3, updated_by = $4, updated_at = NOW()
        WHERE id = $1`, [c.id, dateHeader, c.value, String(by).slice(0, 100)]);
  }
  return { ok: true, dateHeader, moved, cleared, created, trimmed: trim.length, changed: changed.length };
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
  // 800행을 한 행씩 UPDATE하면 네트워크 왕복만으로 수 분이 걸려 요청이 끊긴다.
  // VALUES 배치 하나로 원장 갱신을 끝내고, 이후 장부 투영도 같은 요청 안에서 수행한다.
  if (changed.length) {
    const vals = [], params = [];
    changed.forEach((c, i) => {
      const n = i * 2;
      vals.push(`($${n + 1}::uuid,$${n + 2}::text)`);
      params.push(c.id, c.value);
    });
    params.push(dateHeader, String(by).slice(0, 100));
    await client.query(
      `UPDATE campaign_participants p
          SET row_json=COALESCE(p.row_json,'{}'::jsonb) || jsonb_build_object($${params.length - 1}::text,v.value),
              start_date=v.value, updated_by=$${params.length}::text, updated_at=NOW()
         FROM (VALUES ${vals.join(',')}) AS v(id,value) WHERE p.id=v.id`, params);
  }
  const seqStart = await _nextSeqStart(client, sheetId, tabName);
  const blank = {}; headers.forEach(h => { blank[h] = ''; });
  const inserts = assignments.filter(a => !a.row);
  for (let i = 0; i < inserts.length; i++) {
    const value = _kstDateLabel(inserts[i].date);
    await client.query(
      `INSERT INTO campaign_participants
         (sheet_id, tab_gid, tab_name, seq, start_date, row_json, source, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'worktable',$7,NOW())`,
      [sheetId, rows[0].tab_gid || null, tabName, seqStart + i, value,
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
      // ★ 기준을 작업보드 그리드·조절 실행과 같게(active = TRUE) — 비활성 행까지 세면
      //   모달의 "기본 N명"이 실제 표보다 많아 보이고, 조절은 그 행을 옮기지도 못한다.
      `SELECT row_json, order_submission_id, reviewer_name, recipient_name, phone8
         FROM campaign_participants
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE
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

  /* ★★ 날짜별 **채워진 줄** 수도 함께 센다 — 주말 정책 재배분(①②)이 "그 날을 0명으로
     닫아도 되는가"를 판단하는 재료다. 이미 참여·주문이 있는 날을 0 으로 계획하면
     rebuildAdjustedPlansToWorktable 이 worktable_rebuild_below_used 로 **재구성 전체를
     거부**하므로, 화면이 애초에 그런 값을 만들지 않게 하한을 알려 준다.
     ★ 판정은 `utils/rowNumbering.isFilledRow` 단일 출처(작업보드 게이지·번호 정리와 같은 네 칸). */
  const { isFilledRow } = require('../utils/rowNumbering');
  const byDate = {}, filledByDate = {};
  let parsed = 0;
  iso.forEach((d, i) => {
    if (!d) return;
    byDate[d] = (byDate[d] || 0) + 1;
    if (isFilledRow(rows[i])) filledByDate[d] = (filledByDate[d] || 0) + 1;
    parsed++;
  });
  if (!parsed) return { ok: false, reason: 'unparsable', dateHeader };

  return { ok: true, byDate, filledByDate, dateHeader, parsedRows: parsed, totalRows: rows.length };
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
