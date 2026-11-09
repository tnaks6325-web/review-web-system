'use strict';
/**
 * 결정 352 — 무인증 사진 통로 2곳(`GET /api/drive/image/:id`, `GET /api/order/guide-image/:id`)은
 *   "우리 DB 에 기록된 파일 번호"만 내준다. 목록 밖 번호는 **드라이브 읽기 0** 으로 404,
 *   이체결과 보관 파일(리뷰어 이름·계좌 전체, 결정 316)은 어디에 함께 적혀 있어도 거절.
 *
 * 실제 라우터(drive.routes · order.routes)를 express 에 올리고, DB 는 PGlite(실제 SQL 엔진),
 * 드라이브는 가짜(호출 횟수를 센다)로 바꿔 돌린다. 외부 네트워크 0.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

process.env.ORDER_INTAKE_KEY = 'test-intake-key';
process.env.GUIDE_FOLDER_ID = 'guide-folder-test';
process.env.PUBLIC_API_URL = 'https://api.example.test';

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..');
const drive = require(path.join(SERVER, 'src/services/drive.service'));
const allow = require(path.join(SERVER, 'src/services/imageAllowlist.service'));

const reads = [];
drive.downloadFile = async (id) => {
  reads.push(id);
  const xlsx = id.startsWith('XLSX');
  return { buffer: Buffer.from('IMG:' + id), mimeType: xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'image/png', name: id };
};
let upSeq = 0;
drive.uploadFileBase64 = async () => ({ id: 'UPLOADEDguide' + (++upSeq) + 'x'.repeat(20) });
drive.ensureFolderPath = async () => ({ id: 'folder' });

const id = (tag) => (tag + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3').slice(0, 33);

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

const db = new PGlite();
let queryCount = 0;
const countingDb = { query: (...a) => { queryCount++; return db.query(...a); } };

(async () => {
  // ── 출처 표(운영 칸 이름 그대로, 필요한 칸만) ──
  await db.exec(`
    CREATE TABLE review_submissions (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL);
    CREATE UNIQUE INDEX uq_review_sub_file ON review_submissions(file_id);
    CREATE TABLE order_submissions (id SERIAL PRIMARY KEY, capture_file_id TEXT, capture_file_id_2 TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE review_index (id SERIAL PRIMARY KEY, review_file_id TEXT);
    CREATE INDEX idx_review_file_id ON review_index(review_file_id);
    CREATE TABLE review_inspections (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL);
    CREATE UNIQUE INDEX uq_review_inspect_file ON review_inspections(file_id);
    CREATE TABLE review_edit_requests (id SERIAL PRIMARY KEY, old_file_id TEXT, new_file_id TEXT);
    CREATE TABLE purchase_capture_artifacts (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL);
    CREATE INDEX idx_purchase_artifact_file ON purchase_capture_artifacts(file_id);
    CREATE TABLE purchase_capture_supplements (file_id TEXT PRIMARY KEY);
    CREATE TABLE purchase_submission_sessions (id SERIAL PRIMARY KEY, capture_file_id TEXT);
    CREATE TABLE reviewer_event_logs (id SERIAL PRIMARY KEY, context JSONB NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE payment_result_drive_archive (file_sha256 TEXT PRIMARY KEY, drive_file_id TEXT);
    CREATE TABLE payment_result_uploads (id SERIAL PRIMARY KEY, file_blob BYTEA, file_name TEXT);
    CREATE TABLE work_orders (id SERIAL PRIMARY KEY, guide_images TEXT DEFAULT '', review_guide TEXT DEFAULT '');
    CREATE TABLE cs_messages (id SERIAL PRIMARY KEY, image_urls JSONB NOT NULL DEFAULT '[]'::jsonb);
    CREATE TABLE campaign_options (id SERIAL PRIMARY KEY, inflow_guide_images JSONB NOT NULL DEFAULT '[]'::jsonb, thumbnail_url TEXT);
  `);
  const G = (x) => `https://api.example.test/api/order/guide-image/${x}`;
  const ids = {
    rs: id('RS'), os1: id('OS1'), os2: id('OS2'), ri: id('RI'), insp: id('INSP'),
    reOld: id('REOLD'), reNew: id('RENEW'), pca: id('PCA'), pcs: id('PCS'), pss: id('PSS'),
    logCtx: id('LOGCTX'), sample: id('SAMPLE'),
    pay: id('PAY'), payAlsoRs: id('PAYRS'),
    gWo: id('GWO'), gWoGuide: id('GWOG'), gCs: id('GCS'), gOpt: id('GOPT'), gThumb: id('GTHUMB'), gSet: id('GSET'),
    unknown: id('UNKNOWN'),
  };
  await db.query('INSERT INTO review_submissions(file_id) VALUES ($1),($2)', [ids.rs, ids.payAlsoRs]);
  await db.query('INSERT INTO order_submissions(capture_file_id, capture_file_id_2) VALUES ($1,$2)', [ids.os1, ids.os2]);
  await db.query('INSERT INTO review_index(review_file_id) VALUES ($1)', [ids.ri]);
  await db.query('INSERT INTO review_inspections(file_id) VALUES ($1)', [ids.insp]);
  await db.query('INSERT INTO review_edit_requests(old_file_id,new_file_id) VALUES ($1,$2)', [ids.reOld, ids.reNew]);
  await db.query('INSERT INTO purchase_capture_artifacts(file_id) VALUES ($1)', [ids.pca]);
  await db.query('INSERT INTO purchase_capture_supplements(file_id) VALUES ($1)', [ids.pcs]);
  await db.query('INSERT INTO purchase_submission_sessions(capture_file_id) VALUES ($1)', [ids.pss]);
  await db.query(`INSERT INTO reviewer_event_logs(context) VALUES (jsonb_build_object('fileId', $1::text))`, [ids.logCtx]);
  await db.query(`INSERT INTO app_settings(key,value) VALUES ('review_inspect_sample_x', $1)`,
    [JSON.stringify([`https://api.example.test/api/drive/image/${ids.sample}`])]);
  await db.query(`INSERT INTO app_settings(key,value) VALUES ('cash_receipt_guide_coupang', $1)`, [G(ids.gSet)]);
  await db.query('INSERT INTO payment_result_drive_archive(file_sha256, drive_file_id) VALUES ($1,$2),($3,$4)',
    ['sha1', ids.pay, 'sha2', ids.payAlsoRs]);
  // 비공개 이체결과 파일 내용(bytea)에 guide-image 주소 모양이 있어도 들여오지 않는다.
  await db.query('INSERT INTO payment_result_uploads(file_blob, file_name) VALUES ($1, $2)',
    [Buffer.from(G(id('BLOB'))), 'x.xlsx']);
  await db.query('INSERT INTO work_orders(guide_images, review_guide) VALUES ($1, $2)',
    [G(ids.gWo), `안내문\n[유입가이드 첨부 이미지]\n${G(ids.gWoGuide)}\n끝`]);
  await db.query('INSERT INTO cs_messages(image_urls) VALUES ($1::jsonb)', [JSON.stringify([G(ids.gCs)])]);
  await db.query('INSERT INTO campaign_options(inflow_guide_images, thumbnail_url) VALUES ($1::jsonb, $2)',
    [JSON.stringify([{ url: G(ids.gOpt) }]), G(ids.gThumb)]);

  // ── 실제 마이그레이션 ──
  await db.exec(fs.readFileSync(path.join(SERVER, 'migrations/216_image_allowlist.sql'), 'utf8'));
  allow.__setPoolForTest(countingDb);

  // ── 실제 라우터 ──
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/drive', require(path.join(SERVER, 'src/routes/drive.routes')));
  app.use('/api/order', require(path.join(SERVER, 'src/routes/order.routes')));
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => {
    const r = await fetch(base + p, { redirect: 'manual' });
    return { s: r.status, cc: r.headers.get('cache-control'), loc: r.headers.get('location'), body: await r.text() };
  };
  const D = (x) => get('/api/drive/image/' + x);
  const GI = (x) => get('/api/order/guide-image/' + x);

  try {
    await t('drive/image: 화면이 번호를 얻는 출처마다 1개씩 허용(200 + 드라이브 1회 + 기존 캐시 헤더)', async () => {
      for (const k of ['rs', 'os1', 'os2', 'ri', 'insp', 'reOld', 'reNew', 'pca', 'pcs', 'pss', 'logCtx', 'sample']) {
        reads.length = 0;
        const r = await D(ids[k]);
        assert.equal(r.s, 200, k + ' 허용이어야 한다');
        assert.equal(r.body, 'IMG:' + ids[k]);
        assert.equal(r.cc, 'private, max-age=600', '캐시 헤더 불변');
        assert.deepEqual(reads, [ids[k]], k + ' 드라이브 왕복 1회(결정 008)');
      }
    });

    await t('drive/image: 목록 밖 번호 → 404, 드라이브 읽기 0, 구글 썸네일로 돌리지도 않음', async () => {
      reads.length = 0;
      const r = await D(ids.unknown);
      assert.equal(r.s, 404); assert.equal(r.loc, null); assert.equal(reads.length, 0);
      assert.equal(r.cc, 'no-store', '거절은 브라우저에 남기지 않는다');
    });

    await t('drive/image: 이체결과 보관 파일 → 404(리뷰 제출 표에 같이 적혀 있어도), 드라이브 읽기 0', async () => {
      reads.length = 0;
      assert.equal((await D(ids.pay)).s, 404);
      assert.equal((await D(ids.payAlsoRs)).s, 404);
      assert.equal(reads.length, 0);
    });

    await t('drive/image: 가이드 이미지 번호는 이 통로로 안 열림(통로별 목록 분리)', async () => {
      reads.length = 0;
      assert.equal((await D(ids.gWo)).s, 404);
      assert.equal(reads.length, 0);
    });

    await t('guide-image: 주소가 저장된 출처(오더 가이드·본문·C/S 첨부·선택지 가이드·썸네일·설정)마다 허용', async () => {
      for (const k of ['gWo', 'gWoGuide', 'gCs', 'gOpt', 'gThumb', 'gSet']) {
        reads.length = 0;
        const r = await GI(ids[k]);
        assert.equal(r.s, 200, k + ' 허용이어야 한다');
        assert.equal(r.cc, 'public, max-age=3600', '캐시 헤더 불변');
        assert.deepEqual(reads, [ids[k]]);
      }
    });

    await t('guide-image: 구매·리뷰 캡처 번호·목록 밖·이체결과 → 404, 드라이브 읽기 0', async () => {
      reads.length = 0;
      for (const x of [ids.rs, ids.os1, ids.unknown, ids.pay]) assert.equal((await GI(x)).s, 404, x);
      assert.equal(reads.length, 0);
    });

    await t('guide-image: 이체결과 파일 내용(bytea) 속 주소 모양은 들여오지 않음', async () => {
      const r = await db.query(`SELECT count(*)::int AS n FROM guide_image_files WHERE file_id LIKE 'BLOB%'`);
      assert.equal(r.rows[0].n, 0);
    });

    await t('guide-image: 새로 올린 사진(인트라넷 키)은 올린 즉시 열림 — 목록 등록이 응답보다 먼저', async () => {
      const up = await fetch(base + '/api/order/guide-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intake-Key': 'test-intake-key' },
        body: JSON.stringify({ imageBase64: Buffer.from('png').toString('base64'), mimeType: 'image/png' }),
      }).then(r => r.json());
      assert.equal(up.ok, true);
      const fid = up.id;
      const row = await db.query('SELECT source FROM guide_image_files WHERE file_id=$1', [fid]);
      assert.equal(row.rows.length, 1);
      reads.length = 0;
      assert.equal((await GI(fid)).s, 200);
      assert.equal((await D(fid)).s, 404, '가이드 업로드는 drive/image 목록에 들어가지 않는다');
    });

    await t('속도: 허용 판정은 번호별로 기억 — 같은 번호 두 번째부터 DB 조회 0', async () => {
      allow.__resetCacheForTest();
      queryCount = 0;
      await D(ids.rs); const afterFirst = queryCount;
      await D(ids.rs); await D(ids.rs);
      assert.equal(afterFirst, 1, '첫 판정 = 조회 1회');
      assert.equal(queryCount, 1, '두 번째부터 조회 0');
      // 동시에 여러 장이 같은 번호를 요청해도 조회는 1회(진행 중 판정 공유)
      allow.__resetCacheForTest(); queryCount = 0;
      await Promise.all([D(ids.os1), D(ids.os1), D(ids.os1)]);
      assert.equal(queryCount, 1);
    });

    await t('fail 방향: DB 조회 실패 → 사진(image/*)은 열고, 이체결과 같은 비사진 파일은 거절', async () => {
      allow.__resetCacheForTest();
      allow.__setPoolForTest({ query: async () => { throw new Error('db down'); } });
      reads.length = 0;
      assert.equal((await D(ids.unknown)).s, 200, '조회 실패는 사진을 막지 않는다(fail-open)');
      assert.equal((await D('XLSX' + ids.unknown.slice(4))).s, 404, '사진이 아니면 조회 실패 중에도 거절');
      assert.equal((await GI(ids.unknown)).s, 200);
      assert.equal((await GI('XLSX' + ids.unknown.slice(4))).s, 404);
      // 실패 판정은 기억하지 않는다 — DB 가 돌아오면 바로 정상 판정
      allow.__setPoolForTest(countingDb);
      reads.length = 0;
      assert.equal((await D(ids.unknown)).s, 404);
      assert.equal(reads.length, 0);
    });

    await t('EXPLAIN: 허용 판정의 출처 칸이 전부 인덱스를 탄다(PGlite)', async () => {
      await db.exec('SET enable_seqscan = off');
      for (const src of allow.DRIVE_IMAGE_SOURCES.concat(allow.PRIVATE_SOURCES, allow.GUIDE_IMAGE_SOURCES)) {
        if (src.smallTable) continue;   // app_settings — 수백 줄짜리 설정 표(아래에서 따로 확인)
        const plan = (await db.query(`EXPLAIN ${allow.__branchSql(src)}`, [ids.unknown])).rows.map(r => r['QUERY PLAN']).join('\n');
        assert.match(plan, /Index (Only )?Scan|Bitmap Index Scan/, `${src.table}.${src.column || src.expr} 인덱스 미사용:\n${plan}`);
      }
      await db.exec('RESET enable_seqscan');
    });
  } finally {
    srv.close();
  }

  // ── 회귀가드: 출처 목록 ↔ 판정 SQL ↔ 마이그레이션 인덱스 ──
  await t('회귀가드: 화면이 사진 번호를 얻는 출처 칸 목록 = 허용 판정 SQL 의 칸 목록', async () => {
    // 결정 352 의 「화면 14곳 → 번호 출처」 표. 화면이 새 출처에서 번호를 받기 시작하면 여기와 서비스를 함께 고친다.
    const AUDITED = [
      'review_submissions.file_id',                 // 작업보드 미리보기·검수·리뷰 대신 제출·보고 페이지·리뷰어 수정 요청·C/S 카드
      'order_submissions.capture_file_id',          // 구매캡처 미리보기·교체 팝오버(order_capture 슬롯)
      'order_submissions.capture_file_id_2',        // 구매캡처 두 번째 장(결정 288)
      'review_index.review_file_id',                // 대표 리뷰 이미지 폴백·리뷰어 제출현황 썸네일
      'review_inspections.file_id',                 // 리뷰검수 카드·판별 예시 등록
      'review_edit_requests.old_file_id',           // C/S 교체요청 기존
      'review_edit_requests.new_file_id',           // C/S 교체요청 변경
      'purchase_capture_artifacts.file_id',         // 동시진행 구매처별 캡처
      'purchase_capture_supplements.file_id',       // 본인 추가 사진(원본 보존)
      'purchase_submission_sessions.capture_file_id', // 구매캡처 업로드 세션
      "reviewer_event_logs.(context->>'fileId')",   // 리뷰어 로그 펼침(_logCapFileId)
      'app_settings.value',                         // AI 판별 예시(주소째 저장)
    ];
    const got = allow.DRIVE_IMAGE_SOURCES.map(s => `${s.table}.${s.column || s.expr}`);
    assert.deepEqual(got, AUDITED);
    const sql = allow.__driveSql();
    for (const s of allow.DRIVE_IMAGE_SOURCES) assert.ok(sql.includes(` FROM ${s.table} `), s.table + ' 이 판정 SQL 에 없다');
    assert.ok(sql.includes('payment_result_drive_archive'), '이체결과 거절 칸이 판정 SQL 에 없다');
  });

  await t('회귀가드: 출처 칸마다 마이그레이션에 인덱스가 있다(작은 설정 표 제외)', async () => {
    const all = fs.readdirSync(path.join(SERVER, 'migrations')).filter(f => f.endsWith('.sql'))
      .map(f => fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8')).join('\n').replace(/\s+/g, ' ');
    for (const s of allow.DRIVE_IMAGE_SOURCES.concat(allow.PRIVATE_SOURCES, allow.GUIDE_IMAGE_SOURCES)) {
      if (s.smallTable) continue;
      const col = (s.column || s.expr).replace(/[()]/g, '\\$&');
      const re = new RegExp(`ON ${s.table} ?\\((?:\\(?\\s*)?${col}`, 'i');
      const pk = new RegExp(`CREATE TABLE IF NOT EXISTS ${s.table} \\( ?${s.column} TEXT PRIMARY KEY`, 'i');
      // Inline UNIQUE creates a real B-tree index too; keep checking its exact table/column.
      const inlineUnique = s.column && new RegExp(`CREATE TABLE IF NOT EXISTS ${s.table} \\( [^;]*?\\b${s.column} TEXT NOT NULL UNIQUE`, 'i');
      assert.ok(re.test(all) || pk.test(all) || (inlineUnique && inlineUnique.test(all)), `${s.table}.${s.column || s.expr} 인덱스 없음`);
    }
  });

  await t('회귀가드: 화면에서 drive/image 주소를 만드는 자리 수 고정(새 자리 = 출처 목록 재점검)', async () => {
    const files = ['frontend/workdesk.html', 'frontend/js/search-app.js', 'frontend/index.html',
      'frontend/js/cs-review-edit-card.js', 'frontend/report.html', 'frontend/js/reviewer-purchase-capture.js'];
    const count = files.map(f => (fs.readFileSync(path.join(REPO, f), 'utf8').match(/\/api\/drive\/image\/['`$]/g) || []).length);
    assert.deepEqual(count, [9, 2, 1, 1, 1, 1], '자리가 늘거나 줄었다 — 결정 352 표와 위 AUDITED 를 다시 맞춘다');
  });

  await t('회귀가드: 서버에서 guide-image 주소를 만드는 자리는 전부 목록 등록을 먼저 한다', async () => {
    const dir = path.join(SERVER, 'src');
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const sites = [];
    for (const f of walk(dir).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /\/api\/order\/guide-image\/\$\{/g; let m;
      while ((m = re.exec(src))) {
        const before = src.slice(Math.max(0, m.index - 600), m.index);
        sites.push(path.relative(SERVER, f));
        assert.match(before, /registerGuideImage\(/, `${path.relative(SERVER, f)} 가 주소를 만들기 전에 목록 등록을 안 한다`);
      }
    }
    assert.deepEqual(sites.sort(), ['src/routes/cs.routes.js', 'src/routes/order.routes.js', 'src/routes/reviewer.routes.js']);
  });

  await t('회귀가드: 부팅 점검에 목록 표 등록 · 서버 코드 req.user 미사용', async () => {
    const idx = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
    assert.match(idx, /REQUIRED_TABLES = \[[\s\S]*'guide_image_files'/);
    const svc = fs.readFileSync(path.join(SERVER, 'src/services/imageAllowlist.service.js'), 'utf8');
    assert.doesNotMatch(svc, /req\.user/);
  });

  console.log(`imageAllowlist: ${passed} tests passed (PGlite · 외부 네트워크 0)`);
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; })
  .finally(async () => { try { allow.__setPoolForTest(null); } catch (_) {} await db.close(); process.exit(process.exitCode || 0); });
