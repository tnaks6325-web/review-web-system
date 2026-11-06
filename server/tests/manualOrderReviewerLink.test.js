'use strict';
/* manualOrderReviewerLink.test.js — 결정 348 회귀가드
   외부모집 수동제출 줄마다 리뷰어 연결을 「자동 / 기존 리뷰어 고르기 / 새로 등록」 중에서 고른다.
   - auto(또는 값 없음 = 옛 화면) = 종전 그대로
   - existing = 서버가 그 id 리뷰어를 다시 읽는다. 수취인 전화 = 그 리뷰어 번호 → 본인 건(빈 칸만 채움 · 계좌는 덮지 않고 다르면 경고)
                다르면 타계정(이름 검색 대신 고른 리뷰어 · 사칭 차단·sub_accounts 규율 그대로) · 없는/비활성 id 는 쓰기 0 거절
   - new = registerReviewer 그대로 · 그 번호가 이미 등록돼 있으면 쓰기 0 거절 + 「기존 고르기로 바꿔 주세요」
   - 리뷰어 등록·연결은 원장 기록보다 앞(종전 순서) · 결과에 reviewerLinkApplied(배포 스큐 감지용)
   - 검색(reviewer-search): 2글자 미만은 DB 를 보지 않음 · 최대 20 · 전화·계좌 뒤 4자리만 · 주소·phone8 미반환 · 비활성 제외
   reviewers 표는 PGlite 실물(SQL 문법·조건까지 실제로 돈다), 원장·큐·작업표는 대역(호출 순서만 기록). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

delete process.env.SAME_PHONE_REGISTER_MODE;
delete process.env.CAMPAIGN_SUB_REGISTERED_POLICY;

const SRC = path.resolve(__dirname, '..', 'src');
function inject(rel, exportsObj) {
  const p = require.resolve(path.join(SRC, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
function fresh() { for (const k of Object.keys(require.cache)) if (k.startsWith(SRC + path.sep)) delete require.cache[k]; }

const A_ID = '00000000-0000-4000-8000-00000000000a';   // 김수만 — 계좌 있음 · 주소 빈 칸
const B_ID = '00000000-0000-4000-8000-00000000000b';   // 박본계 — 타계정 소유자
const C_ID = '00000000-0000-4000-8000-00000000000c';   // 최등록 — 이미 가입된 다른 사람
const X_ID = '00000000-0000-4000-8000-00000000000d';   // 정휴면 — 비활성
const NONE = '00000000-0000-4000-8000-0000000000ff';

let PG = null;
async function db() {
  if (PG) return PG;
  PG = new PGlite();
  await PG.exec(`CREATE TABLE reviewers(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, phone text NOT NULL UNIQUE,
    phone8 text GENERATED ALWAYS AS (RIGHT(REGEXP_REPLACE(phone,'[^0-9]','','g'), 8)) STORED,
    consent boolean DEFAULT true, status text DEFAULT 'active', sub_accounts jsonb DEFAULT '[]',
    address text, bank_name text, bank_account text, account_holder text, kakao_id text NOT NULL DEFAULT '',
    registered_at timestamptz DEFAULT NOW())`);
  return PG;
}
async function seed() {
  const pg = await db();
  await pg.exec('DELETE FROM reviewers');
  await pg.query(`INSERT INTO reviewers(id,name,phone,address,bank_name,bank_account,account_holder,registered_at)
    VALUES ($1,'김수만','01012346325','','신한은행','110-111-1234','김수만',NOW() - interval '3 day'),
           ($2,'박본계','01055556666','부산 1','국민은행','220-222-2222','박본계',NOW() - interval '2 day'),
           ($3,'최등록','01077778888','대구 1','우리은행','330-333-3333','최등록',NOW() - interval '1 day')`, [A_ID, B_ID, C_ID]);
  await pg.query(`INSERT INTO reviewers(id,name,phone,status) VALUES ($1,'정휴면','01099990000','inactive')`, [X_ID]);
}

/** 서비스 로드 — reviewers 쿼리는 PGlite 로, 나머지 표는 빈 결과. 모든 SQL·원장 호출 순서를 events 에 남긴다. */
async function load() {
  fresh();
  const pg = await db();
  const events = [];
  const q = async (sql, params) => {
    const s = String(sql);
    events.push({ sql: s });
    if (/\breviewers\b/.test(s)) return pg.query(s, params);
    return { rows: [], rowCount: 0 };
  };
  const pool = { query: q, connect: async () => ({ query: q, release() {} }) };
  inject('db/pool.js', pool);
  inject('services/orderLedger.service.js', {
    createOrderLedgerEntry: async () => { events.push({ ledger: true }); return { orderSubmissionId: 'os-1', sheetRow: 5, tabGid: 'g' }; },
    markOrderQueued: async () => {}, markOrderMirrorFailed: async () => {},
    optionColIndexes: () => [], existingOptionKeyAt: () => '',
  });
  inject('services/syncQueue.service.js', { enqueue: async () => { events.push({ enqueue: true }); } });
  inject('services/workboardQueueApply.service.js', { resolveQueuedWorkboardTarget: async () => ({ enabled: false }) });
  inject('utils/sheetlessScope.js', { isSheetless: async () => true });
  inject('services/sheetlessOrder.service.js', { writeOrderToWorktable: async () => { events.push({ worktable: true }); return { ok: true, seq: 3 }; } });
  inject('services/purchaseSubmissionSession.service.js', { issueForOrder: async () => ({ issued: true }) });
  inject('services/dualChannelLifecycle.service.js', { discoverDualScope: async () => ({ campaignIds: [] }) });
  inject('services/directPurchaseRules.service.js', { judgeLater() {} });
  // 타계정 명부 쓰기 — 실제 모듈은 카드 표까지 만지므로, 같은 계약(잠금→다시 읽기→콜백→저장)만 PGlite 에 흉내 낸다.
  inject('services/reviewerIdentityCards.service.js', {
    mutateSubAccounts: async (id, mutate) => {
      const { rows } = await q('SELECT id, name, sub_accounts FROM reviewers WHERE id = $1', [id]);
      const cur = Array.isArray(rows[0].sub_accounts) ? rows[0].sub_accounts.slice() : [];
      const next = await mutate(cur, rows[0]);
      if (!Array.isArray(next)) return { changed: false };
      await q('UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1', [id, JSON.stringify(next)]);
      return { changed: true };
    },
    syncOwnerCardsSoon() {},
  });
  const svc = require(path.join(SRC, 'services/manualOrder.service.js'));
  const writes = () => events.filter(e => e.sql && /\b(INSERT|UPDATE|DELETE)\b/i.test(e.sql));
  const ledgerAt = () => events.findIndex(e => e.ledger);
  return { svc, events, writes, ledgerAt, pg };
}
const row = async (id) => (await (await db()).query('SELECT * FROM reviewers WHERE id = $1', [id])).rows[0];
const count = async () => Number((await (await db()).query('SELECT COUNT(*)::int AS n FROM reviewers')).rows[0].n);
const F = (o) => Object.assign({ reviewerName: '김수만', recipient: '김수만', userId: 'id1', phone: '010-1234-6325',
  address: '서울 마포구 1', bank: '신한은행', account: '110-111-1234', depositor: '김수만', price: 19000, isSubAccount: false }, o || {});
