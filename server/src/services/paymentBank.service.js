'use strict';
/**
 * 입금 통장 자동 대조 (결정 293 · 사용자 확정 2026-10-27)
 *
 * 리뷰어 지급은 케이뱅크·하나은행 통장에서 대량이체로 나간다. 팝빌 중계 서버(inadd-finance-server)로 두 통장
 * 거래내역을 받아 회차와 맞대 본다(하나은행 = 결정 303 · 사용자 확정 2026-10-28). 회차는 자기 은행 통장과만 맞댄다.
 *   - 회차의 모든 금액이 그 시각 통장에 같은 건수로 찍혀 있고 취소 반환이 없으면 → 결과 파일 없이 '이체 완료'.
 *   - 맞지 않는 금액은 그 금액의 사람만 '확인 필요'로 남긴다(통장에는 받는 사람이 안 찍혀 누가 실패했는지 모른다).
 *     → 결과 파일을 올리거나, 실패한 사람을 직접 고른다(고른 건수가 통장의 부족 건수와 같아야 저장).
 *   - 통장에는 찍혔는데 어느 회차에도 없는 출금 = 회차 밖 이체(입금관리 맨 위 알림).
 * ★ 기록은 결과 파일 반영과 같은 단일 경로(paymentResult._commitBatchOutcome)로만 쓴다.
 * ★ 저장은 시각·금액·구분뿐 — 받는 사람 이름·계좌·적요는 저장하지 않는다.
 * ★ 모르면 확정하지 않는다(fail-closed): 통장을 못 받았거나 · 회차 이체를 못 찾았거나 · 같은 금액이 더 찍혔으면 그대로 둔다.
 */
const { logger } = require('../utils/logger');

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }
let _fetch = (...a) => fetch(...a);
function __setFetchForTest(f) { _fetch = f || ((...a) => fetch(...a)); }

/* 은행별 설정 — 회차(payment_batches.bank)와 통장(payment_bank_rows.bank)이 같은 키를 쓴다.
 *  settleMs = 묶음 끝에서 이만큼 지나야 확정. 케이뱅크는 실패가 같은 분에 '취소'로 돌아온다(82회차 실측).
 *  하나은행은 실패가 어떻게 찍히는지 실측이 아직 없다(2026-10-28) → 30분 기다리고, 반환으로 보이는 입금은
 *  그 금액을 '확인 필요'로 접는다(_markHanaRefunds). 모르면 확정하지 않는다. */
/* 결정 317(사용자 확정 2026-11-02) — 은행마다 '이체 완료'를 정하는 근거가 다르다(confirmBy).
 *  kbank = 'file' : 대량이체 통장 줄에 받는 사람이 없다 → 통장으로는 완료를 적지 않는다(결과 파일만). 통장은 알림·감시용.
 *                   (회차 사람 실패 + 리뷰웹 밖 같은 금액 줄이 맞물리면 못 받은 사람을 완료로 적는 위험 — 코드로 구분 불가)
 *  hana  = 'name' : 통장 줄마다 받는 사람 이름이 찍힌다 → 받을 때 이름+금액으로 우리 대량이체 사람과 맞추고(이름은 저장 안 함)
 *                   맞은 사람만 완료. 이름이 안 보이는 사람은 실패로 적지 않고 '확인 필요'. */
const BANKS = {
  kbank: { code: '0089', label: '케이뱅크', settleMs: 10 * 60 * 1000, confirmBy: 'file' },
  hana:  { code: '0081', label: '하나은행', settleMs: 30 * 60 * 1000, confirmBy: 'name' },
};
const NEED_FILE_AFTER_MS = 30 * 60 * 1000;   // 결정 317 — 케이뱅크 출금이 찍히고 30분이 지나도 결과 파일이 없으면 알린다
const BANK_IDS = Object.keys(BANKS);
const SYNC_MIN_GAP_MS = 3 * 60 * 1000;     // 3분에 한 번까지 받는다(입금관리 열 때마다 팝빌을 부르지 않게)
const SYNC_DAYS = 7;                         // 최근 7일
const CLUSTER_GAP_MS = 3 * 60 * 1000;        // 대량이체 한 번 = 3분 안에 이어 찍힌 출금 묶음
const SETTLE_MS = BANKS.kbank.settleMs;      // 실패는 같은 분에 '취소'로 돌아온다(82회차 실측) — 10분 지나야 확정(은행별 값은 BANKS)
const REFUND_WINDOW_MS = 30 * 60 * 1000;     // 묶음 끝 30분 안의 취소 반환을 그 묶음 것으로 본다
const FIND_WINDOW_MS = 3 * 24 * 3600 * 1000; // 회차 만든 뒤 3일 안의 묶음만 그 회차 후보
const CLAIM_SLACK_MS = 2 * 60 * 1000;        // 다른 회차가 이미 그 시각에 이체 완료면 그 묶음은 다른 회차 것
const BANK_STATUS = '통장 확인';

class BankError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function relayConfig(env = process.env) {
  const url = String(env.POPBILL_RELAY_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.POPBILL_RELAY_KEY || '').trim();
  return url ? { url, key } : null;
}

