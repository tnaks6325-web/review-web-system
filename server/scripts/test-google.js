#!/usr/bin/env node
/**
 * Google Service Account 연결 테스트 스크립트
 * 
 * 사용법:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL=... GOOGLE_PRIVATE_KEY="..." BASE_SHEET_ID=... node scripts/test-google.js
 * 
 * 또는 .env 파일에 설정 후:
 *   cd server && node scripts/test-google.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { readSheet, getSpreadsheetMeta, sheets } = require('../src/services/sheets.service');

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Google Service Account 연결 테스트');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // 1. 환경변수 확인
  console.log('▶ 환경변수 확인:');
  console.log(`  GOOGLE_SERVICE_ACCOUNT_EMAIL: ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? '✅ 설정됨' : '❌ 미설정'}`);
  console.log(`  GOOGLE_PRIVATE_KEY: ${process.env.GOOGLE_PRIVATE_KEY ? '✅ 설정됨 (' + process.env.GOOGLE_PRIVATE_KEY.substring(0, 30) + '...)' : '❌ 미설정'}`);
  console.log(`  BASE_SHEET_ID: ${process.env.BASE_SHEET_ID || '❌ 미설정'}`);
  console.log('');

  if (!sheets) {
    console.log('❌ Google Sheets API가 초기화되지 않았습니다.');
    console.log('   → GOOGLE_SERVICE_ACCOUNT_EMAIL 과 GOOGLE_PRIVATE_KEY 를 설정하세요.');
    process.exit(1);
  }

  const sheetId = process.env.BASE_SHEET_ID;
  if (!sheetId) {
    console.log('❌ BASE_SHEET_ID가 설정되지 않았습니다.');
    process.exit(1);
  }

  // 2. 스프레드시트 메타데이터 조회
  console.log('▶ 스프레드시트 메타데이터 조회...');
  try {
    const meta = await getSpreadsheetMeta(sheetId);
    console.log(`  ✅ 시트 수: ${meta.length}`);
    meta.slice(0, 10).forEach(s => {
      console.log(`    - ${s.properties.title} (gid: ${s.properties.sheetId}, rows: ${s.properties.gridProperties?.rowCount || '?'})`);
    });
    if (meta.length > 10) console.log(`    ... 외 ${meta.length - 10}개`);
  } catch (err) {
    console.log(`  ❌ 메타데이터 조회 실패: ${err.message}`);
    if (err.message.includes('403') || err.message.includes('not found')) {
      console.log('  → 서비스 계정에 스프레드시트 접근 권한을 부여하세요.');
    }
    process.exit(1);
  }

  // 3. 세부목록 탭 읽기 테스트
  console.log('');
  console.log('▶ 세부목록 탭 읽기 테스트...');
  try {
    const data = await readSheet(sheetId, '세부목록!A1:C5');
    console.log(`  ✅ 읽기 성공 (${data.length}행)`);
    data.forEach((row, i) => {
      console.log(`    행 ${i + 1}: ${JSON.stringify(row).substring(0, 100)}`);
    });
  } catch (err) {
    console.log(`  ⚠️ 세부목록 탭 읽기 실패: ${err.message}`);
    console.log('  (세부목록 탭이 없을 수 있음 — 정상)');
  }

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  ✅ Google Service Account 테스트 완료');
  console.log('═══════════════════════════════════════════');
  process.exit(0);
}

main().catch(err => {
  console.error('테스트 실패:', err.message);
  process.exit(1);
});
