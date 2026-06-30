/**
 * ═══════════════════════════════════════════════════════════
 * columnResolver — review_index 컬럼감지 공용 모듈 (P2a)
 *
 * indexBuilder.parseTabRows / smartBuild._parseTabRows로 중복돼 있던 컬럼감지·행파싱을
 * 단일 순수함수로 통합한다. 본문은 indexBuilder.parseTabRows(슈퍼셋)를 그대로 이식하고,
 * DB-loadable 키워드(NAME/SUBMIT/DATA_TAB/SUBMITTED)만 kw 인자로 외부에서 주입받는다
 * (두 빌더의 키워드 defaults·로더가 동일하므로 어느 쪽이 넘겨도 결과가 같다 = 진동 제거).
 *
 * 헬퍼(_isDataTabRow/_isSubmittedValue/_formatDate)는 두 빌더에서 바이트 동일했던 코드를 그대로 이동.
 * P2b(DB매핑 우선)는 이 한 곳(resolveColumns/parseTabRows)에만 추가하면 된다.
 * ═══════════════════════════════════════════════════════════
 */
const { logger } = require('../utils/logger');

// 헤더행 판정: DATA_TAB_KEYWORDS가 2개 이상 매칭되면 헤더로 인정('번호'는 정확일치).
function _isDataTabRow(cells, DATA_TAB_KEYWORDS) {
  let matchCount = 0;
  for (const kw of DATA_TAB_KEYWORDS) {
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

// 제출 판정(강화 3단계): SUBMITTED_VALUES 직접매칭 → 날짜패턴 → 비어있지 않으면 제출.
function _isSubmittedValue(val, SUBMITTED_VALUES) {
  if (!val) return false;
  if (SUBMITTED_VALUES.includes(val)) return true;
  if (/\d{1,2}\/\d{1,2}/.test(val)) return true;             // MM/DD 또는 M/D
  if (/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(val)) return true;   // YYYY-MM-DD
  if (/\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(val)) return true; // DD.MM.YYYY 등
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

/**
 * 탭 데이터 파싱 (indexBuilder.parseTabRows 슈퍼셋 100% 이식).
 * @param kw { NAME_KEYWORDS, SUBMIT_KEYWORDS, DATA_TAB_KEYWORDS, SUBMITTED_VALUES }
 */
function parseTabRows(values, sheetId, tabName, tabGid, campaignTitle, kw) {
  const { NAME_KEYWORDS, SUBMIT_KEYWORDS, DATA_TAB_KEYWORDS, SUBMITTED_VALUES } = kw;

  const HEADER_SCAN_LIMIT = 50; // 깊은 헤더(32행 등) 대응
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(values.length, HEADER_SCAN_LIMIT); i++) {
    const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
    if (_isDataTabRow(cells, DATA_TAB_KEYWORDS)) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) return [];
  if (headerRowIdx >= 20) {
    logger.info(`[parseTabRows] 깊은 헤더 발견 — tab=${tabName} row=${headerRowIdx}`);
  }

  const headers = values[headerRowIdx].map(h => String(h || '').trim());
  const dataRows = values.slice(headerRowIdx + 1);

  const nameColIdx = headers.findIndex(h => NAME_KEYWORDS.some(k => h.includes(k)));
  if (nameColIdx < 0) {
    logger.warn(`[parseTabRows] 이름 컬럼 미발견 — tab=${tabName} headerRow=${headerRowIdx} headers=${JSON.stringify(headers.slice(0, 20))} NAME_KEYWORDS=${JSON.stringify(NAME_KEYWORDS)}`);
    return [];
  }

  // ── 수취인 컬럼: reviewer_name과 별도로 저장(검색 매칭용) ──
  const RECIPIENT_KEYWORDS = ['수취인', '수취인명', '받는분'];
  let recipientColIdx = -1;
  const nameHeader = headers[nameColIdx] || '';
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
    if (ordererIdx >= 0) {
      recipientColIdx = ordererIdx;
    }
  }

  // ── 제출열 탐색: 우선순위 기반 ("리뷰제출" > "리뷰완료" > 기타 "제출") ──
  let submitColIdx = -1;
  const SUBMIT_PRIORITY_PREFIXES = ['리뷰'];
  const SUBMIT_EXCLUDE_PATTERNS = ['주문자', '수취인', '이름', '성함', '예금주'];

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
      if (SUBMIT_KEYWORDS.some(k => hl.includes(k.toLowerCase()))) {
        submitColIdx = hi;
      }
    }
  }
  if (submitColIdx < 0) {
    submitColIdx = headers.findIndex(h => SUBMIT_KEYWORDS.some(k => h.toLowerCase().includes(k.toLowerCase())));
  }

  const productKeywords = ['상품명', '제품명', '상품', 'product'];
  const productColIdx = headers.findIndex(h => productKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const urlKeywords = ['상품url', '제품url', '상품링크', 'url', '링크'];
  const urlColIdx = headers.findIndex(h => urlKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const phoneKeywords = ['연락처', '전화번호', '핸드폰', '휴대폰', 'phone'];
  const phoneColIdx = headers.findIndex(h => phoneKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const startDateKeywords = ['시작일', '구매일', '주문일', '배정일'];
  const endDateKeywords = ['종료일', '마감일', '완료일', '제출마감'];
  const startDateIdx = headers.findIndex(h => startDateKeywords.some(k => h.includes(k)));
  const endDateIdx = headers.findIndex(h => endDateKeywords.some(k => h.includes(k)));

  const roundKeywords = ['회차', '차수', 'round'];
  const roundIdx = headers.findIndex(h => roundKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  // ── 입금열 탐색 (is_submitted2 / submit_col2) ──
  const PAYMENT_EXACT = ['입금', '입금완료', '입금확인', '입금여부', '페이백'];
  const PAYMENT_PARTIAL = ['페이백입금', '페이백'];
  const PAYMENT_EXCLUDE = ['입금명', '입금자', '예금주', '입금자명', '결제금액', '결제금', '결제일', '결제수단'];
  let paymentColIdx = -1;
  for (let hi = 0; hi < headers.length && paymentColIdx < 0; hi++) {
    const h = headers[hi].trim();
    if (PAYMENT_EXACT.includes(h)) {
      paymentColIdx = hi;
    }
  }
  if (paymentColIdx < 0) {
    for (let hi = 0; hi < headers.length && paymentColIdx < 0; hi++) {
      const hl = headers[hi].toLowerCase();
      if (PAYMENT_EXCLUDE.some(p => hl.includes(p))) continue;
      if (PAYMENT_PARTIAL.some(k => hl.includes(k.toLowerCase()))) {
        paymentColIdx = hi;
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
        if (phoneRaw.length >= 8) {
          phone8 = phoneRaw.slice(-8);
        }
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

module.exports = { parseTabRows, _isDataTabRow, _isSubmittedValue, _formatDate };
