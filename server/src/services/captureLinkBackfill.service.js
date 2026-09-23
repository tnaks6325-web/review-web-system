/**
 * captureLinkBackfill.service.js — 구매 캡처 ↔ 주문 연결 감사 + 연결 백필
 *
 * 왜 필요한가: `order_submissions.capture_uploaded_at` 을 채우는 유일한 경로가 제출 직후의
 *   fire-and-forget 업로드(search-app.js)다. 그 업로드가 실패했거나(413·429·네트워크·창 닫음)
 *   구버전 프론트가 `orderSubmissionId` 를 안 실어 보내면 **파일은 Drive 에 있는데 링크만 없다**.
 *   그런 건은 리뷰어에게 다시 받을 필요가 없다 — 이미 낸 증빙을 이어 붙이면 된다.
 *
 * ★★ 판정 단일 출처 — 감사(`/api/diag/no-capture-audit`)와 백필이 **같은 함수**를 쓴다.
 *    사본을 두면 "감사에선 A 파일인데 백필은 B 를 붙이는" 상태가 되고, 그 값은 정산 증빙이다.
 *
 * ★★ 쓰기 표면 = `order_submissions.capture_file_id` · `capture_uploaded_at` 두 칸뿐.
 *    Drive 는 **읽기만**(파일을 만들지도 옮기지도 지우지도 않는다) · 시트·장부·정원 무접촉.
 */
const pool = require('../db/pool');
const driveService = require('./drive.service');
const { logger } = require('../utils/logger');
const { withJobLock } = require('../utils/jobLock');

/* 테스트 주입용(레포 선례와 동일) */
let _pool = null;
let _drive = null;
let _lock = null;
/* ★ 잡 락은 전용 커넥션을 쓰므로(pg_advisory_lock 은 같은 세션에서 lock/unlock 해야 한다)
   스텁 pool 로는 돌지 않는다 — 테스트는 락을 주입해 통과 갈래와 경합 갈래를 각각 본다. */
function __setDepsForTest(p, d, l) { _pool = p; _drive = d; _lock = l || null; }
const db = () => _pool || pool;
const drv = () => _drive || driveService;
const lock = () => _lock || withJobLock;

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();

/** 시각 창 — 캡처는 제출 직전/직후에 올라간다. 창 밖이면 약한 신호(과거 회차 파일일 수 있다). */
const WIN_BEFORE_MS = 30 * 60 * 1000;
const WIN_AFTER_MS = 6 * 60 * 60 * 1000;

function _clamp(v, def, min, max) {
  const n = parseInt(v, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : def, min), max);
}

/**
 * 미링크 주문을 Drive 실물과 대조한다. **읽기 전용**(DB·Drive 쓰기 0).
 * 반환 items[]:
 *   verdict = attachedButUnlinked | notAttached | unknown
 *   confidence = high(시각 창 안) | low(이름만 같고 시각이 멀다)   ※ attachedButUnlinked 일 때만
 *   fileId/file/fileCreatedTime = 붙일 후보 · candidates = 이름이 맞는 파일 수 · winCandidates = 창 안 후보 수
 */
