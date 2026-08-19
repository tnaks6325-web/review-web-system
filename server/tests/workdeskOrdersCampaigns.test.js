/**
 * workdeskOrdersCampaigns.test.js — 리뷰웹시스템[3버전] '작업오더·모집공고' 탭 회귀가드
 * 실행: node tests/workdeskOrdersCampaigns.test.js
 *
 * 이 화면의 위험은 두 가지다.
 *  ① **권한** — 두 탭은 AE 에게도 열려 있는데, 작업오더 접수는 시트/탭 등록의 단일 관문이고
 *     공고 발행·수정은 정원·금액을 바꾼다. 게이트가 한 칸만 어긋나면 아무나 누른다.
 *     → 라우터 스택을 **실제로 검사**한다.
 *  ② **사본 드리프트** — 카드·모달·저장 로직을 리뷰웹시스템[3버전]용으로 베끼면 관리자 대시보드와
 *     계속 어긋난다(레포가 반복해서 경고한 그것). → 같은 파일을 쓰는지 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('\n▶ 리뷰웹시스템[3버전] 작업오더·모집공고 회귀가드\n');

/* ── 1) 권한 — 라우터 스택 실검사 ──────────────────────────── */
console.log('1) 권한 게이트');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const router = require('../src/routes/trackB.routes');
const L = {};
router.stack.filter(l => l.route).forEach(l => {
  const m = Object.keys(l.route.methods)[0];
  L[m.toUpperCase() + ' ' + l.route.path] = l.route.stack.map(s => s.name);
});

const READ = ['GET /work-orders/list', 'GET /campaigns/list', 'GET /campaigns/:id/applications',
  'GET /campaigns/:id/preview', 'GET /perm'];
const WRITE = ['POST /work-orders/accept', 'PUT /work-orders/status',
  'POST /campaigns/create', 'PUT /campaigns/:id', 'POST /campaigns/:id/flags',
  'DELETE /campaigns/:id', 'POST /campaigns/:id/confirm', 'PUT /campaigns/:id/status',
  'POST /campaigns/:id/dismiss'];

t('열람 라우트가 전부 등록돼 있다', () => {
  READ.forEach(k => assert.ok(L[k], '없음: ' + k));
});
t('편집 라우트가 전부 등록돼 있다', () => {
  WRITE.forEach(k => assert.ok(L[k], '없음: ' + k));
});
t('★ 열람은 내부인만(광고주 차단) — internalMiddleware', () => {
  READ.forEach(k => assert.ok(L[k].includes('internalMiddleware'),
    k + ': internalMiddleware 없음 — 광고주에게 열릴 수 있다'));
});
t('★★ 편집은 전부 editorOnlyMiddleware 뒤 — 이름 명단만 통과', () => {
  WRITE.forEach(k => {
    assert.ok(L[k].includes('authMiddleware'), k + ': authMiddleware 없음');
    assert.ok(L[k].includes('internalMiddleware'), k + ': internalMiddleware 없음');
    assert.ok(L[k].includes('editorOnlyMiddleware'),
      k + ': editorOnlyMiddleware 없음 — 명단 밖 AE 가 접수·발행할 수 있다');
  });
});
t('★ 열람 라우트에는 편집 게이트를 걸지 않는다(읽기까지 막히면 탭이 무의미)', () => {
  READ.forEach(k => assert.ok(!L[k].includes('editorOnlyMiddleware'), k + ': 열람에 편집 게이트'));
});
// ★ 2026-08 사용자 확정: 명단 관리도 내부 담당자(AE 포함)가 한다 — 광고주·리뷰어는 차단.
//   ⚠ 명단이 자기 자신을 게이트하면(editorOnly) 명단에서 빠지는 순간 아무도 못 고치므로 그 금지는 유지.
t('명단 관리는 내부 담당자 전용(광고주 차단)', () => {
  ['GET /workdesk-editors', 'POST /workdesk-editors', 'DELETE /workdesk-editors/:id'].forEach(k => {
    assert.ok(L[k], '없음: ' + k);
    assert.ok(L[k].includes('internalMiddleware'), k + ': internal 게이트 없음');
    assert.ok(!L[k].includes('editorOnlyMiddleware'), k + ': 명단이 자기 자신을 게이트하면 안 됨');
  });
});

