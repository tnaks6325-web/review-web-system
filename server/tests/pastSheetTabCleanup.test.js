'use strict';
/**
 * pastSheetTabCleanup.test.js — 과거 탭 정리 회귀가드
 * 실행: node tests/pastSheetTabCleanup.test.js
 *
 * 고정하는 것:
 *  ① 판정 사본 0 — "과거인가"는 utils/tabActivity 한 곳이 정한다(자체 날짜 규칙 금지)
 *  ② 쓰기 표면 = tab_configs.is_closed 한 칸뿐(장부·주문·공고·시트 무접촉)
 *  ③ fail-closed 제외 6갈래 — 모르면 닫지 않는다
 *  ④ 화면이 보낸 목록을 믿지 않는다(서버가 후보 판정을 다시 계산)
 *  ⑤ 미리보기가 기본 — 값이 빠진 요청이 곧바로 닫으면 안 된다
 *  ⑥ 게이트는 이관과 같은 adminOrMaster
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripLine = s => s.replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

const svc = require('../src/services/pastSheetTabCleanup.service');
const SRC = stripLine(R('server/src/services/pastSheetTabCleanup.service.js'));

console.log('\n▶ 과거 탭 시트 읽기 정리 회귀가드\n');

/* ── 1) 판정 사본 0 ─────────────────────────────────────── */
t('1a: 과거 판정은 tabActivity 를 그대로 쓴다(자체 SQL 조각·날짜 규칙 금지)', () => {
  assert.ok(/require\('\.\.\/utils\/tabActivity'\)/.test(SRC), 'tabActivity 사용');
  assert.ok(/ACTIVITY_LATERAL_SQL/.test(SRC) && /resolveActivity/.test(SRC), '조각·판정 함수 재사용');
  // 자체로 연도를 파싱하거나 컷오프를 새로 만들면 두 화면의 "과거"가 갈린다
  assert.ok(!/parseDateToken|koreanDate/.test(SRC), '자체 날짜 파싱 금지');
  assert.ok(!/2026-01-01/.test(SRC), '컷오프 기본값 사본 금지(normalizeSince 가 정한다)');
});

