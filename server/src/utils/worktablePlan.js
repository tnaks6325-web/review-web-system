/**
 * worktablePlan.js — 작업표 생성 "계획" 산출 (M2a · 순수함수)
 *
 * 작업오더 + 표준 열 템플릿 → **무엇을 만들지**(열 구성 · 행 수 · 날짜 분배 · 옵션 배분)를 계산한다.
 * 여기서는 아무것도 만들지 않는다 — 미리보기가 이 결과를 그대로 그리고, 사람이 확인한 뒤에야 생성이 일어난다.
 *
 * ★★ 설계 원칙(되돌리지 말 것)
 *  ① **순수함수**(DB·시트·시각 접근 0) — 미리보기와 실제 생성이 **같은 함수**를 써야
 *     "미리보기 ≠ 실제 표" 가 구조적으로 불가능해진다(campaign-workdetail.js 공용 렌더러와 같은 규율).
 *  ② **열 이름이 곧 동작** — 열 분류는 `worktableTemplate.classifyHeaders`(매퍼 파생) 단일 출처.
 *     여기서 키워드 표를 다시 만들지 않는다.
 *  ③ **채널 목록은 `cashReceiptChannels` 한 벌** — 채널을 늘리면 여기도 자동으로 따라온다.
 *  ④ **막을 것과 알릴 것을 가른다**: `blockers` 는 생성 버튼을 잠그고, `warnings` 는 알리기만 한다.
 *     막는 것은 "그대로 만들면 반드시 잘못된 표가 되는" 경우뿐이다(오탐으로 정상 발행을 막지 않는다 —
 *     옵션 칸 자동점검이 하드블록을 쓰지 않는 것과 같은 판단).
 */
'use strict';

const { classifyHeaders } = require('./worktableTemplate');
const { CASH_RECEIPT_CHANNELS } = require('./cashReceiptChannels');

const MAX_ROWS = 2000;          // prepareRosterSlots 상한과 같은 값(폭주 방지)
const MAX_DAYS = 400;           // 날짜 분배 무한루프 백스톱

/* ── 채널 판정 — 상품 URL 의 **호스트**만 본다 ────────────────────────────
   ★ 전체 URL 로 매칭하면 `coupang.com/...?src=naver_ad` 를 네이버로 오판하고
     `coupang.com.evil.kr` 에 속는다(프론트 `WO_CHANNEL_HOSTS` 와 같은 규율).
   ★ 카카오는 `makers.kakao.com` 만 — 톡스토어·선물하기는 진행 방식이 다르다.
   ★ 판정 실패는 'unknown' — 틀린 채널로 분류하지 않는다(채널 열이 안 붙을 뿐). */
const CHANNEL_HOST_RE = {
  coupang: /(^|\.)coupang\.com$|coupangcdn\.com$/i,
  naver: /(^|\.)naver\.com$|(^|\.)naver\.me$/i,
  oliveyoung: /(^|\.)oliveyoung\.co\.kr$/i,
  kakao: /(^|\.)makers\.kakao\.com$/i,
};

function channelFromUrl(url) {
  const u = String(url == null ? '' : url).trim();
  if (!u) return 'unknown';
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname; } catch (_) { return 'unknown'; }
  for (const c of CASH_RECEIPT_CHANNELS) {
    const re = CHANNEL_HOST_RE[c.key];
    if (re && re.test(host)) return c.key;
  }
  return 'unknown';
}
function channelLabel(key) {
  const c = CASH_RECEIPT_CHANNELS.find(x => x.key === key);
  return c ? c.label : '미상';
}

