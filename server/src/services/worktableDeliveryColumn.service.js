/**
 * 무시트 작업표의 **배송유형 부속 열 보장**(migration 135 · 사용자 확정 2026-08-24).
 *
 * 배경: 작업표 열 구성은 **접수 시점의 작업오더**만 보고 정해진다(`worktablePlan.buildColumns`).
 *   그래서 "오더엔 배송 조합이 없었는데 모집공고에서 혼합·회수로 정한" 작업은 `배송구분`·
 *   회수 칸 없이 만들어지고, 그 값이 표에 갈 곳을 잃는다 — 옵션 칸(worktableOptionColumn)이
 *   막으려던 것과 **같은 계열의 조용한 소실**이다.
 *
 * ★★ 판정 사본 0 — 열 이름·자리·배분은 전부 `utils/worktablePlan` 의 것을 그대로 쓴다
 *   (`DELIVERY_KIND_HEADER`·`RECALL_HEADERS`·`distributeDeliveryTypes`). 여기서 규칙을
 *   다시 만들면 "접수가 만든 표"와 "공고가 보장한 표"가 갈린다.
 * ★★ 쓰기 표면 = `raw_sheet_tabs.headers/detected_headers` + `campaign_participants.row_json`
 *   두 곳뿐(옵션 칸과 같다). 주문 원장·정원·홀드·구글시트 무접촉.
 * ★★ 기입은 blank-only — 담당자가 적어 둔 값을 덮지 않는다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const {
  DELIVERY_KIND_HEADER, RECALL_HEADERS, distributeDeliveryTypes,
} = require('../utils/worktablePlan');
// ★ 열 분류(자리 판정)는 매퍼 파생 단일 출처 — worktablePlan 도 이 함수를 쓴다.
const { classifyHeaders } = require('../utils/worktableTemplate');
const { normalizeDeliveryTypeMix } = require('../utils/deliveryTypeMix');
const { deliveryBaseType } = require('../utils/deliveryType');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

class DeliveryColumnError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const _str = (v) => String(v == null ? '' : v).trim();

/** 배송구분 칸의 자리 = 자동 열 뒤(접수 경로와 **같은 규칙**). */
function withDeliveryKindColumn(headers) {
  if (headers.includes(DELIVERY_KIND_HEADER)) return { headers: headers.slice(), added: false, index: -1 };
  const next = headers.slice();
  // `worktablePlan` 은 tier === 'auto' 인 열 뒤에 넣는다 — 여기서는 헤더 이름만 있으므로
  // 같은 분류기로 tier 를 되읽어 같은 자리를 찾는다(사본 금지).
  const tiers = classifyHeaders(next, {});
  let at = 0;
  while (at < next.length && tiers[at] && tiers[at].tier === 'auto') at++;
  next.splice(at, 0, DELIVERY_KIND_HEADER);
  return { headers: next, added: true, index: at };
}

/** 회수 칸은 맨 뒤(접수 경로와 같은 규칙). */
function withRecallColumns(headers) {
  const next = headers.slice();
  const added = [];
  RECALL_HEADERS.forEach((h) => {
    if (next.includes(h)) return;
    next.push(h);
    added.push(h);
  });
  return { headers: next, added };
}

/**
 * @param {object} p
 * @param {string} p.deliveryBase 기본형('혼합'|'회수'|…) — 호출부가 판정해 넘긴다.
 * @param {*}      p.mix          혼합 조합(정규화 전 원본도 허용)
 * @param {object} p.recall       { courier, product }
 */
