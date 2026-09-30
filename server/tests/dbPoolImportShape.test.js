/* db/pool 구조분해 import 금지 — 레포 전체(src/) 회귀가드.
   (종전 sheetReadScope.test.js 1d — 그 진단 제거(2026-09-28, 결정 186 2번)로 독립 파일로 옮김)
   실측(2026-08-19): `const { getPool } = require('../db/pool')` 는 undefined → 호출 순간 TypeError →
   마스킹된 500("서버 오류가 발생했습니다"). 그 모듈은 풀 자체를 export 한다.
   스텁을 편의 모양으로 감싸면 단위 테스트가 이걸 가려 주므로 소스 전체를 훑는다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src');
const bad = [];
let scanned = 0;
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name);
    if (f.isDirectory()) walk(fp);
    else if (f.name.endsWith('.js')) {
      scanned++;
      if (/\{[^}]*\}\s*=\s*require\((['"])[^'"]*db\/pool\1\)/.test(fs.readFileSync(fp, 'utf8'))) bad.push(fp);
    }
  }
})(dir);
assert.ok(scanned > 50, `src/ 스캔이 비정상적으로 적다(${scanned}) — 경로가 틀렸다`);
assert.strictEqual(bad.length, 0, '★ db/pool 구조분해 import: ' + bad.join(', '));
console.log(`✅ dbPoolImportShape: src/ ${scanned}개 파일 — 구조분해 import 0`);
