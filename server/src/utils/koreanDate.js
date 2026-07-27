/**
 * koreanDate.js — 시트에 실제로 쓰이는 한국식 날짜 표기를 'YYYY-MM-DD'로 정규화.
 *
 * 실측(어니스트캄 업무시트 '구매일자' 컬럼): 한 컬럼에 두 형식이 섞여 있다.
 *   '7 / 23 (목)'  — 연도 없음, 슬래시, 공백 포함
 *   '26.7.28(화)'  — 두 자리 연도, 점 구분
 * 그래서 토큰 파싱과 "연도 추론"을 분리한다. 연도 없는 표기는 같은 컬럼에서 연도가
 * 확정된 가장 가까운 날짜를 앵커로 삼아 추론하며, 연말연초 경계(12월↔1월)를 보정한다.
 *
 * ★ 판정 실패는 항상 null(=날짜 아님)로 떨어뜨린다. 캠페인 일정 파생은 이 값이
 *   충분히 모였을 때만 활성화되므로, 못 읽는 표기가 섞여도 오작동이 아니라 미적용이 된다.
 */

/** 요일 괄호·꼬리 시각·한글 년월일을 제거해 숫자 구분자 형태로 정규화 */
function _stripDecor(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\([^)]*\)/g, ' ')                      // (금) (화) 등 요일 괄호
    .replace(/\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/, '')  // 뒤쪽 시각 HH:MM[:SS]
    .replace(/\s*[년월]\s*/g, '.')                    // 2026년 7월 → 2026.7.
    .replace(/\s*일\s*$/, '')                        // …24일 → …24
    .trim();
}

/** 실제 존재하는 날짜인지(2/30 같은 값 차단) */
function isValidYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toIso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 한 칸을 토큰으로 파싱. 연도를 못 정하면 { y: null, m, d }로 반환(추론은 호출부).
 * 지원: YYYY-M-D / YYYY.M.D / YYYY/M/D, YY.M.D(2000+YY), M/D · M.D(연도 미상),
 *       '2026년 7월 24일', 구글시트 일련번호(40000~60000).
 */
function parseDateToken(raw) {
  const s = _stripDecor(raw);
  if (!s) return null;

  // 순수 숫자 = 구글시트 일련번호만 날짜로 인정(번호 컬럼 값이 날짜로 오인되지 않게 범위 제한)
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 40000 && n < 60000) {
      const dt = new Date(Math.round((n - 25569) * 86400000));
      if (!isNaN(dt.getTime())) {
        return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
      }
    }
    return null;
  }

  const parts = s.split(/\s*[.\-/]\s*/).filter(p => p !== '');
  if (!parts.every(p => /^\d{1,4}$/.test(p))) return null;
  const nums = parts.map(Number);

  if (nums.length === 3) {
    const [a, b, c] = nums;
    const y = a >= 1000 ? a : (a <= 99 ? 2000 + a : null);   // '26.7.28' → 2026
    if (y === null) return null;
    return isValidYmd(y, b, c) ? { y, m: b, d: c } : null;
  }
  if (nums.length === 2) {
    const [m, d] = nums;
    // 연도 미상. 2000년(윤년)으로 월·일 범위만 검증 — 2/29도 살려둔다.
    return isValidYmd(2000, m, d) ? { y: null, m, d } : null;
  }
  return null;
}

/**
 * 연도 미상 토큰의 연도 추론. 앵커와 6개월 넘게 벌어지면 해가 바뀐 것으로 본다.
 * (앵커 1월 · 값 12월 → 전년 / 앵커 12월 · 값 1월 → 익년)
 */
function inferYear(m, d, anchor) {
  if (!anchor || !Number.isInteger(anchor.y)) return null;
  const diff = m - anchor.m;
  let y = anchor.y;
  if (diff > 6) y -= 1;
  else if (diff < -6) y += 1;
  return isValidYmd(y, m, d) ? y : null;
}

/**
 * 한 컬럼(열) 전체를 2패스로 정규화한다.
 *   1패스: 연도가 확정된 토큰을 앵커로 수집
 *   2패스: 연도 미상 토큰을 "인덱스상 가장 가까운 앵커"로 추론
 * 앵커가 하나도 없으면 opts.fallbackAnchor({y,m})로 추론한다(없으면 전부 null).
 *
 * @param {string[]} values  열의 셀 값들(빈 칸 포함, 순서 유지)
 * @returns {(string|null)[]} 같은 길이의 'YYYY-MM-DD' | null 배열
 */
function parseDateColumn(values, opts = {}) {
  const toks = (values || []).map(parseDateToken);
  const anchors = [];
  toks.forEach((t, i) => { if (t && t.y != null) anchors.push({ i, y: t.y, m: t.m }); });

  return toks.map((t, i) => {
    if (!t) return null;
    if (t.y != null) return toIso(t.y, t.m, t.d);
    let best = null;
    let bestDist = Infinity;
    for (const a of anchors) {
      const dist = Math.abs(a.i - i);
      if (dist < bestDist) { bestDist = dist; best = a; }
    }
    if (!best) best = opts.fallbackAnchor || null;
    const y = best ? inferYear(t.m, t.d, best) : null;
    return y ? toIso(y, t.m, t.d) : null;
  });
}

module.exports = { parseDateToken, parseDateColumn, inferYear, isValidYmd, toIso };
