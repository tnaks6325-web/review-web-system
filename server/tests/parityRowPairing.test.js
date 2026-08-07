/**
 * parityRowPairing.test.js — 회귀가드: 한 번호에 여러 줄인 사람은 **줄 번호로 짝을 맞춘다**
 * 실행: node tests/parityRowPairing.test.js
 *
 * 배경(운영 실측 2026-08-07): 탈시트 이관에서 9개 작업이 "설명되지 않는 차이"로 잠겨 있었는데,
 *   실제 시트와 작업보드 표를 **줄 번호끼리** 대조하니 2,300여 줄이 한 칸도 다르지 않았다.
 *   원인 = parity 가 phone8 로 묶은 뒤 **각 목록의 첫 줄만** 맞대 봤고, 가족 공용 번호·차수
 *   재참여로 한 번호에 여러 줄인 작업에서 두 목록의 순서가 달라 **서로 다른 줄끼리** 비교됐다.
 *
 * 고정하는 것:
 *  A. 순서가 뒤섞여도 줄 번호로 짝지어 비교한다(허위 불일치 0)
 *  B. 그래도 **진짜 차이는 그대로 잡는다**(완화 아님) + 어느 줄인지 말한다
 *  C. 짝짓기 **키는 여전히 phone8**(행번호 금지 원칙 불변) — A_only/B_only 판정 무변경
 *  D. 줄 번호가 없으면 종전 폴백(순서대로) — 못 맞췄다고 통과시키지 않는다
 *  E. 재료 배선 — A(review_index.row_index) · B(campaign_participants.seq) 를 실제로 읽는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let passed = 0;
const ok = (name, cond) => { assert(cond, name); passed++; console.log('  ✓ ' + name); };

const { classifyParity } = require('../src/services/trackB.service');

/* 실측 재현 픽스처 — 위프 800건 탭의 한 번호(뒤4 0135)에 4줄, 시트와 표의 값은 줄마다 같다. */
const A = [
  { phone8: '51470135', name: '김영숙', submitted: true, paid: true, round: '', row: 23 },
  { phone8: '51470135', name: '박세희', submitted: false, paid: false, round: '', row: 164 },
  { phone8: '51470135', name: '김현숙', submitted: false, paid: false, round: '', row: 166 },
  { phone8: '51470135', name: '박세희', submitted: true, paid: true, round: '', row: 21 },
];
// ★ B 는 **일부러 다른 순서** — 종전 구현은 A[0](23행) 과 B[0](164행) 을 맞대 "차이"라 했다.
const B = [
  { phone8: '51470135', name: '박세희', submitted: false, paid: false, round: '', row: 164, source: 'import' },
  { phone8: '51470135', name: '김영숙', submitted: true, paid: true, round: '', row: 23, source: 'import' },
  { phone8: '51470135', name: '박세희', submitted: true, paid: true, round: '', row: 21, source: 'import' },
  { phone8: '51470135', name: '김현숙', submitted: false, paid: false, round: '', row: 166, source: 'import' },
];

console.log('\n[A] 순서가 뒤섞여도 줄 번호로 짝짓는다');
{
  const r = classifyParity(A, B);
  ok('★★ 값이 줄마다 같으면 진짜 차이 0 (허위 불일치 재발 차단)', r.buckets.real === 0 && r.pass === true);
  ok('그 사람은 일치 1건으로 센다(사람 단위 계수 유지)', r.buckets.match === 1);
}
{
  /* 차수 재참여형(유일기획 실측) — 같은 번호가 1차·1-2차·1-4차로 여러 줄, 순서만 다르다. */
  const a = [
    { phone8: '11117191', submitted: true, paid: true, round: '1차', row: 57 },
    { phone8: '11117191', submitted: true, paid: true, round: '1-2차', row: 64 },
    { phone8: '11117191', submitted: true, paid: true, round: '1-4차', row: 89 },
  ];
  const b = [a[2], a[0], a[1]].map(x => ({ ...x, source: 'import' }));
  ok('★ 차수가 줄마다 달라도 줄 번호로 맞추면 일치', classifyParity(a, b).buckets.real === 0);
}