/* ── 한국 시간 ─────────────────────────────────────────── */
const KST_MS = 9 * 3600 * 1000;
function kstYmd(ms) { return new Date(ms + KST_MS).toISOString().slice(0, 10); }
/** 팝빌 거래일시 yyyyMMddHHmmss(한국 시간) → ms */
function parseTradeDT(dt) {
  const m = String(dt || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`);
  return Number.isFinite(ms) ? ms : null;
}
/** 작업보드 입금칸 표기(M/D HH:mm, 한국 시간) */
function depositStampOf(ms) {
  const d = new Date(ms + KST_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 중계 서버 거래 한 줄 → 저장할 모양(이름·적요는 버린다). 읽을 수 없으면 null. */
function toBankRow(tx, bank = 'kbank') {
  const at = parseTradeDT(tx && (tx.tradeDT || ''));
  const amount = Math.round(Number(tx && tx.tradeAmt));
  if (at == null || !Number.isFinite(amount) || amount <= 0) return null;
  const incoming = tx.tran_type === 'deposit' || tx.tradeType === 'I';
  const r3 = String(tx.remark3 || '').trim();
  // 하나은행 다건이체는 한 사람 한 줄 '타행송금'/'당행송금'(remark2 '인터넷뱅킹')으로 찍힌다(2026-10-28 실측 22줄).
  const kind = bank === 'hana'
    ? (!incoming && (r3 === '타행송금' || r3 === '당행송금') ? 'bulk_out'
      : incoming && /취소|반환|불능|오류|정정|환불/.test(r3) ? 'refund_in'
      : incoming ? 'other_in' : 'other_out')
    : (!incoming && r3 === '대량이체' ? 'bulk_out'
      : incoming && r3 === '취소' ? 'refund_in'
      : incoming ? 'other_in' : 'other_out');
  const balance = Number(tx.balance);
  const tid = String(tx.tid || '').trim() || `dt:${tx.tradeDT}:${amount}:${Number.isFinite(balance) ? balance : ''}:${kind}`;
  const row = { tid, at, amount, kind, balance: Number.isFinite(balance) ? balance : null };
  // 결정 317 — 하나은행 출금 줄의 받는 사람 이름(remark1). ★ 저장하지 않는다 — 받는 순간 우리 대량이체 사람과 맞추는 데만 쓴다(결정 293).
  if (bank === 'hana' && kind === 'bulk_out') Object.defineProperty(row, 'name', { value: normPayee(tx.remark1), enumerable: false });
  return row;
}

/** 이름 비교용 — 공백·(주)·주식회사를 뺀다. */
function normPayee(v) { return String(v || '').replace(/\s+/g, '').replace(/\(주\)|㈜|주식회사/g, ''); }

/**
 * 결정 317 — 하나은행 통장 줄을 대량이체 사람과 이름+금액으로 맞춘다(순수 계산).
 * @param rows   이번에 받은 줄(bulk_out 만 name 이 있다) — 이미 맞춘 줄(taken.byTid)은 그대로 둔다
 * @param items  후보 {id, amount, holder(정규화), createdAt}
 * @param taken  { byTid: Map<tid, itemId>, items: Set<itemId> } — 저장된 짝(다시 받아도 바뀌지 않게)
 * @returns Map<tid, itemId>
 * 같은 이름·같은 금액이 여럿이면 일찍 만든 대량이체의 사람부터 하나씩. 은행이 이름을 자를 수 있어 정확히 같지 않으면
 * 은행 이름이 예금주의 앞부분(2글자 이상)일 때만 맞춘다. 대량이체를 만들기 전(1분 여유) 출금·3일 뒤 출금은 맞추지 않는다.
 */
function matchByName(rows, items, taken = { byTid: new Map(), items: new Set() }) {
  const out = new Map();
  const used = new Set(taken.items);
  const pool = [...items].sort((a, b) => a.createdAt - b.createdAt);
  for (const r of [...rows].filter(x => x.kind === 'bulk_out').sort((a, b) => a.at - b.at)) {
    if (taken.byTid.has(r.tid)) { out.set(r.tid, taken.byTid.get(r.tid)); continue; }
    const nm = r.name || '';
    if (!nm) continue;
    const ok = it => !used.has(it.id) && it.amount === r.amount && r.at >= it.createdAt - 60 * 1000 && r.at <= it.createdAt + FIND_WINDOW_MS;
    const hit = pool.find(it => ok(it) && it.holder === nm) || (nm.length >= 2 ? pool.find(it => ok(it) && it.holder.startsWith(nm)) : null);
    if (hit) { used.add(hit.id); out.set(r.tid, hit.id); }
  }
  return out;
}

/**
 * 하나은행 — 실패 반환이 무슨 이름으로 찍히는지 모르므로, 대량이체 출금 뒤 30분 안에 **같은 금액**으로 들어온 돈은
 * 반환으로 본다(그 금액은 받은 건수가 줄어 '확인 필요'로 접힌다 = 잘못 '이체 완료'로 적지 않는다).
 * 출금 한 줄에 반환 한 줄까지만 짝짓는다.
 */
function _markHanaRefunds(rows) {
  const outs = rows.filter(r => r.kind === 'bulk_out').sort((a, b) => a.at - b.at);
  const used = new Set();
  const take = r => outs.find(x => !used.has(x) && x.amount === r.amount && r.at >= x.at && r.at <= x.at + REFUND_WINDOW_MS);
  // 이름으로 이미 반환인 입금이 그 출금을 먼저 차지한다 — 같은 출금에 반환이 두 번 붙지 않게(인트라넷 Codex P2 와 같은 갈래)
  for (const r of rows.filter(x => x.kind === 'refund_in').sort((a, b) => a.at - b.at)) { const o = take(r); if (o) used.add(o); }
  for (const r of rows.filter(x => x.kind === 'other_in').sort((a, b) => a.at - b.at)) {
    const o = take(r);
    if (o) { used.add(o); r.kind = 'refund_in'; }
  }
  return rows;
}

/* ── 대조(순수 계산) ─────────────────────────────────────── */
function clusterBulk(rows) {
  const out = [];
  let cur = null;
  for (const r of rows.filter(x => x.kind === 'bulk_out').sort((a, b) => a.at - b.at)) {
    if (!cur || r.at - cur.end > CLUSTER_GAP_MS) { cur = { start: r.at, end: r.at, rows: [] }; out.push(cur); }
    cur.end = r.at; cur.rows.push(r);
  }
  return out;
}
function _countBy(list, f) { const m = new Map(); for (const x of list) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); } return m; }

/**
 * 회차 하나를 통장과 맞대 본다(쓰기 없음).
 * @param {{ batch:{createdAt:number}, items:Array<{id,amount,status,resultStatus,resultSeq}>, rows:Array, claimedTimes:number[], now:number }} p
 * @returns {{ state:'clean'|'review'|'not_found'|'settling'|'file'|'done'|'empty', cluster?, amounts?, outside? }}
 *   state: clean = 확정 가능 · review = 일부 '확인 필요' · not_found = 통장에서 이 회차 이체를 못 찾음 ·
 *          settling = 이체 직후(취소 반환 대기) · file = 결과 파일로 이미 처리된 건이 있음(파일이 기준) · done = 처리할 건 없음
 */
function reconcileBatch({ batch, items, rows, claimedTimes = [], now = Date.now(), settleMs = SETTLE_MS, mode = 'amount' }) {
  const live = items.filter(it => it.status !== 'cancelled');
  if (!live.length) return { state: 'empty' };
  // 결과 파일로 처리된 건이 하나라도 있으면 그 회차는 결과 파일이 기준이다(통장으로 덮지 않는다).
  if (live.some(it => it.status !== 'pending' && it.resultStatus !== BANK_STATUS && !String(it.resultStatus || '').startsWith(BANK_STATUS))) {
    return { state: 'file' };
  }
  if (!live.some(it => it.status === 'pending')) return { state: 'done' };
  if (mode === 'name') return _reconcileByName({ live, rows, now, settleMs });

  const want = _countBy(live, it => Number(it.amount));
  const created = Number(batch.createdAt);
  const candidates = clusterBulk(rows)
    .filter(c => c.start >= created - 60 * 1000 && c.start <= created + FIND_WINDOW_MS)
    .filter(c => !claimedTimes.some(t => t >= c.start - CLAIM_SLACK_MS && t <= c.end + CLAIM_SLACK_MS));
  let best = null; let bestScore = 0;
  for (const c of candidates) {
    const have = _countBy(c.rows, r => r.amount);
    let score = 0;
    for (const [a, n] of want) score += Math.min(n, have.get(a) || 0);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  if (!best || bestScore < Math.max(1, Math.ceil(live.length / 2))) return { state: 'not_found' };

  const cluster = { start: best.start, end: best.end, rowCount: best.rows.length, total: best.rows.reduce((s, r) => s + r.amount, 0) };
  if (now < best.end + settleMs) return { state: 'settling', cluster };

  const have = _countBy(best.rows, r => r.amount);
  const refunds = _countBy(rows.filter(r => r.kind === 'refund_in' && r.at >= best.start && r.at <= best.end + REFUND_WINDOW_MS), r => r.amount);
  const amounts = [];
  let outsideCount = 0; let outsideSum = 0;
  for (const [a, c] of have) if (!want.has(a)) { outsideCount += c; outsideSum += a * c; }
  for (const [a, n] of want) {
    const c = have.get(a) || 0;
    const r = Math.min(refunds.get(a) || 0, c);
    const ofAmount = live.filter(it => Number(it.amount) === a);
    // 같은 금액이 회차보다 더 찍혔으면 그 금액은 통장만으로 누가 받았는지 알 수 없다(회차 밖 줄이 섞였다) — 결과 파일로.
    const failures = c > n ? null : n - (c - r);
    if (c > n) { outsideCount += c - n; outsideSum += a * (c - n); }
    amounts.push({
      amount: a, count: n, bank: c, refunds: r, failures,
      itemIds: ofAmount.map(it => it.id),
      paidTimes: best.rows.filter(x => x.amount === a).map(x => x.at),
    });
  }
  /* 결정 317(방식 B) — 이 묶음에 회차 밖 줄(리뷰웹 밖 작업을 엑셀에 직접 넣어 같이 보낸 줄)이 섞였으면 **통장으로 정하지 않는다**.
       회차 사람 한 명이 계좌 오류로 빠지고 밖의 줄 하나가 같은 금액이면 건수가 맞아 보여, 못 받은 사람을 '이체 완료'로 적게 된다.
       → 모든 금액을 '통장으로 모름'(failures=null)으로 두고 결과 파일을 기다린다(planConfirm 이 아무도 확정하지 않는다). */
  const mixed = outsideCount > 0;
  if (mixed) for (const x of amounts) x.failures = null;
  const clean = amounts.every(x => x.failures === 0);
  return { state: clean ? 'clean' : 'review', cluster, amounts, mixed, outside: { count: outsideCount, sum: outsideSum } };
}

/**
 * 결정 317 — 이름으로 맞춘 은행(하나은행): 받을 때 이 회차 사람과 맞춘 통장 줄(matchedItemId)만 본다.
 *  - 맞춘 줄이 하나도 없으면 not_found · 맞춘 줄 끝에서 settleMs 전이면 settling.
 *  - 맞춘 사람 = 완료 후보. 단 그 금액으로 반환(취소)이 들어왔으면 누구 것인지 몰라 그 금액은 전부 '확인 필요'.
 *  - 안 맞은 사람 = '확인 필요'(실패로 적지 않는다 — 예금주 이름이 통장과 다를 수도 있다).
 *  - 같은 시각 다른 줄(리뷰웹 밖 작업)은 이름이 달라 이 회차와 섞이지 않는다 — 회차 밖으로만 센다.
 * amounts 는 화면·확인할 것과 같은 모양(failures: 0 = 다 맞음, null = 통장으로 모름).
 */
function _reconcileByName({ live, rows, now, settleMs }) {
  const ids = new Set(live.map(it => String(it.id)));
  const mine = rows.filter(r => r.kind === 'bulk_out' && r.matchedItemId && ids.has(String(r.matchedItemId)));
  if (!mine.length) return { state: 'not_found', mode: 'name' };
  const start = Math.min(...mine.map(r => r.at)); const end = Math.max(...mine.map(r => r.at));
  const cluster = { start, end, rowCount: mine.length, total: mine.reduce((x, r) => x + r.amount, 0) };
  if (now < end + settleMs) return { state: 'settling', cluster, mode: 'name' };
  const refunds = _countBy(rows.filter(r => r.kind === 'refund_in' && r.at >= start && r.at <= end + REFUND_WINDOW_MS), r => r.amount);
  const at = new Map(mine.map(r => [String(r.matchedItemId), r.at]));
  const pending = live.filter(it => it.status === 'pending');
  const matched = new Map(); const unresolved = [];
  for (const it of pending) {
    const t = at.get(String(it.id));
    if (t != null && !refunds.get(Number(it.amount))) matched.set(String(it.id), t); else unresolved.push(it);
  }
  const amounts = [];
  for (const [a, n] of _countBy(live, it => Number(it.amount))) {
    const ofAmount = live.filter(it => Number(it.amount) === a);
    const miss = unresolved.filter(it => Number(it.amount) === a).length;
    amounts.push({ amount: a, count: n, bank: mine.filter(r => r.amount === a).length, refunds: refunds.get(a) || 0,
      failures: miss ? null : 0, missing: miss, itemIds: ofAmount.map(it => it.id),
      paidTimes: ofAmount.map(it => at.get(String(it.id))).filter(t => t != null) });
  }
  const inWin = rows.filter(r => r.kind === 'bulk_out' && r.at >= start - CLAIM_SLACK_MS && r.at <= end + CLAIM_SLACK_MS && !r.matchedItemId);
  return { state: unresolved.length ? 'review' : 'clean', mode: 'name', cluster, amounts, matched,
    unresolvedIds: unresolved.map(it => it.id), mixed: false,
    outside: { count: inWin.length, sum: inWin.reduce((x, r) => x + r.amount, 0) } };
}

/**
 * 확정 계획 — reconcileBatch 결과 + 직접 고른 실패자 → paid / failed 목록.
 * failedItemIds 는 '확인 필요' 금액마다 정확히 failures 건이어야 한다(이미 실패로 정한 건 포함). 틀리면 거부.
 * auto(자동 확정)는 아무도 고르지 않는다 — 건수가 안 맞는 금액은 거부 대신 그 금액만 남긴다(다른 금액의 완료를 막지 않게).
 */
function planConfirm(rec, items, failedItemIds = [], { auto = false } = {}) {
  const byId = new Map(items.map(it => [String(it.id), it]));
  if (rec.mode === 'name') {   // 결정 317 — 이름으로 맞춘 사람만 완료 · 고르기 없음 · 실패로 적지 않음
    if ((failedItemIds || []).length) throw new BankError('bad_pick', '하나은행은 통장 이름으로 정합니다 — 못 받은 사람은 결과 파일로 처리해 주세요.');
    const paid = []; const unresolved = [];
    for (const it of items.filter(x => x.status === 'pending')) {
      const t = rec.matched && rec.matched.get(String(it.id));
      if (t != null) paid.push({ item: it, at: t }); else unresolved.push({ amount: Number(it.amount), reason: 'name' });
    }
    return { paid, failed: [], unresolved };
  }
  const picked = new Set((failedItemIds || []).map(String));
  for (const id of picked) {
    const it = byId.get(id);
    if (!it) throw new BankError('bad_pick', '이 대량이체에 없는 사람을 골랐습니다. 화면을 새로고침해 주세요.');
    const row = rec.amounts.find(x => x.amount === Number(it.amount));
    if (!row || row.failures === 0) throw new BankError('bad_pick', `${Number(it.amount).toLocaleString('ko-KR')}원은 통장과 맞아 실패를 고를 수 없습니다.`);
    if (row.failures == null) throw new BankError('bad_pick', `${Number(it.amount).toLocaleString('ko-KR')}원은 통장에 더 많이 찍혀 고를 수 없습니다. 결과 파일을 올려 주세요.`);
  }
  const paid = []; const failed = []; const unresolved = [];
  for (const row of rec.amounts) {
    const ofAmount = row.itemIds.map(id => byId.get(String(id))).filter(Boolean);
    const pending = ofAmount.filter(it => it.status === 'pending');
    const times = [...row.paidTimes].sort((a, b) => a - b);
    if (row.failures === 0) {
      pending.forEach((it, i) => paid.push({ item: it, at: times[Math.min(i, times.length - 1)] }));
      continue;
    }
    if (row.failures == null) { unresolved.push({ amount: row.amount, reason: 'extra' }); continue; }
    const already = ofAmount.filter(it => it.status === 'failed').length;
    const chosen = pending.filter(it => picked.has(String(it.id)));
    if (!chosen.length && !already) { unresolved.push({ amount: row.amount, reason: 'pick', failures: row.failures }); continue; }
    if (already + chosen.length !== row.failures) {
      if (auto && !chosen.length) { unresolved.push({ amount: row.amount, reason: 'pick', failures: row.failures }); continue; }
      throw new BankError('pick_count', `${row.amount.toLocaleString('ko-KR')}원은 통장 기준 ${row.failures}명이 못 받았습니다. ${row.failures}명을 골라 주세요(지금 ${already + chosen.length}명).`);
    }
    chosen.forEach(it => failed.push({ item: it }));
    pending.filter(it => !picked.has(String(it.id))).forEach((it, i) => paid.push({ item: it, at: times[Math.min(i, Math.max(0, times.length - 1))] }));
  }
  return { paid, failed, unresolved };
}

/* ── 저장소 ───────────────────────────────────────────── */
async function _loadRows(bank, fromMs, toMs) {
  const { rows } = await _db().query(
    `SELECT tid, (EXTRACT(EPOCH FROM traded_at) * 1000)::bigint AS at, amount, kind, matched_item_id
       FROM payment_bank_rows WHERE bank = $1 AND traded_at >= $2 AND traded_at <= $3 ORDER BY traded_at`,
    [bank, new Date(fromMs).toISOString(), new Date(toMs).toISOString()]);
  return rows.map(r => ({ tid: r.tid, at: Number(r.at), amount: Number(r.amount), kind: r.kind,
    matchedItemId: r.matched_item_id ? String(r.matched_item_id) : null }));
}

async function _loadBatchItems(batchId) {
  const { rows } = await _db().query(`SELECT * FROM payment_batch_items WHERE batch_id = $1 ORDER BY created_at, id`, [batchId]);
  return rows.map(r => ({
    id: r.id, sheetId: r.sheet_id, tabName: r.tab_name, rowIndex: r.row_index,
    reviewerName: r.reviewer_name || '', amount: Number(r.amount || 0),
    productPrice: Number(r.product_price || 0), reviewFee: Number(r.review_fee || 0),
    status: r.status, resultStatus: r.result_status || '', resultSeq: r.result_seq,
  }));
}

/** 다른 회차가 이미 '이체 완료'한 시각들(그 묶음은 다른 회차 것). */
async function _claimedTimes(bank, batchId, fromMs, toMs) {
  const { rows } = await _db().query(
    `SELECT DISTINCT (EXTRACT(EPOCH FROM date_trunc('minute', i.paid_at)) * 1000)::bigint AS at
       FROM payment_batch_items i JOIN payment_batches b ON b.id = i.batch_id
      WHERE b.bank = $1 AND i.batch_id <> $2 AND i.status = 'paid'
        AND i.paid_at >= $3 AND i.paid_at <= $4`,
    [bank, batchId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()]);
  return rows.map(r => Number(r.at));
}

async function inspectBatch(batchId, { now = Date.now() } = {}) {
  const { rows: [b] } = await _db().query(`SELECT id, seq, bank, status, created_at FROM payment_batches WHERE id = $1`, [batchId]);
  if (!b) throw new BankError('not_found', '대량이체를 찾을 수 없습니다.');
  const cfg = BANKS[b.bank];
  if (!cfg) return { batchId, seq: b.seq, bank: b.bank, state: 'other_bank' };
  if (b.status === 'cancelled') return { batchId, seq: b.seq, bank: b.bank, state: 'cancelled' };
  const created = new Date(b.created_at).getTime();
  const to = Math.min(now, created + FIND_WINDOW_MS + REFUND_WINDOW_MS);
  const [items, rows, claimedTimes] = await Promise.all([
    _loadBatchItems(batchId), _loadRows(b.bank, created - 60 * 1000, to), _claimedTimes(b.bank, batchId, created - 60 * 1000, to),
  ]);
  const rec = reconcileBatch({ batch: { createdAt: created }, items, rows, claimedTimes, now, settleMs: cfg.settleMs,
    mode: cfg.confirmBy === 'name' ? 'name' : 'amount' });
  // 결정 317 — 결과 파일로만 끝내는 은행(케이뱅크): 통장에 이 회차 출금이 찍히고 30분이 지났는데 처리 안 된 사람이 있으면 '결과 파일 필요'
  const fileOnly = cfg.confirmBy === 'file';
  const needFile = fileOnly && !!rec.cluster && now >= rec.cluster.end + NEED_FILE_AFTER_MS
    && ['clean', 'review', 'settling'].includes(rec.state) && items.some(i => i.status === 'pending');
  return { batchId, seq: b.seq, bank: b.bank, ...rec, fileOnly, needFile, items };
}

/**
 * 통장으로 확정 — 'clean' 이면 전부, 'review' 면 맞는 금액만(+ 직접 고른 실패자가 있으면 그 금액도).
 * 기록은 결과 파일 반영과 같은 경로(_commitBatchOutcome).
 */
async function confirmBatchFromBank({ batchId, by, failedItemIds = [], notifyFailed, auto = false }) {
  const rec = await inspectBatch(batchId);
  // 결정 317 — 케이뱅크는 통장으로 '이체 완료'를 적지 않는다(자동·수동 모두). 결과 파일이 기준.
  if (rec.fileOnly) throw new BankError('file_only', `${(BANKS[rec.bank] || {}).label || ''} 대량이체는 이체결과 파일로 완료합니다 — 결과 파일을 입금관리에 놓아 주세요.`);
  if (!['clean', 'review'].includes(rec.state)) {
    const msg = {
      not_found: '통장에서 이 대량이체를 아직 찾지 못했습니다. 이체 뒤 통장 확인을 다시 눌러 주세요.',
      settling: `이체 직후라 실패 반환을 기다리는 중입니다. ${Math.round(((BANKS[rec.bank] || BANKS.kbank).settleMs) / 60000)}분 뒤 다시 확인해 주세요.`,
      file: '결과 파일로 이미 처리된 대량이체입니다. 남은 건은 결과 파일로 처리해 주세요.',
      done: '이미 모두 처리된 대량이체입니다.', empty: '이 대량이체에 대상이 없습니다.',
      other_bank: '케이뱅크·하나은행 대량이체만 통장으로 확인할 수 있습니다.', cancelled: '취소된 대량이체입니다.',
    }[rec.state] || '통장으로 확인할 수 없는 대량이체입니다.';
    throw new BankError(rec.state, msg);
  }
  const plan = planConfirm(rec, rec.items, failedItemIds, { auto });
  if (!plan.paid.length && !plan.failed.length) {
    return { ok: true, state: rec.state, applied: 0, failed: 0, unresolved: plan.unresolved, remaining: rec.items.filter(i => i.status === 'pending').length };
  }
  const result = require('./paymentResult.service');
  const out = await result._commitBatchOutcome({
    batchId, by: by || 'bank', notifyFailed,
    paid: plan.paid.map(p => ({
      item: p.item, paidAtIso: new Date(p.at).toISOString(), statusRaw: BANK_STATUS, seq: null, stamp: depositStampOf(p.at),
    })),
    failed: plan.failed.map(p => ({
      item: p.item, statusRaw: `${BANK_STATUS}: 실패`, seq: null,
      reason: '이체 실패 — 통장에 출금이 없거나 취소로 돌아옴(담당자 확인)',
    })),
    markApplied: 'when_done',
    recordUpload: async (client, { paidCount, failedCount, remaining }) => {
      if (!paidCount && !failedCount) return;   // 동시에 두 번 눌러 바뀐 게 없으면 기록 줄도 남기지 않는다
      const summary = { source: 'bank', bank: { cluster: rec.cluster, outside: rec.outside, unresolved: plan.unresolved, remainingPending: remaining } };
      await client.query(
        `INSERT INTO payment_result_uploads
           (batch_id, bank, file_name, file_format, row_count, matched, success_count, failed_count, applied, applied_count, applied_at, summary, uploaded_by)
         VALUES ($1,$2,$3,'bank',$4,$5,$6,$7,TRUE,$6,NOW(),$8,$9)`,
        [batchId, rec.bank, `통장 확인(${BANKS[rec.bank].label} 거래내역) ${depositStampOf(rec.cluster.start)}`, rec.cluster.rowCount,
         paidCount + failedCount, paidCount, failedCount, JSON.stringify(summary), by || 'bank']);
    },
  });
  logger.info(`[paymentBank] #${rec.seq} 통장 확정 by ${by || 'bank'} — 완료 ${out.paidItems.length} · 실패 ${out.failedCount} · 남음 ${out.remaining}`);
  return { ok: true, state: rec.state, applied: out.paidItems.length, failed: out.failedCount, remaining: out.remaining, unresolved: plan.unresolved, board: out.board, notified: out.notified };
}

/* ── 통장 받기 ─────────────────────────────────────────── */
async function _fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await _fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  } finally { clearTimeout(t); }
}

