'use strict';
/**
 * 리뷰비 입금 자동화 M1 — 입금대상 추출 · 은행별 분류 · 회차(다운로드) 기록
 *
 * 설계 문서: frontend/docs/prd-payment-transfer.html (v1.4)
 *
 * ★★ 이 서비스의 쓰기 표면은 payment_batches / payment_batch_items **두 테이블뿐**이다.
 *    review_index·order_submissions·recruit_campaigns·시트는 **읽기만** 한다.
 *    (시트 입금칸 기록은 M2 이며 이 파일에 없다 — 라이브 경로 무접촉)
 *
 * ★★ 확정 규칙(완화 금지)
 *   ① 이체 단위 = **건별(A안)**. 시트 행 1개 = 이체 1줄. 합산하지 않는다.
 *   ② 대상 = 리뷰 제출완료 ∧ 미입금 ∧ **다운로드 이력 없음**.
 *      "다운로드 이력 있으면 무조건 제외"가 이중입금 방지의 핵심이고,
 *      DB 부분유니크(uq_payment_items_active)가 코드 실수까지 막는 최종 방어선이다.
 *   ③ 금액·통장표시·계좌는 **회차 생성 시점 값을 박제**한다(스냅샷). 나중에 규칙이
 *      바뀌어도 과거 표기가 흔들리지 않는다(기간별 리뷰비 사고와 같은 함정).
 *   ④ 판정 실패는 **추측하지 않는다** — 은행 미지정·계좌미비로 분류해 화면에 드러낸다
 *      (조용한 누락 금지).
 */

const pool = require('../db/pool');           // ★ 이 모듈은 pool 을 직접 export 한다(구조분해 금지)
const { logger } = require('../utils/logger'); // ★ 반대로 logger 는 { logger } 구조분해다
const { PAYMENT_COL_KEYWORDS } = require('./search.service');
const { resolveReviewFee, sheetDateToIso, toKstDate } = require('../utils/campaignFee');
const { resolveBank, bankNameByCode, normalizeAccount, normalizeMemo } = require('../utils/bankCodes');

const BANK_LABEL = { kbank: '케이뱅크', hana: '하나은행' };

/** 작업오더 물건비 수취방식 → 이체 은행 (사용자 확정 규칙)
 *  현금이체 → 하나은행 / 수수료(세금계산서) → 케이뱅크 */
function bankFromGoodsCostType(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/현금/.test(s)) return 'hana';
  if (/계산서|세금|수수료/.test(s)) return 'kbank';
  return null;
}

