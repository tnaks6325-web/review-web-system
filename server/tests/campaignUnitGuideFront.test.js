/**
 * campaignUnitGuideFront.test.js — 복합 작업(선택 단위별 유입가이드) 모달 회귀가드
 * 실행: node tests/campaignUnitGuideFront.test.js
 *
 * 고정하는 것(migration 134 · 사용자 확정 D1~D6):
 *  A. 혼합 표 저장 계약 — 상품A(옵션 2) + 상품B(옵션 없음) = **선택지 3개**,
 *     상품 단위 행은 `unitKind:'product'` 이고 **optKey 가 곧 상품명**
 *  B. 상품명 없는 상품 단위는 저장되지 않는다(키를 만들 수 없다) + 그 사실을 화면이 말한다
 *  C. 상품 단위 그룹은 **그룹당 한 줄**(여러 행이 남아 있어도 선택지는 하나)
 *  D. 선택지 전용 유입가이드 왕복 — 손대지 않으면 **원본 HTML 바이트 그대로**
 *  E. 글을 고쳐도 사진이 살아남는다(재조립) · 비우면 빈 값(= 공고 공통 가이드로 접힘)
 *  F. `_ugDropAll` 은 고정 3칸(inflow/review/notes)을 **절대 안 지운다**
 *  G. `_readProdRowsRaw` 는 상품 단위 행의 optKey 를 비운다(원문 "상품명 - 옵션명" 오염 차단)
 *  H. 자동점검은 **경고 전용**(게시를 막지 않는다) — 혼합 라벨 + 부분 가이드 고지
 *  I. 화면 계약(CSS) — 접힘/펼침 · 행 아래 항상 보이는 안내줄(.rf-ug-cta) · 옵션 없는 상품 그룹의 옵션명 잠금
 *  J. 안내줄 실행 검증(2026-08-24) — 형제로 붙는다 · 채워지면 "설정됨"으로 문구가 바뀐다 · 눌러야 펼쳐진다
 *  L. 2차 확대(2026-08-24 "버튼이 너무 좁아" 신고) — 안내줄·패널을 canonical 3칸보다 크게,
 *     글은 위·사진은 아래로 쌓는다 · compact-main 의 58px !important 캐스케이드를 이긴다
 *
 * ★ 정적 grep 이 아니라 **함수를 vm 으로 꺼내 가짜 DOM 위에서 실제 실행**한다 —
 *   "선택 단위를 존중하는가"·"가이드가 왕복하는가"는 문자열 검사로는 못 본다.
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

/** 옵션표 화면 하나를 세우고 index-recruit 의 표·가이드 함수를 실제로 실행한다 */
function makeTable(opts) {
  const dom = makeDom();
  dom.add('rf_opt_rows');
  dom.add('rf_opt_summary');
  dom.add('rf_wd_product', 'textarea');
  dom.add('rf_recruit_total', 'input');
  dom.add('rf_daily_limit', 'input');
  dom.add('rf_prod_mode_note', 'span');
  ['inflow', 'review', 'notes'].forEach(f => dom.add('rf_wd_' + f, 'textarea'));
  const wrap = dom.add('rf_opt_wrap');
  wrap.classList.add('rf-pm-none');
  const mode = dom.add('rf_prod_mode', 'input'); mode.value = 'none';
  const sw = dom.add('rf_prod_mode_sw');
  ['none', 'opt'].forEach(m => { const b = dom.mk('button'); b.classList.add('rf-pm-btn'); b.dataset.mode = m; sw.appendChild(b); });
  dom.add('rf_opt_addbtn', 'button');

  const sandbox = {
    console, document: dom.document,
    confirm: () => (opts && opts.confirm !== undefined) ? opts.confirm : true,
    escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    renderPartCheck: () => {},
    _renderPreview: () => {},
    syncRecruitProductMainUrl: () => {},
    showToast: () => {},
    // 공유 이미지 위젯의 화면 조작부만 스텁 — 이 가드가 보는 것은 "선택 단위와 가이드 값"이다
    _igBind: () => {},
    _igRender: () => {},
    _readOptionReviewMix: () => [],
    /* 정원 잠금(2026-08-19, main) — 이 하네스는 신규 발행 상태(편집 아님)라 잠금이 꺼진 채 돈다.
       ★ 표 함수가 새 전역을 부르면 여기(또는 아래 추출 목록)에 반드시 함께 넣는다. */
    _recruitEditId: null,
    _rfQuotaUnlock: false,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ['_IG_MAX', '_IG_FIELDS', '_IG_TA', '_IG_URL_RE', '_igTok', '_igOk', '_igUrls', '_igImgTags', '_UG_KEY_RE']
    .forEach(c => vm.runInContext(grabConst(recruitSrc, c), sandbox));
  vm.runInContext('window._igState = { inflow: [], review: [], notes: [] };', sandbox);
  vm.runInContext('let _ugSeq = 0;', sandbox);
  [
    '_htmlToPlainPreview', '_igSetList', '_igSplitInflow',
    '_ugNewKey', '_ugRegister', '_ugDrop', '_ugDropAll', '_ugDropBox', '_ugBuild', '_ugLoad', '_ugCompose', '_ugMark', '_ugAttachAll',
    '_prodMode', '_applyProdModeUi', '_setProdModeNote', '_renderProdModeHelp', 'setProdMode', '_convertProdRows',
    '_renderProdTable', '_buildProdGroup', '_syncGroupTotals', 'addOptRow', '_buildOptRowEl',
    '_lastOptProductName', '_markDupProductNames', 'renderOptRows',
    '_rfHttpUrl', '_rfGroupUnit', '_rfRowProductName',
    'readOptRows', '_readProdRows', '_readProdRowsRaw', '_syncPreviewFromOptRows', '_optSummary',
    '_rfQuotaNotice', '_syncQuotaLockUi',
  ].forEach(fn => vm.runInContext(grab(recruitSrc, fn), sandbox));
  return { dom, sandbox, run: (code) => vm.runInContext(code, sandbox) };
}

const IMG = (t) => 'https://api.example.com/api/order/guide-image/' + t;
const TOK_A = 'aaaaaaaaaaaaaaaaaaaa1';
const TOK_B = 'bbbbbbbbbbbbbbbbbbbb2';

/** 상품A(옵션2) + 상품B(옵션없음) 혼합 표 */
function mixedTable() {
  const t = makeTable();
  t.sandbox._seed = [
    { productName: '상품A', unitKind: 'option', optKey: '옵션A', payAmount: 22000, recruitTotal: 5, dailyLimit: 5,
      inflowGuideHtml: '<p>A-옵션A 유입</p><img src="' + IMG(TOK_A) + '">', inflowGuideImages: [] },
    { productName: '상품A', unitKind: 'option', optKey: '옵션B', payAmount: 23000, recruitTotal: 5, dailyLimit: 5,
      inflowGuideHtml: '', inflowGuideImages: [] },
    { productName: '상품B', unitKind: 'product', optKey: '상품B', payAmount: 19000, recruitTotal: 7, dailyLimit: 3,
      inflowGuideHtml: '<p>B 유입</p>', inflowGuideImages: [IMG(TOK_B)] },
  ];
  t.run('renderOptRows(_seed)');
  return t;
}

/* ══════════════ A. 혼합 표 저장 계약 ══════════════ */
console.log('\n[A] 복합 작업 — 선택지 3개(옵션2 + 상품1)');
{
  const t = mixedTable();
  ok('옵션이 하나라도 있으면 opt 모드', t.run('_prodMode()') === 'opt');
  const groups = t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp');
  ok('상품 단위는 옵션 그룹에 병합되지 않는다(그룹 2개)', groups.length === 2);
  ok('상품B 그룹의 선택 단위 = product', groups[1].dataset.unit === 'product');

  const out = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('선택지 3개(리뷰어가 실제로 고르는 것의 개수)', out.length === 3);
  ok('옵션 단위는 종전 그대로', out[0].optKey === '옵션A' && out[0].unitKind === 'option' && out[0].productName === '상품A');
  ok('상품 단위의 키가 곧 상품명', out[2].unitKind === 'product' && out[2].optKey === '상품B' && out[2].productName === '상품B');
  ok('상품 단위도 자기 금액·정원·하루건수를 갖는다', out[2].payAmount === 19000 && out[2].recruitTotal === 7 && out[2].dailyLimit === 3);
}

/* ══════════════ B. 이름 없는 상품 단위는 저장하지 않는다 ══════════════ */
console.log('\n[B] 상품명 없는 상품 단위 — 키를 만들 수 없다');
{
  const t = makeTable();
  t.sandbox._seed = [{ productName: '', unitKind: 'product', optKey: '', payAmount: 1000, recruitTotal: 3 }];
  t.run("renderOptRows(_seed, { mode:'opt' })");
  ok('저장 페이로드에서 제외(빈 optKey 금지)', t.run('JSON.stringify(readOptRows())') === '[]');
  ok('화면이 사유를 말한다(조용한 누락 금지)', /상품명이 없어/.test(t.dom.byId.rf_opt_summary.innerHTML));
  ok('행 자체는 남는다(이름을 적으면 바로 살아난다)',
    t.dom.byId.rf_opt_rows.querySelectorAll('.rf-opt-row').length === 1);
}

/* ══════════════ C. 상품 단위는 그룹당 한 줄 ══════════════ */
console.log('\n[C] 상품 단위 = 그룹당 선택지 하나');
{
  const t = makeTable();
  t.sandbox._seed = [
    { productName: '상품B', unitKind: 'product', optKey: '상품B', payAmount: 19000, recruitTotal: 7 },
    { productName: '상품B', unitKind: 'product', optKey: '상품B', payAmount: 19000, recruitTotal: 7 },
  ];
  t.run("renderOptRows(_seed, { mode:'opt' })");
  const out = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('같은 상품 단위 그룹이 둘이면 선택지도 둘(그룹이 단위다)', out.length === 2);

  // 한 그룹 안에 행이 여러 개 남아 있어도(옵션 → 상품 전환 잔재) 선택지는 하나
  const t2 = makeTable();
  t2.sandbox._seed = [
    { productName: '상품C', unitKind: 'option', optKey: '옵1' },
    { productName: '상품C', unitKind: 'option', optKey: '옵2' },
  ];
  t2.run("renderOptRows(_seed, { mode:'opt' })");
  t2.run("document.querySelectorAll('#rf_opt_rows .rf-gp')[0].dataset.unit = 'product'");
  const out2 = JSON.parse(t2.run('JSON.stringify(readOptRows())'));
  ok('한 그룹에 행이 둘이어도 상품 단위면 선택지 1개', out2.length === 1 && out2[0].optKey === '상품C');
}

/* ══════════════ D·E. 선택지 전용 유입가이드 왕복 ══════════════ */
console.log('\n[D·E] 선택지 가이드 — 원본 보존 · 글 수정 시 사진 생존 · 비우면 빈 값');
{
  const t = mixedTable();
  const out = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('손대지 않으면 원본 HTML 바이트 그대로', out[0].inflowGuideHtml === t.sandbox._seed[0].inflowGuideHtml);
  ok('본문 <img> 는 이미지 배열로도 함께 나간다', out[0].inflowGuideImages.join() === IMG(TOK_A));
  ok('배열로만 온 사진도 그 선택지에 실린다', out[2].inflowGuideImages.join() === IMG(TOK_B));
  ok('가이드가 없는 선택지는 빈 값(= 공고 공통 가이드로 접힘)', out[1].inflowGuideHtml === '' && out[1].inflowGuideImages.length === 0);

  // 글을 고치면 재조립 — 사진은 살아남는다(글 한 글자에 사진이 통째로 사라지던 사고 차단)
  const key = t.run("document.querySelector('#rf_opt_rows .rf-opt-row').dataset.ig");
  t.run("document.getElementById(_IG_TA['" + key + "']).value = '고친 글'");
  const out2 = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('글 수정 → 재조립되지만 사진 태그가 살아남는다',
    /^고친 글/.test(out2[0].inflowGuideHtml) && out2[0].inflowGuideHtml.indexOf(IMG(TOK_A)) > 0);

  // 글도 사진도 비우면 빈 값
  t.run("document.getElementById(_IG_TA['" + key + "']).value = ''");
  t.run("window._igState['" + key + "'] = []");
  const out3 = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('글·사진을 모두 비우면 빈 값', out3[0].inflowGuideHtml === '' && out3[0].inflowGuideImages.length === 0);
}

/* ══════════════ F. 고정 3칸을 지우지 않는다 ══════════════ */
console.log('\n[F] 동적 키 정리 — 고정 3칸(유입/리뷰/특이) 보호');
{
  const t = mixedTable();
  t.run("window._igState.inflow = [{ url:'" + IMG(TOK_A) + "', tok:'" + TOK_A + "', state:'ok' }]");
  const before = t.run('Object.keys(_IG_FIELDS).filter(k => /^u\\d+$/.test(k)).length');
  ok('선택지마다 동적 키가 발급된다', before === 3);
  t.run('_ugDropAll()');
  ok('_ugDropAll 후 동적 키 0', t.run('Object.keys(_IG_FIELDS).filter(k => /^u\\d+$/.test(k)).length') === 0);
  ok('고정 3칸은 남는다', t.run("['inflow','review','notes'].every(k => !!_IG_FIELDS[k] && !!_IG_TA[k] && !!window._igState[k])") === true);
  ok('고정 3칸의 값도 그대로', t.run("window._igState.inflow.length") === 1);
  // ★ 방어는 두 겹 — 목록 필터(_ugDropAll)와 _ugDrop 자신. 안쪽 것도 따로 고정한다
  //   (한쪽만 지워도 통과하면 다음 사람이 "중복"이라며 안쪽을 걷어낸다)
  t.run("_ugDrop('inflow')");
  ok('_ugDrop 자체가 고정 3칸을 거절한다', t.run("!!_IG_FIELDS.inflow && window._igState.inflow.length === 1") === true);

  // 표를 다시 그리면 옛 키가 남지 않는다(사라진 행의 상태가 위젯에 유령으로 남는 것 차단)
  const t2 = mixedTable();
  t2.run("renderOptRows([{ productName:'상품Z', unitKind:'option', optKey:'옵Z' }], { mode:'opt' })");
  ok('표 재렌더 후 동적 키는 지금 화면의 행 수와 같다',
    t2.run('Object.keys(_IG_FIELDS).filter(k => /^u\\d+$/.test(k)).length') === 1);
}

/* ══════════════ G. 원문 오염 차단 ══════════════ */
console.log('\n[G] 작업내용 원문 — 상품 단위는 "상품명 - 옵션명" 이 되지 않는다');
{
  const t = mixedTable();
  const raw = JSON.parse(t.run('JSON.stringify(_readProdRowsRaw())'));
  const bRow = raw.filter(r => r.productName === '상품B')[0];
  ok('상품 단위 행의 optKey 는 비어 있다', bRow && bRow.optKey === '');
  ok('원문에 "상품B - 상품B" 오염 없음', !/상품B - 상품B/.test(t.dom.byId.rf_wd_product.value));
  ok('원문에 상품B 금액은 살아 있다', /상품B - 결제금액 19,000원/.test(t.dom.byId.rf_wd_product.value));
  ok('옵션 단위는 종전대로 "상품명 - 옵션명"', /상품A - 옵션A - 결제금액/.test(t.dom.byId.rf_wd_product.value));

  // ★★ 숨은 옵션명 칸에 잔여값이 남아 있어도(모드 전환·프리필 잔재) 원문으로 새지 않는다
  //    — 판정은 "그 칸이 비었나"가 아니라 **그룹의 선택 단위**여야 한다
  const bRowEl = t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp')[1].querySelectorAll('.rf-opt-row')[0];
  bRowEl.querySelector('.rf-opt-name').value = '잔재옵션';
  const raw2 = JSON.parse(t.run('JSON.stringify(_readProdRowsRaw())'));
  ok('상품 단위는 숨은 옵션명 잔재를 무시한다',
    raw2.filter(r => r.productName === '상품B')[0].optKey === '');
  t.run('_syncPreviewFromOptRows()');
  ok('원문에도 잔재 옵션명이 안 샌다', !/잔재옵션/.test(t.dom.byId.rf_wd_product.value));
}

/* ══════════════ H. 자동점검 = 경고 전용 ══════════════ */
console.log('\n[H] 자동점검 — 혼합 라벨 · 부분 가이드 고지(게시는 막지 않는다)');
{
  const t = mixedTable();
  const html = t.dom.byId.rf_opt_summary.innerHTML;
  ok('혼합이면 "선택지 N개(옵션 a · 상품 b)" 로 센다', /선택지 3개\(옵션 2 · 상품 1\)/.test(html));
  ok('일부 선택지만 가이드가 있으면 고지', /선택지 전용 유입가이드가 2\/3개만 설정됨/.test(html));

  const t2 = makeTable();
  t2.sandbox._seed = [{ productName: '상품A', unitKind: 'option', optKey: '옵A' }, { productName: '상품A', unitKind: 'option', optKey: '옵B' }];
  t2.run("renderOptRows(_seed, { mode:'opt' })");
  ok('상품 단위가 없으면 종전 문구("옵션 N종")', /옵션 2종/.test(t2.dom.byId.rf_opt_summary.innerHTML));
  ok('가이드가 하나도 없으면 부분 설정 경고 없음(늑대소년 방지)',
    !/전용 유입가이드가/.test(t2.dom.byId.rf_opt_summary.innerHTML));
}

/* ══════════════ I. 화면 계약(CSS) ══════════════ */
console.log('\n[I] 화면 계약 — 접힘 · 항상 보이는 안내줄 · 옵션명 잠금');
{
  ok('선택지 가이드 패널은 평소 접혀 있다', /\.rf-unit>\.rf-ug\{display:none\}/.test(modalSrc));
  ok('버튼을 눌러야(ug-on) 펼쳐진다', /\.rf-unit\.ug-on>\.rf-ug\{display:block/.test(modalSrc));
  // ★★ 2026-08-24 — 작은 아이콘(🧭) 하나뿐이라 클릭 대상인지 알아보기 어렵다는 신고로,
  //    입구를 행 아래 **항상 보이는 안내줄**(.rf-ug-cta)로 옮겼다. 행 끝 도구칸은 이제
  //    삭제/재개 한 버튼만 남아 26px 로 좁아지고, 대신 결제금액·옵션인원·일건수 칸도
  //    함께 줄여 상품명·URL 칸에 여유를 돌려준다(사용자 확정 — 두 제안을 함께 반영).
  ok('행 끝 도구칸은 이제 삭제/재개 한 버튼뿐 — 마지막 트랙이 좁아졌다',
    /\.rf-pm-opt \.rf-prod-head\[data-pm="opt"\],#recruitModal \.rf-pm-opt \.rf-opt-row\{grid-template-columns:[^}]*26px\}/.test(modalSrc));
  ok('결제금액·옵션인원·일건수 칸이 좁아졌다(공간을 안내줄에 돌려준다)',
    /\.rf-pm-opt \.rf-opt-row\{grid-template-columns:18px minmax\(0,1\.18fr\) minmax\(0,1fr\) \.64fr \.46fr \.46fr 26px\}/.test(modalSrc));
  ok('머리줄과 행이 같은 규칙으로 함께 움직인다(열 어긋남 차단)',
    /\.rf-prod-head\[data-pm="opt"\],#recruitModal \.rf-pm-opt \.rf-opt-row\{grid-template-columns/.test(modalSrc));
  // ★★ 나중에 머리줄만 따로 덮는 규칙이 생기면 같은 특이성이라 그쪽이 이겨 열이 어긋난다
  //    (합쳐진 규칙이 "있다"만 보면 이 회귀를 통과시킨다 — 변이시험이 실제로 뚫었다)
  {
    const last = modalSrc.lastIndexOf('.rf-prod-head[data-pm="opt"],#recruitModal .rf-pm-opt .rf-opt-row{grid-template-columns');
    const headOnly = /\.rf-pm-opt \.rf-prod-head\[data-pm="opt"\]\{[^}]*grid-template-columns/g;
    let m, after = false;
    while ((m = headOnly.exec(modalSrc))) if (m.index > last) after = true;
    ok('머리줄만 따로 덮는 나중 규칙이 없다', last > 0 && !after);
  }
  // ★★ 특이성 실측 사고(이번 작업 중 실제로 밟음): `.rf-pm-none .rf-ug-cta{display:none}` 과
  //    `.rf-unit>.rf-ug-cta{display:flex}` 는 특이성이 같아 **나중에 오는 규칙이 이겨** 가림이
  //    풀렸다(실브라우저로 확인). 가림 규칙은 `.rf-unit>` 한 단계를 더해 특이성을 확실히 높인다.
  ok('옵션 없는 작업(none) 모드에는 선택지 가이드 안내줄이 없다(저장되지 않는 칸을 그리지 않는다)',
    /\.rf-pm-none \.rf-unit>\.rf-ug-cta\{display:none\}/.test(modalSrc));
  ok('그 가림 규칙은 특이성이 더 높다(순서에 기대지 않는다 — .rf-unit> 한 단계 추가)',
    /\.rf-pm-none \.rf-unit>\.rf-ug-cta\{display:none\}/.test(modalSrc) &&
    !/\.rf-pm-none \.rf-ug-cta\{display:none\}/.test(modalSrc.replace(/\.rf-pm-none \.rf-unit>\.rf-ug-cta/g, '')));
  ok('종전 아이콘 버튼(.rf-ug-btn)은 CSS 에서 사라졌다(사본 부활 금지)', !/\.rf-ug-btn/.test(modalSrc));
  ok('안내줄은 행 폭 전체를 쓰는 클릭 가능한 한 줄이다',
    /\.rf-unit>\.rf-ug-cta\{display:flex[^}]*width:100%/.test(modalSrc) && /cursor:pointer/.test(modalSrc));
  ok('가이드가 설정되어 있으면 안내줄 색이 바뀐다(has)',
    /\.rf-unit>\.rf-ug-cta\.has\{background:#EDF4FF/.test(modalSrc));
  ok('상품 그룹 머리는 4칸(상품명·옵션 유무·총인원·삭제)',
    /\.rf-gp-head\{grid-template-columns:minmax\(0,1fr\) auto \.62fr 26px\}/.test(modalSrc));
  ok('옵션 없는 상품 그룹의 옵션명 칸은 없애지 않고 잠근다(열 어긋남 차단)',
    /\.rf-gp-noopt \.rf-opt-name\{pointer-events:none/.test(modalSrc) && !/\.rf-gp-noopt \.rf-opt-name\{display:none/.test(modalSrc));
  ok('옵션 없는 상품 그룹에는 [＋ 옵션 추가] 가 없다', /\.rf-gp-noopt \.rf-gp-add\{display:none\}/.test(modalSrc));
  ok('행이 껍데기에 들어가도 마지막 줄 테두리가 산다',
    /#rf_opt_rows \.rf-unit:last-child>\.rf-opt-row\{border-bottom/.test(modalSrc));
  ok('안내줄이 마지막 유닛의 시각적 바닥이 될 때도 테두리가 산다',
    /#rf_opt_rows \.rf-unit:last-child>\.rf-ug-cta\{border-bottom/.test(modalSrc));
  ok('CSS 선택자는 #recruitModal 스코프(호스트 화면 오염 금지)',
    !/\n\.rf-ug\b/.test(modalSrc) && !/\n\.rf-opt-acts\b/.test(modalSrc));
}

/* ══════════════ J. 안내줄(.rf-ug-cta) — 실제 DOM 실행 ══════════════
   2026-08-24 신고 대응: 작은 아이콘(🧭)만으로는 클릭 대상인지 알아보기 어려웠다.
   정적 CSS 검사(I절)와 별개로, 실제로 행마다 안내줄이 붙고 상태 문구가 바뀌는지를
   가짜 DOM 위에서 실행해 확인한다(문자열만 있고 실행은 안 되는 회귀를 잡는다). */
console.log('\n[J] 안내줄 — 행마다 형제로 붙고, 채워지면 상태 문구가 바뀐다');
{
  const t = mixedTable();
  const units = t.dom.byId.rf_opt_rows.querySelectorAll('.rf-unit');
  ok('선택지 3개 = 안내줄도 3개', units.length === 3);

  const unit0 = units[0], row0 = unit0.querySelectorAll('.rf-opt-row')[0], cta0 = unit0.querySelectorAll('.rf-ug-cta')[0];
  ok('안내줄은 행의 자식이 아니라 형제다(칸 폭에 갇히지 않는다)',
    !!cta0 && cta0.parent === unit0 && row0.querySelectorAll('.rf-ug-cta').length === 0);
  ok('가이드가 이미 있는 선택지는 처음부터 "설정됨"을 보여준다',
    cta0.classList.contains('has') && /설정됨/.test(cta0.querySelector('.rf-ug-cta-st').textContent));
  ok('사진 개수도 함께 말한다(사진 1장)', /사진 1장/.test(cta0.querySelector('.rf-ug-cta-st').textContent));
  ok('안내줄은 항상 "이 옵션 전용 유입가이드" 라벨을 보여준다(발견성)',
    /이 옵션 전용 유입가이드/.test(cta0.innerHTML));

  const unit1 = units[1], cta1 = unit1.querySelectorAll('.rf-ug-cta')[0];
  ok('가이드가 비어 있는 선택지는 "비어 있음"을 보여준다',
    !cta1.classList.contains('has') && /비어 있음/.test(cta1.querySelector('.rf-ug-cta-st').textContent));

  ok('종전 아이콘 버튼(.rf-ug-btn) 은 어디에도 없다(사본 부활 금지)',
    t.dom.byId.rf_opt_rows.querySelectorAll('.rf-ug-btn').length === 0);

  ok('안내줄을 누르면 패널이 펼쳐진다(ug-on)', !unit1.classList.contains('ug-on'));
  cta1.onclick();
  ok('열림', unit1.classList.contains('ug-on'));
  cta1.onclick();
  ok('다시 누르면 닫힌다', !unit1.classList.contains('ug-on'));

  // 글을 채운 뒤 다시 살리면(_ugAttachAll) 안내줄도 "설정됨"으로 바뀐다
  const keyEmpty = unit1.querySelectorAll('.rf-opt-row')[0].dataset.ig;
  t.run("document.getElementById(_IG_TA['" + keyEmpty + "']).value = '새로 채움'");
  t.run('_ugAttachAll()');
  ok('글을 채우면 안내줄이 즉시 "설정됨"으로 바뀐다',
    unit1.querySelectorAll('.rf-ug-cta')[0].classList.contains('has'));
}

/* ══════════════ K. 배선 ══════════════ */
console.log('\n[K] 배선 — 값 주입은 DOM 에 붙은 뒤 · onclick 문자열 보간 0');
{
  ok('행 생성 시에는 값을 예약만 한다(_ugPending)', /row\._ugPending\s*=\s*\{/.test(recruitSrc));
  ok('붙인 뒤 _ugAttachAll 이 살린다', /_ugAttachAll\(\)/.test(recruitSrc));
  ['_renderProdTable', 'addOptRow'].forEach(fn => {
    ok(fn + ' 이 _ugAttachAll 로 위젯을 살린다', /_ugAttachAll\(\)/.test(grab(recruitSrc, fn)));
  });
  ok('_renderProdTable 은 갈아치우기 전에 옛 키를 버린다',
    grab(recruitSrc, '_renderProdTable').indexOf('_ugDropAll()') < grab(recruitSrc, '_renderProdTable').indexOf('wrap.innerHTML'));
  ok('선택지 가이드 파일 입력은 addEventListener 로만 배선(onclick 보간 0)',
    /addEventListener\("change", \(\) => igPickFiles\(key, f\)\)/.test(grab(recruitSrc, '_ugBuild')) &&
    !/onclick=/.test(grab(recruitSrc, '_ugBuild')));
  // ★ NUL 은 글자 그대로 적지 않는다 — 이 가드 파일까지 바이너리가 되어 grep 이 죽는다
  const NUL = String.fromCharCode(0);
  ok('소스에 리터럴 NUL 없음', recruitSrc.indexOf(NUL) < 0 && modalSrc.indexOf(NUL) < 0);
  ok('이 가드 파일에도 리터럴 NUL 없음',
    fs.readFileSync(__filename, 'utf8').indexOf(NUL) < 0);
}

/* ══════════════ L. 2차 확대(2026-08-24 "버튼이 너무 좁아" 신고) ══════════════
   안내줄·패널이 좁아 클릭 대상·입력 영역이 답답했다는 신고로, canonical 3칸(유입/리뷰/특이,
   58px로 나란히 좁게 배치)보다 크게 키운다: 안내줄 글자·여백 확대, 패널은 글을 위·사진을
   아래로 쌓고(옆으로 눕힌 58px 판형 폐기), 썸네일도 키운다. 옵션 행 아래는 폭 제약이 없어
   canonical 3칸을 건드리지 않고도 이렇게 할 수 있다(사본 0 — 셀렉터로만 갈라진다). */
console.log('\n[L] 2차 확대 — 안내줄·패널이 canonical 3칸보다 크다 · 58px 캐스케이드를 이긴다');
{
  ok('안내줄 글자·여백이 커졌다(.62rem·4px 8px → .74rem·9px 11px)',
    /\.rf-unit>\.rf-ug-cta\{[^}]*padding:9px 11px[^}]*font-size:\.74rem/.test(modalSrc) &&
    !/\.rf-unit>\.rf-ug-cta\{[^}]*font-size:\.62rem/.test(modalSrc));
  ok('안내줄 아이콘·라벨도 커졌다', /\.rf-ug-cta-ic\{flex:none;font-size:\.92rem\}/.test(modalSrc) &&
    /\.rf-ug-cta-tx\{[^}]*font-size:\.76rem\}/.test(modalSrc));
  // ★ 패널이 열려도 canonical 3칸(유입/리뷰/특이)의 좁은 58px 판형은 절대 안 건드린다
  //   (사본을 두지 않고 .rf-unit>.rf-ug 로만 갈랐다는 것을 회귀로 고정)
  ok('canonical 3칸의 58px !important 규칙은 그대로 남아 있다(무회귀)',
    /\.rf-compact-main \.work-compose textarea,[^{]*\{[^}]*height:58px!important/.test(modalSrc) &&
    /\.rf-compact-main \.ig-strip\{height:58px!important/.test(modalSrc));
  ok('패널은 글 위 · 사진 아래로 쌓는다(옆으로 눕힌 58px 판형 폐기)',
    /\.rf-compact-main \.rf-unit>\.rf-ug \.ig-wrap\{display:flex;flex-direction:column/.test(modalSrc));
  ok('종전의 좁은 58px 옆배치 규칙(.rf-ug 단독 스코프)은 사라졌다(사본 부활 금지)',
    !/#recruitModal \.rf-ug \.ig-wrap>textarea\.rform-input,#recruitModal \.rf-ug \.ig-strip\{height:58px/.test(modalSrc));
  // ★★ compact-main 의 두 58px !important 규칙(텍스트영역·스트립)을 이겨야 한다 — 특이성이
  //    같으면 파일 순서에 좌우된다(위 CTA 특이성 사고와 같은 함정). !important + 더 높은
  //    특이성(.rf-compact-main .rf-unit>.rf-ug …)으로 순서 무관하게 이기는지 고정한다.
  ok('텍스트영역 폭을 !important 로 되찾는다(더 높은 특이성)',
    /\.rf-compact-main \.rf-unit>\.rf-ug \.ig-wrap>textarea\.rform-input\{[^}]*height:64px!important/.test(modalSrc));
  ok('스트립도 !important 로 전체 폭을 되찾는다(더 높은 특이성)',
    /\.rf-compact-main \.rf-unit>\.rf-ug \.ig-strip\{[^}]*width:100%!important[^}]*min-height:78px!important/.test(modalSrc));
  {
    // 두 규칙 모두 compact-main 의 규칙보다 특이성이 높다 — `.rf-compact-main .rf-unit>.rf-ug`
    // 접두가 없는 순간 `.rf-compact-main .ig-strip`/`.work-compose textarea` 와 동률로 떨어져
    // 파일 순서에 기댄다(실측으로 이미 한 번 밟은 함정과 같은 계열).
    const stripRule = /\.rf-compact-main \.rf-unit>\.rf-ug \.ig-strip\{[^}]*\}/.exec(modalSrc);
    const taRule = /\.rf-compact-main \.rf-unit>\.rf-ug \.ig-wrap>textarea\.rform-input\{[^}]*\}/.exec(modalSrc);
    ok('그 두 규칙은 순서에 기대지 않을 만큼 특이성이 높다(.rf-compact-main .rf-unit> 접두)',
      !!stripRule && !!taRule);
  }
  ok('빈 상태 버튼 글자도 커졌다(canonical 3칸과 다른 자리)',
    /\.rf-unit>\.rf-ug \.ig-empty \.t1\{font-size:\.82rem/.test(modalSrc) &&
    /\.rf-unit>\.rf-ug \.ig-empty \.t2\{font-size:\.68rem/.test(modalSrc));
  ok('썸네일·추가 버튼도 커졌다(74px 정사각 → 70px, canonical 은 74px 그대로)',
    /\.rf-unit>\.rf-ug \.ig-thumb,#recruitModal \.rf-unit>\.rf-ug \.ig-add\{width:70px;height:70px\}/.test(modalSrc));
  ok('CSS 선택자는 여전히 #recruitModal 스코프(호스트 화면 오염 금지)',
    !/\n\.rf-ug-cta\b/.test(modalSrc) && !/\n\.rf-ug\b/.test(modalSrc));
}

/* ★ 사진이 실제로 나열되고 클릭하면 확대되는지는 이 파일의 가짜 DOM(getAttribute·임의
   속성 미지원)으로는 검증할 수 없다 — `_igRender`/`_igLbOpen`(최대 4장·라이트박스)은
   `makeTable()` 사본에서도 화면 조작부만 스텁한다("이 가드가 보는 것은 선택 단위와
   가이드 값"). 그 메커니즘 자체는 이 파일이 손댄 적 없고(이번 변경은 CSS뿐),
   실제 브라우저(Playwright)로 3장 나열·클릭 확대를 확인했다. */

console.log('\n✅ campaignUnitGuideFront: ' + passed + '개 통과');
process.exit(0);
