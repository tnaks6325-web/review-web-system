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
    pendingOrders: 0, queued: 0,
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
      if (/UPDATE tab_configs SET sheetless = TRUE/.test(s)) return { rowCount: 1 };
      if (/UPDATE tab_configs SET sheetless = FALSE/.test(s)) return { rowCount: o.reconnectRows == null ? 1 : o.reconnectRows };
      if (/FROM order_submissions/.test(s)) return { rows: [{ n: o.pendingOrders }] };
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
function stubDeps({ prepared = 3, readOk = true, parityReal = 0, parityThrows = false, ledgerThrows = null,
  ledgerIndexRows = 2, remoteModifiedAt = null, driveThrows = false } = {}) {
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
    sheets.getSheetModifiedTime = _gm;
  };
}

(async () => {
  /* ══════════════ A. 라우터 스택 ══════════════ */
  console.log('\n[A] 라우트 4종 · adminOrMaster');
  {
    const r = require('../src/routes/trackB.routes');
    const found = {};
    for (const l of r.stack) {
      if (!l.route || !/^\/sheetless\//.test(l.route.path)) continue;
      const m = Object.keys(l.route.methods)[0].toUpperCase();
      found[m + ' ' + l.route.path] = l.route.stack.map(h => h.handle.name);
    }
    const keys = Object.keys(found);
    ok('4경로 전부 등록: ' + keys.join(', '), keys.length === 4
      && found['GET /sheetless/list'] && found['GET /sheetless/checklist']
      && found['POST /sheetless/cutover'] && found['POST /sheetless/reconnect']);
    ok('★ 전부 authMiddleware + adminOrMaster (AE·광고주 도달 불가)',
      keys.every(k => found[k].includes('authMiddleware') && found[k].includes('adminOrMasterMiddleware')));
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
    ok('막힌 사유에 다음 행동을 적는다(백필 안내)',
      /백필/.test(r.checks.find(c => c.key === 'sheet_rows').hint));
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
    // 미반영 주문 / 미러 신선도
    const { db } = makeStub({ pendingOrders: 3 });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('시트에 못 쓴 주문이 남아 있으면 잠금', r.canCutover === false && r.blocking.includes('pending'));
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

    // 우리가 읽은 뒤에 시트가 수정됨 → 그 편집이 사라지므로 잠금
    restore = stubDeps({ remoteModifiedAt: new Date(Date.now() - 60 * 1000).toISOString() });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    const mk = r.checks.find(c => c.key === 'mirror');
    ok('★ 읽어 둔 뒤 시트가 수정됐으면 잠금', r.canCutover === false && mk.state === 'fail');
    ok('막힌 사유가 다음 행동을 말한다(새로고침 후 이관)', /새로고침/.test(mk.hint));
    restore();

    // 구글 조회 실패 = 모름 → fail-closed
    restore = stubDeps({ driveThrows: true });
    r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('★★ 시트 상태를 못 물어보면 잠금(fail-open 금지)',
      r.canCutover === false && r.checks.find(c => c.key === 'mirror').state === 'unknown');
    restore(); cutover.__setPoolForTest(null);
  }
  {
    // 한 번도 안 읽어 온 탭
    const { db } = makeStub({ tab: { sheetId: 'S1', tabName: 'T1', tabGid: '11', displayName: 'T1',
      sheetless: false, mirroredAt: null, boardRows: 3 } });
    cutover.__setPoolForTest(db);
    const restore = stubDeps({});
    const r = await cutover.cutoverChecklist({ sheetId: 'S1', tabName: 'T1' });
    ok('시트를 한 번도 읽어 온 기록이 없으면 잠금',
      r.canCutover === false && r.checks.find(c => c.key === 'mirror').state === 'unknown');
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
      vm.runInContext(wd.slice(i, wd.indexOf('\n}', i) + 2) + '\n;this.__f = _coChecklistHtml;', sandbox);
      const pass = sandbox.__f({ canCutover: true, checks: [{ state: 'pass', label: 'L', detail: 'D' }] }, 0);
      const block = sandbox.__f({ canCutover: false, checks: [{ state: 'unknown', label: 'L', detail: 'D' }] }, 0);
      ok('★★ 통과면 [이관] 버튼이 실제로 그려진다', /_coCutover\(0\)/.test(pass) && />이관</.test(pass));
      ok('★★ 그 자리에 타이핑 입력칸은 없다(사용자 확정 — 단계 제거)',
        !/<input/.test(pass) && !/이름을 그대로 입력/.test(pass));
      ok('★ 통과 못 하면 [이관] 버튼 자체가 없다(눌러도 안 되는 버튼 금지)',
        !/_coCutover\(/.test(block) && /이관할 수 없습니다/.test(block));
    }
    ok('★ not_ready(096 미적용)를 화면이 말한다', /j\.code==='not_ready'/.test(wd));
    ok('★ 점검표는 서버 판정을 그대로 그린다(프론트 재판정 0) — canCutover 로만 분기',
      /ck\.canCutover/.test(wd) && !/canCutover\s*=\s*[^=]/.test(wd));
    ok('이관 전 confirm + 되돌리기 안내', /_coCutover[\s\S]{0,900}confirm\(/.test(wd));
    ok('★ 부수효과 실패를 사용자에게 알린다', /장부 재생성 실패/.test(wd) && /시트 안내문 기입 실패/.test(wd));
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
    ok('★ 쓰기 표면은 tab_configs.sheetless 한 칸뿐(운영 테이블 무접촉)', (() => {
      const w = src.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi) || [];
      return w.every(x => /tab_configs/i.test(x));
    })());
    ok('★ 이미 이관된 작업은 연도 필터로 숨기지 않는다(현황이 거짓말하지 않게)',
      /if \(!t\.sheetless\) \{[\s\S]{0,260}activityVerdict/.test(src));
  }

  console.log(`\n✅ sheetlessCutover: ${passed} cases passed`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
