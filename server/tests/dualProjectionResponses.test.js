'use strict';
/**
 * 동시진행 응답 투영 — 리뷰어 검색 · 구매양식 재열기(dualPurchaseDraft) · 직원 작업표 roster.
 * 실제 서비스 함수를 PGlite(실제 SQL · migration 215 두 번 적용)에서 실행한다.
 * 일반 행은 HEAD 원본 서비스와 같은 DB 에서 나란히 돌려 키·값이 같음을 대조한다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dual-projection-local-only-test-key-123456';
const server = path.resolve(__dirname, '..');
const repo = path.resolve(server, '..');
const servicesDir = path.join(server, 'src/services');

// ── PGlite 를 공용 pool 자리에 꽂는다(운영 DB 접속 경로 자체를 만들지 않는다) ──
const pg = new PGlite();
const queryLog = [];
const db = {
  query: async (sql, args) => { queryLog.push(String(sql)); return pg.query(sql, args); },
  connect: async () => ({ query: (s, a) => db.query(s, a), release() {} }),
  on() {},
};
const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: db };

/** 같은 파일의 HEAD 원본을 같은 require 문맥에서 적재한다(일반 행 불변 대조용). */
function loadHead(rel) {
  const filename = path.join(server, rel);
  // 비교 기준 = 동시진행 화면 연결 전 커밋(dualSubmitFixture.baselineSource 와 같은 기준).
  //   HEAD 로 두면 연결을 커밋한 순간 기준도 바뀌어 "HEAD 와 같다" 검사가 스스로 깨진다.
  const source = cp.execFileSync('git', ['show', '123802a9:server/' + rel], { cwd: repo, encoding: 'utf8' });
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + source + '\n})', { filename: filename + '#HEAD' })(
    createRequire(filename), mod, mod.exports, filename, path.dirname(filename));
  return mod.exports;
}

const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const OWNER_B = '00000000-0000-4000-8000-0000000000b1';
const DUAL_A = '00000000-0000-4000-8000-00000000d0a1';
const DUAL_B = '00000000-0000-4000-8000-00000000d0b1';
const ORD_A = '00000000-0000-4000-8000-00000000a0a1';
const P8A = '11112222', P8B = '33334444';
const snapshot = { name: '시험 상품', channels: { naver: { url: 'https://naver.invalid', pay: 9000 }, coupang: { url: 'https://coupang.invalid', pay: 10000 } }, cashReceiptRequired: true };
const sha = c => c.repeat(64);

