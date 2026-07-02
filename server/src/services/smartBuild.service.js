/**
 * smartBuild.service.js
 * ═══════════════════════════════════════════════════════════
 * 스마트 빌드 — Drive API 변경감지 + Sheets API batchGet 조합
 * 
 * 기존 indexBuilder.service.js와 완전히 독립된 별개 모듈.
 * indexBuilder의 parseTabRows, computeChecksum, _upsertTabIndex 로직을
 * 내부에서 자체적으로 재구현하여 의존성 없음.
 *
 * 흐름:
 *   1. Drive API로 57개 시트 수정시각 일괄 조회 (분당 12,000회 한도)
 *   2. 이전 수정시각과 비교하여 변경된 시트만 필터링
 *   3. 변경된 시트에 대해 Sheets API batchGet으로 모든 탭 데이터 한번에 읽기
 *   4. 탭별 체크섬 비교 → 변경된 탭만 DB(index_master + review_index) 갱신
 *   5. 5분 주기 자동 실행 (setInterval)
 * ═══════════════════════════════════════════════════════════
 */

const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta, batchReadSheet, getSheetModifiedTime, shareSheetWithServiceAccount } = require('./sheets.service');
const { computeChecksum } = require('../utils/checksum');
const { logger } = require('../utils/logger');
const { throttledCall, driveThrottledCall, getThrottleStatus } = require('../utils/sheetsThrottle');

// ═══════════════════════════════════════════════════════════
// 상수 및 상태
// ═══════════════════════════════════════════════════════════

// 주기(env 조절, 기본 5분·60초 미만은 60으로 클램프) — 쿼터 여유가 더 필요하면 SMART_BUILD_INTERVAL_SEC=600 등으로 상향
const SMART_BUILD_INTERVAL_MS = (n => (Number.isFinite(n) && n > 0 ? Math.max(60, n) : 300))(
  parseInt(process.env.SMART_BUILD_INTERVAL_SEC || '300', 10)
) * 1000;

// 시트 lane 중간 양보 임계 — 변경시트 처리 중 최근 1분 시트 lane 사용량이 이 값을 넘으면
// 남은 변경 시트를 다음 주기로 연기(제출/주문 쿼터 헤드룸 상시 확보). 999로 사실상 비활성.
const SMARTBUILD_YIELD_THRESHOLD = (n => (Number.isFinite(n) && n > 0 ? n : 25))(
  parseInt(process.env.SMARTBUILD_YIELD_THRESHOLD || '25', 10)
);

// ── 에러 메시지 한글 번역 헬퍼 ──
function _translateError(msg) {
  if (!msg) return '알 수 없는 오류';
  if (/file not found/i.test(msg))                      return '파일을 찾을 수 없습니다 (삭제되었거나 ID가 잘못됨)';
  if (/does not have permission/i.test(msg))             return '접근 권한이 없습니다 (서비스 계정에 공유 필요)';
  if (/caller does not have permission/i.test(msg))      return '접근 권한이 없습니다 (서비스 계정에 공유 필요)';
  if (/quota exceeded/i.test(msg))                       return 'API 할당량 초과 (잠시 후 자동 재시도)';
  if (/rate limit/i.test(msg))                           return 'API 요청 속도 제한 초과';
  if (/unable to parse range/i.test(msg))                return '시트 범위를 파싱할 수 없습니다 (탭 이름 오류)';
  if (/requested entity was not found/i.test(msg))       return '요청한 항목을 찾을 수 없습니다';
  if (/spreadsheet.*not found/i.test(msg))               return '스프레드시트를 찾을 수 없습니다';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg))      return '네트워크 연결 오류 (일시적 장애)';
  if (/socket hang up/i.test(msg))                       return '네트워크 연결이 끊어졌습니다';
  if (/503|service unavailable/i.test(msg))              return 'Google API 서비스 일시 중단';
  if (/500|internal server error/i.test(msg))            return 'Google API 내부 서버 오류';
  return msg; // 매칭 안 되면 원문 반환
}

// 키워드 기본값 (DB 로드 실패 시 폴백)
const DEFAULT_SUBMITTED_VALUES = ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'];
const DEFAULT_NAME_KEYWORDS = ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'];
const DEFAULT_SYSTEM_TABS = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정', 'detail', 'config'];
const DEFAULT_DATA_TAB_KEYWORDS = ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'];
const DEFAULT_SUBMIT_KEYWORDS = ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰'];

let SUBMITTED_VALUES = [...DEFAULT_SUBMITTED_VALUES];
let NAME_KEYWORDS = [...DEFAULT_NAME_KEYWORDS];
let SYSTEM_TABS = [...DEFAULT_SYSTEM_TABS];
let DATA_TAB_KEYWORDS = [...DEFAULT_DATA_TAB_KEYWORDS];
let SUBMIT_KEYWORDS = [...DEFAULT_SUBMIT_KEYWORDS];

// 스마트빌드 런타임 상태
let _intervalHandle = null;
let _isRunning = false;
let _lastRunResult = null;
let _modifiedTimeCache = {};   // sheetId → { modifiedTime, checkedAt }
let _checksumCache = {};       // "sheetId||tabName" → checksum
let _runCount = 0;
let _startedAt = null;

// (R5) Drive 변경감지 연속실패 스트릭 — streak>=N이면 "변경 간주" 대신 이번 사이클 skip(풀리드 폭풍 차단).
//   성공 시 리셋. 백스톱: 전체빌드 cron(09/15/04). 비활성화: SMARTBUILD_DRIVE_FAIL_SKIP_AFTER=999
const _driveFailStreak = {};
const DRIVE_FAIL_SKIP_AFTER = (n => (Number.isFinite(n) && n > 0 ? n : 2))(
  parseInt(process.env.SMARTBUILD_DRIVE_FAIL_SKIP_AFTER || '2', 10)
);

// 시트 처리(meta/batchGet/탭) 실패 시: modifiedTime 캐시를 무효화해 다음 주기 재시도 —
//   실패한 데이터가 "반영됨(T2)"으로 영속 스냅샷에 남는 것을 방지. 단 연속 실패가 상한을
//   넘으면 캐시를 유지해 5분 재읽기 루프를 중단(백스톱: 04:00 전체빌드 또는 다음 시트 편집).
const _sheetErrStreak = {};
const SHEET_ERR_RETRY_CYCLES = 3;

// resetSmartBuildCache 직후의 첫 실행이 방금 지운 영속 스냅샷을 복원해 "강제 전체 갱신"을
// 무력화하지 않도록(DELETE 실패/지연 대비) 1회성 복원 스킵 플래그.
let _skipPersistedRestore = false;

