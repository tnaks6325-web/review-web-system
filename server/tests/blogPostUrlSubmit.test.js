// ═══════════════════════════════════════════════════════════════════════════
// 블로그체험단 M4-2 회귀가드 — 포스팅URL 제출 (URL-only 완료 · 검수 격리)
//
// 고정 대상:
//   ① **판정 단일 출처** `utils/blogPostUrl` — 형식만 본다(도메인 화이트리스트 금지).
//      목록을 두는 순간 리뷰어가 쓰는 플랫폼에 따라 **정상 제출이 막힌다**.
//   ② **서버가 최종 방어** — blog 탭은 memo(포스팅URL) 없으면 제출 거부하고 is_submitted 를
//      켜지 않는다. 화면만 막으면 낡은 화면·직접 호출로 "결과물 없는 완료"가 찍힌다.
//   ③ **리뷰체험단은 memo 가 종전대로 선택** = 무회귀(여기서 필수화하면 전 제출이 막힌다).
//   ④ **blog 탭은 슬롯 대조를 건너뛴다** — 현영 겸 blog 탭이 `required=['review']` 를
//      원장에서 못 찾아 영영 미완료가 되던 경로.
//   ⑤ **검수 격리(087 안전핀과 같은 규율)** — 1차 필터 skip, 2차 형식·상품명·본문겹침 skip,
//      **같은 파일(duplicate)은 유지**(슬롯 무관 신호라 blog 에서도 값어치가 있다).
//   ⑥ 프론트 사본(`_isPostUrl`)이 서버 규칙과 같고, 파일 0건 제출 경로가 배선돼 있다.
//
// 실행: node tests/blogPostUrlSubmit.test.js
// ═══════════════════════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FRONT = path.join(__dirname, '..', '..', 'frontend');
const read = p => fs.readFileSync(path.join(SRC, p), 'utf8');
/** 줄 주석만 제거(블록 주석 정규식은 이 레포의 정규식 리터럴을 물어 코드를 통째로 지운다 — 금지) */
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const blogUrl = require('../src/utils/blogPostUrl');
const submitSrc = noLineComments(read('routes/submit.routes.js'));
const inspectSrc = noLineComments(read('services/reviewInspect.service.js'));
const diagSrc = noLineComments(read('routes/diag.routes.js'));
const appSrc = fs.readFileSync(path.join(FRONT, 'js', 'search-app.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
/** 함수 본문만 잘라낸다 — 파일 전체 검사는 다른 함수의 같은 표현이 대신 통과시킨다(실측) */
function bodyOf(src, header, endMark) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, `본문을 못 찾음: ${header}`);
  const j = endMark ? src.indexOf(endMark, i) : -1;
  return src.slice(i, j > i ? j : src.length);
}

