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

t('1b: 소스에 리터럴 NUL 금지 — git 이 바이너리로 취급하면 grep 가드가 통째로 죽는다', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'server/src/services/pastSheetTabCleanup.service.js'));
  assert.equal(raw.indexOf(0), -1, '리터럴 NUL 발견 — 이스케이프 표기(KEY_SEP)를 쓸 것');
  assert.ok(/const KEY_SEP = '\\u0000'/.test(SRC), '복합키 구분자는 이스케이프 표기로');
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
  // 이름이 바뀐 뒤 보관 기록이 옛 이름으로만 남은 탭 — smartBuild 는 새 이름으로 계속 읽는다
  { sheetId: 's', tabName: '리네임후', tabGid: '5', sampleStartDate: '24.5.1', archivedGidOnly: true },
  // 마감인데 보관 기록만 옛 이름 — 읽히지 않으므로 gid-only 건수에 **세면 안 된다**
  { sheetId: 's', tabName: '마감_gid만', tabGid: '6', sampleStartDate: '24.5.1',
    archivedGidOnly: true, isClosed: true },
];

(async () => {
  const p1 = stubPool(ROWS);
  svc.__setPoolForTest(p1);
  const scan = await svc.scanPastSheetTabs({ since: SINCE });
  t('4a: 스캔은 읽기 전용 — 커넥션도 잡지 않고 쓰기 쿼리 0', () => {
    assert.equal(scan.candidates, 3);
    assert.equal(scan.stillReading, 4);
    assert.equal(scan.alreadyQuiet, 2, '이미 조용한 탭 건수를 말한다');
    assert.equal(p1.connects, 0, '읽기에 커넥션 불필요');
    // ★ `deleted_at IS NULL` 이 /DELETE/i 에 걸린다 — **문장 형태**로 본다(낱말 검사 금지)
    assert.ok(!p1.q.some(x => /\b(UPDATE\s+\w|INSERT\s+INTO|DELETE\s+FROM)/i.test(x.s)), '쓰기 쿼리 0');
  });
  t('4b: 후보가 아닌 사유를 건수로 말한다(조용한 누락 금지)', () => {
    assert.equal(scan.heldBy.recent, 1);
    assert.equal(scan.quietBy.already_closed, 2);
  });
  t('4c: 리네임 탭 건수를 응답이 실제로 싣는다(문자열 존재가 아니라 실행으로)', () => {
    // ★ SRC 에 이름이 있는지만 보면 **주석**이 대신 통과시킨다(변이시험 실측)
    assert.equal(scan.archivedByGidOnly, 1, '받음 ' + scan.archivedByGidOnly);
    // ★★ 안 읽히는 탭까지 세면 "여전히 읽습니다"가 거짓이 된다(2026-08-19 실측 6개)
    assert.ok(!scan.items.some(i => !i.reads), '후보는 전부 읽히는 탭');
    assert.ok(scan.items.some(i => i.tabName === '리네임후'), '아카이브로 접지 않고 후보로');
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
    // ★ `confirm(` 만 찾으면 `if(false&&confirm(` 도 통과한다(변이시험 실측) — **막는 형태**를 본다
    const cfm = body.indexOf('if(!confirm(');
    const run = body.indexOf('dryRun:false');
    assert.ok(pre > 0, '미리보기 요청');
    assert.ok(cfm > pre, '확인창이 미리보기 뒤 (받음 ' + cfm + ')');
    assert.ok(run > cfm, '실행은 확인창 뒤');
    assert.ok(/if\(!confirm\([\s\S]{0,600}\)\) return;/.test(body), '확인하지 않으면 실행하지 않는다');
    assert.ok(/되돌리려면/.test(body), '되돌리는 길을 문장으로 말한다');
    // ★★ `is_closed` 는 표시가 아니라 **마감(아카이브) 예약**이다 — 다음 전체 빌드가
    //   장부를 보관함으로 옮기고 tab_configs 행까지 지운다. 그래서 확인창은
    //   "한 칸만 바꾼다 / 데이터는 안 지운다"로 줄여 말하면 **거짓**이 된다.
    assert.ok(!/데이터는 지우지 않습니다/.test(body),
      '축소된 안내 부활 금지 — 실제로는 아카이브되고 목록에서 사라진다');
    assert.ok(/아카이브/.test(body), '아카이브된다고 말한다');
    assert.ok(/리뷰어의 제출완료 내역/.test(body), '리뷰어 화면에서 사라지는 것까지 말한다');
  });
  t('8b-2: 안내 문구에도 축소된 표현이 없다(렌더 본문)', () => {
    const i = FE.indexOf('function _ptRender');
    const body = FE.slice(i, FE.indexOf('function _ptPicked'));
    assert.ok(!/데이터는 지우지 않습니다/.test(body), '렌더 안내도 축소 금지');
    assert.ok(/아카이브/.test(body) && /제출완료 내역/.test(body), '결과를 사실대로');
  });
  t('8c: 실패는 자리표시자를 남기지 않는다(무한 로딩 금지)', () => {
    const i = FE.indexOf('async function _ptScan');
    const body = FE.slice(i, FE.indexOf('function _ptRender'));
    assert.ok(/catch\s*\(e\)\s*\{[\s\S]{0,400}다시 시도/.test(body), '예외 시 사유 + 다시 시도');
  });

  /* ── 3g) 이름 어긋남 = 마감·아카이브 스킵이 빗나간다 ────── */
  t('3g: 시트 탭 이름이 바뀌면 마감·아카이브여도 읽힌다(마감으로 못 멈춘다)', () => {
    // smartBuild 의 tcMap/archivedSet 은 둘 다 sheet_id||tab_name 키다(gid 미참조)
    const IB = R('server/src/services/indexBuilder.service.js');
    assert.ok(/tcMap\[`\$\{r\.sheet_id\}\|\|\$\{r\.tab_name\}`\]/.test(IB), 'tcMap 키 = 이름');
    assert.ok(/const key = `\$\{sheetId\}\|\|\$\{t\.properties\.title\}`/.test(IB),
      '조회는 **시트의 현재 탭 이름**으로 한다 = 등록명이 다르면 빗나간다');
    for (const flag of ['isClosed', 'isArchived']) {
      const r = cls({ [flag]: true, liveTabName: '바뀐이름', sampleStartDate: '24.5.1' });
      assert.equal(r.reads, true, flag + ': 여전히 읽힌다');
      assert.equal(r.reason, 'name_drift');
      assert.equal(r.candidate, false, '★ 마감해도 안 멈추므로 후보로 올리지 않는다(죽은 조작 금지)');
    }
    // 이름이 같으면 종전대로 조용하다(무회귀)
    assert.equal(cls({ isClosed: true, liveTabName: 'T' }).reason, 'already_closed');
    // 무시트는 gid 폴백이 있어(sheetlessScope) 이름이 바뀌어도 유효
    assert.equal(cls({ sheetless: true, liveTabName: '바뀐이름' }).reason, 'already_sheetless');
  });

  /* ── 8d) 아카이브 판정 = smartBuild 와 같은 규칙 ─────────
   *  이 판정은 "그 탭이 무엇인가"가 아니라 **"저쪽(smartBuild)이 읽는가"** 다.
   *  더 넓게 잡으면(gid 폴백) 이름이 바뀐 탭이 "이미 안 읽음"으로 접혀 **정리 대상이 사라진다**
   *  (2026-08-19 실측 「826개 중 0개」 보고로 발견). */
  t('8d: 아카이브 판정은 이름만 본다 — indexBuilder 의 스킵 키와 같다', () => {
    const IB = R('server/src/services/indexBuilder.service.js');
    assert.ok(/archivedSet\.add\(`\$\{r\.sheet_id\}\|\|\$\{r\.tab_name\}`\)/.test(IB),
      'smartBuild 스킵 키 = sheet_id||tab_name (규칙이 바뀌면 이 가드가 먼저 깨진다)');
    // ★ 슬라이스를 넓게 잡으면 무관한 tab_gid 가 섞인다 — **아카이브 집합을 만드는 구간만** 본다
    const seg0 = IB.slice(IB.indexOf('const { rows: archivedRows }'), IB.indexOf('archivedSheetCounts[r.sheet_id]'));
    assert.ok(!/tab_gid/.test(seg0), 'smartBuild 는 아카이브 판정에 gid 를 안 본다');
    assert.ok(/archivedSet\.has\(key\)/.test(IB), '스킵도 그 키로만');
    const seg = SRC.slice(SRC.indexOf('AS "isArchived"'), SRC.indexOf(') arch ON TRUE'));
    assert.ok(/ima\.tab_name = tc\.tab_name/.test(seg), '이름 일치');
    assert.ok(!/tab_gid/.test(seg), '★ gid 폴백 부활 금지 — 정리 대상이 조용히 사라진다');
  });
  t('8e: 이름이 바뀐 탭은 아카이브로 접지 않고 정상 판정에 태운다 + 건수를 말한다', () => {
    const c = cls({ tabName:'새이름', tabGid:'7', archivedGidOnly:true, sampleStartDate:'24.5.10' });
    assert.equal(c.reads, true, '읽힌다고 봐야 한다');
    assert.equal(c.reason, 'past', '정상 판정을 거쳐 후보가 된다');
    assert.equal(c.archivedGidOnly, true, '표식을 실어 건수로 말할 수 있게');
    assert.ok(/archivedByGidOnly/.test(SRC), '스캔 응답에 건수 동봉(조용한 변화 금지)');
  });

  t('8f: 이름 어긋난 탭을 목록으로 보여준다(건수만으로는 고칠 수 없다)', () => {
    assert.ok(/function _ptDriftBlock/.test(FE), '목록 렌더러');
    const rd = FE.slice(FE.indexOf('function _ptRender'), FE.indexOf('function _ptPicked'));
    assert.ok(/\$\{_ptDriftBlock\(r\)\}/.test(rd), '렌더가 실제로 그린다');
    const b = FE.slice(FE.indexOf('function _ptDriftBlock'), FE.indexOf('function _ptRender'));
    assert.ok(/reason\s*===\s*'name_drift'/.test(b), '서버가 준 사유로 고른다(판정 사본 0)');
    assert.ok(/esc\(h\.tabName\)/.test(b) && /esc\(h\.liveTabName/.test(b),
      '★ 탭명은 시트발 외부 문자열 — 반드시 escape');
    assert.ok(/if\(!d\.length\) return ''/.test(b), '없으면 안 그린다');
    assert.ok(/sync-tab-names/.test(b), '고칠 곳을 말한다');
    assert.ok(/index_master_archive/.test(b), '그 도구가 못 고치는 것까지 말한다(조용한 누락 금지)');
  });
  t('8f-2: 두 표 모두 시트를 함께 적는다 + 헤더 칸 수 ≡ 행 칸 수', () => {
    // ★ tab_configs 는 UNIQUE(sheet_id, tab_name) 이라 **다른 시트에 같은 탭 이름**이 있을 수 있다
    //   (시트 복사본이 흔하다) — 시트를 안 적으면 똑같아 보이는 줄이 여럿 생겨
    //   어느 것을 고르는지 알 수 없다(2026-08-19 실측 4줄). 체크박스 표에서는 오조작이 된다.
    assert.ok(/campaignName/.test(SRC), '서버가 시트명을 싣는다');
    const drift = FE.slice(FE.indexOf('function _ptDriftBlock'), FE.indexOf('function _ptRender'));
    const rend = FE.slice(FE.indexOf('function _ptRender'), FE.indexOf('function _ptPicked'));
    for (const [name, body] of [['drift', drift], ['candidates', rend]]) {
      assert.ok(/esc\((h|it)\.campaignName/.test(body), name + ': 시트를 그린다(escape)');
      const th = (body.match(/<th[ >]/g) || []).length;
      const td = (body.match(/<td[ >]/g) || []).length;
      assert.equal(th, td, name + ': 헤더 칸 수 ≡ 행 칸 수 (th ' + th + ' / td ' + td + ')');
    }
  });
  t('8g: 「정리 대상에 포함」이라고 말하지 않는다(후보가 0일 수 있다)', () => {
    const rd = FE.slice(FE.indexOf('function _ptRender'), FE.indexOf('function _ptPicked'));
    const i = rd.indexOf('archivedByGidOnly');
    assert.ok(i > 0);
    assert.ok(!/정리 대상에 포함/.test(rd.slice(i, i + 220)),
      '읽히지만 후보가 아닌 탭이 있으므로 "포함"은 거짓이 될 수 있다(2026-08-19 실측)');
  });

  /* ── 9) 연도 확인 먼저 (사용자 확정 2026-08-19) ─────────
   *  시트 표기에 연도가 없으면(`7 / 12 (금)`) 판정이 시트 등록일로 폴백해
   *  `weak_signal` 이 되어 **정리 대상에서 빠진다**. 그래서 연도 확인이 먼저다. */
  t('9a: 연도 미확정 건수를 세어 확인 창구를 띄운다', () => {
    assert.ok(/function _ptUnconfirmed/.test(FE), '미확정 건수 계산');
    const i = FE.indexOf('function _ptUnconfirmed');
    const body = FE.slice(i, FE.indexOf('function _ptProbeBlock'));
    assert.ok(/year_unknown/.test(body) && /weak_signal/.test(body),
      '두 사유 모두 — weak_signal 을 빼면 연도 없는 표기가 통째로 누락된다');
    // ★ 파일 전체로 보면 **함수 선언**(`function _ptProbeBlock(r){`)이 대신 통과시킨다
    //   (변이시험 실측) — 렌더 본문 안에서 호출되는지를 본다
    const rd = FE.slice(FE.indexOf('function _ptRender'), FE.indexOf('function _ptPicked'));
    assert.ok(/\$\{_ptProbeBlock\(r\)\}/.test(rd), '렌더가 확인 블록을 그린다');
    const rb = FE.slice(FE.indexOf('function _ptProbeBlock'), FE.indexOf('async function _ptProbe'));
    assert.ok(/if\(!n\) return ''/.test(rb), '확정할 것이 없으면 안 띄운다');
  });
  t('9b: 확인은 기존 year-probe 를 쓰고(신규 엔드포인트 0) 끝나면 다시 판정한다', () => {
    const i = FE.indexOf('async function _ptProbe');
    const body = FE.slice(i, FE.indexOf('function _ptRender'));
    assert.ok(/sheet-sync\/year-probe/.test(body), '기존 엔드포인트 재사용');
    assert.ok(/while\s*\(\s*round\s*<\s*\d+\s*\)/.test(body), '무한 루프 금지(상한)');
    assert.ok(/!r\.probed\s*\|\|\s*!r\.remaining/.test(body), '남은 것이 없으면 멈춘다');
    assert.ok(body.indexOf('_ptScan()') > body.indexOf('year-probe'),
      '확인 뒤 재판정 — 안 하면 확인해도 화면이 그대로다');
  });

  console.log('\n✅ 통과 ' + pass + '건\n');
  process.exit(0);
})();
