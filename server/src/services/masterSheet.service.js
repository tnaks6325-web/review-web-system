/**
 * masterSheet.service.js
 * ★ [DEPRECATED — v11.8.0] 2탭 통합으로 전면 폐기
 *
 * 이 서비스는 구글시트 "tab_configs" 탭 ↔ DB 동기화를 담당했으나,
 * 2탭 통합(시트DB + 탭목록)으로 인해 tab_configs 탭 자체가 제거되었습니다.
 *
 * - 설정 데이터(manager, folder_url 등)의 원본은 DB입니다 (POST /api/tab/config).
 * - 구조 데이터(sheet_url, tab_name 등)는 인덱스 스캔(indexScan.service.js)이 담당합니다.
 *
 * 남아있는 import에 대한 하위 호환성을 위해 모든 함수를 no-op/deprecated로 유지합니다.
 */

const { logger } = require('../utils/logger');

const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID || '';

function extractSheetId(url) {
  if (!url) return null;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── 모든 함수를 deprecated 스텁으로 교체 ──

async function readMasterSheet() {
  logger.warn('[masterSheet] DEPRECATED: readMasterSheet() — 이 함수는 더 이상 사용되지 않습니다. indexScan.service.js를 사용하세요.');
  return [];
}

async function syncMasterSheetToDB(dryRun = true) {
  logger.warn('[masterSheet] DEPRECATED: syncMasterSheetToDB() — 2탭 통합으로 제거됨. indexScan.service.js → syncTabListToDB()를 사용하세요.');
  return { dryRun, deprecated: true, message: 'masterSheet.service.js는 v11.8.0부터 폐기되었습니다. indexScan 경로를 사용하세요.' };
}

async function scanAndPopulateMaster(dryRun = true) {
  logger.warn('[masterSheet] DEPRECATED: scanAndPopulateMaster() — 2탭 통합으로 제거됨. indexScan.service.js → runIndexScan()을 사용하세요.');
  return { dryRun, deprecated: true, message: 'masterSheet.service.js는 v11.8.0부터 폐기되었습니다. 인덱스 스캔을 사용하세요.' };
}

async function applyCachedScanAndSync() {
  logger.warn('[masterSheet] DEPRECATED: applyCachedScanAndSync() — 2탭 통합으로 제거됨.');
  return { deprecated: true, message: 'masterSheet.service.js는 v11.8.0부터 폐기되었습니다.' };
}

function hasScanCache() {
  return false;
}

async function syncSettingsOnly(dryRun = true) {
  logger.warn('[masterSheet] DEPRECATED: syncSettingsOnly() — DB가 설정 원본이므로 시트→DB 설정 동기화가 불필요합니다.');
  return { dryRun, deprecated: true, updated: 0, unchanged: 0, message: '설정 동기화는 더 이상 필요하지 않습니다. DB가 설정 원본입니다.' };
}

module.exports = {
  readMasterSheet,
  syncMasterSheetToDB,
  scanAndPopulateMaster,
  applyCachedScanAndSync,
  hasScanCache,
  syncSettingsOnly,
  extractSheetId,
  MASTER_SHEET_ID,
};