/* ── 날짜 ────────────────────────────────────────────────────────────────
   ★ Date 산술 대신 Y-M-D 문자열로 다룬다 — 서버 타임존이 무엇이든 결과가 같아야 한다
     (이 값이 시트 구매일자 칸에 그대로 들어가고, 063 시트 일정 인식이 그걸 읽어 모집 정원을 정한다). */
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function parseYmd(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}
function ymdToUtc(o) { return Date.UTC(o.y, o.m - 1, o.d); }
function utcToYmd(t) { const dt = new Date(t); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
function ymdStr(o) { return `${o.y}-${String(o.m).padStart(2, '0')}-${String(o.d).padStart(2, '0')}`; }
function dowOf(o) { return new Date(ymdToUtc(o)).getUTCDay(); }
/** 시트 구매일자 표기 — 기존 시트들이 쓰는 `M / D (요일)` 형식 그대로. */
function sheetDateStr(o) { return `${o.m} / ${o.d} (${DOW[dowOf(o)]})`; }
function addDays(o, n) { return utcToYmd(ymdToUtc(o) + n * 86400000); }
function isWeekend(o) { const w = dowOf(o); return w === 0 || w === 6; }

/**
 * 날짜 분배 — 하루 `daily` 건씩, 주말 제외 옵션.
 * 시작일이 없으면 **날짜를 만들지 않는다**(빈 칸 = 담당자가 나중에 채움).
 */
function distributeDates({ total, daily, startDate, skipWeekends = true, holidays = [] } = {}) {
  const n = Math.max(0, parseInt(total, 10) || 0);
  const per = Math.max(0, parseInt(daily, 10) || 0);
  const start = parseYmd(startDate);
  if (!n || !per || !start) return { days: [], rowDates: new Array(n).fill(null) };

  const skip = new Set((holidays || []).map(h => String(h || '').trim()).filter(Boolean));
  const days = [];
  const rowDates = [];
  let cur = start, guard = 0;
  while (rowDates.length < n && guard++ < MAX_DAYS) {
    if ((skipWeekends && isWeekend(cur)) || skip.has(ymdStr(cur))) { cur = addDays(cur, 1); continue; }
    const take = Math.min(per, n - rowDates.length);
    days.push({ date: ymdStr(cur), label: sheetDateStr(cur), dow: DOW[dowOf(cur)], count: take });
    for (let i = 0; i < take; i++) rowDates.push({ date: ymdStr(cur), label: sheetDateStr(cur) });
    cur = addDays(cur, 1);
  }
  while (rowDates.length < n) rowDates.push(null);   // MAX_DAYS 백스톱에 걸린 나머지
  return { days, rowDates };
}

/* ── 옵션 ────────────────────────────────────────────────────────────────
   작업오더 `product_options_json` = [{ name, base:{pay}, options:[{label,pay}] }]
   (프론트 `_woOptionRows`·reviewInspect 와 같은 형태). 옵션 라벨이 곧 시트 옵션 칸 기입값이다. */
function optionKeysFromWorkOrder(wo) {
  const out = [];
  const seen = new Set();
  const put = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s || seen.has(s.toLowerCase())) return;
    // ★ "옵션 없음/단일/해당없음" 류는 옵션명이 아니라 서술 — 시트 옵션 칸을 오염시킨다.
    if (/^(옵션\s*없음|없음|단일|해당\s*없음|무옵션|n\/?a)$/i.test(s)) return;
    seen.add(s.toLowerCase());
    out.push(s);
  };
  try {
    const arr = JSON.parse((wo && wo.product_options_json) || '[]');
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const opts = (p && Array.isArray(p.options)) ? p.options : [];
        if (opts.length) opts.forEach(o => put(o && (o.label != null ? o.label : o)));
      }
    }
  } catch (_) { /* 깨진 JSON 은 옵션 없음으로 */ }
  return out;
}

/**
 * 옵션 배분 — 지정 수량이 있으면 그대로, 없으면 균등(나머지는 앞 옵션부터 1개씩).
 * ★ 옵션이 1개 이하면 배분하지 않는다(옵션 칸을 비워 둔다 — 선택지가 하나뿐이면 기입 의미가 없다).
 */
