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

/** 이관 후 시트에 남길 안내. ★ 헤더 탐지 키워드를 2개 이상 넣지 말 것(sheetNotice.validateNoticeText 가 차단). */
const CUTOVER_NOTICE = '⛔ 이 작업은 리뷰웹시스템으로 이관되었습니다 · 이 문서는 더 이상 반영되지 않으니 리뷰웹시스템에서 작업해 주세요';

/* ═══════════════ 점검 항목 ═══════════════ */
//  state: 'pass' | 'fail' | 'unknown'  — pass 가 아니면 전부 잠금(fail-closed)
/**
 * @param {string} [fix] 그 자리에서 누를 수 있는 조치 —
 *   `'refresh'` = 시트 새로고침(repair) · `'audit'` = 반영 점검 화면 열기.
 *   ★★ 막힌 항목이 **다른 화면 이름만 말하고 끝나면 안 된다**(실측: 안내가 가리킨
 *      "시트 데이터 반영 점검 화면"은 nav 어디에도 없어 주소를 직접 쳐야 열렸다).
 *      무엇을 누를지는 **서버가 말하고** 화면은 그대로 그린다(프론트 재판정 0 규율).
 */
function _chk(key, label, state, detail, hint, fix) {
  return { key, label, state, detail: detail || '', hint: hint || '', fix: fix || null };
}

