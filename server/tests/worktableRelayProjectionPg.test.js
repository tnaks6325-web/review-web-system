'use strict';
/**
 * 작업표 날짜 맞추기(relayWorktableToProjection)를 **실제 PostgreSQL** 에서 돌린다 (결정 182).
 * 스텁 테스트(worktableRelayProjection.test.js)는 SQL 을 해석하지 않으므로, 여기서 UPDATE 문 자체
 * (uuid·text 캐스트, jsonb 병합, VALUES 조인)가 실제로 먹는지와 결과 줄 상태를 확인한다.
 * 실행: PGTEST_URL=postgres://... node tests/worktableRelayProjectionPg.test.js
 */
const assert = require('assert');

if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 작업표 날짜 맞추기 실제 PG 검증 건너뜀');
  process.exit(0);
}

const { Client } = require('pg');
const svc = require('../src/services/sheetlessDailyPlan.service');

(async () => {
  const client = new Client({ connectionString: process.env.PGTEST_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE campaign_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL,
        seq INTEGER NOT NULL, reviewer_name TEXT, recipient_name TEXT, phone8 TEXT,
        order_submission_id UUID, row_json JSONB, start_date TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT
      );
      INSERT INTO campaign_participants (sheet_id, tab_name, seq, reviewer_name, order_submission_id, row_json) VALUES
        ('wt','T',1,'참여자', gen_random_uuid(), '{"번호":"1","구매일자":"9 / 28 (월)","옵션":"A"}'),
        ('wt','T',2,NULL,NULL,'{"번호":"2","구매일자":"9 / 28 (월)","옵션":"A"}'),
        ('wt','T',3,NULL,NULL,'{"번호":"3","구매일자":"9 / 28 (월)","옵션":"A"}'),
        ('wt','T',4,'  ',NULL,'{"번호":"4","구매일자":"","옵션":"B"}'),
        ('wt','T',5,NULL,NULL,'{"번호":"5","구매일자":"10 / 9 (금)","옵션":"B"}'),
        ('wt','다른탭',1,NULL,NULL,'{"번호":"1","구매일자":"9 / 28 (월)"}');
      INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, active) VALUES
        ('wt','T',6,'{"번호":"6","구매일자":"9 / 28 (월)"}', FALSE);
    `);

    // 9/28 은 2명(채워진 1 + 빈 1), 9/29 는 2명 필요. 10/9 는 필요 없음.
    const r = await svc.relayWorktableToProjection({ client, sheetId: 'wt', tabName: 'T', today: '2026-09-26', by: 'pg-test',
      days: [{ date: '2026-09-28', quota: 2 }, { date: '2026-09-29', quota: 2 }] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));

    const { rows } = await client.query(
      `SELECT seq, row_json->>'구매일자' AS d, row_json->>'옵션' AS opt, start_date, updated_by, active
         FROM campaign_participants WHERE sheet_id='wt' AND tab_name='T' ORDER BY seq`);
    const by = Object.fromEntries(rows.map(x => [x.seq, x]));
    assert.strictEqual(by[1].d, '9 / 28 (월)', '채워진 줄은 그대로');
    assert.strictEqual(by[1].updated_by, null, '채워진 줄은 손대지 않는다');
    assert.strictEqual(by[2].d, '9 / 28 (월)', '맞는 날짜의 빈 줄 1개는 그대로');
    assert.strictEqual(by[4].d, '9 / 29 (화)', '날짜 없는 빈 줄(공백 이름 = 빈 줄)이 먼저 9/29 로');
    assert.strictEqual(by[4].opt, 'B', '★ 날짜 칸만 바꾸고 다른 칸(옵션)은 보존(jsonb 병합)');
    assert.strictEqual(by[4].start_date, '9 / 29 (화)', 'start_date 도 같은 값');
    assert.strictEqual(by[4].updated_by, 'pg-test');
    // 9/29 두 번째 자리 = 남은 빈 줄 중 9/28 여분(seq 3) 또는 10/9(seq 5) — 앞날(10/9)보다 9/28 여분이 먼저가 아니라,
    // 순서는 "날짜 없음 → 지난 날 → 앞날(번호 순)" 이므로 seq 3(9/28, 앞날) 이 seq 5 보다 먼저다.
    assert.strictEqual(by[3].d, '9 / 29 (화)', '남는 9/28 빈 줄이 9/29 로');
    assert.strictEqual(by[5].d, '', '어디에도 필요 없는 10/9 빈 줄은 날짜를 비운다');
    assert.strictEqual(by[6].d, '9 / 28 (월)', '비활성 줄은 대상이 아니다');
    assert.deepStrictEqual({ moved: r.moved, cleared: r.cleared, shortage: r.shortage }, { moved: 2, cleared: 1, shortage: 0 });
    const { rows: other } = await client.query(`SELECT row_json->>'구매일자' AS d FROM campaign_participants WHERE tab_name='다른탭'`);
    assert.strictEqual(other[0].d, '9 / 28 (월)', '다른 탭은 건드리지 않는다');
    const { rows: cnt } = await client.query(`SELECT COUNT(*)::int AS n FROM campaign_participants WHERE sheet_id='wt'`);
    assert.strictEqual(cnt[0].n, 7, '★★ 줄 수는 그대로(새 줄 0)');

    // 한 번 더 돌리면 바뀌는 것이 없다(멱등)
    const again = await svc.relayWorktableToProjection({ client, sheetId: 'wt', tabName: 'T', today: '2026-09-26', by: 'pg-test2',
      days: [{ date: '2026-09-28', quota: 2 }, { date: '2026-09-29', quota: 2 }] });
    assert.deepStrictEqual({ moved: again.moved, cleared: again.cleared }, { moved: 0, cleared: 0 }, '두 번째 실행은 변경 0(멱등)');

    console.log('worktableRelayProjectionPg: passed');
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) {}
    await client.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