function distributeOptions({ total, options = [] } = {}) {
  const n = Math.max(0, parseInt(total, 10) || 0);
  const keys = (options || [])
    .map(o => (typeof o === 'string' ? { key: o, count: null } : { key: String((o && o.key) || ''), count: o && o.count }))
    .filter(o => o.key.trim());
  if (!n || keys.length < 2) return { buckets: [], rowOptions: new Array(n).fill(null) };

  const explicit = keys.filter(k => Number.isInteger(parseInt(k.count, 10)) && parseInt(k.count, 10) >= 0);
  let buckets;
  if (explicit.length === keys.length) {
    buckets = keys.map(k => ({ key: k.key, count: parseInt(k.count, 10) }));
  } else {
    const base = Math.floor(n / keys.length), rem = n % keys.length;
    buckets = keys.map((k, i) => ({ key: k.key, count: base + (i < rem ? 1 : 0) }));
  }
  const rowOptions = [];
  for (const b of buckets) for (let i = 0; i < b.count && rowOptions.length < n; i++) rowOptions.push(b.key);
  while (rowOptions.length < n) rowOptions.push(null);   // 합계 미달분은 빈 칸(경고로 알린다)
  return { buckets, rowOptions };
}

/* ── 열 구성 ─────────────────────────────────────────────────────────────
   작업표의 열 = **공통 + 그 채널 행**. 공통에 있는 이름은 채널에서 건너뛴다(같은 열 2번 방지). */
function buildColumns({ template, channel, tabOpts = {} } = {}) {
  const core = ((template && template.core) || []).map(s => String(s || '').trim()).filter(Boolean);
  const chan = (((template && template.channels) || {})[channel] || []).map(s => String(s || '').trim()).filter(Boolean);
  const seen = new Set();
  const names = [];
  const origin = [];
  core.forEach(n => { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); names.push(n); origin.push('common'); } });
  chan.forEach(n => { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); names.push(n); origin.push('channel'); } });
  const cls = classifyHeaders(names, tabOpts);
  return cls.map((c, i) => ({
    name: c.header, role: c.role, label: c.label, tier: c.tier, conflict: c.conflict || null, origin: origin[i],
  }));
}

/**
 * 작업표 계획 산출 — 미리보기와 실제 생성이 **같이 쓰는** 단일 출처.
 *
 * @param {object} workOrder  work_orders 행(그대로)
 * @param {object} template   { core:[names], channels:{key:[names]} }
 * @param {object} [o]        미리보기에서 사람이 조정한 값(전부 선택)
 *        o.total·o.daily·o.startDate·o.skipWeekends·o.holidays·o.options·o.channel
 */
