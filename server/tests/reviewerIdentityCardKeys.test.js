'use strict';
/*
 * 명의 카드 조각 3-1 (결정 기록 178) — 구매양식 명의 확인이 카드 번호를 이름표로 쓴다.
 *   A. 짝짓기 순수 함수: 확실한 칸만 카드 번호, 나머지는 옛 이름표
 *   B. 명의 목록(스텁): 칸 순서가 바뀌어도 이름표가 그대로 · 스위치 끄면 옛 이름표 · 카드 조회 실패는 옛 이름표
 *   C. 주소 추천은 카드 이름표 + 옛 이름표 두 해시를 본다 · 아이디 저장은 옛 이름표로도 찾는다
 *   D. PGTEST_URL(전체 마이그레이션 적용 DB) 있으면 진짜 PG: 과거 기록 옮기기 미리보기·적용·재실행·순서 바뀐 기록 보존
 */
const assert = require('assert');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const cards = require('../src/services/reviewerIdentityCards.service');
const roi = require('../src/services/reviewerOrderIdentity.service');
const { legacyIdentityKey, stableHash } = roi._test;

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const OWNER = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const C1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const C2 = '22222222-aaaa-4aaa-8aaa-222222222222';
const reviewer = (subs) => ({ id: OWNER, name: '김수만', phone: '010-1111-1111', phone8: '11111111', sub_accounts: subs,
  address: '', bank_name: '', bank_account: '', account_holder: '', shopping_id: '', reviewer_no: null });
const LEE = { name: '이영희', phone: '010-2222-2222' };
const PARK = { name: '박 민수', phone: '010-3333-3333' };
const cardRows = [
  { id: 'S', kind: 'self', name_key: '김수만', phone8: '11111111' },
  { id: C1, kind: 'sub', name_key: '이영희', phone8: '22222222' },
  { id: C2, kind: 'sub', name_key: '박민수', phone8: '33333333' },
];

function stubDb(subs, { cardsRows = cardRows, cardsError = null, onQuery } = {}) {
  return {
    query: async (sql, params) => {
      if (onQuery) onQuery(String(sql), params);
      if (/FROM reviewers WHERE id = \$1/.test(sql)) return { rows: [reviewer(subs)] };
      if (/FROM reviewer_identities/.test(sql)) return { rows: [] };
      if (/FROM reviewer_identity_cards/.test(sql)) { if (cardsError) throw cardsError; return { rows: cardsRows }; }
      return { rows: [] };
    },
  };
}

