const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta, batchReadSheet, getSheetModifiedTime } = require('./sheets.service');
const { computeChecksum } = require('../utils/checksum');
const { logger } = require('../utils/logger');
const { emitIndexBuild } = require('../utils/sse');
const { throttledCall, throttledMap, getThrottleStatus } = require('../utils/sheetsThrottle');

// ═══════════════════════════════════════════════════════════
// Phase 14: DB에서 키워드 로드 (하드코딩 폴백)
// ═══════════════════════════════════════════════════════════

// 기본 폴백 상수 (DB 로드 실패 시 사용)
const DEFAULT_SUBMITTED_VALUES = ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'];
const DEFAULT_NAME_KEYWORDS = ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'];
const DEFAULT_SYSTEM_TABS = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정', 'detail', 'config'];
const DEFAULT_DATA_TAB_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];
const DEFAULT_SUBMIT_KEYWORDS = ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰'];

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

    // ── 0.5단계: 마감 탭 인덱스 데이터 → 아카이브 이동 ──
    try {
      const { rows: closedTabs } = await pool.query(
        `SELECT tc.sheet_id, tc.tab_name, tc.tab_gid, tc.campaign_name FROM tab_configs tc
         WHERE tc.is_closed = TRUE
         AND EXISTS (SELECT 1 FROM review_index ri WHERE ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name)`
      );
      if (closedTabs.length > 0) {
        let archivedReview = 0, archivedMaster = 0;
        for (const t of closedTabs) {
          // index_master → index_master_archive
          const { rows: masterRows } = await pool.query(
            'SELECT * FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
            [t.sheet_id, t.tab_name]
          );
          if (masterRows.length > 0) {
            const mr = masterRows[0];
            await pool.query(`
              INSERT INTO index_master_archive
                (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count,
                 last_date, checksum, built_at, status, skip_reason, error_msg,
                 sheet_modified_at, archived_by, archive_reason)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'archived',$10,$11,$12,$13,$14)
              ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
                row_count = EXCLUDED.row_count, submitted_count = EXCLUDED.submitted_count,
                checksum = EXCLUDED.checksum, built_at = EXCLUDED.built_at,
                archived_at = NOW(), archived_by = EXCLUDED.archived_by,
                archive_reason = EXCLUDED.archive_reason
            `, [
              mr.sheet_id, mr.tab_name, mr.tab_gid, mr.campaign_name,
              mr.row_count, mr.submitted_count, mr.last_date, mr.checksum,
              mr.built_at, mr.skip_reason, mr.error_msg, mr.sheet_modified_at,
              'system-build', 'auto-clean-closed',
            ]);
            archivedMaster++;
          }
          // review_index → review_index_archive
          const { rowCount: reviewCount } = await pool.query(`
            INSERT INTO review_index_archive
              (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
               row_index, is_submitted, is_submitted2, product_url, product_name,
               submit_col, submit_col2, row_json, start_date, end_date,
               round, phone8, built_at, archived_at)
            SELECT
              reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
              row_index, is_submitted, is_submitted2, product_url, product_name,
              submit_col, submit_col2, row_json, start_date, end_date,
              round, phone8, built_at, NOW()
            FROM review_index
            WHERE sheet_id = $1 AND tab_name = $2
          `, [t.sheet_id, t.tab_name]);
          archivedReview += reviewCount;
          // 원본 삭제
          await pool.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [t.sheet_id, t.tab_name]);
          await pool.query('DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2', [t.sheet_id, t.tab_name]);
          // tab_configs도 삭제 (아카이브 완료)
          await pool.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2', [t.sheet_id, t.tab_name]);
        }
        logger.info(`[buildIndex] 마감 탭 아카이브: ${closedTabs.length}개 탭, review_index ${archivedReview}행, index_master ${archivedMaster}행 이동`);
      }
    } catch (cleanErr) {
      logger.warn(`[buildIndex] 마감 탭 아카이브 실패 (계속 진행): ${cleanErr.message}`);
    }
    // ★ 키워드 중복 로드 제거 (0단계에서 이미 로드됨)

    // ── 0-1단계: 기존 no_data pending 레코드 일괄 resolved 처리 ──
    // no_data = 헤더 구조 정상이지만 데이터 미입력 (진행 중인 탭) → 인식 실패가 아님
    try {
      const { rowCount } = await pool.query(
        `UPDATE unrecognized_tabs SET status = 'resolved' WHERE reason = 'no_data' AND status = 'pending'`
      );
      if (rowCount > 0) {
        logger.info(`[buildIndex] no_data pending ${rowCount}건 → resolved 처리`);
      }
    } catch (_) {}

    // ── 1단계: 시트 ID 목록 수집 (DB 전용 — 베이스시트 의존 제거) ──
    const { rows: campaignRows } = await pool.query(
      'SELECT DISTINCT sheet_id FROM campaigns UNION SELECT DISTINCT sheet_id FROM tab_configs'
    );
    const sheetIds = [...new Set(
      campaignRows.map(r => r.sheet_id)
    )].filter(Boolean);

    logger.info(`[buildIndex] 시작: ${sheetIds.length}개 시트 (DB 기반), forceFullRebuild=${forceFullRebuild}`);

    // ── 2단계: DB에서 기존 데이터 로드 (1회 쿼리) ──
    const { rows: masterRows } = await pool.query(
      'SELECT sheet_id, tab_name, tab_gid, checksum, sheet_modified_at FROM index_master'
    );
    const checksumMap = {};
    const sheetModifiedMap = {}; // sheet_id → 마지막으로 기록한 수정시각
    // ★ GID→탭명 매핑: 탭 이름 변경 감지용
    const gidToNameMap = {}; // "sheetId||gid" → tab_name (기존 DB 이름)
    masterRows.forEach(r => {
      checksumMap[`${r.sheet_id}||${r.tab_name}`] = r.checksum;
      if (r.tab_gid) {
        gidToNameMap[`${r.sheet_id}||${r.tab_gid}`] = r.tab_name;
      }
      if (r.sheet_modified_at) {
        const existing = sheetModifiedMap[r.sheet_id];
        const current = new Date(r.sheet_modified_at).getTime();
        if (!existing || current > existing) {
          sheetModifiedMap[r.sheet_id] = current;
        }
      }
    });

    const { rows: tcRows } = await pool.query(
      'SELECT sheet_id, tab_name, is_closed FROM tab_configs'
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

    // ── 3단계: 시트별 처리 (throttle 적용 — quota 초과 방지) ──
    // 동시 3개씩 + API 호출 간 최소 1.2초 간격 유지
    logger.info(`[buildIndex] throttle 상태: ${JSON.stringify(getThrottleStatus())}`);
    const sheetResults = await throttledMap(
      sheetIds,
      (sheetId) => _processOneSheet(sheetId, {
        forceFullRebuild,
        checksumMap,
        sheetModifiedMap,
        tcMap,
        archivedSet,
        gidToNameMap,
        startTime,
      }),
      3 // 동시 3개 시트 처리
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

  // ── Post-build: no_name_col 탭 재검증 ──
  // batchGet 인덱스 불일치 등으로 잘못 분류된 탭을 개별 readSheet로 재확인
  const postBuildLog = [];
  try {
    const { rows: noNameColTabs } = await pool.query(
      "SELECT sheet_id, tab_name, tab_gid, campaign_name FROM unrecognized_tabs WHERE status = 'pending' AND reason = 'no_name_col'"
    );
    if (noNameColTabs.length > 0) {
      logger.info(`[buildIndex] post-build 검증: no_name_col ${noNameColTabs.length}건 재확인`);
      let resolvedCount = 0;
      for (const tab of noNameColTabs) {
        try {
          const values = await throttledCall(() => readSheet(tab.sheet_id, `'${tab.tab_name}'!A:Z`));
          const valLen = values ? values.length : 0;
          const valCols = values && values.length > 0 ? values[0].length : 0;
          const logEntry = { tab: tab.tab_name, valLen, valCols };
          postBuildLog.push(logEntry);
          if (values && values.length >= 2) {
            // 디버그: parseTabRows 호출 전 헤더 탐지 결과 로깅
            let debugHeaderIdx = -1;
            for (let di = 0; di < Math.min(values.length, 50); di++) {
              const dc = values[di] ? values[di].map(c => String(c || '').trim()) : [];
              if (_isDataTabRow(dc)) { debugHeaderIdx = di; break; }
            }
            logEntry.debugHeaderIdx = debugHeaderIdx;
            if (debugHeaderIdx >= 0) {
              const dh = values[debugHeaderIdx].map(h => String(h || '').trim());
              logEntry.debugHeaders = dh.slice(0, 20);
              const dNameIdx = dh.findIndex(h => NAME_KEYWORDS.some(k => h.includes(k)));
              logEntry.debugNameColIdx = dNameIdx;
              if (dNameIdx >= 0) {
                logEntry.debugNameHeader = dh[dNameIdx];
                logEntry.debugNameKeyword = NAME_KEYWORDS.find(k => dh[dNameIdx].includes(k));
              }
              logEntry.NAME_KEYWORDS_count = NAME_KEYWORDS.length;
            }

            const rows = parseTabRows(values, tab.sheet_id, tab.tab_name, tab.tab_gid, tab.campaign_name);
            logEntry.parsedRows = rows.length;
            if (rows.length > 0) {
              // 성공! review_index에 upsert + unrecognized에서 resolve
              const checksum = computeChecksum(values);
              await _upsertTabIndex(tab.sheet_id, tab.tab_name, tab.tab_gid, checksum, rows, null, tab.campaign_name);
              await _resolveRecognizedTab(tab.sheet_id, tab.tab_name, tab.tab_gid);
              resolvedCount++;
              logEntry.resolved = true;
              logger.info(`[buildIndex] post-build 해결: ${tab.tab_name} (${rows.length}행)`);
            } else {
              logger.warn(`[buildIndex] post-build 여전히 실패: ${tab.tab_name} headerIdx=${debugHeaderIdx} nameColIdx=${logEntry.debugNameColIdx} headers=${JSON.stringify((logEntry.debugHeaders || []).slice(0, 10))}`);
            }
          }
        } catch (err) {
          postBuildLog.push({ tab: tab.tab_name, error: err.message });
          logger.warn(`[buildIndex] post-build 검증 실패 (${tab.tab_name}): ${err.message}`);
        }
      }
      if (resolvedCount > 0) {
        logger.info(`[buildIndex] post-build 결과: ${resolvedCount}/${noNameColTabs.length}건 해결`);
        rebuilt += resolvedCount;
      }
    }
  } catch (err) {
    logger.warn(`[buildIndex] post-build 검증 오류: ${err.message}`);
  }

  // post-build 결과를 build_history에 별도 칼럼으로는 없으므로 로그로 남김
  if (postBuildLog.length > 0) {
    logger.info(`[buildIndex] post-build 상세: ${JSON.stringify(postBuildLog)}`);
    try {
      // trigger_by에 결과 요약 추가
      const summary = `post:${postBuildLog.length}tabs,resolved:${postBuildLog.filter(l => l.resolved).length}`;
      await pool.query(
        "UPDATE build_history SET trigger_by = trigger_by || ' | ' || $1 WHERE id = (SELECT id FROM build_history ORDER BY started_at DESC LIMIT 1)",
        [summary]
      );
    } catch (_) {}
  }

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
  const { forceFullRebuild, checksumMap, sheetModifiedMap, tcMap, archivedSet, gidToNameMap, startTime } = opts;
  const sheetStart = Date.now();
  let rebuilt = 0, skipped = 0, errors = 0;

  // ── Step 1: Drive API 변경감지 (forceFullRebuild 시 스킵) ──
  // ★ modifiedTime을 캐시하여 Step 4에서 재사용 (중복 API 호출 제거)
  let cachedModifiedTime = null;
  if (!forceFullRebuild) {
    try {
      cachedModifiedTime = await throttledCall(() => getSheetModifiedTime(sheetId));
      if (cachedModifiedTime) {
        const remoteModified = new Date(cachedModifiedTime).getTime();
        const lastKnown = sheetModifiedMap[sheetId] || 0;

        if (lastKnown > 0 && remoteModified <= lastKnown) {
          // 수정시각이 변하지 않음 → 이 시트의 모든 탭 스킵
          return {
            rebuilt: 0, skipped: 0, errors: 0,
            elapsed: Date.now() - sheetStart,
            skippedReason: 'not_modified',
            modifiedTime: cachedModifiedTime,
          };
        }
      }
    } catch (err) {
      // Drive API 실패 시 → 안전하게 진행 (변경 가정)
      logger.warn(`[buildIndex] Drive 변경감지 실패 (${sheetId.substring(0, 15)}): ${err.message}`);
    }
  }

  // ── Step 2: 시트 메타 조회 → 유효 탭 목록 (throttle 적용) ──
  const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
  const spreadsheetTitle = meta._spreadsheetTitle || sheetId; // 스프레드시트 제목 (캠페인명)
  const validTabs = meta.filter(s => !SYSTEM_TABS.includes(s.properties.title));

  if (validTabs.length === 0) {
    return { rebuilt: 0, skipped: 0, errors: 0, elapsed: Date.now() - sheetStart };
  }

  // is_closed/아카이브 탭 필터링
  const activeTabs = validTabs.filter(t => {
    const key = `${sheetId}||${t.properties.title}`;
    // 아카이브된 탭은 완전히 스킵
    if (archivedSet.has(key)) {
      skipped++;
      return false;
    }
    const tc = tcMap[key];
    if (tc && tc.is_closed) {
      skipped++;
      return false;
    }
    return true;
  });

  if (activeTabs.length === 0) {
    return { rebuilt: 0, skipped, errors: 0, elapsed: Date.now() - sheetStart };
  }

  // ── Step 3: batchGet으로 모든 활성 탭 데이터 한번에 읽기 ──
  // Google Sheets API batchGet은 대량 범위 요청 시 실패할 수 있으므로 청크 단위로 분할
  const BATCH_CHUNK_SIZE = 50; // Google API 안전 범위: 50개씩
  const ranges = activeTabs.map(t => `'${t.properties.title}'!A:Z`);
  let batchResults = [];

  try {
    if (ranges.length <= BATCH_CHUNK_SIZE) {
      batchResults = await throttledCall(() => batchReadSheet(sheetId, ranges));
    } else {
      // 대량 탭 시트: 청크로 분할하여 batchGet (각 청크마다 throttle)
      logger.info(`[buildIndex] 대량 탭 (${ranges.length}개) — ${BATCH_CHUNK_SIZE}개씩 분할 batchGet`);
      for (let chunkStart = 0; chunkStart < ranges.length; chunkStart += BATCH_CHUNK_SIZE) {
        const chunkRanges = ranges.slice(chunkStart, chunkStart + BATCH_CHUNK_SIZE);
        const chunkResult = await throttledCall(() => batchReadSheet(sheetId, chunkRanges));
        batchResults.push(...chunkResult);
      }
    }
    // batchResults 길이 검증: activeTabs과 동일해야 함
    if (batchResults.length !== activeTabs.length) {
      logger.warn(`[buildIndex] batchResults 길이 불일치: expected=${activeTabs.length}, got=${batchResults.length} — 개별 읽기로 폴백`);
      throw new Error(`batchResults length mismatch: ${batchResults.length} vs ${activeTabs.length}`);
    }
  } catch (err) {
    // batchGet 실패 시 → 개별 readSheet로 폴백 (안전장치)
    logger.warn(`[buildIndex] batchGet 실패 (${sheetId.substring(0, 15)}), 개별 읽기로 폴백: ${err.message}`);
    batchResults = [];
    for (const tab of activeTabs) {
      try {
        const values = await throttledCall(() => readSheet(sheetId, `'${tab.properties.title}'!A:Z`));
        batchResults.push({ values: values || [] });
      } catch (readErr) {
        batchResults.push({ values: [], error: readErr.message });
        logger.error(`[buildIndex] 탭 읽기 실패 (${tab.properties.title}): ${readErr.message}`);
      }
    }
  }

  // ── Step 4: 탭별 체크섬 비교 + DB 업데이트 ──
  // ★ Step 1에서 캐시한 modifiedTime 재사용 (중복 Drive API 호출 제거)
  const currentModifiedTime = cachedModifiedTime || null;

  for (let i = 0; i < activeTabs.length; i++) {
    const tab = activeTabs[i];
    const tabName = tab.properties.title;
    const tabGid = String(tab.properties.sheetId);
    const key = `${sheetId}||${tabName}`;

    // ★ 탭 이름 변경 감지: 같은 GID인데 DB에 다른 이름으로 저장된 경우
    // v11.8.3: DELETE→재빌드 대신 UPDATE로 변경 — review_index 데이터 보존
    const gidKey = `${sheetId}||${tabGid}`;
    const oldTabName = gidToNameMap ? gidToNameMap[gidKey] : null;
    if (oldTabName && oldTabName !== tabName) {
      logger.info(`[buildIndex] 탭 이름 변경 감지: "${oldTabName}" → "${tabName}" (gid=${tabGid}, sheet=${sheetId.substring(0, 15)})`);
      try {
        // ── review_index: 리뷰어 데이터 보존하면서 탭명만 UPDATE ──
        const riResult = await pool.query(
          'UPDATE review_index SET tab_name = $1 WHERE sheet_id = $2 AND tab_name = $3',
          [tabName, sheetId, oldTabName]
        );
        // ── index_master: 탭명 + tab_gid UPDATE (행 보존) ──
        const imResult = await pool.query(
          'UPDATE index_master SET tab_name = $1, tab_gid = $2 WHERE sheet_id = $3 AND tab_name = $4',
          [tabName, tabGid, sheetId, oldTabName]
        );
        // ── tab_configs: 탭명 UPDATE ──
        await pool.query(
          'UPDATE tab_configs SET tab_name = $1 WHERE sheet_id = $2 AND tab_name = $3',
          [tabName, sheetId, oldTabName]
        );
        // ── URL 교정: 정규화된 시트 URL로 업데이트 ──
        const correctUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
        await pool.query(
          'UPDATE tab_configs SET sheet_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3 AND (sheet_url IS NULL OR sheet_url != $1)',
          [correctUrl, sheetId, tabName]
        );
        // unrecognized_tabs에서 옛 이름 삭제
        await pool.query('DELETE FROM unrecognized_tabs WHERE sheet_id = $1 AND tab_name = $2', [sheetId, oldTabName]);
        // checksumMap도 갱신 (옛 이름 체크섬을 새 이름으로 이전)
        const oldKey = `${sheetId}||${oldTabName}`;
        if (checksumMap[oldKey]) {
          checksumMap[key] = checksumMap[oldKey];
          delete checksumMap[oldKey];
        }
        // gidToNameMap 갱신
        if (gidToNameMap) gidToNameMap[gidKey] = tabName;
        logger.info(`[buildIndex] 탭 이름 변경 적용 완료: "${oldTabName}" → "${tabName}" (review_index ${riResult.rowCount}행, index_master ${imResult.rowCount}행 UPDATE)`);
      } catch (renameErr) {
        logger.warn(`[buildIndex] 탭 이름 변경 처리 실패 (${oldTabName} → ${tabName}): ${renameErr.message}`);
      }
    }

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
      await _resolveRecognizedTab(sheetId, tabName, tabGid);
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

  // ★ 고아 탭 정리: 구글 시트에 더 이상 존재하지 않는 index_master 레코드 감지 및 삭제
  // validTabs(필터링 전)의 GID 목록과 DB의 GID 목록을 비교
  try {
    const currentGids = new Set(validTabs.map(t => String(t.properties.sheetId)));
    const { rows: dbTabsForSheet } = await pool.query(
      "SELECT tab_name, tab_gid FROM index_master WHERE sheet_id = $1 AND status = 'active'",
      [sheetId]
    );
    for (const dbTab of dbTabsForSheet) {
      if (dbTab.tab_gid && !currentGids.has(String(dbTab.tab_gid))) {
        // 이 GID는 구글 시트에 더 이상 존재하지 않음 → 고아 레코드 삭제
        logger.info(`[buildIndex] 고아 탭 정리: "${dbTab.tab_name}" (gid=${dbTab.tab_gid}) — 구글 시트에서 삭제됨`);
        await pool.query('DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2', [sheetId, dbTab.tab_name]);
        await pool.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [sheetId, dbTab.tab_name]);
      }
    }
  } catch (orphanErr) {
    logger.warn(`[buildIndex] 고아 탭 정리 실패 (${sheetId.substring(0, 15)}): ${orphanErr.message}`);
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

    // ★ Incremental Upsert: DELETE→INSERT 전체 교체 대신
    //    ON CONFLICT DO UPDATE로 기존 행 갱신 + 고아 행만 삭제
    //    → 인덱스 재구축 비용 대폭 절감

    // 새 데이터의 row_index 집합 수집 (고아 삭제용)
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
            `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`
          );
          insertValues.push(
            row.name, sheetId, row.tabGid, tabName,
            row.campaignName, row.rowIndex, row.isSubmitted,
            row.productUrl, row.productName, row.submitCol,
            JSON.stringify(row.rowJson), row.startDate, row.endDate, row.round,
            row.phone8 || null,
            row.isSubmitted2 || null, row.submitCol2 || null
          );
        }

        await client.query(`
          INSERT INTO review_index
            (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
             row_index, is_submitted, product_url, product_name,
             submit_col, row_json, start_date, end_date, round, phone8,
             is_submitted2, submit_col2)
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
            is_submitted2 = CASE
              WHEN EXCLUDED.is_submitted2 IS NOT NULL THEN EXCLUDED.is_submitted2
              WHEN EXCLUDED.submit_col2 IS NULL AND review_index.is_submitted2 = 'PAID' THEN 'PAID'
              ELSE COALESCE(EXCLUDED.is_submitted2, 'NONE')
            END,
            submit_col2 = EXCLUDED.submit_col2,
            built_at = NOW()
        `, insertValues);
      }
    }

    // ★ 고아 행 삭제: 시트에서 삭제/이동된 행만 DB에서 제거
    if (newRowIndices.size > 0) {
      const idxArray = [...newRowIndices];
      await client.query(
        `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index != ALL($3::int[])`,
        [sheetId, tabName, idxArray]
      );
    } else {
      // 새 행이 없으면 전체 삭제 (탭이 비워진 경우)
      await client.query(
        'DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2',
        [sheetId, tabName]
      );
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

  // ── 제출열 탐색: 우선순위 기반 ("리뷰제출" > "리뷰완료" > 기타 "제출") ──
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

  // ── 입금열 탐색 (is_submitted2 / submit_col2) ──
  // ★ 우선순위: 정확 매칭 '입금' > 접두사 매칭 '입금완료' 등 > '페이백입금일' 등
  // ★ '결제금액','결제일','결제금' 등 금액/날짜 컬럼은 제외 (값이 숫자라 오탐)
  const PAYMENT_EXACT = ['입금', '입금완료', '입금확인', '입금여부', '페이백'];  // 정확 매칭 (최우선)
  const PAYMENT_PARTIAL = ['페이백입금', '페이백'];  // 부분 매칭 (차선) — '구매대금 페이백' 등 공백 포함 헤더 대응
  const PAYMENT_EXCLUDE = ['입금명', '입금자', '예금주', '입금자명', '결제금액', '결제금', '결제일', '결제수단'];
  let paymentColIdx = -1;

  // 1단계: 정확 매칭 (헤더명이 키워드와 완전히 일치)
  for (let hi = 0; hi < headers.length && paymentColIdx < 0; hi++) {
    const h = headers[hi].trim();
    if (PAYMENT_EXACT.includes(h)) {
      paymentColIdx = hi;
    }
  }
  // 2단계: 부분 매칭 (제외 패턴 회피)
  if (paymentColIdx < 0) {
    for (let hi = 0; hi < headers.length && paymentColIdx < 0; hi++) {
      const hl = headers[hi].toLowerCase();
      if (PAYMENT_EXCLUDE.some(p => hl.includes(p))) continue;
      if (PAYMENT_PARTIAL.some(k => hl.includes(k.toLowerCase()))) {
        paymentColIdx = hi;
      }
    }
  }

  return dataRows
    .map((row, i) => {
      const name = String(row[nameColIdx] || '').trim();
      if (!name) return null;

      const submitVal = submitColIdx >= 0 ? String(row[submitColIdx] || '').trim() : '';
      const isSubmitted = _isSubmittedValue(submitVal);

      // 입금 상태 감지
      const paymentVal = paymentColIdx >= 0 ? String(row[paymentColIdx] || '').trim() : '';
      // 입금 상태 감지: 값이 있으면 PAID, 빈칸이면 NONE (미입금)
      let isSubmitted2 = null;
      if (paymentColIdx >= 0) {
        isSubmitted2 = paymentVal && _isSubmittedValue(paymentVal) ? 'PAID' : 'NONE';
      }

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
        isSubmitted2,
        submitCol: submitColIdx >= 0 ? headers[submitColIdx] : '',
        submitCol2: paymentColIdx >= 0 ? headers[paymentColIdx] : '',
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

/**
 * 제출 여부 판단 로직 (강화된 3단계 — smartBuild와 동일)
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
        // 헤더가 있지만 parseTabRows가 빈 배열 반환 → 세부 원인 분석
        const headers = values[headerRowIdx].map(h => String(h || '').trim());
        const nameColIdx = headers.findIndex(h =>
          NAME_KEYWORDS.some(k => h.includes(k))
        );
        if (nameColIdx < 0) {
          reason = 'no_name_col';  // 헤더에 이름 키워드 컬럼 자체가 없음
        } else {
          // 이름 컬럼은 있지만 데이터 행에 실제 이름 값이 없음
          const dataRows = values.slice(headerRowIdx + 1);
          const hasAnyName = dataRows.some(row => {
            const name = String((row && row[nameColIdx]) || '').trim();
            return name.length > 0;
          });
          if (!hasAnyName) {
            reason = 'no_data';  // 헤더/이름컬럼 존재, 데이터 미입력 → 진행 중인 탭
          } else {
            reason = 'no_name_col';  // 기타 원인
          }
        }
      }
    }

    // no_data: 헤더 구조는 정상이지만 데이터가 아직 채워지지 않은 진행 중인 탭
    // → 인식 실패가 아니므로 기록하지 않고, 기존 레코드가 있으면 resolve 처리
    if (reason === 'no_data') {
      await pool.query(
        `UPDATE unrecognized_tabs SET status = 'resolved'
         WHERE sheet_id = $1 AND (tab_name = $2 OR tab_gid = $3) AND status = 'pending'`,
        [sheetId, tabName, tabGid]
      );
      return;
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
// tab_name 매칭 + tab_gid 매칭 (탭명 변경 대응)
async function _resolveRecognizedTab(sheetId, tabName, tabGid) {
  try {
    // 1) 현재 이름으로 resolve
    await pool.query(
      `UPDATE unrecognized_tabs SET status = 'resolved' WHERE sheet_id = $1 AND tab_name = $2 AND status = 'pending'`,
      [sheetId, tabName]
    );
    // 2) 같은 시트의 같은 gid인데 다른 이름으로 남아있는 유령 레코드도 resolve
    if (tabGid) {
      await pool.query(
        `UPDATE unrecognized_tabs SET status = 'resolved' WHERE sheet_id = $1 AND tab_gid = $2 AND tab_name != $3 AND status = 'pending'`,
        [sheetId, tabGid, tabName]
      );
    }
  } catch (_) {}
}

module.exports = { buildIndexSmart, acquireBuildLock, releaseBuildLock, parseTabRows, checkDirtySheets, buildOneSheet };

// ═══════════════════════════════════════════════════════════
// ★ Phase 4: 경량 변경 감지 (Drive API만 사용, 인덱스 빌드 없음)
// 각 시트의 modifiedTime을 Drive API로 확인하고
// DB의 index_master.sheet_modified_at과 비교하여 변경된 시트 목록 반환
// ═══════════════════════════════════════════════════════════

async function checkDirtySheets() {
  // DB에서만 시트 ID 수집 (베이스시트 의존 제거)
  const { rows: campaignRows } = await pool.query(
    'SELECT DISTINCT sheet_id FROM campaigns UNION SELECT DISTINCT sheet_id FROM tab_configs'
  );
  const sheetIds = [...new Set(
    campaignRows.map(r => r.sheet_id)
  )].filter(Boolean);

  // ★ 최적화: 사전에 모든 시트의 수정시각·캠페인명을 1회 쿼리로 로드
  //    기존: 시트별 2회 pool.query (MAX + campaign_name) → 55시트 = 110회 쿼리
  //    개선: 1회 쿼리로 전체 로드 → 메모리 매핑
  const { rows: masterSummary } = await pool.query(
    `SELECT sheet_id,
            MAX(sheet_modified_at) AS last_modified,
            (array_agg(campaign_name ORDER BY built_at DESC NULLS LAST) FILTER (WHERE campaign_name IS NOT NULL))[1] AS campaign_name
     FROM index_master
     GROUP BY sheet_id`
  );
  const localModifiedMap = {};  // sheet_id → { lastModified: ms, campaignName: string }
  masterSummary.forEach(r => {
    localModifiedMap[r.sheet_id] = {
      lastModified: r.last_modified ? new Date(r.last_modified).getTime() : 0,
      lastModifiedRaw: r.last_modified || null,
      campaignName: r.campaign_name || null,
    };
  });

  const dirtySheets = [];

  for (const sheetId of sheetIds) {
    try {
      const remoteModified = await throttledCall(() => getSheetModifiedTime(sheetId));
      if (!remoteModified) continue;

      const remoteMs = new Date(remoteModified).getTime();
      const local = localModifiedMap[sheetId] || { lastModified: 0, lastModifiedRaw: null, campaignName: null };

      if (remoteMs > local.lastModified) {
        dirtySheets.push({
          sheetId,
          campaignName: local.campaignName || sheetId.substring(0, 15) + '...',
          remoteModified,
          localModified: local.lastModifiedRaw,
          diffSec: Math.round((remoteMs - local.lastModified) / 1000),
        });
      }
    } catch (err) {
      logger.warn(`[dirtyCheck] 시트 ${sheetId.substring(0, 15)} 확인 실패: ${err.message}`);
    }
  }

  return dirtySheets;
}

// ═══════════════════════════════════════════════════════════
// ★ Phase 4: 특정 시트 1개만 인덱스 빌드
// 전체 빌드 없이 변경 감지된 시트만 선택적으로 갱신
// ═══════════════════════════════════════════════════════════

async function buildOneSheet(sheetId) {
  const startTime = Date.now();

  // 잠금 획득
  const lockResult = await acquireBuildLock('buildOneSheet');
  if (!lockResult.acquired) {
    return { ok: false, error: '타 사용자가 갱신중입니다.', locked: true };
  }

  try {
    await _loadKeywordsFromDB();

    // 기존 데이터 로드
    const { rows: masterRows } = await pool.query(
      'SELECT sheet_id, tab_name, tab_gid, checksum, sheet_modified_at FROM index_master WHERE sheet_id = $1',
      [sheetId]
    );
    const checksumMap = {};
    const sheetModifiedMap = {};
    const gidToNameMap = {};
    masterRows.forEach(r => {
      checksumMap[`${r.sheet_id}||${r.tab_name}`] = r.checksum;
      if (r.tab_gid) gidToNameMap[`${r.sheet_id}||${r.tab_gid}`] = r.tab_name;
      if (r.sheet_modified_at) {
        const existing = sheetModifiedMap[r.sheet_id];
        const current = new Date(r.sheet_modified_at).getTime();
        if (!existing || current > existing) sheetModifiedMap[r.sheet_id] = current;
      }
    });

    const { rows: tcRows } = await pool.query(
      'SELECT sheet_id, tab_name, is_closed FROM tab_configs WHERE sheet_id = $1',
      [sheetId]
    );
    const tcMap = {};
    tcRows.forEach(r => { tcMap[`${r.sheet_id}||${r.tab_name}`] = r; });

    const { rows: archivedRows } = await pool.query(
      'SELECT sheet_id, tab_name FROM index_master_archive WHERE sheet_id = $1',
      [sheetId]
    );
    const archivedSet = new Set();
    archivedRows.forEach(r => archivedSet.add(`${r.sheet_id}||${r.tab_name}`));

    // 강제 빌드 (변경감지 스킵)
    const result = await _processOneSheet(sheetId, {
      forceFullRebuild: true,
      checksumMap,
      sheetModifiedMap,
      tcMap,
      archivedSet,
      gidToNameMap,
      startTime,
    });

    const elapsed = Date.now() - startTime;
    logger.info(`[buildOneSheet] ${sheetId.substring(0, 15)}... → rebuilt=${result.rebuilt}, skipped=${result.skipped}, ${elapsed}ms`);

    return { ok: true, ...result, elapsed: `${elapsed}ms` };
  } catch (err) {
    logger.error(`[buildOneSheet] 오류: ${err.message}`);
    throw err;
  } finally {
    await releaseBuildLock();
  }
}
