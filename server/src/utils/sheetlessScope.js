/**
 * sheetlessScope.js — "이 시트/탭을 구글에서 읽어야 하는가" 판정의 **단일 출처** (탈 구글시트 W1)
 *
 * ★★ 왜 단일 출처인가: 구글시트를 부르는 주기 작업이 여러 곳(스마트빌드 · RAW 미러 · 변경감지)이고
 *   각자 `campaigns ∪ tab_configs` 의 sheet_id 를 통째로 순회한다. 무시트 작업의 가상 시트ID가
 *   한 곳이라도 새어 들어가면 **매 주기 구글 404 → 오류 로그·재시도 낭비**가 된다.
 *   판정을 여기 하나로 모아 두면 새 스윕이 생겨도 같은 게이트를 쓰게 된다.
 *
 * ★ 탭 단위 판정이 기본이다 — 기존 활성 작업 이관(W5)은 한 시트 안에서 탭별로 진행되므로,
 *   같은 시트에 시트 기반 탭이 하나라도 남아 있으면 **그 시트는 계속 읽어야 한다**.
 *   시트 단위 제외는 "그 시트의 등록 탭이 전부 무시트일 때"만 성립한다(fullySheetlessSheetIds).
 *
 * ★ 조회 실패는 **빈 집합**(fail-open) — 게이트가 죽었다고 스윕을 멈추면 시트 기반 작업 전체가
 *   갱신을 멈춘다. 무시트 탭을 한 사이클 더 읽는 쪽이 훨씬 가볍다(없는 시트면 그 탭만 오류 로그).
 *   컬럼 미적용(42703)·테이블 부재(42P01)도 같은 취급 = 배포 순서 무관.
 */

/** ★★ 주기 스윕이 "어느 시트를 후보로 삼는가" — RAW 미러·스마트빌드·읽는 범위 진단이 **같은 문장**을 쓴다.
 *  사본을 두면 진단이 "안 읽는다"고 말하는 시트를 스윕은 계속 읽는 상태가 된다(관측이 거짓말이 되는 자리). */
const REGISTERED_SHEET_IDS_SQL =
  'SELECT DISTINCT sheet_id FROM campaigns UNION SELECT DISTINCT sheet_id FROM tab_configs';

/** 시트 단위 스윕에서 제외할 sheet_id 목록 — 등록 탭이 **전부** 무시트인 시트만.
 *  (한 탭이라도 시트 기반이면 그 시트는 계속 읽어야 하므로 제외 대상이 아니다) */
const FULLY_SHEETLESS_SHEET_IDS_SQL = `
  SELECT sheet_id FROM tab_configs
   GROUP BY sheet_id
  HAVING BOOL_AND(COALESCE(sheetless, FALSE)) = TRUE`;

/** 무시트 탭 키 목록 */
const SHEETLESS_TABS_SQL = `
  SELECT sheet_id, tab_name, COALESCE(tab_gid,'') AS tab_gid
    FROM tab_configs WHERE COALESCE(sheetless, FALSE) = TRUE`;

/** 복합키 — 리터럴 NUL 금지(git 이 파일을 바이너리로 취급해 grep·가드가 무력화된다) */
function tabKey(sheetId, tabName) {
  return String(sheetId || '') + '\u0000' + String(tabName || '');
}

/**
 * 전부 무시트인 시트 ID 집합.
 * @returns {Promise<Set<string>>} 실패 시 빈 Set(fail-open)
 */
async function fullySheetlessSheetIds(db) {
  try {
    const { rows } = await db.query(FULLY_SHEETLESS_SHEET_IDS_SQL);
    return new Set(rows.map(r => r.sheet_id).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

/**
 * 무시트 탭 집합 — 키는 `tabKey(sheetId, tabName)`, gid 가 있으면 gid 키도 함께 담는다.
 * ★ gid 키를 함께 담는 이유 = 탭 리네임 대비(레포 관용구 "gid 우선 재매칭").
 *   ★ 빈 gid 는 키를 만들지 않는다 — 만들면 gid 없는 탭이 전부 한 키로 뭉쳐 오판한다.
 * @returns {Promise<Set<string>>} 실패 시 빈 Set(fail-open)
 */
async function sheetlessTabKeys(db) {
  const out = new Set();
  try {
    const { rows } = await db.query(SHEETLESS_TABS_SQL);
    for (const r of rows) {
      out.add(tabKey(r.sheet_id, r.tab_name));
      if (r.tab_gid) out.add(tabKey(r.sheet_id, 'gid:' + r.tab_gid));
    }
  } catch (_) { /* fail-open */ }
  return out;
}

/** 집합에서 탭 판정(이름 → gid 순) */
function isSheetlessTab(keys, sheetId, tabName, tabGid) {
  if (!keys || !keys.size) return false;
  if (keys.has(tabKey(sheetId, tabName))) return true;
  if (tabGid && keys.has(tabKey(sheetId, 'gid:' + tabGid))) return true;
  return false;
}

/** 단건 조회(라우트·서비스용) — 실패는 false(fail-open) */
async function isSheetless(db, sheetId, tabName) {
  if (!sheetId || !tabName) return false;
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(sheetless, FALSE) AS s FROM tab_configs
        WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
    return !!(rows[0] && rows[0].s);
  } catch (_) {
    return false;
  }
}

module.exports = {
  REGISTERED_SHEET_IDS_SQL,
  FULLY_SHEETLESS_SHEET_IDS_SQL,
  SHEETLESS_TABS_SQL,
  tabKey,
  fullySheetlessSheetIds,
  sheetlessTabKeys,
  isSheetlessTab,
  isSheetless,
};