function _int(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/* ══════════════════════════════════════════════════════════
   1) 입금대상 추출
   ══════════════════════════════════════════════════════════ */

/**
 * 오늘 입금해야 할 건 목록.
 * @param {object} opts { sheetId?, tabName? } 특정 탭만 보고 싶을 때(선택)
 * @returns {{items:Array, summary:object}}
 */
async function listPaymentTargets(opts = {}) {
  const payPatterns = PAYMENT_COL_KEYWORDS.map(k => '%' + k + '%');
  const params = [payPatterns];
  const where = [
    'ri.is_submitted = TRUE',
    'ri.row_index IS NOT NULL',
    "COALESCE(ri.phone8,'') <> ''",
    // 미입금 — search.service._isPaid 와 동일 규칙(SQL 판)
    `NOT (ri.is_submitted2 = 'PAID' OR EXISTS (
        SELECT 1 FROM jsonb_each_text(COALESCE(ri.row_json, '{}'::jsonb)) kv
         WHERE kv.key ILIKE ANY($1) AND btrim(kv.value) <> ''))`,
    // ★ 다운로드 이력 잠금 — 살아있는 회차 항목이 있으면 제외
    `NOT EXISTS (
        SELECT 1 FROM payment_batch_items pi
         WHERE pi.sheet_id = ri.sheet_id AND pi.tab_name = ri.tab_name
           AND pi.row_index = ri.row_index AND pi.status IN ('pending','paid'))`,
  ];
  if (opts.sheetId) { params.push(opts.sheetId); where.push(`ri.sheet_id = $${params.length}`); }
  if (opts.tabName) { params.push(opts.tabName); where.push(`ri.tab_name = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT ri.sheet_id AS "sheetId", ri.tab_name AS "tabName", ri.row_index AS "rowIndex",
            ri.reviewer_name AS "reviewerName", ri.phone8 AS "phone8",
            ri.start_date AS "startDate", ri.product_name AS "productName"
       FROM review_index ri
      WHERE ${where.join(' AND ')}
      ORDER BY ri.sheet_id, ri.tab_name, ri.row_index
      LIMIT 2000`,
    params
  );
  if (!rows.length) return { items: [], summary: _summarize([]) };

  const sheetIds = [...new Set(rows.map(r => r.sheetId))];
  const tabNames = [...new Set(rows.map(r => r.tabName))];
  const phone8s = [...new Set(rows.map(r => r.phone8).filter(Boolean))];

  const [campMap, orderMap, acctMap, tabMap] = await Promise.all([
    _loadCampaigns(sheetIds, tabNames),
    _loadOrderPrices(sheetIds, tabNames),
    _loadAccounts(phone8s),
    _loadTabLabels(sheetIds, tabNames),
  ]);

  const items = rows.map(r => {
    const key = r.sheetId + '||' + r.tabName;
    const camp = campMap[key] || null;
    const ord = orderMap[key + '||' + r.rowIndex] || null;
    const acct = acctMap[r.phone8] || null;

    // 상품비 = 그 행의 실제 제출 결제금액(주문 원장). 매칭 실패 시 0 + 사유.
    const productPrice = ord ? _int(ord.price) : 0;

    // 리뷰비 = 082 단일 출처(스냅샷 → 주문일 → 시트 구매일자 → 오늘 → 폴백)
    const fee = camp
      ? resolveReviewFee({
          snapshot: ord ? ord.feeSnapshot : null,
          schedules: camp.schedules,
          orderDate: ord ? ord.orderDate : null,
          sheetDate: sheetDateToIso(r.startDate, camp.campStartDate),
          fallback: camp.reviewFee,
        }).fee
      : 0;

    // 은행: 공고에 지정된 값이 항상 우선 → 없으면 작업오더 물건비에서 파생
    const bank = (camp && camp.transferBank) || (camp && bankFromGoodsCostType(camp.goodsCostType)) || null;
    const bankAuto = !(camp && camp.transferBank);

    const resolved = acct ? resolveBank(acct.bankName) : null;
    const account = acct ? normalizeAccount(acct.bankAccount) : '';
    const memo = normalizeMemo((camp && camp.transferMemo) || '');
    const amount = productPrice + fee;

    const issues = [];      // 있으면 다운로드에서 제외(막는 사유)
    const warnings = [];    // 진행은 되지만 사람이 알아야 하는 것
    if (!bank) issues.push('no_bank');
    if (!acct) issues.push('no_reviewer');
    else {
      if (!resolved) issues.push('bank_unknown');
      if (!account) issues.push('no_account');
      if (!String(acct.accountHolder || '').trim()) issues.push('no_holder');
    }
    if (!productPrice) issues.push('no_price');
    if (amount <= 0) issues.push('zero_amount');
    // 통장표시가 없어도 이체 자체는 되지만(양식상 필수 아님) 리뷰어가 무슨 돈인지 모른다 → 경고만.
    if (!memo) warnings.push('no_memo');
    if (!fee) warnings.push('no_review_fee');

    return {
      sheetId: r.sheetId, tabName: r.tabName, rowIndex: r.rowIndex,
      tabLabel: tabMap[key] || r.tabName,
      reviewerName: r.reviewerName || '', phone8: r.phone8 || '',
      startDate: r.startDate || '', productName: r.productName || '',
      campaignId: camp ? camp.id : null,
      campaignTitle: camp ? camp.title : '',
      bank, bankAuto, bankLabel: bank ? BANK_LABEL[bank] : '',
      bankName: acct ? (acct.bankName || '') : '',
      bankCode: resolved ? resolved.code : '',
      bankOfficial: resolved ? resolved.name : '',
      bankAccount: account,
      accountHolder: acct ? (acct.accountHolder || '') : '',
      isSub: acct ? !!acct.isSub : false,
      productPrice, reviewFee: fee, amount,
      transferMemo: memo,
      issues, warnings,
      payable: issues.length === 0,
    };
  });

  return { items, summary: _summarize(items) };
}

function _summarize(items) {
  const s = {
    total: items.length, totalAmount: 0,
    kbank: 0, kbankAmount: 0, hana: 0, hanaAmount: 0,
    noBank: 0, noAccount: 0, blocked: 0, noMemo: 0,
  };
  for (const it of items) {
    if (it.payable) {
      s.totalAmount += it.amount;
      if ((it.warnings || []).includes('no_memo')) s.noMemo++;
      if (it.bank === 'kbank') { s.kbank++; s.kbankAmount += it.amount; }
      else if (it.bank === 'hana') { s.hana++; s.hanaAmount += it.amount; }
    } else {
      s.blocked++;
      if (it.issues.includes('no_bank')) s.noBank++;
      if (it.issues.some(k => ['no_reviewer', 'bank_unknown', 'no_account', 'no_holder'].includes(k))) s.noAccount++;
    }
  }
  return s;
}

/** 탭별 연결 공고(이체설정·리뷰비·구간) + 작업오더 물건비 수취방식 */
async function _loadCampaigns(sheetIds, tabNames) {
  const map = {};
  if (!sheetIds.length) return map;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.linked_sheet_id, c.linked_tab_name)
            c.id, c.title, c.linked_sheet_id AS "sheetId", c.linked_tab_name AS "tabName",
            COALESCE(c.review_fee, 0) AS "reviewFee",
            c.transfer_bank AS "transferBank", c.transfer_memo AS "transferMemo",
            to_char(c.start_date,'YYYY-MM-DD') AS "campStartDate",
            wo.goods_cost_type AS "goodsCostType"
       FROM recruit_campaigns c
       LEFT JOIN LATERAL (
            SELECT w.goods_cost_type FROM work_orders w
             WHERE w.deleted_at IS NULL
               AND w.linked_tab_sheet_id = c.linked_sheet_id
               AND w.linked_tab_name = c.linked_tab_name
             ORDER BY w.created_at DESC LIMIT 1) wo ON TRUE
      WHERE c.linked_sheet_id = ANY($1) AND c.linked_tab_name = ANY($2)
      ORDER BY c.linked_sheet_id, c.linked_tab_name, c.created_at DESC`,
    [sheetIds, tabNames]
  );
  for (const c of rows) {
    map[c.sheetId + '||' + c.tabName] = {
      id: c.id, title: c.title || '', reviewFee: c.reviewFee || 0,
      transferBank: c.transferBank || null, transferMemo: c.transferMemo || '',
      campStartDate: c.campStartDate || null, goodsCostType: c.goodsCostType || '',
      schedules: [],
    };
  }
  // 기간별 리뷰비 구간(082) — 실패해도 기존 review_fee 로 계산된다(fail-soft)
  try {
    const ids = rows.map(r => r.id).filter(Boolean);
    if (ids.length) {
      const { rows: fs } = await pool.query(
        `SELECT campaign_id AS "campaignId", to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom",
                review_fee AS "reviewFee"
           FROM campaign_fee_schedules WHERE campaign_id = ANY($1) ORDER BY campaign_id, effective_from`,
        [ids]);
      const by = new Map();
      for (const f of fs) {
        if (!by.has(f.campaignId)) by.set(f.campaignId, []);
        by.get(f.campaignId).push({ effectiveFrom: f.effectiveFrom, reviewFee: f.reviewFee });
      }
      for (const k of Object.keys(map)) map[k].schedules = by.get(map[k].id) || [];
    }
  } catch (e) { logger.warn('[payment] 리뷰비 구간 조회 실패(기존 값 사용): ' + e.message); }
  return map;
}

/** 행별 실제 결제금액(상품비) + 리뷰비 스냅샷 근거 — 주문 원장 */
async function _loadOrderPrices(sheetIds, tabNames) {
  const map = {};
  if (!sheetIds.length) return map;
  const { rows } = await pool.query(
    // ★ order_submissions 의 제출 시각 컬럼은 **submitted_at** 이다(created_at 이 아니다 — 001:179).
    //   틀리면 42703 으로 이 쿼리가 통째로 죽어 입금대상 화면이 서버오류가 된다.
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName", sheet_row AS "sheetRow",
            price, review_fee_snapshot AS "feeSnapshot", submitted_at AS "orderedAt"
       FROM order_submissions
      WHERE deleted_at IS NULL AND sheet_row IS NOT NULL
        AND sheet_id = ANY($1) AND tab_name = ANY($2)`,
    [sheetIds, tabNames]
  );
  for (const o of rows) {
    map[o.sheetId + '||' + o.tabName + '||' + o.sheetRow] = {
      price: o.price, feeSnapshot: o.feeSnapshot, orderDate: toKstDate(o.orderedAt),
    };
  }
  return map;
}

