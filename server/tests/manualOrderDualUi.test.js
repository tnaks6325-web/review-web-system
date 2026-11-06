'use strict';
/**
 * manualOrderDualUi.test.js — 결정 349 화면(2026-11-07) 회귀가드: 외부모집 수동제출 창의 네이버·쿠팡 동시진행 모드 · 보완 목록
 * 실행: node --test tests/manualOrderDualUi.test.js   (DB·서버·브라우저 불필요)
 *
 * 실제 frontend/js/manual-order.js 를 vm 에 올리고 작은 가짜 DOM·fetch 로 흐름을 돌린다(manualOrderFlowFixes 와 같은 방식).
 *  - 창이 열릴 때 서버(…/dual/pending)가 동시진행이라고 하면 동시진행 모드 · 아니면(또는 옛 서버) 종전 화면 그대로
 *  - 캡처는 고른 줄 + 고른 구매처 칸에만(칸 없이 붙이면 안내만) · 두 주문번호·금액·캡처가 다 있어야 제출 대상
 *  - 제출은 줄마다 …/dual/submit(일반 …/submit 0회) · 보완은 …/dual/complete(기존 쪽은 사진 없이)
 */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MO = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'manual-order.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = '/api/trackb/manual-order';

function boot(server) {
  const calls = [];
  let ovl = null;
  let pasteListener = null;
  const els = new Map();
  const stub = id => { if (!els.has(id)) els.set(id, { id, innerHTML: '', value: '', disabled: false, textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, focus() {} }); return els.get(id); };
  const document = {
    head: { appendChild() {} },
    body: { appendChild(el) { ovl = el; } },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, remove() { ovl = null; }, innerHTML: '', set className(_) {}, get offsetParent() { return null; } }; },
    getElementById(id) {
      if (id === 'mo-style') return {};
      if (id === 'moOvl') return ovl;
      if (!ovl) return null;
      if (id === 'moSubmit' || id === 'moOptTip') return ovl.innerHTML.includes(`id="${id}"`) ? stub(id) : null;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { if (type === 'paste') pasteListener = fn; },
  };
  const dialogs = [], toasts = [];
  const win = {
    document, console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, Error,
    sessionStorage: { getItem: () => 'tok' }, localStorage: { getItem: () => '' },
    location: { hostname: 'x' }, API_BASE_URL: 'http://api', MANUAL_ORDER_API: BASE,
    alert: m => dialogs.push('alert:' + m), confirm: m => { dialogs.push('confirm:' + m); return true; }, toast: m => toasts.push(m),
    FileReader: class { readAsDataURL(f) { setTimeout(() => { this.result = 'data:image/jpeg;base64,' + f.b64; this.onload(); }, 0); } },
    fetch: async (url, o) => {
      const p = String(url).replace('http://api', '');
      const body = o && o.body ? JSON.parse(o.body) : {};
      calls.push({ p, body });
      return { json: async () => server(p, body) };
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(MO, win);
  const M = win.ManualOrder;
  const img = b64 => ({ type: 'image/jpeg', size: 10, b64 });
  const cd = file => ({ items: [{ type: file.type, getAsFile: () => file }] });
  return {
    M, calls, dialogs, toasts, img,
    html: () => (ovl ? ovl.innerHTML : ''),
    paste: async (i, text) => { const ev = { clipboardData: { items: [], getData: () => text }, preventDefault() { this.p = 1; }, target: {} }; M.rowPaste(ev, i); if (!ev.p) M.rowInput(i, text); await M.flush(); },
    capPaste: (i, ch, file) => M.onPaste({ clipboardData: cd(file), preventDefault() {} }, i, ch),
    drop: (i, ch, file) => { const ev = { preventDefault() {}, stopPropagation() { ev.stopped = true; }, currentTarget: null, dataTransfer: { files: [file] } }; M.onDrop(ev, i, ch); return ev; },
    docPaste: file => { const ev = { defaultPrevented: false, clipboardData: cd(file), preventDefault() { this.defaultPrevented = true; } }; pasteListener(ev); return ev; },
    of: p => calls.filter(c => c.p.split('?')[0] === BASE + p),
  };
}
const LINE = '김민수/김민수/kim01/010-1111-1111/서울시 마포구 1/신한은행/110-111/김민수/15800';
const F = { reviewerName: '김민수', recipient: '김민수', userId: 'kim01', phone: '010-1111-1111', address: '서울시 마포구 1', bank: '신한은행', account: '110-111', depositor: '김민수', price: 15800 };
const PEND = [{ orderSubmissionId: '00000000-0000-4000-8000-0000000000b3', name: '가나다', phoneTail: '5678', price: 10000, row: 3, hasCapture: true, hasOrderNum: true, paid: false },
  { orderSubmissionId: '00000000-0000-4000-8000-0000000000b4', name: '라마바', phoneTail: '9999', price: 12000, row: 7, hasCapture: true, hasOrderNum: false, paid: true }];
/** dual: true(동시진행) | false(일반) | 'old'(옛 서버 — 입구 없음) */
function fakeServer(dual) {
  return async (p, body) => {
    const q = p.split('?')[0];
    if (q === BASE + '/dual/pending') return dual === 'old' ? { ok: true, data: [] } : { ok: true, dual: dual === true, items: dual === true ? PEND : [] };
    if (q === BASE + '/preview') {
      if (dual === true && !body.dualAware) return { ok: false, code: 'dual_channel_manual_unsupported', error: '동시진행이라 수동제출로 접수할 수 없어요' };
      const items = String(body.text).split('\n').filter(Boolean).map(l => (l === LINE ? { ok: true, raw: l, fields: Object.assign({}, F), errors: [], warnings: [] }
        : { ok: false, raw: l, fields: {}, errors: ['칸이 부족합니다'], warnings: [] }));
      return Object.assign({ ok: true, items, optionChoices: [] }, dual === true ? { dual: true } : {});
    }
    if (q === BASE + '/dual/submit') return { ok: true, orderSubmissionId: 'os-d1', identity: 'staff_pending', price: body.naver.paidAmount + body.coupang.paidAmount, worktableRow: 9, reviewerLinkApplied: body.reviewerLink.mode, warnings: [] };
    if (q === BASE + '/dual/complete') return { ok: true, orderSubmissionId: body.orderSubmissionId, completed: true, identity: 'staff_pending', price: 19000, warnings: [] };
    if (q === BASE + '/submit') return { ok: true, okCount: 1, failCount: 0, results: [{ index: 0, ok: true, name: '김민수', orderSubmissionId: 'os-1', captureSession: {} }] };
    if (p === '/api/image/image-extract') return { ok: false };
    return { ok: true, data: [] };
  };
}
const open = B => B.M.open({ sheetId: 's1', tabName: 'T', gid: '0', campaignId: null, title: 't' });

test('349 화면 ① 동시진행 작업표: 열면 동시진행 모드 · 보완 필요 N건 링크 · 미리보기는 dualAware · 구매처 칸(네이버·쿠팡 주문번호·금액·캡처)', async () => {
  const B = boot(fakeServer(true));
  open(B); await sleep(10);
  assert.strictEqual(B.of('/dual/pending').length, 1, '열 때 한 번 묻는다');
  assert.ok(B.html().includes('네이버+쿠팡 동시진행'));
  assert.ok(/보완 필요 2건 — 보기/.test(B.html()), '보완 대상 링크');
  await B.paste(0, LINE);
  assert.strictEqual(B.of('/preview')[0].body.dualAware, true);
  const h = B.html();
  for (const id of ['naver_orderNum', 'naver_paidAmount', 'coupang_orderNum', 'coupang_paidAmount']) assert.ok(h.includes(`-${id}"`), id);
  assert.ok(/<th class="chs" colspan="3">네이버<\/th>/.test(h) && /<th class="chs" colspan="3">쿠팡<\/th>/.test(h), '묶음 머리');
  assert.ok(!/>구매캡처</.test(h), '일반 구매캡처 칸 대신 구매처 칸');
  assert.ok(/네이버 주문번호·금액·캡처 \/ 쿠팡 주문번호·금액·캡처 필요/.test(h), '빠진 칸을 그 자리에 알린다');
});

test('349 화면 ② 캡처는 고른 줄 + 고른 구매처 칸에만 — 칸 없이 붙이면 안내만 · 끌어다 놓기는 놓은 칸 · 둘 다 차야 제출 · 줄마다 dual/submit(일반 submit 0)', async () => {
  const B = boot(fakeServer(true));
  open(B); await sleep(10);
  await B.paste(0, LINE);
  B.M.selectRow(0);                        // 양식 칸을 고른 채(구매처 칸 아님) Ctrl+V
  const ev = B.docPaste(B.img('AAA'));
  assert.ok(ev.defaultPrevented && B.toasts.some(t => /네이버 또는 쿠팡 캡처 칸/.test(t)), '짐작해서 붙이지 않는다');
  B.capPaste(0, 'naver', B.img('NNN'));
  const d = B.drop(0, 'coupang', B.img('CCC'));
  assert.ok(d.stopped, '칸에 놓은 것을 줄이 다시 받지 않는다');
  await sleep(30);
  assert.ok(B.html().includes('base64,NNN') && B.html().includes('base64,CCC'));
  B.M.dualEdit(0, 'naver', 'orderNum', '2026110712345678'); B.M.dualEdit(0, 'naver', 'paidAmount', '9,000');
  B.M.dualEdit(0, 'coupang', 'orderNum', '31000123456789');
  await B.M.submit();
  assert.strictEqual(B.of('/dual/submit').length, 0, '쿠팡 금액이 비면 제출 대상 아님');
  B.M.dualEdit(0, 'coupang', 'paidAmount', '10000');
  await B.M.submit();
  const s = B.of('/dual/submit');
  assert.strictEqual(s.length, 1);
  assert.strictEqual(B.of('/submit').length, 0, '일반 제출 입구는 부르지 않는다(결정 344)');
  const b = s[0].body;
  assert.deepStrictEqual([b.naver.orderNum, b.naver.paidAmount, b.naver.imageBase64, b.coupang.orderNum, b.coupang.paidAmount, b.coupang.imageBase64],
    ['2026110712345678', 9000, 'NNN', '31000123456789', 10000, 'CCC']);
  assert.strictEqual(b.fields.recipient, '김민수'); assert.strictEqual(b.reviewerLink.mode, 'auto'); assert.strictEqual(b.sheetId, 's1');
  assert.ok(/김민수 — 접수 완료/.test(B.html()) && /네이버\+쿠팡 합계 19,000원/.test(B.html()) && /명의 직원 확인 필요/.test(B.html()), '결과 화면');
});

test('349 화면 ② 양식 금액은 대조용 — 두 금액 합과 다르면 주황 경고(제출은 막지 않음) · 양식에 금액이 없어도 정상', async () => {
  const B = boot(fakeServer(true));
  open(B); await sleep(10);
  await B.paste(0, LINE);
  B.capPaste(0, 'naver', B.img('NNN')); B.capPaste(0, 'coupang', B.img('CCC')); await sleep(30);
  ['naver', 'coupang'].forEach((c, k) => { B.M.dualEdit(0, c, 'orderNum', 'O-' + k); B.M.dualEdit(0, c, 'paidAmount', k ? '10000' : '9000'); });
  B.M.delRow(1);   // 빈 맨 아래 줄을 지워 표를 다시 그린다(가짜 DOM 은 칸만 갱신하는 길을 못 본다)
  assert.ok(/양식 금액 15,800 ≠ 두 금액 합 19,000/.test(B.html()), '주황 경고');
  assert.ok(/<tr id="moR-\d+" class="[^"]*fix/.test(B.html()), '줄은 주황(빨강 아님)');
  await B.M.submit();
  assert.strictEqual(B.of('/dual/submit').length, 1, '금액 합이 달라도 제출(경고만)');
  // 양식 금액 칸을 비워도(대조용) 줄은 정상
  const C = boot(fakeServer(true));
  open(C); await sleep(10);
  await C.paste(0, LINE);
  C.M.edit(0, 'price', '');
  C.capPaste(0, 'naver', C.img('NNN')); C.capPaste(0, 'coupang', C.img('CCC')); await sleep(30);
  ['naver', 'coupang'].forEach((c, k) => { C.M.dualEdit(0, c, 'orderNum', 'O-' + k); C.M.dualEdit(0, c, 'paidAmount', '9000'); });
  await C.M.submit();
  assert.strictEqual(C.of('/dual/submit').length, 1, '양식 금액이 비어도 제출 대상');
});

