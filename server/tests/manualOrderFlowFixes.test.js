'use strict';
/**
 * manualOrderFlowFixes.test.js — 결정 345 회귀가드(외부모집 수동제출 흐름 버그 묶음) + 결정 347(한 줄 = 한 사람 표 · 줄별 캡처)
 * 실행: node --test tests/manualOrderFlowFixes.test.js   (DB·서버·브라우저 불필요)
 *
 * 실제 frontend/js/manual-order.js 를 vm 에 통째로 올리고, 아주 작은 가짜 DOM·fetch 로
 * 붙여넣기 → 바로 나누기 → 캡처 → 제출 → [계속 입력] 흐름을 실제로 돌린다.
 * (문자열 grep 만으로는 "캡처가 다른 줄에 붙음·나누기 전 제출" 같은 실행 순서 버그를 못 본다.)
 *
 * ★ 결정 347 로 공용 보관함(STAGED)·이름 자동 배정(distributeStaged)이 없어졌다 → 결정 345 의 ②~⑥(판독 대기 배정·
 *   보관함 칩 id·다시 붙여넣기 보관함)은 그 뿌리가 사라졌고, 같은 사고(남의 주문에 캡처)를 막는 검사로 바꿨다:
 *   「줄마다 첨부 = 다른 줄에 안 붙음」(아래 ②'·③'·④'·⑤'·⑥').
 */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MO_PATH = path.join(__dirname, '..', '..', 'frontend', 'js', 'manual-order.js');
const MO = fs.readFileSync(MO_PATH, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 가짜 브라우저 하나 — server(p, body) 가 API 응답을 만든다. */
function boot(server, extraWin) {
  const calls = [];
  const els = new Map();
  let ovl = null;
  let pasteListener = null;
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
  const dialogs = [];
  const toasts = [];
  const win = Object.assign({
    document, console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, Error,
    sessionStorage: { getItem: () => 'tok' }, localStorage: { getItem: () => '' },
    location: { hostname: 'x' }, API_BASE_URL: 'http://api',
    alert: m => dialogs.push('alert:' + m),
    confirm: m => { dialogs.push('confirm:' + m); return true; },
    toast: m => toasts.push(m),
    FileReader: class { readAsDataURL(f) { setTimeout(() => { if (f.bad) { this.onerror && this.onerror(); return; } this.result = 'data:image/jpeg;base64,' + f.b64; this.onload(); }, f.delay || 0); } },
    fetch: async (url, o) => {
      const p = String(url).replace('http://api', '');
      const body = o && o.body ? JSON.parse(o.body) : {};
      calls.push({ p, body, at: Date.now() });
      const r = await server(p, body);
      return { json: async () => r };
    },
  }, extraWin || {});
  win.window = win;
  vm.createContext(win);
  vm.runInContext(MO, win);
  const M = win.ManualOrder;
  const img = (b64, extra) => Object.assign({ type: 'image/jpeg', size: 10, b64 }, extra || {});
  const B = {
    M, win, calls, dialogs, toasts,
    html: () => (ovl ? ovl.innerHTML : ''),
    /** 표의 줄들: [{ text, cap }] — 빈 맨 아래 줄 포함 */
    rows: () => {
      const h = ovl ? ovl.innerHTML : '';
      return h.split('<tr id="moR-').slice(1).map(seg => {
        const t = /id="moRaw-\d+" value="([^"]*)"/.exec(seg);
        const c = /base64,([A-Za-z0-9]+)"/.exec(seg);
        const st = /<div class="mo-st (\w)" title="([^"]*)"/.exec(seg);
        return { text: t ? t[1] : '', cap: c ? c[1] : '', st: st ? st[1] + ':' + st[2] : '' };
      });
    },
    /** 줄 글칸에 붙여넣기(여러 줄이면 화면이 나눠 넣고, 한 줄이면 기본 붙여넣기 + 입력 이벤트) */
    paste: async (i, text) => {
      const ev = { clipboardData: { items: [], getData: () => text }, prevented: false, preventDefault() { this.prevented = true; }, target: {} };
      M.rowPaste(ev, i);
      if (!ev.prevented) M.rowInput(i, text);
      await M.flush();
    },
    type: (i, text) => M.rowInput(i, text, { isComposing: false }),
    /** 캡처 칸(그 줄)에 Ctrl+V */
    capPaste: (i, file) => M.onPaste({ clipboardData: { items: [{ type: file.type, getAsFile: () => file }] }, preventDefault() {} }, i),
    /** 칸을 안 누르고 Ctrl+V(문서 전체) — 고른 줄로만 가야 한다 */
    docPaste: file => { const ev = { defaultPrevented: false, clipboardData: { items: [{ type: file.type, getAsFile: () => file }] }, preventDefault() { this.defaultPrevented = true; } }; pasteListener(ev); return ev; },
    docPasteRaw: ev => pasteListener(ev),
    file: (i, file) => M.onFile({ target: { files: [file], value: '' } }, i),
    drop: (i, ...files) => M.onDrop({ preventDefault() {}, currentTarget: null, dataTransfer: { files } }, i),
    img,
    uploads: () => calls.filter(c => c.p === '/api/image/image-upload').map(c => ({ order: c.body.orderSubmissionId, img: c.body.imageBase64 })),
    previews: () => calls.filter(c => /\/preview$/.test(c.p)),
  };
  return B;
}

