'use strict';
/**
 * 회귀가드 — 양방향 2단계 기반: migration 196 · 스위치 (결정 275)
 *
 * 실행: node tests/bidirPhase2Schema.test.js   (PGTEST_URL 있으면 진짜 PG 에서도 확인)
 *
 * ★ 지키는 것:
 *   ① 195 는 가산 전용 — 칸·표·색인을 더하기만(IF NOT EXISTS). DROP·UPDATE·DELETE·트리거·함수·백필 0
 *   ② 새 칸·표를 읽는 코드가 생기면 그 칸·표는 REQUIRED_SCHEMA·REQUIRED_TABLES 에 등록돼 있어야 한다(3단계부터 등록)
 *   ③ 새 칸 기본값 = 꺼짐(bidir_state 'off', 버전 0) — 마이그레이션만으로 동작이 바뀌지 않는다
 *   ④ 스위치는 fail-closed — 없음·깨짐·모르는 값·읽기 실패 = 전부 꺼짐 · BIDIR_HARD_OFF=1 최우선 · 10초 캐시
 *   ⑤ (PGTEST_URL) 실제 PG 에 두 번 적용해도 성공(멱등) · 기존 행 값 불변 — 트랜잭션 안에서 하고 되돌린다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIG = fs.readFileSync(path.join(__dirname, '../migrations/196_bidir_shared_sync.sql'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const sw = require('../src/utils/bidirSwitch');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

const NEW_TABLES = ['work_order_shared_snapshots', 'shared_sync_outbox', 'work_order_option_links', 'campaign_option_price_history'];
const NEW_COLS = [['work_orders', 'sync_version'], ['work_orders', 'bidir_state'], ['work_orders', 'intranet_acked_version'],
  ['work_orders', 'required_delivery_memo'], ['work_orders', 'purchase_channel_custom'], ['campaign_options', 'inflow_guide_doc']];

(async () => {
  await t('① 195 는 가산 전용', () => {
    const code = MIG.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').replace(/--[^\n]*/g, '');
    const stmts = code.split(';').map(s => s.trim()).filter(Boolean);
    for (const s of stmts) {
      assert.ok(/^(ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)\b/.test(s), '가산이 아닌 문장: ' + s.slice(0, 80));
    }
    assert.ok(!/\b(DROP|UPDATE|DELETE|TRUNCATE|TRIGGER|FUNCTION|INSERT)\b/i.test(code), '파괴·백필·트리거 금지');
    for (const tb of NEW_TABLES) assert.ok(code.includes(`CREATE TABLE IF NOT EXISTS ${tb}`), tb);
    for (const [tb, c] of NEW_COLS) assert.ok(new RegExp(`ALTER TABLE ${tb} ADD COLUMN IF NOT EXISTS ${c}\\b`).test(code), `${tb}.${c}`);
  });

  await t('② 새 칸·표를 읽는 코드가 있으면 그 칸·표는 전부 필수 스키마에 등록돼 있다(3단계부터)', () => {
    // ★ 2단계에서는 "읽는 코드 0 → 미등록" 이었다. 3단계(결정 275)에서 원본 수정·관리자 수정·/shared 가 읽기 시작해 등록했다.
    //   이 가드는 반대 방향 드리프트(읽는 코드는 있는데 미등록 → 마이그레이션 실패 시 기동은 되고 그 기능만 500)를 막는다.
    const req = INDEX.slice(INDEX.indexOf('const REQUIRED_SCHEMA'), INDEX.indexOf('];', INDEX.indexOf('const REQUIRED_SCHEMA')));
    const reqT = INDEX.slice(INDEX.indexOf('const REQUIRED_TABLES'), INDEX.indexOf('];', INDEX.indexOf('const REQUIRED_TABLES')));
    const src = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? src(path.join(dir, d.name)) : [path.join(dir, d.name)]);
    const code = src(path.join(__dirname, '../src')).filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n');   // 주석은 읽는 코드가 아니다
    for (const [tb, c] of NEW_COLS) {
      if (new RegExp(`\\b${c}\\b`).test(code)) assert.ok(req.includes(`['${tb}', '${c}']`), `${tb}.${c} 를 읽는 코드가 있는데 필수 스키마에 없다`);
    }
    for (const tb of NEW_TABLES) {
      if (new RegExp(`\\b${tb}\\b`).test(code)) assert.ok(reqT.includes(`'${tb}'`), `${tb} 를 읽는 코드가 있는데 필수 표에 없다`);
    }
  });

  await t('③ 기본값 = 꺼짐', () => {
    assert.ok(/bidir_state TEXT NOT NULL DEFAULT 'off'/.test(MIG));
    assert.ok(/sync_version BIGINT NOT NULL DEFAULT 0/.test(MIG));
    assert.ok(/purchase_channel_custom BOOLEAN NOT NULL DEFAULT FALSE/.test(MIG));
  });

  await t('④ 스위치 fail-closed · 최우선 비상 스위치 · 캐시', async () => {
    const OFF = { in2rw: 'off', push: 'off', campaign_edit: 'off', hardOff: false };
    assert.deepStrictEqual(sw.parseBidirSetting(null), OFF);
    assert.deepStrictEqual(sw.parseBidirSetting('{깨짐'), OFF);
    assert.deepStrictEqual(sw.parseBidirSetting('[]'), OFF);
    assert.deepStrictEqual(sw.parseBidirSetting('{"in2rw":"ON","push":"yes"}'), OFF, '모르는 값은 꺼짐(대소문자 포함)');
    assert.deepStrictEqual(sw.parseBidirSetting('{"in2rw":"apply","push":"on","campaign_edit":"on"}'), { in2rw: 'apply', push: 'on', campaign_edit: 'on', hardOff: false });

    let calls = 0;
    const db = (value, throws) => ({ query: async () => { calls++; if (throws) throw new Error('down'); return { rows: value == null ? [] : [{ value }] }; } });
    sw._resetBidirSwitchCacheForTest();
    const on = '{"in2rw":"apply","push":"on","campaign_edit":"on"}';
    assert.strictEqual((await sw.readBidirSwitch(db(on), { now: 0, env: { BIDIR_HARD_OFF: '1' } })).hardOff, true, '비상 스위치는 표를 읽지도 않는다');
    assert.strictEqual(calls, 0);
    sw._resetBidirSwitchCacheForTest();
    assert.deepStrictEqual(await sw.readBidirSwitch(db(null), { now: 0, env: {} }), OFF, '설정 없음 = 꺼짐');
    sw._resetBidirSwitchCacheForTest(); calls = 0;
    assert.strictEqual((await sw.readBidirSwitch(db(on), { now: 1000, env: {} })).in2rw, 'apply');
    assert.strictEqual((await sw.readBidirSwitch(db('{}'), { now: 5000, env: {} })).in2rw, 'apply', '10초 안은 캐시');
    assert.strictEqual(calls, 1);
    assert.strictEqual((await sw.readBidirSwitch(db('{}'), { now: 12000, env: {} })).in2rw, 'off', '10초 뒤 다시 읽는다');
    sw._resetBidirSwitchCacheForTest(); calls = 0;
    assert.deepStrictEqual(await sw.readBidirSwitch(db(null, true), { now: 0, env: {} }), OFF, '읽기 실패 = 꺼짐');
    await sw.readBidirSwitch(db(on), { now: 1, env: {} });
    assert.strictEqual(calls, 2, '읽기 실패는 캐시하지 않는다');
  });

  if (process.env.PGTEST_URL) {
    await t('⑤ (진짜 PG) 두 번 적용해도 성공 · 기존 행 불변 · 기본값 확인 — 트랜잭션 안에서 하고 되돌린다', async () => {
      const { Client } = require('pg');
      const c = new Client({ connectionString: process.env.PGTEST_URL });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO work_orders (id, title) VALUES ('wo_mig196_probe', '마이그레이션 시험') ON CONFLICT (id) DO NOTHING`);
        const before = (await c.query(`SELECT to_jsonb(w.*) AS j FROM work_orders w WHERE id = 'wo_mig196_probe'`)).rows[0].j;
        await c.query(MIG);
        await c.query(MIG);
        const after = (await c.query(`SELECT to_jsonb(w.*) AS j FROM work_orders w WHERE id = 'wo_mig196_probe'`)).rows[0].j;
        for (const k of Object.keys(before)) assert.deepStrictEqual(after[k], before[k], `기존 칸 ${k} 가 바뀌었다`);
        assert.strictEqual(after.bidir_state, 'off');
        assert.strictEqual(Number(after.sync_version), 0);
        assert.strictEqual(after.purchase_channel_custom, false);
        for (const tb of NEW_TABLES) {
          const r = await c.query(`SELECT to_regclass($1) AS x`, [tb]);
          assert.ok(r.rows[0].x, tb + ' 없음');
        }
        const ty = await c.query(`SELECT data_type FROM information_schema.columns WHERE table_name='campaign_options' AND column_name='id'`);
        const hy = await c.query(`SELECT data_type FROM information_schema.columns WHERE table_name='campaign_option_price_history' AND column_name='option_id'`);
        assert.strictEqual(hy.rows[0].data_type, ty.rows[0].data_type, '이력 option_id 타입 = 옵션 id 타입');
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    });
  } else {
    console.log('  - ⑤ 진짜 PG 시험 건너뜀(PGTEST_URL 없음)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
