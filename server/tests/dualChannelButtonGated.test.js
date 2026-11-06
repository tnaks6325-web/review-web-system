'use strict';
// 결정 341 「출시(켜기)」(사용자 지시 2026-11-06): 서버 준비 상태가 코드 상수로 열렸으므로
// 모집공고 창의 「네이버+쿠팡」 버튼은 다른 구매채널 버튼과 똑같이 보여야 한다.
// 숨김 표시(data-dual-gated · 인라인 display:none)가 남으면 기능은 열렸는데 고를 수 없는 막다른 길이다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('recruit modal shows the dual channel button like the other channel buttons after release', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../frontend/js/recruit-modal.js'), 'utf8');
  const buttons = src.match(/<button[^>]*data-val="네이버\+쿠팡"[^>]*>/g) || [];
  assert.equal(buttons.length, 1, 'exactly one dual channel button');
  assert.doesNotMatch(buttons[0], /display\s*:\s*none/);
  assert.doesNotMatch(buttons[0], /data-dual-gated/);
  assert.doesNotMatch(buttons[0], /\shidden[\s>=]/);
  assert.match(buttons[0], /onclick="selectRfBtn\('channel',this\)"/);
  for (const v of ['쿠팡', '네이버', '올리브영', '카카오메이커스', '직접입력']) {
    const b = (src.match(new RegExp('<button[^>]*data-val="' + v + '"[^>]*>')) || [])[0];
    assert.ok(b && !/display:none/.test(b), v + ' stays visible');
  }
});
