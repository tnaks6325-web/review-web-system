/**
 * sheetlessLedger.service.js — 장부 생성기 (탈 구글시트 W1)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 이 서비스가 하는 일 = **시트가 하던 일을 대신한다**
 *
 *   종전:  구글시트 ──(5분마다 읽기)──▶ 장부 3권 ──▶ 화면 수십 곳
 *   이번:  시스템 작업표 ──(이 서비스)──▶ 장부 3권 ──▶ 화면 수십 곳 (무수정)
 *
 *   장부 3권 = ① raw_sheet_tabs/raw_sheet_rows(시트 사본 — 주문 행배정 재료)
 *              ② index_master(작업 등록부 — 작업 목록 노출 게이트)
 *              ③ review_index(검색용 명단 — 리뷰어 검색·리뷰내역·홈 통계·입금대상)
 *
 *   사용자 확정 D1-a(길 B): 장부를 없애지 않고 **채우는 손만** 바꾼다 →
 *   검색 소유권 게이트·행배정 원자성 등 검증된 코드가 그대로 살아 있다(재작성 0).
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ★★ 판정 사본 0 — 2차원 배열(시트가 읽혔다면 나왔을 그 모양)을 만들어
 *   **기존 파서 `indexBuilder.parseTabRows` 에 그대로 통과**시킨다. 이름열 우선순위·제출/입금 판정·
 *   phone8 추출·submit_col 감지가 시트 경로와 한 글자도 다르지 않다(사본을 두면 조용히 갈라진다).
 *
 * ★★ 두 장부의 행 수가 다른 것은 **의도**다:
 *   · raw_sheet_rows = **빈 슬롯 포함 전 행**(주문이 들어갈 자리를 알아야 배정이 된다)
 *   · review_index   = **이름 있는 행만**(파서가 이름 없는 행을 버린다 — 검색 결과에 빈 줄이 뜨면 안 된다)
 *
 * ★ fail-closed: `tab_configs.sheetless = TRUE` 인 탭에서만 동작한다.
 *   시트 기반 탭에 잘못 돌리면 **시트에서 만든 장부를 작업표 값으로 덮어써** 데이터가 뒤집힌다.
 */

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { computeChecksum } = require('../utils/checksum');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 헤더 없이 만들 수 없다 — 열 이름이 곧 파서의 판정 재료다 */
class LedgerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * 헤더 결정 — 한 번 정해지면 유지한다(재생성마다 열 순서가 흔들리면 행 배정·표시가 어긋난다).
 * 우선순위: ① 이미 저장된 장부 헤더(이관 작업·재생성) → ② 호출자가 준 열 구성(작업표 생성 시)
 *          → ③ 작업표 행의 키(마지막 폴백 — 순서 불안정이라 경고)
 * ★ JSONB 키 순서는 입력 순서가 아니라 PG 내부 정렬이므로 ③은 최후 수단이다.
 */
function resolveHeaders({ storedHeaders, columns, rows }) {
  const clean = (a) => (Array.isArray(a) ? a.map(h => String(h == null ? '' : h)).filter(h => h.trim()) : []);
  const stored = clean(storedHeaders);
  if (stored.length) return { headers: stored, source: 'stored' };
  const given = clean(columns);
  if (given.length) return { headers: given, source: 'columns' };
  const seen = [];
  for (const r of (rows || [])) {
    const rj = r && r.row_json;
    if (rj && typeof rj === 'object') for (const k of Object.keys(rj)) if (k && seen.indexOf(k) < 0) seen.push(k);
  }
  if (seen.length) return { headers: seen, source: 'row_json' };
  return { headers: [], source: 'none' };
}

/**
 * 작업표 행 → 시트가 읽혔다면 나왔을 2차원 배열.
 * @returns {{ values: string[][], headerRow: number, rowIndexOf: Map<number,number> }}
 *   headerRow = 1-based 헤더 행 번호. 데이터는 각 행의 `seq`(= 시트 실제 행번호) 자리에 놓는다.
 * ★ seq 자리를 지키는 이유: 주문 배정·투영·claim 이 전부 이 번호를 키로 쓴다(어긋나면 표가 두 겹).
 */
