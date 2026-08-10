// ═══════════════════════════════════════════════════════════════════════════
// 블로그체험단 M4-1 회귀가드 — memo(비고 / 포스팅URL) 기록 경로
//
// 고정 대상:
//   ① **열 고르기 단일 출처** — 제출 배경 쓰기 · 큐 재시도 · 무시트 작업표 기록이 같은 규칙.
//      갈라지면 "처음 제출은 포스팅 칸, 재시도는 비고 칸"으로 값이 흩어진다.
//   ② **리뷰체험단·판정 불가는 종전 순서(`비고` → `포스팅`)** = 무회귀.
//   ③ **큐 memo 유실 버그 수리** — 종전엔 payload 의 memo 를 읽지도 쓰지도 않아
//      시트 쓰기가 한 번 실패해 큐로 내려가면 비고/포스팅URL 이 영구 유실됐다.
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
console.log('\n2) 단일 출처 — 소비처 3곳이 같은 함수를 쓴다');
t('★★ 제출 배경 쓰기가 pickMemoColumnIndex 사용', () => {
  assert.ok(/pickMemoColumnIndex\(headers, \{ blog: _isBlog \}\)/.test(submitSrc), '제출 경로 미사용');
});
t('★★ 큐 재시도가 pickMemoColumnIndex 사용', () => {
  assert.ok(/pickMemoColumnIndex\(headers, \{ blog: blog === true \}\)/.test(queueSrc), '큐 미사용');
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
  for (const [name, s] of [['submit:/review', submitReviewBody], ['queue', qBlockEarly()], ['status', statusSrc]]) {
    assert.ok(!/findIndex\([^)]*\/비고\//.test(s), `${name}: 인라인 비고 탐색 사본`);
    assert.ok(!/findIndex\([^)]*\/포스팅\//.test(s), `${name}: 인라인 포스팅 탐색 사본`);
  }
});
function qBlockEarly() {
  const i = queueSrc.indexOf("case 'review_submit'");
  const j = queueSrc.indexOf("case 'deposit_mark'", i);
  return queueSrc.slice(i, j > 0 ? j : i + 4000);
}

// ── 3. 큐 memo 유실 수리 ──────────────────────────────────────────────────
console.log('\n3) 큐 재시도 memo 유실 수리 (현행 버그)');
const qBlock = (() => {
  const i = queueSrc.indexOf("case 'review_submit'");
  assert.ok(i > 0, 'review_submit 핸들러를 못 찾음');
  const j = queueSrc.indexOf("case 'deposit_mark'", i);
  return queueSrc.slice(i, j > 0 ? j : i + 4000);
})();
t('★★ payload 에서 memo 를 꺼낸다', () => {
  assert.ok(/const \{[^}]*\bmemo\b[^}]*\} = payload;/.test(qBlock), 'memo 구조분해 없음(유실 재발)');
});
t('★★ memo 를 실제로 시트에 쓴다', () => {
  assert.ok(/writeSheet\(sheetId, memoRange/.test(qBlock), 'memo 쓰기 없음 — 재시도 시 유실');
});
t('★ 같은 열 우선순위(blog 플래그도 payload 로 온다)', () => {
  assert.ok(/\bblog\b/.test(qBlock), 'blog 플래그 미소비');
  assert.ok(/pickMemoColumnIndex\(headers, \{ blog: blog === true \}\)/.test(qBlock));
});
t('★ 제출 경로가 큐 payload 에 memo·blog 를 함께 싣는다', () => {
  const i = submitSrc.indexOf("enqueue('review_submit'");
  assert.ok(i > 0);
  const block = submitSrc.slice(i, i + 400);
  assert.ok(/memo: memo \|\| ''/.test(block), 'memo 미전달');
  assert.ok(/blog: _isBlog/.test(block), 'blog 미전달 — 재시도가 다른 칸에 쓴다');
});
t('★ 열이 없으면 조용히 넘기지 않고 경고(담당자 조치 신호)', () => {
  assert.ok(/비고\/포스팅 열 없음/.test(qBlock));
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
      if (/FROM tab_configs/.test(s)) return { rows: [{ sheetless }], rowCount: 1 };
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
  const n = (statusSrc.match(/UPDATE campaign_participants/g) || []).length;
  assert.strictEqual(n, 1, `작업표 UPDATE 가 ${n}곳 — 사본이 생겼다`);
  assert.ok(/_writeCellAndRebuild/.test(statusSrc));
});

// ── 5. 제출 경로 배선 ─────────────────────────────────────────────────────
console.log('\n5) 제출 경로 배선');
t('★★ 판정 실패·리뷰체험단은 false(종전 동작) — isBlogKind 로 접는다', () => {
  assert.ok(/_isBlog = isBlogKind\(await workKindForTab\(\{ sheetId, tabName \}\)\)/.test(submitSrc));
  assert.ok(/catch \(_\) \{ _isBlog = false; \}/.test(submitSrc), '조회 실패 폴백 없음');
});
t('★ 무시트 memo 기록을 제출 완료 분기에서 호출', () => {
  const i1 = submitSrc.indexOf("kind: 'submit'");
  const i2 = submitSrc.indexOf('markSheetlessMemo');
  assert.ok(i1 > 0 && i2 > i1 && (i2 - i1) < 1200, '완료 분기 밖이거나 미호출');
});
t('★★ 무시트 기록에도 같은 blog 판정을 넘긴다(시트 경로와 칸이 갈리면 안 된다)', () => {
  const i = submitSrc.indexOf('markSheetlessMemo');
  const block = submitSrc.slice(i, i + 300);
  assert.ok(/blog: _isBlog/.test(block), '무시트 기록에 고정값을 넘겼다 — 시트 경로와 다른 칸에 쓴다');
});
t('★ memo 기록 실패가 제출을 죽이지 않는다(fail-soft)', () => {
  const i = submitSrc.indexOf('markSheetlessMemo');
  const block = submitSrc.slice(i - 200, i + 600);
  assert.ok(/catch \(e\)/.test(block), 'try/catch 없음');
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
t('★ 시트 쓰기 경로는 그대로 살아 있다(무회귀)', () => {
  assert.ok(/writeSheet\(sheetId, memoRange, \[\[memo\.trim\(\)\]\], sheetOpts\)/.test(submitSrc),
    '시트 기반 탭의 memo 쓰기가 사라졌다');
});

console.log(`\n${fail ? '❌' : '✅'} 블로그체험단 M4-1 회귀가드 — 통과 ${pass} · 실패 ${fail}\n`);
process.exit(fail ? 1 : 0);
})();
