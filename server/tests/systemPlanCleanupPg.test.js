'use strict';
/**
 * 시스템이 옮겨 적은 날짜별 계획 정리(결정 182 4단계)를 **실제 PostgreSQL** 에서 돌린다.
 * 고정: 미리보기 쓰기 0 · 내일 이후만(오늘·지난 날 보존) · 사람·오더 휴무일 무접촉 · 기본은 `작업표:` 만 ·
 *       조회 뒤 바뀐 값은 지우지 않음 · 이력 남김 · 지운 공고만 작업표 날짜 맞추기 · 보관 공고 제외 · 공고 골라 실행.
 * 실행: PGTEST_URL=postgres://... node tests/systemPlanCleanupPg.test.js
 */
const assert = require('assert');

if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 시스템 계획 정리 실제 PG 검증 건너뜀');
  process.exit(0);
}

const { Pool } = require('pg');
const svc = require('../src/services/systemPlanCleanup.service');
const cp = require('../src/services/campaignPlan.service');

const SCHEMA = 'spc_test_' + process.pid;
let passed = 0;
const ok = (n, c, x) => { assert.ok(c, n + (x ? ' :: ' + x : '')); passed++; console.log('  ✓ ' + n); };
const TODAY = '2026-09-26';

(async () => {
  const admin = new Pool({ connectionString: process.env.PGTEST_URL });
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  const pool = new Pool({ connectionString: process.env.PGTEST_URL, options: `-c search_path=${SCHEMA}` });
  const origPreview = cp.previewPlanProjection, origRelay = cp.relayCampaignWorktable;
  try {
    await pool.query(`
      CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT, status TEXT, archived_at TIMESTAMPTZ);
      CREATE TABLE campaign_daily_plans (campaign_id TEXT, plan_date DATE, planned_count INT, updated_by TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (campaign_id, plan_date));
      CREATE TABLE campaign_plan_events (id SERIAL, campaign_id TEXT, actor TEXT, action TEXT, detail JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO recruit_campaigns VALUES ('A','공고A','active',NULL),('B','공고B','closed',NULL),('Z','보관','active',NOW());
      INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count, updated_by) VALUES
        ('A','2026-09-25',3,'작업표:관리자'),     -- 지난 날(이월 기준선) → 남긴다
        ('A','2026-09-26',3,'작업표:관리자'),     -- 오늘 → 남긴다
        ('A','2026-09-28',3,'작업표:관리자'),     -- 대상
        ('A','2026-09-29',5,'망고'),              -- 사람 → 무접촉
        ('A','2026-10-03',0,'오더휴무:관리자'),    -- 오더 휴무일 → 무접촉
        ('A','2026-10-05',4,'행삭제 보충:망고'),   -- 기본 kinds 에선 제외
        ('B','2026-09-30',3,'작업표:관리자'),     -- 대상(마감 공고도 보관 전이면)
        ('Z','2026-09-30',3,'작업표:관리자');     -- 보관 공고 → 제외
    `);
    svc.__setPoolForTest(pool);
    const relayed = [];
    cp.previewPlanProjection = async (id, body) => ({ projection: { endDate: (body && body.remove && body.remove.length) ? '2026-11-20' : '2026-11-10' } });
    cp.relayCampaignWorktable = async (id) => { relayed.push(id); return { ok: true, moved: 1 }; };
    const snap = async () => (await pool.query(`SELECT campaign_id||' '||to_char(plan_date,'MM-DD') AS k FROM campaign_daily_plans ORDER BY 1`)).rows.map(r => r.k).join(',');
    const before = await snap();

    console.log('\n[1] 미리보기');
    const pv = await svc.cleanupSystemPlans({ today: TODAY });
    ok('쓰기 0(표 그대로)', (await snap()) === before);
    ok('내일부터 · 기본은 작업표: 만', pv.from === '2026-09-27' && JSON.stringify(pv.prefixes) === '["작업표:"]');
    const pa = pv.campaigns.find(c => c.campaignId === 'A');
    ok('공고A 대상 = 9/28 하나(지난 날·오늘·사람·오더휴무·행삭제 제외)', pa && pa.days.map(d => d.date).join() === '2026-09-28', JSON.stringify(pa));
    ok('마감 공고B 포함 · 보관 공고Z 제외', pv.campaigns.some(c => c.campaignId === 'B') && !pv.campaigns.some(c => c.campaignId === 'Z'));
    ok('예상 종료일 전·후를 보여 준다', pa.endBefore === '2026-11-10' && pa.endAfter === '2026-11-20');
    ok('총 2일', pv.days === 2);
    const pv2 = await svc.cleanupSystemPlans({ today: TODAY, kinds: ['worktable', 'rowDelete'] });
    ok('kinds 로 행삭제도 고를 수 있다', pv2.days === 3 && pv2.campaigns.find(c => c.campaignId === 'A').days.some(d => d.kind === 'rowDelete'));

    console.log('\n[2] 실행 — 조회 뒤 사람이 바꾼 날은 지우지 않는다');
    // 미리보기 뒤 사람이 B 의 9/30 을 고쳤다(작성자 바뀜) — 서버가 다시 고르므로 대상에서 빠지는지 + 낙관적 조건
    await pool.query(`UPDATE campaign_daily_plans SET updated_by='망고', planned_count=6 WHERE campaign_id='B'`);
    const run = await svc.cleanupSystemPlans({ confirm: true, today: TODAY, by: '테스터' });
    ok('지운 것 = A 9/28 하나', run.removed === 1, JSON.stringify(run));
    const after = await snap();
    ok('남은 것: A 지난날·오늘·사람·오더휴무·행삭제, B(사람이 고침), Z(보관)',
      after === 'A 09-25,A 09-26,A 09-29,A 10-03,A 10-05,B 09-30,Z 09-30', after);
    const ev = (await pool.query(`SELECT campaign_id, actor, action, detail FROM campaign_plan_events`)).rows;
    ok('이력 1건(되돌리기 재료: 지운 날짜·인원·작성자)', ev.length === 1 && ev[0].action === 'system_plan_cleanup' && ev[0].actor === '테스터'
      && ev[0].detail.removed[0].date === '2026-09-28' && ev[0].detail.removed[0].count === 3 && ev[0].detail.removed[0].updatedBy === '작업표:관리자');
    ok('지운 공고만 작업표 날짜 맞추기', JSON.stringify(relayed) === '["A"]');
    relayed.length = 0;

    console.log('\n[2b] 미리보기 뒤 보관된 공고 · 도중에 자정이 지난 경우(Codex 리뷰)');
    await pool.query(`INSERT INTO recruit_campaigns VALUES ('C','공고C','active',NULL),('D','공고D','active',NULL);
      INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count, updated_by) VALUES
        ('C','2026-10-02',3,'작업표:관리자'), ('D','2026-09-27',3,'작업표:관리자'), ('D','2026-10-02',3,'작업표:관리자')`);
    // 실행이 C 를 잠그기 직전에 보관된다(목록 조회 → 잠금 사이) — 목록 조회 쿼리 뒤에 보관을 끼워 넣는다
    const realQuery = pool.query.bind(pool);
    let armed = true;
    pool.query = async (...a) => { const r = await realQuery(...a);
      if (armed && /FROM campaign_daily_plans p/.test(String(a[0]))) { armed = false; await realQuery(`UPDATE recruit_campaigns SET archived_at=NOW() WHERE id='C'`); }
      return r; };
    // 시작은 9/26(내일=9/27) 이었는데 지우는 순간엔 9/27 이 됐다 → D 의 9/27 은 이제 "오늘"이라 남긴다
    const mid = await svc.cleanupSystemPlans({ confirm: true, today: TODAY, campaignIds: ['C', 'D'], todayFn: () => '2026-09-27' });
    pool.query = realQuery;
    const cRes = mid.campaigns.find(c => c.campaignId === 'C'), dRes = mid.campaigns.find(c => c.campaignId === 'D');
    ok('★ 잠근 뒤 보관이 확인되면 지우지 않는다(복원용 데이터 보존)', cRes && cRes.skipped === 'archived' && (await snap()).includes('C 10-02'), JSON.stringify(cRes));
    ok('★ 지우는 순간 오늘이 된 날(9/27)은 남기고 그 뒤(10/2)만 지운다', dRes && dRes.removed === 1
      && (await snap()).includes('D 09-27') && !(await snap()).includes('D 10-02'), JSON.stringify(dRes));
    await pool.query(`DELETE FROM campaign_daily_plans WHERE campaign_id IN ('C','D'); DELETE FROM recruit_campaigns WHERE id IN ('C','D')`);

    console.log('\n[3] 공고 골라 실행 · 다시 돌려도 무변경(멱등)');
    await pool.query(`INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count, updated_by) VALUES ('B','2026-10-01',3,'작업표:관리자')`);
    const onlyA = await svc.cleanupSystemPlans({ confirm: true, today: TODAY, campaignIds: ['A'] });
    ok('campaignIds=[A] 면 B 는 건드리지 않는다', onlyA.removed === 0 && (await snap()).includes('B 10-01'));
    const again = await svc.cleanupSystemPlans({ confirm: true, today: TODAY, campaignIds: ['B'] });
    ok('B 만 골라 실행', again.removed === 1 && !(await snap()).includes('B 10-01'));
    const third = await svc.cleanupSystemPlans({ confirm: true, today: TODAY });
    ok('다시 돌리면 지울 것 0', third.removed === 0 && third.days === 0);

    console.log(`\nsystemPlanCleanupPg: ${passed} passed`);
  } finally {
    cp.previewPlanProjection = origPreview; cp.relayCampaignWorktable = origRelay;
    svc.__setPoolForTest(null);
    await pool.end();
    await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await admin.end();
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
