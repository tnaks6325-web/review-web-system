/**
 * sheetlessCutover.test.js — 탈 구글시트 W4(C) 회귀가드: 전환 관리 화면
 * 실행: node tests/sheetlessCutover.test.js
 *
 * 고정하는 것:
 *  A. 라우트 4종 · 전부 adminOrMaster (표식을 켜는 유일한 창구)
 *  B. 점검표 fail-closed — pass 아닌 항목이 하나라도 있으면 잠근다(**unknown 포함**)
 *  C. 이관 게이트 = 점검표 하나 — 통과 못 하면 쓰기 쿼리 0 (타이핑 확정은 제거됨, 사용자 확정)
 *  D. force 는 서버에서 **명시 true 일 때만**(문자열 'true'·1 로 열리지 않는다)
 *  E. 되돌리기 — 0행이면 "되돌렸다"고 꾸미지 않고, 이관 이력은 지우지 않는다
 *  F. preflight — dryRun 과 함께일 때만. 단독이면 종전대로 not_sheetless
 *  G. 부수효과(장부·시트 안내문) 실패해도 이관은 유지 + 사유를 응답에 싣는다
 *  H. 프론트 배선 — nav·뷰 분기·onclick 인덱스만·자리표시자 종결
 *  I. 판정 사본 0 — 점검 재료는 기존 서비스 재사용
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readFe = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
// ⚠ 블록 주석 정규식으로 주석을 지우면 이 레포의 정규식 리터럴을 물어 파일이 통째로 사라진다(실측) — 줄 주석만.
const noLineComments = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

const cutover = require('../src/services/sheetlessCutover.service');
const trackB = require('../src/services/trackB.service');
const ledger = require('../src/services/sheetlessLedger.service');

/* ── 스텁 pool: 쿼리 내용으로 분기 + 실행된 쿼리를 전부 기록 ── */
function makeStub(opts = {}) {
  const o = Object.assign({
    tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1', sheetless: false,
      sheetlessAt: null, sheetlessBy: null, mirroredAt: new Date().toISOString(), boardRows: 3 },
    prepared: 3,          // 시트 준비 줄
    // ③ 미반영 주문: handoff = 배정된 줄이 있어 표로 옮길 수 있는 건 / blocked = 옮길 자리 없는 건
    pendingHandoff: 0, pendingBlocked: 0, queued: 0,
    handoffRows: null,    // handoffPendingOrders 가 실제로 훑을 원장 행(미지정이면 빈 목록)
    pendingThrows: false,
    parityReal: 0, parityThrows: false,
    ledgerThrows: null,   // { code, message }
    indexBefore: 2,       // 지금 review_index 명단 수(⑤ 대조 기준)
    indexThrows: false,
  }, opts);
  const log = [];
  const db = {
    query: async (sql, params) => {
      log.push(String(sql));
      const s = String(sql);
      if (/FROM tab_configs tc/.test(s) && /LEFT JOIN LATERAL/.test(s)) return { rows: [o.tab] };
      // ★ 표식을 켜는 순간을 순서 기록에 남긴다 — "마지막 반영은 켜기 **전**" 계약을 실행으로 고정.
      if (/UPDATE tab_configs SET sheetless = TRUE/.test(s)) { RECORD.order.push('flag'); return { rowCount: 1 }; }
      if (/UPDATE tab_configs SET sheetless = FALSE/.test(s)) return { rowCount: o.reconnectRows == null ? 1 : o.reconnectRows };
      if (/FROM order_submissions/.test(s)) {
        if (o.pendingThrows) throw new Error('os down');
        // ★ 두 쿼리를 구분한다: 점검표(집계) vs 인계(원장 행 훑기)
        if (/SELECT \*/.test(s)) return { rows: o.handoffRows || [] };
        return { rows: [{ handoff: o.pendingHandoff, blocked: o.pendingBlocked }] };
      }
      if (/FROM sync_queue/.test(s)) return { rows: [{ n: o.queued }] };
      if (/FROM review_index/.test(s)) {
        if (o.indexThrows) throw new Error('index down');
        return { rows: [{ n: o.indexBefore }] };
      }
      return { rows: [] };
    },
  };
  return { db, log, o };
}
// _checkSheetRows / _checkParity / _checkMirror / _checkLedger 는 다른 모듈을 부른다 — 전부 스텁으로 갈아끼운다.
// ★ ④ 는 구글 Drive 를 실제로 부르므로(사람이 [점검]을 누를 때만) 여기서도 반드시 막는다 —
//   안 막으면 자격증명 없는 환경에서 전부 unknown 으로 떨어져 "왜 잠겼는지" 를 못 본다.
/* 이관 절차의 호출 순서·인자 기록(마지막 반영 ↔ 표식 켜기 순서 계약). */
const RECORD = { order: [], reflect: [] };

function stubDeps({ prepared = 3, readOk = true, parityReal = 0, parityThrows = false, ledgerThrows = null,
  ledgerIndexRows = 2, remoteModifiedAt = null, driveThrows = false,
  reflectOk = true, reflectThrows = false } = {}) {
  RECORD.order = []; RECORD.reflect = [];
  /* ★★ 이관 직전 **마지막 반영**(repairSheetSync = 미러→빌드→투영)도 반드시 막는다 —
   *    안 막으면 테스트가 진짜 구글 시트를 읽으러 간다. */
  const audit = require('../src/services/sheetSyncAudit.service');
  const _rs = audit.repairSheetSync;
  audit.repairSheetSync = async (a) => {
    RECORD.order.push('reflect'); RECORD.reflect.push(a);
    if (reflectThrows) throw new Error('repair down');
    return { ok: reflectOk, steps: { mirror: { ok: true }, build: { ok: true },
      project: reflectOk ? { ok: true } : { ok: false, error: 'proj down' } } };
  };
  const slot = require('../src/services/sheetSlotSync.service');
  const _rp = slot.readPreparedRows;
  slot.readPreparedRows = async () => (readOk
    ? { ok: true, prepared: Array.from({ length: prepared }, (_, i) => ({ seq: i + 2 })), datelessFilled: 0 }
    : { ok: false, reason: 'no_mirror', prepared: [] });
  const _pr = trackB.parityReport;
  trackB.parityReport = async () => {
    if (parityThrows) throw new Error('boom');
    return { buckets: { match: 3, benign: 0, real: parityReal } };
  };
  const _rl = ledger.rebuildLedgers;
  ledger.rebuildLedgers = async () => {
    if (ledgerThrows) { const e = new Error(ledgerThrows.message || 'x'); e.code = ledgerThrows.code; throw e; }
    return { headers: ['a', 'b'], mirrorRows: 3, indexRows: ledgerIndexRows };
  };
  const sheets = require('../src/services/sheets.service');
  const _gm = sheets.getSheetModifiedTime;
  sheets.getSheetModifiedTime = async () => {
    if (driveThrows) throw new Error('drive 403');
    // 기본값 = 우리가 읽어 둔 시점보다 과거 = "그 뒤로 안 바뀜"
    return remoteModifiedAt || new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  };
  return () => {
    slot.readPreparedRows = _rp; trackB.parityReport = _pr; ledger.rebuildLedgers = _rl;
    sheets.getSheetModifiedTime = _gm; audit.repairSheetSync = _rs;
  };
}

