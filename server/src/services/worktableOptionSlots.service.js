'use strict';
/**
 * worktableOptionSlots — 결정 394(RW-A2 · RW-D · 사용자 확정 2026-11-22 q5): 양방향 공유 저장에서 **선택지별 인원이 실제로 바뀌면**
 *   작업보드 「손 안 댄 빈 줄」의 옵션 표시를 새 인원에 맞춰 다시 나눈다.
 *
 * ★★ 짝 규칙은 새로 만들지 않는다(사용자 답 1 · 레드 H1·H2):
 *   - 빈 줄 ↔ 선택지 = **주문이 실제로 줄을 고르는 규칙** — 옵션 단위 `option_text = opt_key`(주문 줄 고르기 SQL 과 같은 원문 일치)
 *     + v2 「상품 · 옵션」 표식(`sheetlessOrder.stagedSlotRows`) / 상품 단위 = 줄 계획(`planOf` 순서: 표식 → 손 글씨 → 상품 칸)
 *     + `sheetlessOrder.resolveProductLabel`(정확히 하나 · 포함 관계). 상품명과 옵션명이 전혀 달라도(티셔츠 / 블루·라지) 정상.
 *   - 채운 줄 ↔ 선택지 = **정원 셈 규칙** — 그 공고 신청의 option_key → 없으면 `campaignState.matchOrderOption`(바로 구매를 세는 함수 · 같은 입력).
 * ★★ 맞출 수 없으면 **통째로 건너뛴다**(일부 옵션만 옮기기 금지) — 저장은 그대로 성공하고 결과 칸·공고 계획 기록으로 알린다(사용자 답 1·4).
 * ★★ 사람 기록이 달린 줄은 옮기지 않는다 — 결정 254 표 분류 전수(ROW_RECORD_TABLES / TAB_LEVEL_TABLES · 가드) + row_json 의 계획 칸 밖 값 + 제출·입금 표시.
 * ★ 칸 규칙(H10) — `campaignOptionRename.relabelRowCells`(같은 글자인 칸만 · 빈 칸은 빈 칸) · 상품 칸에 다른 계획 상품이 남는 모양이면 옮기지 않는다.
 * ★ 호출 = 같은 트랜잭션 · 공고 옵션 줄 인원을 쓴 뒤 · 줄 수 맞추기 뒤. 탭 잠금은 호출부가 먼저 잡고, 못 잡았으면 여기서 기다리지 않고 시도만 한다(교착 0).
 * ★ 예외는 SAVEPOINT 로 되돌리고 `check_failed` 로 돌려준다 — 이 기능 때문에 저장이 실패하지 않는다(사용자: 저장은 됨). 끄는 스위치 `WORKTABLE_OPTION_REBALANCE=0`.
 */
const { logger } = require('../utils/logger');

/* ── 결정 254 표 분류(workTabDelete DELETE/MONEY/KEEP) 전수 — 줄 단위 사람 기록인가 ────────────────────
   SQL 자리표시자: $1 sheet · $2 tab · $3 줄 id(text[]) · $4 줄 번호(int[]) · $5 identity_key(text[]). 돌려주는 k = 'id:…' | 'seq:…' | 'idk:…'.
   ★ 254 목록에 새 표가 생기면 여기 둘 중 하나로 분류해야 가드(optionSlotsRebalance.test)가 초록이다. */
const _anchorSql = (t, extra = '') => `SELECT (CASE WHEN anchor_type = 'manual' THEN 'id:' ELSE 'idk:' END) || anchor_value AS k FROM ${t}
   WHERE sheet_id = $1 AND tab_name = $2 ${extra} AND ((anchor_type = 'manual' AND anchor_value = ANY($3::text[])) OR (anchor_type = 'identity' AND anchor_value = ANY($5::text[])))`;
