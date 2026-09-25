'use strict';
/*
 * 명의 합치기 — 조각 4 (migration 167 · 결정 기록 179 · 사용자 확정 2026-09-25 모두 가)
 *   A. 배선: 라우트 관리자 전용 · 참여 명의 고르기에서 합친 명의 숨김 · 화면 onclick 에 이름 미포함
 *   B. PGTEST_URL(전체 마이그레이션 DB) 있으면 진짜 PG:
 *      합치기(빈 칸만 채움 · 목록 칸 유지 · 거울이 되살리지 않음 · 명의 목록 "합쳐짐" 표시) ·
 *      본인 명의 못 합침 · 구성 바뀌면 거부 · 그대로 두기 · 새 명의가 생기면 다시 뜸 · 겹치는 번호 확인 · 되돌리기
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

(async () => {
  console.log('A. 배선');
  await test('합치기 라우트 8개는 모두 관리자 전용이다', async () => {
    const r = read('src/routes/trackB.routes.js');
    const lines = r.split('\n').filter((l) => /router\.(get|post)\('\/identity-cards\/(merge-counts|duplicates|shared-phones|decisions|merge|keep-separate|shared-phone-ok|decision-undo)'/.test(l));
    assert.strictEqual(lines.length, 8);
    for (const l of lines) assert.ok(/authMiddleware, adminOrMasterMiddleware/.test(l), l);
  });
  await test('참여할 때 고르는 명의 목록은 합친 명의를 숨긴다', async () => {
    const c = fs.readFileSync(path.resolve(__dirname, '../../frontend/campaign.html'), 'utf8');
    assert.ok(/x\.type === 'sub' && x\.name && x\.phone && !x\.merged/.test(c));
  });
  await test('명의 목록은 합친 명의를 빼지 않고 표시만 한다(내정보 순서 짝짓기 보호)', async () => {
    const s = read('src/services/reviewerOrderIdentity.service.js');
    assert.ok(/merged: mergedByIndex\.has\(index\)/.test(s));
    assert.ok(/merged: !!identity\.merged/.test(s));
  });
  await test('화면 버튼에는 번호만 넘긴다(리뷰어 이름·묶음 키를 코드에 넣지 않는다)', async () => {
    const wd = fs.readFileSync(path.resolve(__dirname, '../../frontend/workdesk.html'), 'utf8');
    const block = wd.slice(wd.indexOf('function _rvImChipsHtml'), wd.indexOf('async function _rvImUndo(i)'));
    assert.ok(block.length > 1000);
    for (const m of block.matchAll(/on(click|input|keydown)="([^"]*)"/g)) {
      assert.ok(!/groupKey|ownerName|\.name|\.phone|JSON\.stringify/.test(m[2]), m[2]);
    }
  });

  if (!process.env.PGTEST_URL) {
    console.log(`\n✅ reviewerIdentityMerge: ${passed}개 통과 (PGTEST_URL 없음 — 진짜 PG 단계 생략)`);
    process.exit(0);
  }

  console.log('B. 진짜 PG (전체 마이그레이션 DB)');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.PGTEST_URL });
  const has = (await db.query(`SELECT to_regclass('public.reviewer_identity_decisions') d, to_regclass('public.order_submissions') o`)).rows[0];
  if (!has.d || !has.o) {
    console.log('  (전체 마이그레이션 DB 가 아니라 B 단계 생략)');
    await db.end();
    console.log(`\n✅ reviewerIdentityMerge: ${passed}개 통과`);
    process.exit(0);
  }
  const cards = require('../src/services/reviewerIdentityCards.service');
  const merge = require('../src/services/reviewerIdentityMerge.service');
  const roi = require('../src/services/reviewerOrderIdentity.service');
  const A = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
  const B = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
  const cleanup = async () => {
    await db.query(`DELETE FROM reviewer_identity_decisions WHERE owner_reviewer_id = ANY($1::uuid[]) OR group_key LIKE 'shared|90909090|%'`, [[A, B]]);
    await db.query(`DELETE FROM order_submissions WHERE owner_reviewer_id = ANY($1::uuid[])`, [[A, B]]);
    await db.query(`DELETE FROM reviewer_account_change_audit WHERE reviewer_id = ANY($1::uuid[])`, [[A, B]]).catch(() => {});
    await db.query(`DELETE FROM reviewers WHERE id = ANY($1::uuid[])`, [[A, B]]);
  };
  await cleanup();
  const subsA = [
    { name: '김민수', phone: '010-9191-5678', bankName: '국민은행', bankAccount: '111-22' },
    { name: '김민수', phone: '010-9191-9999', address: '서울 강남구 1' },
    { name: '이영희', phone: '010-9090-9090' },
  ];
  await db.query(`INSERT INTO reviewers (id, name, phone, sub_accounts) VALUES ($1, '테스트소유A', '010-9191-0000', $2::jsonb)`, [A, JSON.stringify(subsA)]);
  await db.query(`INSERT INTO reviewers (id, name, phone, sub_accounts) VALUES ($1, '이영희', '010-9090-9090', '[]'::jsonb)`, [B]);
  await cards.reconcileCards({ db, dryRun: false, by: 'test' });
  await db.query(`INSERT INTO order_submissions (sheet_id, tab_name, owner_reviewer_id, phone) VALUES ('t','t',$1,'010-9191-5678'),('t','t',$1,'010-9191-9999'),('t','t',$1,'010-9191-9999')`, [A]);
  const groupOf = async () => (await merge.listDuplicateGroups({ db })).groups.find((g) => g.ownerId === A);
  const subsNow = async () => (await db.query('SELECT sub_accounts FROM reviewers WHERE id = $1', [A])).rows[0].sub_accounts;
  const cardsNow = async () => (await db.query(`SELECT id, name, phone8, status, merged_into, address, bank_account FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 ORDER BY phone8`, [A])).rows;

  try {
    let g;
    await test('중복 의심 묶음이 참여 수와 함께 보인다', async () => {
      g = await groupOf();
      assert.ok(g, '묶음 없음');
      assert.strictEqual(g.cards.length, 2);
      const byP = Object.fromEntries(g.cards.map((c) => [c.phone8, c]));
      assert.strictEqual(byP['91915678'].participation, 1);
      assert.strictEqual(byP['91919999'].participation, 2);
      assert.strictEqual(byP['91919999'].hasAddress, true);
      assert.strictEqual(byP['91915678'].hasBank, true);
    });
    await test('구성이 바뀐 묶음 키로는 합치지 않는다', async () => {
      await assert.rejects(merge.mergeGroup({ db, ownerId: A, nameKey: g.nameKey, groupKey: g.groupKey + 'x', keepCardId: g.cards[0].cardId }), (e) => e.code === 'stale');
    });
    let decision;
    await test('합치기: 남길 명의 값 우선 · 빈 칸만 채움 · 목록 칸은 그대로', async () => {
      const keep = g.cards.find((c) => c.phone8 === '91919999');
      decision = await merge.mergeGroup({ db, ownerId: A, nameKey: g.nameKey, groupKey: g.groupKey, keepCardId: keep.cardId, by: 'tester' });
      assert.deepStrictEqual(Object.keys(decision.filled).sort(), ['bank_account', 'bank_name']);
      const subs = await subsNow();
      assert.strictEqual(subs.length, 3, '목록 칸을 지우면 안 된다');
      const kept = subs.find((s) => s.phone === '010-9191-9999');
      assert.strictEqual(kept.address, '서울 강남구 1');
      assert.strictEqual(kept.bankAccount, '111-22');
      const c = await cardsNow();
      assert.strictEqual(c.find((x) => x.phone8 === '91915678').status, 'merged');
      assert.strictEqual(c.find((x) => x.phone8 === '91919999').bank_account, '111-22');
    });
    await test('10분 거울이 합친 명의를 되살리지 않는다', async () => {
      await cards.reconcileCards({ db, dryRun: false, by: 'test' });
      const c = await cardsNow();
      assert.strictEqual(c.filter((x) => x.phone8 === '91915678' && x.status === 'active').length, 0);
      assert.ok(!(await groupOf()), '합친 묶음은 다시 뜨지 않는다');
    });
    await test('명의 목록에는 남아 있고 "합쳐짐" 표시가 붙는다', async () => {
      const { identities } = await roi.loadOwnerProfile(A, db);
      const old = identities.find((i) => i.phone === '010-9191-5678');
      assert.ok(old && old.merged === true);
      assert.strictEqual(identities.find((i) => i.phone === '010-9191-9999').merged, false);
    });
    await test('되돌리기: 합친 명의가 살아나고, 채운 칸은 그대로일 때만 비운다', async () => {
      await db.query(`UPDATE reviewers SET sub_accounts = jsonb_set(sub_accounts, '{1,bankName}', '"사람이고친은행"') WHERE id = $1`, [A]);
      const r = await merge.undoDecision({ db, decisionId: decision.decisionId, by: 'tester' });
      assert.strictEqual(r.restored.cards, 1);
      const kept = (await subsNow()).find((s) => s.phone === '010-9191-9999');
      assert.strictEqual(kept.bankAccount, '', '채운 값 그대로 → 비움');
      assert.strictEqual(kept.bankName, '사람이고친은행', '그 뒤 사람이 고친 값은 둔다');
      assert.ok(await groupOf(), '되돌리면 묶음이 다시 뜬다');
    });
    await test('본인 명의는 합쳐 없앨 수 없다', async () => {
      await db.query(`UPDATE reviewers SET sub_accounts = sub_accounts || '[{"name":"테스트소유A","phone":"010-9191-7777"}]'::jsonb WHERE id = $1`, [A]);
      await cards.reconcileCards({ db, dryRun: false, by: 'test' });
      const gs = (await merge.listDuplicateGroups({ db })).groups.filter((x) => x.ownerId === A);
      const selfGroup = gs.find((x) => x.hasSelf);
      assert.ok(selfGroup);
      const sub = selfGroup.cards.find((c) => c.kind === 'sub');
      await assert.rejects(merge.mergeGroup({ db, ownerId: A, nameKey: selfGroup.nameKey, groupKey: selfGroup.groupKey, keepCardId: sub.cardId }), (e) => e.code === 'self_cannot_merge');
    });
    await test('그대로 두기 → 목록에서 빠지고, 같은 이름 명의가 새로 생기면 다시 뜬다', async () => {
      g = await groupOf();
      const gs = (await merge.listDuplicateGroups({ db })).groups.filter((x) => x.ownerId === A && !x.hasSelf);
      const target = gs[0];
      await merge.keepSeparate({ db, ownerId: A, nameKey: target.nameKey, groupKey: target.groupKey, by: 'tester' });
      assert.ok(!(await merge.listDuplicateGroups({ db })).groups.some((x) => x.groupKey === target.groupKey));
      await db.query(`UPDATE reviewers SET sub_accounts = sub_accounts || '[{"name":"김민수","phone":"010-9191-3333"}]'::jsonb WHERE id = $1`, [A]);
      await cards.reconcileCards({ db, dryRun: false, by: 'test' });
      const again = (await merge.listDuplicateGroups({ db })).groups.find((x) => x.ownerId === A && !x.hasSelf);
      assert.ok(again && again.cards.length === 3);
    });
    await test('같은 묶음을 두 번 판단하지 못한다', async () => {
      const t = (await merge.listDuplicateGroups({ db })).groups.find((x) => x.ownerId === A && !x.hasSelf);
      await merge.keepSeparate({ db, ownerId: A, nameKey: t.nameKey, groupKey: t.groupKey });
      await assert.rejects(merge.keepSeparate({ db, ownerId: A, nameKey: t.nameKey, groupKey: t.groupKey }), (e) => e.code === 'already_decided');
    });
    await test('겹치는 번호: 두 리뷰어가 보이고, 확인하면 빠지며 번호는 그대로다', async () => {
      const it = (await merge.listSharedPhones({ db })).items.find((x) => x.phone8 === '90909090');
      assert.ok(it && new Set(it.entries.map((e) => e.ownerId)).size === 2);
      await merge.confirmSharedPhone({ db, phone8: '90909090', groupKey: it.groupKey, memo: '가족이 한 폰을 씀', by: 'tester' });
      assert.ok(!(await merge.listSharedPhones({ db })).items.some((x) => x.phone8 === '90909090'));
      assert.ok((await subsNow()).some((s) => s.phone === '010-9090-9090'));
      const log = await merge.listDecisions({ db });
      assert.ok(log.decisions.some((d) => d.kind === 'shared_phone_ok' && d.memo === '가족이 한 폰을 씀'));
    });
    await test('되돌린 판단은 다시 되돌릴 수 없다', async () => {
      await assert.rejects(merge.undoDecision({ db, decisionId: decision.decisionId }), (e) => e.code === 'already_undone');
    });
  } finally {
    await cleanup();
    await db.end();
  }
  console.log(`\n✅ reviewerIdentityMerge: ${passed}개 통과 (진짜 PG 포함)`);
  process.exit(0);
})().catch((err) => { console.error('❌', err.stack || err.message); process.exit(1); });
