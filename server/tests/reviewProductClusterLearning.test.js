/**
 * 상품명 군집판단(148) 회귀가드.
 * 실행: node tests/reviewProductClusterLearning.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/reviewInspect.service');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readFront = f => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', f), 'utf8');

let n = 0;
const ok = name => { n++; console.log('  ✓ ' + name); };

function productRow(fileId, { observed = '모키위키 모기 기피제', extra = {}, status = 'suspect' } = {}) {
  return {
    file_id: fileId, sheet_id: 'S', tab_name: 'T', status,
    ocr_product: observed, product_resolution: null,
    checks: {
      format: { verdict: 'pass' },
      product: { verdict: 'warn', expected: ['모기위키 모기기피제'], ocr: observed },
      duplicate: { verdict: 'pass' }, similarity: { verdict: 'pass' }, author: { verdict: 'pass' },
      ...extra,
    },
  };
}

(async () => {
  // A. 안정 군집키 + 작업 격리
  const base = { sheetId: 'S', tabName: 'T', expectedList: ['모기위키 모기기피제'], ocr: '모키위키 모기 기피제…' };
  const key = svc.productClusterKey(base);
  assert.strictEqual(key.length, 24);
  assert.strictEqual(key, svc.productClusterKey({ ...base, expectedList: [' 모기위키   모기기피제 '] }));
  assert.notStrictEqual(key, svc.productClusterKey({ ...base, tabName: '다른 작업' }));
  assert.notStrictEqual(key, svc.productClusterKey({ ...base, ocr: '다른 상품' }));
  ok('A1: 공백·말줄임은 같은 군집, 작업·OCR 변경은 다른 군집');

  // B. 사람 exact 규칙 적용
  const machine = svc.matchProductName('메디큐브 파라다이스 그레인', ['8/11(쿠팡)메디슨벨_파라다이스 그레인 300건']);
  assert.strictEqual(machine.verdict, 'warn');
  const a6Key = svc.productClusterKey({ sheetId: 'S', tabName: 'T', expectedList: machine.expected, ocr: machine.ocr });
  const learnedPass = svc.applyProductRule(machine, [{ id: 'r1', clusterKey: a6Key, verdict: 'pass', active: true }], { sheetId: 'S', tabName: 'T' });
  assert.strictEqual(learnedPass.check.verdict, 'pass');
  assert.strictEqual(learnedPass.check.machineVerdict, 'warn');
  assert.strictEqual(learnedPass.check.learnedRuleId, 'r1');
  const learnedFail = svc.applyProductRule(machine, [{ id: 'r2', clusterKey: a6Key, verdict: 'fail', active: true }], { sheetId: 'S', tabName: 'T' });
  assert.strictEqual(learnedFail.check.verdict, 'fail');
  assert.strictEqual(svc.applyProductRule(machine, [{ id: 'x', clusterKey: a6Key, verdict: 'unknown' }], { sheetId: 'S', tabName: 'T' }).check.verdict, 'warn');
  ok('B1: pass/fail exact 규칙만 적용하고 기계 원판정 보존');

  // B2. 단독 OCR 안전 자동처리: 긴 오타/잘림만 통과, 숫자 충돌·낮은 유사도는 보류
  {
    const safe = svc.classifyProductNameForAuto(
      '낫세린 슈퍼 넛 너리싱 밤 168시간 보습력 지속, 50ml, 1개',
      ['[상품', '넛세린 슈퍼 넛 너리싱 밤 168시간 보습력 지속, 50ml, 1개', '[합계] 최종모집인원 200명']);
    assert.strictEqual(safe.eligible, true);
    assert.strictEqual(safe.reason, 'high_confidence_ocr');
    assert.strictEqual(safe.bestExpected.startsWith('넛세린'), true, '작업오더 구조문구는 기대 상품에서 제외');
    const numberConflict = svc.classifyProductNameForAuto(
      '장수돌침대 28년형 올뉴블랙에디션 카본 탄소매트 전자파없는 전기매트',
      ['장수돌침대 26년형 올뉴블랙에디션 카본 탄소매트 전자파없는 전기매트']);
    assert.strictEqual(numberConflict.eligible, false);
    assert.strictEqual(numberConflict.reason, 'numeric_conflict');
    assert.strictEqual(svc.classifyProductNameForAuto('바디로션', ['바디워시']).eligible, false);
    assert.strictEqual(svc.matchProductName('상품 상세페이지', ['[상품', '[합계] 최종모집인원 200명']).verdict, 'skip',
      '작업오더 구조문구만 있으면 상품명 기준 없음으로 처리');
    ok('B2: 96% 고신뢰 OCR만 자동통과하고 숫자 충돌·짧은 표기는 보류');
  }

  // C. 목록 200건과 독립된 군집 집계
  {
    const rows = [productRow('F1'), productRow('F2'), productRow('F3', { observed: '모기키위 모기 기피제' })];
    const pool = { query: async () => ({ rows }) };
    svc.__setPoolForTest(pool);
    const out = await svc.listProductClusters({ limit: 20 });
    assert.strictEqual(out.totalRows, 3);
    assert.strictEqual(out.totalClusters, 2);
    assert.strictEqual(out.singletonClusters, 1);
    assert.ok(out.triageReasons && out.triageReasons.too_short);
    assert.strictEqual(out.clusters[0].count, 2);
    assert.deepStrictEqual(out.clusters[0].sampleFileIds, ['F1', 'F2']);
    assert.ok(/LIMIT \$1/.test(String(pool.lastSql || '')) || out.clusters.length === 2);
    ok('C1: 동일 작업·기대값·OCR 2건을 한 군집으로 집계');
  }

  // C2. 자동처리는 dry-run 결과를 먼저 내고 명시 확인값 없이는 쓰지 않는다
  {
    const safe = productRow('F1', { observed: '낫세린 슈퍼 넛 너리싱 밤 168시간 보습력 지속, 50ml, 1개' });
    safe.checks.product.expected = ['넛세린 슈퍼 넛 너리싱 밤 168시간 보습력 지속, 50ml, 1개'];
    const blocked = productRow('F2', { observed: '장수돌침대 28년형 올뉴블랙에디션 카본 탄소매트 전자파없는 전기매트' });
    blocked.checks.product.expected = ['장수돌침대 26년형 올뉴블랙에디션 카본 탄소매트 전자파없는 전기매트'];
    let calls = 0;
    svc.__setPoolForTest({ query: async () => { calls++; return { rows: [safe, blocked] }; } });
    const preview = await svc.autoResolveProductClusters({ dryRun: true });
    assert.strictEqual(preview.eligibleClusters, 1);
    assert.strictEqual(preview.eligibleRows, 1);
    const denied = await svc.autoResolveProductClusters({ dryRun: false });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(calls, 2, '두 실행 모두 목록 조회만 하고 판정 UPDATE는 하지 않음');
    ok('C2: dry-run 선행 + 명시 확인값 없는 자동 쓰기 차단');
  }

  // D. 군집판정: 상품명만 종결, 다른 축은 그대로 open, 작업 exact 규칙 저장
  {
    const seed = productRow('F1');
    const withDuplicate = productRow('F2', { extra: { duplicate: { verdict: 'warn', matchFileId: 'OLD' } } });
    const calls = [];
    const pool = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM review_inspections WHERE file_id/.test(sql)) return { rows: [seed] };
        if (/FROM review_inspections\s+WHERE sheet_id/.test(sql)) return { rows: [seed, withDuplicate] };
        if (/SELECT inspect_product_rules/.test(sql)) return { rows: [{ inspect_product_rules: [] }] };
        return { rows: [], rowCount: 1 };
      },
    };
    svc.__setPoolForTest(pool);
    const out = await svc.resolveProductCluster({ fileId: 'F1', verdict: 'pass', note: 'OCR 오타', by: '관리자' });
    assert.strictEqual(out.affected, 2);
    assert.strictEqual(out.remainsOpen, 1, '중복 warn 이 남은 F2는 전체 종결 금지');
    assert.strictEqual(out.ruleSaved, true);
    const updates = calls.filter(c => /UPDATE review_inspections/.test(c.sql));
    assert.strictEqual(updates.length, 2);
    assert.strictEqual(updates[0].params[2], 'resolved');
    assert.strictEqual(updates[1].params[2], 'suspect');
    const checks2 = JSON.parse(updates[1].params[1]);
    assert.strictEqual(checks2.product.humanVerdict, 'pass');
    assert.strictEqual(checks2.product.machineVerdict, 'warn');
    assert.strictEqual(checks2.duplicate.verdict, 'warn');
    const ruleWrite = calls.find(c => /inspect_product_rules = \$1::jsonb/.test(c.sql));
    const rules = JSON.parse(ruleWrite.params[0]);
    assert.strictEqual(rules[0].verdict, 'pass');
    assert.strictEqual(rules[0].evidenceCount, 2);
    ok('D1: 상품명 군집만 소급 종결하고 다른 오류는 open 유지');
  }

  // D2. 미통과는 checks 에도 남되 상품명 축을 제외한 다른 오류만 open 여부를 정한다
  {
    const seed = productRow('F1');
    const withDuplicate = productRow('F2', { extra: { duplicate: { verdict: 'warn', matchFileId: 'OLD' } } });
    const calls = [];
    const pool = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM review_inspections WHERE file_id/.test(sql)) return { rows: [seed] };
      if (/FROM review_inspections\s+WHERE sheet_id/.test(sql)) return { rows: [seed, withDuplicate] };
      if (/SELECT inspect_product_rules/.test(sql)) return { rows: [{ inspect_product_rules: [] }] };
      return { rows: [], rowCount: 1 };
    } };
    svc.__setPoolForTest(pool);
    const out = await svc.resolveProductCluster({ fileId: 'F1', verdict: 'fail', by: '관리자' });
    assert.strictEqual(out.remainsOpen, 1);
    const updates = calls.filter(c => /UPDATE review_inspections/.test(c.sql));
    assert.strictEqual(updates[0].params[2], 'resolved', '상품명 단독 fail 은 bad 로 전체 종결');
    assert.strictEqual(updates[0].params[7], 'bad');
    assert.strictEqual(updates[1].params[2], 'suspect', '다른 warn 이 남은 건만 open');
    assert.strictEqual(JSON.parse(updates[1].params[1]).product.verdict, 'fail', '확정 fail 근거 보존');
    ok('D2: 미통과 근거 보존 + 다른 축만으로 open 여부 계산');
  }

  // D3. 500개를 넘겨도 오래된 exact 규칙을 조용히 버리지 않는다
  {
    const seed = productRow('F1');
    const oldRules = Array.from({ length: 500 }, (_, i) => ({ id: `old-${i}`, clusterKey: `old-key-${i}`, verdict: 'pass' }));
    const calls = [];
    const pool = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM review_inspections WHERE file_id/.test(sql)) return { rows: [seed] };
      if (/FROM review_inspections\s+WHERE sheet_id/.test(sql)) return { rows: [seed] };
      if (/SELECT inspect_product_rules/.test(sql)) return { rows: [{ inspect_product_rules: oldRules }] };
      return { rows: [], rowCount: 1 };
    } };
    svc.__setPoolForTest(pool);
    await svc.resolveProductCluster({ fileId: 'F1', verdict: 'pass', by: '관리자' });
    const ruleWrite = calls.find(c => /inspect_product_rules = \$1::jsonb/.test(c.sql));
    const saved = JSON.parse(ruleWrite.params[0]);
    assert.strictEqual(saved.length, 501);
    assert.ok(saved.some(r => r.clusterKey === 'old-key-499'));
    ok('D3: 501번째 판단도 기존 exact 규칙을 축출하지 않음');
  }

  // E. 판단불가/기준오류는 현재 군집만 끝내고 미래 규칙을 만들지 않는다
  {
    const seed = productRow('F1');
    const calls = [];
    const pool = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM review_inspections WHERE file_id/.test(sql)) return { rows: [seed] };
      if (/FROM review_inspections\s+WHERE sheet_id/.test(sql)) return { rows: [seed] };
      return { rows: [], rowCount: 1 };
    } };
    svc.__setPoolForTest(pool);
    const out = await svc.resolveProductCluster({ fileId: 'F1', verdict: 'unknown', by: '관리자' });
    assert.strictEqual(out.ruleSaved, false);
    assert.ok(!calls.some(c => /inspect_product_rules/.test(c.sql)), 'unknown 은 규칙 조회/쓰기 없음');
    ok('E1: 판단불가 = 현 군집 종결, 미래 자동학습 없음');
  }

  // F. 마이그레이션·권한·화면 배선
  {
    const mig = read('migrations/148_review_product_cluster_learning.sql');
    const idx = read('index.js');
    const routes = read('src/routes/trackB.routes.js');
    const serviceSrc = read('src/services/reviewInspect.service.js');
    const front = readFront('workdesk.html');
    for (const col of ['product_resolution','product_resolution_note','product_resolved_at','product_resolved_by','product_cluster_key']) {
      assert.ok(mig.includes(`ADD COLUMN IF NOT EXISTS ${col}`));
      assert.ok(idx.includes(`['review_inspections', '${col}']`));
    }
    assert.ok(mig.includes('inspect_product_rules JSONB'));
    assert.ok(idx.includes("['tab_configs', 'inspect_product_rules']"));
    assert.ok(/jsonb_set\(EXCLUDED\.checks, '\{product\}'/.test(serviceSrc),
      '다른 사유 재검수 때 이미 끝난 상품명 판단을 기계 경고로 되돌리지 않는다');
    assert.ok(/'\/review-inspect\/product-clusters', authMiddleware, adminOrMasterMiddleware/.test(routes));
    assert.ok(/'\/review-inspect\/product-clusters\/decide', authMiddleware, adminOrMasterMiddleware/.test(routes));
    assert.ok(/'\/review-inspect\/product-clusters\/auto-resolve', authMiddleware, adminOrMasterMiddleware/.test(routes));
    assert.ok(front.includes('riOpenProductClusters') && front.includes("riProductDecide('pass')") && front.includes("riProductDecide('baseline_error')"));
    assert.ok(front.includes('단독 OCR 표기') && front.includes('riProductAutoResolve'));
    assert.ok(!/rules = \[rule,[^\n]*\.slice\(0, 500\)/.test(serviceSrc), 'exact 규칙 500개 조용한 축출 금지');
    ok('F1: 148 스키마 프리플라이트 + 관리자 전용 API + 4선택 UI');
  }

  svc.__setPoolForTest(null);
  console.log(`\n✅ 상품명 군집판단 회귀가드 ${n}케이스 통과`);
})().catch(e => { console.error('❌ 실패:', e); process.exit(1); });
