/**
 * workTabDelete.service.js — 작업(탭) 통째 삭제 (admin/master 전용, 2026-08-19 사용자 확정)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 왜 있나
 *   접수 재시도·오발행으로 **같은 이름의 작업이 두 줄** 생기고 그중 한 줄은 아무도 쓰지 않는
 *   고아로 남았다(화면 실측: `[TEST]…` 3종 · 「웰스앤헬스 …500건」 0/500). 종전 수단은
 *   ㉮ [🏁 마감](목록에는 남고 보관함으로) ㉯ 무시트 잔재 정리(`sheetlessOrphanCleanup` — **빈
 *   가상 탭만**·연결이 하나라도 있으면 제외)뿐이라, "연결은 있는데 실체가 없는 고아"를 치울
 *   창구가 없었다.
 *
 * ★★ 이 기능은 **되돌릴 수 없다**(사용자 확정: DB 행까지 실제 삭제). 그래서 방어를 셋 둔다.
 *   ① **미리보기 필수** — 무엇이 몇 건 지워지는지 먼저 보여주고 사람이 확인해야 실행된다
 *      (`confirm !== true` 면 서버가 거부 — 낡은 화면이 실행만 부르는 경로 차단).
 *   ② **돈 기록은 기본 거부, 두 번째 확인으로만 통과**(사용자 확정 2026-08-19 — 종전의 절대 거부에서
 *      완화) — 입금 회차 항목·입금 원장·수기 입금 표기·미확인 이체 검토가 한 줄이라도 있으면
 *      기본 요청(`forcePayment` 없음)은 **쓰기 0건으로 거부**한다. 화면이 무엇이 걸렸는지 말하고
 *      **별도 체크 + 별도 버튼**을 누른 요청만 그 기록까지 함께 지운다.
 *      ★ 왜 한 단계를 남겼나: 지우면 그 리뷰어 줄이 **미입금으로 보여 다음 회차에 다시 담기고
 *      이중 송금**이 날 수 있다(129 "표에서만 빼기"가 존재하는 이유). 막지는 않되, 실수로
 *      눌리지는 않게 한다.
 *   ③ **표 분류는 전수 고정** — (sheet_id, tab_name) 을 가진 표는 전부 아래 두 목록 중
 *      하나에 있어야 한다(회귀가드가 마이그레이션을 읽어 대조). 새 표가 생겼는데 분류가 없으면
 *      테스트가 빨개진다 = "지워야 하는데 남는" 잔재도, "지우면 안 되는데 지워지는" 사고도 막는다.
 *
 * ★ 구글시트는 **읽지도 쓰지도 않는다**(사용자 확정 — 시트 탭 삭제는 이 기능의 일이 아니다).
 *   시트 기반 탭을 지워도 시트 파일은 그대로 남는다. 등록(`tab_configs`)이 사라지므로
 *   등록 게이트(`TAB_REGISTRATION_MODE=order`)에 따라 인덱스가 다시 만들어지지 않아
 *   목록에도 돌아오지 않는다.
 *
 * ★ 곁다리 정리 4종(전부 같은 트랜잭션):
 *   · 연결 작업오더는 **링크만 비운다**(삭제 아님) → 같은 오더를 **다시 접수**할 수 있다.
 *   · 연결 모집공고는 **함께 삭제**한다(사용자 확정 2026-08-19) — 작업이 사라졌는데 그 작업을
 *     가리키는 공고만 남으면 갈 곳 없는 공고가 목록에 남는다. 참여 신청·옵션·리뷰비 구간·차수·
 *     날짜별 계획·리뷰어 게이트는 FK CASCADE 로 함께 사라진다.
 *   · 업체 소유(`advertiser_campaigns`)는 **이 탭만 지정한 행**만 정리(시트 전체 소유는 남긴다).
 *   · 시트 등록행(`campaigns`)은 그 시트를 쓰는 탭이 하나도 남지 않았을 때만 정리.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');

/* ── (sheet_id, tab_name) 로 이 작업에 매달린 표 — 삭제 대상 ────────────────────
   ★ 순서가 계약이다: 자식(참조하는 쪽) → 부모, 등록행(`tab_configs`)이 마지막.
     `trackb_custom_column_values` 는 `trackb_custom_columns` 에 FK CASCADE 라 따라 지워진다. */
