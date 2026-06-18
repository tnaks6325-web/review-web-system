/**
 * 오류디버깅(Error Debugging) 오케스트레이션 서비스
 * ------------------------------------------------------------------
 * "리뷰웹시스템 오류 디버깅 및 오류수정 프로토콜" 문서를 코드로 구현한 모듈.
 *
 *   오류검증(비파괴) → 다중 에이전트 분석(레드/블루/감독관/예방가드/결정자)
 *   → 결정자 판정 → 이행요청 게이트
 *
 * 설계 원칙:
 *   - ★ 비파괴: 실제 코드 수정이나 운영 작업(저장/삭제/발송/결제/상태변경/외부API)을
 *     절대 재현하지 않는다. 정적 추론 + AI 분석만 수행한다.
 *   - AI(Gemini) 가 없거나 실패하면 규칙기반 fallback 으로 항상 동작한다.
 *   - 코드가 안전 게이트를 강제한다: AI 판정은 "후보"이며, 보호대상/쓰기요청이면
 *     verify_verdict 를 blocked 로, decider 를 implement 금지로 클램프한다.
 */
const { logger } = require('../utils/logger');

// ── 허용 판정값 (문서 8장 / 9.6장) ──
const VERIFY_VERDICTS = ['not_checked', 'likely_reproducible', 'reproduced', 'not_reproduced_static', 'likely_resolved_by_other_change', 'blocked'];
const DECIDER_VERDICTS = ['implement', 'implement_after_preflight', 'needs_more_context', 'ignore'];

// ── 보호대상 키워드 (문서 15장) — flow/category/path/message 에서 탐지 ──
const PROTECTED_PATTERNS = /order|payment|정산|결제|주문|review|리뷰|account|계정|reviewer|campaign|모집|webhook|웹훅|drive|sheet|notice|발송|알림|admin|master|블랙리스트|blacklist/i;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 안전 게이트 계산 — 자동 재현/수정 위험도 판정
 * @returns {{ mutating:boolean, protected:boolean, repro_safe:boolean, reasons:string[] }}
 */
function computeSafety(row) {
  const ctx = (row && row.context) || {};
  const method = String(ctx.method || '').toUpperCase();
  const path = String(ctx.path || '');
  const hay = [row.flow, row.category, row.source, path, row.message_raw, row.message_ko].map(v => String(v || '')).join(' ');

  const mutating = MUTATING_METHODS.has(method);
  const isProtected = PROTECTED_PATTERNS.test(hay);
  // 읽기전용(GET) + 보호대상 아님 + 클라이언트 렌더 오류 등만 자동검증 안전으로 간주
  const repro_safe = !mutating && !isProtected;

  const reasons = [];
  if (mutating) reasons.push(`쓰기 요청(${method})은 자동 재현 금지(저장/삭제/상태변경 위험)`);
  if (isProtected) reasons.push('보호대상(주문/결제/계정/외부연동 등) 관련 — 자동 재현 차단');
  return { mutating, protected: isProtected, repro_safe, reasons };
}

/** 안전하게 문자열화 (객체/배열도 1줄로) */
function _s(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(_s).filter(Boolean).join(', ');
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return ''; } }
  return String(v);
}
/** 배열 정규화 (문자열이면 줄/콤마 분리) */
function _arr(v) {
  if (Array.isArray(v)) return v.map(x => _s(x).trim()).filter(Boolean);
  const s = _s(v).trim();
  if (!s) return [];
  return s.split(/\r?\n|;|,/).map(x => x.trim()).filter(Boolean);
}

/**
 * 규칙기반 fallback 분석 (AI 미설정/실패 시) — 항상 유효한 구조를 반환한다.
 */
