/**
 * ═══════════════════════════════════════════════════════════
 * Gemini AI Service — 구매캡쳐 이미지 분석 + 주소 비교
 *
 * 기능:
 *   1. extractOrderFromImage()  — 캡쳐 이미지 → 주문정보 추출
 *   2. verifyAddressMatch()     — 네이버/쿠팡 주소 동일인 비교
 *
 * 필요 환경변수:
 *   GEMINI_API_KEY       — 기본 API 키 (필수)
 *   GEMINI_API_KEYS      — 멀티 키 (쉼표 구분, 선택) — 라운드로빈 부하 분산
 *
 * v2.16.9 개선:
 *   - 멀티 API 키 라운드로빈 (처리량 N배 확장)
 *   - 결과 캐싱 (동일 이미지 재요청 시 0ms 응답)
 * ═══════════════════════════════════════════════════════════
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

// ── 멀티 키 라운드로빈 풀 ──
const _modelPool = [];    // [{ genAI, model, key(마스킹) }]
let _poolIndex = 0;

// 모델/생성 설정 — 기본을 thinking 없는 빠른 모델로. 필요시 GEMINI_MODEL로 override.
// ※ gemini-2.0-flash 는 구글에서 단종(404)되어 현행 모델로 기본값 변경.
//   배포 환경에서는 GEMINI_MODEL 환경변수로 명시 지정 권장(AI Studio 모델 목록 확인).
// ★ gemini-2.5-flash 는 thinking 이 기본 ON 이라, 작은 maxOutputTokens(800) 에서는
//   추론이 출력 토큰을 다 먹어 본문 JSON 이 빈/잘린 채(MAX_TOKENS) 반환되어
//   "분석 완료인데 전 필드 추출 실패"가 발생한다. → thinkingBudget:0 으로 끄고 토큰 상향.
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEN_CONFIG = {
  temperature: 0,                       // 결정적 출력(추출 안정)
  maxOutputTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '2048', 10),
  responseMimeType: 'application/json',  // JSON 강제 → 파싱 신뢰 + 응답 단축
  // thinking 비활성(2.5 계열). 미지원 모델/SDK에서는 무시되므로 안전.
  thinkingConfig: { thinkingBudget: 0 },
};
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '9000', 10);

const _sleep = ms => new Promise(r => setTimeout(r, ms));
function _withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// 라운드로빈 + 일시오류 시 키회전 재시도 + 호출 타임아웃
// genConfigOverride: 호출별 generationConfig 덮어쓰기(예: maxOutputTokens 확대)
async function _runModel(parts, label, genConfigOverride) {
  if (!_initGemini()) throw new Error('Gemini API가 설정되지 않았습니다. GEMINI_API_KEY(S)를 확인하세요.');
  const attempts = Math.max(2, Math.min(_modelPool.length, 3));
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const { model, key } = _getModel();
    try {
      const req = genConfigOverride
        ? { contents: [{ role: 'user', parts: Array.isArray(parts) ? parts : [parts] }],
            generationConfig: { ...GEN_CONFIG, ...genConfigOverride } }
        : parts;
      const res = await _withTimeout(model.generateContent(req), GEMINI_TIMEOUT_MS, `[Gemini ${label}]`);
      return { text: res.response.text(), key };
    } catch (e) {
      lastErr = e;
      const msg = e.message || '';
      const transient = /429|quota|rate|exhaust|deadline|timeout|unavailable|50[023]|ECONN|ETIMEDOUT|fetch failed|socket hang/i.test(msg);
      logger.warn(`[Gemini] ${label} 시도 ${i + 1}/${attempts} 실패(key=${key}): ${msg}`);
      if (i < attempts - 1 && transient) { await _sleep(250 * (i + 1)); continue; }
      break;
    }
  }
  throw lastErr;
}

function _initGemini() {
  if (_modelPool.length > 0) return true;

  // 멀티 키: GEMINI_API_KEYS (쉼표 구분) 우선, 없으면 GEMINI_API_KEY 단일
  const multiKeys = process.env.GEMINI_API_KEYS;
  const singleKey = process.env.GEMINI_API_KEY;
  const keys = multiKeys
    ? multiKeys.split(',').map(k => k.trim()).filter(Boolean)
    : (singleKey ? [singleKey] : []);

  if (keys.length === 0) {
    logger.warn('[Gemini] GEMINI_API_KEY(S) 환경변수 미설정 — AI 기능 비활성화');
    return false;
  }

  try {
    for (const key of keys) {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({ model: MODEL_NAME, generationConfig: GEN_CONFIG });
      _modelPool.push({ genAI, model, key: key.slice(0, 6) + '...' });
    }
    logger.info(`[Gemini] 초기화 완료 (${MODEL_NAME} × ${_modelPool.length}키 라운드로빈, JSON모드, timeout ${GEMINI_TIMEOUT_MS}ms)`);
    return true;
  } catch (err) {
    logger.error(`[Gemini] 초기화 실패: ${err.message}`);
    return false;
  }
}

// 라운드로빈으로 모델 선택
function _getModel() {
  const entry = _modelPool[_poolIndex % _modelPool.length];
  _poolIndex++;
  return entry;
}

// ── 결과 캐시 (인메모리, LRU 방식) ──
const _extractCache = new Map(); // key: imageHash → { result, ts }
const CACHE_TTL = 10 * 60 * 1000; // 10분
const CACHE_MAX_SIZE = 200;

function _getCacheKey(base64Data) {
  // 이미지 데이터의 MD5 해시 (빠르고 충분)
  const clean = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
  return crypto.createHash('md5').update(clean.slice(0, 50000)).digest('hex');
  // 첫 50KB만 해시 — 대부분의 이미지를 구분하기 충분하며 해싱 비용 절약
}

function _getFromCache(hash) {
  const entry = _extractCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _extractCache.delete(hash);
    return null;
  }
  return entry.result;
}

function _putToCache(hash, result) {
  // LRU: 최대 크기 초과 시 가장 오래된 항목 삭제
  if (_extractCache.size >= CACHE_MAX_SIZE) {
    const firstKey = _extractCache.keys().next().value;
    _extractCache.delete(firstKey);
  }
  _extractCache.set(hash, { result, ts: Date.now() });
}

// ═══════════════════════════════════════════════════════════
// 1. 구매캡쳐 이미지 → 주문정보 추출
// ═══════════════════════════════════════════════════════════

const EXTRACT_PROMPT = `당신은 한국 온라인 쇼핑몰 주문 캡쳐 이미지를 분석하는 전문가입니다.

이미지에서 다음 정보를 추출해주세요. 찾을 수 없는 항목은 빈 문자열("")로 반환하세요.

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "orderNumber": "주문번호",
  "recipient": "수취인/받는분 이름",
  "phone": "연락처/전화번호",
  "address": "배송지 주소",
  "price": "결제금액/상품금액",
  "orderer": "주문자 이름",
  "productName": "상품명",
  "orderDate": "주문일자",
  "store": "쇼핑몰명 (네이버, 쿠팡, 11번가 등)"
}

주의사항:
- 전화번호는 하이픈(-) 포함 그대로 추출 (예: 010-1234-5678)
- 금액은 숫자와 쉼표만 추출 (예: 15,900)
- 주소는 전체 주소를 한 줄로 추출
- 이미지가 주문 캡쳐가 아닌 경우 모든 필드를 빈 문자열로 반환`;

async function extractOrderFromImage(base64Data, mimeType = 'image/jpeg') {
  if (!_initGemini()) {
    throw new Error('Gemini API가 설정되지 않았습니다. GEMINI_API_KEY 환경변수를 확인하세요.');
  }

  const startTime = Date.now();

  // ── 4번: 캐시 확인 ──
  const cacheHash = _getCacheKey(base64Data);
  const cached = _getFromCache(cacheHash);
  if (cached) {
    const elapsed = Date.now() - startTime;
    logger.info(`[Gemini] 캐시 HIT: ${elapsed}ms (hash=${cacheHash.slice(0, 8)})`);
    return { ...cached, elapsed, cached: true };
  }

  try {
    // base64 데이터에서 data URL prefix 제거 (있는 경우)
    const cleanBase64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');

    const imagePart = {
      inlineData: {
        data: cleanBase64,
        mimeType: mimeType || 'image/jpeg',
      },
    };

    // ── 라운드로빈 + 재시도 + 타임아웃 ──
    const { text, key: usedKey } = await _runModel([EXTRACT_PROMPT, imagePart], 'extract');

    // 빈 응답 가드: thinking 이 토큰을 다 먹거나 잘리면 text 가 빈 문자열로 온다.
    // 이 경우 ok:true 로 위장(전 필드 공란)하면 "분석 완료인데 추출 실패"가 되므로 명시적 에러.
    if (!text || !text.trim()) {
      throw new Error('AI 응답이 비어 있습니다 (출력 토큰 초과/잘림 추정). 다시 시도해주세요.');
    }

    // JSON 파싱 (마크다운 코드블록 제거)
    const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let extracted;
    try {
      extracted = JSON.parse(jsonStr);
    } catch (parseErr) {
      logger.warn(`[Gemini] JSON 파싱 실패, 텍스트: ${text.substring(0, 200)}`);
      // 부분 파싱 시도
      extracted = _fallbackParse(text);
    }

    // 핵심 필드가 전부 공란이면 추출 실패로 간주 — 빈 결과를 성공/캐시로 남기지 않는다.
    const _v = k => String(extracted[k] || '').trim();
    const allBlank = !['orderNumber', 'recipient', 'phone', 'address', 'price'].some(_v);
    if (allBlank) {
      logger.warn(`[Gemini] 추출 결과 전 필드 공란 (key=${usedKey}, 응답: ${text.substring(0, 200)})`);
      throw new Error('주문 정보를 인식하지 못했습니다. 주문 캡처 이미지가 맞는지 확인 후 다시 시도해주세요.');
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[Gemini] 이미지 분석 완료: ${elapsed}ms, key=${usedKey}, 수취인=${extracted.recipient || '-'}, 주문번호=${extracted.orderNumber || '-'}`);

    const finalResult = { ok: true, ...extracted };

    // ── 4번: 결과 캐시 저장 (성공한 결과만) ──
    _putToCache(cacheHash, finalResult);

    return { ...finalResult, elapsed };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`[Gemini] 이미지 분석 실패 (${elapsed}ms): ${err.message}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// 2. 주소 동일인 비교 (NC 모드: 네이버 vs 쿠팡)
// ═══════════════════════════════════════════════════════════

const VERIFY_PROMPT = `당신은 온라인 쇼핑몰 주문 정보를 비교하는 전문가입니다.

아래 두 쇼핑몰의 주문 정보를 비교하여 **동일인의 주문인지** 판단해주세요.

[네이버 주문]
- 수취인: {naverRecipient}
- 전화번호: {naverPhone}
- 주소: {naverAddress}

[쿠팡 주문]
- 수취인: {coupangRecipient}
- 전화번호: {coupangPhone}
- 주소: {coupangAddress}

판단 기준:
1. 이름이 동일하거나 유사한가 (한 글자 차이, 닉네임 등 허용)
2. 전화번호가 동일한가 (하이픈 유무 무시, 뒷 8자리 일치 시 동일)
3. 주소가 동일한 장소인가 (표기 차이 허용: 아파트명 약칭, 층/호 표기 등)

반드시 아래 JSON 형식으로만 응답하세요:
{
  "isSamePerson": true 또는 false,
  "confidence": 0.0~1.0 사이 확신도,
  "reason": "판단 근거 한 줄 요약"
}`;

async function verifyAddressMatch(naverInfo, coupangInfo) {
  if (!_initGemini()) {
    throw new Error('Gemini API가 설정되지 않았습니다.');
  }

  const startTime = Date.now();

  try {
    const prompt = VERIFY_PROMPT
      .replace('{naverRecipient}', naverInfo.recipient || '')
      .replace('{naverPhone}', naverInfo.phone || '')
      .replace('{naverAddress}', naverInfo.address || '')
      .replace('{coupangRecipient}', coupangInfo.recipient || '')
      .replace('{coupangPhone}', coupangInfo.phone || '')
      .replace('{coupangAddress}', coupangInfo.address || '');

    // ── 라운드로빈 + 재시도 + 타임아웃 ──
    const { text } = await _runModel(prompt, 'verify');

    const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      logger.warn(`[Gemini] 주소비교 JSON 파싱 실패: ${text.substring(0, 200)}`);
      parsed = { isSamePerson: false, confidence: 0, reason: 'AI 응답 파싱 실패' };
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[Gemini] 주소비교 완료: ${elapsed}ms, 동일인=${parsed.isSamePerson}, 확신도=${parsed.confidence}`);

    return {
      ok: true,
      isSamePerson: !!parsed.isSamePerson,
      confidence: parsed.confidence || 0,
      reason: parsed.reason || '',
      elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`[Gemini] 주소비교 실패 (${elapsed}ms): ${err.message}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// 헬퍼: JSON 파싱 실패 시 텍스트에서 키-값 추출 시도
// ═══════════════════════════════════════════════════════════

function _fallbackParse(text) {
  const result = {
    orderNumber: '', recipient: '', phone: '', address: '',
    price: '', orderer: '', productName: '', orderDate: '', store: '',
  };

  const patterns = {
    orderNumber: /["']?orderNumber["']?\s*:\s*["']([^"']+)["']/i,
    recipient:   /["']?recipient["']?\s*:\s*["']([^"']+)["']/i,
    phone:       /["']?phone["']?\s*:\s*["']([^"']+)["']/i,
    address:     /["']?address["']?\s*:\s*["']([^"']+)["']/i,
    price:       /["']?price["']?\s*:\s*["']([^"']+)["']/i,
    orderer:     /["']?orderer["']?\s*:\s*["']([^"']+)["']/i,
    productName: /["']?productName["']?\s*:\s*["']([^"']+)["']/i,
    orderDate:   /["']?orderDate["']?\s*:\s*["']([^"']+)["']/i,
    store:       /["']?store["']?\s*:\s*["']([^"']+)["']/i,
  };

  for (const [key, regex] of Object.entries(patterns)) {
    const match = text.match(regex);
    if (match) result[key] = match[1].trim();
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 3. 이상로그 자연어 보강 — 에러를 관리자용 한 문장(한국어)으로 풀이
//    (errorLog.service 의 ERRORLOG_AI_ENRICH 토글에서 호출)
//    실패/미설정 시 null 반환 → 호출부는 템플릿 문장을 그대로 유지
// ═══════════════════════════════════════════════════════════
async function explainErrorKo({ flow, step, message, code } = {}) {
  try {
    if (!_initGemini()) return null;
    const prompt = `너는 웹 서비스 운영 담당자에게 장애 원인을 알려주는 한국어 도우미다.
아래 서버 에러를 비개발자 관리자도 이해할 수 있도록 "무엇이 / 어디서 / 왜" 가 드러나는 한 문장으로 풀이하라.
- 한국어 1문장, 80자 이내, 추측은 단정하지 말고 "~로 보입니다" 식으로.
- 기능: ${flow || '미상'} / 단계: ${step || '미상'} / 코드: ${code || '없음'}
- 원본 에러: ${String(message || '').slice(0, 400)}
반드시 JSON 으로만 답하라: {"explanation": "..."}`;

    const { text } = await _runModel([{ text: prompt }], '[ErrorExplain]');
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      const m = text && text.match(/"explanation"\s*:\s*"([^"]+)"/);
      obj = m ? { explanation: m[1] } : null;
    }
    const out = obj && typeof obj.explanation === 'string' ? obj.explanation.trim() : '';
    return out ? out.slice(0, 200) : null;
  } catch (err) {
    logger.warn(`[Gemini] 이상로그 보강 실패(무시): ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 4. 오류디버깅 다중 에이전트 분석 — 레드팀/블루팀/감독관/예방가드/결정자
//    (errorDebug.service 의 "오류검증 및 분석"에서 호출)
//    ★ 실제 코드를 수정하거나 운영 작업을 재현하지 않는다(정적 분석 + 추론만).
//    실패/미설정 시 null 반환 → 호출부가 규칙기반 fallback 으로 대체.
// ═══════════════════════════════════════════════════════════
async function analyzeErrorAgents(p = {}) {
  try {
    if (!_initGemini()) return null;
    const safe = (v, n) => String(v == null ? '' : v).slice(0, n);
    const prompt = `너는 리뷰웹시스템의 "오류 디버깅 다중 에이전트"다.
아래 수집된 오류 1건을 즉시 수정하지 말고, 역할을 분리해 분석하라.
규칙:
- 실제 코드 수정이나 운영 작업(저장/삭제/발송/결제/상태변경/외부 API 실행)을 재현하지 않는다. 정적 추론만.
- mutating(쓰기) 요청이거나 보호대상(리뷰주문/결제/계정/외부API/대량작업)이면 자동 재현은 차단(blocked)으로 본다.
- 추측은 단정하지 말고 한국어로 간결히. 모든 텍스트는 한국어.

[오류 입력]
- 오류범주(category): ${safe(p.category, 40)}
- 심각도(severity): ${safe(p.severity, 20)}
- 기능/단계: ${safe(p.flow_ko, 40)} / ${safe(p.step_ko, 40)}
- 발생화면/위치(source): ${safe(p.source, 40)}
- HTTP: ${safe(p.method, 10)} ${safe(p.path, 120)} ${safe(p.statusCode, 8)}
- 한글요약(message_ko): ${safe(p.message_ko, 200)}
- 원본오류(message_raw): ${safe(p.message_raw, 400)}
- 오류코드: ${safe(p.error_code, 60)}
- 발생횟수: ${safe(p.occurrence_count, 12)}
- 쓰기요청 여부(mutating): ${p.mutating ? '예' : '아니오'}
- 보호대상 관련(protected): ${p.protected ? '예' : '아니오'}
- 자동재현 안전(repro_safe): ${p.repro_safe ? '예' : '아니오'}

반드시 아래 JSON 스키마로만 답하라(키 누락 금지):
{
  "verify": {"verdict":"likely_reproducible|not_reproduced_static|likely_resolved_by_other_change|blocked","evidence":"근거 1~2문장","next_action":"다음 처리 방향"},
  "red_team": {"conditions":"발생 조건","user_impact":"사용자 피해","data_risk":"방치 시 데이터/상태 문제","recurrence":"재발 조건"},
  "blue_team": {"input_validation":"입력검증 방어","exception_handling":"예외처리","state_guard":"상태전이 방어","idempotency":"중복실행 방지","external_api":"외부 API 실패 처리","regression_tests":"회귀 테스트"},
  "supervisor": {"overreach":"원인분석 과한지","scope":"수정범위 적정성","symptom_vs_cause":"증상만 막는지","side_effects":"정상흐름 영향","narrowest_fix":"가장 좁고 안전한 해결책"},
  "prevention_guard": {"affected_screens":"영향 화면","affected_apis":"영향 API","data_flows":"영향 데이터 흐름","external_impact":"외부 연동 영향","new_risks":"새로 생길 오류","blockers":["구현 전 차단 조건(없으면 빈 배열)"],"must_verify":["필수 검증 항목(최소 1개)"],"safe_to_implement":true},
  "decider": {"verdict":"implement|implement_after_preflight|needs_more_context|ignore","reason":"판정 근거"},
  "preflight": ["implement_after_preflight 시 사전 확인 항목(아니면 빈 배열)"],
  "go_no_go": "진행/중단 기준(implement_after_preflight 시 필수)",
  "fix_scope": "수정 범위",
  "test_plan": "테스트 계획",
  "residual_risk": "잔여 위험",
  "summary_ko": "한 줄 요약"
}`;

    const { text } = await _runModel([{ text: prompt }], '[ErrorAgents]', { maxOutputTokens: 2048 });
    let obj = null;
    try { obj = JSON.parse(text); }
    catch (_) {
      const m = text && text.match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch (_) { obj = null; } }
    }
    return obj && typeof obj === 'object' ? obj : null;
  } catch (err) {
    logger.warn(`[Gemini] 오류 에이전트 분석 실패(무시): ${err.message}`);
    return null;
  }
}

module.exports = {
  extractOrderFromImage,
  verifyAddressMatch,
  explainErrorKo,
  analyzeErrorAgents,
};
