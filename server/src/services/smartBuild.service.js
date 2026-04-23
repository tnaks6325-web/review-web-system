/**
 * smartBuild.service.js
 * ═══════════════════════════════════════════════════════════
 * 스마트 빌드 — Drive API 변경감지 + Sheets API batchGet 조합
 * 
 * 기존 indexBuilder.service.js와 완전히 독립된 별개 모듈.
 * indexBuilder의 parseTabRows, computeChecksum, _upsertTabIndex 로직을
 * 내부에서 자체적으로 재구현하여 의존성 없음.
 *
 * 흐름:
 *   1. Drive API로 57개 시트 수정시각 일괄 조회 (분당 12,000회 한도)
 *   2. 이전 수정시각과 비교하여 변경된 시트만 필터링
 *   3. 변경된 시트에 대해 Sheets API batchGet으로 모든 탭 데이터 한번에 읽기
 *   4. 탭별 체크섬 비교 → 변경된 탭만 DB(index_master + review_index) 갱신
 *   5. 5분 주기 자동 실행 (setInterval)
 * ═══════════════════════════════════════════════════════════
 */

const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta, batchReadSheet, getSheetModifiedTime } = require('./sheets.service');
const { computeChecksum } = require('../utils/checksum');
const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
// 상수 및 상태
// ═══════════════════════════════════════════════════════════

const SMART_BUILD_INTERVAL_MS = 5 * 60 * 1000; // 5분

// 키워드 기본값 (DB 로드 실패 시 폴백)
const DEFAULT_SUBMITTED_VALUES = ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'];
const DEFAULT_NAME_KEYWORDS = ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'];
const DEFAULT_SYSTEM_TABS = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정', 'detail', 'config'];
const DEFAULT_DATA_TAB_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];
const DEFAULT_SUBMIT_KEYWORDS = ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출'];

let SUBMITTED_VALUES = [...DEFAULT_SUBMITTED_VALUES];
let NAME_KEYWORDS = [...DEFAULT_NAME_KEYWORDS];
let SYSTEM_TABS = [...DEFAULT_SYSTEM_TABS];
let DATA_TAB_KEYWORDS = [...DEFAULT_DATA_TAB_KEYWORDS];
let SUBMIT_KEYWORDS = [...DEFAULT_SUBMIT_KEYWORDS];

// 스마트빌드 런타임 상태
let _intervalHandle = null;
let _isRunning = false;
let _lastRunResult = null;
let _modifiedTimeCache = {};   // sheetId → { modifiedTime, checkedAt }
let _checksumCache = {};       // "sheetId||tabName" → checksum
let _runCount = 0;
let _startedAt = null;

// ═══════════════════════════════════════════════════════════
// DB에서 키워드 로드
// ═══════════════════════════════════════════════════════════

