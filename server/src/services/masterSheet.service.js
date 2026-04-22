/**
 * masterSheet.service.js
 * 마스터 구글시트 → DB(campaigns, tab_configs) 동기화 서비스
 * 
 * 마스터 시트가 원본(Source of Truth)이며,
 * 시트 데이터를 읽어서 DB를 동기화합니다.
 * 
 * 환경변수: MASTER_SHEET_ID — 마스터 구글시트의 spreadsheet ID
 */

const { readSheet } = require('./sheets.service');
const { throttledCall } = require('../utils/sheetsThrottle');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

// ── 마스터 시트 설정 ──
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID || '';
const MASTER_TAB_NAME = process.env.MASTER_TAB_NAME || 'tab_configs';  // 시트 내 탭명

// ── 시트 컬럼 → DB 컬럼 매핑 ──
const COLUMN_MAP = {
  'sheet_url':           'sheet_url',
  'campaign_name':       'campaign_name',
  'tab_name':            'tab_name',
  'manager':             'manager',
  'time_range':          'time_range',
  'taekha':              'taekhap',       // 시트: taekha → DB: taekhap
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

// BOOLEAN 타입 DB 컬럼 목록
const BOOLEAN_COLS = new Set(['taekhap', 'force_done', 'is_bulk', 'is_closed', 'nc_mode']);

/**
 * sheet_url에서 sheet_id를 추출
 * https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit... → SHEET_ID
 */
function extractSheetId(url) {
  if (!url) return null;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * 값을 BOOLEAN으로 변환
 */
function toBool(val) {
  if (val === true || val === 'TRUE' || val === 'true' || val === 1 || val === '1') return true;
  if (val === false || val === 'FALSE' || val === 'false' || val === 0 || val === '0') return false;
  return false;
}

/**
 * 마스터 시트에서 전체 데이터 읽기
 * @returns {Array<Object>} 파싱된 행 배열
 */
async function readMasterSheet() {
  if (!MASTER_SHEET_ID) {
    throw new Error('MASTER_SHEET_ID 환경변수가 설정되지 않았습니다.');
  }

  logger.info(`[masterSheet] 마스터 시트 읽기 시작: ${MASTER_SHEET_ID} / ${MASTER_TAB_NAME}`);

  const values = await throttledCall(() => readSheet(MASTER_SHEET_ID, `'${MASTER_TAB_NAME}'!A:Z`));

  if (!values || values.length < 2) {
    throw new Error('마스터 시트에 데이터가 없습니다 (헤더 + 최소 1행 필요).');
  }

  // 헤더 행 파싱
  const headers = values[0].map(h => String(h).trim().toLowerCase());
  logger.info(`[masterSheet] 헤더: ${headers.join(', ')} (${headers.length}개 컬럼)`);

  // 데이터 행 파싱
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row || row.length === 0) continue;

    const obj = {};
    headers.forEach((header, idx) => {
      const val = idx < row.length ? row[idx] : '';
      obj[header] = (val === undefined || val === null) ? '' : val;
    });

    // sheet_url과 tab_name은 필수
    if (!obj.sheet_url || !obj.tab_name) continue;

    // sheet_id 자동 추출
    obj.sheet_id = extractSheetId(obj.sheet_url);
    if (!obj.sheet_id) {
      logger.warn(`[masterSheet] 행 ${i + 1}: sheet_url에서 sheet_id 추출 실패 — ${obj.sheet_url}`);
      continue;
    }

    rows.push(obj);
  }

  logger.info(`[masterSheet] 파싱 완료: ${rows.length}행 (유효 데이터)`);
  return rows;
}

/**
 * 마스터 시트 데이터 → DB 동기화 (campaigns + tab_configs)
 * @param {boolean} dryRun - true면 미리보기만, false면 실제 실행
 * @returns {Object} 동기화 결과
 */
