/**
 * 작업 업체 지정 팝업 — 거래처 **검색 콤보박스** 회귀가드 (사용자 요청 2026-08-24).
 *
 *   종전: `<select id="trTarget">` 에 전 업체를 늘어놓아 30곳이 넘으면 스크롤로 찾아야 했다.
 *   지금: 검색어로 좁혀 고르는 콤보박스(실시간 자동완성 · 업체명 · 담당 AE).
 *
 *   ★★ 이 파일이 고정하는 불변식
 *     1. 입력 중 팝업을 재렌더하지 않는다 — `_trRender` 는 팝업을 innerHTML 로 통째 교체하므로
 *        입력칸 DOM 이 다시 만들어져 **한글 IME 조합이 파괴된다**(`ㅁ며면면` 계열 실측 사고).
 *     2. 재료는 이미 받아 둔 `STATE.advs` 하나 — 신규 API 0(리스트 그리기에 api() 호출 없음).
 *     3. onclick 은 **인덱스만** — 업체명은 외부발 문자열(따옴표 하나로 탈출된다).
 *     4. "모른다"와 "없다"를 구분한다 — 목록을 못 받은 것을 "검색 결과 없음"으로 꾸미지 않는다.
 *     5. 후보 목록은 흐름 안(absolute 금지) — 팝업이 overflow-y:auto 라 띄우면 아래가 잘린다(실측 56px).
 *     6. `S.target` 계약(`'' | 업체id | '__new__'`)은 불변 — `ownTransferGo`·서버 무변경.
 * 실행: node tests/vendorAssignSearch.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ` — ${extra}` : '')); console.log('  ✓ ' + name); pass++; };
function grab(name, src = HTML) {
  let i = src.indexOf(`function ${name}(`);
  assert.ok(i > 0, `블록 추출: function ${name} 존재`);
  if (src.slice(i - 6, i) === 'async ') i -= 6;
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error(`${name} 블록 추출 실패`);
}
/** 줄 주석을 지우고 본다 — 주석 설명문이 대신 통과시키면 검사가 무의미해진다. */
const strip = (s) => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

