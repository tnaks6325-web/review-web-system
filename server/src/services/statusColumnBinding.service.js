'use strict';

// v2 작업표의 상태 열은 이름 추측으로 찾지 않는다. 생성 시의 열 위치와 헤더를
// 함께 저장/검증하여, 리뷰옵션 같은 비어있지 않은 작업지시 값이 제출로 읽히는
// 사고를 차단한다.
const STATUS_HEADERS = Object.freeze({ review_submit: '리뷰', payment_status: '입금일' });

class StatusColumnBindingError extends Error {
  constructor(code, message) { super(message); this.name = 'StatusColumnBindingError'; this.code = code; }
}

function buildV2StatusBindings(headers) {
  const list = (headers || []).map(v => String(v || '').trim());
  const bindings = {};
  for (const [role, header] of Object.entries(STATUS_HEADERS)) {
    const indices = list.reduce((out, value, index) => (value === header ? out.concat(index) : out), []);
    if (indices.length !== 1) {
      throw new StatusColumnBindingError('v2_status_binding_missing', `v2 작업표의 ${header} 열은 정확히 하나여야 합니다.`);
    }
    bindings[role] = { header, colIndex: indices[0] };
  }
  return bindings;
}

function validateV2StatusBindings(headers, bindings) {
  const list = (headers || []).map(v => String(v || '').trim());
  for (const [role, expected] of Object.entries(STATUS_HEADERS)) {
    const b = bindings && bindings[role];
    if (!b || b.header !== expected || !Number.isInteger(b.colIndex) || list[b.colIndex] !== expected) {
      throw new StatusColumnBindingError('v2_status_binding_drift', `v2 ${expected} 상태 열 구성이 변경되어 처리를 중단했습니다.`);
    }
  }
  return bindings;
}

function isV2ReviewSubmitted(value) {
  const text = String(value || '').trim();
  return text === '제출' || text === 'O'; // 기존 v2 전환 중 생성분의 O만 읽기 호환
}

function isV2PaymentSubmitted(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  // 실제 입금 기록기 형식(M/D HH:mm)만 인정한다. 임의의 '입금완료' 텍스트는 상태가 아니다.
  return text.split(',').map(v => v.trim()).filter(Boolean)
    .every(v => /^\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}$/.test(v));
}

async function seedV2StatusBindings(db, { sheetId, tabGid, tabName, headers, by = '' }) {
  const bindings = buildV2StatusBindings(headers);
  for (const [role, binding] of Object.entries(bindings)) {
    await db.query(
      `INSERT INTO tab_status_column_bindings
         (sheet_id, tab_gid, tab_name, role, header_text, col_index, workboard_schema_version, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,2,$7)
       ON CONFLICT (sheet_id, tab_gid, role) DO NOTHING`,
      [sheetId, String(tabGid), tabName, role, binding.header, binding.colIndex, by]
    );
  }
  const { rows } = await db.query(
    `SELECT role, header_text, col_index FROM tab_status_column_bindings
      WHERE sheet_id=$1 AND tab_gid=$2`, [sheetId, String(tabGid)]
  );
  const stored = Object.fromEntries(rows.map(r => [r.role, { header: r.header_text, colIndex: Number(r.col_index) }]));
  return validateV2StatusBindings(headers, stored);
}

async function loadV2StatusBindings(db, { sheetId, tabGid, headers }) {
  const { rows } = await db.query(
    `SELECT role, header_text, col_index FROM tab_status_column_bindings
      WHERE sheet_id=$1 AND tab_gid=$2`, [sheetId, String(tabGid)]
  );
  const stored = Object.fromEntries(rows.map(r => [r.role, { header: r.header_text, colIndex: Number(r.col_index) }]));
  return validateV2StatusBindings(headers, stored);
}

module.exports = { STATUS_HEADERS, StatusColumnBindingError, buildV2StatusBindings, validateV2StatusBindings,
  isV2ReviewSubmitted, isV2PaymentSubmitted, seedV2StatusBindings, loadV2StatusBindings };
