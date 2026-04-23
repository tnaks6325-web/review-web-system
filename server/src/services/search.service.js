const pool = require('../db/pool');
const { logger } = require('../utils/logger');

/**
 * Phase 7: pg_trgm 기반 검색 최적화
 * 
 * 전략:
 * 1) 정확 매칭 (ILIKE) — pg_trgm GIN 인덱스가 가속 (기존 풀스캔 → 인덱스 스캔)
 * 2) 유사도 검색 (similarity) — 오타/유사 이름도 검색 가능
 * 3) 부분인덱스 (is_submitted=FALSE) — 활성 건만 빠르게 검색
 * 
 * 한글 특성:
 *  - pg_trgm은 한글을 3-gram으로 분해 (예: "홍길동" → "홍길", "길동")
 *  - ILIKE '%홍길동%' → GIN 인덱스 자동 활용 (기존 B-tree로는 불가)
 *  - similarity() 임계값은 한글 짧은 이름 특성상 0.1~0.2로 낮춤
 */

// 한글 유사도 임계값 (짧은 이름 2~4글자 특성 반영)
const SIMILARITY_THRESHOLD = 0.15;

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

  let sql;

  if (q && p8.length === 8) {
    // ── 이름 + phone8 검색 (동명이인 구분) ──
    // 1단계: ILIKE 정확 매칭 (pg_trgm GIN 인덱스 활용)
    // 2단계: 유사도 검색 (오타 허용)으로 확장
    sql = `
      WITH exact AS (
        SELECT ${SELECT_FIELDS},
               1.0::float AS score
        FROM review_index ri
        LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
        WHERE ri.is_submitted = FALSE
          AND ri.reviewer_name ILIKE $${paramIdx++}
          AND ri.phone8 = $${paramIdx++}
      ),
      fuzzy AS (
        SELECT ${SELECT_FIELDS},
               similarity(ri.reviewer_name, $${paramIdx++})::float AS score
        FROM review_index ri
        LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
        WHERE ri.is_submitted = FALSE
          AND ri.reviewer_name % $${paramIdx++}
          AND ri.phone8 = $${paramIdx++}
          AND NOT EXISTS (
            SELECT 1 FROM exact e WHERE e."sheetId" = ri.sheet_id AND e."tabName" = ri.tab_name AND e."rowIndex" = ri.row_index
          )
      )
      SELECT * FROM exact
      UNION ALL
      SELECT * FROM fuzzy
      ORDER BY score DESC, "startDate" DESC NULLS LAST
      LIMIT 200
    `;
    params.push(`%${q}%`, p8, q, q, p8);

  } else if (p8.length === 8) {
    // ── phone8 단독 검색 (trigram 불필요) ──
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
    // ── 이름만 검색 ──
    // 1단계: ILIKE 정확 매칭 (pg_trgm GIN 인덱스 가속)
    // 2단계: 유사도 검색으로 오타/유사 이름 포착
    sql = `
      WITH exact AS (
        SELECT ${SELECT_FIELDS},
               1.0::float AS score
        FROM review_index ri
        LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
        WHERE ri.is_submitted = FALSE
          AND ri.reviewer_name ILIKE $${paramIdx++}
      ),
      fuzzy AS (
        SELECT ${SELECT_FIELDS},
               similarity(ri.reviewer_name, $${paramIdx++})::float AS score
        FROM review_index ri
        LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
        WHERE ri.is_submitted = FALSE
          AND ri.reviewer_name % $${paramIdx++}
          AND NOT EXISTS (
            SELECT 1 FROM exact e WHERE e."sheetId" = ri.sheet_id AND e."tabName" = ri.tab_name AND e."rowIndex" = ri.row_index
          )
      )
      SELECT * FROM exact
      UNION ALL
      SELECT * FROM fuzzy
      ORDER BY score DESC, "startDate" DESC NULLS LAST
      LIMIT 200
    `;
    params.push(`%${q}%`, q, q);
  }

  const startMs = Date.now();

  try {
    // 유사도 임계값 설정 (세션 단위)
    if (q) {
      await pool.query(`SELECT set_limit(${SIMILARITY_THRESHOLD})`);
    }

    const { rows } = await pool.query(sql, params);
    const queryMs = Date.now() - startMs;

    // 느린 쿼리 경고 (500ms 초과)
    if (queryMs > 500) {
      logger.warn(`[Search] 느린 검색: query="${q}" phone8="${p8}" → ${rows.length}건 ${queryMs}ms`);
    }

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
      score:       row.score, // 유사도 점수 (1.0=정확매칭, <1.0=유사매칭)
    }));

    return {
      results,
      total: results.length,
      fromIndex: true,
      wasExpired: false,
      indexBuiltAt: meta.built_at || null,
      indexCount: parseInt(meta.count) || 0,
      searchMs: queryMs,  // Phase 7: 검색 소요시간 반환
    };
  } catch (err) {
    // pg_trgm 미설치 시 fallback: 기존 ILIKE 검색
    if (err.message.includes('function similarity') || err.message.includes('operator does not exist: %')) {
      logger.warn('[Search] pg_trgm 미설치 — ILIKE fallback 사용');
      return searchByNameFallback(q, p8, SELECT_FIELDS);
    }
    throw new Error('검색 쿼리 오류: ' + err.message);
  }
}

/**
 * pg_trgm 미설치 시 fallback (기존 ILIKE 방식)
 */
async function searchByNameFallback(q, p8, SELECT_FIELDS) {
  let sql;
  const params = [];
  let paramIdx = 1;

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

  const startMs = Date.now();
  const { rows } = await pool.query(sql, params);
  const queryMs = Date.now() - startMs;

  const metaResult = await pool.query(
    'SELECT COUNT(*) AS count, MAX(built_at) AS built_at FROM review_index'
  );
  const meta = metaResult.rows[0] || {};

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
    searchMs: queryMs,
    fallback: true,  // pg_trgm 미설치 상태 표시
  };
}

/**
 * 디버그용 전체 검색 (isSubmitted 포함)
 * GAS: handleSearchAllDebug
 */
async function searchByNameDebug(query) {
  const q = (query || '').trim().replace(/\s/g, '');
  if (!q) return { error: '검색어를 입력하세요.', results: [] };

  const startMs = Date.now();

  try {
    // pg_trgm 유사도 검색 시도
    await pool.query(`SELECT set_limit(${SIMILARITY_THRESHOLD})`);

    const { rows } = await pool.query(`
      SELECT
        ri.reviewer_name AS "idxName", ri.tab_name AS "tabName",
        ri.sheet_id AS "sheetId", ri.row_index AS "rowIndex",
        ri.is_submitted AS "isSubmitted", ri.campaign_name AS "campaignName",
        similarity(ri.reviewer_name, $1)::float AS score
      FROM review_index ri
      WHERE ri.reviewer_name ILIKE $2 OR ri.reviewer_name % $1
      ORDER BY score DESC, ri.built_at DESC NULLS LAST
      LIMIT 500
    `, [q, `%${q}%`]);

    return { results: rows, total: rows.length, debug: true, searchMs: Date.now() - startMs };
  } catch (err) {
    // pg_trgm fallback
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

    return { results: rows, total: rows.length, debug: true, searchMs: Date.now() - startMs, fallback: true };
  }
}

module.exports = { searchByName, searchByNameDebug };
