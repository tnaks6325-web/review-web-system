const { detectSheetHeader, normalizeCells } = require('../utils/sheetHeader');
const { logger } = require('../utils/logger');
const { findSameDayDuplicateInTx, findEquivalentOrderInTx, sameDayDuplicateLockKey } = require('./orderDuplicate.service');
const { parseSelectionKey } = require('./productOptions.service');

const INAD_COL_KEYWORDS = ['인애드', '인애드명', '인애드제출', '카톡', '카카오', '닉네임'];
const OPTION_COL_KEYWORDS = ['옵션', 'option'];
const REVIEW_OPTION_HEADERS = new Set(['리뷰옵션', 'review option', 'review_option']);
function isReviewOptionHeader(value) {
  return REVIEW_OPTION_HEADERS.has(String(value || '').toLowerCase().trim());
}
// ★ 캠페인 준비(설정) 컬럼 — 관리자가 모집 전 미리 채워두는 열(주문 데이터가 아님).
//   "행 점유(채워짐)" 카운트(countFilledForAssignment)에서 제외해야, 이 열들이 채워진 준비행이
//   '점유됨'으로 오판돼 배정 후보에서 빠지고 주문이 하단(작업범위 밖)에 append되는 사고를 막는다.
//   (기존 제외: 번호·구매일자·상품명·옵션·인애드명단. 일부 시트가 차수/담당/구매타입/링크/키워드를
//    추가 준비열로 쓰면서 카운트가 임계값(4)을 넘겨 준비행 전체가 배정에서 제외되던 버그를 해소.)
//   ※ 주문 데이터 컬럼(주문자·수취인·연락처·주소·은행·계좌·예금주·결제금액·주문번호 등)과
//     키워드 충돌 없음 → 실주문행은 여전히 4칸↑로 점유 유지(오배정 무영향).
const PREP_COL_KEYWORDS = ['차수', '담당', '구매타입', '링크', '키워드'];
const FILLED_THRESHOLD = 4;
const APPEND_CANDIDATE_COUNT = 20;

let _pool;
function getPool() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}

function __setPoolForTest(pool) {
  _pool = pool || null;
}

// ★ 미러 안 된 탭에 주문이 오면 그 시트를 백그라운드로 1회 자동미러(탭당 60초 debounce)
//   → 메타가 채워지면 즉시 그 시트의 막힌 주문을 리컨실(행배정+큐). 버스트에도 시트당 미러 1회뿐.
//   (예전: 제출마다 시트를 라이브로 통읽기 → 동시 수백건이면 시트 쿼터 폭발. 그 경로를 대체.)
const _mirrorTriggered = new Map(); // sheetId → 마지막 트리거 시각(ms)
function _triggerSheetMirrorOnce(sheetId) {
  if (!sheetId) return;
  const now = Date.now();
  const last = _mirrorTriggered.get(sheetId) || 0;
  if (now - last < 60000) return; // 60초 debounce
  _mirrorTriggered.set(sheetId, now);
  setImmediate(async () => {
    try {
      const { mirrorOneSheet } = require('./rawMirror.service');
      const { withJobLock } = require('../utils/jobLock');
      await mirrorOneSheet(sheetId);
      // ★ #1: cron/flush reconcile과 동일한 order_reconcile 락으로 직렬화(동시 행배정 경합 차단).
      //   락 busy면 양보 — 정규 cron(리컨실 2분)이 backstop.
      await withJobLock('order_reconcile', () => reconcileStuckOrders({ sheetId, limit: 500, perTabCap: 500 }));
    } catch (_) { /* best-effort; 정규 cron(미러 5분·리컨실 2분)이 backstop */ }
  });
}

function toPhone8(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, '');
}

function computeDedupKey({ orderNum, recipient, phone, dateStr, selectedOptKey, orderSubmissionId } = {}) {
  const num = String(orderNum == null ? '' : orderNum).replace(/[^0-9]/g, '');
  if (num.length >= 6) return `num:${num}`;
  // ★ D4(#5): 주문번호가 약하면(쿠팡 비번호/분할주문 등 6자리 미만) 같은 사람·같은 날·같은 옵션의
  //   별개 주문 2건이 동일 dedupKey → 같은 행 공유 → 한 건 시트 영구소실. orderSubmissionId(UUID)를
  //   폴백 키로 써서 별개 주문은 별개 행. reconcile은 row.dedup_key를 재사용하므로 재시도 멱등 유지.
  if (orderSubmissionId) return `osid:${orderSubmissionId}`;
  const rcp = normalizeText(recipient);
  const p8 = toPhone8(phone);
  const date = normalizeText(dateStr);
  const opt = normalizeText(selectedOptKey);
  return `rcp:${rcp}|${p8}|${date}|${opt}`;
}