// ── pause 상태(적대검증 RED-1 끈채방치 / RED-2 재배포 부활 방어) ──
//   interval은 계속 돌되 now < _pausedUntil이면 tick만 스킵(자동재개). app_settings에 영속화해
//   재배포/재부팅에도 관리자 정지 의도 보존. pause 만료 시 자동 재개(끈 채 방치 방지).
let _pausedUntil = null;   // Date | null
const SMART_BUILD_DEFAULT_PAUSE_MIN = 60;

async function _persistPauseUntil(iso) {
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('smart_build_paused_until', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [iso || '']
    );
  } catch (e) { logger.warn(`[smartBuild] pause 영속화 실패(무시): ${e.message}`); }
}

async function _loadPersistedPause() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'smart_build_paused_until'"
    );
    const v = rows[0] && rows[0].value;
    if (v) {
      const until = new Date(v);
      if (!isNaN(until.getTime()) && until.getTime() > Date.now()) return until;
    }
  } catch (e) { logger.warn(`[smartBuild] pause 복원 조회 실패(무시): ${e.message}`); }
  return null;
}

// ── modifiedTime 캐시 영속화 (재배포 콜드스타트 전체 스윕 제거) ──
//   _modifiedTimeCache는 인메모리라 재배포마다 소실 → 첫 주기에 전 시트(~57개)가 "변경됨"으로
//   간주되어 meta+batchGet 전량 재읽기(시트 lane ~30콜/분 수 분간 점유)되던 것을,
//   사이클 말미에 app_settings로 스냅샷 저장 + 부팅 첫 주기에 복원해 제거한다.
//   실제 변경된 시트는 modifiedTime이 달라 정상 감지(안전측). best-effort — 실패해도 기능 영향 0.
async function _persistModifiedCache(currentSheetIds = null) {
  try {
    const keep = currentSheetIds ? new Set(currentSheetIds) : null;
    const flat = {};
    for (const [sid, v] of Object.entries(_modifiedTimeCache)) {
      if (keep && !keep.has(sid)) continue; // 등록 해제된 시트 엔트리 정리(스냅샷 무한 잔류 방지)
      if (v && v.modifiedTime) flat[sid] = v.modifiedTime;
    }
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('smart_build_modified_cache', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(flat)]
    );
  } catch (e) { logger.warn(`[smartBuild] modifiedTime 캐시 영속화 실패(무시): ${e.message}`); }
}

