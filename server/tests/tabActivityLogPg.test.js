/**
 * tabActivityLogPg.test.js — 작업 로그 커서 페이지네이션 (진짜 PG16)
 *
 * ★★ **스텁 pool 로는 절대 못 잡는 것**: 스텁은 SQL 을 해석하지 않아 UNION ALL·HAVING·::timestamptz
 *    캐스트가 문법으로 맞는지, 커서가 실제로 **과거를 한 건도 안 빠뜨리고** 이어 주는지 모른다.
 *    특히 "한 행이 두 시각을 내는" 주문(접수 8/20 · 취소 8/22)에서 행 단위 커서를 쓰면
 *    접수 항목이 **조용히 사라진다** — 그 회귀는 여기서만 잡힌다.
 *
 * 실행: PGTEST_URL=postgres://… node tests/tabActivityLogPg.test.js
 *      (미설정이면 건너뛴다 — 정적/스텁 가드는 reviewerOrderCancelAndTabLog.test.js 가 담당)
 */
const assert = require('assert');

const URL = process.env.PGTEST_URL || '';
if (!URL) { console.log('PGTEST_URL 없음 — 건너뜀'); process.exit(0); }
process.env.DATABASE_URL = URL;   // ★ pool 은 require 시점에 읽는다(맨 위에서 세운다)

const { Pool } = require('pg');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); } };

const DDL = `
DROP TABLE IF EXISTS order_submissions, reviewer_event_logs, review_submissions, review_inspections,
  participant_edits, campaign_plan_events, recruit_campaigns, payment_batch_items, trackb_tab_finished CASCADE;
CREATE TABLE order_submissions (id UUID DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT, sheet_row INT,
  recipient TEXT, orderer TEXT, price TEXT, submitted_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, canceled_by TEXT);
CREATE TABLE reviewer_event_logs (id BIGSERIAL, occurred_at TIMESTAMPTZ, sheet_id TEXT, tab_name TEXT,
  event_type TEXT, severity TEXT, message TEXT, reviewer_name TEXT, context JSONB);
CREATE TABLE review_submissions (id UUID DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT,
  row_index INT, reviewer_name TEXT, uploaded_at TIMESTAMPTZ);
CREATE TABLE review_inspections (id UUID DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT, row_index INT,
  reviewer_name TEXT, status TEXT, resolution TEXT, resolved_by TEXT,
  resolved_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, created_at TIMESTAMPTZ);
CREATE TABLE participant_edits (id BIGSERIAL, sheet_id TEXT, tab_name TEXT, field TEXT, kind TEXT,
  value_text TEXT, value_bool BOOLEAN, created_by TEXT, created_at TIMESTAMPTZ, reverted_at TIMESTAMPTZ, reverted_by TEXT);
CREATE TABLE recruit_campaigns (id TEXT, linked_sheet_id TEXT, linked_tab_name TEXT, linked_tab_gid TEXT);
CREATE TABLE campaign_plan_events (id UUID DEFAULT gen_random_uuid(), campaign_id TEXT, actor TEXT,
  action TEXT, detail JSONB, created_at TIMESTAMPTZ);
CREATE TABLE payment_batch_items (id UUID DEFAULT gen_random_uuid(), batch_id UUID, sheet_id TEXT, tab_name TEXT,
  status TEXT, paid_at TIMESTAMPTZ);
CREATE TABLE trackb_tab_finished (id BIGSERIAL, sheet_id TEXT, tab_name TEXT, finished_at TIMESTAMPTZ,
  finished_by TEXT, deleted_at TIMESTAMPTZ, reopened_by TEXT);
`;

/** 화면과 같은 방식으로 끝까지 긁어 온다(커서 + id 중복 제거). */
async function drain(m, opts) {
  const seen = new Set(); const all = []; let before = null; let guard = 0;
  for (;;) {
    const r = await m.tabActivityLog(Object.assign({ sheetId: 's1', tabName: 't1' }, opts, { before }));
    assert.strictEqual(r.ok, true);
    let added = 0;
    r.items.forEach(x => { if (!seen.has(x.id)) { seen.add(x.id); all.push(x); added++; } });
    if (!r.hasMore || !r.nextBefore || (!added && guard)) break;
    before = r.nextBefore;
    if (++guard > 200) throw new Error('커서가 제자리 — 무한루프');
  }
  return all;
}

