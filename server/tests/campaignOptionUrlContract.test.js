const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const routes = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'campaign.routes.js'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'frontend', 'js', 'index-recruit.js'), 'utf8');
const modal = fs.readFileSync(path.join(root, 'frontend', 'js', 'recruit-modal.js'), 'utf8');
const workOrder = fs.readFileSync(path.join(root, 'frontend', 'js', 'work-order-detail.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'server', 'migrations', '108_campaign_option_url.sql'), 'utf8');

assert.match(migration, /ADD COLUMN IF NOT EXISTS option_url TEXT NOT NULL DEFAULT ''/);
assert.match(routes, /function _normalizeOptionUrl\(value\)/);
assert.match(routes, /optionUrl: _normalizeOptionUrl/);
assert.match(routes, /INSERT INTO campaign_options \(campaign_id, opt_key, option_url,/);
assert.match(routes, /option_url=EXCLUDED\.option_url/);
assert.match(routes, /option_url AS "optionUrl"/);
assert.match(editor, /rf-opt-url/);
assert.match(editor, /optionUrl/);
assert.match(workOrder, /optionUrl:/);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

const sandbox = { URL };
vm.createContext(sandbox);
vm.runInContext(functionSource(routes, '_normOptKey'), sandbox);
vm.runInContext(functionSource(routes, '_optNum'), sandbox);
vm.runInContext(functionSource(routes, '_normalizeOptionUrl'), sandbox);
vm.runInContext(functionSource(routes, '_normalizeOptionsInput'), sandbox);
assert.equal(sandbox._normalizeOptionUrl('https://store.example/item?option=blue'), 'https://store.example/item?option=blue');
assert.equal(sandbox._normalizeOptionUrl('javascript:alert(1)'), '');
assert.equal(sandbox._normalizeOptionUrl('not a url'), '');
assert.equal(sandbox._normalizeOptionUrl('https://store.example/' + 'x'.repeat(2049)), '');
const normalizedOptions = JSON.parse(JSON.stringify(sandbox._normalizeOptionsInput([{
  optKey: 'blue',
  optionUrl: 'https://store.example/item?option=blue',
  payAmount: 33000,
  recruitTotal: 15,
  dailyLimit: 5,
}])));
assert.deepEqual(normalizedOptions, [{
  optKey: 'blue',
  optionUrl: 'https://store.example/item?option=blue',
  payAmount: 33000,
  recruitTotal: 15,
  dailyLimit: 5,
  sortOrder: 0,
  status: null,
}]);

console.log('campaign option URL contract: OK');
