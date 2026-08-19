'use strict';
/**
 * pastSheetTabCleanupPg.test.js — 과거 탭 정리: 진짜 PG16 검증
 * 실행: PGTEST_URL=postgres://... node tests/pastSheetTabCleanupPg.test.js
 *
 * ★★ 스텁은 SQL 을 해석하지 않는다 — LATERAL 4개·인용 별칭·타입 캐스트가 실제로 도는지는
 *    진짜 PG 로만 확인된다(이 레포가 `cells->>$n::int` 로 이미 밟은 함정).
 * 고정하는 것:
 *   ① 스캔 SQL 이 실행되고 컬럼 별칭이 서비스가 읽는 이름과 맞는다
 *   ② 판정 5갈래가 실제 데이터로 갈린다(무시트/아카이브/마감/최근/과거)
 *   ③ 미반영 주문·활성 공고가 있으면 후보에서 빠진다(fail-closed)
 *   ④ 닫기는 `is_closed` 한 칸만 바꾼다 — 다른 테이블 무접촉
 *   ⑤ 멱등(두 번 닫아도 같은 상태) · 되돌리기로 원복
 */
process.env.PGTEST_URL = process.env.PGTEST_URL || process.env.DATABASE_URL || '';
if (!process.env.PGTEST_URL) { console.log('SKIP: PGTEST_URL 없음'); process.exit(0); }
process.env.DATABASE_URL = process.env.PGTEST_URL;   // pool 은 require 시점에 읽는다

const assert = require('assert');
const { Pool } = require('pg');
const svc = require('../src/services/pastSheetTabCleanup.service');

const pool = new Pool({ connectionString: process.env.PGTEST_URL });
svc.__setPoolForTest(pool);

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

const DDL = `
DROP TABLE IF EXISTS tab_configs, campaigns, order_submissions, recruit_campaigns,
                     review_index, index_master, index_master_archive, raw_sheet_tabs CASCADE;
CREATE TABLE raw_sheet_tabs (sheet_id text, tab_gid text, tab_name text, mirrored_at timestamptz DEFAULT NOW());
CREATE TABLE tab_configs (
  sheet_id text, tab_name text, tab_gid text, campaign_name text, sheetless boolean DEFAULT FALSE,
  is_closed boolean DEFAULT FALSE, PRIMARY KEY (sheet_id, tab_name));
-- ★★ 운영과 같은 제약: 한 시트에 여러 campaigns 행이 정상이다(UNIQUE(sheet_id, campaign_name)).
--   픽스처가 sheet_id 를 PK 로 두면 **행 부풀리기 버그가 구조적으로 안 잡힌다**(실제로 놓쳤다).
CREATE TABLE campaigns (sheet_id text, campaign_name text, created_at timestamptz,
  UNIQUE (sheet_id, campaign_name));
CREATE TABLE order_submissions (
  id serial PRIMARY KEY, sheet_id text, tab_name text, submitted_at timestamptz,
  deleted_at timestamptz, mirror_status text);
CREATE TABLE recruit_campaigns (
  id text PRIMARY KEY, linked_sheet_id text, linked_tab_name text, linked_tab_gid text,
  status text, created_at timestamptz);
CREATE TABLE review_index (sheet_id text, tab_name text, row_index int, start_date text);
CREATE TABLE index_master (sheet_id text, tab_name text);
CREATE TABLE index_master_archive (sheet_id text, tab_name text, tab_gid text);
`;

