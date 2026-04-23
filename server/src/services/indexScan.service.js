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
        // ── 메타 실패해도 campaigns에는 등록되도록 campaignNameHint 사용 ──
        if (entry.campaignNameHint) {
          scanResults.push({
            sheet_url: entry.sheetUrl,
            campaign_name: entry.campaignNameHint,
            tab_url: '',
            tab_name: '',       // tabName 없으면 tab_configs에는 추가 안 됨
            _metaFailed: true,
          });
          logger.warn(`[indexScan] 메타 실패 시트 campaign 등록: ${entry.campaignNameHint} (${entry.sheetId.substring(0, 12)}...)`);
        }
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

        // 숨겨진 탭 제외
        if (sheet.properties.hidden) continue;

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
      // ── 에러 발생해도 campaigns에는 등록되도록 campaignNameHint 사용 ──
      if (entry.campaignNameHint) {
        scanResults.push({
          sheet_url: entry.sheetUrl,
          campaign_name: entry.campaignNameHint,
          tab_url: '',
          tab_name: '',
          _metaFailed: true,
        });
        logger.warn(`[indexScan] 에러 시트 campaign 등록: ${entry.campaignNameHint} (${entry.sheetId.substring(0, 12)}...) — ${err.message}`);
      }
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

  // 캐시 저장 (dryRun/non-dryRun 모두 — db-rebuild에서 fromCache 사용 가능)
  _scanCache = { scanResults, summary, cachedAt: Date.now() };
  if (dryRun) {
    logger.info(`[indexScan] 미리보기 결과 캐시 저장 (${totalTabs}개 탭, 5분 유효)`);
  } else {
    logger.info(`[indexScan] 실행 완료 — 캐시 저장 (${totalTabs}개 탭, db-rebuild용)`);
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
    // 메타 실패 항목은 탭목록에 쓰지 않음 (campaign만 등록용)
    if (result._metaFailed || !result.tab_name) continue;

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
// 탭목록 → DB 직접 동기화
// 탭목록 시트(또는 스캔 캐시)의 데이터를 DB에 직접 반영
//   1) campaigns 테이블 — (sheet_id, campaign_name) UPSERT
//   2) tab_configs 테이블 — (sheet_id, tab_name) UPSERT + tab_gid 포함
//   3) index_master 테이블 — (sheet_id, tab_name) UPSERT (row_count=0, status='active')
// → 대시보드에서 인덱스 빌드 없이 탭 목록 표시 가능
// ═══════════════════════════════════════════════════════════

const pool = require('../db/pool');

/**
 * 탭목록 시트 데이터를 DB에 직접 동기화
 *
 * @param {object} options
 * @param {boolean} options.dryRun - true면 미리보기만 (DB 변경 안 함)
 * @param {boolean} options.fromCache - true면 스캔 캐시에서, false면 탭목록 시트에서 읽기
 * @returns {object} 동기화 결과 요약
 */
async function syncTabListToDB({ dryRun = true, fromCache = false } = {}) {
  const startTime = Date.now();

  // ── 데이터 소스 결정 ──
  let rows; // [{ sheet_url, campaign_name, tab_url, tab_name }]

  if (fromCache) {
    // 스캔 캐시에서 가져오기
    if (!_scanCache) throw new Error('캐시된 스캔 결과가 없습니다. 인덱스 스캔을 먼저 실행하세요.');
    if (Date.now() - _scanCache.cachedAt > SCAN_CACHE_TTL) {
      _scanCache = null;
      throw new Error('캐시가 만료되었습니다 (5분 초과). 인덱스 스캔을 다시 실행하세요.');
    }
    rows = _scanCache.scanResults;
    logger.info(`[syncTabListToDB] 캐시에서 ${rows.length}행 로드`);
  } else {
    // 탭목록 시트에서 읽기
    rows = await _readTabListFromSheet();
    logger.info(`[syncTabListToDB] 탭목록 시트에서 ${rows.length}행 로드`);
  }

  if (rows.length === 0) {
    return { dryRun, elapsed: '0s', totalRows: 0, campaigns: 0, tabs: 0, indexEntries: 0, message: '동기화할 데이터 없음' };
  }

  // ── 시트DB에서 누락된 campaigns 보충 ──
  // 탭목록에는 메타데이터 조회 실패로 빠진 시트가 있을 수 있음
  // 시트DB의 전체 시트 URL을 읽어서 rows에 없는 campaign을 추가
  let supplemented = 0;
  try {
    if (MASTER_SHEET_ID) {
      const sheetDbTabName = await _findTabName(MASTER_SHEET_ID, SHEET_DB_TAB_NAME);
      const sheetDbValues = await throttledCall(() =>
        readSheet(MASTER_SHEET_ID, `'${sheetDbTabName}'!A:B`)
      );
      if (sheetDbValues && sheetDbValues.length >= 2) {
        const dbHeaders = sheetDbValues[0].map(h => String(h).trim().toLowerCase());
        const sUrlIdx = dbHeaders.indexOf('sheet_url');
        const sCampIdx = dbHeaders.indexOf('campaign_name');

        if (sUrlIdx >= 0) {
          // rows에 이미 있는 sheet_id 수집
          const existingSheetIds = new Set();
          for (const r of rows) {
            const sid = extractSheetId(r.sheet_url);
            if (sid) existingSheetIds.add(sid);
          }

          for (let i = 1; i < sheetDbValues.length; i++) {
            const row = sheetDbValues[i];
            if (!row || row.length === 0) continue;
            const url = (row[sUrlIdx] || '').toString().trim();
            const camp = sCampIdx >= 0 && row.length > sCampIdx ? (row[sCampIdx] || '').toString().trim() : '';
            const sid = extractSheetId(url);
            if (!sid || existingSheetIds.has(sid)) continue;
            if (!camp) continue;

            // 이 시트는 탭목록에 없지만 시트DB에 있음 → campaign으로만 추가
            existingSheetIds.add(sid);
            rows.push({
              sheet_url: url.replace(/[?#].*$/, '').replace(/\/edit$/, '/edit'),
              campaign_name: camp,
              tab_url: '',
              tab_name: '',
              _supplemented: true,
            });
            supplemented++;
          }
          if (supplemented > 0) {
            logger.info(`[syncTabListToDB] 시트DB에서 누락된 ${supplemented}개 campaign 보충`);
          }
        }
      }
    }
  } catch (err) {
    logger.warn(`[syncTabListToDB] 시트DB 보충 실패 (계속 진행): ${err.message}`);
  }

  // ── 기존 DB 데이터 조회 ──
  const { rows: dbCampaigns } = await pool.query('SELECT sheet_id, campaign_name FROM campaigns');
  const { rows: dbTabs } = await pool.query('SELECT sheet_id, tab_name, tab_gid FROM tab_configs');
  const { rows: dbIndex } = await pool.query('SELECT sheet_id, tab_name, tab_gid FROM index_master');

  const dbCampSet = new Set(dbCampaigns.map(c => `${c.sheet_id}||${c.campaign_name}`));
  const dbTabMap = new Map(dbTabs.map(t => [`${t.sheet_id}||${t.tab_name}`, t]));
  const dbIndexSet = new Set(dbIndex.map(i => `${i.sheet_id}||${i.tab_name}`));

  // ★ gid → 기존 tab_name 역매핑 (탭 이름 변경 감지용)
  // 동일 sheet_id 내에서 같은 gid를 가진 다른 tab_name이 있으면 이름이 변경된 것
  const gidToOldTabName = new Map(); // "sheetId||gid" → tab_name (from index_master)
  for (const idx of dbIndex) {
    if (idx.tab_gid) gidToOldTabName.set(`${idx.sheet_id}||${idx.tab_gid}`, idx.tab_name);
  }
  const gidToOldTabConfig = new Map(); // "sheetId||gid" → tab_name (from tab_configs)
  for (const tc of dbTabs) {
    if (tc.tab_gid) gidToOldTabConfig.set(`${tc.sheet_id}||${tc.tab_gid}`, tc.tab_name);
  }

  // ── diff 계산 ──
  const campaignsToAdd = [];
  const tabsToAdd = [];
  const tabsToUpdate = [];
  const indexToAdd = [];
  const tabsToRename = [];  // ★ gid 기반 탭 이름 변경 목록
  const seenCampaigns = new Set();

  for (const row of rows) {
    const sheetId = extractSheetId(row.sheet_url);
    if (!sheetId) continue;

    const campaignName = row.campaign_name || '';
    const tabName = row.tab_name || '';

    const sheetUrl = (row.sheet_url || '').replace(/[?#].*$/, '');

    // 1) campaigns — tabName이 없어도 campaign은 등록 (메타 실패 시트 포함)
    const campKey = `${sheetId}||${campaignName}`;
    if (campaignName && !seenCampaigns.has(campKey)) {
      seenCampaigns.add(campKey);
      if (!dbCampSet.has(campKey)) {
        campaignsToAdd.push({ sheetId, campaignName, sheetUrl });
      }
    }

    // tabName이 없으면 tab_configs / index_master는 스킵
    if (!tabName) continue;

    // tab_url에서 gid 추출
    const gidMatch = (row.tab_url || '').match(/gid=(\d+)/);
    const tabGid = gidMatch ? gidMatch[1] : '';

    // ★ gid 기반 탭 이름 변경 감지
    // 같은 gid를 가진 다른 tab_name이 DB에 있으면 이름이 변경된 것
    if (tabGid) {
      const gidKey = `${sheetId}||${tabGid}`;
      const oldTabNameIM = gidToOldTabName.get(gidKey);
      const oldTabNameTC = gidToOldTabConfig.get(gidKey);
      // index_master에서 이전 이름 발견
      if (oldTabNameIM && oldTabNameIM !== tabName) {
        tabsToRename.push({ sheetId, oldTabName: oldTabNameIM, newTabName: tabName, tabGid, source: 'index_master' });
      }
      // tab_configs에서 이전 이름 발견 (중복 방지)
      if (oldTabNameTC && oldTabNameTC !== tabName && oldTabNameTC !== oldTabNameIM) {
        tabsToRename.push({ sheetId, oldTabName: oldTabNameTC, newTabName: tabName, tabGid, source: 'tab_configs' });
      }
    }

    // 2) tab_configs
    const tabKey = `${sheetId}||${tabName}`;
    const existing = dbTabMap.get(tabKey);
    if (!existing) {
      tabsToAdd.push({ sheetId, tabName, sheetUrl, campaignName, tabGid });
    } else if (tabGid && existing.tab_gid !== tabGid) {
      tabsToUpdate.push({ sheetId, tabName, tabGid, campaignName });
    }

    // 3) index_master
    if (!dbIndexSet.has(tabKey)) {
      indexToAdd.push({ sheetId, tabName, tabGid, campaignName });
    }
  }

  const summary = {
    dryRun,
    totalRows: rows.length,
    campaigns: { existing: dbCampaigns.length, toAdd: campaignsToAdd.length, supplemented },
    tabs: { existing: dbTabs.length, toAdd: tabsToAdd.length, toUpdate: tabsToUpdate.length, toRename: tabsToRename.length },
    index: { existing: dbIndex.length, toAdd: indexToAdd.length },
  };

  // ── 미리보기면 여기서 종료 ──
  if (dryRun) {
    summary.elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
    summary.message = `미리보기: campaigns +${campaignsToAdd.length}${supplemented ? ` (시트DB 보충 ${supplemented})` : ''}, tabs +${tabsToAdd.length}/~${tabsToUpdate.length}/rename ${tabsToRename.length}, index +${indexToAdd.length}`;
    if (tabsToRename.length > 0) {
      summary.renames = tabsToRename.map(r => ({ old: r.oldTabName, new: r.newTabName, gid: r.tabGid }));
    }
    logger.info(`[syncTabListToDB] ${summary.message}`);
    return summary;
  }

  // ── DB 트랜잭션 실행 ──
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ★ gid 기반 탭 이름 변경: 이전 tab_name 행 삭제
    // 새 tab_name으로 다시 생성되므로 이전 이름 행만 제거
    const renamedSet = new Set();
    for (const r of tabsToRename) {
      const renameKey = `${r.sheetId}||${r.oldTabName}`;
      if (renamedSet.has(renameKey)) continue;
      renamedSet.add(renameKey);
      logger.info(`[syncTabListToDB] 탭 이름 변경: "${r.oldTabName}" → "${r.newTabName}" (gid=${r.tabGid})`);
      await client.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [r.sheetId, r.oldTabName]);
      await client.query('DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2', [r.sheetId, r.oldTabName]);
      await client.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2', [r.sheetId, r.oldTabName]);
    }

    // campaigns UPSERT
    for (const c of campaignsToAdd) {
      await client.query(
        `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET sheet_url = $3, updated_at = NOW()`,
        [c.sheetId, c.campaignName, c.sheetUrl]
      );
    }

    // tab_configs INSERT
    for (const t of tabsToAdd) {
      await client.query(
        `INSERT INTO tab_configs (sheet_id, tab_name, sheet_url, campaign_name, tab_gid, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
           sheet_url = $3, campaign_name = $4, tab_gid = $5, updated_at = NOW()`,
        [t.sheetId, t.tabName, t.sheetUrl, t.campaignName, t.tabGid]
      );
    }

    // tab_configs UPDATE (tab_gid 변경)
    for (const t of tabsToUpdate) {
      await client.query(
        `UPDATE tab_configs SET tab_gid = $1, campaign_name = COALESCE(NULLIF($2, ''), campaign_name), updated_at = NOW()
         WHERE sheet_id = $3 AND tab_name = $4`,
        [t.tabGid, t.campaignName, t.sheetId, t.tabName]
      );
    }

    // index_master UPSERT (빈 껍데기 — row_count=0, status='active')
    for (const i of indexToAdd) {
      await client.query(
        `INSERT INTO index_master (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count, status, built_at)
         VALUES ($1, $2, $3, $4, 0, 0, 'active', NOW())
         ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
           tab_gid = COALESCE(NULLIF($3, ''), index_master.tab_gid),
           campaign_name = COALESCE(NULLIF($4, ''), index_master.campaign_name),
           status = 'active',
           built_at = NOW()`,
        [i.sheetId, i.tabName, i.tabGid, i.campaignName]
      );
    }

    await client.query('COMMIT');
    logger.info(`[syncTabListToDB] DB 반영 완료: campaigns +${campaignsToAdd.length}, tabs +${tabsToAdd.length}/~${tabsToUpdate.length}/rename ${tabsToRename.length}, index +${indexToAdd.length}`);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[syncTabListToDB] DB 반영 실패: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }

  summary.elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  summary.message = `완료: campaigns +${campaignsToAdd.length}, tabs +${tabsToAdd.length}/~${tabsToUpdate.length}/rename ${tabsToRename.length}, index +${indexToAdd.length} (${summary.elapsed})`;
  return summary;
}

/**
 * 탭목록 시트에서 데이터를 읽어 배열로 반환
 */
async function _readTabListFromSheet() {
  if (!MASTER_SHEET_ID) throw new Error('MASTER_SHEET_ID 환경변수 미설정');

  const tabListTabName = await _findTabName(MASTER_SHEET_ID, TAB_LIST_TAB_NAME);
  const values = await throttledCall(() =>
    readSheet(MASTER_SHEET_ID, `'${tabListTabName}'!A:Z`)
  );

  if (!values || values.length < 2) return [];

  const headers = values[0].map(h => String(h).trim().toLowerCase());
  const urlIdx = headers.indexOf('sheet_url');
  const campIdx = headers.indexOf('campaign_name');
  const tabUrlIdx = headers.indexOf('tab_url');
  const tabNameIdx = headers.indexOf('tab_name');

  if (urlIdx === -1 || tabNameIdx === -1) {
    throw new Error("탭목록에 'sheet_url' 또는 'tab_name' 컬럼이 없습니다");
  }

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row || row.length === 0) continue;

    const sheetUrl = (row[urlIdx] || '').toString().trim();
    const tabName = (row[tabNameIdx] || '').toString().trim();
    if (!sheetUrl || !tabName) continue;

    rows.push({
      sheet_url: sheetUrl,
      campaign_name: campIdx >= 0 ? (row[campIdx] || '').toString().trim() : '',
      tab_url: tabUrlIdx >= 0 ? (row[tabUrlIdx] || '').toString().trim() : '',
      tab_name: tabName,
    });
  }

  return rows;
}

// ═══════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════

module.exports = {
  runIndexScan,
  applyCachedIndexScan,
  hasIndexScanCache,
  syncTabListToDB,
  buildTabUrl,
  extractSheetId,
  // 상수
  INDEX_HEADERS,
  SYSTEM_TAB_KEYWORDS,
};
