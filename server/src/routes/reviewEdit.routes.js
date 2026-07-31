// ═══════════════════════════════════════════════════════════
// 리뷰 이미지 수정요청 (리뷰어 → 관리자 승인 → [리뷰] 폴더 파일 교체)
//
// 흐름:
//   1) 리뷰어(무인증, phone8 강한-키 게이트)가 제출완료 내역에서 제출 이미지를 확인
//   2) 잘못 올린 파일을 교체 요청 → 새 파일은 최상위 [리뷰수정대기] 폴더에 "스테이징"만 됨
//      (모든 탭 [리뷰] 폴더 밖 + 비리뷰형식 파일명 = 관리자 리뷰정리 도구가 승인 전 승격/링크 못 함;
//       review_index / review_submissions 도 그대로 = 실제 리뷰 파일 미변경)
//   3) 관리자(adminOrMaster)가 승인하면 그 때 비로소 파일 교체:
//        새 파일을 [리뷰](또는 슬롯) 폴더로 이동 → DB 포인터 스왑 → 구 파일 [리뷰교체보관]으로 이동(보관)
//      반려하면 스테이징 새 파일을 휴지통 이동.
//
// 보안: /my-files·/request·/my-requests·/cancel 은 무인증이므로 phone8 정확일치
//       (본인+타계정 연락처 또는 participation_links 확정신원)로 소유 검증된 행에만 개방한다.
//       search.service 의 제출완료 강한-키 술어와 동일 규율(이름 단독 매칭은 절대 미개방).
// ═══════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { slotLabel: slotLabelOf } = require('../utils/captureSlots');
const driveService = require('../services/drive.service');
const { _getReviewerPhoneList } = require('../services/search.service');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { imageApiLimiter } = require('../middleware/rateLimit.middleware');
const sse = require('../utils/sse');

// ── 공통 헬퍼 ──

