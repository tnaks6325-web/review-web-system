/**
 * 쇼핑몰 상품페이지 → 공고 편집 상품 카드 「쇼핑몰에서 가져오기」 (결정 277 · 사용자 확정 2026-10-22 「1.나」)
 *
 * 확장 프로그램(INADD 리뷰오더 상품정보 가져오기 1.0.5+)이 직원 크롬에 열린 상품페이지의 상품 영역 글과
 * 페이지 속 상품 데이터를 읽어 공고 편집 화면에 넘기면, 화면이 이 서비스(POST /api/trackb/campaigns/product-page/extract)로 보낸다.
 * AI 가 그 글에서 상품명·가격·옵션(옵션별 가격)·배송비만 골라 돌려준다 — 화면이 확인 창을 띄우고
 * 사람이 고른 값만 카드에 들어간다(여기서는 아무것도 저장하지 않는다).
 *
 * ★ 원본 = 인트라넷 src/routes/product-page-reader.ts(같은 확장 프로그램 · 같은 판독 규칙). 판독 규칙을 고치면 두 곳을 함께 고친다
 *   — 같은 페이지를 두 시스템이 다르게 읽으면 리뷰오더와 공고 값이 갈라진다(양방향 동기화 대상).
 * [경계]
 *   · 받은 글은 저장하지 않고 로그에도 남기지 않는다(로그인 이름 같은 개인 정보가 섞여 올 수 있다).
 *   · 쇼핑몰(구매채널)은 AI 가 아니라 상품 주소로 정한다 — 주소가 없을 때만 AI 의 추정을 쓴다.
 *   · 「결제금액 제안」(가격 + 배송비 규칙)은 AI 가 아니라 이 파일의 계산으로 만든다. AI 는 숫자를 읽기만 한다.
 *   · 모집인원·일건수는 읽지도 채우지도 않는다(인트라넷과 같다 — 쇼핑몰 페이지에 없는 값).
 */
'use strict';

const MAX_INPUT_CHARS = 200000;      // 받는 글 상한(이보다 길면 거절)
const MAX_PROMPT_CHARS = 40000;      // AI 에 보내는 글 상한(상품 정보는 페이지 앞부분에 있다)
const MAX_PAGE_DATA_CHARS = 30000;   // 페이지 속 상품 데이터(JSON 문자열) 상한
const MAX_AMOUNT = 100000000;
const MAX_OPTIONS = 60;
const AI_TIMEOUT_MS = 45000;