function _relayHeaders(cfg) { return { 'Content-Type': 'application/json', ...(cfg.key ? { 'X-Relay-Key': cfg.key } : {}) }; }
/** 팝빌에 등록된 통장 목록 — 한 번 받아 두 은행이 같이 쓴다 */
async function _relayAccounts(cfg) {
  const acc = await _fetchJson(`${cfg.url}/api/bank/accounts`, { headers: _relayHeaders(cfg) }, 20000);
  if (!acc.ok) throw new BankError('relay_failed', `팝빌 중계 서버가 계좌 목록을 주지 않았습니다(${acc.status}).`);
  return (acc.body && acc.body.accounts) || [];
}
async function _collectFromRelay(cfg, bank, account, fromMs, toMs) {
  const headers = _relayHeaders(cfg);
  const res = await _fetchJson(`${cfg.url}/api/bank/collect`, {
    method: 'POST', headers,
    body: JSON.stringify({ bankCode: BANKS[bank].code, accountNumber: account.accountNumber,
      sDate: kstYmd(fromMs).replace(/-/g, ''), eDate: kstYmd(toMs).replace(/-/g, ''), allPages: true }),
  }, 150000);
  if (res.status === 202) throw new BankError('collecting', '팝빌이 아직 통장 내역을 모으는 중입니다. 잠시 뒤 다시 확인해 주세요.');
  const d = res.body || {};
  if (!res.ok || d.success !== true) throw new BankError('relay_failed', `통장 내역을 받지 못했습니다(${res.status}${d.error ? ` · ${String(d.error).slice(0, 80)}` : ''}).`);
  if (d.allPages !== true) throw new BankError('relay_old', '중계 서버가 모든 쪽 받기를 지원하지 않습니다.');
  if (d.truncated) throw new BankError('truncated', '통장 내역을 다 받지 못했습니다(쪽 수 상한). 담당자에게 알려 주세요.');
  if (d.adjustedNote) throw new BankError('range_adjusted', '조회 기간이 팝빌 제한으로 줄었습니다.');
  const rows = (d.list || []).map(tx => toBankRow(tx, bank)).filter(Boolean);
  return bank === 'hana' ? _markHanaRefunds(rows) : rows;
}

