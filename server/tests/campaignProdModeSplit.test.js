/**
 * campaignProdModeSplit.test.js — 진행상품 입력 2모드 분리 회귀가드 (2026-08-07 우레온 건)
 * 실행: node tests/campaignProdModeSplit.test.js
 *
 * 고정하는 것(사고 재발 차단):
 *  A. `_woProductLines` — 인트라넷 "옵션 없는 줄"의 결제금액이 옵션명으로 읽히지 않는다
 *     (실측 오염 문장 `상품명 결제금액 22,000원 - 결제금액 22,000원` 재발 차단)
 *  B. 모드가 옵션 유무의 **단일 출처** — 'none' 이면 숨은 칸에 값이 남아 있어도
 *     `readOptRows()` 는 빈 배열, `rf_wd_product` 원문에도 옵션명이 안 샌다
 *     ★ 결정 271(2026-10-22 「3.가」): 공고 전체 스위치는 없다 — 모드는 **상품 카드 구성**에서 정해진다
 *       (상품 둘 이상·옵션 있는 상품 = opt · 옵션 없는 상품 하나 = none · 원장이 살아 있던 공고 = opt 유지).
 *       판정은 여전히 `_prodMode()` 한 곳이고 저장·원문이 그것을 본다(단일 출처 불변).
 *  C. 자동 판정 = 살아있는 옵션 유무(서버 `liveOptions` 와 같은 기준) — 마감만 남은 카드는 세지 않는다
 *  D. 옵션 원장이 빈 공고/오더는 텍스트 분해가 쪼갠 조각을 **옵션으로 승격시키지 않는다**
 *  E. 카드의 옵션 있음↔없음 전환 — 옵션을 없애는 방향은 확인창(조용한 값 소실 금지)
 *  F. 인트라넷이 옵션 구조를 신호로 보낸다(product_options_json) + 리뷰웹이 옵션인원으로 프리필
 *
 * ★ 정적 grep 이 아니라 **함수를 vm 으로 꺼내 가짜 DOM 위에서 실제 실행**한다 —
 *   "모드를 존중하는가"는 문자열 검사로는 못 본다(변이시험으로 검출 확인).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const recruitSrc = read('frontend/js/index-recruit.js');
const wodSrc = read('frontend/js/work-order-detail.js');
const modalSrc = read('frontend/js/recruit-modal.js');
const intranet = (() => {
  try { return fs.readFileSync('/home/user/inadd-webapp/public/static/js/review-orders.js', 'utf8'); }
  catch (_) { return null; }   // 인트라넷 레포가 없는 환경(리뷰웹 단독 CI)에서는 F절 skip
})();

let passed = 0, skipped = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }
function skip(name) { skipped++; console.log('  – ' + name + ' (skip)'); }

/** 소스에서 함수 하나를 통째로 꺼낸다(중괄호 균형) */
function grab(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert(i >= 0, `함수 없음: ${name}`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('중괄호 불균형: ' + name);
}
/** 한 줄짜리 const 선언(화살표 함수·상수표)을 그대로 꺼낸다 */
function grabConst(src, name) {
  const re = new RegExp('^const ' + name + '\\b.*$', 'm');
  const m = re.exec(src);
  assert(m, 'const 없음: ' + name);
  return m[0];
}

/* ══════════════ 가짜 DOM (querySelector 후손 선택자 지원) ══════════════ */
function makeDom() {
  const byId = {};
  function parseHtml(html) {
    // ★ 결정 271 — 상품 카드는 칸이 이름표 상자 안에 들어간다(겹친 마크업). 여는·닫는 태그 짝으로 실제 DOM 처럼 겹쳐 세운다
    //   (평평하게 세우면 「.rf-gp-unit button」 같은 후손 선택자가 아무것도 못 찾아 버튼 배선을 시험할 수 없다).
    const top = [], stack = [];
    const VOID = new Set(['input', 'img', 'br']);
    const re = /<(\/?)(input|button|span|div|textarea|strong|label|b|img)\b([^>]*)>/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1]) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === m[2]) { stack.length = i; break; } continue; }
      const node = mk(m[2]);
      const cls = /class="([^"]*)"/.exec(m[3]);
      if (cls) cls[1].trim().split(/\s+/).forEach(c => c && node.classList.add(c));
      const ph = /placeholder="([^"]*)"/.exec(m[3]);
      if (ph) node.placeholder = ph[1];
      let d; const dre = /data-([\w-]+)="([^"]*)"/g;
      while ((d = dre.exec(m[3]))) node.dataset[d[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())] = d[2];
      const parent = stack[stack.length - 1];
      if (parent) { node.parent = parent; parent.children.push(node); } else top.push(node);
      if (!VOID.has(m[2])) stack.push(node);
    }
    return top;
  }
  function matches(node, simple) {
    if (simple[0] === '#') return node.id === simple.slice(1);
    if (simple[0] === '.') return node.classList.contains(simple.slice(1));
    return node.tag === simple;
  }
  function walk(node, fn) { node.children.forEach(c => { fn(c); walk(c, fn); }); }
  function queryAll(root, sel) {
    const parts = String(sel).trim().split(/\s+/);
    let level = [root];
    parts.forEach(p => {
      const next = [];
      level.forEach(n => walk(n, c => { if (matches(c, p) && next.indexOf(c) < 0) next.push(c); }));
      level = next;
    });
    return level;
  }
  function mk(tag) {
    const node = {
      tag, children: [], parent: null, style: {}, dataset: {}, id: '', value: '', title: '',
      _cls: [], _text: '', _html: '',
      classList: {
        add(c) { if (node._cls.indexOf(c) < 0) node._cls.push(c); },
        remove(c) { node._cls = node._cls.filter(x => x !== c); },
        contains(c) { return node._cls.indexOf(c) >= 0; },
        toggle(c, on) { if (on === undefined) on = !node.classList.contains(c); return on ? node.classList.add(c) : node.classList.remove(c); },
      },
      set className(v) { node._cls = String(v).trim().split(/\s+/).filter(Boolean); },
      get className() { return node._cls.join(' '); },
      set textContent(v) { node._text = String(v); },
      get textContent() { return node._text; },
      set innerHTML(v) { node._html = String(v); node.children = parseHtml(String(v)); node.children.forEach(c => { c.parent = node; }); },
      get innerHTML() { return node._html; },
      appendChild(c) { c.parent = node; node.children.push(c); return c; },
      removeAttribute(k) { delete node['_attr_' + k]; }, setAttribute(k, v) { node['_attr_' + k] = String(v); },
      remove() { if (node.parent) node.parent.children = node.parent.children.filter(x => x !== node); },
      addEventListener(ev, fn) { (node._li = node._li || {}); (node._li[ev] = node._li[ev] || []).push(fn); },
      fire(ev) { ((node._li || {})[ev] || []).forEach(f => f()); },
      // 134: `.rf-gp` 그룹(상품 단위 판정·그룹 상품명)이 closest 로만 잡히므로 실제 DOM 과 같게 거슬러 올라간다
      closest(sel) { let n = node; const simple = String(sel).trim(); while (n) { if (matches(n, simple)) return n; n = n.parent; } return null; },
      querySelector(sel) { return queryAll(node, sel)[0] || null; },
      querySelectorAll(sel) { return queryAll(node, sel); },
    };
    return node;
  }
  const root = mk('body');
  function add(id, tag) { const n = mk(tag || 'div'); n.id = id; byId[id] = n; root.appendChild(n); return n; }
  return {
    root, mk, add, byId,
    document: {
      getElementById: id => byId[id] || null,
      createElement: tag => mk(tag),
      querySelectorAll: sel => queryAll(root, sel),
      querySelector: sel => queryAll(root, sel)[0] || null,
      body: root,
    },
  };
}

