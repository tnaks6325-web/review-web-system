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

/* 제출열 판정의 기본 키워드 — `indexBuilder`/`smartBuild` 는 런타임 설정(app_settings)이 섞인
   자기 목록을 넘기고, 그 목록이 없는 호출부(작업표 생성)는 이 기본값을 쓴다. */
const DEFAULT_SUBMIT_KEYWORDS = ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰'];

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

  // ── 제출열 — 판정은 `findSubmitColumnIndex` 단일 출처(아래) ──
  //   ★ 이 판정이 "그 탭의 리뷰제출 칸"을 정한다. 작업표 생성(worktablePlan)이 **같은 함수**로
  //     "제출 칸이 있는가"를 확인해 없으면 만들어 붙인다 — 사본을 두면 "만든 칸 ≠ 읽는 칸"이 된다.
  //   ★ `_dbCol` 은 재앵커 거부를 `drift` 에 기록하므로 **한 번만** 부른다(두 번 부르면 거부가 겹쳐 세어진다).
  const submitDbIdx = _dbCol(dbColMap, 'review_submit', headers, drift);
  const submitFromDb = submitDbIdx >= 0;
  const submitColIdx = submitFromDb
    ? submitDbIdx
    : findSubmitColumnIndex(headers, { submitKeywords: SUBMIT_KEYWORDS });

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

  // ── 입금열 (P2b: DB매핑 'payment' 우선 → 정확/부분/제외 키워드 폴백) ──
  let paymentColIdx = _dbCol(dbColMap, 'payment', headers, drift);
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


/**
 * 그 탭에서 **리뷰제출 칸이 되는 열**의 인덱스 — 없으면 -1.
 *
 * ★★ 판정 단일 출처다. 소비처가 둘: ① 인덱스 빌드(`parseTabRows` — 실제로 그 칸에 제출을 기록한다)
 *   ② 작업표 생성(`worktablePlan.ensureReviewColumn` — 그 칸이 없으면 만들어 붙인다).
 *   사본을 두면 **만든 칸과 읽는 칸이 갈려** 제출이 어디에도 안 남는다(2026-08-21 `submit_column_missing` 계열).
 * ★ 본문은 종전 `parseTabRows` 인라인 판정 그대로다(3단계 폴백·제외패턴 포함) — 옮기기만 했다.
 *
 * @param {string[]} headers
 * @param {{dbColMap?:object, drift?:object}} [opts] DB 매핑(있으면 최우선). 생성 단계처럼 매핑이 없으면 생략.
 */
function findSubmitColumnIndex(headers, opts = {}) {
  const list = Array.isArray(headers) ? headers.map(h => String(h == null ? '' : h)) : [];
  if (!list.length) return -1;
  const dbColMap = opts.dbColMap || null;
  const drift = opts.drift || null;
  const kws = Array.isArray(opts.submitKeywords) && opts.submitKeywords.length
    ? opts.submitKeywords : DEFAULT_SUBMIT_KEYWORDS;
  return _findSubmitIdx(list, dbColMap, drift, kws);
}

