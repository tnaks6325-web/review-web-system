/**
 * 작업표 템플릿 — 컬럼 역할 파생 (M1: 헤더 학습 리포트의 분류기)
 *
 * 목적: "작업표를 만들 때 어떤 열이 들어가야 하는가"를 **추측이 아니라 파생**으로 정한다.
 *
 * ★★ 단일 출처 규율 (완화 금지)
 *   역할 판정 키워드 표를 여기에 **복사하지 않는다**. `mapOrderToSheetRow`(orderLedger)가
 *   "제출이 어느 칸에 쓰는가"의 단일 출처이므로, 필드별 **센티널을 주입해 실제 매퍼를 실행**하고
 *   결과에서 역할을 되읽는다(`optionWriteColumns`가 이미 쓰는 기법 — 그 함수는 옵션 칸 전용이라
 *   여기서 그대로 재사용한다). 이렇게 하면 매퍼의 키워드가 바뀌어도 이 분류기가 자동으로 따라간다.
 *   사본을 두면 "제출은 A열에 쓰는데 작업표는 B열을 만든다"는 드리프트가 조용히 생긴다.
 *
 * ★ 센티널 제약(실측으로 밟은 함정): 매퍼가 값을 `trim()` 하므로 **공백 금지**, NUL 문자(0x00)는
 *   git이 파일 전체를 바이너리로 취급하므로 **금지**. 그래서 `__WT_<ROLE>__` 형태의 순수 ASCII 토큰을 쓴다.
 *   ⚠ 이 주석에도 NUL 문자를 **글자 그대로 적지 말 것** — 파일이 바이너리가 되어 diff·grep이 죽는다
 *   (실제로 한 번 밟았다. 'NUL'은 반드시 이렇게 글자로만 표기한다).
 *
 * ★ 이 파일은 "쓰기 표면"을 넓히지 않는다 — 읽기 전용 분류/제안만 한다.
 */

const {
  mapOrderToSheetRow,
  optionWriteColumns,
  _idColIndices,
} = require('../services/orderLedger.service');

/** 매퍼가 채우는 필드 → 센티널. 값 자체는 의미 없고 "어느 열에 꽂혔나"만 본다. */
const FIELD_SENTINELS = {
  orderer:   '__WT_ORDERER__',
  recipient: '__WT_RECIPIENT__',
  userId:    '__WT_USERID__',
  phone:     '__WT_PHONE__',
  address:   '__WT_ADDRESS__',
  bank:      '__WT_BANK__',
  account:   '__WT_ACCOUNT__',
  depositor: '__WT_DEPOSITOR__',
  price:     '__WT_PRICE__',
  dateStr:   '__WT_DATE__',
  orderNum:  '__WT_ORDERNUM__',
  memo:      '__WT_MEMO__',
};
const _SENTINEL_TO_FIELD = Object.fromEntries(
  Object.entries(FIELD_SENTINELS).map(([k, v]) => [v, k])
);

/**
 * 역할 메타 — 계층(tier)·표시명·제출 매칭 설명(fill).
 *
 * tier 의미:
 *   core    = 거의 모든 작업에 공통, **리뷰어 구매양식 제출이 채운다**(생성 시 빈 칸)
 *   auto    = 작업표 **생성 시점에 시스템이 값까지 채운다**(번호·구매일자)
 *   channel = 구매채널에 따라 붙는다(쿠팡ID/네이버아이디 …)
 *   work    = 작업별로 붙는다(옵션·리뷰형태 등 작업지시)
 *   status  = 진행상태 칸(리뷰제출·입금) — Track B write-back/관리자가 쓴다.
 *             ★ 원칙은 "매퍼와 컬럼 disjoint"지만 헤더 이름이 겹치면(예 '입금일자'←'일자' 규칙)
 *               매퍼도 그 열에 쓸 수 있다 → 그런 열은 `conflict` 로 표시해 드러낸다.
 *
 * fill = "리뷰어가 구매양식을 제출하면 이 칸에 무엇이 들어가는가"의 사람용 설명.
 *   ★ 설정 화면 '공통 열 상세'가 그대로 표시한다 — 역할별 설명을 프론트에 복사하면
 *     매퍼·매칭이 바뀔 때 화면 설명만 옛말이 되므로 **여기(역할 단일 출처)에만** 둔다.
 *   구매양식 항목명은 실제 폼 라벨(search-app.js 주문 카드)과 같은 말을 쓴다.
 */
