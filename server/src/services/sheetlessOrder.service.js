/**
 * sheetlessOrder.service.js — 무시트 주문 "즉시 완결" (탈 구글시트 W2)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 하는 일 = **구매양식 제출을 시트가 아니라 작업표에 기록한다**
 *
 *   시트 경로 : 원장 INSERT → 행 배정 → `order_append` 큐 → (몇 초~분) → 구글시트 기록 → written
 *   무시트    : 원장 INSERT → 행 배정 → **작업표에 바로 기록 + 장부 재생성** → written (같은 요청 안)
 *
 *   그래서 "즉시 완결" — 큐·재시도·사후검증(시트 대조)이 통째로 필요 없어진다.
 *   최종점검 문서가 지적한 "시트 없음 종결 상태 부재 → reconcile 헛돌기 + 알림 도배"의 해소다.
 *
 * ★★ **`mirror_status` 값은 그대로 `'written'`**(새 상태를 만들지 않는다). 이유:
 *   'written' 은 이미 **종결 상태**이고 소비처가 여럿(reconcile 제외 · 배치 스케줄러 제외 ·
 *   미반영 알림 제외 · Track B 금액 집계 · 교체요청 자동해결)이다. 새 값을 만들면 그 목록을
 *   전부 훑어야 하고 **한 곳만 놓쳐도 무시트 주문이 조용히 "미완결"로 취급**된다.
 *   대신 **시트를 실제로 읽어 대조하는 경로**(written 사후검증)에서만 무시트 탭을 제외한다.
 *
 * ★★ 매핑 사본 0 — 어느 칸에 무엇을 쓸지는 `mapOrderToSheetRow`(orderLedger 단일 출처)가 정한다.
 *   여기서 키워드 규칙을 다시 만들면 "시트 작업과 무시트 작업이 서로 다른 칸에 쓰는" 사고가 난다.
 *
 * ★★ 옵션 칸 blank-only 유지 — 시트 경로의 `filterOptionWritesBlankOnly` 와 **같은 규율**로
 *   작업표의 기존 옵션 값(관리자 작업지시 '텍스트'·'포토리뷰')을 덮지 않는다.
 *   판정 열은 `optionWriteColumns`(매퍼 파생) — `optionColIndexes`(헤더에 '옵션' 포함)를 쓰면
 *   `옵션금액`(=결제금액)·`비고(옵션확인)` 을 오분류해 금액·비고가 조용히 사라진다.
 *
 * ★ 구글 API 호출 0(회귀가드가 고정). 쓰기 표면 = `campaign_participants` + 장부 3권 + 주문 원장.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');
const { tableOrderNumSql } = require('../utils/tableOrderNum');
const pool = require('../db/pool');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 연락처 → 뒤 8자리(검색·행배정 신원키와 같은 규칙) */
function _phone8(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}
// 중복 판정 키 정규화 — SQL 쪽 regexp_replace(…, '\D', '', 'g') 와 **같은 규칙**이어야 한다.
function _digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

/**
 * 주문 값 → 작업표 행에 병합할 `row_json` 조각.
 *
 * @param {string[]} headers          장부(=작업표) 열 이름
 * @param {object}   orderData        구매양식 값
 * @param {object}   currentRowJson   그 줄의 현재 값(옵션 blank-only 판정 재료)
 * @returns {{patch:object, optionSuppressed:Array<{header,want,cur}>}}
 *   patch = 덮어쓸 {헤더명: 값}. 매퍼가 `null` 을 준 칸(관리자 보호열 등)은 들어가지 않는다.
 */
function buildRowPatch(headers, orderData, currentRowJson = {}) {
  const { mapOrderToSheetRow, optionWriteColumns } = require('./orderLedger.service');
  const mapped = mapOrderToSheetRow(headers || [], orderData || {});
  const optCols = new Set(optionWriteColumns(headers || []));
  const blankOnly = process.env.ORDER_OPTION_BLANK_ONLY !== '0';

  const patch = {};
  const optionSuppressed = [];
  let optionWritten = false;
  (headers || []).forEach((h, i) => {
    const val = mapped[i];
    if (val === null || val === undefined) return;          // 매퍼가 "쓰지 않음"이라 한 칸
    const name = String(h == null ? '' : h);
    if (!name) return;
    if (optCols.has(i) && blankOnly) {
      const cur = String((currentRowJson || {})[name] == null ? '' : (currentRowJson || {})[name]).trim();
      if (cur) { optionSuppressed.push({ header: name, want: String(val), cur }); return; }
    }
    if (optCols.has(i) && String(val).trim()) optionWritten = true;
    patch[name] = String(val);
  });

  /* ★★ 조용한 누락 차단 (2026-08-20) — 리뷰어가 고른 옵션이 있는데 **기입할 칸이 없는** 경우.
     매퍼는 '옵션' 헤더가 없으면 그 값을 `null` 로 떨어뜨리고, 종전에는 경고도 로그도 없이
     사라졌다(8/20 「선물세트 3종 빈박스」 — 원장에는 3종 선택이 남았는데 표에는 흔적 0).
     ★ 보존(blank-only)으로 안 쓴 것과는 **다른 신호**다 — 그쪽은 값이 이미 있는 정상 동작이고,
       이쪽은 **칸 자체가 없다**(사람이 칸을 만들어야 풀린다). */
  const wantOpt = String((orderData || {}).selectedOptKey || '').trim();
  const optionUnmapped = (wantOpt && !optionWritten && !optionSuppressed.length) ? wantOpt : '';

  return { patch, optionSuppressed, optionUnmapped };
}

