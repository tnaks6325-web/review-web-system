const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta, batchReadSheet, getSheetModifiedTime } = require('./sheets.service');
const { computeChecksum } = require('../utils/checksum');
const { logger } = require('../utils/logger');
const { emitIndexBuild } = require('../utils/sse');

// ═══════════════════════════════════════════════════════════
// Phase 14: DB에서 키워드 로드 (하드코딩 폴백)
// ═══════════════════════════════════════════════════════════

// 기본 폴백 상수 (DB 로드 실패 시 사용)
const DEFAULT_SUBMITTED_VALUES = ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'];
const DEFAULT_NAME_KEYWORDS = ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'];
const DEFAULT_SYSTEM_TABS = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정', 'detail', 'config'];
const DEFAULT_DATA_TAB_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];
const DEFAULT_SUBMIT_KEYWORDS = ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출'];

// 빌드 시 DB에서 로드되는 동적 키워드
let SUBMITTED_VALUES = [...DEFAULT_SUBMITTED_VALUES];
let NAME_KEYWORDS = [...DEFAULT_NAME_KEYWORDS];
let SYSTEM_TABS = [...DEFAULT_SYSTEM_TABS];
let DATA_TAB_KEYWORDS = [...DEFAULT_DATA_TAB_KEYWORDS];
let SUBMIT_KEYWORDS = [...DEFAULT_SUBMIT_KEYWORDS];

// DB에서 활성 키워드를 로드하는 함수
async function _loadKeywordsFromDB() {
  try {
    const { rows } = await pool.query(
      "SELECT category, keyword FROM index_keywords WHERE active = TRUE ORDER BY category, keyword"
    );
    if (rows.length === 0) {
      logger.info('[keywords] DB 키워드 없음 → 기본값 사용');
      return;
    }

    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r.keyword);
    });

    DATA_TAB_KEYWORDS = grouped['data_tab'] || [...DEFAULT_DATA_TAB_KEYWORDS];
    NAME_KEYWORDS = grouped['name'] || [...DEFAULT_NAME_KEYWORDS];
    SYSTEM_TABS = grouped['system_tab'] || [...DEFAULT_SYSTEM_TABS];
    SUBMIT_KEYWORDS = grouped['submit'] || [...DEFAULT_SUBMIT_KEYWORDS];

    logger.info(`[keywords] DB 로드 완료: data_tab=${DATA_TAB_KEYWORDS.length}, name=${NAME_KEYWORDS.length}, system=${SYSTEM_TABS.length}, submit=${SUBMIT_KEYWORDS.length}`);
  } catch (err) {
    logger.warn(`[keywords] DB 로드 실패, 기본값 사용: ${err.message}`);
    // 테이블 미존재 등 → 기본값 유지
  }
}

// 빌드 잠금 TTL (10분 — batchGet 병렬 처리로 빨라졌지만 여유 확보)
const BUILD_LOCK_TTL_MS = 10 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
// 빌드 잠금 (기존 로직 유지)
// ═══════════════════════════════════════════════════════════