/**
 * phone8 → 계좌 정보.
 * ① 본계정(reviewers) ② 타계정(sub_accounts) — 타계정 전용계좌가 없으면 소유자 공통계좌.
 * ★ 본계정을 먼저 넣고 타계정으로 덮지 않는다(같은 번호가 양쪽에 있으면 본인이 우선).
 */
async function _loadAccounts(phone8s) {
  const map = {};
  if (!phone8s.length) return map;
  const { rows: subs } = await pool.query(
    `SELECT RIGHT(regexp_replace(COALESCE(s->>'phone',''), '[^0-9]', '', 'g'), 8) AS "phone8",
            COALESCE(NULLIF(btrim(s->>'name'),''), '')                       AS "name",
            COALESCE(NULLIF(btrim(s->>'bankName'),''),   r.bank_name)        AS "bankName",
            COALESCE(NULLIF(btrim(s->>'bankAccount'),''), r.bank_account)    AS "bankAccount",
            COALESCE(NULLIF(btrim(s->>'accountHolder'),''), r.account_holder) AS "accountHolder"
       FROM reviewers r, jsonb_array_elements(
              CASE WHEN jsonb_typeof(r.sub_accounts) = 'array' THEN r.sub_accounts ELSE '[]'::jsonb END) s
      WHERE RIGHT(regexp_replace(COALESCE(s->>'phone',''), '[^0-9]', '', 'g'), 8) = ANY($1)`,
    [phone8s]
  );
  for (const s of subs) {
    if (s.phone8 && !map[s.phone8]) {
      map[s.phone8] = { bankName: s.bankName || '', bankAccount: s.bankAccount || '', accountHolder: s.accountHolder || '', isSub: true };
    }
  }
  const { rows: own } = await pool.query(
    `SELECT phone8, bank_name AS "bankName", bank_account AS "bankAccount", account_holder AS "accountHolder"
       FROM reviewers WHERE phone8 = ANY($1)`,
    [phone8s]
  );
  for (const r of own) {
    map[r.phone8] = { bankName: r.bankName || '', bankAccount: r.bankAccount || '', accountHolder: r.accountHolder || '', isSub: false };
  }
  return map;
}

