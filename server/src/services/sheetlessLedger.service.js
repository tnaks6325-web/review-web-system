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
const { tableOrderNumSql } = require('../utils/tableOrderNum');
const { computeChecksum } = require('../utils/checksum');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

// Railway↔Postgres 왕복 지연이 있는 환경에서 행마다 INSERT 하면 800행 접수 시
// 트랜잭션이 수십 초 이상 걸릴 수 있다. 한 쿼리의 파라미터 수도 안전하게 유지하면서
// 왕복 횟수만 줄이기 위한 단위다(3,200 params/800행 대신 최대 800 params/배치).
const RAW_MIRROR_BATCH_SIZE = 200;

/**
 * raw_sheet_rows 미러를 묶어서 쓴다.
 * `DELETE → INSERT` 순서는 기존과 같고, 빈 줄을 건너뛰는 규칙도 보존한다.
 */
async function writeRawMirrorRows(client, { sheetId, tabGid, tabName, values }) {
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const cells = values[i];
    if (cells && cells.length) rows.push({ rowIndex: i + 1, cells });
  }

  for (let start = 0; start < rows.length; start += RAW_MIRROR_BATCH_SIZE) {
    const batch = rows.slice(start, start + RAW_MIRROR_BATCH_SIZE);
    const params = [sheetId, tabGid, tabName];
    const tuples = batch.map((row, index) => {
      const offset = 4 + index * 2;
      params.push(row.rowIndex, JSON.stringify(row.cells));
      return `($1,$2,$3,$${offset},$${offset + 1}::jsonb,NOW())`;
    });
    await client.query(
      `INSERT INTO raw_sheet_rows (sheet_id, tab_gid, tab_name, row_index, cells, mirrored_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (sheet_id, tab_gid, row_index) DO UPDATE SET
         cells = EXCLUDED.cells, tab_name = EXCLUDED.tab_name, mirrored_at = NOW()`,
      params);
  }
  return rows.length;
}

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
  /* ★★ 900000 대역(수동 격리 대역 — "시트 행을 모를 때"용, participants.MANUAL_SEQ_BASE)은
     시트 모양 배열에 넣지 않는다: seq 자리가 곧 배열 크기라 줄 하나에 90만 칸을 할당하고,
     그 자리는 어떤 시트 행 번호와도 대응하지 않는다(2026-08-21 실측 결함 방어).
     ★ 조용한 누락 금지 — 뺀 줄 수(manualBandSkipped)와 그중 값이 있는 줄 수
       (manualBandWithData)를 반환값으로 알린다(호출부가 warn 으로 드러낸다). */
  const MANUAL_BAND = require('./participants.service').MANUAL_SEQ_BASE;
  const all = (rows || []).filter(r => Number.isFinite(Number(r.seq)) && Number(r.seq) > 0);
  const band = all.filter(r => Number(r.seq) >= MANUAL_BAND);
  const kept = all.filter(r => Number(r.seq) < MANUAL_BAND);
  const manualBandWithData = band.filter(r => {
    const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
    return Object.values(rj).some(v => String(v == null ? '' : v).trim() !== '');
  }).length;
  const seqs = kept.map(r => Number(r.seq));
  const minSeq = seqs.length ? Math.min(...seqs) : 2;
  const maxSeq = seqs.length ? Math.max(...seqs) : 1;
  const headerRow = Math.max(1, minSeq - 1);     // 헤더는 첫 데이터 바로 위
  const values = [];
  for (let i = 0; i < Math.max(headerRow, maxSeq); i++) values.push([]);
  values[headerRow - 1] = headers.slice();
  const byRow = new Map();
  for (const r of kept) {
    const seq = Number(r.seq);
    if (!Number.isFinite(seq) || seq < 1 || seq === headerRow) continue;
    const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
    values[seq - 1] = headers.map(h => {
      const v = rj[h];
      return v === undefined || v === null ? '' : String(v);
    });
    byRow.set(seq, seq);
  }
  return { values, headerRow, rowIndexOf: byRow,
           manualBandSkipped: band.length, manualBandWithData };
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
    `SELECT tab_gid, campaign_name, COALESCE(sheetless, FALSE) AS sheetless,
            closed_rounds, archived_rounds
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tcRows.length) throw new LedgerError('tab_not_registered', '등록되지 않은 탭입니다(접수 후 이용).');
  if (!tcRows[0].sheetless && !(dryRun && preflight)) {
    throw new LedgerError('not_sheetless',
      '시트 기반 탭입니다 — 장부는 시트에서 만들어집니다. 이 탭을 무시트로 이관한 뒤 실행하세요.');
  }
  const tabGid = String(tcRows[0].tab_gid || '');
  const campaignName = tcRows[0].campaign_name || '';

  /* ★★ 차수 마감·아카이브 — **시트 경로와 같은 함수**(`closedRounds.service`)를 쓴다.
     종전에는 이 경로가 두 칸(`closed_rounds`/`archived_rounds`)을 한 번도 읽지 않아,
     무시트 작업에서 차수를 아카이브해도 **다음 재생성이 그대로 되살렸다**(조용한 no-op).
     `archive.routes` 에 무시트 제외 필터가 없어 화면에서는 성공했다고 나오던 상태다.
     ★ 조회 실패는 "제외 없음"으로 접는다 — 못 읽었다고 명단에서 사람을 빼지 않는다. */
  const _closedRounds = require('./closedRounds.service');
  const excludeRounds = _closedRounds.excludedRounds(tcRows[0]);

  // #0 같은 수동 이체 원장은 작업표를 재구성해도 잃으면 안 된다. 행 번호가 아니라
  // 리뷰어/주문 앵커로 다시 찾아 입금칸을 보강한 뒤, 그 값을 이번 장부 재료로 읽는다.
  if (!dryRun && tcRows[0].sheetless) {
    await require('./manualPaymentLedger.service').rehydrateManualPaymentMarks(db, { sheetId, tabName, by });
  }

  // ── 작업표(진실원본) ──
  const { rows: parts } = await db.query(
    `SELECT seq, row_json FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
      ORDER BY seq`, [sheetId, tabName]);

  // ── 헤더 ──
  /* ★★ `detected_headers` 를 먼저 본다(2026-08 실측 사고): 시트 미러가 `headers` 에 넣는 값은
     **시트 A1 행 그대로**(대개 캠페인 정보 1~2칸)이고 진짜 열 이름 줄은 `detected_headers` 에 있다.
     무시트 탭은 이 함수가 둘 다 같은 값으로 써 넣으므로 **동작이 한 글자도 안 바뀌고**,
     시트 기반 탭을 preflight 로 볼 때만 달라진다 — 종전엔 A1 2칸이 잡혀
     "열 2개 · 검색 명단 0명"인데 점검이 통과하는 false-green 이었다. */
  const { rows: prevTab } = await db.query(
    `SELECT detected_headers, headers FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1`,
    [sheetId, tabGid]);
  const { headers, source: headerSource } = resolveHeaders({
    storedHeaders: prevTab[0] && (prevTab[0].detected_headers || prevTab[0].headers), columns, rows: parts,
  });
  if (!headers.length) {
    throw new LedgerError('no_headers',
      '열 구성을 알 수 없습니다 — 작업표를 먼저 만들거나 열 목록을 함께 보내주세요.');
  }

  const { values, headerRow, manualBandSkipped, manualBandWithData } = buildValues({ headers, rows: parts });
  if (manualBandWithData) {
    // 900000 대역에 값이 든 줄 = 옛 [＋ 줄 추가] 결함의 잔재 — 장부에 실리지 않으니 사람이 옮겨야 한다.
    logger.warn(`[sheetlessLedger] 900000 대역에 값이 있는 줄 ${manualBandWithData}건 제외 tab=${tabName} — 실제 행으로 옮기지 않으면 검색·입금대상에 실리지 않습니다`);
  }

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

  /* ★★ 명단에 실제로 들어가는 줄 = 마감·아카이브 차수를 뺀 것.
     집계도 **같은 목록**에서 센다 — `parsed.length` 를 그대로 보고하면 화면이
     "명단 216명"이라 말하고 실제로는 50명만 들어가는 조용한 불일치가 된다. */
  const indexed = _closedRounds.filterRows(parsed, excludeRounds);
  const excludedCount = parsed.length - indexed.length;
  const submittedCount = indexed.filter(r => r.isSubmitted).length;
  const checksum = computeChecksum(JSON.stringify({ headers, n: parts.length, s: submittedCount }));

  if (dryRun) {
    return {
      dryRun: true, sheetId, tabName, tabGid, headerSource,
      headers, headerRow, mirrorRows: parts.length, indexRows: indexed.length, submittedCount,
      excludedRounds: excludeRounds, excludedRows: excludedCount,
      note: 'raw 미러는 빈 슬롯 포함 전 행 · 검색 명단은 이름 있는 행만(파서 규칙 그대로)'
        + (excludedCount ? ` · 마감 차수 ${excludeRounds.join(',')} ${excludedCount}행 제외` : ''),
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
    mirrorRows = await writeRawMirrorRows(client, { sheetId, tabGid, tabName, values });

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

    /* ★★ 마감·아카이브된 차수는 **지우기 전에** `review_index_archive` 로 옮긴다.
       순서가 계약이다 — 아래 DELETE 가 먼저 돌면 옮길 행이 남지 않아 기록이 증발한다.
       같은 트랜잭션(`client`)에서 돌려 부분 성공을 남기지 않는다. */
    if (excludeRounds.length) {
      await _closedRounds.archiveExcludedRounds({
        sheetId, tabName, exclude: excludeRounds, db: client, by: `rebuildLedgers:${by}` });
    }

    // ② 검색 명단(review_index) — 그 탭만 갈아끼운다(시트 빌더와 같은 방식)
    await client.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]);
    /* ★ 제외 차수 행은 다시 넣지 않는다 — 이걸 빼면 위에서 옮겨 둔 행이 곧바로 되살아난다. */
    for (const r of indexed) {
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

  logger.info(`[sheetlessLedger] 장부 생성 tab=${tabName} 미러 ${mirrorRows}행 · 명단 ${indexed.length}행`
    + (excludedCount ? ` (마감 차수 ${excludeRounds.join(',')} ${excludedCount}행 제외)` : '')
    + ` · 헤더출처=${headerSource} by=${by}`);
  return {
    ok: true, sheetId, tabName, tabGid, headerSource,
    headers, headerRow, mirrorRows, indexRows: indexed.length, submittedCount,
    excludedRounds: excludeRounds, excludedRows: excludedCount,
    filesKept, filesSeen,
  };
}

/* ── 무시트 탭 게이트 (사본 0) ────────────────────────────────────────────────
   왜 한 곳인가: 줄 정리·중복 정리·수동 정리 셋이 같은 전제("시트 기반 탭에 쓰면 다음 시트 반영이
   되살린다")를 갖는데 각자 조건을 적으면 한쪽만 조용히 느슨해진다. */
async function _assertSheetlessTab(db, sheetId, tabName, hint) {
  const { rows } = await db.query(
    `SELECT COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!rows.length) throw new LedgerError('tab_not_registered', '등록되지 않은 탭입니다.');
  if (!rows[0].sheetless) throw new LedgerError('not_sheetless', hint);
}

