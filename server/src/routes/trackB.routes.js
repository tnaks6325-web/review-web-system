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
const participants = require('../services/participants.service');

function _by(req) { return String((req.admin && (req.admin.name || req.admin.role)) || 'admin').slice(0, 100); }
function _role(req) { return (req.admin && req.admin.role) || ''; }

// ── 그림자 투영(라이브 읽어 B 최신화) — master 전용 ──
router.post('/project', authMiddleware, masterOnlyMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (sheetId && tabName) return res.json({ ok: true, ...(await svc.projectTab({ sheetId, tabName, by: _by(req) })) });
    // bulk 투영은 cron(trackb_project 락)과 상호배제 — 멀티인스턴스 이중투영·seen-set 플래핑 차단.
    const { withJobLock } = require('../utils/jobLock');
    const r = await withJobLock('trackb_project', () => svc.projectActive({ by: _by(req) }));
    res.json({ ok: true, ...r });
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

// ── 작업/소유 UI 공용: 활성 탭 목록 — adminOrMaster(그림자 콘솔 스코프) ──
//   participants/tabs 는 master 전용이라 admin이 소유 지정 화면의 시트 피커를 못 채운다.
//   Track B 콘솔은 adminOrMaster 이므로 같은 읽기전용 목록을 네임스페이스 내에서 재노출한다.
router.get('/tabs', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const tabs = await participants.listActiveTabs({ limit: req.query.limit });
    res.json({ ok: true, count: tabs.length, tabs });
  } catch (err) { next(err); }
});

// ── 관측 대시보드: 투영된 전 탭 롤업(카운트 대조 + 준비도) — adminOrMaster ──
router.get('/overview', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await svc.overview() }); }
  catch (err) { next(err); }
});

// ── 소유 지정 UI 좌측: 업체 목록 + 소유수 — admin/master ──
router.get('/advertisers', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try { res.json({ ok: true, items: await svc.listAdvertisersWithOwnership() }); }
  catch (err) { next(err); }
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
    // ★ staff PII 구멍 봉합: master/admin(전체) · advertiser(스코프+마스킹)만. staff·reviewer 하드차단.
    const role = _role(req);
    if (!['master', 'admin', 'advertiser'].includes(role)) return res.status(403).json({ ok: false, error: '작업대 열람 권한이 없습니다.' });
    const { sheetId, tabName, tabGid } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const advertiserId = (req.admin && req.admin.advertiser_id) || null;
    const out = await svc.workdeskTab({ sheetId, tabName, tabGid: tabGid || null, role, advertiserId });
    if (out.denied) return res.status(403).json({ ok: false, error: '소유하지 않은 작업(스코프 밖)' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// ── 통합 작업대 편집(오버레이) — adminOrMaster 라우트레벨 강제(advertiser/staff 하드차단). ──
//   rowId ∈ (sheetId,tabName) 재검증·앵커 산출·거부조건은 서비스가 수행.
router.post('/workdesk/edit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId, field, value } = req.body || {};
    if (!sheetId || !tabName || !rowId || !field) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId, field 필수' });
    const out = await svc.editWorkdeskRow({ sheetId, tabName, rowId, field, value, by: _by(req) });
    res.status(out.ok ? 200 : (out.error === 'concurrent_edit_conflict' ? 409 : 400)).json(out);
  } catch (err) { next(err); }
});
router.post('/workdesk/revert', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId, field } = req.body || {};
    if (!sheetId || !tabName || !rowId || !field) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId, field 필수' });
    res.json(await svc.revertWorkdeskEdit({ sheetId, tabName, rowId, field, by: _by(req) }));
  } catch (err) { next(err); }
});
router.post('/workdesk/hide', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, rowId } = req.body || {};
    if (!sheetId || !tabName || !rowId) return res.status(400).json({ ok: false, error: 'sheetId, tabName, rowId 필수' });
    res.json(await svc.hideWorkdeskRow({ sheetId, tabName, rowId, by: _by(req) }));
  } catch (err) { next(err); }
});
router.post('/workdesk/add', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, reviewerName, recipientName, phone, round, optionText, productName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    res.json({ ok: true, ...(await svc.addWorkdeskRow({ sheetId, tabName, reviewerName, recipientName, phone, round, optionText, productName, by: _by(req) })) });
  } catch (err) { next(err); }
});

module.exports = router;
