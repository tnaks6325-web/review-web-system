'use strict';
/**
 * R1(같은 오더에서 구매수량 단계 고치기 · 결정 392) 시험 고정구 — 저장소 migrations 를 전부 깐 DB 위에서
 * 실제 앱(인트라넷 원본 수정 PUT · /shared)과 실제 공유 저장(applySharedPatch)을 돌린다.
 *
 *   PGlite(연결 1개 · 기본 검사) 와 네이티브 PostgreSQL(동시성 · 선택 실행) 둘 다 같은 고정구를 쓴다.
 *   ★ 이 파일을 require 하기 전에 `src/db/pool` 을 바꿔 끼워야 한다(installPglitePool / DATABASE_URL).
 *   개인정보 없음 — 이름·연락처는 모두 「가짜」 값.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..');

async function applyMigrations(exec) {
  const skipped = [];
  for (const f of fs.readdirSync(path.join(SERVER, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
    try { await exec(fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8')); } catch (e) { skipped.push(`${f}: ${e.message.slice(0, 60)}`); }
  }
  return skipped;
}

/** PGlite 를 `src/db/pool` 자리에 끼운다(연결 1개 — 시험은 순서대로만). */
async function installPglitePool() {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  const skipped = await applyMigrations(sql => db.exec(sql));
  const query = async (text, params) => {
    if (text && typeof text === 'object') { params = text.values; text = text.text; }
    const r = await db.query(text, params || []);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {}, totalCount: 0, idleCount: 0, waitingCount: 0 };
  const poolPath = require.resolve(path.join(SERVER, 'src/db/pool'));
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  return { pool, db, skipped };
}

const SERAMO = (count, tiers, daily = 40) => ([{
  name: '세라모사이드', url: 'https://smartstore.naver.com/x/products/235', option_schema_version: 2, product_mode: 'none',
  base: { pay: 12000, count, daily, review_type_mix: [] }, options: [],
  ...(tiers ? { qty_tiers: { mode: 'common', buy_method: 'qty', rows: tiers.map(([qty, people, amount]) => ({ option: null, qty, people, amount })) } } : {}),
}]);
const T400 = [[3, 30, 36000], [2, 105, 24000], [1, 265, 12000]];
const T235 = [[3, 30, 36000], [2, 105, 24000], [1, 100, 12000]];
const payOf = tiers => tiers.reduce((s, [, p, a]) => s + p * a, 0);

/**
 * 앱을 띄우고 「인트라넷 오더 접수 → 발행 그대로인 공고(단계 표 복사) → 무시트 작업표 빈 줄 → 양방향 연결」 고정구를 만든다.
 */
