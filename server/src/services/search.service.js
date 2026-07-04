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

// 입금 컬럼 키워드 (admin.routes.js 대시보드 집계와 동일 판정)
const PAYMENT_COL_KEYWORDS = ['입금', '페이백', '입금완료', '입금확인', '입금여부'];

/**
 * 입금 완료 여부 — is_submitted2='PAID'(입금칸 감지+값 존재) 우선,
 * 미감지 탭은 row_json의 입금 키워드 컬럼에 값이 있으면 완료로 간주(대시보드 폴백과 동일)
 */
function _isPaid(isSubmitted2, rowObj) {
  if (isSubmitted2 === 'PAID') return true;
  if (!rowObj || typeof rowObj !== 'object') return false;
  for (const key of Object.keys(rowObj)) {
    const lk = key.toLowerCase();
    if (PAYMENT_COL_KEYWORDS.some(kw => lk.includes(kw.toLowerCase()))) {
      const val = String(rowObj[key] || '').trim();
      if (val.length > 0) return true;
    }
  }
  return false;
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
 * 기본: isSubmitted=false 행만 반환 (제출 완료 제외)
 * opts.includeSubmitted: true면 제출 완료 행도 함께 반환 (리뷰어 홈 제출대기/제출완료 탭용).
 *   - ★ 보안 가드: 무인증 엔드포인트이므로 제출완료 행은 phone8 정확 일치
 *     (본인+타계정 연락처 또는 participation_links 확정 신원)로 매칭된 행만 포함한다.
 *     이름 단독/이름+전화근접(약한 키) 매칭에는 절대 제출 이력을 열지 않는다
 *     (이름만 아는 임의 호출자가 타인의 누적 제출 이력·row_json PII를 긁는 것 차단).
 *   - 미제출 우선 정렬(is_submitted ASC)로 LIMIT에 걸려도 대기 건이 잘리지 않는다.
 *   - 제출완료 행은 row(행 전체 JSON)를 비워 반환한다(데이터 최소화 — 완료 탭 표시에 불필요).
 */
async function searchByName(query, phone8, opts = {}) {
  const q = (query || '').trim().replace(/\s/g, '');
  const p8 = (phone8 || '').replace(/[^0-9]/g, '');
  // 제출완료 포함은 phone8(8자리)이 있을 때만 유효 — 이름 단독 분기에서는 무시
  const includeSubmitted = !!(opts && opts.includeSubmitted) && p8.length === 8;
  const orderPrefix = includeSubmitted ? 'ri.is_submitted ASC, ' : '';
  // 완료 이력이 합산되므로 LIMIT 상향(대기 건은 정렬 프리픽스로 보호됨)
  const limit = includeSubmitted ? 400 : 200;

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
    ri.is_submitted2     AS "isSubmitted2",
    ri.review_file_at    AS "reviewFileAt",
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
    tc.capture_slots     AS "captureSlots",
    tc.archived_rounds   AS "archivedRounds"
  `;

  let sql;

  if (q && p8.length === 8) {
    // ── 이름 + phone8 하이브리드 검색 ──
    // ★ P0: phone8(본인+타계정)이 일치하면 이름 불일치여도 "내 참여"로 통과시킨다.
    //   (인애드명≠실명, 성 누락 "재관"↔"송재관", 수취인 플레이스홀더 등 이름칸이 지저분해도
    //    전화번호가 맞으면 본인 건이므로 누락하지 않음. 이름은 점수 가산용으로만 사용)
    // ★ P5: participation_links(제출 시점 확정 신원)도 단독 통과 키로 사용.
    //   기존 동작(이름 일치 + 전화 근접/NULL)도 그대로 유지(하위 호환).
    const phoneList = await _getReviewerPhoneList(p8);

    const nameParam = paramIdx++;
    const phoneListParam = paramIdx++;       // 본인+타계정 phone8 배열
    const phonePrefixParam = paramIdx++;     // 앞4자리 (오인식 구제)
    const phoneSuffixParam = paramIdx++;     // 뒤4자리 (오인식 구제)

    // ★ 제출완료 행은 강한 신원키(phone8/확정신원) 일치 시에만 포함 — 약한 키(이름+근접)는 대기 건만
    const submittedCond = includeSubmitted
      ? `(ri.is_submitted = FALSE OR ri.phone8 = ANY($${phoneListParam}) OR pl.phone8 = ANY($${phoneListParam}))`
      : 'ri.is_submitted = FALSE';

    sql = `
      SELECT ${SELECT_FIELDS},
             CASE
               WHEN ri.phone8 = ANY($${phoneListParam}) OR pl.phone8 = ANY($${phoneListParam}) THEN 1.0
               WHEN (REPLACE(ri.reviewer_name, ' ', '') = $${nameParam}
                     OR REPLACE(ri.recipient_name, ' ', '') = $${nameParam})
                    AND ri.phone8 IS NOT NULL AND (
                      SUBSTRING(ri.phone8, 1, 4) = $${phonePrefixParam}
                      OR SUBSTRING(ri.phone8, 5, 4) = $${phoneSuffixParam}
                    ) THEN 0.8
               WHEN (REPLACE(ri.reviewer_name, ' ', '') = $${nameParam}
                     OR REPLACE(ri.recipient_name, ' ', '') = $${nameParam}) THEN 0.6
               ELSE 0.5
             END::float AS score
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      LEFT JOIN participation_links pl
        ON pl.sheet_id = ri.sheet_id AND pl.tab_name = ri.tab_name AND pl.row_index = ri.row_index
      WHERE ${submittedCond}
        AND tc.sheet_id IS NOT NULL
        AND (
          ri.phone8 = ANY($${phoneListParam})          -- P0: 연락처 phone8 단독 통과
          OR pl.phone8 = ANY($${phoneListParam})        -- P5: 확정 신원 단독 통과
          OR (
            (REPLACE(ri.reviewer_name, ' ', '') = $${nameParam}
             OR REPLACE(ri.recipient_name, ' ', '') = $${nameParam})
            AND (
              ri.phone8 IS NULL
              OR SUBSTRING(ri.phone8, 1, 4) = $${phonePrefixParam}
              OR SUBSTRING(ri.phone8, 5, 4) = $${phoneSuffixParam}
            )
          )
        )
      ORDER BY ${orderPrefix}score DESC, ri.start_date DESC NULLS LAST
      LIMIT ${limit}
    `;
    params.push(q, phoneList, p8.substring(0, 4), p8.substring(4, 8));

  } else if (p8.length === 8) {
    // ── phone8 단독 검색 (이름 미입력) ──
    // ★ P0/P5: 본인+타계정 phone8 또는 확정 신원(participation_links)으로 매칭
    const phoneList = await _getReviewerPhoneList(p8);
    const phoneListParam = paramIdx++;
    // 이 분기는 매칭 자체가 강한 신원키(phone8/확정신원)뿐 → 제출완료 포함 시 필터만 해제
    const submittedCond = includeSubmitted ? 'TRUE' : 'ri.is_submitted = FALSE';
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      LEFT JOIN participation_links pl
        ON pl.sheet_id = ri.sheet_id AND pl.tab_name = ri.tab_name AND pl.row_index = ri.row_index
      WHERE ${submittedCond}
        AND tc.sheet_id IS NOT NULL
        AND (ri.phone8 = ANY($${phoneListParam}) OR pl.phone8 = ANY($${phoneListParam}))
      ORDER BY ${orderPrefix}ri.start_date DESC NULLS LAST
      LIMIT ${limit}
    `;
    params.push(phoneList);

  } else {
    // ── 이름만 검색 (정확 일치) ──
    // reviewer_name이 검색어와 정확히 일치하는 경우만 반환
    // 공백 제거 후 비교: "김 수 만" == "김수만"
    // ★ reviewer_name OR recipient_name 매칭 (수취인 검색 지원)
    // ★ 이름 단독 분기는 includeSubmitted 무시(항상 대기 건만) — 무인증 이름 조회로
    //   타인의 제출 이력이 노출되는 것을 차단
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
    const results = filteredRows.map(row => {
      const rowObj = _parseRowJson(row.rowJson);
      return {
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
      captureSlots: Array.isArray(row.captureSlots) && row.captureSlots.length ? row.captureSlots : null,
      submittedSlots: [],   // 아래에서 다중 슬롯 행에 한해 채움
      // ★ 제출완료 행은 행 전체 JSON을 반환하지 않는다(데이터 최소화 — 완료 탭 표시에 불필요)
      row:         row.isSubmitted ? {} : rowObj,
      submitCol:   row.isSubmitted ? null : row.submitCol,
      reviewFileAt: row.reviewFileAt || null, // 대표 리뷰 이미지 연결 시각 (제출완료 탭 표시용)
      isPaid:      _isPaid(row.isSubmitted2, rowObj), // 입금완료 배지용 (row 비우기 전 판정)
      score:       row.score, // 유사도 점수 (1.0=정확매칭, <1.0=유사매칭)
      };
    });

    // ── 다중 캡처 슬롯 행: 이미 제출된 슬롯(submittedSlots) 일괄 조회 ──
    //   captureSlots가 있는 행이 하나라도 있을 때만 1회 배치 쿼리 (단일 슬롯 검색은 비용 0)
    const multiSlotItems = results.filter(r => r.captureSlots);
    if (multiSlotItems.length > 0) {
      try {
        const keyOf = (sheetId, tabName, rowIndex) => `${sheetId} ${tabName} ${rowIndex}`;
        const sheetIds = [...new Set(multiSlotItems.map(r => r.sheetId))];
        const tabNames = [...new Set(multiSlotItems.map(r => r.tabName))];
        const rowIdxs  = [...new Set(multiSlotItems.map(r => r.rowIndex))];
        const { rows: subRows } = await pool.query(
          `SELECT sheet_id, tab_name, row_index, slot_key
             FROM review_submissions
            WHERE sheet_id = ANY($1) AND tab_name = ANY($2) AND row_index = ANY($3)`,
          [sheetIds, tabNames, rowIdxs]
        );
        const coverMap = new Map();
        for (const sr of subRows) {
          const k = keyOf(sr.sheet_id, sr.tab_name, sr.row_index);
          if (!coverMap.has(k)) coverMap.set(k, new Set());
          coverMap.get(k).add(sr.slot_key);
        }
        for (const item of multiSlotItems) {
          const covered = coverMap.get(keyOf(item.sheetId, item.tabName, item.rowIndex));
          item.submittedSlots = covered ? [...covered] : [];
        }
      } catch (slotErr) {
        logger.warn('[Search] submittedSlots 조회 실패 (무시): ' + slotErr.message);
      }
    }

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
      return searchByNameFallback(q, p8, SELECT_FIELDS, includeSubmitted);
    }
    throw new Error('검색 쿼리 오류: ' + err.message);
  }
}