/**
 * 이 구매(orderData.dateStr)가 탭에 연결된 작업오더의 모집 일정을 벗어났는지 판정한다.
 * ★★ 오직 **초과 접수(빈 슬롯 없음 → appendSlot)** 판정에만 쓴다 — 같은 날 초과는 여전히
 *   받는다(2026-08-24 「전보미」 실측: 20건 오더 정원이 그날 안에 다 찼는데 21번째가 결제까지
 *   끝낸 정상 초과였다면 받아야 한다). 거부 대상은 **날짜가 넘어간** 뒷북 접수뿐이다 —
 *   이미 끝난 날짜의 작업표에 다음 날 구매가 섞여 들어가는 사고(같은 실측: 21번 행만 8/21).
 * ★ 범위는 `worktablePlan.distributeDates` 로 **다시 계산**한다(작업표 생성 때와 같은 함수 —
 *   판정 사본 0). 이미 표에 적힌 날짜값을 근거로 삼지 않는다 — 과거 초과 접수로 오염됐을 수 있다
 *   (그 값을 기준으로 삼으면 한 번 새면 다음도 새는 자기강화 버그가 된다).
 * ★★ fail-open — 연결된 작업오더가 없거나(참여형 공고 전용 탭 등) 일정을 모르면(시작일 미상)
 *   판정하지 않는다(막지 않는다). 구매일을 못 읽어도 마찬가지 — "모르면 막지 않는다"는
 *   이 파일 전체의 규율(appendSlot 도입 사유와 같다)과 같은 원칙이다.
 */
async function _isPastOrderWindow(client, { sheetId, tabName, dateStr }) {
  if (!dateStr) return false;
  try {
    const { workOrderForTabSql } = require('../utils/workOrderLink');
    const sql = workOrderForTabSql(['recruit_count', 'daily_count', 'start_date', 'skip_weekends', 'holidays']);
    const { rows } = await client.query(sql, [sheetId, tabName]);
    if (!rows.length) return false;
    const wo = rows[0];

    let holidays = [];
    try {
      const parsed = Array.isArray(wo.holidays) ? wo.holidays
        : (typeof wo.holidays === 'string' && wo.holidays.trim() ? JSON.parse(wo.holidays) : []);
      holidays = Array.isArray(parsed) ? parsed : [];
    } catch (_) { holidays = []; }

    const { distributeDates } = require('../utils/worktablePlan');
    const { days } = distributeDates({
      total: wo.recruit_count, daily: wo.daily_count, startDate: wo.start_date,
      skipWeekends: wo.skip_weekends === false || wo.skip_weekends === 'false' ? false : true,
      holidays,
    });
    if (!days.length) return false;                          // 일정 미상 — 판정 불가
    const windowEnd = days[days.length - 1].date;             // 'YYYY-MM-DD' — 오더가 도는 마지막 날

    const { parseDateColumn } = require('../utils/koreanDate');
    const anchor = { y: parseInt(windowEnd.slice(0, 4), 10), m: parseInt(windowEnd.slice(5, 7), 10) };
    const [iso] = parseDateColumn([dateStr], { fallbackAnchor: anchor });
    if (!iso) return false;                                   // 구매일을 못 읽으면 판정하지 않는다
    return iso > windowEnd;
  } catch (e) {
    logger.warn(`[sheetlessOrder] 모집 일정 범위 판정 실패(막지 않음): ${e.message}`);
    return false;                                             // fail-open
  }
}

/**
 * 무시트 탭의 주문을 작업표에 기록하고 장부를 다시 만든다.
 *
 * @param {object} o
 * @param {string} o.sheetId · o.tabName · [o.tabGid]
 * @param {number} o.sheetRow            배정된 행 번호(= `campaign_participants.seq`)
 * @param {object} o.orderData
 * @param {string} o.orderSubmissionId
 * @param {string} [o.loginPhone8] · [o.loginName]
 * @param {boolean} [o.recovered]        복구 재기록(비고 표기용 — 시트 경로와 같은 의미)
 * @returns {Promise<{ok:boolean, written?:boolean, reason?:string, ledger?:object}>}
 */
