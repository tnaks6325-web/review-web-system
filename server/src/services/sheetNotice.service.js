// ═══════════════════════════════════════════════════════════
// 시트 상단 강제 공지문 — 신규 탭 생성 시 자동 삽입 (선택: 사유 포함형 · C1:R1)
//
// 목적: 직원이 시트에서 "줄(행) 삭제"를 하면 그 아래 모든 기록의 행번호가 밀린다.
//   Track B 전환 전까지 시트 직접 편집이 불가피하므로, 규칙을 시트 안에서 항상 보이게 한다.
//
// ★★ 안전 불변식(절대 완화 금지): 공지문에 헤더 탐지 키워드가 2개 이상 들어가면
//   `detectSheetHeader`가 **공지 줄을 헤더로 오인**해 그 탭의 파싱이 통째로 깨진다
//   (공지는 헤더보다 위에 있고, 탐지는 위에서부터 첫 매칭 줄을 헤더로 확정하기 때문).
//   그래서 쓰기 전에 항상 `validateNoticeText`로 검사하고, 위험하면 **쓰지 않는다**.
//
// 위치: C1:R1 — 템플릿의 메타 영역(A1 캠페인명 / B1 값) 오른쪽 빈 칸.
//   행을 새로 삽입하지 않으므로 기존 기록의 행번호가 밀리지 않는다(리스크 0).
// ═══════════════════════════════════════════════════════════
const { logger } = require('../utils/logger');
const { HEADER_DETECT_KEYWORDS } = require('../utils/sheetHeader');
const { throttledCall } = require('../utils/sheetsThrottle');

// 선택된 기본 문구(사유 포함형) — app_settings.sheet_notice_text 로 덮어쓸 수 있다.
const DEFAULT_NOTICE =
  '⚠️ 구매취소·중복이 생겨도 줄(행)은 삭제하지 마시고 값만 지워주세요 · 줄을 지우면 아래 기록의 줄 번호가 전부 밀립니다';

const NOTICE_START_COL = 2;   // C (0-based)
const NOTICE_END_COL = 18;    // R 다음(exclusive)
const BG = { red: 0.996, green: 0.953, blue: 0.780 };          // 연한 앰버
const FG = { red: 0.486, green: 0.290, blue: 0.012 };          // 진한 갈색 글자

let _pool;
function getPool() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}
function __setPoolForTest(pool) { _pool = pool || null; }

/**
 * 공지문 안전 검사 — 헤더 탐지 키워드가 2개 이상이면 그 줄이 헤더로 오인된다.
 * `isSheetHeaderRow(minMatches=2)`와 동일 기준(단일 셀 문자열 기준으로 substring 매칭).
 */
function validateNoticeText(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { ok: false, reason: 'empty', hits: [] };
  const hits = [];
  for (const kw of HEADER_DETECT_KEYWORDS) {
    // '번호'는 셀 값이 정확히 '번호'일 때만 헤더 신호(원 로직과 동일) — 긴 문장은 해당 없음
    const found = kw === '번호' ? s === kw : s.includes(kw);
    if (found) hits.push(kw);
  }
  if (hits.length >= 2) return { ok: false, reason: 'header_collision', hits };
  return { ok: true, hits };
}

/** 운영 중 문구 교체용 — app_settings 우선, 없으면 기본 문구 */
async function getNoticeText() {
  try {
    const { rows } = await getPool().query(`SELECT value FROM app_settings WHERE key = 'sheet_notice_text' LIMIT 1`);
    const v = rows[0] && String(rows[0].value || '').trim();
    if (v) return v;
  } catch (_) { /* 조회 실패는 기본 문구로 폴백 */ }
  return DEFAULT_NOTICE;
}

async function setNoticeText(text) {
  const v = validateNoticeText(text);
  if (!v.ok) return { ok: false, error: '헤더 탐지와 충돌하는 문구입니다.', ...v };
  await getPool().query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('sheet_notice_text', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(text).trim()]
  );
  return { ok: true, text: String(text).trim() };
}

/**
 * 한 탭의 C1:R1에 공지문을 넣는다(병합 + 배경색 + 굵게 + 좌측정렬).
 *   - 이미 같은 문구면 no-op(멱등), 다른 내용이 이미 있으면 force 없이는 덮지 않음.
 *   - 열 수가 적은 탭은 실제 열 수에 맞춰 범위를 줄인다.
 * @returns {ok, applied?, alreadySet?, skipped?}
 */
