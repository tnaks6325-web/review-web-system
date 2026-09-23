const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const page = read('../../frontend/search.html');
const app = read('../../frontend/js/search-app.js');
const config = read('../../frontend/js/search-config.js');

let passed = 0;
const test = (name, fn) => { fn(); console.log('  ok  ' + name); passed++; };

test('reviewer search has no configurable GAS URL or password gate', () => {
  assert.ok(!/id=["']gasUrlModal["']/.test(page), 'GAS URL settings modal must be removed');
  assert.ok(!/openGasUrlModal\s*\(/.test(page), 'GAS URL settings entry point must be removed');
  assert.ok(!/GAS_URL_PW/.test(app), 'client-side GAS settings password must not exist');
  assert.ok(!/function\s+(openGasUrlModal|saveGasUrl|verifyGasUrlPw|_saveAppUrlToGas)\b/.test(app),
    'direct GAS configuration functions must be removed');
});

test('reviewer paths resolve through the Node API without GAS JSONP fallback', () => {
  assert.ok(!/BOOTSTRAP_GAS_URL/.test(config), 'GAS bootstrap configuration must be removed');
  assert.ok(!/function\s+_jsonpGet\b/.test(app), 'direct JSONP transport must be removed');
  assert.ok(!/script\.google\.com\/macros\/s\//.test(app), 'reviewer client must not accept direct GAS deployment URLs');
  assert.ok(/fetch\(apiBase \+ '\/api\/short\/resolve\?code='/.test(app),
    'short links must resolve through the Node API');
});

console.log(`\n${passed} GAS removal checks passed`);
