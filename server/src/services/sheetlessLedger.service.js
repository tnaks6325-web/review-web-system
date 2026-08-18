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

  const { rows: tcRows } = await db.query(
    `SELECT COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tcRows.length) throw new LedgerError('tab_not_registered', '등록되지 않은 탭입니다.');
  if (!tcRows[0].sheetless) {
    throw new LedgerError('not_sheetless',
      '시트 기반 탭입니다 — 표에서만 내려도 다음 시트 반영이 되살립니다. 시트에서 정리하거나 이관 후 이용하세요.');
  }

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

module.exports = {
  rebuildLedgers,
  retireRows,
  resolveHeaders,
  buildValues,
  LedgerError,
  __setPoolForTest,
  writeRawMirrorRows,
};