async function writeOrderToWorktable({
  sheetId, tabName, tabGid = '', sheetRow, orderData = {},
  orderSubmissionId, loginPhone8 = '', loginName = '', recovered = false,
} = {}) {
  if (!sheetId || !tabName || !orderSubmissionId) return { ok: false, reason: 'bad_request' };
  const db = getPool();

  const ledgerSvc = require('./orderLedger.service');
  const { loadRawTabContext, markOrderWritten } = ledgerSvc;

  // ── 열 구성 = 장부(raw_sheet_tabs)에서. 시트 경로와 **같은 로더**를 쓴다(사본 0). ──
  let ctx = null;
  try { ctx = await loadRawTabContext(sheetId, tabGid, tabName); } catch (_) { ctx = null; }
  let headers = (ctx && ctx.headers) || [];
  // 과거 작업보드는 RAW 탭 메타가 비어 있을 수 있다. 이미 준비된 작업보드
  // 슬롯의 row_json 열 이름을 같은 DB 원본으로 사용해 복구를 막지 않는다.
  if (!headers.length) {
    try {
      const { rows: stored } = await getPool().query(
        `SELECT row_json FROM campaign_participants
          WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
            AND row_json IS NOT NULL
          ORDER BY seq LIMIT 1`, [sheetId, tabName]);
      headers = Object.keys((stored[0] && stored[0].row_json) || {}).filter(Boolean);
    } catch (_) { headers = []; }
  }
  if (!headers.length) {
    // ★ 열을 모르면 아무 칸에도 쓸 수 없다 — 조용히 "완결" 처리하지 않는다(주문은 원장에 살아 있고
    //   화면·복구 경로가 미반영으로 본다).
    return { ok: false, reason: 'no_headers' };
  }
  const gid = String((ctx && ctx.tabGid) || tabGid || '');

  const requestedSeq = sheetRow == null ? null : parseInt(sheetRow, 10);
  if (sheetRow != null && (!Number.isInteger(requestedSeq) || requestedSeq < 1)) return { ok: false, reason: 'bad_row' };

  // ── 작업표 줄에 병합 ────────────────────────────────────────────────
  //   ★ 행 잠금(FOR UPDATE) — 같은 줄에 동시에 두 건이 들어오는 경우는 claim 이 막지만,
  //     재기록(reconcile)·관리자 편집과의 경합까지 직렬화한다.
  const client = await db.connect();
  let optionSuppressed = [];
  let optionUnmapped = '';
  // ★★ `seq` 는 try 밖에서 선언한다 — 아래 catch·완결 표시·신원 링크·로그가 전부 이 값을 쓴다.
  //   try 안에서 `let` 으로 선언하면 블록 스코프라 커밋 뒤 `markOrderWritten(…, seq)` 부터
  //   ReferenceError 가 나고, 마지막 logger.info 에서 함수 밖으로 던져진다. 그러면 행은 이미
  //   기록됐는데 호출부가 예외를 잡아 주문을 'failed' 로 강등하고 리뷰어 화면엔 제출 실패로 보여
  //   **재제출 → 새 주문 → 작업보드 중복 줄**이 된다(2026-08-19 실사고).
  let seq = requestedSeq;
  try {
    await client.query('BEGIN');
    /* ★ 탭 단위 직렬화 — 빈 슬롯 선점과 줄 이어붙이기(MAX(seq)+1)가 겹쳐도 두 건이 같은
       번호를 집지 않는다. 트랜잭션 스코프라 누수 불가이고, 장부 재생성 락은 커밋 뒤
       별도 트랜잭션에서 잡히므로 중첩(=교착) 이 생기지 않는다. */
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`sheetless_worktable:${sheetId}:${tabName}`]);
    let cur;
    if (seq != null) {
      ({ rows: cur } = await client.query(
        `SELECT id, seq, row_json FROM campaign_participants
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL
          FOR UPDATE`, [sheetId, tabName, seq]));
    } else {
      // 재시도는 이미 연결된 행을 먼저 잠근다. 없을 때만 준비된 빈 슬롯을 선점한다.
      ({ rows: cur } = await client.query(
        `SELECT id, seq, row_json FROM campaign_participants
          WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
            AND order_submission_id = $3::uuid
          FOR UPDATE`, [sheetId, tabName, orderSubmissionId]));
      // ★★ 빈 슬롯을 새로 먹기 전에 "같은 구매가 이미 이 표에 있는가" 를 본다.
      //   무시트 경로는 시트 시절의 `sheet_row_claims`(=(sheet,tab,dedup_key) 유니크)를 건너뛰고
      //   `campaign_participants.order_submission_id` 도 유니크가 아니라, **주문원장 행이 하나 더 생기면
      //   작업보드 줄도 하나 더 생긴다**(2026-08-19 중복 사고). 여기서 그 마지막 수렴점을 만든다.
      //   ★ 판정 키 = 주문번호(숫자만) + 연락처(숫자만). 주문번호가 없으면(비번호 쿠팡 등) 판정하지
      //     않고 종전대로 진행한다 — 모르면 막지 않는다(fail-open).
      if (!cur.length && _digits(orderData.orderNum).length >= 6) {
        let { rows: dup } = await client.query(
          `SELECT cp.seq, cp.order_submission_id
             FROM campaign_participants cp
             JOIN order_submissions os2 ON os2.id = cp.order_submission_id
            WHERE cp.sheet_id = $1 AND cp.tab_name = $2 AND cp.deleted_at IS NULL
              AND cp.order_submission_id <> $3::uuid
              AND os2.deleted_at IS NULL
              AND regexp_replace(COALESCE(os2.order_num, ''), '\D', '', 'g') = $4
              AND regexp_replace(COALESCE(os2.phone, ''), '\D', '', 'g') = $5
            ORDER BY cp.seq
            LIMIT 1`,
          [sheetId, tabName, orderSubmissionId,
           _digits(orderData.orderNum), _digits(orderData.phone)]);
        /* ★★ 2차 방어 — **링크를 타지 않고 표에 적힌 주문번호로도** 본다 (2026-08-19 실사고).
             위 1차 방어는 `cp.order_submission_id → os2` 조인으로 판정한다. 그래서 그 **링크가
             오염되면**(다른 주문을 가리키면) 이미 반영된 줄을 보지 못하고 새 빈 슬롯을 먹는다 —
             10분 복구 크론이 매 주기 한 줄씩, 「8/3(쿠팡)위프_블랙 탈취제」 권정현 한 사람에게만
             11줄을 만들었다(16:40~18:20). 링크 오염 하나가 줄 오삭제와 줄 중복 생성 두 방향으로
             동시에 사고를 냈다.
             ★ 판정 값은 **담당자가 표에서 눈으로 보는 주문번호** — 중복 정리(`dedupeRows`)와
               **같은 SQL 조각**(`tableOrderNumSql`)을 쓴다. 두 기능이 다른 규칙으로 "표 주문번호"를
               뽑으면 한쪽은 지우고 다른 쪽은 또 만드는 상태가 된다.
             ★ **명의(phone8)까지 같을 때만** 중복으로 본다 — 표 주문번호만으로는 담당자가 옆 줄에
               같은 번호를 적어 둔 경우까지 막아 정상 주문이 표에 못 들어간다(모르면 막지 않는다).
             ★ 연락처를 8자리로 못 만들면 이 검사를 건너뛴다(fail-open). */
        if (!dup.length && String(_digits(orderData.phone)).length >= 8) {
          const { rows: dupRow } = await client.query(
            `SELECT cp.seq, cp.order_submission_id
               FROM campaign_participants cp
              WHERE cp.sheet_id = $1 AND cp.tab_name = $2 AND cp.deleted_at IS NULL
                AND (cp.order_submission_id IS NULL OR cp.order_submission_id <> $3::uuid)
                AND ${tableOrderNumSql('cp')} = $4
                AND cp.phone8 = $5
              ORDER BY cp.seq
              LIMIT 1`,
            [sheetId, tabName, orderSubmissionId,
             _digits(orderData.orderNum), String(_digits(orderData.phone)).slice(-8)]);
          if (dupRow.length) dup = dupRow;
        }
        if (dup.length) {
          // 이미 반영된 구매다. 새 줄을 만들지 않고 그 줄을 가리켜 돌려준다.
          //   ★ 기존 줄의 `order_submission_id` 는 **바꾸지 않는다** — 링크를 빼앗으면 원래 주문이
          //     "미반영"으로 되살아나 복구 잡이 다시 줄을 만든다(막으려던 사고의 재현).
          await client.query('ROLLBACK');
          /* ★ 표 주문번호로 찾은 줄은 **링크가 비어 있을 수 있다**(담당자 수기 입력 줄).
               그때 `String(null)` 은 문자열 "null" 이 되어 로그·응답이 거짓을 말한다. */
          const dupOf = dup[0].order_submission_id ? String(dup[0].order_submission_id) : null;
          logger.warn(`[sheetlessOrder] 같은 구매가 이미 반영됨 tab=${tabName} seq=${dup[0].seq} ` +
            `os=${orderSubmissionId} 기존os=${dupOf || '(링크 없음 — 표 주문번호로 확인)'} — 새 줄을 만들지 않는다`);
          return { ok: true, written: false, reason: 'duplicate_row',
                   seq: Number(dup[0].seq), duplicateOf: dupOf };
        }
      }
      if (!cur.length) {
        ({ rows: cur } = await client.query(
          `SELECT id, seq, row_json FROM campaign_participants
            WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE
              AND order_submission_id IS NULL
              AND NULLIF(btrim(COALESCE(reviewer_name, '')), '') IS NULL
              AND NULLIF(btrim(COALESCE(recipient_name, '')), '') IS NULL
              AND NULLIF(btrim(COALESCE(phone8, '')), '') IS NULL
            ORDER BY seq
            FOR UPDATE SKIP LOCKED
            LIMIT 1`, [sheetId, tabName]));
      }
      if (!cur.length) {
        /* ★★ 빈 자리가 없다고 주문을 미반영으로 두지 않는다 — **확정된 주문에는 줄이 있어야 한다**.
           작업표가 진실원본인 지금 "준비된 줄 수만큼만 받는다"로 두면, 결제한 리뷰어가 어느 표에도
           없는 상태가 되고 복구 잡이 같은 실패(`no_open_slot`)를 영원히 반복한다(반복 이상현상).
           ★ 쓰기 소유자 규율 — `campaign_participants` INSERT 는 participants.service 가 한다. */
        /* ★ fail-closed — 무시트로 등록된 탭에서만 이어붙인다. 시트 기반 탭에 줄을 만들면
           그 표의 진실원본(시트)과 갈라진다(장부 재생성도 `not_sheetless` 로 거부한다). */
        const { rows: tc } = await client.query(
          `SELECT COALESCE(sheetless, FALSE) AS sheetless FROM tab_configs
            WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
        if (!tc.length || !tc[0].sheetless) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'no_open_slot' };
        }
        /* ★★ 정원 초과 접수 자체는 막지 않는다(확정된 주문은 줄이 있어야 한다) — 다만
           그 초과가 **오더 일정을 넘어간 날짜**(뒷북)면 이 표에 붙이지 않는다. 주문은
           원장에 이미 살아 있으므로(위 createOrderLedgerEntry) 돈을 잃지 않는다 — 여기서
           거부되면 관제가 수동으로 확인한다(다른 append 실패 사유와 같은 경로). */
        if (await _isPastOrderWindow(client, { sheetId, tabName, dateStr: orderData.dateStr })) {
          await client.query('ROLLBACK');
          logger.warn(`[sheetlessOrder] 모집 일정 이후 날짜의 초과 접수 거부 tab=${tabName} ` +
            `dateStr=${orderData.dateStr} os=${orderSubmissionId}`);
          return { ok: false, reason: 'overage_past_order_window' };
        }
        const appended = await require('./participants.service').appendSlot(client, {
          sheetId, tabName, tabGid: gid || null, by: 'sheetless-order-append',
        });
        if (!appended) { await client.query('ROLLBACK'); return { ok: false, reason: 'append_failed' }; }
        // 준비된 줄을 넘겨 이어붙였다는 사실은 남긴다(정원 대비 실제 반영 수 대조용).
        logger.warn(`[sheetlessOrder] 준비된 빈 자리가 없어 줄을 이어붙임 tab=${tabName} seq=${appended.seq} os=${orderSubmissionId}`);
        cur = [appended];
      }
      seq = Number(cur[0].seq);
    }

    const currentRowJson = (cur[0] && cur[0].row_json && typeof cur[0].row_json === 'object') ? cur[0].row_json : {};
    const built = buildRowPatch(headers, orderData, currentRowJson);
    optionSuppressed = built.optionSuppressed;
    optionUnmapped = built.optionUnmapped || '';
    const merged = { ...currentRowJson, ...built.patch };

    const reviewerName = String(loginName || orderData.orderer || orderData.recipient || '').slice(0, 200);
    const recipientName = String(orderData.recipient || '').slice(0, 200);
    const p8 = _phone8(orderData.phone) || String(loginPhone8 || '').replace(/\D/g, '').slice(-8);
    // ★ 옵션은 리뷰어가 고른 값만 원장에 — 시트값 역주입 금지(C′ 규율). 빈 값이면 기존 값 보존.
    const optText = String(orderData.selectedOptKey || '').trim();

    if (cur.length) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = $4::jsonb,
                reviewer_name  = COALESCE(NULLIF($5,''), reviewer_name),
                recipient_name = COALESCE(NULLIF($6,''), recipient_name),
                phone8         = COALESCE(NULLIF($7,''), phone8),
                option_text    = COALESCE(NULLIF($8,''), option_text),
                order_submission_id = $9::uuid,
                updated_by = 'sheetless-order', updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`,
        [sheetId, tabName, seq, JSON.stringify(merged), reviewerName, recipientName, p8, optText, orderSubmissionId]);
    } else {
      // 행 번호가 명시된 레거시 복구만 표 끝 append를 허용한다. 신규 무시트 접수는 위의
      // 준비 슬롯 선점만 사용하므로 모집 인원을 초과해 작업보드 행을 만들지 않는다.
      if (requestedSeq == null) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'no_open_slot' };
      }
      // 표 끝을 넘어 배정된 경우(append) — 그 자리에 줄을 만든다.
      //   ★ source='worktable' — `importTabFromIndex` 상태 CASE 가 인정하는 값(신규 값 금지).
      await client.query(
        `INSERT INTO campaign_participants
           (sheet_id, tab_gid, tab_name, seq, reviewer_name, recipient_name, phone8,
            option_text, order_submission_id, row_json, source, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10::jsonb,'worktable','sheetless-order',NOW())
         ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING`,
        [sheetId, gid || null, tabName, seq, reviewerName, recipientName, p8,
         optText || null, orderSubmissionId, JSON.stringify(merged)]);
    }
    /* ── 번호·담당자 자동 채움 + 구매일자 기준 재번호 ────────────────────────────
       ★ 이어붙인 줄은 `row_json` 이 비어 있어 `번호`·`담당자` 가 영구 빈칸으로 남았다
         (매퍼가 그 두 칸을 쓰지 않는다). 여기서 그 탭 전체를 구매일자 순으로 다시 매긴다.
       ★★ **DB `seq` 는 건드리지 않는다** — 표시 번호(`row_json`)만 바뀐다.
       ★★ SAVEPOINT 격리 + 절대 throw 없음 — 번호 때문에 주문 기록을 잃지 않는다. */
    await require('./rowNumbering.service')
      .renumberTabInTx(client, { sheetId, tabName, by: 'auto-order' });

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error(`[sheetlessOrder] 작업표 기록 실패 tab=${tabName} seq=${seq}: ${err.message}`);
    return { ok: false, reason: 'write_failed', message: err.message };
  } finally {
    client.release();
  }

  // ── 장부 3권 재생성 — 이래야 리뷰어 검색·리뷰내역·홈 통계가 즉시 따라온다 ──
  let ledger = null;
  try {
    ledger = await require('./sheetlessLedger.service').rebuildLedgers({ sheetId, tabName, by: 'sheetless-order' });
  } catch (err) {
    // ★ 여기 실패는 "표엔 있는데 검색은 안 되는" 상태 → 주문을 완결로 찍지 않는다(다음 재시도가 메운다).
    logger.error(`[sheetlessOrder] 장부 재생성 실패 tab=${tabName}: ${err.message}`);
    return { ok: false, reason: 'ledger_failed', message: err.message };
  }

  // ── 주문 완결 + 신원 링크 ───────────────────────────────────────────
  //   ★ 신원 기록은 **기록 성공 후에만**(시트 경로와 같은 규율 — 낙관적 선기입이 교차노출을 만들었다).
  //   ★ `last_sheet_write_sig` 는 남기지 않는다 → 시트 역동기화 탐지가 이 주문을 건드리지 않는다.
  try {
    await markOrderWritten(orderSubmissionId, seq);
  } catch (err) {
    logger.warn(`[sheetlessOrder] 완결 표시 실패(기록은 완료): ${err.message}`);
  }
  try {
    const { recordParticipationLink } = require('./participation.service');
    await recordParticipationLink({
      sheetId, tabName, rowIndex: seq, phone8: loginPhone8,
      phone: orderData.phone, name: loginName || orderData.orderer, source: 'sheetless_order' });
    await ledgerSvc.recordReviewIdentity({
      sheetId, tabName, tabGid: gid, rowIndex: seq, phone8: loginPhone8,
      phone: orderData.phone, name: loginName || orderData.orderer, recipient: orderData.recipient });
  } catch (err) {
    logger.warn(`[sheetlessOrder] 신원 링크 기록 실패(무시): ${err.message}`);
  }

  if (optionSuppressed.length) {
    logger.warn(`[sheetlessOrder] 옵션 칸 보존(blank-only) tab=${tabName} seq=${seq} ` +
      optionSuppressed.map(s => `${s.header}: "${s.cur}" 유지`).join(' · '));
  }

  /* ★ 기입할 옵션 칸이 아예 없으면 **소리 내어 알린다** — 조용히 사라지지 않게(2026-08-20).
     조치는 [⋯] → [🧩 옵션 열](칸 생성 + 소급 기입). 관측 실패가 완결을 막지 않는다. */
  if (optionUnmapped) {
    logger.warn(`[sheetlessOrder] ⚠️ 옵션 기입 칸 없음 — 리뷰어가 고른 옵션이 표에 안 들어감 ` +
      `tab=${tabName} seq=${seq} 선택="${optionUnmapped}" os=${orderSubmissionId}`);
    try {
      require('./errorLog.service').logAbnormal({
        flow: 'order_mirror', step: 'option_column_missing', severity: 'warn',
        error: new Error(`option column missing: "${optionUnmapped}"`),
        context: { sheetId, tabName, tabGid: gid, sheetRow: seq, orderSubmissionId },
      });
    } catch (_) { /* 관측 실패가 쓰기를 막지 않는다 */ }
  }

  logger.info(`[sheetlessOrder] 즉시 완결 tab=${tabName} seq=${seq} os=${orderSubmissionId}${recovered ? ' (복구)' : ''}`);
  return { ok: true, written: true, seq, ledger, optionSuppressed, optionUnmapped };
}

