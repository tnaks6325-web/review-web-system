/**
 * worktableOptionColumn.service.js — 무시트 작업표에 **옵션 열**을 보장한다 (2026-08-20)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★ 사고(8/20 「8/20(네이버)선물세트 3종 빈박스」): 리뷰어가 참여할 때 옵션 3종 중 하나를
 *   골랐고 그 값은 `campaign_applications.option_key` → `order_submissions.selected_opt_key`
 *   까지 **정상 저장**됐는데, 작업표에 **옵션 칸이 없어** 아무 데도 기입되지 않았다.
 *   매퍼(`mapOrderToSheetRow`)는 헤더에 '옵션'이 든 칸에만 쓰고, 그 칸이 없으면 값을
 *   `null` 로 떨어뜨린다 — **경고도 로그도 없이** 사라진다.
 *
 *   왜 칸이 없었나: 작업표 열 구성(`worktablePlan.buildColumns`)은 **작업오더의
 *   `product_options_json`** 만 본다. **공고 옵션(`campaign_options`)은 참조하지 않는다.**
 *   그래서 "작업오더엔 옵션이 없고 공고에만 옵션이 있는" 작업은 옵션 칸 없이 만들어졌고,
 *   `no_option_column` 경고조차 뜨지 않았다(그 경고는 오더발 배분이 있을 때만).
 *
 * ★★ 이 서비스가 하는 일 = **칸을 만들고, 이미 들어온 주문의 선택값을 소급 기입**한다.
 *   ① 창구(관리자 [🧩 옵션 열]) — 지금 진행 중인 작업 복구
 *   ② 공고 저장 시 자동 호출 — 옵션 2종 이상 공고의 연결 작업표에 칸을 보장(재발 방지)
 *
 * ★★ 완화 금지 규율
 *   · **무시트 탭 전용**(fail-closed) — 시트 기반 탭의 열은 시트가 정한다. 여기서 헤더를
 *     바꾸면 다음 미러가 시트 값으로 되돌려 놓고, 그 사이 장부만 갈라진다.
 *   · **판정 사본 0** — "옵션 기입 칸인가"는 `orderLedger.optionWriteColumns`(매퍼 파생),
 *     "리뷰옵션인가"는 `reviewType.isReviewOptionHeader`, 넣을 자리는 `classifyHeaders`
 *     (worktableTemplate)가 정한다. 여기서 '옵션' 키워드 표를 다시 만들면 `옵션금액`
 *     (=결제금액)·`비고(옵션확인)` 을 오분류한다.
 *   · **기입은 blank-only** — 이미 값이 있는 칸(관리자 작업지시 '텍스트'·'포토리뷰')은
 *     절대 덮지 않는다(C′ 규율 그대로).
 *   · **소급 값도 매퍼가 정한다** — `mapOrderToSheetRow` 를 새 헤더로 한 번 돌려 그 칸에
 *     들어갈 값을 읽는다(`|` 다중 옵션 분해까지 앞으로의 쓰기와 한 글자도 같다).
 *   · **미리보기 기본**(`dryRun`) — 실행은 명시 요청일 때만.
 *
 * ★★★ **"옵션이 있는 작업" = 살아있는 공고 옵션이 있는 작업** (2026-08-20 운영 실측으로 추가)
 *   운영 전수 점검에서 옵션 칸이 없는 무시트 탭 5개(521줄)가 소급 대상으로 잡혔는데, 그 값이
 *   **상품옵션이 아니었다** — 상품명 전문 · 상품 URL 조각 · 리뷰형태('텍스트') ·
 *   `포토|리뷰 본문 전체|11번가` 같은 다른 폼의 값이 `selected_opt_key` 에 남아 있었다
 *   (전부 살아있는 공고 옵션 0개 = 옵션 없는 작업). 그대로 넣었으면 800건 작업 419줄에
 *   상품명이 박혔다 — **막으려던 소실보다 큰 오염**이다.
 *   → ① 살아있는 옵션이 없는 탭은 **거부**(`no_live_options`) — 옵션 없는 작업엔 칸도 만들지 않는다.
 *     ② 기입은 **그 공고의 옵션 목록에 있는 값만**(`skippedNotAnOption` 으로 건수를 말한다).
 *   ★ 완화 금지 — 숫자만 보고 누르는 사람을 막는 것이 이 게이트의 존재 이유다.
 *
 * ★ 쓰기 표면 = `raw_sheet_tabs.headers/detected_headers` + `campaign_participants.row_json`
 *   두 곳뿐. 주문 원장·정원·홀드·시트는 무접촉(구글 API 호출 0).
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { isReviewOptionHeader } = require('../utils/reviewType');
const { classifyHeaders } = require('../utils/worktableTemplate');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

/** 새로 만들 옵션 칸 이름 — 매퍼가 '옵션' 포함 헤더에 기입한다(그 규칙과 같은 이름). */
const OPTION_HEADER = '옵션';

