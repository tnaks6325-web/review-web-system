/**
 * masterSheet.service.js
 * 마스터 구글시트 ↔ DB(campaigns, tab_configs) 동기화 서비스
 * 
 * 기능 1: scanAndPopulateMaster() — 29개 광고주 시트를 스캔해서 마스터 시트를 최신 탭명으로 자동 채움
 * 기능 2: syncMasterSheetToDB()  — 마스터 시트 → DB 동기화
 * 
 * 환경변수: MASTER_SHEET_ID, MASTER_TAB_NAME
 */

const { readSheet, writeSheet, getSpreadsheetMeta } = require('./sheets.service');
const { throttledCall, throttledMap } = require('../utils/sheetsThrottle');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

// ── 마스터 시트 설정 ──
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID || '';
const MASTER_TAB_NAME = process.env.MASTER_TAB_NAME || 'tab_configs';

// ── 마스터 시트 헤더 (고정 순서) ──
const MASTER_HEADERS = [
  'sheet_url', 'campaign_name', 'tab_name', 'manager', 'time_range',
  'taekha', 'review_type', 'payment_type', 'display_name', 'updated_at',
  'force_done', 'folder_url', 'is_bulk', 'capture_folder_url', 'is_closed',
  'delivery_type', 'round', 'nc_mode', 'deposit_name', 'transfer_bank', 'income_type',
];

// ── 시트 컬럼 → DB 컬럼 매핑 ──
const COLUMN_MAP = {
  'sheet_url':           'sheet_url',
  'campaign_name':       'campaign_name',
  'tab_name':            'tab_name',
  'manager':             'manager',
  'time_range':          'time_range',
  'taekha':              'taekhap',
  'review_type':         'review_type',
  'payment_type':        'payment_type',
  'display_name':        'display_name',
  'force_done':          'force_done',
  'folder_url':          'folder_url',
  'is_bulk':             'is_bulk',
  'capture_folder_url':  'capture_folder_url',
  'is_closed':           'is_closed',
  'delivery_type':       'delivery_type',
  'round':               'round',
  'nc_mode':             'nc_mode',
  'deposit_name':        'deposit_name',
  'transfer_bank':       'transfer_bank',
  'income_type':         'income_type',
};

const BOOLEAN_COLS = new Set(['taekhap', 'force_done', 'is_bulk', 'is_closed', 'nc_mode']);

// ── 인덱스 빌더에서 사용하는 시스템 탭 키워드 (스캔 시 제외) ──
const SYSTEM_TAB_KEYWORDS = [
  '검색인덱스', '세부목록', '캠페인목록', '시트목록', '설정',
  '매크로', '서식', '요약', '대시보드', '템플릿', '양식',
];

