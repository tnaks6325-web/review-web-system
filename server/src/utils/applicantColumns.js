/**
 * applicantColumns.js — 레거시 공고 참여자 행의 열 찾기 (단일 출처)
 *
 * 레거시(참여형 아님) 공고는 카톡 신청으로 참여가 확정되면 그 작업의 명단에 한 줄이 추가된다.
 * 종전에는 그 한 줄을 **구글시트에 직접**(`appendSheet`) 썼는데, 이관된 작업(sheetless)에서는
 * 그 시트를 아무도 읽지 않으므로 **작업표**로 가야 한다.
 *
 * ★★ 두 경로(시트 append · 작업표 기록)가 **같은 열 판정**을 써야 한다 —
 *    사본을 두면 "시트 작업은 연락처가 들어가는데 이관된 작업은 빈칸"처럼 조용히 갈린다.
 * ★ 이 판정은 `campaign.routes.js` 에서 이관한 것이라 별칭 목록·매칭 방식(`includes`)이
 *   그때와 **한 글자도 다르지 않다**(무회귀). 회귀가드가 두 소비처의 사용을 고정한다.
 * ★ campaign.routes.js 는 의도된 NUL(복합키 구분자)이 있어 grep 가드를 걸 수 없다 —
 *   그래서 판정을 이 파일로 빼서 가드가 붙을 자리를 만든다.
 */

// 헤더 행 감지 키워드(2개 이상 맞으면 그 줄이 헤더)
const HEADER_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호', '아이디', '주소'];

const NAME_ALIASES  = ['수취인', '수취인명', '주문자', '성함', '이름', '성명', '신청자'];
const PHONE_ALIASES = ['연락처', '전화번호', '전번뒷자리', '핸드폰', '휴대폰'];
const INAD_ALIASES  = ['인애드', '인애드명', '인애드제출', '카톡', '카카오', '닉네임'];
const NUM_ALIASES   = ['번호', 'No', 'NO', 'no'];

/** 헤더 배열에서 별칭이 처음 걸리는 열 번호(없으면 -1). 매칭은 부분일치(`includes`) — 종전 그대로. */
function findCol(headerRow, aliases) {
  const hs = (headerRow || []).map(h => String(h == null ? '' : h).trim());
  for (const alias of aliases) {
    const idx = hs.findIndex(h => h.includes(alias));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** 이름/연락처/인애드/번호 열을 한 번에. `name` 이 없으면 그 명단에 사람을 넣을 수 없다. */
function resolveApplicantColumns(headerRow) {
  return {
    name: findCol(headerRow, NAME_ALIASES),
    phone: findCol(headerRow, PHONE_ALIASES),
    inad: findCol(headerRow, INAD_ALIASES),
    num: findCol(headerRow, NUM_ALIASES),
  };
}

/** 헤더 후보 줄인지(키워드 2개 이상) — 시트 상단 메타·공지 줄을 헤더로 오인하지 않게. */
function isApplicantHeaderRow(cells) {
  const cs = (cells || []).map(c => String(c == null ? '' : c).trim());
  let hit = 0;
  for (const kw of HEADER_KEYWORDS) {
    if (cs.some(c => c.includes(kw))) { hit++; if (hit >= 2) return true; }
  }
  return false;
}

module.exports = {
  HEADER_KEYWORDS, NAME_ALIASES, PHONE_ALIASES, INAD_ALIASES, NUM_ALIASES,
  findCol, resolveApplicantColumns, isApplicantHeaderRow,
};
