/**
 * 모집공고 수정 화면이 캠페인 정원(총인원·일건수)을 리셋하지 못하게 하는 회귀가드 (2026-08-19)
 *
 * 실사고: 총 200건 · 일건수 10건으로 조절해 둔 공고를 [수정]에서 저장하면 총량이 **무제한(0)** 이
 *   되고 일건수가 엉뚱한 값으로 바뀌었다. 원인 = 이 표의 총인원·일건수가 **캠페인 정원의 파생
 *   입력**인데, 옵션 없는 작업은 옵션 원장이 비어 있어 표를 작업내용 상품 원문에서 **다시 파싱**해
 *   만들고, 원문이 두 줄 이상이면 인원이 0 으로 떨어져 그대로 저장됐다(실브라우저 재현).
 *
 * 규칙(사용자 확정): 정원 변경 창구는 [📅 모집인원 조절] 하나 — 수정 화면은 보여주기만 한다.
 *   단 기본 일건수를 고칠 다른 창구가 없으므로 [🔓 직접 수정] 탈출구를 남기되,
 *   열면 "저장하면 무엇으로 덮이는지"를 화면이 말한다(조용한 리셋 금지).
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
  const src = ['_rfQuotaApplicable', '_rfQuotaLocked']
    .map((fn) => app.match(new RegExp('function ' + fn + '\\([\\s\\S]*?\\n}'))[0]).join('\n');
  const call = (editId, mode, unlocked) => {
    const sandbox = { _recruitEditId: editId, _prodMode: () => mode, _rfQuotaUnlock: unlocked };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return vm.runInContext('_rfQuotaLocked()', sandbox);
  };
  ok('수정 + 옵션 없는 작업 → 잠금', call('C1', 'none', false) === true);
  ok('★ 신규 발행은 잠그지 않는다(초도 정원을 정하는 유일한 창구)', call(null, 'none', false) === false);
  ok('★ 옵션 있는 작업은 잠그지 않는다(옵션 원장이 서버에서 와 파생이 정확)', call('C1', 'opt', false) === false);
  ok('사람이 연 상태(직접 수정)는 잠금 해제', call('C1', 'none', true) === false);
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
ok('★ 탈출구는 confirm 을 거치고 전역으로 노출된다',
  /function rfQuotaUnlock\(\) \{\s*\n\s*if \(!confirm\(/.test(app)
  && /window\.rfQuotaUnlock = rfQuotaUnlock;/.test(app)
  && /window\.rfQuotaLock = rfQuotaLock;/.test(app));
ok('★ 열린 상태에서는 저장 시 덮일 값을 문장으로 말한다(조용한 리셋 금지)',
  /상태로 덮어씁니다/.test(app));
ok('★ 모달을 열 때마다 잠금이 초기화된다(지난 공고의 해제가 새지 않게)',
  /_rfQuotaUnlock = false;\s*\/\/ ★ 지난 공고에서 연 잠금이 다음 공고로 새지 않게/.test(app));
ok('입력이 바뀌면 안내 숫자도 따라온다', /_syncQuotaLockUi\(\);\s*\/\/ 해제 상태에서/.test(app));

console.log(`\nrecruitQuotaLock: ${passed} passed`);