function _p8(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

/** 사유 정화: HTML 태그 제거 + 길이 제한(텍스트로만 취급) */
function _sanitizeReason(v) {
  return String(v || '').replace(/<[^>]*>/g, '').trim().slice(0, 500);
}

/**
 * 행 소유권 검증 (강한-키 전용): review_index.phone8 또는 participation_links.phone8 이
 * 요청자 phone8 목록(본인+타계정)과 정확 일치하는 행만 소유로 인정.
 * ★ pl(확정신원)은 review_index.phone8 이 공란일 때만 신원키로 인정한다(시트 현재값 우선).
 *   재배정된 행(로스터 행 주인이 바뀐 경우)의 stale pl 로 타인 리뷰 이미지를 열람·교체요청하는
 *   무인증 교차노출을 차단한다(search.service 의 P5 게이트와 동일 규율).
 */
async function _verifyRowOwnership(phoneList, sheetId, tabName, rowIndex) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM review_index ri
       LEFT JOIN participation_links pl
         ON pl.sheet_id = ri.sheet_id AND pl.tab_name = ri.tab_name AND pl.row_index = ri.row_index
      WHERE ri.sheet_id = $1 AND ri.tab_name = $2 AND ri.row_index = $3
        AND (ri.phone8 = ANY($4) OR (ri.phone8 IS NULL AND pl.phone8 = ANY($4)))
      LIMIT 1`,
    [sheetId, tabName, rowIndex, phoneList]
  );
  return rows.length > 0;
}

/**
 * 탭의 [리뷰] 폴더 + (슬롯 서브폴더) + [수정대기] 스테이징 폴더 확보.
 *   review-upload 와 동일 규칙: 기본 'review' 슬롯은 [리뷰] 바로 아래, 그 외는 라벨 서브폴더.
 * @returns {{ reviewFolderId, targetFolderId, stagingFolderId, campaignLabel }}
 */
async function _resolveFolders(sheetId, tabName, slot) {
  const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) throw new Error('AI_REVIEW_FOLDER_ID 미설정');

  const { rows: tc } = await pool.query(
    'SELECT folder_url, campaign_name, display_name, capture_slots, income_type FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
    [sheetId, tabName]
  );
  const cfg = tc[0] || {};

  let reviewFolderId = cfg.folder_url ? driveService.extractFolderIdFromUrl(cfg.folder_url) : null;
  if (!reviewFolderId) {
    const sheetTitle = cfg.campaign_name || tabName;
    const r = await driveService.ensureReviewFolderPath(rootFolderId, sheetTitle, tabName);
    reviewFolderId = r.id;
    // 새로 만든 리뷰 폴더면 tab_configs 에 URL 저장(다음 업로드/조회 재사용)
    try {
      await pool.query(
        'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3 AND (folder_url IS NULL OR folder_url = $4)',
        [r.url, sheetId, tabName, '']
      );
    } catch (_) {}
  }
  if (!reviewFolderId) throw new Error('리뷰 폴더를 확보하지 못했습니다.');

  // 대상 폴더(구 파일이 사는 곳): 기본 슬롯은 [리뷰], 그 외는 슬롯 라벨 서브폴더
  let targetFolderId = reviewFolderId;
  if (slot && slot !== 'review') {
    // 라벨 판정은 공용 유틸 — 현영 자동 슬롯도 같은 폴더명을 쓰게(업로드 경로와 일치해야 파일이 흩어지지 않음)
    const label = slotLabelOf(cfg.capture_slots, cfg.income_type, slot);
    const sf = await driveService.getOrCreateSubFolder(reviewFolderId, label);
    targetFolderId = sf.id;
  }

  // 스테이징: 최상위 [리뷰수정대기] — 모든 탭 [리뷰] 폴더 "밖"에 격리한다.
  //   ★ folder-audit(탭별 [리뷰] 재귀 스캔)는 [리뷰] 밖이라 승인 전 파일을 안 셈.
  //   ★ relocate-orphan-reviews(전역 키워드 검색)는 리뷰형식 파일명만 대상 → 스테이징
  //     파일명을 비리뷰형식(수정대기_*)으로 두어 승인 전 [리뷰]로 승격/링크되는 것을 막는다.
  const rootFolderIdForStaging = rootFolderId;
  const staging = await driveService.getOrCreateSubFolder(rootFolderIdForStaging, '[리뷰수정대기]');

  const campaignLabel = cfg.display_name || cfg.campaign_name || tabName;
  return { reviewFolderId, targetFolderId, stagingFolderId: staging.id, campaignLabel };
}

/**
 * 교체된 구 파일 "보관 전용" 폴더 확보 — 최상위 [리뷰교체보관].
 *   휴지통 폐기가 아니라 원본 보존이 목적. 모든 탭 [리뷰] 폴더 밖이라 report/폴더점검이 안 셈.
 */
async function _resolveArchiveFolder() {
  const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) throw new Error('AI_REVIEW_FOLDER_ID 미설정');
  const f = await driveService.getOrCreateSubFolder(rootFolderId, '[리뷰교체보관]');
  return f.id;
}

/**
 * 보관 파일명 규칙: 교체전_{yyyyMMdd_HHmmss}_{리뷰어}_{캠페인/탭}_행{행번호}.{확장자}
 *   - "교체전_" 표식(비리뷰형식이라 리뷰정리 도구가 승격 안 함)
 *   - 승인(교체) 시각(KST)로 정렬 가능 + 리뷰어/캠페인/행으로 역추적 가능
 */
function _archiveName(r, origName) {
  const ext = (String(origName || '').match(/\.([A-Za-z0-9]+)$/) || [, 'jpg'])[1];
  const clean = (s) => String(s || '').replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '').slice(0, 24);
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const ts = kst.toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/^(\d{8})(\d{6}).*/, '$1_$2');
  return `교체전_${ts}_${clean(r.reviewer_name || '익명')}_${clean(r.campaign_label || r.tab_name)}_행${r.row_index || 0}.${ext}`;
}

// ═══════════════════════════════════════════════════════════
// 리뷰어 측 (무인증 · phone8 강한-키 게이트)
// ═══════════════════════════════════════════════════════════

// GET /api/review-edit/my-files?phone8&sheetId&tabName&rowIndex
//   그 행의 소유(강한-키)가 확인되면 제출 이미지 목록(썸네일용 fileId 포함) + 대기중 요청을 반환.
router.get('/my-files', async (req, res) => {
  try {
    const p8 = _p8(req.query.phone8);
    const sheetId = req.query.sheetId;
    const tabName = req.query.tabName;
    const rowIndex = parseInt(req.query.rowIndex, 10);
    if (p8.length !== 8 || !sheetId || !tabName || !Number.isInteger(rowIndex)) {
      return res.status(400).json({ ok: false, error: '잘못된 요청입니다.' });
    }

    const phoneList = await _getReviewerPhoneList(p8);
    if (!(await _verifyRowOwnership(phoneList, sheetId, tabName, rowIndex))) {
      return res.status(403).json({ ok: false, error: '본인 제출 내역만 조회할 수 있습니다.' });
    }

    const { rows: files } = await pool.query(
      `SELECT file_id, file_name, file_url, slot_key, uploaded_at
         FROM review_submissions
        WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3
          AND file_id IS NOT NULL AND file_id <> ''
        ORDER BY slot_key, uploaded_at ASC NULLS LAST`,
      [sheetId, tabName, rowIndex]
    );

    // 슬롯 라벨
    const { rows: tc } = await pool.query(
      'SELECT capture_slots, income_type FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [sheetId, tabName]
    );
    const slotLabel = (k) => slotLabelOf(tc[0]?.capture_slots, tc[0]?.income_type, k);

    // 이 행의 대기중 요청(슬롯/파일별 UI 잠금용)
    const { rows: pending } = await pool.query(
      `SELECT id, slot_key, old_file_id, created_at
         FROM review_edit_requests
        WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3 AND status = 'pending'`,
      [sheetId, tabName, rowIndex]
    );

    res.json({
      ok: true,
      files: files.map(f => ({
        fileId: f.file_id,
        fileName: f.file_name || '',
        slotKey: f.slot_key || 'review',
        slotLabel: slotLabel(f.slot_key || 'review'),
        uploadedAt: f.uploaded_at,
      })),
      pending: pending.map(p => ({ id: p.id, slotKey: p.slot_key, oldFileId: p.old_file_id, createdAt: p.created_at })),
    });
  } catch (err) {
    logger.error(`[review-edit] my-files 실패: ${err.message}`);
    res.status(500).json({ ok: false, error: '조회 중 오류가 발생했습니다.' });
  }
});

// ── 리뷰가이드 추출: work_detail.reviewGuide에서 [리뷰등록 가이드]/[리뷰가이드] 섹션만.
//    [라벨] 마커가 없으면 평문 전체 그대로. (campaign-workdetail.js pickReviewOnly 서버 포팅 — 표시 규율 일치)
function _pickReviewGuide(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return '';
  if (!/\[[^\]]+\]/.test(text)) return text.trim();
  const norm = (s) => s.replace(/\s/g, '');
  const keep = ['리뷰등록가이드', '리뷰가이드'];
  const out = []; let take = false; let buf = [];
  const flush = () => { const c = buf.join('\n').trim(); if (take && c) out.push(c); buf = []; };
  text.split(/\r?\n/).forEach((ln) => {
    const mm = ln.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (mm) { flush(); take = keep.some((k) => norm(mm[1]).indexOf(k) >= 0); buf = mm[2] ? [mm[2]] : []; }
    else buf.push(ln);
  });
  flush();
  return out.join('\n').trim();
}

// GET /api/review-edit/participation-brief?phone8&sheetId&tabName&gid&rowIndex
//   리뷰 내역 카드 → "참여상품 정보" 시트용. 행 소유권(강한-키) 통과 시에만 그 행의 연결 공고
//   brief(제목·카톡URL·상품URL·상품정보·리뷰가이드)를 반환. 카톡 URL은 이름 단독 약한-키론 절대 안 나간다
//   (참여형 chat_url 게이트와 동일 사상 — my-files 소유권 술어 재사용).
router.get('/participation-brief', async (req, res) => {
  try {
    const p8 = _p8(req.query.phone8);
    const sheetId = req.query.sheetId;
    const tabName = req.query.tabName;
    const rowIndex = parseInt(req.query.rowIndex, 10);
    if (p8.length !== 8 || !sheetId || !tabName || !Number.isInteger(rowIndex)) {
      return res.status(400).json({ ok: false, error: '잘못된 요청입니다.' });
    }

    const phoneList = await _getReviewerPhoneList(p8);
    if (!(await _verifyRowOwnership(phoneList, sheetId, tabName, rowIndex))) {
      return res.status(403).json({ ok: false, error: '본인 참여 내역만 조회할 수 있습니다.' });
    }

    // ★ gid는 클라이언트를 신뢰하지 않고 소유권 검증된 (sheetId, tabName)로 서버가 재도출.
    //   클라이언트 gid를 쓰면 같은 시트의 형제 캠페인 gid를 넘겨 그 공고의 chat_url/product_url을
    //   열람하는 교차 캠페인 유출이 가능하므로(소유권은 tabName으로만 검증됨) tab_configs에서 도출한다.
    let ownGid = '';
    try {
      const { rows: tc } = await pool.query(
        'SELECT tab_gid FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
        [sheetId, tabName]
      );
      ownGid = (tc[0] && tc[0].tab_gid) || '';
    } catch (_) { /* gid 도출 실패 → 탭명 매칭만(fail-soft) */ }

    // 이 행(시트/탭)에 연결된 공고 — 서버도출 gid 우선 → 탭명 폴백
    const { rows: camps } = await pool.query(
      `SELECT id, title, chat_url, landing_url, source_work_order_id, work_detail
         FROM recruit_campaigns
        WHERE linked_sheet_id = $1
          AND (($2 <> '' AND linked_tab_gid = $2) OR linked_tab_name = $3)
        ORDER BY ($2 <> '' AND linked_tab_gid = $2) DESC, created_at DESC
        LIMIT 1`,
      [sheetId, ownGid, tabName]
    );
    if (!camps.length) return res.json({ ok: true, brief: null });   // 공고 미연결 탭(카톡 없음 → 프론트는 제출 버튼만)
    const c = camps[0];

    // 상품 URL: 연결 작업오더 product_url → 공고 landing_url 폴백 (읽기만 · fail-soft)
    let productUrl = '';
    try {
      const { rows: wo } = await pool.query(
        `SELECT product_url FROM work_orders
          WHERE (linked_campaign_id = $1 AND $1 <> '') OR (id = $2 AND $2 <> '')
          ORDER BY (linked_campaign_id = $1) DESC, updated_at DESC LIMIT 1`,
        [c.id, c.source_work_order_id || '']
      );
      productUrl = (wo[0] && wo[0].product_url) || '';
    } catch (_) { /* fail-soft */ }
    if (!productUrl) productUrl = c.landing_url || '';

    let productLines = '', reviewGuide = '';
    try {
      const wd = typeof c.work_detail === 'string' ? JSON.parse(c.work_detail) : (c.work_detail || {});
      productLines = String((wd && wd.productLines) || '').trim();
      reviewGuide = _pickReviewGuide(String((wd && wd.reviewGuide) || ''));
    } catch (_) { /* work_detail 없음/파싱 실패 무시 */ }

    res.json({
      ok: true,
      brief: {
        campaignId: c.id,
        campaignTitle: c.title || '',
        chatUrl: c.chat_url || '',
        productUrl,
        productLines,
        reviewGuide,
      },
    });
  } catch (err) {
    logger.error(`[review-edit] participation-brief 실패: ${err.message}`);
    res.status(500).json({ ok: false, error: '조회 중 오류가 발생했습니다.' });
  }
});

// POST /api/review-edit/request
//   body: { phone8, sheetId, tabName, gid, rowIndex, oldFileId, reason, file:{data,mimeType,name} }
//   새 파일을 [수정대기]에 스테이징만 하고 요청 원장(pending)에 기록. 실제 교체는 관리자 승인 시.
router.post('/request', imageApiLimiter, async (req, res) => {
  try {
    const p8 = _p8(req.body.phone8);
    const { sheetId, tabName, gid, oldFileId, file } = req.body;
    const rowIndex = parseInt(req.body.rowIndex, 10);
    const reason = _sanitizeReason(req.body.reason);

    if (p8.length !== 8 || !sheetId || !tabName || !Number.isInteger(rowIndex) || !oldFileId || !file || !file.data) {
      return res.json({ ok: false, error: '필수 항목이 누락되었습니다.' });
    }

    const phoneList = await _getReviewerPhoneList(p8);
    if (!(await _verifyRowOwnership(phoneList, sheetId, tabName, rowIndex))) {
      return res.status(403).json({ ok: false, error: '본인 제출 내역만 수정 요청할 수 있습니다.' });
    }

    // 교체 대상(구 파일)이 실제로 그 행에 속하는지 검증 + 슬롯/이름/URL 확보
    const { rows: oldRows } = await pool.query(
      `SELECT file_id, file_name, file_url, slot_key, reviewer_name
         FROM review_submissions
        WHERE file_id = $1 AND sheet_id = $2 AND tab_name = $3 AND row_index = $4
        LIMIT 1`,
      [oldFileId, sheetId, tabName, rowIndex]
    );
    if (!oldRows[0]) {
      return res.json({ ok: false, error: '교체 대상 파일을 찾을 수 없습니다.' });
    }
    const slot = oldRows[0].slot_key || 'review';
    const reviewerName = oldRows[0].reviewer_name || '';

    // (행,슬롯)당 대기중 요청 1건 사전 체크(친절 메시지) — 최종 보장은 부분 유니크 인덱스
    const { rows: dup } = await pool.query(
      `SELECT id FROM review_edit_requests
        WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3 AND slot_key = $4 AND status = 'pending'
        LIMIT 1`,
      [sheetId, tabName, rowIndex, slot]
    );
    if (dup[0]) {
      return res.json({ ok: false, error: '이미 처리 대기 중인 수정요청이 있습니다. 관리자 확인을 기다려 주세요.', duplicated: true });
    }

    // 폴더 확보 + 새 파일 스테이징 업로드
    //   ★ 스테이징 파일명은 "비리뷰형식"(수정대기_*) — 승인 전에는 리뷰형식 파일명 재배치
    //     도구(relocate-orphan-reviews)의 reviewPattern에 걸리지 않게. 승인 시 정식명으로 rename.
    const { targetFolderId, stagingFolderId, campaignLabel } = await _resolveFolders(sheetId, tabName, slot);
    const newName = '수정대기_' + crypto.randomBytes(6).toString('hex') + '.jpg';
    const uploaded = await driveService.uploadFileBase64(
      file.data, newName, file.mimeType || 'image/jpeg', stagingFolderId
    );
    const newUrl = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;

    // 원장 기록 (부분 유니크 충돌 시 = 경쟁 패배 → 스테이징 파일 회수)
    const { rows: ins } = await pool.query(
      `INSERT INTO review_edit_requests
         (sheet_id, tab_name, tab_gid, row_index, slot_key, reviewer_name, phone8, campaign_label,
          old_file_id, old_file_url, old_file_name,
          new_file_id, new_file_url, new_file_name, new_parent_id, target_folder_id, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending')
       ON CONFLICT (sheet_id, tab_name, row_index, slot_key) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [sheetId, tabName, gid || null, rowIndex, slot, reviewerName || null, p8, campaignLabel,
       oldFileId, oldRows[0].file_url || null, oldRows[0].file_name || null,
       uploaded.id, newUrl, uploaded.name || newName, stagingFolderId, targetFolderId, reason || null]
    );
    if (!ins[0]) {
      try { await driveService.trashFiles([{ id: uploaded.id, name: newName }]); } catch (_) {}
      return res.json({ ok: false, error: '이미 처리 대기 중인 수정요청이 있습니다.', duplicated: true });
    }

    // 관리자 실시간 알림
    try {
      sse.broadcast('review_edit_request', {
        message: `리뷰 수정요청: ${campaignLabel} — ${reviewerName || '리뷰어'}`,
        requestId: ins[0].id,
        action: 'new',
      });
    } catch (_) {}

    res.json({ ok: true, requestId: ins[0].id });
  } catch (err) {
    logger.error(`[review-edit] request 실패: ${err.message}`);
    res.json({ ok: false, error: err.message || '수정요청 처리 중 오류가 발생했습니다.' });
  }
});

