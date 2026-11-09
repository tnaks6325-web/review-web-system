'use strict';
/**
 * 결정 356 — 실제 SQL(PGlite)로 차례 타이머를 돌린다(동시 접속 증명은 아니다 — 순서·격리·문법 증명).
 *  ① 217·218 두 번 돌려도 같다(멱등) · 218 은 30·빈 값만 20 으로, 따로 정한 값(60)은 그대로 + 백업
 *  ② 바깥 SAVEPOINT(hold_confirm) 안에서 당기기 → 다음 명의 지금 시작 · lock_timeout 원래 값
 *  ③ 다시 당겨도 변화 0
 *  ④ 당기기 SQL 이 실패해도(칸 없음 42703) 같은 트랜잭션의 취소는 커밋된다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }
const C = require('../src/services/campaignHoldChain.service');
const MIG = f => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');
let passed = 0; const ok = (n, c) => { assert.ok(c, n); passed++; };

(async () => {
  const pg = new PGlite();
  const client = { async query(sql, params) { const r = await pg.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } };
  await pg.exec(`CREATE TABLE recruit_campaigns(id TEXT PRIMARY KEY, hold_ttl_min INT DEFAULT 30);
    CREATE TABLE campaign_applications(id SERIAL PRIMARY KEY, campaign_id TEXT, phone8 TEXT, owner_phone8 TEXT, status TEXT,
      expires_at TIMESTAMPTZ, applied_at TIMESTAMPTZ DEFAULT NOW(), hold_token TEXT);
    INSERT INTO recruit_campaigns(id, hold_ttl_min) VALUES ('c1',30),('c2',60),('c3',NULL),('c4',20);`);
  for (let i = 0; i < 2; i++) { await pg.exec(MIG('217_campaign_hold_chain.sql')); await pg.exec(MIG('218_main_hold_ttl_20min.sql')); }
  const ttl = Object.fromEntries((await pg.query('SELECT id, hold_ttl_min FROM recruit_campaigns')).rows.map(r => [r.id, r.hold_ttl_min]));
  const bak = Object.fromEntries((await pg.query('SELECT campaign_id, hold_ttl_min FROM campaign_hold_ttl_backup_218')).rows.map(r => [r.campaign_id, r.hold_ttl_min]));
  ok('① 218: 30·빈 값 → 20 · 60 은 그대로 · 바꾼 값만 백업', ttl.c1 === 20 && ttl.c2 === 60 && ttl.c3 === 20 && ttl.c4 === 20
    && bak.c1 === 30 && bak.c3 === null && !('c2' in bak) && !('c4' in bak));
  ok('① 218: 새 공고 기본값 20', (await pg.query(`INSERT INTO recruit_campaigns(id) VALUES ('c9') RETURNING hold_ttl_min`)).rows[0].hold_ttl_min === 20);

  const now = Date.now(), M = 60000;
  const ins = async (p8, s, e, t) => (await client.query(
    `INSERT INTO campaign_applications(campaign_id, phone8, owner_phone8, status, expires_at, turn_starts_at, chain_ttl_min, hold_token)
     VALUES ('c1',$1,'11110000','applied',$2,$3,$4,'t') RETURNING id`, [p8, new Date(now + e * M), new Date(now + s * M), t])).rows[0].id;
  const a = await ins('11110000', 0, 20, 20);
  const plan = await C.planChainLink(client, { campaignId: 'c1', ownerP8: '11110000', ttlMin: 15, now: new Date(now), closesAt: null, cutoffAt: null });
  ok('② 꼬리 = 살아 있는 홀드 최대 마감', plan.turnStartsAt.getTime() === now + 20 * M && plan.expiresAt.getTime() === now + 35 * M);
  const b = await ins('22220000', 20, 35, 15); await ins('33330000', 35, 50, 15);
  const refused = await C.planChainLink(client, { campaignId: 'c1', ownerP8: '11110000', ttlMin: 15, now: new Date(now),
    closesAt: new Date(now + 55 * M).toISOString(), cutoffAt: new Date(now + 45 * M).toISOString() });
  ok('② R5: 차례 시작(50분 뒤) ≥ cutoff(45분 뒤) → 거절', refused.refuse === true);

  await client.query('BEGIN'); await client.query('SAVEPOINT hold_confirm');
  await client.query(`UPDATE campaign_applications SET status = 'submitted' WHERE id = $1`, [a]);
  const r1 = await C.pullChainEarlierSafe(client, { campaignId: 'c1', endedIds: [a], cause: 'submit' });
  const lt = (await client.query(`SELECT current_setting('lock_timeout') AS v`)).rows[0].v;
  await client.query('RELEASE SAVEPOINT hold_confirm'); await client.query('COMMIT');
  const rows = (await pg.query(`SELECT id, EXTRACT(EPOCH FROM turn_starts_at - to_timestamp($1 / 1000.0)) / 60 AS s,
      EXTRACT(EPOCH FROM expires_at - to_timestamp($1 / 1000.0)) / 60 AS e FROM campaign_applications ORDER BY id`, [now])).rows
    .map(x => [Math.round(Number(x.s)), Math.round(Number(x.e))]);
  ok('② 본계정 제출 → s1 지금~15분 · s2 15~30분 · lock_timeout 원래 값', r1.changed === 2 && lt === '0'
    && rows[1][0] <= 1 && rows[1][1] <= 16 && rows[2][0] <= 16 && rows[2][1] <= 31);
  await client.query('BEGIN');
  const r2 = await C.pullChainEarlierSafe(client, { campaignId: 'c1', endedIds: [a], cause: 'submit' });
  await client.query('COMMIT');
  ok('③ 다시 당겨도 변화 0', r2.changed === 0);
  const view = await C.ownerChainView(client, { campaignId: 'c1', ownerP8: '11110000', now: new Date() });
  ok('③ 소유자 차례 보기 = 진행 1 · 대기 1 · 토큰 없음', view.length === 2 && view[0].state === 'running' && view[1].state === 'waiting'
    && !JSON.stringify(view).includes('hold_token'));

  await client.query('BEGIN');
  await client.query(`UPDATE campaign_applications SET status = 'cancelled' WHERE id = $1`, [b]);
  await pg.exec('ALTER TABLE campaign_applications RENAME COLUMN chain_ttl_min TO chain_ttl_min_x');
  const r3 = await C.pullChainEarlierSafe(client, { campaignId: 'c1', endedIds: [b], cause: 'cancel' });
  await client.query('COMMIT');
  ok('④ 당기기 SQL 실패(42703)에도 같은 트랜잭션의 취소는 커밋', r3.error === '42703'
    && (await pg.query('SELECT status FROM campaign_applications WHERE id = $1', [b])).rows[0].status === 'cancelled');
  console.log(`\n✅ campaignHoldChainPg: ${passed}개 통과`);
})().catch(e => { console.error('❌', e); process.exit(1); });