/* ── 2) 쓰기 표면 ───────────────────────────────────────── */
t('2a: 쓰기는 tab_configs.is_closed 두 문장뿐 — 다른 테이블 UPDATE/DELETE/INSERT 0', () => {
  const writes = SRC.match(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+([a-z_]+)/gi) || [];
  const tables = writes.map(w => w.split(/\s+/).pop().toLowerCase());
  assert.deepEqual([...new Set(tables)], ['tab_configs'],
    '쓰기 대상 테이블 (받음 ' + JSON.stringify([...new Set(tables)]) + ')');
  const sets = SRC.match(/SET\s+([a-z_]+)\s*=/gi) || [];
  assert.deepEqual([...new Set(sets.map(x => x.replace(/SET\s+/i, '').replace(/\s*=/, '')))], ['is_closed'],
    'SET 대상은 is_closed 뿐');
});
t('2b: 구글 시트·드라이브 API 무접촉(정리가 시트를 건드리면 안 된다)', () => {
  // ★ 주석에도 'Drive' 가 나오므로 **호출 형태**로 본다(낱말 검사는 설명문에 걸린다)
  assert.ok(!/require\('[^']*(sheets|drive)\.service'\)/i.test(SRC), '시트/드라이브 서비스 require 금지');
  assert.ok(!/\b(readSheet|writeSheet|appendSheet|batchUpdateSheet|batchReadSheet|throttledCall|driveThrottledCall)\s*\(/.test(SRC),
    '시트/드라이브 API 호출 금지');
});

/* ── 3) 판정 갈래(순수함수 실행) ────────────────────────── */
const SINCE = '2026-01-01';
const base = { sheetId: 's', tabName: 'T', tabGid: '1' };
const cls = (o) => svc.classifyPastTab({ ...base, ...o }, SINCE);
t('3a: 이미 안 읽는 탭은 후보가 아니고 reads=false', () => {
  assert.deepEqual(
    ['sheetless', 'isArchived', 'isClosed'].map(k => { const r = cls({ [k]: true, sampleStartDate: '24.5.1' }); return [r.reads, r.candidate, r.reason]; }),
    [[false, false, 'already_sheetless'], [false, false, 'already_archived'], [false, false, 'already_closed']]);
});
t('3b: 컷오프 이후 활동은 현재 작업 — 닫지 않는다', () => {
  const r = cls({ sampleStartDate: '26.8.1' });
  assert.equal(r.reads, true); assert.equal(r.candidate, false); assert.equal(r.reason, 'recent');
});
t('3c: 연도를 모르면 닫지 않는다', () => {
  const r = cls({});
  assert.equal(r.candidate, false); assert.equal(r.reason, 'year_unknown');
});
t('3d: 근거가 시트 등록일뿐이면 닫지 않는다(등록일 ≠ 진행 시기)', () => {
  const r = cls({ registeredAt: '2024-03-01' });
  assert.equal(r.candidate, false); assert.equal(r.reason, 'weak_signal');
  // ★ 완화 금지: 2024 에 만든 시트를 2026 에 재사용하고 구매일에 연도를 안 적으면
  //   지금 돌아가는 작업이 "2024 활동"으로 찍힌다 — 그걸 닫으면 라이브 작업이 멈춘다.
});
t('3e: 미반영 주문·활성 공고가 있으면 닫지 않는다', () => {
  assert.equal(cls({ sampleStartDate: '24.5.1', pendingOrders: 1 }).reason, 'pending_orders');
  assert.equal(cls({ sampleStartDate: '24.5.1', activeCampaigns: 1 }).reason, 'active_campaign');
});
t('3f: 강한 신호로 과거가 확인되면 후보', () => {
  assert.equal(cls({ sampleStartDate: '24.5.1' }).reason, 'past');
  assert.equal(cls({ lastOrderAt: '2024-06-02' }).reason, 'past');
  assert.equal(cls({ sampleStartDate: '24.5.1' }).candidate, true);
});

/* ── 4) 서비스 실행(스텁 pool) ──────────────────────────── */
function stubPool(rows, { onUpdate } = {}) {
  const q = []; let connects = 0;
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(s)) return { rows: [] };
      if (/UPDATE tab_configs/.test(s)) { if (onUpdate) onUpdate(params); return { rowCount: 1, rows: [] }; }
      return { rows: [] };
    },
    release() {},
  };
  return {
    q, get connects() { return connects; },
    async connect() { connects++; return client; },
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/FROM tab_configs tc/.test(s)) return { rows };
      return { rows: [] };
    },
  };
}
const ROWS = [
  { sheetId: 's', tabName: '과거A', tabGid: '1', sampleStartDate: '24.5.1' },
  { sheetId: 's', tabName: '과거B', tabGid: '2', sampleStartDate: '24.6.1' },
  { sheetId: 's', tabName: '최근', tabGid: '3', sampleStartDate: '26.8.1' },
  { sheetId: 's', tabName: '이미마감', tabGid: '4', sampleStartDate: '24.5.1', isClosed: true },
];

