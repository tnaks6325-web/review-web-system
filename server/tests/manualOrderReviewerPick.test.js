'use strict';
/**
 * manualOrderReviewerPick.test.js — 결정 348 화면 회귀가드(외부모집 수동제출 「리뷰어 연결」 칸)
 * 실행: node --test tests/manualOrderReviewerPick.test.js   (DB·서버·브라우저 불필요 — 실제 manual-order.js 를 vm 에 올린다)
 *
 *  ① 줄마다 「리뷰어 연결」 칸 — 기본 「자동」 · 리뷰어 이름 바로 옆
 *  ② 칸을 누르면 팝오버 — 검색어 기본값 = 그 줄 리뷰어 이름 · 바로 검색 · 결과는 이름·전화 뒤 4자리·계좌 뒤 4자리
 *  ③ 두 글자 미만은 묻지 않는다 · 한글 조합 중에는 묻지 않고 조합이 끝난 글로 묻는다(창 루트 compositionend)
 *  ④ 고르면 「기존: 이름(…뒤4)」 · [새로 등록] · [자동] — 제출 본문에 reviewerLink {mode, reviewerId}
 *  ⑤ 팝오버가 열린 채 표가 다시 그려져도(나누기 결과 도착) 팝오버 요소는 그대로(검색칸 포커스·조합 보호)
 *  ⑥ 고른 뒤 그 줄 연락처가 바뀌면 자동으로 되돌린다(남의 리뷰어에 붙지 않게)
 *  ⑦ 배포 스큐 — 옛 서버(reviewerLinkApplied 없음)면 결과에 경고
 */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MO = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'manual-order.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = '00000000-0000-4000-8000-00000000000a';

