/**
 * 결정 279 — 가격 신고 [금액 고치기]: 리뷰오더와 맞춰지는 공고면 리뷰오더 금액까지 공유 저장으로 (사용자 확정 2026-10-23 「가」)
 *   A. 정적: 알림 트랜잭션 밖에서 먼저 · 같은 알림·금액은 한 번(opId) · 연결 아니면 종전 경로
 *   B. PGTEST_URL 있으면 진짜 PG: 옵션 공고 · 옵션 없는 공고 · 스위치 꺼짐(종전) · 두 번 눌러도 한 번 · 오더·공고 금액 차이 0
 *   ★ B 는 표를 만들고 지운다 — 시험 서버가 쓰는 DB 말고 복사본에서 돌린다.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { productSummaryText } = require('../src/utils/orderProductSummary');

let passed = 0;
function ok(name, cond, extra) { assert(cond, name + (extra ? '  ← ' + extra : '')); passed++; console.log('  ✓ ' + name); }

console.log('\n[A] 정적');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/services/campaignPriceReport.service.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function resolveAlert'));
  ok('연결 공고 처리는 알림 트랜잭션(db.connect) 전에', fn.indexOf('_editLinkedPrice({ db, aid, amount: next, who })') > 0
    && fn.indexOf('_editLinkedPrice({ db, aid, amount: next, who })') < fn.indexOf('const client = await db.connect()'));
  ok('공유 저장(applySharedPatch) · 같은 알림·금액은 opId 로 한 번', /applySharedPatch\(\{[\s\S]{0,260}opId: `price_alert_\$\{aid\}_\$\{amount\}`/.test(src));
  ok('금액 판정은 공고 창과 같은 계획(planCampaignMoneyEdit — 사본 0)', /planCampaignMoneyEdit\(\{ baseState: snap\[0\]\.state, camp: link\.camp, body, campOptions \}\)/.test(src));
  ok('옵션표는 줄 전부(안 보낸 줄 = 지움으로 읽힌다) · 인원·일건수는 기준(오더) 값', /body = \{ options: live\.map\(r => \{/.test(src) && /recruitTotal: br \? br\.recruit_total : r\.recruit_total/.test(src));
  ok('금액 말고 다른 변경이 끼면 쓰지 않는다(fail-closed)', /const extra = Object\.keys\(plan\.mine\)\.filter\(k => k !== 'product_options_json'\);/.test(src) && /plan\.changed\.some\(c => !\/\^결제금액\/\.test\(String\(c\)\)\)/.test(src));
  ok('연결 판정은 공고 창과 같은 함수(findBidirLink) · 스위치 campaign_edit', /findBidirLink\(db, cid\)/.test(src) && /campaign_edit !== 'on'\) return null/.test(src));
}

async function pg() {
  console.log('\n[B] 진짜 PG');
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder } = require('../src/services/sharedPatch.service');
  const { projectOrderToCampaign, compareOrderCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill, _woProductMode } = require('../src/utils/woCampaignPrefill.generated');
  const PR = require('../src/services/campaignPriceReport.service');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const sids = [], camps = [];
  const setup = async (tag, products) => {
    const sid = `ro_pr_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_pr_${tag}_${stamp}`; camps.push(camp);
    const json = JSON.stringify(products);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 가격신고 오더 ' + tag, recruit_count: 10, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '', product_url: 'https://www.coupang.com/vp/products/5',
      inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, thumbnail_url, daily_limit, participation_mode, status, work_detail,
         linked_sheet_id, linked_tab_name)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, $12, TRUE, 'active', $13::jsonb, 'sheet_pr', $14)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.skip_weekends === '1', proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product }),
        `tab_pr_${tag}_${stamp}`]);
    for (const o of (_woProductMode(JSON.parse(JSON.stringify(w))) === 'opt' ? proj.options : [])) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => (await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY id', [camp])).rows;
    const alert = async (optKey) => (await pool.query(`INSERT INTO campaign_price_alerts (campaign_id, opt_key, report_count) VALUES ($1, $2, 2) RETURNING id`, [camp, optKey])).rows[0].id;
    const moneyDiffs = async () => compareOrderCampaign(await wo(), await cRow(), await opts()).filter(d => /pay|product_lines/i.test(String(d.field)) || /pay/.test(JSON.stringify(d)));
    return { w, camp, wo, cRow, opts, alert, moneyDiffs };
  };
  const prev = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  const prods = (o) => JSON.parse(o.product_options_json);
  try {
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');

    // ── 옵션 공고: 「화이트 대용량」 21500 → 19900 ──
    const A = await setup('opt', [{ name: '탈취제', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
      { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
      { option_1: { name: '', value: '화이트 대용량' }, label: '화이트 대용량', url: '', pay: 21500, count: 5, daily: 1, review_type_mix: [] }] }]);
    const v0 = Number((await A.wo()).sync_version);
    const aid = await A.alert('화이트 대용량');
    const r1 = await PR.resolveAlert({ id: aid, action: 'edit', amount: 19900, by: '시험관리자' });
    ok('처리 성공', r1.ok === true, JSON.stringify(r1));
    const o1 = prods(await A.wo());
    ok('리뷰오더 옵션 2개 그대로(안 보낸 줄을 지우지 않는다 — 시험 실측)', o1[0].options.length === 2 && o1[0].options[0].label === '블랙', JSON.stringify(o1[0].options.map(o => o.label)));
    ok('리뷰오더 옵션 금액도 19900(다른 옵션은 그대로)', o1[0].options[1].pay === 19900 && o1[0].options[0].pay === 15900, JSON.stringify(o1[0].options.map(o => o.pay)));
    ok('인원·일건수 그대로', o1[0].options.every(o => o.count === 5 && o.daily === 1));
    const co = await A.opts();
    ok('공고 옵션 금액 19900', Number(co.find(r => r.opt_key === '화이트 대용량').pay_amount) === 19900);
    ok('리뷰오더 버전이 올랐다(공유 저장)', Number((await A.wo()).sync_version) > v0);
    const al = (await pool.query('SELECT * FROM campaign_price_alerts WHERE id = $1', [aid])).rows[0];
    ok('이력: 고침 · 전 21500 → 후 19900', al.resolution === 'edited' && Number(al.old_amount) === 21500 && Number(al.new_amount) === 19900, JSON.stringify(al));
    ok('오더·공고 금액 차이 0', (await A.moneyDiffs()).length === 0, JSON.stringify(await A.moneyDiffs()));
    const v1 = Number((await A.wo()).sync_version);
    const again = await PR.resolveAlert({ id: aid, action: 'edit', amount: 18000, by: '다른관리자' });
    ok('이미 처리된 알림을 다시 눌러도 오더를 또 바꾸지 않는다', again.already === true && Number((await A.wo()).sync_version) === v1
      && prods(await A.wo())[0].options[1].pay === 19900, JSON.stringify(again));

    // ── 옵션 없는 공고(상품 하나): 13000 → 12500 ──
    const B = await setup('one', [{ name: '샴푸', url: 'https://smartstore.naver.com/x/products/1', option_schema_version: 2, product_mode: 'none',
      base: { pay: 13000, count: 10, daily: 2, review_type_mix: [] }, options: [] }]);
    ok('옵션 없는 공고 = 공고 옵션 줄 0', (await B.opts()).length === 0);
    const bid = await B.alert('');
    const r2 = await PR.resolveAlert({ id: bid, action: 'edit', amount: 12500, by: '시험관리자' });
    ok('처리 성공', r2.ok === true, JSON.stringify(r2));
    ok('리뷰오더 상품 금액 12500', prods(await B.wo())[0].base.pay === 12500, JSON.stringify(prods(await B.wo())[0].base));
    const wd = (await B.cRow()).work_detail;
    ok('공고 안내 글 금액 12,500원', /결제금액 12,500원/.test(String((typeof wd === 'string' ? JSON.parse(wd) : wd).productLines)), JSON.stringify(wd));
    ok('오더·공고 금액 차이 0', (await B.moneyDiffs()).length === 0, JSON.stringify(await B.moneyDiffs()));

    // ── 공고에만 있는 줄이 끼어 있으면(오더와 이미 갈라짐) 금액만 바꿀 수 없다 → 막고 아무것도 안 바꾼다 ──
    const D = await setup('div', [{ name: '바디', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
      { option_1: { name: '', value: '라벤더' }, label: '라벤더', url: '', pay: 7000, count: 5, daily: 1, review_type_mix: [] },
      { option_1: { name: '', value: '로즈' }, label: '로즈', url: '', pay: 7000, count: 5, daily: 1, review_type_mix: [] }] }]);
    await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                       VALUES ($1, '자스민', '바디', 'option', '', 7000, 3, 1, 'active', 9)`, [D.camp]);
    const dv0 = Number((await D.wo()).sync_version);
    const r4 = await PR.resolveAlert({ id: await D.alert('라벤더'), action: 'edit', amount: 6500, by: '시험관리자' });
    ok('갈라진 공고 → 막고 안내(오더·공고 다름에서 먼저 맞추기)', r4.ok === false && r4.code === 409 && /오더·공고 다름/.test(r4.error), JSON.stringify(r4));
    ok('막혔으면 오더·공고 아무것도 안 바뀜', Number((await D.wo()).sync_version) === dv0 && prods(await D.wo())[0].options.length === 2
      && Number((await D.opts()).find(r => r.opt_key === '라벤더').pay_amount) === 7000);

    // ── 공고 편집 연결이 꺼져 있으면 종전: 공고만 ──
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    const C = await setup('off', [{ name: '린스', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
      { option_1: { name: '', value: 'S' }, label: 'S', url: '', pay: 9000, count: 5, daily: 1, review_type_mix: [] },
      { option_1: { name: '', value: 'M' }, label: 'M', url: '', pay: 9500, count: 5, daily: 1, review_type_mix: [] }] }]);
    const cv0 = Number((await C.wo()).sync_version);
    const r3 = await PR.resolveAlert({ id: await C.alert('S'), action: 'edit', amount: 8800, by: '시험관리자' });
    ok('스위치 꺼짐 = 종전(공고만 · 오더 무접촉)', r3.ok === true && Number((await C.opts()).find(r => r.opt_key === 'S').pay_amount) === 8800
      && prods(await C.wo())[0].options[0].pay === 9000 && Number((await C.wo()).sync_version) === cv0);
  } finally {
    if (prev) await pool.query(`UPDATE app_settings SET value = $1 WHERE key = 'bidir_sync'`, [prev.value]).catch(() => {});
    await pool.query(`DELETE FROM campaign_price_alerts WHERE campaign_id = ANY($1)`, [camps]).catch(() => {});
    await pool.query(`DELETE FROM campaign_options WHERE campaign_id = ANY($1)`, [camps]).catch(() => {});
    await pool.query(`DELETE FROM recruit_campaigns WHERE id = ANY($1)`, [camps]).catch(() => {});
    srv.close();
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log(`\n✅ bidirPriceReport: ${passed}개 통과${process.env.PGTEST_URL ? ' (진짜 PG 포함)' : ''}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
