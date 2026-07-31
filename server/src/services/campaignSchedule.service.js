/**
 * campaignSchedule.service.js — 연결된 시트 탭의 날짜 컬럼에서 캠페인 일정을 자동 파생.
 *
 *   시작일 = 최소 날짜 · 마감일 = 최대 날짜 · 그날 정원 = 그 날짜의 행 수 · 총 건수 = 총 행 수
 *
 * ★ 소스는 RAW 미러(raw_sheet_rows, cron 5분 주기)다. review_index는 이름 없는 행을 버리므로
 *   (columnResolver.js `if (!name) return null`) **미래의 빈 행(날짜만 적힌 슬롯)이 없어**
 *   앞으로의 일정을 알 수 없다. RAW 미러는 시트를 행 단위로 그대로 담아 이 용도에 맞다.
 * ★ 라이브 시트 읽기 0 — 시트 API 쿼터에 영향 없음. 미러가 5분마다 갱신되므로
 *   시트에 날짜를 추가하면 최대 5분 뒤 마감일 연장·재개가 자동 반영된다.
 * ★ 실패는 전부 null(미적용)로 떨어진다. 일정을 못 읽으면 기존 발행폼 값으로 동작(폴백).
 */

const { detectSheetHeader, normalizeCells } = require('../utils/sheetHeader');
const { parseDateColumn } = require('../utils/koreanDate');
const { logger } = require('../utils/logger');

// 날짜 컬럼 후보(구매일자·시작일·진행일…). columnResolver의 startDateKeywords와 같은 계열.
const DATE_HEADER_KEYWORDS = ['구매일', '시작일', '주문일', '배정일', '진행일'];
// 헤더 탐지를 위해 앞부분만 읽는 범위(시트 상단 캠페인 정보 블록을 넘기기 충분)
const HEADER_SCAN_ROWS = 60;
// 일정으로 인정하는 최소 조건 — 날짜 2종 이상 + 값 있는 칸의 과반이 파싱돼야 신뢰
const MIN_DISTINCT_DATES = 2;
const MIN_PARSE_RATIO = 0.6;

const _cache = new Map();               // key → { at, value }
const CACHE_TTL_MS = 60 * 1000;         // RAW 미러가 5분 주기라 1분 캐시로 충분

function _key(sheetId, tabGid) { return `${sheetId}::${tabGid}`; }

/** 헤더 배열에서 날짜 컬럼 인덱스 찾기(가장 앞선 매칭) */
function findDateColumnIndex(headers) {
  const hs = normalizeCells(headers);
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    if (h && DATE_HEADER_KEYWORDS.some(k => h.includes(k))) return i;
  }
  return -1;
}

/**
 * 날짜 문자열 배열 → 일정 요약. 신뢰 조건 미달이면 null.
 * @param {(string|null)[]} isoDates  파싱된 'YYYY-MM-DD' | null 배열
 * @param {number} nonEmptyCount      값이 들어 있던 칸 수(파싱 성공률 판정용)
 */
function summarizeDates(isoDates, nonEmptyCount) {
  const byDate = {};
  let parsed = 0;
  for (const d of isoDates) {
    if (!d) continue;
    byDate[d] = (byDate[d] || 0) + 1;
    parsed++;
  }
  const dates = Object.keys(byDate).sort();
  if (dates.length < MIN_DISTINCT_DATES) return null;
  if (nonEmptyCount > 0 && parsed / nonEmptyCount < MIN_PARSE_RATIO) return null;
  return {
    ok: true,
    byDate,
    dates: dates.map(d => ({ date: d, slots: byDate[d] })),
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    totalSlots: parsed,
    parsedRows: parsed,
    skippedRows: Math.max(0, nonEmptyCount - parsed),
  };
}

/**
 * 여러 탭의 일정을 한 번에 파생(캐시 적용).
 * @param {object} db      pool 또는 client (query 메서드만 사용)
 * @param {Array}  tabs    [{ sheetId, tabGid }]
 * @returns {Promise<Map<string, object|null>>} key(_key) → schedule | null
 */
