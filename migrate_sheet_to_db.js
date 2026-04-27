/**
 * 일회성 이관 스크립트: 이관시트 CSV → DB tab_configs 업데이트
 * 
 * 매칭 전략:
 *   - tab_name 기준 매칭 (DB에 이미 존재하는 탭만 UPDATE)
 *   - 이관시트 값으로 덮어쓰기 (overwrite)
 * 
 * 업데이트 필드:
 *   manager, time_range, review_type, display_name,
 *   capture_folder_url, folder_url, is_closed
 */

const fs = require('fs');
const csv = require('csv-parse/sync');

const PROD_URL = 'https://sublime-magic-production-790b.up.railway.app';
const MASTER_NAME = 'master';
const MASTER_PW = '931118';

async function main() {
  console.log('=== 이관 스크립트 시작 ===\n');

  // 1. 로그인 → JWT 토큰 획득
  console.log('[1/5] 프로덕션 서버 로그인...');
  const loginRes = await fetch(`${PROD_URL}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: MASTER_NAME, pw: MASTER_PW }),
  });
  const loginData = await loginRes.json();
  if (!loginData.success || !loginData.token) {
    console.error('로그인 실패:', loginData);
    process.exit(1);
  }
  const TOKEN = loginData.token;
  console.log('  ✅ 로그인 성공\n');

  // 2. DB에서 전체 tab_configs 조회
  console.log('[2/5] DB tab_configs 전체 조회...');
  const configRes = await fetch(`${PROD_URL}/api/tab/config`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const configData = await configRes.json();
  if (!configData.ok) {
    console.error('tab_configs 조회 실패:', configData);
    process.exit(1);
  }
  const dbConfigs = configData.configs;
  console.log(`  ✅ DB tab_configs: ${dbConfigs.length}개\n`);

  // 3. tab_name → [{sheet_id, tab_name, ...}] 매핑 생성
  //    동일 tab_name이 여러 sheet_id에 존재할 수 있음
  const tabNameMap = {};
  for (const cfg of dbConfigs) {
    const key = cfg.tab_name.trim();
    if (!tabNameMap[key]) tabNameMap[key] = [];
    tabNameMap[key].push(cfg);
  }
  const uniqueTabNames = Object.keys(tabNameMap).length;
  const duplicateNames = Object.entries(tabNameMap).filter(([, v]) => v.length > 1);
  console.log(`  DB 고유 tab_name: ${uniqueTabNames}개`);
  if (duplicateNames.length > 0) {
    console.log(`  ⚠ 중복 tab_name: ${duplicateNames.length}개 (동일 탭명이 여러 sheet_id에 존재)`);
    for (const [name, entries] of duplicateNames.slice(0, 5)) {
      console.log(`    "${name}" → ${entries.length}개 시트`);
    }
  }
  console.log();

  // 4. CSV 파싱
  console.log('[3/5] 이관시트 CSV 파싱...');
  const csvContent = fs.readFileSync('/home/user/webapp/migration_sheet.csv', 'utf-8');
  const records = csv.parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  console.log(`  ✅ CSV 행: ${records.length}개\n`);

  // 5. 매칭 & 업데이트
  console.log('[4/5] tab_name 매칭 → 업데이트 실행...\n');

  let matched = 0;
  let notFound = 0;
  let updated = 0;
  let errors = 0;
  let skippedDuplicate = 0;
  const notFoundList = [];
  const updateResults = [];

  for (const row of records) {
    const tabName = (row.tab_name || '').trim();
    if (!tabName) continue;

    const dbEntries = tabNameMap[tabName];
    if (!dbEntries || dbEntries.length === 0) {
      notFound++;
      notFoundList.push(tabName);
      continue;
    }

    matched++;

    // is_closed 처리: "TRUE" → true, 그 외(공란 포함) → false
    const isClosed = (row.is_closed || '').toUpperCase() === 'TRUE';

    // 모든 매칭된 DB 엔트리에 대해 업데이트
    for (const dbEntry of dbEntries) {
      const payload = {
        sheetId: dbEntry.sheet_id,
        tabName: tabName,
        manager: row.manager || '',
        timeRange: row.time_range || '',
        reviewType: row.review_type || '',
        displayName: row.display_name || '',
        captureFolderUrl: row.capture_folder_url || '',
        folderUrl: row.folder_url || '',
      };

      try {
        // POST /api/tab/config 호출 (UPSERT)
        const updateRes = await fetch(`${PROD_URL}/api/tab/config`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify(payload),
        });
        const updateData = await updateRes.json();

        if (updateData.ok) {
          updated++;
        } else {
          errors++;
          console.error(`  ❌ 업데이트 실패: "${tabName}" (sheet_id=${dbEntry.sheet_id.substring(0, 15)}...): ${JSON.stringify(updateData)}`);
        }

        // is_closed 업데이트 (별도 API)
        if (isClosed !== dbEntry.is_closed) {
          const closedRes = await fetch(`${PROD_URL}/api/tab/closed`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${TOKEN}`,
            },
            body: JSON.stringify({
              sheetId: dbEntry.sheet_id,
              tabs: [{ tabName: tabName, isClosed: isClosed }],
            }),
          });
          const closedData = await closedRes.json();
          if (!closedData.ok) {
            console.error(`  ❌ is_closed 업데이트 실패: "${tabName}": ${JSON.stringify(closedData)}`);
          }
        }

        updateResults.push({
          tabName,
          sheetId: dbEntry.sheet_id.substring(0, 15) + '...',
          status: 'updated',
          isClosed,
        });
      } catch (err) {
        errors++;
        console.error(`  ❌ API 오류: "${tabName}": ${err.message}`);
      }

      // API Rate limit 방지: 50ms 간격
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // 6. 결과 리포트
  console.log('\n[5/5] === 이관 결과 ===');
  console.log(`  CSV 행 수:       ${records.length}`);
  console.log(`  DB 매칭됨:       ${matched}`);
  console.log(`  DB 미발견:       ${notFound}`);
  console.log(`  업데이트 성공:   ${updated}`);
  console.log(`  업데이트 실패:   ${errors}`);

  if (notFoundList.length > 0) {
    console.log(`\n  --- DB에서 찾지 못한 tab_name (총 ${notFoundList.length}개) ---`);
    for (const name of notFoundList.slice(0, 20)) {
      console.log(`    • "${name}"`);
    }
    if (notFoundList.length > 20) {
      console.log(`    ... 외 ${notFoundList.length - 20}개`);
    }
  }

  console.log('\n=== 이관 완료 ===');
}

main().catch(err => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