/**
 * 과거 첫 탈시트 배포 구간의 주문은 order_submissions에만 있고 작업보드 행이 없을 수 있다.
 * 이 복구는 그런 주문만 골라 이미 준비된 빈 작업보드 슬롯에 연결한다.
 * 외부 시트/GAS 호출은 전혀 하지 않으며, 각 행은 writeOrderToWorktable의 잠금으로 선점된다.
 */
/**
 * 전환 중 누락된 공고→작업보드 연결을, 사람이 입력한 제목이 아닌 이미 저장된
 * work-order 식별자로만 되살린다. 후보가 불명확하면 연결하지 않아 복구도 보류한다.
 */
async function reconcileCampaignWorktableLinks() {
  const db = getPool();
  const { rows } = await db.query(
    `WITH candidates AS (
       SELECT rc.id, wo.linked_tab_sheet_id, wo.linked_tab_name, wo.linked_tab_gid
         FROM recruit_campaigns rc
         JOIN work_orders wo
           ON (rc.source_work_order_id = wo.id OR wo.linked_campaign_id = rc.id)
        WHERE COALESCE(rc.linked_sheet_id, '') = ''
          AND COALESCE(rc.linked_tab_name, '') = ''
          AND wo.deleted_at IS NULL
          AND COALESCE(wo.linked_tab_sheet_id, '') <> ''
          AND COALESCE(wo.linked_tab_name, '') <> ''
          AND EXISTS (
            SELECT 1 FROM tab_configs tc
             WHERE tc.sheet_id = wo.linked_tab_sheet_id
               AND tc.tab_name = wo.linked_tab_name
               AND COALESCE(tc.sheetless, FALSE) = TRUE
          )
     )
     UPDATE recruit_campaigns rc
        SET linked_sheet_id = c.linked_tab_sheet_id,
            linked_tab_name = c.linked_tab_name,
            linked_tab_gid = COALESCE(c.linked_tab_gid, ''),
            updated_at = NOW()
       FROM candidates c
      WHERE rc.id = c.id
      RETURNING rc.id, rc.linked_sheet_id, rc.linked_tab_name, rc.linked_tab_gid`
  );
  return { linked: rows.length, items: rows };
}

