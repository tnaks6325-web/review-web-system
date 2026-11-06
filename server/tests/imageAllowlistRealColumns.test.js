'use strict';
// 결정 352 — 사진 허용 목록의 출처 칸은 실제 마이그레이션이 만든 칸이어야 한다.
//   PR #1790 의 첫 판은 시험용 가짜 표에만 있던 reviewer_event_logs.capture_file_id 를 출처로 잡아,
//   빈 DB 에서 migration 216 이 42703 으로 실패하고 서버가 부팅을 거부했다(테스트 서버에서 발견 · 운영 미반영).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const allow = require(path.join(SERVER, 'src/services/imageAllowlist.service.js'));
const sql = fs.readdirSync(path.join(SERVER, 'migrations')).filter(f => f.endsWith('.sql') && !f.startsWith('216_'))
  .map(f => fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8')).join('\n')
  .replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
const NEW_IN_216 = new Set(['guide_image_files']);

function declared(table, column) {
  const create = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} ?\\(`, 'i');
  const m = create.exec(sql);
  if (m) {
    let depth = 0, i = m.index + m[0].length - 1, end = i;
    for (; i < sql.length; i++) { if (sql[i] === '(') depth++; else if (sql[i] === ')' && --depth === 0) { end = i; break; } }
    if (new RegExp(`[(,] ?${column} `, 'i').test(sql.slice(m.index + m[0].length - 1, end + 1))) return true;
  }
  const alter = new RegExp(`ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${table} [^;]*ADD COLUMN (?:IF NOT EXISTS )?${column} `, 'i');
  return alter.test(sql);
}

test('every image-allowlist source column is created by a real migration (not only by test fixtures)', () => {
  const all = allow.DRIVE_IMAGE_SOURCES.concat(allow.PRIVATE_SOURCES, allow.GUIDE_IMAGE_SOURCES);
  const missing = all.filter(s => s.column && !NEW_IN_216.has(s.table) && !declared(s.table, s.column))
    .map(s => `${s.table}.${s.column}`);
  assert.deepEqual(missing, []);
});