(async () => {
  /* ══════════════ A. 라우터 스택 ══════════════ */
  console.log('\n[A] 라우트 9종 · adminOrMaster');
  {
    const r = require('../src/routes/trackB.routes');
    const found = {};
    for (const l of r.stack) {
      if (!l.route || !/^\/sheetless\//.test(l.route.path)) continue;
      const m = Object.keys(l.route.methods)[0].toUpperCase();
      found[m + ' ' + l.route.path] = l.route.stack.map(h => h.handle.name);
    }
    const keys = Object.keys(found);
    const coreKeys = keys.filter(k => k !== 'POST /sheetless/review-submit-time-backfill');
    // ⚠ 잔재 정리 2경로 + 읽는 범위 진단 1경로 합류(2026-08-19) — 검사 의미는 불변(전부 adminOrMaster 뒤).
    ok('9경로 전부 등록: ' + coreKeys.join(', '), coreKeys.length === 9
      && found['GET /sheetless/list'] && found['GET /sheetless/checklist']
      && found['GET /sheetless/slot-sweep']
      && found['GET /sheetless/orphan-tabs'] && found['POST /sheetless/orphan-tabs/close']
      && found['POST /sheetless/cutover'] && found['POST /sheetless/cutover-active-server-only']
      && found['POST /sheetless/reconnect']
      && found['GET /sheetless/read-scope']);
    ok('★ 전부 authMiddleware + adminOrMaster (AE·광고주 도달 불가)',
      coreKeys.every(k => found[k].includes('authMiddleware') && found[k].includes('adminOrMasterMiddleware')));
    ok('submission-time backfill stays master-only',
      found['POST /sheetless/review-submit-time-backfill']
      && found['POST /sheetless/review-submit-time-backfill'].includes('authMiddleware')
      && found['POST /sheetless/review-submit-time-backfill'].includes('masterOnlyMiddleware')
      && !found['POST /sheetless/review-submit-time-backfill'].includes('adminOrMasterMiddleware'));
  }

  /* ══════════════ B. 점검표 fail-closed ══════════════ */
  console.log('\n[B] 점검표 — pass 가 아니면 전부 잠금(unknown 포함)');
  {
    const { db } = makeStub();
    cutover.__setPoolForTest(db);
    let restore = stubDeps({});
    let r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('5항목을 모두 점검한다', r.checks.length === 5);
    ok('항목 키가 계약대로', JSON.stringify(r.checks.map(c => c.key))
      === JSON.stringify(['sheet_rows', 'parity', 'pending', 'mirror', 'ledger']));
    ok('전부 통과면 canCutover=true', r.canCutover === true && r.blocking.length === 0);
    restore();

    // ① 시트가 더 많으면 잠금
    restore = stubDeps({ prepared: 10 });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('시트 준비 줄이 표보다 많으면 잠금', r.canCutover === false && r.blocking.includes('sheet_rows'));
    /* ★★ 실측 사고(2026-08-07): 종전 안내는 "반영 점검 화면의 시트 우위 점검에서" 였는데
     *    그 화면엔 비슷한 이름의 처리가 둘이라(위쪽 [반영]=repair / 아래쪽 [자리 추가]=slot-backfill)
     *    담당자가 17건 전부 위쪽을 눌러 **아무것도 안 채워졌다**(repair 는 review_index 에 있는 행만
     *    옮기는데 여기서 부족한 것은 이름 없는 준비 자리라 애초에 거기 없다).
     *    → 조치는 **그 자리에서** 끝난다: fix 는 'audit' 이 아니라 'backfill'. */
    ok('★★ 준비 자리 부족은 그 자리에서 채운다(다른 화면으로 떠넘기지 않는다)',
      r.checks.find(c => c.key === 'sheet_rows').fix === 'backfill'
      && /표에 자리 채우기/.test(r.checks.find(c => c.key === 'sheet_rows').hint));
    restore();

    // ★★ unknown 도 통과가 아니다 — 이 가드를 풀면 "모르면 열림"이 된다
    restore = stubDeps({ readOk: false });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★★ 확인 불가(unknown)도 잠금 — 모르면 열지 않는다',
      r.canCutover === false && r.checks.find(c => c.key === 'sheet_rows').state === 'unknown');
    restore();

    restore = stubDeps({ parityThrows: true });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('대조 계산 실패도 통과로 접지 않는다(unknown → 잠금)',
      r.canCutover === false && r.checks.find(c => c.key === 'parity').state === 'unknown');
    restore();

    restore = stubDeps({ parityReal: 2 });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('진짜 불일치가 남아 있으면 잠금', r.canCutover === false && r.blocking.includes('parity'));
    restore();

    restore = stubDeps({ ledgerThrows: { code: 'no_headers' } });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★ 열 구성을 모르면 잠금 — 끊는 순간 검색·행배정이 죽는다',
      r.canCutover === false && r.blocking.includes('ledger'));
    restore();
    cutover.__setPoolForTest(null);
  }
  {
    /* ③ 미반영 주문 — 사용자 확정 2026-08-07 "B로 진행":
     *  이관이 그 주문들을 **작업표로 인계**하므로 "시트에도 표에도 안 남는다"는 위험이 사라졌다.
     *  → 통과시키는 것은 완화가 아니라 사실 반영. 단 **옮길 자리가 없는 건은 계속 잠근다**. */
    let { db } = makeStub({ pendingHandoff: 3 });
    cutover.__setPoolForTest(db);
    let restore = stubDeps({});
    let r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    const pc = r.checks.find(c => c.key === 'pending');
    ok('★★ 배정된 줄이 있는 미반영 주문은 통과 — 이관이 표로 옮긴다',
      r.canCutover === true && pc.state === 'pass' && /표로 옮깁니다/.test(pc.detail));
    restore(); cutover.__setPoolForTest(null);

    ({ db } = makeStub({ pendingBlocked: 2 }));
    cutover.__setPoolForTest(db);
    restore = stubDeps({});
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★★ 옮길 자리(배정된 줄)가 없는 미반영 주문은 잠금 — 지금 끊으면 사라진다',
      r.canCutover === false && r.blocking.includes('pending'));
    restore(); cutover.__setPoolForTest(null);

    ({ db } = makeStub({ pendingThrows: true }));
    cutover.__setPoolForTest(db);
    restore = stubDeps({});
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('③ 조회 실패는 unknown = 잠금(fail-closed)',
      r.canCutover === false && r.checks.find(c => c.key === 'pending').state === 'unknown');
    restore(); cutover.__setPoolForTest(null);
  }
  {
    /* ★★ ④ 는 "얼마나 오래됐나"가 아니라 "그 뒤로 시트가 바뀌었나" 다 (2026-08 실측 사고).
     *    미러는 내용이 바뀐 탭만 다시 읽어 `mirrored_at` 을 갱신하므로, 경과시간 기준으로 두면
     *    **끝나서 조용한 작업(= 이관 최적)** 이 영구히 잠긴다(등록 작업 86건 전부 잠김). */
    const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    const { db } = makeStub({ tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1',
      sheetless: false, mirroredAt: old, sheetModifiedAt: old, boardRows: 3 } });
    cutover.__setPoolForTest(db);
    // 원격 최종수정이 우리가 읽어 둔 시점보다 과거 = 그 뒤로 안 바뀜 → 오래됐어도 통과해야 한다
    let restore = stubDeps({ remoteModifiedAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString() });
    let r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★★ 오래 조용한 시트는 잠그지 않는다(경과시간 기준 부활 차단)',
      r.canCutover === true && r.checks.find(c => c.key === 'mirror').state === 'pass');
    restore();

    restore(); cutover.__setPoolForTest(null);
  }
  {
    /* ★★★ 운영 실측 오탐(2026-08-07) — **탭 자기 타임스탬프로 비교하면 안 된다**.
     *   미러는 내용이 바뀐 탭만 갱신하고 checksum 같은 탭은 통째로 건너뛰므로, 한 시트에서
     *   다른 탭만 바뀌면 이 탭의 값은 옛날에 머문다. 실측: 퓨비아 두 탭 = 미러 갱신 552분 전 ·
     *   시트 수정 465분 전 → "안 읽어 왔습니다"로 잠겼지만 실은 그때 읽고 같아서 건너뛴 것.
     *   → 비교 대상은 **시트 단위 MAX(sheet_modified_at)**(미러의 스킵 판정과 같은 값). */
    const old = new Date(Date.now() - 552 * 60000).toISOString();   // 이 탭이 마지막으로 바뀐 시각
    const sheetKnown = new Date(Date.now() - 465 * 60000).toISOString(); // 그 시트를 읽어 둔 버전
    const { db } = makeStub({ tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1',
      sheetless: false, mirroredAt: old, sheetModifiedAt: old, sheetKnownAt: sheetKnown, boardRows: 3 } });
    cutover.__setPoolForTest(db);
    let restore = stubDeps({ remoteModifiedAt: sheetKnown });
    let r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★★★ 같은 시트의 다른 탭만 바뀐 경우를 "안 읽음"으로 오판하지 않는다(운영 실측 오탐)',
      r.canCutover === true && r.checks.find(c => c.key === 'mirror').state === 'pass');
    restore();

    /* ★★ 시트 단위 값보다 새로운 수정이면 **여전히 fail 로 표시**하되 **잠그지는 않는다**
     *    (사용자 확정 2026-08-07): "시트가 x분 전에 수정됐다"는 대개 리뷰어 제출이고 그 기록은
     *    이미 서버에 있으며, 이관이 끊기 직전에 시트를 마지막으로 한 번 더 읽어 반영한다. */
    restore = stubDeps({ remoteModifiedAt: new Date(Date.now() - 5 * 60000).toISOString() });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    const mc = r.checks.find(c => c.key === 'mirror');
    ok('★★ 시트가 그 뒤로 바뀌었어도 이관을 막지 않는다(경고 전용)',
      r.canCutover === true && mc.state === 'fail' && mc.advisory === true);
    ok('★ 막힌 항목이 아니라 경고 목록에 들어간다',
      !r.blocking.includes('mirror') && r.advisories.includes('mirror'));
    ok('★ 사유가 "이관할 때 마지막으로 읽는다"를 말한다', /마지막으로 한 번 더 읽어 반영/.test(mc.hint));
    restore(); cutover.__setPoolForTest(null);

    const src = noLineComments(read('src/services/sheetlessCutover.service.js'));
    ok('★ 시트 단위 최댓값을 실제로 조회한다', /MAX\(r2\.sheet_modified_at\) AS "sheetKnownAt"/.test(src)
      && /FROM raw_sheet_tabs r2 WHERE r2\.sheet_id = tc\.sheet_id/.test(src));
    ok('★★ 미러도 같은 값으로 스킵을 판정한다(판정 사본 0)', (() => {
      const m = noLineComments(read('src/services/rawMirror.service.js'));
      return /sheetModifiedMap\[sheetId\]/.test(m) && /remote <= lastKnown/.test(m);
    })());
  }
  {
    // 읽어 둔 시점(5시간 전) 이후에 시트가 수정됨(1분 전) → 그 편집이 사라지므로 잠금
    const seen = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    const { db } = makeStub({ tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1',
      sheetless: false, mirroredAt: seen, sheetModifiedAt: seen, sheetKnownAt: seen, boardRows: 3 } });
    cutover.__setPoolForTest(db);
    let restore = stubDeps({ remoteModifiedAt: new Date(Date.now() - 60 * 1000).toISOString() });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    const mk = r.checks.find(c => c.key === 'mirror');
    ok('★ 읽어 둔 뒤 시트가 수정된 사실은 그대로 표시한다(숨기지 않는다)', mk.state === 'fail');
    ok('★ 그래도 이관은 막지 않는다(사용자 확정)', r.canCutover === true && mk.advisory === true);
    ok('그 자리에서 미리 확인할 길은 남긴다([시트 새로고침])', mk.fix === 'refresh');
    restore();

    // 구글 조회 실패도 이관을 막지 않는다 — 어차피 이관이 마지막 반영을 한 번 더 시도한다
    restore = stubDeps({ driveThrows: true });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    const uk = r.checks.find(c => c.key === 'mirror');
    ok('★ 시트 상태를 못 물어봐도 이관은 막지 않는다(경고 전용)',
      r.canCutover === true && uk.state === 'unknown' && uk.advisory === true);
    restore(); cutover.__setPoolForTest(null);
  }
  {
    // 한 번도 안 읽어 온 탭 — 표시는 하되 막지 않는다(이관이 그때 읽어 온다)
    const { db } = makeStub({ tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1',
      sheetless: false, mirroredAt: null, boardRows: 3 } });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    const mk = r.checks.find(c => c.key === 'mirror');
    ok('시트를 한 번도 읽어 온 기록이 없어도 경고까지만',
      r.canCutover === true && mk.state === 'unknown' && mk.advisory === true);
    restore(); cutover.__setPoolForTest(null);
  }
  {
    /* ★★★ 경고 전용은 ④ **하나뿐**이다 — 여기에 항목이 늘면 이관이 조용히 헐거워진다.
     *    ①·②·③·⑤ 는 이관으로 복구되지 않으므로 계속 잠가야 한다(변이시험 대상). */
    const seen = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const { db } = makeStub({ pendingBlocked: 1, indexBefore: 20,
      tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1', sheetless: false,
        mirroredAt: seen, sheetModifiedAt: seen, sheetKnownAt: seen, boardRows: 3 } });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({ prepared: 10, parityReal: 2, ledgerIndexRows: 0,
      remoteModifiedAt: new Date(Date.now() - 60000).toISOString() });   // ④ 도 fail 로 만든다
    const r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★★★ 경고 전용 항목은 ④(mirror) 하나뿐',
      r.checks.filter(c => c.advisory).map(c => c.key).join(',') === 'mirror');
    ok('★ 나머지 네 항목은 그대로 잠근다',
      r.canCutover === false
      && ['sheet_rows', 'parity', 'pending', 'ledger'].every(k => r.blocking.includes(k)));
    restore(); cutover.__setPoolForTest(null);
  }
  {
    /* ⑤ 가 막혔을 때도 **그 자리에서** 조치를 준다 — 가장 흔한 원인(인덱스엔 있는데 표로
     *   아직 투영 안 됨)은 [시트 새로고침](미러→빌드→투영) 한 번으로 풀린다. */
    const { db } = makeStub({ indexBefore: 20 });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({ ledgerIndexRows: 0 });
    const r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★ ⑤ 막힘은 [시트 새로고침] 을 그 자리에서 제안한다',
      r.checks.find(c => c.key === 'ledger').fix === 'refresh');
    restore(); cutover.__setPoolForTest(null);
  }
  {
    /* ★★ ⑤ 는 "예외가 안 났나"가 아니라 "명단이 줄지 않나" 다 (실측 오탐: `열 2개 · 검색 명단 0명`
     *    인 탭이 초록으로 통과했다 — fail-closed 라 해놓고 가장 위험한 항목이 아무것도 안 막았다). */
    const { db } = makeStub({ indexBefore: 20 });
    cutover.__setPoolForTest(db);
    let restore = stubDeps({ ledgerIndexRows: 0 });
    let r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    const lk = r.checks.find(c => c.key === 'ledger');
    ok('★★ 이관 후 검색 명단이 줄면 잠금(0명 통과 재발 차단)',
      r.canCutover === false && lk.state === 'fail');
    ok('줄어드는 인원을 숫자로 말한다', /20/.test(lk.detail) && /0/.test(lk.detail));
    restore();

    // 같거나 늘어나면 통과
    restore = stubDeps({ ledgerIndexRows: 20 });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('명단이 유지되면 통과', r.canCutover === true
      && r.checks.find(c => c.key === 'ledger').state === 'pass');
    restore(); cutover.__setPoolForTest(null);
  }
  {
    // 지금 명단 수를 못 세면 대조 자체가 불가 → 잠금
    const { db } = makeStub({ indexThrows: true });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★ 지금 명단 수를 못 세면 잠금(대조 불가 = 모름)',
      r.canCutover === false && r.checks.find(c => c.key === 'ledger').state === 'unknown');
    restore(); cutover.__setPoolForTest(null);
  }
  {
    // 이미 이관된 탭 = 점검 대상이 아니다
    const { db } = makeStub({ tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1',
      sheetless: true, mirroredAt: new Date().toISOString(), boardRows: 3 } });
    cutover.__setPoolForTest(db);
    const r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('이미 이관된 탭은 already + canCutover=false', r.already === true && r.canCutover === false);
    cutover.__setPoolForTest(null);
  }

  /* ══════════════ C. 이관 게이트 = 점검표 하나 ══════════════ */
  console.log('\n[C] 이관 게이트 — 점검표를 통과해야만 쓴다(타이핑 확정은 제거)');
  {
    const { db, log } = makeStub({ prepared: 3 });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({ prepared: 10 });   // 점검 실패 상태
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    ok('점검표를 통과 못 하면 거부', r.ok === false && r.reason === 'checklist_failed');
    ok('★ 점검 실패 시 쓰기 쿼리 0', !log.some(s => /UPDATE tab_configs SET sheetless = TRUE/.test(s)));
    ok('막힌 항목을 알려준다', Array.isArray(r.blocking) && r.blocking.includes('sheet_rows'));
    restore(); cutover.__setPoolForTest(null);
  }
  {
    const { db, log } = makeStub();
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    // ★★ 타이핑 확정 제거(사용자 확정 2026-08-07) — 이름을 안 보내도 점검 통과면 이관된다.
    //    오클릭 방어는 ① 화면 확인창이 작업 이름을 문장에 넣어 보여주고 ② 점검표 fail-closed,
    //    그리고 되돌리기([재연결])가 점검표 없이 언제든 가능한 것으로 남는다.
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: '만두' });
    ok('★★ 작업명 입력 없이도 점검 통과면 이관된다', r.ok === true && !r.forced);
    ok('표식을 켜는 UPDATE 가 실제로 나간다',
      log.some(s => /UPDATE tab_configs SET sheetless = TRUE/.test(s) && /sheetless_at = NOW\(\)/.test(s)));
    /* ★★ 마지막 반영 = 끊기 **직전**(표식을 켜기 전) — 켠 뒤에는 미러·빌드가 그 탭을 제외해
     *    아무것도 읽어 오지 못한다. 순서를 실행으로 고정한다(존재 검사만으론 못 잡는다). */
    ok('★★ 이관 직전에 그 시트를 마지막으로 한 번 더 읽는다', RECORD.reflect.length === 1
      && RECORD.reflect[0].sheetId === 'S1' && RECORD.reflect[0].tabName === 'T1');
    ok('★★ 반영이 표식 켜기보다 **먼저** 일어난다',
      RECORD.order.indexOf('reflect') >= 0 && RECORD.order.indexOf('reflect') < RECORD.order.indexOf('flag'));
    ok('★ 실행부는 기존 반영 도구 한 벌(repairSheetSync — 사본 0)', (() => {
      const s = noLineComments(read('src/services/sheetlessCutover.service.js'));
      // ★ 미러·빌드·투영을 **직접** 부르지 않는다(순서·락 규율이 그 함수 안에 있다).
      return /sheetSyncAudit\.service'\)\s*\.repairSheetSync\(/.test(s)
        && !/mirrorOneSheet\s*\(/.test(s) && !/buildOneSheet\s*\(/.test(s) && !/projectTab\s*\(/.test(s);
    })());
    ok('반영 결과를 응답에 실어 화면이 말한다', r.reflect && r.reflect.ok === true);
    restore(); cutover.__setPoolForTest(null);
  }
  {
    /* ★ 마지막 반영이 실패해도 **이관은 유지**하고 사유만 싣는다(부수효과 규율) —
     *   되돌리면 "표식은 껐는데 안내문은 붙은" 어중간한 상태가 된다. */
    const { db, log } = makeStub();
    cutover.__setPoolForTest(db);
    let restore = stubDeps({ reflectThrows: true });
    let r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    ok('★ 마지막 반영이 예외로 죽어도 이관은 유지',
      r.ok === true && r.reflect.ok === false && /repair down/.test(r.reflect.message || ''));
    ok('그때도 표식은 켜진다', log.some(s => /UPDATE tab_configs SET sheetless = TRUE/.test(s)));
    restore();

    // 예외가 아니라 `{ok:false}` 로 돌아오는 갈래도 그대로 보고해야 한다(실패 경로가 둘이다)
    restore = stubDeps({ reflectOk: false });
    r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    ok('★ 단계 실패(ok:false)도 조용히 성공으로 접지 않는다',
      r.ok === true && r.reflect.ok === false && r.reflect.steps.project.ok === false);
    restore(); cutover.__setPoolForTest(null);
  }
  {
    // 킬스위치 — 마지막 반영 없이 종전 동작
    const { db } = makeStub();
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    process.env.SHEETLESS_CUTOVER_REFLECT = '0';
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    delete process.env.SHEETLESS_CUTOVER_REFLECT;
    ok('★ 킬스위치 0 이면 반영을 건너뛴다(이관은 그대로)',
      r.ok === true && r.reflect.skipped === 'disabled' && RECORD.reflect.length === 0);
    restore(); cutover.__setPoolForTest(null);
  }
  {
    // ★ 이미 이관된 탭을 또 이관하지 않는다 — 다시 쓰면 sheetless_at/by(유일한 이관 이력)가
    //   오늘 날짜로 덮여 "언제 누가 이관했나"를 잃는다.
    const { db, log } = makeStub({ tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1',
      sheetless: true, sheetlessAt: '2026-08-01T00:00:00Z', sheetlessBy: '만두',
      mirroredAt: new Date().toISOString(), boardRows: 3 } });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    ok('★ 이미 이관된 탭은 already 로 끝낸다', r.ok === true && r.already === true);
    ok('★ 그때 쓰기 쿼리 0(이관 이력 안 덮음)',
      !log.some(s => /UPDATE tab_configs SET sheetless = TRUE/.test(s)));
    restore(); cutover.__setPoolForTest(null);
  }
  {
    // ★ 서버·라우트·화면 어디에도 타이핑 확정이 남아 있지 않아야 한다 — 한쪽만 되살리면
    //   화면이 값을 못 보내 전면 잠금(서버만) 또는 죽은 입력칸(화면만)이 된다.
    const svc = noLineComments(read('src/services/sheetlessCutover.service.js'));
    const rt = noLineComments(read('src/routes/trackB.routes.js'));
    const fe = noLineComments(readFe('workdesk.html'));
    ok('★ 서버에 confirmName 판정 없음', !/confirmName/.test(svc) && !/confirm_mismatch/.test(svc));
    ok('★ 라우트가 confirmName 을 받지 않는다', !/confirmName/.test(rt));
    ok('★ 화면에 입력칸·이름 대조가 없다', !/cocf/.test(fe) && !/confirmName/.test(fe));
    ok('★ 그래도 확인창은 남아 있고 작업 이름을 문장에 넣는다',
      /_coCutover/.test(fe) && /confirm\(`「\$\{t\.displayName\|\|t\.tabName\}」 의 구글시트 연결을 끊습니다/.test(fe));
  }

  /* ══════════════ D. force 는 명시 true 일 때만 ══════════════ */
  console.log('\n[D] force — 명시 true 일 때만 (라우트가 좁힌다)');
  {
    const src = noLineComments(read('src/routes/trackB.routes.js'));
    // ★ 단언은 **cutover 라우트 본문 안**을 지목한다 — 파일 전체를 보면 다른 라우트(year-probe)의
    //   같은 표현이 이 검사를 대신 통과시킨다(변이시험 M10 이 실제로 그렇게 새어 나갔다).
    // ⚠ 경계는 다음 `router.` 까지 — `});` 로 자르면 안쪽의 `res.status(400).json({…});` 에서
    //    먼저 끊겨 정작 검사할 줄이 빠진다(실측).
    const i0 = src.indexOf(`router.post('/sheetless/cutover'`);
    const i1 = src.indexOf('\nrouter.', i0 + 10);
    const body = i0 > 0 ? src.slice(i0, i1 > 0 ? i1 : undefined) : '';
    ok('cutover 라우트 본문을 찾았다', !!body);
    ok('★ 라우트가 force === true 로만 넘긴다(문자열·1 로 안 열림)',
      /force:\s*force\s*===\s*true/.test(body));
    const { db } = makeStub();
    cutover.__setPoolForTest(db);
    const restore = stubDeps({ prepared: 10 });
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q', force: true });
    ok('force 면 점검 미통과여도 이관하되 forced 로 표시한다', r.ok === true && r.forced === true);
    restore(); cutover.__setPoolForTest(null);
  }

  /* ══════════════ E. 되돌리기 ══════════════ */
  console.log('\n[E] 재연결 — 0행이면 꾸미지 않고, 이관 이력은 지우지 않는다');
  {
    const { db, log } = makeStub();
    cutover.__setPoolForTest(db);
    const r = await cutover.disableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    ok('이관된 탭이면 changed=true', r.ok === true && r.changed === true);
    const upd = log.find(s => /UPDATE tab_configs SET sheetless = FALSE/.test(s));
    ok('★ sheetless_at/by 는 지우지 않는다 — 유일한 이관 이력',
      upd && !/sheetless_at\s*=/.test(upd) && !/sheetless_by\s*=/.test(upd));
    ok('★ 원래 시트 기반이었던 탭만 갱신(WHERE sheetless=TRUE)',
      upd && /COALESCE\(sheetless, FALSE\) = TRUE/.test(upd));
    cutover.__setPoolForTest(null);
  }
  {
    const { db } = makeStub({ reconnectRows: 0 });
    cutover.__setPoolForTest(db);
    const r = await cutover.disableSheetless({ sheetId: 'S1', tabName: 'T1' });
    ok('★ 0행은 "되돌렸습니다"로 꾸미지 않는다', r.changed === false && /이미 시트 기반/.test(r.message));
    cutover.__setPoolForTest(null);
  }

  /* ══════════════ F. preflight 는 dryRun 과 함께일 때만 ══════════════ */
  console.log('\n[F] 장부 preflight — 쓰기 게이트는 그대로');
  {
    const stub = {
      query: async (sql) => {
        if (/FROM tab_configs WHERE sheet_id/.test(String(sql))) {
          return { rows: [{ tab_gid: '11', campaign_name: 'c', sheetless: false }] };
        }
        return { rows: [] };
      },
      connect: async () => { throw new Error('쓰기 경로가 열렸다'); },
    };
    ledger.__setPoolForTest(stub);
    let code = '';
    try { await ledger.rebuildLedgers({ sheetId: 'S', tabName: 'T', preflight: true }); }
    catch (e) { code = e.code; }
    ok('★ preflight 만 주고 dryRun 을 빼면 종전대로 거부(not_sheetless)', code === 'not_sheetless');
    ledger.__setPoolForTest(null);
    const src = noLineComments(read('src/services/sheetlessLedger.service.js'));
    ok('★ 게이트 완화는 dryRun AND preflight 조건 하나뿐',
      /!tcRows\[0\]\.sheetless && !\(dryRun && preflight\)/.test(src));
  }

  /* ══════════════ F2. 미반영 주문 인계 (사용자 확정 "B로 진행") ══════════════ */
  console.log('\n[F2] 이관 시 미반영 주문을 작업표로 인계 — 시트에 쓰지 않는다');
  const sheetlessOrder = require('../src/services/sheetlessOrder.service');
  function stubWrite(impl) {
    const _w = sheetlessOrder.writeOrderToWorktable;
    const calls = [];
    sheetlessOrder.writeOrderToWorktable = async (a) => { calls.push(a); return impl ? impl(a) : { ok: true, written: true }; };
    return { calls, restore: () => { sheetlessOrder.writeOrderToWorktable = _w; } };
  }
  {
    const rows = [
      { id: 'o1', sheet_row: 5, tab_gid: '11', orderer: '김', recipient: '김', phone: '01012345678', price: '1000' },
      { id: 'o2', sheet_row: 6, tab_gid: '11', orderer: '이', recipient: '이', phone: '01099998888', price: '2000' },
    ];
    const { db } = makeStub({ pendingHandoff: 2, handoffRows: rows });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const w = stubWrite();
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    w.restore(); restore(); cutover.__setPoolForTest(null);
    ok('★ 미반영 주문마다 writeOrderToWorktable 을 부른다(실행부 사본 0)', w.calls.length === 2);
    ok('★ 결과를 응답에 실어 화면이 말한다', r.handoff && r.handoff.written === 2 && r.handoff.failed === 0);
    ok('★ orderData 는 원장 행에서 파생(매핑 사본 0)',
      w.calls[0].orderData && w.calls[0].orderData.orderer === '김' && w.calls[0].orderData.price === '1000');
    ok('★ 배정된 줄 그대로 사용(새 자리를 만들지 않는다)', w.calls[0].sheetRow === 5 && w.calls[1].sheetRow === 6);
    ok('★ 복구 표기(recovered) 로 부른다 — reconcile 무시트 분기와 같은 형태', w.calls[0].recovered === true);
  }
  {
    // ★★ 순서 계약: 표식을 켠 **뒤에** 인계한다(장부 재생성의 not_sheetless 게이트 때문).
    const { db, log } = makeStub({ pendingHandoff: 1,
      handoffRows: [{ id: 'o1', sheet_row: 5, tab_gid: '11' }] });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    let flagAtCall = null;
    const w = stubWrite(() => {
      flagAtCall = log.findIndex(s => /UPDATE tab_configs SET sheetless = TRUE/.test(s));
      return { ok: true };
    });
    await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    w.restore(); restore(); cutover.__setPoolForTest(null);
    ok('★★ 인계 시점에 이미 무시트 표식이 켜져 있다', flagAtCall >= 0);
  }
  {
    // 실패해도 이관은 유지하고 사유를 싣는다(절대 throw 안 함)
    const { db } = makeStub({ pendingHandoff: 2, handoffRows: [
      { id: 'o1', sheet_row: 5 }, { id: 'o2', sheet_row: null },
    ] });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const w = stubWrite(() => { throw new Error('표 기록 실패'); });
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    w.restore(); restore(); cutover.__setPoolForTest(null);
    ok('★ 인계 실패가 이관을 되돌리지 않는다', r.ok === true);
    ok('★ 실패·자리없음 건수를 그대로 보고한다(조용한 누락 금지)',
      r.handoff.failed === 1 && r.handoff.blocked === 1 && r.handoff.written === 0);
    ok('★ 자리 없는 건은 write 를 부르지 않는다', w.calls.length === 1);
  }
  {
    /* ★★ 실패 경로가 둘이다 — **예외**와 **{ok:false} 반환**. 변이시험이 실측으로 잡았다:
     *    예외만 검사하면 `out.failed++` 를 `+= 0` 으로 바꿔도 통과한다. 둘 다 세고, **값까지** 단언한다. */
    const { db } = makeStub({ pendingHandoff: 2, handoffRows: [{ id: 'o1', sheet_row: 5 }, { id: 'o2', sheet_row: 6 }] });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const w = stubWrite(() => ({ ok: false, reason: 'no_headers' }));
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    w.restore(); restore(); cutover.__setPoolForTest(null);
    ok('★★ 예외가 아니라 {ok:false} 로 실패해도 건수를 그대로 센다',
      r.handoff.failed === 2 && r.handoff.written === 0);
    ok('★ 실패 사유를 응답에 실어 화면이 말한다',
      Array.isArray(r.handoff.reasons) && r.handoff.reasons.includes('no_headers'));
  }
  {
    // 조회 실패도 이관을 막지 않는다
    const { db } = makeStub({ pendingHandoff: 0 });
    db.query = (sql, p) => (/SELECT \* FROM order_submissions/.test(String(sql))
      ? Promise.reject(new Error('os down'))
      : makeStub({ pendingHandoff: 0 }).db.query(sql, p));
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const w = stubWrite();
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    w.restore(); restore(); cutover.__setPoolForTest(null);
    ok('★ 인계 조회 실패도 이관은 유지 + 사유 동봉',
      r.ok === true && r.handoff && r.handoff.ok === false && r.handoff.reason === 'query_failed');
  }
  {
    const src = noLineComments(read('src/services/sheetlessCutover.service.js'));
    ok('★★ 인계 대상 쿼리가 stuck_manual 을 먼저 처리한다(그것만 복구 작업으로 안 풀린다)',
      /ORDER BY \(COALESCE\(mirror_status,'pending'\) <> 'stuck_manual'\)/.test(src));
    ok('★ 인계는 시트에 쓰지 않는다(큐·시트 API 호출 0)',
      !/enqueue\s*\(|appendSheet\s*\(|writeSheet\s*\(/.test(src));
    ok('★ 킬스위치가 있다', /SHEETLESS_CUTOVER_HANDOFF/.test(src));
  }

  /* ══════════════ F3. 준비 자리 일괄 점검 ══════════════ */
  console.log('\n[F3] 준비 자리 일괄 점검 — "시트가 더 많은 작업"만 추려서 답한다');
  {
    // 남은 작업 3건: A=부족 / B=이상 없음 / C=판정 불가(gid 없음), 그리고 이미 이관된 D
    const tabs = [
      { sheetId: 'S1', tabName: 'A', tabGid: '1', displayName: 'A', sheetless: false, boardRows: 20, mirroredAt: new Date().toISOString() },
      { sheetId: 'S1', tabName: 'B', tabGid: '2', displayName: 'B', sheetless: false, boardRows: 50, mirroredAt: new Date().toISOString() },
      { sheetId: 'S1', tabName: 'C', tabGid: null, displayName: 'C', sheetless: false, boardRows: 10, mirroredAt: new Date().toISOString() },
      { sheetId: 'S1', tabName: 'D', tabGid: '4', displayName: 'D', sheetless: true, boardRows: 10, mirroredAt: new Date().toISOString() },
    ];
    const db = { query: async (sql) => (/FROM tab_configs tc/.test(String(sql)) ? { rows: tabs } : { rows: [] }) };
    cutover.__setPoolForTest(db);
    const slot = require('../src/services/sheetSlotSync.service');
    const _rp = slot.readPreparedRows;
    const seen = [];
    slot.readPreparedRows = async (_db, { tabGid }) => {
      seen.push(tabGid);
      if (tabGid === '1') return { ok: true, prepared: Array.from({ length: 100 }, (_, i) => ({ seq: i + 2 })) };
      return { ok: true, prepared: Array.from({ length: 30 }, (_, i) => ({ seq: i + 2 })) };
    };
    // ★ 목록과 **같은 스코프**(연도 필터 포함)를 탄다 — 화면에 안 보이는 작업을 훑으면 답이 안 맞는다.
    const r = await cutover.sweepPreparedRows({ includeUnknown: true });
    slot.readPreparedRows = _rp; cutover.__setPoolForTest(null);

    ok('★★ 시트가 더 많은 작업만 추린다', r.short.length === 1 && r.short[0].tabName === 'A');
    ok('★ 부족한 줄 수를 그대로 말한다(시트 100 · 표 20)',
      r.short[0].missing === 80 && r.short[0].prepared === 100 && r.short[0].board === 20);
    ok('이상 없는 작업은 건수로만 센다', r.okCount === 1);
    ok('★★ 판정 불가를 "이상 없음"으로 꾸미지 않는다(따로 센다)',
      r.unknown.length === 1 && r.unknown[0].tabName === 'C' && r.unknown[0].reason === 'no_gid');
    ok('★ 이미 이관된 작업은 훑지 않는다', !seen.includes('4') && r.remaining === 3);
    ok('★ 판정은 점검표 ①과 같은 함수(readPreparedRows) — 사본 0', seen.length === 2);
  }
  {
    /* ★★ 판정 불가 갈래가 둘이다 — **gid 없음**(위 케이스)과 **읽기 실패**({ok:false}).
     *    한쪽만 검사하면 나머지를 `okCount++` 로 접어도 통과한다(변이시험 N2 실측). */
    const tabs = [{ sheetId: 'S1', tabName: 'A', tabGid: '1', displayName: 'A', sheetless: false,
      boardRows: 5, mirroredAt: new Date().toISOString() }];
    const db = { query: async (sql) => (/FROM tab_configs tc/.test(String(sql)) ? { rows: tabs } : { rows: [] }) };
    cutover.__setPoolForTest(db);
    const slot = require('../src/services/sheetSlotSync.service');
    const _rp = slot.readPreparedRows;
    slot.readPreparedRows = async () => ({ ok: false, reason: 'no_mirror', prepared: [] });
    const r = await cutover.sweepPreparedRows({ includeUnknown: true });
    slot.readPreparedRows = _rp; cutover.__setPoolForTest(null);
    ok('★★ 시트 사본을 못 읽은 작업도 "이상 없음"으로 접지 않는다',
      r.okCount === 0 && r.unknown.length === 1 && r.unknown[0].reason === 'no_mirror' && r.short.length === 0);
  }
  {
    const src = noLineComments(read('src/services/sheetlessCutover.service.js'));
    const body = src.slice(src.indexOf('async function sweepPreparedRows'), src.indexOf('async function enableSheetless'));
    ok('★ 일괄 점검은 시트 API 를 부르지 않는다(RAW 미러만)',
      !/getSheetModifiedTime|readSheet\s*\(|driveThrottledCall/.test(body));
    ok('★ 읽기 전용 — 쓰기 쿼리 0', !/UPDATE |INSERT |DELETE /.test(body));
    ok('★ 부족이 큰 작업부터 보여준다', /sort\(\(a, b\) => b\.missing - a\.missing\)/.test(body));
  }
  {
    const rt = require('../src/routes/trackB.routes').stack
      .filter(l => l.route && l.route.path === '/sheetless/slot-sweep')
      .map(l => ({ methods: Object.keys(l.route.methods), mws: l.route.stack.map(s => s.handle.name) }))[0];
    ok('일괄 점검 라우트가 GET 으로 등록돼 있다', !!rt && rt.methods.includes('get'));
    ok('★ adminOrMaster 게이트', rt && rt.mws.includes('authMiddleware') && rt.mws.includes('adminOrMasterMiddleware'));
  }
  {
    const wd = read('../frontend/workdesk.html');
    ok('헤더에 [준비 자리 일괄 점검] 버튼', /onclick="_coSweep\(\)"/.test(wd));
    ok('★ 없으면 "없다"고 분명히 말한다(빈 화면 금지)', /시트가 더 많은 작업은 없습니다/.test(wd));
    ok('★ 판정 불가 건수를 화면이 고지한다', /판정 불가 \$\{unk\.length\}건|판정 불가 \$\{unk/.test(wd) || /판정 불가/.test(wd));
    // ★★ 실패 경로가 둘이다 — **네트워크 예외(catch)** 와 **응답 실패({ok:false})**.
    //    한쪽만 검사하면 다른 쪽을 지워도 통과한다(변이시험 N8 실측) → **둘 다** 센다.
    const sweepFn = wd.slice(wd.indexOf('async function _coSweep'), wd.indexOf('function _coSweepReason'));
    ok('★★ 실패 두 경로 모두 사유 + [다시 시도]로 화면을 종결시킨다',
      (sweepFn.match(/일괄 점검 실패/g) || []).length === 2
      && (sweepFn.match(/onclick="_coSweep\(\)"/g) || []).length === 2
      && /catch\(e\)\{[\s\S]{0,200}일괄 점검 실패/.test(sweepFn)
      && /j\.ok===false[\s\S]{0,200}다시 시도/.test(sweepFn));
    ok('★ 부족한 작업엔 그 자리에서 조치 버튼', /_coSweep[\s\S]{0,2000}반영 점검에서 채우기/.test(wd));
  }

  /* ══════════════ G. 부수효과 실패해도 이관 유지 ══════════════ */
  console.log('\n[G] 장부·시트 안내문 실패는 이관을 되돌리지 않고 사유를 싣는다');
  {
    const { db } = makeStub();
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const _rl = ledger.rebuildLedgers;
    ledger.rebuildLedgers = async (a) => {
      if (a && a.dryRun) return { headers: ['a'], mirrorRows: 3, indexRows: 2 };   // 점검용은 통과
      throw Object.assign(new Error('장부 실패'), { code: 'no_headers' });          // 실제 재생성만 실패
    };
    const r = await cutover.enableSheetless({ sheetId: 'S1', tabName: 'T1', by: 'q' });
    ledger.rebuildLedgers = _rl;
    ok('★ 장부 재생성이 실패해도 이관은 성공으로 끝난다', r.ok === true);
    ok('★ 그리고 실패 사유를 응답에 실어 화면이 말한다(조용한 실패 금지)',
      r.ledger && r.ledger.ok === false && /장부 실패/.test(r.ledger.message || ''));
    restore(); cutover.__setPoolForTest(null);
  }
  {
    const src = noLineComments(read('src/services/sheetlessCutover.service.js'));
    ok('시트 안내문은 기존 공지를 대신해야 하므로 force:true', /applySheetNotice\([\s\S]{0,220}force:\s*true/.test(src));
    ok('★ 안내문 문구가 헤더 탐지 검증을 통과한다(파싱 붕괴 방지)', (() => {
      const { validateNoticeText } = require('../src/services/sheetNotice.service');
      return validateNoticeText(cutover.CUTOVER_NOTICE).ok === true;
    })());
  }

  /* ══════════════ H. 프론트 배선 ══════════════ */
  console.log('\n[H] 화면 배선 — nav·뷰·인덱스 onclick·자리표시자 종결');
  {
    const wd = readFe('workdesk.html');
    ok('관리자 nav 에 [탈시트 전환] 버튼', /data-v="cutover" onclick="switchView\('cutover'\)"/.test(wd));
    ok('★ AE nav 에는 없다(서버 게이트 adminOrMaster 와 1:1)',
      (wd.match(/data-v="cutover"/g) || []).length === 1);
    ok('switchView 분기에 연결', /v==='cutover'\)\s*renderCutoverView\(\)/.test(wd));
    ok('★ onclick 은 인덱스만 넘긴다(시트발 작업명 보간 금지)',
      /_coCheck\(\$\{i\}\)/.test(wd) && /_coCutover\(\$\{i\}\)/.test(wd) && /_coReconnect\(\$\{i\}\)/.test(wd));
    // ★★ "호출문이 있나"로는 못 잡는다 — 정의를 지워도 호출은 남아 grep 이 통과한다(변이시험 M15 실측).
    //    실제로 실행해 **자리표시자가 끝나는지**를 본다.
    {
      const blocks = ['function renderCutoverView(', 'async function _coLoad(', 'function _coFailed(']
        .map(sig => { const i = wd.indexOf(sig); assert(i > 0, sig + ' 미발견'); return wd.slice(i, wd.indexOf('\n}', i) + 2); });
      const mount = { html: '' };
      const sandbox = {
        STATE: {}, assert,
        api: async () => { throw new Error('네트워크 끊김'); },
        $: () => ({ set innerHTML(v) { mount.html = v; }, get innerHTML() { return mount.html; } }),
        esc: (s) => String(s == null ? '' : s),
      };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(blocks.join('\n') + '\n;this.__run = renderCutoverView;', sandbox);
      sandbox.__run();
      await new Promise(r => setTimeout(r, 30));
      ok('★★ 조회가 실패해도 "불러오는 중…"에 매달리지 않고 사유 + [다시 시도]로 끝낸다',
        !/불러오는 중/.test(mount.html) && /다시 시도/.test(mount.html) && /네트워크 끊김/.test(mount.html));
    }
    // ★★ 점검표 렌더는 **실행해서** 본다 — 타이핑 입력칸을 지우면서 [이관] 버튼까지 같이
    //    날려 버리면 "통과했는데 누를 게 없는" 화면이 되는데 grep 으로는 안 보인다.
    {
      const i = wd.indexOf('function _coChecklistHtml(');
      assert(i > 0, '_coChecklistHtml 미발견');
      const sandbox = {
        STATE: { co: { items: [{ tabName: 'T1', displayName: 'T1' }] } },
        esc: (s) => String(s == null ? '' : s),
      };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      const j = wd.indexOf('function _coFixBtn(');
      assert(j > 0, '_coFixBtn 미발견');
      vm.runInContext(wd.slice(i, wd.indexOf('\n}', i) + 2)
        + wd.slice(j, wd.indexOf('\n}', j) + 2) + '\n;this.__f = _coChecklistHtml;', sandbox);
      const pass = sandbox.__f({ canCutover: true, checks: [{ state: 'pass', label: 'L', detail: 'D' }] }, 0);
      const block = sandbox.__f({ canCutover: false, checks: [{ state: 'unknown', label: 'L', detail: 'D' }] }, 0);
      ok('★★ 통과면 [이관] 버튼이 실제로 그려진다', /_coCutover\(0\)/.test(pass) && />이관</.test(pass));
      ok('★★ 그 자리에 타이핑 입력칸은 없다(사용자 확정 — 단계 제거)',
        !/<input/.test(pass) && !/이름을 그대로 입력/.test(pass));
      ok('★ 통과 못 하면 [이관] 버튼 자체가 없다(눌러도 안 되는 버튼 금지)',
        !/_coCutover\(/.test(block) && /이관할 수 없습니다/.test(block));
      /* ★★ 경고 전용(advisory) 항목은 **막는 항목과 다르게** 그린다 — 같은 ✕ 로 그리면
       *    "빨간 게 있는데 왜 이관 버튼이 살아 있지?"가 된다(사용자 확정 2026-08-07). */
      const advOut = sandbox.__f({ canCutover: true, advisories: ['mirror'],
        checks: [{ key: 'mirror', state: 'fail', advisory: true, label: 'L', detail: 'D' }] }, 0);
      ok('★★ 경고 전용 항목이 있어도 [이관] 버튼은 그려진다',
        /_coCutover\(0\)/.test(advOut) && />이관</.test(advOut));
      ok('★ 그 항목은 ✕(막힘)로 그리지 않는다', /⚠/.test(advOut) && !/✕/.test(advOut));
      ok('★ 화면이 "막지 않는다"와 "마지막으로 한 번 더 읽는다"를 말한다',
        /막지 않습니다/.test(advOut) && /마지막으로 한 번 더 읽어 반영/.test(advOut));
    }
    /* ★★ 막힌 항목은 그 자리에서 처리된다 — 종전 안내는 "시트 데이터 반영 점검 화면에서…" 라고만
     *    했는데 그 화면은 **nav 어디에도 없어**(링크 0곳) 주소를 직접 쳐야 열렸다(사용자 신고).
     *    조치 종류는 서버가 `fix` 로 말하고 화면은 그대로 그린다(프론트 재판정 0). */
    {
      const i = wd.indexOf('function _coFixBtn(');
      assert(i > 0, '_coFixBtn 미발견');
      const sandbox = { esc: (s) => String(s == null ? '' : s) };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(wd.slice(i, wd.indexOf('\n}', i) + 2) + '\n;this.__f = _coFixBtn;', sandbox);
      const ref = sandbox.__f({ state: 'fail', fix: 'refresh' }, 3);
      const aud = sandbox.__f({ state: 'unknown', fix: 'audit' }, 3);
      ok('★★ 새로고침이 필요한 항목엔 [시트 새로고침] 버튼이 붙는다(인덱스만 전달)',
        /_coRefresh\(3\)/.test(ref) && /시트 새로고침/.test(ref));
      ok('★ 다른 화면이 필요한 항목엔 [반영 점검 열기] 버튼', /_coAudit\(\)/.test(aud));
      const bf = sandbox.__f({ state: 'fail', fix: 'backfill' }, 3);
      ok('★★ 준비 자리 부족은 [표에 자리 채우기] 버튼이 그 자리에 붙는다(인덱스만 전달)',
        /_coBackfill\(3\)/.test(bf) && /표에 자리 채우기/.test(bf));
      ok('★ 그 버튼이 무엇을 하는지 화면이 말한다(시트 무접촉)', /시트는 건드리지 않습니다/.test(bf));
      ok('★ 통과한 항목·조치 없는 항목엔 버튼을 만들지 않는다(눌러도 안 되는 버튼 금지)',
        sandbox.__f({ state: 'pass', fix: 'refresh' }, 3) === ''
        && sandbox.__f({ state: 'fail', fix: null }, 3) === '');
    }
    ok('★★ 새로고침은 기존 반영 도구를 그대로 쓴다(신규 엔드포인트 0) + 끝나면 자동 재점검',
      /_coRefresh[\s\S]{0,700}sheet-sync\/repair/.test(wd) && /_coRefresh[\s\S]{0,900}_coCheck\(i\)/.test(wd));
    /* ★★ 백필은 **맞는 도구 하나만** 부른다 — 두 도구가 헷갈려 난 사고의 재발 차단.
     *    repair(=위쪽 [반영])는 review_index 에 있는 행만 옮기므로 이름 없는 준비 자리를 못 채운다. */
    const bfFn = wd.slice(wd.indexOf('async function _coBackfill'), wd.indexOf('async function _coCheck'));
    ok('★★ 자리 채우기는 slot-backfill 을 실제 실행한다(dryRun 아님)',
      /sheet-sync\/slot-backfill/.test(bfFn) && /dryRun:\s*false/.test(bfFn));
    ok('★★ repair 를 부르지 않는다(그 도구로는 준비 자리를 못 채운다)', !/sheet-sync\/repair/.test(bfFn));
    ok('★ 몇 줄이 생기는지 보여주고 확인받는다(조용한 대량 생성 금지)',
      /confirm\(/.test(bfFn) && /sr&&sr\.detail/.test(bfFn));
    ok('★ 채우고 끝내지 않고 바로 재점검한다', /await _coCheck\(i\)/.test(bfFn));
    ok('★ 실패 두 경로 모두 사유로 화면을 종결시킨다',
      (bfFn.match(/자리 채우기 실패/g) || []).length === 2);
    ok('★ 반영 점검 화면으로 가는 길이 화면에 있다(주소 직접 입력 불필요)',
      /_coAudit[\s\S]{0,120}sheet-sync-audit\.html/.test(wd) && /onclick="_coAudit\(\)">↗ 반영 점검</.test(wd));
    ok('★ 안내문이 없는 화면 이름을 가리키지 않는다',
      !/시트 데이터 반영 점검<\/b> 화면에서 먼저 하세요/.test(wd));
    ok('★ 오래 걸리는 조치는 진행 문구를 보여준다(사람이 다시 누르지 않게)',
      /ck\.note\|\|'점검 중…'/.test(wd) && /다시 읽는 중/.test(wd));
    ok('★ not_ready(096 미적용)를 화면이 말한다', /j\.code==='not_ready'/.test(wd));
    ok('★ 점검표는 서버 판정을 그대로 그린다(프론트 재판정 0) — canCutover 로만 분기',
      /ck\.canCutover/.test(wd) && !/canCutover\s*=\s*[^=]/.test(wd));
    ok('이관 전 confirm + 되돌리기 안내', /_coCutover[\s\S]{0,900}confirm\(/.test(wd));
    ok('★ 부수효과 실패를 사용자에게 알린다', /장부 재생성 실패/.test(wd) && /시트 안내문 기입 실패/.test(wd));
    // ★★ 인계는 성공도 말한다 — "몇 건을 어디로 옮겼는지" 모르면 담당자가 시트를 다시 확인하러 간다.
    ok('★★ 이관 확인창이 미반영 주문 처리 방식을 먼저 말한다(시트 아님 · 표로)',
      /_coCutover[\s\S]{0,900}시스템 표로 옮깁니다/.test(wd));
    ok('★★ 이관 결과가 옮긴 건수를 말한다', /handoff[\s\S]{0,400}시스템 표로 옮겼습니다/.test(wd));
    ok('★ 인계 실패·자리없음·절단을 각각 고지한다(조용한 누락 금지)',
      /h\.failed/.test(wd) && /h\.blocked/.test(wd) && /h\.truncated/.test(wd));
    /* ★★ 마지막 반영 실패는 특히 크게 말해야 한다 — 그 시트에만 있던 편집(직원 수기 줄)이
     *    안 담겼을 수 있고, 조치([재연결] → [시트 새로고침] → 재이관)까지 알려야 한다. */
    ok('★★ 마지막 반영 실패를 사용자에게 알리고 조치를 말한다',
      /j\.reflect && j\.reflect\.ok===false/.test(wd) && /시트 마지막 반영 실패/.test(wd)
      && /재연결/.test(wd) && /시트 새로고침/.test(wd));
    ok('★ 이관도 오래 걸리는 조치라 진행 문구를 보여준다',
      /_coCutover[\s\S]{0,1200}이관 중…/.test(wd));
    ok('★ 헤더 캡 = 본문 캡(같은 값 1120px)',
      /#cohead \.mh\{max-width:1120px\}/.test(wd) && /\.cowrap\{max-width:1120px/.test(wd));
    ok('CSS 는 co- 접두 신설', /\.cocard\{/.test(wd) && /\.cochk\{/.test(wd));
  }

  /* ══════════════ I. 판정 사본 0 ══════════════ */
  console.log('\n[I] 점검 재료는 기존 서비스 재사용 — 사본 0');
  {
    const src = noLineComments(read('src/services/sheetlessCutover.service.js'));
    ok('시트 준비 줄 = sheetSlotSync.readPreparedRows', /sheetSlotSync\.service'\)\.readPreparedRows/.test(src));
    ok('대조 = trackB.parityReport', /trackB\.service'\)\.parityReport/.test(src));
    ok('열 구성 = sheetlessLedger.rebuildLedgers(preflight)', /rebuildLedgers\(\{[\s\S]{0,120}preflight: true/.test(src));
    ok('연도 필터 = utils/tabActivity 재사용', /require\('\.\.\/utils\/tabActivity'\)/.test(src));
    ok('★ 헤더 탐지·날짜 파서 사본을 만들지 않았다',
      !/detectSheetHeader|parseDateColumn/.test(src));
    ok('★ 기존 탭 이관은 tab_configs.sheetless만 바꾸고, 연결 없는 활성 공고만 내부 작업표·링크를 만든다', (() => {
      const w = src.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi) || [];
      const allowed = /tab_configs|campaigns|recruit_campaigns|work_orders/i;
      return w.filter(x => !/^UPDATE SET$/i.test(x)).every(x => allowed.test(x))
        && /source_work_order_id AS "sourceWorkOrderId"/.test(src)
        && /createSheetlessWorktable/.test(src)
        && /linked_sheet_id=\$2, linked_tab_name=\$3, linked_tab_gid=\$4/.test(src);
    })());
    ok('★ 이미 이관된 작업은 연도 필터로 숨기지 않는다(현황이 거짓말하지 않게)',
      /if \(!t\.sheetless\) \{[\s\S]{0,260}activityVerdict/.test(src));
  }

  console.log(`\n✅ sheetlessCutover: ${passed} cases passed`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
