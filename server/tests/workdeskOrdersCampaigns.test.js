/**
 * workdeskOrdersCampaigns.test.js — 통합 작업대 '작업오더·모집공고' 탭 회귀가드
 * 실행: node tests/workdeskOrdersCampaigns.test.js
 *
 * 이 화면의 위험은 두 가지다.
 *  ① **권한** — 두 탭은 AE 에게도 열려 있는데, 작업오더 접수는 시트/탭 등록의 단일 관문이고
 *     공고 발행·수정은 정원·금액을 바꾼다. 게이트가 한 칸만 어긋나면 아무나 누른다.
 *     → 라우터 스택을 **실제로 검사**한다.
 *  ② **사본 드리프트** — 카드·모달·저장 로직을 통합 작업대용으로 베끼면 관리자 대시보드와
 *     계속 어긋난다(레포가 반복해서 경고한 그것). → 같은 파일을 쓰는지 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('\n▶ 통합 작업대 작업오더·모집공고 회귀가드\n');

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
t('명단 관리는 master/admin 전용(AE 가 자기를 명단에 넣지 못하게)', () => {
  ['GET /workdesk-editors', 'POST /workdesk-editors', 'DELETE /workdesk-editors/:id'].forEach(k => {
    assert.ok(L[k], '없음: ' + k);
    assert.ok(L[k].includes('adminOrMasterMiddleware'), k + ': adminOrMaster 게이트 없음');
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
  assert.strictEqual((MODAL.match(/id="rf_title"/g) || []).length, 1, '공유 모듈에 모달이 없다');
  assert.strictEqual((HTML.match(/id="rf_title"/g) || []).length, 0,
    '통합 작업대가 모달을 베끼면 안 된다 — 모듈을 마운트해야 한다');
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
t('★ 통합 작업대는 목록·저장 로직을 베끼지 않고 그대로 호출', () => {
  assert.ok(/await loadRecruitList\(\)/.test(HTML), 'index-recruit.js 의 로더를 써야 한다');
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
  assert.ok(/if\(!STATE\.canEdit\) return btn;/.test(HTML), '작업오더 편집 버튼 게이트 없음');
  assert.ok(/\$\{STATE\.canEdit\?'<button class="btn pri" onclick="openRecruitModal\(\)/.test(HTML),
    '공고 발행 버튼 게이트 없음');
});
t('열람 전용 계정에 이유를 알려준다(버튼만 사라지면 고장으로 오해)', () => {
  assert.ok(/열람 전용/.test(HTML));
});
t('접수는 되돌리기 어려우니 확인을 받는다', () => {
  assert.ok(/confirm\('이 작업오더를 접수할까요\?/.test(HTML));
});

t('명단 관리 UI — 관리자에게만, 인트라넷 자동완성 재사용', () => {
  assert.ok(/STATE\.role==='master'\|\|STATE\.role==='admin'\)\?'<button class="btn" onclick="openEditorList\(\)/.test(HTML),
    '명단 버튼이 관리자 전용이 아님');
  assert.ok(/async function openEditorList\(\)/.test(HTML));
  assert.ok(/api\('\/api\/trackb\/intranet\/users\?q='/.test(HTML),
    '후보는 인트라넷 직원DB에서 골라야 한다(기존 프록시 재사용)');
  assert.ok(/STATE\.canEdit=null;/.test(HTML), '명단 변경 후 내 권한 캐시를 비워야 즉시 반영된다');
});
t('명단에서 빼는 것은 되돌리기 어려우니 확인을 받는다', () => {
  assert.ok(/명단에서 뺄까요\?/.test(HTML));
});

console.log(`\n✅ ${pass} checks passed\n`);
process.exit(0);   // trackB.routes 를 require 하면 DB 풀 핸들이 열려 자연 종료가 안 됨