async function syncMasterSheetToDB(dryRun = true) {
  const startTime = Date.now();

  // 1. 마스터 시트 읽기
  const sheetRows = await readMasterSheet();

  // 2. 기존 DB 데이터 로드
  const { rows: dbCampaigns } = await pool.query('SELECT sheet_id, campaign_name, sheet_url FROM campaigns');
  const { rows: dbTabs } = await pool.query('SELECT sheet_id, tab_name, * FROM tab_configs');

  const dbCampaignSet = new Set(dbCampaigns.map(c => `${c.sheet_id}||${c.campaign_name}`));
  const dbTabMap = new Map(dbTabs.map(t => [`${t.sheet_id}||${t.tab_name}`, t]));

  // 3. 시트 데이터에서 고유 campaigns 추출
  const campaignMap = new Map();  // key: sheet_id||campaign_name
  sheetRows.forEach(row => {
    const key = `${row.sheet_id}||${row.campaign_name || ''}`;
    if (!campaignMap.has(key) && row.campaign_name) {
      campaignMap.set(key, {
        sheet_id: row.sheet_id,
        campaign_name: row.campaign_name,
        sheet_url: (row.sheet_url || '').split('#')[0],  // #gid 제거
      });
    }
  });

  // 4. 비교 및 변경사항 계산
  const results = {
    campaigns: { added: [], updated: [], removed: [], unchanged: 0 },
    tabs: { added: [], updated: [], removed: [], unchanged: 0 },
  };

  // 4-1. campaigns 비교
  for (const [key, campaign] of campaignMap) {
    if (dbCampaignSet.has(key)) {
      results.campaigns.unchanged++;
    } else {
      results.campaigns.added.push(campaign);
    }
  }

  // 기존 DB에 있지만 시트에 없는 campaigns
  for (const dbCamp of dbCampaigns) {
    const key = `${dbCamp.sheet_id}||${dbCamp.campaign_name}`;
    if (!campaignMap.has(key)) {
      results.campaigns.removed.push(dbCamp);
    }
  }

  // 4-2. tab_configs 비교
  const sheetTabKeys = new Set();
  for (const row of sheetRows) {
    const key = `${row.sheet_id}||${row.tab_name}`;
    sheetTabKeys.add(key);

    const dbTab = dbTabMap.get(key);
    if (!dbTab) {
      // 새로운 탭
      results.tabs.added.push(row);
    } else {
      // 기존 탭 — 변경사항 비교
      const changes = _compareTabRow(row, dbTab);
      if (changes.length > 0) {
        results.tabs.updated.push({ row, dbTab, changes });
      } else {
        results.tabs.unchanged++;
      }
    }
  }

  // DB에 있지만 시트에 없는 탭
  for (const dbTab of dbTabs) {
    const key = `${dbTab.sheet_id}||${dbTab.tab_name}`;
    if (!sheetTabKeys.has(key)) {
      results.tabs.removed.push(dbTab);
    }
  }

  // 5. dryRun이 아니면 실제 DB 반영
  if (!dryRun) {
    await _applyChanges(results, sheetRows);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  const summary = {
    dryRun,
    elapsed,
    sheetRows: sheetRows.length,
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

/**
 * 시트 행과 DB 행 비교 — 변경된 컬럼 목록 반환
 */
function _compareTabRow(sheetRow, dbRow) {
  const changes = [];

  for (const [sheetCol, dbCol] of Object.entries(COLUMN_MAP)) {
    if (sheetCol === 'sheet_url' || sheetCol === 'tab_name') continue; // PK는 스킵

    const sheetVal = sheetRow[sheetCol];
    let dbVal = dbRow[dbCol];

    if (BOOLEAN_COLS.has(dbCol)) {
      const sheetBool = toBool(sheetVal);
      const dbBool = toBool(dbVal);
      if (sheetBool !== dbBool) {
        changes.push({ col: dbCol, from: dbBool, to: sheetBool });
      }
    } else {
      // 문자열 비교 (빈값 통일)
      const sv = (sheetVal === undefined || sheetVal === null || sheetVal === '') ? '' : String(sheetVal).trim();
      const dv = (dbVal === undefined || dbVal === null || dbVal === '') ? '' : String(dbVal).trim();
      if (sv !== dv) {
        changes.push({ col: dbCol, from: dv, to: sv });
      }
    }
  }

  // sheet_url 비교 (sheet_id + campaign 아닌 URL 자체)
  const sheetUrl = (sheetRow.sheet_url || '').split('#')[0];
  const dbUrl = (dbRow.sheet_url || '').split('#')[0];
  if (sheetUrl && dbUrl && sheetUrl !== dbUrl) {
    changes.push({ col: 'sheet_url', from: dbUrl, to: sheetUrl });
  }

  return changes;
}

/**
 * 변경사항 DB에 실제 적용
 */
async function _applyChanges(results, sheetRows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── campaigns 추가 ──
    for (const camp of results.campaigns.added) {
      await client.query(
        `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET sheet_url = $3, updated_at = NOW()`,
        [camp.sheet_id, camp.campaign_name, camp.sheet_url]
      );
    }

    // ── campaigns 삭제 ──
    for (const camp of results.campaigns.removed) {
      await client.query(
        'DELETE FROM campaigns WHERE sheet_id = $1 AND campaign_name = $2',
        [camp.sheet_id, camp.campaign_name]
      );
    }

    // ── tab_configs 추가 ──
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
        `INSERT INTO tab_configs (${cols.join(', ')}, updated_at)
         VALUES (${placeholders}, NOW())
         ON CONFLICT (sheet_id, tab_name) DO NOTHING`,
        vals
      );
    }

    // ── tab_configs 업데이트 ──
    for (const { row, changes } of results.tabs.updated) {
      const setClauses = changes.map((ch, i) => `${ch.col} = $${i + 1}`);
      setClauses.push(`updated_at = NOW()`);
      const vals = changes.map(ch => BOOLEAN_COLS.has(ch.col) ? toBool(ch.to) : (ch.to || ''));
      vals.push(row.sheet_id, row.tab_name);

      await client.query(
        `UPDATE tab_configs SET ${setClauses.join(', ')}
         WHERE sheet_id = $${vals.length - 1} AND tab_name = $${vals.length}`,
        vals
      );
    }

    // ── tab_configs 삭제 ──
    for (const tab of results.tabs.removed) {
      await client.query(
        'DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
        [tab.sheet_id, tab.tab_name]
      );
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

/**
 * 상세 결과 생성 (프론트엔드 표시용)
 */
function _buildDetails(results, dryRun) {
  const details = [];

  // campaigns
  for (const camp of results.campaigns.added) {
    details.push({
      type: 'campaign',
      action: dryRun ? 'dry_add' : 'added',
      name: camp.campaign_name,
      sheetId: camp.sheet_id.substring(0, 12) + '...',
    });
  }
  for (const camp of results.campaigns.removed) {
    details.push({
      type: 'campaign',
      action: dryRun ? 'dry_remove' : 'removed',
      name: camp.campaign_name,
      sheetId: camp.sheet_id.substring(0, 12) + '...',
    });
  }

  // tabs
  for (const row of results.tabs.added) {
    details.push({
      type: 'tab',
      action: dryRun ? 'dry_add' : 'added',
      campaign: row.campaign_name || '',
      tabName: row.tab_name,
    });
  }
  for (const { row, changes } of results.tabs.updated) {
    details.push({
      type: 'tab',
      action: dryRun ? 'dry_update' : 'updated',
      campaign: row.campaign_name || '',
      tabName: row.tab_name,
      changes: changes.map(c => ({ col: c.col, from: c.from, to: c.to })),
    });
  }
  for (const tab of results.tabs.removed) {
    details.push({
      type: 'tab',
      action: dryRun ? 'dry_remove' : 'removed',
      campaign: tab.campaign_name || '',
      tabName: tab.tab_name,
    });
  }

  return details;
}

module.exports = {
  readMasterSheet,
  syncMasterSheetToDB,
  extractSheetId,
  MASTER_SHEET_ID,
};
