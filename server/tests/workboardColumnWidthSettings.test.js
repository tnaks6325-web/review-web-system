/**
 * 작업보드 열 너비 설정 회귀가드.
 * 실행: node tests/workboardColumnWidthSettings.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'),
  'utf8',
).replace(/\r\n/g, '\n');

// 실제 계산·저장 함수를 브라우저 저장소 모형에서 실행한다.
const start = src.indexOf('const _GRID_CELL_PAD=');
const end = src.indexOf('// 커스텀 열 표시명', start);
assert.ok(start >= 0 && end > start, '열 너비 계산/설정 블록을 찾지 못했습니다.');
const storage = new Map();
const context = {
  STATE: {
    role: 'staff', name: '김수만',
    cur: { sheetId: 'sheet-1', tabName: '작업-A' },
    wd: { headers: ['주소'], roster: [{ 주소: '서울시 강남구' }], customColumns: [] },
    gWidthScope: '', gWidthPrefs: Object.create(null), gWidthEditor: null,
  },
  localStorage: {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
  },
  document: {
    createElement: () => ({ getContext: () => ({
      font: '', measureText: text => ({ width: [...String(text)].length * 10 }),
    }) }),
    querySelector: () => null,
  },
  _colLabel: key => key,
  gCellDisp: (row, key) => row[key] || '',
};
vm.runInNewContext(`${src.slice(start, end)}
globalThis.autoWidths=_gridAutoColumnWidths;
globalThis.applyPrefs=_gridApplyWidthPrefs;
globalThis.savePrefs=_gridSaveWidthPrefs;
globalThis.loadPrefs=_gridLoadWidthPrefs;`, context);

const cols = [{ key: '주소' }];
const auto = context.autoWidths(context.STATE.wd, cols);
const autoWidth = auto.get('주소');
assert.ok(context.savePrefs({ 주소: 320 }), '수동 너비가 저장되어야 합니다.');
assert.strictEqual(context.loadPrefs().주소, 320, '현재 작업표의 수동 너비를 다시 읽어야 합니다.');
assert.strictEqual(context.applyPrefs(auto, cols).get('주소'), 320, '수동 너비는 자동 계산값보다 우선해야 합니다.');
assert.notStrictEqual(autoWidth, 320, '테스트의 자동값과 수동값은 달라야 합니다.');

context.STATE.cur = { sheetId: 'sheet-1', tabName: '작업-B' };
assert.strictEqual(context.loadPrefs().주소, undefined, '다른 작업표에는 수동 너비가 번지면 안 됩니다.');

// 화면 배선: 빠른 드래그 + 정밀 설정 + 자동 복귀가 모두 있어야 한다.
assert.match(src, /class="gresize" aria-hidden="true"/, '헤더 우측 드래그 핸들이 필요합니다.');
assert.match(src, /e\.target\.closest\('\.gresize'\)/, '헤더 선택과 너비 드래그를 구분해야 합니다.');
assert.match(src, /onclick="openGridWidthSettings\(\)"[^>]*>↔ 열 너비<\/button>/, '그리드 툴바에 열 너비 버튼이 필요합니다.');
assert.match(src, /type="range"[^>]*class="gw-range"|class="gw-range" type="range"/, '빠른 슬라이더가 필요합니다.');
assert.match(src, /class="gw-number" type="number"/, '정확한 픽셀 입력이 필요합니다.');
assert.match(src, /onclick="_gridWidthResetAll\(\)"/, '전체 자동맞춤 복귀가 필요합니다.');
assert.match(src, /id="workdeskWidthSettingsMount"/, '상단 설정 메뉴에도 열 너비 설정 진입점이 필요합니다.');
assert.ok(
  (src.match(/STATE\.gColWidths=_gridApplyWidthPrefs\(STATE\.gColWidths,(?:vcols|cols)\)/g) || []).length >= 2,
  '첫 렌더와 셀 편집 후 재계산 모두 저장된 수동 너비를 적용해야 합니다.',
);

console.log('✓ 작업보드 열 너비: 헤더 드래그 + 설정창 + 작업표별 저장 + 자동맞춤 복귀');