test('349 화면 ③ 보완 목록: 기존 쪽을 고르고 빠진 쪽만 넣으면 dual/complete — 기존 쪽은 사진 없이 · 지급된 주문은 제외', async () => {
  const B = boot(fakeServer(true));
  open(B); await sleep(10);
  B.M.openComplete();
  const h = B.html();
  assert.ok(/보완 필요 2건/.test(h) && h.includes('3번') && h.includes('…5678') && h.includes('10,000'));
  assert.ok(/이미 입금 회차에 담긴 주문이라 보완할 수 없습니다/.test(h), '지급된 주문은 막고 이유를 보인다');
  assert.ok(/기존 주문\(금액·캡처\)이 네이버인지 쿠팡인지 고르세요/.test(h));
  B.M.pickBase(0, 'coupang');
  assert.ok(/기존 1장/.test(B.html()), '기존 쪽 캡처 칸 = 기존 1장');
  B.M.dualEdit(0, 'naver', 'orderNum', 'N-555666'); B.M.dualEdit(0, 'naver', 'paidAmount', '9000');
  B.capPaste(0, 'naver', B.img('N2N'));
  B.capPaste(0, 'coupang', B.img('XXX'));   // 기존 쪽 칸에는 칸 자체가 없어 붙여도 쓰지 않는다(보낼 때 사진 없이)
  await sleep(30);
  await B.M.submit();
  const c = B.of('/dual/complete');
  assert.strictEqual(c.length, 1, '지급된 줄은 보내지 않는다');
  assert.strictEqual(c[0].body.orderSubmissionId, PEND[0].orderSubmissionId);
  assert.deepStrictEqual(c[0].body.naver, { orderNum: 'N-555666', paidAmount: 9000, imageBase64: 'N2N', mimeType: 'image/jpeg' });
  assert.ok(!('imageBase64' in c[0].body.coupang), '기존 쪽은 사진을 보내지 않는다(서버가 기존 캡처를 되읽음)');
  assert.ok(/가나다 — 보완 완료/.test(B.html()) && /명의 직원 확인 필요/.test(B.html()));
});