function extractSheetId(url) {
  if (!url) return null;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function toBool(val) {
  if (val === true || val === 'TRUE' || val === 'true' || val === 1 || val === '1') return true;
  return false;
}

function isSystemTab(tabName) {
  const lower = tabName.toLowerCase();
  return SYSTEM_TAB_KEYWORDS.some(kw => lower.includes(kw));
}

// ══════════════════════════════════════════════════════════════
// 기능 1: 광고주 시트 스캔 → 마스터 시트 자동 채우기
// ══════════════════════════════════════════════════════════════

/**
 * 마스터 시트의 실제 탭명을 자동 감지
 * getSpreadsheetMeta로 탭 목록을 조회한 뒤 첫 번째 탭명 반환
 */
async function _detectMasterTabName() {
  if (!MASTER_SHEET_ID) throw new Error('MASTER_SHEET_ID 환경변수 미설정');

  const meta = await throttledCall(() => getSpreadsheetMeta(MASTER_SHEET_ID));
  if (!meta || meta.length === 0) throw new Error('마스터 시트 메타데이터 조회 실패');

  // MASTER_TAB_NAME과 일치하는 탭이 있으면 사용, 없으면 첫 번째 탭 사용
  const matchTab = meta.find(s => s.properties.title === MASTER_TAB_NAME);
  const tabName = matchTab ? MASTER_TAB_NAME : meta[0].properties.title;

  logger.info(`[masterSheet] 탭명 감지: "${tabName}" (설정: "${MASTER_TAB_NAME}", 실제 탭 수: ${meta.length})`);
  return tabName;
}

/**
 * 29개 광고주 시트를 스캔해서 마스터 시트를 최신 탭명으로 자동 채움
 * @param {boolean} dryRun - true면 미리보기만, false면 실제 마스터 시트에 쓰기
 */
async function scanAndPopulateMaster(dryRun = true) {
  const startTime = Date.now();
  if (!MASTER_SHEET_ID) throw new Error('MASTER_SHEET_ID 환경변수 미설정');

  // 1. DB에서 시트 목록 + 기존 tab_configs 로드
  const { rows: campaignRows } = await pool.query(
    'SELECT DISTINCT sheet_id, campaign_name, sheet_url FROM campaigns'
  );
  const { rows: dbTabs } = await pool.query('SELECT * FROM tab_configs');

  // 기존 tab_configs를 sheet_id+tab_name으로 맵핑 (설정값 보존용)
  const dbTabMap = new Map();
  dbTabs.forEach(t => dbTabMap.set(`${t.sheet_id}||${t.tab_name}`, t));

  // campaign_name을 sheet_id로 매핑
  const campaignNameMap = new Map();
  campaignRows.forEach(c => {
    if (!campaignNameMap.has(c.sheet_id)) {
      campaignNameMap.set(c.sheet_id, c.campaign_name);
    }
  });

  // 고유 sheet_id 목록
  const sheetIds = [...new Set(campaignRows.map(r => r.sheet_id))].filter(Boolean);
  logger.info(`[scanMaster] 스캔 시작: ${sheetIds.length}개 시트`);

  // 2. 각 시트를 스캔 (throttle 적용, 동시 3개)
  const scanResults = [];
  let totalTabs = 0, errorCount = 0;
  const errors = [];

  await throttledMap(sheetIds, async (sheetId) => {
    try {
      const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
      if (!meta || meta.length === 0) {
        errors.push({ sheetId: sheetId.substring(0, 15), error: '메타데이터 조회 실패' });
        errorCount++;
        return;
      }

      const campaignName = campaignNameMap.get(sheetId) || meta._spreadsheetTitle || '';
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

      for (const sheet of meta) {
        const tabName = sheet.properties.title;
        const tabGid = String(sheet.properties.sheetId);

        // 시스템 탭 제외
        if (isSystemTab(tabName)) continue;

        // 기존 DB 설정값이 있으면 보존
        const existingConfig = dbTabMap.get(`${sheetId}||${tabName}`);

        scanResults.push({
          sheet_id: sheetId,
          sheet_url: sheetUrl,
          campaign_name: campaignName,
          tab_name: tabName,
          tab_gid: tabGid,
          // 기존 설정값 보존 (있으면 사용, 없으면 빈값)
          manager:            existingConfig?.manager || '',
          time_range:         existingConfig?.time_range || '',
          taekhap:            existingConfig?.taekhap || false,
          review_type:        existingConfig?.review_type || '',
          payment_type:       existingConfig?.payment_type || '',
          display_name:       existingConfig?.display_name || '',
          force_done:         existingConfig?.force_done || false,
          folder_url:         existingConfig?.folder_url || '',
          is_bulk:            existingConfig?.is_bulk || false,
          capture_folder_url: existingConfig?.capture_folder_url || '',
          is_closed:          existingConfig?.is_closed || false,
          delivery_type:      existingConfig?.delivery_type || '',
          round:              existingConfig?.round || '',
          nc_mode:            existingConfig?.nc_mode || false,
          deposit_name:       existingConfig?.deposit_name || '',
          transfer_bank:      existingConfig?.transfer_bank || '',
          income_type:        existingConfig?.income_type || '',
          _isNew: !existingConfig,  // DB에 없는 새 탭 표시
        });
        totalTabs++;
      }
    } catch (err) {
      errors.push({ sheetId: sheetId.substring(0, 15), error: err.message });
      errorCount++;
    }
  }, 3);

  logger.info(`[scanMaster] 스캔 완료: ${sheetIds.length}개 시트 → ${totalTabs}개 탭, 오류 ${errorCount}건`);

  // 3. 마스터 시트 현재 데이터 읽기 (비교용)
  let existingRows = 0;
  let newTabs = scanResults.filter(r => r._isNew).length;
  let preservedTabs = scanResults.filter(r => !r._isNew).length;

  // 4. dryRun이 아니면 마스터 시트에 쓰기
  if (!dryRun) {
    await _writeMasterSheet(scanResults);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  return {
    dryRun,
    elapsed,
    sheetsScanned: sheetIds.length,
    totalTabs,
    newTabs,
    preservedTabs,
    errors: errorCount,
    errorDetails: errors.slice(0, 10),
    // 미리보기용 상세 데이터 (최대 200개)
    preview: scanResults.slice(0, 200).map(r => ({
      campaign: r.campaign_name,
      tabName: r.tab_name,
      isNew: r._isNew,
      sheetId: r.sheet_id.substring(0, 12) + '...',
    })),
  };
}

/**
 * 스캔 결과를 마스터 시트에 쓰기
 */
async function _writeMasterSheet(rows) {
  const tabName = await _detectMasterTabName();

  // 헤더 행 + 데이터 행 구성
  const values = [MASTER_HEADERS];

  for (const row of rows) {
    values.push(MASTER_HEADERS.map(header => {
      if (header === 'taekha') return row.taekhap ? 'TRUE' : '';
      if (header === 'force_done') return row.force_done ? 'TRUE' : '';
      if (header === 'is_bulk') return row.is_bulk ? 'TRUE' : '';
      if (header === 'is_closed') return row.is_closed ? 'TRUE' : '';
      if (header === 'nc_mode') return row.nc_mode ? 'TRUE' : '';
      if (header === 'updated_at') return new Date().toISOString().replace('T', ' ').substring(0, 19);
      return row[header] || '';
    }));
  }

  const range = `'${tabName}'!A1:U${values.length}`;
  logger.info(`[masterSheet] 마스터 시트 쓰기: ${range} (${values.length - 1}행)`);

  await throttledCall(() => writeSheet(MASTER_SHEET_ID, range, values));

  // 기존 데이터가 더 많았을 경우 나머지 행 삭제 (빈 행으로 덮어쓰기)
  // 안전을 위해 500행까지 빈 행으로 클리어
  const clearStart = values.length + 1;
  const clearEnd = Math.max(clearStart, 500);
  const emptyRows = [];
  for (let i = clearStart; i <= clearEnd; i++) {
    emptyRows.push(MASTER_HEADERS.map(() => ''));
  }
  if (emptyRows.length > 0) {
    try {
      await throttledCall(() => writeSheet(
        MASTER_SHEET_ID,
        `'${tabName}'!A${clearStart}:U${clearEnd}`,
        emptyRows
      ));
    } catch (_) {
      // 범위 초과 등 무시
    }
  }

  logger.info(`[masterSheet] 마스터 시트 쓰기 완료: ${values.length - 1}행`);
}


// ══════════════════════════════════════════════════════════════
// 기능 2: 마스터 시트 → DB 동기화 (기존 기능)
// ══════════════════════════════════════════════════════════════

async function readMasterSheet() {
  if (!MASTER_SHEET_ID) throw new Error('MASTER_SHEET_ID 환경변수 미설정');

  // ★ 탭명 자동 감지
  const tabName = await _detectMasterTabName();
  logger.info(`[masterSheet] 마스터 시트 읽기: ${MASTER_SHEET_ID} / "${tabName}"`);

  const values = await throttledCall(() => readSheet(MASTER_SHEET_ID, `'${tabName}'!A:Z`));

  if (!values || values.length < 2) {
    throw new Error('마스터 시트에 데이터가 없습니다 (헤더 + 최소 1행 필요).');
  }

  const headers = values[0].map(h => String(h).trim().toLowerCase());
  logger.info(`[masterSheet] 헤더: ${headers.join(', ')} (${headers.length}개 컬럼)`);

  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row || row.length === 0) continue;

    const obj = {};
    headers.forEach((header, idx) => {
      const val = idx < row.length ? row[idx] : '';
      obj[header] = (val === undefined || val === null) ? '' : val;
    });

    if (!obj.sheet_url || !obj.tab_name) continue;

    obj.sheet_id = extractSheetId(obj.sheet_url);
    if (!obj.sheet_id) continue;

    rows.push(obj);
  }

  logger.info(`[masterSheet] 파싱 완료: ${rows.length}행`);
  return rows;
}

