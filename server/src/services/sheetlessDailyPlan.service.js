/**
 * sheetlessDailyPlan.service.js — 무시트 작업표의 날짜 (탈 구글시트 · 결정 182)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★★ 2026-09-26 사용자 확정(결정 182 — D3-a 뒤집기): 날짜별 모집 인원은 **규칙**(일건수·주말/공휴일·
 *   시작일·이월 방식·총 인원)이 정하고 **작업표가 따라간다**. 이 파일은 "따라가기"만 한다.
 *   종전(D3-a · 2026-08-07)의 "작업표 날짜 분배를 달력에 옮겨 적기(prefillFromWorktable)"와
 *   "저장한 날짜만 맞추기 · 모자라면 줄 새로 만들기(sync/rebuildAdjustedPlansToWorktable)"는 지웠다 —
 *   옮겨 적힌 날은 일건수·이월·주말 변경이 반영되지 않았고, 줄 생성은 총 인원보다 줄을 늘렸다.
 *
 *   - readWorktableDates        : 작업표의 날짜별 줄 수(조절 창 표시 재료 · 읽기 전용)
 *   - relayWorktableToProjection: 빈 줄 날짜를 날짜별 예상 인원(campaignState.projectDailyQuotas)에 맞춤
 *
 * ★★ 날짜 컬럼 찾기·파싱은 기존 단일 출처(`campaignSchedule.findDateColumnIndex` +
 *   `utils/koreanDate.parseDateColumn`) — 여기서 규칙을 다시 만들면 "작업표는 8/7 인데 계산은 8/8" 로 갈린다.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const pool = require('../db/pool');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

function _kstDateLabel(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  // ★★ 표기는 **작업표를 처음 만든 함수와 같은 것**을 쓴다(`worktablePlan.sheetDateStr`) —
  //   종전엔 여기만 `8/19 (수)`(공백 없음)를 써서 같은 열에 `8 / 19 (수)` 와 두 표기가 섞였다(실측).
  //   파서는 둘 다 읽지만 사람이 보는 표·CSV 가 갈리므로 사본을 두지 않는다.
  const { sheetDateStr } = require('../utils/worktablePlan');
  return sheetDateStr({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
}

/**
 * 작업표의 **빈 준비 줄 날짜**를 날짜별 예상 인원(projectDailyQuotas)에 맞춰 옮긴다(결정 182).
 *
 * "규칙이 날짜별 인원을 정하고 작업표가 따라간다" — 이 함수가 그 "따라가기"다.
 * ★★ **줄을 새로 만들지 않는다** — 줄 수는 총 인원 동기화(syncWorktableSlotsInTx)가 맞춘다.
 *   종전 재구성(rebuildAdjustedPlansToWorktable)은 모자라면 줄을 새로 만들어, 전체 날짜로 돌리면
 *   총 인원보다 줄이 늘었다. 모자라면 **모자란 수를 말한다**(shortage).
 * ★★ 참여자·수취인·연락처·주문이 있는 줄은 절대 옮기지 않는다(빈 줄만).
 * ★ 이미 맞는 날짜에 있는 빈 줄은 그대로 둔다(바뀌는 줄을 최소로). 남는 빈 줄은 날짜를 비운다
 *   (날짜 없음 = 구매 시 오늘 줄 다음으로 쓰인다 — sheetlessOrder._pickOpenSlot).
 * ★ 날짜 표기는 작업표를 처음 만든 함수와 같은 `_kstDateLabel`.
 * @param {Array<{date:string, quota:number}>} days  오늘 이후 예상 인원(쉬는 날은 quota 0)
 * @returns {Promise<{ok:boolean, reason?:string, moved?:number, cleared?:number, shortage?:number, dateHeader?:string}>}
 */
async function relayWorktableToProjection({ client, sheetId, tabName, days = [], today = '', by = 'system' } = {}) {
  if (!client || !sheetId || !tabName) return { ok: false, reason: 'worktable_not_linked' };
  const want = new Map();
  for (const x of days || []) {
    const date = String((x && x.date) || '');
    const q = Math.max(0, Number(x && x.quota) || 0);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today && q > 0) want.set(date, q);
  }
  const { rows } = await client.query(
    `SELECT id, seq, reviewer_name, recipient_name, phone8, order_submission_id, row_json
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
      ORDER BY seq FOR UPDATE`, [sheetId, tabName]);
  if (!rows.length) return { ok: false, reason: 'no_worktable_rows' };
  const { findDateColumnIndex } = require('./campaignSchedule.service');
  const headers = [];
  for (const r of rows) for (const k of Object.keys(r.row_json || {})) if (k && !headers.includes(k)) headers.push(k);
  const dateIdx = findDateColumnIndex(headers);
  if (dateIdx < 0) return { ok: false, reason: 'no_date_column' };
  const dateHeader = headers[dateIdx];
  const { parseDateColumn } = require('../utils/koreanDate');
  const anchor = String(today || '').match(/^(\d{4})-(\d{2})/);
  const parsed = parseDateColumn(rows.map(r => String((r.row_json || {})[dateHeader] || '')), {
    fallbackAnchor: anchor ? { y: Number(anchor[1]), m: Number(anchor[2]) } : undefined,
  });
  // ★ 빈 줄 판정은 단일 출처(utils/rowNumbering.isFilledRow — 게이지·번호 정리와 같은 네 칸)
  const { isFilledRow } = require('../utils/rowNumbering');
  const slots = rows.map((r, i) => ({
    id: r.id, seq: Number(r.seq) || 0, date: parsed[i] || '', rawDate: String((r.row_json || {})[dateHeader] || ''),
    empty: !isFilledRow(r),
  }));
  const fixed = new Map();
  for (const s of slots) if (!s.empty && s.date) fixed.set(s.date, (fixed.get(s.date) || 0) + 1);
  const need = new Map();
  for (const [d, q] of want) need.set(d, Math.max(0, q - (fixed.get(d) || 0)));

  // 이미 맞는 날짜에 있는 빈 줄은 필요한 만큼 그 자리에 둔다
  const keptOn = new Map();
  const pool = [];
  for (const s of slots) {
    if (!s.empty) continue;
    const n = need.get(s.date) || 0;
    const k = keptOn.get(s.date) || 0;
    if (s.date && k < n) keptOn.set(s.date, k + 1);
    else pool.push(s);
  }
  // 옮길 줄 순서: 날짜 없음 → 지난 날 → 앞날(번호 순) — 가까운 앞날 줄을 흔들지 않는다
  const tier = s => (!s.date ? 0 : s.date < today ? 1 : 2);
  pool.sort((a, b) => (tier(a) - tier(b)) || (a.seq - b.seq));
  const changed = [];
  let shortage = 0;
  for (const d of [...need.keys()].sort()) {
    let left = (need.get(d) || 0) - (keptOn.get(d) || 0);
    while (left > 0 && pool.length) {
      const s = pool.shift();
      const label = _kstDateLabel(d);
      if (s.rawDate !== label) changed.push({ id: s.id, value: label });
      left--;
    }
    shortage += Math.max(0, left);
  }
  // 남는 빈 줄은 날짜를 비운다(어느 날에도 필요 없는 자리)
  for (const s of pool) if (s.rawDate) changed.push({ id: s.id, value: '' });
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
  return { ok: true, dateHeader, moved: changed.filter(c => c.value).length,
    cleared: changed.filter(c => !c.value).length, shortage };
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

module.exports = {
  readWorktableDates,
  relayWorktableToProjection,
  __setPoolForTest,
};
