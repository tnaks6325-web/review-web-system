const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { normalizeReviewTypeMix } = require('../src/utils/reviewTypeMix');
const { sanitizeGuideHtml, sanitizeGuideImages } = require('../src/utils/sanitizeGuideHtml');

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

// _normalizeOptionsInput also normalizes option-level mixed review data.
// Load its production helper into the isolated contract sandbox so the URL
// assertions exercise the same dependency graph as the route does.
// ★ 134: 선택지별 유입가이드도 같은 함수가 정화하므로 **실제 정화기**를 그대로 주입한다
//   (스텁을 두면 "정화를 안 해도 통과"가 되어 이 계약검사의 의미가 사라진다).
const sandbox = { URL, normalizeReviewTypeMix, sanitizeGuideHtml, sanitizeGuideImages };
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
  productName: '',
  unitKind: 'option',
  inflowGuideHtml: '',
  inflowGuideImages: [],
  reviewTypeMix: [],
  reviewMixError: null,
  sortOrder: 0,
  status: null,
}]);

// ★ 134 — 값 미전달 시 기본값이 "종전 동작"이어야 한다(위 deepEqual 이 고정) + 모르는 unit_kind 는
//   'product' 로 승격되지 않는다. 옵션 없는 상품 단위는 명시했을 때만 만들어진다.
const unitRows = JSON.parse(JSON.stringify(sandbox._normalizeOptionsInput([
  { optKey: '상품B', unitKind: 'product', productName: '상품B' },
  { optKey: '옵션A', unitKind: '이상한값', productName: '상품A' },
])));
assert.equal(unitRows[0].unitKind, 'product');
assert.equal(unitRows[0].productName, '상품B');
assert.equal(unitRows[1].unitKind, 'option', '모르는 unit_kind 는 option(종전 동작)');

// ★ 선택지별 유입가이드는 저장 시점에 정화된다 — 스크립트·비프록시 이미지 주소는 통과 못 한다.
const guarded = sandbox._normalizeOptionsInput([{
  optKey: '옵션A',
  inflowGuideHtml: '<p>안내</p><script>alert(1)</script>',
  inflowGuideImages: ['https://evil.example/x.png'],
}])[0];
assert.ok(!/script/i.test(guarded.inflowGuideHtml), '스크립트 태그는 저장 전에 제거된다');
assert.deepEqual(guarded.inflowGuideImages, [], '우리 프록시 주소가 아닌 이미지는 버린다');

console.log('campaign option URL contract: OK');