async function _loadKeywords() {
  try {
    const { rows } = await pool.query(
      "SELECT category, keyword FROM index_keywords WHERE active = TRUE ORDER BY category, keyword"
    );
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r.keyword);
    });
    DATA_TAB_KEYWORDS = grouped['data_tab'] || [...DEFAULT_DATA_TAB_KEYWORDS];
    NAME_KEYWORDS = grouped['name'] || [...DEFAULT_NAME_KEYWORDS];
    SUBMIT_KEYWORDS = grouped['submit'] || [...DEFAULT_SUBMIT_KEYWORDS];
    SYSTEM_TABS = grouped['system_tab'] || [...DEFAULT_SYSTEM_TABS];
  } catch (err) {
    logger.warn(`[smartBuild] 키워드 로드 실패 (폴백 사용): ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// 헤더 감지 + 행 파싱 (indexBuilder.parseTabRows 자체 재구현)
// ═══════════════════════════════════════════════════════════

function _isDataTabRow(cells) {
  let matchCount = 0;
  for (const kw of DATA_TAB_KEYWORDS) {
    const found = kw === '번호'
      ? cells.includes(kw)
      : cells.some(c => c.includes(kw));
    if (found) {
      matchCount++;
      if (matchCount >= 2) return true;
    }
  }
  return false;
}

function _formatDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return s;
  const num = Number(s);
  if (!isNaN(num) && num > 40000 && num < 50000) {
    const date = new Date((num - 25569) * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }
  return s;
}

function _parseTabRows(values, sheetId, tabName, tabGid, campaignTitle) {
  const HEADER_SCAN_LIMIT = 50;
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(values.length, HEADER_SCAN_LIMIT); i++) {
    const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
    if (_isDataTabRow(cells)) { headerRowIdx = i; break; }
  }
  if (headerRowIdx < 0) return [];

  const headers = values[headerRowIdx].map(h => String(h || '').trim());
  const dataRows = values.slice(headerRowIdx + 1);

  const nameColIdx = headers.findIndex(h => NAME_KEYWORDS.some(k => h.includes(k)));
  if (nameColIdx < 0) return [];

  const submitColIdx = headers.findIndex(h => SUBMIT_KEYWORDS.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const productKeywords = ['상품명', '제품명', '상품', 'product'];
  const productColIdx = headers.findIndex(h => productKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const urlKeywords = ['상품url', '제품url', '상품링크', 'url', '링크'];
  const urlColIdx = headers.findIndex(h => urlKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const phoneKeywords = ['연락처', '전화번호', '핸드폰', '휴대폰', 'phone'];
  const phoneColIdx = headers.findIndex(h => phoneKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const startDateKeywords = ['시작일', '구매일', '주문일', '배정일'];
  const endDateKeywords = ['종료일', '마감일', '완료일', '제출마감'];
  const startDateIdx = headers.findIndex(h => startDateKeywords.some(k => h.includes(k)));
  const endDateIdx = headers.findIndex(h => endDateKeywords.some(k => h.includes(k)));

  const roundKeywords = ['회차', '차수', 'round'];
  const roundIdx = headers.findIndex(h => roundKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  return dataRows
    .map((row, i) => {
      const name = String(row[nameColIdx] || '').trim();
      if (!name) return null;

      const submitVal = submitColIdx >= 0 ? String(row[submitColIdx] || '').trim() : '';
      const isSubmitted = SUBMITTED_VALUES.includes(submitVal);

      let phone8 = null;
      if (phoneColIdx >= 0) {
        const phoneRaw = String(row[phoneColIdx] || '').replace(/[^0-9]/g, '');
        if (phoneRaw.length >= 8) phone8 = phoneRaw.slice(-8);
      }

      return {
        name,
        tabGid,
        rowIndex: headerRowIdx + 1 + i + 1,
        isSubmitted,
        submitCol: submitColIdx >= 0 ? headers[submitColIdx] : '',
        productName: productColIdx >= 0 ? String(row[productColIdx] || '').trim() : '',
        productUrl: urlColIdx >= 0 ? String(row[urlColIdx] || '').trim() : '',
        rowJson: Object.fromEntries(headers.map((h, j) => [h, row[j] !== undefined ? row[j] : ''])),
        startDate: startDateIdx >= 0 ? _formatDate(row[startDateIdx]) : null,
        endDate: endDateIdx >= 0 ? _formatDate(row[endDateIdx]) : null,
        round: roundIdx >= 0 ? String(row[roundIdx] || '').trim() : '',
        campaignName: campaignTitle || tabName,
        phone8,
      };
    })
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════
// DB Upsert (자체 구현 — indexBuilder와 독립)
// ═══════════════════════════════════════════════════════════

async function _upsertTab(sheetId, tabName, tabGid, checksum, rows, modifiedTime, campaignName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const newRowIndices = new Set();
    if (rows.length > 0) {
      const BATCH_SIZE = 100;
      for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
        const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);
        const insertValues = [];
        const insertPlaceholders = [];
        let paramIdx = 1;

        for (const row of batch) {
          newRowIndices.add(row.rowIndex);
          insertPlaceholders.push(
            `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`
          );
          insertValues.push(
            row.name, sheetId, row.tabGid, tabName,
            row.campaignName, row.rowIndex, row.isSubmitted,
            row.productUrl, row.productName, row.submitCol,
            JSON.stringify(row.rowJson), row.startDate, row.endDate, row.round,
            row.phone8 || null
          );
        }

        await client.query(`
          INSERT INTO review_index
            (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
             row_index, is_submitted, product_url, product_name,
             submit_col, row_json, start_date, end_date, round, phone8)
          VALUES ${insertPlaceholders.join(', ')}
          ON CONFLICT (sheet_id, tab_name, row_index) DO UPDATE SET
            reviewer_name = EXCLUDED.reviewer_name,
            tab_gid = EXCLUDED.tab_gid,
            campaign_name = EXCLUDED.campaign_name,
            is_submitted = EXCLUDED.is_submitted,
            product_url = EXCLUDED.product_url,
            product_name = EXCLUDED.product_name,
            submit_col = EXCLUDED.submit_col,
            row_json = EXCLUDED.row_json,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            round = EXCLUDED.round,
            phone8 = EXCLUDED.phone8,
            built_at = NOW()
        `, insertValues);
      }
    }

    // 고아 행 삭제
    if (newRowIndices.size > 0) {
      await client.query(
        `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index != ALL($3::int[])`,
        [sheetId, tabName, [...newRowIndices]]
      );
    } else {
      await client.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]);
    }

    // index_master 갱신
    await client.query(`
      INSERT INTO index_master (sheet_id, tab_name, tab_gid, campaign_name, checksum, built_at,
                                row_count, submitted_count, status, sheet_modified_at)
      VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,'active',$8)
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        checksum = EXCLUDED.checksum,
        built_at = NOW(),
        row_count = EXCLUDED.row_count,
        submitted_count = EXCLUDED.submitted_count,
        campaign_name = EXCLUDED.campaign_name,
        status = 'active',
        error_msg = NULL,
        sheet_modified_at = EXCLUDED.sheet_modified_at
    `, [
      sheetId, tabName, tabGid, campaignName || tabName,
      checksum, rows.length, rows.filter(r => r.isSubmitted).length,
      modifiedTime || null
    ]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════
// 메인: 스마트 빌드 1회 실행
// ═══════════════════════════════════════════════════════════

async function runSmartBuild() {
  if (_isRunning) {
    logger.warn('[smartBuild] 이미 실행 중 — 스킵');
    return { ok: false, reason: 'already_running' };
  }

  _isRunning = true;
  _runCount++;
  const runNum = _runCount;
  const startTime = Date.now();
  const isFirstRun = Object.keys(_modifiedTimeCache).length === 0;

  const result = {
    ok: true,
    runNumber: runNum,
    isFirstRun,
    sheetsChecked: 0,
    sheetsChanged: 0,
    tabsScanned: 0,
    tabsUpdated: 0,
    tabsSkipped: 0,
    errors: 0,
    errorDetails: [],
    elapsed: 0,
    timestamp: new Date().toISOString(),
  };

  try {
    // ── 0단계: 키워드 로드 ──
    await _loadKeywords();

    // ── 1단계: DB에서 시트 ID 목록 + 기존 체크섬 로드 ──
    const { rows: campaignRows } = await pool.query(
      'SELECT DISTINCT sheet_id FROM campaigns UNION SELECT DISTINCT sheet_id FROM tab_configs'
    );
    const sheetIds = [...new Set(campaignRows.map(r => r.sheet_id))].filter(Boolean);
    result.sheetsChecked = sheetIds.length;

    // 기존 체크섬 로드 (첫 실행 시)
    if (isFirstRun) {
      const { rows: masterRows } = await pool.query('SELECT sheet_id, tab_name, checksum FROM index_master');
      masterRows.forEach(r => {
        _checksumCache[`${r.sheet_id}||${r.tab_name}`] = r.checksum;
      });
      logger.info(`[smartBuild] 첫 실행: 체크섬 캐시 ${masterRows.length}건 로드`);
    }

    // 마감 탭 목록 로드
    const { rows: closedRows } = await pool.query('SELECT sheet_id, tab_name FROM tab_configs WHERE is_closed = TRUE');
    const closedSet = new Set(closedRows.map(r => `${r.sheet_id}||${r.tab_name}`));

    // ── 2단계: Drive API로 변경 시트 감지 ──
    const changedSheetIds = [];

    for (const sheetId of sheetIds) {
      try {
        const modifiedTime = await getSheetModifiedTime(sheetId);
        const cached = _modifiedTimeCache[sheetId];

        if (!cached || cached.modifiedTime !== modifiedTime) {
          changedSheetIds.push(sheetId);
          _modifiedTimeCache[sheetId] = { modifiedTime, checkedAt: Date.now() };
        }
      } catch (err) {
        // Drive API 실패 → 안전하게 변경된 것으로 간주
        changedSheetIds.push(sheetId);
        result.errorDetails.push({ phase: 'drive', sheetId: sheetId.substring(0, 15), error: err.message });
      }
    }

    result.sheetsChanged = changedSheetIds.length;

    if (changedSheetIds.length === 0) {
      logger.info(`[smartBuild] #${runNum} 변경 없음 — ${sheetIds.length}개 시트 확인, ${Date.now() - startTime}ms`);
      result.elapsed = Date.now() - startTime;
      _lastRunResult = result;
      return result;
    }

    logger.info(`[smartBuild] #${runNum} 변경 감지: ${changedSheetIds.length}/${sheetIds.length}개 시트`);

    // ── 3단계: 변경된 시트별 batchGet + 체크섬 비교 + DB 갱신 ──
    for (const sheetId of changedSheetIds) {
      try {
        // 시트 메타 조회 (탭 목록)
        const meta = await getSpreadsheetMeta(sheetId);
        const spreadsheetTitle = meta._spreadsheetTitle || '';
        const validTabs = meta.filter(s => {
          const title = s.properties.title;
          return !SYSTEM_TABS.includes(title);
        });

        if (validTabs.length === 0) continue;

        // 활성 탭만 필터 (마감 탭 제외)
        const activeTabs = validTabs.filter(t => {
          const key = `${sheetId}||${t.properties.title}`;
          return !closedSet.has(key);
        });

        if (activeTabs.length === 0) continue;

        // batchGet으로 한번에 읽기
        const BATCH_CHUNK_SIZE = 50;
        const ranges = activeTabs.map(t => `'${t.properties.title}'!A:Z`);
        let batchResults = [];

        try {
          if (ranges.length <= BATCH_CHUNK_SIZE) {
            batchResults = await batchReadSheet(sheetId, ranges);
          } else {
            for (let i = 0; i < ranges.length; i += BATCH_CHUNK_SIZE) {
              const chunk = await batchReadSheet(sheetId, ranges.slice(i, i + BATCH_CHUNK_SIZE));
              batchResults.push(...chunk);
            }
          }
        } catch (batchErr) {
          // batchGet 실패 → 개별 읽기 폴백
          logger.warn(`[smartBuild] batchGet 실패 (${sheetId.substring(0, 15)}), 개별 읽기 폴백: ${batchErr.message}`);
          batchResults = [];
          for (const tab of activeTabs) {
            try {
              const values = await readSheet(sheetId, `'${tab.properties.title}'!A:Z`);
              batchResults.push({ values: values || [] });
            } catch (readErr) {
              batchResults.push({ values: [], error: readErr.message });
            }
          }
        }

        // 탭별 처리
        for (let i = 0; i < activeTabs.length; i++) {
          const tab = activeTabs[i];
          const tabName = tab.properties.title;
          const tabGid = String(tab.properties.sheetId);
          const key = `${sheetId}||${tabName}`;

          result.tabsScanned++;

          try {
            const batchItem = batchResults[i];
            const values = batchItem?.values || batchItem?.data?.values || [];

            if (!values || values.length < 2) {
              result.tabsSkipped++;
              continue;
            }

            // 체크섬 비교
            const newChecksum = computeChecksum(values);
            if (_checksumCache[key] === newChecksum) {
              result.tabsSkipped++;
              continue;
            }

            // 변경됨 → 파싱 + DB 갱신
            const rows = _parseTabRows(values, sheetId, tabName, tabGid, spreadsheetTitle);

            if (rows.length === 0) {
              // 파싱 실패 탭 → index_master에 에러가 아닌 빈 상태로 업데이트
              result.tabsSkipped++;
              continue;
            }

            const modifiedTime = _modifiedTimeCache[sheetId]?.modifiedTime || null;
            await _upsertTab(sheetId, tabName, tabGid, newChecksum, rows, modifiedTime, spreadsheetTitle);

            // 체크섬 캐시 갱신
            _checksumCache[key] = newChecksum;
            result.tabsUpdated++;

            logger.info(`[smartBuild] 갱신: ${spreadsheetTitle}/${tabName} — ${rows.length}행 (제출:${rows.filter(r => r.isSubmitted).length})`);

          } catch (tabErr) {
            result.errors++;
            result.errorDetails.push({ phase: 'tab', sheetId: sheetId.substring(0, 15), tabName, error: tabErr.message });
            logger.error(`[smartBuild] 탭 처리 오류 (${tabName}): ${tabErr.message}`);
          }
        }

      } catch (sheetErr) {
        result.errors++;
        result.errorDetails.push({ phase: 'sheet', sheetId: sheetId.substring(0, 15), error: sheetErr.message });
        logger.error(`[smartBuild] 시트 처리 오류 (${sheetId.substring(0, 15)}): ${sheetErr.message}`);
      }
    }

    result.elapsed = Date.now() - startTime;
    logger.info(`[smartBuild] #${runNum} 완료: 변경 ${result.sheetsChanged}시트, 스캔 ${result.tabsScanned}탭, 갱신 ${result.tabsUpdated}탭, 스킵 ${result.tabsSkipped}, 오류 ${result.errors}, ${result.elapsed}ms`);

    // 빌드 히스토리 기록
    try {
      await pool.query(`
        INSERT INTO build_history (elapsed_ms, rebuilt, skipped, errors, total, trigger_by, build_log)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        result.elapsed, result.tabsUpdated, result.tabsSkipped, result.errors,
        result.tabsScanned, `smart_build_#${runNum}`,
        JSON.stringify({ sheetsChanged: result.sheetsChanged, errorDetails: result.errorDetails })
      ]);
    } catch (_) {}

  } catch (err) {
    result.ok = false;
    result.errors++;
    result.errorDetails.push({ phase: 'global', error: err.message });
    logger.error(`[smartBuild] #${runNum} 전체 오류: ${err.message}`);
  } finally {
    result.elapsed = Date.now() - startTime;
    _isRunning = false;
    _lastRunResult = result;

    // ★ SSE 브로드캐스트: 변경이 있었을 때만 알림
    if (result.tabsUpdated > 0 || result.errors > 0) {
      try {
        const { broadcast } = require('../utils/sse');
        broadcast('smart_build_done', {
          message: `스마트빌드 #${runNum} 완료: ${result.sheetsChanged}시트 변경, ${result.tabsUpdated}탭 갱신, ${result.errors}건 오류 (${(result.elapsed/1000).toFixed(1)}s)`,
          ...result,
        });
      } catch (_) {}
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 스케줄러: 5분 주기 자동 실행
// ═══════════════════════════════════════════════════════════

function startSmartBuild() {
  if (_intervalHandle) {
    logger.warn('[smartBuild] 이미 스케줄러 실행 중');
    return false;
  }

  _startedAt = new Date().toISOString();
  logger.info(`[smartBuild] 스케줄러 시작 — ${SMART_BUILD_INTERVAL_MS / 1000}초 주기`);

  // 최초 실행: 서버 시작 30초 후 (다른 초기화가 완료될 시간 확보)
  setTimeout(() => {
    runSmartBuild().catch(err => logger.error(`[smartBuild] 초기 실행 오류: ${err.message}`));
  }, 30 * 1000);

  // 주기적 실행
  _intervalHandle = setInterval(() => {
    runSmartBuild().catch(err => logger.error(`[smartBuild] 주기 실행 오류: ${err.message}`));
  }, SMART_BUILD_INTERVAL_MS);

  return true;
}

function stopSmartBuild() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    logger.info('[smartBuild] 스케줄러 중지');
    return true;
  }
  return false;
}

function getSmartBuildStatus() {
  return {
    running: _isRunning,
    schedulerActive: !!_intervalHandle,
    startedAt: _startedAt,
    intervalMs: SMART_BUILD_INTERVAL_MS,
    runCount: _runCount,
    cachedSheets: Object.keys(_modifiedTimeCache).length,
    cachedChecksums: Object.keys(_checksumCache).length,
    lastRun: _lastRunResult,
  };
}

// ═══════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════

module.exports = {
  runSmartBuild,
  startSmartBuild,
  stopSmartBuild,
  getSmartBuildStatus,
  SMART_BUILD_INTERVAL_MS,
};
