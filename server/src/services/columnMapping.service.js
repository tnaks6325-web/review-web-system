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

  return { saved: clean.length, mapped: clean.filter(c => c.dbField).length };
}

module.exports = {
  STANDARD_FIELDS,
  OWNERS,
  getFieldRegistry,
  autoGuessField,
  defaultOwnerOf,
  getMapping,
  saveMapping,
};