/**
 * 무시트 탭 줄 정리(은퇴) — 작업표에서 고른 줄을 내리고 장부를 다시 만든다.
 *
 * 왜 필요한가(운영 실측 2026-08-07 · 쿠팡(26년)): 이관 전 검색 명단은 5·6차 50명뿐이었는데
 * 이관 후 216명이 됐다. 시트 시절 투영이 `active = FALSE` 로 내려 둔 옛 차수 166줄을
 * 장부 재생성이 그대로 되살렸기 때문이다. 그 줄들을 다시 내릴 창구가 어디에도 없었다.
 *
 * ★★ 순서가 계약: **작업표 soft-delete → 장부 재생성**. 반대로 하면 10분 투영
 *    (`importTabFromIndex`)의 `deleted_at = NULL` 이 되살린다 — 그 upsert 는 **장부에 있는 줄만**
 *    건드리므로, 장부에서 먼저 빼 두면 그 뒤로는 영원히 안전하다.
 * ★ 무시트 탭만 — 시트 기반 탭은 시트가 진실원본이라 표에서만 내려도 다음 빌드가 되살린다
 *   (되지도 않는 일을 한 것처럼 보이면 안 되므로 사유를 말하고 거부한다).
 * ★ dryRun 기본 — 값이 빠진 요청이 곧바로 실행되지 않는다.
 * ★ 대상은 **서버가 조건으로 다시 고른다**(화면이 보낸 행 목록 불신 — 작업표 탭 삭제와 같은 규율).
 * ★ 하드삭제 아님(`deleted_at`) — 되돌릴 수 있고, 주문 원장·Drive 는 건드리지 않는다.
 */
