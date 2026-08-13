const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'frontend', 'js', 'work-order-detail.js'), 'utf8');
const sandbox = { window: {}, console };
sandbox.window.window = sandbox.window;
vm.runInNewContext(source, sandbox, { filename: 'work-order-detail.js' });

const prefill = sandbox.window._woCampaignPrefill({
  review_type: 'mixed',
  review_type_mix: [{ type: 'photo', quantity: 20 }, { type: 'text', quantity: 20 }],
  product_options_json: JSON.stringify([{
    product_mode: 'opt',
    name: '테스트 상품',
    options: [
      { label: 'A옵션', pay: 10000, count: 20, review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] },
      { label: 'B옵션', pay: 12000, count: 20, review_type_mix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] },
    ],
  }]),
});

assert.strictEqual(prefill.options.length, 2, 'explicit option work pre-fills both option rows');
const plain = value => JSON.parse(JSON.stringify(value));
assert.deepStrictEqual(plain(prefill.options[0].reviewTypeMix), [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }], 'A option keeps its own review mix');
assert.deepStrictEqual(plain(prefill.options[1].reviewTypeMix), [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }], 'B option keeps its own review mix');
assert.deepStrictEqual(plain(prefill.review_type_mix), [{ type: 'photo', quantity: 20 }, { type: 'text', quantity: 20 }], 'top-level mixed review remains backward compatible');

console.log('intranetOptionReviewMixPrefill: passed');
