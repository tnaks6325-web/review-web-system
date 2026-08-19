#!/usr/bin/env node
/**
 * 회귀가드 — 블로그체험단 M5-2: 블로거 사전등록 (작업보드 [＋ 블로거 추가])
 *
 * 고정하는 계약
 *  §1 블로그 칸 판정은 **매퍼 파생**(`blogUrlWriteColumns`) — 헤더 문자열 사본 금지
 *  §2 fail-closed 게이트(무시트 아님 · 블로그 아님 · 미등록 탭 · 열 없음 · 중복 · 값 누락)
 *  §3 쓰기 표면 = participants 한 곳(직접 INSERT 0) + 장부 재생성 · seq 재사용 금지
 *  §4 라우트: `_ensureEditScope`(광고주 차단 · staff 담당 탭) + 검증 실패 400대
 *  §5 화면: 시트 기반·리뷰 명시 작업에는 안 보임 / 미지정은 열어 둔다 · body 직속 · Esc 1회
 *  §6 소스 위생
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let fail = 0, pass = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); } }
const read = p => fs.readFileSync(p, 'utf8');

const SVC = read(path.join(ROOT, 'src', 'services', 'blogRegister.service.js'));
const ROUTES = read(path.join(ROOT, 'src', 'routes', 'trackB.routes.js'));
const PARTS = read(path.join(ROOT, 'src', 'services', 'participants.service.js'));
const HTML = read(path.join(ROOT, '..', 'frontend', 'workdesk.html'));

const ledger = require(path.join(ROOT, 'src', 'services', 'orderLedger.service.js'));
const svc = require(path.join(ROOT, 'src', 'services', 'blogRegister.service.js'));

console.log('\n=== §1 블로그 칸 = 매퍼 파생(사본 금지) ===');
ok(typeof ledger.blogUrlWriteColumns === 'function', 'blogUrlWriteColumns export');
{
  const cols = ledger.blogUrlWriteColumns(['번호', '이름', '블로그주소', '배송주소', '포스팅URL']);
  ok(cols.length === 1 && cols[0] === 2, '★ 매퍼가 실제로 쓰는 칸만(배송주소·포스팅URL 제외)');
  ok(ledger.blogUrlWriteColumns(['이름', '주소']).length === 0, '블로그 칸 없으면 빈 배열');
  ok(ledger.blogUrlWriteColumns(['blogURL']).length === 1, '영문 헤더도 매퍼 규칙 그대로');
  ok(ledger.blogUrlWriteColumns([]).length === 0, '빈 헤더 안전');
}
ok(/blogUrlWriteColumns/.test(SVC), '★ 서비스가 그 함수를 쓴다');
ok(!/includes\('블로그'\)/.test(SVC), "★ 서비스에 헤더 문자열 판정 사본이 없다");
ok(/require\('\.\.\/utils\/blogPostUrl'\)/.test(SVC), '★ 주소 형식은 utils/blogPostUrl(리뷰어 입력과 같은 규칙)');
ok(/require\('\.\.\/utils\/workKind'\)/.test(SVC), '★ 종류 판정은 utils/workKind');
ok(/require\('\.\.\/utils\/applicantColumns'\)/.test(SVC), '★ 이름·연락처 열은 utils/applicantColumns');

console.log('\n=== §2·§3 서비스 실행(스텁 pool) ===');
const HEAD = ['번호', '수취인', '연락처', '블로그주소', '결제금액'];
function makeStub(over = {}) {
  const st = {
    sheetless: true, tab: [{ tab_gid: '77', campaign_name: '캠페인', work_kind: 'blog' }],
    headers: HEAD, dup: [], maxSeq: 12, queries: [], slots: [], rebuilt: 0, ...over,
  };
  st.pool = {
    query: async (sql, params) => {
      st.queries.push(String(sql));
      if (/FROM tab_configs/.test(sql)) return { rows: st.tab };
      if (/FROM raw_sheet_tabs/.test(sql)) return { rows: st.headers ? [{ detected_headers: st.headers, headers: null }] : [] };
      if (/MAX\(seq\)/.test(sql)) return { rows: [{ m: st.maxSeq }] };
      if (/FROM campaign_participants/.test(sql)) return { rows: st.dup };
      return { rows: [] };
    },
  };
  return st;
}
function withStubs(st, fn) {
  const scope = require(path.join(ROOT, 'src', 'utils', 'sheetlessScope.js'));
  const pservice = require(path.join(ROOT, 'src', 'services', 'participants.service.js'));
  const led = require(path.join(ROOT, 'src', 'services', 'sheetlessLedger.service.js'));
  const wkc = require(path.join(ROOT, 'src', 'services', 'workKindContext.service.js'));
  const o = { s: scope.isSheetless, c: pservice.createSlotsFromSheetRows, r: led.rebuildLedgers, w: wkc.workKindForTab };
  scope.isSheetless = async () => st.sheetless;
  pservice.createSlotsFromSheetRows = async (a) => { st.slots.push(a); return { inserted: 1 }; };
  led.rebuildLedgers = async () => { st.rebuilt++; return { ok: true }; };
  wkc.workKindForTab = async () => (st.campKind === undefined ? null : st.campKind);
  svc.__setPoolForTest(st.pool);
  return Promise.resolve().then(fn).finally(() => {
    scope.isSheetless = o.s; pservice.createSlotsFromSheetRows = o.c; led.rebuildLedgers = o.r; wkc.workKindForTab = o.w;
    svc.__setPoolForTest(null);
  });
}
const GOOD = { sheetId: 'S', tabName: 'T', name: '홍길동', phone: '010-1234-5678', blogUrl: 'https://blog.naver.com/gd' };
async function expectCode(st, args, code, label) {
  await withStubs(st, async () => {
    try { await svc.registerBlogger(args); ok(false, label + ' (거부되지 않음)'); }
    catch (e) { ok(e && e.code === code, `${label} → ${code}` + (e && e.code !== code ? ` (실제 ${e && e.code})` : '')); }
  });
}

(async () => {
  // 정상 등록
  {
    const st = makeStub();
    await withStubs(st, async () => {
      const r = await svc.registerBlogger({ ...GOOD, by: '만두' });
      ok(r.ok === true && r.seq === 13, '★ seq = MAX(seq)+1 (삭제된 줄도 세어 재사용 금지)');
      ok(st.slots.length === 1, '★ 줄 INSERT 는 participants.createSlotsFromSheetRows 한 곳');
      const rj = st.slots[0].rows[0].rowJson;
      ok(rj['수취인'] === '홍길동' && rj['연락처'] === '010-1234-5678', '이름·연락처 기입');
      ok(rj['블로그주소'] === 'https://blog.naver.com/gd', '★ 블로그 주소는 매퍼가 쓰는 칸에');
      ok(rj['배송주소'] === undefined, '없는 칸을 지어내지 않는다');
      ok(st.slots[0].tabGid === '77', 'gid 는 서버가 tab_configs 에서 구한다(클라 값 불신)');
      ok(st.rebuilt === 1, '★ 장부 재생성 — 안 하면 표엔 있는데 검색 명단에 없는 줄이 된다');
      const insDirect = st.queries.filter(q => /INSERT\s+INTO\s+campaign_participants/i.test(q));
      ok(insDirect.length === 0, '★ 서비스가 campaign_participants 에 직접 INSERT 하지 않는다(쓰기 소유자 규율)');
    });
  }
  // dryRun 은 쓰기 0
  {
    const st = makeStub();
    await withStubs(st, async () => {
      const r = await svc.registerBlogger({ ...GOOD, dryRun: true });
      ok(r.ok === true && r.dryRun === true && st.slots.length === 0 && st.rebuilt === 0, 'dryRun: 줄 생성·장부 재생성 0');
    });
  }
  // 탭에 종류가 없어도 공고가 blog 면 통과(공고 > 탭)
  {
    const st = makeStub({ tab: [{ tab_gid: '77', campaign_name: 'C', work_kind: '' }], campKind: 'blog' });
    await withStubs(st, async () => {
      const r = await svc.registerBlogger(GOOD);
      ok(r.ok === true, '★ 종류 판정은 공고 > 탭 — 탭이 비어도 공고가 블로그면 등록된다');
    });
  }
  // fail-closed 게이트
  await expectCode(makeStub(), { ...GOOD, name: '  ' }, 'name_required', '이름 없음');
  await expectCode(makeStub(), { ...GOOD, phone: '0101' }, 'phone_required', '★ 연락처 필수(없으면 본인이 못 찾는다)');
  await expectCode(makeStub(), { ...GOOD, blogUrl: 'blog.naver.com/gd' }, 'blog_url_required', '주소 형식(스킴 없음)');
  await expectCode(makeStub(), { ...GOOD, blogUrl: 'https://x.kr/a b' }, 'blog_url_required', '주소 형식(공백)');
  await expectCode(makeStub({ sheetless: false }), GOOD, 'not_sheetless', '★ 시트 기반 작업은 거부(조용히 다른 길로 가지 않는다)');
  await expectCode(makeStub({ tab: [] }), GOOD, 'tab_not_registered', '미등록 탭');
  await expectCode(makeStub({ tab: [{ tab_gid: '7', campaign_name: 'C', work_kind: '' }], campKind: null }), GOOD, 'not_blog', '★ 종류 미지정은 거부(리뷰 작업에 블로거를 넣지 않는다)');
  await expectCode(makeStub({ tab: [{ tab_gid: '7', campaign_name: 'C', work_kind: 'review' }], campKind: null }), GOOD, 'not_blog', '리뷰로 명시된 작업 거부');
  await expectCode(makeStub({ headers: null }), GOOD, 'no_headers', '열 구성 불명');
  await expectCode(makeStub({ headers: ['번호', '연락처', '블로그주소'] }), GOOD, 'no_name_column', '이름 열 없음');
  await expectCode(makeStub({ headers: ['번호', '수취인', '블로그주소'] }), GOOD, 'no_phone_column', '★ 연락처 열 없음');
  await expectCode(makeStub({ headers: ['번호', '수취인', '연락처'] }), GOOD, 'no_blog_column', '★ 블로그 열 없음 — 주소를 넣을 데가 없으면 등록하지 않는다');
  await expectCode(makeStub({ dup: [{ seq: 5, reviewer_name: '홍길동' }] }), GOOD, 'duplicate', '같은 연락처 중복');
  // 거부 시 쓰기 0
  {
    const st = makeStub({ headers: ['번호', '수취인', '연락처'] });
    await withStubs(st, async () => { try { await svc.registerBlogger(GOOD); } catch (_) {} });
    ok(st.slots.length === 0 && st.rebuilt === 0, '★ 거부 시 줄 생성·장부 재생성 0');
  }

  console.log('\n=== §4 라우트 ===');
  {
    const i = ROUTES.indexOf("router.post('/worktable/add-blogger'");
    ok(i > 0, '라우트 등록');
    const body = ROUTES.slice(i, ROUTES.indexOf('\nrouter.', i + 10));
    ok(/authMiddleware/.test(body), 'authMiddleware');
    ok(/_ensureEditScope\(req, sheetId, tabName\)/.test(body), '★ 편집 스코프 가드(광고주 차단 · staff 담당 탭)');
    const iScope = body.indexOf('_ensureEditScope');
    const iSvc = body.indexOf('registerBlogger(');
    ok(iScope > 0 && iSvc > 0 && iScope < iSvc, '★ 스코프 판정이 서비스 호출보다 앞');
    ok(/BlogRegisterError[\s\S]{0,120}status\(400\)/.test(body), '★ 검증 실패는 400대(errorHandler 500 마스킹 방지)');
    ok(/'42P01'|'42703'/.test(body) && /not_ready/.test(body), '마이그레이션 미적용은 not_ready');
    ok(!/adminOrMasterMiddleware/.test(body), '라우트레벨 adminOrMaster 대신 스코프 가드(그리드 편집과 같은 범위)');
  }
  // 라우터 스택 실검사
  {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x';
    const router = require(path.join(ROOT, 'src', 'routes', 'trackB.routes.js'));
    const found = (router.stack || []).some(l => l.route && l.route.path === '/worktable/add-blogger' && l.route.methods.post);
    ok(found, '★ 라우터 스택에 실제로 등록됨');
  }

  console.log('\n=== §5 화면 ===');
  ok(/COALESCE\(tc\.work_kind, ''\) AS "workKind"/.test(PARTS), '★ 작업 목록에 workKind(tab_configs 이미 조인 = 쿼리 순증 0)');
  {
    // _brCanAdd 를 실제로 실행해 게이트를 확인한다(문자열 검사로는 조건을 못 본다)
    const m = HTML.match(/function _brCanAdd\(\)\{[\s\S]*?\n\}/);
    ok(!!m, '_brCanAdd 추출');
    if (m) {
      const sb = { STATE: {} }; vm.createContext(sb); vm.runInContext(m[0], sb);
      const set = (cur, role) => { sb.STATE = { cur, role }; return sb._brCanAdd(); };
      ok(set({ sheetless: true, workKind: 'blog' }, 'admin') === true, '무시트 blog + admin = 표시');
      ok(set({ sheetless: true, workKind: 'blog' }, 'staff') === true, 'staff 도 표시(서버가 담당 탭으로 한정)');
      ok(set({ sheetless: true, workKind: 'blog' }, 'advertiser') === false, '★ 광고주에게는 안 보인다');
      ok(set({ sheetless: false, workKind: 'blog' }, 'admin') === false, '★ 시트 기반 작업에는 안 보인다(막다른 길 금지)');
      ok(set({ sheetless: true, workKind: 'review' }, 'admin') === false, '★ 리뷰로 명시된 작업은 숨김');
      ok(set({ sheetless: true, workKind: '' }, 'admin') === true, '★ 미지정은 열어 둔다(모르는 것을 단정하지 않는다 — 서버가 판정)');
      ok(set(null, 'admin') === false, '작업 미선택이면 false');
    }
  }
  ok(/_brCanAdd\(\)\?`<button class="btn" onclick="openBloggerModal\(\)"/.test(HTML), '[⋯] 메뉴 항목 배선');
  /* ★ 조건 목록은 도구가 늘 때마다 길어진다(2026-08-19 [🔢 번호 정리] 합류) — **_brCanAdd 가 그 조건에
       들어 있는가**만 본다. 전체 문자열을 박아 두면 무관한 도구 추가에 이 가드가 조용히 빨개진다. */
  ok(/\(isMaster(?:\|\|[_A-Za-z0-9]+\(\))*\|\|_brCanAdd\(\)\)\?/.test(HTML), '★ 메뉴 자체 표시 조건에 합류(항목만 넣으면 메뉴가 안 뜬다)');
  {
    const i = HTML.indexOf('function openBloggerModal');
    const b = HTML.slice(i, i + 1600);
    ok(/document\.body\.appendChild\(ov\)/.test(b), '★ 오버레이 body 직속');
    ok(!/brOv[\s\S]{0,400}addEventListener\('click'/.test(b), '바깥클릭으로 닫지 않는다(입력값 보호)');
  }
  ok(/window\._brKeyBound/.test(HTML), '★ Esc 리스너는 최상위 1회(열 때마다 걸면 겹쳐 쌓인다)');
  ok(/_BR\.err[\s\S]{0,80}wbl-warn/.test(HTML), '서버 사유를 화면이 그대로 보여준다');
  ok(/j\.error \|\| j\.message/.test(HTML.slice(HTML.indexOf('async function brSubmit'), HTML.indexOf('async function brSubmit') + 1200)),
    '★ 실패를 성공으로 꾸미지 않는다');
  ok(/box-sizing:border-box/.test(HTML.slice(HTML.indexOf('.wbl-bri'), HTML.indexOf('.wbl-bri') + 260)),
    'CSS: box-sizing 을 호스트 리셋에 기대지 않는다');

  console.log('\n=== §6 소스 위생 ===');
  for (const [n, src] of [['blogRegister.service.js', SVC], ['workdesk.html', HTML]]) {
    ok(src.indexOf(String.fromCharCode(0)) === -1, `${n}: 리터럴 NUL 없음`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} blogRegister: ${pass} pass / ${fail} fail\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