const DELETE_TABLES = [
  'participant_edits',
  'campaign_participants',
  'workdesk_participant_deletions',
  'review_submissions',
  'review_inspections',
  'review_edit_requests',
  'review_report_links',
  'review_index',
  'review_index_archive',
  'index_master',
  'index_master_archive',
  'raw_sheet_rows',
  'raw_sheet_tabs',
  'order_submissions',
  'participation_links',
  'sheet_row_claims',
  'slot_locks',
  'reverse_sync_proposals',
  'parity_snapshots',
  'reviewer_event_logs',
  'tab_column_mappings',
  'tab_status_column_bindings',
  'unrecognized_tabs',
  'short_links',
  'trackb_thread_seen',
  'trackb_tab_threads',
  'trackb_tab_memos',
  'trackb_tab_closeouts',
  'trackb_tab_finished',
  'trackb_tab_daily_done',
  'trackb_settlement_links',
  'trackb_work_order_links',
  'trackb_brand_tab_map',
  'trackb_tab_brand_managers',   // 136 — 작업별 브랜드 담당자(사용자 확정 2026-08-24: 작업을 지우면 함께 지운다)
  'trackb_cell_colors',
  'trackb_custom_columns',
  'trackb_share_links',
  'tab_configs',
];

/* ── 돈 기록 — 기본은 거부, `forcePayment` 두 번째 확인일 때만 함께 삭제 ────────
   ★ 삭제 순서가 계약이다: `payment_account_mismatch_reconciliations.batch_item_id` 가
     `payment_batch_items` 를 **ON DELETE RESTRICT** 로 잡고 있어(119), 그 대조 이력을 먼저
     지우지 않으면 회차 항목 삭제가 FK 로 튕긴다.
   ★ 회차(`payment_batches`) 자체는 지우지 않는다 — 한 회차가 여러 작업에 걸쳐 있다. */
const MONEY_TABLES = [
  { table: 'payment_batch_items', label: '입금 회차 항목' },
  { table: 'payment_records', label: '입금 원장' },
  { table: 'manual_payment_marks', label: '수기 입금 표기' },
  { table: 'unconfirmed_transfer_reviews', label: '미확인 이체 검토' },
];

/* ── 일부러 **남기는** 표 — 작업이 지워져도 살아남아야 한다 (2026-08-24) ──────────
   ★ 왜 세 번째 분류가 필요한가: 표 분류 전수 가드(`workTabDelete.test`)는
     (sheet_id, tab_name) 을 가진 표를 전부 "지운다/돈이라 막는다" 둘 중 하나로 요구한다.
     묘비(134)는 **그 둘 다 아니다** — 작업이 사라진 뒤에도 남아야 뜻이 있는 표라서,
     삭제 목록에 넣으면 기능 자체가 죽고 돈 표로 두면 거짓말이 된다.
   ★ 여기 넣는 것은 "분류를 깜빡한 표"가 아니라 **남기기로 결정한 표**다.
     새 표를 여기 넣으려면 "작업이 사라진 뒤에도 이 줄이 왜 필요한가"를 한 줄로 적는다.
   ★ 이 목록의 표는 삭제 경로가 **건드리지 않는다**(DELETE 문을 만들지 않는다). */
const KEEP_TABLES = [
  { table: 'orphan_capture_tombstones',
    why: '작업이 사라진 뒤 Drive 에 남은 캡처를 찾을 유일한 좌표 — 같이 지우면 영영 못 찾는다' },
  { table: 'workboard_consolidation_link_events',
    why: '통폐합 롤백이 이번 백업에서 만든 연결만 되돌리도록 증명하는 변경 저널이라 작업 삭제 뒤에도 보존한다' },
  { table: 'workboard_consolidation_targets',
    why: '승인된 기존 작업의 통폐합 상태와 새 workboard 연결을 보존하는 전환 원장이라 레거시 탭 삭제와 함께 지우지 않는다' },
];

let _pool = null;
/* ══════════════════════════════════════════════════════════════════════════
   구글 드라이브 폴더 (사용자 확정 2026-08-21)
   ──────────────────────────────────────────────────────────────────────────
   작업을 지울 때 그 작업의 캡처 폴더도 함께 치운다. 대상은 `tab_configs` 가 들고 있는 두 폴더 —
   리뷰(`folder_url`)·구매캡처(`capture_folder_url`). 현금영수증 등 하위 폴더와 그 안의 이미지는
   부모 폴더에 들어 있으므로 부모를 치우면 함께 간다.

   ★★ **휴지통으로 보낸다 — 영구삭제 API 는 쓰지 않는다**(레포 규율: 30일 복구창).
     화면도 "휴지통으로 이동"이라고 정확히 말한다 — 사라진 줄 알았는데 복구 가능한 편이 그 반대보다 낫다.
   ★★ **다른 탭이 같은 폴더를 가리키면 지우지 않는다**(fail-closed). 폴더는 탭별로 만들어지지만
     이름 매칭으로 붙는 경로(`ensureReviewFolderPath`)가 있어 공유가 실제로 가능하다 —
     남의 작업 캡처를 지우는 사고가 "폴더가 남는" 것보다 훨씬 크다.
   ★ Drive 는 **DB 삭제가 커밋된 뒤**에 건드린다: 게이트(확인·입금 기록)를 다 통과한 뒤에만
     외부 저장을 손대고, 실패해도 사유와 폴더 링크를 응답에 실어 사람이 손으로 치울 수 있게 한다.
   ★ 기본은 **끔** — `deleteDrive === true` 일 때만 동작한다(입금 기록 삭제와 같은 별도 확인 규율).
   ══════════════════════════════════════════════════════════════════════════ */
