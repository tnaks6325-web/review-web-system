/**
 * recruitClosedOnlyQuotaPrefill.test.js
 *   — 마감 옵션만 있는 공고의 총인원 프리필 회귀가드 (2026-08-23 실사고)
 * 실행: node tests/recruitClosedOnlyQuotaPrefill.test.js
 *
 * 사고: DB `recruit_total = 200` 인데 모집공고 편집 화면의 총인원이 **공란**이었고,
 *   200 을 다시 넣어 저장해도 다시 열면 또 공란이었다(사용자 신고 "저장이 안 된다").
 *   저장은 매번 정상이었다 — **다시 열 때 화면이 200 을 0 으로 덮고 있었다.**
 *
 * 원인 체인(실브라우저 추적으로 확정):
 *   ① 프리필 `setV("rf_recruit_total", 200)` → 200
 *   ② `renderOptRowsWithProduct` 가 `opts.length`(마감 포함)로 분기해
 *      "옵션 없는 공고" 폴백(캠페인 원장 정원을 첫 행에)을 **건너뛰고**
 *      마감 옵션의 `recruitTotal: 0` 을 첫 행에 실었다
 *   ③ `_syncPreviewFromOptRows` 의 `head = live[0] || rows[0]` 가 그 마감 행을 채택 → 0
 *   ④ 화면 공란
 *
 * 고정하는 것:
 *   A. 살아있는 옵션 판정은 `status !== 'closed'` — `opts.length` 로 되돌리면 실패
 *   B. 마감만 있는 공고는 캠페인 원장 정원이 첫 행에 실린다(신고 케이스)
 *   C. 살아있는 옵션이 하나라도 있으면 **종전 동작 100% 불변**
 *   D. 원장 값이 0·미상이면 건드리지 않는다(공개 화이트리스트 뷰·구버전 백엔드)
 *   E. 마감 행은 표에서 사라지지 않는다([↩ 재개] 경로 보존)
 *   F. `_syncPreviewFromOptRows` 의 `head` 폴백(`live[0] || rows[0]`) 생존
 *      — 이 수정이 그 폴백을 통해 값을 전달한다
 *
 * ★ 정적 grep 이 아니라 **함수를 vm 으로 꺼내 실제 실행**한다(DOM 불필요 —
 *   `renderOptRowsWithProduct` 의 의존은 `parseProductLinesToRows`·`renderOptRows` 둘뿐이라
 *   후자를 스파이로 갈아끼우면 "첫 행에 무엇이 실렸나"를 그대로 볼 수 있다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/js/index-recruit.js'), 'utf8');
let passed = 0;
const ok = (name, cond) => { assert(cond, name); passed++; console.log('  ✓ ' + name); };

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

/** 표에 실제로 실린 행 목록을 돌려준다(renderOptRows 를 스파이로 대체) */
function render(options, productLines, campaign) {
  const box = { rows: null, opts: null };
  const sandbox = {
    console,
    renderOptRows(list, o) { box.rows = list; box.opts = o; },
  };
  vm.createContext(sandbox);
  vm.runInContext(grab(SRC, 'parseProductLinesToRows'), sandbox);
  vm.runInContext(grab(SRC, 'renderOptRowsWithProduct'), sandbox);
  sandbox.__args = [options, productLines, campaign];
  vm.runInContext('renderOptRowsWithProduct(__args[0], __args[1], __args[2])', sandbox);
  return box;
}

const LINES = '이노크아든 빨아쓰는 면마스크 - 결제금액 9,900원';
/* ★ 마감 옵션의 정원은 캠페인 원장과 **다른 값**이어야 한다 — 같은 값(0/30)으로 두면
   "원장 값을 실었다"와 "옵션 값을 그대로 뒀다"가 구분되지 않아 가드가 공허해진다(변이시험 실측). */
const CLOSED = [{ optKey: 'https: mkt.shopping.naver.com link abc', payAmount: 9900, recruitTotal: 7, dailyLimit: 5, status: 'closed' }];
const LIVE   = [{ optKey: '옵션A', payAmount: 9900, recruitTotal: 150, dailyLimit: 20, status: 'active' }];
const CAMP   = { recruit_total: 200, daily_limit: 30 };