const _seqSql = (t, col, extra = '') => `SELECT 'seq:' || ${col}::text AS k FROM ${t} WHERE sheet_id = $1 AND tab_name = $2 AND ${col} = ANY($4::int[]) ${extra}`;
const ROW_RECORD_TABLES = {
  participant_edits: _anchorSql('participant_edits', 'AND reverted_at IS NULL'),
  trackb_cell_colors: _anchorSql('trackb_cell_colors'),
  trackb_custom_columns: `SELECT (CASE WHEN v.anchor_type = 'manual' THEN 'id:' ELSE 'idk:' END) || v.anchor_value AS k
     FROM trackb_custom_column_values v JOIN trackb_custom_columns c ON c.id = v.column_id
    WHERE c.sheet_id = $1 AND c.tab_name = $2 AND btrim(COALESCE(v.value_text, '')) <> ''
      AND ((v.anchor_type = 'manual' AND v.anchor_value = ANY($3::text[])) OR (v.anchor_type = 'identity' AND v.anchor_value = ANY($5::text[])))`,
  manual_payment_marks: _anchorSql('manual_payment_marks'),
  payment_batch_items: _seqSql('payment_batch_items', 'row_index'),
  payment_records: _seqSql('payment_records', 'row_index'),
  unconfirmed_transfer_reviews: _seqSql('unconfirmed_transfer_reviews', 'participant_row_index'),
  review_submissions: _seqSql('review_submissions', 'row_index'),
  review_inspections: _seqSql('review_inspections', 'row_index'),
  review_edit_requests: _seqSql('review_edit_requests', 'row_index'),
  review_reminder_states: _seqSql('review_reminder_states', 'row_index'),
  participation_links: _seqSql('participation_links', 'row_index'),
  sheet_row_claims: _seqSql('sheet_row_claims', 'sheet_row'),
  slot_locks: _seqSql('slot_locks', 'row_number'),
  reverse_sync_proposals: _seqSql('reverse_sync_proposals', 'sheet_row'),
  workdesk_participant_deletions: _seqSql('workdesk_participant_deletions', 'seq'),
  order_submissions: _seqSql('order_submissions', 'sheet_row', 'AND deleted_at IS NULL'),
  workdesk_review_resolutions: `SELECT 'id:' || participant_id::text AS k FROM workdesk_review_resolutions WHERE sheet_id = $1 AND tab_name = $2 AND participant_id::text = ANY($3::text[])`,
  manual_message_sends: `SELECT 'id:' || participant_id::text AS k FROM manual_message_sends WHERE sheet_id = $1 AND tab_name = $2 AND participant_id::text = ANY($3::text[])`,
  reviewer_participations: `SELECT 'id:' || campaign_participant_id::text AS k FROM reviewer_participations
    WHERE sheet_id = $1 AND tab_name = $2 AND campaign_participant_id::text = ANY($3::text[]) AND (owner_reviewer_id IS NOT NULL OR order_submission_id IS NOT NULL)`,
  review_photo_relinks: `SELECT 'seq:' || x::text AS k FROM review_photo_relinks, LATERAL (VALUES (from_row), (to_row)) AS v(x)
    WHERE sheet_id = $1 AND tab_name = $2 AND x = ANY($4::int[])`,
};
/** 줄 단위가 아닌 표(탭 단위 설정·장부·로그·주소) — 왜 빼는지 한 줄. */
const TAB_LEVEL_TABLES = {
  campaign_participants: '줄 자체(판정 대상)',
  qna_slots: 'Q&A 작업은 다시 나누기 해당 없음(isQnaTab)',
  booking_slots: '예약리뷰 작업은 다시 나누기 해당 없음(isBookingTab)',
  receipt_pool: '영수증리뷰 작업은 다시 나누기 해당 없음(isReceiptPoolTab)',
  review_report_links: '탭 단위 보고 주소', review_index: '장부(줄에서 다시 만든다)', review_index_archive: '장부 보관본',
  index_master: '탭 단위 색인', index_master_archive: '탭 단위 색인 보관본', raw_sheet_rows: '장부 미러(줄에서 다시 만든다)', raw_sheet_tabs: '탭 단위 미러',
  parity_snapshots: '탭 단위 점검 기록', reviewer_event_logs: '탭 단위 이벤트 로그', tab_column_mappings: '열 구성', tab_status_column_bindings: '열 구성',
  unrecognized_tabs: '탭 단위', short_links: '탭 단위 주소', trackb_thread_seen: '탭 단위', trackb_tab_threads: '탭 단위 대화', trackb_tab_memos: '탭 단위 메모',
  trackb_tab_closeouts: '탭 단위 마감', trackb_tab_finished: '탭 단위 완료', trackb_tab_daily_done: '탭 단위 날짜 완료', trackb_settlement_links: '탭 단위 정산 연결',
  trackb_work_order_links: '탭 단위 오더 연결', trackb_brand_tab_map: '탭 단위 브랜드', trackb_tab_brand_managers: '탭 단위 브랜드 담당자', trackb_share_links: '탭 단위 공유 주소', trackb_advertiser_work_links: '탭 단위 업체 단축 주소',
  tab_configs: '탭 등록행', orphan_capture_tombstones: '줄 좌표 없음(캡처 파일 묘비)', workboard_consolidation_link_events: '탭 단위 통폐합 기록', workboard_consolidation_targets: '탭 단위 통폐합 상태',
};

/* ── 안내 문구(인트라넷 저장 결과 알림 · 시안 「안 가」) — 「없습니다·실패·초과·불가·오류」 낱말 금지(알림 색이 낱말로 정해진다 · 가드)
 *   말투는 합니다체 하나(「~어요」 섞임 금지) · 옵션 이름 뒤 조사는 utils/koreanParticle(받침·숫자·대문자 약자 · 모르면 「<이름> 옵션은」).
 *   시안의 「짝지을 수 없습니다」「붙일 수 없습니다」는 금지 낱말 「없습니다」를 품어 「짝짓지 못했습니다」「붙이지 못했습니다」로 쓴다. ── */
const { withTopic } = require('../utils/koreanParticle');
const NOTICE_HEAD = '작업보드 빈 줄의 옵션 표시는 그대로입니다 — ';
const NOTICE_TAIL = ' 필요하면 리뷰웹 작업보드에서 직접 고쳐주세요.';
const REASON_TEXT = {
  shared_worktable: () => '이 작업보드를 여러 모집공고가 함께 쓰고 있습니다.',
  filled_unattributed: () => '이미 채운 줄 가운데 어느 옵션 몫인지 정해지지 않은 줄이 있습니다.',
  label_unmatched: () => '줄 표시를 새 옵션과 짝짓지 못했습니다.',
  label_ambiguous: () => '한 줄의 표시가 여러 옵션에 걸려 어느 옵션인지 정하지 못했습니다.',
  over_target: d => {
    const who = d && withTopic(d.option);
    return who ? `${who} 이미 채우거나 손댄 줄(${d.fixed}줄)이 새 인원(${d.target}명)보다 많습니다.` : '이미 채우거나 손댄 줄이 새 인원보다 많은 옵션이 있습니다.';
  },
  total_mismatch: d => (d ? `작업보드 줄 수(${d.rows}줄)와 옵션별 인원 합(${d.sum}명)이 다릅니다.` : '작업보드 줄 수와 옵션별 인원 합이 다릅니다.'),
  row_cells_unknown: () => '옮길 줄의 상품·옵션 칸에 다른 값이 적혀 있습니다.',
  busy: () => '그때 작업보드가 다른 저장을 처리하는 중이었습니다.',
};
/* busy 다음 행동 — 「다시 저장」이 아니다: 다시 나누기는 옵션별 인원이 바뀐 저장에서만 돌아(sharedPatch rebalanceWanted)
   같은 인원으로 다시 저장해도 안 돈다(막다른 길). 잠시 뒤 작업보드를 보고 직접 고치게 한다. */
