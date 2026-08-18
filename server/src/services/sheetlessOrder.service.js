/**
 * sheetlessOrder.service.js — 무시트 주문 "즉시 완결" (탈 구글시트 W2)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 하는 일 = **구매양식 제출을 시트가 아니라 작업표에 기록한다**
 *
 *   시트 경로 : 원장 INSERT → 행 배정 → `order_append` 큐 → (몇 초~분) → 구글시트 기록 → written
 *   무시트    : 원장 INSERT → 행 배정 → **작업표에 바로 기록 + 장부 재생성** → written (같은 요청 안)
 *
 *   그래서 "즉시 완결" — 큐·재시도·사후검증(시트 대조)이 통째로 필요 없어진다.
 *   최종점검 문서가 지적한 "시트 없음 종결 상태 부재 → reconcile 헛돌기 + 알림 도배"의 해소다.
 *
 * ★★ **`mirror_status` 값은 그대로 `'written'`**(새 상태를 만들지 않는다). 이유:
 *   'written' 은 이미 **종결 상태**이고 소비처가 여럿(reconcile 제외 · 배치 스케줄러 제외 ·
 *   미반영 알림 제외 · Track B 금액 집계 · 교체요청 자동해결)이다. 새 값을 만들면 그 목록을
 *   전부 훑어야 하고 **한 곳만 놓쳐도 무시트 주문이 조용히 "미완결"로 취급**된다.
 *   대신 **시트를 실제로 읽어 대조하는 경로**(written 사후검증)에서만 무시트 탭을 제외한다.
 *
 * ★★ 매핑 사본 0 — 어느 칸에 무엇을 쓸지는 `mapOrderToSheetRow`(orderLedger 단일 출처)가 정한다.
 *   여기서 키워드 규칙을 다시 만들면 "시트 작업과 무시트 작업이 서로 다른 칸에 쓰는" 사고가 난다.
 *
 * ★★ 옵션 칸 blank-only 유지 — 시트 경로의 `filterOptionWritesBlankOnly` 와 **같은 규율**로
 *   작업표의 기존 옵션 값(관리자 작업지시 '텍스트'·'포토리뷰')을 덮지 않는다.
 *   판정 열은 `optionWriteColumns`(매퍼 파생) — `optionColIndexes`(헤더에 '옵션' 포함)를 쓰면
 *   `옵션금액`(=결제금액)·`비고(옵션확인)` 을 오분류해 금액·비고가 조용히 사라진다.
 *
 * ★ 구글 API 호출 0(회귀가드가 고정). 쓰기 표면 = `campaign_participants` + 장부 3권 + 주문 원장.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');
const pool = require('../db/pool');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 연락처 → 뒤 8자리(검색·행배정 신원키와 같은 규칙) */
function _phone8(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

/**
 * 주문 값 → 작업표 행에 병합할 `row_json` 조각.
 *
 * @param {string[]} headers          장부(=작업표) 열 이름
 * @param {object}   orderData        구매양식 값
 * @param {object}   currentRowJson   그 줄의 현재 값(옵션 blank-only 판정 재료)
 * @returns {{patch:object, optionSuppressed:Array<{header,want,cur}>}}
 *   patch = 덮어쓸 {헤더명: 값}. 매퍼가 `null` 을 준 칸(관리자 보호열 등)은 들어가지 않는다.
 */
function buildRowPatch(headers, orderData, currentRowJson = {}) {
  const { mapOrderToSheetRow, optionWriteColumns } = require('./orderLedger.service');
  const mapped = mapOrderToSheetRow(headers || [], orderData || {});
  const optCols = new Set(optionWriteColumns(headers || []));
  const blankOnly = process.env.ORDER_OPTION_BLANK_ONLY !== '0';

  const patch = {};
  const optionSuppressed = [];
  (headers || []).forEach((h, i) => {
    const val = mapped[i];
    if (val === null || val === undefined) return;          // 매퍼가 "쓰지 않음"이라 한 칸
    const name = String(h == null ? '' : h);
    if (!name) return;
    if (optCols.has(i) && blankOnly) {
      const cur = String((currentRowJson || {})[name] == null ? '' : (currentRowJson || {})[name]).trim();
      if (cur) { optionSuppressed.push({ header: name, want: String(val), cur }); return; }
    }
    patch[name] = String(val);
  });
  return { patch, optionSuppressed };
}

/**
 * 무시트 탭의 주문을 작업표에 기록하고 장부를 다시 만든다.
 *
 * @param {object} o
 * @param {string} o.sheetId · o.tabName · [o.tabGid]
 * @param {number} o.sheetRow            배정된 행 번호(= `campaign_participants.seq`)
 * @param {object} o.orderData
 * @param {string} o.orderSubmissionId
 * @param {string} [o.loginPhone8] · [o.loginName]
 * @param {boolean} [o.recovered]        복구 재기록(비고 표기용 — 시트 경로와 같은 의미)
 * @returns {Promise<{ok:boolean, written?:boolean, reason?:string, ledger?:object}>}
 */
async function writeOrderToWorktable({
  sheetId, tabName, tabGid = '', sheetRow, orderData = {},
  orderSubmissionId, loginPhone8 = '', loginName = '', recovered = false,
} = {}) {
  if (!sheetId || !tabName || !orderSubmissionId) return { ok: false, reason: 'bad_request' };
  const db = getPool();

  const ledgerSvc = require('./orderLedger.service');
  const { loadRawTabContext, markOrderWritten } = ledgerSvc;

  // ── 열 구성 = 장부(raw_sheet_tabs)에서. 시트 경로와 **같은 로더**를 쓴다(사본 0). ──
  let ctx = null;
  try { ctx = await loadRawTabContext(sheetId, tabGid, tabName); } catch (_) { ctx = null; }
  const headers = (ctx && ctx.headers) || [];
  if (!headers.length) {
    // ★ 열을 모르면 아무 칸에도 쓸 수 없다 — 조용히 "완결" 처리하지 않는다(주문은 원장에 살아 있고
    //   화면·복구 경로가 미반영으로 본다).
    return { ok: false, reason: 'no_headers' };
  }
  const gid = String((ctx && ctx.tabGid) || tabGid || '');

  const requestedSeq = sheetRow == null ? null : parseInt(sheetRow, 10);
  if (sheetRow != null && (!Number.isInteger(requestedSeq) || requestedSeq < 1)) return { ok: false, reason: 'bad_row' };

  // ── 작업표 줄에 병합 ────────────────────────────────────────────────
  //   ★ 행 잠금(FOR UPDATE) — 같은 줄에 동시에 두 건이 들어오는 경우는 claim 이 막지만,
  //     재기록(reconcile)·관리자 편집과의 경합까지 직렬화한다.
  const client = await db.connect();
  let optionSuppressed = [];
  try {
    await client.query('BEGIN');
    let cur;
    let seq = requestedSeq;
    if (seq != null) {
      ({ rows: cur } = await client.query(
        `SELECT id, seq, row_json FROM campaign_participants
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL
          FOR UPDATE`, [sheetId, tabName, seq]));
    } else {
      // 재시도는 이미 연결된 행을 먼저 잠근다. 없을 때만 준비된 빈 슬롯을 선점한다.
      ({ rows: cur } = await client.query(
        `SELECT id, seq, row_json FROM campaign_participants
          WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
            AND order_submission_id = $3::uuid
          FOR UPDATE`, [sheetId, tabName, orderSubmissionId]));
      if (!cur.length) {
        ({ rows: cur } = await client.query(
          `SELECT id, seq, row_json FROM campaign_participants
            WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE
              AND order_submission_id IS NULL
              AND NULLIF(btrim(COALESCE(reviewer_name, '')), '') IS NULL
              AND NULLIF(btrim(COALESCE(recipient_name, '')), '') IS NULL
              AND NULLIF(btrim(COALESCE(phone8, '')), '') IS NULL
            ORDER BY seq
            FOR UPDATE SKIP LOCKED
            LIMIT 1`, [sheetId, tabName]));
      }
      if (!cur.length) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'no_open_slot' };
      }
      seq = Number(cur[0].seq);
    }

    const currentRowJson = (cur[0] && cur[0].row_json && typeof cur[0].row_json === 'object') ? cur[0].row_json : {};
    const built = buildRowPatch(headers, orderData, currentRowJson);
    optionSuppressed = built.optionSuppressed;
    const merged = { ...currentRowJson, ...built.patch };

    const reviewerName = String(loginName || orderData.orderer || orderData.recipient || '').slice(0, 200);
    const recipientName = String(orderData.recipient || '').slice(0, 200);
    const p8 = _phone8(orderData.phone) || String(loginPhone8 || '').replace(/\D/g, '').slice(-8);
    // ★ 옵션은 리뷰어가 고른 값만 원장에 — 시트값 역주입 금지(C′ 규율). 빈 값이면 기존 값 보존.
    const optText = String(orderData.selectedOptKey || '').trim();

    if (cur.length) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = $4::jsonb,
                reviewer_name  = COALESCE(NULLIF($5,''), reviewer_name),
                recipient_name = COALESCE(NULLIF($6,''), recipient_name),
                phone8         = COALESCE(NULLIF($7,''), phone8),
                option_text    = COALESCE(NULLIF($8,''), option_text),
                order_submission_id = $9::uuid,
                updated_by = 'sheetless-order', updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`,
        [sheetId, tabName, seq, JSON.stringify(merged), reviewerName, recipientName, p8, optText, orderSubmissionId]);
    } else {
      // 행 번호가 명시된 레거시 복구만 표 끝 append를 허용한다. 신규 무시트 접수는 위의
      // 준비 슬롯 선점만 사용하므로 모집 인원을 초과해 작업보드 행을 만들지 않는다.
      if (requestedSeq == null) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'no_open_slot' };
      }
      // 표 끝을 넘어 배정된 경우(append) — 그 자리에 줄을 만든다.
      //   ★ source='worktable' — `importTabFromIndex` 상태 CASE 가 인정하는 값(신규 값 금지).
      await client.query(
        `INSERT INTO campaign_participants
           (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8,
            option_text, order_submission_id, row_json, source, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10::jsonb,'worktable','sheetless-order',NOW())
         ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING`,
        [sheetId, gid || null, tabName, seq, reviewerName, recipientName, p8,
         optText || null, orderSubmissionId, JSON.stringify(merged)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error(`[sheetlessOrder] 작업표 기록 실패 tab=${tabName} seq=${seq}: ${err.message}`);
    return { ok: false, reason: 'write_failed', message: err.message };
  } finally {
    client.release();
  }

  // ── 장부 3권 재생성 — 이래야 리뷰어 검색·리뷰내역·홈 통계가 즉시 따라온다 ──
  let ledger = null;
  try {
    ledger = await require('./sheetlessLedger.service').rebuildLedgers({ sheetId, tabName, by: 'sheetless-order' });
  } catch (err) {
    // ★ 여기 실패는 "표엔 있는데 검색은 안 되는" 상태 → 주문을 완결로 찍지 않는다(다음 재시도가 메운다).
    logger.error(`[sheetlessOrder] 장부 재생성 실패 tab=${tabName}: ${err.message}`);
    return { ok: false, reason: 'ledger_failed', message: err.message };
  }

  // ── 주문 완결 + 신원 링크 ───────────────────────────────────────────
  //   ★ 신원 기록은 **기록 성공 후에만**(시트 경로와 같은 규율 — 낙관적 선기입이 교차노출을 만들었다).
  //   ★ `last_sheet_write_sig` 는 남기지 않는다 → 시트 역동기화 탐지가 이 주문을 건드리지 않는다.
  try {
    await markOrderWritten(orderSubmissionId, seq);
  } catch (err) {
    logger.warn(`[sheetlessOrder] 완결 표시 실패(기록은 완료): ${err.message}`);
  }
  try {
    const { recordParticipationLink } = require('./participation.service');
    await recordParticipationLink({
      sheetId, tabName, rowIndex: seq, phone8: loginPhone8,
      phone: orderData.phone, name: loginName || orderData.orderer, source: 'sheetless_order' });
    await ledgerSvc.recordReviewIdentity({
      sheetId, tabName, tabGid: gid, rowIndex: seq, phone8: loginPhone8,
      phone: orderData.phone, name: loginName || orderData.orderer, recipient: orderData.recipient });
  } catch (err) {
    logger.warn(`[sheetlessOrder] 신원 링크 기록 실패(무시): ${err.message}`);
  }

  if (optionSuppressed.length) {
    logger.warn(`[sheetlessOrder] 옵션 칸 보존(blank-only) tab=${tabName} seq=${seq} ` +
      optionSuppressed.map(s => `${s.header}: "${s.cur}" 유지`).join(' · '));
  }

  logger.info(`[sheetlessOrder] 즉시 완결 tab=${tabName} seq=${seq} os=${orderSubmissionId}${recovered ? ' (복구)' : ''}`);
  return { ok: true, written: true, seq, ledger, optionSuppressed };
}

/**
 * 과거 첫 탈시트 배포 구간의 주문은 order_submissions에만 있고 작업보드 행이 없을 수 있다.
 * 이 복구는 그런 주문만 골라 이미 준비된 빈 작업보드 슬롯에 연결한다.
 * 외부 시트/GAS 호출은 전혀 하지 않으며, 각 행은 writeOrderToWorktable의 잠금으로 선점된다.
 */
async function recoverUnwrittenSheetlessOrders({ limit = 100, by = 'sheetless-order-recovery' } = {}) {
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
  const { rows } = await db.query(
    `SELECT os.id, os.orderer, os.recipient, os.user_id, os.phone, os.address,
            os.bank, os.account, os.depositor, os.price, os.date_str, os.order_num,
            os.memo, os.selected_opt_key,
            ca.phone8 AS login_phone8, ca.owner_phone8, r.name AS login_name,
            rc.linked_sheet_id, rc.linked_tab_name, rc.linked_tab_gid
       FROM order_submissions os
       JOIN campaign_applications ca ON ca.id = os.campaign_application_id
       JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
       LEFT JOIN reviewers r ON r.phone8 = COALESCE(ca.owner_phone8, ca.phone8)
      WHERE os.deleted_at IS NULL
        AND os.sheet_id LIKE 'campaign:%'
        AND COALESCE(rc.linked_sheet_id, '') <> ''
        AND COALESCE(rc.linked_tab_name, '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM campaign_participants cp
           WHERE cp.order_submission_id = os.id AND cp.deleted_at IS NULL
        )
      ORDER BY os.created_at ASC
      LIMIT $1`, [lim]);

  const result = { scanned: rows.length, written: 0, failed: 0, noOpenSlot: 0, items: [] };
  for (const row of rows) {
    let out;
    try {
      out = await writeOrderToWorktable({
        sheetId: row.linked_sheet_id, tabName: row.linked_tab_name, tabGid: row.linked_tab_gid || '',
        orderSubmissionId: row.id,
        loginPhone8: row.login_phone8 || row.owner_phone8 || '', loginName: row.login_name || row.orderer || '',
        recovered: true,
        orderData: {
          orderer: row.orderer, recipient: row.recipient, userId: row.user_id, phone: row.phone,
          address: row.address, bank: row.bank, account: row.account, depositor: row.depositor,
          price: row.price, dateStr: row.date_str, orderNum: row.order_num, memo: row.memo,
          selectedOptKey: row.selected_opt_key,
        },
      });
      if (out.ok) result.written++;
      else {
        result.failed++;
        if (out.reason === 'no_open_slot') result.noOpenSlot++;
        await require('./orderLedger.service').markOrderMirrorFailed(row.id, out.message || out.reason);
      }
    } catch (err) {
      out = { ok: false, reason: 'exception', message: err.message };
      result.failed++;
      await require('./orderLedger.service').markOrderMirrorFailed(row.id, err);
    }
    result.items.push({ orderSubmissionId: row.id, ok: !!out.ok, reason: out.reason || null, seq: out.seq || null });
  }
  logger.info(`[sheetlessOrder] 과거 작업보드 복구 by=${by} scanned=${result.scanned} written=${result.written} failed=${result.failed}`);
  return result;
}

module.exports = {
  writeOrderToWorktable,
  recoverUnwrittenSheetlessOrders,
  buildRowPatch,
  __setPoolForTest,
};
