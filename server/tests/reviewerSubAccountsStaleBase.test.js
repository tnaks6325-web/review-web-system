'use strict';
/*
 * 결정 358 — 내정보 타계정 저장의 기준 목록 비교(낙관적 동시성).
 *   리뷰어 홈은 「이 화면이 받은 타계정 목록」(baseSubAccounts)을 함께 보낸다. 서버는 잠금 안에서 지금 목록과 비교해
 *   다르면 쓰지 않고 stale_sub_accounts 로 거절한다(불러오기 실패·오래 열어 둔 화면이 기존 타계정을 지우던 사고 S1).
 *   기준 목록이 없으면(구버전 화면 · 리뷰 제출 화면) 종전 동작 그대로.
 * 스텁 pool 로 handleReviewerProfile 을 실제로 돌린다(결정 177 창구 mutateSubAccounts 포함).
 */
const assert = require('assert');
const pool = require('../src/db/pool');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

const OWNER = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b';
const CURRENT = () => [
  { name: '김타계', phone: '010-1111-2222', bankAccount: '111', jumin: '9001011234567', shoppingId: 'keep-1' },
  { name: '이타계', phone: '010-3333-4444', address: '서울' },
];

function install({ current = CURRENT(), folded = [] } = {}) {
  const log = { updates: [], sqls: [] };
  const query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    log.sqls.push(s);
    if (/SELECT id, reviewer_no FROM reviewers/.test(s)) return { rows: [{ id: OWNER, reviewer_no: null }] };
    if (/FROM reviewer_identity_decisions/.test(s)) return { rows: folded };
    if (/SELECT sub_accounts FROM reviewers WHERE id = \$1$/.test(s)) return { rows: [{ sub_accounts: current }] };
    if (/FOR NO KEY UPDATE/.test(s)) return { rows: [{ id: OWNER, name: '본인', phone: '010-9999-8888', sub_accounts: current }] };
    if (/^UPDATE reviewers SET sub_accounts/.test(s)) { log.updates.push(JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  return log;
}

(async () => {
  const origQuery = pool.query, origConnect = pool.connect;
  const reviewer = require('../src/services/reviewer.service');
  const save = (extra) => reviewer.handleReviewerProfile({ action: 'saveSubAccounts', phone8: '99998888', ownerReviewerId: OWNER, ...extra });
  try {
    await test('S1: 불러오기 실패 화면(기준 = 빈 목록)이 1명만 보내면 쓰지 않고 stale_sub_accounts', async () => {
      const log = install();
      const out = await save({ baseSubAccounts: '[]', subAccounts: JSON.stringify([{ name: '새타계', phone: '010-5555-6666' }]) });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.code, 'stale_sub_accounts');
      assert.ok(/다시 불러/.test(out.error), out.error);
      assert.strictEqual(log.updates.length, 0, '기존 타계정을 덮지 않는다');
    });
    await test('다른 기기에서 계좌를 고친 뒤 옛 화면이 저장해도 쓰지 않는다(이름·번호가 같아도 내용 비교)', async () => {
      const log = install();
      const base = CURRENT(); base[0].bankAccount = '000';   // 화면이 받은 때의 옛 계좌
      const out = await save({ baseSubAccounts: JSON.stringify(base), subAccounts: JSON.stringify(base) });
      assert.strictEqual(out.code, 'stale_sub_accounts');
      assert.strictEqual(log.updates.length, 0);
    });
    await test('기준이 지금과 같으면 저장 · shoppingId 는 비교에서 빼고 보존(결정 177) · 저장된 목록을 돌려준다', async () => {
      const log = install();
      const base = CURRENT().map((s) => { const c = { ...s }; delete c.shoppingId; return c; });   // 화면이 받은 뒤 아이디만 PATCH 로 바뀜
      const next = [...base.map((s) => ({ ...s })), { name: '새타계', phone: '010-5555-6666' }];
      const out = await save({ baseSubAccounts: JSON.stringify(base), subAccounts: JSON.stringify(next) });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      assert.strictEqual(log.updates.length, 1);
      assert.deepStrictEqual(log.updates[0].map((s) => s.name), ['김타계', '이타계', '새타계']);
      assert.strictEqual(log.updates[0][0].shoppingId, 'keep-1');
      assert.deepStrictEqual(out.subAccounts, log.updates[0], '응답 = 실제로 저장된 목록(다음 저장의 기준)');
    });
    await test('기준 목록의 키 순서만 다르면 같은 목록으로 본다', async () => {
      const log = install();
      const base = CURRENT().map((s) => Object.fromEntries(Object.entries(s).reverse()));
      const out = await save({ baseSubAccounts: JSON.stringify(base), subAccounts: JSON.stringify(CURRENT().slice(0, 1)) });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      assert.strictEqual(log.updates.length, 1);
    });
    await test('기준 목록이 배열(문자열 아님)으로 와도 비교한다', async () => {
      const log = install();
      const out = await save({ baseSubAccounts: [], subAccounts: [] });
      assert.strictEqual(out.code, 'stale_sub_accounts');
      assert.strictEqual(log.updates.length, 0);
    });
    await test('기준 목록 형식이 깨지면 쓰지 않는다(fail-closed)', async () => {
      const log = install();
      const out = await save({ baseSubAccounts: '{oops', subAccounts: '[]' });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(log.updates.length, 0);
    });
    await test('기준 목록이 없으면(구버전 화면·리뷰 제출 화면) 종전대로 통째 저장 — 배포 스큐', async () => {
      const log = install();
      const out = await save({ subAccounts: JSON.stringify([{ name: '새타계', phone: '010-5555-6666' }]) });
      assert.strictEqual(out.ok, true);
      assert.strictEqual(log.updates.length, 1);
      assert.deepStrictEqual(log.updates[0].map((s) => s.name), ['새타계']);
    });
    await test('결정 226: 정리로 지운 칸이 기준 목록에만 남아 있으면 비교에서 빼고 저장(정리 칸은 되살리지 않음)', async () => {
      const folded = [{ name: '정리칸', phone: '010-7777-8888' }];
      const log = install({ folded });
      const base = [...CURRENT(), { name: '정리칸', phone: '010-7777-8888' }];
      const out = await save({ baseSubAccounts: JSON.stringify(base), subAccounts: JSON.stringify(base) });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      assert.strictEqual(log.updates.length, 0, '정리 칸을 빼면 지금과 같다 → 바꿀 것 없음');
      assert.strictEqual(out.foldedSkipped, 1);
    });
  } finally {
    pool.query = origQuery; pool.connect = origConnect;
  }
  console.log(`\n✅ reviewerSubAccountsStaleBase: ${passed}개 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
