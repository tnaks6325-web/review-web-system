const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta, batchReadSheet } = require('./sheets.service');
const { computeChecksum } = require('../utils/checksum');
const { logger } = require('../utils/logger');

// GAS 원본 상수 (그대로 유지)
const SUBMITTED_VALUES = ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'];
const NAME_KEYWORDS = ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'];
const SYSTEM_TABS = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정', 'detail', 'config'];
const DATA_TAB_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];

// 빌드 잠금 TTL (7분 — GAS 최대 6분 + 여유 1분)
const BUILD_LOCK_TTL_MS = 7 * 60 * 1000;

/**
 * 빌드 잠금 획득 (GAS: acquireBuildLock)
 */
async function acquireBuildLock(lockedBy = 'system') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT * FROM build_locks WHERE lock_key = 'INDEX_BUILD' FOR UPDATE"
    );

    if (rows.length === 0) {
      // 초기 행이 없으면 생성
      await client.query(
        "INSERT INTO build_locks (lock_key, locked_at, locked_by, is_locked) VALUES ('INDEX_BUILD', NOW(), $1, TRUE)",
        [lockedBy]
      );
      await client.query('COMMIT');
      return { acquired: true };
    }

    const lock = rows[0];
    if (lock.is_locked) {
      // 좀비 잠금 체크 (TTL 초과 시 강제 해제)
      const elapsed = lock.locked_at ? Date.now() - new Date(lock.locked_at).getTime() : Infinity;
      if (elapsed < BUILD_LOCK_TTL_MS) {
        await client.query('COMMIT');
        return { acquired: false, message: '타 사용자가 갱신중입니다.', elapsedMs: elapsed };
      }
      // TTL 초과 — 좀비 잠금 해제 후 재취득
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

/**
 * 빌드 잠금 해제
 */
async function releaseBuildLock() {
  await pool.query(
    "UPDATE build_locks SET is_locked = FALSE, locked_at = NULL, locked_by = NULL WHERE lock_key = 'INDEX_BUILD'"
  );
}

/**
 * 스마트 증분 인덱스 빌드
 * GAS: handleBuildIndexSmart(forceFullRebuild)
 */
async function buildIndexSmart(forceFullRebuild = false) {
  const startTime = Date.now();
  let rebuilt = 0, skipped = 0, errors = 0;

  // 빌드 잠금 획득
  const lockResult = await acquireBuildLock('buildIndexSmart');
  if (!lockResult.acquired) {
    return { ok: false, error: '타 사용자가 갱신중입니다. 잠시 후 다시 시도해주세요.', locked: true };
  }

  try {
    // 1. 캠페인 시트 목록 로드 (campaigns 테이블 + 베이스시트 메타)
    const campaignSheets = [];

    // campaigns 테이블에서 시트 목록 로드
    const { rows: campaignRows } = await pool.query(
      'SELECT DISTINCT sheet_id FROM campaigns UNION SELECT DISTINCT sheet_id FROM tab_configs'
    );
    const sheetIds = [...new Set([
      process.env.BASE_SHEET_ID,
      ...campaignRows.map(r => r.sheet_id)
    ])].filter(Boolean);

    for (const sheetId of sheetIds) {
      try {
        const meta = await getSpreadsheetMeta(sheetId);
        const tabs = meta.filter(s => !SYSTEM_TABS.includes(s.properties.title));
        tabs.forEach(t => campaignSheets.push({ sheetId, ...t }));
      } catch (err) {
        logger.error(`[buildIndex] 시트 메타 로드 실패 (${sheetId}): ${err.message}`);
        errors++;
      }
    }

    // 2. 기존 체크섬 맵 로드
    const { rows: masterRows } = await pool.query(
      'SELECT sheet_id, tab_name, checksum FROM index_master'
    );
    const checksumMap = {};
    masterRows.forEach(r => { checksumMap[`${r.sheet_id}||${r.tab_name}`] = r.checksum; });

    // 3. tab_configs에서 force_done / is_closed 상태 로드
    const { rows: tcRows } = await pool.query(
      'SELECT sheet_id, tab_name, force_done, is_closed FROM tab_configs'
    );
    const tcMap = {};
    tcRows.forEach(r => { tcMap[`${r.sheet_id}||${r.tab_name}`] = r; });

    // 4. 각 캠페인 시트의 탭 처리
    for (const sheet of campaignSheets) {
      const sheetId = sheet.sheetId;
      const tabName = sheet.properties.title;
      const key = `${sheetId}||${tabName}`;

      // 실행 시간 체크 (5분 15초 제한 — GAS 호환 안전 가드)
      if (Date.now() - startTime > 5 * 60 * 1000 + 15 * 1000) {
        logger.warn(`[buildIndex] 시간 초과 — 나머지 탭 다음 빌드에서 처리`);
        break;
      }

      // force_done 또는 is_closed 탭은 스킵
      const tc = tcMap[key];
      if (tc && (tc.force_done || tc.is_closed)) {
        skipped++;
        continue;
      }

      try {
        // 4-1. 탭 전체 데이터 읽기
        const values = await readSheet(sheetId, `'${tabName}'!A:Z`);
        if (!values || values.length < 2) {
          skipped++;
          continue;
        }

        // 4-2. 체크섬 계산
        const newChecksum = computeChecksum(values);

        if (!forceFullRebuild && checksumMap[key] === newChecksum) {
          skipped++;
          continue;
        }

        // 4-3. 헤더 파싱 + 데이터 행 추출
        const rows = parseTabRows(values, sheetId, tabName, String(sheet.properties.sheetId));

        // 4-4. 트랜잭션으로 upsert
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
            // 배치 크기 제한 (한 번에 100행씩)
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

          // index_master 체크섬 업데이트
          await client.query(`
            INSERT INTO index_master (sheet_id, tab_name, tab_gid, campaign_name, checksum, built_at,
                                      row_count, submitted_count, status)
            VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,'active')
            ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
              checksum = EXCLUDED.checksum,
              built_at = NOW(),
              row_count = EXCLUDED.row_count,
              submitted_count = EXCLUDED.submitted_count,
              campaign_name = EXCLUDED.campaign_name,
              status = 'active',
              error_msg = NULL
          `, [
            sheetId, tabName, String(sheet.properties.sheetId), tabName,
            newChecksum, rows.length, rows.filter(r => r.isSubmitted).length
          ]);

          await client.query('COMMIT');
          rebuilt++;
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
      } catch (err) {
        logger.error(`[buildIndex] 탭 처리 오류 (${tabName}): ${err.message}`);
        errors++;
      }
    }
  } catch (err) {
    logger.error(`[buildIndex] 전체 오류: ${err.message}`);
    throw err;
  } finally {
    // 빌드 잠금 해제
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
  };
  logger.info(`[buildIndex] 완료: rebuilt=${rebuilt}, skipped=${skipped}, errors=${errors}, ${elapsed}ms`);
  return result;
}

/**
 * 탭 데이터 파싱 (GAS의 _buildIndexFromTab 로직)
 */
function parseTabRows(values, sheetId, tabName, tabGid) {
  // 헤더 행 탐지 (데이터 탭 키워드가 있는 행)
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(values.length, 10); i++) {
    const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
    if (_isDataTabRow(cells)) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) return [];

  const headers = values[headerRowIdx].map(h => String(h || '').trim());
  const dataRows = values.slice(headerRowIdx + 1);

  // 이름 컬럼 인덱스 찾기 (GAS SEARCH_COLS 키워드)
  const nameColIdx = headers.findIndex(h =>
    NAME_KEYWORDS.some(k => h.includes(k))
  );
  if (nameColIdx < 0) return [];

  // 제출 컬럼 인덱스
  const submitKeywords = ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출'];
  const submitColIdx = headers.findIndex(h =>
    submitKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  // 상품명 컬럼
  const productKeywords = ['상품명', '제품명', '상품', 'product'];
  const productColIdx = headers.findIndex(h =>
    productKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  // 상품URL 컬럼
  const urlKeywords = ['상품url', '제품url', '상품링크', 'url', '링크'];
  const urlColIdx = headers.findIndex(h =>
    urlKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  // 전화번호 컬럼 (phone8 추출용)
  const phoneKeywords = ['연락처', '전화번호', '핸드폰', '휴대폰', 'phone'];
  const phoneColIdx = headers.findIndex(h =>
    phoneKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
  );

  // 날짜 컬럼들
  const startDateKeywords = ['시작일', '구매일', '주문일', '배정일'];
  const endDateKeywords = ['종료일', '마감일', '완료일', '제출마감'];
  const startDateIdx = headers.findIndex(h =>
    startDateKeywords.some(k => h.includes(k))
  );
  const endDateIdx = headers.findIndex(h =>
    endDateKeywords.some(k => h.includes(k))
  );

  // 회차 컬럼
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

      // phone8 추출
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
        rowIndex: headerRowIdx + 1 + i + 1, // 1-based actual row
        isSubmitted,
        submitCol: submitColIdx >= 0 ? headers[submitColIdx] : '',
        productName: productColIdx >= 0 ? String(row[productColIdx] || '').trim() : '',
        productUrl: urlColIdx >= 0 ? String(row[urlColIdx] || '').trim() : '',
        rowJson: Object.fromEntries(headers.map((h, j) => [h, row[j] !== undefined ? row[j] : ''])),
        startDate: startDateIdx >= 0 ? _formatDate(row[startDateIdx]) : null,
        endDate: endDateIdx >= 0 ? _formatDate(row[endDateIdx]) : null,
        round: roundIdx >= 0 ? String(row[roundIdx] || '').trim() : '',
        campaignName: tabName,
        phone8,
      };
    })
    .filter(Boolean);
}

/**
 * GAS _isDataTabRow 호환 — 헤더 행 탐지
 */
function _isDataTabRow(cells) {
  return DATA_TAB_KEYWORDS.some(kw =>
    kw === '번호' ? cells.includes(kw) : cells.some(c => c.includes(kw))
  );
}

/**
 * 날짜 값 포맷팅 (다양한 형식 처리)
 */
function _formatDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;

  // 이미 날짜 문자열 형식이면 그대로 반환
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return s;

  // Excel serial date (숫자)
  const num = Number(s);
  if (!isNaN(num) && num > 40000 && num < 50000) {
    const date = new Date((num - 25569) * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }

  return s;
}

module.exports = { buildIndexSmart, acquireBuildLock, releaseBuildLock };