function getColLetter(colIdx) {
  let letter = '';
  let idx = colIdx;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

function findColumn(headers, keywords, exact = []) {
  return (headers || []).findIndex(h => {
    const key = String(h || '').toLowerCase().trim();
    return exact.includes(key) || keywords.some(kw => key.includes(kw.toLowerCase()));
  });
}

function countFilledForAssignment(headers, row) {
  const excluded = new Set();
  (headers || []).forEach((h, idx) => {
    const key = String(h || '').toLowerCase();
    if (key === '번호' || key === 'no' || key === '#') excluded.add(idx);
    if (INAD_COL_KEYWORDS.some(kw => key.includes(kw))) excluded.add(idx);
    if (key.includes('구매일') || key.includes('상품') || key.includes('product')) excluded.add(idx);
    if (OPTION_COL_KEYWORDS.some(kw => key.includes(kw))) excluded.add(idx);
    if (PREP_COL_KEYWORDS.some(kw => key.includes(kw))) excluded.add(idx); // ★ 준비열(차수/담당/구매타입/링크/키워드) 제외
  });
  return (row || []).filter((cell, idx) => {
    if (excluded.has(idx)) return false;
    const val = String(cell == null ? '' : cell).trim();
    return val !== '' && val !== '0';
  }).length;
}

function isUnfilledOrderRow(headers, row) {
  const phoneColIdx = findColumn(headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']);
  const addressColIdx = findColumn(headers, ['주소', 'address']);
  const phoneVal = phoneColIdx >= 0 ? String((row || [])[phoneColIdx] || '').trim() : '';
  const addrVal = addressColIdx >= 0 ? String((row || [])[addressColIdx] || '').trim() : '';
  return !phoneVal && !addrVal;
}

function pushUnique(arr, seen, rowIndex) {
  const n = parseInt(rowIndex, 10);
  if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
    seen.add(n);
    arr.push(n);
  }
}

function buildCandidateRows({ headers, dataRows, headerRowIndex, orderData = {}, appendOnly = false, appendBaseRow = 0 }) {
  const candidates = [];
  const seen = new Set();
  const rows = (dataRows || []).map((r, idx) => ({
    rowIndex: parseInt(r.rowIndex, 10) || ((headerRowIndex || 0) + 1 + idx),
    cells: normalizeCells(r.cells || r),
  }));

  // ★ appendOnly: 복구(reconcile) 경로 — 제자리(인애드/옵션/빈행) 매칭을 건너뛰고
  //   기존 데이터 "아래"의 새 행만 후보로 삼는다(노란 배경으로 append 기록 → 수동입력분과 구분).
  if (!appendOnly) {
  const inadColIdx = findColumn(headers, INAD_COL_KEYWORDS);
  const submittedOrderer = String(orderData.orderer || '').trim();
  if (inadColIdx >= 0 && submittedOrderer) {
    for (const row of rows) {
      if (countFilledForAssignment(headers, row.cells) >= FILLED_THRESHOLD) continue;
      const inadVal = String(row.cells[inadColIdx] || '').trim();
      if (inadVal === submittedOrderer && isUnfilledOrderRow(headers, row.cells)) {
        pushUnique(candidates, seen, row.rowIndex);
      }
    }
  }

  const selectedOptKey = String(orderData.selectedOptKey || '').trim();
  const stagedSelection = parseSelectionKey(selectedOptKey);
  const stagedCols = {
    product: (headers || []).findIndex(h => /^(상품|product)$/i.test(String(h || '').trim())),
    option1: (headers || []).findIndex(h => /^(1차|1st)\s*옵션$/i.test(String(h || '').trim())),
    option2: (headers || []).findIndex(h => /^(2차|2nd)\s*옵션$/i.test(String(h || '').trim())),
  };
  if (stagedSelection && stagedCols.product >= 0 && stagedCols.option1 >= 0) {
    for (const row of rows) {
      if (countFilledForAssignment(headers, row.cells) >= FILLED_THRESHOLD) continue;
      const matches = String(row.cells[stagedCols.product] || '').trim().toLowerCase() === stagedSelection.productName.toLowerCase()
        && String(row.cells[stagedCols.option1] || '').trim().toLowerCase() === stagedSelection.option1Value.toLowerCase()
        && (stagedCols.option2 < 0 || String(row.cells[stagedCols.option2] || '').trim().toLowerCase() === stagedSelection.option2Value.toLowerCase());
      if (matches && isUnfilledOrderRow(headers, row.cells)) pushUnique(candidates, seen, row.rowIndex);
    }
  }
  const optParts = selectedOptKey ? selectedOptKey.split('|').map(v => v.trim().toLowerCase()) : [];
  const optColIndices = [];
  // ★ 리뷰옵션 칸(행별 리뷰형태 지시 — 작업표 생성이 '포토리뷰'·'텍스트'를 선기입)은 매칭에서
  //   제외한다. 포함하면 리뷰어가 고른 상품옵션('블랙')을 리뷰옵션 칸 값과 대조해 매칭이
  //   구조적으로 전패 → 옵션별 행 소진이 무너진다(판정은 utils/reviewType 단일 출처).
  const { isReviewOptionHeader: _isRtCol } = require('../utils/reviewType');
  (headers || []).forEach((h, idx) => {
    const key = String(h || '').toLowerCase();
    if (optColIndices.length < 3 && !_isRtCol(h) && OPTION_COL_KEYWORDS.some(kw => key.includes(kw))) {
      optColIndices.push(idx);
    }
  });
  if (selectedOptKey && optColIndices.length > 0) {
    for (const row of rows) {
      if (countFilledForAssignment(headers, row.cells) >= FILLED_THRESHOLD) continue;
      const optMatch = optColIndices.every((colIdx, idx) => {
        const actual = String(row.cells[colIdx] || '').trim().toLowerCase();
        const expected = optParts[idx] || '';
        return actual === expected;
      });
      if (optMatch && isUnfilledOrderRow(headers, row.cells)) {
        pushUnique(candidates, seen, row.rowIndex);
      }
    }
  }

  for (const row of rows) {
    if (countFilledForAssignment(headers, row.cells) >= FILLED_THRESHOLD) continue;
    if (isUnfilledOrderRow(headers, row.cells)) {
      pushUnique(candidates, seen, row.rowIndex);
    }
  }
  } // end if(!appendOnly)

  // ★ R-2a: append base를 미러 maxRow와 claims MAX(appendBaseRow) 중 큰 값으로 통일.
  //   제출 핫패스가 claims를 안 보면 같은 maxRow+1을 여러 제출이 동시 후보로 잡아 동일행 경쟁(버스트) →
  //   claims MAX 합류로 reconcile과 단일 진실원본화(단조증가, 손실0).
  const maxRow = Math.max(
    rows.reduce((max, row) => Math.max(max, row.rowIndex), headerRowIndex || 1),
    parseInt(appendBaseRow, 10) || 0
  );
  for (let i = 1; i <= APPEND_CANDIDATE_COUNT; i++) {
    pushUnique(candidates, seen, maxRow + i);
  }
  return candidates;
}

// ★ id열 판정 공용 규칙 — '쿠팡id'/'네이버id'/'id'/'아이디'/'userid' 인식, 'paid'(앞 a-z) 오탐 회피.
//   mapOrderToSheetRow · _fieldToCol('user_id') · 백필이 이 규칙을 공유해 append/update/cancel/sig/detect가 일관되게 같은 열을 본다.
//   (버그이력: 옛 규칙 key==='id' 는 헤더 '쿠팡id'를 못 잡아 쿠팡탭 id열이 영구 공란이었다.)
const _ID_EXACT_ADMIN = ['번호', 'no', '#'];
const _ID_ADMIN_KW = ['인애드', '카톡', '닉네임', '상품', '상품명'];

/* ── 138 선택 상품 칸 ────────────────────────────────────────────────────────────
   복합유형 작업(137)의 선택 단위가 "옵션 없는 상품"이면 그 키는 **상품명**이라, 옵션 칸에 쓰면
   관리자 작업지시('텍스트'·'포토리뷰')를 덮는다(8/3 사고). 그래서 **옵션과 다른 칸**에 적는다.
   ★ 좌측 정렬 우선순위(사용자 확정 2026-08-25) = 상품 > 옵션 > 리뷰옵션. */
const PRODUCT_HEADER = '상품';
const PRODUCT_HEADER_KEY = PRODUCT_HEADER.toLowerCase();
function _isIdHeader(key) {
  const k = String(key || '').toLowerCase().trim();
  if (!k) return false;
  return k.includes('아이디') || k.includes('userid') || k === 'id' || /(^|[^a-z])id$/.test(k);
}
// ★ map의 id-규칙이 실제로 "이기는" 열만 카운트 — id 규칙보다 앞선 규칙(관리자/주문자/수취인)에
//   선점된 열 + '비고(아이디확인)'류 메모열(오탐)을 제외한 잔여 id열만 센다.
function _idColIndices(headers) {
  const out = [];
  (headers || []).forEach((h, i) => {
    const key = String(h || '').toLowerCase().trim();
    if (_ID_EXACT_ADMIN.includes(key)) return;
    if (_ID_ADMIN_KW.some(kw => key === kw || key.includes(kw))) return;
    if (key.includes('주문자') || key.includes('orderer')) return;
    if (key.includes('수취인') || key.includes('받는분') || key.includes('이름') || key.includes('recipient')) return;
    if (key.includes('비고') || key.includes('특이사항') || key.includes('memo')) return; // 메모열 오탐 제외
    if (_isIdHeader(key)) out.push(i);
  });
  return out;
}
// id열이 '정확히 1개'일 때만 그 인덱스, 아니면 -1(0개=없음 / 2개+=NC 동시탭 → 채널구분 불가로 공란).
function _singleIdCol(headers) {
  const idx = _idColIndices(headers);
  return idx.length === 1 ? idx[0] : -1;
}

function mapOrderToSheetRow(headers, orderData = {}) {
  const optParts = String(orderData.selectedOptKey || '').split('|').map(v => v.trim());
  const stagedSelection = parseSelectionKey(orderData.selectedOptKey);
  let optColCounter = 0;
  // ★ id열은 탭 전체에서 '정확히 1개'일 때만 채운다(단일 쿠팡id/네이버id/id). NC(네이버+쿠팡)
  //   동시탭은 id열이 2개라 채널구분 불가 → 오기입 방지 위해 둘 다 공란(현행과 동일=무회귀). 판정은 선행규칙 뒤.
  const idCol = _singleIdCol(headers);

  return (headers || []).map((h, colIdx) => {
    const key = String(h || '').toLowerCase().trim();
    // v2 리뷰유형 지시값은 상품 주문 옵션도, 구매양식 제출 대상도 아니다.
    // null은 buildBatchUpdateData에서 쓰기 자체를 생략해 미리 채운 값을 보존한다.
    if (isReviewOptionHeader(key)) return null;
    if (stagedSelection && (key === '상품' || key === 'product')) return stagedSelection.productName;
    if (stagedSelection && /^(1차|1st)\s*옵션$/.test(key)) return stagedSelection.option1Value;
    if (stagedSelection && /^(2차|2nd)\s*옵션$/.test(key)) return stagedSelection.option2Value;
    if (_ID_EXACT_ADMIN.includes(key)) return null;
    /* ★★ 138 선택 상품 — 자리는 `_ID_ADMIN_KW`('상품' 포함) **바로 앞**이어야 한다.
         그 목록이 상품류 헤더를 통째로 보호열로 막으므로, 뒤에 두면 이 규칙에 영영 도달 못 한다.
       ★★ **정확일치 `상품` 하나만** 연다 — `상품명`·`상품URL`·`상품아이디` 는 관리자가 적어 두는
         칸이라 계속 보호열로 남는다(includes 로 넓히면 그 값들을 덮는다).
       ★★ 값이 없으면 `''` 가 아니라 **`null`(=안 씀)** — 빈 문자열은 **그 칸을 지우는 쓰기**가
         된다(7/31 옵션 칸 사고와 같은 메커니즘). 그래서 상품 값이 없는 기존 주문은 이 규칙이
         생기기 전과 **바이트 동일**하게 동작한다(무회귀의 근거).
       ★ 덮어쓰기 방지(blank-only)는 호출부가 한다 — 옵션 칸과 같은 규율. */
    if (key === PRODUCT_HEADER_KEY) return orderData.selectedProduct || null;
    if (_ID_ADMIN_KW.some(kw => key === kw || key.includes(kw))) return null;
    /* ★★ 101 블로그URL(블로그 주소) — **주소·URL 규칙보다 먼저** 본다.
         `블로그주소` 는 아래 `key.includes('주소')` 에 걸려 **배송 주소가 그 칸에 찍히고**,
         `블로그URL` 은 어느 규칙에도 안 걸려 영영 안 채워진다. 순서가 곧 정확성이다.
       ★★ 값이 없으면 `''` 가 아니라 **`null`(=안 씀)** — `buildBatchUpdateData` 는 null 만 걸러내므로
         빈 문자열은 **그 칸을 지우는 쓰기**가 된다(7/31 옵션 칸 사고와 같은 메커니즘).
         관리자가 사전등록해 둔 주소를 리뷰어의 다음 제출이 지우면 안 된다.
       ★ 포스팅URL(쓴 글 주소)은 여기가 아니라 memo 열이 담당한다(M4-1 `utils/memoColumn`) —
         '포스팅' 은 이 규칙에 걸리지 않으므로 두 칸이 섞이지 않는다. */
    if (key.includes('블로그') || key.includes('blog')) return orderData.blogUrl || null;
    if (key.includes('주문자') || key.includes('orderer')) return orderData.orderer || '';
    if (key.includes('수취인') || key.includes('받는분') || key.includes('이름') || key.includes('recipient')) return orderData.recipient || '';
    if (colIdx === idCol) return orderData.userId || '';   // ★ 옛 규칙(includes '아이디' / ==='id') 대체 — '쿠팡id' 인식
    if (key.includes('전화') || key.includes('연락') || key.includes('핸드폰') || key.includes('휴대폰') || key === 'phone') return orderData.phone || '';
    if (key.includes('주소') || key.includes('address')) return orderData.address || '';
    if (key.includes('은행') || key.includes('bank')) return orderData.bank || '';
    if (key.includes('계좌') || key.includes('account')) return orderData.account || '';
    if (key.includes('예금주') || key.includes('depositor')) return orderData.depositor || '';
    if (key.includes('금액') || key.includes('price')) return orderData.price || '';
    if (key.includes('일자') || key.includes('날짜') || key.includes('date')) return orderData.dateStr || '';
    if (key.includes('주문번호') || key.includes('ordernum')) return orderData.orderNum || '';
    if (key.includes('비고') || key.includes('특이사항') || key.includes('memo')) return orderData.memo || '';
    if (key.includes('옵션') || key.includes('option')) {
      const val = optParts[optColCounter] || '';
      optColCounter++;
      return val;
    }
    return null;
  });
}

/** 헤더에서 옵션 칸 인덱스(매퍼와 같은 규칙 — 여기가 단일 출처) */
function optionColIndexes(headers) {
  const out = [];
  (headers || []).forEach((h, i) => {
    const key = String(h || '').toLowerCase().trim();
    if (!isReviewOptionHeader(key) && (key.includes('옵션') || key.includes('option'))) out.push(i);
  });
  return out;
}

/**
 * 배정된 행에 **이미 적혀 있는 옵션값**을 그대로 돌려준다(`|` 결합 = 매퍼의 optParts 역순).
 *
 * ★★ 왜 필요한가: `mapOrderToSheetRow`는 옵션 칸에 `''`를 반환하고 `buildBatchUpdateData`는
 *   `null`만 걸러낸다 → 빈 옵션은 "쓰지 않음"이 아니라 **그 칸을 지우는 쓰기**가 된다.
 *   로스터에 미리 적힌 값(예: '포토리뷰')이 제출과 동시에 사라지는 원인이었다.
 *   ⚠ 공유 매퍼는 고치지 않는다 — `order_cancel`의 칸 비우기와 Track B write-back의
 *   컬럼 disjoint 마스크가 `''` 반환에 의존한다. 그래서 **호출부에서 값을 되쓴다.**
 *
 * ★★ 2026-08 C′ 이후: 이 함수는 **관측/진단용으로만** 남는다. 여기서 읽은 시트값을
 *   `orderData.selectedOptKey` 나 `order_submissions.selected_opt_key` 로 **역주입하지 말 것**.
 *   역주입하면 ① 재배정(reconcile)이 옛 행의 관리자 작업지시값('포토리뷰')을 새 행으로 옮기고
 *   ② CS 표시·Track B identityKey·홀드 옵션검증이 그 값을 "리뷰어 선택"으로 오독한다.
 *   옵션 칸 보호는 쓰기 시점의 `filterOptionWritesBlankOnly`(blank-only)가 담당한다.
 */
function existingOptionKeyAt(tabContext, sheetRow) {
  if (!tabContext || !sheetRow) return '';
  const cols = optionColIndexes(tabContext.headers);
  if (!cols.length) return '';
  const row = (tabContext.dataRows || []).find(r => Number(r.rowIndex) === Number(sheetRow));
  if (!row) return '';
  const cells = row.cells || [];
  const vals = cols.map(i => String(cells[i] == null ? '' : cells[i]).trim());
  return vals.some(v => v) ? vals.join('|') : '';
}

function buildBatchUpdateData({ tabName, headers, targetRow, orderData }) {
  const rowData = mapOrderToSheetRow(headers, orderData);
  return rowData
    .map((val, col) => ({ val, col }))
    .filter(pair => pair.val !== null)
    .map(pair => ({
      range: `'${tabName}'!${getColLetter(pair.col)}${targetRow}`,
      values: [[pair.val]],
    }));
}

// ════════════════════════════════════════════════════════════════════════
// C′ 옵션 칸 blank-only — "시스템은 옵션 칸의 기존 값을 절대 덮지 않는다".
//   왜 호출부 필터인가: 공유 매퍼는 order_cancel(칸 비우기)·Track B `_wbOrderMappedMask`가
//   ''반환에 의존하므로 고칠 수 없다 → **쓰기 목록에서 뺀다**.
//   판정 기준은 RAW 미러가 아니라 **쓰기 직전 라이브 셀**(미러 stale이 곧 사고 타이밍이었다).
// ════════════════════════════════════════════════════════════════════════
const _optionBlankOnlyOn = () => process.env.ORDER_OPTION_BLANK_ONLY !== '0';

/**
 * ★ "매퍼가 실제로 optParts를 기입하는 열"만 반환 — 매퍼에서 **파생**한다.
 *   `optionColIndexes`(헤더 '옵션' 포함)와 다르다: 헤더 '옵션금액'은 매퍼에서 금액 규칙이
 *   먼저 이겨 **결제금액 칸**이다. 그걸 옵션 칸으로 오분류하면 blank-only 필터가
 *   금액 쓰기를 조용히 삭제한다(막으려던 것보다 큰 손실). 센티널 주입으로 정확히 판정.
 */
//   ※ 센티널에 공백·NUL을 쓰지 않는다 — 매퍼가 `split('|').map(v => v.trim())` 로 파트를 다듬고,
//     소스에 박힌 NUL은 git·에디터가 바이너리로 취급한다(둘 다 실측으로 밟은 함정).
const _OPT_SENTINEL_RE = /^__OPT\d+__$/;
function optionWriteColumns(headers) {
  const n = (headers || []).length;
  if (!n) return [];
  const key = Array.from({ length: n }, (_, i) => `__OPT${i}__`).join('|');
  const mapped = mapOrderToSheetRow(headers, { selectedOptKey: key });
  const out = [];
  mapped.forEach((v, i) => { if (typeof v === 'string' && _OPT_SENTINEL_RE.test(v)) out.push(i); });
  return out;
}

/**
 * ★★ "매퍼가 실제로 블로그 주소를 기입하는 열" — 옵션 칸과 **같은 기법**으로 매퍼에서 파생한다(101/M5-2).
 *   헤더 문자열로 따로 찾으면(`includes('블로그')` 사본) **쓰는 칸 ≠ 보여주는(넣는) 칸** 으로 갈린다 —
 *   관리자 사전등록이 매퍼가 안 쓰는 칸에 주소를 넣어 리뷰어 제출 때 다른 칸이 채워지는 사고.
 *   ★ 센티널에 공백·NUL 금지(매퍼가 trim, NUL은 git이 바이너리 취급 — 실측으로 밟은 함정).
 */
/**
 * ★★ "매퍼가 실제로 **선택 상품**을 기입하는 열" — 옵션 칸과 **같은 기법**으로 매퍼에서 파생한다(138).
 *   헤더 문자열로 따로 찾으면(`key === '상품'` 사본) **쓰는 칸 ≠ 보존(blank-only) 판정 칸** 으로 갈려,
 *   관리자가 적어 둔 상품명을 덮는 사고가 그 틈으로 되살아난다.
 * ★ 센티널에 공백·NUL 금지(매퍼가 trim, NUL 은 git 이 바이너리 취급 — 실측으로 밟은 함정).
 */
const _PRODUCT_SENTINEL = '__SELECTEDPRODUCT_SENTINEL__';
function productWriteColumns(headers) {
  const n = (headers || []).length;
  if (!n) return [];
  const mapped = mapOrderToSheetRow(headers, { selectedProduct: _PRODUCT_SENTINEL });
  const out = [];
  mapped.forEach((v, i) => { if (v === _PRODUCT_SENTINEL) out.push(i); });
  return out;
}

const _BLOG_SENTINEL = '__BLOGURL_SENTINEL__';
function blogUrlWriteColumns(headers) {
  const n = (headers || []).length;
  if (!n) return [];
  const mapped = mapOrderToSheetRow(headers, { blogUrl: _BLOG_SENTINEL });
  const out = [];
  mapped.forEach((v, i) => { if (v === _BLOG_SENTINEL) out.push(i); });
  return out;
}

/** "'탭'!C12" → {col:2(0-based), row:12}. 실패 시 {col:-1,row:-1}. */
function _colIdxFromRange(range) {
  const m = /!([A-Z]+)(\d+)$/.exec(String(range || ''));
  if (!m) return { col: -1, row: -1 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) };
}

