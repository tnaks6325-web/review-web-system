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
  // ★ 풀에서 파생된 캐시(감지대상 허용목록)도 함께 버린다 — 안 버리면 앞 시나리오의 목록이
  //   다음 시나리오에 남아 "왜 건너뛰지?"로 헤맨다(실제로 밟았다).
  _slessKeys = null; _slessAt = 0;
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

// ★ F2: 실시간 "마지막 데이터 행"을 탭당 1콜로 조회.
//   주의: gridProperties.rowCount는 그리드 할당크기(예 1010)지 데이터 끝이 아니다 →
//   그걸 base로 쓰면 append가 데이터 한참 아래(빈칸 수백 행 점프)로 떨어진다.
//   values.get(범위=탭명)은 후행 빈 행을 트림 → 반환 행수 = 실제 마지막 데이터행(1-indexed). 이게 정답.
//   metaCache(사이클 맵)로 같은 사이클 내 탭당 중복콜 제거. base 하한 보정 전용(배치 reconcile만 사용).
async function _getRealMaxRow(sheetId, tabGid, tabName, metaCache) {
  const { readSheet } = require('./sheets.service');
  const { throttledCall } = require('../utils/sheetsThrottle');
  const cacheKey = `${sheetId}||${tabName}`;
  if (metaCache && metaCache.has(cacheKey)) return metaCache.get(cacheKey);
  const safeTab = String(tabName || '').replace(/'/g, "''");
  // gid 미전달 → values.get 경로(후행 빈행 트림). 탭명은 시트 내 유니크(구글 강제)라 안전.
  const grid = await throttledCall(() => readSheet(sheetId, `'${safeTab}'`, {}));
  const lastRow = Array.isArray(grid) ? grid.length : 0;
  if (metaCache) metaCache.set(cacheKey, lastRow);
  return lastRow;
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

function buildMirrorGuardRange({ tabName, headers, targetRow, orderData = {} }) {
  const rowData = mapOrderToSheetRow(headers, orderData);
  const preferredCol = findColumn(headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']);
  const addressCol = findColumn(headers, ['주소', 'address']);
  let col = preferredCol >= 0 ? preferredCol : addressCol;

  if (col < 0) {
    col = rowData.findIndex(v => v !== null && String(v == null ? '' : v).trim() !== '');
  }
  if (col < 0) return null;

  return {
    range: `'${tabName}'!${getColLetter(col)}${targetRow}`,
    col,
    header: headers[col] || '',
    // ★ 이 주문이 가드 칸에 쓸 값(보통 연락처). 재시도 시 "내가 쓴 값"과 외부 기입을 구분하는 데 사용.
    expected: rowData[col] != null ? String(rowData[col]) : '',
  };
}

// ★ D3a(#3): 다중컬럼 가드 — 연락처 한 칸만 보면 그 칸만 빈 수동입력행을 "비었음"으로 오판해 덮어쓴다.
//   연락처+주소+수취인 3칸을 검사해 하나라도 외부값이면 차단. (range 없이 col만 — 호출부가 한 행을
//   한 번에 읽어 셀별로 판정 → 쿼터 1회 유지.) 헤더에서 못 찾으면 첫 비어있지 않은 기대값 칸으로 폴백.
function buildMirrorGuardRanges({ tabName, headers, targetRow, orderData = {} }) {
  const rowData = mapOrderToSheetRow(headers, orderData);
  const cols = [];
  const add = (kw, ex = []) => { const i = findColumn(headers, kw, ex); if (i >= 0) cols.push(i); };
  add(['연락처', '전화', '핸드폰', '휴대폰'], ['phone']);
  add(['주소', 'address']);
  add(['수취인', '받는분', '이름', 'recipient']);
  let uniq = [...new Set(cols)];
  if (!uniq.length) {
    const i = rowData.findIndex(v => v !== null && String(v == null ? '' : v).trim() !== '');
    if (i >= 0) uniq = [i];
  }
  return uniq.map(col => ({
    col,
    header: headers[col] || '',
    expected: rowData[col] != null ? String(rowData[col]) : '',
  }));
}

// 가드 칸 값 정규화 — 연락처류는 숫자만 비교(서식 차이 무시), 그 외는 trim 비교.
function normalizeGuardValue(header, val) {
  const s = String(val == null ? '' : val).trim();
  if (/연락처|전화|핸드폰|휴대폰|phone/i.test(String(header || ''))) {
    return s.replace(/[^0-9]/g, '');
  }
  return s;
}

// 미러 쓰기를 막아야 하는가? (덮어쓰기 방지)
//   - 가드 칸이 비어있음            → false (안전, 써도 됨)
//   - 가드 칸 == 이 주문의 기대값    → false (내가 이미 쓴 값 = 멱등 재기입, 허용)
//   - 가드 칸에 다른 값             → true  (외부/타 주문 기입 = 차단)
function guardBlocksWrite(existingVal, guard) {
  const header = guard && guard.header;
  const existing = normalizeGuardValue(header, existingVal);
  if (!existing) return false;
  const expected = normalizeGuardValue(header, guard && guard.expected);
  if (expected && existing === expected) return false;
  return true;
}

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
 * @param {*} [o.oldValue]                       편집 **전** row_json 값(시트 기반 탭의 큐가 "내가 알던
 *                                                옛값" 대조에 쓴다 — 없으면 라이브 셀이 비어있지 않은 한
 *                                                `mirror_status='conflict'`로 영구 정지해 반영되지 않는다)
 * @param {string} o.orderSubmissionId           editWorkdeskRow 가 확정한 order 앵커
 * @param {string} [o.by]
 * @returns {Promise<{attempted:boolean, ok:boolean, reason?:string, role?:string|null, mode?:string}>}
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

    const { enqueue } = require('./syncQueue.service');   // lazy(순환참조 회피)
    await enqueue('order_update', {
      orderSubmissionId, editSeq,
      edits: [{ field: osCol, oldValue: oldValue == null ? '' : String(oldValue), newValue }],
    });
    return { ok: true, mode: 'queued' };
  }, { onBusy: () => ({ ok: false, reason: 'concurrent_edit' }) });

  if (out && out.mode === 'queued') { try { require('../jobs/queuePump').kickQueuePump(); } catch (_) {} }
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
       selected_product, source, dedup_key, mirror_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NULL,'pending')
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
      // 신청 행에서 이미 확정한 (소유자, 실제참여자) 쌍을 같은 트랜잭션으로 주문원장에 복사한다.
      // phone8 재해석이나 이름 재매칭을 하지 않아, 이후 이름/번호가 바뀌어도 제출 당시 신원이 흔들리지 않는다.
      await client.query(
        `UPDATE order_submissions os
            SET owner_reviewer_id = ca.owner_reviewer_id,
                participant_identity_id = ca.participant_identity_id
           FROM campaign_applications ca
          WHERE os.id = $1 AND ca.id = $2
            AND ca.owner_reviewer_id IS NOT NULL AND ca.participant_identity_id IS NOT NULL`,
        [orderSubmissionId, campaignHold.applicationId]
      );
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
async function reconcileStuckOrders({ limit = 50, perTabCap = 20, sheetId = null, tabName = null, staleQueuedMinutes = 10, dryRun = false, useLiveMaxRow = false } = {}) {
  const db = getPool();
  const { enqueue } = require('./syncQueue.service'); // lazy: require 순환 회피
  const _metaByTab = new Map(); // F2/J-2: 사이클 내 getSpreadsheetMeta 중복콜 제거(시트당 1콜)

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

  const result = { scanned: rows.length, requeued: 0, skippedNoMeta: 0, noCandidates: 0, stillStuck: 0, sheetlessWritten: 0, byTab: [], dryRun };
  const tabCount = new Map();
  const tabCursors = new Map(); // tabKey → 마지막 배정 append 행(순차 커서, 20행 한계 제거)

  /* ★★ 무시트 탭(탈 구글시트 W2)은 **큐로 복구하지 않는다** — 큐는 구글시트에 쓴다.
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
    // ★ D4 보강(리뷰 should-fix): INSERT↔dedup_key UPDATE 사이 크래시로 dedup_key가 NULL이면,
    //   여기서 osid(row.id) 폴백을 넣어 재계산해야 원래 osid 키와 일치(없으면 약한 rcp 키로 떨어져 #5 충돌 재발).
    const dedupKey = row.dedup_key || computeDedupKey({ ...orderData, orderSubmissionId: row.id });
    const gid = row.tab_gid || row.gid || '';
    // ★ 사고(소실) 복구 표식: 사후검증이 "기록했던 행이 사라졌다"고 강등한 건은 원래 자리가 아닌
    //   하단에 다시 적히므로, 큐가 비고란에 [시스템 재기록 · 확인요망]으로 남겨 사람이 확인하게 한다.
    //   (일반 복구는 [시스템 재기록].) sheet_error 는 배정 성공 시 NULL 로 지워지므로 여기서 읽어 전달.
    const recoverReason = /^ghost written/.test(String(row.sheet_error || '')) ? 'lost' : '';

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

    // 이미 행이 있는 주문(failed/정체 queued) → 재배정 없이 바로 재-enqueue
    if (row.sheet_row) {
      if (dryRun) { result.requeued++; continue; }
      // ★ 공정화 #3(R1 근원): 이미 live(pending/processing) order_append가 있으면 재생성 금지 →
      //   고아 큐 누적 차단(written된 주문의 잔여 항목이 throttle를 반복 잠식하던 원인). queued 분기와 동일 가드.
      try {
        const { rows: dup } = await db.query(
          `SELECT 1 FROM sync_queue WHERE type='order_append' AND status IN ('pending','processing')
             AND (payload->>'orderSubmissionId') = $1 LIMIT 1`,
          [String(row.id)]
        );
        if (dup.length) { result.requeued++; continue; }
      } catch (_) { /* 가드 조회 실패는 무시하고 재큐잉(보수적) */ }
      try {
        await enqueue('order_append', {
          sheetId: row.sheet_id, tabName: row.tab_name, gid,
          orderData, orderSubmissionId: row.id, sheetRow: row.sheet_row,
          dedupKey, loginPhone8: '', loginName: '', recovered: true, recoverReason,
        });
        await markOrderQueued(row.id);
        result.requeued++;
      } catch (_) { result.stillStuck++; }
      continue;
    }

    // 행 배정 필요 → RAW 컨텍스트(메타 없으면 skip, 라이브폴백 금지)
    let tabContext = null;
    try { tabContext = await loadRawTabContext(row.sheet_id, gid, row.tab_name); } catch (_) {}
    if (!tabContext || !tabContext.headers || !tabContext.headers.length) {
      result.skippedNoMeta++;
      continue;
    }

    if (dryRun) { result.requeued++; continue; } // 하단 append는 항상 가능

    // ★ 하단 append 행을 "탭별 순차 커서"로 배정(O(n), 20행 한계 제거).
    //   커서 시작 = max(미러 데이터 마지막행, 이미 점유된 sheet_row_claims 최대행) → 패스 간 충돌 없음.
    let cursor = tabCursors.get(tabKey);
    if (cursor == null) {
      let baseRow = tabContext.headerRowIndex || 0;
      for (const dr of (tabContext.dataRows || [])) {
        const ri = parseInt(dr.rowIndex, 10) || 0;
        if (ri > baseRow) baseRow = ri;
      }
      try {
        const mc = await db.query(
          `SELECT COALESCE(MAX(sheet_row), 0) AS m FROM sheet_row_claims WHERE sheet_id = $1 AND tab_name = $2`,
          [row.sheet_id, row.tab_name]
        );
        const claimed = parseInt(mc.rows[0].m, 10) || 0;
        if (claimed > baseRow) baseRow = claimed;
      } catch (_) {}
      // ★ F2: stale 미러로 base가 실제 시트보다 작으면 이미 채워진 행을 claim → 가드블록 스래싱.
      //   useLiveMaxRow(배치 reconcile만)일 때 실시간 그리드 끝행을 base 하한으로 보정(시트당 1콜, 사이클 캐시).
      //   append-only라 그리드 끝 아래는 항상 빈칸 → 가드 통과 보장.
      //   ★ 단, 라이브읽기는 throttle(45/분)에 직렬화되므로 버스트로 throttle 포화면 ~60s 블록 →
      //     pnr 복구가 60s 지연(인터리브 다탭 관측). claims MAX/미러 base가 이미 append에 충분하므로
      //     throttle 여유 없을 땐 라이브읽기 SKIP(캐시값 있으면 사용). 수동행은 다중컬럼 가드가 잡음.
      if (useLiveMaxRow) {
        let live = false;
        const cached = _metaByTab.has(`${row.sheet_id}||${row.tab_name}`);
        if (cached) { live = true; }
        else {
          try {
            const { getThrottleStatus } = require('../utils/sheetsThrottle');
            const busyN = parseInt(process.env.ORDER_RECONCILE_LIVE_MAXROW_BUSY || '30', 10);
            live = getThrottleStatus().requestsInLastMinute < busyN;
          } catch (_) { live = true; }
        }
        if (live) {
          try {
            const realMax = await _getRealMaxRow(row.sheet_id, tabContext.tabGid || gid, row.tab_name, _metaByTab);
            if (realMax > baseRow) baseRow = realMax;
          } catch (e) { logger.warn(`[reconcile] realMaxRow 실패(미러 base 유지): ${e.message}`); }
        }
      }
      cursor = baseRow;
    }
    cursor += 1;
    const candidateRows = [cursor, cursor + 1, cursor + 2, cursor + 3, cursor + 4]; // 작은 버퍼(동시 cron 충돌 대비)
    tabCursors.set(tabKey, cursor);

    const client = await db.connect();
    let claim = { row: null };
    try {
      await client.query('BEGIN');
      claim = await claimRow({
        client, sheetId: row.sheet_id,
        tabGid: tabContext.tabGid || gid, tabName: row.tab_name,
        dedupKey, candidateRows, orderId: row.id,
        meta: { name: row.orderer || row.recipient || '', phone: row.phone, source: 'order_reconcile' },
      });
      await client.query(
        `UPDATE order_submissions
            SET sheet_row = $2::int,
                tab_gid = COALESCE(NULLIF($3, ''), tab_gid),
                mirror_status = CASE WHEN $2::int IS NULL THEN 'pending_no_row' ELSE 'pending' END,
                sheet_error = CASE WHEN $2::int IS NULL THEN $4 ELSE NULL END
          WHERE id = $1`,
        [row.id, claim.row || null, tabContext.tabGid || gid,
         claim.error || (claim.exhausted ? 'row claim exhausted' : 'row claim failed')]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      result.stillStuck++;
      client.release();
      continue;
    }
    client.release();

    if (!claim.row) { result.stillStuck++; continue; }
    { const cr = parseInt(claim.row, 10) || 0; if (cr > (tabCursors.get(tabKey) || 0)) tabCursors.set(tabKey, cr); }

    try {
      await enqueue('order_append', {
        sheetId: row.sheet_id, tabName: row.tab_name, gid: tabContext.tabGid || gid,
        orderData, orderSubmissionId: row.id, sheetRow: claim.row,
        dedupKey, loginPhone8: '', loginName: '', recovered: true, recoverReason,
      });
      await markOrderQueued(row.id);
      result.requeued++;
    } catch (_) { result.stillStuck++; }
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
  //   append(map)·order_update·order_cancel·computeRowWriteSig·reverse-sync가 같은 열 판정을 공유(비대칭 divergence 방지).
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

// ── 시트→DB 역동기화(옵션·수동) 대상 필드(G4: 옵션·dedup영향칸 제외). ──
//   selected_opt_key(옵션칸)는 역매핑이 비결정적이라 제외. recipient/phone은 dedupKey 입력이지만
//   apply가 order_update(매핑칸 in-place)만 타고 dedup_key/claims를 안 건드리므로 포함 가능(R6 방어).
const REVERSE_SYNC_FIELDS = ['orderer', 'recipient', 'user_id', 'phone', 'address', 'bank', 'account', 'depositor', 'price', 'order_num', 'memo', 'date_str'];

// R1 provenance: DB가 "마지막으로 시트에 쓴 매핑칸 값"의 서명. 정방향 written 시 기록.
//   detect가 "현재 시트값 == 이 서명"이면 내가 쓴 흔적 → 제외(핑퐁/노이즈 차단).
//   detect의 _sigFromCells와 동일 필드·순서·정규화를 써야 일치한다.
function computeRowWriteSig(headers, orderData) {
  const mapped = mapOrderToSheetRow(headers, orderData || {});
  const parts = [];
  for (const f of REVERSE_SYNC_FIELDS) {
    const c = _fieldToCol(headers, f);
    if (c >= 0) parts.push(f + '=' + normalizeText(mapped[c]));
  }
  return parts.join('');
}

// ── R1: 그 시트 행이 "여전히 이 주문의 것"인지 다중칸(연락처+수취인+주소) AND 일치로 판정.
//   취소 클리어 전 안전가드 — 사람이 그 행을 재사용했으면 일치 안 해 클리어 거부(데이터 파괴 방지).
//   J-2: 그리드밖 행(빈읽기)은 사람이 손댈 수 없으므로 gridOutOfRange=true로 표시(호출부가 진행 허용).
async function rowIdentityMatches(os, tabContext) {
  const { readSheet, invalidateSheetMeta } = require('./sheets.service');
  const { throttledCall } = require('../utils/sheetsThrottle');
  const sheetId = os.sheet_id || os.sheetId;
  const cands = [
    [findColumn(tabContext.headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']), os.phone],
    [findColumn(tabContext.headers, ['수취인', '받는분', '이름'], ['recipient']), os.recipient],
    [findColumn(tabContext.headers, ['주소'], ['address']), os.address],
  ].filter(([c, v]) => c >= 0 && String(v == null ? '' : v).trim());
  if (!cands.length) return { match: false, gridOutOfRange: false }; // 비교 불가 → 안전: 클리어 거부
  const cols = cands.map(([c]) => c);
  const minC = Math.min(...cols), maxC = Math.max(...cols);
  const range = `'${tabContext.tabName}'!${getColLetter(minC)}${os.sheet_row}:${getColLetter(maxC)}${os.sheet_row}`;
  invalidateSheetMeta(sheetId);
  const read = await throttledCall(() => readSheet(sheetId, range,
    tabContext.tabGid ? { gid: tabContext.tabGid } : {}));
  if (!read || read.length === 0) return { match: false, gridOutOfRange: true }; // J-2: 그리드밖=사람 손 불가
  const cells = read[0] || [];
  const match = cands.every(([col, val]) => {
    const cur = normalizeGuardValue(tabContext.headers[col], cells[col - minC]);
    const exp = normalizeGuardValue(tabContext.headers[col], val);
    return cur && exp && cur === exp;
  });
  return { match, gridOutOfRange: false };
}

// ════════════════════════════════════════════════════════════════════════
// 시트→DB 역동기화(옵션·수동·기본 OFF) — 감지(detect). 읽기 전용 + 제안 생성.
//   심판 최종설계: 자동 무인 동기 금지. 사람이 reverse-sync-apply로 명시 적용.
//   방어: R1(sig 제외) · R2(라이브 단일 사각형 읽기, 미러 값판정 금지) · R3(identity AND 3칸)
//        · R4(그리드밖/전공란=cancel_suspect 플래그만, 단칸 공란 무시) · R5(order_reconcile 락)
//        · R10/G5(throttle busy면 양보) · R11(gid 없으면 보류) · G3(기본 sig-not-null 주문만).
// ════════════════════════════════════════════════════════════════════════
async function detectReverseSyncProposals({ sheetId, tabName, limit = 200, includeNullSig = false, ignoreBusy = false, useLiveHeaders = true } = {}) {
  if (process.env.SHEET_REVERSE_SYNC !== '1') return { skipped: true, reason: 'disabled' };
  if (!sheetId || !tabName) throw new Error('detectReverseSyncProposals: sheetId, tabName 필수');
  // ★★ "지금도 사람이 고칠 수 있는 시트"만 읽는다 — 이 함수의 존재 이유가 "시트를 사람이 고쳤나"인데,
  //   그럴 수 없는 탭을 계속 읽으면 (a) 쿼터를 죽은 시트에 쓰고 (b) 낡은 시트값으로
  //   "원장을 시트값으로" 를 권하게 된다.
  //   실측(2026-08-24): 닫히지 않은 탭 113개가 **전부** 무시트인데 detect 는 3분마다 계속 돌아
  //   하루 약 2,880콜을 썼고, 열린 제안 108건이 전원 무시트 탭 소속이었다.
  //   ⚠ 처음엔 무시트 탭만 뺐는데(#1143) **닫힌 탭 3개에서 계속 새 제안이 생겼다** — sheetless=FALSE 라
  //     무시트 목록에 안 잡히고, 아카이브로 tab_configs 행이 지워진 탭은 목록에 담길 수조차 없었다.
  //     그래서 제외목록이 아니라 **허용목록**으로 뒤집었다(sheetlessScope.DETECTABLE_TABS_SQL).
  //   ★ 판정은 utils/sheetlessScope 단일 출처 — 스마트빌드·RAW 미러·변경감지가 쓰는 그 게이트다
  //     (그 파일 머리주석이 나열한 주기작업 중 역동기화만 빠져 있었다).
  //   ★ 목록을 못 얻으면 건너뛰지 않는다(fail-open) — 게이트가 죽었다고 감지를 멈추지 않는다.
  //   ★ 영구 배제가 아니다. 마감을 풀거나 시트를 재연결하면 그 즉시 다시 감지 대상이 된다.
  if (await _skipDetectTab(sheetId, tabName)) return { skipped: true, reason: 'tab_not_detectable' };
  const { withJobLock } = require('../utils/jobLock');
  return withJobLock('order_reconcile',
    () => _detectReverseSyncInner({ sheetId, tabName, limit, includeNullSig, ignoreBusy, useLiveHeaders }),
    { onBusy: () => ({ skipped: true, reason: 'order_reconcile_lock_busy' }) });
}

const _HEADER_SCAN_ROWS = parseInt(process.env.REVERSE_SYNC_HEADER_SCAN || '20', 10);

/** 무시트 탭 키 집합 — 한 사이클(3탭)에서 같은 목록을 세 번 뜨지 않도록 짧게 캐시한다.
 *  ★ 캐시 수명을 짧게 두는 이유: 무시트 전환·재연결이 다음 사이클에 바로 반영돼야 한다.
 *  ★ 실패하면 빈 집합 → isSheetlessTab 이 전부 false → 종전 동작(fail-open). */
const _SLESS_TTL_MS = 60000;
let _slessKeys = null, _slessAt = 0;
/** 감지해도 되는 탭 허용목록(무시트 아님 · 마감 아님 · tab_configs 에 등록됨). null = 판정 불가. */
async function _detectableKeysCached() {
  const now = Date.now();
  if (_slessKeys !== null && (now - _slessAt) < _SLESS_TTL_MS) return _slessKeys;
  try {
    _slessKeys = await require('../utils/sheetlessScope').detectableTabKeys(getPool());
  } catch (e) {
    logger.warn(`[reverseSync] 감지대상 목록 조회 실패(종전대로 감지 진행): ${e.message}`);
    _slessKeys = null;
  }
  _slessAt = now;
  return _slessKeys;
}
/** 이 탭을 감지에서 건너뛸 것인가. ★ 목록을 못 얻으면(null) 건너뛰지 않는다(fail-open). */
async function _skipDetectTab(sheetId, tabName, tabGid) {
  const keys = await _detectableKeysCached();
  if (!keys) return false;
  return !require('../utils/sheetlessScope').hasTabKey(keys, sheetId, tabName, tabGid);
}

async function _detectReverseSyncInner({ sheetId, tabName, limit, includeNullSig, ignoreBusy, useLiveHeaders }) {
  const db = getPool();
  const { getThrottleStatus, throttledCall } = require('../utils/sheetsThrottle');
  const { readSheet, invalidateSheetMeta } = require('./sheets.service');

  // R10/G5: throttle 여유 없으면 양보(정방향 핫패스 우선). 단 수동 트리거(ignoreBusy)는 소량 콜이라
  //   busy-skip 대신 throttledCall이 슬롯을 기다려 실행(관리자 즉시 결과). cron은 ignoreBusy=false로 양보.
  const busyN = parseInt(process.env.REVERSE_SYNC_BUSY || '15', 10);
  if (!ignoreBusy && getThrottleStatus().requestsInLastMinute > busyN) return { skipped: true, reason: 'throttle_busy' };

  // R11: gid 필수(동명탭 보류). gid는 미러 메타에서.
  const ctx = await loadRawTabContext(sheetId, null, tabName);
  if (!ctx || !ctx.tabGid) return { skipped: true, reason: 'no_meta_or_gid' };
  let headers = ctx.headers;

  // ★ 라이브 헤더 읽기(#2): 미러가 stale/희소하면 detected_headers가 실제 시트 열배치와 어긋나
  //   컬럼 오매핑→오탐(cancel_suspect 폭발). 상단 N행을 라이브로 읽어 헤더를 현재 시트 기준 재감지(1콜).
  //   미러 헤더와 무관하게 컬럼 정확도 보장 → 어떤 탭에서도 detect 정확.
  if (useLiveHeaders) {
    try {
      const top = await throttledCall(() => readSheet(sheetId,
        `'${ctx.tabName}'!A1:ZZ${_HEADER_SCAN_ROWS}`, { gid: ctx.tabGid }));
      const det = detectSheetHeader(Array.isArray(top) ? top : []);
      if (det && det.headers && det.headers.length) headers = det.headers;
    } catch (e) { logger.warn(`[reverseSync] 라이브 헤더 읽기 실패(미러 헤더 사용): ${e.message}`); }
  }
  if (!headers || !headers.length) return { skipped: true, reason: 'no_headers' };

  // 필드→컬럼 매핑(헤더 고정). 식별칸(연락처/수취인/주소) + 역동기 대상칸.
  const fieldCols = {};
  for (const f of REVERSE_SYNC_FIELDS) { const c = _fieldToCol(headers, f); if (c >= 0) fieldCols[f] = c; }
  const idFields = ['phone', 'recipient', 'address'].filter(f => fieldCols[f] != null);
  if (!Object.keys(fieldCols).length || !idFields.length) return { scanned: 0, proposals: 0, reason: 'no_mappable_cols' };

  // R9/G3: written·미취소·행배정 주문만. 기본은 sig 있는 주문만(과거 전수비교 노이즈 폭발 차단).
  const sigFilter = includeNullSig ? '' : ' AND last_sheet_write_sig IS NOT NULL';
  const { rows: orders } = await db.query(
    `SELECT id, sheet_row, orderer, recipient, user_id, phone, address, bank, account, depositor,
            price, order_num, memo, date_str, selected_opt_key, last_sheet_write_sig, last_edit_seq
       FROM order_submissions
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
        AND mirror_status = 'written' AND sheet_row IS NOT NULL${sigFilter}
      ORDER BY sheet_row LIMIT $3`,
    [sheetId, tabName, limit]
  );
  if (!orders.length) return { scanned: 0, proposals: 0 };

  // R2: 라이브 단일 사각형 1콜(미러 금지). 매핑칸 union × 주문 행 범위.
  const cols = Object.values(fieldCols);
  const minC = Math.min(...cols), maxC = Math.max(...cols);
  const rows = orders.map(o => o.sheet_row);
  const minR = Math.min(...rows), maxR = Math.max(...rows);
  invalidateSheetMeta(sheetId);
  const grid = await throttledCall(() => readSheet(sheetId,
    `'${ctx.tabName}'!${getColLetter(minC)}${minR}:${getColLetter(maxC)}${maxR}`, { gid: ctx.tabGid }));

  let made = 0, edits = 0, suspects = 0, skippedSig = 0, identMismatch = 0;
  for (const os of orders) {
    const gi = os.sheet_row - minR;
    const gridRow = grid && grid[gi];
    const cellAt = (c) => (gridRow ? gridRow[c - minC] : undefined);
    const gridOutOfRange = !gridRow || gridRow.length === 0; // R4: 그리드밖/빈행 = 사람 손 불가

    // R3: identity AND(연락처+수취인+주소) — cells에서 직접(추가 쿼터 0).
    let allGuardEmpty = true, idMatch = true, idComparable = 0;
    for (const f of idFields) {
      const c = fieldCols[f];
      const cur = normalizeGuardValue(headers[c], cellAt(c));
      const exp = normalizeGuardValue(headers[c], os[f]);
      if (cur) allGuardEmpty = false;
      if (exp) { idComparable++; if (!(cur && cur === exp)) idMatch = false; }
    }

    if (gridOutOfRange) { continue; } // R4: 그리드밖은 취소 오인 금지 — 스킵
    if (idComparable === 0 || !idMatch) {
      // 식별 불일치: 사람이 그 행을 다른 용도로 재사용 가능. 전부 공란이면 "취소 의심" 플래그만(자동취소 금지).
      identMismatch++;
      if (allGuardEmpty) {
        made += await _replaceOpenProposal(db, os, sheetId, tabName, ctx.tabGid,
          { type: 'cancel_suspect', field: null, oldv: null, newv: null, sig: null });
        suspects++;
      }
      continue;
    }

    // R1: 현재 시트서명 == 내가 마지막 쓴 서명 → 내가 쓴 값(변경 아님) 제외.
    const curSig = _sigFromCells(headers, fieldCols, cellAt);
    if (os.last_sheet_write_sig && curSig === os.last_sheet_write_sig) { skippedSig++; continue; }

    // 필드별 diff → edit 제안. 단칸 공란은 무시(R2/R4 원본 보존).
    const mapped = mapOrderToSheetRow(headers, _osRowToOrderData(os));
    const fieldEdits = [];
    for (const f of REVERSE_SYNC_FIELDS) {
      const c = fieldCols[f]; if (c == null) continue;
      const dbv = normalizeText(mapped[c]);
      const shv = normalizeText(cellAt(c));
      if (shv === dbv) continue;
      if (shv === '') continue; // 공란은 자동 역반영 금지(실수/미러 누락 보호)
      fieldEdits.push({ field: f, oldv: dbv, newv: shv });
    }
    if (fieldEdits.length) {
      made += await _replaceOpenProposalEdits(db, os, sheetId, tabName, ctx.tabGid, fieldEdits, curSig, os.last_edit_seq);
      edits += fieldEdits.length;
    }
  }
  return { scanned: orders.length, proposals: made, edits, cancelSuspects: suspects, skippedBySig: skippedSig, identityMismatch: identMismatch };
}

// detect의 시트행 서명(write-time computeRowWriteSig와 동일 필드·순서·정규화).
function _sigFromCells(headers, fieldCols, cellAt) {
  const parts = [];
  for (const f of REVERSE_SYNC_FIELDS) {
    if (fieldCols[f] == null) continue;
    parts.push(f + '=' + normalizeText(cellAt(fieldCols[f])));
  }
  return parts.join('');
}

// G2 멱등: 트랜잭션 내 "open 제안 교체(DELETE→INSERT)". (단일 cancel_suspect/전체 edits 교체)
async function _replaceOpenProposal(db, os, sheetId, tabName, tabGid, { type, field, oldv, newv, sig }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM reverse_sync_proposals WHERE os_id = $1 AND status = 'open'`, [os.id]);
    await client.query(
      `INSERT INTO reverse_sync_proposals (os_id, sheet_id, tab_name, tab_gid, sheet_row, proposal_type, field, old_value, new_value, detected_sig, detected_edit_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [os.id, sheetId, tabName, tabGid, os.sheet_row, type, field, oldv, newv, sig, os.last_edit_seq]
    );
    await client.query('COMMIT');
    return 1;
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} logger.warn(`[reverseSync] 제안 기록 실패: ${e.message}`); return 0; }
  finally { client.release(); }
}

async function _replaceOpenProposalEdits(db, os, sheetId, tabName, tabGid, fieldEdits, sig, detectedEditSeq) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM reverse_sync_proposals WHERE os_id = $1 AND status = 'open'`, [os.id]);
    for (const e of fieldEdits) {
      await client.query(
        `INSERT INTO reverse_sync_proposals (os_id, sheet_id, tab_name, tab_gid, sheet_row, proposal_type, field, old_value, new_value, detected_sig, detected_edit_seq)
         VALUES ($1,$2,$3,$4,$5,'edit',$6,$7,$8,$9,$10)`,
        [os.id, sheetId, tabName, tabGid, os.sheet_row, e.field, e.oldv, e.newv, sig, detectedEditSeq]
      );
    }
    await client.query('COMMIT');
    return fieldEdits.length;
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} logger.warn(`[reverseSync] edit 제안 기록 실패: ${e.message}`); return 0; }
  finally { client.release(); }
}

// ════════════════════════════════════════════════════════════════════════
// 시트→DB 역동기화 "무인 자동적용(constrained auto-apply)".
//   게이트: SHEET_REVERSE_SYNC=1 AND REVERSE_SYNC_AUTO=1 AND ORDER_LEDGER_WRITE_ENABLED=true
//           (셋 중 하나라도 아니면 비활성 — 순수 옵트인, 기본 OFF, 되돌리기 쉬움).
//   적대검증(레드→블루→심판) 방어:
//     - 전용 락 reverse_sync_auto: 인스턴스/사이클 직렬화. order_reconcile·order_ledger와 키 비충돌 확인.
//     - 안전필드 화이트리스트(_autoSafeFields): price/order_num/identity 하드 제외(돈·송장·오배송 비가역 차단).
//     - apply시점 라이브 재검증: 탭당 1 사각형 읽기로 (a)편집셀이 여전히 new_value (b)identity(연락처+수취인+주소) 재일치.
//     - per-order 쿨다운(reverse_sync_last_auto_at): 자동적용 폭주/핑퐁 hysteresis.
//     - per-order 락(order_ledger:<id>) + G6 edit_seq 불변 + written·미삭제 재확인 → 정식편집과 경합 차단.
//     - applied_old_value 기록 → 롤백(rollbackAutoApplied) 가능. order_update no-op으로 시트 재기록 없음(핑퐁 0).
// ════════════════════════════════════════════════════════════════════════
const REVERSE_SYNC_AUTO_FIELDS_DEFAULT = 'orderer,user_id,memo,date_str';
function _autoSafeFields() {
  const raw = process.env.REVERSE_SYNC_AUTO_FIELDS || REVERSE_SYNC_AUTO_FIELDS_DEFAULT;
  const set = new Set(String(raw).split(',').map(s => s.trim()).filter(Boolean));
  // 하드 제외(어떤 env 설정으로도 무인 자동적용 금지):
  //   price/order_num = 돈·송장(비가역 오염), phone/recipient/address = 신원(detect가 제안도 안 하지만 방어적으로).
  for (const f of ['price', 'order_num', 'phone', 'recipient', 'address']) set.delete(f);
  // 화이트리스트 교집합(REVERSE_SYNC_FIELDS에 있는 필드만 — 인젝션/오타 방어).
  return [...set].filter(f => REVERSE_SYNC_FIELDS.includes(f));
}

async function autoApplyReverseSync({ limit, dryRun = false } = {}) {
  if (process.env.SHEET_REVERSE_SYNC !== '1') return { skipped: true, reason: 'reverse_sync_disabled' };
  if (process.env.REVERSE_SYNC_AUTO !== '1') return { skipped: true, reason: 'auto_disabled' };
  if (!dryRun && process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return { skipped: true, reason: 'ledger_write_disabled' };
  const { withJobLock } = require('../utils/jobLock');
  return withJobLock('reverse_sync_auto',
    () => _autoApplyInner({ limit, dryRun }),
    { onBusy: () => ({ skipped: true, reason: 'reverse_sync_auto_lock_busy' }) });
}

async function _autoApplyInner({ limit, dryRun }) {
  const db = getPool();
  const { throttledCall, getThrottleStatus } = require('../utils/sheetsThrottle');
  const { readSheet, invalidateSheetMeta } = require('./sheets.service');
  const { withJobLock } = require('../utils/jobLock');
  const { enqueue } = require('./syncQueue.service');

  // busy면 양보(정방향 핫패스 우선) — cron 재시도가 backstop.
  const busyN = parseInt(process.env.REVERSE_SYNC_BUSY || '15', 10);
  if (getThrottleStatus().requestsInLastMinute > busyN) return { skipped: true, reason: 'throttle_busy' };

  const rateCap = Math.min(Math.max(parseInt(limit || process.env.REVERSE_SYNC_AUTO_MAX || '20', 10), 1), 200);
  const cooldownMin = Math.max(parseInt(process.env.REVERSE_SYNC_AUTO_COOLDOWN_MIN || '10', 10), 0);
  const safeArr = _autoSafeFields();
  if (!safeArr.length) return { skipped: true, reason: 'no_safe_fields' };

  // 후보: open edit 제안(안전필드) + written·미삭제 + per-order 쿨다운 통과. 오래된 순.
  //   주문 단위로 묶기 위해 os_id로도 정렬(같은 주문 제안 인접).
  const { rows: props } = await db.query(
    `SELECT p.id, p.os_id, p.sheet_id, p.tab_name, p.tab_gid, p.sheet_row, p.field,
            p.new_value, p.detected_edit_seq
       FROM reverse_sync_proposals p
       JOIN order_submissions o ON o.id = p.os_id
      WHERE p.status = 'open' AND p.proposal_type = 'edit'
        AND p.field = ANY($1::text[])
        AND o.deleted_at IS NULL AND o.mirror_status = 'written' AND o.sheet_row IS NOT NULL
        AND (o.reverse_sync_last_auto_at IS NULL
             OR o.reverse_sync_last_auto_at < NOW() - ($2 || ' minutes')::interval)
      ORDER BY p.detected_at ASC, p.os_id
      LIMIT $3`,
    [safeArr, String(cooldownMin), rateCap]
  );
  if (!props.length) return { candidates: 0, applied: 0, orders: 0, dismissed: 0, reverifyFail: 0, dryRun: !!dryRun };

  // 탭별 그룹 → 탭당 1 사각형 라이브 읽기(쿼터 절약). 그 안에서 다시 os_id별로 묶어 주문단위 적용.
  const byTab = new Map();
  for (const p of props) {
    const key = `${p.sheet_id}||${p.tab_name}`;
    if (!byTab.has(key)) byTab.set(key, []);
    byTab.get(key).push(p);
  }

  let applied = 0, ordersApplied = 0, dismissed = 0, reverifyFail = 0, staleG6 = 0, tabsSkipped = 0;
  for (const [, tabProps] of byTab) {
    const first = tabProps[0];
    // ★ 감지 대상이 아닌 탭은 재검증 읽기도 하지 않는다 — detect 를 막아도 **이미 쌓인** 제안이 남아
    //   여기서 탭당 라이브 2콜(헤더+사각형)이 계속 나간다. 읽어 봐야 아무도 안 고치는 시트다.
    //   제안은 지우지 않고 그대로 둔다(사람이 화면에서 판단할 몫 — 여기서 조용히 기각하지 않는다).
    if (await _skipDetectTab(first.sheet_id, first.tab_name, first.tab_gid)) { tabsSkipped++; continue; }
    const ctx = await loadRawTabContext(first.sheet_id, first.tab_gid, first.tab_name);
    if (!ctx || !ctx.tabGid) { tabsSkipped++; continue; }
    let headers = ctx.headers;
    try {
      const top = await throttledCall(() => readSheet(first.sheet_id,
        `'${ctx.tabName}'!A1:ZZ${_HEADER_SCAN_ROWS}`, { gid: ctx.tabGid }));
      const det = detectSheetHeader(Array.isArray(top) ? top : []);
      if (det && det.headers && det.headers.length) headers = det.headers;
    } catch (e) { logger.warn(`[reverseSyncAuto] 라이브 헤더 실패(미러 사용): ${e.message}`); }
    if (!headers || !headers.length) { tabsSkipped++; continue; }

    const fieldCols = {};
    for (const f of REVERSE_SYNC_FIELDS) { const c = _fieldToCol(headers, f); if (c >= 0) fieldCols[f] = c; }
    const idFields = ['phone', 'recipient', 'address'].filter(f => fieldCols[f] != null);
    const editCols = tabProps.map(p => fieldCols[p.field]).filter(c => c != null);
    if (!editCols.length) { tabsSkipped++; continue; }
    // 심판[중대2]: 무인 자동적용은 신원 3칸(연락처+수취인+주소) 전부 매핑될 때만.
    //   라이브 헤더 재감지에서 한 칸이라도 사라지면(약한 신원검증) 자동 대상서 제외 → 그 탭은 수동 apply로.
    if (idFields.length < 3) { tabsSkipped++; continue; }
    const cols = [...editCols, ...idFields.map(f => fieldCols[f])];
    const minC = Math.min(...cols), maxC = Math.max(...cols);
    const rowsN = tabProps.map(p => p.sheet_row);
    const minR = Math.min(...rowsN), maxR = Math.max(...rowsN);
    invalidateSheetMeta(first.sheet_id);
    let grid;
    try {
      grid = await throttledCall(() => readSheet(first.sheet_id,
        `'${ctx.tabName}'!${getColLetter(minC)}${minR}:${getColLetter(maxC)}${maxR}`, { gid: ctx.tabGid }));
    } catch (e) { logger.warn(`[reverseSyncAuto] 라이브 재검증 읽기 실패: ${e.message}`); tabsSkipped++; continue; }

    // 주문(os_id) 단위 묶기 — 같은 주문의 여러 필드는 한 락에서 함께 적용(쿨다운 형제 굶김 방지).
    const byOrder = new Map();
    for (const p of tabProps) {
      if (!byOrder.has(p.os_id)) byOrder.set(p.os_id, []);
      byOrder.get(p.os_id).push(p);
    }

    for (const [osId, oProps] of byOrder) {
      const sheetRow = oProps[0].sheet_row;
      const gi = sheetRow - minR;
      const gridRow = grid && grid[gi];
      const cellAt = (c) => (gridRow ? gridRow[c - minC] : undefined);
      // 그리드밖/빈행 = 사람 손 불가(취소 오인 금지) → 그대로 두고 스킵(다음 detect가 정리).
      if (!gridRow || gridRow.length === 0) { continue; }

      const out = await withJobLock('order_ledger:' + osId, async () => {
        const { rows: cur } = await db.query(
          `SELECT orderer, user_id, memo, date_str, bank, account, depositor,
                  phone, recipient, address, last_edit_seq, deleted_at, mirror_status, reverse_sync_last_auto_at
             FROM order_submissions WHERE id = $1`, [osId]);
        if (!cur.length || cur[0].deleted_at || cur[0].mirror_status !== 'written') return { staleOrder: true };
        // 쿨다운 경합 재확인.
        const lastAuto = cur[0].reverse_sync_last_auto_at ? new Date(cur[0].reverse_sync_last_auto_at).getTime() : 0;
        if (lastAuto && (Date.now() - lastAuto) < cooldownMin * 60000) return { cooldown: true };
        // identity 재일치(연락처+수취인+주소 AND) — grid 셀 vs DB 최신값.
        let idMatch = idFields.length > 0, idComparable = 0;
        for (const f of idFields) {
          const c = fieldCols[f];
          const gv = normalizeGuardValue(headers[c], cellAt(c));
          const dv = normalizeGuardValue(headers[c], cur[0][f]);
          if (dv) idComparable++;
          if (!(gv && dv && gv === dv)) idMatch = false;
        }
        if (idComparable === 0 || !idMatch) return { identityFail: true };

        // 필드별 최종 재검증 → 적용 대상 수집.
        const toApply = []; // { propId, field, newValue, appliedOld }
        const dismiss = []; // propId (재검증 실패 → 정리)
        for (const p of oProps) {
          // G6: 감지 후 정식 편집/취소가 있었으면 이 필드는 stale.
          if (p.detected_edit_seq != null && Number(cur[0].last_edit_seq) !== Number(p.detected_edit_seq)) { dismiss.push(p.id); continue; }
          const editC = fieldCols[p.field];
          if (editC == null) { dismiss.push(p.id); continue; }
          const shv = normalizeText(cellAt(editC));
          if (shv === '') { dismiss.push(p.id); continue; }            // 공란 자동반영 금지
          if (shv !== normalizeText(p.new_value)) { dismiss.push(p.id); continue; } // 시트가 또 바뀜 → 이번 제안 무효(detect 재생성)
          const dbCur = cur[0][p.field];
          if (normalizeText(dbCur) === shv) { dismiss.push(p.id); continue; } // 이미 동기 = no-op
          toApply.push({ propId: p.id, field: p.field, newValue: p.new_value, appliedOld: dbCur == null ? '' : String(dbCur) });
        }

        if (dryRun) return { appliedFields: 0, dismissed: 0, wouldApply: toApply.length, wouldDismiss: dismiss.length };

        // stale/재검증실패 제안 정리(open→dismissed) — detect가 유효하면 재생성.
        for (const id of dismiss) {
          await db.query(`UPDATE reverse_sync_proposals SET status='dismissed', resolved_at=NOW(), resolved_by='auto:reverify' WHERE id=$1 AND status='open'`, [id]);
        }
        if (!toApply.length) return { appliedFields: 0, dismissed: dismiss.length };

        // 심판[치명1]: 편집 확정 시점에 last_edit_seq를 락 안에서 즉시 단조증가 →
        //   큐워커 지연과 무관하게 후속 detect/apply가 이 자동적용을 stale로 인식(관리자편집 덮어쓰기 창 차단).
        //   editSeq는 UPDATE와 enqueue가 동일값을 써야 큐워커 GREATEST가 no-op.
        const editSeq = Date.now();
        // 다중필드 원자 UPDATE(화이트리스트 필드만 → 인젝션 불가) + 쿨다운 스탬프 + edit_seq 단조증가.
        const sets = toApply.map((e, i) => `${e.field} = $${i + 2}`);
        const vals = [osId, ...toApply.map(e => e.newValue)];
        await db.query(
          `UPDATE order_submissions SET ${sets.join(', ')}, updated_at = NOW(), reverse_sync_last_auto_at = NOW(),
                  last_edit_seq = GREATEST(COALESCE(last_edit_seq, 0), $${vals.length + 1})
             WHERE id = $1 AND deleted_at IS NULL`, [...vals, editSeq]);
        await enqueue('order_update', { orderSubmissionId: osId, editSeq,
          edits: toApply.map(e => ({ field: e.field, oldValue: e.appliedOld, newValue: e.newValue })) });
        for (const e of toApply) {
          await db.query(
            `UPDATE reverse_sync_proposals SET status='applied', auto_applied=TRUE, applied_old_value=$2, resolved_at=NOW(), resolved_by='auto'
               WHERE id=$1 AND status='open'`, [e.propId, e.appliedOld]);
        }
        return { appliedFields: toApply.length, dismissed: dismiss.length };
      });

      if (!out) continue; // 락 busy 등 → 다음 사이클
      // dryRun은 wouldApply/wouldDismiss로 실행 예측(실적용과 동일 의미의 집계).
      const addApplied = out.wouldApply != null ? out.wouldApply : (out.appliedFields || 0);
      const addDismissed = out.wouldDismiss != null ? out.wouldDismiss : (out.dismissed || 0);
      if (addApplied || addDismissed) { applied += addApplied; if (addApplied) ordersApplied++; dismissed += addDismissed; }
      else if (out.identityFail) { reverifyFail++; }
      else if (out.staleOrder) { staleG6++; }
      // cooldown → 조용히 스킵(다음 사이클)
    }
  }
  return { candidates: props.length, applied, orders: ordersApplied, dismissed, reverifyFail, staleG6, tabsSkipped, dryRun: !!dryRun };
}

// 자동적용 롤백: auto_applied 제안의 applied_old_value로 필드 복원 + order_update 재큐(시트도 원복).
async function rollbackAutoApplied({ proposalId, osId } = {}) {
  if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return { skipped: true, reason: 'ledger_write_disabled' };
  const db = getPool();
  const { withJobLock } = require('../utils/jobLock');
  const { enqueue } = require('./syncQueue.service');
  let where, params;
  if (proposalId) { where = `id = $1 AND auto_applied = TRUE AND status = 'applied'`; params = [proposalId]; }
  else if (osId) { where = `os_id = $1 AND auto_applied = TRUE AND status = 'applied'`; params = [osId]; }
  else throw new Error('rollbackAutoApplied: proposalId 또는 osId 필수');
  const { rows } = await db.query(
    `SELECT id, os_id, field, applied_old_value, new_value FROM reverse_sync_proposals
      WHERE ${where} ORDER BY resolved_at DESC LIMIT 1`, params);
  if (!rows.length) return { rolledBack: 0, reason: 'not_found' };
  const p = rows[0];
  if (!REVERSE_SYNC_FIELDS.includes(p.field)) return { rolledBack: 0, reason: 'field_not_allowed' }; // 인젝션 방어
  const restore = p.applied_old_value == null ? '' : p.applied_old_value; // 코드리뷰[#3]: NULL→'' 정규화(비교 일관)
  return withJobLock('order_ledger:' + p.os_id, async () => {
    const { rows: cu } = await db.query(`SELECT deleted_at FROM order_submissions WHERE id = $1`, [p.os_id]);
    if (!cu.length || cu[0].deleted_at) return { rolledBack: 0, reason: 'order_deleted' };
    const editSeq = Date.now();
    // 롤백도 편집 확정이므로 last_edit_seq 단조증가(치명1 일관) — 자동적용값을 stale로 만들어 재적용 차단.
    await db.query(
      `UPDATE order_submissions SET ${p.field} = $2, updated_at = NOW(),
              last_edit_seq = GREATEST(COALESCE(last_edit_seq, 0), $3)
         WHERE id = $1 AND deleted_at IS NULL`,
      [p.os_id, restore, editSeq]);
    await enqueue('order_update', { orderSubmissionId: p.os_id, editSeq,
      edits: [{ field: p.field, oldValue: p.new_value, newValue: restore }] });
    await db.query(`UPDATE reverse_sync_proposals SET status='dismissed', resolved_at=NOW(), resolved_by='rollback' WHERE id = $1`, [p.id]);
    return { rolledBack: 1, field: p.field, osId: p.os_id, restored: restore };
  });
}

// 무인 사이클(cron): 활성탭(written+sig)을 라운드로빈으로 detect → 전체 open 제안 1회 autoApply.
//   탭당 라이브읽기라 perCycle로 쿼터 캡. 커서로 사이클마다 다음 탭묶음 → 전탭 순회.
let _reverseAutoCursor = 0;
async function runReverseSyncAutoCycle({ tabsPerCycle } = {}) {
  if (process.env.SHEET_REVERSE_SYNC !== '1' || process.env.REVERSE_SYNC_AUTO !== '1') return { skipped: true, reason: 'disabled' };
  // 코드리뷰[#4]/심판[중대3]: 쓰기게이트 OFF면 detect(라이브 시트읽기=쿼터) 자체를 건너뜀(순수 옵트인).
  if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return { skipped: true, reason: 'ledger_write_disabled' };
  const db = getPool();
  const perCycle = Math.min(Math.max(parseInt(tabsPerCycle || process.env.REVERSE_SYNC_TABS_PER_CYCLE || '3', 10), 1), 30);
  // 시트 편집은 주문 updated_at을 바꾸지 않으므로 시간필터 없이 written+sig 탭 전체를 라운드로빈(오래된 주문의 시트편집도 커버).
  const { rows: rawTabs } = await db.query(
    `SELECT sheet_id, tab_name FROM order_submissions
      WHERE deleted_at IS NULL AND mirror_status = 'written' AND sheet_row IS NOT NULL AND last_sheet_write_sig IS NOT NULL
      GROUP BY sheet_id, tab_name ORDER BY sheet_id, tab_name LIMIT 500`
  );
  // ★ 감지 대상이 아닌 탭을 여기서 걸러 낸다. detect 안에도 같은 게이트가 있지만(단일 관문),
  //   사이클당 탭이 3개뿐이라 그런 탭이 라운드로빈 자리를 먹으면 **진짜 시트 탭이 며칠씩 밀린다**.
  //   ⚠ 무시트 전환도 탭 마감도 last_sheet_write_sig 를 지우지 않는다(전환·마감 전에 시트에 써진
  //     주문이라 표식이 그대로 남는다) → 위 쿼리만으로는 그 탭들이 전부 따라 들어온다.
  //     그게 이번 낭비의 원인이었다.
  const _okKeys = await _detectableKeysCached();
  const { hasTabKey } = require('../utils/sheetlessScope');
  const tabs = _okKeys ? rawTabs.filter(t => hasTabKey(_okKeys, t.sheet_id, t.tab_name)) : rawTabs;
  const skippedNotDetectable = rawTabs.length - tabs.length;
  let detected = 0, detectRuns = 0;
  if (tabs.length) {
    const start = _reverseAutoCursor % tabs.length;
    for (let i = 0; i < Math.min(perCycle, tabs.length); i++) {
      const t = tabs[(start + i) % tabs.length];
      try {
        const d = await detectReverseSyncProposals({ sheetId: t.sheet_id, tabName: t.tab_name }); // ignoreBusy=false → busy면 양보
        detectRuns++;
        if (d && d.proposals) detected += d.proposals;
      } catch (e) { logger.warn(`[reverseSyncAuto] detect 실패 ${t.tab_name}: ${e.message}`); }
    }
    _reverseAutoCursor = (start + perCycle) % tabs.length;
  }
  const apply = await autoApplyReverseSync({});
  return { activeTabs: tabs.length, skippedNotDetectable, detectRuns, detected, apply };
}

module.exports = {
  /** 테스트 전용 — 무시트 판정 캐시를 비운다(전환 직후 동작을 스위트에서 확인하기 위한 것). */
  _resetSheetlessCacheForTest: () => { _slessKeys = null; _slessAt = 0; },
  computeDedupKey,
  softDeleteDuplicateOrders,
  buildCandidateRows,
  reconcileStuckOrders,
  // 시트 변경 감지용 공개 트리거: 가드 차단(=시트가 예상과 다름 신호) 시 그 시트만 자동 재미러+리컨실.
  //   내부 60초/시트 debounce + order_reconcile 락 직렬화 그대로 — 이벤트성 호출에 안전.
  triggerSheetMirrorOnce: _triggerSheetMirrorOnce,
  _osRowToOrderData,
  _fieldToCol,
  _isIdHeader,
  // id 규칙이 **실제로 이기는** 열 인덱스(관리자 보호열·주문자/수취인·비고 선점분 제외).
  //   작업표 템플릿 분류기가 "채널 id 열"을 판정할 때 이것을 쓴다 — 저수준 `_isIdHeader` 를
  //   쓰면 '상품아이디' 같은 보호열이 채널 열로 오분류된다.
  _idColIndices,
  _singleIdCol,
  unmappedSubmittedFields,
  rowIdentityMatches,
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
  buildMirrorGuardRange,
  buildMirrorGuardRanges,
  guardBlocksWrite,
  normalizeGuardValue,
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
  computeRowWriteSig,
  detectReverseSyncProposals,
  autoApplyReverseSync,
  rollbackAutoApplied,
  runReverseSyncAutoCycle,
  _autoSafeFields,
  __setPoolForTest,
};
