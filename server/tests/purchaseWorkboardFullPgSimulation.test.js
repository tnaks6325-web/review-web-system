'use strict';

/**
 * 구매양식 저장 → 작업표 기록 전체 흐름의 실제 PostgreSQL 시뮬레이션.
 * 운영 자료는 사용하지 않고 실행마다 격리된 임시 스키마를 만든 뒤 삭제한다.
 */
const assert = require('assert');
const { randomUUID } = require('crypto');
const { Pool, Client } = require('pg');

if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 구매양식 전체 PostgreSQL 시뮬레이션 건너뜀');
  process.exit(0);
}

const sheetlessOrder = require('../src/services/sheetlessOrder.service');
const ledger = require('../src/services/orderLedger.service');
const ledgers = require('../src/services/sheetlessLedger.service');
const participation = require('../src/services/participation.service');
const numbering = require('../src/services/rowNumbering.service');

const WB = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SHEET = 'wt_purchase_full_sim';
const TAB = '구매양식전체시험';
const HEADERS = ['번호', '구매일자', '수취인', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '주문번호', '옵션', '상품'];

function quoteIdent(v) { return `"${String(v).replace(/"/g, '""')}"`; }

(async () => {
  const schema = `purchase_sim_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const admin = new Client({ connectionString: process.env.PGTEST_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdent(schema)}`);

  const rawPool = new Pool({ connectionString: process.env.PGTEST_URL, max: 30 });
  const scopedPool = {
    async query(sql, params) {
      const c = await rawPool.connect();
      try {
        await c.query(`SET search_path TO ${quoteIdent(schema)}, public`);
        return await c.query(sql, params);
      } finally { c.release(); }
    },
    async connect() {
      const c = await rawPool.connect();
      await c.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      return c;
    },
  };

  const saved = {
    load: ledger.loadRawTabContext,
    written: ledger.markOrderWritten,
    identity: ledger.recordReviewIdentity,
    convert: ledger._osRowToOrderData,
    rebuild: ledgers.rebuildLedgers,
    link: participation.recordParticipationLink,
    renumber: numbering.renumberTabInTx,
  };

  const metrics = {};
  try {
    await admin.query(`SET search_path TO ${quoteIdent(schema)}, public`);
    await admin.query(`
      CREATE TABLE workboards (id UUID PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE tab_configs (
        sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL, tab_gid TEXT,
        workboard_id UUID, sheetless BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE TABLE order_submissions (
        id UUID PRIMARY KEY, mirror_status TEXT, deleted_at TIMESTAMPTZ,
        source TEXT, submitted_at TIMESTAMPTZ, recipient TEXT, orderer TEXT,
        phone TEXT, address TEXT, bank TEXT, account TEXT, depositor TEXT,
        price TEXT, order_num TEXT, date_str TEXT, selected_opt_key TEXT,
        selected_product TEXT, workboard_id UUID, campaign_application_id UUID,
        owner_reviewer_id UUID, participant_identity_id UUID
      );
      CREATE TABLE campaign_applications (
        id UUID PRIMARY KEY, campaign_id UUID, status TEXT, order_submission_id UUID, late_order_id UUID
      );
      CREATE TABLE campaign_options (campaign_id UUID, unit_kind TEXT, opt_key TEXT);
      CREATE TABLE campaign_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT NOT NULL, tab_gid TEXT, tab_name TEXT NOT NULL,
        campaign_name TEXT, seq INT NOT NULL, reviewer_name TEXT, recipient_name TEXT,
        phone8 TEXT, option_text TEXT, order_submission_id UUID, row_json JSONB,
        workboard_id UUID, source TEXT, updated_by TEXT, updated_at TIMESTAMPTZ,
        active BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ,
        owner_reviewer_id UUID, participant_identity_id UUID,
        UNIQUE(sheet_id, tab_name, seq)
      );
      INSERT INTO workboards(id,state) VALUES ('${WB}','active'), ('${OTHER}','archived');
      INSERT INTO tab_configs(sheet_id,tab_name,tab_gid,workboard_id,sheetless)
      VALUES ('${SHEET}','${TAB}','77','${WB}',TRUE);
      INSERT INTO campaign_participants(id,sheet_id,tab_gid,tab_name,seq,row_json,workboard_id,source)
      SELECT gen_random_uuid(),'${SHEET}','77','${TAB}',g,
             jsonb_build_object('번호',g::text,'구매일자','','수취인','','연락처','','주소','','은행','','계좌번호','','예금주','','결제금액','','주문번호','','옵션','','상품',''),
             NULL,'worktable'
        FROM generate_series(1,20) g;
    `);

    ledger.loadRawTabContext = async () => ({ headers: HEADERS, tabGid: '77' });
    ledger.markOrderWritten = async () => {};
    ledger.recordReviewIdentity = async () => {};
    ledger._osRowToOrderData = row => ({
      orderer: row.orderer, recipient: row.recipient, phone: row.phone,
      address: row.address, bank: row.bank, account: row.account,
      depositor: row.depositor, price: row.price, orderNum: row.order_num,
      dateStr: row.date_str, selectedOptKey: row.selected_opt_key,
      selectedProduct: row.selected_product,
    });
    ledgers.rebuildLedgers = async () => ({ mirrorRows: 1, indexRows: 1 });
    participation.recordParticipationLink = async () => {};
    numbering.renumberTabInTx = async () => ({ ok: true });
    sheetlessOrder.__setPoolForTest(scopedPool);

    async function addOrder({ name, source = 'order_submit', submittedAt, status = 'queued', campaignId = null }) {
      const id = randomUUID();
      const n = Number(String(name).replace(/\D/g, '')) || Math.floor(Math.random() * 90000000) + 10000000;
      await scopedPool.query(
        `INSERT INTO order_submissions
           (id,mirror_status,source,submitted_at,recipient,orderer,phone,address,bank,account,depositor,price,order_num,date_str,selected_opt_key,selected_product,workboard_id,campaign_application_id)
         VALUES ($1,$2,$3,$4,$5,$5,$6,'서울 시험주소','국민','123-456','시험예금주','11800',$7,'2026-09-08','','시험상품',$8,$9)`,
        [id, status, source, submittedAt || new Date(), name, `010-${String(n).padStart(8, '0').slice(-8, -4)}-${String(n).padStart(8, '0').slice(-4)}`,
         `SIM${Date.now()}${String(n).padStart(8, '0')}`, WB, campaignId]);
      return id;
    }

    async function write(id, name, extra = {}) {
      return sheetlessOrder.writeOrderToWorktable({
        sheetId: SHEET, tabName: TAB, tabGid: '77', orderSubmissionId: id,
        workboardId: WB, loginName: name, ...extra,
      });
    }

    // 실제 사고 조건: 빈자리는 200개지만 현재 작업과의 연결표시가 전부 비어 있다.
    const before = await scopedPool.query(
      `SELECT COUNT(*)::int AS n FROM campaign_participants
        WHERE sheet_id=$1 AND tab_name=$2 AND workboard_id=$3 AND order_submission_id IS NULL`,
      [SHEET, TAB, WB]);
    assert.equal(before.rows[0].n, 0, '수정 전 조건에서는 현재 작업이 사용할 수 있는 빈자리가 0개로 보인다');

    const incidentNames = ['정숙희', '하찬욱', '심수현'];
    const incidentIds = [];
    for (let i = 0; i < incidentNames.length; i++) {
      const id = await addOrder({ name: incidentNames[i], submittedAt: new Date(Date.UTC(2026, 8, 8, 10, 5 + i * 9, 0)) });
      incidentIds.push(id);
      const out = await write(id, incidentNames[i]);
      assert.equal(out.ok && out.written, true, `${incidentNames[i]} 주문이 빈자리에 기록되어야 한다`);
      assert.equal(out.seq, i + 1, '순차 제출은 제출 순서대로 다음 빈자리를 사용한다');
    }
    const incidentRows = (await scopedPool.query(
      `SELECT seq, reviewer_name FROM campaign_participants WHERE order_submission_id = ANY($1::uuid[]) ORDER BY seq`,
      [incidentIds])).rows;
    assert.deepStrictEqual(incidentRows.map(r => r.reviewer_name), incidentNames);

    // 남은 17자리를 동시에 제출한다. 실제 기록 함수와 실제 DB 잠금을 그대로 사용한다.
    const loadIds = [];
    for (let i = 0; i < 17; i++) {
      loadIds.push(await addOrder({ name: `동시제출${String(i + 1).padStart(3, '0')}`, submittedAt: new Date(Date.now() + i) }));
    }
    const loadStarted = Date.now();
    const loadResults = await Promise.all(loadIds.map((id, i) => write(id, `동시제출${String(i + 1).padStart(3, '0')}`)));
    metrics.concurrent17Ms = Date.now() - loadStarted;
    assert.equal(loadResults.filter(r => r.ok && r.written).length, 17, '정원 안 동시 제출은 모두 기록되어야 한다');
    assert.equal(new Set(loadResults.map(r => r.seq)).size, 17, '동시 제출끼리 같은 자리를 함께 쓰면 안 된다');

    const occupied = await scopedPool.query(
      `SELECT COUNT(*)::int AS filled, COUNT(DISTINCT order_submission_id)::int AS unique_orders
         FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND order_submission_id IS NOT NULL`, [SHEET, TAB]);
    assert.deepStrictEqual(occupied.rows[0], { filled: 20, unique_orders: 20 });

    // 정원을 넘긴 일반 주문은 조용히 사라지지 않고 5건 모두 명확한 실패로 남는다.
    const overflowIds = [];
    for (let i = 0; i < 5; i++) overflowIds.push(await addOrder({ name: `정원초과${i + 1}` }));
    const overflow = await Promise.all(overflowIds.map((id, i) => write(id, `정원초과${i + 1}`)));
    assert.equal(overflow.every(r => !r.ok && r.reason === 'no_open_slot'), true);

    // 외부모집 수동제출은 결제 확정 건이므로 정원 밖에도 한 줄을 이어 기록한다.
    const manualId = await addOrder({ name: '외부수동제출', source: 'admin_external' });
    const manual = await write(manualId, '외부수동제출');
    assert.equal(manual.ok && manual.written && manual.seq === 21, true);

    // 서버가 제출 완료로 확정한 참여형 구매도 정원 밖 복구가 가능하다.
    const campaignId = randomUUID();
    const campaignOrderId = await addOrder({ name: '참여형제출', status: 'written', campaignId });
    await scopedPool.query(
      `INSERT INTO campaign_applications(id,campaign_id,status,order_submission_id) VALUES ($1,$1,'submitted',$2)`,
      [campaignId, campaignOrderId]);
    const campaign = await write(campaignOrderId, '참여형제출', { allowConfirmedCampaignOverflow: true });
    assert.equal(campaign.ok && campaign.written && campaign.seq === 22, true);

    // 접수는 됐지만 전달목록이 누락된 최근 주문도 복구 경로에서 한 줄을 이어 기록한다.
    const recoveryId = await addOrder({ name: '누락복구제출', status: 'failed' });
    const recovery = await write(recoveryId, '누락복구제출', { recovered: true, allowMissingQueueRecoveryOverflow: true });
    assert.equal(recovery.ok && recovery.written && recovery.seq === 23, true);

    // 같은 주문 재시도는 같은 줄에 수렴하며 새 줄을 만들지 않는다.
    const retry = await write(recoveryId, '누락복구제출', { recovered: true, allowMissingQueueRecoveryOverflow: true });
    assert.equal(retry.ok && retry.written && retry.seq === 23, true);
    const afterRetry = await scopedPool.query(
      `SELECT COUNT(*)::int AS n FROM campaign_participants WHERE order_submission_id=$1`, [recoveryId]);
    assert.equal(afterRetry.rows[0].n, 1);

    // 보관된 작업이나 주소가 다른 작업에는 절대 쓰지 않는다.
    const protectedId = await addOrder({ name: '다른작업보호' });
    const inactive = await sheetlessOrder.writeOrderToWorktable({
      sheetId: SHEET, tabName: TAB, orderSubmissionId: protectedId, workboardId: OTHER,
    });
    assert.equal(inactive.ok === false && inactive.reason === 'workboard_not_active', true);
    const mismatch = await sheetlessOrder.writeOrderToWorktable({
      sheetId: '잘못된표', tabName: TAB, orderSubmissionId: protectedId, workboardId: WB,
    });
    assert.equal(mismatch.ok === false && mismatch.reason === 'workboard_target_mismatch', true);

    const finalRows = (await scopedPool.query(
      `SELECT seq, reviewer_name, order_submission_id FROM campaign_participants
        WHERE sheet_id=$1 AND tab_name=$2 ORDER BY seq`, [SHEET, TAB])).rows;
    assert.equal(finalRows.length, 23);
    assert.equal(new Set(finalRows.filter(r => r.order_submission_id).map(r => r.order_submission_id)).size, 23);
    metrics.totalWritten = 23;
    metrics.normalCapacityRejected = 5;
    metrics.duplicateRows = 0;
    metrics.namedIncidentRecovered = incidentRows.map(r => `${r.seq}:${r.reviewer_name}`);

    console.log('purchaseWorkboardFullPgSimulation:', JSON.stringify(metrics));
  } finally {
    sheetlessOrder.__setPoolForTest(null);
    ledger.loadRawTabContext = saved.load;
    ledger.markOrderWritten = saved.written;
    ledger.recordReviewIdentity = saved.identity;
    ledger._osRowToOrderData = saved.convert;
    ledgers.rebuildLedgers = saved.rebuild;
    participation.recordParticipationLink = saved.link;
    numbering.renumberTabInTx = saved.renumber;
    await rawPool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
})().catch(err => { console.error(err); process.exit(1); });
