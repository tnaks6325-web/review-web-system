/**
 * campaignProdModeSplit.test.js — 진행상품 입력 2모드 분리 회귀가드 (2026-08-07 우레온 건)
 * 실행: node tests/campaignProdModeSplit.test.js
 *
 * 고정하는 것(사고 재발 차단):
 *  A. `_woProductLines` — 인트라넷 "옵션 없는 줄"의 결제금액이 옵션명으로 읽히지 않는다
 *     (실측 오염 문장 `상품명 결제금액 22,000원 - 결제금액 22,000원` 재발 차단)
 *  B. 모드가 옵션 유무의 **단일 출처** — 'none' 이면 숨은 칸에 값이 남아 있어도
 *     `readOptRows()` 는 빈 배열, `rf_wd_product` 원문에도 옵션명이 안 샌다
 *  C. 자동 판정 = 살아있는 옵션 유무(서버 `liveOptions` 와 같은 기준) + 사람 전환 자유
 *  D. 옵션 원장이 빈 공고/오더는 텍스트 분해가 쪼갠 조각을 **옵션으로 승격시키지 않는다**
 *  E. 모드 전환 시 값 이월 + 옵션을 없애는 방향은 확인창(조용한 값 소실 금지)
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
    // 이 화면이 만드는 마크업은 전부 `<tag class="..." ...>` 한 겹이라 정규식으로 충분하다
    const out = [];
    const re = /<(input|button|span|div|textarea)\b([^>]*)>/g;
    let m;
    while ((m = re.exec(html))) {
      const node = mk(m[1]);
      const cls = /class="([^"]*)"/.exec(m[2]);
      if (cls) cls[1].trim().split(/\s+/).forEach(c => c && node.classList.add(c));
      const ph = /placeholder="([^"]*)"/.exec(m[2]);
      if (ph) node.placeholder = ph[1];
      out.push(node);
    }
    return out;
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
  const sw = dom.add('rf_prod_mode_sw');
  ['none', 'opt'].forEach(m => { const b = dom.mk('button'); b.classList.add('rf-pm-btn'); b.dataset.mode = m; sw.appendChild(b); });
  dom.add('rf_opt_addbtn', 'button');

  const sandbox = {
    console, document: dom.document,
    confirm: () => (opts && opts.confirm !== undefined) ? opts.confirm : true,
    renderPartCheck: () => {},
    _renderPreview: () => {},
    syncRecruitProductMainUrl: () => {},
    showToast: () => {},
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
    '_htmlToPlainPreview', '_igSetList', '_igSplitInflow', '_rfHttpUrl', '_rfGroupUnit', '_rfRowProductName',
    '_ugNewKey', '_ugRegister', '_ugDrop', '_ugDropAll', '_ugDropBox', '_ugBuild', '_ugLoad', '_ugCompose', '_ugMark', '_ugAttachAll',
    '_prodMode', '_applyProdModeUi', '_setProdModeNote', '_renderProdModeHelp', 'setProdMode', '_convertProdRows',
    '_renderProdTable', '_buildProdGroup', '_syncGroupTotals', 'addOptRow', '_buildOptRowEl',
    '_lastOptProductName', '_markDupProductNames', 'renderOptRows', 'renderOptRowsWithProduct',
    'readOptRows', '_readProdRows', '_readProdRowsRaw', '_syncPreviewFromOptRows', '_optSummary',
    'parseProductLinesToRows', 'applyProductRowsFromOrder',
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
console.log('\n[B] 모드가 옵션 유무의 단일 출처');
{
  const t = makeTable();
  // 옵션명 값이 들어간 행을 만든 뒤 'none' 모드로 두면 — 저장에도 원문에도 옵션이 안 나가야 한다
  t.run(`renderOptRows([{ productName:'상품A', optKey:'블랙', payAmount:22000, recruitTotal:5, dailyLimit:5 }], { mode:'none' })`);
  ok('none 모드: readOptRows() = 빈 배열(숨은 옵션명 무시)', t.run('JSON.stringify(readOptRows())') === '[]');
  ok('none 모드: rf_wd_product 원문에 옵션명 미포함', !/블랙/.test(t.dom.byId.rf_wd_product.value));
  ok('none 모드: 상품명·금액은 원문에 살아 있다', /상품A - 결제금액 22,000원/.test(t.dom.byId.rf_wd_product.value));
  ok('none 모드: 정원 파생은 종전대로(총 5)', t.dom.byId.rf_recruit_total.value === 5);

  // 같은 표를 'opt' 로 바꾸면 숨어 있던 옵션명이 그대로 살아난다(값 이월)
  t.run(`setProdMode('opt')`);
  const opts = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('opt 모드 전환: 숨어 있던 옵션명이 이월돼 저장 대상이 된다', opts.length === 1 && opts[0].optKey === '블랙');
  ok('opt 모드: 작업내용 원문에 옵션명 포함', /상품A - 블랙 - 결제금액/.test(t.dom.byId.rf_wd_product.value));
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

  // 옵션 배열이 오면 그대로 옵션 모드(무회귀)
  const t3 = makeTable();
  t3.run(`applyProductRowsFromOrder({ options: [{ optKey:'콰이어트', payAmount:31400, recruitTotal:20 }, { optKey:'어나더', payAmount:31400, recruitTotal:20 }] })`);
  const o3 = JSON.parse(t3.run('JSON.stringify(readOptRows())'));
  ok('옵션 배열 오더 → opt 모드 · 옵션 2건 · 옵션인원 프리필', t3.run('_prodMode()') === 'opt' && o3.length === 2 && o3[0].recruitTotal === 20);
}

/* ══════════════ E. 전환 시 값 이월 · 확인창 ══════════════ */
console.log('\n[E] 모드 전환 — 값 이월 · 조용한 소실 금지');
{
  const t = makeTable({ confirm: false });
  t.run(`renderOptRows([{ productName:'힙스', optKey:'콰이어트', payAmount:31400, recruitTotal:20, dailyLimit:10 },
                        { productName:'힙스', optKey:'어나더',  payAmount:31400, recruitTotal:20, dailyLimit:10 }])`);
  t.run(`setProdMode('none')`);
  ok('확인창 거절 시 모드가 바뀌지 않는다(옵션 보존)', t.run('_prodMode()') === 'opt' && JSON.parse(t.run('JSON.stringify(readOptRows())')).length === 2);

  const t2 = makeTable({ confirm: true });
  t2.run(`renderOptRows([{ productName:'힙스', optKey:'콰이어트', payAmount:31400, recruitTotal:20, dailyLimit:10 },
                         { productName:'힙스', optKey:'어나더',  payAmount:31400, recruitTotal:20, dailyLimit:10 }])`);
  t2.run(`setProdMode('none')`);
  const rows = JSON.parse(t2.run('JSON.stringify(_readProdRowsRaw())'));
  ok('opt → none: 상품 단위로 접히고 인원은 합계(20+20=40)', rows.length === 1 && rows[0].productName === '힙스' && rows[0].recruitTotal === 40);
  ok('opt → none: 저장 옵션 0건(= 옵션 정리 신호)', t2.run('JSON.stringify(readOptRows())') === '[]');

  // 살아있는 옵션이 없으면 확인창 없이 전환된다(막을 값이 없다)
  const t3 = makeTable({ confirm: false });
  t3.run(`renderOptRows([{ productName:'상품A', payAmount:1000 }], { mode:'opt' })`);
  t3.run(`setProdMode('none')`);
  ok('옵션이 없으면 확인창 없이 전환', t3.run('_prodMode()') === 'none');
}

/* ══════════════ 화면 배선 ══════════════ */
console.log('\n[UI] 모달 배선');
ok('모달: 작업 종류 스위치 + 모드 hidden + 모드별 헤더/도움말', /id="rf_prod_mode_sw"/.test(modalSrc)
  && /id="rf_prod_mode"[^>]*value="none"/.test(modalSrc)
  && /onclick="setProdMode\('none'\)"/.test(modalSrc) && /onclick="setProdMode\('opt'\)"/.test(modalSrc)
  && /rf-prod-head" data-pm="none"/.test(modalSrc) && /rf-prod-head" data-pm="opt"/.test(modalSrc));
ok('모달 CSS: 모드별 열 구성(none=옵션명 숨김 / opt=상품명 숨김+그룹)', /\.rf-pm-none \.rf-opt-name\{display:none\}/.test(modalSrc)
  && /\.rf-pm-opt \.rf-opt-prod\{display:none\}/.test(modalSrc) && /\.rf-gp-head\{display:grid/.test(modalSrc));
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