const TAIL_FOR = { busy: ' 잠시 뒤 리뷰웹 작업보드에서 확인하고 필요하면 직접 고쳐주세요.' };
const MIX_TEXT = '리뷰타입을 섞어 쓰는 작업이라 일부 빈 줄에 표시를 붙이지 못했습니다.';
/* 인트라넷 일반 문구(리뷰웹 답이 불분명할 때 · 인트라넷 api.ts reviewOrderOptionSlotsView 의 fallback)와 같은 뜻 = 같은 글자 */
const CHECK_FAILED_TEXT = '작업보드 빈 줄의 옵션 표시를 맞췄는지 확인하지 못했습니다 — 리뷰웹 작업보드에서 한 번 봐 주세요.';
function noticeFor(reason, detail, { reviewMix = false } = {}) {
  if (reason === 'check_failed') return CHECK_FAILED_TEXT;
  const f = REASON_TEXT[reason];
  if (!f) return CHECK_FAILED_TEXT;
  const why = reviewMix && ['label_unmatched', 'row_cells_unknown', 'label_ambiguous'].includes(reason) ? MIX_TEXT : f(detail);
  return NOTICE_HEAD + why + (TAIL_FOR[reason] || NOTICE_TAIL);
}

const _t = v => String(v == null ? '' : v).trim();
const _q = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

const _memo = new Map();
/** 같은 열 구성은 한 번만 계산(큰 작업보드 성능 — 줄마다 매퍼를 다시 돌리지 않는다) */
function _byHeads(kind, heads, fn) {
  const k = kind + '\u0001' + heads.join('\u0001');
  if (!_memo.has(k)) { if (_memo.size > 500) _memo.clear(); _memo.set(k, fn(heads)); }
  return _memo.get(k);
}
/** 줄의 계획 칸 판정 재료 — 결정 227 단일 출처(planCellHeaders) + 번호·날짜 칸. 그 밖 칸에 값이 있으면 사람이 쓴 칸으로 본다. */
function _systemCells(heads) { return _byHeads('sys', heads, _systemCellsRaw); }
function _systemCellsRaw(heads) {
  const { planCellHeaders } = require('../utils/worktablePlan');
  const { classifyHeaders } = require('../utils/worktableTemplate');
  const { findDateColumnIndex } = require('./campaignSchedule.service');
  const set = new Set(planCellHeaders(heads));
  for (const c of classifyHeaders(heads)) if (c.role === 'seq') set.add(heads[c.index]);
  const di = findDateColumnIndex(heads);
  if (di >= 0) set.add(heads[di]);
  return set;
}
function _humanCells(rj) {
  const heads = Object.keys(rj || {});
  if (!heads.length) return false;
  const sys = _systemCells(heads);
  return heads.some(h => !sys.has(h) && _t(rj[h]) !== '');
}

/** 고르게 섞인 차례 — counts(Map key→n) 를 합만큼 한 칸씩(가장 많이 남은 비율 먼저 · 같은 값은 앞 순서). */
function _interleave(entries) {
  const list = entries.filter(([, c]) => c > 0);
  const total = list.reduce((a, [, c]) => a + c, 0);
  const cur = new Map(list.map(([k]) => [k, 0])); const left = new Map(list);
  const out = [];
  for (let i = 0; i < total; i++) {
    let best = null;
    for (const [k, c] of list) { if (!left.get(k)) continue; cur.set(k, cur.get(k) + c); if (best === null || cur.get(k) > cur.get(best)) best = k; }
    cur.set(best, cur.get(best) - total); left.set(best, left.get(best) - 1); out.push(best);
  }
  return out;
}
/** n 개 가운데 r 개를 띄엄띄엄(날짜가 한쪽으로 몰리지 않게) 고른 위치. */
function _spread(n, r) { const out = new Set(); for (let j = 0; j < r; j++) out.add(Math.min(n - 1, Math.floor(((j + 0.5) * n) / r))); return out; }

/**
 * 순수 판정·계획 — DB 없이 돈다(가드가 직접 부른다).
 * @param ctx.opts   공고 옵션 줄(삭제 아님) [{opt_key, product_name, unit_kind, recruit_total, status}]
 * @param ctx.rows   활성 줄(번호 순) [{id, seq, option_text, row_json, filled:boolean, protected:boolean, overlay?:string|null}]
 * @param ctx.filledKey Map(줄 id → opt_key | null) — 채운 줄의 정원 셈 귀속
 * @returns {{status, reason?, detail?, moves?, options?}}
 */
