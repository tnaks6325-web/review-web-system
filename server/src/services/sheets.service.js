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
    fields: 'sheets(properties(sheetId,title,gridProperties))',
  });
  return res.data.sheets;
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

module.exports = {
  readSheet,
  writeSheet,
  appendSheet,
  getSpreadsheetMeta,
  batchReadSheet,
  sheets,
  drive,
  auth,
};