/** ① 시트에 준비된 줄이 시스템 표보다 많으면 안 된다(먼저 백필). */
async function _checkSheetRows(db, tab) {
  const label = '시트 준비 줄 ≤ 시스템 표';
  if (!tab.tabGid) {
    return _chk('sheet_rows', label, 'unknown', '탭 번호(gid)를 몰라 시트 사본을 읽을 수 없습니다',
      '[반영 점검 열기] 에서 gid 를 채운 뒤 다시 점검하세요.', 'audit');
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
      '[반영 점검 열기] 의 시트 우위 점검에서 표를 먼저 채우세요 — 지금 끊으면 그 줄들이 사라집니다.', 'audit');
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

/**
 * ③ 시트에 아직 못 쓴 주문 — **이관할 때 작업표로 옮긴다**(사용자 확정 2026-08-07 "B로 진행").
 *
 * ★★ 종전엔 미반영 주문이 1건이라도 있으면 무조건 잠갔다. 막으려던 위험은
 *    "지금 끊으면 그 주문들이 **시트에도 표에도** 안 남는다" 였는데, 이제 이관이 그 주문들을
 *    작업표로 인계하므로 **표에는 남는다** → 그 위험이 사라진다. 그래서 통과시키는 것은
 *    완화가 아니라 **사실 반영**이다(fail-closed 는 여전히 아래 한 갈래에서 살아 있다).
 * ★★ 다만 **배정된 줄이 없는 주문**은 옮길 자리가 없어 진짜로 사라진다 → 그건 계속 잠근다.
 *    (그 줄은 복구 작업이 배정한다 — 잠시 뒤 다시 점검하면 인계 가능해진다.)
 * ★ 쓰기 대기 큐는 잠금 사유에서 뺐다 — 이관 후 큐 실행부 백스톱이 사유와 함께 종결하고,
 *   그 주문 자체는 위 집계에 잡혀 인계된다(같은 사실을 두 번 세면 영영 안 열린다).
 */
async function _checkPending(db, tab) {
  const label = '시트 반영 대기 0';
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE sheet_row IS NOT NULL)::int AS handoff,
              COUNT(*) FILTER (WHERE sheet_row IS NULL)::int     AS blocked
         FROM order_submissions
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
          AND COALESCE(mirror_status, 'pending') <> 'written'`, [tab.sheetId, tab.tabName]);
    const handoff = (rows[0] && rows[0].handoff) || 0;
    const blocked = (rows[0] && rows[0].blocked) || 0;
    if (blocked) {
      return _chk('pending', label, 'fail', `배정된 줄이 없는 미반영 주문 ${blocked}건`,
        '옮길 자리가 없어 지금 끊으면 그 주문이 사라집니다 — 복구 작업이 줄을 배정할 때까지 기다렸다 다시 점검하세요.');
    }
    if (handoff) {
      return _chk('pending', label, 'pass', `미반영 주문 ${handoff}건 — 이관할 때 표로 옮깁니다(시트에 쓰지 않습니다)`);
    }
    return _chk('pending', label, 'pass', '남은 것 없음');
  } catch (e) {
    return _chk('pending', label, 'unknown', '조회 실패: ' + e.message, '잠시 뒤 다시 확인하세요.');
  }
}

/**
 * ④ 시트의 **최신 상태를 우리가 갖고 있어야** 한다.
 *
 * ★★ 종전엔 `mirrored_at` 의 경과 시간(30분)으로 봤는데 **틀린 판정이었다**(2026-08 실측):
 *    미러는 **내용이 바뀐 탭만** 다시 읽고 `mirrored_at` 을 갱신한다(변경 없으면 시트 단위로
 *    통째 skip). 즉 조용한 작업일수록 그 값이 낡아져 **이관하기 가장 좋은 작업(끝나서 조용한
 *    작업)이 영구히 막혔다** — 실제로 등록 작업 86건이 전부 이 항목에서 잠겼다.
 * ★ 그래서 "얼마나 오래됐나"가 아니라 **"그 뒤로 시트가 바뀌었나"** 를 본다.
 *   Drive 최종수정 시각을 그 자리에서 1콜 조회해 우리가 읽어 둔 시점과 대조한다.
 * ★ 이 화면에서 **외부 API 를 쓰는 유일한 경로** — 사람이 [점검]을 누를 때만, 탭당 1콜,
 *   그리고 **시트 lane 이 아니라 drive lane**(주문 쓰기 슬롯을 건드리지 않는다).
 * ★ 조회 실패는 `unknown` = 잠금(fail-closed) — 모르면 열지 않는다.
 */
async function _checkMirror(tab, now) {
  const label = '시트 최신 상태 확보';
  const mirroredAt = tab.mirroredAt ? new Date(tab.mirroredAt).getTime() : 0;
  if (!mirroredAt) {
    return _chk('mirror', label, 'unknown', '시트를 읽어 온 기록이 없습니다',
      '아래 [시트 새로고침] 을 누르면 지금 읽어 옵니다.', 'refresh');
  }
  // 우리가 "그 시트의 이 버전까지 읽었다"고 기록해 둔 시각. 없으면 읽어 온 시각으로 대신한다.
  const known = tab.sheetModifiedAt ? new Date(tab.sheetModifiedAt).getTime() : mirroredAt;
  let remote = null;
  try {
    const { getSheetModifiedTime } = require('./sheets.service');
    const { driveThrottledCall } = require('../utils/sheetsThrottle');
    const t = await driveThrottledCall(() => getSheetModifiedTime(tab.sheetId));
    remote = t ? new Date(t).getTime() : null;
  } catch (e) {
    return _chk('mirror', label, 'unknown', '구글에서 시트 상태를 확인하지 못했습니다: ' + e.message,
      '잠시 뒤 다시 점검하세요.');
  }
  if (!remote || Number.isNaN(remote)) {
    return _chk('mirror', label, 'unknown', '시트의 최종 수정 시각을 알 수 없습니다',
      '시트 접근 권한을 확인한 뒤 다시 점검하세요.');
  }
  const ago = Math.max(0, Math.floor((now.getTime() - remote) / 60000));
  if (remote > known) {
    return _chk('mirror', label, 'fail', `시트가 ${ago}분 전에 수정됐는데 아직 읽어 오지 않았습니다`,
      '아래 [시트 새로고침] 을 누른 뒤 다시 점검하세요 — 지금 끊으면 그 편집이 사라집니다.', 'refresh');
  }
  return _chk('mirror', label, 'pass', `시트 최종 수정 ${ago}분 전 · 그 이후로 바뀐 것 없음(읽어 둔 상태가 최신)`);
}

/**
 * ⑤ 이관 후에도 **검색 명단이 그대로 서야** 한다 — 못 하면 끊는 순간 리뷰어 검색이 죽는다.
 *
 * ★★ 종전엔 "예외가 안 났나"만 봤다 — 그래서 `열 2개 · 표 500줄 → 검색 명단 0명` 인 탭도
 *    초록으로 통과했다(실측). fail-closed 라 해놓고 가장 위험한 항목이 아무것도 막지 못했다.
 * ★ 지금은 **지금 명단 수와 이관 후 명단 수를 대조**한다 — 줄어들면 그만큼이 검색에서 사라진다.
 */
async function _checkLedger(db, tab) {
  const label = '이관 후 검색 명단 유지';
  let r;
  try {
    r = await require('./sheetlessLedger.service').rebuildLedgers({
      sheetId: tab.sheetId, tabName: tab.tabName, dryRun: true, preflight: true,
    });
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
  const after = Number(r.indexRows) || 0;
  let before = null;
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM review_index
        WHERE sheet_id = $1 AND tab_name = $2 AND row_index IS NOT NULL`, [tab.sheetId, tab.tabName]);
    before = (rows[0] && rows[0].n) || 0;
  } catch (e) {
    return _chk('ledger', label, 'unknown', '지금 검색 명단 수를 확인하지 못했습니다: ' + e.message,
      '잠시 뒤 다시 점검하세요.');
  }
  const cols = (r.headers || []).length;
  if (after < before) {
    return _chk('ledger', label, 'fail',
      `지금 ${before}명인데 이관 후 ${after}명 (열 ${cols}개 · 표 ${r.mirrorRows}줄)`,
      '이관하면 그 차이만큼 리뷰어 검색에서 사라집니다 — 작업표의 열 이름 줄과 줄 채우기를 먼저 확인하세요.');
  }
  return _chk('ledger', label, 'pass',
    `열 ${cols}개 · 표 ${r.mirrorRows}줄 → 검색 명단 ${after}명(지금 ${before}명)`);
}

