/**
 * sequentialSchedule.js — 순차진행 공고의 **날짜별 상품 일정표** (결정 228 · 사용자 확정 2026-10-12)
 *
 * 왜 필요한가(제주도아 30건): 업체 일정은 「하루 5건 · 하루에 한 상품」(10/8 은갈치5 · 10/12 은갈치5 · 10/13 옥돔5 ·
 *   10/14~16 고등어5)이었는데, 리뷰웹(결정 212)은 상품별 하루 건수를 버리고 공고 하루 인원(15)을 앞 상품부터 채워
 *   은갈치 5명이 차자 같은 날 옥돔을 열었다 → 업체가 취소하고 공고가 멈췄다.
 *
 * 규칙(사용자 확정):
 *   ① 상품마다 「정원 ÷ 상품 하루 건수」(나머지가 있으면 하루 더)일을, 상품 순서대로, 시작일부터 쉬는 날을 빼고 깐다.
 *   ② 그날은 그날 상품만, 그 상품의 하루 건수만큼(마지막 날은 남은 건수) 연다.
 *   ③ 못 채운 건은 다음 날로 넘기지 않는다 — 일정은 **설정값만으로** 정해진다(참여 수와 무관 → 날마다 흔들리지 않는다).
 *   ④ 정규 일정이 끝나면 담당자가 추가 모집 여부를 정한다 — [추가 모집]이면 모자란 상품을 같은 순서로 이어 붙인다(extras).
 *   ⑤ [📅 인원] 0명인 날 = 쉬는 날(일정이 하루 밀린다). 그보다 적은 수(두 번 확인해 저장) = 그날 그 상품을 그만큼만 받고
 *      그날 몫은 소진된 것으로 본다(모자란 건 정규 일정 끝에 다시 정한다). 그보다 큰 수는 저장에서 막는다(남은 옛 값은 잘라 쓴다).
 *
 * ⑥ **지난 날은 고정**(레드팀 P0 — 결정 228): 매일 0시 넘어 어제까지의 「그날 상품」을 기록(`frozen`)한다. 일정표는 고정된 날을 그대로 쓰고
 *    **그 뒤부터만** 지금 설정으로 다시 깐다 — 다 팔린 앞 상품을 마감하거나 총원이 바뀌어도 지난 날이 당겨지거나, 이미 지나간 상품이 다시 열리지 않는다.
 *    고정 뒤에는 **마지막 고정 상품부터** 순서대로 이어 간다(앞 상품으로 되돌아가지 않는다 — 앞 상품의 남은 건은 정규 일정 끝 팝업에서 다룬다).
 *    고정된 날의 몫 소진 = 기록된 base. 마감(closed)한 상품도 자기 날짜를 차지한다(뒤 상품을 당기지 않는다).
 * ★ 순수 함수 — DB·시계 없음. 쉬는 날 판정은 호출부가 넘기는 `isClosedDay`(= campaignWeekend.closedKindOn 단일 출처).
 * ★ 만들 수 없으면 null(시작일 없음 · 살아 있는 상품 없음 · 정원/하루 건수 0 인 상품) → 호출부는 종전(212) 규칙으로 접는다.
 */
'use strict';

const MAX_SCAN_DAYS = 2000;

