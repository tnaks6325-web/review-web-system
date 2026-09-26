'use strict';
/**
 * 확정 인원 기준 = 신청·주문 중 큰 값 (결정 184 · 사용자 확정 2026-09-27 「A」)
 *
 * 고정:
 *  ① 합치는 것 = 어제까지 확정 · 이월/보류 기준선 이후 확정(구간마다 큰 값)
 *  ①' ★★ 오늘 확정은 합치지 않는다 — 신청 게이트는 작업표 오늘 채움으로 이미 세고, 탭 공유 오늘 합산이 두 번 센다(레드팀 R1·Y1·Y3)
 *  ①'' 표 기준 게이트가 켜졌을 때(on)만 — observe 에서 합치면 하루 인원만 0 이 돼 영구 잠금(레드팀 Y4)
 *  ② ★★ submittedAll(총원 마감 soft_full 재료)은 합치지 않는다 — 주문 기준 마감은 table_over_total(비영속) 경로(031)
 *  ③ 공유 작업표·탭 없음·조회 실패·구간 수 없음 = 합치지 않는다(종전 · 정원을 좁히지 않는다)
 *  ④ 끄는 스위치 CAMPAIGN_COUNT_BASIS=applications = 종전 그대로
 *  ⑤ 실제 효과: 공고 밖 주문이 남은 자리·앞날 예상·이월에 들어간다 · 오늘 판정의 오늘 확정은 신청 그대로(업소용 간장 모양 재현)
 *  ⑥ (PGTEST_URL) 실제 PG 에서 주문을 어제까지/오늘/이월 기준선 이후로 정확히 나눠 센다
 * 실행: node tests/countBasisMax.test.js
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const S = require('../src/services/campaignState.service');

let passed = 0;
const ok = (n, c, x) => { assert.ok(c, n + (x ? ' :: ' + x : '')); passed++; console.log('  ✓ ' + n); };

const base = () => ({
  activeHolds: 0, todayActiveHolds: 0, submittedAll: 362, todaySubmitted: 1, submittedBeforeToday: 361,
  carry: { startDate: '2026-08-01', submittedSince: 300 }, hold: { startDate: '2026-08-01', submittedSince: 300 },
  plans: null,
  linked: { ok: true, orders: 404, ordersAll: 404, ordersBefore: 401, ordersToday: 3, ordersSinceCarry: 340, ordersSinceHold: 339, sharedTab: false },
});

(async () => {
  console.log('\n[1] 합치기 — 구간마다 큰 값');
  {
    const o = base();
    S._mergeCountBasis(o);
    ok('어제까지 = max(361, 401) = 401', o.submittedBeforeToday === 401);
    ok('★★ 오늘 확정은 합치지 않는다(1 그대로 — 게이트는 작업표 오늘 채움으로 센다)', o.todaySubmitted === 1);
    ok('이월 기준선 이후 = max(300, 340)', o.carry.submittedSince === 340);
    ok('보류 기준선 이후 = max(300, 339)', o.hold.submittedSince === 339);
    ok('★★ submittedAll(총원 마감 재료)은 그대로 362', o.submittedAll === 362);
    ok('원래 신청 수 보존', o.applications && o.applications.submittedBeforeToday === 361 && o.applications.carrySince === 300);
    ok('기준 표시', o.countBasis === 'max');
    const o2 = base(); o2.linked.ordersBefore = 100; o2.linked.ordersToday = 0; o2.linked.ordersSinceCarry = 10;
    S._mergeCountBasis(o2);
    ok('주문이 더 적으면 신청 수를 쓴다(작아지지 않는다)', o2.submittedBeforeToday === 361 && o2.todaySubmitted === 1 && o2.carry.submittedSince === 300);
  }

  console.log('\n[2] 합치지 않는 경우(종전)');
  for (const [name, patch] of [
    ['공유 작업표', L => { L.sharedTab = true; }],
    ['탭 없음', L => { L.noTab = true; }],
    ['조회 실패(ok=false)', L => { L.ok = false; }],
    ['구간 수 없음(구버전 캐시)', L => { delete L.ordersBefore; }],
  ]) {
    const o = base(); patch(o.linked); S._mergeCountBasis(o);
    ok(name + ' → 합치지 않음', o.submittedBeforeToday === 361 && o.todaySubmitted === 1 && !o.countBasis);
  }
  { const o = base(); o.linked = null; S._mergeCountBasis(o); ok('연결 주문 재료 없음 → 합치지 않음', o.submittedBeforeToday === 361); }

  console.log('\n[3] 끄는 스위치 · 표 기준 게이트 observe');
  {
    const out = execFileSync(process.execPath, ['-e', `
      const S = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'campaignState.service.js'))});
      const o = { submittedBeforeToday: 361, todaySubmitted: 1, carry: null, hold: null,
        linked: { ok: true, ordersBefore: 401, ordersToday: 3, ordersSinceCarry: 0, ordersSinceHold: 0 } };
      S._mergeCountBasis(o); console.log(S.TABLE_QUOTA_MODE + ' ' + o.submittedBeforeToday);
    `], { env: { ...process.env, CAMPAIGN_TABLE_QUOTA: 'observe', FORCE_COLOR: '0' } }).toString().trim().split('\n').pop();
    ok('★ CAMPAIGN_TABLE_QUOTA=observe → 합치지 않음(361 — 하루 인원만 잘려 영구 잠기는 것 방지)', out === 'observe 361', out);
  }
  {
    const out = execFileSync(process.execPath, ['-e', `
      const S = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'campaignState.service.js'))});
      const o = { submittedBeforeToday: 361, todaySubmitted: 1, carry: null, hold: null,
        linked: { ok: true, ordersBefore: 401, ordersToday: 3, ordersSinceCarry: 0, ordersSinceHold: 0 } };
      S._mergeCountBasis(o); console.log(S.COUNT_BASIS + ' ' + o.submittedBeforeToday);
    `], { env: { ...process.env, CAMPAIGN_COUNT_BASIS: 'applications', FORCE_COLOR: '0' } }).toString().trim().split('\n').pop();
    ok('CAMPAIGN_COUNT_BASIS=applications → 종전(361)', out === 'applications 361', out);
  }

  console.log('\n[4] 실제 효과 — 업소용 간장 모양(총 750 · 일 35 · 종료일 뒤에 붙이기)');
  {
    const NOW = new Date('2026-09-27T03:00:00Z');
    const c = { id: 'soy', participation_mode: true, status: 'active', recruit_total: 750, daily_limit: 35,
      start_date: '2026-08-24', carry_strategy: 'extend', carry_mode: 'auto', skip_weekends: false, window_start: null, window_end: null };
    const raw = base(); raw.carry = null; raw.hold = null;
    const merged = base(); merged.carry = null; merged.hold = null; S._mergeCountBasis(merged);
    const pRaw = S.projectDailyQuotas(c, raw, { now: NOW, maxDays: 400 });
    const pMax = S.projectDailyQuotas(c, merged, { now: NOW, maxDays: 400 });
    ok('남은 자리: 신청 기준 389 → 큰 값 기준 349', pRaw.remaining === 389 && pMax.remaining === 349, pRaw.remaining + '→' + pMax.remaining);
    ok('★ 예상 종료일이 앞당겨진다(실제 주문을 센다)', pMax.endDate < pRaw.endDate, pRaw.endDate + '→' + pMax.endDate);
    const sum = p => p.days.reduce((a, d) => a + d.quota, 0);
    ok('앞날 합 = 남은 자리(큰 값 기준) — 총 인원 750 을 넘지 않는다', sum(pMax) <= 349 && 401 + sum(pMax) <= 750, String(sum(pMax)));
    const pc = S.pendingCarry(c, merged, '2026-09-27', { startDate: '2026-08-24', submittedSince: 401 });
    ok('이월도 남은 자리(750 − 401 − 오늘 1) 이하', pc === null || pc <= 750 - 401 - 1, String(pc));
    // 오늘 신청 게이트: 오늘 확정은 신청 기준 그대로 — 탭 공유 오늘 합산이 두 번 세는 재료가 생기지 않는다
    const st = S.computeCampaignState(c, merged, NOW, null);
    ok('★ 오늘 인원 판정의 오늘 확정 = 신청 1(합친 주문 3 이 아니다)', st.todayCount === 1, String(st.todayCount));
  }

  if (process.env.PGTEST_URL) {
    console.log('\n[5] 실제 PG — 주문을 구간별로 나눠 센다');
    const { Pool } = require('pg');
    const SCHEMA = 'cbm_' + process.pid;
    const admin = new Pool({ connectionString: process.env.PGTEST_URL });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    const pool = new Pool({ connectionString: process.env.PGTEST_URL, options: `-c search_path=${SCHEMA}` });
    try {
      await pool.query(`
        CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, participation_mode BOOLEAN, status TEXT, archived_at TIMESTAMPTZ,
          linked_sheet_id TEXT, linked_tab_name TEXT, linked_tab_gid TEXT, start_date DATE, created_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE order_submissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT, tab_gid TEXT,
          submitted_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
        INSERT INTO recruit_campaigns VALUES ('soy', TRUE, 'active', NULL, 'wt', '간장', NULL, '2026-08-24', NOW());
        INSERT INTO order_submissions (sheet_id, tab_name, submitted_at) VALUES
          ('wt','간장','2026-08-20T10:00:00+09:00'),   -- 시작 전(탭 좌표) → 앵커로 제외
          ('wt','간장','2026-08-25T10:00:00+09:00'),   -- 이월 기준선(9/1) 전 · 어제까지
          ('wt','간장','2026-09-10T10:00:00+09:00'),   -- 기준선 이후 · 어제까지
          ('wt','간장','2026-09-26T23:59:00+09:00'),   -- 어제 막바지
          ('wt','간장','2026-09-27T00:00:00+09:00'),   -- 오늘 0시 정각 → 오늘
          ('campaign:soy','campaign:soy','2026-09-27T09:00:00+09:00'),  -- 공고 경유 · 오늘
          ('wt','간장','2026-09-27T11:00:00+09:00');
        INSERT INTO order_submissions (sheet_id, tab_name, submitted_at, deleted_at) VALUES ('wt','간장','2026-09-27T12:00:00+09:00', NOW());
      `);
      S.__resetTableQuotaCacheForTest && S.__resetTableQuotaCacheForTest();
      const NOW = new Date('2026-09-27T03:00:00Z');   // KST 12:00
      const origQ = pool.query.bind(pool);
      // fetchCampaignCounts 의 다른 조회(신청·계획·발주)는 이 스키마에 표가 없으니 빈 결과로 둔다
      S.__resetCarryCacheForTest && S.__resetCarryCacheForTest();
      const db = { query: (sql, p) => {
        if (/order_submissions/.test(String(sql))) return origQ(sql, p);
        if (/FROM app_settings/.test(String(sql))) return Promise.resolve({ rows: [{ key: 'campaign_carry_start', value: '2026-09-01' }, { key: 'campaign_carry_hold_start', value: '2026-09-20' }] });
        return Promise.resolve({ rows: [] });
      } };
      const m = await S.fetchCampaignCounts(db, ['soy'], NOW);
      const o = m.get('soy'), L = o.linked;
      ok('앵커(시작일) 이후 주문 6건(시작 전 1건·삭제 1건 제외)', L.orders === 6, JSON.stringify(L));
      ok('어제까지 3 · 오늘 3(0시 정각은 오늘)', L.ordersBefore === 3 && L.ordersToday === 3, JSON.stringify(L));
      ok('★ 이월 기준선(9/1) 이후 어제까지 = 2(9/10 · 9/26) — 8/25 는 기준선 전', L.ordersSinceCarry === 2, JSON.stringify(L));
      ok('★ 보류 기준선(9/20) 이후 어제까지 = 1(9/26)', L.ordersSinceHold === 1, JSON.stringify(L));
      ok('★ 합쳐진 값: 어제까지 3 · 이월 2 · 보류 1 · 오늘은 신청 그대로 0',
        o.submittedBeforeToday === 3 && o.carry.submittedSince === 2 && o.hold.submittedSince === 1 && o.todaySubmitted === 0 && o.countBasis === 'max', JSON.stringify(o));
    } finally {
      await pool.end(); await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`); await admin.end();
    }
  } else {
    console.log('\n[5] PGTEST_URL 미설정 — 실제 PG 구간 집계 건너뜀');
  }

  console.log(`\ncountBasisMax: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