async function acquireBuildLock(lockedBy = 'system') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT * FROM build_locks WHERE lock_key = 'INDEX_BUILD' FOR UPDATE"
    );

    if (rows.length === 0) {
      await client.query(
        "INSERT INTO build_locks (lock_key, locked_at, locked_by, is_locked) VALUES ('INDEX_BUILD', NOW(), $1, TRUE)",
        [lockedBy]
      );
      await client.query('COMMIT');
      return { acquired: true };
    }

    const lock = rows[0];
    if (lock.is_locked) {
      const elapsed = lock.locked_at ? Date.now() - new Date(lock.locked_at).getTime() : Infinity;
      if (elapsed < BUILD_LOCK_TTL_MS) {
        await client.query('COMMIT');
        return { acquired: false, message: '타 사용자가 갱신중입니다.', elapsedMs: elapsed };
      }
      logger.warn(`[buildLock] 좀비 잠금 해제 (${Math.round(elapsed / 1000)}초 경과)`);
    }

    await client.query(
      "UPDATE build_locks SET is_locked = TRUE, locked_at = NOW(), locked_by = $1 WHERE lock_key = 'INDEX_BUILD'",
      [lockedBy]
    );
    await client.query('COMMIT');
    return { acquired: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function releaseBuildLock() {
  await pool.query(
    "UPDATE build_locks SET is_locked = FALSE, locked_at = NULL, locked_by = NULL WHERE lock_key = 'INDEX_BUILD'"
  );
}

// ═══════════════════════════════════════════════════════════
// ★ Phase 1 핵심: 최적화된 스마트 인덱스 빌드
//
// 변경점 요약:
//   1. Drive API로 시트 수정시각 확인 → 변경 없는 시트 전체 스킵
//   2. 같은 시트의 모든 탭을 batchGet 1회로 읽기 (106회 → 8회 API)
//   3. 시트 간 병렬 처리 (Promise.allSettled)
//   4. 시간 가드 10분으로 확장 (batchGet 병렬이므로 충분)
// ═══════════════════════════════════════════════════════════

async function buildIndexSmart(forceFullRebuild = false) {
  const startTime = Date.now();
  let rebuilt = 0, skipped = 0, errors = 0;
  const buildLog = []; // 시트별 처리 로그

  // 빌드 잠금 획득
  const lockResult = await acquireBuildLock('buildIndexSmart');
  if (!lockResult.acquired) {
    return { ok: false, error: '타 사용자가 갱신중입니다. 잠시 후 다시 시도해주세요.', locked: true };
  }

  try {
    // ── 0단계: DB에서 키워드 로드 ──
    await _loadKeywordsFromDB();

    // ── 1단계: 시트 ID 목록 수집 ──
    const { rows: campaignRows } = await pool.query(
      'SELECT DISTINCT sheet_id FROM campaigns UNION SELECT DISTINCT sheet_id FROM tab_configs'
    );
    const sheetIds = [...new Set([
      process.env.BASE_SHEET_ID,
      ...campaignRows.map(r => r.sheet_id)
    ])].filter(Boolean);

    logger.info(`[buildIndex] 시작: ${sheetIds.length}개 시트, forceFullRebuild=${forceFullRebuild}`);

    // ── 2단계: DB에서 기존 데이터 로드 (1회 쿼리) ──
    const { rows: masterRows } = await pool.query(
      'SELECT sheet_id, tab_name, checksum, sheet_modified_at FROM index_master'
    );
    const checksumMap = {};
    const sheetModifiedMap = {}; // sheet_id → 마지막으로 기록한 수정시각
    masterRows.forEach(r => {
      checksumMap[`${r.sheet_id}||${r.tab_name}`] = r.checksum;
      if (r.sheet_modified_at) {
        const existing = sheetModifiedMap[r.sheet_id];
        const current = new Date(r.sheet_modified_at).getTime();
        if (!existing || current > existing) {
          sheetModifiedMap[r.sheet_id] = current;
        }
      }
    });

    const { rows: tcRows } = await pool.query(
      'SELECT sheet_id, tab_name, force_done, is_closed FROM tab_configs'
    );
    const tcMap = {};
    tcRows.forEach(r => { tcMap[`${r.sheet_id}||${r.tab_name}`] = r; });

    // ── 2.5단계: 아카이브된 탭 목록 로드 ──
    // 아카이브된 탭은 인덱스 빌드에서 완전히 제외
    const { rows: archivedRows } = await pool.query(
      'SELECT sheet_id, tab_name FROM index_master_archive'
    );
    const archivedSet = new Set();
    const archivedSheetCounts = {}; // sheetId → 아카이브된 탭 수
    archivedRows.forEach(r => {
      archivedSet.add(`${r.sheet_id}||${r.tab_name}`);
      archivedSheetCounts[r.sheet_id] = (archivedSheetCounts[r.sheet_id] || 0) + 1;
    });

    logger.info(`[buildIndex] 아카이브된 탭: ${archivedRows.length}개 (${Object.keys(archivedSheetCounts).length}개 시트)`);

    // ── 3단계: 시트별 병렬 처리 ──
    // 각 시트를 독립적으로 처리하고 결과를 모음
    const sheetResults = await Promise.allSettled(
      sheetIds.map(sheetId => _processOneSheet(sheetId, {
        forceFullRebuild,
        checksumMap,
        sheetModifiedMap,
        tcMap,
        archivedSet,
        startTime,
      }))
    );

    // ── 4단계: 결과 집계 ──
    for (let i = 0; i < sheetResults.length; i++) {
      const result = sheetResults[i];
      const sheetId = sheetIds[i];

      if (result.status === 'fulfilled') {
        const r = result.value;
        rebuilt += r.rebuilt;
        skipped += r.skipped;
        errors += r.errors;
        buildLog.push({
          sheetId: sheetId.substring(0, 15) + '...',
          ...r,
          elapsed: r.elapsed,
        });

        if (r.skippedReason === 'not_modified') {
          logger.info(`[buildIndex] 시트 ${sheetId.substring(0, 15)}... → 변경 없음 (Drive API 확인)`);
        } else {
          logger.info(`[buildIndex] 시트 ${sheetId.substring(0, 15)}... → rebuilt=${r.rebuilt}, skipped=${r.skipped}, errors=${r.errors}, ${r.elapsed}ms`);
        }
      } else {
        errors++;
        const errMsg = result.reason?.message || String(result.reason);
        logger.error(`[buildIndex] 시트 ${sheetId.substring(0, 15)}... 처리 실패: ${errMsg}`);
        buildLog.push({
          sheetId: sheetId.substring(0, 15) + '...',
          error: errMsg,
        });
      }
    }
  } catch (err) {
    logger.error(`[buildIndex] 전체 오류: ${err.message}`);
    throw err;
  } finally {
    await releaseBuildLock();
  }

  const elapsed = Date.now() - startTime;
  const result = {
    ok: true,
    rebuilt,
    skipped,
    errors,
    total: rebuilt + skipped + errors,
    elapsed: `${elapsed}ms`,
    builtAt: new Date().toISOString(),
    buildLog,
  };

  // 빌드 히스토리 기록 (실패해도 무시)
  try {
    await pool.query(`
      INSERT INTO build_history (elapsed_ms, rebuilt, skipped, errors, total, trigger_by, build_log)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [elapsed, rebuilt, skipped, errors, rebuilt + skipped + errors,
        forceFullRebuild ? 'manual_full' : 'manual', JSON.stringify(buildLog)]);
  } catch (_) {}

  logger.info(`[buildIndex] 완료: rebuilt=${rebuilt}, skipped=${skipped}, errors=${errors}, ${elapsed}ms`);

  // ── SSE 알림: 인덱스 빌드 완료 ──
  emitIndexBuild({
    rebuilt,
    skipped,
    errors,
    total: rebuilt + skipped + errors,
    elapsed: `${elapsed}ms`,
    trigger: forceFullRebuild ? 'full' : 'smart',
  });

  return result;
}

// ═══════════════════════════════════════════════════════════
// ★ 시트 1개 처리 (병렬 실행 단위)
//
// 흐름:
//   1. Drive API로 수정시각 확인 → 변경 없으면 전체 스킵
//   2. 시트 메타 조회 → 유효 탭 목록 추출
//   3. batchGet으로 모든 탭 데이터 한번에 읽기
//   4. 탭별 체크섬 비교 → 변경된 탭만 DB 업데이트
// ═══════════════════════════════════════════════════════════

async function _processOneSheet(sheetId, opts) {
  const { forceFullRebuild, checksumMap, sheetModifiedMap, tcMap, archivedSet, startTime } = opts;
  const sheetStart = Date.now();
  let rebuilt = 0, skipped = 0, errors = 0;

  // ── Step 1: Drive API 변경감지 (forceFullRebuild 시 스킵) ──
  if (!forceFullRebuild) {
    try {
      const modifiedTime = await getSheetModifiedTime(sheetId);
      if (modifiedTime) {
        const remoteModified = new Date(modifiedTime).getTime();
        const lastKnown = sheetModifiedMap[sheetId] || 0;

        if (lastKnown > 0 && remoteModified <= lastKnown) {
          // 수정시각이 변하지 않음 → 이 시트의 모든 탭 스킵
          return {
            rebuilt: 0, skipped: 0, errors: 0,
            elapsed: Date.now() - sheetStart,
            skippedReason: 'not_modified',
            modifiedTime,
          };
        }
      }
    } catch (err) {
      // Drive API 실패 시 → 안전하게 진행 (변경 가정)
      logger.warn(`[buildIndex] Drive 변경감지 실패 (${sheetId.substring(0, 15)}): ${err.message}`);
    }
  }

  // ── Step 2: 시트 메타 조회 → 유효 탭 목록 ──
  const meta = await getSpreadsheetMeta(sheetId);
  const spreadsheetTitle = meta._spreadsheetTitle || sheetId; // 스프레드시트 제목 (캠페인명)
  const validTabs = meta.filter(s => !SYSTEM_TABS.includes(s.properties.title));

  if (validTabs.length === 0) {
    return { rebuilt: 0, skipped: 0, errors: 0, elapsed: Date.now() - sheetStart };
  }

  // force_done/is_closed/아카이브 탭 필터링
  const activeTabs = validTabs.filter(t => {
    const key = `${sheetId}||${t.properties.title}`;
    // 아카이브된 탭은 완전히 스킵
    if (archivedSet.has(key)) {
      skipped++;
      return false;
    }
    const tc = tcMap[key];
    if (tc && (tc.force_done || tc.is_closed)) {
      skipped++;
      return false;
    }
    return true;
  });

  if (activeTabs.length === 0) {
    return { rebuilt: 0, skipped, errors: 0, elapsed: Date.now() - sheetStart };
  }

  // ── Step 3: batchGet으로 모든 활성 탭 데이터 한번에 읽기 ──
  // 하나의 API 호출로 N개 탭의 데이터를 모두 가져옴
  const ranges = activeTabs.map(t => `'${t.properties.title}'!A:Z`);
  let batchResults;

  try {
    batchResults = await batchReadSheet(sheetId, ranges);
  } catch (err) {
    // batchGet 실패 시 → 개별 readSheet로 폴백 (안전장치)
    logger.warn(`[buildIndex] batchGet 실패 (${sheetId.substring(0, 15)}), 개별 읽기로 폴백: ${err.message}`);
    batchResults = [];
    for (const tab of activeTabs) {
      try {
        const values = await readSheet(sheetId, `'${tab.properties.title}'!A:Z`);
        batchResults.push({ values: values || [] });
      } catch (readErr) {
        batchResults.push({ values: [], error: readErr.message });
        logger.error(`[buildIndex] 탭 읽기 실패 (${tab.properties.title}): ${readErr.message}`);
      }
    }
  }

  // ── Step 4: 탭별 체크섬 비교 + DB 업데이트 ──
  // Drive API에서 가져온 수정시각 (모든 탭 공통)
  let currentModifiedTime = null;
  try {
    currentModifiedTime = await getSheetModifiedTime(sheetId);
  } catch (_) {}

  for (let i = 0; i < activeTabs.length; i++) {
    const tab = activeTabs[i];
    const tabName = tab.properties.title;
    const tabGid = String(tab.properties.sheetId);
    const key = `${sheetId}||${tabName}`;

    // 시간 가드 (10분)
    if (Date.now() - startTime > 10 * 60 * 1000) {
      logger.warn(`[buildIndex] 시간 초과 — 나머지 탭 다음 빌드에서 처리`);
      break;
    }

    try {
      // batchGet 결과에서 해당 탭의 데이터 추출
      const batchItem = batchResults[i];
      const values = batchItem?.values || batchItem?.data?.values || [];

      if (!values || values.length < 2) {
        skipped++;
        continue;
      }

      // 체크섬 비교
      const newChecksum = computeChecksum(values);
      if (!forceFullRebuild && checksumMap[key] === newChecksum) {
        skipped++;
        continue;
      }

      // 헤더 파싱 + DB 업데이트
      const rows = parseTabRows(values, sheetId, tabName, tabGid, spreadsheetTitle);

      // 리뷰 인덱스 구성요건 미충족 (헤더 없음 or 데이터 0건) → 인덱스 등록 스킵 + 기존 데이터 삭제
      if (rows.length === 0) {
        await _removeNonIndexTab(sheetId, tabName);
        // Phase 14: 인식 실패 탭을 unrecognized_tabs에 기록
        await _recordUnrecognizedTab(sheetId, tabName, tabGid, spreadsheetTitle, values);
        skipped++;
        continue;
      }

      await _upsertTabIndex(sheetId, tabName, tabGid, newChecksum, rows, currentModifiedTime, spreadsheetTitle);
      await _resolveRecognizedTab(sheetId, tabName);
      rebuilt++;

    } catch (err) {
      logger.error(`[buildIndex] 탭 처리 오류 (${tabName}): ${err.message}`);
      // index_master에 에러 기록
      try {
        await pool.query(`
          INSERT INTO index_master (sheet_id, tab_name, status, error_msg)
          VALUES ($1, $2, 'error', $3)
          ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
            status = 'error', error_msg = $3
        `, [sheetId, tabName, err.message]);
      } catch (_) {}
      errors++;
    }
  }

  return { rebuilt, skipped, errors, elapsed: Date.now() - sheetStart };
}

// ═══════════════════════════════════════════════════════════
// 리뷰 인덱스 구성요건 미충족 탭 정리
// 헤더가 없거나 데이터가 0건인 탭 → index_master + review_index에서 삭제
// ═══════════════════════════════════════════════════════════

async function _removeNonIndexTab(sheetId, tabName) {
  try {
    const { rowCount: masterDeleted } = await pool.query(
      'DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );
    const { rowCount: indexDeleted } = await pool.query(
      'DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );
    if (masterDeleted > 0 || indexDeleted > 0) {
      logger.info(`[buildIndex] 비인덱스 탭 정리: ${tabName} (master:${masterDeleted}, index:${indexDeleted})`);
    }
  } catch (err) {
    logger.warn(`[buildIndex] 비인덱스 탭 정리 실패 (${tabName}): ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// DB 업데이트 (트랜잭션) — 기존 로직 그대로 유지
// ═══════════════════════════════════════════════════════════

async function _upsertTabIndex(sheetId, tabName, tabGid, checksum, rows, modifiedTime, campaignName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 기존 탭 데이터 삭제
    await client.query(
      'DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );

    // 새 데이터 삽입 (배치)
    if (rows.length > 0) {
      const BATCH_SIZE = 100;
      for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
        const batch = rows.slice(batchStart, batchStart + BATCH_SIZE);
        const insertValues = [];
        const insertPlaceholders = [];
        let paramIdx = 1;

        for (const row of batch) {
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
        `, insertValues);
      }
    }

    // index_master 체크섬 + 수정시각 업데이트
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
    // index_master에 에러 기록
    await pool.query(`
      INSERT INTO index_master (sheet_id, tab_name, status, error_msg)
      VALUES ($1, $2, 'error', $3)
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        status = 'error', error_msg = $3
    `, [sheetId, tabName, err.message]);
    throw err;
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════
// 탭 데이터 파싱 (기존 로직 100% 유지)
// ═══════════════════════════════════════════════════════════

function parseTabRows(values, sheetId, tabName, tabGid, campaignTitle) {
  const HEADER_SCAN_LIMIT = 50; // Phase 14: 20→50 확대 (32행 등 깊은 헤더 대응)
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(values.length, HEADER_SCAN_LIMIT); i++) {
    const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
    if (_isDataTabRow(cells)) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) return [];
  if (headerRowIdx >= 20) {
    logger.info(`[parseTabRows] 깊은 헤더 발견 — tab=${tabName} row=${headerRowIdx}`);
  }

  const headers = values[headerRowIdx].map(h => String(h || '').trim());
  const dataRows = values.slice(headerRowIdx + 1);

  const nameColIdx = headers.findIndex(h =>
    NAME_KEYWORDS.some(k => h.includes(k))
  );
  if (nameColIdx < 0) {
    logger.warn(`[parseTabRows] 이름 컬럼 미발견 — tab=${tabName} headerRow=${headerRowIdx} headers=${JSON.stringify(headers.slice(0, 20))} NAME_KEYWORDS=${JSON.stringify(NAME_KEYWORDS)}`);
    return [];
  }

  const submitKeywords = SUBMIT_KEYWORDS;
  const submitColIdx = headers.findIndex(h =>
    submitKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  const productKeywords = ['상품명', '제품명', '상품', 'product'];
  const productColIdx = headers.findIndex(h =>
    productKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  const urlKeywords = ['상품url', '제품url', '상품링크', 'url', '링크'];
  const urlColIdx = headers.findIndex(h =>
    urlKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  const phoneKeywords = ['연락처', '전화번호', '핸드폰', '휴대폰', 'phone'];
  const phoneColIdx = headers.findIndex(h =>
    phoneKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  const startDateKeywords = ['시작일', '구매일', '주문일', '배정일'];
  const endDateKeywords = ['종료일', '마감일', '완료일', '제출마감'];
  const startDateIdx = headers.findIndex(h =>
    startDateKeywords.some(k => h.includes(k))
  );
  const endDateIdx = headers.findIndex(h =>
    endDateKeywords.some(k => h.includes(k))
  );

  const roundKeywords = ['회차', '차수', 'round'];
  const roundIdx = headers.findIndex(h =>
    roundKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  return dataRows
    .map((row, i) => {
      const name = String(row[nameColIdx] || '').trim();
      if (!name) return null;

      const submitVal = submitColIdx >= 0 ? String(row[submitColIdx] || '').trim() : '';
      const isSubmitted = SUBMITTED_VALUES.includes(submitVal);

      let phone8 = null;
      if (phoneColIdx >= 0) {
        const phoneRaw = String(row[phoneColIdx] || '').replace(/[^0-9]/g, '');
        if (phoneRaw.length >= 8) {
          phone8 = phoneRaw.slice(-8);
        }
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

function _isDataTabRow(cells) {
  // 옵션B: 최소 2개 이상의 DATA_TAB_KEYWORDS가 매칭되어야 헤더로 인정
  let matchCount = 0;
  for (const kw of DATA_TAB_KEYWORDS) {
    const found = kw === '번호'
      ? cells.includes(kw)
      : cells.some(c => c.includes(kw));
    if (found) {
      matchCount++;
      if (matchCount >= 2) return true;  // 2개 이상이면 즉시 반환
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

// ═══════════════════════════════════════════════════════════
// Phase 14: 인식 실패 탭 기록
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
      // 헤더 행 탐지 시도
      let headerFound = false;
      for (let i = 0; i < Math.min(values.length, 50); i++) {
        const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
        if (_isDataTabRow(cells)) {
          headerFound = true;
          break;
        }
      }
      if (!headerFound) {
        reason = 'no_header';
      } else {
        reason = 'no_name_col';
      }
    }

    // 첫 55행 샘플 (분석용 — 50행 헤더 + 데이터 5행)
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
    // 기록 실패는 무시 (빌드 중단 방지)
    logger.warn(`[buildIndex] 인식 실패 탭 기록 오류 (${tabName}): ${err.message}`);
  }
}

// 인식 성공한 탭은 unrecognized_tabs에서 제거 (해결됨)
async function _resolveRecognizedTab(sheetId, tabName) {
  try {
    await pool.query(
      `UPDATE unrecognized_tabs SET status = 'resolved' WHERE sheet_id = $1 AND tab_name = $2 AND status = 'pending'`,
      [sheetId, tabName]
    );
  } catch (_) {}
}

module.exports = { buildIndexSmart, acquireBuildLock, releaseBuildLock };
