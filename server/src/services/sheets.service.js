const { google } = require('googleapis');
const fs = require('fs');

// Service Account 인증 초기화
const getAuth = () => {
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && fs.existsSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)) {
    credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    credentials = {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  } else {
    console.warn('⚠️ Google Service Account 미설정 — Sheets/Drive API 사용 불가');
    return null;
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
};

let auth, sheets, drive;

try {
  auth = getAuth();
  if (auth) {
    sheets = google.sheets({ version: 'v4', auth });
    drive  = google.drive({ version: 'v3', auth });
  }
} catch (err) {
  console.warn('Google API 초기화 실패:', err.message);
}

/**
 * 시트 전체 데이터 읽기 (GAS: SpreadsheetApp.openById + getValues)
 *
 * ★ 탭 이름에 슬래시(/)가 포함되면 values.get의 path parameter가 깨지므로
 *   batchGet (query parameter 방식)을 사용하여 우회합니다.
 */
async function readSheet(spreadsheetId, range) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');

  // 슬래시가 range(탭 이름 부분)에 포함된 경우 batchGet 사용
  // values.get은 range를 URL path에 넣어서 '/'가 경로 구분자로 해석됨
  if (range && range.includes('/')) {
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [range],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const valueRanges = res.data.valueRanges || [];
    return (valueRanges[0] && valueRanges[0].values) || [];
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return res.data.values || [];
}

/**
 * 시트 데이터 쓰기 (GAS: setValues)
 *
 * ★ 탭 이름에 슬래시(/)가 포함되면 values.update의 path parameter가 깨지므로
 *   batchUpdate (query parameter 방식)를 사용하여 우회합니다.
 */
async function writeSheet(spreadsheetId, range, values) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');

  if (range && range.includes('/')) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: [{ range, values }],
      },
    });
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/**
 * 시트 단일 셀/행 추가 (GAS: appendRow)
 *
 * ★ 탭 이름에 슬래시(/)가 포함되면 values.append의 path parameter가 깨지므로
 *   batchUpdate로 마지막 행 뒤에 쓰는 방식으로 우회합니다.
 *   (append는 batchGet처럼 쿼리 파라미터를 지원하지 않으므로, 먼저 데이터를 읽고 다음 행에 write)
 */
async function appendSheet(spreadsheetId, range, values) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');

  if (range && range.includes('/')) {
    // range 형식: '탭이름'!A:Z 또는 '탭이름'!A1:ZZ500 등
    // append 대신: batchGet으로 현재 데이터 길이 파악 후 해당 행에 write
    // 간단한 방법: values.append도 실제로는 range를 request body에 넣지 않고
    // URL path에 넣으므로, 직접 HTTP 요청을 구성하거나 batchUpdate 활용
    // 
    // 가장 안전한 방법: spreadsheets.values.append는 range가 path param이므로
    // 우회책으로 시트 데이터를 읽고 다음 빈 행에 write
    const tabMatch = range.match(/^'([^']*(?:''[^']*)*)'!/);
    const tabName = tabMatch ? tabMatch[1].replace(/''/g, "'") : null;

    if (tabName) {
      // 현재 데이터 행 수 파악
      const existing = await readSheet(spreadsheetId, `'${tabName}'!A:A`);
      const nextRow = (existing ? existing.length : 0) + 1;
      const writeRange = `'${tabName}'!A${nextRow}`;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: [{ range: writeRange, values }],
        },
      });
      return;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

/**
 * 스프레드시트 메타데이터 조회 (GAS: getSheets())
 */
async function getSpreadsheetMeta(spreadsheetId) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
    fields: 'properties(title),sheets(properties(sheetId,title,hidden,gridProperties))',
  });
  // 스프레드시트 제목을 각 시트 메타에 첨부하여 반환
  const spreadsheetTitle = res.data.properties?.title || '';
  const sheetsArr = res.data.sheets || [];
  sheetsArr._spreadsheetTitle = spreadsheetTitle;
  return sheetsArr;
}

/**
 * 배치 읽기 — 여러 범위 한 번에 읽기
 */
async function batchReadSheet(spreadsheetId, ranges) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return res.data.valueRanges || [];
}

/**
 * Drive API로 스프레드시트 최종 수정시각 조회
 * 인덱스 빌드 시 변경 여부를 빠르게 판단 (API 1회 = ~100ms)
 * @returns {string|null} ISO 8601 문자열 (예: "2026-04-17T05:00:00.000Z")
 */
async function getSheetModifiedTime(spreadsheetId) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');
  const res = await drive.files.get({
    fileId: spreadsheetId,
    fields: 'modifiedTime',
  });
  return res.data.modifiedTime || null;
}

/**
 * 스프레드시트 복사 (Drive API — 새 파일 생성)
 * @returns {{ id, name, url }}
 */
async function copySpreadsheet(sourceSpreadsheetId, newTitle) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');
  const res = await drive.files.copy({
    fileId: sourceSpreadsheetId,
    requestBody: { name: newTitle },
    fields: 'id, name',
  });
  const id = res.data.id;
  return {
    id,
    name: res.data.name,
    url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  };
}

/**
 * 시트(탭) 복사 — 소스 스프레드시트의 특정 탭을 대상 스프레드시트에 복사
 * @returns {{ sheetId, title }}
 */
async function copySheetToSpreadsheet(sourceSpreadsheetId, sourceSheetId, destSpreadsheetId) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');
  const res = await sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: sourceSpreadsheetId,
    sheetId: sourceSheetId,
    requestBody: { destinationSpreadsheetId: destSpreadsheetId },
  });
  return {
    sheetId: res.data.sheetId,
    title: res.data.title,
  };
}

/**
 * 시트(탭) 이름 변경
 */
async function renameSheet(spreadsheetId, sheetId, newTitle) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId, title: newTitle },
          fields: 'title',
        },
      }],
    },
  });
}

module.exports = {
  readSheet,
  writeSheet,
  appendSheet,
  getSpreadsheetMeta,
  batchReadSheet,
  getSheetModifiedTime,
  copySpreadsheet,
  copySheetToSpreadsheet,
  renameSheet,
  sheets,
  drive,
  auth,
};
