/**
 * campaignFee.js — 캠페인 기간별 리뷰비 판정 **단일 출처**(migration 082).
 *
 * 배경: 리뷰비가 공고당 한 칸(recruit_campaigns.review_fee)이라, 8월에 금액을 올리면
 *   7월 참여자의 과거 카드·누적 합계까지 바뀌어 문의가 발생했다.
 *
 * 규칙(완화 금지):
 *   ① 스냅샷이 있으면 **무조건 스냅샷** — 참여 시점에 리뷰어가 본 금액이 진실.
 *      "구간표가 더 최신이니까"로 덮어쓰면 막으려던 사고가 그대로 재현된다.
 *   ② 스냅샷이 없으면 그 건의 **참여(구매)일**로 구간표를 조회(사용자 확정 Q1).
 *      → 과거 데이터도 구간만 등록하면 자동 정정된다(수기 정정 불필요).
 *   ③ 구간이 0개이거나 첫 구간보다 이른 날짜면 **기존 review_fee 폴백** = 지금 동작 그대로.
 *
 * ★ 표시 규칙을 화면마다 따로 만들면 "카드는 1,000원인데 합계는 1,500원"으로 갈라진다 —
 *   소비처(리뷰 내역 API·공고 카드·목록)는 전부 이 파일만 부른다.
 *
 * 킬스위치: CAMPAIGN_FEE_SCHEDULE=0 → 구간표를 통째로 무시(전건 기존 review_fee).
 */
const { parseDateToken, inferYear, isValidYmd, toIso } = require('./koreanDate');

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function scheduleEnabled() {
  return process.env.CAMPAIGN_FEE_SCHEDULE !== '0';
}

/** 숫자 정규화 — **빈 값(null·undefined·'')은 반드시 null**.
 *  ★ Number(null)===0, Number('')===0 이라 이 가드가 없으면
 *    "스냅샷 없음(DB NULL)"과 "빈 금액 칸"이 조용히 **0원**이 된다(무상 처리 사고). */
function _int(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** KST 기준 오늘(YYYY-MM-DD). 서버가 UTC로 돌아도 한국 날짜로 판정해야 구간 경계가 맞는다. */
function kstDateStr(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** TIMESTAMPTZ/Date → KST 날짜 문자열. 값이 없으면 null. */
function toKstDate(v) {
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return kstDateStr(d);
}

/**
 * 시트 '구매일자' 원문(`7 / 18 (금)`·`26.7.28(화)` 등) → 'YYYY-MM-DD'.
 * 연도 없는 표기가 흔하므로 앵커(공고 시작일 또는 오늘)로 연도를 추론한다.
 * 판정 실패는 null(=미적용 폴백) — 억지로 날짜를 만들어 엉뚱한 구간에 넣지 않는다.
 */
function sheetDateToIso(raw, anchorIso) {
  const t = parseDateToken(raw);
  if (!t) return null;
  if (t.y != null) return isValidYmd(t.y, t.m, t.d) ? toIso(t.y, t.m, t.d) : null;
  const a = YMD.test(String(anchorIso || '')) ? String(anchorIso) : kstDateStr();
  const y = inferYear(t.m, t.d, { y: Number(a.slice(0, 4)), m: Number(a.slice(5, 7)) });
  return y ? toIso(y, t.m, t.d) : null;
}

/**
 * 입력 배열 → 정규화 구간 목록(시작일 오름차순).
 * 잘못된 줄(날짜 형식 오류·금액 음수·빈 값)은 **버린다**. 같은 날짜가 겹치면 뒤엣것이 이긴다
 * (DB UNIQUE 가 최종 방어지만, 저장 전에 조용히 500이 나지 않도록 여기서 접는다).
 */
function normalizeFeeSchedules(arr) {
  if (!Array.isArray(arr)) return null;      // 미전달 = 변경 없음(옵션표와 같은 계약)
  const byDate = new Map();
  for (const r of arr) {
    if (!r) continue;
    const from = String(r.effectiveFrom ?? r.effective_from ?? r.from ?? '').trim();
    if (!YMD.test(from)) continue;
    const fee = _int(r.reviewFee ?? r.review_fee ?? r.fee);
    if (fee == null) continue;
    byDate.set(from, {
      effectiveFrom: from,
      reviewFee: fee,
      memo: String(r.memo ?? '').trim().slice(0, 200),
    });
  }
  return [...byDate.values()].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

/**
 * 그 날짜에 적용되는 구간. 시작일이 dateStr 이하인 것 중 **가장 늦은** 구간.
 * 첫 구간보다 이르면 null(=폴백).
 */
function feeAtDate(schedules, dateStr) {
  if (!scheduleEnabled()) return null;
  if (!Array.isArray(schedules) || !schedules.length) return null;
  if (!YMD.test(String(dateStr || ''))) return null;
  let hit = null;
  for (const s of schedules) {
    if (!s || !YMD.test(String(s.effectiveFrom || ''))) continue;
    if (s.effectiveFrom <= dateStr) hit = s;
    else break;                              // 오름차순 정렬 전제
  }
  return hit;
}

/**
 * 한 건의 리뷰비를 정한다.
 *
 * @param {object[]} schedules  normalizeFeeSchedules 결과(정렬됨). 없으면 폴백만.
 * @param {number}   fallback   recruit_campaigns.review_fee (기존 값)
 * @param {number}   snapshot   참여 시점에 새긴 금액(있으면 최우선)
 * @param {string}   joinDate   참여(홀드)일 'YYYY-MM-DD'
 * @param {string}   orderDate  주문 제출일 'YYYY-MM-DD'
 * @param {string}   sheetDate  시트 구매일자 'YYYY-MM-DD'
 * @param {string}   today      기준 오늘(미지정 시 KST 오늘)
 * @returns {{fee:number, source:string, basis:(string|null)}}
 *   source: snapshot | schedule | fallback_before_first | fallback
 */
function resolveReviewFee(opts) {
  const o = opts || {};
  const fallback = _int(o.fallback) || 0;

  const snap = _int(o.snapshot);
  if (snap != null) return { fee: snap, source: 'snapshot', basis: null };

  const schedules = Array.isArray(o.schedules) ? o.schedules : [];
  if (!schedules.length || !scheduleEnabled()) {
    return { fee: fallback, source: 'fallback', basis: null };
  }

  const basis = [o.joinDate, o.orderDate, o.sheetDate, o.today || kstDateStr()]
    .map(v => (YMD.test(String(v || '')) ? String(v) : null))
    .find(Boolean) || kstDateStr();

  const hit = feeAtDate(schedules, basis);
  if (!hit) return { fee: fallback, source: 'fallback_before_first', basis };
  return { fee: hit.reviewFee, source: 'schedule', basis };
}

/** 공고 카드·목록에 보일 "오늘 기준 리뷰비". 구간 없으면 기존 값 그대로. */
function currentReviewFee(schedules, fallback, now = new Date()) {
  return resolveReviewFee({ schedules, fallback, today: kstDateStr(now) }).fee;
}

module.exports = {
  scheduleEnabled, kstDateStr, toKstDate, sheetDateToIso,
  normalizeFeeSchedules, feeAtDate, resolveReviewFee, currentReviewFee,
};