/** 한 탭의 기본 정보(점검·이관 공통 재료). */
async function _loadTab(db, sheetId, tabName) {
  const { rows } = await db.query(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
            COALESCE(NULLIF(tc.tab_gid,''), rst."mirrorGid") AS "tabGid",
            COALESCE(tc.display_name, tc.tab_name) AS "displayName",
            COALESCE(tc.sheetless, FALSE) AS "sheetless",
            tc.sheetless_at AS "sheetlessAt", tc.sheetless_by AS "sheetlessBy",
            rst."mirroredAt", rst."sheetModifiedAt", cp.cnt AS "boardRows"
       FROM tab_configs tc
       LEFT JOIN LATERAL (
         SELECT r.mirrored_at AS "mirroredAt", r.sheet_modified_at AS "sheetModifiedAt", r.tab_gid AS "mirrorGid"
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
    await _checkLedger(db, tab),
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
 * ★ 점검표 fail-closed · force 는 명시 요청일 때만.
 *
 * ★★ 작업명 타이핑 확정은 **제거했다**(사용자 확정 2026-08-07). 오클릭 방어는 두 겹으로 남는다:
 *    ① 화면 확인창이 **그 작업 이름을 문장에 넣어** 보여준다(다른 줄이면 거기서 알아챈다)
 *    ② 점검표 fail-closed — 확신이 없는 작업은 애초에 [이관] 버튼이 열리지 않는다.
 *    그리고 되돌리기(재연결)가 점검표 없이 언제든 가능하다(파괴적 조작이 아니다).
 *    ⚠ 되살릴 거면 화면·서버·가드 세 곳을 같이 되돌릴 것 — 서버만 켜면 화면이 못 보내 전면 잠금이 된다.
 */
async function enableSheetless({ sheetId, tabName, by = '', force = false, now = new Date() } = {}) {
  if (!sheetId || !tabName) throw new Error('enableSheetless: sheetId, tabName 필수');
  const db = _db();
  const tab = await _loadTab(db, sheetId, tabName);
  if (!tab) return { ok: false, reason: 'tab_not_found', message: '등록되지 않은 작업입니다.' };
  if (tab.sheetless) return { ok: true, already: true, message: '이미 이관된 작업입니다.' };

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

  // ★★ 표식을 켠 **뒤에** 인계한다 — `writeOrderToWorktable` 이 부르는 장부 재생성이
  //    시트 기반 탭을 `not_sheetless` 로 막기 때문(그 게이트를 풀지 않는다).
  const handoff = await handoffPendingOrders({ sheetId, tabName, tabGid: tab.tabGid, by });

  // ── 부수효과 3종. 전부 실패해도 이관 자체는 유지하고 **사유를 응답에 실어** 화면이 말한다.
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
  return { ok: true, sheetId, tabName, displayName: tab.displayName, forced: !!(force && !list.canCutover),
    handoff, ledger, notice };
}

/**
 * 이관 시 **미반영 주문을 작업표로 인계**한다(사용자 확정 2026-08-07 "B로 진행").
 *
 * ★★ 왜 시트에 다시 쓰지 않는가 — 두 가지 이유가 결정적이다:
 *    ① 곧 안 읽을 시트에 쓰는 것은 낭비이고, 쓰는 동안 시트가 또 바뀌면 ④가 다시 잠긴다.
 *    ② **`stuck_manual` 은 시트 재기록으로 영영 안 풀린다**(reconcile 이 그 상태를 제외한다)
 *       → 그런 주문이 하나라도 있는 작업은 "시트에 다 쓰고 나서 이관"이 **구조적으로 불가능**했다.
 *    작업표로 옮기면 그 주문이 장부(검색 명단·리뷰내역·홈 통계)에 그대로 들어가 완결된다.
 *
 * ★★ **실행부는 `writeOrderToWorktable` 한 벌**(사본 0) — 이관 후 신규 주문이 타는 바로 그 경로다.
 *    매핑(`mapOrderToSheetRow`)·옵션 blank-only·장부 재생성·완결 표시·신원 링크가 전부 거기 있다.
 * ★ 원장 행 → orderData 변환도 `orderLedger._osRowToOrderData` 재사용(큐 실행부와 같은 함수).
 * ★ **표식을 켠 뒤에 불러야 한다** — 그 함수가 부르는 장부 재생성이 시트 기반 탭을 막는다.
 *
 * ★ **절대 throw 하지 않는다** — 인계 실패로 이관을 되돌리면 "표식은 껐는데 시트 안내문은 붙은"
 *   어중간한 상태가 된다. 사유를 응답에 실어 화면이 말하고, 남은 건은 아래 두 경로가 메운다:
 *   ㉮ 2분 reconcile 의 무시트 분기(이제 이 탭이 무시트라 작업표로 재기록) ㉯ 재실행(멱등).
 * ★ 그래서 상한을 넘길 때는 **`stuck_manual` 을 먼저** 처리한다 — 그것만이 ㉮로 안 풀린다.
 *
 * 킬스위치 `SHEETLESS_CUTOVER_HANDOFF=0`(인계 없이 이관 — 종전 동작).
 */
const HANDOFF_CAP = Math.max(1, parseInt(process.env.SHEETLESS_CUTOVER_HANDOFF_CAP || '200', 10) || 200);

async function handoffPendingOrders({ sheetId, tabName, tabGid = '', by = '' } = {}) {
  const base = { ok: true, written: 0, failed: 0, blocked: 0, total: 0, truncated: false };
  if (String(process.env.SHEETLESS_CUTOVER_HANDOFF || '1') === '0') {
    return { ...base, skipped: 'disabled' };
  }
  const db = _db();
  let rows;
  try {
    const r = await db.query(
      `SELECT * FROM order_submissions
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
          AND COALESCE(mirror_status, 'pending') <> 'written'
        ORDER BY (COALESCE(mirror_status,'pending') <> 'stuck_manual'), submitted_at ASC
        LIMIT $3`, [sheetId, tabName, HANDOFF_CAP + 1]);
    rows = r.rows || [];
  } catch (e) {
    logger.warn(`[cutover] 미반영 주문 조회 실패(이관은 유지) — ${tabName}: ${e.message}`);
    return { ...base, ok: false, reason: 'query_failed', message: e.message };
  }
  const truncated = rows.length > HANDOFF_CAP;
  if (truncated) rows = rows.slice(0, HANDOFF_CAP);
  if (!rows.length) return { ...base };

  const { writeOrderToWorktable } = require('./sheetlessOrder.service');
  const { _osRowToOrderData } = require('./orderLedger.service');
  const out = { ...base, total: rows.length, truncated };
  const reasons = [];
  for (const os of rows) {
    // ★ 배정된 줄이 없으면 옮길 자리가 없다 — 점검표 ③이 이미 잠그지만(force 우회 대비) 여기서도 센다.
    if (!os.sheet_row) { out.blocked++; continue; }
    try {
      const w = await writeOrderToWorktable({
        sheetId, tabName, tabGid: os.tab_gid || tabGid,
        sheetRow: os.sheet_row, orderData: _osRowToOrderData(os),
        orderSubmissionId: os.id, recovered: true,   // ★ 복구 표기 = reconcile 무시트 분기와 같은 호출 형태
      });
      if (w && w.ok) out.written++;
      else { out.failed++; if (w && w.reason) reasons.push(w.reason); }
    } catch (e) {
      out.failed++; reasons.push(e.message || 'error');
    }
  }
  if (reasons.length) out.reasons = Array.from(new Set(reasons)).slice(0, 5);
  logger.info(`[cutover] 미반영 주문 인계 — ${tabName} 옮김 ${out.written} · 실패 ${out.failed} · ` +
    `자리없음 ${out.blocked}${truncated ? ` · 상한 ${HANDOFF_CAP} 초과분은 복구 작업이 이어서 처리` : ''} by=${by}`);
  return out;
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
  handoffPendingOrders,
  disableSheetless,
  CUTOVER_NOTICE,
  __setPoolForTest,
};