(async () => {
console.log('\n블로그체험단 M4-2 회귀가드 — 포스팅URL 제출\n');

// ── 1. 판정 단일 출처 (실행) ──────────────────────────────────────────────
console.log('1) 포스팅URL 판정 (순수함수 실행)');
t('http/https 절대 주소는 통과', () => {
  assert.strictEqual(blogUrl.isPostUrl('https://blog.naver.com/abc/223'), true);
  assert.strictEqual(blogUrl.isPostUrl('http://tistory.example.com/1'), true);
  assert.strictEqual(blogUrl.isPostUrl('  https://brunch.co.kr/@x/1  '), true, '앞뒤 공백은 턴다');
});
t('★★ 도메인 화이트리스트가 없다 — 어느 플랫폼이든 통과', () => {
  // 목록을 두면 리뷰어가 쓰는 블로그에 따라 정상 제출이 막힌다(오탐 > 미탐 금지 규율).
  for (const u of ['https://내블로그.한국/1', 'https://example.org/p/9', 'https://m.blog.naver.com/x']) {
    assert.strictEqual(blogUrl.isPostUrl(u), true, u);
  }
});
t('주소가 아니면 거부', () => {
  for (const v of ['', '   ', null, undefined, '포스팅 완료했어요', 'blog.naver.com/x', 'ftp://a.com/x', 'https://', 'https://a']) {
    assert.strictEqual(blogUrl.isPostUrl(v), false, JSON.stringify(v));
  }
});
t('★ 공백·따옴표·꺾쇠는 거부(시트 칸·화면에 그대로 나가는 값)', () => {
  assert.strictEqual(blogUrl.isPostUrl('https://a.com/1 https://a.com/2'), false);
  assert.strictEqual(blogUrl.isPostUrl('https://a.com/"onerror=x'), false);
  assert.strictEqual(blogUrl.isPostUrl('https://a.com/<script>'), false);
});
t('normalizePostUrl 은 앞뒤 공백만 턴다(주소 자체 미변형)', () => {
  assert.strictEqual(blogUrl.normalizePostUrl('  https://a.com/1?q=2#h  '), 'https://a.com/1?q=2#h');
  assert.strictEqual(blogUrl.normalizePostUrl(null), '');
});

// ── 2. 서버 게이트 (라우트 실제 실행) ────────────────────────────────────
console.log('\n2) 제출 게이트 (라우트 실제 호출)');

/** submit.routes 를 스텁 pool 로 로드 — DB·시트·큐를 전부 갈아끼운다 */
function loadSubmitRouter({ workKind, captureSlots = null, incomeType = null }) {
  const queries = [];
  const poolPath = require.resolve('../src/db/pool');
  const wkPath = require.resolve('../src/services/workKindContext.service');
  const rtPath = require.resolve('../src/services/reviewTypeContext.service');
  const routePath = require.resolve('../src/routes/submit.routes');
  const ssPath = require.resolve('../src/services/sheetlessStatus.service');
  const sheetsPath = require.resolve('../src/services/sheets.service');
  const saved = {};
  for (const p of [poolPath, wkPath, rtPath, routePath, ssPath, sheetsPath]) saved[p] = require.cache[p];

  const db = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/FROM review_index ri/.test(String(sql))) {
        return { rows: [{ capture_slots: captureSlots, income_type: incomeType, is_submitted: false }], rowCount: 1 };
      }
      if (/DISTINCT slot_key/.test(String(sql))) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  require.cache[poolPath] = { exports: db };
  require.cache[wkPath] = { exports: { workKindForTab: async () => workKind, workKindsForTabs: async () => new Map() } };
  require.cache[rtPath] = { exports: { reviewTypeForTab: async () => null, CAMPAIGN_REVIEW_TYPE_LATERAL: '' } };
  require.cache[ssPath] = { exports: {
    markStatusCell: async () => ({ handled: false }),
    markSheetlessMemo: async () => ({ handled: false }),
  } };
  require.cache[sheetsPath] = { exports: {
    writeSheet: async () => ({}), readSheet: async () => [], appendSheet: async () => ({}),
    getSpreadsheetMeta: async () => ({}), batchReadSheet: async () => [], batchUpdateSheet: async () => ({}),
  } };
  delete require.cache[routePath];
  const router = require('../src/routes/submit.routes');
  const restore = () => {
    for (const p of Object.keys(saved)) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; }
    delete require.cache[routePath];
  };
  return { router, queries, restore };
}

async function callReview(opts, body) {
  const { router, queries, restore } = loadSubmitRouter(opts);
  try {
    const layer = router.stack.find(l => l.route && l.route.path === '/review');
    assert.ok(layer, 'POST /review 라우트를 못 찾음');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    let payload = null;
    const res = { json(o) { payload = o; return this; }, status() { return this; } };
    await handler({ body }, res, e => { payload = { thrown: e && e.message }; });
    await new Promise(r => setImmediate(r));   // 배경 작업이 던져도 테스트가 죽지 않게 한 틱 양보
    return { payload, queries };
  } finally { restore(); }
}

const BASE = { sheetId: 'S', tabName: 'T', rowIndex: 7, submitCol: '리뷰제출', gid: '1' };

await ta('★★ blog 탭 + 포스팅URL 없음 = 거부', async () => {
  const { payload, queries } = await callReview({ workKind: 'blog' }, { ...BASE, memo: '' });
  assert.ok(payload && payload.error, '거부되지 않았다');
  assert.strictEqual(payload.code, 'post_url_required');
  assert.ok(!queries.some(q => /UPDATE review_index/.test(q.sql)),
    '거부인데 is_submitted 를 건드렸다 — 결과물 없는 제출이 완료로 찍힌다');
});
await ta('★★ blog 탭 + 주소 아님(문장) = 거부', async () => {
  const { payload } = await callReview({ workKind: 'blog' }, { ...BASE, memo: '포스팅 다 했어요' });
  assert.strictEqual(payload.code, 'post_url_required');
});
await ta('★ blog 탭 + 유효 포스팅URL = 통과 + 제출 기록', async () => {
  const { payload, queries } = await callReview({ workKind: 'blog' }, { ...BASE, memo: 'https://blog.naver.com/a/1' });
  assert.strictEqual(payload.ok, true, JSON.stringify(payload));
  assert.strictEqual(payload.complete, true);
  assert.ok(queries.some(q => /UPDATE review_index SET is_submitted = TRUE/.test(q.sql)), 'is_submitted 미기록');
});
await ta('★★ 리뷰체험단은 memo 없이도 제출된다 (무회귀 선 — 완화 아님)', async () => {
  const { payload, queries } = await callReview({ workKind: 'review' }, { ...BASE, memo: '' });
  assert.strictEqual(payload.ok, true, JSON.stringify(payload));
  assert.ok(queries.some(q => /UPDATE review_index SET is_submitted = TRUE/.test(q.sql)));
});
await ta('★★ 판정 실패(null)도 리뷰 경로 — 모른다고 blog 로 단정하지 않는다', async () => {
  const { payload } = await callReview({ workKind: null }, { ...BASE, memo: '' });
  assert.strictEqual(payload.ok, true, '판정 불가인데 막았다 — 리뷰체험단 전 제출이 막힌다');
});

