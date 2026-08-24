/**
 * 작업표(worktable) — M1: 헤더 학습 리포트.
 *
 * "작업표에 어떤 열이 고정으로 들어가고 어떤 열이 변칙인가"를 **운영 중인 실제 탭들의 헤더 통계**로 답한다.
 *
 * ★ 읽기 전용·fail-soft: 미러(raw_sheet_tabs)와 탭 설정만 조회한다.
 *   - **구글시트 재읽기 0**(쿼터 무영향) — RAW 미러 스냅샷만 본다.
 *   - 라이브 경로(주문원장·행배정·인덱스빌드)를 일절 참조하지 않는다.
 *   - 상태를 바꾸지 않는다(순수 집계). 이 파일에는 INSERT/UPDATE/DELETE 가 없다.
 *
 * ★ 분류는 `utils/worktableTemplate.js` 가 **매퍼에서 파생**한다(사본 금지) — 이 파일은 집계만 한다.
 */

const getPool = () => require('../db/pool');
const { classifyHeaders, inferChannelFromHeaders, ROLE_META, roleOrder } = require('../utils/worktableTemplate');
// ★ 구조분해 필수 — 이 모듈은 `{ logger }` 를 내보낸다. 통째로 받으면 `logger.warn` 이
//   undefined 라 fail-soft catch 안에서 TypeError 가 나고, 빈 리포트 대신 500 이 나간다
//   (방어하려던 지점이 오히려 터지는 자리라 더 나쁘다).
const { logger } = require('../utils/logger');

/** 고정(코어) 판정 문턱 — 이 비율 이상의 탭에 등장하면 "거의 모든 작업에 공통". */
const CORE_RATIO = 0.8;
/** 이 비율 미만이면 "일부 작업에만" = 변칙 후보. 사이 구간은 '흔함'으로 따로 보여 준다. */
const RARE_RATIO = 0.3;

function _tierOf(ratio) {
  if (ratio >= CORE_RATIO) return 'fixed';
  if (ratio >= RARE_RATIO) return 'common';
  return 'rare';
}

/**
 * 활성 탭들의 헤더를 모아 역할·채널별로 집계한다.
 *
 * @param {{limit?:number}} [opts]
 * @returns {Promise<object>} 리포트(아래 shape). 실패해도 throw 하지 않고 빈 리포트를 반환한다.
 */
