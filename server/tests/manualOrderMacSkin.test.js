'use strict';
/**
 * manualOrderMacSkin.test.js — 결정 347 외부모집 수동제출 창 맥 규칙 계약
 * 실행: node --test tests/manualOrderMacSkin.test.js   (DB·서버·브라우저 불필요)
 *
 * 창 범위 CSS(다른 화면에 새지 않음) · 색은 창 변수 한 곳에서만 · 채운 파란 단추 = 화면마다 1개 ·
 * 이모지 0 · 11px 미만 글자 0 · 휴대폰 = 아래에서 올라오는 시트 + 표 옆으로 밀기.
 */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MO = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'manual-order.js'), 'utf8');
const CSS = (() => { const a = MO.indexOf('st.textContent = `') + 'st.textContent = `'.length; return MO.slice(a, MO.indexOf('`;', a)); })();
const noComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** CSS 규칙 목록(@media 안쪽 포함) → [{ sel, body }] */
function rules(css) {
  const out = [];
  const src = noComments(css);
  let i = 0;
  const walk = (end) => {
    while (i < end) {
      const open = src.indexOf('{', i); if (open < 0 || open >= end) return;
      const head = src.slice(i, open).trim();
      if (head.startsWith('@media')) {
        let d = 1, k = open + 1; for (; k < src.length && d; k++) { if (src[k] === '{') d++; else if (src[k] === '}') d--; }
        assert.ok(/^@media screen and \(max-width:768px\)$/.test(head), '인쇄 등 다른 매체 규칙 금지: ' + head);
        i = open + 1; walk(k - 1); i = k; continue;
      }
      const close = src.indexOf('}', open);
      out.push({ sel: head, body: src.slice(open + 1, close) });
      i = close + 1;
    }
  };
  walk(src.length);
  return out;
}