function fallbackAnalysis(row, safety) {
  const cat = row.category || 'unknown';
  const where = [row.flow_ko, row.step_ko].filter(Boolean).join(' ') || '시스템';

  // verify 판정 (비파괴) — 실제 재현은 하지 않으므로 'reproduced' 는 사용하지 않음
  let verifyVerdict;
  if (!safety.repro_safe) verifyVerdict = 'blocked';
  else if (['timeout', 'quota', 'network'].includes(cat)) verifyVerdict = 'likely_resolved_by_other_change'; // 일시성 → 재발 여부 우선 확인
  else verifyVerdict = 'likely_reproducible';

  const mustVerify = [
    `${where} 화면/응답이 정상 동작하는지 비파괴로 확인`,
    `동일 signature 오류가 새로 수집되지 않는지 확인`,
  ];
  const blockers = [];
  if (!safety.repro_safe) blockers.push(...safety.reasons);

  // decider 판정
  let deciderVerdict;
  if (verifyVerdict === 'likely_resolved_by_other_change' || verifyVerdict === 'not_reproduced_static') deciderVerdict = 'ignore';
  else if (verifyVerdict === 'blocked') deciderVerdict = 'implement_after_preflight';
  else deciderVerdict = 'needs_more_context';

  const preflight = deciderVerdict === 'implement_after_preflight'
    ? ['운영 데이터에 영향 없는 검증 환경에서만 재현 시도', '관련 코드/로그/영향 범위를 수동 확인']
    : [];
  const goNoGo = deciderVerdict === 'implement_after_preflight'
    ? '검증 환경에서 동일 오류 재현 시 진행, 운영 데이터 변경 가능성 발견 시 중단'
    : '';

  return {
    verify: {
      verdict: verifyVerdict,
      evidence: '정적 분류 기반 추정(자동 재현 미수행). 일시성/보호대상 여부로 판단.',
      next_action: verifyVerdict === 'likely_resolved_by_other_change'
        ? '동일 화면을 비파괴로 확인 후 재발 없으면 resolved 처리'
        : '코드/로그/영향 범위 수동 확인 후 결정',
    },
    red_team: {
      conditions: `${where}에서 ${cat} 유형 조건일 때 발생 추정`,
      user_impact: '해당 기능 사용 중 실패/지연 또는 오류 화면 노출 가능',
      data_risk: '방치 시 동일 오류 반복 수집, 일부 흐름 미완료 가능',
      recurrence: '동일 입력/네트워크/외부연동 상태에서 재발 가능',
    },
    blue_team: {
      input_validation: '관련 입력값 유효성 검증 강화',
      exception_handling: '해당 단계 try/catch 및 사용자 메시지 정비',
      state_guard: '상태 전이 전 사전조건 확인',
      idempotency: '중복 실행/재시도 시 부작용 없는지 점검',
      external_api: '외부 API 실패 시 재시도/타임아웃/사용자 안내 처리',
      regression_tests: '성공/실패 케이스 회귀 테스트 추가',
    },
    supervisor: {
      overreach: '원인 분석이 과하지 않도록 해당 단계로 범위 한정',
      scope: '수정 범위를 발생 위치 1곳으로 최소화 권장',
      symptom_vs_cause: '증상(오류문구)만 막지 말고 발생 단계 원인 확인 필요',
      side_effects: '정상 흐름(성공 케이스)에 영향 없는지 확인',
      narrowest_fix: '해당 단계의 예외 처리/검증만 좁게 수정',
    },
    prevention_guard: {
      affected_screens: `${where} 및 인접 화면`,
      affected_apis: _s(row.context && row.context.path) || '관련 API',
      data_flows: '해당 기능의 입력→처리→저장 흐름',
      external_impact: safety.protected ? '외부 연동/보호대상 영향 가능 — 주의' : '직접적 외부 영향 낮음',
      new_risks: '예외 처리 추가 시 기존 정상 흐름 회귀 가능성',
      blockers,
      must_verify: mustVerify,
      safe_to_implement: blockers.length === 0,
    },
    decider: {
      verdict: deciderVerdict,
      reason: verifyVerdict === 'likely_resolved_by_other_change'
        ? '일시성/타 변경으로 해결됐을 가능성 — 재발 여부 확인 우선'
        : (verifyVerdict === 'blocked' ? '보호대상/쓰기요청 — 사전 확인 후 수동 검증 필요' : '원인/영향 범위 추가 정보 필요'),
    },
    preflight,
    go_no_go: goNoGo,
    fix_scope: `${where} 단계의 예외 처리/검증으로 한정`,
    test_plan: '성공/실패 케이스 수동 확인 + 동일 signature 재수집 모니터링',
    must_verify: mustVerify,
    residual_risk: safety.protected ? '보호대상 관련 — 수정 시 운영 데이터/외부연동 영향 재확인 필요' : '낮음',
    summary_ko: `${where} ${cat} 오류 — ${deciderVerdict === 'ignore' ? '재발 여부 확인 후 종료 권장' : '검증 후 좁은 범위 수정 검토'}`,
    generated_by: 'fallback',
  };
}

