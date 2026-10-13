'use strict';
/*
 * 같은 번호 타계정 정리 — 결정 226 3·4단계 (migration 185 · 사용자 확정 2026-10-13 1가·2가·3나)
 *   A. 판정·배선(DB 없음): 대상/예외/대기 판정 · 옛 이름표 식 대조 · 스위치 해석 · 안내 라우트 리뷰어 세션 ·
 *      화면 [다시 보지 않기] · 옛 화면 되살리기 막기 · 작업 잠금 이름 충돌 없음
 *   B. PGTEST_URL(전체 마이그레이션 DB) 있으면 진짜 PG:
 *      미리보기(쓰기 0) → 실행(칸 지움·카드 merged·주문/참여 본인으로·뒤 칸 이름표 당김) → 다시 실행해도 같음 →
 *      거울이 되살리지 않음 → 그 이름 로그인은 본계정 이름 안내 → 옛 화면 저장이 되살리지 못함 →
 *      안내 팝업·다시 보지 않기 → 하나 되돌리기 → 실행 전체 되돌리기 → 대기(진행 중 참여)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

(async () => {
  const fold = require('../src/services/reviewerIdentityFold.service');
  console.log('A. 판정·배선');
  const owner = { id: 'o', name: '김본인', phone: '010-1111-2222', resident_num: '9001011234567',
    bank_name: '국민은행', bank_account: '123-45', account_holder: '김본인', shopping_id: 'kim1', reviewer_no: null, sub_accounts: [] };
  const one = (sub, ctx = {}, o = {}) => fold.classifyOwner({ ...owner, ...o, sub_accounts: [sub] }, ctx)[0];

  await test('이름만 다른 같은 번호 칸(계좌 같음·비어 있음) = 바로 정리', async () => {
    assert.deepStrictEqual(one({ name: '이가족', phone: '01011112222', bankName: '국민', bankAccount: '12345', accountHolder: '김본인' }).status, 'ready');
    assert.strictEqual(one({ name: '이가족', phone: '010-1111-2222' }).type, 'name_diff');
    assert.strictEqual(one({ name: '김 본인', phone: '010-1111-2222' }).type, 'duplicate');
    assert.strictEqual(one({ name: '김본인', phone: '010-1111-2222' }).status, 'ready');
  });
  await test('번호가 다른 칸은 대상이 아니다', async () => {
    assert.strictEqual(one({ name: '이가족', phone: '010-3333-2222' }), undefined);
  });
  await test('예외 — 계좌(은행·계좌·예금주)·주민번호·쇼핑 아이디가 다름 · 같은 이름 리뷰어 · 코드 명의 · 같은 칸 둘', async () => {
    const r = (s, c, o) => one(s, c, o).reasons;
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', bankAccount: '999' }), ['account_diff']);
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', bankName: '국민', bankAccount: '12345', accountHolder: '이가족' }), ['account_diff']);
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', jumin: '850101-2000000' }), ['jumin_diff']);
    assert.strictEqual(one({ name: '이가족', phone: '01011112222', jumin: '900101-1234567' }).status, 'ready');
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', shoppingId: 'other' }), ['shopping_diff']);
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222' }, { otherNames: new Set(['이가족']) }), ['other_reviewer_same_name']);
    assert.deepStrictEqual(r({ name: '김본인', phone: '01011112222' }, { otherNames: new Set(['김본인']) }), [], '완전 중복은 동명 리뷰어와 무관');
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222' }, { coded: true }), ['coded_identity']);
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222' }, {}, { reviewer_no: 7 }), ['coded_identity']);
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', bank_account: '999' }), ['account_diff'], '옛 snake_case 칸');
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', bankName: '신한은행' }), ['account_diff'], '계좌번호 없이 은행만 다름');
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', accountHolder: '이가족' }), ['account_diff'], '예금주만 다름');
    assert.strictEqual(one({ name: '이가족', phone: '01011112222', bankName: '국민', accountHolder: '김본인' }).status, 'ready');
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', residentNo: '850101-2000000' }), ['jumin_diff'], '옛 키 주민번호');
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222', shopping_id: 'other' }), ['shopping_diff'], '옛 snake_case 칸');
    assert.deepStrictEqual(r({ name: '이가족', phone: '01011112222' }, { mergeKeptSigs: new Set(['이가족|11112222']) }), ['merge_target']);
    const two = fold.classifyOwner({ ...owner, sub_accounts: [{ name: '이가족', phone: '01011112222' }, { name: '이가족', phone: '010-1111-2222' }] }, {});
    assert.ok(two.every((x) => x.status === 'exception' && x.reasons.includes('duplicate_slot')));
  });
  await test('대기 — 진행 중 참여 · 타계정 계좌로 만든 입금 대기', async () => {
    assert.deepStrictEqual(one({ name: '이가족', phone: '01011112222' }, { inProgress: true }).status, 'wait');
    assert.deepStrictEqual(one({ name: '이가족', phone: '01011112222' }, { paymentPending: true }).reasons, ['payment_pending']);
    assert.strictEqual(one({ name: '이가족', phone: '01011112222', bankAccount: '9' }, { inProgress: true }).status, 'exception');
  });
  await test('옛 이름표 식이 구매양식 명의 확인(legacyIdentityKey)과 같다', async () => {
    const roi = require('../src/services/reviewerOrderIdentity.service');
    for (const [n, p, i] of [['이 가족', '010-1111-2222', 0], ['박다른', '01033334444', 3], ['짧은번호', '1234', 2], ['빈번호', '', 1]]) {
      assert.strictEqual(fold._test.legacyKey(n, p, i), roi._test.legacyIdentityKey(n, p, i));
    }
    assert.strictEqual(fold._test.SELF_HASH, roi._test.stableHash('self'));
    // 되돌릴 때 옛 순번 이름표 다시 계산 — 옛 순번이 지금 목록보다 길어도(그 사이 칸이 지워짐) 찾는다
    const list = [{ name: '가', phone: '010-1000-0001' }, { name: '나', phone: '010-1000-0002' }];
    const H = roi._test.stableHash;
    assert.strictEqual(fold._test.remapLegacyHash(list, H(roi._test.legacyIdentityKey('나', '010-1000-0002', 5))), H(roi._test.legacyIdentityKey('나', '010-1000-0002', 1)));
    assert.strictEqual(fold._test.remapLegacyHash(list, H(roi._test.legacyIdentityKey('다', '010-1000-0003', 0))), null);
  });
  await test('스위치 — 모르는 값은 아무것도 하지 않는다', async () => {
    assert.deepStrictEqual(fold.parseMode(''), { mode: 'off' });
    assert.deepStrictEqual(fold.parseMode('off'), { mode: 'off' });
    assert.deepStrictEqual(fold.parseMode('preview'), { mode: 'preview' });
    assert.deepStrictEqual(fold.parseMode('apply:12'), { mode: 'apply', runId: '12' });
    assert.deepStrictEqual(fold.parseMode('undo_all:3'), { mode: 'undo_all', runId: '3' });
    for (const v of ['apply', 'apply:', 'apply:x', 'APPLY:1', 'delete']) assert.strictEqual(fold.parseMode(v).mode, 'invalid', v);
    const r = await fold.runFromSwitch({ env: { SAME_PHONE_FOLD_MODE: 'apply' } });
    assert.strictEqual(r.skipped, 'invalid');
    assert.strictEqual((await fold.runFromSwitch({ env: {} })).skipped, 'off');
  });
  await test('안내 라우트는 리뷰어 세션으로 본계정만 · 실패는 안내 없음', async () => {
    const r = read('src/routes/reviewer.routes.js');
    assert.ok(/router\.get\('\/identity-fold-notice', reviewerSessionMiddleware,/.test(r));
    assert.ok(/router\.post\('\/identity-fold-notice\/dismiss', reviewerSessionMiddleware,/.test(r));
    assert.ok(/pendingNotice\(req\.reviewer\.ownerReviewerId\)/.test(r) && /dismissNotice\(req\.reviewer\.ownerReviewerId\)/.test(r));
    // 다른 번호의 타계정 로그인(가족 등)에는 보여 주지도, 대신 끄게 하지도 않는다(레드팀 9)
    assert.strictEqual((r.match(/if \(req\.reviewer\.loginKind !== 'self'\) return res\.json/g) || []).length, 2);
  });
  await test('화면 — [다시 보지 않기]는 서버에 남기고 [확인]은 이번만 닫는다 · 관리자 홈 열기는 띄우지 않음', async () => {
    const h = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');
    assert.ok(/onclick="closeIdentityFoldNotice\(true\)">다시 보지 않기</.test(h));
    assert.ok(/onclick="closeIdentityFoldNotice\(false\)">확인</.test(h));
    const fn = h.slice(h.indexOf('async function closeIdentityFoldNotice'), h.indexOf('async function closeIdentityFoldNotice') + 1200);
    assert.ok(/if \(!dismiss\) return;/.test(fn) && /identity-fold-notice\/dismiss/.test(fn) && /method:'POST'/.test(fn));
    assert.ok(/if \(!current \|\| current\.adminPreview\) return;/.test(h));
    assert.ok(/const foldLoad = loadIdentityFoldNotice\(user\);/.test(h));
    // 이름은 textContent 로만 넣는다(HTML 주입 금지)
    assert.ok(/getElementById\('ifnSubNames'\)\.textContent =/.test(h) && !/ifnSubNames'\)\.innerHTML/.test(h));
  });
  await test('담당자 판단 내역에 "같은 번호 정리"가 보이고 되돌리기는 같은 창구', async () => {
    const wd = fs.readFileSync(path.resolve(__dirname, '../../frontend/workdesk.html'), 'utf8');
    assert.ok(/fold_self:'같은 번호 정리'/.test(wd));
    const m = read('src/services/reviewerIdentityMerge.service.js');
    assert.ok(/d\.kind === 'fold_self'[\s\S]{0,200}undoFoldInTx\(client, d\)/.test(m));
  });
  await test('옛 내정보 화면의 통째 저장이 정리한 칸을 되살리지 않는다(배선)', async () => {
    const s = read('src/services/reviewer.service.js');
    assert.ok(/kind = 'fold_self' AND owner_reviewer_id = \$1 AND undone_at IS NULL/.test(s));
    assert.ok(/!foldedSigs\.has\(sig\(sub\)\) \|\| currentSubs\.some\(\(old\) => sig\(old\) === sig\(sub\)\)/.test(s));
  });
  await test('작업 잠금 이름이 기존 작업과 겹치지 않는다', async () => {
    const { _lockKeys } = require('../src/utils/jobLock');
    if (typeof _lockKeys !== 'function') return;
    const mine = String(_lockKeys('identity_fold_switch'));
    for (const n of ['order_reconcile', 'queue_pump_drain', 'reverse_sync_auto', 'raw_mirror_all', 'campaign_hold_sweep',
      'review_reminder_alimtalk', 'identity_cards_reconcile']) assert.notStrictEqual(String(_lockKeys(n)), mine, n);
  });
  await test('기동 스위치는 값이 있을 때만 · 실패를 삼킨다', async () => {
    const c = read('src/jobs/cron.js');
    const i = c.indexOf('SAME_PHONE_FOLD_MODE && process.env.SAME_PHONE_FOLD_MODE !== \'off\'');
    assert.ok(i > 0);
    const block = c.slice(i, i + 700);
    assert.ok(/runFromSwitch\(\)/.test(block) && /catch \(err\)/.test(block));
  });

  if (!process.env.PGTEST_URL) {
    console.log(`\n✅ identityFoldSamePhone: ${passed}개 통과 (PGTEST_URL 없음 — 진짜 PG 단계 생략)`);
    process.exit(0);
  }

  console.log('B. 진짜 PG (전체 마이그레이션 DB)');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.PGTEST_URL });
  const has = (await db.query(`SELECT to_regclass('public.reviewer_identity_fold_runs') f`)).rows[0];
  if (!has.f) { await db.end(); console.log(`\n✅ identityFoldSamePhone: ${passed}개 통과 (185 미적용 — B 생략)`); process.exit(0); }
  const cards = require('../src/services/reviewerIdentityCards.service');
  const merge = require('../src/services/reviewerIdentityMerge.service');
  const roi = require('../src/services/reviewerOrderIdentity.service');
  const reviewer = require('../src/services/reviewer.service');
  const A = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
  const B = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';
  const C = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';
  const D = 'f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4';
  const ids = [A, B, C, D];
  const cleanup = async () => {
    await db.query(`DELETE FROM reviewer_delivery_addresses WHERE owner_reviewer_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM reviewer_identity_decisions WHERE owner_reviewer_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM campaign_applications WHERE owner_reviewer_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM order_submissions WHERE owner_reviewer_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM reviewer_account_change_audit WHERE reviewer_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM reviewers WHERE id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM recruit_campaigns WHERE id = 'camp_fold_test'`).catch(() => {});
  };
  await cleanup();
  await db.query(`DELETE FROM reviewer_identity_fold_runs`);
  const subsA = [
    { name: '이가족', phone: '010-7171-2222', bankName: '국민은행', bankAccount: '123-45', accountHolder: '정본인', address: '부모님 댁', jumin: '900101-1234567' },
    { name: '박다른', phone: '010-7373-4444' },
    { name: '정본인', phone: '01071712222', residentNo: '900101-1234567' },
    { name: '최동명', phone: '010-7171-2222' },
  ];
  await db.query(`INSERT INTO reviewers (id, name, phone, bank_name, bank_account, account_holder, resident_num, sub_accounts)
                  VALUES ($1, '정본인', '010-7171-2222', '국민은행', '12345', '정본인', '9001011234567', $2::jsonb)`, [A, JSON.stringify(subsA)]);
  await db.query(`INSERT INTO reviewers (id, name, phone, sub_accounts) VALUES ($1, '최동명', '010-7272-9999', '[]'::jsonb)`, [B]);
  await db.query(`INSERT INTO reviewers (id, name, phone, sub_accounts) VALUES ($1, '한진행', '010-7474-5555', $2::jsonb)`,
    [C, JSON.stringify([{ name: '한가족', phone: '010-7474-5555' }])]);
  await db.query(`INSERT INTO reviewers (id, name, phone, sub_accounts) VALUES ($1, '오바뀜', '010-7575-6666', $2::jsonb)`,
    [D, JSON.stringify([{ name: '오가족', phone: '010-7575-6666' }])]);
  await cards.reconcileCards({ db, dryRun: false, by: 'test' });
  const cardOf = async (owner, name) => (await db.query(
    `SELECT id, status, merged_into FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 AND name_key = $2 ORDER BY created_at DESC LIMIT 1`, [owner, name])).rows[0];
  const selfCard = (await db.query(`SELECT id FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 AND kind = 'self' AND status = 'active'`, [A])).rows[0];
  const famCard = await cardOf(A, '이가족');
  const H = (k) => roi._test.stableHash(k);
  const ins = async (hash, card) => (await db.query(
    `INSERT INTO order_submissions (sheet_id, tab_name, owner_reviewer_id, phone, recipient, participant_identity_key_hash, participant_card_id)
     VALUES ('t','t',$1,'010-7171-2222','이가족',$2,$3) RETURNING id`, [A, hash, card])).rows[0].id;
  const oCard = await ins(H(`card:${famCard.id}`), famCard.id);
  const oLegacyFam = await ins(H(roi._test.legacyIdentityKey('이가족', '010-7171-2222', 0)), null);
  const oLegacyPark = await ins(H(roi._test.legacyIdentityKey('박다른', '010-7373-4444', 1)), null);
  const oOther = await ins(H('self'), selfCard.id);
  await db.query(`INSERT INTO recruit_campaigns (id, title) VALUES ('camp_fold_test', 't')`).catch(async () => {
    await db.query(`INSERT INTO recruit_campaigns (id) VALUES ('camp_fold_test')`);
  });
  const app = (await db.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, status, owner_reviewer_id, participant_card_id)
     VALUES ('camp_fold_test', '이가족', '010-7171-2222', '71712222', 'cancelled', $1, $2) RETURNING id`, [A, famCard.id])).rows[0].id;
  await db.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, status, owner_reviewer_id)
     VALUES ('camp_fold_test', '한진행', '010-7474-5555', '74745555', 'applied', $1)`, [C]);
  const subsNow = async (id = A) => (await db.query('SELECT sub_accounts FROM reviewers WHERE id = $1', [id])).rows[0].sub_accounts;
  const orderRow = async (id) => (await db.query('SELECT participant_card_id, participant_identity_key_hash FROM order_submissions WHERE id = $1', [id])).rows[0];

  try {
    let pv;
    await test('미리보기는 쓰지 않고 대상·예외·대기를 나눈다(이름·번호는 기록에 없음)', async () => {
      pv = await fold.preview({ db });
      const mine = pv.items.filter((x) => ids.includes(x.ownerId));
      const byIdx = Object.fromEntries(mine.filter((x) => x.ownerId === A).map((x) => [x.index, x]));
      assert.strictEqual(byIdx[0].status, 'ready');
      assert.strictEqual(byIdx[2].status, 'ready'); assert.strictEqual(byIdx[2].type, 'duplicate');
      assert.deepStrictEqual(byIdx[3].reasons, ['other_reviewer_same_name']);
      assert.ok(!byIdx[1], '번호가 다른 칸은 대상 아님');
      assert.strictEqual(mine.find((x) => x.ownerId === C).status, 'wait');
      assert.strictEqual((await subsNow()).length, 4);
      const stored = JSON.stringify((await db.query('SELECT items FROM reviewer_identity_fold_runs WHERE id = $1', [pv.runId])).rows[0].items);
      assert.ok(!/이가족|정본인|7171/.test(stored), '실행 기록에 이름·번호가 들어가면 안 된다');
    });
    await test('미리보기 뒤 바뀐 칸(계좌가 생김)은 실행 때 다시 판정해 건너뛴다', async () => {
      assert.strictEqual(pv.items.find((x) => x.ownerId === D).status, 'ready');
      await db.query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`,
        [D, JSON.stringify([{ name: '오가족', phone: '010-7575-6666', bankName: '신한', bankAccount: '777', accountHolder: '오가족' }])]);
    });
    let ap;
    await test('실행 — 칸 지움 · 카드 merged · 주문·참여 본인으로 · 뒤 칸 옛 이름표 당김 · 받는 사람 이름 그대로', async () => {
      ap = await fold.apply({ previewRunId: pv.runId, db, retryDelayMs: 10 });
      const mine = ap.results.filter((r) => r.ownerId === A);
      assert.deepStrictEqual(mine.map((r) => r.result), ['folded', 'folded']);
      const subs = await subsNow();
      assert.deepStrictEqual(subs.map((s) => s.name), ['박다른', '최동명']);
      const fam = await cardOf(A, '이가족');
      assert.strictEqual(fam.status, 'merged'); assert.strictEqual(String(fam.merged_into), String(selfCard.id));
      const r1 = await orderRow(oCard);
      assert.strictEqual(String(r1.participant_card_id), String(selfCard.id)); assert.strictEqual(r1.participant_identity_key_hash, H('self'));
      assert.strictEqual((await orderRow(oLegacyFam)).participant_identity_key_hash, H('self'));
      assert.strictEqual((await orderRow(oLegacyPark)).participant_identity_key_hash, H(roi._test.legacyIdentityKey('박다른', '010-7373-4444', 0)));
      assert.strictEqual((await orderRow(oOther)).participant_identity_key_hash, H('self'));
      assert.strictEqual((await db.query('SELECT recipient FROM order_submissions WHERE id = $1', [oCard])).rows[0].recipient, '이가족');
      assert.strictEqual(String((await db.query('SELECT participant_card_id FROM campaign_applications WHERE id = $1', [app])).rows[0].participant_card_id), String(selfCard.id));
      assert.strictEqual((await subsNow(C)).length, 1, '진행 중 참여가 있는 리뷰어는 건드리지 않는다');
      assert.strictEqual(ap.results.find((r) => r.ownerId === D).result, 'stale');
      assert.strictEqual((await subsNow(D)).length, 1, '바뀐 칸은 지우지 않는다');
      const snap = (await db.query(`SELECT snapshot FROM reviewer_identity_decisions WHERE owner_reviewer_id = $1 AND kind = 'fold_self' ORDER BY id LIMIT 1`, [A])).rows[0].snapshot;
      assert.strictEqual(snap.sub.address, '부모님 댁'); assert.strictEqual(snap.index, 0);
      assert.strictEqual(snap.sub.jumin, '', '되돌리기 기록에 주민번호를 담지 않는다'); assert.strictEqual(snap.juminSameAsOwner, true);
      // 결정 226 (나) — 받는 주소는 본계정 추가 배송지로 남는다(구매양식 고르기·명의 확인)
      const extra = (await db.query(`SELECT recipient, address, source FROM reviewer_delivery_addresses WHERE owner_reviewer_id = $1`, [A])).rows;
      assert.deepStrictEqual(extra, [{ recipient: '이가족', address: '부모님 댁', source: 'fold' }]);
      const prof = await roi.loadOwnerProfile(A, db);
      assert.deepStrictEqual(prof.identities[0].deliveryAddresses.map((x) => x.address), ['부모님 댁']);
    });
    await test('같은 미리보기로 다시 돌려도 결과가 같다 · 스위치는 끝난 실행을 다시 하지 않는다', async () => {
      const again = await fold.apply({ previewRunId: pv.runId, db, retryDelayMs: 10 });
      assert.ok(again.results.filter((r) => r.ownerId === A).every((r) => r.result === 'already_done'));
      const sw = await fold.runFromSwitch({ db, env: { SAME_PHONE_FOLD_MODE: `apply:${pv.runId}` } });
      assert.strictEqual(sw.skipped, 'already_applied');
    });
    await test('10분 거울이 합친 카드를 되살리지 않는다 · 명의 목록에 그 이름이 없다', async () => {
      await cards.reconcileCards({ db, dryRun: false, by: 'test' });
      assert.strictEqual((await cardOf(A, '이가족')).status, 'merged');
      const { identities } = await roi.loadOwnerProfile(A, db);
      assert.ok(!identities.some((i) => i.name === '이가족'));
    });
    await test('그 이름으로 로그인하면 막고 본계정 이름을 안내한다(2단계 안내)', async () => {
      const r = await reviewer.verifyReviewer('이가족', '71712222');
      assert.strictEqual(r.ok, false);
      assert.ok(String(r.error || r.message).includes('정본인'), r.error);
      assert.ok((await reviewer.verifyReviewer('정본인', '71712222')).ok);
    });
    await test('정리 전에 열어 둔 내정보 화면이 통째로 저장해도 지운 칸이 돌아오지 않는다', async () => {
      const stale = JSON.stringify([...subsA.slice(0, 2), subsA[3]].map((s) => ({ ...s })));
      const r = await reviewer.handleReviewerProfile({ action: 'saveSubAccounts', phone8: '71712222', subAccounts: stale });
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual((await subsNow()).map((s) => s.name), ['박다른', '최동명']);
    });
    await test('본계정 로그인 안내 — 합친 이름 · [다시 보지 않기] 뒤에는 뜨지 않는다', async () => {
      const n = await fold.pendingNotice(A, { db });
      assert.deepStrictEqual(n.notice.subNames.sort(), ['이가족', '정본인'].sort());
      assert.strictEqual(n.notice.ownerName, '정본인');
      assert.strictEqual((await fold.pendingNotice(B, { db })).notice, null);
      assert.strictEqual((await fold.dismissNotice(A, { db })).dismissed, 2);
      assert.strictEqual((await fold.pendingNotice(A, { db })).notice, null);
    });
    await test('옛 키(residentNo)의 주민번호도 기록에 담지 않는다', async () => {
      const snap = (await db.query(`SELECT snapshot FROM reviewer_identity_decisions WHERE owner_reviewer_id = $1 AND kind = 'fold_self' AND snapshot->>'type' = 'duplicate'`, [A])).rows[0].snapshot;
      assert.strictEqual(snap.sub.residentNo, ''); assert.deepStrictEqual(snap.juminKeys, ['residentNo']);
      assert.ok(!/1234567/.test(JSON.stringify(snap)));
    });
    await test('정리 뒤 리뷰어가 맨 앞에 칸을 더함(되돌릴 때 순번이 달라지는 경우)', async () => {
      await db.query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`,
        [A, JSON.stringify([{ name: '신규칸', phone: '010-7676-1111' }, ...(await subsNow())])]);
      await cards.reconcileCards({ db, dryRun: false, by: 'test' });
    });
    await test('판단 내역에 보이고, 하나 되돌리면 칸·카드·기록이 원래대로(주민번호는 본계정 값으로)', async () => {
      const list = (await merge.listDecisions({ db })).decisions.filter((d) => d.ownerId === A);
      const famDec = list.find((d) => d.foldedName === '이가족');
      assert.ok(famDec && famDec.kind === 'fold_self');
      const u = await merge.undoDecision({ decisionId: famDec.decisionId, by: 'tester', db });
      assert.ok(u.ok && u.restored.slot && u.restored.cards === 1, JSON.stringify(u));
      const subs = await subsNow();
      // 원래 바로 뒤 칸(박다른) 앞자리로 — 새로 더한 칸이 앞에 있어도 이웃 옆에 돌아간다
      assert.deepStrictEqual(subs.map((s) => s.name), ['신규칸', '이가족', '박다른', '최동명']);
      assert.strictEqual(subs[1].address, '부모님 댁');
      assert.strictEqual((await db.query(`SELECT count(*)::int n FROM reviewer_delivery_addresses WHERE owner_reviewer_id = $1`, [A])).rows[0].n, 0,
        '칸이 돌아오면 추가 배송지는 지운다');
      assert.strictEqual(String(subs[1].jumin).replace(/\D/g, ''), '9001011234567');
      assert.strictEqual((await cardOf(A, '이가족')).status, 'active');
      const r1 = await orderRow(oCard);
      assert.strictEqual(String(r1.participant_card_id), String(famCard.id));
      assert.strictEqual(r1.participant_identity_key_hash, H(`card:${famCard.id}`));
      // 옛 값(순번 1)을 그대로 되돌리면 그 자리는 이제 '신규칸' — 되돌린 목록의 지금 순번(2)으로 다시 계산해야 한다(Codex P1)
      assert.strictEqual((await orderRow(oLegacyPark)).participant_identity_key_hash, H(roi._test.legacyIdentityKey('박다른', '010-7373-4444', 2)));
      assert.strictEqual((await orderRow(oOther)).participant_identity_key_hash, H('self'), '원래 본인 기록은 그대로');
      assert.strictEqual(String((await db.query('SELECT participant_card_id FROM campaign_applications WHERE id = $1', [app])).rows[0].participant_card_id), String(famCard.id));
      await cards.reconcileCards({ db, dryRun: false, by: 'test' });
      assert.strictEqual((await cardOf(A, '이가족')).status, 'active', '되돌린 뒤 거울이 다시 지우지 않는다');
    });
    await test('실행 전체 되돌리기 — 남은 정리(완전 중복)도 원래 자리로 · 다시 돌려도 같음', async () => {
      const r = await fold.undoRun({ applyRunId: ap.applyRunId, db });
      assert.ok(r.summary.undone >= 1 && r.summary.failed === 0, JSON.stringify(r.summary));
      const after = await subsNow();
      assert.deepStrictEqual(after.map((s) => s.name), ['신규칸', '이가족', '박다른', '정본인', '최동명']);
      assert.strictEqual(String(after[3].residentNo).replace(/\D/g, ''), '9001011234567', '옛 키 자리에 본계정 주민번호로');
      const sw = await fold.runFromSwitch({ db, env: { SAME_PHONE_FOLD_MODE: `undo_all:${ap.applyRunId}` } });
      assert.strictEqual(sw.skipped, 'already_undone');
    });
    await test('같은 주소를 두 이름이 쓰면 추가 배송지에 둘 다 남는다', async () => {
      const G = 'f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6';
      try {
        await db.query(`INSERT INTO reviewers (id, name, phone, address, sub_accounts) VALUES ($1, '강본인', '010-7878-1111', '서울 집', $2::jsonb)`,
          [G, JSON.stringify([{ name: '강하나', phone: '010-7878-1111', address: '대전 본가 1동' }, { name: '강두리', phone: '01078781111', address: '대전 본가 1동' },
            { name: '강셋째', phone: '010-7878-1111', address: '대전 XX구 가림' }])]);
        await cards.reconcileCards({ db, dryRun: false, by: 'test' });
        const p4 = await fold.preview({ db });
        await fold.apply({ previewRunId: p4.runId, db, retryDelayMs: 10 });
        const rows = (await db.query(`SELECT recipient, address FROM reviewer_delivery_addresses WHERE owner_reviewer_id = $1 ORDER BY recipient`, [G])).rows;
        assert.deepStrictEqual(rows.map((x) => x.recipient), ['강두리', '강하나'], 'x 가림 주소는 남기지 않는다');
      } finally {
        await db.query(`DELETE FROM reviewer_delivery_addresses WHERE owner_reviewer_id = $1`, [G]);
        await db.query(`DELETE FROM reviewer_identity_decisions WHERE owner_reviewer_id = $1`, [G]);
        await db.query(`DELETE FROM reviewers WHERE id = $1`, [G]);
      }
    });
    await test('되돌릴 때 같은 칸이 다른 주소로 이미 다시 생겼으면 추가 배송지를 지우지 않는다', async () => {
      const H2 = 'f7f7f7f7-f7f7-4f7f-8f7f-f7f7f7f7f7f7';
      try {
        await db.query(`INSERT INTO reviewers (id, name, phone, address, sub_accounts) VALUES ($1, '문본인', '010-7979-1111', '서울 집', $2::jsonb)`,
          [H2, JSON.stringify([{ name: '문가족', phone: '010-7979-1111', address: '광주 본가 2동' }])]);
        await cards.reconcileCards({ db, dryRun: false, by: 'test' });
        const p5 = await fold.preview({ db });
        await fold.apply({ previewRunId: p5.runId, db, retryDelayMs: 10 });
        // 리뷰어가 같은 이름·번호 칸을 다른 주소로 다시 만듦
        await db.query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`, [H2, JSON.stringify([{ name: '문가족', phone: '010-7979-1111', address: '제주 새집' }])]);
        const dec = (await db.query(`SELECT id FROM reviewer_identity_decisions WHERE owner_reviewer_id = $1 AND kind = 'fold_self'`, [H2])).rows[0].id;
        await merge.undoDecision({ decisionId: String(dec), by: 'tester', db });
        const rows = (await db.query(`SELECT address FROM reviewer_delivery_addresses WHERE owner_reviewer_id = $1`, [H2])).rows;
        assert.deepStrictEqual(rows.map((x) => x.address), ['광주 본가 2동'], '원래 주소는 남는다');
        // 다시 원래 주소로 고쳐 또 정리 → 남아 있던 줄을 이번 정리 몫으로 가져와, 되돌리면 지워진다(Codex P2)
        await db.query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`, [H2, JSON.stringify([{ name: '문가족', phone: '010-7979-1111', address: '광주 본가 2동' }])]);
        await cards.reconcileCards({ db, dryRun: false, by: 'test' });
        const p6 = await fold.preview({ db });
        await fold.apply({ previewRunId: p6.runId, db, retryDelayMs: 10 });
        const dec2 = (await db.query(`SELECT id FROM reviewer_identity_decisions WHERE owner_reviewer_id = $1 AND kind = 'fold_self' AND undone_at IS NULL`, [H2])).rows[0].id;
        assert.strictEqual(String((await db.query(`SELECT decision_id FROM reviewer_delivery_addresses WHERE owner_reviewer_id = $1`, [H2])).rows[0].decision_id), String(dec2));
        await merge.undoDecision({ decisionId: String(dec2), by: 'tester', db });
        assert.strictEqual((await db.query(`SELECT count(*)::int n FROM reviewer_delivery_addresses WHERE owner_reviewer_id = $1`, [H2])).rows[0].n, 0);
      } finally {
        await db.query(`DELETE FROM reviewer_delivery_addresses WHERE owner_reviewer_id = $1`, [H2]);
        await db.query(`DELETE FROM reviewer_identity_decisions WHERE owner_reviewer_id = $1`, [H2]);
        await db.query(`DELETE FROM reviewers WHERE id = $1`, [H2]);
      }
    });
    await test('타계정 카드가 아직 없으면 지우지 않고(no_sub_card) 다음에 다시 시도한다', async () => {
      const E = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5';
      try {
        await db.query(`INSERT INTO reviewers (id, name, phone, sub_accounts) VALUES ($1, '유본인', '010-7777-8888', $2::jsonb)`,
          [E, JSON.stringify([{ name: '유가족', phone: '010-7777-8888' }])]);
        await cards.reconcileCards({ db, dryRun: false, by: 'test' });
        await db.query(`DELETE FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 AND kind = 'sub'`, [E]);
        const p3 = await fold.preview({ db });
        const a3 = await fold.apply({ previewRunId: p3.runId, db, retryDelayMs: 10 });
        assert.strictEqual(a3.results.find((x) => x.ownerId === E).result, 'no_sub_card');
        assert.strictEqual((await subsNow(E)).length, 1);
        // 남은 칸이 있는 실행은 끝난 것으로 보지 않는다 — 스위치가 이어서 시도
        const sw = await fold.runFromSwitch({ db, env: { SAME_PHONE_FOLD_MODE: `apply:${p3.runId}` } });
        assert.notStrictEqual(sw && sw.skipped, 'already_applied');
      } finally {
        await db.query(`DELETE FROM reviewer_identity_decisions WHERE owner_reviewer_id = $1`, [E]);
        await db.query(`DELETE FROM reviewers WHERE id = $1`, [E]);
      }
    });
    await test('실패가 남은 전체 되돌리기는 끝난 것으로 보지 않는다', async () => {
      const { rows: [u] } = await db.query(`INSERT INTO reviewer_identity_fold_runs (mode, finished_at, summary) VALUES ('undo_all', NOW(), '{"applyRunId":"987654","failed":1}') RETURNING id`);
      const sw = await fold.runFromSwitch({ db, env: { SAME_PHONE_FOLD_MODE: 'undo_all:987654' } });
      assert.notStrictEqual(sw && sw.skipped, 'already_undone');
      await db.query(`DELETE FROM reviewer_identity_fold_runs WHERE id = $1`, [u.id]);
    });
    await test('되돌릴 때 같은 이름·번호의 살아 있는 카드가 이미 있으면 기록을 그 카드로 돌린다(Codex P2)', async () => {
      await db.query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`, [D, JSON.stringify([{ name: '오가족', phone: '010-7575-6666' }])]);
      await cards.reconcileCards({ db, dryRun: false, by: 'test' });
      const dCard = await cardOf(D, '오가족');
      const o = (await db.query(`INSERT INTO order_submissions (sheet_id, tab_name, owner_reviewer_id, phone, recipient, participant_identity_key_hash, participant_card_id)
         VALUES ('t','t',$1,'010-7575-6666','오가족',$2,$3) RETURNING id`, [D, H(`card:${dCard.id}`), dCard.id])).rows[0].id;
      const p2 = await fold.preview({ db });
      const a2 = await fold.apply({ previewRunId: p2.runId, db, retryDelayMs: 10 });
      assert.strictEqual(a2.results.find((r) => r.ownerId === D).result, 'folded');
      // 그 사이 같은 이름·번호 카드가 새로 살아남(담당자가 다시 넣는 등)
      const live = (await db.query(`INSERT INTO reviewer_identity_cards (owner_reviewer_id, kind, name, name_key, phone, phone8, source)
         VALUES ($1, 'sub', '오가족', '오가족', '010-7575-6666', '75756666', 'test') RETURNING id`, [D])).rows[0].id;
      const dec = (await db.query(`SELECT id FROM reviewer_identity_decisions WHERE owner_reviewer_id = $1 AND kind = 'fold_self' AND undone_at IS NULL`, [D])).rows[0].id;
      const u = await merge.undoDecision({ decisionId: String(dec), by: 'tester', db });
      assert.ok(u.ok);
      const r = await orderRow(o);
      assert.strictEqual(String(r.participant_card_id), String(live));
      assert.strictEqual(r.participant_identity_key_hash, H(`card:${live}`));
    });
  } finally {
    await cleanup();
    await db.end();
  }
  console.log(`\n✅ identityFoldSamePhone: ${passed}개 통과`);
  process.exit(0);
})().catch((err) => { console.error('❌', err && err.stack || err); process.exit(1); });