async function headerStats({ limit = 500 } = {}) {
  const empty = {
    tabsAnalyzed: 0, tabsWithoutHeaders: 0,
    channels: { coupang: 0, naver: 0, both: 0, unknown: 0 },
    roles: [], unmapped: [], statusConflicts: [],
    suggestedTemplate: { core: [], channel: {}, work: [] }, suggestedCore: [],
    thresholds: { core: CORE_RATIO, rare: RARE_RATIO },
  };
  let rows;
  try {
    const db = getPool();
    const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
    // ★ LATERAL LIMIT 1 — 동명 탭/다중 행으로 인한 곱증식 차단(레포 관용구).
    const q = await db.query(
      `SELECT rst.sheet_id AS "sheetId", rst.tab_gid AS "tabGid", rst.tab_name AS "tabName",
              rst.spreadsheet_title AS "spreadsheetTitle",
              COALESCE(rst.detected_headers, rst.headers) AS headers,
              tc.income_type AS "incomeType",
              ri.submit_col AS "submitCol", ri.submit_col2 AS "submitCol2"
         FROM raw_sheet_tabs rst
         LEFT JOIN LATERAL (
              SELECT t.income_type FROM tab_configs t
               WHERE t.sheet_id = rst.sheet_id
                 AND (t.tab_gid = rst.tab_gid OR t.tab_name = rst.tab_name)
               ORDER BY (t.tab_gid = rst.tab_gid) DESC LIMIT 1
         ) tc ON TRUE
         LEFT JOIN LATERAL (
              SELECT r.submit_col, r.submit_col2 FROM review_index r
               WHERE r.sheet_id = rst.sheet_id AND r.tab_name = rst.tab_name
                 AND (r.submit_col IS NOT NULL OR r.submit_col2 IS NOT NULL)
               LIMIT 1
         ) ri ON TRUE
        WHERE rst.is_system_tab = FALSE
          AND EXISTS (SELECT 1 FROM index_master im
                       WHERE im.status = 'active' AND im.sheet_id = rst.sheet_id
                         AND (im.tab_gid = rst.tab_gid OR im.tab_name = rst.tab_name))
        ORDER BY rst.spreadsheet_title, rst.tab_name
        LIMIT $1`,
      [lim]
    );
    rows = q.rows;
  } catch (err) {
    logger.warn(`[worktable/headerStats] 조회 실패 — 빈 리포트 반환: ${err.message}`);
    return empty;
  }

  const channels = { coupang: 0, naver: 0, both: 0, unknown: 0 };
  // role → { tabs:Set, variants: Map(headerName → count) }
  const byRole = new Map();
  // 미분류 헤더 → { tabs:count, sample:원본 표기 }
  const byUnmapped = new Map();
  // ★ 상태 칸(리뷰제출·입금)인데 매퍼도 그 열에 쓰는 탭 — 컬럼 disjoint 위반 신호(조용히 삼키지 않는다).
  const byConflict = new Map();
  let analyzed = 0;
  let noHeaders = 0;

  for (const r of rows) {
    const headers = Array.isArray(r.headers) ? r.headers : null;
    if (!headers || !headers.length) { noHeaders++; continue; }
    analyzed++;

    const ch = inferChannelFromHeaders(headers);
    channels[ch] = (channels[ch] || 0) + 1;

    let cls;
    try {
      cls = classifyHeaders(headers, { submitCol: r.submitCol, submitCol2: r.submitCol2 });
    } catch (err) {
      // 한 탭의 분류 실패가 전체 리포트를 죽이지 않는다(fail-soft).
      logger.warn(`[worktable/headerStats] 분류 실패 (${r.tabName}): ${err.message}`);
      continue;
    }

    // 한 탭 안에서 같은 역할이 여러 열에 나와도 "그 탭에 있다"는 1회만 센다.
    const seenRoles = new Set();
    for (const c of cls) {
      if (!c.header) continue;
      if (c.conflict) {
        const ck = `${c.header.toLowerCase()}\t${c.role}\t${c.conflict}`;
        if (!byConflict.has(ck)) {
          byConflict.set(ck, { header: c.header, role: c.role, mapperRole: c.conflict, tabs: new Set() });
        }
        byConflict.get(ck).tabs.add(`${r.tabName}`);
      }
      if (c.role) {
        if (!byRole.has(c.role)) byRole.set(c.role, { tabs: new Set(), variants: new Map() });
        const e = byRole.get(c.role);
        if (!seenRoles.has(c.role)) { e.tabs.add(`${r.sheetId}\t${r.tabGid}`); seenRoles.add(c.role); }
        e.variants.set(c.header, (e.variants.get(c.header) || 0) + 1);
      } else {
        const key = c.header.toLowerCase();
        if (!byUnmapped.has(key)) byUnmapped.set(key, { sample: c.header, tabs: new Set() });
        byUnmapped.get(key).tabs.add(`${r.sheetId}\t${r.tabGid}`);
      }
    }
  }

  const denom = analyzed || 1;
  const roles = [...byRole.entries()].map(([role, e]) => {
    const meta = ROLE_META[role] || {};
    const tabCount = e.tabs.size;
    const ratio = tabCount / denom;
    return {
      role,
      label: meta.label || role,
      layer: meta.tier || 'work',          // core|auto|channel|work|status (설계상 계층)
      frequency: _tierOf(ratio),           // fixed|common|rare (실측 빈도)
      tabCount,
      ratio: Math.round(ratio * 1000) / 1000,
      headerVariants: [...e.variants.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
    };
  }).sort((a, b) => roleOrder(a.role) - roleOrder(b.role));

  const unmapped = [...byUnmapped.values()]
    .map(v => {
      const tabCount = v.tabs.size;
      const ratio = tabCount / denom;
      return { name: v.sample, tabCount, ratio: Math.round(ratio * 1000) / 1000, frequency: _tierOf(ratio) };
    })
    .sort((a, b) => b.tabCount - a.tabCount)
    .slice(0, 40);

  // 제안 템플릿 — ★ 제안일 뿐이며 실제 생성은 미리보기에서 사람이 확정한다(오분류 안전장치).
  const suggestedTemplate = {
    core: roles.filter(r => r.layer !== 'channel' && r.layer !== 'work' && r.frequency === 'fixed')
               .map(r => ({ role: r.role, label: r.label, layer: r.layer })),
    channel: {
      coupang: roles.some(r => r.role === 'userId') ? ['쿠팡ID'] : [],
      naver: roles.some(r => r.role === 'userId') ? ['네이버아이디'] : [],
    },
    work: roles.filter(r => r.layer === 'work').map(r => ({ role: r.role, label: r.label, layer: r.layer })),
  };

  /* ★ "통계에서 불러오기"가 채울 **실제 헤더 이름** 목록.
     역할이 아니라 이름이어야 하는 이유: 작업표에 만들 열의 이름이 곧 매퍼 판정을 결정한다
     (예 '연락처'로 만들어야 제출이 그 칸에 전화번호를 쓴다). 역할마다 가장 많이 쓰이는
     표기를 고른다 — 우리 시트들이 실제로 쓰는 이름이라 리뷰어·직원 모두에게 낯설지 않다.
     ★ 이 파생을 프론트에 두지 않는다(사본 금지 — 두 곳에서 다른 이름을 고르면 어긋난다). */
  const suggestedCore = roles
    .filter(r => r.layer !== 'channel' && r.layer !== 'work' && r.frequency === 'fixed')
    .map(r => (r.headerVariants[0] || {}).name)
    .filter(Boolean);

  const statusConflicts = [...byConflict.values()]
    .map(c => ({
      header: c.header,
      role: c.role,
      roleLabel: (ROLE_META[c.role] || {}).label || c.role,
      mapperRole: c.mapperRole,
      mapperLabel: (ROLE_META[c.mapperRole] || {}).label || c.mapperRole,
      tabCount: c.tabs.size,
    }))
    .sort((a, b) => b.tabCount - a.tabCount)
    .slice(0, 20);

  return {
    tabsAnalyzed: analyzed,
    tabsWithoutHeaders: noHeaders,
    channels,
    roles,
    unmapped,
    statusConflicts,
    suggestedTemplate,
    suggestedCore,
    thresholds: { core: CORE_RATIO, rare: RARE_RATIO },
  };
}

/* ══════════════════════════════════════════════════════════════════
   표준 열 템플릿 — 관리자가 확정하는 "우리 작업표의 기본 열"
   ══════════════════════════════════════════════════════════════════
   ★ 저장은 `app_settings` 키 하나(JSON) — 신규 테이블·마이그레이션 없음.
     헤더 학습 리포트는 "무엇이 흔한가"를 보여줄 뿐이고, **무엇을 쓸지 정하는 건 사람**이다.
     그 결정을 여기에 못박아 M2(작업표 생성)의 기본값으로 쓴다.
   ★ 저장하는 것은 **역할이 아니라 열 이름**이다 — 작업표에 만들 열의 이름이 곧 매퍼 판정을
     결정하기 때문(예 '연락처'라고 만들어야 제출이 그 칸에 전화번호를 쓴다).
   ★ Q3 확정(채널별 기본): 코어 = 항상 들어가는 열, 채널별 = 그 채널일 때만 붙는 열.
     업체별 원장은 만들지 않는다.
   ══════════════════════════════════════════════════════════════════ */
const TEMPLATE_KEY = 'worktable_template';
const MAX_COLS = 60;        // 오붙여넣기·무한증식 방지(시트 열 수 현실 상한을 넉넉히 넘김)
const MAX_NAME_LEN = 40;    // 시트 헤더로 쓸 이름이라 길면 표가 무너진다
const MAX_CUSTOM_CHANNELS = 12;   // 직접 추가 채널 상한(폭주 방지 — 현실 채널 수를 넉넉히 넘김)
const MAX_WORK_TYPES = 12;        // 작업유형 상한(같은 이유)
/** 채널 키 — 현금영수증 발행방법과 **같은 4채널**(utils/cashReceiptChannels.js 가 단일 출처). */
const { CASH_RECEIPT_CHANNELS } = require('../utils/cashReceiptChannels');
const CHANNEL_KEYS = CASH_RECEIPT_CHANNELS.map(c => c.key);
/** 기본 4채널 키 집합 — **삭제 불가**(현영 발행방법 안내 등 다른 기능과 짝을 이룬다). */
const BUILTIN_CHANNEL_KEYS = new Set(CHANNEL_KEYS);

/** 열 이름 목록 정규화: 트림 · 빈값 제거 · 길이 제한 · **대소문자 무시 중복 제거**(순서 보존). */
function _normNames(arr) {
  const out = [];
  const seen = new Set();
  for (const v of (Array.isArray(arr) ? arr : [])) {
    const name = String(v == null ? '' : v).trim().slice(0, MAX_NAME_LEN);
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;      // 같은 열을 두 번 만들면 시트가 깨진다
    seen.add(k);
    out.push(name);
    if (out.length >= MAX_COLS) break;
  }
  return out;
}

/**
 * 템플릿 열 이름들을 분류하고 **사람이 알아야 할 경고**를 붙인다.
 * ★ 분류는 매퍼 파생 단일 출처(`classifyHeaders`) — 여기서 규칙을 다시 만들지 않는다.
 */
function _annotate(names) {
  const cls = classifyHeaders(names, {});
  const roleCount = new Map();
  cls.forEach(c => { if (c.role) roleCount.set(c.role, (roleCount.get(c.role) || 0) + 1); });
  return cls.map(c => ({
    name: c.header,
    role: c.role,
    label: c.label,
    tier: c.tier,
    // ★ 제출 매칭 설명 — 역할 단일 출처(ROLE_META)의 문장을 그대로 싣는다(프론트 사본 금지).
    fill: c.fill,
    // ★ 같은 역할이 두 칸 이상 = 제출이 **같은 값을 두 칸에 쓴다**(대개 실수).
    duplicateRole: !!(c.role && roleCount.get(c.role) > 1),
    // 역할 없음 = 제출이 값을 쓰지 않는 열(리뷰제출·입금 같은 상태 칸이나 관리자 메모면 정상).
    writtenBySubmit: !!c.role && c.tier !== 'status',
  }));
}

/* ══════════════════════════════════════════════════════════════════
   직접 추가한 작업채널 · 작업유형 (와이어프레임 C·D)
   ══════════════════════════════════════════════════════════════════
   ★★ 저장은 여전히 `app_settings` **한 키**다 — 신규 테이블·마이그레이션 0.
   ★ **키는 서버가 발급**한다(`c1`·`t1` …). 화면이 보낸 키는 형식이 맞을 때만 인정하고,
     기본 4채널 키와 겹치면 거부한다 — 겹치면 그 채널 열이 조용히 덮인다.
   ★ 한 번 발급한 키는 바꾸지 않는다(라벨만 바꾼다) — 키가 바뀌면 그 채널에 담아 둔
     열 구성이 통째로 고아가 된다(현영 이미지 키와 같은 규율).
   ══════════════════════════════════════════════════════════════════ */
const KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_LABEL_LEN = 24;

/** `c` / `t` 접두 + 번호 발급기 — 기존 키의 최대 번호 다음 값(삭제 후 재사용 안 함). */
function _keyMinter(prefix, existing) {
  let max = 0;
  existing.forEach(k => {
    const m = new RegExp('^' + prefix + '(\\d+)$').exec(String(k || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  });
  return () => `${prefix}${++max}`;
}

/** 직접 추가 채널 목록 정규화 — [{key,label}]. 기본 채널 키·중복 키·빈 라벨은 버린다. */
function _normCustomChannels(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const keys = list.map(c => (c && c.key) || '').filter(k => KEY_RE.test(k) && !BUILTIN_CHANNEL_KEYS.has(k));
  const mint = _keyMinter('c', keys);
  const out = [];
  const seenKey = new Set(BUILTIN_CHANNEL_KEYS);
  const seenLabel = new Set(CASH_RECEIPT_CHANNELS.map(c => c.label.toLowerCase()));
  for (const c of list) {
    const label = String((c && c.label) || '').trim().slice(0, MAX_LABEL_LEN);
    if (!label || seenLabel.has(label.toLowerCase())) continue;   // 같은 이름 채널 중복 차단
    let key = String((c && c.key) || '').trim();
    if (!KEY_RE.test(key) || seenKey.has(key)) key = mint();
    seenKey.add(key); seenLabel.add(label.toLowerCase());
    out.push({ key, label });
    if (out.length >= MAX_CUSTOM_CHANNELS) break;
  }
  return out;
}

/**
 * ★★ 작업유형 **자동 선택 조건** — 작업오더 내용을 보고 그 유형을 켤지 정하는 규칙(사용자 확정).
 *
 * 예) 작업오더가 "쿠팡 작업 + 상품옵션 2가지" 면 → 채널은 상품 URL 로 쿠팡이 잡히고,
 *     `options_2plus` 조건을 가진 '상품옵션' 유형이 켜진 채로 작업표 미리보기가 열린다.
 *
 * ★ **닫힌 목록**이다(자유 입력 금지) — 조건은 `work_orders` 의 **실제 칸**에서 파생돼야 하고,
 *   판정은 `utils/worktablePlan.evalWorkTypeTrigger` 한 곳에서만 한다(규칙 사본 금지).
 * ★ 값이 없거나 모르는 값은 `auto` = **기존 동작 그대로**(옵션 열을 가진 유형만 옵션 2종 이상일 때
 *   제안). 조건이 늘어도 이미 저장된 설정이 조용히 달라지지 않는다.
 */
const WORK_TYPE_TRIGGERS = [
  { key: 'auto',            label: '기본 — 옵션 열이 있으면 옵션 2가지 이상일 때' },
  { key: 'never',           label: '직접 고를 때만 (자동 선택 안 함)' },
  { key: 'always',          label: '항상 켬' },
  { key: 'options_2plus',   label: '상품옵션이 2가지 이상일 때' },
  { key: 'courier_proxy',   label: '택배대행이 \'예\'일 때' },
  { key: 'delivery_real',   label: '배송유형이 실배송일 때' },
  { key: 'delivery_empty',  label: '배송유형이 빈박스일 때' },
  { key: 'delivery_recall', label: '배송유형이 회수일 때' },
  { key: 'review_type_set', label: '리뷰유형이 적혀 있을 때' },
];
const WORK_TYPE_TRIGGER_KEYS = new Set(WORK_TYPE_TRIGGERS.map(t => t.key));

/**
 * 작업유형 목록 정규화 — [{key,label,desc,position,autoTrigger,columns}].
 * position: 'front' = 자동 열(번호·구매일자) 바로 뒤 / 'back' = 맨 뒤(비고 앞).
 *   ★ 값이 이상하면 'back'(맨 뒤) — 앞쪽에 잘못 끼면 기존 열 순서를 흔든다.
 */
function _normWorkTypes(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const keys = list.map(t => (t && t.key) || '').filter(k => KEY_RE.test(k));
  const mint = _keyMinter('t', keys);
  const out = [];
  const seenKey = new Set();
  const seenLabel = new Set();
  for (const t of list) {
    const label = String((t && t.label) || '').trim().slice(0, MAX_LABEL_LEN);
    if (!label || seenLabel.has(label.toLowerCase())) continue;
    let key = String((t && t.key) || '').trim();
    if (!KEY_RE.test(key) || seenKey.has(key)) key = mint();
    seenKey.add(key); seenLabel.add(label.toLowerCase());
    const trig = String((t && t.autoTrigger) || '').trim();
    out.push({
      key, label,
      desc: String((t && t.desc) || '').trim().slice(0, 80),
      position: (t && t.position) === 'front' ? 'front' : 'back',
      // 모르는 값은 'auto' — 기존 저장분(필드 없음)이 그대로 옛 동작을 유지한다.
      autoTrigger: WORK_TYPE_TRIGGER_KEYS.has(trig) ? trig : 'auto',
      columns: _normNames(t && t.columns),
    });
    if (out.length >= MAX_WORK_TYPES) break;
  }
  return out;
}

/** 기본 4채널 + 직접 추가 채널 — 화면·계획이 함께 쓰는 채널 목록 단일 출처. */
function channelList(tpl) {
  const custom = ((tpl && tpl.customChannels) || []).map(c => ({ key: c.key, label: c.label, icon: '🏷', custom: true }));
  return CASH_RECEIPT_CHANNELS.map(c => ({ key: c.key, label: c.label, icon: c.icon, custom: false })).concat(custom);
}

function _emptyTemplate() {
  const channels = {};
  CHANNEL_KEYS.forEach(k => { channels[k] = []; });
  // templateSheetId = 작업표를 만들 때 복사할 회사 템플릿 시트(서식·공지문 원본).
  //   ★ 전사 설정이라 서버에 둔다 — 종전엔 관리자 브라우저 localStorage 에만 있어
  //     서버가 알 수 없었고 사람마다 값이 달랐다(프로덕션 테스트에서 드러난 문제).
  return { core: [], channels, customChannels: [], workTypes: [], templateSheetId: '', updatedAt: null, updatedBy: null };
}

/** 저장·조회가 함께 쓰는 파생 — 채널별/유형별 열 분류(사본 금지). */
function _decorate(t) {
  const channelColumns = {};
  Object.keys(t.channels || {}).forEach(k => { channelColumns[k] = _annotate(t.channels[k]); });
  const workTypeColumns = {};
  (t.workTypes || []).forEach(w => { workTypeColumns[w.key] = _annotate(w.columns); });
  return {
    ...t,
    configured: (t.core || []).length > 0,
    columns: _annotate(t.core),
    channelColumns,
    workTypeColumns,
    channelList: channelList(t),
    // 화면이 조건 드롭다운을 그릴 때 쓰는 목록 — 서버가 내려 준다(프론트 사본 금지).
    triggers: WORK_TYPE_TRIGGERS,
  };
}

/** 구글시트 URL 또는 ID → ID. 잘못된 값은 빈 문자열(추측 금지). */
function normalizeSheetId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
}

/** 저장된 템플릿(없으면 빈 템플릿) + 분류/경고. 조회 실패는 빈 템플릿(fail-soft). */
async function getTemplate() {
  let saved = _emptyTemplate();
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = $1 LIMIT 1`, [TEMPLATE_KEY]);
    if (rows.length && rows[0].value) {
      const j = JSON.parse(rows[0].value);
      saved.core = _normNames(j.core);
      saved.customChannels = _normCustomChannels(j.customChannels);
      saved.workTypes = _normWorkTypes(j.workTypes);
      // ★ 채널 열은 **기본 4채널 + 저장된 커스텀 채널 키**에 대해서만 읽는다
      //   (목록에 없는 키의 열은 버린다 — 삭제된 채널의 열이 유령으로 남지 않게).
      channelList(saved).forEach(c => { saved.channels[c.key] = _normNames((j.channels || {})[c.key]); });
      saved.templateSheetId = normalizeSheetId(j.templateSheetId);
      saved.updatedAt = j.updatedAt || null;
      saved.updatedBy = j.updatedBy || null;
    }
  } catch (err) {
    // 파싱 실패·조회 실패 모두 "설정 없음"으로 수렴 — 설정 화면이 통째로 죽지 않게.
    logger.warn(`[worktable/getTemplate] 실패 — 빈 템플릿 반환: ${err.message}`);
    saved = _emptyTemplate();
  }
  return _decorate(saved);
}

/** 템플릿 저장. 유효성은 서버가 최종 판정(정규화 후 저장·반환). */
async function saveTemplate({ core, channels, customChannels, workTypes, templateSheetId, by } = {}) {
  const next = _emptyTemplate();
  next.core = _normNames(core);
  next.customChannels = _normCustomChannels(customChannels);
  next.workTypes = _normWorkTypes(workTypes);
  // 커스텀 채널 정규화에서 키가 새로 발급될 수 있으므로 **정규화된 목록 기준**으로 열을 받는다.
  channelList(next).forEach(c => { next.channels[c.key] = _normNames((channels || {})[c.key]); });
  next.templateSheetId = normalizeSheetId(templateSheetId);
  next.updatedAt = new Date().toISOString();
  next.updatedBy = String(by || '').slice(0, 100) || null;

  const db = getPool();
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [TEMPLATE_KEY, JSON.stringify(next)]
  );
  return _decorate(next);
}

module.exports = {
  headerStats, getTemplate, saveTemplate, normalizeSheetId, channelList,
  CORE_RATIO, RARE_RATIO, TEMPLATE_KEY, CHANNEL_KEYS, MAX_COLS, MAX_NAME_LEN,
  MAX_CUSTOM_CHANNELS, MAX_WORK_TYPES, WORK_TYPE_TRIGGERS,
};
