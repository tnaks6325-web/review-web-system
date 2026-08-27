/**
 * columnMapping.service.js
 * 명시적 컬럼 매핑 레이어 (구글시트 점진 대체의 keystone)
 *
 * 역할:
 *   - 표준 DB 필드 레지스트리(STANDARD_FIELDS) 정의
 *   - 시트 헤더 → 표준필드 자동 추측(autoGuessField) — 기존 _mapOrderToRow/parseTabRows 키워드 재사용
 *   - 탭별 매핑 조회/저장 (tab_column_mappings)
 *
 * 2a 단계: 매핑을 "정의/열람/편집"만 한다. 아직 쓰기 로직(_mapOrderToRow 등)은 바꾸지 않는다.
 *
 * owner(열 소유권): 'db'(DB권위) | 'sheet'(시트권위) | 'shared'(공용)
 *   → 양방향 동기화 충돌을 "누가 주인인가"로 원천 차단하기 위한 기준
 */

const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const OWNERS = ['db', 'sheet', 'shared'];

// ── 표준 필드 레지스트리 ──
// match: 'exact'(헤더 전체 일치) | 'includes'(부분 포함)
// 우선순위 = 배열 순서 (구체적/고유한 키워드를 앞에 둔다)
// ★ 우선순위 원칙:
//   (1) 고유/명시 키워드(인애드·주문번호) 먼저
//   (2) 속성형 컬럼(연락처·주소·은행·계좌·금액)을 이름형(주문자·수취인·예금주)보다 먼저
//       → "받는분 주소", "수취인 연락처" 같은 결합 헤더에서 속성이 우선 인식되도록
const STANDARD_FIELDS = [
  { key: 'row_no',        label: '번호(관리)',   defaultOwner: 'sheet',  match: 'exact',    keywords: ['번호', 'no', '#'] },
  { key: 'inad_name',     label: '인애드명단',    defaultOwner: 'sheet',  match: 'includes', keywords: ['인애드'] },
  { key: 'nickname',      label: '닉네임/카톡',   defaultOwner: 'sheet',  match: 'includes', keywords: ['닉네임', '카톡'] },
  { key: 'order_num',     label: '주문번호',      defaultOwner: 'db',     match: 'includes', keywords: ['주문번호', 'ordernum'] },
  { key: 'phone',         label: '연락처',        defaultOwner: 'db',     match: 'includes', keywords: ['연락처', '전화', '핸드폰', '휴대폰', '전번', 'phone'] },
  { key: 'address',       label: '주소',          defaultOwner: 'db',     match: 'includes', keywords: ['주소', 'address'] },
  { key: 'bank',          label: '은행',          defaultOwner: 'db',     match: 'includes', keywords: ['은행', 'bank'] },
  { key: 'account',       label: '계좌',          defaultOwner: 'db',     match: 'includes', keywords: ['계좌', 'account'] },
  { key: 'price',         label: '금액',          defaultOwner: 'db',     match: 'includes', keywords: ['금액', '가격', 'price'] },
  { key: 'depositor',     label: '예금주',        defaultOwner: 'db',     match: 'includes', keywords: ['예금주', 'depositor'] },
  { key: 'orderer',       label: '주문자',        defaultOwner: 'db',     match: 'includes', keywords: ['주문자', 'orderer'] },
  { key: 'recipient',     label: '수취인',        defaultOwner: 'db',     match: 'includes', keywords: ['수취인', '받는분'] },
  { key: 'review_submit', label: '리뷰제출',      defaultOwner: 'shared', match: 'includes', keywords: ['리뷰제출', '리뷰완료', '리뷰작성', '리뷰'] },
  { key: 'payment',       label: '입금',          defaultOwner: 'shared', match: 'includes', keywords: ['입금', '페이백'] },
  { key: 'round',         label: '차수',          defaultOwner: 'sheet',  match: 'includes', keywords: ['차수', '회차', 'round'] },
  { key: 'product',       label: '상품',          defaultOwner: 'sheet',  match: 'includes', keywords: ['상품', '제품', 'product'] },
  { key: 'user_id',       label: '아이디',        defaultOwner: 'db',     match: 'includes', keywords: ['아이디', 'userid', '로그인'] },
  { key: 'order_date',    label: '구매일/날짜',   defaultOwner: 'shared', match: 'includes', keywords: ['구매일', '주문일', '일자', '날짜', 'date'] },
  { key: 'option_1',      label: '1차옵션',       defaultOwner: 'sheet',  match: 'includes', keywords: ['1차옵션', '1st option'] },
  { key: 'option_2',      label: '2차옵션',       defaultOwner: 'sheet',  match: 'includes', keywords: ['2차옵션', '2nd option'] },
  { key: 'option',        label: '옵션',          defaultOwner: 'shared', match: 'includes', keywords: ['옵션', 'option'] },
  { key: 'memo',          label: '비고/메모',     defaultOwner: 'shared', match: 'includes', keywords: ['비고', '특이사항', 'memo'] },
  // 마지막 폴백: 이름/성함 → 수취인 (모호하므로 최하위, 사용자가 교정)
  { key: 'recipient',     label: '수취인',        defaultOwner: 'db',     match: 'includes', keywords: ['이름', '성함'] },
];

