'use strict';
/**
 * 업로드된 표 파일(.xlsx / .xls / .csv) → 2차원 배열(AOA)
 *
 * ★★ 왜 라이브러리를 하나 더 두는가: 기존 `exceljs` 는 **.xlsx 만 읽는다**. 그런데 실측한
 *   은행 결과 파일은 ① 하나은행 = **진짜 구형 .xls(OLE2)** ② 케이뱅크 = 확장자는 `.xls`
 *   인데 내용은 **.xlsx** 였다. 즉 확장자를 믿을 수 없고 구형 .xls 도 반드시 읽어야 한다
 *   → SheetJS(@e965/xlsx = 유지보수 중인 미러, 0.20.x 로 알려진 취약점 수정본).
 *
 * ★ **확장자가 아니라 파일 앞머리(매직 바이트)로 판정한다** — 위 ②처럼 확장자가 거짓인
 *   파일이 실제로 온다. 판정 실패는 텍스트(CSV)로 떨어뜨린다.
 * ★ CSV 는 한글 인코딩이 갈린다(엑셀에서 저장하면 대개 CP949). UTF-8 로 읽히지 않으면
 *   CP949 로 다시 읽는다 — 잘못 고르면 열 이름이 깨져 "은행 파일이 아니다"로 오판한다.
 */

const XLSX = require('@e965/xlsx');

const MAX_BYTES = 12 * 1024 * 1024;   // 업로드 상한(본문 10MB 제한보다 여유 — base64 팽창 고려는 라우트에서)

/** 파일 앞머리로 형식 판정. 확장자는 참고만 한다. */
function sniffFormat(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  const b = buf;
  if (b[0] === 0x50 && b[1] === 0x4b) return 'xlsx';                       // PK.. (zip)
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls'; // OLE2
  return 'text';                                                           // csv/tsv/기타 텍스트
}

/** 버퍼가 올바른 UTF-8 인가(아니면 CP949 로 본다). */
function looksUtf8(buf) {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return !s.includes('�');
  } catch (_) { return false; }
}

/**
 * @param {Buffer} buf
 * @param {string} [fileName]
 * @returns {{ok:boolean, error?:string, format?:string, sheetName?:string, aoa?:Array<Array<string>>}}
 */
function loadSheetAoa(buf, fileName = '') {
  if (!buf || !buf.length) return { ok: false, error: '빈 파일입니다.' };
  if (buf.length > MAX_BYTES) return { ok: false, error: '파일이 너무 큽니다(12MB 초과).' };

  const format = sniffFormat(buf);
  let wb;
  try {
    if (format === 'text') {
      // CSV/TSV — 인코딩을 잘못 고르면 열 이름이 깨진다.
      const opts = { type: 'buffer', raw: false };
      if (!looksUtf8(buf)) opts.codepage = 949;
      wb = XLSX.read(buf, opts);
    } else {
      wb = XLSX.read(buf, { type: 'buffer', raw: false });
    }
  } catch (e) {
    return { ok: false, error: `파일을 열지 못했습니다(${format}): ${e.message}` };
  }
  const sheetName = (wb.SheetNames || [])[0];
  if (!sheetName) return { ok: false, error: '시트가 없습니다.' };

  /* ★ `raw:false` = 셀을 **화면에 보이는 문자열 그대로** 읽는다.
     숫자로 읽으면 계좌번호 앞 0 이 사라지고 `2026.06.09 11:46:52` 가 다른 형식으로 바뀐다.
     `defval:''` 로 빈 칸을 undefined 대신 빈 문자열로 채워 열 위치가 밀리지 않게 한다. */
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1, defval: '', raw: false, blankrows: true,
  });
  return { ok: true, format, sheetName, aoa };
}

module.exports = { loadSheetAoa, sniffFormat, looksUtf8, MAX_BYTES };
