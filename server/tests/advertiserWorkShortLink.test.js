'use strict';
/**
 * advertiserWorkShortLink.test.js — 업체 작업 링크 단축 주소(결정 419 · migration 229) 회귀가드
 *   실행: node tests/advertiserWorkShortLink.test.js
 *
 * 배경(2026-11-25 직원 신고): 작업보드 [🏢 광고주링크]가 `#a=<열쇠>&work=<작업 좌표 JSON>` 을 복사했는데,
 *   작업 이름 「337)10/20(쿠팡)…」의 `)` 에서 카카오톡이 링크를 끊었다(200자 넘는 주소).
 *   → `/workdesk#k=<12자>` 단축 주소. 받은 화면은 서버에서 열쇠+좌표를 되찾아 **기존 교환·작업 열기를 그대로** 탄다.
 *
 *   [A] 서비스(실제 SQL · PGlite + 저장소 migrations) — 같은 (열쇠, 작업) = 같은 코드 · 다른 작업 = 다른 코드 · 되찾기
 *   [B] 주소 모양 — 카톡이 끊는 글자(괄호·%·한글)가 없다 · 60자 안쪽
 *   [C] 받은 화면 실제 boot — 코드 → 되찾기 → 기존 교환 → 지정 작업이 열린다 / 없는 코드·통신 실패는 말한다
 *   [D] 복사 — 서버가 코드를 주면 짧은 주소, 안 주면(옛 서버·표 없음) 종전 긴 주소(fail-soft)
 *   [E] 입장 판정 사본 0 — 되찾기 라우트는 교환 판정(loginByLinkToken)을 부르지 않고, 작업을 지우면 함께 지운다
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const SERVER = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(SERVER, '..', 'frontend/workdesk.html'), 'utf8');
const routes = fs.readFileSync(path.join(SERVER, 'src/routes/trackB.routes.js'), 'utf8');

function fn(name) {
  const m = new RegExp('(?:async )?function ' + name + '\\(').exec(html);
  assert.ok(m, 'Missing function ' + name);
  let i = html.indexOf('{', m.index), d = 0;
  for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}' && --d === 0) return html.slice(m.index, i + 1); }
  assert.fail('Unclosed function ' + name);
}

let passed = 0;
const ok = async (name, f) => { await f(); passed++; console.log('  ✓ ' + name); };

(async () => {
  console.log('\n── A. 서비스(실제 SQL) ──');
  const db = new PGlite();
  for (const f of fs.readdirSync(path.join(SERVER, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8')); } catch (_) { /* 확장 의존 표는 건너뛴다 */ }
  }
  const query = async (sql, params) => { const r = await db.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; };
  const svc = require('../src/services/advertiserWorkLink.service');
  svc.__setPoolForTest({ query });
  const W = { token: 'fake-token-A', sheetId: 'S1', tabName: '337)10/20(쿠팡)좋은상황_상황버섯진액10포 300건' };

  await ok('같은 (열쇠, 작업)은 몇 번 눌러도 같은 코드 — 이미 보낸 주소가 안 죽는다', async () => {
    const a = await svc.ensureWorkLink({ ...W, by: 'tester' }), b = await svc.ensureWorkLink(W);
    assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.code, b.code);
    assert.match(a.code, /^[A-Za-z0-9_-]{12}$/);
  });
  await ok('다른 작업·다른 열쇠(회전 뒤)는 다른 코드', async () => {
    const a = await svc.ensureWorkLink(W);
    const b = await svc.ensureWorkLink({ ...W, tabName: '다른 작업' });
    const c = await svc.ensureWorkLink({ ...W, token: 'fake-token-rotated' });
    assert.notEqual(a.code, b.code); assert.notEqual(a.code, c.code);
  });
  await ok('되찾기 = 만들 때의 열쇠 + 작업 좌표 그대로', async () => {
    const { code } = await svc.ensureWorkLink(W);
    assert.deepEqual(await svc.resolveWorkLink(code), { token: W.token, sheetId: W.sheetId, tabName: W.tabName });
  });
  await ok('없는 코드·이상한 글자는 null(SQL 까지 안 간다)', async () => {
    assert.equal(await svc.resolveWorkLink('AAAAAAAAAAAA'), null);
    for (const bad of ['', 'short', "x' OR 1=1 --", '가나다라마바사아자차', null]) assert.equal(await svc.resolveWorkLink(bad), null);
  });
  await ok('필수값이 비면 400', async () => {
    await assert.rejects(svc.ensureWorkLink({ token: '', sheetId: 'S', tabName: 'T' }), e => e.status === 400);
  });

  console.log('\n── B. 주소 모양 ──');
  await ok('단축 주소에는 카톡이 끊는 글자(괄호·%·한글)가 없고 60자 안쪽이다', () => {
    const ctx = { location: { origin: 'https://review-web-system.pages.dev' }, encodeURIComponent, JSON };
    vm.createContext(ctx); vm.runInContext(fn('_advShortLinkUrl'), ctx);
    const u = ctx._advShortLinkUrl('AbCdEfGh_-12');
    assert.equal(u, 'https://review-web-system.pages.dev/workdesk#k=AbCdEfGh_-12');
    assert.ok(u.length <= 60, u.length);
    assert.ok(/^[A-Za-z0-9:/._#=_-]+$/.test(u));
  });

  console.log('\n── C. 받은 화면 실제 boot ──');
  const rows = [{ sheetId: 'S', tabName: '작업 1' }, { sheetId: 'S', tabName: '337)10/20(쿠팡)작업' }];
  function receiver(hash, resolveImpl) {
    const log = { opened: [], messages: [], fetches: [] };
    const location = { origin: 'https://preview.invalid', pathname: '/workdesk', search: '', hash };
    const ctx = {
      STATE: { tabs: [], cur: null }, location, _GO: null, _VIEW: '', _PICK: '', _SHARE: null, _SHARE_ERR: '', _ADV_WORK: null,
      history: { state: null, replaceState(_a, _b, url) { location.hash = new URL(url, location.origin).hash; } },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      token: () => 'fake-session', parseJwt: () => ({ role: 'advertiser', exp: Math.floor(Date.now() / 1000) + 3600 }),
      fetch: async (url, opt) => {
        const body = JSON.parse(opt.body); log.fetches.push({ url, body });
        if (url.endsWith('/advertiser-work-link/resolve')) return resolveImpl(body.code);
        return { status: 200, json: async () => ({ success: body.token === 'real-token', token: 'fake-session' }) };
      },
      API_BASE: 'https://api.invalid', window: {}, Date, JSON, URL, decodeURIComponent, encodeURIComponent, setTimeout: () => 0,
      alert: m => log.messages.push(m), toast: m => log.messages.push(m),
      _navCanRestore: () => false, _navRestoreState() {}, _wbOrderLiveStart() {}, _isInternalRole: () => false,
      _brandLens() {}, _renderAdvSidebar() {}, refreshUnseen() {}, _renderAdvHome() {},
      selTab(i) { log.opened.push(ctx.STATE.tabs[i].tabName); ctx.STATE.cur = ctx.STATE.tabs[i]; },
      $: () => null,
      api: async url => url.includes('my-work-summary') ? { ok: true, items: [] } : { ok: true, tabs: rows.map(x => ({ ...x })) },
      renderShell() { ctx.loaded = ctx.loadTabs(); }, renderLogin: m => { log.messages.push(m); },
    };
    vm.createContext(ctx);
    vm.runInContext(['_advLinkUrl', '_advWorkLinkUrl', '_readAdvertiserWork', '_consumeAdvertiserWork', '_clearAdvertiserWorkHash',
      '_openPendingAdvertiserWork', 'boot', '_consumeGo', '_consumeShare', 'loadTabs'].map(fn).join('\n'), ctx);
    return { ctx, log, async boot() { await ctx.boot(); await ctx.loaded; } };
  }
  const found = code => ({ status: 200, json: async () => (code === 'GoodCode1234'
    ? { ok: true, token: 'real-token', work: { s: 'S', t: '337)10/20(쿠팡)작업' } }
    : { ok: false, code: 'not_found' }) });

  await ok('★ #k=코드 → 되찾기 → 기존 교환(열쇠) → 괄호 든 작업이 바로 열린다', async () => {
    const h = receiver('#k=GoodCode1234', code => (code === 'GoodCode1234' ? found(code) : { status: 404, json: async () => ({ ok: false }) }));
    await h.boot();
    assert.deepEqual(h.log.opened, ['337)10/20(쿠팡)작업']);
    assert.ok(h.log.fetches.some(f => f.url.endsWith('/advertiser-link-login') && f.body.token === 'real-token'), '기존 교환을 탄다');
    assert.equal(h.ctx.location.hash, '#a=real-token', '주소에는 열쇠가 남아 새로고침해도 열린다(A안) · 작업 지정은 한 번만');
  });
  await ok('없는 코드 → "유효하지 않거나 폐기" 안내(문구 없는 로그인 화면 아님)', async () => {
    const h = receiver('#k=BadCode12345', () => ({ status: 404, json: async () => ({ ok: false, code: 'not_found' }) }));
    await h.boot();
    assert.equal(h.log.opened.length, 0); assert.match(h.log.messages.join(' '), /유효하지 않거나 폐기/);
    assert.ok(!h.log.fetches.some(f => f.url.endsWith('/advertiser-link-login')));
  });
  await ok('통신 실패·요청 과다 → "잠시 뒤 새로고침" 안내(폐기라고 단정하지 않는다)', async () => {
    for (const impl of [() => { throw new Error('offline'); }, () => ({ status: 429, json: async () => ({ success: false }) })]) {
      const h = receiver('#k=GoodCode1234', impl); await h.boot();
      assert.equal(h.log.opened.length, 0); assert.match(h.log.messages.join(' '), /새로고침/);
    }
  });
  await ok('회전·폐기된 열쇠를 가리키는 코드는 기존 교환이 막는다(판정 사본 0)', async () => {
    const h = receiver('#k=OldCode12345', () => ({ status: 200, json: async () => ({ ok: true, token: 'rotated-old-token', work: { s: 'S', t: '작업 1' } }) }));
    await h.boot();
    assert.equal(h.log.opened.length, 0); assert.match(h.log.messages.join(' '), /유효하지 않거나 폐기/);
  });
  await ok('기존 긴 주소(#a=…&work=…)는 되찾기 없이 종전대로 열린다', async () => {
    const h = receiver('#a=real-token&work=' + encodeURIComponent(JSON.stringify({ s: 'S', t: '작업 1' })), () => assert.fail('부르면 안 된다'));
    h.ctx._ADV_WORK = h.ctx._readAdvertiserWork(h.ctx.location.hash);
    await h.boot(); assert.deepEqual(h.log.opened, ['작업 1']);
  });

  console.log('\n── D. 복사 ──');
  async function copy(resp) {
    const out = { copied: null };
    const ctx = { STATE: { cur: { sheetId: 'S', tabName: '337)작업' }, tabs: [] }, location: { origin: 'https://review-web-system.pages.dev' },
      encodeURIComponent, JSON, Number, api: async () => resp, alert() {}, toast() {},
      _copyText: async u => { out.copied = u; return true; }, _shareLinkOk() {}, _shareLinkPopup() {} };
    vm.createContext(ctx);
    vm.runInContext([fn('_advLinkUrl'), fn('_advWorkLinkUrl'), fn('_advShortLinkUrl'), fn('copyAdvertiserLink')].join('\n'), ctx);
    await ctx.copyAdvertiserLink(); return out.copied;
  }
  const base = { ok: true, advertiser: { id: 'A', name: '업체' }, link: { token: 'real-token', active: true } };
  await ok('★ 서버가 코드를 주면 짧은 주소를 복사한다', async () => {
    assert.equal(await copy({ ...base, shortCode: 'GoodCode1234' }), 'https://review-web-system.pages.dev/workdesk#k=GoodCode1234');
  });
  await ok('코드가 없거나 이상하면(옛 서버·표 없음) 종전 긴 주소로 복사한다', async () => {
    for (const sc of [undefined, '', '<script>', 'a b c d e f g h']) {
      const u = await copy({ ...base, shortCode: sc });
      assert.match(u, /#a=real-token&work=/, String(sc));
    }
  });

  console.log('\n── E. 경계 ──');
  await ok('되찾기 라우트는 공개 + 교환과 같은 레이트리밋 · 입장 판정을 하지 않는다', () => {
    const m = /router\.post\('\/advertiser-work-link\/resolve', advertiserLinkLimiter, async[\s\S]*?\n\}\);/.exec(routes);
    assert.ok(m, '라우트 없음');
    assert.ok(!/loginByLinkToken|jwt\.sign/.test(m[0]));
  });
  await ok('for-tab 은 살아 있는 링크일 때만 코드를 만들고, 실패해도 응답은 그대로(fail-soft)', () => {
    const m = /if \(action === 'for-tab'\) \{[\s\S]*?\n    \}/.exec(routes);
    assert.ok(m); assert.match(m[0], /link\.active !== false/); assert.match(m[0], /try \{ shortCode =[\s\S]*catch/);
  });
  await ok('작업을 지우면 그 작업으로 가는 단축 주소도 지운다', () => {
    assert.ok(require('../src/services/workTabDelete.service').DELETE_TABLES.includes('trackb_advertiser_work_links'));
  });

  console.log(`\nadvertiserWorkShortLink: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