function planOptionSlots({ opts, rows, filledKey, classifyOnly = false }) {
  const so = require('./sheetlessOrder.service');
  const { PRODUCT_HEADER } = require('./orderLedger.service');
  const { parseSelectionKey } = require('./productOptions.service');
  const ol = require('./orderLedger.service');
  const optionWriteColumns = heads => _byHeads('opt', heads, ol.optionWriteColumns);
  const productWriteColumns = heads => _byHeads('prod', heads, ol.productWriteColumns);
  const { relabelRowCells, stagedComponentColumns } = require('./campaignOptionRename.service');
  const isProd = o => String(o.unit_kind || '') === 'product';
  const hasProd = opts.some(isProd);
  const prodCell = r => _t(((r.row_json || {})[PRODUCT_HEADER]));
  // 주문 쪽 planOf(상품 단위) 와 같은 순서: 표식 → 손 글씨 → 상품 칸
  const planP = (r, ot = r.option_text, rj = r.row_json) => _t(ot) || (r.overlay != null ? _t(r.overlay) : _t(((rj || {})[PRODUCT_HEADER])));

  /** 주어진 줄 상태에서 빈 줄마다 짝 선택지 목록 — 주문 줄 고르기 규칙 그대로 */
  const ownersFn = (state) => {
    const allLabels = [...new Set([
      ...state.map(s => _t(s.ot)).filter(Boolean),
      ...state.filter(s => !s.filled).map(s => planP(s.r, s.ot, s.rj)).filter(Boolean)])];
    const pk = new Map(opts.filter(isProd).map(o => [o.opt_key, so.resolveProductLabel(_t(o.product_name) || o.opt_key, allLabels)]));
    const staged = state.filter(s => !s.filled).map(s => ({ id: s.r.id, option_text: s.ot }));
    const stagedSets = new Map(opts.filter(o => !isProd(o)).map(o => [o.opt_key, new Set(so.stagedSlotRows(staged, o.opt_key, _t(o.product_name)).map(x => String(x.id)))]));
    return s => opts.filter(o => (isProd(o)
      ? !!pk.get(o.opt_key) && planP(s.r, s.ot, s.rj) === pk.get(o.opt_key)
      : (s.ot != null && String(s.ot) === o.opt_key) || stagedSets.get(o.opt_key).has(String(s.r.id)))).map(o => o.opt_key);
  };
  const state0 = rows.map(r => ({ r, ot: r.option_text, rj: r.row_json || {}, filled: !!r.filled }));
  const ownersOf = ownersFn(state0);
  const labelled = s => !!_t(s.ot) || (hasProd && !!planP(s.r, s.ot, s.rj));
  if (!state0.some(labelled)) return { status: 'not_applicable', reason: 'no_labels' };

  const optByKey = new Map(opts.map(o => [o.opt_key, o]));
  const T = new Map(opts.map(o => [o.opt_key, _q(o.recruit_total)]));
  const filled = new Map(opts.map(o => [o.opt_key, 0]));
  const fixedEmpty = new Map(opts.map(o => [o.opt_key, 0]));
  const own = new Map(opts.map(o => [o.opt_key, []]));
  const unlabeled = [];
  const prodsOf = (o, s) => [_t(o.product_name), ...(isProd(o) ? [_t(s.ot), planP(s.r, s.ot, s.rj)] : [])].filter(Boolean);
  /** 옮겨도 되는 칸 모양인가(H10) — 계획 칸이 빈 칸이거나 옛 선택지의 값뿐 */
  const cellsMovable = (s, ownerKey) => {
    const rj = s.rj || {}; const heads = Object.keys(rj);
    const o = ownerKey ? optByKey.get(ownerKey) : null;
    const sel = parseSelectionKey(_t(s.ot));
    // ★ v2 줄(표시 「상품 · 옵션」)의 1·2차옵션 칸은 부품 칸 — 통째 옵션 값 검사에서 빼고 아래 부품 검사로만 본다(리뷰 P1)
    const comp = stagedComponentColumns(heads);
    const compSet = new Set(sel ? [...comp.o1, ...comp.o2] : []);
    const optVals = new Set(['', _t(s.ot), ...(o ? [o.opt_key] : [])]);
    for (const i of optionWriteColumns(heads)) if (!compSet.has(i) && !optVals.has(_t(rj[heads[i]]))) return false;
    // 표시 없는 줄: 옵션 단위 작업에서 모든 선택지가 한 상품이면 그 상품 이름만 허용(어느 옵션으로 가도 상품 칸이 맞다) · 그 밖 = 빈 칸만
    const oneProduct = [...new Set(opts.map(x => _t(x.product_name)).filter(Boolean))];
    const prodVals = new Set(['', ...(o ? prodsOf(o, s) : (!hasProd && oneProduct.length === 1 ? oneProduct : []))]);
    for (const i of productWriteColumns(heads)) if (!prodVals.has(_t(rj[heads[i]]))) return false;
    for (const [idx, part] of [[comp.o1, 'option1Value'], [comp.o2, 'option2Value']]) {
      for (const i of idx) if (_t(rj[heads[i]]) && !(sel && _t(sel[part]) === _t(rj[heads[i]]))) return false;
    }
    return true;
  };
  for (const s of state0) {
    if (s.filled) {
      const k = filledKey.get(String(s.r.id));
      if (!k || !optByKey.has(k)) return { status: 'skipped', reason: 'filled_unattributed', detail: { seq: Number(s.r.seq) } };
      filled.set(k, filled.get(k) + 1);
      continue;
    }
    const ow = ownersOf(s);
    if (ow.length > 1) return { status: 'skipped', reason: 'label_ambiguous', detail: { seq: Number(s.r.seq) } };
    if (s.r.protected) {
      if (!ow.length) return { status: 'skipped', reason: 'label_unmatched', detail: { seq: Number(s.r.seq) } };
      fixedEmpty.set(ow[0], fixedEmpty.get(ow[0]) + 1);
      continue;
    }
    if (!ow.length && labelled(s)) return { status: 'skipped', reason: 'label_unmatched', detail: { seq: Number(s.r.seq) } };
    const movable = cellsMovable(s, ow[0] || null);
    if (!ow.length) { if (!movable) return { status: 'skipped', reason: 'row_cells_unknown', detail: { seq: Number(s.r.seq) } }; unlabeled.push(s); continue; }
    if (!movable) { fixedEmpty.set(ow[0], fixedEmpty.get(ow[0]) + 1); s.stuck = true; continue; }
    own.get(ow[0]).push(s);
  }
  // 줄 수 맞추기(줄이기) 전 순위 계산용 — 같은 짝 판정 결과만 돌려준다(새 규칙 0)
  if (classifyOnly) return { status: 'classified', own, filled, fixedEmpty, T };
  const optionsView = extra => opts.map(o => ({ option: o.opt_key, product: _t(o.product_name), target: T.get(o.opt_key), filled: filled.get(o.opt_key),
    fixed_empty: fixedEmpty.get(o.opt_key), empty_before: own.get(o.opt_key).length + fixedEmpty.get(o.opt_key), ...(extra ? extra(o) : {}) }));
  const sum = [...T.values()].reduce((a, b) => a + b, 0);
  if (sum !== rows.length) return { status: 'skipped', reason: 'total_mismatch', detail: { rows: rows.length, sum }, options: optionsView() };
  const need = new Map();
  for (const o of opts) {
    const fx = filled.get(o.opt_key) + fixedEmpty.get(o.opt_key);
    if (fx > T.get(o.opt_key)) return { status: 'skipped', reason: 'over_target', detail: { option: o.opt_key, fixed: fx, target: T.get(o.opt_key) }, options: optionsView() };
    need.set(o.opt_key, T.get(o.opt_key) - fx);
  }
  // 새로 적을 표시 — 그 선택지로 짝지어진 빈 줄 표시(가장 많이) → 채운 줄 표시 → 주문이 처음 채울 때 적는 값(새 글자를 지어내지 않는다)
  //   ★ 상품 단위는 줄 계획(planP = 주문 쪽 planOf 순서: 표식 → 손 글씨 → 상품 칸)으로 센다(리뷰 P2) — 표식이 비고 상품 칸에만
  //     「고등어 2팩 세트」가 있는 작업에서 표식만 세면 공고 이름 「고등어」를 지어 적어, 되읽기에서 정확 일치 「고등어」가 이겨 나머지 줄이 짝을 잃는다.
  const labelFor = new Map();
  for (const o of opts) {
    const lab = s => (isProd(o) ? planP(s.r, s.ot, s.rj) : _t(s.ot));
    const tally = list => { const c = new Map(); for (const s of list) { const l = lab(s); if (l) c.set(l, (c.get(l) || 0) + 1); } return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''; };
    const emptyOwned = state0.filter(s => !s.filled && ownersOf(s).length === 1 && ownersOf(s)[0] === o.opt_key);
    const filledOwned = state0.filter(s => s.filled && ownersOf({ ...s, filled: false }).length === 1 && ownersOf({ ...s, filled: false })[0] === o.opt_key);
    labelFor.set(o.opt_key, tally(emptyOwned) || tally(filledOwned) || (isProd(o) ? (_t(o.product_name) || o.opt_key) : o.opt_key));
  }
  // 자기 자리 남기기 · 넘치는 줄은 띄엄띄엄 내놓기 · 표시 없는 줄 + 내놓은 줄을 모자란 선택지에 고르게
  const pool = [...unlabeled];
  const deficit = new Map();
  for (const o of opts) {
    const list = own.get(o.opt_key); const n = need.get(o.opt_key);
    if (list.length > n) { const rel = _spread(list.length, list.length - n); list.forEach((s, i) => { if (rel.has(i)) pool.push(s); }); deficit.set(o.opt_key, 0); }
    else deficit.set(o.opt_key, n - list.length);
  }
  pool.sort((a, b) => Number(a.r.seq) - Number(b.r.seq));
  const order = _interleave(opts.map(o => [o.opt_key, deficit.get(o.opt_key)]));
  if (order.length !== pool.length) return { status: 'skipped', reason: 'total_mismatch', detail: { rows: rows.length, sum }, options: optionsView() };
  const moves = [];
  const target = new Map();
  for (const s of state0) if (!s.filled) { const ow = ownersOf(s); if (ow.length === 1) target.set(String(s.r.id), ow[0]); }
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i]; const to = order[i]; const o = optByKey.get(to);
    target.set(String(s.r.id), to);
    const from = ownersOf(s)[0] || null; const fo = from ? optByKey.get(from) : null;
    const nl = labelFor.get(to);
    const nsel = parseSelectionKey(nl); const osel = parseSelectionKey(_t(s.ot));
    const rj = relabelRowCells(s.rj, {
      optFrom: [_t(s.ot), ...(fo ? [fo.opt_key] : [])], optTo: nl,
      productFrom: fo ? prodsOf(fo, s) : [], productTo: isProd(o) ? nl : _t(o.product_name),
      o1From: osel ? [osel.option1Value] : [], o1To: nsel ? _t(nsel.option1Value) : null,
      o2From: osel ? [osel.option2Value] : [], o2To: nsel ? _t(nsel.option2Value) : null,
    });
    // 칸 모양 확인(H10) — 계획 칸이 빈 칸이거나 새 선택지 값뿐이어야 한다(표시는 B 인데 상품 칸은 A 인 모양 금지)
    //   ★ 부품 칸(리뷰 P1) — 새 표시가 「상품 · 옵션」이면 1·2차옵션 칸은 통째 표시가 아니라 **그 부품 값**(또는 빈 칸)이어야 한다.
    const heads = Object.keys(rj);
    const comp = stagedComponentColumns(heads);
    const compSet = new Set(nsel ? [...comp.o1, ...comp.o2] : []);
    const cellsBad = () => {
      const okProd = new Set(['', isProd(o) ? nl : _t(o.product_name)]);
      if (productWriteColumns(heads).some(j => !okProd.has(_t(rj[heads[j]])))) return true;
      if (optionWriteColumns(heads).some(j => !compSet.has(j) && !['', nl].includes(_t(rj[heads[j]])))) return true;
      if (!nsel) return heads.some((h, j) => (comp.o1.includes(j) || comp.o2.includes(j)) && _t(rj[h]));
      return comp.o1.some(j => !['', _t(nsel.option1Value)].includes(_t(rj[heads[j]])))
        || comp.o2.some(j => !['', _t(nsel.option2Value)].includes(_t(rj[heads[j]])));
    };
    if (cellsBad()) return { status: 'skipped', reason: 'row_cells_unknown', detail: { seq: Number(s.r.seq) }, options: optionsView() };
    if (from === to && _t(s.ot) === nl) continue;   // 같은 자리(표시 없는 줄이 아님) — 쓸 것 없음
    moves.push({ id: s.r.id, seq: Number(s.r.seq), from: _t(s.ot), to: nl, option: to, row_json: rj, s });
  }
  // 라운드트립 — 다시 나눈 결과를 같은 짝 함수로 되읽어 모든 빈 줄이 의도한 선택지 하나로만 읽히는지
  const mv = new Map(moves.map(m => [String(m.id), m]));
  const state1 = state0.map(s => (mv.has(String(s.r.id)) ? { ...s, ot: mv.get(String(s.r.id)).to, rj: mv.get(String(s.r.id)).row_json } : s));
  const owners1 = ownersFn(state1);
  const after = new Map(opts.map(o => [o.opt_key, 0]));
  for (const s of state1) {
    if (s.filled) continue;
    const ow = owners1(s);
    if (ow.length !== 1 || ow[0] !== target.get(String(s.r.id))) return { status: 'skipped', reason: 'label_ambiguous', detail: { seq: Number(s.r.seq) }, options: optionsView() };
    after.set(ow[0], after.get(ow[0]) + 1);
  }
  for (const o of opts) if (after.get(o.opt_key) !== T.get(o.opt_key) - filled.get(o.opt_key)) {
    return { status: 'skipped', reason: 'label_ambiguous', detail: { option: o.opt_key }, options: optionsView() };
  }
  return { status: moves.length ? 'applied' : 'unchanged', moves, options: optionsView(o => ({ empty_after: after.get(o.opt_key) })) };
}

