/**
 * optionLandingModal.test.js — 옵션별 유입 링크 M3(발행·수정 모달 UI) 회귀가드
 * 실행: node tests/optionLandingModal.test.js
 *
 * 고정하는 것(되돌리면 이 기능이 무너지는 자리):
 *  A. **A안 열 구성**(사용자 확정) — 진행상품 표에 [상품 URL]·[유입 링크] 열이 있고
 *     머리 칸 수 ≡ 행 입력 칸 수 ≡ CSS grid 트랙 수(열을 끼워 넣을 때 가장 흔히 깨지는 자리)
 *  B. **판정 사본 일치** — 프론트 `RF_OPTION_URL_SUPPORT` ≡ 서버 `OPTION_URL_SUPPORT`
 *     (화면에서만 열면 저장은 되는데 리뷰어 화면이 안 바뀌고, 화면에서만 잠그면 입력 방법이 없다)
 *  C. `_optUrlState` 3갈래 — 가이드유입 잠금 · 네이버 잠금 · 그 외 열림 · **채널 미상 fail-open**
 *  D. ★★ **잠긴 칸은 `landingUrl` 을 전송하지 않는다**(미전송 = 서버 COALESCE 유지)
 *     — 빈 문자열을 보내면 CASE 센티널이 '해제'로 읽어 저장된 주소가 조용히 지워진다
 *  E. **랜딩 URL 은 파생**(D3) — 첫 상품 URL 하나 · readonly · 주소 2종이면 경고만
 *  F. 자동점검 항목은 **전부 경고**(D2 확정 — 게시를 막지 않는다)
 *  G. 배선 — 유입방식 버튼군 · 저장 payload 게이트("UI 있는 화면에서만 전송") · 편집 프리필
 *
 * ★ 정적 grep 이 아니라 **함수를 vm 으로 꺼내 가짜 DOM 위에서 실제 실행**한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const recruitSrc = read('frontend/js/index-recruit.js');
const modalSrc = read('frontend/js/recruit-modal.js');
const { OPTION_URL_SUPPORT, supportsOptionUrl } = require('../src/utils/optionUrlChannels');
const { sanitizeLandingUrl, deriveCampaignLandingUrl } = require('../src/utils/optionLanding');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

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
/** `const NAME = {...};` 한 줄 꺼내기 */
function grabConst(src, name) {
  const re = new RegExp(`const ${name}\\s*=\\s*\\{[^}]*\\};`);
  const m = re.exec(src);
  assert(m, `상수 없음: ${name}`);
  return m[0];
}

