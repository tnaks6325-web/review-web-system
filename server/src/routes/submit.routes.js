const express = require('express');
const router = express.Router();
const { writeSheet, readSheet, appendSheet, getSpreadsheetMeta, batchReadSheet, batchUpdateSheet } = require('../services/sheets.service');
const { throttledCall } = require('../utils/sheetsThrottle');
const { enqueue } = require('../services/syncQueue.service');
const { logAbnormal } = require('../services/errorLog.service');
const {
  createOrderLedgerEntry,
  markOrderQueued,
  markOrderMirrorFailed,
} = require('../services/orderLedger.service');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { emitReviewSubmit, emitOrderSubmit } = require('../utils/sse');
const { authMiddleware } = require('../middleware/auth.middleware');

// ═══════════════════════════════════════════════════════════
// 캡처 슬롯 유틸 — 탭의 capture_slots(JSONB)에서 필요 슬롯 key 목록 추출
//   NULL/[] = 단일 암묵 'review' 슬롯 (기존 동작 그대로)
// ═══════════════════════════════════════════════════════════
function requiredSlotKeys(captureSlots) {
  if (!Array.isArray(captureSlots) || captureSlots.length === 0) return ['review'];
  const keys = captureSlots.map(s => s && s.key).filter(Boolean);
  return keys.length ? keys : ['review'];
}

// ═══════════════════════════════════════════════════════════
// 한국 실명 판별 유틸리티
// ═══════════════════════════════════════════════════════════
const KOREAN_SURNAMES = new Set([
  '김','이','박','최','정','강','조','윤','장','임','한','오','서','신','권','황','안','송','류','전',
  '홍','고','문','양','손','배','백','허','유','남','노','하','곽','성','차','주','우','구','라','민',
  '진','엄','채','원','천','방','공','탁','봉','석','선','설','마','길','연','위','표','도','사','변',
  '추','염','기','반','피','왕','금','육','옥','현','제','맹','태','소','전','탁','국','어','경',
  '복','예','편','팽','모','장','여','나','범','평','승','심','단','감','상','두','온','점','습',
  '독고','남궁','사공','황보','제갈','선우'
]);

/**
 * 한국 실명 여부 판별
 * - 순수 한글 2~4글자
 * - 첫 글자(또는 첫 2글자)가 한국 성씨
 */