const ROLE_META = {
  seq:       { label: '번호',      tier: 'auto',    order: 10,
               fill: '제출과 매칭 없음 — 작업표를 만들 때 시스템이 번호를 매깁니다' },
  dateStr:   { label: '구매일자',  tier: 'auto',    order: 20,
               fill: '리뷰어가 제출한 날짜를 시스템이 "M / D (요일)" 형식으로 기록합니다(리뷰어 입력 아님)' },
  option:    { label: '옵션',      tier: 'work',    order: 30,
               fill: '리뷰어가 참여할 때 고른 옵션명이 들어갑니다(칸이 비어 있을 때만 — 미리 적어둔 작업지시는 보존)' },
  product:   { label: '상품',      tier: 'work',    order: 31,
               fill: 'v2 작업 생성 시 상품 원본에서 자동 기입됩니다' },
  option_1:  { label: '1차옵션',   tier: 'work',    order: 32,
               fill: 'v2 작업 생성 시 1차 옵션값이 자동 기입됩니다' },
  option_2:  { label: '2차옵션',   tier: 'work',    order: 33,
               fill: 'v2 작업 생성 시 2차 옵션값이 자동 기입됩니다' },
  round:     { label: '차수',      tier: 'work',    order: 34,
               fill: 'v2 작업의 차수 추가 결과가 자동 기입됩니다' },
  review_option_instruction: { label: '리뷰옵션', tier: 'work', order: 35,
               fill: 'v2 작업 생성 시 확정된 리뷰유형이 자동 기입됩니다' },
  tracking_number: { label: '송장번호', tier: 'work', order: 36,
               fill: '택배발송대행 작업에서 발송 처리 시 기록합니다' },
  orderer:   { label: '주문자',    tier: 'core',    order: 40,
               fill: '구매양식 [주문자] 입력값이 들어갑니다' },
  recipient: { label: '수취인',    tier: 'core',    order: 50,
               fill: '구매양식 [수취인] 입력값이 들어갑니다' },
  userId:    { label: '구매채널ID', tier: 'channel', order: 60,
               fill: '구매양식 [아이디] 입력값이 들어갑니다(쿠팡+네이버 동시탭은 채널구분 불가로 비워 둠)' },
  phone:     { label: '연락처',    tier: 'core',    order: 70,
               fill: '구매양식 [연락처] 입력값이 들어갑니다' },
  address:   { label: '배송주소',  tier: 'core',    order: 80,
               fill: '구매양식 [배송주소] 입력값이 들어갑니다' },
  bank:      { label: '은행',      tier: 'core',    order: 90,
               fill: '구매양식 [은행] 입력값이 들어갑니다' },
  account:   { label: '계좌번호',  tier: 'core',    order: 100,
               fill: '구매양식 [계좌] 입력값이 들어갑니다' },
  depositor: { label: '예금주',    tier: 'core',    order: 110,
               fill: '구매양식 [예금주] 입력값이 들어갑니다' },
  price:     { label: '결제금액',  tier: 'core',    order: 120,
               fill: '구매양식 [결제금액] 입력값이 들어갑니다' },
  orderNum:  { label: '주문번호',  tier: 'core',    order: 130,
               fill: '구매양식 [주문번호] 입력값이 들어갑니다(구매 캡처에서 자동 인식되면 그 값)' },
  submit:    { label: '리뷰',      tier: 'status',  order: 140,
               fill: '구매양식 제출값 없음 — 리뷰 캡처가 접수되면 시스템·관리자가 표시하는 상태 칸입니다' },
  paid:      { label: '입금일',    tier: 'status',  order: 150,
               fill: '구매양식 제출값 없음 — 입금 처리 시 표시되는 상태 칸입니다' },
  memo:      { label: '비고',      tier: 'core',    order: 160,
               fill: '구매양식 [비고] 입력값이 들어갑니다(시스템 복구 표기가 함께 남을 수 있음)' },
};

