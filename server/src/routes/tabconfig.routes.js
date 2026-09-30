const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware, internalOnlyMiddleware } = require('../middleware/auth.middleware');
const { tabConfigWriteScopeMiddleware } = require('../middleware/tabConfigScope.middleware');
const { readSheet } = require('../services/sheets.service');
const { getTabRegistrationMode } = require('../utils/tabRegistration');
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

// ═══════════════════════════════════════════════════════════
// 옵션(Option) 기능용 시스템 헤더 키워드 목록
// indexBuilder.service.js의 parseTabRows에서 사용하는 시스템 컬럼 키워드를 통합
// 이 목록에 매칭되는 헤더는 "시스템 헤더"로 분류하여 옵션 후보에서 제외
// ═══════════════════════════════════════════════════════════
const SYSTEM_HEADER_KEYWORDS = [
  // 이름/수취인 계열
  '수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명', '받는분',
  // 연락처 계열
  '연락처', '전화번호', '핸드폰', '휴대폰', 'phone',
  // 주소 계열
  '주소', '우편번호', '배송지', '배송주소', '상세주소',
  // 제출/리뷰 계열
  '리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰',
  // URL 계열
  '상품url', '제품url', '상품링크', 'url', '링크',
  // 날짜 계열
  '시작일', '구매일', '주문일', '배정일', '종료일', '마감일', '완료일', '제출마감', '날짜',
  // 차수 계열
  '회차', '차수', 'round',
  // 입금 계열
  '입금', '입금완료', '입금확인', '입금여부', '페이백', '입금명', '입금자', '입금자명',
  '결제금액', '결제금', '결제일', '결제수단',
  // 기타 시스템 계열
  '비고', '메모', '주문번호', '송장번호', '운송장', '택배사', 'InAd',
  '번호', '리뷰제출일',
  // 담당/계정/명단 계열
  '담당', '은행', 'id', '아이디', '명단',
  // 데이터탭 판별 키워드
  '수취인명',
];

// 시스템 헤더 판별 함수: 헤더가 시스템 키워드에 매칭되는지 확인
function _isSystemHeader(header) {
  const h = header.trim().toLowerCase();
  if (!h) return true; // 빈 헤더는 시스템으로 취급
  return SYSTEM_HEADER_KEYWORDS.some(k => h.includes(k.toLowerCase()));
}