async function deriveSchedules(db, tabs, now = new Date()) {
  const out = new Map();
  const wanted = [];
  const seen = new Set();
  for (const t of tabs || []) {
    if (!t || !t.sheetId || !t.tabGid) continue;
    const k = _key(t.sheetId, t.tabGid);
    if (seen.has(k)) continue;
    seen.add(k);
    const c = _cache.get(k);
    if (c && (now.getTime() - c.at) < CACHE_TTL_MS) out.set(k, c.value);
    else wanted.push({ ...t, key: k });
  }
  if (!wanted.length) return out;

  try {
    const params = [];
    const tuples = wanted.map(t => {
      params.push(t.sheetId, String(t.tabGid));
      return `($${params.length - 1},$${params.length})`;
    }).join(',');

    // 1단계: 상단 일부만 읽어 헤더행·날짜 컬럼 위치를 정한다(전체 셀 로드 회피)
    const head = await db.query(
      `SELECT sheet_id, tab_gid, row_index, cells
         FROM raw_sheet_rows
        WHERE (sheet_id, tab_gid) IN (${tuples}) AND row_index <= ${HEADER_SCAN_ROWS}
        ORDER BY sheet_id, tab_gid, row_index`,
      params
    );
    const headRows = new Map();   // key → [{row_index, cells}]
    for (const r of head.rows) {
      const k = _key(r.sheet_id, r.tab_gid);
      if (!headRows.has(k)) headRows.set(k, []);
      headRows.get(k).push(r);
    }

    for (const t of wanted) {
      let value = null;
      try {
        const rows = headRows.get(t.key) || [];
        if (rows.length) {
          const cellRows = rows.map(r => Array.isArray(r.cells) ? r.cells : []);
          const det = detectSheetHeader(cellRows);
          const headers = det.headers || [];
          const colIdx = findDateColumnIndex(headers);
          // detectSheetHeader의 dataStartRow는 배열 인덱스 기준(1-based) — 시트 실제 행번호로 환산
          const headerRowNo = det.headerRowIndex ? rows[det.headerRowIndex - 1].row_index : null;
          if (colIdx >= 0 && headerRowNo != null) {
            // 2단계: 날짜 컬럼 한 칸씩만 순서대로 읽는다(넓은 시트에서도 전송량 일정)
            const col = await db.query(
              `SELECT cells->>$3 AS v
                 FROM raw_sheet_rows
                WHERE sheet_id = $1 AND tab_gid = $2 AND row_index > $4
                ORDER BY row_index`,
              [t.sheetId, String(t.tabGid), String(colIdx), headerRowNo]
            );
            const raw = col.rows.map(r => r.v == null ? '' : String(r.v));
            const nonEmpty = raw.filter(v => v.trim()).length;
            const kstToday = new Date(now.getTime() + 9 * 3600 * 1000);
            const parsedCol = parseDateColumn(raw, {
              fallbackAnchor: { y: kstToday.getUTCFullYear(), m: kstToday.getUTCMonth() + 1 },
            });
            const sum = summarizeDates(parsedCol, nonEmpty);
            if (sum) value = { ...sum, dateColumn: headers[colIdx] || '', source: 'raw_mirror' };
          }
        }
      } catch (e) {
        logger.warn(`[campaignSchedule] ${t.key} 파생 실패: ${e.message}`);
        value = null;
      }
      _cache.set(t.key, { at: now.getTime(), value });
      out.set(t.key, value);
    }
  } catch (err) {
    // 파생 실패는 기능 미적용일 뿐 — 참여 흐름을 막지 않는다(fail-soft)
    logger.warn(`[campaignSchedule] 일괄 파생 실패: ${err.message}`);
    for (const t of wanted) if (!out.has(t.key)) out.set(t.key, null);
  }
  return out;
}

/**
 * 관제 진단용 — 연결 탭의 날짜 분포를 **게이트 없이 그대로** 돌려준다.
 *
 * ★ deriveSchedules 와 일부러 분리했다. 저쪽은 "신뢰 조건(날짜 2종·파싱 60%)을 통과한 것만"
 *   반환하므로, 조건 미달일 때 **왜 일정이 안 잡혔는지**를 설명할 수가 없다.
 *   하루에 끝나는 캠페인(날짜 1종)이 바로 그 경우다 — 관리자에게는 "미적용 + 사유"가 필요하다.
 * ★ 읽기 전용·캐시 없음(관제 창을 열 때만 호출). 상태 계산에는 일절 쓰이지 않는다.
 *
 * @returns {{ok, applied, reason, dateColumn, distinctDates, totalDated, rowsScanned, dates:[{date,rows}]}}
 */