const submit = (h, fields, reviewerLink) => h.svc.submitExternalOrder({ sheetId: 's', tabName: 't', gid: 'g', campaignId: null,
  fields, adminName: '관리자', allowRepurchase: true, reviewerLink });

test.after(async () => { if (PG) await PG.close(); });

test('auto(값 없음 = 옛 화면) — 종전 그대로: 새 번호는 등록 · 결과에 reviewerLinkApplied=auto', async () => {
  await seed(); const h = await load();
  const n0 = await count();
  const r = await submit(h, F({ reviewerName: '한새사람', recipient: '한새사람', phone: '010-4444-1212', depositor: '한새사람' }));
  assert.equal(r.ok, true); assert.equal(r.reviewerLinkApplied, 'auto');
  assert.equal(await count(), n0 + 1, '새 리뷰어 1명 등록');
  const r2 = await submit(h, F({ reviewerName: '한새둘', recipient: '한새둘', phone: '010-4444-3434', depositor: '한새둘' }), { mode: 'auto' });
  assert.equal(r2.ok, true); assert.equal(r2.reviewerLinkApplied, 'auto');
  assert.equal(await count(), n0 + 2);
  const r3 = await submit(h, F({ reviewerName: '한셋', recipient: '한셋', phone: '010-4444-5656' }), { mode: '이상한값' });
  assert.equal(r3.ok, true); assert.equal(r3.reviewerLinkApplied, 'auto', '모르는 mode 는 auto 로 접힌다(옛 동작)');
});

