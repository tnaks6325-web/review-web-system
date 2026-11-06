'use strict';
/**
 * manualOrderFlowFixes.test.js — 결정 345 회귀가드 (외부모집 수동제출 흐름 버그 묶음)
 * 실행: node --test tests/manualOrderFlowFixes.test.js   (DB·서버·브라우저 불필요)
 *
 * 실제 frontend/js/manual-order.js 를 vm 에 통째로 올리고, 아주 작은 가짜 DOM·fetch 로
 * 붙여넣기 → [다음] → 제출 → [계속 입력]/[← 다시 붙여넣기] 흐름을 실제로 돌린다.
 * (문자열 grep 만으로는 "보관함이 안 비워짐·판독 전 배정" 같은 실행 순서 버그를 못 본다.)
 */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MO_PATH = path.join(__dirname, '..', '..', 'frontend', 'js', 'manual-order.js');
const MO = fs.readFileSync(MO_PATH, 'utf8');

const unesc = s => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 가짜 브라우저 하나 — server(p, body) 가 API 응답을 만든다. */
function boot(server, extraWin) {
  const calls = [];
  const els = new Map();
  let ovl = null;
  const stub = id => { if (!els.has(id)) els.set(id, { id, innerHTML: '', value: '', disabled: false, textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, focus() {} }); return els.get(id); };
  const textEl = { focus() {}, _v: null, _html: null };
  Object.defineProperty(textEl, 'value', {
    get() {
      if (textEl._v != null && textEl._html === (ovl && ovl.innerHTML)) return textEl._v;
      const m = ovl && /<textarea[^>]*id="moText"[^>]*>([\s\S]*?)<\/textarea>/.exec(ovl.innerHTML);
      return m ? unesc(m[1]) : '';
    },
    set(v) { textEl._v = v; textEl._html = ovl && ovl.innerHTML; },
  });
  const document = {
    head: { appendChild() {} },
    body: { appendChild(el) { ovl = el; } },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, remove() { ovl = null; }, innerHTML: '', set className(_) {}, get offsetParent() { return null; } }; },
    getElementById(id) {
      if (id === 'mo-style') return {};
      if (id === 'moOvl') return ovl;
      if (!ovl) return null;
      if (id === 'moText') return ovl.innerHTML.includes('id="moText"') ? textEl : null;
      if (id === 'moStage') return ovl.innerHTML.includes('id="moStage"') ? stub('moStage') : null;
      if (id === 'moSubmit') return ovl.innerHTML.includes('id="moSubmit"') ? stub('moSubmit') : null;
      if (id === 'moNext') return ovl.innerHTML.includes('id="moNext"') ? stub('moNext') : null;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const dialogs = [];
  const win = Object.assign({
    document, console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, Error,
    sessionStorage: { getItem: () => 'tok' }, localStorage: { getItem: () => '' },
    location: { hostname: 'x' }, API_BASE_URL: 'http://api',
    alert: m => dialogs.push('alert:' + m),
    confirm: m => { dialogs.push('confirm:' + m); return true; },
    FileReader: class { readAsDataURL(f) { setTimeout(() => { if (f.bad) { this.onerror && this.onerror(); return; } this.result = 'data:image/jpeg;base64,' + f.b64; this.onload(); }, f.delay || 0); } },
    fetch: async (url, o) => {
      const p = String(url).replace('http://api', '');
      const body = o && o.body ? JSON.parse(o.body) : {};
      calls.push({ p, body, at: calls.length });
      const r = await server(p, body);
      return { json: async () => r };
    },
  }, extraWin || {});
  win.window = win;
  vm.createContext(win);
  vm.runInContext(MO, win);
  const M = win.ManualOrder;
  return {
    M, win, calls, dialogs,
    html: () => (ovl ? ovl.innerHTML : ''),
    stageHtml: () => stub('moStage').innerHTML,
    setText: v => { textEl.value = v; },
    stage: (...files) => M.onStageFiles({ target: { files: files.map(f => Object.assign({ type: 'image/jpeg', size: 10 }, f)), value: '' } }),
    uploads: () => calls.filter(c => c.p === '/api/image/image-upload').map(c => ({ order: c.body.orderSubmissionId, img: c.body.imageBase64 })),
  };
}

