'use strict';
/*
 * 명의 카드 거울 — 2단계 조각 2-1 (결정 기록 176)
 *   A. 계획(순수 함수): 레드팀 2026-09-24 지적 사례 — 번호 변경 순서 · 본인/타계정 맞바꿈 · 되살림(번호 유지) ·
 *      합친 카드 미재생성 · 본인 카드 절대 제거 금지 · 값 변경 덮어쓰기 · 사라진 명의 제거
 *   B. 배선: 저장 경로 19곳 무접촉 · 10분 크론 · 라우트 게이트 · 잠금 방식
 *   C. PGTEST_URL 있으면 진짜 PG: 위 사례를 실제 유일 인덱스 위에서 실행(23505 0) · 멱등 ·
 *      리뷰어 행을 잠근 동안에도 그 리뷰어를 참조하는 자식 행 INSERT 가 막히지 않음
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const svc = require('../src/services/reviewerIdentityCards.service');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
function reviewer(over = {}) {
  return { id: OWNER_ID, name: '김수만', phone: '010-1111-1111', address: '서울 1', bank_name: '', bank_account: '',
    account_holder: '', shopping_id: '', income_type: '', sub_accounts: [], ...over };
}
function card(id, kind, name, phone8, status = 'active', extra = {}) {
  return { id, kind, status, name, name_key: name.replace(/\s+/g, ''), phone: '010-' + phone8.slice(0, 4) + '-' + phone8.slice(4), phone8,
    address: '', bank_name: '', bank_account: '', account_holder: '', shopping_id: '', income_name: '', updated_at: '2026-09-01', ...extra };
}
const opsOf = (ops) => ops.map((o) => `${o.op}:${o.id || (o.card && o.card.name + '/' + o.card.phone8)}`);

(async () => {
  console.log('A. 계획(순수 함수)');
  await test('변화가 없으면 아무것도 하지 않는다', async () => {
    const r = reviewer({ sub_accounts: [{ name: '이영희', phone: '010-2222-2222' }] });
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' }), card('a', 'sub', '이영희', '22222222')];
    assert.deepStrictEqual(svc.planOwnerSync(r, ex), []);
  });
  await test('값이 바뀌면 덮는다(JSON 이 진실)', async () => {
    const r = reviewer({ sub_accounts: [{ name: '이영희', phone: '010-2222-2222', address: '새 주소' }] });
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' }), card('a', 'sub', '이영희', '22222222', 'active', { address: '옛 주소' })];
    const ops = svc.planOwnerSync(r, ex);
    assert.deepStrictEqual(ops, [{ op: 'update', id: 'a', set: { address: '새 주소' } }]);
  });
  await test('목록에서 사라진 타계정은 제거한다', async () => {
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' }), card('a', 'sub', '이영희', '22222222')];
    assert.deepStrictEqual(opsOf(svc.planOwnerSync(reviewer(), ex)), ['remove:a']);
  });
  await test('번호 변경: 본인이 새 번호로, 옛 번호는 타계정이 되면 — 본인 갱신이 새 카드보다 먼저', async () => {
    const r = reviewer({ phone: '010-9999-9999', sub_accounts: [{ name: '김수만', phone: '010-1111-1111' }] });
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' })];
    const ops = svc.planOwnerSync(r, ex);
    assert.deepStrictEqual(opsOf(ops), ['update:s', 'insert:김수만/11111111']);
    assert.strictEqual(ops[0].set.phone8, '99999999');
  });
  await test('본인과 같아진 타계정 카드는 본인 카드보다 먼저 제거한다(유일 인덱스 충돌 방지)', async () => {
    // 본인이 이영희(2222)로 바뀌었고, 그 명의가 타계정 카드로 살아 있다
    const r = reviewer({ name: '이영희', phone: '010-2222-2222', sub_accounts: [{ name: '이영희', phone: '010-2222-2222' }] });
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' }), card('a', 'sub', '이영희', '22222222')];
    assert.deepStrictEqual(opsOf(svc.planOwnerSync(r, ex)), ['remove:a', 'update:s']);
  });
  await test('사라졌다 돌아온 명의는 같은 카드를 되살린다(번호 유지 · 가장 최근 것)', async () => {
    const r = reviewer({ sub_accounts: [{ name: '이영희', phone: '010-2222-2222' }] });
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' }),
      card('old', 'sub', '이영희', '22222222', 'removed', { updated_at: '2026-08-01' }),
      card('new', 'sub', '이영희', '22222222', 'removed', { updated_at: '2026-09-10' })];
    const ops = svc.planOwnerSync(r, ex);
    assert.deepStrictEqual(opsOf(ops), ['reactivate:new']);
    assert.strictEqual(ops[0].kind, 'sub');
  });
  await test('DB 가 준 Date 값으로도 가장 최근 카드를 고른다(문자열 비교 금지 — Codex P2)', async () => {
    const r = reviewer({ sub_accounts: [{ name: '이영희', phone: '010-2222-2222' }] });
    // 토요일(이른 시각) vs 월요일(늦은 시각): 문자열로 비교하면 'Sat' > 'Mon' 이라 옛 카드를 고른다
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' }),
      card('old', 'sub', '이영희', '22222222', 'removed', { updated_at: new Date('2026-09-05T00:00:00Z') }),
      card('new', 'sub', '이영희', '22222222', 'removed', { updated_at: new Date('2026-09-07T00:00:00Z') })];
    assert.deepStrictEqual(opsOf(svc.planOwnerSync(r, ex)), ['reactivate:new']);
  });
  await test('예전 본인 카드가 타계정 명의로 돌아오면 타계정으로 되살린다(본인 유일 위반 방지)', async () => {
    const r = reviewer({ name: '김새명', phone: '010-9999-9999', sub_accounts: [{ name: '김수만', phone: '010-1111-1111' }] });
    const ex = [card('s2', 'self', '김새명', '99999999', 'active'), card('s1', 'self', '김수만', '11111111', 'removed')];
    const ops = svc.planOwnerSync(r, ex).filter((o) => o.op === 'reactivate');
    assert.deepStrictEqual(ops.map((o) => [o.id, o.kind]), [['s1', 'sub']]);
  });
  await test('합친(merged) 카드의 명의는 목록에 남아 있어도 다시 만들지 않는다', async () => {
    const r = reviewer({ sub_accounts: [{ name: '김민수', phone: '010-3333-3333' }, { name: '김민수', phone: '010-4444-4444' }] });
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' }),
      card('keep', 'sub', '김민수', '44444444'), card('m', 'sub', '김민수', '33333333', 'merged', { merged_into: 'keep' })];
    assert.deepStrictEqual(svc.planOwnerSync(r, ex), []);
  });
  await test('본인 이름이 비어도 본인 카드는 절대 제거하지 않는다', async () => {
    const r = reviewer({ name: '', sub_accounts: [] });
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' })];
    assert.deepStrictEqual(svc.planOwnerSync(r, ex), []);
  });
  await test('본인 이름이 비었을 때 본인과 같은 명의의 타계정 칸은 새로 만들지 않는다', async () => {
    const r = reviewer({ name: '', sub_accounts: [{ name: '김수만', phone: '010-1111-1111' }] });
    const ex = [card('s', 'self', '김수만', '11111111', 'active', { address: '서울 1' })];
    assert.deepStrictEqual(svc.planOwnerSync(r, ex), []);
  });
  await test('카드가 하나도 없으면 본인부터 만든다', async () => {
    const r = reviewer({ sub_accounts: [{ name: '이영희', phone: '010-2222-2222' }] });
    assert.deepStrictEqual(opsOf(svc.planOwnerSync(r, [])), ['insert:김수만/11111111', 'insert:이영희/22222222']);
  });

  console.log('B. 배선');
  const src = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
  await test('저장 경로 19곳은 이번 조각에서 카드를 부르지 않는다(카드 표 참조는 서비스뿐)', async () => {
    const hits = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('reviewer_identity_cards')) hits.push(path.relative(path.resolve(__dirname, '../src'), p));
      }
    })(path.resolve(__dirname, '../src'));
    assert.deepStrictEqual(hits, ['services/reviewerIdentityCards.service.js']);
  });
  await test('10분 크론은 작업 잠금 아래에서 돌고 끌 수 있다', async () => {
    const cron = src('src/jobs/cron.js');
    assert.match(cron, /process\.env\.IDENTITY_CARDS_RECONCILE !== '0'/);
    assert.match(cron, /withJobLock\('identity_cards_reconcile', \(\) => reconcileCards\(\{ dryRun: false, by: 'cron' \}\)\)/);
  });
  await test('대조는 FOR NO KEY UPDATE + lock_timeout 으로 짧게 잠근다(자식 INSERT 를 막지 않는다)', async () => {
    const s = src('src/services/reviewerIdentityCards.service.js');
    const body = s.slice(s.indexOf('async function reconcileCards'), s.indexOf('/** 적용 — confirm:true'));
    assert.match(body, /FOR NO KEY UPDATE/);
    assert.match(body, /set_config\('lock_timeout'/);
    assert.ok(!/FOR UPDATE`/.test(body.replace(/FOR NO KEY UPDATE/g, '')), '리뷰어 행을 FOR UPDATE 로 잠그지 않는다');
  });
  await test('대조 라우트는 관리자 전용이고 실행은 confirm 이 필요하다', async () => {
    const r = src('src/routes/trackB.routes.js');
    assert.match(r, /router\.get\('\/identity-cards\/drift', authMiddleware, adminOrMasterMiddleware/);
    assert.match(r, /router\.post\('\/identity-cards\/reconcile', authMiddleware, adminOrMasterMiddleware/);
    assert.match(r, /\(req\.body \|\| \{\}\)\.confirm !== true/);
  });

  if (!process.env.PGTEST_URL) {
    console.log(`\n✅ reviewerIdentityCardsMirror: ${passed}개 통과 (PGTEST_URL 없음 — 진짜 PG 단계 생략)`);
    process.exit(0);
  }

  console.log('C. 진짜 PG');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.PGTEST_URL });
  await db.query('DROP TABLE IF EXISTS child_orders; DROP TABLE IF EXISTS reviewer_identity_cards; DROP TABLE IF EXISTS reviewers');
  await db.query(`CREATE TABLE reviewers (id UUID PRIMARY KEY, name TEXT, phone TEXT, address TEXT, bank_name TEXT,
    bank_account TEXT, account_holder TEXT, shopping_id TEXT, income_type TEXT, sub_accounts JSONB DEFAULT '[]',
    registered_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(fs.readFileSync(path.resolve(__dirname, '../migrations/166_reviewer_identity_cards.sql'), 'utf8'));
  await db.query(`CREATE TABLE child_orders (id SERIAL PRIMARY KEY, owner_reviewer_id UUID REFERENCES reviewers(id))`);
  const setRow = (r) => db.query(`INSERT INTO reviewers (id,name,phone,address,sub_accounts) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, address=EXCLUDED.address, sub_accounts=EXCLUDED.sub_accounts`,
    [r.id, r.name, r.phone, r.address, JSON.stringify(r.sub_accounts)]);
  const cards = async () => (await db.query(`SELECT id, kind, status, name, phone8, address FROM reviewer_identity_cards ORDER BY created_at, name`)).rows;
  const run = async () => { const r = await svc.reconcileCards({ db, dryRun: false, by: 'test' }); assert.deepStrictEqual(r.failed, []); return r; };

  await test('처음 대조는 카드를 만들고, 다시 돌리면 달라진 리뷰어가 0명이다', async () => {
    await setRow(reviewer({ sub_accounts: [{ name: '이영희', phone: '010-2222-2222', address: '부산' }] }));
    const r = await run();
    assert.strictEqual(r.inserted, 2);
    assert.strictEqual((await svc.reconcileCards({ db, dryRun: true })).drifted, 0);
  });
  let selfId;
  await test('번호 변경(본인 새 번호 + 옛 번호 타계정)이 유일 인덱스 충돌 없이 반영되고 본인 카드 번호는 그대로다', async () => {
    selfId = (await cards()).find((c) => c.kind === 'self').id;
    await setRow(reviewer({ phone: '010-9999-9999', sub_accounts: [{ name: '이영희', phone: '010-2222-2222', address: '부산' }, { name: '김수만', phone: '010-1111-1111' }] }));
    await run();
    const c = await cards();
    assert.strictEqual(c.find((x) => x.kind === 'self' && x.status === 'active').id, selfId);
    assert.strictEqual(c.find((x) => x.kind === 'self').phone8, '99999999');
    assert.ok(c.some((x) => x.kind === 'sub' && x.phone8 === '11111111' && x.status === 'active'));
  });
  let leeId;
  await test('타계정을 지웠다 다시 넣으면 같은 카드가 되살아난다', async () => {
    leeId = (await cards()).find((x) => x.name === '이영희').id;
    await setRow(reviewer({ phone: '010-9999-9999', sub_accounts: [{ name: '김수만', phone: '010-1111-1111' }] }));
    await run();
    assert.strictEqual((await cards()).find((x) => x.id === leeId).status, 'removed');
    await setRow(reviewer({ phone: '010-9999-9999', sub_accounts: [{ name: '김수만', phone: '010-1111-1111' }, { name: '이영희', phone: '010-2222-2222', address: '대구' }] }));
    await run();
    const lee = (await cards()).find((x) => x.id === leeId);
    assert.deepStrictEqual([lee.status, lee.address], ['active', '대구']);
  });
  await test('본인이 타계정 명의로 바뀌어도(본인·타계정 맞바꿈) 충돌 없이 반영된다', async () => {
    await setRow(reviewer({ name: '이영희', phone: '010-2222-2222', sub_accounts: [{ name: '김수만', phone: '010-9999-9999' }, { name: '이영희', phone: '010-2222-2222' }] }));
    await run();
    const active = (await cards()).filter((x) => x.status === 'active');
    assert.strictEqual(active.filter((x) => x.kind === 'self').length, 1);
    assert.strictEqual(active.find((x) => x.kind === 'self').phone8, '22222222');
    assert.strictEqual(new Set(active.map((x) => x.name + x.phone8)).size, active.length, '살아 있는 카드끼리 겹침 없음');
    assert.strictEqual((await svc.reconcileCards({ db, dryRun: true })).drifted, 0);
  });
  await test('합친 카드는 대조를 거듭해도 되살아나지 않는다', async () => {
    const sub = (await cards()).find((x) => x.kind === 'sub' && x.status === 'active');
    const keep = (await cards()).find((x) => x.kind === 'self');
    await db.query(`UPDATE reviewer_identity_cards SET status='merged', merged_into=$2 WHERE id=$1`, [sub.id, keep.id]);
    await run(); await run();
    assert.strictEqual((await cards()).find((x) => x.id === sub.id).status, 'merged');
    assert.strictEqual((await cards()).filter((x) => x.status === 'active' && x.name === sub.name && x.phone8 === sub.phone8).length, 0);
  });
  await test('대조가 리뷰어 행을 잠근 동안에도 그 리뷰어의 주문 기록 INSERT 는 막히지 않는다', async () => {
    const a = await db.connect(); const b = await db.connect();
    try {
      await a.query('BEGIN');
      await a.query('SELECT id FROM reviewers WHERE id = $1 FOR NO KEY UPDATE', [OWNER_ID]);
      await b.query(`SET lock_timeout = '1500ms'`);
      await b.query('INSERT INTO child_orders (owner_reviewer_id) VALUES ($1)', [OWNER_ID]);
      await a.query('ROLLBACK');
    } finally { a.release(); b.release(); }
  });
  await test('다른 곳이 리뷰어 행을 오래 잡고 있으면 기다리지 않고 다음으로 미룬다', async () => {
    await setRow(reviewer({ name: '이영희', phone: '010-2222-2222', address: '바뀜', sub_accounts: [] }));
    const hold = await db.connect();
    try {
      await hold.query('BEGIN');
      await hold.query('SELECT id FROM reviewers WHERE id = $1 FOR UPDATE', [OWNER_ID]);
      const r = await svc.reconcileCards({ db, dryRun: false, lockTimeoutMs: 300 });
      assert.strictEqual(r.busy, 1);
      assert.deepStrictEqual(r.failed, []);
      await hold.query('ROLLBACK');
    } finally { hold.release(); }
    await run();
    assert.strictEqual((await svc.reconcileCards({ db, dryRun: true })).drifted, 0);
  });

  await db.query('DROP TABLE IF EXISTS child_orders; DROP TABLE IF EXISTS reviewer_identity_cards; DROP TABLE IF EXISTS reviewers');
  await db.end();
  console.log(`\n✅ reviewerIdentityCardsMirror: ${passed}개 통과 (진짜 PG 포함)`);
  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
