/**
 * smartBuild pause/killswitch 회귀 가드 (적대검증 RED-1 끈채방치 / RED-2 재배포부활 방어).
 *   - pauseSmartBuild: paused 상태 + 영속 upsert + 자동재개 시각.
 *   - getSmartBuildStatus: paused/pausedMinutesLeft/staleWarning 정확.
 *   - _tickSmartBuild: pause 중이면 runSmartBuild 미호출(빌드 쿼리 0).
 *   - _loadPersistedPause: 미래=복원, 과거/공란=null(만료 pause 부팅복원 안 함).
 *   - resumeSmartBuild: 해제 + 영속 공란.
 * 실행: node tests/smartBuildPause.test.js
 */
const assert = require('assert');

// pool 모킹(쿼리 기록). smartBuild가 top-level require('../db/pool')로 잡으므로 require 전에 주입.
const _queries = [];
let _pausedValueInDb = ''; // _loadPersistedPause가 읽을 값
function mockModule(relId, exportsObj) {
  const resolved = require.resolve(relId);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
mockModule('../src/db/pool', {
  query: async (sql, params) => {
    _queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (/SELECT value FROM app_settings WHERE key = 'smart_build_paused_until'/.test(sql)) {
      return { rows: _pausedValueInDb ? [{ value: _pausedValueInDb }] : [] };
    }
    return { rows: [], rowCount: 0 };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
});

const sb = require('../src/services/smartBuild.service');

function buildQueryCount() {
  // runSmartBuild가 실행되면 campaigns/tab_configs 조회가 발생 — pause tick은 이게 0이어야 함.
  return _queries.filter(q => /FROM campaigns|FROM tab_configs/i.test(q.sql)).length;
}

async function run() {
  // 스케줄러 기동(interval 세팅 → staleReason이 paused/null로 갈림). _pausedValueInDb='' 라 복원 없음.
  await sb.startSmartBuild();

  // ── pause(30분) → 상태·영속·자동재개 ──
  const out = await sb.pauseSmartBuild(30);
  assert.equal(out.paused, true);
  assert.equal(out.autoResumeMinutes, 30);
  let st = sb.getSmartBuildStatus();
  assert.equal(st.paused, true, 'paused=true');
  assert.ok(st.pausedMinutesLeft >= 29 && st.pausedMinutesLeft <= 30, 'pausedMinutesLeft≈30');
  assert.equal(st.staleWarning, true, 'staleWarning=true(pause)');
  assert.equal(st.staleReason, 'paused');
  const upsert = _queries.find(q => /INSERT INTO app_settings/.test(q.sql) && /smart_build_paused_until/.test(q.sql));
  assert.ok(upsert, 'pause 영속 upsert 발생');
  console.log('  pause 상태·영속·자동재개 통과');

  // ── pause 중 _tickSmartBuild → runSmartBuild 미호출(빌드 쿼리 0) ──
  const before = buildQueryCount();
  sb._tickSmartBuild();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(buildQueryCount(), before, 'pause 중 tick은 빌드 실행 안 함');
  console.log('  pause 중 tick 스킵 통과');

  // ── resume → 해제 + 영속 공란 ──
  const r = await sb.resumeSmartBuild();
  assert.equal(r.paused, false);
  st = sb.getSmartBuildStatus();
  assert.equal(st.paused, false, 'resume 후 paused=false');
  const clearUpsert = _queries.filter(q => /INSERT INTO app_settings/.test(q.sql)).pop();
  assert.equal(clearUpsert.params[0], '', 'resume는 영속값 공란');
  console.log('  resume 해제 통과');

  // ── _loadPersistedPause: 과거=null, 미래=복원 ──
  _pausedValueInDb = new Date(Date.now() - 60000).toISOString(); // 과거
  assert.equal(await sb._loadPersistedPause(), null, '만료 pause는 부팅복원 안 함(RED-1 자동재개 일관)');
  _pausedValueInDb = new Date(Date.now() + 30 * 60000).toISOString(); // 미래
  const restored = await sb._loadPersistedPause();
  assert.ok(restored && restored.getTime() > Date.now(), '미래 pause는 부팅복원(RED-2)');
  _pausedValueInDb = '';
  assert.equal(await sb._loadPersistedPause(), null, '공란=null');
  console.log('  부팅복원 만료판정 통과');

  sb.stopSmartBuild(); // interval 정리(프로세스 종료)
}

run().then(() => { console.log('smartBuildPause tests passed'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
