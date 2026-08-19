/**
 * recruitReviewMixRenderCache.test.js — 혼합 리뷰 조합 카드의 렌더 캐시 회귀가드
 * 실행: node tests/recruitReviewMixRenderCache.test.js
 *
 * 배경(2026-08-19 실측 신고):
 *   모집공고 수정에서 ① 카드가 "합계 0명 / 총모집인원 500명"처럼 **총인원과 다른 기준**을 말하고
 *   ② 총인원에 맞춰 저장해도 다시 열면 저장한 수량이 안 보였다.
 *   원인은 하나 — `renderRecruitOptionReviewMix` 의 전역 지문이 상수 `'global'` 이라
 *   모달 DOM(페이지당 1회 마운트·재사용)이 **다시 그려지지 않고 early-return** 했다.
 *   → 기준값(dataset.expected)이 이전 공고 값에 고착되고, 프리필한 수량은 화면에 못 들어갔다.
 *
 * 고정하는 것:
 *   A. 다른 공고를 이어서 열면 저장된 수량·기준이 그대로 보인다(캐시 무효화)
 *   B. 기준 인원의 단일 출처 = `_reviewMixExpectedFor` — 총인원이 바뀌면 카드도 따라온다
 *   C. 카드 라벨과 저장 검증(validateRecruitReviewTypeMix)이 같은 기준을 말한다
 *   D. 프리필된 수량이 저장 페이로드(getRecruitReviewTypeMix)에 그대로 실린다
 *   E. 배선 — 모달 초기화가 렌더 캐시를 비우고, 상수 'global' 지문이 되살아나지 않는다
 *
 * ★ 정적 grep 으로는 못 잡는다(문자열은 그대로 있고 "다시 그리는가"가 문제) →
 *   함수를 vm 으로 꺼내 가짜 DOM 위에서 실제 실행한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-recruit.js'), 'utf8');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

/** 소스에서 함수/상수 선언 하나를 통째로 꺼낸다(중괄호 균형) */
function grab(s, name) {
  let i = s.indexOf(`function ${name}(`);
  assert(i >= 0, `함수 없음: ${name}`);
  let depth = 0;
  for (let k = s.indexOf('{', i); k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') { depth--; if (!depth) return s.slice(i, k + 1); }
  }
  throw new Error('중괄호 불균형: ' + name);
}

