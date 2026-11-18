'use strict';
/* 결정 379(사용자 확정 2026-11-17 「1+2까지만」) — Q&A 공고
 *   ① 모집인원 조절 창에서 빈 자리(신청·주문이 안 묶인 open 자리)를 날짜 사이로 옮긴다(moveQnaSlots · 총 자리 수 불변)
 *   ② 하루 기준 = 그날 자리 수 하나(날짜별 계획의 0명 휴무를 Q&A 에서는 판정에 쓰지 않는다)
 *  실제 서비스 + 실 SQL(PGlite · 저장소 migrations). 운영 사례(11/3더로우 Q/A 50건)를 본뜬 가상 자료 · 오늘 = 2026-11-16(월) 14:00 KST.
 *  M1 조절 창 재료: 날짜별 옮길 수 있는 빈 자리(movable) · 옮길 수 있는 날 범위 · 쉬는 날 · 오늘 마감 전 여부
 *  M2 11/03 못 채운 1 → 11/17(0명 계획 있음) · 자리·줄 날짜 · 기록 qna_move · 11/17 에 실제로 열림(②)
 *  M3 총 자리 수가 화면과 다르면 409(아무것도 안 옮김) · M4 그날 빈 자리 수가 바뀌었으면 409 · 입력 오류는 400 대
 *  M5 지난 날 · 마감 뒤 오늘 · 주말 제외 공고의 주말 · 오더 휴무일 = 거절 / 마감 전 오늘 = 가능(그날 바로 열림)
 *  M6 신청 중(유효 홀드)·제출된 자리는 옮기지 않는다
 *  M7 상품별 하루 건수: 다 찬 상품은 건너뛰고 들어갈 수 있는 상품을 고른다 · 하나라도 못 넣으면 전부 되돌림
 *  M8 일정 끝 결정(qna_extra)이 이미 있어도 옮길 수 있다
 *  M9 ② 오늘 0명 계획이 있어도 오늘부터 추가 모집 가능 · 내일부터는 0명 계획 날을 건너뛰지 않는다
 *  M10 ② 조절 창 저장: Q&A 공고에 날짜별 인원(set)은 막고(안내) 저장값 해제(remove)는 받는다
 *  M11 실제 라우트(/api/trackb/campaigns/:id/qna-move) — 내부 직원 게이트 · 200 은 조절 창 자료 동봉 · 409 그대로
 */
const assert = require('assert');
const F = require('./helpers/qnaExtraPgFixture');

