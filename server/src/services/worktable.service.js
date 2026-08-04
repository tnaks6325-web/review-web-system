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
const logger = require('../utils/logger');

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
    roles: [], unmapped: [], suggestedTemplate: { core: [], channel: {}, work: [] },
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

  return {
    tabsAnalyzed: analyzed,
    tabsWithoutHeaders: noHeaders,
    channels,
    roles,
    unmapped,
    suggestedTemplate,
    thresholds: { core: CORE_RATIO, rare: RARE_RATIO },
  };
}

module.exports = { headerStats, CORE_RATIO, RARE_RATIO };
