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
const { isSheetHeaderRow } = require('./sheetHeader');

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
/**
 * 채널 라벨 — 기본 4채널 + **템플릿에 직접 추가한 채널**까지 본다.
 * ★ 자동 판정(`channelFromUrl`)은 여전히 기본 4채널만 한다 — 커스텀 채널은 주소로 알아낼
 *   규칙이 없어 담당자가 직접 고른다(틀린 자동 추측보다 안전, 와이어프레임 C 확정).
 */
function channelLabel(key, template) {
  const c = CASH_RECEIPT_CHANNELS.find(x => x.key === key);
  if (c) return c.label;
  const custom = (((template || {}).customChannels) || []).find(x => x && x.key === key);
  return custom ? custom.label : '미상';
}

/* ── 날짜 ────────────────────────────────────────────────────────────────
   ★ Date 산술 대신 Y-M-D 문자열로 다룬다 — 서버 타임존이 무엇이든 결과가 같아야 한다
     (이 값이 시트 구매일자 칸에 그대로 들어가고, 063 시트 일정 인식이 그걸 읽어 모집 정원을 정한다). */
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function parseYmd(v) {
  /* ★★ DB의 DATE 컬럼은 node-pg 가 **Date 객체**로 돌려준다(`work_orders.start_date`).
     문자열로 가정하면 `String(date).slice(0,10)` 가 'Mon Aug 03' 이 되어 조용히 파싱 실패한다
     — 프로덕션 실데이터로 잡은 버그. 문자열 테스트만으로는 드러나지 않는다.
     ★ UTC 로 읽는다: pg 는 DATE 를 UTC 자정으로 주므로 로컬 기준으로 읽으면 서버 TZ 가 음수일 때 하루 밀린다. */
  if (v instanceof Date && !isNaN(v.getTime())) {
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  }
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
   작업표의 열 = **공통 + 그 채널 행 + 켠 작업유형**. 이미 담긴 이름은 건너뛴다(같은 열 2번 방지).

   ★ 순서(와이어프레임 D 확정): `[번호·구매일자 등 자동 열] + [앞쪽 유형] + [나머지 공통] +
     [채널] + [뒤쪽 유형]`. 옵션·리뷰옵션처럼 작업지시 칸은 앞쪽(front), 택배송장번호처럼
     기록용 칸은 뒤쪽(back)에 붙인다.
   ★ **유형을 하나도 안 켜면 종전과 완전히 같은 순서**(공통 → 채널) — 안 쓰면 무변화. */
function buildColumns({ template, channel, workTypes, tabOpts = {} } = {}) {
  const norm = (arr) => (arr || []).map(s => String(s || '').trim()).filter(Boolean);
  const core = norm((template && template.core));
  const chan = norm((((template && template.channels) || {})[channel]));

  /* 켠 작업유형 = 템플릿의 유형 중 `workTypes`(키 배열)에 포함된 것. 순서는 템플릿 순서 그대로. */
  const wantedKeys = new Set((Array.isArray(workTypes) ? workTypes : []).map(k => String(k || '').trim()).filter(Boolean));
  const types = ((template && template.workTypes) || []).filter(t => t && wantedKeys.has(t.key));
  const frontCols = [];
  const backCols = [];
  types.forEach(t => {
    const target = t.position === 'front' ? frontCols : backCols;
    norm(t.columns).forEach(n => target.push({ name: n, typeKey: t.key }));
  });

  /* 공통의 **앞머리 자동 열**(번호·구매일자)을 찾는다 — 앞쪽 유형은 그 뒤에 온다.
     ★ 분류는 매퍼 파생 단일 출처를 그대로 쓴다(여기서 '번호'·'일자' 규칙을 다시 만들지 않는다). */
  const coreCls = classifyHeaders(core, tabOpts);
  let autoPrefix = 0;
  while (autoPrefix < coreCls.length && coreCls[autoPrefix].tier === 'auto') autoPrefix++;

  const seen = new Set();
  const names = [];
  const origin = [];
  const typeKeys = [];
  const push = (n, org, tk) => {
    const k = String(n).toLowerCase();
    if (seen.has(k)) return;                 // 이미 담긴 열 = 작업표에 같은 열 2번 생성 차단
    seen.add(k); names.push(n); origin.push(org); typeKeys.push(tk || null);
  };
  core.slice(0, autoPrefix).forEach(n => push(n, 'common'));
  frontCols.forEach(c => push(c.name, 'worktype', c.typeKey));
  core.slice(autoPrefix).forEach(n => push(n, 'common'));
  chan.forEach(n => push(n, 'channel'));
  backCols.forEach(c => push(c.name, 'worktype', c.typeKey));

  const cls = classifyHeaders(names, tabOpts);
  return cls.map((c, i) => ({
    name: c.header, role: c.role, label: c.label, tier: c.tier, conflict: c.conflict || null,
    origin: origin[i], typeKey: typeKeys[i],
  }));
}

/* ── 작업유형 자동 선택 조건 ─────────────────────────────────────────────
   "작업오더 내용을 보고 그 유형을 켜 둘까?"를 판정한다(사용자 확정 — 쿠팡 작업 + 상품옵션 2가지면
   채널 쿠팡 + 작업유형 상품옵션이 켜진 표가 만들어져야 한다).

   ★★ 판정은 **여기 한 곳**뿐이다 — 조건 목록은 `worktable.service.WORK_TYPE_TRIGGERS`(화면용 라벨),
     판정은 이 함수(동작). 화면에 판정 사본을 두면 "체크는 켜졌는데 서버는 안 켠" 상태가 된다.
   ★ 조건은 전부 `work_orders` 의 **실제 칸**에서 나온다. 모르는 값·판정 실패는 **켜지 않는다**
     (틀린 열을 만드느니 담당자가 직접 켜는 게 낫다 — 이 화면의 fail-soft 원칙).
   ★ `auto`(기본·옛 저장분) = 종전 동작 = 옵션 열을 가진 유형만 옵션 2종 이상일 때. */
function evalWorkTypeTrigger(trigger, ctx = {}) {
  const t = String(trigger || 'auto');
  const wo = ctx.workOrder || {};
  const optionCount = Math.max(0, parseInt(ctx.optionCount, 10) || 0);
  const hasOptionColumn = !!ctx.hasOptionColumn;
  const delivery = String(wo.delivery_type == null ? '' : wo.delivery_type);
  const reviewType = String(wo.review_type == null ? '' : wo.review_type).trim();

  switch (t) {
    case 'never': return false;
    case 'always': return true;
    case 'options_2plus': return optionCount >= 2;
    // ★ boolean 컬럼이지만 문자열('true'/'Y')로 올 수 있어 둘 다 인정한다(빈 값·false 는 안 켬).
    case 'courier_proxy': return wo.courier_proxy === true || /^(true|t|y|yes|1|예)$/i.test(String(wo.courier_proxy || ''));
    case 'delivery_real': return /실배송|실\s*발송/.test(delivery);
    case 'delivery_empty': return /빈박스|빈\s*박스/.test(delivery);
    case 'review_type_set': return reviewType.length > 0;
    case 'auto':
    default:
      return hasOptionColumn && optionCount >= 2;   // 종전 동작 보존
  }
}

/** 조건별 "왜 켜졌는지" 한 줄 — 화면이 그대로 보여 준다(근거 없는 자동 체크 금지). */
function workTypeTriggerReason(trigger, ctx = {}) {
  const wo = (ctx.workOrder || {});
  const n = Math.max(0, parseInt(ctx.optionCount, 10) || 0);
  switch (String(trigger || 'auto')) {
    case 'always': return '항상 켜는 유형';
    case 'options_2plus': return `작업오더에 상품옵션 ${n}가지`;
    case 'courier_proxy': return '작업오더 택배대행 = 예';
    case 'delivery_real': return `작업오더 배송유형 = ${String(wo.delivery_type || '실배송')}`;
    case 'delivery_empty': return `작업오더 배송유형 = ${String(wo.delivery_type || '빈박스')}`;
    case 'review_type_set': return `작업오더 리뷰유형 = ${String(wo.review_type || '')}`.trim();
    case 'auto': default: return `작업오더에 상품옵션 ${n}가지`;
  }
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
  /* ★★ 작업유형은 **명시적으로 켠 것만** 반영한다(미전송 = 없음).
     제안(`suggestedWorkTypes`)은 화면이 체크를 미리 해 주는 재료일 뿐, 여기서 조용히 적용하면
     "정하지 않았는데 정해진" 표가 만들어진다(설정 프리셋과 같은 규율). */
  const workTypes = (Array.isArray(o.workTypes) ? o.workTypes : []).map(k => String(k || '').trim()).filter(Boolean);
  const columns = buildColumns({ template, channel, workTypes });

  const rawTotal = o.total != null ? o.total : wo.recruit_count;
  const total = Math.max(0, Math.min(parseInt(rawTotal, 10) || 0, MAX_ROWS));
  const daily = Math.max(0, parseInt(o.daily != null ? o.daily : wo.daily_count, 10) || 0);
  // ★ 작업오더의 start_date 는 Date 객체일 수 있다 — parseYmd 로 정규화해 Y-M-D 문자열로 통일.
  const rawStart = o.startDate != null ? o.startDate : (wo.start_date || '');
  const parsedStart = parseYmd(rawStart);
  const startDate = parsedStart ? ymdStr(parsedStart) : '';
  /* 주말 제외 — 우선순위 = ① 미리보기 조정값 ② **작업오더 신호**(097) ③ 기본 제외.
     ★ ②는 `false` 와 "안 보냄"(NULL)을 구분해야 한다 — 구버전 인트라넷의 미전송을 `false` 로
       접으면 주말 제외가 조용히 꺼져 토·일에도 구매일이 잡힌다. */
  const skipWeekends = (o.skipWeekends !== undefined && o.skipWeekends !== null)
    ? o.skipWeekends !== false
    : (wo.skip_weekends === false || wo.skip_weekends === 'false' ? false : true);

  /* 제외 날짜(공휴일·업체 휴무) — ① 미리보기에서 담당자가 지정 ② 없으면 **작업오더 신호**(097).
     ★ 형식이 맞는 값만 받는다(잘못된 값은 조용히 무시 — 날짜 분배가 통째로 깨지는 것보다 낫다). */
  let _rawHolidays = Array.isArray(o.holidays) ? o.holidays : null;
  if (!_rawHolidays) {
    try {
      const parsedWo = Array.isArray(wo.holidays) ? wo.holidays
        : (typeof wo.holidays === 'string' && wo.holidays.trim() ? JSON.parse(wo.holidays) : []);
      _rawHolidays = Array.isArray(parsedWo) ? parsedWo : [];
    } catch (_) { _rawHolidays = []; }
  }
  const holidays = [...new Set(_rawHolidays
    .map(h => String(h == null ? '' : h).trim())
    .filter(h => !!parseYmd(h))
    .map(h => ymdStr(parseYmd(h))))].sort();

  const optKeys = o.options != null ? o.options : optionKeysFromWorkOrder(wo);
  /* 자동 선택 조건이 세는 "옵션 가지 수" — 배분 형태({key,count})로 와도 같은 수를 센다. */
  const optionKindCount = (Array.isArray(optKeys) ? optKeys : [])
    .map(x => (typeof x === 'string' ? x : String((x && x.key) || ''))).filter(v => v.trim()).length;
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
  /* ★★ 시스템이 이 줄을 **헤더로 인식하지 못하면 그 탭은 통째로 파싱되지 않는다**
     (인덱스가 안 만들어져 리뷰어 검색·제출·행배정이 전부 죽는다). 게다가 헤더 줄을 못 찾으면
     행 번호가 어긋나 작업대 표와 시트가 따로 논다. 그래서 이건 경고가 아니라 **잠금**이다.
     판정은 인덱스 빌더와 **같은 함수**(isSheetHeaderRow) — 사본을 두면 판정이 갈린다. */
  if (columns.length && !isSheetHeaderRow(columns.map(c => c.name))) {
    blockers.push({
      code: 'header_unrecognizable',
      message: '이 열 구성은 시스템이 "열 이름 줄"로 인식하지 못합니다 — 수취인·연락처·주소·결제금액처럼 시스템이 아는 열을 2개 이상 넣어 주세요.',
    });
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
  /* ★ 날짜를 나눠 놓고 쓸 칸이 없으면 조용히 사라진다 — 게다가 구매일자 칸이 없으면
     시트 일정 자동 인식이 그날 모집 정원을 파생하지 못한다(발행폼 값 경로로 되돌아간다). */
  if (days.length && !columns.some(c => c.role === 'dateStr')) {
    warnings.push({ code: 'no_date_column', message: '날짜를 나눴지만 표에 구매일자 열이 없어 기입되지 않습니다 — 그날 모집 정원도 시트에서 파생되지 않습니다. 공통 열에 구매일자 칸을 추가하세요.' });
  }

  /* ── 작업유형 목록 + 자동 제안 ────────────────────────────────────────
     ★ 제안 근거는 **열 역할에서 파생**한다 — 유형 이름이 자유 문자열이라 이름으로 맞추면
       '상품옵션'을 '옵션종류'로 바꾼 순간 제안이 조용히 죽는다. 옵션 열(role='option')을 가진
       유형은 작업오더 옵션이 2종 이상일 때 제안한다(옵션 1종 이하는 배분 자체를 안 한다).
     ★ 제안은 **체크를 미리 해 주는 것까지** — 확정은 담당자가 한다(학습은 제안까지 규율). */
  const allTypes = ((template && template.workTypes) || []).map(t => {
    const cols = classifyHeaders((t.columns || []).map(s => String(s || '').trim()).filter(Boolean), {});
    const hasOption = cols.some(c => c.role === 'option');
    const trigger = String(t.autoTrigger || 'auto');
    /* ★ 옵션 개수는 **배분 결과(buckets)가 아니라 작업오더가 말한 옵션 종류 수**로 센다 —
       배분은 총 건수가 0이면 비어 있어서, "건수를 아직 안 정한 오더"에서 제안이 조용히 죽는다. */
    const ctx = { workOrder: wo, optionCount: optionKindCount, hasOptionColumn: hasOption };
    const suggested = evalWorkTypeTrigger(trigger, ctx);
    return {
      key: t.key, label: t.label, desc: t.desc || '', position: t.position === 'front' ? 'front' : 'back',
      autoTrigger: trigger,
      columns: cols.map(c => ({ name: c.header, role: c.role, label: c.label, tier: c.tier })),
      suggested,
      suggestReason: suggested ? workTypeTriggerReason(trigger, ctx) : '',
      enabled: workTypes.includes(t.key),
    };
  });
  const suggestedWorkTypes = allTypes.filter(t => t.suggested).map(t => t.key);

  /* 켠 유형인데 그 열이 하나도 안 붙었다면(전부 이미 있는 이름) 조용히 사라진 것처럼 보인다. */
  const emptyTypes = allTypes.filter(t => t.enabled && !columns.some(c => c.typeKey === t.key));
  if (emptyTypes.length) {
    warnings.push({
      code: 'worktype_no_column',
      message: `켠 작업유형에 새로 붙은 열이 없습니다(${emptyTypes.map(t => t.label).join(', ')}) — 이미 공통·채널에 같은 이름의 열이 있습니다.`,
    });
  }

  return {
    channel, channelLabel: channelLabel(channel, template),
    channels: (typeof template === 'object' && template) ? _channelChoices(template) : [],
    columns,
    rows,
    dates: days,
    optionBuckets: buckets,
    workTypes: allTypes,
    enabledWorkTypes: workTypes,
    suggestedWorkTypes,
    totals: { rows: total, days: days.length, daily, columns: columns.length },
    startDate, skipWeekends, holidays,
    blockers, warnings,
    canCreate: blockers.length === 0,
  };
}

/** 고를 수 있는 채널 목록(기본 4 + 직접 추가) — 미리보기 드롭다운이 그대로 쓴다. */
function _channelChoices(template) {
  const custom = ((template.customChannels) || []).map(c => ({ key: c.key, label: c.label, custom: true }));
  return CASH_RECEIPT_CHANNELS.map(c => ({ key: c.key, label: c.label, custom: false })).concat(custom);
}

module.exports = {
  buildWorktablePlan, buildColumns, distributeDates, distributeOptions,
  optionKeysFromWorkOrder, channelFromUrl, channelLabel, sheetDateStr,
  evalWorkTypeTrigger, workTypeTriggerReason,
  MAX_ROWS,
};
