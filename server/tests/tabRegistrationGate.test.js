/**
 * tabRegistrationGate — 작업탭 등록 단일경로(작업오더 접수) 회귀 가드
 *   ① TAB_REGISTRATION_MODE 헬퍼: 기본 'order'(자동·수동 차단), 'manual'(수동만), 'auto'(전부 허용)
 *   ② smartBuild: 미등록 탭(이름·gid 불일치)은 읽기/빌드/등록 제외 + tabsSkippedUnregistered 계수,
 *      등록 탭 이름 일치·gid 일치(리네임)는 빌드 유지
 *   ③ indexBuilder(buildOneSheet): 동일 게이트 — 미등록 탭은 batchGet 범위에서 제외
 *   ④ syncTabListToDB: 게이트 모드에서 신규 campaigns/tabs/index INSERT 미실행 + registrationGate 보고,
 *      기존 탭 gid 보정·리네임 UPDATE는 유지, allowNewTabs:true(DB 재구축)면 INSERT 실행,
 *      'manual' 모드도 자동 신규추가는 여전히 차단('auto'만 허용)
 * 실행: node tests/tabRegistrationGate.test.js
 */
const assert = require('assert');

process.env.MASTER_SHEET_ID = 'MASTER1';
delete process.env.TAB_REGISTRATION_MODE;

