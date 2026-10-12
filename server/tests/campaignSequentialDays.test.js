/**
 * campaignSequentialDays.test.js — 결정 228 (2026-10-12 제주도아 30건 · 사용자 확정)
 *
 * 순차진행 = 상품마다 「정원 ÷ 상품 하루 건수」일을 상품 순서대로 깐 날짜별 일정표. 그날은 그날 상품만, 그 상품 하루 건수만큼.
 * 못 채운 건은 넘기지 않고 정규 일정 끝에 담당자가 정한다. [📅 인원] 0명 = 쉬는 날(밀림) · 줄이기 = 두 번 확인 · 늘리기 = 막음.
 * 고정:
 *   [1] 일정표(순수) — 제주도아 실제 일정 · 0명 밀림 · 줄여 받기(몫 소진) · 주말·공휴일 · 추가 모집 이어 붙이기 · 못 만들면 null
 *   [2] 선택지 뷰 — 오늘 상품만 열림(그 상품 하루 건수) · 나머지 대기+여는 날 · 오늘 몫 소진 · 쉬는 날 전부 대기 · boolean = 212 그대로
 *   [3] 오늘 정원 = 오늘 상품 몫(공고 하루 인원·이월 무시) · 상품 남은 정원으로 자름
 *   [4] 앞날 예상 = 일정표(상품 실어) · 끝에서 멈춤 · 상품 남은 정원으로 자름
 *   [5] 작업표 날짜 맞추기 — 그날 상품 줄을 그날로(상품 없는 줄 → 다른 상품 줄 순) · 순차 아니면 종전
 *   [6] 배선 — 호출부가 일정표를 넘긴다 · [📅 인원] 저장 검사 · 정규 일정 끝 팝업 · 화면 문구 · 두 번 확인
 * 실행: node tests/campaignSequentialDays.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, n = 0;
const ok = (msg, cond) => { n++; if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };

const { buildSequentialSchedule, nextDateFor } = require('../src/utils/sequentialSchedule');
const { closedKindOn } = require('../src/services/campaignWeekend.service');
const CS = require('../src/services/campaignState.service');

const OPTS = [
  { optKey: '은갈치', recruitTotal: 10, dailyLimit: 5 },
  { optKey: '옥돔', recruitTotal: 5, dailyLimit: 5 },
  { optKey: '고등어', recruitTotal: 15, dailyLimit: 5 },
];
const camp = { skip_weekends: true };
const sched = (extra = {}) => buildSequentialSchedule({ startDate: '2026-10-08', options: OPTS,
  isClosedDay: d => !!closedKindOn(camp, d, extra.plans || null), ...extra });
const flat = s => s.days.map(d => `${d.date.slice(5)}:${d.optKey}${d.amount}`).join(' ');

(async () => {
  console.log('[1] 일정표');
  {
    const s = sched();
    ok('★ 제주도아 업체 일정 그대로(한글날·주말 건너뜀)', flat(s) === '10-08:은갈치5 10-12:은갈치5 10-13:옥돔5 10-14:고등어5 10-15:고등어5 10-16:고등어5' && s.regularEnd === '2026-10-16');
    const z = sched({ plans: { '2026-10-14': 0 } });
    ok('★ 0명 = 쉬는 날 → 뒤 일정이 하루씩 밀린다(고등어 10/19 끝)', flat(z) === '10-08:은갈치5 10-12:은갈치5 10-13:옥돔5 10-15:고등어5 10-16:고등어5 10-19:고등어5');
    const r = sched({ plans: { '2026-10-13': 3 } });
    const d13 = r.byDate.get('2026-10-13');
    ok('★ 줄여 받기 = 그날 3건 · 몫은 소진(다음 날 바로 고등어 · 끝나는 날 그대로)', d13.amount === 3 && d13.base === 5 && d13.reduced && r.byDate.get('2026-10-14').optKey === '고등어' && r.regularEnd === '2026-10-16');
    const o = sched({ plans: { '2026-10-13': 8 } });
    ok('더 큰 옛 계획은 몫으로 자른다(저장 검사가 막지만 남은 값 방어)', o.byDate.get('2026-10-13').amount === 5);
    const e = sched({ extras: [{ after: '2026-10-19', shortages: [{ optKey: '은갈치', n: 2 }, { optKey: '고등어', n: 1 }] }] });
    ok('★ 추가 모집 = 결정한 날 다음 영업일부터 같은 순서로 이어 붙임', flat(e).endsWith('10-20:은갈치2 10-21:고등어1') && e.regularEnd === '2026-10-16' && e.end === '2026-10-21'
      && e.byDate.get('2026-10-20').extra === true);
    const odd = buildSequentialSchedule({ startDate: '2026-10-12', options: [{ optKey: 'A', recruitTotal: 7, dailyLimit: 3 }], isClosedDay: () => false });
    ok('나머지는 마지막 날 남은 건수(7 = 3·3·1)', flat(odd) === '10-12:A3 10-13:A3 10-14:A1');
    ok('★ 못 만들면 null — 시작일 없음 · 하루 건수 0 · 정원 0 · 상품 없음',
      buildSequentialSchedule({ startDate: null, options: OPTS }) === null
      && buildSequentialSchedule({ startDate: '2026-10-08', options: [{ optKey: 'A', recruitTotal: 5, dailyLimit: 0 }] }) === null
      && buildSequentialSchedule({ startDate: '2026-10-08', options: [{ optKey: 'A', recruitTotal: 0, dailyLimit: 5 }] }) === null
      && buildSequentialSchedule({ startDate: '2026-10-08', options: [] }) === null);
    ok('날마다 닫혀도 무한 반복 없이 null', buildSequentialSchedule({ startDate: '2026-10-08', options: OPTS, isClosedDay: () => true }) === null);
    ok('상품이 처음/다음에 열리는 날', nextDateFor(s, '고등어', '2026-10-12') === '2026-10-14' && nextDateFor(s, '은갈치', '2026-10-13') === null);
  }

  console.log('[1-b] 레드팀 반영 — 지난 날 고정 · 마감 상품 · 하루 건수 빈 상품');
  {
    const fz = [{ date: '2026-10-08', optKey: '은갈치', base: 5, amount: 5, idx: 0 }, { date: '2026-10-12', optKey: '은갈치', base: 5, amount: 5, idx: 0 }];
    const closedG = [{ ...OPTS[0], closed: true }, OPTS[1], OPTS[2]];
    const a = buildSequentialSchedule({ startDate: '2026-10-08', options: closedG, isClosedDay: d => !!closedKindOn(camp, d), frozen: fz });
    ok('★ P0-1: 다 팔린 은갈치를 마감해도 지난 날이 당겨지지 않는다(10/13 옥돔)', flat(a) === '10-08:은갈치5 10-12:은갈치5 10-13:옥돔5 10-14:고등어5 10-15:고등어5 10-16:고등어5');
    const noFz = buildSequentialSchedule({ startDate: '2026-10-08', options: closedG, isClosedDay: d => !!closedKindOn(camp, d) });
    ok('★ 고정 기록이 없어도 마감 상품은 자기 날짜를 차지한다(오늘 은갈치를 마감해도 오늘 옥돔이 열리지 않는다)', flat(noFz) === flat(sched()));
    const closedO = buildSequentialSchedule({ startDate: '2026-10-08', options: [OPTS[0], { ...OPTS[1], closed: true }, OPTS[2]], isClosedDay: d => !!closedKindOn(camp, d) });
    ok('★ 옥돔을 마감(품절)해도 고등어가 당겨지지 않는다(10/13 = 옥돔 날 그대로 · 팔 상품 없음)', closedO.byDate.get('2026-10-13').optKey === '옥돔' && closedO.byDate.get('2026-10-14').optKey === '고등어');
    const vClosed = CS.computeOptionViews([{ opt_key: '은갈치', recruit_total: 10, daily_limit: 5, status: 'active' }, { opt_key: '옥돔', recruit_total: 5, daily_limit: 5, status: 'closed' }, { opt_key: '고등어', recruit_total: 15, daily_limit: 5, status: 'active' }],
      new Map([['은갈치', { submitted: 10 }]]), { state: 'open' }, { sequential: closedO, today: '2026-10-13' });
    const capsC = CS.optionCapsFromViews(vClosed);
    ok('마감 상품의 날 = 아무것도 고를 수 없고 오늘 정원 0', !vClosed.some(v => v.selectable) && capsC.sequentialDayRoom === 0);
    const junk = buildSequentialSchedule({ startDate: '2026-10-08', options: [{ optKey: '옛행', recruitTotal: 0, dailyLimit: 0, closed: true }, ...OPTS], isClosedDay: d => !!closedKindOn(camp, d) });
    ok('정원·하루 건수가 없는 옛 마감 행은 순서에서 뺀다', flat(junk) === flat(sched()));
    const grown = [{ optKey: '은갈치', recruitTotal: 15, dailyLimit: 5 }, { optKey: '옥돔', recruitTotal: 5, dailyLimit: 5 }, { optKey: '고등어', recruitTotal: 15, dailyLimit: 5 }];
    const fz2 = [...fz, { date: '2026-10-13', optKey: '옥돔', base: 5, amount: 5, idx: 1 }];
    const b2 = buildSequentialSchedule({ startDate: '2026-10-08', options: grown, isClosedDay: d => !!closedKindOn(camp, d), frozen: fz2 });
    ok('★ P0-2: 고정 뒤에는 마지막 고정 상품부터 — 앞 상품(은갈치)이 정원이 늘어도 다시 열리지 않는다', b2.byDate.get('2026-10-14').optKey === '고등어' && !b2.days.some(d => d.date > '2026-10-13' && d.optKey === '은갈치'));
    const renamed = buildSequentialSchedule({ startDate: '2026-10-08', options: [{ optKey: '은갈치(새이름)', recruitTotal: 10, dailyLimit: 5 }, OPTS[1], OPTS[2]],
      isClosedDay: d => !!closedKindOn(camp, d), frozen: fz });
    ok('★ 고정된 상품 이름이 바뀌어도 기록된 순번으로 같은 상품으로 본다(끝난 은갈치가 새 이름으로 다시 열리지 않는다)', renamed.byDate.get('2026-10-13').optKey === '옥돔');
  }

  console.log('[2] 선택지 뷰');
  const rows = [
    { opt_key: '은갈치', recruit_total: 10, daily_limit: 5, status: 'active' },
    { opt_key: '옥돔', recruit_total: 5, daily_limit: 5, status: 'active' },
    { opt_key: '고등어', recruit_total: 15, daily_limit: 5, status: 'active' },
  ];
  const cnt = m => new Map(Object.entries(m));
  const s = sched();
  {
    const v = CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 10 } }), { state: 'open' }, { sequential: s, today: '2026-10-13' });
    const [g, o, m] = v;
    ok('★ 오늘(10/13) = 옥돔만 열림 · 그 상품 하루 건수(5)', o.status === 'open' && o.selectable && o.dailyLimit === 5 && o.todayRemaining === 5 && o.sequenceCurrent === true);
    ok('★ 고등어 = 대기 · 10/14 시작', m.status === 'waiting' && !m.selectable && m.opensOn === '2026-10-14');
    ok('은갈치 = 정원 소진', g.status === 'soldout');
    ok('일정표를 뷰에 실어 하루 몫 재료가 같은 표를 본다', v.sequentialSchedule === s);
  }
  {
    const v = CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 5 } }), { state: 'open' }, { sequential: s, today: '2026-10-13' });
    ok('★ 은갈치가 덜 팔렸어도(5/10) 10/13 은 옥돔 날 — 은갈치는 대기(추가 모집 결정 대기 · 여는 날 없음)', v[1].status === 'open' && v[0].status === 'waiting' && v[0].opensOn === null);
  }
  {
    const v = CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 10 }, '옥돔': { submitted: 5 }, '고등어': { todaySubmitted: 3, submitted: 3, todayActiveHolds: 2, activeHolds: 2 } }), { state: 'open' }, { sequential: s, today: '2026-10-14' });
    ok('★ 오늘 몫(5)을 홀드 포함 다 받으면 오늘 마감(다음 고등어 날 10/15) — 남은 정원(10)이 있어도 더 열지 않는다', v[2].status === 'today_done' && v[2].todayRemaining === 0 && v[2].remaining === 10 && v[2].opensOn === '2026-10-15');
  }
  {
    const v = CS.computeOptionViews(rows, cnt({}), { state: 'open' }, { sequential: s, today: '2026-10-10' });
    ok('쉬는 날(토요일) = 열린 상품 없음 · 전부 대기', v.every(x => x.status === 'waiting' && !x.selectable) && !v.some(x => x.sequenceCurrent));
  }
  {
    const v = CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 9 } }), { state: 'open' }, { sequential: s, today: '2026-10-12' });
    ok('오늘 상품 남은 정원이 하루 건수보다 적으면 남은 정원까지(1)', v[0].todayRemaining === 1 && v[0].status === 'open');
  }
  {
    const v = CS.computeOptionViews(rows, cnt({}), { state: 'closed' }, { sequential: s, today: '2026-10-13' });
    ok('공고가 닫혀 있으면 오늘 상품도 고를 수 없다', v[1].status === 'open' && v[1].selectable === false);
  }
  {
    const v = CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 5 } }), { state: 'open' }, { sequential: true });
    ok('★ 일정표 없이 true 만 오면 결정 212 규칙 그대로(앞 상품이 차야 다음)', v[0].status === 'open' && v[0].sequenceCurrent && v[1].status === 'waiting' && !v[0].seqDays);
  }

  {
    const v = CS.computeOptionViews(rows, cnt({}), { state: 'open' }, { sequential: s, today: '2026-10-10' });
    ok('★ P2-10: 쉬는 날엔 다음으로 열릴 상품을 표시용으로만(고를 수 없음 · 하루 몫 재료 아님)', v.find(x => x.sequenceNext) && v.find(x => x.sequenceNext).optKey === '은갈치' && !v.some(x => x.selectable));
    const { sequentialDisplay } = require('../src/utils/sequentialDisplay');
    const d = sequentialDisplay({ title: '빈))) 상품', thumbnailUrl: '' }, v.map(x => ({ ...x, productName: x.optKey })));
    ok('제목·사진이 첫 상품으로 돌아가지 않고 다음 상품을 쓴다', d !== null);
    const one = CS.computeOptionViews([rows[2]], cnt({}), { state: 'open' }, { sequential: s, today: '2026-10-14' });
    ok('★ 살아 있는 상품이 하나뿐인 목록이어도 일정표를 따른다(하루 몫 재료가 마감 행을 뺀 목록)', one[0].seqDays === true && one[0].dailyLimit === 5);
  }

  console.log('[3] 오늘 정원');
  {
    const views = CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 10 } }), null, { sequential: s, today: '2026-10-13' });
    const caps = CS.optionCapsFromViews(views);
    ok('하루 몫 재료 = 오늘 상품 하나 · 몫 5', caps.length === 1 && caps[0].key === '옥돔' && caps.sequentialDayRoom === 5 && CS.optionDayCapacity(caps) === 5);
    const restCaps = CS.optionCapsFromViews(CS.computeOptionViews(rows, cnt({}), null, { sequential: s, today: '2026-10-10' }));
    ok('★ 쉬는 날 = 몫 0(상한 없음 null 로 접지 않는다)', restCaps.sequentialDayRoom === 0 && CS.optionDayCapacity(restCaps) === 0);
    const c = { participation_mode: true, status: 'active', daily_limit: 15, recruit_total: 30, window_start: '00:00', window_end: '23:59',
      start_date: '2026-10-08', carry_mode: 'auto', carry_strategy: 'next' };
    const counts = { submittedAll: 10, submittedBeforeToday: 10, activeHolds: 0, todaySubmitted: 0, todayActiveHolds: 0,
      carry: { startDate: '2026-10-01', submittedSince: 10, today: '2026-10-13' }, plans: null, optionCaps: caps };
    const st = CS.computeCampaignState(c, counts, new Date('2026-10-13T05:00:00Z'), null);
    ok('★ 공고 하루 인원 15·이월이 있어도 오늘 정원 = 오늘 상품 몫 5', st.dailyQuota === 5);
    const caps2 = CS.optionCapsFromViews(CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 10 }, '옥돔': { submitted: 4 } }), null, { sequential: s, today: '2026-10-13' }));
    const st2 = CS.computeCampaignState(c, { ...counts, optionCaps: caps2 }, new Date('2026-10-13T05:00:00Z'), null);
    ok('상품 남은 정원으로 자른다(옥돔 4/5 팔림 → 오늘 1)', st2.dailyQuota === 1);
    const caps4 = CS.optionCapsFromViews(CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 12, todaySubmitted: 2 } }), null, { sequential: s, today: '2026-10-13' }));
    const st4 = CS.computeCampaignState(c, { ...counts, optionCaps: caps4, todaySubmitted: 2 }, new Date('2026-10-13T05:00:00Z'), null);
    ok('★ P2-4: 오늘 들어온 다른 상품 주문(지각 2)은 오늘 상품 자리를 깎지 않는다(정원 5+2)', caps4.sequentialOthersToday === 2 && st4.dailyQuota === 7);
    ok('일정표 공고엔 "+N 이월" 표시가 없다', st.carryAdded === 0);
    const st3 = CS.computeCampaignState({ ...c, daily_limit: 3, carry_strategy: 'extend' }, { ...counts, carry: null }, new Date('2026-10-13T05:00:00Z'), null);
    ok('★ 공고 하루 인원이 상품 하루 건수보다 작아도(3) 오늘 정원 = 상품 몫 5(공고 하루 인원을 쓰지 않는다)', st3.dailyQuota === 5);
  }

  console.log('[4] 앞날 예상');
  {
    const views = CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 10 } }), null, { sequential: s, today: '2026-10-13' });
    const caps = CS.optionCapsFromViews(views);
    const c = { participation_mode: true, status: 'active', daily_limit: 15, recruit_total: 30, window_start: '00:00', window_end: '23:59', start_date: '2026-10-08', skip_weekends: true };
    const counts = { submittedAll: 10, submittedBeforeToday: 10, activeHolds: 0, todaySubmitted: 0, todayActiveHolds: 0, plans: null, optionCaps: caps };
    const pj = CS.projectDailyQuotas(c, counts, { now: new Date('2026-10-13T01:00:00Z') });
    const open = pj.days.filter(d => d.quota > 0).map(d => `${d.date.slice(5)}:${d.optKey}${d.quota}`).join(' ');
    ok('★ 앞날 = 일정표 그대로(상품 실어)', open === '10-13:옥돔5 10-14:고등어5 10-15:고등어5 10-16:고등어5' && pj.endDate === '2026-10-16');
    ok('★ 일정표 끝에서 멈춘다(넘겨 받지 않는다)', pj.days[pj.days.length - 1].date === '2026-10-16' && pj.sequential && pj.sequential.end === '2026-10-16');
    const pjBig = CS.projectDailyQuotas({ ...c, recruit_total: 100 }, counts, { now: new Date('2026-10-13T01:00:00Z') });
    ok('★ 총원이 넉넉해도(100) 일정표 끝(10/16)에서 멈춘다 — 모자란 건 담당자 결정', pjBig.days[pjBig.days.length - 1].date === '2026-10-16' && pjBig.endDate === '2026-10-16');
    const caps3 = CS.optionCapsFromViews(CS.computeOptionViews(rows, cnt({ '은갈치': { submitted: 10 }, '고등어': { submitted: 12 } }), null, { sequential: s, today: '2026-10-13' }));
    const pj3 = CS.projectDailyQuotas(c, { ...counts, optionCaps: caps3 }, { now: new Date('2026-10-13T01:00:00Z') });
    const q3 = pj3.days.filter(d => d.quota > 0).map(d => `${d.date.slice(5)}:${d.quota}`).join(' ');
    ok('상품 남은 정원으로 자른다(고등어 12 이미 → 3만 더)', q3 === '10-13:5 10-14:3');
  }

  console.log('[5] 작업표 날짜 맞추기');
  {
    const { relayWorktableToProjection } = require('../src/services/sheetlessDailyPlan.service');
    const mk = (id, seq, ot, date) => ({ id, seq, reviewer_name: null, recipient_name: null, phone8: null, order_submission_id: null,
      option_text: ot, row_json: { 번호: String(seq), 구매일자: date, 상품: ot, 수취인: '', 연락처: '' } });
    const rowsDb = [mk('a', 1, '고등어', '10 / 13 (화)'), mk('b', 2, '고등어', '10 / 13 (화)'), mk('c', 3, '옥돔', '10 / 14 (수)'), mk('d', 4, '옥돔', '10 / 14 (수)'), mk('e', 5, '', '')];
    let upd = null;
    const client = { query: async (sql, params) => {
      const q = String(sql);
      if (/FROM campaign_participants/.test(q) && /FOR UPDATE/.test(q)) return { rows: rowsDb };
      if (/UPDATE campaign_participants p/.test(q)) { upd = params; return { rowCount: 1 }; }
      return { rows: [] };
    } };
    const r = await relayWorktableToProjection({ client, sheetId: 'S', tabName: 'T', today: '2026-10-13',
      days: [{ date: '2026-10-13', quota: 2, optKey: '옥돔' }, { date: '2026-10-14', quota: 2, optKey: '고등어' }] });
    const moved = {};
    for (let i = 0; upd && i < upd.length - 2; i += 2) moved[upd[i]] = upd[i + 1];
    ok('★ 그날 상품 줄을 그날로 — 옥돔 줄 → 10/13, 고등어 줄 → 10/14', moved.c === '10 / 13 (화)' && moved.d === '10 / 13 (화)' && moved.a === '10 / 14 (수)' && moved.b === '10 / 14 (수)');
    ok('남는 빈 줄은 날짜를 비운다(종전 규율) · 상품 어긋남 0', r.ok && r.productMismatch === 0 && !('e' in moved));
    upd = null;
    const r2 = await relayWorktableToProjection({ client, sheetId: 'S', tabName: 'T', today: '2026-10-13',
      days: [{ date: '2026-10-13', quota: 2 }, { date: '2026-10-14', quota: 2 }] });
    ok('순차가 아니면(상품 없음) 종전 그대로 — 맞는 날짜 줄은 안 움직인다', r2.ok && r2.moved === 0 && r2.productMismatch === undefined);
  }

  console.log('[6] 배선');
  const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'latin1');
  const cr = Buffer.from(routes, 'latin1').toString('utf8');
  ok('★ 공고 라우트가 일정표를 넘긴다(상세·옵션 변경·공개 목록·참여 게이트 — has() 판정 0)',
    (cr.match(/sequentialFor\(/g) || []).length >= 4 && !/fetchSequentialCampaignIds\([^)]*\)\)\.has\(/.test(cr));
  ok('공개 뷰가 여는 날을 싣는다', /seqDays: true, opensOn: v\.opensOn \|\| null/.test(cr));
  const csSrc = rd('src/services/campaignState.service.js');
  ok('하루 몫 재료도 같은 일정표', /sequential: sequentialFor\(seqIds, cid\), today: kstTodayStr\(now\)/.test(csSrc));
  ok('끄는 스위치 CAMPAIGN_SEQUENTIAL_DAYS', /SEQUENTIAL_DAYS_ENABLED = process\.env\.CAMPAIGN_SEQUENTIAL_DAYS !== '0'/.test(csSrc));
  ok('★ 일정표 조회 실패 = 212 규칙(fail-open) · SAVEPOINT', /ROLLBACK TO SAVEPOINT seq_days/.test(csSrc) && /return new Map\(\);\s*\}\s*\}\s*\n\n\/\*\*\n \* ★ 결정 228 — 한 공고의 일정표/.test(csSrc));
  for (const f of ['src/services/manualOrder.service.js', 'src/services/campaignQuotaBalance.service.js'])
    ok(`${path.basename(f)} 도 일정표를 넘긴다`, /sequentialFor\(await fetchSequentialCampaignIds/.test(rd(f)));
  const plan = rd('src/services/campaignPlan.service.js');
  ok('★ [📅 인원] 저장 — 늘리기·상품 없는 날 막음 · 줄이기는 confirmReduce 없으면 거절',
    /e\.code = 'sequential_over'/.test(plan) && /e\.code = 'sequential_no_product'/.test(plan) && /needConfirm\.length && b\.confirmReduce !== true/.test(plan));
  ok('저장 검사는 이번 저장을 얹은 일정표(0명 밀림 반영)', /loadSequentialSchedule\(client, campaignId, \{ planPatch:/.test(plan));
  const tr = rd('src/routes/trackB.routes.js');
  ok('오류 코드가 400대 + 줄어드는 날 목록을 화면에 돌려준다', /sequential_reduce_needs_confirm: 409/.test(tr) && /reduce: err\.reduce/.test(tr));
  ok('정규 일정 끝 팝업 창구(내부 직원만)', /router\.get\('\/sequential-end-prompts', authMiddleware, internalMiddleware/.test(tr) && /router\.post\('\/sequential-end-prompts\/apply', authMiddleware, internalMiddleware/.test(tr));
  const se = rd('src/services/campaignSequentialEnd.service.js');
  ok('★ 정규 일정 끝 = 오늘 > 일정표 끝 · 같은 끝은 한 번만(잠근 뒤 다시 확인) · 끝내기 = 공고 마감',
    /today > sch\.end/.test(se) && /FOR UPDATE/.test(se) && /detail->>'end' = \$3/.test(se) && /SET status = 'closed'/.test(se));
  ok('받는 사람은 어제 부족 인원 팝업과 같은 판정(사본 없음)', /require\('\.\/campaignShortage\.service'\)/.test(se) && /isRecipient\(admin && admin\.name/.test(se));
  const cdp = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-daily-plan.js'), 'utf8');
  ok('★ 화면: 줄이기는 확인창 두 번(둘 다 예여야 confirmReduce 로 다시 저장)',
    /e1\.code !== 'sequential_reduce_needs_confirm'/.test(cdp) && /var ok2 = window\.confirm\('정말 수정하시겠습니까\?'\);/.test(cdp) && /_body\.confirmReduce = true;/.test(cdp));
  const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  ok('작업보드 로그인 시 정규 일정 끝 팝업 시작 · 로그아웃 시 정지', /window\.SequentialEndPrompt\.start\(_sp\)/.test(wd) && (wd.match(/window\.SequentialEndPrompt\.stop\(\)/g) || []).length === 2 && /js\/sequential-end-prompt\.js/.test(wd));
  const ch = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'campaign.html'), 'utf8');
  const fn = ch.slice(ch.indexOf('function _optRemainText'), ch.indexOf('function _optSubText'));
  const ctx = { _pvOpenSim: () => false }; vm.createContext(ctx); vm.runInContext(fn + '\nthis.f=_optRemainText;', ctx);
  ok('★ 리뷰어 화면: 대기 = "10/14(수) 시작" · 여는 날 없음 = 추가 모집 결정 대기 · 오늘 마감 = 다음 날',
    ctx.f({ seqDays: true, status: 'waiting', remaining: 15, opensOn: '2026-10-14' }) === '15자리 · 10/14(수) 시작'
    && /추가 모집 결정 대기$/.test(ctx.f({ seqDays: true, status: 'waiting', remaining: 2, opensOn: null }))
    && ctx.f({ seqDays: true, status: 'today_done', opensOn: '2026-10-15' }) === '오늘 마감 (10/15(목) 다시)'
    && ctx.f({ status: 'waiting', remaining: 3 }) === '3자리 · 앞 상품 마감 후 열림');

  console.log('[7] 레드팀 반영 배선');
  ok('★ P0-3: 상품 하루 건수가 비면 공고 하루 인원 · 둘 다 없으면 경고 로그', /\(Number\(o\.daily_limit\) \|\| 0\) > 0 \? Number\(o\.daily_limit\) : \(Number\(c\.daily_limit\) \|\| 0\)/.test(csSrc) && /순차진행 일정표를 만들 수 없음/.test(csSrc));
  ok('★ P0: 지난 날 고정 기록을 일정표가 읽는다', /\['sequential_extra', 'sequential_frozen'\]/.test(csSrc) && /frozen,\s*\n\s*isClosedDay/.test(csSrc));
  ok('P2-9: 저장점은 계산이 끝난 뒤 해제', /out\.set\(id, sch\);\s*\}\s*if \(sp\) \{ try \{ await db\.query\('RELEASE SAVEPOINT seq_days'\)/.test(csSrc));
  ok('★ 지난 날 고정 작업 — 어제까지 · 공고별 잠금 · 멱등 · 매일 0시 5분 + 켜질 때', /d\.date < today && !d\.frozen && !d\.extra/.test(se) && /seq_freeze:/.test(se) && /if \(seen\.has\(d\.date\)\) continue;/.test(se)
    && /'5 0 \* \* \*'/.test(rd('src/jobs/cron.js')) && /runFreeze\('startup'\)/.test(rd('src/jobs/cron.js')));
  ok('★ P0-2: 총원 재배분에서 일정이 지난 상품은 정원 고정', (rd('src/services/linkedRecruitQuota.service.js').match(/allocateOptionQuotas\(await _sequentialPastAsClosed\(/g) || []).length === 2);
  ok('★ P1-1: 어제 부족 인원 팝업은 순차진행 공고를 묻지 않는다', /if \(seqSet\.has\(String\(c\.id\)\)\) continue;/.test(rd('src/services/campaignShortage.service.js')));
  ok('★ P1-2: 끝내기는 다시 게시하면 다시 묻는다(추가 모집만 중복 차단) · 화면 확인 한 번 더', /action = \$2`, \[ids\.map\(String\), ACTIONS\.extra\]/.test(se)
    && /fin\.length && !window\.confirm/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'sequential-end-prompt.js'), 'utf8')));
  ok('★ P1-3: 마스터는 받는 사람이 아니어도 본다', /admin && admin\.role === 'master'/.test(se));
  ok('P2-2: 주말을 여는 저장(1명 이상)을 일정표에 얹어 본다 · 안내는 공고 수정', /for \(const x of set\) pm\[x\.date\] = x\.count;/.test(plan) && /\[공고 수정\]에서 그 상품의 하루 건수/.test(plan));
  ok('P2-1: 미리보기도 바꾼 계획을 일정표에 얹는다', /planPatch: \(\) => \(\{ \.\.\.plans \}\)/.test(plan));
  ok('P2-5: 작업표 날짜 맞추기도 손 글씨 상품을 본다', /SAVEPOINT relay_hand/.test(rd('src/services/sheetlessDailyPlan.service.js')));
  ok('P2-10: 차례 아닌 상품 거절 문구 = 여는 날', /function _waitingMsg\(ov\)/.test(cr) && (cr.match(/error: _waitingMsg\(ov\)/g) || []).length === 2);
  ok('P2-11: 화면 파일 버전 표기를 올렸다(옛 조절 창이 남지 않게)', /campaign-daily-plan\.js\?v=20261012-seqdays/.test(wd));

  console.log(`\n${failed ? '❌' : '✅'} campaignSequentialDays: ${n - failed}/${n}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