// POST /api/tab/config — 탭 설정 저장/수정 (GAS: setTabConfig)
router.post('/config', authMiddleware, internalOnlyMiddleware, tabConfigWriteScopeMiddleware, async (req, res, next) => {
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

    // undefined 필드 제거 (기존값 보존)
    const updateEntries = Object.entries(fields).filter(([, v]) => v !== undefined);

    if (updateEntries.length === 0) {
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
    res.json({ ok: true, tabName, sheetId });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/tab/reopen-slots — 기존 완료행 보완 재오픈
//
// 탭에 새 캡처 슬롯(예: 현금영수증)을 추가했을 때, 이미 제출완료
// (is_submitted=TRUE)된 행 중 "필요 슬롯을 다 채우지 못한" 행을 다시 열어
// 리뷰어 검색에 재노출(is_submitted=FALSE)하고 index_master.submitted_count를 차감한다.
//   - 필요 슬롯이 단일('review')뿐이면(=다중 슬롯 미설정) 아무 것도 하지 않음.
//   - dryRun=true 이면 변경 없이 대상 건수만 반환.
//   - 판정: review_submissions에서 (필요 슬롯에 속한) distinct slot_key 수 < 필요 슬롯 수.
//     → 구버전(원장 없음) 완료행도 재오픈됨(의도된 동작: 새 요구를 소급 적용).
// ═══════════════════════════════════════════════════════════
router.post('/reopen-slots', authMiddleware, async (req, res, next) => {
  try {
    const sheetId = (req.body.sheetId || '').trim();
    const tabName = (req.body.tabName || '').trim();
    const dryRun = !!req.body.dryRun;
    if (!sheetId || !tabName) return res.json({ ok: false, error: 'sheetId, tabName이 필요합니다.' });

    // 탭의 필요 슬롯 확인
    const { rows: cfgRows } = await pool.query(
      'SELECT capture_slots FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [sheetId, tabName]
    );
    const cs = cfgRows[0]?.capture_slots;
    const required = (Array.isArray(cs) && cs.length)
      ? cs.map(s => s && s.key).filter(Boolean)
      : ['review'];
    const isMultiSlot = !(required.length === 1 && required[0] === 'review');
    if (!isMultiSlot) {
      return res.json({ ok: true, reopened: 0, candidates: 0, dryRun, note: '다중 캡처 슬롯이 설정되지 않아 재오픈 대상이 없습니다.' });
    }

    // 미충족 완료행 판정 조건 (공통)
    const coverCond = `
      ( SELECT COUNT(DISTINCT rs.slot_key)
          FROM review_submissions rs
         WHERE rs.sheet_id = ri.sheet_id AND rs.tab_name = ri.tab_name
           AND rs.row_index = ri.row_index AND rs.slot_key = ANY($3) ) < $4`;

    if (dryRun) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt
           FROM review_index ri
          WHERE ri.sheet_id = $1 AND ri.tab_name = $2 AND ri.is_submitted = TRUE
            AND ${coverCond}`,
        [sheetId, tabName, required, required.length]
      );
      return res.json({ ok: true, dryRun: true, candidates: rows[0]?.cnt || 0, reopened: 0 });
    }

    // 실제 재오픈
    const { rows: reopenedRows } = await pool.query(
      `WITH reopened AS (
         UPDATE review_index ri
            SET is_submitted = FALSE, built_at = NOW()
          WHERE ri.sheet_id = $1 AND ri.tab_name = $2 AND ri.is_submitted = TRUE
            AND ${coverCond}
          RETURNING ri.row_index
       ), participant_reset AS (
         UPDATE campaign_participants cp
            SET is_submitted = FALSE,
                updated_at = NOW(),
                updated_by = 'reopen-slots'
           FROM reopened r
          WHERE cp.sheet_id = $1 AND cp.tab_name = $2 AND cp.seq = r.row_index
            AND cp.active = TRUE AND cp.deleted_at IS NULL
          RETURNING cp.seq
       )
       SELECT row_index FROM reopened`,
      [sheetId, tabName, required, required.length]
    );
    const reopened = reopenedRows.length;

    // index_master.submitted_count 차감 (0 미만 방지)
    if (reopened > 0) {
      try {
        await pool.query(
          `UPDATE index_master
              SET submitted_count = GREATEST(0, submitted_count - $3)
            WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, tabName, reopened]
        );
      } catch (cntErr) {
        logger.warn(`[reopen-slots] submitted_count 차감 실패 (무시): ${cntErr.message}`);
      }
    }

    logger.info(`[reopen-slots] ${sheetId}/${tabName} — ${reopened}개 행 재오픈 (필요 슬롯: ${required.join(',')})`);
    return res.json({ ok: true, dryRun: false, reopened, candidates: reopened });
  } catch (err) {
    logger.error(`[reopen-slots] ${err.message}`);
    return res.json({ ok: false, error: err.message });
  }
});

// GET /api/tab/config — 탭 설정 조회 (세부목록 전체 or 단건)
router.get('/config', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;

    let sql = `SELECT * FROM tab_configs`;
    const params = [];
    const where = [];

    if (sheetId) { where.push(`sheet_id = $${params.length + 1}`); params.push(sheetId); }
    if (tabName) { where.push(`tab_name = $${params.length + 1}`); params.push(tabName); }

    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY updated_at DESC';

    const { rows } = await pool.query(sql, params);

    // detailMap 형식으로 변환 (GAS 호환)
    const detailMap = {};
    rows.forEach(r => {
      const key = `${r.sheet_id}||${r.tab_name}`;
      detailMap[key] = {
        manager: r.manager,
        timeRange: r.time_range,
        taekhap: r.taekhap,
        reviewType: r.review_type,
        paymentType: r.payment_type,
        displayName: r.display_name,
        isClosed: r.is_closed,
        folderUrl: r.folder_url,
        captureFolderUrl: r.capture_folder_url,
        isBulk: r.is_bulk,
        deliveryType: r.delivery_type,
        round: r.round,
        ncMode: r.nc_mode,
        depositName: r.deposit_name,
        transferBank: r.transfer_bank,
        incomeType: r.income_type,
        providerMemo: r.provider_memo,
        campaignName: r.campaign_name,
        sheetUrl: r.sheet_url,
        captureSlots: Array.isArray(r.capture_slots) && r.capture_slots.length ? r.capture_slots : null,
      };
    });

    res.json({ ok: true, configs: rows, detailMap });
  } catch (err) {
    next(err);
  }
});

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

