const express = require('express');
const router = express.Router();
// Track B(trackB.routes.js)가 경로 문자열 대신 이름으로 부르는 핸들러 모음 — 맨 아래 router.handlers 로 내보낸다(결정 270).
const { lastRouteHandler } = require('../utils/routeHandlers');
const _handlers = {};
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { readSheet } = require('../services/sheets.service');
// ★ 담당자 표기 단일 출처(065) — 실명(박세희·박은비)이 들어오면 닉네임(만두·망고)으로 접는다.
//   여기서 접지 않으면 자유입력 한 번에 담당자 필터 칩이 다시 넷으로 갈린다.
const { normalizeManagerForStore } = require('../utils/workManager');
const {
  CASH_RECEIPT_CHANNELS, CASH_RECEIPT_SETTING_KEYS,
  cashReceiptSettingKey, isCashReceiptChannelKey, cashReceiptChannelLabel,
} = require('../utils/cashReceiptChannels');
const { logger } = require('../utils/logger');
const { throttledCall } = require('../utils/sheetsThrottle');
const { assignStableCaptureSlotKeys } = require('../utils/captureSlots');

// ── Auto-migration: display_name_map JSONB 컬럼 추가 (차수별 표시명) ──
(async () => {
  try {
    await pool.query(`
      ALTER TABLE tab_configs
      ADD COLUMN IF NOT EXISTS display_name_map JSONB DEFAULT '{}'::jsonb
    `);
    logger.info('[tabconfig] display_name_map 컬럼 확인/추가 완료');
  } catch (err) {
    // 이미 존재하거나 다른 이유로 실패 시 무시 (서버 시작 차단 방지)
    logger.warn('[tabconfig] display_name_map 컬럼 추가 실패 (이미 존재할 수 있음):', err.message);
  }
})();

// ── Auto-migration: option_columns JSONB 컬럼 추가 (옵션 컬럼 선택) ──
(async () => {
  try {
    await pool.query(`
      ALTER TABLE tab_configs
      ADD COLUMN IF NOT EXISTS option_columns JSONB DEFAULT '[]'::jsonb
    `);
    logger.info('[tabconfig] option_columns 컬럼 확인/추가 완료');
  } catch (err) {
    logger.warn('[tabconfig] option_columns 컬럼 추가 실패 (이미 존재할 수 있음):', err.message);
  }
})();

// ── Auto-migration: option_columns_map JSONB 컬럼 추가 (차수별 옵션 컬럼) ──
(async () => {
  try {
    await pool.query(`
      ALTER TABLE tab_configs
      ADD COLUMN IF NOT EXISTS option_columns_map JSONB DEFAULT '{}'::jsonb
    `);
    logger.info('[tabconfig] option_columns_map 컬럼 확인/추가 완료');
  } catch (err) {
    logger.warn('[tabconfig] option_columns_map 컬럼 추가 실패 (이미 존재할 수 있음):', err.message);
  }
})();

// ── Auto-migration: round_meta JSONB 컬럼 추가 (차수별 부가정보: 담당자, 리뷰타입, 결제방식, 주문시간대 등) ──
(async () => {
  try {
    await pool.query(`
      ALTER TABLE tab_configs
      ADD COLUMN IF NOT EXISTS round_meta JSONB DEFAULT '{}'::jsonb
    `);
    logger.info('[tabconfig] round_meta 컬럼 확인/추가 완료');
  } catch (err) {
    logger.warn('[tabconfig] round_meta 컬럼 추가 실패 (이미 존재할 수 있음):', err.message);
  }
})();

// ── Auto-migration: provider_memo 컬럼 추가 (구매양식 제공정보 메모) ──
(async () => {
  try {
    await pool.query(`
      ALTER TABLE tab_configs
      ADD COLUMN IF NOT EXISTS provider_memo TEXT DEFAULT ''
    `);
    // 회사 공통 사업자번호 키 시드 (없을 때만)
    await pool.query(`
      INSERT INTO app_settings (key, value)
      VALUES ('company_business_no', '')
      ON CONFLICT (key) DO NOTHING
    `);
    logger.info('[tabconfig] provider_memo 컬럼/회사 사업자번호 키 확인/추가 완료');
  } catch (err) {
    logger.warn('[tabconfig] provider_memo 컬럼 추가 실패 (이미 존재할 수 있음):', err.message);
  }
})();

// ── Auto-migration: capture_slots JSONB 컬럼 추가 (탭별 다중 리뷰 캡처 슬롯) ──
// 형식: [{"key":"review","label":"리뷰"},{"key":"receipt","label":"현금영수증"}]
// NULL/[] = 단일 암묵 'review' 슬롯 (기존 동작 그대로)
(async () => {
  try {
    await pool.query(`
      ALTER TABLE tab_configs
      ADD COLUMN IF NOT EXISTS capture_slots JSONB DEFAULT NULL
    `);
    logger.info('[tabconfig] capture_slots 컬럼 확인/추가 완료');
  } catch (err) {
    logger.warn('[tabconfig] capture_slots 컬럼 추가 실패 (이미 존재할 수 있음):', err.message);
  }
})();

