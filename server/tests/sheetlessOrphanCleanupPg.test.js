/**
 * sheetlessOrphanCleanupPg.test.js — 무시트 잔재 정리 **진짜 PG16** 검증
 * 실행: PGTEST_URL=postgres://postgres@/t?host=/tmp/pgs&port=55444 node tests/sheetlessOrphanCleanupPg.test.js
 *
 * ★★ 왜 따로인가: 스텁 pool 은 **SQL 을 해석하지 않는다** — `NOT EXISTS` 상관 서브쿼리가
 *   정말 "그 탭만" 빼는지, `LIKE $1 || '%'`·`($2 || ' minutes')::interval` 이 실제로 도는지는
 *   진짜 PG 로만 잡힌다(063 `cells->>$n` 캐스트 누락이 무음이었던 계열).
 *
 * 고정하는 것: 잔재만 고른다 · 보호 대상 6종은 절대 안 고른다 · 실행이 그 줄만 닫는다 ·
 *   재실행이 안전(멱등) · 다른 테이블 무접촉.
 */
const assert = require('assert');
if (!process.env.PGTEST_URL) { console.log('PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀'); process.exit(0); }
process.env.DATABASE_URL = process.env.PGTEST_URL;

const { Client } = require('pg');
let passed = 0;
const ok = (n, c) => { assert(c, n); passed++; console.log('  ✓ ' + n); };