console.log('\n[B] 진짜 차이는 그대로 잡는다 (완화 아님)');
{
  const b2 = B.map(x => (x.row === 23 ? { ...x, submitted: false, paid: false } : x));
  const r = classifyParity(A, b2);
  ok('★★ 한 줄이라도 값이 다르면 real (fail-closed 방향 불변)', r.buckets.real === 1 && r.pass === false);
  ok('★ 어느 줄이 다른지 말한다(화면·보고서가 행을 짚을 수 있게)',
    r.realSample[0].kind === 'state_diff' && r.realSample[0].row === 23);
  ok('★ 뒤 4자리만 노출(마스킹 유지)', /^•+\d{4}$/.test(r.realSample[0].phone8));
}
{
  /* ★★ 비교 항목 3종(제출·입금·차수)이 전부 살아 있어야 한다 — 하나라도 빠지면 그 종류의
   *    불일치가 조용히 통과한다(변이시험 M4 가 실제로 빠져나갔다). */
  const base = { phone8: '99998888', submitted: true, paid: true, round: '1-3차', row: 73 };
  const only = (k, v) => classifyParity([base], [{ ...base, [k]: v, source: 'import' }]).buckets.real;
  ok('★★ 제출만 달라도 real', only('submitted', false) === 1);
  ok('★★ 입금만 달라도 real', only('paid', false) === 1);
  ok('★★ 차수만 달라도 real (유일기획 실측 유형)', only('round', '1-4차') === 1);
}
{
  // 편집(BD-8)은 종전대로 benign — 의도된 차이
  const b2 = B.map(x => (x.row === 23 ? { ...x, submitted: false, paid: false } : x));
  const r = classifyParity(A, b2, new Set(['51470135']));
  ok('의도된 편집은 benign 유지', r.buckets.real === 0 && r.buckets.benign === 1);
}

console.log('\n[C] 짝짓기 키는 여전히 phone8 — 멤버십 판정 무변경');
{
  const a = [{ phone8: '11112222', submitted: true, paid: false, round: '', row: 10 }];
  const b = [{ phone8: '33334444', submitted: true, paid: false, round: '', row: 10, source: 'import' }];
  const r = classifyParity(a, b);
  ok('★★ 줄 번호가 같아도 번호가 다르면 A_only + B_only (행번호 짝짓기 금지 원칙 유지)',
    r.buckets.real === 2 && r.realSample.some(x => x.kind === 'A_only') && r.realSample.some(x => x.kind === 'B_only'));
  const r2 = classifyParity(a, [{ ...b[0], source: 'manual' }]);
  ok('manual B-only 는 종전대로 benign', r2.realSample.filter(x => x.kind === 'B_only').length === 0);
}
{
  // 같은 번호인데 줄 번호가 서로 없는 짝(표에만 있는 줄) — 멤버십은 phone8 이라 real 로 안 샌다
  const a = [{ phone8: '55556666', submitted: true, paid: true, round: '', row: 30 }];
  const b = [{ phone8: '55556666', submitted: true, paid: true, round: '', row: 30, source: 'import' },
    { phone8: '55556666', submitted: false, paid: false, round: '', row: 900001, source: 'manual' }];
  ok('★ 짝지을 A 가 없는 B 줄은 종전대로 무시(멤버십은 phone8)', classifyParity(a, b).buckets.real === 0);
}

console.log('\n[D] 줄 번호가 없으면 종전 폴백 (순서대로)');
{
  const a = A.map(({ row, ...x }) => x), b = B.map(({ row, ...x }) => x);
  ok('★★ 줄 번호가 없으면 순서대로 맞대 종전과 같은 결과(모른다고 통과시키지 않는다)',
    classifyParity(a, b).buckets.real === 1);
  // 한쪽만 줄 번호가 있는 과도기(구버전 데이터)도 폴백으로 수렴
  const half = classifyParity(A, b);
  ok('★ 한쪽만 줄 번호가 있어도 예외 없이 판정한다', typeof half.buckets.real === 'number');
}

console.log('\n[E] 재료 배선 — 줄 번호를 실제로 읽어 온다');
{
  const src = noLineComments(read('src/services/trackB.service.js'));
  /* ★ 단언은 **_parityCore 본문 안**을 지목한다 — 파일 전체를 보면 다른 쿼리의 같은 표현이
   *   이 검사를 대신 통과시킨다(변이시험 M7 이 실제로 그렇게 새어 나갔다). */
  const i0 = src.indexOf('async function _parityCore(');
  const i1 = src.indexOf('\nasync function ', i0 + 10);
  const core = i0 > 0 ? src.slice(i0, i1 > 0 ? i1 : undefined) : '';
  ok('_parityCore 본문을 찾았다', !!core);
  ok('★ A 는 review_index.row_index 를 읽는다', /row_index AS "?row"?/.test(core));
  ok('★ B 는 campaign_participants.seq 를 읽는다', /seq AS "?row"?/.test(core));
  ok('★ 짝짓기 함수가 줄 번호로 맞춘다', /function _pairByRow\(/.test(src) && /bByRow\.get\(String\(a\.row\)\)/.test(src));
  ok('★★ 대표 1쌍 비교(arr[0] vs bl[0])는 부활하지 않았다',
    !/const a = arr\[0\], b = bl\[0\]/.test(src));
}

console.log(`\n✅ parityRowPairing: ${passed} cases passed`);
process.exit(0);
