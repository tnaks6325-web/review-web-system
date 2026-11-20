'use strict';
/**
 * captureClassifyMatch.test.js — 결정 383: 옵션 없는 「택1」 공고의 분류 후보 짝짓기(productCaptureMatch 단일 출처)
 * 실행: node tests/captureClassifyMatch.test.js
 *
 * 기대값 = 2026-11-18 올리브영 세라모사이드 캡처 30장 실측(measure.md) — 틀림 0 이 요구 조건이다.
 *   ① 옵션 글자만 대조 ② 상품명은 옵션 줄이 아예 없고 후보가 하나만 보일 때만 ③ 짧은 후보(`피치`)도 `피치맛` 안에서 걸린다.
 */
const assert = require('assert');
const path = require('path');
const m = require('../src/utils/productCaptureMatch');
const FIX = require(path.join(__dirname, 'fixtures/oliveyoungCeramoFlavorCaptures.json'));

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }
const mk = a => a.map(s => ({ opt_key: s, product_name: s }));
const cls = (name, option, cands = FIX.candidates) => m.classifyCaptureCandidate({ productName: name, productOption: option }, cands);

ok('표본이 실측 집계를 그대로 재현한다(운영 짝짓기 그대로 = 맞음 9 · 틀림 19 · 미분류 2 / 옵션 글자만+○○맛 = 27·0·3)', () => {
  const tally = fn => {
    let good = 0, bad = 0, none = 0;
    for (const s of FIX.samples) { const r = fn(s); if (!r) none++; else if (r.replace(/맛$/, '') === s.truth) good++; else bad++; }
    return [good, bad, none];
  };
  const A = mk(['피치', '레몬', '스트로베리']), B = mk(['피치맛', '레몬맛', '스트로베리맛']);
  assert.deepEqual(tally(s => m.matchOption(`${s.name} ${s.option}`.trim(), A, { shortText: s.option })), [9, 19, 2]);
  assert.deepEqual(tally(s => m.matchOption(`${s.name} ${s.option}`.trim(), B, { shortText: s.option })), [1, 1, 28]);
  assert.deepEqual(tally(s => m.matchOption(s.option, A, { shortText: s.option })), [9, 0, 21]);
  assert.deepEqual(tally(s => m.matchOption(s.option, B, { shortText: s.option })), [27, 0, 3]);
  const by = {}; FIX.samples.forEach(s => { by[s.truth] = (by[s.truth] || 0) + 1; });
  assert.deepEqual(by, { 레몬: 9, 피치: 12, 스트로베리: 9 });
});

ok('★ 30장 실측 표본: 틀림 0 · 맛 하나로 확정 30장(오타 `레몬밋` · 옵션 칸에 상품명이 섞인 #145 · 옵션 줄 없는 #127 포함)', () => {
  const wrong = [], none = [];
  for (const s of FIX.samples) {
    const r = cls(s.name, s.option);
    if (!r) none.push(s.rn); else if (r !== s.truth) wrong.push(`${s.rn}:${r}≠${s.truth}`);
  }
  assert.deepEqual(wrong, [], '틀린 분류가 하나라도 있으면 안 된다');
  assert.deepEqual(none, [], '실측 표본은 전부 하나로 정해진다');
  assert.equal(cls('[먹박스속] 세라마이드 피치/레몬/스트로베리 28정', '세라마이드레몬밋 28정'), '레몬', '#190 오타');
  assert.equal(cls('[2주보습캔디] 세라모사이드 피치맛 28정', ''), '피치', '#127 옵션 줄 없음 → 상품명 하나');
});

ok('후보를 `○○맛` 으로 적어도 같다(공통 꼬리 `맛` 을 떼고 본다 · 돌려주는 값은 직원이 적은 그대로)', () => {
  const C = '피치맛, 레몬맛, 스트로베리맛';
  for (const s of FIX.samples) assert.equal(cls(s.name, s.option, C), s.truth + '맛', `#${s.rn}`);
});

ok('★ 상품명은 보조뿐 — 옵션 글자가 있으면 상품명을 보지 않는다 · 상품명에 후보 둘 이상이면 모른다', () => {
  // 옵션 글자에 맛이 없으면(28정만) 상품명에 맛이 하나 있어도 쓰지 않는다
  assert.equal(cls('세라모사이드 피치맛 28정', '옵션: 28정 (2주분)'), '');
  // 옵션 줄 없음 + 상품명에 세 맛 → 모름(운영 짝짓기 19장 틀림의 원인)
  assert.equal(cls('[먹바속촉] 세라모사이드 피치맛/레몬맛/스트로베리맛 28정', ''), '');
  // 옵션 칸이 「옵션:」 머리말만 → 옵션 줄 없음과 같다
  assert.equal(cls('[2주보습캔디] 세라모사이드 레몬맛 28정', '옵션 :'), '레몬');
  // 아무 글자도 없음
  assert.equal(cls('', ''), '');
});

