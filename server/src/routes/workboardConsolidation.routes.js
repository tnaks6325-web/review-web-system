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

/* (전환 준비 입구 targets/approve-legacy · backups · mappings · mode 와 rollback-mappings 는 2026-08-28 enabled 전환
   완료(대상 165 전부 enabled) 뒤 미사용으로 2026-10-02 제거 — 결정 186 71번. 함수는 workboardConsolidation.service 에 있다.)
   ★★ 아래 rollback-mode 는 **비상 정지 스위치**라 남긴다(완화 금지) — enabled 경로에 이상(중복 활성 줄·참조 누락·
      큐 재시도 급증)이 생기면 새 경로를 즉시 막고 미처리분을 legacy 복구 경로로 넘긴다(docs/prd-workboard-consolidation.md). */

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

module.exports = router;