const FIELD_KEYS = new Set(STANDARD_FIELDS.map(f => f.key));

/** 필드 메타(드롭다운용) — 중복 key 제거 */
function getFieldRegistry() {
  const seen = new Set();
  const out = [];
  for (const f of STANDARD_FIELDS) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    out.push({ key: f.key, label: f.label, defaultOwner: f.defaultOwner });
  }
  return out;
}

function defaultOwnerOf(fieldKey) {
  const f = STANDARD_FIELDS.find(x => x.key === fieldKey);
  return f ? f.defaultOwner : 'sheet';
}

/**
 * 헤더 문자열 → 표준 필드 key 자동 추측 (없으면 null)
 */
function autoGuessField(header) {
  const h = String(header || '').trim().toLowerCase();
  if (!h) return null;
  for (const f of STANDARD_FIELDS) {
    if (f.match === 'exact') {
      if (f.keywords.some(k => h === k.toLowerCase())) return f.key;
    } else {
      if (f.keywords.some(k => h.includes(k.toLowerCase()))) return f.key;
    }
  }
  return null;
}

/**
 * 탭의 현재 헤더(raw_sheet_tabs.headers) + 저장된 매핑을 병합하여 컬럼 뷰 반환
 * @returns {{ hasHeaders, tab, columns: Array }}
 *   columns: { colIndex, header, autoGuess, dbField, owner, stored, drift }
 */
async function getMapping(sheetId, tabGid) {
  const gid = String(tabGid);

  // 현재 헤더 — raw 미러에서 가져옴 (미러링돼 있어야 함)
  const { rows: tabRows } = await pool.query(
    `SELECT tab_name, spreadsheet_title, headers, detected_headers,
            header_row_index, data_start_row, col_count
       FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2`,
    [sheetId, gid]
  );
  const tab = tabRows[0] || null;
  const headers = tab && Array.isArray(tab.detected_headers)
    ? tab.detected_headers
    : (tab && Array.isArray(tab.headers) ? tab.headers : []);

  // 저장된 매핑
  const { rows: stored } = await pool.query(
    `SELECT col_index, header_text, db_field, owner
       FROM tab_column_mappings WHERE sheet_id = $1 AND tab_gid = $2`,
    [sheetId, gid]
  );
  const storedMap = new Map(stored.map(r => [r.col_index, r]));

  // 컬럼 수: 헤더가 있으면 헤더 길이, 없으면 저장된 col_index 최대값
  let colCount = headers.length;
  if (colCount === 0 && stored.length > 0) {
    colCount = Math.max(...stored.map(r => r.col_index)) + 1;
  }

  const columns = [];
  for (let i = 0; i < colCount; i++) {
    const header = headers[i] !== undefined && headers[i] !== null ? String(headers[i]) : '';
    const guess = autoGuessField(header);
    const s = storedMap.get(i);
    columns.push({
      colIndex: i,
      header,
      autoGuess: guess,
      dbField: s ? (s.db_field || null) : guess,                 // 저장값 우선, 없으면 추측
      owner: s ? s.owner : (guess ? defaultOwnerOf(guess) : 'sheet'),
      stored: !!s,
      drift: !!(s && s.header_text !== null && s.header_text !== header),  // 헤더 변경 감지
    });
  }

  return {
    hasHeaders: headers.length > 0,
    tab: tab ? {
      tabName: tab.tab_name,
      spreadsheetTitle: tab.spreadsheet_title,
      colCount: tab.col_count,
      headerRowIndex: tab.header_row_index || null,
      dataStartRow: tab.data_start_row || null,
      detected: Array.isArray(tab.detected_headers),
    } : null,
    columns,
  };
}

/**
 * 매핑 저장 — 해당 탭의 모든 컬럼을 교체(replace)
 * @param {Array} columns - [{ colIndex, header, dbField, owner }]
 */
