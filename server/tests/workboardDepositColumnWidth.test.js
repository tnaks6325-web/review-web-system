const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workdesk = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'),
  'utf8',
).replace(/\r\n/g, '\n');

assert.match(
  workdesk,
  /'입금':96/,
  '작업보드 입금 열은 날짜가 생략되지 않도록 96px 폭을 유지해야 합니다.',
);

console.log('✓ 작업보드 입금 열 폭: 96px');