/* ══════════════ 가짜 DOM (후손 선택자 + [data-*] 속성 선택자) ══════════════ */
function camel(attr) { return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function makeDom() {
  const byId = {};
  function matches(node, simple) {
    if (simple[0] === '#') return node.id === simple.slice(1);
    if (simple[0] === '.') return node.classList.contains(simple.slice(1));
    if (simple[0] === '[') {
      const body = simple.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq < 0) return node.dataset[camel(body)] !== undefined;
      const key = camel(body.slice(0, eq));
      const val = body.slice(eq + 1).replace(/^["']|["']$/g, '');
      return String(node.dataset[key]) === val;
    }
    return node.tag === simple;
  }
  function walk(node, fn) { node.children.forEach(c => { fn(c); walk(c, fn); }); }
  function queryAll(rootNode, sel) {
    const parts = String(sel).trim().split(/\s+/);
    let level = [rootNode];
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
      type: '', min: '', inputMode: '', hidden: false, _cls: [], _text: '', _html: '',
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
      set innerHTML(v) { node._html = String(v); if (!v) node.children = []; },
      get innerHTML() { return node._html; },
      append(...kids) { kids.forEach(k => node.appendChild(k)); },
      appendChild(c) { c.parent = node; node.children.push(c); return c; },
      remove() { if (node.parent) node.parent.children = node.parent.children.filter(x => x !== node); },
      addEventListener() {},
      querySelector(sel) { return queryAll(node, sel)[0] || null; },
      querySelectorAll(sel) { return queryAll(node, sel); },
    };
    return node;
  }
  const body = mk('body');
  function add(id, tag) { const n = mk(tag || 'div'); n.id = id; byId[id] = n; body.appendChild(n); return n; }
  return {
    body, mk, add, byId,
    document: {
      getElementById: id => byId[id] || null,
      createElement: tag => mk(tag),
      querySelectorAll: sel => queryAll(body, sel),
      querySelector: sel => queryAll(body, sel)[0] || null,
      body,
    },
  };
}

/** 혼합 조합 화면 하나를 세운다 — index-recruit 의 실제 함수를 그대로 실행한다 */
function makeMixScreen() {
  const dom = makeDom();
  dom.add('rf_review_mix');
  const composer = dom.add('rf_mixed_review_composer');
  composer.hidden = true;
  dom.byId.rf_review_mix.appendChild(dom.add('rf_review_mix_rows'));
  dom.add('rf_review_mix_total', 'span');
  dom.add('rf_review_type', 'input');
  dom.add('rf_recruit_total', 'input');
  dom.add('rf_opt_rows');
  const mode = dom.add('rf_prod_mode', 'input'); mode.value = 'none';

  const sandbox = { console, document: dom.document, syncRecruitAutomaticBadges: () => {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src.slice(src.indexOf('const RF_REVIEW_MIX_TYPES'), src.indexOf('\n', src.indexOf('const RF_REVIEW_MIX_TYPES'))), sandbox);
  [
    '_prodMode', '_setRecruitGlobalReviewTypeMix', '_reviewMixRows', '_readOptionReviewMix',
    '_writeOptionReviewMix', 'getRecruitOptionReviewTypeMix', '_isOptionReviewMix', '_mixQuantity',
    '_reviewMixTotalLabel', '_reviewMixExpectedFor', 'resetRecruitReviewMixRender',
    'renderRecruitOptionReviewMix', 'getRecruitReviewTypeMix', 'syncRecruitReviewTypeMix',
    'validateRecruitReviewTypeMix',
  ].forEach(fn => vm.runInContext(grab(src, fn), sandbox));

  const api = {
    dom, sandbox,
    run: code => vm.runInContext(code, sandbox),
    /** 모달을 "그 공고로 여는" 흐름 재현: 초기화 → 프리필 → [혼합] 선택 → 렌더 */
    open({ recruitTotal, mix, reset = true }) {
      if (reset) {
        sandbox.window._rfGlobalReviewTypeMix = [];
        vm.runInContext('resetRecruitReviewMixRender()', sandbox);
      }
      dom.byId.rf_recruit_total.value = String(recruitTotal);
      sandbox._mix = mix;
      vm.runInContext('_setRecruitGlobalReviewTypeMix(_mix)', sandbox);
      dom.byId.rf_review_type.value = 'mixed';
      return vm.runInContext('syncRecruitReviewTypeMix()', sandbox);
    },
    card() { return dom.byId.rf_review_mix_rows.querySelectorAll('[data-rf-review-mix-card]')[0]; },
    label() { return api.card().querySelectorAll('.mixed-review-total')[0].textContent; },
    inputs() {
      const out = {};
      api.card().querySelectorAll('[data-mix-type]').forEach(i => { out[i.dataset.mixType] = Number(i.value) || 0; });
      return out;
    },
    invalid() { return api.card().querySelectorAll('.mixed-review-total')[0].classList.contains('is-invalid'); },
  };
  return api;
}

/* ══════════════ A. 공고를 이어서 열면 저장값이 보인다 ══════════════ */
console.log('\n[A] 다른 공고를 이어서 열기 — 렌더 캐시 무효화');
{
  const s = makeMixScreen();
  s.open({ recruitTotal: 500, mix: [{ type: 'photo', quantity: 300 }, { type: 'text', quantity: 200 }] });
  ok('첫 공고: 저장된 수량이 그대로 보인다', s.inputs().photo === 300 && s.inputs().text === 200);
  ok('첫 공고: 기준은 그 공고의 총모집인원', s.label() === '합계 500명 / 총모집인원 500명' && !s.invalid());

  // 같은 페이지에서 다른 공고를 연다(모달 DOM 은 재사용된다)
  s.open({ recruitTotal: 300, mix: [{ type: 'photo', quantity: 100 }, { type: 'confirm', quantity: 200 }] });
  ok('두 번째 공고: 이전 공고 수량이 남지 않는다', s.inputs().photo === 100 && s.inputs().text === 0);
  ok('두 번째 공고: 저장된 수량이 보인다(합계 0명 재발 없음)', s.inputs().confirm === 200);
  ok('두 번째 공고: 기준이 500 에 고착되지 않는다', s.label() === '합계 300명 / 총모집인원 300명' && !s.invalid());
}

/* ══════════════ B. 기준 인원 단일 출처 ══════════════ */
console.log('\n[B] 총인원이 바뀌면 카드 기준도 따라온다');
{
  const s = makeMixScreen();
  s.open({ recruitTotal: 300, mix: [{ type: 'photo', quantity: 200 }, { type: 'text', quantity: 100 }] });
  s.dom.byId.rf_recruit_total.value = '500';           // 표에서 총인원이 바뀐 상황(신규 발행)
  s.run('syncRecruitReviewTypeMix()');
  ok('기준이 새 총인원을 말한다', s.label() === '합계 300명 / 총모집인원 500명');
  ok('불일치 표시(is-invalid)가 켜진다', s.invalid());
  ok('수량은 유지된다(입력값 소실 없음)', s.inputs().photo === 200 && s.inputs().text === 100);
}

/* ══════════════ C. 카드 라벨 ≡ 저장 검증 기준 ══════════════ */
console.log('\n[C] 화면과 저장 검증이 같은 기준을 말한다');
{
  const s = makeMixScreen();
  s.open({ recruitTotal: 300, mix: [{ type: 'photo', quantity: 250 }, { type: 'text', quantity: 250 }] });
  const err = s.run('validateRecruitReviewTypeMix()');
  ok('검증 메시지의 총인원 = 카드가 말한 총인원', /총인원\(300명\)/.test(err) && /총모집인원 300명/.test(s.label()));

  s.open({ recruitTotal: 300, mix: [{ type: 'photo', quantity: 150 }, { type: 'text', quantity: 150 }] });
  ok('합계가 맞으면 저장이 통과한다', s.run('validateRecruitReviewTypeMix()') === '' && !s.invalid());
}

/* ══════════════ D. 프리필 → 저장 페이로드 ══════════════ */
console.log('\n[D] 프리필한 수량이 저장 페이로드에 실린다');
{
  const s = makeMixScreen();
  s.open({ recruitTotal: 300, mix: [{ type: 'photo', quantity: 120 }, { type: 'star', quantity: 180 }] });
  const payload = s.run('getRecruitReviewTypeMix()');
  ok('payload 가 저장값 그대로(빈 배열로 지워지지 않는다)',
    JSON.stringify(payload) === JSON.stringify([{ type: 'photo', quantity: 120 }, { type: 'star', quantity: 180 }]));
}

/* ══════════════ E. 배선 ══════════════ */
console.log('\n[E] 배선 — 초기화가 캐시를 비우고 상수 지문이 되살아나지 않는다');
{
  ok('모달 초기화가 렌더 캐시를 비운다',
    /window\._rfGlobalReviewTypeMix = \[\];[\s\S]{0,400}?resetRecruitReviewMixRender\(\);/.test(src));
  ok('전역 지문에 기준 인원이 들어간다', /`global:\$\{_reviewMixExpectedFor\(/.test(src));
  ok("상수 'global' 지문이 되살아나지 않는다", !/:\s*'global';/.test(src));
  ok('early-return 경로도 기준을 다시 읽는다(dataset.expected 고착 금지)',
    /const expected = _reviewMixExpectedFor\(rows, optionMode, Number\(box\.dataset\.rfReviewMixCard\)\);/.test(src));
  ok('모달 초기화가 리뷰타입 hidden 값도 되돌린다', /_rfPickBtn\("review_type", ""\);/.test(src));
}

console.log(`\nrecruitReviewMixRenderCache: ${passed} checks passed`);
