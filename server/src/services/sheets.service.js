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
 * ★ 탭 이름에 슬래시(/)가 포함되면 values.get / batchGet 모두 파싱 실패
 *   → spreadsheets.get + includeGridData 방식으로 GID 기반 조회 사용
 */
async function readSheet(spreadsheetId, range) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');

  // 슬래시가 range(탭 이름 부분)에 포함된 경우: GID 기반 gridData 방식 사용
  if (range && range.includes('/')) {
    return await _readSheetByGridData(spreadsheetId, range);
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return res.data.values || [];
}

/**
 * GID 기반 시트 데이터 읽기 (슬래시 포함 탭 이름 우회)
 * spreadsheets.getByDataFilter 사용 — range 파싱 문제를 완전히 회피
 * range 형식: '탭이름'!A1:ZZ500 또는 '탭이름'!A:A 등
 */
async function _readSheetByGridData(spreadsheetId, range) {
  // 탭 이름 추출
  const tabMatch = range.match(/^'([^']*(?:''[^']*)*)'!/);
  const tabName = tabMatch ? tabMatch[1].replace(/''/g, "'") : null;
  if (!tabName) {
    throw new Error(`탭 이름을 추출할 수 없습니다: ${range}`);
  }

  // 범위 파싱 (A1:ZZ500 → startRow, endRow, startCol, endCol)
  const cellRange = range.replace(/^'[^']*(?:''[^']*)*'!/, '');
  const { startRow, endRow, startCol, endCol } = _parseA1Range(cellRange);

  // 스프레드시트 메타에서 GID 찾기
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
    fields: 'sheets(properties(sheetId,title,gridProperties))',
  });

  const targetSheet = (meta.data.sheets || []).find(s => s.properties.title === tabName);
  if (!targetSheet) {
    throw new Error(`시트를 찾을 수 없습니다: ${tabName}`);
  }

  const sheetId = targetSheet.properties.sheetId;
  const maxRows = targetSheet.properties.gridProperties?.rowCount || 1000;
  const maxCols = targetSheet.properties.gridProperties?.columnCount || 26;

  const actualEndRow = endRow > 0 ? Math.min(endRow, maxRows) : maxRows;
  const actualEndCol = endCol > 0 ? Math.min(endCol, maxCols) : maxCols;

  // getByDataFilter로 GID 기반 데이터 조회 (range 파싱 문제 완전 회피)
  const filterRes = await sheets.spreadsheets.getByDataFilter({
    spreadsheetId,
    requestBody: {
      dataFilters: [{
        gridRange: {
          sheetId: sheetId,
          startRowIndex: startRow - 1,
          endRowIndex: actualEndRow,
          startColumnIndex: startCol - 1,
          endColumnIndex: actualEndCol,
        }
      }],
      includeGridData: true,
    },
  });

  const sheetsData = filterRes.data.sheets || [];
  const rowData = sheetsData[0]?.data?.[0]?.rowData || [];

  // rowData를 2D 배열로 변환 (readSheet 반환 형식과 동일)
  const result = [];
  for (const row of rowData) {
    const cells = [];
    const values = row?.values || [];
    for (let c = 0; c < actualEndCol - (startCol - 1); c++) {
      const cell = values[c];
      if (!cell || !cell.effectiveValue) {
        cells.push('');
      } else if (cell.effectiveValue.numberValue !== undefined) {
        cells.push(cell.effectiveValue.numberValue);
      } else if (cell.effectiveValue.stringValue !== undefined) {
        cells.push(cell.effectiveValue.stringValue);
      } else if (cell.effectiveValue.boolValue !== undefined) {
        cells.push(cell.effectiveValue.boolValue);
      } else if (cell.effectiveValue.formulaValue !== undefined) {
        cells.push(cell.formattedValue || '');
      } else {
        cells.push(cell.formattedValue || '');
      }
    }
    result.push(cells);
  }

  return result;
}

/**
 * A1 범위 문자열을 파싱 (예: A1:ZZ500 → {startRow, endRow, startCol, endCol})
 */
function _parseA1Range(rangeStr) {
  // A:A, A1:Z500, A1:ZZ500 등
  const match = rangeStr.match(/^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/i);
  if (!match) {
    return { startRow: 1, endRow: 500, startCol: 1, endCol: 702 }; // 기본값 ZZ=702
  }

  const startCol = _colToNum(match[1]);
  const startRow = match[2] ? parseInt(match[2]) : 1;
  const endCol = match[3] ? _colToNum(match[3]) : startCol;
  const endRow = match[4] ? parseInt(match[4]) : 0; // 0 = 끝까지

  return { startRow, endRow, startCol, endCol };
}

