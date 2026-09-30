'use strict';
/**
 * 회귀가드 — **진짜 PostgreSQL** 로 유입·시간창 전파를 돌린다 (사용자 지적 2026-09-22)
 *
 * 실행: PGLITE_MODULE=$(node -e "console.log(require.resolve('@electric-sql/pglite'))") node tests/inflowSyncPg.test.js
 *
 * ★★★ **가짜 DB 로는 절대 못 잡는 것들** — 스텁은 SQL 을 해석하지 않아 컬럼 오타(42703)·
 *    타입 불일치(42804)·필수값 위반(23502)·캐스팅 실패를 전부 통과시킨다. 이 레포는 그 계열로
 *    여러 번 전면 장애를 겪었다(082 FK 타입 · 123 트리거 · cs_messages.meta 23502).
 *    전파는 `campaign_options.inflow_guide_images`(JSONB NOT NULL) 와
 *    `recruit_campaigns.window_start`(TIME) 에 쓰므로 **한 번 돌려 봐야** 안다.
 * ★ 검사: 실제 SQL 실행 · `24:00:00` 이 TIME 에 들어가는가 · 되돌리기가 진짜로 되돌리는가 ·
 *   NOT NULL 칸에 빈 값이 들어가는가.
 *
 * ★★★ **이 가드가 실제로 잡은 버그(2026-09-22)** — 시간창 UPDATE 가 운영에서 **항상 실패**하고 있었다:
 *      `SET window_start = $2 ... WHERE COALESCE(window_start::text,'') <> $2`
 *      **같은 파라미터를 SET 과 (문자열) WHERE 에 재사용하면** PostgreSQL 이 그 파라미터를
 *      **text 로 확정**하고, text → time 암묵 변환이 없어 `column ... is of type time but
 *      expression is of type text` 로 거부한다. 파라미터를 SET 에만 쓰면 컬럼 타입으로 추론돼
 *      통과하므로 **재사용할 때만** 터진다. 고침 = `$2::time` 명시 캐스팅.
 *      ⇒ 같은 모양(SET + 문자열 WHERE 에 같은 `$n`, 컬럼이 text 가 아님)을 새로 쓸 때는 캐스팅을 붙인다.
 * ⚠ `inflow_guide_images = $4::jsonb` 에서 캐스팅을 빼는 변이는 이 가드가 **안 잡는다** —
 *   그 파라미터는 SET 에만 쓰여 컬럼 타입으로 추론되므로 **실제로 무해**하기 때문이다(명시는 유지).
 */
if (!process.env.PGLITE_MODULE) throw Error('Embedded PostgreSQL required (PGLITE_MODULE)');
const { PGlite } = require(process.env.PGLITE_MODULE);
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'));
const IMG = 'https://api.example.com/api/order/guide-image/' + 'a'.repeat(22);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