const LINE = {
  KIM: '김민수/김민수/kim01/010-1111-1111/서울시 마포구 1/신한은행/110-111/김민수/15800',
  PARK: '박지영/박지영/park02/010-2222-2222/서울시 강남구 2/국민은행/220-222/박지영/15800',
  CHOI: '최유리/최유리/choi03/010-3333-3333/서울시 종로구 3/우리은행/330-333/최유리/15800',
};
const F = {
  KIM: { reviewerName: '김민수', recipient: '김민수', userId: 'kim01', phone: '010-1111-1111', address: '서울시 마포구 1', bank: '신한은행', account: '110-111', depositor: '김민수', price: 15800 },
  PARK: { reviewerName: '박지영', recipient: '박지영', userId: 'park02', phone: '010-2222-2222', address: '서울시 강남구 2', bank: '국민은행', account: '220-222', depositor: '박지영', price: 15800 },
  CHOI: { reviewerName: '최유리', recipient: '최유리', userId: 'choi03', phone: '010-3333-3333', address: '서울시 종로구 3', bank: '우리은행', account: '330-333', depositor: '최유리', price: 15800 },
};
/** 줄 → 미리보기 항목(간이 — 실제 파서는 서버 slashForm.js · 여기선 고정 표본만) */
function previewOf(text) {
  return String(text).split('\n').filter(s => s.trim()).map(l => {
    for (const k of Object.keys(LINE)) if (l === LINE[k]) return { ok: true, raw: l, fields: Object.assign({}, F[k]), errors: [], warnings: [] };
    return { ok: false, raw: l, fields: {}, errors: ['칸이 부족합니다'], warnings: [], missing: ['은행'] };
  });
}
/** 기본 가짜 서버: extract 는 base64 → 판독 결과 표, submit 은 전부 성공 */
function fakeServer(opt) {
  const o = Object.assign({ extract: {}, extractDelay: 0, submit: null, previewDelay: 0 }, opt || {});
  let seq = 0;
  return async (p, body) => {
    if (p === '/api/manual-order/preview' || p === '/api/trackb/manual-order/preview') { if (o.previewDelay) await sleep(o.previewDelay); return { ok: true, items: previewOf(body.text), optionChoices: [] }; }
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
const who = u => u.order.replace(/^os-\d+-/, '') + ':' + u.img;

/* ── 결정 347: 여러 줄 붙여넣기 → 한 줄 = 한 사람 ── */
test('347-① 여러 줄을 한 번에 붙여넣으면 첫 줄은 그 줄, 나머지는 아래 새 줄에 한 줄씩(빈 줄 무시) · 맨 아래엔 빈 줄 하나', async () => {
  const B = boot(fakeServer());
  open(B);
  await B.paste(0, LINE.KIM + '\r\n\n' + LINE.PARK + '\n   \n' + LINE.CHOI + '\n');
  const rows = B.rows();
  assert.deepStrictEqual(rows.map(r => r.text.split('/')[0]), ['김민수', '박지영', '최유리', '']);
  assert.strictEqual(B.previews().length, 1, '바뀐 줄 묶음을 미리보기 한 번으로');
  assert.strictEqual(B.previews()[0].body.text.split('\n').length, 3);
});
test('347-① 가운데 줄에 여러 줄을 붙이면 그 아래에 끼워 넣는다(뒤 줄은 밀린다) · 최대 50줄', async () => {
  const B = boot(fakeServer());
  open(B);
  await B.paste(0, LINE.KIM + '\n' + LINE.CHOI);
  B.M.delRow(0);   // 첫 줄을 지우고
  await B.paste(1, LINE.KIM + '\n' + LINE.PARK);   // 빈 맨 아래 줄에 다시
  assert.deepStrictEqual(B.rows().map(r => r.text.split('/')[0]), ['최유리', '김민수', '박지영', '']);
  const C = boot(fakeServer());
  open(C);
  await C.paste(0, Array.from({ length: 60 }, () => LINE.KIM).join('\n'));
  assert.strictEqual(C.rows().length, 51, '50줄 + 빈 줄');
  assert.ok(C.dialogs.some(d => /최대 50건/.test(d)));
});

/* ── 결정 347: 붙여넣으면 바로 나눈다(단계 없음) · 손으로 치면 잠깐 멈춘 뒤 ── */
test('347-② 한 줄 붙여넣기는 기다리지 않고 바로 서버 미리보기를 부른다 · 그 자리에 나뉜 값이 보인다', async () => {
  const B = boot(fakeServer());
  open(B);
  const ev = { clipboardData: { items: [], getData: () => LINE.KIM }, preventDefault() { this.p = 1; }, target: {} };
  B.M.rowPaste(ev, 0); B.M.rowInput(0, LINE.KIM);
  await sleep(40);
  assert.strictEqual(B.previews().length, 1, '붙여넣기 직후(500ms 대기 없이) 나눈다');
  await B.M.flush();
  assert.ok(B.html().includes('id="moF-') && B.html().includes('value="kim01"'), '나뉜 칸이 같은 줄에 보인다');
  assert.ok(!/다음 — 자동으로 나누기/.test(MO), '[다음] 단계가 없다');
});
test('347-② 손으로 치는 중에는 부르지 않고, 멈추면(또는 칸을 벗어나면) 부른다 · 나누는 중인 줄은 제출 전에 끝까지 기다린다', async () => {
  const B = boot(fakeServer({ previewDelay: 50 }));
  open(B);
  B.type(0, LINE.KIM.slice(0, 10));
  await sleep(100);
  assert.strictEqual(B.previews().length, 0, '치는 중엔 안 부른다');
  B.type(0, LINE.KIM);
  B.M.rowBlur(0);
  await sleep(20);
  assert.strictEqual(B.previews().length, 1, '칸을 벗어나면 바로');
  assert.strictEqual(B.previews()[0].body.text, LINE.KIM, '중간 글이 아니라 마지막 글로');
  // 바로 제출해도 나누기를 기다렸다가 보낸다
  B.type(0, LINE.PARK);
  await B.M.submit();
  const sub = B.calls.find(c => c.p === '/api/manual-order/submit');
  assert.ok(sub && sub.body.items.length === 1 && sub.body.items[0].fields.recipient === '박지영', '고친 글로 나눈 값이 나가야 한다');
});
test('347-② 틀린 줄은 그 자리에 빨간 표시 + 사유, 빠진 칸은 「없음」 · 오류 줄은 제출에서 빠진다', async () => {
  const B = boot(fakeServer());
  open(B);
  await B.paste(0, LINE.KIM + '\n홍길동/홍길동/x/010-1/주소만');
  const h = B.html();
  assert.match(h, /<tr id="moR-\d+" class="bad"/);
  assert.ok(B.rows()[1].st.startsWith('e:칸이 부족합니다'));
  assert.ok(h.includes('<span class="mo-miss">없음</span>'));
  await B.M.submit();
  assert.strictEqual(B.calls.find(c => c.p === '/api/manual-order/submit').body.items.length, 1);
});
test('347-② 나누기 실패(서버 오류)는 값을 지어내지 않고 그 줄에 이유 · 제출 대상 아님', async () => {
  const B = boot(async p => (/preview$/.test(p) ? { ok: false, error: '권한 없음' } : { ok: true }));
  open(B);
  await B.paste(0, LINE.KIM);
  assert.ok(B.rows()[0].st.startsWith('e:나누기 실패: 권한 없음'));
  assert.ok(/id="moSubmit" disabled/.test(B.html()));
});

/* ── ① (결정 345) 제출 성공 뒤 [계속 입력]: 앞 사람 캡처가 다음 사람에게 또 붙지 않는다 ── */
test('① 제출 성공 뒤 [계속 입력]에서 성공 줄과 그 캡처가 사라지고, 다음 사람 주문에 앞 사람 캡처가 올라가지 않는다', async () => {
  const B = boot(fakeServer({ extract: { A: { recipient: '김민수', phone: '010-1111-1111' } } }));
  open(B);
  await B.paste(0, LINE.KIM); B.file(0, B.img('A')); await settle();
  await B.M.submit();
  B.M.again(); await settle();
  assert.ok(!/<img/.test(B.html()), '캡처가 남아 있으면 안 된다');
  await B.paste(0, LINE.PARK); await B.M.submit();
  assert.deepStrictEqual(B.uploads().map(who), ['김민수:A']);
});

/* ── ②' 줄마다 첨부 = 다른 줄에 안 붙음(결정 345 P1 오배정의 뿌리 제거) ── */
test("②' 줄을 고른 뒤 Ctrl+V(칸을 안 눌러도) → 그 줄에만 · 그 줄 캡처 칸 Ctrl+V · 끌어다 놓기 · 파일 선택도 그 줄에만", async () => {
  const B = boot(fakeServer());
  open(B);
  await B.paste(0, [LINE.KIM, LINE.PARK, LINE.CHOI].join('\n'));
  B.M.selectRow(1); B.docPaste(B.img('P'));      // 박지영 줄을 고른 채 Ctrl+V
  B.capPaste(2, B.img('C'));                     // 최유리 줄 캡처 칸에 Ctrl+V
  B.drop(0, B.img('K'));                         // 김민수 줄에 끌어다 놓기
  await settle();
  assert.deepStrictEqual(B.rows().map(r => r.cap), ['K', 'P', 'C', '']);
  B.file(1, B.img('P2')); await settle();        // 박지영 줄 파일 선택 = 그 줄 캡처만 바뀐다
  assert.deepStrictEqual(B.rows().map(r => r.cap), ['K', 'P2', 'C', '']);
  await B.M.submit();
  assert.deepStrictEqual(B.uploads().map(who).sort(), ['김민수:K', '박지영:P2', '최유리:C']);
});
test("②' 이름을 못 읽든 순서가 어떻든 캡처는 붙인 줄을 떠나지 않는다(이름으로 옮기지 않는다)", async () => {
  const B = boot(fakeServer({ extractDelay: 80, extract: { X: { recipient: '박지영' } } }));
  open(B);
  await B.paste(0, LINE.KIM + '\n' + LINE.PARK);
  B.capPaste(0, B.img('X'));   // 김민수 줄에 박지영 이름이 찍힌 캡처
  await sleep(150);
  assert.deepStrictEqual(B.rows().map(r => r.cap), ['X', '', '']);
  await B.M.submit();
  assert.deepStrictEqual(B.uploads().map(who), ['김민수:X']);
});
test("③' 고른 줄이 없으면 문서 Ctrl+V 사진은 어느 줄에도 붙지 않고 알린다 · 글자 붙여넣기는 가로채지 않는다", async () => {
  const B = boot(fakeServer());
  open(B);
  await B.paste(0, LINE.KIM);
  const ev = B.docPaste(B.img('Z'));
  await settle();
  assert.ok(ev.defaultPrevented && !B.rows().some(r => r.cap), '아무 줄에도 안 붙는다');
  assert.ok(B.toasts.some(t => /줄을 먼저 눌러 고르세요/.test(t)));
  B.M.selectRow(0);
  B.docPaste(B.img('Y')); await settle();
  assert.strictEqual(B.rows()[0].cap, 'Y', '고른 뒤에는 그 줄로');
  const txt = { defaultPrevented: false, clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }] }, preventDefault() { this.defaultPrevented = true; } };
  // 글자만 든 붙여넣기는 가로채지 않는다(문서 처리기에 그대로 넘긴다)
  const before = B.rows().map(r => r.cap).join();
  B.docPasteRaw(txt);
  assert.ok(!txt.defaultPrevented && B.rows().map(r => r.cap).join() === before);
});
test("④' 한 줄 = 캡처 한 장 — 여러 장을 한 번에 넣으면 첫 장만 그 줄에, 나머지를 다른 줄로 보내지 않는다", async () => {
  const B = boot(fakeServer());
  open(B);
  await B.paste(0, LINE.KIM + '\n' + LINE.PARK);
  B.drop(0, B.img('A'), B.img('B'));
  await settle();
  assert.deepStrictEqual(B.rows().map(r => r.cap), ['A', '', '']);
  assert.ok(B.toasts.some(t => /첫 장만/.test(t)));
});
test("⑤' 사진을 줄이는 사이 그 줄을 지우면 버린다 — 밀려 올라온 다른 줄에 붙지 않는다", async () => {
  const B = boot(fakeServer());
  open(B);
  await B.paste(0, LINE.KIM + '\n' + LINE.PARK);
  B.file(0, B.img('SLOW', { delay: 60 }));
  B.M.delRow(0);
  await sleep(120);
  assert.deepStrictEqual(B.rows().map(r => r.cap), ['', '']);
  await B.M.submit();
  assert.deepStrictEqual(B.uploads(), []);
});
test("⑥' 캡처 판독 이름이 그 줄 수취인과 다르면 「이름이 다릅니다(캡처: OOO)」 경고만 — 제출은 막지 않는다 · 마스킹(김*수)이 맞으면 경고 없음", async () => {
  const B = boot(fakeServer({ extract: { W: { recipient: '김민수' }, M: { recipient: '김*수' }, S: { recipient: '최 유 리' } } }));
  open(B);
  await B.paste(0, [LINE.KIM, LINE.PARK, LINE.CHOI].join('\n'));
  B.capPaste(0, B.img('M')); B.capPaste(1, B.img('W')); B.capPaste(2, B.img('S'));
  await sleep(60);
  const rows = B.rows();
  assert.ok(!/이름이 다릅니다/.test(rows[0].st), '마스킹 패턴 일치 = 경고 없음: ' + rows[0].st);
  assert.ok(/^w:.*이름이 다릅니다\(캡처: 김민수\)/.test(rows[1].st), rows[1].st);
  assert.ok(!/이름이 다릅니다/.test(rows[2].st), '공백 차이는 같은 이름');
  assert.match(B.html(), /<tr id="moR-\d+" class="fix"/, '주황 표시');
  await B.M.submit();
  assert.strictEqual(B.calls.find(c => c.p === '/api/manual-order/submit').body.items.length, 3, '경고 줄도 제출된다');
});

