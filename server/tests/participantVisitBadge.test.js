/**
 * participantVisitBadge.test.js — 회귀가드: 참여자 칸 참여횟수 배지 (사용자 확정 2026-08-19)
 * 실행: node tests/participantVisitBadge.test.js
 *
 * 확정 규칙:
 *  ① 세는 단위는 리뷰어(소유자)가 아니라 **계정 명의(phone8)** — 한 사람이 본계정 1회·타계정 1회면
 *     둘 다 [1회]이고, 같은 타계정으로 또 참여해야 [2회].
 *  ② 집계 범위는 **이 작업(탭) 안**.
 *  ③ 색은 1회 파랑 / 2회 노랑 / 3회 이상 빨강이고 **숫자는 실제 횟수**(4회·5회도 빨강).
 *  ④ 종전 `주문` 배지만 교체 — `수동`·🔒 는 유지.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

/* ── 스텁 pool: SQL 조각으로 분기. ★ 더 좁은 조건을 먼저 둔다(스텁 매칭 순서 함정). ── */
function makePool(roster, edits) {
  return {
    query: async (sql) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(q)) return { rows: [{ n: 0 }] };
      if (/FROM campaign_participants/.test(q) && /ORDER BY seq/.test(q)) return { rows: roster };
      if (/FROM participant_edits/.test(q)) return { rows: edits || [] };
      if (/FROM tab_configs/.test(q)) return { rows: [{ campaignName: 'c', displayName: 'd', gid: '' }] };
      return { rows: [] };
    },
  };
}
const R = (seq, name, p8, extra) => Object.assign({
  id: 'r' + seq, seq, name, recipient: name, phone8: p8, round: null, option: null, product: null,
  submitted: false, paid: false, source: 'import', order_submission_id: null, identity_key: 'ik' + seq,
  row_json: {}, submit_col: null, submit_col2: null,
}, extra || {});

