// ═══════════════════════════════════════════════════════════════════════════
// 시트 우위 동기화(sheet-slot sync) — 탈 구글시트 마지막 트리거의 1차
//
//   기준(원본)은 리뷰웹시스템이다. 다만 지금은 **시트에 준비된 인원·일정이 시스템 표보다
//   많은 작업**이 있다(실측: 8/3 우레온 — 시트 100행 vs 표 20행). 그래서 순서는 하나뿐이다.
//     ① 시트 우위 점검 → ② 표 슬롯 백필 → ③ 공고 정원 교정 → (다음 단계) 시트 연결 끊기
//
// ★★ 왜 표에 자리조차 없었나(구조): 표(campaign_participants)는 검색인덱스(review_index)를
//    거쳐 채워지는데, 그 파서가 **이름 없는 행을 버린다**(columnResolver `if (!name) return null`).
//    시트에 구매일자·리뷰옵션만 적어 둔 "준비 행"은 그래서 표에 들어올 길이 없었다.
//    → 이름이 없어도 살아남는 경로(RAW 미러)에서 직접 읽어 슬롯으로 만든다.
//
// ★ 읽기 소스 = RAW 미러(raw_sheet_rows) — campaignSchedule(063)이 일정을 읽는 그 소스.
//   **라이브 시트 읽기 0**(구글 쿼터 무영향). 5분 주기 미러라 방금 붙여넣은 행은 다음 주기에 보인다.
// ★ 판정 사본 금지: 헤더 탐지 = utils/sheetHeader · 날짜 컬럼 = campaignSchedule.findDateColumnIndex ·
//   날짜 파싱 = utils/koreanDate · **옵션 칸 = orderLedger.optionWriteColumns**(헤더에 '옵션'이 든
//   칸을 직접 고르면 `옵션금액`(=결제금액)·`비고(옵션확인)`을 오분류한다 — 이미 밟은 함정).
// ★ 쓰기 표면은 딱 둘: ① 슬롯 INSERT 는 participants.createSlotsFromSheetRows 에 위임(그 모듈이
//   campaign_participants 쓰기의 소유자) ② 정원 교정은 **recruit_total 두 칸만** UPDATE.
//   시트·주문원장·검색인덱스·큐는 일절 건드리지 않는다.
// ═══════════════════════════════════════════════════════════════════════════
const { detectSheetHeader, normalizeCells } = require('../utils/sheetHeader');
const { parseDateColumn } = require('../utils/koreanDate');
const { findDateColumnIndex } = require('./campaignSchedule.service');
const { optionWriteColumns } = require('./orderLedger.service');
const participants = require('./participants.service');
const activity = require('../utils/tabActivity');
const { logger } = require('../utils/logger');

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

const HEADER_SCAN_ROWS = 60;      // campaignSchedule 과 같은 범위(상단 캠페인 정보 블록을 넘기기 충분)
const AUDIT_TAB_CAP = 1500;       // 목록 상한(넘으면 truncated 고지)
const SCAN_CAP = 80;              // 한 번에 정밀 스캔할 작업 수(탭당 쿼리 1개 — 조용한 절단 금지로 보고)
const BACKFILL_CAP = 2000;        // 한 번에 만들 슬롯 상한

/**
 * 한 탭의 "시트 준비 행"을 읽는다. (읽기 전용)
 *
 * 준비 행 = **구매일자 칸이 채워져 날짜로 해석되는 행**. 날짜를 기준으로 삼는 이유는
 * 그것이 곧 투입 일정이고, 063 이 그날 정원을 세는 재료와 **같은 칸**이기 때문이다
 * (다른 기준을 쓰면 "표는 늘렸는데 일정은 그대로"가 된다).
 *
 * ★ 날짜가 없는데 다른 칸만 채워진 행은 `datelessFilled` 로 **세어서 보고만** 한다 —
 *   일정을 모르는 행을 슬롯으로 만들면 그날 정원 계산이 어긋난다(조용히 버리지도 않는다).
 * @returns {{ok, reason, headerRow, headers, dateColumn, optionColumn, prepared:[{seq,dateRaw,dateIso,optionText,cells?}], datelessFilled, rowsScanned}}
 */