async function auditCaptureLinks(opts = {}) {
  const days = _clamp(opts.days, 3, 1, 3650);
  const limit = _clamp(opts.limit, 200, 1, 2000);
  const maxTabs = _clamp(opts.maxTabs, 20, 1, 60);

  // ★ 컷오프 = 캡처↔주문 연결 기능 배포 시각. 그 이전 주문은 링크가 비어 있는 게 정상이라
  //   감지기(detectMissingCaptures)도 알림을 내지 않는다 — 화면이 두 구간을 갈라 보여줘야
  //   "오탐 수백 건"으로 오해하지 않는다. ★ 백필 대상에서는 제외하지 않는다(오히려 주 대상이다).
  let cutoff = null;
  try {
    const { rows: cf } = await db().query(
      `SELECT value FROM app_settings WHERE key = 'reviewer_log_capture_cutoff'`);
    cutoff = (cf[0] && cf[0].value) || null;
  } catch (_) { /* 못 읽으면 구분 없이 보고(판정은 그대로 유효) */ }

  const { rows: orders } = await db().query(
    `SELECT os.id, os.sheet_id AS "sheetId", os.tab_name AS "tabName",
            os.recipient, os.orderer, os.submitted_at AS "submittedAt",
            ($3::timestamptz IS NOT NULL AND os.submitted_at <= $3::timestamptz) AS "preCutoff",
            EXISTS(SELECT 1 FROM reviewer_event_logs l
                    WHERE l.order_submission_id = os.id
                      AND l.event_type = 'order_no_capture' AND l.resolved_at IS NULL) AS "hasOpenLog"
       FROM order_submissions os
      WHERE os.deleted_at IS NULL AND os.capture_uploaded_at IS NULL
        AND os.submitted_at < NOW() - interval '20 minutes'
        AND os.submitted_at > NOW() - ($1 || ' days')::interval
      ORDER BY os.submitted_at DESC
      LIMIT $2`,
    [String(days), limit, cutoff]
  );
  if (!orders.length) return { days, cutoff, scanned: 0, tabs: 0, tabsSkipped: 0, items: [] };

  // 탭 단위로 묶어 Drive 조회 횟수를 최소화(탭당 1회 재귀 조회)
  const byTab = new Map();
  for (const o of orders) {
    const k = `${o.sheetId}\t${o.tabName}`;
    if (!byTab.has(k)) byTab.set(k, []);
    byTab.get(k).push(o);
  }
  const tabKeys = [...byTab.keys()].slice(0, maxTabs);
  const tabsSkipped = byTab.size - tabKeys.length;

  const items = [];
  for (const k of tabKeys) {
    const [sheetId, tabName] = k.split('\t');
    const group = byTab.get(k);
    let files = null, folderErr = '';
    try {
      const { rows: cfg } = await db().query(
        'SELECT capture_folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
        [sheetId, tabName]
      );
      const url = cfg[0] && cfg[0].capture_folder_url;
      const folderId = url ? drv().extractFolderIdFromUrl(url) : null;
      if (!folderId) folderErr = 'no_capture_folder';
      else files = await drv().listFolderFilesRecursive(folderId);   // 회차 하위폴더 포함
    } catch (e) { folderErr = e.message || 'drive_error'; }

    // 파일명 → 정규화 인덱스(확장자 제거, '_' 앞 토큰 = 수취인, 공백 제거)
    const idx = [];
    for (const f of (files || [])) {
      if (f.mimeType && String(f.mimeType).indexOf('image/') !== 0) continue;
      const base = String(f.name || '').replace(/\.[^.]+$/, '');
      idx.push({ id: f.id, full: norm(base), head: norm(base.split('_')[0]),
                 createdTime: f.createdTime, name: f.name });
    }

    for (const o of group) {
      if (!files) { items.push({ ...o, verdict: 'unknown', reason: folderErr }); continue; }
      const rc = norm(o.recipient), od = norm(o.orderer);
      /* ★ 매칭 근거를 함께 남긴다 — 파일명 규칙은 `{수취인}` 또는 `{수취인}_{주문자}`(search-app.js)라
         `head` 는 **항상 수취인**이다. 그래서 `head === 주문자` 로 걸린 파일은 대개 "그 이름이 수취인인
         다른 주문"의 캡처다. 감사는 사람이 보라고 넓게 보여 주되, **자동 연결은 그걸 근거로 쓰지 않는다**
         (수취인이 비어 있는 주문에서만 주문자 매칭이 정당하다). */
      const cands = idx.map((f) => {
        const byRc = !!(rc && (f.head === rc || f.full === rc));
        const byOd = !!(od && (f.head === od || f.full === od));
        return (byRc || byOd) ? { ...f, matchedBy: byRc ? 'recipient' : 'orderer' } : null;
      }).filter(Boolean);
      if (!cands.length) { items.push({ ...o, verdict: 'notAttached' }); continue; }
      const t0 = new Date(o.submittedAt).getTime() - WIN_BEFORE_MS;
      const t1 = new Date(o.submittedAt).getTime() + WIN_AFTER_MS;
      const win = cands.filter(f => { const c = Date.parse(f.createdTime); return c >= t0 && c <= t1; });
      const pick = win[0] || cands[0];
      items.push({
        ...o,
        verdict: 'attachedButUnlinked',
        confidence: win.length ? 'high' : 'low',   // low = 이름은 같은데 시각이 멀다
        file: pick.name,
        fileId: pick.id,
        fileCreatedTime: pick.createdTime,
        matchedBy: pick.matchedBy,                 // recipient | orderer
        candidates: cands.length,                  // ★ 백필 게이트의 근거(모호하면 붙이지 않는다)
        winCandidates: win.length,
        hasRecipient: !!rc,
      });
    }
  }
  return { days, cutoff, scanned: items.length, tabs: tabKeys.length, tabsSkipped, items };
}

