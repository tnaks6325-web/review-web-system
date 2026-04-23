/**
 * indexScan.service.js
 * 인덱스 스캔 서비스 — 시트DB에서 시트 URL 목록을 읽어 
 * 각 시트의 탭 정보를 파싱하고 '탭목록' 탭에 기록
 *
 * 출력 컬럼: sheet_url, campaign_name, tab_url, tab_name
 *
 * 의존: sheets.service.js, sheetsThrottle.js
 * 환경변수: MASTER_SHEET_ID (시트DB + 탭목록이 있는 스프레드시트)
 */

const { readSheet, writeSheet, getSpreadsheetMeta } = require('./sheets.service');
const { throttledCall, throttledMap, getThrottleStatus } = require('../utils/sheetsThrottle');
const { logger } = require('../utils/logger');

// ── 환경변수 ──
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID || '';

// ── 시트DB / 탭목록 탭 gid 설정 (마스터 시트 내 탭) ──
const SHEET_DB_TAB_NAME   = '시트DB';
const TAB_LIST_TAB_NAME   = '탭목록';

// ── 출력 헤더 ──
const INDEX_HEADERS = ['sheet_url', 'campaign_name', 'tab_url', 'tab_name'];

// ── 시스템 탭 키워드 (파싱에서 제외) ──
const SYSTEM_TAB_KEYWORDS = [
  '검색인덱스', '세부목록', '캠페인목록', '시트목록', '설정',
  '매크로', '서식', '요약', '대시보드', '템플릿', '양식',
  '시트DB', '탭목록', 'tab_configs',
];

// ── 캐시 (미리보기 → 실행 연계) ──
let _scanCache = null;
const SCAN_CACHE_TTL = 5 * 60 * 1000; // 5분

// ═══════════════════════════════════════════════════════════
// 유틸
// ═══════════════════════════════════════════════════════════

