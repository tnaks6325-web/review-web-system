/**
 * rawMirror.service.js
 * 구글시트 전체 RAW 미러링 서비스
 *
 * 목적: 인덱스(시트DB = campaigns/tab_configs)로 관리되는 모든 스프레드시트의
 *       "모든 탭 · 모든 행"을 구조와 무관하게 SQL(raw_sheet_tabs / raw_sheet_rows)로 통째 보존.
 *       - review_index(구조화된 리뷰 데이터)와 독립적인 원본 거울(mirror)
 *       - 리뷰 인덱스로 인식 안 되는 탭, 시스템 탭, 숨김 탭까지 모두 포함
 *
 * 동작:
 *   1. campaigns ∪ tab_configs 에서 sheet_id 목록 수집 (인덱스 기반)
 *   2. (force 아니면) Drive 수정시각으로 변경 없는 시트는 통째 스킵
 *   3. 각 시트의 모든 탭을 batchGet(A:ZZ)으로 읽기
 *   4. 탭별 체크섬 비교 → 변경된 탭만 raw_sheet_rows 교체(replace) + raw_sheet_tabs 메타 갱신
 *
 * 의존: sheets.service.js, sheetsThrottle.js, checksum.js
 */

const pool = require('../db/pool');
const { getSpreadsheetMeta, batchReadSheet, readSheet, getSheetModifiedTime } = require('./sheets.service');
const { computeChecksum } = require('../utils/checksum');
const { throttledCall, driveThrottledCall, concurrentMap, getThrottleStatus } = require('../utils/sheetsThrottle');
const { logger } = require('../utils/logger');
const { detectSheetHeader } = require('../utils/sheetHeader');
const { fullySheetlessSheetIds, REGISTERED_SHEET_IDS_SQL } = require('../utils/sheetlessScope');

// 시스템 탭 키워드 — 제외하지 않고 is_system_tab 플래그만 부여
const SYSTEM_TAB_KEYWORDS = [
  '검색인덱스', '세부목록', '캠페인목록', '시트목록', '설정',
  '매크로', '서식', '요약', '대시보드', '템플릿', '양식',
  '시트db', '탭목록', '인덱스마스터', '인덱스데이터', '상세목록', '탭설정',
  'tab_configs', 'detail', 'config',
];

// batchGet 안전 청크 크기 (Google API 권장 범위)
const BATCH_CHUNK_SIZE = 50;
// 전체 미러링 시간 가드 (15분) — 초과 시 나머지는 다음 실행에서 처리
const MIRROR_TIME_GUARD_MS = 15 * 60 * 1000;
// row 일괄 INSERT 배치 크기
const ROW_INSERT_BATCH = 500;

// ── (A) 비활성 시트 미러 주기 완화 — env 게이트(기본 OFF=기존 매 사이클 전체 미러). ──
//   RAW미러의 유일 소비처는 "주문 행배정"(claimRow/loadRawTabContext/reconcile)이고
//   review_index 빌드(smartBuild)는 시트를 직접 읽어 RAW미러에 의존하지 않는다(검증됨).
//   따라서 "최근 주문이 없는 시트"는 미러를 매 사이클 돌릴 필요가 없다. INACTIVE_EVERY 사이클마다 1회만 미러.
//   안전: 비활성 시트에 주문이 오면 loadRawTabContext가 _triggerSheetMirrorOnce로 즉시 자동미러(자가치유).
//   force(수동 전체미러)·mirrorOneSheet(단일)·_triggerSheetMirrorOnce는 완화 무관(항상 미러).
const INACTIVE_RELAX  = () => process.env.RAW_MIRROR_INACTIVE_RELAX === '1';
const INACTIVE_DAYS   = parseInt(process.env.RAW_MIRROR_INACTIVE_DAYS  || '30', 10);
const INACTIVE_EVERY  = Math.max(2, parseInt(process.env.RAW_MIRROR_INACTIVE_EVERY || '6', 10));
let _mirrorCycleCount = 0;

// (R2) bulk 미러 중간 양보 임계(시트 lane 기준) — 초과 시 그 시트를 다음 사이클로 연기. 999로 사실상 비활성.
const YIELD_THRESHOLD = (n => (Number.isFinite(n) && n > 0 ? n : 30))(
  parseInt(process.env.RAW_MIRROR_YIELD_THRESHOLD || '30', 10)
);
// (R5) Drive 변경감지 연속실패 스트릭(bulk 경로 전용) — 999로 사실상 비활성.
const _driveFailStreak = new Map();
const DRIVE_FAIL_SKIP_AFTER = (n => (Number.isFinite(n) && n > 0 ? n : 2))(
  parseInt(process.env.RAW_MIRROR_DRIVE_FAIL_SKIP_AFTER || '2', 10)
);

