const HEADER_DETECT_KEYWORDS = [
  '번호', '주문자', '수취인', '수취인명', '받는분', '성함', '이름', '성명',
  '신청자', '연락처', '전화번호', '핸드폰', '휴대폰', '아이디', '주소',
  '은행', '계좌', '예금주', '결제금액', '주문번호',
];

function normalizeCells(row) {
  return (row || []).map(c => String(c == null ? '' : c).trim());
}

function isSheetHeaderRow(row, minMatches = 2) {
  const cells = normalizeCells(row);
  let matchCount = 0;
  for (const kw of HEADER_DETECT_KEYWORDS) {
    const found = kw === '번호'
      ? cells.includes(kw)
      : cells.some(c => c.includes(kw));
    if (found) {
      matchCount++;
      if (matchCount >= minMatches) return true;
    }
  }
  return false;
}

function detectSheetHeader(rows, { maxScanRows = 50 } = {}) {
  const scanLimit = Math.min(Array.isArray(rows) ? rows.length : 0, maxScanRows);
  for (let i = 0; i < scanLimit; i++) {
    const headers = normalizeCells(rows[i]);
    if (isSheetHeaderRow(headers)) {
      return {
        headerRowIndex: i + 1,
        dataStartRow: i + 2,
        headers,
      };
    }
  }
  return {
    headerRowIndex: null,
    dataStartRow: null,
    headers: null,
  };
}

module.exports = {
  HEADER_DETECT_KEYWORDS,
  normalizeCells,
  isSheetHeaderRow,
  detectSheetHeader,
};
