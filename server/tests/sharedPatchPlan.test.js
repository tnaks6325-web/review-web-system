'use strict';
/**
 * 회귀가드 — 양방향 동기화 3방향 병합 판정 (결정 263 · 심판 최종안 2단계)
 *
 * 실행: node tests/sharedPatchPlan.test.js
 *
 * ★ 지키는 것(판정 9갈래 + 상품·옵션 + 변이):
 *   ① 안 보낸 칸 → 무시          ② base 와 같음 → 무시(theirs 가 바뀌었어도 덮지 않는다)
 *   ③ 인트라넷 고유 칸을 리뷰웹발로 고침 → readOnly     ④ 인트라넷발·대조(reconcile)는 고유 칸도 쓸 수 있다
 *   ⑤ theirs 가 이미 mine → same     ⑥ theirs = base → write     ⑦ 양쪽이 다르게 고침 → conflict
 *   ⑧ forceMine(사람이 고름) → write   ⑨ 표기만 다름(거짓 vs 0) → 아무 일 없음
 *   ⑩ 같은 상품의 다른 옵션을 각각 고침 → 충돌 아님   ⑪ 옵션 삭제는 그 경로의 쓰기   ⑫ 이름 변경(prev_label)은 같은 경로의 이름 칸
 *   ⑬ 변이 — 판정 줄 하나를 바꾸면 위 사례 중 하나 이상이 반드시 실패한다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const FILE = path.join(__dirname, '../src/utils/sharedPatchPlan.js');
const SRC = fs.readFileSync(FILE, 'utf8');

function load(src) {
  const m = new Module(FILE, module);
  m.filename = FILE;
  m.paths = Module._nodeModulePaths(path.dirname(FILE));
  m._compile(src, FILE);
  return m.exports;
}

const P = (v) => JSON.stringify(v);
const prod = (opts, extra = {}) => P([{ name: 'A', product_mode: 'opt', url: 'https://a', options: opts, ...extra }]);
const BASE = {
  title: '작업', review_fee: 1000, skip_weekends: false, purchase_time: '13:00 ~ 18:00',
  product_options_json: prod([{ label: '빨강', pay: 1000, count: 5 }, { label: '파랑', pay: 1200, count: 5 }]),
};

/** 사례 표 — [이름, 입력, 기대 판정 검사]. 변이 시험이 같은 표를 쓴다. */
const CASES = [
  ['① 안 보낸 칸은 무시', { mine: { title: '작업' }, theirs: { ...BASE, review_fee: 1500 }, origin: 'intranet' },
    r => r.writes.length === 0 && r.conflicts.length === 0 && r.same.length === 0],
  ['② base 와 같으면 theirs 가 바뀌었어도 덮지 않는다', { mine: { ...BASE }, theirs: { ...BASE, review_fee: 1500 }, origin: 'intranet' },
    r => r.writes.length === 0 && r.conflicts.length === 0],
  ['③ 리뷰웹발로 인트라넷 고유 칸(작업명) 수정 → readOnly', { mine: { ...BASE, title: '바꿈' }, theirs: BASE, origin: 'campaign' },
    r => r.readOnly.length === 1 && r.readOnly[0].path === 'f:title' && r.writes.length === 0],
  ['④ 인트라넷발은 고유 칸을 쓴다', { mine: { ...BASE, title: '바꿈' }, theirs: BASE, origin: 'intranet' },
    r => r.writes.length === 1 && r.writes[0].path === 'f:title'],
  ['④-1 대조(reconcile)도 고유 칸을 쓴다', { mine: { ...BASE, title: '바꿈' }, theirs: BASE, origin: 'reconcile' },
    r => r.writes.length === 1 && r.readOnly.length === 0],
  ['⑤ theirs 가 이미 mine 과 같으면 same', { mine: { ...BASE, review_fee: 1500 }, theirs: { ...BASE, review_fee: 1500 }, origin: 'campaign' },
    r => r.same.length === 1 && r.writes.length === 0],
  ['⑥ theirs = base 면 write', { mine: { ...BASE, review_fee: 1500 }, theirs: BASE, origin: 'campaign' },
    r => r.writes.length === 1 && r.writes[0].path === 'f:review_fee' && r.writes[0].mine === '1500'],
  ['⑦ 양쪽이 같은 칸을 다르게 고치면 conflict', { mine: { ...BASE, review_fee: 1500 }, theirs: { ...BASE, review_fee: 2000 }, origin: 'intranet' },
    r => r.conflicts.length === 1 && r.writes.length === 0 && r.conflicts[0].theirs === '2000'],
  ['⑧ 사람이 고르면(forceMine) write', { mine: { ...BASE, review_fee: 1500 }, theirs: { ...BASE, review_fee: 2000 }, origin: 'intranet', forceMine: ['f:review_fee'] },
    r => r.writes.length === 1 && r.conflicts.length === 0],
  ['⑨ 표기만 다르면(거짓 vs 0 · 시간 띄어쓰기) 아무 일 없음', { mine: { ...BASE, skip_weekends: 0, purchase_time: '13:00~18:00' }, theirs: BASE, origin: 'intranet' },
    r => r.writes.length + r.conflicts.length + r.same.length + r.readOnly.length === 0],
  ['⑩ 같은 상품의 다른 옵션을 각각 고치면 충돌 아님', {
    mine: { ...BASE, product_options_json: prod([{ label: '빨강', pay: 1100, count: 5 }, { label: '파랑', pay: 1200, count: 5 }]) },
    theirs: { ...BASE, product_options_json: prod([{ label: '빨강', pay: 1000, count: 5 }, { label: '파랑', pay: 1200, count: 9 }]) }, origin: 'intranet' },
    r => r.conflicts.length === 0 && r.writes.length === 1 && r.writes[0].path === 'p:A|o:빨강.pay'],
  ['⑪ 옵션을 지우면 그 옵션 경로들이 "없음"으로 쓰인다', {
    mine: { ...BASE, product_options_json: prod([{ label: '빨강', pay: 1000, count: 5 }]) }, theirs: BASE, origin: 'intranet' },
    r => r.conflicts.length === 0 && r.writes.some(w => w.path === 'p:A|o:파랑' && w.mine === '∅')],
  ['⑪-1 지운 옵션을 상대가 그 사이 고쳤으면 충돌', {
    mine: { ...BASE, product_options_json: prod([{ label: '빨강', pay: 1000, count: 5 }]) },
    theirs: { ...BASE, product_options_json: prod([{ label: '빨강', pay: 1000, count: 5 }, { label: '파랑', pay: 1500, count: 5 }]) }, origin: 'intranet' },
    r => r.conflicts.some(c => c.path === 'p:A|o:파랑.pay')],
  ['⑫ 옵션 이름 변경(prev_label)은 같은 경로의 label 칸 쓰기 + 이름 바꿈 기록', {
    mine: { ...BASE, product_options_json: prod([{ label: '빨강', pay: 1000, count: 5 }, { label: '하늘', prev_label: '파랑', pay: 1200, count: 5 }]) },
    theirs: BASE, origin: 'intranet' },
    r => r.conflicts.length === 0 && r.writes.length === 1 && r.writes[0].path === 'p:A|o:파랑.label'
      && r.renames.length === 1 && r.renames[0].from === '파랑' && r.renames[0].to === '하늘'],
];

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

