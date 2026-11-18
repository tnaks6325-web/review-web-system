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
  const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
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
  const move = (moves, extra = {}) => qs.moveQnaSlots({ campaignId: F.CAMP, moves, total: 50, actor: '망고', now: NOW, ...extra });
  const code = c => e => { assert.equal(e.code, c, e.code + ' ' + e.message); return true; };
  const md = d => require('../src/utils/worktablePlan').businessDays({ count: 1, startDate: d, skipWeekends: false })[0].label;
  /* 두 번째 상품(B) 자리를 더 깐다 — 총 자리 수는 그만큼 늘어난다(이 시험에서만). unit_idx 0 · unit_seq 1 부터라 같은 날 A 보다 앞에 선다. */
  const addSlot = async ({ unit = 'B상품', date, seq, unitSeq, visibility = 'private' }) => {
    await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, start_date, row_json, active) VALUES ($1,$2,$3,$4,$5,true)`,
      [F.SHEET, F.TAB, seq, md(date), JSON.stringify({ 진행일자: md(date) })]);
    await pool.query(`INSERT INTO qna_slots (work_order_id, sheet_id, tab_name, seq, unit_key, product_name, unit_idx, unit_seq, slot_date, visibility)
                      VALUES ($1,$2,$3,$4,$5,$5,0,$6,$7::date,$8)`, [F.WO, F.SHEET, F.TAB, seq, unit, unitSeq, date, visibility]);
  };

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
    const r = await move([{ from: '2026-11-03', to: '2026-11-17', n: 1, fromOpen: 1 }]);
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
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-17', n: 1, fromOpen: 1 }], { total: 49 }), code('qna_move_stale'));
    assert.equal((await slotOf()).d, '2026-11-03'); assert.equal((await events()).length, 0);
  });

  await t('M4 그날 빈 자리 수가 바뀌었으면 409 · 입력 오류(빈 목록·n>빈 자리·같은 날 빼고 더하기·날짜 형식)는 400 대', async () => {
    await F.seed(pool, {});
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-17', n: 1, fromOpen: 2 }]), code('qna_move_stale'));
    await assert.rejects(move([]), code('qna_move_empty'));
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-17', n: 2, fromOpen: 1 }]), code('qna_move_bad'));
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-17', n: 1, fromOpen: 1 }, { from: '2026-11-17', to: '2026-11-18', n: 1, fromOpen: 0 }]), code('qna_move_bad'));
    await assert.rejects(move([{ from: '11/03', to: '2026-11-17', n: 1, fromOpen: 1 }]), code('qna_move_bad'));
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-03', n: 1, fromOpen: 1 }]), code('qna_move_bad'));
    assert.equal((await slotOf()).d, '2026-11-03'); assert.equal((await events()).length, 0);
  });

  await t('M5 지난 날·마감 뒤 오늘·주말·오더 휴무일 = 거절 · 마감 전 오늘 = 옮겨지고 그날 바로 열림', async () => {
    await F.seed(pool, {});
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-15', n: 1, fromOpen: 1 }]), code('qna_move_past'));
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-16', n: 1, fromOpen: 1 }], { now: F.kst('2026-11-16', '23:55') }), code('qna_move_today'));
    // 잠금을 기다리는 사이 마감이 지나면 — 잠근 뒤 시각으로 거절(결정 377 리뷰 반영과 같은 규율)
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-16', n: 1, fromOpen: 1 }],
      { now: new Date('2026-11-16T23:49:59+09:00'), clock: () => new Date('2026-11-16T23:50:01+09:00') }), code('qna_move_today'));
    await pool.query(`UPDATE work_orders SET holidays = '["2026-11-19"]' WHERE id = $1`, [F.WO]);
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-19', n: 1, fromOpen: 1 }]), code('qna_move_closed_day'));
    assert.equal((await slotOf()).d, '2026-11-03'); assert.equal((await events()).length, 0);
    const ok = await move([{ from: '2026-11-03', to: '2026-11-16', n: 1, fromOpen: 1 }]);
    assert.equal(ok.moved, 1); assert.equal((await slotOf()).d, '2026-11-16');
    const today = await stateAt(NOW);
    assert.equal(today.s.dailyQuota, 1); assert.equal(today.s.state, 'open', JSON.stringify(today.s));
    await F.seed(pool, { skipWeekends: true });
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-21', n: 1, fromOpen: 1 }]), code('qna_move_closed_day'));
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
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-17', n: 1, fromOpen: 1 }]), code('qna_move_stale'));
    await assert.rejects(move([{ from: '2026-11-04', to: '2026-11-17', n: 1, fromOpen: 1 }]), code('qna_move_stale'), '11/04 는 모두 제출된 자리');
    assert.equal((await slotOf()).d, '2026-11-03');
    // 홀드가 끝나(유예 지남) 풀린 자리는 다시 옮길 수 있다
    await pool.query(`UPDATE campaign_applications SET expires_at = NOW() - interval '1 hour' WHERE qna_slot_id = $1`, [sl.id]);
    assert.equal((await view()).days[0].movable, 1);
  });

  await t('M7 상품별 하루 건수 — 다 찬 상품은 건너뛰고 들어갈 상품을 고른다 · 못 넣으면 전부 되돌림(기록 없음)', async () => {
    await F.seed(pool, {});
    // B: 하루 1건(11/20·11/21 에 하나씩) · A(기존 상품): 하루 8건 · 11/20 에 A 빈 자리 1 더
    await addSlot({ date: '2026-11-20', seq: 200, unitSeq: 1 });
    await addSlot({ date: '2026-11-21', seq: 201, unitSeq: 2 });
    await addSlot({ unit: F.PRODUCT && (await slotOf()).unit_key, date: '2026-11-20', seq: 202, unitSeq: 51 });
    const total = (await view()).total;
    assert.equal(total, 53);
    // 앞 이동(11/03→11/18)은 되지만 뒤 이동(11/20→11/21 2개)은 B 가 11/21 에 이미 하루 1건이라 하나만 들어간다 → 전부 되돌림
    await assert.rejects(move([{ from: '2026-11-03', to: '2026-11-18', n: 1, fromOpen: 1 }, { from: '2026-11-20', to: '2026-11-21', n: 2, fromOpen: 2 }], { total }),
      code('qna_move_no_room'));
    assert.equal((await slotOf()).d, '2026-11-03', '앞 이동도 되돌려졌다');
    assert.equal((await slotOf(200)).d, '2026-11-20'); assert.equal((await slotOf(202)).d, '2026-11-20');
    assert.equal((await events()).length, 0);
    // 1개만 옮기면 — B(앞 순서)는 11/21 에 자리가 없어 건너뛰고 A 를 옮긴다
    const r = await move([{ from: '2026-11-20', to: '2026-11-21', n: 1, fromOpen: 2 }], { total });
    assert.equal(r.moved, 1);
    assert.equal((await slotOf(202)).d, '2026-11-21', 'A 가 옮겨졌다');
    assert.equal((await slotOf(200)).d, '2026-11-20', 'B 는 그대로');
  });

  await t('M8 일정 끝 결정(qna_extra)이 이미 있어도 옮길 수 있다', async () => {
    await F.seed(pool, {});
    await pool.query(`INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, '망고', 'qna_extra', '{"end":"2026-11-12"}'::jsonb)`, [F.CAMP]);
    const r = await move([{ from: '2026-11-03', to: '2026-11-18', n: 1, fromOpen: 1 }]);
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
    const bad = await call({ moves: [{ from: '2026-11-03', to: '2099-01-05', n: 1, fromOpen: 1 }], total: 1 });
    assert.equal(bad.s, 409); assert.equal(bad.b.code, 'qna_move_stale'); assert.equal(bad.b.ok, false);
    const r = await call({ moves: [{ from: '2026-11-03', to: '2099-01-05', n: 1, fromOpen: 1 }], total: 50 });
    assert.equal(r.s, 200, JSON.stringify(r.b)); assert.equal(r.b.ok, true); assert.equal(r.b.moved, 1);
    assert.ok(r.b.qna && Array.isArray(r.b.qna.days), '조절 창을 다시 그릴 자료가 함께 온다');
  });

  console.log(`\n${passed}개 통과`);
  process.exit(0);
})().catch(e => { console.error('✗', e && e.stack || e); process.exit(1); });