/* ── 제출 본문 계약 불변(결정 143·211·236·345) ── */
test('347 제출 본문 모양은 그대로 — 최상위 칸·줄 칸이 종전과 같다', async () => {
  const B = boot(fakeServer({ extract: { A: { recipient: '김민수', orderNumber: 'ORD-1', productName: '클렌저', productOption: '500ml' } } }));
  open(B);
  await B.paste(0, LINE.KIM); B.capPaste(0, B.img('A')); await settle();
  await B.M.submit();
  const body = B.calls.find(c => c.p === '/api/manual-order/submit').body;
  assert.deepStrictEqual(Object.keys(body), ['sheetId', 'tabName', 'gid', 'campaignId', 'allowOverDaily', 'allowRepurchase', 'force', 'optionAware', 'productCheck', 'allowProductMismatch', 'items']);
  // 결정 348: 줄 칸에 reviewerLink(리뷰어 연결 {mode, reviewerId}) 하나가 더해졌다 — 옛 서버는 모르는 칸이라 무시하고 auto 로 처리한다
  assert.deepStrictEqual(Object.keys(body.items[0]), ['fields', 'optionKey', 'optionFullAck', 'targetApplicationId', 'reviewerLink', 'captureName', 'captureOption']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(body.items[0].reviewerLink)), { mode: 'auto', reviewerId: '' }, '고르지 않으면 자동(종전)');
  assert.deepStrictEqual(body.items[0].fields, Object.assign({}, F.KIM, { orderNum: 'ORD-1' }));
  assert.strictEqual(body.items[0].captureName, '클렌저');
  assert.strictEqual(body.campaignId, null);
});