console.log('\n§A 살아있는 옵션 판정');
{
  /* 마감만 있는 공고에서 원장 값이 첫 행에 실려야 한다 — `opts.length` 분기로 되돌리면 0 이 실린다 */
  const r = render(CLOSED, LINES, CAMP);
  ok('B. 마감만 있는 공고 — 첫 행 총인원 = 캠페인 원장 200 (신고 케이스)', r.rows[0].recruitTotal === 200);
  ok('B. 마감만 있는 공고 — 첫 행 일건수 = 캠페인 원장 30', r.rows[0].dailyLimit === 30);
  ok('E. 마감 행이 표에서 사라지지 않는다', r.rows.length === CLOSED.length && r.rows[0].status === 'closed');
  ok('A. 마감 옵션의 자기 값(7)이 첫 행에 남지 않는다', r.rows[0].recruitTotal !== 7);
}

console.log('\n§B 살아있는 옵션이 있으면 종전 동작 불변');
{
  const r = render(LIVE, LINES, CAMP);
  ok('C. 옵션 값이 그대로 (원장 값이 덮지 않는다)', r.rows[0].recruitTotal === 150 && r.rows[0].dailyLimit === 20);
}
{
  /* 마감 + 살아있는 옵션이 섞이면 살아있는 쪽이 있으므로 원장 값을 싣지 않는다 */
  const r = render([...CLOSED, ...LIVE], LINES, CAMP);
  ok('C. 마감+활성 혼재 — 첫 행(마감)도 원장 값으로 덮지 않는다', r.rows[0].recruitTotal === 7 && r.rows[0].dailyLimit === 5);
  ok('C. 마감+활성 혼재 — 행 수 보존', r.rows.length === 2);
}

console.log('\n§C 모르는 값은 지어내지 않는다');
{
  const r0 = render(CLOSED, LINES, { recruit_total: 0, daily_limit: 0 });
  ok('D. 원장 정원이 0 이면 옵션 값을 0 으로 덮지 않는다', r0.rows[0].recruitTotal === 7 && r0.rows[0].dailyLimit === 5);
  const ru = render(CLOSED, LINES, {});
  ok('D. 원장 정원이 미상(공개 뷰·구버전)이면 옵션 값 유지', ru.rows[0].recruitTotal === 7 && ru.rows[0].dailyLimit === 5);
  const rn = render(CLOSED, LINES, null);
  ok('D. campaign 인자 자체가 없어도 죽지 않는다', rn.rows.length === 1 && rn.rows[0].recruitTotal === 7);
}

console.log('\n§D 옵션 0개 공고(종전 폴백) 무회귀');
{
  const r = render([], LINES, CAMP);
  ok('옵션 0개 — 첫 행에 원장 정원(200)', r.rows[0].recruitTotal === 200);
  ok('옵션 0개 — mode "none" 강제 유지', r.opts && r.opts.mode === 'none');
  ok('옵션 0개 — 추측 옵션명을 승격시키지 않는다', r.rows.every(x => !x.optKey));
}

console.log('\n§E 배선 계약');
{
  const fn = grab(SRC, 'renderOptRowsWithProduct');
  ok('A. 살아있는 옵션 판정에 status 비교가 있다', /!==\s*["']closed["']/.test(fn));
  ok('마감 행을 걸러내지 않는다(표에서 filter 로 제거 금지)', !/opts\.filter\s*\(/.test(fn));
  const sync = grab(SRC, '_syncPreviewFromOptRows');
  ok('F. head 폴백(live[0] || rows[0])이 살아 있다', /live\[0\]\s*\|\|\s*rows\[0\]/.test(sync));
  ok('F. 표가 비면 정원을 다시 만들지 않는다(|| null + if(head)) 유지',
     /\|\|\s*null\s*;/.test(sync) && /if\s*\(head\)/.test(sync));
}

console.log(`\n✅ recruitClosedOnlyQuotaPrefill: ${passed} 케이스 통과\n`);