async function readPreparedRows(db, { sheetId, tabGid, includeCells = false, now = new Date() } = {}) {
  const fail = (reason) => ({ ok: false, reason, prepared: [], datelessFilled: 0, rowsScanned: 0 });
  if (!db || !sheetId || !tabGid) return fail('no_tab');
  try {
    const head = await db.query(
      `SELECT row_index, cells FROM raw_sheet_rows
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index <= ${HEADER_SCAN_ROWS}
        ORDER BY row_index`,
      [sheetId, String(tabGid)]);
    if (!head.rows.length) return fail('no_mirror');            // 미러가 이 탭을 아직 못 봄
    const det = detectSheetHeader(head.rows.map(r => (Array.isArray(r.cells) ? r.cells : [])));
    const headers = det.headers || [];
    if (!headers.length || det.headerRowIndex == null) return fail('header_unrecognizable');
    const dateIdx = findDateColumnIndex(headers);
    if (dateIdx < 0) return fail('no_date_column');
    const headerRow = head.rows[det.headerRowIndex - 1].row_index;   // 배열 인덱스(1-based) → 시트 실제 행 번호
    const optIdx = (optionWriteColumns(headers) || [])[0];
    const optCol = Number.isInteger(optIdx) ? optIdx : -1;

    // ★★ `cells->>$n::int` 의 `::int` 를 절대 빼지 말 것 — cells 는 JSONB **배열**이라
    //   캐스트가 없으면 `jsonb ->> text`(객체 키 조회)로 해석되어 **에러 없이 전 행 NULL** 이 된다
    //   (063 이 배포 이래 무음으로 꺼져 있던 원인). 로컬 PG16 재현·검증된 함정.
    let body;
    if (includeCells) {
      body = await db.query(
        `SELECT row_index, cells FROM raw_sheet_rows
          WHERE sheet_id = $1 AND tab_gid = $2 AND row_index > $3 ORDER BY row_index`,
        [sheetId, String(tabGid), headerRow]);
    } else if (optCol >= 0) {
      body = await db.query(
        `SELECT row_index, cells->>$3::int AS d, cells->>$4::int AS o FROM raw_sheet_rows
          WHERE sheet_id = $1 AND tab_gid = $2 AND row_index > $5 ORDER BY row_index`,
        [sheetId, String(tabGid), String(dateIdx), String(optCol), headerRow]);
    } else {
      body = await db.query(
        `SELECT row_index, cells->>$3::int AS d FROM raw_sheet_rows
          WHERE sheet_id = $1 AND tab_gid = $2 AND row_index > $4 ORDER BY row_index`,
        [sheetId, String(tabGid), String(dateIdx), headerRow]);
    }

    const rows = body.rows.map(r => {
      const cells = includeCells ? (Array.isArray(r.cells) ? normalizeCells(r.cells) : []) : null;
      const d = includeCells ? (cells[dateIdx] || '') : (r.d == null ? '' : String(r.d));
      const o = includeCells ? (optCol >= 0 ? (cells[optCol] || '') : '')
                             : (r.o == null ? '' : String(r.o));
      return { seq: r.row_index, dateRaw: String(d).trim(), optionText: String(o).trim(), cells };
    });

    const kst = new Date(now.getTime() + 9 * 3600 * 1000);
    const iso = parseDateColumn(rows.map(r => r.dateRaw), {
      fallbackAnchor: { y: kst.getUTCFullYear(), m: kst.getUTCMonth() + 1 },
    });

    const prepared = [];
    let datelessFilled = 0;
    rows.forEach((r, i) => {
      if (iso[i]) {
        const item = { seq: r.seq, dateRaw: r.dateRaw, dateIso: iso[i], optionText: r.optionText };
        if (includeCells) item.rowJson = _rowJson(headers, r.cells);
        prepared.push(item);
      } else if (r.dateRaw) datelessFilled++;   // 칸에 값은 있는데 날짜로 해석되지 않음(두 모드 같은 기준)
    });

    return {
      ok: true, reason: 'ok', headerRow, headers,
      dateColumn: headers[dateIdx] || '', optionColumn: optCol >= 0 ? (headers[optCol] || '') : null,
      prepared, datelessFilled, rowsScanned: rows.length,
    };
  } catch (e) {
    logger.warn(`[sheetSlotSync] 준비 행 읽기 실패(${sheetId}/${tabGid}): ${e.message}`);
    return fail('error');
  }
}

