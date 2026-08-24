/**
 * 역동기화가 무시트 탭의 구글시트를 읽지 않는다 (2026-08-24).
 *
 * 배경(본섭 실측): 무시트 전환은 `last_sheet_write_sig` 를 **지우지 않는다** — 전환 전에 시트에
 *   써진 주문이라 표식이 그대로 남는다. 그런데 detect 의 탭 선정은 그 표식만 보므로, 전환이 끝난
 *   뒤에도 옛 구글시트를 계속 읽었다. 2026-08-24 기준:
 *     · 닫히지 않은 탭 113개가 **전부** 무시트(remaining=0)
 *     · 열린 edit 제안 108건이 **전원** 무시트 탭 소속(시트연결 탭 0건)
 *     · 크론 `1-59/3 * * * *` × 3탭 × 2콜 = 하루 약 2,880콜을 죽은 시트에 씀
 *   게다가 화면이 「원장을 시트값으로」를 권하면 **아무도 안 쓰는 시트값으로 원장을 덮게** 된다.
 *
 * 이 가드가 지키는 것 — 문자열이 아니라 **행동**이다. sheets.service 를 부르면 즉시 터지는
 * 스텁으로 갈아끼우고, 무시트 탭에서 정상 종료하면 한 번도 안 불렀다는 뜻이다(주장 아니라 증거).
 *
 *   §1 detect 단일 관문 — 무시트면 시트 호출 0
 *   §2 시트 기반 탭은 종전대로 읽는다(무회귀 — 영구 배제가 아니다)
 *   §3 크론 탭 선정에서 무시트 탭이 라운드로빈 자리를 먹지 않는다
 *   §4 자동적용 재검증도 무시트 탭은 읽지 않는다(이미 쌓인 제안 때문에 계속 나가던 콜)
 *   §5 판정은 sheetlessScope 단일 출처 · 조회 실패는 fail-open
 *
 * 실행: node tests/reverseSyncSheetlessSkip.test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const SRC = path.resolve(__dirname, '..', 'src');
function mock(id, exports) {
  const r = require.resolve(id);
  require.cache[r] = { id: r, filename: r, loaded: true, exports };
}

// ── 구글시트는 전부 폭발물 ───────────────────────────────────────
const sheetCalls = [];
const boom = name => (...a) => { sheetCalls.push(name); throw new Error('구글시트 호출됨: ' + name); };
mock(path.join(SRC, 'services/sheets.service'), {
  readSheet: boom('readSheet'), writeSheet: boom('writeSheet'),
  batchUpdateSheet: boom('batchUpdateSheet'), appendSheet: boom('appendSheet'),
  getSpreadsheetMeta: boom('getSpreadsheetMeta'), copySpreadsheet: boom('copySpreadsheet'),
  copySheetToSpreadsheet: boom('copySheetToSpreadsheet'), renameSheet: boom('renameSheet'),
  shareSheetWithServiceAccount: boom('shareSheetWithServiceAccount'),
  checkSheetWriteAccess: boom('checkSheetWriteAccess'),
  invalidateSheetMeta: () => {},
});
mock(path.join(SRC, 'utils/sheetsThrottle'), {
  throttledCall: async fn => fn(),
  getThrottleStatus: () => ({ requestsInLastMinute: 0, limit: 45 }),
});
mock(path.join(SRC, 'utils/jobLock'), { withJobLock: async (_k, fn) => fn() });

// ── 스텁 DB ─────────────────────────────────────────────────────
const SLESS   = { sheet_id: 'wt_sheetless',  tab_name: '무시트 작업 100건',   tab_gid: '' };
const SHEETED = { sheet_id: 'REAL_SHEET_ID', tab_name: '시트 기반 작업 50건',  tab_gid: '77' };
/* ⚠ #1143 배포 직후 실제로 새어 나간 두 갈래 — 허용목록에 들어가지 않는다. */
const CLOSED  = { sheet_id: 'REAL_SHEET_ID', tab_name: '마감된 작업 100건',    tab_gid: '88' }; // is_closed
const ORPHAN  = { sheet_id: 'REAL_SHEET_ID', tab_name: '아카이브된 작업 30건', tab_gid: '99' }; // tab_configs 행 없음
let sheetlessQueryFails = false;
const queries = [];

