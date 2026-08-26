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

const PAYMENT_EXACT = ['입금', '입금일', '입금일자', '입금완료', '입금확인', '입금여부', '페이백'];
const PAYMENT_PARTIAL = ['페이백입금', '페이백', '입금'];
const PAYMENT_EXCLUDE = ['입금명', '입금자', '예금주', '입금자명', '결제금액', '결제금', '결제일', '결제수단'];

function compactPaymentHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_\-()[\]{}]/g, '');
}

function findPaymentColumnIndex(headers) {
  const normalized = (headers || []).map(h => String(h || '').trim());
  const exact = normalized.findIndex(h => PAYMENT_EXACT.includes(compactPaymentHeader(h)));
  if (exact >= 0) return exact;
  return normalized.findIndex(h => {
    const compact = compactPaymentHeader(h);
    return !PAYMENT_EXCLUDE.some(p => compact.includes(compactPaymentHeader(p)))
      && PAYMENT_PARTIAL.some(k => compact.includes(compactPaymentHeader(k)));
  });
}

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
//   drift(배열, 선택): 저장 매핑이 거부된 사유 수집 — silent 폴백을 관측 가능하게.
function _dbCol(dbColMap, field, headers, drift = null) {
  if (!dbColMap) return -1;
  const m = dbColMap.get(field);
  if (!m) return -1;
  const ci = m.colIndex;
  if (!Number.isInteger(ci) || ci < 0 || ci >= headers.length) {                 // 범위가드(R2/R11)
    if (drift) drift.push({ field, reason: 'range', storedCol: ci, storedHeader: m.header != null ? String(m.header) : null, currentHeader: null });
    return -1;
  }
  if (m.header != null && String(headers[ci] || '').trim() !== String(m.header).trim()) { // 재앵커(R3/R7)
    if (drift) drift.push({ field, reason: 'reanchor', storedCol: ci, storedHeader: String(m.header), currentHeader: String(headers[ci] || '').trim() || null });
    return -1;
  }
  return ci;
}

/**
 * 탭 데이터 파싱 (슈퍼셋). kw=키워드 세트, dbColMap=DB컬럼매핑(없으면 키워드 전용=P2a 동일).
 * meta(객체, 선택) = 감지 provenance out-param — 넘기면 다음을 채운다(반환값·파싱 로직 불변):
 *   meta.headerRowIdx, meta.drift(=_dbCol 거부 목록),
 *   meta.fields = { name|recipient|review_submit|product|url|phone|start_date|end_date|round|payment:
 *                   { col, header, src: 'db'|'keyword'|'none' } }
 */