async function ensureDeliveryColumns({
  sheetId, tabName, deliveryBase, mix, recall,
  dryRun = true, backfill = true, by = 'system',
} = {}) {
  if (!sheetId || !tabName) throw new DeliveryColumnError('bad_request', 'sheetId, tabName 필수');
  const base = _str(deliveryBase) || deliveryBaseType(deliveryBase);
  if (base !== '혼합' && base !== '회수') {
    throw new DeliveryColumnError('not_applicable', '회수·혼합 배송이 아닙니다 — 부속 열을 만들지 않습니다.');
  }

  const mixState = normalizeDeliveryTypeMix(mix);
  const liveMix = base === '혼합' ? (mixState.mix || []).filter(m => m.quantity > 0) : [];
  if (base === '혼합' && liveMix.length < 2) {
    throw new DeliveryColumnError('no_delivery_mix',
      '혼합 배송의 유형별 건수가 없습니다 — 두 유형의 건수를 먼저 입력하세요.');
  }
  const courier = _str(recall && recall.courier);
  const product = _str(recall && recall.product);
  if (base === '회수' && !courier && !product) {
    throw new DeliveryColumnError('no_recall_info',
      '회수택배사·회수상품명칭이 비어 있습니다 — 값이 없으면 칸을 만들지 않습니다.');
  }

  const db = getPool();

  // ── 게이트: 등록된 무시트 탭에서만 (fail-closed · 옵션 칸과 같은 규율) ──
  const { rows: tc } = await db.query(
    `SELECT tab_gid, COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tc.length) throw new DeliveryColumnError('tab_not_registered', '등록되지 않은 탭입니다(접수 후 이용).');
  if (!tc[0].sheetless) {
    throw new DeliveryColumnError('not_sheetless',
      '시트 기반 탭입니다 — 열은 구글시트가 정합니다. 시트에 칸을 추가하세요.');
  }
  const tabGid = String(tc[0].tab_gid || '');

  const { rows: rt } = await db.query(
    `SELECT detected_headers, headers FROM raw_sheet_tabs
      WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1`, [sheetId, tabGid]);
  const { resolveHeaders } = require('./sheetlessLedger.service');
  const { rows: parts } = await db.query(
    `SELECT seq, row_json FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
      ORDER BY seq`, [sheetId, tabName]);
  const { headers: cur } = resolveHeaders({
    storedHeaders: rt[0] && (rt[0].detected_headers || rt[0].headers),
    columns: null, rows: parts,
  });
  if (!cur.length) {
    throw new DeliveryColumnError('no_headers',
      '열 구성을 알 수 없습니다 — 작업표를 먼저 만들거나 [작업표 재구성]을 실행하세요.');
  }

  let next = cur;
  let added = [];
  if (base === '혼합') {
    const r = withDeliveryKindColumn(next);
    next = r.headers;
    if (r.added) added.push(DELIVERY_KIND_HEADER);
  } else {
    const r = withRecallColumns(next);
    next = r.headers;
    added = added.concat(r.added);
  }

  // ── 소급 기입(blank-only) ──
  const plan = [];
  let alreadyFilled = 0;
  if (backfill && parts.length) {
    let valueOf;
    if (base === '혼합') {
      /* ★ 배분은 접수 경로와 **같은 함수** — 구매일자 비율을 지킨다.
         행의 구매일자는 표시 문자열이라 라벨 그대로 넘긴다(같은 날짜끼리 묶이면 충분하다). */
      const rowDates = parts.map((p) => {
        const rj = (p.row_json && typeof p.row_json === 'object') ? p.row_json : {};
        const label = _str(rj['구매일자']);
        return label ? { date: label, label } : null;
      });
      const dist = distributeDeliveryTypes({ total: parts.length, rowDates, globalMix: liveMix });
      valueOf = (i) => (dist.rowDeliveryTypes[i] ? { [DELIVERY_KIND_HEADER]: dist.rowDeliveryTypes[i] } : null);
    } else {
      const patchAll = {};
      if (courier) patchAll[RECALL_HEADERS[0]] = courier;
      if (product) patchAll[RECALL_HEADERS[1]] = product;
      valueOf = () => patchAll;
    }
    parts.forEach((p, i) => {
      const want = valueOf(i);
      if (!want) return;
      const rj = (p.row_json && typeof p.row_json === 'object') ? p.row_json : {};
      const patch = {};
      for (const [h, v] of Object.entries(want)) {
        if (!v) continue;
        const now = _str(rj[h]);
        if (now) continue;            // ★ blank-only
        patch[h] = v;
      }
      if (!Object.keys(patch).length) { alreadyFilled++; return; }
      plan.push({ seq: p.seq, patch });
    });
  }

  const summary = {
    ok: true, sheetId, tabName, tabGid, deliveryBase: base,
    headerNames: base === '혼합' ? [DELIVERY_KIND_HEADER] : RECALL_HEADERS.slice(),
    headerAdded: added,
    alreadyHadColumn: !added.length,
    headers: next,
    backfillCount: plan.length,
    skippedAlreadyFilled: alreadyFilled,
    rows: plan.slice(0, 50).map(p => ({ seq: p.seq, patch: p.patch })),
    rowsTruncated: Math.max(0, plan.length - 50),
  };
  if (dryRun) return { ...summary, dryRun: true };
  if (!added.length && !plan.length) return { ...summary, dryRun: false, noop: true };

  // ── 실행: 헤더 + row_json 두 곳만 ──
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 장부 재생성과 **같은 락** — 재생성 도중 헤더가 바뀌면 표가 한 칸씩 밀린다.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sheetless_ledger:${sheetId}:${tabName}`]);
    if (added.length) {
      const { rowCount } = await client.query(
        `UPDATE raw_sheet_tabs
            SET headers = $3::jsonb, detected_headers = $3::jsonb, col_count = $4
          WHERE sheet_id = $1 AND tab_gid = $2`,
        [sheetId, tabGid, JSON.stringify(next), next.length]);
      if (!rowCount) logger.warn(`[deliveryColumn] raw_sheet_tabs 행 없음 — 재생성이 헤더를 만든다 ${sheetId}/${tabName}`);
    }
    for (const p of plan) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL`,
        [sheetId, tabName, p.seq, JSON.stringify(p.patch)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }

  // ── 장부 3권 재생성 ──
  let rebuilt = null, rebuildError = null;
  try {
    const { rebuildLedgers } = require('./sheetlessLedger.service');
    rebuilt = await rebuildLedgers({ sheetId, tabName, columns: next, dryRun: false, by: `deliverycol:${by}` });
  } catch (e) {
    rebuildError = (e && e.message) || String(e);
    logger.warn(`[deliveryColumn] 장부 재생성 실패 ${sheetId}/${tabName}: ${rebuildError}`);
  }

  logger.info(`[deliveryColumn] ${sheetId}/${tabName} base=${base} 열추가=${added.join(',') || '없음'} 소급=${plan.length} by=${by}`);
  return { ...summary, dryRun: false, rebuilt, rebuildError };
}

module.exports = {
  ensureDeliveryColumns, DeliveryColumnError,
  withDeliveryKindColumn, withRecallColumns,
  __setPoolForTest,
};