async function syncMasterSheetToDB(dryRun = true) {
  const startTime = Date.now();

  const sheetRows = await readMasterSheet();

  const { rows: dbCampaigns } = await pool.query('SELECT sheet_id, campaign_name, sheet_url FROM campaigns');
  const { rows: dbTabs } = await pool.query('SELECT sheet_id, tab_name, * FROM tab_configs');

  const dbCampaignSet = new Set(dbCampaigns.map(c => `${c.sheet_id}||${c.campaign_name}`));
  const dbTabMap = new Map(dbTabs.map(t => [`${t.sheet_id}||${t.tab_name}`, t]));

  const campaignMap = new Map();
  sheetRows.forEach(row => {
    const key = `${row.sheet_id}||${row.campaign_name || ''}`;
    if (!campaignMap.has(key) && row.campaign_name) {
      campaignMap.set(key, {
        sheet_id: row.sheet_id,
        campaign_name: row.campaign_name,
        sheet_url: (row.sheet_url || '').split('#')[0],
      });
    }
  });

  const results = {
    campaigns: { added: [], updated: [], removed: [], unchanged: 0 },
    tabs: { added: [], updated: [], removed: [], unchanged: 0 },
  };

  for (const [key, campaign] of campaignMap) {
    if (dbCampaignSet.has(key)) results.campaigns.unchanged++;
    else results.campaigns.added.push(campaign);
  }
  for (const dbCamp of dbCampaigns) {
    const key = `${dbCamp.sheet_id}||${dbCamp.campaign_name}`;
    if (!campaignMap.has(key)) results.campaigns.removed.push(dbCamp);
  }

  const sheetTabKeys = new Set();
  for (const row of sheetRows) {
    const key = `${row.sheet_id}||${row.tab_name}`;
    sheetTabKeys.add(key);
    const dbTab = dbTabMap.get(key);
    if (!dbTab) {
      results.tabs.added.push(row);
    } else {
      const changes = _compareTabRow(row, dbTab);
      if (changes.length > 0) results.tabs.updated.push({ row, dbTab, changes });
      else results.tabs.unchanged++;
    }
  }
  for (const dbTab of dbTabs) {
    const key = `${dbTab.sheet_id}||${dbTab.tab_name}`;
    if (!sheetTabKeys.has(key)) results.tabs.removed.push(dbTab);
  }

  if (!dryRun) await _applyChanges(results, sheetRows);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
  const summary = {
    dryRun, elapsed, sheetRows: sheetRows.length,
    campaigns: {
      added: results.campaigns.added.length,
      removed: results.campaigns.removed.length,
      unchanged: results.campaigns.unchanged,
    },
    tabs: {
      added: results.tabs.added.length,
      updated: results.tabs.updated.length,
      removed: results.tabs.removed.length,
      unchanged: results.tabs.unchanged,
    },
    details: _buildDetails(results, dryRun),
  };

  logger.info(`[masterSheet] 동기화 ${dryRun ? '미리보기' : '완료'}: ` +
    `campaigns(+${summary.campaigns.added}/-${summary.campaigns.removed}), ` +
    `tabs(+${summary.tabs.added}/~${summary.tabs.updated}/-${summary.tabs.removed}) — ${elapsed}`);

  return summary;
}

