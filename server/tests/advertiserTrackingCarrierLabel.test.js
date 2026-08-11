const assert = require('node:assert/strict');
const { __advertiserColumnsForTest: advertiserColumns } = require('../src/services/trackB.service');

const headers = ['\uBC88\uD638', '\uD0DD\uBC30\uC1A1\uC7A5(\uB86F\uB370\uD0DD\uBC30)', '\uC740\uD589'];
assert.deepEqual(
  advertiserColumns(headers),
  ['\uBC88\uD638', '\uD0DD\uBC30\uC1A1\uC7A5(\uB86F\uB370\uD0DD\uBC30)'],
  '\uD0DD\uBC30\uC0AC\uBA85\uC774 \uBD99\uC740 \uC1A1\uC7A5 \uD5E4\uB354\uB294 \uC5C5\uCCB4 \uBDF0\uC5B4\uC5D0 \uD3EC\uD568\uD55C\uB2E4'
);

console.log('advertiserTrackingCarrierLabel: passed');