async function boot({ pool }) {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = require('../../src/app');
  const sw = require('../../src/utils/bidirSwitch');
  const SP = require('../../src/services/sharedPatch.service');
  const qt = require('../../src/services/campaignQtyTiers.service');
  const { productSummaryText } = require('../../src/utils/orderProductSummary');
  const { projectOrderToCampaign } = require('../../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill, _woProductMode } = require('../../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  srv.keepAliveTimeout = 120000;   // 고정구 만들기가 수 초 걸린다 — 재사용 연결이 그 사이 끊겨 ECONNRESET 이 나지 않게
  const port = srv.address().port;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', connection: 'close', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');
  const stamp = Date.now();
  let n = 0;

  /** products = 상품 구성 · opts.workKind · opts.reviewType · opts.options(공고 옵션 줄을 발행처럼 만든다 — opt 상품) */
  async function setup(tag, products, { workKind = 'review', reviewType = '포토', recruit = null, daily = null, linkTab = true, extra = {} } = {}) {
    n += 1;
    const sid = `ro_r1_${tag}_${stamp}_${n}`;
    const camp = `camp_r1_${tag}_${stamp}_${n}`;
    const sheet = `sheet_r1_${stamp}`;
    const tab = `tab_r1_${tag}_${n}`;
    const json = JSON.stringify(products);
    const sum = products.reduce((s, p) => s + (p.options.length ? p.options.reduce((a, o) => a + o.count, 0) : p.base.count), 0);
    const dsum = products.reduce((s, p) => s + (p.options.length ? p.options.reduce((a, o) => a + (o.daily || 0), 0) : (p.base.daily || 0)), 0);
    const pay = products.reduce((s, p) => s + (p.qty_tiers ? p.qty_tiers.rows.reduce((a, r) => a + r.people * r.amount, 0)
      : (p.options.length ? p.options.reduce((a, o) => a + o.pay * o.count, 0) : p.base.pay * p.base.count)), 0);
    const payload = {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 R1 오더 ' + tag, recruit_count: recruit == null ? sum : recruit, daily_count: daily == null ? dsum : daily, review_fee: 3000,
      purchase_time: '13:00 ~ 18:00', review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: products[0].url || 'https://www.coupang.com/vp/products/1',
      inflow_type: 'link', purchase_channel: '네이버', delivery_type: '실배송', review_type: reviewType, work_kind: workKind, skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: pay, ...extra };
    const r = await call('POST', '/api/order/intake', payload);
    assert.equal(r.status, 200, 'intake ' + JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    const proj = projectOrderToCampaign(w);
    const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end,
         delivery_type, review_type, work_kind, skip_weekends, channel, channel_custom, landing_url, thumbnail_url, daily_limit, participation_mode, status, work_detail,
         linked_sheet_id, linked_tab_name, published_at, review_type_mix)
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, $8, $9, $10, '', $11, $12, $13, TRUE, 'active', $14::jsonb, $15, $16, NOW(), $17::jsonb)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type, workKind,
        proj.skip_weekends === '1', proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product, payAmount: 12000 }),
        linkTab ? sheet : null, linkTab ? tab : null, JSON.stringify(Array.isArray(pre.review_type_mix) ? pre.review_type_mix : [])]);
    // 배송 혼합 오더 — 발행처럼 공고에도 같은 혼합 수량(연결 대조가 어긋나 diverged 가 되지 않게)
    if (w.delivery_type_mix && JSON.stringify(w.delivery_type_mix) !== '[]') {
      await pool.query('UPDATE recruit_campaigns SET delivery_type_mix = $2::jsonb WHERE id = $1', [camp, JSON.stringify(w.delivery_type_mix)]);
    }
    const optRows = [];
    let so = 0;
    for (const o of (_woProductMode(JSON.parse(JSON.stringify(w))) === 'opt' ? proj.options : [])) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0, so++]);
      optRows.push({ optKey: oKey || pName, productName: pName });
    }
    // 발행 복사와 같은 함수(planTierCopy + insertTiers) — 블로그·Q&A 는 복사하지 않는다(발행 규칙)
    if (qt.copiesFor ? qt.copiesFor(workKind) : !['blog', 'qna'].includes(workKind)) {
      await qt.insertTiers({ query: (t, p) => pool.query(t, p) }, camp, qt.planTierCopy(w.product_options_json, optRows));
    }
    if (linkTab) {
      await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless, updated_at) VALUES ($1, $2, TRUE, NOW())`, [sheet, tab]);
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, source, updated_by, updated_at)
                        SELECT $1, $2, g, '{}'::jsonb, 'worktable', '시험', NOW() FROM generate_series(1, $3::int) g`, [sheet, tab, Number(proj.recruit_total)]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await SP.linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', 'link ' + JSON.stringify(ln.body));
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => (await pool.query('SELECT opt_key, recruit_total, daily_limit, status FROM campaign_options WHERE campaign_id = $1 ORDER BY sort_order, id', [camp])).rows;
    const tiers = async () => (await pool.query('SELECT product_name, opt_key, qty, people, pay_amount, buy_method FROM campaign_qty_tiers WHERE campaign_id = $1 ORDER BY sort_order, id', [camp])).rows
      .map(t => [t.product_name, t.opt_key, Number(t.qty), Number(t.people), Number(t.pay_amount), t.buy_method]);
    const rows = async () => Number((await pool.query(`SELECT COUNT(*)::int n FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active`, [sheet, tab])).rows[0].n);
    const events = async () => (await pool.query(`SELECT action, actor, detail FROM campaign_plan_events WHERE campaign_id = $1 ORDER BY id`, [camp])).rows;
    /** 지금 상태 지문 — 거절 때 「아무것도 안 바뀜」을 한 줄로 비교한다. */
    const snapshot = async () => {
      const x = await wo(); const c = (await cRow()) || {};
      return JSON.stringify({ src: Number(x.source_revision), ver: String(x.sync_version), poj: x.product_options_json, pay: Number(x.pay_amount), rc: Number(x.recruit_count), dc: Number(x.daily_count),
        crt: Number(c.recruit_total), cdl: Number(c.daily_limit), opts: await opts(), tiers: await tiers(), rows: await rows(), ev: (await events()).length,
        snaps: Number((await pool.query('SELECT COUNT(*)::int n FROM work_order_shared_snapshots WHERE work_order_id=$1', [x.id])).rows[0].n) });
    };
    let rev = 1;
    /** 실제 인트라넷 저장 경로(원본 수정 PUT) — 전 칸을 지금 값으로 다시 보내고 바꿀 칸만 덮는다. bidir 표시는 bid 로 더한다. */
    const putSource = async (patch = {}, bid = {}, { revision = null, baseVersion = null } = {}) => {
      const cur = await wo();
      const next = revision == null ? rev + 1 : revision;
      const r2 = await call('PUT', `/api/order/intake/source/${sid}`, { ...payload, source_revision: next, idempotency_key: `${sid}:${next}:r1`,
        product_options_json: cur.product_options_json, product_option: cur.product_option, pay_amount: Number(cur.pay_amount), review_fee: Number(cur.review_fee),
        recruit_count: Number(cur.recruit_count), daily_count: Number(cur.daily_count), ...patch,
        bidir: { base_sync_version: baseVersion == null ? Number(cur.sync_version) : baseVersion, op_id: `op_r1_${tag}_${stamp}_${n}_${next}`, money: 1, counts: 1, ...bid } });
      if (r2.status === 200 && r2.body && r2.body.ok) rev = next;
      return r2;
    };
    return { sid, camp, sheet, tab, w, wo, cRow, opts, tiers, rows, events, snapshot, putSource, payload };
  }

  /** 인트라넷 화면이 하듯 단계·인원을 고친 저장 칸(상품 구성·총모집·일건수·결제합계·요약 문장). */
  function tierEdit(cur, fn) {
    const p = JSON.parse(cur.product_options_json); fn(p);
    let total = 0, daily = 0, pay = 0;
    for (const x of p) {
      const t = x.qty_tiers && Array.isArray(x.qty_tiers.rows) && x.qty_tiers.rows.length ? x.qty_tiers.rows : null;
      if (x.options.length) for (const o of x.options) { total += o.count; daily += o.daily || 0; if (!t) pay += o.pay * o.count; }
      else { total += x.base.count; daily += x.base.daily || 0; if (!t) pay += x.base.pay * x.base.count; }
      if (t) pay += t.reduce((a, r) => a + r.people * r.amount, 0);
    }
    const json = JSON.stringify(p);
    return { product_options_json: json, recruit_count: total, daily_count: daily, pay_amount: pay, product_option: productSummaryText(json) };
  }
  const close = async () => { await new Promise(r => srv.close(r)); };
  return { app, call, setSwitch, setup, tierEdit, close, SP };
}

module.exports = { installPglitePool, applyMigrations, boot, SERAMO, T400, T235, payOf };
