/**
 * ═══════════════════════════════════════════════════════════
 * columnResolver — review_index 컬럼감지 공용 모듈 (P2a + P2b)
 *
 * P2a: indexBuilder/smartBuild로 중복돼 있던 컬럼감지·행파싱을 단일 순수함수로 통합.
 * P2b: DB 컬럼매핑(tab_column_mappings) 우선 → 키워드 폴백(opt-in). 매핑이 없으면 P2a와 100% 동일.
 *      안전장치: per-field 재앵커(저장 헤더==현재 헤더일 때만 신뢰), col_index 범위가드,
 *      nameColIdx override 제외(PII 교차노출 방지 — 이름열은 키워드 전용).
 * ═══════════════════════════════════════════════════════════
 */
const { logger } = require('../utils/logger');

function _isDataTabRow(cells, DATA_TAB_KEYWORDS) {
  let matchCount = 0;
  for (const kw of DATA_TAB_KEYWORDS) {
    const found = kw === '번호' ? cells.includes(kw) : cells.some(c => c.includes(kw));
    if (found) { matchCount++; if (matchCount >= 2) return true; }
  }
  return false;
}

function _isSubmittedValue(val, SUBMITTED_VALUES) {
  if (!val) return false;
  if (SUBMITTED_VALUES.includes(val)) return true;
  if (/\d{1,2}\/\d{1,2}/.test(val)) return true;
  if (/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(val)) return true;
  if (/\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(val)) return true;
  return val.length > 0;
}

function _formatDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return s;
  const num = Number(s);
  if (!isNaN(num) && num > 40000 && num < 50000) {
    const date = new Date((num - 25569) * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }
  return s;
}

// ── P2b: DB매핑에서 그 필드의 시트 컬럼 인덱스를 "증명 가능할 때만" 반환 ──
//   dbColMap: Map<db_field, { colIndex, header }>. 없으면/범위밖/재앵커 불일치면 -1(→키워드 폴백).
function _dbCol(dbColMap, field, headers) {
  if (!dbColMap) return -1;
  const m = dbColMap.get(field);
  if (!m) return -1;
  const ci = m.colIndex;
  if (!Number.isInteger(ci) || ci < 0 || ci >= headers.length) return -1;        // 범위가드(R2/R11)
  if (m.header != null && String(headers[ci] || '').trim() !== String(m.header).trim()) return -1; // 재앵커(R3/R7)
  return ci;
}

/**
 * 탭 데이터 파싱 (슈퍼셋). kw=키워드 세트, dbColMap=DB컬럼매핑(없으면 키워드 전용=P2a 동일).
 */