/**
 * 열 문자를 숫자로 변환 (A=1, Z=26, AA=27, ZZ=702)
 */
function _colToNum(col) {
  let num = 0;
  for (let i = 0; i < col.length; i++) {
    num = num * 26 + (col.charCodeAt(i) - 64);
  }
  return num;
}

/**
 * 시트 데이터 쓰기 (GAS: setValues)
 *
 * ★ 탭 이름에 슬래시(/)가 포함되면 values.update의 path parameter가 깨지므로
 *   spreadsheets.batchUpdate + updateCells (GID 기반)로 우회합니다.
 */
async function writeSheet(spreadsheetId, range, values) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');

  if (range && range.includes('/')) {
    await _writeSheetByGridData(spreadsheetId, range, values);
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
 * GID 기반 시트 쓰기 (슬래시 포함 탭 이름 우회)
 */
async function _writeSheetByGridData(spreadsheetId, range, values) {
  const tabMatch = range.match(/^'([^']*(?:''[^']*)*)'!/);
  const tabName = tabMatch ? tabMatch[1].replace(/''/g, "'") : null;
  if (!tabName) throw new Error(`탭 이름을 추출할 수 없습니다: ${range}`);

  const cellRange = range.replace(/^'[^']*(?:''[^']*)*'!/, '');
  const { startRow, startCol } = _parseA1Range(cellRange);

  // 메타에서 GID 찾기
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
    fields: 'sheets(properties(sheetId,title))',
  });
  const targetSheet = (meta.data.sheets || []).find(s => s.properties.title === tabName);
  if (!targetSheet) throw new Error(`시트를 찾을 수 없습니다: ${tabName}`);

  const sheetId = targetSheet.properties.sheetId;

  // values를 CellData 형식으로 변환
  const rows = values.map(rowValues => ({
    values: rowValues.map(val => ({
      userEnteredValue: _toCellValue(val),
    })),
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateCells: {
          rows,
          fields: 'userEnteredValue',
          start: {
            sheetId,
            rowIndex: startRow - 1,
            columnIndex: startCol - 1,
          },
        },
      }],
    },
  });
}

/**
 * 값을 Google Sheets CellData.userEnteredValue 형식으로 변환
 */
function _toCellValue(val) {
  if (val === null || val === undefined || val === '') {
    return { stringValue: '' };
  }
  if (typeof val === 'number') {
    return { numberValue: val };
  }
  if (typeof val === 'boolean') {
    return { boolValue: val };
  }
  // 숫자 문자열은 문자열로 유지
  return { stringValue: String(val) };
}

/**
 * 시트 단일 셀/행 추가 (GAS: appendRow)
 *
 * ★ 탭 이름에 슬래시(/)가 포함되면 values.append의 path parameter가 깨지므로
 *   GID 기반으로 마지막 행을 찾아 updateCells로 우회합니다.
 */
async function appendSheet(spreadsheetId, range, values) {
  if (!sheets) throw new Error('Google Sheets API가 설정되지 않았습니다.');

  if (range && range.includes('/')) {
    const tabMatch = range.match(/^'([^']*(?:''[^']*)*)'!/);
    const tabName = tabMatch ? tabMatch[1].replace(/''/g, "'") : null;

    if (tabName) {
      // GID 기반: 현재 데이터 행 수 파악 후 다음 행에 쓰기
      const existing = await _readSheetByGridData(spreadsheetId, `'${tabName}'!A1:A1000`);
      const nextRow = (existing ? existing.length : 0) + 1;

      // 메타에서 GID 찾기
      const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        includeGridData: false,
        fields: 'sheets(properties(sheetId,title))',
      });
      const targetSheet = (meta.data.sheets || []).find(s => s.properties.title === tabName);
      if (!targetSheet) throw new Error(`시트를 찾을 수 없습니다: ${tabName}`);

      const sheetId = targetSheet.properties.sheetId;

      // values를 CellData 형식으로 변환
      const rows = values.map(rowValues => ({
        values: rowValues.map(val => ({
          userEnteredValue: _toCellValue(val),
        })),
      }));

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateCells: {
              rows,
              fields: 'userEnteredValue',
              start: {
                sheetId,
                rowIndex: nextRow - 1,
                columnIndex: 0,
              },
            },
          }],
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
