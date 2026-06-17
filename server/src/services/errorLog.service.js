/**
 * 이상로그(비정상 이벤트) 서비스
 * ------------------------------------------------------------------
 * 목적: 정상 로그가 아닌 "비정상(에러/이상징후)"만 영구 저장하고,
 *       관리자가 근본원인을 바로 인지하도록 자연어(한국어) 문장으로 풀이한다.
 *
 *   예) "구매양식제출 이미지 업로드에서 로딩시간 초과(타임아웃) 에러가
 *        외부 API(구글 등)에서 발생했습니다"
 *
 * 설계 원칙:
 *   - ★ 완전 fail-safe: 로깅 실패가 절대 요청 흐름을 깨지 않는다(전체 try/catch).
 *   - 기존 Winston logger / Sentry captureException 파이프라인을 그대로 병행.
 *   - 같은 유형 에러는 fingerprint 로 묶어 occurrence_count 만 증가(중복 폭주 방지).
 *
 * 사용: logAbnormal({ flow, step, category, source, severity, error, context })
 *       — 반환값(Promise)은 무시(await 불필요, fire-and-forget) 해도 안전.
 */
const crypto = require('crypto');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { captureException } = require('../utils/sentry');

const ENABLED = process.env.ERRORLOG_ENABLED !== 'false'; // 기본 ON
const AI_ENRICH = process.env.ERRORLOG_AI_ENRICH === 'true'; // 기본 OFF — 미분류 건만 Gemini 보강

// ── 한국어 사전 (자연어 문장 합성용) ──
// flow: 어떤 기능/플로우에서
const FLOW_LABELS = {
  order_submit:  '구매양식제출',
  review_submit: '리뷰제출',
  image_upload:  '이미지 업로드',
  image_extract: 'AI 이미지분석',
  sheet_write:   '시트 기록',
  sync_queue:    '동기화 큐',
  index_build:   '인덱스 빌드',
  reviewer:      '리뷰어 등록',
  admin:         '관리자 작업',
  campaign:      '캠페인 관리',
  drive:         'Drive 연동',
  db:            'DB',
  cron:          '스케줄러 작업',
  client:        '웹 화면',
  unknown:       '시스템',
};

// step: 어떤 단계에서 (없으면 생략)
const STEP_LABELS = {
  image_upload:  '이미지 업로드',
  drive_upload:  'Drive 업로드',
  gemini_call:   'AI 분석 호출',
  sheet_write:   '시트 쓰기',
  enqueue:       '큐 등록',
  process_queue: '큐 처리',
  db_insert:     'DB 저장',
  db_query:      'DB 조회',
  folder_create: '폴더 생성',
  auth:          '인증',
};

// category: 무엇이(어떤 종류의) 에러가
const CATEGORY_PHRASES = {
  timeout:      '로딩시간 초과(타임아웃) 에러가',
  quota:        'API 호출한도 초과(quota) 에러가',
  network:      '네트워크 연결 오류가',
  auth:         '인증 오류가',
  permission:   '접근 권한 오류가',
  validation:   '입력값 검증 오류가',
  db:           '데이터베이스 오류가',
  external_api: '외부 API 오류가',
  not_found:    '대상을 찾지 못하는 오류가',
  unknown:      '알 수 없는 오류가',
};

// source: 어디서 발생했는지
const SOURCE_PHRASES = {
  server:       '서버에서 발생했습니다',
  external_api: '외부 API(구글 등)에서 발생했습니다',
  db:           '데이터베이스에서 발생했습니다',
  client:       '사용자 브라우저에서 발생했습니다',
};

/**
 * 자연어(한국어) 설명 문장 합성
 * "구매양식제출 이미지 업로드에서 로딩시간 초과(타임아웃) 에러가 외부 API(구글 등)에서 발생했습니다"
 */
function composeKo({ flowKo, stepKo, category, source }) {
  const cat = CATEGORY_PHRASES[category] || CATEGORY_PHRASES.unknown;
  const src = SOURCE_PHRASES[source] || SOURCE_PHRASES.server;
  const where = stepKo ? `${flowKo} ${stepKo}에서` : `${flowKo}에서`;
  return `${where} ${cat} ${src}`;
}

