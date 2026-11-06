'use strict';
// 작업오더 없이 만든 공고의 작업표(첫 주문 때 자동 생성)도 모집인원만큼 빈 줄을 미리 만든다(사용자 확정 2026-11-06 「1.A」).
// 0줄로 만들면 결정 340 신청 관문이 「빈 줄 없음」으로 보고 둘째 신청자부터 막는다(2026-11-06 사설 PG 끝까지 시험에서 실측).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

async function makeDb() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE recruit_campaigns(id text PRIMARY KEY, title text, landing_url text, channel text, work_detail jsonb,
      linked_sheet_id text, linked_tab_name text, linked_tab_gid text, workboard_id uuid, recruit_total int,
      participation_mode boolean DEFAULT true, status text DEFAULT 'active', archived_at timestamptz, updated_at timestamptz, work_kind text);
    CREATE TABLE campaigns(sheet_id text, campaign_name text, sheet_url text, UNIQUE(sheet_id, campaign_name));
    CREATE TABLE workboards(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state text DEFAULT 'active');
    CREATE TABLE tab_configs(sheet_id text, tab_name text, tab_gid text, sheet_url text, campaign_name text, display_name text,
      sheetless boolean, updated_at timestamptz, workboard_id uuid, work_kind text, UNIQUE(sheet_id, tab_name));
    CREATE TABLE campaign_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id text, tab_gid text, tab_name text, seq int,
      row_json jsonb, workboard_id uuid, source text, updated_by text, updated_at timestamptz, deleted_at timestamptz, active boolean DEFAULT true,
      reviewer_name text, recipient_name text, phone8 text, order_submission_id uuid, UNIQUE(sheet_id, tab_name, seq));
    CREATE TABLE campaign_applications(id serial, campaign_id text, status text, expires_at timestamptz, phone8 text);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY, deleted_at timestamptz, mirror_status text);
    CREATE TABLE sync_queue(id serial, type text, status text, payload jsonb);
    ${require('fs').readFileSync(require('path').join(__dirname,'../migrations/210_qna_slots.sql'),'utf8').match(/CREATE TABLE IF NOT EXISTS qna_slots \([\s\S]*?\n\);/)[0]}
  `);
  const q = (s, p) => pg.query(s, p).then(r => ({ ...r, rowCount: r.affectedRows ?? r.rows.length }));
  return { pg, pool: { query: q, connect: async () => ({ query: q, release() {} }) } };
}

function stubDeps() {
  const keep = [];
  const swap = (mod, name, fn) => { const m = require(mod); keep.push([m, name, m[name]]); m[name] = fn; };
  swap('../src/services/worktable.service', 'getTemplate', async () => ({ core: ['번호', '이름', '연락처', '결제금액', '리뷰제출', '입금'], channels: {}, workTypes: [] }));
  swap('../src/services/sheetlessOrder.service', 'reconcileCampaignWorktableLinks', async () => ({}));
  swap('../src/services/sheetlessLedger.service', 'rebuildLedgers', async () => ({ ok: true }));
  swap('../src/services/workboardConsolidation.service', 'ensureNewWorkTarget', async ({ sheetId, tabName, client }) => {
    const { rows } = await client.query('INSERT INTO workboards DEFAULT VALUES RETURNING id');
    await client.query('UPDATE tab_configs SET workboard_id=$3 WHERE sheet_id=$1 AND tab_name=$2', [sheetId, tabName, rows[0].id]);
    await client.query('UPDATE recruit_campaigns SET workboard_id=$2 WHERE linked_sheet_id=$1', [sheetId, rows[0].id]);
    return { ok: true, workboardId: rows[0].id };
  });
  return () => { for (const [m, n, f] of keep.reverse()) m[n] = f; };
}

test('campaign-only worktable is created with empty rows for the whole recruit quota, starting at row 2, so the apply gate stays open', async () => {
  const { pg, pool } = await makeDb();
  const restore = stubDeps();
  const svc = require('../src/services/campaignWorktable.service');
  svc.__setPoolForTest(pool);
  try {
    await pg.query(`INSERT INTO recruit_campaigns(id, title, landing_url, recruit_total) VALUES('c1', '가짜 직접 공고', 'https://smartstore.naver.com/x/products/1', 5)`);
    const out = await svc.ensureCampaignWorktable({ campaignId: 'c1', by: 'test' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const rows = (await pg.query('SELECT seq, workboard_id FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 ORDER BY seq', [out.sheetId, out.tabName])).rows;
    assert.deepEqual(rows.map(r => r.seq), [2, 3, 4, 5, 6], 'one empty row per recruit, below the header row');
    assert.ok(rows.every(r => r.workboard_id), 'rows belong to the new workboard');
    const room = await require('../src/services/worktableApplyRoom.service').worktableRoomForApply(pool, { sheetId: out.sheetId, tabName: out.tabName, campaignId: 'c1', phone8: '12345678' });
    assert.equal(room.applies, true);
    assert.equal(room.room, 5, 'decision-340 gate sees five free rows');
    // idempotent: second call finds the link and adds nothing
    const again = await svc.ensureCampaignWorktable({ campaignId: 'c1', by: 'test' });
    assert.equal(again.created, false);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM campaign_participants')).rows[0].n, 5);
  } finally { svc.__setPoolForTest(null); restore(); }
});

test('slot preparation failure keeps the worktable (fail-soft, old 0-row shape) so the order still has a place', async () => {
  const { pg, pool } = await makeDb();
  const restore = stubDeps();
  const quota = require('../src/services/linkedRecruitQuota.service');
  const keep = quota.syncWorktableSlotsInTx;
  quota.syncWorktableSlotsInTx = async () => { throw new Error('fake slot failure'); };
  const svc = require('../src/services/campaignWorktable.service');
  svc.__setPoolForTest(pool);
  try {
    await pg.query(`INSERT INTO recruit_campaigns(id, title, recruit_total) VALUES('c3', '가짜 준비실패', 3)`);
    const out = await svc.ensureCampaignWorktable({ campaignId: 'c3', by: 'test' });
    assert.equal(out.ok, true);
    assert.equal(out.created, true);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM tab_configs')).rows[0].n, 1);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM campaign_participants')).rows[0].n, 0);
  } finally { quota.syncWorktableSlotsInTx = keep; svc.__setPoolForTest(null); restore(); }
});

test('Q&A campaign keeps 0 rows (the date calendar decides rows)', async () => {
  const { pg, pool } = await makeDb();
  const restore = stubDeps();
  const svc = require('../src/services/campaignWorktable.service');
  svc.__setPoolForTest(pool);
  try {
    await pg.query(`INSERT INTO recruit_campaigns(id, title, recruit_total, work_kind) VALUES('c4', '가짜 큐앤에이', 4, 'qna')`);
    const out = await svc.ensureCampaignWorktable({ campaignId: 'c4', by: 'test' });
    assert.equal(out.ok, true);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM campaign_participants')).rows[0].n, 0);
  } finally { svc.__setPoolForTest(null); restore(); }
});

test('campaign without a recruit quota keeps the old shape (0 rows, orders append)', async () => {
  const { pg, pool } = await makeDb();
  const restore = stubDeps();
  const svc = require('../src/services/campaignWorktable.service');
  svc.__setPoolForTest(pool);
  try {
    await pg.query(`INSERT INTO recruit_campaigns(id, title, recruit_total) VALUES('c2', '가짜 정원없음', NULL)`);
    const out = await svc.ensureCampaignWorktable({ campaignId: 'c2', by: 'test' });
    assert.equal(out.ok, true);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM campaign_participants')).rows[0].n, 0);
  } finally { svc.__setPoolForTest(null); restore(); }
});
