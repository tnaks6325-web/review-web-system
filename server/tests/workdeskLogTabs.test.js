/**
 * workdeskLogTabs.test.js — 리뷰웹시스템[3버전] 「로그」 2탭 회귀가드
 * 실행: node tests/workdeskLogTabs.test.js
 *
 * 이 변경의 위험은 넷이다.
 *  ① **권한** — 시스템 오류로그에는 경로·스택·요청 컨텍스트가 실린다. AE 의 "담당 탭" 스코프로
 *     나눌 수 있는 데이터가 아니라 master/admin 전용이어야 한다. 그리고 레포가 이미 밟은 함정 —
 *     역할 미들웨어 앞에 `authMiddleware` 를 빠뜨리면 **마스터 포함 전원 403**.
 *     → 라우터 스택을 **실제로 검사**한다.
 *  ② **제외 규칙** — `/api/admin/*` 을 통째로 걸러내면 **작업보드 로그인·SSO 장애가 무신호**가 된다
 *     (로그인 4경로는 이름만 admin 이고 실제 호출자는 리뷰웹시스템[3버전]이다).
 *     → 판정 순수함수를 **실행**해 그 예외가 살아 있는지 고정한다.
 *  ③ **창구 단일화** — 관리자 대시보드의 「오류디버깅」 화면이 남아 있으면 창구가 둘이 되고,
 *     index-app.js 에서 코드만 지우고 HTML 버튼을 남기면 **누르면 ReferenceError 로 죽는 탭**이 된다.
 *     → 세 화면(admin/admin-siand/index-app) 모두에서 흔적 0 을 고정한다.
 *  ④ **프리변수·사본** — 렌더 함수가 자기 스코프에 없는 변수를 참조하면 화면이 조용히 매달린다
 *     (리뷰검수 `isAdmin` 실측 사고). → 로그 뷰 렌더 블록을 **vm 으로 꺼내 실제 실행**한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 리뷰웹시스템[3버전] 「로그」 2탭 회귀가드\n');

const WD = F('workdesk.html');

/* ── 1) 권한 — 라우터 스택 실검사 ──────────────────────────── */
console.log('1) 권한 게이트 (라우터 스택 실검사)');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const router = require('../src/routes/trackB.routes');
const L = {};
router.stack.filter(l => l.route).forEach(l => {
  const m = Object.keys(l.route.methods)[0];
  L[m.toUpperCase() + ' ' + l.route.path] = l.route.stack.map(s => s.name);
});

const ERR_ROUTES = [
  'GET /error-logs', 'GET /error-logs/detail',
  'POST /error-logs/analyze', 'POST /error-logs/status', 'POST /error-logs/resolve',
];
ERR_ROUTES.forEach(k => {
  t(`${k} 등록됨`, Array.isArray(L[k]));
  t(`${k} = authMiddleware + adminOrMaster (AE·광고주 차단)`,
    L[k] && L[k][0] === 'authMiddleware' && L[k][1] === 'adminOrMasterMiddleware');
});
// ★ 리뷰어 비정상로그는 종전대로 내부인 열람(AE 담당 탭만) — 이번 변경으로 좁아지면 안 된다
t('리뷰어 비정상로그 목록은 여전히 internalMiddleware (AE 열람 유지)',
  L['GET /reviewer-logs'] && L['GET /reviewer-logs'][1] === 'internalMiddleware');
t('리뷰어 로그 해결 처리는 여전히 adminOrMaster',
  L['POST /reviewer-logs/resolve'] && L['POST /reviewer-logs/resolve'][1] === 'adminOrMasterMiddleware');

