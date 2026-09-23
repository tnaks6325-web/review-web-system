/*
 * 업체 전용 접속 링크 — 짧은 URL(#a=) + 해시 유지(A안) 회귀가드
 *   실행: node tests/advertiserLinkShortUrl.test.js
 *
 * 배경(2026-08-24 사용자 확정 "㉡ + A안"):
 *   ① 링크가 81자로 길어 카톡 전달이 불편했다 → 키 `#adv=` → `#a=`, 토큰 24B(32자) → 12B(16자).
 *      경로 `/workdesk` 는 **그대로 둔다**((나)안 — `/a` 는 Cloudflare Pages 전용이라 테섭에서 404,
 *      링크는 location.origin 기반이라 테섭에서 복사하면 죽은 링크가 된다).
 *   ② 첫 진입 뒤 해시를 지워서 **재방문·새 탭이 전부 "문구 없는 로그인 화면"** 이 됐다(실측 신고)
 *      → 교환 뒤에도 해시를 남긴다. 대신 logout 이 해시를 지운다(안 지우면 로그아웃이 안 된다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const wd = fs.readFileSync(path.join(root, 'frontend/workdesk.html'), 'utf8');
const svc = fs.readFileSync(path.join(root, 'server/src/services/trackB.service.js'), 'utf8');
const redirects = fs.readFileSync(path.join(root, 'frontend/_redirects'), 'utf8');
const headers = fs.readFileSync(path.join(root, 'frontend/_headers'), 'utf8');

let pass = 0;
const ok = (m, c) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

// boot 의 접속 링크 교환 블록만 잘라낸다(async 함수로 감싸 실제 실행)
const BLOCK = /const advm=\(location\.hash\|\|''\)[\s\S]*?문의하세요\.'\); \} \}/.exec(wd);
assert.ok(BLOCK, '접속 링크 교환 블록 추출 실패');
const block = BLOCK[0];

console.log('\n── A. 짧은 URL 생성 ──');
const mk = /function _advLinkUrl\(token\)\{[^\n]*\}/.exec(wd);
ok('_advLinkUrl 을 한 줄로 추출할 수 있다(ownershipBStyle 가드가 같은 형태를 본다)', !!mk);
ok('★ 짧은 키 `#a=` 로 만든다', /#a=/.test(mk[0]) && !/#adv=/.test(mk[0]));
ok('★ 경로는 /workdesk 를 유지한다 — /a 로 만들면 테섭(Railway)에서 404 인 죽은 링크가 된다',
  /'\/workdesk#a='/.test(mk[0]) && !/'\/a#/.test(mk[0]));
ok('토큰은 여전히 encodeURIComponent 를 거친다', /encodeURIComponent\(token\)/.test(mk[0]));

console.log('\n── B. 토큰 생성 = 단일 출처 · 12바이트 ──');
ok('★ _linkToken 단일 출처가 있다', /function _linkToken\(\)/.test(svc));
ok('★ 12바이트(base64url 16자)', /const LINK_TOKEN_BYTES = 12;/.test(svc)
  && /randomBytes\(LINK_TOKEN_BYTES\)\.toString\('base64url'\)/.test(svc));
// ★ 설명 주석에 옛 표기가 남아 있으면 "사본이 있다"로 오판한다 — 줄 주석을 지우고 본다.
//   (블록 주석 정규식은 이 레포의 정규식 리터럴을 물어 코드를 통째로 지운다 — 줄 주석만.)
const svcCode = svc.replace(/^[ \t]*\/\/.*$/gm, '');
ok('★ randomBytes(24) 사본이 남아 있지 않다(업체 ensure/generate + 브랜드 create/rotate 4곳 이관)',
  !/randomBytes\(24\)/.test(svcCode));
ok('★ 링크 토큰을 만드는 곳은 전부 _linkToken() 을 쓴다(4곳)',
  (svcCode.match(/_linkToken\(\)/g) || []).length >= 5);   // 선언 1 + 사용 4

console.log('\n── C. 하위호환 — 이미 뿌린 #adv= 링크는 계속 열린다 ──');
ok('★ #a= 를 먼저 보고 #adv= 로 폴백한다(폴백 제거 금지)',
  /\[#&\]a=\(\[\^&\]\+\)/.test(block) && /\[#&\]adv=\(\[\^&\]\+\)/.test(block));
ok('토큰을 못 읽으면 문구 없는 로그인으로 흘리지 않는다', /if\(!t\) return renderLogin\(/.test(block));

console.log('\n── D. A안 — 교환 뒤에도 해시를 지우지 않는다 ──');
ok('★★ 교환 블록 안에 replaceState 가 없다(있으면 재방문이 다시 막힌다)',
  !/replaceState/.test(block));
ok('★ _navPush 도 해시를 보존한다(빼면 화면 전환 한 번에 열쇠가 증발)',
  /const e=_navEntry\(\), url=location\.pathname\+location\.search\+location\.hash;/.test(wd));

console.log('\n── E. logout 은 주소에서도 열쇠를 지운다 ──');
const LO = /function logout\(\)\{[\s\S]*?\n\}/.exec(wd);
assert.ok(LO, 'logout 추출 실패');
ok('★★ logout 이 해시를 제거한다 — 안 지우면 이어지는 boot() 이 다시 교환해 로그아웃이 안 된다',
  /history\.replaceState\(null,'',location\.pathname\+location\.search\)/.test(LO[0]));
ok('★ 마지막에 쓴 링크 토큰 기억(adv_link_tok)도 비운다', /removeItem\('adv_link_tok'\)/.test(LO[0]));

console.log('\n── F. /a 별칭 — 리뷰어 홈이 뜨지 않게 명시 ──');
ok('★ Pages SPA 폴백 때문에 /a 를 명시 rewrite 한다(안 하면 200 + 리뷰어 홈)',
  /^\/a\s+\/workdesk\.html\s+200\s*$/m.test(redirects));
ok('★ /a 는 확장자가 없어 /*.html 캐시 규칙에 안 걸린다 — 따로 no-cache',
  /^\/a\n\s+Cache-Control: no-cache$/m.test(headers));

console.log('\n── G. 런타임 실행 — 교환 4갈래(정적 검사로는 못 보는 것) ──');
function run(hash, { sessionExp = null, lastTok = null } = {}) {
  const store = { admin_token: sessionExp ? 'h.' + Buffer.from(JSON.stringify({ role: 'advertiser', exp: sessionExp })).toString('base64url') + '.s' : null };
  if (lastTok) store.adv_link_tok = lastTok;
  let fetches = 0, loginMsg = null;
  const sandbox = {
    location: { hash, pathname: '/workdesk', search: '' },
    API_BASE: 'https://api.test',
    token: () => store.admin_token || '',
    parseJwt: t => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); } catch (_) { return null; } },
    sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
    renderLogin: m => { loginMsg = m || ''; return 'LOGIN'; },
    fetch: async () => { fetches++; return { json: async () => ({ success: true, token: 'h.' + Buffer.from(JSON.stringify({ role: 'advertiser', exp: 4102444800 })).toString('base64url') + '.s' }) }; },
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(`globalThis.__run = async function(){ ${block} return 'OK'; }`, sandbox);
  return sandbox.__run().then(r => ({ r, fetches, loginMsg, store, hash: sandbox.location.hash }));
}
const TOK = 'Ab3xK9mQ2pLwRt7d';
(async () => {
  const a = await run('#a=' + TOK);
  ok('★ #a= 링크가 교환된다(1회)', a.fetches === 1 && a.loginMsg === null);
  ok('★★ 교환 뒤에도 주소의 해시가 그대로 남는다', a.hash === '#a=' + TOK);
  ok('마지막 토큰을 기억한다', a.store.adv_link_tok === TOK);

  const b = await run('#adv=' + TOK);
  ok('★ 구 #adv= 링크도 그대로 교환된다(하위호환)', b.fetches === 1 && b.loginMsg === null);

  const c = await run('#a=' + TOK, { sessionExp: 4102444800, lastTok: TOK });
  ok('★ 같은 토큰 + 살아 있는 세션 = 재교환 생략(새로고침마다 레이트리밋을 먹지 않는다)', c.fetches === 0);

  const d = await run('#a=' + TOK, { sessionExp: 1, lastTok: TOK });
  ok('★★ 세션이 만료됐으면 같은 토큰이어도 반드시 교환한다(생략 게이트가 열쇠를 삼키지 않는다)', d.fetches === 1);

  const e = await run('#a=' + TOK, { sessionExp: 4102444800, lastTok: 'OTHER_TOKEN___xx' });
  ok('★ 다른 업체 링크를 열면 세션이 살아 있어도 교환한다(업체 전환이 막히지 않는다)', e.fetches === 1);

  console.log(`\n✅ advertiserLinkShortUrl: ${pass} cases passed\n`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
