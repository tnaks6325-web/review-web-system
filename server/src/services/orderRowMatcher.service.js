const INAD_COL_KEYWORDS = ['인애드', '인애드명', '인애드제출', '카톡', '카카오', '닉네임'];
// ★ 인애드 후보에서 제외할 헤더 키워드 — 자유기재(비고/특이사항/메모) 컬럼은
//   "비고(닉네임 등 자유)"처럼 '닉네임'을 포함해도 인애드 컬럼으로 인식하지 않는다.
const INAD_EXCLUDE_KEYWORDS = ['비고', '특이사항', '메모', 'memo'];
const OPTION_COL_KEYWORDS = ['옵션', 'option'];
const MAX_OPTION_COLS = 3;

function _headerAt(headers, idx) {
  return String(headers[idx] || '').trim().toLowerCase();
}

function _findFirstCol(headers, keywords, exact = []) {
  return headers.findIndex((h) => {
    const raw = String(h || '').trim();
    const hl = raw.toLowerCase();
    return exact.includes(hl) || keywords.some((kw) => hl.includes(kw));
  });
}

// ★ orderLedger._isIdHeader 와 동일 규칙('쿠팡id'/'네이버id'/'id'/'아이디'/'userid'). dead-code 모듈이라
//   순환 require 회피 위해 지역 복제. NOTE: 이 모듈은 현재 src/ 어디서도 import되지 않음(test/만 참조).
function _isIdHeaderRM(h) {
  const k = String(h || '').trim().toLowerCase();
  if (!k) return false;
  return k.includes('아이디') || k.includes('userid') || k === 'id' || /(^|[^a-z])id$/.test(k);
}

function getOrderRowColumns(headers, maxOptionCols = MAX_OPTION_COLS) {
  const optionColIndices = [];
  for (let ci = 0; ci < headers.length && optionColIndices.length < maxOptionCols; ci++) {
    const hl = _headerAt(headers, ci);
    if (OPTION_COL_KEYWORDS.some((kw) => hl.includes(kw))) optionColIndices.push(ci);
  }

  return {
    inadColIdx: headers.findIndex((h) => {
      const hl = String(h || '').trim().toLowerCase();
      if (INAD_EXCLUDE_KEYWORDS.some((kw) => hl.includes(kw))) return false;
      return INAD_COL_KEYWORDS.some((kw) => hl.includes(kw));
    }),
    optionColIndices,
    orderNumColIdx: _findFirstCol(headers, ['주문번호', 'ordernum', 'order_num', 'order number']),
    ordererColIdx: _findFirstCol(headers, ['주문자제출', '주문자', 'orderer']),
    recipientColIdx: _findFirstCol(headers, ['수취인', '받는분', 'recipient'], ['성함', '이름']),
    userIdColIdx: headers.findIndex((h) => _isIdHeaderRM(h)),
    phoneColIdx: _findFirstCol(headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']),
    addressColIdx: _findFirstCol(headers, ['주소', 'address']),
    bankColIdx: _findFirstCol(headers, ['은행', 'bank']),
    accountColIdx: _findFirstCol(headers, ['계좌', 'account']),
    depositorColIdx: _findFirstCol(headers, ['예금주', 'depositor']),
  };
}

function _value(row, idx) {
  if (idx < 0) return '';
  return String((row || [])[idx] || '').trim();
}

function hasSubmittedOrderData(row, cols) {
  const submittedIndices = [
    cols.orderNumColIdx,
    cols.ordererColIdx,
    cols.recipientColIdx,
    cols.userIdColIdx,
    cols.phoneColIdx,
    cols.addressColIdx,
    cols.bankColIdx,
    cols.accountColIdx,
    cols.depositorColIdx,
  ];
  return submittedIndices.some((idx) => _value(row, idx) !== '');
}

function isAvailableOrderRow(row, cols) {
  return !hasSubmittedOrderData(row, cols);
}

function selectOrderTargetRow({ headers, dataRows, orderer, selectedOptKey, maxOptionCols = MAX_OPTION_COLS }) {
  const cols = getOrderRowColumns(headers || [], maxOptionCols);
  const rows = dataRows || [];
  const submittedOrderer = String(orderer || '').trim();
  const submittedOptKey = String(selectedOptKey || '').trim();
  const optKeyParts = submittedOptKey ? submittedOptKey.split('|').map((v) => v.trim()) : [];

  if (cols.inadColIdx >= 0 && submittedOrderer) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || [];
      if (!isAvailableOrderRow(row, cols)) continue;
      if (_value(row, cols.inadColIdx) === submittedOrderer) {
        return { emptyRowOffset: i, matchType: 'inad', columns: cols };
      }
    }
  }

  if (submittedOptKey && cols.optionColIndices.length > 0) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || [];
      if (!isAvailableOrderRow(row, cols)) continue;

      const optMatch = cols.optionColIndices.every((ci, oi) => {
        const expectedVal = optKeyParts[oi] || '';
        return _value(row, ci).toLowerCase() === expectedVal.toLowerCase();
      });
      if (optMatch) return { emptyRowOffset: i, matchType: 'option', columns: cols };
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    if (isAvailableOrderRow(row, cols)) {
      return { emptyRowOffset: i, matchType: 'first_available', columns: cols };
    }
  }

  return { emptyRowOffset: rows.length, matchType: 'append', columns: cols };
}

module.exports = {
  getOrderRowColumns,
  hasSubmittedOrderData,
  isAvailableOrderRow,
  selectOrderTargetRow,
};
