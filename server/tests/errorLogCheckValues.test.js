'use strict';
// 이상로그(error_logs) 기록이 표의 CHECK 허용값을 벗어나 조용히 버려지지 않게 고정한다.
// 2026-10-12 실측: 구매양식 "신원 경고 확인 후 제출" 기록이 source:'validation'(허용값 아님)이라
// 2026-07-14 부터 매번 CHECK 위반으로 저장 실패 — 관리자 화면에 한 번도 안 떴다(무신호).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.ERRORLOG_ENABLED;
delete process.env.ERRORLOG_AI_ENRICH;
const pool = require('../src/db/pool');
const EL = require('../src/services/errorLog.service');
const root = path.resolve(__dirname, '..');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// 1) 사전 키 = 표 CHECK 허용값(026)
const mig = fs.readFileSync(path.join(root, 'migrations/026_error_logs.sql'), 'utf8');
const allowed = (col) => {
  const m = mig.match(new RegExp(col + "\\s+IN\\s*\\(([^)]*)\\)"));
  assert(m, col + ' CHECK 를 찾지 못함');
  return m[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1)).sort();
};
assert.deepStrictEqual(Object.keys(EL.CATEGORY_PHRASES).sort(), allowed('category'), 'category 사전 = CHECK 허용값');
assert.deepStrictEqual(Object.keys(EL.SOURCE_PHRASES).sort(), allowed('source'), 'source 사전 = CHECK 허용값');
console.log('PASS 사전 키 = 표 CHECK 허용값');

// 2) 모든 logAbnormal 호출의 문자열 category/source 가 허용값 안
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'src'));
let calls = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').replace(/\u0000/g, '');
  const re = /logAbnormal\(\{([\s\S]{0,400}?)\}\)/g;
  let m;
  while ((m = re.exec(src))) {
    calls++;
    for (const [key, dict] of [['category', EL.CATEGORY_PHRASES], ['source', EL.SOURCE_PHRASES]]) {
      const v = m[1].match(new RegExp('\\b' + key + ":\\s*'([^']*)'"));
      if (v) assert(own(dict, v[1]), `${path.relative(root, f)}: ${key}:'${v[1]}' 는 표 CHECK 허용값이 아니다`);
    }
  }
}
assert(calls >= 10, '호출을 충분히 찾았다(' + calls + ')');
console.log('PASS 호출 ' + calls + '곳 — 문자열 category/source 모두 허용값');

// 3) 허용값 밖이 들어와도 저장값은 허용값으로 바뀐다(버려지지 않는다)
(async () => {
  const orig = pool.query;
  const seen = [];
  pool.query = async (sql, params) => { seen.push({ sql: String(sql), params }); return { rows: [{ id: 1, occurrence_count: 2 }] }; };
  try {
    await EL.logAbnormal({ flow: 'order_submit', step: 'x', source: 'validation', category: 'bogus', error: new Error('필수 값 검증 실패') });
    const ins = seen.find((x) => /INSERT INTO error_logs/.test(x.sql));
    assert(ins, 'INSERT 실행');
    const [, , , , , category, source] = ins.params;
    assert(own(EL.CATEGORY_PHRASES, category) && own(EL.SOURCE_PHRASES, source), `저장값 허용 범위: ${category}/${source}`);
    assert.strictEqual(category, 'validation', '잘못된 category 는 오류 내용으로 다시 분류');
    assert.strictEqual(source, 'server');
    // 상속 키('constructor'·'__proto__')를 허용값으로 착각하지 않는다(Codex P2)
    seen.length = 0;
    await EL.logAbnormal({ flow: 'order_submit', step: 'y', category: 'constructor', source: '__proto__', error: new Error('필수 값 검증 실패') });
    const p1 = seen.find((x) => /INSERT INTO error_logs/.test(x.sql)).params;
    assert.deepStrictEqual([p1[5], p1[6]], ['validation', 'server'], '상속 키는 추론값으로');
    // 허용값은 그대로 존중
    seen.length = 0;
    await EL.logAbnormal({ flow: 'order_submit', step: 'identity_confirm_override', category: 'validation', source: 'server', severity: 'warn', error: new Error('신원 유사도 경고 확인 후 제출 (리뷰어 확인 완료)') });
    const p2 = seen.find((x) => /INSERT INTO error_logs/.test(x.sql)).params;
    assert.deepStrictEqual([p2[0], p2[5], p2[6]], ['warn', 'validation', 'server']);
  } finally { pool.query = orig; }
  console.log('PASS 허용값 밖 → 추론값으로 저장 · 허용값은 그대로');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
