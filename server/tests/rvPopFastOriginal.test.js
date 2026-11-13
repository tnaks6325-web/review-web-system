'use strict';
/**
 * 작업보드 「제출물 크게 보기」 팝업 — 사람을 넘길 때 원본 사진이 1~3초 늦게 뜨던 문제(결정 354 보강 · 결정 008 원본 유지).
 *
 *   원인: 팝업 사진은 원본 자리(`_fullAttrs` → drive-thumb `fullAttrs`)라 o(원본 바이트 그대로) 서명이 없으면
 *         느린 원본 프록시로 그리고, 서명은 "다음 번을 위해" 그 사람 것만 물었다. 서명이 도착해도 swapIn 은
 *         작은 사진(data-dt="g")만 갈아 끼워 팝업 사진은 계속 프록시에 남았다. 다음 사람 미리 받기도 없었다.
 *
 *   A) 팝업을 열면 목록 전원의 구매·리뷰(현영 표시 시 영수증) o 서명을 **한 묶음**으로 묻는다(SIGN_CHUNK 그대로)
 *   B) 서명이 늦게 와도 이미 그려진 팝업 원본 사진을 o 로 갈아 끼운다 · o 실패 → 원본 프록시 1회(fullFall)
 *   C) 원본 자리에는 t·m(변환본)이 **절대** 나오지 않는다(결정 008 완화 금지)
 *   D) 앞·뒤 사람의 지금 장 원본을 기존 prefetch 로 미리 받는다(상한 그대로)
 *   E) 업체(광고주) 화면·무인증(seed 전용) 화면은 종전과 같다
 *
 * 실제 frontend/js/drive-thumb.js 와 frontend/workdesk.html 의 함수 본문을 vm 으로 떼어 가짜 fetch/document 로 실행한다.
 * 실행: node --test tests/rvPopFastOriginal.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DT = R('frontend/js/drive-thumb.js');
const WD = R('frontend/workdesk.html');

const id = (s) => (s + '_'.repeat(28)).slice(0, 28);
const EXP = () => Math.floor(Date.now() / 1000) + 12 * 3600;
const SIG = 'A'.repeat(43);
const PROXY = (x) => `https://api.example.com/api/drive/image/${x}`;
const signed = (k, x) => `/img/${k}/${x}?e=${EXP()}&s=${SIG}`;

/** workdesk.html 에서 이름으로 최상위 선언 한 개를 떼어 낸다(다음 최상위 선언 직전까지). */
function pick(name) {
  const re = new RegExp('\\n(?:function ' + name + '\\(|const ' + name + '=)');
  const m = re.exec(WD);
  assert.ok(m, name + ' 를 workdesk.html 에서 찾았다');
  const from = m.index + 1;
  const rest = WD.slice(from + 1);
  const nx = /\n(?:function |const |let |var |\/\*|<\/script>)/.exec(rest);
  return WD.slice(from, from + 1 + (nx ? nx.index : rest.length));
}

function parseImgs(html) {
  const out = [];
  html.replace(/<img((?:\s+[\w-]+="[^"]*")*)\s*>/g, (_, attrs) => {
    const a = {};
    attrs.replace(/([\w-]+)="([^"]*)"/g, (__, k, v) => { a[k] = v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); });
    out.push({ a, complete: false, naturalWidth: 0, dataset: {},
      getAttribute(k) { return k in this.a ? this.a[k] : null; }, setAttribute(k, v) { this.a[k] = String(v); },
      removeAttribute(k) { delete this.a[k]; }, get src() { return this.a.src; }, set src(v) { this.a.src = String(v); } });
  });
  return out;
}

