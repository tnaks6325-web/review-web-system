/**
 * folderTitle.service.js — Drive 폴더 1단 이름 해석 (탈 구글시트 W2 · D2-a)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 리뷰·구매캡처 폴더 경로는 `AI_REVIEW_FOLDER → {1단} → {탭명} → [리뷰]` 다.
 * 그 **{1단}** 이 지금까지 "구글 스프레드시트 파일 제목"이었다 — 무시트 작업에는 그 파일이 없다.
 *
 * 사용자 확정 **D2-a: 폴더 이름 = 업체명 자동**.
 *   업체(광고주) → 없으면 등록된 캠페인 이름 → 그것도 없으면 작업 이름.
 *
 * ★★ **기존(시트 기반) 탭은 한 글자도 안 바뀐다** — 이 함수는 무시트 탭일 때만 값을 돌려주고,
 *   그 외에는 `null` 을 돌려준다. 호출부는 `null` 이면 **자기 기존 로직을 그대로** 탄다.
 *   (여기서 시트 탭까지 이름을 정하려 들면 이미 만들어진 수백 개 폴더와 경로가 갈라진다.)
 *
 * ★ 구글 API 호출 0 — 무시트 탭에 `getSpreadsheetMeta` 를 부르면 404 다. 그게 이 함수가 있는 이유.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const pool = require('../db/pool');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** Drive 폴더 이름으로 쓸 수 없는 문자 정리(경로 구분자·제어문자) */
function sanitizeFolderName(v) {
  return String(v == null ? '' : v)
    .replace(/[\\/]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 120);
}

/**
 * 무시트 탭의 폴더 1단 이름.
 *
 * @param {string} sheetId · {string} tabName
 * @returns {Promise<string|null>} 무시트 탭이면 이름, **시트 기반 탭이면 null**(호출부 기존 로직 유지)
 */
async function resolveSheetlessFolderTitle(sheetId, tabName) {
  if (!sheetId || !tabName) return null;
  const db = getPool();

  let row;
  try {
    // ★ 한 왕복 — 무시트 여부·캠페인 이름·소유 업체를 함께 읽는다.
    //   업체 소유는 **탭 지정 > 시트 전체** 순(작업목록 그룹핑과 같은 우선순위).
    const { rows } = await db.query(
      `SELECT COALESCE(tc.sheetless, FALSE) AS sheetless,
              COALESCE(tc.campaign_name, '') AS campaign_name,
              COALESCE((
                SELECT a.name FROM advertiser_campaigns ac
                  JOIN advertisers a ON a.id = ac.advertiser_id
                 WHERE ac.sheet_id = tc.sheet_id
                   AND (ac.tab_gid IS NULL OR ac.tab_gid = tc.tab_gid)
                   AND ac.deleted_at IS NULL
                 ORDER BY (ac.tab_gid IS NOT NULL) DESC
                 LIMIT 1), '') AS advertiser_name
         FROM tab_configs tc
        WHERE tc.sheet_id = $1 AND tc.tab_name = $2
        LIMIT 1`, [sheetId, tabName]);
    row = rows[0];
  } catch (_) {
    // ★ 조회 실패 = 판정 불가 → null(호출부 기존 로직). 여기서 이름을 지어내면
    //   시트 기반 탭의 폴더가 엉뚱한 곳에 생긴다.
    return null;
  }

  if (!row || !row.sheetless) return null;

  const name = sanitizeFolderName(row.advertiser_name) ||
               sanitizeFolderName(row.campaign_name) ||
               sanitizeFolderName(tabName);
  return name || null;
}

module.exports = {
  resolveSheetlessFolderTitle,
  sanitizeFolderName,
  __setPoolForTest,
};
