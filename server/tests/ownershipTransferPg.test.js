/**
 * 작업(소유) 이관 — **진짜 PostgreSQL** 검증 (스텁으로는 못 잡는 것만)
 *
 * 스텁 DB 는 SQL 을 해석하지 않는다. 이관의 핵심은 전부 **조건절의 실제 동작**이라 여기서만 잡힌다:
 *   1. 탭 이관 = 그 탭만 새 업체로, **나머지 탭은 옛 업체 소유 유지**(시트전체 행 무접촉)
 *   2. 시트전체 전개에서 "타 업체 탭지정" 배제 — 없으면 이관한 작업이 옛 업체 표에도 그대로 남는다
 *   3. ★★ 한 업체가 같은 시트의 **시트전체 + 탭지정을 동시에** 가질 때 개요 작업 수 **이중 계수**
 *      (DISTINCT 없으면 2로 센다 — 이관을 탭→시트 순으로 두 번 하면 즉시 도달. 개발 중 실측으로 발견)
 *   4. 시트 전체 이관이 **타 업체 탭지정 세분 소유를 보존**하는지(조용한 삭제 금지)
 *   5. 업서트 멱등 — 같은 이관 재실행이 행을 늘리지 않고 소프트삭제 행을 되살리는지
 *
 * 실행: PGTEST_URL=postgres://... node tests/ownershipTransferPg.test.js
 *   (PGTEST_URL 이 없으면 skip — 스텁 가드는 tests/ownershipTransfer.test.js)
 *
 * ★★ PGTEST_URL → DATABASE_URL 이관은 **파일 최상단에서**(pool 은 require 시점에 env 를 읽는다 — 레포 실측).
 */
if (!process.env.PGTEST_URL) {
  console.log('⏭  PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀(스텁 가드는 tests/ownershipTransfer.test.js)');
  process.exit(0);
}
process.env.DATABASE_URL = process.env.PGTEST_URL;

const assert = require('assert');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.PGTEST_URL });
const svc = require('../src/services/trackB.service');

let pass = 0;
const ta = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

const S = 'S_TRANSFER';
const WF = 'adv_wf', WC = 'adv_wc', OTHER = 'adv_x';

async function schema() {
  // ★★ 스키마는 **서비스가 실제로 조회하는 테이블**을 전부 만든다 — 여기서 SQL 사본을 검증하면
  //   서비스 쿼리를 망가뜨려도 테스트가 통과한다(변이시험이 실제로 잡아 이렇게 바꿨다).
  await pool.query(`
    DROP TABLE IF EXISTS advertiser_campaigns, advertisers, raw_sheet_tabs, campaign_participants, tab_configs,
      trackb_work_order_links, work_orders, trackb_settlement_links, trackb_tab_closeouts, trackb_tab_memos,
      trackb_advertiser_links, index_master CASCADE;
    CREATE TABLE advertisers (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      inad_pm TEXT, contact TEXT, memo TEXT, sort_order INT DEFAULT 0);
    CREATE TABLE advertiser_campaigns (id SERIAL PRIMARY KEY, advertiser_id TEXT REFERENCES advertisers(id),
      sheet_id TEXT NOT NULL, tab_gid TEXT, assigned_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ);
    CREATE UNIQUE INDEX uq_adv_camp ON advertiser_campaigns (advertiser_id, sheet_id, COALESCE(tab_gid,''));
    CREATE TABLE raw_sheet_tabs (sheet_id TEXT, spreadsheet_title TEXT, tab_gid TEXT, tab_name TEXT,
      row_count INT, mirrored_at TIMESTAMPTZ DEFAULT NOW(), is_system_tab BOOLEAN DEFAULT FALSE);
    CREATE TABLE campaign_participants (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, tab_gid TEXT,
      seq INT, active BOOLEAN DEFAULT TRUE, deleted_at TIMESTAMPTZ, is_submitted BOOLEAN DEFAULT FALSE,
      is_paid BOOLEAN DEFAULT FALSE, first_seen_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tab_configs (sheet_id TEXT, tab_name TEXT, manager TEXT, folder_url TEXT, capture_folder_url TEXT,
      capture_slots JSONB, income_type TEXT, sheetless BOOLEAN DEFAULT FALSE);
    CREATE TABLE work_orders (id SERIAL PRIMARY KEY, recruit_count INT, start_date DATE);
    CREATE TABLE trackb_work_order_links (id SERIAL PRIMARY KEY, work_order_id INT, sheet_id TEXT, tab_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ);
    CREATE TABLE trackb_settlement_links (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, sales_id TEXT,
      contract_number TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ);
    CREATE TABLE trackb_tab_closeouts (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, closed_date DATE,
      row_count INT, sub_count INT, created_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ);
    CREATE TABLE trackb_tab_memos (sheet_id TEXT, tab_name TEXT, memo TEXT);
    CREATE TABLE trackb_advertiser_links (advertiser_id TEXT, token TEXT, active BOOLEAN DEFAULT TRUE,
      login_required BOOLEAN DEFAULT FALSE, last_used_at TIMESTAMPTZ);
    CREATE TABLE index_master (id SERIAL PRIMARY KEY, status TEXT DEFAULT 'active', sheet_id TEXT, tab_gid TEXT, tab_name TEXT);
  `);
}
async function seed() {
  await pool.query(`TRUNCATE advertiser_campaigns RESTART IDENTITY; DELETE FROM advertisers; DELETE FROM raw_sheet_tabs;`);
  await pool.query(`INSERT INTO advertisers (id,name) VALUES ($1,'(주)위드프렌즈'),($2,'주식회사 위프코리아'),($3,'타업체')`, [WF, WC, OTHER]);
  await pool.query(`INSERT INTO advertiser_campaigns (advertiser_id,sheet_id,tab_gid) VALUES ($1,$2,NULL)`, [WF, S]);
  await pool.query(`INSERT INTO raw_sheet_tabs (sheet_id,spreadsheet_title,tab_gid,tab_name,row_count) VALUES
     ($1,'위드시트','100','위프 작업',31), ($1,'위드시트','200','다른 작업',10)`, [S]);
}
/** 그 업체의 소유로 전개되는 탭 이름 — ★ **서비스를 그대로 호출**한다(쿼리 사본 금지: 사본을 검증하면
 *  서비스 SQL 을 망가뜨려도 통과한다 — 변이시험이 실제로 잡았다). */
