// ═══════════════════════════════════════════════════════════════════════════
// 블로그체험단 M4-1 회귀가드 — memo(비고 / 포스팅URL) 기록 경로
//
// 고정 대상:
//   ① **열 고르기 단일 출처** — 무시트 작업표 기록이 utils/memoColumn 을 쓴다.
//      (제출 배경 시트 쓰기 · 큐 재시도는 결정 274 로 제거 — 되살아나지 않는지 본다.)
//   ② **리뷰체험단·판정 불가는 종전 순서(`비고` → `포스팅`)** = 무회귀.
//   ③ (큐 memo 유실 수리 — review_submit 큐 자체가 결정 274 로 없어졌다. 부재만 본다.)
//   ④ **무시트 탭 memo 기록** — 시트 쓰기가 막힌 탭에서 값이 사라지지 않게 작업표 칸에 남긴다.
//
// 실행: node tests/blogMemoColumn.test.js
// ═══════════════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = p => fs.readFileSync(path.join(SRC, p), 'utf8');
/** 줄 주석만 제거(블록 주석 정규식은 이 레포의 정규식 리터럴을 물어 코드를 통째로 지운다 — 금지) */
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const memoCol = require('../src/utils/memoColumn');
const sheetlessStatus = require('../src/services/sheetlessStatus.service');

