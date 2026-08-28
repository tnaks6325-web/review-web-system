'use strict';

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const consolidation = require('../services/workboardConsolidation.service');

function actor(req) { return String((req.admin && (req.admin.name || req.admin.username)) || '').slice(0, 100); }

router.get('/status', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    res.json({ ok: true, control: await consolidation.getControl(), targets: await consolidation.listApprovedTargets() });
  } catch (err) { next(err); }
});

// 기존 무시트 작업의 승인 목록을 정확히 120건으로 최초 1회 고정한다.
router.post('/targets/approve-legacy', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (!req.body || req.body.confirm !== 'LOCK-APPROVED-120-WORKBOARDS') {
      return res.status(400).json({ ok: false, code: 'confirmation_required', error: '확인 문자열이 필요합니다.' });
    }
    const out = await consolidation.approveLegacyTargets({ targets: req.body.targets, by: actor(req) });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

// 전환 직전 대상별 원장·작업보드·리뷰·입금 참조를 sealed 스냅샷으로 보관한다.
router.post('/backups', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const out = await consolidation.createPreCutoverBackup({
      targets: req.body && req.body.targets,
      reason: req.body && req.body.reason,
      createdBy: actor(req),
    });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

// 1단계: sealed 백업과 동일한 대상에만 nullable workboard_id를 연결한다.
router.post('/mappings', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (!req.body || req.body.confirm !== 'CREATE-WORKBOARD-PILOT-MAPPINGS') {
      return res.status(400).json({ ok: false, code: 'confirmation_required', error: '확인 문자열이 필요합니다.' });
    }
    const out = await consolidation.createAdditiveMappings({
      backupId: req.body.backupId, targets: req.body.targets, by: actor(req),
    });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

// pilot은 승인·연결된 작업 1건만, enabled는 승인된 120건이 모두 연결된 경우만 허용한다.
router.post('/mode', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const mode = req.body && req.body.mode;
    const expected = mode === 'pilot' ? 'START-ONE-WORKBOARD-PILOT' : 'ENABLE-APPROVED-120-WORKBOARDS';
    if (!req.body || req.body.confirm !== expected) {
      return res.status(400).json({ ok: false, code: 'confirmation_required', error: '확인 문자열이 필요합니다.' });
    }
    const control = await consolidation.setControlMode({ mode, targets: req.body.targets, by: actor(req) });
    res.json({ ok: true, control });
  } catch (err) { next(err); }
});

// 이 단계에서는 데이터 삭제·복원을 하지 않는다. 즉시 새 경로를 막아 기존 경로로 되돌린다.
router.post('/rollback-mode', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (!req.body || req.body.confirm !== 'ROLLBACK-WORKBOARD-CONSOLIDATION') {
      return res.status(400).json({ ok: false, code: 'confirmation_required', error: '확인 문자열이 필요합니다.' });
    }
    const control = await consolidation.rollbackToLegacy({ backupId: req.body.backupId || null, by: actor(req) });
    res.json({ ok: true, control });
  } catch (err) { next(err); }
});

// 1단계 연결 자체도 되돌릴 때만 사용한다. 새 경로가 활성화되기 전의 가산적 데이터만 대상으로 한다.
router.post('/rollback-mappings', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (!req.body || req.body.confirm !== 'REVERT-WORKBOARD-PILOT-MAPPINGS') {
      return res.status(400).json({ ok: false, code: 'confirmation_required', error: '확인 문자열이 필요합니다.' });
    }
    await consolidation.rollbackToLegacy({ backupId: req.body.backupId || null, by: actor(req) });
    const out = await consolidation.revertAdditiveMappings({ backupId: req.body.backupId, by: actor(req) });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
