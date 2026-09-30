/**
 * 모집공고 수정 저장이 조용히 실패하지 않게 하는 회귀가드 (2026-08-19)
 *
 * 실사고: "저장했다는데 다시 열면 이전 값" — 실제로는 PUT 이 **한 번도 나가지 않았다**.
 *   ① 옵션 URL 이 빈 기존 공고(칸 도입 이전 발행분)가 필수 검증에 걸려 저장 차단
 *   ② 차단 사유 배너가 `display:none` 인 인라인 푸터에 붙어 화면에 0×0 으로 렌더(무신호)
 * 곁다리로 같은 계열 2건도 함께 고정한다.
 *   ③ 입력칸이 없는 유의사항(notes)을 ''로 전송해 저장할 때마다 지우던 것
 *   ④ 탭 목록 미로드·복원 실패를 "사람이 연결을 비웠다"로 읽어 시트 연결을 끊던 것
 *
 * 실행: node tests/recruitSaveBlockVisible.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', p), 'utf8');
const modal = read('recruit-modal.js');
const app = read('index-recruit.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };

/* ── ① 차단 배너는 "보이는" 푸터에 붙는다 ───────────────────────── */
ok('차단 배너 호스트를 고르는 단일 함수가 있다', /function _blockHost\(\)/.test(modal));
ok('푸터를 전부 훑어 보이는 것을 고른다(첫 번째 고정 금지)',
  /_blockHost[\s\S]{0,700}querySelectorAll\('#recruitModal \.modal-footer'\)/.test(modal)
  && /_blockHost[\s\S]{0,700}offsetParent !== null/.test(modal));
ok('recruitSaveBlock 이 querySelector 로 첫 푸터를 집지 않는다',
  !/var foot = document\.querySelector\('#recruitModal \.modal-footer'\)/.test(modal));
ok('인라인 푸터를 숨기는 규칙은 그대로다(그래서 첫 푸터를 고르면 안 된다)',
  /#recruitModal \.rf-compact-main \.footer\{display:none\}/.test(modal));
ok('배너를 못 붙이면 false 를 돌려주고 화면이 폴백한다',
  /function recruitSaveBlock\([\s\S]{0,400}if \(!foot\) return false;/.test(modal)
  && /const shown = \(typeof recruitSaveBlock === "function"\)[\s\S]{0,200}if \(!shown\) showToast\(msg, "error"\)/.test(app));
ok('배너 정리는 남은 것을 전부 지운다',
  /function recruitSaveBlockClear\(\)[\s\S]{0,300}querySelectorAll\('#recruitModal \.rf-blockbar'\)/.test(modal));

/* ── ② 옵션 URL 은 값이 있을 때만 형식 검사 ─────────────────────── */
{
  const m = app.match(/const invalidOptionUrl = payload\.options\.find\(option =>[\s\S]{0,220}?\);/);
  ok('옵션 URL 검증 블록이 있다', !!m);
  ok('빈 옵션 URL 은 차단하지 않는다(기존 공고 저장 봉쇄 해제)',
    /String\(option\.optionUrl \|\| ""\)\.trim\(\) && !_rfHttpUrl\(option\.optionUrl\)/.test(m[0]));
  ok('형식이 틀린 값은 여전히 차단한다', /_rfHttpUrl\(option\.optionUrl\)/.test(m[0]));
}

/* ── ③ 유의사항(notes)은 입력칸이 있는 화면에서만 전송 ──────────── */
ok('payload 리터럴에서 무조건 전송하던 notes 가 사라졌다',
  !/notes:\s*String\(document\.getElementById\("rf_notes"\)\?\.value/.test(app));
ok('rf_notes 요소가 있을 때만 payload.notes 를 싣는다',
  /const _notesEl = document\.getElementById\("rf_notes"\);\s*\n\s*if \(_notesEl\) payload\.notes =/.test(app));

/* ── ④ 연결 해제는 "사람이 비웠을 때만" ─────────────────────────── */
ok('연결 해제 판정 함수가 단일 출처다', /function _rfExplicitUnlink\(\)/.test(app));
{
  const src = app.match(/function _rfExplicitUnlink\(\)[\s\S]*?\n}/)[0];
  const call = (ctx) => {
    const sandbox = Object.assign({ document: { getElementById: (id) => ctx.sel } }, ctx.globals);
    vm.createContext(sandbox);
    vm.runInContext(src + '\n_rfExplicitUnlink();', sandbox);
    return vm.runInContext('_rfExplicitUnlink()', sandbox);
  };
  const tabs2 = [{}, {}];
  ok('신규 공고는 연결 없음이 곧 의도(unlinked)',
    call({ sel: { options: [] }, globals: { _recruitEditId: null, _recruitTabList: [], _rfLinkedMiss: null } }) === true);
  ok('탭 목록을 못 받았으면 해제로 보지 않는다(기존 연결 보존)',
    call({ sel: { options: [{}] }, globals: { _recruitEditId: 'C1', _recruitTabList: [], _rfLinkedMiss: null } }) === false);
  ok('저장된 탭 복원 실패(리네임·아카이브)면 해제로 보지 않는다',
    call({ sel: { options: [{}, {}] }, globals: { _recruitEditId: 'C1', _recruitTabList: tabs2, _rfLinkedMiss: { source: 'campaign' } } }) === false);
  ok('목록도 정상이고 복원도 됐는데 비어 있으면 사람이 비운 것(unlinked)',
    call({ sel: { options: [{}, {}] }, globals: { _recruitEditId: 'C1', _recruitTabList: tabs2, _rfLinkedMiss: null } }) === true);
}

console.log(`\nrecruitSaveBlockVisible: ${passed} passed`);