/**
 * pg_trgm 미설치 시 fallback (기존 ILIKE 방식)
 */
async function searchByNameFallback(q, p8, SELECT_FIELDS, includeSubmitted) {
  let sql;
  const params = [];
  let paramIdx = 1;
  // ★ 보안 가드(본검색과 동일): 제출완료 행은 phone8 정확 일치 매칭에만 포함,
  //   이름 매칭(ILIKE 부분일치 포함)에는 절대 열지 않는다
  const orderPrefix = includeSubmitted ? 'ri.is_submitted ASC, ' : '';
  const limit = includeSubmitted ? 400 : 200;

  if (q && p8.length === 8) {
    // ★ P0/P5: phone8(연락처) 또는 확정 신원(pl) 일치 시 이름 불일치여도 통과
    const nameParam = paramIdx++;
    const phoneParam = paramIdx++;
    const submittedCond = includeSubmitted
      ? `(ri.is_submitted = FALSE OR ri.phone8 = $${phoneParam} OR pl.phone8 = $${phoneParam})`
      : 'ri.is_submitted = FALSE';
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      LEFT JOIN participation_links pl
        ON pl.sheet_id = ri.sheet_id AND pl.tab_name = ri.tab_name AND pl.row_index = ri.row_index
      WHERE ${submittedCond}
        AND tc.sheet_id IS NOT NULL
        AND (
          ri.phone8 = $${phoneParam}
          OR pl.phone8 = $${phoneParam}
          OR ri.reviewer_name ILIKE $${nameParam}
          OR ri.recipient_name ILIKE $${nameParam}
        )
      ORDER BY ${orderPrefix}ri.start_date DESC NULLS LAST
      LIMIT ${limit}
    `;
    params.push(`%${q}%`, p8);
  } else if (p8.length === 8) {
    const phoneParam = paramIdx++;
    const submittedCond = includeSubmitted ? 'TRUE' : 'ri.is_submitted = FALSE';
    sql = `
      SELECT ${SELECT_FIELDS}
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      LEFT JOIN participation_links pl
        ON pl.sheet_id = ri.sheet_id AND pl.tab_name = ri.tab_name AND pl.row_index = ri.row_index
      WHERE ${submittedCond}
        AND tc.sheet_id IS NOT NULL
        AND (ri.phone8 = $${phoneParam} OR pl.phone8 = $${phoneParam})
      ORDER BY ${orderPrefix}ri.start_date DESC NULLS LAST
      LIMIT ${limit}
    `;
    params.push(p8);
  } else {
    // ★ 이름 단독 분기는 includeSubmitted 무시(항상 대기 건만)
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

  const results = filteredRows.map(row => {
    const rowObj = _parseRowJson(row.rowJson);
    return {
    displayName: (row.idxName || '').split('/')[0],
    idxName:     row.idxName,
    recipientName: row.recipientName || '',
    campaignName: row.tcCampaignName || row.campaignName || '',
    tabName:     row.tabName,
    sheetId:     row.sheetId,
    gid:         row.gid,
    rowIndex:    row.rowIndex,
    isSubmitted: row.isSubmitted,
    productName: row.productName,
    productUrl:  row.productUrl,
    startDate:   row.startDate,
    endDate:     row.endDate,
    round:       row.round,
    displayNameTC: row.displayName,
    folderUrl:   row.folderUrl,
    captureFolderUrl: row.captureFolderUrl,
    captureSlots: Array.isArray(row.captureSlots) && row.captureSlots.length ? row.captureSlots : null,
    submittedSlots: [],
    // ★ 제출완료 행은 행 전체 JSON 미반환 (본검색과 동일한 데이터 최소화)
    row:         row.isSubmitted ? {} : rowObj,
    submitCol:   row.isSubmitted ? null : row.submitCol,
    reviewFileAt: row.reviewFileAt || null,
    isPaid:      _isPaid(row.isSubmitted2, rowObj),
    };
  });

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

module.exports = { searchByName, searchByNameDebug, _getReviewerPhoneList };
