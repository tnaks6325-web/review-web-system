/* 작업보드 셀 우클릭 메뉴의 복구 가능한 행 삭제 회귀 방지. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');

assert.match(html, /function _menuDeleteRow\(\)/, '행 삭제 메뉴 핸들러가 필요합니다');
// ── 우클릭 행 삭제 = 구매기록 취소 + 총원 유지 ──
// 경로는 hideRow 하나뿐이다(성격별로 나누면 두 경로가 곧 갈린다).
const menuFn = html.slice(html.indexOf('function _menuDeleteRow()'), html.indexOf('function _revertSelection()'));
assert.ok(menuFn, '_menuDeleteRow 본문을 찾지 못했습니다');
assert.ok(!/deleteOrderRow\(/.test(menuFn),
  '우클릭 삭제가 총원을 줄이는 order-delete 경로로 가면 안 됩니다(총 모집인원 유지가 이 기능의 목적)');
assert.match(menuFn, /hideRow\(rowId,\s*\{hasOrder:/, '우클릭 삭제는 hideRow 한 경로로 수렴해야 합니다');
assert.match(menuFn, /STATE\.role==='master'\|\|STATE\.role==='admin'/,
  '구매기록 취소는 서버가 master/admin만 허용하므로 화면도 같은 게이트를 걸어야 합니다');
assert.match(menuFn, /alert\(/, '권한 없는 경우 조용히 아무 일도 안 하지 말고 사유를 말해야 합니다');

// 메뉴 항목이 그 행에서 무엇을 하는지 라벨로 말하고, 못 누르는 경우는 잠근다(죽은 항목 금지).
const openMenu = html.slice(html.indexOf('function _openCellMenu'), html.indexOf('function _closeCellMenu'));
assert.match(openMenu, /menuRowHasOrder\s*=\s*!!\(selectedRow&&selectedRow\.hasOrder\)/, '메뉴도 hasOrder로 판정해야 합니다');
assert.match(openMenu, /menuRowHasOrder\?'행 삭제 · 구매기록 취소':'행 삭제'/, '주문 있는 행은 라벨이 구매기록 취소임을 말해야 합니다');
assert.match(openMenu, /menuRowHasOrder&&!menuCanOrderDelete/, '권한 없는 담당자에게는 그 항목을 잠가야 합니다');

// 확인창이 "총원은 줄지 않는다"를 말해야 한다 — 이 기능의 핵심 약속이다.
const hideConfirm = html.slice(html.indexOf('async function hideRow(rowId'), html.indexOf('function _orderDeleteCount'));
assert.match(hideConfirm, /총 모집인원은 줄지 않습니다/, '주문 있는 행 확인창은 총원이 줄지 않음을 말해야 합니다');
assert.match(hideConfirm, /시트[\s\S]{0,20}주문값도 함께 비워집니다/, '시트 주문값이 비워진다는 사실도 말해야 합니다');

// 이름 옆 [삭제] 버튼(총원·금액 반영)은 별개 기능으로 그대로 남는다.
assert.match(html, /onclick="deleteOrderRow\('/, '기존 [삭제] 버튼 경로는 유지되어야 합니다');
assert.strictEqual((html.match(/order-delete-preview/g) || []).length, 1, '구매기록 취소 미리보기 경로는 한 벌이어야 합니다');

// ── 실패 사유 고지 ──
// 서버는 6갈래 이상으로 행 삭제를 거부하는데, 화면이 '실패' 한 마디로 접으면
// 담당자는 무엇을 고쳐야 하는지 알 수 없다("눌렀는데 아무 일도 안 일어난다").
const hideFn = html.slice(html.indexOf('async function hideRow(rowId'), html.indexOf('function _orderDeleteCount'));
assert.ok(hideFn, 'hideRow 함수를 찾지 못했습니다');
assert.ok(!/toast\([^)]*'실패'/.test(hideFn), "실패를 '실패' 한 마디로 접지 않습니다 — 사유를 말해야 합니다");
assert.match(hideFn, /_hideRowErrorText\(r\)/, '실패 시 사유 문구 생성기를 사용해야 합니다');
assert.match(hideFn, /alert\(/, '사유는 자동으로 사라지는 토스트가 아니라 읽고 조치할 수 있게 표시해야 합니다');
assert.match(hideFn, /catch\(_\)\{ r=null; \}/, '네트워크 예외도 삼키지 않고 사유 문구로 수렴해야 합니다');

// 서버가 내는 사유 코드는 전부 한국어 문구를 가져야 한다(새 코드가 늘면 이 검사가 잡는다).
const svc = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');
const block = svc.slice(svc.indexOf('class HideRowError'), svc.indexOf('// 주문이 연결된 한 행을 안전하게 취소한다.'));
assert.ok(block, '행 삭제 서비스 본문을 찾지 못했습니다');
const codes = new Set();
for (const m of block.matchAll(/HideRowError\('([a-z_]+)'\)/g)) codes.add(m[1]);
for (const m of block.matchAll(/error: '([a-z_]+)'/g)) codes.add(m[1]);
for (const m of block.matchAll(/'([a-z_]+)'\s*:\s*\(scopes/g)) codes.add(m[1]);
for (const c of ['ambiguous_campaign', 'sheetless_campaign_not_found']) if (block.includes(`'${c}'`)) codes.add(c);
// 주문 취소 서비스가 돌려주는 코드도 이 화면에 그대로 나온다.
for (const c of ['concurrent_cancel', 'invalid_order_id']) codes.add(c);
assert.ok(codes.size >= 6, `서버 사유 코드를 충분히 읽지 못했습니다(${codes.size}개) — 추출 정규식을 확인하세요`);
assert.ok(codes.has('not_sheetless'), '시트 기반 작업 거부 사유가 있어야 합니다(행이 되살아난다)');
const msgMap = html.slice(html.indexOf('const _HIDE_ROW_ERRORS'), html.indexOf('function _hideRowErrorText'));
// 'unexpected'(예상 밖 서버 오류)는 표 대신 전용 분기가 DB 오류코드·내용을 그대로 보여준다.
codes.delete('unexpected');
for (const c of codes) assert.ok(msgMap.includes(`${c}:`), `사유 코드 ${c}의 한국어 안내 문구가 없습니다`);

// 예상 밖 오류를 "서버 오류가 발생했습니다"로 뭉뚱그리지 않는다 — 원인 코드와 내용을 그대로 보여준다.
assert.match(block, /error: 'unexpected'[\s\S]{0,200}pgCode/, '서버는 예상 밖 오류의 DB 코드를 함께 돌려줘야 합니다');
assert.match(block, /logger\.error\(/, '예상 밖 오류는 서버 로그에도 남아야 합니다');
const unexpectedBranch = html.slice(html.indexOf("if(code==='unexpected')"), html.indexOf('const known=_HIDE_ROW_ERRORS[code]'));
assert.ok(unexpectedBranch, '예상 밖 오류 전용 분기가 필요합니다');
assert.match(unexpectedBranch, /r\.pgCode/, '화면이 DB 오류코드를 보여줘야 합니다');
assert.match(unexpectedBranch, /r\.detail/, '화면이 오류 내용을 보여줘야 합니다');

// 알 수 없는 코드도 조용히 삼키지 않는다.
const fallback = html.slice(html.indexOf('function _hideRowErrorText'), html.indexOf('async function hideRow(rowId'));
assert.match(fallback, /사유 코드/, '알려진 코드는 원문 코드를 함께 보여 담당자가 그대로 전달할 수 있어야 합니다');
assert.match(fallback, /서버 응답/, '모르는 코드도 서버 응답을 그대로 보여야 합니다');

// ── 실행 검증: 배선이 아니라 실제로 어느 경로로 가는지 ──
// grep 은 "호출문이 있다"까지만 본다. 세 갈래(주문 행·빈 행·권한 없음)를 실제로 실행해 고정한다.
const vm = require('vm');
function runMenuDelete({ role, roster, rowId }) {
  const calls = { hide: [], order: [], alert: [] };
  const sandbox = {
    STATE: { role, _gMenuRowId: rowId, wd: { roster } },
    alert: (m) => calls.alert.push(m),
    hideRow: (id, opts) => calls.hide.push({ id, opts }),
    deleteOrderRow: (id) => calls.order.push(id),
    _closeCellMenu: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(menuFn + '\n_menuDeleteRow();', sandbox);
  return calls;
}
const orderRoster = [{ id: 'r1', hasOrder: true }];
const plainRoster = [{ id: 'r2', hasOrder: false }];

const asAdmin = runMenuDelete({ role: 'admin', roster: orderRoster, rowId: 'r1' });
assert.strictEqual(asAdmin.hide.length, 1, '주문 있는 행도 hideRow 한 경로로 가야 합니다');
assert.strictEqual(asAdmin.order.length, 0, '총원을 줄이는 경로로 가면 안 됩니다');
assert.strictEqual(asAdmin.hide[0].opts && asAdmin.hide[0].opts.hasOrder, true,
  '구매기록이 붙은 행임을 알려 확인창이 사실대로 말하게 해야 합니다');

const asStaff = runMenuDelete({ role: 'staff', roster: orderRoster, rowId: 'r1' });
assert.strictEqual(asStaff.hide.length, 0, '권한 없는 담당자가 구매기록을 취소하면 안 됩니다');
assert.strictEqual(asStaff.alert.length, 1, '권한 없는 경우 사유를 말해야 합니다');

const plain = runMenuDelete({ role: 'staff', roster: plainRoster, rowId: 'r2' });
assert.strictEqual(plain.hide.length, 1, '주문 없는 행은 종전대로 담당자도 제거할 수 있어야 합니다');
assert.strictEqual(plain.hide[0].opts.hasOrder, false, '주문 없는 행에 구매기록 취소 문구가 뜨면 안 됩니다');

// 명단에서 찾지 못한 행(로스터 stale)은 주문 있는 행으로 단정하지 않는다.
const unknown = runMenuDelete({ role: 'staff', roster: plainRoster, rowId: 'gone' });
assert.strictEqual(unknown.hide.length, 1, '모르는 행도 삭제 경로 자체는 막지 않습니다');
assert.strictEqual(unknown.hide[0].opts.hasOrder, false, '모르는 행을 주문 있는 행으로 단정하면 안 됩니다');

console.log('workdesk row context delete contract passed');
