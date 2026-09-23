/**
 * 무시트 작업표에 **「상품」 칸을 보장하고 이미 들어온 선택을 소급 기입**한다 (138).
 *
 * ★★ 왜 필요한가(2026-08-25 실사고 「업소용 간장」 · 상품 3종 · 22명 참여):
 *   복합유형 작업(137)에서 선택지가 "옵션 없는 상품"이면 제출 경로가 **옵션 칸에 쓸 값을
 *   일부러 비운다**(상품명이 관리자 작업지시 칸을 덮던 8/3 사고 재현 방지 — 그 규율은 유지).
 *   그런데 상품명을 적을 다른 칸이 없어 **리뷰어가 고른 상품이 표·원장 어디에도 안 남았다**.
 *   경고조차 안 떴다 — 고른 값이 빈 값으로 넘어와 "안 골랐다"로 보였기 때문.
 *
 * ★★ 그래서 옵션과 **다른 칸**에 적는다. 좌측 정렬(사용자 확정 2026-08-25) = 상품 > 옵션 > 리뷰옵션.
 *
 * ★★ 소급 값의 출처가 옵션 서비스와 다르다(중요):
 *   옵션은 원장(`order_submissions.selected_opt_key`)에 값이 남아 있어 거기서 읽으면 됐지만,
 *   상품은 **이 배포 이전 참여분의 원장이 통째로 비어 있다**(위 사고). 그래서
 *     ① 원장 `selected_product`(이 배포 이후 제출분) →
 *     ② **참여 기록**(`campaign_applications.option_key` → `campaign_options.product_name`)
 *   순으로 읽는다. ②가 이번 사고의 22명을 되살리는 유일한 근거다.
 *   ★ 짝짓기 키는 **주문 id**(`order_submission_id`) — 제목·탭명·줄 번호가 바뀌어도 불변
 *     (리뷰어 홈 dedup·관제 대조와 같은 규율. 위치키 금지).
 *
 * ★★★ **"상품을 고르는 작업"에만 칸을 만든다**(옵션 서비스의 `no_live_options` 와 같은 fail-closed):
 *   살아있는 공고 옵션에 `product_name` 이 하나도 없으면 상품 축이 없는 작업이다 — 칸도 만들지 않는다.
 *   기입도 **그 목록에 있는 값만**(`skippedNotAProduct` 로 건수를 말한다 — 조용히 버리지 않는다).
 *   조회 실패도 거부한다(모르는 채로 표에 값을 박지 않는다).
 *
 * ★ 기입은 **blank-only** — 관리자가 적어 둔 값을 덮지 않는다.
 * ★ 열 이름·기입 칸 판정은 **매퍼 파생 단일 출처**(`orderLedger.PRODUCT_HEADER`/`productWriteColumns`).
 *   여기서 '상품' 규칙을 다시 만들면 **만든 칸 != 쓰는 칸** 으로 갈려 빈 열만 하나 늘어난다.
 *
 * ★ 쓰기 표면 = `raw_sheet_tabs.headers/detected_headers` · `campaign_participants.row_json` ·
 *   `order_submissions.selected_product` 세 곳. 시트·정원·홀드는 무접촉(구글 API 호출 0).
 *   원장까지 채우는 이유 = 안 채우면 원장이 영구히 "안 고름"이라 말하고, 나중에 원장을 읽는
 *   기능이 같은 오해를 되풀이한다.
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { isReviewOptionHeader } = require('../utils/reviewType');
const { classifyHeaders } = require('../utils/worktableTemplate');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

class ProductColumnError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 새로 만들 「상품」 칸 이름 — 매퍼가 기입하는 그 헤더(단일 출처). */
function productHeader() {
  return require('./orderLedger.service').PRODUCT_HEADER;
}

/** 그 헤더 목록에서 **상품 기입 칸** 인덱스 — 매퍼 파생(사본 금지). */
function productColumns(headers) {
  const { productWriteColumns } = require('./orderLedger.service');
  return productWriteColumns(headers || []);
}

/**
 * 「상품」 칸을 넣을 자리 — **상품옵션 칸 바로 앞**(좌측 정렬 상품 > 옵션 > 리뷰옵션).
 * ★ 옵션 칸이 없으면 자동 열(번호·구매일자) 바로 뒤(옵션 칸 자동 추가와 같은 자리).
 */
function productInsertIndex(headers) {
  const list = headers || [];
  const { optionWriteColumns } = require('./orderLedger.service');
  const optIdx = optionWriteColumns(list).filter(i => !isReviewOptionHeader(list[i]));
  if (optIdx.length) return optIdx[0];
  const cls = classifyHeaders(list, {});
  let at = 0;
  while (at < cls.length && cls[at].tier === 'auto') at++;
  return at;
}

/** 헤더 목록에 「상품」 칸을 끼워 넣은 새 목록(순수함수). 이미 있으면 그대로 돌려준다. */
function withProductColumn(headers) {
  const list = (headers || []).map(h => String(h == null ? '' : h));
  if (productColumns(list).length) return { headers: list, added: false, index: -1 };
  const at = productInsertIndex(list);
  const next = list.slice(0, at).concat([productHeader()], list.slice(at));
  return { headers: next, added: true, index: at };
}