/** 옵션표 화면 하나를 통째로 세운다 — index-recruit 의 표 함수들을 실제로 실행한다 */
function makeTable(opts) {
  const dom = makeDom();
  dom.add('rf_opt_rows');
  dom.add('rf_opt_summary');
  dom.add('rf_wd_product', 'textarea');
  dom.add('rf_recruit_total', 'input');
  dom.add('rf_daily_limit', 'input');
  dom.add('rf_prod_mode_note', 'span');
  const wrap = dom.add('rf_opt_wrap');
  wrap.classList.add('rf-pm-none');
  const mode = dom.add('rf_prod_mode', 'input'); mode.value = 'none';
  dom.add('rf_opt_addbtn', 'button');
  dom.add('rf_inflow_type_value', 'input').value = 'link';
  dom.add('rf_product_url', 'input');

  const sandbox = {
    console, document: dom.document,
    confirm: () => (opts && opts.confirm !== undefined) ? opts.confirm : true,
    renderPartCheck: () => {},
    _renderPreview: () => {},
    syncRecruitProductMainUrl: () => {},
    showToast: () => {},
    /* 정원 잠금(2026-08-19) — 이 하네스는 신규 발행 상태(편집 아님)라 잠금이 꺼진 채 돈다.
       ★ 표 함수가 부르는 전역은 여기(또는 아래 추출 목록)에 반드시 함께 넣는다 —
         빠지면 ReferenceError 로 가드 전체가 빨개진다(실측: `_renderProdModeHelp` 누락). */
    _recruitEditId: null,
    _rfQuotaUnlock: false,
    escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    // 선택지별 유입가이드(134) 위젯의 화면 조작부는 스텁 — 이 가드가 보는 것은 "모드와 저장 페이로드"다
    _igBind: () => {},
    _igRender: () => {},
    _readOptionReviewMix: () => [],
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // ⚠ 표 함수가 새 전역을 부르면 이 목록도 함께 늘린다(스텁을 두면 규칙이 거기서만 딴판이 된다)
  ['_IG_MAX', '_IG_FIELDS', '_IG_TA', '_IG_URL_RE', '_igTok', '_igOk', '_igUrls', '_igImgTags', '_UG_KEY_RE']
    .forEach(c => vm.runInContext(grabConst(recruitSrc, c), sandbox));
  vm.runInContext('window._igState = { inflow: [], review: [], notes: [] };', sandbox);
  vm.runInContext('let _ugSeq = 0;', sandbox);
  [
    '_htmlToPlainPreview', '_igSetList', '_igSplitInflow', '_rfHttpUrl', '_rfGroupUnit', '_rfRowProductName', '_optUnitEntries',
    '_ugNewKey', '_ugRegister', '_ugDrop', '_ugDropAll', '_ugDropBox', '_ugBuild', '_ugLoad', '_ugCompose', '_ugMark', '_ugAttachAll',
    // 결정 272 — 글·사진 줄 편집 모델
    '_ugSt', '_ugDocNorm', '_ugDocSync', '_ugSig', '_ugMirror', '_ugAutoH', '_ugDocRender', '_ugMove', '_ugDocChanged', '_ugInsHere', '_ugDocBind', '_ugHtmlText',
    '_prodMode', '_applyProdModeUi', '_setProdModeNote', '_renderProdModeHelp', '_rfRefreshCards', '_rfSyncFirstCardUrl', '_rfRowProductUrl',
    '_renderProdTable', '_buildProdGroup', '_syncGroupTotals', 'addOptRow', '_buildOptThumbLine', '_buildOptRowEl',
    '_lastOptProductName', '_markDupProductNames', 'renderOptRows', 'renderOptRowsWithProduct',
    'readOptRows', '_readProdRows', '_readProdRowsRaw', '_syncPreviewFromOptRows', '_optSummary',
    'parseProductLinesToRows', 'applyProductRowsFromOrder',
    '_renderProdModeHelp', '_rfQuotaNotice', '_syncQuotaLockUi',
  ].forEach(fn => vm.runInContext(grab(recruitSrc, fn), sandbox));
  return { dom, sandbox, run: (code) => vm.runInContext(code, sandbox) };
}

/* ══════════════ A. 인트라넷 "옵션 없는 줄" 오독 수리 ══════════════ */
console.log('\n[A] 작업오더 상품 원문 — 옵션 없는 줄 오독');
{
  const sb = { console };
  sb.window = sb; vm.createContext(sb);
  ['_woCleanProductOption', '_woProductLines'].forEach(fn => vm.runInContext(grab(wodSrc, fn), sb));
  const NAME = '우레온 모이스처 바디 리셋 미스트 150ml 등드름 가드름';
  sb._o = {
    product_url: 'https://smartstore.naver.com/x/products/1',
    product_option: ['[상품/옵션/금액]', `1. ${NAME} (https://smartstore.naver.com/x/products/1)`,
      '- 결제금액 22,000원 / 5명 / 소계 110,000원',
      '[합계] 최종모집인원 5명 / 총 상품구입비 110,000원'].join('\n'),
  };
  const out = vm.runInContext('_woProductLines(_o)', sb);
  ok('옵션 없는 줄 → "상품명 - 결제금액 N원" (금액 중복 오염 없음)', out === `${NAME} - 결제금액 22,000원`);
  ok('실측 오염 문장(결제금액 2회) 재발 없음', !/결제금액[\s\S]*결제금액/.test(out));

  // 옵션 있는 줄은 종전 그대로 — 라벨 보존(무회귀)
  sb._o2 = { product_option: ['1. 힙스 세트', '- 콰이어트 / 결제금액 31,400원', '- 어나더 / 결제금액 31,400원'].join('\n') };
  const out2 = vm.runInContext('_woProductLines(_o2)', sb);
  ok('옵션 있는 줄은 옵션명 보존(무회귀)', /힙스 세트 콰이어트 - 결제금액 31,400원/.test(out2) && /힙스 세트 어나더/.test(out2));
}

/* ══════════════ B. 모드 = 옵션 유무의 단일 출처 ══════════════ */
console.log('\n[B] 모드가 옵션 유무의 단일 출처(결정 271 — 카드 구성에서 정해짐)');
{
  const t = makeTable();
  // 옵션명 값이 들어간 행을 'none' 으로 그리면 = 옵션 없는 상품 카드 — 저장에도 원문에도 옵션이 안 나가야 한다
  t.run(`renderOptRows([{ productName:'상품A', optKey:'블랙', payAmount:22000, recruitTotal:5, dailyLimit:5 }], { mode:'none' })`);
  ok('none: 옵션 없는 상품 카드 하나', t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp').length === 1 && t.dom.byId.rf_opt_rows.querySelector('.rf-gp').dataset.unit === 'product');
  ok('none 모드: readOptRows() = 빈 배열(숨은 옵션명 무시)', t.run('JSON.stringify(readOptRows())') === '[]');
  ok('none 모드: rf_wd_product 원문에 옵션명 미포함', !/블랙/.test(t.dom.byId.rf_wd_product.value));
  ok('none 모드: 상품명·금액은 원문에 살아 있다', /상품A - 결제금액 22,000원/.test(t.dom.byId.rf_wd_product.value));
  ok('none 모드: 정원 파생은 종전대로(총 5)', t.dom.byId.rf_recruit_total.value === 5);

  // 카드에서 「옵션 있음」을 누르고 옵션명을 넣으면 = 옵션 있는 상품(opt) — 저장 대상이 된다
  const box = t.dom.byId.rf_opt_rows.querySelector('.rf-gp');
  box.querySelectorAll('.rf-gp-unit button').find(b => b.dataset.unit === 'option').onclick();
  const nm = box.querySelector('.rf-opt-name'); nm.value = '블랙'; nm.fire('input');
  const opts = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('옵션 있음 전환 + 옵션명 → opt 모드 · 저장 대상 1', t.run('_prodMode()') === 'opt' && opts.length === 1 && opts[0].optKey === '블랙' && opts[0].unitKind === 'option');
  ok('opt 모드: 작업내용 원문에 옵션명 포함', /상품A - 블랙 - 결제금액/.test(t.dom.byId.rf_wd_product.value));
}

/* ══════════════ B-2. 결정 271 — 카드 구성이 정하는 저장 모양 ══════════════ */
console.log('\n[B-2] 카드 구성 → 저장 모양(발행 프리필 _woProductMode 와 같은 규칙)');
{
  const t = makeTable();
  t.run(`renderOptRows([])`);
  ok('빈 공고 = 옵션 없는 상품 카드 하나(인트라넷과 같다) · none', t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp').length === 1 && t.run('_prodMode()') === 'none');
  ok('카드 하나 = 삭제 버튼 숨김', t.dom.byId.rf_opt_rows.querySelector('.rf-gp-del').hidden === true);
  t.run(`addOptRow()`);
  ok('[+ 상품 추가] = 옵션 없는 상품 카드 하나 더', t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp').length === 2
    && t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp')[1].dataset.unit === 'product');
  ok('카드 둘 = 삭제 버튼 보임', t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp-del').every(b => b.hidden === false));
  const boxes = t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp');
  [['상품A', 'https://s.example/a'], ['상품B', 'https://s.example/b']].forEach(([n, u], i) => {
    const ne = boxes[i].querySelector('.rf-gp-name'); ne.value = n; ne.fire('input');
    const ue = boxes[i].querySelector('.rf-gp-url'); ue.value = u; ue.fire('input');
  });
  const o = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('옵션 없는 상품 둘 = opt · 상품 단위 선택지 둘', t.run('_prodMode()') === 'opt' && o.length === 2 && o.every(x => x.unitKind === 'product'));
  ok('상품 단위 선택지 주소 = 카드 상품 주소(옵션 주소·상품 주소 같은 값)', o[0].optionUrl === 'https://s.example/a' && o[0].productUrl === 'https://s.example/a' && o[1].productUrl === 'https://s.example/b');
  ok('첫 카드 주소 = 공고 상품 페이지(랜딩)', t.dom.byId.rf_product_url.value === 'https://s.example/a');

  // 원장이 살아 있던 공고는 상품 하나여도 원장을 유지한다(손대지 않은 저장이 원장을 지우지 않게)
  const t2 = makeTable();
  t2.run(`renderOptRowsWithProduct([{ optKey:'상품A', unitKind:'product', productName:'상품A', payAmount:1000, recruitTotal:3, dailyLimit:1, status:'active' }], '상품A - 결제금액 1,000원')`);
  ok('원장 줄이 살아 있던 상품 하나 = opt 유지', t2.run('_prodMode()') === 'opt' && JSON.parse(t2.run('JSON.stringify(readOptRows())')).length === 1);

  // 옵션 있는 상품의 상품 주소 — 모르는 값(196 이전 줄)은 보내지 않는다(null = 저장된 값 유지) · 사람이 고치면 보낸다
  const t3 = makeTable();
  t3.run(`renderOptRows([{ productName:'힙스', optKey:'콰이어트', payAmount:1, recruitTotal:1, dailyLimit:1 }, { productName:'힙스', optKey:'어나더', payAmount:1, recruitTotal:1, dailyLimit:1 }])`);
  ok('모르는 상품 주소 = null', JSON.parse(t3.run('JSON.stringify(readOptRows())')).every(x => x.productUrl === null));
  const ue = t3.dom.byId.rf_opt_rows.querySelector('.rf-gp-url'); ue.value = 'https://s.example/h'; ue.fire('input');
  ok('사람이 넣은 상품 주소 = 그 상품의 모든 옵션 줄에', JSON.parse(t3.run('JSON.stringify(readOptRows())')).every(x => x.productUrl === 'https://s.example/h'));
  const t4 = makeTable();
  t4.run(`renderOptRows([{ productName:'힙스', optKey:'콰이어트', productUrl:'https://s.example/saved', payAmount:1, recruitTotal:1, dailyLimit:1 }])`);
  ok('저장된 상품 주소는 그대로 보낸다', JSON.parse(t4.run('JSON.stringify(readOptRows())'))[0].productUrl === 'https://s.example/saved');
  // ★ 코드 리뷰(2026-10-22) — 저장돼 있던 옵션 없는 상품 줄(savedOptKey)인데 상품 주소가 없으면(196 이전) 그 줄 주소를 상품 주소로 보내지 않는다
  const t5 = makeTable();
  t5.run(`renderOptRows([{ productName:'방향제', unitKind:'product', optKey:'방향제', savedOptKey:'방향제', optionUrl:'https://s.example/old', payAmount:1, recruitTotal:1, dailyLimit:1 },
    { productName:'탈취제', unitKind:'product', optKey:'탈취제', savedOptKey:'탈취제', optionUrl:'https://s.example/t', productUrl:'https://s.example/t', payAmount:1, recruitTotal:1, dailyLimit:1 }], { saved: true })`);
  const o5 = JSON.parse(t5.run('JSON.stringify(readOptRows())'));
  ok('저장된 옵션 없는 상품 줄 · 상품 주소 모름 = null(줄 주소는 그대로 보냄)', o5[0].productUrl === null && o5[0].optionUrl === 'https://s.example/old' && o5[1].productUrl === 'https://s.example/t');
  const ue5 = t5.dom.byId.rf_opt_rows.querySelector('.rf-gp-url'); ue5.value = 'https://s.example/new'; ue5.fire('input');
  ok('사람이 고치면 보낸다', JSON.parse(t5.run('JSON.stringify(readOptRows())'))[0].productUrl === 'https://s.example/new');
  const t6 = makeTable();
  t6.run('addOptRow()'); t6.run('addOptRow()');
  const ue6 = t6.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp-name'); ue6[0].value = 'A'; ue6[0].fire('input'); ue6[1].value = 'B'; ue6[1].fire('input');
  const ru6 = t6.dom.byId.rf_opt_rows.querySelectorAll('.rf-opt-url'); ru6[0].value = 'https://s.example/a';
  ok('새 카드(저장 전)의 옵션 없는 상품 = 줄 주소가 곧 상품 주소', JSON.parse(t6.run('JSON.stringify(readOptRows())'))[0].productUrl === 'https://s.example/a');
}

/* ══════════════ C. 자동 판정 + 사람 전환 ══════════════ */
console.log('\n[C] 모드 자동 판정(살아있는 옵션 기준) · 사람 전환');
{
  const t = makeTable();
  t.run(`renderOptRows([{ optKey:'콰이어트', status:'active' }, { optKey:'어나더', status:'active' }])`);
  ok('살아있는 옵션 2종 → opt 모드 자동', t.run('_prodMode()') === 'opt');

  const t2 = makeTable();
  // ★★ 우레온 상태: 마감(closed) 옵션만 남은 공고 → 옵션 없는 작업으로 자동 판정(서버 liveOptions 와 같은 기준)
  t2.run(`renderOptRows([{ optKey:'우레온 모이스처 바디', status:'closed', recruitTotal:3 }])`);
  ok('마감 옵션만 남은 공고 → none 모드 자동(서버 liveOptions 와 같은 기준)', t2.run('_prodMode()') === 'none');
  ok('마감 옵션만 남은 공고: 저장 페이로드 빈 배열(= 옵션 정리)', t2.run('JSON.stringify(readOptRows())') === '[]');
  ok('마감 옵션 행 자체는 화면에 남는다(이력·재개 경로 보존)',
    t2.dom.byId.rf_opt_rows.querySelectorAll('.rf-opt-row').length === 1);

  const t3 = makeTable();
  t3.run(`renderOptRows([])`);
  ok('빈 표(신규 공고) → none 모드 · 자동판정 사유 미표기', t3.run('_prodMode()') === 'none' && t3.dom.byId.rf_prod_mode_note.textContent === '');
}

/* ══════════════ D. 텍스트 추측을 옵션으로 승격시키지 않는다 ══════════════ */
console.log('\n[D] 옵션 신호 없는 오더·공고 — 추측 승격 금지');
{
  // 상품명 안의 하이픈이 옵션처럼 쪼개지는 실제 함정
  const t = makeTable();
  t.run(`applyProductRowsFromOrder({ wd_product: '우레온 모이스처 바디-리셋 미스트 150ml - 결제금액 22,000원' })`);
  ok('옵션 배열 없는 오더 → none 모드', t.run('_prodMode()') === 'none');
  ok('옵션 배열 없는 오더 → 저장 옵션 0건(상품명 조각 승격 없음)', t.run('JSON.stringify(readOptRows())') === '[]');
  const rows = JSON.parse(t.run('JSON.stringify(_readProdRowsRaw())'));
  ok('쪼개진 조각은 상품명으로 되붙는다(값 유실 0)', rows.length === 1 && rows[0].productName === '우레온 모이스처 바디 리셋 미스트 150ml');

  // 편집 프리필: 옵션 원장이 비었으면 원문 분해 결과도 옵션이 아니다
  const t2 = makeTable();
  t2.run(`renderOptRowsWithProduct([], '우레온 모이스처 바디-리셋 미스트 - 결제금액 22,000원')`);
  ok('옵션 원장 빈 공고 편집 → none 모드 · 옵션 0건', t2.run('_prodMode()') === 'none' && t2.run('JSON.stringify(readOptRows())') === '[]');

  // ★ 결정 271 코드 리뷰 실측 — 원장 없이 상품 여러 줄로 저장된 공고: 카드가 둘이어도 손대지 않은 저장은 원장을 만들지 않는다
  const tm = makeTable();
  tm.run(`renderOptRowsWithProduct([], '상품A - 결제금액 10,000원\\n상품B - 결제금액 12,000원', { recruit_total: 30 })`);
  ok('원장 없는 여러 줄 공고 → 카드 2개 · none · 옵션 0건',
    tm.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp').length === 2 && tm.run('_prodMode()') === 'none' && tm.run('JSON.stringify(readOptRows())') === '[]');
  const tw = makeTable();
  tw.run(`applyProductRowsFromOrder({ wd_product: '상품A - 결제금액 10,000원\\n상품B - 결제금액 12,000원' })`);
  ok('구조화 옵션 없는 여러 줄 오더 → none · 옵션 0건', tw.run('_prodMode()') === 'none' && tw.run('JSON.stringify(readOptRows())') === '[]');
  tm.run('addOptRow()');
  ok('사람이 [+ 상품 추가]를 누르면 새 규칙(카드 여럿 = opt)', tm.run('_prodMode()') === 'opt');
  const tn = makeTable();
  tn.run(`renderOptRowsWithProduct([], '상품A - 결제금액 10,000원\\n상품B - 결제금액 12,000원', {})`);
  tn.run(`document.querySelectorAll('#rf_opt_rows .rf-gp')[1].querySelectorAll('.rf-gp-unit button').filter(x => x.dataset.unit === 'option')[0].onclick()`);
  ok('사람이 카드를 「옵션 있음」으로 바꾸면 opt', tn.run('_prodMode()') === 'opt');
  // ★ 2026-10-22 실측 — 옵션 없는 공고의 원문은 한 줄에 상품 하나다. 한 덩어리 줄이 앞 줄 상품명을 이어받아
  //   "린스" 가 "샴푸 린스" 가 되던 것(손대지 않은 저장 한 번에 둘째 상품부터 이름이 바뀜)
  const tl = makeTable();
  tl.run(`renderOptRowsWithProduct([], '샴푸 - 결제금액 10,000원\\n린스 - 결제금액 12,000원')`);
  const rl = JSON.parse(tl.run('JSON.stringify(_readProdRowsRaw())'));
  ok('옵션 없는 공고 여러 줄 — 상품명이 앞 줄 이름을 이어받지 않는다(샴푸 · 린스)', rl.map(r => r.productName).join(',') === '샴푸,린스' && rl[1].payAmount === 12000);
  // 같은 줄 조각은 종전대로 되붙는다(결정 042) · 작업오더 원문은 종전대로 오더 상품명을 이어받는다(옵션 글자 줄)
  const tl2 = makeTable();
  tl2.run(`renderOptRowsWithProduct([], '우레온 미스트 - 리필 - 결제금액 9,000원\\n샴푸 - 결제금액 10,000원')`);
  ok('같은 줄 조각은 되붙는다', JSON.parse(tl2.run('JSON.stringify(_readProdRowsRaw())')).map(r => r.productName).join(',') === '우레온 미스트 리필,샴푸');
  const to = makeTable();
  to.run(`applyProductRowsFromOrder({ product_name: '샴푸', wd_product: '블랙 - 결제금액 10,000원\\n화이트 - 결제금액 12,000원' })`);
  ok('작업오더 글자 옵션은 오더 상품명을 이어받는다(무회귀)', JSON.parse(to.run('JSON.stringify(_readProdRowsRaw())')).map(r => r.productName).join(',') === '샴푸 블랙,샴푸 화이트');

  // 옵션 배열이 오면 그대로 옵션 모드(무회귀)
  const t3 = makeTable();
  t3.run(`applyProductRowsFromOrder({ options: [{ optKey:'콰이어트', payAmount:31400, recruitTotal:20 }, { optKey:'어나더', payAmount:31400, recruitTotal:20 }] })`);
  const o3 = JSON.parse(t3.run('JSON.stringify(readOptRows())'));
  ok('옵션 배열 오더 → opt 모드 · 옵션 2건 · 옵션인원 프리필', t3.run('_prodMode()') === 'opt' && o3.length === 2 && o3[0].recruitTotal === 20);
}

/* ══════════════ E. 카드의 옵션 있음↔없음 · 확인창 ══════════════ */
console.log('\n[E] 카드 옵션 유무 전환 — 조용한 소실 금지');
{
  const rows2 = `[{ productName:'힙스', optKey:'콰이어트', payAmount:31400, recruitTotal:20, dailyLimit:10 },
                  { productName:'힙스', optKey:'어나더',  payAmount:31400, recruitTotal:20, dailyLimit:10 }]`;
  const t = makeTable({ confirm: false });
  t.run(`renderOptRows(${rows2})`);
  const noBtn = tb => tb.dom.byId.rf_opt_rows.querySelector('.rf-gp').querySelectorAll('.rf-gp-unit button').find(b => b.dataset.unit === 'product');
  noBtn(t).onclick();
  ok('확인창 거절 시 바뀌지 않는다(옵션 보존)', t.run('_prodMode()') === 'opt' && JSON.parse(t.run('JSON.stringify(readOptRows())')).length === 2);

  const t2 = makeTable({ confirm: true });
  t2.run(`renderOptRows(${rows2})`);
  noBtn(t2).onclick();
  const rows = JSON.parse(t2.run('JSON.stringify(_readProdRowsRaw())'));
  ok('옵션 있음 → 없음: 첫 줄만 남고 옵션명은 비운다(숨은 칸이 옵션으로 새지 않게)', rows.length === 1 && rows[0].productName === '힙스' && rows[0].optKey === '');
  ok('옵션 없는 상품 하나(원장 없는 새 공고) = 저장 옵션 0건(= 옵션 정리 신호)', t2.run('JSON.stringify(readOptRows())') === '[]');

  // 옵션이 하나뿐이면 확인창 없이 바뀐다(막을 값이 없다)
  const t3 = makeTable({ confirm: false });
  t3.run(`renderOptRows([{ productName:'상품A', optKey:'단품', payAmount:1000 }], { mode:'opt' })`);
  noBtn(t3).onclick();
  ok('옵션 하나 = 확인창 없이 전환', t3.dom.byId.rf_opt_rows.querySelector('.rf-gp').dataset.unit === 'product');
}

/* ══════════════ 화면 배선 ══════════════ */
console.log('\n[UI] 모달 배선');
ok('모달: 공고 전체 스위치 없음(결정 271) · 모드 hidden 생존 · 카드 표 표시', !/id="rf_prod_mode_sw"/.test(modalSrc)
  && !/setProdMode\(/.test(modalSrc) && /id="rf_prod_mode"[^>]*value="none"/.test(modalSrc) && /id="rf_opt_wrap" class="rf-cards"/.test(modalSrc));
ok('모달 CSS: 카드 — 옵션 없는 카드는 URL·옵션 칸 숨김', /\.rf-gp-noopt \.rf-opt-row \.rf-f-url,#recruitModal #rf_opt_wrap\.rf-cards \.rf-gp-noopt \.rf-opt-row \.rf-f-name\{display:none\}/.test(modalSrc));
ok('index-recruit: 모드 = 카드 구성(상품 둘 이상·옵션 있는 상품 = opt · 원장 살아 있던 공고 = opt · 마감만 = 세지 않음)',
  /function _prodMode\(\)\s*\{[\s\S]*?if \(live\.length > 1 && !\(window\._rfForcedNone && allProduct\)\) return "opt";[\s\S]*?if \(!allProduct\) return "opt";[\s\S]*?if \(window\._rfLiveLedger\) return "opt";/.test(recruitSrc));
ok('index-recruit: 사람이 누르는 공고 전체 모드 전환 함수가 없다(사본 판정 0)', !/function setProdMode\(/.test(recruitSrc) && !/function _convertProdRows\(/.test(recruitSrc));
ok('모달: 옵션표 저장 계약 필드 생존(rf_opt_rows·rf_wd_product·정원 hidden)', /id="rf_opt_rows"/.test(modalSrc)
  && /id="rf_wd_product"/.test(modalSrc) && /id="rf_recruit_total"/.test(modalSrc) && /id="rf_daily_limit"/.test(modalSrc));
ok('index-recruit: 모드 단일 출처(readOptRows·_readProdRows 가 _prodMode 를 본다)',
  /function readOptRows\(\)\s*\{[\s\S]{0,220}?if \(_prodMode\(\) !== "opt"\) return out;/.test(recruitSrc)
  && /function _readProdRows\(\)\s*\{[\s\S]{0,200}?const noOpt = _prodMode\(\) !== "opt";/.test(recruitSrc));

/* ══════════════ F. 인트라넷 옵션 구조 신호 ══════════════ */
console.log('\n[F] 인트라넷 → 리뷰웹 옵션 구조 신호');
if (!intranet) { skip('인트라넷 전송 페이로드(레포 없음)'); skip('인트라넷 구조 조립 함수(레포 없음)'); }
else {
  ok('인트라넷: 전송 페이로드에 product_options_json 동봉', /product_options_json:\s*reviewOrderOptionsPayload\(products\)/.test(intranet));
  ok('인트라넷: 구조 조립 — 옵션 라벨·금액·건수 + 시트참조 모드 제외', /function reviewOrderOptionsPayload\(/.test(intranet)
    && /label:\s*reviewOrderFormatOption\(option\)/.test(intranet) && /count:\s*Number\(option\.count\)\s*\|\|\s*0/.test(intranet)
    && /if \(reviewOrderIsSheetReferenceMode\(\)\) return undefined/.test(intranet));
  ok('인트라넷: 요약 문장(product_option)은 유지 — 사람 읽기·구버전 호환', /product_option:\s*reviewOrderProductSummary\(products\)/.test(intranet));
  // 구조 조립을 실제로 실행해 계약(옵션 없음 = 빈 배열)을 고정
  const sb = { console };
  sb.window = sb; vm.createContext(sb);
  sb.reviewOrderIsSheetReferenceMode = () => false;
  // ⚠ 134: reviewOrderOptionsPayload 가 유입방식 게이트를 부른다(가이드유입일 때만 선택지 가이드 동봉).
  //   스텁이 아니라 실물을 꺼내 쓴다 — 여기서만 다른 판정을 두면 옵션 구조 신호가 딴판이 된다.
  sb.document = { querySelector: sel => (/review-order-inflow-type/.test(sel) ? { value: '링크유입' } : null) };
  vm.runInContext(grab(intranet, 'reviewOrderChecked'), sb);
  vm.runInContext(grab(intranet, 'reviewOrderInflowTypeCode'), sb);
  vm.runInContext(grab(intranet, 'reviewOrderIsGuideInflow'), sb);
  vm.runInContext(grab(intranet, 'reviewOrderFormatOption'), sb);
  vm.runInContext(grab(intranet, 'reviewOrderOptionsPayload'), sb);
  sb._p = [{ name: '우레온', url: 'https://x', basePrice: 22000, baseCount: 5, options: [] }];
  const noOpt = JSON.parse(vm.runInContext('reviewOrderOptionsPayload(_p)', sb));
  ok('옵션 없는 상품 → options: [] (= "옵션 없음" 확정 신호)', noOpt.length === 1 && Array.isArray(noOpt[0].options) && noOpt[0].options.length === 0 && noOpt[0].base.count === 5);
  sb._p2 = [{ name: '힙스', basePrice: 0, baseCount: 0, options: [
    { optionType: 'single', option1Value: '콰이어트', price: 31400, count: 20 },
    { optionType: 'double', option1Value: '블랙', option2Value: '라지', price: 31400, count: 20 }] }];
  const withOpt = JSON.parse(vm.runInContext('reviewOrderOptionsPayload(_p2)', sb));
  ok('옵션 있는 상품 → 라벨·금액·건수 그대로(이중옵션은 한 라벨)', withOpt[0].options.length === 2
    && withOpt[0].options[0].label === '콰이어트' && withOpt[0].options[0].count === 20
    && withOpt[0].options[1].label === '블랙 + 라지');
}

// 리뷰웹 수신 — 옵션별 건수를 옵션 정원으로 프리필
{
  const sb = { console };
  sb.window = sb; vm.createContext(sb);
  // ⚠ _woOptionRows 가 새 전역을 부르면 이 목록도 함께 늘린다(스텁을 두면 규칙이 거기서만 딴판이 된다).
  //   134: 선택지 전용 유입가이드 정규화(_woUnitGuide) + 그 평문→HTML 변환 의존 3종.
  vm.runInContext(grabConst(wodSrc, '_WO_UNIT_GUIDE_IMG_MAX'), sb);
  ['_woCleanGuide', '_driveId', '_woPlainGuideToHtml', '_woUnitGuide', '_woProductUnitSrc', '_woOptionRows']
    .forEach(n => vm.runInContext(grab(wodSrc, n), sb));
  sb._o = { product_options_json: JSON.stringify([{ name: '힙스', base: { pay: 0 }, options: [
    { label: '콰이어트', pay: 31400, count: 20 }, { label: '어나더', pay: 31400, count: 25 }] }]) };
  const rows = vm.runInContext('_woOptionRows(_o)', sb);
  sb._oNew = { product_options_json: JSON.stringify([{ name: 'new single option', product_mode: 'opt', base: { pay: 0 }, options: [
    { label: 'white', url: 'https://store.example/item?option=white', pay: 31400, count: 20, daily_limit: 4 }] }]) };
  const explicitOptRows = vm.runInContext('_woOptionRows(_oNew)', sb);
  ok('new explicit option mode preserves a single option, its URL, and daily limit',
    explicitOptRows.length === 1 && explicitOptRows[0].optKey === 'white'
      && explicitOptRows[0].optionUrl === 'https://store.example/item?option=white'
      && explicitOptRows[0].dailyLimit === 4);
  ok('리뷰웹: 옵션별 건수 → 옵션 정원 프리필', rows.length === 2 && rows[0].recruitTotal === 20 && rows[1].recruitTotal === 25);
  sb._o2 = { product_options_json: JSON.stringify([{ name: '우레온', base: { pay: 22000, count: 5 }, options: [] }]) };
  ok('리뷰웹: 옵션 없는 구조 → 옵션행 0(종전 규칙 유지)', vm.runInContext('_woOptionRows(_o2)', sb).length === 0);
}


/* ══════════════ G. 134 복합 작업 — 저장된 상품명이 최우선 ══════════════ */
console.log('\n[G] 편집 프리필 — 상품 단위(unit_kind=product)의 상품명 보존');
{
  // 테섭 실측(2026-08-20): 상품A(옵션 2) + 상품B(옵션 없음) 공고를 수정 모달로 열면
  // 두 그룹 머리가 **둘 다 상품A 이름**으로 떠서, 그대로 저장하면 상품 단위의
  // product_name·opt_key 가 남의 상품명으로 덮인다(리뷰어 화면 상품 묶음 머리가 뒤바뀐다).
  const t = makeTable();
  t.run(`renderOptRowsWithProduct([
    { optKey:'옵션A (30일분)',        unitKind:'option',  productName:'하루한포 종합비타민', payAmount:19900, recruitTotal:6, dailyLimit:3, status:'active' },
    { optKey:'옵션B (대용량 90일분)', unitKind:'option',  productName:'하루한포 종합비타민', payAmount:34900, recruitTotal:4, dailyLimit:2, status:'active' },
    { optKey:'속편한 유산균',          unitKind:'product', productName:'속편한 유산균',       payAmount:24900, recruitTotal:5, dailyLimit:2, status:'active' }
  ], '하루한포 종합비타민 - 옵션A (30일분) - 결제금액 19,900원\\n하루한포 종합비타민 - 옵션B (대용량 90일분) - 결제금액 34,900원')`);
  const rows = JSON.parse(t.run('JSON.stringify(_readProdRowsRaw())'));
  ok('상품 단위 줄의 상품명이 첫 상품 이름으로 덮이지 않는다',
    rows.length === 3 && rows[2].productName === '속편한 유산균');
  ok('옵션 줄의 상품명은 종전대로 유지', rows[0].productName === '하루한포 종합비타민' && rows[1].productName === '하루한포 종합비타민');
  ok('저장 페이로드도 같은 상품명(리뷰어 화면 상품 묶음 머리)',
    (JSON.parse(t.run('JSON.stringify(readOptRows())')).find(o => o.optKey === '속편한 유산균') || {}).productName === '속편한 유산균');

  // ★ 상품 단위는 opt_key 가 곧 상품명 — 저장된 productName 이 비어도 첫 상품으로 접지 않는다
  const t2 = makeTable();
  t2.run(`renderOptRowsWithProduct([
    { optKey:'옵션A', unitKind:'option',  productName:'상품A', status:'active' },
    { optKey:'상품B', unitKind:'product', status:'active' }
  ], '상품A - 옵션A - 결제금액 10,000원')`);
  const r2 = JSON.parse(t2.run('JSON.stringify(_readProdRowsRaw())'));
  ok('상품명 미저장 상품 단위 → opt_key(=상품명) 폴백', r2[1].productName === '상품B');

  // 무회귀: 옵션 단위인데 저장 상품명이 없으면 종전대로 원문 매칭 → 첫 상품 폴백
  const t3 = makeTable();
  t3.run(`renderOptRowsWithProduct([
    { optKey:'콰이어트', status:'active' },
    { optKey:'어나더',   status:'active' }
  ], '힙스 - 콰이어트 - 결제금액 31,400원\\n힙스 - 어나더 - 결제금액 31,400원')`);
  const r3 = JSON.parse(t3.run('JSON.stringify(_readProdRowsRaw())'));
  ok('옵션 단위 무저장: 원문에서 상품명을 찾아 채운다(무회귀)', r3[0].productName === '힙스' && r3[1].productName === '힙스');
}

console.log(`\n✅ campaignProdModeSplit: ${passed}개 통과${skipped ? ` (${skipped}개 skip)` : ''}`);