const LINE = {
  KIM: '김민수/김민수/kim01/010-1111-1111/서울시 마포구 1/신한은행/110-111/김민수/15800',
  PARK: '박지영/박지영/park02/010-2222-2222/서울시 강남구 2/국민은행/220-222/박지영/15800',
};
const F = {
  KIM: { reviewerName: '김민수', recipient: '김민수', userId: 'kim01', phone: '010-1111-1111', address: '서울시 마포구 1', bank: '신한은행', account: '110-111', depositor: '김민수', price: 15800 },
  PARK: { reviewerName: '박지영', recipient: '박지영', userId: 'park02', phone: '010-2222-2222', address: '서울시 강남구 2', bank: '국민은행', account: '220-222', depositor: '박지영', price: 15800 },
};
/** 줄 → 미리보기 항목(간이 파서 — 실제 파서는 다른 작업자 담당이라 여기선 고정 표본만) */
function previewOf(text) {
  return String(text).split('\n').filter(s => s.trim()).map(l => {
    if (l === LINE.KIM) return { ok: true, fields: Object.assign({}, F.KIM), errors: [], warnings: [] };
    if (l === LINE.PARK) return { ok: true, fields: Object.assign({}, F.PARK), errors: [], warnings: [] };
    return { ok: false, fields: { recipient: l.split('/')[1] || '', phone: l.split('/')[3] || '' }, errors: ['칸이 부족합니다'], warnings: [] };
  });
}
/** 기본 가짜 서버: extract 는 base64 → 판독 결과 표, submit 은 전부 성공 */
function fakeServer(opt) {
  const o = Object.assign({ extract: {}, extractDelay: 0, submit: null }, opt || {});
  let seq = 0;
  return async (p, body) => {
    if (p === '/api/manual-order/preview') return { ok: true, items: previewOf(body.text), optionChoices: [] };
    if (p === '/api/image/image-extract') {
      if (o.extractDelay) await sleep(o.extractDelay);
      const e = o.extract[body.imageBase64];
      return e ? Object.assign({ ok: true, orderNumber: '' }, e) : { ok: false };
    }
    if (p === '/api/manual-order/submit') {
      if (o.submit) return o.submit(body);
      const results = body.items.map((it, i) => ({ index: i, ok: true, name: it.fields.recipient, orderSubmissionId: 'os-' + (++seq) + '-' + it.fields.recipient, captureSession: { id: 'c', token: 't' }, queued: true }));
      return { ok: true, okCount: results.length, failCount: 0, results };
    }
    if (p === '/api/image/image-upload') return { ok: true };
    return { ok: true, data: [] };
  };
}
const open = (B, ctx) => B.M.open(Object.assign({ sheetId: 's1', tabName: 'T', gid: '0', campaignId: null, title: 't' }, ctx || {}));
const settle = () => sleep(30);

/* ── ① 제출 성공 뒤 [계속 입력]: 앞 사람 캡처가 다음 사람에게 또 붙지 않는다 ── */
test('① 제출 성공 뒤 [계속 입력]에서 보관함이 비고, 다음 사람 주문에 앞 사람 캡처가 올라가지 않는다', async () => {
  const B = boot(fakeServer({ extract: { A: { recipient: '김민수', phone: '010-1111-1111' } } }));
  open(B);
  B.stage({ b64: 'A' }); await settle();
  B.setText(LINE.KIM); await B.M.parse(); await B.M.submit();
  B.M.again(); await settle();
  assert.ok(!/<img/.test(B.stageHtml()), '보관함 칩이 남아 있으면 안 된다');
  B.setText(LINE.PARK); await B.M.parse(); await B.M.submit();
  const ups = B.uploads();
  assert.deepStrictEqual(ups.map(u => u.order.replace(/^os-\d+-/, '') + ':' + u.img), ['김민수:A']);
});

/* ── ② 판독이 끝나기 전 [다음]: 끝날 때까지 기다렸다가 이름으로 배정 ── */
test('② 판독(이름 읽기) 중에 [다음]을 눌러도 이름으로 맞는 줄에 붙는다', async () => {
  const B = boot(fakeServer({ extractDelay: 150, extract: { B: { recipient: '박지영', phone: '010-2222-2222' }, A: { recipient: '김민수', phone: '010-1111-1111' } } }));
  open(B);
  B.stage({ b64: 'B' }, { b64: 'A' }); await sleep(5);
  B.setText(LINE.KIM + '\n' + LINE.PARK);
  await B.M.parse();
  await B.M.submit();
  const ups = B.uploads().map(u => u.order.replace(/^os-\d+-/, '') + ':' + u.img).sort();
  assert.deepStrictEqual(ups, ['김민수:A', '박지영:B']);
  assert.ok(!B.html().includes('순서로 붙음'), '이름으로 붙었으면 순서 표시가 없어야 한다');
});