(async () => {
  const pool = new Pool({ connectionString: URL });
  await pool.query(DDL);
  const D = (s) => new Date(s);
  // ★ 함정 그 자체: 접수는 8/20, 취소는 8/22 — 행 단위 커서면 접수가 사라진다.
  await pool.query(`INSERT INTO order_submissions (sheet_id,tab_name,sheet_row,recipient,price,submitted_at,deleted_at,canceled_by)
    VALUES ('s1','t1',3,'홍길동','13,900',$1,$2,'reviewer:1234')`, [D('2026-08-20T01:00:00Z'), D('2026-08-22T01:00:00Z')]);
  for (let i = 0; i < 40; i++) {
    await pool.query(`INSERT INTO order_submissions (sheet_id,tab_name,sheet_row,recipient,price,submitted_at)
      VALUES ('s1','t1',$1,$2,'1000',$3)`, [10 + i, '리뷰어' + i, D(Date.UTC(2026, 7, 21, 0, i))]);
  }
  await pool.query(`INSERT INTO reviewer_event_logs (occurred_at,sheet_id,tab_name,event_type,severity,message,reviewer_name,context)
    VALUES ($1,'s1','t1','order_canceled_by_reviewer','info','리뷰어가 취소했습니다','ㄱ','{"rowIndex":3}'),
           ($2,'s1','t1','order_lost','critical','시트에서 사라졌습니다','ㄴ',NULL)`,
    [D('2026-08-19T01:00:00Z'), D('2026-08-18T01:00:00Z')]);
  await pool.query(`INSERT INTO review_submissions (sheet_id,tab_name,row_index,reviewer_name,uploaded_at)
    VALUES ('s1','t1',3,'홍길동',$1), ('s1','t1',3,'홍길동',$2)`, [D('2026-08-23T01:00:00Z'), D('2026-08-23T02:00:00Z')]);
  await pool.query(`INSERT INTO review_inspections (sheet_id,tab_name,row_index,reviewer_name,status,resolution,resolved_by,resolved_at,created_at)
    VALUES ('s1','t1',3,'홍길동','resolved','ok','만두',$1,$1)`, [D('2026-08-23T03:00:00Z')]);
  // 편집 + 되돌리기 — 여기도 한 행 두 시각
  await pool.query(`INSERT INTO participant_edits (sheet_id,tab_name,field,kind,value_text,created_by,created_at,reverted_at,reverted_by)
    VALUES ('s1','t1','col:비고','text','메모','망고',$1,$2,'만두')`, [D('2026-08-17T01:00:00Z'), D('2026-08-24T01:00:00Z')]);
  await pool.query(`INSERT INTO recruit_campaigns (id,linked_sheet_id,linked_tab_name,linked_tab_gid) VALUES ('c1','s1','t1','777')`);
  await pool.query(`INSERT INTO campaign_plan_events (campaign_id,actor,action,detail,created_at)
    VALUES ('c1','망고','plan_save','{"set":[1,2,3]}',$1)`, [D('2026-08-16T01:00:00Z')]);
  await pool.query(`INSERT INTO payment_batch_items (batch_id,sheet_id,tab_name,status,paid_at)
    VALUES (gen_random_uuid(),'s1','t1','paid',$1)`, [D('2026-08-15T01:00:00Z')]);
  // 마감 + 복귀 — 한 행 두 시각
  await pool.query(`INSERT INTO trackb_tab_finished (sheet_id,tab_name,finished_at,finished_by,deleted_at,reopened_by)
    VALUES ('s1','t1',$1,'만두',$2,'망고')`, [D('2026-08-14T01:00:00Z'), D('2026-08-25T01:00:00Z')]);

  const m = require('../src/services/tabActivityLog.service');
  console.log('\n[PG] 작업 로그 — 커서로 처음까지');

  await t('★★ 한 묶음(60건 기본)으로도 SQL 8종이 전부 실행된다(문법·캐스트)', async () => {
    const r = await m.tabActivityLog({ sheetId: 's1', tabName: 't1', gid: '777' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.failed, [], '실패한 소스: ' + r.failed.join(','));
    assert.ok(r.items.length > 0);
  });

  const EXPECT = 1 + 1 + 40 + 2 + 1 + 1 + 2 + 1 + 1 + 2;  // 접수1+취소1+접수40+이벤트2+리뷰1+검수1+편집2+정원1+입금1+마감2
  await t('★★ 잘게 끊어 받아도 총 건수가 한 번에 받은 것과 같다(과거 유실 0)', async () => {
    const small = await drain(m, { gid: '777', limit: 10 });
    assert.strictEqual(small.length, EXPECT, '끊어 받기 ' + small.length + ' ≠ ' + EXPECT);
    const big = await m.tabActivityLog({ sheetId: 's1', tabName: 't1', gid: '777', limit: 300 });
    assert.strictEqual(big.items.length, EXPECT, '한 번에 ' + big.items.length);
    assert.deepStrictEqual(small.map(x => x.id), big.items.map(x => x.id), '순서·구성이 같아야 한다');
  });

  await t('★★★ 접수 8/20 · 취소 8/22 인 한 행에서 두 항목이 모두 나온다(행 단위 커서 회귀 차단)', async () => {
    const all = await drain(m, { gid: '777', limit: 3 });   // 커서가 두 시각 사이에 반드시 놓이는 크기
    const mine = all.filter(x => /홍길동/.test(x.message));
    assert.ok(mine.some(x => x.kind === 'order'), '접수 항목이 사라졌다');
    assert.ok(mine.some(x => x.kind === 'cancel'), '취소 항목이 사라졌다');
  });

  await t('★★ 편집·되돌리기 / 마감·복귀도 두 항목이 모두 나온다', async () => {
    const all = await drain(m, { gid: '777', limit: 3 });
    assert.ok(all.some(x => /표 편집 —/.test(x.message)), '편집');
    assert.ok(all.some(x => /표 편집 되돌리기/.test(x.message)), '되돌리기');
    assert.ok(all.some(x => x.message === '작업 마감'), '마감');
    assert.ok(all.some(x => x.message === '마감 복귀'), '복귀');
  });

  await t('★★ 유형을 골라도 그 유형의 과거까지 전부 나온다(SQL 유형 조건)', async () => {
    const cancels = await drain(m, { gid: '777', kind: 'cancel', limit: 2 });
    assert.strictEqual(cancels.length, 2, '취소 2건(주문취소 1 + 리뷰어 이벤트 1) — 받은 건수 ' + cancels.length);
    cancels.forEach(x => assert.strictEqual(x.kind, 'cancel'));
    const orders = await drain(m, { gid: '777', kind: 'order', limit: 7 });
    assert.strictEqual(orders.length, 41, '접수 41건 — 받은 건수 ' + orders.length);
  });

  await t('★ 시간 내림차순이 페이지를 넘어도 유지된다', async () => {
    const all = await drain(m, { gid: '777', limit: 4 });
    for (let i = 1; i < all.length; i++) {
      assert.ok(new Date(all[i - 1].at) >= new Date(all[i].at), i + '번째에서 순서가 깨졌다');
    }
  });

  await t('★ 빈 gid 는 절을 켜지 않는다(정원 이력이 남의 공고로 새지 않게)', async () => {
    await pool.query(`INSERT INTO recruit_campaigns (id,linked_sheet_id,linked_tab_name,linked_tab_gid)
      VALUES ('c2','s1','다른탭',NULL)`);
    await pool.query(`INSERT INTO campaign_plan_events (campaign_id,actor,action,detail,created_at)
      VALUES ('c2','X','round_add','{}',$1)`, [D('2026-08-13T01:00:00Z')]);
    const r = await m.tabActivityLog({ sheetId: 's1', tabName: 't1', gid: '', kind: 'quota', limit: 50 });
    assert.strictEqual(r.items.length, 1, '연결 안 된 공고의 이력까지 딸려왔다(' + r.items.length + ')');
  });

  await pool.end();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
