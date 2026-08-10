// ═══════════════════════════════════════════════════════════════════════════
// 블로그체험단 M3 — (주)바를참스킨 「0804)비타민,글루타치온_블로그 50건」 1회 동기화
//
// **사고**: 이 작업은 블로그체험단이라 구매일자를 미리 정할 수 없는데(모집되는 대로 그때그때
//   입력), 무시트 이관의 준비 행 판정이 **구매일자 날짜 파싱 성공**을 유일 조건으로 써서
//   빈 행이 통째로 **무음 누락**된 채 이관됐다(점검표 ① 도 같은 판정이라 초록으로 통과).
//   M2 가 판정을 고쳤지만 **이 탭은 이미 이관돼** 시스템이 시트를 더 안 읽고, 내부 시트 사본
//   (RAW 미러)도 작업표 기준으로 재생성돼 **빈 행 기록 자체가 없다** → 시트를 한 번은 다시 읽어야 한다.
//
// ★ 사용자 확정: **전용 화면·엔드포인트를 만들지 않는다**("별도 전용기능 구현 필요없이 그 작업만").
//   그래서 부팅 1회성 잡 + `app_settings` 가드(migration 057·제출열 핫픽스와 같은 선례).
//
// ★★ 이 잡은 **추가만** 한다 — 기존 행·제출·입금 표시를 건드리지 않고(ON CONFLICT DO NOTHING),
//   **시트에는 한 글자도 쓰지 않는다**(읽기 1회뿐).
// ★★ 판정 사본 0: 준비 행 고르기 = `sheetSlotSync.pickBlogPrepared` · 값 있음 = `rowHasValue` ·
//   헤더 탐지 = `utils/sheetHeader` · 행 JSON = `rowJsonFromHeaders` · 슬롯 INSERT 는
//   `participants.createSlotsFromSheetRows`(campaign_participants 쓰기 소유자) · 장부는 `rebuildLedgers`.
// ★ fail-soft: 실패하면 **가드를 기록하지 않아** 다음 부팅에 재시도하고, 부팅 자체는 계속된다.
// ★ 킬스위치 `BLOG_0804_BACKFILL=0`.
// ═══════════════════════════════════════════════════════════════════════════
const { detectSheetHeader, normalizeCells } = require('../utils/sheetHeader');
const { pickBlogPrepared, rowHasValue, rowJsonFromHeaders } = require('./sheetSlotSync.service');
const { workOrderForTabSql } = require('../utils/workOrderLink');
const participants = require('./participants.service');
const { logger } = require('../utils/logger');

const GUARD_KEY = 'blog_0804_slot_backfill_done';

/** 대상 = PRD 에 못박힌 그 작업 하나(범용 도구가 아니다). */
const TARGET = {
  sheetId: '1kLjLprT55A60Npz6gLtx6BeF8KrddsMEin-9jFt_tp8',
  tabGid: '545717806',
  rows: 50,                 // 「…블로그 50건」 — 하드 상한(총원을 못 읽어도 이 수를 넘기지 않는다)
};

const HEADER_SCAN_ROWS = 60;   // sheetSlotSync 와 같은 범위(상단 캠페인 정보 블록을 넘기기 충분)

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

/**
 * 1회 동기화 실행.
 * @param {{dryRun?:boolean, force?:boolean, deps?:object}} opts
 *   dryRun = 쓰기 0(만들 자리 수만 계산) · force = 가드 무시(재실행) · deps = 테스트 주입
 * @returns {Promise<{ok:boolean, reason?:string, ...}>}
 */