async function describeTabDates(db, sheetId, tabGid, now = new Date()) {
  const fail = (reason) => ({ ok: false, applied: false, reason, distinctDates: 0, totalDated: 0, rowsScanned: 0, dates: [] });
  if (!db || !sheetId || !tabGid) return fail('no_tab');
  try {
    const head = await db.query(
      `SELECT row_index, cells FROM raw_sheet_rows
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index <= ${HEADER_SCAN_ROWS}
        ORDER BY row_index`,
      [sheetId, String(tabGid)]
    );
    if (!head.rows.length) return fail('no_mirror');       // RAW 미러가 아직 이 탭을 못 봄
    const det = detectSheetHeader(head.rows.map(r => (Array.isArray(r.cells) ? r.cells : [])));
    const headers = det.headers || [];
    const colIdx = findDateColumnIndex(headers);
    if (colIdx < 0 || det.headerRowIndex == null) return fail('no_date_column');
    const headerRowNo = head.rows[det.headerRowIndex - 1].row_index;

    const col = await db.query(
      `SELECT cells->>$3 AS v FROM raw_sheet_rows
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index > $4
        ORDER BY row_index`,
      [sheetId, String(tabGid), String(colIdx), headerRowNo]
    );
    const raw = col.rows.map(r => (r.v == null ? '' : String(r.v)));
    const nonEmpty = raw.filter(v => v.trim()).length;
    const kstToday = new Date(now.getTime() + 9 * 3600 * 1000);
    const parsed = parseDateColumn(raw, {
      fallbackAnchor: { y: kstToday.getUTCFullYear(), m: kstToday.getUTCMonth() + 1 },
    });
    const byDate = {};
    let totalDated = 0;
    for (const d of parsed) { if (!d) continue; byDate[d] = (byDate[d] || 0) + 1; totalDated++; }
    const dates = Object.keys(byDate).sort().map(d => ({ date: d, rows: byDate[d] }));

    const ratioOk = !(nonEmpty > 0 && totalDated / nonEmpty < MIN_PARSE_RATIO);
    const applied = dates.length >= MIN_DISTINCT_DATES && ratioOk;
    const reason = applied ? 'applied'
      : dates.length === 0 ? 'no_parsable_date'
      : dates.length < MIN_DISTINCT_DATES ? 'single_date'   // 하루 완결 캠페인 — 일정 미적용
      : 'low_parse_ratio';
    return {
      ok: true, applied, reason,
      dateColumn: headers[colIdx] || '',
      distinctDates: dates.length, totalDated, rowsScanned: nonEmpty,
      firstDate: dates[0] ? dates[0].date : null,
      lastDate: dates.length ? dates[dates.length - 1].date : null,
      dates: dates.slice(0, 20),   // 표시용 상한(긴 캠페인 대비)
    };
  } catch (e) {
    logger.warn(`[campaignSchedule] 진단 실패(${sheetId}/${tabGid}): ${e.message}`);
    return fail('error');
  }
}

/** 캠페인 행 배열 → 탭 목록(참여형 + 연결 gid 있는 것만) */
function tabsOfCampaigns(rows) {
  return (rows || [])
    .filter(r => r && r.participation_mode && r.linked_sheet_id && r.linked_tab_gid)
    .map(r => ({ sheetId: r.linked_sheet_id, tabGid: String(r.linked_tab_gid) }));
}

/** 캠페인 행에 대응하는 일정 꺼내기 */
function scheduleFor(map, row) {
  if (!map || !row || !row.linked_sheet_id || !row.linked_tab_gid) return null;
  return map.get(_key(row.linked_sheet_id, String(row.linked_tab_gid))) || null;
}

function _clearCache() { _cache.clear(); }

module.exports = {
  deriveSchedules,
  tabsOfCampaigns,
  scheduleFor,
  summarizeDates,
  findDateColumnIndex,
  describeTabDates,
  DATE_HEADER_KEYWORDS,
  MIN_DISTINCT_DATES,
  _clearCache,
};
