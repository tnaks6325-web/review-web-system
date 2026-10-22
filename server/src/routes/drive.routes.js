const express = require('express');
const router = express.Router();
const driveService = require('../services/drive.service');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

// 공개 리포트에서 제외할 영수증 검수 증거. 리뷰 슬롯 파일을 AI가 영수증으로 오판했어도
// 담당자가 정상(ok)으로 확정했다면 format 흔적만으로 숨기지 않는다. 영수증 전용
// receiptValidation이 있으면 승인 상태와 무관하게 계속 제외한다.
const PUBLIC_REPORT_RECEIPT_EVIDENCE_SQL = `(
  COALESCE(ri.checks, '{}'::jsonb) ? 'receiptValidation'
  OR (
    COALESCE(ri.checks->'format'->>'got', ri.checks->'format'->>'kind', '') = 'receipt'
    AND NOT (COALESCE(ri.status, '') = 'resolved' AND COALESCE(ri.resolution, '') = 'ok')
  )
)`;

// ═══════════════════════════════════════════════════════════
// 구글드라이브 용량 귀속 점검·이전 (구매캡처/리뷰 폴더)
//
// 용량은 "파일 소유자" 계정에 귀속된다. 업로드는 OAuth(tnaks6325) 소유로
// 생성되도록 구현돼 있으나, (a) 토큰이 다른 계정이거나 (b) 과거 GAS가
// 만든 파일이 관리자 소유로 남아 있으면 관리자 용량이 차감된다.
// 아래 엔드포인트로 (1) 현재 귀속 계정 확인 (2) 소유자별 용량 집계
// (3) tnaks6325로 소유권 이전을 수행한다.
// ═══════════════════════════════════════════════════════════


// (POST /relocate-orphan-reviews — 옛 대시보드 「리뷰 캡처 정리」 창 전용, 2026-09-29 제거 · 결정 186 72번)

// (POST /capture-rename-recipient — 과거 리뷰 캡처 파일명 소급 정정, 2026-10-22 제거 · 결정 272 ·
//  결정 186 90번. 실행 금지 상태로 한 번도 안 돌았다. migration 164 renamed_from 칸은 그대로 둔다.)
// (POST /review-folder-backfill — 같은 창 전용, 결정 186 72번 제거)

// (POST /share-review-folder — 같은 창 전용, 결정 186 72번 제거)

