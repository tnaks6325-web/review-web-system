/* 읽는 시트 진단(2026-08-19) 회귀가드.
 *   실행: node server/tests/sheetReadScope.test.js
 *
 * 이 진단의 값어치는 **스윕과 같은 것을 본다**는 것 하나다. 열거식이나 게이트 사본이 생기면
 * 진단이 "안 읽는다"고 말하는 시트를 스윕은 계속 읽는 상태가 된다(관측이 거짓말이 되는 자리).
 * 그래서 여기서는 ① 사본 부재 ② 스텁 pool 로 **실제 실행**해 사유 분류 ③ 읽기 전용을 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); fail++; }
}

const SRC = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const scopeSrc = SRC('src/utils/sheetlessScope.js');
const rawSrc = SRC('src/services/rawMirror.service.js');
const sbSrc = SRC('src/services/smartBuild.service.js');
const svcSrc = SRC('src/services/sheetReadScope.service.js');
const routeSrc = SRC('src/routes/trackB.routes.js');
const FE = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

console.log('\n[1] 열거식 단일 출처 — 사본 금지');
t('1a sheetlessScope 가 열거식을 소유한다', () => {
  assert.ok(/REGISTERED_SHEET_IDS_SQL\s*=\s*\n?\s*'SELECT DISTINCT sheet_id FROM campaigns UNION SELECT DISTINCT sheet_id FROM tab_configs'/.test(scopeSrc),
    '열거식 상수가 없다');
  assert.ok(/REGISTERED_SHEET_IDS_SQL,/.test(scopeSrc.slice(scopeSrc.indexOf('module.exports'))), 'export 되지 않았다');
});
t('1b ★ 스윕 3곳이 그 상수를 쓴다(인라인 문자열 사본 0)', () => {
  for (const [n, src] of [['RAW미러', rawSrc], ['스마트빌드', sbSrc], ['진단', svcSrc]]) {
    assert.ok(/REGISTERED_SHEET_IDS_SQL/.test(src), n + ' 이 상수를 안 쓴다');
    assert.ok(!/SELECT DISTINCT sheet_id FROM campaigns UNION/.test(src),
      '★ ' + n + ' 에 열거식 사본이 되살아났다(진단과 스윕이 다른 시트를 보게 된다)');
  }
});
t('1c ★ 제외 게이트도 사본 없이 같은 함수', () => {
  assert.ok(/fullySheetlessSheetIds/.test(svcSrc), '진단이 게이트 함수를 안 쓴다');
  // ★ 주석의 설명(BOOL_AND 가 깨진다)은 사본이 아니다 — SQL 절(HAVING)로 판정한다.
  assert.ok(!/HAVING\s+BOOL_AND/i.test(svcSrc), '★ 진단에 게이트 SQL 사본이 생겼다');
});

console.log('\n[2] 읽기 전용');
t('2a 쓰기 쿼리 0 · 시트/Drive API 0', () => {
  assert.ok(!/\b(INSERT|UPDATE|\bDELETE\s+FROM\b|ALTER|DROP)\b/i.test(svcSrc), '★ 진단이 쓰기를 한다');
  assert.ok(!/sheets\.spreadsheets|googleapis|ThrottledCall|batchReadSheet|writeSheet\(/.test(svcSrc),
    '★ 진단이 구글 API 를 부른다(끄기 판단용 화면이 쿼터를 먹으면 안 된다)');
});

console.log('\n[3] 사유 분류 — 스텁 pool 로 실제 실행');
function withStub(rows, run) {
  const poolPath = require.resolve('../src/db/pool');
  const orig = require.cache[poolPath];
  const stub = { query: async (sql) => {
    if (/UNION SELECT DISTINCT sheet_id FROM tab_configs/.test(sql)) return { rows: rows.sheets };
    if (/HAVING BOOL_AND/.test(sql)) return { rows: rows.fully };
    if (/FILTER \(WHERE COALESCE\(sheetless, FALSE\)\)/.test(sql)) return { rows: rows.tc };
    if (/ORDER BY sheet_id, tab_name/.test(sql)) return { rows: rows.names || [] };
    if (/FROM order_submissions/.test(sql)) return { rows: rows.pend || [] };
    if (/FROM raw_sheet_tabs/.test(sql)) return { rows: rows.mir || [] };
    throw new Error('예상 못한 쿼리: ' + sql.slice(0, 60));
  } };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => stub, pool: stub } };
  delete require.cache[require.resolve('../src/services/sheetReadScope.service')];
  delete require.cache[require.resolve('../src/utils/sheetlessScope')];
  const svc = require('../src/services/sheetReadScope.service');
  return Promise.resolve(run(svc)).finally(() => {
    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
    delete require.cache[require.resolve('../src/services/sheetReadScope.service')];
  });
}

const FIXTURE = {
  //  S1: 시트 기반 활성 탭 있음 / S2: 마감 탭만 / S3: campaigns 만(아카이브로 tab_configs 삭제) / S4: 전부 무시트(제외)
  sheets: [{ sheet_id: 'S1' }, { sheet_id: 'S2' }, { sheet_id: 'S3' }, { sheet_id: 'S4' }],
  fully: [{ sheet_id: 'S4' }],
  tc: [
    { sheetId: 'S1', tabs: 3, sheetlessTabs: 2, liveSheetTabs: 1, closedSheetTabs: 0 },
    { sheetId: 'S2', tabs: 2, sheetlessTabs: 1, liveSheetTabs: 0, closedSheetTabs: 1 },
  ],
  names: [{ sheetId: 'S1', tabName: 'T1', displayName: '0801 살아있는작업' }],
  pend: [{ sheetId: 'S1', n: 4 }],
  mir: [{ sheetId: 'S1', mirroredAt: '2026-08-19T10:00:00Z' }],
};

let R = null;
(async () => {
  await withStub(FIXTURE, async svc => { R = await svc.readScope(); });

  t('3a 무시트로 전부 덮인 시트는 목록에서 빠진다', () => {
    assert.strictEqual(R.registered, 4);
    assert.strictEqual(R.excludedSheetless, 1);
    assert.strictEqual(R.reading, 3);
    assert.ok(!R.items.some(i => i.sheetId === 'S4'), 'S4 가 남았다');
  });
  t('3b ★ 마감 탭만 남은 시트도 "읽는 시트"로 잡힌다(BOOL_AND 가 깨진다)', () => {
    const s2 = R.items.find(i => i.sheetId === 'S2');
    assert.ok(s2, 'S2 가 목록에 없다');
    assert.strictEqual(s2.reason, 'closed_only');
  });
  t('3c ★ 등록 탭이 없고 campaigns 행만 남은 시트도 잡힌다(아카이브 잔존)', () => {
    const s3 = R.items.find(i => i.sheetId === 'S3');
    assert.ok(s3, 'S3 가 목록에 없다');
    assert.strictEqual(s3.reason, 'campaigns_only');
    assert.strictEqual(s3.tabs, 0);
  });
  t('3d 살아 있는 시트 작업은 사유·이름·미반영 주문을 함께 말한다', () => {
    const s1 = R.items.find(i => i.sheetId === 'S1');
    assert.strictEqual(s1.reason, 'sheet_tab_live');
    assert.deepStrictEqual(s1.liveTabNames, ['0801 살아있는작업']);
    assert.strictEqual(s1.pendingOrders, 4);
    assert.strictEqual(R.pendingOrdersTotal, 4);
  });
  t('3e 조치가 필요한 순서로 정렬한다(살아있음 → 마감만 → campaigns만)', () => {
    assert.deepStrictEqual(R.items.map(i => i.reason), ['sheet_tab_live', 'closed_only', 'campaigns_only']);
  });
  t('3f 사유 문구는 서버 한 곳(REASONS)에서 나온다', () => {
    assert.ok(R.reasons && R.reasons.closed_only && R.items.every(i => i.reasonText),
      '사유 문구가 응답에 실리지 않는다(화면이 사본을 만들게 된다)');
  });

  await withStub({ sheets: [{ sheet_id: 'S4' }], fully: [{ sheet_id: 'S4' }], tc: [] }, async svc => {
    const r = await svc.readScope();
    t('3g 읽는 시트가 0이면 0으로 말한다(빈 목록을 실패로 위장하지 않는다)', () => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.reading, 0);
      assert.strictEqual(r.excludedSheetless, 1);
    });
  });

  console.log('\n[4] 라우터 — 스택 실검사');
  t('4a GET /sheetless/read-scope 가 adminOrMaster 로 등록돼 있다', () => {
    assert.ok(/router\.get\('\/sheetless\/read-scope', authMiddleware, adminOrMasterMiddleware/.test(routeSrc),
      '라우트 등록·게이트가 다르다');
    assert.ok(/not_ready/.test(routeSrc.slice(routeSrc.indexOf("'/sheetless/read-scope'"), routeSrc.indexOf("'/sheetless/read-scope'") + 900)),
      '42P01/42703 을 사유로 말하지 않는다(500 마스킹에 묻힌다)');
  });

  console.log('\n[5] 화면 배선');
  t('5a 버튼·박스·렌더러가 있고 조작 버튼이 없다(읽기 전용)', () => {
    assert.ok(/onclick="_rsScan\(\)"/.test(FE), '버튼 배선이 없다');
    assert.ok(/id="rsBox"/.test(FE), '박스가 없다');
    const blk = FE.slice(FE.indexOf('function _rsRender'), FE.indexOf('function _ptBox'));
    assert.ok(blk.length > 200, '렌더러 블록을 잘못 잘랐다');
    assert.ok(!/api\('\/api\/trackb\/[^']*',\s*\{/.test(blk), '★ 진단 화면에 쓰기 호출이 생겼다');
  });
  t('5b ★ 실패해도 화면을 종결시킨다(무한 로딩 금지)', () => {
    const blk = FE.slice(FE.indexOf('async function _rsScan'), FE.indexOf('function _rsRender'));
    assert.ok(/catch\s*\(e\)/.test(blk) && /다시 시도/.test(blk), '실패 경로가 화면을 끝내지 않는다');
  });
  t('5c ★ 사유 문구를 화면에서 다시 만들지 않는다(서버 reasons 를 그린다)', () => {
    const blk = FE.slice(FE.indexOf('function _rsRender'), FE.indexOf('function _ptBox'));
    assert.ok(/r\.reasons/.test(blk), '서버 사유 표를 안 쓴다');
    assert.ok(!/마감 탭만 남았는데/.test(blk), '★ 화면에 사유 문구 사본이 생겼다');
  });
  t('5d 시트 문자열을 onclick 에 보간하지 않는다', () => {
    const blk = FE.slice(FE.indexOf('function _rsRender'), FE.indexOf('function _ptBox'));
    assert.ok(!/onclick="[^"]*\$\{(?!esc)/.test(blk.replace(/onclick="_rs[A-Za-z]*\(\)"/g, '')),
      '★ onclick 에 외부 문자열이 들어간다');
  });

  console.log(`\n${fail ? '❌' : '✅'} sheetReadScope: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