/**
 * '번호' 계열 — ★ 매퍼가 쓰지 않는 칸이라 센티널로는 잡히지 않는다.
 *   제출이 채우는 칸이 아니라 **작업표를 만들 때 우리가 매기는 칸**이라 생성 측에서만 의미가 있다.
 *   그래서 "쓰기 표면"이 아니라 여기(생성 측 분류)에만 둔다 — 매퍼에 추가하면 제출이 번호를 덮어쓴다.
 */
const _SEQ_KEYS = ['번호', 'no', 'no.', '#', '순번', 'seq'];
function _isSeqHeader(h) {
  const key = String(h || '').toLowerCase().trim();
  if (!key) return false;
  // '주문번호'·'전화번호' 등은 다른 역할이 이미 가져가므로 여기 오지 않지만, 방어적으로 정확일치만 인정.
  return _SEQ_KEYS.includes(key);
}

/**
 * 헤더 배열 → 열별 역할 배열.
 *
 * @param {string[]} headers 시트 헤더(감지된 헤더 그대로)
 * @param {{submitCol?:string, submitCol2?:string}} [opts]
 *        탭 설정의 리뷰제출/입금 칸 이름(tab_configs.submit_col/submit_col2).
 *        ★ 이 두 칸은 매퍼가 쓰지 않으므로(컬럼 disjoint 불변식) 탭 설정으로만 알 수 있다.
 * @returns {Array<{index:number, header:string, role:string|null, tier:string|null,
 *                  label:string|null, fill:string|null, conflict:string|null}>}
 *          conflict = 상태 칸으로 판정했는데 매퍼도 그 열에 쓰는 경우의 매퍼 역할(없으면 null).
 */
