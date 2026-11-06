'use strict';
// 운영 반영 1차(사용자 지시 2026-11-06 「운영에 반영해」): 동시진행 서버 입구는 기본 닫힘이다.
// 모집공고 창에 「네이버+쿠팡」 버튼이 보이면 직원이 골라 입력한 뒤 저장에서 거부되는 막다른 길이 된다.
// 실제 모집을 여는 별도 승인 전까지 버튼은 화면에 보이지 않아야 한다(코드·편집기는 그대로 둔다).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('recruit modal keeps the dual channel button but does not display it while the feature is closed', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../frontend/js/recruit-modal.js'), 'utf8');
  const buttons = src.match(/<button[^>]*data-val="네이버\+쿠팡"[^>]*>/g) || [];
  assert.equal(buttons.length, 1, 'exactly one dual channel button');
  assert.match(buttons[0], /style="display:none"/, 'inline display:none (class display rules would override the hidden attribute)');
  assert.match(buttons[0], /data-dual-gated="1"/);
  // 다른 구매채널 버튼은 그대로 보인다.
  for (const v of ['쿠팡', '네이버', '올리브영', '카카오메이커스', '직접입력']) {
    const b = (src.match(new RegExp('<button[^>]*data-val="' + v + '"[^>]*>')) || [])[0];
    assert.ok(b && !/display:none/.test(b), v + ' stays visible');
  }
});