test('② 사진 줄이기(축소)가 끝나기 전 [다음]도 기다렸다가 배정한다', async () => {
  const B = boot(fakeServer({ extract: { A: { recipient: '김민수', phone: '' } } }));
  open(B);
  B.stage({ b64: 'A', delay: 120 }); await sleep(5);
  B.setText(LINE.KIM); await B.M.parse();
  await B.M.submit();
  assert.deepStrictEqual(B.uploads().map(u => u.img), ['A']);
});

/* ── ③ 나누기 실패 줄은 캡처를 먹지 않는다 ── */
test('③ 오류 줄(나누기 실패)은 순서 배정 대상에서 빠진다', async () => {
  const B = boot(fakeServer());
  open(B);
  B.stage({ b64: 'A' }, { b64: 'B' }); await settle();
  B.setText(LINE.KIM + '\n김철수/김철수/x/010-3333-3333/주소만\n' + LINE.PARK);
  await B.M.parse();
  await B.M.submit();
  const ups = B.uploads().map(u => u.order.replace(/^os-\d+-/, '') + ':' + u.img).sort();
  assert.deepStrictEqual(ups, ['김민수:A', '박지영:B']);
});

/* ── ④ 배정 규칙(실제 distributeStaged 실행) ── */
function distributor() {
  const src = MO.slice(MO.indexOf('function distributeStaged('));
  let d = 0, k = src.indexOf('{');
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
  const ctx = { ROWS: [], STAGED: [] };
  vm.createContext(ctx);
  vm.runInContext('var ROWS=[],STAGED=[];' + src.slice(0, k + 1) + ';this.run=(r,s)=>{ROWS=r;STAGED=s;const out=distributeStaged();return out;};', ctx);
  return (rows, caps) => {
    const R = rows.map(([recipient, phone, ok]) => ({ ok: ok !== false, fields: { recipient, phone }, capture: null, extract: null }));
    const S = caps.map(([id, recipient, phone]) => ({ id, base64: 'IMG_' + id, mime: 'i', busy: false, extract: recipient == null && phone == null ? null : { ok: true, recipient, phone } }));
    const out = ctx.run(R, S);
    return { got: R.map(r => (r.capture ? r.capture.base64.slice(4) : '-') + (r.captureByOrder ? '(순서)' : '')), out: out || {} };
  };
}
test('④ 동명이인은 연락처로만 · 연락처로도 못 가리면 순서로 보내지 않는다', () => {
  const run = distributor();
  assert.deepStrictEqual(run([['김민수', '010-1111-1111'], ['김민수', '010-2222-2222']], [['b', '김민수', '010-2222-2222'], ['a', '김민수', '010-1111-1111']]).got, ['a', 'b']);
  const r = run([['김민수', '010-1111-1111'], ['김민수', '010-2222-2222']], [['x', '김민수', '']]);
  assert.deepStrictEqual(r.got, ['-', '-']);
  assert.strictEqual(r.out.unassigned, 1);
});
test('④ 이름이 맞아도 전화 끝4자리가 분명히 다르면 이름 매칭을 버린다(안심번호 050x 는 판단 안 함)', () => {
  const run = distributor();
  assert.deepStrictEqual(run([['김민수', '010-1111-1111'], ['박지영', '010-2222-2222']], [['b', '김민수', '010-2222-2222']]).got, ['-', 'b']);
  assert.deepStrictEqual(run([['김민수', '010-1111-1111'], ['박지영', '010-2222-2222']], [['b', '박*영', '0504-1234-9876'], ['a', '김*수', '0504-5678-4321']]).got, ['a', 'b']);
});
test('④ 마스킹 이름(김*수)은 글자 패턴으로 — 후보가 하나일 때만', () => {
  const run = distributor();
  assert.deepStrictEqual(run([['김민수', '010-1111-5555'], ['박지영', '010-2222-5555']], [['b', '박*영', '010-2222-5555'], ['a', '김*수', '010-1111-5555']]).got, ['a', 'b']);
  assert.deepStrictEqual(run([['김민수', '010-1111-1111'], ['박지영', '010-2222-2222']], [['b', '박*영', ''], ['a', '김*수', '']]).got, ['a', 'b']);
  const amb = run([['김민수', '010-1111-1111'], ['김영수', '010-2222-2222']], [['x', '김*수', '']]);
  assert.deepStrictEqual(amb.got, ['-', '-']);
  assert.strictEqual(amb.out.unassigned, 1);
});
test('④ 이름이 없을 때 전화 끝4자리는 정확히 한 줄일 때만', () => {
  const run = distributor();
  const r = run([['김민수', '010-1111-5555'], ['박지영', '010-2222-5555']], [['x', '', '010-9999-5555']]);
  assert.deepStrictEqual(r.got, ['-', '-']);
  assert.strictEqual(r.out.unassigned, 1);
  assert.deepStrictEqual(run([['김민수', '010-1111-1111'], ['박지영', '010-2222-2222']], [['x', '', '010-9999-2222']]).got, ['-', 'x']);
});
test('④ 한 사람에 2장 이상 맞으면 첫 장만 — 나머지는 남기고 다른 사람 줄로 보내지 않는다', () => {
  const run = distributor();
  const r = run([['김민수', '010-1111-1111'], ['최유리', '010-3333-3333']], [['a', '김민수', '010-1111-1111'], ['a2', '김민수', '']]);
  assert.deepStrictEqual(r.got, ['a', '-']);
  assert.strictEqual(r.out.unassigned, 1);
});
test('④ 순서로 붙은 줄은 표시가 남고, 이름 못 읽은 캡처가 이름이 틀린 캡처보다 먼저 순서 배정된다', () => {
  const run = distributor();
  assert.deepStrictEqual(run([['박지영', '010-2222-2222'], ['김민수', '010-1111-1111']], [['a', '김민서', ''], ['b', null, null]]).got, ['b(순서)', 'a(순서)']);
  assert.deepStrictEqual(run([['김민수', '010-1111-1111'], ['박지영', '010-2222-2222'], ['최유리', '010-3333-3333']], [['c', null, null]]).got, ['c(순서)', '-', '-']);
});
test('④ 화면: 순서로 붙은 줄에 "순서로 붙음 — 확인", 남은 캡처는 "배정 안 된 캡처 N장"', async () => {
  const B = boot(fakeServer({ extract: { A: { recipient: '김민수', phone: '010-1111-1111' }, A2: { recipient: '김민수', phone: '' } } }));
  open(B);
  B.stage({ b64: 'A' }, { b64: 'A2' }, { b64: 'Z' }); await settle();
  B.setText(LINE.KIM + '\n' + LINE.PARK); await B.M.parse();
  const h = B.html();
  assert.ok(h.includes('순서로 붙음 — 확인'), 'Z 는 박지영 줄에 순서로 붙고 표시가 있어야 한다');
  assert.ok(h.includes('배정 안 된 캡처 1장'), 'A2(김민수 두 번째 장)는 남는다');
});

