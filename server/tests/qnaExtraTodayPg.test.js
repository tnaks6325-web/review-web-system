'use strict';
/* 결정 377 — Q&A 추가 모집 「오늘부터」 + 0명 휴무일 건너뛰기 + 조절 창 Q&A 재료. 실제 서비스 + 실 SQL(PGlite · 저장소 migrations).
 *  운영 사례(11/3더로우 Q/A 50건 — 자리표 11/03~11/12 · 못 채운 1)를 본뜬 가상 자료 · 오늘 = 2026-11-16(월) 14:00 KST.
 *  E1 팝업 목록: 오늘부터가 기본(마감 23:50 전) · 내일부터는 0명 휴무일(11/17)을 건너뛴 11/18
 *  E2 오늘부터 반영 → 자리·작업표 줄이 11/16 으로 · 오늘 정원 1 · 상태 open · 신청 자리 묶기 통과 · 다시 묻지 않음
 *  E3 마감(23:50) 뒤 = 오늘 선택지 막힘 · 오늘부터 반영 거절 · 아무것도 안 옮김(fail-closed)
 *  E4 오늘이 0명 휴무 = 오늘부터 거절 · 내일부터 = 휴무일 건너뜀 · 옛 화면(시작일 없음) = 내일부터
 *  E5 모르는 시작일 값 = 거절 · 시간창 공고는 창 끝 − 여유가 마감 · 주말 제외 공고의 토요일 = 오늘 불가
 *  E7 잠금 대기 중 마감이 지나면 잠근 뒤 시각으로 거절(현재 시각은 잠금 뒤에 읽는다)
 *  E6 조절 창 재료: Q&A 공고만 qna 칸(자리표 날짜별 자리 수 · 일정 끝 · 못 채운 1 · 정할 수 있음) · 일반 공고는 칸 없음
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
  const slotOf = async () => (await pool.query(`SELECT id, to_char(slot_date,'YYYY-MM-DD') d, round FROM qna_slots WHERE sheet_id=$1 AND seq=$2`, [F.SHEET, F.UNFILLED_SEQ])).rows[0];
  const rowOf = async () => (await pool.query(`SELECT start_date, row_json->>'진행일자' AS pd, updated_by FROM campaign_participants WHERE sheet_id=$1 AND seq=$2`, [F.SHEET, F.UNFILLED_SEQ])).rows[0];
  const stateAt = async now => {
    const counts = (await st.fetchCampaignCounts(pool, [F.CAMP], now)).get(F.CAMP);
    const c = (await pool.query('SELECT * FROM recruit_campaigns WHERE id=$1', [F.CAMP])).rows[0];
    return { s: st.computeCampaignState(c, counts, now, null), counts };
  };

  console.log('\n[결정 377 · Q&A 추가 모집 오늘부터 · 실 SQL]');

  await t('E1 팝업 목록 — 오늘부터가 기본(23:50 마감 전) · 내일부터는 0명 휴무 11/17 을 건너뛴 11/18', async () => {
    await F.seed(pool, { plans: { '2026-11-16': 1, '2026-11-17': 0 } });
    const { items } = await se.listSequentialEnds(master, { now: NOW });
    const it = items.find(x => x.campaignId === F.CAMP);
    assert.ok(it && it.kind === 'qna' && it.total === 1 && it.end === '2026-11-12', JSON.stringify(items));
    assert.ok(it.start, '시작일 선택지가 실려야 한다');
    assert.equal(it.start.default, 'today');
    assert.equal(it.start.today.ok, true);
    assert.equal(it.start.today.cutoffAt, F.kst('2026-11-16', '23:50').toISOString());
    assert.deepEqual(it.start.today.days, ['2026-11-16']);
    assert.deepEqual(it.start.tomorrow.days, ['2026-11-18']);
    assert.deepEqual(it.start.tomorrow.skipped, ['2026-11-17']);
    const before = await stateAt(NOW);
    assert.equal(before.s.dailyQuota, 0, '자리표가 끝나 오늘 정원 0(신고 상황 재현)');
  });

  await t('E2 오늘부터 반영 → 자리·줄 11/16 · 오늘 정원 1 · open · 신청 자리 묶기 통과 · 다시 묻지 않음', async () => {
    const r = await se.applySequentialEnds(master, [{ campaignId: F.CAMP, action: 'extra', end: '2026-11-12', start: 'today' }], { now: NOW });
    assert.ok(r.results[0].ok, JSON.stringify(r));
    assert.equal(r.results[0].moved, 1);
    assert.equal(r.results[0].from, '2026-11-16');
    const sl = await slotOf();
    assert.equal(sl.d, '2026-11-16'); assert.equal(sl.round, 1);
    const row = await rowOf();
    assert.equal(row.pd, '11 / 16 (월)'); assert.equal(row.start_date, '11 / 16 (월)'); assert.equal(row.updated_by, 'qna-extra');
    const ev = (await pool.query(`SELECT detail FROM campaign_plan_events WHERE campaign_id=$1 AND action='qna_extra'`, [F.CAMP])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].detail.start, 'today'); assert.equal(ev[0].detail.from, '2026-11-16');
    const after = await stateAt(NOW);
    assert.equal(after.counts.qnaToday, 1);
    assert.equal(after.s.dailyQuota, 1);
    assert.equal(after.s.state, 'open', JSON.stringify(after.s));
    // 신청 = 오늘 빈 자리 하나 묶기(campaign.routes 의 qna 신청이 부르는 함수 그대로)
    const client = await pool.connect();
    await client.query('BEGIN');
    const b = await qs.bindSlotForApply(client, { sheetId: F.SHEET, tabName: F.TAB, optKey: F.PRODUCT, now: NOW });
    await client.query('ROLLBACK');
    assert.ok(b && b.slot && b.slot.seq === F.UNFILLED_SEQ && b.slot.slot_date === '2026-11-16', JSON.stringify(b));
    const again = await se.listSequentialEnds(master, { now: NOW });
    assert.ok(!again.items.some(x => x.campaignId === F.CAMP), '반영 뒤에는 다시 묻지 않는다');
  });

  await t('E3 마감(23:50) 뒤 — 오늘 선택지 막힘 · 오늘부터 반영 거절 · 아무것도 안 옮김', async () => {
    await F.seed(pool, {});
    const late = F.kst('2026-11-16', '23:55');
    const { items } = await se.listSequentialEnds(master, { now: late });
    const it = items.find(x => x.campaignId === F.CAMP);
    assert.equal(it.start.today.ok, false); assert.equal(it.start.today.code, 'cutoff'); assert.equal(it.start.default, 'tomorrow');
    const r = await se.applySequentialEnds(master, [{ campaignId: F.CAMP, action: 'extra', end: '2026-11-12', start: 'today' }], { now: late });
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].error, /마감 시각/);
    assert.equal((await slotOf()).d, '2026-11-03');
    assert.equal((await rowOf()).pd, '11 / 3 (화)');
    assert.equal((await pool.query(`SELECT 1 FROM campaign_plan_events WHERE campaign_id=$1`, [F.CAMP])).rows.length, 0);
  });

  await t('E4 오늘 0명 휴무 = 오늘부터 거절 · 내일부터 = 휴무 11/17 건너뜀 → 11/18 · 옛 화면(시작일 없음)도 같은 길', async () => {
    await F.seed(pool, { plans: { '2026-11-16': 0, '2026-11-17': 0 } });
    const { items } = await se.listSequentialEnds(master, { now: NOW });
    const it = items.find(x => x.campaignId === F.CAMP);
    assert.equal(it.start.today.ok, false); assert.equal(it.start.today.code, 'rest_day'); assert.match(it.start.today.why, /기본으로/);
    const bad = await se.applySequentialEnds(master, [{ campaignId: F.CAMP, action: 'extra', end: '2026-11-12', start: 'today' }], { now: NOW });
    assert.equal(bad.results[0].ok, false); assert.equal((await slotOf()).d, '2026-11-03');
    const ok = await se.applySequentialEnds(master, [{ campaignId: F.CAMP, action: 'extra', end: '2026-11-12' }], { now: NOW });   // 옛 화면 = start 없음
    assert.ok(ok.results[0].ok, JSON.stringify(ok));
    assert.equal((await slotOf()).d, '2026-11-18');
    assert.deepEqual(ok.results[0].skipped, ['2026-11-17']);
    const ev = (await pool.query(`SELECT detail FROM campaign_plan_events WHERE campaign_id=$1 AND action='qna_extra'`, [F.CAMP])).rows[0].detail;
    assert.equal(ev.start, 'tomorrow'); assert.deepEqual(ev.skipped, ['2026-11-17']);
    // 11/18 이 오면 그 자리가 실제로 열린다(휴무로 닫히지 않는다)
    const d18 = await stateAt(F.kst('2026-11-18', '10:00'));
    assert.equal(d18.s.dailyQuota, 1); assert.equal(d18.s.state, 'open', JSON.stringify(d18.s));
  });

  await t('E5 모르는 시작일 = 거절 · 시간창 공고는 창 끝 − 여유가 마감 · 주말 제외 공고의 토요일 = 오늘 불가', async () => {
    await F.seed(pool, {});
    await assert.rejects(qs.applyQnaEnd({ campaignId: F.CAMP, action: 'extra', end: '2026-11-12', start: 'yesterday', now: NOW }), e => e.code === 'bad_start');
    assert.equal((await slotOf()).d, '2026-11-03');
    await F.seed(pool, { windowStart: '10:00', windowEnd: '18:00' });
    const c = (await pool.query('SELECT * FROM recruit_campaigns WHERE id=$1', [F.CAMP])).rows[0];
    const counts = (await st.fetchCampaignCounts(pool, [F.CAMP], NOW)).get(F.CAMP);
    const ok = qs.qnaTodayStartCheck(c, counts, F.kst('2026-11-16', '14:00'), { skipWeekends: false });
    assert.equal(ok.ok, true); assert.equal(ok.cutoffAt, F.kst('2026-11-16', '17:50').toISOString());
    const late = qs.qnaTodayStartCheck(c, counts, F.kst('2026-11-16', '17:55'), { skipWeekends: false });
    assert.equal(late.ok, false); assert.equal(late.code, 'cutoff');
    const early = qs.qnaTodayStartCheck(c, counts, F.kst('2026-11-16', '08:00'), { skipWeekends: false });
    assert.equal(early.ok, true, '시간창 시작 전(오늘 아직 안 열림)은 오늘부터 가능');
    const sat = qs.qnaTodayStartCheck({ ...c, window_start: null, window_end: null }, counts, F.kst('2026-11-21', '14:00'), { skipWeekends: true });
    assert.equal(sat.ok, false); assert.equal(sat.code, 'not_business_day');
    const unknown = qs.qnaTodayStartCheck(c, { ...counts, qnaToday: undefined }, NOW, { skipWeekends: false });
    assert.equal(unknown.ok, false, '오늘 자리 수를 모르면 열지 않는다(fail-closed)');
  });

  await t('E6 조절 창 재료 — Q&A 공고만 qna 칸(자리표 10일 · 끝남 · 못 채운 1 · 정할 수 있음) · 일반 공고는 칸 없음', async () => {
    await F.seed(pool, { plans: { '2026-11-16': 1, '2026-11-17': 0 } });
    const v = await qs.qnaPlanView(pool, { id: F.CAMP, linked_sheet_id: F.SHEET, linked_tab_name: F.TAB }, { admin: master, now: NOW });
    assert.equal(v.days.length, 10); assert.equal(v.total, 50); assert.equal(v.filled, 49);
    assert.equal(v.first, '2026-11-03'); assert.equal(v.last, '2026-11-12'); assert.equal(v.ended, true);
    assert.equal(v.days[0].open, 1, '11/03 에 못 채운 자리 1');
    assert.ok(v.extra && v.extra.total === 1 && v.extra.canDecide === true && v.extra.start && v.extra.start.default === 'today', JSON.stringify(v.extra));
    const other = await qs.qnaPlanView(pool, { id: F.CAMP, linked_sheet_id: F.SHEET, linked_tab_name: F.TAB }, { admin: { name: '다른직원', role: 'admin' }, now: NOW });
    assert.equal(other.extra.canDecide, false, '받는 사람이 아니면 팝업에서 정할 수 없다(막다른 버튼 금지)');
    // 실제 조절 창 조회(getPlanOverview) — Q&A 공고는 qna 칸, 일반 공고는 칸 자체가 없다(종전 응답 그대로)
    const cp = require('../src/services/campaignPlan.service');
    const ov = await cp.getPlanOverview(F.CAMP, { admin: master });
    assert.ok(ov.qna && Array.isArray(ov.qna.days) && ov.qna.days.length === 10, JSON.stringify(ov.qna));
    const ovR = await cp.getPlanOverview(F.CAMP_REVIEW, { admin: master });
    assert.ok(!('qna' in ovR), '일반 공고 응답에는 qna 칸이 없다');
  });

  await t('E7 잠금을 기다리는 사이 마감이 지나면 — 잠근 뒤 시각으로 다시 재서 거절 · 아무것도 안 옮김(Codex 리뷰 P2)', async () => {
    await F.seed(pool, {});
    // 들어올 때는 23:49:59(마감 전) · 잠금을 얻은 뒤 시계는 23:50:01(마감 뒤)
    const r = qs.applyQnaEnd({ campaignId: F.CAMP, action: 'extra', end: '2026-11-12', start: 'today',
      now: new Date('2026-11-16T23:49:59+09:00'), clock: () => new Date('2026-11-16T23:50:01+09:00') });
    await assert.rejects(r, e => e.code === 'today_cutoff');
    assert.equal((await slotOf()).d, '2026-11-03');
    assert.equal((await rowOf()).pd, '11 / 3 (화)');
    assert.equal((await pool.query(`SELECT 1 FROM campaign_plan_events WHERE campaign_id=$1`, [F.CAMP])).rows.length, 0);
  });

  console.log(`\n${passed}개 통과`);
})().catch(e => { console.error('✗', e && e.stack || e); process.exit(1); });
