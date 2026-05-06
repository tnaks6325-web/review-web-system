/**
 * ═══════════════════════════════════════════════════════════
 * 실험 5: Tiered 모델 테스트 (Lite → Flash 2단계)
 *
 * 본 시스템 미적용 — 별도 테스트용
 *
 * 동작 원리:
 *   1차: gemini-2.0-flash-lite (빠름, ~2-4초) → 핵심 필드 추출 시도
 *   2차: 1차 결과가 불완전하면 gemini-2.5-flash (정확, ~9초) 재시도
 *
 * 사용법:
 *   GEMINI_API_KEY=your_key node experiments/test-tiered-model.js [image_path]
 *
 * 테스트 시나리오:
 *   - 성공률: lite 모델의 핵심 필드 추출 성공률 측정
 *   - 속도: lite vs flash 응답 시간 비교
 *   - 정확도: lite 추출 결과 vs flash 추출 결과 비교
 * ═══════════════════════════════════════════════════════════
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// ── 설정 ──
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('❌ GEMINI_API_KEY 환경변수를 설정하세요.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const modelLite = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
const modelFlash = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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

// ── 핵심 필드 완성도 체크 ──
const REQUIRED_FIELDS = ['recipient', 'phone', 'address'];

function isComplete(result) {
  return REQUIRED_FIELDS.every(f => result[f] && result[f].trim().length > 0);
}

function parseResponse(text) {
  const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// ── 단일 모델 호출 ──
async function callModel(model, modelName, imagePart) {
  const start = Date.now();
  try {
    const result = await model.generateContent([EXTRACT_PROMPT, imagePart]);
    const text = result.response.text();
    const parsed = parseResponse(text);
    const elapsed = Date.now() - start;

    return {
      ok: !!parsed,
      modelName,
      elapsed,
      result: parsed || {},
      complete: parsed ? isComplete(parsed) : false,
      raw: text.substring(0, 300),
    };
  } catch (err) {
    return {
      ok: false,
      modelName,
      elapsed: Date.now() - start,
      result: {},
      complete: false,
      error: err.message,
    };
  }
}

// ── Tiered 전략 실행 ──
async function tieredExtract(base64Data, mimeType = 'image/jpeg') {
  const imagePart = {
    inlineData: { data: base64Data, mimeType },
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 1차: gemini-2.0-flash-lite 호출...');

  const liteResult = await callModel(modelLite, 'gemini-2.0-flash-lite', imagePart);

  console.log(`   ⏱️  ${liteResult.elapsed}ms`);
  console.log(`   ✅  성공: ${liteResult.ok}`);
  console.log(`   📋  완성도: ${liteResult.complete ? '✅ PASS (핵심 필드 모두 추출)' : '❌ FAIL (불완전)'}`);

  if (liteResult.ok && liteResult.complete) {
    console.log('\n🎉 Lite 모델로 충분! Flash 호출 불필요.');
    console.log(`   총 소요: ${liteResult.elapsed}ms`);
    return { tier: 'lite_only', ...liteResult };
  }

  // 2차: Flash 모델
  console.log('\n🔄 2차: gemini-2.5-flash 호출 (Lite 결과 불완전)...');
  const flashResult = await callModel(modelFlash, 'gemini-2.5-flash', imagePart);

  console.log(`   ⏱️  ${flashResult.elapsed}ms`);
  console.log(`   ✅  성공: ${flashResult.ok}`);
  console.log(`   📋  완성도: ${flashResult.complete ? '✅ PASS' : '❌ FAIL'}`);

  const totalElapsed = liteResult.elapsed + flashResult.elapsed;
  console.log(`\n⚠️  총 소요: ${totalElapsed}ms (lite=${liteResult.elapsed}ms + flash=${flashResult.elapsed}ms)`);

  return { tier: 'flash_fallback', totalElapsed, lite: liteResult, flash: flashResult };
}

// ── 양쪽 병렬 비교 테스트 ──
async function parallelCompare(base64Data, mimeType = 'image/jpeg') {
  const imagePart = {
    inlineData: { data: base64Data, mimeType },
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 병렬 비교: Lite vs Flash 동시 호출...');

  const [liteResult, flashResult] = await Promise.all([
    callModel(modelLite, 'gemini-2.0-flash-lite', imagePart),
    callModel(modelFlash, 'gemini-2.5-flash', imagePart),
  ]);

  console.log('\n┌─────────────────────┬─────────────────────┐');
  console.log('│  gemini-2.0-flash-lite  │  gemini-2.5-flash    │');
  console.log('├─────────────────────┼─────────────────────┤');
  console.log(`│  ⏱️  ${String(liteResult.elapsed).padStart(5)}ms         │  ⏱️  ${String(flashResult.elapsed).padStart(5)}ms         │`);
  console.log(`│  성공: ${liteResult.ok ? '✅' : '❌'}              │  성공: ${flashResult.ok ? '✅' : '❌'}              │`);
  console.log(`│  완성: ${liteResult.complete ? '✅' : '❌'}              │  완성: ${flashResult.complete ? '✅' : '❌'}              │`);
  console.log('└─────────────────────┴─────────────────────┘');

  // 정확도 비교
  if (liteResult.ok && flashResult.ok) {
    console.log('\n📋 필드별 비교:');
    const allFields = ['orderNumber', 'recipient', 'phone', 'address', 'price', 'orderer', 'productName', 'orderDate', 'store'];
    for (const field of allFields) {
      const lv = (liteResult.result[field] || '').trim();
      const fv = (flashResult.result[field] || '').trim();
      const match = lv === fv;
      console.log(`   ${match ? '✅' : '⚠️ '} ${field.padEnd(14)} │ Lite: "${lv}" │ Flash: "${fv}"`);
    }
  }

  return { lite: liteResult, flash: flashResult };
}

// ── Main ──
async function main() {
  const imagePath = process.argv[2];

  if (!imagePath) {
    console.log(`
사용법: GEMINI_API_KEY=xxx node experiments/test-tiered-model.js <image_path>

예시:
  node experiments/test-tiered-model.js ./test-order-capture.jpg

테스트 모드:
  --tiered   : Tiered 전략 테스트 (기본)
  --compare  : 병렬 비교 테스트

이 스크립트는 본 시스템에 적용되지 않습니다.
적용 결정 시 gemini.service.js의 extractOrderFromImage를 수정하세요.
`);
    process.exit(0);
  }

  // 이미지 읽기
  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) {
    console.error(`❌ 파일을 찾을 수 없습니다: ${absPath}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(absPath);
  const base64 = buffer.toString('base64');
  const ext = path.extname(absPath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

  console.log(`📁 이미지: ${absPath} (${(buffer.length / 1024).toFixed(1)}KB, ${mimeType})`);

  const mode = process.argv[3] || '--tiered';

  if (mode === '--compare') {
    await parallelCompare(base64, mimeType);
  } else {
    await tieredExtract(base64, mimeType);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💡 결론:');
  console.log('   - Lite 모델이 핵심 필드를 충분히 추출하면: 평균 ~3초 (9초 대비 66% 단축)');
  console.log('   - Lite 실패 시 Flash 폴백: 최악 ~12초 (오히려 느림)');
  console.log('   - 적용 판단: Lite 성공률이 80%+ 이면 도입 가치 있음');
  console.log('');
}

main().catch(err => {
  console.error(`❌ 오류: ${err.message}`);
  process.exit(1);
});
