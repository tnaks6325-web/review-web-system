/**
 * campaignMultiAccountDefense.test.js — 타계정 추가참여 방어 회귀가드 (심판 최종안)
 * 실행: node tests/campaignMultiAccountDefense.test.js
 *
 * 고정하는 것:
 *  P0 런타임 — 관리자 공고 라우트가 "선언되지 않은 식별자"로 500이 나지 않는다(grep 테스트가 못 잡던 클래스).
 *  D1  — 이미 리뷰어로 등록된 번호는 타인의 타계정 명의로 사용 불가(사칭 차단, fail-closed).
 *  D1b — 차단 사유의 귀속 판별(타소유자 선점 = 사칭 신호 / 같은번호 다른명의 = 오차단 원인 설명).
 *  D2  — 마이그레이션 실패 오기록 차단(문자열 부분일치 금지) + 스키마 프리플라이트가 listen 앞.
 *  D3  — 타계정 홀드 ↔ 주문 연락처 드리프트 경고(순수함수, 자기참여는 무신호).
 *  D9  — holdPhone8 은 힌트일 뿐 — hold_token 으로 서버가 명의를 확정(고아 주문 차단).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const routes = read('src/routes/campaign.routes.js');
const submit = read('src/routes/submit.routes.js');
const index = read('index.js');
const adminHtml = read('../frontend/admin.html');
const recruitJs = read('../frontend/js/index-recruit.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ══════════════════════════════════════════════════════════════
// P0 런타임: 관리자 공고 라우트 스코프 (2026-07 회귀 — multi_* 구조분해 누락 → 공고수정 전체 500)
//   ★ DB 없이 검증: pool 을 스텁으로 갈아끼운 뒤 실제 핸들러를 호출한다.
//     grep 가드(`multi_account_mode = COALESCE($33...)`)는 이 버그를 통과시켰다 → 런타임 가드 필수.
// ══════════════════════════════════════════════════════════════
const pool = require('../src/db/pool');
pool.query = async () => ({ rows: [{ id: 'camp-test', title: 'T', participation_mode: false }] });
pool.connect = async () => ({ query: async () => ({ rows: [] }), release() {} });

const campaignRouter = require('../src/routes/campaign.routes');
function handlerFor(method, routePath) {
  const layer = campaignRouter.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `라우트 없음: ${method.toUpperCase()} ${routePath}`);
  const st = layer.route.stack;
  return st[st.length - 1].handle;
}
async function callHandler(method, routePath, req) {
  const handler = handlerFor(method, routePath);
  return await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ kind: 'json', statusCode: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ kind: 'next', err })))
      .catch((err) => resolve({ kind: 'throw', err }));
  });
}

(async () => {
  const put = await callHandler('put', '/admin/:id', {
    params: { id: 'camp-test' }, body: { title: '수정' }, admin: { role: 'admin', name: 'tester' },
  });
  ok('P0: PUT /admin/:id 가 ReferenceError 없이 실행(구조분해 누락 회귀가드)',
    !(put.err instanceof ReferenceError));
  ok('P0: PUT /admin/:id 정상 응답(ok:true)', put.kind === 'json' && put.body && put.body.ok === true);

  const post = await callHandler('post', '/admin/create', {
    params: {}, body: { title: '신규' }, admin: { role: 'admin', name: 'tester' },
  });
  ok('P0: POST /admin/create 가 ReferenceError 없이 실행', !(post.err instanceof ReferenceError));

  const st = await callHandler('put', '/admin/:id/status', {
    params: { id: 'camp-test' }, body: { status: 'closed' }, admin: { role: 'admin', name: 'tester' },
  });
  ok('P0: PUT /admin/:id/status 가 ReferenceError 없이 실행', !(st.err instanceof ReferenceError));

  // ══════════════════════════════════════════════════════════════
  // D1 / D1b — 사칭 차단 · 차단 사유 귀속
  // ══════════════════════════════════════════════════════════════
  ok('D1: 등록번호 명의 차단 사유 코드', routes.includes("'sub_is_registered_reviewer'"));
  ok('D1: EXISTS 판정(reviewers.phone8 은 GENERATED·비유니크 → 행 동일성 금지)',
    /SELECT 1 FROM reviewers WHERE phone8 = \$1 LIMIT 1/.test(routes));
  ok('D1: 완화 스위치(block 기본 · warn/allow)', /CAMPAIGN_SUB_REGISTERED_POLICY/.test(routes));
  ok('D1: 차단은 타계정 참여 경로에서만(자기참여 무영향)',
    routes.indexOf("'sub_is_registered_reviewer'") > routes.indexOf('const holdP8 = isSubApply'));

  ok('D1b: 기존 사유 코드 불변(프론트 문구 계약)',
    routes.includes("'already_submitted'") && routes.includes("'already_today'"));
  ok('D1b: 귀속 판별 사유 신설', routes.includes("'blocked_by_other_owner'") && routes.includes("'same_phone_other_name'"));
  ok('D1b: done/hist 2쿼리 → 1쿼리(왕복 순증 0)',
    !/const done = await client\.query/.test(routes) && !/const hist = await client\.query/.test(routes)
    && /const blk = await client\.query/.test(routes));
  ok('D1b: submitted 우선순위 보존(ORDER BY)', /ORDER BY \(status = 'submitted'\) DESC, applied_at DESC/.test(routes));
  ok('D1b: normName 은 identity.service 공식 export 사용',
    typeof require('../src/services/identity.service').normName === 'function');

  // ══════════════════════════════════════════════════════════════
  // D2 / D7 — 마이그레이션 오기록 차단 · 프리플라이트 · 락 타임아웃
  // ══════════════════════════════════════════════════════════════
  ok('D2: duplicate 부분일치 제거(23505 데이터 실패를 적용됨으로 오기록 금지)',
    !/err\.message\.includes\(/.test(index) && /DUP_OBJECT_CODES\.has\(err\.code\)/.test(index));
  ok('D2: 프리플라이트가 listen 앞', index.indexOf('assertSchemaReady(') < index.indexOf('app.listen'));
  ok('D2: 필수 스키마에 063 컬럼 4종', /owner_phone8/.test(index) && /multi_account_mode/.test(index)
    && /multi_daily_limit/.test(index) && /sub_hold_ttl_min/.test(index));
  ok('D2: 조회 실패는 부팅 계속(DB 일시장애 크래시루프 방지)', /프리플라이트 조회 실패/.test(index));
  ok('D2: 긴급 탈출구 ALLOW_SCHEMA_DRIFT', /ALLOW_SCHEMA_DRIFT/.test(index));
  ok('D7: set_config 파라미터 바인딩(SET 문자열 보간 금지)', /set_config\('lock_timeout', \$1, false\)/.test(index));
  ok('D7: 락 대기 초과(55P03)는 미기록 후 재시도', /55P03/.test(index));

  // ══════════════════════════════════════════════════════════════
  // D3 — 명의 ↔ 주문 신원 드리프트(순수함수)
  // ══════════════════════════════════════════════════════════════
  const { detectIdentityDrift } = require('../src/services/campaignHold.service');
  ok('D3: 명의==주문 연락처 → 무신호',
    detectIdentityDrift({ phone8: '11112222', owner_phone8: '33334444' }, { phone: '010-1111-2222' }) === null);
  ok('D3: 타계정 홀드인데 주문 연락처가 소유자 본인 → sub_hold_self_order',
    detectIdentityDrift({ phone8: '11112222', owner_phone8: '33334444' }, { phone: '01033334444' }).kind === 'sub_hold_self_order');
  ok('D3: 타계정 홀드인데 주문 연락처가 제3자 → sub_hold_other_order',
    detectIdentityDrift({ phone8: '11112222', owner_phone8: '33334444' }, { phone: '01099998888' }).kind === 'sub_hold_other_order');
  ok('D3: 자기참여(owner==명의) 연락처 상이는 무신호(가족배송 등 정상 — 오탐 0)',
    detectIdentityDrift({ phone8: '11112222', owner_phone8: '11112222' }, { phone: '01099998888' }) === null);
  ok('D3: 레거시(owner NULL) 무신호',
    detectIdentityDrift({ phone8: '11112222', owner_phone8: null }, { phone: '01099998888' }) === null);
  ok('D3: 불확실 값(8자리 미만)은 무신호',
    detectIdentityDrift({ phone8: '11112222', owner_phone8: '33334444' }, { phone: '123' }) === null);
  ok('D3: 주문 손실 0 계약 — 드리프트는 확정을 막지 않는다(경고만)',
    !/return 'identity_mismatch'/.test(read('src/services/campaignHold.service.js')));
  ok('D3: submit 이 시트 기입 연락처를 확정 문맥에 전달', /orderIdentity: \{ phone \}/.test(submit));

  // ══════════════════════════════════════════════════════════════
  // D9 — holdPhone8 서버권위
  // ══════════════════════════════════════════════════════════════
  ok('D9: hold_token 기반 서버확정 함수 존재', /_authoritativeHold/.test(submit));
  ok('D9: 신원게이트보다 먼저 확정(owner 폴백 JOIN 정합)',
    submit.indexOf('await _authoritativeHold(') < submit.indexOf('let { rows: _rvRows }'));
  ok('D9: 옵션 서버권위 쿼리를 흡수(왕복 순증 0)',
    /option_key/.test(submit) && !/SELECT option_key FROM campaign_applications\n\s+WHERE id = \$1 AND campaign_id = \$2 AND phone8 = \$3/.test(submit));
  ok('D9: 조회 실패는 클라값 유지(fail-open — 라이브 핫패스 보호)', /홀드 서버확정 실패\(클라값 유지\)/.test(submit));

  // ══════════════════════════════════════════════════════════════
  // D4-lite — 하루한도 기본값 footgun 제거(0=무제한은 PRD §09-5 유지 · 비차단 경고)
  // ══════════════════════════════════════════════════════════════
  ok('D4: 관리자 폼 기본값 1(무제한이 기본이 아님)', /id="rf_multi_daily"[^>]*value="1"/.test(adminHtml));
  ok('D4: 신규 폼 초기화도 1', /_mdEl\.value = "1"/.test(recruitJs));
  ok('D4: 0=무제한은 여전히 허용(PRD §09-5)', /min="0"/.test(adminHtml.match(/<input id="rf_multi_daily"[^>]*>/)[0]));
  ok('D4: 자동점검이 무제한을 경고로 표시', /무제한/.test(recruitJs) && /warn: /.test(recruitJs));

  console.log(`\n✅ campaignMultiAccountDefense: ${passed}개 통과`);
})().catch((err) => { console.error('\n❌ 실패:', err.message); process.exit(1); });
