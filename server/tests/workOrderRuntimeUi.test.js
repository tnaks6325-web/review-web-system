const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const cards = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-app.js'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'frontend', 'js', 'work-order-detail.js'), 'utf8');

assert.match(cards, /wo-runtime-card/);
assert.match(cards, /wo-runtime-card__summary/);
assert.match(cards, /wo-runtime-workspace/);
assert.match(cards, /function woRuntimeSelect\(/);
assert.match(cards, /function _bindWorkOrderWorkspace\(/);
assert.doesNotMatch(cards, /onclick="woRuntimeSelect/);
assert.match(editor, /wo-runtime-modal/);
assert.match(editor, /wo-runtime-modal__row/);
assert.match(editor, /wo-runtime-modal__choice/);

console.log('work-order-runtime-ui: passed');
