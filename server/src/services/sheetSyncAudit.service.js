// ═══════════════════════════════════════════════════════════════════════════
// 시트 데이터 반영 점검(sheet-sync audit) — "등록된 작업의 베이스 시트 값이
// 리뷰웹시스템에 반영되어 있는가"를 사슬 단위로 진단하고, 끊긴 고리를 기존
// 반영 경로(RAW 미러 → 인덱스 빌드 → Track B 투영)로 다시 이어 준다.
//
// 반영 사슬(이 순서가 곧 수리 순서):
//   구글시트 → ① RAW 미러(raw_sheet_tabs/rows, 주문 행배정 재료)
//            → ② 검색인덱스(review_index, smartBuild — 검색·제출·리뷰내역 재료)
//            → ③ 작업보드 투영(campaign_participants, projectTab — 리뷰웹시스템[3버전] 표)
//
// ★★ 분모는 tab_configs(등록된 작업 전체)다 — participants.listActiveTabs()는
//    raw_sheet_tabs ∩ index_master(active)에서 시작하므로 ①·②가 끊긴 탭은
//    그 목록에 아예 안 떠서(작업보드에도 안 보인다) "미반영을 찾는" 감사의
//    분모로 쓸 수 없다(projectionCoverage 가 다루는 눈속임과 같은 구조).
//    아카이브(is_closed) 탭은 제외 — 관리자 대시보드 목록과 같은 기준.
//
// ★★ 감사(audit)는 읽기 전용·시트 API 무접촉(DB만) — 조회 실패는 라우트에서
//    fail-soft. 수리(repair)는 신규 쓰기 경로 0: 검증된 기존 함수 3개만 순서대로
//    호출한다(mirrorOneSheet → buildOneSheet → projectTab). 여기서 SQL 을 직접
//    쓰면 반영 규칙이 두 벌이 된다(사본 금지).
//
// ★ 등록일 = campaigns.created_at(시트 단위 최솟값) — tab_configs 에는 생성
//   시각 컬럼이 없어 이것이 가장 가까운 신호다. 모르는 탭(reg=null)은 컷오프
//   필터에서 제외하지 않고 regUnknown 으로 함께 보여준다(조용한 누락 금지).
// ═══════════════════════════════════════════════════════════════════════════
const { logger } = require('../utils/logger');
const { detectSheetHeader } = require('../utils/sheetHeader');
const activity = require('../utils/tabActivity');

const _HEADER_SCAN_ROWS = 60;   // 상단 캠페인 정보 블록을 넘기기 충분(campaignSchedule 과 같은 범위)
const _DETAIL_CAP = 120;        // 정밀 보강(작업 행 수·인덱스 진단)을 돌릴 문제 탭 상한 — 초과는 고지

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

// ── gid 해석(순수함수) — "시트만 열리는 링크"를 "그 탭이 열리는 링크"로 ─────────
//   구글시트 URL 은 `#gid=<탭번호>` 가 있어야 그 탭으로 바로 들어간다. tab_configs.tab_gid 가
//   비어 있는 등록 작업이 많아 지금까지는 시트 첫 탭만 열렸다.
//   ★ 우선순위: 등록값(tab_configs) → RAW 미러(이름으로 찾되 **동명 탭이 1개일 때만**) → 검색인덱스.
//   ★★ 동명 탭이 2개 이상이면 확정하지 않는다(null) — 잘못된 탭으로 데려가는 링크는 빈 링크보다 나쁘다
//      (주문 행배정의 "동명탭 보류"와 같은 규율).
//   ★ 순수함수 = 회귀가드가 직접 실행. 여기서 DB 를 읽지 않는다(본 쿼리가 재료를 이미 실어 온다).
function resolveTabGid(r = {}) {
  const cfg = String(r.tabGid == null ? '' : r.tabGid).trim();
  if (cfg) return _gidOut(r, cfg, 'config');
  const mirrorGid = String(r.mirrorGid == null ? '' : r.mirrorGid).trim();
  const nameCount = Number(r.mirrorNameCount) || 0;
  if (mirrorGid && nameCount <= 1) return _gidOut(r, mirrorGid, 'mirror');
  if (mirrorGid && nameCount > 1) return _gidOut(r, '', 'ambiguous');   // 동명 탭 — 확정 불가
  const idxGid = String(r.idxGid == null ? '' : r.idxGid).trim();
  if (idxGid) return _gidOut(r, idxGid, 'index');
  return _gidOut(r, '', null);
}
function _gidOut(r, gid, source) {
  const sheetId = String(r.sheetId || '');
  const base = sheetId ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit` : null;
  return {
    resolvedGid: gid || null,
    gidSource: source,
    // gid 를 못 구하면 시트만 여는 링크(그마저 없으면 null) — "열리는데 엉뚱한 탭"보다 정직하다.
    tabUrl: base ? (gid ? `${base}#gid=${encodeURIComponent(gid)}` : base) : null,
  };
}