/**
 * AI 결과를 안전하게 정규화 + 코드 게이트 클램프
 */
function normalizeAndClamp(ai, row, safety) {
  const base = fallbackAnalysis(row, safety); // 누락 키 채움용 기준
  const pg = (ai && ai.prevention_guard) || {};

  // prevention_guard 정규화
  const blockers = _arr(pg.blockers);
  if (!safety.repro_safe) for (const r of safety.reasons) if (!blockers.includes(r)) blockers.push(r);
  let mustVerify = _arr(pg.must_verify);
  if (mustVerify.length === 0) mustVerify = base.prevention_guard.must_verify;
  const safeToImplement = pg.safe_to_implement === false ? false : (blockers.length === 0);

  // verify 클램프 — 비파괴 원칙상 'reproduced' 불가, 보호대상이면 blocked
  let verifyVerdict = VERIFY_VERDICTS.includes((ai.verify || {}).verdict) ? ai.verify.verdict : base.verify.verdict;
  if (verifyVerdict === 'reproduced') verifyVerdict = 'likely_reproducible';
  if (!safety.repro_safe && (verifyVerdict === 'likely_reproducible' || verifyVerdict === 'reproduced')) verifyVerdict = 'blocked';

  // decider 클램프
  let deciderVerdict = DECIDER_VERDICTS.includes((ai.decider || {}).verdict) ? ai.decider.verdict : base.decider.verdict;
  if (verifyVerdict === 'likely_resolved_by_other_change' || verifyVerdict === 'not_reproduced_static') deciderVerdict = 'ignore';
  else if (verifyVerdict === 'blocked' && deciderVerdict === 'implement') deciderVerdict = 'implement_after_preflight';

  // preflight / go_no_go — implement_after_preflight 면 필수
  let preflight = _arr(ai.preflight);
  let goNoGo = _s(ai.go_no_go).trim();
  if (deciderVerdict === 'implement_after_preflight') {
    if (preflight.length === 0) preflight = base.preflight.length ? base.preflight : ['운영 데이터 영향 없는 환경에서만 재현/검증', '관련 코드·로그·영향 범위 수동 확인'];
    if (!goNoGo) goNoGo = base.go_no_go || '검증 환경에서 재현 시 진행, 운영 데이터 변경 가능성 발견 시 중단';
  }

  const pick = (obj, fb) => {
    const o = obj && typeof obj === 'object' ? obj : {};
    const out = {};
    for (const k of Object.keys(fb)) out[k] = _s(o[k]).trim() || fb[k];
    return out;
  };

  return {
    verify: {
      verdict: verifyVerdict,
      evidence: _s((ai.verify || {}).evidence).trim() || base.verify.evidence,
      next_action: _s((ai.verify || {}).next_action).trim() || base.verify.next_action,
    },
    red_team: pick(ai.red_team, base.red_team),
    blue_team: pick(ai.blue_team, base.blue_team),
    supervisor: pick(ai.supervisor, base.supervisor),
    prevention_guard: {
      affected_screens: _s(pg.affected_screens).trim() || base.prevention_guard.affected_screens,
      affected_apis: _s(pg.affected_apis).trim() || base.prevention_guard.affected_apis,
      data_flows: _s(pg.data_flows).trim() || base.prevention_guard.data_flows,
      external_impact: _s(pg.external_impact).trim() || base.prevention_guard.external_impact,
      new_risks: _s(pg.new_risks).trim() || base.prevention_guard.new_risks,
      blockers,
      must_verify: mustVerify,
      safe_to_implement: safeToImplement,
    },
    decider: {
      verdict: deciderVerdict,
      reason: _s((ai.decider || {}).reason).trim() || base.decider.reason,
    },
    preflight,
    go_no_go: goNoGo,
    fix_scope: _s(ai.fix_scope).trim() || base.fix_scope,
    test_plan: _s(ai.test_plan).trim() || base.test_plan,
    must_verify: mustVerify,
    residual_risk: _s(ai.residual_risk).trim() || base.residual_risk,
    summary_ko: _s(ai.summary_ko).trim() || base.summary_ko,
    generated_by: 'ai',
  };
}

