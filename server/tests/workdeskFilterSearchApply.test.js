const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');

assert.match(
  html,
  /onkeydown="if\(event\.key==='Enter'\)\{event\.preventDefault\(\);applyGFilter\(\);\}"/,
  'Pressing Enter in the filter search must apply the filter immediately.'
);

function grab(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') { depth++; opened = true; }
    else if (html[i] === '}' && opened && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(grab('_gFilterSelection'), sandbox);

const box = (value, checked, visible) => ({
  value,
  checked,
  closest: () => ({ style: { display: visible ? '' : 'none' } }),
});

const allChecked = [box('7/27', true, false), box('7/30', true, true), box('8/4', true, false)];
assert.deepEqual([...sandbox._gFilterSelection(allChecked, '7/30').values], ['7/30'],
  'A filtered search applies only currently visible selections.');
assert.deepEqual([...sandbox._gFilterSelection(allChecked, '').values], ['7/27', '7/30', '8/4'],
  'An empty search preserves the full selection state.');

const mixed = [box('7/27', true, false), box('7/30', false, true), box('7/31', true, true)];
assert.deepEqual([...sandbox._gFilterSelection(mixed, '7/3').values], ['7/31'],
  'Unchecked visible values are excluded when applying a search.');

console.log('workdesk filter search apply regression passed');