function _compareTabRow(sheetRow, dbRow) {
  const changes = [];
  for (const [sheetCol, dbCol] of Object.entries(COLUMN_MAP)) {
    if (sheetCol === 'sheet_url' || sheetCol === 'tab_name') continue;
    const sheetVal = sheetRow[sheetCol];
    let dbVal = dbRow[dbCol];
    if (BOOLEAN_COLS.has(dbCol)) {
      if (toBool(sheetVal) !== toBool(dbVal)) changes.push({ col: dbCol, from: toBool(dbVal), to: toBool(sheetVal) });
    } else {
      const sv = (sheetVal === undefined || sheetVal === null || sheetVal === '') ? '' : String(sheetVal).trim();
      const dv = (dbVal === undefined || dbVal === null || dbVal === '') ? '' : String(dbVal).trim();
      if (sv !== dv) changes.push({ col: dbCol, from: dv, to: sv });
    }
  }
  const sheetUrl = (sheetRow.sheet_url || '').split('#')[0];
  const dbUrl = (dbRow.sheet_url || '').split('#')[0];
  if (sheetUrl && dbUrl && sheetUrl !== dbUrl) changes.push({ col: 'sheet_url', from: dbUrl, to: sheetUrl });
  return changes;
}

async function _applyChanges(results, sheetRows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const camp of results.campaigns.added) {
      await client.query(
        `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET sheet_url = $3, updated_at = NOW()`,
        [camp.sheet_id, camp.campaign_name, camp.sheet_url]
      );
    }
    for (const camp of results.campaigns.removed) {
      await client.query('DELETE FROM campaigns WHERE sheet_id = $1 AND campaign_name = $2',
        [camp.sheet_id, camp.campaign_name]);
    }

    for (const row of results.tabs.added) {
      const cols = ['sheet_id', 'tab_name', 'sheet_url', 'campaign_name'];
      const vals = [row.sheet_id, row.tab_name, (row.sheet_url || '').split('#')[0], row.campaign_name || ''];
      for (const [sheetCol, dbCol] of Object.entries(COLUMN_MAP)) {
        if (['sheet_url', 'campaign_name', 'tab_name'].includes(sheetCol)) continue;
        cols.push(dbCol);
        vals.push(BOOLEAN_COLS.has(dbCol) ? toBool(row[sheetCol]) : (row[sheetCol] || ''));
      }
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(
        `INSERT INTO tab_configs (${cols.join(', ')}, updated_at) VALUES (${placeholders}, NOW())
         ON CONFLICT (sheet_id, tab_name) DO NOTHING`, vals);
    }

    for (const { row, changes } of results.tabs.updated) {
      const setClauses = changes.map((ch, i) => `${ch.col} = $${i + 1}`);
      setClauses.push(`updated_at = NOW()`);
      const vals = changes.map(ch => BOOLEAN_COLS.has(ch.col) ? toBool(ch.to) : (ch.to || ''));
      vals.push(row.sheet_id, row.tab_name);
      await client.query(
        `UPDATE tab_configs SET ${setClauses.join(', ')}
         WHERE sheet_id = $${vals.length - 1} AND tab_name = $${vals.length}`, vals);
    }

    for (const tab of results.tabs.removed) {
      await client.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
        [tab.sheet_id, tab.tab_name]);
    }

    await client.query('COMMIT');
    logger.info(`[masterSheet] DB 반영 완료`);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[masterSheet] DB 반영 실패 — ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

