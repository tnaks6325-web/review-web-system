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

module.exports = router;