function parseTabRows(values, sheetId, tabName, tabGid, campaignTitle, kw, dbColMap = null, meta = null) {
  const { NAME_KEYWORDS, SUBMIT_KEYWORDS, DATA_TAB_KEYWORDS, SUBMITTED_VALUES } = kw;
  const drift = meta ? [] : null;
  if (meta) { meta.headerRowIdx = -1; meta.fields = null; meta.drift = drift; }

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
  if (meta) meta.headerRowIdx = headerRowIdx;

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
  let recipientColIdx = _dbCol(dbColMap, 'recipient', headers, drift);
  const recipientFromDb = recipientColIdx >= 0;
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

  // ── 제출열: 명시적 DB 매핑만 허용 ──
  // 리뷰 옵션/가이드처럼 값이 항상 있는 컬럼을 키워드로 오인하면 전원이 제출완료가 된다.
  // review_submit은 작업별로 명시 저장한 매핑만 신뢰한다. 매핑이 없거나 시트 구조 변경으로
  // 재앵커에 실패하면 안전한 기본값(미제출)을 사용한다.
  let submitColIdx = _dbCol(dbColMap, 'review_submit', headers, drift);
  const submitFromDb = submitColIdx >= 0;

  // ── 상품/URL/연락처/날짜/차수 (P2b: 해당 db_field 우선 → 키워드 폴백) ──
  const productKeywords = ['상품명', '제품명', '상품', 'product'];
  let productColIdx = _dbCol(dbColMap, 'product', headers, drift);
  const productFromDb = productColIdx >= 0;
  if (productColIdx < 0) productColIdx = headers.findIndex(h => productKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  // ★★ 블로그체험단 전용 열(블로그URL·포스팅URL)이 상품URL 을 하이재킹하지 않게 제외한다(099/M2).
  //   urlKeywords 는 'url'·'링크' **부분일치** + findIndex(**첫 매칭 승**)라, 그 열이 상품URL보다
  //   왼쪽에 있으면 `review_index.product_url` 이 통째로 블로그·포스팅 주소가 된다 —
  //   리뷰어 화면의 '상품 페이지'가 남의 블로그로 나가고 검수 대조도 어긋난다.
  // ★ 확실한 두 낱말만 막는다 — 넓히면 멀쩡한 상품열까지 빈 값이 된다(오탐이 더 나쁘다).
  // ★ 전부 걸리면 urlColIdx = -1 → productUrl 빈 값(소비처가 이미 `>= 0` 으로 방어). 포스팅 주소를
  //   상품 주소로 내보내느니 빈 값이 맞다.
  const URL_EXCLUDE_PATTERNS = ['블로그', '포스팅'];
  const urlKeywords = ['상품url', '제품url', '상품링크', 'url', '링크'];
  const urlColIdx = headers.findIndex(h => {
    const hl = h.toLowerCase();
    if (URL_EXCLUDE_PATTERNS.some(p => hl.includes(p))) return false;
    return urlKeywords.some(k => hl.includes(k.toLowerCase()));
  });

  const phoneKeywords = ['연락처', '전화번호', '핸드폰', '휴대폰', 'phone'];
  let phoneColIdx = _dbCol(dbColMap, 'phone', headers, drift);
  const phoneFromDb = phoneColIdx >= 0;
  if (phoneColIdx < 0) phoneColIdx = headers.findIndex(h => phoneKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const startDateKeywords = ['시작일', '구매일', '주문일', '배정일'];
  const endDateKeywords = ['종료일', '마감일', '완료일', '제출마감'];
  const startDateIdx = headers.findIndex(h => startDateKeywords.some(k => h.includes(k)));
  const endDateIdx = headers.findIndex(h => endDateKeywords.some(k => h.includes(k)));

  const roundKeywords = ['회차', '차수', 'round'];
  let roundIdx = _dbCol(dbColMap, 'round', headers, drift);
  const roundFromDb = roundIdx >= 0;
  if (roundIdx < 0) roundIdx = headers.findIndex(h => roundKeywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  // ── 입금일 (표준 키 payment_status, 레거시 payment 매핑도 읽기 호환) ──
  let paymentColIdx = _dbCol(dbColMap, 'payment_status', headers, drift);
  if (paymentColIdx < 0) paymentColIdx = _dbCol(dbColMap, 'payment', headers, drift);
  const paymentFromDb = paymentColIdx >= 0;
  if (paymentColIdx < 0) paymentColIdx = findPaymentColumnIndex(headers);

  // ── 감지 provenance 보고 (meta out-param) — 반환값/파싱에는 영향 없음 ──
  if (meta) {
    const f = (col, fromDb) => ({
      col,
      header: col >= 0 ? (headers[col] || '') : null,
      src: col >= 0 ? (fromDb ? 'db' : 'keyword') : 'none',
    });
    meta.fields = {
      name: f(nameColIdx, false),                       // PII 가드: 항상 키워드 전용
      recipient: f(recipientColIdx, recipientFromDb),
      review_submit: f(submitColIdx, submitFromDb),
      product: f(productColIdx, productFromDb),
      url: f(urlColIdx, false),
      phone: f(phoneColIdx, phoneFromDb),
      start_date: f(startDateIdx, false),
      end_date: f(endDateIdx, false),
      round: f(roundIdx, roundFromDb),
      payment: f(paymentColIdx, paymentFromDb),
    };
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

module.exports = { parseTabRows, findPaymentColumnIndex, _dbCol, _isDataTabRow, _isSubmittedValue, _formatDate };