test('existing 본인 — 빈 칸(주소)만 채우고 계좌는 덮지 않으며 다르면 경고 · 새 리뷰어 0 · 원장보다 앞', async () => {
  await seed(); const h = await load();
  const n0 = await count();
  const r = await submit(h, F({ account: '999-888-7777', address: '서울 마포구 새주소 5' }), { mode: 'existing', reviewerId: A_ID });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reviewerLinkApplied, 'existing');
  assert.equal(r.linkedReviewer, '김수만');
  assert.equal(r.linkedOwner, null, '본인 건은 타계정 연결이 아니다');
  const a = await row(A_ID);
  assert.equal(a.bank_account, '110-111-1234', '★ 계좌는 절대 덮지 않는다');
  assert.equal(a.address, '서울 마포구 새주소 5', '빈 주소는 채운다');
  assert.ok(r.warnings.some(w => /계좌/.test(w) && /…1234/.test(w) && /…7777/.test(w)), '계좌가 다르면 경고: ' + r.warnings.join(' | '));
  assert.equal(await count(), n0, '새 리뷰어를 만들지 않는다');
  const fill = h.events.findIndex(e => e.sql && /UPDATE reviewers SET/.test(e.sql));
  assert.ok(fill >= 0 && fill < h.ledgerAt(), '리뷰어 연결(빈 칸 채우기)은 원장 기록보다 앞');
  assert.ok(!h.events.some(e => e.sql && /REPLACE\(LOWER\(name\)/.test(e.sql)), '이름 검색을 하지 않는다');
});

test('existing 타계정 — 이름 검색 대신 고른 리뷰어의 sub_accounts 에 수취인 등록', async () => {
  await seed(); const h = await load();
  // 붙여넣은 리뷰어 이름이 실제 이름과 달라도(카톡 별명) 고른 리뷰어를 쓴다
  const r = await submit(h, F({ reviewerName: '박별명', recipient: '박가족', phone: '010-3030-4040', depositor: '박가족', isSubAccount: true }),
    { mode: 'existing', reviewerId: B_ID });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reviewerLinkApplied, 'existing'); assert.equal(r.linkedOwner, '박본계');
  const b = await row(B_ID);
  assert.equal(b.sub_accounts.length, 1); assert.equal(b.sub_accounts[0].name, '박가족');
  assert.equal(b.bank_account, '220-222-2222', '소유자 계좌는 그대로');
  assert.ok(!h.events.some(e => e.sql && /REPLACE\(LOWER\(name\)/.test(e.sql)), '이름 검색을 하지 않는다');
  const sub = h.events.findIndex(e => e.sql && /SET sub_accounts/.test(e.sql));
  assert.ok(sub >= 0 && sub < h.ledgerAt(), '타계정 연결은 원장 기록보다 앞');
});

test('existing 타계정 — 이미 등록된 남의 번호는 연결하지 않는다(사칭 차단 그대로)', async () => {
  await seed(); const h = await load();
  const r = await submit(h, F({ reviewerName: '박본계', recipient: '최등록', phone: '010-7777-8888', depositor: '최등록', isSubAccount: true }),
    { mode: 'existing', reviewerId: B_ID });
  assert.equal(r.ok, true);
  assert.equal(r.linkedOwner, null);
  assert.ok(r.warnings.some(w => /이미 등록된 리뷰어/.test(w)), r.warnings.join(' | '));
  assert.deepEqual((await row(B_ID)).sub_accounts, [], 'sub_accounts 무변경');
});

