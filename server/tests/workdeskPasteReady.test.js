'use strict';
// 결정 264: 작업보드 사진 칸 "Ctrl+V 준비됨" 공용 장치(paste-ready.js) — 리뷰 대신 제출 · 캡처 교체 · 메시지 첨부 · 수동 주문.
// 실행: node tests/workdeskPasteReady.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FE = path.join(__dirname, '..', '..', 'frontend');
const pr = fs.readFileSync(path.join(FE, 'js', 'paste-ready.js'), 'utf8');
const wd = fs.readFileSync(path.join(FE, 'workdesk.html'), 'utf8');
const mo = fs.readFileSync(path.join(FE, 'js', 'manual-order.js'), 'utf8');
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log('PASS ' + n); };

const cls = new Set();
const ctx = { window: {}, console, setTimeout, clearTimeout, navigator: {}, File: function (b, n, o) { this.name = n; this.type = o.type; },
  document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}), hasFocus: () => true, addEventListener() {},
    documentElement: { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), add: c => cls.add(c), remove: c => cls.delete(c) } } } };
ctx.window.addEventListener = () => {};
vm.createContext(ctx); vm.runInContext(pr, ctx);
const P = ctx.window.PasteReady;

(async () => {
  await t('부품 모양: [Ctrl+V 붙여넣기] · [끌어다 놓기] + 상태 줄(준비됨/다른 창) · 파일 칸은 file 옵션일 때만', () => {
    const h = P.html({ dropSub: '최대 5장' });
    assert.ok(h.indexOf('data-prz="paste"') < h.indexOf('prz-drop'));
    assert.match(h, /<kbd>Ctrl<\/kbd>\+<kbd>V<\/kbd>/);
    assert.match(h, /지금 <b>Ctrl\+V<\/b> 하면 여기에 들어가요/);
    assert.match(h, /다른 창을 보고 있어요 — 이 창을 한 번 누른 뒤 <b>Ctrl\+V<\/b>/);
    assert.ok(!/type="file"/.test(h), '파일 고르기 창구를 새로 만들지 않는다(결정 136·192)');
    const hf = P.html({ file: { onchange: 'X(event)', multiple: true } });
    assert.match(hf, /<input type="file" accept="image\/\*" multiple hidden onchange="X\(event\)">/);
  });
  await t('사전 확인 중(wait) = 회색 · 누르기 막힘 · "준비됨" 문구 없음', () => {
    const h = P.html({ wait: '확인하는 중' });
    assert.match(h, /prz prz-wait/); assert.match(h, /<button type="button" class="prz-cell prz-paste" disabled>/);
    assert.ok(!/data-prz="paste"/.test(h) && !/하면 여기에 들어가요/.test(h));
  });
  await t('맥은 ⌘V 로 안내한다(키캡·상태 줄·실패 안내)', async () => {
    const c2 = { window: { addEventListener() {} }, console, setTimeout, clearTimeout, navigator: { platform: 'MacIntel' }, File: ctx.File,
      document: Object.assign({}, ctx.document) };
    vm.createContext(c2); vm.runInContext(pr, c2);
    const M = c2.window.PasteReady, h = M.html({});
    assert.match(h, /<kbd>⌘<\/kbd>\+<kbd>V<\/kbd>/); assert.match(h, /지금 <b>⌘V<\/b> 하면/); assert.ok(!/Ctrl/.test(h));
    assert.match((await M.readClipboard()).msg, /⌘V 를 눌러주세요/);
  });
  await t('클립보드를 읽는 사이 칸이 닫히면 결과를 버린다 — 엉뚱한 줄·받는 사람에 붙지 않게', async () => {
    let got = 0, handler = null;
    const btn = { _przBound: false, isConnected: true, addEventListener: (_e, f) => { handler = f; } };
    const host = { isConnected: true, classList: { add() {} }, querySelector: () => btn };
    ctx.navigator.clipboard = { read: async () => [{ types: ['image/png'], getType: async () => ({}) }] };
    P.bind(host, () => { got++; });
    host.isConnected = false;
    await handler({ preventDefault() {}, stopPropagation() {} });
    assert.equal(got, 0);
    host.isConnected = true;
    await handler({ preventDefault() {}, stopPropagation() {} });
    assert.equal(got, 1);
  });
  await t('창이 앞에 없으면 "다른 창" 상태(html.prz-blur) — hasFocus 기준', () => {
    ctx.document.hasFocus = () => false; P._syncFocus(); assert.ok(cls.has('prz-blur'));
    ctx.document.hasFocus = () => true; P._syncFocus(); assert.ok(!cls.has('prz-blur'));
  });
  await t('[Ctrl+V] 칸 누르기 실패는 이유를 말한다 — 미지원 · 거절 · 사진 없음', async () => {
    ctx.navigator.clipboard = undefined;
    assert.match((await P.readClipboard()).msg, /눌러서 붙여넣기를 못 해요/);
    ctx.navigator.clipboard = { read: async () => { throw new Error('denied'); } };
    assert.match((await P.readClipboard()).msg, /클립보드 읽기를 막았어요/);
    ctx.navigator.clipboard = { read: async () => [{ types: ['text/plain'] }] };
    assert.match((await P.readClipboard()).msg, /클립보드에 사진이 없어요/);
    ctx.navigator.clipboard = { read: async () => [{ types: ['image/png'], getType: async () => ({}) }] };
    const r = await P.readClipboard(); assert.equal(r.files.length, 1); assert.match(r.files[0].name, /^붙여넣기_\d{6}\.png$/);
  });
  await t('작업보드 3칸이 부품을 쓰고, 받는 함수는 각 칸의 기존 함수 그대로(장수·용량·사전확인 사본 0)', () => {
    assert.match(wd, /PasteReady\.html\(pre==='loading' \? \{compact:!!n, wait:'제출 가능 여부를 확인하는 중[^']*'\} : \{compact:!!n, dropSub:`최대 \$\{_MR_MAX_FILES\}장`\}\)/, '사전 확인 중엔 "준비됨"을 띄우지 않는다');
    assert.match(wd, /PasteReady\.bind\(dz, _manualReviewTake, toast\)/);
    assert.match(wd, /PasteReady\.html\(\{compact:!!st\.file, dropSub:'한 장'\}\)/);
    assert.match(wd, /PasteReady\.bind\(dz, _capTake, toast\)/);
    assert.match(wd, /PasteReady\.html\(\{compact:!!fs\.length, dropSub:`최대 \$\{_RM_MAX_FILES\}장`\}\)/);
    assert.match(wd, /PasteReady\.bind\(a, _rmTake, toast\)/);
    assert.ok(wd.indexOf('js/paste-ready.js') > 0 && wd.indexOf('js/paste-ready.js') < wd.indexOf('js/manual-order.js'), '부품이 수동 주문보다 먼저 실린다');
  });
  await t('부품이 안 실렸을 때(옛 캐시 등)는 종전 문구로 그린다 — 빈 칸이 되지 않는다', () => {
    assert.match(wd, /window\.PasteReady   \/\/ 결정 264[\s\S]{0,900}로 리뷰 캡처를 붙여넣으세요/);
    assert.match(wd, /로 새 \$\{K\.label\}를 붙여넣으세요/);
    assert.match(mo, /window\.PasteReady[\s\S]{0,300}여기에 <b>Ctrl\+V<\/b> 하거나 이미지를 끌어다 놓으세요/);
  });
  await t('받았을 때만 초록 깜빡임', () => {
    assert.match(wd, /const grew=next\.length>st\.files\.length;[\s\S]{0,120}if\(grew&&window\.PasteReady\) PasteReady\.flash\(document\.getElementById\('wrpDrop'\)\)/);
    assert.match(wd, /const grew=_RM\.files\.length>n0;[\s\S]{0,120}PasteReady\.flash\(document\.getElementById\('rmAtt'\)\)/);
  });
  await t('수동 주문: 넣는 길 한 곳(_stageAll) · 화면이 떠 있으면 칸을 안 눌러도 Ctrl+V · 글자·이미 처리한 붙여넣기는 건드리지 않음', () => {
    for (const fn of ['onTextPaste', 'onStagePaste', 'onDrop', 'onStageFiles']) {
      const b = mo.slice(mo.indexOf('function ' + fn), mo.indexOf('\n  }', mo.indexOf('function ' + fn)));
      assert.match(b, /_stageAll\(/, fn); assert.ok(!/forEach\(stageImage\)/.test(b), fn + ' 사본 금지');
    }
    const d = mo.slice(mo.indexOf("document.addEventListener('paste'"), mo.indexOf('function onDrop'));
    assert.match(d, /if \(ev\.defaultPrevented\) return;[\s\S]*offsetParent\) return;[\s\S]*if \(!imgs\.length\) return;\s*\n\s*ev\.preventDefault\(\);/);
    assert.match(mo, /PasteReady\.html\(\{ dropSub: '여러 장 가능', file: \{ onchange: 'ManualOrder\.onStageFiles\(event\)', multiple: true \} \}\)/);
  });
  console.log(`\n✅ workdeskPasteReady: ${passed}/${passed}`);
})().catch(e => { console.error(e); process.exit(1); });