/* ── ⑦ 결과 문구: 작업표에 바로 적힌 경우 ── */
test('⑦ 서버가 작업표 줄 번호를 돌려주면 "작업표 N번 줄에 기록됨" — "자동복구 대기"로 잘못 말하지 않는다', async () => {
  const B = boot(fakeServer({ submit: () => ({ ok: true, okCount: 1, failCount: 0, results: [{ index: 0, ok: true, name: '김민수', orderSubmissionId: 'os1', captureSession: { id: 'c', token: 't' }, queued: false, worktableRow: 7 }] }) }));
  open(B);
  await B.paste(0, LINE.KIM); await B.M.submit();
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
  await B.paste(0, LINE.KIM); B.capPaste(0, B.img('A')); await settle();
  await B.M.submit();
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
  await B.paste(0, [LINE.KIM, LINE.PARK, LINE.CHOI].join('\n'));
  await B.M.submit();
  assert.strictEqual(posts.length, 2);
  assert.deepStrictEqual(posts[1], { force: true, allowRepurchase: true, n: 2 });
  assert.strictEqual(B.dialogs.filter(d => d.startsWith('confirm:')).length, 2, '제출 확인 + 겹침 확인 한 번');
  assert.ok(!B.html().includes('실패'), '확인 뒤에는 모두 접수');
});