/** 시트 헤더명 → 값 맵(review_index.row_json 과 같은 모양 — 그리드가 그대로 그린다) */
function _rowJson(headers, cells) {
  const out = {};
  (headers || []).forEach((h, i) => {
    const key = String(h == null ? '' : h).trim();
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(out, key)) return;   // 중복 헤더는 첫 칸만(그리드 헤더도 중복 제거)
    out[key] = cells && cells[i] != null ? String(cells[i]) : '';
  });
  return out;
}

/**
 * 전수 점검: "시트에 준비된 인원 > 시스템 표 인원"인 작업 찾기. (읽기 전용 · 시트 API 무접촉)
 *
 * ★ 분모는 `tab_configs`(등록 작업 전체) — sheetSyncAudit 과 같은 판단. 활성 탭 목록으로 세면
 *   반영 사슬이 끊긴 탭이 분모에서 빠져 "문제 없음"으로 보인다.
 * ★ 값싼 1차 거르기(미러 행 수 vs 표 행 수) 뒤에만 정밀 스캔(탭당 쿼리 1개)을 돌린다.
 *   스캔 상한에 걸리면 `scanCapped` 로 **고지**한다(조용한 절단 금지).
 */
async function auditSheetSuperiority({ limit = AUDIT_TAB_CAP, scanCap = SCAN_CAP,
                                       since = null, includeUnknown = false, now = new Date() } = {}) {
  const db = _db();
  const lim = Math.min(Math.max(parseInt(limit, 10) || AUDIT_TAB_CAP, 1), AUDIT_TAB_CAP);
  const cap = Math.min(Math.max(parseInt(scanCap, 10) || SCAN_CAP, 1), 300);
  // 연도 하한 — 과거 작업에 정밀 스캔 예산(탭당 쿼리)을 쓰지 않는다.
  const sinceDay = activity.normalizeSince(since);

  const { rows: tabs } = await db.query(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
            COALESCE(NULLIF(tc.tab_gid,''), rst."mirrorGid") AS "tabGid",
            COALESCE(tc.display_name, tc.tab_name) AS "displayName",
            rst."rawRows", rst."mirroredAt", cp.cnt AS "boardRows",
            reg.reg_at AS "registeredAt",
            ${activity.ACTIVITY_SELECT_SQL}
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT r.row_count AS "rawRows", r.mirrored_at AS "mirroredAt", r.tab_gid AS "mirrorGid"
           FROM raw_sheet_tabs r
          WHERE r.sheet_id = tc.sheet_id
            AND (r.tab_name = tc.tab_name
                 OR (tc.tab_gid IS NOT NULL AND tc.tab_gid <> '' AND r.tab_gid = tc.tab_gid))
          ORDER BY r.mirrored_at DESC NULLS LAST LIMIT 1
       ) rst ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS cnt FROM campaign_participants p
          WHERE p.sheet_id = tc.sheet_id AND p.tab_name = tc.tab_name AND p.deleted_at IS NULL
       ) cp ON TRUE
       LEFT JOIN LATERAL (
         SELECT MIN(c.created_at) AS reg_at FROM campaigns c WHERE c.sheet_id = tc.sheet_id
       ) reg ON TRUE
       ${activity.ACTIVITY_LATERAL_SQL}
      WHERE COALESCE(tc.is_closed, FALSE) = FALSE
      ORDER BY tc.sheet_id, tc.tab_name
      LIMIT $1`, [lim]);

  // 1차 거르기: gid 가 있고, 미러 행 수가 표 행 수보다 눈에 띄게 많은 탭만 정밀 스캔.
  //   (미러 행 수에는 상단 캠페인 정보·헤더 줄이 섞여 있어 정확한 수치가 아니다 — 후보 선별용.)
  // ── 연도 하한 먼저 — 과거 작업이 스캔 상한(SCAN_CAP)을 잡아먹지 않게 ──
  let filteredOld = 0, yearUnknown = 0;
  const current = tabs.filter(t => {
    const v = activity.activityVerdict(activity.resolveActivity(t), sinceDay, includeUnknown);
    if (v === 'old') { filteredOld++; return false; }
    if (v === 'unknown') { yearUnknown++; return false; }
    return true;
  });
  const candidates = current.filter(t => t.tabGid && Number(t.rawRows) > (Number(t.boardRows) || 0) + 2);
  const scan = candidates.slice(0, cap);
  const scanCapped = candidates.length > scan.length;

  // 기존 자리(seq) 일괄 조회 — 탭마다 따로 물으면 왕복이 배로 는다.
  const seqMap = new Map();
  if (scan.length) {
    const params = [];
    const tuples = scan.map(t => { params.push(t.sheetId, t.tabName); return `($${params.length - 1},$${params.length})`; }).join(',');
    const { rows: sq } = await db.query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName", array_agg(seq) AS seqs
         FROM campaign_participants
        WHERE (sheet_id, tab_name) IN (${tuples}) AND deleted_at IS NULL
        GROUP BY 1,2`, params).catch(e => {
          logger.warn(`[sheetSlotSync] 기존 자리 조회 실패: ${e.message}`);
          return { rows: [] };
        });
    for (const r of sq) seqMap.set(r.sheetId + '\u0000' + r.tabName, new Set((r.seqs || []).map(Number)));
  }

  const quotaMap = await _loadCampaignQuota(db, scan);

  const items = [];
  for (const t of scan) {
    const read = await readPreparedRows(db, { sheetId: t.sheetId, tabGid: t.tabGid, now });
    const key = t.sheetId + '\u0000' + t.tabName;
    const have = seqMap.get(key) || new Set();
    const missing = read.ok ? read.prepared.filter(p => !have.has(Number(p.seq))) : [];
    const camp = quotaMap.get(key) || null;
    const preparedCount = read.ok ? read.prepared.length : null;
    const target = preparedCount == null ? null : Math.max(preparedCount, Number(t.boardRows) || 0);
    items.push({
      sheetId: t.sheetId, tabName: t.tabName, tabGid: t.tabGid, displayName: t.displayName,
      rawRows: Number(t.rawRows) || 0, boardRows: Number(t.boardRows) || 0,
      mirroredAt: t.mirroredAt || null,
      readOk: read.ok, readReason: read.reason,
      dateColumn: read.dateColumn || null, optionColumn: read.optionColumn || null,
      preparedRows: preparedCount, datelessFilled: read.datelessFilled || 0,
      missingSlots: missing.length,
      firstDate: read.ok && read.prepared.length ? read.prepared[0].dateIso : null,
      lastDate: read.ok && read.prepared.length ? read.prepared[read.prepared.length - 1].dateIso : null,
      campaign: camp,
      quota: camp && target != null ? evaluateQuota(camp, target) : null,
      severity: !read.ok ? 'unknown' : (missing.length > 0 ? 'sheet_ahead' : 'ok'),
    });
  }
  // 차이가 큰 작업이 먼저 — 담당자가 위에서부터 처리한다.
  items.sort((a, b) => (b.missingSlots || 0) - (a.missingSlots || 0));
  return {
    total: tabs.length,
    since: sinceDay, filteredOld, yearUnknown, includeUnknown: !!includeUnknown,
    candidates: candidates.length,
    scanned: scan.length,
    scanCapped,
    truncated: tabs.length >= lim,
    flagged: items.filter(i => i.severity === 'sheet_ahead').length,
    items,
  };
}