/** 백필 대상 판정 — ★ 완화 금지. 틀린 파일을 붙이면 남의 캡처가 그 주문의 정산 증빙이 된다. */
function backfillEligibility(item, { allowLow = false } = {}) {
  if (!item || item.verdict !== 'attachedButUnlinked') return { ok: false, reason: 'not_attached' };
  if (!item.fileId) return { ok: false, reason: 'no_file_id' };
  // ★ 시각 창 밖(low)은 "이름만 같은" 신호다 — 동명이인·과거 회차 파일일 수 있어 자동 대상이 아니다.
  if (item.confidence !== 'high' && !allowLow) return { ok: false, reason: 'low_confidence' };
  // ★★ 후보가 여럿이면 붙이지 않는다 — 어느 것이 그 주문의 캡처인지 정할 근거가 없다.
  //    (감사는 사람이 보라고 첫 후보를 보여 주지만, 자동 반영은 유일할 때만 한다.)
  const n = item.confidence === 'high' ? item.winCandidates : item.candidates;
  if (!(n === 1)) return { ok: false, reason: 'ambiguous' };
  /* ★★ 주문자(orderer) 이름으로만 걸린 파일은 자동 연결 근거가 못 된다 — 파일명의 첫 토큰은
     항상 수취인이라, 그렇게 걸린 파일은 **그 이름이 수취인인 다른 주문**의 캡처이기 쉽다.
     수취인 칸이 비어 있는 주문에서만 정당하다(그때는 주문자가 유일한 단서다). */
  if (item.matchedBy === 'orderer' && item.hasRecipient) return { ok: false, reason: 'orderer_only' };
  return { ok: true };
}

/**
 * 감사 결과 중 확실한 것만 링크를 채운다.
 * ★ dryRun 기본 · `confirm === true` 가 아니면 **쓰기 0건**.
 * ★ `capture_uploaded_at` 은 NOW 가 아니라 **그 파일이 Drive 에 만들어진 시각**(사실대로 적는다).
 */
async function backfillCaptureLinks(opts = {}) {
  const dryRun = opts.dryRun !== false;
  const confirm = opts.confirm === true;
  const allowLow = opts.allowLow === true;
  const by = String(opts.by || '').slice(0, 40);

  const audit = await auditCaptureLinks(opts);
  const cand = [];
  const skipped = [];
  for (const it of audit.items) {
    const e = backfillEligibility(it, { allowLow });
    if (e.ok) cand.push(it); else if (it.verdict === 'attachedButUnlinked') skipped.push({ ...it, skip: e.reason });
  }

  /* ★★★ 역-유일성 — "주문 하나당 후보 파일이 하나"만으로는 오연결을 못 막는다.
     같은 수취인이 같은 탭에 20~30분 간격으로 두 번 제출하면(재제출·타계정 참여) 파일 하나가
     **두 주문의 시각 창에 모두** 들어가 양쪽 다 `winCandidates === 1` 이 된다. 그대로 두면
     처리 순서상 나중 주문이 그 파일을 가져가고 진짜 주인은 밀린다 — 그건 **정산 증빙이 뒤바뀌는**
     사고이고, 링크가 채워지는 순간 `autoResolveHealed` 가 미첨부 알림까지 닫아 조용해진다.
     → 한 파일을 둘 이상이 노리면 **양쪽 다 제외**한다(모르면 붙이지 않는다). */
  const byFile = new Map();
  for (const it of cand) {
    if (!byFile.has(it.fileId)) byFile.set(it.fileId, []);
    byFile.get(it.fileId).push(it);
  }
  const planned = [];
  for (const [, list] of byFile) {
    if (list.length === 1) planned.push(list[0]);
    else for (const it of list) skipped.push({ ...it, skip: 'ambiguous_file' });
  }
  planned.sort((a, b) => String(a.id).localeCompare(String(b.id)));   // 결정적 순서

  /* ★ 응답에 감사 items 전체를 다시 싣지 않는다 — 수취인·주문자·파일명이 실리는데 화면은
     집계와 앞부분 목록만 쓴다(데이터 최소화). 분류 수는 여기서 세어 보낸다. */
  const verdicts = audit.items.reduce((a, x) => { a[x.verdict] = (a[x.verdict] || 0) + 1; return a; }, {});
  /* ★ 판정 보류(unknown)의 **사유별** 집계 — 폴더 미연결과 Drive 조회 실패는 고칠 곳이 다르다.
     화면이 "모른다"를 "없다"로 말하지 않으려면 이 재료가 필요하다. */
  const unknownReasons = audit.items.reduce((a, x) => {
    if (x.verdict === 'unknown') { const k = x.reason || 'unknown'; a[k] = (a[k] || 0) + 1; }
    return a;
  }, {});
  const result = {
    days: audit.days, cutoff: audit.cutoff, scanned: audit.scanned,
    tabs: audit.tabs, tabsSkipped: audit.tabsSkipped,
    verdicts, unknownReasons,
    dryRun: dryRun || !confirm,
    planned: planned.length,
    skipped: skipped.length,
    linked: 0,
    conflicts: 0,
    raced: 0,
    plannedItems: planned,
    skippedItems: skipped,
  };
  // ★ 미리보기(또는 확인 없는 요청)는 여기서 끝 — DB 쓰기 0건.
  if (dryRun || !confirm) return result;

  /* ★★ 관리자 둘이 동시에 누르면 dup-check ↔ UPDATE 사이(TOCTOU)에 같은 파일이 두 주문에 붙는다
     (`capture_file_id` 에 유니크 제약이 없다). 레포 관용구대로 advisory lock 으로 직렬화한다.
     락을 못 잡으면 **아무것도 쓰지 않고 그 사실을 말한다**(조용한 no-op 금지). */
  const locked = await lock()('capture_link_backfill', async () => {
    await _runLinking(planned, result);
    return true;
  }, { onBusy: () => false });
  if (locked === false) {
    result.busy = true;
    result.error = '다른 관리자가 같은 작업을 진행 중입니다. 잠시 후 다시 시도하세요.';
    return result;
  }
  // 실행 뒤 보류 수를 실제 목록으로 다시 센다(사전 필터분 + 실행 중 건너뛴 분).
  result.skipped = result.skippedItems.length;
  _rememberBackfill(result, by);
  logger.info(`[captureLinkBackfill] linked=${result.linked} conflicts=${result.conflicts} raced=${result.raced} by=${by || '-'}`);
  return result;
}

