/**
 * 세부목록 탭 → tab_configs 테이블 마이그레이션
 * 실행: cd server && node scripts/migrate-detail.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const pool = require('../src/db/pool');
const { readSheet } = require('../src/services/sheets.service');

async function migrate() {
  console.log('세부목록 마이그레이션 시작...');
  const BASE_SHEET_ID = process.env.BASE_SHEET_ID;

  try {
    // 세부목록 탭 전체 읽기
    const values = await readSheet(BASE_SHEET_ID, '세부목록!A:U');
    if (!values || values.length < 2) {
      console.log('세부목록 데이터 없음');
      return;
    }

    const header = values[0].map(h => String(h || '').trim());
    const dataRows = values.slice(1);

    let inserted = 0, skipped = 0;

    for (const row of dataRows) {
      const tabName = getCol(row, header, 'tab_name');
      if (!tabName) { skipped++; continue; }

      const sheetUrl = getCol(row, header, 'sheet_url');
      const sheetId  = extractSheetId(sheetUrl);
      if (!sheetId) { skipped++; continue; }

      try {
        await pool.query(`
          INSERT INTO tab_configs (
            sheet_id, tab_name, sheet_url, manager, time_range, taekhap,
            review_type, payment_type, display_name, folder_url,
            is_bulk, capture_folder_url, is_closed, delivery_type, round,
            nc_mode, deposit_name, transfer_bank, income_type, campaign_name
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
            manager = EXCLUDED.manager,
            time_range = EXCLUDED.time_range,
            updated_at = NOW()
        `, [
          sheetId, tabName, sheetUrl,
          getCol(row, header, 'manager'),
          getCol(row, header, 'time_range'),
          toBoolean(getCol(row, header, 'taekhap')),
          getCol(row, header, 'review_type'),
          getCol(row, header, 'payment_type'),
          getCol(row, header, 'display_name'),
          getCol(row, header, 'folder_url'),
          toBoolean(getCol(row, header, 'is_bulk')),
          getCol(row, header, 'capture_folder_url'),
          toBoolean(getCol(row, header, 'is_closed')),
          getCol(row, header, 'delivery_type'),
          getCol(row, header, 'round'),
          toBoolean(getCol(row, header, 'nc_mode')),
          getCol(row, header, 'deposit_name'),
          getCol(row, header, 'transfer_bank'),
          getCol(row, header, 'income_type'),
          getCol(row, header, 'campaign_name'),
        ]);
        inserted++;
        if (inserted % 10 === 0) console.log(`  → ${inserted}건 처리 중...`);
      } catch (err) {
        console.error(`  ✗ 오류 (${tabName}):`, err.message);
      }
    }

    console.log(`✅ 마이그레이션 완료: ${inserted}건 삽입, ${skipped}건 스킵`);
  } catch (err) {
    console.error('마이그레이션 오류:', err);
  } finally {
    await pool.end();
  }
}

function getCol(row, header, key) {
  const idx = header.indexOf(key);
  return idx >= 0 ? String(row[idx] || '').trim() : '';
}

function toBoolean(val) {
  return ['TRUE','true','1','yes'].includes(String(val || '').trim());
}

function extractSheetId(url) {
  const m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

migrate();
