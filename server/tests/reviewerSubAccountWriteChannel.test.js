'use strict';
/*
 * 타계정 목록 쓰기 창구 — 명의 카드 2단계 조각 2-2 (결정 기록 177)
 *   A. 배선: 쓰는 곳 8곳이 전부 창구(mutateSubAccounts) 또는 잠금+카드 맞추기(syncCardsAfterWrite)를 탄다
 *   B. 스텁 실행: 결제 계좌 보완이 같은 번호를 쓰는 타계정을 이름으로 가른다 · 모호하면 쓰지 않는다 ·
 *      내정보 저장이 같은 번호 리뷰어 여럿이면 쓰지 않는다
 *   C. PGTEST_URL 있으면 진짜 PG: 동시 저장 두 건이 둘 다 남는다 · 저장 즉시 카드가 맞춰진다 ·
 *      카드 맞추기가 실패해도 저장은 유지된다 · 주문·참여 INSERT(외래키)를 막지 않는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

(async () => {
  console.log('A. 배선');
  const WRITERS = {
    'src/routes/submit.routes.js': 'channel',
    'src/services/reviewer.service.js': 'channel',
    'src/services/manualOrder.service.js': 'channel',
    'src/services/reviewerOrderIdentity.service.js': 'sync',
    'src/services/reviewerIdentity.service.js': 'sync',
    'src/services/payment.service.js': 'sync',
    'src/services/reviewerPhoneChange.service.js': 'sync',
  };
  await test('타계정 목록을 직접 저장하는 문장은 창구와 이미 잠그는 4곳 밖에 없다', async () => {
    const src = path.resolve(__dirname, '../src');
    const hits = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (!p.endsWith('.js')) return;
      if (/UPDATE reviewers SET[^`'"]*sub_accounts\s*=/.test(stripComments(fs.readFileSync(p, 'utf8')))) hits.push(path.relative(path.resolve(__dirname, '..'), p));
    });
    walk(src);
    const allowed = ['src/services/reviewerIdentityCards.service.js',
      ...Object.entries(WRITERS).filter(([, k]) => k === 'sync').map(([f]) => f)];
    assert.deepStrictEqual(hits.sort(), allowed.sort());
  });
  await test('창구를 쓰는 3곳은 직접 저장 문장이 없고 창구를 부른다', async () => {
    for (const [f, kind] of Object.entries(WRITERS)) {
      if (kind !== 'channel') continue;
      const s = stripComments(read(f));
      assert.ok(/mutateSubAccounts\(/.test(s), f);
    }
  });
  await test('이미 잠그는 4곳은 저장 뒤 카드를 맞춘다(같은 트랜잭션)', async () => {
    for (const [f, kind] of Object.entries(WRITERS)) {
      if (kind !== 'sync') continue;
      assert.ok(/await syncCardsAfterWrite\(client,/.test(stripComments(read(f))), f);
    }
  });
  await test('명의 아이디 저장은 읽기 전에 소유자 행을 잠근다', async () => {
    const s = read('src/services/reviewerOrderIdentity.service.js');
    const body = s.slice(s.indexOf('async function saveShoppingId'), s.indexOf('async function saveShoppingId') + 1500);
    assert.ok(body.indexOf('FOR NO KEY UPDATE') > 0 && body.indexOf('FOR NO KEY UPDATE') < body.indexOf('loadOwnerProfile(ownerReviewerId, client)'));
  });
  await test('구매양식 자동보강은 칸 순번이 아니라 이름+번호로 다시 찾는다', async () => {
    const s = stripComments(read('src/routes/submit.routes.js'));
    assert.ok(/findSubIndex\(subs, _target\.name, _target\.phone\)/.test(s));
    assert.ok(!/UPDATE reviewers SET sub_accounts = \$1::jsonb WHERE phone8/.test(s));
  });
  await test('창구 잠금은 FOR NO KEY UPDATE(외래키 INSERT 를 막지 않는다)', async () => {
    const s = read('src/services/reviewerIdentityCards.service.js');
    const body = s.slice(s.indexOf('async function mutateSubAccountsInTx'));
    assert.ok(/FOR NO KEY UPDATE/.test(body.slice(0, 400)));
  });
  await test('결제 화면은 타계정 이름을 함께 보낸다', async () => {
    const wd = fs.readFileSync(path.resolve(__dirname, '../../frontend/workdesk.html'), 'utf8');
    assert.ok(/subName:a\.ref\.subName\|\|null/.test(wd));
    assert.ok(/subName: b\.subName/.test(read('src/routes/trackB.routes.js')));
    assert.ok(/sub_ambiguous: 409/.test(read('src/routes/trackB.routes.js')));
  });

  console.log('B. 스텁 실행');
  const svc = require('../src/services/reviewerIdentityCards.service');
  await test('findSubIndex: 이름+번호가 딱 하나일 때만 찾는다', async () => {
    const subs = [{ name: '김 민수', phone: '010-1111-2222' }, { name: '김민우', phone: '010-1111-2222' }, { name: '이영희', phone: '010-3333-4444' }];
    assert.strictEqual(svc.findSubIndex(subs, '김민수', '01011112222'), 0);
    assert.strictEqual(svc.findSubIndex(subs, '김민우', '1111-2222'), 1);
    assert.strictEqual(svc.findSubIndex(subs.concat([{ name: '김민수', phone: '010-1111-2222' }]), '김민수', '01011112222'), -1);
    assert.strictEqual(svc.findSubIndex(subs, '', '01011112222'), -1);
  });

  const pool = require('../src/db/pool');
  const bankOv = require('../src/services/bankNameOverride.service');
  const origConnect = pool.connect, origQuery = pool.query, origEnsure = bankOv.ensureBankOverrides;
  bankOv.ensureBankOverrides = async () => {};
  const OWNER = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
  const family = () => [
    { name: '김엄마', phone: '010-5555-6666', bankName: '국민은행', bankAccount: '111' },
    { name: '김아이', phone: '010-5555-6666', bankName: '신한은행', bankAccount: '222' },
  ];
  function stubConn(subs, log) {
    const query = async (sql, params) => {
      log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/SELECT sub_accounts FROM reviewers WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ sub_accounts: subs }] };
      return { rows: [], rowCount: 1 };
    };
    return { query, release() {} };
  }
  const payment = require('../src/services/payment.service');
  try {
    await test('결제 계좌 보완: 같은 번호를 쓰는 타계정은 이름으로 정확한 명의에 저장한다', async () => {
      const log = [];
      pool.connect = async () => stubConn(family(), log);
      await payment.saveReviewerAccount({ reviewerId: OWNER, subPhone8: '55556666', subName: '김아이', bankAccount: '999', by: 't' });
      const upd = log.find((q) => /^UPDATE reviewers SET sub_accounts/.test(q.sql));
      const saved = JSON.parse(upd.params[1]);
      assert.strictEqual(saved[0].bankAccount, '111');
      assert.strictEqual(saved[1].bankAccount, '999');
    });
    await test('결제 계좌 보완: 이름 없이 여러 타계정이 쓰는 번호만 오면 저장하지 않는다(종전: 첫 사람에게 저장)', async () => {
      const log = [];
      pool.connect = async () => stubConn(family(), log);
      await assert.rejects(payment.saveReviewerAccount({ reviewerId: OWNER, subPhone8: '55556666', bankAccount: '999', by: 't' }),
        (e) => e.code === 'sub_ambiguous');
      assert.ok(!log.some((q) => /^UPDATE reviewers/.test(q.sql)));
    });
    await test('결제 계좌 보완: 번호가 하나뿐이면 이름이 없어도 종전대로 저장한다', async () => {
      const log = [];
      pool.connect = async () => stubConn([{ name: '이영희', phone: '010-3333-4444' }], log);
      await payment.saveReviewerAccount({ reviewerId: OWNER, subPhone8: '33334444', bankAccount: '777', by: 't' });
      assert.ok(log.some((q) => /^UPDATE reviewers SET sub_accounts/.test(q.sql)));
    });
    await test('내정보 저장: 같은 번호 리뷰어가 둘이면 아무것도 쓰지 않는다(종전: 둘 다 덮음)', async () => {
      const log = [];
      pool.query = async (sql, params) => { log.push(String(sql)); if (/SELECT id, reviewer_no FROM reviewers/.test(sql)) return { rows: [{ id: 'a', reviewer_no: null }, { id: 'b', reviewer_no: null }] }; return { rows: [] }; };
      pool.connect = async () => { throw new Error('트랜잭션을 열면 안 된다'); };
      const reviewer = require('../src/services/reviewer.service');
      const out = await reviewer.handleReviewerProfile({ action: 'saveSubAccounts', phone8: '12345678', subAccounts: [{ name: '가', phone: '010-0000-1111' }] });
      assert.strictEqual(out.code, 'ambiguous_reviewer');
      assert.ok(!log.some((s) => /UPDATE/.test(s)));
    });
  } finally {
    pool.connect = origConnect; pool.query = origQuery; bankOv.ensureBankOverrides = origEnsure;
  }

  if (!process.env.PGTEST_URL) {
    console.log(`\n✅ reviewerSubAccountWriteChannel: ${passed}개 통과 (PGTEST_URL 없음 — 진짜 PG 단계 생략)`);
    process.exit(0);
  }

  console.log('C. 진짜 PG');
  const { Pool } = require('pg');
  // ★ 전용 스키마 안에서만 만든다 — 공용 시험 DB 의 reviewers 를 지우면 다른 PG 가드가 전부 깨진다.
  const SCHEMA = 'ic_write_channel_test';
  { const boot = new Pool({ connectionString: process.env.PGTEST_URL });
    await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`); await boot.end(); }
  const db = new Pool({ connectionString: process.env.PGTEST_URL, max: 6 , options: `-c search_path=${SCHEMA}` });
  await db.query(`CREATE TABLE reviewers (id UUID PRIMARY KEY, name TEXT, phone TEXT, address TEXT, bank_name TEXT,
    bank_account TEXT, account_holder TEXT, shopping_id TEXT, income_type TEXT, sub_accounts JSONB DEFAULT '[]',
    registered_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(fs.readFileSync(path.resolve(__dirname, '../migrations/166_reviewer_identity_cards.sql'), 'utf8'));
  await db.query(`CREATE TABLE child_orders (id SERIAL PRIMARY KEY, owner_reviewer_id UUID REFERENCES reviewers(id))`);
  await db.query(`INSERT INTO reviewers (id, name, phone, sub_accounts) VALUES ($1, '김수만', '010-1111-1111', '[]')`, [OWNER]);
  const subsNow = async () => (await db.query('SELECT sub_accounts FROM reviewers WHERE id = $1', [OWNER])).rows[0].sub_accounts;
  const activeCards = async () => (await db.query(`SELECT kind, name, phone8 FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 AND status = 'active' ORDER BY kind, name`, [OWNER])).rows;

  await test('저장하면 같은 트랜잭션에서 카드가 바로 맞춰진다', async () => {
    const r = await svc.mutateSubAccounts(OWNER, (subs) => { subs.push({ name: '이영희', phone: '010-2222-2222' }); return subs; }, { db, source: 'test' });
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual((await activeCards()).map((c) => c.name + '/' + c.phone8), ['김수만/11111111', '이영희/22222222']);
  });
  await test('동시에 두 명의를 추가해도 둘 다 남는다(종전: 한쪽이 사라짐)', async () => {
    await Promise.all([
      svc.mutateSubAccounts(OWNER, async (subs) => { await new Promise((r) => setTimeout(r, 150)); subs.push({ name: '박민수', phone: '010-3333-3333' }); return subs; }, { db }),
      (async () => { await new Promise((r) => setTimeout(r, 30));
        return svc.mutateSubAccounts(OWNER, (subs) => { subs.push({ name: '최지우', phone: '010-4444-4444' }); return subs; }, { db }); })(),
    ]);
    const names = (await subsNow()).map((s) => s.name).sort();
    assert.deepStrictEqual(names, ['박민수', '이영희', '최지우']);
    assert.strictEqual((await activeCards()).length, 4);
  });
  await test('바꿀 게 없으면 저장하지 않는다', async () => {
    const r = await svc.mutateSubAccounts(OWNER, () => null, { db });
    assert.strictEqual(r.changed, false);
  });
  await test('카드 맞추기가 실패해도 저장은 유지된다(거울이 따라잡는다)', async () => {
    await db.query(`CREATE OR REPLACE FUNCTION ic_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`);
    await db.query(`CREATE TRIGGER ic_boom BEFORE INSERT ON reviewer_identity_cards FOR EACH ROW EXECUTE FUNCTION ic_boom()`);
    try {
      const r = await svc.mutateSubAccounts(OWNER, (subs) => { subs.push({ name: '정하늘', phone: '010-5555-5555' }); return subs; }, { db });
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.cards.ok, false);
      assert.ok((await subsNow()).some((s) => s.name === '정하늘'));
    } finally {
      await db.query('DROP TRIGGER ic_boom ON reviewer_identity_cards; DROP FUNCTION ic_boom()');
    }
    await svc.reconcileCards({ db, dryRun: false, by: 'test' });
    assert.ok((await activeCards()).some((c) => c.name === '정하늘'));
  });
  await test('저장 중에도 그 리뷰어의 주문 INSERT(외래키)는 막히지 않는다', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await svc.mutateSubAccountsInTx(client, OWNER, (subs) => { subs.push({ name: '한별', phone: '010-6666-6666' }); return subs; });
      const other = await db.connect();
      try {
        await other.query("SET lock_timeout = '1s'");
        await other.query('INSERT INTO child_orders (owner_reviewer_id) VALUES ($1)', [OWNER]);
      } finally { other.release(); }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  });
  await test('리뷰어가 없으면 저장하지 않고 알린다', async () => {
    await assert.rejects(svc.mutateSubAccounts('00000000-0000-4000-8000-000000000000', (s) => s, { db }), (e) => e.code === 'reviewer_not_found');
  });

  await db.end();
  { const boot = new Pool({ connectionString: process.env.PGTEST_URL }); await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await boot.end(); }
  console.log(`\n✅ reviewerSubAccountWriteChannel: ${passed}개 통과 (진짜 PG 포함)`);
  process.exit(0);
})().catch((err) => { console.error('❌', err.stack || err.message); process.exit(1); });
