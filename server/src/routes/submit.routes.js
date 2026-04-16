const express = require('express');
const router = express.Router();
const { writeSheet, readSheet } = require('../services/sheets.service');

// POST /api/submit/review — 리뷰 제출 (GAS: submitReview — Sheets API 직접 쓰기 유지)
router.post('/review', async (req, res, next) => {
  try {
    const { sheetId, tabName, rowIndex, submitCol, value, phone8 } = req.body;

    if (!sheetId || !tabName || !rowIndex) {
      return res.json({ error: '필수 파라미터 누락 (sheetId, tabName, rowIndex)' });
    }

    // 제출 값 설정 (기본: "제출")
    const submitValue = value || '제출';

    // TODO: Sheets API로 해당 셀에 값 쓰기
    // 현재는 submitCol 헤더를 사용해서 해당 열에 값 입력
    // 실제 구현 시 Google Sheets API를 통해 처리
    try {
      // 시트에서 헤더 행을 읽어서 submitCol 위치 확인
      const headerValues = await readSheet(sheetId, `'${tabName}'!1:1`);
      if (headerValues && headerValues[0]) {
        const headers = headerValues[0].map(h => String(h || '').trim());
        const colIdx = headers.findIndex(h => h === submitCol);
        if (colIdx >= 0) {
          // 열 문자 계산 (A, B, C, ... AA, AB, ...)
          const colLetter = getColLetter(colIdx);
          const range = `'${tabName}'!${colLetter}${rowIndex}`;
          await writeSheet(sheetId, range, [[submitValue]]);
        }
      }
    } catch (sheetsErr) {
      console.warn('Sheets API 쓰기 실패 (Service Account 미설정?):', sheetsErr.message);
    }

    res.json({ ok: true, submitted: submitValue });
  } catch (err) {
    next(err);
  }
});

// POST /api/submit/check-files — 리뷰파일 존재 확인 (GAS: checkReviewFiles)
router.post('/check-files', async (req, res, next) => {
  try {
    const { sheetId, tabName, rowIndex } = req.body;
    // TODO: Drive API로 리뷰파일 존재 여부 확인
    res.json({ ok: true, exists: false, message: '파일 확인 기능 (구현 예정)' });
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

module.exports = router;
