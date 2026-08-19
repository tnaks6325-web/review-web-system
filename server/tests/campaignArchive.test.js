/**
 * campaignArchive.test.js — 모집공고 보관(폐기) 회귀가드 (migration 130)
 * 실행: node tests/campaignArchive.test.js
 *   (PGTEST_URL 있으면 진짜 PG 로 마이그레이션·필터·멱등까지 실행 확인)
 *
 * 왜 필요한가: 종전엔 끝난 공고를 치우는 수단이 **하드 삭제뿐**이었고, 그 DELETE 는
 *   FK CASCADE 로 참여 이력·리뷰비 스냅샷·정산 연결까지 함께 지운다. 그래서 실제로는
 *   아무도 못 치웠고 closed 공고가 리뷰어 목록에 영구히 남았다(실측 2026-08-19: 32건 중
 *   closed 5 + [TEST] draft 3 = 목록의 25%가 "끝났는데 남아 있는" 상태).
 *
 * 고정하는 것:
 *  A. 마이그레이션 모양 — 컬럼 추가만·백필 0·CHECK 0(배포 즉시 동작 불변).
 *  B. 노출 — 공개 /list 와 관리자 /admin/list 에서 제외, 보관함(?archived=1)은 보관분만.
 *  C. 참여(apply) 차단 — 목록엔 없는데 링크로는 참여되는 상태를 만들지 않는다.
 *  D. fail-closed — 살아 있는 홀드·블로그 승인 대기가 있으면 보관 거부(참여 소각 방지).
 *  E. 삭제는 참여 이력이 있으면 거부하고 보관으로 안내(데이터 파괴 차단).
 *  F. 자동 보관 없음 — 제안 조건은 **작업표의 모든 줄이 채워진 경우**뿐(사용자 확정).
 *  G. 권한 — 스코프 토큰 도달 불가 · 라우터 스택 실검사.
 *  H. 프론트 — 배지·[⋯] 메뉴·보관함 토글·확인창.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const routes = read('src/routes/campaign.routes.js');
const trackb = read('src/routes/trackB.routes.js');
const svcSrc = read('src/services/campaignArchive.service.js');
const indexJs = read('index.js');
const migration = read('migrations/130_campaign_archive.sql');
const cards = read('../frontend/js/campaign-cards.js');
const recruitJs = read('../frontend/js/index-recruit.js');
const adminHtml = read('../frontend/admin.html');
const workdesk = read('../frontend/workdesk.html');

/* 스텁 pool — 라우트를 **실제로 실행**하기 위해 require 캐시에 미리 심는다.
   ★ 정적 검사만으로는 `if (false && …)` 같은 무력화를 통과시킨다(변이시험이 실제로 뚫었다). */
const _poolPath = require.resolve('../src/db/pool');
let _poolCalls = [];
let _poolHandler = () => ({ rows: [] });
require.cache[_poolPath] = {
  id: _poolPath, filename: _poolPath, loaded: true,
  exports: { query: async (sql, params) => { _poolCalls.push({ sql, params }); return _poolHandler(sql, params); } },
};

let passed = 0;
function ok(name, cond, extra) {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
}
/** 라우트 본문만 잘라낸다 — 파일 전체로 검사하면 다른 라우트의 같은 표현이 대신 통과시킨다. */
function routeBody(src, decl) {
  const i = src.indexOf(decl);
  assert(i > -1, '라우트를 찾지 못함: ' + decl);
  const j = src.indexOf('\nrouter.', i + 10);
  return src.slice(i, j > i ? j : src.length);
}

// ── A. 마이그레이션 ──────────────────────────────────────────
console.log('\n[A] 마이그레이션 130');
ok('archived_at / archived_by 컬럼 추가', /ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ/.test(migration)
  && /ADD COLUMN IF NOT EXISTS archived_by TEXT/.test(migration));
