/**
 * workManager.js — 작업오더 "작업담당" 해석의 **단일 출처**(migration 065).
 *
 * 인트라넷 작업오더 표기:
 *   ▶ 담당AE   : 이만수
 *   ▶ 작업담당 : 박세희 / 박은비 / 랜덤
 *
 * 리뷰웹의 담당자는 닉네임(만두/망고)이라 그대로 쓸 수 없다. 매핑은 여기 하나뿐이며
 * 소비처는 ① 작업오더 접수 시 캠페인 탭 담당자 기입 ② 모집공고 발행 프리필(프론트 사본)
 * 두 곳이다. 두 곳이 어긋나면 "탭 담당자는 만두인데 공고 담당자는 빈칸"이 된다.
 *
 * ★ 랜덤은 빈 문자열을 돌려준다 — 자동으로 아무나 고르면 안 되고 관리자가 정해야 한다.
 *   (모르는 이름도 같은 이유로 빈 문자열 = fail-safe. 원문은 화면에 그대로 보여준다.)
 */

/** 실명 → 리뷰웹 담당자 닉네임 */
const WORK_MANAGER_MAP = {
  '박세희': '만두',
  '박은비': '망고',
};

/** 자동 선택하지 않고 관리자가 정해야 하는 값(인트라넷 표기 그대로) */
const UNDECIDED = ['랜덤', '랜덤배정', '미정'];

/** 공백·구분자 제거 — "박 세희", "박세희(만두)" 같은 표기 흔들림 흡수 */
function _norm(v) {
  return String(v || '').replace(/\s+/g, '').replace(/[()（）[\]]/g, '');
}

/**
 * 작업담당 원문 → 리뷰웹 담당자 닉네임.
 * @returns {string} '만두' | '망고' | '' (빈 문자열 = 직접결정)
 */
function mapWorkManager(raw) {
  const v = _norm(raw);
  if (!v) return '';
  for (const [name, nick] of Object.entries(WORK_MANAGER_MAP)) {
    if (v.includes(name)) return nick;
  }
  // 이미 닉네임으로 온 경우도 인정(인트라넷이 나중에 닉네임을 보내도 동작)
  for (const nick of Object.values(WORK_MANAGER_MAP)) {
    if (v.includes(nick)) return nick;
  }
  return '';
}

/** 관리자가 직접 정해야 하는 값인가(랜덤 등) */
function isUndecidedWorkManager(raw) {
  const v = _norm(raw);
  return !!v && UNDECIDED.some(u => v.includes(u));
}

/**
 * 화면 표시용 라벨. 예) '박세희' → '박세희 (만두)' · '랜덤' → '랜덤 (직접결정)'
 * 매핑되지 않는 이름은 원문만 보여준다(임의 해석 금지).
 */
function workManagerLabel(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (isUndecidedWorkManager(v)) return `${v} (직접결정)`;
  const nick = mapWorkManager(v);
  return nick ? `${v} (${nick})` : v;
}

/**
 * 인트라넷 payload에서 작업담당 값을 꺼낸다.
 * 표준 키는 `work_manager`. 다른 이름으로 와도 받아들이되(계약 흔들림 흡수),
 * 어디에도 없으면 본문 텍스트의 "작업담당 : X" 표기에서 마지막으로 찾는다.
 */
function pickWorkManager(body = {}) {
  const direct = body.work_manager || body.worker || body.work_staff || body['작업담당'];
  if (direct) return String(direct).trim();
  const text = [body.special_notes, body.review_guide, body.product_option].filter(Boolean).join('\n');
  const m = String(text).match(/작업\s*담당\s*[:：]\s*([^\n<]{1,40})/);
  return m ? m[1].trim() : '';
}

/**
 * 저장 직전 담당자 값 정규화 — 실명(박세희·박은비)으로 들어오면 닉네임(만두·망고)으로 접는다.
 *
 * ★★ 매핑되지 않는 값은 **원문 그대로 돌려준다**(완화 금지): `mapWorkManager` 의 ''
 *   fail-safe 를 저장 경로에 그대로 쓰면, 저장에서 '' 는 "모름"이 아니라 **"해제"** 라는
 *   다른 뜻이라 자유입력 담당자가 조용히 지워진다.
 * ★ 빈 값은 빈 값 그대로(해제 저장 계약 불변).
 */
function normalizeManagerForStore(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return v;                 // '' = 해제(기존 동작 불변)
  return mapWorkManager(v) || v;    // 실명·표기흔들림 → 닉네임 / 모르는 값 → 원문 보존
}

module.exports = {
  WORK_MANAGER_MAP, UNDECIDED,
  mapWorkManager, isUndecidedWorkManager, workManagerLabel, pickWorkManager,
  normalizeManagerForStore,
};
