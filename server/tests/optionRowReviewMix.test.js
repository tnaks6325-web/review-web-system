/**
 * optionRowReviewMix.test.js — 선택지별 리뷰 조합 접이줄 회귀가드 (2026-08-25)
 * 실행: node tests/optionRowReviewMix.test.js
 *
 * 실사고: 옵션 없는 상품 3개짜리 오더(진간장 500/200/50)에서
 *   · 화면은 `_reviewMixRows` 가 **옵션명 칸이 채워진 행**만 세어 전역 「전체 모집」 카드 한 장만 그리고
 *   · 저장은 `readOptRows` 가 **상품명을 optKey 로** 삼아 옵션 3건을 보내
 *   · 서버 `validateOptionReviewTypeMix` 가 옵션마다 조합을 요구해 영구히 거부됐다.
 *   선택지별로 넣을 칸이 화면에 **없어서 고칠 방법도 없는** 막다른 길이었다.
 *
 * 고정하는 것:
 *  A. 선택 단위 목록 단일 출처 — `readOptRows` 와 조합 입력이 **같은 `_optUnitEntries`** 를 본다
 *     (실사고 재현: 옵션 없는 상품 3개 → 접이줄 3개 · 저장 optKey 3개와 1:1)
 *  B. 판정 사본 0 — 접이줄·균형바·저장 검증이 `_mixVerdict` 하나를 본다
 *  C. 노출 규칙 — 혼합 + 옵션 원장 모드(opt)일 때만. 그 밖에는 전역 카드가 담당한다
 *  D. 입력 중 패널을 다시 그리지 않는다(입력칸 DOM 동일성 — 한글 조합 보호)
 *  E. 자동 배분은 제안까지 — 합계 = 그 줄 인원, 기준 조합이 없으면 무동작
 *  F. 마감(closed) 선택지는 조합 대상이 아니다(서버 skip 과 같은 기준)
 *  G. 화면 계약(CSS) — 접이줄/패널 선언과 `rf-mx-on` 게이트
 *
 * ★ 정적 grep 이 아니라 **함수를 vm 으로 꺼내 가짜 DOM 위에서 실제 실행**한다 —
 *   "화면과 저장이 같은 선택지를 보는가"는 문자열 검사로는 볼 수 없다(그게 이 사고였다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const recruitSrc = read('frontend/js/index-recruit.js');
const modalSrc = read('frontend/js/recruit-modal.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

/** 소스에서 함수 하나를 통째로 꺼낸다(중괄호 균형) */
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert(i >= 0, '함수 없음: ' + name);
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

/* ══════════════ 가짜 DOM (후손 선택자 + id 파싱 + getElementById 트리 탐색) ══════════════ */
function makeDom() {
  function parseHtml(html) {
    const out = [];
    const re = /<(input|button|span|div|textarea)\b([^>]*)>/g;
    let m;
    while ((m = re.exec(html))) {
      const node = mk(m[1]);
      const cls = /class="([^"]*)"/.exec(m[2]);
      if (cls) cls[1].trim().split(/\s+/).forEach(c => c && node.classList.add(c));
      const id = /id="([^"]*)"/.exec(m[2]);
      if (id) node.id = id[1];
      const ph = /placeholder="([^"]*)"/.exec(m[2]);
      if (ph) node.placeholder = ph[1];
      out.push(node);
    }
    return out;
  }
  function matches(node, simple) {
    if (simple[0] === '#') return node.id === simple.slice(1);
    if (simple[0] === '.') return node.classList.contains(simple.slice(1));
    /* [data-mx-type="photo"] — 조합 입력칸을 이 셀렉터로 찾으므로 가짜 DOM 도 지원해야 한다 */
    const at = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(simple);
    if (at) {
      const key = at[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return String(node.dataset[key] == null ? '' : node.dataset[key]) === at[2];
    }
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
      append(...cs) { cs.forEach(c => node.appendChild(c)); },
      remove() { if (node.parent) node.parent.children = node.parent.children.filter(x => x !== node); },
      closest(sel) {
        let n = node;
        while (n) { if (matches(n, sel.trim())) return n; n = n.parent; }
        return null;
      },
      addEventListener(ev, fn) { (node._li = node._li || {}); (node._li[ev] = node._li[ev] || []).push(fn); },
      fire(ev) { ((node._li || {})[ev] || []).forEach(f => f()); },
      querySelector(sel) { return queryAll(node, sel)[0] || null; },
      querySelectorAll(sel) { return queryAll(node, sel); },
    };
    return node;
  }
  const root = mk('body');
  const byId = {};
  function add(id, tag) { const n = mk(tag || 'div'); n.id = id; byId[id] = n; root.appendChild(n); return n; }
  function findById(id) {
    if (byId[id] && byId[id].parent) return byId[id];
    let hit = null;
    walk(root, n => { if (!hit && n.id === id) hit = n; });
    return hit || byId[id] || null;
  }
  return {
    root, mk, add, byId,
    document: {
      getElementById: findById,
      createElement: tag => mk(tag),
      querySelectorAll: sel => queryAll(root, sel),
      querySelector: sel => queryAll(root, sel)[0] || null,
      body: root,
    },
  };
}

