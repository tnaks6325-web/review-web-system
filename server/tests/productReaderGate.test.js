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
const admin = fs.readFileSync(path.join(front, 'admin.html'), 'utf8');
const indexApp = fs.readFileSync(path.join(front, 'js/index-app.js'), 'utf8');

let failed = 0;
const ok = (m, c) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m); } };

function load(ua, chromeRuntime, required) {
  const appended = [];
  const document = { getElementById: id => appended.find(n => n.id === id) || null, createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }), body: { appendChild: n => appended.push(n) } };
  const window = { chrome: chromeRuntime ? { runtime: chromeRuntime } : undefined };
  const src = required ? gateSrc.replace('var PRODUCT_READER_REQUIRED = false;', 'var PRODUCT_READER_REQUIRED = true;') : gateSrc;
  vm.runInNewContext(src, { window, document, navigator: { userAgent: ua }, setTimeout, clearTimeout, Promise, location: { reload() {} } });
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

  ok('PING 만 보낸다', /sendMessage\(EXTENSION_ID, \{ type: 'PING' \}/.test(gateSrc) && !/type: '(LIST|READ)'/.test(gateSrc));
  ok('작업데스크: 광고주 제외로 호출', /window\.productReaderGate\(\{ isStaff: STATE\.role !== 'advertiser' \}\)/.test(workdesk));
  ok('관리자 화면: 진입 때 호출', /function enterAdminScreen\(\) \{\s*\/\/[^\n]*\n\s*try \{ window\.productReaderGate && window\.productReaderGate\(\{ isStaff: true \}\)/.test(indexApp));
  ok('두 화면 모두 스크립트 로드', /<script src="js\/product-reader-gate\.js"><\/script>/.test(workdesk) && /<script src="js\/product-reader-gate\.js"><\/script>/.test(admin));
  if (failed) { console.log(`\n${failed}건 실패`); process.exit(1); }
})();
