/**
 * 모집공고 수정 화면의 정원(총인원·일건수) 규칙 회귀가드
 *
 * 이력
 *  - 2026-08-19 오전: 저장하면 총량이 무제한(0)으로 리셋되던 실사고 → 두 칸을 **읽기 전용으로 잠갔다**.
 *    원인 = 이 표의 두 칸이 캠페인 정원의 **파생 입력**인데, 옵션 없는 작업은 옵션 원장이 비어
 *    표를 상품 원문에서 다시 파싱해 만들고, 합계 규칙("하나라도 0이면 무제한")이 0 을 만들었다.
 *  - 2026-08-19 오후(사용자 확정): **잠금을 푼다** — 초도 세팅이 잘못 들어온 공고를 여기서
 *    바로잡아야 한다. 대신 ① 경고 문구를 남기고 ② **수정 모드에서는 합계가 아니라 첫 행 값을
 *    그대로 정원으로 쓴다**(0 리셋 경로 차단) ③ 프리필이 원장 값을 첫 행에 싣는다.
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
  const src = app.match(/function _rfQuotaNotice\([\s\S]*?\n}/)[0];
  const call = (editId, mode) => {
    const sandbox = { _recruitEditId: editId, _prodMode: () => mode };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return vm.runInContext('_rfQuotaNotice()', sandbox);
  };
  ok('수정 + 옵션 없는 작업 → 경고 + 첫 행 값 사용', call('C1', 'none') === true);
  ok('★ 신규 발행은 경고 없음(초도 정원을 정하는 유일한 창구)', call(null, 'none') === false);
  ok('★ 옵션 있는 작업은 종전대로(옵션 원장이 서버에서 와 파생이 정확)', call('C1', 'opt') === false);
  ok('★★ 잠금 함수는 남아 있지 않다(두 칸은 수정 가능해야 한다 — 사용자 확정)',
    !/_rfQuotaLocked/.test(app) && !/rf-locked/.test(app));
}

/* ── 파생·전송 ──────────────────────────────────────────────── */
ok('★★ 수정 모드에서는 합계가 아니라 **첫 행 값**을 정원으로 쓴다(합계 0 리셋 차단)',
  /if \(_rfQuotaNotice\(\)\) \{[\s\S]{0,500}?const head = live\[0\][\s\S]{0,300}?rt\.value = Number\(head\.recruitTotal\)[\s\S]{0,300}?dl\.value = Number\(head\.dailyLimit\)/.test(app));
ok('신규 발행은 종전 합계 규칙 유지(하나라도 0이면 무제한)',
  /\} else \{\s*\n\s*if \(rt\) rt\.value = live\.length && live\.every\(r => r\.recruitTotal > 0\)/.test(app));
ok('★★ 저장 payload 에 총인원·일건수를 **항상 싣는다**(사람이 고친 값이 저장돼야 한다)',
  /payload\.daily_limit\s*=[\s\S]{0,200}?payload\.recruit_total\s*=/.test(app)
  && !/if \(!_rfQuotaLocked\(\)\) \{\s*\n\s*payload\.daily_limit/.test(app));
ok('★ 입력칸을 읽기 전용으로 잠그지 않는다', !/el\.readOnly = true;/.test(app));
ok('프리필은 캠페인 원장 값을 첫 행에 싣는다(상품 줄 수와 무관 — 0 리셋 경로 차단)',
  /recruitTotal: i === 0 \? \(fallback\.recruit_total \?\? 0\) : 0/.test(app)
  && /dailyLimit: i === 0 \? \(fallback\.daily_limit \?\? 0\) : 0/.test(app)
  && !/singleProduct \? \(fallback\.recruit_total/.test(app));

/* ── 화면(경고) ─────────────────────────────────────────────── */
ok('안내 줄이 마크업에 있다(라이브 영역)', /id="rf_quota_lock"/.test(modal));
ok('안내 스타일이 모달 CSS 에 스코프되어 있다', /#recruitModal \.rf-quota-lock\{/.test(modal));
ok('★★ 사용자 확정 문구 그대로 — "함부로 수정하지마세요 · 모집인원조절 기능"',
  /총건수과 일건수는 초기작업세팅값이므로 함부로 수정하지마세요, 필요시 모집인원조절 기능을 사용하세요/.test(app));
ok('안내가 변경 창구([📅 인원])를 문장으로 알려준다', /모집인원 조절/.test(app) && /인원\]/.test(app));
ok('입력이 바뀌면 안내 숫자도 따라온다', /_syncQuotaLockUi\(\);\s*\/\/ 해제 상태에서/.test(app));

console.log(`\nrecruitQuotaLock: ${passed} passed`);
