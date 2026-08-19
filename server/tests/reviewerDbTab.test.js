/**
 * reviewerDbTab.test.js — 리뷰웹시스템[3버전] '등록리뷰어DB' 탭 회귀가드
 * 실행: node tests/reviewerDbTab.test.js        (서버 기동 불필요)
 *       PGTEST_URL=postgres://... node tests/reviewerDbTab.test.js   (진짜 PG로 SQL까지 검증)
 *
 * 왜 이렇게 짜는가
 *  - 이 탭은 **주민번호·계좌번호**를 그대로 보여준다. 권한이 한 칸만 어긋나도
 *    AE·광고주에게 전사 개인정보가 열린다 → 라우터 스택을 **실제로 검사**한다.
 *  - 검색·페이지네이션 SQL은 파라미터 번호가 어긋나도 조용히 깨지지 않고 500이 난다.
 *    개발 중 실제로 "숫자 없는 이름 검색"에서 bind 파라미터 개수가 안 맞는 버그가 있었다
 *    → 쿼리 조립을 **그대로 실행**해 자리표시자와 파라미터 개수 일치를 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('\n▶ 등록리뷰어DB 탭 회귀가드\n');

/* ── 1) 권한 — 라우터 스택 실검사 ──────────────────────────── */
console.log('1) 권한');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const router = require('../src/routes/trackB.routes');
const layers = router.stack.filter(l => l.route).map(l => ({
  path: l.route.path,
  methods: Object.keys(l.route.methods),
  mw: l.route.stack.map(s => s.name),
}));
const list = layers.find(l => l.path === '/reviewers');
const memo = layers.find(l => l.path === '/reviewers/memo');

t('목록·메모 라우트가 등록돼 있다', () => {
  assert.ok(list && list.methods.includes('get'), 'GET /reviewers 없음');
  assert.ok(memo && memo.methods.includes('post'), 'POST /reviewers/memo 없음');
});
t('★ 둘 다 adminOrMaster 게이트 뒤 — AE(staff)·광고주 차단', () => {
  [list, memo].forEach(l => {
    assert.ok(l.mw.includes('authMiddleware'), l.path + ': authMiddleware 없음');
    assert.ok(l.mw.includes('adminOrMasterMiddleware'), l.path + ': adminOrMasterMiddleware 없음');
    assert.ok(!l.mw.includes('internalMiddleware'),
      l.path + ': internalMiddleware 는 staff 를 통과시킨다 — 리뷰어DB엔 쓰면 안 됨');
  });
});
t('★ 인트라넷 SSO 토큰이 도달할 수 있는 경로에 둔다(/api/trackb/*)', () => {
  const auth = R('src/middleware/auth.middleware.js');
  assert.ok(/intranet[\s\S]{0,400}trackb/i.test(auth),
    'via:intranet 토큰은 /api/trackb/* 로 격리 — 리뷰어DB를 다른 마운트에 두면 SSO 관리자가 못 쓴다');
});

/* ── 2) 쿼리 조립 — 자리표시자 ↔ 파라미터 개수 ────────────── */
console.log('\n2) 쿼리 조립(파라미터 정합)');