/** 상품명 비교 정규화 — 공백 차이·대소문자로 정상 값을 놓치지 않는다(판정은 여전히 정확일치). */
function normProduct(v) { return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase(); }

/**
 * 그 탭에 연결된 공고들의 **살아있는 상품명 목록**(status <> 'closed' · product_name 있음).
 * ★ 연결은 이름 -> gid 폴백 · 빈 gid 는 절을 켜지 않는다 · 차수 재발행이면 합집합
 *   (옵션 서비스와 **같은 규칙** — 두 칸이 서로 다른 공고를 보면 안 된다).
 */
async function liveProductNames(db, { sheetId, tabName, tabGid }) {
  const { rows } = await db.query(
    `SELECT DISTINCT o.product_name
       FROM recruit_campaigns c
       JOIN campaign_options o ON o.campaign_id = c.id
      WHERE c.linked_sheet_id = $1
        AND (c.linked_tab_name = $2 OR ($3 <> '' AND c.linked_tab_gid = $3))
        AND COALESCE(o.status, 'active') <> 'closed'
        AND COALESCE(o.product_name, '') <> ''`,
    [sheetId, tabName, String(tabGid || '')]);
  return rows.map(r => String(r.product_name || '')).filter(Boolean);
}

/** 그 헤더 구성에서 상품값이 어느 칸에 무엇으로 들어가는가 — **매퍼가 정한다**(사본 0). */
function productCellValues(headers, selectedProduct) {
  const { mapOrderToSheetRow } = require('./orderLedger.service');
  const mapped = mapOrderToSheetRow(headers || [], { selectedProduct: selectedProduct || '' });
  const out = new Map();
  productColumns(headers).forEach(i => {
    const v = mapped[i];
    if (typeof v === 'string' && v.trim()) out.set(String((headers || [])[i]), v);
  });
  return out;
}

/**
 * 무시트 작업표에 「상품」 칸을 보장하고, 이미 들어온 주문의 선택 상품을 소급 기입한다.
 *
 * @param {object} o
 * @param {string} o.sheetId - o.tabName
 * @param {boolean} [o.dryRun=true]   미리보기(쓰기 0)
 * @param {boolean} [o.backfill=true] 기존 참여 건 소급 기입
 * @param {string}  [o.by='system']
 */
