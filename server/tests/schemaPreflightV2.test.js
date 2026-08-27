'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('V2 작업표 의존 열과 상태열 바인딩 표가 시작 전 점검 대상이다', () => {
  assert.match(source, /\['work_orders', 'workboard_schema_version'\]/);
  assert.match(source, /\['work_orders', 'work_series_id'\]/);
  assert.match(source, /\['work_orders', 'work_round'\]/);
  assert.match(source, /\['tab_configs', 'workboard_schema_version'\]/);
  assert.match(source, /const REQUIRED_TABLES = \[[\s\S]*'tab_status_column_bindings'/);
  assert.match(source, /information_schema\.tables[\s\S]*table_name = ANY/);
  assert.match(source, /table:\$\{t\}/);
});