const SYSTEM_PROMPT = [
  '너는 리뷰 체험단 작업을 등록하는 담당자를 돕는다. 쇼핑몰 상품페이지의 화면 글이 주어지고,',
  '쇼핑몰이 페이지에 넣어 둔 상품 데이터(JSON)가 함께 올 수 있다.',
  '그 안에서 "이 페이지의 주인공 상품" 한 개의 정보만 뽑아 JSON 으로 답한다.',
  '',
  '페이지 속 데이터 읽는 법:',
  '- 화면 글에 없는 옵션·배송비는 페이지 속 데이터에서 찾는다. 둘이 다르면 화면 글을 따른다.',
  '- product: 주인공 상품의 이름·판매가 후보. optionArrays: 페이지 속 옵션 배열(key·path 와 항목들). delivery: 배송비 정보.',
  '- 네이버 optionCombinations 의 price 는 기본 판매가에 "더하는 추가금"(음수면 빼는 금액)이다. optionName1~3 을 " / " 로 이어 옵션 이름으로 쓴다.',
  '  stockQuantity 가 0 이면 품절이다. 할인가는 discountedSalePrice 가 있으면 그것.',
  '  배송: deliveryFeeType 이 FREE 면 무료, CONDITIONAL_FREE 면 freeConditionalAmount 이상 무료, PAID 면 baseFee 가 배송비.',
  '- optionArrays 중 화면 설정용처럼 보이는(가격·옵션명이 없는) 배열은 무시한다.',
  '- jsonLd 의 offers.price 는 기본 판매가 후보다.',
  '',
  '반드시 지킬 것:',
  '- 글에 없는 숫자·옵션·조건은 절대 지어내지 않는다. 모르면 0 또는 빈 값으로 둔다.',
  '- 추천 상품, 함께 본 상품, 최근 본 상품, 장바구니, 광고, 다른 판매자 상품의 가격은 무시한다.',
  '- 로그인한 사람의 이름·주소·연락처 같은 개인 정보는 답에 넣지 않는다.',
  '- 금액은 원 단위 정수(쉼표·"원" 없이)로 쓴다.',
  '',
  '가격(prices): 글에 보이는 주인공 상품의 가격을 종류별로 모두 적는다(예: 정가, 판매가, 할인가, 쿠폰 적용가, 최대할인가, 회원가).',
  '  label 은 페이지에 적힌 말을 그대로 쓰고, condition 에 조건(쿠폰 받기 필요, 와우회원, 카드 결제 등)을 적는다.',
  '  카드 즉시할인·포인트 적립·캐시백은 가격이 아니므로 넣지 않는다.',
  'basePrice: 쿠폰 다운로드·특정 카드·멤버십 없이 누구나 결제하는 1개(기본 구성) 가격. 보통 할인가(판매가)다.',
  '',
  '옵션(options): 글에 펼쳐져 보이는 선택 항목을 모두 적는다(색상·사이즈·구성·수량 묶음 등).',
  '  글 끝의 "[펼치지 않은 옵션 목록 · …]" 블록은 화면에서 접혀 있던 옵션 목록이다 — 그 항목들도 옵션으로 적는다.',
  '  price 는 그 옵션을 골랐을 때의 상품 가격 "총액"이다. "+2,000원" 처럼 추가금만 보이면 basePrice 에 더하고,',
  '  "(-68,100원)" 처럼 빼는 금액이면 basePrice 에서 뺀 값을 쓴다. 금액 표시가 없는 옵션은 basePrice 와 같다.',
  '  "10개", "30개" 처럼 수량 묶음이면 isQuantityBundle=true, quantity 에 개수를 적는다.',
  '  품절 표시가 있으면 soldOut=true.',
  '  본품과 "함께 사는" 추가상품·추가구성(예: 고기 추가, 소스팩, 사은품 선택, "추가상품"·"추가옵션" 목록)은 본품 옵션이 아니다 —',
  '  isAddon=true 로 표시하고, 그 항목의 가격이 글에 없으면 price 는 0 으로 둔다(본품 가격을 넣지 않는다).',
  '  옵션 선택 칸만 있고 항목이 글에 펼쳐져 있지 않으면 options 는 빈 배열, optionsHidden=true 로 둔다.',
  '',
  '배송(shipping): fee=기본 배송비(무료면 0). freeThreshold="N원 이상 무료배송" 의 N(없으면 0). isFree=조건 없이 무료면 true.',
  '  회원 전용 무료배송(예: 와우회원 무료배송)이면 isFree=true 로 두고 condition 에 그 조건을 적는다.',
  '  evidence 에는 배송비를 판단한 원문 한 줄을 그대로 옮긴다.',
  '',
  'warnings: 담당자가 꼭 확인해야 할 점을 짧은 한국어 문장으로 적는다(예: 옵션 목록이 접혀 있어 읽지 못함, 가격이 여러 개라 선택 필요).',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    productName: { type: 'STRING' },
    mallGuess: { type: 'STRING' },
    basePrice: { type: 'INTEGER' },
    prices: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { label: { type: 'STRING' }, amount: { type: 'INTEGER' }, condition: { type: 'STRING' } },
        required: ['label', 'amount'],
      },
    },
    options: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' }, price: { type: 'INTEGER' },
          isQuantityBundle: { type: 'BOOLEAN' }, quantity: { type: 'INTEGER' }, soldOut: { type: 'BOOLEAN' }, isAddon: { type: 'BOOLEAN' },
        },
        required: ['name', 'price'],
      },
    },
    optionsHidden: { type: 'BOOLEAN' },
    shipping: {
      type: 'OBJECT',
      properties: {
        fee: { type: 'INTEGER' }, freeThreshold: { type: 'INTEGER' }, isFree: { type: 'BOOLEAN' },
        condition: { type: 'STRING' }, evidence: { type: 'STRING' },
      },
    },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['productName', 'basePrice', 'prices', 'options', 'shipping'],
};

