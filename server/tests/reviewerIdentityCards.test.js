'use strict';
/*
 * 명의 카드 — 2단계 조각 1 (migration 166 · 결정 기록 175)
 *   A. 카드 만들기 규칙(순수 함수) — 완전 중복만 합침 · 가족 같은 번호 허용 · 같은 이름 다른 번호는 보고만 · 주민번호 미복제
 *   B. 아무도 카드를 읽지 않는다(이 조각의 약속) · 라우트 게이트
 *   C. PGTEST_URL 있으면 진짜 PG 로: 마이그레이션 멱등 · 미리보기 쓰기 0 · confirm 게이트 · 적용 멱등 ·
 *      sub_accounts 무변경 · 빈 칸만 채움 · 완전 중복 차단(유일 인덱스)
 *      PGTEST_URL=postgres://postgres@127.0.0.1:55432/postgres node tests/reviewerIdentityCards.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const svc = require('../src/services/reviewerIdentityCards.service');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

const OWNER = {
  id: '11111111-1111-4111-8111-111111111111', name: '김수만', phone: '010-1111-2222', address: '서울 본인로 1',
  bank_name: '국민', bank_account: '111', account_holder: '김수만', shopping_id: 'me', income_type: '사업',
  sub_accounts: [
    { name: '이영희', phone: '010-1111-2222', address: '서울 본인로 1', jumin: '9001011234567' },   // 가족 · 같은 번호
    { name: '김민수', phone: '010-3333-5678', address: '' },                                          // 주소 없음
    { name: '박지훈', phone: '010-3333-5678', address: '부산 1' },                                    // 같은 번호 · 다른 이름
    { name: '김민수', phone: '010-9999-9999', address: '대구 1', bankName: '신한', bankAccount: '222' }, // 같은 이름 · 다른 번호
    { name: '김 민 수', phone: '01033335678', address: '광주 1' },                                    // 김민수(5678)와 완전 중복
    { name: '', phone: '010-0000-0000' },                                                               // 이름 없음
  ],
};

(async () => {
  console.log('A. 카드 만들기 규칙');
  await test('본인 + 타계정이 각각 카드가 되고, 완전 중복은 한 장으로 합쳐 빈 칸만 채운다', async () => {
    const { cards, issues } = svc.buildCardsFromReviewer(OWNER);
    assert.deepStrictEqual(cards.map((c) => `${c.kind}:${c.name}:${c.phone8}`), [
      'self:김수만:11112222', 'sub:이영희:11112222', 'sub:김민수:33335678', 'sub:박지훈:33335678', 'sub:김민수:99999999',
    ]);
    const minsu = cards.find((c) => c.phone8 === '33335678' && c.nameKey === '김민수');
    assert.strictEqual(minsu.address, '광주 1', '빈 주소는 중복 칸의 값으로 채운다');
    assert.strictEqual(minsu.sourceIndex, 1, '먼저 나온 칸을 남긴다');
    assert.ok(issues.some((i) => i.code === 'exact_duplicate' && i.sourceIndex === 4 && i.conflicts.length === 0));
    assert.ok(issues.some((i) => i.code === 'missing_name' && i.sourceIndex === 5));
  });
  await test('가족이 같은 번호를 써도 이름이 다르면 따로 카드가 된다(결정 1가)', async () => {
    const { cards } = svc.buildCardsFromReviewer(OWNER);
    assert.strictEqual(cards.filter((c) => c.phone8 === '11112222').length, 2);
    assert.strictEqual(cards.filter((c) => c.phone8 === '33335678').length, 2);
  });
  await test('이름만 같고 번호가 다르면 합치지 않고 보고만 한다(결정 2가)', async () => {
    const { cards, issues } = svc.buildCardsFromReviewer(OWNER);
    assert.strictEqual(cards.filter((c) => c.nameKey === '김민수').length, 2);
    assert.ok(issues.some((i) => i.code === 'same_name_diff_phone'));
  });
  await test('완전 중복인데 값이 서로 다르면 사람이 보도록 남긴다', async () => {
    const r = { ...OWNER, sub_accounts: [{ name: 'A', phone: '010-1234-5678', address: '가' }, { name: 'A', phone: '01012345678', address: '나' }] };
    const { cards, issues } = svc.buildCardsFromReviewer(r);
    assert.strictEqual(cards.filter((c) => c.kind === 'sub').length, 1);
    assert.strictEqual(cards[1].address, '가');
    assert.deepStrictEqual(issues.find((i) => i.code === 'exact_duplicate').conflicts, ['address']);
  });
  await test('주민번호는 카드에 옮기지 않는다', async () => {
    const { cards } = svc.buildCardsFromReviewer(OWNER);
    for (const c of cards) assert.ok(!JSON.stringify(c).includes('9001011234567'));
  });
  await test('문자열로 저장된 목록도 읽는다', async () => {
    const { cards } = svc.buildCardsFromReviewer({ ...OWNER, sub_accounts: JSON.stringify([{ name: 'B', phone: '010-5555-6666' }]) });
    assert.strictEqual(cards.length, 2);
  });

  console.log('B. 이 조각의 약속');
  await test('카드 표를 읽는 코드는 카드 서비스뿐이다(아직 아무도 카드를 쓰지 않는다)', async () => {
    const srcDir = path.resolve(__dirname, '../src');
    const hits = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('reviewer_identity_cards')) hits.push(path.relative(srcDir, p));
      }
    })(srcDir);
    // 조각 4(결정 179): 담당자 합치기 서비스도 카드 표를 다룬다 — 카드 표를 만지는 곳은 이 두 서비스뿐.
    assert.deepStrictEqual(hits.sort(), ['services/reviewerIdentityCards.service.js', 'services/reviewerIdentityMerge.service.js']);
  });
  await test('미리보기·적용 라우트는 관리자 전용이다', async () => {
    const routes = fs.readFileSync(path.resolve(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
    assert.match(routes, /router\.get\('\/identity-cards\/preview', authMiddleware, adminOrMasterMiddleware/);
    assert.match(routes, /router\.post\('\/identity-cards\/apply', authMiddleware, adminOrMasterMiddleware/);
    assert.match(routes, /confirm: b\.confirm === true/);
  });
  await test('confirm 없이 적용하면 쓰기 없이 거절한다', async () => {
    let queried = false;
    const out = await svc.applyCards({ db: { query: async () => { queried = true; return { rows: [] }; } } });
    assert.strictEqual(out.code, 'confirm_required');
    assert.strictEqual(queried, false);
  });

  await test('카드 표가 없으면(마이그레이션 미적용) 성공으로 꾸미지 않고 멈춘다', async () => {
    let released = 0;
    const client = { query: async (sql) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [{ ...OWNER }] };
      if (/reviewer_identity_cards/.test(sql)) { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }
      return { rows: [] };
    }, release: () => { released++; } };
    const db = { query: async () => ({ rows: [{ id: OWNER.id }] }), connect: async () => client };
    await assert.rejects(svc.applyCards({ db, confirm: true }), (e) => e.code === '42P01');
    assert.strictEqual(released, 1, '커넥션은 반납한다');
  });

  if (!process.env.PGTEST_URL) {
    console.log(`\n✅ reviewerIdentityCards: ${passed}개 통과 (PGTEST_URL 없음 — 진짜 PG 단계 생략)`);
    process.exit(0);
  }

  console.log('C. 진짜 PG');
  const { Pool } = require('pg');
  // ★ 전용 스키마 안에서만 만든다 — 공용 시험 DB 의 reviewers 를 지우면 다른 PG 가드가 전부 깨진다.
  const SCHEMA = 'ic_cards_test';
  { const boot = new Pool({ connectionString: process.env.PGTEST_URL });
    await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`); await boot.end(); }
  const db = new Pool({ connectionString: process.env.PGTEST_URL, options: `-c search_path=${SCHEMA}` });
  const migration = fs.readFileSync(path.resolve(__dirname, '../migrations/166_reviewer_identity_cards.sql'), 'utf8');
  await db.query(`CREATE TABLE reviewers (id UUID PRIMARY KEY, name TEXT, phone TEXT, address TEXT, bank_name TEXT,
    bank_account TEXT, account_holder TEXT, shopping_id TEXT, income_type TEXT, sub_accounts JSONB DEFAULT '[]',
    registered_at TIMESTAMPTZ DEFAULT NOW())`);
  const OTHER = { ...OWNER, id: '22222222-2222-4222-8222-222222222222', name: '최다른', phone: '010-3333-5678', sub_accounts: [] };
  for (const r of [OWNER, OTHER]) {
    await db.query(`INSERT INTO reviewers (id,name,phone,address,bank_name,bank_account,account_holder,shopping_id,income_type,sub_accounts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [r.id, r.name, r.phone, r.address, r.bank_name, r.bank_account,
      r.account_holder, r.shopping_id, r.income_type, JSON.stringify(r.sub_accounts)]);
  }
  const before = (await db.query('SELECT sub_accounts FROM reviewers ORDER BY id')).rows;

  await test('마이그레이션은 두 번 돌려도 된다', async () => {
    await db.query(migration);
    await db.query(migration);
  });
  await test('미리보기는 쓰지 않고 수를 센다', async () => {
    const p = await svc.previewCards({ db });
    assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM reviewer_identity_cards')).rows[0].n, 0);
    assert.strictEqual(p.summary.cards, 6);
    assert.strictEqual(p.summary.exactDuplicatesCollapsed, 1);
    assert.strictEqual(p.summary.sameNameDiffPhoneOwners, 1);
    assert.strictEqual(p.summary.sharedPhoneFamilyOwners, 1);
    assert.strictEqual(p.summary.crossOwnerPhones, 1, '010-3333-5678 은 두 소유자 밑에 있다');
    assert.strictEqual(p.summary.skippedEntries, 1);
  });
  await test('적용하면 카드가 생기고, 다시 돌려도 늘지 않으며, 옛 목록은 그대로다', async () => {
    const a = await svc.applyCards({ db, confirm: true });
    assert.strictEqual(a.inserted, 6);
    assert.deepStrictEqual(a.failed, []);
    const b = await svc.applyCards({ db, confirm: true });
    assert.strictEqual(b.inserted, 0);
    assert.strictEqual(b.filled, 0);
    assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM reviewer_identity_cards')).rows[0].n, 6);
    assert.deepStrictEqual((await db.query('SELECT sub_accounts FROM reviewers ORDER BY id')).rows, before);
    const p = await svc.previewCards({ db });
    assert.strictEqual(p.summary.ownersAlreadyCarded, 2);
  });
  // ★ 조각 2-1(결정 기록 176): 카드는 JSON 의 거울 — 값이 바뀌면 덮는다(조각 1 의 "빈 칸만 채움"을 대체).
  await test('목록에 명의가 늘거나 값이 바뀌면 카드도 그대로 따라간다', async () => {
    const subs = JSON.parse(JSON.stringify(OWNER.sub_accounts));
    subs[0].bankName = '우리'; subs[0].address = '바뀐 주소';
    subs.push({ name: '정새명', phone: '010-7777-8888' });
    await db.query('UPDATE reviewers SET sub_accounts = $2 WHERE id = $1', [OWNER.id, JSON.stringify(subs)]);
    const r = await svc.applyCards({ db, confirm: true });
    assert.strictEqual(r.inserted, 1);
    assert.strictEqual(r.filled, 1);
    const lee = (await db.query(`SELECT address, bank_name FROM reviewer_identity_cards WHERE name = '이영희'`)).rows[0];
    assert.deepStrictEqual(lee, { address: '바뀐 주소', bank_name: '우리' });
  });
  await test('같은 소유자 안에서 이름·번호가 완전히 같은 카드는 DB 가 막는다', async () => {
    await assert.rejects(db.query(`INSERT INTO reviewer_identity_cards (owner_reviewer_id, kind, name, name_key, phone8)
      VALUES ($1, 'sub', '이영희', '이영희', '11112222')`, [OWNER.id]), (e) => e.code === '23505');
  });
  // ★ 조각 1 의 카드는 사본이다 — 리뷰어 삭제(등록리뷰어DB)를 막으면 기존 기능이 바뀐다.
  await test('리뷰어를 지우면 그 리뷰어의 카드도 함께 지워진다(삭제 기능 무변경)', async () => {
    // 합친 카드(merged_into)가 서로를 가리켜도 삭제가 막히지 않아야 한다
    const ids = (await db.query('SELECT id FROM reviewer_identity_cards WHERE owner_reviewer_id = $1', [OTHER.id])).rows;
    const extra = (await db.query(`INSERT INTO reviewer_identity_cards (owner_reviewer_id, kind, name, name_key, phone8, status, merged_into)
      VALUES ($1,'sub','옛명의','옛명의','12341234','merged',$2) RETURNING id`, [OTHER.id, ids[0].id])).rows[0];
    assert.ok(extra.id);
    await db.query('DELETE FROM reviewers WHERE id = $1', [OTHER.id]);
    assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM reviewer_identity_cards WHERE owner_reviewer_id = $1', [OTHER.id])).rows[0].n, 0);
  });
  await test('잘못된 afterId 는 쓰기 없이 거절한다', async () => {
    const out = await svc.applyCards({ db, confirm: true, afterId: 'x' });
    assert.strictEqual(out.code, 'bad_after_id');
  });

  await db.end();
  { const boot = new Pool({ connectionString: process.env.PGTEST_URL }); await boot.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await boot.end(); }
  console.log(`\n✅ reviewerIdentityCards: ${passed}개 통과 (진짜 PG 포함)`);
  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
