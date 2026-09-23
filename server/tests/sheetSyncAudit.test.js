/**
 * 시트 데이터 반영 점검(sheet-sync audit) 회귀가드
 *
 * 이 가드가 고정하는 것
 *   1. 분류(classifySyncRow)는 순수함수 — 반영 사슬(RAW→인덱스→작업보드)의 끊긴 곳을
 *      실제 실행으로 검증(9케이스). boardRows > indexRows(수동/작업표 행)는 플래그가 아니다.
 *   2. 감사(auditSheetSync)는 읽기 전용(쓰기 SQL 0) · 분모는 tab_configs ·
 *      컷오프 필터는 "이전 등록 + 등록일 미상"을 남긴다(조용한 누락 금지).
 *   3. 수리(repairSheetSync)는 신규 쓰기 경로 0 — 기존 함수 3개를 mirror→build→project
 *      순서로만 호출하고, 한 단계 실패·빌드 락이 다음 단계를 죽이지 않는다.
 *   4. 라우트 2개는 authMiddleware + adminOrMasterMiddleware 뒤(/api/trackb/* — 인트라넷 SSO 도달 가능).
 *   5. 프론트 페이지는 onclick 에 인덱스만 넘긴다(시트발 문자열 보간 금지 — XSS 규율).
 *
 * 실행: node tests/sheetSyncAudit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const FRONT = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }
async function ta(name, fn) { await fn(); pass++; console.log('  ✓ ' + name); }

const svc = require('../src/services/sheetSyncAudit.service');
const { classifySyncRow } = svc;

(async () => {

/* ══ 1) 분류 순수함수 ══════════════════════════════════════ */
console.log('\n1) classifySyncRow — 반영 사슬 진단');

t('정상(전 사슬 도달) = ok · 플래그 0', () => {
  const c = classifySyncRow({ rawRows: 100, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: 'x', indexRows: 90, boardRows: 90 });
  assert.strictEqual(c.severity, 'ok'); assert.strictEqual(c.flags.length, 0);
});
t('RAW 미러 없음 → no_raw_mirror(broken)', () => {
  const c = classifySyncRow({ rawRows: null, mirroredAt: null, idxStatus: 'active', idxBuiltAt: 'x', indexRows: 10, boardRows: 10 });
  assert.ok(c.flags.includes('no_raw_mirror')); assert.strictEqual(c.severity, 'broken');
});
t('인덱스 등록 자체 없음 → index_missing', () => {
  const c = classifySyncRow({ rawRows: 50, mirroredAt: 'x', idxStatus: null, indexRows: 0, boardRows: 0 });
  assert.ok(c.flags.includes('index_missing'));
});
t('인덱스 비활성 상태 → index_inactive', () => {
  const c = classifySyncRow({ rawRows: 50, mirroredAt: 'x', idxStatus: 'skipped', idxBuiltAt: 'x', indexRows: 0, boardRows: 0 });
  assert.ok(c.flags.includes('index_inactive'));
});
t('빌드 오류 → index_error(오류 문구 동봉)', () => {
  const c = classifySyncRow({ rawRows: 50, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: 'x', idxErrorMsg: 'Quota exceeded', indexRows: 0, boardRows: 0 });
  assert.ok(c.flags.includes('index_error')); assert.ok(c.reasonKo.includes('Quota'));
});
t('한 번도 빌드 안 됨 → index_never_built', () => {
  const c = classifySyncRow({ rawRows: 50, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: null, indexRows: 0, boardRows: 0 });
  assert.ok(c.flags.includes('index_never_built'));
});
t('시트엔 데이터 있는데 인덱스 0행 → index_empty(헤더 인식 실패 의심)', () => {
  const c = classifySyncRow({ rawRows: 50, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: 'x', indexRows: 0, boardRows: 0 });
  assert.ok(c.flags.includes('index_empty'));
});
t('인덱스는 있는데 작업보드 0행 → not_projected(broken)', () => {
  const c = classifySyncRow({ rawRows: 100, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: 'x', indexRows: 90, boardRows: 0 });
  assert.ok(c.flags.includes('not_projected')); assert.strictEqual(c.severity, 'broken');
});
t('작업보드가 인덱스보다 적음 → projection_behind(behind — broken 아님)', () => {
  const c = classifySyncRow({ rawRows: 100, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: 'x', indexRows: 90, boardRows: 70 });
  assert.deepStrictEqual(c.flags, ['projection_behind']); assert.strictEqual(c.severity, 'behind');
});
t('★ 작업보드가 인덱스보다 많음(수동/작업표 행) = 정상 + boardExtra 정보만', () => {
  const c = classifySyncRow({ rawRows: 100, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: 'x', indexRows: 90, boardRows: 120 });
  assert.strictEqual(c.severity, 'ok'); assert.strictEqual(c.boardExtra, 30);
});

/* ══ 2) 감사 — 스텁 pool 실제 실행 ═════════════════════════ */
console.log('\n2) auditSheetSync — 읽기 전용 · 컷오프 필터');

const captured = [];
const mkRow = (o) => Object.assign({
  sheetId: 'S1', tabName: 'T', tabGid: '1', displayName: 'T', campaignName: null,
  registeredAt: '2026-07-01T00:00:00Z', rawRows: 10, mirroredAt: 'x',
  idxStatus: 'active', idxBuiltAt: 'x', idxErrorMsg: null, indexRows: 5, boardRows: 5,
}, o);
svc.__setPoolForTest({
  query: async (sql, params) => {
    captured.push(String(sql));
    return { rows: [
      mkRow({ tabName: 'old-ok', registeredAt: '2026-07-01T00:00:00Z' }),
      mkRow({ tabName: 'old-broken', registeredAt: '2026-06-15T00:00:00Z', boardRows: 0 }),
      mkRow({ tabName: 'new-tab', registeredAt: '2026-07-25T00:00:00Z' }),
      mkRow({ tabName: 'unknown-date', registeredAt: null }),
    ] };
  },
});

