const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
// 옛 관리자 대시보드 폐기(결정 267) — 작업오더 런타임 카드(wo-runtime-card · index-app.js)는 화면째 사라졌다.
//   공유 모듈(work-order-detail.js)의 런타임 모달 마크업만 고정한다.
const editor = fs.readFileSync(path.join(root, 'frontend', 'js', 'work-order-detail.js'), 'utf8');

assert.match(editor, /wo-runtime-modal/);
assert.match(editor, /wo-runtime-modal__row/);
assert.match(editor, /wo-runtime-modal__choice/);

console.log('work-order-runtime-ui: passed');