function boot(server) {
  const calls = [];
  const toasts = [];
  let ovl = null;
  let renders = 0;
  const mkEl = () => {
    const attrs = {};
    const el = {
      id: '', className: '', style: {}, innerHTML: '', parentNode: null,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k]; },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
      focus() {}, select() {},
    };
    return el;
  };
  const mkOvl = () => {
    const L = {};
    let html = '';
    const kids = [];
    const box = { id: '', __box: true };
    const o = {
      id: 'moOvl', style: {}, classList: { add() {}, remove() {}, toggle() {} }, __L: L, __kids: kids,
      addEventListener(t, fn, cap) { (L[t] = L[t] || []).push({ fn, cap: !!cap }); },
      remove() { ovl = null; },
      get innerHTML() { return html; }, set innerHTML(v) { html = v; kids.length = 0; renders++; },
      set className(_) {},
      get childNodes() { return (html ? [box] : []).concat(kids); },
      removeChild(n) { if (n === box) html = ''; else { const k = kids.indexOf(n); if (k >= 0) kids.splice(k, 1); n.parentNode = null; } },
      appendChild(n) { kids.push(n); n.parentNode = o; },
      insertAdjacentHTML(_pos, v) { html = v; renders++; },
      contains(n) { return n === box || kids.includes(n); },
    };
    return o;
  };
  const listEl = { id: 'moRlList', innerHTML: '' };
  const qEl = { id: 'moRlQ', value: '', focus() {}, select() {} };
  const lkStub = new Map();
  const document = {
    head: { appendChild() {} },
    body: { appendChild(el) { ovl = el; } },
    activeElement: null,
    createElement() { return ovl ? mkEl() : mkOvl(); },
    getElementById(id) {
      if (id === 'mo-style') return {};
      if (id === 'moOvl') return ovl;
      if (!ovl) return null;
      const pop = ovl.__kids.find(k => k.id === 'moRl') || null;
      if (id === 'moRl') return pop;
      if (id === 'moRlList') return pop ? listEl : null;
      if (id === 'moRlQ') return pop ? qEl : null;
      if (/^moLk-/.test(id)) {
        if (!ovl.innerHTML.includes(`id="${id}"`)) return null;
        if (!lkStub.has(id)) lkStub.set(id, { id, focus() {}, classList: { add() {}, remove() {} }, parentNode: { innerHTML: '' } });
        return lkStub.get(id);
      }
      if (id === 'moSubmit' || id === 'moOptTip') return ovl.innerHTML.includes(`id="${id}"`) ? { id, disabled: false, textContent: '' } : null;
      return null;
    },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {},
  };
  const win = {
    document, console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, Error,
    sessionStorage: { getItem: () => 'tok' }, localStorage: { getItem: () => '' },
    location: { hostname: 'x' }, API_BASE_URL: 'http://api', encodeURIComponent,
    alert() {}, confirm: () => true, toast(m) { toasts.push(m); },
    fetch: async (url, o) => {
      const p = String(url).replace('http://api', '');
      const body = o && o.body ? JSON.parse(o.body) : {};
      calls.push({ p, body, method: (o && o.method) || 'GET' });
      const r = await server(p, body);
      return { json: async () => r };
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(MO, win);
  const M = win.ManualOrder;
  const html = () => (ovl ? ovl.innerHTML : '');
  const fire = (type, target) => ((ovl && ovl.__L[type]) || []).forEach(l => l.fn({ type, target, isComposing: type !== 'compositionend' }));
  return {
    M, calls, toasts, html, fire, listEl,
    renders: () => renders,
    pop: () => (ovl ? ovl.__kids.find(k => k.id === 'moRl') : null),
    searches: () => calls.filter(c => /\/reviewer-search\?/.test(c.p)),
    submits: () => calls.filter(c => /\/submit$/.test(c.p)),
  };
}

const LINE = {
  KIM: '김수만/김수만/kim01/010-1234-6325/서울시 마포구 1/신한은행/110-111-1234/김수만/15800',
  PARK: '박지영/박지영/park02/010-2222-2222/서울시 강남구 2/국민은행/220-222/박지영/15800',
};
const fieldsOf = l => { const p = l.split('/'); return { reviewerName: p[0], recipient: p[1], userId: p[2], phone: p[3], address: p[4], bank: p[5], account: p[6], depositor: p[7], price: Number(p[8]) }; };
function server(opt) {
  const o = Object.assign({ oldServer: false }, opt || {});
  return async (p, body) => {
    if (/\/preview$/.test(p)) {
      const items = String(body.text).split('\n').filter(s => s.trim()).map(l => ({ ok: true, raw: l, fields: fieldsOf(l), errors: [], warnings: [] }));
      return { ok: true, items, optionChoices: [] };
    }
    if (/\/reviewer-search\?/.test(p)) {
      return { ok: true, hasMore: false, items: [{ id: UA, name: '김수만', phoneTail: '6325', accountTail: '1234' },
        { id: '00000000-0000-4000-8000-00000000000b', name: '김수만', phoneTail: '9999', accountTail: '' }] };
    }
    if (/\/submit$/.test(p)) {
      const results = body.items.map((it, i) => Object.assign({ index: i, ok: true, name: it.fields.recipient, orderSubmissionId: 'os' + i, captureSession: {}, warnings: [] },
        o.oldServer ? {} : { reviewerLinkApplied: (it.reviewerLink && it.reviewerLink.mode) || 'auto', linkedReviewer: it.reviewerLink && it.reviewerLink.mode === 'existing' ? '김수만' : null }));
      return { ok: true, okCount: results.length, failCount: 0, results };
    }
    return { ok: true, data: [] };
  };
}
async function twoRows(B) {
  B.M.open({ sheetId: 's', tabName: 't' });
  B.M.pasteLines(0, [LINE.KIM, LINE.PARK]);
  await B.M.flush();
}
const cellText = (h, uid) => { const m = new RegExp(`id="moLk-${uid}"[^>]*>\\s*<span class="t">([^<]*)<`).exec(h); return m ? m[1] : null; };
const uids = h => [...h.matchAll(/id="moLk-(\d+)"/g)].map(m => Number(m[1]));

test('① 줄마다 「리뷰어 연결」 칸 — 기본 「자동」 · 리뷰어 칸 바로 옆', async () => {
  const B = boot(server());
  await twoRows(B);
  const h = B.html();
  const heads = [...h.matchAll(/<th class="[^"]*"(?: title="[^"]*")?>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.strictEqual(heads[heads.indexOf('리뷰어') + 1], '리뷰어 연결', '머리: ' + heads.join('|'));
  const u = uids(h);
  assert.strictEqual(u.length, 2, '나뉜 두 줄에 칸이 있다(빈 줄엔 없다)');
  assert.deepStrictEqual(u.map(x => cellText(h, x)), ['자동', '자동']);
});

test('② 누르면 팝오버 — 검색어 기본값 = 그 줄 리뷰어 이름 · 바로 검색 · 뒤 4자리만', async () => {
  const B = boot(server());
  await twoRows(B);
  B.M.openLink(0);
  assert.ok(B.pop(), '팝오버가 열렸다');
  assert.match(B.pop().innerHTML, /id="moRlQ" value="김수만"/, '검색어 기본값 = 리뷰어 이름');
  assert.ok(!/mo-btn pri/.test(B.pop().innerHTML), '팝오버에 채운 파란 단추 없음(창당 1개 유지)');
  await sleep(20);
  const s = B.searches();
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].p, '/api/manual-order/reviewer-search?q=' + encodeURIComponent('김수만'));
  assert.strictEqual(s[0].method, 'GET');
  assert.match(B.listEl.innerHTML, /김수만<\/span><span class="ph">…6325<\/span><span class="ac">계좌 …1234<\/span>/);
  assert.match(B.listEl.innerHTML, /번호 같음/, '수취인 뒤 4자리와 같은 사람에 표시');
  B.M.openLink(0);
  assert.strictEqual(B.pop(), undefined, '같은 칸을 다시 누르면 닫힌다');
});