class OptionColumnError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * 그 헤더 목록에 **상품옵션 기입 칸**이 있는가.
 * ★ 리뷰옵션(㉯ 작업옵션=리뷰형태) 칸은 제외 — 상품옵션 기입처가 아니다(worktablePlan 과 같은 판정).
 * @returns {number[]} 옵션 기입 칸 인덱스
 */
function productOptionColumns(headers) {
  const { optionWriteColumns } = require('./orderLedger.service');
  return optionWriteColumns(headers || [])
    .filter(i => !isReviewOptionHeader((headers || [])[i]));
}

/**
 * 옵션 칸을 넣을 자리 — 자동 열(번호·구매일자) **바로 뒤**.
 * ★ 작업지시 칸은 앞쪽(worktablePlan 의 front 규칙·리뷰옵션 자동 추가와 같은 자리).
 */
function optionInsertIndex(headers) {
  const cls = classifyHeaders(headers || [], {});
  let at = 0;
  while (at < cls.length && cls[at].tier === 'auto') at++;
  return at;
}

/** 헤더 목록에 옵션 칸을 끼워 넣은 새 목록(순수함수). 이미 있으면 그대로 돌려준다. */
function withOptionColumn(headers) {
  const list = (headers || []).map(h => String(h == null ? '' : h));
  if (productOptionColumns(list).length) return { headers: list, added: false, index: -1 };
  const at = optionInsertIndex(list);
  const next = list.slice(0, at).concat([OPTION_HEADER], list.slice(at));
  return { headers: next, added: true, index: at };
}

/** 옵션명 비교 정규화 — 공백 차이·대소문자로 정상 값을 놓치지 않는다(판정은 여전히 정확일치). */
function normOptKey(v) { return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase(); }

/**
 * 그 탭에 연결된 공고들의 **살아있는 옵션 목록**(status <> 'closed').
 * ★ 연결은 이름 → gid 폴백(탭 리네임으로 연결이 조용히 풀리면 옵션 작업이 "옵션 없음"이 된다).
 * ★ 빈 gid 는 절을 켜지 않는다(켜면 gid 없는 공고가 전부 매칭된다 — 레포 규율).
 * ★ 차수 재발행으로 공고가 여럿이면 **합집합**(어느 차수의 옵션이든 그 표에 적힌 적이 있다).
 */
async function liveOptionKeys(db, { sheetId, tabName, tabGid }) {
  const { rows } = await db.query(
    `SELECT DISTINCT o.opt_key
       FROM recruit_campaigns c
       JOIN campaign_options o ON o.campaign_id = c.id
      WHERE c.linked_sheet_id = $1
        AND (c.linked_tab_name = $2 OR ($3 <> '' AND c.linked_tab_gid = $3))
        AND COALESCE(o.status, 'active') <> 'closed'`,
    [sheetId, tabName, String(tabGid || '')]);
  return rows.map(r => String(r.opt_key || '')).filter(Boolean);
}

/** 그 헤더 구성에서 주문의 옵션값이 어느 칸에 무엇으로 들어가는가 — **매퍼가 정한다**(사본 0). */
function optionCellValues(headers, selectedOptKey) {
  const { mapOrderToSheetRow } = require('./orderLedger.service');
  const mapped = mapOrderToSheetRow(headers || [], { selectedOptKey: selectedOptKey || '' });
  const out = new Map();                       // 헤더명 → 값
  productOptionColumns(headers).forEach(i => {
    const v = mapped[i];
    if (typeof v === 'string' && v.trim()) out.set(String((headers || [])[i]), v);
  });
  return out;
}

