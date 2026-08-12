'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workOrderDetail = fs.readFileSync(path.join(root, '..', 'frontend', 'js', 'work-order-detail.js'), 'utf8');
const recruit = fs.readFileSync(path.join(root, '..', 'frontend', 'js', 'index-recruit.js'), 'utf8');

assert.match(workOrderDetail, /function _woProductMode\(o\)/);
assert.match(workOrderDetail, /productMode:\s*\(typeof _woProductMode === "function"\) \? _woProductMode\(o\) : ""/);
assert.match(workOrderDetail, /const explicitOptionMode = String\(\(arr\[0\] \|\| \{\}\)\.product_mode \|\| ""\) === "opt"/);
assert.match(workOrderDetail, /return explicitOptionMode \|\| rows\.filter\(r => r\.optKey\)\.length >= 2 \? rows : \[\]/);
assert.match(workOrderDetail, /dailyLimit:\s*Math\.max\(0, Number\(op\.daily_limit \?\? op\.dailyLimit\) \|\| 0\)/);
assert.match(workOrderDetail, /dailyLimit:\s*baseDaily/);
assert.match(recruit, /const sourceMode = p\.productMode === "opt" \? "opt" : ""/);
assert.match(recruit, /renderOptRows\(sourceOptions, \{ mode: sourceMode \}\)/);

console.log('reviewOrderProductPrefill: 5 passed');
