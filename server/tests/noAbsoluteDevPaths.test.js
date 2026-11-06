'use strict';
// 시험이 다른 작업폴더(개발자 컴퓨터의 절대 경로)의 코드를 읽으면, 로컬에서는 통과하지만 실제로는
// 이 저장소의 코드를 검사하지 않고, CI 에서는 파일이 없어 실패한다(2026-11-06 PR #1775 CI 에서 실측).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('server tests never load code from absolute developer-machine paths', () => {
  const root = __dirname;
  const offenders = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
      if (!/\.(c|m)?js$/.test(e.name) || full === __filename) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/['"`]\/Users\/[^'"`]*|['"`]\/home\/[^'"`]*\/dev\/wt\//.test(src)) offenders.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