// GET /api/review-edit/my-requests?phone8
//   리뷰어 본인(본인+타계정) 요청 내역 + 상태/처리메모.
router.get('/my-requests', async (req, res) => {
  try {
    const p8 = _p8(req.query.phone8);
    if (p8.length !== 8) return res.status(400).json({ ok: false, error: '잘못된 요청입니다.' });
    const phoneList = await _getReviewerPhoneList(p8);
    const { rows } = await pool.query(
      `SELECT id, campaign_label, tab_name, slot_key, old_file_name, new_file_name,
              status, admin_note, created_at, resolved_at
         FROM review_edit_requests
        WHERE phone8 = ANY($1)
        ORDER BY created_at DESC
        LIMIT 50`,
      [phoneList]
    );
    res.json({ ok: true, requests: rows });
  } catch (err) {
    logger.error(`[review-edit] my-requests 실패: ${err.message}`);
    res.status(500).json({ ok: false, error: '조회 중 오류가 발생했습니다.' });
  }
});

// POST /api/review-edit/cancel  body: { phone8, requestId }
//   리뷰어 본인이 대기중 요청을 스스로 취소 → 스테이징 파일 회수.
router.post('/cancel', async (req, res) => {
  const { requestId } = req.body;
  const p8 = _p8(req.body.phone8);
  if (p8.length !== 8 || !requestId) return res.status(400).json({ ok: false, error: '잘못된 요청입니다.' });

  const client = await pool.connect();
  try {
    const phoneList = await _getReviewerPhoneList(p8);
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM review_edit_requests WHERE id = $1 AND phone8 = ANY($2) FOR UPDATE`,
      [requestId, phoneList]
    );
    const r = rows[0];
    if (!r) { await client.query('ROLLBACK'); return res.status(403).json({ ok: false, error: '본인 요청만 취소할 수 있습니다.' }); }
    if (r.status !== 'pending') { await client.query('ROLLBACK'); return res.json({ ok: false, error: `이미 처리된 요청입니다 (${r.status}).`, status: r.status }); }

    await client.query(
      `UPDATE review_edit_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [requestId]
    );
    await client.query('COMMIT');

    // 스테이징 파일 회수(커밋 후, 비치명적)
    try { if (r.new_file_id) await driveService.trashFiles([{ id: r.new_file_id, name: r.new_file_name || '' }]); } catch (_) {}
    try { sse.broadcast('review_edit_request', { message: '리뷰 수정요청 취소', requestId, action: 'cancelled' }); } catch (_) {}

    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error(`[review-edit] cancel 실패: ${err.message}`);
    res.json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// 관리자 측 (authMiddleware + adminOrMaster)
// ═══════════════════════════════════════════════════════════

// GET /api/review-edit/list?status=pending
router.get('/list', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)
      ? req.query.status : 'pending';
    const { rows } = await pool.query(
      `SELECT id, sheet_id, tab_name, tab_gid, row_index, slot_key, reviewer_name, phone8,
              campaign_label, old_file_id, old_file_name, new_file_id, new_file_name,
              reason, status, admin_note, created_at, resolved_at, resolved_by
         FROM review_edit_requests
        WHERE status = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [status]
    );
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM review_edit_requests WHERE status = 'pending'`
    );
    res.json({ ok: true, requests: rows, pendingCount: cnt[0]?.n || 0 });
  } catch (err) {
    logger.error(`[review-edit] list 실패: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/review-edit/approve  body: { id, note? }
//   ★ Drive 연산(비트랜잭셔널)은 트랜잭션 "밖"에서 먼저(멱등) 수행하고, 짧은 트랜잭션에서만
//     FOR UPDATE 재검증 + DB 포인터 스왑 + 상태확정 → 커밋 → 구 파일 [리뷰교체보관] 이동(커밋 후·비치명적).
//   → Drive 왕복 동안 커넥션/행 락을 잡지 않는다(스타베이션 방지). 이동/이름변경은 재시도 안전.
router.post('/approve', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  const { id, note } = req.body;
  if (!id) return res.json({ ok: false, error: 'id가 필요합니다.' });

  try {
    // 0) 사전 로드(락 없음) — Drive 이동을 트랜잭션 밖에서 하기 위한 정보 확보
    const { rows: pre } = await pool.query('SELECT * FROM review_edit_requests WHERE id = $1', [id]);
    const r0 = pre[0];
    if (!r0) return res.json({ ok: false, error: '요청을 찾을 수 없습니다.' });
    if (r0.status !== 'pending') return res.json({ ok: false, error: `이미 처리된 요청입니다 (${r0.status}).`, status: r0.status });
    if (!r0.new_file_id) return res.json({ ok: false, error: '스테이징된 새 파일이 없습니다.' });

    // 1) 대상 폴더 확보(트랜잭션 밖) — 요청 이후 폴더가 이동/재생성됐어도 현재 [리뷰]로 배치
    let targetFolderId = r0.target_folder_id;
    if (!targetFolderId) {
      targetFolderId = (await _resolveFolders(r0.sheet_id, r0.tab_name, r0.slot_key || 'review')).targetFolderId;
    }

    // 2) 새 파일을 대상 폴더로 이동(멱등: 이미 대상이면 skip) + 정식 리뷰 파일명으로 rename
    //    (스테이징 중엔 비리뷰형식 이름이었으므로 승인 시점에 정식명으로 되돌린다)
    const meta = await driveService.getFileParents(r0.new_file_id);
    if (meta && meta.trashed) return res.json({ ok: false, error: '스테이징 파일이 삭제되어 승인할 수 없습니다.' });
    const parents = Array.isArray(meta && meta.parents) ? meta.parents : [];
    if (!parents.includes(targetFolderId)) {
      await driveService.moveFile(r0.new_file_id, targetFolderId, parents[0] || r0.new_parent_id);
    }
    const finalName = driveService.generateReviewFileName(r0.reviewer_name || '익명', 1, 'image/jpeg');
    try { await driveService.renameFile(r0.new_file_id, finalName); }
    catch (e) { logger.warn(`[review-edit] 새 파일 rename 실패(무시): ${e.message}`); }
    const finalUrl = r0.new_file_url || `https://drive.google.com/file/d/${r0.new_file_id}/view`;

    // 3) 짧은 트랜잭션: FOR UPDATE 재검증(이중승인 차단) + DB 포인터 스왑 + 상태확정
    const client = await pool.connect();
    let committed = null;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM review_edit_requests WHERE id = $1 FOR UPDATE', [id]);
      const r = rows[0];
      if (!r || r.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.json({ ok: false, error: '이미 처리된 요청입니다.', status: r && r.status });
      }
      // review_submissions: 구 파일 레코드를 새 파일로 (원 제출시각 uploaded_at 보존 = 제출일 유지)
      await client.query(
        `UPDATE review_submissions
            SET file_id = $1, file_url = $2, file_name = $3
          WHERE file_id = $4 AND sheet_id = $5 AND tab_name = $6 AND row_index = $7`,
        [r.new_file_id, finalUrl, finalName, r.old_file_id, r.sheet_id, r.tab_name, r.row_index]
      );
      // review_index: 대표이미지가 구 파일과 일치할 때만 교체 (원 연결시각 review_file_at 보존)
      await client.query(
        `UPDATE review_index
            SET review_file_id = $1, review_file_url = $2, review_file_name = $3
          WHERE sheet_id = $4 AND tab_name = $5 AND row_index = $6 AND review_file_id = $7`,
        [r.new_file_id, finalUrl, finalName, r.sheet_id, r.tab_name, r.row_index, r.old_file_id]
      );
      // 요청 확정 (새 파일 최종명/URL 스냅샷 갱신)
      await client.query(
        `UPDATE review_edit_requests
            SET status = 'approved', resolved_by = $1, resolved_at = NOW(), updated_at = NOW(),
                new_file_name = $2, new_file_url = $3, admin_note = COALESCE($4, admin_note)
          WHERE id = $5`,
        [req.admin?.name || '', finalName, finalUrl, note ? _sanitizeReason(note) : null, id]
      );
      await client.query('COMMIT');
      committed = r;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }

    // 4) 구 파일: 휴지통이 아니라 [리뷰교체보관] 폴더로 이동 + 규칙 파일명(보관 목적, 커밋 후·비치명적)
    try {
      if (committed.old_file_id) {
        const archiveId = await _resolveArchiveFolder();
        const oldMeta = await driveService.getFileParents(committed.old_file_id);
        const oldParents = Array.isArray(oldMeta.parents) ? oldMeta.parents : [];
        if (!oldParents.includes(archiveId)) {
          await driveService.moveFile(committed.old_file_id, archiveId, oldParents.join(',') || undefined);
        }
        try { await driveService.renameFile(committed.old_file_id, _archiveName(committed, committed.old_file_name)); }
        catch (e) { logger.warn(`[review-edit] 보관 파일 rename 실패(무시): ${e.message}`); }
      }
    } catch (e) {
      logger.warn(`[review-edit] 구 파일 보관 이동 실패(무시): ${e.message}`);
    }

    // 5) 관리자 위젯 실시간 갱신
    try { sse.broadcast('review_edit_request', { message: '리뷰 수정요청 승인 완료', requestId: id, action: 'approved' }); } catch (_) {}

    res.json({ ok: true });
  } catch (err) {
    logger.error(`[review-edit] approve 실패: ${err.message}`);
    res.json({ ok: false, error: err.message || '승인 처리 중 오류가 발생했습니다.' });
  }
});

