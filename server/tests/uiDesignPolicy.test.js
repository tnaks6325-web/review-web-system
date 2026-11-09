'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const policySection = text => text.slice(text.indexOf('\n## '), text.indexOf('\n이 파일은'));

for (const name of ['AGENTS.md', 'CLAUDE.md']) {
  test(`${name}: letter-style gate is removed without weakening business or preview safeguards`, () => {
    const text = read(name);
    const section = policySection(text);
    assert.doesNotMatch(text, /UI style proposal gate|A\s*\/\s*B\s*\/\s*C|A·B스타일|C스타일/);
    assert.match(section, /특정 문자 규격을 선택하거나 따를 의무는 없다/);
    assert.match(section, /사용자 확정 2026-11-09/);
    assert.match(section, /승인된 디자인은 요청 범위 밖에서 보존한다/);
    assert.match(section, /선택된 작업들의 체크된 입금 항목만/);
    assert.match(section, /합계 금액과 다운로드 대상은 같은 기준/);
    assert.match(section, /담당자 판정과 미지정 작업 안내/);
    assert.match(section, /지급 보호와 권한/);
    assert.match(section, /`박은비`가 아니라 항상 `망고`로 정규화/);
    assert.match(section, /배포본에서 픽셀로 재서만 말한다/);
    assert.match(section, /같은 기준/);
    assert.match(section, /수정 전·후를 함께/);
    assert.match(text, /화면이 바뀌는 변경이면 머지 전에 미리보기를 보여주고 확인을 받는다/);
    assert.match(text, /답이 없으면 머지하지 않고 기다린다/);
  });
}

test('both assistants receive the same current UI policy', () => {
  assert.equal(policySection(read('AGENTS.md')), policySection(read('CLAUDE.md')));
});

test('the former reviewer design spec is historical, not a mandatory cross-page prompt', () => {
  const text = read('docs/sian-c-design-language.md');
  assert.match(text, /역사 기록/);
  assert.match(text, /새 화면의 문자 규격이나 복사용 지시로 적용하지 않는다/);
  assert.doesNotMatch(text, /바로 쓰는 프롬프트 \(복사용\)|가장 중요 — 이게 빠지면 "시안 C 아님"/);
  assert.match(text, /과거 비교 라벨/);
  assert.match(text, /CSS 호환 클래스/);
  assert.match(text, /금융·권한·검증 안전/);
  assert.match(text, /승인된 기존 화면/);
});