(async () => {
  let PG;
  try { PG = await F.openDb(); } catch (e) { console.log('⏭ PGlite 없음 — 건너뜀: ' + e.message); process.exit(0); }
  const pool = F.poolOf(PG.db);
  F.injectPool(pool);
  const qs = require('../src/services/qnaSlots.service');
  const st = require('../src/services/campaignState.service');
  const se = require('../src/services/campaignSequentialEnd.service');
  const master = { name: '마스터', role: 'master' };
  const NOW = F.kst('2026-11-16', '14:00');
  let passed = 0;
  const failed = [];
  // 하나가 실패해도 나머지를 돌려 실패한 것을 모두 보인다(끝에서 실패 1개 이상 = exit 1)
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed.push(name); console.log('  ✗ ' + name + '\n      ' + String((e && e.message) || e).split('\n')[0]); }
  };
  const slotOf = async (seq = F.UNFILLED_SEQ) => (await pool.query(`SELECT id, unit_key, to_char(slot_date,'YYYY-MM-DD') d, round FROM qna_slots WHERE sheet_id=$1 AND seq=$2`, [F.SHEET, seq])).rows[0];
  const rowOf = async (seq = F.UNFILLED_SEQ) => (await pool.query(`SELECT start_date, row_json->>'진행일자' AS pd, updated_by FROM campaign_participants WHERE sheet_id=$1 AND seq=$2`, [F.SHEET, seq])).rows[0];
  const events = async () => (await pool.query(`SELECT action, actor, detail FROM campaign_plan_events WHERE campaign_id=$1 ORDER BY id`, [F.CAMP])).rows;
  const campRow = async () => (await pool.query('SELECT * FROM recruit_campaigns WHERE id=$1', [F.CAMP])).rows[0];
  const stateAt = async now => {
    const counts = (await st.fetchCampaignCounts(pool, [F.CAMP], now)).get(F.CAMP);
    return { s: st.computeCampaignState(await campRow(), counts, now, null), counts };
  };
  const view = async (now = NOW) => {
    const counts = (await st.fetchCampaignCounts(pool, [F.CAMP], now)).get(F.CAMP);
    return qs.qnaPlanView(pool, await campRow(), { admin: master, counts, now });
  };
  const move = (days, extra = {}) => qs.moveQnaSlots({ campaignId: F.CAMP, days, total: 50, actor: '망고', now: NOW, ...extra });
  /** 「from 에서 n개 빼고 to 에 n개 더하기」 = 날짜별 증감 두 줄(리뷰 반영 — 화면이 보내는 모양) · movable = 화면이 본 from 의 옮길 빈 자리 수 */
  const pair = (from, to, n = 1, movable = 1) => [{ date: from, n: -n, movable }, { date: to, n }];
  const code = c => e => { assert.equal(e.code, c, e.code + ' ' + e.message); return true; };
  const md = d => require('../src/utils/worktablePlan').businessDays({ count: 1, startDate: d, skipWeekends: false })[0].label;
  /* 두 번째 상품(B) 자리를 더 깐다 — 총 자리 수는 그만큼 늘어난다(이 시험에서만). unit_idx 0 · unit_seq 1 부터라 같은 날 A 보다 앞에 선다. */
  const addSlot = async ({ unit = 'B상품', date, seq, unitSeq, visibility = 'private' }) => {
    await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, start_date, row_json, active) VALUES ($1,$2,$3,$4,$5,true)`,
      [F.SHEET, F.TAB, seq, md(date), JSON.stringify({ 진행일자: md(date) })]);
    await pool.query(`INSERT INTO qna_slots (work_order_id, sheet_id, tab_name, seq, unit_key, product_name, unit_idx, unit_seq, slot_date, visibility)
                      VALUES ($1,$2,$3,$4,$5,$5,0,$6,$7::date,$8)`, [F.WO, F.SHEET, F.TAB, seq, unit, unitSeq, date, visibility]);
  };

  /** 자리표를 만든 원천(작업오더 상품별 하루 건수)을 바꾼다 — 기존 상품(A, 하루 8) + 추가 상품들 */
  const setUnits = async (extra = []) => {
    const list = [{ name: F.PRODUCT, product_mode: 'base', count: 50, daily: 8, options: [] }]
      .concat(extra.map(u => ({ name: u.name, product_mode: 'none', base: { count: u.count || 2, daily: u.daily }, options: [] })));
    await pool.query(`UPDATE work_orders SET product_options_json = $2 WHERE id = $1`, [F.WO, JSON.stringify(list)]);
  };
  const slotsOf = async unit => (await pool.query(
    `SELECT id, seq, unit_key, unit_seq, visibility, round, to_char(slot_date,'YYYY-MM-DD') AS slot_date FROM qna_slots WHERE sheet_id=$1 AND unit_key=$2 ORDER BY unit_seq`, [F.SHEET, unit])).rows;

  console.log('\n[결정 379 · Q&A 빈 자리 옮기기 · 하루 기준 = 자리 수 · 실 SQL]');

  await t('M1 조절 창 재료 — 11/03 옮길 빈 자리 1 · 범위 오늘~(마지막 날·오늘 중 늦은 날)+14 · 쉬는 날 · 오늘 마감 전', async () => {
    await F.seed(pool, { plans: { '2026-11-17': 0 } });
    const v = await view();
    assert.equal(v.days[0].date, '2026-11-03'); assert.equal(v.days[0].movable, 1); assert.equal(v.days[1].movable, 0);
    assert.ok(v.move, 'move 칸이 있어야 한다(새 서버)');
    assert.equal(v.move.from, '2026-11-16'); assert.equal(v.move.to, '2026-11-30');
    assert.deepEqual(v.move.closed, [], '주말 제외가 아닌 오더 = 쉬는 날 없음');
    assert.equal(v.move.today.ok, true);
    await F.seed(pool, { skipWeekends: true });
    const w = await view();
    assert.deepEqual(w.move.closed, ['2026-11-21', '2026-11-22', '2026-11-28', '2026-11-29']);
  });

  await t('M2 11/03 → 11/17(0명 계획 있음) 1개 — 자리·줄 날짜 · round 그대로 · 기록 qna_move · 11/17 에 실제로 열림', async () => {
    await F.seed(pool, { plans: { '2026-11-17': 0 } });
    const r = await move(pair('2026-11-03', '2026-11-17', 1, 1));
    assert.equal(r.ok, true); assert.equal(r.moved, 1);
    const sl = await slotOf();
    assert.equal(sl.d, '2026-11-17'); assert.equal(sl.round, 0, '옮기기는 추가 모집 회차가 아니다');
    const row = await rowOf();
    assert.equal(row.pd, '11 / 17 (화)'); assert.equal(row.start_date, '11 / 17 (화)'); assert.equal(row.updated_by, 'qna-move');
    const ev = await events();
    assert.equal(ev.length, 1); assert.equal(ev[0].action, 'qna_move'); assert.equal(ev[0].actor, '망고');
    assert.deepEqual(ev[0].detail.moves.map(m => [m.from, m.to, m.n]), [['2026-11-03', '2026-11-17', 1]]);
    assert.equal(ev[0].detail.total, 50);
    const d17 = await stateAt(F.kst('2026-11-17', '10:00'));
    assert.equal(d17.counts.qnaToday, 1);
    assert.equal(d17.s.dailyQuota, 1);
    assert.equal(d17.s.state, 'open', '0명 계획이 있어도 Q&A 는 그날 자리대로 열린다: ' + JSON.stringify(d17.s));
    assert.notEqual(d17.s.stateReason, 'rest_day');
    const v = await view();
    assert.equal(v.total, 50, '총 자리 수 불변');
  });

  await t('M3 총 자리 수가 화면과 다르면 409(qna_move_stale) · 아무것도 안 옮김 · 기록 없음', async () => {
    await F.seed(pool, {});
    await assert.rejects(move(pair('2026-11-03', '2026-11-17', 1, 1), { total: 49 }), code('qna_move_stale'));
    assert.equal((await slotOf()).d, '2026-11-03'); assert.equal((await events()).length, 0);
  });

  await t('M4 그날 빈 자리 수가 바뀌었으면 409 · 입력 오류(빈 목록·n>빈 자리·같은 날 빼고 더하기·날짜 형식)는 400 대', async () => {
    await F.seed(pool, {});
    await assert.rejects(move(pair('2026-11-03', '2026-11-17', 1, 2)), code('qna_move_stale'));
    await assert.rejects(move([]), code('qna_move_empty'));
    await assert.rejects(move(pair('2026-11-03', '2026-11-17', 2, 1)), code('qna_move_bad'));
    await assert.rejects(move([{ date: '2026-11-03', n: -1, movable: 1 }, { date: '2026-11-17', n: 1 }, { date: '2026-11-17', n: -1, movable: 0 }]), code('qna_move_bad'));
    await assert.rejects(move(pair('11/03', '2026-11-17', 1, 1)), code('qna_move_bad'));
    await assert.rejects(move(pair('2026-11-03', '2026-11-03', 1, 1)), code('qna_move_bad'));
    assert.equal((await slotOf()).d, '2026-11-03'); assert.equal((await events()).length, 0);
  });

  await t('M5 지난 날·마감 뒤 오늘·주말·오더 휴무일 = 거절 · 마감 전 오늘 = 옮겨지고 그날 바로 열림', async () => {
    await F.seed(pool, {});
    await assert.rejects(move(pair('2026-11-03', '2026-11-15', 1, 1)), code('qna_move_past'));
    await assert.rejects(move(pair('2026-11-03', '2026-11-16', 1, 1), { now: F.kst('2026-11-16', '23:55') }), code('qna_move_today'));
    // 잠금을 기다리는 사이 마감이 지나면 — 잠근 뒤 시각으로 거절(결정 377 리뷰 반영과 같은 규율)
    await assert.rejects(move(pair('2026-11-03', '2026-11-16', 1, 1),
      { now: new Date('2026-11-16T23:49:59+09:00'), clock: () => new Date('2026-11-16T23:50:01+09:00') }), code('qna_move_today'));
    await pool.query(`UPDATE work_orders SET holidays = '["2026-11-19"]' WHERE id = $1`, [F.WO]);
    await assert.rejects(move(pair('2026-11-03', '2026-11-19', 1, 1)), code('qna_move_closed_day'));
    assert.equal((await slotOf()).d, '2026-11-03'); assert.equal((await events()).length, 0);
    const ok = await move(pair('2026-11-03', '2026-11-16', 1, 1));
    assert.equal(ok.moved, 1); assert.equal((await slotOf()).d, '2026-11-16');
    const today = await stateAt(NOW);
    assert.equal(today.s.dailyQuota, 1); assert.equal(today.s.state, 'open', JSON.stringify(today.s));
    await F.seed(pool, { skipWeekends: true });
    await assert.rejects(move(pair('2026-11-03', '2026-11-21', 1, 1)), code('qna_move_closed_day'));
    assert.equal((await slotOf()).d, '2026-11-03');
  });

  await t('M6 신청 중(유효 홀드)인 빈 자리·제출된 자리는 옮기지 않는다', async () => {
    await F.seed(pool, {});
    const sl = await slotOf();
    await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, status, applied_at, expires_at, qna_slot_id)
                      VALUES ($1, '가짜신청', '01099990000', '99990000', 'applied', NOW(), NOW() + interval '1 hour', $2)`, [F.CAMP, sl.id]);
    const v = await view();
    assert.equal(v.days[0].open, 1, '남은 자리(신청 중 포함)는 1');
    assert.equal(v.days[0].movable, 0, '신청 중인 자리는 옮길 수 없다');
    await assert.rejects(move(pair('2026-11-03', '2026-11-17', 1, 1)), code('qna_move_stale'));
    await assert.rejects(move(pair('2026-11-04', '2026-11-17', 1, 1)), code('qna_move_stale'), '11/04 는 모두 제출된 자리');
    assert.equal((await slotOf()).d, '2026-11-03');
    // 홀드가 끝나(유예 지남) 풀린 자리는 다시 옮길 수 있다
    await pool.query(`UPDATE campaign_applications SET expires_at = NOW() - interval '1 hour' WHERE qna_slot_id = $1`, [sl.id]);
    assert.equal((await view()).days[0].movable, 1);
  });

  await t('M7 상품별 하루 건수 — 다 찬 상품은 건너뛰고 들어갈 상품을 고른다 · 못 넣으면 전부 되돌림(기록 없음)', async () => {
    /* 검사 의미 변경 — PR #1839 리뷰 반영(Codex P2): 하루 건수 = 오더 원천(B 하루 1건) · 고른 날짜 전체를 한꺼번에 배정.
       종전 「앞 이동 11/03→11/18 · 뒤 이동 11/20→11/21 2개 = 거절」은 이제 해가 있다(B→11/18 · A 2개→11/21) — 아래 ③에서 성공을 단언한다. */
    await F.seed(pool, {});
    await setUnits([{ name: 'B상품', daily: 1 }]);
    // B: 하루 1건(11/20·11/21 에 하나씩) · A(기존 상품): 하루 8건 · 11/20 에 A 빈 자리 1 더
    await addSlot({ date: '2026-11-20', seq: 200, unitSeq: 1 });
    await addSlot({ date: '2026-11-21', seq: 201, unitSeq: 2 });
    await addSlot({ unit: F.PRODUCT && (await slotOf()).unit_key, date: '2026-11-20', seq: 202, unitSeq: 51 });
    const total = (await view()).total;
    assert.equal(total, 53);
    // ① 11/03 1개 + 11/20 2개 → 11/21 3개: B 는 11/21 에 이미 하루 1건이라 들어갈 곳이 없다 → 해 없음 → 전부 되돌림
    await assert.rejects(move([{ date: '2026-11-03', n: -1, movable: 1 }, { date: '2026-11-20', n: -2, movable: 2 }, { date: '2026-11-21', n: 3 }], { total }),
      e => e.code === 'qna_move_no_room' && /들어갈 수 있는 수 2개/.test(e.message));
    assert.equal((await slotOf()).d, '2026-11-03', '들어갈 수 있던 자리도 되돌려졌다');
    assert.equal((await slotOf(200)).d, '2026-11-20'); assert.equal((await slotOf(202)).d, '2026-11-20');
    assert.equal((await events()).length, 0);
    // ② 1개만 옮기면 — B(앞 순서)는 11/21 에 자리가 없어 건너뛰고 A 를 옮긴다
    const r = await move(pair('2026-11-20', '2026-11-21', 1, 2), { total });
    assert.equal(r.moved, 1);
    assert.equal((await slotOf(202)).d, '2026-11-21', 'A 가 옮겨졌다');
    assert.equal((await slotOf(200)).d, '2026-11-20', 'B 는 그대로');
    // ③ 종전에 거절되던 조합(날짜 순 짝: 11/03→11/18 · 11/20→11/21) — 한꺼번에 배정하면 B→11/18 · A→11/21 로 된다
    await F.seed(pool, {});
    await setUnits([{ name: 'B상품', daily: 1 }]);
    await addSlot({ date: '2026-11-20', seq: 200, unitSeq: 1 });
    await addSlot({ date: '2026-11-21', seq: 201, unitSeq: 2 });
    await addSlot({ unit: (await slotOf()).unit_key, date: '2026-11-20', seq: 202, unitSeq: 51 });
    const ok = await move([{ date: '2026-11-03', n: -1, movable: 1 }, { date: '2026-11-20', n: -2, movable: 2 }, { date: '2026-11-18', n: 1 }, { date: '2026-11-21', n: 2 }], { total });
    assert.equal(ok.moved, 3);
    assert.equal((await slotOf(200)).d, '2026-11-18', 'B → 11/18');
    assert.equal((await slotOf()).d, '2026-11-21'); assert.equal((await slotOf(202)).d, '2026-11-21');
  });

  await t('M8 일정 끝 결정(qna_extra)이 이미 있어도 옮길 수 있다', async () => {
    await F.seed(pool, {});
    await pool.query(`INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, '망고', 'qna_extra', '{"end":"2026-11-12"}'::jsonb)`, [F.CAMP]);
    const r = await move(pair('2026-11-03', '2026-11-18', 1, 1));
    assert.equal(r.moved, 1); assert.equal((await slotOf()).d, '2026-11-18');
  });

  await t('M9 ② 오늘 0명 계획이 있어도 오늘부터 추가 모집 가능 · 내일부터는 0명 계획 날을 건너뛰지 않는다', async () => {
    await F.seed(pool, { plans: { '2026-11-16': 0, '2026-11-17': 0 } });
    const { items } = await se.listSequentialEnds(master, { now: NOW });
    const it = items.find(x => x.campaignId === F.CAMP);
    assert.equal(it.start.today.ok, true, JSON.stringify(it.start.today));
    assert.deepEqual(it.start.tomorrow.days, ['2026-11-17']);
    assert.deepEqual(it.start.tomorrow.skipped, []);
    const ok = await se.applySequentialEnds(master, [{ campaignId: F.CAMP, action: 'extra', end: '2026-11-12' }], { now: NOW });
    assert.ok(ok.results[0].ok, JSON.stringify(ok));
    assert.equal((await slotOf()).d, '2026-11-17');
    assert.deepEqual(ok.results[0].skipped, []);
    const d17 = await stateAt(F.kst('2026-11-17', '10:00'));
    assert.equal(d17.s.state, 'open', JSON.stringify(d17.s)); assert.equal(d17.s.dailyQuota, 1);
    assert.equal(d17.s.planAdjusted, false, 'Q&A 는 저장된 계획을 「조절됨」으로 보이지 않는다');
  });

  await t('M10 ② 조절 창 저장 — Q&A 공고의 날짜별 인원(set)은 막고 안내 · 저장값 해제(remove)는 받는다', async () => {
    await F.seed(pool, { plans: { '2099-01-06': 0 } });
    const cp = require('../src/services/campaignPlan.service');
    await assert.rejects(cp.savePlans(F.CAMP, { set: [{ date: '2099-01-07', count: 0 }], remove: [], clientMode: 'projection' }, '망고'),
      e => e.code === 'qna_plan_set' && /자리/.test(e.message));
    assert.equal((await pool.query(`SELECT 1 FROM campaign_daily_plans WHERE campaign_id=$1 AND plan_date='2099-01-07'`, [F.CAMP])).rows.length, 0);
    await cp.savePlans(F.CAMP, { set: [], remove: ['2099-01-06'], clientMode: 'projection' }, '망고');
    assert.equal((await pool.query(`SELECT 1 FROM campaign_daily_plans WHERE campaign_id=$1`, [F.CAMP])).rows.length, 0);
    // (savePlans 는 실제 시계를 쓴다 — 먼 앞날로 시험) 일반 공고는 종전대로 저장된다
    await cp.savePlans(F.CAMP_REVIEW, { set: [{ date: '2099-01-07', count: 0 }], remove: [], clientMode: 'projection' }, '망고');
    assert.equal((await pool.query(`SELECT 1 FROM campaign_daily_plans WHERE campaign_id=$1`, [F.CAMP_REVIEW])).rows.length, 1);
  });

  await t('M11 실제 라우트 — POST /campaigns/:id/qna-move · 내부 직원 게이트 · 200 은 조절 창 자료 동봉 · 409 그대로', async () => {
    await F.seed(pool, {});
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x@127.0.0.1:1/x';
    const router = require('../src/routes/trackB.routes');
    const layer = router.stack.find(l => l.route && l.route.path === '/campaigns/:id/qna-move' && l.route.methods.post);
    assert.ok(layer, '라우트가 있어야 한다');
    const names = layer.route.stack.map(s => s.name);
    assert.ok(names.includes('authMiddleware') && names.includes('internalMiddleware'), names.join(','));
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const call = body => new Promise((resolve, reject) => {
      const res = { _s: 200, status(c) { this._s = c; return this; }, json(b) { resolve({ s: this._s, b }); } };
      handler({ params: { id: F.CAMP }, body, admin: master }, res, reject);
    });
    const bad = await call({ days: pair('2026-11-03', '2099-01-05', 1, 1), total: 1 });
    assert.equal(bad.s, 409); assert.equal(bad.b.code, 'qna_move_stale'); assert.equal(bad.b.ok, false);
    const r = await call({ days: pair('2026-11-03', '2099-01-05', 1, 1), total: 50 });
    assert.equal(r.s, 200, JSON.stringify(r.b)); assert.equal(r.b.ok, true); assert.equal(r.b.moved, 1);
    assert.ok(r.b.qna && Array.isArray(r.b.qna.days), '조절 창을 다시 그릴 자료가 함께 온다');
    // 리뷰 반영 — 새 거절(시작일 전)도 500 으로 숨지 않고 422 + 안내
    await pool.query(`UPDATE recruit_campaigns SET start_date = '2099-01-10' WHERE id = $1`, [F.CAMP]);
    const early = await call({ days: pair('2099-01-05', '2099-01-06', 1, 1), total: 50 });
    assert.equal(early.s, 422, JSON.stringify(early.b)); assert.equal(early.b.code, 'qna_move_before_start');
  });

  /* ── PR #1839 리뷰 반영(Codex P2) ─────────────────────────────────────────────── */
  await t('R1 리뷰 P2① 상품별 하루 건수 = 자리표를 만든 원천(오더 상품별 하루 건수) — 옮겼다 되돌리기 가능 · 추가 모집 용량도 그대로', async () => {
    await F.seed(pool, {});
    await setUnits([{ name: 'B상품', daily: 2 }]);
    await addSlot({ date: '2026-11-20', seq: 200, unitSeq: 1 });
    await addSlot({ date: '2026-11-20', seq: 201, unitSeq: 2 });
    const total = (await view()).total;
    const a = await move(pair('2026-11-20', '2026-11-23', 1, 2), { total });
    assert.equal(a.moved, 1);
    // 종전: 남은 분포(하루 1)로 다시 재서 최대치가 1로 내려가 되돌리기가 qna_move_no_room 으로 막혔다
    const back = await move(pair('2026-11-23', '2026-11-20', 1, 1), { total });
    assert.equal(back.moved, 1, '옮긴 자리를 원래 날로 되돌릴 수 있어야 한다');
    assert.deepEqual((await slotsOf('B상품')).map(s => s.slot_date), ['2026-11-20', '2026-11-20']);
    // 한 번 더 흩은 뒤에도 추가 모집은 하루 2건(원천)으로 깐다 — 종전: 하루 1건으로 줄어 이틀이 됐다
    await move(pair('2026-11-20', '2026-11-23', 1, 2), { total });
    const wo = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [F.WO])).rows[0];
    const p = await qs.qnaExtraPlan(pool, { sheetId: F.SHEET, tabName: F.TAB, unfilled: await slotsOf('B상품') }, wo, { startDate: '2026-11-24' });
    assert.deepEqual(p.days, ['2026-11-24'], '하루 2건 = 하루에 다 들어간다');
  });

  await t('R2 리뷰 P2① 원천에 없는 상품(하루 건수 모름) = 옮기기·추가 모집 모두 거절(fail-closed · 아무것도 안 옮김)', async () => {
    await F.seed(pool, {});
    await addSlot({ unit: 'C상품', date: '2026-11-20', seq: 200, unitSeq: 1 });
    const total = (await view()).total;
    await assert.rejects(move(pair('2026-11-20', '2026-11-23', 1, 1), { total }), code('qna_move_capacity_unknown'));
    assert.equal((await slotOf(200)).d, '2026-11-20'); assert.equal((await events()).length, 0);
    const wo = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [F.WO])).rows[0];
    await assert.rejects(qs.qnaExtraPlan(pool, { sheetId: F.SHEET, tabName: F.TAB, unfilled: await slotsOf('C상품') }, wo, { startDate: '2026-11-24' }),
      code('qna_capacity_unknown'));
  });

  await t('R3 리뷰 P2③ 공고 시작일 전 날로는 못 옮김 · 미래 개시 공고의 「오늘」 = 거절(오늘 늦은 시각 개시는 종전대로 가능)', async () => {
    await F.seed(pool, {});
    await pool.query(`UPDATE recruit_campaigns SET start_date = '2026-11-18' WHERE id = $1`, [F.CAMP]);
    await assert.rejects(move(pair('2026-11-03', '2026-11-17', 1, 1)), code('qna_move_before_start'));
    await assert.rejects(move(pair('2026-11-03', '2026-11-16', 1, 1)), code('qna_move_before_start'));
    assert.equal((await slotOf()).d, '2026-11-03'); assert.equal((await events()).length, 0);
    const v = await view();
    assert.equal(v.move.start, '2026-11-18', '화면이 시작일 전 날의 [＋]를 잠글 재료');
    assert.equal(v.move.today.ok, false); assert.equal(v.move.today.code, 'not_started');
    const counts = (await st.fetchCampaignCounts(pool, [F.CAMP], NOW)).get(F.CAMP);
    const chk = qs.qnaTodayStartCheck(await campRow(), counts, NOW, { skipWeekends: false });
    assert.equal(chk.ok, false); assert.equal(chk.code, 'not_started');
    // 추가 모집 「오늘부터」도 같은 판정 — 미래 개시 공고는 오늘 다시 깔지 않는다
    await assert.rejects(qs.applyQnaEnd({ campaignId: F.CAMP, action: 'extra', end: '2026-11-12', start: 'today', actor: '망고', now: NOW }), code('today_not_started'));
    assert.equal((await slotOf()).d, '2026-11-03');
    const ok = await move(pair('2026-11-03', '2026-11-18', 1, 1));
    assert.equal(ok.moved, 1, '시작일 당일은 된다');
    // 오늘 시작 + 오늘 늦은 시각 개시(시간 preopen) = 오늘로 옮길 수 있다(종전 동작)
    await F.seed(pool, { windowStart: '18:00', windowEnd: '22:00' });
    await pool.query(`UPDATE recruit_campaigns SET start_date = '2026-11-16' WHERE id = $1`, [F.CAMP]);
    const s = await stateAt(NOW);
    assert.equal(s.s.state, 'preopen');
    const r = await move(pair('2026-11-03', '2026-11-16', 1, 1));
    assert.equal(r.moved, 1);
  });

  await t('R4 리뷰 P2② 날짜별 증감만 받아 서버가 한꺼번에 배정 — 날짜 순 짝짓기로는 안 되는 재배치(X·Y 하루 1건)도 된다', async () => {
    await F.seed(pool, {});
    await setUnits([{ name: 'X상품', daily: 1 }, { name: 'Y상품', daily: 1 }]);
    await addSlot({ unit: 'X상품', date: '2026-11-17', seq: 300, unitSeq: 1 });
    await addSlot({ unit: 'Y상품', date: '2026-11-18', seq: 301, unitSeq: 1 });
    await addSlot({ unit: 'X상품', date: '2026-11-19', seq: 302, unitSeq: 2 });
    await addSlot({ unit: 'Y상품', date: '2026-11-20', seq: 303, unitSeq: 2 });
    const total = (await view()).total;
    // 날짜 순 짝(11/17→11/19 · 11/18→11/20)은 X·Y 모두 받는 날에 이미 하루 1건 → 종전엔 qna_move_no_room
    const r = await qs.moveQnaSlots({ campaignId: F.CAMP, total, actor: '망고', now: NOW,
      days: [{ date: '2026-11-17', n: -1, movable: 1 }, { date: '2026-11-18', n: -1, movable: 1 }, { date: '2026-11-19', n: 1 }, { date: '2026-11-20', n: 1 }] });
    assert.equal(r.moved, 2);
    assert.equal((await slotOf(300)).d, '2026-11-20', 'X(11/17) → 11/20');
    assert.equal((await slotOf(301)).d, '2026-11-19', 'Y(11/18) → 11/19');
    const ev = (await events()).filter(e => e.action === 'qna_move');
    assert.deepEqual(ev[0].detail.moves.map(m => [m.from, m.to, m.n]), [['2026-11-17', '2026-11-20', 1], ['2026-11-18', '2026-11-19', 1]]);
    assert.deepEqual(r.moves.map(m => m.units), [[{ name: 'X상품', n: 1 }], [{ name: 'Y상품', n: 1 }]]);
  });

  await t('R5 리뷰 P2② 해가 여러 개면 비공개 → 상품 순서 → 상품 안 순번을 먼저 옮긴다 · 해가 없으면 전부 되돌림(들어갈 수 있는 수 안내)', async () => {
    await F.seed(pool, {});
    await setUnits([{ name: 'X상품', daily: 1 }, { name: 'Y상품', daily: 1 }]);
    // 11/20 에 X 공개 1 · X 비공개 1 · Y 비공개 1 — 1개만 빼서 11/23 으로 → 비공개 중 상품 순서(X 먼저 · unit_idx 같으면 순번)
    await addSlot({ unit: 'X상품', date: '2026-11-20', seq: 300, unitSeq: 1, visibility: 'public' });
    await addSlot({ unit: 'X상품', date: '2026-11-20', seq: 301, unitSeq: 2 });
    await addSlot({ unit: 'Y상품', date: '2026-11-20', seq: 302, unitSeq: 1 });
    await pool.query(`UPDATE qna_slots SET unit_idx = CASE unit_key WHEN 'X상품' THEN 1 ELSE 2 END WHERE unit_key IN ('X상품','Y상품')`);
    const total = (await view()).total;
    const r = await qs.moveQnaSlots({ campaignId: F.CAMP, total, actor: '망고', now: NOW, days: [{ date: '2026-11-20', n: -1, movable: 3 }, { date: '2026-11-23', n: 1 }] });
    assert.equal(r.moved, 1);
    assert.equal((await slotOf(301)).d, '2026-11-23', '비공개 X 가 먼저');
    assert.equal((await slotOf(300)).d, '2026-11-20'); assert.equal((await slotOf(302)).d, '2026-11-20');
    // 같은 요청을 다시 해도(11/20 에 X공개·Y 남음 · 11/23 에 X 1건) → 비공개 Y(X 는 11/23 에 하루 1건이 찼다)
    const r2 = await qs.moveQnaSlots({ campaignId: F.CAMP, total, actor: '망고', now: NOW, days: [{ date: '2026-11-20', n: -1, movable: 2 }, { date: '2026-11-23', n: 1 }] });
    assert.equal(r2.moved, 1); assert.equal((await slotOf(302)).d, '2026-11-23');
    // 이제 11/20 은 X 공개 1개뿐 · 11/23 은 X·Y 가 하루 1건씩 찼다 → 해 없음 → 전부 되돌림
    const before = (await events()).length;
    await assert.rejects(qs.moveQnaSlots({ campaignId: F.CAMP, total, actor: '망고', now: NOW, days: [{ date: '2026-11-20', n: -1, movable: 1 }, { date: '2026-11-23', n: 1 }] }),
      e => e.code === 'qna_move_no_room' && /들어갈 수 있는 수 0개/.test(e.message));
    assert.equal((await slotOf(300)).d, '2026-11-20'); assert.equal((await events()).length, before);
  });

  await t('R6 리뷰 P2② 요청 모양 검사 — 옛 짝 목록(moves)·합이 0 아님·0 증감·같은 날 두 번·빈 자리보다 많이 빼기·빼는 날 빈 자리 수 없음 = qna_move_bad/empty', async () => {
    await F.seed(pool, {});
    const call = (days, extra = {}) => qs.moveQnaSlots({ campaignId: F.CAMP, total: 50, actor: '망고', now: NOW, days, ...extra });
    await assert.rejects(qs.moveQnaSlots({ campaignId: F.CAMP, total: 50, now: NOW, moves: [{ from: '2026-11-03', to: '2026-11-17', n: 1, fromOpen: 1 }] }), code('qna_move_empty'));
    await assert.rejects(call([{ date: '2026-11-03', n: -1, movable: 1 }]), code('qna_move_bad'));
    await assert.rejects(call([{ date: '2026-11-03', n: -1, movable: 1 }, { date: '2026-11-17', n: 1 }, { date: '2026-11-18', n: 0 }]), code('qna_move_bad'));
    await assert.rejects(call([{ date: '2026-11-03', n: -1, movable: 1 }, { date: '2026-11-03', n: 1 }]), code('qna_move_bad'));
    await assert.rejects(call([{ date: '2026-11-03', n: -2, movable: 1 }, { date: '2026-11-17', n: 2 }]), code('qna_move_bad'));
    await assert.rejects(call([{ date: '2026-11-03', n: -1 }, { date: '2026-11-17', n: 1 }]), code('qna_move_bad'));
    assert.equal((await slotOf()).d, '2026-11-03'); assert.equal((await events()).length, 0);
  });

  await t('R7 리뷰 P2② 배정은 결정적(같은 입력 = 같은 결과) · 탐색 상한을 넘으면 거절(qna_move_too_big)', async () => {
    const S = (id, unit, vis = 'private') => ({ id, seq: id, unit_key: unit, unit_seq: id, visibility: vis });
    const input = () => ({
      cand: new Map([['2026-11-17', [S(1, 'X'), S(2, 'Y')]], ['2026-11-18', [S(3, 'Y'), S(4, 'X', 'public')]]]),
      froms: new Map([['2026-11-17', { need: 2 }], ['2026-11-18', { need: 1 }]]),
      tos: new Map([['2026-11-19', 2], ['2026-11-20', 1]]),
      occ: new Map([['2026-11-19|X', { n: 1, pub: 0 }]]),
      cap: new Map([['X', 1], ['Y', 2]]),
    });
    const a = qs._assignQnaMoves(input()), b = qs._assignQnaMoves(input());
    assert.equal(a.ok, true);
    const flat = r => r.plan.map(p => [p.slot.id, p.to]);
    assert.deepEqual(flat(a), flat(b));
    assert.deepEqual(flat(a).sort((x, y) => x[0] - y[0]), [[1, '2026-11-20'], [2, '2026-11-19'], [3, '2026-11-19']], '비공개 Y(3)를 공개 X(4)보다 먼저');
    assert.throws(() => qs._assignQnaMoves({ ...input(), budget: 5 }), code('qna_move_too_big'));
  });

  console.log(`\n${passed}개 통과` + (failed.length ? ` · ${failed.length}개 실패` : ''));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('✗', e && e.stack || e); process.exit(1); });