/** 연결된 모집공고 + 정원 정보(옵션 포함)를 탭 단위로 모은다. 읽기 전용·fail-soft. */
async function _loadCampaignQuota(db, tabs) {
  const out = new Map();
  if (!tabs || !tabs.length) return out;
  try {
    const params = [];
    const conds = tabs.map(t => {
      params.push(t.sheetId, String(t.tabGid || ''), t.tabName);
      const i = params.length;
      return `(c.linked_sheet_id = $${i - 2} AND (NULLIF(c.linked_tab_gid,'') = NULLIF($${i - 1},'') OR c.linked_tab_name = $${i}))`;
    }).join(' OR ');
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.status, c.participation_mode AS "participationMode",
              c.recruit_total AS "recruitTotal", c.daily_limit AS "dailyLimit",
              c.linked_sheet_id AS "sheetId", c.linked_tab_gid AS "tabGid", c.linked_tab_name AS "tabName",
              COALESCE(json_agg(json_build_object(
                'optKey', o.opt_key, 'recruitTotal', o.recruit_total,
                'dailyLimit', o.daily_limit, 'status', o.status
              ) ORDER BY o.sort_order) FILTER (WHERE o.id IS NOT NULL), '[]') AS options
         FROM recruit_campaigns c
         LEFT JOIN campaign_options o ON o.campaign_id = c.id
        WHERE ${conds}
        GROUP BY c.id`, params);
    for (const t of tabs) {
      const hit = rows.find(r => r.sheetId === t.sheetId
        && ((r.tabGid && String(r.tabGid) === String(t.tabGid)) || r.tabName === t.tabName));
      if (hit) {
        out.set(t.sheetId + '\u0000' + t.tabName, {
          id: hit.id, title: hit.title, status: hit.status,
          participationMode: !!hit.participationMode,
          recruitTotal: Number(hit.recruitTotal) || 0, dailyLimit: Number(hit.dailyLimit) || 0,
          options: Array.isArray(hit.options) ? hit.options : [],
        });
      }
    }
  } catch (e) {
    logger.warn(`[sheetSlotSync] 공고 정원 조회 실패: ${e.message}`);   // fail-soft — 목록은 그대로 뜬다
  }
  return out;
}

/**
 * 공고 정원 ↔ 표 인원 대조(순수함수). **판정만** 하고 아무것도 바꾸지 않는다.
 *
 * ★ `0 = 무제한`이라 손대지 않는다(0을 target 으로 올리면 무제한이던 공고를 조이는 회귀).
 * ★ 이미 target 이상이면 손대지 않는다 — 이 기능은 **더 여는 쪽**이지 조이는 쪽이 아니다.
 * ★★ 옵션이 2개 이상이면 자동 배분하지 않는다(`multi_option_manual`) — 어느 옵션에 몇 명을
 *   줄지는 시스템이 정할 수 없다. 화면이 사유를 말하고 사람이 공고 수정에서 정한다.
 */
function evaluateQuota(camp, target) {
  const t = Math.max(0, parseInt(target, 10) || 0);
  const fixes = [], skips = [];
  if (!camp || !t) return { target: t, fixes, skips, needsFix: false };

  const ct = Number(camp.recruitTotal) || 0;
  if (ct > 0 && ct < t) fixes.push({ kind: 'campaign', from: ct, to: t });
  else if (ct === 0) skips.push({ kind: 'campaign', reason: 'unlimited' });
  else if (ct >= t) skips.push({ kind: 'campaign', reason: 'already_enough' });

  const active = (camp.options || []).filter(o => String(o.status || 'active') !== 'closed');
  const bounded = active.filter(o => (Number(o.recruitTotal) || 0) > 0);
  if (!active.length) skips.push({ kind: 'option', reason: 'no_option' });
  else if (!bounded.length) skips.push({ kind: 'option', reason: 'unlimited' });
  else if (bounded.length > 1) skips.push({ kind: 'option', reason: 'multi_option_manual', count: bounded.length });
  else {
    const o = bounded[0];
    const ot = Number(o.recruitTotal) || 0;
    if (ot < t) fixes.push({ kind: 'option', optKey: o.optKey, from: ot, to: t });
    else skips.push({ kind: 'option', reason: 'already_enough' });
  }
  return { target: t, fixes, skips, needsFix: fixes.length > 0 };
}

/**
 * STEP B — 시트 준비 행을 표의 빈 자리로 백필. (추가만 · 비파괴 · 멱등)
 *
 * ★★ `tabGid` 는 **서버가 tab_configs/미러에서 다시 구한다** — 클라이언트가 보낸 gid 를 믿으면
 *   낡은 화면이 **엉뚱한 탭의 행을 이 작업 표에 밀어 넣는다**(작업표 탭 삭제와 같은 규율).
 * ★ dryRun 기본 true — 미리보기 먼저, 실행은 사람이.
 */
async function backfillSlots({ sheetId, tabName, dryRun = true, by = 'sheet-slot-sync', now = new Date() } = {}) {
  if (!sheetId || !tabName) throw new Error('backfillSlots: sheetId, tabName 필수');
  const db = _db();
  const { rows: tc } = await db.query(
    `SELECT COALESCE(NULLIF(tc.tab_gid,''), (
              SELECT r.tab_gid FROM raw_sheet_tabs r
               WHERE r.sheet_id = tc.sheet_id AND r.tab_name = tc.tab_name
               ORDER BY r.mirrored_at DESC NULLS LAST LIMIT 1)) AS "tabGid",
            tc.campaign_name AS "campaignName"
       FROM tab_configs tc WHERE tc.sheet_id = $1 AND tc.tab_name = $2 LIMIT 1`,
    [sheetId, tabName]);
  if (!tc.length) return { ok: false, error: 'tab_not_registered' };
  const tabGid = tc[0].tabGid;
  if (!tabGid) return { ok: false, error: 'no_tab_gid' };

  const read = await readPreparedRows(db, { sheetId, tabGid, includeCells: true, now });
  if (!read.ok) return { ok: false, error: read.reason };

  const { rows: ex } = await db.query(
    `SELECT seq FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`,
    [sheetId, tabName]);
  const have = new Set(ex.map(r => Number(r.seq)));
  const missing = read.prepared.filter(p => !have.has(Number(p.seq)));
  const capped = missing.length > BACKFILL_CAP;
  const list = missing.slice(0, BACKFILL_CAP);

  const base = {
    ok: true, sheetId, tabName, tabGid,
    headerRow: read.headerRow, dateColumn: read.dateColumn, optionColumn: read.optionColumn,
    preparedRows: read.prepared.length, existingRows: have.size,
    missing: missing.length, capped, datelessFilled: read.datelessFilled,
    sample: list.slice(0, 5).map(p => ({ seq: p.seq, date: p.dateRaw, option: p.optionText })),
  };
  if (dryRun) return { ...base, dryRun: true, created: 0 };
  if (!list.length) return { ...base, dryRun: false, created: 0 };

  const res = await participants.createSlotsFromSheetRows({
    sheetId, tabName, tabGid, campaignName: tc[0].campaignName || null,
    rows: list.map(p => ({ seq: p.seq, optionText: p.optionText, startDate: p.dateRaw, rowJson: p.rowJson })),
    by,
  });
  const { rows: after } = await db.query(
    `SELECT COUNT(*)::int AS n FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`,
    [sheetId, tabName]);
  logger.info(`[sheetSlotSync] 슬롯 백필 ${sheetId}/${tabName}: +${res.created} (준비 ${read.prepared.length} · by ${by})`);
  return { ...base, dryRun: false, created: res.created, boardRowsAfter: after[0] ? after[0].n : null };
}

/**
 * STEP C — 공고 정원을 표 인원에 맞춘다. (쓰기 표면 = recruit_total 두 칸뿐)
 *
 * ★★ target 은 **서버가 다시 센다**(표의 활성 행 수) — 화면이 보낸 숫자를 믿지 않는다.
 * ★★ 연결 검증: 그 공고가 정말 이 탭에 연결돼 있을 때만 고친다(엉뚱한 공고 정원 변경 차단).
 * ★ 판정은 evaluateQuota 한 곳(순수함수) — 화면이 보여준 것과 서버가 하는 일이 갈라지지 않는다.
 * ★ daily_limit 은 건드리지 않는다 — 그날 정원은 시트/표의 구매일자 분배(063)가 정한다.
 */
async function applyQuotaFix({ sheetId, tabName, campaignId, by = 'sheet-slot-sync' } = {}) {
  if (!sheetId || !tabName || !campaignId) throw new Error('applyQuotaFix: sheetId, tabName, campaignId 필수');
  const db = _db();
  const { rows: cnt } = await db.query(
    `SELECT COUNT(*)::int AS n FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`,
    [sheetId, tabName]);
  const target = cnt[0] ? cnt[0].n : 0;
  if (!target) return { ok: false, error: 'empty_board' };

  const quotaMap = await _loadCampaignQuota(db, [{ sheetId, tabName, tabGid: null }]);
  let camp = quotaMap.get(sheetId + '\u0000' + tabName) || null;
  if (!camp) {
    // gid 로만 연결된 공고 — 탭의 gid 를 구해 한 번 더 찾는다.
    const { rows: g } = await db.query(
      `SELECT COALESCE(NULLIF(tab_gid,''), NULL) AS gid FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`,
      [sheetId, tabName]);
    if (g.length && g[0].gid) {
      const m2 = await _loadCampaignQuota(db, [{ sheetId, tabName, tabGid: g[0].gid }]);
      camp = m2.get(sheetId + '\u0000' + tabName) || null;
    }
  }
  if (!camp) return { ok: false, error: 'campaign_not_linked' };
  if (String(camp.id) !== String(campaignId)) {
    return { ok: false, error: 'campaign_mismatch', linkedCampaignId: camp.id };
  }

  const plan = evaluateQuota(camp, target);
  if (!plan.needsFix) return { ok: true, applied: [], target, plan, campaignId: camp.id };

  const applied = [];
  for (const f of plan.fixes) {
    if (f.kind === 'campaign') {
      // ★ 조건부 UPDATE — 그 사이 누가 더 큰 값으로 고쳤으면 그대로 둔다(사람 값 보호).
      const { rowCount } = await db.query(
        `UPDATE recruit_campaigns SET recruit_total=$2, updated_at=NOW()
          WHERE id=$1 AND recruit_total > 0 AND recruit_total < $2`, [camp.id, f.to]);
      if (rowCount) applied.push(f);
    } else if (f.kind === 'option') {
      const { rowCount } = await db.query(
        `UPDATE campaign_options SET recruit_total=$3, updated_at=NOW()
          WHERE campaign_id=$1 AND opt_key=$2 AND recruit_total > 0 AND recruit_total < $3`,
        [camp.id, f.optKey, f.to]);
      if (rowCount) applied.push(f);
    }
  }
  logger.info(`[sheetSlotSync] 정원 교정 ${camp.id}(${sheetId}/${tabName}) → ${target}: ${JSON.stringify(applied)} (by ${by})`);
  return { ok: true, applied, target, plan, campaignId: camp.id };
}

module.exports = {
  readPreparedRows,
  auditSheetSuperiority,
  backfillSlots,
  applyQuotaFix,
  evaluateQuota,
  __setPoolForTest,
  SCAN_CAP, BACKFILL_CAP,
};
