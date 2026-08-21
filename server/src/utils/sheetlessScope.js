/**
 * sheetlessScope.js — "이 시트/탭을 구글에서 읽어야 하는가" 판정의 **단일 출처** (탈 구글시트 W1)
 *
 * ★★ 왜 단일 출처인가: 구글시트를 부르는 주기 작업이 여러 곳(스마트빌드 · RAW 미러 · 변경감지)이고
 *   각자 `campaigns ∪ tab_configs` 의 sheet_id 를 통째로 순회한다. 무시트 작업의 가상 시트ID가
 *   한 곳이라도 새어 들어가면 **매 주기 구글 404 → 오류 로그·재시도 낭비**가 된다.
 *   판정을 여기 하나로 모아 두면 새 스윕이 생겨도 같은 게이트를 쓰게 된다.
 *
 * ★ 탭 단위 판정이 기본이다 — 기존 활성 작업 이관(W5)은 한 시트 안에서 탭별로 진행되므로,
 *   같은 시트에 **읽을 이유가 남은 탭**이 하나라도 있으면 그 시트는 계속 읽어야 한다.
 *   시트 단위 제외는 그런 탭이 하나도 없을 때만 성립한다(`sweepSkipSheetIds`).
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
 *  ★ 좁은(구) 규칙 — 킬스위치 `SHEET_SWEEP_SKIP_WIDE=0` 일 때만 쓰인다. */
const FULLY_SHEETLESS_SHEET_IDS_SQL = `
  SELECT sheet_id FROM tab_configs
   GROUP BY sheet_id
  HAVING BOOL_AND(COALESCE(sheetless, FALSE)) = TRUE`;

/**
 * ★★ 넓은 규칙(기본) — "읽을 이유가 남아 있는 탭이 하나도 없는 시트" 를 전부 제외한다.
 *
 * 좁은 규칙(`FULLY_SHEETLESS_SHEET_IDS_SQL`)만으로는 아래 둘이 영영 제외되지 않아,
 * 이관이 끝난 뒤에도 주기 스윕이 시트를 계속 열었다(2026-08-20 실측: 읽는 시트 47개 =
 * 마감만 남은 시트 4 + 등록 탭 0 인 시트 43, **시트 기반 활성 작업은 0**):
 *   ㉮ **마감(is_closed) 탭** — 그 탭이 `sheetless=FALSE` 면 `BOOL_AND(sheetless)` 가 깨진다.
 *      마감 탭은 주문을 받지 않고, 인덱스 정리(전체 빌드 0.5단계 auto-clean-closed)는
 *      **DB 안에서만** 돌아 시트를 읽지 않는다 → 읽을 이유가 없다.
 *   ㉯ **등록 탭이 0 인 시트** — 아카이브로 `tab_configs` 행이 지워지면 GROUP BY 그룹 자체가
 *      사라져 좁은 규칙의 판정 대상에서 빠지는데, `campaigns` 행은 남아 열거에는 계속 잡힌다.
 *      등록 게이트(`TAB_REGISTRATION_MODE=order`)상 미등록 탭은 어차피 인덱스를 만들지 않는다.
 *
 * ★ 되살아나는 판정이다 — 마감을 풀거나(`is_closed=FALSE`) 탭을 복구하면 **그 즉시 다시 읽는다**
 *   (아카이브 복구·재접수가 `tab_configs` 행을 되살린다). 여기서 아무것도 영구화하지 않는다.
 * ★ 되돌리기 = Railway `SHEET_SWEEP_SKIP_WIDE=0` (코드 변경 0 · 좁은 규칙으로 즉시 복귀).
 */
const SWEEP_SKIP_SHEET_IDS_SQL = `
  SELECT c.sheet_id
    FROM (${REGISTERED_SHEET_IDS_SQL}) c
    LEFT JOIN tab_configs t ON t.sheet_id = c.sheet_id
   GROUP BY c.sheet_id
  HAVING BOOL_AND(
           t.sheet_id IS NULL
           OR COALESCE(t.sheetless, FALSE)
           OR COALESCE(t.is_closed, FALSE)
         ) = TRUE`;

/** 무시트 탭 키 목록 */
const SHEETLESS_TABS_SQL = `
  SELECT sheet_id, tab_name, COALESCE(tab_gid,'') AS tab_gid
    FROM tab_configs WHERE COALESCE(sheetless, FALSE) = TRUE`;

/** 복합키 — 리터럴 NUL 금지(git 이 파일을 바이너리로 취급해 grep·가드가 무력화된다) */
function tabKey(sheetId, tabName) {
  return String(sheetId || '') + '\u0000' + String(tabName || '');
}

/**
 * 주기 스윕에서 건너뛸 시트 ID 집합 — "읽을 이유가 남은 탭이 하나도 없는 시트".
 * ★ 조회 실패는 **빈 집합**(fail-open) — 게이트가 죽었다고 스윕을 멈추지 않는다.
 * @returns {Promise<Set<string>>}
 */
async function sweepSkipSheetIds(db) {
  const sql = (process.env.SHEET_SWEEP_SKIP_WIDE === '0')
    ? FULLY_SHEETLESS_SHEET_IDS_SQL
    : SWEEP_SKIP_SHEET_IDS_SQL;
  try {
    const { rows } = await db.query(sql);
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
  SWEEP_SKIP_SHEET_IDS_SQL,
  SHEETLESS_TABS_SQL,
  tabKey,
  sweepSkipSheetIds,
  sheetlessTabKeys,
  isSheetlessTab,
  isSheetless,
};