/* ── 2) 편집 판정 로직 ─────────────────────────────────────── */
console.log('\n2) 편집 판정(workdeskEditors)');
const WD = R('src/utils/workdeskEditors.js');
t('★ master 는 명단 무관 허용(명단 오설정 잠금 방지)', () => {
  assert.ok(/if \(role === 'master'\) return true;/.test(WD));
});
t('★ 조회 실패는 읽기 전용으로 수렴(fail-closed)', () => {
  assert.ok(/if \(!set\) return false;/.test(WD), '명단을 못 읽으면 열지 말아야 한다');
});
t('광고주는 무조건 차단', () => {
  assert.ok(/role === 'advertiser'[\s\S]{0,40}return false/.test(WD));
});
t('표기 흔들림(공백) 흡수', () => {
  assert.ok(/replace\(\/\\s\+\/g, ''\)/.test(WD));
});
t('명단 변경 시 캐시를 즉시 무효화(다음 요청부터 반영)', () => {
  ['addEditor', 'removeEditor'].forEach(fn => {
    const body = WD.slice(WD.indexOf('function ' + fn), WD.indexOf('function ' + fn) + 700);
    assert.ok(/invalidate\(\);/.test(body), fn + ': invalidate 없음');
  });
});
t('제거는 소프트(이력 보존)', () => {
  assert.ok(/UPDATE workdesk_editors SET active = FALSE/.test(WD), '하드 삭제는 이력이 사라진다');
});
t('마이그레이션이 멱등이고 소급 재삽입하지 않는다', () => {
  const mg = R('migrations/079_workdesk_editors.sql');
  assert.ok(/CREATE TABLE IF NOT EXISTS workdesk_editors/.test(mg));
  assert.ok(/ON CONFLICT DO NOTHING/.test(mg), '재배포 때 지운 사람이 되살아나면 안 된다');
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS uq_workdesk_editors_name/.test(mg));
});

/* ── 3) 사본 금지 — 관리자 대시보드와 같은 코드 ────────────── */
console.log('\n3) 단일 출처(사본 드리프트 방지)');
const HTML = F('workdesk.html');
const ADM = F('admin.html');
const MODAL = F('js/recruit-modal.js');
const REC = F('js/index-recruit.js');

