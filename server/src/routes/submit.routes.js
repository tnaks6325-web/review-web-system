const express = require('express');
const router = express.Router();
const { writeSheet, readSheet, appendSheet, getSpreadsheetMeta, batchReadSheet, batchUpdateSheet } = require('../services/sheets.service');
const { enqueue } = require('../services/syncQueue.service');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { emitReviewSubmit, emitOrderSubmit } = require('../utils/sse');

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

// 탭 전체 데이터 캐시 (슬롯 매칭용, 1분)
const tabDataCache = new Map();
const TAB_DATA_CACHE_TTL = 60 * 1000; // 1분

// 헤더 행 자동 감지용 키워드 (smartBuild _isDataTabRow와 동일 로직)
const HEADER_DETECT_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호', '아이디', '주소'];

// 인애드명 컬럼 감지 키워드
const INAD_COL_KEYWORDS = ['인애드', '인애드명', '인애드제출', '카톡', '카카오', '닉네임'];

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
  const allRows = await readSheet(sheetId, `'${tabName}'!A1:ZZ50`, opts);
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
  const allRows = await readSheet(sheetId, `'${tabName}'!A1:ZZ500`, opts);
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
router.post('/debug-tabs', async (req, res, next) => {
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
router.post('/debug-sheet-data', async (req, res, next) => {
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
router.get('/diag-tabs', async (req, res) => {
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
router.get('/slot-status', async (req, res) => {
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
// 슬롯 매칭 API — 구매양식 제출 시 자동 행 매칭
//
// 규칙:
//   1순위: 로그인 이름 == 인애드명 정확 일치 → 위에서부터 빈 행
//   2순위: 일치 없으면 → "실명이 아닌" 인애드명 행 중 위에서부터 빈 행 (선착순)
// ═══════════════════════════════════════════════════════════
router.post('/find-slot', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, loginName, phone8, profileName } = req.body;
    if (!sheetId || !tabName || !loginName) {
      return res.json({ ok: false, error: 'sheetId, tabName, loginName 필요' });
    }

    const matchName = (profileName || loginName).trim();
    const sheetOpts = gid ? { gid } : {};

    // 탭 전체 데이터 로드 (Sheets API 실패 시 append 모드로 폴백)
    let tabData = null;
    try {
      tabData = await getCachedTabData(sheetId, tabName, sheetOpts);
    } catch (sheetErr) {
      logger.warn(`[find-slot] 시트 읽기 실패 → append 모드: ${sheetErr.message}`);
      return res.json({ ok: true, mode: 'append', reason: 'sheet_read_error', debug: sheetErr.message });
    }
    if (!tabData) {
      return res.json({ ok: true, mode: 'append', reason: 'no_tab_data', debug: 'getCachedTabData returned null (no rows or no header found)' });
    }

    const { headers, headerRowIdx, dataRows } = tabData;

    // 인애드명 컬럼 찾기
    const inadColIdx = headers.findIndex(h => {
      const hl = h.toLowerCase();
      return INAD_COL_KEYWORDS.some(k => hl.includes(k));
    });
    if (inadColIdx < 0) {
      // 인애드명 컬럼이 없으면 기존 append 방식으로 폴백
      return res.json({ ok: true, mode: 'append', reason: 'no_inad_col' });
    }

    // 수취인 컬럼 찾기 (빈 행 판별 기준)
    const recipientKeywords = ['수취인', '수취인명', '이름', '성함', '성명'];
    const recipientColIdx = headers.findIndex(h =>
      recipientKeywords.some(k => h.includes(k))
    );
    // 연락처 컬럼도 빈 행 판별 보조
    const phoneKeywords = ['연락처', '전화', '전화번호', 'phone'];
    const phoneColIdx = headers.findIndex(h =>
      phoneKeywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
    );

    // 빈 행 판별: 수취인 컬럼이 비어있으면 빈 행
    function _isEmptyRow(row) {
      if (recipientColIdx >= 0) {
        const val = String(row[recipientColIdx] || '').trim();
        if (val) return false;
      }
      if (phoneColIdx >= 0) {
        const val = String(row[phoneColIdx] || '').trim();
        if (val) return false;
      }
      // 수취인/연락처 모두 없는 경우, ID 컬럼도 체크
      const idKeywords = ['아이디', 'id', 'userid'];
      const idColIdx = headers.findIndex(h => idKeywords.some(k => h.toLowerCase().includes(k)));
      if (idColIdx >= 0) {
        const val = String(row[idColIdx] || '').trim();
        if (val) return false;
      }
      return true;
    }

    // DB에서 이미 잠긴 슬롯 조회 (테이블 미생성 시 빈 Set)
    let lockedRowSet = new Set();
    try {
      const { rows: lockedSlots } = await pool.query(
        'SELECT row_number FROM slot_locks WHERE sheet_id = $1 AND tab_name = $2 AND is_submitted = TRUE',
        [sheetId, tabName]
      );
      lockedRowSet = new Set(lockedSlots.map(r => r.row_number));
    } catch (dbErr) {
      logger.warn(`[find-slot] slot_locks 조회 실패 (테이블 미생성?): ${dbErr.message}`);
    }

    // ── 1순위: 이름 정확 매칭 ──
    let matchedRow = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i] || [];
      const inadValue = String(row[inadColIdx] || '').trim();
      if (inadValue !== matchName) continue;

      const sheetRowNumber = headerRowIdx + 1 + i + 1; // 1-based sheet row
      if (lockedRowSet.has(sheetRowNumber)) continue; // 이미 제출된 행 스킵
      if (!_isEmptyRow(row)) continue; // 데이터 이미 있는 행 스킵

      matchedRow = sheetRowNumber;
      break;
    }

    if (matchedRow > 0) {
      return res.json({
        ok: true,
        mode: 'slot',
        rowNumber: matchedRow,
        inadName: matchName,
        matchType: 'exact',
        headerRowIdx: headerRowIdx + 1, // 1-based
      });
    }

    // ── 2순위: 실명 아닌 인애드명 행 중 선착순 ──
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i] || [];
      const inadValue = String(row[inadColIdx] || '').trim();
      if (!inadValue) continue; // 인애드명 자체가 비어있으면 스킵

      // 실명이면 스킵 (다른 사람의 슬롯이므로)
      if (_isKoreanRealName(inadValue)) continue;

      const sheetRowNumber = headerRowIdx + 1 + i + 1;
      if (lockedRowSet.has(sheetRowNumber)) continue;
      if (!_isEmptyRow(row)) continue;

      matchedRow = sheetRowNumber;
      break;
    }

    if (matchedRow > 0) {
      const inadValue = String(dataRows[matchedRow - headerRowIdx - 2][inadColIdx] || '').trim();
      return res.json({
        ok: true,
        mode: 'slot',
        rowNumber: matchedRow,
        inadName: inadValue,
        matchType: 'nickname_slot',
        headerRowIdx: headerRowIdx + 1,
      });
    }

    // ── 3순위: 인애드명이 비어있는 빈 행 중 선착순 (완전 빈 슬롯) ──
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i] || [];
      const inadValue = String(row[inadColIdx] || '').trim();
      if (inadValue) continue; // 인애드명이 있는 행은 스킵 (1순위/2순위에서 처리됨)

      const sheetRowNumber = headerRowIdx + 1 + i + 1;
      if (lockedRowSet.has(sheetRowNumber)) continue;
      if (!_isEmptyRow(row)) continue;

      matchedRow = sheetRowNumber;
      break;
    }

    if (matchedRow > 0) {
      return res.json({
        ok: true,
        mode: 'slot',
        rowNumber: matchedRow,
        inadName: '',
        matchType: 'empty_slot',
        headerRowIdx: headerRowIdx + 1,
      });
    }

    // ── 매칭 실패: append 모드로 폴백 ──
    return res.json({ ok: true, mode: 'append', reason: 'no_available_slot' });
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
    const { sheetId, gid, tabName, rowIndex, submitCol, value, phone8 } = req.body;

    if (!sheetId || !tabName || !rowIndex) {
      return res.json({ error: '필수 파라미터 누락 (sheetId, tabName, rowIndex)' });
    }

    const submitValue = value || '제출';
    const sheetOpts = gid ? { gid } : {};

    // ── Step 1: DB 즉시 업데이트 (가장 빠름) ──
    let dbUpdated = false;
    try {
      const result = await pool.query(
        `UPDATE review_index SET is_submitted = TRUE, built_at = NOW()
         WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
        [sheetId, tabName, rowIndex]
      );
      dbUpdated = result.rowCount > 0;
    } catch (dbErr) {
      logger.warn(`[submit/review] DB 업데이트 실패: ${dbErr.message}`);
    }

    // ── Phase 1: index_master 카운트 즉시 반영 ──
    // 다음 인덱스 빌드에서 시트 원본 기준 재계산되므로 누적 오차 없음
    if (dbUpdated) {
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

    // ── Step 2: Sheets 동시 쓰기 시도 ──
    let sheetsWritten = false;
    try {
      const headers = await getCachedHeaders(sheetId, tabName, sheetOpts);
      if (headers) {
        const colIdx = headers.findIndex(h => h === submitCol);
        if (colIdx >= 0) {
          const colLetter = getColLetter(colIdx);
          const range = `'${tabName}'!${colLetter}${rowIndex}`;
          await writeSheet(sheetId, range, [[submitValue]], sheetOpts);
          sheetsWritten = true;
        }
      }
    } catch (sheetsErr) {
      logger.warn(`[submit/review] Sheets 쓰기 실패 → 큐 등록: ${sheetsErr.message}`);

      // ── Step 3: 실패 시 sync_queue에 등록 ──
      try {
        await enqueue('review_submit', {
          sheetId,
          tabName,
          rowIndex,
          submitCol,
          value: submitValue,
        });
      } catch (queueErr) {
        logger.error(`[submit/review] 큐 등록도 실패: ${queueErr.message}`);
      }
    }

    // ── SSE 알림: 리뷰 제출 ──
    emitReviewSubmit({
      tabName,
      sheetId,
      reviewer: req.body.reviewerName || '',
      rowIndex,
      dbUpdated,
      sheetsWritten,
    });

    res.json({
      ok: true,
      submitted: submitValue,
      dbUpdated,
      sheetsWritten,
      queued: !sheetsWritten,
    });
  } catch (err) {
    next(err);
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
            slotRowNumber, slotInadName, loginPhone8, loginName,
            // ★ 재제출 허용 파라미터 (에러로 시트 미기록 시 프론트에서 전달)
            forceResubmit } = b;

    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId와 tabName이 필요합니다.' });
    }

    // ── Step 1: DB 기반 중복 검사 (forceResubmit 시 건너뜀) ──
    if (!forceResubmit) {
      const dupCheck = await pool.query(
        `SELECT COUNT(*) FROM order_submissions
         WHERE sheet_id = $1 AND tab_name = $2 AND user_id = $3 AND date_str = $4
         AND submitted_at > NOW() - INTERVAL '1 hour'`,
        [sheetId, tabName, userId || '', dateStr || '']
      );
      if (parseInt(dupCheck.rows[0].count) > 0) {
        return res.json({ error: '최근 1시간 내 동일한 주문이 이미 제출되었습니다.', isDuplicate: true });
      }
    } else {
      logger.info(`[submit/order] forceResubmit 활성 — 중복 검사 건너뜀 (sheet=${sheetId}, tab=${tabName}, user=${userId || 'N/A'})`);
    }

    // ── Step 2: DB 즉시 저장 ──
    let dbSaved = false;
    try {
      await pool.query(
        `INSERT INTO order_submissions (sheet_id, tab_name, gid, orderer, recipient, user_id, phone, address, order_num, date_str, selected_opt_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sheetId, tabName, gid || '', orderer || '', recipient || '', userId || '', phone || '', address || '', orderNum || '', dateStr || '', selectedOptKey || '']
      );
      dbSaved = true;
    } catch (dbErr) {
      logger.warn(`[submit/order] DB 저장 실패: ${dbErr.message}`);
    }

    // ── Phase 1: index_master 카운트 즉시 반영 ──
    // 슬롯 매칭 시에는 기존 행 사용이므로 row_count 증가 불필요
    if (dbSaved && !slotRowNumber) {
      try {
        await pool.query(
          `UPDATE index_master
           SET row_count = row_count + 1
           WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, tabName]
        );
      } catch (_) { /* 대시보드 카운트 보조 — 실패해도 무시 */ }
    }

    // ── Step 3: Sheets 쓰기 ──
    const orderData = { orderer, recipient, userId, phone, address, bank, account, depositor, price, dateStr, orderNum, memo, selectedOptKey };
    let sheetsWritten = false;
    let usedSlot = false;
    const sheetOpts = gid ? { gid } : {};

    try {
      const headers = await getCachedHeaders(sheetId, tabName, sheetOpts);
      if (headers) {
        const rowData = _mapOrderToRow(headers, orderData);

        if (slotRowNumber && parseInt(slotRowNumber) > 0) {
          // ★ 슬롯 매칭: 기존 행에 덮어쓰기 (인애드명 컬럼은 보존)
          const rowNum = parseInt(slotRowNumber);
          const inadColIdx = headers.findIndex(h => INAD_COL_KEYWORDS.some(k => h.toLowerCase().includes(k)));

          // 인애드명 컬럼은 기존값 유지 (덮어쓰지 않음)
          if (inadColIdx >= 0) {
            rowData[inadColIdx] = null; // null = 기존값 유지 표시
          }

          // 날짜 컬럼도 기존값 유지 (이미 관리자가 세팅해둔 값)
          const dateColIdx = headers.findIndex(h => {
            const hl = h.toLowerCase();
            return hl.includes('일자') || hl.includes('날짜') || hl.includes('구매일');
          });
          if (dateColIdx >= 0) {
            rowData[dateColIdx] = null;
          }

          // 번호 컬럼도 기존값 유지
          const numColIdx = headers.findIndex(h => h === '번호');
          if (numColIdx >= 0) {
            rowData[numColIdx] = null;
          }

          // null이 아닌 컬럼만 개별 셀 쓰기 (기존값 보호)
          const writePairs = [];
          for (let ci = 0; ci < rowData.length; ci++) {
            if (rowData[ci] === null || rowData[ci] === '') continue;
            writePairs.push({ col: ci, val: rowData[ci] });
          }

          // ★ 성능 개선: batchUpdate로 1회 API 호출 (기존 N회 → 1회)
          //   실패 시 기존 개별 쓰기로 폴백 (안전 보장)
          if (writePairs.length > 0) {
            const batchData = writePairs.map(pair => ({
              range: `'${tabName}'!${getColLetter(pair.col)}${rowNum}`,
              values: [[pair.val]],
            }));

            try {
              await batchUpdateSheet(sheetId, batchData, 'RAW', sheetOpts);
              sheetsWritten = true;
              usedSlot = true;
            } catch (batchErr) {
              // batchUpdate 실패 → 기존 개별 쓰기로 폴백
              logger.warn(`[submit/order] batchUpdate 실패, 개별 쓰기 폴백: ${batchErr.message}`);
              for (const pair of writePairs) {
                const colLetter = getColLetter(pair.col);
                const range = `'${tabName}'!${colLetter}${rowNum}`;
                await writeSheet(sheetId, range, [[pair.val]], sheetOpts);
              }
              sheetsWritten = true;
              usedSlot = true;
            }
          }

          // 슬롯 잠금 기록
          if (sheetsWritten) {
            try {
              await pool.query(
                `INSERT INTO slot_locks (sheet_id, tab_name, row_number, inad_name, locked_by_phone8, locked_by_name, profile_name, is_submitted, submitted_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
                 ON CONFLICT (sheet_id, tab_name, row_number) DO UPDATE
                 SET is_submitted = TRUE, submitted_at = NOW(), locked_by_phone8 = $5, locked_by_name = $6`,
                [sheetId, tabName, rowNum, slotInadName || '', loginPhone8 || '', loginName || '', loginName || '']
              );
            } catch (lockErr) {
              logger.warn(`[submit/order] 슬롯 잠금 기록 실패: ${lockErr.message}`);
            }
          }
        } else {
          // ★ 기존 방식: appendSheet (인애드명 컬럼 없는 탭이거나 슬롯 없음)
          await appendSheet(sheetId, `'${tabName}'!A:A`, [rowData], sheetOpts);
          sheetsWritten = true;
        }
      }
    } catch (sheetsErr) {
      logger.warn(`[submit/order] Sheets 쓰기 실패 → 큐 등록: ${sheetsErr.message}`);

      // ── Step 4: 실패 시 sync_queue에 등록 ──
      try {
        await enqueue('order_append', {
          sheetId,
          tabName,
          orderData,
          slotRowNumber: slotRowNumber || null,
        });
      } catch (queueErr) {
        logger.error(`[submit/order] 큐 등록도 실패: ${queueErr.message}`);
      }
    }

    // 탭 데이터 캐시 무효화 (슬롯 상태 변경됨)
    if (sheetsWritten) {
      tabDataCache.delete(`${sheetId}||${tabName}`);
    }

    // ── SSE 알림: 구매양식 제출 ──
    emitOrderSubmit({
      tabName,
      sheetId,
      orderer: orderer || '',
      recipient: recipient || '',
      dbSaved,
      sheetsWritten,
      usedSlot,
    });

    res.json({
      ok: true,
      dbSaved,
      sheetsWritten,
      queued: !sheetsWritten,
      usedSlot,
      slotRowNumber: usedSlot ? parseInt(slotRowNumber) : null,
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

/** 주문 데이터를 헤더에 맞게 매핑 */
function _mapOrderToRow(headers, orderData) {
  return headers.map(h => {
    const key = h.toLowerCase();
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
    if (key.includes('비고') || key.includes('memo')) return orderData.memo || '';
    if (key.includes('옵션') || key.includes('option')) return orderData.selectedOptKey || '';
    return '';
  });
}

module.exports = router;