/**
 * @param {number}  [o.limit=100]
 * @param {number|null} [o.sinceHours=null]  최근 N시간 내 제출분만(주기 잡용 폭발반경 제한).
 *   ★ null = 전체(사람이 부르는 수동 복구). 주기 잡은 반드시 창을 준다 — 옛 고아 주문까지
 *     자동으로 줄을 이어붙이면 8/18 중복 사고와 같은 대량 append 가 무인으로 일어난다.
 */
async function recoverUnwrittenSheetlessOrders({ limit = 100, sinceHours = null, by = 'sheetless-order-recovery' } = {}) {
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
  const win = (sinceHours == null) ? null : Math.min(Math.max(parseInt(sinceHours, 10) || 0, 1), 24 * 30);
  const links = await reconcileCampaignWorktableLinks();
  const { rows } = await db.query(
    `SELECT os.id, os.orderer, os.recipient, os.user_id, os.phone, os.address,
            os.bank, os.account, os.depositor, os.price, os.date_str, os.order_num,
            os.memo, os.selected_opt_key,
            ca.phone8 AS login_phone8, ca.owner_phone8, r.name AS login_name,
            rc.linked_sheet_id, rc.linked_tab_name, rc.linked_tab_gid
       FROM order_submissions os
       JOIN campaign_applications ca
         ON (os.campaign_application_id = ca.id
             OR ca.order_submission_id = os.id
             OR ca.late_order_id = os.id)
       JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
       LEFT JOIN reviewers r ON r.phone8 = COALESCE(ca.owner_phone8, ca.phone8)
      WHERE os.deleted_at IS NULL
        AND COALESCE(rc.linked_sheet_id, '') <> ''
        AND COALESCE(rc.linked_tab_name, '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM campaign_participants cp
           WHERE cp.order_submission_id = os.id AND cp.deleted_at IS NULL
        )
        AND ($2::int IS NULL OR os.submitted_at > NOW() - ($2 || ' hours')::interval)
      ORDER BY os.submitted_at ASC
      LIMIT $1`, [lim, win]);

  const result = { linked: links.linked, scanned: rows.length, sinceHours: win, written: 0, failed: 0, noOpenSlot: 0, items: [] };
  for (const row of rows) {
    let out;
    try {
      out = await writeOrderToWorktable({
        sheetId: row.linked_sheet_id, tabName: row.linked_tab_name, tabGid: row.linked_tab_gid || '',
        orderSubmissionId: row.id,
        loginPhone8: row.login_phone8 || row.owner_phone8 || '', loginName: row.login_name || row.orderer || '',
        recovered: true,
        orderData: {
          orderer: row.orderer, recipient: row.recipient, userId: row.user_id, phone: row.phone,
          address: row.address, bank: row.bank, account: row.account, depositor: row.depositor,
          price: row.price, dateStr: row.date_str, orderNum: row.order_num, memo: row.memo,
          selectedOptKey: row.selected_opt_key,
        },
      });
      if (out.ok) result.written++;
      else {
        result.failed++;
        if (out.reason === 'no_open_slot') result.noOpenSlot++;
        await require('./orderLedger.service').markOrderMirrorFailed(row.id, out.message || out.reason);
      }
    } catch (err) {
      out = { ok: false, reason: 'exception', message: err.message };
      result.failed++;
      await require('./orderLedger.service').markOrderMirrorFailed(row.id, err);
    }
    result.items.push({ orderSubmissionId: row.id, ok: !!out.ok, reason: out.reason || null, seq: out.seq || null });
  }
  logger.info(`[sheetlessOrder] 과거 작업보드 복구 by=${by} scanned=${result.scanned} written=${result.written} failed=${result.failed}`);
  return result;
}

