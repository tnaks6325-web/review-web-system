/**
 * 결정 343 — 모집인원 조절 창에서 상품 일건수 바꾸기 (사용자 확정 2026-11-06)
 *   A. 순수: 요청 형식 · 지금 줄과 대조(그 사이 바뀜 = 409) · 연결 계획이 "일건수만" 바꾸는가(fail-closed)
 *   B. 정적: 권한 = 조절 창과 같은 내부 직원 · 연결 공고는 공고 창과 같은 계획 · 줄 전부 · 작업표 빈 줄 다시 깔기 · 조절 창 화면
 *   C. PGTEST_URL 있으면 진짜 PG: 연결 옵션 공고 · 연결 상품 하나 공고(실사례 모양) · 연결 아닌 공고 · 그 사이 바뀜 · 스위치 꺼짐 ·
 *      갈라진 공고 · HTTP(직원 토큰) · 조절 창 자료(optionDaily)
 *   ★ C 는 표를 만들고 지운다 — 시험 서버가 쓰는 DB 말고 복사본에서 돌린다.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

let passed = 0;
function ok(name, cond, extra) { assert(cond, name + (extra ? '  ← ' + extra : '')); passed++; console.log('  ✓ ' + name); }

const SVC = require('../src/services/campaignOptionDaily.service');

console.log('\n[A] 순수');
{
  const p = SVC.parseRequest;
  ok('정상 요청', JSON.stringify(p({ options: [{ optKey: 'A', dailyLimit: 40, from: 20 }] })) === JSON.stringify([{ optKey: 'A', dailyLimit: 40, from: 20 }]));
  ok('0명·음수·소수·너무 큼 = 거부', [0, -1, 1.5, 10000, '40명'].every(v => p({ options: [{ optKey: 'A', dailyLimit: v, from: 20 }] }) === null));
  ok('본 값(from) 없음 = 거부(그 사이 바뀜을 못 가린다)', p({ options: [{ optKey: 'A', dailyLimit: 40 }] }) === null);
  ok('같은 줄 두 번 = 거부', p({ options: [{ optKey: 'A', dailyLimit: 40, from: 20 }, { optKey: 'A', dailyLimit: 30, from: 20 }] }) === null);
  ok('빈 목록 = 거부', p({ options: [] }) === null && p({}) === null);

  const live = [{ opt_key: 'A', daily_limit: 20, status: 'active' }, { opt_key: 'B', daily_limit: 10, status: 'active' }, { opt_key: 'C', daily_limit: 0, status: 'closed' }];
  const c = SVC.checkAgainstLive;
  ok('열린 줄 전부 + 본 값 같음 = 통과', c([{ optKey: 'A', dailyLimit: 40, from: 20 }, { optKey: 'B', dailyLimit: 10, from: 10 }], live) === null);
  ok('열린 줄 하나 빠짐 = 409', c([{ optKey: 'A', dailyLimit: 40, from: 20 }], live).status === 409);
  ok('마감 줄을 보내면 = 409', c([{ optKey: 'A', dailyLimit: 40, from: 20 }, { optKey: 'C', dailyLimit: 5, from: 0 }], live).status === 409);
  ok('그 사이 바뀜(본 값 다름) = 409 option_daily_stale', c([{ optKey: 'A', dailyLimit: 40, from: 25 }, { optKey: 'B', dailyLimit: 10, from: 10 }], live).body.code === 'option_daily_stale');
  ok('바뀐 것 없음 = 400', c([{ optKey: 'A', dailyLimit: 20, from: 20 }, { optKey: 'B', dailyLimit: 10, from: 10 }], live).status === 400);
  ok('staleAgainst: 같으면 null · 다르면 409', SVC.staleAgainst([{ optKey: 'A', dailyLimit: 40, from: 20 }, { optKey: 'B', dailyLimit: 10, from: 10 }], live) === null
    && SVC.staleAgainst([{ optKey: 'A', dailyLimit: 40, from: 20 }, { optKey: 'B', dailyLimit: 10, from: 11 }], live).status === 409);
  ok('열린 줄 없음 = 409', c([{ optKey: 'A', dailyLimit: 40, from: 20 }], [{ opt_key: 'A', daily_limit: 20, status: 'closed' }]).status === 409);

  // 실사례 모양(상품 하나 · 340)11/4 비오진 — 가짜 이름) — 일건수만 바뀐 계획은 통과, 다른 칸이 끼면 막는다
  const prod = d => JSON.stringify([{ name: '가짜 세트', url: 'https://www.coupang.com/vp/products/1', option_schema_version: 2, product_mode: 'none',
    guide: { text: '', images: ['img1'] }, base: { pay: 39900, count: 200, daily: d, review_type_mix: [{ type: 'photo', quantity: 80 }, { type: 'text', quantity: 120 }] }, options: [] }]);
  const baseState = { recruit_count: 200, product_options_json: prod(20) };
  const v = SVC.dailyOnlyViolation;
  ok('일건수만 바뀜 = 통과', v({ mine: { recruit_count: 200, daily_count: 40, product_options_json: prod(40) }, changed: [], unmappable: [] }, baseState) === null);
  ok('총모집이 바뀌면 = 막음', v({ mine: { recruit_count: 210, daily_count: 40, product_options_json: prod(40) }, changed: [], unmappable: [] }, baseState) === 'recruit_count');
  const payChanged = JSON.parse(prod(40)); payChanged[0].base.pay = 35000;
  ok('금액이 끼면 = 막음', v({ mine: { daily_count: 40, product_options_json: JSON.stringify(payChanged) }, changed: [], unmappable: [] }, baseState) === 'product_options_json');
  ok('다른 칸(리뷰가이드)이 끼면 = 막음', /^extra:/.test(v({ mine: { daily_count: 40, review_guide: 'x' }, changed: [], unmappable: [] }, baseState)));
  ok('못 담는 칸이 있으면 = 막음', v({ mine: {}, changed: [], unmappable: [{ key: 'x' }] }, baseState) === 'unmappable');
}

console.log('\n[B] 정적');
{
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
  ok('입구 = 조절 창과 같은 내부 직원 권한(사용자 확정 A)', /router\.post\('\/campaigns\/:id\/option-daily', authMiddleware, internalMiddleware,/.test(routes));
  ok('저장 뒤 다시 읽기 실패해도 실패로 보이지 않는다(reload)', /reload: !ov/.test(routes));
  const src = fs.readFileSync(path.join(__dirname, '../src/services/campaignOptionDaily.service.js'), 'utf8');
  ok('연결 공고 = 공고 창과 같은 계획(planCampaignMoneyEdit — 사본 0)', /planCampaignMoneyEdit\(\{ baseState: snap\[0\]\.state, camp: link\.camp, body, campOptions \}\)/.test(src));
  ok('옵션표는 줄 전부(결정 280) · 인원·금액은 기준(오더) 값', /const options = live\.map\(r => \{/.test(src) && /recruitTotal: br \? br\.recruit_total : r\.recruit_total/.test(src) && /payAmount: br \? br\.pay_amount : r\.pay_amount/.test(src));
  ok('공유 저장(applySharedPatch · origin campaign) · opId 로 한 번', /applySharedPatch\(\{[\s\S]{0,200}origin: 'campaign'[\s\S]{0,900}opId: `option_daily_/.test(src));
  ok('연결 판정 실패 = 막음(fail-closed)', /option_daily_link_unknown/.test(src));
  ok('연결 공고: 공유 저장 잠금 안에서 본 값을 다시 대조(preHook — last_writer 가 남의 값을 조용히 덮지 않게)', /preHook: async \(client\) => \{[\s\S]{0,260}return staleAgainst\(want, rows\);/.test(src));
  ok('연결 공고: 공고만 맞추기는 오더 버전이 그대로일 때만(오더 잠금 후)', /SELECT sync_version FROM work_orders WHERE id = \$1 FOR UPDATE/.test(src) && /String\(wv\[0\]\.sync_version\) === String\(linked\.version\)/.test(src));
  ok('순차진행 공고는 막는다(상품 일건수가 하루 몫을 정하지 않음)', /option_daily_sequential/.test(src));
  ok('계획 예외는 409 안내(500 으로 가리지 않음)', /catch \(e\) \{   \/\/ 계획이 모양을 못 맞추면/.test(src));
  ok('스위치 꺼짐 = 409(공고만 바꾸지 않는다)', /campaign_edit !== 'on'\) \{\s*return fail\(409, 'counts_link_paused'/.test(src));
  ok('쓴 뒤 작업표 빈 줄 날짜를 다시 깐다', /relayCampaignWorktable\(cid,/.test(src));
  ok('날짜별로 정한 인원(campaign_daily_plans)은 건드리지 않는다', !/campaign_daily_plans/.test(src.replace(/^\/\/.*$/mg, '')));
  const plan = fs.readFileSync(path.join(__dirname, '../src/services/campaignPlan.service.js'), 'utf8');
  ok('조절 창 자료에 optionDaily(상한이 걸릴 때만 · 순차진행 제외)', /optionDayCapacity\(caps\) !== null/.test(plan) && /!caps\.sequentialSchedule/.test(plan) && /    optionDaily,\n/.test(plan));
  ok('조절 창 자료: Q&A·순차진행 공고는 경고 없음(서버가 막는 버튼을 보이지 않는다)', /if \(!isQna && !isSeq && Array\.isArray\(caps\)/.test(plan) && /typeof quotaCounts\.qnaToday === 'number'/.test(plan));
  const fe = fs.readFileSync(path.join(__dirname, '../../frontend/js/campaign-daily-plan.js'), 'utf8');
  ok('화면: 상한보다 큰 날 = "N명 중 cap명만"', /'명 중 ' \+ odCap \+ '명만<\/span>'/.test(fe));
  ok('화면: 비교는 사람이 정한 값(저장된 계획)으로 — 표 숫자(실제 여는 값)로 보면 저장된 40이 20으로 보여 경고가 안 뜬다', /odWant\(d\) > odCap/.test(fe) && /return S\.base\[d\] != null \? S\.base\[d\] : planFor\(d\);/.test(fe));
  ok('화면: 경고 줄 + [상품 일건수 바꾸기] 버튼(누를 때만 팝업 — 사용자 확정 B)', /상품 일건수 바꾸기<\/button>/.test(fe) && /onclick="CampaignDailyPlan\._odOpen\(\)"/.test(fe));
  ok('화면: 저장 전 확인(함께 바뀌는 곳) · 연결 공고면 인트라넷 리뷰오더 줄', /함께 바뀌는 곳/.test(fe) && /j\.optionDaily\.linked \? '<li>인트라넷 리뷰오더 일 진행 건수/.test(fe));
  ok('화면: 화면이 본 값(from)을 함께 보낸다', /dailyLimit: o\.next, from: o\.cur/.test(fe));
  ok('화면: 바꾼 뒤 저장 전 조절은 그대로 둔다(작업 연속 · 처음 값·재설정 표시까지)', /S\.pj\.pend = keep\.pend; S\.pj\.rm = keep\.rm; S\.pj\.orig = keep\.orig \|\| \{\}; S\.pj\.reset = keep\.reset;/.test(fe)
    && /if \(r\.reload \|\| !r\.campaignId\) \{ await _odReload\(campId\); return; \}/.test(fe));
  ok('화면: 그 사이 바뀜(409)이면 새 값을 다시 불러와 팝업을 다시 연다(막다른 길 금지)', /if \(e\.code === 'option_daily_stale'\)/.test(fe) && /_odReload\(campId\) && S && odCapNow\(\) != null\) \{ _odOpen\(\);/.test(fe));
  ok('화면: 이력에 상품 일건수 변경 표시', /ev\.action === 'option_daily'/.test(fe));
}

async function pg() {
  console.log('\n[C] 진짜 PG');
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder } = require('../src/services/sharedPatch.service');
  const { productSummaryText } = require('../src/utils/orderProductSummary');
  const { projectOrderToCampaign, compareOrderCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill, _woProductMode } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const call = async (method, p, body, token) => {
    const headers = { 'content-type': 'application/json', 'x-intake-key': 'test-intake' };
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const setSwitch = async (v) => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    sw._resetBidirSwitchCacheForTest();
  };
  const camps = [];
  /** 연결 공고 만들기 — soleRow: 상품 하나짜리도 상품 줄(campaign_options unit_kind product)을 둔다(운영 실사례 모양) */
  const setup = async (tag, products, { link = true, soleRow = false } = {}) => {
    const sid = `ro_od_${tag}_${stamp}`;
    const camp = `camp_od_${tag}_${stamp}`; camps.push(camp);
    const json = JSON.stringify(products);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 일건수 오더 ' + tag, recruit_count: products.reduce((a, p) => a + (p.base.count || 0) + (p.options || []).reduce((b, o) => b + o.count, 0), 0),
      review_fee: 1000, purchase_time: '13:00 ~ 18:00',
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
       VALUES ($1, '가짜 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, $12, TRUE, 'active', $13::jsonb, 'sheet_od', $14)`,
      [camp, link ? w.id : null, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type,
        proj.skip_weekends === '1', proj.channel, proj.landing_url, proj.thumbnail_url, Number(proj.daily_limit) || 1,
        JSON.stringify({ inflowType: 'link', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product }),
        `tab_od_${tag}_${stamp}`]);
    const rows = _woProductMode(JSON.parse(JSON.stringify(w))) === 'opt' || soleRow ? proj.options : [];
    for (const o of rows) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 0)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0]);
    }
    if (link) {
      await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
      const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
      assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    }
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => (await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY id', [camp])).rows;
    const diffs = async () => compareOrderCampaign(await wo(), await cRow(), await opts());
    return { w, camp, wo, cRow, opts, diffs };
  };
  const prev = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  const prods = (o) => JSON.parse(o.product_options_json);
  const events = async (camp) => (await pool.query(`SELECT * FROM campaign_plan_events WHERE campaign_id = $1 AND action = 'option_daily'`, [camp])).rows;
  try {
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"on"}');

    // ── 연결 옵션 공고: 블랙 2 → 4 (화이트는 그대로) ──
    const A = await setup('opt', [{ name: '탈취제', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
      { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 10, daily: 2, review_type_mix: [] },
      { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 21500, count: 10, daily: 2, review_type_mix: [] }] }]);
    const v0 = Number((await A.wo()).sync_version);
    const r1 = await SVC.changeOptionDaily({ campaignId: A.camp, actor: '시험직원',
      body: { options: [{ optKey: '블랙', dailyLimit: 4, from: 2 }, { optKey: '화이트', dailyLimit: 2, from: 2 }] } });
    ok('연결 옵션 공고 — 성공', r1.status === 200 && r1.body.applied.intranet === true, JSON.stringify(r1.body));
    const o1 = prods(await A.wo())[0].options;
    ok('리뷰오더 옵션 2개 그대로 · 블랙 일건수 4 · 화이트 2', o1.length === 2 && o1[0].daily === 4 && o1[1].daily === 2, JSON.stringify(o1.map(o => [o.label, o.daily])));
    ok('리뷰오더 인원·금액 그대로', o1[0].count === 10 && o1[1].count === 10 && o1[0].pay === 15900 && o1[1].pay === 21500);
    ok('리뷰오더 일 진행 건수 6 · 총모집 20 그대로', Number((await A.wo()).daily_count) === 6 && Number((await A.wo()).recruit_count) === 20, JSON.stringify({ d: (await A.wo()).daily_count, r: (await A.wo()).recruit_count }));
    ok('리뷰오더 버전이 올랐다(공유 저장 → 인트라넷 전송 대상)', Number((await A.wo()).sync_version) > v0);
    const co = await A.opts();
    ok('공고 옵션 일건수 블랙 4 · 화이트 2', Number(co.find(r => r.opt_key === '블랙').daily_limit) === 4 && Number(co.find(r => r.opt_key === '화이트').daily_limit) === 2);
    ok('공고 기본 일건수 6', Number((await A.cRow()).daily_limit) === 6);
    ok('오더·공고 차이 0', (await A.diffs()).length === 0, JSON.stringify(await A.diffs()));
    ok('조정 이력 1건(전 → 후 · 리뷰오더도 함께)', (await events(A.camp)).length === 1 && (await events(A.camp))[0].detail.linked === true);
    const v1 = Number((await A.wo()).sync_version);
    const again = await SVC.changeOptionDaily({ campaignId: A.camp, actor: '다른직원',
      body: { options: [{ optKey: '블랙', dailyLimit: 4, from: 2 }, { optKey: '화이트', dailyLimit: 2, from: 2 }] } });
    ok('옛 화면으로 다시 누르면 = 409(그 사이 바뀜) · 쓰기 0', again.status === 409 && again.body.code === 'option_daily_stale' && Number((await A.wo()).sync_version) === v1, JSON.stringify(again.body));

    // ── 판정(트랜잭션 밖)과 쓰기 사이에 남이 바꿈 → 공유 저장 잠금 안 재대조(preHook)가 막는다 ──
    //    밖의 판정이 옛 값을 보게 하려고 그 한 조회만 옛 값으로 돌려주는 대리 pool 을 쓴다(공유 저장은 진짜 pool).
    await pool.query(`UPDATE campaign_options SET daily_limit = 5 WHERE campaign_id = $1 AND opt_key = '블랙'`, [A.camp]);   // 남(인트라넷 투영 등)이 5로 바꿈
    const proxy = { connect: () => pool.connect(), query: async (sql, params) => {
      const r = await pool.query(sql, params);
      if (/^\s*SELECT \* FROM campaign_options WHERE campaign_id = \$1/.test(sql)) r.rows = r.rows.map(x => x.opt_key === '블랙' ? { ...x, daily_limit: 4 } : x);
      return r;
    } };
    const v2 = Number((await A.wo()).sync_version);
    const race = await SVC.changeOptionDaily({ campaignId: A.camp, actor: '시험직원', db: proxy,
      body: { options: [{ optKey: '블랙', dailyLimit: 7, from: 4 }, { optKey: '화이트', dailyLimit: 2, from: 2 }] } });
    ok('사이에 바뀜 → 공유 저장 안에서 409 · 오더 무접촉 · 남이 바꾼 5 유지', race.status === 409 && race.body.code === 'option_daily_stale'
      && Number((await A.wo()).sync_version) === v2 && Number((await A.opts()).find(r => r.opt_key === '블랙').daily_limit) === 5, JSON.stringify(race.body));
    await pool.query(`UPDATE campaign_options SET daily_limit = 4 WHERE campaign_id = $1 AND opt_key = '블랙'`, [A.camp]);

    // ── 연결 상품 하나 공고(운영 실사례 모양 · 상품 줄 있음): 20 → 40 ──
    const B = await setup('sole', [{ name: '가짜 세트 / 21호', url: 'https://www.coupang.com/vp/products/9', option_schema_version: 2, product_mode: 'none',
      base: { pay: 39900, count: 200, daily: 20, review_type_mix: [] }, options: [] }], { soleRow: true });
    ok('상품 하나 공고 = 상품 줄 1개', (await B.opts()).length === 1 && (await B.opts())[0].unit_kind === 'product', JSON.stringify(await B.opts()));
    const key = (await B.opts())[0].opt_key;
    const r2 = await SVC.changeOptionDaily({ campaignId: B.camp, actor: '시험직원', body: { options: [{ optKey: key, dailyLimit: 40, from: 20 }] } });
    ok('상품 하나 공고 — 성공', r2.status === 200, JSON.stringify(r2.body));
    const b1 = prods(await B.wo())[0];
    ok('리뷰오더 상품 일건수 40 · 인원 200 · 금액 그대로', b1.base.daily === 40 && b1.base.count === 200 && b1.base.pay === 39900, JSON.stringify(b1.base));
    ok('리뷰오더 일 진행 건수 40', Number((await B.wo()).daily_count) === 40);
    ok('공고 상품 줄 40 · 공고 기본 40', Number((await B.opts())[0].daily_limit) === 40 && Number((await B.cRow()).daily_limit) === 40);
    ok('오더·공고 차이 0', (await B.diffs()).length === 0, JSON.stringify(await B.diffs()));

    // ── 조절 창 자료(HTTP · 직원 토큰) ──
    const staff = jwt.sign({ name: '시험직원', role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const ov = await call('GET', `/api/trackb/campaigns/${encodeURIComponent(B.camp)}/daily-plan`, null, staff);
    ok('조절 창 자료에 상품 일건수(cap 40 · 연결)', ov.status === 200 && ov.body.optionDaily && ov.body.optionDaily.cap === 40 && ov.body.optionDaily.linked === true,
      JSON.stringify(ov.body.optionDaily) + ' ' + ov.status);
    const h = await call('POST', `/api/trackb/campaigns/${encodeURIComponent(B.camp)}/option-daily`, { options: [{ optKey: key, dailyLimit: 30, from: 40 }] }, staff);
    ok('직원 토큰으로 HTTP 바꾸기 = 200 + 조절 창 자료 동봉', h.status === 200 && h.body.ok === true && h.body.optionDaily && h.body.optionDaily.cap === 30 && h.body.defaultDaily === 30,
      JSON.stringify({ s: h.status, e: h.body.error, od: h.body.optionDaily }));
    const noAuth = await call('POST', `/api/trackb/campaigns/${encodeURIComponent(B.camp)}/option-daily`, { options: [{ optKey: key, dailyLimit: 50, from: 30 }] });
    ok('로그인 없이 = 막힘 · 쓰기 0', noAuth.status === 401 && Number((await B.cRow()).daily_limit) === 30, String(noAuth.status));

    // ── 공고에만 있는 줄이 끼어 있으면(오더와 이미 갈라짐) → 막고 아무것도 안 바꾼다 ──
    const D = await setup('div', [{ name: '바디', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
      { option_1: { name: '', value: '라벤더' }, label: '라벤더', url: '', pay: 7000, count: 5, daily: 1, review_type_mix: [] },
      { option_1: { name: '', value: '로즈' }, label: '로즈', url: '', pay: 7000, count: 5, daily: 1, review_type_mix: [] }] }]);
    await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                       VALUES ($1, '자스민', '바디', 'option', '', 7000, 3, 1, 'active', 9)`, [D.camp]);
    const dv0 = Number((await D.wo()).sync_version);
    const r4 = await SVC.changeOptionDaily({ campaignId: D.camp, actor: '시험직원', body: { options: [
      { optKey: '라벤더', dailyLimit: 3, from: 1 }, { optKey: '로즈', dailyLimit: 1, from: 1 }, { optKey: '자스민', dailyLimit: 1, from: 1 }] } });
    ok('갈라진 공고 → 409 · 안내', r4.status === 409 && /오더·공고 다름/.test(r4.body.error), JSON.stringify(r4.body));
    ok('막혔으면 오더·공고 아무것도 안 바뀜', Number((await D.wo()).sync_version) === dv0 && prods(await D.wo())[0].options.every(o => o.daily === 1)
      && (await D.opts()).every(r => Number(r.daily_limit) === 1));

    // ── 연결 아닌 공고: 공고 칸만 ──
    const N = await setup('plain', [{ name: '린스', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
      { option_1: { name: '', value: 'S' }, label: 'S', url: '', pay: 9000, count: 5, daily: 1, review_type_mix: [] },
      { option_1: { name: '', value: 'M' }, label: 'M', url: '', pay: 9500, count: 5, daily: 1, review_type_mix: [] }] }], { link: false });
    const nv0 = Number((await N.wo()).sync_version) || 0;
    const r5 = await SVC.changeOptionDaily({ campaignId: N.camp, actor: '시험직원', body: { options: [{ optKey: 'S', dailyLimit: 3, from: 1 }, { optKey: 'M', dailyLimit: 2, from: 1 }] } });
    ok('연결 아닌 공고 — 성공 · 인트라넷 아님', r5.status === 200 && r5.body.applied.intranet === false, JSON.stringify(r5.body));
    ok('공고 옵션 S 3 · M 2 · 공고 기본 5', Number((await N.opts()).find(r => r.opt_key === 'S').daily_limit) === 3
      && Number((await N.opts()).find(r => r.opt_key === 'M').daily_limit) === 2 && Number((await N.cRow()).daily_limit) === 5);
    ok('작업오더는 손대지 않는다', (Number((await N.wo()).sync_version) || 0) === nv0 && prods(await N.wo())[0].options.every(o => o.daily === 1));

    // ── 연결 저장 꺼짐 → 409 · 쓰기 0 ──
    await setSwitch('{"in2rw":"apply","push":"off","campaign_edit":"off"}');
    const C = await setup('off', [{ name: '샴푸', url: '', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
      { option_1: { name: '', value: 'L' }, label: 'L', url: '', pay: 9000, count: 5, daily: 1, review_type_mix: [] }] }]);
    const cv0 = Number((await C.wo()).sync_version);
    const r3 = await SVC.changeOptionDaily({ campaignId: C.camp, actor: '시험직원', body: { options: [{ optKey: 'L', dailyLimit: 3, from: 1 }] } });
    ok('스위치 꺼짐 = 409(공고만 바꾸지 않는다)', r3.status === 409 && r3.body.code === 'counts_link_paused', JSON.stringify(r3.body));
    ok('스위치 꺼짐 = 오더·공고 무접촉', Number((await C.wo()).sync_version) === cv0 && Number((await C.opts())[0].daily_limit) === 1 && prods(await C.wo())[0].options[0].daily === 1);
  } finally {
    if (prev) await pool.query(`UPDATE app_settings SET value = $1 WHERE key = 'bidir_sync'`, [prev.value]).catch(() => {});
    await pool.query(`DELETE FROM campaign_plan_events WHERE campaign_id = ANY($1)`, [camps]).catch(() => {});
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
  console.log(`\n✅ campaignOptionDaily: ${passed}개 통과${process.env.PGTEST_URL ? ' (진짜 PG 포함)' : ''}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