test('existing 타계정 — 이미 있는 타계정 칸의 계좌가 다르면 덮지 않고 경고', async () => {
  await seed();
  await (await db()).query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`,
    [B_ID, JSON.stringify([{ name: '박가족', phone: '01030304040', bankName: '농협', bankAccount: '111-2222-3333', accountHolder: '박가족' }])]);
  const h = await load();
  const r = await submit(h, F({ reviewerName: '박본계', recipient: '박가족', phone: '010-3030-4040', account: '555-6666-7777', depositor: '박가족', isSubAccount: true }),
    { mode: 'existing', reviewerId: B_ID });
  assert.equal(r.ok, true);
  const b = await row(B_ID);
  assert.equal(b.sub_accounts.length, 1); assert.equal(b.sub_accounts[0].bankAccount, '111-2222-3333', '타계정 계좌도 덮지 않는다');
  assert.ok(r.warnings.some(w => /계좌/.test(w) && /…3333/.test(w)), r.warnings.join(' | '));
});

test('existing — 없는 id · 비활성 · 모양이 틀린 id 는 쓰기 0 거절', async () => {
  for (const id of [NONE, X_ID, 'abc', '', null]) {
    await seed(); const h = await load();
    const n0 = await count();
    const r = await submit(h, F(), { mode: 'existing', reviewerId: id });
    assert.equal(r.ok, false, String(id)); assert.equal(r.reason, 'reviewer_link_invalid', String(id));
    assert.ok(/리뷰어/.test(r.error));
    assert.equal(h.ledgerAt(), -1, '원장 0'); assert.deepEqual(h.writes(), [], '쓰기 0');
    assert.equal(await count(), n0);
  }
});

test('new — 등록 안 된 번호는 registerReviewer 로 새로 등록', async () => {
  await seed(); const h = await load();
  const n0 = await count();
  const r = await submit(h, F({ reviewerName: '윤신규', recipient: '윤신규', phone: '010-2468-1357', depositor: '윤신규' }), { mode: 'new' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.reviewerLinkApplied, 'new');
  assert.equal(await count(), n0 + 1);
  const ins = h.events.findIndex(e => e.sql && /INSERT INTO reviewers/.test(e.sql));
  assert.ok(ins >= 0 && ins < h.ledgerAt(), '등록은 원장 기록보다 앞');
});

test('new — 이미 등록된 번호면 그 줄을 쓰기 0 으로 거절하고 「기존 고르기」 안내(이름 + 뒤 4자리)', async () => {
  await seed(); const h = await load();
  const n0 = await count();
  const r = await submit(h, F({ reviewerName: '김수만', recipient: '김수만', phone: '010-1234-6325' }), { mode: 'new' });
  assert.equal(r.ok, false); assert.equal(r.reason, 'reviewer_already_registered');
  assert.match(r.error, /이미 등록된 리뷰어 김수만\(…6325\)/);
  assert.match(r.error, /기존 고르기로 바꿔 주세요/);
  assert.equal(h.ledgerAt(), -1, '원장 0'); assert.deepEqual(h.writes(), [], '쓰기 0');
  assert.equal(await count(), n0);
});

test('검색 — 2글자 미만은 DB 를 보지 않는다 · 최대 20 · 뒤 4자리만 · 주소·phone8 미반환 · 비활성 제외 · LIKE 특수문자 무력화', async () => {
  await seed(); const h = await load();
  const pg = await db();
  for (let k = 0; k < 25; k++) await pg.query(`INSERT INTO reviewers(name,phone,address,bank_account) VALUES ($1,$2,'비밀주소',$3)`,
    ['김검색' + k, '0108800' + String(1000 + k), '777-000-' + String(1000 + k)]);
  const before = h.events.length;
  for (const q of ['', ' ', '김', ' 김 ', '1']) {
    const r = await h.svc.searchReviewersForLink(q);
    assert.equal(r.ok, true); assert.deepEqual(r.items, []); assert.equal(r.tooShort, true, JSON.stringify(q));
  }
  assert.equal(h.events.length, before, '짧은 검색어는 DB 를 보지 않는다');

  const many = await h.svc.searchReviewersForLink('김검색');
  assert.equal(many.items.length, 20, '최대 20'); assert.equal(many.hasMore, true);
  for (const it of many.items) {
    assert.deepEqual(Object.keys(it).sort(), ['accountTail', 'id', 'name', 'phoneTail'], '돌려주는 칸은 넷뿐: ' + Object.keys(it));
    assert.match(it.phoneTail, /^\d{4}$/); assert.match(it.accountTail, /^(\d{4})?$/);
  }
  assert.ok(!JSON.stringify(many).includes('비밀주소'), '주소 미반환');
  assert.ok(!JSON.stringify(many).includes('0108800'), '전화 앞자리 미반환');

  const one = await h.svc.searchReviewersForLink('김수만');
  assert.equal(one.items.length, 1); assert.equal(one.items[0].id, A_ID);
  assert.equal(one.items[0].phoneTail, '6325'); assert.equal(one.items[0].accountTail, '1234');

  assert.equal((await h.svc.searchReviewersForLink('정휴면')).items.length, 0, '비활성 제외');
  assert.equal((await h.svc.searchReviewersForLink('6325')).items[0].id, A_ID, '전화 뒤자리로 찾기');
  assert.equal((await h.svc.searchReviewersForLink('%%')).items.length, 0, '% 로 전체를 훑지 못한다');
  assert.equal((await h.svc.searchReviewersForLink('__')).items.length, 0, '_ 로 전체를 훑지 못한다');
});
