const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta } = require('./sheets.service');
const { computeChecksum } = require('../utils/checksum');
const { logger } = require('../utils/logger');

// GAS 원본 상수 (그대로 유지)
const SUBMITTED_VALUES = ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'];
const NAME_KEYWORDS = ['수취인', '이름', '신청자', '참여자', '수취인명'];
const SYSTEM_TABS = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감'];

/**
 * 스마트 증분 인덱스 빌드
 * GAS: handleBuildIndexSmart(forceFullRebuild)
 */
async function buildIndexSmart(forceFullRebuild = false) {
  const startTime = Date.now();
  let rebuilt = 0, skipped = 0, errors = 0;

  try {
    // 1. 베이스시트의 모든 탭(캠페인 목록) 로드
    const baseMeta = await getSpreadsheetMeta(process.env.BASE_SHEET_ID);
    const campaignSheets = baseMeta.filter(s =>
      !SYSTEM_TABS.includes(s.properties.title)
    );

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
      const sheetId = process.env.BASE_SHEET_ID;
      const tabName = sheet.properties.title;
      const key = `${sheetId}||${tabName}`;

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
            const insertValues = [];
            const insertPlaceholders = [];
            let paramIdx = 1;

            for (const row of rows) {
              insertPlaceholders.push(
                `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`
              );
              insertValues.push(
                row.name, sheetId, row.tabGid, tabName,
                row.campaignName, row.rowIndex, row.isSubmitted,
                row.productUrl, row.productName, row.submitCol,
                JSON.stringify(row.rowJson), row.startDate, row.endDate, row.round
              );
            }

            await client.query(`
              INSERT INTO review_index
                (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
                 row_index, is_submitted, product_url, product_name,
                 submit_col, row_json, start_date, end_date, round)
              VALUES ${insertPlaceholders.join(', ')}
            `, insertValues);
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
              campaign_name = EXCLUDED.campaign_name
          `, [
            sheetId, tabName, String(sheet.properties.sheetId), tabName,
            newChecksum, rows.length, rows.filter(r => r.isSubmitted).length
          ]);

          await client.query('COMMIT');
          rebuilt++;
        } catch (err) {
          await client.query('ROLLBACK');
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
  // 헤더 행 탐지 (이름 컬럼이 있는 행)
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(values.length, 10); i++) {
    if (values[i] && values[i].some(cell => NAME_KEYWORDS.some(k => String(cell || '').includes(k)))) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) return [];

  const headers = values[headerRowIdx].map(h => String(h || '').trim());
  const dataRows = values.slice(headerRowIdx + 1);

  // 이름 컬럼 인덱스 찾기
  const nameColIdx = headers.findIndex(h => NAME_KEYWORDS.some(k => h.includes(k)));
  if (nameColIdx < 0) return [];

  // 제출 컬럼 인덱스
  const submitKeywords = ['리뷰완료', '제출', '완료', 'submit', '제출완료'];
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

  return dataRows
    .map((row, i) => {
      const name = String(row[nameColIdx] || '').trim();
      if (!name) return null;

      const submitVal = submitColIdx >= 0 ? String(row[submitColIdx] || '').trim() : '';
      const isSubmitted = SUBMITTED_VALUES.includes(submitVal);

      return {
        name,
        tabGid,
        rowIndex: headerRowIdx + 1 + i + 1, // 1-based actual row
        isSubmitted,
        submitCol: submitColIdx >= 0 ? headers[submitColIdx] : '',
        productName: productColIdx >= 0 ? String(row[productColIdx] || '').trim() : '',
        productUrl: urlColIdx >= 0 ? String(row[urlColIdx] || '').trim() : '',
        rowJson: Object.fromEntries(headers.map((h, j) => [h, row[j] !== undefined ? row[j] : ''])),
        startDate: null,
        endDate: null,
        round: '',
        campaignName: tabName,
      };
    })
    .filter(Boolean);
}

module.exports = { buildIndexSmart };