await ta('★★ blog 탭은 슬롯 대조를 건너뛴다(현영 겸 blog = 영영 미완료 차단)', async () => {
  // 화면 슬롯 2개(리뷰+현금영수증) + 원장에 제출 슬롯 0건 → 리뷰체험단이면 미완료
  const opts = { captureSlots: null, incomeType: '사업자현영' };
  const rBlog = await callReview({ workKind: 'blog', ...opts }, { ...BASE, memo: 'https://a.com/1' });
  assert.strictEqual(rBlog.payload.complete, true, 'blog 인데 슬롯 미충족으로 막혔다');
  assert.ok(!rBlog.queries.some(q => /DISTINCT slot_key/.test(q.sql)), 'blog 인데 원장 대조를 돌렸다');

  const rRev = await callReview({ workKind: 'review', ...opts }, { ...BASE, memo: '' });
  assert.strictEqual(rRev.payload.complete, false, '리뷰체험단 슬롯 대조가 사라졌다(무회귀 위반)');
  assert.ok(rRev.queries.some(q => /DISTINCT slot_key/.test(q.sql)));
});

t('★ 게이트는 blog 일 때만 — 판정식 자체를 고정', () => {
  const body = bodyOf(submitSrc, "router.post('/review'", 'router.post(');
  assert.ok(/if\s*\(\s*_isBlog\s*&&\s*!isPostUrl\(\s*memo\s*\)\s*\)/.test(body),
    'blog + URL 없음 게이트가 사라졌거나 조건이 바뀌었다');
  assert.ok(/isMultiSlot\s*&&\s*!_isBlog/.test(body), '슬롯 대조 blog 예외가 사라졌다');
});

// ── 3. 검수 격리 ─────────────────────────────────────────────────────────
console.log('\n3) 검수 격리 (087 안전핀과 같은 규율)');
const inspect = require('../src/services/reviewInspect.service');

t('★★ 1차 필터 — blog 탭은 판정하지 않는다(첨부가 잠기면 참여 소각)', () => {
  const v = inspect.precheckPolicy({
    classified: { kind: 'other', confidence: 0.99 }, expectedChannel: 'coupang',
    slotKey: 'review', workKind: 'blog',
  });
  assert.strictEqual(v.verdict, 'skip');
  assert.strictEqual(v.code, 'blog_tab');
  assert.strictEqual(v.blockable, false);
});
t('★★ workKind 가 null 이면 종전 판정 그대로(오늘 동작 불변)', () => {
  const v = inspect.precheckPolicy({
    classified: { kind: 'other', confidence: 0.99 }, expectedChannel: 'coupang', slotKey: 'review',
  });
  assert.notStrictEqual(v.code, 'blog_tab');
  assert.strictEqual(v.verdict, 'block', '리뷰체험단의 차단 갈래가 사라졌다');
});
t('★ review 로 명시돼도 종전 판정(안전핀은 blog 한 갈래뿐)', () => {
  const v = inspect.precheckPolicy({
    classified: { kind: 'other', confidence: 0.99 }, expectedChannel: 'coupang',
    slotKey: 'review', workKind: 'review',
  });
  assert.strictEqual(v.verdict, 'block');
});