function _isSystemTab(tabName) {
  const lower = (tabName || '').toLowerCase();
  return SYSTEM_TAB_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

/**
 * 인덱스(시트DB)로 관리되는 모든 시트를 RAW 미러링
 *
 * @param {object} opts
 * @param {boolean} opts.force        - true면 체크섬/수정시각 무시하고 전체 재미러링
 * @param {boolean} opts.includeHidden- false면 숨김 탭 제외 (기본 true: 모두 포함)
 * @returns {object} 요약
 */
async function mirrorAllSheets({ force = false, includeHidden = true } = {}) {
  const startTime = Date.now();

  // ── 1) 인덱스 기반 sheet_id 목록 ──
  // ★ 열거식은 `sheetlessScope` 단일 출처 — 읽는 범위 진단이 같은 문장을 봐야 관측이 거짓말을 안 한다.
  const { rows: idRows } = await pool.query(REGISTERED_SHEET_IDS_SQL);
  let sheetIds = [...new Set(idRows.map(r => r.sheet_id))].filter(Boolean);
  const totalRegistered = sheetIds.length;

  // ★★ 무시트 작업 제외(탈 구글시트 W1) — 등록 탭이 전부 무시트인 시트는 구글에 존재하지 않거나
  //   더는 읽을 이유가 없다. 안 걸러내면 **매 사이클 404 반복**(오류 로그·재시도 낭비).
  //   판정은 `sheetlessScope` 단일 출처이고 조회 실패는 빈 집합(fail-open = 종전 동작).
  const _slSheets = await fullySheetlessSheetIds(pool);
  let sheetlessSkipped = 0;
  if (_slSheets.size) {
    const before = sheetIds.length;
    sheetIds = sheetIds.filter(id => !_slSheets.has(id));
    sheetlessSkipped = before - sheetIds.length;
  }

  // ── (A) 비활성 시트 완화: relax 사이클에는 "최근 주문 있는 활성 시트"만 미러. ──
  const cycle = ++_mirrorCycleCount;
  let deferredInactive = 0;
  const relaxThisCycle = INACTIVE_RELAX() && !force && (cycle % INACTIVE_EVERY !== 0);
  if (relaxThisCycle) {
    try {
      const { rows: act } = await pool.query(
        `SELECT DISTINCT sheet_id FROM order_submissions
           WHERE deleted_at IS NULL AND submitted_at > NOW() - ($1 || ' days')::interval
             AND sheet_id IS NOT NULL`,
        [String(INACTIVE_DAYS)]
      );
      const activeSet = new Set(act.map(r => r.sheet_id));
      const kept = sheetIds.filter(id => activeSet.has(id));
      deferredInactive = sheetIds.length - kept.length;
      sheetIds = kept;
    } catch (e) {
      logger.warn(`[rawMirror] 활성시트 조회 실패 → 완화 미적용(전체 미러): ${e.message}`);
    }
  }

  logger.info(`[rawMirror] 시작: ${sheetIds.length}/${totalRegistered}개 시트 (force=${force}, cycle=${cycle}, relax=${relaxThisCycle}, 비활성연기=${deferredInactive})`);

  // ── 2) 기존 미러 메타 로드 (증분 비교용) ──
  const { rows: existingTabs } = await pool.query(
    'SELECT sheet_id, tab_gid, checksum, sheet_modified_at FROM raw_sheet_tabs'
  );
  const checksumMap = {};       // "sheetId||gid" → checksum
  const sheetModifiedMap = {};  // sheetId → 마지막 기록 수정시각(ms)
  for (const t of existingTabs) {
    checksumMap[`${t.sheet_id}||${t.tab_gid}`] = t.checksum;
    if (t.sheet_modified_at) {
      const ms = new Date(t.sheet_modified_at).getTime();
      if (!sheetModifiedMap[t.sheet_id] || ms > sheetModifiedMap[t.sheet_id]) {
        sheetModifiedMap[t.sheet_id] = ms;
      }
    }
  }

  // ── 3) 시트별 처리 (동시성 3 — 실 API콜은 내부 throttledCall/driveThrottledCall이 정확 계량, 팬텀 슬롯 0) ──
  const results = await concurrentMap(
    sheetIds,
    (sheetId) => _mirrorOneSheet(sheetId, { force, includeHidden, checksumMap, sheetModifiedMap, startTime, deferOnBusy: true, deferOnDriveFail: true }),
    3
  );

  // ── 4) 집계 ──
  let tabsMirrored = 0, tabsSkipped = 0, rowsWritten = 0, sheetsSkipped = 0, sheetsDeferred = 0, errors = 0;
  const errorDetails = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const v = r.value;
      tabsMirrored += v.tabsMirrored;
      tabsSkipped  += v.tabsSkipped;
      rowsWritten  += v.rowsWritten;
      if (v.sheetSkipped) sheetsSkipped++;
      if (v.sheetDeferred) sheetsDeferred++;
      errors += v.errors;
    } else {
      errors++;
      const msg = r.reason?.message || String(r.reason);
      errorDetails.push({ sheetId: (sheetIds[i] || '').substring(0, 15) + '...', error: msg });
      logger.error(`[rawMirror] 시트 처리 실패 (${(sheetIds[i] || '').substring(0, 15)}): ${msg}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  const summary = {
    ok: true,
    sheetsScanned: sheetIds.length,
    totalRegistered,
    deferredInactive,           // (A) 이번 사이클에 비활성으로 건너뛴 시트 수(다음 INACTIVE_EVERY 사이클에 미러)
    relaxCycle: relaxThisCycle,
    sheetlessSkipped,           // 무시트 작업으로 제외한 시트 수(W1) — 0 이면 종전과 동일
    sheetsSkipped,
    sheetsDeferred,
    tabsMirrored,
    tabsSkipped,
    rowsWritten,
    errors,
    errorDetails: errorDetails.slice(0, 20),
    elapsed,
    throttle: getThrottleStatus(),
    mirroredAt: new Date().toISOString(),
  };
  logger.info(`[rawMirror] 완료: 탭 미러 ${tabsMirrored}개(스킵 ${tabsSkipped}), 행 ${rowsWritten}개, 시트스킵 ${sheetsSkipped}, 양보연기 ${sheetsDeferred}, 비활성연기 ${deferredInactive}, 오류 ${errors} — ${elapsed}`);
  return summary;
}

/**
 * 시트 1개의 모든 탭을 미러링
 */
async function _mirrorOneSheet(sheetId, opts) {
  const { force, includeHidden, checksumMap, sheetModifiedMap, startTime,
          deferOnBusy = false, deferOnDriveFail = false } = opts;
  let tabsMirrored = 0, tabsSkipped = 0, rowsWritten = 0, errors = 0;

  // (R2/R1) bulk 사이클 중간 양보 — 시트 lane이 달아오르면(주문 버스트/해빙 직후) 이 시트는 다음 사이클로.
  //   단일 미러(mirrorOneSheet)·_triggerSheetMirrorOnce 자동미러는 deferOnBusy 미전달(false) → 현행 유지(자가치유 보존).
  if (!force && deferOnBusy && getThrottleStatus().requestsInLastMinute > YIELD_THRESHOLD) {
    return { tabsMirrored: 0, tabsSkipped: 0, rowsWritten: 0, errors: 0, sheetDeferred: true };
  }

  // ── Drive 변경감지: drive lane 사용(시트 45/분 미소모) — 수정시각 변동 없으면 시트 전체 스킵 ──
  let modifiedTime = null;
  if (!force) {
    try {
      modifiedTime = await driveThrottledCall(() => getSheetModifiedTime(sheetId));
      _driveFailStreak.delete(sheetId);
      if (modifiedTime) {
        const remote = new Date(modifiedTime).getTime();
        const lastKnown = sheetModifiedMap[sheetId] || 0;
        if (lastKnown > 0 && remote <= lastKnown) {
          return { tabsMirrored: 0, tabsSkipped: 0, rowsWritten: 0, errors: 0, sheetSkipped: true };
        }
      }
    } catch (err) {
      const streak = (_driveFailStreak.get(sheetId) || 0) + 1;
      _driveFailStreak.set(sheetId, streak);
      logger.warn(`[rawMirror] Drive 변경감지 실패 ${streak}회 (${sheetId.substring(0, 15)}): ${err.message}`);
      // (R5) bulk 경로 연속실패 — 전체읽기 진행(=시트 lane 폭풍) 대신 이번 사이클 연기.
      if (deferOnDriveFail && streak >= DRIVE_FAIL_SKIP_AFTER) {
        return { tabsMirrored: 0, tabsSkipped: 0, rowsWritten: 0, errors: 0, sheetDeferred: true };
      }
    }
  }

  // ── 메타 조회: 모든 탭 (필터링 없음) ──
  const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
  const spreadsheetTitle = meta._spreadsheetTitle || sheetId;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

  let tabs = (meta || []).filter(s => s && s.properties);
  if (!includeHidden) tabs = tabs.filter(t => !t.properties.hidden);
  if (tabs.length === 0) {
    return { tabsMirrored: 0, tabsSkipped: 0, rowsWritten: 0, errors: 0 };
  }

  // ── 모든 탭 데이터 batchGet (A:ZZ — 전체 열 확보) ──
  const ranges = tabs.map(t => `'${t.properties.title}'!A:ZZ`);
  // ★ 미러는 FORMATTED_VALUE로 읽는다 → 시트에 표기된 그대로 보존
  //   (구매날짜 등 날짜 셀이 직렬숫자 45463이 아니라 "11/23" 표기 문자열로 저장)
  let batchResults = [];
  try {
    if (ranges.length <= BATCH_CHUNK_SIZE) {
      batchResults = await throttledCall(() => batchReadSheet(sheetId, ranges, 'FORMATTED_VALUE'));
    } else {
      for (let s = 0; s < ranges.length; s += BATCH_CHUNK_SIZE) {
        const chunk = ranges.slice(s, s + BATCH_CHUNK_SIZE);
        const part = await throttledCall(() => batchReadSheet(sheetId, chunk, 'FORMATTED_VALUE'));
        batchResults.push(...part);
      }
    }
    if (batchResults.length !== tabs.length) {
      throw new Error(`batchResults length mismatch: ${batchResults.length} vs ${tabs.length}`);
    }
  } catch (err) {
    // 슬래시 포함 탭명 등 batchGet 실패 → 개별 읽기 폴백 (gid 기반)
    logger.warn(`[rawMirror] batchGet 실패 (${sheetId.substring(0, 15)}), 개별 읽기 폴백: ${err.message}`);
    batchResults = [];
    for (const t of tabs) {
      try {
        const values = await throttledCall(() =>
          readSheet(sheetId, `'${t.properties.title}'!A:ZZ`, { gid: String(t.properties.sheetId), valueRenderOption: 'FORMATTED_VALUE' })
        );
        batchResults.push({ values: values || [] });
      } catch (readErr) {
        batchResults.push({ values: [], error: readErr.message });
      }
    }
  }

  // ── 탭별 처리 ──
  for (let i = 0; i < tabs.length; i++) {
    // 시간 가드
    if (Date.now() - startTime > MIRROR_TIME_GUARD_MS) {
      logger.warn(`[rawMirror] 시간 초과 — 나머지 탭은 다음 실행에서 처리`);
      break;
    }

    const tab = tabs[i];
    const tabName = tab.properties.title;
    const tabGid = String(tab.properties.sheetId);
    const isHidden = !!tab.properties.hidden;
    const values = batchResults[i]?.values || batchResults[i]?.data?.values || [];

    try {
      const checksum = computeChecksum(values);
      const key = `${sheetId}||${tabGid}`;
      if (!force && checksumMap[key] === checksum) {
        tabsSkipped++;
        continue;
      }

      const written = await _replaceTabRows(sheetId, tabGid, tabName, values);
      await _upsertTabMeta({
        sheetId, sheetUrl, spreadsheetTitle, tabGid, tabName,
        values, checksum, isHidden, modifiedTime,
      });
      rowsWritten += written;
      tabsMirrored++;
    } catch (err) {
      errors++;
      logger.error(`[rawMirror] 탭 미러 실패 (${tabName}): ${err.message}`);
    }
  }

  return { tabsMirrored, tabsSkipped, rowsWritten, errors };
}

/**
 * 탭의 raw 행 데이터를 통째로 교체 (DELETE 후 일괄 INSERT)
 * @returns {number} 기록된 행 수
 */
async function _replaceTabRows(sheetId, tabGid, tabName, values) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM raw_sheet_rows WHERE sheet_id = $1 AND tab_gid = $2',
      [sheetId, tabGid]
    );

    let written = 0;
    if (values && values.length > 0) {
      for (let start = 0; start < values.length; start += ROW_INSERT_BATCH) {
        const batch = values.slice(start, start + ROW_INSERT_BATCH);
        const placeholders = [];
        const params = [];
        let p = 1;
        batch.forEach((row, j) => {
          const rowIndex = start + j + 1; // 구글시트 1-based 행 번호
          placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(sheetId, tabGid, tabName, rowIndex, JSON.stringify(Array.isArray(row) ? row : []));
        });
        await client.query(
          `INSERT INTO raw_sheet_rows (sheet_id, tab_gid, tab_name, row_index, cells)
           VALUES ${placeholders.join(',')}`,
          params
        );
        written += batch.length;
      }
    }

    await client.query('COMMIT');
    return written;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * raw_sheet_tabs 메타 UPSERT
 */
async function _upsertTabMeta({ sheetId, sheetUrl, spreadsheetTitle, tabGid, tabName, values, checksum, isHidden, modifiedTime }) {
  const rowCount = values ? values.length : 0;
  const colCount = values && values.length > 0
    ? values.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    : 0;
  const headers = values && values.length > 0 && Array.isArray(values[0]) ? values[0] : [];
  const detected = detectSheetHeader(values || []);
  const detectedHeaders = detected.headers || null;

  await pool.query(
    `INSERT INTO raw_sheet_tabs
       (sheet_id, sheet_url, spreadsheet_title, tab_gid, tab_name,
        row_count, col_count, headers, is_system_tab, is_hidden,
        checksum, sheet_modified_at, mirrored_at,
        header_row_index, detected_headers, data_start_row)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13,$14::jsonb,$15)
     ON CONFLICT (sheet_id, tab_gid) DO UPDATE SET
       sheet_url = EXCLUDED.sheet_url,
       spreadsheet_title = EXCLUDED.spreadsheet_title,
       tab_name = EXCLUDED.tab_name,
       row_count = EXCLUDED.row_count,
       col_count = EXCLUDED.col_count,
       headers = EXCLUDED.headers,
       is_system_tab = EXCLUDED.is_system_tab,
       is_hidden = EXCLUDED.is_hidden,
       checksum = EXCLUDED.checksum,
       sheet_modified_at = EXCLUDED.sheet_modified_at,
       header_row_index = EXCLUDED.header_row_index,
       detected_headers = EXCLUDED.detected_headers,
       data_start_row = EXCLUDED.data_start_row,
       mirrored_at = NOW()`,
    [
      sheetId, sheetUrl, spreadsheetTitle, tabGid, tabName,
      rowCount, colCount, JSON.stringify(headers), _isSystemTab(tabName), isHidden,
      checksum, modifiedTime || null,
      detected.headerRowIndex,
      detectedHeaders ? JSON.stringify(detectedHeaders) : null,
      detected.dataStartRow,
    ]
  );
}

/**
 * 단일 시트만 즉시 RAW 미러링 (탭/캠페인 등록 시 best-effort 호출용)
 *
 * - 등록 직후 해당 시트가 RAW 미러에 바로 채워지도록 한다(전체 미러 대기 없음).
 * - 해당 시트의 기존 체크섬/수정시각만 로드해 _mirrorOneSheet에 위임 → 변경된 탭만 갱신.
 * - 신규 등록 시트는 기존 데이터가 없으므로 모든(비숨김 포함) 탭이 새로 미러된다.
 * - 모든 시트 읽기는 throttle 경유라 쿼터 안전. 호출 측은 비차단(fire-and-forget) 권장.
 *
 * @param {string} sheetId
 * @param {object} opts { force=false, includeHidden=true }
 * @returns {object} { tabsMirrored, tabsSkipped, rowsWritten, errors }
 */
async function mirrorOneSheet(sheetId, { force = false, includeHidden = true } = {}) {
  if (!sheetId) throw new Error('sheetId가 필요합니다.');

  // 해당 시트의 기존 미러 메타(증분 비교용)만 로드
  const { rows: existingTabs } = await pool.query(
    'SELECT tab_gid, checksum, sheet_modified_at FROM raw_sheet_tabs WHERE sheet_id = $1',
    [sheetId]
  );
  const checksumMap = {};
  const sheetModifiedMap = {};
  for (const t of existingTabs) {
    checksumMap[`${sheetId}||${t.tab_gid}`] = t.checksum;
    if (t.sheet_modified_at) {
      const ms = new Date(t.sheet_modified_at).getTime();
      if (!sheetModifiedMap[sheetId] || ms > sheetModifiedMap[sheetId]) {
        sheetModifiedMap[sheetId] = ms;
      }
    }
  }

  const r = await _mirrorOneSheet(sheetId, {
    force, includeHidden, checksumMap, sheetModifiedMap, startTime: Date.now(),
  });
  logger.info(`[rawMirror] 단일 시트 미러 완료 (${sheetId.substring(0, 12)}…): 탭 ${r.tabsMirrored}(스킵 ${r.tabsSkipped}), 행 ${r.rowsWritten}, 오류 ${r.errors}`);
  return r;
}

module.exports = {
  mirrorAllSheets,
  mirrorOneSheet,
  SYSTEM_TAB_KEYWORDS,
};