/**
 * 무시트 작업표에 옵션 칸을 보장하고, 이미 들어온 주문의 선택 옵션을 소급 기입한다.
 *
 * @param {object} o
 * @param {string} o.sheetId · o.tabName
 * @param {boolean} [o.dryRun=true]   미리보기(쓰기 0)
 * @param {boolean} [o.backfill=true] 기존 주문 선택값 소급 기입
 * @param {string}  [o.by='system']
 * @returns {Promise<object>} 요약 — 무엇을 했는지 화면이 그대로 말할 수 있는 모양
 */
async function ensureOptionColumn({ sheetId, tabName, dryRun = true, backfill = true, by = 'system' } = {}) {
  if (!sheetId || !tabName) throw new OptionColumnError('bad_request', 'sheetId, tabName 필수');
  const db = getPool();

  // ── 게이트: 등록된 무시트 탭에서만 (fail-closed) ──
  const { rows: tc } = await db.query(
    `SELECT tab_gid, COALESCE(sheetless, FALSE) AS sheetless
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
  if (!tc.length) throw new OptionColumnError('tab_not_registered', '등록되지 않은 탭입니다(접수 후 이용).');
  if (!tc[0].sheetless) {
    throw new OptionColumnError('not_sheetless',
      '시트 기반 탭입니다 — 열은 구글시트가 정합니다. 시트에 옵션 칸을 추가하세요.');
  }
  const tabGid = String(tc[0].tab_gid || '');

  // ── 지금 열 구성 = 장부 헤더(무시트 탭은 이 값이 곧 작업표 열) ──
  const { rows: rt } = await db.query(
    `SELECT detected_headers, headers FROM raw_sheet_tabs
      WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1`, [sheetId, tabGid]);
  const { resolveHeaders } = require('./sheetlessLedger.service');
  const { rows: parts } = await db.query(
    `SELECT seq, row_json, order_submission_id FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
      ORDER BY seq`, [sheetId, tabName]);
  const { headers: cur } = resolveHeaders({
    storedHeaders: rt[0] && (rt[0].detected_headers || rt[0].headers),
    columns: null, rows: parts,
  });
  if (!cur.length) {
    throw new OptionColumnError('no_headers',
      '열 구성을 알 수 없습니다 — 작업표를 먼저 만들거나 [작업표 재구성]을 실행하세요.');
  }

  const { headers: next, added, index } = withOptionColumn(cur);

  /* ★★★ 게이트 — 살아있는 공고 옵션이 있어야 "옵션이 있는 작업"이다(위 주석의 실측 근거).
     조회 실패도 거부한다(fail-closed — 모르는 채로 표에 값을 박지 않는다). */
  let liveKeys = null;
  try { liveKeys = await liveOptionKeys(db, { sheetId, tabName, tabGid }); }
  catch (e) {
    throw new OptionColumnError('live_options_unknown',
      '연결 공고의 옵션을 확인하지 못했습니다 — 확인 전에는 표에 값을 넣지 않습니다.');
  }
  /* ★ 여기는 1종 이상이면 허용한다(공고 저장 훅은 배분 의미가 있는 2종 이상일 때만 부른다) —
     옵션 1종이면 리뷰어가 자동 선택하고 그 값이 곧 정답이라 표에 적는 것이 맞다. */
  if (!liveKeys.length) {
    throw new OptionColumnError('no_live_options',
      '이 작업에 연결된 공고에 살아있는 옵션이 없습니다 — 옵션이 없는 작업이라 옵션 칸을 만들지 않습니다. '
      + '(주문 원장에 남은 값은 상품명·URL·리뷰형태 등 다른 경로에서 온 값일 수 있습니다.)');
  }
  const liveSet = new Set(liveKeys.map(normOptKey));

  // ── 소급 기입 대상 — 링크된 주문의 선택 옵션(blank-only) ──
  const plan = [];
  let noOrder = 0, alreadyFilled = 0, notOption = 0;
  if (backfill) {
    const ids = [...new Set(parts.map(p => p.order_submission_id).filter(Boolean).map(String))];
    let optByOrder = new Map();
    if (ids.length) {
      const { rows: ords } = await db.query(
        `SELECT id, selected_opt_key FROM order_submissions
          WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
            AND COALESCE(selected_opt_key, '') <> ''`, [ids]);
      optByOrder = new Map(ords.map(o => [String(o.id), o.selected_opt_key]));
    }
    for (const p of parts) {
      const key = p.order_submission_id ? optByOrder.get(String(p.order_submission_id)) : null;
      if (!key) { noOrder++; continue; }
      const rj = (p.row_json && typeof p.row_json === 'object') ? p.row_json : {};
      const patch = {};
      let notAnOption = false;
      for (const [h, v] of optionCellValues(next, key)) {
        /* ★★ 그 공고의 옵션 목록에 없는 값은 **넣지 않는다** — 상품명 전문·URL·리뷰형태가
           `selected_opt_key` 에 남아 있는 탭이 실제로 있다(운영 실측). */
        if (!liveSet.has(normOptKey(v))) { notAnOption = true; continue; }
        // ★ blank-only — 관리자가 적어 둔 작업지시를 덮지 않는다.
        const now = String(rj[h] == null ? '' : rj[h]).trim();
        if (now) continue;
        patch[h] = v;
      }
      if (!Object.keys(patch).length) { notAnOption ? notOption++ : alreadyFilled++; continue; }
      plan.push({ seq: p.seq, optKey: key, patch });
    }
  }

  const summary = {
    ok: true, sheetId, tabName, tabGid,
    headerName: OPTION_HEADER,
    headerAdded: added, insertIndex: added ? index : -1,
    alreadyHadColumn: !added,
    headers: next,
    liveOptionKeys: liveKeys,
    backfillCount: plan.length,
    skippedNoOrderOption: noOrder,
    skippedAlreadyFilled: alreadyFilled,
    skippedNotAnOption: notOption,
    rows: plan.slice(0, 50).map(p => ({ seq: p.seq, optKey: p.optKey })),
    rowsTruncated: Math.max(0, plan.length - 50),
  };
  if (dryRun) return { ...summary, dryRun: true };
  if (!added && !plan.length) return { ...summary, dryRun: false, noop: true };

  // ── 실행: 헤더 + row_json 두 곳만 쓴다 ──
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 장부 재생성과 **같은 락** — 재생성 도중 헤더가 바뀌면 표가 한 칸씩 밀린다.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sheetless_ledger:${sheetId}:${tabName}`]);
    if (added) {
      const { rowCount } = await client.query(
        `UPDATE raw_sheet_tabs
            SET headers = $3::jsonb, detected_headers = $3::jsonb, col_count = $4
          WHERE sheet_id = $1 AND tab_gid = $2`,
        [sheetId, tabGid, JSON.stringify(next), next.length]);
      // 장부 행이 아직 없는 탭(작업표만 만들어 둔 경우)은 아래 재생성이 열 구성을 만든다.
      if (!rowCount) logger.warn(`[optionColumn] raw_sheet_tabs 행 없음 — 재생성이 헤더를 만든다 ${sheetId}/${tabName}`);
    }
    for (const p of plan) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3 AND deleted_at IS NULL`,
        [sheetId, tabName, p.seq, JSON.stringify(p.patch)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }

  // ── 장부 3권 재생성 — 새 열·새 값이 검색 명단·행배정 재료에 반영된다 ──
  let rebuilt = null, rebuildError = null;
  try {
    const { rebuildLedgers } = require('./sheetlessLedger.service');
    // 장부 행이 없던 탭도 열 구성을 넘겨 첫 생성이 되게 한다(stored 가 있으면 그쪽이 이긴다).
    rebuilt = await rebuildLedgers({ sheetId, tabName, columns: next, dryRun: false, by: `optioncol:${by}` });
  } catch (e) {
    rebuildError = (e && e.message) || String(e);
    logger.warn(`[optionColumn] 장부 재생성 실패 ${sheetId}/${tabName}: ${rebuildError}`);
  }

  logger.info(`[optionColumn] ${sheetId}/${tabName} 열추가=${added} 소급=${plan.length} by=${by}`);
  return { ...summary, dryRun: false, rebuilt, rebuildError };
}

module.exports = {
  ensureOptionColumn,
  liveOptionKeys,
  normOptKey,
  productOptionColumns,
  withOptionColumn,
  optionInsertIndex,
  optionCellValues,
  OPTION_HEADER,
  OptionColumnError,
  __setPoolForTest,
};
