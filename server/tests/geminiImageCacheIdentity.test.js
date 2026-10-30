'use strict';
// Pure production cache-key function: no model SDK, network or production data.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const source = fs.readFileSync(path.join(__dirname, '../src/services/gemini.service.js'), 'utf8');
const start = source.indexOf('function _getCacheKey(');
const end = source.indexOf('function _getFromCache(', start);
assert.ok(start >= 0 && end > start, 'production cache key function must exist');
const key = vm.runInNewContext(source.slice(start, end) + '; _getCacheKey;', { crypto });
const common = Buffer.alloc(60000, 65);
const first = Buffer.concat([common, Buffer.from('first image tail')]).toString('base64');
const second = Buffer.concat([common, Buffer.from('different image tail')]).toString('base64');
assert.notStrictEqual(
  key('classify7:same-samples:' + first),
  key('classify7:same-samples:' + second),
  'different image tails must never reuse the same classification cache entry'
);
assert.strictEqual(key('classify7:same-samples:' + first), key('classify7:same-samples:' + first), 'same image and criteria must keep the attachment/submission cache shared');
assert.notStrictEqual(key('classify7:old-samples:' + first), key('classify7:new-samples:' + first), 'sample changes must invalidate the entry');
assert.notStrictEqual(key('classify7:samples:' + first), key('extract4:samples:' + first), 'classification and purchase extraction must stay isolated');
assert.strictEqual(key('data:image/png;base64,' + first), key(first), 'bare image data URL normalization must be preserved');
console.log('Image cache identity: 5 checks passed');