// ── 진단 분류(순수함수 — 회귀가드가 직접 실행) ──────────────────────────────
// row: { rawRows, dataRows, mirroredAt, idxStatus, idxBuiltAt, idxErrorMsg, indexRows, boardRows, indexHint }
// 반환: { flags: string[], severity: 'broken'|'behind'|'ok', reasonKo: string }
//   ★ 완화 금지: boardRows > indexRows 는 정상일 수 있다(수동 추가·작업표 스켈레톤 행)
//     → 플래그가 아니라 정보(boardExtra)로만 둔다. 뒤짐(behind)은 index > board 만.
//   ★★ 건수 판정은 `dataRows`(헤더 아래 실제 작업 행) 우선 — `rawRows`(미러 행 수)는
//      상단 캠페인 정보·빈 줄·헤더까지 포함한 값이라 "15건 작업이 33행"으로 보인다(실측 오해).
//      dataRows 를 못 구한 경우에만 rawRows 로 폴백한다.
function classifySyncRow(r = {}) {
  const rawRows = r.rawRows == null ? null : Number(r.rawRows);
  const dataRows = r.dataRows == null ? null : Number(r.dataRows);
  const workRows = dataRows != null ? dataRows : rawRows;   // 판정에 쓰는 "실제 작업 행" 추정치
  const indexRows = Number(r.indexRows) || 0;
  const boardRows = Number(r.boardRows) || 0;
  const hint = r.indexHint || null;
  const flags = [];
  const why = [];

  if (r.mirroredAt == null && rawRows == null) {
    flags.push('no_raw_mirror');
    why.push('RAW 미러 없음(주문 행배정·자동 반영이 이 시트를 못 본다)');
  }
  if (!r.idxStatus) {
    // ★ "어디에 없는가"를 끝까지 짚는다 — 없다는 사실만 알려주면 담당자가 다음 행동을 못 정한다.
    //   등록부 = index_master(검색인덱스 등록부). 여기 없으면 리뷰어 검색·제출이 막히고,
    //   작업보드 목록(listActiveTabs)도 이 등록부를 게이트로 쓰므로 3버전 작업목록에서도 빠진다.
    if (hint && hint.archived) {
      flags.push('index_archived');
      why.push('검색인덱스 등록부(index_master)에서 아카이브로 내려간 탭입니다 — 차수 종료 처리된 작업이면 정상, 아니면 아카이브 복구가 필요합니다');
    } else if (hint && hint.renamedTo) {
      // ★★ 신호 출처는 **RAW 미러의 현재 탭 이름**이다(index_master 가 아니라).
      //   index_master 를 보면 안 되는 이유: 감사 본 쿼리가 `tab_name = ... OR tab_gid = ...` 로
      //   **gid 우선 재매칭**을 하므로, 인덱스에 같은 gid 가 있으면 애초에 idxStatus 가 채워져
      //   이 분기에 오지 않는다(진짜 PG 검증이 잡은 도달 불가 분기 — 되살리지 말 것).
      flags.push('index_renamed');
      why.push(`시트의 실제 탭 이름은 "${hint.renamedTo}" 인데 등록은 "${hint.tabName}" 로 되어 있습니다 — 시트에서 탭 이름이 바뀐 것으로 보입니다(탭명 교정 필요)`);
    } else if (hint && hint.sheetIndexed === false) {
      flags.push('index_sheet_never_built');
      why.push('이 시트 자체가 검색인덱스 등록부(index_master)에 한 줄도 없습니다 — 시트 전체가 한 번도 빌드되지 않았습니다');
    } else {
      flags.push('index_missing');
      why.push('검색인덱스 등록부(index_master)에 이 탭이 없습니다 — 리뷰어 검색·구매양식 제출이 막히고, 리뷰웹시스템[3버전] 작업목록에도 뜨지 않습니다'
        + (hint && hint.otherTabs && hint.otherTabs.length
          ? ` (같은 시트에 등록된 탭: ${hint.otherTabs.slice(0, 3).join(' · ')}${hint.otherTabs.length > 3 ? ' 외 ' + (hint.otherTabs.length - 3) + '개' : ''})`
          : ''));
    }
  } else if (String(r.idxStatus) !== 'active') {
    flags.push('index_inactive');
    why.push(`검색인덱스 상태가 '${r.idxStatus}'(활성 아님)`);
  } else if (r.idxErrorMsg) {
    flags.push('index_error');
    why.push('마지막 인덱스 빌드가 오류로 끝남: ' + String(r.idxErrorMsg).slice(0, 120));
  } else if (!r.idxBuiltAt) {
    flags.push('index_never_built');
    why.push('인덱스가 한 번도 빌드되지 않음');
  } else if (indexRows === 0 && workRows != null && workRows > 2) {
    // 시트에는 작업 행이 있는데 인덱스는 0행 = 파싱/헤더 인식 실패 의심.
    flags.push('index_empty');
    why.push('시트에는 작업 행이 있는데 검색인덱스가 0행(헤더 인식 실패 의심)');
  }

  if (indexRows > 0 && boardRows === 0) {
    flags.push('not_projected');
    why.push('작업보드(리뷰웹시스템[3버전]) 표에 투영된 행이 없음');
  } else if (boardRows > 0 && indexRows > boardRows) {
    flags.push('projection_behind');
    why.push(`작업보드 행(${boardRows})이 검색인덱스 행(${indexRows})보다 적음(투영 뒤짐)`);
  }

  const severity = flags.some(f => f !== 'projection_behind') ? (flags.length ? 'broken' : 'ok')
                 : (flags.length ? 'behind' : 'ok');
  return {
    flags,
    severity: flags.length ? severity : 'ok',
    reasonKo: why.join(' · ') || '정상(시트 값이 반영 사슬 끝까지 도달)',
    boardExtra: boardRows > indexRows ? boardRows - indexRows : 0,
  };
}

