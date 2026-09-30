const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const workdesk = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'),
  'utf8',
).replace(/\r\n/g, '\n');

assert.match(
  workdesk,
  /function _gridAutoColumnWidths\(wd,cols\)/,
  '작업보드는 컬럼별 실제 표시값을 기준으로 폭을 계산해야 합니다.',
);
const start = workdesk.indexOf('const _GRID_CELL_PAD=');
const end = workdesk.indexOf('// 커스텀 열 표시명', start);
assert.ok(start >= 0 && end > start, '자동 폭 계산기 블록을 찾지 못했습니다.');
const context = { STATE:{wd:{customColumns:[]}}, document:{createElement:()=>({getContext:()=>({font:'',measureText:text=>({width:[...String(text)].length*10})})})}, _colLabel:key=>key, gCellDisp:(row,key)=>row[key]||'' };
vm.runInNewContext(`${workdesk.slice(start,end)}\nglobalThis.autoWidths=_gridAutoColumnWidths;`, context);
const cols=[{key:'수취인'}];
const shortWidth=context.autoWidths({roster:[{수취인:'김수만'}]},cols).get('수취인');
const longWidth=context.autoWidths({roster:[{수취인:'김수만'},{수취인:'김수만123'}]},cols).get('수취인');
assert.ok(longWidth>shortWidth, '더 긴 신규 데이터가 들어오면 해당 컬럼 폭이 넓어져야 합니다.');

console.log('✓ 작업보드 컬럼 폭: 최장 표시값 기준 + 긴 신규 데이터 자동 확장');