// POST /api/tab/config — 탭 설정 저장/수정 (GAS: setTabConfig)
// (POST /api/tab/config 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.tabConfigSave = async (req, res, next) => {
  try {
    const b = req.body;
    const tabName = (b.tabName || '').trim();
    if (!tabName) return res.json({ error: 'tabName이 필요합니다.' });

    const sheetId = (b.sheetId || '').trim();
    if (!sheetId) return res.json({ error: 'sheetId가 필요합니다.' });

    // ★ 차수별 표시명(display_name_map) 처리
    // round가 제공된 경우 display_name_map JSONB에 { round: displayName } 저장
    const roundKey = (b.round || '').trim();
    if (roundKey && b.displayName !== undefined) {
      try {
        const displayVal = (b.displayName || '').trim();
        // display_name_map JSONB 업데이트: 해당 round 키만 변경
        const mapSql = displayVal
          ? `UPDATE tab_configs
             SET display_name_map = COALESCE(display_name_map, '{}'::jsonb) || jsonb_build_object($3::text, $4::text),
                 updated_at = NOW()
             WHERE sheet_id = $1 AND tab_name = $2`
          : `UPDATE tab_configs
             SET display_name_map = COALESCE(display_name_map, '{}'::jsonb) - $3::text,
                 updated_at = NOW()
             WHERE sheet_id = $1 AND tab_name = $2`;
        const mapParams = displayVal
          ? [sheetId, tabName, roundKey, displayVal]
          : [sheetId, tabName, roundKey];
        const mapResult = await pool.query(mapSql, mapParams);
        if (mapResult.rowCount === 0) {
          // 레코드가 없으면 INSERT
          await pool.query(
            `INSERT INTO tab_configs (sheet_id, tab_name, display_name_map, updated_at)
             VALUES ($1, $2, jsonb_build_object($3::text, $4::text), NOW())
             ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
               display_name_map = COALESCE(tab_configs.display_name_map, '{}'::jsonb) || jsonb_build_object($3::text, $4::text),
               updated_at = NOW()`,
            [sheetId, tabName, roundKey, displayVal || '']
          );
        }
        return res.json({ ok: true, tabName, sheetId, round: roundKey, displayName: displayVal });
      } catch (mapErr) {
        logger.error('[tab/config] display_name_map 저장 오류:', mapErr.message, mapErr.stack);
        return res.json({ error: '차수별 표시명 저장 오류: ' + mapErr.message });
      }
    }

    // ★ 차수별 부가정보(round_meta) 처리
    // round가 제공되고 manager/reviewType/paymentType/timeRange 중 하나라도 있으면
    // round_meta JSONB의 해당 차수 키에 저장: { "1차": { manager: "만두", review_type: "실배송", ... } }
    const ROUND_META_FIELDS = { manager: 'manager', reviewType: 'review_type', paymentType: 'payment_type', timeRange: 'time_range' };
    if (roundKey) {
      const metaUpdate = {};
      for (const [apiKey, dbKey] of Object.entries(ROUND_META_FIELDS)) {
        if (b[apiKey] === undefined) continue;
        // ★ 담당자는 저장 직전 정규화(만두/망고) — 본 칸과 같은 규칙(사본 금지).
        metaUpdate[dbKey] = (apiKey === 'manager') ? normalizeManagerForStore(b[apiKey]) : b[apiKey];
      }
      if (Object.keys(metaUpdate).length > 0) {
        try {
          // round_meta[roundKey] 기존 값에 머지
          const { rows: existing } = await pool.query(
            'SELECT round_meta FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
            [sheetId, tabName]
          );
          const currentMeta = existing[0]?.round_meta || {};
          const roundData = currentMeta[roundKey] || {};
          Object.assign(roundData, metaUpdate);
          currentMeta[roundKey] = roundData;

          const upsertResult = await pool.query(
            `INSERT INTO tab_configs (sheet_id, tab_name, round_meta, updated_at)
             VALUES ($1, $2, $3::jsonb, NOW())
             ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
               round_meta = $3::jsonb,
               updated_at = NOW()`,
            [sheetId, tabName, JSON.stringify(currentMeta)]
          );
          return res.json({ ok: true, tabName, sheetId, round: roundKey, roundMeta: roundData });
        } catch (metaErr) {
          logger.error('[tab/config] round_meta 저장 오류:', metaErr.message);
          return res.json({ error: '차수별 부가정보 저장 오류: ' + metaErr.message });
        }
      }
    }

    // ★ 캡처 슬롯(capture_slots) 처리 — 전용 분기 (JSONB 타입 안전)
    //   순서가 바뀌어도 기존 key를 보존해 review_submissions 원장이 끊기지 않게 한다.
    //   기존 화면의 라벨 목록과 신규 화면의 {key,label} 모두 받는다.
    //   슬롯이 1개 이하이면 NULL 저장(= 단일 기본 'review' 슬롯, 기존 동작 그대로).
    if (b.captureSlots !== undefined) {
      const client = await pool.connect();
      try {
        const raw = Array.isArray(b.captureSlots) ? b.captureSlots : [];
        await client.query('BEGIN');
        const { rows: existing } = await client.query(
          `SELECT capture_slots FROM tab_configs
            WHERE sheet_id = $1 AND tab_name = $2
            FOR UPDATE`,
          [sheetId, tabName]
        );
        const slotsArr = assignStableCaptureSlotKeys(raw, existing[0]?.capture_slots);
        const slotsJson = slotsArr.length > 1 ? JSON.stringify(slotsArr) : null;
        await client.query(
          `INSERT INTO tab_configs (sheet_id, tab_name, capture_slots, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
             capture_slots = $3::jsonb, updated_at = NOW()`,
          [sheetId, tabName, slotsJson]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, tabName, sheetId, captureSlots: slotsArr });
      } catch (csErr) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        logger.error('[tab/config] capture_slots 저장 오류:', csErr.message);
        return res.json({ error: '캡처 슬롯 저장 오류: ' + csErr.message });
      } finally {
        client.release();
      }
    }

    // null 처리: undefined(미전송) = 기존값 보존, 빈문자열("") = 빈값 저장
    const fields = {
      sheet_url:    b.sheetUrl  || (sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit${b.tabGid ? '#gid=' + b.tabGid : ''}` : undefined),
      // ★★ 실명(박세희·박은비)으로 저장되던 것이 담당자 필터 칩이 넷으로 갈린 원인이다 —
      //   저장 직전에 닉네임으로 접는다. 모르는 값은 원문 보존, 빈 값은 해제 그대로.
      manager:      b.manager      !== undefined ? normalizeManagerForStore(b.manager) : undefined,
      time_range:   b.timeRange    !== undefined ? b.timeRange    : undefined,
      taekhap:      b.taekhap      !== undefined ? Boolean(b.taekhap) : undefined,
      review_type:  b.reviewType   !== undefined ? b.reviewType   : undefined,
      payment_type: b.paymentType  !== undefined ? b.paymentType  : undefined,
      display_name: b.displayName  !== undefined ? b.displayName  : undefined,
      delivery_type:b.deliveryType !== undefined ? b.deliveryType : undefined,
      is_bulk:      b.isBulk       !== undefined ? Boolean(b.isBulk) : undefined,
      round:        b.round        !== undefined ? b.round        : undefined,
      nc_mode:      b.ncMode       !== undefined ? Boolean(b.ncMode) : undefined,
      folder_url:   b.folderUrl    !== undefined ? b.folderUrl    : undefined,
      capture_folder_url: b.captureFolderUrl !== undefined ? b.captureFolderUrl : undefined,
      deposit_name: b.depositName  !== undefined ? b.depositName  : undefined,
      transfer_bank:b.transferBank !== undefined ? b.transferBank : undefined,
      income_type:  b.incomeType   !== undefined ? b.incomeType   : undefined,
      provider_memo:b.providerMemo !== undefined ? b.providerMemo : undefined,
      campaign_name:b.campaignName !== undefined ? b.campaignName : undefined,
    };

    /* 결정 247 — 이체은행 「업체입금」 쓰기 규칙(켜기 = 고를 수 있는 작업만 · 끄기 = 확인 표시가 있을 때만, 없으면 유지).
       ★ 관리자 대시보드의 탭 설정 창·간편 입력은 업체입금을 모른다 — 다른 칸만 고쳐도 transferBank 를 같이 보내므로
         여기서 막지 않으면 업체입금이 조용히 꺼진다(Codex 리뷰). */
    let bankKept = null;
    if (fields.transfer_bank !== undefined) {
      const { rows: curRows } = await pool.query(
        'SELECT transfer_bank FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1', [sheetId, tabName]);
      const g = await require('../services/advertiserPayout.service').guardTransferBankWrite({
        current: curRows[0] ? curRows[0].transfer_bank : null, incoming: fields.transfer_bank,
        ack: b.transferBankDisableAck, sheetId, tabName, slot: 'tab' });
      if (g.action === 'reject') return res.json({ error: g.message, code: g.error });
      if (g.action === 'keep') { fields.transfer_bank = undefined; bankKept = g; }
      else if (require('../services/payment.service').isAdvertiserPayoutChoice(fields.transfer_bank)) fields.transfer_bank = '업체입금';   // 표기 하나로
      else if (require('../services/payment.service').splitBankOf(fields.transfer_bank)) {   // 결정 292 — 제품비 업체도 탭 라벨 하나로
        const pay = require('../services/payment.service');
        fields.transfer_bank = pay.SPLIT_PAYOUT_LABEL[pay.splitBankOf(fields.transfer_bank)];
      }
    }

    // undefined 필드 제거 (기존값 보존)
    const updateEntries = Object.entries(fields).filter(([, v]) => v !== undefined);

    if (updateEntries.length === 0) {
      if (bankKept) return res.json({ ok: true, tabName, sheetId, transferBankKept: bankKept.kept, transferBankNotice: bankKept.notice });
      return res.json({ error: '업데이트할 필드가 없습니다.' });
    }

    // UPSERT SQL 동적 생성
    const colNames = updateEntries.map(([k]) => k);
    const values = updateEntries.map(([, v]) => v);
    const placeholders = values.map((_, i) => `$${i + 3}`);
    const setClause = colNames.map((k, i) => `${k} = $${i + 3}`).join(', ');

    const sql = `
      INSERT INTO tab_configs (sheet_id, tab_name, ${colNames.join(', ')}, updated_at)
      VALUES ($1, $2, ${placeholders.join(', ')}, NOW())
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        ${setClause},
        updated_at = NOW()
      RETURNING *
    `;

    await pool.query(sql, [sheetId, tabName, ...values]);
    res.json({ ok: true, tabName, sheetId,
      ...(bankKept ? { transferBankKept: bankKept.kept, transferBankNotice: bankKept.notice } : {}) });
  } catch (err) {
    next(err);
  }
};

// ═══════════════════════════════════════════════════════════
// GET /api/tab/provider-info — 구매양식 "제공정보" 카드용 안내정보 (인증 불필요)
// Query: sheetId, tabName (둘 다 선택 — 없으면 회사 사업자번호만 반환)
// 반환: { ok, providerMemo, incomeType, companyBusinessNo }
//  - providerMemo: 탭별 제공정보 메모 (공란이면 화면에 미노출)
//  - incomeType: 진행방식 (사업자현영이면 현금영수증 안내 표시 조건)
//  - companyBusinessNo: 회사 공통 사업자번호 (지출증빙 현금영수증 발행용)
// ═══════════════════════════════════════════════════════════
router.get('/provider-info', async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;

    // 회사 공통 사업자번호 + 현금영수증 발행방법 이미지 (항상 반환 — 설정탭 프리필·현영 안내 공용)
    let companyBusinessNo = '';
    // 채널 목록은 utils/cashReceiptChannels 단일 출처 — 채널을 늘려도 여기는 안 고친다.
    const cashReceiptGuides = {};
    for (const c of CASH_RECEIPT_CHANNELS) cashReceiptGuides[c.key] = '';
    try {
      const { rows: sRows } = await pool.query(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [['company_business_no', ...CASH_RECEIPT_SETTING_KEYS]]
      );
      for (const r of sRows) {
        if (r.key === 'company_business_no') { companyBusinessNo = r.value || ''; continue; }
        const hit = CASH_RECEIPT_CHANNELS.find(c => cashReceiptSettingKey(c.key) === r.key);
        if (hit) cashReceiptGuides[hit.key] = r.value || '';
      }
    } catch (_) { /* app_settings 없을 수 있음 — 무시 */ }

    let providerMemo = '';
    let incomeType = '';
    if (sheetId && tabName) {
      const { rows } = await pool.query(
        'SELECT provider_memo, income_type FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
        [sheetId, tabName]
      );
      providerMemo = rows[0]?.provider_memo || '';
      incomeType   = rows[0]?.income_type   || '';
    }

    // ★ D안 ③(제출 화면 재안내)용 — 라벨 붙은 배열(등록된 이미지만). 채널 라벨을 프론트에
    //   사본으로 두지 않기 위해 서버가 표(CASH_RECEIPT_CHANNELS) 그대로 내려준다.
    const cashReceiptGuideList = CASH_RECEIPT_CHANNELS
      .filter(c => cashReceiptGuides[c.key])
      .map(c => ({ key: c.key, label: c.label, imageUrl: cashReceiptGuides[c.key] }));
    res.json({ ok: true, providerMemo, incomeType, companyBusinessNo, cashReceiptGuides, cashReceiptGuideList });
  } catch (err) {
    next(err);
  }
});
_handlers.providerInfo = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 270)

// ═══════════════════════════════════════════════════════════
// POST /api/tab/company-business-no — 회사 공통 사업자번호 설정 (관리자)
// Body: { businessNo }
// ═══════════════════════════════════════════════════════════
// ★ authMiddleware 필수 — adminOrMasterMiddleware는 authMiddleware가 세팅한 req.admin을 읽는다.
//   빠뜨리면 req.admin이 undefined라 **마스터를 포함해 아무도** 저장할 수 없다(전원 403).
router.post('/company-business-no', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const businessNo = String(req.body?.businessNo ?? '').trim();
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('company_business_no', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [businessNo]
    );
    logger.info(`[tabconfig] 회사 사업자번호 설정: ${businessNo || '(공란)'}`);
    res.json({ ok: true, businessNo });
  } catch (err) {
    next(err);
  }
});
_handlers.companyBusinessNo = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 270)

// ═══════════════════════════════════════════════════════════
// POST /api/tab/cash-receipt-guide — 현금영수증 발행방법 이미지 설정 (관리자)
// Body: { channel, imageUrl }  — ''=제거
//   channel 허용값은 utils/cashReceiptChannels 단일 출처(coupang·naver·oliveyoung·kakao).
//   회사 공통 1회 등록. 현영 탭 공고의 work-detail(cashReceipt)이 채널에 맞는 이미지를 리뷰어에게 노출.
//   imageUrl은 guide-image 프록시/https 절대 URL만(자유 문자열 저장 방지 — 리뷰어 화면에 <img src>로 나감).
// ═══════════════════════════════════════════════════════════
// ★ authMiddleware 필수 — 위 company-business-no 주석과 같은 이유(빠지면 전원 403)
router.post('/cash-receipt-guide', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const channel = String(req.body?.channel || '');
    // ★ 화이트리스트 — 목록에 없는 키를 받으면 임의 app_settings 키가 생성된다.
    if (!isCashReceiptChannelKey(channel)) {
      return res.status(400).json({
        ok: false,
        error: `channel은 ${CASH_RECEIPT_CHANNELS.map(c => c.key).join(', ')} 중 하나여야 합니다.`,
      });
    }
    const imageUrl = String(req.body?.imageUrl ?? '').trim();
    if (imageUrl && !/^https:\/\/\S+$/i.test(imageUrl)) {
      return res.status(400).json({ ok: false, error: 'imageUrl은 https 절대 URL이어야 합니다(비우면 제거).' });
    }
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [cashReceiptSettingKey(channel), imageUrl]
    );
    logger.info(`[tabconfig] 현금영수증 발행방법 이미지(${cashReceiptChannelLabel(channel)}): ${imageUrl ? '설정' : '제거'}`);
    res.json({ ok: true, channel, imageUrl });
  } catch (err) {
    next(err);
  }
});
_handlers.cashReceiptGuide = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 270)

// GET /api/tab/stats(작업별 상세 통계 — GAS getCampaignStats 시절) 은 2026-10-04 제거 — 결정 186 94번(화면 호출 0 · 9/2 이후 호출 0).

// (POST /reset-all — 검색 색인·탭 설정·캠페인·마감 기록 전체 DELETE, 게이트 authMiddleware 뿐 → 2026-09-28 제거 · 결정 186 62번)

// ═══════════════════════════════════════════════════════════
// ★ 옵션(Option) 기능 — 시트 헤더 분석 + 옵션 컬럼 관리
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// GET /api/tab/option-column-audit — 연결 탭의 옵션 컬럼 실태 (모집공고 게시 전 자동점검용)
//
// 왜: 시트의 '옵션' 컬럼은 두 종류다.
//   ㉮ 상품옵션 — 리뷰어 선택값을 기입해야 하는 칸(관리자가 tab_configs.option_columns 로 지정)
//   ㉯ 작업옵션(리뷰형태) — 관리자가 미리 적어둔 '텍스트/포토리뷰' 작업지시. 시스템이 쓰면 안 되는 칸.
//   공고 옵션명이 ㉯ 칸의 값과 어긋나면 제출 때 그 칸이 덮이는 사고가 났다(#417 배경).
//   여기서는 **경고 재료만** 돌려주고 판단·표시는 프론트가 한다(차단 아님).
//
// ★ 시트 재읽기 0 — RAW 미러(raw_sheet_rows)만 조회한다(쿼터 무영향, describeTabDates 선례).
// ★ 읽기 전용·fail-soft — 실패해도 공고 발행은 막지 않는다({ ok:false, reason }).
// ═══════════════════════════════════════════════════════════
const _OPT_AUDIT_HEADER_SCAN_ROWS = 30;
const _OPT_AUDIT_MAX_VALUES = 30;

router.get('/option-column-audit', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  const { sheetId, tabName } = req.query;
  const gid = String(req.query.gid || '');
  const bail = (reason) => res.json({ ok: false, reason, columns: [] });
  try {
    if (!sheetId || !gid) return bail('no_tab');   // gid 없으면 동명탭 오조회 위험 → 판정 포기

    const { detectSheetHeader } = require('../utils/sheetHeader');
    const head = await pool.query(
      `SELECT row_index, cells FROM raw_sheet_rows
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index <= ${_OPT_AUDIT_HEADER_SCAN_ROWS}
        ORDER BY row_index`,
      [sheetId, gid]
    );
    if (!head.rows.length) return bail('no_mirror');   // RAW 미러가 아직 이 탭을 못 봄
    const det = detectSheetHeader(head.rows.map(r => (Array.isArray(r.cells) ? r.cells : [])));
    const headers = det.headers || [];
    if (!headers.length || det.headerRowIndex == null) return bail('no_header');
    const headerRowNo = head.rows[det.headerRowIndex - 1].row_index;

    // 기입 대상 판정은 orderLedger 매퍼와 **같은 규칙**이어야 한다(점검과 실제 쓰기가 갈리면 무의미).
    const optCols = [];
    headers.forEach((h, i) => {
      const key = String(h || '').toLowerCase().trim();
      if (key.includes('옵션') || key.includes('option')) optCols.push({ name: headers[i], colIndex: i });
    });
    if (!optCols.length) return res.json({ ok: true, reason: 'no_option_column', columns: [] });

    // 관리자가 '상품옵션'으로 지정한 컬럼(리뷰어 옵션 피커용 설정) — 지정 = ㉮ 로 본다.
    const { rows: tcRows } = await pool.query(
      'SELECT option_columns, option_columns_map FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName || '']
    );
    const designated = new Set();
    const addDesignated = (list) => (list || []).forEach(c => { if (c && c.name) designated.add(String(c.name).trim()); });
    addDesignated(tcRows[0] && tcRows[0].option_columns);
    Object.values((tcRows[0] && tcRows[0].option_columns_map) || {}).forEach(addDesignated);

    for (const col of optCols) {
      // ★★ `::int` 필수 — 빼면 jsonb 배열에 텍스트 키 조회가 되어 전 행 NULL(CLAUDE.md 참조).
      const { rows } = await pool.query(
        `SELECT cells->>$3::int AS v FROM raw_sheet_rows
          WHERE sheet_id = $1 AND tab_gid = $2 AND row_index > $4
          ORDER BY row_index`,
        [sheetId, gid, String(col.colIndex), headerRowNo]
      );
      const vals = rows.map(r => String(r.v == null ? '' : r.v).trim()).filter(Boolean);
      const uniq = [...new Set(vals)];
      col.filledRows = vals.length;
      col.distinctCount = uniq.length;
      col.values = uniq.slice(0, _OPT_AUDIT_MAX_VALUES);
      col.designated = designated.has(String(col.name).trim());
    }
    return res.json({ ok: true, reason: 'ok', columns: optCols });
  } catch (err) {
    logger.warn(`[option-column-audit] 실패(무시): ${err.message}`);
    return bail('error');
  }
});

// GET /api/tab/product-choices — 구매양식 링크 화면의 「구매한 상품」 선택지 (인증 불필요, 2026-10-02 B안)
//   상품이 2종 이상인 무시트 작업만 값을 돌려준다(아니면 []). 상품명은 공고에 이미 공개된 값이다.
//   ★ 판정·순서는 sheetlessOrder.listProductChoices 단일 출처 — 제출 검증도 같은 함수를 쓴다.
//   ★ 조회 실패도 [] — 화면은 종전대로(선택 칸 없이) 동작한다.
router.get('/product-choices', async (req, res) => {
  const sheetId = String(req.query.sheetId || '').trim();
  const tabName = String(req.query.tabName || '').trim();
  if (!sheetId || !tabName) return res.json({ ok: true, products: [] });
  const { listProductChoices } = require('../services/sheetlessOrder.service');
  const products = await listProductChoices(pool, sheetId, tabName);
  res.json({ ok: true, products });
});

// GET /api/tab/reviewer-options — 리뷰어용 옵션 데이터 조회 (인증 불필요)
// Query: sheetId, tabName, (optional) name, (optional) gid, (optional) round
// ★ name 없이 호출 시 → 옵션 컬럼 헤더만 반환 (headersOnly 모드)
// ★ name 있을 시 → 해당 리뷰어 행의 옵션 데이터 반환
router.get('/reviewer-options', async (req, res, next) => {
  try {
    const { sheetId, tabName, name, gid } = req.query;
    let round = req.query.round || '';
    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId, tabName이 필요합니다.' });
    }

    // 1) 저장된 옵션 컬럼 조회 (★ round별 option_columns_map 우선)
    const { rows: tcRows } = await pool.query(
      'SELECT option_columns, option_columns_map, closed_rounds, archived_rounds, distinct_values_cache FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );
    let optionColumns = [];
    const ocMap = tcRows[0]?.option_columns_map || {};

    // ★★★ round 미지정 시 최신 활성 차수 자동 감지 ★★★
    if (!round && Object.keys(ocMap).length > 0) {
      const closedRounds = (tcRows[0]?.closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
      const archivedRounds = (tcRows[0]?.archived_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
      const excludeSet = new Set([...closedRounds, ...archivedRounds]);
      
      // ocMap의 키(차수)들 중 마감/보관되지 않은 가장 마지막(최신) 차수 선택
      const activeRounds = Object.keys(ocMap)
        .filter(r => !excludeSet.has(r))
        .sort((a, b) => {
          // "1-4차" → 숫자 추출 후 비교
          const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
          const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
          return numA - numB;
        });
      
      if (activeRounds.length > 0) {
        round = activeRounds[activeRounds.length - 1]; // 최신(마지막) 활성 차수
      }
    }

    // ★★★ round 미지정 + ocMap 비어있는 경우: review_index에서 최신 활성 차수 조회 ★★★
    if (!round && name) {
      try {
        const closedRounds = (tcRows[0]?.closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
        const archivedRounds = (tcRows[0]?.archived_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
        const excludeSet = new Set([...closedRounds, ...archivedRounds]);

        const { rows: riRounds } = await pool.query(
          `SELECT DISTINCT round FROM review_index 
           WHERE sheet_id = $1 AND tab_name = $2 AND round IS NOT NULL AND round != ''
           ORDER BY round`,
          [sheetId, tabName]
        );
        const allRounds = riRounds.map(r => r.round);
        const activeRiRounds = allRounds
          .filter(r => !excludeSet.has(r))
          .sort((a, b) => {
            const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
            const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
            return numA - numB;
          });
        if (activeRiRounds.length > 0) {
          round = activeRiRounds[activeRiRounds.length - 1];
        }
      } catch (_) { /* 무시 */ }
    }

    if (round && ocMap[round]) {
      // ★ 특정 차수 지정 → 해당 차수의 옵션만 사용
      optionColumns = ocMap[round];
    } else if (round && !ocMap[round] && Object.keys(ocMap).length > 0) {
      // ★ round는 감지됐지만 해당 차수의 옵션 설정이 없는 경우 → 가장 가까운 활성 차수의 옵션 사용
      // (round 변수는 유지하여 distinct values 필터링에 활용)
      const roundNum = parseInt(round.replace(/[^0-9]/g, '')) || 0;
      const closedRounds = (tcRows[0]?.closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
      const archivedRounds = (tcRows[0]?.archived_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
      const excludeSet = new Set([...closedRounds, ...archivedRounds]);
      const sortedKeys = Object.keys(ocMap)
        .filter(r => !excludeSet.has(r))
        .sort((a, b) => {
          const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
          const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
          return Math.abs(numA - roundNum) - Math.abs(numB - roundNum);
        });
      if (sortedKeys.length > 0) {
        optionColumns = ocMap[sortedKeys[0]]; // 가장 가까운 차수의 옵션 설정 사용
      } else {
        optionColumns = tcRows[0]?.option_columns || [];
      }
    } else if (!round && Object.keys(ocMap).length > 0) {
      // ★ 차수 미지정 + option_columns_map에 데이터 존재 → 모든 차수 합집합(union)
      const seen = new Set();
      for (const cols of Object.values(ocMap)) {
        for (const col of (cols || [])) {
          const key = `${col.name}::${col.colIndex}`;
          if (!seen.has(key)) { seen.add(key); optionColumns.push(col); }
        }
      }
    } else {
      // ★ fallback: 기존 option_columns (하위 호환)
      optionColumns = tcRows[0]?.option_columns || [];
    }
    if (optionColumns.length === 0) {
      return res.json({ ok: true, options: null, message: '설정된 옵션이 없습니다.' });
    }

    // ★ name 없이 호출 → 옵션 컬럼 헤더만 반환 (headersOnly 모드)
    if (!name) {
      return res.json({
        ok: true,
        headersOnly: true,
        optionColumns: optionColumns.map(c => c.name),
        matched: 0,
        rows: [],
        optionLabels: [],
      });
    }

    // ★★★ 캐시 우선 조회: distinct_values_cache에서 즉시 반환 (시트 읽기 없이 ~0.2초) ★★★
    const dvCache = tcRows[0]?.distinct_values_cache || {};
    const cachedDV = round ? dvCache[round] : null;
    // ★ 캐시 히트: 해당 차수의 distinctValues가 캐시에 있으면 즉시 반환
    //   (사용자 이름 매칭은 생략 — matched=0으로 처리. 대부분의 구매양식 접속 케이스)
    if (cachedDV && Object.keys(cachedDV).length > 0) {
      return res.json({
        ok: true,
        optionColumns: optionColumns.map(c => c.name),
        matched: 0,
        rows: [],
        optionLabels: [],
        distinctValues: cachedDV,
        cached: true,
      });
    }

    // 2) 시트 전체 데이터 읽기 (캐시 미스 시에만)
    const range = `'${tabName.replace(/'/g, "''")}'`;
    const opts = gid ? { gid } : {};
    let values;
    try {
      values = await throttledCall(() => readSheet(sheetId, range, opts));
    } catch (sheetErr) {
      logger.error('[reviewer-options] 시트 읽기 실패:', sheetErr.message);
      return res.json({ error: '시트 읽기 실패: ' + sheetErr.message });
    }

    if (!values || values.length === 0) {
      return res.json({ ok: true, options: null });
    }

    // 3) 헤더 행 찾기
    const DATA_TAB_KW = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];
    const NAME_KW = ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'];
    const ROUND_KW = ['회차', '차수', 'round'];
    let headerRowIdx = -1;

    for (let i = 0; i < Math.min(values.length, 50); i++) {
      const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
      if (cells.some(c => DATA_TAB_KW.some(k => c.includes(k)))) {
        headerRowIdx = i;
        break;
      }
    }
    if (headerRowIdx < 0) {
      return res.json({ ok: true, options: null });
    }

    const headers = values[headerRowIdx].map(h => String(h || '').trim());
    const dataRows = values.slice(headerRowIdx + 1);

    const nameColIdx = headers.findIndex(h => NAME_KW.some(k => h.includes(k)));
    const roundColIdx = headers.findIndex(h => ROUND_KW.some(k => h.toLowerCase().includes(k.toLowerCase())));

    // 4) 옵션 컬럼 매핑
    const optColMap = [];
    for (const oc of optionColumns) {
      let idx = oc.colIndex;
      if (idx === undefined || idx === null || headers[idx] !== oc.name) {
        idx = headers.findIndex(h => h === oc.name);
      }
      if (idx >= 0) optColMap.push({ name: oc.name, idx });
    }
    if (optColMap.length === 0) {
      return res.json({ ok: true, options: null });
    }

    // 5) 해당 리뷰어 이름으로 행 찾기
    const searchName = name.trim();
    const matchedRows = [];
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowName = nameColIdx >= 0 ? String(row[nameColIdx] || '').trim() : '';
      if (rowName !== searchName) continue;

      // round 필터
      if (round && roundColIdx >= 0) {
        const rowRound = String(row[roundColIdx] || '').trim();
        if (rowRound !== round) continue;
      }

      const options = {};
      for (const { name: colName, idx } of optColMap) {
        options[colName] = String(row[idx] !== undefined ? row[idx] : '').trim();
      }
      matchedRows.push({
        rowIndex: headerRowIdx + 1 + i + 1,
        round: roundColIdx >= 0 ? String(row[roundColIdx] || '').trim() : '',
        options,
      });
    }

    // 옵션 문자열 생성: "키워드: 끈나시 / 컬러: 노랑색"
    const optionLabels = matchedRows.map(r => {
      return optColMap.map(c => {
        const v = r.options[c.name];
        return v ? `${c.name}: ${v}` : '';
      }).filter(Boolean).join(' / ');
    });

    // ★ matched=0 → 각 옵션 컬럼의 고유값(distinct values)을 추출하여 반환
    //   → 프론트엔드에서 드롭다운 선택지로 표시
    //   ★★★ round 필터 적용: 해당 차수의 행만 대상으로 고유값 추출
    let distinctValues = null;
    if (matchedRows.length === 0) {
      distinctValues = {};
      for (const { name: colName, idx } of optColMap) {
        const valSet = new Set();
        for (const row of dataRows) {
          // round 필터: 차수가 지정되어 있으면 해당 차수의 행만 사용
          if (round && roundColIdx >= 0) {
            const rowRound = String(row[roundColIdx] || '').trim();
            if (rowRound !== round) continue;
          }
          const v = String(row[idx] !== undefined ? row[idx] : '').trim();
          if (v) valSet.add(v);
        }
        distinctValues[colName] = [...valSet];
      }

      // ★★★ 캐시 갱신: 시트를 읽었으므로 결과를 DB에 캐시 (비동기, 응답 차단 안 함)
      if (round && distinctValues) {
        pool.query(
          `UPDATE tab_configs
           SET distinct_values_cache = COALESCE(distinct_values_cache, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb),
               updated_at = NOW()
           WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, tabName, round, JSON.stringify(distinctValues)]
        ).catch(err => logger.warn('[reviewer-options] 캐시 갱신 실패:', err.message));
      }
    }

    res.json({
      ok: true,
      optionColumns: optColMap.map(c => c.name),
      matched: matchedRows.length,
      rows: matchedRows,
      optionLabels,  // 리뷰어 화면에 직접 표시할 문자열 배열
      ...(distinctValues && { distinctValues }),  // matched=0일 때만 포함
    });
  } catch (err) {
    next(err);
  }
});

// ★ 이름을 빼거나 바꾸면 trackB 가 기동 시 바로 실패한다(fail-closed) — 옛 공개 경로를 지워도 Track B 는 그대로다.
router.handlers = Object.freeze(_handlers);

module.exports = router;