// POST /api/tab/closed — 마감 설정 (GAS: setClosed)
// ★ 차수 단위 마감 지원: items[].round 가 있으면 closed_rounds에 추가/제거
// round가 없으면 기존처럼 탭 전체 is_closed 토글
router.post('/closed', authMiddleware, async (req, res, next) => {
  try {
    // 두 가지 형태 지원: { sheetId, tabs } 또는 { items }
    const items = req.body.items || req.body.tabs;
    const topSheetId = req.body.sheetId;

    if (!Array.isArray(items)) {
      return res.json({ error: 'items(또는 tabs) 배열이 필요합니다.' });
    }

    for (const t of items) {
      const sid = t.sheetId || topSheetId;
      if (!sid || !t.tabName) continue;

      if (t.round) {
        // ── 차수 단위 마감/해제 ──
        const { rows } = await pool.query(
          'SELECT closed_rounds FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
          [sid, t.tabName]
        );
        if (rows.length === 0) continue;

        const existing = (rows[0].closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
        const roundSet = new Set(existing);

        if (t.isClosed) {
          roundSet.add(t.round);
        } else {
          roundSet.delete(t.round);
        }

        const newClosedRounds = Array.from(roundSet).join(',');

        await pool.query(
          'UPDATE tab_configs SET closed_rounds = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
          [newClosedRounds, sid, t.tabName]
        );
      } else {
        // ── 기존 탭 전체 마감/해제 ──
        await pool.query(
          'UPDATE tab_configs SET is_closed = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
          [Boolean(t.isClosed), sid, t.tabName]
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/tab/options — 탭 옵션 목록 (GAS: getTabOptions)
router.get('/options', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT sheet_id AS "sheetId", tab_name AS "tabName",
             campaign_name AS "campaignName", display_name AS "displayName"
      FROM tab_configs
      WHERE is_closed = FALSE
      ORDER BY tab_name
    `);
    res.json({ ok: true, options: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/tab/end-date — 탭 종료일 조회 (GAS: getTabEndDate)
router.get('/end-date', async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId와 tabName이 필요합니다.' });

    const { rows } = await pool.query(
      `SELECT MAX(end_date) AS "endDate" FROM review_index
       WHERE sheet_id = $1 AND tab_name = $2`,
      [sheetId, tabName]
    );
    res.json({ ok: true, endDate: rows[0]?.endDate || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/tab/stats — 탭별 상세 통계 (GAS: getCampaignStats)
router.get('/stats', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        im.sheet_id AS "sheetId",
        im.tab_name AS "tabName",
        im.campaign_name AS "campaignName",
        im.row_count AS "totalCount",
        im.submitted_count AS "submittedCount",
        im.status,
        tc.manager,
        tc.review_type AS "reviewType",
        tc.is_closed AS "isClosed"
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      ORDER BY im.built_at DESC NULLS LAST
    `);
    res.json({ ok: true, stats: rows });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/tab/dashboard — 탭설정 현황 전체 조회
// 모든 tab_configs + index_master 통계를 JOIN하여 반환
// ═══════════════════════════════════════════════════════════
router.get('/dashboard', authMiddleware, async (req, res, next) => {
  try {
    // 탭설정 + 인덱스 통계 + 입금 집계 JOIN
    const { rows } = await pool.query(`
      SELECT
        tc.sheet_id, tc.tab_name, tc.sheet_url, tc.campaign_name,
        COALESCE(tc.tab_gid, im.tab_gid) AS tab_gid,
        tc.manager, tc.time_range, tc.taekhap, tc.review_type,
        tc.payment_type, tc.display_name, tc.display_name_map, tc.option_columns, tc.option_columns_map, tc.is_closed,
        tc.folder_url, tc.capture_folder_url, tc.is_bulk, tc.delivery_type,
        tc.round, tc.nc_mode, tc.deposit_name, tc.transfer_bank,
        tc.income_type, tc.provider_memo, tc.updated_at, tc.closed_rounds, tc.round_meta,
        tc.capture_slots,
        im.row_count, im.submitted_count, im.status AS index_status,
        im.built_at AS index_built_at, im.checksum,
        im.detect_drift,
        COALESCE(paid.paid_count, 0) AS paid_count
      FROM tab_configs tc
      LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      LEFT JOIN (
        SELECT sheet_id, tab_name,
               COUNT(*) FILTER (WHERE is_submitted2 = 'PAID') AS paid_count
        FROM review_index
        GROUP BY sheet_id, tab_name
      ) paid ON tc.sheet_id = paid.sheet_id AND tc.tab_name = paid.tab_name
      WHERE NOT EXISTS (
        SELECT 1 FROM index_master_archive ima
        WHERE ima.sheet_id = tc.sheet_id AND (ima.tab_name = tc.tab_name OR (ima.tab_gid IS NOT NULL AND ima.tab_gid = COALESCE(tc.tab_gid, im.tab_gid)))
      )
      ORDER BY tc.campaign_name NULLS LAST, tc.tab_name
    `);

    // ★ 차수별 집계: review_index에서 round 값이 있는 행을 탭별로 그룹핑
    // closed_rounds + archived_rounds에 포함된 차수는 제외
    const { rows: roundRows } = await pool.query(`
      SELECT ri.sheet_id, ri.tab_name, ri.round,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE ri.is_submitted) AS submitted,
             COUNT(*) FILTER (WHERE ri.is_submitted2 = 'PAID') AS paid
      FROM review_index ri
      INNER JOIN index_master im ON ri.sheet_id = im.sheet_id AND ri.tab_name = im.tab_name AND im.status = 'active'
      INNER JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.round IS NOT NULL AND ri.round != ''
        AND (tc.closed_rounds IS NULL OR tc.closed_rounds = '' OR NOT (ri.round = ANY(string_to_array(tc.closed_rounds, ','))))
        AND (tc.archived_rounds IS NULL OR tc.archived_rounds = '' OR NOT (ri.round = ANY(string_to_array(tc.archived_rounds, ','))))
      GROUP BY ri.sheet_id, ri.tab_name, ri.round
      ORDER BY ri.sheet_id, ri.tab_name, ri.round
    `);

    // 탭별 roundList 맵 구성
    const roundMap = {}; // "sheet_id||tab_name" → [{ round, total, submitted }]
    for (const rr of roundRows) {
      const key = `${rr.sheet_id}||${rr.tab_name}`;
      if (!roundMap[key]) roundMap[key] = [];
      roundMap[key].push({
        round: rr.round,
        total: parseInt(rr.total) || 0,
        submitted: parseInt(rr.submitted) || 0,
        paid: parseInt(rr.paid) || 0,
      });
    }
    // roundList 숫자순 정렬
    for (const key of Object.keys(roundMap)) {
      roundMap[key].sort((a, b) => {
        const numA = parseInt(a.round.replace(/[^0-9]/g, '')) || 0;
        const numB = parseInt(b.round.replace(/[^0-9]/g, '')) || 0;
        return numA - numB;
      });
    }

    // 각 탭에 roundList 추가
    const tabsWithRounds = rows.map(r => {
      const key = `${r.sheet_id}||${r.tab_name}`;
      return {
        ...r,
        roundList: roundMap[key] || [],
      };
    });

    // 통계 계산
    const stats = {
      total: rows.length,
      active: rows.filter(r => !r.is_closed).length,
      closed: rows.filter(r => r.is_closed).length,
      indexed: rows.filter(r => r.index_status === 'active').length,
      noManager: rows.filter(r => !r.manager).length,
      noFolder: rows.filter(r => !r.folder_url).length,
      noCaptureFolder: rows.filter(r => !r.capture_folder_url).length,
      totalRows: rows.reduce((s, r) => s + (r.row_count || 0), 0),
      totalSubmitted: rows.reduce((s, r) => s + (r.submitted_count || 0), 0),
      totalPaid: rows.reduce((s, r) => s + (parseInt(r.paid_count, 10) || 0), 0),
    };

    // 캠페인별 그룹핑
    const campaigns = {};
    rows.forEach(r => {
      const camp = r.campaign_name || '(미지정)';
      if (!campaigns[camp]) campaigns[camp] = { tabs: 0, active: 0, closed: 0 };
      campaigns[camp].tabs++;
      if (r.is_closed) campaigns[camp].closed++;
      else campaigns[camp].active++;
    });

    // 담당자별 통계
    const managers = {};
    rows.forEach(r => {
      const mgr = r.manager || '(미지정)';
      if (!managers[mgr]) managers[mgr] = 0;
      managers[mgr]++;
    });

    // 마지막 동기화 시각
    const { rows: syncRows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'last_tab_sync'`
    );
    const lastSync = syncRows[0]?.value || null;

    res.json({
      ok: true,
      stats,
      campaigns,
      managers,
      lastSync,
      // 탭 등록 단일경로 정책 모드 — 'order'면 프론트가 수동 등록 UI(작업시트추가)를 숨김
      tabRegistrationMode: getTabRegistrationMode(),
      tabs: tabsWithRounds,
    });
  } catch (err) {
    next(err);
  }
});
// (POST /reset-all — 검색 색인·탭 설정·캠페인·마감 기록 전체 DELETE, 게이트 authMiddleware 뿐 → 2026-09-28 제거 · 결정 186 62번)

// ═══════════════════════════════════════════════════════════
// GET /api/tab/col-prefs — 캠페인탭 관리 컬럼 표시/순서 설정 조회 (전역 공유)
// ═══════════════════════════════════════════════════════════
router.get('/col-prefs', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'tabDash_colPrefs'"
    );
    const prefs = rows[0]?.value ? JSON.parse(rows[0].value) : null;
    res.json({ ok: true, prefs });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/tab/col-prefs — 캠페인탭 관리 컬럼 표시/순서 설정 저장 (전역 공유)
// body: { prefs: { key: { show: bool, order: number }, ... } }
// ═══════════════════════════════════════════════════════════
router.post('/col-prefs', authMiddleware, async (req, res, next) => {
  try {
    const { prefs } = req.body;
    if (!prefs || typeof prefs !== 'object') {
      return res.status(400).json({ error: '컬럼 설정(prefs)이 필요합니다.' });
    }
    const value = JSON.stringify(prefs);
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('tabDash_colPrefs', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [value]
    );
    logger.info(`[col-prefs] 컬럼 설정 저장 by ${req.admin?.name || 'unknown'}: ${Object.keys(prefs).length}개 컬럼`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// ★ 옵션(Option) 기능 — 시트 헤더 분석 + 옵션 컬럼 관리
// ═══════════════════════════════════════════════════════════

// GET /api/tab/option-headers — 시트 헤더 읽기 + 시스템/옵션 후보 분류
// Query: sheetId, tabName, (optional) gid, (optional) round
router.get('/option-headers', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, gid, round } = req.query;
    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId와 tabName이 필요합니다.' });
    }

    // 1) 시트에서 헤더 행 읽기 (첫 50행 스캔하여 데이터 탭 헤더 찾기)
    const range = `'${tabName.replace(/'/g, "''")}'`;
    const opts = gid ? { gid } : {};
    let values;
    try {
      values = await throttledCall(() => readSheet(sheetId, range, opts));
    } catch (sheetErr) {
      logger.error('[option-headers] 시트 읽기 실패:', sheetErr.message);
      return res.json({ error: '시트 읽기 실패: ' + sheetErr.message });
    }

    if (!values || values.length === 0) {
      return res.json({ error: '시트에 데이터가 없습니다.' });
    }

    // 2) 헤더 행 탐색 (indexBuilder.parseTabRows와 동일한 로직)
    //    DATA_TAB_KEYWORDS 중 하나라도 포함된 첫 행을 헤더로 인식
    const DATA_TAB_KW = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];
    const HEADER_SCAN_LIMIT = 50;
    let headerRowIdx = -1;

    for (let i = 0; i < Math.min(values.length, HEADER_SCAN_LIMIT); i++) {
      const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
      const hasKeyword = cells.some(c => DATA_TAB_KW.some(k => c.includes(k)));
      if (hasKeyword) {
        headerRowIdx = i;
        break;
      }
    }

    if (headerRowIdx < 0) {
      return res.json({ error: '데이터 헤더 행을 찾을 수 없습니다. (첫 50행 내 수취인/이름 등 키워드 미발견)' });
    }

    const headers = values[headerRowIdx].map(h => String(h || '').trim());

    // 3) 시스템 vs 옵션 후보 분류
    const systemHeaders = [];
    const optionCandidates = [];

    headers.forEach((h, colIdx) => {
      if (!h) return; // 빈 헤더 무시
      const entry = { name: h, colIndex: colIdx };
      if (_isSystemHeader(h)) {
        systemHeaders.push({ ...entry, reason: 'system' });
      } else {
        optionCandidates.push(entry);
      }
    });

    // 4) 현재 저장된 option_columns 조회 (★ round별 option_columns_map 우선)
    const { rows: tcRows } = await pool.query(
      'SELECT option_columns, option_columns_map FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );
    let savedOptionColumns = [];
    if (round && tcRows[0]?.option_columns_map && tcRows[0].option_columns_map[round]) {
      savedOptionColumns = tcRows[0].option_columns_map[round];
    } else if (!round) {
      savedOptionColumns = tcRows[0]?.option_columns || [];
    }

    res.json({
      ok: true,
      headerRow: headerRowIdx + 1, // 1-based
      totalHeaders: headers.length,
      systemHeaders,
      optionCandidates,
      savedOptionColumns,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/tab/option-columns — 옵션 컬럼 선택 저장
// Body: { sheetId, tabName, optionColumns: [...], round (optional) }
// ★ round가 있으면 option_columns_map[round]에 저장, 없으면 option_columns에 저장
router.post('/option-columns', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, optionColumns, round } = req.body;
    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId와 tabName이 필요합니다.' });
    }
    if (!Array.isArray(optionColumns)) {
      return res.json({ error: 'optionColumns는 배열이어야 합니다.' });
    }

    if (round) {
      // ★ 차수별 저장: option_columns_map JSONB에 { round: optionColumns } 저장
      const colsJson = JSON.stringify(optionColumns);
      const result = await pool.query(
        `UPDATE tab_configs
         SET option_columns_map = COALESCE(option_columns_map, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb),
             updated_at = NOW()
         WHERE sheet_id = $1 AND tab_name = $2`,
        [sheetId, tabName, round, colsJson]
      );
      if (result.rowCount === 0) {
        await pool.query(
          `INSERT INTO tab_configs (sheet_id, tab_name, option_columns_map, updated_at)
           VALUES ($1, $2, jsonb_build_object($3::text, $4::jsonb), NOW())
           ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
             option_columns_map = COALESCE(tab_configs.option_columns_map, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb),
             updated_at = NOW()`,
          [sheetId, tabName, round, colsJson]
        );
      }
      logger.info(`[option-columns] 차수별 저장: sheetId=${sheetId} tab=${tabName} round=${round} cols=${optionColumns.length}개`);
      // ★ 옵션 컬럼 변경 시 해당 차수의 distinctValues 캐시 무효화
      pool.query(
        `UPDATE tab_configs
         SET distinct_values_cache = COALESCE(distinct_values_cache, '{}'::jsonb) - $3
         WHERE sheet_id = $1 AND tab_name = $2`,
        [sheetId, tabName, round]
      ).catch(err => logger.warn('[option-columns] 캐시 무효화 실패:', err.message));
      res.json({ ok: true, sheetId, tabName, round, optionColumns });
    } else {
      // 기존 방식: option_columns에 저장 (하위 호환)
      const result = await pool.query(
        `UPDATE tab_configs
         SET option_columns = $3::jsonb, updated_at = NOW()
         WHERE sheet_id = $1 AND tab_name = $2`,
        [sheetId, tabName, JSON.stringify(optionColumns)]
      );
      if (result.rowCount === 0) {
        await pool.query(
          `INSERT INTO tab_configs (sheet_id, tab_name, option_columns, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
             option_columns = $3::jsonb, updated_at = NOW()`,
          [sheetId, tabName, JSON.stringify(optionColumns)]
        );
      }
      logger.info(`[option-columns] 저장: sheetId=${sheetId} tab=${tabName} cols=${optionColumns.length}개`);
      res.json({ ok: true, sheetId, tabName, optionColumns });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/tab/option-data — 선택된 옵션 컬럼의 행별 데이터 조회
// Query: sheetId, tabName, (optional) gid, (optional) round
// ★ columns: JSON 문자열로 전달 시 DB 저장 데이터 대신 해당 컬럼 기준으로 미리보기
// 반환: { rows: [{ rowIndex, reviewerName, options: { "키워드": "끈나시", "컬러": "노랑색" } }, ...] }
router.get('/option-data', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, gid, round, columns } = req.query;
    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId와 tabName이 필요합니다.' });
    }

    // 1) columns 파라미터가 있으면 그것을 사용, 없으면 DB 저장값 조회
    // ★ round가 있으면 option_columns_map[round] 우선 조회
    let optionColumns = [];
    if (columns) {
      try { optionColumns = JSON.parse(columns); } catch(e) {
        return res.json({ error: 'columns 파라미터 파싱 실패' });
      }
    } else {
      const { rows: tcRows } = await pool.query(
        'SELECT option_columns, option_columns_map FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
        [sheetId, tabName]
      );
      if (round && tcRows[0]?.option_columns_map && tcRows[0].option_columns_map[round]) {
        optionColumns = tcRows[0].option_columns_map[round];
      } else {
        optionColumns = tcRows[0]?.option_columns || [];
      }
    }
    if (optionColumns.length === 0) {
      return res.json({ ok: true, rows: [], message: '설정된 옵션 컬럼이 없습니다.' });
    }

    // 2) 시트 전체 데이터 읽기
    const range = `'${tabName.replace(/'/g, "''")}'`;
    const opts = gid ? { gid } : {};
    let values;
    try {
      values = await throttledCall(() => readSheet(sheetId, range, opts));
    } catch (sheetErr) {
      logger.error('[option-data] 시트 읽기 실패:', sheetErr.message);
      return res.json({ error: '시트 읽기 실패: ' + sheetErr.message });
    }

    if (!values || values.length === 0) {
      return res.json({ ok: true, rows: [] });
    }

    // 3) 헤더 행 찾기 (option-headers와 동일 로직)
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
      return res.json({ error: '데이터 헤더 행을 찾을 수 없습니다.' });
    }

    const headers = values[headerRowIdx].map(h => String(h || '').trim());
    const dataRows = values.slice(headerRowIdx + 1);

    // 4) 이름 컬럼 인덱스 찾기
    const nameColIdx = headers.findIndex(h => NAME_KW.some(k => h.includes(k)));

    // 5) 회차 컬럼 인덱스 찾기 (round 필터용)
    const roundColIdx = headers.findIndex(h => ROUND_KW.some(k => h.toLowerCase().includes(k.toLowerCase())));

    // 6) 옵션 컬럼 인덱스 매핑 (저장된 이름 → 실제 헤더 인덱스)
    const optColMap = [];
    for (const oc of optionColumns) {
      // colIndex가 있으면 우선, 없으면 이름으로 검색
      let idx = oc.colIndex;
      if (idx === undefined || idx === null || headers[idx] !== oc.name) {
        idx = headers.findIndex(h => h === oc.name);
      }
      if (idx >= 0) {
        optColMap.push({ name: oc.name, idx });
      }
    }

    if (optColMap.length === 0) {
      return res.json({ ok: true, rows: [], message: '옵션 컬럼이 현재 시트 헤더와 매칭되지 않습니다.' });
    }

    // 7) 행별 옵션 데이터 추출
    const result = [];
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const reviewerName = nameColIdx >= 0 ? String(row[nameColIdx] || '').trim() : '';
      // ★ 옵션값이 하나라도 있으면 이름(수취인)이 비어 있어도 포함한다.
      //   (수취인 미배정 양식: 옵션만 채워둔 행도 미리보기에 보여줘야 저장 가능)
      const hasAnyOption = optColMap.some(({ idx }) => String(row[idx] !== undefined ? row[idx] : '').trim() !== '');
      if (!reviewerName && !hasAnyOption) continue; // 이름·옵션 모두 비면 스킵

      // round 필터
      if (round && roundColIdx >= 0) {
        const rowRound = String(row[roundColIdx] || '').trim();
        if (rowRound !== round) continue;
      }

      const options = {};
      for (const { name, idx } of optColMap) {
        options[name] = String(row[idx] !== undefined ? row[idx] : '').trim();
      }

      result.push({
        rowIndex: headerRowIdx + 1 + i + 1, // 1-based (시트 행 번호)
        reviewerName,
        round: roundColIdx >= 0 ? String(row[roundColIdx] || '').trim() : '',
        options,
      });
    }

    res.json({
      ok: true,
      optionColumns: optColMap.map(c => c.name),
      rows: result,
      totalRows: result.length,
    });
  } catch (err) {
    next(err);
  }
});

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

// ═══════════════════════════════════════════════════════════
// POST /api/tab/refresh-option-cache — 옵션 distinctValues 캐시 수동 갱신
// Body: { sheetId, tabName, gid, round }
// ★ 관리자가 옵션 설정 후 즉시 캐시를 워밍할 때 사용
// ═══════════════════════════════════════════════════════════
router.post('/refresh-option-cache', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, gid, round } = req.body;
    if (!sheetId || !tabName) {
      return res.json({ error: 'sheetId, tabName이 필요합니다.' });
    }

    // 1) option_columns_map에서 옵션 컬럼 조회
    const { rows: tcRows } = await pool.query(
      'SELECT option_columns, option_columns_map, closed_rounds, archived_rounds FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
      [sheetId, tabName]
    );
    const ocMap = tcRows[0]?.option_columns_map || {};

    // round 결정 (미지정 시 최신 활성 차수)
    let targetRound = round || '';
    if (!targetRound && Object.keys(ocMap).length > 0) {
      const closedRounds = (tcRows[0]?.closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
      const archivedRounds = (tcRows[0]?.archived_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
      const excludeSet = new Set([...closedRounds, ...archivedRounds]);
      const activeRounds = Object.keys(ocMap)
        .filter(r => !excludeSet.has(r))
        .sort((a, b) => {
          const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
          const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
          return numA - numB;
        });
      if (activeRounds.length > 0) targetRound = activeRounds[activeRounds.length - 1];
    }

    const optionColumns = targetRound && ocMap[targetRound] ? ocMap[targetRound] : (tcRows[0]?.option_columns || []);
    if (optionColumns.length === 0) {
      return res.json({ ok: true, message: '설정된 옵션 컬럼이 없습니다.' });
    }

    // 2) 시트 데이터 읽기
    const range = `'${tabName.replace(/'/g, "''")}'`;
    const opts = gid ? { gid } : {};
    const values = await throttledCall(() => readSheet(sheetId, range, opts));
    if (!values || values.length === 0) {
      return res.json({ ok: true, message: '시트 데이터 없음' });
    }

    // 3) 헤더/데이터 파싱
    const DATA_TAB_KW = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];
    const ROUND_KW = ['회차', '차수', 'round'];
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(values.length, 50); i++) {
      const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
      if (cells.some(c => DATA_TAB_KW.some(k => c.includes(k)))) { headerRowIdx = i; break; }
    }
    if (headerRowIdx < 0) return res.json({ ok: true, message: '헤더 행을 찾을 수 없습니다.' });

    const headers = values[headerRowIdx].map(h => String(h || '').trim());
    const dataRows = values.slice(headerRowIdx + 1);
    const roundColIdx = headers.findIndex(h => ROUND_KW.some(k => h.toLowerCase().includes(k.toLowerCase())));

    // 4) distinctValues 추출
    const optColMap = [];
    for (const oc of optionColumns) {
      let idx = oc.colIndex;
      if (idx === undefined || idx === null || headers[idx] !== oc.name) {
        idx = headers.findIndex(h => h === oc.name);
      }
      if (idx >= 0) optColMap.push({ name: oc.name, idx });
    }

    const distinctValues = {};
    for (const { name: colName, idx } of optColMap) {
      const valSet = new Set();
      for (const row of dataRows) {
        if (targetRound && roundColIdx >= 0) {
          const rowRound = String(row[roundColIdx] || '').trim();
          if (rowRound !== targetRound) continue;
        }
        const v = String(row[idx] !== undefined ? row[idx] : '').trim();
        if (v) valSet.add(v);
      }
      distinctValues[colName] = [...valSet];
    }

    // 5) DB 캐시 저장
    await pool.query(
      `UPDATE tab_configs
       SET distinct_values_cache = COALESCE(distinct_values_cache, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb),
           updated_at = NOW()
       WHERE sheet_id = $1 AND tab_name = $2`,
      [sheetId, tabName, targetRound, JSON.stringify(distinctValues)]
    );

    logger.info(`[refresh-option-cache] 캐시 갱신 완료: tab=${tabName} round=${targetRound} cols=${Object.keys(distinctValues).length}`);
    res.json({ ok: true, round: targetRound, distinctValues, message: '캐시 갱신 완료' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
