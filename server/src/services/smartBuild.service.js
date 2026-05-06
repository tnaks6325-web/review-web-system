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
const { throttledCall } = require('../utils/sheetsThrottle');

// ═══════════════════════════════════════════════════════════
// 상수 및 상태
// ═══════════════════════════════════════════════════════════

const SMART_BUILD_INTERVAL_MS = 5 * 60 * 1000; // 5분

// ── 에러 메시지 한글 번역 헬퍼 ──
function _translateError(msg) {
  if (!msg) return '알 수 없는 오류';
  if (/file not found/i.test(msg))                      return '파일을 찾을 수 없습니다 (삭제되었거나 ID가 잘못됨)';
  if (/does not have permission/i.test(msg))             return '접근 권한이 없습니다 (서비스 계정에 공유 필요)';
  if (/caller does not have permission/i.test(msg))      return '접근 권한이 없습니다 (서비스 계정에 공유 필요)';
  if (/quota exceeded/i.test(msg))                       return 'API 할당량 초과 (잠시 후 자동 재시도)';
  if (/rate limit/i.test(msg))                           return 'API 요청 속도 제한 초과';
  if (/unable to parse range/i.test(msg))                return '시트 범위를 파싱할 수 없습니다 (탭 이름 오류)';
  if (/requested entity was not found/i.test(msg))       return '요청한 항목을 찾을 수 없습니다';
  if (/spreadsheet.*not found/i.test(msg))               return '스프레드시트를 찾을 수 없습니다';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg))      return '네트워크 연결 오류 (일시적 장애)';
  if (/socket hang up/i.test(msg))                       return '네트워크 연결이 끊어졌습니다';
  if (/503|service unavailable/i.test(msg))              return 'Google API 서비스 일시 중단';
  if (/500|internal server error/i.test(msg))            return 'Google API 내부 서버 오류';
  return msg; // 매칭 안 되면 원문 반환
}

// 키워드 기본값 (DB 로드 실패 시 폴백)
const DEFAULT_SUBMITTED_VALUES = ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'];
const DEFAULT_NAME_KEYWORDS = ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'];
const DEFAULT_SYSTEM_TABS = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정', 'detail', 'config'];
const DEFAULT_DATA_TAB_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];
const DEFAULT_SUBMIT_KEYWORDS = ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰'];

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

/**
 * 제출 여부 판단 로직 (강화된 3단계)
 * 1단계: SUBMITTED_VALUES에 직접 매칭 (기존 로직)
 * 2단계: 날짜 패턴 인식 (MM/DD HH:MM, YYYY-MM-DD, M/D 등)
 * 3단계: 비어있지 않은 값이면 제출로 간주 (빈 칸 = 미제출)
 */