async function _loadPersistedModifiedCache() {
  if (_skipPersistedRestore) {
    _skipPersistedRestore = false;
    logger.info('[smartBuild] 캐시 리셋 직후 — 영속 modifiedTime 스냅샷 복원 스킵(강제 전체 갱신 보존)');
    return 0;
  }
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'smart_build_modified_cache'"
    );
    const raw = rows[0] && rows[0].value;
    if (!raw) return 0;
    const flat = JSON.parse(raw);
    let n = 0;
    for (const [sid, mt] of Object.entries(flat || {})) {
      if (sid && typeof mt === 'string' && mt) {
        _modifiedTimeCache[sid] = { modifiedTime: mt, checkedAt: 0 };
        n++;
      }
    }
    return n;
  } catch (e) {
    logger.warn(`[smartBuild] modifiedTime 캐시 복원 실패(전체 재감지로 폴백): ${e.message}`);
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════
// DB에서 키워드 로드
// ═══════════════════════════════════════════════════════════

async function _loadKeywords() {
  try {
    const { rows } = await pool.query(
      "SELECT category, keyword FROM index_keywords WHERE active = TRUE ORDER BY category, keyword"
    );
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r.keyword);
    });
    DATA_TAB_KEYWORDS = grouped['data_tab'] || [...DEFAULT_DATA_TAB_KEYWORDS];
    NAME_KEYWORDS = grouped['name'] || [...DEFAULT_NAME_KEYWORDS];
    SUBMIT_KEYWORDS = grouped['submit'] || [...DEFAULT_SUBMIT_KEYWORDS];
    SYSTEM_TABS = grouped['system_tab'] || [...DEFAULT_SYSTEM_TABS];
  } catch (err) {
    logger.warn(`[smartBuild] 키워드 로드 실패 (폴백 사용): ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// 헤더 감지 + 행 파싱 (indexBuilder.parseTabRows 자체 재구현)
// ═══════════════════════════════════════════════════════════

function _isDataTabRow(cells) {
  let matchCount = 0;
  for (const kw of DATA_TAB_KEYWORDS) {
    const found = kw === '번호'
      ? cells.includes(kw)
      : cells.some(c => c.includes(kw));
    if (found) {
      matchCount++;
      if (matchCount >= 2) return true;
    }
  }
  return false;
}

function _parseTabRows(values, sheetId, tabName, tabGid, campaignTitle, dbColMap = null) {
  // ★ P2a: indexBuilder와 동일한 공용 columnResolver로 위임(동일 kw → 동일 출력).
  //   이제 recipientName/isSubmitted2/submitCol2도 반환되며 _upsertTab이 이를 기록한다.
  //   ★ P2b: dbColMap(있으면) 전달 — DB컬럼매핑 우선. 없으면(null) P2a와 100% 동일.
  return require('./columnResolver').parseTabRows(values, sheetId, tabName, tabGid, campaignTitle, {
    NAME_KEYWORDS, SUBMIT_KEYWORDS, DATA_TAB_KEYWORDS, SUBMITTED_VALUES,
  }, dbColMap);
}

// ═══════════════════════════════════════════════════════════
// DB Upsert (자체 구현 — indexBuilder와 독립)
// ═══════════════════════════════════════════════════════════

async function _upsertTab(sheetId, tabName, tabGid, checksum, rows, modifiedTime, campaignName, archivedRoundsCache) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ★★★ 방어적 필터: 이미 아카이브된 탭이면 재삽입하지 않고 스킵
    // (activeTabs 필터를 통과했더라도 아카이브 테이블에 있으면 스킵)
    // tab_name 매칭 + gid 매칭 (탭 이름 변경 대응)
    const { rows: archiveCheck } = await client.query(
      `SELECT 1 FROM index_master_archive
       WHERE sheet_id = $1 AND (tab_name = $2 OR ($3::text IS NOT NULL AND tab_gid = $3::text))
       LIMIT 1`,
      [sheetId, tabName, tabGid || null]
    );
    if (archiveCheck.length > 0) {
      await client.query('COMMIT');
      client.release();
      logger.info(`[smartBuild] _upsertTab 스킵: "${tabName}" (gid=${tabGid}) — index_master_archive에 존재 (아카이브됨)`);
      return;
    }

    // ★ gid 기반 탭 이름 변경 감지 — 동일 gid의 이전 tab_name 행 정리
    // 구글시트에서 탭 이름이 변경되면 gid는 유지되지만 tab_name이 달라짐
    // 이전 이름의 행을 삭제하지 않으면 대시보드에 두 개가 표시됨
    if (tabGid) {
      const { rows: oldEntries } = await client.query(
        `SELECT tab_name FROM index_master WHERE sheet_id = $1 AND tab_gid = $2 AND tab_name != $3`,
        [sheetId, tabGid, tabName]
      );
      for (const old of oldEntries) {
        logger.info(`[smartBuild] 탭 이름 변경 감지: "${old.tab_name}" → "${tabName}" (gid=${tabGid})`);
        // review_index에서 이전 tab_name 행 삭제
        await client.query(
          `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, old.tab_name]
        );
        // index_master에서 이전 tab_name 행 삭제
        await client.query(
          `DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, old.tab_name]
        );
        // tab_configs에서 이전 tab_name 행 삭제
        await client.query(
          `DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, old.tab_name]
        );
        // 체크섬 캐시에서 이전 키 제거
        delete _checksumCache[`${sheetId}||${old.tab_name}`];
      }
    }

    // ★ 아카이브된 차수(round)의 행은 재삽입하지 않도록 필터링
    // 빌드 시작 시 일괄 로드한 캐시 사용 (DB 쿼리 0회)
    const cacheKey = `${sheetId}||${tabName}`;
    const archivedRoundsSet = archivedRoundsCache?.get(cacheKey) || new Set();

    // 아카이브된 차수에 해당하는 행 제외
    let filteredRows = rows;
    if (archivedRoundsSet.size > 0) {
      filteredRows = rows.filter(row => {
        if (!row.round) return true; // 차수가 없는 행은 유지
        return !archivedRoundsSet.has(row.round.trim());
      });
      const skippedCount = rows.length - filteredRows.length;
      if (skippedCount > 0) {
        logger.info(`[smartBuild] ${tabName}: 아카이브된 차수 행 ${skippedCount}건 스킵 (archived_rounds: ${[...archivedRoundsSet].join(',')})`);
      }
    }

    const newRowIndices = new Set();
    if (filteredRows.length > 0) {
      const BATCH_SIZE = 100;
      for (let batchStart = 0; batchStart < filteredRows.length; batchStart += BATCH_SIZE) {
        const batch = filteredRows.slice(batchStart, batchStart + BATCH_SIZE);
        const insertValues = [];
        const insertPlaceholders = [];
        let paramIdx = 1;

        for (const row of batch) {
          newRowIndices.add(row.rowIndex);
          insertPlaceholders.push(
            `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`
          );
          insertValues.push(
            row.name, sheetId, row.tabGid, tabName,
            row.campaignName, row.rowIndex, row.isSubmitted,
            row.productUrl, row.productName, row.submitCol,
            JSON.stringify(row.rowJson), row.startDate, row.endDate, row.round,
            row.phone8 || null,
            // ★ P2a: 공용 columnResolver가 이제 제공하는 3컬럼(이전 smartBuild엔 누락 → 진동 원인)
            row.recipientName || null, row.isSubmitted2 || null, row.submitCol2 || null
          );
        }

        await client.query(`
          INSERT INTO review_index
            (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
             row_index, is_submitted, product_url, product_name,
             submit_col, row_json, start_date, end_date, round, phone8,
             recipient_name, is_submitted2, submit_col2)
          VALUES ${insertPlaceholders.join(', ')}
          ON CONFLICT (sheet_id, tab_name, row_index) DO UPDATE SET
            reviewer_name = EXCLUDED.reviewer_name,
            tab_gid = EXCLUDED.tab_gid,
            campaign_name = EXCLUDED.campaign_name,
            is_submitted = EXCLUDED.is_submitted,
            product_url = EXCLUDED.product_url,
            product_name = EXCLUDED.product_name,
            submit_col = EXCLUDED.submit_col,
            row_json = EXCLUDED.row_json,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            round = EXCLUDED.round,
            phone8 = EXCLUDED.phone8,
            recipient_name = EXCLUDED.recipient_name,
            is_submitted2 = EXCLUDED.is_submitted2,
            submit_col2 = EXCLUDED.submit_col2,
            built_at = NOW()
        `, insertValues);
      }
    }

    // 고아 행 삭제 (아카이브된 차수 행도 삭제 대상에서 보호)
    if (newRowIndices.size > 0) {
      if (archivedRoundsSet.size > 0) {
        // 아카이브된 차수의 행은 보존 — newRowIndices에 없더라도 삭제하지 않음
        // 아카이브된 차수 행은 이미 위에서 INSERT 대상에서 제외됨
        // 따라서 review_index에서 해당 차수 행만 별도 보존
        await client.query(
          `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index != ALL($3::int[])
           AND (round IS NULL OR round NOT IN (${[...archivedRoundsSet].map((_, i) => `$${i + 4}`).join(',')}))`,
          [sheetId, tabName, [...newRowIndices], ...archivedRoundsSet]
        );
      } else {
        await client.query(
          `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index != ALL($3::int[])`,
          [sheetId, tabName, [...newRowIndices]]
        );
      }
    } else if (archivedRoundsSet.size === 0) {
      await client.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]);
    }
    // else: filteredRows가 0이지만 아카이브된 차수가 있으면 → 기존 아카이브 차수 행 보존

    // index_master 갱신 (filteredRows 기준 카운트)
    await client.query(`
      INSERT INTO index_master (sheet_id, tab_name, tab_gid, campaign_name, checksum, built_at,
                                row_count, submitted_count, status, sheet_modified_at)
      VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,'active',$8)
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        tab_gid = EXCLUDED.tab_gid,
        checksum = EXCLUDED.checksum,
        built_at = NOW(),
        row_count = EXCLUDED.row_count,
        submitted_count = EXCLUDED.submitted_count,
        campaign_name = EXCLUDED.campaign_name,
        status = 'active',
        error_msg = NULL,
        sheet_modified_at = EXCLUDED.sheet_modified_at
    `, [
      sheetId, tabName, tabGid, campaignName || tabName,
      checksum, filteredRows.length, filteredRows.filter(r => r.isSubmitted).length,
      modifiedTime || null
    ]);

    // tab_configs도 현재 탭의 tab_gid + campaign_name 갱신
    // ★ campaign_name 교정: spreadsheetTitle(시트 제목)이 있으면 탭 이름과 동일한 잘못된 값을 덮어씀
    if (tabGid) {
      if (campaignName && campaignName !== tabName) {
        // spreadsheetTitle이 유효 → tab_configs에 적극 교정
        await client.query(
          `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheet_url, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
             tab_gid = $3,
             campaign_name = CASE
               WHEN tab_configs.campaign_name IS NULL OR tab_configs.campaign_name = '' OR tab_configs.campaign_name = $2
               THEN $4 ELSE COALESCE(NULLIF($4, ''), tab_configs.campaign_name)
             END,
             updated_at = NOW()`,
          [sheetId, tabName, tabGid, campaignName, `https://docs.google.com/spreadsheets/d/${sheetId}/edit`]
        );
      } else {
        // spreadsheetTitle 없음 → 기존 로직 유지 (기존 값 보존)
        await client.query(
          `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheet_url, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
             tab_gid = $3, campaign_name = COALESCE(NULLIF($4, ''), tab_configs.campaign_name), updated_at = NOW()`,
          [sheetId, tabName, tabGid, campaignName || '', `https://docs.google.com/spreadsheets/d/${sheetId}/edit`]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════
// 메인: 스마트 빌드 1회 실행
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// 서비스계정 시트 쓰기권한 자동 보장
// — 인덱스 빌드 대상 시트마다 SA 편집자(writer) 권한을 자동 부여/검증.
//   이미 부여된 시트는 permissions.list 1회로 단락되며, 권한이 사라진
//   경우 자동으로 재부여(자가치유)된다. 기존 수동 "시트 쓰기권한 일괄부여"
//   버튼을 대체한다.
// ═══════════════════════════════════════════════════════════
async function _ensureSheetsShared(sheetIds, result) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return;
  if (!sheetIds || sheetIds.length === 0) return;

  let granted = 0, alreadyOk = 0, failed = 0;
  for (const sheetId of sheetIds) {
    try {
      // drive lane 1슬롯 = 내부 실 Drive 콜 최대 4회(permissions.list/create × SA/OAuth) 언더카운트 — 120/분 여유폭 내
      const r = await driveThrottledCall(() => shareSheetWithServiceAccount(sheetId));
      if (r.alreadyShared) alreadyOk++;
      else granted++;
    } catch (err) {
      failed++;
      result.errorDetails.push({ phase: 'share', sheetId: sheetId.substring(0, 15), error: err.message, desc: _translateError(err.message) });
    }
  }
  result.sheetsShared = granted;
  if (granted > 0 || failed > 0) {
    logger.info(`[smartBuild] 시트 쓰기권한 자동부여: 신규 ${granted}, 기존 ${alreadyOk}, 실패 ${failed}`);
  }
}

async function runSmartBuild({ noYield = false } = {}) {
  if (_isRunning) {
    logger.warn('[smartBuild] 이미 실행 중 — 스킵');
    return { ok: false, reason: 'already_running' };
  }

  _isRunning = true;
  _runCount++;
  const runNum = _runCount;
  const startTime = Date.now();
  const isFirstRun = Object.keys(_modifiedTimeCache).length === 0;
  let _buildLockHeld = false; // ★ G4: indexBuilder와 build_locks 공유 여부

  const result = {
    ok: true,
    runNumber: runNum,
    isFirstRun,
    sheetsChecked: 0,
    sheetsChanged: 0,
    sheetsDeferred: 0,
    sheetsShared: 0,
    tabsScanned: 0,
    tabsUpdated: 0,
    tabsSkipped: 0,
    errors: 0,
    errorDetails: [],
    elapsed: 0,
    timestamp: new Date().toISOString(),
  };

  try {
    // ── ★ G4: 빌더 직렬화 — buildIndexSmart/buildOneSheet와 동일한 build_locks('INDEX_BUILD')를 공유 ──
    //   smartBuild만 이 락을 우회하던 버그로, 두 빌더가 같은 탭 review_index를 동시 인터리브 갱신해
    //   is_submitted/recipient_name 등이 빌드마다 진동·torn write 되던 것을 차단한다.
    //   점유 중(타 빌드 진행)이면 이번 5분 주기는 양보(다음 주기 재시도). 락 획득 자체가 실패하면
    //   smartBuild를 막지 않도록 best-effort로 진행(드문 DB오류 시 기능 우선).
    try {
      const { acquireBuildLock } = require('./indexBuilder.service');
      const lk = await acquireBuildLock('smartBuild');
      if (!lk || !lk.acquired) {
        result.ok = false;
        result.reason = 'build_locked';
        logger.info('[smartBuild] build_locks 점유 중(타 빌드 진행) — 이번 주기 양보');
        return result; // finally가 _isRunning=false 처리(락 미보유라 해제 없음)
      }
      _buildLockHeld = true;
    } catch (lockErr) {
      logger.warn(`[smartBuild] build lock 획득 실패(best-effort 진행): ${lockErr.message}`);
    }

    // ── 0단계: 키워드 로드 ──
    await _loadKeywords();

    // ── 1단계: DB에서 시트 ID 목록 + 기존 체크섬 로드 ──
    const { rows: campaignRows } = await pool.query(
      'SELECT DISTINCT sheet_id FROM campaigns UNION SELECT DISTINCT sheet_id FROM tab_configs'
    );
    const sheetIds = [...new Set(campaignRows.map(r => r.sheet_id))].filter(Boolean);
    result.sheetsChecked = sheetIds.length;

    // 기존 체크섬 로드 (첫 실행 시)
    if (isFirstRun) {
      const { rows: masterRows } = await pool.query('SELECT sheet_id, tab_name, checksum FROM index_master');
      masterRows.forEach(r => {
        _checksumCache[`${r.sheet_id}||${r.tab_name}`] = r.checksum;
      });
      // ★ modifiedTime 캐시 복원 — 재배포 직후 "전 시트 변경 간주" 콜드스타트 스윕 제거
      const restored = await _loadPersistedModifiedCache();
      logger.info(`[smartBuild] 첫 실행: 체크섬 캐시 ${masterRows.length}건 + modifiedTime 캐시 ${restored}건 복원`);
    }

    // 마감 탭 목록 로드
    const { rows: closedRows } = await pool.query('SELECT sheet_id, tab_name FROM tab_configs WHERE is_closed = TRUE');
    const closedSet = new Set(closedRows.map(r => `${r.sheet_id}||${r.tab_name}`));

    // ★ 아카이브된 탭 목록 로드 — 스마트빌드에서 완전히 제외
    const { rows: archivedRows } = await pool.query('SELECT sheet_id, tab_name, tab_gid FROM index_master_archive');
    const archivedSet = new Set(archivedRows.map(r => `${r.sheet_id}||${r.tab_name}`));
    // ★ gid 기반 아카이브 Set (탭 이름 변경 후에도 감지)
    const archivedGidSet = new Set(
      archivedRows.filter(r => r.tab_gid).map(r => `${r.sheet_id}||gid:${r.tab_gid}`)
    );
    if (archivedRows.length > 0) {
      logger.info(`[smartBuild] 아카이브된 탭 ${archivedRows.length}개 스킵 대상 로드 (gid매칭: ${archivedGidSet.size}개)`);
    }

    // ★ 차수 단위 아카이브 캐시: 빌드 시작 시 1회 bulk 로드 (탭당 개별 쿼리 제거)
    // Map<"sheetId||tabName", Set<round>>
    const archivedRoundsCache = new Map();
    const { rows: archivedRoundsRows } = await pool.query(
      "SELECT sheet_id, tab_name, archived_rounds FROM tab_configs WHERE archived_rounds IS NOT NULL AND archived_rounds != ''"
    );
    for (const r of archivedRoundsRows) {
      const rounds = r.archived_rounds.split(',').map(s => s.trim()).filter(Boolean);
      if (rounds.length > 0) {
        archivedRoundsCache.set(`${r.sheet_id}||${r.tab_name}`, new Set(rounds));
      }
    }
    if (archivedRoundsCache.size > 0) {
      logger.info(`[smartBuild] 차수 단위 아카이브 캐시 로드: ${archivedRoundsCache.size}개 탭, 총 ${archivedRoundsRows.reduce((sum, r) => sum + r.archived_rounds.split(',').filter(Boolean).length, 0)}개 차수`);
    }

    // ── 2단계: Drive API로 변경 시트 감지 (throttle 적용) ──
    const changedSheetIds = [];

    for (const sheetId of sheetIds) {
      try {
        // drive lane — 시트 45/분 미소모(모니터 'Drive' 게이지에 계수)
        const modifiedTime = await driveThrottledCall(() => getSheetModifiedTime(sheetId));
        _driveFailStreak[sheetId] = 0;
        const cached = _modifiedTimeCache[sheetId];

        if (!cached || cached.modifiedTime !== modifiedTime) {
          changedSheetIds.push(sheetId);
          _modifiedTimeCache[sheetId] = { modifiedTime, checkedAt: Date.now() };
        }
      } catch (err) {
        const streak = (_driveFailStreak[sheetId] || 0) + 1;
        _driveFailStreak[sheetId] = streak;
        if (streak >= DRIVE_FAIL_SKIP_AFTER) {
          // (R5) 연속실패 — "변경 간주" 증폭 대신 이번 사이클 skip. 다음 성공 시 자동 재개.
          result.errorDetails.push({ phase: 'drive_defer', sheetId: sheetId.substring(0, 15), error: err.message, desc: `Drive 확인 ${streak}연속 실패 — 이번 주기 건너뜀(폭풍 방지)` });
        } else {
          // 1회성 실패는 현행대로 안전측(변경 간주)
          changedSheetIds.push(sheetId);
          result.errorDetails.push({ phase: 'drive', sheetId: sheetId.substring(0, 15), error: err.message, desc: _translateError(err.message) });
        }
      }
    }

    result.sheetsChanged = changedSheetIds.length;

    if (changedSheetIds.length === 0) {
      logger.info(`[smartBuild] #${runNum} 변경 없음 — ${sheetIds.length}개 시트 확인, ${Date.now() - startTime}ms`);
      result.elapsed = Date.now() - startTime;
      _lastRunResult = result;
      return result;
    }

    logger.info(`[smartBuild] #${runNum} 변경 감지: ${changedSheetIds.length}/${sheetIds.length}개 시트`);

    // ── 2.5단계: 빌드 대상 시트에 서비스계정 쓰기권한 자동 보장 ──
    // (인덱스 빌드 시마다 자동 적용 — 기존 수동 "시트 쓰기권한 일괄부여" 버튼 대체)
    await _ensureSheetsShared(changedSheetIds, result);

    // ── 3단계: 변경된 시트별 batchGet + 체크섬 비교 + DB 갱신 ──
    for (const sheetId of changedSheetIds) {
      // ★ 시트 lane 중간 양보 — 제출/주문 버스트 중이면 남은 변경 시트는 다음 주기로 연기.
      //   modifiedTime 캐시를 지워 다음 주기에 반드시 재감지(변경 유실 없음). 백스톱: 전체빌드 cron.
      //   noYield(관리자 강제실행/DB재구축)는 조각나지 않게 양보 없이 완주.
      if (!noYield && getThrottleStatus().requestsInLastMinute > SMARTBUILD_YIELD_THRESHOLD) {
        result.sheetsDeferred++;
        delete _modifiedTimeCache[sheetId];
        continue;
      }
      let sheetHadError = false;
      try {
        // 시트 메타 조회 (탭 목록) — throttle 적용
        const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
        const spreadsheetTitle = meta._spreadsheetTitle || '';
        const validTabs = meta.filter(s => {
          const title = s.properties.title;
          // 시스템 탭 제외
          if (SYSTEM_TABS.includes(title)) return false;
          // 숨겨진 탭 제외
          if (s.properties.hidden) return false;
          return true;
        });

        if (validTabs.length === 0) continue;

        // 활성 탭만 필터 (마감 탭 + 아카이브 탭 제외)
        // ★ tab_name 매칭 + gid 매칭 (탭 이름 변경 후에도 아카이브 상태 유지)
        const activeTabs = validTabs.filter(t => {
          const key = `${sheetId}||${t.properties.title}`;
          if (archivedSet.has(key)) return false;
          // gid 기반 매칭 (탭 이름이 변경되어도 아카이브 감지)
          const gidStr = String(t.properties.sheetId);
          const gidKey = `${sheetId}||gid:${gidStr}`;
          if (archivedGidSet && archivedGidSet.has(gidKey)) return false;
          return !closedSet.has(key);
        });

        if (activeTabs.length === 0) continue;

        // batchGet으로 한번에 읽기
        const BATCH_CHUNK_SIZE = 50;
        const ranges = activeTabs.map(t => `'${t.properties.title}'!A:Z`);
        let batchResults = [];

        try {
          if (ranges.length <= BATCH_CHUNK_SIZE) {
            batchResults = await throttledCall(() => batchReadSheet(sheetId, ranges));
          } else {
            for (let i = 0; i < ranges.length; i += BATCH_CHUNK_SIZE) {
              const chunkRanges = ranges.slice(i, i + BATCH_CHUNK_SIZE);
              const chunk = await throttledCall(() => batchReadSheet(sheetId, chunkRanges));
              batchResults.push(...chunk);
            }
          }
        } catch (batchErr) {
          // batchGet 실패 → 개별 읽기 폴백 (throttle 적용)
          logger.warn(`[smartBuild] batchGet 실패 (${sheetId.substring(0, 15)}), 개별 읽기 폴백: ${batchErr.message}`);
          batchResults = [];
          for (const tab of activeTabs) {
            try {
              const values = await throttledCall(() => readSheet(sheetId, `'${tab.properties.title}'!A:Z`));
              batchResults.push({ values: values || [] });
            } catch (readErr) {
              batchResults.push({ values: [], error: readErr.message });
            }
          }
        }

        // 탭별 처리
        for (let i = 0; i < activeTabs.length; i++) {
          const tab = activeTabs[i];
          const tabName = tab.properties.title;
          const tabGid = String(tab.properties.sheetId);
          const key = `${sheetId}||${tabName}`;

          result.tabsScanned++;

          try {
            const batchItem = batchResults[i];
            const values = batchItem?.values || batchItem?.data?.values || [];

            if (!values || values.length < 2) {
              result.tabsSkipped++;
              continue;
            }

            // 체크섬 비교
            const newChecksum = computeChecksum(values);
            if (_checksumCache[key] === newChecksum) {
              result.tabsSkipped++;
              continue;
            }

            // 변경됨 → 파싱 + DB 갱신
            // ★ P2b: DB컬럼매핑(있으면) 로드 → 매핑 우선. 없으면 null=키워드 전용(P2a 동일).
            const dbColMap = await require('./columnMapping.service').getTabColumnIndexMap(sheetId, tabGid);
            const rows = _parseTabRows(values, sheetId, tabName, tabGid, spreadsheetTitle, dbColMap);

            if (rows.length === 0) {
              // ★ 인식 실패 탭 기록 (indexBuilder와 동일)
              await _recordUnrecognizedTab(sheetId, tabName, tabGid, spreadsheetTitle, values);
              result.tabsSkipped++;
              continue;
            }

            const modifiedTime = _modifiedTimeCache[sheetId]?.modifiedTime || null;
            await _upsertTab(sheetId, tabName, tabGid, newChecksum, rows, modifiedTime, spreadsheetTitle, archivedRoundsCache);

            // ★ 인식 성공 → unrecognized_tabs에서 resolve
            await _resolveRecognizedTab(sheetId, tabName, tabGid);

            // 체크섬 캐시 갱신
            _checksumCache[key] = newChecksum;
            result.tabsUpdated++;

            // ★ round 데이터 디버그 로깅
            const roundCounts = {};
            for (const r of rows) {
              const rv = r.round || '(빈값)';
              roundCounts[rv] = (roundCounts[rv] || 0) + 1;
            }
            const roundSummary = Object.entries(roundCounts).map(([k,v]) => `${k}:${v}`).join(', ');
            logger.info(`[smartBuild] 갱신: ${spreadsheetTitle}/${tabName} — ${rows.length}행 (제출:${rows.filter(r => r.isSubmitted).length}) [차수: ${roundSummary}]`);

          } catch (tabErr) {
            sheetHadError = true;
            result.errors++;
            result.errorDetails.push({ phase: 'tab', sheetId: sheetId.substring(0, 15), tabName, error: tabErr.message, desc: _translateError(tabErr.message) });
            logger.error(`[smartBuild] 탭 처리 오류 (${tabName}): ${tabErr.message}`);
          }
        }

      } catch (sheetErr) {
        sheetHadError = true;
        result.errors++;
        result.errorDetails.push({ phase: 'sheet', sheetId: sheetId.substring(0, 15), error: sheetErr.message, desc: _translateError(sheetErr.message) });
        logger.error(`[smartBuild] 시트 처리 오류 (${sheetId.substring(0, 15)}): ${sheetErr.message}`);
      }
      // ★ 실패 시트는 캐시 무효화(다음 주기 재시도) — 미반영 데이터가 "반영됨"으로 영속되는 것 방지.
      //   연속 실패가 상한을 넘으면 캐시 유지 → 재읽기 루프 중단(백스톱: 04시 전체빌드/다음 편집).
      if (sheetHadError) {
        const streak = (_sheetErrStreak[sheetId] || 0) + 1;
        _sheetErrStreak[sheetId] = streak;
        if (streak <= SHEET_ERR_RETRY_CYCLES) {
          delete _modifiedTimeCache[sheetId];
        } else {
          logger.warn(`[smartBuild] ${sheetId.substring(0, 15)} ${streak}주기 연속 실패 — 재시도 중단(캐시 유지)`);
        }
      } else {
        delete _sheetErrStreak[sheetId];
      }
    }

    result.elapsed = Date.now() - startTime;
    logger.info(`[smartBuild] #${runNum} 완료: 변경 ${result.sheetsChanged}시트(연기 ${result.sheetsDeferred}), 스캔 ${result.tabsScanned}탭, 갱신 ${result.tabsUpdated}탭, 스킵 ${result.tabsSkipped}, 오류 ${result.errors}, ${result.elapsed}ms`);

    // ★ modifiedTime 캐시 스냅샷 저장 — 다음 재배포의 콜드스타트 전체 스윕 제거(best-effort)
    await _persistModifiedCache(sheetIds);

    // 빌드 히스토리 기록
    try {
      await pool.query(`
        INSERT INTO build_history (elapsed_ms, rebuilt, skipped, errors, total, trigger_by, build_log)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        result.elapsed, result.tabsUpdated, result.tabsSkipped, result.errors,
        result.tabsScanned, `smart_build_#${runNum}`,
        JSON.stringify({ sheetsChanged: result.sheetsChanged, errorDetails: result.errorDetails })
      ]);
    } catch (_) {}

    // ── 리뷰/캡처 폴더 자동 보장 (신규/미연결 활성 탭) ──
    //   on-demand(첫 업로드) 생성에만 의존하던 것을 보완 — 탭이 추가되면
    //   tnaks6325 소유 [리뷰]/[구매캡처] 폴더를 미리 만들어 연결한다.
    //   (타 소유권/미연결 폴더 예방). best-effort: 실패해도 빌드에 영향 없음.
    try {
      const reviewFolders = require('./reviewFolders.service');
      const rf = await reviewFolders.ensureReviewFoldersForActiveTabs({ limit: 30 });
      result.reviewFoldersCreated = rf.reviewCreated || 0;
      result.captureFoldersCreated = rf.captureCreated || 0;
      result.folderLinkErrors = rf.errors || 0; // 지속 실패 탭 가시화(예: 권한/이름 문제)
      if (rf.reviewCreated || rf.captureCreated || rf.errors) {
        logger.info(`[smartBuild] #${runNum} 폴더 자동연결: 리뷰 ${rf.reviewCreated}, 캡처 ${rf.captureCreated}, 오류 ${rf.errors}${rf.capped ? ' (일부 다음 주기)' : ''}`);
      }
    } catch (e) {
      logger.warn(`[smartBuild] 폴더 자동연결 스킵: ${e.message}`);
    }

  } catch (err) {
    result.ok = false;
    result.errors++;
    result.errorDetails.push({ phase: 'global', error: err.message, desc: _translateError(err.message) });
    logger.error(`[smartBuild] #${runNum} 전체 오류: ${err.message}`);
  } finally {
    result.elapsed = Date.now() - startTime;
    // ★ G4: 보유한 build_locks 해제(획득한 경우만). 실패해도 TTL(10분)로 자동 회수.
    if (_buildLockHeld) {
      try { const { releaseBuildLock } = require('./indexBuilder.service'); await releaseBuildLock(); }
      catch (e) { logger.warn(`[smartBuild] build lock 해제 실패(무시, TTL 회수): ${e.message}`); }
      _buildLockHeld = false;
    }
    _isRunning = false;
    _lastRunResult = result;

    // ★ SSE 브로드캐스트: 변경이 있었을 때만 알림
    if (result.tabsUpdated > 0 || result.errors > 0) {
      try {
        const { broadcast } = require('../utils/sse');
        broadcast('smart_build_done', {
          message: `스마트빌드 #${runNum} 완료: ${result.sheetsChanged}시트 변경, ${result.tabsUpdated}탭 갱신, ${result.errors}건 오류 (${(result.elapsed/1000).toFixed(1)}s)`,
          ...result,
        });
      } catch (_) {}
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 스케줄러: 5분 주기 자동 실행
// ═══════════════════════════════════════════════════════════

async function startSmartBuild() {
  if (_intervalHandle) {
    logger.warn('[smartBuild] 이미 스케줄러 실행 중');
    return false;
  }

  // ★ RED-2: 부팅 시 관리자 pause 상태 복원(재배포로 정지 의도가 뒤집히지 않게).
  _pausedUntil = await _loadPersistedPause();
  if (_pausedUntil) {
    logger.warn(`[smartBuild] 부팅 시 pause 복원 — ${_pausedUntil.toISOString()}까지 정지(자동재개)`);
  }

  _startedAt = new Date().toISOString();
  logger.info(`[smartBuild] 스케줄러 시작 — ${SMART_BUILD_INTERVAL_MS / 1000}초 주기`);

  // 최초 실행도 pause 판정 경유(부팅복원 pause가 첫 tick에도 적용 — 심판 수정1).
  setTimeout(() => { _tickSmartBuild(); }, 30 * 1000);
  _intervalHandle = setInterval(() => { _tickSmartBuild(); }, SMART_BUILD_INTERVAL_MS);

  return true;
}

// tick: interval은 계속 돌되 pause면 스킵. pausedUntil 경과 시 자동 재개(끈 채 방치 방지 — RED-1).
function _tickSmartBuild() {
  if (_pausedUntil) {
    if (Date.now() < _pausedUntil.getTime()) {
      logger.debug(`[smartBuild] pause 중 — ${_pausedUntil.toISOString()}까지 tick 스킵`);
      return;
    }
    logger.info('[smartBuild] pause 만료 — 자동 재개');
    _pausedUntil = null;
    _persistPauseUntil(''); // 영속 해제(다음 부팅 복원 안 됨)
  }
  runSmartBuild().catch(err => logger.error(`[smartBuild] 주기 실행 오류: ${err.message}`));
}

// graceful shutdown 전용(index.js) — 영구 clearInterval. 영속 pause는 안 건드림(재부팅 시 정상 재기동).
//   ⚠️ 관리자 정지는 반드시 pauseSmartBuild 경유(영속·자동재개). 이건 프로세스 종료용.
function stopSmartBuild() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    logger.info('[smartBuild] 스케줄러 중지(프로세스 종료)');
    return true;
  }
  return false;
}

// 관리자 일시정지: interval 유지, pausedUntil까지 tick만 스킵(자동재개·영속화). RED-1/RED-2.
async function pauseSmartBuild(minutes) {
  const min = Number.isFinite(minutes) && minutes > 0 ? minutes : SMART_BUILD_DEFAULT_PAUSE_MIN;
  _pausedUntil = new Date(Date.now() + min * 60 * 1000);
  await _persistPauseUntil(_pausedUntil.toISOString());
  logger.info(`[smartBuild] pause ${min}분 — ${_pausedUntil.toISOString()}까지(자동재개)`);
  return { paused: true, pausedUntil: _pausedUntil.toISOString(), autoResumeMinutes: min };
}

async function resumeSmartBuild() {
  _pausedUntil = null;
  await _persistPauseUntil('');
  logger.info('[smartBuild] 수동 재개');
  return { paused: false };
}

function getSmartBuildStatus() {
  const now = Date.now();
  const paused = !!(_pausedUntil && _pausedUntil.getTime() > now);
  const pausedMinutesLeft = paused ? Math.ceil((_pausedUntil.getTime() - now) / 60000) : 0;
  return {
    running: _isRunning,
    schedulerActive: !!_intervalHandle,
    paused,
    pausedUntil: _pausedUntil ? _pausedUntil.toISOString() : null,
    pausedMinutesLeft,
    // schedulerActive=false(킬스위치/미기동) 또는 paused면 근실시간 변경감지 없음 → 대시보드 배너용(RED-1).
    staleWarning: (!_intervalHandle) || paused,
    staleReason: !_intervalHandle ? 'scheduler_inactive' : (paused ? 'paused' : null),
    startedAt: _startedAt,
    intervalMs: SMART_BUILD_INTERVAL_MS,
    runCount: _runCount,
    cachedSheets: Object.keys(_modifiedTimeCache).length,
    cachedChecksums: Object.keys(_checksumCache).length,
    lastRun: _lastRunResult,
  };
}

// ═══════════════════════════════════════════════════════════
// 캐시 리셋 — DB 초기화 후 전체 재빌드를 위해
// ═══════════════════════════════════════════════════════════

// P2c: 단일 탭 체크섬 무효화 — 매핑 변경 시 smartBuild 인메모리 캐시에서 그 탭만 제거.
//   (index_master.checksum=NULL은 saveMapping이 DB에 직접 수행; 이 함수는 장수 프로세스의
//    인메모리 _checksumCache가 isFirstRun 이후 DB를 다시 안 읽는 문제를 보완 — 다음 주기에 강제 재파싱.)
//   tabName 또는 tabGid(현재 인덱스의 tab_name 역추적)로 매칭. 데이터 미변경이라 1회만 재파싱 후 안정화.
function invalidateChecksumCache(sheetId, tabName) {
  if (!sheetId) return 0;
  let n = 0;
  if (tabName) {
    const key = `${sheetId}||${tabName}`;
    if (Object.prototype.hasOwnProperty.call(_checksumCache, key)) {
      delete _checksumCache[key];
      n++;
    }
  }
  // 시트 단위 modifiedTime 캐시도 무효화 — 시트가 그동안 미편집이어도 다음 주기에
  // 재읽기·재파싱되도록(매핑 변경 즉시 반영 의도 관철; 캐시 키는 sheetId 단위).
  if (Object.prototype.hasOwnProperty.call(_modifiedTimeCache, sheetId)) {
    delete _modifiedTimeCache[sheetId];
    n++;
    // 영속 스냅샷에도 즉시 반영 — 다음 사이클 전 재배포돼도 복원이 이 시트를 되살리지 않게(best-effort)
    _persistModifiedCache();
  }
  if (n) logger.info(`[smartBuild] 체크섬 캐시 무효화 — sheet=${String(sheetId).slice(0,12)} tab=${tabName} (${n}건) → 다음 주기 재파싱`);
  return n;
}

function resetSmartBuildCache() {
  const prev = {
    modifiedTimeEntries: Object.keys(_modifiedTimeCache).length,
    checksumEntries: Object.keys(_checksumCache).length,
  };
  _modifiedTimeCache = {};
  _checksumCache = {};
  _lastRunResult = null;
  // DB의 index_master.checksum도 NULL로 초기화 → 다음 빌드에서 전체 탭 강제 갱신
  pool.query("UPDATE index_master SET checksum = NULL").catch(err => {
    logger.error(`[SmartBuild] DB 체크섬 초기화 실패: ${err.message}`);
  });
  // 영속 modifiedTime 캐시도 함께 삭제 — 리셋 후 첫 주기가 전 시트를 재읽기하도록(전체 재빌드 의도 보존)
  // + DELETE 실패/지연 대비 1회성 복원 스킵 플래그(리셋 직후 첫 실행이 옛 스냅샷을 되살리지 않게)
  _skipPersistedRestore = true;
  pool.query("DELETE FROM app_settings WHERE key = 'smart_build_modified_cache'").catch(err => {
    logger.error(`[SmartBuild] 영속 modifiedTime 캐시 삭제 실패: ${err.message}`);
  });
  logger.info(`[SmartBuild] 캐시 리셋 완료 — modifiedTime: ${prev.modifiedTimeEntries}→0, checksum: ${prev.checksumEntries}→0, DB checksum→NULL`);
  return prev;
}

// ═══════════════════════════════════════════════════════════
// ★ 인식 실패 탭 기록 (indexBuilder와 동일 로직)
// parseTabRows가 빈 배열을 반환한 탭을 unrecognized_tabs에 기록
// ═══════════════════════════════════════════════════════════

async function _recordUnrecognizedTab(sheetId, tabName, tabGid, campaignName, values) {
  try {
    // 실패 원인 분석
    let reason = 'unknown';
    if (!values || values.length === 0) {
      reason = 'empty';
    } else if (values.length < 2) {
      reason = 'few_rows';
    } else {
      let headerRowIdx = -1;
      for (let i = 0; i < Math.min(values.length, 50); i++) {
        const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
        if (_isDataTabRow(cells)) {
          headerRowIdx = i;
          break;
        }
      }
      if (headerRowIdx < 0) {
        reason = 'no_header';
      } else {
        const headers = values[headerRowIdx].map(h => String(h || '').trim());
        const nameColIdx = headers.findIndex(h =>
          NAME_KEYWORDS.some(k => h.includes(k))
        );
        if (nameColIdx < 0) {
          reason = 'no_name_col';
        } else {
          const dataRows = values.slice(headerRowIdx + 1);
          const hasAnyName = dataRows.some(row => {
            const name = String((row && row[nameColIdx]) || '').trim();
            return name.length > 0;
          });
          reason = hasAnyName ? 'no_name_col' : 'no_data';
        }
      }
    }

    // no_data: 헤더 정상, 데이터 미입력 → 인식 실패가 아니므로 기록 스킵
    if (reason === 'no_data') {
      await pool.query(
        `UPDATE unrecognized_tabs SET status = 'resolved'
         WHERE sheet_id = $1 AND (tab_name = $2 OR tab_gid = $3) AND status = 'pending'`,
        [sheetId, tabName, tabGid]
      );
      return;
    }

    // 첫 55행 샘플
    const sampleRows = (values || []).slice(0, 55).map(row =>
      (row || []).map(c => String(c || '').trim()).slice(0, 15)
    );

    await pool.query(`
      INSERT INTO unrecognized_tabs (sheet_id, tab_name, tab_gid, campaign_name, sample_rows, reason, status, detected_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        campaign_name = EXCLUDED.campaign_name,
        sample_rows = EXCLUDED.sample_rows,
        reason = EXCLUDED.reason,
        status = CASE WHEN unrecognized_tabs.status = 'ignored' THEN 'ignored' ELSE 'pending' END,
        detected_at = NOW()
    `, [sheetId, tabName, tabGid, campaignName, JSON.stringify(sampleRows), reason]);
  } catch (err) {
    logger.warn(`[smartBuild] 인식 실패 탭 기록 오류 (${tabName}): ${err.message}`);
  }
}

// 인식 성공한 탭은 unrecognized_tabs에서 resolve
async function _resolveRecognizedTab(sheetId, tabName, tabGid) {
  try {
    await pool.query(
      `UPDATE unrecognized_tabs SET status = 'resolved' WHERE sheet_id = $1 AND tab_name = $2 AND status = 'pending'`,
      [sheetId, tabName]
    );
    if (tabGid) {
      await pool.query(
        `UPDATE unrecognized_tabs SET status = 'resolved' WHERE sheet_id = $1 AND tab_gid = $2 AND tab_name != $3 AND status = 'pending'`,
        [sheetId, tabGid, tabName]
      );
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════

module.exports = {
  runSmartBuild,
  startSmartBuild,
  stopSmartBuild,
  pauseSmartBuild,
  resumeSmartBuild,
  getSmartBuildStatus,
  resetSmartBuildCache,
  invalidateChecksumCache,
  SMART_BUILD_INTERVAL_MS,
  _tickSmartBuild,
  _loadPersistedPause,
};
