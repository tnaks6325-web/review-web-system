'use strict';
/* 이상로그(error_logs) 누적 횟수만 보고 "이번 주 506회"로 오판하지 않게 — 최근 7일 횟수 (결정 326)
 *
 * 2026-11-03 운영 조사: 같은 오류를 한 줄로 묶어 occurrence_count 를 처음부터 계속 더해서
 * "6월부터 506회"(AI 시간초과)가 "이번 주 506회"처럼 읽혔다(실제 이번 주 2회).
 * 스키마는 그대로 두고 기존 context JSON 에 최근 14일 일자별 횟수(_daily)와 집계 시작 시각(_dailyFrom)을
 * 작게 유지한다. 조회 응답은 행마다 recent_7d_count / recent_7d_complete / recent_counts_since 를 싣는다.
 * ★ 집계 시작 전 발생분이 섞일 수 있으면 "완전함"으로 꾸미지 않는다(모름을 0 으로 접지 않는다).
 *
 * 실 Postgres(PGlite) 에 026+028 을 깔고 실제 logAbnormal UPSERT SQL 을 돌린다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.ERRORLOG_ENABLED;
delete process.env.ERRORLOG_AI_ENRICH;
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const pool = require('../src/db/pool');
const EL = require('../src/services/errorLog.service');
const root = path.resolve(__dirname, '..');

const kstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const DAY = 86400e3;

(async () => {
  const db = new PGlite();
  for (const f of ['026_error_logs.sql', '028_error_debug.sql']) {
    await db.exec(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
  }
  pool.query = (sql, params) => db.query(sql, params);
  const row = async (fp) => (await db.query(`SELECT * FROM error_logs WHERE message_raw = $1`, [fp])).rows[0];
  const today = kstDay(Date.now());
  let n = 0;

  // 1) 새 오류 3번 → 오늘 칸 3, 집계 시작 시각 기록, 7일 횟수 3(완전)
  const errA = () => new Error('[Gemini extract] timeout 9000ms A');
  for (let i = 0; i < 3; i++) await EL.logAbnormal({ flow: 'image_extract', step: 'gemini_call', error: errA(), context: { path: '/image-extract' } });
  let a = await row('[Gemini extract] timeout 9000ms A');
  assert.strictEqual(a.occurrence_count, 3);
  assert.strictEqual(a.context._daily && a.context._daily[today], 3, '오늘 칸 = 3 (' + JSON.stringify(a.context) + ')');
  assert(a.context._dailyFrom, '집계 시작 시각이 남는다');
  assert.strictEqual(a.context.path, '/image-extract', '호출부 context 는 그대로');
  let rc = EL.recentCounts(a);
  assert.deepStrictEqual([rc.recent_7d_count, rc.recent_7d_complete], [3, true]);
  n++; console.log('PASS 새 오류: 오늘 3회 = 최근 7일 3회(완전)');

  // 2) 오래 묶여 온 행: 누적 506 · 20일 전 칸은 지워지고(14일 보존) 7일 창 밖(8일 전)은 안 센다
  const old = {
    ...a.context,
    _daily: { [kstDay(Date.now() - 20 * DAY)]: 400, [kstDay(Date.now() - 8 * DAY)]: 50, [kstDay(Date.now() - 3 * DAY)]: 2, [today]: 1, junk: 'x' },
    _dailyFrom: new Date(Date.now() - 30 * DAY).toISOString(),
  };
  await db.query(`UPDATE error_logs SET occurrence_count = 505, first_seen_at = NOW() - interval '140 days', context = $1::jsonb WHERE id = $2`, [JSON.stringify(old), a.id]);
  await EL.logAbnormal({ flow: 'image_extract', step: 'gemini_call', error: errA(), context: { path: '/image-extract' } });
  a = await row('[Gemini extract] timeout 9000ms A');
  assert.strictEqual(a.occurrence_count, 506, '누적은 종전대로 계속 센다');
  assert.strictEqual(a.context._daily[today], 2, '오늘 칸 +1');
  assert(!(kstDay(Date.now() - 20 * DAY) in a.context._daily), '14일 지난 칸은 지운다');
  assert(!('junk' in a.context._daily), '날짜가 아닌 칸은 버린다');
  assert.strictEqual(a.context._dailyFrom, old._dailyFrom, '집계 시작 시각은 처음 값 유지');
  rc = EL.recentCounts(a);
  assert.deepStrictEqual([rc.recent_7d_count, rc.recent_7d_complete], [4, true], '506 이 아니라 최근 7일 4회 ' + JSON.stringify(rc));
  n++; console.log('PASS 누적 506 · 최근 7일 4회(8일 전 50회는 창 밖)');

  // 3) 이 기능 이전부터 있던 행(_daily 없음) — 최근에 났으면 "모름"(null), 다음 발생부터 세되 미완전 표시
  await EL.logAbnormal({ flow: 'admin', error: new Error('legacy B') });
  let b = await row('legacy B');
  await db.query(`UPDATE error_logs SET occurrence_count = 331, first_seen_at = NOW() - interval '90 days', context = '{"path":"/x"}'::jsonb WHERE id = $1`, [b.id]);
  b = await row('legacy B');
  rc = EL.recentCounts(b);
  assert.strictEqual(rc.recent_7d_count, null, '집계 전 기록은 0 으로 꾸미지 않는다');
  assert.strictEqual(rc.recent_7d_complete, false);
  await EL.logAbnormal({ flow: 'admin', error: new Error('legacy B') });
  b = await row('legacy B');
  rc = EL.recentCounts(b);
  assert.deepStrictEqual([rc.recent_7d_count, rc.recent_7d_complete], [1, false], '집계 시작 뒤 1회 · 그 전 분은 모름');
  assert(rc.recent_counts_since, '언제부터 셌는지 알려준다');
  n++; console.log('PASS 집계 이전 행: 모름(null) → 시작 후 1회(미완전 표시)');

  // 4) 마지막 발생이 7일 창보다 전이면 집계 여부와 무관하게 최근 7일 0(확실)
  await db.query(`UPDATE error_logs SET last_seen_at = NOW() - interval '10 days', context = '{}'::jsonb WHERE id = $1`, [b.id]);
  b = await row('legacy B');
  rc = EL.recentCounts(b);
  assert.deepStrictEqual([rc.recent_7d_count, rc.recent_7d_complete], [0, true]);
  n++; console.log('PASS 10일 전이 마지막 → 최근 7일 0(확실)');

  // 5) 옛 서버가 0.5초 전에 만든 행(_daily 없음)에 새 서버가 처음 기록 — '완전'으로 오판하지 않는다(Codex P2)
  await EL.logAbnormal({ flow: 'admin', error: new Error('legacy C') });
  let c = await row('legacy C');
  await db.query(`UPDATE error_logs SET occurrence_count = 1, first_seen_at = NOW() - interval '500 milliseconds', context = '{}'::jsonb WHERE id = $1`, [c.id]);
  await EL.logAbnormal({ flow: 'admin', error: new Error('legacy C') });
  c = await row('legacy C');
  rc = EL.recentCounts(c);
  assert.deepStrictEqual([c.occurrence_count, rc.recent_7d_count, rc.recent_7d_complete], [2, 1, false], '직전 옛 기록 1회가 빠졌으니 미완전 ' + JSON.stringify(rc));
  await db.query(`DELETE FROM error_logs WHERE id = $1`, [c.id]);   // 아래 목록 행 수 단언과 분리
  n++; console.log('PASS 직전 옛 행 → 미완전(유예 없음)');

  // 5) 조회 응답(목록·상세 — Track B 프록시가 위임하는 원본 핸들러)에 필드가 실린다
  const admin = require('../src/routes/admin.routes');
  const call = (name, query) => new Promise((resolve, reject) => {
    admin.handlers[name]({ query, admin: { name: 't' } }, { json: resolve, status() { return this; } }, reject);
  });
  const list = await call('errorLogsList', { status: 'all' });
  assert(list.ok && list.logs.length === 2, '목록 2행');
  for (const l of list.logs) {
    assert(Object.prototype.hasOwnProperty.call(l, 'recent_7d_count'), '목록 행에 recent_7d_count');
    assert(Object.prototype.hasOwnProperty.call(l, 'recent_7d_complete'), '목록 행에 recent_7d_complete');
  }
  assert.strictEqual(list.logs.find((l) => l.id === a.id).recent_7d_count, 4);
  const det = await call('errorLogDetail', { id: String(a.id) });
  assert.strictEqual(det.log.recent_7d_count, 4, '상세에도');
  n++; console.log('PASS 목록·상세 응답에 최근 7일 횟수');

  console.log(`✅ errorLogRecentCounts: ${n} cases passed`);
  await db.close();
  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