async function expand(advId) {
  const r = await svc.ownedTabsForAdvertiser({ advertiserId: advId });
  return r.rows.map(x => x.tabName).sort();
}
/** 개요 작업 수 — ★ 서비스 advertiserOverview 실행값(byAdvertiser[*].works). */
async function overviewCounts() {
  const o = await svc.advertiserOverview();
  const out = {};
  for (const [id, v] of Object.entries(o.byAdvertiser || {})) out[id] = v.works;
  return out;
}

async function run() {
  await schema();

  console.log('\n1) 탭 이관 — 그 작업만 옮기고 나머지는 옛 업체에 남는다');
  await seed();
  await ta('이관 전: 위드프렌즈가 시트 전체(2탭) 소유', async () => {
    assert.deepStrictEqual(await expand(WF), ['다른 작업', '위프 작업']);
    assert.deepStrictEqual(await expand(WC), []);
  });
  let r = await svc.transferOwnership({ sheetId: S, tabGid: '100', toAdvertiserId: WC, by: '홍길동' });
  await ta('이관 성공(scope=tab)', async () => { assert.strictEqual(r.ok, true); assert.strictEqual(r.scope, 'tab'); });
  await ta('★ 위프 작업만 위프코리아로', async () => assert.deepStrictEqual(await expand(WC), ['위프 작업']));
  await ta('★ 나머지 탭은 위드프렌즈 소유 유지', async () => assert.deepStrictEqual(await expand(WF), ['다른 작업']));
  await ta('★ 시트전체 소유 행은 해제되지 않았다(같은 범위만 해제)', async () => {
    const { rows } = await pool.query(`SELECT advertiser_id FROM advertiser_campaigns WHERE sheet_id=$1 AND tab_gid IS NULL AND deleted_at IS NULL`, [S]);
    assert.deepStrictEqual(rows.map(x => x.advertiser_id), [WF]);
  });
  await ta('나머지 탭 소유자를 응답이 고지(keptSheetOwners)', async () =>
    assert.deepStrictEqual(r.keptSheetOwners, ['(주)위드프렌즈']));

  console.log('\n2) 멱등 — 같은 이관 재실행');
  const before = (await pool.query(`SELECT COUNT(*)::int n FROM advertiser_campaigns WHERE deleted_at IS NULL`)).rows[0].n;
  await svc.transferOwnership({ sheetId: S, tabGid: '100', toAdvertiserId: WC });
  await ta('행이 늘지 않는다(업서트)', async () => {
    const after = (await pool.query(`SELECT COUNT(*)::int n FROM advertiser_campaigns WHERE deleted_at IS NULL`)).rows[0].n;
    assert.strictEqual(after, before);
  });
  await ta('되돌린 뒤 재이관 = 소프트삭제 행 재활성', async () => {
    await svc.transferOwnership({ sheetId: S, tabGid: '100', toAdvertiserId: WF });   // 되돌리기
    assert.deepStrictEqual(await expand(WC), []);
    await svc.transferOwnership({ sheetId: S, tabGid: '100', toAdvertiserId: WC });   // 다시 이관
    assert.deepStrictEqual(await expand(WC), ['위프 작업']);
  });

  console.log('\n3) ★★ 개요 작업 수 이중 계수(DISTINCT 없으면 재현)');
  // 위프코리아가 탭지정('100')을 가진 상태에서 시트 전체까지 이관받는다 = 같은 탭이 두 own 행에 매칭.
  r = await svc.transferOwnership({ sheetId: S, tabGid: null, toAdvertiserId: WC });
  await ta('시트 전체 이관 성공(scope=sheet)', async () => assert.strictEqual(r.scope, 'sheet'));
  await ta('★ 타 업체 탭지정 세분 소유 보존 신호(keptTabOverrides)', async () => {
    await pool.query(`INSERT INTO advertiser_campaigns (advertiser_id,sheet_id,tab_gid) VALUES ($1,$2,'200')
                      ON CONFLICT (advertiser_id,sheet_id,COALESCE(tab_gid,'')) DO UPDATE SET deleted_at=NULL`, [OTHER, S]);
    const r2 = await svc.transferOwnership({ sheetId: S, tabGid: null, toAdvertiserId: WC });
    assert.ok(r2.keptTabOverrides.some(k => k.tabGid === '200'), JSON.stringify(r2.keptTabOverrides));
  });
  await ta('★ 타 업체 탭지정 행이 살아 있다(조용한 삭제 없음)', async () => {
    const { rows } = await pool.query(`SELECT 1 FROM advertiser_campaigns WHERE advertiser_id=$1 AND sheet_id=$2 AND tab_gid='200' AND deleted_at IS NULL`, [OTHER, S]);
    assert.strictEqual(rows.length, 1);
  });
  // 이 시점 상태: 위프코리아 = 시트전체 + 탭지정('100') 동시 보유 / 타업체 = 탭지정('200')
  //   → DISTINCT 없으면 탭 100 이 두 own 행에 매칭돼 위프코리아 작업 수가 2로 부풀어 오른다.
  await ta('★★ 개요 작업 수 ≡ 실제 소유 탭 수(이중 계수 없음)', async () => {
    const good = await overviewCounts();
    assert.strictEqual(good[WC], 1, '위프코리아 works=' + JSON.stringify(good));
    assert.strictEqual(good[OTHER], 1, '타업체 works=' + JSON.stringify(good));
  });
  await ta('★★ 개요 숫자 ≡ 연결탭 표(두 화면이 갈리지 않는다)', async () => {
    const good = await overviewCounts();
    assert.deepStrictEqual(await expand(WC), ['위프 작업']);
    assert.strictEqual(good[WC], (await expand(WC)).length);
    assert.strictEqual(good[OTHER], (await expand(OTHER)).length);
  });

  console.log('\n4) fail-closed');
  await ta('없는 업체 = 404 · 쓰기 0', async () => {
    const n0 = (await pool.query(`SELECT COUNT(*)::int n FROM advertiser_campaigns`)).rows[0].n;
    const o = await svc.transferOwnership({ sheetId: S, tabGid: '100', toAdvertiserId: 'adv_ghost' });
    assert.strictEqual(o.code, 404);
    const n1 = (await pool.query(`SELECT COUNT(*)::int n FROM advertiser_campaigns`)).rows[0].n;
    assert.strictEqual(n1, n0);
  });
  await ta('종료(ended) 거래처로 이관 거부', async () => {
    await pool.query(`UPDATE advertisers SET status='ended' WHERE id=$1`, [OTHER]);
    const o = await svc.transferOwnership({ sheetId: S, tabGid: '100', toAdvertiserId: OTHER });
    assert.strictEqual(o.ok, false);
    assert.deepStrictEqual(await expand(WC), ['위프 작업']);   // 소유는 그대로
  });

  console.log(`\n✅ ownershipTransferPg: ${pass}개 통과 (진짜 PG16)`);
  await pool.end();
  process.exit(0);
}
run().catch(async e => { console.error('❌', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