const DRIVE_FOLDER_KINDS = [
  { kind: 'review', column: 'folder_url', label: '리뷰 캡처 폴더' },
  { kind: 'capture', column: 'capture_folder_url', label: '구매 캡처 폴더' },
];

function _drive() { return require('./drive.service'); }

/**
 * 그 탭이 가리키는 드라이브 폴더 목록(좌표만 — Drive 무접촉).
 * `sharedWith` 가 비어 있지 않으면 다른 탭도 같은 폴더를 쓴다는 뜻이라 **지우지 않는다**.
 */
async function _tabDriveFolders(q, sheetId, tabName) {
  const { rows } = await q(
    `SELECT folder_url AS review, capture_folder_url AS capture
       FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2`, [sheetId, tabName]);
  if (!rows.length) return [];
  const { extractFolderIdFromUrl } = _drive();
  const out = [];
  for (const k of DRIVE_FOLDER_KINDS) {
    const url = String(rows[0][k.kind === 'review' ? 'review' : 'capture'] || '').trim();
    if (!url) continue;
    const folderId = extractFolderIdFromUrl(url) || (/^[a-zA-Z0-9_-]{10,}$/.test(url) ? url : null);
    if (!folderId) { out.push({ ...k, url, folderId: null, unreadable: true, sharedWith: [] }); continue; }
    // 같은 폴더를 가리키는 **다른** 탭이 있는가(시트가 달라도 위험은 같다).
    const { rows: sh } = await q(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName" FROM tab_configs
        WHERE NOT (sheet_id=$1 AND tab_name=$2)
          AND (COALESCE(folder_url,'') LIKE $3 OR COALESCE(capture_folder_url,'') LIKE $3)
        LIMIT 5`, [sheetId, tabName, `%${folderId}%`]);
    out.push({ ...k, url, folderId, sharedWith: sh || [] });
  }
  return out;
}

/** 미리보기용 — 폴더 이름·파일 수를 붙인다(사람이 "무엇이 사라지는지" 보고 누르게). fail-soft. */
async function _describeDriveFolders(folders) {
  const d = _drive();
  for (const f of folders) {
    if (!f.folderId) continue;
    try {
      const meta = await d.getFolderMeta(f.folderId);
      if (meta) f.name = meta.name || '';
    } catch (e) { f.metaError = e && e.message; }
    try {
      const ins = await d.inspectFolder(f.folderId);
      if (ins) { f.files = ins.fileCount; f.subfolders = (ins.subfolders || []).length; }
    } catch (e) { f.countError = e && e.message; }
  }
  return folders;
}

/**
 * 실행 — 폴더를 **휴지통으로** 보낸다. 공유 폴더·좌표 불명은 건너뛰고 사유를 남긴다.
 * ★ 절대 throw 하지 않는다 — DB 삭제는 이미 커밋됐고, 여기서 예외가 오르면 호출부가
 *   "삭제 실패"로 보고해 사람이 같은 삭제를 다시 시도한다(이미 지워진 작업에).
 */
async function _trashDriveFolders(folders, by) {
  const out = [];
  for (const f of folders) {
    const base = { kind: f.kind, label: f.label, url: f.url, folderId: f.folderId, name: f.name || '' };
    if (!f.folderId) { out.push({ ...base, ok: false, skipped: 'unreadable_url' }); continue; }
    if (f.sharedWith && f.sharedWith.length) {
      out.push({ ...base, ok: false, skipped: 'shared', sharedWith: f.sharedWith });
      continue;
    }
    try {
      const r = await _drive().trashFiles([{ id: f.folderId, name: f.name || f.label }]);
      const ok = !!(r && r.success);
      out.push({ ...base, ok, error: ok ? null : ((r && r.errors && r.errors[0] && r.errors[0].error) || '휴지통 이동 실패') });
      if (ok) logger.warn(`[workTabDelete] 드라이브 폴더 휴지통 이동(${by}): ${f.label} "${f.name || ''}" (${f.folderId})`);
    } catch (e) {
      out.push({ ...base, ok: false, error: (e && e.message) || String(e) });
    }
  }
  return out;
}

function _db() { return _pool || (_pool = require('../db/pool')); }
function __setPoolForTest(p) { _pool = p; }

function _args(sheetId, tabName) {
  if (!sheetId || !tabName) {
    const e = new Error('sheetId, tabName 이 필요합니다.');
    e.code = 'bad_args';
    throw e;
  }
}

/** 돈 기록 집계 — 미리보기·실행이 **같은 함수**를 쓴다(사본을 두면 한쪽만 느슨해진다). */
async function _moneyRows(q, sheetId, tabName) {
  const out = [];
  for (const m of MONEY_TABLES) {
    const { rows } = await q(
      `SELECT COUNT(*)::int AS n FROM ${m.table} WHERE sheet_id=$1 AND tab_name=$2`,
      [sheetId, tabName]);
    const n = (rows && rows[0] && rows[0].n) || 0;
    if (n > 0) out.push({ table: m.table, label: m.label, count: n });
  }
  return out;
}

/**
 * 미리보기 — **쓰기 0건**. 무엇이 몇 건 지워지는지, 무엇 때문에 못 지우는지 그대로 말한다.
 */
async function previewTaskDelete({ sheetId, tabName, pool } = {}) {
  _args(sheetId, tabName);
  const db = pool || _db();
  const q = (text, params) => db.query(text, params);

  const tabRow = await q(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName", tc.tab_gid AS "tabGid",
            COALESCE(NULLIF(tc.display_name,''), NULLIF(tc.campaign_name,''), tc.tab_name) AS "displayName",
            COALESCE(tc.sheetless, FALSE) AS "sheetless"
       FROM tab_configs tc WHERE tc.sheet_id=$1 AND tc.tab_name=$2`, [sheetId, tabName]);

  const tables = [];
  let totalRows = 0;
  for (const t of DELETE_TABLES) {
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM ${t} WHERE sheet_id=$1 AND tab_name=$2`, [sheetId, tabName]);
    const n = (rows && rows[0] && rows[0].n) || 0;
    if (n > 0) { tables.push({ table: t, count: n }); totalRows += n; }
  }

  // 사람이 읽는 요약 — "몇 명이 참여했고 주문이 몇 건인가"가 판단의 근거다.
  const { rows: sum } = await q(
    `SELECT (SELECT COUNT(*) FROM campaign_participants
              WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL)::int AS "boardRows",
            (SELECT COUNT(*) FROM campaign_participants
              WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND phone8 IS NOT NULL)::int AS participants,
            (SELECT COUNT(*) FROM order_submissions
              WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL)::int AS orders,
            (SELECT COUNT(*) FROM review_submissions
              WHERE sheet_id=$1 AND tab_name=$2)::int AS "reviewFiles",
            (SELECT COUNT(*) FROM review_index
              WHERE sheet_id=$1 AND tab_name=$2)::int AS roster`,
    [sheetId, tabName]);

  const money = await _moneyRows(q, sheetId, tabName);

  const { rows: camps } = await q(
    `SELECT id, title, status, archived_at AS "archivedAt"
       FROM recruit_campaigns
      WHERE linked_sheet_id=$1 AND COALESCE(NULLIF(linked_tab_name,''), $2)=$2
      ORDER BY created_at DESC LIMIT 20`, [sheetId, tabName]);
  const { rows: wos } = await q(
    `SELECT id, title, status
       FROM work_orders
      WHERE linked_tab_sheet_id=$1 AND linked_tab_name=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 20`, [sheetId, tabName]);

  /* 드라이브 폴더 — **좌표는 DB 에서, 이름·파일 수는 Drive 에서**(사람이 누른 미리보기에서만).
     ★ fail-soft: Drive 가 막혀도 미리보기는 떠야 한다. 대신 "몇 장인지 모른다"를 화면이 말한다. */
  let drive = { folders: [], unavailable: null };
  try {
    const folders = await _tabDriveFolders(q, sheetId, tabName);
    drive.folders = await _describeDriveFolders(folders);
  } catch (e) { drive = { folders: [], unavailable: (e && e.message) || String(e) }; }

  return {
    ok: true,
    tab: (tabRow.rows && tabRow.rows[0]) || { sheetId, tabName, tabGid: null, displayName: tabName, sheetless: null },
    registered: !!(tabRow.rows && tabRow.rows.length),
    counts: (sum && sum[0]) || {},
    tables, totalRows,
    money, blocked: money.length > 0,
    campaigns: camps || [], workOrders: wos || [],
    drive,
  };
}

/**
 * 실행 — 한 트랜잭션. 확인(`confirm===true`) 없이는 아무것도 지우지 않는다.
 */
async function deleteTask({ sheetId, tabName, confirm, forcePayment = false, deleteDrive = false, by = 'admin', pool } = {}) {
  _args(sheetId, tabName);
  if (confirm !== true) return { ok: false, code: 'confirm_required', error: '삭제 확인이 필요합니다.' };

  const db = pool || _db();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 같은 작업을 두 사람이 동시에 지우거나, 지우는 중에 주문이 들어오는 것을 막는다.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [String(sheetId), String(tabName)]);

    // ★★ 돈 기록은 트랜잭션 안에서 다시 센다 — 미리보기 이후에 회차에 담겼을 수 있다(TOCTOU).
    const money = await _moneyRows((t, p) => client.query(t, p), sheetId, tabName);
    if (money.length && forcePayment !== true) {
      await client.query('ROLLBACK');
      return {
        ok: false, code: 'payment_locked', money,
        error: '이 작업에는 입금 기록이 걸려 있습니다. 그대로 지우면 그 리뷰어가 미입금으로 보여 다음 회차에 다시 담길 수 있습니다 — 확인 후 [입금 기록까지 삭제]로 진행하세요.',
      };
    }

    /* ★ gid 는 **지우기 전에** 읽어 둔다 — `tab_configs`·`raw_sheet_tabs` 를 지운 뒤에는
       업체 소유(탭 지정) 행이 어느 탭 것인지 알 방법이 사라진다.
       ★ 못 구하면(빈 gid) 소유 행은 건드리지 않는다 — 빈 값으로 매칭하면 시트 전체 소유나
         남의 탭 소유를 지운다(모르면 손대지 않는다). */
    const { rows: gidRows } = await client.query(
      `SELECT COALESCE(NULLIF(tc.tab_gid,''), NULLIF(rst.tab_gid,'')) AS gid
         FROM (SELECT $1::text AS sid, $2::text AS tname) k
         LEFT JOIN tab_configs tc ON tc.sheet_id=k.sid AND tc.tab_name=k.tname
         LEFT JOIN raw_sheet_tabs rst ON rst.sheet_id=k.sid AND rst.tab_name=k.tname`,
      [sheetId, tabName]);
    const tabGid = (gidRows && gidRows[0] && gidRows[0].gid) || '';

    /* ★ 드라이브 폴더 좌표도 **지우기 전에** 읽어 둔다 — `tab_configs` 가 사라지면 그 작업의
       폴더가 어느 것인지 알 방법이 없다(gid 와 같은 이유). Drive 호출은 커밋 뒤에 한다. */
    let driveTargets = [];
    if (deleteDrive === true) {
      try { driveTargets = await _tabDriveFolders((t, p) => client.query(t, p), sheetId, tabName); }
      catch (e) { driveTargets = []; logger.warn(`[workTabDelete] 드라이브 폴더 좌표 조회 실패: ${e && e.message}`); }
    }

    const deleted = {};
    let totalRows = 0;
    let recordedTombstones = 0;   // 고아 캡처 정리용 좌표 기록 건수(청소 편의 — 삭제 결과에 영향 없음)

    /* ★★ 두 번째 확인을 받은 경우에만 — 돈 기록도 함께 지운다(사용자 확정 2026-08-19).
       ★ 순서 계약: 대조 이력(119, batch_item_id 가 RESTRICT)을 **먼저** 지워야 회차 항목이 지워진다.
       ★ 회차(`payment_batches`) 자체는 남긴다 — 한 회차가 여러 작업에 걸쳐 있어 지우면 남의 작업의
         입금 기록까지 사라진다(폭발반경 차단). */
    if (money.length && forcePayment === true) {
      const rec = await client.query(
        `DELETE FROM payment_account_mismatch_reconciliations r
          WHERE r.batch_item_id IN (SELECT id FROM payment_batch_items
                                     WHERE sheet_id=$1 AND tab_name=$2)`, [sheetId, tabName]);
      if (rec.rowCount) { deleted.payment_account_mismatch_reconciliations = rec.rowCount; totalRows += rec.rowCount; }
      for (const m of MONEY_TABLES) {
        const r = await client.query(`DELETE FROM ${m.table} WHERE sheet_id=$1 AND tab_name=$2`, [sheetId, tabName]);
        if (r && r.rowCount) { deleted[m.table] = r.rowCount; totalRows += r.rowCount; }
      }
      logger.warn(`[workTabDelete] "${tabName}" (${sheetId}) — 입금 기록까지 삭제(확인: ${by}): ${money.map(x => `${x.label} ${x.count}`).join(' · ')}`);
    }

    /* ★★ 지우기 **직전에** 그 작업의 캡처 좌표를 묘비에 남긴다 (2026-08-24).
       이 함수는 `review_submissions`·`order_submissions` 를 실제 DELETE 하므로, 남기지 않으면
       Drive 파일은 남는데 그것을 가리키던 원장이 통째로 사라져 **DB 기준으로 존재를 영영
       알 수 없다**(C종류 = 탐지 불가). 좌표만 남겨 두면 고아 캡처 정리가 그 뒤로도 찾는다.
       ★ 순서가 계약 — DELETE_TABLES 루프보다 **앞**이어야 한다(뒤면 읽을 원장이 없다).
       ★ 절대 삭제를 막지 않는다(fail-soft) — 묘비는 청소 편의지 삭제의 전제가 아니다.
         다만 조용히 넘기지 않고 사유를 로그로 남긴다.
       ★★★ **SAVEPOINT 로 격리한다**(2026-08-24 Codex 리뷰 · 완화 금지) — try/catch 만으로는
         fail-soft 가 **성립하지 않는다**. 열린 트랜잭션 안에서 이 INSERT 가 실패하면
         (배포 중 134 미적용 = `relation does not exist` 가 대표 사례) PostgreSQL 이 그
         트랜잭션을 **abort 상태**로 표시해 뒤따르는 DELETE 가 전부 25P02 로 죽는다.
         잡아서 로그만 남기면 "삭제는 계속"이 아니라 **작업 삭제 전체가 롤백**된다.
         (CLAUDE.md 의 082 apply·번호 매기기와 같은 자리 — 같은 함정을 세 번째로 밟지 않는다.) */
    await client.query('SAVEPOINT orphan_tomb');
    try {
      const tomb = await client.query(
        `INSERT INTO orphan_capture_tombstones
           (file_id, file_name, sheet_id, tab_name, reviewer_name, slot_key, reason, recorded_by)
         SELECT rs.file_id, rs.file_name, rs.sheet_id, rs.tab_name, rs.reviewer_name,
                rs.slot_key, 'work_deleted', $3
           FROM review_submissions rs
          WHERE rs.sheet_id=$1 AND rs.tab_name=$2
            AND COALESCE(rs.slot_key,'') <> 'trashed' AND rs.file_id IS NOT NULL
         UNION
         SELECT os.capture_file_id, NULL, os.sheet_id, os.tab_name, os.orderer,
                'capture', 'work_deleted', $3
           FROM order_submissions os
          WHERE os.sheet_id=$1 AND os.tab_name=$2 AND os.capture_file_id IS NOT NULL
         ON CONFLICT (file_id) DO NOTHING`,
        [sheetId, tabName, String(by || 'admin').slice(0, 100)]);
      if (tomb.rowCount) {
        recordedTombstones = tomb.rowCount;
        logger.info(`[workTabDelete] "${tabName}" 캡처 묘비 ${tomb.rowCount}건 기록(고아 정리용)`);
      }
      await client.query('RELEASE SAVEPOINT orphan_tomb');
    } catch (tombErr) {
      /* ★ 되돌린 뒤에야 트랜잭션이 다시 쓸 수 있는 상태가 된다 — 이 한 줄이 fail-soft 의 전부다. */
      try { await client.query('ROLLBACK TO SAVEPOINT orphan_tomb'); } catch (_) { /* 이미 죽었으면 어차피 아래서 드러난다 */ }
      logger.warn(`[workTabDelete] 캡처 묘비 기록 실패(삭제는 계속) "${tabName}": ${tombErr.message}`);
    }

    for (const t of DELETE_TABLES) {
      const r = await client.query(`DELETE FROM ${t} WHERE sheet_id=$1 AND tab_name=$2`, [sheetId, tabName]);
      if (r && r.rowCount) { deleted[t] = r.rowCount; totalRows += r.rowCount; }
    }

    /* ① 연결 작업오더 — 링크만 비운다(오더는 남는다 → 같은 오더를 다시 접수할 수 있다).
       ★★ 종전엔 링크를 비우기만 해서 그 오더가 목록에서 **"아직 접수 안 한 오더"와 똑같이** 보였다
         (언제 무엇이 지워졌는지 아무 데도 안 남았다) → 삭제 시각·삭제자·지워진 작업 이름을 함께
         새긴다(134). 재접수하면 accept 가 이 세 칸을 비운다(화면이 거짓을 말하지 않게). */
    const wo = await client.query(
      `UPDATE work_orders SET linked_tab_sheet_id='', linked_tab_name='', linked_tab_gid='',
              tab_deleted_at=NOW(), tab_deleted_by=$3, tab_deleted_tab=$2, updated_at=NOW()
        WHERE linked_tab_sheet_id=$1 AND linked_tab_name=$2
        RETURNING id, title, status, created_by`, [sheetId, tabName, String(by || '')]);

    /* ② 연결 모집공고 — **함께 삭제**한다(사용자 확정 2026-08-19, 종전 보관 처리에서 변경).
       작업이 사라졌는데 그 작업을 가리키는 공고만 남으면 갈 곳 없는 공고가 목록에 떠 있게 된다.
       ★ 참여 신청·옵션·리뷰비 구간·차수·날짜별 계획·리뷰어 게이트는 FK CASCADE 로 함께 사라진다
         (018·061·082·091·095·112·115 — 전부 CASCADE, RESTRICT 없음).
       ★ 입금 회차 항목의 `campaign_id` 는 SET NULL(086)이라 회차 자체는 영향받지 않는다. */
    const rc = await client.query(
      `DELETE FROM recruit_campaigns
        WHERE linked_sheet_id=$1 AND COALESCE(NULLIF(linked_tab_name,''), $2)=$2`,
      [sheetId, tabName]);

    // ③ 업체 소유 — 이 탭만 지정한 행만 정리(시트 전체 소유 행은 다른 탭의 근거라 남긴다).
    const ac = tabGid
      ? await client.query(
        `DELETE FROM advertiser_campaigns
          WHERE sheet_id=$1 AND COALESCE(tab_gid,'') <> '' AND tab_gid=$2`, [sheetId, tabGid])
      : { rowCount: 0 };

    // ④ 시트 등록행 — 그 시트를 쓰는 탭이 하나도 남지 않았을 때만.
    const cam = await client.query(
      `DELETE FROM campaigns c
        WHERE c.sheet_id=$1
          AND NOT EXISTS (SELECT 1 FROM tab_configs tc WHERE tc.sheet_id=$1)
          AND NOT EXISTS (SELECT 1 FROM raw_sheet_tabs r WHERE r.sheet_id=$1)
          AND NOT EXISTS (SELECT 1 FROM index_master im WHERE im.sheet_id=$1)`, [sheetId]);

    await client.query('COMMIT');
    logger.info(`[workTabDelete] "${tabName}" (${sheetId}) 삭제 by ${by} — 행 ${totalRows} · 공고 삭제 ${rc.rowCount} · 오더 링크 해제 ${wo.rowCount}`
      + (recordedTombstones ? ` · 캡처 묘비 ${recordedTombstones}건` : ''));

    /* ★ 커밋 뒤에만 외부 저장을 손댄다. 실패해도 **삭제 자체는 성공**이므로 throw 하지 않고
       결과를 실어 보낸다(화면이 폴더 링크와 사유를 보여 사람이 손으로 치울 수 있다). */
    const driveTrashed = (deleteDrive === true && driveTargets.length)
      ? await _trashDriveFolders(driveTargets, by)
      : [];

    /* ★ 인트라넷 "보낸 오더" 카드에도 알린다 — 그쪽 목록은 리뷰웹 원장을 실시간 조회하므로
       `tab_deleted_at` 은 인트라넷이 그 필드를 읽도록 고친 뒤에야 보인다. 반면 처리메모
       webhook 은 **지금 있는 채널**이라 인트라넷 배포 없이 그 자리에서 주황 메모로 뜬다.
       ★ 실행부는 `intranetMemo.service` 한 벌(사본 금지) · fail-soft(절대 throw 없음). */
    const orderNotices = await _notifyOrdersTabDeleted(wo.rows || [], tabName, by);

    return {
      ok: true, sheetId, tabName, deleted, totalRows, recordedTombstones, driveTrashed, orderNotices,
      paymentDeleted: (money.length && forcePayment === true) ? money : [],
      workOrdersUnlinked: wo.rowCount || 0, campaignsDeleted: rc.rowCount || 0,
      ownershipRemoved: ac.rowCount || 0, sheetRowRemoved: cam.rowCount || 0,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

/**
 * 삭제된 작업의 연결 작업오더에 "언제 지워졌나"를 알린다.
 * ★ memo_log 에 `kind:'tab_deleted'` 로 누적(이력 — 재접수해서 `tab_deleted_at` 이 비어도 남는다)
 *   + 기존 처리메모 webhook 으로 push(인트라넷 수신부 무변경).
 * ★ 절대 throw 없음 — 삭제는 이미 커밋됐다.
 */
async function _notifyOrdersTabDeleted(orders, tabName, by) {
  if (!Array.isArray(orders) || !orders.length) return [];
  const { pushIntranetMemo, appendMemoLog } = require('./intranetMemo.service');
  const at = new Date().toISOString();
  const memo = `[작업 삭제] "${tabName}" 작업표가 삭제되었습니다. 이 오더의 작업 연결이 해제되었습니다 — 다시 진행하려면 재접수하세요.`;
  const out = [];
  for (const o of orders) {
    let delivered = false, deliverError = null;
    try { ({ delivered, deliverError } = await pushIntranetMemo(o, memo, by, at)); }
    catch (e) { deliverError = (e && e.message) || String(e); }
    try { await appendMemoLog(_db(), o.id, { memo, by, at, delivered, error: deliverError, kind: 'tab_deleted' }); }
    catch (_) { /* fail-soft */ }
    out.push({ id: o.id, title: o.title, delivered, error: deliverError });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   지워진 작업의 남은 공고 정리 (사용자 확정 2026-08-19)
   ──────────────────────────────────────────────────────────────────────────
   왜: 작업 삭제가 공고까지 지우기 **전에** 지운 작업들이 있어(그때는 보관 처리만 했다),
   가리키는 작업이 없는 공고가 목록에 남아 있다. 그 잔재를 사람이 확인하고 치우는 창구다.

   ★★ 판정은 fail-closed — "연결이 **명시돼 있는데** 그 작업이 어디에도 없다" 만 고른다.
     · 연결 시트·탭이 **둘 다 적혀 있어야** 한다 — 빈 값은 "미연결 공고"(정상 발행 전 상태)라
       대상이 아니다. 빈 값으로 매칭하면 멀쩡한 공고가 통째로 지워진다.
     · `tab_configs`(등록부) · `index_master`(장부) · `raw_sheet_tabs`(시트 미러) **셋 다 없을 때만**.
       하나라도 있으면 그 작업은 살아 있다(등록만 빠진 상태일 수 있다).
     · 탭 이름이 바뀐 경우를 대비해 **gid 로도 찾아본다**(리네임을 삭제로 오인하지 않는다).
   ★ 실행은 **id 를 받아** 그 시점에 다시 판정한다 — 낡은 화면이 보낸 id 라도 지금 살아 있는
     작업의 공고면 건너뛰고 사유를 보고한다(조용한 파괴 금지).
   ══════════════════════════════════════════════════════════════════════════ */
const ORPHAN_CAMPAIGN_WHERE = `
      COALESCE(rc.linked_sheet_id,'') <> '' AND COALESCE(rc.linked_tab_name,'') <> ''
  AND NOT EXISTS (SELECT 1 FROM tab_configs tc
                   WHERE tc.sheet_id = rc.linked_sheet_id
                     AND (tc.tab_name = rc.linked_tab_name
                          OR (COALESCE(rc.linked_tab_gid,'') <> '' AND tc.tab_gid = rc.linked_tab_gid)))
  AND NOT EXISTS (SELECT 1 FROM index_master im
                   WHERE im.sheet_id = rc.linked_sheet_id
                     AND (im.tab_name = rc.linked_tab_name
                          OR (COALESCE(rc.linked_tab_gid,'') <> '' AND im.tab_gid = rc.linked_tab_gid)))
  AND NOT EXISTS (SELECT 1 FROM raw_sheet_tabs rst
                   WHERE rst.sheet_id = rc.linked_sheet_id
                     AND (rst.tab_name = rc.linked_tab_name
                          OR (COALESCE(rc.linked_tab_gid,'') <> '' AND rst.tab_gid = rc.linked_tab_gid)))`;

/** 미리보기 — **쓰기 0건**. 무엇이 지워질지 사람이 보고 판단한다. */
async function findOrphanCampaigns({ limit = 200, pool } = {}) {
  const db = pool || _db();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const { rows } = await db.query(
    `SELECT rc.id, rc.title, rc.status, rc.archived_at AS "archivedAt", rc.created_at AS "createdAt",
            rc.linked_sheet_id AS "sheetId", rc.linked_tab_name AS "tabName",
            (SELECT COUNT(*) FROM campaign_applications ca WHERE ca.campaign_id = rc.id)::int AS applications
       FROM recruit_campaigns rc
      WHERE ${ORPHAN_CAMPAIGN_WHERE}
      ORDER BY rc.created_at DESC LIMIT $1`, [lim]);
  return { ok: true, items: rows || [], truncated: (rows || []).length >= lim };
}

/** 실행 — 고른 공고만, 그 시점에 다시 판정해서. 참여 신청 등은 FK CASCADE 로 함께 사라진다. */
async function deleteOrphanCampaigns({ ids, confirm, by = 'admin', pool } = {}) {
  if (confirm !== true) return { ok: false, code: 'confirm_required', error: '삭제 확인이 필요합니다.' };
  const list = (Array.isArray(ids) ? ids : []).map(x => String(x || '')).filter(Boolean).slice(0, 500);
  if (!list.length) return { ok: false, code: 'empty', error: '지울 공고를 고르지 않았습니다.' };

  const db = pool || _db();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // ★ 지금도 고아인 것만 지운다 — 그 사이 작업이 되살아났으면 건너뛴다(낡은 화면 방어).
    const { rows } = await client.query(
      `DELETE FROM recruit_campaigns rc
        WHERE rc.id = ANY($1::text[]) AND ${ORPHAN_CAMPAIGN_WHERE}
        RETURNING rc.id, rc.title`, [list]);
    await client.query('COMMIT');
    const deleted = rows || [];
    const skipped = list.filter(id => !deleted.some(r => String(r.id) === id));
    logger.info(`[workTabDelete/orphanCampaigns] ${deleted.length}건 삭제 by ${by}${skipped.length ? ` · 건너뜀 ${skipped.length}` : ''}`);
    return { ok: true, deleted: deleted.length, items: deleted, skipped: skipped.length, skippedIds: skipped };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

module.exports = { previewTaskDelete, deleteTask, DRIVE_FOLDER_KINDS, findOrphanCampaigns, deleteOrphanCampaigns, DELETE_TABLES, MONEY_TABLES, KEEP_TABLES, __setPoolForTest };
