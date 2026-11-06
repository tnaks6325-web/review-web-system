'use strict';
/**
 * manualOrderImeAndGates.test.js — 결정 347 후속(실브라우저 검증에서 나온 6건) 회귀가드
 * 실행: node --test tests/manualOrderImeAndGates.test.js   (DB·서버·브라우저 불필요)
 *
 * 실제 frontend/js/manual-order.js 를 vm 에 올리고 아주 작은 가짜 DOM 으로 돌린다.
 *  ① 한글 조합 중에는 표를 다시 그리지 않는다 — 조합 시작·끝은 **창 루트에 묶은 이벤트**로 안다.
 *     (인라인 oncompositionstart/oncompositionend 속성은 Chromium·WebKit 이 지원하지 않아 한 번도 안 불렸다 —
 *      그래서 이 시험은 공개 함수 ime() 를 직접 부르지 않고, 창 루트에 등록된 리스너로만 조합 이벤트를 보낸다.)
 *  ② 이미 나뉜 줄에서 한글만 고쳐도(조합으로만 바뀜) 조합이 끝나면 다시 나눈다.
 *  ③ 남은 자리 초과 확인 체크가 붙은 상품 칸 — 고르는 칸이 찌그러지지 않는다(최소 폭 · 휴대폰은 칸 폭을 넓힌다).
 *  ④ 참여형: 고를 기존 신청이 있는데 안 고른 줄은 빨간 표시 + 제출 제외(서버 application_selection_required 와 같은 조건).
 *  ⑤ 표 칸 합이 PC 창(1440 → 상자 1392px)을 넘지 않는다 — 넘으면 구매캡처 클립 단추가 오른쪽 고정 칸에 가린다.
 *  ⑥ 모듈 머리 설명의 진입점 수가 실제와 같다.
 */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MO_PATH = path.join(__dirname, '..', '..', 'frontend', 'js', 'manual-order.js');