let ready;
async function setup() {
  if (ready) return ready;
  ready = (async () => {
    await pg.exec(`
      CREATE TABLE reviewers(id uuid PRIMARY KEY, phone8 text, sub_accounts jsonb);
      CREATE TABLE review_index(id serial PRIMARY KEY, reviewer_name text, recipient_name text, campaign_name text,
        sheet_id text, tab_name text, tab_gid text, row_index int, is_submitted boolean DEFAULT false, is_submitted2 text,
        product_name text, product_url text, start_date text, end_date text, round text, row_json jsonb, submit_col text,
        submit_col2 text, review_file_at timestamptz, review_file_id text, review_file_url text, review_file_name text,
        review_file_count int, phone8 text, built_at timestamptz DEFAULT now());
      CREATE TABLE tab_configs(sheet_id text, tab_name text, tab_gid text, campaign_name text, display_name text,
        workboard_display_name text, manager text, time_range text, review_type text, taekhap boolean, is_closed boolean DEFAULT false,
        delivery_type text, is_bulk boolean, income_type text, nc_mode boolean, folder_url text, capture_folder_url text,
        capture_slots jsonb, archived_rounds text, sheetless boolean DEFAULT false, source_of_truth text, deposit_name text,
        review_fee int, transfer_bank text, work_kind text, workboard_schema_version int, PRIMARY KEY(sheet_id, tab_name));
      CREATE TABLE recruit_campaigns(id text PRIMARY KEY, title text, work_detail jsonb, linked_sheet_id text, linked_tab_name text,
        linked_tab_gid text, source_work_order_id text, participation_mode boolean DEFAULT true, status text DEFAULT 'active',
        review_type text, work_kind text, created_at timestamptz DEFAULT now(), archived_at timestamptz, cash_receipt_required boolean);
      CREATE TABLE campaign_applications(id integer PRIMARY KEY, campaign_id text, phone8 text, owner_phone8 text,
        owner_reviewer_id uuid, participant_identity_id uuid, participant_card_id uuid, order_submission_id uuid,
        status text, hold_token text, expires_at timestamptz, applied_at timestamptz DEFAULT now(), submitted_at timestamptz,
        option_key text, reject_reason text, decided_at timestamptz, purchase_qty int, qty_tier_amount int, is_popular_snapshot boolean);
      CREATE TABLE order_submissions(id uuid PRIMARY KEY, sheet_id text, tab_name text, tab_gid text, gid text, sheet_row int,
        orderer text, recipient text, user_id text, phone text, address text, order_num text, date_str text, price text,
        selected_opt_key text, mirror_status text, owner_reviewer_id uuid, participant_identity_id uuid, participant_card_id uuid,
        participant_identity_key_hash text, campaign_application_id integer, deleted_at timestamptz,
        submitted_at timestamptz DEFAULT now(), sheet_written_at timestamptz, rule_flags jsonb, delivery_memo text,
        delivery_memo_check text, capture_flags jsonb, purchase_qty int, qty_tier_amount int, dedup_key text);
      CREATE TABLE campaign_participants(id uuid PRIMARY KEY, seq int, sheet_id text, tab_name text, tab_gid text, source text,
        order_submission_id uuid, identity_key text, phone8 text, recipient_name text, reviewer_name text, option_text text,
        product_name text, round text, row_json jsonb, submit_col text, submit_col2 text, active boolean DEFAULT true,
        deleted_at timestamptz, is_submitted boolean DEFAULT false, is_paid boolean DEFAULT false, owner_reviewer_id uuid,
        participant_identity_id uuid, revision int, updated_at timestamptz, held_at timestamptz);
      CREATE TABLE participation_links(sheet_id text, tab_name text, row_index int, phone8 text, owner_reviewer_id uuid, participant_identity_id uuid);
      CREATE TABLE review_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id text, tab_name text, row_index int,
        reviewer_name text, slot_key text, file_id text UNIQUE, file_url text, file_name text, file_hash text, source text,
        upload_batch_id uuid, completed_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE review_inspections(file_id text PRIMARY KEY, status text, resolution text, checks jsonb);
      CREATE TABLE payment_batch_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text);
      CREATE TABLE review_closed_targets(sheet_id text, tab_name text, row_index int, review_status text, order_submission_id uuid);
      CREATE TABLE reviewer_participations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id text, tab_name text, row_index int,
        lifecycle_status text, review_obligation_status text, review_evidence jsonb, campaign_participant_id uuid);
      CREATE TABLE index_master_archive(sheet_id text, tab_name text, tab_gid text, campaign_name text, archived_at timestamptz, archived_by text);
      CREATE TABLE trackb_tab_finished(sheet_id text, tab_name text, tab_gid text, deleted_at timestamptz);
      CREATE TABLE reviewer_phone_changes(old_phone8 text, reviewer_id uuid);
      CREATE TABLE reviewer_identities(id uuid, owner_reviewer_id uuid);
      CREATE TABLE reviewer_identity_aliases(identity_id uuid, phone8 text);
      CREATE TABLE participant_edits(id serial PRIMARY KEY, sheet_id text, tab_name text, anchor_type text, anchor_value text,
        field text, kind text, value_text text, value_bool boolean, created_by text, created_at timestamptz DEFAULT now(),
        reverted_at timestamptz, reverted_by text);
      CREATE TABLE raw_sheet_tabs(sheet_id text, tab_name text, tab_gid text, headers jsonb, detected_headers jsonb, mirrored_at timestamptz);
      CREATE TABLE campaign_options(id serial PRIMARY KEY, campaign_id text, opt_key text, option_url text, pay_amount int, recruit_total int,
        daily_limit int, sort_order int DEFAULT 0, status text DEFAULT 'active', inflow_type text, product_name text, unit_kind text,
        inflow_guide_html text, inflow_guide_images jsonb, thumbnail_url text, paused_at timestamptz);
      CREATE TABLE qna_slots(id bigserial PRIMARY KEY, work_order_id text, sheet_id text, tab_name text, seq int, unit_key text,
        unit_seq int, slot_date date, visibility text, question_text text, status text DEFAULT 'open', campaign_application_id int);
      CREATE TABLE campaign_daily_plans(campaign_id text, plan_date date, planned_count int);
      CREATE TABLE app_settings(key text PRIMARY KEY, value text);
      CREATE TABLE trackb_custom_columns(id serial, sheet_id text, tab_name text, col_name text, sort_order int, deleted_at timestamptz);
      CREATE TABLE trackb_cell_colors(sheet_id text, tab_name text, anchor_type text, anchor_value text, field text, color text);
      CREATE TABLE work_orders(id text PRIMARY KEY, title text, product_option text, product_options_json text, source_review_order_id text,
        bidir_state text, sync_version int, linked_campaign_id text, pay_amount int, review_fee int, daily_count int, daily_count_text text,
        purchase_time text, inflow_keyword text, inflow_type text, inflow_guide text, delivery_type text, courier_proxy text, review_type text,
        recruit_count int, review_guide text, special_notes text, product_url text, start_date text, manager_name text, created_by text,
        status text, goods_cost_type text, work_manager text, linked_tab_sheet_id text, linked_tab_name text,
        deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE trackb_work_order_links(sheet_id text, tab_name text, work_order_id text, deleted_at timestamptz);
    `);
    const migration = fs.readFileSync(path.join(server, 'migrations/215_dual_channel_purchase_bundles.sql'), 'utf8');
    await pg.exec(migration); await pg.exec(migration);
    const digest = require('../src/services/dualPurchaseProof.service').hash;
    await pg.query(`INSERT INTO reviewers VALUES($1,$2,'[]'),($3,$4,'[]')`, [OWNER_A, P8A, OWNER_B, P8B]);
    await pg.query(`INSERT INTO tab_configs(sheet_id,tab_name,tab_gid,display_name,campaign_name,income_type,sheetless,source_of_truth)
      VALUES('s','t','g','동시 작업','동시 작업','',true,'db'),('s2','t2','g2','일반 작업','일반 작업','',true,'db')`);
    await pg.query(`INSERT INTO recruit_campaigns(id,title,work_detail,linked_sheet_id,linked_tab_name,linked_tab_gid)
      VALUES('camp','동시 작업',$1,'s','t','g'),('camp2','일반 작업','{}','s2','t2','g2')`, [JSON.stringify({ dualChannelProduct: snapshot })]);
    await pg.query(`INSERT INTO campaign_applications(id,campaign_id,phone8,owner_phone8,owner_reviewer_id,status,hold_token,expires_at)
      VALUES(1,'camp',$1,$1,$2,'submitted','hold-a',now()+interval '1 hour'),(2,'camp',$3,$3,$4,'submitted','hold-b',now()+interval '1 hour'),
            (3,'camp2',$1,$1,$2,'submitted','hold-o',now()+interval '1 hour')`, [P8A, OWNER_A, P8B, OWNER_B]);
    for (const [id, app, owner, phone, seq] of [[DUAL_A, 1, OWNER_A, '010' + P8A, 2], [DUAL_B, 2, OWNER_B, '010' + P8B, 4]]) {
      await pg.query(`INSERT INTO order_submissions(id,sheet_id,tab_name,gid,sheet_row,recipient,phone,price,mirror_status,owner_reviewer_id,
        campaign_application_id,purchase_bundle_version,purchase_bundle_application_id,purchase_bundle_hash,purchase_condition_snapshot,
        purchase_identity_result,purchase_bundle_revision)
        VALUES($1,'s','t','g',$5,'수취','${phone}','19000','written',$2,$3,1,$3,$4,$6,'uncertain',2)`,
        [id, owner, app, sha(id === DUAL_A ? 'a' : 'e'), seq, JSON.stringify(snapshot)]);
      for (const [ch, amount] of [['naver', 9000], ['coupang', 10000]]) {
        await pg.query(`INSERT INTO order_purchase_channels VALUES($1,$2,'num-'||$2,'uid-'||$2,'수취','010','주소',$3,NULL)`, [id, ch, amount]);
        await pg.query(`INSERT INTO purchase_capture_artifacts(application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,
          extraction_proof_hash,final_input_hash,condition_snapshot_hash,status,created_by)
          VALUES($1,$2,$3,'primary',1,$4,$5,$5,$5,$5,'committed',$6)`,
          [app, id, ch, 'purchase-' + ch + '-file-0000' + app, sha(ch === 'naver' ? (app === 1 ? 'b' : '1') : (app === 1 ? 'c' : '2')), String(owner)]);
      }
      await pg.query(`INSERT INTO campaign_participants(id,seq,sheet_id,tab_name,tab_gid,source,order_submission_id,phone8,reviewer_name,
        recipient_name,row_json,submit_col,owner_reviewer_id) VALUES(gen_random_uuid(),$1,'s','t','g','order',$2,$3,'참여자','수취',$4,'리뷰제출',$5)`,
        [seq, id, phone.slice(-8), JSON.stringify({ 번호: seq, 결제금액: '19000', 리뷰제출: '' }), owner]);
      await pg.query(`INSERT INTO review_index(reviewer_name,recipient_name,sheet_id,tab_name,tab_gid,row_index,row_json,submit_col,phone8)
        VALUES('참여자','수취','s','t','g',$1,$2,'리뷰제출',$3)`, [seq, JSON.stringify({ 번호: seq, 결제금액: '19000', 리뷰제출: '' }), phone.slice(-8)]);
    }
    // 일반 행(같은 리뷰어 A) — 응답이 HEAD 와 키·값이 같아야 한다.
    await pg.query(`INSERT INTO order_submissions(id,sheet_id,tab_name,gid,sheet_row,recipient,phone,price,mirror_status,owner_reviewer_id,campaign_application_id)
      VALUES($1,'s2','t2','g2',3,'수취','010${P8A}','5000','written',$2,3)`, [ORD_A, OWNER_A]);
    await pg.query(`INSERT INTO campaign_participants(id,seq,sheet_id,tab_name,tab_gid,source,order_submission_id,phone8,reviewer_name,
      recipient_name,row_json,submit_col,owner_reviewer_id) VALUES(gen_random_uuid(),3,'s2','t2','g2','order',$1,$2,'참여자','수취',$3,'리뷰제출',$4)`,
      [ORD_A, P8A, JSON.stringify({ 번호: 3, 결제금액: '5000', 리뷰제출: '' }), OWNER_A]);
    await pg.query(`INSERT INTO review_index(reviewer_name,recipient_name,sheet_id,tab_name,tab_gid,row_index,row_json,submit_col,phone8)
      VALUES('참여자','수취','s2','t2','g2',3,$1,'리뷰제출',$2)`, [JSON.stringify({ 번호: 3, 결제금액: '5000', 리뷰제출: '' }), P8A]);
    // A 의 네이버 리뷰는 현행 완료 증빙. 쿠팡 리뷰는 올렸지만 아직 완료 전(제출 슬롯 아님).
    const hash = digest(snapshot);
    await pg.query(`INSERT INTO review_submissions(sheet_id,tab_name,row_index,slot_key,file_id,file_hash,source,completed_at,
      order_submission_id,purchase_channel,evidence_role,evidence_revision,byte_sha256,condition_snapshot_hash)
      VALUES('s','t',2,'review','rv-naver-a',$1,'upload',now(),$2,'naver','review',1,$1,$3),
            ('s','t',2,'slot2','rv-coupang-a',$4,'upload',NULL,$2,'coupang','review',1,$4,$3)`, [sha('d'), DUAL_A, hash, sha('f')]);
    // A 의 다른 동시진행 신청(아직 접수 전) — 재열기 대상. B 의 스테이징 사진은 절대 섞이면 안 된다.
    await pg.query(`INSERT INTO campaign_applications(id,campaign_id,phone8,owner_phone8,owner_reviewer_id,status,hold_token,expires_at)
      VALUES(4,'camp',$1,$1,$2,'applied','hold-a4',now()+interval '1 hour'),(5,'camp',$3,$3,$4,'applied','hold-b5',now()+interval '1 hour')`,
      [P8A, OWNER_A, P8B, OWNER_B]);
    await pg.query(`INSERT INTO purchase_capture_artifacts(application_id,channel,role,revision,file_id,byte_sha256,extraction_json,
      extraction_proof_hash,final_input_hash,condition_snapshot_hash,status,created_by) VALUES
      (4,'naver','primary',3,'stage-a4-n',$1,'{"approval":{"secret":"no"}}',$1,$1,$1,'staged',$5),
      (4,'naver','primary',2,'stage-a4-n-old',$2,NULL,$2,$2,$2,'superseded',$5),
      (5,'coupang','primary',1,'stage-b5-c',$3,NULL,$3,$3,$3,'staged',$6),
      (4,'naver','supplement',1,'stage-a4-ns',$4,NULL,$4,$4,$4,'staged',$5)`, [sha('3'), sha('4'), sha('5'), sha('6'), OWNER_A, OWNER_B]);
    await pg.query(`UPDATE purchase_capture_artifacts SET superseded_at=now() WHERE file_id='stage-a4-n-old'`);
  })();
  return ready;
}

