'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

// A payment cell can deliberately retain multiple transfer dates.  The grid
// must not render or filter only the first one, otherwise a second transfer is
// invisible even though the workboard data is correct.
const latestDepositFormatter = source.slice(source.lastIndexOf('function _fmtMD(v)'));
assert.ok(latestDepositFormatter.includes('split(/\\s*,\\s*/)'));
assert.match(source, /function gFilterValues\(r,col\)/);
assert.match(source, /gFilterValues\(r,col\)\.some\(v=>set\.has\(v\)\)/);

console.log('workdesk deposit-history display tests passed');
