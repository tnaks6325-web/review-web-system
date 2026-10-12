'use strict';
// 결정 226 2단계 — 같은 번호 + 다른 이름: 가입은 막고 가입된 이름 안내(C). 로그인 안내(B)는 samePhoneLoginHint.test.js.
// 실행: node tests/samePhoneRegister.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.SAME_PHONE_REGISTER_MODE;
const pool = require('../src/db/pool');
const reviewer = require('../src/services/reviewer.service');
const origQuery = pool.query, origConnect = pool.connect;
let passed = 0;
const ok = (label, cond) => { assert(cond, label); passed++; console.log('  ✓ ' + label); };
const restore = () => { pool.query = origQuery; pool.connect = origConnect; };

(async () => {
  console.log('\n▶ 가입(C) — 같은 번호·다른 이름은 막고 가입된 이름을 알려준다\n');
  let connectCalls = 0;
  const regStub = (existingName, subRows = []) => async (sql, params) => {
    if (/jsonb_array_elements/.test(sql)) return { rows: subRows };
    if (/INSERT INTO reviewers/.test(sql)) return { rows: [], rowCount: 0 };   // ON CONFLICT — 이미 있는 번호
    if (/SELECT id, name, sub_accounts FROM reviewers WHERE phone = \$1/.test(sql)) {
      return { rows: [{ id: 'r1', name: existingName, sub_accounts: [] }] };
    }
    if (/UPDATE reviewers SET kakao_id/.test(sql)) return { rows: [], rowCount: 0 };
    throw new Error('예상하지 못한 쿼리: ' + String(sql).slice(0, 60));
  };
  pool.connect = async () => { connectCalls++; throw new Error('타계정 추가 시도'); };
  try {
    pool.query = regStub('김본인');
    const out = await reviewer.registerReviewer({ name: '이다른', phone: '010-1234-5678', consent: true });
    ok('다른 이름 가입은 거부', out.ok === false && out.reason === 'phone_registered_other_name');
    ok('가입된 이름을 알려준다(안내 문구·채워 넣을 값)', /'김본인' 이름으로 가입돼/.test(out.error) && out.registeredName === '김본인');
    ok('옛 화면 호환 — message 에도 같은 문구', out.message === out.error);
    ok('같은 번호 타계정을 만들지 않는다', connectCalls === 0);

    const same = await reviewer.registerReviewer({ name: '김본인', phone: '01012345678', consent: true });
    ok('같은 이름 재가입은 종전대로 이미 가입', same.ok === true && same.alreadyRegistered === true);

    process.env.SAME_PHONE_REGISTER_MODE = 'allow';
    await assert.rejects(reviewer.registerReviewer({ name: '이다른', phone: '01012345678', consent: true }));
    ok('비상 스위치(allow) — 종전 A안(타계정 추가)으로 돌아간다', connectCalls === 1);
    delete process.env.SAME_PHONE_REGISTER_MODE;

    // 다른 리뷰어의 타계정 번호 — 막되 이름은 알려주지 않는다(타계정 이름도, 그 타계정을 올린 본계정 이름도)
    let subParams = null, subSql = '';
    pool.query = async (sql, params) => {
      if (/jsonb_array_elements/.test(sql)) { subParams = params; subSql = String(sql); return { rows: [{ '?column?': 1 }] }; }
      throw new Error('차단 뒤 다른 쿼리 금지');
    };
    const sub = await reviewer.registerReviewer({ name: '홍길동', phone: '010-7586-0135', consent: true });
    ok('타계정 번호 가입은 거부 · 이름은 알려주지 않는다(사용자 확정 (가) — 이름+번호가 로그인 열쇠)',
      sub.ok === false && sub.reason === 'phone_registered_as_sub_account'
      && !Object.hasOwn(sub, 'registeredName') && !/'[^']+' 이름으로/.test(sub.error) && /등록할 때 쓴 이름/.test(sub.error));
    ok('본계정 이름(mainName)은 응답에 없다', !Object.hasOwn(sub, 'mainName'));
    ok('그 전체 번호의 본계정이 어디든 있으면 타계정 검사를 건너뛰고 본계정 경로가 판정(Codex P1 — 남의 타계정 이름 안내 금지)',
      subParams && subParams[1] === '01075860135'
      && /NOT EXISTS \(SELECT 1 FROM reviewers m\s+WHERE regexp_replace\(COALESCE\(m\.phone,''\), '\[\^0-9\]', '', 'g'\) = \$2\)/.test(subSql));
  } finally { restore(); }

  console.log('\n▶ 담당자 수동 접수 · 화면 배선\n');
  const mo = fs.readFileSync(path.resolve(__dirname, '../src/services/manualOrder.service.js'), 'utf8');
  ok('수동 접수는 가입 거부(다른 이름)를 실패로 끝내지 않고 그 리뷰어로 연결(경고만)',
    /reg\.reason === 'phone_registered_other_name'\)\s*\{[\s\S]{0,300}?warnings\.push\([\s\S]{0,200}?\}\s*else if \(!reg\.ok\)/.test(mo));
  const front = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
  const br = front.match(/data\.reason === "phone_registered_as_sub_account" \|\| data\.reason === "phone_registered_other_name"\)\) \{([\s\S]*?)\} else if/);
  ok('구매양식 가입 화면 — 두 거부 모두 로그인 탭으로 옮겨 번호(·가입된 이름)를 채우고 안내(Codex P2)', br && /_switchAuthTab\("login"\)/.test(br[1])
    && /data\.registeredName/.test(br[1]) && /_showLoginErr\(/.test(br[1]));
  ok('구매양식 가입 화면 — 서버 안내(error)를 읽는다', /_showRegErr\(\(data && \(data\.error \|\| data\.message\)\)/.test(front));

  console.log(`\n✅ samePhoneRegister: ${passed} cases passed`);
})().catch((err) => { console.error('❌ ' + (err.stack || err.message)); process.exit(1); });
