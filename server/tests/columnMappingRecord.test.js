/**
 * recordDetectedMappings 회귀 가드 (컬럼 판정 DB화 1단계 — 자동기록).
 *   - 단일 원자 INSERT: WHERE NOT EXISTS(탭에 기존 행) + ON CONFLICT DO NOTHING → 수동 매핑 절대 미덮어씀.
 *   - name(PII)·src!=='keyword'·미검출 필드는 기록 안 함. 같은 col 중복 기록 안 함.
 *   - checksum 무효화(index_master UPDATE) 안 함 — 기록≡키워드 결과라 재파싱 불필요(쿼터 안전).
 *   - gid/meta 없으면 skip. 쿼리 실패해도 throw 안 함(best-effort).
 * 실행: node tests/columnMappingRecord.test.js
 */
const assert = require('assert');
const svc = require('../src/services/columnMapping.service');

function makePool({ fail = false, rowCount = 6 } = {}) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (fail) throw new Error('boom');
      return { rowCount, rows: [] };
    },
  };
}

const META = {
  headerRowIdx: 0,
  drift: [],
  fields: {
    name:          { col: 1, header: '주문자',   src: 'keyword' }, // PII — 기록 금지
    recipient:     { col: 2, header: '수취인',   src: 'keyword' },
    review_submit: { col: 4, header: '리뷰제출', src: 'keyword' },
    product:       { col: 6, header: '상품명',   src: 'keyword' },
    url:           { col: 7, header: '상품URL',  src: 'keyword' }, // resolver 미소비 — 기록 금지
    phone:         { col: 3, header: '연락처',   src: 'keyword' },
    start_date:    { col: -1, header: null,      src: 'none' },
    end_date:      { col: -1, header: null,      src: 'none' },
    round:         { col: -1, header: null,      src: 'none' },   // 미검출 — 기록 안 함
    payment:       { col: 5, header: '입금',     src: 'keyword' },
  },
};

async function run() {
  // ── 정상 기록: 원자 INSERT 1회, 가드 절 포함, name/url/none 제외 ──
  let pool = makePool({ rowCount: 4 });
  svc.__setPoolForTest(pool);
  let r = await svc.recordDetectedMappings({ sheetId: 'sheet1', tabGid: '99', tabName: '탭A', meta: META });
  assert.deepEqual(r, { recorded: 4 });
  assert.equal(pool.q.length, 1, '쿼리 1회(원자 INSERT)만');
  const ins = pool.q[0];
  assert.ok(/INSERT INTO tab_column_mappings/.test(ins.s), 'tab_column_mappings INSERT');
  assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM tab_column_mappings t WHERE t.sheet_id = \$1 AND t.tab_gid = \$2\)/.test(ins.s), '★ 기존 행 있으면 전체 skip(수동 매핑 보호)');
  assert.ok(/ON CONFLICT \(sheet_id, tab_gid, col_index\) DO NOTHING/.test(ins.s), '★ 경합 시 DO NOTHING');
  assert.ok(!/index_master/.test(ins.s), '★ checksum 무효화 없음(재파싱 불필요)');
  assert.equal(ins.params[0], 'sheet1');
  assert.equal(ins.params[1], '99', 'gid 문자열화');
  assert.equal(ins.params[2], '탭A');
  assert.equal(ins.params[3], 'auto:detect', '기본 provenance');
  const flat = ins.params.slice(4);
  assert.ok(!flat.includes('name'), '★ name(PII) 미기록');
  assert.ok(!flat.includes('url') && !flat.includes('start_date') && !flat.includes('end_date'), 'resolver 미소비 필드 미기록');
  assert.ok(!flat.includes('round'), '미검출(none) 필드 미기록');
  assert.ok(!flat.includes('review_submit'), '★ review_submit은 자동탐지로 기록하지 않음');
  for (const f of ['recipient', 'product', 'phone', 'payment']) {
    assert.ok(flat.includes(f), `${f} 기록됨`);
  }
  console.log('  정상 기록(원자 INSERT·가드·제외 규칙) 통과');

  // ── db 소스 필드는 재기록 안 함(이미 매핑 사용 중) ──
  pool = makePool();
  svc.__setPoolForTest(pool);
  const metaDb = { ...META, fields: { ...META.fields, review_submit: { col: 4, header: '리뷰제출', src: 'db' } } };
  await svc.recordDetectedMappings({ sheetId: 's', tabGid: '1', tabName: 't', meta: metaDb });
  assert.ok(!pool.q[0].params.slice(4).includes('review_submit'), '★ src=db 필드는 후보 제외');
  console.log('  db 소스 제외 통과');

  // ── 같은 컬럼 중복 매핑 방지(결정적: 먼저 온 필드 승) ──
  pool = makePool();
  svc.__setPoolForTest(pool);
  const metaDup = { ...META, fields: { ...META.fields, product: { col: 5, header: '입금', src: 'keyword' } } }; // payment와 같은 col5
  await svc.recordDetectedMappings({ sheetId: 's', tabGid: '1', tabName: 't', meta: metaDup });
  const dupFlat = pool.q[0].params.slice(4);
  assert.ok(dupFlat.includes('product') && !dupFlat.includes('payment'), '★ 같은 col은 첫 필드만(RECORDABLE 순서)');
  console.log('  중복 col 방지 통과');

  // ── skip 케이스: gid 없음 / meta 없음 / 후보 없음 → 쿼리 0회 ──
  pool = makePool();
  svc.__setPoolForTest(pool);
  assert.deepEqual(await svc.recordDetectedMappings({ sheetId: 's', tabGid: '', tabName: 't', meta: META }), { skipped: true, reason: 'no-gid' });
  assert.deepEqual(await svc.recordDetectedMappings({ sheetId: 's', tabGid: '1', tabName: 't', meta: null }), { skipped: true, reason: 'no-meta' });
  const metaNone = { headerRowIdx: 0, drift: [], fields: { name: { col: 1, header: 'x', src: 'keyword' } } };
  assert.deepEqual(await svc.recordDetectedMappings({ sheetId: 's', tabGid: '1', tabName: 't', meta: metaNone }), { skipped: true, reason: 'no-candidates' });
  assert.equal(pool.q.length, 0, 'skip 시 쿼리 없음');
  console.log('  skip 케이스 통과');

  // ── best-effort: 쿼리 실패해도 throw 안 함 ──
  pool = makePool({ fail: true });
  svc.__setPoolForTest(pool);
  r = await svc.recordDetectedMappings({ sheetId: 's', tabGid: '1', tabName: 't', meta: META });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'error');
  console.log('  best-effort(무throw) 통과');

  svc.__setPoolForTest(null);
}

run()
  .then(() => console.log('columnMappingRecord tests passed'))
  .catch(e => { console.error(e); process.exit(1); });