await ta('컷오프(2026-07-20): 이전 등록만 남고 이후 등록은 제외', async () => {
  const out = await svc.auditSheetSync({ before: '2026-07-20' });
  const names = out.items.map(i => i.tabName);
  assert.ok(names.includes('old-ok') && names.includes('old-broken'), '이전 등록 누락');
  assert.ok(!names.includes('new-tab'), '컷오프 이후 등록이 섞였다');
  assert.strictEqual(out.before, '2026-07-20');
});
await ta('★ 연도 신호가 하나도 없는 작업은 목록에서 빼되 **건수를 고지**한다(조용한 누락 금지)', async () => {
  // 사용자 확정: 연도 미상은 숨기되 상단에 건수 + [보기] 버튼. 종전엔 무조건 포함했다.
  const out = await svc.auditSheetSync({ before: '2026-07-20' });
  assert.ok(!out.items.some(i => i.tabName === 'unknown-date'), '연도 미상이 그대로 섞였다');
  assert.ok(out.yearUnknown >= 1, '연도 미상 건수를 고지하지 않는다 — 조용히 사라지면 안 된다');
  const on = await svc.auditSheetSync({ before: '2026-07-20', includeUnknown: true });
  const unk = on.items.find(i => i.tabName === 'unknown-date');
  assert.ok(unk, '[보기](includeUnknown)로도 안 보인다 — 열람 경로가 없다');
  assert.strictEqual(unk.yearUnknown, true);
});
await ta('문제 탭(broken)이 목록 앞에 온다 + flagged 집계', async () => {
  const out = await svc.auditSheetSync({ before: '2026-07-20' });
  assert.strictEqual(out.items[0].tabName, 'old-broken');
  assert.strictEqual(out.flagged, 1);
});
await ta('잘못된 before 형식은 무시(전수 감사) — 예외로 죽지 않는다', async () => {
  const out = await svc.auditSheetSync({ before: '7/20' });
  assert.strictEqual(out.before, null);
  // 등록일 컷오프는 해제되지만 **연도 하한은 그대로** — 연도 미상 1건은 빠지고 건수로 고지된다.
  assert.strictEqual(out.items.length, 3);
  assert.strictEqual(out.yearUnknown, 1);
});
await ta('★ 잘못된 since 형식은 기본값(2026-01-01)으로 접지 — 형식 오류로 필터가 통째로 꺼지지 않는다', async () => {
  const out = await svc.auditSheetSync({ since: '2026년' });
  assert.strictEqual(out.since, '2026-01-01');
});
t('★ 감사는 읽기 전용 — 쓰기 SQL 0', () => {
  assert.ok(captured.length > 0);
  captured.forEach(sql => assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(sql), '감사에 쓰기 SQL이 들어왔다'));
});
t('★ 분모는 tab_configs(등록 작업 전체) — listActiveTabs 로 세면 끊긴 탭이 분모에서 빠진다', () => {
  const sql = captured[0];
  assert.ok(/FROM tab_configs/i.test(sql), '분모가 tab_configs 가 아니다');
  assert.ok(/is_closed/i.test(sql), '아카이브 탭 제외가 없다');
});
svc.__setPoolForTest(null);

/* ══ 3) 수리 — 순서·독립 실패·신규 쓰기 경로 0 ═════════════ */
console.log('\n3) repairSheetSync — mirror→build→project 순서 고정');

function mkDeps(overrides = {}) {
  const calls = [];
  const deps = {
    mirrorOneSheet: async () => { calls.push('mirror'); return { tabsMirrored: 1, rowsWritten: 10 }; },
    buildOneSheet: async () => { calls.push('build'); return { ok: true }; },
    projectTab: async () => { calls.push('project'); return { imported: 5 }; },
    compareWithIndex: async () => { calls.push('compare'); return { indexRows: 5, dbRows: 5, inSync: true }; },
    ...overrides,
  };
  return { deps, calls };
}