function parseTabRows(values, sheetId, tabName, tabGid, campaignTitle, kw, dbColMap = null) {
  const { NAME_KEYWORDS, SUBMIT_KEYWORDS, DATA_TAB_KEYWORDS, SUBMITTED_VALUES } = kw;

  const HEADER_SCAN_LIMIT = 50;
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(values.length, HEADER_SCAN_LIMIT); i++) {
    const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
    if (_isDataTabRow(cells, DATA_TAB_KEYWORDS)) { headerRowIdx = i; break; }
  }
  if (headerRowIdx < 0) return [];
  if (headerRowIdx >= 20) {
    logger.info(`[parseTabRows] 깊은 헤더 발견 — tab=${tabName} row=${headerRowIdx}`);
  }

  const headers = values[headerRowIdx].map(h => String(h || '').trim());
  const dataRows = values.slice(headerRowIdx + 1);

  // ★ nameColIdx는 키워드 전용(P2b: DB override 제외 — reviewer_name 열 이동 시 phone8 교차노출 위험).
  //   ★ 이름열 우선순위(사용자 지정): 주문자 계열('주문자'/'주문자제출')을 최우선으로 잡는다.
  //     리뷰 작성자 = 구매자(주문자)라는 도메인 규칙 — 여러 이름 키워드가 공존하고 수취인이 더 왼쪽이어도
  //     주문자열이 있으면 그걸 이름열로. 주문자열이 없을 때만 나머지 NAME_KEYWORDS(수취인/이름/…) 폴백.
  //     (NAME_PRIORITY_KEYWORDS는 '주문자' 하나로 '주문자제출'까지 포함매칭으로 커버.)
  const NAME_PRIORITY_KEYWORDS = ['주문자'];
  let nameColIdx = headers.findIndex(h => NAME_PRIORITY_KEYWORDS.some(k => h.includes(k)));
  if (nameColIdx < 0) nameColIdx = headers.findIndex(h => NAME_KEYWORDS.some(k => h.includes(k)));
  if (nameColIdx < 0) {
    logger.warn(`[parseTabRows] 이름 컬럼 미발견 — tab=${tabName} headerRow=${headerRowIdx} headers=${JSON.stringify(headers.slice(0, 20))} NAME_KEYWORDS=${JSON.stringify(NAME_KEYWORDS)}`);
    return [];
  }

  // ── 수취인 컬럼 (P2b: DB매핑 'recipient' 우선 → 키워드 폴백) ──
  const RECIPIENT_KEYWORDS = ['수취인', '수취인명', '받는분'];
  const nameHeader = headers[nameColIdx] || '';
  let recipientColIdx = _dbCol(dbColMap, 'recipient', headers);
  if (recipientColIdx < 0) {
    if (nameHeader.includes('주문자') || nameHeader.includes('예금주')) {
      recipientColIdx = headers.findIndex((h, hi) => {
        if (hi === nameColIdx) return false;
        return RECIPIENT_KEYWORDS.some(k => h.includes(k));
      });
    }
    if (recipientColIdx < 0 && RECIPIENT_KEYWORDS.some(k => nameHeader.includes(k))) {
      const ordererIdx = headers.findIndex((h, hi) => {
        if (hi === nameColIdx) return false;
        return h.includes('주문자');
      });
      if (ordererIdx >= 0) recipientColIdx = ordererIdx;
    }
  }

  // ── 제출열 (P2b: DB매핑 'review_submit' 우선 → 3단계 키워드 폴백) ──
  const SUBMIT_PRIORITY_PREFIXES = ['리뷰'];
  const SUBMIT_EXCLUDE_PATTERNS = ['주문자', '수취인', '이름', '성함', '예금주'];
  let submitColIdx = _dbCol(dbColMap, 'review_submit', headers);
  if (submitColIdx < 0) {
    for (let hi = 0; hi < headers.length && submitColIdx < 0; hi++) {
      const hl = headers[hi].toLowerCase();
      if (SUBMIT_PRIORITY_PREFIXES.some(p => hl.includes(p)) &&
          SUBMIT_KEYWORDS.some(k => hl.includes(k.toLowerCase()))) {
        submitColIdx = hi;
      }
    }
    if (submitColIdx < 0) {
      for (let hi = 0; hi < headers.length && submitColIdx < 0; hi++) {
        const hl = headers[hi].toLowerCase();
        if (SUBMIT_EXCLUDE_PATTERNS.some(p => hl.includes(p))) continue;
        if (SUBMIT_KEYWORDS.some(k => hl.includes(k.toLowerCase()))) submitColIdx = hi;
      }
    }
    if (submitColIdx < 0) {
      submitColIdx = headers.findIndex(h => SUBMIT_KEYWORDS.some(k => h.toLowerCase().includes(k.toLowerCase())));
    }
  }

  // ── 상품/URL/연락처/날짜/차수 (P2b: 해당 db_field 우선 → 키워드 폴백) ──
  const productKeywords = ['상품명', '제품명', '상품', 'product'];
  let productColIdx = _dbCol(dbColMap, 'product', headers);
  if (productColIdx < 0) productColIdx = headers.findIndex(h => productKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const urlKeywords = ['상품url', '제품url', '상품링크', 'url', '링크'];
  const urlColIdx = headers.findIndex(h => urlKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const phoneKeywords = ['연락처', '전화번호', '핸드폰', '휴대폰', 'phone'];
  let phoneColIdx = _dbCol(dbColMap, 'phone', headers);
  if (phoneColIdx < 0) phoneColIdx = headers.findIndex(h => phoneKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const startDateKeywords = ['시작일', '구매일', '주문일', '배정일'];
  const endDateKeywords = ['종료일', '마감일', '완료일', '제출마감'];
  const startDateIdx = headers.findIndex(h => startDateKeywords.some(k => h.includes(k)));
  const endDateIdx = headers.findIndex(h => endDateKeywords.some(k => h.includes(k)));

  const roundKeywords = ['회차', '차수', 'round'];
  let roundIdx = _dbCol(dbColMap, 'round', headers);
  if (roundIdx < 0) roundIdx = headers.findIndex(h => roundKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  // ── 입금열 (P2b: DB매핑 'payment' 우선 → 정확/부분/제외 키워드 폴백) ──
  const PAYMENT_EXACT = ['입금', '입금완료', '입금확인', '입금여부', '페이백'];
  const PAYMENT_PARTIAL = ['페이백입금', '페이백'];
  const PAYMENT_EXCLUDE = ['입금명', '입금자', '예금주', '입금자명', '결제금액', '결제금', '결제일', '결제수단'];
  let paymentColIdx = _dbCol(dbColMap, 'payment', headers);
  if (paymentColIdx < 0) {
    for (let hi = 0; hi < headers.length && paymentColIdx < 0; hi++) {
      if (PAYMENT_EXACT.includes(headers[hi].trim())) paymentColIdx = hi;
    }
    if (paymentColIdx < 0) {
      for (let hi = 0; hi < headers.length && paymentColIdx < 0; hi++) {
        const hl = headers[hi].toLowerCase();
        if (PAYMENT_EXCLUDE.some(p => hl.includes(p))) continue;
        if (PAYMENT_PARTIAL.some(k => hl.includes(k.toLowerCase()))) paymentColIdx = hi;
      }
    }
  }

  return dataRows
    .map((row, i) => {
      const name = String(row[nameColIdx] || '').trim();
      if (!name) return null;

      const submitVal = submitColIdx >= 0 ? String(row[submitColIdx] || '').trim() : '';
      const isSubmitted = _isSubmittedValue(submitVal, SUBMITTED_VALUES);

      const paymentVal = paymentColIdx >= 0 ? String(row[paymentColIdx] || '').trim() : '';
      let isSubmitted2 = null;
      if (paymentColIdx >= 0) {
        isSubmitted2 = paymentVal && _isSubmittedValue(paymentVal, SUBMITTED_VALUES) ? 'PAID' : 'NONE';
      }

      let phone8 = null;
      if (phoneColIdx >= 0) {
        const phoneRaw = String(row[phoneColIdx] || '').replace(/[^0-9]/g, '');
        if (phoneRaw.length >= 8) phone8 = phoneRaw.slice(-8);
      }

      return {
        name,
        recipientName: recipientColIdx >= 0 ? String(row[recipientColIdx] || '').trim() : null,
        tabGid,
        rowIndex: headerRowIdx + 1 + i + 1,
        isSubmitted,
        isSubmitted2,
        submitCol: submitColIdx >= 0 ? headers[submitColIdx] : '',
        submitCol2: paymentColIdx >= 0 ? headers[paymentColIdx] : '',
        productName: productColIdx >= 0 ? String(row[productColIdx] || '').trim() : '',
        productUrl: urlColIdx >= 0 ? String(row[urlColIdx] || '').trim() : '',
        rowJson: Object.fromEntries(headers.map((h, j) => [h, row[j] !== undefined ? row[j] : ''])),
        startDate: startDateIdx >= 0 ? _formatDate(row[startDateIdx]) : null,
        endDate: endDateIdx >= 0 ? _formatDate(row[endDateIdx]) : null,
        round: roundIdx >= 0 ? String(row[roundIdx] || '').trim() : '',
        campaignName: campaignTitle || tabName,
        phone8,
      };
    })
    .filter(Boolean);
}

module.exports = { parseTabRows, _dbCol, _isDataTabRow, _isSubmittedValue, _formatDate };
