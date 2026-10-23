/**
 * 결정 285 — 상품 이름은 시스템마다 따로(사용자 확정 2026-10-24 「가」).
 *   인트라넷 수정 창이 리뷰웹 이름과 다른 자기 이름으로 연 상품은 `bidir.rw_names`({인트라넷 이름: 리뷰웹 이름})를 싣고 저장한다.
 *   ① 판정: 짝이 있는 상품만 리뷰웹 이름으로 되돌린다 · 원래 이름(prev_name) 열쇠 우선 · 기준에 있는 이름·기준에 없는 짝·겹침은 그대로 · 요약 문장 버림
 *   ② 배선: 저장·관찰 두 경로가 같은 함수 · 수정 기준 응답 capabilities.keep_names
 *   ③ (PGTEST_URL) 이름이 갈라진 오더에 인트라넷 이름으로 금액만 고친 저장 → 리뷰웹·공고 이름 그대로 · 금액 반영 · 줄 더하기·지우기 0
 *      / 짝 없이 보내면 종전 판정(이름이 리뷰웹에 들어온다 = 지우고 더하기) — 이 갈래를 가드가 증명한다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const SP = require('../src/services/sharedPatch.service');
const P = (list) => ({ product_options_json: JSON.stringify(list), product_option: '인트라넷 문장' });
const prod = (name, pay = 9000, extra = {}) => ({ name, url: '', option_schema_version: 2, product_mode: 'none', base: { pay, count: 3, daily: 1, review_type_mix: [] }, options: [], ...extra });
const names = (m) => JSON.parse(m.product_options_json).map(p => p.name);

{
  const base = P([prod('1번 일체형베개'), prod('2번 다크그린')]);
  // 짝대로 되돌린다 · 요약 문장(인트라넷 이름) 버림
  let r = SP.alignIntranetNames(base, P([prod('일체형베개', 9500), prod('다크그린')]), { '일체형베개': '1번 일체형베개', '다크그린': '2번 다크그린' });
  assert.equal(r.aligned, 2); assert.deepEqual(names(r.mine), ['1번 일체형베개', '2번 다크그린']); assert.equal(r.mine.product_option, undefined, '인트라넷 이름 문장은 버린다');
  assert.equal(JSON.parse(r.mine.product_options_json)[0].base.pay, 9500, '이름 말고는 보낸 값 그대로');
  // 원래 이름 열쇠 우선 — 인트라넷에서 갈라진 상품 이름을 바꿔도 리뷰웹 이름 그대로 · 원래 이름 지움
  r = SP.alignIntranetNames(base, P([prod('일체형베개 리뉴얼', 9000, { prev_name: '일체형베개' }), prod('2번 다크그린')]), { '일체형베개': '1번 일체형베개' });
  assert.equal(r.aligned, 1); assert.deepEqual(names(r.mine), ['1번 일체형베개', '2번 다크그린']); assert.equal(JSON.parse(r.mine.product_options_json)[0].prev_name, undefined);
  // 기준에 이미 있는 이름(안 갈라짐)은 그대로 — 종전 이름 바꾸기 판정이 맡는다
  r = SP.alignIntranetNames(base, P([prod('1번 일체형베개'), prod('2번 다크그린')]), { '1번 일체형베개': '2번 다크그린' });
  assert.equal(r.aligned, 0);
  // 기준에 없는 짝 · 보낸 목록에 이미 있는 이름(겹침) · 모양이 틀린 짝 = 그대로(종전 판정)
  assert.equal(SP.alignIntranetNames(base, P([prod('새 상품')]), { '새 상품': '없는 이름' }).aligned, 0);
  assert.equal(SP.alignIntranetNames(base, P([prod('일체형베개'), prod('1번 일체형베개')]), { '일체형베개': '1번 일체형베개' }).aligned, 0, '겹치면 안 바꾼다');
  assert.equal(SP.alignIntranetNames(base, P([prod('일체형베개')]), ['x']).aligned, 0);
  assert.equal(SP.alignIntranetNames(base, P([prod('일체형베개')]), null).aligned, 0);
  // 두 상품이 같은 리뷰웹 이름으로 짝 = 첫 번째만
  r = SP.alignIntranetNames(base, P([prod('A'), prod('B')]), { A: '1번 일체형베개', B: '1번 일체형베개' });
  assert.equal(r.aligned, 1); assert.deepEqual(names(r.mine), ['1번 일체형베개', 'B']);
}
{
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/order.routes.js'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/sharedPatch.service.js'), 'utf8');
  assert.ok(/capabilities: \{ bidir_v1: true, keep_names: true \}/.test(routes), '수정 기준 응답에 keep_names');
  assert.ok(/nameMap: _bidirNameMap\(bid\)/.test(routes), '저장 경로가 짝을 넘긴다');
  assert.ok(/svc\.alignIntranetNames\(rows\[0\]\.state, _sourceSharedMine\(/.test(routes), '관찰 경로도 같은 함수로 되돌린 뒤 판정');
  const iAlign = svc.indexOf('alignIntranetNames(base, p.mine, p.nameMap)'), iSan = svc.indexOf('mine: sanitizeRenames(base, p.mine)');
  assert.ok(iAlign > 0 && iSan > iAlign, '이름 되돌리기는 이름 바꾸기 판정(sanitizeRenames)보다 먼저');
}
console.log('bidirKeepNames: static passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { productSummaryText } = require('../src/utils/orderProductSummary');
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const { linkSharedOrder, applySharedPatch, readSharedState } = SP;
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
  const PRODUCTS = [prod('일체형베개_아이보리', 18900), prod('일체형베개_다크그린', 18900)];
  const sid = `ro_keepnames_${stamp}`, camp = `camp_keepnames_${stamp}`, SHEET = 'sheet_keepnames', tab = `tab_keepnames_${stamp}`;
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  let woId = null;
  try {
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    const json = JSON.stringify(PRODUCTS);
    const r0 = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 이름 따로 오더', recruit_count: 6, daily_count: 2, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: 'https://www.coupang.com/vp/products/7',
      inflow_type: 'link', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: 18900 * 6 });
    assert.equal(r0.status, 200, JSON.stringify(r0.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    woId = w.id;
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, thumbnail_url, daily_limit, participation_mode, status, work_detail,
         linked_sheet_id, linked_tab_name, linked_tab_gid)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', FALSE, $8, '', $9, $10, $11, TRUE, 'active', $12::jsonb, $13, $14, '7')`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product }),
        SHEET, tab]);
    for (const o of proj.options) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
    }
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless, updated_at) VALUES ($1, $2, TRUE, NOW())`, [SHEET, tab]);
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const optRows = async () => (await pool.query(`SELECT opt_key, status, pay_amount FROM campaign_options WHERE campaign_id = $1 ORDER BY opt_key`, [camp])).rows;
    const save = async (list, nameMap) => {
      const cur = await wo();
      const j = JSON.stringify(list);
      return applySharedPatch({ workOrderId: w.id, mine: { ...readSharedState(cur), product_options_json: j, product_option: productSummaryText(j), pay_amount: list.reduce((a, p) => a + p.base.pay * p.base.count, 0) },
        baseVersion: Number(cur.sync_version), origin: 'intranet', actor: '인트라넷', conflictPolicy: 'last_writer', nameMap,
        moneyCapable: true, guideCapable: true, countsCapable: true, weekendsCapable: true, structureCapable: true, renameCapable: true });
    };

    // 갈라짐 만들기 — 리뷰웹 쪽 이름만 "1번 …" 으로(공고 창 이름 바꾸기와 같은 결과: 오더 사본·공고 줄 이름)
    const rw = JSON.parse((await wo()).product_options_json);
    rw[0].name = '1번 일체형베개_아이보리'; rw[1].name = '2번 일체형베개_다크그린';
    await pool.query('UPDATE work_orders SET product_options_json = $2, product_option = $3 WHERE id = $1', [w.id, JSON.stringify(rw), productSummaryText(JSON.stringify(rw))]);
    await pool.query(`UPDATE campaign_options SET opt_key = '1번 ' || opt_key, product_name = '1번 ' || product_name WHERE campaign_id = $1 AND opt_key = '일체형베개_아이보리'`, [camp]);
    await pool.query(`UPDATE campaign_options SET opt_key = '2번 ' || opt_key, product_name = '2번 ' || product_name WHERE campaign_id = $1 AND opt_key = '일체형베개_다크그린'`, [camp]);
    // 지금 모양으로 기준 스냅숏(같은 버전 줄을 지금 값으로)
    const cur0 = await wo();
    await pool.query(`INSERT INTO work_order_shared_snapshots (work_order_id, sync_version, origin, op_id, state, actor) VALUES ($1, $2, 'link', '', $3::jsonb, '시험')
                      ON CONFLICT (work_order_id, sync_version) DO UPDATE SET state = EXCLUDED.state`,
      [w.id, Number(cur0.sync_version), JSON.stringify(readSharedState(cur0))]);
    const optsBefore = await optRows();

    // 수정 기준 응답 — keep_names 표시
    const eb = await call('GET', `/api/order/intake/source/${sid}/shared`);
    assert.equal(eb.status, 200, JSON.stringify(eb.body)); assert.equal(eb.body.capabilities.keep_names, true);

    // K1 인트라넷 이름 + 짝 + 금액만 바꿈 → 리뷰웹·공고 이름 그대로 · 금액 반영 · 줄 수 그대로
    const intr = [prod('일체형베개_아이보리', 19900), prod('일체형베개_다크그린', 18900)];
    let out = await save(intr, { '일체형베개_아이보리': '1번 일체형베개_아이보리', '일체형베개_다크그린': '2번 일체형베개_다크그린' });
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.notEqual(out.body.ok, false, JSON.stringify(out.body));
    let after = JSON.parse((await wo()).product_options_json);
    assert.deepEqual(after.map(p => p.name), ['1번 일체형베개_아이보리', '2번 일체형베개_다크그린'], '리뷰웹 이름 그대로');
    assert.equal(after[0].base.pay, 19900, '금액은 반영');
    const optsAfter = await optRows();
    assert.deepEqual(optsAfter.map(o => [o.opt_key, o.status]), optsBefore.map(o => [o.opt_key, o.status]), '공고 줄 더하기·지우기·마감 0');
    assert.equal(Number(optsAfter.find(o => o.opt_key === '1번 일체형베개_아이보리').pay_amount), 19900, '공고 금액도 반영');
    assert.ok(String((await wo()).product_option || '').includes('1번 일체형베개_아이보리'), '요약 문장은 리뷰웹 이름으로 다시 만든다');

    // K2 짝 없이 인트라넷 이름 = 종전 판정(인트라넷 이름이 들어오거나 거부) — 이 갈래가 고친 이유다
    out = await save([prod('일체형베개_아이보리', 19900), prod('일체형베개_다크그린', 18900)], null);
    const names2 = JSON.parse((await wo()).product_options_json).map(p => p.name);
    assert.ok(out.status !== 200 || names2.includes('일체형베개_아이보리'), '짝이 없으면 되돌리지 않는다(종전 판정)');
  } finally {
    if (prevSetting) await pool.query(`UPDATE app_settings SET value = $1 WHERE key = 'bidir_sync'`, [prevSetting.value]);
    else await pool.query(`DELETE FROM app_settings WHERE key = 'bidir_sync'`);
    sw._resetBidirSwitchCacheForTest();
    if (woId) {
      await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = $1', [woId]);
      await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = $1', [woId]);
      await pool.query('DELETE FROM work_orders WHERE id = $1', [woId]);
    }
    await pool.query('DELETE FROM campaign_options WHERE campaign_id = $1', [camp]);
    await pool.query('DELETE FROM recruit_campaigns WHERE id = $1', [camp]);
    await pool.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2', [SHEET, tab]);
    srv.close();
    await pool.end();
  }
  console.log('bidirKeepNames: pg passed');
}

if (process.env.PGTEST_URL) pg().catch(e => { console.error(e); process.exit(1); });