/**
 * 작업보드 줄은 **이미 있는데** 원장만 미완결(`failed` 등)로 굳은 주문의 완결 표시를 정정한다.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 왜 필요한가 — `writeOrderToWorktable` 이 줄을 **커밋한 뒤** 장부 재생성(`ledger_failed`)이나
 *   예외로 빠지면 호출부가 그 주문을 `failed` 로 강등한다. 화면(작업보드·리뷰어 리뷰 내역)에는
 *   이미 보이는데 원장만 미완결이라 ① `order_unmirrored` 비정상로그가 계속 쌓이고
 *   ② 미반영 집계가 부풀어 **다음 진짜 사고를 가린다**. `campaign:*` 좌표는 큐 리컨실에서
 *   제외돼(orderLedger `NOT LIKE 'campaign:%'`) 스스로 풀릴 길이 없다.
 *
 * ★★ 판정 근거는 딱 하나 — **`campaign_participants.order_submission_id` 링크**.
 *   그 링크는 `writeOrderToWorktable` 이 **기록 성공 후에만** 남긴다(낙관적 선기입 금지 규율).
 *   즉 링크가 있다 = 그 주문이 실제로 그 줄에 반영됐다. 복구 잡이 "이미 반영됨"을 판정하는
 *   근거와 **같은 것**을 쓴다(사본 0).
 * ★ 소프트삭제된 줄(`deleted_at`)은 근거가 아니다 — [줄 정리]로 내린 줄이면 그 주문은
 *   반영된 게 아니다(그대로 미완결로 남겨 복구 잡이 다시 줄을 만들게 둔다).
 * ★★ 상태 화이트리스트(완화 금지) — `failed`·`pending`·`pending_no_row` 만.
 *   `canceled`(취소된 주문을 되살리면 안 됨) · `queued`(인플라이트) · `stuck_manual`(사람이
 *   수동 입력해야 하는 표시) · `conflict` 는 건드리지 않는다.
 * ★ 완결 표시는 `markOrderWritten` **단일 출처**로 한다(UPDATE 사본을 두면 `sheet_error`·
 *   `sheet_written_at` 처리가 갈린다).
 * ★ dryRun 기본 — 세어 보고 나서 사람이 실행한다.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * @returns {Promise<{scanned:number, repaired:number, dryRun:boolean, byStatus:object, items:Array}>}
 */