(async () => {
  const c = new Client({ connectionString: process.env.PGTEST_URL });
  await c.connect();
  await c.query(`
    DROP TABLE IF EXISTS tab_configs, campaign_participants, review_index, order_submissions,
      work_orders, recruit_campaigns, trackb_settlement_links CASCADE;
    CREATE TABLE tab_configs (sheet_id TEXT, tab_name TEXT, tab_gid TEXT, campaign_name TEXT,
      display_name TEXT, sheetless BOOLEAN DEFAULT FALSE, is_closed BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (sheet_id, tab_name));
    CREATE TABLE campaign_participants (sheet_id TEXT, tab_name TEXT, seq INT, deleted_at TIMESTAMPTZ);
    CREATE TABLE review_index (sheet_id TEXT, tab_name TEXT, reviewer_name TEXT);
    CREATE TABLE order_submissions (id SERIAL PRIMARY KEY, sheet_id TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE work_orders (id TEXT PRIMARY KEY, linked_tab_sheet_id TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, linked_sheet_id TEXT);
    CREATE TABLE trackb_settlement_links (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE index_master (sheet_id TEXT, tab_name TEXT, status TEXT DEFAULT 'active', UNIQUE (sheet_id, tab_name));
  `);
  const OLD = `NOW() - INTERVAL '3 hours'`;
  const T = '8/19)유일기획_쿠팡_암막커튼 20건';
  // 잔재 2건(닫혀야 함) + 보호 대상 7건
  await c.query(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless, updated_at) VALUES
    ('wt_orphan1', $1, TRUE, ${OLD}),
    ('wt_orphan2', $1, TRUE, ${OLD}),
    ('wt_hasrows', $1, TRUE, ${OLD}),
    ('wt_hasindex', $1, TRUE, ${OLD}),
    ('wt_hasorder', $1, TRUE, ${OLD}),
    ('wt_linked', $1, TRUE, ${OLD}),
    ('wt_campaign', $1, TRUE, ${OLD}),
    ('wt_settle', $1, TRUE, ${OLD}),
    ('wt_indexed', $1, TRUE, ${OLD}),
    ('wt_fresh', $1, TRUE, NOW()),
    ('1RealGoogleSheetId_abcdefghij', $1, TRUE, ${OLD}),
    ('wt_sheetbased', $1, FALSE, ${OLD})`, [T]);
  await c.query(`INSERT INTO campaign_participants VALUES ('wt_hasrows', $1, 2, NULL)`, [T]);
  await c.query(`INSERT INTO review_index VALUES ('wt_hasindex', $1, '홍길동')`, [T]);
  await c.query(`INSERT INTO order_submissions (sheet_id) VALUES ('wt_hasorder')`);
  await c.query(`INSERT INTO work_orders VALUES ('wo1', 'wt_linked', NULL)`);
  await c.query(`INSERT INTO recruit_campaigns VALUES ('c1', 'wt_campaign')`);
  await c.query(`INSERT INTO trackb_settlement_links (sheet_id, tab_name) VALUES ('wt_settle', $1)`, [T]);
  // 등록부에 활성 행이 있는 탭 — 닫아도 목록의 다른 경로로 계속 보이므로 후보가 아니다
  await c.query(`INSERT INTO index_master (sheet_id, tab_name) VALUES ('wt_indexed', $1)`, [T]);
  // 소프트삭제된 줄·주문은 "없는 것"이라 잔재 판정을 막지 않는다
  await c.query(`INSERT INTO campaign_participants VALUES ('wt_orphan1', $1, 2, NOW())`, [T]);
  await c.query(`INSERT INTO order_submissions (sheet_id, deleted_at) VALUES ('wt_orphan2', NOW())`);

  const svc = require('../src/services/sheetlessOrphanCleanup.service');

  console.log('\n[1] 후보 판정 — 잔재만');
  const found = await svc.findOrphanTabs({});
  const ids = found.items.map(t => t.sheetId).sort();
  ok('★ 잔재 2건만 고른다', JSON.stringify(ids) === JSON.stringify(['wt_orphan1', 'wt_orphan2']));
  ok('★ 소프트삭제된 줄·주문은 잔재 판정을 막지 않는다', ids.includes('wt_orphan1') && ids.includes('wt_orphan2'));
  ok('★ 같은 이름 형제 수를 센다(사람이 중복임을 확인할 근거)', found.items[0].siblings === 11);
  ok('★ 등록부에 활성 행이 있는 탭은 후보 아님(닫아도 목록에 남는다 = 조용한 no-op 금지)',
    !ids.includes('wt_indexed'));

  console.log('\n[2] 실행 — 그 줄만 닫힌다');
  const run = await svc.closeOrphanTabs({ dryRun: false, by: 'pgtest' });
  ok('2건 닫힘', run.closed === 2);
  const { rows: closed } = await c.query(`SELECT sheet_id FROM tab_configs WHERE is_closed = TRUE ORDER BY sheet_id`);
  ok('★ 닫힌 것은 잔재 2건뿐 — 보호 대상 10건은 그대로',
    JSON.stringify(closed.map(r => r.sheet_id)) === JSON.stringify(['wt_orphan1', 'wt_orphan2']));
  const { rows: cnt } = await c.query(`SELECT
      (SELECT COUNT(*) FROM campaign_participants) p, (SELECT COUNT(*) FROM review_index) r,
      (SELECT COUNT(*) FROM order_submissions) o, (SELECT COUNT(*) FROM tab_configs) t`);
  ok('★ 데이터는 한 줄도 지우지 않았다',
    +cnt[0].p === 2 && +cnt[0].r === 1 && +cnt[0].o === 2 && +cnt[0].t === 12);

  console.log('\n[3] 재실행 안전(멱등) · 되돌리기');
  const again = await svc.closeOrphanTabs({ dryRun: false });
  ok('★ 이미 닫힌 것은 다시 세지 않는다(후보에서 빠진다)', again.total === 0 && again.closed === 0);
  // ★ 정리는 `updated_at` 도 갱신하므로 되돌린 직후에는 **유예 시간(신선한 탭 보호)** 에 걸려
  //   후보로 안 잡힌다 — 그것까지 확인한 뒤(경합 보호가 살아 있다는 뜻) 시간을 되감아 확인한다.
  await c.query(`UPDATE tab_configs SET is_closed = FALSE WHERE sheet_id = 'wt_orphan1'`);
  ok('★ 방금 만진 탭은 유예 시간에 걸려 후보가 아니다(진행 중 접수 보호)',
    (await svc.findOrphanTabs({})).items.length === 0);
  await c.query(`UPDATE tab_configs SET updated_at = ${OLD} WHERE sheet_id = 'wt_orphan1'`);
  const back = await svc.findOrphanTabs({});
  ok('★ 되돌리면(is_closed=FALSE) 다시 목록에 보인다 — 잃는 것이 없다',
    back.items.length === 1 && back.items[0].sheetId === 'wt_orphan1');

  await c.end();
  console.log(`\n✅ sheetlessOrphanCleanupPg: ${passed} cases passed`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
