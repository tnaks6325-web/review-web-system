const pool = require('../db/pool');

/**
 * 이름/전화번호로 리뷰 인덱스 검색
 * GAS: handleSearchAll(query, phone8)
 * isSubmitted=false 행만 반환 (제출 완료 제외)
 */
async function searchByName(query, phone8) {
  const q = (query || '').trim().replace(/\s/g, '');
  const p8 = (phone8 || '').replace(/[^0-9]/g, '');

  if (!q && p8.length !== 8) {
    return { error: '2글자 이상 입력하세요.', results: [] };
  }

  // PostgreSQL 쿼리 — review_index + tab_configs JOIN
  let sql;
  const params = [];
  let paramIdx = 1;

  const SELECT_FIELDS = `
    ri.reviewer_name     AS "idxName",
    ri.campaign_name     AS "campaignName",
    ri.tab_name          AS "tabName",
    ri.sheet_id          AS "sheetId",
    ri.tab_gid           AS "gid",
    ri.row_index         AS "rowIndex",
    ri.is_submitted      AS "isSubmitted",
    ri.product_name      AS "productName",
    ri.product_url       AS "productUrl",
    ri.start_date        AS "startDate",
    ri.end_date          AS "endDate",
    ri.round,
    ri.row_json          AS "rowJson",
    ri.submit_col        AS "submitCol",
    tc.manager,
    tc.time_range        AS "timeRange",
    tc.review_type       AS "reviewType",
    tc.taekhap,
    tc.force_done        AS "forceDone",
    tc.is_closed         AS "isClosed",
    tc.delivery_type     AS "deliveryType",
    tc.is_bulk           AS "isBulk",
    tc.income_type       AS "incomeType",
    tc.campaign_name     AS "tcCampaignName",
    tc.display_name      AS "displayName",
    tc.nc_mode           AS "ncMode",
    tc.folder_url        AS "folderUrl",
    tc.capture_folder_url AS "captureFolderUrl"
  `;

  // 이름 검색 + phone8 필터 (동명이인 구분)
  if (q && p8.length === 8) {
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = FALSE
        AND ri.reviewer_name ILIKE $${paramIdx++}
        AND ri.phone8 = $${paramIdx++}
      ORDER BY ri.start_date DESC NULLS LAST
      LIMIT 200
    `;
    params.push(`%${q}%`, p8);
  } else if (p8.length === 8) {
    // phone8 단독 검색
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = FALSE
        AND ri.phone8 = $${paramIdx++}
      ORDER BY ri.start_date DESC NULLS LAST
      LIMIT 200
    `;
    params.push(p8);
  } else {
    // 이름만 검색
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = FALSE
        AND ri.reviewer_name ILIKE $${paramIdx++}
      ORDER BY ri.start_date DESC NULLS LAST
      LIMIT 200
    `;
    params.push(`%${q}%`);
  }

  try {
    const { rows } = await pool.query(sql, params);

    // 인덱스 메타 정보 가져오기
    const metaResult = await pool.query(
      'SELECT COUNT(*) AS count, MAX(built_at) AS built_at FROM review_index'
    );
    const meta = metaResult.rows[0] || {};

    // GAS 호환 결과 변환
    const results = rows.map(row => ({
      displayName: (row.idxName || '').split('/')[0],
      idxName:     row.idxName,
      campaignName: row.tcCampaignName || row.campaignName || '',
      tabName:     row.tabName,
      sheetId:     row.sheetId,
      gid:         row.gid,
      rowIndex:    row.rowIndex,
      isSubmitted: row.isSubmitted,
      submitVal:   '',
      productName: row.productName,
      productUrl:  row.productUrl,
      startDate:   row.startDate,
      endDate:     row.endDate,
      round:       row.round,
      manager:     row.manager,
      timeRange:   row.timeRange,
      reviewType:  row.reviewType,
      taekhap:     row.taekhap,
      forceDone:   row.forceDone || false,
      isClosed:    row.isClosed  || false,
      deliveryType: row.deliveryType,
      isBulk:      row.isBulk,
      incomeType:  row.incomeType,
      displayNameTC: row.displayName,
      ncMode:      row.ncMode,
      folderUrl:   row.folderUrl,
      captureFolderUrl: row.captureFolderUrl,
      rowJson:     row.rowJson,
      submitCol:   row.submitCol,
    }));

    return {
      results,
      total: results.length,
      fromIndex: true,
      wasExpired: false,
      indexBuiltAt: meta.built_at || null,
      indexCount: parseInt(meta.count) || 0,
    };
  } catch (err) {
    throw new Error('검색 쿼리 오류: ' + err.message);
  }
}

/**
 * 디버그용 전체 검색 (isSubmitted 포함)
 * GAS: handleSearchAllDebug
 */
async function searchByNameDebug(query) {
  const q = (query || '').trim().replace(/\s/g, '');
  if (!q) return { error: '검색어를 입력하세요.', results: [] };

  const { rows } = await pool.query(`
    SELECT
      ri.reviewer_name AS "idxName", ri.tab_name AS "tabName",
      ri.sheet_id AS "sheetId", ri.row_index AS "rowIndex",
      ri.is_submitted AS "isSubmitted", ri.campaign_name AS "campaignName"
    FROM review_index ri
    WHERE ri.reviewer_name ILIKE $1
    ORDER BY ri.built_at DESC NULLS LAST
    LIMIT 500
  `, [`%${q}%`]);

  return { results: rows, total: rows.length, debug: true };
}

module.exports = { searchByName, searchByNameDebug };