/**
 * 에러 객체에서 종류(category) 자동 분류
 * (gemini.service.js 의 transient 판별 패턴과 일관)
 */
function classify(error) {
  const msg = (error && (error.message || String(error))) || '';
  const code = (error && (error.code || error.name)) || '';
  const status = (error && (error.status || error.statusCode)) || 0;
  const hay = `${msg} ${code} ${status}`;

  if (/ETIMEDOUT|timed?\s?out|timeout|타임아웃|deadline|로딩시간|ESOCKETTIMEDOUT/i.test(hay)) return 'timeout';
  // quota: 'exhaust' 단독은 'pool exhausted'(DB) 등과 충돌하므로 RESOURCE_EXHAUSTED 형태로만 매칭
  if (/429|quota|rate.?limit|RESOURCE_EXHAUSTED|호출한도|한도\s?초과/i.test(hay)) return 'quota';
  if (status === 401 || /unauthor|invalid token|토큰|인증\s?(실패|만료)|SessionExpired/i.test(hay)) return 'auth';
  if (status === 403 || /forbidden|permission|권한|CORS/i.test(hay)) return 'permission';
  if (status === 404 || /not.?found|찾을 수 없|존재하지 않/i.test(hay)) return 'not_found';
  // ECONNABORTED/aborted: 연결 중단(클라이언트 끊김 등). timeout 메시지는 위에서 먼저 잡힘.
  if (/ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EHOSTUNREACH|socket hang|request aborted|aborted|fetch failed|network|네트워크/i.test(hay)) return 'network';
  // Postgres SQLSTATE (23xxx 무결성, 08xxx 연결, 57xxx 운영, 53xxx 자원) 또는 pg 키워드
  if (/^(08|23|53|57)/.test(String(code)) || /\bpool\b|relation .* does not exist|duplicate key|deadlock|postgres|database|데이터베이스/i.test(hay)) return 'db';
  if (/googleapis|google api|drive|sheets|gemini|외부 ?api/i.test(hay)) return 'external_api';
  if (/invalid|required|필수|유효하지|검증|올바르지/i.test(hay)) return 'validation';
  return 'unknown';
}

/**
 * 발생 위치(source) 추론
 */
function inferSource(category, flow, step) {
  if (category === 'db') return 'db';
  if (flow === 'client') return 'client';
  if (category === 'quota' || category === 'external_api') return 'external_api';
  const ext = ['drive_upload', 'gemini_call', 'sheet_write'];
  if (ext.includes(step) || ['image_upload', 'image_extract', 'sheet_write', 'drive'].includes(flow)) return 'external_api';
  return 'server';
}

/**
 * 중복 그룹핑 fingerprint (메시지 내 숫자/ID 정규화 후 해시)
 */
