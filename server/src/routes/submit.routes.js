const express = require('express');
const router = express.Router();
const { writeSheet, readSheet, appendSheet } = require('../services/sheets.service');
const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════
// POST /api/submit/review — 리뷰 제출 (GAS: submitReview — Sheets API 직접 쓰기 유지)
// ═══════════════════════════════════════════════════════════
router.post('/review', async (req, res, next) => {
  try {
    const { sheetId, tabName, rowIndex, submitCol, value, phone8 } = req.body;

    if (!sheetId || !tabName || !rowIndex) {
      return res.json({ error: '필수 파라미터 누락 (sheetId, tabName, rowIndex)' });
    }

    const submitValue = value || '제출';

    try {
      // 시트에서 헤더 행을 읽어서 submitCol 위치 확인
      const headerValues = await readSheet(sheetId, `'${tabName}'!1:1`);
      if (headerValues && headerValues[0]) {
        const headers = headerValues[0].map(h => String(h || '').trim());
        const colIdx = headers.findIndex(h => h === submitCol);
        if (colIdx >= 0) {
          const colLetter = getColLetter(colIdx);
          const range = `'${tabName}'!${colLetter}${rowIndex}`;
          await writeSheet(sheetId, range, [[submitValue]]);
        }
      }
    } catch (sheetsErr) {
      console.warn('Sheets API 쓰기 실패:', sheetsErr.message);
    }

    // DB에서도 인덱스 업데이트 (is_submitted = true)
    try {
      await pool.query(
        `UPDATE review_index SET is_submitted = TRUE, built_at = NOW()
         WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
        [sheetId, tabName, rowIndex]
      );
    } catch (_) { /* DB 없으면 무시 */ }

    res.json({ ok: true, submitted: submitValue });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/submit/order — 구매양식 제출 (GAS: submitOrderForm)
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

    // 중복 검사
    const dupCheck = await pool.query(
      `SELECT COUNT(*) FROM order_submissions
       WHERE sheet_id = $1 AND tab_name = $2 AND user_id = $3 AND date_str = $4
       AND submitted_at > NOW() - INTERVAL '1 hour'`,
      [sheetId, tabName, userId || '', dateStr || '']
    );
    if (parseInt(dupCheck.rows[0].count) > 0) {
      return res.json({ error: '최근 1시간 내 동일한 주문이 이미 제출되었습니다.', isDuplicate: true });
    }

    // Sheets API로 행 추가
    try {
      const headerValues = await readSheet(sheetId, `'${tabName}'!1:1`);
      if (headerValues && headerValues[0]) {
        const headers = headerValues[0].map(h => String(h || '').trim());

        // 헤더에 맞춰 값 배열 구성
        const rowData = headers.map(h => {
          const key = h.toLowerCase();
          if (key.includes('주문자') || key.includes('orderer')) return orderer || '';
          if (key.includes('수취인') || key.includes('이름') || key.includes('recipient')) return recipient || '';
          if (key.includes('아이디') || key.includes('userid') || key.includes('id')) return userId || '';
          if (key.includes('전화') || key.includes('연락') || key.includes('phone')) return phone || '';
          if (key.includes('주소') || key.includes('address')) return address || '';
          if (key.includes('은행') || key.includes('bank')) return bank || '';
          if (key.includes('계좌') || key.includes('account')) return account || '';
          if (key.includes('예금주') || key.includes('depositor')) return depositor || '';
          if (key.includes('금액') || key.includes('price')) return price || '';
          if (key.includes('일자') || key.includes('날짜') || key.includes('date')) return dateStr || '';
          if (key.includes('주문번호') || key.includes('ordernum')) return orderNum || '';
          if (key.includes('비고') || key.includes('memo')) return memo || '';
          if (key.includes('옵션') || key.includes('option')) return selectedOptKey || '';
          return '';
        });

        await appendSheet(sheetId, `'${tabName}'!A:A`, [rowData]);
      }
    } catch (sheetsErr) {
      console.warn('Sheets API 쓰기 실패:', sheetsErr.message);
      // 시트 쓰기 실패해도 DB에는 기록
    }

    // DB에 주문 이력 기록 (중복 검사용)
    try {
      await pool.query(
        `INSERT INTO order_submissions (sheet_id, tab_name, gid, orderer, recipient, user_id, phone, address, order_num, date_str, selected_opt_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sheetId, tabName, gid || '', orderer || '', recipient || '', userId || '', phone || '', address || '', orderNum || '', dateStr || '', selectedOptKey || '']
      );
    } catch (_) { /* DB 없으면 무시 */ }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/submit/check-duplicate — 구매양식 중복 검사 (GAS: checkDuplicateOrder)
// ═══════════════════════════════════════════════════════════
router.post('/check-duplicate', async (req, res, next) => {
  try {
    const { sheetId, tabName, userId, dateStr, orderNum, recipient, phone, address } = req.body;
    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId, tabName 필요' });
    }

    // DB 기반 중복 검사
    const conditions = ['sheet_id = $1', 'tab_name = $2'];
    const params = [sheetId, tabName];
    let idx = 3;

    if (userId) { conditions.push(`user_id = $${idx++}`); params.push(userId); }
    if (orderNum) { conditions.push(`order_num = $${idx++}`); params.push(orderNum); }

    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM order_submissions WHERE ${conditions.join(' AND ')}`,
      params
    );

    const isDuplicate = parseInt(rows[0].count) > 0;

    // 시트에서도 직접 검사 (DB가 비어있을 수 있으므로)
    let sheetDuplicate = false;
    try {
      if (!isDuplicate && (userId || recipient)) {
        const values = await readSheet(sheetId, `'${tabName}'!A:Z`);
        if (values && values.length > 1) {
          const headers = values[0].map(h => String(h || '').trim().toLowerCase());
          const userIdIdx = headers.findIndex(h => h.includes('아이디') || h.includes('userid') || h.includes('id'));
          const recipientIdx = headers.findIndex(h => h.includes('수취인') || h.includes('이름'));

          for (let r = 1; r < values.length; r++) {
            const row = values[r];
            if (userId && userIdIdx >= 0 && String(row[userIdIdx] || '').trim() === userId) {
              sheetDuplicate = true;
              break;
            }
          }
        }
      }
    } catch (_) { /* 시트 접근 실패 시 무시 */ }

    res.json({ ok: true, isDuplicate: isDuplicate || sheetDuplicate });
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

module.exports = router;