/** 결정 317 — 이번에 받은 하나은행 줄을 대량이체 사람과 이름+금액으로 맞춘다(같은 트랜잭션 · 이름은 저장 안 함). */
async function _matchNames(client, bank, rows, fromMs) {
  const { rows: items } = await client.query(
    `SELECT i.id, i.amount, i.account_holder, (EXTRACT(EPOCH FROM b.created_at) * 1000)::bigint AS created
       FROM payment_batch_items i JOIN payment_batches b ON b.id = i.batch_id
      WHERE b.bank = $1 AND b.status <> 'cancelled' AND i.status <> 'cancelled' AND b.created_at >= $2`,
    [bank, new Date(fromMs - FIND_WINDOW_MS).toISOString()]);
  const { rows: prev } = await client.query(
    `SELECT tid, matched_item_id FROM payment_bank_rows WHERE bank = $1 AND matched_item_id IS NOT NULL AND traded_at >= $2`,
    [bank, new Date(fromMs - FIND_WINDOW_MS).toISOString()]);
  const taken = { byTid: new Map(prev.map(r => [r.tid, String(r.matched_item_id)])), items: new Set(prev.map(r => String(r.matched_item_id))) };
  return matchByName(rows, items.map(it => ({ id: String(it.id), amount: Number(it.amount), holder: normPayee(it.account_holder),
    createdAt: Number(it.created) })), taken);
}

