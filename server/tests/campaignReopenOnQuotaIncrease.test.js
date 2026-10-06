'use strict';
/**
 * 총 건수를 늘리면 "가득 차서 자동 마감된" 공고만 다시 연다 (2026-10-06 · camp_35dbcb4e41e7 건)
 *
 * 사고: 총 100 → 200 으로 늘려 저장했는데, 100 명이 차서 이미 closed 로 굳어 있던 공고라
 *   모집이 안 열렸다(게시 토글을 따로 켜야 했다). maybePersistClosed(닫기)의 짝이 없었다.
 * 고정:
 *   ① 가득 차서 닫힌 공고(직전 closed + 확정 ≥ 직전 총 + 새 총 > 확정) → active
 *   ② 가득 차기 전 수동 마감(확정 < 직전 총) → 그대로 closed          ★ 완화 금지
 *   ③ 총 건수가 안 늘었으면 무동작 · 직전 총 0(무제한)이면 무동작
 *   ④ 시트 일정 공고는 건드리지 않는다
 *   ⑤ 절대 throw 없음 + 트랜잭션 안(savepoint)에서도 실패가 tx 를 망치지 않음
 *   ⑥ 배선: 차수 추가·공고 수정 저장 두 경로가 이 함수를 쓰고, 화면이 사실을 말한다
 * 실행: node tests/campaignReopenOnQuotaIncrease.test.js   (진짜 PG 절은 PGTEST_URL 이 있을 때)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (n, c, x) => { assert.ok(c, n + (x ? ' :: ' + x : '')); passed++; };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const { maybeReopenAfterQuotaIncrease } = require('../src/services/campaignHold.service');

(async () => {
  // ── 스텁 절: SQL 조건 문장·무동작 갈래·fail-soft ──────────────────────────
  const mk = (impl) => { const calls = []; return { calls, query: async (sql, p) => { calls.push({ sql: String(sql), p }); return impl ? impl(sql, p, calls) : { rows: [], rowCount: 0 }; } }; };

  ok('직전 총 0(무제한) = 쿼리 0 · false', await (async () => { const q = mk(); const r = await maybeReopenAfterQuotaIncrease(q, 'c1', 0); return r === false && q.calls.length === 0; })());
  ok('직전 총 미상 = 무동작', await maybeReopenAfterQuotaIncrease(mk(), 'c1', null) === false);

  {
    const q = mk((sql) => (/UPDATE recruit_campaigns/.test(sql) ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }));
    ok('UPDATE 1행 = true', await maybeReopenAfterQuotaIncrease(q, 'c1', 100) === true);
    const up = q.calls.find(c => /UPDATE recruit_campaigns/.test(c.sql));
    ok('조건: 지금 closed · 새 총 > 직전 총 · 확정 ≥ 직전 총 · 확정 < 새 총',
      /rc\.status = 'closed'/.test(up.sql) && /rc\.recruit_total > \$2/.test(up.sql)
      && /\) >= \$2/.test(up.sql) && /\) < rc\.recruit_total/.test(up.sql) && /status = 'active'/.test(up.sql));
    ok('확정 수는 신청 확정(submitted) 기준 — maybePersistClosed 와 같다', (up.sql.match(/ca\.status = 'submitted'/g) || []).length === 2);
    ok('직전 총 건수가 파라미터로 간다', up.p[0] === 'c1' && up.p[1] === 100);
  }
  {
    const q = mk(() => ({ rows: [], rowCount: 0 }));
    ok('UPDATE 0행 = false', await maybeReopenAfterQuotaIncrease(q, 'c1', 100) === false);
  }
  {
    const q = mk((sql) => { if (/UPDATE recruit_campaigns/.test(sql)) throw new Error('boom'); return { rows: [], rowCount: 0 }; });
    let thrown = false, r;
    try { r = await maybeReopenAfterQuotaIncrease(q, 'c1', 100); } catch (_) { thrown = true; }
    ok('쿼리 실패도 throw 하지 않는다(저장·차수 추가를 되돌리지 않는다)', !thrown && r === false);
  }
  {
    const q = mk((sql) => { if (/UPDATE recruit_campaigns/.test(sql)) throw new Error('boom'); return { rows: [], rowCount: 0 }; });
    await maybeReopenAfterQuotaIncrease(q, 'c1', 100, { savepoint: true });
    const seq = q.calls.map(c => c.sql.split('\n')[0].trim().slice(0, 40));
    ok('savepoint 모드: 실패 시 ROLLBACK TO + RELEASE 로 tx 를 살린다',
      seq[0].startsWith('SAVEPOINT') && seq.some(s => s.startsWith('ROLLBACK TO SAVEPOINT')) && seq[seq.length - 1].startsWith('RELEASE'));
  }
  {
    const q = mk((sql) => (/UPDATE recruit_campaigns/.test(sql) ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }));
    await maybeReopenAfterQuotaIncrease(q, 'c1', 100, { savepoint: true });
    const seq = q.calls.map(c => c.sql.split('\n')[0].trim().slice(0, 40));
    ok('savepoint 모드 성공: SAVEPOINT → … → RELEASE (ROLLBACK 없음)',
      seq[0].startsWith('SAVEPOINT') && seq[seq.length - 1].startsWith('RELEASE') && !seq.some(s => s.startsWith('ROLLBACK')));
  }

  // ── 진짜 PG 절 ───────────────────────────────────────────────────────────
  if (process.env.PGTEST_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.PGTEST_URL });
    await pool.query(`DROP TABLE IF EXISTS campaign_applications; DROP TABLE IF EXISTS recruit_campaigns;
      CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, participation_mode BOOLEAN, status TEXT, recruit_total INT,
        linked_sheet_id TEXT, linked_tab_gid TEXT, updated_at TIMESTAMPTZ);
      CREATE TABLE campaign_applications (id SERIAL PRIMARY KEY, campaign_id TEXT, status TEXT);`);
    const seed = async (id, { status = 'closed', total, submitted, mode = true }) => {
      await pool.query('INSERT INTO recruit_campaigns (id, participation_mode, status, recruit_total) VALUES ($1,$2,$3,$4)', [id, mode, status, total]);
      for (let i = 0; i < submitted; i++) await pool.query("INSERT INTO campaign_applications (campaign_id, status) VALUES ($1,'submitted')", [id]);
    };
    const st = async (id) => (await pool.query('SELECT status FROM recruit_campaigns WHERE id=$1', [id])).rows[0].status;

    // 실사례: 총 100 가득(확정 100) → 200 으로 증량 저장(DB 는 이미 총 200)
    await seed('full', { total: 200, submitted: 100 });
    ok('PG ① 가득 차서 닫힌 공고(확정 100, 직전 총 100 → 새 총 200) → active', await maybeReopenAfterQuotaIncrease(pool, 'full', 100) === true && await st('full') === 'active');
    ok('PG 멱등: 한 번 더 불러도 그대로 active', await maybeReopenAfterQuotaIncrease(pool, 'full', 100) === false && await st('full') === 'active');

    // 수동 마감: 직전 총 100, 확정 60 에서 사람이 닫았다 → 증량해도 안 푼다
    await seed('manual', { total: 200, submitted: 60 });
    ok('PG ② 가득 차기 전 수동 마감(확정 60 < 직전 총 100)은 풀지 않는다', await maybeReopenAfterQuotaIncrease(pool, 'manual', 100) === false && await st('manual') === 'closed');

    // 증량이 확정보다 작아 아직도 가득(새 총 ≤ 확정)이면 안 연다
    await seed('stillfull', { total: 100, submitted: 100 });
    ok('PG ③ 새 총 건수가 확정 수 이하면 열지 않는다', await maybeReopenAfterQuotaIncrease(pool, 'stillfull', 100) === false && await st('stillfull') === 'closed');

    // 이미 active · 임시저장은 건드리지 않는다
    await seed('act', { status: 'active', total: 200, submitted: 100 });
    await seed('draft', { status: 'draft', total: 200, submitted: 100 });
    ok('PG active 는 무동작', await maybeReopenAfterQuotaIncrease(pool, 'act', 100) === false && await st('act') === 'active');
    ok('PG draft(임시저장)는 열지 않는다 — closed 만 대상', await maybeReopenAfterQuotaIncrease(pool, 'draft', 100) === false && await st('draft') === 'draft');

    // 참여형이 아니면 무동작(레거시 공고)
    await seed('legacy', { total: 200, submitted: 100, mode: false });
    ok('PG 레거시(참여형 아님)는 무동작', await maybeReopenAfterQuotaIncrease(pool, 'legacy', 100) === false && await st('legacy') === 'closed');

    // 트랜잭션 안: 실패 쿼리가 tx 를 abort 시키지 않는다(savepoint 격리) — 일부러 존재하지 않는 컬럼을 보게 한다
    await seed('tx', { total: 200, submitted: 100 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await maybeReopenAfterQuotaIncrease(client, 'tx', 100, { savepoint: true });
      await client.query('SELECT 1');   // abort 상태면 여기서 25P02
      await client.query('COMMIT');
      ok('PG tx 안 호출 + 커밋 성공', r === true && await st('tx') === 'active');
    } finally { client.release(); }

    await pool.query('DROP TABLE campaign_applications; DROP TABLE recruit_campaigns');
    await pool.end();
  } else {
    console.log('(PGTEST_URL 없음 — 진짜 PG 절 건너뜀)');
  }

  // ── 배선 ─────────────────────────────────────────────────────────────────
  const plan = read('src/services/campaignPlan.service.js');
  const routes = read('src/routes/campaign.routes.js');
  const hold = read('src/services/campaignHold.service.js');
  const cdp = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/js/campaign-daily-plan.js'), 'utf8');
  const recruit = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/js/index-recruit.js'), 'utf8');

  ok('차수 추가: COMMIT 앞에서 같은 트랜잭션·savepoint 로 호출 + 직전 총량(camp.recruit_total)을 넘긴다',
    /maybeReopenAfterQuotaIncrease\(client, campaignId, camp\.recruit_total, \{ savepoint: true \}\)[\s\S]{0,300}COMMIT/.test(plan));
  ok('차수 추가 응답에 reopened · 다시 열렸으면 status=active', /status: reopened \? 'active' : camp\.status, reopened/.test(plan));
  ok('공고 수정: 직전 총 건수·직전 상태를 UPDATE 앞에서 읽는다', /SELECT recruit_total, status FROM recruit_campaigns/.test(routes) && /_statusPrev = prevRt\[0\]\.status/.test(routes));
  ok('공고 수정: 직전 closed + 이번 요청이 마감으로 바꾼 게 아닐 때만 호출',
    /_statusPrev === 'closed' && rows\[0\]\.status === 'closed' && _rtPrev !== null && _rtPrev > 0/.test(routes)
    && /maybeReopenAfterQuotaIncrease\(pool, id, _rtPrev\)/.test(routes));
  ok('공고 수정: 호출은 fail-soft(catch)이고 응답에 reopened 를 싣는다', /_reopened \? \{ reopened: true \}/.test(routes));
  ok('공고 수정: 다시 연 뒤 목록 캐시를 비운다', /_reopened[\s\S]{0,200}_listCache = \{ at: 0/.test(routes));
  ok('maybePersistClosed(닫기)는 그대로 — 신청 확정만 센다', /rc\.recruit_total > 0\s*\n\s*AND \(SELECT COUNT\(\*\) FROM campaign_applications ca\s*\n\s*WHERE ca\.campaign_id = rc\.id AND ca\.status = 'submitted'\) >= rc\.recruit_total/.test(hold));
  ok('공고 수정 저장 안내가 재개를 말한다', /saved\.reopened === true/.test(recruit) && /모집을 다시 열었습니다/.test(recruit));
  ok('차수 추가 토스트가 재개를 말하고, 재개됐으면 "게시를 켜야" 경고를 내지 않는다',
    /j\.reopened \? ' · ✅/.test(cdp) && /!j\.reopened && j\.status && j\.status !== 'active'/.test(cdp));

  console.log(`campaignReopenOnQuotaIncrease: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