const pool = {
  query: async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    queries.push(q);
    // 허용목록: 무시트 아님 AND 마감 아님 인 **등록된** 탭만. 여기 없는 탭은 전부 감지 제외.
    if (/FROM tab_configs/.test(q) && /sheetless/.test(q) && /is_closed/.test(q)) {
      if (sheetlessQueryFails) throw new Error('42703 column does not exist');
      return { rows: [SHEETED] };
    }
    // 크론 탭 선정 — 무시트·마감·아카이브 탭이 **전부 따라 들어온다**(표식을 아무도 안 지우므로).
    if (/GROUP BY sheet_id, tab_name/.test(q)) {
      return { rows: [SLESS, CLOSED, ORPHAN, SHEETED].map(t => ({ sheet_id: t.sheet_id, tab_name: t.tab_name })) };
    }
    if (/FROM reverse_sync_proposals p/.test(q)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  },
  connect: async () => ({ query: pool.query, release: () => {} }),
};
mock(path.join(SRC, 'db/pool'), pool);

process.env.SHEET_REVERSE_SYNC = '1';
process.env.REVERSE_SYNC_AUTO = '1';
process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';

const OL = require(path.join(SRC, 'services/orderLedger.service'));
const SRC_TXT = fs.readFileSync(path.join(SRC, 'services/orderLedger.service.js'), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' -> ' + extra : '')); pass++; console.log('  ' + String.fromCharCode(10003) + ' ' + name); };

