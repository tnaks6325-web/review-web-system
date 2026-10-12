'use strict';
// 결정 226 2단계 ② — 로그인 실패: 번호는 맞고 이름이 다르면 그 번호로 가입된 이름을 알려준다(B).
// 실행: node tests/samePhoneLoginHint.test.js
const assert = require('assert');
const pool = require('../src/db/pool');
const reviewer = require('../src/services/reviewer.service');
const origQuery = pool.query, origConnect = pool.connect;
let passed = 0;
const ok = (label, cond) => { assert(cond, label); passed++; console.log('  ✓ ' + label); };
const restore = () => { pool.query = origQuery; pool.connect = origConnect; };

(async () => {
  console.log('\n▶ 로그인(B) — 번호는 맞고 이름이 다르면 가입된 이름을 알려준다\n');
  const loginStub = ({ selfRows = [], subOwners = [] }) => async (sql) => {
    if (/WHERE phone8 = \$1 AND name = \$2/.test(sql)) return { rows: [] };
    if (/sub_accounts IS NOT NULL/.test(sql)) return { rows: subOwners };
    if (/SELECT name FROM reviewers WHERE phone8 = \$1/.test(sql)) return { rows: selfRows };
    if (/SELECT phone FROM reviewers WHERE name = \$1/.test(sql)) return { rows: [] };
    throw new Error('예상하지 못한 쿼리: ' + String(sql).slice(0, 60));
  };
  try {
    // 본계정 번호 + 같은 번호 타계정(정리 대상) — 본계정 이름이 먼저
    pool.query = loginStub({ selfRows: [{ name: '김본인' }],
      subOwners: [{ id: 'r1', name: '김본인', phone: '01012345678', sub_accounts: [{ name: '이가족', phone: '01012345678' }] }] });
    const a = await reviewer.verifyReviewer('홍길동', '12345678');
    ok('본계정 번호면 본계정 이름 안내', a.ok === false && /'김본인' 이름으로 가입돼/.test(a.error) && a.field === 'name');
    ok('"같은 번호로 추가 등록" 유도 문구는 없다', !/추가 등록/.test(a.error));

    // 다른 리뷰어의 타계정 번호(본계정 아님) — 이름은 알려주지 않는다(사용자 확정 (가) · Codex 보안 P1)
    pool.query = loginStub({ subOwners: [{ id: 'r2', name: '최주인', phone: '01099998888', sub_accounts: [{ name: '박가족', phone: '010-1234-5678' }] }] });
    const b = await reviewer.verifyReviewer('홍길동', '12345678');
    ok('타계정 번호면 이름 없이 안내(타계정 이름·본계정 이름 모두 비노출)', b.ok === false && !/박가족|최주인/.test(b.error) && /타계정으로 등록/.test(b.error));

    // 같은 번호의 본계정이 둘(앞자리만 다름) — 그 이름으로도 로그인이 안 되므로 이름을 고르지 않는다(Codex P2)
    pool.query = loginStub({ selfRows: [{ name: '김본인' }, { name: '김본인' }] });
    const c = await reviewer.verifyReviewer('홍길동', '12345678');
    ok('로그인 대상이 하나가 아니면 이름 없이 일반 안내', c.ok === false && !/김본인/.test(c.error));

    // 번호가 없으면 종전 안내 그대로
    pool.query = loginStub({});
    const d = await reviewer.verifyReviewer('홍길동', '12345678');
    ok('가입 안 된 번호는 종전 미가입 안내', /가입되지 않은 정보/.test(d.error));
  } finally { restore(); }

  console.log(`\n✅ samePhoneLoginHint: ${passed} cases passed`);
})().catch((err) => { console.error('❌ ' + (err.stack || err.message)); process.exit(1); });
