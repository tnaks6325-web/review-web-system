/**
 * 회귀가드 — 입금관리 맨 위 상품구입비 게이지 (결정 296)
 *
 * 고정하는 것:
 *   §1 서버는 인트라넷 GET /api/review-paybacks/gauge 를 서버간 키(X-Api-Key)로 부르고, 숫자만 옮겨 담는다(다시 계산하지 않는다)
 *   §2 인트라넷이 막거나(403)·죽거나·모양이 다르면 0 으로 꾸미지 않고 ok:false
 *   §3 1분 안에는 다시 부르지 않는다 · force 면 다시 부른다
 *   §4 화면 — 상품구입비 총액 − 리뷰웹으로 돌려준 상품값 − 기록 없이 나간 돈 = 남은 상품구입비, 막대·비율, 실제 내역이 없으면 「기록 없이 나간 돈」 칸 없음
 *   §5 라우트 — 입금관리와 같은 권한(admin/master) · 화면이 입금관리를 열 때 부른다
 *
 * 실행: node tests/paymentPaybackGauge.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}
const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const G = { contract_total: 301456420, contract_count: 91, paid_product: 208131750, outside: 32931516, rest: 60393154, unlinked_paid_product: 75406108, through: '2026-10-26' };

// 2026-10-28 — 인트라넷이 하나은행 장부를 붙인 뒤의 은행별 칸
const GH = { outside: 34547916, rest: 58776238, outside_kbank: 32931516, outside_hana: 1616400, hana_from: '2026-10-01', hana_through: '2026-10-23' };

function freshSvc() {
  const p = require.resolve('../src/services/trackB.service');
  delete require.cache[p];
  return require(p);
}

(async () => {
  console.log('\n▶ paymentPaybackGauge 회귀가드\n');
  const realFetch = global.fetch;

  await ta('§1 인트라넷 게이지를 서버간 키로 받아 숫자만 옮겨 담는다', async () => {
    process.env.INTRANET_API_KEY = 'k-test'; process.env.INTRANET_API_BASE = 'https://intra.test';
    const calls = [];
    global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ ok: true, gauge: { ...G, extra: 'x' } }) }; };
    const svc = freshSvc();
    const r = await svc.intranetPaybackGauge({ force: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://intra.test/api/review-paybacks/gauge');
    assert.equal(calls[0].opts.headers['X-Api-Key'], 'k-test', '키는 헤더로만');
    assert.ok(!/k-test/.test(calls[0].url), '주소에 키를 싣지 않는다');
    assert.equal(r.ok, true);
    assert.deepEqual(r.gauge, { ...G, outside_kbank: null, outside_hana: null, hana_from: null, hana_through: null }, '모르는 칸은 버리고 숫자는 그대로(옛 인트라넷 = 은행별 칸 null)');
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, gauge: { ...G, ...GH } }) });
    assert.deepEqual((await freshSvc().intranetPaybackGauge({ force: true })).gauge, { ...G, ...GH }, '은행별 칸도 그대로 옮긴다');
  });

  await ta('§2 막힘·오류·모양 다름은 ok:false (0 으로 꾸미지 않음)', async () => {
    const svc = freshSvc();
    global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    assert.deepEqual(await svc.intranetPaybackGauge({ force: true }), { ok: false, error: 'intranet_denied' });
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.deepEqual(await svc.intranetPaybackGauge({ force: true }), { ok: false, error: 'intranet_error' });
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    assert.deepEqual(await svc.intranetPaybackGauge({ force: true }), { ok: false, error: 'intranet_error' });
    global.fetch = async () => { throw new Error('down'); };
    assert.deepEqual(await svc.intranetPaybackGauge({ force: true }), { ok: false, error: 'intranet_unreachable' });
  });

  await ta('§3 1분 안에는 다시 부르지 않고, force 면 다시 부른다', async () => {
    const svc = freshSvc();
    let n = 0;
    global.fetch = async () => { n++; return { ok: true, status: 200, json: async () => ({ ok: true, gauge: G }) }; };
    await svc.intranetPaybackGauge(); await svc.intranetPaybackGauge();
    assert.equal(n, 1);
    await svc.intranetPaybackGauge({ force: true });
    assert.equal(n, 2);
  });
  global.fetch = realFetch;

  const html = read('frontend/workdesk.html');
  const grab = (start, end) => { const i = html.indexOf(start); const j = html.indexOf(end, i); assert.ok(i >= 0 && j > i, start); return html.slice(i, j); };
  const src = grab('function _pmGaugeHtml(){', 'function _pmBankPaint(){');
  const run = state => {
    const ctx = { STATE: { pmGauge: state }, esc: s => String(s == null ? '' : s), _pmNum: n => (Number(n) || 0).toLocaleString('en-US') };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.out = _pmGaugeHtml();', ctx);
    return ctx.out;
  };

  await ta('§4 화면 — 총액 − 돌려준 상품값 − 기록 없이 나간 돈 = 남은 상품구입비 · 막대 · 비율', async () => {
    const out = run({ ok: true, gauge: G });
    assert.match(out, /상품구입비 총액<\/div><div class="v ">301,456,420원/);
    assert.match(out, /계약 91건/);
    assert.match(out, /리뷰웹으로 돌려준 상품값<\/div><div class="v ">208,131,750원/);
    assert.match(out, /기록 없이 나간 돈<\/div><div class="v red">32,931,516원/);
    assert.match(out, /남은 상품구입비<\/div><div class="v ">60,393,154원/);
    assert.match(out, /계약에 잇지 않은 작업에 돌려준 상품값 75,406,108원/);
    assert.match(out, /2026-10-26까지 케이뱅크 실제 내역/);
    assert.equal((out.match(/<div style="background:/g) || []).length, 3, '막대 세 칸');
    assert.match(out, />69%</, '208,131,750 / 301,456,420');
    // 실제 내역이 없으면 「기록 없이 나간 돈」 칸 없음 · 더 나가면 음수 + 경고
    const over = run({ ok: true, gauge: { ...G, outside: null, paid_product: 130, contract_total: 100, rest: -30, unlinked_paid_product: 0 } });
    assert.doesNotMatch(over, /기록 없이 나간 돈<\/div>/);
    assert.match(over, /남은 상품구입비<\/div><div class="v warn">−30원/);
    assert.match(over, /30원 더 나갔습니다/);
    // 하나은행이 있으면 합치지 않고 은행별 두 칸 · 막대 네 칸 · 남은 상품구입비는 둘 다 뺀 값(사용자 요청 2026-10-28)
    const split = run({ ok: true, gauge: { ...G, ...GH } });
    assert.match(split, /기록 없이 나간 돈 · 케이뱅크<\/div><div class="v red">32,931,516원/);
    assert.match(split, /기록 없이 나간 돈 · 하나은행<\/div><div class="v red">1,616,400원/);
    assert.doesNotMatch(split, /34,547,916원/, '합친 금액은 보이지 않는다');
    assert.match(split, /남은 상품구입비<\/div><div class="v ">58,776,238원/);
    assert.equal((split.match(/<div style="background:/g) || []).length, 4, '막대 네 칸');
    assert.match(split, /케이뱅크 2026-10-26까지 · 하나은행 2026-10-01~2026-10-23 실제 내역/);
    assert.match(run(null), /받는 중/);
    assert.match(run({ error: 'intranet_denied' }), /받지 못했습니다 — 인트라넷 연결 설정/);
    assert.equal(run({ ok: true, gauge: { ...G, contract_total: 0 } }), '');
  });

  await ta('§5 라우트 권한 = 입금관리와 같음 · 입금관리를 열 때 부른다 · 맨 위 자리', async () => {
    const routes = read('server/src/routes/trackB.routes.js');
    assert.match(routes, /router\.get\('\/payment\/payback-gauge', authMiddleware, adminOrMasterMiddleware, async/);
    assert.match(html, /_pmBankRefresh\(false\);[^\n]*\n\s*_pmGaugeRefresh\(\);/);
    assert.match(html, /\$\{_pmTabsHtml\(\)\}\s*<div id="pmGauge">\$\{_pmGaugeHtml\(\)\}<\/div>\s*\$\{_pmFilterBar\(allItems\)\}/);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})();
