/**
 * 캠페인탭 로스터 DB 원장 (Phase 1 · shadow) — master 전용 테스트 도구.
 *
 * ★ 라이브 무영향: 전 라우트 master 전용 + 신규 테이블(campaign_participants)만 read/write.
 *   검색·my-status·대시보드·시트·주문 흐름을 일절 건드리지 않는다. 소스 전환은 후속 Phase(별도 게이트).
 *   즉 이 라우트는 배포돼도 리뷰어·일반 관리자에게 보이지 않고 닿지 않는다.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware, masterOnlyMiddleware } = require('../middleware/auth.middleware');
const svc = require('../services/participants.service');

function _by(req) { return String((req.admin && (req.admin.name || req.admin.role)) || 'master').slice(0, 100); }

// POST /api/participants/import { sheetId, tabName, dryRun? } — review_index→DB 백필(멱등)
router.post('/import', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, dryRun } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const out = await svc.importTabFromIndex({ sheetId, tabName, dryRun: dryRun === true, by: _by(req) });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// GET /api/participants?sheetId&tabName — DB 로스터 조회(phone8 마스킹)
router.get('/', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, limit } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const items = await svc.listParticipants({ sheetId, tabName, limit });
    res.json({ ok: true, count: items.length, items });
  } catch (err) { next(err); }
});

// GET /api/participants/compare?sheetId&tabName — shadow 충실도 대조(DB vs review_index)
router.get('/compare', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const out = await svc.compareWithIndex({ sheetId, tabName });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// POST /api/participants/sync { sheetId?, tabName? } — DB를 review_index에서 최신화(수동편집 보존).
//   sheetId/tabName 주면 그 탭만, 없으면 이미 가져온 전 탭. 시트 재읽기 0(review_index=DB). master 전용.
router.post('/sync', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (sheetId && tabName) {
      const out = await svc.importTabFromIndex({ sheetId, tabName, by: _by(req) });
      return res.json({ ok: true, tab: tabName, ...out });
    }
    // bulk sync 는 Track B 투영 cron 과 같은 락으로 상호배제(seen-set/오버레이 합성 안정).
    const { withJobLock } = require('../utils/jobLock');
    const out = await withJobLock('trackb_project', () => svc.syncImportedTabs({ by: _by(req) }));
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// GET /api/participants/tabs — 프리뷰 탭 셀렉터용 활성 캠페인 탭(master 전용)
router.get('/tabs', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const tabs = await svc.listActiveTabs({ limit: req.query.limit });
    res.json({ ok: true, count: tabs.length, tabs });
  } catch (err) { next(err); }
});

// POST /api/participants/status { id, isSubmitted?, isPaid? } — 테스트용 토글(신규 테이블만)
router.post('/status', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { id, isSubmitted, isPaid } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id 필수' });
    const out = await svc.setParticipantStatus({ id, isSubmitted, isPaid, by: _by(req) });
    if (!out.updated) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// ── Phase 2a: 참여자 추가/수정/삭제 (신규 테이블만 · master 전용 · 라이브 무영향) ──

// POST /api/participants/add { sheetId, tabName, reviewerName, recipientName?, phone?, round?, optionText?, productName? }
router.post('/add', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.sheetId || !b.tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    if (!b.reviewerName && !b.phone) return res.status(400).json({ ok: false, error: '이름 또는 연락처 중 하나는 필요' });
    const out = await svc.addParticipant({ ...b, by: _by(req) });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// POST /api/participants/update { id, reviewerName?, recipientName?, phone?, round?, optionText?, productName? }
router.post('/update', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ ok: false, error: 'id 필수' });
    const fields = {};
    if (b.reviewerName !== undefined) fields.reviewer_name = b.reviewerName;
    if (b.recipientName !== undefined) fields.recipient_name = b.recipientName;
    if (b.phone !== undefined) fields.phone8 = b.phone;
    if (b.round !== undefined) fields.round = b.round;
    if (b.optionText !== undefined) fields.option_text = b.optionText;
    if (b.productName !== undefined) fields.product_name = b.productName;
    const out = await svc.updateParticipant({ id: b.id, fields, by: _by(req) });
    if (!out.updated) return res.status(out.reason === 'no_editable_fields' ? 400 : 404).json({ ok: false, error: out.reason || 'not_found' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// POST /api/participants/delete { id } — 소프트삭제(신규 테이블만)
router.post('/delete', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id 필수' });
    const out = await svc.softDeleteParticipant({ id, by: _by(req) });
    if (!out.deleted) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// ── Phase 2b: 탭단위 DB→시트 되쓰기 트리거 (master 전용 · 게이트 이중 · 기본 OFF) ──
router.post('/mirror-tab', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    if (process.env.PARTICIPANTS_SHEET_MIRROR !== '1')
      return res.status(403).json({ ok: false, error: '시트 미러 비활성(PARTICIPANTS_SHEET_MIRROR)' });
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const out = await require('../services/participantMirror.service').enqueueTabMirror({ sheetId, tabName, by: _by(req) });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

module.exports = router;