/* ── DB 읽기 ───────────────────────────────────────────────────────────── */
async function _loadInTx(client, camp) {
  const { rows: opts } = await client.query(
    `SELECT opt_key, product_name, unit_kind, recruit_total, status, sole_until FROM campaign_options
      WHERE campaign_id = $1 AND COALESCE(status, 'active') <> 'deleted' ORDER BY sort_order, id`, [camp.id]);
  const { rows } = await client.query(
    `SELECT id, seq, option_text, row_json, identity_key, is_submitted, is_paid,
            (NULLIF(btrim(COALESCE(reviewer_name,'')),'') IS NOT NULL OR NULLIF(btrim(COALESCE(recipient_name,'')),'') IS NOT NULL
              OR NULLIF(btrim(COALESCE(phone8,'')),'') IS NOT NULL OR order_submission_id IS NOT NULL) AS filled
       FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE
      ORDER BY seq FOR UPDATE`, [camp.linked_sheet_id, camp.linked_tab_name]);
  return { opts, rows };
}

/** 사람 기록이 달린 줄 id 집합 — 표는 있는 것만(to_regclass) 한 번에. 조회 실패는 위로 던진다(호출부 SAVEPOINT → check_failed). */
async function _humanRecordIds(client, camp, rows) {
  const names = Object.keys(ROW_RECORD_TABLES);
  const { rows: ex } = await client.query(`SELECT n FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL`, [names.map(n => n === 'trackb_custom_columns' ? 'trackb_custom_column_values' : n)]);
  const have = new Set(ex.map(r => r.n === 'trackb_custom_column_values' ? 'trackb_custom_columns' : r.n));
  const parts = names.filter(n => have.has(n)).map(n => `(${ROW_RECORD_TABLES[n]})`);
  const out = new Set();
  if (!parts.length || !rows.length) return out;
  const ids = rows.map(r => String(r.id)), seqs = rows.map(r => Number(r.seq)), idks = rows.map(r => _t(r.identity_key)).filter(Boolean);
  const { rows: hit } = await client.query(`SELECT DISTINCT k FROM (${parts.join(' UNION ALL ')}) x`, [camp.linked_sheet_id, camp.linked_tab_name, ids, seqs, idks]);
  const keys = new Set(hit.map(h => h.k));
  for (const r of rows) if (keys.has('id:' + r.id) || keys.has('seq:' + r.seq) || (_t(r.identity_key) && keys.has('idk:' + _t(r.identity_key)))) out.add(String(r.id));
  return out;
}