/* ── ⑩ 일부 접수 후 [계속 입력]: 실패한 줄만 다시 남긴다 ── */
test('⑩ 일부만 접수된 뒤 [계속 입력]은 실패·미제출 줄만 표에 남긴다(성공 줄 이중 등록 방지) · 그 줄의 캡처는 그 줄에 그대로', async () => {
  const B = boot(fakeServer({ submit: () => ({ ok: true, okCount: 1, failCount: 1, results: [
    { index: 0, ok: true, name: '김민수', orderSubmissionId: 'os1', captureSession: { id: 'c', token: 't' } },
    { index: 1, ok: false, name: '박지영', error: '정원 반영 실패' }] }) }));
  open(B);
  await B.paste(0, LINE.KIM + '\n' + LINE.PARK + '\n틀린/줄');
  B.capPaste(0, B.img('K')); B.capPaste(1, B.img('P')); await settle();
  await B.M.submit();
  B.M.again(); await settle();
  const rows = B.rows();
  assert.deepStrictEqual(rows.map(r => r.text.split('/')[0]), ['박지영', '틀린', ''], '실패한 박지영 + 미제출(오류) 줄만');
  assert.strictEqual(rows[0].text.split('/').length, 9, '9칸 슬래시양식');
  assert.deepStrictEqual(rows.map(r => r.cap), ['P', '', ''], '박지영 캡처는 박지영 줄에, 김민수 캡처는 사라진다');
});

