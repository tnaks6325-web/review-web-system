/**
 * sheetlessCutover.service.js — 탈 구글시트 W4(C): 전환 관리
 *
 * "이 작업을 이제 구글시트 없이 돌린다"고 **선언하는 유일한 창구**.
 * 표식(`tab_configs.sheetless`)은 W1 에서 만들었지만 그것을 켜는 화면이 없어 이관을 시작할 방법이 없었다.
 *
 * ★★ 이 서비스가 하는 일은 딱 둘 — **점검하고, 켠다**(사용자 확정).
 *    백필·미러 같은 준비 작업은 **하지 않는다**: 그건 이미 다른 화면(시트 데이터 반영 점검)에 있고,
 *    한 버튼으로 묶으면 중간 실패 시 어디까지 됐는지 사람이 알 수 없다.
 *
 * ★★ 점검표는 fail-closed — **모르면 잠근다**(`unknown` 도 통과 아님).
 *    이관은 "그 작업의 시트를 더 이상 읽지 않는다"는 선언이라, 잘못 켜면 그 작업의 시트 값이
 *    장부에 영영 반영되지 않는다(크론이 그 탭을 건너뛴다). 되돌릴 수는 있지만 그 사이의
 *    시트 편집은 아무도 모르게 흘러간다 → 확신이 없으면 열지 않는 쪽이 맞다.
 *
 * ★ 판정 재료는 전부 기존 서비스 재사용(사본 0):
 *    시트 우위 = sheetSlotSync.readPreparedRows · 대조 = trackB.parityReport
 *    열 구성   = sheetlessLedger.rebuildLedgers(dryRun+preflight) · 연도 = utils/tabActivity
 */
const { logger } = require('../utils/logger');
const activity = require('../utils/tabActivity');

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

const LIST_CAP = 800;
// 미러 신선도 — 끊기 전에 시트의 마지막 상태가 우리 쪽에 들어와 있어야 한다.
//   RAW 미러 크론이 5분 주기라 30분이면 평상시엔 늘 통과하고, 오래 멈춰 있었다면 잡힌다.
const MIRROR_FRESH_MIN = Number(process.env.SHEETLESS_MIRROR_FRESH_MIN || 30);

/** 이관 후 시트에 남길 안내. ★ 헤더 탐지 키워드를 2개 이상 넣지 말 것(sheetNotice.validateNoticeText 가 차단). */
const CUTOVER_NOTICE = '⛔ 이 작업은 리뷰웹시스템으로 이관되었습니다 · 이 문서는 더 이상 반영되지 않으니 리뷰웹시스템에서 작업해 주세요';

/* ═══════════════ 점검 항목 ═══════════════ */
//  state: 'pass' | 'fail' | 'unknown'  — pass 가 아니면 전부 잠금(fail-closed)
function _chk(key, label, state, detail, hint) {
  return { key, label, state, detail: detail || '', hint: hint || '' };
}

/** ① 시트에 준비된 줄이 시스템 표보다 많으면 안 된다(먼저 백필). */
async function _checkSheetRows(db, tab) {
  const label = '시트 준비 줄 ≤ 시스템 표';
  if (!tab.tabGid) {
    return _chk('sheet_rows', label, 'unknown', '탭 번호(gid)를 몰라 시트 사본을 읽을 수 없습니다',
      '시트 데이터 반영 점검 화면의 [gid 채우기]를 먼저 실행하세요.');
  }
  let read;
  try {
    read = await require('./sheetSlotSync.service').readPreparedRows(db, { sheetId: tab.sheetId, tabGid: tab.tabGid });
  } catch (e) {
    return _chk('sheet_rows', label, 'unknown', '시트 사본 읽기 실패: ' + e.message, '잠시 뒤 다시 확인하세요.');
  }
  if (!read || !read.ok) {
    return _chk('sheet_rows', label, 'unknown', '시트 준비 줄을 셀 수 없습니다(' + ((read && read.reason) || 'unknown') + ')',
      '구매일자 칸이 있는지, 시트 사본이 최신인지 확인하세요.');
  }
  const prepared = read.prepared.length;
  const board = Number(tab.boardRows) || 0;
  if (prepared > board) {
    return _chk('sheet_rows', label, 'fail', `시트 ${prepared}줄 · 시스템 표 ${board}줄 (${prepared - board}줄 부족)`,
      '시트 데이터 반영 점검 화면의 [슬롯 백필]로 표를 먼저 채우세요 — 지금 끊으면 그 줄들이 사라집니다.');
  }
  return _chk('sheet_rows', label, 'pass', `시트 ${prepared}줄 · 시스템 표 ${board}줄`);
}

