'use strict';

// Source-inspection tests compare JavaScript/HTML snippets with multiline regular
// expressions. Git may materialize those files as CRLF on Windows and LF in CI,
// so normalize text reads at the test-process boundary. Buffer reads remain exact.
const fs = require('fs');
const readFileSync = fs.readFileSync.bind(fs);

fs.readFileSync = function normalizedTextRead(...args) {
  const value = readFileSync(...args);
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
};