/** 빈 줄 손 글씨 상품(결정 227 — 주문 줄 고르기와 같은 조회) */
async function _overlay(client, camp, ids) {
  const { PRODUCT_HEADER } = require('./orderLedger.service');
  if (!ids.length) return new Map();
  const { rows } = await client.query(
    `SELECT DISTINCT ON (anchor_value) anchor_value, value_text FROM participant_edits
      WHERE sheet_id = $1 AND tab_name = $2 AND anchor_type = 'manual' AND field = $3 AND kind = 'text' AND reverted_at IS NULL AND anchor_value = ANY($4::text[])
      ORDER BY anchor_value, created_at DESC, id DESC`, [camp.linked_sheet_id, camp.linked_tab_name, 'col:' + PRODUCT_HEADER, ids]);
  return new Map(rows.map(r => [String(r.anchor_value), _t(r.value_text)]));
}

/** 채운 줄의 정원 셈 귀속 — 그 공고 신청의 option_key → matchOrderOption(바로 구매 셈과 같은 함수·같은 입력) */
async function _filledKeys(client, camp, opts, filledRows) {
  const out = new Map();
  if (!filledRows.length) return out;
  const { matchOrderOption } = require('./campaignState.service');
  const { rows } = await client.query(
    `SELECT cp.id, cp.option_text, cp.row_json->>'상품' AS row_product, os.selected_opt_key, os.selected_product, os.submitted_at,
            ca.campaign_id AS app_campaign, ca.option_key AS app_key, pe.value_text AS edited_product
       FROM campaign_participants cp
       LEFT JOIN order_submissions os ON os.id = cp.order_submission_id
       LEFT JOIN campaign_applications ca ON ca.id = os.campaign_application_id
       LEFT JOIN LATERAL (
         SELECT pe0.value_text FROM participant_edits pe0
          WHERE pe0.sheet_id = cp.sheet_id AND pe0.tab_name = cp.tab_name AND pe0.field = 'col:상품' AND pe0.reverted_at IS NULL
            AND ((pe0.anchor_type = 'order' AND os.id IS NOT NULL AND pe0.anchor_value = os.id::text) OR (pe0.anchor_type = 'manual' AND pe0.anchor_value = cp.id::text))
          ORDER BY pe0.created_at DESC, pe0.id DESC LIMIT 1) pe ON TRUE
      WHERE cp.id = ANY($1::uuid[])`, [filledRows.map(r => r.id)]);
  const keys = new Set(opts.map(o => o.opt_key));
  for (const r of rows) {
    let k = (String(r.app_campaign || '') === String(camp.id) && r.app_key && keys.has(r.app_key)) ? r.app_key : null;
    if (!k) k = matchOrderOption(opts, { selectedOptKey: r.selected_opt_key, optionText: r.option_text, selectedProduct: r.selected_product,
      rowProduct: r.row_product, editedProduct: r.edited_product, submittedAt: r.submitted_at });
    out.set(String(r.id), k || null);
  }
  return out;
}