// ── 감사: 등록 작업 전수(또는 컷오프 이전) 반영 상태 ─────────────────────────
const _AUDIT_TAB_CAP = 1500;
async function auditSheetSync({ before = null, limit = _AUDIT_TAB_CAP, includeArchived = false,
                                since = null, includeUnknown = false, includeIgnored = false } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || _AUDIT_TAB_CAP, 1), _AUDIT_TAB_CAP);
  // 컷오프는 KST 날짜 문자열(YYYY-MM-DD)만 받는다 — 형식이 아니면 무시(전수 감사).
  const cutoff = (typeof before === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(before)) ? before : null;
  // 연도 하한 — 과거 자료(기본 2026-01-01 이전)는 목록에서 빼되 **건수는 고지**한다.
  const sinceDay = activity.normalizeSince(since);

  const { rows } = await _db().query(
    `SELECT tc.sheet_id  AS "sheetId",
            tc.tab_name  AS "tabName",
            tc.tab_gid   AS "tabGid",
            COALESCE(tc.display_name, tc.tab_name) AS "displayName",
            tc.campaign_name AS "campaignName",
            reg.reg_at   AS "registeredAt",
            rst."rawRows", rst."mirroredAt", rst."mirrorTabName", rst."mirrorGid",
            mc.n         AS "mirrorNameCount",
            im.status    AS "idxStatus", im.built_at AS "idxBuiltAt", im."idxGid",
            im.error_msg AS "idxErrorMsg", im.skip_reason AS "idxSkipReason",
            ri.cnt       AS "indexRows",
            cp.cnt       AS "boardRows",
            ${activity.ACTIVITY_SELECT_SQL}
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT MIN(c.created_at) AS reg_at FROM campaigns c WHERE c.sheet_id = tc.sheet_id
       ) reg ON TRUE
       LEFT JOIN LATERAL (
         SELECT r.row_count AS "rawRows", r.mirrored_at AS "mirroredAt",
                r.tab_name AS "mirrorTabName", r.tab_gid AS "mirrorGid"
           FROM raw_sheet_tabs r
          WHERE r.sheet_id = tc.sheet_id
            AND (r.tab_name = tc.tab_name
                 OR (tc.tab_gid IS NOT NULL AND tc.tab_gid <> '' AND r.tab_gid = tc.tab_gid))
          ORDER BY r.mirrored_at DESC NULLS LAST LIMIT 1
       ) rst ON TRUE
       LEFT JOIN LATERAL (
         -- 같은 이름의 미러 탭이 2개 이상이면 gid 를 확정할 수 없다(동명 탭 보류 — 오배정 방지)
         SELECT COUNT(*)::int AS n FROM raw_sheet_tabs r2
          WHERE r2.sheet_id = tc.sheet_id AND r2.tab_name = tc.tab_name
       ) mc ON TRUE
       LEFT JOIN LATERAL (
         SELECT m.status, m.built_at, m.error_msg, m.skip_reason, m.tab_gid AS "idxGid"
           FROM index_master m
          WHERE m.sheet_id = tc.sheet_id
            AND (m.tab_name = tc.tab_name
                 OR (tc.tab_gid IS NOT NULL AND tc.tab_gid <> '' AND m.tab_gid = tc.tab_gid))
          LIMIT 1
       ) im ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS cnt FROM review_index x
          WHERE x.sheet_id = tc.sheet_id AND x.tab_name = tc.tab_name AND x.row_index IS NOT NULL
       ) ri ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS cnt FROM campaign_participants p
          WHERE p.sheet_id = tc.sheet_id AND p.tab_name = tc.tab_name AND p.deleted_at IS NULL
       ) cp ON TRUE
       ${activity.ACTIVITY_LATERAL_SQL}
      WHERE (COALESCE(tc.is_closed, FALSE) = FALSE OR $2::boolean)
      ORDER BY reg.reg_at ASC NULLS FIRST, tc.sheet_id, tc.tab_name
      LIMIT $1`,
    [lim, !!includeArchived]
  );

  // 사람이 [연도 확인]으로 시트에서 읽어 둔 실제 날짜(미러엔 표시 문자열만 남아 잃어버린 연도)
  const probeMap = await _loadProbeMap();
  // 담당자가 "복구할 필요 없다"고 치운 작업(데이터는 그대로 — 목록에서만 감춘다)
  const ignoreMap = await _loadIgnoreMap();

  const items = [];
  let filteredOld = 0, yearUnknown = 0, ignoredCount = 0;
  for (const r of rows) {
    const regUnknown = !r.registeredAt;
    // ── 연도 하한: 과거 작업은 빼고, 연도를 모르는 작업은 따로 센다(조용한 누락 금지) ──
    const act = activity.resolveActivity({ ...r, probedAt: probeMap[r.sheetId + '\t' + r.tabName] || null });
    const verdict = activity.activityVerdict(act, sinceDay, includeUnknown);
    if (verdict === 'old') { filteredOld++; continue; }
    if (verdict === 'unknown') { yearUnknown++; continue; }
    if (ignoreMap[r.sheetId + '\t' + r.tabName] && !includeIgnored) { ignoredCount++; continue; }
    // 컷오프가 있으면: 이전 등록 + 등록일 미상(놓치면 안 되는 쪽)만 남긴다.
    if (cutoff && !regUnknown) {
      const regDay = new Date(r.registeredAt).toISOString().slice(0, 10);
      if (regDay >= cutoff) continue;
    }
    const cls = classifySyncRow({
      rawRows: r.rawRows, mirroredAt: r.mirroredAt,
      idxStatus: r.idxStatus, idxBuiltAt: r.idxBuiltAt, idxErrorMsg: r.idxErrorMsg,
      indexRows: r.indexRows, boardRows: r.boardRows,
    });
    items.push({
      sheetId: r.sheetId, tabName: r.tabName, tabGid: r.tabGid || null,
      displayName: r.displayName, campaignName: r.campaignName || null,
      registeredAt: r.registeredAt, regUnknown,
      activityAt: act.activityAt, activitySource: act.activitySource, yearUnknown: act.yearUnknown,
      ignored: !!ignoreMap[r.sheetId + '\t' + r.tabName],
      rawRows: r.rawRows == null ? null : Number(r.rawRows),
      mirroredAt: r.mirroredAt || null, mirrorTabName: r.mirrorTabName || null,
      ...resolveTabGid(r),
      idxStatus: r.idxStatus || null, idxBuiltAt: r.idxBuiltAt || null,
      idxErrorMsg: r.idxErrorMsg || null,
      indexRows: Number(r.indexRows) || 0, boardRows: Number(r.boardRows) || 0,
      ...cls,
    });
  }
  // ── 문제 탭만 정밀 보강 후 재분류 ──────────────────────────────────────────
  //   ① 실제 작업 행 수(dataRows) — 미러 행 수는 상단 정보·헤더까지 세서 "15건이 33행"으로 보인다
  //   ② 검색인덱스에 왜 없는지(indexHint) — 아카이브/리네임/시트 전체 미빌드를 구분
  //   전 탭에 돌리면 탭당 쿼리라 무거우므로 **문제 탭만**(상한 초과분은 고지).
  const flaggedIdx = items.map((it, i) => ({ it, i })).filter(x => x.it.severity !== 'ok');
  const detail = flaggedIdx.slice(0, _DETAIL_CAP);
  const detailCapped = flaggedIdx.length > detail.length;
  if (detail.length) {
    const dataMap = await _countDataRows(detail.map(x => x.it)).catch(e => {
      logger.warn(`[sheetSync] 작업 행 수 계산 실패: ${e.message}`); return new Map();
    });
    const hintMap = await _indexHints(detail.map(x => x.it)).catch(e => {
      logger.warn(`[sheetSync] 인덱스 진단 실패: ${e.message}`); return new Map();
    });
    for (const { it } of detail) {
      const key = it.sheetId + '\u0000' + it.tabName;
      const dataRows = dataMap.has(key) ? dataMap.get(key) : null;
      const indexHint = hintMap.get(key) || null;
      it.dataRows = dataRows;
      it.indexHint = indexHint;
      Object.assign(it, classifySyncRow({
        rawRows: it.rawRows, dataRows, mirroredAt: it.mirroredAt,
        idxStatus: it.idxStatus, idxBuiltAt: it.idxBuiltAt, idxErrorMsg: it.idxErrorMsg,
        indexRows: it.indexRows, boardRows: it.boardRows, indexHint,
      }));
    }
  }

  // 아카이브에만 남은 탭(등록 목록에서 내려간 것)도 함께 — 복구 대상이라 화면에 보여야 한다.
  if (includeArchived) {
    const keys = new Set(items.map(i => i.sheetId + ' ' + i.tabName));
    for (const a of await listArchivedOnly(keys)) {
      if (ignoreMap[a.sheetId + '\t' + a.tabName] && !includeIgnored) { ignoredCount++; continue; }
      a.ignored = !!ignoreMap[a.sheetId + '\t' + a.tabName];
      items.push(a);
    }
  }

  // 문제 있는 탭이 먼저 보이게(broken → behind → ok), 같은 급은 등록 오래된 순.
  const rank = { broken: 0, behind: 1, ok: 2 };
  items.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.registeredAt || '').localeCompare(String(b.registeredAt || '')));
  return {
    before: cutoff,
    total: items.length,
    flagged: items.filter(i => i.severity !== 'ok').length,
    includeArchived: !!includeArchived,
    since: sinceDay, filteredOld, yearUnknown, includeUnknown: !!includeUnknown,
    ignoredCount, includeIgnored: !!includeIgnored,
    detailCapped,
    truncated: rows.length >= lim,
    items,
  };
}

