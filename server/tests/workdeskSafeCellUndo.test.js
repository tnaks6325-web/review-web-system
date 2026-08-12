const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const script = (html.match(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i) || [])[1];

function functionBody(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 함수를 찾을 수 있어야 합니다.`);
  let depth = 0;
  let quote = null;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    const c = script[i];
    const prev = script[i - 1];
    if (quote) { if (c === quote && prev !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`${name} 함수 끝을 찾지 못했습니다.`);
}

const buildGrid = script.slice(script.indexOf('function buildGrid('), script.indexOf('function rerenderGrid('));
const paintGridCell = functionBody('_paintGridCell');
const revertSelection = functionBody('_revertSelection');

assert.ok(!/class="revb"/.test(script), '어느 셀에서도 즉시 되돌리기 아이콘을 렌더하면 안 됩니다.');
assert.ok(!/class="revb"/.test(paintGridCell), '셀 재도색 후에도 즉시 되돌리기 아이콘이 나타나면 안 됩니다.');
assert.match(script, /편집 되돌리기[\s\S]*_revertSelection\(\)/, '우클릭 메뉴에는 명시적인 편집 되돌리기가 남아야 합니다.');
assert.match(revertSelection, /revertGridCell\(td\)/, '우클릭 메뉴의 되돌리기는 셀을 직접 되돌려야 합니다.');
assert.match(script, /function openLegacyRevertMenu\(/, '폴백 셀도 우클릭 메뉴로만 편집을 되돌릴 수 있어야 합니다.');

const shortcutBody = functionBody('_handleWorkdeskUndoShortcut');
assert.match(script, /document\.addEventListener\('keydown',\s*_handleWorkdeskUndoShortcut\)/, 'Ctrl+Z 핸들러는 문서에 한 번 등록되어야 합니다.');
const makeShortcut = new Function('STATE', '_undoLatestCellGroup', `${shortcutBody}\nreturn _handleWorkdeskUndoShortcut;`);
let undoCalls = 0;
const handler = makeShortcut({ view: 'workdesk' }, () => { undoCalls++; return true; });
let prevented = 0;
handler({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: { tagName: 'DIV' }, preventDefault() { prevented++; } });
assert.strictEqual(undoCalls, 1, '작업보드에서 Ctrl+Z는 셀 실행취소를 호출해야 합니다.');
assert.strictEqual(prevented, 1, '작업보드 셀 실행취소는 브라우저 기본 실행취소를 막아야 합니다.');

handler({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: { tagName: 'INPUT' }, preventDefault() { prevented++; } });
assert.strictEqual(undoCalls, 1, '텍스트 입력 중 Ctrl+Z는 브라우저 입력 실행취소에 맡겨야 합니다.');

const outsideHandler = makeShortcut({ view: 'orders' }, () => { throw new Error('다른 화면에서 실행되면 안 됩니다.'); });
outsideHandler({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: { tagName: 'DIV' }, preventDefault() { prevented++; } });

console.log('workdeskSafeCellUndo.test.js passed');