/** 탭 표시명(리뷰어에게 노출하는 이름 규칙과 동일 — 시트제목은 쓰지 않는다) */
async function _loadTabLabels(sheetIds, tabNames) {
  const map = {};
  try {
    const { rows } = await pool.query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName",
              COALESCE(NULLIF(btrim(display_name),''), tab_name) AS "label"
         FROM tab_configs WHERE sheet_id = ANY($1) AND tab_name = ANY($2)`,
      [sheetIds, tabNames]);
    for (const t of rows) map[t.sheetId + '||' + t.tabName] = t.label;
  } catch (e) { logger.warn('[payment] 탭 표시명 조회 실패(탭명 사용): ' + e.message); }
  return map;
}

/* ══════════════════════════════════════════════════════════
   2) 회차 생성 (= 다운로드 · 잠금)
   ══════════════════════════════════════════════════════════ */

/**
 * 선택한 건들을 한 회차로 묶어 잠근다.
 * @param {object} p { bank, rows:[{sheetId,tabName,rowIndex}], by }
 * @returns {{ok:boolean, batch?:object, items?:Array, error?:string, skipped?:Array}}
 *
 * ★ 단일 트랜잭션. 부분유니크(uq_payment_items_active) 위반(23505)은
 *   "그 사이 다른 담당자가 먼저 담았다"는 뜻이라 **그 건만 건너뛰고** 나머지는 진행한다
 *   (전체 실패로 만들면 매번 처음부터 다시 골라야 한다).
 */
async function createBatch({ bank, rows, by }) {
  if (!BANK_LABEL[bank]) return { ok: false, error: '이체 은행이 올바르지 않습니다.' };
  const want = Array.isArray(rows) ? rows : [];
  if (!want.length) return { ok: false, error: '선택된 건이 없습니다.' };

  // 화면 값은 신뢰하지 않는다 — 대상 목록을 서버에서 다시 계산해 교집합만 담는다.
  const { items: fresh } = await listPaymentTargets();
  const freshMap = new Map(fresh.map(it => [it.sheetId + '||' + it.tabName + '||' + it.rowIndex, it]));

  const picked = [];
  const skipped = [];
  for (const w of want) {
    const k = String(w.sheetId) + '||' + String(w.tabName) + '||' + String(w.rowIndex);
    const it = freshMap.get(k);
    if (!it) { skipped.push({ key: k, reason: 'not_target' }); continue; }
    if (!it.payable) { skipped.push({ key: k, reason: it.issues[0] || 'blocked' }); continue; }
    if (it.bank !== bank) { skipped.push({ key: k, reason: 'other_bank' }); continue; }
    picked.push(it);
  }
  if (!picked.length) return { ok: false, error: '담을 수 있는 건이 없습니다.', skipped };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [batch] } = await client.query(
      `INSERT INTO payment_batches (bank, created_by) VALUES ($1, $2) RETURNING *`, [bank, by || '']);

    const saved = [];
    for (const it of picked) {
      // 건별 SAVEPOINT — 23505(다른 담당자가 먼저 담음)는 그 건만 건너뛴다.
      await client.query('SAVEPOINT sp_item');
      try {
        const { rows: [row] } = await client.query(
          `INSERT INTO payment_batch_items
             (batch_id, sheet_id, tab_name, row_index, campaign_id, reviewer_name, phone8,
              bank_name, bank_code, bank_account, account_holder,
              product_price, review_fee, amount, transfer_memo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [batch.id, it.sheetId, it.tabName, it.rowIndex, it.campaignId, it.reviewerName, it.phone8,
           it.bankName, it.bankCode, it.bankAccount, it.accountHolder,
           it.productPrice, it.reviewFee, it.amount, it.transferMemo]);
        await client.query('RELEASE SAVEPOINT sp_item');
        saved.push({ ...it, id: row.id });
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_item');
        if (e && e.code === '23505') skipped.push({ key: it.sheetId + '||' + it.tabName + '||' + it.rowIndex, reason: 'already_locked' });
        else throw e;
      }
    }
    if (!saved.length) {
      await client.query('ROLLBACK');
      return { ok: false, error: '담을 수 있는 건이 없습니다(이미 다른 회차에 포함).', skipped };
    }
    const total = saved.reduce((a, b) => a + b.amount, 0);
    const { rows: [updated] } = await client.query(
      `UPDATE payment_batches SET item_count = $2, total_amount = $3 WHERE id = $1 RETURNING *`,
      [batch.id, saved.length, total]);
    await client.query('COMMIT');
    return { ok: true, batch: _batchView(updated), items: saved, skipped };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/** 회차 취소 — 잠금 해제(항목 cancelled). 이미 반영된 회차는 취소 불가. */