function buildValues({ headers, rows }) {
  const seqs = (rows || []).map(r => Number(r.seq)).filter(n => Number.isFinite(n) && n > 0);
  const minSeq = seqs.length ? Math.min(...seqs) : 2;
  const maxSeq = seqs.length ? Math.max(...seqs) : 1;
  const headerRow = Math.max(1, minSeq - 1);     // 헤더는 첫 데이터 바로 위
  const values = [];
  for (let i = 0; i < Math.max(headerRow, maxSeq); i++) values.push([]);
  values[headerRow - 1] = headers.slice();
  const byRow = new Map();
  for (const r of (rows || [])) {
    const seq = Number(r.seq);
    if (!Number.isFinite(seq) || seq < 1 || seq === headerRow) continue;
    const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
    values[seq - 1] = headers.map(h => {
      const v = rj[h];
      return v === undefined || v === null ? '' : String(v);
    });
    byRow.set(seq, seq);
  }
  return { values, headerRow, rowIndexOf: byRow };
}

/**
 * 장부 3권 생성/갱신 — 무시트 탭 전용.
 *
 * @param {object} o
 * @param {string} o.sheetId · o.tabName            대상 탭
 * @param {string[]} [o.columns]                    열 구성(작업표 생성 시 전달 — 첫 생성에 사용)
 * @param {boolean} [o.dryRun=false]                미리보기(쓰기 0)
 * @param {string}  [o.by='system']
 * @returns {Promise<object>} 요약
 */
/**
 * @param {boolean} preflight  이관 **전** 점검용(전환 관리 화면 ⑤ 항목). `dryRun` 과 **함께일 때만** 유효하며
 *   시트 기반 탭에서도 "열 구성을 알아볼 수 있는가"를 계산해 본다. 쓰기 경로는 그대로 잠겨 있다
 *   — 게이트가 막으려는 것은 **시트 값 덮어쓰기**인데 dry-run 은 한 줄도 쓰지 않기 때문.
 *   ★ preflight 만 주고 dryRun 을 빼면 종전대로 `not_sheetless` 로 거부한다(완화 금지).
 */