/**
 * 이행 요청 복사 게이트 (문서 10장) — 차단 사유 목록 반환(비어있으면 복사 허용)
 */
function transferGate(analysis, verifyVerdict, deciderVerdict) {
  const reasons = [];
  const pg = (analysis && analysis.prevention_guard) || null;
  if (!['implement', 'implement_after_preflight'].includes(deciderVerdict))
    reasons.push('결정자 판정이 implement / implement_after_preflight 가 아님');
  if (!pg) reasons.push('예방가드 결과가 없음');
  else {
    if (pg.safe_to_implement === false) reasons.push('예방가드가 안전 구현 불가로 판단함');
    if (Array.isArray(pg.blockers) && pg.blockers.length > 0) reasons.push('구현 전 차단 조건이 남아 있음');
    if (!Array.isArray(pg.must_verify) || pg.must_verify.length === 0) reasons.push('필수 검증 항목이 비어 있음');
  }
  if (deciderVerdict === 'implement_after_preflight') {
    if (!analysis || !Array.isArray(analysis.preflight) || analysis.preflight.length === 0)
      reasons.push('implement_after_preflight 인데 사전 확인 항목이 없음');
    if (!analysis || !_s(analysis.go_no_go).trim())
      reasons.push('implement_after_preflight 인데 진행/중단 기준이 없음');
  }
  if (verifyVerdict === 'likely_resolved_by_other_change')
    reasons.push('오류검증 결과가 이미 해결 후보임');
  return reasons;
}

/**
 * 오류검증 및 분석 실행 (비파괴) — DB row 1건을 받아 분석 결과 객체를 만든다.
 * 실제 DB 갱신은 호출부(라우트)에서 수행.
 * @returns {{ analysis, verify_verdict, decider_verdict, transfer_blockers, safety }}
 */
async function runAnalysis(row) {
  const safety = computeSafety(row);

  let normalized;
  try {
    const { analyzeErrorAgents } = require('./gemini.service');
    const ctx = (row && row.context) || {};
    const ai = await analyzeErrorAgents({
      category: row.category, severity: row.severity,
      flow_ko: row.flow_ko, step_ko: row.step_ko, source: row.source,
      method: ctx.method, path: ctx.path, statusCode: ctx.statusCode,
      message_ko: row.message_ko, message_raw: row.message_raw,
      error_code: row.error_code, occurrence_count: row.occurrence_count,
      mutating: safety.mutating, protected: safety.protected, repro_safe: safety.repro_safe,
    });
    normalized = ai ? normalizeAndClamp(ai, row, safety) : fallbackAnalysis(row, safety);
  } catch (err) {
    logger.warn(`[오류디버깅] 분석 실패 → fallback 사용: ${err.message}`);
    normalized = fallbackAnalysis(row, safety);
  }

  normalized.safety = safety;
  normalized.generated_at = new Date().toISOString();

  const verify_verdict = normalized.verify.verdict;
  const decider_verdict = normalized.decider.verdict;
  const transfer_blockers = transferGate(normalized, verify_verdict, decider_verdict);

  return { analysis: normalized, verify_verdict, decider_verdict, transfer_blockers, safety };
}

module.exports = {
  runAnalysis,
  computeSafety,
  transferGate,
  fallbackAnalysis,
  VERIFY_VERDICTS,
  DECIDER_VERDICTS,
};