(async () => {
  console.log('A. 짝짓기');
  await test('이름·번호가 딱 맞는 카드가 하나면 그 카드 번호', async () => {
    const m = cards.mapSubsToCards(reviewer([LEE, PARK]), cardRows);
    assert.deepStrictEqual([...m.byIndex], [[0, C1], [1, C2]]);
    assert.deepStrictEqual(m.misses, []);
  });
  await test('확실하지 않은 칸은 옛 이름표(칸마다 판단)', async () => {
    const m = cards.mapSubsToCards(reviewer([LEE, LEE, { name: '김수만', phone: '010-1111-1111' }, { name: '최', phone: '' },
      { name: '없음', phone: '010-9999-9999' }, PARK]),
      cardRows.concat([{ id: 'X', kind: 'sub', name_key: '박민수', phone8: '33333333' }]));
    assert.deepStrictEqual(m.misses.map((x) => `${x.index}:${x.reason}`),
      ['0:duplicate_in_list', '1:duplicate_in_list', '2:same_as_self', '3:no_name_or_phone', '4:no_card', '5:ambiguous_card']);
    assert.strictEqual(m.byIndex.size, 0);
  });
  await test('본인 카드는 타계정 짝으로 쓰지 않는다', async () => {
    const m = cards.mapSubsToCards(reviewer([{ name: '김수만', phone: '010-1111-1111' }]), [{ id: 'S', kind: 'self', name_key: '김수만', phone8: '11111111' }]);
    assert.strictEqual(m.byIndex.size, 0);
  });

  console.log('B. 명의 목록');
  await test('타계정 이름표가 카드 번호가 되고 옛 이름표도 함께 든다 · 본인은 그대로 self', async () => {
    const { identities } = await roi.loadOwnerProfile(OWNER, stubDb([LEE, PARK]));
    assert.strictEqual(identities[0].identityKey, 'self');
    assert.strictEqual(identities[1].identityKey, `card:${C1}`);
    assert.strictEqual(identities[1].legacyIdentityKey, legacyIdentityKey(LEE.name, LEE.phone, 0));
    assert.strictEqual(identities[2].identityKey, `card:${C2}`);
    assert.strictEqual(identities[2].subIndex, 1);
  });
  await test('★ 칸 순서가 바뀌어도 이름표는 그대로다(이 조각의 목적)', async () => {
    const a = (await roi.loadOwnerProfile(OWNER, stubDb([LEE, PARK]))).identities;
    const b = (await roi.loadOwnerProfile(OWNER, stubDb([PARK, LEE]))).identities;
    const keyOf = (list, name) => list.find((i) => i.name === name).identityKey;
    assert.strictEqual(keyOf(a, '이영희'), keyOf(b, '이영희'));
    assert.strictEqual(keyOf(a, '박 민수'), keyOf(b, '박 민수'));
    assert.notStrictEqual(a.find((i) => i.name === '이영희').legacyIdentityKey, b.find((i) => i.name === '이영희').legacyIdentityKey);
  });
  await test('스위치를 끄면 전부 옛 이름표', async () => {
    process.env.IDENTITY_CARDS_READ = '0';
    try {
      let asked = false;
      const { identities } = await roi.loadOwnerProfile(OWNER, stubDb([LEE], { onQuery: (s) => { if (/reviewer_identity_cards/.test(s)) asked = true; } }));
      assert.strictEqual(identities[1].identityKey, legacyIdentityKey(LEE.name, LEE.phone, 0));
      assert.strictEqual(asked, false);
    } finally { delete process.env.IDENTITY_CARDS_READ; }
  });
  await test('카드 표가 없거나 조회가 실패해도 막지 않고 옛 이름표', async () => {
    const e1 = Object.assign(new Error('no table'), { code: '42P01' });
    const e2 = Object.assign(new Error('boom'), { code: 'XX000' });
    for (const err of [e1, e2]) {
      const { identities } = await roi.loadOwnerProfile(OWNER, stubDb([LEE], { cardsError: err }));
      assert.strictEqual(identities[1].identityKey, legacyIdentityKey(LEE.name, LEE.phone, 0));
    }
  });
  await test('카드가 아직 없는 칸만 옛 이름표, 나머지는 카드 번호', async () => {
    const { identities } = await roi.loadOwnerProfile(OWNER, stubDb([LEE, { name: '새사람', phone: '010-7777-7777' }]));
    assert.strictEqual(identities[1].identityKey, `card:${C1}`);
    assert.strictEqual(identities[2].identityKey, legacyIdentityKey('새사람', '010-7777-7777', 1));
  });

  console.log('C. 소비처');
  await test('주소 추천은 카드 이름표와 옛 이름표 두 해시를 함께 본다', async () => {
    let params;
    const db = { query: async (sql, p) => { if (/eligible_orders/.test(sql)) params = p; return { rows: [] }; } };
    await roi.loadOrderInfoSuggestions({ owner: { id: OWNER }, selected: { identityKey: `card:${C1}`, legacyIdentityKey: 'sub:old' } }, db);
    assert.deepStrictEqual(params[1], [stableHash(`card:${C1}`), stableHash('sub:old')]);
  });
  await test('본인·옛 이름표뿐이면 해시 하나만 본다', async () => {
    let params;
    const db = { query: async (sql, p) => { if (/eligible_orders/.test(sql)) params = p; return { rows: [] }; } };
    await roi.loadOrderInfoSuggestions({ owner: { id: OWNER }, selected: { identityKey: 'self' } }, db);
    assert.deepStrictEqual(params[1], [stableHash('self')]);
  });
  await test('명의 아이디 저장은 새로고침 전 화면의 옛 이름표로도 그 명의를 찾는다', async () => {
    const pool = require('../src/db/pool');
    const orig = pool.connect;
    const log = [];
    const q = async (sql, params) => {
      log.push({ sql: String(sql).replace(/\s+/g, ' '), params });
      if (/FROM reviewers WHERE id = \$1 LIMIT 1/.test(sql)) return { rows: [reviewer([LEE, PARK])] };
      if (/FROM reviewer_identity_cards/.test(sql)) return { rows: cardRows };
      return { rows: [], rowCount: 1 };
    };
    pool.connect = async () => ({ query: q, release() {} });
    try {
      const out = await roi.saveShoppingId(OWNER, legacyIdentityKey(PARK.name, PARK.phone, 1), 'my-id');
      assert.strictEqual(out.identityKey, `card:${C2}`);
      const upd = log.find((x) => /^UPDATE reviewers SET sub_accounts/.test(x.sql));
      assert.strictEqual(JSON.parse(upd.params[1])[1].shoppingId, 'my-id');
    } finally { pool.connect = orig; }
  });

  if (!process.env.PGTEST_URL) {
    console.log(`\n✅ reviewerIdentityCardKeys: ${passed}개 통과 (PGTEST_URL 없음 — 진짜 PG 단계 생략)`);
    process.exit(0);
  }

  console.log('D. 진짜 PG (전체 마이그레이션 적용 DB)');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.PGTEST_URL });
  const has = (await db.query(`SELECT to_regclass('public.order_submissions') t, to_regclass('public.reviewer_identity_cards') c`)).rows[0];
  if (!has.t || !has.c) {
    console.log('  (전체 마이그레이션이 적용된 DB 가 아니라 D 단계 생략)');
    await db.end();
    console.log(`\n✅ reviewerIdentityCardKeys: ${passed}개 통과`);
    process.exit(0);
  }
  const RID = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
  const cleanup = async () => {
    await db.query(`DELETE FROM order_submissions WHERE owner_reviewer_id = $1`, [RID]);
    await db.query(`DELETE FROM reviewers WHERE id = $1`, [RID]);
  };
  await cleanup();
  const subs = [{ name: '이영희', phone: '010-4242-2222' }, { name: '박민수', phone: '010-4242-3333' }, { name: '최지우', phone: '010-4242-4444' }];
  await db.query(`INSERT INTO reviewers (id, name, phone, sub_accounts) VALUES ($1, '테스트소유', '010-4242-1111', $2::jsonb)`, [RID, JSON.stringify(subs)]);
  await cards.reconcileCards({ db, dryRun: false, by: 'test' });
  let seqNo = 0;
  const addOrder = (hash) => db.query(`INSERT INTO order_submissions (sheet_id, tab_name, owner_reviewer_id, participant_identity_key_hash) VALUES ('t',$3,$1,$2)`, [RID, hash, 't' + (seqNo++)]);
  await addOrder(stableHash('self'));
  await addOrder(stableHash(legacyIdentityKey('이영희', '010-4242-2222', 0)));
  await addOrder(stableHash(legacyIdentityKey('이영희', '010-4242-2222', 0)));
  await addOrder(stableHash(legacyIdentityKey('박민수', '010-4242-3333', 1)));
  await addOrder(stableHash(legacyIdentityKey('최지우', '010-4242-4444', 0))); // 순서가 이미 바뀐 기록 — 지금 칸과 안 맞음
  const hashes = async () => (await db.query(`SELECT participant_identity_key_hash h FROM order_submissions WHERE owner_reviewer_id = $1 ORDER BY tab_name`, [RID])).rows.map((r) => r.h);
  const before = await hashes();
  try {
    await test('미리보기는 쓰지 않고, 옮길 수 있는 건과 맞지 않는 건을 센다', async () => {
      const r = await roi.rebindLegacySubHashes({ db, dryRun: true });
      assert.ok(r.movable >= 3 && r.noMatch >= 1, JSON.stringify(r));
      assert.deepStrictEqual(await hashes(), before);
    });
    await test('적용하면 지금 칸과 맞는 기록만 카드 이름표로 옮긴다(본인·순서 바뀐 기록은 그대로)', async () => {
      await roi.rebindLegacySubHashes({ db, dryRun: false });
      const { identities } = await roi.loadOwnerProfile(RID, db);
      const keyOf = (n) => stableHash(identities.find((i) => i.name === n).identityKey);
      const after = await hashes();
      assert.strictEqual(after[0], stableHash('self'));
      assert.strictEqual(after[1], keyOf('이영희'));
      assert.strictEqual(after[2], keyOf('이영희'));
      assert.strictEqual(after[3], keyOf('박민수'));
      assert.strictEqual(after[4], before[4]);
    });
    await test('다시 돌려도 결과가 같다', async () => {
      const snap = await hashes();
      const r = await roi.rebindLegacySubHashes({ db, dryRun: false });
      assert.deepStrictEqual(await hashes(), snap);
      assert.deepStrictEqual(r.failed, []);
    });
    await test('옮긴 뒤 목록 순서를 바꿔도 주소 추천 조회 대상(이름표)이 그대로다', async () => {
      await db.query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`, [RID, JSON.stringify([subs[2], subs[1], subs[0]])]);
      await cards.reconcileCards({ db, dryRun: false, by: 'test' });
      const { identities } = await roi.loadOwnerProfile(RID, db);
      const lee = identities.find((i) => i.name === '이영희');
      assert.strictEqual(stableHash(lee.identityKey), (await hashes())[1]);
    });
  } finally {
    await cleanup();
    await db.end();
  }
  console.log(`\n✅ reviewerIdentityCardKeys: ${passed}개 통과 (진짜 PG 포함)`);
  process.exit(0);
})().catch((err) => { console.error('❌', err.stack || err.message); process.exit(1); });
