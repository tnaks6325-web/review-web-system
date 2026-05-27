const pool = require('../db/pool');
const { logger } = require('../utils/logger');

/**
 * rowJson (JSON 문자열 또는 객체) → row 객체로 파싱
 * DB에 TEXT로 저장된 JSON 문자열을 안전하게 파싱
 */
function _parseRowJson(rowJson) {
  if (!rowJson) return {};
  if (typeof rowJson === 'object') return rowJson;
  try {
    return JSON.parse(rowJson);
  } catch (_) {
    return {};
  }
}

/**
 * ★ 리뷰어 프로필에서 본인 + 타계정의 phone8 목록을 가져온다
 * 반환: ['29979075', '62900585', ...] (본인 포함)
 */
async function _getReviewerPhoneList(phone8) {
  if (!phone8 || phone8.length !== 8) return [phone8].filter(Boolean);
  
  try {
    const { rows } = await pool.query(
      `SELECT phone8, sub_accounts AS "subAccounts" FROM reviewers WHERE phone8 = $1 LIMIT 1`,
      [phone8]
    );
    if (rows.length === 0) return [phone8];
    
    const phoneList = [phone8]; // 본인
    
    // 타계정 phone8 추출
    let subs = rows[0].subAccounts;
    if (typeof subs === 'string') {
      try { subs = JSON.parse(subs); } catch(_) { subs = []; }
    }
    if (Array.isArray(subs)) {
      subs.forEach(sub => {
        const subPhone = (sub.phone || sub.전화번호 || '').replace(/[^0-9]/g, '');
        if (subPhone.length >= 8) {
          const sp8 = subPhone.slice(-8);
          if (!phoneList.includes(sp8)) phoneList.push(sp8);
        }
      });
    }
    
    return phoneList;
  } catch(e) {
    logger.warn('[Search] 프로필 phone8 목록 조회 실패:', e.message);
    return [phone8];
  }
}

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
    ri.recipient_name    AS "recipientName",
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
    tc.capture_folder_url AS "captureFolderUrl",
    tc.archived_rounds   AS "archivedRounds"
  `;

  let sql;

  if (q && p8.length === 8) {
    // ── 이름 + phone8 하이브리드 검색 (동명이인 분리) ──
    // ★ 방안3: phone8 기반 필터링 + 유사 매칭(오인식 구제)
    //   1) 본인 + 타계정 phone8 정확 일치
    //   2) phone8 앞4자리 또는 뒤4자리가 동일한 건 (1~2자리 오인식 구제)
    //   3) phone8이 NULL인 건 (전화번호 없는 행도 포함)
    const phoneList = await _getReviewerPhoneList(p8);
    
    const nameParam = paramIdx++;
    // phoneList를 배열 파라미터로 전달
    const phoneListParam = paramIdx++;
    // 기준 phone8 (앞4/뒤4 비교용)
    const phonePrefixParam = paramIdx++;
    const phoneSuffixParam = paramIdx++;
    
    sql = `
      SELECT ${SELECT_FIELDS},
             CASE 
               WHEN ri.phone8 = ANY($${phoneListParam}) THEN 1.0
               WHEN ri.phone8 IS NOT NULL AND (
                 SUBSTRING(ri.phone8, 1, 4) = $${phonePrefixParam}
                 OR SUBSTRING(ri.phone8, 5, 4) = $${phoneSuffixParam}
               ) THEN 0.8
               WHEN ri.phone8 IS NULL THEN 0.6
               ELSE 0.0
             END::float AS score
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = FALSE
        AND tc.sheet_id IS NOT NULL
        AND (REPLACE(ri.reviewer_name, ' ', '') = $${nameParam}
             OR REPLACE(ri.recipient_name, ' ', '') = $${nameParam})
        AND (
          ri.phone8 = ANY($${phoneListParam})
          OR ri.phone8 IS NULL
          OR (
            SUBSTRING(ri.phone8, 1, 4) = $${phonePrefixParam}
            OR SUBSTRING(ri.phone8, 5, 4) = $${phoneSuffixParam}
          )
        )
      ORDER BY score DESC, ri.start_date DESC NULLS LAST
      LIMIT 200
    `;
    params.push(q, phoneList, p8.substring(0, 4), p8.substring(4, 8));

  } else if (p8.length === 8) {
    // ── phone8 단독 검색 (trigram 불필요) ──
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = FALSE
        AND tc.sheet_id IS NOT NULL
        AND ri.phone8 = $${paramIdx++}
      ORDER BY ri.start_date DESC NULLS LAST
      LIMIT 200
    `;
    params.push(p8);

  } else {
    // ── 이름만 검색 (정확 일치) ──
    // reviewer_name이 검색어와 정확히 일치하는 경우만 반환
    // 공백 제거 후 비교: "김 수 만" == "김수만"
    // ★ reviewer_name OR recipient_name 매칭 (수취인 검색 지원)
    const nameParam = paramIdx++;
    sql = `
      SELECT ${SELECT_FIELDS},
             1.0::float AS score
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = FALSE
        AND tc.sheet_id IS NOT NULL
        AND (REPLACE(ri.reviewer_name, ' ', '') = $${nameParam}
             OR REPLACE(ri.recipient_name, ' ', '') = $${nameParam})
      ORDER BY ri.start_date DESC NULLS LAST
      LIMIT 200
    `;
    params.push(q);
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

    // ★ 아카이브된 차수 필터링: archived_rounds에 해당 행의 round가 포함되면 제외
    const filteredRows = rows.filter(row => {
      if (!row.archivedRounds || !row.round) return true;
      const archivedSet = new Set(row.archivedRounds.split(',').map(s => s.trim()).filter(Boolean));
      return !archivedSet.has(row.round);
    });

    // GAS 호환 결과 변환
    const results = filteredRows.map(row => ({
      displayName: (row.idxName || '').split('/')[0],
      idxName:     row.idxName,
      recipientName: row.recipientName || '',
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
      row:         _parseRowJson(row.rowJson),
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
    const nameParam = paramIdx++;
    const phoneParam = paramIdx++;
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = FALSE
        AND tc.sheet_id IS NOT NULL
        AND (ri.reviewer_name ILIKE $${nameParam}
             OR ri.recipient_name ILIKE $${nameParam})
        AND ri.phone8 = $${phoneParam}
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
        AND tc.sheet_id IS NOT NULL
        AND ri.phone8 = $${paramIdx++}
      ORDER BY ri.start_date DESC NULLS LAST
      LIMIT 200
    `;
    params.push(p8);
  } else {
    const nameParam = paramIdx++;
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = FALSE
        AND tc.sheet_id IS NOT NULL
        AND (ri.reviewer_name ILIKE $${nameParam}
             OR ri.recipient_name ILIKE $${nameParam})
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

  // ★ 아카이브된 차수 필터링
  const filteredRows = rows.filter(row => {
    if (!row.archivedRounds || !row.round) return true;
    const archivedSet = new Set(row.archivedRounds.split(',').map(s => s.trim()).filter(Boolean));
    return !archivedSet.has(row.round);
  });

  const results = filteredRows.map(row => ({
    displayName: (row.idxName || '').split('/')[0],
    idxName:     row.idxName,
    recipientName: row.recipientName || '',
    campaignName: row.tcCampaignName || row.campaignName || '',
    folderUrl:   row.folderUrl,
    captureFolderUrl: row.captureFolderUrl,
    row:         _parseRowJson(row.rowJson),
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
      WHERE (ri.reviewer_name ILIKE $2 OR ri.recipient_name ILIKE $2) OR ri.reviewer_name % $1
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
      WHERE (ri.reviewer_name ILIKE $1 OR ri.recipient_name ILIKE $1)
      ORDER BY ri.built_at DESC NULLS LAST
      LIMIT 500
    `, [`%${q}%`]);

    return { results: rows, total: rows.length, debug: true, searchMs: Date.now() - startMs, fallback: true };
  }
}

module.exports = { searchByName, searchByNameDebug };
