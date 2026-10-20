'use strict';
// 결정 266: 리뷰어 가격 신고 → 다른 리뷰어 2명이면 관리자 전원 팝업 → 리뷰웹 공고 금액 고치기 · 처리 이력 — 실제 실행 회귀가드.
//   서버: PGlite 실DB 로 신고 세기·알림·금액 쓰기(상품 칸 / 공고 글)·이력·권한을 돌린다.
//   화면: 팝업 모듈을 가짜 DOM 에서 돌려 금액 입력·버튼·XSS 방어를 본다 · 작업보드 배선 · 업체 렌즈.
// 실행: node tests/campaignPriceReport.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

process.env.JWT_SECRET = 'test-price-report';
(async () => {
  let passed = 0; const t = async (n, f) => { await f(); passed++; console.log('PASS ' + n); };
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT, thumbnail_url TEXT, manager TEXT, linked_tab_name TEXT,
      work_detail JSONB, archived_at TIMESTAMPTZ, status TEXT DEFAULT 'active', updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE campaign_options (id SERIAL PRIMARY KEY, campaign_id TEXT, opt_key TEXT, pay_amount INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active', thumbnail_url TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE campaign_applications (id SERIAL PRIMARY KEY, campaign_id TEXT, option_key TEXT, order_submission_id INTEGER, applied_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE order_submissions (id SERIAL PRIMARY KEY, sheet_id TEXT, campaign_application_id INTEGER, selected_opt_key TEXT);
    CREATE TABLE campaign_plan_events (id SERIAL PRIMARY KEY, campaign_id TEXT, actor TEXT, action TEXT, detail JSONB);
  `);
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '194_campaign_price_reports.sql'), 'utf8'));
  const P = { query: (s, p) => db.query(s, p), connect: async () => ({ query: (s, p) => db.query(s, p), release() {} }) };
  const pool = require('../src/db/pool');
  pool.query = P.query; pool.connect = P.connect;
  const svc = require('../src/services/campaignPriceReport.service');
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];

  await db.exec(`
    INSERT INTO recruit_campaigns (id, title, manager, linked_tab_name, work_detail) VALUES
      ('c1', '<b>탈취제</b>', '망고', '8/3 탈취제', '{"productLines":"탈취제 - A - 결제금액 9,190원"}'),
      ('c2', '간장', '만두', '간장 100건', '{"productLines":"간장 1L - 결제금액 12,000원","payAmount":12000}'),
      ('c3', '샴푸', '', '샴푸', '{"productLines":"샴푸 - 결제금액 9,000원\\n린스 - 결제금액 8,000원"}');
    INSERT INTO campaign_options (campaign_id, opt_key, pay_amount) VALUES ('c1', 'A', 9190), ('c1', 'B', 11000);
  `);
  let oid = 0;
  const order = async (cid, optKey) => {
    const a = await one(`INSERT INTO campaign_applications (campaign_id, option_key) VALUES ($1, $2) RETURNING id`, [cid, optKey || null]);
    const o = await one(`INSERT INTO order_submissions (sheet_id, campaign_application_id) VALUES ($1, $2) RETURNING id`, ['campaign:' + cid, a.id]);
    oid = o.id; return String(o.id);
  };
  const report = async (cid, optKey, phone) => svc.recordPriceReport({ orderSubmissionId: await order(cid, optKey), phone8: phone, pool: P });

  await t('신고 1명은 알림 없이 쌓이기만 한다 · 같은 리뷰어의 두 번째 주문은 한 명으로 센다 · 같은 주문은 두 번 세지 않는다', async () => {
    let r = await report('c1', 'A', '11112222');
    assert.deepStrictEqual([r.action, r.reporters], ['reported', 1]);
    r = await report('c1', 'A', '11112222');
    assert.deepStrictEqual([r.action, r.reporters], ['reported', 1]);
    r = await svc.recordPriceReport({ orderSubmissionId: String(oid), phone8: '33334444', pool: P });
    assert.strictEqual(r.action, 'duplicate');
    assert.strictEqual((await svc.listOpenAlerts({ pool: P })).items.length, 0);
    const card = await svc.priceReportsForCampaign(P, 'c1');
    assert.deepStrictEqual(card.open, [{ optKey: 'A', reports: 1 }]);
  });

  let alertA;
  await t('다른 리뷰어 2명 → 알림 1건(지금 금액 · 고칠 수 있음) · 공고 금액은 자동으로 바뀌지 않는다', async () => {
    const r = await report('c1', 'A', '55556666');
    assert.deepStrictEqual([r.action, r.reporters], ['alerted', 2]);
    const { items } = await svc.listOpenAlerts({ pool: P });
    assert.strictEqual(items.length, 1);
    alertA = items[0];
    assert.deepStrictEqual([alertA.optKey, alertA.reportCount, alertA.currentAmount, alertA.editable, alertA.tabName], ['A', 2, 9190, true, '8/3 탈취제']);
    assert.strictEqual((await one(`SELECT pay_amount FROM campaign_options WHERE campaign_id='c1' AND opt_key='A'`)).pay_amount, 9190);
    await report('c1', 'A', '77778888');   // 세 번째도 같은 알림을 올린다(새 알림 0)
    const again = (await svc.listOpenAlerts({ pool: P })).items;
    assert.deepStrictEqual([again.length, again[0].id, again[0].reportCount], [1, alertA.id, 3]);
  });

  await t('금액 고치기 — 잘못된 금액·같은 금액은 거절(쓰기 0) · 합계 같은 큰 금액도 거절', async () => {
    for (const amount of [0, -5, 'abc', 8900.5, 10000000, 93240000]) {
      const r = await svc.resolveAlert({ id: alertA.id, action: 'edit', amount, by: '관리자갑', pool: P });
      assert.strictEqual(r.code, 400, String(amount));
    }
    const same = await svc.resolveAlert({ id: alertA.id, action: 'edit', amount: 9190, by: '관리자갑', pool: P });
    assert.ok(same.code === 400 && /같아요/.test(same.error));
    assert.strictEqual((await one(`SELECT pay_amount FROM campaign_options WHERE opt_key='A'`)).pay_amount, 9190);
    assert.ok(!(await one(`SELECT resolved_at FROM campaign_price_alerts WHERE id=$1`, [alertA.id])).resolved_at);
  });

  await t('금액 고치기 — 그 상품 칸만 바뀌고(다른 상품 그대로) 신고 정리 · 이력(전→후·누가) · 공고 활동 기록', async () => {
    const r = await svc.resolveAlert({ id: alertA.id, action: 'edit', amount: 8900, by: '관리자갑', pool: P });
    assert.deepStrictEqual([r.ok, r.resolution, r.oldAmount, r.newAmount], [true, 'edited', 9190, 8900]);
    const opts = (await db.query(`SELECT opt_key, pay_amount FROM campaign_options WHERE campaign_id='c1' ORDER BY opt_key`)).rows;
    assert.deepStrictEqual(opts.map(o => o.pay_amount), [8900, 11000]);
    const card = await svc.priceReportsForCampaign(P, 'c1');
    assert.deepStrictEqual(card.open, []);
    assert.deepStrictEqual(card.history.map(h => [h.optKey, h.resolution, h.oldAmount, h.newAmount, h.by]), [['A', 'edited', 9190, 8900, '관리자갑']]);
    const ev = await one(`SELECT actor, action, detail FROM campaign_plan_events WHERE campaign_id='c1'`);
    assert.deepStrictEqual([ev.actor, ev.action, ev.detail.from, ev.detail.to], ['관리자갑', 'price_edited', 9190, 8900]);
    assert.strictEqual((await svc.listOpenAlerts({ pool: P })).items.length, 0);
  });

  await t('늦게 누른 사람 = "이미 처리됨 · 처리한 사람"(쓰기 0)', async () => {
    const r = await svc.resolveAlert({ id: alertA.id, action: 'edit', amount: 7000, by: '직원을', pool: P });
    assert.deepStrictEqual([r.ok, r.already, r.resolvedBy], [true, true, '관리자갑']);
    assert.strictEqual((await one(`SELECT pay_amount FROM campaign_options WHERE opt_key='A'`)).pay_amount, 8900);
  });

  await t('정리된 뒤 신고는 처음부터 센다(1명 = 알림 없음)', async () => {
    const r = await report('c1', 'A', '11112222');
    assert.deepStrictEqual([r.action, r.reporters], ['reported', 1]);
  });

  await t('상품을 나누지 않은 공고 — 공고 글 「결제금액 N원」과 payAmount 를 같이 고친다(리뷰어 화면은 글자를 먼저 읽는다)', async () => {
    await report('c2', null, '10000001'); await report('c2', null, '10000002');
    const it = (await svc.listOpenAlerts({ pool: P })).items.find(x => x.campaignId === 'c2');
    assert.deepStrictEqual([it.optKey, it.hasOptions, it.currentAmount, it.editable], ['', false, 12000, true]);
    const r = await svc.resolveAlert({ id: it.id, action: 'edit', amount: 13500, by: '관리자갑', pool: P });
    assert.ok(r.ok);
    const wd = (await one(`SELECT work_detail FROM recruit_campaigns WHERE id='c2'`)).work_detail;
    assert.deepStrictEqual([wd.productLines, wd.payAmount], ['간장 1L - 결제금액 13,500원', 13500]);
  });

  await t('★ 공고 글에 금액이 여러 개면 고치지 않는다(fail-closed) — 팝업은 안내만 · [그대로 두기]로 닫을 수 있다(막다른 길 0)', async () => {
    await report('c3', null, '20000001'); await report('c3', null, '20000002');
    const it = (await svc.listOpenAlerts({ pool: P })).items.find(x => x.campaignId === 'c3');
    assert.deepStrictEqual([it.editable, it.notEditableWhy, it.currentAmount], [false, 'multiple_amounts', null]);
    const r = await svc.resolveAlert({ id: it.id, action: 'edit', amount: 9500, by: '관리자갑', pool: P });
    assert.ok(r.code === 409 && /모집공고 수정/.test(r.error));
    assert.ok(/9,000원[\s\S]*8,000원/.test((await one(`SELECT work_detail FROM recruit_campaigns WHERE id='c3'`)).work_detail.productLines));
    const k = await svc.resolveAlert({ id: it.id, action: 'keep', by: '직원을', pool: P });
    assert.ok(k.ok && k.resolution === 'kept');
    assert.deepStrictEqual((await svc.priceReportsForCampaign(P, 'c3')).open, []);
  });

  await t('[결정 보류] = 알림만 닫고 신고는 남긴다 → 한 명이 더 신고하면 다시 뜬다 · 이력에 "보류"', async () => {
    await report('c1', 'B', '30000001'); await report('c1', 'B', '30000002');
    let it = (await svc.listOpenAlerts({ pool: P })).items.find(x => x.optKey === 'B');
    const d = await svc.resolveAlert({ id: it.id, action: 'defer', by: '직원병', pool: P });
    assert.ok(d.ok && d.resolution === 'deferred');
    assert.deepStrictEqual((await svc.priceReportsForCampaign(P, 'c1')).open.find(o => o.optKey === 'B'), { optKey: 'B', reports: 2 });
    assert.strictEqual((await svc.listOpenAlerts({ pool: P })).items.filter(x => x.optKey === 'B').length, 0);
    // ★ 코드리뷰 P2: 이미 센 리뷰어가 또 취소해도 보류한 알림은 다시 뜨지 않는다(새 리뷰어만)
    const same = await report('c1', 'B', '30000001');
    assert.deepStrictEqual([same.action, same.reporters], ['reported', 2]);
    assert.strictEqual((await svc.listOpenAlerts({ pool: P })).items.filter(x => x.optKey === 'B').length, 0);
    const r = await report('c1', 'B', '30000003');
    assert.deepStrictEqual([r.action, r.reporters], ['alerted', 3]);
    it = (await svc.listOpenAlerts({ pool: P })).items.find(x => x.optKey === 'B');
    assert.ok(it && it.id !== d.id && it.reportCount === 3);
    const h = (await svc.priceReportsForCampaign(P, 'c1')).history;
    assert.ok(h.some(x => x.optKey === 'B' && x.resolution === 'deferred' && x.by === '직원병' && x.oldAmount === 11000 && x.newAmount === null));
  });

  await t('상품이 마감되면 알림을 정리한다(gone — 이력에는 안 남는다) · 마감 상품에 온 신고는 세지 않는다', async () => {
    await db.query(`UPDATE campaign_options SET status='closed' WHERE opt_key='B'`);
    assert.strictEqual((await svc.listOpenAlerts({ pool: P })).items.filter(x => x.optKey === 'B').length, 0);
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual((await one(`SELECT resolution FROM campaign_price_alerts WHERE opt_key='B' ORDER BY id DESC LIMIT 1`)).resolution, 'gone');
    assert.ok(!(await svc.priceReportsForCampaign(P, 'c1')).history.some(x => x.resolution === 'gone'));
    // ★ 코드리뷰 P2: 닫을 때 그 상품의 쌓인 신고도 정리한다 — 카드에 남지 않고, 다시 열어도 옛 신고를 세지 않는다
    assert.strictEqual(Number((await one(`SELECT COUNT(*) n FROM campaign_price_reports WHERE campaign_id='c1' AND opt_key='B' AND cleared_at IS NULL`)).n), 0);
    assert.ok(!(await svc.priceReportsForCampaign(P, 'c1')).open.some(o => o.optKey === 'B'));
    const r = await report('c1', 'B', '30000004');
    assert.strictEqual(r.action, 'unknown_option');
  });

  // ── 경로·권한 ──
  const router = require('../src/routes/trackB.routes');
  const jwt = require('jsonwebtoken');
  await new Promise(r => setTimeout(r, 300));
  const call = async (method, p, claims, body, params) => {
    const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    assert.ok(layer, '라우트 없음: ' + method + ' ' + p);
    const req = { headers: { authorization: 'Bearer ' + jwt.sign(claims, process.env.JWT_SECRET) }, method: method.toUpperCase(),
      baseUrl: '/api/trackb', path: p, originalUrl: '/api/trackb' + p, query: {}, params: params || {}, body: body || {} };
    let status = 200, out = null;
    const res = { status(c) { status = c; return this; }, json(o) { out = o; return this; }, set() { return this; } };
    for (const h of layer.route.stack.map(s => s.handle)) {
      let nexted = false;
      await h(req, res, (e) => { if (e) throw e; nexted = true; });
      if (!nexted) break;
    }
    return { status, body: out };
  };
  await t('경로: 내부 직원(관리자·AE)은 목록·처리 가능 · 업체 계정은 막힌다', async () => {
    const AE = { name: '직원을', role: 'staff', via: 'intranet' };
    const ADV = { name: '업체', role: 'advertiser' };
    const list = await call('get', '/price-alerts', AE);
    assert.ok(list.status === 200 && list.body.ok && Array.isArray(list.body.items));
    assert.ok((await call('get', '/price-alerts', ADV)).status >= 400);
    await report('c2', null, '40000001'); await report('c2', null, '40000002');
    const it = (await call('get', '/price-alerts', AE)).body.items.find(x => x.campaignId === 'c2');
    assert.ok((await call('post', '/price-alerts/:id/resolve', ADV, { action: 'keep' }, { id: String(it.id) })).status >= 400);
    const ok = await call('post', '/price-alerts/:id/resolve', AE, { action: 'edit', amount: 14000 }, { id: String(it.id) });
    assert.ok(ok.status === 200 && ok.body.ok);
    assert.strictEqual((await svc.priceReportsForCampaign(P, 'c2')).history[0].by, '직원을');
    const bad = await call('post', '/price-alerts/:id/resolve', AE, { action: 'pause' }, { id: String(it.id) });
    assert.strictEqual(bad.status, 400);
  });

  // ── 배선 ──
  const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const RF = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
  await t('취소 사유 "화면과 가격이 달라요"(price)만 가격 신고로 센다 · 취소 뒤 후처리(실패해도 취소 유효)', async () => {
    const src = R('src/services/reviewerOrderCancel.service.js');
    assert.ok(/\{ key: 'price', label: '화면과 가격이 달라요' \}/.test(src));
    assert.ok(/if \(String\(reasonKey \|\| ''\) === 'price'\) \{\s*try \{\s*const r = await require\('\.\/campaignPriceReport\.service'\)\.recordPriceReport/.test(src));
    assert.ok(src.indexOf("recordPriceReport") > src.indexOf('hideWorkdeskRow'), '취소(행 숨김) 뒤에 센다');
  });
  await t('★ 끄는 스위치가 꺼져 있으면 금액 고치기를 거절한다(남은 팝업·직접 호출) · 상품 이름 바꾸기가 신고·알림을 옮긴다 · 필수 스키마', async () => {
    const src = R('src/services/campaignPriceReport.service.js');
    assert.ok(/if \(action === 'edit'\) \{[\s\S]{0,260}if \(!ENABLED\) return \{ ok: false/.test(src));
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'latin1');
    assert.strictEqual((routes.match(/UPDATE campaign_price_reports SET opt_key=\$3/g) || []).length, 2);
    assert.strictEqual((routes.match(/UPDATE campaign_price_alerts SET opt_key=\$3/g) || []).length, 2);
    const idx = R('index.js');
    assert.ok(/'campaign_price_reports',/.test(idx) && /'campaign_price_alerts',/.test(idx));
  });
  await t('업체 렌즈는 가격 신고를 내보내지 않는다(화이트리스트) · 작업조건 재료에 실린다', async () => {
    const src = R('src/services/trackB.service.js');
    const lens = src.slice(src.indexOf('function _condAdvertiserLens'), src.indexOf('function _condAdvertiserLens') + 4000);
    assert.ok(lens.indexOf('priceReports') < 0);
    assert.ok(/priceReports: c \? await require\('\.\/campaignPriceReport\.service'\)\.priceReportsForCampaign\(db, c\.id\) : null/.test(src));
  });
  const wdk = RF('frontend/workdesk.html');
  await t('작업보드 배선: 내부 직원 접속 때 시작 · 로그아웃/세션만료 때 멈춤 · 스크립트 · 실시간 통로 · 카드 줄', async () => {
    assert.ok(/_isInternalRole\(\)\)\{[\s\S]{0,1800}PriceAlertPrompt\.start\(_sp\); else window\.__PRICEALERT_PENDING=_sp;/.test(wdk));
    assert.strictEqual((wdk.match(/window\.__PRICEALERT_PENDING=null; if\(window\.PriceAlertPrompt\) window\.PriceAlertPrompt\.stop\(\);/g) || []).length, 2);
    assert.ok(/<script src="js\/price-alert-prompt\.js\?v=\d{8}/.test(wdk));
    assert.ok(/addEventListener\('price_alert',ev=>\{[\s\S]{0,200}PriceAlertPrompt\.refresh\(\)/.test(wdk));
    assert.ok(/\$\{_cndSalesRow\(cd\)\}\$\{_cndPriceRow\(cd\)\}/.test(wdk));
    assert.ok(/function _cndPriceRow\(cd\)\{[\s\S]{0,200}STATE\.role==='advertiser'/.test(wdk));
  });
  await t('실시간 알림은 관리자 화면 연결에만 · 이름·번호·상품명 없이', async () => {
    const src = R('src/services/campaignPriceReport.service.js');
    assert.ok(/broadcast\('price_alert', \{ message: '가격 신고 알림', \.\.\.payload \}, \(c\) => \{[\s\S]{0,120}role === 'admin' \|\| role === 'workdesk'/.test(src));
    assert.ok(!/_emit\(\{[^}]*(optKey|title|phone|reviewer)/.test(src));
  });

  // ── 화면: 팝업 모듈 실제 실행 ──
  const src = RF('frontend/js/price-alert-prompt.js');
  const mkEl = (tag) => ({ tagName: tag, id: '', children: [], attrs: {}, innerHTML: '', listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; },
    contains() { return false; }, remove() { const i = body.children.indexOf(this); if (i >= 0) body.children.splice(i, 1); } });
  const body = mkEl('body'); body.appendChild = (el) => { body.children.push(el); };
  const head = mkEl('head'); head.appendChild = () => {};
  const mkStore = () => { const s = {}; for (const [k, f] of Object.entries({ getItem: k2 => (Object.prototype.hasOwnProperty.call(s, k2) ? s[k2] : null), setItem: (k2, v) => { s[k2] = String(v); }, removeItem: k2 => { delete s[k2]; } })) Object.defineProperty(s, k, { value: f, enumerable: false }); return s; };
  const ctx = { window: {}, console, setTimeout: (f) => f(), clearTimeout() {}, setInterval: () => 1, clearInterval() {}, Number, String, Object, JSON, Date, isNaN, isFinite,
    sessionStorage: mkStore(), localStorage: mkStore(),
    document: { body, head, activeElement: null, createElement: mkEl, getElementById: (id) => body.children.find(c => c.id === id) || null } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const PA = ctx.window.PriceAlertPrompt;
  const posts = [];
  let items = [
    { id: 11, campaignId: 'c1', optKey: 'A<img src=x>', hasOptions: true, reportCount: 2, title: '<script>x</script>', thumbnailUrl: '', manager: '망고', tabName: '작업', currentAmount: 9190, editable: true, notEditableWhy: '' },
    { id: 12, campaignId: 'c3', optKey: '', hasOptions: false, reportCount: 2, title: '샴푸', currentAmount: null, editable: false, notEditableWhy: 'multiple_amounts' },
  ];
  const api = async (p, o) => {
    if (p === '/api/trackb/price-alerts') return { ok: true, items };
    posts.push({ p, b: JSON.parse(o.body) });
    items = items.filter(x => String(x.id) !== p.split('/')[4]);
    return { ok: true, resolution: 'edited', oldAmount: 9190, newAmount: 8900 };
  };
  const ov = () => body.children.find(c => c.id === 'paOv');
  const click = (attrs) => ov().listeners.click({ target: { closest: () => ({ disabled: false, getAttribute: k => (k in attrs ? attrs[k] : null) }) } });
  PA.start({ api, name: '관리자갑' });
  await new Promise(r => setImmediate(r));
  await t('팝업: 두 건 · 제목·상품명은 글자로만(태그 실행 0) · 지금 금액 · 고칠 수 없는 공고는 안내만(입력칸 없음)', async () => {
    const h = ov().innerHTML;
    assert.ok(/가격 신고 알림/.test(h) && /2건/.test(h));
    assert.ok(h.indexOf('<script>x') < 0 && h.indexOf('&lt;script&gt;x') >= 0 && h.indexOf('A<img') < 0);
    assert.ok(/지금 공고 금액 <b>9,190원<\/b>/.test(h));
    assert.strictEqual((h.match(/data-a="edit"/g) || []).length, 1, '고칠 수 없는 공고엔 [금액 고치기]가 없다');
    assert.ok(/모집공고 수정에서 고쳐 주세요/.test(h));
    assert.strictEqual((h.match(/data-a="keep"/g) || []).length, 2);
    assert.strictEqual((h.match(/data-a="defer"/g) || []).length, 2);
    assert.ok(/인트라넷 리뷰오더는 그대로/.test(h));
  });
  await t('팝업: 금액을 안 적고 [금액 고치기] = 보내지 않는다 · 쉼표·"원"을 지워 숫자로 보낸다', async () => {
    await click({ 'data-i': '0', 'data-a': 'edit' });
    assert.strictEqual(posts.length, 0);
    assert.deepStrictEqual([PA._parseWon('8,900원'), PA._parseWon(' 8900 '), PA._parseWon('8.9천')].map(v => (Number.isNaN(v) ? 'NaN' : v)), [8900, 8900, 'NaN']);
    ov().listeners.input({ target: { getAttribute: k => (k === 'data-in' ? '0' : null), value: '8,900' } });
    await click({ 'data-i': '0', 'data-a': 'edit' });
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(posts[0], { p: '/api/trackb/price-alerts/11/resolve', b: { action: 'edit', amount: 8900 } });
    assert.ok(/1건/.test(ov().innerHTML), '처리한 알림은 다시 읽어 사라진다');
  });
  await t('팝업: [결정 보류] 전달 · 다 처리하면 닫힌다 · stop 하면 정리', async () => {
    await click({ 'data-i': '0', 'data-a': 'defer' });
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(posts[1], { p: '/api/trackb/price-alerts/12/resolve', b: { action: 'defer' } });
    assert.ok(!ov());
    PA.stop();
    assert.ok(!ov());
  });

  console.log(`\n✅ campaignPriceReport: ${passed}개 통과`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