/** ② 시트 ↔ 시스템 진짜 불일치 0. */
async function _checkParity(tab) {
  const label = '시트 ↔ 시스템 대조';
  try {
    const p = await require('./trackB.service').parityReport({ sheetId: tab.sheetId, tabName: tab.tabName });
    const real = (p && p.buckets && Number(p.buckets.real)) || 0;
    if (real > 0) {
      return _chk('parity', label, 'fail', `설명되지 않는 차이 ${real}건`,
        '작업보드에서 그 줄들을 확인해 맞춘 뒤 다시 점검하세요.');
    }
    return _chk('parity', label, 'pass', `일치 ${(p.buckets && p.buckets.match) || 0}건 · 설명되는 차이 ${(p.buckets && p.buckets.benign) || 0}건`);
  } catch (e) {
    return _chk('parity', label, 'unknown', '대조 계산 실패: ' + e.message, '잠시 뒤 다시 확인하세요.');
  }
}

/** ③ 시트에 아직 못 쓴 주문·대기 중인 쓰기가 0이어야 한다. */
async function _checkPending(db, tab) {
  const label = '시트 반영 대기 0';
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM order_submissions
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
          AND COALESCE(mirror_status, 'pending') <> 'written'`, [tab.sheetId, tab.tabName]);
    const orders = (rows[0] && rows[0].n) || 0;
    const { rows: q } = await db.query(
      `SELECT COUNT(*)::int AS n FROM sync_queue
        WHERE status IN ('pending', 'processing')
          AND payload->>'sheetId' = $1 AND payload->>'tabName' = $2`, [tab.sheetId, tab.tabName]);
    const queued = (q[0] && q[0].n) || 0;
    if (orders || queued) {
      return _chk('pending', label, 'fail', `미반영 주문 ${orders}건 · 쓰기 대기 ${queued}건`,
        '먼저 반영을 끝내세요 — 지금 끊으면 그 주문들이 시트에도 표에도 안 남습니다.');
    }
    return _chk('pending', label, 'pass', '남은 것 없음');
  } catch (e) {
    return _chk('pending', label, 'unknown', '조회 실패: ' + e.message, '잠시 뒤 다시 확인하세요.');
  }
}

/** ④ 시트 사본이 최근 것이어야 한다(끊기 직전의 시트 상태가 우리 쪽에 있어야). */
async function _checkMirror(tab, now) {
  const label = '시트 사본 최신';
  const at = tab.mirroredAt ? new Date(tab.mirroredAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return _chk('mirror', label, 'unknown', '시트를 읽어 온 기록이 없습니다',
      '시트 데이터 반영 점검 화면에서 그 시트를 한 번 새로고침하세요.');
  }
  const min = Math.floor((now.getTime() - at.getTime()) / 60000);
  if (min > MIRROR_FRESH_MIN) {
    return _chk('mirror', label, 'fail', `마지막으로 읽어 온 지 ${min}분 지남(기준 ${MIRROR_FRESH_MIN}분)`,
      '시트를 한 번 새로고침해 최신 상태를 받아 온 뒤 이관하세요.');
  }
  return _chk('mirror', label, 'pass', `${min}분 전에 읽어 옴`);
}

/** ⑤ 열 구성을 알아볼 수 있어야 한다 — 못 하면 끊는 순간 검색·행배정이 통째로 죽는다. */
async function _checkLedger(tab) {
  const label = '열 구성 인식';
  try {
    const r = await require('./sheetlessLedger.service').rebuildLedgers({
      sheetId: tab.sheetId, tabName: tab.tabName, dryRun: true, preflight: true,
    });
    return _chk('ledger', label, 'pass', `열 ${(r.headers || []).length}개 · 표 ${r.mirrorRows}줄 → 검색 명단 ${r.indexRows}명`);
  } catch (e) {
    const code = e && e.code ? e.code : '';
    if (code === 'no_headers') {
      return _chk('ledger', label, 'fail', '열 이름을 알 수 없습니다',
        '작업표(열 이름 줄)가 있는지 확인하세요 — 열 이름이 곧 시스템의 판정 재료입니다.');
    }
    if (code === 'tab_not_registered') {
      return _chk('ledger', label, 'fail', '등록되지 않은 탭입니다', '작업오더 접수를 먼저 하세요.');
    }
    return _chk('ledger', label, 'unknown', '확인 실패: ' + e.message, '잠시 뒤 다시 확인하세요.');
  }
}

/** 한 탭의 기본 정보(점검·이관 공통 재료). */
async function _loadTab(db, sheetId, tabName) {
  const { rows } = await db.query(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
            COALESCE(NULLIF(tc.tab_gid,''), rst."mirrorGid") AS "tabGid",
            COALESCE(tc.display_name, tc.tab_name) AS "displayName",
            COALESCE(tc.sheetless, FALSE) AS "sheetless",
            tc.sheetless_at AS "sheetlessAt", tc.sheetless_by AS "sheetlessBy",
            rst."mirroredAt", cp.cnt AS "boardRows"
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT r.mirrored_at AS "mirroredAt", r.tab_gid AS "mirrorGid"
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
      WHERE tc.sheet_id = $1 AND tc.tab_name = $2
      LIMIT 1`, [sheetId, tabName]);
  return rows[0] || null;
}

