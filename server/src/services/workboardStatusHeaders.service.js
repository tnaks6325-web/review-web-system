'use strict';
/**
 * ═══════════════════════════════════════════════════════════
 * 작업보드 상태 칸(리뷰제출·입금) 머리글 판정 — ★★ 단일 출처 (결정 281)
 *
 * 작업보드 [진행 현황](trackB.workdeskTab) · 홈 작업목록(tabStatsMap) · 업체관리/업체 요약
 * (ownedTabsForAdvertiser)이 **같은 칸**을 보고 제출·입금을 센다. 종전에는 홈·업체관리가
 * `review_index.submit_col/submit_col2`(시트 시절 장부)에서 칸 이름을 따로 골라, 장부가 빈 탭
 * (「8/3(쿠팡)위프_블랙 탈취제 800건」 — 남은 유일한 시트 기반 탭)에서 작업보드는 입금 775 인데
 * 홈 내부 집계·업체관리는 653(행별 포인터가 빈 140줄을 못 셈)으로 갈렸다.
 *
 * 판정 순서(작업보드와 같다 — workdeskTab 이 이 함수를 그대로 부른다):
 *   입금 = ① 작업표 실제 머리글(raw_sheet_tabs.detected_headers, 없으면 첫 줄 row_json 키) 중
 *          `findPaymentColumnIndex` 가 고른 칸 → ② 작업표 줄의 `submit_col2` 최빈값
 *          → ③ `sheetlessStatus.statusHeaderForTab('paid')`(기록 칸).
 *   제출 = ① 작업표 첫 줄(번호 순)의 `submit_col` → ② `statusHeaderForTab('submit')`.
 *   ★ 칸을 모르면 '' — 호출부는 행별 포인터(`submit_col`/`submit_col2`)로만 센다(지어내지 않는다).
 * ═══════════════════════════════════════════════════════════
 */
const { findPaymentColumnIndex } = require('./columnResolver');

const _txt = v => String(v == null ? '' : v).trim();
const _key = (sheetId, tabName) => `${sheetId}\t${tabName}`;

/** 작업보드 표 머리글 — 감지 헤더(공백·중복 제거) → 없으면 첫 줄 row_json 키(id 제외). 「현영」 원본 칸은 뺀다
 *  (작업보드는 서버 파생 가상 칸 한 벌만 쓴다). workdeskTab 내부 직원 화면과 같은 규칙. */
function boardHeaders(detectedHeaders, firstRowJson) {
  let raw = Array.isArray(detectedHeaders) ? [...new Set(detectedHeaders.map(_txt).filter(Boolean))] : [];
  if (!raw.length && firstRowJson && typeof firstRowJson === 'object') {
    raw = Object.keys(firstRowJson).filter(k => k !== 'id');
  }
  return raw.filter(h => String(h).replace(/\s+/g, '') !== '현영');
}

/** 값 목록 → {머리글: 개수}(빈 값 제외). workdeskTab 은 명단에서, 배치는 SQL 집계에서 만든다. */
function countHeaders(values) {
  const out = {};
  for (const v of values || []) { const h = _txt(v); if (h) out[h] = (out[h] || 0) + 1; }
  return out;
}

/** 입금 칸 ①②(동기) — 머리글에서 찾고, 없으면 줄 포인터 최빈값(동률은 이름순). 모르면 ''. */
function pickPaidHeader(headers, submitCol2Counts) {
  const hs = Array.isArray(headers) ? headers : [];
  const i = findPaymentColumnIndex(hs);
  if (i >= 0) { const h = _txt(hs[i]); if (h) return h; }
  const entries = Object.entries(submitCol2Counts || {}).filter(([h, n]) => _txt(h) && Number(n) > 0);
  entries.sort((a, b) => (Number(b[1]) - Number(a[1])) || a[0].localeCompare(b[0]));
  return entries.length ? _txt(entries[0][0]) : '';
}

/** 제출 칸 ①(동기) — 작업표 첫 줄(번호 순)의 submit_col. */
function pickSubmitHeader(firstSubmitCol) { return _txt(firstSubmitCol); }

/** ③ 폴백 — 서버가 기록하는 칸. 조회 실패 = ''(플래그로 추측하지 않는다). */
async function statusHeaderFallback(db, { sheetId, tabName, kind }) {
  try {
    return _txt(await require('./sheetlessStatus.service').statusHeaderForTab(db, { sheetId, tabName, kind }));
  } catch (_) { return ''; }
}

