'use strict';

const assert = require('assert');

if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 작업보드 빈자리 실제 PG 검증 건너뜀');
  process.exit(0);
}

const { Client } = require('pg');
const affinity = require('../src/services/workboardSlotAffinity.service');

const WB = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';

(async () => {
  const client = new Client({ connectionString: process.env.PGTEST_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE workboards (id UUID PRIMARY KEY, state TEXT NOT NULL);
      CREATE TEMP TABLE tab_configs (sheet_id TEXT, tab_name TEXT, workboard_id UUID);
      CREATE TEMP TABLE campaign_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT,
        workboard_id UUID, active BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ
      );
      INSERT INTO workboards(id,state) VALUES
        ('${WB}','active'), ('${OTHER}','active');
      INSERT INTO tab_configs(sheet_id,tab_name,workboard_id) VALUES ('wt-a','T1','${WB}');
      INSERT INTO campaign_participants(sheet_id,tab_name,workboard_id) VALUES
        ('wt-a','T1',NULL), ('wt-a','T1','${OTHER}'), ('wt-a','다른탭',NULL);
      INSERT INTO campaign_participants(sheet_id,tab_name,workboard_id,active) VALUES
        ('wt-a','T1',NULL,FALSE);
    `);

    const repaired = await affinity.bindUnassignedRowsToActiveWorkboard(client, {
      sheetId: 'wt-a', tabName: 'T1', expectedWorkboardId: WB,
    });
    assert.deepStrictEqual(repaired, { workboardId: WB, bound: 1 });

    let rows = (await client.query(
      `SELECT tab_name, workboard_id FROM campaign_participants ORDER BY tab_name, workboard_id NULLS FIRST`
    )).rows;
    assert.equal(rows.filter(r => r.tab_name === 'T1' && String(r.workboard_id) === WB).length, 1);
    assert.equal(rows.filter(r => r.tab_name === 'T1' && String(r.workboard_id) === OTHER).length, 1,
      '이미 다른 작업에 연결된 행은 덮지 않아야 한다');
    assert.equal(rows.filter(r => r.tab_name === '다른탭' && r.workboard_id === null).length, 1,
      '다른 탭의 빈자리는 건드리지 않아야 한다');
    assert.equal((await client.query(
      `SELECT COUNT(*)::int AS n FROM campaign_participants
        WHERE sheet_id='wt-a' AND tab_name='T1' AND active=FALSE AND workboard_id IS NULL`
    )).rows[0].n, 1, '사용하지 않는 행은 건드리지 않아야 한다');

    await client.query(`INSERT INTO campaign_participants(sheet_id,tab_name,workboard_id) VALUES ('wt-a','T1',NULL)`);
    const mismatch = await affinity.bindUnassignedRowsToActiveWorkboard(client, {
      sheetId: 'wt-a', tabName: 'T1', expectedWorkboardId: OTHER,
    });
    assert.deepStrictEqual(mismatch, { workboardId: null, bound: 0 });
    rows = (await client.query(
      `SELECT workboard_id FROM campaign_participants WHERE sheet_id='wt-a' AND tab_name='T1' AND workboard_id IS NULL`
    )).rows;
    assert.equal(rows.length, 2, '대상이 일치하지 않으면 새 빈자리도 그대로 남아야 한다');

    await client.query('ROLLBACK');
    console.log('workboardSlotAffinityPg: 7 checks passed');
  } finally {
    await client.end();
  }
})().catch(err => { console.error(err); process.exit(1); });
