/**
 * inspectMessages.js — 검수 결과로 **리뷰어에게 나가는 문구의 단일 출처**.
 *
 * ★★ 유형 목록·기본 문구·토큰이 여기 한 곳에만 있다 — 관리자 설정 화면(설정 › 리뷰어 안내문구),
 *   [✕ 불량]/[🗑 중복파일 제거]/[이동] 팝업의 프리필, 실제 전송이 전부 이 표를 본다.
 *   사본을 두면 "설정에서 고쳤는데 실제로 나가는 문장은 그대로"가 된다.
 * ★ 저장은 `app_settings.inspect_messages` JSON 1키(신규 테이블 0). 저장값이 없으면 기본 문구.
 * ★ 토큰은 세 개뿐: {reason} 판정 근거 문장 · {work} 작업명 · {to} 옮긴 칸 이름.
 *   모르는 토큰은 **그대로 남긴다**(관리자가 오타를 알아볼 수 있게 — 조용히 지우지 않는다).
 */
const SETTING_KEY = 'inspect_messages';

/** 유형 = 리뷰검수 카드의 유형과 1:1. key 는 프론트 판정(_riPrimaryIssue)과 같은 이름을 쓴다. */
const INSPECT_MSG_KINDS = [
  {
    key: 'duplicate', label: '📄 같은 파일 (중복 제출)',
    desc: '[🗑 중복파일 제거]를 눌렀을 때',
    def: '중복이미지 제출로 반려되었습니다.\n\n'
      + '앞서 제출하신 사진과 같은 사진이 다시 올라와, 나중에 올리신 사진은 등록되지 않았습니다.\n\n'
      + '이번 건은 다른 리뷰 화면을 캡처해 다시 제출해 주세요.',
  },
  {
    /* ★ 주문취소는 "잘못 올렸으니 다시 내라"가 아니다 — 리뷰어가 이미 취소한 건이라
       재제출을 요구하면 엉뚱한 안내가 된다. 사실 확인을 청하는 톤으로 둔다. */
    key: 'cancel', label: '🚫 주문취소',
    desc: '주문이 취소된 화면을 [✕ 불량]으로 처리했을 때',
    def: '제출하신 캡처가 주문이 취소된 화면으로 확인되었습니다.\n\n'
      + '참여를 취소하신 것이라면 그대로 두셔도 됩니다.\n'
      + '계속 진행하실 예정이라면 다시 구매하신 뒤 캡처를 보내주세요.\n\n'
      + '착오가 있다면 이 채팅으로 알려주세요.',
  },
  {
    key: 'format_fail', label: '📵 리뷰화면 아님',
    desc: '리뷰 화면이 아닌 캡처를 [✕ 불량]으로 처리했을 때',
    def: '제출하신 리뷰 캡처가 검수에서 반려되었습니다.\n\n사유: {reason}\n\n'
      + '올바른 캡처로 다시 제출해 주세요. 궁금한 점은 이 채팅으로 답장 주시면 됩니다.',
  },
  {
    key: 'product', label: '🏷 상품명 다름',
    desc: '캡처의 상품이 작업 상품과 달라 [✕ 불량]으로 처리했을 때',
    def: '제출하신 리뷰 캡처가 검수에서 반려되었습니다.\n\n사유: {reason}\n\n'
      + '이 작업의 상품이 맞는지 확인 후 다시 제출해 주세요.',
  },
  {
    key: 'channel', label: '🔀 채널 다름',
    desc: '작업 채널과 다른 곳의 캡처를 [✕ 불량]으로 처리했을 때',
    def: '제출하신 리뷰 캡처가 검수에서 반려되었습니다.\n\n사유: {reason}\n\n'
      + '이 작업에 맞는 곳의 리뷰 화면을 캡처해 다시 제출해 주세요.',
  },
  {
    key: 'similarity', label: '✍ 본문 겹침',
    desc: '앞서 낸 리뷰와 내용이 거의 같아 [✕ 불량]으로 처리했을 때',
    def: '제출하신 리뷰 캡처가 검수에서 반려되었습니다.\n\n사유: {reason}\n\n'
      + '건마다 새로 작성한 리뷰가 필요합니다. 다시 작성해 제출해 주세요.',
  },
  {
    key: 'author', label: '👤 작성자 표기',
    desc: '작성자 표기 문제로 [✕ 불량]으로 처리했을 때',
    def: '제출하신 리뷰 캡처가 검수에서 반려되었습니다.\n\n사유: {reason}\n\n'
      + '본인 계정으로 작성한 리뷰인지 확인 후 다시 제출해 주세요.',
  },
  {
    key: 'moved', label: '↪ 다른 칸으로 이동',
    desc: '[🧾 현금영수증으로 이동]·[🛒 구매캡처로 이동]을 눌렀을 때',
    def: '올려주신 사진은 {to}(으)로 확인되어 {to} 칸으로 옮겨 두었습니다.\n\n'
      + '리뷰 캡처는 아직 비어 있어요 — 리뷰 화면을 캡처해 추가로 올려주세요.',
  },
];

const KEYS = INSPECT_MSG_KINDS.map(k => k.key);
const DEFAULTS = INSPECT_MSG_KINDS.reduce((m, k) => { m[k.key] = k.def; return m; }, {});
const MAX_LEN = 1000;

/** 저장값 정규화 — 알 수 없는 키는 버리고, 빈 값은 기본 문구로 되돌린다(빈 메시지 전송 방지). */
function normalize(obj) {
  const out = {};
  for (const k of KEYS) {
    const v = String((obj && obj[k]) == null ? '' : obj[k]).trim().slice(0, MAX_LEN);
    if (v) out[k] = v;
  }
  return out;
}

/** 설정값 + 기본값 병합 — 화면·전송이 함께 쓰는 최종 표. */
function merge(saved) {
  const s = normalize(saved);
  const out = {};
  for (const k of KEYS) out[k] = s[k] || DEFAULTS[k];
  return out;
}

/**
 * 문구 만들기. vars = { reason, work, to }
 * ★ 값이 없는 토큰은 **그대로 둔다** — 예: 판정 근거가 없는데 {reason} 을 빈칸으로 지우면
 *   "사유:" 만 남은 이상한 문장이 리뷰어에게 나간다. 대신 호출부가 근거를 채워 넘긴다.
 */
function render(template, vars) {
  let s = String(template == null ? '' : template);
  const v = vars || {};
  for (const t of ['reason', 'work', 'to']) {
    if (v[t] == null || v[t] === '') continue;
    s = s.split('{' + t + '}').join(String(v[t]));
  }
  return s.slice(0, MAX_LEN);
}

module.exports = { SETTING_KEY, INSPECT_MSG_KINDS, KEYS, DEFAULTS, normalize, merge, render, MAX_LEN };