test('349 화면 ④ 일반 작업표 · 옛 서버(입구 없음)는 종전 화면 그대로 — 구매캡처 칸 · 일반 submit', async () => {
  for (const mode of [false, 'old']) {
    const B = boot(fakeServer(mode));
    open(B); await sleep(10);
    await B.paste(0, LINE);
    const h = B.html();
    assert.ok(!h.includes('동시진행') && !h.includes('naver_orderNum') && />구매캡처</.test(h), String(mode));
    await B.M.submit();
    assert.strictEqual(B.of('/submit').length, 1); assert.strictEqual(B.of('/dual/submit').length, 0);
  }
});

test('349 화면 ⑤ 칸 폭: 동시진행 모드 칸 합 ≤ 1600(옆으로 밀기 · 번호·양식·확인 고정) · 연락처·계좌·아이디는 일반 모드와 같은 폭', () => {
  const block = MO.slice(MO.indexOf('function dualTableCols()'), MO.indexOf('function headHtml('));
  const ws = [...block.matchAll(/w: (\d+)/g)].map(m => +m[1]);
  const dc = MO.slice(MO.indexOf('function dualCols('), MO.indexOf('function appCell('));
  const per = [...dc.matchAll(/w: (\d+)/g)].map(m => +m[1]).reduce((a, b) => a + b, 0) * 2;
  const sum = ws.reduce((a, b) => a + b, 0) - 156 + per;   // 참여 신청 칸(공고 화면 경로 전용)은 작업보드 경로에 없다
  assert.ok(sum <= 1600, '동시진행 칸 합 ' + sum);
  for (const [k, w] of [['phone', 118], ['account', 128], ['userId', 74]]) assert.ok(new RegExp(`k: '${k}', label: '[^']+', w: ${w}`).test(block), k);
  assert.ok(/k: 'no'[^\n]*cls: 'stk r'/.test(block) && /k: 'raw'[^\n]*cls: 'stk2'/.test(block) && /k: 'st'[^\n]*cls: 'stkr'/.test(block), '고정 칸');
});
