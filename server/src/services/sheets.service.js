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
 */
async function readSheet(spreadsheetId, range) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return res.data.values || [];
}

/**
 * 시트 데이터 쓰기 (GAS: setValues)
 */
async function writeSheet(spreadsheetId, range, values) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/**
 * 시트 단일 셀/행 추가 (GAS: appendRow)
 */
async function appendSheet(spreadsheetId, range, values) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');
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
