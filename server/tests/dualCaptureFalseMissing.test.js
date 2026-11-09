/**
 * 네이버·쿠팡 동시진행 묶음 주문 — 「구매캡처 없음」 오판 제거 (결정 355 · 2026-11-09 실사례)
 *
 *   묶음 주문은 사진을 구매처별 표(purchase_capture_artifacts)에 두고 옛 칸 capture_uploaded_at 을 채우지 않는다.
 *   그 칸만 보던 세 곳이 묶음 주문을 전부 "캡처 없음"으로 봤다:
 *     ① 리뷰어 홈 「구매 캡처 보완 필요」 목록 → [캡처 첨부하기] 를 누르면 "제출 세션을 발급받지 못했습니다"(막다른 길)
 *     ② 직원 리뷰어 기록의 「구매캡쳐를 첨부하지 않았습니다」 경고(5분 주기 감지)
 *     ③ 그 경고의 자동 해결(옛 칸만 봐서 영영 안 풀림)
 *   그리고 ④ 캡처 연결 백필(옛 1장 칸에 Drive 파일을 붙이는 직원 도구)은 묶음 주문을 대상에 넣으면 안 된다(결정 338).
 *
 *   ★ 진짜 SQL 을 PGlite 에서 돌린다 — 묶음 표는 실제 migration 215 로 만든다(손으로 칸을 지어내지 않는다).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { PGlite } = require('@electric-sql/pglite');

let passed = 0;
const ok = (n, c, x) => { assert(c, n + (x ? '  ← ' + x : '')); passed++; console.log('  ✓ ' + n); };

const P8 = '29979075';
const FULL = '00000000-0000-4000-8000-0000000000a1';   // 묶음 · 두 구매처 사진 있음
const HALF = '00000000-0000-4000-8000-0000000000a2';   // 묶음 · 쿠팡 사진 없음(진짜 빠짐)
const PLAIN = '00000000-0000-4000-8000-0000000000a3';  // 보통 주문 · 캡처 없음(종전대로 보완 대상)

async function makeDb() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE app_settings(key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now());
    CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,sheetless boolean DEFAULT false,workboard_schema_version integer,folder_url text,is_closed boolean DEFAULT false,archived_rounds text,display_name text,campaign_name text);
    CREATE TABLE recruit_campaigns(id text PRIMARY KEY,title text,linked_sheet_id text,linked_tab_name text,work_detail jsonb,linked_tab_gid text,source_work_order_id text);
    CREATE TABLE campaign_applications(id integer PRIMARY KEY, campaign_id text, order_submission_id uuid);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY, phone text, recipient text, orderer text, price text,
      sheet_id text, tab_name text, tab_gid text, submitted_at timestamptz DEFAULT now() - interval '1 hour',
      deleted_at timestamptz, capture_file_id text, capture_file_id_2 text, capture_uploaded_at timestamptz,
      campaign_application_id integer, mirror_status text, owner_reviewer_id uuid, gid text);
    CREATE TABLE campaign_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_submission_id uuid,sheet_id text,tab_name text,seq integer,active boolean DEFAULT true,deleted_at timestamptz,row_json jsonb,identity_key text,source text,updated_at timestamptz,submit_col text,is_submitted boolean DEFAULT false,review_participation_id uuid NOT NULL DEFAULT gen_random_uuid());
    -- migration 215 가 기대는 표 묶음(tests/helpers/dualChannelRealFixture.js 와 같은 부분집합)
    CREATE TABLE work_orders(id text PRIMARY KEY,linked_campaign_id text);
    CREATE TABLE reviewer_participations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_participant_id uuid NOT NULL,sheet_id text,tab_name text,row_index integer,review_obligation_status text NOT NULL CHECK (review_obligation_status IN ('pending','fulfilled','closed_no_review','unknown')),review_evidence jsonb NOT NULL DEFAULT '{}',index_snapshot jsonb NOT NULL DEFAULT '{}',lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('active','archived','cancelled')),updated_at timestamptz NOT NULL DEFAULT now(),record_version bigint NOT NULL DEFAULT 1);
    CREATE TABLE review_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,reviewer_name text,slot_key text,file_id text UNIQUE,file_url text,file_name text,file_hash text,source text,uploaded_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now(),upload_batch_id uuid,completed_at timestamptz);
    CREATE TABLE review_inspections(file_id text PRIMARY KEY,sheet_id text,tab_name text,row_index integer,reviewer_name text,slot_key text,status text,checks jsonb,resolution text,updated_at timestamptz,product_resolution text,ocr_product text,resolved_at timestamptz,resolved_by text);
    CREATE TABLE payment_batch_items(id uuid DEFAULT gen_random_uuid(),batch_id uuid,status text DEFAULT 'pending',sheet_id text,tab_name text,row_index integer,product_price integer,review_fee integer,bank_name text,bank_account text,account_holder text);
    CREATE TABLE participant_edits(id serial,sheet_id text,tab_name text,anchor_type text,anchor_value text,field text,kind text,value_text text,value_bool boolean,created_by text,created_at timestamptz DEFAULT now(),reverted_at timestamptz,reverted_by text);
    CREATE TABLE raw_sheet_tabs(sheet_id text,tab_name text,tab_gid text,headers jsonb,detected_headers jsonb);
    CREATE TABLE raw_sheet_rows(sheet_id text,tab_name text,tab_gid text,row_index integer,cells jsonb);
    CREATE TABLE review_index(id uuid DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,row_json jsonb,is_submitted boolean DEFAULT false,review_file_id text,review_file_url text,review_file_name text,review_file_count integer);
    CREATE TABLE review_index_archive(sheet_id text, tab_name text, row_index integer, is_submitted boolean DEFAULT false);
    CREATE TABLE purchase_submission_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_submission_id uuid,
      token_hash text, capture_sheet_id text, capture_tab_name text, source text, expires_at timestamptz,
      status text DEFAULT 'issued', capture_file_id text);
  `);
  for (const m of ['062_reviewer_event_logs.sql', '215_dual_channel_purchase_bundles.sql']) {
    await pg.exec(fs.readFileSync(path.resolve(__dirname, '../migrations', m), 'utf8'));
  }
  await pg.exec(`INSERT INTO recruit_campaigns(id,title,linked_sheet_id,linked_tab_name) VALUES ('camp','가짜 동시진행 작업','wt_s','가짜 탭')`);
  for (const [i, id] of [[1, FULL], [2, HALF]]) {
    await pg.query(`INSERT INTO campaign_applications VALUES ($1,'camp',$2)`, [i, id]);
    await pg.query(`INSERT INTO order_submissions(id,phone,recipient,price,sheet_id,tab_name,campaign_application_id,
        purchase_bundle_version,purchase_bundle_application_id,purchase_bundle_hash,purchase_condition_snapshot,purchase_identity_result,purchase_bundle_revision)
      VALUES ($1,'010-2997-9075','가**','19000','campaign:camp','campaign:camp',$2,1,$2,$3,'{}','uncertain',1)`, [id, i, require('crypto').createHash('sha256').update('b' + i).digest('hex')]);
    for (const [c, n] of [['naver', 9000], ['coupang', 10000]]) {
      await pg.query(`INSERT INTO order_purchase_channels VALUES ($1,$2,'num','uid','가','01012345678','주소',$3,NULL)`, [id, c, n]);
      if (id === HALF && c === 'coupang') continue;
      await pg.query(`INSERT INTO purchase_capture_artifacts(application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,
          extraction_proof_hash,final_input_hash,condition_snapshot_hash,status)
        VALUES ($1,$2,$3,'primary',1,$4,$5,$5,$5,$5,'committed')`, [i, id, c, 'f-' + i + c, require('crypto').createHash('sha256').update(i + c).digest('hex')]);
    }
  }
  await pg.query(`INSERT INTO order_submissions(id,phone,recipient,price,sheet_id,tab_name) VALUES ($1,'010-2997-9075','나**','9000','wt_p','보통 탭')`, [PLAIN]);
  return { query: (s, p) => pg.query(s, p), pg };
}

function routeHandler(router, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods.get);
  assert(layer, '라우트 없음 ' + p);
  const st = layer.route.stack; return st[st.length - 1].handle;
}
const callGet = (h, query) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  Promise.resolve(h({ query }, res, e => resolve({ err: e }))).catch(e => resolve({ err: e }));
});

(async () => {
  const db = await makeDb();
  // db/pool 을 PGlite 로 바꿔 끼운다(실제 라우트·서비스 SQL 을 그대로 돌린다)
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: db };

  // 캡처 감시 시작 시각(migration 062 가 NOW 로 심는다)을 가짜 주문보다 앞으로 당긴다
  await db.query(`UPDATE app_settings SET value = (now() - interval '2 days')::text WHERE key = 'reviewer_log_capture_cutoff'`);
  console.log('\n[① 리뷰어 홈 보완 목록]');
  const router = require('../src/routes/reviewer.routes');
  const r = await callGet(routeHandler(router, '/my-missing-captures'), { phone8: P8 });
  assert(!r.err, String(r.err && r.err.stack));
  const ids = (r.body.items || []).map(x => x.id);
  ok('두 구매처 사진을 다 낸 묶음 주문은 보완 목록에 없다', !ids.includes(FULL), JSON.stringify(ids));
  ok('보통 주문 미첨부는 종전대로 보완 목록에 있고 첨부 세션이 붙는다',
    ids.includes(PLAIN) && !!(r.body.items.find(x => x.id === PLAIN).captureSession || {}).token);
  const half = (r.body.items || []).find(x => x.id === HALF);
  ok('사진이 정말 빠진 묶음 주문은 목록에 남되 "동시진행" 표시로 내려간다(옛 1장 세션 없음)',
    half && half.dualBundle === true && !half.captureSession, JSON.stringify(half));

  console.log('\n[② 직원 리뷰어 기록 "캡처 없음" 감지]');
  const wv = require('../src/services/writtenVerify.service');
  const ev = require('../src/services/reviewerEventLog.service');
  wv.__setPoolForTest(db); ev.__setPoolForTest(db);
  const det = wv.detectMissingCaptures || (wv._internals && wv._internals.detectMissingCaptures);
  assert(det, 'detectMissingCaptures 를 꺼낼 수 없음');
  await det({ limit: 50 });
  const logged = (await db.query(`SELECT order_submission_id::text id FROM reviewer_event_logs WHERE event_type='order_no_capture'`)).rows.map(x => x.id);
  ok('두 구매처 사진을 다 낸 묶음 주문엔 "캡처 없음" 경고를 만들지 않는다', !logged.includes(FULL), JSON.stringify(logged));
  ok('사진이 정말 빠진 묶음 주문·보통 미첨부는 종전대로 경고', logged.includes(HALF) && logged.includes(PLAIN), JSON.stringify(logged));

  console.log('\n[③ 이미 쌓인 잘못된 경고의 자동 해결]');
  await db.query(`INSERT INTO reviewer_event_logs(event_type, severity, message, order_submission_id) VALUES ('order_no_capture','warn','옛 오판',$1)`, [FULL]);
  await ev.autoResolveHealed();
  const st = Object.fromEntries((await db.query(`SELECT order_submission_id::text id, resolved_by FROM reviewer_event_logs WHERE event_type='order_no_capture'`)).rows.map(x => [x.id, x.resolved_by]));
  ok('두 구매처 사진이 있는 묶음 주문의 옛 경고는 자동 해결된다', st[FULL] === 'auto:capture', JSON.stringify(st));
  ok('사진이 정말 빠진 묶음·보통 미첨부 경고는 그대로 남는다', !st[HALF] && !st[PLAIN], JSON.stringify(st));

  console.log('\n[④ 캡처 연결 백필 — 묶음 주문은 대상 아님]');
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/captureLinkBackfill.service.js'), 'utf8');
  ok('백필 대상 조회·쓰기 둘 다 묶음 주문을 뺀다', (src.match(/isDualBundleSql\(/g) || []).length >= 2);

  console.log('\n[단일 출처]');
  const proj = fs.readFileSync(path.resolve(__dirname, '../src/services/dualPurchaseProjection.service.js'), 'utf8');
  ok('완료 판정은 묶음 읽기(projection)와 같은 사진 조건(primary·committed·교체 안 됨·네이버+쿠팡)',
    /a\.status='committed' AND a\.superseded_at IS NULL/.test(proj) && /\['naver','coupang'\]/.test(proj) && /a\.role==='primary'/.test(proj));
  for (const f of ['routes/reviewer.routes.js', 'services/writtenVerify.service.js', 'services/reviewerEventLog.service.js']) {
    const s = fs.readFileSync(path.resolve(__dirname, '../src', f), 'utf8');
    ok(f + ' 는 판정을 utils/dualCaptureComplete 에서 가져온다(사본 없음)',
      /require\(['"]\.\.\/utils\/dualCaptureComplete['"]\)/.test(s) && !/purchase_capture_artifacts/.test(s));
  }
  const fe = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');
  ok('리뷰어 화면: 동시진행 주문은 첨부 대신 담당자 문의 안내(세션 오류로 끝나지 않음)',
    /it\.dualBundle[\s\S]{0,200}담당자에게 문의/.test(fe));

  await db.pg.close();
  console.log(`\n✅ dualCaptureFalseMissing: ${passed}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