function buildWorktablePlan({ workOrder, template, options: o = {} } = {}) {
  const wo = workOrder || {};
  const channel = (o.channel && String(o.channel)) || channelFromUrl(wo.product_url);
  const columns = buildColumns({ template, channel });

  const rawTotal = o.total != null ? o.total : wo.recruit_count;
  const total = Math.max(0, Math.min(parseInt(rawTotal, 10) || 0, MAX_ROWS));
  const daily = Math.max(0, parseInt(o.daily != null ? o.daily : wo.daily_count, 10) || 0);
  const startDate = o.startDate != null ? o.startDate
    : (wo.start_date ? String(wo.start_date).slice(0, 10) : '');
  const skipWeekends = o.skipWeekends !== false;   // 기본 주말 제외

  /* 제외 날짜(공휴일·업체 휴무) — 작업오더에 날짜 필드가 없어 담당자가 미리보기에서 지정한다.
     ★ 형식이 맞는 값만 받는다(잘못된 값은 조용히 무시 — 날짜 분배가 통째로 깨지는 것보다 낫다). */
  const holidays = [...new Set((Array.isArray(o.holidays) ? o.holidays : [])
    .map(h => String(h == null ? '' : h).trim())
    .filter(h => !!parseYmd(h))
    .map(h => ymdStr(parseYmd(h))))].sort();

  const optKeys = o.options != null ? o.options : optionKeysFromWorkOrder(wo);
  const { buckets, rowOptions } = distributeOptions({ total, options: optKeys });
  const { days, rowDates } = distributeDates({ total, daily, startDate, skipWeekends, holidays });

  const rows = [];
  for (let i = 0; i < total; i++) {
    rows.push({
      seq: i + 1,
      date: rowDates[i] ? rowDates[i].date : null,
      dateLabel: rowDates[i] ? rowDates[i].label : null,
      optionKey: rowOptions[i] || null,
    });
  }

  /* ── 막을 것(blockers) — 그대로 만들면 반드시 잘못된 표가 되는 경우만 ── */
  const blockers = [];
  if (!total) blockers.push({ code: 'no_total', message: '만들 건수가 0입니다. 총 건수를 입력하세요.' });
  if (total >= MAX_ROWS) blockers.push({ code: 'too_many', message: `한 번에 만들 수 있는 최대 행은 ${MAX_ROWS}개입니다.` });
  if (!columns.length) blockers.push({ code: 'no_columns', message: '표준 열이 정해지지 않았습니다. 설정 › 작업표 표준 열에서 먼저 정하세요.' });
  const optSum = buckets.reduce((a, b) => a + b.count, 0);
  if (buckets.length && optSum !== total) {
    blockers.push({ code: 'option_sum', message: `옵션 배분 합계(${optSum})가 총 건수(${total})와 다릅니다.` });
  }
  const dup = {};
  columns.forEach(c => { if (c.role) dup[c.role] = (dup[c.role] || 0) + 1; });
  const dupRoles = Object.keys(dup).filter(r => dup[r] > 1);

  /* ── 알릴 것(warnings) — 생성은 되지만 사람이 알아야 하는 것 ── */
  const warnings = [];
  if (!startDate) warnings.push({ code: 'no_start_date', message: '시작일이 없어 구매일자 칸을 비워 둡니다. 날짜가 없으면 그날 모집 정원이 시트에서 파생되지 않습니다.' });
  else if (!daily) warnings.push({ code: 'no_daily', message: '일건수가 없어 날짜를 나누지 않았습니다.' });
  else if (rows.some(r => !r.date)) warnings.push({ code: 'date_short', message: '날짜를 다 채우지 못했습니다(기간이 너무 깁니다). 일건수를 확인하세요.' });
  if (channel === 'unknown') warnings.push({ code: 'unknown_channel', message: '상품 URL로 구매채널을 알 수 없어 채널 전용 열(예: 쿠팡ID)을 넣지 않았습니다.' });
  if (dupRoles.length) warnings.push({ code: 'duplicate_role', message: `같은 역할의 열이 둘 이상입니다(${dupRoles.join(', ')}) — 리뷰어 제출이 두 칸에 같은 값을 씁니다.` });
  const conflicts = columns.filter(c => c.conflict);
  if (conflicts.length) warnings.push({ code: 'status_conflict', message: `상태 칸과 제출 기입이 겹치는 열이 있습니다: ${conflicts.map(c => c.name).join(', ')}` });
  /* 진행 기간 밖의 제외 날짜는 아무 영향이 없다 — 오타·잘못 고른 날일 수 있어 알려 준다.
     (기간 안의 제외일은 그날이 빠진 것 = 정상 동작이라 알릴 것이 없다.) */
  if (holidays.length && days.length) {
    const first = days[0].date, last = days[days.length - 1].date;
    const outside = holidays.filter(h => h < first || h > last);
    if (outside.length) warnings.push({ code: 'holiday_outside', message: `제외 날짜 중 진행 기간 밖이라 영향이 없는 날: ${outside.join(', ')}` });
  }
  if (buckets.length && !columns.some(c => c.role === 'option')) {
    warnings.push({ code: 'no_option_column', message: '옵션을 나눴지만 표에 옵션 열이 없어 기입되지 않습니다. 공통 열에 옵션 칸을 추가하세요.' });
  }

  return {
    channel, channelLabel: channelLabel(channel),
    columns,
    rows,
    dates: days,
    optionBuckets: buckets,
    totals: { rows: total, days: days.length, daily, columns: columns.length },
    startDate, skipWeekends, holidays,
    blockers, warnings,
    canCreate: blockers.length === 0,
  };
}

module.exports = {
  buildWorktablePlan, buildColumns, distributeDates, distributeOptions,
  optionKeysFromWorkOrder, channelFromUrl, channelLabel, sheetDateStr,
  MAX_ROWS,
};
