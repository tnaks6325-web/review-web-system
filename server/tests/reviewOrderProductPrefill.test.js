'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workOrderDetail = fs.readFileSync(path.join(root, '..', 'frontend', 'js', 'work-order-detail.js'), 'utf8');
const recruit = fs.readFileSync(path.join(root, '..', 'frontend', 'js', 'index-recruit.js'), 'utf8');

assert.match(workOrderDetail, /function _woProductMode\(o\)/);
assert.match(workOrderDetail, /productMode:\s*\(typeof _woProductMode === "function"\) \? _woProductMode\(o\) : ""/);
// ⚠ 134 — 상품별 모드(복합 작업)로 넓힌 판정. 첫 상품만 보면 "상품B(옵션없음)+상품A(옵션)" 순서에서 구조를 버린다.
assert.match(workOrderDetail, /const explicitMode = arr\.some\(p => p && String\(p\.product_mode \|\| ""\)\)/);
assert.match(workOrderDetail, /return explicitMode \|\| rows\.filter\(r => r\.optKey\)\.length >= 2 \? rows : \[\]/);
assert.match(workOrderDetail, /dailyLimit:\s*Math\.max\(0, Number\(op\.daily_limit \?\? op\.dailyLimit\) \|\| 0\)/);
assert.match(workOrderDetail, /dailyLimit:\s*baseDaily/);
// ⚠ 134 — 작업오더가 "옵션 없음"을 **명시**한 경우도 신호로 받는다(빈 값 = 명시 없음 = 종전 추론).
assert.match(recruit, /const sourceMode = p\.productMode === "opt" \? "opt" : \(p\.productMode === "none" \? "none" : ""\)/);
assert.match(recruit, /renderOptRows\(sourceOptions, \{ mode: sourceMode \}\)/);

console.log('reviewOrderProductPrefill: 5 passed');