/* ── ⑪ 신청 후보 조회 경로 재기준 ── */
test('⑪ 인트라넷 화면(CAMPAIGN_ADMIN_API=/api/trackb/campaigns)에서는 신청 후보도 그 경로로 조회한다', async () => {
  const B = boot(fakeServer(), { CAMPAIGN_ADMIN_API: '/api/trackb/campaigns' });
  open(B, { campaignId: 7 });
  await B.paste(0, LINE.KIM);
  assert.ok(B.calls.some(c => c.p === '/api/trackb/campaigns/7/applications'), B.calls.map(c => c.p).join(','));
  const C = boot(fakeServer());
  open(C, { campaignId: 7 });
  await C.paste(0, LINE.KIM);
  assert.ok(C.calls.some(c => c.p === '/api/campaign/admin/7/applications'), '전역 미설정 = 종전 경로');
});
test('⑪ Track B 신청 목록은 관리자 경로와 같은 핸들러(같은 응답 모양)에 위임한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
  assert.match(src, /router\.get\('\/campaigns\/:id\/applications', authMiddleware, internalMiddleware, \(req, res, next\) =>\s*_campHandlers\.apps\(req, res, next\)\)/);
  assert.match(src, /apps: _handler\(_campRoutes, '[A-Za-z]+'\)/);
});