// ── 실제 작업 행 수 = 헤더 아래에서 값이 하나라도 있는 행 ────────────────────
//   ★ 미러 행 수(raw_sheet_tabs.row_count)를 쓰지 않는 이유: 그 값은 상단 캠페인 정보(9행 남짓)·
//     빈 줄·헤더 줄까지 포함해서 **15건짜리 작업이 33행**으로 보인다(사용자 실측 오해).
//   ★ 헤더 탐지는 utils/sheetHeader 단일 출처(인덱스 빌더와 같은 함수) — 사본 금지.
//   ★ gid 없는 탭은 RAW 행을 찾을 키가 없다 → 계산하지 않고 null(모르면 숫자를 지어내지 않는다).
async function _countDataRows(tabs) {
  const out = new Map();
  const withGid = (tabs || []).filter(t => t.tabGid);
  if (!withGid.length) return out;
  const db = _db();
  const params = [];
  const tuples = withGid.map(t => { params.push(t.sheetId, String(t.tabGid)); return `($${params.length - 1},$${params.length})`; }).join(',');
  const { rows: head } = await db.query(
    `SELECT sheet_id, tab_gid, row_index, cells FROM raw_sheet_rows
      WHERE (sheet_id, tab_gid) IN (${tuples}) AND row_index <= ${_HEADER_SCAN_ROWS}
      ORDER BY sheet_id, tab_gid, row_index`, params);
  const byTab = new Map();
  for (const r of head) {
    const k = r.sheet_id + '\u0000' + String(r.tab_gid);
    if (!byTab.has(k)) byTab.set(k, []);
    byTab.get(k).push(r);
  }
  for (const t of withGid) {
    const hrows = byTab.get(t.sheetId + '\u0000' + String(t.tabGid)) || [];
    if (!hrows.length) continue;
    const det = detectSheetHeader(hrows.map(r => (Array.isArray(r.cells) ? r.cells : [])));
    if (det.headerRowIndex == null) continue;      // 헤더를 못 찾으면 세지 않는다(추측 금지)
    const headerRow = hrows[det.headerRowIndex - 1].row_index;
    const { rows: c } = await db.query(
      `SELECT COUNT(*)::int AS n FROM raw_sheet_rows
        WHERE sheet_id=$1 AND tab_gid=$2 AND row_index > $3
          AND jsonb_typeof(cells)='array'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(cells) v WHERE btrim(v) <> '')`,
      [t.sheetId, String(t.tabGid), headerRow]);
    out.set(t.sheetId + '\u0000' + t.tabName, c[0] ? c[0].n : 0);
  }
  return out;
}

