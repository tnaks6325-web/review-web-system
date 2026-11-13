/**
 * 리뷰 내역 → 「참여상품 정보」 [📷 구매캡처보기] — 네이버·쿠팡 동시진행 묶음 주문 (결정 371 · 감사 M5)
 *
 *   묶음 주문은 사진을 구매처별 표(purchase_capture_artifacts)에 두고 옛 칸 capture_file_id 를 채우지 않는다(결정 338/355).
 *   participation-brief 가 옛 칸만 읽어 묶음 주문은 버튼이 늘 꺼져 「연결된 구매 캡처가 없습니다」였다.
 *
 *   확인:
 *     ① 묶음 주문 = 지금 사진(committed · 교체 안 됨)을 구매처 이름(네이버/쿠팡)과 함께 2장 돌려준다.
 *        교체된 옛 사진 · 아직 확정 안 된 사진은 안 나간다. 옛 화면이 읽는 fileId/fileId2 도 채운다(배포 순서 무관).
 *     ② 보통 주문 = 응답 모양·값이 종전과 똑같다({fileId,fileId2,uploadedAt} — 필드 추가 없음).
 *     ③ 다른 리뷰어 = 종전처럼 403 · 줄은 내 것이지만 주문 주인이 다른 리뷰어면 사진 없음(null).
 *
 *   ★ 실제 라우트 핸들러 + 실제 migration 215 를 PGlite 에서 돌린다.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';

let passed = 0;
const ok = (n, c, x) => { assert(c, n + (x ? '  ← ' + x : '')); passed++; console.log('  ✓ ' + n); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

const OWNER_A = '00000000-0000-4000-8000-00000000000a';
const OWNER_B = '00000000-0000-4000-8000-00000000000b';
const P8_A = '29979075';
const P8_B = '11112222';
const DUAL = '00000000-0000-4000-8000-0000000000d1';
const PLAIN = '00000000-0000-4000-8000-0000000000e1';
const STOLEN = '00000000-0000-4000-8000-0000000000f1';   // 줄은 A 것인데 주문 주인은 B(오염 링크)
const NOCAP = '00000000-0000-4000-8000-0000000000c1';    // 보통 주문 · 캡처 없음

async function makeDb() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE reviewers(id uuid PRIMARY KEY, phone8 text, sub_accounts jsonb DEFAULT '[]');
    CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,folder_url text,capture_slots jsonb,income_type text,display_name text,campaign_name text,is_closed boolean DEFAULT false);
    CREATE TABLE recruit_campaigns(id text PRIMARY KEY,title text,chat_url text,landing_url text,source_work_order_id text,work_detail jsonb,linked_sheet_id text,linked_tab_name text,linked_tab_gid text,created_at timestamptz DEFAULT now());
    CREATE TABLE campaign_applications(id integer PRIMARY KEY, campaign_id text, order_submission_id uuid);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY, phone text, recipient text, orderer text, price text,
      sheet_id text, tab_name text, sheet_row integer, gid text, submitted_at timestamptz DEFAULT now() - interval '1 hour',
      deleted_at timestamptz, capture_file_id text, capture_file_id_2 text, capture_uploaded_at timestamptz,
      campaign_application_id integer, mirror_status text, owner_reviewer_id uuid);
    CREATE TABLE campaign_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_submission_id uuid,sheet_id text,tab_name text,seq integer,
      deleted_at timestamptz,row_json jsonb,owner_reviewer_id uuid,phone8 text,is_submitted boolean DEFAULT false);
    CREATE TABLE review_index(id uuid DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,phone8 text,row_json jsonb,submit_col2 text);
    CREATE TABLE participation_links(sheet_id text,tab_name text,row_index integer,phone8 text);
    CREATE TABLE work_orders(id text PRIMARY KEY,linked_campaign_id text,product_url text,updated_at timestamptz DEFAULT now());
    CREATE TABLE review_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,slot_key text,file_id text,uploaded_at timestamptz DEFAULT now());
    CREATE TABLE payment_batch_items(id uuid DEFAULT gen_random_uuid(),status text DEFAULT 'pending',sheet_id text,tab_name text,row_index integer,amount integer,paid_at timestamptz,transfer_memo text,created_at timestamptz DEFAULT now());
  `);
  await pg.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/215_dual_channel_purchase_bundles.sql'), 'utf8'));

  await pg.query(`INSERT INTO reviewers VALUES ($1,$2,'[]'),($3,$4,'[]')`, [OWNER_A, P8_A, OWNER_B, P8_B]);
  await pg.query(`INSERT INTO recruit_campaigns(id,title,linked_sheet_id,linked_tab_name) VALUES ('camp','가짜 동시진행 작업','wt_s','가짜 탭')`);
  // 작업표 줄 1~4 = 전부 A 의 전화번호(줄 소유권은 A)
  for (const row of [1, 2, 3, 4]) {
    await pg.query(`INSERT INTO review_index(sheet_id,tab_name,row_index,phone8,row_json) VALUES ('wt_s','가짜 탭',$1,$2,'{}')`, [row, P8_A]);
  }
  // ① 묶음 주문 — 줄 1
  await pg.query(`INSERT INTO campaign_applications VALUES (1,'camp',$1)`, [DUAL]);
  await pg.query(`INSERT INTO order_submissions(id,phone,recipient,price,sheet_id,tab_name,sheet_row,campaign_application_id,owner_reviewer_id,
      purchase_bundle_version,purchase_bundle_application_id,purchase_bundle_hash,purchase_condition_snapshot,purchase_identity_result,purchase_bundle_revision)
    VALUES ($1,'010-2997-9075','가**','19000','wt_s','가짜 탭',1,1,$2,1,1,$3,'{}','match',1)`, [DUAL, OWNER_A, sha('bundle')]);
  for (const [c, n] of [['naver', 9000], ['coupang', 10000]]) {
    await pg.query(`INSERT INTO order_purchase_channels VALUES ($1,$2,'num','uid','가','01012345678','주소',$3,NULL)`, [DUAL, c, n]);
  }
  const art = (rev, ch, role, fileId, status, superseded) => pg.query(
    `INSERT INTO purchase_capture_artifacts(application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,
       extraction_proof_hash,final_input_hash,condition_snapshot_hash,status,superseded_at)
     VALUES (1,$1,$2,$3,$4,$5,$6,$6,$6,$6,$7,$8)`,
    [DUAL, ch, role, rev, fileId, sha(fileId), status, superseded ? new Date().toISOString() : null]);
  await art(1, 'naver', 'primary', 'f-naver-old', 'superseded', true);   // 교체된 옛 사진 — 안 나간다
  await art(2, 'naver', 'primary', 'f-naver', 'committed', false);
  await art(1, 'coupang', 'primary', 'f-coupang', 'committed', false);
  await art(1, 'coupang', 'supplement', 'f-coupang-staged', 'staged', false); // 아직 확정 전 — 안 나간다
  await pg.query(`INSERT INTO campaign_participants(order_submission_id,sheet_id,tab_name,seq,owner_reviewer_id,phone8) VALUES ($1,'wt_s','가짜 탭',1,$2,$3)`, [DUAL, OWNER_A, P8_A]);
  // ② 보통 주문 — 줄 2 (옛 두 칸)
  await pg.query(`INSERT INTO order_submissions(id,phone,sheet_id,tab_name,sheet_row,owner_reviewer_id,capture_file_id,capture_file_id_2,capture_uploaded_at)
    VALUES ($1,'010-2997-9075','wt_s','가짜 탭',2,$2,'f-plain-1','f-plain-2','2026-11-10T01:02:03Z')`, [PLAIN, OWNER_A]);
  await pg.query(`INSERT INTO campaign_participants(order_submission_id,sheet_id,tab_name,seq,owner_reviewer_id,phone8) VALUES ($1,'wt_s','가짜 탭',2,$2,$3)`, [PLAIN, OWNER_A, P8_A]);
  // ③ 줄은 A 것인데 주문·참여 주인은 B — 줄 3 (묶음 주문)
  await pg.query(`INSERT INTO campaign_applications VALUES (3,'camp',$1)`, [STOLEN]);
  await pg.query(`INSERT INTO order_submissions(id,phone,price,sheet_id,tab_name,sheet_row,campaign_application_id,owner_reviewer_id,
      purchase_bundle_version,purchase_bundle_application_id,purchase_bundle_hash,purchase_condition_snapshot,purchase_identity_result,purchase_bundle_revision)
    VALUES ($1,'010-1111-2222','19000','wt_s','가짜 탭',3,3,$2,1,3,$3,'{}','match',1)`, [STOLEN, OWNER_B, sha('stolen')]);
  await pg.query(`INSERT INTO purchase_capture_artifacts(application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,
       extraction_proof_hash,final_input_hash,condition_snapshot_hash,status)
     VALUES (3,$1,'naver','primary',1,'f-stolen',$2,$2,$2,$2,'committed')`, [STOLEN, sha('f-stolen')]);
  await pg.query(`INSERT INTO campaign_participants(order_submission_id,sheet_id,tab_name,seq,owner_reviewer_id,phone8) VALUES ($1,'wt_s','가짜 탭',3,$2,$3)`, [STOLEN, OWNER_B, P8_B]);
  // ④ 보통 주문 · 캡처 없음 — 줄 4
  await pg.query(`INSERT INTO order_submissions(id,phone,sheet_id,tab_name,sheet_row,owner_reviewer_id) VALUES ($1,'010-2997-9075','wt_s','가짜 탭',4,$2)`, [NOCAP, OWNER_A]);
  await pg.query(`INSERT INTO campaign_participants(order_submission_id,sheet_id,tab_name,seq,owner_reviewer_id,phone8) VALUES ($1,'wt_s','가짜 탭',4,$2,$3)`, [NOCAP, OWNER_A, P8_A]);
  return { query: (s, p) => pg.query(s, p), pg };
}

function routeHandler(router, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods.get);
  assert(layer, '라우트 없음 ' + p);
  const st = layer.route.stack; return st[st.length - 1].handle;
}
const callGet = (h, req) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  Promise.resolve(h(req, res, e => resolve({ err: e }))).catch(e => resolve({ err: e }));
});
const reqFor = (owner, p8, rowIndex) => ({
  query: { phone8: p8, sheetId: 'wt_s', tabName: '가짜 탭', rowIndex: String(rowIndex) },
  reviewer: { ownerReviewerId: owner, loginKind: 'self', loginPhone8: p8 },
});

(async () => {
  const db = await makeDb();
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: db };
  const router = require('../src/routes/reviewEdit.routes');
  const brief = routeHandler(router, '/participation-brief');
  const capOf = r => (r.body && r.body.brief && r.body.brief.purchaseCapture) || null;

  console.log('\n[① 동시진행 묶음 주문]');
  const d = await callGet(brief, reqFor(OWNER_A, P8_A, 1));
  assert(!d.err, String(d.err && d.err.stack));
  const dc = capOf(d);
  ok('묶음 주문도 구매캡처가 내려온다(버튼이 꺼지지 않는다)', !!dc, JSON.stringify(d.body));
  ok('지금 사진 2장 · 네이버 먼저 · 구매처 이름이 붙는다',
    Array.isArray(dc.photos) && dc.photos.length === 2
      && dc.photos[0].fileId === 'f-naver' && dc.photos[0].label === '네이버'
      && dc.photos[1].fileId === 'f-coupang' && dc.photos[1].label === '쿠팡', JSON.stringify(dc));
  ok('교체된 옛 사진 · 확정 전 사진은 나가지 않는다',
    !JSON.stringify(dc).includes('f-naver-old') && !JSON.stringify(dc).includes('f-coupang-staged'), JSON.stringify(dc));
  ok('옛 화면이 읽는 두 칸(fileId/fileId2)도 같은 두 장으로 채운다', dc.fileId === 'f-naver' && dc.fileId2 === 'f-coupang', JSON.stringify(dc));

  console.log('\n[② 보통 주문 — 종전과 똑같다]');
  const s = await callGet(brief, reqFor(OWNER_A, P8_A, 2));
  assert(!s.err, String(s.err && s.err.stack));
  const sc = capOf(s);
  ok('보통 주문 응답은 {fileId,fileId2,uploadedAt} 그대로(필드 추가 없음)',
    sc && Object.keys(sc).sort().join(',') === 'fileId,fileId2,uploadedAt'
      && sc.fileId === 'f-plain-1' && sc.fileId2 === 'f-plain-2' && !!sc.uploadedAt, JSON.stringify(sc));
  const n = await callGet(brief, reqFor(OWNER_A, P8_A, 4));
  ok('캡처 없는 보통 주문은 종전처럼 없음(null)', !capOf(n), JSON.stringify(n.body));

  console.log('\n[③ 다른 리뷰어는 여전히 못 본다]');
  const other = await callGet(brief, reqFor(OWNER_B, P8_B, 1));
  ok('다른 리뷰어가 A 의 묶음 주문 줄을 열면 403', other.status === 403 && !capOf(other), JSON.stringify(other.body));
  const stolen = await callGet(brief, reqFor(OWNER_A, P8_A, 3));
  ok('줄은 내 것이어도 주문 주인이 다른 리뷰어면 묶음 사진을 내주지 않는다', stolen.status === 200 && !capOf(stolen), JSON.stringify(stolen.body));

  console.log('\n[단일 출처]');
  const route = fs.readFileSync(path.resolve(__dirname, '../src/routes/reviewEdit.routes.js'), 'utf8');
  ok('묶음 판정·사진 읽기는 utils/dualCaptureComplete 에서 가져온다(사본 SQL 없음)',
    /require\(['"]\.\.\/utils\/dualCaptureComplete['"]\)/.test(route) && !/FROM purchase_capture_artifacts/.test(route));

  console.log('\n[화면 — 캡처 창]');
  const home = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');
  const fnSlice = head => { const s = home.indexOf(head); assert(s >= 0, head); const e = home.indexOf('\nfunction ', s + head.length); return home.slice(s, e); };
  const vm = require('vm');
  const ctx = { escHtml: x => String(x), _escAttrX: x => String(x), _reEditImgUrl: id => '/api/drive/image/' + id };
  vm.createContext(ctx);
  vm.runInContext(fnSlice('function _partInfoCapturePhotos(pc)') + '\n' + fnSlice('function _partInfoCapturePhotosHtml(capture)'), ctx);
  const dualCap = { fileId: dc.fileId, fileId2: dc.fileId2, photos: ctx._partInfoCapturePhotos(dc) };
  const dualHtml = ctx._partInfoCapturePhotosHtml(dualCap);
  ok('묶음 주문 캡처 창 = 「네이버」「쿠팡」 이름 아래 각 사진(기존 이미지 통로)',
    /네이버<\/div><img[^>]+\/api\/drive\/image\/f-naver"/.test(dualHtml) && /쿠팡<\/div><img[^>]+\/api\/drive\/image\/f-coupang"/.test(dualHtml) && !/2장째/.test(dualHtml), dualHtml);
  const plainCap = { fileId: sc.fileId, fileId2: sc.fileId2, photos: ctx._partInfoCapturePhotos(sc) };
  const plainHtml = ctx._partInfoCapturePhotosHtml(plainCap);
  ok('보통 주문 캡처 창 = 종전 그대로(첫 장 + 「2장째」)',
    plainCap.photos === null && /f-plain-1/.test(plainHtml) && /2장째<\/div><img[^>]+f-plain-2/.test(plainHtml) && !/네이버|쿠팡/.test(plainHtml), plainHtml);
  ok('이상한 사진 목록(빈 칸·배열 아님)은 버리고 종전 두 칸으로 접는다',
    ctx._partInfoCapturePhotos({ photos: [{ fileId: '' }, null] }) === null && ctx._partInfoCapturePhotos({ photos: 'x' }) === null);

  await db.pg.close();
  console.log(`\n✅ partInfoDualCapture: ${passed}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