// POST /api/review-edit/reject  body: { id, note? }
router.post('/reject', authMiddleware, adminOrMasterMiddleware, async (req, res) => {
  const { id, note } = req.body;
  if (!id) return res.json({ ok: false, error: 'id가 필요합니다.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM review_edit_requests WHERE id = $1 FOR UPDATE`, [id]);
    const r = rows[0];
    if (!r) { await client.query('ROLLBACK'); return res.json({ ok: false, error: '요청을 찾을 수 없습니다.' }); }
    if (r.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.json({ ok: false, error: `이미 처리된 요청입니다 (${r.status}).`, status: r.status });
    }

    await client.query(
      `UPDATE review_edit_requests
          SET status = 'rejected', resolved_by = $1, resolved_at = NOW(), updated_at = NOW(),
              admin_note = $2
        WHERE id = $3`,
      [req.admin?.name || '', note ? _sanitizeReason(note) : null, id]
    );
    await client.query('COMMIT');

    // 스테이징 새 파일 회수(커밋 후, 비치명적)
    try { if (r.new_file_id) await driveService.trashFiles([{ id: r.new_file_id, name: r.new_file_name || '' }]); } catch (_) {}

    try { sse.broadcast('review_edit_request', { message: '리뷰 수정요청 반려', requestId: id, action: 'rejected' }); } catch (_) {}

    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error(`[review-edit] reject 실패: ${err.message}`);
    res.json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
