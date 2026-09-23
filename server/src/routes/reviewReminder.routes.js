'use strict';

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { withJobLock } = require('../utils/jobLock');
const reminderService = require('../services/reviewReminder.service');

router.get('/status', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    res.json(await reminderService.status());
  } catch (err) { next(err); }
});

// 기본은 dry-run이다. 실발송은 서버 킬스위치(REVIEW_REMINDER_ENABLED=1)도 켜져 있어야 한다.
router.post('/run', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const dryRun = req.body && req.body.dryRun === false ? false : true;
    const limit = Number.parseInt(String((req.body && req.body.limit) || ''), 10) || undefined;
    if (dryRun) return res.json(await reminderService.run({ dryRun: true, limit }));
    const result = await withJobLock('review_reminder_alimtalk',
      () => reminderService.run({ dryRun: false, limit }));
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