(async () => {
  const pg = new PGlite();
  /* 전파가 실제로 건드리는 칸만 — 타입·NOT NULL 은 마이그레이션 그대로(137 · 045). */
  await pg.query(`CREATE TABLE work_orders(
    id TEXT PRIMARY KEY, linked_campaign_id TEXT, deleted_at TIMESTAMPTZ)`);
  await pg.query(`CREATE TABLE recruit_campaigns(
    id TEXT PRIMARY KEY, source_work_order_id TEXT, linked_sheet_id TEXT, linked_tab_name TEXT,
    participation_mode BOOLEAN DEFAULT TRUE, work_detail JSONB,
    window_start TIME, window_end TIME, time_range TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pg.query(`CREATE TABLE campaign_options(
    id SERIAL PRIMARY KEY, campaign_id TEXT, opt_key TEXT, product_name TEXT, status TEXT DEFAULT 'open',
    sort_order INT DEFAULT 0,
    inflow_guide_html TEXT NOT NULL DEFAULT '',
    inflow_guide_images JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW())`);

  const client = { query: (sql, params) => pg.query(String(sql), params || []), release: () => {} };
  svc.__setPoolForTest({ connect: async () => client });

  async function reset(opts) {
    await pg.query('DELETE FROM campaign_options'); await pg.query('DELETE FROM recruit_campaigns');
    await pg.query('DELETE FROM work_orders');
    await pg.query(`INSERT INTO work_orders(id, linked_campaign_id) VALUES('wo_1','camp_1')`);
    await pg.query(`INSERT INTO recruit_campaigns(id, source_work_order_id, work_detail, window_start, window_end, time_range)
      VALUES('camp_1','wo_1',$1::jsonb,'10:00','12:00','오전 10시 ~ 12시')`, [JSON.stringify({ inflowType: 'link' })]);
    for (const o of (opts || [])) {
      await pg.query(`INSERT INTO campaign_options(campaign_id, opt_key, product_name, status, inflow_guide_html, inflow_guide_images)
        VALUES('camp_1',$1,$2,$3,$4,$5::jsonb)`, [o.k, o.p || '상품', o.s || 'open', o.h || '', JSON.stringify(o.i || [])]);
    }
  }
  const camp = async () => (await pg.query('SELECT * FROM recruit_campaigns WHERE id=$1', ['camp_1'])).rows[0];
  const opts = async () => (await pg.query('SELECT opt_key, inflow_guide_html, inflow_guide_images FROM campaign_options ORDER BY opt_key')).rows;

  console.log('\n진짜 PostgreSQL — 유입·시간창 전파');

  await t('① 공통 가이드 + 유입방식이 실제로 저장된다(컬럼·타입 실행 확인)', async () => {
    await reset();
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'guide',
      commonGuide: { text: '네이버에서 검색', images: JSON.stringify([IMG]) } });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    const wd = (await camp()).work_detail;
    assert.strictEqual(wd.inflowType, 'guide');
    assert.ok(/검색/.test(wd.inflowGuideHtml) && wd.inflowGuideHtml.includes(IMG), wd.inflowGuideHtml);
  });

  await t('② 선택지 가이드가 JSONB·NOT NULL 칸에 실제로 들어간다', async () => {
    await reset([{ k: '레드' }, { k: '블루' }]);
    const json = JSON.stringify([{ name: '핫팩', product_mode: 'opt', base: { pay: 0 }, options: [
      { label: '레드', pay: 1, guide: { text: '레드 안내', images: [IMG] } },
      { label: '블루', pay: 1, guide: { text: '블루 안내', images: [] } }] }]);
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'guide', productOptionsJson: json });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    const rows = await opts();
    assert.deepStrictEqual(rows.map(r => r.opt_key), ['레드', '블루']);
    assert.ok(/레드 안내/.test(rows[0].inflow_guide_html));
    assert.deepStrictEqual(rows[0].inflow_guide_images, [IMG], '사진 목록이 JSONB 로 안 들어갔다');
    assert.deepStrictEqual(rows[1].inflow_guide_images, [], 'NOT NULL 칸에 빈 배열이 안 들어갔다');
  });

  await t('③ 가이드가 빈 선택지가 있으면 **진짜로 되돌아간다**(거부 뒤 DB 무변경)', async () => {
    await reset([{ k: '레드' }]);
    const before = JSON.stringify((await camp()).work_detail);
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'guide' });
    assert.strictEqual(out.applied, false); assert.strictEqual(out.reason, 'guide_missing');
    assert.strictEqual(JSON.stringify((await camp()).work_detail), before, '거부했는데 공고가 바뀌었다');
    assert.strictEqual((await opts())[0].inflow_guide_html, '', '거부했는데 선택지가 바뀌었다');
  });

  await t('④ 시간창이 TIME 칸에 실제로 저장된다 — 리뷰어가 읽는 글자도 **같이** 바뀐다', async () => {
    await reset();
    const out = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '오후 2시 ~ 5시' });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    const c = await camp();
    assert.strictEqual(String(c.window_start).slice(0, 5), '14:00');
    assert.strictEqual(String(c.window_end).slice(0, 5), '17:00');
    /* ★★★ 실측 2026-09-22 — 종전에는 시각만 바뀌고 글자가 "자유시간대" 로 남아,
       리뷰어는 아무 때나 되는 줄 알고 들어와 막혔다(막다른 길). 글자와 시각은 같이 움직인다. */
    assert.strictEqual(c.time_range, '오후 2시 ~ 5시',
      '리뷰어가 읽는 글자가 안 바뀌었다 — 화면과 실제 열리는 시각이 어긋난다: ' + JSON.stringify(c.time_range));
  });

  await t('★ 자유시간대로 되돌리면 시간 제한이 **실제로 풀린다**(글자만 바뀌지 않는다)', async () => {
    await reset();
    await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '오후 2시 ~ 5시' });
    const out = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '자유시간대' });
    assert.strictEqual(out.applied, true, '자유시간대로 되돌리지 못했다: ' + JSON.stringify(out));
    const c = await camp();
    assert.strictEqual(c.window_start, null, '시간 제한이 안 풀렸다(시작 시각이 남아 있다)');
    assert.strictEqual(c.window_end, null, '시간 제한이 안 풀렸다(끝 시각이 남아 있다)');
    assert.strictEqual(c.time_range, '자유시간대');
  });

  await t('★ 읽을 수 없는 문장은 **아무것도 바꾸지 않는다**(추측하지 않는다)', async () => {
    await reset();
    const before = await camp();
    const out = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '사장님 편하신 때' });
    assert.strictEqual(out.applied, false); assert.strictEqual(out.reason, 'unparsed');
    const after = await camp();
    assert.strictEqual(String(after.window_start), String(before.window_start));
    assert.strictEqual(after.time_range, before.time_range, '못 읽은 문장을 글자에만 써 넣었다');
    assert.ok(/직접 고쳐/.test(svc.campaignSyncNotice('time', out)), '사람에게 알리지 않는다');
  });

  await t('⑤ 자정까지(24:00)도 TIME 이 받는다 — 범위 밖이면 저장이 통째로 죽는다', async () => {
    await reset();
    const out = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '23시~24시' });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    assert.strictEqual(String((await camp()).window_end), '24:00:00');
  });

  await t('⑥ 같은 값이면 쓰지 않는다(이미 같음)', async () => {
    await reset();
    await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '오후 2시 ~ 5시' });
    const out = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '오후 2시 ~ 5시' });
    assert.strictEqual(out.applied, false); assert.strictEqual(out.reason, 'already_same');
  });

  await t('⑦ 마감된 선택지는 가이드 검사 대상이 아니다', async () => {
    await reset([{ k: '레드', s: 'closed' }, { k: '블루', h: '블루 안내' }]);
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'guide' });
    assert.strictEqual(out.applied, true, '마감 선택지 때문에 막혔다: ' + JSON.stringify(out));
  });

  console.log(`\n  통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('실패:', e); process.exit(1); });
