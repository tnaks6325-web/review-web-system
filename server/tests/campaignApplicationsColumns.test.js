/* campaign_applications 에 없는 컬럼을 쓰는 UPDATE 를 막는다.
   실사고(2026-08-19): _hideParticipantInTx 가 존재하지 않는 updated_at 을 SET 해
   42703 → 트랜잭션 전체 롤백 → "구매기록이 붙은 행만 삭제가 안 되는" 상태가 됐다.
   함수 본문은 실행해야만 터지므로 정적 검사로 컬럼 존재를 미리 고정한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const NUL = String.fromCharCode(0);   // 소스에 리터럴 NUL 을 넣으면 이 파일까지 바이너리가 된다
const migDir = path.join(__dirname, '../migrations');
const srcDir = path.join(__dirname, '../src');

// ── 마이그레이션이 선언한 컬럼 집합 ──
const columns = new Set();
for (const f of fs.readdirSync(migDir).filter(n => n.endsWith('.sql'))) {
  const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
  const created = sql.match(/CREATE TABLE IF NOT EXISTS campaign_applications\s*\(([\s\S]*?)\n\);/);
  if (created) {
    for (const line of created[1].split('\n')) {
      const m = line.trim().match(/^([a-z_]+)\s+[A-Z]/);
      if (m) columns.add(m[1]);
    }
  }
  // ALTER TABLE campaign_applications … ; 블록 안의 ADD COLUMN 만 센다(다른 테이블 혼입 금지)
  for (const alter of sql.matchAll(/ALTER TABLE campaign_applications([\s\S]*?);/g)) {
    for (const c of alter[1].matchAll(/ADD COLUMN IF NOT EXISTS\s+([a-z_]+)/g)) columns.add(c[1]);
  }
}
assert.ok(columns.has('status') && columns.has('hold_token') && columns.has('late_order_id'),
  `컬럼 추출이 실패했습니다 — 파서를 확인하세요: ${[...columns].sort().join(', ')}`);
assert.ok(!columns.has('updated_at'), 'updated_at 이 생겼다면 이 테스트의 전제를 갱신하세요');

// ── 소스의 UPDATE campaign_applications SET 이 그 집합 안에만 있는지 ──
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(srcDir);

const bad = [];
let updates = 0;
for (const p of files) {
  const src = fs.readFileSync(p, 'utf8').split(NUL).join('');   // 의도된 NUL(복합키 구분자) 제거 후 검사
  for (const m of src.matchAll(/UPDATE campaign_applications[\s\S]{0,400}?SET([\s\S]{0,400}?)WHERE/g)) {
    updates++;
    // ★ `make_interval(mins => $2)` 같은 **명명 인자**(`=>`)는 컬럼 대입이 아니다 —
    //   부정 전방탐색이 없으면 멀쩡한 코드를 42703 위험으로 오탐한다(실제로 그랬다).
    for (const c of m[1].matchAll(/([a-z_]+)\s*=(?!>)/g)) {
      if (!columns.has(c[1])) bad.push(`${path.relative(srcDir, p)} → ${c[1]}`);
    }
  }
}
assert.ok(updates >= 5, `UPDATE 문을 충분히 읽지 못했습니다(${updates}건) — 추출 정규식을 확인하세요`);
assert.deepStrictEqual(bad, [], `campaign_applications 에 없는 컬럼을 SET 합니다(실행 시 42703):\n  ${bad.join('\n  ')}`);

console.log(`campaign_applications column contract passed (UPDATE ${updates}건 · 컬럼 ${columns.size}개)`);
