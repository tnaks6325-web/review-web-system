'use strict';
/**
 * imageExtractFriendlyError.test.js — 결정 331: 구매캡처 AI 분석이 실패하면 리뷰어에게는 쉬운 한국어 안내를,
 *   이상로그(error_logs)에는 원문을 그대로 남긴다.
 *
 * ★ 사고(2026-11-03 조사): Gemini 키 3개가 모두 9초를 넘기면(최악 약 28초) 구매양식 빨간 상자에
 *   서버 원문 '[Gemini extract] timeout 9000ms' 가 그대로 보였다. 또 화면의 시간초과 문구는 「15초」였는데
 *   실제 화면 대기는 35초였다.
 *
 * 실행: node tests/imageExtractFriendlyError.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const express = require('express');
const Module = require('module');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-image-extract-msg';
let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const FRIENDLY = 'AI가 잠시 응답하지 않아요. [다시 분석하기]를 누르거나 아래 칸을 직접 채워 주세요.';

// 실제 라우트 코드를 태우되 AI·DB·오류 기록부만 가로챈다(clientErrorReport.test.js 와 같은 방식)
const logged = [];
let nextError = null;
const origLoad = Module._load;
Module._load = function (req) {
  if (/errorLog\.service$/.test(req)) return { logAbnormal: (e) => logged.push(e) };
  if (/db\/pool$/.test(req)) return { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }), on() {} };
  if (/services\/gemini\.service$/.test(req)) return {
    extractOrderFromImage: async () => { throw nextError; },
    verifyAddressMatch: async () => ({}),
    classifySubmissionImage: async () => ({}),
  };
  return origLoad.apply(this, arguments);
};
const diag = require('../src/routes/diag.routes');
Module._load = origLoad;
// 라우트가 요청 안에서 늦게 부르는 예시 이미지 조회도 DB 에 닿지 않게 미리 채워 둔다
const inspectPath = require.resolve('../src/services/reviewInspect.service');
require.cache[inspectPath] = { id: inspectPath, filename: inspectPath, loaded: true, exports: { loadOrderExtractionSamples: async () => [] } };

(async () => {
  console.log('\n서버 — /image-extract 실패 응답');
  const app = express(); app.use(express.json({ limit: '2mb' })); app.use('/api/image', diag);
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const post = (payload) => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const q = http.request({ port, path: '/api/image/image-extract', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = ''; res.on('data', c => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf) }));
    });
    q.on('error', reject); q.end(body);
  });
  const run = async (err, extra) => { nextError = err; logged.length = 0; return post({ imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg', ...(extra || {}) }); };
  try {
    // ① 시간초과(키 3개 모두 9초 초과) — 리뷰어에게 영문 원문이 보이면 안 된다
    let r = await run(new Error('[Gemini extract] timeout 9000ms'));
    ok('시간초과 → 응답은 실패(ok:false) 그대로', r.status === 200 && r.json.ok === false);
    ok('시간초과 → 리뷰어 안내는 쉬운 한국어', r.json.error === FRIENDLY);
    ok('시간초과 → 응답에 영문 원문(Gemini·timeout)이 없다', !/Gemini|timeout|\d+ms/i.test(r.json.error));
    ok('시간초과 → 이상로그에는 원문 그대로', logged.length === 1 && logged[0].error && logged[0].error.message === '[Gemini extract] timeout 9000ms');
    ok('시간초과 → 이상로그 분류 불변(image_extract/gemini_call)', logged[0].flow === 'image_extract' && logged[0].step === 'gemini_call');
    ok('실패해도 명의 확인 실패 증명은 그대로 실린다', !!r.json.extractToken && !!r.json.imageHash);

    // ② AI 서버 오류(내부 문구) — 쉬운 안내
    r = await run(Object.assign(new Error('[GoogleGenerativeAI Error]: 503 Service Unavailable'), { status: 503 }));
    ok('AI 서버 503 → 쉬운 한국어 안내', r.json.error === FRIENDLY && logged[0].error.message.includes('503'));
    r = await run(new Error('AI 응답이 비어 있습니다 (출력 토큰 초과/잘림 추정). 다시 시도해주세요.'));
    ok('빈 응답(내부 사정 문구) → 쉬운 한국어 안내', r.json.error === FRIENDLY);
    r = await run(new Error('Gemini API가 설정되지 않았습니다. GEMINI_API_KEY 환경변수를 확인하세요.'));
    ok('키 미설정(운영 내부 문구) → 쉬운 한국어 안내 · 원문은 기록', r.json.error === FRIENDLY && /GEMINI_API_KEY/.test(logged[0].error.message));

    // ③ 이미 리뷰어용 한국어 안내인 것은 그대로
    const NOT_ORDER = '주문 정보를 인식하지 못했습니다. 주문 캡처 이미지가 맞는지 확인 후 다시 시도해주세요.';
    r = await run(new Error(NOT_ORDER));
    ok('「주문 정보를 인식하지 못했습니다」 → 그대로', r.json.error === NOT_ORDER);

    // ④ 두 번째 장 실패 — 받았다는 서명(결정 300)은 그대로, 안내만 쉬운 말
    r = await run(new Error('[Gemini extract] timeout 9000ms'), { captureIndex: 2, orderNumberHint: '2026110312345' });
    ok('두 번째 장 시간초과 → capture2Token 유지 + 쉬운 안내', !!r.json.capture2Token && r.json.error === FRIENDLY);
  } finally { server.close(); }

  console.log('\n화면 — 구매양식 카드 AI 시간초과 문구');
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/search-app.js'), 'utf8');
  const fnSrc = (name) => {
    const start = source.indexOf('async function ' + name + '(');
    assert(start >= 0, name);
    const ends = ['\nfunction ', '\nasync function ', '\nwindow.'].map(x => source.indexOf(x, start + 1)).filter(x => x >= 0);
    return source.slice(start, Math.min(...ends));
  };
  const els = {};
  const elFor = (id) => els[id] || (els[id] = { id, textContent: '', innerHTML: '', value: '', style: {}, classList: { add() {}, remove() {} } });
  const shown = [];
  const ctx = {
    _cardAiState: { c1: {} }, APP_CONFIG: { GAS_WEB_APP_URL: 'http://local' }, window: {},
    document: { getElementById: elFor },
    _resetSavedIdentityPickerLabels() {}, _syncSubmissionIdentityAction() {}, _stopCardCountdown() {},
    _renderIdentityMatchState() {}, _showCardAiError: (cid, msg, retry) => shown.push({ msg, retry }),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, AbortController: class { abort() {} },
    gasPostUpload: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('_callCardExtractAi') + '\nthis._run = _callCardExtractAi;', ctx);
  await ctx._run('c1', 'aGVsbG8=', 'image/jpeg');
  ok('화면 시간초과 → 안내 1건 + [다시 분석하기] 보임', shown.length === 1 && shown[0].retry === true);
  ok('화면 시간초과 문구에 「15초」가 없다(실제 대기 35초와 어긋나던 숫자)', !/15초/.test(shown[0].msg));
  ok('화면 시간초과 문구 = 서버 실패와 같은 쉬운 안내', shown[0].msg.includes('AI가 잠시 응답하지 않아요'));
  ok('search-app.js 어디에도 「15초 안에 응답이 없었습니다」가 남지 않는다', !source.includes('15초 안에 응답이 없었습니다'));

  console.log(`\n${n}개 규칙 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