/** 한 은행 통장 받기(3분에 한 번 — 칸 하나를 조건부로 잡아 동시에 두 번 받지 않는다). */
async function _syncOne(cfg, bank, { by, force, now }, getAccounts) {
  await _db().query(`INSERT INTO payment_bank_sync (bank) VALUES ($1) ON CONFLICT (bank) DO NOTHING`, [bank]);
  const { rows: claim } = await _db().query(
    `UPDATE payment_bank_sync SET last_synced_at = $2, synced_by = $3
      WHERE bank = $1 AND ($4::bool OR last_synced_at IS NULL OR last_synced_at < $2::timestamptz - make_interval(secs => $5))
      RETURNING bank`,
    [bank, new Date(now).toISOString(), String(by || ''), !!force, SYNC_MIN_GAP_MS / 1000]);
  if (!claim.length) return { ok: true, skipped: true, fetched: null };
  const fromMs = now - (SYNC_DAYS - 1) * 24 * 3600 * 1000;
  try {
    const account = (await getAccounts()).find(a => String(a && a.bankCode) === BANKS[bank].code);
    if (!account) throw new BankError('no_account', `${BANKS[bank].label} 통장이 팝빌에 등록돼 있지 않습니다.`);
    const rows = await _collectFromRelay(cfg, bank, account, fromMs, now);
    const client = await _db().connect();
    try {
      await client.query('BEGIN');
      // 결정 317 — 이름으로 맞추는 은행: 받는 사람 이름은 여기서만 쓰고 버린다. 저장하는 것은 '우리 쪽 누구와 맞았는지'뿐.
      const matches = BANKS[bank].confirmBy === 'name' ? await _matchNames(client, bank, rows, fromMs) : new Map();
      for (const r of rows) {
        await client.query(
          `INSERT INTO payment_bank_rows (bank, tid, traded_at, amount, kind, balance, collected_at, matched_item_id)
           VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
           ON CONFLICT (bank, tid) DO UPDATE SET traded_at = EXCLUDED.traded_at, amount = EXCLUDED.amount,
             kind = EXCLUDED.kind, balance = EXCLUDED.balance, collected_at = NOW(),
             matched_item_id = COALESCE(payment_bank_rows.matched_item_id, EXCLUDED.matched_item_id)`,
          [bank, r.tid, new Date(r.at).toISOString(), r.amount, r.kind, r.balance, matches.get(r.tid) || null]);
      }
      await client.query(
        `UPDATE payment_bank_sync SET last_ok = TRUE, last_error = '', range_from = $2, range_to = $3, row_count = $4 WHERE bank = $1`,
        [bank, kstYmd(fromMs), kstYmd(now), rows.length]);
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client.release(); }
    return { ok: true, skipped: false, fetched: rows.length };
  } catch (e) {
    const message = String(e && e.message || e).slice(0, 300);
    await _db().query(`UPDATE payment_bank_sync SET last_ok = FALSE, last_error = $2 WHERE bank = $1`, [bank, message]);
    logger.warn(`[paymentBank] ${BANKS[bank].label} 통장 받기 실패: ${message}`);
    return { ok: false, code: e && e.code || 'sync_failed', error: message };
  }
}