// ── "검색인덱스에 왜 없는가" 진단 재료 ──────────────────────────────────────
//   등록부 = index_master. 아카이브(차수 종료) / 리네임(같은 gid 다른 이름) / 시트 전체 미빌드를
//   구분해야 담당자가 다음 행동(복구 vs 탭명 교정 vs 빌드)을 정할 수 있다. 읽기 전용·fail-soft.
async function _indexHints(tabs) {
  const out = new Map();
  if (!tabs || !tabs.length) return out;
  const db = _db();
  const sheetIds = [...new Set(tabs.map(t => t.sheetId))];
  const { rows: im } = await db.query(
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName", tab_gid AS "tabGid", status
       FROM index_master WHERE sheet_id = ANY($1::text[])`, [sheetIds]);
  const { rows: ar } = await db.query(
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName"
       FROM index_master_archive WHERE sheet_id = ANY($1::text[])`, [sheetIds]).catch(() => ({ rows: [] }));
  for (const t of tabs) {
    const mine = im.filter(r => r.sheetId === t.sheetId);
    // 리네임 신호 = **시트 미러의 현재 탭 이름**이 등록 이름과 다름(본 쿼리가 gid 로 매칭한 미러 행).
    //   ★★ index_master 에서 같은 gid 를 찾는 방식은 쓰지 않는다 — 본 쿼리가 gid 우선 재매칭이라
    //     인덱스에 같은 gid 행이 있으면 애초에 idxStatus 가 채워져 이 분기(미등록)에 오지 않는다.
    //     진짜 PG 검증이 그 분기가 **도달 불가**임을 잡아냈다(되살리지 말 것).
    const renamedTo = (t.mirrorTabName && t.mirrorTabName !== t.tabName) ? t.mirrorTabName : null;
    out.set(t.sheetId + '\u0000' + t.tabName, {
      tabName: t.tabName,
      sheetIndexed: mine.length > 0,
      archived: ar.some(r => r.sheetId === t.sheetId && r.tabName === t.tabName),
      renamedTo,
      otherTabs: mine.map(r => r.tabName).filter(n => n && n !== t.tabName).slice(0, 10),
    });
  }
  return out;
}

// ── 수리: 끊긴 고리를 기존 반영 경로로 다시 잇는다(신규 쓰기 경로 0) ─────────
//   순서 고정: ① RAW 미러(mirrorOneSheet force) → ② 인덱스 빌드(buildOneSheet)
//             → ③ 작업보드 투영(projectTab). ②는 빌드 락을 쓰므로 잠겨 있으면
//   locked 로 보고만 하고 ③은 그대로 진행한다(기존 인덱스 기준 투영도 의미 있음).
//   ★ 한 단계 실패가 다음 단계를 죽이지 않는다 — 각 단계 결과를 그대로 보고
//     (조용한 누락 금지). deps 주입은 테스트용(cutoverAll 과 같은 이유 — 렉시컬
//     호출은 export 스터빙이 안 먹는다).
async function repairSheetSync({ sheetId, tabName, by = 'sheet-sync-repair', deps = null } = {}) {
  if (!sheetId || !tabName) throw new Error('repairSheetSync: sheetId, tabName 필수');
  const d = deps || {
    mirrorOneSheet: require('./rawMirror.service').mirrorOneSheet,
    buildOneSheet: require('./indexBuilder.service').buildOneSheet,
    projectTab: require('./trackB.service').projectTab,
    compareWithIndex: require('./participants.service').compareWithIndex,
  };
  const steps = { mirror: null, build: null, project: null };

  try {
    const m = await d.mirrorOneSheet(sheetId, { force: true });
    steps.mirror = { ok: true, tabsMirrored: m && m.tabsMirrored, rowsWritten: m && m.rowsWritten };
  } catch (e) {
    steps.mirror = { ok: false, error: e.message };
    logger.warn(`[sheetSync] RAW 미러 실패 ${sheetId}: ${e.message}`);
  }

  try {
    const b = await d.buildOneSheet(sheetId);
    steps.build = b && b.locked ? { ok: false, locked: true, error: b.error }
                                : { ok: b ? b.ok !== false : true, detail: b || null };
  } catch (e) {
    steps.build = { ok: false, error: e.message };
    logger.warn(`[sheetSync] 인덱스 빌드 실패 ${sheetId}: ${e.message}`);
  }

  try {
    const p = await d.projectTab({ sheetId, tabName, by });
    steps.project = { ok: true, ...p };
  } catch (e) {
    steps.project = { ok: false, error: e.message };
    logger.warn(`[sheetSync] 투영 실패 ${sheetId}/${tabName}: ${e.message}`);
  }

  let compare = null;
  try { compare = await d.compareWithIndex({ sheetId, tabName }); } catch (_) {}
  const ok = !!(steps.project && steps.project.ok);
  return { ok, sheetId, tabName, steps, compare };
}