function setup({ token = 'tok', role = 'staff', people, showReceipt = false, reply } = {}) {
  const mem = token ? { admin_token: token } : {};
  const fetches = [], timers = [], images = [];
  let imgs = [];
  const ov = { id: 'rvpop', set innerHTML(h) { this._h = h; imgs = parseImgs(h); }, get innerHTML() { return this._h; }, remove() {} };
  let attached = false;
  const document = {
    getElementById: (k) => (k === 'rvpop' && attached ? ov : null),
    createElement: () => ov,
    body: { appendChild: () => { attached = true; } },
    addEventListener: () => {},
    querySelectorAll: (sel) => {
      const m = /^img\[data-dt="(\w)"\]\[data-dt-id\]$/.exec(sel);
      if (!m) return [];
      return imgs.filter(im => im.getAttribute('data-dt') === m[1] && im.getAttribute('data-dt-id'));
    },
  };
  const defReply = (b) => {
    const mk = (k) => Object.fromEntries(b.ids.map(x => [x, signed(k, x)]));
    const j = { ok: true, enabled: true, urls: mk(b.kind) };
    if (b.extra) j.more = { o: mk('o') };
    return j;
  };
  const sb = {
    console, Date, JSON, Math, Object, String, Number, Promise, RegExp, Array, Boolean,
    setTimeout: (f) => { timers.push(f); return 1; },
    sessionStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } },
    fetch: (u, init) => { const b = JSON.parse(init.body); fetches.push({ u, body: b });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve((reply || defReply)(b)) }); },
    document,
    Image: function () { const im = { set src(v) { this._src = v; images.push(this); }, get src() { return this._src; } }; return im; },
    API_BASE_URL: 'https://api.example.com',
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(DT, sb);
  const names = ['esc', '_rvNo', '_rvWho', '_rvReceiptApplies', '_rvReceiptSubmitted', '_rvKindFiles', '_fullAttrs'];
  const popFrom = WD.indexOf('\nfunction _rvPopIdx(');
  const popTo = WD.indexOf('\n/* ── 시안 B');
  assert.ok(popFrom > 0 && popTo > popFrom, '팝업 함수 묶음을 찾았다');
  const src = names.map(pick).join('\n') + '\n' + WD.slice(popFrom, popTo);
  vm.runInContext('var STATE = { role: ' + JSON.stringify(role) + ' };\n' +
    'function _rvPeople(){ return STATE.__people; }\nfunction _rvReceiptActive(){ return STATE.__showReceipt; }\n' + src, sb);
  vm.runInContext('STATE', sb).__people = people;
  vm.runInContext('STATE', sb).__showReceipt = showReceipt;
  const tick = async () => { for (let n = 0; n < 4; n++) { while (timers.length) timers.shift()(); for (let i = 0; i < 8; i++) await Promise.resolve(); } };
  return { sb, T: sb.DriveThumb, fetches, tick, images, imgs: () => imgs, run: (c) => vm.runInContext(c, sb) };
}

function mkPeople(n, { receipt = false } = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const files = [
      { slot: 'order_capture', fileId: id('CAP' + i) },
      { slot: 'review', fileId: id('REV' + i) },
    ];
    if (receipt && i === 1) files.push({ slot: 'receipt', fileId: id('RCP' + i) });
    files.forEach(f => { f.url = PROXY(f.fileId); });
    out.push({ r: { id: 'r' + i, seq: i, boardNo: i, rowJson: { '수취인': '사람' + i } }, files });
  }
  return out;
}
const allIds = (people, withReceipt) => people.flatMap(p => p.files.filter(f => withReceipt || f.slot !== 'receipt').map(f => f.fileId));
const oAsked = (fetches) => fetches.flatMap(f => (f.body.kind === 'o' || (f.body.extra || []).includes('o')) ? f.body.ids : []);
const NO_TM = (s) => !/\/img\/[tm]\//.test(s);

test('A1) 팝업을 열면 목록 전원의 원본(o) 서명을 한 묶음으로 묻는다(현영 표시 시 영수증 포함)', async () => {
  const people = mkPeople(5, { receipt: true });
  const env = setup({ people, showReceipt: true });
  env.run("_rvOpen('r1', 0)");
  await env.tick();
  assert.equal(env.fetches.length, 1, '요청 1번(묶음)');
  assert.equal(env.fetches[0].body.kind, 'o');
  assert.deepEqual([...oAsked(env.fetches)].sort(), allIds(people, true).sort(), '목록 전원 · 구매·리뷰·영수증');
});

test('A2) 현영을 안 보이는 화면은 영수증 번호를 묻지 않는다', async () => {
  const people = mkPeople(3, { receipt: true });
  const env = setup({ people, showReceipt: false });
  env.run("_rvOpen('r2', 0)");
  await env.tick();
  assert.deepEqual([...oAsked(env.fetches)].sort(), allIds(people, false).sort());
});

test('A3) 큰 목록은 기존 SIGN_CHUNK(200) 그대로 나눠 묻는다', async () => {
  const people = mkPeople(230);   // 460장
  const env = setup({ people });
  env.run("_rvOpen('r1', 0)");
  await env.tick();
  assert.deepEqual(env.fetches.map(f => f.body.ids.length), [200, 200, 60]);
  assert.equal(new Set(oAsked(env.fetches)).size, 460, '중복 없이 전원');
});

test('B1) 서명이 늦게 와도 이미 그려진 팝업 사진을 o 로 갈아 끼운다 · o 실패 → 원본 프록시 1회', async () => {
  const people = mkPeople(3);
  const env = setup({ people });
  env.run("_rvOpen('r1', 0)");
  let imgs = env.imgs();
  assert.equal(imgs.length, 2);
  assert.deepEqual(imgs.map(i => i.src), [PROXY(id('CAP1')), PROXY(id('REV1'))], '서명 전 = 종전 원본 프록시 그대로');
  await env.tick();
  imgs = env.imgs();
  assert.ok(imgs[0].src.startsWith('/img/o/' + id('CAP1') + '?'), imgs[0].src);
  assert.ok(imgs[1].src.startsWith('/img/o/' + id('REV1') + '?'), imgs[1].src);
  assert.equal(imgs[0].getAttribute('data-full'), PROXY(id('CAP1')), '실패 시 돌아갈 원본 프록시');
  assert.equal(env.T.fullFall(imgs[0]), true);
  assert.equal(imgs[0].src, PROXY(id('CAP1')), 'o 실패 → 프록시 1회');
  assert.equal(env.T.fullFall(imgs[0]), false, '한 번만');
});