ok('★ 둘 이상이면 모른다(완화 금지) — 장바구니 두 맛 · 옵션 줄 두 개 · 머리말 앞에 한 맛이 따로 보임', () => {
  assert.equal(cls('', '옵션: 피치맛 28정 / 레몬맛 28정'), '');
  assert.equal(cls('', '옵션: 세라모사이드 피치맛 28정 옵션: 세라모사이드 레몬맛 28정'), '');
  assert.equal(cls('', '피치맛 1개 옵션: 레몬맛 28정'), '', '머리말 앞 글자가 맛 하나를 말하면 함께 센다');
  // 머리말 앞이 상품 제목(맛 셋 나열)이면 머리말 뒤만 본다(#145 유형)
  assert.equal(cls('', '세라마이드 피치맛/레몬맛/스트로베리맛 28정 옵션: 세라마이드 피치맛 28정'), '피치');
  // 머리말 없이 옵션 칸에 세 맛 → 모름
  assert.equal(cls('', '세라마이드 피치맛/레몬맛/스트로베리맛 28정'), '');
});

ok('짧은 영문·숫자 후보는 따로 쓴 글자만(`XL` 속 `L` ✗ · `KS-100` 속 `100` ✗) · 한 글자 한글은 낱말 일치만', () => {
  assert.equal(cls('', '옵션: 블랙 / XL', 'S, M, L'), '');
  assert.equal(cls('', '옵션: 블랙 / L', 'S, M, L'), 'L');
  assert.equal(cls('', '옵션: XL', 'S, M, L, XL'), 'XL', '긴 후보 안의 짧은 후보는 따로 보일 때만');
  assert.equal(cls('', '모델 KS-100 블루', '100, 200'), '');
  assert.equal(cls('', '옵션: 킹사이즈', '킹, 퀸'), '');
  assert.equal(cls('', '옵션: 킹 / 그레이', '킹, 퀸'), '킹');
});

ok('후보끼리 겹치면 긴 쪽을 먼저(`레몬라임` 안의 `레몬` 은 따로 세지 않는다) · 둘 다 따로 보이면 모름', () => {
  assert.equal(cls('', '옵션: 레몬라임맛', '레몬, 레몬라임, 자몽'), '레몬라임');
  assert.equal(cls('', '옵션: 레몬맛 + 레몬라임맛', '레몬, 레몬라임, 자몽'), '');
});

ok('호수·색상처럼 숫자·한글이 섞인 후보 · 전각/대소문자 정규화', () => {
  assert.equal(cls('', '옵션: 21호 라이트베이지', '13호, 21호, 23호'), '21호');
  assert.equal(cls('', '옵션: ２３호', '13호, 21호, 23호'), '23호');
  assert.equal(cls('', '옵션: Black', 'black, white'), 'black');
});

ok('후보 읽기: 쉼표·빗금·가운뎃점·줄바꿈으로 나눈다 · 하나뿐이면 띄어쓰기로 나눈다 · 같은 글자는 하나로 · 둘 미만이면 꺼짐', () => {
  assert.deepEqual(m.parseClassifyCandidates('피치, 레몬, 스트로베리'), ['피치', '레몬', '스트로베리']);
  assert.deepEqual(m.parseClassifyCandidates('피치/레몬/스트로베리'), ['피치', '레몬', '스트로베리']);
  assert.deepEqual(m.parseClassifyCandidates('피치 레몬 스트로베리'), ['피치', '레몬', '스트로베리'], '「/」가 지워진 글(운영 실측)');
  assert.deepEqual(m.parseClassifyCandidates('라이트 베이지, 내추럴 베이지'), ['라이트 베이지', '내추럴 베이지']);
  assert.deepEqual(m.parseClassifyCandidates('피치 · 피치 · 레몬\n자몽'), ['피치', '레몬', '자몽']);
  assert.deepEqual(m.parseClassifyCandidates(''), []);
  assert.deepEqual(m.parseClassifyCandidates(null), []);
  assert.equal(m.formatClassifyCandidates(['피치', '레몬']), '피치, 레몬');
  assert.equal(cls('', '옵션: 피치맛', '피치'), '', '후보 하나 = 기능 꺼짐(고를 것이 없다)');
  assert.equal(cls('', '옵션: 피치맛', ''), '');
});

ok('★ 결정 230 짝짓기(matchOption)는 그대로 — 새 규칙은 분류 전용 함수에만', () => {
  // 약한 이름 보호: `피치` 는 matchOption 에서 여전히 `피치맛` 속 글자로 걸리지 않는다
  assert.equal(m.matchOption('옵션: 피치맛', mk(['피치', '레몬'])), '');
  assert.equal(m.matchOption('킹사이즈', mk(['킹', '퀸'])), '');
});

console.log(`\n✅ captureClassifyMatch: ${passed} passed`);