async function ensureProductColumn({ sheetId, tabName, dryRun = true, backfill = true, by = 'system' } = {}) {
  if (!sheetId || !tabName) throw new ProductColumnError('bad_request', 'sheetId, tabName 필수');
  const db = getPool();

  // 게이트: 등록된 무시트 탭에서만 (fail-closed — 시트 기반 탭의 열은 시트가 정한다)
  const { rows: tc } = await db.query(
    `SELECT tab_gid, COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tc.length) throw new ProductColumnError('tab_not_registered', '등록되지 않은 탭입니다(접수 후 이용).');
  if (!tc[0].sheetless) {
    throw new ProductColumnError('not_sheetless',
      '시트 기반 탭입니다 — 열은 구글시트가 정합니다. 시트에 「상품」 칸을 추가하세요.');
  }
  const tabGid = String(tc[0].tab_gid || '');

  // 지금 열 구성 = 장부 헤더(무시트 탭은 이 값이 곧 작업표 열)
  const { rows: rt } = await db.query(
    `SELECT detected_headers, headers FROM raw_sheet_tabs
      WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1`, [sheetId, tabGid]);
  const { resolveHeaders } = require('./sheetlessLedger.service');
  const { rows: parts } = await db.query(
    `SELECT seq, row_json, order_submission_id FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
      ORDER BY seq`, [sheetId, tabName]);
  const { headers: cur } = resolveHeaders({
    storedHeaders: rt[0] && (rt[0].detected_headers || rt[0].headers),
    columns: null, rows: parts,
  });
  if (!cur.length) {
    throw new ProductColumnError('no_headers',
      '열 구성을 알 수 없습니다 — 작업표를 먼저 만들거나 [작업표 재구성]을 실행하세요.');
  }

  const { headers: next, added, index } = withProductColumn(cur);

  // 게이트: 살아있는 공고 상품이 있어야 "상품을 고르는 작업"이다(fail-closed)
  let liveNames = null;
  try { liveNames = await liveProductNames(db, { sheetId, tabName, tabGid }); }
  catch (e) {
    throw new ProductColumnError('live_products_unknown',
      '연결 공고의 상품을 확인하지 못했습니다 — 확인 전에는 표에 값을 넣지 않습니다.');
  }
  if (!liveNames.length) {
    throw new ProductColumnError('no_live_products',
      '이 작업에 연결된 공고에 상품 구분이 없습니다 — 리뷰어가 상품을 고르지 않는 작업이라 「상품」 칸을 만들지 않습니다.');
  }
  const liveSet = new Set(liveNames.map(normProduct));

  // ── 소급 재료: 원장(신규 제출분) -> 참여 기록(이 배포 이전 참여분) ──
  const ids = [...new Set(parts.map(p => p.order_submission_id).filter(Boolean).map(String))];
  const prodByOrder = new Map();
  if (ids.length) {
    const { rows: ords } = await db.query(
      `SELECT id, selected_product FROM order_submissions
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
          AND COALESCE(selected_product, '') <> ''`, [ids]);
    ords.forEach(o => prodByOrder.set(String(o.id), String(o.selected_product)));
    /* ★ 원장이 비어 있는 건 = 이 배포 이전 참여분. 참여 기록에서 되살린다(이번 사고의 22명). */
    const { rows: apps } = await db.query(
      `SELECT ca.order_submission_id AS oid, co.product_name AS product_name
         FROM campaign_applications ca
         JOIN campaign_options co
           ON co.campaign_id = ca.campaign_id AND co.opt_key = ca.option_key
        WHERE ca.order_submission_id = ANY($1::uuid[])
          AND COALESCE(co.product_name, '') <> ''`, [ids]);
    apps.forEach(a => {
      const k = String(a.oid);
      if (!prodByOrder.has(k)) prodByOrder.set(k, String(a.product_name));
    });
  }

  const plan = [];
  const ledgerFill = [];        // 원장이 비어 있던 건 = 참여 기록에서 되살린 값
  let noOrder = 0, alreadyFilled = 0, notProduct = 0;
  if (backfill) {
    for (const p of parts) {
      const name = p.order_submission_id ? prodByOrder.get(String(p.order_submission_id)) : null;
      if (!name) { noOrder++; continue; }
      if (!liveSet.has(normProduct(name))) { notProduct++; continue; }
      const rj = (p.row_json && typeof p.row_json === 'object') ? p.row_json : {};
      const patch = {};
      for (const [h, v] of productCellValues(next, name)) {
        const now = String(rj[h] == null ? '' : rj[h]).trim();
        if (now) continue;                      // blank-only — 적어 둔 값을 덮지 않는다
        patch[h] = v;
      }
      if (Object.keys(patch).length) plan.push({ seq: p.seq, product: name, patch });
      else alreadyFilled++;
      ledgerFill.push({ id: String(p.order_submission_id), product: name });
    }
  }

  const summary = {
    ok: true, sheetId, tabName, tabGid,
    headerName: productHeader(),
    headerAdded: added, insertIndex: added ? index : -1,
    alreadyHadColumn: !added,
    headers: next,
    liveProductNames: liveNames,
    backfillCount: plan.length,
    skippedNoOrderProduct: noOrder,
    skippedAlreadyFilled: alreadyFilled,
    skippedNotAProduct: notProduct,
    rows: plan.slice(0, 50).map(p => ({ seq: p.seq, product: p.product })),
    rowsTruncated: Math.max(0, plan.length - 50),
  };
  if (dryRun) return { ...summary, dryRun: true };
  if (!added && !plan.length) return { ...summary, dryRun: false, noop: true };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 장부 재생성과 **같은 락** — 재생성 도중 헤더가 바뀌면 표가 한 칸씩 밀린다.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sheetless_ledger:${sheetId}:${tabName}`]);
    if (added) {
      const { rowCount } = await client.query(
        `UPDATE raw_sheet_tabs
            SET headers = $3::jsonb, detected_headers = $3::jsonb, col_count = $4
          WHERE sheet_id = $1 AND tab_gid = $2`,
        [sheetId, tabGid, JSON.stringify(next), next.length]);
      if (!rowCount) logger.warn(`[productColumn] raw_sheet_tabs 행 없음 — 재생성이 헤더를 만든다 ${sheetId}/${tabName}`);
    }
    for (const p of plan) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL`,
        [sheetId, tabName, p.seq, JSON.stringify(p.patch)]);
    }
    /* ★ 원장도 채운다 — blank-only. 안 채우면 원장이 영구히 "안 고름"이라 말하고,
       무시트 재기록이 돌 때 같은 값을 다시 쓰지 못한다. */
    for (const f of ledgerFill) {
      await client.query(
        `UPDATE order_submissions SET selected_product = $2
          WHERE id = $1::uuid AND COALESCE(selected_product, '') = ''`,
        [f.id, f.product]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }

  let rebuilt = null, rebuildError = null;
  try {
    const { rebuildLedgers } = require('./sheetlessLedger.service');
    rebuilt = await rebuildLedgers({ sheetId, tabName, columns: next, dryRun: false, by: `productcol:${by}` });
  } catch (e) {
    rebuildError = (e && e.message) || String(e);
    logger.warn(`[productColumn] 장부 재생성 실패 ${sheetId}/${tabName}: ${rebuildError}`);
  }

  logger.info(`[productColumn] ${sheetId}/${tabName} 열추가=${added} 소급=${plan.length} by=${by}`);
  return { ...summary, dryRun: false, rebuilt, rebuildError };
}

module.exports = {
  ensureProductColumn,
  liveProductNames,
  normProduct,
  productColumns,
  withProductColumn,
  productInsertIndex,
  productCellValues,
  productHeader,
  ProductColumnError,
  __setPoolForTest,
};