test('B2) 다 뜬 프록시 사진은 건드리지 않는다', async () => {
  const env = setup({ people: mkPeople(2) });
  env.run("_rvOpen('r1', 0)");
  const imgs = env.imgs();
  imgs[0].complete = true; imgs[0].naturalWidth = 800;
  await env.tick();
  assert.equal(imgs[0].src, PROXY(id('CAP1')));
  assert.match(imgs[1].src, /^\/img\/o\//);
});

test('C1) 원본 자리에는 t·m 이 절대 안 나온다 — t·m 서명이 모두 있어도 · 사람을 넘겨도', async () => {
  const people = mkPeople(4);
  const env = setup({ people });
  env.T.seed(allIds(people).flatMap(x => [signed('t', x), signed('m', x)]));
  env.run("_rvOpen('r1', 0)");
  const seen = [];
  const grab = () => env.imgs().forEach(im => seen.push(JSON.stringify(im.a)));
  grab();
  await env.tick(); grab();
  for (let i = 0; i < 5; i++) { env.run('_rvPopStep(1)'); grab(); await env.tick(); grab(); }
  assert.ok(seen.length >= 20);
  seen.forEach(s => assert.ok(NO_TM(s), '변환본 주소 0: ' + s));
  env.images.forEach(im => assert.ok(NO_TM(im.src), '미리 받기도 원본만'));
});

test('D1) 앞·뒤 사람의 지금 장 원본을 미리 받는다 → 넘기면 바로 o', async () => {
  const people = mkPeople(4);
  const env = setup({ people });
  env.run("_rvOpen('r2', 0)");
  await env.tick();
  const pre = env.images.map(im => im.src);
  assert.ok(pre.some(u => u.includes(id('CAP3'))) || pre.some(u => u.includes(id('REV3'))), '다음 사람(3번) 원본 미리 받기: ' + pre.join(','));
  pre.forEach(u => assert.match(u, /^\/img\/o\//));
  env.run('_rvPopStep(1)');
  env.imgs().forEach(im => assert.match(im.src, /^\/img\/o\//, '넘긴 사람 사진이 처음부터 빠른 길'));
});

test('D2) 미리 받기 상한은 기존 그대로(동시 2장)', async () => {
  const env = setup({ people: mkPeople(6, { receipt: true }), showReceipt: true });
  env.run("_rvOpen('r3', 0)");
  await env.tick();
  assert.ok(env.images.length <= 2, '동시 2장(PRE_MAX) — 지금 ' + env.images.length);
});

test('E1) 업체(광고주) 화면 — 목록 전원 서명·미리 받기를 하지 않는다(종전과 같은 요청)', async () => {
  const people = mkPeople(4);
  const env = setup({ people, role: 'advertiser' });
  env.run("_rvOpen('r1', 0)");
  await env.tick();
  assert.deepEqual([...oAsked(env.fetches)].sort(), [id('CAP1'), id('REV1')].sort(), '보이는 그 사람 것만(종전 그대로)');
  assert.equal(env.images.length, 0, '미리 받기 0');
});

test('E2) 무인증(seed 전용) 화면 — 요청 0 · 원본 자리 태그는 종전과 글자 하나 다르지 않다', async () => {
  const env = setup({ token: '', people: mkPeople(3) });
  env.run("_rvOpen('r1', 0)");
  await env.tick();
  assert.equal(env.fetches.length, 0);
  assert.equal(env.T.fullAttrs(id('CAP1'), PROXY(id('CAP1'))), ` src="${PROXY(id('CAP1'))}"`);
  assert.match(env.run('document.getElementById("rvpop").innerHTML'), /<img src="https:\/\/api\.example\.com\/api\/drive\/image\/CAP1_+" alt=/);
});

test('E3) drive-thumb 공개 함수 wantFull — 형식 불량·이미 있는 번호는 묻지 않는다', async () => {
  const env = setup({ people: mkPeople(1) });
  assert.equal(typeof env.T.wantFull, 'function');
  env.T.seed([signed('o', id('HAS'))]);
  env.T.wantFull([id('HAS'), 'bad', id('NEW'), id('NEW')]);
  await env.tick();
  assert.deepEqual(oAsked(env.fetches), [id('NEW')]);
});
