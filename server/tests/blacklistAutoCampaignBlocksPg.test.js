/**
 * 블랙리스트 → 공고별 「참여 불가」 자동 반영 — 실 PG (결정 050 개정 · 사용자 확정 2026-11-05 「b」)
 *
 * ① 등록하면 보관 안 된 공고 전부(작성중·게시중·마감)에 차단이 들어간다 · 보관된 공고·허용 예외·이미 차단은 무접촉
 * ② 새 공고에는 블랙리스트 전원이 들어간다
 * ③ migration 214(한 번 맞추기)는 빠진 것만 채우고 두 번 돌려도 0행
 * ④ 해제하면 종전대로 모든 공고 차단이 함께 풀린다 · 참여 판정(checkApplyGate)이 실제로 막고 푼다
 * PGTEST_URL 이 없으면 건너뛴다(템플릿 복사 DB에서 돌린다).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

if (!process.env.PGTEST_URL) { console.log('blacklistAutoCampaignBlocksPg: PGTEST_URL 없음 — 건너뜀'); process.exit(0); }
process.env.DATABASE_URL = process.env.PGTEST_URL;
const pool = require('../src/db/pool');
const svc = require('../src/services/reviewerGate.service');

const stamp = Date.now();
const id = (k) => `camp_bla_${k}_${stamp}`;
const P1 = '010' + String(stamp).slice(-8), P1_8 = P1.slice(-8);
const P2 = '010' + String(stamp + 7).slice(-8), P2_8 = P2.slice(-8);
const ids = ['active', 'draft', 'closed', 'archived', 'allow', 'new'].map(id);
let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('  ✓ ' + name); }
const active = async (cid, p8) => (await pool.query(
  `SELECT mode, message_type FROM campaign_reviewer_gates WHERE campaign_id=$1 AND phone8=$2 AND released_at IS NULL`, [cid, p8])).rows;

(async () => {
  try {
    const mk = (cid, status, archived) => pool.query(
      `INSERT INTO recruit_campaigns (id, title, status, archived_at) VALUES ($1, '가짜 공고', $2, ${archived ? 'NOW()' : 'NULL'})`, [cid, status]);
    await mk(id('active'), 'active'); await mk(id('draft'), 'draft'); await mk(id('closed'), 'closed');
    await mk(id('archived'), 'closed', true); await mk(id('allow'), 'active');
    // 사람이 정한 허용 예외
    await pool.query(`INSERT INTO campaign_reviewer_gates (campaign_id, phone8, reviewer_name, mode, created_by) VALUES ($1,$2,'가짜','allow','직원')`, [id('allow'), P1_8]);

    console.log('\n[블랙리스트 → 공고별 참여 불가 자동 반영 · 실 PG]');
    await t('① 등록 = 보관 안 된 공고에 「마감」 차단 · 보관·허용 예외는 무접촉', async () => {
      const r = await svc.setGlobalBlacklist({ phone: P1, on: true, reason: '가짜', by: '박세희' });
      assert.ok(r.on === true && r.campaignBlocksAdded >= 3, JSON.stringify(r));
      for (const k of ['active', 'draft', 'closed']) assert.deepStrictEqual(await active(id(k), P1_8), [{ mode: 'block', message_type: 'closed' }], k);
      assert.deepStrictEqual(await active(id('archived'), P1_8), [], '보관된 공고');
      assert.deepStrictEqual(await active(id('allow'), P1_8), [{ mode: 'allow', message_type: null }], '허용 예외가 이긴다');
      const g = await svc.checkApplyGate(pool, id('active'), P1_8);
      assert.deepStrictEqual([g.blocked, g.gate, g.source], [true, 'closed', 'campaign'], '참여 판정이 「마감」으로 막는다');
    });

    await t('① 다시 등록(사유 수정)해도 중복 행이 생기지 않는다', async () => {
      await svc.setGlobalBlacklist({ phone: P1, on: true, reason: '가짜2', by: '박세희' });
      const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM campaign_reviewer_gates WHERE campaign_id = ANY($1) AND phone8=$2 AND released_at IS NULL`, [ids, P1_8]);
      assert.strictEqual(rows[0].n, 4, '3곳 차단 + 허용 1');
    });

    await t('② 새 공고 = 블랙리스트 전원 차단', async () => {
      await pool.query(`INSERT INTO blacklist (phone, name, reason, added_by) VALUES ($1,'가짜둘','',''), ($2,'가짜','','')
                        ON CONFLICT (phone) DO NOTHING`, [P2, P1]);
      await mk(id('new'), 'draft');
      const r = await svc.blockBlacklistOnCampaign(id('new'), '김담당');
      assert.ok(r.added >= 2, JSON.stringify(r));
      assert.deepStrictEqual(await active(id('new'), P1_8), [{ mode: 'block', message_type: 'closed' }]);
      assert.deepStrictEqual(await active(id('new'), P2_8), [{ mode: 'block', message_type: 'closed' }]);
      assert.deepStrictEqual(await svc.blockBlacklistOnCampaign(id('new'), '김담당'), { added: 0 }, '두 번째는 0');
    });

    await t('③ migration 214 = 빠진 것만 채움(P2 를 직접 넣어 빠진 공고) · 재실행 0행 · 보관·허용 무접촉', async () => {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '214_blacklist_campaign_blocks_backfill.sql'), 'utf8');
      assert.deepStrictEqual(await active(id('active'), P2_8), [], '직접 넣은 P2 는 아직 빠져 있다');
      await pool.query(sql);
      for (const k of ['active', 'draft', 'closed']) assert.deepStrictEqual(await active(id(k), P2_8), [{ mode: 'block', message_type: 'closed' }], k);
      assert.deepStrictEqual(await active(id('archived'), P2_8), []);
      assert.deepStrictEqual(await active(id('allow'), P1_8), [{ mode: 'allow', message_type: null }]);
      const before = (await pool.query(`SELECT COUNT(*)::int n FROM campaign_reviewer_gates`)).rows[0].n;
      await pool.query(sql);
      assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM campaign_reviewer_gates`)).rows[0].n, before, '멱등');
    });

    await t('④ 해제 = 모든 공고 차단이 함께 풀린다(허용 예외는 남는다) · 참여 판정 통과', async () => {
      const r = await svc.setGlobalBlacklist({ phone: P1, on: false, by: '박세희' });
      assert.ok(r.campaignBlocksReleased >= 4, JSON.stringify(r));
      for (const k of ['active', 'draft', 'closed', 'new']) assert.deepStrictEqual(await active(id(k), P1_8), [], k);
      assert.deepStrictEqual(await active(id('allow'), P1_8), [{ mode: 'allow', message_type: null }]);
      assert.deepStrictEqual(await svc.checkApplyGate(pool, id('active'), P1_8), { blocked: false }, '풀린 뒤 참여 가능');
    });

    console.log(`\n✅ blacklistAutoCampaignBlocksPg: ${pass}개 통과`);
  } finally {
    await pool.query(`DELETE FROM campaign_reviewer_gates WHERE campaign_id = ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM recruit_campaigns WHERE id = ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM blacklist WHERE phone = ANY($1)`, [[P1, P2]]).catch(() => {});
    await pool.end();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