async function cancelBatch(batchId, by) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [b] } = await client.query(
      `SELECT * FROM payment_batches WHERE id = $1 FOR UPDATE`, [batchId]);
    if (!b) { await client.query('ROLLBACK'); return { ok: false, error: '회차를 찾을 수 없습니다.' }; }
    if (b.status === 'cancelled') { await client.query('ROLLBACK'); return { ok: false, error: '이미 취소된 회차입니다.' }; }
    if (b.status === 'applied') { await client.query('ROLLBACK'); return { ok: false, error: '이미 이체결과가 반영된 회차는 취소할 수 없습니다.' }; }
    // 입금 기록된 항목이 하나라도 있으면 취소 금지(M2 대비 안전장치)
    const { rows: [{ n }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM payment_batch_items WHERE batch_id = $1 AND status = 'paid'`, [batchId]);
    if (n > 0) { await client.query('ROLLBACK'); return { ok: false, error: '입금 완료된 건이 포함되어 취소할 수 없습니다.' }; }

    await client.query(
      `UPDATE payment_batch_items SET status = 'cancelled' WHERE batch_id = $1 AND status = 'pending'`, [batchId]);
    const { rows: [updated] } = await client.query(
      `UPDATE payment_batches SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2
        WHERE id = $1 RETURNING *`, [batchId, by || '']);
    await client.query('COMMIT');
    return { ok: true, batch: _batchView(updated) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/** 회차 목록 */
async function listBatches(limit = 50) {
  const { rows } = await pool.query(
    `SELECT b.*,
            (SELECT COUNT(*)::int FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'paid')   AS paid_count,
            (SELECT COUNT(*)::int FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'failed') AS failed_count
       FROM payment_batches b ORDER BY b.created_at DESC LIMIT $1`, [Math.min(200, Math.max(1, limit))]);
  return rows.map(_batchView);
}

/** 회차 상세(항목 포함) */
async function getBatch(batchId) {
  const { rows: [b] } = await pool.query(`SELECT * FROM payment_batches WHERE id = $1`, [batchId]);
  if (!b) return null;
  const { rows: items } = await pool.query(
    `SELECT * FROM payment_batch_items WHERE batch_id = $1 ORDER BY created_at, id`, [batchId]);
  return { batch: _batchView(b), items };
}

/** 재다운로드 이력 기록(사용자 확정: 재다운로드도 이력에 남는다) */
async function markDownloaded(batchId, by) {
  await pool.query(
    `UPDATE payment_batches
        SET download_count = download_count + 1, last_downloaded_at = NOW(), last_downloaded_by = $2
      WHERE id = $1`, [batchId, by || '']);
}

function _batchView(b) {
  return {
    id: b.id, seq: Number(b.seq), bank: b.bank, bankLabel: BANK_LABEL[b.bank] || b.bank,
    status: b.status, itemCount: b.item_count, totalAmount: Number(b.total_amount || 0),
    createdBy: b.created_by || '', createdAt: b.created_at,
    downloadCount: b.download_count, lastDownloadedAt: b.last_downloaded_at,
    lastDownloadedBy: b.last_downloaded_by || '',
    cancelledAt: b.cancelled_at, cancelledBy: b.cancelled_by || '',
    paidCount: b.paid_count == null ? undefined : b.paid_count,
    failedCount: b.failed_count == null ? undefined : b.failed_count,
  };
}

/* ══════════════════════════════════════════════════════════
   3) 은행 서식 엑셀 생성
   ══════════════════════════════════════════════════════════ */

/**
 * 은행별 다건이체 등록 서식(.xlsx).
 * ★ 헤더·열 순서는 각 은행 **공식 양식 그대로**다(케이뱅크는 공유받은 원본 양식 기준).
 *   임의로 바꾸면 은행 사이트가 파일을 거부한다.
 */
async function buildWorkbook(bank, items) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'review-web-system';

  if (bank === 'kbank') {
    const ws = wb.addWorksheet('대량이체등록정보');
    ws.addRow(['* 입금은행(코드/은행명/증권사명)', '* 입금계좌', '* 이체금액(원)', '받는분 통장표시 ', '예금주']);
    for (const it of items) {
      // ★ 리뷰어가 적은 원문('신한')이 아니라 **표준코드에서 파생한 정식명**('신한은행')을 쓴다.
      //   양식 가이드가 "형식에 맞는 은행/증권사명 혹은 코드만" 허용하므로 원문은 거부될 수 있다.
      const code = String(it.bank_code || it.bankCode || '');
      ws.addRow([
        bankNameByCode(code) || code,
        String(it.bank_account || it.bankAccount || ''),
        _int(it.amount),
        it.transfer_memo || it.transferMemo || '',
        it.account_holder || it.accountHolder || '',
      ]);
    }
    ws.columns = [{ width: 28 }, { width: 20 }, { width: 14 }, { width: 18 }, { width: 14 }];
  } else {
    const ws = wb.addWorksheet('다건이체');
    ws.addRow(['입금은행코드', '입금계좌번호', '이체금액', '예상예금주', '보내는분 통장표시내용', '받는분 통장표시내용', 'CMS/모집인코드']);
    for (const it of items) {
      ws.addRow([
        String(it.bank_code || it.bankCode || ''),     // ★ 문자열 — '045'의 앞 0이 사라지면 안 됨
        String(it.bank_account || it.bankAccount || ''),
        _int(it.amount),
        it.account_holder || it.accountHolder || '',
        '',
        it.transfer_memo || it.transferMemo || '',
        '',
      ]);
    }
    ws.columns = [{ width: 14 }, { width: 22 }, { width: 14 }, { width: 14 }, { width: 20 }, { width: 20 }, { width: 16 }];
  }
  // 계좌·코드가 숫자로 해석돼 앞 0이 날아가거나 지수표기 되는 것 방지
  wb.worksheets[0].eachRow((row, i) => {
    if (i === 1) return;
    row.eachCell(cell => { if (typeof cell.value === 'string') cell.numFmt = '@'; });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 다운로드 파일명 — 예) 케이뱅크_다건이체_20260804_124.xlsx */
function batchFileName(batch) {
  const d = new Date(batch.createdAt || Date.now());
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const ymd = kst.toISOString().slice(0, 10).replace(/-/g, '');
  return `${BANK_LABEL[batch.bank] || batch.bank}_다건이체_${ymd}_${batch.seq}.xlsx`;
}

module.exports = {
  BANK_LABEL, bankFromGoodsCostType,
  listPaymentTargets, createBatch, cancelBatch, listBatches, getBatch, markDownloaded,
  buildWorkbook, batchFileName,
};