function _buildDetails(results, dryRun) {
  const details = [];
  for (const camp of results.campaigns.added) {
    details.push({ type: 'campaign', action: dryRun ? 'dry_add' : 'added', name: camp.campaign_name, sheetId: camp.sheet_id.substring(0, 12) + '...' });
  }
  for (const camp of results.campaigns.removed) {
    details.push({ type: 'campaign', action: dryRun ? 'dry_remove' : 'removed', name: camp.campaign_name, sheetId: camp.sheet_id.substring(0, 12) + '...' });
  }
  for (const row of results.tabs.added) {
    details.push({ type: 'tab', action: dryRun ? 'dry_add' : 'added', campaign: row.campaign_name || '', tabName: row.tab_name });
  }
  for (const { row, changes } of results.tabs.updated) {
    details.push({ type: 'tab', action: dryRun ? 'dry_update' : 'updated', campaign: row.campaign_name || '', tabName: row.tab_name,
      changes: changes.map(c => ({ col: c.col, from: c.from, to: c.to })) });
  }
  for (const tab of results.tabs.removed) {
    details.push({ type: 'tab', action: dryRun ? 'dry_remove' : 'removed', campaign: tab.campaign_name || '', tabName: tab.tab_name });
  }
  return details;
}

module.exports = {
  readMasterSheet,
  syncMasterSheetToDB,
  scanAndPopulateMaster,
  extractSheetId,
  MASTER_SHEET_ID,
};
