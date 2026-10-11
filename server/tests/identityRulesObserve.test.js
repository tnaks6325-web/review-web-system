'use strict';
// 결정 222 — 명의 규칙 한 곳(3-1, 관찰 모드). 아무것도 막지 않고 "막았을 저장"만 기록한다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.IDENTITY_RULES_MODE;
const IR = require('../src/services/identityRules.service');
const cards = require('../src/services/reviewerIdentityCards.service');

const OWNER = { id: '11111111-1111-4111-8111-111111111111', name: '인소민', phone: '010-4149-4334' };
const OTHER = '22222222-2222-4222-8222-222222222222';
function db(otherRows = [], { settings = [] } = {}) {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      log.push({ sql: String(sql), params });
      if (/FROM app_settings/.test(sql)) return { rows: settings };
      if (/FROM reviewers r/.test(sql)) return { rows: otherRows.filter((r) => params[1].includes(r.p8)) };
      if (/INSERT INTO identity_rule_observations/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
}
const codes = (v) => v.map((x) => x.code).sort();

(async () => {
  const ev = (d, prev, next) => IR.evaluateSubAccountsChange(d, { owner: OWNER, prev, next });
  // ② 본인과 같은 칸(띄어쓰기 무시)
  assert.deepStrictEqual(codes(await ev(db(), [], [{ name: '인 소민', phone: '010-4149-4334' }])), ['same_as_self']);
  // ③ 같은 이름·번호 두 칸 / 같은 번호·다른 이름은 허용(가족 같은 전제 없이 그냥 다른 명의)
  assert.deepStrictEqual(codes(await ev(db(), [], [{ name: '가', phone: '010-1000-0001' }, { name: '가', phone: '01010000001' }])), ['duplicate_in_list']);
  assert.deepStrictEqual(codes(await ev(db(), [], [{ name: '가', phone: '010-1000-0001' }, { name: '나', phone: '010-1000-0001' }])), [], '번호 같고 이름 다르면 허용');
  assert.deepStrictEqual(codes(await ev(db(), [], [{ name: '다른이름', phone: '010-4149-4334' }])), [], '본인 번호라도 이름 다르면 허용(B)');
  // 기존 칸은 문제 삼지 않는다(사용자 확정 "가")
  const dupPrev = [{ name: '인소민', phone: '010-4149-4334', address: '옛' }];
  assert.deepStrictEqual(codes(await ev(db(), dupPrev, [{ name: '인소민', phone: '010-4149-4334', address: '새 주소' }])), [], '이미 있던 칸은 내용만 바꿔도 위반 아님');
  // ④⑤ 다른 소유자 번호
  const others = [{ owner_id: OTHER, p8: '20000001', kind: 'self' }, { owner_id: OTHER, p8: '30000001', kind: 'sub' }];
  let v = await ev(db(others), [], [{ name: '갑', phone: '010-2000-0001' }, { name: '을', phone: '010-3000-0001' }]);
  assert.deepStrictEqual(codes(v), ['other_owner_self_phone', 'other_owner_sub_phone']);
  assert(v.every((x) => x.otherOwnerId === OTHER), '겹친 소유자 기록');
  v = await ev(db(others), [{ name: '을', phone: '010-3000-0001' }], [{ name: '을', phone: '010-3000-0001' }, { name: '병', phone: '010-5000-0001' }]);
  assert.deepStrictEqual(codes(v), [], '이미 있던 번호(기존 겹침 76건 같은)는 새 위반이 아니다');
  v = await ev(db(others), [{ name: '을', phone: '010-3000-0001' }], [{ name: '을', phone: '010-3000-0001' }, { name: '정', phone: '010-3000-0001' }]);
  assert.deepStrictEqual(codes(v), ['other_owner_sub_phone'], '같은 번호 새 이름 칸도 다른 리뷰어 겹침이면 센다');
  // ⑥ 상한 · ⑦ 빈 칸
  const eleven = Array.from({ length: 11 }, (_, i) => ({ name: '이' + i, phone: '010-7000-00' + String(10 + i) }));
  assert(codes(await ev(db(), eleven.slice(0, 10), eleven)).includes('limit'));
  assert.deepStrictEqual(codes(await ev(db(), [], [{ name: '', phone: '010-1' }])), ['missing_name_or_phone']);
  // Codex P2 — 빈 칸은 값으로 센다: 순서만 바뀌면 위반 아님 / 다른 빈 칸으로 바꾸면 위반
  const blankPrev = [{ name: '정상', phone: '010-8000-0001' }, { name: '', phone: '010-1' }];
  assert.deepStrictEqual(codes(await ev(db(), blankPrev, [{ name: '', phone: '010-1' }])), [], '앞 칸을 지워 빈 칸이 앞으로 와도 새 위반 아님');
  assert.deepStrictEqual(codes(await ev(db(), blankPrev, [{ name: '정상', phone: '010-8000-0001' }, { name: '이름만', phone: '' }])), ['missing_name_or_phone'], '다른 빈 칸으로 바뀌면 센다');

  console.log('PASS 규칙 7종 — 새로 생긴 위반만 · 번호 같고 이름 다르면 허용 · 기존 칸 면제');

  // 모드: 기본 관찰 · 설정 off · 비상 스위치 · 조회 실패는 관찰(막지 않음)
  IR._test._resetModeCacheForTest();
  assert.strictEqual(await IR.getMode(db()), 'observe');
  IR._test._resetModeCacheForTest();
  assert.strictEqual(await IR.getMode(db([], { settings: [{ value: 'off' }] })), 'off');
  IR._test._resetModeCacheForTest();
  assert.strictEqual(await IR.getMode({ query: async () => { throw new Error('down'); } }), 'observe');
  process.env.IDENTITY_RULES_MODE = 'off';
  assert.strictEqual(await IR.getMode(db([], { settings: [{ value: 'observe' }] })), 'off', '비상 스위치가 이긴다');
  delete process.env.IDENTITY_RULES_MODE;
  IR._test._resetModeCacheForTest();
  console.log('PASS 스위치 — 기본 관찰 · 설정으로 끄기 · 비상 스위치 · 모르면 막지 않음');

  // 관찰: 기록만 · 끄면 아무것도 안 함 · 어떤 실패도 던지지 않음
  let d = db();
  let r = await IR.observeSubAccountsWrite({ owner: OWNER, prev: [], next: [{ name: '인소민', phone: '010-4149-4334' }], source: 'profile' }, d);
  assert.deepStrictEqual(codes(r), ['same_as_self']);
  const ins = d.log.find((x) => /INSERT INTO identity_rule_observations/.test(x.sql));
  assert(ins && ins.params[0] === 'profile' && ins.params[2] === 'same_as_self' && ins.params[5] === 'observe');
  assert(!ins.params.some((p) => /인소민|4149/.test(String(p))), '이름·번호는 기록하지 않는다');
  IR._test._resetModeCacheForTest();
  d = db([], { settings: [{ value: 'off' }] });
  r = await IR.observeSubAccountsWrite({ owner: OWNER, prev: [], next: [{ name: '인소민', phone: '010-4149-4334' }] }, d);
  assert.deepStrictEqual(r, []); assert(!d.log.some((x) => /INSERT INTO identity_rule_observations/.test(x.sql)), '끄면 기록도 안 함');
  IR._test._resetModeCacheForTest();
  r = await IR.observeSubAccountsWrite({ owner: OWNER, prev: [], next: [{ name: '갑', phone: '010-2000-0001' }] },
    { query: async (sql) => { if (/app_settings/.test(sql)) return { rows: [] }; throw new Error('table missing'); } });
  assert.deepStrictEqual(r, [], '관찰 실패는 삼킨다');
  console.log('PASS 관찰 — 이름·번호 없이 기록 · 끄면 무동작 · 실패는 밖으로 안 나감');

  // 창구: 저장 COMMIT 뒤에 관찰 — 관찰이 실패해도 저장 결과는 그대로
  {
    const log = [];
    const client = {
      query: async (sql, params) => {
        log.push(String(sql));
        if (/FOR NO KEY UPDATE/.test(sql)) return { rows: [{ id: OWNER.id, name: OWNER.name, phone: OWNER.phone, sub_accounts: [] }] };
        if (/INSERT INTO identity_rule_observations|FROM reviewers r\b/.test(sql)) throw new Error('관찰 쪽 장애');
        if (/reviewer_identity_cards/.test(sql)) return { rows: [] };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const pool = { connect: async () => client, query: client.query };
    IR._test._resetModeCacheForTest();
    const out = await cards.mutateSubAccounts(OWNER.id, () => [{ name: '인소민', phone: '010-4149-4334' }], { db: pool, source: 'profile' });
    assert.strictEqual(out.changed, true, '저장은 그대로 성공');
    const commit = log.findIndex((s) => /^COMMIT/.test(s.trim()));
    assert(commit > 0, 'COMMIT 됨');
    await new Promise((res) => setTimeout(res, 20));
    const firstObserve = log.findIndex((s) => /app_settings/.test(s));
    assert(firstObserve > commit, '관찰은 COMMIT 뒤에만');
    console.log('PASS 창구 — 관찰은 저장 확정 뒤 · 관찰 장애가 저장을 깨지 않는다');
  }

  // 배선
  const tb = fs.readFileSync(path.resolve(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
  assert(/router\.post\('\/settings\/identity-rules-mode', authMiddleware, masterOnlyMiddleware/.test(tb), '스위치는 마스터만');
  assert(/\['off', 'observe'\]\.includes\(mode\)/.test(tb), '차단(enforce)은 아직 고를 수 없다(관찰 확인 뒤 3-1b)');
  assert(/available: false, last14d: null/.test(tb) && !/\.catch\(\(\) => \(\{ rows: \[\] \}\)\)/.test(tb.slice(tb.indexOf('identity-rules-mode'), tb.indexOf('identity-rules-mode') + 1500)), '관찰 기록 못 읽으면 0건이 아니라 확인 불가');
  const mig = fs.readFileSync(path.resolve(__dirname, '../migrations/183_identity_rule_observations.sql'), 'utf8');
  assert(/CREATE TABLE IF NOT EXISTS identity_rule_observations/.test(mig) && !/ALTER TABLE/.test(mig), '183 은 새 기록 표만');
  console.log('PASS 배선 — 마스터 전용 스위치 · enforce 미노출 · 추가만');
})().catch((e) => { console.error(e); process.exit(1); });