/* ══════════════ 가짜 DOM (querySelector 후손 선택자 지원) ══════════════ */
function makeDom() {
  const byId = {};
  function parseHtml(html) {
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
      disabled: false, placeholder: '',
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

/** 진행상품 표 + 유입방식·채널·랜딩 칸을 세우고 index-recruit 함수를 실제 실행한다 */
function makeTable() {
  const dom = makeDom();
  dom.add('rf_opt_rows');
  dom.add('rf_opt_summary');
  dom.add('rf_wd_product', 'textarea');
  dom.add('rf_recruit_total', 'input');
  dom.add('rf_daily_limit', 'input');
  dom.add('rf_prod_mode_note', 'span');
  dom.add('rf_inflow_type', 'input');
  dom.add('rf_inflow_type_btns');
  dom.add('rf_inflow_note');
  dom.add('rf_channel', 'input');
  dom.add('rf_channel_custom', 'input');
  dom.add('rf_landing_url', 'input');
  dom.add('rf_landing_note');
  const wrap = dom.add('rf_opt_wrap');
  wrap.classList.add('rf-pm-none');
  const mode = dom.add('rf_prod_mode', 'input'); mode.value = 'none';
  const sw = dom.add('rf_prod_mode_sw');
  ['none', 'opt'].forEach(m => { const b = dom.mk('button'); b.classList.add('rf-pm-btn'); b.dataset.mode = m; sw.appendChild(b); });
  dom.add('rf_opt_addbtn', 'button');

  const sandbox = {
    console, document: dom.document,
    confirm: () => true,
    renderPartCheck: () => {},
    _renderPreview: () => {},
    showToast: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(grabConst(recruitSrc, 'RF_OPTION_URL_SUPPORT'), sandbox);
  [
    '_prodMode', '_applyProdModeUi', '_setProdModeNote', 'setProdMode', '_convertProdRows',
    '_renderProdTable', '_buildProdGroup', '_syncGroupTotals', 'addOptRow', '_buildOptRowEl',
    '_lastOptProductName', '_markDupProductNames', 'renderOptRows', 'renderOptRowsWithProduct',
    'readOptRows', '_readProdRows', '_readProdRowsRaw', '_syncPreviewFromOptRows', '_optSummary',
    '_rfChannelKey', '_optUrlState', '_optUrlEnabled', '_syncOptUrlState',
    '_syncLandingFromProdRows', '_optUrlCheckItems',
    'parseProductLinesToRows', 'applyProductRowsFromOrder',
  ].forEach(fn => vm.runInContext(grab(recruitSrc, fn), sandbox));
  return { dom, sandbox, run: (code) => vm.runInContext(code, sandbox) };
}

/* ══════════════ A. A안 열 구성 ══════════════ */
console.log('\n[A] A안 — 표에 열 추가 (머리 ≡ 행 ≡ grid 트랙)');
{
  const headNone = /<div class="rf-prod-head" data-pm="none">([\s\S]*?)<\/div>/.exec(modalSrc);
  const headOpt = /<div class="rf-prod-head" data-pm="opt">([\s\S]*?)<\/div>/.exec(modalSrc);
  ok('진행상품 표 머리 2종(none·opt) 존재', !!headNone && !!headOpt);
  const cntNone = (headNone[1].match(/<span/g) || []).length;
  const cntOpt = (headOpt[1].match(/<span/g) || []).length;
  ok('none 머리 6칸(상품명·상품 URL·결제금액·총인원·일건수·삭제)', cntNone === 6);
  ok('opt 머리 7칸(들여쓰기·옵션명·유입 링크·결제금액·옵션인원·일건수·삭제)', cntOpt === 7);
  ok('none 머리에 [상품 URL] 열', /상품 URL/.test(headNone[1]));
  ok('opt 머리에 [유입 링크] 열', /유입 링크/.test(headOpt[1]));

  const gNone = /\.rf-pm-none \.rf-prod-head\[data-pm="none"\],#recruitModal \.rf-pm-none \.rf-opt-row\{grid-template-columns:([^}]+)\}/.exec(modalSrc);
  const gOpt = /\.rf-pm-opt \.rf-prod-head\[data-pm="opt"\],#recruitModal \.rf-pm-opt \.rf-opt-row\{grid-template-columns:([^}]+)\}/.exec(modalSrc);
  ok('none grid 트랙 6개 = 머리 칸 수', !!gNone && gNone[1].trim().split(/\s+/).length === cntNone);
  ok('opt grid 트랙 7개 = 머리 칸 수', !!gOpt && gOpt[1].trim().split(/\s+/).length === cntOpt);

  // 행 DOM 은 두 모드 공통(저장 계약 무변경) — 실제 만들어 칸 수를 센다
  const t = makeTable();
  t.run(`renderOptRows([{ productName:'상품A', optKey:'블랙', payAmount:1000 }], { mode:'opt' })`);
  const row = t.dom.byId.rf_opt_rows.querySelector('.rf-opt-row');
  const inputs = ['rf-opt-prod', 'rf-opt-purl', 'rf-opt-name', 'rf-opt-ourl', 'rf-opt-pay', 'rf-opt-rt', 'rf-opt-dl'];
  ok('행 DOM = 두 모드 공통 7입력(보이는 칸만 CSS로 갈린다)',
    inputs.every(c => !!row.querySelector('.' + c)));
  ok('opt 모드는 상품명·상품 URL 칸을 CSS 로 숨긴다(행 DOM 은 유지)',
    /\.rf-pm-opt \.rf-opt-prod,#recruitModal \.rf-pm-opt \.rf-opt-purl\{display:none\}/.test(modalSrc));
  ok('none 모드는 옵션명·유입 링크 칸을 CSS 로 숨긴다',
    /\.rf-pm-none \.rf-opt-name,#recruitModal \.rf-pm-none \.rf-opt-ourl\{display:none\}/.test(modalSrc));

  const gp = /\.rf-gp-head\{display:grid;grid-template-columns:([^;]+);/.exec(modalSrc);
  ok('상품 그룹 머리 4트랙(상품명·상품 URL·총인원·삭제)', !!gp && gp[1].trim().split(/\s+/).length === 4);
}

/* ══════════════ B. 판정 사본 일치 ══════════════ */
console.log('\n[B] 프론트 판정 사본 ≡ 서버 표');
{
  const sb = { console }; vm.createContext(sb);
  vm.runInContext(grabConst(recruitSrc, 'RF_OPTION_URL_SUPPORT') + ';out=RF_OPTION_URL_SUPPORT;', sb);
  ok('RF_OPTION_URL_SUPPORT ≡ 서버 OPTION_URL_SUPPORT',
    JSON.stringify(sb.out) === JSON.stringify(OPTION_URL_SUPPORT));
  ok('네이버는 서버·프론트 모두 옵션별 주소 미지원', OPTION_URL_SUPPORT.naver === false && sb.out.naver === false);
  ok('쿠팡은 양쪽 모두 지원', supportsOptionUrl('쿠팡') === true && sb.out.coupang === true);
  ok('서버는 채널 미상을 fail-open(잠그지 않는다)', supportsOptionUrl('') === true && supportsOptionUrl('지마켓') === true);
}

/* ══════════════ C. _optUrlState 3갈래 ══════════════ */
console.log('\n[C] 옵션별 유입 링크 칸을 열지 말지');
{
  const t = makeTable();
  const set = (inflow, chan, custom) => {
    t.dom.byId.rf_inflow_type.value = inflow;
    t.dom.byId.rf_channel.value = chan || '';
    t.dom.byId.rf_channel_custom.value = custom || '';
  };
  set('link', '쿠팡');
  ok('링크유입 + 쿠팡 → 열림', t.run('_optUrlState().on') === true);
  set('guide', '쿠팡');
  ok('유입가이드 → 잠금(사유 표기)', t.run('_optUrlState().on') === false && /유입가이드/.test(t.run('_optUrlState().why')));
  set('link', '네이버');
  ok('네이버 → 잠금(옵션별 주소 없음)', t.run('_optUrlState().on') === false && /옵션별 주소/.test(t.run('_optUrlState().why')));
  set('', '');
  ok('유입방식·채널 미지정 → 열림(fail-open · 추정으로 잠그지 않는다)', t.run('_optUrlState().on') === true);
  set('link', '직접입력', '스마트스토어');
  ok('직접입력 커스텀 "스마트스토어" → 네이버로 판정해 잠금', t.run('_optUrlState().on') === false);
  set('link', '직접입력', '지마켓');
  ok('모르는 커스텀 채널 → 열림(fail-open)', t.run('_optUrlState().on') === true);

  // 잠금 표시: 입력칸 disabled + 그룹마다 사유 한 줄
  set('link', '네이버');
  t.run(`renderOptRows([{ productName:'상품A', optKey:'블랙' },{ productName:'상품A', optKey:'화이트' }], { mode:'opt' })`);
  t.run('_syncOptUrlState()');
  const ourls = t.dom.byId.rf_opt_rows.querySelectorAll('.rf-opt-ourl');
  ok('잠금: 옵션 링크 칸 전부 disabled', ourls.length === 2 && ourls.every(e => e.disabled === true));
  const locks = t.dom.byId.rf_opt_rows.querySelectorAll('.rf-opt-lock');
  ok('잠금 사유는 상품 그룹마다 한 줄(옵션 행마다 반복하지 않는다)', locks.length === 1);
  set('link', '쿠팡'); t.run('_syncOptUrlState()');
  ok('풀리면 disabled 해제 + 사유 줄 제거',
    t.dom.byId.rf_opt_rows.querySelectorAll('.rf-opt-ourl').every(e => e.disabled === false) &&
    t.dom.byId.rf_opt_rows.querySelectorAll('.rf-opt-lock').length === 0);
}

/* ══════════════ D. 잠긴 칸 = landingUrl 미전송 ══════════════ */
console.log('\n[D] 잠긴 칸은 landingUrl 을 전송하지 않는다(미전송 = 유지)');
{
  const t = makeTable();
  t.dom.byId.rf_inflow_type.value = 'link';
  t.dom.byId.rf_channel.value = '쿠팡';
  t.run(`renderOptRows([{ optKey:'블랙', landingUrl:'https://a.example/1' },{ optKey:'화이트' }], { mode:'opt' })`);
  const sent = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('열린 상태: landingUrl 키 전송', sent.length === 2 && sent[0].landingUrl === 'https://a.example/1');
  ok('열린 상태: 빈 옵션은 빈 문자열 전송(= 해제 의도)', sent[1].landingUrl === '');

  t.dom.byId.rf_channel.value = '네이버';
  const locked = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  ok('★ 잠긴 상태: landingUrl 키 자체가 없다(서버 COALESCE 유지)',
    locked.length === 2 && locked.every(o => !Object.prototype.hasOwnProperty.call(o, 'landingUrl')));
  ok('잠겨도 나머지 옵션 계약은 그대로(optKey·정원·마감상태)',
    locked[0].optKey === '블랙' && 'recruitTotal' in locked[0] && 'status' in locked[0]);

  // 편집 프리필: 저장된 옵션 주소가 그대로 칸에 들어온다
  ok('프리필: campaign_options.landing_url 이 옵션 칸으로 복원',
    /d\.landingUrl \?\? d\.landing_url/.test(recruitSrc));

  // none 모드: 숨은 칸 잔여값이 옵션 원장·원문으로 새지 않는다
  const t2 = makeTable();
  t2.run(`renderOptRows([{ optKey:'블랙', landingUrl:'https://a.example/1' }], { mode:'none' })`);
  ok('none 모드: 저장 옵션 0건', t2.run('JSON.stringify(readOptRows())') === '[]');
  const raw = JSON.parse(t2.run('JSON.stringify(_readProdRows())'));
  ok('none 모드: 파생 행에서 landingUrl 제거', raw.length === 1 && raw[0].landingUrl === '');
}

/* ══════════════ E. 랜딩 URL 은 파생 ══════════════ */
console.log('\n[E] 랜딩 URL = 첫 상품 URL 파생(읽기 전용)');
{
  ok('랜딩 URL 입력칸 readonly(표와 갈라지는 수정 창구 제거)',
    /id="rf_landing_url"[^>]*readonly/.test(modalSrc));

  const t = makeTable();
  t.run(`renderOptRows([
    { productName:'상품A', optKey:'블랙', productUrl:'https://a.example/1' },
    { productName:'상품A', optKey:'화이트', productUrl:'https://a.example/1' }
  ], { mode:'opt' })`);
  ok('첫 상품 URL 이 랜딩 칸에 자동으로 채워진다', t.dom.byId.rf_landing_url.value === 'https://a.example/1');
  ok('주소 1종이면 안내문은 기본 문구', /자동으로 채워집니다/.test(t.dom.byId.rf_landing_note.textContent));

  const t2 = makeTable();
  t2.run(`renderOptRows([
    { productName:'상품A', productUrl:'https://a.example/1', payAmount:1000 },
    { productName:'상품B', productUrl:'https://b.example/2', payAmount:2000 }
  ], { mode:'none' })`);
  ok('주소 2종: 첫 상품 URL 만 사용', t2.dom.byId.rf_landing_url.value === 'https://a.example/1');
  ok('주소 2종: 경고만 표기(막지 않는다)', /⚠[\s\S]*첫 상품 URL/.test(t2.dom.byId.rf_landing_note.textContent));

  // 서버 파생 규칙과 같은 답
  const srv = deriveCampaignLandingUrl([{ url: 'https://a.example/1' }, { url: 'https://b.example/2' }]);
  ok('서버 deriveCampaignLandingUrl 과 같은 규칙(첫 URL · multiDistinct)',
    srv.url === 'https://a.example/1' && srv.multiDistinct === true);
  ok('서버 위생: https 아닌 주소는 빈 값', sanitizeLandingUrl('javascript:alert(1)') === '');
}

/* ══════════════ F. 자동점검 = 전부 경고 ══════════════ */
console.log('\n[F] 게시 전 자동점검 — 경고 전용(D2)');
{
  const t = makeTable();
  t.dom.byId.rf_inflow_type.value = 'link';
  t.dom.byId.rf_channel.value = '쿠팡';
  t.run(`renderOptRows([
    { productName:'상품A', optKey:'블랙', productUrl:'https://a.example/1' },
    { productName:'상품A', optKey:'화이트', productUrl:'https://a.example/1', landingUrl:'ftp://nope' }
  ], { mode:'opt' })`);
  const items = JSON.parse(t.run('JSON.stringify(_optUrlCheckItems())'));
  ok('점검 항목이 나온다', items.length > 0);
  ok('★ 전부 warn — 하드블록 0(게시를 막지 않는다)', items.every(i => i.warn === true));
  ok('옵션 링크 미입력 건수를 말한다', items.some(i => /유입 링크가 없어요/.test(i.label)));
  ok('https 아닌 링크를 짚어 준다', items.some(i => /https:\/\/ 로 시작하지 않아/.test(i.label)));

  const t2 = makeTable();
  t2.run(`renderOptRows([{ productName:'상품A', payAmount:1000 }], { mode:'none' })`);
  const it2 = JSON.parse(t2.run('JSON.stringify(_optUrlCheckItems())'));
  ok('상품 URL 미입력도 경고만', it2.some(i => /상품 URL이 비어 있어요/.test(i.label)) && it2.every(i => i.warn === true));

  const t3 = makeTable();
  t3.dom.byId.rf_inflow_type.value = 'guide';
  t3.run(`renderOptRows([{ productName:'상품A', optKey:'블랙', productUrl:'https://a.example/1' }], { mode:'opt' })`);
  const it3 = JSON.parse(t3.run('JSON.stringify(_optUrlCheckItems())'));
  ok('잠긴 상태의 안내는 경고가 아니다(warn:false — 정상 상태를 붉게 칠하지 않는다)',
    it3.some(i => i.warn === false && /유입가이드/.test(i.label)));
  ok('잠긴 상태에서는 "옵션 링크 없음" 경고를 내지 않는다', !it3.some(i => /유입 링크가 없어요/.test(i.label)));

  ok('자동점검 배선은 fail-soft(try/catch)', /try \{ \(_optUrlCheckItems\(\) \|\| \[\]\)/.test(recruitSrc));
}

/* ══════════════ G. 배선 ══════════════ */
console.log('\n[G] 배선 — 유입방식 버튼군 · 저장 게이트 · 동기화');
{
  ok('유입방식 버튼군 3택(미지정·링크유입·유입가이드)',
    /id="rf_inflow_type_btns"/.test(modalSrc) &&
    /data-group="inflow_type" data-val=""/.test(modalSrc) &&
    /data-group="inflow_type" data-val="link"/.test(modalSrc) &&
    /data-group="inflow_type" data-val="guide"/.test(modalSrc));
  ok('hidden 입력 rf_inflow_type 존재(저장 계약)', /id="rf_inflow_type" type="hidden"/.test(modalSrc));
  ok('selectRfBtn 컨테이너 목록에 #rf_inflow_type_btns 포함(빠지면 버튼이 죽는다)',
    /closest\('[^']*#rf_inflow_type_btns'\)/.test(recruitSrc));
  ok('유입방식 선택 시 칸 잠금 재계산', /group === 'inflow_type'[\s\S]{0,260}_syncOptUrlState\(\)/.test(recruitSrc));
  ok('채널 변경 시에도 칸 잠금 재계산(네이버 전환 반영)',
    /group === 'channel'[\s\S]{0,400}_syncOptUrlState\(\)/.test(recruitSrc));

  // ★ "UI 있는 화면에서만 전송" — 유입방식 칸 없는 화면이 저장해도 설정이 안 풀린다
  ok('★ 저장 payload 는 버튼군이 있는 화면에서만 inflow_type 전송',
    /if \(document\.getElementById\("rf_inflow_type_btns"\)\) \{[\s\S]{0,180}payload\.inflow_type/.test(recruitSrc));
  ok('편집 프리필: 공고 inflow_type 을 버튼군에 복원',
    /_rfPickBtn\("inflow_type", String\(c\.inflow_type \|\| ""\)\)/.test(recruitSrc));
  // 편집 프리필의 `setV("rf_landing_url", c.landing_url)` 는 표가 그려지기 전 표시용이라 유지 —
  // 작업오더 프리필이 그 칸에 직접 쓰던 경로만 제거했다(표 파생이 곧바로 덮어써 값이 갈린다)
  ok('작업오더 프리필: landing_url 직접 주입 제거(표 파생으로 일원화)',
    !/prefill\.landing_url/.test(recruitSrc));
  ok('작업오더 링크유입 첫 URL 은 표의 첫 상품 URL 로 들어간다',
    /productUrl: i === 0 \? _pUrl : ""/.test(recruitSrc));
  ok('신규 공고 초기화에서 유입방식 비움(이전 공고 값 잔류 금지)',
    /_rfPickBtn\("inflow_type", ""\)/.test(recruitSrc));
  ok('미리보기 payload 가 inflowType 을 실제 값으로 넘긴다(하드코딩 "" 제거)',
    /inflowType: _v\("rf_inflow_type"\)/.test(recruitSrc));
  ok('변경 이력(diff) 필드에 유입방식 포함', /\["inflow_type",\s*"유입방식"\]/.test(recruitSrc));

  // 그룹 머리 상품 URL → 그 그룹 행의 숨은 칸으로 내려간다(상품명과 같은 규율)
  const t = makeTable();
  t.run(`renderOptRows([{ productName:'상품A', optKey:'블랙' },{ productName:'상품A', optKey:'화이트' }], { mode:'opt' })`);
  const gpUrl = t.dom.byId.rf_opt_rows.querySelector('.rf-gp-purl');
  ok('opt 모드 그룹 머리에 상품 URL 칸', !!gpUrl);
  gpUrl.value = 'https://a.example/9';
  gpUrl.fire('input');
  const rows = JSON.parse(t.run('JSON.stringify(_readProdRowsRaw())'));
  ok('그룹 상품 URL 이 그 그룹 옵션 행 전부로 내려간다',
    rows.length === 2 && rows.every(r => r.productUrl === 'https://a.example/9'));
  ok('그 값이 랜딩 URL 파생으로 이어진다', t.dom.byId.rf_landing_url.value === 'https://a.example/9');
}

/* ══════════════ H. 모듈이 실제로 뜨는가 (실측 사고 재발 차단) ══════════════ */
console.log('\n[H] recruit-modal.js 실행 — 템플릿 문자열 조기 종료 차단');
{
  /* ★★ 실측 사고(2026-08-10): CSS 블록은 **JS 템플릿 문자열 안**이라 주석에 백틱을 하나 쓰면
     문자열이 거기서 끝나고 뒤 문장이 코드로 파싱돼 `ReferenceError: opt is not defined` 로
     **모듈 전체가 죽는다**(모달이 아예 안 뜬다). `node --check` 는 통과하고 브라우저에서만
     드러났다 — 그래서 가드가 **모듈을 실제로 실행**한다(정적 grep 으로는 못 잡는다). */
  const mkNode = () => ({
    children: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, setAttribute() {}, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML() {},
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ''; },
  });
  const sb = {
    console,
    document: {
      getElementById: () => null, createElement: mkNode,
      querySelector: () => null, querySelectorAll: () => [],
      body: mkNode(), head: mkNode(), addEventListener() {}, readyState: 'complete',
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem: () => null, setItem() {} },
  };
  sb.window = sb;
  vm.createContext(sb);
  let boom = null;
  try { vm.runInContext(modalSrc, sb); } catch (e) { boom = e; }
  ok('recruit-modal.js 가 예외 없이 실행된다(백틱 조기 종료 = 모듈 전멸)', !boom);
  const api = sb.window.RecruitModal || {};
  ok('window.RecruitModal 공개 API 생존', typeof api.mount === 'function' && typeof api.html === 'string');
  const html = String(api.html || '');
  ok('마크업에 유입방식 버튼군·진행상품 표가 실제로 들어 있다',
    /id="rf_inflow_type_btns"/.test(html) && /id="rf_opt_rows"/.test(html) && /id="rf_landing_url"/.test(html));
  // CSS 는 별도 var 라 API 로 안 나온다 — 실행이 예외 없이 끝났다는 것 자체가 그 템플릿의 생존 증거다.
  // 여기서는 "주석에 백틱을 다시 넣지 않았는가"를 CSS 블록 범위에서 직접 본다.
  const cssBlk = /var CSS = `([\s\S]*?)`;/.exec(modalSrc);
  ok('CSS 템플릿이 한 덩어리로 닫힌다(내부 백틱 0)', !!cssBlk && cssBlk[1].indexOf('`') < 0);
  ok('CSS 블록이 끝까지 살아 있다(모드별 열 구성 선언 포함)',
    !!cssBlk && /rf-pm-opt \.rf-opt-row\{grid-template-columns/.test(cssBlk[1]));
}

console.log(`\n✅ optionLandingModal: ${passed} passed\n`);
process.exit(0);