function _findSubmitIdx(headers, dbColMap, drift, SUBMIT_KEYWORDS) {
  const SUBMIT_PRIORITY_PREFIXES = ['리뷰'];
  // ★★ '포스팅' 제외(2026-08-19 블로그 E2E 실측): 블로그체험단 작업표의 '포스팅제출일' 헤더가
  //   완료신호 '제출'을 포함해 2단계에서 **리뷰제출 열로 오탐**됐다 — 제출 표시('제출')가 날짜 칸에
  //   들어갔다가 포스팅제출일 스탬프에 덮이고, 진짜 '리뷰' 칸은 비어 is_submitted 가 장부 재생성마다
  //   FALSE 로 무너졌다. 포스팅 계열 칸(포스팅결과URL·포스팅제출일)은 결과물·날짜 칸이지 제출 표시
  //   칸이 아니므로 이름열과 같은 급으로 제외한다(제외 후 3단계가 '리뷰' 단독 열을 정상 채택).
  const SUBMIT_EXCLUDE_PATTERNS = ['주문자', '수취인', '이름', '성함', '예금주', '포스팅'];
  // ★★ 8/3 실측 사고(박은비 탭): SUBMIT_KEYWORDS에 완료신호 단어(제출/완료/submit)와 함께
  //   넓은 catch-all인 '리뷰' 단독도 섞여 있다. 1·2단계(우선탐지)에서 '리뷰'를 그대로 매칭에
  //   쓰면 그 자체가 SUBMIT_PRIORITY_PREFIXES('리뷰')와 항상 동시에 참이 되어 AND 조건이
  //   무력화된다 — '리뷰가이드'(작업지시 열, 항상 값이 차 있음) 같은 열이 실제 '리뷰제출'열보다
  //   먼저 잡혀 참여자 전원이 제출완료로 오판정됐다(2단계도 같은 이유로 동일 오탐).
  //   → 1·2단계(우선탐지)는 완료신호 키워드만 쓰고, '리뷰' 단독 매칭은 완료신호 열이 전혀
  //   없을 때의 최후수단(3단계, 기존 동작 그대로)에만 남긴다.
  const SUBMIT_COMPLETION_KEYWORDS = SUBMIT_KEYWORDS.filter(k => k !== '리뷰');
  let submitColIdx = _dbCol(dbColMap, 'review_submit', headers, drift);
  if (submitColIdx < 0) {
    for (let hi = 0; hi < headers.length && submitColIdx < 0; hi++) {
      const hl = headers[hi].toLowerCase();
      if (SUBMIT_PRIORITY_PREFIXES.some(p => hl.includes(p)) &&
          SUBMIT_COMPLETION_KEYWORDS.some(k => hl.includes(k.toLowerCase()))) {
        submitColIdx = hi;
      }
    }
    if (submitColIdx < 0) {
      for (let hi = 0; hi < headers.length && submitColIdx < 0; hi++) {
        const hl = headers[hi].toLowerCase();
        if (SUBMIT_EXCLUDE_PATTERNS.some(p => hl.includes(p))) continue;
        if (SUBMIT_COMPLETION_KEYWORDS.some(k => hl.includes(k.toLowerCase()))) submitColIdx = hi;
      }
    }
    // ★★ 8/4 재발(면마스크 탭 실측): 3단계(최후수단, 바로 위 두 단계가 못 찾았을 때만 도달)는
    //   '리뷰' 단독 매칭까지 허용해야 하는 이유가 있다 — 이 탭처럼 완료열 이름이 아예 '리뷰'
    //   뿐(리뷰제출/리뷰완료 접미 없음)인 정상 시트도 실재한다. 문제는 이 단계에 제외패턴이
    //   없어서, 완료열이 헤더 순서상 '주문자제출'(이름열, '제출' 포함)보다 뒤에 있으면
    //   '주문자제출'을 먼저 집어 전원 제출완료로 오판정한다(2단계에서 이미 걸러지던 예외를
    //   3단계가 다시 무방비로 통과시킴). → 2단계와 동일하게 이름열 제외패턴을 적용해
    //   '리뷰' 단독 매칭은 허용하되 이름류 열은 여전히 걸러낸다.
    if (submitColIdx < 0) {
      submitColIdx = headers.findIndex(h => {
        const hl = h.toLowerCase();
        if (SUBMIT_EXCLUDE_PATTERNS.some(p => hl.includes(p))) return false;
        return SUBMIT_KEYWORDS.some(k => hl.includes(k.toLowerCase()));
      });
    }
  }

  return submitColIdx;
}

module.exports = { parseTabRows, findPaymentColumnIndex, findSubmitColumnIndex, DEFAULT_SUBMIT_KEYWORDS, _dbCol, _isDataTabRow, _isSubmittedValue, _formatDate };