const text = (value, maxLength = 500) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);

function toAmount(value) {
  const raw = typeof value === 'number' ? value : Number(String(value == null ? '' : value).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.round(raw), MAX_AMOUNT);
}

/** 상품 주소 → 공고 구매채널(공고 편집의 채널 버튼 값과 같다). 모르는 쇼핑몰은 ''(담당자가 직접 고른다). */
function channelFromUrl(url) {
  let host = '';
  try { host = new URL(String(url == null ? '' : url).trim()).hostname.toLowerCase(); } catch (_) { return ''; }
  const is = domain => host === domain || host.endsWith('.' + domain);
  if (is('coupang.com')) return '쿠팡';
  if (is('oliveyoung.co.kr')) return '올리브영';
  if (host === 'makers.kakao.com') return '카카오메이커스';
  if (is('naver.com')) return '네이버';
  return '';
}

function channelFromGuess(guess) {
  const g = text(guess, 40).replace(/\s/g, '');
  if (/쿠팡|coupang/i.test(g)) return '쿠팡';
  if (/올리브영|oliveyoung/i.test(g)) return '올리브영';
  if (/카카오메이커스|makers/i.test(g)) return '카카오메이커스';
  if (/네이버|스마트스토어|smartstore|naver/i.test(g)) return '네이버';
  return '';
}

/** 리뷰어가 실제로 결제할 금액 = 상품가 + 배송비. 조건 없는 무료배송이거나 「N원 이상 무료」 기준을 넘으면 배송비는 0. */
function suggestedPayFor(price, shipping) {
  if (!price) return 0;
  if (shipping.isFree || !shipping.fee) return price;
  if (shipping.freeThreshold && price >= shipping.freeThreshold) return price;
  return price + shipping.fee;
}

/** 정상 상품페이지 글인지 대충 본다 — 차단·로그인 화면을 읽어 온 경우를 AI 호출 전에 걸러낸다. */
function blockedPageReason(source, pageData = '') {
  const head = source.slice(0, 3000);
  const dataHasPrice = /"(?:salePrice|discountedSalePrice|price)"\s*:\s*"?\d{3,}/.test(pageData);
  if (/아이디\s*(또는\s*전화번호)?[\s\S]{0,40}비밀번호/.test(head) && !/\d{1,3}(,\d{3})+\s*원/.test(source)) {
    return '그 탭이 로그인 화면입니다. 상품페이지가 열린 상태에서 다시 가져와 주세요.';
  }
  if (/Access Denied|잠시만 기다려 주세요|사람인지 확인|자동입력 방지/.test(head) && !/\d{1,3}(,\d{3})+\s*원/.test(source)) {
    return '그 탭이 쇼핑몰의 확인 화면입니다. 상품페이지가 다 열린 뒤 다시 가져와 주세요.';
  }
  if (!dataHasPrice && !/\d{1,3}(,\d{3})+\s*원|\d{4,}\s*원/.test(source)) {
    return '그 탭에서 가격(원)을 찾지 못했습니다. 상품페이지가 다 열렸는지 확인해 주세요.';
  }
  return '';
}

/** 빈 줄·중복 공백을 줄여 AI 에 보낼 글을 만든다(앞부분 우선). */
function compactPageText(source) {
  return String(source == null ? '' : source)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_PROMPT_CHARS);
}