/**
 * 여러 탭의 상태 칸을 한 번에(N+1 금지) — 집합 쿼리 2~3개 + (칸을 못 찾은, 줄이 있는 탭만) ③ 폴백.
 * @param {object} db  pg pool/client
 * @param {{tabs?: Array<{sheetId,tabName,tabGid}>, submit?: boolean}} opt
 *   tabs 를 안 주면 tab_configs 전체. submit=false 면 제출 칸은 고르지 않는다(홈 집계는 입금 칸만 쓴다 — 폴백 왕복 절약).
 * @returns {Promise<Map<string,{paid:string, submit:string}>>}  키 = `${sheetId}\t${tabName}`
 * ★ 조회 실패는 **throw** — 호출부가 fail 방향을 정한다(홈 통계 = ok:false, 업체관리 = 경고 후 행별 포인터).
 */
async function loadTabStatusHeaders(db, { tabs = null, submit: wantSubmit = true } = {}) {
  const useAll = !Array.isArray(tabs);
  const param = useAll ? null : JSON.stringify(tabs
    .filter(t => t && t.sheetId && t.tabName)
    .map(t => ({ sheet_id: String(t.sheetId), tab_name: String(t.tabName), tab_gid: _txt(t.tabGid) || null })));
  const out = new Map();
  if (!useAll && param === '[]') return out;
  const keysCte = useAll
    ? `keys AS (SELECT sheet_id, tab_name, NULLIF(BTRIM(COALESCE(tab_gid, '')), '') AS tab_gid FROM tab_configs)`
    : `keys AS (SELECT DISTINCT ON (sheet_id, tab_name) sheet_id, tab_name, NULLIF(BTRIM(COALESCE(tab_gid, '')), '') AS tab_gid
                  FROM jsonb_to_recordset($1::jsonb) AS k(sheet_id text, tab_name text, tab_gid text)
                 ORDER BY sheet_id, tab_name, tab_gid NULLS LAST)`;
  const args = useAll ? [] : [param];
  // ① 작업표 머리글 — workdeskTab 과 같은 선택(gid 일치 우선, 그다음 이름 · 같으면 최신 미러).
  const { rows: hdr } = await db.query(
    `WITH ${keysCte}
     SELECT DISTINCT ON (k.sheet_id, k.tab_name) k.sheet_id AS "sheetId", k.tab_name AS "tabName", rst.detected_headers AS "detectedHeaders"
       FROM keys k
       JOIN raw_sheet_tabs rst ON rst.sheet_id = k.sheet_id
        AND ((k.tab_gid IS NOT NULL AND rst.tab_gid = k.tab_gid) OR rst.tab_name = k.tab_name)
      ORDER BY k.sheet_id, k.tab_name, (k.tab_gid IS NOT NULL AND rst.tab_gid = k.tab_gid) DESC, rst.mirrored_at DESC NULLS LAST`, args);
  // ② 작업표 줄(활성 · 분리 안 됨) — 줄 유무 · 첫 줄(번호 순) submit_col · submit_col2 빈도. 작업보드 명단과 같은 조건.
  const { rows: ptr } = await db.query(
    `WITH ${keysCte},
     live AS (SELECT p.sheet_id, p.tab_name, p.seq, p.submit_col, p.submit_col2
                FROM campaign_participants p JOIN keys k ON k.sheet_id = p.sheet_id AND k.tab_name = p.tab_name
               WHERE p.active = TRUE AND p.deleted_at IS NULL AND p.held_at IS NULL),
     has_rows AS (SELECT DISTINCT sheet_id, tab_name FROM live),
     first_submit AS (SELECT DISTINCT ON (sheet_id, tab_name) sheet_id, tab_name, BTRIM(submit_col) AS h
                        FROM live WHERE NULLIF(BTRIM(submit_col), '') IS NOT NULL ORDER BY sheet_id, tab_name, seq),
     paid_freq AS (SELECT sheet_id, tab_name, jsonb_object_agg(h, n) AS agg FROM (
                     SELECT sheet_id, tab_name, BTRIM(submit_col2) AS h, COUNT(*)::int AS n FROM live
                      WHERE NULLIF(BTRIM(submit_col2), '') IS NOT NULL GROUP BY 1, 2, 3) x GROUP BY 1, 2)
     SELECT r.sheet_id AS "sheetId", r.tab_name AS "tabName", fs.h AS "firstSubmitCol", pf.agg AS "submitCol2Counts"
       FROM has_rows r
       LEFT JOIN first_submit fs ON fs.sheet_id = r.sheet_id AND fs.tab_name = r.tab_name
       LEFT JOIN paid_freq pf ON pf.sheet_id = r.sheet_id AND pf.tab_name = r.tab_name`, args);
  const hm = new Map(hdr.filter(r => r && r.sheetId && r.tabName).map(r => [_key(r.sheetId, r.tabName), r.detectedHeaders]));
  const pm = new Map(ptr.filter(r => r && r.sheetId && r.tabName).map(r => [_key(r.sheetId, r.tabName), r]));
  // ③ 감지 헤더가 비어 있고 줄이 있는 탭만 — 첫 줄 row_json 키(작업보드의 최후 폴백과 같다).
  const needFirstRow = [...pm.keys()].filter(k => !boardHeaders(hm.get(k), null).length);
  const firstRow = new Map();
  if (needFirstRow.length) {
    const { rows: fr } = await db.query(
      `SELECT DISTINCT ON (p.sheet_id, p.tab_name) p.sheet_id AS "sheetId", p.tab_name AS "tabName", p.row_json AS "rowJson"
         FROM campaign_participants p
         JOIN jsonb_to_recordset($1::jsonb) AS k(sheet_id text, tab_name text) ON k.sheet_id = p.sheet_id AND k.tab_name = p.tab_name
        WHERE p.active = TRUE AND p.deleted_at IS NULL AND p.held_at IS NULL
          AND jsonb_typeof(p.row_json) = 'object' AND p.row_json <> '{}'::jsonb
        ORDER BY p.sheet_id, p.tab_name, p.seq`,
      [JSON.stringify(needFirstRow.map(k => { const i = k.indexOf('\t'); return { sheet_id: k.slice(0, i), tab_name: k.slice(i + 1) }; }))]);
    for (const r of fr) if (r && r.sheetId && r.tabName) firstRow.set(_key(r.sheetId, r.tabName), r.rowJson);
  }
  const fallbacks = [];   // [키, 칸 종류] — 아래에서 **하나씩** 부른다(동시에 쏘면 풀 연결을 한꺼번에 잡는다 — 접속 폭주 사고 이력)
  for (const k of new Set([...hm.keys(), ...pm.keys()])) {
    const r = pm.get(k) || null;
    const i = k.indexOf('\t'); const sheetId = k.slice(0, i), tabName = k.slice(i + 1);
    const v = {
      paid: pickPaidHeader(boardHeaders(hm.get(k), firstRow.get(k)), r && r.submitCol2Counts),
      submit: wantSubmit ? pickSubmitHeader(r && r.firstSubmitCol) : '',
    };
    out.set(k, v);
    // ④ 기록 칸 폴백 — 작업보드와 같다. 줄이 없는 탭(셀 것이 없다)은 건너뛴다(왕복 절약).
    if (r) {
      if (!v.paid) fallbacks.push([v, sheetId, tabName, 'paid']);
      if (wantSubmit && !v.submit) fallbacks.push([v, sheetId, tabName, 'submit']);
    }
  }
  for (const [v, sheetId, tabName, kind] of fallbacks) v[kind] = await statusHeaderFallback(db, { sheetId, tabName, kind });
  return out;
}

/** SQL 조인용 jsonb 매개변수 — [{sheet_id, tab_name, paid_header, submit_header}] (모르는 칸은 null). */
function headersParam(map) {
  const arr = [];
  for (const [k, v] of (map || new Map())) {
    const i = k.indexOf('\t');
    arr.push({ sheet_id: k.slice(0, i), tab_name: k.slice(i + 1),
      paid_header: (v && v.paid) || null, submit_header: (v && v.submit) || null });
  }
  return JSON.stringify(arr);
}

module.exports = {
  boardHeaders, countHeaders, pickPaidHeader, pickSubmitHeader, statusHeaderFallback,
  loadTabStatusHeaders, headersParam,
};