/**
 * batchData에서 **옵션 칸 쓰기만** blank-only로 걸러낸다(다른 칸은 절대 무영향).
 * @param {(col:number)=>{known:boolean,value:string}} probe 라이브 셀 조회기.
 *        probe 없음/known!==true = 확인 불가 → **쓰지 않는다**(fail-closed).
 * @returns {{data:Array, suppressed:Array<{col,want,cur,reason}>}}
 */
function filterOptionWritesBlankOnly({ batchData, headers, tabName, targetRow, probe }) {
  const out = { data: batchData, suppressed: [] };
  if (!_optionBlankOnlyOn() || !Array.isArray(batchData) || !batchData.length) return out;
  const cols = optionWriteColumns(headers);
  if (!cols.length) return out;
  const row = parseInt(targetRow, 10);
  const colSet = new Set(cols);
  // 판정 = range 문자열 ∪ 열 인덱스(보수적 합집합). 문자열만 보면 탭명 표기차에서 fail-open.
  const byRange = new Map(cols.map(c => [`'${tabName}'!${getColLetter(c)}${row}`, c]));
  out.data = batchData.filter(u => {
    const p = _colIdxFromRange(u.range);
    const col = byRange.has(u.range) ? byRange.get(u.range)
      : ((colSet.has(p.col) && p.row === row) ? p.col : -1);
    if (col < 0) return true;                                   // 옵션 칸 아님 → 그대로 통과
    const want = String((((u.values || [])[0] || [])[0]) == null ? '' : (u.values[0][0])).trim();
    let pr = null;
    try { pr = probe ? probe(col) : null; } catch (_) { pr = null; }
    if (!pr || pr.known !== true) { out.suppressed.push({ col, want, cur: null, reason: 'unverified' }); return false; }
    const cur = String(pr.value == null ? '' : pr.value).trim();
    if (!cur) return true;                                      // 빈 칸 → 기입(하단 신규 append 포함)
    if (cur === want) return false;                             // 같은 값 → 쓰기 생략(멱등)
    out.suppressed.push({ col, want, cur, reason: 'occupied' });
    return false;                                               // ★ 기존 값 보존 — 어떤 경우에도 안 덮는다
  });
  return out;
}

// (시트 미러 쓰기 가드 buildMirrorGuardRange·buildMirrorGuardRanges·normalizeGuardValue·guardBlocksWrite —
//  큐 실행부 order_append 전용 — 는 2026-10-23 제거 · 결정 274.)