// ── tab_configs.tab_gid 백필 — 링크·매칭이 계속 어긋나지 않게 등록값을 채운다 ──
//   ★★ 쓰기 표면 = `tab_configs.tab_gid` **한 칸**, 그리고 **비어 있을 때만**(`NULLIF(tab_gid,'') IS NULL`).
//      이미 값이 있는 gid 는 절대 덮지 않는다 — 잘못된 gid 교정은 별도 경로(sync-tab-names/fix-swap)의 일이다.
//   ★ 동명 탭(미러에 같은 이름 2개 이상)은 건너뛴다(확정 불가 — 오배정 방지).
//   ★ dryRun 기본 true(미리보기 먼저).
async function backfillTabGids({ dryRun = true, by = 'sheet-sync', limit = _AUDIT_TAB_CAP } = {}) {
  const db = _db();
  const lim = Math.min(Math.max(parseInt(limit, 10) || _AUDIT_TAB_CAP, 1), _AUDIT_TAB_CAP);
  const { rows } = await db.query(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
            COALESCE(tc.display_name, tc.tab_name) AS "displayName",
            m."mirrorGid", m.n AS "mirrorNameCount", i."idxGid"
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT MIN(r.tab_gid) AS "mirrorGid", COUNT(*)::int AS n
           FROM raw_sheet_tabs r
          WHERE r.sheet_id = tc.sheet_id AND r.tab_name = tc.tab_name
       ) m ON TRUE
       LEFT JOIN LATERAL (
         SELECT im.tab_gid AS "idxGid" FROM index_master im
          WHERE im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name LIMIT 1
       ) i ON TRUE
      WHERE NULLIF(tc.tab_gid, '') IS NULL
      LIMIT $1`, [lim]);

  const fill = [], skip = [];
  for (const r of rows) {
    const g = resolveTabGid({ ...r, tabGid: null });
    if (g.resolvedGid) fill.push({ sheetId: r.sheetId, tabName: r.tabName, displayName: r.displayName, gid: g.resolvedGid, source: g.gidSource });
    else skip.push({ sheetId: r.sheetId, tabName: r.tabName, displayName: r.displayName, reason: g.gidSource === 'ambiguous' ? '동명 탭이 여러 개라 확정 불가' : '시트 사본·인덱스 어디에도 gid 가 없음' });
  }
  if (dryRun) return { ok: true, dryRun: true, missing: rows.length, fillable: fill.length, updated: 0, fill: fill.slice(0, 50), skip: skip.slice(0, 50), skipped: skip.length };

  let updated = 0;
  for (const f of fill) {
    // 조건부 UPDATE — 그 사이 누가 채웠으면 그대로 둔다(사람 값 보호).
    const { rowCount } = await db.query(
      `UPDATE tab_configs SET tab_gid = $3, updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2 AND NULLIF(tab_gid, '') IS NULL`,
      [f.sheetId, f.tabName, f.gid]);
    if (rowCount) updated++;
  }
  logger.info(`[sheetSync] tab_gid 백필: ${updated}/${fill.length} (by ${by})`);
  return { ok: true, dryRun: false, missing: rows.length, fillable: fill.length, updated, fill: fill.slice(0, 50), skip: skip.slice(0, 50), skipped: skip.length };
}

// ── 아카이브 전용 항목: tab_configs 에는 없고 아카이브에만 남은 탭 ──────────
//   ★ 아카이브는 tab_configs 행이 남지 않을 수 있어(복원이 ON CONFLICT 로 다시 만든다) 본 목록에서 빠진다.
//     "아카이브된 탭을 복구"하려면 화면에 보여야 하므로 별도로 읽어 합친다. 읽기 전용·fail-soft.
async function listArchivedOnly(existingKeys, limit = 300) {
  try {
    const { rows } = await _db().query(
      `SELECT ima.sheet_id AS "sheetId", ima.tab_name AS "tabName", ima.tab_gid AS "tabGid",
              ima.campaign_name AS "campaignName", ima.archived_at AS "archivedAt",
              ima.row_count AS "archivedRows"
         FROM index_master_archive ima
        ORDER BY ima.archived_at DESC NULLS LAST
        LIMIT $1`, [Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000)]);
    return rows
      .filter(r => !existingKeys.has(r.sheetId + ' ' + r.tabName))
      .map(r => ({
        sheetId: r.sheetId, tabName: r.tabName, tabGid: r.tabGid || null,
        displayName: r.tabName, campaignName: r.campaignName || null,
        registeredAt: null, regUnknown: true,
        rawRows: null, mirroredAt: null, mirrorTabName: null,
        ...resolveTabGid({ sheetId: r.sheetId, tabGid: r.tabGid }),
        idxStatus: null, idxBuiltAt: null, idxErrorMsg: null,
        indexRows: 0, boardRows: 0, dataRows: null,
        archivedOnly: true, archivedAt: r.archivedAt || null, archivedRows: r.archivedRows || 0,
        indexHint: { tabName: r.tabName, archived: true, sheetIndexed: false, renamedTo: null, otherTabs: [] },
        flags: ['index_archived'], severity: 'broken', boardExtra: 0,
        reasonKo: '아카이브된 작업입니다(등록 목록에서 내려감) — [아카이브 복구]로 되살린 뒤 반영하면 작업보드에 다시 나타납니다',
      }));
  } catch (e) {
    logger.warn(`[sheetSync] 아카이브 목록 조회 실패: ${e.message}`);
    return [];
  }
}

// ── 연도 확인 — 시트의 **실제 날짜값**을 읽어 잃어버린 연도를 되찾는다 ────────────
//
// ★★ 왜 필요한가(실측): 시트 셀에는 진짜 날짜값 `2024. 7. 12` 가 들어 있는데 **표시 형식이
//    `7 / 12 (금)`** 이라 연도가 안 보인다. RAW 미러는 `FORMATTED_VALUE`(=표시 문자열 그대로)로
//    저장하므로 미러만 봐서는 연도를 알 수 없다 → 그 탭들이 전부 "연도 미상"이 된다.
// ★★ **미러를 UNFORMATTED 로 바꾸면 안 된다**(완화 금지): 주문 행배정·다중컬럼 가드가
//    "시트에 표기된 그대로"를 전제로 비교하고(orderLedger 가 일부러 같은 옵션으로 읽는다),
//    바꾸는 순간 라이브 핫패스가 깨진다. 그래서 **연도 미상 탭의 날짜 컬럼만** 따로 읽는다.
// ★ 읽는 값은 구글시트 **일련번호**(예: 45485) — `parseDateToken` 이 이미 40000~60000 범위를
//   날짜로 해석한다(파서 사본 금지, 그대로 재사용).
// ★ 시트 API 를 쓰는 유일한 경로다 → **사람이 버튼을 누를 때만** 돌고, throttle 을 타며,
//   한 번에 `_PROBE_CAP` 탭까지만(초과분은 고지). 결과는 app_settings 한 키에 캐시해 재조회 0.
// ★ 셀이 **텍스트로 직접 입력**된 시트(`7 / 12 (금)` 를 글자로 친 경우)는 일련번호가 아니므로
//   여전히 연도를 알 수 없다 — 그건 미상으로 남기고 화면이 그 사실을 말한다(추측 금지).
const _PROBE_KEY = 'tab_year_probe';   // { "sheetId\ttabName": "YYYY-MM-DD" }
const _PROBE_CAP = 40;                 // 한 번에 읽을 탭 수(탭당 시트 API 1콜)

async function _loadProbeMap() {
  try {
    const { rows } = await _db().query(`SELECT value FROM app_settings WHERE key = $1 LIMIT 1`, [_PROBE_KEY]);
    if (!rows.length || !rows[0].value) return {};
    const o = JSON.parse(rows[0].value);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    logger.warn(`[sheetSync] 연도 확인 캐시 조회 실패: ${e.message}`);
    return {};   // fail-soft — 캐시가 없으면 그냥 미상으로 보일 뿐이다
  }
}

/** 0-based 컬럼 인덱스 → 시트 열 문자(A, B, ... AA) */
function _colLetter(idx) {
  let n = Number(idx) + 1, out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

async function probeUnknownYears({ limit = _PROBE_CAP, by = 'sheet-sync' } = {}) {
  const { throttledCall } = require('../utils/sheetsThrottle');
  const { readSheet } = require('./sheets.service');
  const { findDateColumnIndex } = require('./campaignSchedule.service');
  const { parseDateToken } = require('../utils/koreanDate');
  const db = _db();
  const cap = Math.min(Math.max(parseInt(limit, 10) || _PROBE_CAP, 1), 100);

  // 연도 미상 탭만 고른다(이미 아는 탭에 시트 API 를 쓰지 않는다)
  const { rows } = await db.query(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
            COALESCE(NULLIF(tc.tab_gid,''), rst.tab_gid) AS "tabGid",
            reg.reg_at AS "registeredAt", ${activity.ACTIVITY_SELECT_SQL}
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT MIN(c.created_at) AS reg_at FROM campaigns c WHERE c.sheet_id = tc.sheet_id
       ) reg ON TRUE
       LEFT JOIN LATERAL (
         SELECT r.tab_gid FROM raw_sheet_tabs r
          WHERE r.sheet_id = tc.sheet_id AND r.tab_name = tc.tab_name
          ORDER BY r.mirrored_at DESC NULLS LAST LIMIT 1
       ) rst ON TRUE
       ${activity.ACTIVITY_LATERAL_SQL}
      WHERE COALESCE(tc.is_closed, FALSE) = FALSE
      LIMIT $1`, [_AUDIT_TAB_CAP]);

  const cached = await _loadProbeMap();
  const targets = rows.filter(r => {
    if (!r.tabGid) return false;                                   // gid 없이는 그 탭을 읽을 수 없다
    if (cached[r.sheetId + '\t' + r.tabName]) return false;        // 이미 확인함(시트 재읽기 0)
    return activity.resolveActivity(r).yearUnknown;
  });
  const pick = targets.slice(0, cap);
  const capped = targets.length > pick.length;

  const found = {}, failed = [];
  for (const t of pick) {
    try {
      // 헤더 탐지는 미러로(시트 재읽기 없이) — 날짜 컬럼 위치만 알면 된다
      const { rows: head } = await db.query(
        `SELECT row_index, cells FROM raw_sheet_rows
          WHERE sheet_id=$1 AND tab_gid=$2 AND row_index <= ${_HEADER_SCAN_ROWS} ORDER BY row_index`,
        [t.sheetId, String(t.tabGid)]);
      if (!head.rows.length) { failed.push({ ...t, reason: 'no_mirror' }); continue; }
      const det = detectSheetHeader(head.rows.map(r => (Array.isArray(r.cells) ? r.cells : [])));
      if (det.headerRowIndex == null) { failed.push({ ...t, reason: 'header_unrecognizable' }); continue; }
      const colIdx = findDateColumnIndex(det.headers || []);
      if (colIdx < 0) { failed.push({ ...t, reason: 'no_date_column' }); continue; }

      // ★ 날짜 컬럼 **한 열만** 읽는다(넓은 시트에서도 전송량 일정) · gid 지정(리네임 안전)
      const col = _colLetter(colIdx);
      const esc = String(t.tabName).replace(/'/g, "''");
      const vals = await throttledCall(() => readSheet(t.sheetId, `'${esc}'!${col}:${col}`,
        { gid: String(t.tabGid), valueRenderOption: 'UNFORMATTED_VALUE' }));

      let best = null;
      for (const row of (vals || [])) {
        const tok = parseDateToken(Array.isArray(row) ? row[0] : row);
        if (!tok || tok.y == null) continue;      // 텍스트로 친 값은 연도가 없다 → 신호 아님
        const iso = `${tok.y}-${String(tok.m || 1).padStart(2, '0')}-${String(tok.d || 1).padStart(2, '0')}`;
        if (!best || iso > best) best = iso;      // 그 탭의 마지막 진행일
      }
      if (best) found[t.sheetId + '\t' + t.tabName] = best;
      else failed.push({ ...t, reason: 'no_dated_cell' });
    } catch (e) {
      logger.warn(`[sheetSync] 연도 확인 실패(${t.sheetId}/${t.tabName}): ${e.message}`);
      failed.push({ sheetId: t.sheetId, tabName: t.tabName, reason: 'read_error' });
    }
  }

  if (Object.keys(found).length) {
    const merged = { ...cached, ...found };
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [_PROBE_KEY, JSON.stringify(merged)]);
    logger.info(`[sheetSync] 연도 확인: ${Object.keys(found).length}개 탭 (by ${by})`);
  }
  return {
    ok: true, unknownTabs: targets.length, probed: pick.length, capped,
    resolved: Object.keys(found).length,
    failed: failed.slice(0, 30).map(f => ({ tabName: f.tabName, reason: f.reason })),
    failedCount: failed.length,
    sample: Object.entries(found).slice(0, 10).map(([k, v]) => ({ tabName: k.split('\t')[1], date: v })),
  };
}

