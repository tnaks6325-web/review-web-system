/**
 * campaignReviewerGate.test.js — 모집공고별 참여가능 리뷰어 게이트(블랙리스트 건별) 회귀가드 (091)
 * 실행: node tests/campaignReviewerGate.test.js
 *
 * 왜 필요한가(직원 아이디어 · 사용자 확정 4건):
 *   공고별로 참여 불가 리뷰어를 건별 지정(deny-list — 예외만 저장, 2000명 전체 미로드)하고
 *   차단 시 안내는 고정 2종(마감 위장/사유 고지). 기존 홀드는 건드리지 않고 신규 apply 만 막는다.
 *
 * 고정하는 것:
 *  A. 판정 순수함수(utils/reviewerGate) — allow > block > 전역(옵트인), 킬스위치, 문구 단일 출처
 *  B. 관리기준 정규화 — 기본 14일, 빈 값을 0으로 접지 않음(082 _int 규율)
 *  C. 마이그레이션 — FK 타입 TEXT ≡ 018(recruit_campaigns.id), 활성 부분유니크, mode CHECK 없음
 *  D. apply 게이트 배선 — 홀드 INSERT 전 · SAVEPOINT 격리 · ROLLBACK 후 403 · fail-open
 *  E. 서비스 실행(스텁 db) — checkApplyGate 분기 · 검색 자리표시자 정합 · PII 마스킹 · 변경 tx
 *  F. 라우터 스택 실검사 — trackB 5경로 전부 authMiddleware+internal 체인(2026-08: AE 도 관리)
 *  G. 프론트 배선 — 카드 버튼(참여형+모듈 존재 시만) · 모듈 로드 · campaign.html 위장/고지 · 설정 패널
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
function ok(name, cond, extra) {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
}

const gate = require('../src/utils/reviewerGate');

(async () => {

  // ── A. 판정 순수함수 ──
  console.log('\n[A] 판정 순수함수 (allow > block > 전역 옵트인)');
  delete process.env.CAMPAIGN_REVIEWER_GATE;
  delete process.env.CAMPAIGN_REVIEWER_GATE_GLOBAL;

  ok('기본: 예외 없음 = 통과', gate.decideReviewerGate({}).blocked === false);
  {
    const d = gate.decideReviewerGate({ gateRow: { mode: 'block', message_type: 'closed' } });
    ok('block(closed) = 차단 + 마감 위장 문구', d.blocked && d.gate === 'closed' && d.message === gate.GATE_MESSAGES.closed);
  }
  {
    const d = gate.decideReviewerGate({ gateRow: { mode: 'block', message_type: 'policy' } });
    ok('block(policy) = 차단 + 사유 고지 문구', d.blocked && d.gate === 'policy' && d.message === gate.GATE_MESSAGES.policy);
  }
  ok('모르는 message_type 은 마감 위장으로 수렴(사유를 지어내지 않음)',
    gate.decideReviewerGate({ gateRow: { mode: 'block', message_type: 'weird' } }).gate === 'closed');
  ok('★ allow 는 전역 블랙리스트보다 우선(건별 허용의 핵심)',
    gate.decideReviewerGate({ gateRow: { mode: 'allow' }, inGlobalBlacklist: true }).blocked === false);
  ok('★ 전역 블랙리스트는 기본 미강제(옵트인 전 = 기존 동작, 사용자 확정 Q3)',
    gate.decideReviewerGate({ gateRow: null, inGlobalBlacklist: true }).blocked === false);
  process.env.CAMPAIGN_REVIEWER_GATE_GLOBAL = '1';
  {
    const d = gate.decideReviewerGate({ gateRow: null, inGlobalBlacklist: true });
    ok('옵트인 시 전역 차단 = 사유 고지형', d.blocked && d.gate === 'policy' && d.source === 'global');
  }
  delete process.env.CAMPAIGN_REVIEWER_GATE_GLOBAL;
  process.env.CAMPAIGN_REVIEWER_GATE = '0';
  ok('★ 킬스위치 CAMPAIGN_REVIEWER_GATE=0 = 전건 통과(기존 동작 100%)',
    gate.decideReviewerGate({ gateRow: { mode: 'block', message_type: 'closed' } }).blocked === false);
  delete process.env.CAMPAIGN_REVIEWER_GATE;

  // ── B. 관리기준 정규화 ──
  console.log('\n[B] 블랙리스트 관리기준 정규화 (사용자 확정 Q4)');
  {
    const c = gate.normalizeCriteria(null);
    ok('기본값 = 기한경과 14일 / 리뷰미작성 30일(2026-08-05 사용자 확정 재정의)',
      c.nowriteDays === 30 && c.overdueDays === 14);
  }
  ok('★ 빈 문자열은 0일이 아니라 기본값(082 _int 규율)',
    gate.normalizeCriteria({ nowriteDays: '' }).nowriteDays === 30);
  ok('범위 클램프 1..365', gate.normalizeCriteria({ nowriteDays: 0, overdueDays: 9999 }).nowriteDays === 1
    && gate.normalizeCriteria({ overdueDays: 9999 }).overdueDays === 365);
  ok('문자 숫자 허용', gate.normalizeCriteria({ nowriteDays: '30' }).nowriteDays === 30);
  {
    const h = gate.summarizeHistory(null);
    ok('집계 실패 = "조회 실패"(0으로 꾸미지 않음)', h.level === 'unknown');
    ok('미작성 우선 표시', gate.summarizeHistory({ joined: 3, nowrite: 1, overdue: 2 }).level === 'bad');
    ok('참여 0건 = 이력 없음', gate.summarizeHistory({ joined: 0 }).level === 'none');
  }

  // ── C. 마이그레이션 ──
  console.log('\n[C] 마이그레이션 091');
  const mig = read('migrations/091_campaign_reviewer_gates.sql');
  const mig018 = read('migrations/018_campaigns.sql');
  {
    const m18 = mig018.match(/id\s+(TEXT)\s+PRIMARY KEY/i);
    ok('018: recruit_campaigns.id 는 TEXT(전제 확인)', !!m18);
    ok('★ 091 FK 컬럼도 TEXT(082 의 42804 파일 전체 롤백 사고 재발 방지)',
      /campaign_id\s+TEXT\s+NOT NULL\s+REFERENCES\s+recruit_campaigns\(id\)/i.test(mig));
  }
  ok('활성 예외 부분유니크(중복 활성 백스톱)',
    /uq_campaign_reviewer_gates_active[\s\S]{0,200}WHERE released_at IS NULL/.test(mig));
  ok('mode/message_type 에 DB CHECK 없음(어휘 확장 대비 — 087 규율)', !/CHECK\s*\(/i.test(mig));
  ok('소프트 해제 컬럼(이력 보존)', /released_at\s+TIMESTAMPTZ/.test(mig));

  // ── D. apply 게이트 배선 ──
  console.log('\n[D] apply 게이트 배선 (campaign.routes.js)');
  const routes = read('src/routes/campaign.routes.js');
  ok('apply 에 reviewer_blocked 사유코드', routes.includes("reason: 'reviewer_blocked'"));
  ok('★ SAVEPOINT 격리(테이블 부재·조회 실패가 tx 를 죽이지 않음)',
    routes.includes("SAVEPOINT rg_gate") && routes.includes('ROLLBACK TO SAVEPOINT rg_gate'));
  ok('★ fail-open(판정 실패는 참여를 막지 않음)', /reviewerGate\] apply 판정 실패\(fail-open\)/.test(routes));
  {
    const gateIdx = routes.indexOf("reason: 'reviewer_blocked'");
    const holdIdx = routes.indexOf('INSERT INTO campaign_applications');
    ok('★ 게이트는 홀드 INSERT 앞(자리 미점유 상태에서 차단)', gateIdx > -1 && holdIdx > gateIdx, { gateIdx, holdIdx });
    const notReg = routes.indexOf("reason: 'not_registered'");
    ok('등록 리뷰어 검증 뒤에 위치', notReg > -1 && gateIdx > notReg);
  }
  {
    const seg = routes.slice(routes.indexOf('SAVEPOINT rg_gate'), routes.indexOf("reason: 'reviewer_blocked'") + 200);
    ok('차단 응답 전에 ROLLBACK(홀드 tx 잔존 금지)', /await client\.query\('ROLLBACK'\);[\s\S]{0,200}reviewer_blocked/.test(routes.slice(routes.indexOf('rg_gate'))));
    ok('킬스위치 게이트(gateEnabled) 경유', /gateEnabled\(\)/.test(seg) || /gateEnabled\(\)/.test(routes));
  }
  ok('★ 문구 단일 출처 — 라우트에 고정 문구 사본 없음(gateDecision.message 만 사용)',
    !routes.includes(gate.GATE_MESSAGES.closed) && !routes.includes(gate.GATE_MESSAGES.policy));

  // ── E. 서비스 실행(스텁 db) ──
  console.log('\n[E] 서비스 실행 (스텁 db)');
  const svc = require('../src/services/reviewerGate.service');

  // E-1. checkApplyGate 분기 + 전역 조회는 옵트인일 때만
  {
    const calls = [];
    const client = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM campaign_reviewer_gates/.test(sql)) return { rows: [{ mode: 'block', message_type: 'policy' }] };
      return { rows: [] };
    } };
    const d = await svc.checkApplyGate(client, 'c1', '12345678');
    ok('checkApplyGate: block 행 → 차단(policy)', d.blocked && d.gate === 'policy');
    ok('★ 옵트인 OFF 면 blacklist 테이블을 조회하지 않음(왕복 순증 0)',
      !calls.some(c => /FROM blacklist/.test(c.sql)));
  }
  {
    process.env.CAMPAIGN_REVIEWER_GATE_GLOBAL = '1';
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      if (/FROM campaign_reviewer_gates/.test(sql)) return { rows: [] };
      if (/FROM blacklist/.test(sql)) return { rows: [{ 1: 1 }] };
      return { rows: [] };
    } };
    const d = await svc.checkApplyGate(client, 'c1', '12345678');
    ok('옵트인 ON + 전역 소속 → 차단', d.blocked === true && d.source === 'global');
    delete process.env.CAMPAIGN_REVIEWER_GATE_GLOBAL;
  }

  // E-2. 검색 — 자리표시자↔파라미터 정합(부품4g 실측 500 재발 방지) + PII 마스킹
  function stubSearchDb(reviewerRows) {
    const seen = [];
    return {
      seen,
      query: async (sql, params) => {
        seen.push({ sql, params });
        const maxPh = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
        assert(maxPh === (params || []).length, '자리표시자↔파라미터 불일치: $' + maxPh + ' vs ' + (params || []).length + ' — ' + sql.slice(0, 80));
        if (/FROM reviewers/.test(sql)) return { rows: reviewerRows };
        if (/FROM app_settings/.test(sql)) return { rows: [] };
        return { rows: [] };
      },
    };
  }
  {
    const db = stubSearchDb([{ name: '홍길동', phone8: '10101234', phone: '010-1010-1234', bank_account: '110-222-334455', status: 'active', registered_at: null }]);
    const r = await svc.searchReviewers('c1', '홍길', db);
    ok('이름 검색(숫자 없음)이 자리표시자 정합으로 실행됨', r.items.length === 1);
    const it = r.items[0];
    ok('★ 연락처는 뒤4자리만(전체값 미반환 = 데이터 최소화)', it.phoneMasked === '***-1234' && !('phone' in it));
    ok('★ 계좌는 뒤4자리만', it.accountTail === '…4455' && !('bank_account' in it));
  }
  {
    const db = stubSearchDb([]);
    const r = await svc.searchReviewers('c1', '1234', db);
    ok('숫자 검색(전화 뒤자리∪계좌)도 자리표시자 정합', Array.isArray(r.items));
    ok('빈 검색어 = 조회 0(전체 로드 금지)', (await svc.searchReviewers('c1', '', db)).items.length === 0);
  }

  // E-3. 변경 적용 tx — release 후 INSERT(append-only), clear 는 INSERT 없음, 잘못된 입력 스킵
  {
    const calls = [];
    const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; }, release() {} };
    const db = { connect: async () => client };
    const out = await svc.applyGateChanges('c1', [
      { phone8: '11112222', name: '홍길동', mode: 'block', messageType: 'weird' },
      { phone8: '33334444', mode: 'clear' },
      { phone8: '123', mode: 'block' },                 // 8자리 아님 → 스킵
      { phone8: '55556666', mode: 'hack' },             // 모르는 mode → 스킵
    ], '만두', db);
    ok('유효 변경 2건만 적용', out.applied.length === 2, out.applied);
    const inserts = calls.filter(c => /INSERT INTO campaign_reviewer_gates/.test(c.sql));
    ok('block 은 INSERT 1건 + 모르는 messageType 은 closed 로 정규화',
      inserts.length === 1 && inserts[0].params[4] === 'closed');
    const releases = calls.filter(c => /SET released_at = NOW\(\)/.test(c.sql));
    ok('기존 활성 행 release(append-only 이력 보존)', releases.length === 2);
    ok('tx BEGIN/COMMIT', calls.some(c => c.sql === 'BEGIN') && calls.some(c => c.sql === 'COMMIT'));
  }

  // ── F. 라우터 스택 실검사 ──
  console.log('\n[F] 라우터 스택 실검사 (trackB 5경로 · 권한 체인)');
  const trackB = require('../src/routes/trackB.routes');
  const layers = trackB.stack.filter(l => l.route);
  function findRoute(p, method) {
    return layers.find(l => l.route.path === p && l.route.methods[method]);
  }
  for (const [p, m] of [
    ['/campaigns/:id/reviewer-gate', 'get'],
    ['/campaigns/:id/reviewer-gate/search', 'get'],
    ['/campaigns/:id/reviewer-gate', 'post'],
    ['/settings/reviewer-gate-criteria', 'get'],
    ['/settings/reviewer-gate-criteria', 'post'],
  ]) {
    const r = findRoute(p, m);
    ok(`${m.toUpperCase()} ${p} 등록 + 미들웨어 체인 3단(auth→internal→핸들러)`,
      !!r && r.route.stack.length >= 3, r && r.route.stack.length);
  }
  ok('42P01 = not_ready 로 말함(마스킹된 200 무신호 방지 — 088 규율)',
    /_rgNotReady/.test(read('src/routes/trackB.routes.js')) && /migration 091 미적용/.test(read('src/routes/trackB.routes.js')));

  // ── G. 프론트 배선 ──
  console.log('\n[G] 프론트 배선');
  const cards = read('../frontend/js/campaign-cards.js');
  const modal = read('../frontend/js/campaign-reviewer-gate.js');
  const adminHtml = read('../frontend/admin.html');
  const workdesk = read('../frontend/workdesk.html');
  const campHtml = read('../frontend/campaign.html');
  const settings = read('../frontend/js/admin-settings.js');
  const indexApp = read('../frontend/js/index-app.js');

  ok('카드 버튼: 참여형 + 모듈 존재 시만(모듈 없는 화면에 죽은 버튼 금지)',
    /c\.participation_mode && typeof window !== 'undefined' && window\.ReviewerGate/.test(cards));
  ok('카드 버튼 onclick 은 id 만 전달(기존 openCampControlById 관용구)', /ReviewerGate\.open\('\$\{id\}'\)/.test(cards));
  ok('모듈 로드: admin.html', /campaign-reviewer-gate\.js/.test(adminHtml));
  ok('모듈 로드: workdesk.html', /campaign-reviewer-gate\.js/.test(workdesk));
  ok('★ 모달은 body 직속 마운트', /document\.body\.appendChild\(d\)/.test(modal));
  ok('★ 모듈 CSS 는 var() 폴백(테마 없는 호스트 대비)', /var\(--card,#fff\)/.test(modal));
  ok('★ 행 토글 onclick 은 배열 인덱스만(XSS 규율)', /ReviewerGate\._toggle\(' \+ i \+ '\)/.test(modal));
  ok('★ 검색 LIMIT 초과 시 "검색어를 좁혀주세요" 고지(전체 로드 금지)', /검색어를 좁혀주세요/.test(modal));
  ok('로딩 자리표시자는 어떤 예외에도 종결([다시 시도])', /다시 시도/.test(modal));
  ok('API 베이스는 bare 식별자(window.API_BASE_URL 은 항상 undefined — 실측 함정)',
    /typeof API_BASE_URL !== 'undefined'/.test(modal) && !/window\.API_BASE_URL/.test(modal));

  ok('campaign.html: reviewer_blocked 분기', /reason === 'reviewer_blocked'/.test(campHtml));
  ok('★ 마감 위장 = 실제 마감과 같은 renderPre 경로(전용 화면 금지)',
    /_gateMask = 'closed';[\s\S]{0,200}renderPre\(\)/.test(campHtml));
  ok('★ 재조회(loadCampaign)가 위장을 되돌리지 않음', /_gateMask === 'closed'\)\{ _camp\.state = 'closed'/.test(campHtml));
  ok('사유 고지형도 재렌더에 잠금 유지', /_gateMask === 'policy'\)\{ jb\.disabled = true/.test(campHtml));

  ok('설정 패널: PANELS/LOADERS/PANEL_NAV 3곳 모두 등록(갈리면 목차 빈 칸)',
    /gatecriteria: _gateCriteriaHtml/.test(settings) && /gatecriteria: loadGateCriteria/.test(settings)
    && /gatecriteria: \{ ic: '🚫'/.test(settings));
  ok('설정 경로는 /api/trackb/settings/*(양쪽 호스트 공용 — 재기준 금지)',
    /RGC_EP = '\/api\/trackb\/settings\/reviewer-gate-criteria'/.test(settings));
  /* ⚠ 종전에는 마운트 목록의 **인접 문자열**(`'worktable', 'gatecriteria'`)을 고정했다 —
     목록에 항목이 하나만 끼어도 조용히 깨지는 패턴이라(레포에서 반복된 함정) **그 마운트 호출
     안에 키가 있는가**로 바꾼다. 검사 의미는 불변: gatecriteria 가 실제로 마운트된다. */
  const _mountCall = (src) => {
    const i = src.indexOf("AdminSettings.mount('adminSettingsMount'");
    return i < 0 ? '' : src.slice(i, src.indexOf(')', src.indexOf('panels', i)) + 1);
  };
  ok('admin.html 설정 마운트에 gatecriteria 포함', /'gatecriteria'/.test(_mountCall(adminHtml)));
  // ★ 2026-08 사용자 확정: 공고별 [🚫 참여 리뷰어 관리]를 AE 도 쓰므로, 그 판정 기준인
  //   gatecriteria 패널은 admin/staff **양쪽 마운트 목록**에 있어야 한다(한쪽만 있으면 AE 가
  //   기준을 못 보고 관리만 하게 된다). 다른 패널 목록이 늘어도 깨지지 않게 두 목록을 따로 본다.
  {
    const mount = /AdminSettings\.mount\('adminSettingsMount',[^\n]*/.exec(workdesk);
    const line = (mount && mount[0]) || '';
    const both = line.split('?')[1] || '';
    const [adminList, staffList] = both.split(':');
    ok('workdesk 설정 마운트 — 관리자 목록에 gatecriteria', /gatecriteria/.test(adminList || ''));
    ok('workdesk 설정 마운트 — AE 목록에도 gatecriteria(관리 기준 = 그 기능과 같은 범위)',
      /gatecriteria/.test(staffList || ''));
  }
  ok('admin 탭 전환 시 loadGateCriteria 호출', /loadGateCriteria\(\)/.test(indexApp));
  ok('전역 노출(onclick 이 부를 이름)', /window\.saveGateCriteria = saveGateCriteria/.test(settings));

  console.log(`\n✅ campaignReviewerGate: ${passed}개 통과`);
  process.exit(0);   // trackB.routes require 가 pool 핸들을 열어 프로세스가 안 끝난다(레포 관용구)
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
