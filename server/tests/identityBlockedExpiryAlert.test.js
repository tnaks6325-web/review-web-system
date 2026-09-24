'use strict';
// 명의 확인에 막혀 만료된 참여를 담당자 로그에 남긴다(2026-09-24 근본원인 보고서 원인 5 — 20일간 82건이 아무도 모르게 만료).
const assert = require('assert');
const path = require('path');
const logPath = path.resolve(__dirname, '../src/services/reviewerEventLog.service.js');
const logged = [];
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true,
  exports: { logReviewerEvent: async (e) => { logged.push(e); return { ok: true, id: 1 }; } } };
const hold = require('../src/services/campaignHold.service');
const { describeEvent } = (() => { delete require.cache[logPath]; return require(logPath); })();
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  await test('명의 불일치만 있고 승인이 없던 만료 건만 로그를 남긴다', async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params });
      return { rows: [{ id: 12825, applicant_name: '김수만', phone8: '11112222', linked_sheet_id: 's1',
        linked_tab_name: '탭', linked_tab_gid: '9', blocked_tries: '20' }] }; } };
    // require.cache 스텁은 hold 모듈 require 이후 원본으로 교체됐으므로 다시 스텁한다
    require.cache[logPath].exports = { ...require.cache[logPath].exports,
      logReviewerEvent: async (e) => { logged.push(e); return { ok: true }; } };
    await hold.logIdentityBlockedExpiries(pool, [12825, 12826]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].params, [[12825, 12826]]);
    assert.match(calls[0].sql, /status = 'MISMATCH'/);
    assert.match(calls[0].sql, /NOT bool_or\(a\.status IN \('MATCH', 'MANUAL_CONFIRMED'\)\)/);
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].eventType, 'identity_blocked_expired');
    assert.strictEqual(logged[0].sheetId, 's1');
    assert.strictEqual(logged[0].context.blockedTries, 20);
  });

  await test('조회 실패(감사 테이블 미적용 등)는 만료 처리를 막지 않는다', async () => {
    const pool = { query: async () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; } };
    await hold.logIdentityBlockedExpiries(pool, [1]);
  });

  await test('만료 스윕은 방금 만료된 id 로만 알림을 조회한다', async () => {
    const seen = [];
    const pool = { query: async (sql, params) => {
      seen.push(sql);
      if (/SET status = 'expired'/.test(sql)) return { rowCount: 1, rows: [{ id: 77 }] };
      if (/reviewer_identity_match_audits/.test(sql)) { assert.deepStrictEqual(params, [[77]]); return { rows: [] }; }
      return { rowCount: 0, rows: [] };
    } };
    await hold.sweepExpiredHolds(pool);
    assert.ok(seen.some((s) => /reviewer_identity_match_audits/.test(s)));
    const none = { query: async (sql) => {
      assert.ok(!/reviewer_identity_match_audits/.test(sql), '만료 0건이면 조회하지 않는다');
      return { rowCount: 0, rows: [] };
    } };
    await hold.sweepExpiredHolds(none);
  });

  await test('로그 화면 문구가 원인과 조치를 말한다', async () => {
    const d = describeEvent({ eventType: 'identity_blocked_expired', context: { blockedTries: 20 } });
    assert.match(d.problem, /20회/);
    assert.match(d.action, /1:1 문의/);
  });

  console.log(`\n✅ identityBlockedExpiryAlert: ${passed}개 통과`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