const submitSrc = noLineComments(read('routes/submit.routes.js'));
const queueSrc = noLineComments(read('services/syncQueue.service.js'));
const statusSrc = noLineComments(read('services/sheetlessStatus.service.js'));
const searchSrc = noLineComments(read('services/search.service.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

(async () => {
console.log('\n블로그체험단 M4-1 회귀가드 — memo 기록 경로\n');

// ── 1. 열 고르기 순수함수 ─────────────────────────────────────────────────
console.log('1) 열 고르기 (실행)');
const HDR = ['번호', '구매일자', '수취인', '연락처', '비고(닉네임)', '포스팅URL'];
t('★★ 리뷰체험단 = 종전 순서(비고 우선) — 무회귀', () => {
  assert.strictEqual(memoCol.pickMemoColumnIndex(HDR), 4);
  assert.strictEqual(memoCol.pickMemoColumnIndex(HDR, { blog: false }), 4);
});
t('★★ 블로그체험단 = 포스팅 우선(결과물 칸)', () => {
  assert.strictEqual(memoCol.pickMemoColumnIndex(HDR, { blog: true }), 5);
});
t('★ 블로그인데 포스팅 열이 없으면 비고로 폴백(바를참스킨 기존 시트 호환)', () => {
  const h = ['번호', '비고'];
  assert.strictEqual(memoCol.pickMemoColumnIndex(h, { blog: true }), 1);
});
t('★ 리뷰체험단인데 비고가 없으면 포스팅으로 폴백(종전 동작)', () => {
  const h = ['번호', '포스팅주소'];
  assert.strictEqual(memoCol.pickMemoColumnIndex(h), 1);
});
t('둘 다 없으면 -1(호출부가 고지)', () => {
  assert.strictEqual(memoCol.pickMemoColumnIndex(['번호', '주소']), -1);
  assert.strictEqual(memoCol.pickMemoColumnIndex(['번호'], { blog: true }), -1);
});
t('공백·null 헤더에 안 걸린다', () => {
  assert.strictEqual(memoCol.pickMemoColumnIndex([null, '  ', '비고 ']), 2);
  assert.strictEqual(memoCol.pickMemoColumnIndex(null), -1);
});
t('pickMemoColumnName = 같은 판정의 이름 표기', () => {
  assert.strictEqual(memoCol.pickMemoColumnName(HDR, { blog: true }), '포스팅URL');
  assert.strictEqual(memoCol.pickMemoColumnName(HDR), '비고(닉네임)');
  assert.strictEqual(memoCol.pickMemoColumnName(['번호']), '');
});

// ── 2. 단일 출처 (사본 금지) ──────────────────────────────────────────────
console.log('\n2) 단일 출처 — 소비처는 무시트 작업표 기록 하나(결정 274 로 시트 쓰기 두 곳 제거)');
t('★★ 결정 274 — 제출 배경 시트 쓰기·큐 재시도가 없다(열 고르기 사본이 생길 자리가 없다)', () => {
  assert.ok(!/pickMemoColumnIndex/.test(submitSrc), '제출 경로에 시트 memo 쓰기가 되살아났다');
  assert.ok(!/case 'review_submit'/.test(queueSrc) && !/pickMemoColumnIndex/.test(queueSrc), '큐 review_submit 실행부가 되살아났다');
});
t('★★ 무시트 기록이 pickMemoColumnName 사용', () => {
  assert.ok(/pickMemoColumnName\(headers, \{ blog \}\)/.test(statusSrc), '무시트 미사용');
});
/* ★ 검사 범위는 **쓰기 경로 본문**으로 스코프한다 — 파일 전체를 보면 `/debug-headers`
   (두 열을 각각 보고만 하는 진단 엔드포인트, 판정이 아니다)가 잡혀 잘못된 빨간불이 된다.
   반대로 스코프가 없으면 다른 라우트의 같은 표현이 사본 부활을 대신 통과시킬 수도 있다. */
const submitReviewBody = (() => {
  const i = submitSrc.indexOf("router.post('/review'");
  assert.ok(i > 0, "'/review' 라우트를 못 찾음");
  const j = submitSrc.indexOf('router.', i + 20);
  return submitSrc.slice(i, j > 0 ? j : submitSrc.length);
})();
t('★★ 판정 사본 0 — 쓰기 경로 세 곳에 인라인 /비고/ → /포스팅/ 폴백이 없다', () => {
  for (const [name, s] of [['submit:/review', submitReviewBody], ['status', statusSrc]]) {
    assert.ok(!/findIndex\([^)]*\/비고\//.test(s), `${name}: 인라인 비고 탐색 사본`);
    assert.ok(!/findIndex\([^)]*\/포스팅\//.test(s), `${name}: 인라인 포스팅 탐색 사본`);
  }
});

// ── 3. (큐 재시도 memo 유실 수리 — review_submit 실행부와 함께 결정 274 로 제거) ─────────
console.log('\n3) 큐 재시도 경로 없음 (결정 274)');
t('★★ review_submit 을 넣는 곳도 실행하는 곳도 없다(시트 기반 탭도 시트에 쓰지 않는다)', () => {
  assert.ok(!/enqueue\('review_submit'/.test(submitSrc), '제출 경로가 review_submit 큐를 다시 넣는다');
  assert.ok(!/case 'review_submit'/.test(queueSrc), '큐 실행부가 되살아났다');
});

// ── 4. 무시트 memo 기록 ───────────────────────────────────────────────────
console.log('\n4) 무시트 탭 memo 기록 (실행)');
function stubDb({ sheetless = true, headers = HDR, rowCount = 1 } = {}) {
  const q = [];
  return {
    queries: q,
    async query(sql, params) {
      q.push({ sql: String(sql), params });
      const s = String(sql);
      if (/^\s*SELECT[\s\S]*FROM tab_configs/.test(s)) return { rows: [{ sheetless }], rowCount: 1 };
      if (/detected_headers/.test(s)) return { rows: [{ h: headers }], rowCount: 1 };
      if (/UPDATE campaign_participants/.test(s)) return { rows: [], rowCount };
      return { rows: [], rowCount: 0 };
    },
  };
}
async function callMemo(opts = {}, args = {}) {
  const db = stubDb(opts);
  sheetlessStatus.__setPoolForTest(db);
  // 무시트 판정·장부 재생성은 실제 모듈을 태우지 않도록 require 캐시를 갈아끼운다
  const scopePath = require.resolve('../src/utils/sheetlessScope');
  const ledgerPath = require.resolve('../src/services/sheetlessLedger.service');
  const oldScope = require.cache[scopePath], oldLedger = require.cache[ledgerPath];
  const rebuilt = [];
  require.cache[scopePath] = { exports: { isSheetless: async () => opts.sheetless !== false } };
  require.cache[ledgerPath] = { exports: { rebuildLedgers: async (a) => { rebuilt.push(a); if (opts.ledgerThrows) throw new Error('boom'); } } };
  try {
    const res = await sheetlessStatus.markSheetlessMemo({
      sheetId: 'S', tabName: 'T', rowIndex: 7, memo: 'https://blog.naver.com/x/1', ...args,
    });
    return { res, db, rebuilt };
  } finally {
    sheetlessStatus.__setPoolForTest(null);
    if (oldScope) require.cache[scopePath] = oldScope; else delete require.cache[scopePath];
    if (oldLedger) require.cache[ledgerPath] = oldLedger; else delete require.cache[ledgerPath];
  }
}
await ta('★★ 블로그 탭은 포스팅 칸에 기록', async () => {
  const { res, db } = await callMemo({}, { blog: true });
  assert.strictEqual(res.handled, true);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.column, '포스팅URL');
  const up = db.queries.find(x => /UPDATE campaign_participants/.test(x.sql));
  assert.strictEqual(up.params[3], '포스팅URL');
  assert.strictEqual(up.params[4], 'https://blog.naver.com/x/1');
});
await ta('★ 리뷰체험단은 비고 칸(종전 위치)', async () => {
  const { res } = await callMemo({}, { blog: false });
  assert.strictEqual(res.column, '비고(닉네임)');
});
await ta('★★ 시트 기반 탭이면 handled:false = 호출부 종전 경로', async () => {
  const { res, db } = await callMemo({ sheetless: false }, { blog: true });
  assert.strictEqual(res.handled, false);
  assert.ok(!db.queries.some(x => /UPDATE campaign_participants/.test(x.sql)), '시트 탭인데 작업표를 건드렸다');
});
await ta('★★ 무시트 판정 예외도 handled:false = 호출부 종전 경로(fail-open)', async () => {
  // 판정 자체가 던지는 경우 — handled:true 로 접으면 시트 기반 탭의 memo 가 조용히 사라진다
  const db = stubDb();
  sheetlessStatus.__setPoolForTest(db);
  const scopePath = require.resolve('../src/utils/sheetlessScope');
  const oldScope = require.cache[scopePath];
  require.cache[scopePath] = { exports: { isSheetless: async () => { throw new Error('down'); } } };
  try {
    const res = await sheetlessStatus.markSheetlessMemo({
      sheetId: 'S', tabName: 'T', rowIndex: 7, memo: 'x', blog: true });
    assert.strictEqual(res.handled, false, '판정 실패인데 handled:true — 시트 경로가 막힌다');
    assert.strictEqual(db.queries.length, 0);
  } finally {
    sheetlessStatus.__setPoolForTest(null);
    if (oldScope) require.cache[scopePath] = oldScope; else delete require.cache[scopePath];
  }
});
await ta('★ 빈 memo 는 관여하지 않는다(빈 값으로 칸을 덮지 않는다)', async () => {
  for (const m of ['', '   ', null, undefined]) {
    const { res, db } = await callMemo({}, { memo: m, blog: true });
    assert.strictEqual(res.handled, false, `memo=${JSON.stringify(m)}`);
    assert.strictEqual(db.queries.length, 0);
  }
});
await ta('★ 비고/포스팅 열이 없으면 조용히 성공으로 접지 않는다', async () => {
  const { res } = await callMemo({ headers: ['번호', '주소'] }, { blog: true });
  assert.strictEqual(res.handled, true);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'no_memo_column');
});
await ta('★ 그 행이 없으면 row_not_found (조용한 성공 금지)', async () => {
  const { res } = await callMemo({ rowCount: 0 }, { blog: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'row_not_found');
});
await ta('★ 장부 재생성 실패해도 값은 작업표에 남는다(deferred)', async () => {
  const { res } = await callMemo({ ledgerThrows: true }, { blog: true });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.deferred, true);
});
await ta('★ 성공 시 장부를 다시 만든다(화면 반영)', async () => {
  const { rebuilt } = await callMemo({}, { blog: true });
  assert.strictEqual(rebuilt.length, 1);
  assert.strictEqual(rebuilt[0].tabName, 'T');
});
t('★★ 상태 칸·memo 칸이 같은 쓰기 함수를 쓴다(쓰기 규율 사본 금지)', () => {
  const writerStart = statusSrc.indexOf('async function _writeCellAndRebuild');
  const writerEnd = statusSrc.indexOf("/* (8/10 이전 'O' 표기", writerStart);   // (옛 끝 표지 REVIEW_SUBMIT_TIME_BACKFILL_DAYS 는 결정 186 63번에서 제거)
  assert.ok(writerStart >= 0 && writerEnd > writerStart, 'common writer not found');
  const writer = statusSrc.slice(writerStart, writerEnd);
  const n = (writer.match(/UPDATE campaign_participants/g) || []).length;
  assert.strictEqual(n, 1, `작업표 UPDATE 가 ${n}곳 — 사본이 생겼다`);
  assert.ok(/markStatusCell[\s\S]*?_writeCellAndRebuild/.test(statusSrc));
  assert.ok(/markSheetlessMemo[\s\S]*?_writeCellAndRebuild/.test(statusSrc));
});

// ── 5. 제출 경로 배선 ─────────────────────────────────────────────────────
console.log('\n5) 제출 경로 배선');
t('★★ 판정 실패·리뷰체험단은 false(종전 동작) — isBlogKind 로 접는다', () => {
  assert.ok(/_isBlog = isBlogKind\(await workKindForTab\(\{ sheetId, tabName \}\)\)/.test(submitSrc));
  assert.ok(/catch \(_\) \{ _isBlog = false; \}/.test(submitSrc), '조회 실패 폴백 없음');
});
t('필수 블로그 URL은 완료 COMMIT 전에 같은 client로 기록', () => {
  const i1 = submitSrc.indexOf("completionClient.query('COMMIT')");
  const i2 = submitSrc.indexOf('markSheetlessMemo');
  assert.ok(i2 > 0 && i2 < i1, 'URL 저장보다 먼저 완료를 확정함');
  assert.ok(/client: completionClient/.test(submitSrc.slice(i2,i2+260)));
});
t('★★ 무시트 기록에도 같은 blog 판정을 넘긴다(시트 경로와 칸이 갈리면 안 된다)', () => {
  const i = submitSrc.indexOf('markSheetlessMemo');
  const block = submitSrc.slice(i, i + 300);
  assert.ok(/blog: _isBlog/.test(block), '무시트 기록에 고정값을 넘겼다 — 시트 경로와 다른 칸에 쓴다');
});
t('필수 URL 저장 실패는 재시도 오류, 선택 비고만 완료 뒤 기록', () => {
  const i = submitSrc.indexOf('markSheetlessMemo');
  const block = submitSrc.slice(i - 200, i + 600);
  assert.ok(/REVIEW_POST_URL_WRITE_FAILED/.test(block));
  assert.ok(submitSrc.indexOf('if (!_isBlog) try')>submitSrc.indexOf("completionClient.query('COMMIT')"));
});

// ── 6. 검색 응답 workKind ─────────────────────────────────────────────────
console.log('\n6) /api/search 에 workKind 동봉 (M4-2 화면 재료)');
t('★ 배치 조회(N+1 금지) — reviewTypesForTabs 와 같은 모양', () => {
  assert.ok(/workKindsForTabs\(/.test(searchSrc), '배치 조회 미사용');
  assert.strictEqual(typeof require('../src/services/workKindContext.service').workKindsForTabs, 'function');
});
t('★ 행마다 workKind 를 싣는다', () => {
  assert.ok(/workKind:\s*_wkMap\.get\(/.test(searchSrc));
});
t('★ 조회 실패는 빈 맵 = null = 종전 화면(fail-soft)', () => {
  assert.ok(/catch \(_\) \{ _wkMap = new Map\(\); \}/.test(searchSrc));
});

// ── 7. 소스 위생 ──────────────────────────────────────────────────────────
console.log('\n7) 소스 위생');
t('★ memoColumn 에 리터럴 NUL 없음', () => {
  assert.strictEqual(fs.readFileSync(path.join(SRC, 'utils/memoColumn.js')).indexOf(0), -1);
});
t('★ 결정 274 — 시트 기반 탭에도 리뷰제출 시트 쓰기가 없다(작업보드가 원본)', () => {
  assert.ok(!/writeSheet\(/.test(submitSrc), '제출 경로에 시트 직접 쓰기가 되살아났다');
});

console.log(`\n${fail ? '❌' : '✅'} 블로그체험단 M4-1 회귀가드 — 통과 ${pass} · 실패 ${fail}\n`);
process.exit(fail ? 1 : 0);
})();
