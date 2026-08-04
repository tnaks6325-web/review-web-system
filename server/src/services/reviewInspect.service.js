/**
 * reviewInspect.service.js — 리뷰 자동검수 (M0 1차 필터 + M1 2차 검수).
 *
 * 두 층으로 나뉜다.
 *   1차(M0) = 리뷰어가 캡처를 **첨부하는 순간**. 리뷰 화면인가 / 어느 채널인가만 본다.
 *             아직 Drive 에 올라가지도, 제출로 기록되지도 않은 상태라 파일만 바꾸면 끝난다.
 *   2차(M1) = **제출 이후**. 상품명·같은 파일·본문 겹침처럼 다른 제출과 대조해야
 *             나오는 판정. 결과는 기록만 하고 제출을 되돌리지 않는다.
 *
 * ★★ 완화 금지 불변식 (이 셋이 풀리면 "참여 소각" 사고가 난다)
 *   ① fail-open — AI 미설정·오류·타임아웃·저확신은 **통과**. 모르면 통과가 원칙.
 *   ② 차단은 "리뷰 화면이 아님"(kind='other') + 높은 확신 **하나뿐**.
 *      채널 불일치·상품명 불일치·중복·유사도는 **절대 차단하지 않는다**(경고 또는 사후 분류).
 *   ③ 카카오메이커스는 잠금 제외 — 별점 있는 후기 화면과 별점 없는 피드형이 공존해
 *      리뷰어가 어느 쪽을 캡처할지 통제할 수 없다. 피드형 오판이 곧 정상 제출 차단이다.
 */
const crypto = require('crypto');
const { logger } = require('../utils/logger');

/* ── 스위치·임계값 (전부 env 로 끌 수 있다) ───────────────────────────── */
const ENABLED = process.env.REVIEW_INSPECT !== '0';            // 2차 검수 전체
const PRECHECK_ENABLED = process.env.REVIEW_PRECHECK !== '0';  // 1차 필터 전체
// ★ 관측 모드: 판정은 하되 **잠그지 않는다**. 운영 초기 오탐률을 보는 동안 이걸 권장.
const PRECHECK_BLOCK = process.env.REVIEW_PRECHECK_BLOCK !== '0';
const BLOCK_CONFIDENCE = Number(process.env.REVIEW_PRECHECK_BLOCK_CONFIDENCE || 0.9);
const CHANNEL_WARN_CONFIDENCE = Number(process.env.REVIEW_PRECHECK_CHANNEL_CONFIDENCE || 0.8);
const SIM_THRESHOLD = Number(process.env.REVIEW_INSPECT_SIM_THRESHOLD || 0.9);
const MIN_TEXT = Number(process.env.REVIEW_INSPECT_MIN_TEXT || 30);
// ★ 두 글의 길이가 이 비율 이상일 때만 "포함 관계"(word_similarity)까지 본다.
//   낮추면 짧은 관용구가 긴 리뷰에 들어있다는 이유로 오탐이 난다(findSimilarText 주석 참조).
const SIM_LEN_RATIO = Number(process.env.REVIEW_INSPECT_SIM_LEN_RATIO || 0.5);
// ★ 잠금 제외 채널 — 위 불변식 ③
const BLOCK_EXEMPT_CHANNELS = String(process.env.REVIEW_PRECHECK_EXEMPT || 'kakao')
  .split(',').map(s => s.trim()).filter(Boolean);

let _pool;
function _db() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}
function __setPoolForTest(p) { _pool = p || null; }

/* ── 채널 표기 ─────────────────────────────────────────────────────── */
const CHANNEL_LABELS = {
  coupang: '쿠팡', naver: '네이버', kakao: '카카오메이커스', oliveyoung: '올리브영',
};
function channelLabel(k) { return CHANNEL_LABELS[k] || ''; }

/**
 * 탭/공고의 구매채널 문자열 → 검수용 채널 key.
 * 관리자 화면의 버튼값(쿠팡·네이버·올리브영·카카오메이커스)과 커스텀 입력 양쪽을 받는다.
 * ★ 카카오는 '메이커스'를 요구 — 톡스토어·선물하기는 화면이 달라 같은 기준을 쓸 수 없다
 *   (utils/cashReceiptChannels 와 같은 규율). 판정 실패는 null = 대조 안 함.
 */
