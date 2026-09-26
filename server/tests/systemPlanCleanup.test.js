'use strict';
/**
 * 시스템 계획 정리 도구(결정 182 4단계) — DB 없이 도는 가드. 실제 SQL·삭제는 systemPlanCleanupPg.test.js.
 * 고정: 미리보기 쓰기 0 · 내일부터 · 기본 `작업표:` 만 · 사람/오더휴무 접두 없음 · 관리자 이상만 · 확인 없이는 실행 안 됨.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let passed = 0;
const ok = (n, c, x) => { assert.ok(c, n + (x ? ' :: ' + x : '')); passed++; console.log('  ✓ ' + n); };

const svc = require('../src/services/systemPlanCleanup.service');
const cp = require('../src/services/campaignPlan.service');
const src = fs.readFileSync(path.join(__dirname, '../src/services/systemPlanCleanup.service.js'), 'utf8');
const rt = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');

(async () => {
  const sqls = [];
  svc.__setPoolForTest({
    query: async (sql, params) => { sqls.push({ sql: String(sql), params });
      return { rows: [{ campaign_id: 'A', title: 'T', status: 'active', date: '2026-09-28', planned_count: 3, updated_by: '작업표:관리자' }] }; },
    connect: async () => { throw new Error('미리보기에서 연결(쓰기 트랜잭션)을 열면 안 된다'); },
  });
  const origPv = cp.previewPlanProjection;
  cp.previewPlanProjection = async () => ({ projection: { endDate: '2026-11-10' } });
  try {
    const r = await svc.cleanupSystemPlans({ today: '2026-09-26' });
    ok('미리보기 = 쓰기 0(SELECT 만 · 트랜잭션 안 엶)', r.dryRun === true && sqls.every(q => /^\s*SELECT/i.test(q.sql)));
    ok('★ 내일(9/27)부터 — 오늘·지난 날은 이월 기준선이라 남긴다', sqls[0].params[0] === '2026-09-27');
    ok('기본 접두 = 작업표: 만', JSON.stringify(sqls[0].params.slice(1)) === '["작업표:%"]');
    sqls.length = 0;
    await svc.cleanupSystemPlans({ today: '2026-09-26', kinds: ['nope'] });
    ok('모르는 종류는 기본(작업표:)으로 — 넓어지지 않는다', JSON.stringify(sqls[0].params.slice(1)) === '["작업표:%"]');
    const all = Object.values(svc.KIND_PREFIXES).flat();
    ok('★★ 사람·오더 휴무일 접두는 정리 대상이 아니다', !all.some(p => /오더휴무/.test(p)) && all.every(p => /^(작업표|행삭제)/.test(p)));
  } finally {
    cp.previewPlanProjection = origPv; svc.__setPoolForTest(null);
  }
  ok('실행은 서버가 다시 고르고 바뀐 값은 지우지 않는다(낙관적 조건)', /AND planned_count = \$3 AND updated_by = \$4/.test(src));
  ok('지운 값은 이력(system_plan_cleanup)에 남긴다', /'system_plan_cleanup'/.test(src));
  ok('지운 뒤 커밋 밖에서 작업표 날짜 맞추기', /COMMIT[\s\S]*relayCampaignWorktable\(camp\.campaignId/.test(src));
  ok('경로 = 관리자 이상 · confirm===true 일 때만 실행',
    /router\.post\('\/settings\/system-plan-cleanup', authMiddleware, adminOrMasterMiddleware/.test(rt)
    && /cleanupSystemPlans\(\{ confirm: b\.confirm === true/.test(rt));
  console.log(`\nsystemPlanCleanup: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
