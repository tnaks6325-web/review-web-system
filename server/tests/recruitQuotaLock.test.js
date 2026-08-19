/**
 * 모집공고 수정 화면이 캠페인 정원(총인원·일건수)을 리셋하지 못하게 하는 회귀가드 (2026-08-19)
 *
 * 실사고: 총 200건 · 일건수 10건으로 조절해 둔 공고를 [수정]에서 저장하면 총량이 **무제한(0)** 이
 *   되고 일건수가 엉뚱한 값으로 바뀌었다. 원인 = 이 표의 총인원·일건수가 **캠페인 정원의 파생
 *   입력**인데, 옵션 없는 작업은 옵션 원장이 비어 있어 표를 작업내용 상품 원문에서 **다시 파싱**해
 *   만들고, 원문이 두 줄 이상이면 인원이 0 으로 떨어져 그대로 저장됐다(실브라우저 재현).
 *
 * 규칙(사용자 확정 2026-08-19): 총인원·일건수는 **작업오더에서 받은 값으로 고정**하고,
 *   조절은 [📅 모집인원 조절]에서 **총건수가 지켜지는 범위 안에서만** 한다.
 *   ★ 수정 화면에는 해제(직접 수정) 창구를 두지 않는다 — 창구가 둘이면 같은 사고가 그 문으로 다시 들어온다.
 *
 * 실행: node tests/recruitQuotaLock.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', p), 'utf8');
const app = read('index-recruit.js');
const modal = read('recruit-modal.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };

/* ── 판정(실행) ─────────────────────────────────────────────── */
{
  const src = app.match(/function _rfQuotaLocked\([\s\S]*?\n}/)[0];
  const call = (editId, mode) => {
    const sandbox = { _recruitEditId: editId, _prodMode: () => mode };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return vm.runInContext('_rfQuotaLocked()', sandbox);
  };
  ok('수정 + 옵션 없는 작업 → 잠금', call('C1', 'none') === true);
  ok('★ 신규 발행은 잠그지 않는다(초도 정원을 정하는 유일한 창구)', call(null, 'none') === false);
  ok('★ 옵션 있는 작업은 잠그지 않는다(옵션 원장이 서버에서 와 파생이 정확)', call('C1', 'opt') === false);
  ok('★ 잠금을 푸는 조건이 없다(수정 화면에는 해제 창구가 없다)', !/_rfQuotaUnlock/.test(app));
}

/* ── 파생·전송 차단 ─────────────────────────────────────────── */
ok('잠금이면 캠페인 정원을 표에서 다시 만들지 않는다',
  /if \(!_rfQuotaLocked\(\)\) \{\s*\n\s*if \(rt\) rt\.value =[\s\S]{0,240}?if \(dl\) dl\.value =/.test(app));
ok('★ 잠금이면 저장 payload 에 총인원·일건수를 싣지 않는다(서버 COALESCE 유지)',
  /if \(!_rfQuotaLocked\(\)\) \{\s*\n\s*payload\.daily_limit\s*=[\s\S]{0,200}?payload\.recruit_total\s*=/.test(app));
ok('입력칸을 읽기 전용으로 잠근다',
  /if \(_rfQuotaLocked\(\)\) \{[\s\S]{0,400}?el\.readOnly = true;/.test(app));
ok('프리필은 캠페인 원장 값을 첫 행에 싣는다(상품 줄 수와 무관 — 종전 0 리셋 경로 차단)',
  /recruitTotal: i === 0 \? \(fallback\.recruit_total \?\? 0\) : 0/.test(app)
  && /dailyLimit: i === 0 \? \(fallback\.daily_limit \?\? 0\) : 0/.test(app)
  && !/singleProduct \? \(fallback\.recruit_total/.test(app));

/* ── 화면·탈출구 ────────────────────────────────────────────── */
ok('안내 줄이 마크업에 있다(라이브 영역)', /id="rf_quota_lock"/.test(modal));
ok('잠금 스타일이 모달 CSS 에 스코프되어 있다',
  /#recruitModal \.rf-quota-lock\{/.test(modal) && /#recruitModal \.rf-opt-row input\.rf-locked\{/.test(modal));
ok('안내가 변경 창구([📅 인원])를 문장으로 알려준다', /모집인원 조절/.test(app) && /인원\]/.test(app));
ok('★ 해제 버튼·전역이 남아 있지 않다(창구는 [📅 인원] 하나)',
  !/rfQuotaUnlock/.test(app) && !/window\.rfQuotaLock\b/.test(app)
  && !/rf-qbtn/.test(app) && !/rf-qbtn/.test(modal));
ok('안내가 "작업오더 값으로 고정"과 "총건수 안에서 조절"을 말한다',
  /작업오더 값으로 고정/.test(app) && /총건수 안에서/.test(app));
ok('입력이 바뀌면 안내 숫자도 따라온다', /_syncQuotaLockUi\(\);\s*\/\/ 해제 상태에서/.test(app));

console.log(`\nrecruitQuotaLock: ${passed} passed`);