/**
 * 통장 받기(은행마다 3분에 한 번) + 회차 자동 확정. force 면 3분 제한을 무시한다(버튼). banks 를 주면 그 은행만 받는다(자동 받기).
 * 자동 확정 = 'clean' 은 전부 · 'review' 는 통장과 맞는 금액의 사람만(사용자 확정 2026-10-28 「빠진 사람만 제외하면 적용」) —
 *   빠진 사람이 섞인 금액 묶음은 그대로 '확인 필요'로 남아 담당자가 고른다(통장에 받는 사람이 안 찍혀 누군지 모른다).
 * ★ 은행은 서로 막지 않는다 — 한 은행이 실패해도 다른 은행은 받고 확정한다. 실패한 은행의 회차는 자동 확정하지 않는다.
 *   ok = 모든 은행이 받았거나 건너뜀 · 실패한 은행이 있으면 ok=false + code/error 는 첫 실패(케이뱅크 먼저).
 */
async function syncBank({ by, force = false, now = Date.now(), env = process.env, banks: only = null } = {}) {
  const cfg = relayConfig(env);
  if (!cfg) return { ok: false, code: 'not_configured', error: '통장 연결 설정이 없습니다(POPBILL_RELAY_URL).' };
  const ids = only ? BANK_IDS.filter(bk => only.includes(bk)) : BANK_IDS;
  let accounts = null;
  const getAccounts = async () => (accounts = accounts || _relayAccounts(cfg));
  const banks = {};
  for (const bank of ids) banks[bank] = await _syncOne(cfg, bank, { by, force, now }, getAccounts);
  const okBanks = ids.filter(bk => banks[bk].ok);
  // 회차 자동 확정 — 받기에 성공한(또는 3분 안에 이미 받은) 은행의 최근 7일 회차 중 처리 안 된 건이 있는 것
  const { rows: open } = okBanks.length ? await _db().query(
    `SELECT b.id FROM payment_batches b
      WHERE b.bank = ANY($1::text[]) AND b.status <> 'cancelled' AND b.created_at >= $2
        AND EXISTS (SELECT 1 FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'pending')
      ORDER BY b.created_at`,
    [okBanks, new Date(now - SYNC_DAYS * 24 * 3600 * 1000).toISOString()]) : { rows: [] };
  const autoConfirmed = [];
  for (const { id } of open) {
    try {
      const rec = await inspectBatch(id, { now });
      if (rec.fileOnly) continue;   // 결정 317 — 케이뱅크는 결과 파일로만
      if (rec.state !== 'clean' && rec.state !== 'review') continue;
      const r = await confirmBatchFromBank({ batchId: id, by: `통장 자동확인${by ? `(${by})` : ''}`, auto: true });
      if (r.applied) autoConfirmed.push({ batchId: id, seq: rec.seq, applied: r.applied, remaining: r.remaining || 0 });
    } catch (e) { logger.warn(`[paymentBank] 자동 확정 건너뜀(${id}): ${e.message}`); }
  }
  const failed = ids.filter(bk => !banks[bk].ok);
  const fetchedList = ids.map(bk => banks[bk].fetched).filter(n => n != null);
  return {
    ok: !failed.length,
    ...(failed.length ? { code: banks[failed[0]].code, error: failed.map(bk => `${BANKS[bk].label}: ${banks[bk].error}`).join(' / ') } : {}),
    fetched: fetchedList.length ? fetchedList.reduce((x, y) => x + y, 0) : null,
    skipped: ids.every(bk => banks[bk].skipped),
    anyOk: okBanks.length > 0,
    banks, autoConfirmed,
  };
}

