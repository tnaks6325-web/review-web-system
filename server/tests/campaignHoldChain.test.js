'use strict';
/**
 * 결정 356 — 차례 타이머 순수 규칙·당기기 격리(실행 가드).
 *  ① 고정 사례(제출·미리 제출·멱등·종전 행 닻·마감 자르기·시작만 당기기·R5 거절 경계)
 *  ② 무작위 3,000회: 마감이 늦어지지 않음 · 0분 차례 없음 · 창 마감 넘김 없음 · 진행 중 차례 명의 ≤ 1 · 머리 명의 거절 0
 *  ③ R2: 진행 중 명의가 끝나면 다음 명의가 '지금' 시작
 *  ④ pullChainEarlierSafe: SAVEPOINT 안에서만 · 실패해도 던지지 않음 · lock_timeout 되돌림 · 잠글 일 없으면 3왕복 · 끄는 스위치
 */
const assert = require('assert');
const C = require('../src/services/campaignHoldChain.service');
const MIN = 60000;
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

(async () => {
  const T0 = Date.parse('2026-11-09T01:00:00Z');
  const mk = (id, s, e, ttl) => ({ id, status: 'applied', turn_starts_at: new Date(T0 + s * MIN), expires_at: new Date(T0 + e * MIN), chain_ttl_min: ttl });
  const view = ch => ch.map(c => [c.id, (c.turnStartsAt - T0) / MIN, (c.expiresAt - T0) / MIN]);
  ok('① 본계정 10:05 제출 → s1 10:05–10:20 · s2 10:20–10:35',
    JSON.stringify(view(C.computeChainDeadlines([mk(2, 20, 35, 15), mk(3, 35, 50, 15)], T0 + 5 * MIN))) === JSON.stringify([[2, 5, 20], [3, 20, 35]]));
  ok('① 대기 s1 미리 제출 → 본계정 불변 · s2 10:20–10:35',
    JSON.stringify(view(C.computeChainDeadlines([mk(1, 0, 20, 20), mk(3, 35, 50, 15)], T0 + 5 * MIN))) === JSON.stringify([[3, 20, 35]]));
  ok('① 멱등 — 다시 계산하면 변화 0', C.computeChainDeadlines([mk(2, 5, 20, 15), mk(3, 20, 35, 15)], T0 + 5 * MIN).length === 0);
  ok('① 종전(동시) 홀드는 닻일 뿐 고치지 않는다',
    JSON.stringify(view(C.computeChainDeadlines([{ id: 9, status: 'applied', turn_starts_at: null, expires_at: new Date(T0 + 30 * MIN) }, mk(3, 35, 50, 15)], T0 + 5 * MIN))) === JSON.stringify([[3, 30, 45]]));
  ok('① 마감에 잘린 명의는 시작만 당겨진다(끝은 마감 그대로)',
    JSON.stringify(view(C.computeChainDeadlines([mk(2, 45, 60, 20)], T0 + 44 * MIN))) === JSON.stringify([[2, 44, 60]]));
  const close = T0 + 40 * MIN, cut = T0 + 30 * MIN;
  ok('① R5 시작 < cutoff 면 참여(끝 = min(시작+TTL, 마감))', C.shapeLink({ startMs: T0 + 20 * MIN, ttlMin: 15, closesMs: close, cutoffMs: cut }).expiresAt.getTime() === T0 + 35 * MIN);
  ok('① R5 시작 = cutoff 면 거절', C.shapeLink({ startMs: cut, ttlMin: 15, closesMs: close, cutoffMs: cut }).refuse === true);
  ok('① R5 cutoff − 1ms 면 참여', C.shapeLink({ startMs: cut - 1, ttlMin: 15, closesMs: close, cutoffMs: cut }).refuse === false);
  {   // 사용자 확정 답 24①: close_buffer_min = 0 이어도 기다리는 명의는 마감까지 10분 이상 남아야 한다 · 첫 명의(지금 시작)는 종전 그대로
    const cl = T0 + 60 * MIN, cut0 = cl;   // buffer 0 → cutoffAt = closesAt
    ok('① 답24① buffer 0: 기다리는 명의 시작 = 마감 − 9분 → 거절', C.shapeLink({ startMs: cl - 9 * MIN, ttlMin: 15, closesMs: cl, cutoffMs: cut0, nowMs: T0 }).refuse === true);
    ok('① 답24① buffer 0: 기다리는 명의 시작 = 마감 − 11분 → 참여(끝 = 마감)', C.shapeLink({ startMs: cl - 11 * MIN, ttlMin: 15, closesMs: cl, cutoffMs: cut0, nowMs: T0 }).expiresAt.getTime() === cl);
    ok('① 답24① buffer 0: 지금 시작하는 첫 명의는 마감 − 5분이어도 종전대로 참여', C.shapeLink({ startMs: cl - 5 * MIN, ttlMin: 20, closesMs: cl, cutoffMs: cut0, nowMs: cl - 5 * MIN }).refuse === false);
    ok('① 답24① buffer 15 면 종전 cutoff(마감 − 15분)가 더 이르다', C.shapeLink({ startMs: cl - 12 * MIN, ttlMin: 15, closesMs: cl, cutoffMs: cl - 15 * MIN, nowMs: T0 }).refuse === true);
  }
  ok('① 시간창 없는 공고 = 자르기·거절 없음', C.shapeLink({ startMs: T0, ttlMin: 15, closesMs: NaN, cutoffMs: NaN }).expiresAt.getTime() === T0 + 15 * MIN);
  ok('① 본계정 기본 20분 상수', C.MAIN_HOLD_TTL_DEFAULT_MIN === 20);

  // ② 무작위
  let violations = 0;
  const guarded = (row, c, nowMs) => {   // pull UPDATE 의 WHERE 를 그대로 재현
    const ts = +row.turn_starts_at, ex = +row.expires_at, ns = +c.turnStartsAt, ne = +c.expiresAt;
    if (!(row.status === 'applied' && row.turn_starts_at && ts > nowMs && ne > nowMs && ts >= ns && ex >= ne && (ts > ns || ex > ne))) return false;
    row.turn_starts_at = new Date(ns); row.expires_at = new Date(ne); return true;
  };
  for (let run = 0; run < 3000; run++) {
    let now = Date.parse('2026-11-09T07:00:00Z') + Math.floor(rnd() * 60) * MIN;
    const windowed = rnd() < 0.7, closes = Date.parse('2026-11-09T09:00:00Z'), buffer = [0, 10, 10, 15][Math.floor(rnd() * 4)];
    const closesMs = windowed ? closes : NaN, cutoffMs = windowed ? closes - buffer * MIN : NaN;
    const rows = [], hist = new Map(); let id = 1;
    const live = () => rows.filter(r => r.status === 'applied' && +r.expires_at > now);
    for (let step = 0; step < 40; step++) {
      const op = rnd();
      if (op < 0.35 && (!windowed || now < cutoffMs)) {
        if (live().length >= 10) continue;
        const ttl = rnd() < 0.3 ? 20 : 15;
        if (rnd() < 0.1) { rows.push({ id: id++, status: 'applied', turn_starts_at: null, expires_at: new Date(windowed ? Math.min(now + ttl * MIN, closes) : now + ttl * MIN) }); continue; }
        const tail = Math.max(now, ...live().map(r => +r.expires_at));
        const s = C.shapeLink({ startMs: tail, ttlMin: ttl, closesMs, cutoffMs, nowMs: now });
        if (s.refuse) { if (tail === now) violations++; continue; }
        // 답24①: 기다리는 명의로 받아들였으면 차례 시작 때 마감까지 10분 이상
        if (windowed && tail > now && !(tail < closes - 10 * MIN)) violations++;
        rows.push({ id: id++, status: 'applied', turn_starts_at: s.turnStartsAt, expires_at: s.expiresAt, chain_ttl_min: ttl, startAtJoin: +s.turnStartsAt });
      } else if (op < 0.6) {
        const L = live(); if (!L.length) continue;
        L[Math.floor(rnd() * L.length)].status = rnd() < 0.5 ? 'submitted' : 'cancelled';
        for (const c of C.computeChainDeadlines(rows, now)) guarded(rows.find(r => r.id === c.id), c, now);
        if (C.computeChainDeadlines(rows, now).some(c => guarded({ ...rows.find(r => r.id === c.id) }, c, now))) violations++;
      } else {
        now += Math.floor(rnd() * 12 * MIN) + 1000;
        for (const r of rows) if (r.status === 'applied' && +r.expires_at <= now - 30000) r.status = 'expired';
      }
      for (const r of rows) {
        const p = hist.get(r.id);
        if (p && (+r.expires_at > p.e || (r.turn_starts_at && +r.turn_starts_at > p.s))) violations++;
        hist.set(r.id, { e: +r.expires_at, s: r.turn_starts_at ? +r.turn_starts_at : -Infinity });
        if (r.turn_starts_at && +r.expires_at <= +r.turn_starts_at) violations++;
        if (windowed && +r.expires_at > closes) violations++;
        if (r.turn_starts_at && windowed && !(r.startAtJoin < cutoffMs)) violations++;
      }
      if (rows.filter(r => r.status === 'applied' && r.turn_starts_at && +r.turn_starts_at <= now && +r.expires_at > now).length > 1) violations++;
    }
  }
  ok('② 무작위 3,000회 불변식 위반 0', violations === 0);

  // ③ R2
  let bad = 0, checked = 0;
  for (let run = 0; run < 2000; run++) {
    let now = T0; const rows = []; let id = 1;
    for (let k = 0; k < 1 + Math.floor(rnd() * 5); k++) {
      const tail = Math.max(now, ...rows.filter(r => r.status === 'applied').map(r => +r.expires_at));
      const s = C.shapeLink({ startMs: tail, ttlMin: k ? 15 : 20, closesMs: NaN, cutoffMs: NaN });
      rows.push({ id: id++, status: 'applied', turn_starts_at: s.turnStartsAt, expires_at: s.expiresAt, chain_ttl_min: k ? 15 : 20 });
    }
    for (let step = 0; step < 8; step++) {
      now += Math.floor(rnd() * 10 * MIN);
      const running = rows.find(r => r.status === 'applied' && +r.turn_starts_at <= now && +r.expires_at > now);
      if (!running) continue;
      running.status = 'submitted';
      for (const c of C.computeChainDeadlines(rows, now)) { const r = rows.find(x => x.id === c.id); r.turn_starts_at = c.turnStartsAt; r.expires_at = c.expiresAt; }
      const w = rows.filter(r => r.status === 'applied' && +r.expires_at > now).sort((a, b) => a.turn_starts_at - b.turn_starts_at);
      if (w.length) { checked++; if (Math.abs(+w[0].turn_starts_at - now) > C.SLACK_MS) bad++; }
    }
  }
  ok('③ R2 진행 중 명의가 끝나면 다음 명의가 지금 시작', checked > 1000 && bad === 0);

  // ④ 당기기 격리
  const client = (failOn, owners = ['12345678']) => {
    const log = [];
    return { log, async query(sql) {
      const one = sql.replace(/\s+/g, ' ').trim(); log.push(one);
      if (failOn && one.includes(failOn)) { const e = new Error('boom'); e.code = '55P03'; throw e; }
      if (one.includes('ARRAY(')) return { rows: [{ now: new Date(T0 + 5 * MIN), owners }] };
      if (one.includes('current_setting')) return { rows: [{ v: '0' }] };
      if (one.includes('FOR UPDATE')) return { rows: [mk(2, 20, 35, 15)] };
      if (one.startsWith('UPDATE')) return { rowCount: 1 };
      return { rows: [] };
    } };
  };
  let c = client(null), r = await C.pullChainEarlierSafe(c, { campaignId: 'x', endedIds: [1], cause: 'submit' });
  ok('④ 성공 = SAVEPOINT 로 시작 · RELEASE 로 끝 · lock_timeout 되돌림', r.changed === 1 && c.log[0] === 'SAVEPOINT hold_chain'
    && c.log[c.log.length - 1] === 'RELEASE SAVEPOINT hold_chain' && c.log.some(s => s.startsWith("SELECT set_config('lock_timeout', $1, true)")));
  c = client(null, []); r = await C.pullChainEarlierSafe(c, { campaignId: 'x', endedIds: [1] });
  ok('④ 기다리는 명의 없으면 잠금 없이 3왕복', r.changed === 0 && c.log.length === 3 && !c.log.some(s => /FOR UPDATE/.test(s)));
  c = client('FOR UPDATE'); r = await C.pullChainEarlierSafe(c, { campaignId: 'x', endedIds: [1] });
  ok('④ 실패 = 던지지 않고 ROLLBACK TO SAVEPOINT → RELEASE', r.error === '55P03' && c.log.includes('ROLLBACK TO SAVEPOINT hold_chain')
    && c.log[c.log.length - 1] === 'RELEASE SAVEPOINT hold_chain');
  c = client(null); r = await C.pullChainEarlierSafe(c, { campaignId: 'x', endedIds: [] });
  ok('④ 끝난 행이 없으면 쿼리 0', c.log.length === 0);
  process.env.CAMPAIGN_HOLD_CHAIN_PULL = '0'; c = client(null); r = await C.pullChainEarlierSafe(c, { campaignId: 'x', endedIds: [1] });
  ok('④ 끄는 스위치(CAMPAIGN_HOLD_CHAIN_PULL=0) = 쿼리 0', r.skipped === 'off' && c.log.length === 0);
  delete process.env.CAMPAIGN_HOLD_CHAIN_PULL;
  process.env.CAMPAIGN_HOLD_CHAIN = '0';
  ok('④ 끄는 스위치(CAMPAIGN_HOLD_CHAIN=0) = 새 차례 줄 없음', C.chainEligibleCampaign({ multi_account_mode: true }) === false);
  delete process.env.CAMPAIGN_HOLD_CHAIN;
  ok('④ 1인1회 공고는 차례 줄 없음', C.chainEligibleCampaign({ multi_account_mode: false }) === false);
  ok('④ 동시진행(네이버+쿠팡) 공고는 차례 줄 없음', C.chainEligibleCampaign({ multi_account_mode: true, channel: '네이버+쿠팡' }) === false);
  console.log(`\n✅ campaignHoldChain: ${passed}개 통과`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
