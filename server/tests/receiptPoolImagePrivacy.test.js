'use strict';
/**
 * receiptPoolImagePrivacy.test.js — 영수증리뷰 2단계 회귀가드: 영수증 사진은 비공개(결정 420 · 결정 352 거절 목록)
 * 실행: node tests/receiptPoolImagePrivacy.test.js
 *
 * 위험:
 *  ① 영수증 사진(결제 카드·시각이 찍힘)이 무인증 사진 통로(drive/image · guide-image)·엣지(354)로 열린다.
 *  ② 드라이브 「링크 있는 모든 사용자」 공개로 올라가 구글 썸네일 주소로 열린다.
 *  ③ 업체(광고주) 토큰·무인증 요청이 영수증을 올리거나 본다.
 *  ④ 직원·인트라넷 통로가 목록 밖 파일 번호(공개 사진·이체결과 파일)를 드라이브에서 꺼내 준다.
 * ★ 실제 라우터(order.routes · drive.routes · trackB.routes)를 express 에 올리고, DB 는 PGlite(저장소 migrations 그대로),
 *   드라이브는 가짜(호출·옵션을 기록)로 바꿔 돌린다. 외부 네트워크 0.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.ORDER_INTAKE_KEY = 'test-intake-key';
process.env.JWT_SECRET = 'test-jwt-secret-receipt';
process.env.GUIDE_FOLDER_ID = 'guide-folder-test';
delete process.env.RECEIPT_REVIEW_FOLDER_ID;
process.env.AI_REVIEW_FOLDER_ID = 'root-folder-test';
process.env.PUBLIC_API_URL = 'https://api.example.test';

const SERVER = path.resolve(__dirname, '..');
const S = p => fs.readFileSync(path.join(SERVER, p), 'utf8');
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  console.log('\n▶ 영수증리뷰 2단계 — 영수증 사진 비공개\n');
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  for (const f of fs.readdirSync(path.join(SERVER, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8')); } catch (_) { /* PGlite 에 없는 확장 — 이 시험의 표와 무관 */ }
  }
  // PGlite 에 없는 확장(pg_trgm)을 쓰는 081 이 못 만든 사진 출처 표 — 판정 SQL 이 읽는 칸만(결정 352 시험과 같은 모양)
  await db.exec('CREATE TABLE IF NOT EXISTS review_inspections (id SERIAL PRIMARY KEY, file_id TEXT NOT NULL)');
  const query = async (sql, params) => { const r = await db.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length }; };
  const pool = { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };

  const drive = require('../src/services/drive.service');
  const reads = [];
  const uploads = [];
  drive.downloadFile = async (id) => { reads.push(id); return { buffer: Buffer.from('IMG:' + id), mimeType: id.startsWith('XLSX') ? 'application/vnd.ms-excel' : 'image/jpeg', name: id }; };
  let upSeq = 0;
  drive.uploadFileBase64 = async (b64, name, mime, folderId, opts) => { uploads.push({ name, mime, folderId, opts }); return { id: `RCPTUPLOAD${++upSeq}_abcdefghijklmnop` }; };
  const folders = [];
  drive.ensureFolderPath = async (root, segs) => { folders.push({ root, segs }); return { id: 'receipt-folder-' + segs.join('/') }; };

  const allow = require('../src/services/imageAllowlist.service');
  allow.__resetCacheForTest();
  const jwt = require('jsonwebtoken');
  const tok = role => jwt.sign({ role, name: `가짜${role}` }, process.env.JWT_SECRET);

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/drive', require('../src/routes/drive.routes'));
  app.use('/api/order', require('../src/routes/order.routes'));
  app.use('/api/trackb', require('../src/routes/trackB.routes'));
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, { headers = {}, body } = {}) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* 사진 */ }
    return { s: res.status, h: res.headers, buf, json };
  };
  const IMG = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');
  const KEY = { 'X-Intake-Key': 'test-intake-key' };

  try {
    /* ── ① 올리기 ── */
    console.log('① 올리기(비공개 저장)');
    await t('★ 인증 없이 올리면 401 · 드라이브 쓰기 0', async () => {
      const r = await call('POST', '/api/order/receipt-review-image', { body: { imageBase64: IMG, mimeType: 'image/jpeg' } });
      assert.equal(r.s, 401); assert.equal(uploads.length, 0);
    });
    await t('★★ 업체(광고주) 로그인으로는 못 올린다 · 드라이브 쓰기 0', async () => {
      const r = await call('POST', '/api/order/receipt-review-image', { headers: { Authorization: 'Bearer ' + tok('advertiser') }, body: { imageBase64: IMG, mimeType: 'image/jpeg' } });
      assert.equal(r.s, 401); assert.equal(uploads.length, 0);
    });
    await t('사진이 아니면 거절(400) · 드라이브 쓰기 0', async () => {
      const r = await call('POST', '/api/order/receipt-review-image', { headers: KEY, body: { imageBase64: 'data:application/pdf;base64,AAAA', mimeType: 'application/pdf' } });
      assert.equal(r.s, 400); assert.equal(uploads.length, 0);
      const r2 = await call('POST', '/api/order/receipt-review-image', { headers: KEY, body: { imageUrl: 'https://image.coupangcdn.com/x.jpg' } });
      assert.equal(r2.s, 400, '주소로 받아 오기는 받지 않는다(영수증은 AE 가 올린 파일만)'); assert.equal(uploads.length, 0);
    });
    let fid1 = null, fid2 = null;
    await t('★★ 인트라넷 키로 올리면 파일 번호만 돌려준다(주소 없음) · 드라이브 비공개(shareAnyone=false) · 안내 사진 폴더 아님', async () => {
      const r = await call('POST', '/api/order/receipt-review-image', { headers: KEY, body: { imageBase64: IMG, mimeType: 'image/jpeg', fileName: '영수증1' } });
      assert.equal(r.s, 200, JSON.stringify(r.json));
      assert.equal(r.json.ok, true); fid1 = r.json.id;
      assert.ok(/^RCPTUPLOAD1_/.test(fid1));
      assert.ok(!('url' in r.json) && !('viewUrl' in r.json), '공개 주소를 만들지 않는다');
      assert.ok(!JSON.stringify(r.json).includes('/api/order/guide-image/') && !JSON.stringify(r.json).includes('/api/drive/image/'));
      assert.equal(uploads[0].opts && uploads[0].opts.shareAnyone, false, '드라이브 공개 권한을 주지 않는다');
      assert.notEqual(uploads[0].folderId, process.env.GUIDE_FOLDER_ID, '유입가이드(공개 안내 사진) 폴더에 섞지 않는다');
      assert.deepEqual(folders[0], { root: 'root-folder-test', segs: ['[영수증리뷰]'] });
    });
    await t('★ 올린 즉시 비공개 목록에 적힌다(source=upload:intranet) · 공개 안내 사진 목록(guide_image_files)에는 없다', async () => {
      const a = (await query('SELECT source, mime_type FROM receipt_review_files WHERE file_id = $1', [fid1])).rows;
      assert.deepEqual(a, [{ source: 'upload:intranet', mime_type: 'image/jpeg' }]);
      assert.equal((await query('SELECT 1 FROM guide_image_files WHERE file_id = $1', [fid1])).rows.length, 0);
    });
    await t('내부 담당자 로그인으로도 올린다(source=upload:staff)', async () => {
      const r = await call('POST', '/api/order/receipt-review-image', { headers: { Authorization: 'Bearer ' + tok('staff') }, body: { imageBase64: IMG, mimeType: 'image/png' } });
      assert.equal(r.s, 200); fid2 = r.json.id;
      assert.equal((await query('SELECT source FROM receipt_review_files WHERE file_id = $1', [fid2])).rows[0].source, 'upload:staff');
    });

    /* ── ② 무인증 통로 거절 ── */
    console.log('\n② 무인증 사진 통로(결정 352) 거절');
    await t('★★ guide-image · drive/image 는 영수증 번호를 404 로 거절 · 드라이브 읽기 0', async () => {
      reads.length = 0; allow.__resetCacheForTest();
      for (const u of [`/api/order/guide-image/${fid1}`, `/api/drive/image/${fid1}`]) {
        const r = await call('GET', u);
        assert.equal(r.s, 404, u); assert.ok(!/drive\.google\.com/.test(r.h.get('location') || ''), '구글 썸네일로 돌리지 않는다');
      }
      assert.equal(reads.length, 0);
    });
    await t('★★ 영수증 번호가 공개 목록에 잘못 함께 적혀도(실수로 안내 사진 통로로 올림) 거절이 이긴다', async () => {
      await allow.registerGuideImage(fid1, 'upload:intranet');
      await query('INSERT INTO review_inspections (file_id) VALUES ($1)', [fid2]);   // 화면 출처 칸(검수 카드)에 함께 적힌 경우
      reads.length = 0; allow.__resetCacheForTest();
      assert.equal((await call('GET', `/api/order/guide-image/${fid1}`)).s, 404);
      assert.equal((await call('GET', `/api/drive/image/${fid2}`)).s, 404);
      assert.equal(reads.length, 0);
      assert.equal((await allow.checkGuideImage(fid1)).ok, false);
      assert.equal((await allow.checkFresh(fid1)).ok, false, '엣지 미리 만들기(354)·서명 주소도 같은 판정 — 거절');
    });
    await t('★ 거절 목록(PRIVATE_SOURCES)에 비공개 영수증 목록이 있다(이체결과 보관과 같은 자리)', async () => {
      assert.ok(allow.PRIVATE_SOURCES.some(s => s.table === 'receipt_review_files' && s.column === 'file_id'));
      assert.ok(allow.PRIVATE_SOURCES.some(s => s.table === 'payment_result_drive_archive'), '이체결과 거절은 그대로');
    });

    /* ── ③ 인트라넷 보기 통로 ── */
    console.log('\n③ 인트라넷(AE 미리보기)·직원 보기 통로');
    await t('★ 인트라넷 키로 번호를 주면 사진을 준다 · 캐시 금지(private, no-store)', async () => {
      reads.length = 0;
      const r = await call('GET', `/api/order/receipt-review-image/${fid1}`, { headers: KEY });
      assert.equal(r.s, 200); assert.equal(r.buf.toString(), 'IMG:' + fid1);
      assert.match(r.h.get('cache-control') || '', /private/); assert.match(r.h.get('cache-control') || '', /no-store/);
      assert.equal(reads.length, 1);
    });
    await t('★★ 인증 없음 401 · 업체 로그인 401 · 드라이브 읽기 0', async () => {
      reads.length = 0;
      assert.equal((await call('GET', `/api/order/receipt-review-image/${fid1}`)).s, 401);
      assert.equal((await call('GET', `/api/order/receipt-review-image/${fid1}`, { headers: { Authorization: 'Bearer ' + tok('advertiser') } })).s, 401);
      assert.equal((await call('GET', `/api/order/receipt-review-image/${fid1}?token=${tok('admin')}`)).s, 401, '주소에 실은 토큰은 받지 않는다(주소가 기록·공유된다)');
      assert.equal(reads.length, 0);
    });
    await t('★★ 목록 밖 번호(공개 안내 사진·이체결과·아무 번호)는 404 · 드라이브 읽기 0', async () => {
      reads.length = 0;
      await allow.registerGuideImage('PUBLICguide_abcdefghijklmnop', 'upload:order');
      await query(`INSERT INTO payment_result_drive_archive (file_sha256, drive_file_id) VALUES ('sha_x', 'PAYARCHIVE_abcdefghijklmnop')`).catch(async () => {
        await query(`INSERT INTO payment_result_drive_archive (drive_file_id) VALUES ('PAYARCHIVE_abcdefghijklmnop')`).catch(() => {});
      });
      for (const id of ['PUBLICguide_abcdefghijklmnop', 'UNKNOWNfile_abcdefghijklmnop', 'PAYARCHIVE_abcdefghijklmnop']) {
        assert.equal((await call('GET', `/api/order/receipt-review-image/${id}`, { headers: KEY })).s, 404, id);
      }
      assert.equal((await call('GET', '/api/order/receipt-review-image/short', { headers: KEY })).s, 400);
      assert.equal(reads.length, 0);
    });
    await t('목록에 있어도 드라이브 파일이 사진이 아니면 내주지 않는다', async () => {
      await query(`INSERT INTO receipt_review_files (file_id, source) VALUES ('XLSXreceipt_abcdefghijklmnop', 'upload:intranet')`);
      assert.equal((await call('GET', '/api/order/receipt-review-image/XLSXreceipt_abcdefghijklmnop', { headers: KEY })).s, 404);
    });

    /* ── ④ 직원 작업보드 통로(줄 번호로) ── */
    await query(`INSERT INTO receipt_pool (work_order_id, sheet_id, tab_name, seq, pool_seq, file_id) VALUES ('wo_x', 'sh_x', '가짜 영수증 탭', 2, 1, $1), ('wo_x', 'sh_x', '가짜 영수증 탭', 3, 2, 'UNREGISTERED_abcdefghijklmn')`, [fid1]);
    const rowUrl = seq => `/api/trackb/workdesk/receipt-image?sheetId=sh_x&tabName=${encodeURIComponent('가짜 영수증 탭')}&seq=${seq}`;
    await t('★ 직원(내부 담당자)은 작업보드 줄 번호로 그 줄의 영수증을 본다(파일 번호를 화면에 주지 않는다)', async () => {
      reads.length = 0;
      const r = await call('GET', rowUrl(2), { headers: { Authorization: 'Bearer ' + tok('staff') } });
      assert.equal(r.s, 200); assert.equal(r.buf.toString(), 'IMG:' + fid1);
      assert.match(r.h.get('cache-control') || '', /no-store/);
    });
    await t('★★ 업체(광고주)는 못 본다 · 인증 없음 401 · 드라이브 읽기 0', async () => {
      reads.length = 0;
      assert.equal((await call('GET', rowUrl(2), { headers: { Authorization: 'Bearer ' + tok('advertiser') } })).s, 403);
      assert.equal((await call('GET', rowUrl(2))).s, 401);
      assert.equal(reads.length, 0);
    });
    await t('★ 없는 줄 · 비공개 목록에 없는 파일이 묶인 줄 = 404 · 드라이브 읽기 0', async () => {
      reads.length = 0;
      assert.equal((await call('GET', rowUrl(9), { headers: { Authorization: 'Bearer ' + tok('admin') } })).s, 404);
      assert.equal((await call('GET', rowUrl(3), { headers: { Authorization: 'Bearer ' + tok('admin') } })).s, 404);
      assert.equal((await call('GET', '/api/trackb/workdesk/receipt-image?sheetId=sh_x', { headers: { Authorization: 'Bearer ' + tok('admin') } })).s, 400);
      assert.equal(reads.length, 0);
    });

    /* ── ⑤ 정적 대조 ── */
    console.log('\n⑤ 정적 대조');
    await t('★ 영수증 코드는 공개 사진 주소를 만들지 않는다 · 올리기 = 비공개 목록 등록이 응답보다 앞', async () => {
      const files = ['src/utils/receiptPool.js', 'src/services/receiptPool.service.js'];
      for (const f of files) assert.doesNotMatch(S(f), /\/api\/order\/guide-image\/\$\{|\/api\/drive\/image\/\$\{|registerGuideImage/, f);
      const orr = S('src/routes/order.routes.js');
      const at = orr.indexOf("router.post('/receipt-review-image'");
      const body = orr.slice(at, orr.indexOf('_handlers.receiptReviewImageUpload', at));
      assert.ok(at > 0 && body.indexOf('registerReceiptUpload(') > 0 && body.indexOf('registerReceiptUpload(') < body.indexOf('res.json('));
      assert.match(body, /shareAnyone: false/);
      assert.doesNotMatch(body, /registerGuideImage|fetchThumbFromUrl/);
    });
    await t('★ 작업보드 화면: [보기]는 내부 응답의 receiptPoolColumn 이 있을 때만 · 헤더 인증 fetch(주소에 토큰·파일 번호 없음) · 공개 사진 주소 안 만듦', async () => {
      const wd = fs.readFileSync(path.join(SERVER, '..', 'frontend/workdesk.html'), 'utf8');
      const fn = wd.slice(wd.indexOf('async function openReceiptPoolImage'), wd.indexOf('function closeReceiptPoolImage'));
      assert.match(fn, /\/api\/trackb\/workdesk\/receipt-image\?/);
      assert.match(fn, /headers:\{Authorization:'Bearer '\+token\(\)\}/);
      assert.doesNotMatch(fn, /token=|\/api\/drive\/image|guide-image|file_id|fileId/);
      assert.match(wd, /function _rpIsCol\(h\)\{ const c=STATE\.wd&&STATE\.wd\.receiptPoolColumn; return STATE\.role!=='advertiser'&&/);
      const tbs = S('src/services/trackB.service.js');
      const at = tbs.indexOf('res.receiptPoolColumn =');
      const showEditsAt = tbs.lastIndexOf('if (showEdits) {', at);
      assert.ok(at > 0 && showEditsAt > 0 && at - showEditsAt < 2500, '내부 응답(showEdits) 블록 안에서만 싣는다');
      assert.doesNotMatch(tbs.slice(at - 400, at + 200), /file_id/, '파일 번호를 싣지 않는다');
    });
  } finally {
    srv.close();
  }
  console.log(`\n✅ ${passed}개 통과\n`);
  await db.close();
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
