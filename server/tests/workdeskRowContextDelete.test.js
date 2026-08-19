/* 작업보드 셀 우클릭 메뉴의 복구 가능한 행 삭제 회귀 방지. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');

assert.match(html, /function _menuDeleteRow\(\)/, '행 삭제 메뉴 핸들러가 필요합니다');
// ── 성격에 따라 갈리는 삭제 경로 ──
// 구매양식이 연결된 행의 "삭제"는 명단에서 빼는 것이 아니라 그 리뷰어의 구매기록 취소다.
const menuFn = html.slice(html.indexOf('function _menuDeleteRow()'), html.indexOf('function _revertSelection()'));
assert.ok(menuFn, '_menuDeleteRow 본문을 찾지 못했습니다');
assert.match(menuFn, /r\.hasOrder/, '삭제 경로 판정은 서버가 준 hasOrder 하나로만 해야 합니다');
assert.match(menuFn, /deleteOrderRow\(rowId,\s*\{\s*onNoOrder:\s*\(\)=>hideRow\(rowId\)\s*\}\)/,
  '주문 있는 행은 구매기록 취소 경로로 보내고, 원장이 이미 없으면 행 제거로 이어져야 합니다');
assert.ok(menuFn.lastIndexOf('hideRow(rowId)') > menuFn.indexOf('deleteOrderRow('),
  '주문 없는 행은 종전대로 복구 가능한 hideRow로 떨어져야 합니다');
assert.match(menuFn, /STATE\.role==='master'\|\|STATE\.role==='admin'/,
  '주문 취소는 서버가 master/admin만 허용하므로 화면도 같은 게이트를 걸어야 합니다');
assert.match(menuFn, /alert\(/, '권한 없는 경우 조용히 아무 일도 안 하지 말고 사유를 말해야 합니다');

// 메뉴 항목이 그 행에서 무엇을 하는지 라벨로 말하고, 못 누르는 경우는 잠근다(죽은 항목 금지).
const openMenu = html.slice(html.indexOf('function _openCellMenu'), html.indexOf('function _closeCellMenu'));
assert.match(openMenu, /menuRowHasOrder\s*=\s*!!\(selectedRow&&selectedRow\.hasOrder\)/, '메뉴도 hasOrder로 판정해야 합니다');
assert.match(openMenu, /menuRowHasOrder\?'행 삭제 · 구매기록 취소':'행 삭제'/, '주문 있는 행은 라벨이 구매기록 취소임을 말해야 합니다');
assert.match(openMenu, /menuRowHasOrder&&!menuCanOrderDelete/, '권한 없는 담당자에게는 그 항목을 잠가야 합니다');

// 구매기록 취소는 확인창(영향 숫자)을 거치는 기존 경로 한 벌만 쓴다(사본 금지).
const coreFn = html.slice(html.indexOf('async function _deleteOrderRowCore'), html.indexOf('async function cleanupAutoTestRecord'));
assert.match(coreFn, /order-delete-preview/, '삭제 전 영향 미리보기를 거쳐야 합니다');
assert.match(coreFn, /confirm\(message\)/, '총원·금액 변화를 확인창으로 보여준 뒤에만 삭제해야 합니다');
assert.strictEqual((html.match(/order-delete-preview/g) || []).length, 1, '구매기록 취소 경로는 한 벌이어야 합니다');
assert.strictEqual((html.match(/'\/api\/trackb\/workdesk\/order-delete'/g) || []).length, 1, '구매기록 취소 호출은 한 곳이어야 합니다');
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

// ── 실행 검증: 배선이 아니라 실제로 어느 경로로 가는지 ──
// grep 은 "호출문이 있다"까지만 본다. 세 갈래(주문 행·빈 행·권한 없음)를 실제로 실행해 고정한다.
const vm = require('vm');
function runMenuDelete({ role, roster, rowId }) {
  const calls = { order: [], hide: [], alert: [] };
  const sandbox = {
    STATE: { role, _gMenuRowId: rowId, wd: { roster } },
    alert: (m) => calls.alert.push(m),
    deleteOrderRow: (id, opts) => calls.order.push({ id, opts }),
    hideRow: (id) => calls.hide.push(id),
    _closeCellMenu: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(menuFn + '\n_menuDeleteRow();', sandbox);
  return calls;
}
const orderRoster = [{ id: 'r1', hasOrder: true }];
const plainRoster = [{ id: 'r2', hasOrder: false }];

const asAdmin = runMenuDelete({ role: 'admin', roster: orderRoster, rowId: 'r1' });
assert.strictEqual(asAdmin.order.length, 1, '주문 있는 행은 구매기록 취소 경로로 가야 합니다');
assert.strictEqual(asAdmin.hide.length, 0, '주문 있는 행이 바로 hideRow로 가면 구매양식이 남습니다');
assert.strictEqual(typeof asAdmin.order[0].opts.onNoOrder, 'function', '원장이 이미 없는 경우의 대체 경로가 있어야 합니다');
asAdmin.order[0].opts.onNoOrder();
assert.deepStrictEqual(asAdmin.hide, ['r1'], '대체 경로는 같은 행을 hideRow로 넘겨야 합니다');

const asStaff = runMenuDelete({ role: 'staff', roster: orderRoster, rowId: 'r1' });
assert.strictEqual(asStaff.order.length, 0, '권한 없는 담당자가 구매기록을 취소하면 안 됩니다');
assert.strictEqual(asStaff.hide.length, 0, '권한 없는 경우 다른 경로로 우회해서도 안 됩니다');
assert.strictEqual(asStaff.alert.length, 1, '권한 없는 경우 사유를 말해야 합니다');

const plain = runMenuDelete({ role: 'staff', roster: plainRoster, rowId: 'r2' });
assert.deepStrictEqual(plain.hide, ['r2'], '주문 없는 행은 종전대로 hideRow여야 합니다');
assert.strictEqual(plain.order.length, 0, '주문 없는 행에 구매기록 취소를 걸면 안 됩니다');

// 명단에서 찾지 못한 행(로스터 stale)은 주문 취소로 추측하지 않는다.
const unknown = runMenuDelete({ role: 'admin', roster: plainRoster, rowId: 'gone' });
assert.strictEqual(unknown.order.length, 0, '모르는 행을 구매기록 취소로 단정하면 안 됩니다');

console.log('workdesk row context delete contract passed');
