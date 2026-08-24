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
const SLESS = { sheet_id: 'wt_sheetless', tab_name: '무시트 작업 100건', tab_gid: '' };
const SHEETED = { sheet_id: 'REAL_SHEET_ID', tab_name: '시트 기반 작업 50건', tab_gid: '77' };
let sheetlessQueryFails = false;
const queries = [];

const pool = {
  query: async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    queries.push(q);
    if (/FROM tab_configs/.test(q) && /sheetless/.test(q) && /tab_name/.test(q)) {
      if (sheetlessQueryFails) throw new Error('42703 column does not exist');
      return { rows: [SLESS] };
    }
    // 크론 탭 선정 — 무시트 탭과 시트 탭이 **둘 다** 나온다(전환이 표식을 안 지우므로).
    if (/GROUP BY sheet_id, tab_name/.test(q)) {
      return { rows: [{ sheet_id: SLESS.sheet_id, tab_name: SLESS.tab_name },
                       { sheet_id: SHEETED.sheet_id, tab_name: SHEETED.tab_name }] };
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

  console.log('1) detect 단일 관문');
  sheetCalls.length = 0;
  const r1 = await OL.detectReverseSyncProposals({ sheetId: SLESS.sheet_id, tabName: SLESS.tab_name });
  t('무시트 탭이면 건너뛴다', r1 && r1.skipped === true, JSON.stringify(r1));
  t('건너뛴 사유를 말한다(조용히 0건으로 위장하지 않는다)', r1 && r1.reason === 'sheetless_tab', JSON.stringify(r1));
  t('구글시트를 한 번도 부르지 않았다', sheetCalls.length === 0, sheetCalls.join(','));

  console.log('\n2) 시트 기반 탭은 종전대로 읽는다(영구 배제 아님)');
  /* ★ 여기서 readSheet 까지 도달시키려면 미러 메타(raw_sheet_tabs)까지 흉내내야 하는데, 그건 이
     가드의 관심사가 아니다. 지키려는 불변식은 **새 게이트가 시트 탭을 막지 않는다**이므로,
     시트 탭이 sheetless_tab 로 끊기지 않고 **그 다음 단계까지 갔다**는 것으로 고정한다.
     (다음 단계 = loadRawTabContext → 스텁엔 메타가 없으니 no_meta_or_gid 로 멈춘다.) */
  sheetCalls.length = 0;
  const r2 = await OL.detectReverseSyncProposals({ sheetId: SHEETED.sheet_id, tabName: SHEETED.tab_name });
  t('시트 기반 탭은 새 게이트에 막히지 않는다', r2 && r2.reason !== 'sheetless_tab', JSON.stringify(r2));
  t('게이트 다음 단계까지 진행한다(탭 메타 조회)', r2 && r2.reason === 'no_meta_or_gid', JSON.stringify(r2));

  console.log('\n3) 크론 탭 선정');
  sheetCalls.length = 0;
  const cyc = await OL.runReverseSyncAutoCycle({ tabsPerCycle: 3 });
  t('무시트 탭을 라운드로빈에서 제외한다', cyc && cyc.sheetlessSkipped === 1, JSON.stringify(cyc));
  t('남은 시트 기반 탭만 대상이 된다', cyc && cyc.activeTabs === 1, JSON.stringify(cyc));
  t('건너뛴 수를 반환값에 실어 관측 가능하다(조용히 줄지 않게)',
    cyc && typeof cyc.sheetlessSkipped === 'number');

  console.log('\n4) 자동적용 재검증');
  t('무시트 탭이면 재검증 읽기 전에 건너뛴다',
    /_isSheetlessTabCached\(first\.sheet_id, first\.tab_name, first\.tab_gid\)\) \{ tabsSkipped\+\+; continue; \}/.test(SRC_TXT));
  t('건너뛰되 제안을 기각하지 않는다(사람이 화면에서 판단할 몫)', (() => {
    const i = SRC_TXT.indexOf('if (await _isSheetlessTabCached(first.sheet_id');
    const line = SRC_TXT.slice(i, SRC_TXT.indexOf('\n', i));
    return !/dismiss/i.test(line);
  })());

  console.log('\n5) 판정 단일 출처 · fail-open');
  t('판정을 utils/sheetlessScope 에 위임한다(키워드 사본 0)',
    /require\('\.\.\/utils\/sheetlessScope'\)\.sheetlessTabKeys/.test(SRC_TXT)
    && /isSheetlessTab/.test(SRC_TXT)
    && !/COALESCE\(sheetless, FALSE\)/.test(SRC_TXT));
  sheetlessQueryFails = true;
  OL._resetSheetlessCacheForTest();
  const r5 = await OL.detectReverseSyncProposals({ sheetId: SLESS.sheet_id, tabName: SLESS.tab_name });
  t('무시트 목록 조회가 실패하면 **무시트 탭도** 종전대로 감지한다(fail-open — 게이트가 죽었다고 멈추지 않는다)',
    r5 && r5.reason !== 'sheetless_tab', JSON.stringify(r5));

  console.log('\n' + String.fromCharCode(9654) + ' ' + pass + '건 통과');
  console.log('reverseSyncSheetlessSkip tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