/* ═══ 1. 되돌리기 차단 — 옛 <select> 창구가 없다 ═══════════════════════════ */
console.log('\n1) 옛 select 창구 부재');
t('★★ <select id="trTarget"> 가 없다', !/<select id="trTarget"/.test(HTML));
// ★ 산문(주석)이 대신 걸리지 않게 **정의·배선 형태**로 본다.
t('★ 옛 onchange 핸들러가 없다(정의·배선 모두)',
  !/function _trTargetSel\(/.test(HTML) && !/onchange="_trTargetSel/.test(HTML));
t('★ 검색 입력칸이 있다(#trAdvQ)', /id="trAdvQ"/.test(HTML) && /oninput="_trAdvInput\(this\.value\)"/.test(HTML));
t('★ 필드 렌더는 한 곳(_trTargetFieldHtml)', (HTML.match(/_trTargetFieldHtml\(/g) || []).length === 2);

/* ═══ 2. IME 보호 — 타이핑 경로에 팝업 재렌더가 없다 ═════════════════════════ */
console.log('\n2) 입력 중 재렌더 금지(IME)');
const inputFn = strip(grab('_trAdvInput'));
const paintFn = strip(grab('_trAdvPaint'));
t('★★ _trAdvInput 이 _trRender 를 부르지 않는다', !/_trRender\(/.test(inputFn), inputFn);
t('★★ _trAdvPaint 가 _trRender 를 부르지 않는다', !/_trRender\(/.test(paintFn));
t('★ 타이핑 때 손대는 DOM 은 리스트·안내문뿐',
  /getElementById\('trAdvSug'\)/.test(paintFn) && /getElementById\('trAdvHint'\)/.test(paintFn)
  && !/innerHTML=`<div class="owntr"/.test(paintFn));
// 고른 뒤에는 재렌더가 **있어야** 한다(선택 표시로 바뀐다) — 입력 중이 아니므로 IME 와 무관.
t('★ 고르면 재렌더한다(_trAdvPick/_trAdvNew/_trAdvChange)',
  /_trRender\(\)/.test(grab('_trAdvPick')) && /_trRender\(\)/.test(grab('_trAdvNew')) && /_trRender\(\)/.test(grab('_trAdvChange')));

/* ═══ 3. 재료·보간 규율 ═══════════════════════════════════════════════════ */
console.log('\n3) 재료 단일 출처 · onclick 인덱스');
t('★★ 리스트 그리기에 신규 API 호출이 없다(STATE.advs 하나)',
  !/api\(/.test(paintFn) && !/api\(/.test(strip(grab('_trAdvCands'))) && /STATE\.advs/.test(grab('_trAdvCands')));
t('★★ onclick 은 인덱스만(업체명 보간 0)',
  /onclick="_trAdvPick\(\$\{i\}\)"/.test(paintFn) && !/onclick="[^"]*\$\{esc\(a\.name\)/.test(paintFn));
t('★ 바깥 클릭 리스너는 최상위 1회',
  (HTML.match(/if\(!e\.target\.closest\('\.trac'\)\) _trAdvHide\(\);/g) || []).length === 1);

/* ═══ 4. 후보 계산·렌더 실제 실행 ═══════════════════════════════════════════ */
console.log('\n4) 후보 계산·렌더 vm 실행');
function mount(advs, S) {
  const sug = { innerHTML: '', classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } };
  const hint = { textContent: '', style: {} };
  const sb = {
    console, JSON, Object, Array, String, Number, Math, Set, Map, RegExp,
    STATE: { advs },
    _trS: S,
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    document: { getElementById: (id) => (id === 'trAdvSug' ? sug : id === 'trAdvHint' ? hint : null), querySelector: () => null },
  };
  sb.window = sb; vm.createContext(sb);
  vm.runInContext([grab('_trAdvNorm'), grab('_trAdvCands'), grab('_trAdvPaint'), grab('_trAdvPick'), grab('_trTargetFieldHtml'),
    'let _trAdvItems=[]; const _TR_ADV_CAP=8; function _trRender(){ _trS._rendered=(_trS._rendered||0)+1; }'].join('\n'), sb);
  return { sb, sug, hint };
}
const ADVS = [
  { id: 'a1', name: '주식회사 포파코', inadPm: '황운하' },
  { id: 'a2', name: '자연생각', inadPm: '김수민' },
  { id: 'a3', name: '주식회사 담영', inadPm: '이만수' },
  { id: 'a4', name: '와이투에스 코리아', inadPm: '황운하' },
];
{
  const { sb, sug, hint } = mount(ADVS, { kind: 'assign', from: null, q: '', kb: -1, target: '' });
  sb._trAdvPaint();
  t('★ 검색어 없으면 전체 후보', (sug.innerHTML.match(/class="sugitem/g) || []).length === ADVS.length + 1);  // +1 = 새 거래처 등록
  t('★ 업체명 부분일치', (() => { sb._trS.q = '포파'; sb._trAdvPaint(); return /포파코/.test(sug.innerHTML) && !/자연생각/.test(sug.innerHTML); })());
  t('★★ 담당 AE 로도 찾는다', (() => { sb._trS.q = '황운하'; sb._trAdvPaint(); return /포파코/.test(sug.innerHTML) && /와이투에스/.test(sug.innerHTML) && !/담영/.test(sug.innerHTML); })());
  t('★ 공백·대소문자 무시', (() => { sb._trS.q = '와이투에스코리아'; sb._trAdvPaint(); return /와이투에스/.test(sug.innerHTML); })());
  t('★ 결과 0 은 "없다"로 말한다', (() => { sb._trS.q = '없는업체'; sb._trAdvPaint(); return /일치하는 업체가 없습니다/.test(hint.textContent); })());
  t('★★ 결과 0 이어도 새 거래처 등록 줄은 남는다', /sugnew/.test(sug.innerHTML));
}
{
  // ★★ "모른다"(목록 미수신)를 "없다"로 꾸미지 않는다.
  const { sb, hint } = mount([], { kind: 'assign', from: null, q: '', kb: -1, target: '' });
  sb._trAdvPaint();
  t('★★ 목록 미수신은 "불러오지 못했습니다"', /불러오지 못했습니다/.test(hint.textContent) && !/일치하는 업체가 없습니다/.test(hint.textContent), hint.textContent);
}
{
  // ★ 절단은 조용히 하지 않는다(건수를 말한다).
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, name: '업체' + i, inadPm: '김수민' }));
  const { sb, sug, hint } = mount(many, { kind: 'assign', from: null, q: '', kb: -1, target: '' });
  sb._trAdvPaint();
  t('★ 상한 8곳까지 그린다', (sug.innerHTML.match(/class="sugitem"/g) || []).length === 8);
  t('★★ 잘린 건수를 말한다', /30곳 중 8곳 표시/.test(hint.textContent), hint.textContent);
}
{
  // ★ 이관은 원 소유 업체를 후보에서 뺀다(자기 자신으로 이관 금지 — 종전 select 와 같은 규칙).
  const { sb, sug } = mount(ADVS, { kind: 'transfer', from: { id: 'a1', name: '주식회사 포파코' }, q: '', kb: -1, target: '' });
  sb._trAdvPaint();
  t('★ 이관 후보에서 원 소유 업체 제외', !/포파코/.test(sug.innerHTML) && /자연생각/.test(sug.innerHTML));
}
{
  // ★★ XSS — 업체명에 따옴표·태그가 들어가도 마크업이 탈출되지 않는다.
  const { sb, sug } = mount([{ id: 'evil', name: `x"><img src=x onerror=alert(1)>`, inadPm: `'"` }], { kind: 'assign', from: null, q: '', kb: -1, target: '' });
  sb._trAdvPaint();
  t('★★ 업체명 escape', !/<img/.test(sug.innerHTML) && /&lt;img/.test(sug.innerHTML), sug.innerHTML.slice(0, 120));
}

/* ═══ 5. 선택 계약 — S.target 과 새 거래처 잔재 폐기 ═══════════════════════ */
console.log('\n5) 선택 계약(S.target)');
{
  const { sb, sug } = mount(ADVS, { kind: 'assign', from: null, q: '포파', kb: -1, target: '', newName: '옛 입력', newOk: true, newPm: '김수민' });
  sb._trAdvPaint();
  sb._trAdvPick(0);
  t('★ 고르면 S.target = 업체 id', sb._trS.target === 'a1', String(sb._trS.target));
  t('★ 검색어를 비운다', sb._trS.q === '');
  t('★★ 새 거래처 입력 잔재를 폐기한다(구 _trTargetSel 계약 승계)',
    sb._trS.newName === '' && sb._trS.newOk === false && sb._trS.newPm === '');
  const html = sb._trTargetFieldHtml(sb._trS);
  t('★ 고른 뒤에는 무엇을 골랐는지 보인다 + [변경]', /주식회사 포파코/.test(html) && /_trAdvChange\(\)/.test(html) && !/id="trAdvQ"/.test(html));
  t('★ 담당 AE 를 함께 보여준다(동명 구분)', /담당 황운하/.test(html));
}
{
  const S = { kind: 'assign', from: null, q: '', kb: -1, target: '__new__' };
  const { sb } = mount(ADVS, S);
  const html = sb._trTargetFieldHtml(S);
  t('★ __new__ 도 되돌릴 수 있다', /새 거래처 등록/.test(html) && /_trAdvChange\(\)/.test(html));
}
{ // ownTransferGo 의 소비 계약이 그대로다 — 서버 무변경의 근거.
  const go = strip(grab('ownTransferGo'));
  t('★★ ownTransferGo 는 종전대로 S.target 을 읽는다', /S\.target/.test(go) && /targetId==='__new__'/.test(go));
}

/* ═══ 6. 잘림 재발 차단(CSS) ═══════════════════════════════════════════════ */
console.log('\n6) 목록 잘림 차단');
t('★★ 후보 목록은 흐름 안(absolute 금지)', /\.owntr \.trac \.advsug\{position:static/.test(HTML));
t('★ 새 거래처 등록 줄은 목록 아래 고정', /\.owntr \.sugnew\{position:sticky;bottom:0/.test(HTML));
t('★ 새 CSS 는 팝업 스코프(.owntr) 안에만',
  ['.trac{', '.trsel{', '.sugnew{'].every(sel => {
    const i = HTML.indexOf(sel); return i > 0 && /\.owntr [^\n{]*$/.test(HTML.slice(HTML.lastIndexOf('\n', i), i + sel.length - 1).replace(/\n/, ''));
  }));

console.log(`\n✅ vendorAssignSearch: ${pass} 케이스 통과`);
