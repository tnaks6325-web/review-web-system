/**
 * mapping.routes.js — 명시적 컬럼 매핑 API (2a)
 *
 *   GET  /api/mapping/fields           — 표준 DB 필드 레지스트리 (드롭다운용)
 *   GET  /api/mapping/coverage          — 활성 탭별 매핑 커버리지/출처 집계 (admin/master)
 *   GET  /api/mapping/drift             — 감지 드리프트(매핑 거부→키워드 폴백) 탭 목록 (admin/master)
 *   GET  /api/mapping?sheetId=&gid=     — 탭의 컬럼 매핑(저장값+자동추측 병합)
 *   POST /api/mapping                   — 탭 컬럼 매핑 저장 (admin/master)
 *
 * 인증: 조회는 로그인, 저장·집계는 admin/master 전용.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { getFieldRegistry, getMapping, saveMapping } = require('../services/columnMapping.service');

// ── 표준 필드 목록 ──
router.get('/fields', authMiddleware, (req, res) => {
  res.json({ ok: true, fields: getFieldRegistry() });
});

// ── 매핑 커버리지 집계 (컬럼 판정 DB화 1단계 관측) ──
// 활성 탭(대시보드와 동일한 아카이브 제외) 기준 매핑 보유율 + 출처(auto/manual) + 드리프트 여부
router.get('/coverage', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT im.sheet_id, im.tab_name, im.tab_gid, im.campaign_name,
             im.detect_source, im.detect_drift, im.detected_at,
             COALESCE(m.mapped_fields, 0) AS mapped_fields,
             m.updated_by AS mapping_updated_by, m.updated_at AS mapping_updated_at
      FROM index_master im
      LEFT JOIN (
        SELECT sheet_id, tab_gid,
               COUNT(*) FILTER (WHERE db_field IS NOT NULL) AS mapped_fields,
               MAX(updated_by) AS updated_by, MAX(updated_at) AS updated_at
        FROM tab_column_mappings
        GROUP BY sheet_id, tab_gid
      ) m ON im.sheet_id = m.sheet_id AND im.tab_gid = m.tab_gid
      WHERE im.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM index_master_archive ima
          WHERE ima.sheet_id = im.sheet_id
            AND (ima.tab_name = im.tab_name OR (ima.tab_gid IS NOT NULL AND ima.tab_gid = im.tab_gid))
        )
      ORDER BY im.campaign_name NULLS LAST, im.tab_name
    `);

    const tabs = rows.map(r => ({
      sheetId: r.sheet_id,
      tabName: r.tab_name,
      tabGid: r.tab_gid,
      campaignName: r.campaign_name,
      mappedFields: parseInt(r.mapped_fields, 10) || 0,
      mappingUpdatedBy: r.mapping_updated_by || null,
      mappingUpdatedAt: r.mapping_updated_at || null,
      drift: Array.isArray(r.detect_drift) ? r.detect_drift : [],
      detectedAt: r.detected_at || null,
      noGid: !r.tab_gid, // gid 없는 탭은 매핑 불가(키워드 전용 유지)
    }));

    const stats = {
      total: tabs.length,
      mapped: tabs.filter(t => t.mappedFields > 0).length,
      unmapped: tabs.filter(t => t.mappedFields === 0 && !t.noGid).length,
      noGid: tabs.filter(t => t.noGid).length,
      drifting: tabs.filter(t => t.drift.length > 0).length,
      byProvenance: {
        auto: tabs.filter(t => t.mappedFields > 0 && t.mappingUpdatedBy === 'auto:detect').length,
        manual: tabs.filter(t => t.mappedFields > 0 && t.mappingUpdatedBy !== 'auto:detect').length,
      },
    };

    res.json({ ok: true, stats, tabs });
  } catch (err) {
    next(err);
  }
});

// ── 드리프트 목록 — 저장 매핑이 재앵커/범위가드로 거부돼 키워드 폴백 중인 활성 탭 ──
router.get('/drift', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sheet_id, tab_name, tab_gid, campaign_name, detect_drift, detected_at
      FROM index_master
      WHERE status = 'active'
        AND detect_drift IS NOT NULL
        AND jsonb_typeof(detect_drift) = 'array'
        AND jsonb_array_length(detect_drift) > 0
      ORDER BY campaign_name NULLS LAST, tab_name
    `);
    res.json({
      ok: true,
      count: rows.length,
      tabs: rows.map(r => ({
        sheetId: r.sheet_id,
        tabName: r.tab_name,
        tabGid: r.tab_gid,
        campaignName: r.campaign_name,
        drift: r.detect_drift,
        detectedAt: r.detected_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── 탭 매핑 조회 ──
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, gid } = req.query;
    if (!sheetId || !gid) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid 파라미터가 필요합니다.' });
    }
    const result = await getMapping(sheetId, String(gid));
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── 탭 매핑 저장 ──
router.post('/', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, columns } = req.body || {};
    if (!sheetId || !gid) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid가 필요합니다.' });
    }
    if (!Array.isArray(columns)) {
      return res.status(400).json({ ok: false, error: 'columns 배열이 필요합니다.' });
    }
    const updatedBy = req.admin?.name || 'admin';
    const result = await saveMapping(sheetId, String(gid), tabName, columns, updatedBy);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