t('★ 발행·수정 모달 마크업은 공유 모듈 한 벌뿐', () => {
  assert.strictEqual((ADM.match(/id="rf_title"/g) || []).length, 0,
    'admin.html 에 인라인 모달이 남아 있으면 두 벌이 된다');
  // ★ 세는 대상은 **살아 있는 마크업 한 벌**이다 — 모듈 안의 `<template id="rf_legacy_*_markup">` 는
  //   브라우저가 inert 로 다루는 보관용 조각이라 document 에 id 가 등록되지 않는다(중복 id 아님).
  //   단순 문자열 계수로 두면 그 보관 조각 때문에 이 가드가 조용히 빨개진다.
  const liveOnly = (src) => { let d = 0, out = ''; for (const line of src.split('\n')) {
    const o = (line.match(/<template[\s>]/g) || []).length, c = (line.match(/<\/template>/g) || []).length;
    if (d === 0) out += line + '\n'; d += o - c; } return out; };
  assert.strictEqual((liveOnly(MODAL).match(/id="rf_title"/g) || []).length, 1,
    '공유 모듈의 살아 있는 모달 마크업은 정확히 한 벌이어야 한다');
  assert.strictEqual((HTML.match(/id="rf_title"/g) || []).length, 0,
    '리뷰웹시스템[3버전]이 모달을 베끼면 안 된다 — 모듈을 마운트해야 한다');
});
t('모달 CSS도 모듈에 함께 있다(스타일 없이 뜨는 것 방지)', () => {
  assert.ok(/\.rf-split\{/.test(MODAL), '모듈에 CSS 없음');
  assert.ok(!/^\.rf-split\{/m.test(ADM), 'admin.html 에 CSS 가 남아 있음');
});
t('두 화면이 같은 모듈을 로드한다', () => {
  ['js/recruit-modal.js', 'js/campaign-cards.js', 'js/index-recruit.js'].forEach(f => {
    assert.ok(ADM.includes(f), 'admin.html 이 ' + f + ' 미로드');
    assert.ok(HTML.includes(f), 'workdesk.html 이 ' + f + ' 미로드');
  });
});
t('모달 로드 순서 — 마크업이 저장 로직보다 먼저', () => {
  [ADM, HTML].forEach((doc, i) => {
    assert.ok(doc.indexOf('js/recruit-modal.js') < doc.indexOf('js/index-recruit.js'),
      (i ? 'workdesk' : 'admin') + ': recruit-modal.js 가 index-recruit.js 뒤에 있으면 프리필이 필드를 못 찾는다');
  });
});
t('★ 리뷰웹시스템[3버전]은 목록·저장 로직을 베끼지 않고 그대로 호출', () => {
  assert.ok(/await (window\.)?loadRecruitList\(\)/.test(HTML), 'index-recruit.js 의 로더를 써야 한다');
  assert.ok(/openRecruitModal\(\)/.test(HTML), '발행 모달도 같은 함수');
  assert.ok(!/function loadRecruitList/.test(HTML), '사본 정의가 있으면 안 된다');
  assert.ok(!/function _renderRecruitCards\s*\(/.test(HTML), '카드 렌더 사본 금지');
});
t('★ 컨테이너 id 는 index-recruit.js 계약(recruitListWrap)을 따른다', () => {
  assert.ok(/id="recruitListWrap"/.test(HTML), '다른 id 를 쓰면 목록이 안 그려진다');
  assert.ok(/id="recruitModalMount"/.test(HTML) && /id="recruitModalMount"/.test(ADM),
    '두 화면 모두 마운트 지점이 있어야 한다');
});
t('★ API 베이스만 갈아끼워 재사용(경로 하드코딩 제거)', () => {
  assert.ok(/function _campApi\(path\)/.test(REC), 'index-recruit.js 에 경로 헬퍼가 없다');
  const hard = (REC.match(/API_BASE_URL \+ ["`']\/api\/campaign\/admin/g) || []).length;
  assert.strictEqual(hard, 0, '하드코딩된 admin 경로가 남아 있으면 AE 는 403 이 된다');
  assert.ok(/window\.CAMPAIGN_ADMIN_API = '\/api\/trackb\/campaigns'/.test(HTML),
    'workdesk 가 Track B 네임스페이스를 지정해야 한다');
});
t('Track B 네임스페이스가 admin 과 같은 모양(베이스 치환만으로 동작)', () => {
  const SRC = R('src/routes/trackB.routes.js');
  ['/campaigns/list', '/campaigns/create', '/campaigns/:id', '/campaigns/:id/flags',
    '/campaigns/:id/status', '/campaigns/:id/applications', '/campaigns/:id/confirm',
    '/campaigns/:id/dismiss'].forEach(p => {
    assert.ok(SRC.includes("'" + p + "'"), '경로 모양 불일치: ' + p);
  });
});
t('편집 계열은 기존 핸들러에 위임(로직 복제 0)', () => {
  const SRC = R('src/routes/trackB.routes.js');
  assert.ok(/function _delegate\(/.test(SRC), '위임 헬퍼가 없다');
  assert.ok(/throw new Error\(`\[trackB\] 위임 대상 라우트를 찾지 못함/.test(SRC),
    '대상이 사라지면 부팅 때 터져야 한다(조용한 404 금지)');
  assert.ok(!/INSERT INTO recruit_campaigns/.test(SRC), 'Track B 가 공고를 직접 INSERT 하면 사본이다');
  assert.ok(!/INSERT INTO work_orders/.test(SRC), 'Track B 가 오더를 직접 INSERT 하면 사본이다');
});

/* ── 4) 프론트 배선 ────────────────────────────────────────── */
console.log('\n4) 프론트 배선');
t('상단탭에 두 버튼', () => {
  assert.ok(/data-v="orders" onclick="switchView\('orders'\)">작업오더/.test(HTML));
  assert.ok(/data-v="campaigns" onclick="switchView\('campaigns'\)">모집공고/.test(HTML));
});
t('★ 관리자·AE 양쪽 nav 에 있다(광고주 nav 는 원래 없음)', () => {
  const adminNav = HTML.slice(HTML.indexOf('${isAdmin?`<nav'), HTML.indexOf(':isStaff?`<nav'));
  const staffNav = HTML.slice(HTML.indexOf(':isStaff?`<nav'), HTML.indexOf('<span class="sp"></span>'));
  ['작업오더', '모집공고'].forEach(n => {
    assert.ok(adminNav.includes(n), '관리자 nav 에 ' + n + ' 없음');
    assert.ok(staffNav.includes(n), 'AE nav 에 ' + n + ' 없음');
  });
  assert.ok(!staffNav.includes('등록리뷰어DB'), 'AE 에게 리뷰어DB 가 열리면 안 됨(별건)');
});
t('switchView 가 두 뷰를 그린다', () => {
  assert.ok(/v==='orders'\) renderOrdersView\(\)/.test(HTML));
  assert.ok(/v==='campaigns'\) renderCampaignsView\(\)/.test(HTML));
});
t('★ 편집 버튼은 서버 판정(canEdit)으로만 노출', () => {
  assert.ok(/api\('\/api\/trackb\/perm'\)/.test(HTML), '권한을 서버에 물어야 한다');
  // 접수·상태변경은 _woEditActions 한 곳에서만 만든다(표 셀과 펼침 패널이 같은 것을 쓴다)
  //   → 게이트도 한 곳뿐이라 "표에는 안 뜨는데 패널에는 뜬다"가 생길 수 없다.
  assert.ok(/function _woEditActions\(o\)\{\s*\n\s*if\(!STATE\.canEdit\) return '';/.test(HTML),
    '작업오더 편집 버튼 게이트 없음');
  assert.strictEqual((HTML.match(/_woAccept\('\$\{id\}'\)/g) || []).length, 1,
    '접수 버튼을 두 곳에서 만들면 게이트가 갈라진다');
  assert.ok(/\$\{STATE\.canEdit\?'<button class="btn pri" onclick="openRecruitModal\(\)/.test(HTML),
    '공고 발행 버튼 게이트 없음');
});
t('열람 전용 계정에 이유를 알려준다(버튼만 사라지면 고장으로 오해)', () => {
  assert.ok(/열람 전용/.test(HTML));
});
t('접수는 되돌리기 어려우니 확인을 받는다', () => {
  // ★ 확인 문구는 무시트/시트 두 갈래로 갈리지만(탈 구글시트 2026-08-10) confirm 게이트 자체는 유지된다.
  // ★ 재접수 우회 변수명은 바뀔 수 있다(pickGid → _confirmed) — 고정하는 것은 **confirm 게이트의 존재**다.
  assert.ok(/이 작업오더를 접수할까요\?/.test(HTML) && /&& !confirm\(msg\)\) return false;/.test(HTML));
});

// ★ 2026-08-19 사용자 확정(AE 권한 확대): 명단 관리는 **내부 담당자(AE 포함)** 가 한다.
//   위 1) 절이 서버 게이트를 `internalMiddleware` 로 이미 고정하고 있으므로, 화면 게이트도 같아야
//   서버보다 좁거나 넓은 버튼이 생기지 않는다(같은 파일 안에서 두 기준이 갈리던 것을 맞춘다).
t('명단 관리 UI — 내부 담당자에게만(광고주 차단), 인트라넷 자동완성 재사용', () => {
  assert.ok(/_isInternalRole\(\)\?'<button class="btn" onclick="openEditorList\(\)/.test(HTML),
    '명단 버튼이 내부 담당자 게이트(_isInternalRole)를 쓰지 않는다 — 서버 게이트와 어긋난다');
  assert.ok(/async function openEditorList\(\)/.test(HTML));
  assert.ok(/api\('\/api\/trackb\/intranet\/users\?q='/.test(HTML),
    '후보는 인트라넷 직원DB에서 골라야 한다(기존 프록시 재사용)');
  assert.ok(/STATE\.canEdit=null;/.test(HTML), '명단 변경 후 내 권한 캐시를 비워야 즉시 반영된다');
});
t('명단에서 빼는 것은 되돌리기 어려우니 확인을 받는다', () => {
  assert.ok(/명단에서 뺄까요\?/.test(HTML));
});

/* ── 5) 작업오더 상세 = 팝업 아닌 펼침행 · 상세 렌더러는 한 벌 ─────── */
console.log('\n5) 작업오더 상세(펼침행 · 공유 렌더러)');
const WOD = F('js/work-order-detail.js');
const APP = F('js/index-app.js');

t('★ 팝업(_modal)이 아니라 표 안에서 펼친다', () => {
  assert.ok(/<tr class="wolrow" id="wolrow-\$\{i\}" onclick="_woToggle\(\$\{i\}\)"/.test(HTML),
    '행 클릭이 펼침 토글이어야 한다');
  assert.ok(/<tr class="woldetail" id="woldetail-\$\{i\}" style="display:none"><td colspan="8">/.test(HTML),
    '상세는 바로 아래 행(colspan)으로 들어가야 한다');
  assert.ok(!/_modal\(`작업오더/.test(HTML), '작업오더 상세를 다시 팝업으로 되돌리면 안 된다');
});
t('펼칠 때 한 번만 그린다(목록 30건이 한꺼번에 첨부 이미지를 받지 않게)', () => {
  assert.ok(/if\(open\) _woFillDetail\(i\);/.test(HTML));
  assert.ok(/if\(!box\|\|box\.dataset\.filled\) return;/.test(HTML), '재렌더 방지 플래그가 없다');
});
t('처리 버튼 클릭이 행 토글로 번지지 않는다', () => {
  // ★ '상세' 버튼은 제거됐다(행을 누르면 펼쳐지므로 하는 일이 겹쳤다) → 처리 셀 = _woEditActions 하나뿐
  assert.ok(/<td style="white-space:nowrap" onclick="event\.stopPropagation\(\)">\$\{_woEditActions\(o\)\}<\/td>/.test(HTML));
  assert.ok(!/function _woActions\s*\(/.test(HTML), "'상세' 버튼 래퍼(_woActions)가 되살아났다 — 행 클릭과 중복");
  assert.ok(/onclick="event\.stopPropagation\(\);_woAccept\(/.test(HTML)
    && /onclick="event\.stopPropagation\(\);_woStatus\(/.test(HTML));
});
t('★★ 펼침행 클래스는 `wol` 접두 — 작업보드 탭의 .worow/.wodetail/.wochip 과 겹치면 표가 무너진다', () => {
  // 실측 사고: `.worow{display:grid}`(작업세부 패널용)가 이 표의 <tr> 에 걸려
  //   8칸이 2열 그리드로 접혔고, `.wochip` 재정의는 그쪽 옵션 칩 색을 바꿔버렸다.
  ['worow', 'wodetail', 'wochip'].forEach(c => {
    assert.ok(!new RegExp('class="' + c + '" id="' + c).test(HTML), c + ' 이름 재사용');
  });
  assert.ok(/\.lgtable tr\.wolrow\{/.test(HTML) && /\.lgtable tr\.woldetail>td\{/.test(HTML));
  // 기존 소유자 규칙이 그대로 살아 있어야 한다(내가 덮어쓰지 않았다는 증거)
  assert.ok(/\n  \.worow\{display:grid;/.test(HTML), '작업세부 패널의 .worow 규칙이 사라졌다');
  assert.ok(/\n  \.wochip\{display:inline-block;/.test(HTML), '작업세부 패널의 .wochip 규칙이 사라졌다');
  assert.strictEqual((HTML.match(/\n  \.wochip\{/g) || []).length, 1, '.wochip 을 두 번 정의하면 뒤엣것이 이긴다');
});

t('★ 상세 본문은 관리자 대시보드와 **같은 렌더러**(사본 금지)', () => {
  assert.ok(/_woDetailHtml\(o\)/.test(HTML), '리뷰웹시스템[3버전]이 공유 렌더러를 호출해야 한다');
  assert.ok(/function _woDetailHtml\(o\) \{/.test(WOD), '렌더러는 모듈에 있어야 한다');
  assert.ok(!/function _woDetailHtml/.test(APP), 'index-app.js 에 사본이 남아 있다');
  assert.ok(!/function _woDetailHtml/.test(HTML), 'workdesk.html 에 사본을 만들면 안 된다');
});
t('두 화면이 같은 모듈을 로드한다(admin·admin-siand·workdesk)', () => {
  ['admin.html', 'admin-siand.html'].forEach(p => {
    const s = F(p);
    // ★ 캐시버스팅 쿼리(?v=…)가 붙을 수 있다 — 고정하는 것은 **그 모듈을 로드한다**는 사실이다.
    assert.ok(/<script src="js\/work-order-detail\.js(\?[^"]*)?"><\/script>/.test(s), p + ' 미로드');
    assert.ok(s.indexOf('js/work-order-detail.js') < s.indexOf('js/index-app.js'),
      p + ': 렌더러가 index-app.js 뒤에 있으면 호출 시점에 없다');
  });
  assert.ok(/<script src="js\/work-order-detail\.js(\?[^"]*)?"><\/script>/.test(HTML), 'workdesk 미로드');
});
t('★ 모듈은 호스트 전역에 기대지 않는다(리뷰웹시스템[3버전]엔 escHtml 이 없다)', () => {
  assert.ok(/function _escFallback\(s\)/.test(WOD) && /function escHtml\(s\)/.test(WOD),
    'escHtml 폴백이 없으면 리뷰웹시스템[3버전]에서 상세가 통째로 터진다');
  // ★ 로드 시점 캡처 금지 — 이 모듈은 index-app.js **앞에** 로드되므로 그때는 window.escHtml 이 없다.
  //   캡처하면 admin 에서도 폴백이 쓰여 원본과 출력이 조용히 달라진다(실측).
  assert.ok(!/var escHtml = \(typeof window/.test(WOD), 'escHtml 을 로드 시점에 캡처하고 있다');
  assert.ok(/\.replace\(\/&\/g, "&amp;"\)\.replace\(\/<\/g, "&lt;"\)\.replace\(\/>\/g, "&gt;"\)\.replace\(\/"\/g, "&quot;"\)/.test(WOD),
    '폴백이 index-app.js 의 escHtml 과 다른 구현이면 출력이 갈라진다');
  // 모듈이 정의하지 않은 _wo* 를 참조하면 리뷰웹시스템[3버전]에서만 죽는다 → 정적으로 막는다
  const defined = new Set([...WOD.matchAll(/^function (_?\w+)\s*\(/gm)].map(m => m[1])
    .concat([...WOD.matchAll(/^const (\w+)\s*=/gm)].map(m => m[1])));
  const used = new Set([...WOD.matchAll(/\b(_wo\w+|_driveId|woImageModal)\s*\(/g)].map(m => m[1]));
  const missing = [...used].filter(n => !defined.has(n));
  assert.deepStrictEqual(missing, [], '모듈 안에서 정의되지 않은 참조: ' + missing.join(', '));
  // ★ 반대 방향 — 관리자 대시보드 전용 전역이 모듈로 딸려오면 리뷰웹시스템[3버전]에서 죽는다.
  //   실측: 함수 범위를 잘못 잡아 woCreateCampaign(showToast·openRecruitModal·_woCache 사용)이
  //   통째로 딸려왔고, 공개 목록에 없어 **admin 의 '공고 발행' 버튼이 조용히 고장**났다.
  const bare = WOD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ['showToast', 'openRecruitModal', '_woCache', 'loadWorkOrders', 'switchAdminTab']
    .forEach(n => assert.ok(!new RegExp('\\b' + n + '\\b').test(bare),
      '관리자 대시보드 전용 전역이 모듈에 섞였다: ' + n));
  // ★ API_BASE_URL(api.js) 은 두 호스트 모두 로드하지만 **최상위 const 라 window 프로퍼티가 아니다** —
  //   모듈이 쓰려면 반드시 `typeof` 가드 뒤에서만(로드 순서가 어긋난 화면에서 ReferenceError 로 죽지 않게).
  const apiUses = (bare.match(/\bAPI_BASE_URL\b/g) || []).length;
  const apiGuarded = (bare.match(/typeof API_BASE_URL !== "undefined" \? API_BASE_URL : ""/g) || []).length;
  assert.strictEqual(apiUses, apiGuarded * 2,
    'API_BASE_URL 을 typeof 가드 없이 쓰면 로드 순서가 다른 화면에서 ReferenceError 로 죽는다');
});
t('★ 전역 공개 — index-app.js 의 기존 호출부·onclick 문자열이 이름 그대로 쓴다', () => {
  ['_woDetailHtml', 'woImageModal', '_woImgError', '_woKv', '_woGuideUrls', '_woManagerNick']
    .forEach(n => assert.ok(new RegExp(n + ': ' + n + '[,\\s]').test(WOD), '미공개: ' + n));
  assert.ok(/window\[k\] = EXPORTS\[k\]/.test(WOD));
  // onclick/onerror 문자열은 전역이어야 동작한다(모듈 스코프면 조용히 죽는다)
  assert.ok(/onclick="woImageModal\(this\.dataset\.openurl\|\|this\.src\)" onerror="_woImgError\(this\)"/.test(WOD));
});
t('첨부 이미지는 클릭하면 크게 본다(라이트박스)', () => {
  assert.ok(/function woImageModal\(url\)/.test(WOD) && /woImgModal/.test(WOD));
  assert.ok(/\.woldoc img\{max-width:min\(100%,360px\)\}/.test(HTML), '펼침행에서 이미지 폭 제한이 없다');
});

console.log(`\n✅ ${pass} checks passed\n`);
process.exit(0);   // trackB.routes 를 require 하면 DB 풀 핸들이 열려 자연 종료가 안 됨