async function runBlog0804Backfill({ dryRun = false, force = false, deps = {} } = {}) {
  if (process.env.BLOG_0804_BACKFILL === '0') return { ok: false, reason: 'disabled' };

  const db = deps.db || _db();
  const readSheet = deps.readSheet || require('./sheets.service').readSheet;
  const throttledCall = deps.throttledCall || require('../utils/sheetsThrottle').throttledCall;
  const rebuildLedgers = deps.rebuildLedgers || require('./sheetlessLedger.service').rebuildLedgers;

  // ── 가드: 이미 했으면 아무것도 안 한다(재배포마다 시트를 다시 읽지 않는다) ──
  if (!force) {
    const { rows } = await db.query('SELECT 1 FROM app_settings WHERE key = $1', [GUARD_KEY]);
    if (rows.length) return { ok: true, reason: 'already_done', created: 0 };
  }

  // ── 대상 탭 해석: gid 로 찾는다(이름은 바뀔 수 있다) ──
  const { rows: tc } = await db.query(
    `SELECT tab_name AS "tabName", campaign_name AS "campaignName",
            COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1`,
    [TARGET.sheetId, TARGET.tabGid]);
  if (!tc.length) return { ok: false, reason: 'tab_not_registered' };
  const { tabName, campaignName, sheetless } = tc[0];

  // ── 시트 1회 읽기(저우선 lane — 주문 쓰기 슬롯 무접촉) ──
  //   ★ 무시트 크론 게이트(sheetlessScope)는 **주기 작업용**이라 이 명시적 1회 읽기와 무관하다.
  //   ★ FORMATTED_VALUE = 미러와 같은 표기(시트에 보이는 그대로) — 그리드가 그대로 그린다.
  let values;
  try {
    values = await throttledCall(
      () => readSheet(TARGET.sheetId, `'${tabName}'!A:ZZ`,
        { gid: TARGET.tabGid, valueRenderOption: 'FORMATTED_VALUE' }),
      2, { priority: 'low' });
  } catch (e) {
    return { ok: false, reason: 'sheet_read_failed', error: e.message };
  }
  const grid = Array.isArray(values) ? values : [];
  if (!grid.length) return { ok: false, reason: 'sheet_empty' };

  // ── 헤더 탐지(사본 금지 — 인덱스 빌더와 같은 함수) ──
  const det = detectSheetHeader(grid.slice(0, HEADER_SCAN_ROWS));
  if (!det.headers || det.headerRowIndex == null) return { ok: false, reason: 'header_unrecognizable' };
  const headers = det.headers;
  const headerRow = det.headerRowIndex;          // 1-based 시트 행 번호

  // ── 준비 행 고르기: M2 와 **같은 함수**(값이 있는 행 · 총원까지만) ──
  //   seq = **시트 실제 행 번호**(배열 인덱스 + 1). 어긋나면 주문 유입 시
  //   `ON CONFLICT (sheet_id, tab_name, seq)` 가 제자리 갱신을 못 해 표가 두 겹이 된다.
  const list = [];
  for (let i = headerRow; i < grid.length; i++) {          // headerRow(1-based) → 그 다음 배열 인덱스부터
    const cells = normalizeCells(grid[i]);
    list.push({
      filled: rowHasValue(cells),
      item: { seq: i + 1, rowJson: rowJsonFromHeaders(headers, cells) },
    });
  }
  const pick = pickBlogPrepared(list, TARGET.rows);
  if (!pick.prepared.length) return { ok: false, reason: 'no_prepared_rows', solidRows: pick.solidRows };

  // ── 이미 있는 자리는 건드리지 않는다 ──
  const { rows: ex } = await db.query(
    `SELECT seq FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL`,
    [TARGET.sheetId, tabName]);
  const have = new Set(ex.map(r => Number(r.seq)));
  const missing = pick.prepared.filter(p => !have.has(Number(p.seq)));

  const base = {
    ok: true, sheetId: TARGET.sheetId, tabName, tabGid: TARGET.tabGid,
    headerRow, preparedRows: pick.prepared.length, solidRows: pick.solidRows,
    shortOfTotal: pick.shortOfTotal, beyondTotal: pick.beyondTotal,
    existingRows: have.size, missing: missing.length, sheetless,
  };
  if (dryRun) return { ...base, dryRun: true, created: 0 };

  // ── ① 슬롯 생성(추가만·멱등) ──
  let created = 0;
  if (missing.length) {
    const res = await participants.createSlotsFromSheetRows({
      sheetId: TARGET.sheetId, tabName, tabGid: TARGET.tabGid, campaignName: campaignName || null,
      rows: missing.map(p => ({ seq: p.seq, rowJson: p.rowJson })),
      by: 'boot:blog-0804',
    });
    created = res.created;
  }

  // ── ② 장부 재생성(무시트 탭만 — 시트 기반이면 장부는 시트가 만든다) ──
  let ledger = 'skipped_not_sheetless';
  if (sheetless) {
    try {
      await rebuildLedgers({ sheetId: TARGET.sheetId, tabName, by: 'boot:blog-0804' });
      ledger = 'rebuilt';
    } catch (e) {
      // 자리는 이미 만들어졌다(작업보드 표는 표를 직접 읽는다) — 장부만 다음 재생성 때 따라온다.
      ledger = `failed: ${e.message}`;
      logger.warn(`[blog0804] 장부 재생성 실패(자리는 생성됨): ${e.message}`);
    }
  }

  // ── ③ 분류(blank-only — 사람이 정해 둔 값을 덮지 않는다) ──
  const classified = await _classifyBlog(db, { sheetId: TARGET.sheetId, tabName });

  // ── ④ 가드 기록 ──
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, NOW()::text, NOW())
     ON CONFLICT (key) DO NOTHING`, [GUARD_KEY]);

  logger.info(`[blog0804] 1회 동기화 완료: +${created}자리 (준비 ${pick.prepared.length} · 기존 ${have.size} · 장부 ${ledger})`);
  return { ...base, dryRun: false, created, ledger, ...classified };
}

/**
 * 그 탭과 연결 작업오더를 blog 로 분류. **blank-only** — 이미 값이 있으면 그대로 둔다
 * (관리자가 정해 둔 값을 1회성 잡이 덮지 않는다).
 * ★ 작업오더 지목은 `workOrderForTabSql`(Track B 링크 우선) — 우선순위 사본 금지.
 */
async function _classifyBlog(db, { sheetId, tabName }) {
  const out = { tabClassified: false, orderClassified: false };
  try {
    const t = await db.query(
      `UPDATE tab_configs SET work_kind = 'blog', updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2 AND COALESCE(work_kind, '') = ''`,
      [sheetId, tabName]);
    out.tabClassified = t.rowCount > 0;

    const { rows: wo } = await db.query(workOrderForTabSql(['id']), [sheetId, tabName]);
    if (wo.length) {
      const o = await db.query(
        `UPDATE work_orders SET work_kind = 'blog', updated_at = NOW()
          WHERE id = $1 AND COALESCE(work_kind, '') = ''`, [wo[0].id]);
      out.orderClassified = o.rowCount > 0;
      out.workOrderId = wo[0].id;
    }
  } catch (e) {
    // 분류는 표시·판정 보조라 실패해도 자리 생성을 되돌리지 않는다(사유만 남긴다).
    out.classifyError = e.message;
    logger.warn(`[blog0804] 분류 실패(자리는 생성됨): ${e.message}`);
  }
  return out;
}

module.exports = { runBlog0804Backfill, GUARD_KEY, TARGET, __setPoolForTest };
