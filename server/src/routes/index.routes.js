const express = require('express');
const router = express.Router();
const { searchByName, searchByNameDebug } = require('../services/search.service');
const { buildIndexSmart, checkDirtySheets, buildOneSheet } = require('../services/indexBuilder.service');
const { authMiddleware } = require('../middleware/auth.middleware');
const { emitIndexBuild } = require('../utils/sse');
const { calcNextCronTimes } = require('../utils/cronCalc');
const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════
// GET /api/search — 이름/전화번호 검색 (GAS: searchAll)
// ═══════════════════════════════════════════════════════════
router.get('/', async (req, res, next) => {
  try {
    const { query, phone8 } = req.query;
    const result = await searchByName(query, phone8);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/search/debug — 디버그용 검색 (GAS: searchAllDebug)
// ═══════════════════════════════════════════════════════════
router.get('/debug', async (req, res, next) => {
  try {
    const { query } = req.query;
    const result = await searchByNameDebug(query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/index/build — 인덱스 빌드 (비동기: 즉시 응답 + 백그라운드 처리)
// 
// 55개+ 캠페인 × N개 탭을 Google Sheets API로 읽어오므로
// 동기 방식은 5분 이상 소요 → 프론트엔드 타임아웃 발생.
// 해결: 즉시 accepted 응답 반환 → 백그라운드에서 빌드 → 
//       프론트엔드는 /api/index/status 폴링으로 완료 감지.
// ═══════════════════════════════════════════════════════════
router.post('/build', authMiddleware, async (req, res, next) => {
  try {
    const { forceFullRebuild } = req.body;

    // 이미 빌드 중인지 확인 (잠금 상태)
    const { rows: lockRows } = await pool.query(
      "SELECT * FROM build_locks WHERE lock_key = 'INDEX_BUILD'"
    );
    if (lockRows.length > 0 && lockRows[0].is_locked) {
      const lock = lockRows[0];
      const elapsed = lock.locked_at ? Date.now() - new Date(lock.locked_at).getTime() : 0;
      // TTL(7분) 미만이면 이미 진행 중
      if (elapsed < 7 * 60 * 1000) {
        return res.json({
          ok: false,
          error: '타 사용자가 갱신중입니다. 잠시 후 다시 시도해주세요.',
          locked: true,
          elapsedSec: Math.round(elapsed / 1000),
        });
      }
    }

    // ★ 즉시 응답 반환 (accepted) — 빌드는 백그라운드에서 실행
    res.json({
      ok: true,
      success: true,
      mode: 'async',
      message: '인덱스 빌드가 시작되었습니다. 완료 시 자동으로 업데이트됩니다.',
    });

    // ★ 백그라운드에서 빌드 실행 (응답 이후 비동기 처리)
    setImmediate(async () => {
      try {
        const result = await buildIndexSmart(forceFullRebuild === true);
        console.log('[index/build] 백그라운드 빌드 완료:', JSON.stringify(result));
        // ── SSE 알림: 인덱스 빌드 완료 ──
        emitIndexBuild({
          rebuilt: result.rebuilt || 0,
          skipped: result.skipped || 0,
          errors: result.errors || 0,
          elapsed: result.elapsed || '',
          trigger: 'manual',
        });
      } catch (err) {
        console.error('[index/build] 백그라운드 빌드 실패:', err.message);
      }
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/index/status — 인덱스 현황 (GAS: indexStatus)
// ═══════════════════════════════════════════════════════════
router.get('/status', authMiddleware, async (req, res, next) => {
  try {
    const metaResult = await pool.query(
      'SELECT COUNT(*) AS count, MAX(built_at) AS built_at FROM review_index'
    );
    const meta = metaResult.rows[0] || {};

    const { rows: masterData } = await pool.query(
      `SELECT campaign_name AS "campaignName", tab_name AS "tabName",
              row_count AS "rowCount", submitted_count AS "submittedCount",
              status, checksum, built_at AS "builtAt",
              error_msg AS "errorMsg", skip_reason AS "skipReason"
       FROM index_master
       ORDER BY built_at DESC NULLS LAST`
    );

    // 빌드 잠금 상태
    let lockStatus = { isLocked: false };
    try {
      const { rows: lockRows } = await pool.query(
        "SELECT * FROM build_locks WHERE lock_key = 'INDEX_BUILD'"
      );
      if (lockRows.length > 0) {
        const lock = lockRows[0];
        lockStatus = {
          isLocked: lock.is_locked,
          lockedAt: lock.locked_at,
          lockedBy: lock.locked_by,
          elapsedSec: lock.locked_at ? Math.round((Date.now() - new Date(lock.locked_at).getTime()) / 1000) : 0,
        };
      }
    } catch (_) {}

    // 인덱스 만료 체크 (2시간)
    const builtAt = meta.built_at ? new Date(meta.built_at).getTime() : 0;
    const isExpired = (Date.now() - builtAt) > 2 * 60 * 60 * 1000;
    const indexCount = parseInt(meta.count) || 0;

    // builtAt을 KST 문자열로 변환 (프론트엔드 builtAtStr 필드)
    let builtAtStr = '-';
    if (meta.built_at) {
      const d = new Date(meta.built_at);
      builtAtStr = d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    }

    // ── 다음 자동 빌드 / 전체 재빌드 시각 계산 ──
    const cronSchedule = calcNextCronTimes();

    res.json({
      ok: true,
      // ★ 프론트엔드 호환 필드 (GAS 응답 형식 유지)
      exists: indexCount > 0,
      expired: isExpired,
      count: indexCount,
      builtAt: meta.built_at || null,
      builtAtStr,
      // 추가 메타 (구조화된 형식)
      meta: {
        count: indexCount,
        builtAt: meta.built_at || null,
        isExpired,
      },
      master: masterData,
      lock: lockStatus,
      buildLock: {
        locked: lockStatus.isLocked,
        elapsedSec: lockStatus.elapsedSec || 0,
      },
      codeVersion: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      // ★ CRON 스케줄 정보
      cron: cronSchedule,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// Phase 4: GET /api/index/dirty — 변경된 시트 감지 (경량, Drive API만)
// ═══════════════════════════════════════════════════════════
router.get('/dirty', authMiddleware, async (req, res, next) => {
  try {
    const dirtySheets = await checkDirtySheets();
    res.json({
      ok: true,
      dirtyCount: dirtySheets.length,
      dirtySheets,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// Phase 4: POST /api/index/build-sheet — 특정 시트 1개만 빌드
// ═══════════════════════════════════════════════════════════
router.post('/build-sheet', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId } = req.body;
    if (!sheetId) return res.json({ error: 'sheetId 필요' });

    // 즉시 응답
    res.json({ ok: true, mode: 'async', message: `시트 ${sheetId.substring(0, 15)}... 빌드 시작` });

    // 백그라운드 빌드
    setImmediate(async () => {
      try {
        const result = await buildOneSheet(sheetId);
        console.log('[index/build-sheet] 완료:', JSON.stringify(result));
        emitIndexBuild({
          rebuilt: result.rebuilt || 0,
          skipped: result.skipped || 0,
          errors: result.errors || 0,
          elapsed: result.elapsed || '',
          trigger: 'partial',
          sheetId,
        });
      } catch (err) {
        console.error('[index/build-sheet] 실패:', err.message);
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