const runtime = require('../src/services/dualChannelRuntime.service');
const allReady = () => runtime.__setReadinessForTest(Object.fromEntries(
  ['settings', 'roundtrip', 'recruitment', 'purchase', 'review', 'payment', 'operationalEnabled'].map(k => [k, true])));
const closed = () => runtime.__setReadinessForTest(null);
const { snapshotCaptureSlots } = require('../src/utils/captureSlots');
const byRow = (results, sheetId, rowIndex) => results.find(r => r.sheetId === sheetId && r.rowIndex === rowIndex);

// 모든 서비스는 지연 require — 변이 검사(scratch)가 require.cache 에 메모리 변이본을 먼저 꽂을 수 있게.
const svc = name => require('../src/services/' + name + '.service');

async function withRestore(sqlRestore, fn) {
  try { return await fn(); } finally { await pg.exec(sqlRestore); }
}

test('리뷰어 검색: 동시진행 행은 서버 슬롯·현행 완료 슬롯을 싣고, 일반 행은 HEAD 와 키·값이 같다', async () => {
  await setup(); allReady();
  const search = svc('search');
  const head = loadHead('src/services/search.service.js');
  const now = await search.searchByName('', P8A, { includeSubmitted: true });
  const before = await head.searchByName('', P8A, { includeSubmitted: true });
  const dual = byRow(now.results, 's', 2);
  assert.ok(dual, '내 동시진행 행이 검색돼야 한다');
  assert.deepEqual(dual.purchaseConditionSnapshot, snapshot);
  assert.equal(dual.orderSubmissionId, DUAL_A);
  assert.equal(dual.purchaseBundleRevision, 2);
  assert.deepEqual(dual.captureSlots.map(({ evidenceRevision, ...s }) => s), snapshotCaptureSlots(snapshot), '슬롯은 snapshot 단일 해석기 결과 그대로');
  assert.ok(dual.captureSlots.every(s => Number.isSafeInteger(s.evidenceRevision)), '각 슬롯에 업로드 기대 revision');
  assert.deepEqual(dual.captureSlots.map(s => [s.key, s.channel, s.role]),
    [['review', 'naver', 'review'], ['slot2', 'coupang', 'review'], ['receipt', 'naver', 'receipt'], ['receipt2', 'coupang', 'receipt']]);
  assert.deepEqual(dual.submittedSlots, ['review'], '완료 전 쿠팡 리뷰는 제출 슬롯이 아니다');
  // 일반 행: HEAD 원본과 키·값 동일
  assert.deepEqual(byRow(now.results, 's2', 3), byRow(before.results, 's2', 3));
  assert.ok(byRow(now.results, 's2', 3));
  // 동시진행 행에서 새 필드 외에는 HEAD 와 동일
  const headDual = byRow(before.results, 's', 2);
  const strip = r => { const c = { ...r }; for (const k of ['purchaseConditionSnapshot', 'orderSubmissionId', 'purchaseBundleRevision', 'captureSlots', 'submittedSlots']) delete c[k]; return c; };
  assert.deepEqual(strip(dual), strip(headDual));
  // 남의 신청(B) 미노출
  const json = JSON.stringify(now);
  assert.equal(json.includes(DUAL_B), false);
  assert.equal(byRow(now.results, 's', 4), undefined);
});

