/**
 * Track B — 백그라운드 평행 트랙(통합 작업대의 그림자) 라우트.
 *
 * ★ 무영향·격리: 투영/대조/소유/작업대는 master 전용. 작업대 읽기는 advertiser(광고주)에게도
 *   "본인 소유 탭만" 열되(스코프 강제 + PII 마스킹), 라이브 검색·주문·시트 흐름을 일절 안 건드린다.
 *   되돌리기 = app.js 마운트 제거.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware, masterOnlyMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const svc = require('../services/trackB.service');

function _by(req) { return String((req.admin && (req.admin.name || req.admin.role)) || 'admin').slice(0, 100); }
function _role(req) { return (req.admin && req.admin.role) || ''; }

// ── 그림자 투영(라이브 읽어 B 최신화) — master 전용 ──
router.post('/project', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (sheetId && tabName) return res.json({ ok: true, ...(await svc.projectTab({ sheetId, tabName, by: _by(req) })) });
    res.json({ ok: true, ...(await svc.projectActive({ by: _by(req) })) });
  } catch (err) { next(err); }
});

// ── parity 리포트(B ↔ A, 6차원×3버킷) — master 전용 ──
router.get('/parity', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json({ ok: true, ...(await svc.parityReport({ sheetId, tabName })) });
  } catch (err) { next(err); }
});

// ── 업체 소유 매핑(1:N) — admin/master ──
router.get('/ownership', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await svc.listOwnership({ advertiserId: req.query.advertiserId, sheetId: req.query.sheetId }) }); }
  catch (err) { next(err); }
});
router.post('/ownership', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { advertiserId, sheetId, tabGid } = req.body || {};
    if (!advertiserId || !sheetId) return res.status(400).json({ ok: false, error: 'advertiserId, sheetId 필수' });
    res.json({ ok: true, ...(await svc.setOwnership({ advertiserId, sheetId, tabGid: tabGid || null, by: _by(req) })) });
  } catch (err) { next(err); }
});
router.delete('/ownership', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { advertiserId, sheetId, tabGid } = req.body || {};
    if (!advertiserId || !sheetId) return res.status(400).json({ ok: false, error: 'advertiserId, sheetId 필수' });
    res.json({ ok: true, ...(await svc.removeOwnership({ advertiserId, sheetId, tabGid: tabGid || null })) });
  } catch (err) { next(err); }
});

// ── 통합 작업대 데이터(읽기): 세부+명단+상태. 역할 렌즈(광고주는 소유 스코프+PII 마스킹) ──
router.get('/workdesk', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, tabGid } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const role = _role(req);
    const advertiserId = (req.admin && req.admin.advertiser_id) || null;
    const out = await svc.workdeskTab({ sheetId, tabName, tabGid: tabGid || null, role, advertiserId });
    if (out.denied) return res.status(403).json({ ok: false, error: '소유하지 않은 작업(스코프 밖)' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

module.exports = router;
