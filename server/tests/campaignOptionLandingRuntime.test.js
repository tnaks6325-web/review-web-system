const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'frontend', 'js', 'campaign-workdetail.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const cardsHtml = sandbox.window.CampWorkDetail.cardsHtml;
const selectedOptionUrl = 'https://store.example/item?option=blue';
const fallbackUrl = 'https://store.example/item';

const optionHtml = cardsHtml({
  inflowType: 'link',
  landingUrl: fallbackUrl,
  selectedOption: { optKey: '블루', optionUrl: selectedOptionUrl },
}, {});
assert.match(optionHtml, new RegExp('data-cwd-landing="' + selectedOptionUrl.replace(/[?]/g, '\\?') + '"'));

const fallbackHtml = cardsHtml({
  inflowType: 'link',
  landingUrl: fallbackUrl,
  selectedOption: { optKey: '블루', optionUrl: '' },
}, {});
assert.match(fallbackHtml, new RegExp('data-cwd-landing="' + fallbackUrl.replace(/[?]/g, '\\?') + '"'));

console.log('campaign selected option landing runtime: OK');
