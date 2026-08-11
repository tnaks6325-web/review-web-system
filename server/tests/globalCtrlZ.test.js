/* Global Ctrl/Cmd+Z and workdesk cell undo contract.
 * Run: node server/tests/globalCtrlZ.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const apiSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'api.js'), 'utf8');
const workdeskSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
let passed = 0;
function ok(message, condition) { assert(condition, message); passed++; console.log('  OK ' + message); }

function blockBetween(src, start, end) {
  const from = src.indexOf(start), to = src.indexOf(end);
  assert(from >= 0 && to > from, `keyboard undo block not found: ${start}`);
  return src.slice(from + start.length, to);
}

console.log('\n[1] common keyboard shortcut');
const shortcutCode = blockBetween(apiSrc, '/* GLOBAL_UNDO_SHORTCUT_START */', '/* GLOBAL_UNDO_SHORTCUT_END */');
{
  const listeners = {};
  const sandbox = {
    document: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    window: {},
    history: { backCount: 0, back() { this.backCount++; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(shortcutCode, sandbox);
  const handler = listeners.keydown;
  ok('keydown listener is registered', typeof handler === 'function');
  let prevented = false;
  handler({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: { tagName: 'DIV' }, preventDefault() { prevented = true; } });
  ok('non-input Ctrl+Z prevents native browser undo', prevented);
  ok('non-input Ctrl+Z goes back when workdesk has no undo', sandbox.history.backCount === 1);
  prevented = false;
  handler({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: { tagName: 'INPUT' }, preventDefault() { prevented = true; } });
  ok('input Ctrl+Z keeps native undo', !prevented && sandbox.history.backCount === 1);
  sandbox.window.WorkdeskUndo = () => true;
  prevented = false;
  handler({ key: 'z', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, target: { tagName: 'DIV' }, preventDefault() { prevented = true; } });
  ok('workdesk undo consumes Cmd+Z before history navigation', prevented && sandbox.history.backCount === 1);
}

console.log('\n[2] workdesk undo boundaries');
ok('workdesk exposes an undo hook to the common shortcut', /window\.WorkdeskUndo\s*=\s*_undoLatestCellGroup/.test(workdeskSrc));
ok('only successful col edits are recorded for undo', /function _recordCellUndo\([\s\S]*?if\(!entry\|\|entry\.field\.indexOf\('col:'\)!==0\) return;/.test(workdeskSrc));
ok('undo waits for saving groups instead of navigating away', /if\(group\.pending\)\{[\s\S]{0,200}return true;/.test(workdeskSrc));
ok('undo restores existing overlays by saving their previous value', /entry\.had[\s\S]{0,500}\/api\/trackb\/workdesk\/edit/.test(workdeskSrc));
ok('undo removes first-time overlays through the revert endpoint', /\/api\/trackb\/workdesk\/revert/.test(workdeskSrc));
ok('paste creates one shared undo group for all affected cells', /const undoGroup=_beginCellUndoGroup\('paste'\);[\s\S]{0,1200}commitCellEdit\(j\.rowId, j\.field, j\.val, j\.td, \{undoGroup\}\)/.test(workdeskSrc));

async function runWorkdeskUndoExecution() {
  console.log('\n[3] workdesk undo execution');
  const undoStart = workdeskSrc.indexOf('const _CELL_UNDO_MAX=100;');
  const undoEnd = workdeskSrc.indexOf('function beginEditCell(td){', undoStart);
  assert(undoStart >= 0 && undoEnd > undoStart, 'workdesk undo block not found');
  const calls = [], row = { id: 'r1', cellEdits: { 송장: 'NEW' } };
  const sandbox = {
    STATE: { cur: { sheetId: 's1', tabName: 't1' }, wd: { roster: [row] } }, window: {}, toast: () => {},
    _gridRowById: id => String(id) === 'r1' ? row : null, _paintGridCell: () => {},
    api: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, reverted: 1 }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(workdeskSrc.slice(undoStart, undoEnd), sandbox);
  ok('empty workdesk undo stack immediately yields to browser history', vm.runInContext('_undoLatestCellGroup()', sandbox) === false);
  vm.runInContext("_beginCellUndoGroup('paste')", sandbox);
  vm.runInContext("_recordCellUndo({rowId:'r1',field:'col:송장',value:'NEW',had:false,td:{}}, _cellUndoStack[0]); _finishCellUndoGroup(_cellUndoStack[0]);", sandbox);
  vm.runInContext('_undoLatestCellGroup()', sandbox);
  await new Promise(resolve => setImmediate(resolve));
  ok('first-time cell edit is reverted through the server', calls.length === 1 && calls[0].url.endsWith('/workdesk/revert'));
  ok('first-time cell edit is removed from local overlay after server success', !Object.prototype.hasOwnProperty.call(row.cellEdits, '송장'));
  console.log(`\nOK globalCtrlZ: ${passed} cases passed`);
}
runWorkdeskUndoExecution().catch(err => { console.error(err); process.exitCode = 1; });