(async () => {
  console.log('\n' + String.fromCharCode(9654) + ' 역동기화 무시트 탭 제외\n');

  console.log('1) detect 단일 관문 — 허용목록 밖은 전부 건너뛴다');
  for (const [label, tab] of [['무시트 탭', SLESS], ['마감된 탭', CLOSED], ['tab_configs 행이 없는 탭', ORPHAN]]) {
    sheetCalls.length = 0;
    const r = await OL.detectReverseSyncProposals({ sheetId: tab.sheet_id, tabName: tab.tab_name });
    t(`${label}은 건너뛴다`, r && r.skipped === true && r.reason === 'tab_not_detectable', JSON.stringify(r));
    t(`${label} — 구글시트를 한 번도 부르지 않았다`, sheetCalls.length === 0, sheetCalls.join(','));
  }

  console.log('\n2) 시트 기반 탭은 종전대로 읽는다(영구 배제 아님)');
  /* ★ 여기서 readSheet 까지 도달시키려면 미러 메타(raw_sheet_tabs)까지 흉내내야 하는데, 그건 이
     가드의 관심사가 아니다. 지키려는 불변식은 **새 게이트가 시트 탭을 막지 않는다**이므로,
     시트 탭이 sheetless_tab 로 끊기지 않고 **그 다음 단계까지 갔다**는 것으로 고정한다.
     (다음 단계 = loadRawTabContext → 스텁엔 메타가 없으니 no_meta_or_gid 로 멈춘다.) */
  sheetCalls.length = 0;
  const r2 = await OL.detectReverseSyncProposals({ sheetId: SHEETED.sheet_id, tabName: SHEETED.tab_name });
  t('시트 기반 탭은 새 게이트에 막히지 않는다', r2 && r2.reason !== 'tab_not_detectable', JSON.stringify(r2));
  t('게이트 다음 단계까지 진행한다(탭 메타 조회)', r2 && r2.reason === 'no_meta_or_gid', JSON.stringify(r2));

  console.log('\n3) 크론 탭 선정');
  sheetCalls.length = 0;
  const cyc = await OL.runReverseSyncAutoCycle({ tabsPerCycle: 4 });
  t('★★ 무시트 + 마감 + 아카이브 세 갈래를 전부 라운드로빈에서 뺀다', cyc && cyc.skippedNotDetectable === 3, JSON.stringify(cyc));
  t('남은 시트 기반 탭만 대상이 된다', cyc && cyc.activeTabs === 1, JSON.stringify(cyc));
  t('건너뛴 수를 반환값에 실어 관측 가능하다(조용히 줄지 않게)',
    cyc && typeof cyc.skippedNotDetectable === 'number');

  console.log('\n4) 자동적용 재검증');
  t('감지 대상이 아닌 탭이면 재검증 읽기 전에 건너뛴다',
    /_skipDetectTab\(first\.sheet_id, first\.tab_name, first\.tab_gid\)\) \{ tabsSkipped\+\+; continue; \}/.test(SRC_TXT));
  t('건너뛰되 제안을 기각하지 않는다(사람이 화면에서 판단할 몫)', (() => {
    const i = SRC_TXT.indexOf('if (await _skipDetectTab(first.sheet_id');
    const line = SRC_TXT.slice(i, SRC_TXT.indexOf('\n', i));
    return !/dismiss/i.test(line);
  })());

  console.log('\n5) 판정 단일 출처 · fail-open');
  /* ★ 허용목록 SQL 자체를 고정한다 — 스텁은 SQL 을 해석하지 않으므로 위 §1~§3 만으로는
     "is_closed 조건이 빠져도" 초록이다(실제로 그래서 #1143 이 닫힌 탭을 놓쳤다). */
  const SCOPE_TXT = fs.readFileSync(path.join(SRC, 'utils/sheetlessScope.js'), 'utf8');
  const DETECTABLE = require(path.join(SRC, 'utils/sheetlessScope')).DETECTABLE_TABS_SQL;
  t('★★ 허용목록 SQL 이 무시트를 뺀다', /COALESCE\(sheetless, FALSE\) = FALSE/.test(DETECTABLE));
  t('★★ 허용목록 SQL 이 **마감 탭**도 뺀다(이번에 새어 나간 갈래)',
    /COALESCE\(is_closed, FALSE\) = FALSE/.test(DETECTABLE));
  t('★ 두 조건이 AND 로 묶인다(하나만 걸면 나머지가 샌다)', /= FALSE\s+AND\s+COALESCE\(is_closed/.test(DETECTABLE));
  t('★ tab_configs 에서만 고른다 = 행이 없는 아카이브 탭은 애초에 허용목록에 못 들어온다',
    /FROM tab_configs/.test(DETECTABLE));
  t('★ 조회 실패는 빈 Set 이 아니라 null 을 돌려준다(빈 Set 이면 전부 차단된다)',
    /return null;\s*\/\/ .*빈 Set 이 아니라 null/.test(SCOPE_TXT));

  t('판정을 utils/sheetlessScope 에 위임한다(키워드 사본 0)',
    /require\('\.\.\/utils\/sheetlessScope'\)\.detectableTabKeys/.test(SRC_TXT)
    && /hasTabKey/.test(SRC_TXT)
    && !/COALESCE\(sheetless, FALSE\)/.test(SRC_TXT));
  /* ★★ 허용목록은 실패하면 **전부 차단**이 되기 쉽다 — 그러면 게이트 고장이 곧 기능 정지다.
     조회 실패는 null 로 받아 "게이트 없음"으로 처리해야 한다. 무시트 탭조차 종전대로 감지되는지 본다. */
  sheetlessQueryFails = true;
  OL._resetSheetlessCacheForTest();
  const r5 = await OL.detectReverseSyncProposals({ sheetId: SLESS.sheet_id, tabName: SLESS.tab_name });
  t('★★ 허용목록 조회가 실패하면 전부 차단하지 않고 종전대로 감지한다(fail-open)',
    r5 && r5.reason !== 'tab_not_detectable', JSON.stringify(r5));
  OL._resetSheetlessCacheForTest();
  const cyc2 = await OL.runReverseSyncAutoCycle({ tabsPerCycle: 4 });
  t('★ 크론도 마찬가지 — 목록을 못 얻으면 아무 탭도 빼지 않는다', cyc2 && cyc2.skippedNotDetectable === 0, JSON.stringify(cyc2));
  sheetlessQueryFails = false; OL._resetSheetlessCacheForTest();

  console.log('\n' + String.fromCharCode(9654) + ' ' + pass + '건 통과');
  console.log('reverseSyncSheetlessSkip tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
