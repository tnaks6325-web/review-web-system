'use strict';
// 결정 349 — 동시진행 지급 보류 사유가 입금 화면에 코드 이름(dual_bundle_incomplete 등)으로 뜨지 않게 한글 이름표가 있어야 한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('every reason the dual payout judge can emit has a Korean label on the payment screen', () => {
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/dualChannelPayout.service.js'), 'utf8');
  const codes = new Set([...svc.matchAll(/reasons\.push\('([a-z_]+)'\)/g)].map(m => m[1]));
  for (const c of ['dual_bundle_incomplete', 'dual_bundle_check_failed', 'missing_validated_naver_receipt', 'missing_validated_coupang_receipt']) codes.add(c);
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
  const i = html.indexOf('const PAY_ISSUE_LABEL = {');
  assert.ok(i > 0);
  const block = html.slice(i, html.indexOf('};', i));
  const missing = [...codes].filter(c => !new RegExp('\\b' + c + ":'").test(block));
  assert.deepEqual(missing, [], 'labels missing for: ' + missing.join(', '));
});