async function retireRows({ sheetId, tabName, rounds = [], seqs = [], dryRun = true, by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new LedgerError('bad_request', 'sheetId, tabName 필수');
  const db = getPool();

  await _assertSheetlessTab(db, sheetId, tabName,
    '시트 기반 탭입니다 — 표에서만 내려도 다음 시트 반영이 되살립니다. 시트에서 정리하거나 이관 후 이용하세요.');

  /* ★ 작업표 쓰기는 `participants.service` 가 소유한다(쓰기 소유자 규율) — 여기는 게이트·순서·장부만. */
  const r = await require('./participants.service')
    .retireRows({ sheetId, tabName, rounds, seqs, dryRun, by });
  if (r.reason === 'empty') throw new LedgerError('empty', '정리할 대상을 고르지 않았습니다.');
  if (dryRun) return { ...r, sheetId, tabName };
  if (!r.retired) return { ...r, sheetId, tabName, indexRows: null };

  /* ★ 장부 재생성이 실패하면 조용히 끝내지 않는다 — 표에서만 내려간 상태로 남으면
     다음 투영이 되살릴 수 있으므로 사유를 응답에 실어 화면이 재실행을 안내한다. */
  let ledger = null, ledgerError = null;
  try {
    ledger = await rebuildLedgers({ sheetId, tabName, by: `retire:${by}` });
  } catch (e) {
    ledgerError = (e && (e.code || e.message)) || 'rebuild_failed';
    logger.warn(`[sheetlessLedger] 정리 후 장부 재생성 실패 tab=${tabName} — ${ledgerError}`);
  }
  logger.info(`[sheetlessLedger] 줄 정리 tab=${tabName} ${r.retired}줄 은퇴 · 명단 ${ledger ? ledger.indexRows : '?'}명 by=${by}`);
  return { ...r, sheetId, tabName, indexRows: ledger ? ledger.indexRows : null, ledgerError };
}

/**
 * ★★ 작업보드 중복 줄 정리 (2026-08-19 사고 수습) — 예방(중복 차단)의 짝.
 *
 * 무엇을 중복으로 보나: 같은 탭 안에서 **주문번호(숫자만) + 연락처(숫자만)** 가 같은 줄들.
 *   기록 단계 중복 차단과 **같은 키**를 쓴다(판정이 갈리면 "화면은 중복인데 정리는 안 되는" 상태가 된다).
 *
 * ★★ 남기는 줄 = 가장 이른 seq. 다만 **다음 그룹은 손대지 않고 보고만 한다**(사람이 판단):
 *   ㉮ 지울 줄이 **입금 회차에 담겨 있다**(`payment_batch_items` pending/paid) — `uq_payment_items_active`
 *      가 `(sheet_id,tab_name,row_index)` 기준이라 중복 줄이 각각 별개 이체 건으로 잡힌다.
 *      여기서 조용히 지우면 **이미 나간 이체의 근거가 사라진다**.
 *   ㉯ 지울 줄에 **리뷰제출·입금 표시가 있는데 남길 줄에는 없다** — 실제로 쓰인 줄이 뒤에 있다는 뜻.
 * ★ dryRun 기본. 대상은 **서버가 조건으로 다시 고른다**(화면이 보낸 목록 불신).
 * ★ 하드삭제 없음 — 줄은 `deleted_at`, 중복 주문은 `mirror_status='canceled'` 소프트 처리.
 */
async function dedupeRows({ sheetId, tabName, dryRun = true, by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new LedgerError('bad_request', 'sheetId, tabName 필수');
  const db = getPool();

  await _assertSheetlessTab(db, sheetId, tabName,
    '시트 기반 탭입니다 — 표에서만 내려도 다음 시트 반영이 되살립니다. 시트에서 정리하세요.');

  const { rows } = await db.query(
    `SELECT cp.seq, cp.order_submission_id AS osid, cp.reviewer_name AS name,
            COALESCE(cp.is_submitted, FALSE) AS submitted, COALESCE(cp.is_paid, FALSE) AS paid,
            regexp_replace(COALESCE(os.order_num, ''), '\\D', '', 'g') AS ordnum,
            regexp_replace(COALESCE(os.phone, ''), '\\D', '', 'g') AS ph,
            os.submitted_at AS at,
            /* ★★ 작업보드 표에 **실제로 보이는** 주문번호. 원장(os.order_num)만 보면
               "화면에는 서로 다른 주문번호인데 중복으로 잡히는" 일이 생긴다(2026-08-19 신다인 건).
               담당자가 눈으로 판단하는 값과 시스템 판정이 같은 값을 봐야 한다. */
            ${tableOrderNumSql('cp')} AS roword,
            EXISTS (SELECT 1 FROM payment_batch_items pi
                     WHERE pi.sheet_id = cp.sheet_id AND pi.tab_name = cp.tab_name
                       AND pi.row_index = cp.seq AND pi.status IN ('pending','paid')) AS in_payment
       FROM campaign_participants cp
       JOIN order_submissions os ON os.id = cp.order_submission_id
      WHERE cp.sheet_id = $1 AND cp.tab_name = $2 AND cp.deleted_at IS NULL AND os.deleted_at IS NULL
      ORDER BY cp.seq`, [sheetId, tabName]);

  /* ★★ 판정 축 2개 (사용자 확정 2026-08-19) ────────────────────────────────────────
     ㉮ **표 주문번호 + 원장 주문번호 + 연락처 셋 다 일치** — 재제출로 *주문이 새로 생긴* 중복(종전 규칙 그대로).
        ★ 표에 주문번호가 없거나 6자리 미만인 줄은 판정 불가 → 제외한다(모르면 안 지운다).
        ★ 원장 주문번호가 6자리 미만인 줄도 이 축의 대상이 아니다(종전 WHERE 필터와 같은 의미).
     ㉯ **같은 주문 기록(`order_submission_id`)을 여러 줄이 씀** — *한 주문이 여러 줄에 기록된* 중복.
        왜 필요한가(실측 2026-08-19 위드프렌즈): 한 주문이 **7줄**에 기록됐는데 뒤쪽 줄들의
        **표 주문번호가 서로 달라** ㉮ 로는 영원히 안 잡혔고, 그 원장의 주문번호가 비어 있어
        (비번호 주문) **조회 대상에서조차 빠졌다**. 시스템이 스스로 "한 주문"이라고 말하는 값이라
        근거가 가장 강하다("주문 1건 = 줄 1개" 를 강제하는 제약이 어디에도 없다는 그 구멍의 수습).
     ★★ 두 축이 겹치는 줄이 있으면 **한 덩어리로 합쳐 결정을 한 번만** 내린다(같은 줄을 두 번 지우지
        않고, 남길 줄도 하나만 정해진다). 겹치지 않으면 결과는 종전과 완전히 같다(무회귀). */
  const parent = rows.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const noRowOrder = [];
  const byKeys = new Map();     // ㉮
  const byOrder = new Map();    // ㉯
  rows.forEach((r, i) => {
    if (r.osid) {
      /* ★★ 같은 주문 기록을 공유해도 **표 주문번호가 서로 다르면 묶지 않는다**
         (2026-08-19 실사고 · 사용자 확정). 링크(`order_submission_id`)는 투영이 채우는 값이라
         한 리뷰어의 여러 참여가 **한 주문**을 가리키도록 오염될 수 있다(장수산업 실측: 8/19 줄이
         8/4 주문 링크를 들고 있었다). 그 상태에서 이 축만 믿으면 **별개 참여가 중복으로 지워진다**.
         담당자가 표에서 눈으로 보는 값(주문번호)이 다르면 그건 다른 구매다 — 링크보다 그 값을 믿는다.
         ★★ **표 주문번호가 6자리 미만(비번호 주문·빈 칸)이면 이 축에서 아예 제외한다**
           (2026-08-19 2차 확정 — 종전에는 빈 값끼리 묶었다). 링크는 투영이 **연락처만으로 추측해
           채우는** 값이라, 표에 주문번호가 없는 줄들은 *같은 사람의 서로 다른 참여*가 한 주문에
           함께 매달리기 쉽다(실측: 진행 중 무시트 작업에서 그런 줄이 82줄). 그 상태에서 이 축으로
           묶으면 **별개 참여가 중복으로 지워진다**. 판정 근거가 없으면 판정하지 않는다.
           ★ 그래서 이 갈래는 사람이 [♻ 중복 줄 정리]·[🧹 줄 정리]로 직접 고른다(자동 판정 금지).
           ★ 표 주문번호가 있는 줄끼리는 종전 그대로 묶인다(무회귀). */
      const _rw = String(r.roword || '');
      if (_rw.length >= 6) {
        const k = 'os:' + String(r.osid) + '\u0000' + _rw;
        if (!byOrder.has(k)) byOrder.set(k, []);
        byOrder.get(k).push(i);
      }
    }
    if (String(r.ordnum || '').length < 6) return;
    if (String(r.roword || '').length < 6) { noRowOrder.push(r); return; }
    const k = `${r.roword}\u0000${r.ordnum}\u0000${r.ph}`;
    if (!byKeys.has(k)) byKeys.set(k, []);
    byKeys.get(k).push(i);
  });
  for (const list of byKeys.values()) for (let j = 1; j < list.length; j++) union(list[0], list[j]);
  for (const list of byOrder.values()) for (let j = 1; j < list.length; j++) union(list[0], list[j]);
  // 어느 규칙으로 묶였는지 — 화면이 "왜 이 줄들이 한 묶음인지" 를 말할 수 있어야 한다.
  const axisOf = new Map();
  const tagAxis = (map, name) => {
    for (const list of map.values()) {
      if (list.length < 2) continue;
      const root = find(list[0]);
      if (!axisOf.has(root)) axisOf.set(root, new Set());
      axisOf.get(root).add(name);
    }
  };
  tagAxis(byKeys, 'keys'); tagAxis(byOrder, 'order');

  const groups = new Map();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { root, rows: [] });
    groups.get(root).rows.push(r);
  });

  const removeSeqs = [];
  const removeOsIds = [];
  const plan = [];
  const skipped = [];
  /* ★★ 남길 줄이 쓰는 주문은 **절대 취소하지 않는다** — ㉯ 축의 지울 줄들은 남길 줄과
     **같은 주문 기록**을 공유하므로, 그대로 취소하면 살아남은 줄의 주문까지 함께 사라진다. */
  const keepOsIds = new Set();
  let sameOrderGroups = 0;   // 발생 시각을 알 수 없는 그룹(㉯ 축만) — 조용히 빼지 않고 고지한다
  for (const g of groups.values()) {
    const list = g.rows;
    if (list.length < 2) continue;
    const keep = list[0];                      // 가장 이른 seq (조회가 seq 오름차순)
    const losers = list.slice(1);
    const matchedBy = [...(axisOf.get(g.root) || [])];
    const blockedPayment = losers.filter(r => r.in_payment);
    const blockedUsed = losers.filter(r => (r.submitted && !keep.submitted) || (r.paid && !keep.paid));
    /* ★★ "언제 생긴 중복인가" — 판정에는 쓰지 않고 **보여주기만** 한다.
       재발 방지(2026-08-19)가 실제로 듣고 있는지는 이 값 하나로 판별된다: 남은 목록이
       전부 그 이전 날짜면 **정리 안 한 과거분**이고, 그 이후 날짜가 보이면 **아직 새는 구멍**이 있다.
       ★ 기준은 **늦게 들어온 줄(losers)** 의 제출 시각 — 먼저 들어온 줄은 정상 참여다.
       ★★ 단 **남길 줄과 같은 주문을 쓰는 줄(㉯ 축)은 세지 않는다** — 그 시각은 "중복이 생긴 때" 가
          아니라 "그 주문이 접수된 때" 다. 오늘 들어온 주문이 여러 줄에 기록되면 발생 시점과 무관하게
          오늘 날짜가 찍혀 **"배포 이후에 또 샜다" 는 빨간 경고가 오탐으로 뜬다**(2026-08-19 실측).
          작업표 줄이 언제 만들어졌는지는 이 원장에 없으므로 **모른다고 둔다**(0 이나 오늘로 꾸미지 않는다). */
    const _newOrderLosers = losers.filter(r => String(r.osid || '') !== String(keep.osid || ''));
    const _lastAt = _newOrderLosers.reduce((m, r) => (r.at && (!m || r.at > m) ? r.at : m), null);
    if (!_newOrderLosers.length) sameOrderGroups++;
    if (blockedPayment.length || blockedUsed.length) {
      skipped.push({
        orderNum: keep.roword || keep.ordnum, phone8: String(keep.ph).slice(-8), name: keep.name || '',
        seqs: list.map(r => r.seq), lastAt: _lastAt, matchedBy,
        reason: blockedPayment.length ? 'in_payment_batch' : 'used_row_is_not_first',
        keepSeq: keep.seq, removeSeqs: losers.map(r => r.seq),
        detail: blockedPayment.length
          ? '지울 줄이 입금 회차(대기·완료)에 담겨 있습니다 — 이체 내역을 먼저 확인하세요.'
          : '지울 줄에 리뷰제출·입금 표시가 있고 남길 줄에는 없습니다 — 어느 줄을 남길지 사람이 정하세요.',
      });
      continue;
    }
    plan.push({
      orderNum: keep.roword || keep.ordnum, phone8: String(keep.ph).slice(-8), name: keep.name || '',
      keepSeq: keep.seq, removeSeqs: losers.map(r => r.seq), lastAt: _lastAt, matchedBy,
    });
    if (keep.osid) keepOsIds.add(String(keep.osid));
    for (const r of losers) { removeSeqs.push(r.seq); if (r.osid) removeOsIds.push(String(r.osid)); }
  }

  /* ★★ 보류 건에는 **이체 내역을 붙여 준다** — 보류의 대부분은 "지울 줄이 입금 회차에 담김" 인데,
     그 줄이 실제로 **이체까지 됐는지**를 모르면 사람이 판단할 수가 없다(입금관리 화면을 따로 열어
     대조해야 했다). 항목 키가 `(sheet_id, tab_name, row_index)` 라 **중복 줄은 서로 다른 이체 항목**이
     되므로, 한 구매에 `paid` 가 둘이면 **같은 사람에게 두 번 나간 것**이다 — 돈 문제라 반드시 드러낸다.
     ★ 읽기 전용·추가 쿼리 1회(보류가 있을 때만) · 계좌번호는 싣지 않는다(화면에 PII 를 늘리지 않는다). */
  if (skipped.length) {
    const seqs = [...new Set(skipped.flatMap(g => g.seqs))];
    let payRows = [];
    try {
      ({ rows: payRows } = await db.query(
        `SELECT pi.row_index AS seq, pi.status, pi.amount, pi.paid_at AS "paidAt",
                pi.fail_reason AS "failReason", b.seq AS "batchSeq", b.bank,
                b.status AS "batchStatus", b.created_at AS "batchAt"
           FROM payment_batch_items pi
           JOIN payment_batches b ON b.id = pi.batch_id
          WHERE pi.sheet_id = $1 AND pi.tab_name = $2 AND pi.row_index = ANY($3::int[])
          ORDER BY pi.row_index, b.created_at`, [sheetId, tabName, seqs]));
    } catch (e) {
      /* ★ 조회 실패는 보류 목록 자체를 죽이지 않는다 — 대신 "모른다" 로 말한다(0건으로 꾸미지 않는다). */
      logger.warn(`[sheetlessLedger] 보류 건 이체 내역 조회 실패 tab=${tabName} — ${e.message}`);
      for (const g of skipped) g.payUnavailable = true;
      payRows = null;
    }
    if (payRows) {
      const bySeq = new Map();
      for (const r of payRows) {
        if (!bySeq.has(r.seq)) bySeq.set(r.seq, []);
        bySeq.get(r.seq).push(r);
      }
      for (const g of skipped) {
        g.rows = g.seqs.map(sq => ({
          seq: sq, isKeep: sq === g.keepSeq, pay: bySeq.get(sq) || [],
        }));
        /* 같은 구매에 이체 완료가 둘 이상 = 이중 송금. 판정이 아니라 **사실**이라 그대로 말한다. */
        g.paidRows = g.rows.filter(r => r.pay.some(x => x.status === 'paid')).map(r => r.seq);
        g.doublePaid = g.paidRows.length >= 2;
      }
    }
  }

  const cancelOsIds = [...new Set(removeOsIds)].filter(id => !keepOsIds.has(id));
  const lastDupAt = [...plan, ...skipped]
    .reduce((m, g) => (g.lastAt && (!m || g.lastAt > m) ? g.lastAt : m), null);
  const stat = {
    sheetId, tabName, boardRows: rows.length, skippedNoRowOrder: noRowOrder.length, lastDupAt,
    groups: plan.length, removeRows: removeSeqs.length, cancelOrders: cancelOsIds.length,
    /* 발생 시각을 알 수 없는 그룹 수 — 화면이 "이만큼은 이 판정에 안 들어갔다" 고 말한다. */
    sameOrderGroups,
    /* 어느 규칙이 몇 그룹을 잡았는지 — ㉯(같은 주문 기록) 축이 실제로 듣고 있는지 이 값으로 갈린다. */
    byAxis: [...plan, ...skipped].reduce((a, g) => {
      for (const k of (g.matchedBy || [])) a[k] = (a[k] || 0) + 1; return a;
    }, {}),
    skippedGroups: skipped.length, plan: plan.slice(0, 100), skipped: skipped.slice(0, 100),
  };
  if (dryRun) return { ...stat, dryRun: true };
  if (!removeSeqs.length) return { ...stat, removed: 0, canceledOrders: 0 };

  /* ★ 작업표 쓰기는 participants.service 소유(쓰기 소유자 규율) — 여기는 판정·순서·장부만. */
  const r = await require('./participants.service')
    .retireRows({ sheetId, tabName, seqs: removeSeqs, dryRun: false, by: `dedupe:${by}` });
  /* ★★ 남길 줄이 그 주문을 쓰고 있으면 취소하지 않는다(위 keepOsIds 규율) — ㉯ 축에서는
     지울 줄과 남길 줄이 **같은 주문 기록**을 공유하므로 그대로 넘기면 살아남은 줄의 주문이 사라진다. */
  const canceled = await require('./orderLedger.service')
    .softDeleteDuplicateOrders(cancelOsIds, `dedupe:${by}`);

  let ledger = null, ledgerError = null;
  try {
    ledger = await rebuildLedgers({ sheetId, tabName, by: `dedupe:${by}` });
  } catch (e) {
    ledgerError = (e && (e.code || e.message)) || 'rebuild_failed';
    logger.warn(`[sheetlessLedger] 중복 정리 후 장부 재생성 실패 tab=${tabName} — ${ledgerError}`);
  }
  logger.info(`[sheetlessLedger] 중복 줄 정리 tab=${tabName} ${r.retired}줄 · 주문 ${canceled}건 취소 by=${by}`);
  return { ...stat, removed: r.retired, canceledOrders: canceled,
           indexRows: ledger ? ledger.indexRows : null, ledgerError };
}