await ta('정상 경로: mirror → build → project → compare 순서', async () => {
  const { deps, calls } = mkDeps();
  const out = await svc.repairSheetSync({ sheetId: 'S', tabName: 'T', deps });
  assert.deepStrictEqual(calls, ['mirror', 'build', 'project', 'compare']);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.compare.inSync, true);
});
await ta('★ 미러 실패해도 빌드·투영은 계속(한 단계 실패가 전체를 죽이지 않는다)', async () => {
  const { deps, calls } = mkDeps({ mirrorOneSheet: async () => { throw new Error('quota'); } });
  const out = await svc.repairSheetSync({ sheetId: 'S', tabName: 'T', deps });
  assert.ok(calls.includes('build') && calls.includes('project'));
  assert.strictEqual(out.steps.mirror.ok, false);
  assert.ok(out.steps.mirror.error.includes('quota'));
});
await ta('★ 빌드 락(locked) = 보고만 하고 투영은 진행', async () => {
  const { deps, calls } = mkDeps({ buildOneSheet: async () => ({ ok: false, locked: true, error: '타 사용자가 갱신중입니다.' }) });
  const out = await svc.repairSheetSync({ sheetId: 'S', tabName: 'T', deps });
  assert.strictEqual(out.steps.build.locked, true);
  assert.ok(calls.includes('project'));
});
await ta('투영 실패 = ok:false(성공으로 꾸미지 않는다)', async () => {
  const { deps } = mkDeps({ projectTab: async () => { throw new Error('db down'); } });
  const out = await svc.repairSheetSync({ sheetId: 'S', tabName: 'T', deps });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.steps.project.ok, false);
});
await ta('sheetId/tabName 없으면 즉시 거부', async () => {
  await assert.rejects(() => svc.repairSheetSync({ sheetId: '', tabName: '' }));
});
t('★ 수리는 신규 쓰기 경로 0 — repairSheetSync 안에 직접 SQL 없음(기존 함수 3개만 재사용)', () => {
  const src = R('src/services/sheetSyncAudit.service.js');
  const i = src.indexOf('async function repairSheetSync(');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(body),
    '수리가 SQL 을 직접 쓴다 — 반영 규칙 사본 금지(mirrorOneSheet/buildOneSheet/projectTab 만)');
  ['mirrorOneSheet', 'buildOneSheet', 'projectTab', 'compareWithIndex'].forEach(fn =>
    assert.ok(src.includes(fn), fn + ' 호출이 없다'));
});
t('★★ 이 서비스의 쓰기 표면은 둘뿐 — `tab_configs.tab_gid`(빈 칸만) · `app_settings` 캐시 키', () => {
  const src = R('src/services/sheetSyncAudit.service.js');
  const writes = src.match(/\b(INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET[^\n]*|DELETE\s+FROM\s+\w+)/gi) || [];
  assert.strictEqual(writes.length, 3, '쓰기 SQL 이 늘었다: ' + JSON.stringify(writes));
  assert.ok(/UPDATE tab_configs SET tab_gid/i.test(writes[0]), '예상 밖 쓰기: ' + writes[0]);
  // 나머지 둘은 app_settings 키(연도 확인 캐시 · 목록 제외) — 설정·캐시 저장소지 운영 테이블이 아니다.
  assert.ok(writes.slice(1).every(w => /INSERT INTO app_settings/i.test(w)),
    '예상 밖 쓰기: ' + JSON.stringify(writes.slice(1)));
  ['review_index', 'campaign_participants', 'order_submissions', 'index_master', 'raw_sheet_rows']
    .forEach(tb => assert.ok(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${tb}\\b`, 'i').test(src),
      '운영 테이블에 쓰고 있다: ' + tb));
  const i = src.indexOf('async function backfillTabGids(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/NULLIF\(tab_gid, ''\) IS NULL/.test(body),
    'gid 가 이미 있는 탭을 덮을 수 있다 — 백필은 빈 칸만 채운다(교정은 별도 경로의 일)');
});

/* ══ 4) 라우트 — 스택 실검사 ═══════════════════════════════ */
console.log('\n4) 라우트 권한');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const router = require('../src/routes/trackB.routes');
const layers = router.stack.filter(l => l.route).map(l => ({
  path: l.route.path, methods: Object.keys(l.route.methods), mw: l.route.stack.map(s => s.name),
}));
const audit = layers.find(l => l.path === '/sheet-sync/audit');
const repair = layers.find(l => l.path === '/sheet-sync/repair');

t('감사 GET · 수리 POST 라우트가 등록돼 있다', () => {
  assert.ok(audit && audit.methods.includes('get'), 'GET /sheet-sync/audit 없음');
  assert.ok(repair && repair.methods.includes('post'), 'POST /sheet-sync/repair 없음');
});
t('★ 둘 다 authMiddleware + adminOrMasterMiddleware — AE(staff)·광고주 차단', () => {
  [audit, repair].forEach(l => {
    assert.ok(l.mw.includes('authMiddleware'), l.path + ': authMiddleware 없음');
    assert.ok(l.mw.includes('adminOrMasterMiddleware'), l.path + ': adminOrMasterMiddleware 없음');
  });
});

/* ══ 5) 프론트 배선 ════════════════════════════════════════ */
console.log('\n5) 프론트(sheet-sync-audit.html)');
const HTML = FRONT('sheet-sync-audit.html');

t('감사·수리 두 엔드포인트를 호출한다', () => {
  assert.ok(HTML.includes('/api/trackb/sheet-sync/audit'));
  assert.ok(HTML.includes('/api/trackb/sheet-sync/repair'));
});
t('★ onclick 은 인덱스만 넘긴다(시트발 탭명 문자열 보간 금지 — XSS 규율)', () => {
  assert.ok(/repairOne\(' \+ i \+ '\)/.test(HTML), '반영 버튼이 인덱스 방식이 아니다');
  assert.ok(!/repairOne\('\s*"?\s*\+\s*(esc\()?it\./.test(HTML), 'onclick 에 탭 데이터가 보간됐다');
});
t('escape 처리(esc)와 api.js(API_BASE_URL) 사용', () => {
  assert.ok(/function esc\(/.test(HTML));
  assert.ok(/src="api\.js"/.test(HTML));
  assert.ok(!/window\.API_BASE_URL/.test(HTML), 'window.API_BASE_URL 은 존재하지 않는다(레포 실측 함정) — bare 식별자');
});

/* ══ 6) 실제 작업 건수 · "어디에 없는가" 진단 ═══════════════ */
console.log('\n6) 시트 작업건수(미러 행 수 아님) · 인덱스 미등록 원인 특정');

// 실측 픽스처: 상단 캠페인 정보 9행 + 빈 줄 + 헤더 18행 + 데이터 15행 = 미러 33행, 실제 작업 15건
const HDRS = ['번호', '담당자', '구매일자', '수취인', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액'];
function auditPool({ tabs, imRows = [], arRows = [], dataCount = 15 }) {
  const seen = { countSql: [], headScan: 0 };
  return {
    seen,
    query: async (sql, params) => {
      const s = String(sql);
      if (/FROM tab_configs tc/.test(s) && /registeredAt/.test(s)) return { rows: tabs };
      if (/row_index <= 60/.test(s)) {
        seen.headScan++;
        return { rows: [
          { sheet_id: 'S', tab_gid: 'G', row_index: 1, cells: ['캠페인명', '6/10퓨비아표백제_네이버15건'] },
          { sheet_id: 'S', tab_gid: 'G', row_index: 18, cells: HDRS },
        ] };
      }
      if (/COUNT\(\*\)::int AS n FROM raw_sheet_rows/.test(s)) { seen.countSql.push({ s, params }); return { rows: [{ n: dataCount }] }; }
      if (/FROM index_master WHERE sheet_id/.test(s)) return { rows: imRows };
      if (/FROM index_master_archive/.test(s)) return { rows: arRows };
      return { rows: [] };
    },
  };
}
const baseTab = {
  sheetId: 'S', tabName: '6/10퓨비아표백제_네이버15건', tabGid: 'G',
  displayName: '6/10퓨비아표백제_네이버15건', campaignName: null, registeredAt: '2026-06-10T00:00:00Z',
  rawRows: 33, mirroredAt: 'x', idxStatus: null, idxBuiltAt: null, idxErrorMsg: null,
  indexRows: 0, boardRows: 0,
};

await ta('★★ 시트 작업건수는 헤더 아래 값 있는 행(15) — 미러 행 수(33)를 그대로 쓰지 않는다', async () => {
  const p = auditPool({ tabs: [baseTab] });
  svc.__setPoolForTest(p);
  const out = await svc.auditSheetSync({});
  const it = out.items[0];
  assert.strictEqual(it.dataRows, 15, '실제 작업 건수가 15가 아니다');
  assert.strictEqual(it.rawRows, 33, '미러 행 수는 참고로 남겨야 한다');
  // 헤더 아래(18행 초과)만 세는지 — 헤더 위 캠페인 정보가 섞이면 33이 된다
  const cq = p.seen.countSql[0];
  assert.ok(cq && cq.params[2] === 18, '헤더 행(18) 아래부터 세지 않는다');
  assert.ok(/btrim\(v\) <> ''/.test(cq.s), '빈 행을 걸러내지 않는다');
  svc.__setPoolForTest(null);
});
await ta('★ 인덱스 등록부에 같은 시트가 한 줄도 없음 → index_sheet_never_built', async () => {
  svc.__setPoolForTest(auditPool({ tabs: [baseTab], imRows: [] }));
  const out = await svc.auditSheetSync({});
  assert.ok(out.items[0].flags.includes('index_sheet_never_built'), 'flags=' + out.items[0].flags);
  assert.ok(/한 줄도 없/.test(out.items[0].reasonKo));
  assert.strictEqual(out.items[0].indexHint.sheetIndexed, false);
  svc.__setPoolForTest(null);
});
await ta('★★ 시트의 실제 탭 이름이 등록 이름과 다름 → index_renamed(양쪽 이름을 다 보여준다)', async () => {
  // ★ 신호는 **미러의 현재 탭 이름**(gid 로 매칭된 행)이다 — index_master 에서 같은 gid 를 찾는
  //   방식은 본 쿼리의 gid 우선 재매칭 때문에 도달 불가(진짜 PG 검증이 잡은 것).
  svc.__setPoolForTest(auditPool({
    tabs: [{ ...baseTab, mirrorTabName: '6/11퓨비아표백제_네이버15건' }], imRows: [] }));
  const out = await svc.auditSheetSync({});
  assert.ok(out.items[0].flags.includes('index_renamed'), 'flags=' + out.items[0].flags);
  assert.ok(out.items[0].reasonKo.includes('6/11퓨비아표백제_네이버15건'), '시트의 실제 이름을 안 보여준다');
  assert.ok(out.items[0].reasonKo.includes('6/10퓨비아표백제_네이버15건'), '등록된 이름(무엇을 고쳐야 하는지)을 안 보여준다');
  assert.strictEqual(out.items[0].indexHint.renamedTo, '6/11퓨비아표백제_네이버15건');
  svc.__setPoolForTest(null);
});
t('★★ 도달 불가 분기 금지 — 리네임 판정에 index_master gid 매칭을 쓰지 않는다', () => {
  const src = R('src/services/sheetSyncAudit.service.js');
  const i = src.indexOf('async function _indexHints(');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/mirrorTabName/.test(fn), '미러의 현재 탭 이름을 신호로 쓰지 않는다');
  assert.ok(!/String\(r\.tabGid\) === String\(t\.tabGid\)/.test(fn),
    'index_master gid 매칭으로 리네임을 판정한다 — 본 쿼리가 gid 로 이미 매칭해 이 분기는 영영 실행되지 않는다');
});
await ta('★ 아카이브로 내려간 탭 → index_archived(정상일 수 있음을 함께 말한다)', async () => {
  svc.__setPoolForTest(auditPool({ tabs: [baseTab],
    imRows: [{ sheetId: 'S', tabName: '다른탭', tabGid: 'Z', status: 'active' }],
    arRows: [{ sheetId: 'S', tabName: '6/10퓨비아표백제_네이버15건' }] }));
  const out = await svc.auditSheetSync({});
  assert.ok(out.items[0].flags.includes('index_archived'), 'flags=' + out.items[0].flags);
  assert.ok(/아카이브/.test(out.items[0].reasonKo));
  svc.__setPoolForTest(null);
});
await ta('일반 미등록 → 등록부 이름을 밝히고 같은 시트의 등록 탭을 예시로 보여준다', async () => {
  svc.__setPoolForTest(auditPool({ tabs: [baseTab],
    imRows: [{ sheetId: 'S', tabName: '다른탭A', tabGid: 'Z1', status: 'active' },
             { sheetId: 'S', tabName: '다른탭B', tabGid: 'Z2', status: 'active' }] }));
  const out = await svc.auditSheetSync({});
  assert.ok(out.items[0].flags.includes('index_missing'), 'flags=' + out.items[0].flags);
  assert.ok(/index_master/.test(out.items[0].reasonKo), '어느 등록부인지 말하지 않는다');
  assert.ok(/작업목록에도 뜨지 않습니다/.test(out.items[0].reasonKo), '작업목록에서도 빠진다는 영향을 말하지 않는다');
  assert.ok(/리뷰어 검색·구매양식 제출이 막히고/.test(out.items[0].reasonKo), '리뷰어 영향(검색·제출)을 말하지 않는다');
  assert.ok(out.items[0].reasonKo.includes('다른탭A'), '같은 시트의 등록 탭 예시가 없다');
  svc.__setPoolForTest(null);
});
t('★ 판정은 dataRows 우선 · dataRows 없으면 rawRows 폴백(무회귀)', () => {
  // 미러 33행이지만 실제 작업 0건이면 index_empty 로 몰지 않는다
  const a = classifySyncRow({ rawRows: 33, dataRows: 0, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: 'x', indexRows: 0, boardRows: 0 });
  assert.ok(!a.flags.includes('index_empty'), '작업 행이 0인데 인덱스 0을 문제로 봤다');
  const b = classifySyncRow({ rawRows: 33, mirroredAt: 'x', idxStatus: 'active', idxBuiltAt: 'x', indexRows: 0, boardRows: 0 });
  assert.ok(b.flags.includes('index_empty'), 'dataRows 없을 때 rawRows 폴백이 깨졌다');
});
t('★ 정밀 진단은 문제 탭만 · gid 없는 탭은 건수를 지어내지 않는다', () => {
  const body = R('src/services/sheetSyncAudit.service.js');
  assert.ok(/severity !== 'ok'/.test(body), '문제 탭만 보강하지 않는다(전 탭 정밀 진단은 무겁다)');
  assert.ok(/detailCapped/.test(body), '정밀 진단 절단을 고지하지 않는다');
  const i = body.indexOf('async function _countDataRows(');
  const fn = body.slice(i, body.indexOf('\n}', i));
  assert.ok(/filter\(t => t\.tabGid\)/.test(fn), 'gid 없는 탭을 걸러내지 않는다');
  assert.ok(/detectSheetHeader/.test(fn), '헤더 탐지 단일 출처를 안 쓴다');
  assert.ok(/headerRowIndex == null\) continue/.test(fn), '헤더를 못 찾았는데 숫자를 만든다');
});
t('★ 프론트는 시트 작업건수를 주 숫자로 · 미러 행 수는 참고로만', () => {
  assert.ok(/시트 작업건수/.test(HTML), '열 이름이 아직 미러 행 수 기준이다');
  assert.ok(/it\.dataRows != null/.test(HTML), 'dataRows 를 안 쓴다');
  assert.ok(/미러 ' \+ it\.rawRows \+ '행/.test(HTML), '미러 행 수를 참고 표기로 남기지 않았다');
  assert.ok(/검색인덱스’ =|검색인덱스' =/.test(HTML) || /리뷰어가 이름·전화로/.test(HTML),
    '검색인덱스가 무엇인지 화면이 설명하지 않는다');
});

/* ══ 7) gid 해석 · 탭 직링크 · 백필 · 아카이브 복구 ═══════════ */
console.log('\n7) gid 해석 · 탭 직링크 · 아카이브 복구');

t('★ gid 우선순위: 등록값 → 시트 사본(동명 1개일 때) → 검색인덱스', () => {
  const S = { sheetId: 'SH' };
  assert.strictEqual(svc.resolveTabGid({ ...S, tabGid: '111', mirrorGid: '222', mirrorNameCount: 1, idxGid: '333' }).resolvedGid, '111');
  assert.strictEqual(svc.resolveTabGid({ ...S, tabGid: '', mirrorGid: '222', mirrorNameCount: 1, idxGid: '333' }).resolvedGid, '222');
  assert.strictEqual(svc.resolveTabGid({ ...S, tabGid: '', mirrorGid: '', idxGid: '333' }).resolvedGid, '333');
  assert.strictEqual(svc.resolveTabGid({ ...S, tabGid: '', mirrorGid: '', idxGid: '' }).resolvedGid, null);
});
t('★★ 동명 탭이 2개 이상이면 gid 를 확정하지 않는다(엉뚱한 탭 링크 금지)', () => {
  const g = svc.resolveTabGid({ sheetId: 'SH', tabGid: '', mirrorGid: '222', mirrorNameCount: 2, idxGid: '333' });
  assert.strictEqual(g.resolvedGid, null, '동명 탭인데 gid 를 정했다');
  assert.strictEqual(g.gidSource, 'ambiguous');
  assert.ok(!/#gid=/.test(g.tabUrl), '확정 못 했는데 탭 앵커를 붙였다');
});
t('★ 탭 링크는 docs.google.com 고정 + gid 있으면 #gid= 로 그 탭이 열린다', () => {
  const g = svc.resolveTabGid({ sheetId: 'ABC', tabGid: '1244421967' });
  assert.strictEqual(g.tabUrl, 'https://docs.google.com/spreadsheets/d/ABC/edit#gid=1244421967');
  assert.strictEqual(svc.resolveTabGid({ sheetId: '', tabGid: '1' }).tabUrl, null, '시트 id 없이 링크를 만들었다');
});

await ta('gid 백필: 비어 있는 탭만 채우고, 동명 탭은 사유와 함께 건너뛴다', async () => {
  const ups = [];
  svc.__setPoolForTest({
    query: async (sql, params) => {
      const s = String(sql);
      if (/NULLIF\(tc\.tab_gid, ''\) IS NULL/.test(s)) return { rows: [
        { sheetId: 'S', tabName: 'A', displayName: 'A', mirrorGid: '10', mirrorNameCount: 1, idxGid: null },
        { sheetId: 'S', tabName: 'B', displayName: 'B', mirrorGid: '20', mirrorNameCount: 3, idxGid: null },
        { sheetId: 'S', tabName: 'C', displayName: 'C', mirrorGid: null, mirrorNameCount: 0, idxGid: '30' },
      ] };
      if (/UPDATE tab_configs SET tab_gid/.test(s)) { ups.push(params); return { rowCount: 1 }; }
      return { rows: [] };
    },
  });
  const pre = await svc.backfillTabGids({});
  assert.strictEqual(pre.dryRun, true);
  assert.strictEqual(pre.fillable, 2, 'A(미러)·C(인덱스) 두 개가 채워져야 한다');
  assert.strictEqual(pre.skipped, 1, '동명 탭 B 가 건너뛰기로 보고되지 않았다');
  assert.ok(/동명/.test(pre.skip[0].reason), '건너뛴 이유를 말하지 않는다');
  assert.strictEqual(ups.length, 0, '미리보기가 UPDATE 를 실행했다');

  const out = await svc.backfillTabGids({ dryRun: false });
  assert.strictEqual(out.updated, 2);
  assert.ok(ups.every(p => p[2] === '10' || p[2] === '30'), '엉뚱한 gid 를 썼다');
  svc.__setPoolForTest(null);
});

await ta('★ 아카이브 전용 탭(등록 목록에 없음)은 includeArchived 일 때만 목록에 합류', async () => {
  const arch = [{ sheetId: 'S', tabName: '지난차수', tabGid: '99', campaignName: 'X', archivedAt: '2026-06-01', row_count: 15 }];
  const mk = (incl) => ({
    query: async (sql) => {
      const s = String(sql);
      if (/FROM tab_configs tc/.test(s) && /registeredAt/.test(s)) return { rows: [] };
      if (/FROM index_master_archive ima/.test(s)) return { rows: arch };
      return { rows: [] };
    },
  });
  svc.__setPoolForTest(mk());
  const off = await svc.auditSheetSync({});
  assert.strictEqual(off.items.length, 0, '기본 조회에 아카이브 탭이 섞였다');
  const on = await svc.auditSheetSync({ includeArchived: true });
  assert.strictEqual(on.items.length, 1);
  assert.strictEqual(on.items[0].archivedOnly, true);
  assert.ok(on.items[0].flags.includes('index_archived'));
  assert.ok(/복구/.test(on.items[0].reasonKo), '다음 행동(복구)을 안내하지 않는다');
  assert.strictEqual(on.items[0].tabUrl, 'https://docs.google.com/spreadsheets/d/S/edit#gid=99');
  svc.__setPoolForTest(null);
});

t('★★ 아카이브 복구는 기존 /api/archive/restore 핸들러에 위임(복구 로직 사본 금지)', () => {
  const ROUTES = R('src/routes/trackB.routes.js');
  assert.ok(/_delegate\(_archiveRoutes, 'post', '\/restore'\)/.test(ROUTES), '기존 복구 핸들러에 위임하지 않는다');
  const src = R('src/services/sheetSyncAudit.service.js');
  assert.ok(!/index_master_archive[\s\S]{0,200}INSERT INTO index_master\b/.test(src),
    '복구 로직 사본이 들어왔다 — archive.routes 의 트랜잭션 한 벌만 써야 한다');
});
t('★ 신규 라우트 2종도 authMiddleware + adminOrMaster(원본보다 넓히지 않는다)', () => {
  const gid = layers.find(l => l.path === '/sheet-sync/gid-backfill');
  const un = layers.find(l => l.path === '/sheet-sync/unarchive');
  [gid, un].forEach(l => {
    assert.ok(l, '라우트 누락');
    assert.ok(l.mw.includes('authMiddleware') && l.mw.includes('adminOrMasterMiddleware'), l.path + ' 게이트 부족');
  });
  const ROUTES = R('src/routes/trackB.routes.js');
  const i = ROUTES.indexOf("router.post('/sheet-sync/gid-backfill'");
  const body = ROUTES.slice(i, ROUTES.indexOf('\nrouter.', i + 10));
  assert.ok(/dryRun:\s*dryRun\s*!==\s*false/.test(body), 'gid 백필 기본값이 미리보기가 아니다');
});
t('★ 프론트: 탭 링크·아카이브 복구·gid 채우기 배선 + onclick 은 인덱스만', () => {
  assert.ok(/function tabLink\(/.test(HTML), '탭 링크 렌더러가 없다');
  assert.ok(/\^https:\\\/\\\/docs\\\.google\\\.com/.test(HTML), '링크 호스트 검증이 없다(신뢰 베이스 재구성)');
  assert.ok(/rel="noopener"/.test(HTML), '새 창 링크에 noopener 가 없다');
  assert.ok(/unarchiveOne\(' \+ i \+ '\)/.test(HTML), '복구 버튼이 인덱스 방식이 아니다');
  assert.ok(HTML.includes('/api/trackb/sheet-sync/unarchive') && HTML.includes('/api/trackb/sheet-sync/gid-backfill'),
    '신규 엔드포인트 호출이 없다');
  assert.ok(/includeArchived=1/.test(HTML), '아카이브 포함 조회 배선이 없다');
  // 복구는 반영까지 이어져야 "작업보드에 나타나는 상태"로 끝난다
  const i = HTML.indexOf('async function unarchiveOne(');
  const body = HTML.slice(i, HTML.indexOf('async function gidBackfill(', i));
  assert.ok(/repairOne\(i, \{ keepRes: true \}\)/.test(body), '복구 후 반영으로 이어지지 않는다');
});

/* ══ 8) 연도 기준(2026~) ═══════════════════════════════════ */
console.log('\n8) 연도 기준 — 과거 자료 제외 · 미상은 고지');
const act = require('../src/utils/tabActivity');

t('★★ 활동 시각 = 신호들의 **최댓값** — 2025년 등록이어도 2026년 주문이 있으면 현재 작업', () => {
  const r = act.resolveActivity({ registeredAt: '2025-06-01T00:00:00Z', lastOrderAt: '2026-08-01T00:00:00Z' });
  assert.strictEqual(r.activityAt, '2026-08-01');
  assert.strictEqual(r.activitySource, 'order');
  assert.strictEqual(act.activityVerdict(r, '2026-01-01'), 'keep', '살아있는 작업을 과거로 숨겼다');
});
t('2025년 신호만 있으면 old · 신호 0이면 unknown(과거로 단정하지 않는다)', () => {
  assert.strictEqual(act.activityVerdict(act.resolveActivity({ registeredAt: '2025-06-01' }), '2026-01-01'), 'old');
  const u = act.resolveActivity({});
  assert.strictEqual(u.yearUnknown, true);
  assert.strictEqual(act.activityVerdict(u, '2026-01-01'), 'unknown');
  assert.strictEqual(act.activityVerdict(u, '2026-01-01', true), 'keep', '[보기]로도 안 열린다');
});
t('★★ 구매일자는 **연도가 명시된 표기만** 신호로 쓴다(추론 금지)', () => {
  assert.strictEqual(act.explicitYearDate('26.8.24(월)'), '2026-08-24');
  assert.strictEqual(act.explicitYearDate('6 / 11 (목)'), null,
    '연도 없는 표기로 연도를 추론했다 — 2025/2026 을 찍는 셈이 된다');
  assert.strictEqual(act.explicitYearDate(''), null);
});
t('★★ mirrored_at · built_at 은 신호로 쓰지 않는다(매 주기 NOW() 로 갱신 → 전부 최신으로 보임)', () => {
  const src = R('src/utils/tabActivity.js');
  const sql = src.slice(src.indexOf('ACTIVITY_LATERAL_SQL'), src.indexOf('ACTIVITY_SELECT_SQL'));
  assert.ok(!/mirrored_at|built_at/.test(sql),
    '갱신되는 시각을 활동 신호로 썼다 — 2025년 작업도 최신으로 보여 필터가 무력화된다');
  ['order_submissions', 'recruit_campaigns', 'review_index'].forEach(tb =>
    assert.ok(sql.includes(tb), tb + ' 신호가 없다'));
});
t('★ 두 점검이 같은 신호를 본다(SQL 조각 단일 출처 — 사본 금지)', () => {
  ['src/services/sheetSyncAudit.service.js', 'src/services/sheetSlotSync.service.js'].forEach(f => {
    const src = R(f);
    assert.ok(/require\('\.\.\/utils\/tabActivity'\)/.test(src), f + ': tabActivity 미사용');
    assert.ok(/ACTIVITY_LATERAL_SQL/.test(src), f + ': 공용 LATERAL 조각을 안 쓴다');
    assert.ok(!/MAX\(os\.submitted_at\)/.test(src), f + ': 활동 신호 SQL 사본이 들어왔다');
  });
});
t('★ 제외한 건수를 반드시 돌려준다(조용한 누락 금지) + 프론트가 고지·열람 버튼을 그린다', () => {
  ['src/services/sheetSyncAudit.service.js', 'src/services/sheetSlotSync.service.js'].forEach(f => {
    const src = R(f);
    assert.ok(/filteredOld/.test(src) && /yearUnknown/.test(src), f + ': 제외 건수를 안 센다');
  });
  assert.ok(/meta\.filteredOld/.test(HTML), '과거 제외 건수를 화면이 말하지 않는다');
  assert.ok(/meta\.yearUnknown/.test(HTML) && /toggleUnknown\(\)/.test(HTML), '연도 미상 [보기] 버튼이 없다');
  assert.ok(/includeUnknown=1/.test(HTML), 'includeUnknown 배선이 없다');
  assert.ok(/id="sinceDate"/.test(HTML) && /value="2026-01-01"/.test(HTML), '기준 연도 입력 기본값이 없다');
});
/* ── 연도 확인(시트 실제 날짜값 읽기) ─────────────────────── */
t('★★ 미러는 표시 문자열만 갖는다 — 시트의 실제 날짜값은 UNFORMATTED 로만 읽힌다', () => {
  const mirror = R('src/services/rawMirror.service.js');
  assert.ok(/FORMATTED_VALUE/.test(mirror), '미러 읽기 옵션이 바뀌었다');
  const src = R('src/services/sheetSyncAudit.service.js');
  const i = src.indexOf('async function probeUnknownYears(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/UNFORMATTED_VALUE/.test(body), '연도 확인이 표시 문자열을 읽는다 — 연도를 못 되찾는다');
  assert.ok(/parseDateToken/.test(body), '일련번호 해석에 기존 파서를 안 쓴다(사본 금지)');
  assert.ok(/throttledCall/.test(body), '시트 API 호출이 throttle 을 안 탄다');
  assert.ok(/gid: String\(t\.tabGid\)/.test(body), 'gid 없이 읽는다 — 리네임에 취약');
});
t('★★ 미러 읽기 옵션을 바꾸지 않는다(주문 행배정·가드가 표시 문자열 비교에 의존)', () => {
  const src = R('src/services/sheetSyncAudit.service.js');
  assert.ok(!/rawMirror|mirrorAllSheets/.test(src.slice(src.indexOf('async function probeUnknownYears('))),
    '연도 확인이 미러 경로를 건드린다');
  const led = R('src/services/orderLedger.service.js');
  assert.ok(/FORMATTED_VALUE/.test(led), '주문원장 라이브 폴백이 미러와 다른 옵션을 쓴다(비교가 깨진다)');
});
t('★★ [실측 신고] 구매일 연도를 못 읽으면 등록일로 폴백 — 그 탭이 연도 확인 대상이어야 한다', () => {
  const a2 = require('../src/utils/tabActivity');
  const row = { sampleStartDate: '7 / 12 (금)', registeredAt: '2026-03-01' };   // 표기에 연도 없음
  const act = a2.resolveActivity(row);
  assert.strictEqual(act.activitySource, 'registered', '폴백 경로가 바뀌었다');
  assert.strictEqual(act.yearUnknown, false, 'yearUnknown 이면 종전 대상 필터로도 잡혔을 것');
  // ★ 핵심: yearUnknown 이 아니어도 **구매일 미확정**이라 확인 대상이어야 한다
  assert.strictEqual(a2.purchaseUnconfirmed(row), true,
    '구매일 미확정을 못 세면 2024·2025 작업이 등록일로 살아남고 교정도 안 된다');
  assert.strictEqual(a2.purchaseUnconfirmed({ probedAt: '2024-07-12' }), false);
  assert.strictEqual(a2.purchaseUnconfirmed({ sampleStartDate: '26.8.24(월)' }), false);
});
t('★★ 연도 확인 대상은 purchaseUnconfirmed 기준(yearUnknown 아님)', () => {
  const src = R('src/services/sheetSyncAudit.service.js');
  const i = src.indexOf('async function probeUnknownYears(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/purchaseUnconfirmed/.test(body),
    '대상 필터가 yearUnknown 기준이면 등록일로 폴백한 과거 작업이 영영 교정되지 않는다');
  assert.ok(!/resolveActivity\(r\)\.yearUnknown/.test(body), '옛 대상 필터가 남아 있다');
});
await ta('★★ 확인 결과가 2024면 등록일(2026)을 이기고 목록에서 빠진다', async () => {
  const probeJson = JSON.stringify({ 'S1\told-ok': '2024-07-12' });
  svc.__setPoolForTest({
    query: async (sql) => {
      const q = String(sql);
      if (/SELECT value FROM app_settings/.test(q)) return { rows: [{ value: probeJson }] };
      if (/FROM tab_configs tc/.test(q) && /registeredAt/.test(q)) return { rows: [
        mkRow({ tabName: 'old-ok', registeredAt: '2026-03-01', sampleStartDate: '7 / 12 (금)' }),
        mkRow({ tabName: 'keep-me', registeredAt: '2026-03-01', sampleStartDate: '7 / 12 (금)' }),
      ] };
      return { rows: [] };
    },
  });
  const out = await svc.auditSheetSync({});
  assert.ok(!out.items.some(i => i.tabName === 'old-ok'), '확인된 구매일 2024 인데 목록에 남았다');
  assert.strictEqual(out.filteredOld, 1);
  // 아직 못 읽은 탭은 건수로 드러난다(그 상태에선 등록일로 임시 판정 중)
  assert.strictEqual(out.purchaseUnconfirmed, 1, '구매일 미확정 건수를 고지하지 않는다');
  svc.__setPoolForTest(null);
});
t("★ 'none'(글자로 친 날짜)은 신호로 쓰지 않는다 + 재조회를 막는다", () => {
  const src = R('src/services/sheetSyncAudit.service.js');
  assert.ok(/probed !== 'none'/.test(src), "'none' 을 날짜처럼 썼다");
  assert.ok(/= 'none';/.test(src), '확인 불가 탭을 기록하지 않아 매번 다시 읽는다(쿼터 낭비)');
});
t('★ 프론트가 구매일 미확정을 항상 드러내고 판정 근거를 행에 표시', () => {
  assert.ok(/meta\.purchaseUnconfirmed/.test(HTML), '구매일 미확정 건수를 화면이 말하지 않는다');
  assert.ok(/과거 작업이 섞여 보일 수 있습니다/.test(HTML), '무엇이 문제인지 설명하지 않는다');
  assert.ok(/ACT_SRC/.test(HTML) && /등록일\(임시\)/.test(HTML), '판정 근거를 행에 안 보여준다');
});
t('★ 연도 확인은 미상 탭만 · 캐시된 탭은 다시 읽지 않는다 · 상한 초과는 고지', () => {
  const src = R('src/services/sheetSyncAudit.service.js');
  const i = src.indexOf('async function probeUnknownYears(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/purchaseUnconfirmed/.test(body), '확인 대상을 좁히지 않는다 — 아는 탭까지 시트를 읽는다');
  assert.ok(/!force && cached\[/.test(body), '이미 확인한 탭을 또 읽는다(force 일 때만 재확인해야 한다)');
  assert.ok(/capped/.test(body), '상한 초과를 고지하지 않는다');
  assert.ok(/tok\.y == null\) continue/.test(body),
    '연도 없는 값(글자로 친 날짜)을 신호로 썼다 — 추측 금지');
});
t('★ 확인된 연도는 활동 신호에 합류(sheet_probe)', () => {
  const act2 = require('../src/utils/tabActivity');
  const r = act2.resolveActivity({ registeredAt: '2025-01-01', probedAt: '2026-07-12' });
  assert.strictEqual(r.activityAt, '2026-07-12');
  assert.strictEqual(r.activitySource, 'sheet_probe');
});
t('★ 라우트: year-probe 는 adminOrMaster · 프론트 버튼은 미상 있을 때만', () => {
  const pr = layers.find(l => l.path === '/sheet-sync/year-probe');
  assert.ok(pr && pr.mw.includes('authMiddleware') && pr.mw.includes('adminOrMasterMiddleware'), '게이트 부족');
  assert.ok(/id="btnProbe"/.test(HTML) && /yearProbe\(\)/.test(HTML), '연도 확인 버튼 배선이 없다');
  assert.ok(HTML.includes('/api/trackb/sheet-sync/year-probe'), '엔드포인트 호출이 없다');
  assert.ok(/no_dated_cell/.test(HTML), '확인 불가 사유(글자로 친 날짜)를 화면이 설명하지 않는다');
});

/* ── 구매일 우선 판정 · 목록 제외 ─────────────────────────── */
t('★★ 구매일 컬럼의 마지막 날짜가 최우선 — 다른 신호로 덮지 않는다(사용자 확정)', () => {
  const a2 = require('../src/utils/tabActivity');
  // 구매일 2025 + 시트 등록 2026 → 과거 작업(등록일로 되살리면 안 된다)
  const r = a2.resolveActivity({ registeredAt: '2026-03-01', probedAt: '2025-07-12' });
  assert.strictEqual(r.activityAt, '2025-07-12');
  assert.strictEqual(a2.activityVerdict(r, '2026-01-01'), 'old', '구매일이 2025인데 목록에 남겼다');
  // 구매일이 없을 때만 나머지 신호의 최댓값
  const r2 = a2.resolveActivity({ registeredAt: '2026-03-01', lastOrderAt: '2026-08-01' });
  assert.strictEqual(r2.activitySource, 'order');
});
t('★ 구매일은 [연도 확인] 값(probedAt) > DB 표본(sampleStartDate) 순', () => {
  const a2 = require('../src/utils/tabActivity');
  const r = a2.resolveActivity({ probedAt: '2026-07-12', sampleStartDate: '26.1.2(금)' });
  assert.strictEqual(r.activitySource, 'sheet_probe');
  assert.strictEqual(r.activityAt, '2026-07-12');
});
await ta('★★ 목록 제외는 **데이터를 지우지 않는다** — 감추기만 하고 되돌릴 수 있다', async () => {
  let saved = null;
  const store = { rows: [] };
  svc.__setPoolForTest({
    query: async (sql, params) => {
      const q = String(sql);
      if (/SELECT value FROM app_settings/.test(q)) return store;
      if (/INSERT INTO app_settings/.test(q)) { saved = params; return { rows: [] }; }
      return { rows: [] };
    },
  });
  const out = await svc.setIgnored({ sheetId: 'S', tabName: 'T' });
  assert.strictEqual(out.ignored, true);
  assert.strictEqual(saved[0], 'sheet_sync_ignored', '제외 목록을 엉뚱한 곳에 저장한다');
  assert.ok(JSON.parse(saved[1])['S\tT'], '제외 기록이 없다');
  // 되돌리기
  store.rows = [{ value: saved[1] }];
  await svc.setIgnored({ sheetId: 'S', tabName: 'T', ignored: false });
  assert.strictEqual(Object.keys(JSON.parse(saved[1])).length, 0, '되돌리기가 안 된다');
  svc.__setPoolForTest(null);
});
await ta('★★ 제외한 작업은 목록에서 빠지고 **건수가 실제로 집계**된다 + includeIgnored 로 복원 열람', async () => {
  // ★ 문자열 존재만 보면 "세는 코드를 지워도" 통과한다(변이시험이 잡은 약한 단언) → 실행으로 확인.
  const ignoreJson = JSON.stringify({ 'S1\told-ok': '2026-08-07T00:00:00Z' });
  svc.__setPoolForTest({
    query: async (sql) => {
      const q = String(sql);
      if (/SELECT value FROM app_settings/.test(q)) return { rows: [{ value: ignoreJson }] };
      if (/FROM tab_configs tc/.test(q) && /registeredAt/.test(q)) return { rows: [
        mkRow({ tabName: 'old-ok' }), mkRow({ tabName: 'keep-me' }),
      ] };
      return { rows: [] };
    },
  });
  const off = await svc.auditSheetSync({});
  assert.ok(!off.items.some(i => i.tabName === 'old-ok'), '제외한 작업이 목록에 남았다');
  assert.strictEqual(off.ignoredCount, 1, '제외 건수가 집계되지 않았다 — 조용히 사라진다');
  assert.ok(off.items.some(i => i.tabName === 'keep-me'), '제외하지 않은 작업까지 빠졌다');

  const on = await svc.auditSheetSync({ includeIgnored: true });
  const back = on.items.find(i => i.tabName === 'old-ok');
  assert.ok(back, '[제외된 작업 보기]로도 안 보인다 — 되돌릴 방법이 없다');
  assert.strictEqual(back.ignored, true, '제외 표시가 행에 없다(복원 버튼을 못 그린다)');
  svc.__setPoolForTest(null);
});
t('★ 제외는 운영 데이터를 건드리지 않는다(삭제 SQL 0) + 건수 고지 + 복원 버튼', () => {
  const src = R('src/services/sheetSyncAudit.service.js');
  const i = src.indexOf('async function setIgnored(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(!/DELETE FROM (?!.*app_settings)/i.test(body), '제외가 데이터를 지운다');
  assert.ok(/app_settings/.test(body), '제외 기록이 app_settings 가 아니다');
  assert.ok(/ignoredCount/.test(src), '제외 건수를 세지 않는다(조용한 누락)');
  assert.ok(/meta\.ignoredCount/.test(HTML), '제외 건수를 화면이 말하지 않는다');
  assert.ok(/toggleIgnore\(' \+ i \+ '\)/.test(HTML), '제외 버튼이 인덱스 방식이 아니다');
  assert.ok(/includeIgnored=1/.test(HTML) && /toggleIgnored\(\)/.test(HTML), '제외된 작업 열람 경로가 없다');
  assert.ok(/지워지지 않습니다/.test(HTML), '데이터가 지워지지 않는다는 안내가 없다');
});
t('★ 라우트: ignore 는 adminOrMaster · 기본은 제외(ignored !== false)', () => {
  const ig = layers.find(l => l.path === '/sheet-sync/ignore');
  assert.ok(ig && ig.mw.includes('authMiddleware') && ig.mw.includes('adminOrMasterMiddleware'), '게이트 부족');
});

t('★ 시트 우위 점검도 같은 기준 입력(sinceDate)을 쓴다 — 두 화면이 다른 범위를 보면 안 된다', () => {
  const i = HTML.indexOf('async function runSlotAudit(');
  const body = HTML.slice(i, HTML.indexOf('const SS_REASON', i));
  assert.ok(/getElementById\('sinceDate'\)/.test(body), '시트 우위 점검이 별도 기준을 쓴다');
});

console.log('\n✅ 전체 통과: ' + pass + '케이스');
process.exit(0);
})().catch(e => { console.error('\n❌ 실패:', e); process.exit(1); });