t('★★ 2차 검수 — blog 는 형식·상품명·본문겹침을 skip, 같은 파일은 유지', () => {
  const body = bodyOf(inspectSrc, 'const _isBlogTab = ', 'const status = computeStatus');
  assert.ok(/_isBlogTab\s*\)\s*\{\s*checks\.format\s*=\s*\{\s*verdict:\s*'skip'/.test(body.replace(/\s+/g, ' '))
    || /if \(_isBlogTab\) \{/.test(body), '형식 판정 blog skip 이 사라졌다');
  assert.ok(/checks\.product\s*=\s*\(isReview\s*&&\s*!_isBlogTab\)/.test(body), '상품명 skip 이 사라졌다');
  assert.ok(/checks\.similarity\s*=\s*\(isReview\s*&&\s*!_isBlogTab\)/.test(body), '본문겹침 skip 이 사라졌다');
  // ★ duplicate 는 blog 게이트를 타면 안 된다(캡처 재탕은 blog 에서도 신호)
  const dupLine = body.slice(body.indexOf('checks.duplicate'), body.indexOf('checks.similarity'));
  assert.ok(!/_isBlogTab/.test(dupLine), '같은 파일 검사까지 blog 로 껐다 — 재탕을 못 잡는다');
});
t('★ 판정 재료는 loadTabExpectations 가 같은 쿼리로 싣는다(왕복 순증 0 · 사본 0)', () => {
  const body = bodyOf(inspectSrc, 'async function loadTabExpectations', 'async function productNameSettings');
  assert.ok(/CAMPAIGN_WORK_KIND_LATERAL/.test(body), '공유 LATERAL 을 안 쓴다(사본 위험)');
  assert.ok(/resolveWorkKind\(/.test(body), '판정을 utils/workKind 에 맡기지 않는다');
  assert.ok(/out\.workKind\s*=/.test(body));
  assert.strictEqual((body.match(/FROM tab_configs c/g) || []).length, 1, '쿼리가 늘었다(왕복 순증)');
});
t('★ 1차 필터 라우트가 workKind 를 실제로 넘긴다', () => {
  assert.ok(/workKind = exp\.workKind/.test(diagSrc), 'precheck 라우트가 workKind 를 안 읽는다');
  assert.ok(/precheckPolicy\(\{[^}]*workKind[^}]*\}\)/.test(diagSrc), 'precheckPolicy 에 workKind 미전달');
});

// ── 4. 프론트 (사본 일치 · 배선) ─────────────────────────────────────────
console.log('\n4) 리뷰어 화면');

const sandbox = { document: undefined };
vm.createContext(sandbox);
vm.runInContext(
  appSrc.slice(appSrc.indexOf('const _BLOG_POST_URL_HINT'), appSrc.indexOf('function _applyBlogMemoUi')),
  sandbox);

t('★★ 프론트 사본 `_isPostUrl` 이 서버 규칙과 같다(사본 드리프트 차단)', () => {
  const cases = ['https://blog.naver.com/a/1', 'http://a.co/1', '  https://a.co/1 ', '', '   ', 'a.com/1',
    'ftp://a.com', 'https://', 'https://a', '포스팅 완료', 'https://a.com/1 https://a.com/2',
    'https://a.com/"x', 'https://a.com/<b>', 'https://내블로그.한국/1'];
  for (const c of cases) {
    assert.strictEqual(sandbox._isPostUrl(c), blogUrl.isPostUrl(c), `불일치: ${JSON.stringify(c)}`);
  }
});
t('★ 안내 문구도 서버와 같다(거부 메시지 ≠ 화면 힌트 방지)', () => {
  // ★ `const` 는 컨텍스트 객체의 프로퍼티가 되지 않는다(스크립트 렉시컬 환경) — 식으로 평가해 읽는다.
  assert.strictEqual(vm.runInContext('_BLOG_POST_URL_HINT', sandbox), blogUrl.POST_URL_HINT);
});
t('★★ 종류 판정은 서버가 준 workKind 정확 일치 — 탭명·상품명 추측 금지', () => {
  const m = appSrc.match(/function _isBlogItem\(item\)\s*\{([^}]*)\}/);
  assert.ok(m, '_isBlogItem 이 없다');
  assert.ok(/item\.workKind === 'blog'/.test(m[1]), 'workKind 정확 일치가 아니다');
  assert.ok(!/tabName|campaignName|productName|includes\(/.test(m[1]), '탭명·상품명으로 추측한다');
});

t('★★ memo 칸 문구는 세 렌더 지점이 같은 함수(_applyBlogMemoUi)를 쓴다', () => {
  const calls = (appSrc.match(/_applyBlogMemoUi\(/g) || []).length;
  assert.ok(calls >= 4, `호출이 ${calls}회 — 정의 1 + 렌더 3 이상이어야 한다`);
  assert.ok(/_applyBlogMemoUi\(document\.getElementById\("memoTxt"\), items\[0\]\)/.test(appSrc), '단건 미배선');
  assert.ok(/_applyBlogMemoUi\(slot\.querySelector\(`#mrMemo_\$\{idx\}`\), item\)/.test(appSrc), '다건 미배선');
  assert.ok(/_applyBlogMemoUi\(memoEl, item\)/.test(appSrc), '슬롯 모드 미배선');
});
t('★ 리뷰체험단 문구는 건드리지 않는다(무회귀) — blog 아닐 때 원래 placeholder 복원', () => {
  const m = appSrc.match(/function _applyBlogMemoUi\(el, item\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '_applyBlogMemoUi 를 못 찾음');
  assert.ok(/el\.dataset\.memoPh/.test(m[0]), '원래 placeholder 를 보관하지 않는다');
  assert.ok(/if \(!blog\)/.test(m[0]), 'blog 아닐 때 조기 반환이 없다');
});

t('★★ 단건: blog 면 파일 0장 허용 + URL 필수', () => {
  const body = bodyOf(appSrc, 'async function submitReview()', 'function resetApp()');
  assert.ok(/else if \(_isBlogItem\(items\[0\]\)\) \{/.test(body), '단건 blog 분기가 없다');
  assert.ok(/if \(!_isPostUrl\(m\)\) \{ showToast\(_BLOG_POST_URL_HINT/.test(body), '단건 URL 검증이 없다');
  assert.ok(/if \(S\.files\.length === 0\)/.test(body), '리뷰체험단 사진 필수 규칙이 사라졌다(무회귀 위반)');
});
t('★★ 다건: blog 행은 빈 슬롯으로 세지 않는다(행마다 판정)', () => {
  const body = bodyOf(appSrc, 'async function submitReview()', 'function resetApp()');
  assert.ok(/if \(_isBlogItem\(it\)\) \{/.test(body), '다건 행별 blog 판정이 없다');
  assert.ok(/badUrl\.push\(idx \+ 1\)/.test(body), '다건 URL 검증이 없다');
  assert.ok(/emptySlots\.length && emptySlots\.length === items\.length/.test(body),
    'blog 만 있을 때 "이미지를 첨부해주세요" 로 막힌다(빈 배열 === 0건 오판)');
});
t('★★ 파일 0장이면 업로드 호출 자체를 건너뛴다', () => {
  const body = bodyOf(appSrc, 'async function submitReview()', 'function resetApp()');
  const i0 = body.indexOf('if (files.length === 0) {');
  const iUp = body.indexOf('gasPostUpload(');
  assert.ok(i0 >= 0 && i0 < iUp, '업로드 앞 0건 분기가 없다');
  // ★ 거리(정규식 창)가 아니라 순서를 본다 — 주석 한 줄에 창이 넘쳐 조용히 빨개진다.
  const iName = body.indexOf('const reviewerName = item.recipientName');
  assert.ok(iName >= 0, 'reviewerName 선언을 못 찾음');
  assert.ok(iName < i0, 'reviewerName 이 업로드 블록 안에 있다 — 0건 제출에서 ReferenceError');
});
t('★★ 슬롯 모드: blog 면 캡처 0장 허용 + 0건을 "전부 실패"로 오판하지 않는다', () => {
  const body = bodyOf(appSrc, 'async function _submitReviewSlots(item)', 'async function submitReview()');
  assert.ok(/const _blogSlot = _isBlogItem\(item\)/.test(body), '슬롯 모드 blog 판정이 없다');
  assert.ok(/if \(slotsToUpload\.length === 0 && !_blogSlot\)/.test(body), '슬롯 0건 게이트에 blog 예외가 없다');
  assert.ok(/slotsToUpload\.length > 0 && uploadErrors\.length === slotsToUpload\.length/.test(body),
    '0건일 때 0===0 이 참이 되어 아무 오류 없이 "업로드 실패"로 돌아간다');
});

// ── 5. 소스 위생 ─────────────────────────────────────────────────────────
console.log('\n5) 소스 위생');
t('★ 리터럴 NUL 없음(git 이 바이너리로 취급하면 grep 가드가 무력화된다)', () => {
  for (const [n, s] of [['blogPostUrl.js', fs.readFileSync(path.join(SRC, 'utils/blogPostUrl.js'))],
                        ['이 가드', fs.readFileSync(__filename)]]) {
    assert.ok(!s.includes(0), `${n} 에 NUL`);
  }
});
t('★ 판정 사본 0 — 라우트·화면이 자체 URL 정규식을 두지 않는다', () => {
  const body = bodyOf(submitSrc, "router.post('/review'", 'router.post(');
  assert.ok(!/https\?:\\\/\\\//.test(body), 'submit.routes 에 URL 정규식 사본이 생겼다');
});

console.log(`\n${fail === 0 ? '✅' : '❌'} 블로그체험단 M4-2 회귀가드 — 통과 ${pass} · 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
})();
