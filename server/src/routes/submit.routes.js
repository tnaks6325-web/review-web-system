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
// 캡처 슬롯 판정은 utils/captureSlots 하나로 — 검색 응답·완료 판정·업로드 폴더가
// 같은 답을 봐야 한다(어긋나면 "슬롯 2개인데 1장에 완료" 같은 제출 파손).
// ═══════════════════════════════════════════════════════════
const { requiredSlotKeys, effectiveCaptureSlots } = require('../utils/captureSlots');
const { reviewTypeForTab } = require('../services/reviewTypeContext.service');

// ═══════════════════════════════════════════════════════════
// 블로그체험단(099) — memo 가 들어갈 열은 종류에 따라 우선순위가 다르다.
// 열 고르기는 `utils/memoColumn` 단일 출처(이 경로·큐 재시도·무시트 작업표 기록 공용).
// ★ 판정 실패·리뷰체험단은 종전 순서 그대로 = 무회귀.
// ═══════════════════════════════════════════════════════════
const { pickMemoColumnIndex } = require('../utils/memoColumn');
const { workKindForTab } = require('../services/workKindContext.service');
const { isBlogKind } = require('../utils/workKind');
const { isPostUrl, POST_URL_HINT } = require('../utils/blogPostUrl');

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

    // ★ 체험단 종류 — memo 열 우선순위와 무시트 기록 대상이 갈린다.
    //   조회 실패·미등록 탭은 null → `isBlogKind(null)=false` = 리뷰체험단 경로(종전 동작).
    let _isBlog = false;
    try { _isBlog = isBlogKind(await workKindForTab({ sheetId, tabName })); } catch (_) { _isBlog = false; }

    /* ★★ 블로그체험단의 결과물은 포스팅URL 하나다(사용자 확정: "URL 제출 = 리뷰제출 완료").
       그 값이 곧 제출물이므로 **서버가 최종 방어**한다 — 화면만 막으면 낡은 화면·직접 호출로
       결과물 없는 제출이 완료로 찍히고, 그 행은 리뷰어에겐 "제출완료"인데 실제로는 아무것도 없다.
       ★ 리뷰체험단(기본·판정 불가 포함)은 memo 가 **종전대로 선택** — 여기서 필수화하면
         기존 제출이 전부 막힌다(무회귀 선). 판정은 `utils/blogPostUrl` 단일 출처. */
    if (_isBlog && !isPostUrl(memo)) {
      return res.json({ error: POST_URL_HINT, code: 'post_url_required' });
    }

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
        `SELECT tc.capture_slots AS capture_slots, tc.income_type AS income_type, ri.is_submitted AS is_submitted
           FROM review_index ri
           LEFT JOIN tab_configs tc
             ON tc.sheet_id = ri.sheet_id AND tc.tab_name = ri.tab_name
          WHERE ri.sheet_id = $1 AND ri.tab_name = $2 AND ri.row_index = $3
          LIMIT 1`,
        [sheetId, tabName, rowIndex]
      );
      const wasSubmitted = ctxRows[0]?.is_submitted === true;
      // ★ 087 2차: 슬롯 파생은 리뷰타입까지 봐야 한다 — 넷 중 하나만 빠지면
      //   "슬롯은 2개인데 1장에 완료"(또는 그 반대)가 되어 제출이 깨진다.
      const _rt = await reviewTypeForTab({ sheetId, tabName });
      const required = requiredSlotKeys(ctxRows[0]?.capture_slots, ctxRows[0]?.income_type, _rt);
      // ★★ 슬롯 모드 판정은 required 개수가 아니라 **화면 슬롯(effectiveCaptureSlots)** 기준.
      //   현금영수증 슬롯이 선택(required:false)이 되면서 현영 탭도 required=['review'] 하나가 됐는데,
      //   그걸 근거로 fast-path를 타면 **영수증만 올리고 제출해도 완료**가 된다(리뷰 캡처 0장).
      //   슬롯 UI가 뜨는 탭은 원장 대조를 거쳐 "필수 슬롯 ⊆ 제출 슬롯"을 확인해야 한다.
      const _effSlots = effectiveCaptureSlots(ctxRows[0]?.capture_slots, ctxRows[0]?.income_type, _rt);
      const isMultiSlot = Array.isArray(_effSlots) && _effSlots.length > 1;

      /* ★★ 블로그체험단은 슬롯 대조를 하지 않는다 — 완료 조건이 위에서 검증한 포스팅URL 이다.
         현영을 겸한 blog 탭은 화면 슬롯이 2개가 되는데(리뷰+현금영수증), 그대로 두면
         `required=['review']` 를 원장에서 못 찾아 **영영 미완료**가 된다(블로그는 리뷰 캡처가 없다).
         ★ 이 완화는 blog 탭에만 — 리뷰체험단의 "필수 슬롯 ⊆ 제출 슬롯" 대조는 그대로다. */
      if (isMultiSlot && !_isBlog) {
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

        /* ★★ 무시트 탭은 위 UPDATE 가 **다음 장부 재생성에 지워진다**(주문 한 건만 들어와도).
           시트 기반 탭은 같은 값이 시트 칸에도 써져 살아남지만 무시트는 시트 쓰기가 막혀 있다.
           → 작업표의 리뷰제출 칸에 기록해 **재생성이 그것을 다시 읽게** 한다(진실원본 일원화).
           ★ 시트 기반 탭이면 handled:false = 종전 동작 그대로. 실패해도 제출은 성공(fail-soft). */
        try {
          const st = await require('../services/sheetlessStatus.service')
            .markStatusCell({ sheetId, tabName, rowIndex, kind: 'submit', value: submitValue, by: 'review-submit' });
          if (st.handled && !st.ok) {
            logger.warn(`[submit] 무시트 리뷰제출 표시 기록 실패 tab=${tabName} row=${rowIndex} reason=${st.reason}`);
          }
        } catch (e) {
          logger.warn(`[submit] 무시트 리뷰제출 표시 예외 tab=${tabName} row=${rowIndex}: ${e.message}`);
        }

        /* ★ memo(비고 / 블로그는 포스팅URL)도 무시트 탭에서는 시트 쓰기가 막혀 있어 사라진다.
           같은 이유·같은 방식으로 작업표 칸에 남긴다(열 고르기는 memoColumn 단일 출처).
           ★ 시트 기반 탭이면 handled:false = 아래 Step 3 배경 시트 쓰기가 종전대로 처리. */
        try {
          const mm = await require('../services/sheetlessStatus.service')
            .markSheetlessMemo({ sheetId, tabName, rowIndex, memo, blog: _isBlog, by: 'review-submit' });
          if (mm.handled && !mm.ok) {
            logger.warn(`[submit] 무시트 memo 기록 실패 tab=${tabName} row=${rowIndex} reason=${mm.reason}`);
          }
        } catch (e) {
          logger.warn(`[submit] 무시트 memo 기록 예외 tab=${tabName} row=${rowIndex}: ${e.message}`);
        }

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
      /* ★★ 무시트 탭은 쓸 시트가 없다 — 표시는 위 Step 1 의 `markStatusCell` 이 **작업표 칸**에 이미 기록했다.
         이 게이트가 없으면 리뷰제출 표시 1건마다 ① 구글 호출 1회 → 404 ② `logAbnormal(warn)` 오류로그
         ③ 무의미한 `review_submit` 큐 항목이 쌓인다(프로덕션 E2E 로 실측 — 큐 백스톱이 시트 쓰기 자체는
         막지만 그 앞의 낭비·소음은 남았다). payment.routes 의 `if (st.handled) continue` 와 같은 규율.
         ★ 부분 제출(complete=false)은 markStatusCell 을 타지 않으므로 **여기서 따로 판정**한다.
         ★ 판정 실패는 종전 경로(fail-open) — 시트 기반 탭이 절대 다수다. */
      try {
        const { isSheetless } = require('../utils/sheetlessScope');
        if (await isSheetless(pool, sheetId, tabName)) {
          logger.info(`[submit/review:bg] 무시트 탭 — 시트 쓰기 생략 (tab=${tabName}, row=${rowIndex})`);
          return;
        }
      } catch (_) { /* fail-open */ }

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
          //   ★ 열 고르기는 `utils/memoColumn` 단일 출처 — 이 경로와 큐 재시도, 무시트 작업표 기록이
          //     같은 규칙을 써야 "처음 제출은 포스팅 칸, 재시도는 비고 칸"으로 값이 흩어지지 않는다.
          //   ★ 블로그체험단은 결과물이 포스팅URL 이라 우선순위가 뒤집힌다(리뷰체험단은 종전 그대로).
          if (memo && memo.trim()) {
            const memoColIdx = pickMemoColumnIndex(headers, { blog: _isBlog });
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
            blog: _isBlog,          // ★ 재시도도 같은 열 우선순위를 써야 값이 흩어지지 않는다
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
/** 참여형 홀드 문맥(단일 출처, 063): phone8 = 명의(b.holdPhone8) 우선 → loginPhone8(소유자) 폴백.
 *  신원게이트 owner 폴백·옵션 서버권위·orderLedger 확정 문맥이 전부 이 값을 공유한다(레드 #4 — 인라인 중복 드리프트 봉인).
 *  타계정 제출은 holdPhone8=명의 p8(campaign.html h.phone8), loginPhone8=소유자 p8 — 역할 분리 계약. */
function _campaignHoldCtx(b, loginPhone8) {
  if (!(b && b.campaignId && b.campaignApplicationId && b.holdToken)) return null;
  return {
    applicationId: parseInt(b.campaignApplicationId, 10) || 0,
    campaignId: String(b.campaignId),
    phone8: String(b.holdPhone8 || loginPhone8 || '').replace(/\D/g, '').slice(-8), // 힌트(폴백 유지)
    holdToken: String(b.holdToken).trim(),
    optionKey: undefined,   // _authoritativeHold 가 채움(옵션 서버권위 쿼리 흡수)
  };
}

/** ★ 방어 D9: 클라 holdPhone8 은 "힌트"일 뿐 — 명의는 hold_token 으로 서버가 확정한다.
 *  홀드 확정(confirmHoldInTx)·provenance 링크는 전부 ca.phone8 일치를 요구하므로, 캐시된 구버전 프론트나
 *  2단계 회귀로 holdPhone8 이 어긋나면 확정도 링크도 실패 → 스윕의 late 백필(campaign_application_id 기반)도
 *  불가 → "결제했는데 관제에 흔적 0"인 고아 주문이 된다. hold_token(추측불가 24B)+id+campaign_id 일치가 인증이다.
 *  같은 왕복에서 option_key 도 가져와 아래 옵션 서버권위 쿼리를 대체(왕복 순증 0). fail-open. */
async function _authoritativeHold(ctx) {
  if (!ctx || !ctx.applicationId || !ctx.holdToken) return ctx;
  try {
    const { rows } = await pool.query(
      `SELECT ca.phone8, ca.option_key, ca.blog_url, ca.status,
              ca.order_submission_id, ca.late_order_id,
              (so.id IS NOT NULL) AS sub_alive,
              (lo.id IS NOT NULL) AS late_alive
         FROM campaign_applications ca
         LEFT JOIN order_submissions so
                ON so.id = ca.order_submission_id AND so.deleted_at IS NULL
         LEFT JOIN order_submissions lo
                ON lo.id = ca.late_order_id      AND lo.deleted_at IS NULL
        WHERE ca.id = $1 AND ca.campaign_id = $2
          AND ca.hold_token = $3 AND ca.hold_token <> '' LIMIT 1`,
      [ctx.applicationId, ctx.campaignId, ctx.holdToken]);
    if (!rows.length) return ctx;                     // 미확인 = 기존 late 경로(오확정 없음)
    ctx.verified = true;
    const srv = String(rows[0].phone8 || '').replace(/\D/g, '').slice(-8);
    if (srv.length === 8 && srv !== ctx.phone8) {
      logger.warn(`[submit/order] holdPhone8 보정 app=${ctx.applicationId} ` +
        `클라=${ctx.phone8 || '∅'} → 서버=***${srv.slice(-4)} (구버전 프론트/문맥 불일치 의심)`);
      ctx.phone8 = srv;
    }
    ctx.optionKey = rows[0].option_key || null;
    // ★ 101: 블로그 주소도 **서버가 홀드에서 읽는다**(클라 전달 금지 — 옵션 서버권위와 같은 규율).
    //   같은 왕복이라 순증 0. 이 값이 주문 원장 INSERT 와 시트 '블로그URL' 칸으로 그대로 간다.
    ctx.blogUrl = rows[0].blog_url || null;
    // ★ 멱등 판정 재료: 이 홀드로 이미 접수된 "살아있는" 주문이 있는가.
    //   status='submitted' 확정건뿐 아니라 late_order_id(지각 접수)도 포함해야 한다 —
    //   confirmHoldInTx 의 late UPDATE 는 `late_order_id IS NULL` 조건이라 2회차 재제출은
    //   링크조차 못 남기고 주문만 새로 생긴다(관제에 흔적 0인 고아 주문).
    if (rows[0].status === 'submitted' && rows[0].sub_alive) {
      ctx.doneOrderId = rows[0].order_submission_id; ctx.doneKind = 'confirmed';
    } else if (rows[0].late_alive) {
      ctx.doneOrderId = rows[0].late_order_id;       ctx.doneKind = 'late';
    }
    return ctx;
  } catch (e) {
    logger.warn(`[submit/order] 홀드 서버확정 실패(클라값 유지): ${e.message}`);
    return ctx;                                       // fail-open — 라이브 핫패스 보호
  }
}

/**
 * 구매양식의 저장 범위는 클라이언트 URL이나 Google Sheet 연결값으로 정하지 않는다.
 * 참여형 공고는 서버에서 검증한 캠페인 홀드를 기준으로 DB 전용 범위를 만든다.
 * 비참여형 레거시 요청만 기존 시트 범위를 계속 사용한다.
 */
async function _resolveCampaignOrderScope({ sheetId, gid, tabName, holdCtx }) {
  if (!holdCtx || !holdCtx.applicationId || !holdCtx.campaignId || !holdCtx.holdToken || !holdCtx.verified) {
    return (sheetId && tabName) ? { sheetId, gid: gid || '', tabName, sheetless: false } : null;
  }

  // _authoritativeHold가 이미 applicationId·campaignId·holdToken 소유권을 확인했다.
  // linked_* 값은 Google Sheet 접근 정보가 아니라 기존 작업보드 행의 DB 내부 식별자다.
  // 이 조회는 DB만 읽으며, Google Sheet/GAS를 읽거나 쓰지 않는다.
  const { rows } = await pool.query(
    `SELECT linked_sheet_id, linked_tab_name, linked_tab_gid
       FROM recruit_campaigns
      WHERE id = $1
      LIMIT 1`,
    [holdCtx.campaignId]
  );
  const campaign = rows[0] || {};
  return {
    sheetId: `campaign:${holdCtx.campaignId}`,
    gid: '',
    tabName: `campaign:${holdCtx.campaignId}`,
    sheetless: true,
    worktable: (campaign.linked_sheet_id && campaign.linked_tab_name) ? {
      sheetId: campaign.linked_sheet_id,
      tabName: campaign.linked_tab_name,
      tabGid: campaign.linked_tab_gid || '',
    } : null,
  };
}

router.post('/order', async (req, res, next) => {
  try {
    const b = req.body;
    const { sheetId, gid, tabName, orderer, recipient, userId, phone,
            address, bank, account, depositor, price, dateStr, orderNum,
            memo, selectedOptKey, isCoupang, ncMode,
            // ★ 슬롯 매칭 파라미터 (find-slot에서 받은 값)
            slotRowNumber, slotInadName, loginPhone8, loginName } = b;

    // ═══ 신원 게이트: 내정보(사용자명/전화/주소/계좌) 완비 + 제출정보 유사도 검증 ═══
    // - loginPhone8이 있는 리뷰어 제출에만 적용 (레거시/관리자 경유 제출은 통과)
    // - identityConfirmed='true'면 NEED_CONFIRM 단계는 리뷰어가 확인한 것으로 간주(로그만 남김)
    // - ★ fail-open: 게이트 내부 오류는 주문 접수를 막지 않는다 (라이브 핫패스 보호)
    const _idPhone8 = String(loginPhone8 || '').replace(/[^0-9]/g, '').slice(-8);
    // ★ 참여형 홀드 문맥(단일 출처, 063) — 신원게이트 owner 폴백·옵션 서버권위·확정 문맥 공용(1회 계산)
    const holdCtx = await _authoritativeHold(_campaignHoldCtx(b, loginPhone8));
    const orderScope = await _resolveCampaignOrderScope({ sheetId, gid, tabName, holdCtx });
    if (!orderScope) {
      return res.status(400).json({ error: '유효한 참여 문맥이 없어 구매양식을 제출할 수 없습니다.' });
    }

    // ★★ 홀드 멱등 게이트(중복 원장·중복 시트행 차단) — 일괄 제출(batch) 도입의 선행 조건.
    //   이 홀드는 이미 주문을 하나 만들었다. 그대로 태우면 createOrderLedgerEntry 가
    //   order_submissions 를 새로 INSERT 하고(SAVEPOINT 격리라 홀드 확정이 실패해도 주문은 남는다)
    //   confirmHoldInTx 는 'late' 만 반환한다 → 시트 중복행 + 정원 미차감 + 관제에 흔적 없는 고아 주문.
    //   ★ ok:true 로 돌려주는 것이 핵심 — "실패"로 보이면 리뷰어가 또 누른다.
    //   ★ fail-open 유지: 위 조회가 실패하면 doneKind 가 없어 이 분기에 도달하지 않는다.
    //   ★ 레거시·비참여형·nc모드·관리자 경유 제출은 holdCtx 자체가 null 이라 무영향.
    if (holdCtx && holdCtx.doneKind) {
      logger.info(`[submit/order] 멱등 통과(이미 접수된 홀드) app=${holdCtx.applicationId} ` +
        `kind=${holdCtx.doneKind} os=${holdCtx.doneOrderId}`);
      return res.json({
        ok: true, alreadySubmitted: true, dbSaved: true, sheetsWritten: false, queued: false,
        orderSubmissionId: holdCtx.doneOrderId, mirrorStatus: '',
        campaignHold: holdCtx.doneKind,     // 'confirmed' | 'late' — 부모 화면이 거짓말하지 않게
      });
    }

    if (_idPhone8.length === 8) {
      try {
        const { profileMissing, resolveOrderIdentity } = require('../services/identity.service');
        let { rows: _rvRows } = await pool.query(
          `SELECT name, phone, phone8, address, bank_name, bank_account, account_holder, sub_accounts
           FROM reviewers WHERE phone8 = $1 LIMIT 1`, [_idPhone8]
        );
        // ★ 타계정(063): 로그인 p8로 reviewers 행이 없으면(독립번호 타계정의 서브 로그인 세션 — verifyReviewer
        //   sub 매칭) 홀드의 owner_phone8로 "소유자" 행을 역조회해 게이트를 계속 수행 — 조용한 게이트 스킵 봉합.
        //   소유권 검증(campaign+명의 phone8+hold_token 정확일치) 통과 홀드에만. fail-open 원칙 유지(try 내부).
        if (!_rvRows.length && holdCtx) {
          const owner = await pool.query(
            `SELECT r.name, r.phone, r.phone8, r.address, r.bank_name, r.bank_account, r.account_holder, r.sub_accounts
               FROM campaign_applications ca JOIN reviewers r ON r.phone8 = ca.owner_phone8
              WHERE ca.id = $1 AND ca.campaign_id = $2 AND ca.phone8 = $3
                AND ca.hold_token = $4 AND ca.hold_token <> '' AND ca.owner_phone8 IS NOT NULL
              LIMIT 1`,
            [holdCtx.applicationId, holdCtx.campaignId, holdCtx.phone8, holdCtx.holdToken]);
          _rvRows = owner.rows; // 소유자 프로필 기준 → 타계정 명의는 SUB 판별·자동보강 경로 그대로
        }
        if (_rvRows.length > 0) {
          const _rv = _rvRows[0];
          if (typeof _rv.sub_accounts === 'string') {
            try { _rv.sub_accounts = JSON.parse(_rv.sub_accounts); } catch (_) { _rv.sub_accounts = []; }
          }
          if (!Array.isArray(_rv.sub_accounts)) _rv.sub_accounts = [];

          const _missing = profileMissing(_rv);
          if (_missing.length > 0) {
            return res.json({
              ok: false, code: 'PROFILE_INCOMPLETE', profileMissing: _missing,
              error: `내정보 미등록 항목이 있어 제출할 수 없습니다: ${_missing.join(', ')}. 리뷰어 홈 > 내정보에서 등록해주세요.`,
            });
          }

          // ★ 서버측 필수필드 검증 (주문번호·비고 제외 전 필드 — 리뷰어 제출에만 적용, 프론트 우회 차단)
          const _reqFields = [
            [orderer, '주문자'], [userId, '아이디'], [recipient, '수취인'], [phone, '연락처'],
            [address, '배송주소'], [bank, '은행'], [account, '계좌'], [depositor, '예금주'], [price, '결제금액'],
          ];
          const _emptyFields = _reqFields.filter(([v]) => !String(v || '').trim()).map(([, l]) => l);
          if (_emptyFields.length > 0) {
            return res.json({
              ok: false, code: 'FIELDS_REQUIRED',
              error: `필수 항목이 비어 있습니다: ${_emptyFields.join(', ')} (주문번호·비고 외 전 항목 필수)`,
            });
          }

          // ★ mode:'submit' = Gemini 미사용(핫패스 지연/비결정성 차단 — Gemini는 precheck 전용),
          //   uncertain은 통과·mismatch만 차단. identityConfirmed면 주소/계좌 상세대조 생략(분류만).
          const _verdict = await resolveOrderIdentity(_rv, {
            recipient, phone, address, bank, account, depositor,
            extractedRecipient: b.extractedRecipient || '',
            extractedPhone: b.extractedPhone || '',
            extractedAddress: b.extractedAddress || '',
          }, { mode: 'submit', skipDetailChecks: String(b.identityConfirmed) === 'true' });

          if (_verdict.status === 'NEED_SUB_REGISTER') {
            return res.json({
              ok: false, code: 'NEED_SUB_REGISTER',
              identity: _verdict.identity, reasons: _verdict.reasons,
              error: '내 정보와 다른 정보가 감지되었습니다. 타계정으로 등록 후 제출해주세요.',
            });
          }
          if (_verdict.status === 'NEED_CONFIRM') {
            return res.json({
              ok: false, code: 'NEED_CONFIRM',
              identity: _verdict.identity, reasons: _verdict.reasons,
              error: '등록된 내정보와 달라 보이는 항목이 있습니다: ' + _verdict.reasons.join(' / '),
            });
          }
          // 리뷰어가 경고 확인 후 제출(identityConfirmed) — 통과시키되 이상로그로 관리자 가시성 확보
          if (String(b.identityConfirmed) === 'true') {
            logAbnormal({
              flow: 'order_submit', step: 'identity_confirm_override', source: 'validation',
              error: new Error('신원 유사도 경고 확인 후 제출 (리뷰어 확인 완료)'),
              context: { sheetId, tabName, loginPhone8: _idPhone8, recipient: recipient || '' },
            });
          }
          // SUB 매칭 시 타계정의 빈 주소/계좌 자동 보강 (best-effort)
          if (_verdict.status === 'SUB' && _verdict.subIndex >= 0) {
            try {
              const _sub = _rv.sub_accounts[_verdict.subIndex] || {};
              let _dirty = false;
              if (!String(_sub.address || '').trim() && (b.extractedAddress || address)) {
                _sub.address = String(b.extractedAddress || address).trim(); _dirty = true;
              }
              // 계좌 보강은 "본인 공통계좌와 다른 계좌"일 때만 (본인 계좌로 입금받는 흐름을
              // 타계정 전용계좌로 오기록하지 않도록)
              const _mainAcctDigits = String(_rv.bank_account || '').replace(/[^0-9]/g, '');
              const _orderAcctDigits = String(account || '').replace(/[^0-9]/g, '');
              if (!String(_sub.bankAccount || '').trim() && _orderAcctDigits && _orderAcctDigits !== _mainAcctDigits) {
                _sub.bankName = _sub.bankName || bank || '';
                _sub.bankAccount = account;
                _sub.accountHolder = _sub.accountHolder || depositor || '';
                _dirty = true;
              }
              if (_dirty) {
                _rv.sub_accounts[_verdict.subIndex] = _sub;
                await pool.query(
                  'UPDATE reviewers SET sub_accounts = $1::jsonb WHERE phone8 = $2',
                  // ★ 063: owner 폴백 시 _idPhone8은 서브 p8이라 소유자 행에 못 쓴다 — 게이트 기준 행에 기록
                  [JSON.stringify(_rv.sub_accounts), _rvRows[0].phone8 || _idPhone8]
                );
                logger.info(`[order-identity] 타계정 자동보강: ${_idPhone8} sub[${_verdict.subIndex}] ${_sub.name || ''}`);
              }
            } catch (enrichErr) {
              logger.warn(`[order-identity] 타계정 자동보강 실패(무시): ${enrichErr.message}`);
            }
          }
        }
      } catch (gateErr) {
        // fail-open: 게이트 오류는 접수를 막지 않는다
        logger.warn(`[order-identity] 신원 게이트 오류(통과 처리): ${gateErr.message}`);
      }
    }

    // ★ 참여형 옵션 서버권위(061, PRD §05): 홀드에 저장된 option_key를 selectedOptKey로 강제.
    //   화면 값 조작·낡은 표시로 다른 옵션이 기록되는 것을 차단(행배정·시트기입·dedup 모두 이 값 기준).
    //   fail-open: 조회 실패/미참여/옵션없는 홀드는 클라이언트 값 유지(라이브 핫패스 무영향).
    //   ※ 잔여 TOCTOU(레드 #1): 이 읽기는 확정 락 밖이라, 제출 처리 중 다른 탭이 change-option으로 옵션을
    //     바꾸면 시트=옛옵션·DB홀드=새옵션 불일치가 이론상 가능. 2단계 UI 계약으로 봉합 = 옵션변경은
    //     부모(campaign.html)에서만 가능하고 변경 시 구매양식 iframe을 재로드해 인플라이트 제출을 파기한다
    //     (같은 페이지라 동시 진행 불가). change-option UI 미연동인 1단계에서는 도달 불가.
    //   ※ 값 자체는 위 _authoritativeHold(hold_token 기준 1회 조회)가 이미 읽어 왔다 — 왕복 순증 0.
    let effectiveOptKey = selectedOptKey;
    if (holdCtx && holdCtx.optionKey) effectiveOptKey = holdCtx.optionKey;

    // ★ 101: 블로그 주소는 **홀드에서 읽은 서버값만** 싣는다(요청 본문 미신뢰 — 옵션과 같은 규율).
    //   홀드가 없거나(레거시·관리자 경유) 리뷰체험단이면 undefined = 시트 '블로그URL' 칸 무접촉.
    const orderData = { orderer, recipient, userId, phone, address, bank, account, depositor, price, dateStr, orderNum, memo,
                        selectedOptKey: effectiveOptKey, blogUrl: (holdCtx && holdCtx.blogUrl) || '' };
    const ledger = await createOrderLedgerEntry({
      sheetId: orderScope.sheetId,
      tabName: orderScope.tabName,
      gid: orderScope.gid,
      skipSheetMirror: orderScope.sheetless,
      orderData,
      slotRowNumber: slotRowNumber || null,
      loginPhone8: loginPhone8 || '',
      loginName: loginName || '',
      // ★ 참여형 캠페인 홀드 확정 문맥(전부 optional — 비참여 제출 무영향).
      //   확정은 orderLedger 단일 트랜잭션 안에서 소유권 3중검증(applied·phone8·연결탭) 통과 시에만.
      //   ★ 063: expectedOptKey = 시트에 실제 기입되는 옵션 → 확정 시점 홀드 옵션과 다르면 warn(관제 대조 신호).
      //   ★ 방어 D3: orderIdentity = 시트에 실제 기입되는 연락처(정산 귀속 기준) → 명의 드리프트 경고 입력.
      campaignHold: holdCtx ? { ...holdCtx, expectedOptKey: effectiveOptKey, orderIdentity: { phone }, skipTabBinding: orderScope.sheetless } : undefined,
      // ★ 동일 캠페인에서 오늘 같은 모든 구매양식 값으로 이미 제출했으면 원장 INSERT 전에 차단.
      // orderLedger 트랜잭션의 advisory lock으로 동시 더블클릭도 한 건만 통과시킨다.
      // crossDay: 무시트 경로는 claim(dedup_key 유니크)을 건너뛰므로 날짜를 넘는 같은 구매도 막는다.
      sameDayDuplicateGuard: { sheetId: orderScope.sheetId, tabName: orderScope.tabName, campaignId: holdCtx && holdCtx.campaignId, orderData, crossDay: !!orderScope.sheetless },
    });

    if (ledger && ledger.duplicateOrderSubmissionId) {
      return res.status(409).json({
        ok: false,
        code: 'DUPLICATE_SAME_DAY',
        error: '오늘 동일한 구매양식이 이미 제출되었습니다. 내용을 확인해 주세요.',
      });
    }

    // ★ 신원 기록(recordParticipationLink/recordReviewIdentity)은 여기서 하지 않는다.
    //   제출 시점의 ledger.sheetRow는 RAW 미러 스냅샷 기반 "빈 행" 추정치라,
    //   미러 stale·로스터 선기입 탭에서는 '다른 리뷰어의 행'을 가리킬 수 있다.
    //   가드 전에 그 행에 phone8을 찍으면(=리뷰어 교차노출 버그) review_index/participation_links가 오염된다.
    //   → 신원 기록은 큐 워커(syncQueue order_append)에서 "다중컬럼 가드 통과 + 실제 시트쓰기 성공 후,
    //     실제로 쓴 행에만" 수행한다(거기서만 신뢰 가능한 시트행↔phone8 링크가 확정됨).

    // ★★ 무시트 탭(탈 구글시트 W2)은 **큐를 타지 않는다** — 작업표에 바로 기록하고 장부를
    //   다시 만들어 같은 요청 안에서 완결시킨다. 큐를 태우면 존재하지 않는(또는 이관하며
    //   버린) 구글 시트에 쓰려다 실패하고, reconcile 이 영원히 재시도한다.
    //   ★ 판정은 `sheetlessScope` 단일 출처. 조회 실패는 false(fail-open = 종전 경로) —
    //     최종 방어는 큐 실행부(syncQueue)가 쓰기 직전 다시 확인하는 백스톱이다.
    // 참여형 무시트 주문은 `campaign:*` 원장 키와 별도로, 공고에 연결된 DB 작업보드의
    // 빈 슬롯 하나를 즉시 선점한다. sheetRow가 없는 것은 정상이며 서비스가 원자적으로 배정한다.
    let sheetlessDone = null;
    if (orderScope.sheetless) {
      try {
        const wt = orderScope.worktable;
        sheetlessDone = wt
          ? await require('../services/sheetlessOrder.service').writeOrderToWorktable({
              sheetId: wt.sheetId, tabName: wt.tabName, tabGid: wt.tabGid,
              orderData, orderSubmissionId: ledger.orderSubmissionId,
              loginPhone8: loginPhone8 || '', loginName: loginName || '',
            })
          : { ok: false, reason: 'no_worktable_mapping' };
      } catch (slErr) {
        sheetlessDone = { ok: false, reason: 'exception', message: slErr.message };
      }
      if (!sheetlessDone.ok) {
        await markOrderMirrorFailed(ledger.orderSubmissionId, sheetlessDone.message || sheetlessDone.reason);
        logger.error(`[submit/order] 작업보드 기록 실패(주문은 저장됨): ${sheetlessDone.reason} ${sheetlessDone.message || ''}`);
        logAbnormal({
          flow: 'order_submit', step: 'sheetless_worktable_write', severity: 'critical',
          error: new Error(`작업보드 기록 실패: ${sheetlessDone.reason}`),
          context: { campaignId: holdCtx && holdCtx.campaignId, orderSubmissionId: ledger.orderSubmissionId },
        });
      }
    }
    if (ledger.sheetRow) {
      let isSl = false;
      try {
        isSl = await require('../utils/sheetlessScope').isSheetless(require('../db/pool'), sheetId, tabName);
      } catch (_) { isSl = false; }
      if (isSl) {
        try {
          sheetlessDone = await require('../services/sheetlessOrder.service').writeOrderToWorktable({
            sheetId, tabName, tabGid: ledger.tabGid || gid || '',
            sheetRow: ledger.sheetRow, orderData,
            orderSubmissionId: ledger.orderSubmissionId,
            loginPhone8: loginPhone8 || '', loginName: loginName || '',
          });
        } catch (slErr) {
          sheetlessDone = { ok: false, reason: 'exception', message: slErr.message };
        }
        if (!sheetlessDone.ok) {
          logger.error(`[submit/order] 무시트 기록 실패(주문은 저장됨): ${sheetlessDone.reason} ${sheetlessDone.message || ''}`);
          logAbnormal({
            flow: 'order_submit', step: 'sheetless_write', severity: 'critical',
            error: new Error(`무시트 작업표 기록 실패: ${sheetlessDone.reason}`),
            context: { sheetId, tabName, orderSubmissionId: ledger.orderSubmissionId },
          });
        }
      }
    }

    let queued = false;
    if (ledger.sheetRow && !sheetlessDone) {
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
    } else if (!ledger.sheetRow && !orderScope.sheetless) {
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
      // 무시트는 DB 작업보드 기록까지 성공한 경우에만 완결이다.
      mirrorStatus: orderScope.sheetless ? (sheetlessDone && sheetlessDone.ok ? 'written' : 'failed')
        : (sheetlessDone && sheetlessDone.ok) ? 'written'
        : queued ? 'queued' : (ledger.sheetRow ? 'failed' : 'pending_no_row'),
      campaignHold: ledger.holdResult || null, // 'confirmed'|'late'|'tab_mismatch'|'error'|null — 확정 외에는 "구매는 접수됨, 운영자 확인 중" 안내
    });

    emitOrderSubmit({
      tabName, sheetId,
      orderer: orderer || '', recipient: recipient || '',
      dbSaved: true, sheetsWritten: false, queued, usedSlot: !!slotRowNumber,
      sheetRow: ledger.sheetRow,
    });

    // ★ 근실시간화: 큐 등록 성공 시에만 비차단 즉시 펌프(30초 cron을 기다리지 않음).
    //   res.json·emitOrderSubmit·markOrderQueued 모두 끝난 뒤라 R1(written→queued 역행) 안전.
    //   order_append만 kick(메타전제 자동충족, R8). 실패해도 30초 cron이 백스톱이라 throw 안 함.
    if (queued) {
      try {
        // ★ 상시 배치(ORDER_BATCH_AUTO=1): 주문은 배치 스케줄러가 탭별로 묶어 근실시간 반영
        //   (단건 펌프보다 throttle 효율 수십배). 미설정 시 기존 단건 펌프(되돌리기).
        if (process.env.ORDER_BATCH_AUTO === '1') {
          // ★ 공정화 #1: 제출한 탭을 타깃으로 전달 → 그 탭이 글로벌 우선순위 밖이어도 이 사이클에 직접 드레인(즉시성).
          require('../jobs/orderBatchScheduler').kickOrderBatch(sheetId, tabName);
        } else {
          require('../jobs/queuePump').kickQueuePump();
        }
      } catch (e) { logger.warn(`[submit/order] kick 실패(무시, cron 백스톱): ${e.message}`); }
    }

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