function runCases(mod) {
  const failed = [];
  for (const [name, input, check] of CASES) {
    let ok = false;
    try { ok = check(mod.planSharedPatch({ base: BASE, ...input })); } catch (_) { ok = false; }
    if (!ok) failed.push(name);
  }
  return failed;
}

const real = load(SRC);
for (const [name, input, check] of CASES) {
  t(name, () => {
    const r = real.planSharedPatch({ base: BASE, ...input });
    assert.ok(check(r), JSON.stringify(r));
  });
}

t('origin 없이 부르면 던진다(어디서 온 수정인지 모르면 주인 판정을 못 한다)', () => {
  assert.throws(() => real.planSharedPatch({ base: BASE, mine: BASE, theirs: BASE }), /origin/);
});

const MUTANTS = [
  ['① 안 보낸 칸 건너뛰기 제거', 'if (m === undefined) continue;', 'if (m === undefined) { /* mutant */ }'],
  ['② base 비교 제거', 'if (m === b) continue;', 'if (false) continue;'],
  ['③ 주인 판정 뒤집기', "pathOwner(path) === 'intranet' && !intranetMayWrite", "pathOwner(path) === 'intranet' && intranetMayWrite"],
  ['⑤ same 판정 제거', 'if (t === m) { out.same.push(row); continue; }', ''],
  ['⑥ write 조건 넓히기', 'if (t === b || force.has(path))', 'if (true)'],
  ['⑧ forceMine 무시', 'if (t === b || force.has(path))', 'if (t === b)'],
  ['⑨ 정규화 대신 원문 비교', "paths.set('f:' + f.key, canon(f.key, s[f.key]));", "paths.set('f:' + f.key, String(s[f.key]));"],
  ['⑪ 삭제 감지 제거', "(productLike && st.hasProducts ? ABSENT : undefined)", "undefined"],
  ['⑫ 이름 변경 무시', "const ok = prevLabel || label;", "const ok = label;"],
];
for (const [name, from, to] of MUTANTS) {
  t(`⑬ 변이 「${name}」 → 사례가 반드시 실패한다`, () => {
    assert.ok(SRC.includes(from), `변이 지점을 못 찾았다: ${from}`);
    const failed = runCases(load(SRC.replace(from, to)));
    assert.ok(failed.length > 0, '변이가 살아남았다 — 사례 표가 그 판정을 지키지 못한다');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