function fingerprint({ flow, step, category, source, message_raw }) {
  const norm = String(message_raw || '').replace(/\d+/g, '#').slice(0, 160);
  return crypto.createHash('sha1')
    .update([flow, step, category, source, norm].join('|'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * AI 자연어 보강 (best-effort) — 미분류 건의 message_ko 를 Gemini 한 문장으로 교체.
 * 지연 require 로 순환참조 회피. 실패 시 아무것도 안 함(템플릿 문장 유지).
 */
async function _enrichWithAI(rowId, { flow, step, message_raw, error_code }) {
  try {
    const { explainErrorKo } = require('./gemini.service');
    const sentence = await explainErrorKo({ flow, step, message: message_raw, code: error_code });
    if (!sentence) return;
    // 보강 사이에 해결됐을 수 있으므로 미해결 행에만 반영
    await pool.query(
      `UPDATE error_logs SET message_ko = $1 WHERE id = $2 AND resolved = FALSE`,
      [sentence, rowId]
    );
    logger.info(`[이상로그] AI 보강 적용 #${rowId}: ${sentence}`);
  } catch (_) { /* noop — 템플릿 문장 유지 */ }
}

/**
 * 비정상 이벤트 1건 기록 (fail-safe, fire-and-forget 가능)
 *
 * @param {object}  p
 * @param {string}  p.flow      기능/플로우 키 (예: 'order_submit')
 * @param {string} [p.step]     단계 키 (예: 'image_upload')
 * @param {string} [p.category] 미지정 시 error 로부터 자동분류
 * @param {string} [p.source]   미지정 시 category/flow/step 으로 추론
 * @param {string} [p.severity] 'warn'|'error'|'critical' (기본 'error')
 * @param {Error|string} p.error 원본 에러
 * @param {object} [p.context]  { path, method, ip, userAgent, userId, requestId, extra... }
 */
async function logAbnormal(p = {}) {
  try {
    if (!ENABLED) return;

    const error = p.error || {};
    const flow = p.flow || 'unknown';
    const step = p.step || '';
    const category = p.category || classify(error);
    const source = p.source || inferSource(category, flow, step);
    const severity = ['warn', 'error', 'critical'].includes(p.severity) ? p.severity : 'error';

    const flowKo = FLOW_LABELS[flow] || FLOW_LABELS.unknown;
    const stepKo = STEP_LABELS[step] || '';
    const message_ko = composeKo({ flowKo, stepKo, category, source });

    const message_raw = (error && (error.message || String(error))) || '';
    const error_code = String((error && (error.code || error.name || error.status || error.statusCode)) || '');
    const stack = (error && error.stack ? String(error.stack) : '').split('\n').slice(0, 6).join('\n');
    const context = p.context && typeof p.context === 'object' ? p.context : {};
    const fp = fingerprint({ flow, step, category, source, message_raw });

    // ── 기존 파이프라인 병행 (제거하지 않음) ──
    logger.error(`[이상로그] ${message_ko} | ${flow}/${step || '-'} | ${message_raw}`);
    if (error instanceof Error) {
      try { captureException(error, { flow, step, category, source, ...context }); } catch (_) { /* noop */ }
    }

    // ── dedup UPSERT (미해결 동일 fingerprint 는 카운트만 증가) ──
    // ※ message_ko 는 DO UPDATE 에서 제외 — 같은 fingerprint 면 템플릿 문장은 동일하므로
    //   불필요하고, AI 보강(아래)으로 다듬은 문장이 재발 때마다 덮어쓰이는 것을 방지.
    const { rows: upserted } = await pool.query(
      `INSERT INTO error_logs
         (severity, flow, flow_ko, step, step_ko, category, source,
          message_ko, message_raw, error_code, stack, context, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (fingerprint) WHERE resolved = FALSE
       DO UPDATE SET
         occurrence_count = error_logs.occurrence_count + 1,
         last_seen_at     = NOW(),
         message_raw      = EXCLUDED.message_raw,
         error_code       = EXCLUDED.error_code,
         stack            = EXCLUDED.stack,
         context          = EXCLUDED.context,
         severity         = CASE
           WHEN error_logs.severity = 'critical' OR EXCLUDED.severity = 'critical' THEN 'critical'
           WHEN error_logs.severity = 'error'    OR EXCLUDED.severity = 'error'    THEN 'error'
           ELSE 'warn'
         END
       RETURNING id, occurrence_count`,
      [severity, flow, flowKo, step, stepKo, category, source,
       message_ko, message_raw, error_code, stack, JSON.stringify(context), fp]
    );

    // ── 선택: AI 자연어 보강 (ERRORLOG_AI_ENRICH=true, 미분류 건 최초 1회만) ──
    // 템플릿 문장은 이미 저장됨 → 보강은 best-effort 비동기, 실패해도 템플릿 유지.
    if (AI_ENRICH && category === 'unknown' && upserted[0] && upserted[0].occurrence_count === 1) {
      _enrichWithAI(upserted[0].id, { flow, step, message_raw, error_code });
    }
  } catch (logErr) {
    // ★ 로깅 실패는 절대 호출부로 전파하지 않는다.
    try { logger.warn(`[이상로그] 기록 실패(무시): ${logErr.message}`); } catch (_) { /* noop */ }
  }
}

module.exports = {
  logAbnormal,
  // 재사용/테스트용 내부 함수·사전 노출
  classify,
  inferSource,
  composeKo,
  fingerprint,
  FLOW_LABELS,
  STEP_LABELS,
  CATEGORY_PHRASES,
  SOURCE_PHRASES,
};
