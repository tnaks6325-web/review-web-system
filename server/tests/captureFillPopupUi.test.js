'use strict';
/**
 * captureFillPopupUi.test.js — 결정 237: 어긋남 팝업의 [📷 캡처로 상품 찾기] · 결과 표 · 적용
 * 실행: node tests/captureFillPopupUi.test.js
 */
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/workdesk.html'), 'utf8');
function fn(name) { const re = new RegExp('(?:async )?function ' + name + '\\('); const m = re.exec(html); assert(m, name);
  let i = html.indexOf('{', m.index), d = 0; for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}' && --d === 0) break; } return html.slice(m.index, i + 1); }
let passed = 0;
async function ok(n, f) { await f(); passed++; console.log('  ✓ ' + n); }
function harness(role, apiImpl) {
  const els = {}; const log = { api: [], toast: [], alert: [] };
  const mk = (id) => ({ id, innerHTML: '', remove() { delete els[this.id]; }, set onclick(f) { this._c = f; } });
  const ctx = { STATE: { role, cur: { sheetId: 'S' } }, esc: s => String(s == null ? '' : s).replace(/[<>&"']/g, ''),
    document: { getElementById: id => els[id] || null, createElement: () => mk('x'), body: { appendChild(e) { els[e.id] = e; } },
      addEventListener() {}, removeEventListener() {} },
    api: async (u, o) => { log.api.push([u, JSON.parse(o.body)]); return apiImpl(JSON.parse(o.body)); },
    toast: m => log.toast.push(m), alert: m => log.alert.push(m), _wdQuotaAlert: async () => {} };
  vm.createContext(ctx);
  vm.runInContext(['_cfCanUse', '_cfClose', '_cfShell', 'openCaptureFill', '_cfPick', '_cfRender', '_cfApply'].map(fn).join('\n') +
    '\nconst _CF_LABEL=' + html.match(/const _CF_LABEL=(\{[\s\S]*?\});/)[1] + ';', ctx);
  return { ctx, els, log };
}
const PREVIEW = { ok: true, total: 3, nextOffset: null, options: [{ optKey: 'F', productName: '진간장 F' }, { optKey: 'S', productName: '진간장 S' }],
  items: [{ orderId: 'o1', seq: 195, day: '2026-09-05', status: 'matched', optKey: 'F', read: '진간장F' },
          { orderId: 'o2', seq: 196, day: '2026-09-05', status: 'ambiguous', read: '진간장 13L' },
          { orderId: 'o3', seq: 197, day: '2026-09-05', status: 'duplicate_rows', applicable: false }] };

(async () => {
  await ok('버튼은 관리자·마스터 + 상품별 남은 자리가 더 클 때(gap>0)만 — AE 에겐 안 보인다(서버 게이트 1:1)', async () => {
    assert.equal(harness('admin').ctx._cfCanUse({ gap: 7 }), true);
    assert.equal(harness('master').ctx._cfCanUse({ gap: 1 }), true);
    assert.equal(harness('staff').ctx._cfCanUse({ gap: 7 }), false);
    assert.equal(harness('admin').ctx._cfCanUse({ gap: -3 }), false);
  });
  await ok('미리보기 → 확정 줄만 미리 골라 둠 · 적용 불가 줄은 고르는 칸 없음 · n건 적용 버튼', async () => {
    const { ctx, els } = harness('admin', () => PREVIEW);
    await ctx.openCaptureFill('c1', 0);
    const h = els.cfOv.innerHTML;
    assert(/1건 적용/.test(h)); assert(/적용 불가/.test(h)); assert(/확정/.test(h) && /애매/.test(h));
    assert.deepEqual(ctx.STATE._cf.picks, { o1: 'F' });
  });
  await ok('사람이 애매한 줄을 고르면 수동지정으로, 확정 그대로면 캡처판독으로 보낸다(confirm:true)', async () => {
    const { ctx, els, log } = harness('admin', (b) => b.mode === 'preview' ? PREVIEW : { ok: true, written: 2, results: [{ ok: true }, { ok: true }] });
    await ctx.openCaptureFill('c1', 0);
    ctx._cfPick('o2', 'S');
    assert(/2건 적용/.test(els.cfOv.innerHTML));
    await ctx._cfApply();
    const ap = log.api.find(x => x[1].mode === 'apply')[1];
    assert.equal(ap.confirm, true);
    assert.deepEqual(ap.picks, [{ orderId: 'o1', optKey: 'F', source: 'capture' }, { orderId: 'o2', optKey: 'S', source: 'manual' }]);
    assert(/2건을 채웠습니다/.test(log.toast[0])); assert(!els.cfOv, '적용 뒤 창 닫힘');
  });
  await ok('Codex 리뷰: 다음 묶음으로 넘어가도 앞에서 고른 줄을 유지하고 함께 적용한다', async () => {
    const P2 = { ok: true, total: 4, nextOffset: null, options: PREVIEW.options, items: [{ orderId: 'o4', seq: 300, day: '2026-09-06', status: 'matched', optKey: 'S', read: 'S' }] };
    const { ctx, els, log } = harness('admin', (b) => b.mode === 'preview' ? (b.offset ? P2 : { ...PREVIEW, nextOffset: 3 }) : { ok: true, written: 3, results: [] });
    await ctx.openCaptureFill('c1', 0);
    ctx._cfPick('o2', 'S');
    await ctx.openCaptureFill('c1', 3, true);
    assert(/앞 묶음에서 고른 2건 포함/.test(els.cfOv.innerHTML)); assert(/3건 적용/.test(els.cfOv.innerHTML));
    await ctx._cfApply();
    const ap = log.api.find(x => x[1].mode === 'apply')[1];
    assert.deepEqual(ap.picks.map(p => p.orderId).sort(), ['o1', 'o2', 'o4']);
  });
  await ok('Codex 리뷰: 같은 상품 이름을 여러 옵션이 쓰면 옵션 이름까지 보인다', async () => {
    const P3 = { ok: true, total: 1, nextOffset: null, options: [{ optKey: '샴푸 · 500ml', productName: '샴푸' }, { optKey: '샴푸 · 1L', productName: '샴푸' }, { optKey: '린스', productName: '린스' }],
      items: [{ orderId: 'o1', seq: 1, day: '2026-09-05', status: 'ambiguous', read: '샴푸' }] };
    const { ctx, els } = harness('admin', () => P3);
    await ctx.openCaptureFill('c1', 0);
    const h = els.cfOv.innerHTML;
    assert(/샴푸 · 샴푸 · 500ml/.test(h) && /샴푸 · 샴푸 · 1L/.test(h)); assert(/>린스</.test(h));
  });
  await ok('미리보기 실패 → 실패를 말한다(조용한 실패 금지)', async () => {
    const { ctx, els } = harness('admin', () => ({ ok: false, error: '권한 없음' }));
    await ctx.openCaptureFill('c1', 0);
    assert(/읽지 못했습니다/.test(els.cfOv.innerHTML) && /권한 없음/.test(els.cfOv.innerHTML));
  });
  await ok('팝업에 버튼 배선', async () => {
    assert(/_cfCanUse\(qb\)\?'<button class="wbl-b" id="wdQbFill"/.test(html));
    assert(/fb\.onclick=\(\)=>\{ _wdQuotaAlertClose\(\); openCaptureFill\(cid\); \}/.test(html));
  });
  // ★ Codex 리뷰 #1843: 여러 묶음을 읽어 200건 넘게 고르면 한 요청에 다 실었고, 서버(옛 판)가 200건 뒤를 조용히 버렸다.
  //   → 화면이 200건씩 나눠 보내고 결과를 합친다(옛 서버·새 서버 모두에서 전부 적힌다). 상품 찾기·분류 채우기 같은 함수.
  const many = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ orderId: 'm' + (from + i), seq: from + i + 1, day: '2026-11-19', status: 'matched', optKey: 'F', read: 'F' }));
  const oldServer = (b) => {   // 옛 서버: 200건만 적고 나머지는 말없이 버린다
    const kept = b.picks.slice(0, 200);
    return { ok: true, written: kept.length, results: kept.map(p => ({ orderId: p.orderId, ok: true })) };
  };
  await ok('Codex 리뷰 #1843: 묶음 둘(250건)을 골라 적용 → 200건씩 나눠 보내 250건 전부 적는다 · 안내는 합친 건수', async () => {
    const { ctx, els, log } = harness('admin', (b) => b.mode === 'preview'
      ? (b.offset ? { ok: true, total: 250, nextOffset: null, options: PREVIEW.options, items: many(50, 200) } : { ok: true, total: 250, nextOffset: 200, options: PREVIEW.options, items: many(200) })
      : oldServer(b));
    await ctx.openCaptureFill('c1', 0);
    await ctx.openCaptureFill('c1', 200, true);
    assert(/250건 적용/.test(els.cfOv.innerHTML));
    await ctx._cfApply();
    const aps = log.api.filter(x => x[1].mode === 'apply').map(x => x[1]);
    assert(aps.every(b => b.picks.length <= 200 && b.confirm === true), '한 요청 200건 이하');
    const sent = aps.flatMap(b => b.picks.map(p => p.orderId));
    assert.equal(new Set(sent).size, 250, '고른 250건이 모두 서버에 간다(중복 없이)');
    assert.equal(sent.length, 250);
    assert(/상품 250건을 채웠습니다/.test(log.toast[0]), log.toast[0]);
    assert(!els.cfOv, '적용 뒤 창 닫힘');
  });
  await ok('Codex 리뷰 #1843: 나눠 보내다 중간에 실패 → 이미 적힌 건은 알리고, 못 보낸 줄은 고른 채 창에 남긴다(다시 누르면 이어서)', async () => {
    let n = 0;
    const { ctx, els, log } = harness('admin', (b) => b.mode === 'preview'
      ? { ok: true, total: 250, nextOffset: null, options: PREVIEW.options, items: many(250) }
      : (++n === 1 ? oldServer(b) : { ok: false, error: '서버 오류' }));
    await ctx.openCaptureFill('c1', 0);
    await ctx._cfApply();
    assert(/상품 200건을 채웠습니다/.test(log.toast[0]), '먼저 적힌 건수를 알린다');
    assert(/적용하지 못했습니다/.test(log.alert[0]));
    assert(els.cfOv, '창은 열려 있다');
    assert.equal(Object.keys(ctx.STATE._cf.picks).length, 50, '못 보낸 50건만 남는다');
    assert(/50건 적용/.test(els.cfOv.innerHTML));
  });
  console.log(`\n✅ captureFillPopupUi: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