ok('★ 백필 0 — UPDATE 문이 없다(배포 즉시 동작 불변)', !/\bUPDATE\s+recruit_campaigns/i.test(migration));
ok('★ status CHECK 를 건드리지 않는다(상태 축이 아니라 노출 축)',
  !/CHECK\s*\(/i.test(migration) && !/DROP CONSTRAINT/i.test(migration));
ok('★ REQUIRED_SCHEMA 등록(컬럼 누락 = 목록 전면 42703)',
  /\['recruit_campaigns', 'archived_at'\]/.test(indexJs));

// ── B. 노출 ────────────────────────────────────────────────
console.log('\n[B] 목록에서 내린다');
{
  const list = routeBody(routes, "router.get('/list'");
  ok('★ 공개 /list 가 보관 공고를 제외 — 리뷰어 노출의 유일한 출처', /AND archived_at IS NULL/.test(list));
}
{
  const admin = routeBody(routes, "router.get('/admin/list'");
  ok('★ 관리자 목록도 기본은 보관 제외', /WHERE archived_at IS \$\{_archivedView \? 'NOT NULL' : 'NULL'\}/.test(admin));
  ok('★ 보관함 보기(?archived=1) — 서버가 통째로 거르면 보관함이 영원히 빈다',
    /req\.query\.archived/.test(admin));
  ok('보관 건수를 응답에 실어 목록에서 빠진 수를 화면이 말한다', /archivedCount: _archivedCount/.test(admin));
  ok('★ 건수 조회 실패는 null(0 으로 위장 금지)', /let _archivedCount = null/.test(admin));
}

// ── C. 참여 차단 ────────────────────────────────────────────
console.log('\n[C] 보관된 공고는 참여를 받지 않는다');
{
  const apply = routeBody(routes, "router.post('/:id/apply'");
  ok("★ apply 게이트에 archived 차단", /if \(camp\.archived_at\)[\s\S]{0,200}reason: 'archived'/.test(apply));
  // 참여형 분기(_applyParticipation)보다 **앞**이어야 두 경로가 함께 막힌다
  const iArc = apply.indexOf('camp.archived_at');
  const iPart = apply.indexOf('_applyParticipation');
  ok('★ 레거시·참여형 분기보다 앞 — 한 곳에서 두 경로를 막는다', iArc > -1 && iPart > -1 && iArc < iPart,
    { iArc, iPart });
}

// ── D. fail-closed(살아 있는 참여) ───────────────────────────
console.log('\n[D] 살아 있는 참여가 있으면 보관 거부');
{
  const svc = require('../src/services/campaignArchive.service');
  const calls = [];
  const stub = (rowsBy) => ({ query: async (sql, params) => { calls.push({ sql, params }); return rowsBy(sql); } });

  // 유효 홀드 2건 → 거부 + 쓰기 0
  (async () => {
    calls.length = 0;
    const db = stub((sql) => {
      if (/FROM recruit_campaigns WHERE id/.test(sql)) return { rows: [{ id: 'c1', title: 'T', archived_at: null }] };
      if (/FROM campaign_applications/.test(sql)) return { rows: [{ holds: '2', blog_pending: '0' }] };
      return { rows: [] };
    });
    const out = await svc.archiveCampaign(db, 'c1', 'master');
    ok('★ 유효 홀드가 있으면 거부(참여 소각 방지)', out.ok === false && out.code === 'blocked', out);
    ok('★ 거부 시 UPDATE 0건(쓰기 표면 무접촉)', !calls.some(c => /UPDATE recruit_campaigns/.test(c.sql)));
    ok('사유를 문장으로 말한다(무엇을 기다려야 하는지)', /진행 중인 참여/.test(out.error));

    // 블로그 승인 대기도 같은 갈래
    const db2 = stub((sql) => {
      if (/FROM recruit_campaigns WHERE id/.test(sql)) return { rows: [{ id: 'c1', archived_at: null }] };
      if (/FROM campaign_applications/.test(sql)) return { rows: [{ holds: '0', blog_pending: '3' }] };
      return { rows: [] };
    });
    const out2 = await svc.archiveCampaign(db2, 'c1', 'm');
    ok('★ 블로그 승인 대기도 보관 거부', out2.ok === false && out2.blockers.some(b => b.code === 'blog_pending'));

    // 정상 보관
    calls.length = 0;
    const db3 = stub((sql) => {
      if (/FROM recruit_campaigns WHERE id/.test(sql)) return { rows: [{ id: 'c1', archived_at: null }] };
      if (/FROM campaign_applications/.test(sql)) return { rows: [{ holds: '0', blog_pending: '0' }] };
      if (/UPDATE recruit_campaigns/.test(sql)) return { rows: [{ archived_at: '2026-08-19T00:00:00Z' }] };
      return { rows: [] };
    });
    const out3 = await svc.archiveCampaign(db3, 'c1', 'master');
    ok('참여가 없으면 보관된다', out3.ok === true && !!out3.archivedAt, out3);
    const upd = calls.find(c => /UPDATE recruit_campaigns/.test(c.sql));
    ok('★ 쓰기 표면 = archived_at/archived_by 두 칸뿐',
      /SET archived_at = NOW\(\), archived_by = \$2, updated_at = NOW\(\)/.test(upd.sql));
    ok('★ 보관 UPDATE 는 archived_at IS NULL 조건(경합 이중 기록 방지)',
      /WHERE id = \$1 AND archived_at IS NULL/.test(upd.sql));

    // 이미 보관됨 = 멱등 성공(검사 쿼리 없이 즉시)
    const db4 = stub((sql) => /FROM recruit_campaigns WHERE id/.test(sql)
      ? { rows: [{ id: 'c1', archived_at: '2026-01-01' }] } : { rows: [] });
    const out4 = await svc.archiveCampaign(db4, 'c1', 'm');
    ok('이미 보관된 공고는 멱등 성공', out4.ok === true && out4.already === true);

    // 해제
    const db5 = stub((sql) => /UPDATE recruit_campaigns/.test(sql) ? { rows: [{ id: 'c1' }] } : { rows: [] });
    const out5 = await svc.unarchiveCampaign(db5, 'c1');
    ok('보관 해제', out5.ok === true && !out5.already);
    ok('★ 해제는 archived_by 를 지우지 않는다(누가 보관했나의 유일한 기록)',
      !/SET[^;]*archived_by\s*=\s*NULL/.test(svcSrc));

    // ── F. 제안 판정 ──
    console.log('\n[F] 보관 제안 — 작업표가 다 찼을 때만');
    const dbS = { query: async () => ({ rows: [
      { sheet_id: 's1', tab_name: 't1', total: '50', filled: '50' },
      { sheet_id: 's1', tab_name: 't2', total: '50', filled: '49' },
    ] }) };
    const sug = await svc.archiveSuggestions(dbS, [
      { id: 'full', linked_sheet_id: 's1', linked_tab_name: 't1' },
      { id: 'part', linked_sheet_id: 's1', linked_tab_name: 't2' },
      { id: 'notab', linked_sheet_id: 's1', linked_tab_name: 'none' },
    ]);
    ok('★ 모든 줄이 채워지면 제안', sug.get('full') && sug.get('full').full === true);
    ok('★ 한 줄이라도 비면 제안하지 않는다', sug.get('part') && sug.get('part').full === false);
    ok('★ 표가 없으면 판정 자체를 하지 않는다(0/0 을 "다 찼다"로 읽지 않는다)', !sug.has('notab'));

    const dbZero = { query: async () => ({ rows: [{ sheet_id: 's1', tab_name: 't1', total: '0', filled: '0' }] }) };
    const sugZ = await svc.archiveSuggestions(dbZero, [{ id: 'z', linked_sheet_id: 's1', linked_tab_name: 't1' }]);
    ok('★ 빈 표(0줄)도 제안하지 않는다', !sugZ.has('z'));

    const dbFail = { query: async () => { throw new Error('boom'); } };
    const sugF = await svc.archiveSuggestions(dbFail, [{ id: 'x', linked_sheet_id: 's', linked_tab_name: 't' }]);
    ok('★ 조회 실패 = null(제안 없음, 목록은 그대로 뜬다)', sugF === null);

    const sugArc = await svc.archiveSuggestions({ query: async () => { throw new Error('불려선 안 됨'); } },
      [{ id: 'a', linked_sheet_id: 's', linked_tab_name: 't', archived_at: '2026-01-01' }]);
    ok('이미 보관된 공고는 제안 대상이 아니다(쿼리도 안 나간다)', sugArc instanceof Map && sugArc.size === 0);

    ok('★★ 자동 보관 없음 — 서비스에 "제안이 곧 실행" 경로가 없다(archiveSuggestions 가 archiveCampaign 을 부르지 않는다)',
      !/archiveSuggestions[\s\S]*?archiveCampaign\s*\(/.test(svcSrc.slice(svcSrc.indexOf('async function archiveSuggestions'))));

    finish();
  })().catch((e) => { console.error('\n✗ ' + e.message); process.exit(1); });
}

function finish() {
  // ── E. 삭제 ────────────────────────────────────────────────
  console.log('\n[E] 삭제는 참여 이력이 있으면 거부 → 보관으로 안내');
  {
    const del = routeBody(routes, "router.delete('/admin/:id'");
    ok('★ 참여 이력 건수를 먼저 센다', /FROM campaign_applications WHERE campaign_id = \$1/.test(del));
    ok('★ 1건이라도 있으면 409 로 거부', /has_applications/.test(del) && /409/.test(del));
    ok('★ 세지 못하면 지우지 않는다(fail-closed)', /unknown_history/.test(del));
    ok('★ 안내 문구가 보관을 가리킨다', /보관/.test(del));
    const iCount = del.indexOf('campaign_applications');
    const iDel = del.indexOf("DELETE FROM recruit_campaigns");
    ok('★ 검사가 DELETE 보다 앞', iCount > -1 && iDel > -1 && iCount < iDel, { iCount, iDel });
    // ★ 주석 문구가 아니라 **실제 우회 경로**가 없는지 본다(주석의 'force' 가 통과시키지 않게)
    ok('★ force 우회를 두지 않는다', !/(req\.(body|query)[^\n]*force|\bforce\b\s*(===|\?\?|\|\|))/.test(del));
  }

  // ── E2. 삭제 게이트 **실행** ────────────────────────────────
  console.log('\n[E2] 삭제 라우트 실제 실행');
  {
    const campRouter = require('../src/routes/campaign.routes');
    const layer = campRouter.stack.find(l => l.route && l.route.path === '/admin/:id' && l.route.methods.delete);
    assert(layer, 'DELETE /admin/:id 라우트를 찾지 못함');
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;
    const run = async (appsCount, opts) => {
      _poolCalls = [];
      _poolHandler = (sql) => {
        if (/FROM campaign_applications/.test(sql)) {
          if (opts && opts.throwOnCount) throw new Error('count failed');
          return { rows: [{ n: String(appsCount) }] };
        }
        if (/DELETE FROM recruit_campaigns/.test(sql)) return { rowCount: 1 };
        return { rows: [] };
      };
      let code = 200, body = null;
      const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
      await handle({ params: { id: 'c1' }, body: {}, query: {}, admin: { name: 'master' } }, res, () => {});
      return { code, body, deleted: _poolCalls.some(c => /DELETE FROM recruit_campaigns/.test(c.sql)) };
    };
    return Promise.resolve().then(async () => {
      const r1 = await run(3);
      ok('★★ 참여 이력이 있으면 409 로 거부하고 **DELETE 를 실행하지 않는다**',
        r1.code === 409 && r1.body && r1.body.code === 'has_applications' && r1.deleted === false, r1);
      const r2 = await run(0);
      ok('참여 0건(오발행분)은 종전대로 삭제된다', r2.body && r2.body.ok === true && r2.deleted === true, r2);
      const r3 = await run(0, { throwOnCount: true });
      ok('★★ 세지 못하면 지우지 않는다(fail-closed) — DELETE 미실행',
        r3.code === 503 && r3.body && r3.body.code === 'unknown_history' && r3.deleted === false, r3);
      finishRest();
    });
  }
}

function finishRest() {
  // ── G. 권한·라우터 ──────────────────────────────────────────
  console.log('\n[G] 권한');
  {
    const arc = routeBody(routes, "router.post('/admin/:id/archive'");
    ok('★ adminOrMaster 게이트', /authMiddleware, adminOrMasterMiddleware/.test(arc));
    ok('archived 는 boolean 명시(빈 요청이 곧 보관이 되지 않게)', /typeof want !== 'boolean'/.test(arc));
    ok('42703(마이그레이션 미적용)은 not_ready 로 말한다', /not_ready/.test(arc));
  }
  ok('★ Track B 프록시 — 인트라넷 SSO 토큰이 닿는 경로',
    /router\.post\('\/campaigns\/:id\/archive', authMiddleware, internalMiddleware, editorOnlyMiddleware/.test(trackb));
  {
    // 라우터 스택 실검사 — 문자열이 아니라 실제로 등록됐는지
    const campRouter = require('../src/routes/campaign.routes');
    const has = campRouter.stack.some(l => l.route && l.route.path === '/admin/:id/archive' && l.route.methods.post);
    ok('★ 라우터 스택에 실제 등록(POST /admin/:id/archive)', has);
    const tbRouter = require('../src/routes/trackB.routes');
    const has2 = tbRouter.stack.some(l => l.route && l.route.path === '/campaigns/:id/archive' && l.route.methods.post);
    ok('★ 라우터 스택에 실제 등록(POST /campaigns/:id/archive)', has2);
  }
  ok('★ 스코프 토큰(리뷰어앱 공고수정)이 못 바꾼다 — _scopedCampaignEdit SET 절에 archived_at 없음',
    !/UPDATE recruit_campaigns SET\s+title=\$2[\s\S]*?archived_at[\s\S]*?WHERE id=\$1 RETURNING/.test(routes));

  // ── H. 프론트 ──────────────────────────────────────────────
  console.log('\n[H] 화면');
  ok('★ 보관 배지는 관리자 화면에서만(admin 분기)', /const arcBadge = \(admin && c\.archived_at\)/.test(cards));
  ok('★ 보관 제안 배지도 admin 분기 + full 일 때만', /c\.archiveSuggest\.full === true/.test(cards)
    && /const sug = admin && !c\.archived_at/.test(cards));
  ok('★ 판정 불가는 아무 말도 하지 않는다(archiveSuggest 없으면 배지 없음)',
    /c\.archiveSuggest && c\.archiveSuggest\.full === true/.test(cards));
  ok('★ 보관/해제는 [⋯] 메뉴 안(주 줄 3개 고정 규율)',
    /_ACT_MORE\[c\.id\] = \[planBtn, gateBtn, arcBtn\]/.test(cards));
  ok('★ onclick 은 id 만 넘긴다(문자열 보간 XSS 금지)',
    /CampCards\.toggleArchive\('\$\{id\}',(true|false)\)/.test(cards));
  ok('★ 보관 중에는 게시 토글 대신 표기(목록엔 없는데 active 가 되는 상태 방지)',
    /const pubToggle = c\.archived_at/.test(cards));
  ok('★ 확인창을 거친다', /window\.confirm\(msg\)/.test(cards));
  ok('★ 확인창이 되돌릴 수 있다는 사실을 말한다', /되돌릴 수 있습니다/.test(cards));
  /* ★★ 문구가 "무엇이 닫히는가"를 정확히 말한다(사용자 신고 2026-08-19).
     종전 '참여가 닫힙니다'는 **이미 참여한 리뷰어의 참여까지 끊긴다**로 읽혔다 —
     실제로 닫히는 것은 새 참여 신청뿐이고, 리뷰 내역·제출·리뷰비는 그대로 진행된다.
     ★ 아래 [J] 가 그 사실(리뷰어 경로에 보관 필터 0)을 함께 고정하므로 문구와 코드가 갈리지 않는다. */
  ok('★★ 확인창이 "새 참여 신청"이 닫힌다고 말한다(이미 참여한 사람과 구분)',
    /새 참여 신청이 닫힙니다/.test(cards));
  ok('★★ 확인창이 이미 참여한 리뷰어는 영향 없음을 명시', /이미 참여한 리뷰어는 영향 없습니다/.test(cards));
  ok('★ 오해를 부르던 옛 문구가 남아 있지 않다', !/리뷰어 목록에서 빠지고 참여가 닫힙니다/.test(cards));

  // ── J. 리뷰어 대면 경로 무접촉 ──────────────────────────────
  console.log('\n[J] 이미 참여한 리뷰어는 영향 없다');
  {
    /* 보관은 **노출 축**이다 — 리뷰 내역·리뷰 캡처 제출·받을 예정/누적 금액·입금 대상 추출·
       이미지 교체요청은 review_index·order_submissions·campaign_participants 에서 나오므로
       보관 필터가 그쪽에 **한 곳도 없어야** 한다(생기면 미제출·미입금 리뷰어의 화면이 사라진다). */
    for (const f of ['services/search.service.js', 'routes/reviewer.routes.js',
      'services/payment.service.js', 'routes/submit.routes.js', 'routes/reviewEdit.routes.js']) {
      const src = read('src/' + f);
      ok(`★★ ${f} 에 보관 필터 없음(미제출·미입금 리뷰어 화면 보존)`, !/archived_at/.test(src));
    }
  }

  // ── K. 소스 위생 ───────────────────────────────────────────
  console.log('\n[K] 소스 위생');
  {
    /* ★ 리터럴 NUL 금지 — git 이 파일을 **바이너리로 취급**해 grep·grep 기반 회귀가드가
       그 파일에서 통째로 무력화된다(레포 실측 규율). 구분자는 '\u0000' 이스케이프 표기로. */
    const raw = fs.readFileSync(path.join(__dirname, '..', 'src/services/campaignArchive.service.js'));
    ok('★★ 새 서비스에 리터럴 NUL 0개(가드 무력화 방지)', !raw.includes(0x00));
    ok('구분자는 이스케이프 표기로 유지', /\$\{sheetId\}\\u0000\$\{tabName\}/.test(svcSrc));
  }
  ok('★ 경로는 호스트가 재기준(_campAdminBase — 인트라넷 토큰은 /api/trackb/* 로만 닿는다)',
    /_apiBase\(\) \+ _campAdminBase\(\) \+ '\/' \+ encodeURIComponent\(campId\) \+ '\/archive'/.test(cards));
  ok('CampCards 에 export', /window\.CampCards = \{[^}]*toggleArchive/.test(cards));

  ok('★ 목록 조회가 보관함 보기를 전달', /_campApi\("\/list"\) \+ \(window\._recruitArchivedView \? "\?archived=1" : ""\)/.test(recruitJs));
  ok('★ 보관 건수는 서버 값만(구버전 백엔드·실패면 null)',
    /typeof json\.archivedCount === 'number'\) \? json\.archivedCount : null/.test(recruitJs));
  ok('보관함 토글 함수 노출', /window\.toggleRecruitArchivedView = toggleRecruitArchivedView/.test(recruitJs));
  ok('보관함이 비면 다른 안내(빈 목록과 구분)', /보관한 공고가 없습니다/.test(recruitJs));
  ok('★ 관리자 대시보드에 보관함 버튼', /id="recruitArchiveBtn"[\s\S]{0,200}toggleRecruitArchivedView\(\)/.test(adminHtml));
  ok('★ 리뷰웹시스템[3버전]에도 보관함 버튼', /id="recruitArchiveBtn"[\s\S]{0,200}toggleRecruitArchivedView\(\)/.test(workdesk));
  ok('★ 머리말 재렌더 후 버튼 상태 복원(보관함 보는 중인데 버튼은 "보관함" 방지)',
    /_rcRenderHead\(\(list \|\| \[\]\)\.length\)[\s\S]{0,400}_syncArchiveBtn\(\)/.test(workdesk));

  // ── I. 렌더 실행 — 정적 패턴이 아니라 **실제로 그려 보고** 확인한다 ──
  console.log('\n[I] 카드 렌더 실행');
  {
    const vm = require('vm');
    const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
      getBoundingClientRect: () => ({}), querySelector: () => null, querySelectorAll: () => [],
      insertAdjacentHTML() {}, remove() {}, contains: () => true, innerHTML: '', textContent: '' });
    const win = { location: { hostname: 'x' }, addEventListener() {},
      sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null }, confirm: () => true };
    const doc = { head: el(), body: el(), createElement: () => el(), getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
    const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout,
      fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }), API_BASE_URL: '' };
    sb.globalThis = sb; win.document = doc;
    vm.createContext(sb);
    vm.runInContext(cards, sb, { filename: 'campaign-cards.js' });
    const CC = sb.window.CampCards;
    const base = { id: 'c1', title: '테스트 공고', participation_mode: true, status: 'closed' };
    const hArc = CC.cardHtml({ ...base, archived_at: '2026-08-19T00:00:00Z' }, { admin: true });
    const hFull = CC.cardHtml({ ...base, archiveSuggest: { total: 50, filled: 50, full: true } }, { admin: true });
    const hPart = CC.cardHtml({ ...base, archiveSuggest: { total: 50, filled: 49, full: false } }, { admin: true });
    const hNone = CC.cardHtml({ ...base }, { admin: true });
    const hRev = CC.cardHtml({ ...base, archived_at: '2026-08-19' }, { admin: false });
    ok('★ 보관된 공고 카드에 [📦 보관됨] 배지', hArc.includes('📦 보관됨'));
    ok('★ 보관 중에는 게시 토글이 없다(목록엔 없는데 active 가 되는 상태 방지)',
      hArc.includes('>보관</span>') && !hArc.includes('toggleRecruitPublish'));
    ok('★ 작업표가 다 차면 [📦 보관 제안]', hFull.includes('📦 보관 제안'));
    ok('★ 한 줄이라도 비면 제안 배지 없음', !hPart.includes('보관 제안'));
    ok('★ 판정 재료가 없으면 아무 말도 하지 않는다', !hNone.includes('보관 제안') && !hNone.includes('보관됨'));
    ok('★ 리뷰어 화면(admin:false)에는 보관 표기가 나가지 않는다', !hRev.includes('보관됨'));
    ok('toggleArchive 가 export 되어 호출 가능', typeof CC.toggleArchive === 'function');

    /* ★★ 확인창을 **실제로 띄워** 문구를 읽는다 — 정적 검사는 그 문자열이 다른 분기에
       들어가도 통과한다. 취소(confirm=false)면 요청이 나가지 않는 것까지 함께 고정. */
    const ss = { getItem: (k) => (k === 'admin_token' ? 't' : null) };
    let asked = null, fetched = false;
    const win2 = { location: { hostname: 'x' }, addEventListener() {}, sessionStorage: ss,
      localStorage: { getItem: () => null }, confirm: (m) => { asked = m; return false; } };
    const doc2 = { head: el(), body: el(), createElement: () => el(), getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
    const sb2 = { window: win2, document: doc2, sessionStorage: ss, localStorage: { getItem: () => null },
      console: { log() {}, warn() {}, error() {} }, setTimeout,
      fetch: async () => { fetched = true; return { ok: true, json: async () => ({ ok: true }) }; }, API_BASE_URL: '' };
    sb2.globalThis = sb2; win2.document = doc2;
    vm.createContext(sb2); vm.runInContext(cards, sb2, { filename: 'campaign-cards.js' });
    return sb2.window.CampCards.toggleArchive('c1', true).then(() => {
      ok('★★ 확인창 실문구 — "새 참여 신청"이 닫힌다', /새 참여 신청이 닫힙니다/.test(asked || ''), asked);
      ok('★★ 확인창 실문구 — 이미 참여한 리뷰어는 영향 없음', /이미 참여한 리뷰어는 영향 없습니다/.test(asked || ''));
      ok('★ 취소하면 요청이 나가지 않는다', fetched === false);
      done();
    });
  }
}

function done() {
  console.log(`\n✅ campaignArchive: ${passed} 케이스 통과`);
  process.exit(0);
}