// ── 목록에서 제외 — "복구할 필요 없는 작업"을 담당자가 치운다 ──────────────────
//   ★★ **데이터를 지우지 않는다**(완화 금지): 시트·검색인덱스·아카이브·작업보드 어디도 건드리지
//      않고, 이 점검 화면의 목록에서만 감춘다. 실제 삭제는 되돌릴 수 없어 점검 도구가 할 일이 아니다.
//   ★ 저장은 app_settings 한 키(JSON) — 신규 테이블·마이그레이션 0(worktable_template 과 같은 관용구).
//   ★ 되돌리기(undo)가 항상 가능하고, 제외 건수는 화면에 고지된다(조용한 누락 금지).
const _IGNORE_KEY = 'sheet_sync_ignored';   // { "sheetId\ttabName": "제외 시각" }

async function _loadIgnoreMap() {
  try {
    const { rows } = await _db().query(`SELECT value FROM app_settings WHERE key = $1 LIMIT 1`, [_IGNORE_KEY]);
    if (!rows.length || !rows[0].value) return {};
    const o = JSON.parse(rows[0].value);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    logger.warn(`[sheetSync] 제외 목록 조회 실패: ${e.message}`);
    return {};   // fail-soft — 못 읽으면 아무것도 감추지 않는다(숨기는 쪽으로 실패하지 않는다)
  }
}

async function setIgnored({ sheetId, tabName, ignored = true, by = 'sheet-sync' } = {}) {
  if (!sheetId || !tabName) throw new Error('setIgnored: sheetId, tabName 필수');
  const map = await _loadIgnoreMap();
  const key = sheetId + '\t' + tabName;
  if (ignored) map[key] = new Date().toISOString();
  else delete map[key];
  await _db().query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [_IGNORE_KEY, JSON.stringify(map)]);
  logger.info(`[sheetSync] 목록 ${ignored ? '제외' : '복원'}: ${sheetId}/${tabName} (by ${by})`);
  return { ok: true, sheetId, tabName, ignored, total: Object.keys(map).length };
}

module.exports = { auditSheetSync, repairSheetSync, classifySyncRow, resolveTabGid, backfillTabGids, probeUnknownYears, setIgnored, __setPoolForTest, _AUDIT_TAB_CAP };
