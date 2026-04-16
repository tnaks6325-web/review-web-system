/**
 * 인애드명단 시트 → reviewers 테이블 마이그레이션
 * 실행: cd server && node scripts/migrate-reviewers.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const pool = require('../src/db/pool');
const { readSheet } = require('../src/services/sheets.service');

async function migrate() {
  console.log('리뷰어 명단 마이그레이션 시작...');
  const BASE_SHEET_ID = process.env.BASE_SHEET_ID;

  try {
    // 인애드명단 탭 읽기
    const values = await readSheet(BASE_SHEET_ID, '인애드명단!A:I');
    if (!values || values.length < 2) {
      console.log('데이터 없음');
      return;
    }

    const header = values[0].map(h => String(h || '').trim());
    const dataRows = values.slice(1);
    let inserted = 0;

    for (const row of dataRows) {
      const name  = String(row[header.indexOf('이름')] || '').trim();
      const phone = String(row[header.indexOf('전화번호')] || '').replace(/[^0-9]/g, '');
      if (!name || phone.length !== 11) continue;

      const consent    = String(row[header.indexOf('동의여부')] || '').toLowerCase() !== 'false';
      const status     = String(row[header.indexOf('상태')] || 'active').trim() || 'active';
      const incomeType = String(row[header.indexOf('소득명의')] || '').trim();
      const subAccts   = (() => {
        try { return JSON.parse(row[header.indexOf('sub_accounts')] || '[]'); }
        catch { return []; }
      })();

      try {
        await pool.query(`
          INSERT INTO reviewers (name, phone, consent, status, income_type, sub_accounts)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (phone) DO UPDATE SET
            name = EXCLUDED.name, status = EXCLUDED.status
        `, [name, phone, consent, status, incomeType, JSON.stringify(subAccts)]);
        inserted++;
      } catch (err) {
        console.error(`  ✗ 오류 (${name}/${phone}):`, err.message);
      }
    }

    console.log(`✅ 리뷰어 마이그레이션 완료: ${inserted}건`);
  } catch (err) {
    console.error('마이그레이션 오류:', err);
  } finally {
    await pool.end();
  }
}

migrate();
