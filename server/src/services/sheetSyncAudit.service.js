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

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

// ── 진단 분류(순수함수 — 회귀가드가 직접 실행) ──────────────────────────────
// row: { rawRows, mirroredAt, idxStatus, idxBuiltAt, idxErrorMsg, indexRows, boardRows }
// 반환: { flags: string[], severity: 'broken'|'behind'|'ok', reasonKo: string }
//   ★ 완화 금지: boardRows > indexRows 는 정상일 수 있다(수동 추가·작업표 스켈레톤 행)
//     → 플래그가 아니라 정보(boardExtra)로만 둔다. 뒤짐(behind)은 index > board 만.
function classifySyncRow(r = {}) {
  const rawRows = r.rawRows == null ? null : Number(r.rawRows);
  const indexRows = Number(r.indexRows) || 0;
  const boardRows = Number(r.boardRows) || 0;
  const flags = [];
  const why = [];

  if (r.mirroredAt == null && rawRows == null) {
    flags.push('no_raw_mirror');
    why.push('RAW 미러 없음(주문 행배정·자동 반영이 이 시트를 못 본다)');
  }
  if (!r.idxStatus) {
    flags.push('index_missing');
    why.push('검색인덱스에 등록 자체가 없음(리뷰어 검색·제출 불가 — 탭명/gid 불일치 또는 미빌드 의심)');
  } else if (String(r.idxStatus) !== 'active') {
    flags.push('index_inactive');
    why.push(`검색인덱스 상태가 '${r.idxStatus}'(활성 아님)`);
  } else if (r.idxErrorMsg) {
    flags.push('index_error');
    why.push('마지막 인덱스 빌드가 오류로 끝남: ' + String(r.idxErrorMsg).slice(0, 120));
  } else if (!r.idxBuiltAt) {
    flags.push('index_never_built');
    why.push('인덱스가 한 번도 빌드되지 않음');
  } else if (indexRows === 0 && rawRows != null && rawRows > 2) {
    // RAW 에는 데이터가 있는데(헤더 제외 추정 임계 2행) 인덱스는 0행 = 파싱/헤더 인식 실패 의심.
    flags.push('index_empty');
    why.push('시트에는 데이터가 있는데 검색인덱스가 0행(헤더 인식 실패 의심)');
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
            rst."rawRows", rst."mirroredAt",
            im.status    AS "idxStatus", im.built_at AS "idxBuiltAt",
            im.error_msg AS "idxErrorMsg", im.skip_reason AS "idxSkipReason",
            ri.cnt       AS "indexRows",
            cp.cnt       AS "boardRows"
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT MIN(c.created_at) AS reg_at FROM campaigns c WHERE c.sheet_id = tc.sheet_id
       ) reg ON TRUE
       LEFT JOIN LATERAL (
         SELECT r.row_count AS "rawRows", r.mirrored_at AS "mirroredAt"
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
      mirroredAt: r.mirroredAt || null,
      idxStatus: r.idxStatus || null, idxBuiltAt: r.idxBuiltAt || null,
      indexRows: Number(r.indexRows) || 0, boardRows: Number(r.boardRows) || 0,
      ...cls,
    });
  }
  // 문제 있는 탭이 먼저 보이게(broken → behind → ok), 같은 급은 등록 오래된 순.
  const rank = { broken: 0, behind: 1, ok: 2 };
  items.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.registeredAt || '').localeCompare(String(b.registeredAt || '')));
  return {
    before: cutoff,
    total: items.length,
    flagged: items.filter(i => i.severity !== 'ok').length,
    truncated: rows.length >= lim,
    items,
  };
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
