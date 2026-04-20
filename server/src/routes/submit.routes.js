const express = require('express');
const router = express.Router();
const { writeSheet, readSheet, appendSheet } = require('../services/sheets.service');
const { enqueue } = require('../services/syncQueue.service');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { emitReviewSubmit, emitOrderSubmit } = require('../utils/sse');

// ═══════════════════════════════════════════════════════════
// 헤더 캐시 — 같은 탭의 헤더를 5분간 캐시 (Phase 3 최적화)
// ═══════════════════════════════════════════════════════════
const headerCache = new Map();
const HEADER_CACHE_TTL = 5 * 60 * 1000; // 5분

async function getCachedHeaders(sheetId, tabName) {
  const key = `${sheetId}||${tabName}`;
  const cached = headerCache.get(key);
  if (cached && Date.now() - cached.ts < HEADER_CACHE_TTL) {
    return cached.headers;
  }
  const headerValues = await readSheet(sheetId, `'${tabName}'!1:1`);
  if (headerValues && headerValues[0]) {
    const headers = headerValues[0].map(h => String(h || '').trim());
    headerCache.set(key, { headers, ts: Date.now() });
    return headers;
  }
  return null;
}

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
    const { sheetId, tabName, rowIndex, submitCol, value, phone8 } = req.body;

    if (!sheetId || !tabName || !rowIndex) {
      return res.json({ error: '필수 파라미터 누락 (sheetId, tabName, rowIndex)' });
    }

    const submitValue = value || '제출';

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

    // ── Step 2: Sheets 동시 쓰기 시도 ──
    let sheetsWritten = false;
    try {
      const headers = await getCachedHeaders(sheetId, tabName);
      if (headers) {
        const colIdx = headers.findIndex(h => h === submitCol);
        if (colIdx >= 0) {
          const colLetter = getColLetter(colIdx);
          const range = `'${tabName}'!${colLetter}${rowIndex}`;
          await writeSheet(sheetId, range, [[submitValue]]);
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
// Phase 3 개선:
//   1. DB 즉시 저장 (order_submissions)
//   2. Sheets 동시 쓰기 (행 추가)
//   3. Sheets 실패 시 → sync_queue에 등록
//   4. 중복 검사 DB 전용 (Phase 4와 동일)
// ═══════════════════════════════════════════════════════════
router.post('/order', async (req, res, next) => {
  try {
    const b = req.body;
    const { sheetId, gid, tabName, orderer, recipient, userId, phone,
            address, bank, account, depositor, price, dateStr, orderNum,
            memo, selectedOptKey, isCoupang, ncMode } = b;

    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId와 tabName이 필요합니다.' });
    }

    // ── Step 1: DB 기반 중복 검사 (Sheets 읽기 제거) ──
    const dupCheck = await pool.query(
      `SELECT COUNT(*) FROM order_submissions
       WHERE sheet_id = $1 AND tab_name = $2 AND user_id = $3 AND date_str = $4
       AND submitted_at > NOW() - INTERVAL '1 hour'`,
      [sheetId, tabName, userId || '', dateStr || '']
    );
    if (parseInt(dupCheck.rows[0].count) > 0) {
      return res.json({ error: '최근 1시간 내 동일한 주문이 이미 제출되었습니다.', isDuplicate: true });
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

    // ── Step 3: Sheets 행 추가 시도 ──
    const orderData = { orderer, recipient, userId, phone, address, bank, account, depositor, price, dateStr, orderNum, memo, selectedOptKey };
    let sheetsWritten = false;

    try {
      const headers = await getCachedHeaders(sheetId, tabName);
      if (headers) {
        const rowData = _mapOrderToRow(headers, orderData);
        await appendSheet(sheetId, `'${tabName}'!A:A`, [rowData]);
        sheetsWritten = true;
      }
    } catch (sheetsErr) {
      logger.warn(`[submit/order] Sheets 쓰기 실패 → 큐 등록: ${sheetsErr.message}`);

      // ── Step 4: 실패 시 sync_queue에 등록 ──
      try {
        await enqueue('order_append', {
          sheetId,
          tabName,
          orderData,
        });
      } catch (queueErr) {
        logger.error(`[submit/order] 큐 등록도 실패: ${queueErr.message}`);
      }
    }

    // ── SSE 알림: 구매양식 제출 ──
    emitOrderSubmit({
      tabName,
      sheetId,
      orderer: orderer || '',
      recipient: recipient || '',
      dbSaved,
      sheetsWritten,
    });

    res.json({
      ok: true,
      dbSaved,
      sheetsWritten,
      queued: !sheetsWritten,
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
