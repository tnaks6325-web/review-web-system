/**
 * 외부모집 구매양식 관리자 수동제출 라우트 — 전부 admin/master 전용.
 *
 * ★ 무인증인 `/api/submit/order` 를 재사용하지 않는 이유: 그 경로는 loginPhone8 이 없으면
 *   신원게이트 전체를 건너뛰도록 설계돼 있다(레거시 호환). 관리자 기능의 정식 문을 그 우회로에
 *   두면 무인증 표면이 그대로 노출된다 → 별도 인증 라우트 + 서비스 재사용.
 */
const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { parseSlashForm } = require('../utils/slashForm');
const { submitExternalOrder } = require('../services/manualOrder.service');
const { logger } = require('../utils/logger');

const MAX_LINES = 50;   // 한 번에 처리할 최대 건수(오붙여넣기로 수백 건이 들어가는 사고 방지)

// ── 파싱 미리보기 (읽기 전용) ────────────────────────────────
// 제출 전에 9칸 분해 결과를 사람이 확인·수정하게 한다. DB 접근 없음.
router.post('/preview', authMiddleware, adminOrMasterMiddleware, (req, res) => {
  const text = String((req.body && req.body.text) || '');
  const all = parseSlashForm(text);
  const items = all.slice(0, MAX_LINES);
  res.json({
    ok: true, items,
    truncated: all.length > MAX_LINES ? all.length - MAX_LINES : 0,
    okCount: items.filter(i => i.ok).length,
    errCount: items.filter(i => !i.ok).length,
  });
});

// ── 제출 ─────────────────────────────────────────────────────
// body: { sheetId, tabName, gid, campaignId?, items:[{fields, optionKey?, orderNum?}] }
// ★ 건별 독립 처리 — 일부 실패해도 성공 건은 접수된다(카톡 재수집 비용 회피).
router.post('/submit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { sheetId, tabName, gid, campaignId } = b;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });

    const items = Array.isArray(b.items) ? b.items.slice(0, MAX_LINES) : [];
    if (!items.length) return res.status(400).json({ ok: false, error: '제출할 건이 없습니다' });

    const adminName = (req.admin && req.admin.name) || '';
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const f = it.fields || {};
      // 서버측 재검증 — 프론트 미리보기를 우회한 직접 호출 방어.
      // ★ 자릿수까지 본다: phone8이 8자리가 안 되면 검색·행배정·정원 키가 전부 어긋난다.
      const missing = ['recipient', 'phone', 'address', 'bank', 'account', 'depositor']
        .filter(k => !String(f[k] == null ? '' : f[k]).trim());
      if (missing.length) {
        results.push({ index: i, ok: false, error: '필수 항목이 비어 있습니다: ' + missing.join(', '), name: f.recipient || '' });
        continue;
      }
      const pd = String(f.phone).replace(/[^0-9]/g, '');
      if (pd.length !== 11 && pd.length !== 10) {
        results.push({ index: i, ok: false, error: `전화번호 자릿수가 이상합니다 (${pd.length}자리)`, name: f.recipient || '' });
        continue;
      }
      try {
        const r = await submitExternalOrder({
          sheetId, tabName, gid: gid || '',
          fields: f,
          campaignId: campaignId || null,
          optionKey: it.optionKey || '',
          adminName,
          force: b.force === true,   // 중복 경고를 확인한 뒤 재시도할 때만
        });
        results.push({ index: i, name: f.recipient || '', ...r });
      } catch (e) {
        logger.error(`[manual-order] 건별 실패 idx=${i}: ${e.message}`);
        results.push({ index: i, ok: false, name: f.recipient || '', error: e.message });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    logger.info(`[manual-order] 제출 완료 tab=${tabName} ${okCount}/${results.length} by=${adminName}`);
    res.json({ ok: true, okCount, failCount: results.length - okCount, results });
  } catch (err) { next(err); }
});

module.exports = router;