test('리뷰어 검색: snapshot 해석 실패·완료 판정 실패는 슬롯을 빼서 화면이 새로고침을 요구한다', async () => {
  await setup(); allReady();
  const search = svc('search');
  await withRestore(`UPDATE order_submissions SET purchase_condition_snapshot='${JSON.stringify(snapshot)}' WHERE id='${DUAL_A}'`, async () => {
    await pg.query(`UPDATE order_submissions SET purchase_condition_snapshot='{"channels":{"naver":{}}}' WHERE id=$1`, [DUAL_A]);
    const row = byRow((await search.searchByName('', P8A, { includeSubmitted: true })).results, 's', 2);
    assert.deepEqual(row.purchaseConditionSnapshot, { channels: { naver: {} } });
    assert.equal(row.orderSubmissionId, DUAL_A);
    assert.equal('captureSlots' in row, false, '모르는 슬롯을 단일 리뷰 슬롯(null)로 꾸미지 않는다');
    assert.equal('submittedSlots' in row, false);
  });
  await withRestore(`ALTER TABLE review_inspections_x RENAME TO review_inspections`, async () => {
    await pg.exec('ALTER TABLE review_inspections RENAME TO review_inspections_x');   // 완료 판정 조회 실패 주입
    const row = byRow((await search.searchByName('', P8A, { includeSubmitted: true })).results, 's', 2);
    assert.deepEqual(row.purchaseConditionSnapshot, snapshot);
    assert.equal('captureSlots' in row, false);
    assert.equal('submittedSlots' in row, false, '완료 조회 실패를 빈 제출([])로 꾸미지 않는다');
  });
});