async function rebuildLedgers({ sheetId, tabName, columns = null, dryRun = false, by = 'system', preflight = false } = {}) {
  if (!sheetId || !tabName) throw new LedgerError('bad_request', 'sheetId, tabName 필수');
  const db = getPool();

  // ── 게이트: 무시트 탭에서만 (fail-closed) ──
  const { rows: tcRows } = await db.query(
    `SELECT tab_gid, campaign_name, COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tcRows.length) throw new LedgerError('tab_not_registered', '등록되지 않은 탭입니다(접수 후 이용).');
  if (!tcRows[0].sheetless && !(dryRun && preflight)) {
    throw new LedgerError('not_sheetless',
      '시트 기반 탭입니다 — 장부는 시트에서 만들어집니다. 이 탭을 무시트로 이관한 뒤 실행하세요.');
  }
  const tabGid = String(tcRows[0].tab_gid || '');
  const campaignName = tcRows[0].campaign_name || '';

  // ── 작업표(진실원본) ──
  const { rows: parts } = await db.query(
    `SELECT seq, row_json FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
      ORDER BY seq`, [sheetId, tabName]);

  // ── 헤더 ──
  const { rows: prevTab } = await db.query(
    `SELECT headers FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1`, [sheetId, tabGid]);
  const { headers, source: headerSource } = resolveHeaders({
    storedHeaders: prevTab[0] && prevTab[0].headers, columns, rows: parts,
  });
  if (!headers.length) {
    throw new LedgerError('no_headers',
      '열 구성을 알 수 없습니다 — 작업표를 먼저 만들거나 열 목록을 함께 보내주세요.');
  }

  const { values, headerRow } = buildValues({ headers, rows: parts });

  // ── 검색 명단(review_index) 재료 = **시트 경로와 같은 파서** ──
  //   ★ 사본 금지: 이름열 우선순위·제출/입금 판정·phone8 추출·submit_col 감지가 여기서 갈리면
  //     "시트 작업은 검색되는데 무시트 작업만 안 되는" 상태가 조용히 생긴다.
  const _ib = require('./indexBuilder.service');
  // ★ 키워드·컬럼매핑도 시트 경로와 같은 것을 쓴다 — 기본 상수로만 파싱하면 관리자가 커스터마이즈한
  //   키워드가 무시트 작업에만 적용되지 않아 감지가 조용히 갈린다(fail-soft: 로드 실패는 기본값).
  try { await _ib.loadKeywordsFromDB(); } catch (_) {}
  let dbColMap = null;
  try { dbColMap = await require('./columnMapping.service').getTabColumnIndexMap(sheetId, tabGid); } catch (_) {}
  const parsed = _ib.parseTabRows(values, sheetId, tabName, tabGid, campaignName, dbColMap) || [];

  const submittedCount = parsed.filter(r => r.isSubmitted).length;
  const checksum = computeChecksum(JSON.stringify({ headers, n: parts.length, s: submittedCount }));

  if (dryRun) {
    return {
      dryRun: true, sheetId, tabName, tabGid, headerSource,
      headers, headerRow, mirrorRows: parts.length, indexRows: parsed.length, submittedCount,
      note: 'raw 미러는 빈 슬롯 포함 전 행 · 검색 명단은 이름 있는 행만(파서 규칙 그대로)',
    };
  }

  const client = await db.connect();
  let mirrorRows = 0;
  let filesKept = 0;          // 보존한 대표 리뷰 이미지 수(조용한 소실 감지용)
  let filesSeen = 0;          // 보존 대상이었던 행 수 — seen>kept 면 그만큼 행이 사라진 것
  try {
    await client.query('BEGIN');

    /* ★★ 탭 단위 직렬화 — 주문이 몰리면 같은 탭의 장부 재생성이 동시에 돌 수 있는데,
       이 함수는 `review_index` 를 **지우고 다시 넣는다**. 겹치면 한쪽이 지운 사이의 순간에
       다른 쪽이 읽어 **검색 명단이 잠깐 비는** 창이 생긴다(리뷰어에겐 "내 참여가 사라짐").
       트랜잭션 스코프 락이라 COMMIT/ROLLBACK 에 자동 해제된다(누수 불가). */
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sheetless_ledger:${sheetId}:${tabName}`]);

    // ① 시트 사본(raw) — 행배정(claimRow)이 읽는 재료. 빈 슬롯도 그대로 실어야 배정할 자리가 생긴다.
    await client.query(
      `INSERT INTO raw_sheet_tabs
         (sheet_id, sheet_url, spreadsheet_title, tab_gid, tab_name, row_count, col_count,
          headers, detected_headers, is_system_tab, is_hidden, checksum, mirrored_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7::jsonb, $7::jsonb, FALSE, FALSE, $8, NOW())
       ON CONFLICT (sheet_id, tab_gid) DO UPDATE SET
         spreadsheet_title = EXCLUDED.spreadsheet_title, tab_name = EXCLUDED.tab_name,
         row_count = EXCLUDED.row_count, col_count = EXCLUDED.col_count,
         headers = EXCLUDED.headers, detected_headers = EXCLUDED.detected_headers,
         checksum = EXCLUDED.checksum, mirrored_at = NOW()`,
      [sheetId, campaignName, tabGid, tabName, parts.length, headers.length,
       JSON.stringify(headers), checksum]);

    await client.query('DELETE FROM raw_sheet_rows WHERE sheet_id = $1 AND tab_gid = $2', [sheetId, tabGid]);
    for (let i = 0; i < values.length; i++) {
      const cells = values[i];
      if (!cells || !cells.length) continue;            // 빈 줄은 넣지 않는다(시트 미러와 같은 성질)
      await client.query(
        `INSERT INTO raw_sheet_rows (sheet_id, tab_gid, tab_name, row_index, cells, mirrored_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
         ON CONFLICT (sheet_id, tab_gid, row_index) DO UPDATE SET
           cells = EXCLUDED.cells, tab_name = EXCLUDED.tab_name, mirrored_at = NOW()`,
        [sheetId, tabGid, tabName, i + 1, JSON.stringify(cells)]);
      mirrorRows++;
    }

    /* ★★ ②-0 시스템 전용 값 스냅샷 — **시트에 칸이 없어 작업표에서 되만들 수 없는 값**.
       `review_index` 를 지우고 다시 넣으므로, 파서가 만들지 않는 컬럼은 여기서 보존하지 않으면
       **주문 한 건만 더 들어와도 통째로 증발**한다(대표 리뷰 이미지 = 리뷰어 "제출완료" 카드 썸네일·
       제출일, 업체 뷰어 미리보기, 리뷰 캡처 백필 결과가 전부 사라진다).
       ★ 제출·입금 표시(is_submitted/is_submitted2)는 **여기서 보존하지 않는다** — 시트에도 칸이 있는
         값이라 작업표 칸이 진실원본이어야 한다(보존하면 작업표에서 지워도 장부만 남아 갈라진다).
         그 값들을 켜는 경로는 `sheetlessStatus.service` 가 작업표 칸에 기록한다.
       ★ 앵커는 row_index 하나뿐(= 작업표 seq = 시트 실제 행 번호). */
    const { rows: keepRows } = await client.query(
      `SELECT row_index, review_file_id, review_file_url, review_file_name,
              review_file_count, review_file_at
         FROM review_index
        WHERE sheet_id = $1 AND tab_name = $2
          AND row_index IS NOT NULL AND review_file_id IS NOT NULL`,
      [sheetId, tabName]);

    filesSeen = keepRows.length;

    // ② 검색 명단(review_index) — 그 탭만 갈아끼운다(시트 빌더와 같은 방식)
    await client.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]);
    for (const r of parsed) {
      await client.query(
        `INSERT INTO review_index
           (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name, row_index,
            is_submitted, is_submitted2, product_url, product_name, submit_col, submit_col2,
            row_json, start_date, end_date, round, phone8, built_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,NOW())`,
        [r.name, sheetId, tabGid || null, tabName, campaignName, r.rowIndex,
         !!r.isSubmitted, r.isSubmitted2 || 'NONE', r.productUrl || null, r.productName || null,
         r.submitCol || null, r.submitCol2 || null, JSON.stringify(r.rowJson || {}),
         r.startDate || null, r.endDate || null, r.round || null, r.phone8 || null]);
    }

    /* ②-1 스냅샷 복원 — 파서가 만들지 않는 컬럼이라 덮어쓸 값이 없다(충돌 없는 순수 복원).
       ★ 재생성 결과에 없는 행(작업표에서 사라진 줄)은 WHERE 가 0행이라 자동으로 버려진다. */
    for (const k of keepRows) {
      const r = await client.query(
        `UPDATE review_index
            SET review_file_id = $3, review_file_url = $4, review_file_name = $5,
                review_file_count = $6, review_file_at = $7
          WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $8`,
        [sheetId, tabName, k.review_file_id, k.review_file_url, k.review_file_name,
         k.review_file_count, k.review_file_at, k.row_index]);
      filesKept += r.rowCount;
    }

    // ③ 작업 등록부(index_master) — 작업 목록 노출 게이트. 없으면 접수해도 어디에도 안 뜬다.
    await client.query(
      `INSERT INTO index_master
         (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count,
          checksum, built_at, status, skip_reason, error_msg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),'active',NULL,NULL)
       ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
         tab_gid = EXCLUDED.tab_gid, campaign_name = EXCLUDED.campaign_name,
         row_count = EXCLUDED.row_count, submitted_count = EXCLUDED.submitted_count,
         checksum = EXCLUDED.checksum, built_at = NOW(),
         status = 'active', skip_reason = NULL, error_msg = NULL`,
      [sheetId, tabName, tabGid || null, campaignName, parsed.length, submittedCount, checksum]);

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  logger.info(`[sheetlessLedger] 장부 생성 tab=${tabName} 미러 ${mirrorRows}행 · 명단 ${parsed.length}행 · 헤더출처=${headerSource} by=${by}`);
  return {
    ok: true, sheetId, tabName, tabGid, headerSource,
    headers, headerRow, mirrorRows, indexRows: parsed.length, submittedCount,
    filesKept, filesSeen,
  };
}

module.exports = {
  rebuildLedgers,
  resolveHeaders,
  buildValues,
  LedgerError,
  __setPoolForTest,
};