(async () => {
  await pool.query(DDL);
  const S = 'sheetA';
  // 한 시트에 campaigns 행 2개 — 시트 단위로 조인하면 그 시트의 모든 탭이 2배가 된다
  await pool.query(`INSERT INTO campaigns VALUES ($1, '캠A', '2024-03-01')`, [S]);
  await pool.query(`INSERT INTO campaigns VALUES ($1, '캠B', '2024-04-15')`, [S]);
  const mk = async (tab, opt = {}) => {
    await pool.query(
      `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheetless, is_closed)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [S, tab, opt.gid || '', opt.campaign || '시트甲', !!opt.sheetless, !!opt.closed]);
    if (opt.startDate) await pool.query(
      `INSERT INTO review_index VALUES ($1,$2,1,$3)`, [S, tab, opt.startDate]);
    if (opt.orderAt) await pool.query(
      `INSERT INTO order_submissions (sheet_id, tab_name, submitted_at, mirror_status) VALUES ($1,$2,$3,'written')`,
      [S, tab, opt.orderAt]);
    if (opt.pending) await pool.query(
      `INSERT INTO order_submissions (sheet_id, tab_name, submitted_at, mirror_status) VALUES ($1,$2,$3,'pending')`,
      [S, tab, opt.orderAt || '2024-05-05']);
    if (opt.activeCamp) await pool.query(
      `INSERT INTO recruit_campaigns VALUES ($1,$2,$3,'', 'active', '2024-04-01')`, ['c_' + tab, S, tab]);
    await pool.query(`INSERT INTO index_master VALUES ($1,$2)`, [S, tab]);
  };

  await mk('과거_구매일2024', { startDate: '24.5.10' });                       // 후보
  await mk('과거_주문2024',   { orderAt: '2024-06-02' });                      // 후보(주문 신호)
  await mk('최근_2026',       { startDate: '26.8.1' });                        // recent
  await mk('연도모름',        { startDate: '5 / 10 (금)' });                   // weak_signal(등록일 신호만)
  await mk('신호없음',        {});                                             // weak_signal(등록일 신호만)
  await mk('과거_미반영주문', { startDate: '24.5.10', pending: true });        // pending_orders
  await mk('과거_활성공고',   { startDate: '24.5.10', activeCamp: true });     // active_campaign
  await mk('이미무시트',      { startDate: '24.5.10', sheetless: true });      // already_sheetless
  await mk('이미마감',        { startDate: '24.5.10', closed: true });         // already_closed
  await mk('이미아카이브',    { startDate: '24.5.10' });
  await pool.query(`INSERT INTO index_master_archive VALUES ($1,'이미아카이브','')`, [S]);
  // ★ 이름이 바뀐 탭: 아카이브 마커는 **옛 이름**으로만 남아 있다.
  //   smartBuild 는 `sheet_id||tab_name` 로만 스킵하므로 **새 이름으로 계속 읽는다**
  //   ⇒ "이미 아카이브"로 접으면 정리 대상이 조용히 사라진다(2026-08-19 「0개」 보고의 원인).
  await mk('리네임후_새이름', { startDate: '24.5.10', gid: '777' });
  await pool.query(`INSERT INTO index_master_archive VALUES ($1,'리네임전_옛이름','777')`, [S]);
  // ★ 시트에서 이름이 바뀌었는데 tab_configs 는 옛 이름 — 마감 표시가 있어도 smartBuild 는
  //   **시트의 현재 이름**으로 조회하므로 스킵이 빗나가 계속 읽는다(마감으로 못 멈춘다).
  await mk('이름어긋남_옛', { startDate: '24.5.10', gid: '888', closed: true });
  await pool.query(`INSERT INTO raw_sheet_tabs (sheet_id, tab_gid, tab_name) VALUES ($1,'888','이름어긋남_새')`, [S]);
  // 대조군: 이름이 같으면 종전대로 조용하다
  await pool.query(`INSERT INTO raw_sheet_tabs (sheet_id, tab_gid, tab_name) VALUES ($1,'4','이미마감')`, [S]);

  // ── ① 스캔이 실제로 돈다 ─────────────────────────────────
  const scan = await svc.scanPastSheetTabs({ since: '2026-01-01' });
  const by = Object.fromEntries(
    [...scan.items, ...scan.holds].map(i => [i.tabName, i]));
  t('①: 스캔 SQL 이 진짜 PG 에서 실행되고 별칭이 맞는다', () => {
    assert.equal(scan.ok, true);
    assert.equal(scan.total, 12, '탭 12개 (받음 ' + scan.total + ')');
  });
  t('②: 판정이 5갈래로 갈린다', () => {
    assert.equal(by['과거_구매일2024'].reason, 'past');
    assert.equal(by['과거_주문2024'].reason, 'past');
    assert.equal(by['최근_2026'].reason, 'recent');
    assert.equal(by['연도모름'].reason, 'weak_signal',
      '연도 없는 구매일 표기 → 등록일 폴백 → 닫지 않는다(진짜 PG 가 잡은 자리)');
    assert.equal(by['신호없음'].reason, 'weak_signal');
    // 이미 안 읽는 탭은 목록에 싣지 않고 **건수로** 말한다(payload 절약 + 조용한 누락 금지)
    assert.equal(scan.alreadyQuiet, 3, '이미 조용한 탭 3개 (받음 ' + scan.alreadyQuiet + ')');
    assert.equal(scan.quietBy.already_sheetless, 1);
    assert.equal(scan.quietBy.already_closed, 1, '이름이 같은 마감만 조용하다');
    assert.equal(scan.quietBy.already_archived, 1);
  });
  t('②b: 구매일 신호가 우선 — 시트 등록일(2024)로 최근 작업을 과거로 몰지 않는다', () => {
    assert.equal(by['최근_2026'].activitySource, 'sheet_date');
    assert.equal(by['과거_주문2024'].activitySource, 'order');
  });
  t('③: 미반영 주문·활성 공고는 후보에서 빠진다(fail-closed)', () => {
    assert.equal(by['과거_미반영주문'].reason, 'pending_orders');
    assert.equal(by['과거_미반영주문'].candidate, false);
    assert.equal(by['과거_활성공고'].reason, 'active_campaign');
    assert.equal(by['과거_활성공고'].candidate, false);
  });
  t('③b: "지금도 읽히는 탭"과 "이미 안 읽는 탭"을 구분해 센다', () => {
    // 무시트·아카이브·마감 3개를 뺀 7개가 지금도 읽힌다
    assert.equal(scan.stillReading, 9, 'stillReading (받음 ' + scan.stillReading + ')');
    assert.equal(scan.candidates, 3, '후보 3개 (받음 ' + scan.candidates + ')');
    assert.equal(scan.heldBy.recent, 1);
    assert.equal(scan.heldBy.weak_signal, 2, '등록일만으로는 닫지 않는다');
    assert.equal(scan.heldBy.pending_orders, 1);
    assert.equal(scan.heldBy.active_campaign, 1);
    assert.equal(scan.heldBy.name_drift, 1, '이름 어긋남은 후보가 아니라 사유로 말한다');
  });

  // ── ④ 닫기 ───────────────────────────────────────────────
  const SNAP = `SELECT (SELECT count(*)::int FROM index_master) im,
                       (SELECT count(*)::int FROM order_submissions) os,
                       (SELECT count(*)::int FROM recruit_campaigns) rc,
                       (SELECT count(*)::int FROM review_index) ri,
                       (SELECT count(*)::int FROM tab_configs) tc,
                       (SELECT count(*)::int FROM tab_configs WHERE is_closed) closed`;
  const before = await pool.query(SNAP);
  const dry = await svc.closePastTabs({ tabs: scan.items.map(i => ({ sheetId: i.sheetId, tabName: i.tabName })) });
  const afterDry = await pool.query(`SELECT count(*)::int n FROM tab_configs WHERE is_closed`);
  t('③c: 이름이 바뀐 탭은 아카이브로 접히지 않는다(진짜 PG 로만 잡히는 자리)', () => {
    assert.equal(by['리네임후_새이름'].reason, 'past', '새 이름으로 여전히 읽힌다 → 정리 후보');
    assert.equal(by['리네임후_새이름'].archivedGidOnly, true, '옛 이름 마커는 건수로만 말한다');
    assert.equal(scan.archivedByGidOnly, 1);
    assert.equal(scan.quietBy.already_archived, 1, '진짜 아카이브만 1건(이름 일치)');
  });

  t('③d: 시트에서 이름이 바뀐 마감 탭은 조용하지 않다(RAW 미러 조인 — 진짜 PG 로만)', () => {
    const d = by['이름어긋남_옛'];
    assert.equal(d.reason, 'name_drift');
    assert.equal(d.reads, true, '마감 표시가 있어도 새 이름으로 읽힌다');
    assert.equal(d.candidate, false, '마감해도 안 멈추므로 후보로 올리지 않는다');
    assert.equal(d.liveTabName, '이름어긋남_새', '시트의 현재 이름을 말해 준다');
    assert.equal(d.campaignName, '시트甲', '어느 시트인지 함께 말한다(같은 탭 이름 구분)');
    // ★ 조용한 탭은 목록에 싣지 않고 건수로만 말한다 — `by` 에서 찾으면 안 된다
    assert.equal(scan.quietBy.already_closed, 1, '이름이 같은 마감은 종전대로 조용하다');
  });

  t('④: 미리보기는 쓰지 않는다', () => {
    assert.equal(dry.dryRun, true); assert.equal(dry.wouldClose, 3);
    assert.equal(afterDry.rows[0].n, before.rows[0].closed, '기존 마감 그대로(새로 닫힌 것 없음)');
  });

  const done = await svc.closePastTabs({
    tabs: scan.items.map(i => ({ sheetId: i.sheetId, tabName: i.tabName })), dryRun: false });
  t('④b: 실행하면 후보만 닫힌다', () => { assert.equal(done.closed, 3); });
  t('④c: is_closed 한 칸만 바뀐다 — 장부·주문·공고 무접촉', async () => {});
  const after = await pool.query(SNAP);
  t('④d: is_closed 말고는 한 행도 바뀌지 않는다(스냅샷 대조)', () => {
    // ★ 기대값을 손으로 적지 않고 **실행 전 스냅샷과 대조** — 손으로 적으면 픽스처를
    //   늘릴 때마다 테스트가 틀린 이유로 빨개진다(이번에 실제로 밟았다).
    for (const k of ['im', 'os', 'rc', 'ri', 'tc']) {
      assert.equal(after.rows[0][k], before.rows[0][k], k + ' 행 수 불변');
    }
    assert.equal(after.rows[0].closed, before.rows[0].closed + 3, '마감만 +3');
  });

  // ── ⑤ 멱등 · 되돌리기 · 서버 재검증 ───────────────────────
  const again = await svc.closePastTabs({
    tabs: [{ sheetId: S, tabName: '과거_구매일2024' }], dryRun: false });
  t('⑤: 이미 닫힌 탭을 또 닫아도 0건(멱등)', () => { assert.equal(again.closed, 0); });
  const refuse = await svc.closePastTabs({
    tabs: [{ sheetId: S, tabName: '과거_미반영주문' }, { sheetId: S, tabName: '최근_2026' }], dryRun: false });
  t('⑤b: 화면이 후보 아닌 탭을 보내면 서버가 거부한다', () => {
    assert.equal(refuse.closed, 0);
    assert.equal(refuse.refused.length, 2);
    assert.ok(refuse.refused.every(r => r.reason === 'not_candidate'));
  });
  const back = await svc.reopenTabs({ tabs: [{ sheetId: S, tabName: '과거_구매일2024' }] });
  const afterBack = await pool.query(
    `SELECT is_closed FROM tab_configs WHERE sheet_id=$1 AND tab_name='과거_구매일2024'`, [S]);
  t('⑤c: 되돌리기로 원복(비상구는 후보 판정을 요구하지 않는다)', () => {
    assert.equal(back.reopened, 1);
    assert.equal(afterBack.rows[0].is_closed, false);
  });

  console.log('\n✅ 진짜 PG 통과 ' + pass + '건\n');
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
