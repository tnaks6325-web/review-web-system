/**
 * reviewerSubAccountRegistrationGuard.test.js — 타계정 번호의 별도 본계정 등록 차단.
 *
 * 같은 번호가 타계정으로 먼저 등록된 상태에서 새 reviewers 행을 만들면 phone8 기반 로그인·검색·정산이
 * 두 소유자로 갈라진다. 등록 API의 서버 판정이라 화면을 우회한 요청도 막혀야 한다.
 * 실행: node tests/reviewerSubAccountRegistrationGuard.test.js
 */
const assert = require('assert');

const pool = require('../src/db/pool');
const reviewer = require('../src/services/reviewer.service');
const originalQuery = pool.query;
let passed = 0;
const ok = (label, condition) => { assert(condition, label); passed++; console.log('  ✓ ' + label); };

async function withQuery(handler, run) {
  pool.query = handler;
  try { await run(); } finally { pool.query = originalQuery; }
}

(async () => {
  console.log('\n▶ 타계정 번호 신규 리뷰어 등록 차단\n');

  await withQuery(async (sql, params) => {
    if (/jsonb_array_elements/.test(sql)) {
      ok('타계정 충돌은 이름이 아닌 전화번호 뒤 8자리로 조회한다', params[0] === '75860135');
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }
    if (/INSERT INTO reviewers/.test(sql)) throw new Error('차단된 타계정 번호로 INSERT가 실행되면 안 됩니다');
    throw new Error('예상하지 못한 쿼리');
  }, async () => {
    const out = await reviewer.registerReviewer({ name: '박세희', phone: '010-7586-0135', consent: true });
    ok('이미 타계정으로 등록된 번호는 새 리뷰어 등록을 거부한다',
      out.ok === false && out.reason === 'phone_registered_as_sub_account');
    ok('차단 응답은 타계정을 등록한 본계정의 이름을 노출하지 않는다', !Object.hasOwn(out, 'mainName'));
  });

  let insertCalls = 0;
  await withQuery(async (sql, params) => {
    if (/jsonb_array_elements/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO reviewers/.test(sql)) {
      insertCalls++;
      ok('타계정 충돌이 없으면 기존 등록 INSERT를 수행한다', params[0] === '신규리뷰어' && params[1] === '01012345678');
      return { rows: [{ name: '신규리뷰어', phone: '01012345678' }], rowCount: 1 };
    }
    throw new Error('예상하지 못한 쿼리');
  }, async () => {
    const out = await reviewer.registerReviewer({ name: '신규리뷰어', phone: '010-1234-5678', consent: 'true' });
    ok('타계정 충돌이 없는 신규 등록은 그대로 성공한다', out.ok === true && out.phone === '01012345678');
    ok('신규 등록 INSERT는 정확히 한 번', insertCalls === 1);
  });

  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'reviewer.service.js'), 'utf8');
  ok('구형/비정상 sub_accounts는 빈 배열로 취급해 등록 API가 500으로 깨지지 않는다',
    /jsonb_typeof\(r\.sub_accounts\)='array'[\s\S]{0,180}?'\[\]'::jsonb/.test(source));
  ok('타계정 충돌은 어떤 이름으로 등록을 시도해도 동일하게 막는다(번호 뒤 8자리 기준)',
    /COALESCE\(sub\.value->>'phone',''\)[\s\S]{0,180}?8\) = \$1/.test(source));

  console.log(`\n✅ reviewerSubAccountRegistrationGuard: ${passed} cases passed`);
})().catch(err => { console.error('❌ ' + err.message); process.exit(1); });
