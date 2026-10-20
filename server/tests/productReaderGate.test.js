/**
 * 회귀가드: 직원 화면 확장 프로그램 필수 설치(2026-10-13 사용자 결정 · js/product-reader-gate.js).
 * 고정: (1) 직원만 — 광고주(업체) 화면 제외 (2) 휴대폰·사파리·파이어폭스는 막지 않음
 *       (3) 설치 확인은 PING 만, 확장이 없거나 답이 없으면 「미설치」 (4) 두 화면(관리자·작업데스크) 배선.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const front = path.join(__dirname, '..', '..', 'frontend');
const gateSrc = fs.readFileSync(path.join(front, 'js/product-reader-gate.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(front, 'workdesk.html'), 'utf8');
// 옛 관리자 대시보드 폐기(결정 267) — admin.html 은 작업보드로 보내는 정류장이라 잠금 대상 화면은 작업보드 하나다.

let failed = 0;
const ok = (m, c) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };

function load(ua, chromeRuntime, required, hostname) {
  const appended = [];
  const document = { getElementById: id => appended.find(n => n.id === id) || null, createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }), body: { appendChild: n => appended.push(n) } };
  const window = { chrome: chromeRuntime ? { runtime: chromeRuntime } : undefined };
  const src = gateSrc.replace(/var PRODUCT_READER_REQUIRED = (true|false);/, 'var PRODUCT_READER_REQUIRED = ' + (required ? 'true' : 'false') + ';');
  vm.runInNewContext(src, { window, document, navigator: { userAgent: ua }, setTimeout, clearTimeout, Promise, location: { hostname: hostname || 'review-web-system.pages.dev', reload() {} } });
  return { gate: window.productReaderGate, appended };
}
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MOBILE = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36';
const installed = { sendMessage: (id, msg, cb) => cb({ ok: true, version: '1.0.4' }) };
const missing = { sendMessage: (id, msg, cb) => cb(undefined), lastError: { message: 'Could not establish connection' } };

(async () => {
  const k = load(CHROME, null, true).gate._internals.browserKind;
  ok('크롬·웨일·엣지 = 막는 대상', k(CHROME) === 'supported' && k(CHROME.replace('Safari/', 'Whale/4.39 Safari/')) === 'supported' && k(CHROME + ' Edg/150') === 'supported');
  ok('사파리·파이어폭스 = 안내만, 휴대폰 = 안내만', k(SAFARI) === 'unsupported' && k('Mozilla/5.0 (Macintosh; rv:130.0) Gecko/20100101 Firefox/130.0') === 'unsupported' && k(MOBILE) === 'mobile');

  let t = load(CHROME, missing, true); await t.gate({ isStaff: true });
  ok('미설치 직원(크롬) → 잠금 화면', t.appended.length === 1 && t.appended[0].id === 'product-reader-gate');
  t = load(CHROME, null, true); await t.gate({ isStaff: true });
  ok('확장이 하나도 없어 chrome.runtime 이 없어도 → 잠금 화면', t.appended.length === 1);
  t = load(CHROME, installed, true); await t.gate({ isStaff: true });
  ok('설치된 직원 → 아무것도 안 띄움', t.appended.length === 0);
  t = load(CHROME, missing, true); await t.gate({ isStaff: false });
  ok('광고주·리뷰어(isStaff=false) → 검사 안 함', t.appended.length === 0);
  t = load(CHROME, missing, false); await t.gate({ isStaff: true });
  ok('스위치 꺼짐(PRODUCT_READER_REQUIRED=false) → 아무것도 안 함', t.appended.length === 0);
  t = load(SAFARI, null, true); await t.gate({ isStaff: true });
  ok('사파리 직원 → 막지 않고 안내 문구만(같은 id 1개)', t.appended.length === 1);

  ok('스위치 선언이 한 줄로 있다(검사가 값을 바꿔 끼울 수 있어야 함)', (gateSrc.match(/var PRODUCT_READER_REQUIRED = (true|false);/g) || []).length === 1);
  t = load(CHROME, missing, true, 'test-review-wdb-web-review-web-system-pr-1633.up.railway.app'); await t.gate({ isStaff: true });
  ok('PR 미리보기 주소 → 잠그지 않음', t.appended.length === 0);
  t = load(CHROME, missing, true, '127.0.0.1'); await t.gate({ isStaff: true });
  ok('내 컴퓨터 서버 → 잠그지 않음', t.appended.length === 0);
  const th = t.gate._internals.isTestHost;
  ok('시험 주소 예외는 좁게 — 운영·Cloudflare 미리보기·테섭 production·비슷한 가짜 주소는 잠금 대상', !th('review-web-system.pages.dev') && !th('abc123.review-web-system.pages.dev') && !th('test-review-wdb-web-production.up.railway.app') && !th('test-review-wdb-web-review-web-system-pr-1.up.railway.app.evil.com'));
  const bootCall = workdesk.search(/^boot\(\);$/m), gateTag = workdesk.indexOf('<script src="js/product-reader-gate.js"></script>');
  ok('작업데스크: 잠금 스크립트가 첫 boot() 보다 먼저 읽힘(재방문·SSO 입장 우회 방지)', gateTag > 0 && bootCall > 0 && gateTag < bootCall);
  ok('PING 만 보낸다', /sendMessage\(EXTENSION_ID, \{ type: 'PING' \}/.test(gateSrc) && !/type: '(LIST|READ)'/.test(gateSrc));
  ok('작업데스크: 광고주 제외로 호출', /window\.productReaderGate\(\{ isStaff: STATE\.role !== 'advertiser' \}\)/.test(workdesk));
  ok('작업데스크가 스크립트 로드', /<script src="js\/product-reader-gate\.js"><\/script>/.test(workdesk));
  if (failed) { console.log(`\n${failed}건 실패`); process.exit(1); }
})();
