/**
 * smartBuildQuota — 정기 인덱스빌드의 시트 lane 사용량 감축 회귀 가드
 *   ① modifiedTime 캐시 영속 복원: 재배포 첫 주기에 "전 시트 변경 간주" 콜드스타트 스윕이 없어야 함.
 *   ② 시트 lane 중간 양보(SMARTBUILD_YIELD_THRESHOLD): 제출 버스트 중이면 변경 시트를 연기하고
 *      modifiedTime 캐시를 지워 다음 주기에 반드시 재감지(변경 유실 없음).
 *   ③ 사이클 말미 스냅샷 저장(app_settings 'smart_build_modified_cache').
 * 실행: node tests/smartBuildQuota.test.js
 */
const assert = require('assert');

function mockModule(relId, exportsObj) {
  const resolved = require.resolve(relId);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── 상태 주입 변수 ──
let _persistedCacheJson = '';   // app_settings smart_build_modified_cache 값
let _lastPersistedJson = null;  // 마지막 upsert된 값 캡처
let _mockUsage = 0;             // getThrottleStatus().requestsInLastMinute
const _mockMT = {};             // sheetId → modifiedTime
let _metaCalls = 0;             // getSpreadsheetMeta 호출 수(시트 lane 소모 대리 지표)
const _metaThrowFor = new Set(); // meta 조회를 실패시킬 sheetId (에러 경로 검증)

mockModule('../src/db/pool', {
  query: async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/SELECT value FROM app_settings WHERE key = 'smart_build_paused_until'/.test(s)) return { rows: [] };
    if (/SELECT value FROM app_settings WHERE key = 'smart_build_modified_cache'/.test(s)) {
      return { rows: _persistedCacheJson ? [{ value: _persistedCacheJson }] : [] };
    }
    if (/INSERT INTO app_settings \(key, value, updated_at\) VALUES \('smart_build_modified_cache'/.test(s)) {
      _lastPersistedJson = params[0];
      _persistedCacheJson = params[0];
      return { rows: [] };
    }
    // ★★ 스윕 제외 게이트(`sheetlessScope.SWEEP_SKIP_SHEET_IDS_SQL`)는 열거식을 서브쿼리로 **품고 있어**
    //   아래 열거 분기의 정규식에도 걸린다 → 더 좁은 이 분기를 먼저 둔다(레포 관용구: 스텁 분기는 좁은 것부터).
    //   빠뜨리면 게이트가 S1·S2 를 "제외 대상"으로 받아 변경 감지가 0 이 된다(실측).
    if (/BOOL_AND/.test(s)) return { rows: [] };
    if (/SELECT DISTINCT sheet_id FROM campaigns/.test(s)) return { rows: [{ sheet_id: 'S1' }, { sheet_id: 'S2' }] };
    return { rows: [], rowCount: 0 };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
});
mockModule('../src/services/indexBuilder.service', {
  acquireBuildLock: async () => ({ acquired: true }),
  releaseBuildLock: async () => {},
});
mockModule('../src/services/sheets.service', {
  readSheet: async () => [],
  batchReadSheet: async () => [],
  getSpreadsheetMeta: async (sid) => {
    _metaCalls++;
    if (_metaThrowFor.has(sid)) throw new Error('boom-meta');
    const a = []; a._spreadsheetTitle = ''; return a;
  },
  getSheetModifiedTime: async (sid) => _mockMT[sid],
  shareSheetWithServiceAccount: async () => ({ alreadyShared: true }),
});
mockModule('../src/utils/sheetsThrottle', {
  throttledCall: (fn) => fn(),
  driveThrottledCall: (fn) => fn(),
  getThrottleStatus: () => ({ requestsInLastMinute: _mockUsage }),
});
mockModule('../src/services/reviewFolders.service', {
  ensureReviewFoldersForActiveTabs: async () => ({}),
});

const sb = require('../src/services/smartBuild.service');

async function run() {
  // ── ① 콜드스타트 스윕 제거: 영속 캐시 복원 → 무변경이면 sheetsChanged=0, 시트 읽기 0 ──
  _persistedCacheJson = JSON.stringify({ S1: 'T1', S2: 'T1' });
  _mockMT.S1 = 'T1'; _mockMT.S2 = 'T1';
  _mockUsage = 0; _metaCalls = 0;
  const r1 = await sb.runSmartBuild();
  assert.equal(r1.ok, true);
  assert.equal(r1.isFirstRun, true, '첫 실행');
  assert.equal(r1.sheetsChanged, 0, '영속 캐시 복원 → 재배포 첫 주기 전체 스윕 없음');
  assert.equal(_metaCalls, 0, '시트 lane meta 읽기 0');
  console.log('  ① 콜드스타트 스윕 제거 통과');

  // ── ② 시트 lane 양보: 버스트 중이면 변경 시트 연기 + 캐시 삭제(다음 주기 재감지) ──
  _mockMT.S1 = 'T2'; _mockMT.S2 = 'T2';
  _mockUsage = 99; _lastPersistedJson = null;
  const r2 = await sb.runSmartBuild();
  assert.equal(r2.sheetsChanged, 2, '변경 2시트 감지');
  assert.equal(r2.sheetsDeferred, 2, '버스트 중 → 2시트 모두 연기');
  assert.equal(_metaCalls, 0, '연기 시 시트 읽기 0(쿼터 미소모)');
  assert.ok(_lastPersistedJson !== null, '③ 사이클 말미 스냅샷 저장됨');
  const snap = JSON.parse(_lastPersistedJson);
  assert.ok(!('S1' in snap) && !('S2' in snap), '연기 시트는 스냅샷에서 제외(재감지 보장)');
  console.log('  ② 양보 연기 + ③ 스냅샷 저장 통과');

  // ── 연기분 재감지: 다음 주기에 변경 유실 없이 다시 잡힘 ──
  const r3 = await sb.runSmartBuild();
  assert.equal(r3.sheetsChanged, 2, '연기분이 다음 주기에 재감지(변경 유실 없음)');
  console.log('  연기분 재감지 통과');

  // ── 여유 시 정상 처리 경로: 양보 없이 시트 읽기 진행 ──
  _mockUsage = 0;
  const r4 = await sb.runSmartBuild();
  assert.equal(r4.sheetsDeferred, 0, '여유 시 연기 없음');
  assert.equal(_metaCalls, 2, '변경 2시트 meta 읽기 진행');
  console.log('  여유 시 정상 처리 통과');

  // ── noYield: 버스트 중에도 양보 없이 완주(관리자 강제실행/DB재구축 경로) ──
  _mockMT.S1 = 'T3'; _mockMT.S2 = 'T3';
  _mockUsage = 99; _metaCalls = 0;
  const r5 = await sb.runSmartBuild({ noYield: true });
  assert.equal(r5.sheetsChanged, 2);
  assert.equal(r5.sheetsDeferred, 0, 'noYield → 연기 없이 완주');
  assert.equal(_metaCalls, 2, 'noYield → 시트 읽기 진행');
  console.log('  noYield 완주 통과');

  // ── 에러 경로: 실패 시트는 캐시 무효화 → 스냅샷에 "반영됨" 오기록 없음 + 다음 주기 재시도 ──
  _mockMT.S1 = 'T4'; _mockMT.S2 = 'T4';
  _mockUsage = 0; _metaThrowFor.add('S1'); _lastPersistedJson = null;
  const r6 = await sb.runSmartBuild();
  assert.equal(r6.sheetsChanged, 2);
  assert.equal(r6.errors, 1, 'S1 meta 실패 1건');
  const snap6 = JSON.parse(_lastPersistedJson);
  assert.ok(!('S1' in snap6), '실패 시트는 스냅샷 제외(미반영 데이터를 반영됨으로 영속 금지)');
  assert.equal(snap6.S2, 'T4', '성공 시트는 정상 영속');
  const r7 = await sb.runSmartBuild();
  assert.equal(r7.sheetsChanged, 1, '실패 시트만 다음 주기 재감지(재시도)');
  console.log('  에러 경로 캐시 무효화 통과');

  // ── 연속 실패 상한: SHEET_ERR_RETRY_CYCLES(3) 초과 시 캐시 유지 → 재읽기 루프 중단 ──
  await sb.runSmartBuild(); // streak 3 (재시도 계속)
  await sb.runSmartBuild(); // streak 4 → 캐시 유지(T4)
  const r8 = await sb.runSmartBuild();
  assert.equal(r8.sheetsChanged, 0, '상한 초과 → 캐시 유지로 재읽기 루프 중단');
  _metaThrowFor.delete('S1');
  console.log('  연속 실패 상한 통과');

  // ── invalidateChecksumCache: 시트 단위 modifiedTime 캐시 무효화 → 미편집이어도 재감지 ──
  const n = sb.invalidateChecksumCache('S2', '아무탭');
  assert.ok(n >= 1, '시트 단위 캐시 무효화됨');
  const r9 = await sb.runSmartBuild();
  assert.ok(r9.sheetsChanged >= 1, '매핑 변경 시트가 미편집이어도 재감지(즉시 반영 의도)');
  console.log('  invalidateChecksumCache 재감지 통과');

  console.log('✅ smartBuildQuota 전체 통과');
  process.exit(0);
}
run().catch(e => { console.error('❌ smartBuildQuota 실패:', e); process.exit(1); });