async function _applicable(client, camp) {
  if (process.env.WORKTABLE_OPTION_REBALANCE === '0') return 'switch_off';
  if (!camp || !camp.linked_sheet_id || !camp.linked_tab_name) return 'no_worktable_link';
  const { isSheetless } = require('../utils/sheetlessScope');
  if (!await isSheetless(client, camp.linked_sheet_id, camp.linked_tab_name)) return 'not_sheetless';
  if (await require('./qnaSlots.service').isQnaTab(client, camp.linked_sheet_id, camp.linked_tab_name)) return 'qna';
  if (await require('./bookingSlots.service').isBookingTab(client, camp.linked_sheet_id, camp.linked_tab_name)) return 'booking';
  if (await require('./receiptPool.service').isReceiptPoolTab(client, camp.linked_sheet_id, camp.linked_tab_name)) return 'receipt';
  return null;
}

async function _context(client, camp) {
  const { opts, rows } = await _loadInTx(client, camp);
  if (opts.length < 2) return { na: 'single_option' };
  const { rows: shared } = await client.query(
    `SELECT id FROM recruit_campaigns WHERE participation_mode AND status = 'active' AND archived_at IS NULL AND linked_sheet_id = $1 AND linked_tab_name = $2 FOR UPDATE`,
    [camp.linked_sheet_id, camp.linked_tab_name]);
  if (shared.some(r => String(r.id) !== String(camp.id))) return { skip: 'shared_worktable' };
  const empty = rows.filter(r => !r.filled);
  const human = await _humanRecordIds(client, camp, empty);
  const overlay = await _overlay(client, camp, empty.map(r => String(r.id)));
  const filledKey = await _filledKeys(client, camp, opts, rows.filter(r => r.filled));
  const list = rows.map(r => ({ id: r.id, seq: r.seq, option_text: r.option_text, row_json: r.row_json && typeof r.row_json === 'object' ? r.row_json : {}, filled: !!r.filled,
    overlay: overlay.has(String(r.id)) ? overlay.get(String(r.id)) : null,
    protected: !r.filled && (human.has(String(r.id)) || !!r.is_submitted || !!r.is_paid || _humanCells(r.row_json)) }));
  return { opts, rows: list, filledKey };
}

/**
 * 줄 수 맞추기(줄이기) 전에 — 지울 빈 줄 순위: 인원이 넘치는 선택지의 옮길 줄(띄엄띄엄) 먼저 · 사람 기록이 달린 빈 줄은 맨 뒤.
 * ★ 순위만 정한다(막지 않음). 실패·해당 없음 = {}(종전 순서).
 */