function extractSheetId(url) {
  if (!url) return null;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function isSystemTab(tabName) {
  const lower = (tabName || '').toLowerCase();
  return SYSTEM_TAB_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

/**
 * 탭 URL 생성: sheet_url + #gid=TAB_GID
 */
function buildTabUrl(sheetUrl, tabGid) {
  // sheetUrl에서 기존 fragment/query 제거
  const base = (sheetUrl || '').replace(/[?#].*$/, '');
  return `${base}#gid=${tabGid}`;
}

/**
 * 마스터 시트에서 특정 탭명의 실제 존재를 확인하고 이름 반환
 */
async function _findTabName(spreadsheetId, targetName) {
  const meta = await throttledCall(() => getSpreadsheetMeta(spreadsheetId));
  if (!meta || meta.length === 0) throw new Error('스프레드시트 메타데이터 조회 실패');
  
  const found = meta.find(s => s.properties.title === targetName);
  if (!found) {
    const availableTabs = meta.map(s => `"${s.properties.title}"`).join(', ');
    throw new Error(`"${targetName}" 탭을 찾을 수 없습니다. 사용 가능한 탭: ${availableTabs}`);
  }
  return found.properties.title;
}

// ═══════════════════════════════════════════════════════════
// 핵심: 인덱스 스캔
// ═══════════════════════════════════════════════════════════

/**
 * 시트DB에서 시트 URL 목록을 읽고, 각 시트의 메타데이터를 파싱하여
 * sheet_url, campaign_name, tab_url, tab_name을 수집
 *
 * @param {boolean} dryRun - true면 미리보기 (탭목록에 쓰지 않음)
 * @returns {object} 스캔 결과 요약
 */
async function runIndexScan(dryRun = true) {
  const startTime = Date.now();
  
  if (!MASTER_SHEET_ID) {
    throw new Error('MASTER_SHEET_ID 환경변수 미설정');
  }

  // ──────────────────────────────────────────────
  // Step 1: 시트DB 탭에서 sheet_url 목록 읽기
  // ──────────────────────────────────────────────
  logger.info(`[indexScan] Step 1: 시트DB 읽기 시작`);

  const sheetDbTabName = await _findTabName(MASTER_SHEET_ID, SHEET_DB_TAB_NAME);
  const rawValues = await throttledCall(() =>
    readSheet(MASTER_SHEET_ID, `'${sheetDbTabName}'!A:Z`)
  );

  if (!rawValues || rawValues.length < 2) {
    throw new Error('시트DB에 데이터가 없습니다 (헤더 + 최소 1행 필요)');
  }

  // 헤더 파싱
  const headers = rawValues[0].map(h => String(h).trim().toLowerCase());
  const urlIdx = headers.indexOf('sheet_url');
  const campIdx = headers.indexOf('campaign_name');

  if (urlIdx === -1) {
    throw new Error("시트DB에 'sheet_url' 컬럼이 없습니다");
  }

  // 시트 URL 목록 추출 (중복 제거)
  const sheetEntries = []; // { sheetUrl, campaignNameHint, sheetId }
  const seenSheetIds = new Set();

  for (let i = 1; i < rawValues.length; i++) {
    const row = rawValues[i];
    if (!row || row.length === 0) continue;

    const url = (row[urlIdx] || '').toString().trim();
    if (!url) continue;

    const sheetId = extractSheetId(url);
    if (!sheetId || seenSheetIds.has(sheetId)) continue;
    seenSheetIds.add(sheetId);

    // 시트DB에 campaign_name 컬럼이 있으면 힌트로 사용 (실제 값은 시트 제목에서 가져옴)
    const campHint = campIdx >= 0 && row.length > campIdx ? (row[campIdx] || '').toString().trim() : '';

    sheetEntries.push({
      sheetUrl: url.replace(/[?#].*$/, '').replace(/\/edit$/, '/edit'),
      campaignNameHint: campHint,
      sheetId,
    });
  }

  logger.info(`[indexScan] 시트DB에서 ${sheetEntries.length}개 고유 시트 URL 발견`);

  // ──────────────────────────────────────────────
  // Step 2: 각 시트에 접속하여 탭 정보 파싱
  // ──────────────────────────────────────────────
  logger.info(`[indexScan] Step 2: 각 시트 메타데이터 파싱 시작 (${sheetEntries.length}개)`);

  const scanResults = [];   // { sheet_url, campaign_name, tab_url, tab_name }
  const errors = [];
  let totalTabs = 0;

  await throttledMap(sheetEntries, async (entry) => {
    try {
      const meta = await throttledCall(() => getSpreadsheetMeta(entry.sheetId));
      if (!meta || meta.length === 0) {
        errors.push({
          sheetId: entry.sheetId.substring(0, 15) + '...',
          sheetUrl: entry.sheetUrl,
          error: '메타데이터 조회 실패 (접근 권한 확인)',
          errorCode: 'META_FAIL',
        });
        return;
      }

      // 시트 제목 = campaign_name (실제 구글시트 파일명)
      const campaignName = meta._spreadsheetTitle || entry.campaignNameHint || '';
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${entry.sheetId}/edit`;

      for (const sheet of meta) {
        const tabName = sheet.properties.title;
        const tabGid = String(sheet.properties.sheetId);

        // 시스템 탭 제외
        if (isSystemTab(tabName)) continue;

        const tabUrl = buildTabUrl(sheetUrl, tabGid);

        scanResults.push({
          sheet_url: sheetUrl,
          campaign_name: campaignName,
          tab_url: tabUrl,
          tab_name: tabName,
        });
        totalTabs++;
      }
    } catch (err) {
      errors.push({
        sheetId: entry.sheetId.substring(0, 15) + '...',
        sheetUrl: entry.sheetUrl,
        error: err.message,
        errorCode: err.code || 'UNKNOWN',
      });
    }
  }, 3); // 동시성 3

  logger.info(`[indexScan] Step 2 완료: ${totalTabs}개 탭 발견, 오류 ${errors.length}건`);

  // ──────────────────────────────────────────────
  // Step 3: 결과를 탭목록 탭에 쓰기 (dryRun이 아닌 경우)
  // ──────────────────────────────────────────────
  if (!dryRun) {
    logger.info(`[indexScan] Step 3: 탭목록 쓰기 (${scanResults.length}행)`);
    await _writeTabList(scanResults);
  } else {
    logger.info(`[indexScan] Step 3: 미리보기 모드 — 쓰기 생략`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  const summary = {
    dryRun,
    elapsed,
    sheetsScanned: sheetEntries.length,
    totalTabs,
    errors: errors.length,
    errorDetails: errors.slice(0, 20),
    throttleStatus: getThrottleStatus(),
    // 미리보기용 상세 데이터
    preview: scanResults.slice(0, 500).map(r => ({
      campaign: r.campaign_name,
      tabName: r.tab_name,
      tabUrl: r.tab_url,
      sheetUrl: r.sheet_url.substring(0, 60) + '...',
    })),
  };

  // 미리보기 시 캐시 저장
  if (dryRun) {
    _scanCache = { scanResults, summary, cachedAt: Date.now() };
    logger.info(`[indexScan] 미리보기 결과 캐시 저장 (${totalTabs}개 탭, 5분 유효)`);
  } else {
    _scanCache = null;
  }

  logger.info(`[indexScan] 완료: ${sheetEntries.length}개 시트 → ${totalTabs}개 탭 — ${elapsed}`);
  return summary;
}

/**
 * 캐시된 스캔 결과로 탭목록에 쓰기 (재스캔 없이)
 */
async function applyCachedIndexScan() {
  if (!_scanCache) {
    throw new Error('캐시된 스캔 결과가 없습니다. 미리보기를 먼저 실행하세요.');
  }
  if (Date.now() - _scanCache.cachedAt > SCAN_CACHE_TTL) {
    _scanCache = null;
    throw new Error('캐시가 만료되었습니다 (5분 초과). 미리보기를 다시 실행하세요.');
  }

  const startTime = Date.now();
  const { scanResults, summary: cachedSummary } = _scanCache;

  logger.info(`[indexScan] 캐시 적용: ${scanResults.length}개 탭 → 탭목록 쓰기`);
  await _writeTabList(scanResults);

  _scanCache = null;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  return {
    ...cachedSummary,
    dryRun: false,
    elapsed: `${elapsed} (캐시 적용, 스캔 ${cachedSummary.elapsed})`,
    usedCache: true,
  };
}

/**
 * 캐시 유효 여부
 */
function hasIndexScanCache() {
  if (!_scanCache) return false;
  if (Date.now() - _scanCache.cachedAt > SCAN_CACHE_TTL) {
    _scanCache = null;
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// 탭목록 쓰기
// ═══════════════════════════════════════════════════════════

/**
 * 탭목록 탭에 스캔 결과를 기록
 * - 기존 헤더 행을 유지하되, 첫 4컬럼(sheet_url, campaign_name, tab_url, tab_name)은 덮어씀
 * - 기존 탭목록에 있는 추가 컬럼(manager, time_range 등) 데이터를 tab_name 기준으로 보존
 */
async function _writeTabList(scanResults) {
  if (!MASTER_SHEET_ID) throw new Error('MASTER_SHEET_ID 환경변수 미설정');

  // 탭목록 탭 존재 확인
  const tabListTabName = await _findTabName(MASTER_SHEET_ID, TAB_LIST_TAB_NAME);

  // 현재 탭목록의 기존 데이터 읽기 (보존할 컬럼 확인용)
  const existingValues = await throttledCall(() =>
    readSheet(MASTER_SHEET_ID, `'${tabListTabName}'!A:Z`)
  );

  let existingHeaders = [];
  const existingRowMap = new Map(); // key: sheet_url||tab_name → row data

  if (existingValues && existingValues.length >= 1) {
    existingHeaders = existingValues[0].map(h => String(h).trim().toLowerCase());
    
    const eUrlIdx = existingHeaders.indexOf('sheet_url');
    const eTabIdx = existingHeaders.indexOf('tab_name');

    if (eUrlIdx >= 0 && eTabIdx >= 0) {
      for (let i = 1; i < existingValues.length; i++) {
        const row = existingValues[i];
        if (!row || row.length === 0) continue;
        
        const url = (row[eUrlIdx] || '').toString().trim();
        const tab = (row[eTabIdx] || '').toString().trim();
        if (!url || !tab) continue;

        const key = `${extractSheetId(url)}||${tab}`;
        const obj = {};
        existingHeaders.forEach((h, idx) => {
          obj[h] = idx < row.length ? (row[idx] || '') : '';
        });
        existingRowMap.set(key, obj);
      }
    }
  }

  // 출력 헤더 결정: 기존 헤더가 있으면 그대로 유지, 없으면 4컬럼만
  const outputHeaders = existingHeaders.length >= 4 ? existingHeaders : INDEX_HEADERS.slice();

  // 출력 데이터 구성
  const outputValues = [outputHeaders.map(h => h)]; // 헤더 행

  for (const result of scanResults) {
    const key = `${extractSheetId(result.sheet_url)}||${result.tab_name}`;
    const existing = existingRowMap.get(key) || {};

    const row = outputHeaders.map(header => {
      // 핵심 4컬럼은 새 스캔 결과로 덮어씀
      if (header === 'sheet_url') return result.sheet_url;
      if (header === 'campaign_name') return result.campaign_name;
      if (header === 'tab_url') return result.tab_url;
      if (header === 'tab_name') return result.tab_name;
      // updated_at은 현재 시간
      if (header === 'updated_at') return new Date().toISOString().replace('T', ' ').substring(0, 19);
      // 나머지 컬럼은 기존 값 보존
      return existing[header] || '';
    });

    outputValues.push(row);
  }

  // 쓰기 범위 계산
  const colLetter = String.fromCharCode(65 + outputHeaders.length - 1);
  const range = `'${tabListTabName}'!A1:${colLetter}${outputValues.length}`;
  
  logger.info(`[indexScan] 탭목록 쓰기: ${range} (${outputValues.length - 1}행, ${outputHeaders.length}열)`);
  await throttledCall(() => writeSheet(MASTER_SHEET_ID, range, outputValues));

  // 기존 데이터가 더 많았을 경우 나머지 행 비우기
  const clearStart = outputValues.length + 1;
  const clearEnd = Math.max(clearStart, 500);
  const emptyRows = [];
  for (let i = clearStart; i <= clearEnd; i++) {
    emptyRows.push(outputHeaders.map(() => ''));
  }
  if (emptyRows.length > 0) {
    try {
      await throttledCall(() => writeSheet(
        MASTER_SHEET_ID,
        `'${tabListTabName}'!A${clearStart}:${colLetter}${clearEnd}`,
        emptyRows
      ));
    } catch (_) {
      // 범위 초과 등 무시
    }
  }

  logger.info(`[indexScan] 탭목록 쓰기 완료: ${outputValues.length - 1}행`);
}

// ═══════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════

module.exports = {
  runIndexScan,
  applyCachedIndexScan,
  hasIndexScanCache,
  buildTabUrl,
  extractSheetId,
  // 상수
  INDEX_HEADERS,
  SYSTEM_TAB_KEYWORDS,
};