function classifyHeaders(headers, opts = {}) {
  const list = Array.isArray(headers) ? headers : [];
  if (!list.length) return [];

  // ① 매퍼 실행 — 필드별 센티널이 어느 열에 꽂히는지 관측
  const mapped = mapOrderToSheetRow(list, FIELD_SENTINELS);
  // ② 옵션 칸은 전용 파생 함수 재사용(매퍼 파생 단일 출처)
  const optionCols = new Set(optionWriteColumns(list));
  // ③ 채널 id 열 — ★ 저수준 `_isIdHeader` 가 아니라 **id 규칙이 실제로 이기는 열**만 반환하는
  //   `_idColIndices` 를 쓴다. 그러지 않으면 매퍼가 일부러 보호하는 '상품아이디'(관리자 열)·
  //   '비고(아이디확인)'(메모 열)까지 채널 열로 오분류해, 작업표가 만들지 말아야 할 열을 제안한다.
  //   NC(쿠팡+네이버) 탭에서는 2개가 그대로 나온다 — 매퍼는 채널구분 불가로 둘 다 비우지만
  //   **작업표에는 두 열이 다 필요**하므로 이 분류는 맞다(쓰기 표면은 여전히 불변).
  const idCols = new Set(_idColIndices(list));

  const submitName = String(opts.submitCol || '').trim().toLowerCase();
  const paidName = String(opts.submitCol2 || '').trim().toLowerCase();

  return list.map((h, i) => {
    const header = String(h == null ? '' : h).trim();
    const key = header.toLowerCase();
    let role = null;
    let mapperRole = null;

    const v = mapped[i];
    if (typeof v === 'string' && _SENTINEL_TO_FIELD[v]) mapperRole = _SENTINEL_TO_FIELD[v];
    else if (optionCols.has(i)) mapperRole = 'option';
    else if (idCols.has(i)) mapperRole = 'userId';

    // ★★ 상태 칸(리뷰제출·입금)은 **탭 설정이 진실원본이므로 매퍼 판정을 이긴다**.
    //   `submit_col`/`submit_col2` 는 그 탭에서 실제로 관측된 열 이름이라 키워드 추측보다 구체적이다.
    //   실측 함정: `submit_col2='입금일자'` 는 매퍼의 '일자' 규칙에 걸려 dateStr(구매일자)로 잡힌다 →
    //   먼저 보지 않으면 **입금 상태 칸이 "자동 채움 구매일자"로 보고**된다.
    const stagedRole = key === '상품' || key === 'product' ? 'product'
      : (/^(?:1차|1st)\s*옵션$/.test(key) ? 'option_1'
        : (/^(?:2차|2nd)\s*옵션$/.test(key) ? 'option_2'
          : (key === '차수' ? 'round'
            : (key === '리뷰옵션' ? 'review_option_instruction'
              : (key === '송장번호' ? 'tracking_number' : null)))));
    if (key === '리뷰') role = 'submit';
    else if (key === '입금일') role = 'paid';
    else if (submitName && key === submitName) role = 'submit';
    else if (paidName && key === paidName) role = 'paid';
    else if (stagedRole) role = stagedRole;
    else role = mapperRole;

    if (!role && _isSeqHeader(header)) role = 'seq';

    // ★ 상태 칸인데 매퍼도 그 열에 쓴다 = **컬럼 disjoint 가정 위반**(Track B write-back 전제).
    //   제출이 그 칸을 덮어쓸 수 있다는 뜻이므로 조용히 한쪽을 고르지 않고 신호로 남긴다.
    const conflict = (role === 'submit' || role === 'paid') && mapperRole ? mapperRole : null;

    const meta = role ? ROLE_META[role] : null;
    return {
      index: i,
      header,
      role,
      tier: meta ? meta.tier : null,
      label: meta ? meta.label : null,
      fill: meta ? meta.fill : null,
      conflict,
    };
  });
}

/**
 * 헤더만으로 그 탭의 구매채널을 추정한다.
 *
 * ★ 왜 헤더로 보는가: 채널 판정의 기존 단일 출처(상품 URL 호스트)는 작업오더가 연결된 탭에서만
 *   쓸 수 있고, 학습 대상은 **연결이 없는 과거 탭까지 전부**다. 헤더의 id 칸 이름은 그 탭이
 *   실제로 어느 채널로 운영됐는지를 직접 말해 준다(쿠팡id / 네이버아이디). 추정 실패는 unknown —
 *   ★ 틀린 채널로 분류하느니 모름으로 둔다(현영 안내 이미지 규율과 같은 원칙).
 */
function inferChannelFromHeaders(headers) {
  const keys = (Array.isArray(headers) ? headers : []).map(h => String(h || '').toLowerCase());
  const hasCoupang = keys.some(k => k.includes('쿠팡'));
  const hasNaver = keys.some(k => k.includes('네이버'));
  if (hasCoupang && hasNaver) return 'both';   // NC(동시진행) — id 칸이 2개라 매퍼도 둘 다 비운다
  if (hasCoupang) return 'coupang';
  if (hasNaver) return 'naver';
  return 'unknown';
}

/** 표시 순서(작업표 생성 시 제안 열 순서) — 실제 시트 관례 순서를 따른다. */
function roleOrder(role) {
  const m = ROLE_META[role];
  return m ? m.order : 9999;
}

module.exports = {
  FIELD_SENTINELS,
  ROLE_META,
  classifyHeaders,
  inferChannelFromHeaders,
  roleOrder,
};