console.log('\n[A] 서버 — 명의(phone8)별 순번을 센다');
{
  const T = require('../src/services/trackB.service');
  const run = async (roster, edits) => {
    T.__setPoolForTest(makePool(roster, edits));
    try { return await T.workdeskTab({ sheetId: 's1', tabName: 't1', role: 'master' }); }
    finally { T.__setPoolForTest(null); }
  };

  return run([
    /* 김수만(소유자)이 본계정 1 · 명지수 계정 2 — 사용자가 든 예시 그대로 */
    R(1, '김수만', '11111111'),
    R(2, '명지수', '22222222'),
    R(3, '명지수', '22222222'),
    R(4, '홍길동', ''),          // 명의 미상(빈 슬롯) — 세지 않는다
  ]).then(async res => {
    const by = Object.fromEntries(res.roster.map(r => [r.seq, r.visitNo]));
    ok('본계정 1회', by[1] === 1, JSON.stringify(by));
    ok('타계정 첫 참여도 1회(소유자가 같아도 계정이 다르면 새로 센다)', by[2] === 1);
    ok('같은 계정 두 번째 = 2회', by[3] === 2);
    ok('명의 미상 줄은 세지 않는다(undefined — 0/1 로 꾸미지 않는다)', by[4] === undefined);

    /* ★★ 행 숨김 기능은 폐기됐다(사용자 확정 2026-08-23) — 옛 `_hidden` 오버레이가 남아 있어도
       그 줄은 표에 그대로 있고, 따라서 참여횟수도 정상적으로 센다(표의 줄 수와 배지가 갈리지 않는다). */
    const res2 = await run(
      [R(10, '가', '33333333'), R(11, '가', '33333333'), R(12, '가', '33333333')],
      [{ anchor_type: 'identity', anchor_value: 'ik11', field: '_hidden', kind: 'bool', value_bool: true, value_text: null }],
    );
    const seqs = res2.roster.map(r => [r.seq, r.visitNo]);
    ok('옛 숨김 오버레이가 있어도 줄이 빠지지 않고 순번도 이어진다',
      JSON.stringify(seqs) === JSON.stringify([[10, 1], [11, 2], [12, 3]]), JSON.stringify(seqs));

    /* 광고주 렌즈: 마스킹 전 원본으로 세야 한다 — 마스킹 뒤에 세면 전 줄이 같은 값이 되어 1,2,3… 이 된다 */
    const res3 = await run([R(20, '가', '44444444'), R(21, '나', '55555555'), R(22, '가', '44444444')]);
    const v3 = res3.roster.map(r => r.visitNo);
    ok('서로 다른 명의는 각각 1회부터', JSON.stringify(v3) === JSON.stringify([1, 1, 2]), JSON.stringify(v3));

    console.log('\n[B] 서버 — 마스킹 전에 센다(코드 순서 계약)');
    const src = read('src/services/trackB.service.js');
    const iVisit = src.indexOf('visitSeen.set(_vp8');
    const iMask = src.indexOf('if (maskPII) { syn.phone8 = _mask(');
    ok('visitNo 계산이 maskPII 보다 앞', iVisit > 0 && iMask > 0 && iVisit < iMask);

    console.log('\n[C] 프론트 — 배지 렌더러는 한 벌');
    const wd = read('../frontend/workdesk.html');
    ok('_visitBadge 정의는 1개', (wd.match(/function _visitBadge\(/g) || []).length === 1);
    ok('두 렌더러(기본 표·시트 그리드)가 모두 호출', (wd.match(/_visitBadge\(r\)/g) || []).length - 1 === 2,
    '정의 1 + 호출 2 여야 한다');
    ok('종전 `주문` 배지 마크업은 제거', !/class="src order"/.test(wd));
    ok('`수동` 배지는 유지(사용자 확정 ④)', /class="src manual"/.test(wd));
    ok('🔒 편집 잠금 배지는 유지', /class="lock"/.test(wd));
    ok('복사값에서 참여횟수 배지를 뺀다(표 복사에 "2회" 가 섞이지 않게)', /querySelectorAll\('[^']*\.visit[^']*'\)/.test(wd));

    console.log('\n[D] 프론트 — 색 3단계 + 숫자는 실제 횟수');
    const vm = require('vm');
    const m = wd.match(/function _visitBadge\(r\)\{[\s\S]*?\n\}/);
    ok('_visitBadge 본문 추출', !!m);
    const ctx = vm.createContext({});
    vm.runInContext(m[0], ctx);
    const call = r => vm.runInContext('_visitBadge(' + JSON.stringify(r) + ')', ctx);
    ok('1회 = v1', /class="visit v1"/.test(call({ visitNo: 1, hasOrder: true })));
    ok('2회 = v2', /class="visit v2"/.test(call({ visitNo: 2, hasOrder: true })));
    ok('3회 = v3', /class="visit v3"/.test(call({ visitNo: 3, hasOrder: true })));
    ok('5회도 v3 이고 숫자는 5회(사용자 확정 ③)', /class="visit v3"/.test(call({ visitNo: 5, hasOrder: true })) && />5회</.test(call({ visitNo: 5, hasOrder: true })));
    ok('값이 없으면 아무것도 그리지 않는다(모르는 것을 1회로 꾸미지 않는다)', call({ hasOrder: true }) === '' && call({ visitNo: 0 }) === '');
    ok('주문 연결 여부는 툴팁으로 남는다(정보 손실 0)',
      /주문과 연결된 줄/.test(call({ visitNo: 1, hasOrder: true })) && /주문 연결 없음/.test(call({ visitNo: 1, hasOrder: false })));

    console.log('\n[E] CSS — 세 단계 색이 정의돼 있다');
    ok('.visit 기본(1회)', /\.visit\{[^}]*background:#dbeafe/.test(wd));
    ok('.visit.v2', /\.visit\.v2\{[^}]*background:#fef3c7/.test(wd));
    ok('.visit.v3', /\.visit\.v3\{[^}]*background:#fee2e2/.test(wd));

    console.log('\n통과: ' + passed + '건');
    process.exit(0);
  }).catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
}