const MO = fs.readFileSync(MO_PATH, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot(server) {
  const calls = [];
  const els = new Map();
  let ovl = null;
  let renders = 0;
  const stub = id => { if (!els.has(id)) els.set(id, { id, innerHTML: '', value: '', disabled: false, textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, focus() {} }); return els.get(id); };
  const mkOvl = () => {
    const L = {};
    let html = '';
    return {
      style: {}, classList: { add() {}, remove() {}, toggle() {} }, __L: L,
      addEventListener(t, fn, cap) { (L[t] = L[t] || []).push({ fn, cap: !!cap }); },
      remove() { ovl = null; },
      get innerHTML() { return html; }, set innerHTML(v) { html = v; renders++; },
      set className(_) {},
    };
  };
  const document = {
    head: { appendChild() {} },
    body: { appendChild(el) { ovl = el; } },
    createElement() { return mkOvl(); },
    getElementById(id) {
      if (id === 'mo-style') return {};
      if (id === 'moOvl') return ovl;
      if (!ovl) return null;
      if (id === 'moSubmit' || id === 'moOptTip') return ovl.innerHTML.includes(`id="${id}"`) ? stub(id) : null;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const win = {
    document, console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Array, Object, String, Number, RegExp, Map, Set, Error,
    sessionStorage: { getItem: () => 'tok' }, localStorage: { getItem: () => '' },
    location: { hostname: 'x' }, API_BASE_URL: 'http://api',
    alert() {}, confirm: () => true, toast() {},
    fetch: async (url, o) => {
      const p = String(url).replace('http://api', '');
      const body = o && o.body ? JSON.parse(o.body) : {};
      calls.push({ p, body });
      const r = await server(p, body);
      return { json: async () => r };
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(MO, win);
  const M = win.ManualOrder;
  const html = () => (ovl ? ovl.innerHTML : '');
  /** 창 루트에 등록된 리스너로만 조합 이벤트를 보낸다(브라우저가 하는 일과 같은 길) */
  const fire = (type, target) => {
    const ls = (ovl && ovl.__L[type]) || [];
    ls.forEach(l => l.fn({ type, target, isComposing: type !== 'compositionend' }));
    return ls.length;
  };
  const uid = k => Number((/id="moRaw-(\d+)"/g.exec(html().split('<tr id="moR-')[k + 1] || '') || [])[1]);
  return {
    M, win, calls, html, fire, uid,
    renders: () => renders,
    previews: () => calls.filter(c => /\/preview$/.test(c.p)),
    submits: () => calls.filter(c => /\/submit$/.test(c.p)),
    btn: () => document.getElementById('moSubmit'),
    tip: () => document.getElementById('moOptTip'),
  };
}

const LINE = {
  KIM: '김민수/김민수/kim01/010-1111-1111/서울시 마포구 1/신한은행/110-111/김민수/15800',
  KIM2: '김민우/김민우/kim01/010-1111-1111/서울시 마포구 1/신한은행/110-111/김민우/15800',
  PARK: '박지영/박지영/park02/010-2222-2222/서울시 강남구 2/국민은행/220-222/박지영/15800',
};
const fieldsOf = l => { const p = l.split('/'); return { reviewerName: p[0], recipient: p[1], userId: p[2], phone: p[3], address: p[4], bank: p[5], account: p[6], depositor: p[7], price: Number(p[8]) }; };
function server(opt) {
  const o = Object.assign({ options: [], apps: [] }, opt || {});
  return async (p, body) => {
    if (/\/preview$/.test(p)) {
      const items = String(body.text).split('\n').filter(s => s.trim()).map(l => (l.split('/').length === 9
        ? { ok: true, raw: l, fields: fieldsOf(l), errors: [], warnings: [] }
        : { ok: false, raw: l, fields: {}, errors: ['칸이 부족합니다'], warnings: [] }));
      return { ok: true, items, optionChoices: o.options };
    }
    if (/\/applications$/.test(p)) return { ok: true, data: o.apps };
    if (/\/submit$/.test(p)) {
      const results = body.items.map((it, i) => ({ index: i, ok: true, name: it.fields.recipient, orderSubmissionId: 'os' + i, captureSession: {} }));
      return { ok: true, okCount: results.length, failCount: 0, results };
    }
    return { ok: true, data: [] };
  };
}
const colWidths = h => [...h.matchAll(/<col [^>]*style="width:(\d+)px"/g)].map(m => Number(m[1]));

test('① 조합 시작·끝은 창 루트(캡처 단계) 리스너로 안다 — 조합 중엔 분류 응답이 와도 표를 다시 그리지 않고, 끝나면 분류를 다시 건다', async () => {
  const B = boot(server());
  B.M.open({ sheetId: 's', tabName: 't' });
  const raw = { id: 'moRaw-' + B.uid(0), value: '' };
  B.M.rowInput(0, '김민수/', { isComposing: false });      // '/' 는 조합 없이 들어온다 → 0.5초 분류 타이머
  const r0 = B.renders();
  raw.value = '김민수/';
  assert.ok(B.fire('compositionstart', raw) > 0, '창 루트에 compositionstart 리스너가 있어야 한다');
  for (const v of ['김민수/ㅂ', '김민수/바', '김민수/박']) { raw.value = v; B.M.rowInput(0, v, { isComposing: true }); }
  await sleep(800);                                           // 예전엔 여기서 타이머가 표를 통째로 다시 그려 조합이 깨졌다
  assert.strictEqual(B.renders(), r0, '조합 중에는 표를 다시 그리지 않는다');
  raw.value = '김민수/박';
  assert.ok(B.fire('compositionend', raw) > 0, '창 루트에 compositionend 리스너가 있어야 한다');
  await sleep(700);
  const last = B.previews().slice(-1)[0];
  assert.ok(last && last.body.text === '김민수/박', '조합이 끝난 글로 다시 나눈다: ' + (last && last.body.text));
  assert.ok(B.renders() > r0, '조합이 끝난 뒤에는 미뤄 둔 다시 그리기를 한다');
});

test('① 다른 칸(나뉜 값 칸)에서 조합 중이어도 표를 다시 그리지 않는다', async () => {
  const B = boot(server());
  B.M.open({ sheetId: 's', tabName: 't' });
  B.M.rowInput(0, LINE.KIM.slice(0, 20), { isComposing: false });
  const r0 = B.renders();
  B.fire('compositionstart', { id: 'moF-' + B.uid(0) + '-reviewerName', value: '김' });
  await sleep(800);
  assert.strictEqual(B.renders(), r0);
  const n0 = B.previews().length;
  B.fire('compositionend', { id: 'moF-' + B.uid(0) + '-reviewerName', value: '김' });
  await sleep(700);
  assert.ok(B.previews().length > n0, '조합 시작 때 쉬게 한 분류 타이머를 조합이 끝나면 다시 건다');
  assert.ok(B.renders() > r0);
});

test('② 이미 나뉜 줄에서 한글만 고쳐도(조합 입력으로만 바뀜) 조합이 끝나면 다시 나눈다', async () => {
  const B = boot(server());
  B.M.open({ sheetId: 's', tabName: 't' });
  B.M.rowInput(0, LINE.KIM, { isComposing: false });
  await B.M.flush();
  const n0 = B.previews().length;
  const raw = { id: 'moRaw-' + B.uid(0), value: LINE.KIM };
  B.fire('compositionstart', raw);
  for (const v of [LINE.KIM.replace('김민수', '김민ㅇ'), LINE.KIM.replace('김민수', '김민우')]) { raw.value = v; B.M.rowInput(0, v, { isComposing: true }); }
  raw.value = LINE.KIM.replace('김민수', '김민우');
  B.fire('compositionend', raw);
  await sleep(700);
  assert.ok(B.previews().length > n0, '조합이 끝난 뒤 0.5초 안에 다시 나눈다');
  assert.ok(B.previews().slice(-1)[0].body.text.startsWith('김민우/'), B.previews().slice(-1)[0].body.text);
});

test('② (공개 함수 길) ime(1) → 조합 입력 → ime(0) 도 같은 순서로 다시 나눈다 — 글 저장이 조합 판정보다 뒤', async () => {
  const B = boot(server());
  B.M.open({ sheetId: 's', tabName: 't' });
  B.M.rowInput(0, LINE.KIM, { isComposing: false });
  await B.M.flush();
  const n0 = B.previews().length;
  B.M.ime(1);
  B.M.rowInput(0, LINE.KIM.replace('김민수', '김민우'), { isComposing: true });
  B.M.ime(0, 0, LINE.KIM.replace('김민수', '김민우'));
  await sleep(700);
  assert.ok(B.previews().length > n0, '한글만 고친 줄이 다시 나뉘어야 한다');
});

test('③ 초과 확인 체크가 붙은 상품 칸 — 고르는 칸은 최소 폭을 지키고, 휴대폰에서는 칸 자체를 넓힌다(한 줄 규칙 유지)', async () => {
  const options = [
    { optKey: 'A', productName: '본품 500ml', unitKind: 'product', remaining: 0, used: 5, recruitTotal: 5, status: 'soldout' },
    { optKey: 'B', productName: '리필 1L', unitKind: 'product', remaining: 5, used: 0, recruitTotal: 5, status: 'active' },
  ];
  const B = boot(server({ options }));
  B.M.open({ sheetId: 's', tabName: 't' });
  B.M.rowInput(0, LINE.KIM, { isComposing: false });
  await B.M.flush();
  assert.ok(!/mo-c-opt ack/.test(B.html()), '초과 줄이 없으면 넓히지 않는다');
  B.M.pickOption(0, 'A');
  const h = B.html();
  assert.ok(/id="moAck-\d+"/.test(h), '초과 확인 체크가 나온다');
  assert.ok(/<col class="mo-c-opt ack" style="width:\d+px">/.test(h), '초과 확인이 있는 표는 상품 칸에 표시를 단다');
  const CSS = MO.slice(MO.indexOf('st.textContent = `'), MO.indexOf('`;', MO.indexOf('st.textContent = `')));
  const minW = /#moOvl \.mo-cellf \.mo-sel\{[^}]*min-width:(\d+)px/.exec(CSS);
  assert.ok(minW && Number(minW[1]) >= 96, '상품 고르는 칸 최소 폭 ≥ 96px');
  assert.match(CSS, /#moOvl \.mo-ack\{[^}]*flex:none/, '확인 체크는 줄지도 늘지도 않는다');
  const mob = CSS.slice(CSS.indexOf('@media screen and (max-width:768px)'));
  const wide = /#moOvl col\.mo-c-opt\.ack\{width:(\d+)px !important\}/.exec(mob);
  assert.ok(wide && Number(wide[1]) >= 220, '휴대폰: 초과 확인이 있는 상품 칸은 넓힌다');
  // PC: 상품 칸 156px(안쪽 148) = 고르는 칸 최소 폭 + 사이 + 확인 체크(체크 13 + 글자 두 자) 안에 든다
  // (결정 348: 리뷰어 연결 칸이 앞에 들어와 순번이 밀린다 — 순번이 아니라 상품 칸 표시로 찾는다 · 검사 의미 불변)
  const optW = Number((/<col class="mo-c-opt[^"]*" style="width:(\d+)px">/.exec(h) || [])[1]);
  assert.ok(optW - 8 >= Number(minW[1]) + 4 + 13 + 4 + 2 * 12, 'PC 상품 칸 안에 고르는 칸 최소 폭 + 확인 체크가 든다: ' + optW);
  assert.match(h, /<label class="mo-ack" [^>]*><input type="checkbox" id="moAck-\d+" aria-label="1번 줄 남은 자리 초과 확인"/);
});

test('④ 참여형: 고를 기존 신청이 있는데 안 고른 줄은 빨간 표시 + 제출 제외 — 고르면 다시 제출 대상', async () => {
  const apps = [{ id: 501, phone8: '11111111', applicant_name: '김민수', status: 'applied', applied_at: '11-06' },
    { id: 900, phone8: '22222222', applicant_name: '박지영', status: 'approved', applied_at: '11-06' }];   // 확정된 신청은 고를 대상 아님(서버와 같은 상태 목록)
  const B = boot(server({ apps }));
  B.M.open({ sheetId: 's', tabName: 't', campaignId: 'c77' });
  B.M.pasteLines(0, [LINE.KIM, LINE.PARK]);
  await B.M.flush();
  await sleep(10);
  assert.strictEqual(B.btn().textContent, '1건 제출', '신청을 안 고른 김민수 줄은 제출 수에서 빠진다');
  assert.match(B.tip().textContent, /참여 신청을 고르지 않은 줄 1개/);
  const seg = B.html().split('<tr id="moR-')[1];
  assert.match(seg, /<div class="mo-st e" title="[^"]*기존 신청이 있어 확정할 신청을 골라야 제출할 수 있습니다/);
  await B.M.submit();
  const sb = B.submits()[0];
  assert.deepStrictEqual(sb.body.items.map(i => i.fields.recipient), ['박지영'], '안 고른 줄은 서버로 보내지 않는다');
  // 다시 — 고르면 제출 대상
  const B2 = boot(server({ apps }));
  B2.M.open({ sheetId: 's', tabName: 't', campaignId: 'c77' });
  B2.M.pasteLines(0, [LINE.KIM, LINE.PARK]);
  await B2.M.flush();
  B2.M.pickApplication(0, '501');
  assert.strictEqual(B2.btn().textContent, '2건 제출');
  await B2.M.submit();
  assert.deepStrictEqual(B2.submits()[0].body.items.map(i => i.targetApplicationId), ['501', null]);
});

test('④ 서버 판정과 같은 조건 — 서버는 applied·expired·cancelled 신청이 있고 선택이 없으면 그 줄을 거절한다', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'manualOrder.service.js'), 'utf8');
  assert.match(svc, /status IN \('applied', 'expired', 'cancelled'\) LIMIT 1/);
  assert.match(svc, /reason: 'application_selection_required'/);
  assert.match(MO, /\['applied', 'expired', 'cancelled'\]\.includes\(a\.status\)/, '화면 후보도 같은 상태 목록');
  assert.match(MO, /const submittable = it => [^\n]*!appBlock\(it\)/, '제출 가능 판정에 신청 미선택이 들어간다');
});

test('⑤ 표 칸 합이 PC 창 안에 든다(작업보드·참여형 모두 ≤ 1380px — 상자 1392px 에서 여유 12px)', async () => {
  for (const [ctx, opts] of [[{ sheetId: 's', tabName: 't' }, [{ optKey: 'A', productName: 'A', remaining: 3 }, { optKey: 'B', productName: 'B', remaining: 3 }]],
    [{ sheetId: 's', tabName: 't', campaignId: 'c77' }, []]]) {
    const B = boot(server({ options: opts, apps: [] }));
    B.M.open(ctx);
    B.M.rowInput(0, LINE.KIM, { isComposing: false });
    await B.M.flush();
    const ws = colWidths(B.html());
    const sum = ws.reduce((a, b) => a + b, 0);
    assert.ok(ws.length >= 14, '상품 또는 참여 신청 칸까지 그렸다: ' + ws.length);
    assert.ok(sum <= 1380, (ctx.campaignId ? '참여형' : '작업보드') + ' 칸 합 ' + sum);
  }
});

test('⑥ 모듈 머리 설명의 진입점은 실제와 같다 — 작업보드·관제 패널 2곳(리뷰어 홈은 모듈을 싣지 않는다)', () => {
  const head = MO.slice(0, MO.indexOf('(function () {'));
  assert.ok(!/진입점 3곳/.test(head), '진입점 3곳이라고 적지 않는다');
  assert.match(head, /진입점 2곳/);
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
  assert.ok(!/manual-order\.js/.test(idx), '리뷰어 홈은 수동제출 모듈을 싣지 않는다(설명과 실제가 같다)');
  const doc = fs.readdirSync(path.join(__dirname, '..', '..', 'docs', 'decisions')).find(f => f.startsWith('347-'));
  const body = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'decisions', doc), 'utf8');
  assert.ok(!/진입점 3곳 그대로/.test(body), '결정 347 문서도 진입점 수를 바로잡는다');
});
