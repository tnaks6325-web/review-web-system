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

const _HEADER_SCAN_ROWS = 60;   // 상단 캠페인 정보 블록을 넘기기 충분(campaignSchedule 과 같은 범위)
const _DETAIL_CAP = 120;        // 정밀 보강(작업 행 수·인덱스 진단)을 돌릴 문제 탭 상한 — 초과는 고지

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

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
async function auditSheetSync({ before = null, limit = _AUDIT_TAB_CAP } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || _AUDIT_TAB_CAP, 1), _AUDIT_TAB_CAP);
  // 컷오프는 KST 날짜 문자열(YYYY-MM-DD)만 받는다 — 형식이 아니면 무시(전수 감사).
  const cutoff = (typeof before === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(before)) ? before : null;

  const { rows } = await _db().query(
    `SELECT tc.sheet_id  AS "sheetId",
            tc.tab_name  AS "tabName",
            tc.tab_gid   AS "tabGid",
            COALESCE(tc.display_name, tc.tab_name) AS "displayName",
            tc.campaign_name AS "campaignName",
            reg.reg_at   AS "registeredAt",
            rst."rawRows", rst."mirroredAt", rst."mirrorTabName",
            im.status    AS "idxStatus", im.built_at AS "idxBuiltAt",
            im.error_msg AS "idxErrorMsg", im.skip_reason AS "idxSkipReason",
            ri.cnt       AS "indexRows",
            cp.cnt       AS "boardRows"
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT MIN(c.created_at) AS reg_at FROM campaigns c WHERE c.sheet_id = tc.sheet_id
       ) reg ON TRUE
       LEFT JOIN LATERAL (
         SELECT r.row_count AS "rawRows", r.mirrored_at AS "mirroredAt", r.tab_name AS "mirrorTabName"
           FROM raw_sheet_tabs r
          WHERE r.sheet_id = tc.sheet_id
            AND (r.tab_name = tc.tab_name
                 OR (tc.tab_gid IS NOT NULL AND tc.tab_gid <> '' AND r.tab_gid = tc.tab_gid))
          ORDER BY r.mirrored_at DESC NULLS LAST LIMIT 1
       ) rst ON TRUE
       LEFT JOIN LATERAL (
         SELECT m.status, m.built_at, m.error_msg, m.skip_reason
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
      WHERE COALESCE(tc.is_closed, FALSE) = FALSE
      ORDER BY reg.reg_at ASC NULLS FIRST, tc.sheet_id, tc.tab_name
      LIMIT $1`,
    [lim]
  );

  const items = [];
  for (const r of rows) {
    const regUnknown = !r.registeredAt;
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
      rawRows: r.rawRows == null ? null : Number(r.rawRows),
      mirroredAt: r.mirroredAt || null, mirrorTabName: r.mirrorTabName || null,
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

  // 문제 있는 탭이 먼저 보이게(broken → behind → ok), 같은 급은 등록 오래된 순.
  const rank = { broken: 0, behind: 1, ok: 2 };
  items.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.registeredAt || '').localeCompare(String(b.registeredAt || '')));
  return {
    before: cutoff,
    total: items.length,
    flagged: items.filter(i => i.severity !== 'ok').length,
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

module.exports = { auditSheetSync, repairSheetSync, classifySyncRow, __setPoolForTest, _AUDIT_TAB_CAP };