/** 라우트와 **동일한** 조립 로직(변경 시 여기도 깨져야 하므로 소스에서 뽑아 쓴다) */
const SRC = R('src/routes/trackB.routes.js');
t('라우트가 안 쓸 파라미터를 push 하지 않는다(회귀 방지)', () => {
  const fn = SRC.slice(SRC.indexOf("router.get('/reviewers'"), SRC.indexOf("router.post('/reviewers/memo'"));
  assert.ok(/const d = q\.replace\(\/\[\^0-9\]\/g, ''\);/.test(fn), '숫자 추출부가 사라짐');
  assert.ok(/if \(d\.length >= 4\) \{[\s\S]{0,200}params\.push/.test(fn),
    "★ 숫자 부분일치는 4자리부터(2026-08-19 오삭제 사고 — 'E2E블로거'의 '22'가 연락처 부분일치로 " +
    '번져 무관한 리뷰어 수십 명이 결과에 섞였다). 문서화된 용례 = 전화 뒤4자리 검색.');
  assert.ok(/LIMIT \$\$\{params\.length - 1\} OFFSET \$\$\{params\.length\}/.test(fn),
    'LIMIT/OFFSET 자리표시자 계산이 바뀜');
});

function build({ q = '', status = '', limit = 50, offset = 0 }) {
  const where = [], params = [];
  if (q) {
    const d = q.replace(/[^0-9]/g, '');
    const ors = [];
    params.push('%' + q + '%'); ors.push(`name ILIKE $${params.length}`);
    if (d.length >= 4) { params.push('%' + d + '%'); ors.push(`REGEXP_REPLACE(phone,'[^0-9]','','g') LIKE $${params.length}`); }
    where.push('(' + ors.join(' OR ') + ')');
  }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const countSql = `SELECT COUNT(*)::int AS n FROM reviewers ${w}`;
  const countParams = params.slice();
  const p2 = params.slice(); p2.push(limit); p2.push(offset);
  const listSql = `SELECT id FROM reviewers ${w} ORDER BY registered_at DESC
    LIMIT $${p2.length - 1} OFFSET $${p2.length}`;
  return { countSql, countParams, listSql, listParams: p2 };
}
/** SQL 안의 최대 $n 이 넘긴 파라미터 개수와 정확히 같아야 한다(초과=500, 미달=미사용) */
function maxPlaceholder(sql) {
  let m, max = 0;
  const re = /\$(\d+)/g;
  while ((m = re.exec(sql))) max = Math.max(max, parseInt(m[1], 10));
  return max;
}
const CASES = [
  ['검색 없음', {}],
  ['★ 숫자 없는 이름 검색', { q: '이시현' }],
  ['숫자만 검색', { q: '7701' }],
  ['하이픈 포함 검색', { q: '010-1111-2222' }],
  ['★ 혼합 검색어(숫자 3자리 이하)', { q: 'E2E블로거' }],
  ['상태만', { status: 'active' }],
  ['검색+상태', { q: '김하나', status: 'inactive' }],
  ['숫자검색+상태', { q: '1111', status: 'active' }],
  ['페이지 2', { offset: 50 }],
];
CASES.forEach(([label, opt]) => {
  t(`${label} — 자리표시자와 파라미터 개수 일치`, () => {
    const b = build(opt);
    assert.strictEqual(maxPlaceholder(b.countSql), b.countParams.length,
      `count 불일치: ${b.countSql} / ${b.countParams.length}개`);
    assert.strictEqual(maxPlaceholder(b.listSql), b.listParams.length,
      `list 불일치: ${b.listSql} / ${b.listParams.length}개`);
  });
});
t('페이지 크기 상한이 있다(전 행 덤프 방지)', () => {
  const fn = SRC.slice(SRC.indexOf("router.get('/reviewers'"), SRC.indexOf("router.post('/reviewers/memo'"));
  assert.ok(/Math\.min\(200,/.test(fn), 'limit 상한이 없으면 목록 하나로 전 리뷰어를 덤프할 수 있다');
});
t('메모는 id(UUID) 로만 지목하고 길이를 자른다', () => {
  const fn = SRC.slice(SRC.indexOf("router.post('/reviewers/memo'"));
  assert.ok(/\[0-9a-f\]\{8\}-/.test(fn), 'UUID 형식 검증 없음');
  assert.ok(/\.slice\(0, 2000\)/.test(fn), '메모 길이 상한 없음');
  assert.ok(/UPDATE reviewers SET admin_memo = \$2 WHERE id = \$1/.test(fn),
    '메모 외 컬럼을 쓰면 안 된다(조회 전용 원칙)');
});
t('★ 메모 라우트가 admin_memo 외의 컬럼을 건드리지 않는다', () => {
  const fn = SRC.slice(SRC.indexOf("router.post('/reviewers/memo'"), SRC.indexOf("router.get('/reviewer-logs'"));
  const sets = fn.match(/SET\s+([a-z_]+)\s*=/g) || [];
  assert.deepStrictEqual(sets, ['SET admin_memo ='], '메모 외 컬럼 수정 경로가 생김: ' + sets.join(','));
});

/* ── 3) 프론트 배선 ────────────────────────────────────────── */
console.log('\n3) 프론트');
const HTML = F('workdesk.html');
t('상단탭에 등록리뷰어DB 버튼', () => {
  assert.ok(/data-v="reviewers" onclick="switchView\('reviewers'\)">등록리뷰어DB</.test(HTML));
});
t('★ 버튼이 관리자 nav 에만 있다(AE nav 에는 없음)', () => {
  const adminNav = HTML.slice(HTML.indexOf('${isAdmin?`<nav'), HTML.indexOf(':isStaff?`<nav'));
  const staffNav = HTML.slice(HTML.indexOf(':isStaff?`<nav'), HTML.indexOf('<span class="sp"></span>'));
  assert.ok(adminNav.includes('등록리뷰어DB'), '관리자 nav 에 없음');
  assert.ok(!staffNav.includes('등록리뷰어DB'), 'AE(staff) nav 에 있으면 안 됨');
});
t('switchView 가 새 뷰를 그린다', () => {
  assert.ok(/v==='reviewers'\) renderReviewersView\(\)/.test(HTML));
  assert.ok(/async function renderReviewersView\(\)/.test(HTML));
});
t('서버 검색·페이지네이션을 쓴다(전 행 클라 로딩 금지)', () => {
  assert.ok(HTML.includes("api('/api/trackb/reviewers?'+qs.toString())"), '쿼리스트링 조회가 아님');
  assert.ok(/limit:String\(RV_PAGE\), offset:String\(STATE\.rvOffset\|\|0\)/.test(HTML), '페이지 파라미터 없음');
  // ★ 주석에 적힌 설명(왜 안 쓰는지)까지 잡으면 위양성 — **실제 호출**만 본다
  assert.ok(!/api\(\s*['"`][^'"`]*\/api\/reviewer\/list/.test(HTML),
    '전 행을 한 번에 반환하는 /api/reviewer/list 를 호출하면 안 된다');
});
t('민감정보 상시 노출 경고를 띄운다', () => {
  assert.ok(/주민등록번호·계좌번호가 그대로 표시/.test(HTML), '화면공유 주의 문구 없음');
});
t('메모만 편집 가능(다른 칸은 입력창이 아니다)', () => {
  const body = HTML.slice(HTML.indexOf('function _renderRvBody()'), HTML.indexOf('/* 타계정 펼침'));
  const inputs = body.match(/<input/g) || [];
  assert.strictEqual(inputs.length, 1, '표에 입력창은 메모 하나뿐이어야 함(현재 ' + inputs.length + '개)');
  assert.ok(body.includes('_rvSaveMemo('), '메모 저장 배선 없음');
});
t('값이 안 바뀌면 저장 요청을 보내지 않는다', () => {
  const fn = HTML.slice(HTML.indexOf('async function _rvSaveMemo'), HTML.indexOf('async function _rvDelete'));
  // ★ 저장은 이제 [저장] 버튼/Enter 로만 일어나지만(사용자 확정), "무변경이면 요청 0" 은 그대로여야 한다.
  //   버튼 상태를 함께 되돌리느라 `) return;` 이 `){ … return; }` 로 바뀌었을 뿐 — 조건과 위치를 확인한다.
  assert.ok(/String\(row\.memo\|\|''\)===String\(memo\)\)\{[\s\S]{0,120}?return;/.test(fn), '무변경 조기 return 없음');
  assert.ok(fn.indexOf('return;') < fn.indexOf("api('/api/trackb/reviewers/memo'"),
    '무변경 return 이 저장 요청보다 뒤에 있다(=요청이 먼저 나간다)');
  assert.ok(/el\.value=row\.memo\|\|'';/.test(fn), '저장 실패 시 화면값 되돌리기 없음');
});

/* ── 4) 진짜 PG(선택) ─────────────────────────────────────── */
if (process.env.PGTEST_URL) {
  console.log('\n4) 실제 PG 검증');
  const { Client } = require('pg');
  (async () => {
    const c = new Client({ connectionString: process.env.PGTEST_URL });
    await c.connect();
    try {
      for (const [label, opt] of CASES) {
        const b = build(opt);
        await c.query(b.countSql, b.countParams);
        await c.query(b.listSql, b.listParams);
        console.log('  ✓ PG 실행: ' + label);
        pass++;
      }
      console.log(`\n${pass} checks passed`);
    } finally { await c.end(); }
    process.exit(0);   // 열린 핸들(트랙B 라우트의 DB 풀) 때문에 자연 종료가 안 됨
  })().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
} else {
  console.log('\n(PGTEST_URL 미설정 — SQL 실행 검증은 건너뜀)');
  console.log(`\n${pass} checks passed`);
  // trackB.routes 를 require 하면 DB 풀·타이머 핸들이 열려 프로세스가 스스로 안 끝난다
  process.exit(0);
}