async function retirePreferenceInTx(client, camp) {
  await client.query('SAVEPOINT wos_retire');
  try {
    if (await _applicable(client, camp)) { await client.query('RELEASE SAVEPOINT wos_retire'); return {}; }
    const ctx = await _context(client, camp);
    await client.query('RELEASE SAVEPOINT wos_retire');
    if (!ctx.rows) return {};
    const protectIds = new Set(ctx.rows.filter(r => r.protected).map(r => String(r.id)));
    const c = planOptionSlots({ ...ctx, classifyOnly: true });
    // 넘침 = 자기 선택지 자유 빈 줄 − (새 인원 − 채운 줄 − 손댄 빈 줄) — 넘치는 줄을 띄엄띄엄 먼저 지운다. 짝을 못 지은 작업은 순위 없이(종전)
    const prefer = new Set();
    if (c.status === 'classified') {
      for (const [k, free] of c.own) {
        const surplus = free.length - Math.max(0, c.T.get(k) - c.filled.get(k) - c.fixedEmpty.get(k));
        if (surplus > 0) { const pick = _spread(free.length, surplus); free.forEach((x, i) => { if (pick.has(i)) prefer.add(String(x.r.id)); }); }
      }
    }
    return { preferRetireIds: prefer, protectIds };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT wos_retire').catch(() => {});
    logger.warn(`[bidir/rebalance] ${camp && camp.id} 줄 지우기 순위 계산 건너뜀(종전 순서): ${e.message}`);
    return {};
  }
}

/**
 * 다시 나누기 본체 — 결과는 응답 `option_slots` 칸 모양. 절대 throw 하지 않는다(저장은 됨).
 * @returns {{status:'applied'|'unchanged'|'skipped'|'not_applicable', reason:string|null, moved:number, notice?:string, options?:Array, worktable?:object}}
 */
async function rebalanceOptionSlotsInTx(client, camp, { by = 'bidir-rebalance', actor = '', origin = '', reviewMix = false } = {}) {
  const out = (status, reason = null, extra = {}) => ({ status, reason, moved: 0, ...extra });
  await client.query('SAVEPOINT wos_rebalance');
  let res;
  try {
    const na = await _applicable(client, camp);
    if (na) res = out('not_applicable', na);
    else {
      // 탭 잠금 — 호출부가 공고 행보다 먼저 잡았으면 다시 잡아도 바로 참(같은 트랜잭션). 아니면 기다리지 않고 시도만(역순 교착 0).
      const { rows: lk } = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [`sheetless_worktable:${camp.linked_sheet_id}:${camp.linked_tab_name}`]);
      if (!(lk[0] && lk[0].ok)) res = out('skipped', 'busy');
      else {
        const ctx = await _context(client, camp);
        if (ctx.na) res = out('not_applicable', ctx.na);
        else if (ctx.skip) res = out('skipped', ctx.skip);
        else {
          const plan = planOptionSlots(ctx);
          if (plan.status !== 'applied') res = out(plan.status, plan.reason || null, { ...(plan.detail ? { detail: plan.detail } : {}), ...(plan.options ? { options: plan.options } : {}) });
          else {
            await client.query(
              `UPDATE campaign_participants cp SET option_text = v.ot, row_json = v.rj::jsonb, updated_by = $4, updated_at = NOW()
                 FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS ot, unnest($3::text[]) AS rj) v
                WHERE cp.id = v.id AND cp.deleted_at IS NULL AND cp.active = TRUE AND cp.order_submission_id IS NULL`,
              [plan.moves.map(m => m.id), plan.moves.map(m => m.to), plan.moves.map(m => JSON.stringify(m.row_json)), String(by).slice(0, 100)]);
            logger.info(`[bidir/rebalance] ${camp.id} 빈 줄 ${plan.moves.length}개 옵션 표시 다시 나눔`);
            res = { status: 'applied', reason: null, moved: plan.moves.length, options: plan.options,
              worktable: { synced: true, sheetId: camp.linked_sheet_id, tabName: camp.linked_tab_name, add: 0, retire: 0, rebalanced: true } };
          }
        }
      }
    }
    await client.query('RELEASE SAVEPOINT wos_rebalance');
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT wos_rebalance').catch(() => {});
    logger.warn(`[bidir/rebalance] ${camp && camp.id} 빈 줄 옵션 표시 다시 나누기 확인 못 함(저장은 계속): ${e.message}`);
    res = out('skipped', 'check_failed');
  }
  if (res.status === 'skipped') res.notice = noticeFor(res.reason, res.detail, { reviewMix });
  // 공고 계획 기록 — 맞췄을 때·못 맞췄을 때(사람 화면이 없는 길도 여기에 남는다) · 기록 실패는 경고만
  if (camp && camp.id && (res.status === 'applied' || res.status === 'skipped')) {
    await client.query('SAVEPOINT wos_event');
    try {
      await client.query(`INSERT INTO campaign_plan_events (campaign_id, actor, action, detail) VALUES ($1, $2, 'option_slots_rebalance', $3::jsonb)`,
        [camp.id, String(actor || origin || ''), JSON.stringify({ by: origin || by, status: res.status, reason: res.reason, moved: res.moved, detail: res.detail || null, options: res.options || [] })]);
      await client.query('RELEASE SAVEPOINT wos_event');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT wos_event').catch(() => {});
      logger.warn(`[bidir/rebalance] ${camp.id} 기록 남기기 건너뜀(저장은 계속): ${e.message}`);
    }
  }
  return res;
}

module.exports = { rebalanceOptionSlotsInTx, retirePreferenceInTx, planOptionSlots, noticeFor, ROW_RECORD_TABLES, TAB_LEVEL_TABLES, REASON_TEXT, _humanCells };