// ═══════════════════════════════════════════════════════════
// 업체 보고용 공개 링크 (탭 단위) — **이미 보낸 링크 열람만** 남긴다
//   - GET  /report/:code (공개): 코드 → 탭의 리뷰 캡처 목록 반환(이미지 자체는
//     기존 /api/drive/image/:id 프록시로 표시 → 폴더 공개공유 불필요, 원본 복제 0)
//   - (POST /report-link — 새 링크 발급, 2026-10-22 제거 · 결정 272 · 결정 186 48번.
//      발급하던 화면 버튼은 이미 없다. 이미 발급된 review_report_links 행과 report.html 은 그대로.)
// ═══════════════════════════════════════════════════════════
// GET /api/drive/report/:code — 공개: 코드 → 탭 리뷰 캡처 목록 (무인증)
//   명시적 review 원장 우선 → 비어 있으면 review_index 대표 리뷰만 사용.
//   폴더 재귀 스캔은 역할을 판별할 수 없어 현금영수증을 노출하므로 공개 경로에서 사용하지 않는다.
router.get('/report/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!/^[a-z2-9]{6,16}$/.test(code)) return res.status(404).json({ ok: false, error: '유효하지 않은 링크입니다.' });

    const { rows } = await pool.query(
      'SELECT sheet_id, tab_name, display_name FROM review_report_links WHERE code = $1 LIMIT 1',
      [code]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: '유효하지 않은 링크입니다.' });
    const { sheet_id: sheetId, tab_name: tabName, display_name: displayName } = rows[0];

    // 1) 제출 원장 우선
    let images = [];
    try {
      const sub = await pool.query(
        `SELECT rs.file_id, rs.file_name, rs.reviewer_name, rs.uploaded_at
           FROM review_submissions rs
          WHERE rs.sheet_id = $1 AND rs.tab_name = $2
            AND rs.file_id IS NOT NULL AND rs.file_id <> ''
            AND COALESCE(rs.slot_key, 'review') = 'review'
            AND NOT EXISTS (
              SELECT 1 FROM review_inspections ri
               WHERE ri.file_id = rs.file_id
                 AND ${PUBLIC_REPORT_RECEIPT_EVIDENCE_SQL}
            )
          ORDER BY reviewer_name NULLS LAST, uploaded_at ASC NULLS LAST`,
        [sheetId, tabName]
      );
      images = sub.rows.map(r => ({
        id: r.file_id,
        name: r.file_name || '',
        reviewer: (r.reviewer_name || driveService.extractReviewerNameFromFile(r.file_name) || '').trim(),
      }));
    } catch (_) {}

    // 2) 원장이 비어 있으면 명시적 대표 리뷰만 폴백
    if (images.length === 0) {
      try {
        const fallback = await pool.query(
          `SELECT r.review_file_id AS file_id, r.review_file_name AS file_name,
                  r.reviewer_name, r.review_file_at AS uploaded_at
             FROM review_index r
            WHERE r.sheet_id = $1 AND r.tab_name = $2
               AND r.review_file_id IS NOT NULL AND r.review_file_id <> ''
               AND NOT EXISTS (
                 SELECT 1 FROM review_submissions rs_role
                  WHERE rs_role.file_id = r.review_file_id
                    AND COALESCE(rs_role.slot_key, 'review') <> 'review'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM review_inspections ri
                 WHERE ri.file_id = r.review_file_id
                   AND ${PUBLIC_REPORT_RECEIPT_EVIDENCE_SQL}
              )
            ORDER BY r.reviewer_name NULLS LAST, r.review_file_at ASC NULLS LAST`,
          [sheetId, tabName]
        );
        images = fallback.rows.map(r => ({
          id: r.file_id,
          name: r.file_name || '',
          reviewer: (r.reviewer_name || driveService.extractReviewerNameFromFile(r.file_name) || '').trim(),
        }));
      } catch (e) {
        logger.warn(`[report] 대표 리뷰 폴백 실패 (${code}): ${e.message}`);
      }
    }

    res.json({
      ok: true,
      title: (displayName || tabName || '리뷰 보고'),
      count: images.length,
      images,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/drive/image/:id — Drive 이미지 스트리밍 프록시 (모달 인라인 미리보기)
//   <img src>가 헤더 인증을 못 보내므로 무인증. id는 추측 불가한 Drive fileId(20+).
//   서버 OAuth(소유자 계정)로 받아 스트리밍 → 비공개/링크공유 섞여도 표시.
//   실패 시 Drive thumbnail로 302 폴백.
// ═══════════════════════════════════════════════════════════
router.get('/image/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[-\w]{20,}$/.test(id)) return res.status(400).send('bad id');
  try {
    const f = await driveService.downloadFile(id);
    res.set('Content-Type', f.mimeType || 'application/octet-stream');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'private, max-age=600');
    return res.send(f.buffer);
  } catch (err) {
    logger.warn(`[drive] image 프록시 실패(${id}): ${err.message} → thumbnail 폴백`);
    return res.redirect(302, `https://drive.google.com/thumbnail?id=${id}&sz=w1600`);
  }
});

// (POST /orphan-capture-cleanup — 고아 캡처 수동 미리보기·정리, 2026-10-22 제거 · 결정 272 · 결정 186 73번.
//  04:40 자동 정리는 2026-10-02 에 이미 제거(결정 064 후속 2). 작업 삭제 때 남기는 묘비(134)는 그대로 기록된다.)

module.exports = router;
