/**
 * ═══════════════════════════════════════════════════════════
 * Gemini AI Service — 구매캡쳐 이미지 분석 + 주소 비교
 *
 * 기능:
 *   1. extractOrderFromImage()  — 캡쳐 이미지 → 주문정보 추출
 *   2. verifyAddressMatch()     — 네이버/쿠팡 주소 동일인 비교
 *
 * 필요 환경변수:
 *   GEMINI_API_KEY — Google AI Studio에서 발급한 API 키
 * ═══════════════════════════════════════════════════════════
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logger } = require('../utils/logger');

// ── Gemini 클라이언트 초기화 ──
let genAI = null;
let model = null;

function _initGemini() {
  if (model) return true;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('[Gemini] GEMINI_API_KEY 환경변수 미설정 — AI 기능 비활성화');
    return false;
  }

  try {
    genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    logger.info('[Gemini] 초기화 완료 (gemini-2.0-flash)');
    return true;
  } catch (err) {
    logger.error(`[Gemini] 초기화 실패: ${err.message}`);
    return false;
  }
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

  try {
    // base64 데이터에서 data URL prefix 제거 (있는 경우)
    const cleanBase64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');

    const imagePart = {
      inlineData: {
        data: cleanBase64,
        mimeType: mimeType || 'image/jpeg',
      },
    };

    const result = await model.generateContent([EXTRACT_PROMPT, imagePart]);
    const response = result.response;
    const text = response.text();

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

    const elapsed = Date.now() - startTime;
    logger.info(`[Gemini] 이미지 분석 완료: ${elapsed}ms, 수취인=${extracted.recipient || '-'}, 주문번호=${extracted.orderNumber || '-'}`);

    return {
      ok: true,
      ...extracted,
      elapsed,
    };
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

    const result = await model.generateContent(prompt);
    const text = result.response.text();

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

module.exports = {
  extractOrderFromImage,
  verifyAddressMatch,
};