/** AI 가 준 JSON 을 믿지 않고 다시 다듬는다 — 숫자 범위·글자 수·옵션 개수·배송비 규칙. */
function normalizeExtraction(raw, url = '') {
  const src = raw && typeof raw === 'object' ? raw : {};
  const shippingRaw = src.shipping && typeof src.shipping === 'object' ? src.shipping : {};
  const shipping = {
    fee: toAmount(shippingRaw.fee),
    freeThreshold: toAmount(shippingRaw.freeThreshold),
    isFree: shippingRaw.isFree === true,
    condition: text(shippingRaw.condition, 120),
    evidence: text(shippingRaw.evidence, 200),
  };
  if (shipping.isFree && !shipping.condition) shipping.fee = 0;

  const prices = [];
  for (const p of Array.isArray(src.prices) ? src.prices : []) {
    const amount = toAmount(p && p.amount);
    const label = text(p && p.label, 40);
    if (!amount || !label) continue;
    if (prices.some(x => x.label === label && x.amount === amount)) continue;
    prices.push({ label, amount, condition: text(p && p.condition, 80) });
    if (prices.length >= 12) break;
  }

  let basePrice = toAmount(src.basePrice);
  if (!basePrice && prices.length) basePrice = Math.min(...prices.map(p => p.amount));

  const options = [];
  const seen = new Set();
  for (const o of Array.isArray(src.options) ? src.options : []) {
    // ★ 공고 선택지 키는 「|」 를 구분자로 쓴다(작업내용 원문 "상품|옵션") — 이름에 남기지 않는다
    const name = text(String((o && o.name) || '').replace(/\|/g, ' '), 120);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const price = toAmount(o && o.price);
    const quantity = Math.min(Math.max(Math.round(Number(o && o.quantity) || 0), 0), 10000);
    const isAddon = !!(o && o.isAddon === true);
    options.push({
      name, price,
      isQuantityBundle: !!(o && o.isQuantityBundle === true) && quantity > 0,
      quantity,
      soldOut: !!(o && o.soldOut === true),
      isAddon,
      suggestedPay: isAddon ? 0 : suggestedPayFor(price, shipping),
    });
    if (options.length >= MAX_OPTIONS) break;
  }

  const urlChannel = channelFromUrl(url);
  const aiChannel = urlChannel ? '' : channelFromGuess(src.mallGuess);
  const warnings = [];
  for (const w of Array.isArray(src.warnings) ? src.warnings : []) {
    const line = text(w, 160);
    if (line && !warnings.includes(line)) warnings.push(line);
    if (warnings.length >= 8) break;
  }
  if (shipping.isFree && shipping.condition && /회원|멤버십|와우|wow/i.test(shipping.condition)) {
    warnings.unshift(`무료배송이 「${shipping.condition}」 조건입니다. 리뷰어는 배송비를 낼 수 있으니 결제금액을 확인해 주세요.`);
  }
  if (src.optionsHidden === true && !options.length) {
    for (let i = warnings.length - 1; i >= 0; i--) if (/접혀|펼쳐/.test(warnings[i])) warnings.splice(i, 1);
    warnings.unshift('옵션 목록이 접혀 있어 옵션을 읽지 못했습니다. 상품페이지에서 옵션 목록을 펼쳐 둔 뒤 [다른 탭에서 가져오기]로 다시 가져오면 옵션까지 채웁니다.');
  }
  if (options.length && options.every(o => o.isAddon)) {
    warnings.push('읽은 목록이 본품 옵션이 아니라 함께 사는 추가상품입니다. 기본으로 체크를 꺼 두었습니다.');
  }
  if (new Set(prices.map(p => p.amount)).size > 1) {
    warnings.push('가격이 여러 개입니다. 리뷰어가 실제로 결제할 가격인지 확인해 주세요.');
  }

  return {
    productName: text(String(src.productName || '').replace(/\|/g, ' '), 200),
    channel: urlChannel || aiChannel,
    channelSource: urlChannel ? 'url' : aiChannel ? 'ai' : '',
    url: text(url, 2000),
    basePrice,
    basePay: suggestedPayFor(basePrice, shipping),
    prices,
    options,
    optionsHidden: src.optionsHidden === true && !options.length,
    shipping,
    warnings,
  };
}