/**
 * ★★ ⚠중복 진단에서 **그룹 하나를 사람이 직접** 정리한다 (2026-08-19 사용자 요청).
 *
 * 왜 필요한가: `dedupeRows` 는 "확신할 때만" 잡는다 — 주문 링크가 없거나(무링크 줄),
 * 연결된 주문이 취소됐거나, 표 주문번호가 줄마다 다르면 **조회 대상에서조차 빠진다**.
 * 그런 그룹이 진단 창에 `정리 보류`·`주문 링크 없음` 으로 쌓이는데 손댈 창구가 없어
 * 표에 같은 사람이 3~4줄로 남았고, **그 표를 그대로 보는 광고주가 혼동했다**(실측 신고).
 *
 * ★★ 자동 판정을 완화하지 않는다 — `dedupeRows` 의 키(표·원장 주문번호·연락처 3개 일치)는
 *   그대로 두고, **사람이 그룹마다 남길 줄을 고르는** 경로를 따로 연다. 판정을 넓히면
 *   "다른 구매인데 한 줄로 합쳐지는" 사고가 자동으로 일어난다.
 * ★★ fail-closed 4종(완화 금지):
 *   ㉮ **이체가 이미 나간 줄(paid)은 어떤 확인으로도 못 내린다** — 그 줄이 송금 근거다.
 *   ㉯ 이체 대기(pending) 회차에 담긴 줄은 `ackPending` 명시 확인이 있어야 내린다.
 *   ㉰ 이체 담김 여부를 **모르면 내리지 않는다**(조회 실패 = 거부 — 모르는 채로 지우지 않는다).
 *   ㉱ 화면이 보낸 줄 번호는 **서버가 그 탭에서 다시 조회**한다(없으면 거부 — 낡은 화면 차단).
 * ★ 주문 취소는 **그 주문을 쓰는 활성 줄이 하나도 안 남을 때만**(남길 줄뿐 아니라 이 그룹 밖의
 *   다른 줄까지 본다 — 같은 주문 기록을 공유하는 그룹에서 살아남은 줄의 주문이 사라지면 안 된다).
 * ★ 순서 계약은 `retireRows` 와 같다: **작업표 soft-delete → 장부 재생성**.
 * ★ dryRun 기본 — 값이 빠진 요청이 곧바로 실행되지 않는다. 하드삭제 없음(되돌릴 수 있다).
 */