/* ── 2) 로직 복제 0 — 기존 admin 핸들러 위임 ───────────────── */
console.log('\n2) 로직 복제 0 (기존 핸들러 위임)');
const TB = fs.readFileSync(path.join(__dirname, '..', 'src/routes/trackB.routes.js'), 'utf8');
t('_delegate 로 admin.routes 핸들러를 태운다', /_delegate\(_adminRoutes, 'get',\s*'\/error-logs'\)/.test(TB));
t('trackB 가 error_logs 를 직접 쿼리하지 않는다(사본 금지)', !/FROM\s+error_logs/i.test(TB));
const AD = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.routes.js'), 'utf8');
t('원본 /api/admin/error-logs* 라우트는 그대로 살아 있다(위임 대상)',
  /router\.get\('\/error-logs',/.test(AD) && /router\.post\('\/error-logs\/analyze',/.test(AD));

/* ── 3) 제외 규칙 — 순수함수 실행 ──────────────────────────── */
console.log('\n3) 관리자 대시보드 오류 제외 규칙');
const flt = require('../src/utils/adminUiErrorFilter');
t('/api/admin/* 일반 경로 = 제외 대상',
  flt.isAdminUiError({ flow: 'admin', context: { path: '/api/admin/reviewer-list' } }) === true);
t('★ 작업보드 로그인 4경로는 제외하지 않는다(SSO 장애 무신호 방지)',
  flt.WORKDESK_ADMIN_PATHS.length === 4 &&
  ['/api/admin/login', '/api/admin/staff-login', '/api/admin/advertiser-login', '/api/admin/intranet-login']
    .every(p => flt.isAdminUiError({ flow: 'admin', context: { path: p } }) === false));
t('★ 그 4경로가 실제로 리뷰웹시스템[3버전]의 로그인 폴백이다(문서가 아니라 코드와 대조)',
  flt.WORKDESK_ADMIN_PATHS.every(p => WD.includes(p)));
t('공용 인프라 오류(flow≠admin)는 남긴다',
  flt.isAdminUiError({ flow: 'order_submit', context: { path: '/api/submit/order' } }) === false &&
  flt.isAdminUiError({ flow: 'sync_queue', context: {} }) === false);
t('flow=admin 인데 경로 정보가 없으면 제외(대시보드 표면으로 간주)',
  flt.isAdminUiError({ flow: 'admin' }) === true &&
  flt.isAdminUiError({ flow: 'admin', context: null }) === true);
t('error.middleware 가 실제로 /api/admin/* 에 flow=admin 을 붙인다(판정 전제)',
  /\[\/\^\\\/api\\\/admin\/,\s*\{ flow: 'admin'/.test(
    fs.readFileSync(path.join(__dirname, '..', 'src/middleware/error.middleware.js'), 'utf8').replace(/\s+/g, ' '))
  || /\/\^\\\/api\\\/admin\/[\s\S]{0,40}flow: 'admin'/.test(
    fs.readFileSync(path.join(__dirname, '..', 'src/middleware/error.middleware.js'), 'utf8')));
// SQL 조각 — 바인딩 번호가 호출부 배열을 이어받는지(자리표시자↔파라미터 개수 정합)
{
  const p = ['x', 'y'];
  const sql = flt.adminUiWhereSql(p);
  t('WHERE 조각이 파라미터 배열을 이어서 쓴다($3,$4)', /\$3/.test(sql) && /\$4::text\[\]/.test(sql) && p.length === 4);
  t('기본은 "제외"(NOT ...), negate 는 "제외 대상만"',
    sql.startsWith('NOT (') && !flt.adminUiWhereSql([], true).startsWith('NOT'));
  t('opt-in — 값이 없으면 미적용(다른 소비처 동작 불변)',
    flt.wantsExclusion(undefined) === false && flt.wantsExclusion('') === false &&
    flt.wantsExclusion('1') === true && flt.wantsExclusion('true') === true);
}
t('admin.routes 목록이 제외를 opt-in 으로 받고 제외 건수를 함께 준다(조용한 누락 금지)',
  /wantsExclusion\(req\.query\.excludeAdminUi\)/.test(AD) && /excludedCount/.test(AD));
t('★ 제외 적용 시 요약(뱃지)도 같은 기준으로 센다(표와 헤더가 어긋나지 않게)',
  /sumCond/.test(AD) && /sevCond/.test(AD));
t('작업보드 프록시는 기본 제외 · includeAdminUi 로만 포함',
  /excludeAdminUi: req\.query\.includeAdminUi \? '' : '1'/.test(TB));

/* ── 4) 창구 단일화 — 관리자 대시보드 흔적 0 ───────────────── */
console.log('\n4) 관리자 대시보드 「오류디버깅」 제거');
const IA = F('js/index-app.js');
const ADMIN_HTML = F('admin.html');
const SIAND = F('admin-siand.html');
[['admin.html', ADMIN_HTML], ['admin-siand.html', SIAND]].forEach(([nm, src]) => {
  t(`${nm} — 탭 버튼 제거`, !/data-tab="errorlogs"/.test(src));
  t(`${nm} — 패널 마크업 제거`, !/id="tab-errorlogs"/.test(src) && !/id="errorLogListWrap"/.test(src));
});
t('index-app.js — 오류디버깅 함수·상수 제거',
  !/function loadErrorLogs/.test(IA) && !/ERRLOG_CAT_LABELS/.test(IA) && !/ERR_AGENTS/.test(IA));
t('★ 죽은 호출 잔재 0 — 탭 분기·뱃지 호출도 함께 지웠다',
  !/loadErrorLogs\(\)/.test(IA) && !/_updateErrorLogBadge/.test(IA) && !/errorLogBadge/.test(IA));
t('제거 사유가 코드에 남아 있다(다음 사람이 되살리지 않게)',
  /리뷰웹시스템\[3버전\] 「로그」/.test(IA) && /시스템 오류로그/.test(IA));

/* ── 5) 프론트 배선 ───────────────────────────────────────── */
console.log('\n5) 리뷰웹시스템[3버전] 배선');
t('nav 이름이 「로그」', /switchView\('logs'\)">로그<span id="lgNavBadge">/.test(WD));
t('옛 이름(리뷰어 로그) nav 버튼 없음', !/">리뷰어 로그<span id="lgNavBadge"/.test(WD));
t('서브탭 알약은 기존 .seg 재사용(신규 컴포넌트 0)',
  /class="seg\$\{t==='reviewer'\?' on':''\}" onclick="switchLogTab\('reviewer'\)/.test(WD)
  && /switchLogTab\('system'\)/.test(WD));
t('★ 기본 탭 = 리뷰어 비정상로그',
  /STATE\.logTab==='system'\) \? 'system' : 'reviewer'/.test(WD));
t('★ 시스템 탭은 admin/master 에게만 그린다(프론트 게이트 = 서버 게이트와 1:1)',
  /function _lgCanSys\(\)\{ return STATE\.role==='master' \|\| STATE\.role==='admin'; \}/.test(WD)
  && /if\(!_lgCanSys\(\)\) STATE\.logTab='reviewer';/.test(WD)
  && /if\(t==='system' && !_lgCanSys\(\)\) return;/.test(WD));
t('시스템 표는 리뷰어 로그와 같은 .lgtable + 행 펼침(사본 아님)',
  /_renderSysBody[\s\S]{0,800}class="lgwrap"><table class="lgtable"/.test(WD)
  && /_toggleSysRow/.test(WD));
t('AI 다중에이전트 분석 유지 — 6역할 + 이행요청 게이트',
  /SYS_AGENTS\s*=\s*\[/.test(WD) && (WD.match(/nm:'(오류검증|레드팀|블루팀|감독관|예방가드|결정자)'/g) || []).length === 6
  && /_sysRunAnalysis/.test(WD) && /error-logs\/analyze/.test(WD) && /transfer_allowed/.test(WD));
t('★ 분석 모달은 body 직속(뷰 스크롤 컨테이너에 넣지 않는다)',
  /document\.body\.appendChild\(ov\)/.test(WD.slice(WD.indexOf('function _sysModal'))));
t('제외 건수를 화면에 표기하고 포함해 볼 수 있다',
  /excludedCount/.test(WD) && /제외분 포함해 보기/.test(WD) && /includeAdminUi=1/.test(WD));
t('★ nav 뱃지 = 두 탭 합계, 둘 다 미조회면 건드리지 않는다',
  /_NAVLG = \{ rv:null, sys:null \}/.test(WD)
  && /if\(_NAVLG\.rv===null && _NAVLG\.sys===null\) return;/.test(WD)
  && /\(_NAVLG\.rv\|0\)\+\(_NAVLG\.sys\|0\)/.test(WD));
t('폭 상한 — 시스템 표도 리뷰어 로그와 같은 1300px',
  /#syshead \.mh\{max-width:1300px\}/.test(WD) && /#sysbody \.lgwrap\{max-width:1300px\}/.test(WD)
  && /#lghead \.mh\{max-width:1300px\}/.test(WD));

/* ── 6) 렌더 블록 실제 실행 (프리변수·사본 검출) ───────────── */
console.log('\n6) 렌더 함수 실제 실행');
{
  // 로그 뷰 관련 함수만 잘라 vm 으로 실행한다. sandbox 에 isAdmin 같은 전역을 **일부러 두지 않아**
  // 프리변수가 들어오면 그 자리에서 터진다(리뷰검수 무한로딩 사고의 재발 가드).
  const start = WD.indexOf('function _lgCanSys()');
  const end = WD.indexOf('async function renderOverviewView()');
  assert(start > 0 && end > start, '로그 뷰 블록을 찾지 못함');
  const code = WD.slice(start, end);

  const els = {};
  const mkEl = () => ({ innerHTML: '', textContent: '', hidden: false, style: {},
    addEventListener() {}, appendChild() {}, remove() {}, classList: { contains: () => false } });
  const doc = {
    getElementById: id => (els[id] = els[id] || mkEl()),
    createElement: () => mkEl(),
    body: { appendChild() {} },
  };
  const calls = [];
  const sandbox = {
    document: doc,
    $: sel => doc.getElementById(String(sel).replace('#', '')),
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    STATE: { role: 'admin' },
    api: async (url) => {
      calls.push(url);
      if (/reviewer-logs/.test(url)) return { ok: true, items: [], counts: { total: 0, critical: 0 } };
      if (/error-logs\?/.test(url)) {
        return { ok: true, excludedCount: 12, logs: [{
          id: 7, severity: 'critical', status: 'new', flow: 'sheet_write', flow_ko: '시트 기록',
          step_ko: '시트 쓰기', category: 'quota', message_ko: '시트 기록 시트 쓰기에서 호출한도 초과',
          message_raw: 'Quota exceeded', error_code: '429', occurrence_count: 34, source: 'external_api',
          first_seen_at: '2026-08-04T09:12:00Z', last_seen_at: '2026-08-04T09:40:00Z',
          has_analysis: true, decider_verdict: 'implement_after_preflight',
          context: { method: 'POST', path: '/api/submit/order' },
        }], summary: { openCount: 2, bySeverity: { critical: 1 } } };
      }
      return { ok: true };
    },
    alert() {}, confirm: () => true, _toast() {},
    setInterval: () => 0, clearInterval() {},
    navigator: { clipboard: { writeText: async () => {} } },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'workdesk-logs.js' });

  t('로그 뷰 블록이 단독 실행된다(프리변수 0)', typeof sandbox.renderLogsView === 'function');

  // 기본 탭 = 리뷰어
  const rv = sandbox.renderLogsView();
  t('renderLogsView 가 예외 없이 시작한다', rv && typeof rv.then === 'function');

  // 서브탭 렌더 — 권한별
  sandbox.STATE.logTab = 'reviewer';
  sandbox._renderLogSegs();
  const segHtml = els.lgsegs.innerHTML;
  t('admin — 두 알약이 그려지고 리뷰어 탭이 켜져 있다',
    /리뷰어 비정상로그/.test(segHtml) && /시스템 오류로그/.test(segHtml)
    && /class="seg on" onclick="switchLogTab\('reviewer'\)/.test(segHtml));
  sandbox.STATE.role = 'staff';
  sandbox._renderLogSegs();
  t('★ AE(staff) — 시스템 오류로그 알약 자체가 없다', !/시스템 오류로그/.test(els.lgsegs.innerHTML));
  sandbox.STATE.role = 'admin';

  // 시스템 표 실제 렌더
  return sandbox._loadSysLogs().then(() => {
    const body = els.sysbody.innerHTML, head = els.syshead.innerHTML;
    t('시스템 표가 실제로 그려진다(정상 응답에 오류 문구 없음)',
      /table class="lgtable"/.test(body) && !/불러오지 못했습니다/.test(body));
    t('행에 기능·단계·종류·횟수·오류내용이 들어간다',
      /시트 기록/.test(body) && /호출한도 초과/.test(body) && /×34/.test(body));
    t('AI 분석 배지 · 펼침행 · 분석 버튼', /분석됨/.test(body) && /sysdetail-7/.test(body) && /_sysOpenAnalysis\(7\)/.test(body));
    t('제외 건수 12건이 화면에 표기된다', /12건은 제외/.test(head));
    t('★ 목록 요청이 제외 포함 파라미터 없이 나간다(기본 제외)',
      calls.some(u => /error-logs\?status=open/.test(u) && !/includeAdminUi/.test(u)));
    t('nav 뱃지에 시스템 치명 건수가 합산된다', /🔴/.test(els.lgNavBadge.textContent));

    // 포함해 보기
    sandbox.STATE.sysIncludeAdminUi = true;
    return sandbox._loadSysLogs().then(() => {
      t('제외분 포함해 보기 → includeAdminUi=1 로 재조회',
        calls.some(u => /includeAdminUi=1/.test(u)));
      done();
    });
  });
}

function done() {
  console.log(`\n✅ workdeskLogTabs: ${pass}개 통과\n`);
  process.exit(0);   // trackB.routes 를 require 하면 DB 풀 핸들이 열려 자연 종료가 안 됨
}
