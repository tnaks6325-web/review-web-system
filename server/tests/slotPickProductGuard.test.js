'use strict';
/* 결정 346 — 상품이 정해진 주문의 빈 줄 고르기(사용자 확정 '가'안 2026-11-06).
 *
 * 진짜 SQL(pglite)로 writeOrderToWorktable(InTx)을 실제로 돌린다. 줄 고르기·빈 줄 조건(openSlotRowSql)·
 * 정원 밖 허용 판정(_canAppendConfirmedOverflowOrder)·끝에 붙이기(appendSlot)·줄 갱신 SQL 이 전부 진짜다.
 * (SAVEPOINT 류만 자동 커밋 모드라 넘긴다.)
 *
 *  ① 새 줄을 붙일 수 있는 주문(외부모집 수동제출 등): 다른 상품으로 계획된 빈 줄을 **절대** 가져가지 않는다 →
 *     그 상품 빈 줄 → 상품 미지정 빈 줄 → 없으면 표 끝에 새 줄(상품 칸 = 산 상품).
 *  ② 새 줄을 못 붙이는 일반 리뷰어 주문(큐 경로): 종전대로 다른 상품 줄을 마지막 순위로 쓰되(결정 227·324·252 불변)
 *     그 줄의 상품 칸·옵션 칸·배정 표식을 산 상품으로 덮는다(R2 — 상품 계획이 상품 칸에만 있어 1종으로 보던 문제).
 *  ③ 상품을 고르지 않은 주문: 상품 미지정 빈 줄을 먼저(R1), 없으면 종전.
 *  ④ 같은 상품 줄이 있으면 두 경로 모두 종전과 같다.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const S = require('../src/services/sheetlessOrder.service');
const { kstTodayStr, addIsoDays } = require('../src/services/campaignState.service');

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const label = iso => { const [y, m, d] = iso.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return `${m} / ${d} (${DOW[w]})`; };
const T = kstTodayStr();

let pgP = null;
async function pg() {
  if (pgP) return pgP;
  pgP = (async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE order_submissions(id uuid PRIMARY KEY, source text, recipient text, orderer text, phone text, order_num text,
        mirror_status text, submitted_at timestamptz DEFAULT now(), workboard_id uuid, deleted_at timestamptz,
        campaign_application_id int, selected_product text, selected_opt_key text,
        owner_reviewer_id uuid, participant_identity_id uuid);
      CREATE TABLE campaign_applications(id int PRIMARY KEY, campaign_id text, status text, order_submission_id uuid, late_order_id uuid);
      CREATE TABLE campaign_options(campaign_id text, opt_key text, unit_kind text, status text, product_name text);
      CREATE TABLE campaign_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id text, tab_gid text, tab_name text,
        campaign_name text, seq int, row_json jsonb, option_text text, order_submission_id uuid, reviewer_name text,
        recipient_name text, phone8 text, workboard_id uuid, source text, updated_by text, updated_at timestamptz,
        deleted_at timestamptz, active boolean DEFAULT TRUE, owner_reviewer_id uuid, participant_identity_id uuid,
        UNIQUE (sheet_id, tab_name, seq));
      CREATE TABLE participant_edits(id serial PRIMARY KEY, sheet_id text, tab_name text, anchor_type text, anchor_value text,
        field text, kind text, value_text text, reverted_at timestamptz, reverted_by text, created_at timestamptz DEFAULT now());
      CREATE TABLE tab_configs(sheet_id text, tab_name text, tab_gid text, sheetless boolean DEFAULT TRUE, work_kind text);
      CREATE TABLE qna_slots(sheet_id text, tab_name text);
      CREATE TABLE recruit_campaigns(id text PRIMARY KEY, linked_sheet_id text, linked_tab_name text, linked_tab_gid text, archived_at timestamptz);
    `);
    return db;
  })();
  return pgP;
}
// 자동 커밋 클라이언트 — SAVEPOINT 류는 트랜잭션 밖이라 넘긴다(그 밖의 SQL 은 전부 진짜로 실행).
async function client() {
  const db = await pg();
  return {
    async query(sql, params) {
      if (/^\s*(SAVEPOINT|RELEASE|ROLLBACK TO)/i.test(String(sql))) return { rows: [], rowCount: 0 };
      const r = await db.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
    },
  };
}

let tabN = 0, osN = 0;
const HEAD = { 번호: '', 구매일자: '', 상품: '', 리뷰옵션: '', 옵션: '', 수취인: '', 연락처: '', 주문번호: '' };
async function tab(rows, { products = [] } = {}) {
  const db = await pg();
  const t = { sheetId: 'wt_guard', tabName: `탭${++tabN}` };
  await db.query(`INSERT INTO tab_configs(sheet_id, tab_name) VALUES ($1,$2)`, [t.sheetId, t.tabName]);
  if (products.length) {   // 이 작업에 연결된 모집공고와 그 상품(상품 고르기 선택지의 근거)
    const cid = 'camp_' + tabN;
    await db.query(`INSERT INTO recruit_campaigns(id, linked_sheet_id, linked_tab_name) VALUES ($1,$2,$3)`, [cid, t.sheetId, t.tabName]);
    for (const p of products) await db.query(`INSERT INTO campaign_options(campaign_id, opt_key, unit_kind, product_name) VALUES ($1,$2,'product',$2)`, [cid, p]);
  }
  for (const r of rows) {
    await db.query(`INSERT INTO campaign_participants(sheet_id, tab_name, seq, row_json, option_text, order_submission_id, reviewer_name)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [t.sheetId, t.tabName, r.seq, JSON.stringify({ ...HEAD, 구매일자: r.date ? label(r.date) : '', 상품: r.prod || '', 옵션: r.opt || '' }),
       r.ot || null, r.filled ? r.filled : null, r.filled ? '채움' : null]);
  }
  return t;
}
async function order({ source, product = '' }) {
  const db = await pg();
  osN++;
  const id = `00000000-0000-4000-8000-${String(osN).padStart(12, '0')}`;
  await db.query(`INSERT INTO order_submissions(id, source, recipient, orderer, phone, order_num, mirror_status, selected_product)
    VALUES ($1,$2,'김가짜','김가짜','010-1234-${String(5000 + osN)}',$3,'pending',$4)`,
    [id, source, String(202611060000 + osN), product || null]);
  return id;
}
async function write(t, osId, product) {
  const c = await client();
  const orderData = { recipient: '김가짜', orderer: '김가짜', phone: `010-1234-${String(5000 + Number(osId.slice(-4)))}`,
    orderNum: '', selectedProduct: product || '' };
  return S.writeOrderToWorktableInTx(c, { sheetId: t.sheetId, tabName: t.tabName, orderSubmissionId: osId, orderData });
}
async function rowsOf(t) {
  const db = await pg();
  return (await db.query(`SELECT seq, option_text, order_submission_id, row_json FROM campaign_participants
    WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL ORDER BY seq`, [t.sheetId, t.tabName])).rows;
}
const at = (rows, seq) => rows.find(r => Number(r.seq) === seq);

// ── ② 큐 경로(새 줄 불가) ─────────────────────────────────────────
test('큐 주문: 그 상품 줄이 없으면 다른 상품 줄을 쓰되 상품 칸·옵션 칸·배정 표식을 산 상품으로 덮는다(상품 계획이 상품 칸에만 있어도)', async () => {
  const t = await tab([{ seq: 2, date: T, prod: '고등어', opt: '고등어' }, { seq: 3, date: T, prod: '고등어' }], { products: ['고등어', '옥돔'] });
  const os = await order({ source: 'order_submit', product: '옥돔' });
  const r = await write(t, os, '옥돔');
  assert.equal(r.ok, true);
  assert.equal(r.seq, 2, '결정 227 — 큐 경로는 다른 상품 줄을 마지막 순위로 쓴다(줄을 늘리지 않는다 · 결정 324·252)');
  const row = at(await rowsOf(t), 2);
  assert.equal(row.order_submission_id, os);
  assert.equal(row.row_json.상품, '옥돔', '상품 칸 = 산 상품');
  assert.equal(row.row_json.옵션, '옥돔', '옛 상품 이름이 적힌 옵션 칸도 산 상품으로');
  assert.equal(row.option_text, '옥돔', '배정 표식 = 산 상품');
  assert.equal((await rowsOf(t)).length, 2, '큐 경로는 줄을 늘리지 않는다');
});

test('큐 주문: 상품 2종 이상 표에서도 다른 상품 줄을 쓰고 덮는다(종전 그대로)', async () => {
  const t = await tab([{ seq: 2, date: T, prod: '고등어', ot: '고등어' }, { seq: 3, date: T, prod: '은갈치', ot: '은갈치' }]);
  const os = await order({ source: 'order_submit', product: '옥돔' });
  const r = await write(t, os, '옥돔');
  assert.equal(r.ok, true);
  assert.ok([2, 3].includes(r.seq));
  const row = at(await rowsOf(t), r.seq);
  assert.equal(row.row_json.상품, '옥돔');
  assert.equal(row.option_text, '옥돔');
});

// ── ① 새 줄 가능 경로(외부모집 수동제출) ──────────────────────────
test('수동제출: 다른 상품 줄만 남았으면 그 줄을 가져가지 않고 표 끝에 새 줄(상품 = 산 상품)', async () => {
  const t = await tab([{ seq: 2, date: T, prod: '고등어' }, { seq: 3, date: T, prod: '고등어' }], { products: ['고등어', '옥돔'] });
  const os = await order({ source: 'admin_external', product: '옥돔' });
  const r = await write(t, os, '옥돔');
  assert.equal(r.ok, true);
  assert.equal(r.seq, 4, '끝에 새 줄');
  const rows = await rowsOf(t);
  assert.equal(at(rows, 2).order_submission_id, null, '고등어 빈 줄은 그대로');
  assert.equal(at(rows, 2).row_json.상품, '고등어');
  assert.equal(at(rows, 3).order_submission_id, null);
  assert.equal(at(rows, 4).order_submission_id, os);
  assert.equal(at(rows, 4).row_json.상품, '옥돔', '새 줄 상품 칸 = 산 상품');
});

test('수동제출: 상품 2종 이상 표 · 그 상품 줄 없음 → 다른 상품 줄 대신 끝에 새 줄', async () => {
  const t = await tab([{ seq: 2, date: T, prod: '고등어', ot: '고등어' }, { seq: 3, date: T, prod: '은갈치', ot: '은갈치' }]);
  const os = await order({ source: 'admin_external', product: '옥돔' });
  const r = await write(t, os, '옥돔');
  assert.equal(r.ok, true);
  assert.equal(r.seq, 4);
  const rows = await rowsOf(t);
  assert.equal(at(rows, 2).order_submission_id, null);
  assert.equal(at(rows, 3).order_submission_id, null);
  assert.equal(at(rows, 4).row_json.상품, '옥돔');
});

test('수동제출: 다른 상품 줄(오늘)보다 상품 미지정 빈 줄(앞날)을 쓴다', async () => {
  const t = await tab([{ seq: 2, date: T, prod: '고등어', ot: '고등어' }, { seq: 3, date: T, prod: '은갈치', ot: '은갈치' },
    { seq: 4, date: addIsoDays(T, 2), prod: '' }]);
  const os = await order({ source: 'admin_external', product: '옥돔' });
  const r = await write(t, os, '옥돔');
  assert.equal(r.seq, 4);
  const row = at(await rowsOf(t), 4);
  assert.equal(row.row_json.상품, '옥돔');
});

// ── ④ 같은 상품 줄이 있으면 종전 그대로 ──────────────────────────
test('같은 상품 줄이 있으면 수동제출·큐 모두 그 줄(종전과 같음)', async () => {
  for (const source of ['admin_external', 'order_submit']) {
    const t = await tab([{ seq: 2, date: T, prod: '고등어', ot: '고등어' }, { seq: 3, date: addIsoDays(T, 1), prod: '옥돔', ot: '옥돔' },
      { seq: 4, date: T, prod: '' }]);
    const os = await order({ source, product: '옥돔' });
    const r = await write(t, os, '옥돔');
    assert.equal(r.seq, 3, source);
    const rows = await rowsOf(t);
    assert.equal(at(rows, 3).row_json.상품, '옥돔');
    assert.equal(rows.length, 3, '새 줄 없음 ' + source);
  }
});

// ── ③ 상품을 고르지 않은 주문(R1) ─────────────────────────────────
test('상품 미선택 주문: 다른 상품이 미리 적힌 오늘 줄보다 상품 미지정 빈 줄(내일)을 먼저', async () => {
  const t = await tab([{ seq: 2, date: T, prod: '고등어' }, { seq: 3, date: addIsoDays(T, 1), prod: '' }]);
  const os = await order({ source: 'order_submit' });
  const r = await write(t, os, '');
  assert.equal(r.seq, 3);
});

test('상품 미선택 주문: 상품 미지정 빈 줄이 없으면 종전대로 상품이 적힌 줄', async () => {
  const t = await tab([{ seq: 2, date: T, prod: '고등어' }]);
  const os = await order({ source: 'order_submit' });
  const r = await write(t, os, '');
  assert.equal(r.seq, 2);
  assert.equal(at(await rowsOf(t), 2).row_json.상품, '고등어', '상품을 모르면 상품 칸은 건드리지 않는다');
});

// ── 상품 1개 공고(결정 252 — 표기가 달라도 같은 상품)는 종전 그대로 ──────────
test('상품 1개 공고: 작업표 표기와 산 상품 표기가 달라도 다른 상품으로 보지 않는다(덮지 않음 · 새 줄 없음)', async () => {
  for (const source of ['order_submit', 'admin_external']) {
    const t = await tab([{ seq: 2, date: T, prod: '리페어크림' }], { products: ['블랑카우 고보습 크림 200ml'] });
    const os = await order({ source, product: '블랑카우 고보습 크림 200ml' });
    const r = await write(t, os, '블랑카우 고보습 크림 200ml');
    assert.equal(r.seq, 2, source);
    const rows = await rowsOf(t);
    assert.equal(rows.length, 1, '새 줄 없음 ' + source);
    assert.equal(at(rows, 2).row_json.상품, '리페어크림', '작업표 표기 유지 ' + source);
  }
});

test('연결 공고를 모르면(공고 없음) 상품 1종 표는 종전 그대로', async () => {
  const t = await tab([{ seq: 2, date: T, prod: '고등어' }]);
  const os = await order({ source: 'order_submit', product: '옥돔' });
  const r = await write(t, os, '옥돔');
  assert.equal(r.seq, 2);
  assert.equal(at(await rowsOf(t), 2).row_json.상품, '고등어');
});

test('끄는 스위치 WORKTABLE_SLOT_PRODUCT_GUARD=0 = 종전 동작(수동제출도 다른 상품 줄을 씀 · 상품 미선택 줄 순서 종전)', async () => {
  process.env.WORKTABLE_SLOT_PRODUCT_GUARD = '0';
  try {
    const t = await tab([{ seq: 2, date: T, prod: '고등어', ot: '고등어' }, { seq: 3, date: T, prod: '은갈치', ot: '은갈치' }]);
    const os = await order({ source: 'admin_external', product: '옥돔' });
    const r = await write(t, os, '옥돔');
    assert.ok([2, 3].includes(r.seq));
    const t2 = await tab([{ seq: 2, date: T, prod: '고등어' }, { seq: 3, date: addIsoDays(T, 1), prod: '' }]);
    const r2 = await write(t2, await order({ source: 'order_submit' }), '');
    assert.equal(r2.seq, 2);
  } finally { delete process.env.WORKTABLE_SLOT_PRODUCT_GUARD; }
});
