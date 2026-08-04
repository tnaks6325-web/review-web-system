/**
 * csInquiryTab.test.js — C/S 문의창구를 리뷰웹시스템[3버전] 상단탭에 연동한 것의 회귀가드
 * 실행: node tests/csInquiryTab.test.js
 *
 * 위험 두 가지를 고정한다.
 *  ① **권한** — 문의 본문에는 리뷰어 실명·연락처·주소·주문정보가 그대로 실린다.
 *     기존 `/api/cs/*` 는 master/admin 전용(cs.routes.js 머리말: "staff·리뷰어는 접근 불가")이고
 *     Track B 프록시도 **같은 게이트**여야 한다. 한 칸만 어긋나면 AE 전원에게 열린다.
 *     → 라우터 스택을 실제로 검사한다.
 *  ② **사본 드리프트** — 화면 코드를 리뷰웹시스템[3버전]용으로 베끼면 답장·메모·상태변경 중
 *     하나만 고쳐도 두 화면이 갈라진다. → 같은 모듈을 쓰는지 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ C/S 문의창구 · 리뷰웹시스템[3버전] 연동 회귀가드\n');

/* ── 1) 권한 — 라우터 스택 실검사 ──────────────────────────── */
console.log('1) 권한 게이트');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const router = require('../src/routes/trackB.routes');
const L = {};
router.stack.filter(l => l.route).forEach(l => {
  const m = Object.keys(l.route.methods)[0];
  L[m.toUpperCase() + ' ' + l.route.path] = l.route.stack.map(s => s.name);
});
const CS = ['GET /cs/threads', 'GET /cs/unread-count', 'GET /cs/messages', 'GET /cs/order-context',
  'POST /cs/reply', 'POST /cs/status', 'POST /cs/memo'];

t('★ 7개 경로가 모두 존재하고 `/api/cs/*` 와 모양이 1:1', () => {
  CS.forEach(k => assert.ok(L[k], '없는 라우트: ' + k));
});
t('★★ 전부 authMiddleware + adminOrMasterMiddleware — AE(staff)·광고주 차단', () => {
  CS.forEach(k => {
    assert.ok(L[k].includes('authMiddleware'), k + ': 인증 게이트 없음');
    assert.ok(L[k].includes('adminOrMasterMiddleware'), k + ': 관리자 게이트 없음');
    assert.ok(!L[k].includes('internalMiddleware'), k + ': internal 로 완화되면 AE 에게 열린다');
  });
});
t('원본 /api/cs/* 정책이 바뀌지 않았다(프록시만 추가)', () => {
  const cs = R('src/routes/cs.routes.js');
  assert.ok(/router\.use\(authMiddleware, adminOrMasterMiddleware\)/.test(cs),
    '원본 라우터의 전역 게이트가 사라졌다');
});
t('★ 로직 복제 0 — 기존 cs 핸들러에 위임한다', () => {
  const src = R('src/routes/trackB.routes.js');
  assert.ok(/const _csRoutes = require\('\.\/cs\.routes'\)/.test(src));
  ['/threads', '/unread-count', '/messages', '/order-context', '/reply', '/status', '/memo']
    .forEach(p => assert.ok(new RegExp("_delegate\\(_csRoutes, '(get|post)',\\s*'" + p + "'\\)").test(src),
      '위임이 아닌 경로: ' + p));
  // 위임 대신 SQL 을 베끼면 원본과 갈라진다.
  // ★ 금지 대상은 **문의 목록·대화를 재현하는 조회**다. 다른 기능이 "이 리뷰어에게 문의가 몇 건인가"를
  //   세는 COUNT 는 CS 로직의 사본이 아니라 교차 참조라 허용한다(등록리뷰어DB 삭제 경고 = reviewers/delete).
  //   그래서 규칙을 "cs_threads 금지"가 아니라 **"COUNT 외의 cs_threads 조회 금지 + cs_messages 전면 금지"**로 좁힌다
  //   — 목록·대화 사본은 여전히 한 글자도 못 들어온다.
  assert.ok(!/FROM\s+cs_messages/i.test(src), 'trackB.routes 에 CS 대화(cs_messages) 쿼리 사본이 있다');
  [...src.matchAll(/SELECT[\s\S]{0,300}?FROM\s+cs_threads/gi)].forEach(m =>
    assert.ok(/^SELECT\s+COUNT\(\*\)/i.test(m[0].trim()),
      'cs_threads 를 COUNT 외의 방식으로 조회한다(=목록/상세 사본): ' + m[0].replace(/\s+/g, ' ').slice(0, 90)));
});