function _addDays(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * @param {object} p
 * @param {string} p.startDate                  'YYYY-MM-DD'
 * @param {Array<{optKey:string, recruitTotal:number, dailyLimit:number, closed?:boolean}>} p.options  상품 전부(마감 포함), 순서대로 —
 *        ★ 마감(closed) 상품도 **자기 날짜를 그대로 차지**한다(그날은 팔 상품이 없다) — 마감했다고 뒤 상품이 당겨지면
 *          업체 일정과 다른 상품이 그날 열린다(10/12 사고와 같은 모양). 정원·하루 건수가 없는 마감 행(옛 정리 흔적)만 뺀다.
 * @param {(iso:string)=>boolean} [p.isClosedDay] 주말·공휴일 등 공고가 닫는 날(0명 계획은 아래 plans 로 따로 본다)
 * @param {Object<string,number>} [p.plans]       날짜별 계획(0 = 쉬는 날 · 그보다 작은 수 = 그날 줄여 받기)
 * @param {Array<{after:string, shortages:Array<{optKey:string,n:number}>}>} [p.extras]  추가 모집 결정(순서대로)
 * @param {Array<{date:string, optKey:string, base:number, amount:number, idx?:number}>} [p.frozen]  고정된 지난 날(⑥)
 * @returns {null | {days:Array<{date,optKey,amount,base,reduced,extra}>, byDate:Map, regularEnd:string|null,
 *                   end:string|null, optionOrder:string[]}}
 */
function buildSequentialSchedule({ startDate, options, isClosedDay = null, plans = null, extras = [], frozen = [] } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ''))) return null;
  const valid = o => _num(o.recruitTotal) > 0 && _num(o.dailyLimit) > 0;
  // 마감 행 중 정원·하루 건수가 없는 것(옛 정리 흔적)은 순서에서 뺀다 — 나머지는 마감이어도 자기 날짜를 차지한다
  const opts = (Array.isArray(options) ? options : []).filter(o => o && o.optKey && (!o.closed || valid(o)));
  const liveOpts = opts.filter(o => !o.closed);
  if (!liveOpts.length) return null;
  if (liveOpts.some(o => !valid(o))) return null;
  const closed = d => !!(isClosedDay && isClosedDay(d)) || (plans && plans[d] != null && _num(plans[d]) === 0);

  const days = [];
  const daily = new Map(opts.map(o => [o.optKey, Math.floor(_num(o.dailyLimit))]));
  // 한 구간(정규 일정 또는 추가 모집 한 번) = [{optKey, units}] 을 from 부터 깐다. 마지막으로 깐 날을 돌려준다.
  const lay = (queue, from, extra) => {
    let d = from, last = null, guard = 0;
    for (const q of queue) {
      let units = Math.floor(_num(q.units));
      while (units > 0) {
        if (++guard > MAX_SCAN_DAYS) return { last, overflow: true };
        if (!closed(d)) {
          const base = Math.min(daily.get(q.optKey), units);
          const pl = plans && plans[d] != null ? _num(plans[d]) : null;
          const amount = (pl != null && pl > 0 && pl < base) ? Math.floor(pl) : base;
          days.push({ date: d, optKey: q.optKey, amount, base, reduced: amount < base, extra: !!extra });
          units -= base;   // ★ 줄여 받은 날도 그날 몫은 소진(모자란 건 넘기지 않는다 — 규칙 ③⑤)
          last = d;
        }
        d = _addDays(d, 1);
      }
    }
    return { last, overflow: false };
  };

  // ⑥ 고정된 지난 날 — 날짜별 하나(먼저 기록된 것), 날짜 순
  const fz = [];
  const seenFz = new Set();
  for (const f of (Array.isArray(frozen) ? frozen : [])) {
    if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(String(f.date || '')) || !f.optKey || seenFz.has(f.date)) continue;
    seenFz.add(f.date);
    // 이름이 바뀐 상품은 기록된 순번으로 같은 상품을 찾는다(못 찾으면 기록 이름 그대로 — 지금 상품과 겹치지 않는다)
    let key = String(f.optKey);
    if (!opts.some(o => o.optKey === key) && Number.isInteger(f.idx) && opts[f.idx]) key = opts[f.idx].optKey;
    fz.push({ date: f.date, optKey: key, base: Math.max(0, Math.floor(_num(f.base))), amount: Math.max(0, Math.floor(_num(f.amount))), idx: f.idx });
  }
  fz.sort((a, b) => (a.date < b.date ? -1 : 1));
  let regQueue = opts.map(o => ({ optKey: o.optKey, units: o.recruitTotal }));
  let regFrom = startDate;
  if (fz.length) {
    const consumed = new Map();
    for (const f of fz) {
      consumed.set(f.optKey, (consumed.get(f.optKey) || 0) + f.base);
      days.push({ date: f.date, optKey: f.optKey, amount: f.amount, base: f.base, reduced: f.amount < f.base, extra: false, frozen: true });
    }
    const lastF = fz[fz.length - 1];
    // 마지막 고정 상품의 위치(이름이 바뀌었으면 기록된 순번) — 그보다 앞 상품으로는 되돌아가지 않는다
    let startIdx = opts.findIndex(o => o.optKey === lastF.optKey);
    if (startIdx < 0) startIdx = Number.isInteger(lastF.idx) ? Math.min(Math.max(0, lastF.idx), opts.length) : opts.length;
    regQueue = opts.slice(startIdx)
      .map(o => ({ optKey: o.optKey, units: Math.max(0, _num(o.recruitTotal) - (consumed.get(o.optKey) || 0)) }));
    regFrom = _addDays(lastF.date, 1);
    if (regFrom < startDate) regFrom = startDate;
  }
  const reg = lay(regQueue, regFrom, false);
  if (reg.overflow) return null;
  const regularEnd = reg.last || (fz.length ? fz[fz.length - 1].date : null);
  let end = regularEnd;
  for (const ex of (Array.isArray(extras) ? extras : [])) {
    if (!ex || !Array.isArray(ex.shortages)) continue;
    const q = liveOpts.map(o => {
      const s = ex.shortages.find(x => x && x.optKey === o.optKey);
      return { optKey: o.optKey, units: s ? Math.max(0, Math.floor(_num(s.n))) : 0 };
    }).filter(x => x.units > 0);
    if (!q.length) continue;
    // 추가 모집은 「정규(또는 앞 추가) 일정 끝」과 「결정한 날」 중 늦은 날의 **다음 날**부터
    const after = [end, /^\d{4}-\d{2}-\d{2}$/.test(String(ex.after || '')) ? ex.after : null].filter(Boolean).sort().pop();
    const r = lay(q, _addDays(after, 1), true);
    if (r.overflow) return null;
    if (r.last) end = r.last;
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byDate = new Map(days.map(x => [x.date, x]));
  return { days, byDate, regularEnd, end, optionOrder: opts.map(o => o.optKey) };   // 순서 = 마감 포함(고정 순번과 같은 기준)
}

/** 그 상품이 `from` 이후(포함) 처음 열리는 날 — 없으면 null. */
function nextDateFor(schedule, optKey, from) {
  if (!schedule || !Array.isArray(schedule.days)) return null;
  for (const x of schedule.days) if (x.optKey === optKey && x.date >= from) return x.date;
  return null;
}

/** 그 날짜의 일정(없으면 null = 쉬는 날·일정 밖). */
function dayOf(schedule, iso) {
  return (schedule && schedule.byDate && schedule.byDate.get(iso)) || null;
}

module.exports = { buildSequentialSchedule, nextDateFor, dayOf, _addDays };