async function dedupeManual({ sheetId, tabName, keepSeq, removeSeqs = [],
                              cancelOrders = true, ackPending = false,
                              dryRun = true, by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new LedgerError('bad_request', 'sheetId, tabName 필수');
  const keep = parseInt(keepSeq, 10);
  if (!Number.isFinite(keep)) throw new LedgerError('bad_request', '남길 줄을 고르지 않았습니다.');
  const rem = [...new Set((Array.isArray(removeSeqs) ? removeSeqs : [])
    .map(n => parseInt(n, 10)).filter(n => Number.isFinite(n)))].slice(0, 200);
  if (!rem.length) throw new LedgerError('empty', '내릴 줄을 고르지 않았습니다.');
  if (rem.includes(keep)) throw new LedgerError('keep_in_remove', '남길 줄은 내릴 줄에 함께 담을 수 없습니다.');

  const db = getPool();
  await _assertSheetlessTab(db, sheetId, tabName,
    '시트 기반 탭입니다 — 표에서만 내려도 다음 시트 반영이 되살립니다. 시트에서 정리하세요.');

  /* ㉱ 대상은 서버가 다시 읽는다 — `dedupeRows` 와 달리 **LEFT JOIN** 이라
     무링크 줄·취소된 주문에 매달린 줄도 다룰 수 있다(그게 이 경로의 존재 이유다). */
  const { rows } = await db.query(
    `SELECT cp.seq, cp.reviewer_name AS name, cp.phone8, cp.order_submission_id::text AS osid,
            COALESCE(cp.is_submitted, FALSE) AS submitted, COALESCE(cp.is_paid, FALSE) AS paid,
            (os.id IS NOT NULL AND os.deleted_at IS NOT NULL) AS "orderDeleted",
            regexp_replace(COALESCE(os.order_num, ''), '\\D', '', 'g') AS ordnum
       FROM campaign_participants cp
       LEFT JOIN order_submissions os ON os.id = cp.order_submission_id
      WHERE cp.sheet_id = $1 AND cp.tab_name = $2 AND cp.deleted_at IS NULL
        AND cp.seq = ANY($3::int[])
      ORDER BY cp.seq`, [sheetId, tabName, [keep, ...rem]]);
  const bySeq = new Map(rows.map(r => [Number(r.seq), r]));
  const missing = [keep, ...rem].filter(s => !bySeq.has(s));
  if (missing.length) {
    throw new LedgerError('row_not_found',
      `표에 없거나 이미 내려간 줄이 있습니다(줄 ${missing.join(', ')}) — 창을 새로 불러온 뒤 다시 시도하세요.`);
  }

  /* ㉰ 이체 담김 — 모르면 거부. 0 으로 꾸미지 않는다. */
  let payBySeq = new Map();
  try {
    const { rows: p } = await db.query(
      `SELECT pi.row_index AS seq, pi.status, b.seq AS "batchSeq", b.bank
         FROM payment_batch_items pi
         JOIN payment_batches b ON b.id = pi.batch_id
        WHERE pi.sheet_id = $1 AND pi.tab_name = $2 AND pi.row_index = ANY($3::int[])
          AND pi.status IN ('pending','paid')`, [sheetId, tabName, rem]);
    for (const r of p) {
      const k = Number(r.seq);
      if (!payBySeq.has(k)) payBySeq.set(k, []);
      payBySeq.get(k).push(r);
    }
  } catch (e) {
    logger.warn(`[sheetlessLedger] 수동 정리 이체 담김 조회 실패 tab=${tabName} — ${e.message}`);
    throw new LedgerError('payment_unknown',
      '이체 회차에 담긴 줄인지 확인하지 못했습니다 — 모르는 채로 내리지 않습니다. 잠시 후 다시 시도하세요.');
  }
  const paidSeqs = rem.filter(s => (payBySeq.get(s) || []).some(x => x.status === 'paid'));
  if (paidSeqs.length) {
    throw new LedgerError('in_paid_batch',
      `이미 이체가 나간 줄이 있습니다(줄 ${paidSeqs.join(', ')}) — 송금 근거라 내리지 않습니다. ` +
      '그 줄을 남기고 다른 줄을 내리거나, 입금관리에서 먼저 확인하세요.');
  }
  const pendingSeqs = rem.filter(s => (payBySeq.get(s) || []).some(x => x.status === 'pending'));
  if (pendingSeqs.length && ackPending !== true) {
    throw new LedgerError('in_pending_batch',
      `이체 대기 회차에 담긴 줄이 있습니다(줄 ${pendingSeqs.join(', ')}) — 줄을 내려도 그 회차 항목은 ` +
      '자동으로 빠지지 않습니다. 입금관리에서 회차를 확인한 뒤 진행하세요.');
  }

  /* 주문 취소 대상 — 이 그룹 밖의 활성 줄까지 확인해 **아무도 안 쓰는 주문만** 취소한다. */
  const removeOsIds = [...new Set(rem.map(s => bySeq.get(s).osid).filter(Boolean))];
  let cancelIds = [];
  if (cancelOrders !== false && removeOsIds.length) {
    const { rows: still } = await db.query(
      `SELECT DISTINCT order_submission_id::text AS id
         FROM campaign_participants
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
          AND order_submission_id = ANY($3::uuid[])
          AND NOT (seq = ANY($4::int[]))`, [sheetId, tabName, removeOsIds, rem]);
    const inUse = new Set(still.map(r => r.id));
    cancelIds = removeOsIds.filter(id => !inUse.has(id));
  }

  const detail = (seq) => {
    const r = bySeq.get(seq);
    return {
      seq, name: r.name || '', phone8: String(r.phone8 || '').slice(-8),
      hasOrder: !!r.osid, orderNum: r.ordnum || '', orderDeleted: !!r.orderDeleted,
      submitted: !!r.submitted, paid: !!r.paid,
      inPendingBatch: (payBySeq.get(seq) || []).some(x => x.status === 'pending'),
    };
  };
  const stat = {
    ok: true, sheetId, tabName,
    keep: detail(keep), remove: rem.map(detail),
    removeRows: rem.length, cancelOrders: cancelIds.length, pendingSeqs,
    /* 지울 줄에만 표시가 있으면 사람이 다시 볼 신호다 — 막지는 않고 사실로 말한다. */
    losesSubmitted: rem.some(s => bySeq.get(s).submitted) && !bySeq.get(keep).submitted,
    losesPaid: rem.some(s => bySeq.get(s).paid) && !bySeq.get(keep).paid,
  };
  if (dryRun) return { ...stat, dryRun: true };

  /* ★ 작업표 쓰기는 participants.service 소유(쓰기 소유자 규율) — 여기는 게이트·순서·장부만. */
  const r = await require('./participants.service')
    .retireRows({ sheetId, tabName, seqs: rem, dryRun: false, by: `dedupe-manual:${by}` });
  const canceled = await require('./orderLedger.service')
    .softDeleteDuplicateOrders(cancelIds, `dedupe-manual:${by}`);

  let ledger = null, ledgerError = null;
  try {
    ledger = await rebuildLedgers({ sheetId, tabName, by: `dedupe-manual:${by}` });
  } catch (e) {
    ledgerError = (e && (e.code || e.message)) || 'rebuild_failed';
    logger.warn(`[sheetlessLedger] 수동 정리 후 장부 재생성 실패 tab=${tabName} — ${ledgerError}`);
  }
  logger.info(`[sheetlessLedger] 중복 수동 정리 tab=${tabName} 남김 ${keep} · ${r.retired}줄 내림 · ` +
    `주문 ${canceled}건 취소 by=${by}`);
  return { ...stat, removed: r.retired, canceledOrders: canceled,
           indexRows: ledger ? ledger.indexRows : null, ledgerError };
}

/**
 * ★★ 전체 작업 일괄 점검 — 어느 작업에 중복 줄이 남아 있는지 한 번에 찾는다(읽기 전용).
 *
 * ★ 판정 사본 0 — 탭마다 `dedupeRows({ dryRun: true })` 를 **그대로** 부른다. 여기서 조건을 다시
 *   쓰면 "일괄 점검엔 뜨는데 그 작업을 열면 대상이 아닌" 상태가 생긴다.
 * ★ 쓰기 0(모든 호출이 dryRun) · 시트/Drive 무접촉.
 * ★ 대상은 **무시트 탭**뿐(시트 기반은 dedupeRows 가 거부한다). 탭 하나가 실패해도 나머지는 계속하고
 *   그 탭의 사유를 보고한다(조용한 누락 금지).
 */
/* ★ `dedupeFn` 은 테스트 주입용 — 모듈 내부 호출은 렉시컬이라 export 를 갈아끼워도 안 먹는다
   (`trackB.cutoverAll` 의 `overviewFn`/`flipFn` 과 같은 선례). 런타임 기본값은 항상 dedupeRows. */
async function scanDuplicateRows({ limit = 300, by = 'admin', dedupeFn = dedupeRows } = {}) {
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000);
  const { rows: tabs } = await db.query(
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName", COALESCE(display_name, tab_name) AS label
       FROM tab_configs
      WHERE COALESCE(sheetless, FALSE) = TRUE
      ORDER BY updated_at DESC NULLS LAST, tab_name
      LIMIT $1`, [lim + 1]);
  const truncated = tabs.length > lim;
  const list = truncated ? tabs.slice(0, lim) : tabs;

  const out = { scanned: 0, failed: 0, truncated, tabs: [], errors: [] };
  for (const t of list) {
    out.scanned++;
    try {
      const r = await dedupeFn({ sheetId: t.sheetId, tabName: t.tabName, dryRun: true, by });
      if (r.removeRows > 0 || r.skippedGroups > 0) {
        out.tabs.push({
          sheetId: t.sheetId, tabName: t.tabName, label: t.label,
          boardRows: r.boardRows, groups: r.groups, removeRows: r.removeRows,
          skippedGroups: r.skippedGroups, skippedNoRowOrder: r.skippedNoRowOrder || 0,
          lastDupAt: r.lastDupAt || null, sameOrderGroups: r.sameOrderGroups || 0,
        });
      }
    } catch (e) {
      out.failed++;
      out.errors.push({ sheetId: t.sheetId, tabName: t.tabName, label: t.label,
        reason: (e && (e.code || e.message)) || 'unknown' });
    }
  }
  out.tabs.sort((a, b) => (b.removeRows - a.removeRows) || (b.skippedGroups - a.skippedGroups));
  out.totalRemoveRows = out.tabs.reduce((n, t) => n + t.removeRows, 0);
  out.totalSkipped = out.tabs.reduce((n, t) => n + t.skippedGroups, 0);
  /* ★ 전 작업 통틀어 가장 최근에 생긴 중복 — "지금도 늘어나는가" 의 답. */
  out.lastDupAt = out.tabs.reduce((m, t) => (t.lastDupAt && (!m || t.lastDupAt > m) ? t.lastDupAt : m), null);
  /* 발생 시각을 알 수 없는 그룹(㉯ 축만) — 조용히 빼면 "배포 이후 유입 0" 으로 오독된다. */
  out.sameOrderGroups = out.tabs.reduce((n, t) => n + (t.sameOrderGroups || 0), 0);
  logger.info(`[sheetlessLedger] 중복 일괄 점검 by=${by} 탭 ${out.scanned}개 · 해당 ${out.tabs.length}개 · ` +
    `정리대상 ${out.totalRemoveRows}줄 · 보류 ${out.totalSkipped}건 · 실패 ${out.failed}`);
  return out;
}

module.exports = {
  rebuildLedgers,
  retireRows,
  dedupeRows,
  dedupeManual,
  scanDuplicateRows,
  resolveHeaders,
  buildValues,
  LedgerError,
  __setPoolForTest,
  writeRawMirrorRows,
};