function _isSubmittedValue(val) {
  if (!val) return false;
  // 1단계: 기존 SUBMITTED_VALUES 직접 매칭
  if (SUBMITTED_VALUES.includes(val)) return true;
  // 2단계: 날짜/시간 패턴 인식 (리뷰제출일 열에 "04/11 22:26" 같은 값)
  if (/\d{1,2}\/\d{1,2}/.test(val)) return true;   // MM/DD 또는 M/D
  if (/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(val)) return true;  // YYYY-MM-DD
  if (/\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(val)) return true;  // DD.MM.YYYY 등
  // 3단계: 비어있지 않은 값이면 제출로 간주 (e.g. "리뷰등록", "작성완료" 등 커스텀 값)
  return val.length > 0;
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

  // ── 제출열 탐색: 우선순위 기반 ("리뷰제출" > "리뷰완료" > 기타 "제출") ──
  // 1단계: 정확한 키워드 일치 (= 헤더가 키워드와 동일)
  // 2단계: "리뷰" 접두사 포함 매칭 우선 ("리뷰제출", "리뷰제출일", "리뷰완료")
  // 3단계: 일반 부분 매칭 ("제출", "완료" 등) — 단, "주문자" 포함 헤더 제외
  let submitColIdx = -1;
  const SUBMIT_PRIORITY_PREFIXES = ['리뷰'];  // 이 접두사가 있는 열을 우선
  const SUBMIT_EXCLUDE_PATTERNS = ['주문자', '수취인', '이름', '성함', '예금주'];  // 사람이름 열 제외

  // 1단계: "리뷰" 접두사 + 키워드 매칭 (최우선)
  for (let hi = 0; hi < headers.length && submitColIdx < 0; hi++) {
    const hl = headers[hi].toLowerCase();
    if (SUBMIT_PRIORITY_PREFIXES.some(p => hl.includes(p)) &&
        SUBMIT_KEYWORDS.some(k => hl.includes(k.toLowerCase()))) {
      submitColIdx = hi;
    }
  }
  // 2단계: 일반 키워드 매칭 (사람이름 열 제외)
  if (submitColIdx < 0) {
    for (let hi = 0; hi < headers.length && submitColIdx < 0; hi++) {
      const hl = headers[hi].toLowerCase();
      if (SUBMIT_EXCLUDE_PATTERNS.some(p => hl.includes(p))) continue;
      if (SUBMIT_KEYWORDS.some(k => hl.includes(k.toLowerCase()))) {
        submitColIdx = hi;
      }
    }
  }
  // 3단계: 폴백 — 제외 패턴 무시하고 원래 로직 (호환성)
  if (submitColIdx < 0) {
    submitColIdx = headers.findIndex(h => SUBMIT_KEYWORDS.some(k => h.toLowerCase().includes(k.toLowerCase())));
  }

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
      // 제출 판단: (1) SUBMITTED_VALUES 직접 매칭, (2) 날짜 패턴 인식, (3) 비어있지 않은 값
      const isSubmitted = _isSubmittedValue(submitVal);

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

    // ★★★ 방어적 필터: 이미 아카이브된 탭이면 재삽입하지 않고 스킵
    // (activeTabs 필터를 통과했더라도 아카이브 테이블에 있으면 스킵)
    // tab_name 매칭 + gid 매칭 (탭 이름 변경 대응)
    const { rows: archiveCheck } = await client.query(
      `SELECT 1 FROM index_master_archive
       WHERE sheet_id = $1 AND (tab_name = $2 OR ($3::text IS NOT NULL AND tab_gid = $3::text))
       LIMIT 1`,
      [sheetId, tabName, tabGid || null]
    );
    if (archiveCheck.length > 0) {
      await client.query('COMMIT');
      client.release();
      logger.info(`[smartBuild] _upsertTab 스킵: "${tabName}" (gid=${tabGid}) — index_master_archive에 존재 (아카이브됨)`);
      return;
    }

    // ★ gid 기반 탭 이름 변경 감지 — 동일 gid의 이전 tab_name 행 정리
    // 구글시트에서 탭 이름이 변경되면 gid는 유지되지만 tab_name이 달라짐
    // 이전 이름의 행을 삭제하지 않으면 대시보드에 두 개가 표시됨
    if (tabGid) {
      const { rows: oldEntries } = await client.query(
        `SELECT tab_name FROM index_master WHERE sheet_id = $1 AND tab_gid = $2 AND tab_name != $3`,
        [sheetId, tabGid, tabName]
      );
      for (const old of oldEntries) {
        logger.info(`[smartBuild] 탭 이름 변경 감지: "${old.tab_name}" → "${tabName}" (gid=${tabGid})`);
        // review_index에서 이전 tab_name 행 삭제
        await client.query(
          `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, old.tab_name]
        );
        // index_master에서 이전 tab_name 행 삭제
        await client.query(
          `DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, old.tab_name]
        );
        // tab_configs에서 이전 tab_name 행 삭제
        await client.query(
          `DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, old.tab_name]
        );
        // 체크섬 캐시에서 이전 키 제거
        delete _checksumCache[`${sheetId}||${old.tab_name}`];
      }
    }

    // ★ 아카이브된 차수(round)의 행은 재삽입하지 않도록 필터링
    // 탭 자체는 활성이지만 특정 차수만 아카이브된 경우, 해당 차수 행 제외
    const { rows: tcArchivedRows } = await client.query(
      'SELECT archived_rounds FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );
    const archivedRoundsStr = tcArchivedRows?.[0]?.archived_rounds || '';
    const archivedRoundsSet = new Set(
      archivedRoundsStr.split(',').map(s => s.trim()).filter(Boolean)
    );

    // 아카이브된 차수에 해당하는 행 제외
    let filteredRows = rows;
    if (archivedRoundsSet.size > 0) {
      filteredRows = rows.filter(row => {
        if (!row.round) return true; // 차수가 없는 행은 유지
        return !archivedRoundsSet.has(row.round.trim());
      });
      const skippedCount = rows.length - filteredRows.length;
      if (skippedCount > 0) {
        logger.info(`[smartBuild] ${tabName}: 아카이브된 차수 행 ${skippedCount}건 스킵 (archived_rounds: ${archivedRoundsStr})`);
      }
    }

    const newRowIndices = new Set();
    if (filteredRows.length > 0) {
      const BATCH_SIZE = 100;
      for (let batchStart = 0; batchStart < filteredRows.length; batchStart += BATCH_SIZE) {
        const batch = filteredRows.slice(batchStart, batchStart + BATCH_SIZE);
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

    // 고아 행 삭제 (아카이브된 차수 행도 삭제 대상에서 보호)
    if (newRowIndices.size > 0) {
      if (archivedRoundsSet.size > 0) {
        // 아카이브된 차수의 행은 보존 — newRowIndices에 없더라도 삭제하지 않음
        // 아카이브된 차수 행은 이미 위에서 INSERT 대상에서 제외됨
        // 따라서 review_index에서 해당 차수 행만 별도 보존
        await client.query(
          `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index != ALL($3::int[])
           AND (round IS NULL OR round NOT IN (${[...archivedRoundsSet].map((_, i) => `$${i + 4}`).join(',')}))`,
          [sheetId, tabName, [...newRowIndices], ...archivedRoundsSet]
        );
      } else {
        await client.query(
          `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index != ALL($3::int[])`,
          [sheetId, tabName, [...newRowIndices]]
        );
      }
    } else if (archivedRoundsSet.size === 0) {
      await client.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]);
    }
    // else: filteredRows가 0이지만 아카이브된 차수가 있으면 → 기존 아카이브 차수 행 보존

    // index_master 갱신 (filteredRows 기준 카운트)
    await client.query(`
      INSERT INTO index_master (sheet_id, tab_name, tab_gid, campaign_name, checksum, built_at,
                                row_count, submitted_count, status, sheet_modified_at)
      VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,'active',$8)
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        tab_gid = EXCLUDED.tab_gid,
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
      checksum, filteredRows.length, filteredRows.filter(r => r.isSubmitted).length,
      modifiedTime || null
    ]);

    // tab_configs도 현재 탭의 tab_gid 갱신
    if (tabGid) {
      await client.query(
        `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheet_url, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
           tab_gid = $3, campaign_name = COALESCE(NULLIF($4, ''), tab_configs.campaign_name), updated_at = NOW()`,
        [sheetId, tabName, tabGid, campaignName || '', `https://docs.google.com/spreadsheets/d/${sheetId}/edit`]
      );
    }

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

    // ★ 아카이브된 탭 목록 로드 — 스마트빌드에서 완전히 제외
    const { rows: archivedRows } = await pool.query('SELECT sheet_id, tab_name, tab_gid FROM index_master_archive');
    const archivedSet = new Set(archivedRows.map(r => `${r.sheet_id}||${r.tab_name}`));
    // ★ gid 기반 아카이브 Set (탭 이름 변경 후에도 감지)
    const archivedGidSet = new Set(
      archivedRows.filter(r => r.tab_gid).map(r => `${r.sheet_id}||gid:${r.tab_gid}`)
    );
    if (archivedRows.length > 0) {
      logger.info(`[smartBuild] 아카이브된 탭 ${archivedRows.length}개 스킵 대상 로드 (gid매칭: ${archivedGidSet.size}개)`);
    }

    // ── 2단계: Drive API로 변경 시트 감지 (throttle 적용) ──
    const changedSheetIds = [];

    for (const sheetId of sheetIds) {
      try {
        const modifiedTime = await throttledCall(() => getSheetModifiedTime(sheetId));
        const cached = _modifiedTimeCache[sheetId];

        if (!cached || cached.modifiedTime !== modifiedTime) {
          changedSheetIds.push(sheetId);
          _modifiedTimeCache[sheetId] = { modifiedTime, checkedAt: Date.now() };
        }
      } catch (err) {
        // Drive API 실패 → 안전하게 변경된 것으로 간주
        changedSheetIds.push(sheetId);
        result.errorDetails.push({ phase: 'drive', sheetId: sheetId.substring(0, 15), error: err.message, desc: _translateError(err.message) });
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
        // 시트 메타 조회 (탭 목록) — throttle 적용
        const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
        const spreadsheetTitle = meta._spreadsheetTitle || '';
        const validTabs = meta.filter(s => {
          const title = s.properties.title;
          // 시스템 탭 제외
          if (SYSTEM_TABS.includes(title)) return false;
          // 숨겨진 탭 제외
          if (s.properties.hidden) return false;
          return true;
        });

        if (validTabs.length === 0) continue;

        // 활성 탭만 필터 (마감 탭 + 아카이브 탭 제외)
        // ★ tab_name 매칭 + gid 매칭 (탭 이름 변경 후에도 아카이브 상태 유지)
        const activeTabs = validTabs.filter(t => {
          const key = `${sheetId}||${t.properties.title}`;
          if (archivedSet.has(key)) return false;
          // gid 기반 매칭 (탭 이름이 변경되어도 아카이브 감지)
          const gidStr = String(t.properties.sheetId);
          const gidKey = `${sheetId}||gid:${gidStr}`;
          if (archivedGidSet && archivedGidSet.has(gidKey)) return false;
          return !closedSet.has(key);
        });

        if (activeTabs.length === 0) continue;

        // batchGet으로 한번에 읽기
        const BATCH_CHUNK_SIZE = 50;
        const ranges = activeTabs.map(t => `'${t.properties.title}'!A:Z`);
        let batchResults = [];

        try {
          if (ranges.length <= BATCH_CHUNK_SIZE) {
            batchResults = await throttledCall(() => batchReadSheet(sheetId, ranges));
          } else {
            for (let i = 0; i < ranges.length; i += BATCH_CHUNK_SIZE) {
              const chunkRanges = ranges.slice(i, i + BATCH_CHUNK_SIZE);
              const chunk = await throttledCall(() => batchReadSheet(sheetId, chunkRanges));
              batchResults.push(...chunk);
            }
          }
        } catch (batchErr) {
          // batchGet 실패 → 개별 읽기 폴백 (throttle 적용)
          logger.warn(`[smartBuild] batchGet 실패 (${sheetId.substring(0, 15)}), 개별 읽기 폴백: ${batchErr.message}`);
          batchResults = [];
          for (const tab of activeTabs) {
            try {
              const values = await throttledCall(() => readSheet(sheetId, `'${tab.properties.title}'!A:Z`));
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
              // ★ 인식 실패 탭 기록 (indexBuilder와 동일)
              await _recordUnrecognizedTab(sheetId, tabName, tabGid, spreadsheetTitle, values);
              result.tabsSkipped++;
              continue;
            }

            const modifiedTime = _modifiedTimeCache[sheetId]?.modifiedTime || null;
            await _upsertTab(sheetId, tabName, tabGid, newChecksum, rows, modifiedTime, spreadsheetTitle);

            // ★ 인식 성공 → unrecognized_tabs에서 resolve
            await _resolveRecognizedTab(sheetId, tabName, tabGid);

            // 체크섬 캐시 갱신
            _checksumCache[key] = newChecksum;
            result.tabsUpdated++;

            // ★ round 데이터 디버그 로깅
            const roundCounts = {};
            for (const r of rows) {
              const rv = r.round || '(빈값)';
              roundCounts[rv] = (roundCounts[rv] || 0) + 1;
            }
            const roundSummary = Object.entries(roundCounts).map(([k,v]) => `${k}:${v}`).join(', ');
            logger.info(`[smartBuild] 갱신: ${spreadsheetTitle}/${tabName} — ${rows.length}행 (제출:${rows.filter(r => r.isSubmitted).length}) [차수: ${roundSummary}]`);

          } catch (tabErr) {
            result.errors++;
            result.errorDetails.push({ phase: 'tab', sheetId: sheetId.substring(0, 15), tabName, error: tabErr.message, desc: _translateError(tabErr.message) });
            logger.error(`[smartBuild] 탭 처리 오류 (${tabName}): ${tabErr.message}`);
          }
        }

      } catch (sheetErr) {
        result.errors++;
        result.errorDetails.push({ phase: 'sheet', sheetId: sheetId.substring(0, 15), error: sheetErr.message, desc: _translateError(sheetErr.message) });
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
    result.errorDetails.push({ phase: 'global', error: err.message, desc: _translateError(err.message) });
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
// 캐시 리셋 — DB 초기화 후 전체 재빌드를 위해
// ═══════════════════════════════════════════════════════════

function resetSmartBuildCache() {
  const prev = {
    modifiedTimeEntries: Object.keys(_modifiedTimeCache).length,
    checksumEntries: Object.keys(_checksumCache).length,
  };
  _modifiedTimeCache = {};
  _checksumCache = {};
  _lastRunResult = null;
  // DB의 index_master.checksum도 NULL로 초기화 → 다음 빌드에서 전체 탭 강제 갱신
  pool.query("UPDATE index_master SET checksum = NULL").catch(err => {
    logger.error(`[SmartBuild] DB 체크섬 초기화 실패: ${err.message}`);
  });
  logger.info(`[SmartBuild] 캐시 리셋 완료 — modifiedTime: ${prev.modifiedTimeEntries}→0, checksum: ${prev.checksumEntries}→0, DB checksum→NULL`);
  return prev;
}

// ═══════════════════════════════════════════════════════════
// ★ 인식 실패 탭 기록 (indexBuilder와 동일 로직)
// parseTabRows가 빈 배열을 반환한 탭을 unrecognized_tabs에 기록
// ═══════════════════════════════════════════════════════════

async function _recordUnrecognizedTab(sheetId, tabName, tabGid, campaignName, values) {
  try {
    // 실패 원인 분석
    let reason = 'unknown';
    if (!values || values.length === 0) {
      reason = 'empty';
    } else if (values.length < 2) {
      reason = 'few_rows';
    } else {
      let headerRowIdx = -1;
      for (let i = 0; i < Math.min(values.length, 50); i++) {
        const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
        if (_isDataTabRow(cells)) {
          headerRowIdx = i;
          break;
        }
      }
      if (headerRowIdx < 0) {
        reason = 'no_header';
      } else {
        const headers = values[headerRowIdx].map(h => String(h || '').trim());
        const nameColIdx = headers.findIndex(h =>
          NAME_KEYWORDS.some(k => h.includes(k))
        );
        if (nameColIdx < 0) {
          reason = 'no_name_col';
        } else {
          const dataRows = values.slice(headerRowIdx + 1);
          const hasAnyName = dataRows.some(row => {
            const name = String((row && row[nameColIdx]) || '').trim();
            return name.length > 0;
          });
          reason = hasAnyName ? 'no_name_col' : 'no_data';
        }
      }
    }

    // no_data: 헤더 정상, 데이터 미입력 → 인식 실패가 아니므로 기록 스킵
    if (reason === 'no_data') {
      await pool.query(
        `UPDATE unrecognized_tabs SET status = 'resolved'
         WHERE sheet_id = $1 AND (tab_name = $2 OR tab_gid = $3) AND status = 'pending'`,
        [sheetId, tabName, tabGid]
      );
      return;
    }

    // 첫 55행 샘플
    const sampleRows = (values || []).slice(0, 55).map(row =>
      (row || []).map(c => String(c || '').trim()).slice(0, 15)
    );

    await pool.query(`
      INSERT INTO unrecognized_tabs (sheet_id, tab_name, tab_gid, campaign_name, sample_rows, reason, status, detected_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        campaign_name = EXCLUDED.campaign_name,
        sample_rows = EXCLUDED.sample_rows,
        reason = EXCLUDED.reason,
        status = CASE WHEN unrecognized_tabs.status = 'ignored' THEN 'ignored' ELSE 'pending' END,
        detected_at = NOW()
    `, [sheetId, tabName, tabGid, campaignName, JSON.stringify(sampleRows), reason]);
  } catch (err) {
    logger.warn(`[smartBuild] 인식 실패 탭 기록 오류 (${tabName}): ${err.message}`);
  }
}

// 인식 성공한 탭은 unrecognized_tabs에서 resolve
async function _resolveRecognizedTab(sheetId, tabName, tabGid) {
  try {
    await pool.query(
      `UPDATE unrecognized_tabs SET status = 'resolved' WHERE sheet_id = $1 AND tab_name = $2 AND status = 'pending'`,
      [sheetId, tabName]
    );
    if (tabGid) {
      await pool.query(
        `UPDATE unrecognized_tabs SET status = 'resolved' WHERE sheet_id = $1 AND tab_gid = $2 AND tab_name != $3 AND status = 'pending'`,
        [sheetId, tabGid, tabName]
      );
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════

module.exports = {
  runSmartBuild,
  startSmartBuild,
  stopSmartBuild,
  getSmartBuildStatus,
  resetSmartBuildCache,
  SMART_BUILD_INTERVAL_MS,
};
