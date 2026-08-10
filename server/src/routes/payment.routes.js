const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { writeSheet, readSheet } = require('../services/sheets.service');
const { enqueue } = require('../services/syncQueue.service');
const { logger } = require('../utils/logger');
const pool = require('../db/pool');

// ── 헬퍼: 열 인덱스 → 알파벳 (A=0) ──
function _getColLetter(colIdx) {
  let letter = '';
  let idx = colIdx;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

// ── 헬퍼: 헤더 행 탐색 (키워드 2개 이상 포함된 행) ──
function _detectHeaderRow(headerValues) {
  if (!headerValues || !headerValues.length) return [];
  const KW = ['주문자', '수취인', '연락처', '주소', '은행', '계좌', '금액', '아이디', '인애드', '리뷰', '입금'];
  let headerRow = headerValues[0];
  for (const row of headerValues) {
    const m = (row || []).filter(c => KW.some(k => String(c || '').includes(k))).length;
    if (m >= 2) { headerRow = row; break; }
  }
  return headerRow.map(h => String(h || '').trim());
}

// ── 헬퍼: 이체완료시각 "YYYY.M.D HH:mm" (Asia/Seoul) ──
function _nowStamp() {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  // hour는 2자리, 자정 표기 '24' 방어
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}.${p.month}.${p.day} ${hh}:${p.minute}`;
}

// ── 헬퍼: row_json에서 결제금액 추출 ──
// ★ 규칙 본체는 utils/paymentAmount.js 단일 출처(입금관리 M1 의 상품비 폴백과 공용).
//   여기 사본을 되살리면 "레거시 화면과 입금관리의 금액이 갈리는" 드리프트가 난다.
const { extractAmountText: _extractAmount } = require('../utils/paymentAmount');

// ═══════════════════════════════════════════════════════════
// GET /api/payment/targets — 입금 대상 목록 (GAS: getPaymentTargets)
//   리뷰 완료(is_submitted) + 입금 미처리(is_submitted2 != PAID) + 미마감 탭
//   리뷰어 마스터(reviewers)에서 계좌/소득명의/주민번호를 결합한다.
// ═══════════════════════════════════════════════════════════
router.get('/targets', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ri.reviewer_name AS "reviewerName",
        ri.tab_name AS "tabName",
        ri.sheet_id AS "sheetId",
        ri.tab_gid AS "gid",
        ri.row_index AS "rowIndex",
        ri.campaign_name AS "campaignName",
        ri.product_name AS "productName",
        ri.submit_col2 AS "depositColKey",
        ri.row_json AS "rowJson",
        tc.deposit_name AS "depositName",
        tc.transfer_bank AS "transferBank",
        tc.payment_type AS "paymentType",
        tc.display_name AS "displayName",
        rev.bank_name AS "bank",
        rev.bank_account AS "account",
        rev.account_holder AS "holder",
        rev.income_type AS "incomeName",
        rev.resident_num AS "residentNum"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      LEFT JOIN reviewers   rev ON rev.phone8 = ri.phone8
      WHERE ri.is_submitted = TRUE
        AND (tc.is_closed IS NULL OR tc.is_closed = FALSE)
        AND (ri.is_submitted2 IS NULL OR ri.is_submitted2 = 'NONE')
      ORDER BY ri.tab_name, ri.reviewer_name
    `);

    // row_json → 결제금액 추출 후 응답 슬림화 (row_json 자체는 제외)
    const targets = rows.map(r => {
      const { rowJson, ...rest } = r;
      return { ...rest, amount: _extractAmount(rowJson) };
    });

    res.json({ ok: true, targets, total: targets.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/payment/mark-done — 이체 완료 처리 (GAS: markPaymentDone)
//   1) DB: review_index.is_submitted2='PAID' + payment_records 이력
//   2) 백그라운드: 구글시트 입금칸(submit_col2)에 이체완료시각 기록
//      (실패 시 sync_queue 'deposit_mark' 로 재시도)
// ═══════════════════════════════════════════════════════════
router.post('/mark-done', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items
                : Array.isArray(req.body.rows)  ? req.body.rows
                : [];
    if (items.length === 0) {
      return res.json({ error: '처리할 항목이 없습니다.' });
    }

    const stamp = _nowStamp();
    let updated = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of items) {
        const rowIndex = item.rowIndex != null ? item.rowIndex : item.rowNum;
        const result = await client.query(
          `UPDATE review_index SET is_submitted2 = 'PAID'
           WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
          [item.sheetId, item.tabName, rowIndex]
        );
        updated += result.rowCount;

        await client.query(
          `INSERT INTO payment_records (sheet_id, tab_name, reviewer_name, row_index, amount, paid_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [item.sheetId, item.tabName, item.reviewerName || '', rowIndex,
           item.amount || '', req.admin?.name || '']
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // ── 즉시 응답 (DB 저장 = 처리 성공) ──
    res.json({ ok: true, updated, successCount: updated, paidAt: stamp, errors: [] });

    // ── 백그라운드: 구글시트 입금칸에 이체완료시각 기록 ──
    setImmediate(async () => {
      const headerCache = {};
      for (const item of items) {
        const rowIndex = item.rowIndex != null ? item.rowIndex : item.rowNum;
        const depositColKey = item.depositColKey;

        /* ★★ 무시트 탭 — 위의 `review_index.is_submitted2='PAID'` 는 **다음 장부 재생성에 지워진다**
           (재생성이 review_index 를 지우고 작업표에서 다시 만든다). 시트 쓰기도 막혀 있으므로
           작업표 입금 칸에 스탬프를 남겨야 **입금 표시가 살아남는다**.
           ★ 입금 칸 헤더명은 파서가 감지한 `submit_col2` 를 쓰므로 depositColKey 가 없어도 동작한다
             (그 값은 화면이 준 힌트일 뿐 — 무시트에서는 서버가 다시 정한다). */
        try {
          const st = await require('../services/sheetlessStatus.service').markStatusCell({
            sheetId: item.sheetId, tabName: item.tabName, rowIndex,
            kind: 'paid', value: stamp, by: req.admin?.name || 'payment',
          });
          if (st.handled) {
            if (st.ok) logger.info(`[payment/mark-done:bg] 무시트 입금칸 기록 (tab=${item.tabName}, row=${rowIndex}, col=${st.column})`);
            else logger.warn(`[payment/mark-done:bg] 무시트 입금칸 기록 실패 (tab=${item.tabName}, row=${rowIndex}) reason=${st.reason}`);
            continue;   // ★ 시트 쓰기·deposit_mark 큐로 내려가지 않는다(무시트에는 쓸 시트가 없다)
          }
        } catch (e) {
          logger.warn(`[payment/mark-done:bg] 무시트 판정 예외 → 시트 경로로 진행: ${e.message}`);
        }

        if (!depositColKey || !rowIndex) continue; // 입금컬럼 미지정 행은 시트 기록 생략
        try {
          const cacheKey = item.sheetId + '||' + item.tabName;
          let headers = headerCache[cacheKey];
          if (!headers) {
            const hv = await readSheet(item.sheetId, `'${item.tabName}'!1:50`);
            headers = _detectHeaderRow(hv);
            headerCache[cacheKey] = headers;
          }
          const colIdx = headers.findIndex(h => h === depositColKey);
          if (colIdx < 0) throw new Error(`입금컬럼 '${depositColKey}' 을 헤더에서 찾을 수 없음`);
          const range = `'${item.tabName}'!${_getColLetter(colIdx)}${rowIndex}`;
          await writeSheet(item.sheetId, range, [[stamp]], item.gid ? { gid: item.gid } : {});
          logger.info(`[payment/mark-done:bg] 입금칸 기록 성공 (tab=${item.tabName}, row=${rowIndex})`);
        } catch (bgErr) {
          logger.warn(`[payment/mark-done:bg] 시트 쓰기 실패 → 큐 등록: ${bgErr.message}`);
          try {
            await enqueue('deposit_mark', {
              sheetId: item.sheetId,
              tabName: item.tabName,
              rowIndex,
              depositColKey,
              value: stamp,
              gid: item.gid || '',
            });
          } catch (qErr) {
            logger.error(`[payment/mark-done:bg] 큐 등록도 실패: ${qErr.message}`);
          }
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/payment/history — 입금 이력 조회
// ═══════════════════════════════════════════════════════════
router.get('/history', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, limit } = req.query;
    let sql = `
      SELECT sheet_id AS "sheetId", tab_name AS "tabName",
             reviewer_name AS "reviewerName", row_index AS "rowIndex",
             amount, status, paid_by AS "paidBy", paid_at AS "paidAt"
      FROM payment_records
    `;
    const params = [];
    const where = [];

    if (sheetId) { where.push(`sheet_id = $${params.length + 1}`); params.push(sheetId); }
    if (tabName) { where.push(`tab_name = $${params.length + 1}`); params.push(tabName); }

    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY paid_at DESC';
    sql += ` LIMIT ${parseInt(limit) || 100}`;

    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, history: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