/* ═══════════════ 공개 API ═══════════════ */

/**
 * 이관 점검표 — 읽기 전용. 5항목 모두 pass 여야 `canCutover`.
 * ★ 이미 이관된 탭은 점검하지 않는다(점검 대상이 아니라 되돌리기 대상).
 */
async function cutoverChecklist({ sheetId, tabName, now = new Date() } = {}) {
  if (!sheetId || !tabName) throw new Error('cutoverChecklist: sheetId, tabName 필수');
  const db = _db();
  const tab = await _loadTab(db, sheetId, tabName);
  if (!tab) return { ok: false, reason: 'tab_not_found', message: '등록되지 않은 작업입니다.' };
  if (tab.sheetless) {
    return { ok: true, sheetId, tabName, displayName: tab.displayName, already: true, checks: [], canCutover: false,
      message: '이미 이관된 작업입니다.' };
  }
  const checks = [
    await _checkSheetRows(db, tab),
    await _checkParity(tab),
    await _checkPending(db, tab),
    await _checkMirror(tab, now),
    await _checkLedger(tab),
  ];
  // ★★ fail-closed — pass 가 아닌 항목이 하나라도 있으면 잠근다('unknown' 포함).
  const blocking = checks.filter(c => c.state !== 'pass');
  return {
    ok: true, sheetId, tabName, tabGid: tab.tabGid || null, displayName: tab.displayName,
    already: false, checks,
    canCutover: blocking.length === 0,
    blocking: blocking.map(c => c.key),
  };
}

/**
 * 전환 대상 목록 — 이관됨 / 남음. 읽기 전용·가벼운 요약만(점검은 한 건씩 눌러서).
 * ★ 연도 하한(기본 2026~)을 그대로 적용 — 과거 작업이 목록을 덮으면 이관할 것을 못 찾는다.
 */