function _isKoreanRealName(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  // 순수 한글만 허용 (2~4글자)
  if (!/^[가-힣]{2,4}$/.test(s)) return false;
  // 복성 체크 (2글자 성)
  if (s.length >= 3 && KOREAN_SURNAMES.has(s.slice(0, 2))) return true;
  // 단성 체크 (1글자 성)
  if (KOREAN_SURNAMES.has(s[0])) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════
// 헤더 캐시 — 같은 탭의 헤더를 5분간 캐시 (Phase 3 최적화)
// ═══════════════════════════════════════════════════════════
const headerCache = new Map();
const HEADER_CACHE_TTL = 5 * 60 * 1000; // 5분

// 탭 전체 데이터 캐시 (슬롯 매칭용, 3분)
// ★ B1: 1분→3분 연장 (Sheets API 호출 감소, 슬롯 정보 3분 이내 변경 가능성 낮음)
const tabDataCache = new Map();
const TAB_DATA_CACHE_TTL = 3 * 60 * 1000; // 3분

// 헤더 행 자동 감지용 키워드 (smartBuild _isDataTabRow와 동일 로직)
const HEADER_DETECT_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호', '아이디', '주소'];

// 인애드명 컬럼 감지 키워드
const INAD_COL_KEYWORDS = ['인애드', '인애드명', '인애드제출', '카톡', '카카오', '닉네임'];

// ★ FILLED_THRESHOLD: 이 수 이상 셀이 채워진 행은 절대 덮어쓰지 않음 (데이터 보호)
const FILLED_THRESHOLD = 4;

/** 행의 채워진 셀 수를 계산 (숫자 0은 빈 값으로 취급) */
function _countFilledCells(row) {
  return (row || []).filter(cell => {
    const val = String(cell || '').trim();
    return val !== '' && val !== '0';
  }).length;
}

function _isHeaderRow(cells) {
  let matchCount = 0;
  for (const kw of HEADER_DETECT_KEYWORDS) {
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

async function getCachedHeaders(sheetId, tabName, opts = {}) {
  const key = `${sheetId}||${opts.gid || tabName}`;
  const cached = headerCache.get(key);
  if (cached && Date.now() - cached.ts < HEADER_CACHE_TTL) {
    return cached.headers;
  }

  // 상위 50행을 읽어서 실제 헤더 행을 동적으로 탐색
  // ★ opts.gid가 있으면 GID 기반 조회로 탭 이름 변경에도 안전
  // ★ 글로벌 throttle로 감싸 읽기 쿼터 초과를 구조적으로 차단 (한도 근접 시 대기)
  const allRows = await throttledCall(() => readSheet(sheetId, `'${tabName}'!A1:ZZ50`, opts));
  if (!allRows || allRows.length === 0) return null;

  let headerRow = null;
  for (let i = 0; i < allRows.length; i++) {
    const cells = (allRows[i] || []).map(c => String(c || '').trim());
    if (_isHeaderRow(cells)) {
      headerRow = cells;
      logger.info(`[getCachedHeaders] 헤더 발견: ${tabName} → ${i + 1}행 (키워드 매칭)`);
      break;
    }
  }

  if (!headerRow) {
    // fallback: 1행을 헤더로 사용 (기존 동작)
    const firstRow = (allRows[0] || []).map(c => String(c || '').trim());
    if (firstRow.length > 0 && firstRow.some(c => c)) {
      headerRow = firstRow;
      logger.warn(`[getCachedHeaders] 헤더 감지 실패 → fallback 1행 사용: ${tabName}`);
    }
  }

  if (headerRow) {
    headerCache.set(key, { headers: headerRow, ts: Date.now() });
    return headerRow;
  }
  return null;
}

/**
 * 탭 전체 데이터 캐시 (헤더행 + 데이터행 포함)
 * 슬롯 매칭에서 인애드명 컬럼 스캔용
 */
async function getCachedTabData(sheetId, tabName, opts = {}) {
  const key = `${sheetId}||${opts.gid || tabName}`;
  const cached = tabDataCache.get(key);
  if (cached && Date.now() - cached.ts < TAB_DATA_CACHE_TTL) {
    return cached;
  }

  // 전체 탭 데이터 읽기 (최대 500행)
  // ★ opts.gid가 있으면 GID 기반 조회로 탭 이름 변경에도 안전
  // ★ 글로벌 throttle로 감싸 읽기 쿼터 초과를 구조적으로 차단 (한도 근접 시 대기)
  const allRows = await throttledCall(() => readSheet(sheetId, `'${tabName}'!A1:ZZ500`, opts));
  if (!allRows || allRows.length === 0) return null;

  // 헤더 행 탐지 (상위 설정 영역이 30행 이상일 수 있으므로 50행까지 탐색)
  let headerRowIdx = -1;
  let headers = null;
  for (let i = 0; i < Math.min(allRows.length, 50); i++) {
    const cells = (allRows[i] || []).map(c => String(c || '').trim());
    if (_isHeaderRow(cells)) {
      headerRowIdx = i;
      headers = cells;
      break;
    }
  }
  if (headerRowIdx < 0) return null;

  const dataRows = allRows.slice(headerRowIdx + 1);
  const result = { headers, headerRowIdx, dataRows, ts: Date.now() };
  tabDataCache.set(key, result);
  return result;
}

// ═══════════════════════════════════════════════════════════
// 진단: 시트 탭 이름 목록 조회 (디버그용)
// ═══════════════════════════════════════════════════════════
router.post('/debug-tabs', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId } = req.body;
    if (!sheetId) return res.json({ ok: false, error: 'sheetId 필요' });
    const meta = await getSpreadsheetMeta(sheetId);
    const tabs = (meta || []).map(s => ({
      title: s.properties?.title,
      gid: s.properties?.sheetId,
      hidden: s.properties?.hidden || false,
    }));
    return res.json({ ok: true, tabs });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 진단: 시트 데이터 조회 (헤더 감지 디버그용)
// ═══════════════════════════════════════════════════════════
router.post('/debug-sheet-data', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rows = 10 } = req.body;
    if (!sheetId || !tabName) return res.json({ ok: false, error: 'sheetId, tabName 필요' });
    const allRows = await readSheet(sheetId, `'${tabName}'!A1:ZZ${rows}`);
    // 각 행에 대해 _isHeaderRow 결과도 함께 반환
    const analyzed = (allRows || []).map((row, i) => {
      const cells = (row || []).map(c => String(c || '').trim());
      return { rowIdx: i, isHeader: _isHeaderRow(cells), cells: cells.slice(0, 20) };
    });
    return res.json({ ok: true, rowCount: (allRows || []).length, analyzed });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/submit/diag-tabs — tab_configs 데이터 진단 (캠페인/탭명 확인용)
// ═══════════════════════════════════════════════════════════
router.get('/diag-tabs', authMiddleware, async (req, res) => {
  try {
    const { sheetId } = req.query;
    if (!sheetId) return res.json({ ok: false, error: 'sheetId 필요' });
    const { rows } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, tab_gid, sheet_url, display_name
       FROM tab_configs WHERE sheet_id = $1
       ORDER BY tab_name LIMIT 30`,
      [sheetId]
    );
    res.json({ ok: true, total: rows.length, tabs: rows });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/submit/slot-status — slot_locks 테이블 상태 확인 (진단용)
// ═══════════════════════════════════════════════════════════
router.get('/slot-status', authMiddleware, async (req, res) => {
  try {
    const { rows: tableCheck } = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'slot_locks'
      ) AS "exists"
    `);
    const tableExists = tableCheck[0]?.exists || false;
    if (!tableExists) {
      return res.json({ ok: true, tableExists: false });
    }
    const { rows: stats } = await pool.query(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE is_submitted = TRUE) AS submitted
      FROM slot_locks
    `);
    res.json({ ok: true, tableExists: true, stats: stats[0] });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/submit/get-inaed-list — 시트에서 인애드명단+옵션 목록 조회
//
// 구매양식 옵션 피커용: 시트 헤더에서 옵션 컬럼(최대 3개) 감지,
// 인애드명 컬럼의 데이터행에서 이름+옵션 조합을 추출하여 반환
// ═══════════════════════════════════════════════════════════
const OPTION_COL_KEYWORDS = ['옵션', 'option'];
const MAX_OPTION_COLS = 3;
const MEMO_COL_KEYWORDS = ['비고', '메모', '특이사항', 'memo', 'note'];
const ORDERNUM_COL_KEYWORDS = ['주문번호', 'ordernum', 'order_num', 'order number'];
const DATE_COL_KEYWORDS = ['구매일자', '주문일자', '구매날짜', 'purchase_date'];

router.get('/get-inaed-list', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName } = req.query;
    let round = req.query.round || '';
    if (!sheetId || !tabName) {
      return res.json({ ok: false, error: 'sheetId와 tabName이 필요합니다.' });
    }

    const sheetOpts = gid ? { gid } : {};

    // 전체 탭 데이터 로드 (캐시 활용)
    const tabData = await getCachedTabData(sheetId, tabName, sheetOpts);
    if (!tabData || !tabData.headers) {
      return res.json({ ok: true, names: [], optionHeaders: [], memoHeader: '', orderNumHeader: '' });
    }

    const headers = tabData.headers;
    const dataRows = tabData.dataRows;

    // ── 인애드명 컬럼 감지 ──
    let inadColIdx = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (INAD_COL_KEYWORDS.some(kw => h.includes(kw))) {
        inadColIdx = i;
        break;
      }
    }

    // ── 차수(round) 컬럼 감지 ──
    const ROUND_COL_KEYWORDS = ['회차', '차수', 'round'];
    let roundColIdx = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (ROUND_COL_KEYWORDS.some(kw => h.includes(kw))) {
        roundColIdx = i;
        break;
      }
    }

    // ★★★ round 미지정 시 최신 활성 차수 자동 감지 ★★★
    if (!round && roundColIdx >= 0) {
      // 1) tab_configs에서 closed/archived 차수 목록 조회
      let closedSet = new Set();
      try {
        const { rows: tcRows } = await pool.query(
          'SELECT closed_rounds, archived_rounds FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );
        if (tcRows.length > 0) {
          const closedRounds = (tcRows[0].closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
          const archivedRounds = (tcRows[0].archived_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
          closedSet = new Set([...closedRounds, ...archivedRounds]);
        }
      } catch (_) { /* 무시 */ }

      // 2) 시트 데이터에서 모든 차수 추출
      const allRoundsInSheet = new Set();
      for (const row of dataRows) {
        const rv = String(row[roundColIdx] || '').trim();
        if (rv) allRoundsInSheet.add(rv);
      }

      // 3) 활성(미마감) 차수 중 가장 최신(숫자 큰) 것 선택
      const activeRounds = [...allRoundsInSheet]
        .filter(r => !closedSet.has(r))
        .sort((a, b) => {
          const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
          const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
          return numA - numB;
        });
      if (activeRounds.length > 0) {
        round = activeRounds[activeRounds.length - 1]; // 최신 활성 차수
      }
    }

    // ── 옵션 컬럼 감지 (최대 3개, 연속) ──
    const optionColIndices = [];
    const optionHeaders = [];
    for (let i = 0; i < headers.length && optionColIndices.length < MAX_OPTION_COLS; i++) {
      const h = headers[i].toLowerCase();
      if (OPTION_COL_KEYWORDS.some(kw => h.includes(kw))) {
        optionColIndices.push(i);
        optionHeaders.push(headers[i]);
      }
    }

    // ── 비고 컬럼 감지 ──
    let memoHeader = '';
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (MEMO_COL_KEYWORDS.some(kw => h.includes(kw))) {
        memoHeader = headers[i];
        break;
      }
    }

    // ── 주문번호 컬럼 감지 ──
    let orderNumHeader = '';
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (ORDERNUM_COL_KEYWORDS.some(kw => h.includes(kw))) {
        orderNumHeader = headers[i];
        break;
      }
    }

    // ── 날짜 컬럼 감지 ──
    let dateColIdx = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase();
      if (DATE_COL_KEYWORDS.some(kw => h.includes(kw))) {
        dateColIdx = i;
        break;
      }
    }

    // ── 데이터행에서 인애드명+옵션 추출 (★ 차수 필터링 적용) ──
    const names = [];
    for (let ri = 0; ri < dataRows.length; ri++) {
      const row = dataRows[ri] || [];

      // ★ 차수 필터: round가 지정되어 있고 차수 컬럼이 있으면 해당 차수만
      if (round && roundColIdx >= 0) {
        const rowRound = String(row[roundColIdx] || '').trim();
        if (rowRound !== round) continue;
      }

      // 인애드명이 없으면 스킵
      const name = inadColIdx >= 0 ? String(row[inadColIdx] || '').trim() : '';
      if (!name) continue;

      // 옵션 값 추출
      const options = optionColIndices.map(ci => String(row[ci] || '').trim());

      // 날짜 값
      const date = dateColIdx >= 0 ? String(row[dateColIdx] || '').trim() : '';

      // 실제 시트 행 번호 (1-based): headerRowIdx + 1(헤더행) + ri + 1(1-based)
      const rowIndex = tabData.headerRowIdx + 1 + ri + 1;

      names.push({ name, date, options, rowIndex });
    }

    logger.info(`[get-inaed-list] sheet=${sheetId}, tab=${tabName}, round=${round || '(auto)'} → ${names.length}명, 옵션헤더: [${optionHeaders.join(',')}]`);

    return res.json({
      ok: true,
      names,
      optionHeaders,
      memoHeader,
      orderNumHeader,
      detectedRound: round || '',  // 프론트엔드에 감지된 차수 알려줌
    });

  } catch (err) {
    logger.error(`[get-inaed-list] 오류: ${err.message}`);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 슬롯 매칭 API — 구매양식 제출 시 자동 행 매칭
//
// 규칙:
//   1순위: 로그인 이름 == 인애드명 정확 일치 → 위에서부터 빈 행
//   2순위: 일치 없으면 → "실명이 아닌" 인애드명 행 중 위에서부터 빈 행 (선착순)
// ═══════════════════════════════════════════════════════════
router.post('/find-slot', async (req, res, next) => {
  try {
    // ★ 슬롯 매칭 비활성화 — 항상 append 모드 (위에서부터 순서대로 기입)
    return res.json({ ok: true, mode: 'append', reason: 'slot_matching_disabled' });
  } catch (err) {
    logger.error(`[submit/find-slot] 오류: ${err.message}`);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/submit/review — 리뷰 제출
//
// Phase 3 개선:
//   1. DB 즉시 업데이트 (is_submitted = TRUE)
//   2. Sheets 동시 쓰기 시도
//   3. Sheets 실패 시 → sync_queue에 등록 (자동 재시도)
//   4. 헤더 캐시 적용 (5분)
// ═══════════════════════════════════════════════════════════
router.post('/review', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, rowIndex, submitCol, value, phone8, memo } = req.body;

    if (!sheetId || !tabName || !rowIndex) {
      return res.json({ error: '필수 파라미터 누락 (sheetId, tabName, rowIndex)' });
    }

    const submitValue = value || '제출';
    const sheetOpts = gid ? { gid } : {};

    // ── Step 1: 완료 판정 + DB 업데이트 ──
    //   다중 캡처 슬롯 탭(예: 리뷰+현금영수증)은 "필요 슬롯 전부 제출"되어야 완료.
    //   업로드(/api/image/review-upload)가 submitReview보다 먼저 실행되어 원장
    //   (review_submissions.slot_key)이 이미 채워져 있다는 전제(프론트 보장).
    //   단일 슬롯(기존 탭, capture_slots NULL) = fast-path로 기존 동작 그대로.
    let dbUpdated = false;     // is_submitted=TRUE 로 전이/유지되었는지
    let complete = true;       // 모든 필요 슬롯 충족 여부
    let missingSlots = [];
    try {
      // 탭의 필요 슬롯 + 현재 행의 is_submitted 조회
      const { rows: ctxRows } = await pool.query(
        `SELECT tc.capture_slots AS capture_slots, ri.is_submitted AS is_submitted
           FROM review_index ri
           LEFT JOIN tab_configs tc
             ON tc.sheet_id = ri.sheet_id AND tc.tab_name = ri.tab_name
          WHERE ri.sheet_id = $1 AND ri.tab_name = $2 AND ri.row_index = $3
          LIMIT 1`,
        [sheetId, tabName, rowIndex]
      );
      const wasSubmitted = ctxRows[0]?.is_submitted === true;
      const required = requiredSlotKeys(ctxRows[0]?.capture_slots);
      const isMultiSlot = !(required.length === 1 && required[0] === 'review');

      if (isMultiSlot) {
        // 원장에서 이 행의 제출된 distinct 슬롯 조회
        const { rows: slotRows } = await pool.query(
          `SELECT DISTINCT slot_key FROM review_submissions
            WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
          [sheetId, tabName, rowIndex]
        );
        const covered = new Set(slotRows.map(r => r.slot_key));
        missingSlots = required.filter(k => !covered.has(k));
        complete = missingSlots.length === 0;
      }

      if (complete) {
        // 완료 → is_submitted=TRUE (멱등). 이미 TRUE여도 안전.
        const result = await pool.query(
          `UPDATE review_index SET is_submitted = TRUE, built_at = NOW()
           WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
          [sheetId, tabName, rowIndex]
        );
        dbUpdated = result.rowCount > 0;

        // index_master 카운트: FALSE→TRUE 전이일 때만 증가 (보완 제출 중복 방지)
        if (dbUpdated && !wasSubmitted) {
          try {
            await pool.query(
              `UPDATE index_master
               SET submitted_count = submitted_count + 1
               WHERE sheet_id = $1 AND tab_name = $2
                 AND submitted_count < row_count`,
              [sheetId, tabName]
            );
          } catch (_) { /* 대시보드 카운트 보조 — 실패해도 무시 */ }
        }
      } else {
        // 부분 제출 → is_submitted 유지(FALSE), 타임스탬프만 갱신해 행 재오픈 상태 유지
        await pool.query(
          `UPDATE review_index SET built_at = NOW()
           WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
          [sheetId, tabName, rowIndex]
        );
        logger.info(`[submit/review] 부분 제출 — 미충족 슬롯: ${missingSlots.join(', ')} (row=${rowIndex})`);
      }
    } catch (dbErr) {
      logger.warn(`[submit/review] DB 업데이트 실패: ${dbErr.message}`);
    }

    // ── ★ Step 2: 즉시 응답 반환 (DB 저장 완료 = 제출 성공) ──
    // Sheets 쓰기는 백그라운드에서 처리 → 사용자 대기 제거
    emitReviewSubmit({
      tabName,
      sheetId,
      reviewer: req.body.reviewerName || '',
      rowIndex,
      dbUpdated,
      sheetsWritten: false,
    });

    res.json({
      ok: true,
      submitted: submitValue,
      complete,                  // 모든 필요 슬롯 충족 여부 (다중 슬롯 탭)
      missingSlots,              // 아직 미제출인 슬롯 key 목록
      dbUpdated,
      sheetsWritten: false,  // Sheets는 백그라운드에서 처리
      queued: true,          // 항상 큐 처리 방식
    });

    // ── ★ Step 3: 백그라운드 Sheets 쓰기 (응답 후 비동기 처리) ──
    const SHEETS_TIMEOUT_MS = 15000;

    setImmediate(async () => {
      try {
        const sheetsPromise = (async () => {
          const headers = await getCachedHeaders(sheetId, tabName, sheetOpts);
          if (!headers) throw new Error('헤더를 가져올 수 없음');

          const colIdx = headers.findIndex(h => h === submitCol);
          if (colIdx < 0) throw new Error(`submitCol '${submitCol}' 을 헤더에서 찾을 수 없음`);

          const colLetter = getColLetter(colIdx);
          const range = `'${tabName}'!${colLetter}${rowIndex}`;
          // ★ 글로벌 throttle (멱등 쓰기 — 같은 셀에 고정값 기록이라 재시도/중복 안전)
          await throttledCall(() => writeSheet(sheetId, range, [[submitValue]], sheetOpts));
          logger.info(`[submit/review:bg] Sheets 쓰기 성공 (sheet=${sheetId}, tab=${tabName}, row=${rowIndex})`);

          // ── 비고/포스팅 컬럼 쓰기 ──
          if (memo && memo.trim()) {
            // 우선순위: "비고" 정확히 포함 > "포스팅" 포함
            let memoColIdx = headers.findIndex(h => /비고/.test((h || '').trim()));
            if (memoColIdx < 0) {
              memoColIdx = headers.findIndex(h => /포스팅/.test((h || '').trim()));
            }
            if (memoColIdx >= 0) {
              const memoColLetter = getColLetter(memoColIdx);
              const memoRange = `'${tabName}'!${memoColLetter}${rowIndex}`;
              await throttledCall(() => writeSheet(sheetId, memoRange, [[memo.trim()]], sheetOpts));
              logger.info(`[submit/review:bg] 비고 컬럼 쓰기 성공 (col=${headers[memoColIdx]}, colIdx=${memoColIdx}, row=${rowIndex})`);
            } else {
              logger.warn(`[submit/review:bg] 비고/포스팅 컬럼을 찾을 수 없음 (headers: ${headers.slice(0, 30).join(',')})`);
            }
          }
        })();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Sheets 쓰기 타임아웃 (15초)')), SHEETS_TIMEOUT_MS)
        );

        await Promise.race([sheetsPromise, timeoutPromise]);
      } catch (bgErr) {
        logger.warn(`[submit/review:bg] Sheets 쓰기 실패 → 큐 등록: ${bgErr.message}`);
        logAbnormal({
          flow: 'review_submit', step: 'sheet_write', severity: 'warn', error: bgErr,
          context: { sheetId, tabName, rowIndex, queued: true },
        });
        try {
          await enqueue('review_submit', {
            sheetId,
            tabName,
            rowIndex,
            submitCol,
            value: submitValue,
            memo: memo || '',
          });
        } catch (queueErr) {
          logger.error(`[submit/review:bg] 큐 등록도 실패: ${queueErr.message}`);
          logAbnormal({
            flow: 'sync_queue', step: 'enqueue', severity: 'critical', error: queueErr,
            context: { sheetId, tabName, type: 'review_submit' },
          });
        }
      }
    });

  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/submit/debug-headers — 시트 헤더 확인 (디버그용)
// ═══════════════════════════════════════════════════════════
router.get('/debug-headers', async (req, res) => {
  try {
    const { sheetId, tabName, gid, rowIndex } = req.query;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });
    const sheetOpts = gid ? { gid } : {};
    const headers = await getCachedHeaders(sheetId, tabName, sheetOpts);
    if (!headers) return res.json({ ok: false, error: '헤더를 가져올 수 없음' });

    // 비고/포스팅 컬럼 검색
    let bigoIdx = headers.findIndex(h => /비고/.test((h || '').trim()));
    let postingIdx = headers.findIndex(h => /포스팅/.test((h || '').trim()));

    const result = {
      ok: true,
      headerCount: headers.length,
      headers,
      bigoCol: bigoIdx >= 0 ? { idx: bigoIdx, name: headers[bigoIdx], letter: getColLetter(bigoIdx) } : null,
      postingCol: postingIdx >= 0 ? { idx: postingIdx, name: headers[postingIdx], letter: getColLetter(postingIdx) } : null,
    };

    // rowIndex가 지정되면 해당 행의 특정 셀 값도 읽기
    if (rowIndex) {
      const row = parseInt(rowIndex);
      const range = `'${tabName}'!A${row}:ZZ${row}`;
      const rowData = await readSheet(sheetId, range, sheetOpts);
      if (rowData && rowData[0]) {
        const cells = rowData[0];
        result.rowData = {};
        headers.forEach((h, i) => {
          if (h && cells[i] !== undefined && cells[i] !== '') {
            result.rowData[h] = String(cells[i]);
          }
        });
        // 특히 비고 컬럼 값 별도 표시
        if (bigoIdx >= 0) result.bigoValue = cells[bigoIdx] !== undefined ? String(cells[bigoIdx]) : '(empty)';
        if (postingIdx >= 0) result.postingValue = cells[postingIdx] !== undefined ? String(cells[postingIdx]) : '(empty)';
      }
    }

    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/submit/order — 구매양식 제출
//
// Phase 5 개선: 슬롯 매칭 시스템
//   1. DB 즉시 저장 (order_submissions)
//   2. 슬롯 매칭: rowNumber 있으면 writeSheet (기존 행 덮어쓰기)
//      없으면 appendSheet (기존 동작 유지)
//   3. Sheets 실패 시 → sync_queue에 등록
//   4. 중복 검사 DB 전용 (Phase 4와 동일)
// ═══════════════════════════════════════════════════════════
router.post('/order', async (req, res, next) => {
  try {
    const b = req.body;
    const { sheetId, gid, tabName, orderer, recipient, userId, phone,
            address, bank, account, depositor, price, dateStr, orderNum,
            memo, selectedOptKey, isCoupang, ncMode,
            // ★ 슬롯 매칭 파라미터 (find-slot에서 받은 값)
            slotRowNumber, slotInadName, loginPhone8, loginName } = b;

    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId와 tabName이 필요합니다.' });
    }

    const orderData = { orderer, recipient, userId, phone, address, bank, account, depositor, price, dateStr, orderNum, memo, selectedOptKey };
    const ledger = await createOrderLedgerEntry({
      sheetId, tabName, gid,
      orderData,
      slotRowNumber: slotRowNumber || null,
      loginPhone8: loginPhone8 || '',
      loginName: loginName || '',
    });

    // ★ 신원 기록(recordParticipationLink/recordReviewIdentity)은 여기서 하지 않는다.
    //   제출 시점의 ledger.sheetRow는 RAW 미러 스냅샷 기반 "빈 행" 추정치라,
    //   미러 stale·로스터 선기입 탭에서는 '다른 리뷰어의 행'을 가리킬 수 있다.
    //   가드 전에 그 행에 phone8을 찍으면(=리뷰어 교차노출 버그) review_index/participation_links가 오염된다.
    //   → 신원 기록은 큐 워커(syncQueue order_append)에서 "다중컬럼 가드 통과 + 실제 시트쓰기 성공 후,
    //     실제로 쓴 행에만" 수행한다(거기서만 신뢰 가능한 시트행↔phone8 링크가 확정됨).

    let queued = false;
    if (ledger.sheetRow) {
      try {
        await enqueue('order_append', {
          sheetId,
          tabName,
          gid: ledger.tabGid || gid || '',
          orderData,
          orderSubmissionId: ledger.orderSubmissionId,
          sheetRow: ledger.sheetRow,
          dedupKey: ledger.dedupKey,
          loginPhone8: loginPhone8 || '',
          loginName: loginName || '',
        });
        await markOrderQueued(ledger.orderSubmissionId);
        queued = true;
      } catch (queueErr) {
        logger.error(`[submit/order] 큐 등록 실패: ${queueErr.message}`);
        await markOrderMirrorFailed(ledger.orderSubmissionId, queueErr);
        logAbnormal({
          flow: 'sync_queue', step: 'enqueue', severity: 'critical', error: queueErr,
          context: { sheetId, tabName, type: 'order_append', orderSubmissionId: ledger.orderSubmissionId },
        });
      }
    } else {
      logger.warn(`[submit/order] RAW 행 배정 실패: sheet=${sheetId}, tab=${tabName}, orderSubmissionId=${ledger.orderSubmissionId}`);
      logAbnormal({
        flow: 'order_submit', step: 'row_claim', severity: 'warn',
        error: new Error('RAW 미러 기반 행 배정 실패'),
        context: { sheetId, tabName, orderSubmissionId: ledger.orderSubmissionId },
      });
    }

    res.json({
      ok: true,
      dbSaved: true,
      sheetsWritten: false,
      queued,
      usedSlot: !!slotRowNumber,
      slotRowNumber: slotRowNumber ? parseInt(slotRowNumber) : null,
      sheetRow: ledger.sheetRow,
      orderSubmissionId: ledger.orderSubmissionId,
      mirrorStatus: queued ? 'queued' : (ledger.sheetRow ? 'failed' : 'pending_no_row'),
    });

    emitOrderSubmit({
      tabName, sheetId,
      orderer: orderer || '', recipient: recipient || '',
      dbSaved: true, sheetsWritten: false, queued, usedSlot: !!slotRowNumber,
      sheetRow: ledger.sheetRow,
    });

  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/submit/check-duplicate — 중복 검사
//
// Phase 4: DB 전용 전환
//   - Sheets readSheet 호출 완전 제거
//   - order_submissions + review_index 기반 검사
//   - 응답시간: 5~15초 → 3ms
// ═══════════════════════════════════════════════════════════
router.post('/check-duplicate', async (req, res, next) => {
  try {
    const { sheetId, tabName, userId, dateStr, orderNum, recipient, phone, address } = req.body;
    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId, tabName 필요' });
    }

    // ── DB 기반 중복 검사 (Sheets 읽기 완전 제거) ──
    let isDuplicate = false;

    // 1차: order_submissions 테이블에서 검사
    if (userId || orderNum) {
      const conditions = ['sheet_id = $1', 'tab_name = $2'];
      const params = [sheetId, tabName];
      let idx = 3;

      if (userId) { conditions.push(`user_id = $${idx++}`); params.push(userId); }
      if (orderNum) { conditions.push(`order_num = $${idx++}`); params.push(orderNum); }

      const { rows } = await pool.query(
        `SELECT COUNT(*) FROM order_submissions WHERE ${conditions.join(' AND ')}`,
        params
      );
      isDuplicate = parseInt(rows[0].count) > 0;
    }

    // 2차: 아직 안 찾았으면 review_index에서도 검사 (phone8 기반)
    if (!isDuplicate && phone) {
      const phone8 = phone.replace(/[^0-9]/g, '').slice(-8);
      if (phone8.length === 8) {
        const { rows } = await pool.query(
          `SELECT COUNT(*) FROM review_index
           WHERE sheet_id = $1 AND tab_name = $2 AND phone8 = $3`,
          [sheetId, tabName, phone8]
        );
        isDuplicate = parseInt(rows[0].count) > 0;
      }
    }

    // 3차: recipient + address 조합으로도 검사
    if (!isDuplicate && recipient && address) {
      const { rows } = await pool.query(
        `SELECT COUNT(*) FROM order_submissions
         WHERE sheet_id = $1 AND tab_name = $2 AND recipient = $3 AND address = $4`,
        [sheetId, tabName, recipient, address]
      );
      isDuplicate = parseInt(rows[0].count) > 0;
    }

    res.json({ ok: true, isDuplicate, source: 'db' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/submit/check-files — 리뷰파일 존재 확인 (GAS: checkReviewFiles)
// ═══════════════════════════════════════════════════════════
router.post('/check-files', async (req, res, next) => {
  try {
    const { sheetId, tabName, rowIndex } = req.body;

    // tab_configs에서 폴더 URL 조회
    const { rows } = await pool.query(
      'SELECT folder_url, capture_folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );

    if (rows.length === 0 || !rows[0].folder_url) {
      return res.json({ ok: true, exists: false, message: '폴더 URL 미설정' });
    }

    // Drive API로 폴더 내 파일 확인
    try {
      const driveService = require('../services/drive.service');
      const folderId = extractFolderId(rows[0].folder_url);
      if (folderId) {
        const files = await driveService.listFolderContents(folderId);
        return res.json({ ok: true, exists: files.length > 0, fileCount: files.length });
      }
    } catch (driveErr) {
      console.warn('Drive API 조회 실패:', driveErr.message);
    }

    res.json({ ok: true, exists: false, message: '파일 확인 불가' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 헬퍼 함수들
// ═══════════════════════════════════════════════════════════

/** 열 인덱스를 알파벳 문자로 변환 (0=A, 1=B, ..., 25=Z, 26=AA) */
function getColLetter(colIdx) {
  let letter = '';
  let idx = colIdx;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

/** Google Drive URL에서 폴더 ID 추출 */
function extractFolderId(url) {
  if (!url) return null;
  const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/** 주문 데이터를 헤더에 맞게 매핑
 *  ★ 옵션 처리: selectedOptKey가 "블랙|유선|체리축" 형태이면
 *  시트의 옵션 컬럼 순서대로 분리하여 각각 기입 (옵션1=블랙, 옵션2=유선, 옵션3=체리축)
 */
function _mapOrderToRow(headers, orderData) {
  // 옵션 키를 파이프로 분리 (ex: "블랙|유선" → ["블랙","유선"])
  const optParts = (orderData.selectedOptKey || '').split('|').map(v => v.trim());
  // 옵션 컬럼 카운터 (순서대로 할당)
  let optColCounter = 0;

  // ★ 관리자 전용 열: 절대 덮어쓰면 안 되는 키워드 목록
  const ADMIN_ONLY_KEYWORDS = ['번호', 'no', '#', '인애드', '카톡', '닉네임', '상품', '상품명'];

  return headers.map(h => {
    const key = h.toLowerCase().trim();
    // ★ 관리자 전용 열 보호: 정확히 일치하거나 특정 키워드만 포함된 열은 null 반환
    if (ADMIN_ONLY_KEYWORDS.some(kw => key === kw)) return null;
    // "인애드" 포함 열도 보호 (인애드명단, 인애드명, 인애드제출 등)
    if (key.includes('인애드')) return null;
    if (key.includes('주문자') || key.includes('orderer')) return orderData.orderer || '';
    if (key.includes('수취인') || key.includes('이름') || key.includes('recipient')) return orderData.recipient || '';
    if (key.includes('아이디') || key.includes('userid') || key.includes('id')) return orderData.userId || '';
    if (key.includes('전화') || key.includes('연락') || key.includes('phone')) return orderData.phone || '';
    if (key.includes('주소') || key.includes('address')) return orderData.address || '';
    if (key.includes('은행') || key.includes('bank')) return orderData.bank || '';
    if (key.includes('계좌') || key.includes('account')) return orderData.account || '';
    if (key.includes('예금주') || key.includes('depositor')) return orderData.depositor || '';
    if (key.includes('금액') || key.includes('price')) return orderData.price || '';
    if (key.includes('일자') || key.includes('날짜') || key.includes('date')) return orderData.dateStr || '';
    if (key.includes('주문번호') || key.includes('ordernum')) return orderData.orderNum || '';
    if (key.includes('비고') || key.includes('특이사항') || key.includes('memo')) return orderData.memo || '';
    // ★ 옵션 컬럼: selectedOptKey를 분리하여 순서대로 할당
    if (key.includes('옵션') || key.includes('option')) {
      const val = optParts[optColCounter] || '';
      optColCounter++;
      return val;
    }
    // ★ 매칭되지 않는 열은 null → 기존 값 보존
    return null;
  });
}

module.exports = router;