async function applySheetNotice(spreadsheetId, { gid, tabName, text, force = false, dryRun = false } = {}) {
  if (!spreadsheetId) return { ok: false, error: 'spreadsheetId 필요' };
  const notice = String(text || (await getNoticeText())).trim();
  const v = validateNoticeText(notice);
  if (!v.ok) {
    logger.warn(`[sheet-notice] 위험 문구라 삽입 취소: reason=${v.reason} hits=${v.hits.join(',')}`);
    return { ok: false, skipped: 'unsafe_text', ...v };
  }

  const { getSpreadsheetMeta, readSheet, sheets } = require('./sheets.service');
  if (!sheets) return { ok: false, skipped: 'sheets_api_unavailable' };

  const meta = await getSpreadsheetMeta(spreadsheetId);
  const target = (meta || []).find(s => {
    if (gid != null && String(s.properties.sheetId) === String(gid)) return true;
    if (tabName && s.properties.title === tabName) return true;
    return false;
  });
  if (!target) return { ok: false, skipped: 'tab_not_found' };

  const sheetId = target.properties.sheetId;
  const title = target.properties.title;
  const colCount = (target.properties.gridProperties && target.properties.gridProperties.columnCount) || 26;
  const endCol = Math.min(NOTICE_END_COL, colCount);
  if (endCol - NOTICE_START_COL < 2) return { ok: false, skipped: 'too_narrow' };

  // 이미 내용이 있으면 덮지 않는다(사람이 써 둔 메모 보호). 같은 공지면 멱등 종료.
  let current = '';
  try {
    const safeTab = String(title).replace(/'/g, "''");
    const read = await throttledCall(() => readSheet(spreadsheetId, `'${safeTab}'!C1:R1`, { gid: String(sheetId) }));
    current = ((read && read[0]) || []).map(x => String(x == null ? '' : x).trim()).filter(Boolean)[0] || '';
  } catch (_) { /* 읽기 실패는 아래 force 판정으로 */ }
  if (current && current === notice) return { ok: true, alreadySet: true, tabName: title };
  if (current && !force) return { ok: false, skipped: 'occupied', current: current.slice(0, 60), tabName: title };

  if (dryRun) return { ok: true, dryRun: true, tabName: title, wouldWrite: notice };

  const range = { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: NOTICE_START_COL, endColumnIndex: endCol };

  // 병합은 이미 병합돼 있으면 실패할 수 있으므로 분리 + 무시(값·서식은 그대로 진행).
  try {
    await throttledCall(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ mergeCells: { range, mergeType: 'MERGE_ALL' } }] },
    }));
  } catch (mergeErr) {
    logger.info(`[sheet-notice] 병합 생략(무시): ${mergeErr.message}`);
  }

  await throttledCall(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateCells: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: NOTICE_START_COL, endColumnIndex: NOTICE_START_COL + 1 },
          rows: [{
            values: [{
              userEnteredValue: { stringValue: notice },
              userEnteredFormat: {
                backgroundColor: BG,
                textFormat: { bold: true, foregroundColor: FG, fontSize: 10 },
                horizontalAlignment: 'LEFT',
                verticalAlignment: 'MIDDLE',
                wrapStrategy: 'WRAP',
              },
            }],
          }],
          fields: 'userEnteredValue,userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
        },
      }],
    },
  }));

  logger.info(`[sheet-notice] 공지문 삽입: ${spreadsheetId} / "${title}" (C1:${String.fromCharCode(64 + endCol)}1)`);
  return { ok: true, applied: true, tabName: title };
}

/**
 * 신규 탭/시트 생성 직후 호출(best-effort) — 실패해도 생성 자체는 성공으로 둔다.
 *   env `SHEET_NOTICE_ON_CREATE=0` 이면 비활성.
 */
async function applyNoticeOnCreate(spreadsheetId, { gid, tabName } = {}) {
  if (process.env.SHEET_NOTICE_ON_CREATE === '0') return { ok: false, skipped: 'disabled' };
  try {
    return await applySheetNotice(spreadsheetId, { gid, tabName });
  } catch (err) {
    logger.warn(`[sheet-notice] 생성 시 삽입 실패(무시): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** 새 스프레드시트(템플릿 전체 복사)의 보이는 탭 전부에 삽입 — best-effort */
async function applyNoticeToAllTabs(spreadsheetId, { limit = 10 } = {}) {
  if (process.env.SHEET_NOTICE_ON_CREATE === '0') return { ok: false, skipped: 'disabled' };
  const results = [];
  try {
    const { getSpreadsheetMeta } = require('./sheets.service');
    const meta = await getSpreadsheetMeta(spreadsheetId);
    const tabs = (meta || []).filter(s => !(s.properties.hidden)).slice(0, limit);
    for (const t of tabs) {
      try {
        results.push({ tab: t.properties.title, ...(await applySheetNotice(spreadsheetId, { gid: String(t.properties.sheetId) })) });
      } catch (e) {
        results.push({ tab: t.properties.title, ok: false, error: e.message });
      }
    }
  } catch (err) {
    logger.warn(`[sheet-notice] 전체 탭 삽입 실패(무시): ${err.message}`);
    return { ok: false, error: err.message, results };
  }
  return { ok: true, results };
}

module.exports = {
  DEFAULT_NOTICE,
  validateNoticeText,
  getNoticeText,
  setNoticeText,
  applySheetNotice,
  applyNoticeOnCreate,
  applyNoticeToAllTabs,
  __setPoolForTest,
};