const REPAIRABLE_MIRROR_STATUSES = ['failed', 'pending', 'pending_no_row'];

async function repairWrittenMarkForBoardRows({ limit = 500, dryRun = true, by = 'mirror-repair' } = {}) {
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
  const { rows } = await db.query(
    `SELECT os.id, os.mirror_status, os.tab_name,
            (SELECT MIN(cp.seq) FROM campaign_participants cp
              WHERE cp.order_submission_id = os.id AND cp.deleted_at IS NULL) AS seq
       FROM order_submissions os
      WHERE os.deleted_at IS NULL
        AND os.sheet_id LIKE 'campaign:%'
        AND os.mirror_status = ANY($1::text[])
        AND EXISTS (SELECT 1 FROM campaign_participants cp
                     WHERE cp.order_submission_id = os.id AND cp.deleted_at IS NULL)
      ORDER BY os.submitted_at ASC
      LIMIT $2`, [REPAIRABLE_MIRROR_STATUSES, lim]);

  const byStatus = {};
  rows.forEach(r => { byStatus[r.mirror_status] = (byStatus[r.mirror_status] || 0) + 1; });
  const result = { scanned: rows.length, repaired: 0, dryRun: !!dryRun, byStatus, items: [] };
  if (dryRun) {
    result.items = rows.slice(0, 50).map(r => ({ orderSubmissionId: r.id, from: r.mirror_status, seq: r.seq }));
    return result;
  }

  const { markOrderWritten } = require('./orderLedger.service');
  for (const r of rows) {
    try {
      await markOrderWritten(r.id, r.seq);
      result.repaired++;
      result.items.push({ orderSubmissionId: r.id, from: r.mirror_status, seq: r.seq, ok: true });
    } catch (err) {
      logger.warn(`[sheetlessOrder] 완결 표시 정정 실패 os=${r.id}: ${err.message}`);
      result.items.push({ orderSubmissionId: r.id, from: r.mirror_status, ok: false, error: err.message });
    }
  }
  /* 원인이 사라진 리뷰어 비정상로그(`order_unmirrored`)는 그 함수가 스스로 정리한다 — 사본 0. */
  try { await require('./reviewerEventLog.service').autoResolveHealed(); } catch (_) { /* fail-soft */ }
  logger.info(`[sheetlessOrder] 완결 표시 정정 by=${by} scanned=${result.scanned} repaired=${result.repaired}`);
  return result;
}

module.exports = {
  writeOrderToWorktable,
  repairWrittenMarkForBoardRows,
  REPAIRABLE_MIRROR_STATUSES,
  reconcileCampaignWorktableLinks,
  recoverUnwrittenSheetlessOrders,
  buildRowPatch,
  _isPastOrderWindow,
  __setPoolForTest,
};