function expectedChannelKey(channel) {
  const ch = String(channel == null ? '' : channel);
  if (!ch.trim()) return null;
  if (/쿠팡|coupang/i.test(ch)) return 'coupang';
  if (/네이버|스마트스토어|naver/i.test(ch)) return 'naver';
  if (/올리브영|올영|oliveyoung/i.test(ch)) return 'oliveyoung';
  if (/메이커스|makers/i.test(ch)) return 'kakao';
  return null;
}

/* ══════════════════════════════════════════════════════════════════
 * 1차 필터 (M0) — 첨부 시점 정책
 * ════════════════════════════════════════════════════════════════ */

/**
 * @param {object|null} classified  gemini.classifySubmissionImage 결과(실패 시 null)
 * @param {string|null} expectedChannel  이 작업의 채널 key(모르면 null = 대조 생략)
 * @param {string} slotKey  'review' 외 슬롯은 1차 대상이 아니다
 * @returns {{verdict:'pass'|'warn'|'block'|'skip', code:string, message:string,
 *            channel:string, confidence:number, blockable:boolean}}
 */
function precheckPolicy({ classified, expectedChannel, slotKey = 'review' } = {}) {
  const skip = (code) => ({ verdict: 'skip', code, message: '', channel: '', confidence: 0, blockable: false });

  if (!PRECHECK_ENABLED) return skip('disabled');
  // 1차는 리뷰 슬롯만 — 영수증 슬롯은 기존 제출 시점 검수(captureVerify)가 그대로 담당한다.
  if (String(slotKey || 'review') !== 'review') return skip('not_review_slot');
  // ★ 불변식 ① — 판정 재료가 없으면 통과. AI 장애가 제출을 막는 사유가 되면 안 된다.
  if (!classified || typeof classified !== 'object') return skip('no_verdict');

  const conf = Number(classified.confidence) || 0;
  const kind = classified.kind;
  const channel = String(classified.channel || '');

  // ── 리뷰 화면이 아님 ──
  if (kind !== 'review') {
    // 영수증을 리뷰 자리에 올린 경우는 기존 슬롯 검수가 이미 다루는 영역이라
    // 여기서는 같은 말을 두 번 하지 않고 통과시킨다(중복 경고 방지).
    if (kind === 'receipt') return skip('receipt_handled_elsewhere');
    if (conf < BLOCK_CONFIDENCE) return skip('low_confidence');
    // ★ 불변식 ③ — 잠금 제외 채널의 작업은 경고까지만.
    const exempt = expectedChannel && BLOCK_EXEMPT_CHANNELS.includes(expectedChannel);
    const msg = '리뷰 화면이 아닌 것 같아요. 별점과 리뷰 내용이 함께 보이는 화면을 캡처해 주세요.';
    if (exempt || !PRECHECK_BLOCK) {
      return { verdict: 'warn', code: exempt ? 'not_review_exempt' : 'not_review_observe',
               message: msg, channel, confidence: conf, blockable: false };
    }
    return { verdict: 'block', code: 'not_review', message: msg, channel, confidence: conf, blockable: true };
  }

  // ── 리뷰는 맞는데 채널이 다름 → ★ 불변식 ② 경고까지만 ──
  //   이 작업의 채널 정보는 상품 URL 호스트로 **추정한** 값이라 우리 쪽이 틀렸을 수 있다.
  //   우리 데이터 오류로 리뷰어를 막지 않는다.
  if (expectedChannel && channel && channel !== expectedChannel && conf >= CHANNEL_WARN_CONFIDENCE) {
    return {
      verdict: 'warn', code: 'channel_mismatch',
      message: `이 작업은 ${channelLabel(expectedChannel)} 리뷰인데 ${channelLabel(channel)} 리뷰 화면으로 보여요.`,
      channel, confidence: conf, blockable: false,
    };
  }

  return {
    verdict: 'pass', code: 'ok',
    message: channel ? `${channelLabel(channel)} 리뷰 화면으로 확인했어요.` : '리뷰 화면으로 확인했어요.',
    channel, confidence: conf, blockable: false,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 2차 검수 (M1) — 제출 이후 대조
 * ════════════════════════════════════════════════════════════════ */

/** 파일 지문. base64 를 이미 쥔 시점에 계산하므로 추가 I/O 0. */
function hashBase64(b64) {
  const clean = String(b64 || '').replace(/^data:image\/[a-z]+;base64,/, '');
  if (!clean) return null;
  return crypto.createHash('sha256').update(clean).digest('hex');
}

/** 상품명 비교용 정규화 — 공백·괄호·특수문자 제거 후 소문자. */
function _normProduct(s) {
  return String(s || '').toLowerCase().replace(/[\s\[\]()（）{}·・,，/|_+~"'`]/g, '');
}

/**
 * 캡처 속 상품명 ↔ 기대 상품명 대조.
 * ★ 쇼핑몰 화면은 상품명을 줄여 쓰거나 말줄임(…)하므로 **부분 포함도 일치로 인정**한다.
 *   기대값이 없으면 'skip'(대조 안 함) — 판정 불가를 불량으로 취급하지 않는다.
 * @returns {{verdict:'pass'|'warn'|'skip', expected:string[], ocr:string}}
 */
function matchProductName(ocr, expectedList) {
  const list = (Array.isArray(expectedList) ? expectedList : [])
    .map(s => String(s || '').trim()).filter(Boolean);
  const o = _normProduct(ocr);
  if (!list.length) return { verdict: 'skip', expected: [], ocr: String(ocr || '') };
  if (!o) return { verdict: 'skip', expected: list, ocr: '' };
  for (const e of list) {
    const n = _normProduct(e);
    if (!n) continue;
    if (o.includes(n) || n.includes(o)) return { verdict: 'pass', expected: list, ocr: String(ocr) };
    // 말줄임 대비: 앞 6글자가 겹치면 같은 상품으로 본다(오탐보다 미탐을 택함)
    if (n.length >= 6 && o.length >= 6 && n.slice(0, 6) === o.slice(0, 6)) {
      return { verdict: 'pass', expected: list, ocr: String(ocr) };
    }
  }
  return { verdict: 'warn', expected: list, ocr: String(ocr) };
}

/** 항목별 판정 → 종합 status. 하나라도 fail → fail / warn 있으면 suspect / 나머지 pass. */
function computeStatus(checks) {
  const vs = Object.values(checks || {}).map(c => (c && c.verdict) || 'skip');
  if (!vs.length) return 'pending';
  if (vs.includes('fail')) return 'fail';
  if (vs.includes('warn')) return 'suspect';
  if (vs.every(v => v === 'skip')) return 'unverifiable';
  return 'pass';
}

/* ── 기대 상품명 공급 ─────────────────────────────────────────────
   ★ 우선순위: ① 탭에 직접 적어둔 값(`inspect_product_names`) → ② 연결된 작업오더.
     ①이 있으면 ②는 보지 않는다 — 관리자가 명시한 값이 항상 이긴다(시트 표기와
     작업오더 표기가 다를 때 손으로 잡는 칸이라, 자동값이 섞이면 그 의도가 무너진다). */

/** "옵션 없음"류는 상품명이 아니라 **서술**이다 — 기대값에 넣으면 아무 리뷰나 통과한다. */
const _NON_PRODUCT = /^(옵션\s*없음|없음|단일(\s*상품)?|해당\s*없음|기본|공통|-|없슴)$/;
function _isNonProduct(s) { return _NON_PRODUCT.test(String(s || '').trim()); }

/** 가격·수량 꼬리 제거 — "힙스 31400원" → "힙스", "A 28,900원" → "A" */
function _stripPriceTail(s) {
  return String(s || '')
    .replace(/결제\s*금액\s*[:：]?\s*[\d,]+\s*원?/g, ' ')
    .replace(/[\d,]{3,}\s*원/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 작업오더 → 기대 상품명 후보(순수함수).
 * ★ 후보를 넉넉히 모으는 쪽이 맞다 — 하나라도 맞으면 통과이므로, 후보가 많을수록
 *   **오탐(정상 리뷰를 의심 처리)이 줄고** 미탐만 조금 늘어난다. 이 기능의 실패 선호와 일치.
 */
function productNamesFromWorkOrder(wo) {
  const out = [];
  const push = (s) => {
    const v = _stripPriceTail(String(s || '').replace(/\|/g, '')).trim();
    if (v && v.length >= 2 && !_isNonProduct(v)) out.push(v);
  };
  if (!wo) return out;

  // ① 구조화 JSON — [{ name, base:{pay}, options:[{label,pay}] }] (프론트 _woOptionRows 와 같은 형태)
  try {
    const arr = JSON.parse(wo.product_options_json || '[]');
    if (Array.isArray(arr)) for (const p of arr) push(p && p.name);
  } catch (_) { /* 깨진 JSON 은 무시하고 아래 텍스트 경로로 */ }

  // ② 자유서술 텍스트 — 줄 단위, 구분자 앞 조각이 상품명
  //    실측 형식: "A - 옵1 - 결제금액 28,900원" / "상품A / 레드 / 12,000원" / "힙스 31400원"
  for (const line of String(wo.product_option || '').split(/[\n\r]+/)) {
    const t = line.trim();
    if (!t) continue;
    const head = t.split(/\s*[-–/|]\s*/)[0];
    push(head);
  }

  // 중복 제거(정규화 기준) — 같은 상품이 JSON·텍스트 양쪽에 있을 수 있다
  const seen = new Set();
  return out.filter(v => {
    const k = _normProduct(v);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 이 탭에 연결된 작업오더 1건. Track B 링크 우선 → work_orders.linked_tab_* 폴백.
 * ★ work_orders 는 **읽기만** 한다(Track A 승인 흐름이 linked_tab_* 를 보고 분기하므로).
 */
async function _workOrderForTab({ sheetId, tabName } = {}) {
  try {
    // ★★ 우선순위를 ORDER BY 로 **명시**한다 — 두 조건을 OR 로만 묶으면 Track B 링크가
    //   있어도 `created_at` 이 더 최근인 폴백 오더가 이긴다(실측으로 잡힘).
    //   0 = Track B 링크(명시적 지정) / 1 = work_orders.linked_tab_* 폴백.
    const { rows } = await _db().query(
      `SELECT w.title, w.product_option, w.product_options_json,
              CASE WHEN EXISTS (SELECT 1 FROM trackb_work_order_links l
                                 WHERE l.work_order_id = w.id AND l.deleted_at IS NULL
                                   AND l.sheet_id = $1 AND l.tab_name = $2)
                   THEN 0 ELSE 1 END AS link_rank
         FROM work_orders w
        WHERE w.deleted_at IS NULL
          AND ( EXISTS (SELECT 1 FROM trackb_work_order_links l
                         WHERE l.work_order_id = w.id AND l.deleted_at IS NULL
                           AND l.sheet_id = $1 AND l.tab_name = $2)
                OR (w.linked_tab_sheet_id = $1 AND w.linked_tab_name = $2) )
        ORDER BY link_rank, w.created_at DESC
        LIMIT 1`,
      [sheetId, tabName]
    );
    return rows[0] || null;
  } catch (e) {
    logger.warn(`[reviewInspect] 작업오더 조회 실패(상품명 대조 생략): ${e.message}`);
    return null;
  }
}

/** 탭 설정에서 기대 채널·기대 상품명을 읽는다. 실패는 빈 값(대조 생략). */
async function loadTabExpectations({ sheetId, tabName } = {}) {
  const out = { expectedChannel: null, productNames: [] };
  if (!sheetId || !tabName) return out;
  try {
    // ★ LATERAL 최신 1행 — 서브쿼리를 둘로 나누면 채널과 커스텀값이 서로 **다른 공고**에서
    //   올 수 있다(같은 탭에 공고가 여러 개면 실제로 갈린다). 한 행에서 둘 다 가져온다.
    const { rows } = await _db().query(
      `SELECT c.inspect_product_names, rc.channel, rc.channel_custom
         FROM tab_configs c
         LEFT JOIN LATERAL (
              SELECT channel, channel_custom
                FROM recruit_campaigns
               WHERE linked_sheet_id = c.sheet_id AND linked_tab_name = c.tab_name
               ORDER BY created_at DESC
               LIMIT 1
         ) rc ON TRUE
        WHERE c.sheet_id = $1 AND c.tab_name = $2
        LIMIT 1`,
      [sheetId, tabName]
    );
    const r = rows[0];
    if (!r) return out;
    const ch = r.channel === '직접입력' ? (r.channel_custom || '') : (r.channel || '');
    out.expectedChannel = expectedChannelKey(ch);
    out.productNames = String(r.inspect_product_names || '')
      .split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
    if (out.productNames.length) { out.productSource = 'manual'; return out; }

    // 직접 적어둔 값이 없으면 연결된 작업오더에서 파생한다
    const wo = await _workOrderForTab({ sheetId, tabName });
    const derived = productNamesFromWorkOrder(wo);
    if (derived.length) { out.productNames = derived; out.productSource = 'work_order'; }
  } catch (e) {
    logger.warn(`[reviewInspect] 탭 기대값 조회 실패(대조 생략): ${e.message}`);
  }
  return out;
}

/** 관리자 화면용 — 이 탭의 기대 상품명 현황(수동값 + 작업오더 파생값을 함께 보여준다). */
async function productNameSettings({ sheetId, tabName } = {}) {
  const out = { manual: '', derived: [], effective: [], source: 'none' };
  try {
    const { rows } = await _db().query(
      'SELECT inspect_product_names FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [sheetId, tabName]
    );
    out.manual = String(rows[0]?.inspect_product_names || '');
    out.derived = productNamesFromWorkOrder(await _workOrderForTab({ sheetId, tabName }));
    const manualList = out.manual.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
    if (manualList.length) { out.effective = manualList; out.source = 'manual'; }
    else if (out.derived.length) { out.effective = out.derived; out.source = 'work_order'; }
  } catch (e) {
    logger.warn(`[reviewInspect] 기대 상품명 조회 실패: ${e.message}`);
  }
  return out;
}

/** 탭별 기대 상품명 저장(줄바꿈 구분). 빈 값 = 해제(작업오더 파생으로 되돌아간다). */
async function saveProductNames({ sheetId, tabName, text } = {}) {
  const v = String(text == null ? '' : text)
    .split(/[\n\r]+/).map(s => s.trim()).filter(Boolean).slice(0, 20).join('\n').slice(0, 2000);
  await _db().query(
    'UPDATE tab_configs SET inspect_product_names = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
    [v, sheetId, tabName]
  );
  return v;
}

/**
 * 같은 파일 지문이 **다른 사람·다른 자리**에 이미 있는가.
 * ★ 같은 (시트·탭·행·리뷰어)의 재업로드는 중복이 아니다 — Drive 는 재업로드마다
 *   새 file_id 를 만들므로, 이걸 중복으로 잡으면 정상적인 재제출이 전부 불량이 된다.
 */
async function findDuplicate({ fileHash, fileId, sheetId, tabName, rowIndex, reviewerName } = {}) {
  if (!fileHash) return { verdict: 'skip' };
  try {
    const { rows } = await _db().query(
      `SELECT file_id, sheet_id, tab_name, row_index, reviewer_name, uploaded_at
         FROM review_submissions
        WHERE file_hash = $1
          AND file_id <> COALESCE($2, '')
          AND NOT (sheet_id = $3 AND tab_name = $4
                   AND COALESCE(row_index, -1) = COALESCE($5::int, -1)
                   AND COALESCE(reviewer_name, '') = COALESCE($6, ''))
        ORDER BY uploaded_at ASC NULLS LAST
        LIMIT 1`,
      [fileHash, fileId || null, sheetId, tabName, rowIndex ?? null, reviewerName || '']
    );
    if (!rows.length) return { verdict: 'pass' };
    const m = rows[0];
    return {
      verdict: 'fail',
      matchFileId: m.file_id, matchTab: m.tab_name,
      matchReviewer: m.reviewer_name || '', matchRow: m.row_index,
      matchAt: m.uploaded_at,
    };
  } catch (e) {
    logger.warn(`[reviewInspect] 중복 대조 실패(통과 처리): ${e.message}`);
    return { verdict: 'skip' };
  }
}

/**
 * 본문 텍스트 겹침 — 같은 탭 안에서만 비교(기본).
 *
 * ★★ 판정식이 `similarity` 단독이 아닌 이유 (로컬 PG16 실측):
 *   가장 흔한 복붙 수법은 **남의 리뷰를 그대로 붙이고 문장 한두 개를 덧붙이는 것**인데,
 *   trigram `similarity` 는 길이가 벌어지면 급격히 떨어져 이걸 놓친다.
 *     원문 + 한 문장 추가 → 0.859 / 두 문장 추가 → 0.718  (둘 다 0.9 기준을 빠져나감)
 *   `word_similarity` 는 "한쪽이 다른 쪽의 연속 구간에 들어있는가"를 재므로 둘 다 1.000 으로 잡는다.
 *
 * ★ 다만 word_similarity 만 쓰면 **짧은 관용구가 긴 리뷰에 통째로 들어있을 때** 1.000 이 나온다
 *   (실측: 27자 관용구 ⊂ 94자 리뷰 → 1.000). 그래서 **길이비 가드**를 둔다 —
 *   두 글의 길이가 비슷할 때(기본 0.5 이상)만 word_similarity 를 쓰고, 아니면 similarity 만 본다.
 *     위 오탐 케이스는 길이비 0.29 → 0.298 로 떨어져 걸리지 않고,
 *     복붙+추가(길이비 0.85·0.71)는 1.000 을 유지한다.
 *
 * ★ 짧은 글은 애초에 비교하지 않는다: "맛있어요 재구매의사 있습니다" 같은 관용구는
 *   누구나 비슷해 오탐이 된다.
 */
async function findSimilarText({ text, fileId, sheetId, tabName } = {}) {
  const t = String(text || '').trim();
  if (t.length < MIN_TEXT) return { verdict: 'skip', reason: 'too_short' };
  try {
    const { rows } = await _db().query(
      `SELECT file_id, reviewer_name, row_index,
              CASE WHEN LEAST(length(ocr_text), length($1))::numeric
                        / GREATEST(length(ocr_text), length($1)) >= $6
                   THEN GREATEST(similarity(ocr_text, $1),
                                 word_similarity(ocr_text, $1),
                                 word_similarity($1, ocr_text))
                   ELSE similarity(ocr_text, $1)
              END AS score
         FROM review_inspections
        WHERE sheet_id = $2 AND tab_name = $3
          AND file_id <> COALESCE($4, '')
          AND ocr_text IS NOT NULL AND length(ocr_text) >= $5
        ORDER BY score DESC
        LIMIT 1`,
      [t, sheetId, tabName, fileId || null, MIN_TEXT, SIM_LEN_RATIO]
    );
    const top = rows[0];
    if (!top || !(Number(top.score) >= SIM_THRESHOLD)) {
      return { verdict: 'pass', score: top ? Number(top.score) : 0, scope: 'tab' };
    }
    return {
      verdict: 'warn', score: Number(top.score), scope: 'tab',
      matchFileId: top.file_id, matchReviewer: top.reviewer_name || '', matchRow: top.row_index,
    };
  } catch (e) {
    logger.warn(`[reviewInspect] 유사도 대조 실패(통과 처리): ${e.message}`);
    return { verdict: 'skip' };
  }
}

/**
 * 파일 1장의 2차 검수 — 판정 후 review_inspections 에 업서트.
 * ★ 절대 throw 하지 않는다: 업로드는 이미 끝난 뒤의 후처리라, 여기서 예외가 오르면
 *   "파일은 올라갔는데 제출이 실패"로 보이는 사고가 난다(csBridge 와 같은 규율).
 */
async function inspectSubmission({
  base64, mimeType, fileId, fileHash, sheetId, tabName, rowIndex, reviewerName, slotKey = 'review',
} = {}) {
  if (!ENABLED || !fileId || !sheetId || !tabName) return null;
  try {
    const hash = fileHash || hashBase64(base64);

    // 리뷰 슬롯이 아니면 형식 판정만 남기고 끝낸다(영수증엔 상품명·본문 대조가 무의미).
    const isReview = String(slotKey || 'review') === 'review';

    let cls = null;
    if (base64) {
      try {
        // ★ 첨부 시점 1차 필터가 이미 같은 이미지를 판정했다면 캐시 히트 = AI 콜 0
        const { classifySubmissionImage } = require('./gemini.service');
        cls = await classifySubmissionImage(base64, mimeType || 'image/jpeg');
      } catch (_) { cls = null; }   // fail-open
    }

    const checks = {};
    const exp = isReview ? await loadTabExpectations({ sheetId, tabName }) : { expectedChannel: null, productNames: [] };

    // ① 형식·채널
    if (!cls) {
      checks.format = { verdict: 'skip', reason: 'no_ai' };
    } else if (isReview && cls.kind !== 'review' && cls.confidence >= BLOCK_CONFIDENCE) {
      checks.format = { verdict: 'fail', kind: cls.kind, confidence: cls.confidence };
    } else {
      checks.format = {
        verdict: (exp.expectedChannel && cls.channel && cls.channel !== exp.expectedChannel) ? 'warn' : 'pass',
        kind: cls.kind, channel: cls.channel || '', expectedChannel: exp.expectedChannel || '',
        confidence: cls.confidence,
      };
    }

    // ② 상품명 (리뷰 슬롯만)
    checks.product = isReview
      ? matchProductName(cls && cls.productName, exp.productNames)
      : { verdict: 'skip' };

    // ③ 같은 파일 — 슬롯 무관(영수증 재탕도 잡을 값어치가 있다)
    checks.duplicate = await findDuplicate({
      fileHash: hash, fileId, sheetId, tabName, rowIndex, reviewerName,
    });

    // ④ 본문 겹침 (리뷰 슬롯만)
    checks.similarity = isReview
      ? await findSimilarText({ text: cls && cls.reviewText, fileId, sheetId, tabName })
      : { verdict: 'skip' };

    // ⑤ 작성자 — 수집만, 판정하지 않는다(마스킹·닉네임이라 실명 대조 불가)
    checks.author = { verdict: 'skip', ocr: (cls && cls.authorMask) || '' };

    const status = computeStatus(checks);
    await _upsertInspection({
      fileId, sheetId, tabName, rowIndex, reviewerName, slotKey, status, checks,
      channel: (cls && cls.channel) || null, device: (cls && cls.device) || null,
      ocrProduct: (cls && cls.productName) || null,
      ocrText: (cls && cls.reviewText) || null,
      ocrAuthor: (cls && cls.authorMask) || null,
      fileHash: hash, confidence: (cls && cls.confidence) || null,
    });
    return { status, checks };
  } catch (e) {
    logger.warn(`[reviewInspect] 검수 실패(무시): ${e.message}`);
    return null;
  }
}

async function _upsertInspection(p) {
  try {
    await _db().query(
      `INSERT INTO review_inspections
         (file_id, sheet_id, tab_name, row_index, reviewer_name, slot_key, status, checks,
          channel, device, ocr_product, ocr_text, ocr_author, file_hash, ai_confidence,
          inspected_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
       ON CONFLICT (file_id) DO UPDATE
          SET status = EXCLUDED.status, checks = EXCLUDED.checks,
              channel = EXCLUDED.channel, device = EXCLUDED.device,
              ocr_product = EXCLUDED.ocr_product, ocr_text = EXCLUDED.ocr_text,
              ocr_author = EXCLUDED.ocr_author, file_hash = EXCLUDED.file_hash,
              ai_confidence = EXCLUDED.ai_confidence,
              row_index = EXCLUDED.row_index, reviewer_name = EXCLUDED.reviewer_name,
              inspected_at = NOW(), updated_at = NOW(),
              attempts = review_inspections.attempts + 1`,
      [p.fileId, p.sheetId, p.tabName, p.rowIndex ?? null, p.reviewerName || null, p.slotKey || 'review',
       p.status, JSON.stringify(p.checks || {}), p.channel, p.device, p.ocrProduct, p.ocrText,
       p.ocrAuthor, p.fileHash, p.confidence]
    );
  } catch (e) {
    logger.warn(`[reviewInspect] 판정 기록 실패(무시): ${e.message}`);
  }
}

/** 제출 원장에 파일 지문 기록(중복 대조의 재료). 실패해도 업로드엔 영향 없음. */
async function saveFileHash({ fileId, fileHash } = {}) {
  if (!fileId || !fileHash) return;
  try {
    await _db().query('UPDATE review_submissions SET file_hash = $1 WHERE file_id = $2', [fileHash, fileId]);
  } catch (e) {
    logger.warn(`[reviewInspect] 지문 기록 실패(무시): ${e.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 관리자 검수 탭(M3) 조회
 * ════════════════════════════════════════════════════════════════ */

const _LIST_STATUSES = ['pending', 'pass', 'suspect', 'fail', 'unverifiable', 'resolved'];

/**
 * 검수 목록. 기본은 **손볼 것만**(의심+불량) — 통과 건까지 나열하면 정작 볼 게 묻힌다.
 * @param status 'open'(기본, suspect+fail) | 'all' | 개별 status
 */
async function listInspections({ sheetId, tabName, status = 'open', limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (sheetId) { params.push(sheetId); where.push(`i.sheet_id = $${params.length}`); }
  if (tabName) { params.push(tabName); where.push(`i.tab_name = $${params.length}`); }
  if (status === 'open') {
    where.push(`i.status IN ('suspect','fail')`);
  } else if (status !== 'all' && _LIST_STATUSES.includes(status)) {
    params.push(status); where.push(`i.status = $${params.length}`);
  }
  params.push(Math.min(Number(limit) || 200, 500));
  const { rows } = await _db().query(
    `SELECT i.id, i.file_id, i.sheet_id, i.tab_name, i.row_index, i.reviewer_name, i.slot_key,
            i.status, i.checks, i.channel, i.ocr_product, i.ocr_text, i.ai_confidence,
            i.inspected_at, i.resolved_at, i.resolved_by, i.created_at,
            s.file_url, s.file_name
       FROM review_inspections i
       LEFT JOIN review_submissions s ON s.file_id = i.file_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE i.status WHEN 'fail' THEN 0 WHEN 'suspect' THEN 1 ELSE 2 END,
               i.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** 탭별 검수 현황 집계(상단 요약 + nav 뱃지). */
async function inspectionSummary({ sheetId, tabName } = {}) {
  const where = [];
  const params = [];
  if (sheetId) { params.push(sheetId); where.push(`sheet_id = $${params.length}`); }
  if (tabName) { params.push(tabName); where.push(`tab_name = $${params.length}`); }
  const { rows } = await _db().query(
    `SELECT status, COUNT(*)::int AS c FROM review_inspections
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY status`,
    params
  );
  const out = { pass: 0, suspect: 0, fail: 0, pending: 0, unverifiable: 0, resolved: 0, open: 0 };
  for (const r of rows) if (out[r.status] !== undefined) out[r.status] = r.c;
  out.open = out.suspect + out.fail;
  return out;
}

/**
 * 관리자 확인 종결. ★ 원판정(checks)은 지우지 않는다 — 나중에 "왜 통과시켰나"를
 * 되짚을 수 있어야 기준을 고칠 수 있다(오탐 누적이 임계값 조정의 근거다).
 */
async function resolveInspection({ fileId, by } = {}) {
  const { rowCount } = await _db().query(
    `UPDATE review_inspections
        SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, updated_at = NOW()
      WHERE file_id = $1 AND status <> 'resolved'`,
    [fileId, by || '']
  );
  return { ok: true, resolved: rowCount || 0 };
}

/** 한 건의 스코프 판정용 — 그 파일이 어느 (시트,탭)인지. */
async function inspectionScope(fileId) {
  const { rows } = await _db().query(
    'SELECT sheet_id, tab_name FROM review_inspections WHERE file_id = $1 LIMIT 1', [fileId]
  );
  return rows[0] || null;
}

module.exports = {
  precheckPolicy, expectedChannelKey, channelLabel,
  productNamesFromWorkOrder, productNameSettings, saveProductNames,
  listInspections, inspectionSummary, resolveInspection, inspectionScope,
  hashBase64, matchProductName, computeStatus,
  loadTabExpectations, findDuplicate, findSimilarText,
  inspectSubmission, saveFileHash,
  ENABLED, PRECHECK_ENABLED, PRECHECK_BLOCK,
  BLOCK_CONFIDENCE, SIM_THRESHOLD, MIN_TEXT, SIM_LEN_RATIO, BLOCK_EXEMPT_CHANNELS,
  __setPoolForTest,
};
