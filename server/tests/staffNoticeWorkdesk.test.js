'use strict';
// 결정 265: 직원 공지(옛 관리자 대시보드 로그인 팝업)를 작업보드로 이관 — 실제 실행 회귀가드.
//   서버: Track B 경로가 원본 `/api/admin/notices*` 핸들러에 위임되고 권한이 맞는가(PGlite 실DB).
//   화면: 팝업 모듈을 가짜 DOM 에서 돌려 필수열람 잠금·읽음 기록·XSS 방어가 그대로인가.
// 실행: node tests/staffNoticeWorkdesk.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

process.env.JWT_SECRET = 'test-staff-notice';
(async () => {
  let passed = 0; const t = async (n, f) => { await f(); passed++; console.log('PASS ' + n); };
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '017_admin_notices.sql'), 'utf8'));
  const pool = require('../src/db/pool');
  pool.query = (sql, params) => db.query(sql, params);

  const router = require('../src/routes/trackB.routes');
  const jwt = require('jsonwebtoken');
  await new Promise(r => setTimeout(r, 300));   // 모듈 적재 때의 기동 작업은 대상이 아니다
  const call = async (method, p, claims, body) => {
    const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    assert.ok(layer, '라우트 없음: ' + method + ' ' + p);
    const req = { headers: { authorization: 'Bearer ' + jwt.sign(claims, process.env.JWT_SECRET) }, method: method.toUpperCase(),
      baseUrl: '/api/trackb', path: p, originalUrl: '/api/trackb' + p, query: {}, params: {}, body: body || {} };
    let status = 200, out = null;
    const res = { status(c) { status = c; return this; }, json(o) { out = o; return this; }, set() { return this; } };
    for (const h of layer.route.stack.map(s => s.handle)) {
      let nexted = false;
      await h(req, res, (e) => { if (e) throw e; nexted = true; });
      if (!nexted) break;
    }
    return { status, body: out };
  };
  const ADMIN = { name: '관리자갑', role: 'admin', via: 'intranet' };
  const AE = { name: '직원을', role: 'staff', via: 'intranet' };
  const AE2 = { name: '직원병', role: 'staff', via: 'intranet' };
  const ADV = { name: '업체', role: 'advertiser' };

  await t('관리자는 공지를 올린다(작성자 = 로그인 이름 · 기간 → 만료일)', async () => {
    const r = await call('post', '/settings/staff-notices/save', ADMIN, { title: '전체 공지', content: '[필수열람]\n문서 https://example.com/a', display_days: 3 });
    assert.equal(r.status, 200); assert.equal(r.body.success, true);
    assert.equal(r.body.notice.created_by, '관리자갑');
    const days = (new Date(r.body.notice.expires_at) - new Date(r.body.notice.created_at)) / 86400000;
    assert.ok(Math.abs(days - 3) < 0.01);
    const r2 = await call('post', '/settings/staff-notices/save', ADMIN, { title: '을에게만', content: '개별', target_names: ['직원을'] });
    assert.equal(r2.body.success, true);
  });
  await t('AE·업체는 공지를 쓰거나 목록을 볼 수 없다(서버가 막는다)', async () => {
    assert.equal((await call('post', '/settings/staff-notices/save', AE, { title: 'x', content: 'y' })).status, 403);
    assert.equal((await call('get', '/settings/staff-notices', AE)).status, 403);
    assert.equal((await call('post', '/settings/staff-notices/delete', AE, { id: 1 })).status, 403);
    const n = await db.query('SELECT count(*)::int c FROM admin_notices');
    assert.equal(n.rows[0].c, 2);
  });
  await t('받는 사람 판정: 전체 공지는 모두, 개별 공지는 그 이름에게만', async () => {
    const a = await call('get', '/staff-notices/unread', AE);
    assert.deepStrictEqual(a.body.notices.map(x => x.title).sort(), ['을에게만', '전체 공지']);
    const b = await call('get', '/staff-notices/unread', AE2);
    assert.deepStrictEqual(b.body.notices.map(x => x.title), ['전체 공지']);
  });
  await t('업체(광고주)는 팝업 조회도 못 한다', async () => {
    assert.equal((await call('get', '/staff-notices/unread', ADV)).status, 403);
    assert.equal((await call('post', '/staff-notices/read', ADV, { notice_id: 1 })).status, 403);
  });
  await t('[확인] = 읽음 기록 → 그 사람에게만 다시 안 뜬다(두 번 눌러도 한 줄)', async () => {
    const id = (await db.query("SELECT id FROM admin_notices WHERE title='전체 공지'")).rows[0].id;
    assert.equal((await call('post', '/staff-notices/read', AE, { notice_id: id })).body.success, true);
    assert.equal((await call('post', '/staff-notices/read', AE, { notice_id: id })).body.success, true);
    assert.deepStrictEqual((await call('get', '/staff-notices/unread', AE)).body.notices.map(x => x.title), ['을에게만']);
    assert.deepStrictEqual((await call('get', '/staff-notices/unread', AE2)).body.notices.map(x => x.title), ['전체 공지']);
    assert.equal((await db.query('SELECT count(*)::int c FROM admin_notice_reads')).rows[0].c, 1);
  });
  await t('수정은 원본 PUT 핸들러로(만료일 = 작성일 + 새 기간) · 번호가 이상하면 거절', async () => {
    const id = (await db.query("SELECT id FROM admin_notices WHERE title='전체 공지'")).rows[0].id;
    const r = await call('post', '/settings/staff-notices/save', ADMIN, { id: String(id), title: '전체 공지(수정)', content: '본문', display_days: 10 });
    assert.equal(r.body.success, true); assert.equal(r.body.notice.id, id); assert.equal(r.body.notice.title, '전체 공지(수정)');
    const days = (new Date(r.body.notice.expires_at) - new Date(r.body.notice.created_at)) / 86400000;
    assert.ok(Math.abs(days - 10) < 0.01);
    assert.equal((await call('post', '/settings/staff-notices/save', ADMIN, { id: '1 OR 1=1', title: 'x', content: 'y' })).status, 400);
    assert.equal((await call('post', '/settings/staff-notices/save', ADMIN, { id: 99999, title: 'x', content: 'y' })).status, 404);
  });
  await t('삭제 → 목록·팝업에서 사라지고 읽음 기록도 함께 지워진다', async () => {
    const id = (await db.query("SELECT id FROM admin_notices WHERE title LIKE '전체 공지%'")).rows[0].id;
    assert.equal((await call('post', '/settings/staff-notices/delete', ADMIN, { id })).body.success, true);
    assert.equal((await call('post', '/settings/staff-notices/delete', ADMIN, {})).status, 400);
    const all = await call('get', '/settings/staff-notices', ADMIN);
    assert.deepStrictEqual(all.body.notices.map(x => x.title), ['을에게만']);
    assert.equal((await db.query('SELECT count(*)::int c FROM admin_notice_reads')).rows[0].c, 0);
  });
  await t('마스터도 그대로 쓴다(원본 권한자)', async () => {
    assert.equal((await call('get', '/settings/staff-notices', { name: 'master', role: 'master' })).status, 200);
  });

  // ── 화면: 팝업 모듈 실제 실행 ──
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'staff-notice-prompt.js'), 'utf8');
  const mkEl = (tag) => {
    const el = { tagName: tag, id: '', children: [], attrs: {}, innerHTML: '', textContent: '', listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; },
      remove() { const i = body.children.indexOf(this); if (i >= 0) body.children.splice(i, 1); } };
    return el;
  };
  const body = mkEl('body'); body.appendChild = (el) => { body.children.push(el); };
  const head = mkEl('head'); head.appendChild = () => {};
  // 브라우저 sessionStorage 처럼 Object.keys 가 저장된 키를 돌려주게 — 메서드는 열거되지 않게 둔다
  const store = {};
  for (const [k, f] of Object.entries({ getItem: k2 => (Object.prototype.hasOwnProperty.call(store, k2) ? store[k2] : null),
    setItem: (k2, v) => { store[k2] = String(v); }, removeItem: k2 => { delete store[k2]; } })) Object.defineProperty(store, k, { value: f, enumerable: false });
  const ctx = {
    window: {}, console, setTimeout: (f) => f(), Number, String, Object, JSON, Date, isNaN,
    sessionStorage: store,
    document: { body, head, createElement: mkEl, getElementById: (id) => body.children.find(c => c.id === id) || (id === 'snPromptStyles' ? null : null) },
  };
  ctx.window.toast = () => {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const SN = ctx.window.StaffNoticePrompt;
  const reads = [];
  const notices = [
    { id: 7, title: '<img src=x onerror=alert(1)>', content: '[필수열람]\n꼭 읽기 https://docs.example.com/a?x=1"onmouseover="alert(1)', created_by: '관리자갑', created_at: '2026-10-20T00:00:00Z', expires_at: '2026-10-27T00:00:00Z' },
    { id: 8, title: '일반', content: '그냥 안내', created_by: '관리자갑', created_at: '2026-10-20T00:00:00Z', expires_at: '2026-10-27T00:00:00Z' },
  ];
  const api = async (p, o) => {
    if (p === '/api/trackb/staff-notices/unread') return { success: true, notices };
    if (p === '/api/trackb/staff-notices/read') { reads.push(JSON.parse(o.body).notice_id); return { success: true }; }
    return null;
  };
  const ov = () => body.children.find(c => c.id === 'snOv');
  const click = (target) => ov().listeners.click({ target: { closest: (sel) => (sel.indexOf(target.kind) === 0 ? target : null), getAttribute: (k) => target.attrs[k] } });
  const btn = (attrs) => ({ kind: 'button', disabled: /data-ok="1" disabled/.test(ov().innerHTML) && attrs['data-ok'], getAttribute: k => attrs[k], attrs });

  SN.start({ api, name: '직원을' });
  await new Promise(r => setImmediate(r));
  await t('팝업이 뜬다 · 제목은 글자로만(태그 실행 0) · 필수열람 표시', async () => {
    assert.ok(ov(), '팝업 없음');
    assert.ok(/2건/.test(ov().innerHTML));
    assert.ok(ov().innerHTML.indexOf('<img src=x') < 0 && ov().innerHTML.indexOf('&lt;img src=x') >= 0);
    assert.ok(/필수열람<\/span>/.test(ov().innerHTML));
    assert.ok(ov().innerHTML.indexOf('[필수열람]') < 0, '마커는 본문에서 지운다');
  });
  await t('주소 속 따옴표는 escape 된 채로 남는다(href 탈출 0 — 속성이 하나 더 생기지 않는다) · 새 탭 + noopener', async () => {
    const m = ov().innerHTML.match(/<a href="([^"]*)" target="_blank" rel="noopener" data-doc="7">/);
    assert.ok(m && m[1].indexOf('https://docs.example.com/a?x=1&quot;') === 0, m && m[1]);
    assert.ok(/target="_blank" rel="noopener" data-doc="7"/.test(ov().innerHTML));
  });
  await t('필수열람 링크를 열기 전에는 [확인]이 잠겨 있고 눌러도 기록 0', async () => {
    assert.ok(/data-ok="1" disabled/.test(ov().innerHTML));
    await click(btn({ 'data-ok': '1' }));
    assert.deepStrictEqual(reads, []);
  });
  await t('링크를 열면 풀리고 [확인] = 보이던 공지 전부 읽음 기록 → 팝업이 닫힌다', async () => {
    click({ kind: 'a[data-doc]', attrs: { 'data-doc': '7' }, getAttribute: k => ({ 'data-doc': '7' })[k] });
    assert.ok(!/data-ok="1" disabled/.test(ov().innerHTML));
    assert.ok(/문서를 열었어요/.test(ov().innerHTML));
    await click(btn({ 'data-ok': '1' }));
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(reads, [7, 8]);
    assert.ok(!ov(), '팝업이 남았다');
  });
  await t('✕ 닫기 = 이번 접속에서만 숨김(기록 안 남김) · 로그아웃(stop)하면 숨김도 지운다', async () => {
    reads.length = 0;
    SN.start({ api, name: '직원병' });
    await new Promise(r => setImmediate(r));
    assert.ok(ov());
    click(btn({ 'data-x': '1' }));
    assert.ok(!ov()); assert.deepStrictEqual(reads, []);
    SN.start({ api, name: '직원병' });
    await new Promise(r => setImmediate(r));
    assert.ok(!ov(), '같은 접속에서 다시 떴다');
    SN.stop();
    assert.ok(!Object.keys(store).some(k => k.indexOf('wd_staffnotice_dismiss_v1_') === 0));
  });
  await t('조회 실패·구버전 서버(404)면 팝업 없이 지나간다(업무를 막지 않는다)', async () => {
    SN.start({ api: async () => ({ error: 'Not Found' }), name: 'x' });
    await new Promise(r => setImmediate(r));
    assert.ok(!ov());
    SN.start({ api: async () => { throw new Error('net'); }, name: 'x' });
    await new Promise(r => setImmediate(r));
    assert.ok(!ov());
  });

  await t('필수열람인데 주소가 덜 적혀 링크가 안 그려지면 [확인]을 잠그지 않는다(영영 못 누르는 막다른 길 0)', async () => {
    const half = SN._bodyHtml({ id: 9, content: '[필수열람]\n주소 https:// 나중에 붙임' });
    assert.ok(half.required && !half.gated && half.html.indexOf('<a ') < 0);
    const full = SN._bodyHtml({ id: 9, content: '[필수열람]\n주소 https://docs.example.com/a' });
    assert.ok(full.required && full.gated && full.html.indexOf('<a href="https://docs.example.com/a"') >= 0);
  });

  // ── 배선 ──
  const wdk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  await t('작업보드 배선: 내부 직원 접속 때 시작 · 로그아웃/세션만료 때 멈춤 · 스크립트 로드', async () => {
    assert.ok(/_isInternalRole\(\)\)\{[\s\S]{0,1200}StaffNoticePrompt\.start\(_sp\); else window\.__STAFFNOTICE_PENDING=_sp;/.test(wdk));
    assert.equal((wdk.match(/window\.__STAFFNOTICE_PENDING=null; if\(window\.StaffNoticePrompt\) window\.StaffNoticePrompt\.stop\(\);/g) || []).length, 2);
    assert.ok(/<script src="js\/staff-notice-prompt\.js\?v=\d{8}/.test(wdk));
  });

  // ── 서버 SQL(옛 adminNoticeGate.test.js 에서 이관 — 옛 관리자 대시보드 폐기, 결정 267) ──
  // pg 는 `($3::text || ' days')::interval` 의 $3 타입을 text·int 로 동시에 추론해
  // "inconsistent types deduced for parameter $3"으로 항상 실패한다(실측) → make_interval 고정.
  // 작업보드 직원 공지(trackB → admin.routes 핸들러 위임)가 같은 INSERT/UPDATE 를 탄다.
  const adminRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.routes.js'), 'utf8');
  await t('notices INSERT/UPDATE는 make_interval 사용(타입 추론 충돌 없음)', async () => {
    assert.ok((adminRoutes.match(/make_interval\(days => \$3::int\)/g) || []).length >= 2);
  });
  await t("구 '($3::text || days)::interval' 패턴 재유입 금지", async () => {
    assert.ok(!/\$3::text \|\| ' days'/.test(adminRoutes));
  });

  console.log(`\n✅ staffNoticeWorkdesk: ${passed}개 통과`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