function mockModule(relId, exportsObj) {
  const resolved = require.resolve(relId);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── 상태 주입 변수 ──
let _persistedCacheJson = '';
const _mockMT = {};                // sheetId → modifiedTime
let _sheetIdRows = [];             // campaigns∪tab_configs 시트 목록 (smartBuild)
let _tcRowsAll = [];               // tab_configs 전체 rows (smartBuild·indexScan·buildOneSheet 공용)
let _imRows = [];                  // index_master rows (indexScan diff용)
let _campRows = [];                // campaigns rows (indexScan diff용)
let _metaBySheet = {};             // sheetId → meta 배열
let _tabListValues = [];           // '탭목록' 시트 값
const _batchCalls = [];            // batchReadSheet 호출 캡처 {sid, ranges}
const _writes = [];                // pool/client 쓰기 쿼리 캡처 {sql, params}

function _capture(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (/^(INSERT|UPDATE|DELETE)/i.test(s)) _writes.push({ sql: s, params: params || [] });
}
function _wrote(re) { return _writes.some(w => re.test(w.sql)); }

async function _dispatchQuery(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  _capture(s, params);
  if (/SELECT value FROM app_settings WHERE key = 'smart_build_paused_until'/.test(s)) return { rows: [] };
  if (/SELECT value FROM app_settings WHERE key = 'smart_build_modified_cache'/.test(s)) {
    return { rows: _persistedCacheJson ? [{ value: _persistedCacheJson }] : [] };
  }
  if (/SELECT DISTINCT sheet_id FROM campaigns/.test(s)) return { rows: _sheetIdRows };
  // smartBuild: 마감+등록 탭 로드 (신규 쿼리)
  if (/SELECT sheet_id, tab_name, tab_gid, is_closed FROM tab_configs$/.test(s)) return { rows: _tcRowsAll };
  // buildOneSheet: 시트 한정 tab_configs
  if (/SELECT sheet_id, tab_name, tab_gid, is_closed FROM tab_configs WHERE sheet_id/.test(s)) {
    return { rows: _tcRowsAll.filter(r => r.sheet_id === params[0]) };
  }
  // indexScan diff용
  if (/SELECT sheet_id, campaign_name FROM campaigns$/.test(s)) return { rows: _campRows };
  if (/SELECT sheet_id, tab_name, tab_gid FROM tab_configs$/.test(s)) return { rows: _tcRowsAll };
  if (/SELECT sheet_id, tab_name, tab_gid FROM index_master$/.test(s)) return { rows: _imRows };
  return { rows: [], rowCount: 0 };
}

mockModule('../src/db/pool', {
  query: _dispatchQuery,
  connect: async () => ({ query: _dispatchQuery, release() {} }),
});
mockModule('../src/services/sheets.service', {
  readSheet: async (sid, range) => {
    if (String(range).startsWith("'탭목록'")) return _tabListValues;
    if (String(range).startsWith("'시트DB'")) return [['sheet_url', 'campaign_name']];
    return [];
  },
  writeSheet: async () => {},
  batchReadSheet: async (sid, ranges) => {
    _batchCalls.push({ sid, ranges: [...ranges] });
    return ranges.map(() => ({ values: [] }));
  },
  getSpreadsheetMeta: async (sid) => {
    if (sid === 'MASTER1') {
      const m = [
        { properties: { title: '탭목록', sheetId: 1 } },
        { properties: { title: '시트DB', sheetId: 2 } },
      ];
      m._spreadsheetTitle = '마스터';
      return m;
    }
    return _metaBySheet[sid] || [];
  },
  getSheetModifiedTime: async (sid) => _mockMT[sid],
  shareSheetWithServiceAccount: async () => ({ alreadyShared: true }),
});
mockModule('../src/utils/sheetsThrottle', {
  throttledCall: (fn) => fn(),
  driveThrottledCall: (fn) => fn(),
  concurrentMap: async (items, fn) => Promise.all(items.map((it, i) => fn(it, i))),
  throttledMap: async (items, fn) => Promise.all(items.map((it, i) => fn(it, i))),
  getThrottleStatus: () => ({ requestsInLastMinute: 0 }),
});
mockModule('../src/utils/sse', {
  emitIndexBuild() {}, broadcast() {}, addClient() {}, getStatus() { return {}; },
  emitImageExtract() {}, emitImageUpload() {},
});
mockModule('../src/services/reviewFolders.service', {
  ensureReviewFoldersForActiveTabs: async () => ({}),
});

const reg = require('../src/utils/tabRegistration');
const sb = require('../src/services/smartBuild.service');
const ib = require('../src/services/indexBuilder.service');
const { syncTabListToDB } = require('../src/services/indexScan.service');

function _tab(title, gid) { return { properties: { title, sheetId: gid } }; }

async function run() {
  // ══ ① 모드 헬퍼 ══
  delete process.env.TAB_REGISTRATION_MODE;
  assert.equal(reg.getTabRegistrationMode(), 'order', '미설정 → order');
  assert.equal(reg.allowAutoRegister(), false);
  assert.equal(reg.allowManualRegister(), false);
  process.env.TAB_REGISTRATION_MODE = 'manual';
  assert.equal(reg.allowAutoRegister(), false, 'manual: 자동 신규추가는 여전히 차단');
  assert.equal(reg.allowManualRegister(), true, 'manual: 수동 등록 허용');
  process.env.TAB_REGISTRATION_MODE = 'auto';
  assert.equal(reg.allowAutoRegister(), true);
  assert.equal(reg.allowManualRegister(), true);
  process.env.TAB_REGISTRATION_MODE = 'weird';
  assert.equal(reg.getTabRegistrationMode(), 'order', '오타 → order(fail-closed)');
  delete process.env.TAB_REGISTRATION_MODE;
  console.log('  ① 모드 헬퍼 통과');

  // ══ ② smartBuild 게이트 ══
  _sheetIdRows = [{ sheet_id: 'S1' }];
  _tcRowsAll = [{ sheet_id: 'S1', tab_name: 'RegTab', tab_gid: '100', is_closed: false }];
  _metaBySheet.S1 = Object.assign([_tab('RegTab', 100), _tab('NewTab', 999)], { _spreadsheetTitle: '캠페인A' });
  _persistedCacheJson = '';
  _mockMT.S1 = 'T1';
  _batchCalls.length = 0; _writes.length = 0;

  const b1 = await sb.runSmartBuild();
  assert.equal(b1.ok, true);
  assert.equal(b1.tabsSkippedUnregistered, 1, '미등록 NewTab 1개 제외 계수');
  assert.equal(_batchCalls.length, 1, 'S1 batchGet 1회');
  assert.deepEqual(_batchCalls[0].ranges, ["'RegTab'!A:Z"], '등록 탭만 읽음(미등록 NewTab 제외)');
  assert.ok(!_writes.some(w => /INSERT INTO tab_configs/.test(w.sql) && String(w.params[1]) === 'NewTab'),
    '미등록 NewTab의 tab_configs INSERT 없음');
  console.log('  ② smartBuild: 미등록 탭 제외 통과');

  // gid 일치(리네임) 탭은 게이트 통과
  _metaBySheet.S1 = Object.assign([_tab('RenamedTab', 100), _tab('NewTab', 999)], { _spreadsheetTitle: '캠페인A' });
  _mockMT.S1 = 'T2';
  _batchCalls.length = 0;
  const b2 = await sb.runSmartBuild();
  assert.equal(b2.tabsSkippedUnregistered, 1, '미등록 NewTab만 제외');
  assert.deepEqual(_batchCalls[0].ranges, ["'RenamedTab'!A:Z"], 'gid 일치(리네임 탭)는 빌드 유지');
  console.log('  ② smartBuild: gid 리네임 통과');

  // auto 모드 → 레거시 전체 허용(미등록 탭도 빌드 대상)
  process.env.TAB_REGISTRATION_MODE = 'auto';
  _metaBySheet.S1 = Object.assign([_tab('RegTab', 100), _tab('NewTab', 999)], { _spreadsheetTitle: '캠페인A' });
  _mockMT.S1 = 'T3';
  _batchCalls.length = 0;
  const b3 = await sb.runSmartBuild();
  assert.equal(b3.tabsSkippedUnregistered, 0, 'auto: 게이트 비활성');
  assert.deepEqual(_batchCalls[0].ranges, ["'RegTab'!A:Z", "'NewTab'!A:Z"], 'auto: 미등록 탭도 읽음(현행 유지)');
  delete process.env.TAB_REGISTRATION_MODE;
  console.log('  ② smartBuild: auto 롤백 모드 통과');

  // ══ ③ indexBuilder(buildOneSheet) 게이트 ══
  _tcRowsAll = [{ sheet_id: 'S2', tab_name: 'RegTab2', tab_gid: '300', is_closed: false }];
  _metaBySheet.S2 = Object.assign([_tab('RegTab2', 300), _tab('Stray', 301)], { _spreadsheetTitle: '캠페인B' });
  _batchCalls.length = 0;
  const r1 = await ib.buildOneSheet('S2');
  assert.equal(r1.ok, true);
  assert.equal(_batchCalls.length, 1);
  assert.deepEqual(_batchCalls[0].ranges, ["'RegTab2'!A:Z"], '전체빌드도 등록 탭만 읽음');
  // gid 리네임 통과
  _metaBySheet.S2 = Object.assign([_tab('RegTab2New', 300), _tab('Stray', 301)], { _spreadsheetTitle: '캠페인B' });
  _batchCalls.length = 0;
  await ib.buildOneSheet('S2');
  assert.deepEqual(_batchCalls[0].ranges, ["'RegTab2New'!A:Z"], '전체빌드 gid 리네임 유지');
  console.log('  ③ indexBuilder 게이트 통과');

  // ══ ④ syncTabListToDB 게이트 ══
  const SHEET_URL = 'https://docs.google.com/spreadsheets/d/SHEET1/edit';
  _tabListValues = [
    ['sheet_url', 'campaign_name', 'tab_url', 'tab_name'],
    [SHEET_URL, '캠프A', `${SHEET_URL}#gid=111`, 'ExistTab'],
    [SHEET_URL, '캠프A', `${SHEET_URL}#gid=222`, 'BrandNewTab'],
  ];
  _campRows = [{ sheet_id: 'SHEET1', campaign_name: '캠프A' }];
  _tcRowsAll = [{ sheet_id: 'SHEET1', tab_name: 'ExistTab', tab_gid: '' }];
  _imRows = [{ sheet_id: 'SHEET1', tab_name: 'ExistTab', tab_gid: '111' }];

  // 게이트 ON(기본 order): 신규 INSERT 없음 + 기존 탭 gid 보정 유지
  _writes.length = 0;
  const s1 = await syncTabListToDB({ dryRun: false, fromCache: false });
  assert.equal(s1.registrationGate.active, true);
  assert.equal(s1.registrationGate.skippedNewTabs, 1, 'BrandNewTab 스킵');
  assert.equal(s1.registrationGate.skippedNewIndex, 1, '미등록 탭 index 껍데기 스킵');
  assert.equal(s1.tabs.toAdd, 0);
  assert.ok(!_wrote(/INSERT INTO tab_configs/), '게이트: tab_configs 신규 INSERT 없음');
  assert.ok(!_wrote(/INSERT INTO campaigns/), '게이트: campaigns 신규 INSERT 없음');
  assert.ok(!_wrote(/INSERT INTO index_master/), '게이트: 미등록 index_master 껍데기 없음');
  assert.ok(_wrote(/UPDATE tab_configs SET tab_gid/), '기존 탭 gid 보정은 유지');
  assert.ok(/작업오더 접수로만 등록/.test(s1.message), '메시지에 게이트 안내 포함');
  console.log('  ④ sync: 게이트 ON 신규 차단 통과');

  // manual 모드도 자동 신규추가는 차단('auto'만 허용)
  process.env.TAB_REGISTRATION_MODE = 'manual';
  _writes.length = 0;
  const s2 = await syncTabListToDB({ dryRun: false, fromCache: false });
  assert.equal(s2.registrationGate.active, true, 'manual 모드도 sync 자동추가는 차단');
  assert.ok(!_wrote(/INSERT INTO tab_configs/));
  delete process.env.TAB_REGISTRATION_MODE;
  console.log('  ④ sync: manual 모드 자동추가 차단 통과');

  // allowNewTabs:true (DB 재구축 재해복구 경로) → 신규 INSERT 실행
  _writes.length = 0;
  const s3 = await syncTabListToDB({ dryRun: false, fromCache: false, allowNewTabs: true });
  assert.equal(s3.registrationGate.active, false);
  assert.ok(_wrote(/INSERT INTO tab_configs/), 'allowNewTabs: BrandNewTab INSERT 실행');
  assert.ok(_wrote(/INSERT INTO index_master/), 'allowNewTabs: index 껍데기 생성');
  console.log('  ④ sync: allowNewTabs(DB 재구축) 예외 통과');

  // 게이트 ON에서도 gid 기반 리네임은 유지
  _tabListValues = [
    ['sheet_url', 'campaign_name', 'tab_url', 'tab_name'],
    [SHEET_URL, '캠프A', `${SHEET_URL}#gid=222`, 'NewNameTab'],
  ];
  _tcRowsAll = [{ sheet_id: 'SHEET1', tab_name: 'OldTab', tab_gid: '222' }];
  _imRows = [{ sheet_id: 'SHEET1', tab_name: 'OldTab', tab_gid: '222' }];
  _writes.length = 0;
  const s4 = await syncTabListToDB({ dryRun: false, fromCache: false });
  assert.equal(s4.tabs.toRename, 1, '리네임 감지');
  assert.ok(_wrote(/UPDATE tab_configs SET tab_name/), '게이트 ON에도 리네임 UPDATE 유지');
  assert.ok(_wrote(/UPDATE review_index SET tab_name/), 'review_index 리네임 보존');
  assert.ok(!_wrote(/INSERT INTO tab_configs/), '리네임은 INSERT 아님');
  console.log('  ④ sync: 게이트 ON 리네임 유지 통과');

  console.log('✅ tabRegistrationGate 전체 통과');
  process.exit(0);
}
run().catch(e => { console.error('❌ tabRegistrationGate 실패:', e); process.exit(1); });