/* ── 2) 프론트 — 화면 코드 한 벌 ───────────────────────────── */
console.log('\n2) 사본 금지(공유 모듈)');
const MOD = F('js/cs-inquiry.js');
const APP = F('js/index-app.js');
const ADM = F('admin.html');
const SIA = F('admin-siand.html');
const WD = F('workdesk.html');
const API = F('api.js');

t('★ 화면 코드는 모듈에만 있다(index-app.js·workdesk.html 에 사본 없음)', () => {
  ['loadCsRooms', '_renderCsRooms', 'csOpenConversation', '_csRenderMessages', 'csSendReply']
    .forEach(fn => {
      assert.ok(new RegExp('function ' + fn + '\\b').test(MOD), '모듈에 없다: ' + fn);
      assert.ok(!new RegExp('function ' + fn + '\\b').test(APP), 'index-app.js 에 사본: ' + fn);
      assert.ok(!new RegExp('function ' + fn + '\\b').test(WD), 'workdesk.html 에 사본: ' + fn);
    });
});
t('★ 마크업도 모듈이 들고 있다(두 화면이 같은 판을 마운트)', () => {
  assert.ok(/id=\\"tab-cs-inquiry\\"/.test(MOD) || /id=\\?"tab-cs-inquiry/.test(MOD),
    '모듈 안에 탭 판 마크업이 없다');
  assert.ok(/id="csInquiryMount"/.test(ADM), 'admin.html 마운트 지점 없음');
  assert.ok(!/id="csRoomListWrap"/.test(ADM), 'admin.html 에 마크업 사본이 남아 있다');
  assert.ok(!/id="csRoomListWrap"/.test(WD), 'workdesk.html 에 마크업 사본이 있다');
  assert.ok(/CsInquiry\.mount\('csInquiryMount'\)/.test(WD), '리뷰웹시스템[3버전]이 모듈 마운트를 안 쓴다');
});
t('세 화면이 같은 모듈을 로드한다', () => {
  [['admin.html', ADM], ['admin-siand.html', SIA], ['workdesk.html', WD]].forEach(([n, s]) => {
    assert.ok(/<script src="js\/cs-inquiry\.js"><\/script>/.test(s), n + ' 미로드');
  });
  // admin 계열은 index-app.js 앞 — onclick 문자열이 전역 이름으로 참조한다
  [['admin.html', ADM], ['admin-siand.html', SIA]].forEach(([n, s]) => {
    assert.ok(s.indexOf('js/cs-inquiry.js') < s.indexOf('js/index-app.js'), n + ': 로드 순서');
  });
});
t('★ 전역 공개 — onclick 문자열·SSE 훅이 이름 그대로 쓴다', () => {
  ['loadCsRooms', 'csOpenConversation', 'csSendReply', 'csSaveMemo', 'csToggleStatus',
    'csViewImage', 'csCloseConversation', 'csUpdateBadge', 'csRefreshBadge', 'csOnSSE']
    .forEach(n => assert.ok(new RegExp(n + ': ' + n + '[,\\s]').test(MOD), '미공개: ' + n));
  assert.ok(/window\[k\] = EXPORTS\[k\]/.test(MOD));
  assert.ok(/window\.csOnSSE/.test(MOD) || /csOnSSE: csOnSSE/.test(MOD),
    'index-payment.js 의 SSE 훅이 끊긴다');
});
t('★ 모듈은 호스트 전역에 기대지 않는다(리뷰웹시스템[3버전]엔 escHtml·showToast 가 없다)', () => {
  assert.ok(/function _escFallback\(s\)/.test(MOD) && /function escHtml\(s\)/.test(MOD),
    'escHtml 폴백이 없으면 리뷰웹시스템[3버전]에서 화면이 통째로 터진다');
  // ★ 로드 시점 캡처 금지 — 이 모듈은 index-app.js 앞에 로드되므로 그때는 window.escHtml 이 없다.
  //   캡처해 버리면 admin 에서도 폴백이 쓰여 원본과 출력이 조용히 달라진다(실측으로 확인한 함정).
  assert.ok(!/var escHtml = \(typeof window/.test(MOD), 'escHtml 을 로드 시점에 캡처하고 있다');
  assert.ok(/\.replace\(\/&\/g, "&amp;"\)\.replace\(\/<\/g, "&lt;"\)\.replace\(\/>\/g, "&gt;"\)\.replace\(\/"\/g, "&quot;"\)/.test(MOD),
    '폴백이 index-app.js 의 escHtml 과 다른 구현이면 출력이 갈라진다');
  assert.ok(/typeof window\.showToast === "function"/.test(MOD), 'showToast 폴백 없음');
  // var() 폴백 — admin 테마가 없는 화면에서 색·테두리가 날아간다
  assert.strictEqual((MOD.match(/var\(--[a-zA-Z0-9-]+\)/g) || []).length, 0,
    '폴백 없는 CSS 변수가 남아 있다');
});

/* ── 3) 경로 재기준 (SSO 토큰 격리 우회 금지) ───────────────── */
console.log('\n3) 경로 재기준');
t('★ api.js 가 /api/cs 만 재기준한다 — 전역 미설정이면 동작 불변', () => {
  assert.ok(/function _resolveApiPath\(p\)/.test(API));
  assert.ok(/window\.CS_API_BASE/.test(API));
  assert.ok(/p\.indexOf\('\/api\/cs\/'\) === 0/.test(API), '다른 경로까지 갈아끼우면 안 된다');
  assert.strictEqual((API.match(/_resolveApiPath\(route\.path\)/g) || []).length, 3,
    'gasGet(GET·POST 분기)·gasPost 세 곳 모두 거쳐야 한다');
});
t('리뷰웹시스템[3버전]만 Track B 네임스페이스를 가리킨다', () => {
  assert.ok(/window\.CS_API_BASE = '\/api\/trackb\/cs'/.test(WD));
  assert.ok(!/CS_API_BASE\s*=/.test(ADM) && !/CS_API_BASE\s*=/.test(SIA),
    'admin 이 베이스를 바꾸면 기존 경로가 죽는다');
  // ★ 문자열이 주석에도 나오므로 **실제 태그 위치**로 비교한다(주석 순서에 속지 않게)
  assert.ok(WD.indexOf("<script>window.CS_API_BASE") < WD.indexOf('<script src="js/cs-inquiry.js">'),
    '베이스는 모듈 로드보다 먼저 정해져야 한다');
});

/* ── 4) 리뷰웹시스템[3버전] 배선 ────────────────────────────────────── */
console.log('\n4) 리뷰웹시스템[3버전] 배선');
/* ★★ 이미지 교체요청이 이 탭 안으로 들어오면서(시안 C = 문의 화면 위의 대기 큐 띠)
   AE 에게도 **메뉴는** 열렸다 — AE 가 그 화면에서 하는 일이 교체요청 처리다.
   보안 경계는 "메뉴가 보이나"가 아니라 **"AE 화면에 문의 본문을 그리나"** 로 옮겼고,
   그 실행 검증은 reviewEditCsBridge.test.js §8(역할별 renderCsView 실행)에 있다. */
t('★ 상단탭 버튼 — 관리자·AE 양쪽 / AE 는 문의창구를 마운트하지 않는다', () => {
  const adminNav = WD.slice(WD.indexOf('${isAdmin?`<nav'), WD.indexOf(':isStaff?`<nav'));
  // ★ 끝 표지는 `</nav>`:''}` — 그냥 `:''}` 로 찾으면 파일 앞쪽의 다른 삼항이 먼저 걸려 빈 슬라이스가 된다
  const staffNav = WD.slice(WD.indexOf(':isStaff?`<nav'), WD.indexOf('</nav>`:\'\'}'));
  assert.ok(/data-v="cs"/.test(adminNav), '관리자 nav 에 버튼이 없다');
  assert.ok(/data-v="cs"/.test(staffNav), 'AE nav 에 버튼이 없다 — AE 가 이미지 교체요청을 처리할 문이 사라진다');
  // 문의창구 마운트·목록조회는 **관리자 분기 안**에서만 일어난다(AE 는 그리려는 시도조차 안 함)
  const view = WD.slice(WD.indexOf('async function renderCsView()'));
  const body = view.slice(0, view.indexOf('\n}\n'));
  const gate = body.indexOf('if(isAdmin){'), mount = body.indexOf('CsInquiry.mount('), other = body.indexOf('}else{');
  assert.ok(gate > -1 && mount > gate && other > mount,
    '★★ 문의창구 마운트가 isAdmin 분기 밖으로 나왔다 — AE 화면에 리뷰어 실명·연락처·주소가 그려진다');
  assert.ok(body.indexOf('loadCsRooms()') > gate && body.indexOf('loadCsRooms()') < other,
    '★★ AE 도 문의 목록을 조회한다');
});
t('switchView 가 CS 뷰를 그린다', () => {
  assert.ok(/else if\(v==='cs'\) renderCsView\(\)/.test(WD));
  assert.ok(/async function renderCsView\(\)/.test(WD));
});
t('탭 안(#viewroot)에 그린다 — 팝업·새 창 아님', () => {
  // 위 = 교체요청 대기 큐(시안 C) / 아래 = 문의창구. 순서가 바뀌면 띠가 문의 화면에 묻힌다.
  assert.ok(/\$\('#viewroot'\)\.innerHTML=`<div class="ovwrap"><div id="csTopNote"><\/div><div id="reQueueMount"><\/div><div id="csInquiryMount"><\/div><\/div>`/.test(WD));
  // 모듈 마크업은 .admin-tab-pane(기본 display:none) — active 를 줘야 보인다
  assert.ok(/getElementById\('tab-cs-inquiry'\); if\(pane\) pane\.classList\.add\('active'\)/.test(WD));
});
t('★ nav 뱃지는 DOM 이 아니라 값으로 받는다(#csInquiryBadge 는 리뷰웹시스템[3버전]에 없다)', () => {
  assert.ok(/function _csSyncNavBadge\(n\)/.test(WD));
  assert.ok(/!Number\.isFinite\(n\)\) return/.test(WD), '값이 없을 때 뱃지를 지우면 안 된다');
  assert.ok(!/_csSyncNavBadge[\s\S]{0,200}getElementById\('csInquiryBadge'\)/.test(WD),
    '#csInquiryBadge 를 읽으면 리뷰웹시스템[3버전]에선 늘 0이 된다(실측)');
});
t('★★ 모듈 뱃지 갱신은 **훅**으로 받는다 — window 함수를 감싸는 방식은 동작하지 않는다', () => {
  // 실측(코드리뷰 지적): loadCsRooms·csRefreshBadge 는 렉시컬 스코프의 csUpdateBadge 를
  //   직접 부르므로 밖에서 window.csUpdateBadge 를 감싸도 **절대 호출되지 않는다**.
  //   → 뱃지가 부팅 시각 값에 영영 머무른다. 훅은 모듈 안에서 부른다.
  assert.ok(/window\.CS_ON_BADGE === "function"\) window\.CS_ON_BADGE\(Number\(count\) \|\| 0\)/.test(MOD),
    '모듈이 호스트 훅을 부르지 않는다');
  assert.ok(/window\.CS_ON_BADGE = function \(n\)/.test(WD), '리뷰웹시스템[3버전]이 훅을 등록하지 않는다');
  assert.ok(!/W\.csUpdateBadge = function/.test(WD), '동작하지 않는 래퍼 방식이 되살아났다');
  // #csInquiryBadge 가 없어도 훅은 불려야 한다 → early return 을 되살리면 안 됨
  assert.ok(!/const b = document\.getElementById\("csInquiryBadge"\);\s*\n\s*if \(!b\) return;/.test(MOD),
    'early return 이 돌아오면 리뷰웹시스템[3버전]에서 훅이 안 불린다');
});
t('★ 부팅 1회로 끝내지 않는다 — 주기 갱신 + 화면 가려지면 쉼', () => {
  assert.ok(/CS_BADGE_POLL_MS/.test(WD) && /setInterval\(/.test(WD), '주기 갱신이 없다');
  assert.ok(/document\.visibilityState==='visible'/.test(WD), '백그라운드 탭에서도 계속 두드린다');
  assert.ok(/addEventListener\('visibilitychange'/.test(WD), '복귀 시 즉시 갱신이 없다');
  assert.ok(/if\(isAdmin\) _csStartBadgePoll\(\)/.test(WD), '관리자에게만 돌아야 한다');
});
t('모듈 아이콘이 보이도록 폰트어썸을 admin 과 같은 CDN 으로 로드', () => {
  const fa = /fontawesome-free@6\.4\.0\/css\/all\.min\.css/;
  assert.ok(fa.test(WD) && fa.test(ADM), '두 화면의 아이콘 버전이 어긋난다');
});

console.log(`\n✅ ${pass} checks passed\n`);
process.exit(0);   // trackB.routes 를 require 하면 DB 풀 핸들이 열려 자연 종료가 안 됨