function parseAiJson(raw) {
  const source = String(raw == null ? '' : raw).trim();
  if (!source) throw new Error('AI 응답이 비어 있습니다.');
  const candidates = [source];
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const braced = source.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate.trim()); } catch (_) { /* 다음 후보로 */ }
  }
  throw new Error('AI 응답을 읽지 못했습니다. 다시 시도해 주세요.');
}

/**
 * { text, url?, pageData? } → { status, body }  (저장 없음 · 받은 글 로그 금지)
 * deps.generate(prompt, opts) — 테스트가 AI 를 바꿔 끼운다(기본 = gemini.service.generateStructuredJson).
 */
async function extractProductPage(input, deps) {
  const generate = (deps && deps.generate) || require('./gemini.service').generateStructuredJson;
  const body = input && typeof input === 'object' ? input : {};
  const pageText = String(body.text == null ? '' : body.text);
  const pageData = String(body.pageData == null ? '' : body.pageData).slice(0, MAX_PAGE_DATA_CHARS);
  const url = text(body.url, 2000);
  if (!pageText.trim()) return { status: 400, body: { ok: false, error: '상품페이지 글이 비어 있습니다. 상품페이지가 다 열린 뒤 다시 가져와 주세요.' } };
  if (pageText.length > MAX_INPUT_CHARS) return { status: 400, body: { ok: false, error: '상품페이지 글이 너무 깁니다.' } };
  const blocked = blockedPageReason(pageText, pageData);
  if (blocked) return { status: 422, body: { ok: false, error: blocked } };

  const prompt = [
    url ? `상품 주소: ${url}` : '상품 주소: (담당자가 비워둠)',
    '',
    '상품페이지 화면 글:',
    '"""',
    compactPageText(pageText),
    '"""',
    pageData ? `\n페이지 속 상품 데이터(JSON):\n"""\n${pageData}\n"""` : '',
  ].join('\n');

  let raw;
  try {
    raw = await generate(prompt, {
      label: '[ProductPage]', systemInstruction: SYSTEM_PROMPT, responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 8192, timeoutMs: AI_TIMEOUT_MS, maxAttempts: 1,
    });
  } catch (e) {
    const msg = String((e && e.message) || '');
    if (/설정되지 않았습니다/.test(msg)) return { status: 503, body: { ok: false, error: 'AI 연결이 설정되지 않았습니다.' } };
    if (/timeout/i.test(msg)) return { status: 502, body: { ok: false, error: 'AI 응답이 늦어 중단했습니다. 다시 시도해 주세요.' } };
    return { status: 502, body: { ok: false, error: 'AI 읽기 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.' } };
  }
  let parsed;
  try { parsed = parseAiJson(raw); } catch (e) { return { status: 502, body: { ok: false, error: e.message } }; }
  const result = normalizeExtraction(parsed, url);
  if (!result.productName && !result.basePrice && !result.options.length) {
    return { status: 422, body: { ok: false, error: '상품페이지에서 상품 정보를 찾지 못했습니다. 다른 탭을 고르거나 페이지를 새로고침한 뒤 다시 가져와 주세요.' } };
  }
  return { status: 200, body: { ok: true, result } };
}

module.exports = {
  extractProductPage,
  normalizeExtraction, parseAiJson, blockedPageReason, compactPageText, suggestedPayFor, channelFromUrl, toAmount,
  SYSTEM_PROMPT, RESPONSE_SCHEMA,
};
