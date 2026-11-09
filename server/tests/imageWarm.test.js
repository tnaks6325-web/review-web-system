'use strict';
/**
 * 결정 354 「미리 만들기(2026-11-09)」 — 사진 빠른 길의 작은 사진(t)을 첫 조회 전에 R2 에 만들어 둔다.
 *
 *   A) 업로드 직후 미리 만들기(imageWarm.scheduleUploadWarm)
 *      - 서명 열쇠 없음 = 아무 호출 0 · 사진 아님 = 0
 *      - 허용 목록에 기록된 뒤에만 부른다(fresh 판정 — 거절은 기억하지 않는다) · 아직 기록 전이면 1회만 다시
 *      - 실패는 삼킨다(업로드 응답·프로세스에 영향 0) · 동시 수 상한 · 대기열 상한 넘치면 버린다
 *      - 호출 주소 = PUBLIC_ORIGIN(없으면 pages.dev) + 서버 서명 주소(/img/t/…) — Function 이 R2 에 담는다
 *   B) imageAllowlist.checkFresh — 거절을 기억하지 않고, 기억된 거절도 무시한다(업로드 직후 화면이 5초 404 를 먹지 않게)
 *   C) 단일 지점 — drive.service.uploadFileBase64 가 업로드 성공 뒤 훅을 부른다(실패한 업로드는 0)
 *      + 업로드 자리 전수(새로 생기면 이 시험이 알린다) + drive 업로드는 drive.service 밖에서 하지 않는다
 *   D) 일괄 스크립트(scripts/img-warm.js) — PGlite 로 실제 SQL: 최근 N일·중복 제거·최신순·이체결과 제외·
 *      삭제된 주문 제외 · --dry-run 은 호출 0 · 읽기 전용 트랜잭션 · 출력에 파일 번호 없음 · 적중/생성/건너뜀/실패 세기
 *   E) 스크립트 출처 표가 허용 목록 출처를 전부 다룬다(새 출처가 생기면 알린다) + 시각 칸이 실제 마이그레이션에 있다
 *
 * 실행: node tests/imageWarm.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const KEY = 's'.repeat(48);
delete process.env.IMG_SIGNING_KEY;
delete process.env.PUBLIC_ORIGIN;
delete process.env.DRIVE_OAUTH_CLIENT_ID;
delete process.env.DRIVE_OAUTH_CLIENT_SECRET;
delete process.env.DRIVE_OAUTH_REFRESH_TOKEN;

// drive.service 는 sheets.service 의 drive 를 읽기 클라이언트로 쓴다 — 가짜로 바꾼다(외부 호출 0).
let UPLOAD_FAIL = false;
const fakeDrive = {
  files: {
    create: async (p) => {
      if (UPLOAD_FAIL) throw new Error('upload failed');
      return { data: { id: 'UPLOADED_' + 'x'.repeat(24), name: p.requestBody.name } };
    },
  },
  permissions: { create: async () => ({ data: {} }) },
  about: { get: async () => ({ data: { user: { emailAddress: 'sa@x' } } }) },
};
const sheetsPath = require.resolve(path.join(SERVER, 'src/services/sheets.service'));
require.cache[sheetsPath] = {
  id: sheetsPath, filename: sheetsPath, loaded: true,
  exports: { drive: fakeDrive, sheets: {}, throttledCall: async (f) => f(), driveThrottledCall: async (f) => f() },
};

const warm = require(path.join(SERVER, 'src/services/imageWarm.service'));
const allow = require(path.join(SERVER, 'src/services/imageAllowlist.service'));
const edge = require(path.join(SERVER, 'src/services/imageEdge.service'));
const imgWarmScript = require(path.join(SERVER, 'scripts/img-warm.js'));

const ID = (n) => ('PHOTO' + n + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2').slice(0, 30);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 20; i++) await sleep(2); }

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    return handler ? handler(url, init) : new Response('x', { status: 200, headers: { 'Content-Type': 'image/webp', 'X-Img-Src': 'origin' } });
  };
  fn.calls = calls;
  return fn;
}
function withKey(fn) {
  return async () => {
    process.env.IMG_SIGNING_KEY = KEY;
    try { await fn(); } finally { delete process.env.IMG_SIGNING_KEY; delete process.env.PUBLIC_ORIGIN; warm.__resetForTest(); }
  };
}

// ═══ A. 업로드 직후 미리 만들기 ═══
test('A1 서명 열쇠가 없으면 아무것도 부르지 않는다(판정·호출 0)', async () => {
  let checks = 0;
  const f = fakeFetch();
  warm.__setDepsForTest({ fetch: f, checkFresh: async () => { checks++; return { ok: true }; }, firstDelayMs: 0, retryDelayMs: 0 });
  assert.equal(warm.scheduleUploadWarm(ID(1), 'image/jpeg'), false);
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(checks, 0);
  warm.__resetForTest();
});

test('A2 사진이 아니거나 번호 형식이 틀리면 부르지 않는다', withKey(async () => {
  const f = fakeFetch();
  warm.__setDepsForTest({ fetch: f, checkFresh: async () => ({ ok: true }), firstDelayMs: 0, retryDelayMs: 0 });
  assert.equal(warm.scheduleUploadWarm(ID(2), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), false);
  assert.equal(warm.scheduleUploadWarm(ID(2), 'text/csv'), false);
  assert.equal(warm.scheduleUploadWarm('short', 'image/png'), false);
  await settle();
  assert.equal(f.calls.length, 0);
}));

test('A3 허용 목록 통과 뒤 서명 주소(PUBLIC_ORIGIN + /img/t/…)를 한 번 GET 한다', withKey(async () => {
  process.env.PUBLIC_ORIGIN = 'https://example-front.test/';
  const f = fakeFetch();
  const asked = [];
  warm.__setDepsForTest({ fetch: f, checkFresh: async (id) => { asked.push(id); return { ok: true }; }, firstDelayMs: 0, retryDelayMs: 0 });
  assert.equal(warm.scheduleUploadWarm(ID(3), 'image/jpeg'), true);
  await settle();
  assert.deepEqual(asked, [ID(3)]);
  assert.equal(f.calls.length, 1);
  const u = new URL(f.calls[0]);
  assert.equal(u.origin, 'https://example-front.test');
  assert.equal(u.pathname, `/img/t/${ID(3)}`);
  const signed = edge.signImage(ID(3), 't');
  assert.equal(u.pathname + u.search, signed, '서버 서명 단일 출처(imageEdge.signImage)를 그대로 쓴다');
  assert.equal(warm.__stats().made, 1);
}));

test('A3b PUBLIC_ORIGIN 이 없으면 운영 프론트(pages.dev)', withKey(async () => {
  const f = fakeFetch();
  warm.__setDepsForTest({ fetch: f, checkFresh: async () => ({ ok: true }), firstDelayMs: 0, retryDelayMs: 0 });
  warm.scheduleUploadWarm(ID(4), 'image/png');
  await settle();
  assert.equal(new URL(f.calls[0]).origin, 'https://review-web-system.pages.dev');
}));

test('A4 아직 DB 기록 전(거절)이면 1회만 다시 본다 — 두 번째에 통과하면 GET, 끝내 거절이면 호출 0', withKey(async () => {
  const f = fakeFetch();
  let n = 0;
  warm.__setDepsForTest({ fetch: f, checkFresh: async () => (++n >= 2 ? { ok: true } : { ok: false }), firstDelayMs: 0, retryDelayMs: 0 });
  warm.scheduleUploadWarm(ID(5), 'image/jpeg');
  await settle();
  assert.equal(n, 2);
  assert.equal(f.calls.length, 1);

  const g = fakeFetch();
  let m = 0;
  warm.__setDepsForTest({ fetch: g, checkFresh: async () => { m++; return { ok: false }; }, firstDelayMs: 0, retryDelayMs: 0 });
  warm.scheduleUploadWarm(ID(6), 'image/jpeg');
  await settle();
  assert.equal(m, 2, '다시 보기는 1회만');
  assert.equal(g.calls.length, 0);
}));

test('A5 판정 조회 실패(fail-open)는 미리 만들지 않는다(서명 입구와 같은 규칙)', withKey(async () => {
  const f = fakeFetch();
  warm.__setDepsForTest({ fetch: f, checkFresh: async () => ({ ok: true, failOpen: true }), firstDelayMs: 0, retryDelayMs: 0 });
  warm.scheduleUploadWarm(ID(7), 'image/jpeg');
  await settle();
  assert.equal(f.calls.length, 0);
}));

test('A6 실패는 삼킨다 — 호출이 던지거나 판정이 던지거나 5xx 여도 unhandled 0', withKey(async () => {
  const unhandled = [];
  const onU = (e) => unhandled.push(e);
  process.on('unhandledRejection', onU);
  try {
    warm.__setDepsForTest({ fetch: async () => { throw new Error('network down'); }, checkFresh: async () => ({ ok: true }), firstDelayMs: 0, retryDelayMs: 0 });
    warm.scheduleUploadWarm(ID(8), 'image/jpeg');
    await settle();
    warm.__setDepsForTest({ fetch: async () => new Response('busy', { status: 502 }), checkFresh: async () => ({ ok: true }) });
    warm.scheduleUploadWarm(ID(9), 'image/jpeg');
    await settle();
    const f = fakeFetch();
    warm.__setDepsForTest({ fetch: f, checkFresh: async () => { throw new Error('db down'); } });
    warm.scheduleUploadWarm(ID(10), 'image/jpeg');
    await settle();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(unhandled, []);
    assert.ok(warm.__stats().failed >= 2);
  } finally { process.off('unhandledRejection', onU); }
}));

test('A7 동시 수 상한(WARM_MAX) · 대기열 상한 넘치면 버린다', withKey(async () => {
  let active = 0, peak = 0;
  const release = [];
  const f = async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => release.push(r));
    active--;
    return new Response('x', { status: 200, headers: { 'Content-Type': 'image/webp', 'X-Img-Src': 'origin' } });
  };
  warm.__setDepsForTest({ fetch: f, checkFresh: async () => ({ ok: true }), firstDelayMs: 0, retryDelayMs: 0, queueMax: 3 });
  for (let i = 0; i < 10; i++) warm.scheduleUploadWarm(ID(100 + i), 'image/jpeg');
  await settle();
  assert.equal(peak, warm.WARM_MAX);
  assert.equal(warm.__stats().dropped, 10 - warm.WARM_MAX - 3);
  while (release.length) { release.shift()(); await settle(); }
  assert.equal(peak, warm.WARM_MAX);
  assert.equal(warm.__stats().made, warm.WARM_MAX + 3);
}));

test('A8 응답 출처 헤더로 이미 있음(r2·edge) / 새로 만듦(origin) / 건너뜀(404) / 실패를 가른다', withKey(async () => {
  const mk = (status, src) => async () => new Response('x', { status, headers: src ? { 'X-Img-Src': src, 'Content-Type': 'image/webp' } : {} });
  assert.equal(await warm.warmOne(ID(11), { fetch: mk(200, 'r2') }), 'hit');
  assert.equal(await warm.warmOne(ID(11), { fetch: mk(200, 'edge') }), 'hit');
  assert.equal(await warm.warmOne(ID(11), { fetch: mk(200, 'origin') }), 'made');
  assert.equal(await warm.warmOne(ID(11), { fetch: mk(404) }), 'skip');
  assert.equal(await warm.warmOne(ID(11), { fetch: mk(502) }), 'fail');
  assert.equal(await warm.warmOne(ID(11), { fetch: async () => { throw new Error('x'); } }), 'fail');
  delete process.env.IMG_SIGNING_KEY;
  let called = 0;
  assert.equal(await warm.warmOne(ID(11), { fetch: async () => { called++; } }), 'off');
  assert.equal(called, 0);
}));

// ═══ B. 거절을 기억하지 않는 판정 ═══
test('B checkFresh 는 거절을 기억하지 않고, 기억된 거절도 무시한다', async () => {
  let allowed = false, queries = 0;
  allow.__setPoolForTest({ query: async () => { queries++; return { rows: [{ private: false, allowed }] }; } });
  allow.__resetCacheForTest();
  try {
    const id = ID(20);
    assert.equal((await allow.checkFresh(id)).ok, false);
    allowed = true;
    // 업로드 직후 거절을 기억했다면 이 판정이 5초 동안 404 가 된다
    assert.equal((await allow.checkDriveImage(id)).ok, true, 'fresh 거절이 기억되어 화면 판정이 막혔다');
    // 반대: 화면 판정이 거절을 기억해 둔 상태에서도 fresh 는 다시 본다
    const id2 = ID(21);
    allowed = false;
    assert.equal((await allow.checkDriveImage(id2)).ok, false);
    allowed = true;
    const before = queries;
    assert.equal((await allow.checkFresh(id2)).ok, true);
    assert.ok(queries > before);
    // 통과는 기억한다 → Function 이 부르는 내부 입구 판정이 바로 끝난다
    const q2 = queries;
    assert.equal((await allow.checkDriveImage(id2)).ok, true);
    assert.equal(queries, q2);
    // guide 통로(가이드 사진)도 본다
    let guideOnly = true;
    allow.__setPoolForTest({ query: async (sql) => ({ rows: [{ private: false, allowed: guideOnly && /guide_image_files/.test(sql) }] }) });
    allow.__resetCacheForTest();
    assert.equal((await allow.checkFresh(ID(22))).ok, true);
    // 조회 실패 = failOpen 표시(미리 만들기는 이것을 건너뛴다)
    allow.__setPoolForTest({ query: async () => { throw new Error('db down'); } });
    allow.__resetCacheForTest();
    const v = await allow.checkFresh(ID(23));
    assert.equal(v.failOpen, true);
  } finally { allow.__setPoolForTest(null); allow.__resetCacheForTest(); }
});

// ═══ C. 단일 지점 + 업로드 자리 전수 ═══
test('C1 drive.service.uploadFileBase64 가 업로드 성공 뒤 (번호, 형식)으로 훅을 부른다 · 실패한 업로드는 0', async () => {
  const D = require(path.join(SERVER, 'src/services/drive.service'));
  const seen = [];
  const orig = warm.scheduleUploadWarm;
  warm.scheduleUploadWarm = (id, mime) => { seen.push([id, mime]); return false; };
  try {
    const r = await D.uploadFileBase64('QUJD', 'a.jpg', 'image/jpeg', 'FOLDER1', { shareAnyone: false });
    assert.deepEqual(seen, [[r.id, 'image/jpeg']]);
    UPLOAD_FAIL = true;
    await assert.rejects(() => D.uploadFileBase64('QUJD', 'b.jpg', 'image/jpeg', 'FOLDER1', { shareAnyone: false }));
    assert.equal(seen.length, 1);
    // 훅이 던져도 업로드 결과는 그대로
    UPLOAD_FAIL = false;
    warm.scheduleUploadWarm = () => { throw new Error('boom'); };
    const r2 = await D.uploadFileBase64('QUJD', 'c.jpg', 'image/jpeg', 'FOLDER1', { shareAnyone: false });
    assert.ok(r2.id);
  } finally { warm.scheduleUploadWarm = orig; UPLOAD_FAIL = false; }
});

// 드라이브에 파일을 올리는 자리 전부. 새 자리가 생기면 여기서 실패한다 —
//   사진이면 uploadFileBase64 의 훅이 자동으로 데우지만, 그 번호를 허용 목록 출처 칸에 쓰는지 확인하고 더한다.
const UPLOAD_SITES = {
  'src/routes/cs.routes.js': 'C/S 첨부 사진(guide 허용 목록)',
  'src/routes/diag.routes.js': '구매캡처·리뷰캡처 업로드(order_submissions·review_submissions)',
  'src/routes/order.routes.js': '가이드·공고 사진(guide 허용 목록)',
  'src/routes/reviewEdit.routes.js': '리뷰 수정 요청 새 사진(review_edit_requests.new_file_id)',
  'src/routes/reviewer.routes.js': '리뷰어 문의 첨부 사진(guide 허용 목록)',
  'src/services/dualChannelReview.service.js': '동시진행 리뷰 사진(review_submissions)',
  'src/services/dualPurchaseArtifacts.service.js': '동시진행 구매캡처 교체(purchase_capture_artifacts)',
  'src/services/dualPurchaseSubmission.service.js': '동시진행 구매캡처(purchase_capture_artifacts)',
  'src/services/dualStaffSubmission.service.js': '동시진행 대리 접수(purchase_capture_artifacts)',
  'src/services/paymentResultArchive.service.js': '★ 이체결과 보관(엑셀·CSV — 사진 아님, 훅이 형식으로 거른다 · 허용 판정도 거절)',
  'src/services/purchaseCaptureReplace.service.js': '구매캡처 교체(order_submissions)',
  'src/services/purchaseCaptureSelfService.service.js': '추가 구매사진(purchase_capture_supplements.file_id)',
  'src/services/reviewCaptureReplace.service.js': '리뷰캡처 교체(review_submissions)',
};
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
  });
}
test('C2 드라이브 업로드 자리 전수 — 새 자리가 생기면 알린다 · 업로드는 drive.service 밖에서 하지 않는다', () => {
  const files = walk(path.join(SERVER, 'src'));
  const rel = (p) => path.relative(SERVER, p).split(path.sep).join('/');
  const callers = files.filter(p => rel(p) !== 'src/services/drive.service.js' && /uploadFileBase64\s*\(/.test(fs.readFileSync(p, 'utf8')))
    .map(rel).sort();
  assert.deepEqual(callers, Object.keys(UPLOAD_SITES).sort(),
    '드라이브 업로드 자리가 바뀌었다 — 사진이면 그 번호를 허용 목록 출처 칸에 쓰는지 보고 UPLOAD_SITES 에 더하라(결정 354 미리 만들기)');
  // 다른 길(files.create 직접 호출 · 브라우저 직접 업로드용 resumable)로 올리면 훅을 건너뛴다
  const bypass = files.filter(p => rel(p) !== 'src/services/drive.service.js')
    .filter(p => /\.files\.create\s*\(|uploadType\s*[:=]\s*['"]resumable/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert.deepEqual(bypass, []);
  // 훅은 업로드 성공 로그 뒤, 돌려주기 전에 있다(성공한 업로드만)
  const ds = fs.readFileSync(path.join(SERVER, 'src/services/drive.service.js'), 'utf8');
  const fnStart = ds.indexOf('async function uploadFileBase64');
  const fnEnd = ds.indexOf('\n}\n', fnStart);
  const body = ds.slice(fnStart, fnEnd);
  const at = body.indexOf('scheduleUploadWarm');
  assert.ok(at > body.indexOf('업로드 성공'), '훅은 업로드 성공 뒤에');
});

// ═══ D. 일괄 스크립트 ═══
async function pgliteFixture() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE review_submissions (file_id TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE order_submissions (capture_file_id TEXT, capture_file_id_2 TEXT, capture_uploaded_at TIMESTAMPTZ,
      capture2_uploaded_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
    CREATE TABLE review_index (review_file_id TEXT, review_file_at TIMESTAMPTZ);
    CREATE TABLE review_inspections (file_id TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE review_edit_requests (old_file_id TEXT, new_file_id TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE purchase_capture_artifacts (file_id TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE purchase_capture_supplements (file_id TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE purchase_submission_sessions (capture_file_id TEXT, created_at TIMESTAMPTZ);
    CREATE TABLE reviewer_event_logs (context JSONB, occurred_at TIMESTAMPTZ);
    CREATE TABLE guide_image_files (file_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ);
    CREATE TABLE payment_result_drive_archive (drive_file_id TEXT);
  `);
  const d = (n) => `now() - interval '${n} days'`;
  await db.exec(`
    INSERT INTO review_submissions VALUES ('${ID(1)}', ${d(1)}), ('${ID(2)}', ${d(90)}), ('', ${d(1)}), (NULL, ${d(1)});
    INSERT INTO order_submissions VALUES ('${ID(3)}', '${ID(4)}', ${d(2)}, NULL, ${d(3)}, NULL),
                                         ('${ID(5)}', NULL, ${d(2)}, NULL, ${d(2)}, now());
    INSERT INTO review_index VALUES ('${ID(1)}', ${d(5)});
    INSERT INTO review_inspections VALUES ('${ID(6)}', ${d(10)});
    INSERT INTO review_edit_requests VALUES ('${ID(7)}', '${ID(8)}', ${d(4)});
    INSERT INTO purchase_capture_artifacts VALUES ('${ID(9)}', ${d(6)});
    INSERT INTO purchase_submission_sessions VALUES ('${ID(3)}', ${d(2)});
    INSERT INTO reviewer_event_logs VALUES ('{"fileId":"${ID(10)}"}', ${d(7)}), ('{"other":1}', ${d(1)});
    INSERT INTO guide_image_files VALUES ('${ID(11)}', ${d(8)}), ('${ID(12)}', ${d(3)});
    INSERT INTO payment_result_drive_archive VALUES ('${ID(12)}');
  `);
  return db;
}

test('D1 최근 N일 사진 번호 — 출처 전부 · 중복 제거 · 최신순 · 이체결과·삭제 주문·빈 값 제외 · limit', async () => {
  const db = await pgliteFixture();
  try {
    const ids = await warm.collectRecentIds(db, { days: 60 });
    assert.deepEqual(ids, [ID(1), ID(3), ID(4), ID(7), ID(8), ID(9), ID(10), ID(11), ID(6)]);
    assert.ok(!ids.includes(ID(2)), '60일 넘은 것');
    assert.ok(!ids.includes(ID(5)), '삭제된 주문');
    assert.ok(!ids.includes(ID(12)), '이체결과 보관 파일');
    assert.deepEqual(await warm.collectRecentIds(db, { days: 60, limit: 2 }), [ID(1), ID(3)]);
    assert.equal((await warm.collectRecentIds(db, { days: 100 })).length, 10);
  } finally { await db.close(); }
});

test('D1b 추가 구매사진도 기존 최근 사진 수집에 포함한다', async () => {
  const db = await pgliteFixture();
  try {
    await db.query('INSERT INTO purchase_capture_supplements VALUES ($1, now())', [ID(13)]);
    const ids = await warm.collectRecentIds(db, { days: 60 });
    assert.equal(ids[0], ID(13));
    assert.equal(ids.length, 10);
  } finally { await db.close(); }
});

function captureLog() { const lines = []; const log = (...a) => lines.push(a.join(' ')); log.lines = lines; return log; }

test('D2 --dry-run: 읽기 전용 트랜잭션으로 세기만 · 호출 0 · 출력에 파일 번호 없음 · 열쇠 없어도 된다', async () => {
  const db = await pgliteFixture();
  try {
    const sent = [];
    const spy = { query: (sql, p) => { sent.push(String(sql)); return db.query(sql, p); } };
    const f = fakeFetch();
    const log = captureLog();
    const r = await imgWarmScript.main(['--dry-run', '--days', '60'], { db: spy, fetch: f, log, env: {} });
    assert.equal(r.total, 9);
    assert.equal(f.calls.length, 0);
    assert.match(sent[0], /default_transaction_read_only\s*=\s*on/i);
    assert.ok(sent.some(s => /BEGIN READ ONLY/i.test(s)));
    const out = log.lines.join('\n');
    for (let i = 1; i <= 12; i++) assert.ok(!out.includes(ID(i)), '출력에 파일 번호가 나왔다');
    assert.match(out, /9/);
  } finally { await db.close(); }
});

test('D3 실제 실행: 동시 수 상한 · 이미 있음/새로 만듦/건너뜀/실패 세기 · 열쇠 없으면 거부', async () => {
  const db = await pgliteFixture();
  try {
    const log = captureLog();
    await assert.rejects(() => imgWarmScript.main(['--days', '60'], { db, fetch: fakeFetch(), log, env: {} }), /IMG_SIGNING_KEY/);
    let active = 0, peak = 0, n = 0;
    const kinds = ['r2', 'edge', 'origin', 404, 502];
    const f = async (url) => {
      assert.match(String(url), /^https:\/\/review-web-system\.pages\.dev\/img\/t\/[-\w]+\?e=\d+&s=[-\w]{43}$/);
      active++; peak = Math.max(peak, active);
      await sleep(5);
      active--;
      const k = kinds[n++ % kinds.length];
      if (typeof k === 'number') return new Response('x', { status: k });
      return new Response('x', { status: 200, headers: { 'X-Img-Src': k, 'Content-Type': 'image/webp' } });
    };
    const r = await imgWarmScript.main(['--days', '60', '--concurrency', '3'], { db, fetch: f, log, env: { IMG_SIGNING_KEY: KEY } });
    assert.equal(peak, 3);
    assert.equal(r.total, 9);
    assert.deepEqual({ hit: r.hit, made: r.made, skip: r.skip, fail: r.fail }, { hit: 4, made: 2, skip: 2, fail: 1 });
    const out = log.lines.join('\n');
    for (let i = 1; i <= 12; i++) assert.ok(!out.includes(ID(i)));
    // 동시 수 기본 4 · 상한 6(원본 서버 내부 입구 동시 12 안쪽)
    assert.equal(imgWarmScript.parseArgs([]).concurrency, 4);
    assert.equal(imgWarmScript.parseArgs(['--concurrency', '50']).concurrency, 6);
    assert.equal(imgWarmScript.parseArgs([]).days, 60);
  } finally { await db.close(); }
});

// ═══ E. 출처 표 드리프트 ═══
test('E 스크립트 출처 표가 허용 목록 출처를 전부 다룬다 · 시각 칸이 실제 마이그레이션에 있다', () => {
  const key = (s) => `${s.table}.${s.column || s.expr}`;
  const listed = new Set(warm.WARM_SOURCES.map(key).concat(warm.WARM_SKIPPED.map(key)));
  const missing = allow.DRIVE_IMAGE_SOURCES.concat(allow.GUIDE_IMAGE_SOURCES).map(key).filter(k => !listed.has(k));
  assert.deepEqual(missing, [], '허용 목록에 새 출처가 생겼다 — 미리 만들기 출처 표(WARM_SOURCES)에 시각 칸과 함께 더하라');
  const sql = fs.readdirSync(path.join(SERVER, 'migrations')).filter(f => f.endsWith('.sql'))
    .map(f => fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8')).join('\n').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
  for (const s of warm.WARM_SOURCES) {
    for (const col of s.timeColumns) {
      const ok = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${s.table} ?\\([^;]*[(,] ?${col} `, 'i').test(sql)
        || new RegExp(`ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${s.table} [^;]*ADD COLUMN (?:IF NOT EXISTS )?${col} `, 'i').test(sql);
      assert.ok(ok, `${s.table}.${col} 은 실제 마이그레이션이 만든 칸이 아니다`);
    }
  }
});
