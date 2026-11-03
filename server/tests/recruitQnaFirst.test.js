/**
 * 결정 321 변경(사용자 확정 2026-11-03 「탭 구분 없이 첫 번째로」) — 리뷰어 모집 목록의 리뷰체험단(처음 열리는) 탭
 * 맨 앞에 Q&A 공고를 띄운다. Q&A 탭은 그대로, 블로그 탭에는 섞지 않는다.
 * ★ 정렬은 공용 카드 모듈 `CampCards.qnaFirst` 한 곳(모집 페이지·첫 화면 미리보기가 같이 쓴다 — 사본 금지).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let fails = 0;
function ok(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) fails++; }
const root = path.join(__dirname, '..', '..', 'frontend');
const cc = fs.readFileSync(path.join(root, 'js', 'campaign-cards.js'), 'utf8');
const RH = fs.readFileSync(path.join(root, 'recruit.html'), 'utf8');
const IH = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ① qnaFirst 실제 실행 — Q&A 앞으로 · 각 묶음 안 순서 유지(안정)
const s = cc.indexOf('function qnaFirst(');
const fnSrc = cc.slice(s, cc.indexOf('\n  }\n', s) + 4);
const sb = {}; vm.createContext(sb); vm.runInContext(fnSrc + '\nthis.qnaFirst = qnaFirst;', sb);
const L = [{ id: 'r1', work_kind: '' }, { id: 'q1', work_kind: 'qna' }, { id: 'r2', work_kind: 'review' }, { id: 'q2', work_kind: 'qna' }, null];
ok('Q&A 가 맨 앞, 묶음 안 순서는 그대로', JSON.stringify(sb.qnaFirst(L).map(c => c && c.id)) === JSON.stringify(['q1', 'q2', 'r1', 'r2', null]));
ok('빈 목록·없음도 안전', sb.qnaFirst([]).length === 0 && sb.qnaFirst(null).length === 0);
ok('CampCards 로 노출', /window\.CampCards = \{[^}]*sortByAvailability, qnaFirst,/.test(cc));

// ② 두 목록이 같은 규칙 — 리뷰 탭이면 Q&A 도 보이고, 정렬은 가용성 → Q&A 앞으로
for (const [name, H] of [['recruit.html', RH], ['index.html', IH]]) {
  ok(`${name}: 리뷰 탭에 Q&A 도 보인다(Q&A 탭·블로그 탭은 종전)`, H.includes('function _rcShown(c){ const k = _rcKindOf(c); return k === _rcKind || (_rcKind === "review" && k === "qna"); }'));
  ok(`${name}: 참여형 목록이 _rcShown 으로 거르고 qnaFirst(sortByAvailability(...)) 순서`, /CampCards\.qnaFirst\(CampCards\.sortByAvailability\(/.test(H) && /c\.participation_mode && c\.status !== "closed" && _rcShown\(c\)/.test(H));
}
// ③ 판정 실행 — 탭별로 무엇이 보이나
const shown = (H) => { const a = H.indexOf('function _rcKindOf('); const b = H.indexOf('function _rcShown('); const src = H.slice(a, H.indexOf('\n', a)) + '\n' + H.slice(b, H.indexOf('\n', b)); return (kind, wk) => { const x = { _rcKind: kind }; vm.createContext(x); vm.runInContext(src + `\nthis.r = _rcShown({ work_kind: ${JSON.stringify(wk)} });`, x); return x.r; }; };
for (const [name, H] of [['recruit.html', RH], ['index.html', IH]]) {
  const f = shown(H);
  ok(`${name}: 리뷰 탭 = 리뷰·Q&A / 블로그 제외`, f('review', '') && f('review', 'qna') && !f('review', 'blog'));
  ok(`${name}: Q&A 탭 = Q&A 만 · 블로그 탭 = 블로그 만`, f('qna', 'qna') && !f('qna', '') && f('blog', 'blog') && !f('blog', 'qna'));
}
console.log(fails ? `\n✗ ${fails}건 실패` : '\n✓ 전부 통과');
process.exit(fails ? 1 : 0);