/* ── ⑤ 보관함 칩은 순서 번호가 아니라 고유 id 로 ── */
test('⑤ 앞 캡처를 빼는 사이 뒤 캡처의 축소가 끝나도 서로 자리가 바뀌지 않는다', async () => {
  const B = boot(fakeServer());
  open(B);
  B.stage({ b64: 'X', delay: 5 }, { b64: 'Y', delay: 60 }, { b64: 'Z', delay: 90 });
  await sleep(30);
  const firstId = /ManualOrder\.unstage\(([^)]+)\)/.exec(B.stageHtml())[1];
  B.M.unstage(Number(firstId) || firstId.replace(/['"]/g, ''));
  await sleep(150);
  const imgs = [...B.stageHtml().matchAll(/base64,([A-Z]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(imgs, ['Y', 'Z']);
  assert.ok(!B.stageHtml().includes('⏳'), '멈춘 칩이 없어야 한다');
});
test('⑤ 첫 캡처를 못 읽어 빠져도 뒤 캡처가 사라지지 않는다', async () => {
  const B = boot(fakeServer());
  open(B);
  B.stage({ b64: 'X', bad: true, delay: 5 }, { b64: 'Y', delay: 20 }, { b64: 'Z', delay: 40 });
  await sleep(100);
  const imgs = [...B.stageHtml().matchAll(/base64,([A-Z]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(imgs, ['Y', 'Z']);
});

/* ── ⑥ [← 다시 붙여넣기]: 글과 줄별 캡처 유지 ── */
test('⑥ [← 다시 붙여넣기] 뒤에도 붙여넣은 글이 남고, 2단계 줄별 캡처는 보관함으로 돌아온다', async () => {
  const B = boot(fakeServer());
  open(B);
  B.setText(LINE.KIM + '\n' + LINE.PARK); await B.M.parse();
  B.M.onFile({ target: { files: [{ type: 'image/jpeg', size: 10, b64: 'R' }] } }, 0); await settle();
  B.M.back(); await settle();
  assert.strictEqual(B.win.document.getElementById('moText').value, LINE.KIM + '\n' + LINE.PARK);
  assert.ok(/base64,R"/.test(B.stageHtml()), '줄별 캡처가 보관함에 있어야 한다');
  await B.M.parse(); await B.M.submit();
  assert.deepStrictEqual(B.uploads().map(u => u.img), ['R']);
});

/* ── ⑦ 결과 문구: 작업표에 바로 적힌 경우 ── */
test('⑦ 서버가 작업표 줄 번호를 돌려주면 "작업표 N번 줄에 기록됨" — "자동복구 대기"로 잘못 말하지 않는다', async () => {
  const B = boot(fakeServer({ submit: body => ({ ok: true, okCount: 1, failCount: 0, results: [{ index: 0, ok: true, name: '김민수', orderSubmissionId: 'os1', captureSession: { id: 'c', token: 't' }, queued: false, worktableRow: 7 }] }) }));
  open(B);
  B.setText(LINE.KIM); await B.M.parse(); await B.M.submit();
  assert.ok(B.html().includes('작업표 7번 줄에 기록됨'));
  assert.ok(!B.html().includes('자동복구 대기'));
});
test('⑦ 서버: 무시트 작업표 기록 결과를 응답 필드로 바꾸는 규칙', () => {
  const svc = require('../src/services/manualOrder.service');
  assert.strictEqual(typeof svc.worktableRowOf, 'function');
  assert.strictEqual(svc.worktableRowOf({ ok: true, written: true, seq: 12 }), 12);
  assert.strictEqual(svc.worktableRowOf({ ok: true, written: false, reason: 'duplicate_row', seq: 4 }), 4);
  assert.strictEqual(svc.worktableRowOf({ ok: false, reason: 'x' }), null);
  assert.strictEqual(svc.worktableRowOf(null), null);
  assert.strictEqual(svc.worktableRowOf({ ok: true, written: false, reason: 'deleted_or_canceled' }), null);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'manualOrder.service.js'), 'utf8');
  assert.match(src, /worktableRow: worktableRowOf\(sheetlessDone\)/);
});

/* ── ⑧ 작업보드 즉시 새로고침 ── */
test('⑧ 화면은 캡처 업로드를 기다리기 전에 작업보드 새로고침을 건다', async () => {
  let refreshedAt = -1;
  const B = boot(fakeServer());
  open(B, { onSubmitted: () => { if (refreshedAt < 0) refreshedAt = B.calls.length; } });
  B.stage({ b64: 'A' }); await settle();
  B.setText(LINE.KIM); await B.M.parse(); await B.M.submit();
  const firstUpload = B.calls.findIndex(c => c.p === '/api/image/image-upload');
  assert.ok(firstUpload >= 0 && refreshedAt >= 0 && refreshedAt <= firstUpload, `새로고침(${refreshedAt})이 업로드(${firstUpload})보다 먼저`);
});
test('⑧ 서버: 수동제출 성공 건도 리뷰어 제출과 같은 실시간 알림(emitOrderSubmit)을 보낸다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'manualOrder.routes.js'), 'utf8');
  assert.match(src, /const \{ emitOrderSubmit \} = require\('\.\.\/utils\/sse'\)/);
  const tail = src.slice(src.indexOf('const okCount = results.filter(r => r.ok).length;'));
  assert.match(tail.slice(0, 900), /if \(okCount > 0\)[\s\S]*emitOrderSubmit\(\{[\s\S]*sheetId[\s\S]*tabName/);
  assert.ok(tail.indexOf('emitOrderSubmit(') < tail.indexOf('res.json('), '응답 전에 알린다');
});

/* ── ⑨ 같은 연락처 두 줄: 중복 확인과 재참여 확인을 한 번에 ── */
test('⑨ 중복(24시간)·재참여 기간으로 걸린 줄은 한 번 확인받고 force+allowRepurchase 로 그 줄만 다시 보낸다', async () => {
  const posts = [];
  const B = boot(fakeServer({ submit: body => {
    posts.push({ force: body.force, allowRepurchase: body.allowRepurchase, n: body.items.length });
    if (!body.force) return { ok: true, okCount: 1, failCount: 2, results: [
      { index: 0, ok: true, name: '김민수', orderSubmissionId: 'os1', captureSession: { id: 'c', token: 't' } },
      { index: 1, ok: false, duplicate: true, name: '박지영', error: '24시간 내 이미 접수' },
      { index: 2, ok: false, repurchaseBlocked: true, name: '최유리', error: '최근 14일 안에 참여 — 확인 후 강제로 등록할 수 있습니다' }] };
    return { ok: true, okCount: body.items.length, failCount: 0, results: body.items.map((it, i) => ({ index: i, ok: true, name: it.fields.recipient, orderSubmissionId: 'f' + i, captureSession: { id: 'c', token: 't' } })) };
  } }));
  open(B);
  const CHOI = LINE.PARK.replace(/박지영/g, '최유리');
  B.win.__choi = CHOI;
  B.setText(LINE.KIM + '\n' + LINE.PARK + '\n' + CHOI);
  // 간이 파서가 최유리 줄을 오류로 보지 않게 미리보기 응답을 덮는다
  const orig = B.win.fetch;
  B.win.fetch = async (url, o) => {
    if (String(url).endsWith('/preview')) return { json: async () => ({ ok: true, items: [
      { ok: true, fields: Object.assign({}, F.KIM) }, { ok: true, fields: Object.assign({}, F.PARK) },
      { ok: true, fields: Object.assign({}, F.PARK, { reviewerName: '최유리', recipient: '최유리', depositor: '최유리' }) }] }) };
    return orig(url, o);
  };
  await B.M.parse(); await B.M.submit();
  assert.strictEqual(posts.length, 2);
  assert.deepStrictEqual(posts[1], { force: true, allowRepurchase: true, n: 2 });
  assert.strictEqual(B.dialogs.filter(d => d.startsWith('confirm:')).length, 2, '제출 확인 + 겹침 확인 한 번');
  assert.ok(!B.html().includes('실패'), '확인 뒤에는 모두 접수');
});

/* ── ⑩ 일부 접수 후 [계속 입력]: 실패한 줄만 다시 채운다 ── */
test('⑩ 일부만 접수된 뒤 [계속 입력]은 실패한 줄만 입력칸에 다시 채운다(성공 줄 이중 등록 방지)', async () => {
  const B = boot(fakeServer({ submit: body => ({ ok: true, okCount: 1, failCount: 1, results: [
    { index: 0, ok: true, name: '김민수', orderSubmissionId: 'os1', captureSession: { id: 'c', token: 't' } },
    { index: 1, ok: false, name: '박지영', error: '정원 반영 실패' }] }) }));
  open(B);
  B.setText(LINE.KIM + '\n' + LINE.PARK); await B.M.parse(); await B.M.submit();
  B.M.again(); await settle();
  const t = B.win.document.getElementById('moText').value;
  assert.ok(t.includes('박지영') && !t.includes('김민수'), '실패한 박지영 줄만: ' + t);
  assert.strictEqual(t.split('/').length, 9, '9칸 슬래시양식으로 다시 채운다');
});

/* ── ⑪ 신청 후보 조회 경로 재기준 ── */
test('⑪ 인트라넷 화면(CAMPAIGN_ADMIN_API=/api/trackb/campaigns)에서는 신청 후보도 그 경로로 조회한다', async () => {
  const B = boot(fakeServer(), { CAMPAIGN_ADMIN_API: '/api/trackb/campaigns' });
  open(B, { campaignId: 7 });
  B.setText(LINE.KIM); await B.M.parse();
  assert.ok(B.calls.some(c => c.p === '/api/trackb/campaigns/7/applications'), B.calls.map(c => c.p).join(','));
  const C = boot(fakeServer());
  open(C, { campaignId: 7 });
  C.setText(LINE.KIM); await C.M.parse();
  assert.ok(C.calls.some(c => c.p === '/api/campaign/admin/7/applications'), '전역 미설정 = 종전 경로');
});
test('⑪ Track B 신청 목록은 관리자 경로와 같은 핸들러(같은 응답 모양)에 위임한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
  assert.match(src, /router\.get\('\/campaigns\/:id\/applications', authMiddleware, internalMiddleware, \(req, res, next\) =>\s*_campHandlers\.apps\(req, res, next\)\)/);
  assert.match(src, /apps: _handler\(_campRoutes, '[A-Za-z]+'\)/);
});
