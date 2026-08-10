// ═══════════════════════════════════════════════════════════════════════════
// 블로그체험단 M3 회귀가드 — (주)바를참스킨 0804 1회 동기화
//
// 이 잡이 지켜야 하는 것(고정 대상):
//   ① **판정 사본 0** — 준비 행 고르기·값 있음·행 JSON·헤더 탐지·슬롯 INSERT·장부·작업오더 지목이
//      전부 기존 단일 출처를 그대로 쓴다(사본을 두면 "점검이 세는 행 ≠ 만들어지는 자리"로 갈린다).
//   ② **추가만 · 시트 쓰기 0** — 기존 행·제출·입금 표시 무접촉, 시트는 읽기 1회뿐.
//   ③ **seq = 시트 실제 행 번호** — 어긋나면 주문 유입 시 표가 두 겹이 된다.
//   ④ **가드** — 이미 했으면 시트를 다시 읽지 않고, 실패하면 가드를 안 남겨 재시도한다.
//   ⑤ **blank-only 분류** — 사람이 정해 둔 work_kind 를 1회성 잡이 덮지 않는다.
//
// 실행: node tests/blog0804Backfill.test.js
// ═══════════════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const svcPath = path.join(SRC, 'services', 'blog0804Backfill.service.js');
const src = fs.readFileSync(svcPath, 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const slotSyncSrc = fs.readFileSync(path.join(SRC, 'services', 'sheetSlotSync.service.js'), 'utf8');

const svc = require('../src/services/blog0804Backfill.service');
const slotSync = require('../src/services/sheetSlotSync.service');
const participants = require('../src/services/participants.service');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
/** 줄 주석 제거(블록 주석 정규식은 이 레포의 정규식 리터럴을 물어 코드를 통째로 지운다 — 금지) */
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const code = noLineComments(src);

// ── 공통 스텁 ──────────────────────────────────────────────────────────────
function makeDb({ guard = false, tab = { tabName: '0804)비타민,글루타치온_블로그 50건', campaignName: '바를참스킨', sheetless: true }, existing = [], workOrder = { id: 'wo-1' }, tabWorkKind = '', orderWorkKind = '' } = {}) {
  const q = [];
  const db = {
    queries: q,
    async query(sql, params) {
      q.push({ sql, params });
      const s = String(sql);
      if (/FROM app_settings WHERE key/.test(s)) return { rows: guard ? [{ '?column?': 1 }] : [], rowCount: guard ? 1 : 0 };
      if (/FROM tab_configs WHERE sheet_id/.test(s)) return { rows: tab ? [tab] : [], rowCount: tab ? 1 : 0 };
      if (/SELECT seq FROM campaign_participants/.test(s)) return { rows: existing.map(seq => ({ seq })), rowCount: existing.length };
      if (/INSERT INTO campaign_participants/.test(s)) {
        // 실제 createSlotsFromSheetRows 의 INSERT — 만들어진 자리 수를 그대로 돌려준다
        const n = (s.match(/\),\(/g) || []).length + 1;
        return { rows: [], rowCount: n };
      }
      if (/UPDATE tab_configs SET work_kind/.test(s)) return { rows: [], rowCount: tabWorkKind === '' ? 1 : 0 };
      if (/FROM work_orders w/.test(s)) return { rows: workOrder ? [workOrder] : [], rowCount: workOrder ? 1 : 0 };
      if (/UPDATE work_orders SET work_kind/.test(s)) return { rows: [], rowCount: orderWorkKind === '' ? 1 : 0 };
      if (/INSERT INTO app_settings/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

/** 실제 시트 모양: 상단 캠페인 정보 2줄 → 헤더 → 번호만 채운 준비 행 */
function makeGrid(dataRows = 50, { extraFilled = 0 } = {}) {
  const g = [
    ['0804)비타민,글루타치온_블로그 50건'],
    [],
    ['번호', '구매일자', '주문자', '연락처', '주소', '블로그URL', '포스팅URL'],
  ];
  for (let i = 1; i <= dataRows; i++) g.push([String(i), '', '', '', '', '', '']);
  for (let i = 0; i < extraFilled; i++) g.push(['참고', '', '', '', '', '', '']);
  return g;
}

function makeDeps(over = {}) {
  const calls = { readSheet: [], rebuild: [], throttle: [] };
  const deps = {
    readSheet: async (...a) => { calls.readSheet.push(a); return over.grid !== undefined ? over.grid : makeGrid(); },
    throttledCall: async (fn, retries, opts) => { calls.throttle.push({ retries, opts }); return fn(); },
    rebuildLedgers: async (a) => { calls.rebuild.push(a); return { ok: true }; },
    ...over.deps,
  };
  return { deps, calls };
}

async function run(opts = {}) {
  const db = opts.db || makeDb(opts.dbOpts);
  const { deps, calls } = makeDeps(opts);
  participants.__setPoolForTest(db);
  try {
    const res = await svc.runBlog0804Backfill({ ...opts.args, deps: { db, ...deps } });
    return { res, db, calls };
  } finally { participants.__setPoolForTest(null); }
}

(async () => {
console.log('\n블로그체험단 M3 회귀가드 — 바를참스킨 0804 1회 동기화\n');

// ── 1. 판정 단일 출처 ──────────────────────────────────────────────────────
console.log('1) 판정·조립 단일 출처 (사본 금지)');
t('★★ 준비 행 고르기 = sheetSlotSync.pickBlogPrepared', () => {
  assert.ok(/pickBlogPrepared/.test(code), 'pickBlogPrepared 미사용');
  assert.strictEqual(typeof slotSync.pickBlogPrepared, 'function', 'sheetSlotSync 가 안 내보냄');
});
t('★★ "값 있음" 판정 = rowHasValue (SQL btrim 과 같은 뜻)', () => {
  assert.ok(/rowHasValue/.test(code));
  assert.strictEqual(typeof slotSync.rowHasValue, 'function');
  assert.ok(!/\.some\(\s*c\s*=>/.test(code), '값 있음 판정 사본이 들어왔다');
});
t('★ 행 JSON = rowJsonFromHeaders · 헤더 탐지 = utils/sheetHeader', () => {
  assert.ok(/rowJsonFromHeaders/.test(code) && /detectSheetHeader/.test(code));
  assert.ok(!/headers\s*\.\s*forEach\([^)]*\)\s*=>\s*\{[^}]*out\[/.test(code), 'rowJson 사본이 들어왔다');
});
t('★ 슬롯 INSERT 는 participants.createSlotsFromSheetRows 위임(쓰기 소유자)', () => {
  assert.ok(/participants\.createSlotsFromSheetRows/.test(code));
  assert.ok(!/INSERT INTO campaign_participants/.test(code), '슬롯 INSERT 사본이 들어왔다');
});
t('★ 작업오더 지목 = workOrderForTabSql(링크 우선순위 사본 금지)', () => {
  assert.ok(/workOrderForTabSql/.test(code));
  assert.ok(!/ORDER BY\s+link_rank/.test(code), '링크 우선순위 SQL 사본이 들어왔다');
});
t('★ 장부 재생성 = sheetlessLedger.rebuildLedgers', () => {
  assert.ok(/rebuildLedgers/.test(code));
});
t('★★ M2(readPreparedRows)도 같은 pickBlogPrepared 를 쓴다 — 두 경로가 갈릴 수 없다', () => {
  const m2 = noLineComments(slotSyncSrc);
  assert.ok(/pickBlogPrepared\(/.test(m2), 'readPreparedRows 가 헬퍼를 안 쓴다(사본 부활)');
  assert.ok(!/const solid = \[\];/.test(m2), '옛 인라인 선별 코드가 남아 있다');
});

// ── 2. 순수함수: pickBlogPrepared ──────────────────────────────────────────
console.log('\n2) pickBlogPrepared — 총원 상한 · 부족 · 초과 (실행)');
t('값 있는 행만 센다(빈 줄 제외)', () => {
  const r = slotSync.pickBlogPrepared(
    [{ filled: true, item: 1 }, { filled: false, item: 2 }, { filled: true, item: 3 }], null);
  assert.deepStrictEqual(r.prepared, [1, 3]);
  assert.strictEqual(r.solidRows, 2);
});
t('★ 총원까지만 자른다(앞에서부터)', () => {
  const list = [1, 2, 3, 4, 5].map(n => ({ filled: true, item: n }));
  const r = slotSync.pickBlogPrepared(list, 3);
  assert.deepStrictEqual(r.prepared, [1, 2, 3]);
  assert.strictEqual(r.beyondTotal, 2);
  assert.strictEqual(r.shortOfTotal, 0);
});
t('★★ 총원이 실체 행보다 많아도 자리를 지어내지 않는다(부족은 숫자로 고지)', () => {
  const list = [1, 2].map(n => ({ filled: true, item: n }));
  const r = slotSync.pickBlogPrepared(list, 50);
  assert.strictEqual(r.prepared.length, 2, '없는 줄을 만들었다');
  assert.strictEqual(r.shortOfTotal, 48);
});
t('총원 0·null = 자르지 않음(모르면 전부)', () => {
  const list = [1, 2, 3].map(n => ({ filled: true, item: n }));
  assert.strictEqual(slotSync.pickBlogPrepared(list, 0).prepared.length, 3);
  assert.strictEqual(slotSync.pickBlogPrepared(list, null).recruitTotal, null);
});
t('rowHasValue — 공백만 있는 칸은 값이 아니다', () => {
  assert.strictEqual(slotSync.rowHasValue(['', '  ', null]), false);
  assert.strictEqual(slotSync.rowHasValue(['', ' x ']), true);
  assert.strictEqual(slotSync.rowHasValue([]), false);
});

// ── 3. 실행: 자리 생성 ─────────────────────────────────────────────────────
console.log('\n3) 1회 동기화 실행');
await ta('★★ seq = 시트 실제 행 번호 (헤더 3행 → 첫 자리 4)', async () => {
  const { res, db } = await run();
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.headerRow, 3);
  const ins = db.queries.find(x => /INSERT INTO campaign_participants/.test(x.sql));
  assert.ok(ins, '슬롯 INSERT 가 안 나갔다');
  const seqs = (ins.sql.match(/\(\$1,\$2,\$3,\$4,(\d+),/g) || []).map(m => Number(m.match(/,(\d+),$/)[1]));
  assert.strictEqual(seqs[0], 4, `첫 seq=${seqs[0]} (헤더 3행 다음은 4행)`);
  assert.strictEqual(seqs[seqs.length - 1], 53, '마지막 seq 는 53(4+50-1)');
  assert.strictEqual(seqs.length, 50);
});
await ta('★ 50건 상한 — 그 아래 값 있는 줄은 자리를 만들지 않는다', async () => {
  const { res } = await run({ grid: makeGrid(50, { extraFilled: 7 }) });
  assert.strictEqual(res.preparedRows, 50, `preparedRows=${res.preparedRows}`);
  assert.strictEqual(res.beyondTotal, 7);
  assert.strictEqual(res.created, 50);
});
await ta('★ 이미 있는 자리는 건드리지 않는다', async () => {
  const { res, db } = await run({ dbOpts: { existing: [4, 5, 6] } });
  assert.strictEqual(res.missing, 47, `missing=${res.missing}`);
  const ins = db.queries.find(x => /INSERT INTO campaign_participants/.test(x.sql));
  const seqs = (ins.sql.match(/\(\$1,\$2,\$3,\$4,(\d+),/g) || []).map(m => Number(m.match(/,(\d+),$/)[1]));
  assert.ok(!seqs.includes(4) && !seqs.includes(5), '기존 자리를 다시 만들었다');
});
await ta('★★ 추가만 — INSERT 는 ON CONFLICT DO NOTHING(기존 행 무손상)', async () => {
  const { db } = await run();
  const ins = db.queries.find(x => /INSERT INTO campaign_participants/.test(x.sql));
  assert.ok(/ON CONFLICT \(sheet_id, tab_name, seq\) DO NOTHING/.test(ins.sql), 'DO NOTHING 이 아니다');
});
await ta('★★ campaign_participants 에 UPDATE·DELETE 0 (제출·입금 표시 무접촉)', async () => {
  const { db } = await run();
  const bad = db.queries.filter(x => /(UPDATE|DELETE)[\s\S]*campaign_participants/i.test(x.sql));
  assert.strictEqual(bad.length, 0, `파괴 쿼리 ${bad.length}건`);
});
await ta('★ 장부 재생성은 무시트 탭에서만', async () => {
  const a = await run();
  assert.strictEqual(a.calls.rebuild.length, 1, '무시트인데 장부 재생성 안 함');
  const b = await run({ dbOpts: { tab: { tabName: 'T', campaignName: 'C', sheetless: false } } });
  assert.strictEqual(b.calls.rebuild.length, 0, '시트 기반 탭에 장부를 다시 만들었다');
  assert.strictEqual(b.res.ledger, 'skipped_not_sheetless');
});
await ta('★ 장부 재생성 실패해도 자리는 유지·가드는 기록(되돌리지 않는다)', async () => {
  const { res, db } = await run({ deps: { rebuildLedgers: async () => { throw new Error('boom'); } } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.created, 50);
  assert.ok(/failed: boom/.test(res.ledger));
  assert.ok(db.queries.some(x => /INSERT INTO app_settings/.test(x.sql)), '가드 미기록');
});

// ── 4. 가드 ───────────────────────────────────────────────────────────────
console.log('\n4) 1회성 가드');
await ta('★★ 이미 했으면 시트를 다시 읽지 않는다', async () => {
  const { res, calls, db } = await run({ dbOpts: { guard: true } });
  assert.strictEqual(res.reason, 'already_done');
  assert.strictEqual(calls.readSheet.length, 0, '가드가 있는데 시트를 읽었다');
  assert.strictEqual(db.queries.length, 1, '가드 조회 외 쿼리가 나갔다');
});
await ta('★ force = 가드 무시하고 재실행', async () => {
  const { res, calls } = await run({ dbOpts: { guard: true }, args: { force: true } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(calls.readSheet.length, 1);
});
await ta('★★ 실패하면 가드를 남기지 않는다(다음 부팅에 재시도)', async () => {
  const cases = [
    { name: '탭 미등록', opts: { dbOpts: { tab: null } }, reason: 'tab_not_registered' },
    { name: '시트 읽기 실패', opts: { deps: { readSheet: async () => { throw new Error('x'); } } }, reason: 'sheet_read_failed' },
    { name: '빈 시트', opts: { grid: [] }, reason: 'sheet_empty' },
    { name: '헤더 인식 불가', opts: { grid: [['메모'], ['a'], ['b']] }, reason: 'header_unrecognizable' },
    { name: '준비 행 0', opts: { grid: makeGrid(0) }, reason: 'no_prepared_rows' },
  ];
  for (const c of cases) {
    const { res, db } = await run(c.opts);
    assert.strictEqual(res.ok, false, `${c.name}: ok=true 로 끝났다`);
    assert.strictEqual(res.reason, c.reason, `${c.name}: reason=${res.reason}`);
    assert.ok(!db.queries.some(x => /INSERT INTO app_settings/.test(x.sql)), `${c.name}: 실패인데 가드를 남겼다`);
    assert.ok(!db.queries.some(x => /INSERT INTO campaign_participants/.test(x.sql)), `${c.name}: 실패인데 자리를 만들었다`);
  }
});
await ta('★ dryRun = 쓰기 0(만들 자리 수만 계산)', async () => {
  const { res, db } = await run({ args: { dryRun: true } });
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.missing, 50);
  const writes = db.queries.filter(x => /^\s*(INSERT|UPDATE|DELETE)/i.test(x.sql));
  assert.strictEqual(writes.length, 0, `dryRun 인데 쓰기 ${writes.length}건`);
});
await ta('★ 킬스위치 BLOG_0804_BACKFILL=0', async () => {
  process.env.BLOG_0804_BACKFILL = '0';
  try {
    const { res, db } = await run();
    assert.strictEqual(res.reason, 'disabled');
    assert.strictEqual(db.queries.length, 0, '꺼졌는데 쿼리가 나갔다');
  } finally { delete process.env.BLOG_0804_BACKFILL; }
});

// ── 5. 분류 (blank-only) ──────────────────────────────────────────────────
console.log('\n5) blog 분류 — blank-only');
await ta('★★ 이미 값이 있으면 덮지 않는다(COALESCE 가드가 SQL 에 있다)', async () => {
  const { db } = await run();
  const tu = db.queries.find(x => /UPDATE tab_configs SET work_kind/.test(x.sql));
  const ou = db.queries.find(x => /UPDATE work_orders SET work_kind/.test(x.sql));
  assert.ok(tu && /COALESCE\(work_kind, ''\) = ''/.test(tu.sql), '탭 분류가 blank-only 가 아니다');
  assert.ok(ou && /COALESCE\(work_kind, ''\) = ''/.test(ou.sql), '오더 분류가 blank-only 가 아니다');
});
await ta('★ 작업오더가 없으면 탭만 분류하고 넘어간다', async () => {
  const { res, db } = await run({ dbOpts: { workOrder: null } });
  assert.strictEqual(res.tabClassified, true);
  assert.strictEqual(res.orderClassified, false);
  assert.ok(!db.queries.some(x => /UPDATE work_orders SET work_kind/.test(x.sql)));
});
await ta('★ 분류 실패해도 자리 생성은 되돌리지 않는다', async () => {
  const base = makeDb();
  const db = {
    queries: base.queries,
    async query(sql, params) {
      if (/UPDATE tab_configs SET work_kind/.test(String(sql))) { base.queries.push({ sql, params }); throw new Error('nope'); }
      return base.query(sql, params);
    },
  };
  const { res } = await run({ db });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.created, 50);
  assert.ok(/nope/.test(res.classifyError || ''), 'classifyError 미보고');
});

// ── 6. 시트 무접촉 · lane ─────────────────────────────────────────────────
console.log('\n6) 시트 쓰기 0 · 저우선 lane');
t('★★ 시트 쓰기 API 호출 0 (읽기 1회뿐)', () => {
  assert.ok(!/writeSheet|appendSheet|batchUpdate|clearSheetValues|insertDimension/.test(code),
    '시트 쓰기 호출이 들어왔다');
});
await ta('★ 시트 읽기는 정확히 1회 · gid 우선 · FORMATTED_VALUE', async () => {
  const { calls } = await run();
  assert.strictEqual(calls.readSheet.length, 1, `읽기 ${calls.readSheet.length}회`);
  const [, , opts] = calls.readSheet[0];
  assert.strictEqual(opts.gid, svc.TARGET.tabGid);
  assert.strictEqual(opts.valueRenderOption, 'FORMATTED_VALUE');
});
await ta('★ throttle 저우선 lane(주문 쓰기 슬롯 무접촉)', async () => {
  const { calls } = await run();
  assert.strictEqual(calls.throttle.length, 1);
  assert.strictEqual(calls.throttle[0].opts && calls.throttle[0].opts.priority, 'low');
});

// ── 7. 부팅 배선 ──────────────────────────────────────────────────────────
console.log('\n7) 부팅 배선');
const boot = noLineComments(indexSrc);
t('★ index.js 가 1회성 잡을 호출한다', () => {
  assert.ok(/runBlog0804Backfill\(\)/.test(boot), '부팅에서 호출 안 함');
  assert.ok(/blog0804Backfill\.service/.test(boot));
});
t('★ production 에서만 · 실패해도 부팅은 계속(try/catch)', () => {
  const i = boot.indexOf('runBlog0804Backfill');
  const block = boot.slice(Math.max(0, i - 700), i + 700);
  assert.ok(/NODE_ENV === 'production'/.test(block), 'production 게이트 없음');
  assert.ok(/catch\s*\(/.test(block), 'try/catch 없음 — 부팅이 죽을 수 있다');
});
t('★ already_done 은 조용히(평상시 로그 소음 0)', () => {
  assert.ok(/already_done/.test(boot));
});

// ── 8. 소스 위생 ──────────────────────────────────────────────────────────
console.log('\n8) 소스 위생');
t('★ 리터럴 NUL 없음(git 이 바이너리로 취급하면 grep 가드가 무력화된다)', () => {
  assert.strictEqual(fs.readFileSync(svcPath).indexOf(0), -1, 'NUL 발견');
});
t('★ 대상은 PRD 에 못박힌 그 작업 하나(범용 도구 아님)', () => {
  assert.strictEqual(svc.TARGET.sheetId, '1kLjLprT55A60Npz6gLtx6BeF8KrddsMEin-9jFt_tp8');
  assert.strictEqual(svc.TARGET.tabGid, '545717806');
  assert.strictEqual(svc.TARGET.rows, 50);
});
t('★ 가드 키 고정', () => assert.strictEqual(svc.GUARD_KEY, 'blog_0804_slot_backfill_done'));
t('★ 신규 라우트·화면 0 (전용기능 없이 그 작업만 — 사용자 확정)', () => {
  const routes = fs.readdirSync(path.join(SRC, 'routes'));
  const hit = routes.filter(f => /blog0804|blog_0804/i.test(fs.readFileSync(path.join(SRC, 'routes', f), 'utf8')));
  assert.strictEqual(hit.length, 0, `라우트에 노출됨: ${hit.join(', ')}`);
});

console.log(`\n${fail ? '❌' : '✅'} 블로그체험단 M3 회귀가드 — 통과 ${pass} · 실패 ${fail}\n`);
process.exit(fail ? 1 : 0);
})();