test('③ 두 글자 미만은 묻지 않는다 · 한글 조합 중에는 묻지 않고 조합이 끝난 글로 묻는다', async () => {
  const B = boot(server());
  await twoRows(B);
  B.M.openLink(1);
  await sleep(20);
  const n0 = B.searches().length;
  B.M.linkInput('박', { isComposing: false });
  await sleep(300);
  assert.strictEqual(B.searches().length, n0, '한 글자는 서버에 묻지 않는다');
  assert.match(B.listEl.innerHTML, /두 글자 이상/);
  B.fire('compositionstart', { id: 'moRlQ', value: '박' });
  for (const v of ['박ㅈ', '박지', '박지ㅇ', '박지영']) B.M.linkInput(v, { isComposing: true });
  await sleep(300);
  assert.strictEqual(B.searches().length, n0, '조합 중에는 묻지 않는다');
  B.fire('compositionend', { id: 'moRlQ', value: '박지영' });
  await sleep(300);
  const last = B.searches().slice(-1)[0];
  assert.ok(last && last.p.endsWith(encodeURIComponent('박지영')), '조합이 끝난 글로 검색: ' + (last && last.p));
});

test('④ 고르기·새로 등록 → 칸 표시 + 제출 본문 reviewerLink', async () => {
  const B = boot(server());
  await twoRows(B);
  const [u0, u1] = uids(B.html());
  B.M.openLink(0); await sleep(20);
  B.M.linkPick(0);
  assert.strictEqual(B.pop(), undefined, '고르면 닫힌다');
  assert.strictEqual(cellText(B.html(), u0), '기존: 김수만(…6325)');
  B.M.openLink(1); await sleep(20);
  B.M.linkSet('new');
  assert.strictEqual(cellText(B.html(), u1), '새로 등록');
  await B.M.submit();
  const body = B.submits()[0].body;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(body.items.map(x => x.reviewerLink))),
    [{ mode: 'existing', reviewerId: UA }, { mode: 'new', reviewerId: '' }]);
  assert.match(B.html(), /기존 리뷰어 ‘김수만’에 연결/, '결과에 연결 방식이 보인다');
  // [자동] 으로 되돌리면 auto
  const C = boot(server());
  await twoRows(C);
  C.M.openLink(0); await sleep(20); C.M.linkPick(0);
  C.M.openLink(0); await sleep(20); C.M.linkSet('auto');
  await C.M.submit();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(C.submits()[0].body.items.map(x => x.reviewerLink.mode))), ['auto', 'auto']);
});

test('⑤ 팝오버가 열린 채 표가 다시 그려져도 팝오버 요소는 그대로', async () => {
  const B = boot(server());
  await twoRows(B);
  B.M.openLink(0); await sleep(20);
  const pop = B.pop();
  const r0 = B.renders();
  B.M.pasteLines(2, ['이새줄/이새줄/lee/010-3333-4444/부산 1/우리은행/330-1/이새줄/15800']);
  await B.M.flush();
  assert.ok(B.renders() > r0, '표는 다시 그려졌다');
  assert.strictEqual(B.pop(), pop, '같은 팝오버 요소가 남아 있다(검색칸 포커스·조합 보호)');
});

test('⑥ 고른 뒤 그 줄 연락처가 바뀌면 「자동」으로 되돌리고 알린다', async () => {
  const B = boot(server());
  await twoRows(B);
  const [u0] = uids(B.html());
  B.M.openLink(0); await sleep(20); B.M.linkPick(0);
  B.M.edit(0, 'phone', '010-5555-0000');
  B.M.close(); // 표를 다시 그리지 않는 경로라 상태로 확인한다
  const D = boot(server());
  await twoRows(D);
  D.M.openLink(0); await sleep(20); D.M.linkPick(0);
  D.M.rowInput(0, LINE.KIM.replace('010-1234-6325', '010-7777-0000'), { isComposing: false });
  await D.M.flush();
  assert.strictEqual(cellText(D.html(), uids(D.html())[0]), '자동', '다시 나눈 연락처가 다르면 자동으로');
  assert.ok(D.toasts.some(t => /리뷰어 연결을 「자동」으로 되돌렸습니다/.test(t)));
  assert.ok(B.toasts.some(t => /리뷰어 연결을 「자동」으로 되돌렸습니다/.test(t)), '칸을 직접 고쳐도 같은 안내');
  void u0;
});

test('⑦ 배포 스큐 — 옛 서버가 연결 방식을 돌려주지 않으면 결과에 경고', async () => {
  const B = boot(server({ oldServer: true }));
  await twoRows(B);
  B.M.openLink(0); await sleep(20); B.M.linkPick(0);
  await B.M.submit();
  assert.match(B.html(), /리뷰어 연결\(기존 고르기\)이 서버에 반영되지 않아 자동으로 처리됐습니다/);
  assert.strictEqual((B.html().match(/서버에 반영되지 않아/g) || []).length, 1, '자동으로 둔 줄에는 경고 없음');
});
