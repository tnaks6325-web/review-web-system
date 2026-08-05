/**
 * reviewerGate.js — 모집공고별 참여가능 리뷰어 게이트 판정 **단일 출처** (migration 091)
 *
 * 배경(직원 아이디어, 2026-08-05 사용자 확정):
 *   공고별로 "이 공고에 참여할 수 없는 리뷰어"를 건별 지정하고, 차단된 리뷰어가 참여를
 *   시도하면 관리자가 고른 안내(마감 위장 / 사유 고지)를 보여준다. 기본 = 전원 참여가능
 *   (deny-list) — 예외 행만 저장하므로 2000여명 전체 로드·저장이 없다.
 *
 * 판정 규칙(완화 금지 · 우선순위 3단):
 *   ① 공고별 allow → 통과 (전역 블랙리스트보다 우선 — "안 구해지는 공고엔 참여시킨다"의 건별 override)
 *   ② 공고별 block → 차단 + 그 행의 message_type 고정 문구
 *   ③ 전역 blacklist → 차단(사유 고지형) — ★ 단 env CAMPAIGN_REVIEWER_GATE_GLOBAL=1 옵트인일 때만.
 *      전역 블랙리스트는 지금까지 apply 를 막지 않았으므로 기본 ON 이면 기존 참여자가 조용히 막히는
 *      회귀가 된다(사용자 확정 Q3: 후속 — 구현 후 실제 테스트 후 결정).
 *
 * ★ 안내 문구는 고정 2종(사용자 확정 Q2 — 자유 문구 없음). 문구의 단일 출처는 GATE_MESSAGES 하나 —
 *   라우트·화면이 문구 사본을 만들면 관리 화면 설명과 리뷰어 화면이 갈라진다.
 * ★ 차단은 "신규 신청(apply)"만 막는다(사용자 확정 Q1) — 이미 잡힌 홀드·확정 건은 건드리지 않는다.
 *
 * 킬스위치: CAMPAIGN_REVIEWER_GATE=0 → 게이트 전체 무력화(전건 통과 = 기존 동작 100%).
 */

/** 차단 안내 고정 문구 (message_type → 리뷰어에게 그대로 나가는 텍스트) */
const GATE_MESSAGES = {
  closed: '공고가 마감되었습니다',                                          // 마감 위장 — 차단 사실 비노출
  policy: '이전 리뷰 미작성 또는 리뷰 기한 경과로 인해 공고 참여가 불가합니다', // 사유 고지
};

function gateEnabled() {
  return process.env.CAMPAIGN_REVIEWER_GATE !== '0';
}

/** 전역 blacklist 테이블 강제 — 기본 OFF(옵트인, 사용자 확정 Q3) */
function globalGateEnabled() {
  return process.env.CAMPAIGN_REVIEWER_GATE_GLOBAL === '1';
}

function normalizeMessageType(v) {
  return v === 'policy' ? 'policy' : 'closed'; // 모르는 값은 마감 위장(더 보수적인 쪽 = 사유를 지어내지 않음)
}

/**
 * 판정 순수함수 — DB 조회는 호출측(service)이 하고 여기서는 규칙만.
 * @param {object} p
 *   gateRow: {mode, message_type} | null  — 이 공고의 활성 예외 행
 *   inGlobalBlacklist: boolean            — 전역 blacklist 소속 여부(옵트인 OFF면 호출측이 false 전달)
 * @returns {blocked:false} | {blocked:true, gate:'closed'|'policy', message, source:'campaign'|'global'}
 */
function decideReviewerGate({ gateRow, inGlobalBlacklist } = {}) {
  if (!gateEnabled()) return { blocked: false };
  if (gateRow && gateRow.mode === 'allow') return { blocked: false }; // ① 건별 허용이 최우선
  if (gateRow && gateRow.mode === 'block') {                          // ② 공고별 차단
    const mt = normalizeMessageType(gateRow.message_type);
    return { blocked: true, gate: mt, message: GATE_MESSAGES[mt], source: 'campaign' };
  }
  if (inGlobalBlacklist && globalGateEnabled()) {                     // ③ 전역(옵트인)
    return { blocked: true, gate: 'policy', message: GATE_MESSAGES.policy, source: 'global' };
  }
  return { blocked: false };
}

/**
 * 블랙리스트 관리기준(설정탭, 사용자 확정 Q4) 정규화.
 *   nowriteDays: 참여 확정 후 이 일수가 지나도록 리뷰 미제출 → "리뷰 미작성" 판정
 *   overdueDays: 리뷰 기한 일수 — 제출은 했으나 구매 후 이 일수 이후 제출 → "기한 경과" 판정
 * ★ _int 규율(082): 빈 값을 0으로 접지 않는다 — Number('')===0 이라 가드 없으면
 *   "미설정"이 조용히 0일(전건 미작성 판정)이 된다.
 */
const CRITERIA_DEFAULTS = { nowriteDays: 14, overdueDays: 14 };

function _days(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

function normalizeCriteria(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  return {
    nowriteDays: _days(o.nowriteDays, CRITERIA_DEFAULTS.nowriteDays),
    overdueDays: _days(o.overdueDays, CRITERIA_DEFAULTS.overdueDays),
  };
}

/**
 * 이전 리뷰 상태 요약 문장 — 관리 표의 "이전 리뷰" 칸 표시 단일 출처(프론트 규칙 사본 금지).
 * @param {object} h {joined, done, nowrite, overdue} 숫자(집계 실패 시 null 전달)
 * @returns {label, level:'ok'|'warn'|'bad'|'none'|'unknown'}
 */
function summarizeHistory(h) {
  if (!h) return { label: '조회 실패', level: 'unknown' };       // 0으로 꾸미지 않는다(조용한 정상 위장 금지)
  const joined = Number(h.joined) || 0;
  const nowrite = Number(h.nowrite) || 0;
  const overdue = Number(h.overdue) || 0;
  if (!joined) return { label: '참여 이력 없음', level: 'none' };
  if (nowrite > 0) return { label: `리뷰 미작성 (${nowrite}건)`, level: 'bad' };
  if (overdue > 0) return { label: `기한 경과 (${overdue}건)`, level: 'warn' };
  return { label: `정상 (참여 ${joined}건)`, level: 'ok' };
}

module.exports = {
  GATE_MESSAGES, CRITERIA_DEFAULTS,
  gateEnabled, globalGateEnabled, normalizeMessageType,
  decideReviewerGate, normalizeCriteria, summarizeHistory,
};
