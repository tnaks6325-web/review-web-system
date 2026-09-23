/* 작업보드 셀 우클릭 메뉴의 복구 가능한 행 삭제 회귀 방지. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');

assert.match(html, /function _menuDeleteRow\(\)/, '행 삭제 메뉴 핸들러가 필요합니다');
assert.match(html, /function _menuDeleteRow\(\)[\s\S]{0,300}hideRow\(rowId\)/, '행 삭제는 기존의 복구 가능한 hideRow를 사용해야 합니다');
assert.match(html, /danger\?' danger':''/, '행 삭제는 빨간 danger 메뉴 스타일을 사용해야 합니다');
assert.match(html, /\.gcmrow\.danger\{[\s\S]{0,200}var\(--bad\)/, 'danger 메뉴는 경고 색상을 사용해야 합니다');

const menu = html.slice(html.indexOf('function _openCellMenu'), html.indexOf('function _closeCellMenu'));
assert.ok(menu.lastIndexOf('_menuDeleteRow()') > menu.lastIndexOf('_applyRangeColor'), '행 삭제는 메뉴의 마지막 동작이어야 합니다');

console.log('workdesk row context delete contract passed');