test('① 모든 선택자가 창 id(#moOvl)로 시작 — 작업보드 다른 화면에 새지 않는다', () => {
  const R = rules(CSS);
  assert.ok(R.length > 40, '규칙을 읽었다: ' + R.length);
  for (const r of R) for (const s of r.sel.split(',')) assert.ok(/^#moOvl(\s|$|[.:#*])/.test(s.trim()) || s.trim() === '#moOvl', '창 밖 선택자: ' + s.trim());
});
test('② 색은 #moOvl 변수 한 곳에서만 정한다(직접 적은 #색·rgba 는 변수 정의 밖에 0)', () => {
  const R = rules(CSS);
  const root = R.find(r => r.sel === '#moOvl');
  assert.ok(root && /--mo-accent:#007aff/.test(root.body), '선택 표시는 맥 시스템 파랑(#007aff)');
  for (const r of R) {
    const body = r === root ? r.body.replace(/--mo-[\w-]+:[^;]+;/g, '') : r.body;
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(body), `직접 색: ${r.sel} { ${body.slice(0, 80)} }`);
  }
  // 화면에 그리는 HTML 안에도 직접 색 금지(style="color:…" 등)
  const html = MO.slice(MO.indexOf('function open('));
  assert.ok(!/style="[^"]*(color|background)\s*:/.test(html), 'HTML 인라인 색 금지');
});
test('③ 글자 11px 미만 0 · 굵기는 400·600·700만', () => {
  const sizes = [...noComments(CSS).matchAll(/font(?:-size)?:[^;}]*?(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 10);
  assert.ok(sizes.every(n => n >= 11), '11px 미만: ' + sizes.filter(n => n < 11).join(','));
  const weights = [...noComments(CSS).matchAll(/font-weight:(\d+)/g)].map(m => Number(m[1]));
  assert.ok(weights.every(w => [400, 600, 700].includes(w)), '굵기: ' + weights.join(','));
  // 줄 28px · 머리 31px · 칸 27~28px(표 안) · 단추 28px / 휴대폰 줄 44 · 입력 36(16px) · 단추 44
  assert.match(CSS, /#moOvl \.mo-tbl td\{height:28px;/);
  assert.match(CSS, /#moOvl \.mo-tbl th\{position:sticky;top:0;z-index:2;height:31px;/);
  assert.match(CSS, /#moOvl \.mo-btn\{[^}]*height:28px;/);
  assert.match(CSS, /@media screen and \(max-width:768px\)\{[\s\S]*#moOvl \.mo-tbl td\{height:44px\}[\s\S]*#moOvl \.mo-in\{height:36px;font-size:16px\}[\s\S]*#moOvl \.mo-btn\{height:44px;/);
});
test('④ 이모지·그림문자 0 (아이콘은 Font Awesome) · 대각선 화살표 0', () => {
  const pict = MO.match(/\p{Extended_Pictographic}/gu) || [];
  assert.deepStrictEqual(pict, [], '그림문자: ' + pict.join(''));
  assert.ok(!/[↗↖↘↙]/.test(MO));
  assert.ok(/class="fa-solid fa-xmark"/.test(MO) && /fa-triangle-exclamation/.test(MO) && /fa-circle-check/.test(MO));
  // 아이콘만 있는 단추는 title + aria-label
  const iconBtns = [...MO.matchAll(/<(button|label) [^>]*class="mo-(ib|x)[^"]*"[^>]*>/g)].map(m => m[0]);
  assert.ok(iconBtns.length >= 4);
  for (const b of iconBtns) assert.ok(/title="/.test(b) && /aria-label="/.test(b), '아이콘 단추에 title·aria-label: ' + b.slice(0, 80));
});
test('⑤ 채운 파란 단추는 화면마다 1개 — 표 화면 [N건 제출] · 보완 목록 [N건 보완] · 결과 화면 [완료]', () => {
  const pri = [...MO.matchAll(/class="mo-btn pri"/g)].length;
  assert.strictEqual(pri, 3, '표·보완 목록(결정 349 화면)·결과 세 화면 각 1개');
  const cmp = MO.slice(MO.indexOf('function renderComplete()'), MO.indexOf('async function submitComplete()'));
  assert.strictEqual((cmp.match(/mo-btn pri/g) || []).length, 1, '보완 목록 화면도 1개');
  const tableFoot = MO.slice(MO.indexOf("`<button type=\"button\" class=\"mo-btn\" onclick=\"ManualOrder.close(true)\">닫기</button>"));
  assert.ok(/class="mo-btn pri" id="moSubmit"/.test(tableFoot.slice(0, 600)));
  const resFoot = MO.slice(MO.indexOf('function renderResult('));
  assert.strictEqual((resFoot.slice(0, resFoot.indexOf('// 목록/관제가')).match(/mo-btn pri/g) || []).length, 1);
  assert.ok(!/linear-gradient|radial-gradient/.test(CSS), '그라데이션 금지');
});
test('⑥ 휴대폰 = 아래에서 올라오는 시트(폭 가득·위 모서리만 둥글게) · 표는 옆으로 밀기', () => {
  assert.match(CSS, /@media screen and \(max-width:768px\)\{\s*#moOvl\{align-items:flex-end;padding:0\}\s*#moOvl \.mo-box,#moOvl \.mo-box\.narrow\{width:100%;max-height:94vh;border-radius:12px 12px 0 0\}/);
  assert.match(CSS, /#moOvl \.mo-bd\{overflow:auto;/);
  assert.match(CSS, /#moOvl \.mo-tbl\{[^}]*overflow:visible\}/, '작업보드 전역 table{overflow:hidden} 무효화 — 남으면 머리 줄·칸 고정이 안 된다');
});
test('⑦ 금액은 고정폭 숫자·오른쪽 정렬 · 선택 줄은 #007aff 계열', () => {
  assert.match(CSS, /#moOvl \.mo-in\.num\{text-align:right;font-variant-numeric:tabular-nums\}/);
  assert.ok(/fieldCell\('price', \{ label: '금액', num: true \}\)/.test(MO));
  assert.match(CSS, /#moOvl \.mo-tbl tr\.sel td\{background:var\(--mo-accent-bg\)\}/);
});
test('⑧ 표 칸은 목록 하나(cols)에서 그린다 — 후속 칸(리뷰어 고르기·동시진행 네이버/쿠팡)은 항목 추가로', () => {
  const c = MO.slice(MO.indexOf('function cols()'), MO.indexOf('function rowHtml('));
  assert.ok(/const L = \[/.test(c) && /L\.push\(\{ k: 'cap'/.test(c) && /L\.push\(\{ k: 'st'/.test(c));
  const r = MO.slice(MO.indexOf('function renderPreview()'), MO.indexOf('function paint()'));
  // 결정 349 화면: 머리 줄은 headHtml(C) 하나가 그린다(동시진행 모드의 「네이버」「쿠팡」 묶음 머리 포함) — 같은 목록 C 에서
  const h = MO.slice(MO.indexOf('function headHtml(C)'), MO.indexOf('function rowHtml('));
  assert.ok(/const C = cols\(\);/.test(r) && /<thead>\$\{headHtml\(C\)\}<\/thead>/.test(r) && /C\.map\(c => th\(c\)\)/.test(h) && /rowHtml\(it, i, C\)/.test(r), '머리·줄·폭이 같은 목록에서');
});