/* ── 자동 받기(사용자 확정 2026-10-28) ─────────────────────
 * 화면을 안 열어도 이체 파일을 받은 뒤 서버가 스스로 통장을 받는다 — 팝빌은 조금만 부른다.
 *   다운로드 뒤 1시간 안 = 5분마다 · 1~2시간 = 30분마다 · 2시간 뒤 = 안 받는다(입금관리를 열면 그때 받는다).
 * 기준 = 그 은행 대량이체 중 처리 안 된 건이 있는 것의 가장 최근 다운로드 시각. 다시 받으면 다시 2시간.
 * 일찍 멈춤 = 다 처리됐거나, 한 번 확정(맞는 사람 완료)·결과 파일 반영이 된 회차는 기준에서 빠진다.
 * (인트라넷 통장 기록을 신호로 쓰지 않는 이유: 인트라넷은 정기 작업이 없어 사람이 열 때만 받는다 — 시점이 사람에 달린다.) */
const AUTO_SYNC_STEPS = [
  { untilMs: 60 * 60 * 1000, gapMs: 5 * 60 * 1000 },
  { untilMs: 120 * 60 * 1000, gapMs: 30 * 60 * 1000 },
];
const AUTO_SYNC_SLACK_MS = 60 * 1000;   // 5분 크론이 몇 초 늦게 돌아도 한 번을 건너뛰지 않게
function autoSyncGap(sinceDownloadMs) {
  if (!(sinceDownloadMs >= 0)) return null;
  const step = AUTO_SYNC_STEPS.find(s => sinceDownloadMs < s.untilMs);
  return step ? step.gapMs : null;
}
/** 지금 받아야 할 은행 — 순수 계산(다운로드 시각·마지막 받은 시각). */
function autoSyncDue(rows, syncs, now = Date.now()) {
  const due = [];
  for (const r of rows) {
    const gap = autoSyncGap(now - Number(r.downloadedAt));
    if (gap == null) continue;
    const last = syncs[r.bank] == null ? null : Number(syncs[r.bank]);
    if (last == null || now - last >= gap - AUTO_SYNC_SLACK_MS) due.push(r.bank);
  }
  return due;
}
async function autoSync({ now = Date.now(), env = process.env } = {}) {
  const since = new Date(now - AUTO_SYNC_STEPS[AUTO_SYNC_STEPS.length - 1].untilMs).toISOString();
  const { rows } = await _db().query(
    `SELECT b.bank, (EXTRACT(EPOCH FROM MAX(b.last_downloaded_at)) * 1000)::bigint AS dl
       FROM payment_batches b
      WHERE b.bank = ANY($1::text[]) AND b.status <> 'cancelled' AND b.last_downloaded_at >= $2
        AND EXISTS (SELECT 1 FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'pending')
        -- 한 번이라도 통장 확정·결과 파일 반영이 된 회차는 더 받지 않는다(남은 건 = 사람이 고를 '확인 필요'뿐 · 통장을 더 받아도 안 바뀐다)
        AND NOT EXISTS (SELECT 1 FROM payment_result_uploads u WHERE u.batch_id = b.id AND u.applied)
      GROUP BY b.bank`, [BANK_IDS, since]);
  if (!rows.length) return { ran: false, banks: [] };
  const { rows: s } = await _db().query(
    `SELECT bank, (EXTRACT(EPOCH FROM last_synced_at) * 1000)::bigint AS at FROM payment_bank_sync WHERE bank = ANY($1::text[])`, [BANK_IDS]);
  const syncs = Object.fromEntries(s.map(x => [x.bank, x.at == null ? null : Number(x.at)]));
  const due = autoSyncDue(rows.map(r => ({ bank: r.bank, downloadedAt: Number(r.dl) })), syncs, now);
  if (!due.length) return { ran: false, banks: [] };
  const sync = await syncBank({ by: '자동', now, env, banks: due });
  return { ran: true, banks: due, sync };
}

/** 한 은행의 통장 상태 + 회차 밖으로 나간 돈 + 처리 안 된 회차별 대조. */
async function _bankOverviewOne(bank, now) {
  const cfg = BANKS[bank];
  const { rows: [sync] } = await _db().query(`SELECT * FROM payment_bank_sync WHERE bank = $1`, [bank]);
  const fromMs = now - SYNC_DAYS * 24 * 3600 * 1000;
  const rows = await _loadRows(bank, fromMs, now);
  // 회차 이체 완료 건(그 은행 어느 회차든)을 시각·금액으로 지운다 → 남은 대량이체 = 회차 밖
  const { rows: paid } = await _db().query(
    `SELECT (EXTRACT(EPOCH FROM i.paid_at) * 1000)::bigint AS at, i.amount
       FROM payment_batch_items i JOIN payment_batches b ON b.id = i.batch_id
      WHERE b.bank = $1 AND i.status = 'paid' AND i.paid_at >= $2`, [bank, new Date(fromMs - 3600 * 1000).toISOString()]);
  const { rows: open } = await _db().query(
    `SELECT b.id FROM payment_batches b
      WHERE b.bank = $1 AND b.status <> 'cancelled' AND b.created_at >= $2
        AND EXISTS (SELECT 1 FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'pending')
      ORDER BY b.created_at`, [bank, new Date(fromMs).toISOString()]);
  const batches = [];
  for (const { id } of open) {
    const rec = await inspectBatch(id, { now });
    batches.push({
      batchId: id, seq: rec.seq, bank, state: rec.state, cluster: rec.cluster || null, outside: rec.outside || null, mixed: !!rec.mixed,
      fileOnly: !!rec.fileOnly, needFile: !!rec.needFile, mode: rec.mode || 'amount',   // 결정 317
      amounts: (rec.amounts || []).filter(x => x.failures !== 0).map(x => ({ amount: x.amount, count: x.count, bank: x.bank, refunds: x.refunds, failures: x.failures,
        ...(x.missing != null ? { missing: x.missing } : {}) })),   // 결정 317 — 하나은행 이름이 안 보이는 사람 수
      pending: (rec.items || []).filter(i => i.status === 'pending').length,
    });
  }
  // 결정 317 — 「리뷰웹 밖 작업」으로 표시한 이체도 '기록 없이 나간 돈'이 아니다(시각·금액으로 지운다)
  let external = [];
  try { external = await require('./paymentExternalWork.service').paidTransfersForBank(bank, new Date(fromMs - 3600 * 1000).toISOString(), _db()); }
  catch (e) { if (!(e && e.code === '42P01')) throw e; }
  const outside = outsideTransfers(rows, [...paid.map(p => ({ at: Number(p.at), amount: Number(p.amount) })), ...external],
    batches.filter(b => b.cluster).map(b => ({ start: b.cluster.start, end: b.cluster.end })), now, cfg.settleMs);
  return {
    bank, label: cfg.label, settleMinutes: Math.round(cfg.settleMs / 60000), confirmBy: cfg.confirmBy,
    sync: sync ? { lastSyncedAt: sync.last_synced_at, ok: sync.last_ok, error: sync.last_error || '', rowCount: sync.row_count } : null,
    outside, batches,
  };
}