/** 실제 링크 쓰기 — 락 안에서만 돈다. */
async function _runLinking(planned, result) {
  for (const it of planned) {
    try {
      /* ★★ 한 파일이 여러 주문의 증빙이 되지 않게 — 이미 다른 주문이 그 파일을 쓰고 있으면 건너뛴다.
         (같은 이름으로 여러 번 올린 탭에서 도달 가능하다.) */
      const { rows: dup } = await db().query(
        `SELECT id FROM order_submissions
          WHERE capture_file_id = $1 AND id <> $2 AND deleted_at IS NULL LIMIT 1`,
        [it.fileId, it.id]
      );
      if (dup.length) { result.conflicts++; result.skippedItems.push({ ...it, skip: 'file_already_linked' }); continue; }

      /* ★ 조건부 UPDATE — 그 사이 리뷰어가 보완 첨부했으면 그쪽이 이긴다(덮지 않는다). */
      const { rowCount } = await db().query(
        `UPDATE order_submissions
            SET capture_file_id = $2, capture_uploaded_at = COALESCE($3::timestamptz, NOW())
          WHERE id = $1 AND capture_uploaded_at IS NULL AND deleted_at IS NULL`,
        [it.id, it.fileId, it.fileCreatedTime || null]
      );
      if (rowCount === 1) { result.linked++; it._linked = true; }
      else { result.raced++; result.skippedItems.push({ ...it, skip: 'already_linked_meanwhile' }); }
    } catch (e) {
      // 건별 실패가 나머지를 죽이지 않는다(도구의 성격 — 다시 돌리면 남은 건만 처리된다).
      result.skippedItems.push({ ...it, skip: 'error:' + String(e.message || e).slice(0, 80) });
    }
  }
}

/* ★★ 되돌릴 근거를 남긴다 — 백필로 채운 링크와 리뷰어가 직접 올린 링크는 DB 에서 구분되지 않는다
   (`capture_uploaded_at` 에 파일의 실제 시각을 넣기 때문 — 그 판단 자체는 옳다).
   오연결이 나중에 발견됐을 때 "어느 행을 기계가 붙였나"를 알 수 있어야 한다.
   신규 테이블 0 — `app_settings` 한 키에 최근 회차만 쌓는다(레포 관용구). 실패는 무시(기록이
   본작업을 죽이면 안 된다). */
async function _rememberBackfill(result, by) {
  try {
    if (!result.linked) return;
    const entry = {
      at: new Date().toISOString(), by: by || '',
      linked: result.linked,
      ids: (result.plannedItems || []).filter(x => x._linked).map(x => ({ o: x.id, f: x.fileId })).slice(0, 500),
    };
    await db().query(
      `INSERT INTO app_settings (key, value) VALUES ('capture_link_backfill_log', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify([entry].concat(_lastLog).slice(0, 10))]
    );
    _lastLog = [entry].concat(_lastLog).slice(0, 9);
  } catch (e) { logger.warn(`[captureLinkBackfill] 이력 기록 실패(무시): ${e.message}`); }
}
let _lastLog = [];

module.exports = {
  auditCaptureLinks,
  backfillCaptureLinks,
  backfillEligibility,
  __setDepsForTest,
};