async function saveMapping(sheetId, tabGid, tabName, columns, updatedBy) {
  const gid = String(tabGid);
  if (!Array.isArray(columns)) throw new Error('columns 배열이 필요합니다.');

  // 유효성 정리
  const clean = columns.map(c => {
    const dbField = c.dbField && FIELD_KEYS.has(c.dbField) ? c.dbField : null;
    let owner = OWNERS.includes(c.owner) ? c.owner : null;
    if (!owner) owner = dbField ? defaultOwnerOf(dbField) : 'sheet';
    return {
      colIndex: parseInt(c.colIndex),
      header: c.header !== undefined && c.header !== null ? String(c.header) : '',
      dbField,
      owner,
    };
  }).filter(c => Number.isInteger(c.colIndex) && c.colIndex >= 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM tab_column_mappings WHERE sheet_id = $1 AND tab_gid = $2',
      [sheetId, gid]
    );
    for (const c of clean) {
      await client.query(
        `INSERT INTO tab_column_mappings
           (sheet_id, tab_gid, tab_name, col_index, header_text, db_field, owner, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8)`,
        [sheetId, gid, tabName || null, c.colIndex, c.header, c.dbField, c.owner, updatedBy || null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ── P2c: 매핑 변경 = 컬럼해석 변경. 시트 데이터 체크섬은 그대로라 빌더가 스킵하므로,
  //   해당 탭의 index_master.checksum=NULL로 강제 무효화 → 두 빌더(인덱스/스마트)가 다음 빌드에서 재파싱.
  //   (시트 데이터 미변경이라 재파싱 1회 후 동일 체크섬 재기록 → 자동 안정화.)
  //   best-effort: 실패해도 매핑 저장 자체는 성공 처리(다음 강제 재빌드/재시작으로 자가치유).
  try {
    await pool.query(
      `UPDATE index_master SET checksum = NULL
         WHERE sheet_id = $1 AND (tab_gid = $2 OR tab_name = $3)`,
      [sheetId, gid, tabName || null]
    );
    // 스마트빌드 장수 프로세스의 인메모리 캐시도 무효화(isFirstRun 이후 DB 재로드 안 함)
    try { require('./smartBuild.service').invalidateChecksumCache(sheetId, tabName); } catch (_) {}
    logger.info(`[mapping] 체크섬 무효화 — sheet=${String(sheetId).slice(0,12)} gid=${gid} tab=${tabName} → 다음 빌드 재파싱`);
  } catch (err) {
    logger.warn(`[mapping] 체크섬 무효화 실패(무시, 매핑은 저장됨): ${err.message}`);
  }

  return { saved: clean.length, mapped: clean.filter(c => c.dbField).length };
}

/**
 * P2b: 인덱스 빌더용 경량 매핑 — db_field → { colIndex, header } Map.
 *   columnResolver가 컬럼감지를 "DB매핑 우선"으로 하기 위한 입력.
 *   매핑이 없거나(미설정 탭) sheetId/tabGid가 없으면 null → 빌더는 키워드 전용(P2a 동일).
 *   같은 db_field가 여러 컬럼에 매핑되면 가장 앞(작은 col_index)만 사용(determinism).
 * @returns {Promise<Map<string,{colIndex:number,header:string|null}>|null>}
 */
async function getTabColumnIndexMap(sheetId, tabGid) {
  if (!sheetId || tabGid === undefined || tabGid === null || tabGid === '') return null;
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT col_index, header_text, db_field
         FROM tab_column_mappings
        WHERE sheet_id = $1 AND tab_gid = $2 AND db_field IS NOT NULL
        ORDER BY col_index ASC`,
      [sheetId, String(tabGid)]
    ));
  } catch (err) {
    // 매핑 테이블 부재/조회 실패는 치명 아님 — 키워드 폴백(P2a 동일)
    return null;
  }
  if (!rows || !rows.length) return null;
  const m = new Map();
  for (const r of rows) {
    if (!r.db_field || m.has(r.db_field)) continue;       // 첫(최소 col_index) 매핑만
    if (!Number.isInteger(r.col_index) || r.col_index < 0) continue;
    m.set(r.db_field, { colIndex: r.col_index, header: r.header_text != null ? String(r.header_text) : null });
  }
  return m.size ? m : null;
}

// ═══════════════════════════════════════════════════════════
// 자동 기록 (detection snapshot) — 컬럼 판정 DB화 1단계의 백필 경로
//
//   빌더가 방금 파싱하며 "키워드가 실제로 고른 컬럼"(columnResolver meta)을 그대로 기록한다.
//   ★ autoGuessField/raw_sheet_tabs 헤더 기반 백필 금지 — columnResolver와 시맨틱이 달라
//     (예: '입금자명'은 resolver가 PAYMENT_EXCLUDE로 제외하지만 autoGuess는 payment로 매치)
//     기록≠실동작이 되어 숫자가 조용히 바뀐다. 기록은 반드시 "실제 판정 결과"만.
//   ★ 수동 매핑 절대 미덮어씀: 그 탭에 행이 하나라도 있으면(수동 저장 포함) 전체 skip
//     (원자 WHERE NOT EXISTS + ON CONFLICT DO NOTHING — saveMapping(replace-all)과 경합해도 수동이 승자).
//   ★ saveMapping과 달리 checksum 무효화를 하지 않는다 — 기록된 매핑 ≡ 방금 키워드 결과라
//     재파싱이 불필요(무변경)하고, 전 탭 백필 시 쿼터 폭풍을 막는다.
// ═══════════════════════════════════════════════════════════

// 자동 기록 대상 = columnResolver가 DB 오버라이드를 소비하는 6필드만.
// name(PII 가드)·url/날짜(resolver 미소비 → 죽은 매핑 방지)는 기록하지 않는다.
const RECORDABLE_FIELDS = ['recipient', 'review_submit', 'product', 'phone', 'round', 'payment'];

let _testPool = null;
function __setPoolForTest(p) { _testPool = p || null; }
function _db() { return _testPool || pool; }

async function recordDetectedMappings({ sheetId, tabGid, tabName, meta, by = 'auto:detect' } = {}) {
  if (!sheetId || tabGid === undefined || tabGid === null || tabGid === '') return { skipped: true, reason: 'no-gid' };
  if (!meta || !meta.fields) return { skipped: true, reason: 'no-meta' };
  const gid = String(tabGid);

  const seenCols = new Set();
  const candidates = [];
  for (const field of RECORDABLE_FIELDS) {
    const f = meta.fields[field];
    if (!f || f.src !== 'keyword' || !Number.isInteger(f.col) || f.col < 0) continue;
    if (seenCols.has(f.col)) continue; // 같은 컬럼 중복 매핑 방지(결정적)
    seenCols.add(f.col);
    candidates.push({
      colIndex: f.col,
      header: f.header != null ? String(f.header) : '',
      dbField: field,
      owner: defaultOwnerOf(field),
    });
  }
  if (!candidates.length) return { skipped: true, reason: 'no-candidates' };

  const params = [sheetId, gid, tabName || null, by];
  const valuesSql = candidates.map((c) => {
    const base = params.length;
    params.push(c.colIndex, c.header, c.dbField, c.owner);
    return `($${base + 1}::int, $${base + 2}::text, $${base + 3}::text, $${base + 4}::text)`;
  }).join(', ');

  try {
    const { rowCount } = await _db().query(
      `INSERT INTO tab_column_mappings
         (sheet_id, tab_gid, tab_name, col_index, header_text, db_field, owner, updated_at, updated_by)
       SELECT $1, $2, $3, v.col_index, v.header_text, v.db_field, v.owner, NOW(), $4
       FROM (VALUES ${valuesSql}) AS v(col_index, header_text, db_field, owner)
       WHERE NOT EXISTS (SELECT 1 FROM tab_column_mappings t WHERE t.sheet_id = $1 AND t.tab_gid = $2)
       ON CONFLICT (sheet_id, tab_gid, col_index) DO NOTHING`,
      params
    );
    if (rowCount > 0) {
      logger.info(`[mapping] 컬럼매핑 자동기록 — sheet=${String(sheetId).slice(0, 12)} gid=${gid} tab=${tabName} fields=${candidates.map(c => `${c.dbField}:${c.colIndex}`).join(',')}`);
    }
    return { recorded: rowCount };
  } catch (err) {
    // best-effort — 기록 실패가 빌드를 실패시키면 안 됨
    logger.warn(`[mapping] 컬럼매핑 자동기록 실패(무시): ${err.message}`);
    return { skipped: true, reason: 'error', error: err.message };
  }
}

module.exports = {
  STANDARD_FIELDS,
  OWNERS,
  getFieldRegistry,
  autoGuessField,
  defaultOwnerOf,
  getMapping,
  saveMapping,
  getTabColumnIndexMap,
  recordDetectedMappings,
  RECORDABLE_FIELDS,
  __setPoolForTest,
};