/**
 * 입금관리 맨 위 — 은행마다 통장 받은 상태 + 회차 밖으로 나간 돈, 처리 안 된 회차별 대조(두 은행 합침).
 * ★ 배포 스큐: 옛 화면은 맨 위 sync/outside 만 읽는다 → 케이뱅크 값을 그대로 둔다(새 화면은 banks[]).
 */
async function bankOverview({ now = Date.now(), env = process.env } = {}) {
  const cfg = relayConfig(env);
  const banks = [];
  for (const bank of BANK_IDS) banks.push(await _bankOverviewOne(bank, now));
  const kb = banks.find(b => b.bank === 'kbank');
  return {
    ok: true, configured: !!cfg,
    sync: kb.sync, outside: kb.outside,
    banks: banks.map(({ batches, ...b }) => b),
    batches: banks.flatMap(b => b.batches),
  };
}

/**
 * 회차 밖으로 나간 돈 — 대량이체 묶음에서 회차 이체 완료(같은 금액·묶음 시각 ±2분)와 취소 반환을 지우고 남은 줄.
 * 아직 처리 전인 회차가 차지한 묶음(pendingClusters)은 그 회차가 정해질 때까지 세지 않는다(거짓 알림 방지).
 */
function outsideTransfers(rows, paid, pendingClusters = [], now = Date.now(), settleMs = SETTLE_MS) {
  const days = new Map();
  let count = 0; let sum = 0; let held = 0;
  for (const c of clusterBulk(rows)) {
    if (now < c.end + settleMs) continue;
    if (pendingClusters.some(p => p.start === c.start)) { held += c.rows.length; continue; }
    const left = _countBy(c.rows, r => r.amount);
    for (const p of paid) {
      if (p.at < c.start - CLAIM_SLACK_MS || p.at > c.end + CLAIM_SLACK_MS) continue;
      if ((left.get(p.amount) || 0) > 0) left.set(p.amount, left.get(p.amount) - 1);
    }
    // 실패로 나갔다가 '취소'로 돌아온 돈은 회차 밖으로 나간 돈이 아니다(82회차 실측: 같은 분에 반환).
    for (const r of rows) {
      if (r.kind !== 'refund_in' || r.at < c.start || r.at > c.end + REFUND_WINDOW_MS) continue;
      if ((left.get(r.amount) || 0) > 0) left.set(r.amount, left.get(r.amount) - 1);
    }
    for (const [a, n] of left) {
      if (!n) continue;
      count += n; sum += a * n;
      const d = kstYmd(c.start);
      const cur = days.get(d) || { date: d, count: 0, sum: 0 };
      cur.count += n; cur.sum += a * n; days.set(d, cur);
    }
  }
  return { count, sum, held, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/**
 * 결정 302 — 「뺀 사람 고르기」 힌트(무료 · 우리 기록만). 계좌 조회(유료)는 하지 않는다.
 *   firstAccount = 이 계좌로 다른 대량이체에서 받은 적 없음 · failedBefore = 이 계좌로 이체 실패한 적 있음
 *   holderDiff = 예금주가 리뷰어 이름과 다름 · multiJob = 같은 대량이체에 같은 계좌가 또 있음(다른 작업)
 * ★ 계좌번호는 돌려주지 않는다(화면에 PII 를 늘리지 않는다) · 조회 실패 = 힌트 없음(고르기는 그대로 된다).
 */
async function itemHints(batchId, itemIds) {
  const ids = (itemIds || []).map(String).filter(Boolean);
  if (!batchId || !ids.length) return {};
  const { rows } = await _db().query(
    `WITH t AS (
       SELECT id, batch_id, regexp_replace(COALESCE(bank_account, ''), '\\D', '', 'g') AS acc,
              regexp_replace(COALESCE(reviewer_name, ''), '\\s', '', 'g') AS nm,
              regexp_replace(COALESCE(account_holder, ''), '\\s', '', 'g') AS holder
         FROM payment_batch_items WHERE batch_id = $1 AND id::text = ANY($2::text[])),
     h AS (
       SELECT p.id, p.batch_id, p.status, regexp_replace(COALESCE(p.bank_account, ''), '\\D', '', 'g') AS acc
         FROM payment_batch_items p
        WHERE regexp_replace(COALESCE(p.bank_account, ''), '\\D', '', 'g') IN (SELECT acc FROM t WHERE acc <> ''))
     SELECT t.id::text AS id,
            (t.acc <> '' AND NOT EXISTS (SELECT 1 FROM h WHERE h.acc = t.acc AND h.status = 'paid' AND h.batch_id <> t.batch_id)) AS first_account,
            EXISTS (SELECT 1 FROM h WHERE h.acc = t.acc AND h.status = 'failed' AND h.id <> t.id) AS failed_before,
            (t.holder <> '' AND t.nm <> '' AND t.holder <> t.nm) AS holder_diff,
            EXISTS (SELECT 1 FROM h WHERE h.acc = t.acc AND h.batch_id = t.batch_id AND h.id <> t.id) AS multi_job
       FROM t`, [batchId, ids]);
  const out = {};
  for (const r of rows) {
    const tags = [];
    if (r.first_account) tags.push('처음 받는 계좌');
    if (r.holder_diff) tags.push('예금주가 리뷰어와 다름');
    if (r.failed_before) tags.push('예전에 이체 실패');
    if (r.multi_job) tags.push('같은 날 다른 작업에도 있음');
    out[r.id] = tags;
  }
  return out;
}

module.exports = {
  autoSyncGap, autoSyncDue, autoSync, AUTO_SYNC_STEPS,
  BANK_STATUS, BankError, BANKS, BANK_IDS,
  relayConfig, toBankRow, parseTradeDT, _markHanaRefunds, depositStampOf, clusterBulk, reconcileBatch, planConfirm, outsideTransfers,
  matchByName, normPayee, NEED_FILE_AFTER_MS,
  inspectBatch, confirmBatchFromBank, syncBank, bankOverview, itemHints,
  // 결정 302 — 「오늘 확인할 것」(opsCheck.service)이 같은 재료·같은 기준을 쓴다(사본 금지)
  loadRows: (...a) => _loadRows(...a),   // (bank, fromMs, toMs)
  TIMING: { SYNC_DAYS, SETTLE_MS, REFUND_WINDOW_MS, CLAIM_SLACK_MS, FIND_WINDOW_MS },
  __setPoolForTest, __setFetchForTest,
};