(async () => {
  const p1 = stubPool(ROWS);
  svc.__setPoolForTest(p1);
  const scan = await svc.scanPastSheetTabs({ since: SINCE });
  t('4a: 스캔은 읽기 전용 — 커넥션도 잡지 않고 쓰기 쿼리 0', () => {
    assert.equal(scan.candidates, 2);
    assert.equal(scan.stillReading, 3);
    assert.equal(scan.alreadyQuiet, 1, '이미 조용한 탭 건수를 말한다');
    assert.equal(p1.connects, 0, '읽기에 커넥션 불필요');
    // ★ `deleted_at IS NULL` 이 /DELETE/i 에 걸린다 — **문장 형태**로 본다(낱말 검사 금지)
    assert.ok(!p1.q.some(x => /\b(UPDATE\s+\w|INSERT\s+INTO|DELETE\s+FROM)/i.test(x.s)), '쓰기 쿼리 0');
  });
  t('4b: 후보가 아닌 사유를 건수로 말한다(조용한 누락 금지)', () => {
    assert.equal(scan.heldBy.recent, 1);
    assert.equal(scan.quietBy.already_closed, 1);
  });

  const p2 = stubPool(ROWS);
  svc.__setPoolForTest(p2);
  const dry = await svc.closePastTabs({ tabs: [{ sheetId: 's', tabName: '과거A' }] });
  t('5a: 기본은 미리보기 — 쓰기 0', () => {
    assert.equal(dry.dryRun, true); assert.equal(dry.wouldClose, 1);
    assert.ok(!p2.q.some(x => /\bUPDATE\s+\w/i.test(x.s)), '미리보기는 쓰지 않는다');
  });

  const seen = [];
  const p3 = stubPool(ROWS, { onUpdate: prm => seen.push(prm) });
  svc.__setPoolForTest(p3);
  const run = await svc.closePastTabs({
    tabs: [{ sheetId: 's', tabName: '과거A' }, { sheetId: 's', tabName: '최근' },
           { sheetId: 's', tabName: '없는탭' }, { sheetId: '', tabName: '' }],
    dryRun: false });
  t('5b: 화면이 보낸 목록을 믿지 않는다 — 서버가 후보를 다시 계산해 거른다', () => {
    assert.equal(run.closed, 1, '후보 1개만 닫힘 (받음 ' + run.closed + ')');
    assert.equal(seen.length, 1, 'UPDATE 도 1회');
    assert.deepEqual(seen[0], ['s', '과거A']);
    assert.equal(run.refused.length, 3);
    assert.deepEqual(run.refused.map(r => r.reason), ['not_candidate', 'not_candidate', 'bad_key']);
  });
  t('5c: 스캔을 다시 돌려 판정한다(낡은 화면 방어)', () => {
    assert.ok(p3.q.filter(x => /FROM tab_configs tc/.test(x.s)).length >= 1, '실행 시점 재조회');
  });

  t('5d: 상한·빈 목록은 거부(쓰기 0)', async () => {});
  const p4 = stubPool(ROWS);
  svc.__setPoolForTest(p4);
  let e1 = null, e2 = null;
  try { await svc.closePastTabs({ tabs: [] }); } catch (e) { e1 = e; }
  try { await svc.closePastTabs({ tabs: Array.from({ length: svc.CLOSE_CAP + 1 }, () => ({ sheetId: 's', tabName: 'x' })) }); } catch (e) { e2 = e; }
  t('5e: 빈 목록·상한 초과 거부', () => {
    assert.equal(e1 && e1.code, 'tabs_required');
    assert.equal(e2 && e2.code, 'too_many_tabs');
    assert.ok(!p4.q.some(x => /\bUPDATE\s+\w/i.test(x.s)), '쓰기 0');
  });

  const p5 = stubPool(ROWS, { onUpdate: () => {} });
  svc.__setPoolForTest(p5);
  const back = await svc.reopenTabs({ tabs: [{ sheetId: 's', tabName: '아무거나' }] });
  t('6a: 되돌리기는 후보 판정을 요구하지 않는다(비상구를 잠그지 않는다)', () => {
    assert.equal(back.reopened, 1);
    assert.ok(p5.q.some(x => /SET is_closed = FALSE/i.test(x.s)), 'is_closed=FALSE');
    assert.ok(!p5.q.some(x => /FROM tab_configs tc/.test(x.s)), '되돌리기에 스캔 불필요');
  });

  /* ── 7) 라우트 ────────────────────────────────────────── */
  const RT = stripLine(R('server/src/routes/trackB.routes.js'));
  t('7a: 세 라우트가 adminOrMaster 게이트로 등록된다(이관과 같은 급)', () => {
    const router = require('../src/routes/trackB.routes');
    for (const [m, p] of [['get', '/past-tabs/scan'], ['post', '/past-tabs/close'], ['post', '/past-tabs/reopen']]) {
      assert.ok((router.stack || []).some(l => l.route && l.route.path === p && l.route.methods[m]), p + ' 등록');
      const i = RT.indexOf(`router.${m}('${p}'`);
      assert.ok(i > 0);
      assert.ok(/authMiddleware,\s*adminOrMasterMiddleware/.test(RT.slice(i, i + 160)), p + ' 게이트');
    }
  });
  t('7b: 라우트도 미리보기가 기본 — dryRun 을 안 보내면 닫지 않는다', () => {
    const i = RT.indexOf("router.post('/past-tabs/close'");
    const body = RT.slice(i, RT.indexOf('router.', i + 10));
    assert.ok(/dryRun:\s*dryRun\s*!==\s*false/.test(body),
      'dryRun 미전송이 실행으로 떨어지면 안 된다 (받음: ' + (body.match(/dryRun[^,)]*/g) || []).join(' | ') + ')');
  });
  t('7c: 마이그레이션 미적용은 503 not_ready(500 마스킹 금지)', () => {
    assert.ok(/'not_ready'\s*\?\s*503/.test(RT.replace(/\s+/g, ' ')), 'not_ready → 503');
    assert.ok(/42P01/.test(SRC) && /not_ready/.test(SRC), '서비스가 42P01 을 not_ready 로');
  });

  /* ── 8) 화면 ──────────────────────────────────────────── */
  const FE = R('frontend/workdesk.html');
  t('8a: 전환 화면에 정리 창구가 있고 서버 응답만 그린다(판정 사본 0)', () => {
    assert.ok(/onclick="_ptScan\(\)"/.test(FE), '진입 버튼');
    assert.ok(/id="ptBox"/.test(FE), '마운트 지점');
    const i = FE.indexOf('function _ptRender');
    const body = FE.slice(i, FE.indexOf('function _ptPicked'));
    // 화면이 과거를 다시 판정하면 서버와 갈린다 — 날짜 비교·컷오프가 있으면 안 된다
    assert.ok(!/new Date\(|20\d\d-\d\d-\d\d/.test(body), '화면 자체 날짜 판정 금지');
    assert.ok(/r\.candidates/.test(body) && /r\.stillReading/.test(body), '서버 집계를 그대로 표기');
  });
  t('8b: 실행은 미리보기 → confirm 2단계 · 되돌릴 수 있다고 말한다', () => {
    const i = FE.indexOf('async function _ptClose');
    const body = FE.slice(i, FE.indexOf('\n}', FE.indexOf('catch(e)', i)));
    const pre = body.indexOf("body:JSON.stringify({tabs:picked})");
    const cfm = body.indexOf('confirm(');
    const run = body.indexOf('dryRun:false');
    assert.ok(pre > 0 && cfm > pre && run > cfm, '미리보기 → confirm → 실행 순서');
    assert.ok(/되돌리려면/.test(body), '되돌릴 수 있음을 문장으로 말한다');
    assert.ok(/데이터는 지우지 않습니다/.test(body), '무엇을 바꾸는지 말한다');
  });
  t('8c: 실패는 자리표시자를 남기지 않는다(무한 로딩 금지)', () => {
    const i = FE.indexOf('async function _ptScan');
    const body = FE.slice(i, FE.indexOf('function _ptRender'));
    assert.ok(/catch\s*\(e\)\s*\{[\s\S]{0,400}다시 시도/.test(body), '예외 시 사유 + 다시 시도');
  });

  console.log('\n✅ 통과 ' + pass + '건\n');
  process.exit(0);
})();
