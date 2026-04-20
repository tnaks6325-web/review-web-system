/* ══════════════════════════════════════════
   config.js – 앱 설정 (v2) [인라인]
══════════════════════════════════════════ */

// ★ 부트스트랩 GAS URL
// 관리자가 최초 1회 여기에 GAS 웹앱 URL을 입력하면
// 이후 모든 접속자가 자동으로 동일한 URL을 사용합니다.
// saveGasUrl() 실행 시 GAS PropertiesService에도 저장되어
// 다음 접속자는 GAS에서 자동으로 URL을 가져옵니다.
// ★ [Node.js 이관] GAS URL → API_BASE_URL 대체
const BOOTSTRAP_GAS_URL = typeof API_BASE_URL !== "undefined" ? API_BASE_URL : "http://localhost:3000";

const DEFAULT_CONFIG = {
  GAS_WEB_APP_URL: BOOTSTRAP_GAS_URL,
  BASE_SHEET_ID: "1YW2KgPo-fvwBUS1nuzWTutqE_n2RVAnHPXXYVn4o2i4",
  BASE_SHEET_GID: "240447267",
  COL_ALIASES: {
    orderer:    ["주문자", "성함"],
    recipient:  ["수취인", "수취인명"],
    depositor:  ["예금주"],
    userId:     ["아이디", "ID", "id"],
    phone:      ["연락처", "전화번호", "전번뒷자리"],
    option:     ["옵션션", "옵션", "상품옵션"],
    product:    ["상품"],
    store:      ["스토어"],
    orderDate:  ["구매날짜", "날짜"],
    orderNum:   ["번호", "주문번호"],
    round:      ["차수"],
    reviewDone: ["리뷰작성", "리뷰", "리뷰제출여부", "리뷰제출"],
  },
  SUBMITTED_VALUES: ["TRUE", "true", "1", "제출", "O", "o", "완료", "Y", "y"],
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  ALLOWED_MIME: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  VERSION: "2.0.0"
};

const APP_CONFIG = (() => {
  let stored = {};
  try {
    const raw = localStorage.getItem("rapp_cfg");
    if (raw) stored = JSON.parse(raw);
  } catch (_) {}
  const cfg = Object.assign({}, DEFAULT_CONFIG, stored);
  // ★ BOOTSTRAP_GAS_URL이 하드코딩된 경우 항상 우선 적용
  //    (localStorage 값이 달라도 코드에 박힌 URL 사용)
  if (BOOTSTRAP_GAS_URL) cfg.GAS_WEB_APP_URL = BOOTSTRAP_GAS_URL;
  return cfg;
})();

function saveConfig(patch) {
  Object.assign(APP_CONFIG, patch);
  try { localStorage.setItem("rapp_cfg", JSON.stringify(APP_CONFIG)); } catch (_) {}
}

function resolveCol(headers, aliases) {
  for (const a of aliases) {
    if (headers.includes(a)) return a;
  }
  return null;
}
