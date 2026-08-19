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

// ── 실패 사유 고지 ──
// 서버는 6갈래 이상으로 행 삭제를 거부하는데, 화면이 '실패' 한 마디로 접으면
// 담당자는 무엇을 고쳐야 하는지 알 수 없다("눌렀는데 아무 일도 안 일어난다").
const hideFn = html.slice(html.indexOf('async function hideRow(rowId)'), html.indexOf('function _orderDeleteCount'));
assert.ok(hideFn, 'hideRow 함수를 찾지 못했습니다');
assert.ok(!/toast\([^)]*'실패'/.test(hideFn), "실패를 '실패' 한 마디로 접지 않습니다 — 사유를 말해야 합니다");
assert.match(hideFn, /_hideRowErrorText\(r\)/, '실패 시 사유 문구 생성기를 사용해야 합니다');
assert.match(hideFn, /alert\(/, '사유는 자동으로 사라지는 토스트가 아니라 읽고 조치할 수 있게 표시해야 합니다');
assert.match(hideFn, /catch\(_\)\{ r=null; \}/, '네트워크 예외도 삼키지 않고 사유 문구로 수렴해야 합니다');

// 서버가 내는 사유 코드는 전부 한국어 문구를 가져야 한다(새 코드가 늘면 이 검사가 잡는다).
const svc = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');
const block = svc.slice(svc.indexOf('async function hideWorkdeskRow'), svc.indexOf('async function previewWorkdeskOrderDelete'));
assert.ok(block, 'hideWorkdeskRow 본문을 찾지 못했습니다');
const codes = new Set();
for (const m of block.matchAll(/error: (?:row\.order_submission_id \? )?'([a-z_]+)'/g)) codes.add(m[1]);
for (const m of block.matchAll(/'([a-z_]+)'\s*:\s*\(scopes/g)) codes.add(m[1]);
for (const c of ['ambiguous_campaign', 'sheetless_campaign_not_found']) if (block.includes(`'${c}'`)) codes.add(c);
assert.ok(codes.size >= 8, `서버 사유 코드를 충분히 읽지 못했습니다(${codes.size}개) — 추출 정규식을 확인하세요`);
const msgMap = html.slice(html.indexOf('const _HIDE_ROW_ERRORS'), html.indexOf('function _hideRowErrorText'));
for (const c of codes) assert.ok(msgMap.includes(`${c}:`), `사유 코드 ${c}의 한국어 안내 문구가 없습니다`);

// 알 수 없는 코드도 조용히 삼키지 않는다.
const fallback = html.slice(html.indexOf('function _hideRowErrorText'), html.indexOf('async function hideRow(rowId)'));
assert.match(fallback, /사유 코드/, '알려진 코드는 원문 코드를 함께 보여 담당자가 그대로 전달할 수 있어야 합니다');
assert.match(fallback, /서버 응답/, '모르는 코드도 서버 응답을 그대로 보여야 합니다');

console.log('workdesk row context delete contract passed');