/* ══════════════ 표 하나를 세우고 실제 함수를 돌린다 ══════════════ */
function stand(rows, opts) {
  const o = opts || {};
  const dom = makeDom();
  const wrap = dom.add('rf_opt_wrap');
  wrap.classList.add('rf-pm-opt');
  const rowsBox = dom.mk('div'); rowsBox.id = 'rf_opt_rows'; wrap.appendChild(rowsBox);
  dom.byId.rf_opt_rows = rowsBox;
  const mode = dom.add('rf_prod_mode', 'input'); mode.value = o.mode || 'opt';
  const rt = dom.add('rf_review_type', 'input'); rt.value = o.reviewType || 'mixed';
  dom.add('rf_recruit_total', 'input').value = '750';

  const sandbox = {
    console, document: dom.document, showToast: () => {},
    _ugCompose: () => ({ html: '', images: [] }),
    syncRecruitReviewTypeMix: () => [],
    _mixQuantity: null,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ['RF_REVIEW_MIX_TYPES', 'RF_MIX_LABEL'].forEach(c => vm.runInContext(grabConst(recruitSrc, c), sandbox));
  ['_prodMode', '_rfGroupUnit', '_rfRowProductName', '_optUnitEntries', 'readOptRows',
   '_readOptionReviewMix', '_writeOptionReviewMix', '_mixQuantity', '_mixVerdict',
   '_reviewMixRows', '_reviewMixKey', 'getRecruitOptionReviewTypeMix', '_isOptionReviewMix',
   '_mxBuild', '_mxAuto', '_mxMark', '_mxMarkAll', 'validateRecruitReviewTypeMix',
  ].forEach(fn => vm.runInContext(grab(recruitSrc, fn), sandbox));

  /* 표를 손으로 세운다 — `_buildOptRowEl` 은 유입가이드 위젯까지 끌고 오므로 여기서는
     그 함수가 만드는 것과 **같은 모양**(.rf-gp > .rf-unit > .rf-opt-row + 접이줄 + 패널)만 만든다. */
  rows.forEach((r) => {
    const gp = dom.mk('div'); gp.classList.add('rf-gp');
    gp.dataset.unit = r.unit || (r.opt === undefined ? 'product' : 'option');
    const gn = dom.mk('input'); gn.classList.add('rf-gp-name'); gn.value = r.product || '';
    gp.appendChild(gn);
    (r.rows || (r.opt === undefined ? [r] : [].concat(r.opt))).forEach((u) => {
      const unit = dom.mk('div'); unit.classList.add('rf-unit');
      const row = dom.mk('div'); row.classList.add('rf-opt-row');
      if (u.closed) row.dataset.status = 'closed';
      const nm = dom.mk('input'); nm.classList.add('rf-opt-name'); nm.value = (u.name || '');
      const pay = dom.mk('input'); pay.classList.add('rf-opt-pay'); pay.value = '1000';
      const q = dom.mk('input'); q.classList.add('rf-opt-rt'); q.value = String(u.quota != null ? u.quota : r.quota || 0);
      const dl = dom.mk('input'); dl.classList.add('rf-opt-dl'); dl.value = '1';
      const url = dom.mk('input'); url.classList.add('rf-opt-url'); url.value = '';
      [nm, pay, q, dl, url].forEach(x => row.appendChild(x));
      unit.appendChild(row);
      const cta = dom.mk('button'); cta.classList.add('rf-mx-cta');
      const st = dom.mk('span'); st.classList.add('rf-ug-cta-st'); cta.appendChild(st);
      unit.appendChild(cta);
      unit.appendChild(vm.runInContext('_mxBuild', sandbox)(row));
      gp.appendChild(unit);
    });
    rowsBox.appendChild(gp);
  });
  const run = (code) => vm.runInContext(code, sandbox);
  run('_mxMarkAll()');
  return { dom, sandbox, run, rowsBox };
}

/* ══════════════ A. 선택 단위 단일 출처 — 실사고 재현 ══════════════ */
console.log('[A] 옵션 없는 상품 3개 — 화면과 저장이 같은 선택지를 본다');
{
  const t = stand([
    { product: '풍성한 진간장 F 13L x 1통', quota: 500 },
    { product: '풍성한 진간장 13L x 1통', quota: 200 },
    { product: '풍성한 진간장 S 13L x 1통', quota: 50 },
  ]);
  const keys = t.run('_optUnitEntries({activeOnly:true}).map(e=>e.optKey)');
  ok('선택지 3개를 인식한다(옵션명이 비어 있어도)', keys.length === 3);
  ok('키가 곧 상품명이다', keys[0] === '풍성한 진간장 F 13L x 1통');
  ok('조합을 받을 줄도 3개', t.run('_reviewMixRows().length') === 3);
  const save = t.run('JSON.stringify(readOptRows().map(o=>o.optKey))');
  ok('저장 optKey 와 1:1 로 일치', save === JSON.stringify(keys));
  ok('접이줄이 줄마다 있다', t.rowsBox.querySelectorAll('.rf-mx-cta').length === 3);
  ok('접이줄이 미입력을 말한다', /미입력/.test(t.rowsBox.querySelectorAll('.rf-mx-cta .rf-ug-cta-st')[0].textContent));
  ok('저장 검증이 그 선택지를 지목한다',
    /풍성한 진간장 F 13L x 1통/.test(t.run('validateRecruitReviewTypeMix()')));
}

/* ══════════════ B. 판정 사본 0 ══════════════ */
console.log('[B] 접이줄·균형바·저장 검증이 같은 판정을 본다');
{
  ok('저장 검증이 _mixVerdict 를 쓴다', /_mixVerdict\(option\.optKey/.test(recruitSrc));
  ok('접이줄 표시도 _mixVerdict 를 쓴다', /const v = _mixVerdict\(_reviewMixKey\(row\)/.test(recruitSrc));
  ok('옛 인라인 판정이 남아 있지 않다',
    !/두 가지 이상 리뷰방식을 입력해주세요\.`;\s*\n\s*if \(option\.recruitTotal/.test(recruitSrc));

  const t = stand([{ product: 'A', quota: 10 }]);
  const row = t.rowsBox.querySelectorAll('.rf-opt-row')[0];
  t.sandbox._writeOptionReviewMix(row, [{ type: 'photo', quantity: 10 }]);
  t.run('_mxMarkAll()');
  const st = t.rowsBox.querySelector('.rf-mx-cta .rf-ug-cta-st').textContent;
  ok('한 유형만이면 접이줄이 막는다고 말한다', /두 가지 이상/.test(st));
  ok('저장 검증도 같은 이유로 막는다', /두 가지 이상/.test(t.run('validateRecruitReviewTypeMix()')));

  t.sandbox._writeOptionReviewMix(row, [{ type: 'photo', quantity: 6 }, { type: 'text', quantity: 3 }]);
  t.run('_mxMarkAll()');
  ok('부족분을 숫자로 말한다', /1명 부족/.test(t.rowsBox.querySelector('.rf-mx-cta .rf-ug-cta-st').textContent));
  ok('저장도 막힌다', t.run('validateRecruitReviewTypeMix()') !== '');

  t.sandbox._writeOptionReviewMix(row, [{ type: 'photo', quantity: 7 }, { type: 'text', quantity: 3 }]);
  t.run('_mxMarkAll()');
  ok('맞으면 접이줄이 초록으로 바뀐다', t.rowsBox.querySelector('.rf-mx-cta').classList.contains('ok'));
  ok('맞으면 저장이 열린다', t.run('validateRecruitReviewTypeMix()') === '');
}

/* ══════════════ C. 노출 규칙 ══════════════ */
console.log('[C] 혼합 + 옵션 원장 모드일 때만 접이줄을 쓴다');
{
  ok('혼합+opt 는 선택지별', stand([{ product: 'A', quota: 5 }]).run('_isOptionReviewMix()') === true);
  ok('none 모드는 선택지별이 아니다(전역 카드가 담당)',
    stand([{ product: 'A', quota: 5 }], { mode: 'none' }).run('_isOptionReviewMix()') === false);
  ok('노출 판정은 JS 가 한다(rf-mx-on)', /optWrap\.classList\.toggle\('rf-mx-on', rowMode\)/.test(recruitSrc));
  ok('행별로 받는 동안 전역 카드를 그리지 않는다', /if \(visible && !rowMode\) \{ renderRecruitOptionReviewMix\(\)/.test(recruitSrc));
  ok('혼합이 아니면 접이줄이 꺼진다', /const rowMode = visible && _isOptionReviewMix\(\)/.test(recruitSrc));
}

/* ══════════════ D. 입력 중 패널 재렌더 금지 ══════════════ */
console.log('[D] 숫자를 고쳐도 입력칸 DOM 을 다시 만들지 않는다(한글 조합 보호)');
{
  const t = stand([{ product: 'A', quota: 10 }]);
  const before = t.rowsBox.querySelectorAll('.rf-mx input');
  const photo = t.rowsBox.querySelector('.rf-mx').querySelectorAll('input')[0];
  photo.value = '4'; photo.fire('input');
  const after = t.rowsBox.querySelectorAll('.rf-mx input');
  ok('입력칸이 그대로다(같은 객체)', before[0] === after[0] && before.length === after.length);
  ok('값이 원장에 실린다', t.sandbox._mixQuantity(t.sandbox._readOptionReviewMix(t.rowsBox.querySelector('.rf-opt-row')), 'photo') === 4);
  ok('패널을 다시 그리지 않는다는 근거가 코드에 남아 있다', /패널을 다시 그리지 않는다/.test(recruitSrc));
}

/* ══════════════ E. 자동 배분 ══════════════ */
console.log('[E] 자동 배분은 제안까지 — 합계는 그 줄 인원과 정확히 맞는다');
{
  const t = stand([{ product: 'A', quota: 500 }]);
  t.sandbox.window._rfOrderReviewTypeMix = [{ type: 'photo', quantity: 500 }, { type: 'text', quantity: 200 }, { type: 'star', quantity: 50 }];
  const row = t.rowsBox.querySelector('.rf-opt-row');
  t.sandbox._mxAuto(row);
  const mix = t.sandbox._readOptionReviewMix(row);
  const sum = mix.reduce((a, m) => a + m.quantity, 0);
  ok('합계 = 인원', sum === 500);
  ok('두 유형 이상', mix.filter(m => m.quantity > 0).length >= 2);
  ok('저장이 열린다', t.run('validateRecruitReviewTypeMix()') === '');

  const t2 = stand([{ product: 'A', quota: 500 }]);
  t2.sandbox.window._rfOrderReviewTypeMix = [];
  t2.sandbox.window._rfGlobalReviewTypeMix = [];
  t2.sandbox._mxAuto(t2.rowsBox.querySelector('.rf-opt-row'));
  ok('기준 조합이 없으면 아무것도 채우지 않는다',
    t2.sandbox._readOptionReviewMix(t2.rowsBox.querySelector('.rf-opt-row')).length === 0);

  const t3 = stand([{ product: 'A', quota: 0 }]);
  t3.sandbox.window._rfOrderReviewTypeMix = [{ type: 'photo', quantity: 1 }, { type: 'text', quantity: 1 }];
  t3.sandbox._mxAuto(t3.rowsBox.querySelector('.rf-opt-row'));
  ok('인원이 없으면 지어내지 않는다',
    t3.sandbox._readOptionReviewMix(t3.rowsBox.querySelector('.rf-opt-row')).length === 0);
}

/* ══════════════ F. 마감 선택지 ══════════════ */
console.log('[F] 마감 선택지는 조합 대상이 아니다(서버 skip 과 같은 기준)');
{
  const t = stand([
    { product: 'P', opt: [{ name: '살아있음', quota: 10 }, { name: '마감', quota: 10, closed: true }] },
  ]);
  ok('활성 선택지만 조합을 받는다', t.run('_reviewMixRows().length') === 1);
  ok('저장에는 마감분도 실린다(상태 보존)', t.run('readOptRows().length') === 2);
  /* ★ 순서를 **동작으로** 고정한다 — 소스 문자열 순서만 보면 앞에 한 줄을 더 끼워 넣는
     변이를 놓친다(변이시험 실측). 상품 그룹의 **첫 줄이 마감**이면 그 상품은 조합 대상이
     아니어야 한다(저장이 내보내는 대표 줄이 마감이므로 서버도 그 옵션을 건너뛴다).
     중복 제거가 뒤로 밀리면 둘째 줄이 대신 뽑혀 "화면엔 칸이 있는데 서버는 안 보는" 상태가 된다. */
  const t2 = stand([{ product: 'P', unit: 'product', rows: [{ quota: 10, closed: true }, { quota: 10 }] }]);
  ok('첫 줄이 마감인 상품은 조합 대상이 아니다', t2.run('_reviewMixRows().length') === 0);
  ok('저장은 그 상품을 마감 상태로 한 건만 내보낸다',
    t2.run('readOptRows().length') === 1 && t2.run('readOptRows()[0].status') === 'closed');
}

/* ══════════════ G. 화면 계약 ══════════════ */
console.log('[G] CSS 계약');
{
  ok('접이줄 선언이 있다', /\.rf-unit>\.rf-mx-cta\{display:none/.test(modalSrc));
  ok('rf-mx-on 일 때만 보인다', /\.rf-mx-on \.rf-unit>\.rf-mx-cta\{display:flex\}/.test(modalSrc));
  ok('패널은 mx-on 일 때만 펼쳐진다', /\.rf-mx-on \.rf-unit\.mx-on>\.rf-mx\{display:block/.test(modalSrc));
  ok('상태색 3종이 있다', /\.rf-mx-bal\.ok\{/.test(modalSrc) && /\.rf-mx-bal\.ng\{/.test(modalSrc) && /\.rf-mx-bal\.warn\{/.test(modalSrc));
  ok('유입가이드 줄과 같은 아이콘/글자 클래스를 쓴다', /rf-ug-cta-ic">🧩/.test(recruitSrc) && /rf-ug-cta-tx">이 옵션 리뷰 조합/.test(recruitSrc));
  ok('vm 추출 가드를 위한 typeof 가드가 있다', /if \(typeof _mxBuild === "function"\)/.test(recruitSrc));
}

console.log('\noptionRowReviewMix: ' + passed + ' passed');
process.exit(0);