function escapeSheetName(name) {
  return String(name || '').replace(/'/g, "''");
}

async function loadRawTabContextFromSheet(sheetId, tabGid, tabName) {
  const pool = getPool();
  const { getSpreadsheetMeta, readSheet } = require('./sheets.service');
  const { throttledCall } = require('../utils/sheetsThrottle');

  const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
  const sheets = Array.isArray(meta) ? meta : [];
  const target = sheets.find(s => {
    const props = s && s.properties;
    if (!props) return false;
    if (tabGid && String(props.sheetId) === String(tabGid)) return true;
    return tabName && props.title === tabName;
  });
  const resolvedTabName = (target && target.properties && target.properties.title) || tabName;
  const resolvedGid = String((target && target.properties && target.properties.sheetId) || tabGid || '');
  if (!resolvedTabName) return null;

  // ★ 미러(rawMirror)와 동일하게 FORMATTED_VALUE로 읽어 라이브폴백/미러 간
  //   raw_sheet_rows 표기 일관성 유지 (날짜 등이 직렬숫자 45463이 아니라 시트 표기 "11/23"로 저장).
  //   행배정은 텍스트 컬럼(연락처/주소/인애드/옵션) 기준이라 서식 변경에 영향 없음.
  const rows = await throttledCall(() =>
    readSheet(sheetId, `'${escapeSheetName(resolvedTabName)}'!A:ZZ`,
      resolvedGid
        ? { gid: resolvedGid, valueRenderOption: 'FORMATTED_VALUE' }
        : { valueRenderOption: 'FORMATTED_VALUE' })
  );
  const values = Array.isArray(rows) ? rows : [];
  const detected = detectSheetHeader(values);
  const headers = detected.headers || (values[0] ? normalizeCells(values[0]) : []);
  const headerRowIndex = detected.headerRowIndex || (headers.length ? 1 : null);
  const dataStartRow = detected.dataStartRow || (headers.length ? 2 : null);
  const colCount = values.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);

  if (resolvedGid) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO raw_sheet_tabs
           (sheet_id, sheet_url, spreadsheet_title, tab_gid, tab_name,
            row_count, col_count, headers, is_system_tab, is_hidden,
            checksum, sheet_modified_at, mirrored_at,
            header_row_index, detected_headers, data_start_row)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false,false,NULL,NULL,NOW(),$9,$10::jsonb,$11)
         ON CONFLICT (sheet_id, tab_gid) DO UPDATE SET
           tab_name = EXCLUDED.tab_name,
           row_count = EXCLUDED.row_count,
           col_count = EXCLUDED.col_count,
           headers = EXCLUDED.headers,
           header_row_index = EXCLUDED.header_row_index,
           detected_headers = EXCLUDED.detected_headers,
           data_start_row = EXCLUDED.data_start_row,
           mirrored_at = NOW()`,
        [
          sheetId,
          `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
          meta._spreadsheetTitle || sheetId,
          resolvedGid,
          resolvedTabName,
          values.length,
          colCount,
          JSON.stringify(values[0] || []),
          headerRowIndex,
          headers.length ? JSON.stringify(headers) : null,
          dataStartRow,
        ]
      );
      await client.query('DELETE FROM raw_sheet_rows WHERE sheet_id = $1 AND tab_gid = $2', [sheetId, resolvedGid]);
      for (let start = 0; start < values.length; start += 500) {
        const batch = values.slice(start, start + 500);
        const placeholders = [];
        const params = [];
        let p = 1;
        batch.forEach((row, idx) => {
          placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(sheetId, resolvedGid, resolvedTabName, start + idx + 1, JSON.stringify(Array.isArray(row) ? row : []));
        });
        if (placeholders.length) {
          await client.query(
            `INSERT INTO raw_sheet_rows (sheet_id, tab_gid, tab_name, row_index, cells)
             VALUES ${placeholders.join(',')}`,
            params
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    sheetId,
    tabGid: resolvedGid,
    tabName: resolvedTabName,
    headers,
    headerRowIndex,
    dataStartRow,
    dataRows: values.slice(Math.max((dataStartRow || 1) - 1, 0)).map((cells, idx) => ({
      rowIndex: (dataStartRow || 1) + idx,
      cells,
    })),
    liveFallback: true,
  };
}

async function loadRawTabContext(sheetId, tabGid, tabName) {
  const pool = getPool();
  const params = [sheetId];
  let where = 'sheet_id = $1';
  if (tabGid) {
    params.push(String(tabGid));
    where += ` AND tab_gid = $${params.length}`;
  } else {
    params.push(tabName);
    where += ` AND tab_name = $${params.length}`;
  }

  const { rows: tabRows } = await pool.query(
    `SELECT sheet_id, tab_gid, tab_name, headers, header_row_index, detected_headers, data_start_row,
            COUNT(*) OVER () AS _dup
       FROM raw_sheet_tabs
      WHERE ${where}
      ORDER BY mirrored_at DESC NULLS LAST
      LIMIT 1`,
    params
  );
  const tab = tabRows[0];
  if (!tab) {
    // ★ 미러 안 된 탭: per-제출 라이브읽기(버스트 시 시트 쿼터 위험) 대신
    //   그 시트를 백그라운드로 1회 자동미러(debounce) → 메타 채운 뒤 리컨실이 복구.
    //   이 주문은 일단 행 없음(null) → pending_no_row → 자동복구가 시트에 기록(손실 0).
    _triggerSheetMirrorOnce(sheetId);
    return null;
  }
  // ★ D5b(#8): gid 없이 tab_name으로 매칭했는데 동명 탭이 여러 개(복제 후 미정리)면 임의 1개 선택 시
  //   다른 탭에 오배정 위험 → 보류(pending_no_row). 미러 재유도로 gid가 채워질 때까지 자가치유.
  if (!tabGid && parseInt(tab._dup, 10) > 1) {
    _triggerSheetMirrorOnce(sheetId);
    return null;
  }

  let headers = Array.isArray(tab.detected_headers) ? tab.detected_headers : null;
  let headerRowIndex = tab.header_row_index || null;
  let dataStartRow = tab.data_start_row || null;

  if (!headers || !headerRowIndex || !dataStartRow) {
    const { rows: firstRows } = await pool.query(
      `SELECT row_index, cells
         FROM raw_sheet_rows
        WHERE sheet_id = $1 AND tab_gid = $2
        ORDER BY row_index
        LIMIT 50`,
      [sheetId, tab.tab_gid]
    );
    const sparse = [];
    for (const r of firstRows) sparse[(parseInt(r.row_index, 10) || 1) - 1] = r.cells || [];
    const detected = detectSheetHeader(sparse);
    if (detected.headers) {
      headers = detected.headers;
      headerRowIndex = detected.headerRowIndex;
      dataStartRow = detected.dataStartRow;
      await pool.query(
        `UPDATE raw_sheet_tabs
            SET detected_headers = $3::jsonb,
                header_row_index = $4,
                data_start_row = $5
          WHERE sheet_id = $1 AND tab_gid = $2`,
        [sheetId, tab.tab_gid, JSON.stringify(headers), headerRowIndex, dataStartRow]
      );
    }
  }

  if (!headers || !headerRowIndex || !dataStartRow) {
    headers = Array.isArray(tab.headers) ? tab.headers : [];
    headerRowIndex = 1;
    dataStartRow = 2;
  }

  const { rows: dataRows } = await pool.query(
    `SELECT row_index AS "rowIndex", cells
       FROM raw_sheet_rows
      WHERE sheet_id = $1 AND tab_gid = $2 AND row_index >= $3
      ORDER BY row_index`,
    [sheetId, tab.tab_gid, dataStartRow]
  );

  return {
    sheetId,
    tabGid: tab.tab_gid,
    tabName: tab.tab_name,
    headers,
    headerRowIndex,
    dataStartRow,
    dataRows,
  };
}

/**
 * 탭의 감지 헤더 목록만 가볍게 조회 — `loadRawTabContext`(raw_sheet_rows 전체를 읽는다)보다
 * 훨씬 싸다. `trackB.service._isTabColumn`(col: 편집 검증, editWorkdeskRow 트랜잭션 안에서 매
 * 편집마다 실행)과 **같은 모양의 질의**다 — 그쪽은 `client`(트랜잭션 커넥션)로 읽고 여기는
 * 커밋 후 별도 요청에서 풀 커넥션으로 읽는다(연결 컨텍스트가 달라 통합하지 않았다).
 * gid 우선(리네임 대비), 못 찾으면 headers=[]·tabGid=''.
 */
async function tabDetectedHeaders(sheetId, tabGid, tabName) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT detected_headers, tab_gid FROM raw_sheet_tabs
      WHERE sheet_id=$1 AND (($2::text IS NOT NULL AND tab_gid=$2) OR tab_name=$3)
      ORDER BY ($2::text IS NOT NULL AND tab_gid=$2) DESC LIMIT 1`,
    [sheetId, tabGid || null, tabName]).catch(() => ({ rows: [] }));
  const r = rows[0];
  const headers = r && Array.isArray(r.detected_headers) ? r.detected_headers : [];
  return { headers, tabGid: (r && r.tab_gid) || tabGid || '' };
}

/* 그리드 셀(col:<헤더>) 편집 → 주문 원장 through-write 대상 역할 → order_submissions 컬럼명.
 *   worktableTemplate.ROLE_META 의 부분집합만 — 은행·계좌·예금주·주문번호·비고는 제외한다.
 *   결제금액은 운영자가 작업보드에서 바로 정정할 수 있도록 원장과 무시트 작업표에도 함께 쓴다.
 *   값(=order_submissions 컬럼명)은 columnMapping.service.STANDARD_FIELDS 의 key 와 **같은 표기**
 *   (예 'user_id')다 — 오버라이드 대조(아래)에서 이 값을 그대로 조회 키로 쓴다.
 *   ★ 'orderer'→reviewer_name 은 매핑하지 않는다 — reviewer_name(참여자 신원열)은 로그인 계정을
 *     우선하는 별개 의미라(`writeOrderToWorktable` 참조), 시트의 "주문자" 칸 정정으로 덮으면 안 된다.
 */
const _OS_COL_BY_ROLE = { orderer: 'orderer', recipient: 'recipient', userId: 'user_id', phone: 'phone', address: 'address', price: 'price' };

// 원장 금액은 TEXT지만, 작업보드에서의 정정은 원화 정수만 받는다. 표시용 쉼표/"원"은 허용하되
// 음수·소수·수식 같은 값은 막아 정산 집계(regexp_replace 기반)에 다른 값이 섞이지 않게 한다.
function normalizeWorkdeskPrice(value) {
  const raw = String(value == null ? '' : value).trim();
  const compact = raw.replace(/원\s*$/, '').replace(/[\s,]/g, '');
  if (!/^\d+$/.test(compact)) return null;
  const n = Number(compact);
  if (!Number.isSafeInteger(n)) return null;
  return String(n);
}

// 라우트가 오버레이를 저장하기 전에 금액열인지 알아내는 공용 판정. 헤더 별칭(상품가격/금액/price)
// 도 worktableTemplate의 같은 분류기를 쓰므로, 표시값만 바뀌고 원장이 거절되는 분리 상태를 막는다.
async function normalizeWorkdeskColumnValue({ sheetId, tabName, header, value } = {}) {
  if (!sheetId || !tabName || !header) return { isPrice: false, ok: true, value };
  const { headers } = await tabDetectedHeaders(sheetId, null, tabName);
  const idx = headers.findIndex(h => String(h == null ? '' : h).trim() === header);
  if (idx < 0) return { isPrice: false, ok: true, value };
  const { classifyHeaders } = require('../utils/worktableTemplate');
  const role = (classifyHeaders(headers)[idx] || {}).role;
  if (role !== 'price') return { isPrice: false, ok: true, value, role: role || null };
  const normalized = normalizeWorkdeskPrice(value);
  return { isPrice: true, ok: normalized != null, value: normalized, role };
}

/**
 * 작업보드 그리드 셀 편집(col:<헤더>)을 주문 원장(order_submissions) + 무시트 작업표(row_json)에
 * through-write 한다 — 관리자가 표에서 연락처 등을 고쳐도 review_index(리뷰어 "리뷰 내역" 검색)에는
 * 전혀 반영되지 않던 문제의 수정.
 *
 * ★★ `editWorkdeskRow`(participant_edits 오버레이 저장)가 **끝나고 커밋된 뒤, 별도 호출**에서만
 *   쓴다 — 그 함수의 FOR UPDATE 트랜잭션 안에서 부르면, 무시트 경로가 같은 물리행을 다시 잠그려다
 *   자기 자신을 기다려 사실상 항상 교착한다(레드팀 실증: 커넥션 풀 고갈로 전체 서비스 장애).
 *
 * ★★ `writeOrderToWorktable`(order_submissions 전체 필드를 그 행의 모든 매칭 컬럼에 재기입)을
 *   재사용하지 않는다 — 그 함수는 "리뷰어가 방금 낸 폼 전체를 반영"하는 용도라 적절하지만, 이번
 *   용도(관리자가 셀 하나만 고침)에 그대로 쓰면 관리자가 손대지 않은 다른 열(운영 메모 등)까지
 *   조용히 값이 바뀔 수 있다. 여기서는 **편집된 그 헤더 하나만** row_json 에 갈아끼운다.
 *
 * ★ 그 역할에 DB 컬럼매핑 오버라이드(`tab_column_mappings`)가 걸려 있는데 지금 편집한 열과
 *   다르면 동기화하지 않는다 — `columnResolver`(review_index 파생)는 오버라이드를 키워드보다
 *   우선하므로, 무시하고 진행하면 "review_index 는 안 고쳐지는데 엉뚱한 값이 order_submissions
 *   에는 들어가는" 상태가 된다.
 *
 * @param {object} o
 * @param {string} o.sheetId · o.tabName        편집이 일어난 탭(그리드가 보여준 문맥)
 * @param {string} o.header                     편집된 시트 헤더(field.slice(4))
 * @param {*} o.value                            새 값
 * @param {*} [o.oldValue]                       편집 **전** row_json 값(종전 시트 기반 탭 큐의 옛값 대조용 —
 *                                                결정 274 로 시트 큐가 없어져 지금은 읽지 않는다 · 호출 호환용)
 * @param {string} o.orderSubmissionId           editWorkdeskRow 가 확정한 order 앵커
 * @param {string} [o.by]
 * @returns {Promise<{attempted:boolean, ok:boolean, reason?:string, role?:string|null, mode?:'sheetless'|'db_only'}>}
 */
async function syncCellToOrderIdentity({ sheetId, tabName, header, value, oldValue, orderSubmissionId, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !header || !orderSubmissionId) return { attempted: false, ok: false, reason: 'bad_request' };
  if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return { attempted: false, ok: false, reason: 'ledger_write_disabled' };
  if (process.env.WORKDESK_CELL_ORDER_SYNC === '0') return { attempted: false, ok: false, reason: 'disabled' };

  const { headers, tabGid } = await tabDetectedHeaders(sheetId, null, tabName);
  if (!headers.length) return { attempted: true, ok: false, reason: 'no_headers' };
  const idx = headers.findIndex(h => String(h == null ? '' : h).trim() === header);
  if (idx < 0) return { attempted: true, ok: false, reason: 'header_not_found' };

  const { classifyHeaders } = require('../utils/worktableTemplate');   // lazy(순환참조 회피)
  const classified = classifyHeaders(headers);
  const role = classified[idx] && classified[idx].role;
  const osCol = _OS_COL_BY_ROLE[role];
  if (!osCol) return { attempted: true, ok: false, reason: 'role_not_syncable', role: role || null };

  if (tabGid) {
    const dbColMap = await require('./columnMapping.service').getTabColumnIndexMap(sheetId, tabGid).catch(() => null);
    const ov = dbColMap && dbColMap.get(osCol);
    if (ov && ov.colIndex !== idx) return { attempted: true, ok: false, reason: 'column_mapping_mismatch', role };
  }

  const { withJobLock } = require('../utils/jobLock');
  const { isSheetless } = require('../utils/sheetlessScope');
  const db = getPool();
  const editSeq = Date.now();
  const newValue = role === 'price'
    ? normalizeWorkdeskPrice(value)
    : (value == null ? '' : String(value).slice(0, 2000));
  if (newValue == null) return { attempted: true, ok: false, reason: 'invalid_price', role };

  const out = await withJobLock('order_ledger:' + orderSubmissionId, async () => {
    const { rows } = await db.query(
      `UPDATE order_submissions SET ${osCol} = $2, updated_at = NOW(),
              last_edit_seq = GREATEST(COALESCE(last_edit_seq, 0), $3)
        WHERE id = $1 AND sheet_id = $4 AND tab_name = $5 AND deleted_at IS NULL
      RETURNING id, sheet_id, tab_name`,
      [orderSubmissionId, newValue, editSeq, sheetId, tabName]);
    if (!rows.length) return { ok: false, reason: 'order_cancelled_or_missing' };
    const os = rows[0];
    // ★ 편집 시점에 알던 탭과 지금 주문이 속한 탭이 다르면(그 사이 재연결됨) 중단 — 잘못된 탭의
    //   장부를 재생성하는 것보다 안 하는 게 낫다.
    if (String(os.sheet_id) !== String(sheetId) || String(os.tab_name) !== String(tabName)) {
      return { ok: false, reason: 'tab_mismatch' };
    }

    let isSl = false;
    try { isSl = await isSheetless(db, os.sheet_id, os.tab_name); } catch (_) { isSl = false; }

    if (isSl) {
      const p8 = role === 'phone' ? (toPhone8(newValue) || null) : null;
      const { rowCount } = await db.query(
        `UPDATE campaign_participants
            SET row_json = jsonb_set(COALESCE(row_json, '{}'::jsonb), ARRAY[$1::text], to_jsonb($2::text), true),
                recipient_name = CASE WHEN $3 = 'recipient' THEN COALESCE(NULLIF($2, ''), recipient_name) ELSE recipient_name END,
                phone8         = CASE WHEN $3 = 'phone' AND $4::text IS NOT NULL THEN $4 ELSE phone8 END,
                price          = CASE WHEN $3 = 'price' THEN $2 ELSE price END,
                updated_by = 'workdesk-cell-sync', updated_at = NOW()
          WHERE sheet_id = $5 AND tab_name = $6 AND order_submission_id = $7::uuid AND deleted_at IS NULL`,
        [header, newValue, role, p8, os.sheet_id, os.tab_name, orderSubmissionId]);
      if (rowCount !== 1) return { ok: false, reason: rowCount === 0 ? 'row_reassigned' : 'ambiguous_row' };
      try {
        await require('./sheetlessLedger.service').rebuildLedgers({ sheetId: os.sheet_id, tabName: os.tab_name, by: 'workdesk-cell-sync' });
      } catch (e) {
        return { ok: false, reason: 'ledger_rebuild_failed', message: e.message };
      }
      return { ok: true, mode: 'sheetless' };
    }

    /* ★★ 결정 274 — 시트 기반 탭도 **원장(DB)만** 고친다(위 UPDATE 로 끝). 종전엔 여기서 order_update 를 넣어
       큐가 시트 셀을 고쳤지만, 시트 쓰기 실행부를 지웠고 남은 시트 탭은 작업보드가 원본이다(사용자 결정 2026-10-23).
       작업보드 화면 값은 editWorkdeskRow 가 이미 저장했다. */
    return { ok: true, mode: 'db_only' };
  }, { onBusy: () => ({ ok: false, reason: 'concurrent_edit' }) });

  return { attempted: true, ok: !!(out && out.ok), reason: out && out.reason, role, mode: out && out.mode };
}

async function claimRow({ client, sheetId, tabGid, tabName, dedupKey, candidateRows, orderId, meta = {} }) {
  const db = client || getPool();
  const candidates = (candidateRows || []).filter(r => Number.isInteger(parseInt(r, 10)) && parseInt(r, 10) > 0);
  const firstCandidate = candidates[0] || null;
  if (!sheetId || !tabName || !dedupKey) return { row: null, error: 'missing args' };

  let existing;
  try {
    existing = await db.query(
      `SELECT sheet_row FROM sheet_row_claims
       WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3`,
      [sheetId, tabName, dedupKey]
    );
  } catch (e) {
    // ★ D5d(#10): claims 테이블 부재(부팅/복구 윈도우)면 무검증 firstCandidate 배정 금지.
    //   배정 보류(pending_no_row) → 다음 reconcile이 정상 claim. 멱등·중복방지 무력화 차단.
    if (e.code === '42P01') return { row: null, error: 'claims table missing (boot window)' };
    throw e;
  }
  if (existing.rows.length) {
    const row = existing.rows[0].sheet_row;
    if (orderId) {
      await db.query(
        `UPDATE sheet_row_claims
            SET order_id = COALESCE(order_id, $4), updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3`,
        [sheetId, tabName, dedupKey, orderId]
      );
    }
    return { row, isNew: false };
  }

  for (const rawRow of candidates) {
    const row = parseInt(rawRow, 10);
    const result = await db.query(
      `INSERT INTO sheet_row_claims
         (sheet_id, tab_gid, tab_name, sheet_row, dedup_key, order_id, name, phone8, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT DO NOTHING
       RETURNING sheet_row`,
      [
        sheetId,
        tabGid || null,
        tabName,
        row,
        dedupKey,
        orderId || null,
        meta.name || '',
        toPhone8(meta.phone8) || toPhone8(meta.phone),
        meta.source || 'order_submit',
      ]
    );
    if (result.rows.length) return { row, isNew: true };

    const again = await db.query(
      `SELECT sheet_row FROM sheet_row_claims
       WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3`,
      [sheetId, tabName, dedupKey]
    );
    if (again.rows.length) return { row: again.rows[0].sheet_row, isNew: false };
  }

  return { row: null, exhausted: true };
}

async function createOrderLedgerEntry(input) {
  const db = getPool();
  const {
    sheetId, tabName, gid, orderData,
    slotRowNumber, loginPhone8, loginName,
    skipSheetMirror = false,
    deferSheetlessApply = false, // workboard_apply 큐가 실제 작업보드 반영 후 written으로 전이한다.
    campaignHold, // 참여형 홀드 확정 문맥 {applicationId, campaignId, phone8, holdToken} | undefined
    sameDayDuplicateGuard, // 구매양식의 오늘 동일 제출 차단(선택 입력)
    source = 'order_submit', // 호출 시 확정한 접수 출처도 최초 INSERT와 함께 보존한다.
  } = input;
  // ★ D4(#5): osid 폴백 dedupKey를 쓰려면 먼저 id가 필요 → INSERT(dedup_key NULL) 후 osid 포함 키 계산·UPDATE.
  const ORDER_INSERT_SQL = `INSERT INTO order_submissions
      (sheet_id, tab_name, gid, tab_gid, orderer, recipient, user_id, phone, address,
       order_num, date_str, selected_opt_key, bank, account, depositor, price, memo, blog_url,
       selected_product, source, dedup_key, mirror_status, delivery_memo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NULL,'pending',$21)
     RETURNING id`;
  const orderInsertParams = [
    sheetId,
    tabName,
    gid || '',
    gid || '',
    orderData.orderer || '',
    orderData.recipient || '',
    orderData.userId || '',
    orderData.phone || '',
    orderData.address || '',
    orderData.orderNum || '',
    orderData.dateStr || '',
    orderData.selectedOptKey || '',
    orderData.bank || '',
    orderData.account || '',
    orderData.depositor || '',
    orderData.price || '',
    orderData.memo || '',
    orderData.blogUrl || null,   // ★ 101 — 없으면 NULL(빈 문자열로 굳히지 않는다: 나중 전파/사전등록이 COALESCE 로 채운다)
    /* ★ 138 선택 상품 — 컬럼이 NOT NULL DEFAULT '' 라 빈 문자열이 곧 "안 고름"이다.
       원장에 남겨야 무시트 재기록·큐 재시도·reconcile 이 같은 값을 다시 쓴다(_osRowToOrderData). */
    orderData.selectedProduct || '',
    source || 'order_submit',
    // 결정 245 — 캡처에서 읽은 배송메세지(작업표 칸으로는 보내지 않는다 · 작업보드 미리보기 전용).
    orderData.deliveryMemo || '',
  ];

  let orderSubmissionId;
  let dedupKey;
  let holdResult = null;
  let duplicateOrderSubmissionId = null;
  const guardDuplicate = async (client) => {
    if (!sameDayDuplicateGuard) return null;
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [sameDayDuplicateLockKey(sameDayDuplicateGuard)]);
    const sameDay = await findSameDayDuplicateInTx(client, sameDayDuplicateGuard);
    if (sameDay) return sameDay;
    // ★ 무시트(탈시트) 경로만 날짜를 넘는 같은 구매까지 본다 — 그쪽은 claim(dedup_key 유니크)을
    //   건너뛰어 수렴점이 없다. 시트 경로 동작은 한 줄도 바뀌지 않는다(crossDay 미전달).
    if (!sameDayDuplicateGuard.crossDay) return null;
    return findEquivalentOrderInTx(client, sameDayDuplicateGuard);
  };

  if (campaignHold && campaignHold.applicationId) {
    // ★ 참여형(레드-블루-심판 최종안): 주문 INSERT + dedup + 홀드확정 + provenance 링크 = 단일 트랜잭션(부분상태 불가).
    //   홀드확정 내부 오류는 SAVEPOINT로 격리(심판 J2) — 어떤 경우에도 주문 INSERT는 살아남는다(주문 손실 0).
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const duplicate = await guardDuplicate(client);
      if (duplicate) {
        duplicateOrderSubmissionId = duplicate.id;
        await client.query('ROLLBACK');
      } else {
      const ins = await client.query(ORDER_INSERT_SQL, orderInsertParams);
      orderSubmissionId = ins.rows[0].id;
      dedupKey = computeDedupKey({ ...orderData, orderSubmissionId });
      await client.query(`UPDATE order_submissions SET dedup_key = $2 WHERE id = $1`, [orderSubmissionId, dedupKey]);
      // 명의 게이트가 검증한 소유자 UUID+참여 명의 해시를 같은 트랜잭션으로 고정한다.
      // 구버전 호출은 신청행의 코드 UUID가 모두 있을 때만 종전처럼 복사한다.
      if (campaignHold.identityBinding?.ownerReviewerId && campaignHold.identityBinding?.participantIdentityKeyHash) {
        await client.query(
          `UPDATE order_submissions
              SET owner_reviewer_id = $3::uuid,
                  participant_identity_id = $4::uuid,
                  participant_identity_key_hash = $5
            WHERE id = $1
              AND EXISTS (SELECT 1 FROM campaign_applications ca WHERE ca.id = $2)`,
          [orderSubmissionId, campaignHold.applicationId,
           campaignHold.identityBinding.ownerReviewerId,
           campaignHold.identityBinding.participantIdentityId || null,
           campaignHold.identityBinding.participantIdentityKeyHash]
        );
      } else {
        await client.query(
          `UPDATE order_submissions os
              SET owner_reviewer_id = ca.owner_reviewer_id,
                  participant_identity_id = ca.participant_identity_id
             FROM campaign_applications ca
            WHERE os.id = $1 AND ca.id = $2
              AND ca.owner_reviewer_id IS NOT NULL
              AND (os.owner_reviewer_id IS NULL OR os.owner_reviewer_id=ca.owner_reviewer_id)`,
          [orderSubmissionId, campaignHold.applicationId]
        );
      }
      // ★★ 결정 221 — 주문에 참여 명의 카드 번호를 새긴다.
      //   ★ 명의 게이트가 검증한 결과가 있으면 **그 카드만** 쓴다(없으면 비운다) — 게이트가 다른 명의를 골랐는데
      //     신청행 카드가 붙으면 주문의 명의 해시와 카드가 서로 다른 사람을 가리킨다(레드팀 5).
      //   ★ 게이트 결과가 없을 때만 신청행 카드를 옮기되, 신청행·주문 소유자가 **둘 다 있고 같을 때만**.
      //   ★ 기록만 한다 — SAVEPOINT 격리: 어떤 실패도 주문 INSERT 를 되돌리지 않는다(주문 손실 0 규율). 잠금 대기 1초 상한.
      //   ★ lock_timeout 은 SAVEPOINT 가 아니라 트랜잭션 범위다 — RELEASE 뒤 반드시 원래 값으로 되돌린다.
      //     안 되돌리면 바로 다음 홀드 확정(FOR UPDATE)까지 1초 상한이 걸려 "주문은 들어갔는데 자리 미확정"이 된다(Codex P1).
      //   ★ 게이트 결과에 카드 칸이 **아예 없으면**(구버전 게이트) 게이트 결과가 없는 것과 같게 본다(Codex P1).
      const _bindingHasCard = !!campaignHold.identityBinding
        && Object.prototype.hasOwnProperty.call(campaignHold.identityBinding, 'participantCardId');
      let _prevLockTimeout = null;
      try {
        await client.query('SAVEPOINT card_copy');
        // 읽기도 SAVEPOINT 안에서 — 밖에서 실패하면 되돌릴 지점이 없어 트랜잭션(=주문)이 통째로 죽는다.
        _prevLockTimeout = (await client.query("SELECT current_setting('lock_timeout') AS v")).rows[0].v;
        await client.query("SET LOCAL lock_timeout = '1s'");
        if (_bindingHasCard) {
          if (campaignHold.identityBinding.participantCardId) {
            await client.query(
              `UPDATE order_submissions SET participant_card_id = $2::uuid
                WHERE id = $1 AND participant_card_id IS NULL`,
              [orderSubmissionId, campaignHold.identityBinding.participantCardId]);
          }
        } else {
          await client.query(
            `UPDATE order_submissions os
                SET participant_card_id = ca.participant_card_id
               FROM campaign_applications ca
              WHERE os.id = $1 AND ca.id = $2
                AND os.participant_card_id IS NULL AND ca.participant_card_id IS NOT NULL
                AND os.owner_reviewer_id IS NOT NULL AND os.owner_reviewer_id = ca.owner_reviewer_id`,
            [orderSubmissionId, campaignHold.applicationId]);
        }
        // 되돌리기는 RELEASE 전에(SAVEPOINT 안) — 혹시 실패해도 아래 ROLLBACK TO 로 격리된다.
        await client.query("SELECT set_config('lock_timeout', $1, true)", [_prevLockTimeout]);
        await client.query('RELEASE SAVEPOINT card_copy');
      } catch (cardErr) {
        try { await client.query('ROLLBACK TO SAVEPOINT card_copy'); } catch (_) { /* noop */ }
        logger.warn(`[orderLedger] 명의 카드 기록 실패(주문은 보존): ${cardErr.code || ''} ${cardErr.message} os=${orderSubmissionId}`);
      }
      await client.query('SAVEPOINT hold_confirm');
      try {
        const { confirmHoldInTx } = require('./campaignHold.service'); // 지연 require(순환 방지 — 기존 패턴)
        holdResult = await confirmHoldInTx(client, { ...campaignHold, orderSubmissionId, sheetId, gid, tabName });
      } catch (holdErr) {
        await client.query('ROLLBACK TO SAVEPOINT hold_confirm');
        holdResult = 'error';
        logger.warn(`[orderLedger] 홀드확정 오류(주문은 보존): ${holdErr.message} camp=${campaignHold.campaignId} os=${orderSubmissionId}`);
      }
      await client.query('COMMIT');
      }
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
    if (holdResult === 'tab_mismatch') {
      logger.warn(`[orderLedger] 캠페인 탭 불일치 — 홀드확정 보류(주문은 저장, 관제 수동확정 대상): camp=${campaignHold.campaignId} os=${orderSubmissionId} sheet=${sheetId} gid=${gid || ''} tab=${tabName}`);
    } else if (holdResult === 'not_found' || holdResult === 'invalid_params') {
      // 무신호 방지(코드리뷰 #7): 위조/오염 문맥 — 주문은 저장됐고 홀드 링크만 거부됨
      logger.warn(`[orderLedger] 홀드확정 문맥 무효(${holdResult}) — 주문은 저장: camp=${campaignHold.campaignId} app=${campaignHold.applicationId} os=${orderSubmissionId}`);
    }
  } else {
    // 비참여 주문: 기존 경로 그대로(핫패스 무변경 — 트랜잭션·커넥션 점유 없음)
    if (sameDayDuplicateGuard) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const duplicate = await guardDuplicate(client);
        if (duplicate) {
          duplicateOrderSubmissionId = duplicate.id;
          await client.query('ROLLBACK');
        } else {
          const insert = await client.query(ORDER_INSERT_SQL, orderInsertParams);
          orderSubmissionId = insert.rows[0].id;
          dedupKey = computeDedupKey({ ...orderData, orderSubmissionId });
          await client.query(`UPDATE order_submissions SET dedup_key = $2 WHERE id = $1`, [orderSubmissionId, dedupKey]);
          await client.query('COMMIT');
        }
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw err;
      } finally {
        client.release();
      }
    } else {
      const insert = await db.query(ORDER_INSERT_SQL, orderInsertParams);
      orderSubmissionId = insert.rows[0].id;
      dedupKey = computeDedupKey({ ...orderData, orderSubmissionId });
      await db.query(`UPDATE order_submissions SET dedup_key = $2 WHERE id = $1`, [orderSubmissionId, dedupKey]);
    }
  }

  if (duplicateOrderSubmissionId) return { duplicateOrderSubmissionId };

  // 탈시트 구매양식: 주문원장과 홀드 확정까지만 같은 트랜잭션으로 남긴다.
  // 이후 RAW 행 배정·시트 동기화 큐는 실행하지 않는다.
  if (skipSheetMirror) {
    await db.query(
      `UPDATE order_submissions
          SET mirror_status = CASE WHEN $2 THEN 'pending' ELSE 'written' END,
              sheet_error = CASE WHEN $2 THEN 'workboard_apply_pending' ELSE NULL END
        WHERE id = $1`,
      [orderSubmissionId, !!deferSheetlessApply]
    );
    return {
      orderSubmissionId,
      dedupKey,
      sheetRow: null,
      claim: { row: null, error: deferSheetlessApply ? 'workboard_apply_pending' : 'db_only' },
      tabContext: null,
      tabGid: gid || '',
      headers: [],
      holdResult,
    };
  }

  let tabContext = null;
  let claim = { row: null, error: 'not_attempted' };
  let candidateRows = [];
  let claimError = null;

  try {
    tabContext = await loadRawTabContext(sheetId, gid, tabName);
    // ★ R-2a: 제출 claim 후보 base에 claims MAX 합류(reconcile과 동일기준) → 버스트 동일행 경쟁 차단.
    let claimsMax = 0;
    try {
      const mc = await db.query(
        `SELECT COALESCE(MAX(sheet_row),0) AS m FROM sheet_row_claims WHERE sheet_id=$1 AND tab_name=$2`,
        [sheetId, tabName]
      );
      claimsMax = parseInt(mc.rows[0].m, 10) || 0;
    } catch (_) { /* claims 조회 실패는 미러 base로 폴백 */ }
    candidateRows = slotRowNumber
      ? [parseInt(slotRowNumber, 10)]
      : (tabContext ? buildCandidateRows({
          headers: tabContext.headers,
          dataRows: tabContext.dataRows,
          headerRowIndex: tabContext.headerRowIndex,
          orderData,
          appendBaseRow: claimsMax,
        }) : []);

    if (!candidateRows.length) {
      claim = { row: null, error: 'no candidates' };
    } else {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        claim = await claimRow({
          client,
          sheetId,
          tabGid: (tabContext && tabContext.tabGid) || gid || '',
          tabName,
          dedupKey,
          candidateRows,
          orderId: orderSubmissionId,
          meta: {
            name: loginName || orderData.orderer || orderData.recipient || '',
            phone8: loginPhone8,
            phone: orderData.phone,
            source: 'order_submit',
          },
        });
        await client.query(
          `UPDATE order_submissions
              SET sheet_row = $2::int,
                  tab_gid = COALESCE(NULLIF($3, ''), tab_gid),
                  mirror_status = CASE WHEN $2::int IS NULL THEN 'pending_no_row' ELSE 'pending' END,
                  sheet_error = CASE WHEN $2::int IS NULL THEN $4 ELSE NULL END
            WHERE id = $1`,
          [
            orderSubmissionId,
            claim.row || null,
            (tabContext && tabContext.tabGid) || gid || '',
            claim.error || (claim.exhausted ? 'row claim exhausted' : 'row claim failed'),
          ]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        claimError = err;
        claim = { row: null, error: 'claim_failed', message: err.message };
      } finally {
        client.release();
      }
    }
  } catch (err) {
    claimError = err;
    claim = { row: null, error: 'row_assignment_failed', message: err.message };
  }

  // ★★ C′: 옵션 칸 보호는 **시트 쓰기 직전**(syncQueue의 filterOptionWritesBlankOnly)이
  //   라이브 셀 기준 blank-only로 수행한다. 시트값을 orderData/selected_opt_key로 되쓰던
  //   옛 방식은 폐기 — 재배정 시 옛 행의 관리자 작업지시값이 새 행으로 전이하고,
  //   원장이 리뷰어 선택을 잃어 CS·TrackB·홀드검증이 전부 오독한다.
  //   원장은 "리뷰어가 고른 값(없으면 빈 값)"이 진실이다.

  if (!claim.row) {
    try {
      await db.query(
        `UPDATE order_submissions
            SET mirror_status = 'pending_no_row',
                tab_gid = COALESCE(NULLIF($3, ''), tab_gid),
                sheet_error = $2
          WHERE id = $1`,
        [
          orderSubmissionId,
          String((claimError && claimError.message) || claim.message || claim.error || 'row assignment failed').slice(0, 500),
          (tabContext && tabContext.tabGid) || gid || '',
        ]
      );
    } catch (err) {
      claim.statusUpdateError = err.message;
    }
  }

  return {
    orderSubmissionId,
    dedupKey,
    sheetRow: claim.row || null,
    claim,
    tabContext,
    tabGid: (tabContext && tabContext.tabGid) || gid || '',
    headers: tabContext ? tabContext.headers : [],
    holdResult, // 참여형 홀드 확정 결과('confirmed'|'late'|'tab_mismatch'|'error'|null)
  };
}

async function markOrderQueued(orderSubmissionId) {
  if (!orderSubmissionId) return;
  // ★ R1: 단조전이 가드. 펌프(queuePump)가 enqueue 직후 이 주문을 이미 'written' 처리했다면
  //   여기서 'queued'로 역행시키지 않는다(written이면 UPDATE 0행=무해). markOrderWritten은
  //   무가드 유지 — reconcile의 'failed'→'written' 정상전이를 막지 않기 위함.
  await getPool().query(
    `UPDATE order_submissions SET queued_at = NOW(), mirror_status = 'queued'
       WHERE id = $1 AND mirror_status <> 'written'`,
    [orderSubmissionId]
  );
}

async function markOrderWritten(orderSubmissionId, sheetRow, sig = null) {
  if (!orderSubmissionId) return;
  await getPool().query(
    `UPDATE order_submissions
        SET mirror_status = 'written',
            sheet_row = COALESCE($2::int, sheet_row),
            sheet_written_at = NOW(),
            sheet_error = NULL,
            last_sheet_write_sig = COALESCE($3, last_sheet_write_sig)
      WHERE id = $1`,
    [orderSubmissionId, sheetRow || null, sig]
  );
}

/**
 * 중복 주문 취소(소프트) — 작업보드 중복 줄 정리의 짝. 2026-08-19.
 *
 * ★ 이 함수는 **호출자가 이미 "중복이고 입금 회차에 걸리지 않는다"를 확인한 id 만** 받는다.
 *   여기서 다시 판정하지 않는다(판정 단일 출처 = sheetlessLedger.dedupeRows).
 * ★ 하드삭제 금지 — `deleted_at` + `mirror_status='canceled'`(migration 120 과 같은 표기)라
 *   감사·복구 경로가 남는다. 이미 취소된 건은 건드리지 않는다(멱등).
 */
async function softDeleteDuplicateOrders(ids = [], by = 'dedupe') {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 5000);
  if (!list.length) return 0;
  const { rowCount } = await getPool().query(
    `UPDATE order_submissions
        SET deleted_at = NOW(), canceled_by = $2, mirror_status = 'canceled', updated_at = NOW()
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [list, String(by).slice(0, 100)]);
  return rowCount;
}

