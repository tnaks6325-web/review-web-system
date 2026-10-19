'use strict';
// 결정 258: 마감 보관함 아래 "📦 예전 마감 작업"(옛 대시보드 ⬛ 마감) — 읽기 전용 · 쓰기 0.
// 실행: node tests/finishArchiveLegacyClosed.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

process.env.JWT_SECRET = 'test-legacy-closed';
(async () => {
  let passed = 0; const t = async (n, f) => { await f(); passed++; console.log('PASS ' + n); };
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,display_name text,campaign_name text,is_closed boolean DEFAULT false,updated_at timestamptz DEFAULT now());
    CREATE TABLE index_master_archive(sheet_id text,tab_name text,tab_gid text,campaign_name text,archived_at timestamptz,archived_by text);
    INSERT INTO tab_configs VALUES
      ('s1','옛마감A','11','','업체가',true,'2026-08-20'),
      ('s1','옛마감B','12','표시B','업체가',true,'2026-08-21'),
      ('s2','진행중','21','','업체나',false,'2026-09-01');
    INSERT INTO index_master_archive VALUES ('s1','옛마감A','11','캠페인A','2026-09-03','admin');
  `);
  const pool = require('../src/db/pool');
  pool.query = (sql, params) => db.query(sql, params);
  const writes = [];
  const realQuery = pool.query;
  pool.query = (sql, params) => { if (/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(sql); return realQuery(sql, params); };

  const router = require('../src/routes/trackB.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/workdesk/legacy-closed' && l.route.methods.get);
  assert.ok(layer, '라우트 없음');
  const handlers = layer.route.stack.map(s => s.handle);
  const jwt = require('jsonwebtoken');
  await new Promise(r => setTimeout(r, 300));   // 모듈 적재 때의 기동 작업(칸 확인 등)은 이 가드의 대상이 아니다
  const callWrites = [];
  const call = async (claims) => {
    const before = writes.length;
    try { return await _call(claims); } finally { callWrites.push(...writes.slice(before)); }
  };
  const _call = async (claims) => {
    const req = { headers: { authorization: 'Bearer ' + jwt.sign(claims, process.env.JWT_SECRET) }, method: 'GET',
      baseUrl: '/api/trackb', path: '/workdesk/legacy-closed', originalUrl: '/api/trackb/workdesk/legacy-closed', query: {} };
    let status = 200, body = null;
    const res = { status(c) { status = c; return this; }, json(o) { body = o; return this; }, set() { return this; } };
    for (const h of handlers) {
      let nexted = false;
      await h(req, res, (e) => { if (e) throw e; nexted = true; });
      if (!nexted) break;
    }
    return { status, body };
  };

  await t('직원(인트라넷 staff)도 목록을 받는다 · ⬛ 마감만 · 최신 보관순', async () => {
    const r = await call({ name: '직원', role: 'staff', via: 'intranet' });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.body.tabs.map(x => x.tabName), ['옛마감A', '옛마감B']);
    const a = r.body.tabs[0];
    assert.ok(a.hasArchive === true && a.archived === true && a.campaignName === '캠페인A' && a.displayName === '옛마감A');
    assert.ok(r.body.tabs[1].hasArchive === false && r.body.tabs[1].displayName === '표시B');
  });
  await t('광고주는 막는다(내부 운영 정보)', async () => {
    const r = await call({ name: '광고주', role: 'advertiser' });
    assert.equal(r.status, 403);
  });
  await t('쓰기 0 — 옛 마감을 🏁 로 옮기지 않는다(결정 255)', async () => {
    assert.deepStrictEqual(callWrites, []);
  });

  // ── 화면: 함수 추출 실행 ──
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  const grab = name => { const m = html.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}')); assert.ok(m, name); return m[0]; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ctx = { STATE: { tabs: [], finQ: '' }, esc, api: async () => ({ ok: true, tabs: [] }), document: { getElementById: () => null },
    selTab(k) { ctx.picked = k; }, _favKey: x => x.sheetId + '\t' + x.tabName };
  vm.createContext(ctx);
  vm.runInContext(['_finLegacyHtml', '_finOpenLegacy', '_finRenderLegacy', '_finLegacyRetry'].map(grab).join('\n') + '\n' + grab('_finLoadLegacy'), ctx);
  await t('목록 렌더: 건수·읽기 전용 안내 · 자료 없는 작업은 못 연다고 말한다 · onclick 은 인덱스만', async () => {
    ctx.STATE.legacyClosed = [
      { sheetId: 's1', tabName: "x'),alert(1),('", displayName: '<b>A</b>', campaignName: '캠페인A', archivedAt: '2026-09-03T00:00:00Z', hasArchive: true },
      { sheetId: 's1', tabName: '옛마감B', displayName: '표시B', campaignName: '업체가', closedAt: '2026-08-21', hasArchive: false },
    ];
    const h = vm.runInContext('_finLegacyHtml()', ctx);
    assert.match(h, /예전 마감 작업 <b>2<\/b>건/);
    assert.match(h, /onclick="_finOpenLegacy\(0\)"/);
    assert.ok(!/alert\(1\)/.test(h.replace(/&#39;/g, '')) || !/onclick="[^"]*alert/.test(h), '탭명이 onclick 에 들어가지 않는다');
    assert.ok(!/<b>A<\/b>/.test(h), '이름은 이스케이프');
    assert.match(h, /자료 없음/);
    assert.ok(!/_finOpenLegacy\(1\)/.test(h), '보관 자료 없는 줄은 열기 없음');
  });
  await t('검색어로 거른다(이름·업체)', async () => {
    ctx.STATE.finQ = '업체가';
    const h = vm.runInContext('_finLegacyHtml()', ctx);
    assert.ok(/표시B/.test(h) && !/_finOpenLegacy\(0\)/.test(h));
    ctx.STATE.finQ = '';
  });
  await t('열기 = 작업검색의 *마감 작업과 같은 규칙(읽기 전용으로 붙여 selTab) · 두 번 열어도 한 줄', async () => {
    vm.runInContext('_finOpenLegacy(0); _finOpenLegacy(0); _finOpenLegacy(1);', ctx);
    assert.equal(ctx.STATE.tabs.length, 1);
    assert.ok(ctx.STATE.tabs[0].archived === true && ctx.STATE.tabs[0].finished === true);
    assert.equal(ctx.picked, 0);
  });
  await t('조회 실패는 "없음"으로 꾸미지 않는다 — 다시 시도 안내', async () => {
    ctx.STATE.legacyClosed = null;
    assert.match(vm.runInContext('_finLegacyHtml()', ctx), /불러오지 못했습니다[\s\S]*_finLegacyRetry\(\)/);
  });
  await t('보관함 탭에서만 붙고, 검색이 그 칸도 다시 그린다', async () => {
    assert.match(html, /\$\{fin\?`<div id="wblLegacy">\$\{_finLegacyHtml\(\)\}<\/div>`:''\}/);
    assert.match(grab('_finSearch'), /_finRenderLegacy\(\);/);
  });
  console.log(`\n✅ finishArchiveLegacyClosed: ${passed}/${passed}`);
})().catch(e => { console.error(e); process.exit(1); });
