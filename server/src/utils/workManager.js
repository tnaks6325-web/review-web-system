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
 * ★ 랜덤은 빈 문자열을 돌려준다(= 아직 만두·망고 어느 쪽도 아님). 모르는 이름도 빈 문자열 = fail-safe
 *   (원문은 화면에 그대로 보여준다).
 * ★★ 2026-11-23 사용자 확정으로 규칙이 바뀌었다(결정 395) — 종전 「랜덤은 자동으로 아무나 고르면 안 되고
 *   관리자가 정해야 한다」는 **폐기**. 「랜덤」은 AE 가 만두·망고를 못 고를 때 쓰는 선택지라, 인트라넷에서
 *   랜덤으로 들어온 작업오더는 리뷰웹이 **진행 중 작업이 적은 쪽**(같으면 번갈아)으로 자동 배정한다
 *   (`services/autoWorkManager.service`). 이 파일의 매핑은 그대로다 — 배정은 기존 공유 저장 경로가 한다.
 *   ★ 자동 배정 대상은 `isExactUndecidedWorkManager`(정확 일치)만 — 「이미정」 같은 사람 이름은 잡지 않는다.
 */

/** 실명 → 리뷰웹 담당자 닉네임 */
const WORK_MANAGER_MAP = {
  '박세희': '만두',
  '박은비': '망고',
};

/** 만두·망고 둘 다 아닌 작업(예: 블로그) — 인트라넷 작업담당 「기타」와 같은 글자(결정 374).
 *  ★ 미지정이 아니다(질문을 다시 띄우지 않는다) · 입금관리에서 만두·망고 칩에 섞이지 않는다(「전체」·「기타」에서만). */
const OTHER_MANAGER = '기타';

/** 자동 선택하지 않고 관리자가 정해야 하는 값(인트라넷 표기 그대로) */
const UNDECIDED = ['랜덤', '랜덤배정', '미정'];

/** 공백·구분자 제거 — "박 세희", "박세희(만두)" 같은 표기 흔들림 흡수 */
function _norm(v) {
  return String(v || '').replace(/\s+/g, '').replace(/[()（）[\]]/g, '');
}

/**
 * 작업담당 원문 → 리뷰웹 담당자 닉네임.
 * @returns {string} '만두' | '망고' | '기타' | '' (빈 문자열 = 직접결정)
 */
function mapWorkManager(raw) {
  const v = _norm(raw);
  if (!v) return '';
  if (v === OTHER_MANAGER) return OTHER_MANAGER;   // 정확히 「기타」만(결정 374) — 다른 이름 속 글자는 잡지 않는다
  for (const [name, nick] of Object.entries(WORK_MANAGER_MAP)) {
    if (v.includes(name)) return nick;
  }
  // 이미 닉네임으로 온 경우도 인정(인트라넷이 나중에 닉네임을 보내도 동작)
  for (const nick of Object.values(WORK_MANAGER_MAP)) {
    if (v.includes(nick)) return nick;
  }
  return '';
}

/** 미정 표기가 들어 있는가(랜덤 등 · 포함 비교 — 표시·정규화용. 쓰기 판정에는 아래 정확 일치를 쓴다) */
function isUndecidedWorkManager(raw) {
  const v = _norm(raw);
  return !!v && UNDECIDED.some(u => v.includes(u));
}

/** 정식 미정 값과 **정확히** 같은가(공백만 무시) — 「이미정」 같은 사람 이름은 false(결정 311).
 *  자동 배정·홈 미지정 질문처럼 **쓰기를 여는 판정**은 이것만 쓴다. 빈 값은 false(빈 값은 미정 표기가 아니다). */
function isExactUndecidedWorkManager(raw) {
  const v = String(raw == null ? '' : raw).replace(/\s+/g, '');
  return !!v && UNDECIDED.includes(v);
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

/**
 * 어떤 화면이든 "이 작업의 담당자" 를 보여줄 때 쓰는 **판정 단일 출처**.
 *
 * ★★ 사고(2026-08-24 회차 #18): 입금관리는 `tab_configs.manager` 만 봤다. 그 칸은
 *    접수 업서트가 **blank-only**(`manager = COALESCE(NULLIF(tab_configs.manager,''), …)`)라
 *    한 번 채워지면 재접수로도 안 바뀐다. 오더에서 작업담당이 바뀐 작업은 **옛 담당자로 굳어**
 *    "망고만 선택했는데 만두 작업의 이체건이 서식에 딸려오는" 상태가 됐다.
 * ★★ **홈 작업목록도 같은 함정이다**(같은 날 신고): 작업조건 카드·모집공고는 만두인데 홈
 *    "담당" 열은 망고로 보였다 — `trackB.service.tabStatsMap` 이 `tab_configs.manager` 를
 *    **폴백 없이 그대로** 보여줬기 때문이다(`tab_configs.manager` 를 쓰는 다른 곳은 회차 #18
 *    사고 자리와 동일). 두 화면이 각자 이 함수를 부르면 판정이 다시 갈릴 수 없다.
 * ★★ 원천은 `work_manager` **하나뿐**이다 — `manager_name`(담당AE 실명)은 절대 쓰지 않는다
 *    (065 이전에 그 칸을 탭 담당자로 넣어 "옵션은 만두/망고인데 값은 AE 실명"이 됐던 그 사고
 *    자리다). 닉네임 치환도 이 파일의 `mapWorkManager` 한 곳뿐 — 다른 이름 맵(예: C/S 닉네임)을
 *    끌어오면 AE·관리자 이름이 담당자 칩으로 새어 들어온다.
 * ★ 랜덤·미매핑은 **빈 값** → 그때만 탭 설정을 폴백으로 본다(이 함수는 판정만 — 랜덤 자동 배정은 결정 395 의
 *   `autoWorkManager.service` 가 공유 저장으로 work_manager 자체를 바꾼다. 여기서 아무나 고르지 않는다).
 *   탭 값도 매핑되면 닉네임으로 접고, 모르는 값은 **원문 보존**(임의 해석·조용한 담당자 변경 금지).
 *
 * @param {{orderWorkManager?: string, tabManager?: string}} p
 * @returns {{manager:string, managerSource:('order'|'tab'|null)}}
 */
function resolveWorkManager({ orderWorkManager, tabManager } = {}) {
  const fromOrder = mapWorkManager(orderWorkManager);
  if (fromOrder) return { manager: fromOrder, managerSource: 'order' };
  const tab = String(tabManager == null ? '' : tabManager).trim();
  if (!tab) return { manager: '', managerSource: null };
  return { manager: mapWorkManager(tab) || tab, managerSource: 'tab' };
}

module.exports = {
  WORK_MANAGER_MAP, UNDECIDED, OTHER_MANAGER,
  mapWorkManager, isUndecidedWorkManager, isExactUndecidedWorkManager, workManagerLabel, pickWorkManager,
  normalizeManagerForStore, resolveWorkManager,
};
