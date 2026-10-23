/**
 * 공고 편집 상품 카드 「쇼핑몰에서 가져오기」(결정 276) — 서버 판독 + 화면 연결부 회귀가드.
 *   (1) 판독 결과는 AI 를 믿지 않고 다시 다듬는다(배송비 규칙·추가상품·「|」 제거·구매채널은 주소로)
 *   (2) 빈 글·긴 글·차단 화면·AI 미설정·시간초과를 사람 말로 돌려준다 — 저장 없음, 받은 글 로그 금지
 *   (3) 라우트는 공고 편집 게이트(편집자만) 뒤 · /campaigns/:id 보다 앞
 *   (4) 화면은 모집인원·일건수를 채우지 않고, 확장 프로그램과는 externally_connectable 로만 이야기한다
 *   (5) Gemini 공용 실행기의 기본 동작(재시도 수·제한 시간)은 그대로
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };
const root = path.join(__dirname, '..', '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');
const svc = require('../src/services/productPageReader.service');
const svcSrc = rd('server/src/services/productPageReader.service.js');
const routes = rd('server/src/routes/trackB.routes.js');
const gemSrc = rd('server/src/services/gemini.service.js');
const shopSrc = rd('frontend/js/recruit-shop-import.js');

(async () => {
  console.log('\n[1] 판독 결과 다듬기');
  {
    const r = svc.normalizeExtraction({
      productName: '하늘 | 텀블러', basePrice: '12,900', mallGuess: '스마트스토어',
      prices: [{ label: '판매가', amount: 12900 }, { label: '판매가', amount: 12900 }, { label: '쿠폰가', amount: 11000, condition: '쿠폰 받기' }],
      options: [
        { name: '화이트|500ml', price: 12900 }, { name: '블랙', price: 14900, soldOut: true },
        { name: '화이트|500ml', price: 1 }, { name: '빨대 추가', price: 0, isAddon: true },
      ],
      shipping: { fee: 3000, freeThreshold: 30000 },
    }, 'https://smartstore.naver.com/x/products/1');
    ok('구매채널은 AI 추정이 아니라 주소로(네이버 · url)', r.channel === '네이버' && r.channelSource === 'url');
    ok('이름의 「|」 는 공백으로(선택지 키 구분자)', r.productName === '하늘 텀블러' && r.options[0].name === '화이트 500ml');
    ok('같은 이름 옵션은 한 번만', r.options.filter(o => o.name === '화이트 500ml').length === 1);
    ok('같은 가격·이름은 한 번만', r.prices.length === 2);
    ok('결제금액 제안 = 가격 + 배송비(기준 미만)', r.basePay === 15900 && r.options[0].suggestedPay === 15900);
    ok('추가상품은 결제금액 0', r.options.find(o => o.name === '빨대 추가').suggestedPay === 0);
    ok('품절 표시 유지', r.options.find(o => o.name === '블랙').soldOut === true);
    ok('가격이 여럿이면 경고', r.warnings.some(w => /가격이 여러 개/.test(w)));
    ok('모집인원·일건수 칸은 결과에 없다', !/recruit|daily|모집인원|일건수/.test(JSON.stringify(Object.keys(r).concat(Object.keys(r.options[0])))));
    const free = svc.normalizeExtraction({ productName: 'A', basePrice: 9000, prices: [], options: [], shipping: { fee: 3000, isFree: true } }, '');
    ok('조건 없는 무료배송 → 배송비 0', free.shipping.fee === 0 && free.basePay === 9000);
    const wow = svc.normalizeExtraction({ productName: 'A', basePrice: 9000, prices: [], options: [], shipping: { fee: 3000, isFree: true, condition: '와우회원' } }, 'https://www.coupang.com/vp/products/1');
    ok('회원 전용 무료배송은 경고', wow.warnings[0].includes('와우회원') && wow.channel === '쿠팡');
    const hidden = svc.normalizeExtraction({ productName: 'A', basePrice: 1000, prices: [], options: [], optionsHidden: true, warnings: ['옵션이 접혀 있음'], shipping: {} }, '');
    ok('접힌 옵션 안내는 한 줄로', hidden.optionsHidden === true && hidden.warnings.filter(w => /접혀/.test(w)).length === 1);
    ok('구매채널: 주소가 없으면 AI 추정', svc.normalizeExtraction({ mallGuess: '올리브영', shipping: {} }, '').channelSource === 'ai');
    ok('금액 상한·음수', svc.toAmount(-5) === 0 && svc.toAmount(1e12) === 100000000);
    ok('비슷한 가짜 주소는 쇼핑몰로 보지 않는다', svc.channelFromUrl('https://coupang.com.evil.example/x') === '');
  }

  console.log('\n[2] 요청 처리 — 저장 없음 · 사람 말 안내');
  {
    let seen = null;
    const fake = out => async (prompt, opts) => { seen = { prompt, opts }; if (out instanceof Error) throw out; return out; };
    const page = '하늘 텀블러\n판매가 12,900원\n배송비 3,000원';
    const r400 = await svc.extractProductPage({ text: '   ' }, { generate: fake('{}') });
    ok('빈 글 → 400', r400.status === 400 && /비어/.test(r400.body.error));
    const rLong = await svc.extractProductPage({ text: 'x'.repeat(200001) }, { generate: fake('{}') });
    ok('너무 긴 글 → 400', rLong.status === 400);
    const rLogin = await svc.extractProductPage({ text: '아이디 또는 전화번호\n비밀번호\n로그인' }, { generate: fake('{}') });
    ok('로그인 화면 → 422(AI 부르지 않음)', rLogin.status === 422 && /로그인 화면/.test(rLogin.body.error));
    seen = null;
    const rNoKey = await svc.extractProductPage({ text: page }, { generate: fake(new Error('Gemini API가 설정되지 않았습니다. GEMINI_API_KEY(S)를 확인하세요.')) });
    ok('AI 미설정 → 503', rNoKey.status === 503 && !/GEMINI/.test(rNoKey.body.error));
    const rTo = await svc.extractProductPage({ text: page }, { generate: fake(new Error('[Gemini [ProductPage]] timeout 45000ms')) });
    ok('시간초과 → 502 + 다시 시도 안내', rTo.status === 502 && /늦어/.test(rTo.body.error));
    const rBad = await svc.extractProductPage({ text: page }, { generate: fake('not json') });
    ok('AI 응답을 못 읽으면 502', rBad.status === 502);
    const rEmpty = await svc.extractProductPage({ text: page }, { generate: fake('{"productName":"","basePrice":0,"prices":[],"options":[],"shipping":{}}') });
    ok('상품 정보가 하나도 없으면 422', rEmpty.status === 422);
    const good = await svc.extractProductPage({ text: page, url: 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A1', pageData: '{"a":1}' },
      { generate: fake('```json\n{"productName":"하늘 텀블러","basePrice":12900,"prices":[],"options":[],"shipping":{"fee":3000}}\n```') });
    ok('성공 → 200 · 다듬은 결과', good.status === 200 && good.body.ok && good.body.result.basePay === 15900 && good.body.result.channel === '올리브영');
    ok('AI 호출: 판독 규칙·응답 모양·45초·재시도 없음', seen.opts.systemInstruction === svc.SYSTEM_PROMPT && seen.opts.responseSchema === svc.RESPONSE_SCHEMA &&
      seen.opts.timeoutMs === 45000 && seen.opts.maxAttempts === 1);
    ok('AI 에 주소·페이지 데이터를 함께 보낸다', /상품 주소: https:\/\/www\.oliveyoung/.test(seen.prompt) && /페이지 속 상품 데이터/.test(seen.prompt));
    ok('받은 글을 로그에 남기지 않는다(서비스에 로그 호출 없음)', !/logger|console\./.test(svcSrc));
    ok('DB 를 쓰지 않는다(저장 없음)', !/require\(['"]\.\.\/db|pool\.|query\(/.test(svcSrc));
  }

  console.log('\n[3] 라우트 — 편집자만 · 경로 순서');
  {
    const i = routes.indexOf("router.post('/campaigns/product-page/extract', authMiddleware, internalMiddleware, editorOnlyMiddleware, productPageLimiter,");
    ok('공고 편집 게이트 뒤 + 사람별 호출 제한(auth·내부인·편집자·제한)', i > 0);
    const rl = rd('server/src/middleware/rateLimit.middleware.js');
    ok('호출 제한은 사람별(로그인 면제 없음)', /const productPageLimiter = rateLimit\(\{[\s\S]*?'u:' \+ _staffKey\(req\)[\s\S]*?max: 12,/.test(rl) && !/productPageLimiter = rateLimit\(\{[\s\S]{0,600}skip:/.test(rl));
    ok('/campaigns/:id 보다 앞', i < routes.indexOf("router.get('/campaigns/:id'"));
    ok('응답은 캐시 금지', /product-page\/extract[\s\S]{0,200}Cache-Control', 'no-store'/.test(routes));
    ok('라우트 오류 로그는 오류 이름만(받은 글 금지)', /\[product-page\] 판독 실패: \$\{String\(e && e\.name \|\| 'Error'\)\}/.test(routes));
  }

  console.log('\n[4] 화면 연결부');
  {
    ok('모집인원·일건수 칸에는 쓰지 않는다', !/fill\([^)]*rf-opt-(rt|dl)/.test(shopSrc) && !/_buildOptRowEl\(\{[^}]*(recruitTotal|dailyLimit)/.test(shopSrc));
    ok('확장 프로그램과는 확장 ID 로 sendMessage(리뷰웹 화면에 확장 스크립트를 심지 않는다)', /rt\.sendMessage\(extensionId\(\), msg,/.test(shopSrc) && !/postMessage/.test(shopSrc));
    ok('판독은 trackb 편집 경로로', /"\/api\/trackb\/campaigns\/product-page\/extract"/.test(shopSrc));
    ok('잠긴 칸은 건너뛴다', /input\.disabled \|\| input\.readOnly \|\| input\.classList\.contains\("rf-locked"\)\) return false/.test(shopSrc));
    ok('마감 줄은 손대지 않고, 저장돼 있던 줄은 지우지 않는다(빈 이름이면 채워 쓴다)',
      /return row\.dataset\.status !== "closed" && !String/.test(shopSrc) && /blanks\.forEach\(function \(row\) \{\s*if \(row\.dataset\.origKey\) return;/.test(shopSrc));
    ok('안내는 창·카드 안에서(토스트는 공고 창 아래에 깔린다)', !/showToast\(/.test(shopSrc));
    for (const page of ['frontend/admin.html', 'frontend/workdesk.html']) {
      const html = rd(page);
      ok(page + ': index-recruit 다음에 싣는다', html.indexOf('js/recruit-shop-import.js') > html.indexOf('js/index-recruit.js?v='));
    }
    // ask() — 확장이 없음 / 옛 버전 / 실패 / 성공을 가른다
    const run = (chromeStub) => {
      const win = { chrome: chromeStub };
      const sb = { window: win, document: { getElementById: () => null }, setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, isFinite };
      win.window = win;
      vm.createContext(sb);
      vm.runInContext(shopSrc, sb);
      return win.rfShopImport._internals;
    };
    const mk = reply => ({ runtime: { lastError: null, sendMessage: (id, msg, cb) => { cb(reply(msg, id)); } } });
    ok('확장 없음 → missing', (await run(undefined).ask('LIST')).kind === 'missing');
    ok('옛 버전(PING 만 답함) → old', (await run(mk(() => ({ ok: false }))).ask('LIST')).kind === 'old');
    ok('실패 문구는 그대로', (await run(mk(() => ({ ok: false, error: '지원하는 쇼핑몰 상품페이지가 아닙니다.' }))).ask('READ', { tabId: 1 })).error === '지원하는 쇼핑몰 상품페이지가 아닙니다.');
    let sentTo = '';
    const okRes = await run(mk((msg, id) => { sentTo = id + ':' + msg.type + ':' + msg.tabId; return { ok: true, tabs: [] }; })).ask('READ', { tabId: 7 });
    ok('성공 · 확장 ID 로 보낸다', okRes.ok === true && sentTo === 'hlhphdglgkacdbbknpfmaoklcbinnaoe:READ:7');
    const pf = run(undefined).payFor;
    ok('결제금액 계산 = 서버와 같은 규칙', pf(12900, { fee: 3000, freeThreshold: 30000 }, true) === 15900 && pf(31000, { fee: 3000, freeThreshold: 30000 }, true) === 31000 &&
      pf(12900, { fee: 3000 }, false) === 12900 && pf(12900, { fee: 3000, isFree: true }, true) === 12900);
  }

  console.log('\n[5] Gemini 공용 실행기 — 기본 동작 그대로');
  {
    ok('기본 재시도 수 그대로(2~3)', /co\.maxAttempts > 0 \? co\.maxAttempts : Math\.max\(2, Math\.min\(_modelPool\.length, 3\)\)/.test(gemSrc));
    ok('기본 제한 시간 그대로(GEMINI_TIMEOUT_MS)', /co\.timeoutMs > 0 \? co\.timeoutMs : GEMINI_TIMEOUT_MS/.test(gemSrc));
    ok('구조화 JSON 함수를 내보낸다', /module\.exports = \{\s*generateStructuredJson,/.test(gemSrc));
  }

  console.log(`\n✅ productPageReader: ${passed}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
