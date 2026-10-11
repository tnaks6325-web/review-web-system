'use strict';
// 결정 223 — 신원 기준 3-2: 본인 정보(주소·계좌·소득명의·가입)를 바꾼 뒤 그 리뷰어 카드를 바로 맞춘다.
// 저장이 확정된 뒤 따로 돌고(기다리지 않음), 어떤 실패도 저장에 닿지 않는다. 카드 잠금은 FOR NO KEY UPDATE.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.IDENTITY_CARDS_READ;
const cards = require('../src/services/reviewerIdentityCards.service');
const ID = '11111111-1111-4111-8111-111111111111';
const read = (f) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

(async () => {
  // ① 정상: 한 사람분 짧은 트랜잭션(잠금 상한 2초 · 리뷰어 행 FOR NO KEY UPDATE · 카드 FOR NO KEY UPDATE)
  {
    const log = [];
    const client = {
      query: async (sql) => {
        log.push(String(sql));
        if (/FROM reviewers WHERE id = \$1 FOR NO KEY UPDATE/.test(sql)) return { rows: [{ id: ID, name: '새가입', phone: '010-1234-5678', sub_accounts: [] }] };
        if (/FROM reviewer_identity_cards/.test(sql)) return { rows: [] };
        return { rows: [{ id: 'new-card' }], rowCount: 1 };
      },
      release() { log.push('RELEASE_CONN'); },
    };
    const r = await cards.syncOwnerCardsSoon(ID, { source: 'register', db: { connect: async () => client } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.inserted, 1, '본인 카드가 없으면 바로 만든다(새 가입자)');
    const i = (re) => log.findIndex((s) => re.test(s));
    assert(i(/^BEGIN/) < i(/lock_timeout', '2000ms'/) && i(/lock_timeout', '2000ms'/) < i(/FOR NO KEY UPDATE/), '잠금 상한을 먼저 걸고 잠근다');
    assert(log.some((s) => /reviewer_identity_cards[\s\S]*FOR NO KEY UPDATE/.test(s)), '카드 잠금도 FOR NO KEY UPDATE');
    assert(i(/^COMMIT/) > 0 && log[log.length - 1] === 'RELEASE_CONN', 'COMMIT 후 커넥션 반환');
  }
  // ② 실패: 던지지 않고 되돌리고 커넥션 반환
  {
    const log = [];
    const client = { query: async (sql) => { log.push(String(sql)); if (/FOR NO KEY UPDATE/.test(sql)) { const e = new Error('lock'); e.code = '55P03'; throw e; } return { rows: [] }; }, release() { log.push('RELEASE_CONN'); } };
    const r = await cards.syncOwnerCardsSoon(ID, { db: { connect: async () => client } });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, '55P03');
    assert(log.includes('ROLLBACK') && log[log.length - 1] === 'RELEASE_CONN');
    const r2 = await cards.syncOwnerCardsSoon(ID, { db: { connect: async () => { throw new Error('pool down'); } } });
    assert.strictEqual(r2.ok, false, '커넥션도 못 얻으면 조용히 실패');
    assert.strictEqual((await cards.syncOwnerCardsSoon('', {})).skipped, true);
  }
  console.log('PASS 카드 바로 맞추기 — 한 사람분 짧은 트랜잭션 · 실패는 삼키고 커넥션 반환');

  // ③ 배선: 저장 뒤 · 기다리지 않음(await 없이 호출) · 대상 4곳
  const rv = read('src/services/reviewer.service.js');
  for (const [label, re] of [
    ['가입', /if \(result\.rowCount > 0\) _syncCardsSoon\(result\.rows, 'register'\)/],
    ['소득', /WHERE \$\{scopeColumn\} = \$3\s*RETURNING id`[\s\S]{0,80}\);\s*_syncCardsSoon\(_incRes && _incRes\.rows, 'income'\)/],
    ['계좌', /WHERE \$\{scopeColumn\} = \$5\s*RETURNING id`[\s\S]{0,80}\);\s*_syncCardsSoon\(_bankRes && _bankRes\.rows, 'bank'\)/],
    ['주소', /RETURNING id`, \[addr, scopeValue\]\);\s*_syncCardsSoon\(_addrRes && _addrRes\.rows, 'address'\)/],
  ]) assert(re.test(rv), label + ' 저장 뒤 카드 바로 맞추기');
  assert(!/await\s+_syncCardsSoon|await\s+cards\.syncOwnerCardsSoon/.test(rv), '기다리지 않는다');
  const mo = read('src/services/manualOrder.service.js');
  assert(/if \(typeof db\.connect === 'function'\) \{\s*try \{ for \(const row of \(_fillRes && _fillRes\.rows\) \|\| \[\]\) require\('\.\/reviewerIdentityCards\.service'\)\.syncOwnerCardsSoon/.test(mo), '외부 주문: 트랜잭션 밖일 때만');
  const cs = read('src/services/reviewerIdentityCards.service.js');
  assert(/CARD_SELECT\} WHERE owner_reviewer_id = \$1 FOR NO KEY UPDATE/.test(cs) && !/CARD_SELECT\} WHERE owner_reviewer_id = \$1 FOR UPDATE/.test(cs), '카드 맞추기 잠금 = FOR NO KEY UPDATE');
  console.log('PASS 배선 — 가입·소득·계좌·주소·외부주문 저장 뒤 · 기다리지 않음 · 카드 잠금 완화');
})().catch((e) => { console.error(e); process.exit(1); });
