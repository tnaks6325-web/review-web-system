/**
 * 오더·공고 맞추기(결정 263 · 사용자 확정 2026-10-21 「C스타일 · 칸마다 고르기 + 전부 한쪽 · 관리자 이상」).
 *   값이 다른(연결 전) 오더 ↔ 공고를 칸마다 쪽을 골라 맞추고 연결한다 — ① 오더를 공고와 같게(P) ② 오더 쪽 고른 칸만 보통 공유 저장으로.
 *   끝에 다시 비교해 한 칸이라도 다르면 통째로 되돌린다.
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const { productSummaryText } = require('../src/utils/orderProductSummary');

const OPT_P = [{ name: '탈취제', url: 'https://smartstore.naver.com/x/products/11', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
  { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15900, count: 5, daily: 1, review_type_mix: [] },
  { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 21500, count: 12, daily: 2, review_type_mix: [] }] }];

{
  // 정적 — 판정·변환 단일 출처를 태운다(새로 만들지 않는다)
  const src = require('fs').readFileSync(require.resolve('../src/services/sharedReconcile.service'), 'utf8');
  assert.match(src, /compareOrderCampaign\(wo, camp, opts\)\.filter\(d => d\.kind === 'diff'\)/, '무엇이 다른가 = 연결 판정과 같은 비교');
  assert.match(src, /planCampaignSharedEdit\(\{ baseState, camp: fake, body \}\)/, '공고 → 오더 = 공고 편집 창 저장의 되돌리기 계산');
  assert.match(src, /planCampaignMoneyEdit\(\{ baseState, camp: fake, body, campOptions: fakeOpts \}\)/);
  assert.match(src, /applySharedPatch\(\{ workOrderId, origin: 'reconcile'/, '쓰기 = 공유 저장 한 곳');
  const sp = require('fs').readFileSync(require.resolve('../src/services/sharedPatch.service'), 'utf8');
  assert.ok(sp.indexOf("code: 'reconcile_incomplete'") > 0 && sp.indexOf("code: 'reconcile_incomplete'") < sp.indexOf("VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,\n        [wo.id, newVersion"),
    '끝 비교는 스냅숏·송신·커밋 전(fail-closed)');
  assert.match(sp, /if \(plan\.fingerprint !== String\(rec\.fingerprint \|\| ''\)\)/, '화면이 본 차이가 지금과 다르면 막는다');
  // 검토 2026-10-21 ⑤ — 같은 저장 재전송 확인은 맞추기 준비(이미 연결 판정)보다 먼저
  assert.ok(sp.indexOf("SELECT sync_version FROM work_order_shared_snapshots WHERE op_id = $1") < sp.indexOf('const r = await _reconcilePrepareInTx('), 'opId 재전송 확인이 맞추기 준비보다 앞');
  // ⑥ — 목록의 공고 찾기 = 짝짓기 단일 출처(정방향·역방향)
  assert.match(src, /require\('\.\/linkedRecruitQuota\.service'\);\n[^]*?JOIN LATERAL \(SELECT c\.\* FROM recruit_campaigns c WHERE c\.archived_at IS NULL AND \$\{LINKED_WO_ON\}/);
  // ① — 비교 모양 혼합 수량은 CANON 글자(JSON 아님)
  const R0 = require('../src/services/sharedReconcile.service');
  assert.deepEqual(R0._mixArr('photo:3,text:2'), [{ type: 'photo', quantity: 3 }, { type: 'text', quantity: 2 }]);
  assert.deepEqual(R0._mixArr(''), []);
  assert.throws(() => R0._mixArr('invalid:"x"'));
  // ④ — 이름 바꾸기 표시는 기준(P)에 남기지 않는다
  const st = R0._stripRenameMarks({ product_options_json: JSON.stringify([{ name: 'A', prev_name: 'B', options: [{ label: 'x', prev_label: 'y' }] }]) });
  assert.ok(!/prev_name|prev_label/.test(st.product_options_json), st.product_options_json);
}
console.log('bidirReconcile: static passed');

async function pg() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const { linkSharedOrder } = require('../src/services/sharedPatch.service');
  const R = require('../src/services/sharedReconcile.service');
  const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const { rows: prevRows } = await pool.query(`SELECT value FROM app_settings WHERE key='bidir_sync'`);
  const prevSetting = prevRows[0];
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', '{"in2rw":"apply","campaign_edit":"on"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  sw._resetBidirSwitchCacheForTest();
  const sids = [], camps = [], tabs = [];
  const SHEET = 'sheet_rcn';
  /** 인트라넷 오더 + 발행 그대로의 공고(옵션 줄) → diverge(공고만 고침) → 연결 시도(diverged). */
  const setup = async (tag, diverge) => {
    const sid = `ro_rcn_${tag}_${stamp}`; sids.push(sid);
    const camp = `camp_rcn_${tag}_${stamp}`; camps.push(camp);
    const tab = `tab_rcn_${tag}_${stamp}`; tabs.push(tab);
    const json = JSON.stringify(OPT_P);
    const r = await call('POST', '/api/order/intake', {
      source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 맞추기 ' + tag, recruit_count: 17, daily_count: 3, review_fee: 1000, purchase_time: '13:00 ~ 18:00',
      review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '주의 없음', product_url: OPT_P[0].url,
      inflow_type: 'link', purchase_channel: '스마트스토어', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: json, product_option: productSummaryText(json), pay_amount: 15900 * 5 + 21500 * 12 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
    await pool.query(`UPDATE work_orders SET work_manager = '박은비' WHERE id = $1`, [w.id]);
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
    let i = 0;
    for (const o of proj.options) {
      const [pName, oKey] = o.key.split('|');
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
        [camp, oKey || pName, pName, o.unit_kind, o.option_url, Number(o.pay_amount) || 0, Number(o.recruit_total) || 0, Number(o.daily_limit) || 0, i++]);
    }
    await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, sheetless, delivery_type, taekhap, updated_at) VALUES ($1, $2, $3, TRUE, '실배송', FALSE, NOW())`, [SHEET, tab, 'g' + tag + stamp]);
    for (let k = 1; k <= 17; k++) {
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, option_text, source, updated_by, updated_at)
                        VALUES ($1, $2, $3, '{}'::jsonb, $4, 'worktable', '시험', NOW())`, [SHEET, tab, k, k <= 5 ? '블랙' : '화이트']);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    if (diverge) await diverge(camp);
    const ln = await linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [w.id])).rows[0];
    const cRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [camp])).rows[0];
    const opts = async () => (await pool.query(`SELECT * FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'deleted' ORDER BY sort_order, id`, [camp])).rows;
    const item = async () => (await R.listReconcile(pool)).items.find(x => x.workOrderId === w.id);
    return { sid, camp, tab, w, ln, wo, cRow, opts, item };
  };
  const picksOf = (it, fn) => Object.fromEntries(it.fields.filter(f => !f.derived).map(f => [f.id, fn(f)]));
  const outbox = async (id) => (await pool.query('SELECT COUNT(*)::int AS n FROM shared_sync_outbox WHERE work_order_id = $1', [id])).rows[0].n;
  const renameCamp = (camp) => pool.query(`UPDATE campaign_options SET opt_key = '1번 ' || opt_key WHERE campaign_id = $1`, [camp]);

  try {
    // ── R1 공고에서 리뷰비·옵션 이름·옵션 주소를 고친 공고 — 리뷰비는 공고 쪽, 이름·주소는 오더 쪽 ──
    const A = await setup('a', async (camp) => {
      await pool.query(`UPDATE recruit_campaigns SET review_fee = 1500 WHERE id = $1`, [camp]);
      await renameCamp(camp);
      await pool.query(`UPDATE campaign_options SET option_url = 'https://naver.me/short1' WHERE campaign_id = $1 AND opt_key = '1번 블랙'`, [camp]);
    });
    assert.equal(A.ln.body.state, 'diverged', JSON.stringify(A.ln.body));
    let it = await A.item();
    assert.ok(it, '목록에 나온다');
    const ids = it.fields.map(f => f.id).sort();
    assert.deepEqual(ids, ['option:탈취제 / 블랙.name', 'option:탈취제 / 블랙.option_url', 'option:탈취제 / 화이트.name', 'review_fee'].sort(), JSON.stringify(ids));
    const f = id => it.fields.find(x => x.id === id);
    assert.equal(f('review_fee').campaignSide.ok, true);
    assert.equal(f('option:탈취제 / 블랙.name').campaignSide.ok, true);
    assert.equal(f('option:탈취제 / 블랙.option_url').campaignSide.ok, false, '옵션 주소는 공고 쪽으로 못 옮긴다(오더 쪽만)');
    assert.equal(it.workManager, '박은비');
    // 고르지 않은 칸이 있으면 막힌다
    let out = await R.reconcileSharedOrder({ workOrderId: A.w.id, picks: { review_fee: 'campaign' }, fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 409); assert.equal(out.body.code, 'reconcile_unpicked');
    // 지문이 다르면(그 사이 바뀜) 막힌다
    out = await R.reconcileSharedOrder({ workOrderId: A.w.id, picks: picksOf(it, () => 'order'), fingerprint: 'old', actor: '시험' });
    assert.equal(out.status, 409); assert.equal(out.body.code, 'reconcile_stale');
    // 공고 쪽으로 못 옮기는 칸을 공고 쪽으로 고르면 막힌다
    out = await R.reconcileSharedOrder({ workOrderId: A.w.id, picks: picksOf(it, () => 'campaign'), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 409); assert.equal(out.body.code, 'reconcile_campaign_side_locked');
    const picks = picksOf(it, x => (x.id === 'review_fee' ? 'campaign' : 'order'));
    // 해 보기(dryRun) — 아무것도 안 바뀐다
    const before = JSON.stringify([await A.wo(), await A.cRow(), await A.opts()]);
    out = await R.reconcileSharedOrder({ workOrderId: A.w.id, picks, fingerprint: it.fingerprint, dryRun: true, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal(out.body.dryRun, true);
    assert.equal(JSON.stringify([await A.wo(), await A.cRow(), await A.opts()]), before, 'dryRun 은 되돌린다');
    out = await R.reconcileSharedOrder({ workOrderId: A.w.id, picks, fingerprint: it.fingerprint, actor: '시험', opId: 'rcn-a-1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    let w = await A.wo();
    assert.equal(w.bidir_state, 'on');
    assert.equal(Number(w.review_fee), 1500, '리뷰비 = 공고 쪽');
    assert.deepEqual((await A.opts()).map(o => [o.opt_key, o.option_url]), [['블랙', OPT_P[0].url], ['화이트', OPT_P[0].url]], '이름·주소 = 오더 쪽(공고가 따라감)');
    assert.deepEqual(JSON.parse(w.product_options_json)[0].options.map(o => o.label), ['블랙', '화이트']);
    assert.equal(Number((await A.cRow()).review_fee), 1500);
    assert.ok(await outbox(A.w.id) >= 1, '인트라넷으로 보낼 거리가 쌓인다');
    assert.ok(!(await R.listReconcile(pool)).items.some(x => x.workOrderId === A.w.id), '맞춘 뒤 목록에서 빠진다');
    // 검토 ⑤ — 커밋은 됐는데 응답만 잃은 재전송(같은 opId) = 성공으로(「이미 연결」 실패 아님)
    out = await R.reconcileSharedOrder({ workOrderId: A.w.id, picks, fingerprint: it.fingerprint, actor: '시험', opId: 'rcn-a-1' });
    assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal(out.body.idempotent, true);

    // ── R2 전부 공고 쪽(옵션 주소는 오더 쪽만) — 오더가 공고 이름을 받는다(인트라넷도 그 이름으로) ──
    const B = await setup('b', async (camp) => { await pool.query(`UPDATE recruit_campaigns SET review_fee = 1500 WHERE id = $1`, [camp]); await renameCamp(camp); });
    it = await B.item();
    out = await R.reconcileSharedOrder({ workOrderId: B.w.id, picks: picksOf(it, x => (x.campaignSide.ok ? 'campaign' : 'order')), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    w = await B.wo();
    assert.equal(w.bidir_state, 'on');
    assert.deepEqual(JSON.parse(w.product_options_json)[0].options.map(o => o.label), ['1번 블랙', '1번 화이트']);
    assert.deepEqual((await B.opts()).map(o => o.opt_key), ['1번 블랙', '1번 화이트'], '공고는 그대로');
    // 검토 ④ — 이름 바꾸기 표시(원래 이름)가 오더·기준 스냅숏에 남지 않는다
    assert.ok(!/prev_name|prev_label/.test(w.product_options_json), w.product_options_json);
    { const { rows: sn } = await pool.query(`SELECT state::text AS s FROM work_order_shared_snapshots WHERE work_order_id = $1 AND origin = 'reconcile_base'`, [B.w.id]);
      assert.ok(sn.length && !/prev_name|prev_label/.test(sn[0].s), JSON.stringify(sn)); }
    assert.equal(Number(w.review_fee), 1500);
    assert.ok(await outbox(B.w.id) >= 1);

    // ── R3 옵션 인원 — 공고에서 블랙 5 → 8(총모집 20) · 공고 쪽 ──
    const C = await setup('c', async (camp) => {
      await pool.query(`UPDATE campaign_options SET recruit_total = 8 WHERE campaign_id = $1 AND opt_key = '블랙'`, [camp]);
      await pool.query(`UPDATE recruit_campaigns SET recruit_total = 20 WHERE id = $1`, [camp]);
    });
    it = await C.item();
    assert.ok(it.fields.find(x => x.id === 'recruit_total').derived, '총모집은 줄 인원을 따른다');
    out = await R.reconcileSharedOrder({ workOrderId: C.w.id, picks: picksOf(it, () => 'campaign'), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    w = await C.wo();
    assert.equal(JSON.parse(w.product_options_json)[0].options[0].count, 8);
    assert.equal(Number(w.recruit_count), 20);
    // ── R3b 같은 차이를 오더 쪽으로 — 공고 인원이 5 로 돌아간다 ──
    const C2 = await setup('c2', async (camp) => {
      await pool.query(`UPDATE campaign_options SET recruit_total = 8 WHERE campaign_id = $1 AND opt_key = '블랙'`, [camp]);
      await pool.query(`UPDATE recruit_campaigns SET recruit_total = 20 WHERE id = $1`, [camp]);
    });
    it = await C2.item();
    out = await R.reconcileSharedOrder({ workOrderId: C2.w.id, picks: picksOf(it, () => 'order'), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual((await C2.opts()).map(o => o.recruit_total), [5, 12]);
    assert.equal(Number((await C2.cRow()).recruit_total), 17);

    // ── R4 공고에만 있는 옵션(참여자 2명) — 오더 쪽 = 지우면 마감으로 남는다 ──
    const D = await setup('d', async (camp) => {
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, pay_amount, recruit_total, daily_limit, status, sort_order)
                        VALUES ($1, '그레이', '탈취제', 'option', $2, 15900, 3, 1, 'active', 9)`, [camp, OPT_P[0].url]);
      await pool.query(`UPDATE recruit_campaigns SET recruit_total = 20 WHERE id = $1`, [camp]);
      await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, expires_at)
                        SELECT $1, '가짜참여' || g, lpad((7700000 + g)::text, 8, '0'), 'applied', '그레이', NOW() + INTERVAL '1 hour' FROM generate_series(1, 2) g`, [camp]);
    });
    it = await D.item();
    const pres = it.fields.find(x => x.leaf === 'presence');
    assert.ok(pres, JSON.stringify(it.fields.map(x => x.id)));
    assert.equal(pres.used, 2, '참여 수 안내');
    out = await R.reconcileSharedOrder({ workOrderId: D.w.id, picks: picksOf(it, () => 'order'), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.closed_options, [{ pName: '탈취제', oLabel: '그레이', used: 2 }], JSON.stringify(out.body));
    const gray = (await D.opts()).find(o => o.opt_key === '그레이');
    assert.equal(gray.status, 'closed', '참여자가 있어 지우지 않고 마감');

    // ── R5 체험단 종류가 다르면 여기서 맞추지 않는다 ──
    const E = await setup('e', async (camp) => { await pool.query(`UPDATE recruit_campaigns SET work_kind = 'blog' WHERE id = $1`, [camp]); });
    it = await E.item();
    assert.ok(it.blocked && /체험단 종류/.test(it.blocked), JSON.stringify(it));
    out = await R.reconcileSharedOrder({ workOrderId: E.w.id, picks: {}, fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 409); assert.equal(out.body.code, 'reconcile_blocked');
    assert.notEqual((await E.wo()).bidir_state, 'on');

    // ── R7 글·설정 칸 여럿 — 구매시간·주말·구매채널·썸네일·리뷰타입. 하나는 전부 공고 쪽, 하나는 전부 오더 쪽 ──
    const scalarDiverge = async (camp) => {
      await pool.query(`UPDATE recruit_campaigns SET time_range = '10:00 ~ 12:00', window_start = '10:00', window_end = '12:00', skip_weekends = TRUE,
                          channel = '쿠팡', thumbnail_url = 'https://img.example/t.png', review_type = 'text' WHERE id = $1`, [camp]);
    };
    for (const side of ['campaign', 'order']) {
      const G = await setup('g' + side, scalarDiverge);
      it = await G.item();
      const gids = it.fields.map(x => x.id).sort();
      assert.deepEqual(gids, ['channel', 'review_type', 'skip_weekends', 'time_range'], JSON.stringify(gids));   // 썸네일은 오더가 비어 있어 「채울 값」(차이 아님 · 비교 규칙)
      for (const x of it.fields) assert.equal(x.campaignSide.ok, true, `${x.id}: ${JSON.stringify(x.campaignSide)}`);
      out = await R.reconcileSharedOrder({ workOrderId: G.w.id, picks: picksOf(it, () => side), fingerprint: it.fingerprint, actor: '시험' });
      assert.equal(out.status, 200, `${side}: ${JSON.stringify(out.body)}`);
      w = await G.wo(); const c = await G.cRow();
      assert.equal(w.bidir_state, 'on');
      if (side === 'campaign') {
        assert.match(w.purchase_time, /^10:00\s*~\s*12:00$/); assert.equal(w.skip_weekends, true);
        assert.equal(w.review_type, '텍스트'); assert.equal(w.purchase_channel, '쿠팡');
      } else {
        assert.match(c.time_range, /^13:00\s*~\s*18:00$/); assert.equal(c.skip_weekends, false); assert.equal(c.review_type, 'photo');
      }
    }

    // ── R8 옵션별 리뷰타입 수량이 다른 공고 — 목록이 깨지지 않는다(검토 ①: 비교 모양은 CANON 글자) ──
    const M = await setup('m', async (camp) => {
      // 양쪽 다 값이 있어야 「차이」(한쪽이 비면 「채울 값」) — 오더 블랙 = 포토 5 · 공고 블랙 = 포토 3·텍스트 2
      const { rows: [mw] } = await pool.query(`SELECT w.id, w.product_options_json FROM work_orders w JOIN recruit_campaigns c ON c.source_work_order_id = w.id WHERE c.id = $1`, [camp]);
      const pj = JSON.parse(mw.product_options_json); pj[0].options[0].review_type_mix = [{ type: 'photo', quantity: 5 }];
      await pool.query(`UPDATE work_orders SET product_options_json = $2 WHERE id = $1`, [mw.id, JSON.stringify(pj)]);
      await pool.query(`UPDATE campaign_options SET review_type_mix = '[{"type":"photo","quantity":3},{"type":"text","quantity":2}]'::jsonb WHERE campaign_id = $1 AND opt_key = '블랙'`, [camp]);
    });
    const lm = await R.listReconcile(pool);   // 예전: JSON.parse("photo:3,text:2") 예외 → 목록 전체 500
    it = lm.items.find(x => x.workOrderId === M.w.id);
    assert.ok(it, JSON.stringify(lm.items.map(x => x.workOrderId)));
    const mf = it.fields.find(x => x.id === 'option:탈취제 / 블랙.review_type_mix');
    assert.ok(mf, JSON.stringify(it.fields.map(x => x.id)));
    assert.match(mf.campaignText, /3/, mf.campaignText);
    assert.ok(!/photo:|\{/.test(mf.campaignText), '사람이 읽는 글자: ' + mf.campaignText);
    out = await R.reconcileSharedOrder({ workOrderId: M.w.id, picks: picksOf(it, () => 'order'), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await M.wo()).bidir_state, 'on');

    // ── R9 주말 제외 — 오더는 아직 안 정함 · 공고는 주말 포함(검토 ②) ──
    const K = await setup('k', async (camp) => {
      await pool.query(`UPDATE work_orders SET skip_weekends = NULL WHERE id = (SELECT source_work_order_id FROM recruit_campaigns WHERE id = $1)`, [camp]);
    });
    it = await K.item();
    assert.ok(it, '목록에 나온다');
    const kf = it.fields.find(x => x.id === 'skip_weekends');
    assert.ok(kf, JSON.stringify(it.fields.map(x => x.id)));
    assert.equal(kf.orderSide && kf.orderSide.ok, false, '오더 쪽(정하지 않음)은 공고로 못 옮긴다');
    assert.equal(kf.campaignSide.ok, true, JSON.stringify(kf.campaignSide));
    out = await R.reconcileSharedOrder({ workOrderId: K.w.id, picks: picksOf(it, () => 'order'), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 409); assert.equal(out.body.code, 'reconcile_order_side_locked');
    out = await R.reconcileSharedOrder({ workOrderId: K.w.id, picks: picksOf(it, () => 'campaign'), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    w = await K.wo();
    assert.equal(w.bidir_state, 'on'); assert.equal(w.skip_weekends, false, '공고 값(주말 포함)이 오더에 들어간다');

    // ── R10 줄 값은 같고 총모집만 다름 — 고를 칸 없이 맞춘다(검토 ③) ──
    const T = await setup('t', async (camp) => { await pool.query(`UPDATE recruit_campaigns SET recruit_total = 20 WHERE id = $1`, [camp]); });
    it = await T.item();
    assert.ok(it, '목록에 나온다');
    assert.ok(it.fields.length && it.fields.every(x => x.derived), JSON.stringify(it.fields.map(x => [x.id, x.derived])));
    out = await R.reconcileSharedOrder({ workOrderId: T.w.id, picks: {}, fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await T.wo()).bidir_state, 'on');
    assert.equal(Number((await T.cRow()).recruit_total), 17, '공고 총모집 = 줄 합(오더)');

    // ── R13 역방향으로만 이어진 공고(오더 쪽 연결 칸 비어 있음) — 목록에 나오고 맞춰진다(검토 ⑥) ──
    const V = await setup('v', async (camp) => {
      await pool.query(`UPDATE recruit_campaigns SET review_fee = 1500 WHERE id = $1`, [camp]);
      await pool.query(`UPDATE work_orders SET linked_campaign_id = NULL WHERE linked_campaign_id = $1`, [camp]);
    });
    it = await V.item();
    assert.ok(it, '역방향 짝도 목록에 나온다');
    assert.equal(it.campaignId, V.camp);
    out = await R.reconcileSharedOrder({ workOrderId: V.w.id, picks: picksOf(it, () => 'campaign'), fingerprint: it.fingerprint, actor: '시험' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(Number((await V.wo()).review_fee), 1500);

    // ── R6 HTTP — 관리자만 · 목록·해 보기·맞추기 ──
    const jwt = require('jsonwebtoken');
    const admin = { authorization: 'Bearer ' + jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET) };
    const staff = { authorization: 'Bearer ' + jwt.sign({ id: 'staff_t', role: 'staff', name: '시험AE' }, process.env.JWT_SECRET) };
    const F = await setup('f', async (camp) => { await pool.query(`UPDATE recruit_campaigns SET review_fee = 1500 WHERE id = $1`, [camp]); });
    let h = await call('GET', '/api/trackb/bidir/reconcile', null, staff);
    assert.equal(h.status, 403, 'AE 는 못 본다');
    h = await call('GET', '/api/trackb/bidir/reconcile', null, admin);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    const hi = h.body.items.find(x => x.workOrderId === F.w.id);
    assert.ok(hi);
    h = await call('POST', `/api/trackb/bidir/reconcile/${F.w.id}`, { picks: { review_fee: 'campaign' }, fingerprint: hi.fingerprint, dryRun: true }, admin);
    assert.equal(h.status, 200, JSON.stringify(h.body)); assert.equal(h.body.dryRun, true);
    h = await call('POST', `/api/trackb/bidir/reconcile/${F.w.id}`, { picks: { review_fee: 'campaign' }, fingerprint: hi.fingerprint }, staff);
    assert.equal(h.status, 403);
    h = await call('POST', `/api/trackb/bidir/reconcile/${F.w.id}`, { picks: { review_fee: 'campaign' }, fingerprint: hi.fingerprint }, admin);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.equal((await F.wo()).bidir_state, 'on');
    console.log('bidirReconcile: PG passed');
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value=$1 WHERE key='bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key='bidir_sync'`).catch(() => {});
    sw._resetBidirSwitchCacheForTest();
    const ids = (await pool.query('SELECT id FROM work_orders WHERE source_review_order_id = ANY($1)', [sids]).catch(() => ({ rows: [] }))).rows.map(r => r.id);
    await pool.query('DELETE FROM work_order_shared_snapshots WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM shared_sync_outbox WHERE work_order_id = ANY($1)', [ids]).catch(() => {});
    await pool.query('DELETE FROM campaign_applications WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_participants WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = ANY($2)', [SHEET, tabs]).catch(() => {});
    await pool.query('DELETE FROM campaign_fee_schedules WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_plan_events WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_option_price_history WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_option_alerts WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM campaign_options WHERE campaign_id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id = ANY($1)', [camps]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE id = ANY($1)', [ids]).catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pg();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('bidirReconcile: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