async function listCutoverTabs({ since = null, includeUnknown = false, limit = LIST_CAP } = {}) {
  const db = _db();
  const lim = Math.min(Math.max(parseInt(limit, 10) || LIST_CAP, 1), LIST_CAP);
  const sinceDay = activity.normalizeSince(since);
  const { rows } = await db.query(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
            COALESCE(NULLIF(tc.tab_gid,''), rst."mirrorGid") AS "tabGid",
            COALESCE(tc.display_name, tc.tab_name) AS "displayName",
            COALESCE(tc.sheetless, FALSE) AS "sheetless",
            tc.sheetless_at AS "sheetlessAt", tc.sheetless_by AS "sheetlessBy",
            rst."mirroredAt", cp.cnt AS "boardRows", pend.n AS "pendingOrders",
            ${activity.ACTIVITY_SELECT_SQL}
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT r.mirrored_at AS "mirroredAt", r.tab_gid AS "mirrorGid"
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
         SELECT COUNT(*)::int AS n FROM order_submissions o
          WHERE o.sheet_id = tc.sheet_id AND o.tab_name = tc.tab_name AND o.deleted_at IS NULL
            AND COALESCE(o.mirror_status, 'pending') <> 'written'
       ) pend ON TRUE
       ${activity.ACTIVITY_LATERAL_SQL}
      WHERE COALESCE(tc.is_closed, FALSE) = FALSE
      ORDER BY tc.sheet_id, tc.tab_name
      LIMIT $1`, [lim]);

  let filteredOld = 0, yearUnknown = 0;
  const items = [];
  for (const t of rows) {
    // ★ 이미 이관된 작업은 연도 필터로 숨기지 않는다 — "이관됨 N" 이 조용히 줄어들면 현황이 거짓말이 된다.
    if (!t.sheetless) {
      const v = activity.activityVerdict(activity.resolveActivity(t), sinceDay, includeUnknown);
      if (v === 'old') { filteredOld++; continue; }
      if (v === 'unknown') { yearUnknown++; continue; }
    }
    items.push({
      sheetId: t.sheetId, tabName: t.tabName, tabGid: t.tabGid || null, displayName: t.displayName,
      sheetless: t.sheetless === true,
      sheetlessAt: t.sheetlessAt || null, sheetlessBy: t.sheetlessBy || null,
      boardRows: Number(t.boardRows) || 0,
      pendingOrders: Number(t.pendingOrders) || 0,
      mirroredAt: t.mirroredAt || null,
      activitySource: t.activitySource || null,
    });
  }
  const done = items.filter(i => i.sheetless).length;
  return {
    ok: true, since: sinceDay, includeUnknown: !!includeUnknown,
    filteredOld, yearUnknown, truncated: rows.length >= lim,
    total: items.length, done, remaining: items.length - done,
    items,
  };
}

/**
 * 이관 — 무시트 표식을 켠다(= 그 작업의 시트 연결을 끊는다).
 * ★ 작업명 타이핑 확정 필수(오클릭 방지) · 점검표 fail-closed · force 는 명시 요청일 때만.
 */
async function enableSheetless({ sheetId, tabName, confirmName, by = '', force = false, now = new Date() } = {}) {
  if (!sheetId || !tabName) throw new Error('enableSheetless: sheetId, tabName 필수');
  const db = _db();
  const tab = await _loadTab(db, sheetId, tabName);
  if (!tab) return { ok: false, reason: 'tab_not_found', message: '등록되지 않은 작업입니다.' };
  if (tab.sheetless) return { ok: true, already: true, message: '이미 이관된 작업입니다.' };

  // ★ 타이핑 확정 — 목록에서 옆 줄을 눌렀을 때 그대로 실행되지 않게(관측 뷰 force 마찰과 같은 장치).
  if (String(confirmName || '').trim() !== String(tabName).trim()) {
    return { ok: false, reason: 'confirm_mismatch', message: '작업 이름을 정확히 입력해야 이관됩니다.' };
  }

  const list = await cutoverChecklist({ sheetId, tabName, now });
  if (!list.ok) return list;
  if (!list.canCutover && !force) {
    return { ok: false, reason: 'checklist_failed', message: '점검표를 통과하지 못했습니다.',
      blocking: list.blocking, checks: list.checks };
  }
  if (!list.canCutover && force) {
    logger.warn(`[cutover] UNVERIFIED 이관 — ${tabName} (${sheetId}) by=${by} blocking=${(list.blocking || []).join(',')}`);
  }

  await db.query(
    `UPDATE tab_configs SET sheetless = TRUE, sheetless_at = NOW(), sheetless_by = $3
      WHERE sheet_id = $1 AND tab_name = $2`, [sheetId, tabName, String(by || '').slice(0, 100)]);

  // ── 부수효과 2종. 둘 다 실패해도 이관 자체는 유지하고 **사유를 응답에 실어** 화면이 말한다.
  //    (되돌리면 크론이 다시 시트를 읽으므로, 부수효과 실패로 이관을 롤백할 이유가 없다.)
  let ledger = null;
  try {
    ledger = await require('./sheetlessLedger.service').rebuildLedgers({ sheetId, tabName, by: by || 'cutover' });
  } catch (e) {
    ledger = { ok: false, reason: e.code || 'error', message: e.message };
    logger.warn(`[cutover] 장부 재생성 실패(이관은 유지) — ${tabName}: ${e.message}`);
  }

  let notice = null;
  try {
    // ★ force:true — 시트에 이미 있는 공지는 "행 삭제 금지" 안내인데, 이제 그 시트를 안 쓰므로
    //   그대로 두면 직원이 계속 그 시트에서 작업한다. 이관 안내가 그 자리를 대신해야 한다.
    notice = await require('./sheetNotice.service').applySheetNotice(sheetId, {
      gid: tab.tabGid || undefined, tabName, text: CUTOVER_NOTICE, force: true,
    });
  } catch (e) {
    notice = { ok: false, skipped: 'exception', message: e.message };
  }

  logger.info(`[cutover] 이관 완료 — ${tabName} (${sheetId}) by=${by}${force && !list.canCutover ? ' [UNVERIFIED]' : ''}`);
  return { ok: true, sheetId, tabName, displayName: tab.displayName, forced: !!(force && !list.canCutover), ledger, notice };
}

/**
 * 되돌리기(재연결) — 시트를 다시 읽게 한다. 비상구라 점검표를 요구하지 않는다.
 * ★ `sheetless_at`/`sheetless_by` 는 지우지 않는다 — "언제 누가 이관했었나"가 유일한 이력이다.
 */
async function disableSheetless({ sheetId, tabName, by = '' } = {}) {
  if (!sheetId || !tabName) throw new Error('disableSheetless: sheetId, tabName 필수');
  const db = _db();
  const { rowCount } = await db.query(
    `UPDATE tab_configs SET sheetless = FALSE
      WHERE sheet_id = $1 AND tab_name = $2 AND COALESCE(sheetless, FALSE) = TRUE`, [sheetId, tabName]);
  if (!rowCount) {
    // 0행 = 원래 시트 기반이었다는 뜻 — "되돌렸습니다"로 꾸미지 않는다.
    return { ok: true, changed: false, message: '이미 시트 기반 작업입니다.' };
  }
  logger.warn(`[cutover] 재연결 — ${tabName} (${sheetId}) by=${by} · 다음 주기부터 시트 값이 장부를 덮습니다`);
  return { ok: true, changed: true,
    message: '시트를 다시 읽습니다 — 다음 갱신부터 시트 값이 시스템 표 대신 반영됩니다.' };
}

module.exports = {
  cutoverChecklist,
  listCutoverTabs,
  enableSheetless,
  disableSheetless,
  CUTOVER_NOTICE,
  MIRROR_FRESH_MIN,
  __setPoolForTest,
};