async function workDetail(port, campaignId, phone8, holdToken) {
  const r = await fetch(`http://127.0.0.1:${port}/api/campaign/${campaignId}/work-detail?phone8=${phone8}&holdToken=${holdToken}`);
  return { status: r.status, body: await r.json() };
}
async function withRouter(routerModule, fn) {
  const express = require('express');
  const app = express();
  app.use('/api/campaign', routerModule);
  app.use((err, req, res, next) => res.status(500).json({ ok: false, error: err.message }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  try { return await fn(srv.address().port); } finally { await new Promise(r => srv.close(r)); }
}

test('구매양식 재열기: 본인 신청의 현행 스테이징 사진 id·revision·구매처·역할만 싣고 승인·비밀은 싣지 않는다', async () => {
  await setup(); allReady();
  await withRouter(require('../src/routes/campaign.routes'), async port => {
    const mine = await workDetail(port, 'camp', P8A, 'hold-a4');
    assert.equal(mine.status, 200);
    const draft = mine.body.dualPurchaseDraft;
    assert.ok(draft, '동시진행 신청은 재열기 상태를 싣는다');
    assert.equal(draft.version, 1);
    assert.equal(draft.campaignApplicationId, 4);
    assert.equal(draft.committedOrderSubmissionId, null);
    assert.match(draft.conditionFingerprint, /^[0-9a-f]{64}$/);
    assert.match(draft.identityFingerprint, /^[0-9a-f]{64}$/);
    const ids = (await pg.query(`SELECT id,file_id FROM purchase_capture_artifacts WHERE application_id=4 AND superseded_at IS NULL`)).rows;
    const idOf = file => ids.find(r => r.file_id === file).id;
    assert.deepEqual(draft.artifacts, [
      { id: idOf('stage-a4-n'), channel: 'naver', role: 'primary', revision: 3 },
      { id: idOf('stage-a4-ns'), channel: 'naver', role: 'supplement', revision: 1 },
    ]);
    assert.deepEqual(Object.keys(draft).sort(), ['artifacts', 'campaignApplicationId', 'committedOrderSubmissionId', 'conditionFingerprint', 'identityFingerprint', 'version']);
    const json = JSON.stringify(draft);
    assert.doesNotMatch(json, /stage-|approval|secret|token|sha|hash|file/i);
    // B 의 신청 사진은 A 의 응답 어디에도 없다
    const bId = (await pg.query(`SELECT id FROM purchase_capture_artifacts WHERE file_id='stage-b5-c'`)).rows[0].id;
    assert.equal(JSON.stringify(mine.body).includes(bId), false);
    // A 의 전화번호로 B 의 열쇠를 쓰면 기존 게이트가 막고 재열기 상태도 없다
    const cross = await workDetail(port, 'camp', P8A, 'hold-b5');
    assert.equal(cross.status, 403);
    assert.equal('dualPurchaseDraft' in cross.body, false);
    const theirs = await workDetail(port, 'camp', P8B, 'hold-b5');
    assert.deepEqual(theirs.body.dualPurchaseDraft.artifacts, [{ id: bId, channel: 'coupang', role: 'primary', revision: 1 }]);
    assert.notEqual(theirs.body.dualPurchaseDraft.identityFingerprint, draft.identityFingerprint);
    // 접수된 신청은 부모 주문 id 만 알려 화면이 다시 제출하지 않게 한다
    const done = await workDetail(port, 'camp', P8A, 'hold-a');
    assert.equal(done.body.dualPurchaseDraft.committedOrderSubmissionId, DUAL_A);
    assert.deepEqual(done.body.dualPurchaseDraft.artifacts, []);
    // 조건이 바뀌면 지문도 바뀐다
    await withRestore(`UPDATE recruit_campaigns SET work_detail='${JSON.stringify({ dualChannelProduct: snapshot })}' WHERE id='camp'`, async () => {
      await pg.query(`UPDATE recruit_campaigns SET work_detail=$1 WHERE id='camp'`, [JSON.stringify({ dualChannelProduct: { ...snapshot, channels: { ...snapshot.channels, naver: { url: 'https://naver.invalid', pay: 9100 } } } })]);
      const changed = await workDetail(port, 'camp', P8A, 'hold-a4');
      assert.notEqual(changed.body.dualPurchaseDraft.conditionFingerprint, draft.conditionFingerprint);
    });
    // 준비 상태 기본 닫힘이면 싣지 않는다(화면은 준비 중으로 접힌다)
    closed();
    const shut = await workDetail(port, 'camp', P8A, 'hold-a4');
    assert.equal(shut.status, 200);
    assert.equal('dualPurchaseDraft' in shut.body, false);
    allReady();
  });
});

test('구매양식 재열기: 일반 공고 응답은 HEAD 라우트와 키·값이 같다(serverNow 제외)', async () => {
  await setup(); allReady();
  const norm = b => { const c = { ...b }; delete c.serverNow; return c; };
  const now = await withRouter(require('../src/routes/campaign.routes'), port => workDetail(port, 'camp2', P8A, 'hold-o'));
  const head = await withRouter(loadHead('src/routes/campaign.routes.js'), port => workDetail(port, 'camp2', P8A, 'hold-o'));
  assert.equal(now.status, 200);
  assert.deepEqual(norm(now.body), norm(head.body));
  assert.equal('dualPurchaseDraft' in now.body, false);
});

test('직원 작업표: 동시진행 행에 구매처별 금액·현행 사진·확인 상태를 싣고 합계는 두 금액 합이다', async () => {
  await setup(); allReady();
  const trackB = svc('trackB'); trackB.__setPoolForTest(db);
  const w = await trackB.workdeskTab({ sheetId: 's', tabName: 't', role: 'master' });
  const row = w.roster.find(r => r.seq === 2);
  const arts = (await pg.query(`SELECT id,channel,file_id FROM purchase_capture_artifacts WHERE order_submission_id=$1 ORDER BY channel`, [DUAL_A])).rows;
  assert.deepEqual(row.dualPurchase, {
    orderSubmissionId: DUAL_A, revision: 2, bundleHash: 'a'.repeat(64), identityResult: 'uncertain', identityReview: null,
    purchases: { naver: { paidAmount: 9000 }, coupang: { paidAmount: 10000 } },
    artifacts: ['coupang', 'naver'].map(ch => ({ id: arts.find(a => a.channel === ch).id, channel: ch, role: 'primary', revision: 1, fileId: 'purchase-' + ch + '-file-00001' })),
  });
  assert.equal(row.dualPurchase.purchases.naver.paidAmount + row.dualPurchase.purchases.coupang.paidAmount, Number(row.order.price));
  // 다른 사람 행(B)도 자기 주문만
  assert.equal(w.roster.find(r => r.seq === 4).dualPurchase.orderSubmissionId, DUAL_B);
  // 일반 작업표: HEAD 와 응답 전체가 같다
  const head = loadHead('src/services/trackB.service.js'); head.__setPoolForTest(db);
  const ordinaryNow = await trackB.workdeskTab({ sheetId: 's2', tabName: 't2', role: 'master' });
  const ordinaryHead = await head.workdeskTab({ sheetId: 's2', tabName: 't2', role: 'master' });
  assert.deepEqual(ordinaryNow, ordinaryHead);
  // 동시진행 작업표도 dualPurchase 외에는 HEAD 와 같다
  const dualHead = await head.workdeskTab({ sheetId: 's', tabName: 't', role: 'master' });
  assert.deepEqual({ ...w, roster: w.roster.map(r => { const c = { ...r }; delete c.dualPurchase; return c; }) }, dualHead);
});

test('직원 작업표: 업체 응답에는 내부 확인값을 싣지 않고, 하위 자료 조회 실패는 0으로 꾸미지 않는다', async () => {
  await setup(); allReady();
  const trackB = svc('trackB'); trackB.__setPoolForTest(db);
  const adv = await trackB.workdeskTab({ sheetId: 's', tabName: 't', role: 'advertiser', allowAllWorkdesk: true });
  assert.ok(adv.roster.length >= 2);
  assert.equal(adv.roster.some(r => 'dualPurchase' in r), false);
  assert.equal(JSON.stringify(adv).includes('a'.repeat(64)), false);
  const head = loadHead('src/services/trackB.service.js'); head.__setPoolForTest(db);
  assert.deepEqual(adv, await head.workdeskTab({ sheetId: 's', tabName: 't', role: 'advertiser', allowAllWorkdesk: true }));
  await withRestore(`INSERT INTO order_purchase_channels VALUES('${DUAL_A}','coupang','num-coupang','uid-coupang','수취','010','주소',10000,NULL)`, async () => {
    await pg.query(`DELETE FROM order_purchase_channels WHERE order_submission_id=$1 AND channel='coupang'`, [DUAL_A]);
    const w = await trackB.workdeskTab({ sheetId: 's', tabName: 't', role: 'master' });
    const row = w.roster.find(r => r.seq === 2);
    assert.deepEqual(row.dualPurchase, { orderSubmissionId: DUAL_A }, '불완전 하위자료는 금액·사진을 빼고 확인 필요로 접는다');
    assert.ok(w.roster.find(r => r.seq === 4).dualPurchase.purchases, '다른 행은 영향 없음');
  });
});

test('화면 소비처가 실제 응답을 그대로 받는다: 검색 슬롯 검사·재열기 컨트롤러·작업표 패널', async () => {
  await setup(); allReady();
  const front = path.join(repo, 'frontend');
  // ① 리뷰 제출 화면의 동시진행 슬롯 검사(search-app.js _dualSlotsForItem) — 실제 함수 추출 실행
  const app = fs.readFileSync(path.join(front, 'js/search-app.js'), 'utf8');
  const start = app.indexOf('function _dualSlotsForItem('), end = app.indexOf('\nfunction openSubmitMulti(', start);
  const dualSlots = vm.runInNewContext('(' + app.slice(start, end) + ')', {});
  const search = svc('search');
  const item = byRow((await search.searchByName('', P8A, { includeSubmitted: true })).results, 's', 2);
  assert.deepEqual(dualSlots(item).map(s => s.key), ['review', 'slot2', 'receipt', 'receipt2']);
  const { captureSlots, submittedSlots, ...unknown } = item;
  assert.throws(() => dualSlots(unknown), /새로고침/, '슬롯이 빠진 동시진행 행은 화면이 새로고침을 요구한다');
  // ①-b 실제 리뷰 제출 입구(_submitReviewSlots)가 쓰는 검사: 각 슬롯의 현재 증빙 revision 이 있어야 사진을 올린다.
  const rs = app.indexOf('function _dualReviewSlotsReady('), re = app.indexOf('\nasync function _dualReviewPost(', rs);
  const slotsReady = vm.runInNewContext('(' + app.slice(rs, re) + ')', {});
  assert.equal(slotsReady(item.captureSlots), true, '실제 검색 응답으로 동시진행 리뷰 제출을 시작할 수 있다');
  assert.deepEqual(item.captureSlots.map(s => [s.key, s.evidenceRevision]),
    [['review', 1], ['slot2', 1], ['receipt', 0], ['receipt2', 0]], '서버 업로드 검사와 같은 구매처·역할별 최신 revision(완료 전 쿠팡 업로드도 포함)');
  // ② 구매양식 재열기: 실제 응답의 draft 가 컨트롤러 검증을 통과하고 다음 revision·기대 id 로 이어진다
  const { createController } = require(path.join(front, 'js/dual-channel-purchase.js'));
  const detail = await withRouter(require('../src/routes/campaign.routes'), port => workDetail(port, 'camp', P8A, 'hold-a4'));
  const calls = [];
  const c = createController({ campaignId: 'camp', campaignApplicationId: 4, campaignHoldToken: 'hold-a4' },
    async (url, body) => { calls.push({ url, body }); throw Object.assign(Error('stop'), { status: 500 }); },
    { requireServerState: true, serverState: detail.body.dualPurchaseDraft });
  await c.setImage('naver', { imageBase64: 'QUFB', mimeType: 'image/jpeg' });
  await assert.rejects(c.stage('naver'), /stop/);
  assert.equal(calls[0].url, '/api/image/dual/extract', '현재 서버 상태를 받아들여 판독 단계로 넘어간다');
  assert.equal(calls[0].body.revision, 4, '현행 revision 3 다음 번호');
  const blocked = createController({ campaignId: 'camp', campaignApplicationId: 4, campaignHoldToken: 'hold-a4' },
    async () => { throw Error('호출되면 안 됨'); }, { requireServerState: true, serverState: undefined });
  await blocked.setImage('naver', { imageBase64: 'QUFB', mimeType: 'image/jpeg' });
  await assert.rejects(blocked.stage('naver'), /사진 보관 상태를 확인하지 못했습니다/, '필드 생략 = 준비 중으로 접힘');
  // ③ 작업표 패널(workdesk.html _dualPurchasePanel) — 실제 roster 행
  const html = fs.readFileSync(path.join(front, 'workdesk.html'), 'utf8');
  const ps = html.indexOf('function _dualPurchasePanel('), pe = html.indexOf('\nasync function _dualStaffMutation(', ps);
  const panelFor = role => vm.runInNewContext('(' + html.slice(ps, pe) + ')', {
    esc: v => String(v), _rvUrl: id => (/^[-\w]{20,}$/.test(String(id || '')) ? '/img/' + id : ''),
    _isInternalRole: () => ['master', 'admin', 'staff'].includes(role) });
  const trackB = svc('trackB'); trackB.__setPoolForTest(db);
  const w = await trackB.workdeskTab({ sheetId: 's', tabName: 't', role: 'master' });
  const panel = panelFor('master')(w.roster.find(r => r.seq === 2));
  assert.match(panel, /합계 19,000원/);
  assert.match(panel, /네이버 9,000원 <a [^>]*\/img\/purchase-naver-file-00001/);
  assert.match(panel, /쿠팡 10,000원 <a [^>]*\/img\/purchase-coupang-file-00001/);
  assert.match(panel, /배송지 직원 확인 대기/);
  assert.match(panelFor('master')({ id: 'x', dualPurchase: { orderSubmissionId: DUAL_A } }), /불러오지 못했습니다/);
});