async function markOrderMirrorFailed(orderSubmissionId, err) {
  if (!orderSubmissionId) return;
  await getPool().query(
    `UPDATE order_submissions
        SET mirror_status = 'failed',
            sheet_error = $2
      WHERE id = $1`,
    [orderSubmissionId, String((err && err.message) || err || '').slice(0, 500)]
  );
}

async function recordReviewIdentity({ sheetId, tabName, tabGid, rowIndex, phone8, phone, name, recipient }) {
  try {
    const p8 = toPhone8(phone8) || toPhone8(phone);
    const ri = parseInt(rowIndex, 10);
    if (!sheetId || !tabName || !Number.isInteger(ri) || ri < 1 || !p8) return;
    const displayName = String(name || recipient || '').trim();
    await getPool().query(
      `UPDATE review_index
          SET phone8 = COALESCE(NULLIF($4, ''), phone8),
              recipient_name = COALESCE(NULLIF($5, ''), recipient_name),
              tab_gid = COALESCE(NULLIF($6, ''), tab_gid)
        WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
      [sheetId, tabName, ri, p8, displayName, tabGid || '']
    );
  } catch (_) {
    // Best-effort identity backfill. Submission durability is handled by order_submissions.
  }
}

/**
 * 막힌 주문 복구/리컨실 — order_submissions에서 시트에 못 들어간 주문을 찾아
 * 행을 재배정하고 order_append 큐에 다시 올린다. (복구분은 하단 append + 노란 배경)
 *
 * - 대상: mirror_status IN ('pending','pending_no_row','failed') + 정체된 'queued'
 * - RAW 미러 메타가 없는 탭은 skip(자가치유 대기) — 여기서 라이브폴백 금지(쿼터 버스트 방지)
 * - createOrderLedgerEntry는 호출 안 함(매번 INSERT됨). 기존 order 행에 대해
 *   행배정 하위단계(loadRawTabContext→buildCandidateRows(appendOnly)→claimRow)만 재실행
 * - claimRow의 dedup 유니크로 재시도해도 같은 행 반환 → 시트 중복행 없음
 */
async function reconcileStuckOrders({ limit = 50, perTabCap = 20, sheetId = null, tabName = null, staleQueuedMinutes = 10, dryRun = false } = {}) {
  const db = getPool();
  const { enqueue } = require('./syncQueue.service'); // lazy: require 순환 회피
  const _queuedTargetByTab = new Map(); // 큐 대상 판정도 탭별 1회만 조회한다.

  const params = [staleQueuedMinutes];
  let sheetFilter = '';
  if (sheetId) { params.push(sheetId); sheetFilter += ` AND os.sheet_id = $${params.length}`; }
  if (tabName) { params.push(tabName); sheetFilter += ` AND os.tab_name = $${params.length}`; } // 탭 단위 우선 복구
  params.push(limit);
  const limitIdx = params.length;

  /* ★★ 참여형 무시트 주문의 원장 좌표는 `campaign:<공고ID>` 다 — 구글시트 탭이 아니라
     **큐로는 영원히 복구되지 않는다**(RAW 메타가 없어 매 사이클 `skippedNoMeta` 로 스킵될 뿐).
     그 건들이 `submitted_at ASC` 정렬의 앞자리를 차지하면 진짜 복구 대상이 LIMIT 밖으로 밀린다.
     → 스캔에서 제외한다. 이 좌표의 반영은 제출 경로(작업보드 기록)와 무시트 복구 잡이 담당한다. */
  const { rows } = await db.query(
    `SELECT os.id, os.sheet_id, os.tab_name, os.gid, os.tab_gid, os.dedup_key,
            os.orderer, os.recipient, os.user_id, os.phone, os.address,
            os.order_num, os.date_str, os.selected_opt_key, os.selected_product, os.bank, os.account,
            os.depositor, os.price, os.memo, os.mirror_status, os.sheet_row, os.sheet_error
       FROM order_submissions os
      WHERE os.deleted_at IS NULL
        AND os.sheet_id NOT LIKE 'campaign:%'
        AND (os.mirror_status IN ('pending','pending_no_row','failed')
             OR (os.mirror_status = 'queued'
                 AND os.queued_at IS NOT NULL
                 AND os.queued_at < NOW() - ($1 || ' minutes')::interval
                 AND NOT EXISTS (
                   SELECT 1 FROM sync_queue sq
                    WHERE sq.type = 'order_append'
                      AND sq.status IN ('pending','processing')
                      AND (sq.payload->>'orderSubmissionId') = os.id::text)))
        ${sheetFilter}
      ORDER BY (os.mirror_status <> 'pending_no_row'), os.submitted_at ASC
      LIMIT $${limitIdx}`,
    params
  );

  const result = { scanned: rows.length, requeued: 0, skippedNoMeta: 0, noCandidates: 0, stillStuck: 0, sheetlessWritten: 0, sheetTabSkipped: 0, byTab: [], dryRun };
  const tabCount = new Map();

  /* ★★ 무시트 탭(탈 구글시트 W2)은 **order_append 큐로 복구하지 않는다** — 큐는 구글시트에 쓴다.
     대신 같은 자리에서 작업표 기록을 다시 시도한다(그게 무시트의 "반영"이다).
     ★ 목록에서 통째로 빼면 그 주문은 영영 복구되지 않는다 → 반드시 대체 경로를 준다. */
  const _slKeys = await require('../utils/sheetlessScope').sheetlessTabKeys(db);
  const { isSheetlessTab } = require('../utils/sheetlessScope');

  for (const row of rows) {
    const tabKey = `${row.sheet_id}||${row.tab_name}`;
    if ((tabCount.get(tabKey) || 0) >= perTabCap) continue;
    tabCount.set(tabKey, (tabCount.get(tabKey) || 0) + 1);

    const orderData = {
      orderer: row.orderer, recipient: row.recipient, userId: row.user_id, phone: row.phone,
      address: row.address, orderNum: row.order_num, dateStr: row.date_str,
      selectedOptKey: row.selected_opt_key, bank: row.bank, account: row.account,
      depositor: row.depositor, price: row.price, memo: row.memo,
      // ★ 138 — 재기록도 같은 상품값을 쓴다(빠지면 복구 한 번에 「상품」 칸이 비워진다).
      selectedProduct: row.selected_product,
    };
    const gid = row.tab_gid || row.gid || '';

    // workboard_apply 전환 탭은 일반 주문이라도 원장 단계에서 sheet_row를 만들지 않는다.
    // enqueue 직후 DB/네트워크 오류가 나면 failed 상태만 남을 수 있으므로, reconcile이 같은
    // 주문 ID의 살아있는 큐를 확인한 뒤 정확히 한 번 다시 등록한다. 이 분기는 일반 sheetless
    // 직접기록보다 먼저 실행해야 기존 RAW 행 배정 경로로 되돌아가지 않는다.
    let queuedTarget;
    try {
      if (_queuedTargetByTab.has(tabKey)) {
        queuedTarget = _queuedTargetByTab.get(tabKey);
      } else {
        queuedTarget = await require('./workboardQueueApply.service').resolveQueuedWorkboardTarget({
          sheetId: row.sheet_id, tabName: row.tab_name,
        });
        _queuedTargetByTab.set(tabKey, queuedTarget);
      }
    } catch (_) {
      queuedTarget = null; // 대상 판정 실패는 기존 복구 경로를 보존한다.
    }
    if (queuedTarget && queuedTarget.enabled) {
      if (dryRun) { result.requeued++; continue; }
      try {
        const { rows: dup } = await db.query(
          `SELECT 1 FROM sync_queue WHERE type = 'workboard_apply' AND status IN ('pending','processing')
             AND (payload->>'orderSubmissionId') = $1 LIMIT 1`,
          [String(row.id)]
        );
        if (dup.length) { result.requeued++; continue; }
        await enqueue('workboard_apply', {
          sheetId: row.sheet_id, tabName: row.tab_name, gid,
          orderSubmissionId: row.id, loginPhone8: '', loginName: '', recovered: true,
        });
        await markOrderQueued(row.id);
        result.requeued++;
      } catch (_) { result.stillStuck++; }
      continue;
    }

    // ── 무시트 탭: 큐 대신 작업표 재기록 ──────────────────────────────
    if (isSheetlessTab(_slKeys, row.sheet_id, row.tab_name, gid)) {
      if (dryRun) { result.sheetlessWritten++; continue; }
      if (!row.sheet_row) { result.noCandidates++; continue; }   // 행 배정은 아래 공통 경로가 아니라 다음 사이클에
      try {
        const w = await require('./sheetlessOrder.service').writeOrderToWorktable({
          sheetId: row.sheet_id, tabName: row.tab_name, tabGid: gid,
          sheetRow: row.sheet_row, orderData, orderSubmissionId: row.id, recovered: true,
        });
        if (w.ok) result.sheetlessWritten++; else result.stillStuck++;
      } catch (_) { result.stillStuck++; }
      continue;
    }

    // ── 시트 기반 탭: 복구하지 않는다(결정 274) ──────────────────────────
    //   종전엔 여기서 시트 행을 배정하고 order_append 를 다시 넣었다. 시트 쓰기 실행부를 지웠으므로
    //   넣어도 아무도 집지 않는다 — 행 배정도 큐 등록도 하지 않고 건수만 센다(주문 상태는 그대로).
    result.sheetTabSkipped++;
  }

  result.byTab = Array.from(tabCount.entries()).map(([tab, processed]) => ({ tab, processed }));
  return result;
}

// ── PR-B 헬퍼: order_submissions 행 → orderData(편집/취소/append fresh값 공유) ──
function _osRowToOrderData(os) {
  return {
    orderer: os.orderer, recipient: os.recipient, userId: os.user_id, phone: os.phone, address: os.address,
    bank: os.bank, account: os.account, depositor: os.depositor, price: os.price, orderNum: os.order_num,
    memo: os.memo, dateStr: os.date_str, selectedOptKey: os.selected_opt_key,
    // ★ 101: 큐 재시도·reconcile 재기록도 같은 값을 쓴다(제출 시점과 시트 기입이 갈리지 않게).
    blogUrl: os.blog_url,
    // ★ 138: 선택 상품도 같은 이유로 재기록 재료에 들어간다 — 빠지면 재기록 한 번에 도로 사라진다.
    selectedProduct: os.selected_product,
  };
}

// 편집 가능 필드 → 헤더 키워드(한글/라틴). _fieldToCol이 헤더에서 컬럼 인덱스를 찾는다.
const _FIELD_HEADER_KW = {
  orderer: [['주문자'], ['orderer']],
  recipient: [['수취인', '받는분', '이름'], ['recipient']],
  user_id: [['아이디'], ['userid', 'id']],
  phone: [['연락처', '전화', '핸드폰', '휴대폰'], ['phone']],
  address: [['주소'], ['address']],
  bank: [['은행'], ['bank']],
  account: [['계좌'], ['account']],
  depositor: [['예금주'], ['depositor']],
  price: [['금액'], ['price']],
  order_num: [['주문번호'], ['ordernum']],
  memo: [['비고', '특이사항'], ['memo']],
  date_str: [['일자', '날짜'], ['date']],
  selected_opt_key: [['옵션'], ['option']],
};
function _fieldToCol(headers, field) {
  // ★ user_id는 _singleIdCol 단일열 게이트로 통일('쿠팡id' 인식 + NC 2열이면 -1).
  //   작업표 기록·작업보드 편집 등 같은 열 판정을 공유(비대칭 divergence 방지).
  if (field === 'user_id') return _singleIdCol(headers);
  const def = _FIELD_HEADER_KW[field];
  if (!def) return -1;
  return findColumn(headers, def[0], def[1] || []);
}

// ★ 재발방지: 제출값이 있는데 시트에 넣을 열을 못 찾은 필드 목록(조용한 누락 관측용).
//   쓰기측(order_append)이 이걸로 warn/logAbnormal → '쿠팡id'류 헤더 미인식이 조용히 새지 않고 즉시 신호로 뜬다.
//   user_id는 NC(id열 2개=동시탭)면 '의도적 미기입'이라 제외하고, id열이 아예 0개인데 값이 있으면 누락으로 본다.
const _UNMAPPED_CHECK_FIELDS = ['recipient', 'phone', 'address', 'bank', 'account', 'depositor', 'order_num'];
const _FIELD_ODKEY = { recipient: 'recipient', phone: 'phone', address: 'address', bank: 'bank',
  account: 'account', depositor: 'depositor', order_num: 'orderNum', user_id: 'userId' };
function unmappedSubmittedFields(headers, orderData = {}) {
  const val = (f) => String((orderData || {})[_FIELD_ODKEY[f]] || '').trim();
  const out = [];
  for (const f of _UNMAPPED_CHECK_FIELDS) {
    if (val(f) && _fieldToCol(headers, f) < 0) out.push(f);
  }
  if (val('user_id') && _idColIndices(headers).length === 0) out.push('user_id'); // NC(2열)는 의도적 미기입 → 제외
  return out;
}

// (시트→DB 역동기화 — REVERSE_SYNC_FIELDS·computeRowWriteSig·rowIdentityMatches·detectReverseSyncProposals·
//  autoApplyReverseSync·rollbackAutoApplied·runReverseSyncAutoCycle 와 그 도우미 — 는 2026-10-23 제거 · 결정 274.
//  표 reverse_sync_proposals 는 기록으로 남는다(열린 제안은 migration 195 가 dismissed 로 닫았다).
//  rowIdentityMatches 는 큐 실행부 order_update·order_cancel 의 신원 재확인이었다 — 그 실행부도 함께 지웠다.)

module.exports = {
  computeDedupKey,
  softDeleteDuplicateOrders,
  buildCandidateRows,
  reconcileStuckOrders,
  _osRowToOrderData,
  _fieldToCol,
  _isIdHeader,
  // id 규칙이 **실제로 이기는** 열 인덱스(관리자 보호열·주문자/수취인·비고 선점분 제외).
  //   작업표 템플릿 분류기가 "채널 id 열"을 판정할 때 이것을 쓴다 — 저수준 `_isIdHeader` 를
  //   쓰면 '상품아이디' 같은 보호열이 채널 열로 오분류된다.
  _idColIndices,
  _singleIdCol,
  unmappedSubmittedFields,
  mapOrderToSheetRow,
  optionColIndexes,
  existingOptionKeyAt,
  optionWriteColumns,
  productWriteColumns,   // 138 — 선택 상품 기입 칸(매퍼 파생 · 사본 금지)
  PRODUCT_HEADER,        // 138 — 작업표 「상품」 열 이름 단일 출처
  blogUrlWriteColumns,
  filterOptionWritesBlankOnly,
  _colIdxFromRange,
  buildBatchUpdateData,
  loadRawTabContext,
  tabDetectedHeaders,
  normalizeWorkdeskPrice,
  normalizeWorkdeskColumnValue,
  syncCellToOrderIdentity,
  claimRow,
  createOrderLedgerEntry,
  markOrderQueued,
  markOrderWritten,
  markOrderMirrorFailed,
  recordReviewIdentity,
  getColLetter,
  __setPoolForTest,
};
