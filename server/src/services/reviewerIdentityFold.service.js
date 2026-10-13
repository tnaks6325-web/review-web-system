/*
 * 같은 번호 타계정 정리 — 결정 226 3·4단계 (migration 185 · 사용자 확정 2026-10-13 1가·2가·3나).
 *
 * 본계정과 번호(끝 8자리)가 같은 타계정 칸을 본계정으로 합친다.
 *   - 대상: 이름만 다른 칸 + 이름까지 같은 완전 중복 칸.
 *   - 예외(담당자 화면으로 · 이 기능은 건드리지 않음): 계좌(은행·계좌·예금주)가 본계정과 다름 · 주민번호가 다름 ·
 *     쇼핑 아이디가 다름 · 그 이름으로 따로 가입한 리뷰어가 있음 · 코드 명의(142)가 붙은 리뷰어 · 같은 칸이 둘 이상.
 *   - 대기(다음에 다시): 진행 중인 참여(applied) · 아직 안 나간 입금(타계정 계좌로 만든 대기 항목).
 *
 * 한 칸의 처리(소유자마다 짧은 트랜잭션 · 잠금 대기 2초 · 잠금 순서 = 리뷰어 → 카드 → 기록):
 *   ① 리뷰어 행 FOR NO KEY UPDATE · 조건 다시 확인(그 사이 바뀌었으면 stale 로 건너뜀)
 *   ② 판단 기록(fold_self · 지운 칸 전체 · 주민번호는 "본계정과 같음" 표시만) — 열린 판단은 묶음마다 하나(167 유일 색인)
 *   ③ 그 타계정 카드로 기록된 주문·참여를 본인 카드로(받는 사람 이름·연락처는 그대로) · 옮긴 행은 fold_moves 에
 *   ④ 뒤 칸들의 옛 이름표(칸 순번 해시)를 한 칸 당긴 순번으로(순번이 밀려 과거 주문과의 짝이 끊기지 않게)
 *   ⑤ 카드를 merged(합쳐 들어간 곳 = 본인 카드)로 표시한 **다음에** 칸을 지운다 — 10분 거울이 되살리지 않는다(176)
 * ★ 결정 179 완화 금지 ①(타계정 칸 안 지움)의 예외는 이 유형만이다(번호가 본계정과 같아 옛 번호 로그인 걱정이 없다).
 * ★ 스위치: Railway `SAME_PHONE_FOLD_MODE` — 없음/off = 아무것도 안 함 · preview = 목록만 기록 ·
 *   apply:<미리보기 번호> = 그 미리보기의 대상만 정리 · undo_all:<실행 번호> = 그 실행이 만든 정리를 전부 되돌림.
 */
const crypto = require('crypto');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const cards = require('./reviewerIdentityCards.service');

const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const p8 = (v) => { const d = digits(v); return d.length >= 8 ? d.slice(-8) : ''; };
const nk = (v) => String(v == null ? '' : v).replace(/\s+/g, '');
const blank = (v) => String(v == null ? '' : v).trim() === '';
const bankKey = (v) => String(v == null ? '' : v).replace(/\s+|은행/g, '');
const stableHash = (v) => crypto.createHash('sha256').update(String(v == null ? '' : v)).digest('hex');
// reviewerOrderIdentity.legacyIdentityKey 와 같은 규칙(이름표 = 이름|번호8|칸 순번) — 회귀가드가 두 식을 대조한다.
const legacyP8 = (v) => { const d = digits(v); return d.length >= 8 ? d.slice(-8) : d; };   // reviewerOrderIdentity.phone8 과 같음(짧은 번호는 그대로)
const legacyKey = (name, phone, index) => `sub:${stableHash(`${nk(name)}|${legacyP8(phone)}|${Number(index)}`).slice(0, 24)}`;
const SELF_HASH = stableHash('self');
const sigHash = (name, phone) => stableHash(`fold|${nk(name)}|${p8(phone)}`).slice(0, 32);
const groupKeyOf = (ownerId, name, phone) => `fold|${ownerId}|${sigHash(name, phone)}`;
function asSubs(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return asSubs(JSON.parse(value)); } catch (_) { return []; } }
  return [];
}

class IdentityFoldError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const REVIEWER_COLS = 'id, name, phone, resident_num, bank_name, bank_account, account_holder, shopping_id, reviewer_no, sub_accounts';

/**
 * 한 소유자의 같은 번호 칸을 판정한다(순수 함수 · DB 미접근).
 * @param ctx { otherNames:Set(이름키 — 다른 리뷰어 본계정 이름), coded, inProgress, paymentPending }
 * @returns [{ index, sig, type:'name_diff'|'duplicate', status:'ready'|'exception'|'wait', reasons:[] }]
 */
function classifyOwner(owner, ctx = {}) {
  const ownerP8 = p8(owner.phone);
  if (!ownerP8 || digits(owner.phone).length < 8) return [];
  const subs = asSubs(owner.sub_accounts);
  const out = [];
  const pick = (s, a, b) => (s && !blank(s[a]) ? s[a] : (s ? s[b] : ''));   // 옛 칸은 snake_case 로 저장돼 있기도 하다
  subs.forEach((s, index) => {
    if (!s || typeof s !== 'object' || p8(s.phone) !== ownerP8) return;
    const bankAccount = pick(s, 'bankAccount', 'bank_account'), bankName = pick(s, 'bankName', 'bank_name');
    const holder = pick(s, 'accountHolder', 'account_holder'), shoppingId = pick(s, 'shoppingId', 'shopping_id');
    const reasons = [];
    const sameName = nk(s.name) !== '' && nk(s.name) === nk(owner.name);
    if (!nk(s.name)) reasons.push('no_name');
    if (!blank(bankAccount) && (digits(bankAccount) !== digits(owner.bank_account)
        || bankKey(bankName) !== bankKey(owner.bank_name) || nk(holder) !== nk(owner.account_holder))) reasons.push('account_diff');
    if (digits(s.jumin) && digits(s.jumin) !== digits(owner.resident_num)) reasons.push('jumin_diff');
    if (!blank(shoppingId) && String(shoppingId).trim() !== String(owner.shopping_id || '').trim()) reasons.push('shopping_diff');
    // 담당자 합치기(179)에서 다른 카드가 이 칸 카드로 합쳐 들어와 있으면 건드리지 않는다(합친 묶음이 갈 곳을 잃는다).
    if (!sameName && ctx.mergeKeptSigs && ctx.mergeKeptSigs.has(`${nk(s.name)}|${p8(s.phone)}`)) reasons.push('merge_target');
    if (!sameName && ctx.otherNames && ctx.otherNames.has(nk(s.name))) reasons.push('other_reviewer_same_name');
    if (ctx.coded || owner.reviewer_no != null) reasons.push('coded_identity');
    if (subs.filter((x) => x && nk(x.name) === nk(s.name) && p8(x.phone) === ownerP8).length > 1) reasons.push('duplicate_slot');
    const wait = [];
    if (ctx.inProgress) wait.push('in_progress');
    if (ctx.paymentPending) wait.push('payment_pending');
    out.push({ index, sig: sigHash(s.name, s.phone), type: sameName ? 'duplicate' : 'name_diff',
      status: reasons.length ? 'exception' : (wait.length ? 'wait' : 'ready'), reasons: reasons.length ? reasons : wait });
  });
  return out;
}

async function _ownerContext(db, ownerId, names) {
  const { rows: [r] } = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM reviewer_identities WHERE owner_reviewer_id = $1) AS coded,
       EXISTS (SELECT 1 FROM campaign_applications WHERE owner_reviewer_id = $1 AND status = 'applied') AS in_progress,
       -- 타계정 계좌로 박제된 대기 항목이 있으면 칸을 지운 뒤 그 회차 전체가 다운로드 불가(계좌 대조 409)가 된다.
       EXISTS (SELECT 1 FROM payment_batch_items pi JOIN payment_batches pb ON pb.id = pi.batch_id
                WHERE pi.status = 'pending' AND pb.status <> 'cancelled' AND pi.account_source = 'sub'
                  AND (pi.owner_reviewer_id = $1 OR pi.account_sub_phone8 = (SELECT RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g'), 8) FROM reviewers WHERE id = $1))) AS payment_pending,
       ARRAY(SELECT DISTINCT REGEXP_REPLACE(COALESCE(o.name, ''), '\\s', '', 'g') FROM reviewers o
              WHERE o.id <> $1 AND REGEXP_REPLACE(COALESCE(o.name, ''), '\\s', '', 'g') = ANY($2::text[])) AS other_names,
       ARRAY(SELECT k.name_key || '|' || k.phone8 FROM reviewer_identity_cards k
              WHERE k.owner_reviewer_id = $1 AND EXISTS (SELECT 1 FROM reviewer_identity_cards m WHERE m.merged_into = k.id AND m.id <> k.id)) AS merge_kept`,
    [ownerId, names]);
  return { coded: !!r.coded, inProgress: !!r.in_progress, paymentPending: !!r.payment_pending, otherNames: new Set(r.other_names || []),
    mergeKeptSigs: new Set(r.merge_kept || []) };
}

/** 같은 번호 칸이 있는 소유자 목록(읽기만). */
async function _candidateOwners(db) {
  const { rows } = await db.query(
    `SELECT ${REVIEWER_COLS.split(', ').map((c) => 'r.' + c).join(', ')}
       FROM reviewers r
      WHERE LENGTH(REGEXP_REPLACE(COALESCE(r.phone, ''), '\\D', '', 'g')) >= 8
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.sub_accounts) = 'array' THEN r.sub_accounts ELSE '[]'::jsonb END) s
                     WHERE RIGHT(REGEXP_REPLACE(COALESCE(s->>'phone', ''), '\\D', '', 'g'), 8)
                         = RIGHT(REGEXP_REPLACE(r.phone, '\\D', '', 'g'), 8))`);
  return rows;
}

/** 미리보기 — 쓰기 0(실행 기록 한 줄만). items 에는 소유자 번호·칸 순번·판정만(이름·번호 금지). */
async function preview({ db = pool, record = true } = {}) {
  const owners = await _candidateOwners(db);
  const items = [];
  for (const o of owners) {
    const names = asSubs(o.sub_accounts).map((s) => nk(s && s.name)).filter(Boolean);
    const ctx = await _ownerContext(db, o.id, names);
    for (const c of classifyOwner(o, ctx)) items.push({ ownerId: String(o.id), ...c });
  }
  const summary = { owners: new Set(items.map((x) => x.ownerId)).size, slots: items.length,
    ready: items.filter((x) => x.status === 'ready').length,
    readyDuplicate: items.filter((x) => x.status === 'ready' && x.type === 'duplicate').length,
    exception: items.filter((x) => x.status === 'exception').length,
    wait: items.filter((x) => x.status === 'wait').length };
  let runId = null;
  if (record) {
    const { rows: [run] } = await db.query(
      `INSERT INTO reviewer_identity_fold_runs (mode, finished_at, summary, items) VALUES ('preview', NOW(), $1::jsonb, $2::jsonb) RETURNING id`,
      [JSON.stringify(summary), JSON.stringify(items)]);
    runId = String(run.id);
  }
  logger.info(`[identity-fold] preview run=${runId} ${JSON.stringify(summary)}`);
  return { ok: true, runId, summary, items };
}

/** 한 칸 정리(호출자가 연 트랜잭션 안). */
async function _foldOne(client, { ownerId, sig, by, runId }) {
  const { rows: [owner] } = await client.query(`SELECT ${REVIEWER_COLS} FROM reviewers WHERE id = $1 FOR NO KEY UPDATE`, [ownerId]);
  if (!owner) return { result: 'gone' };
  const subs = asSubs(owner.sub_accounts);
  const names = subs.map((s) => nk(s && s.name)).filter(Boolean);
  const ctx = await _ownerContext(client, ownerId, names);
  const verdict = classifyOwner(owner, ctx).find((c) => c.sig === sig);
  if (!verdict) return { result: 'already_done' };
  if (verdict.status !== 'ready') return { result: verdict.status === 'wait' ? 'wait' : 'stale', reasons: verdict.reasons };
  const index = verdict.index;
  const slot = subs[index];

  // 카드: 본인 카드(필수) · 이 칸의 타계정 카드(완전 중복은 본인 카드가 그 명의를 가져서 없다)
  const { rows: ownerCards } = await client.query(
    `SELECT id, kind, status, name_key, phone8 FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 FOR NO KEY UPDATE`, [ownerId]);
  const selfCard = ownerCards.find((c) => c.kind === 'self' && c.status === 'active');
  if (!selfCard) return { result: 'no_self_card' };
  const subCard = verdict.type === 'name_diff'
    ? ownerCards.find((c) => c.kind === 'sub' && c.status === 'active' && c.name_key === nk(slot.name) && c.phone8 === p8(slot.phone)) || null
    : null;

  const juminSame = !!digits(slot.jumin);
  const saved = { ...slot };
  if (juminSame) saved.jumin = '';
  // 앞뒤 칸 표시(이름·번호 해시) — 되돌릴 때 다른 정리가 먼저 되돌려져 순번이 달라져도 원래 자리를 찾는다.
  const near = (s) => (s && typeof s === 'object' ? sigHash(s.name, s.phone) : null);
  const snapshot = { index, type: verdict.type, sub: saved, juminSameAsOwner: juminSame,
    prevSig: index > 0 ? near(subs[index - 1]) : null, nextSig: near(subs[index + 1]),
    subCardId: subCard ? String(subCard.id) : null, selfCardId: String(selfCard.id), runId: runId || null };
  const { rows: [dec] } = await client.query(
    `INSERT INTO reviewer_identity_decisions (kind, owner_reviewer_id, group_key, kept_card_id, merged_card_ids, snapshot, decided_by)
     VALUES ('fold_self', $1, $2, $3, $4::uuid[], $5::jsonb, $6) RETURNING id`,
    [ownerId, groupKeyOf(ownerId, slot.name, slot.phone), selfCard.id, subCard ? [subCard.id] : [], JSON.stringify(snapshot), String(by).slice(0, 80)]);
  const decisionId = dec.id;

  // ③ 이 칸으로 기록된 주문·참여 → 본인(받는 사람 이름·연락처는 그대로)
  const oldHashes = [stableHash(legacyKey(slot.name, slot.phone, index))];
  if (subCard) oldHashes.push(stableHash(`card:${subCard.id}`));
  const moved = { orders: 0, applications: 0, shifted: 0 };
  const { rows: orders } = await client.query(
    `SELECT id, participant_card_id, participant_identity_key_hash FROM order_submissions
      WHERE owner_reviewer_id = $1
        AND (participant_identity_key_hash = ANY($2::text[]) OR ($3::uuid IS NOT NULL AND participant_card_id = $3::uuid))
      FOR UPDATE`, [ownerId, oldHashes, subCard ? subCard.id : null]);
  for (const o of orders) {
    const newCard = subCard && String(o.participant_card_id) === String(subCard.id) ? selfCard.id : o.participant_card_id;
    const newHash = oldHashes.includes(o.participant_identity_key_hash) ? SELF_HASH : o.participant_identity_key_hash;
    await client.query(`UPDATE order_submissions SET participant_card_id = $2, participant_identity_key_hash = $3 WHERE id = $1`,
      [o.id, newCard, newHash]);
    await client.query(
      `INSERT INTO reviewer_identity_fold_moves (decision_id, table_name, row_id, old_card_id, new_card_id, old_hash, new_hash)
       VALUES ($1, 'order_submissions', $2, $3, $4, $5, $6)`,
      [decisionId, String(o.id), o.participant_card_id, newCard, o.participant_identity_key_hash, newHash]);
    moved.orders++;
  }
  if (subCard) {
    const { rows: apps } = await client.query(
      `SELECT id FROM campaign_applications WHERE participant_card_id = $1 FOR UPDATE`, [subCard.id]);
    for (const a of apps) {
      await client.query(`UPDATE campaign_applications SET participant_card_id = $2 WHERE id = $1`, [a.id, selfCard.id]);
      await client.query(
        `INSERT INTO reviewer_identity_fold_moves (decision_id, table_name, row_id, old_card_id, new_card_id)
         VALUES ($1, 'campaign_applications', $2, $3, $4)`, [decisionId, String(a.id), subCard.id, selfCard.id]);
      moved.applications++;
    }
  }
  // ④ 뒤 칸들의 옛 이름표를 한 칸 당긴 순번으로(카드 이름표로 묶인 기록은 순번과 무관해 그대로)
  for (let j = index + 1; j < subs.length; j++) {
    const s = subs[j];
    if (!s || typeof s !== 'object') continue;
    const from = stableHash(legacyKey(s.name, s.phone, j));
    const to = stableHash(legacyKey(s.name, s.phone, j - 1));
    const { rows: shifted } = await client.query(
      `UPDATE order_submissions SET participant_identity_key_hash = $3
        WHERE owner_reviewer_id = $1 AND participant_identity_key_hash = $2 RETURNING id, participant_card_id`, [ownerId, from, to]);
    for (const o of shifted) {
      await client.query(
        `INSERT INTO reviewer_identity_fold_moves (decision_id, table_name, row_id, old_card_id, new_card_id, old_hash, new_hash)
         VALUES ($1, 'order_submissions', $2, $3, $3, $4, $5)`, [decisionId, String(o.id), o.participant_card_id, from, to]);
      moved.shifted++;
    }
  }
  // ⑤ 카드 merged → 칸 지우기(이 순서여야 거울이 카드를 되살리지 않는다)
  if (subCard) {
    await client.query(
      `UPDATE reviewer_identity_cards SET status = 'merged', merged_into = $2, updated_at = NOW(), record_version = record_version + 1
        WHERE id = $1 AND status = 'active'`, [subCard.id, selfCard.id]);
  }
  await cards.mutateSubAccountsInTx(client, ownerId, (list) => {
    const i = cards.findSubIndex(list, slot.name, slot.phone);
    if (i !== index) throw new IdentityFoldError('stale', '정리하는 사이 타계정 목록이 바뀌었습니다.');
    list.splice(i, 1);
    return list;
  }, { source: 'fold_self' });
  return { result: 'folded', decisionId: String(decisionId), moved };
}

async function _inTx(db, lockTimeoutMs, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${Math.max(100, Number(lockTimeoutMs) || 2000)}ms`]);
    // 계정 변경 기록(125 트리거)에 리뷰어가 한 것처럼 남지 않게 실행 주체를 밝힌다.
    await client.query(`SELECT set_config('app.changed_by', 'identity-fold', true)`);
    const out = await fn(client);
    if (out && ['folded', 'undone'].includes(out.result)) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

/**
 * 실행 — 미리보기(runId)에서 ready 였던 칸만 정리한다. 여러 번 돌려도 결과가 같다(이미 정리한 칸은 already_done).
 * 잠금 대기에 걸린 칸은 끝에서 두 번 더 시도한다.
 */
async function apply({ previewRunId, db = pool, by = 'switch', lockTimeoutMs = 2000, retryDelayMs = 3000 } = {}) {
  const id = Number(previewRunId);
  if (!Number.isSafeInteger(id) || id < 1) throw new IdentityFoldError('bad_run', '미리보기 번호가 올바르지 않습니다.');
  const { rows: [run] } = await db.query(`SELECT id, mode, items FROM reviewer_identity_fold_runs WHERE id = $1`, [id]);
  if (!run || run.mode !== 'preview') throw new IdentityFoldError('bad_run', '그 번호의 미리보기가 없습니다.');
  const { rows: [me] } = await db.query(
    `INSERT INTO reviewer_identity_fold_runs (mode, summary) VALUES ('apply', $1::jsonb) RETURNING id`,
    [JSON.stringify({ previewRunId: String(id) })]);
  const applyRunId = String(me.id);
  // 담당자 「판단 내역」의 담당자 칸에 그대로 보인다 — 사람이 아니라 스위치 실행임을 알 수 있게.
  const tag = by === 'switch' ? `자동 정리 #${applyRunId}` : `${String(by).slice(0, 30)} #${applyRunId}`;
  let todo = (run.items || []).filter((x) => x.status === 'ready');
  const results = [];
  for (let pass = 0; pass < 3 && todo.length; pass++) {
    if (pass) await new Promise((r) => setTimeout(r, retryDelayMs));
    const busy = [];
    for (const it of todo) {
      try {
        const out = await _inTx(db, lockTimeoutMs, (client) => _foldOne(client, { ownerId: it.ownerId, sig: it.sig, by: tag, runId: applyRunId }));
        results.push({ ownerId: it.ownerId, index: it.index, ...out });
      } catch (err) {
        if (err && (err.code === '55P03' || err.code === '40P01')) { busy.push(it); continue; }   // 잠금 대기·교착 = 다시
        const code = err && err.code === '23505' ? 'already_decided' : (err && err.code) || 'failed';
        results.push({ ownerId: it.ownerId, index: it.index, result: 'failed', code, error: String(err && err.message || err).slice(0, 160) });
      }
    }
    todo = busy;
  }
  for (const it of todo) results.push({ ownerId: it.ownerId, index: it.index, result: 'busy' });
  const count = (k) => results.filter((r) => r.result === k).length;
  const summary = { previewRunId: String(id), folded: count('folded'), alreadyDone: count('already_done'), stale: count('stale'),
    wait: count('wait'), busy: count('busy'), failed: count('failed'), noSelfCard: count('no_self_card'),
    ordersMoved: results.reduce((a, r) => a + (r.moved ? r.moved.orders : 0), 0),
    applicationsMoved: results.reduce((a, r) => a + (r.moved ? r.moved.applications : 0), 0),
    hashesShifted: results.reduce((a, r) => a + (r.moved ? r.moved.shifted : 0), 0) };
  await db.query(`UPDATE reviewer_identity_fold_runs SET finished_at = NOW(), summary = $2::jsonb, items = $3::jsonb WHERE id = $1`,
    [applyRunId, JSON.stringify(summary), JSON.stringify(results.map((r) => ({ ownerId: r.ownerId, index: r.index, result: r.result,
      decisionId: r.decisionId || null, code: r.code || null, reasons: r.reasons || null })))]);
  logger.info(`[identity-fold] apply run=${applyRunId} ${JSON.stringify(summary)}`);
  return { ok: true, applyRunId, summary, results };
}

/**
 * 정리 하나 되돌리기(호출자 트랜잭션 안) — 카드를 먼저 다시 살린 **다음에** 칸을 원래 자리에 넣는다
 * (거꾸로 하면 거울이 merged 카드 때문에 새 카드를 만들지 않아 칸만 남는다).
 * 주문·참여 기록은 **지금 값이 정리 때 쓴 값일 때만** 되돌린다(그 뒤 바뀐 행은 둔다).
 */
async function undoFoldInTx(client, d) {
  const snap = d.snapshot || {};
  const sub = { ...(snap.sub || {}) };
  const { rows: [owner] } = await client.query(`SELECT id, resident_num, sub_accounts FROM reviewers WHERE id = $1 FOR NO KEY UPDATE`, [d.owner_reviewer_id]);
  if (!owner) return { result: 'gone' };
  if (snap.juminSameAsOwner) sub.jumin = owner.resident_num || '';
  const restored = { card: false, slot: false, rows: 0 };
  if (snap.subCardId) {
    await client.query(`SELECT id FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 FOR NO KEY UPDATE`, [d.owner_reviewer_id]);
    const sp = 'fold_undo_card';
    await client.query(`SAVEPOINT ${sp}`);
    try {
      const r = await client.query(
        `UPDATE reviewer_identity_cards SET status = 'active', merged_into = NULL, updated_at = NOW(), record_version = record_version + 1
          WHERE id = $1 AND status = 'merged'`, [snap.subCardId]);
      restored.card = r.rowCount > 0;
      await client.query(`RELEASE SAVEPOINT ${sp}`);
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      if (!err || err.code !== '23505') throw err;     // 같은 이름·번호 카드가 이미 살아 있다 — 그 카드를 쓴다
    }
  }
  const out = await cards.mutateSubAccountsInTx(client, d.owner_reviewer_id, (list) => {
    if (list.some((s) => s && nk(s.name) === nk(sub.name) && p8(s.phone) === p8(sub.phone))) return null;
    const sigs = list.map((s) => (s && typeof s === 'object' ? sigHash(s.name, s.phone) : null));
    let at = -1;
    if (snap.prevSig && sigs.indexOf(snap.prevSig) >= 0) at = sigs.indexOf(snap.prevSig) + 1;
    else if (snap.nextSig && sigs.indexOf(snap.nextSig) >= 0) at = sigs.indexOf(snap.nextSig);
    else if (!snap.prevSig) at = 0;
    if (at < 0) at = Math.min(Math.max(0, Number(snap.index) || 0), list.length);
    list.splice(at, 0, sub);
    return list;
  }, { source: 'fold_undo' });
  restored.slot = !!out.changed;
  const { rows: moves } = await client.query(
    `SELECT table_name, row_id, old_card_id, new_card_id, old_hash, new_hash FROM reviewer_identity_fold_moves WHERE decision_id = $1 ORDER BY id DESC`, [d.id]);
  for (const m of moves) {
    if (m.table_name === 'order_submissions') {
      const r = await client.query(
        `UPDATE order_submissions SET participant_card_id = $2, participant_identity_key_hash = $3
          WHERE id = $1::uuid AND participant_card_id IS NOT DISTINCT FROM $4 AND participant_identity_key_hash IS NOT DISTINCT FROM $5`,
        [m.row_id, m.old_card_id, m.old_hash, m.new_card_id, m.new_hash]);
      restored.rows += r.rowCount;
    } else {
      const r = await client.query(
        `UPDATE campaign_applications SET participant_card_id = $2 WHERE id = $1::int AND participant_card_id IS NOT DISTINCT FROM $3`,
        [m.row_id, m.old_card_id, m.new_card_id]);
      restored.rows += r.rowCount;
    }
  }
  return { result: 'undone', restored };
}

/** 한 실행이 만든 정리를 전부 되돌린다(비상 스위치 undo_all:<실행 번호>). */
async function undoRun({ applyRunId, db = pool, by = '자동 되돌리기', lockTimeoutMs = 2000 } = {}) {
  const id = Number(applyRunId);
  if (!Number.isSafeInteger(id) || id < 1) throw new IdentityFoldError('bad_run', '실행 번호가 올바르지 않습니다.');
  const { rows: list } = await db.query(
    // 같은 미리보기로 돈 실행 전부(중간에 끊겨 다시 돈 실행 포함)를 함께 되돌린다.
    `SELECT id FROM reviewer_identity_decisions
      WHERE kind = 'fold_self' AND undone_at IS NULL
        AND snapshot->>'runId' IN (
          SELECT a.id::text FROM reviewer_identity_fold_runs a
           WHERE a.mode = 'apply' AND (a.id = $1 OR a.summary->>'previewRunId' =
                 (SELECT b.summary->>'previewRunId' FROM reviewer_identity_fold_runs b WHERE b.id = $1 AND b.mode = 'apply')))
      ORDER BY id DESC`, [id]);
  const { rows: [me] } = await db.query(
    `INSERT INTO reviewer_identity_fold_runs (mode, summary) VALUES ('undo_all', $1::jsonb) RETURNING id`, [JSON.stringify({ applyRunId: String(id) })]);
  let undone = 0; const failed = [];
  for (const { id: decisionId } of list) {
    try {
      const out = await _inTx(db, lockTimeoutMs, async (client) => {
        const { rows: [d] } = await client.query(`SELECT * FROM reviewer_identity_decisions WHERE id = $1 FOR UPDATE`, [decisionId]);
        if (!d || d.undone_at) return { result: 'skip' };
        const r = await undoFoldInTx(client, d);
        await client.query(`UPDATE reviewer_identity_decisions SET undone_at = NOW(), undone_by = $2 WHERE id = $1`, [decisionId, String(by).slice(0, 80)]);
        return r;
      });
      if (out.result === 'undone') undone++;
    } catch (err) { failed.push({ decisionId: String(decisionId), code: (err && err.code) || 'failed' }); }
  }
  const summary = { applyRunId: String(id), targets: list.length, undone, failed: failed.length };
  await db.query(`UPDATE reviewer_identity_fold_runs SET finished_at = NOW(), summary = $2::jsonb, items = $3::jsonb WHERE id = $1`,
    [me.id, JSON.stringify(summary), JSON.stringify(failed)]);
  logger.info(`[identity-fold] undo_all run=${me.id} ${JSON.stringify(summary)}`);
  return { ok: true, undoRunId: String(me.id), summary };
}

/** 스위치 값 해석 — 모르는 값은 아무것도 하지 않는다(fail-closed). */
function parseMode(raw) {
  const v = String(raw || '').trim();
  if (!v || v === 'off') return { mode: 'off' };
  if (v === 'preview') return { mode: 'preview' };
  let m = /^apply:(\d+)$/.exec(v);
  if (m) return { mode: 'apply', runId: m[1] };
  m = /^undo_all:(\d+)$/.exec(v);
  if (m) return { mode: 'undo_all', runId: m[1] };
  return { mode: 'invalid' };
}

/**
 * 기동 때 한 번 — 스위치 값대로 실행한다. 여러 인스턴스가 떠도 한 번만(작업 잠금 · 끝난 실행은 다시 하지 않음).
 * ★ 실패해도 서버 기동·다른 작업에 영향 0(로그만).
 */
async function runFromSwitch({ db = pool, env = process.env } = {}) {
  const sw = parseMode(env.SAME_PHONE_FOLD_MODE);
  if (sw.mode === 'off') return { ok: true, skipped: 'off' };
  if (sw.mode === 'invalid') { logger.warn('[identity-fold] SAME_PHONE_FOLD_MODE 값을 알 수 없어 아무것도 하지 않습니다'); return { ok: false, skipped: 'invalid' }; }
  const { withJobLock } = require('../utils/jobLock');
  const r = await withJobLock('identity_fold_switch', async () => {
    if (sw.mode === 'preview') {
      // 같은 날 이미 미리보기가 있으면 재기동마다 쌓지 않는다(1시간 안 · 한 번).
      const { rows } = await db.query(`SELECT id FROM reviewer_identity_fold_runs WHERE mode = 'preview' AND started_at > NOW() - INTERVAL '1 hour' LIMIT 1`);
      if (rows.length) return { ok: true, skipped: 'recent_preview', runId: String(rows[0].id) };
      return preview({ db });
    }
    if (sw.mode === 'apply') {
      const { rows } = await db.query(
        `SELECT id FROM reviewer_identity_fold_runs WHERE mode = 'apply' AND summary->>'previewRunId' = $1 AND finished_at IS NOT NULL LIMIT 1`, [sw.runId]);
      if (rows.length) return { ok: true, skipped: 'already_applied', runId: String(rows[0].id) };
      return apply({ previewRunId: sw.runId, db });
    }
    const { rows } = await db.query(
      `SELECT id FROM reviewer_identity_fold_runs WHERE mode = 'undo_all' AND summary->>'applyRunId' = $1 AND finished_at IS NOT NULL LIMIT 1`, [sw.runId]);
    if (rows.length) return { ok: true, skipped: 'already_undone', runId: String(rows[0].id) };
    return undoRun({ applyRunId: sw.runId, db });
  });
  return r;
}

// ── 본계정 로그인 팝업(사용자 확정 2026-10-13) ───────────────────────────────
/** 그 소유자의 아직 안 본 정리 안내 — 합친 타계정 이름(본인 계정에만 보여 준다). */
async function pendingNotice(ownerId, { db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT d.id, d.snapshot->'sub'->>'name' AS sub_name, r.name AS owner_name
       FROM reviewer_identity_decisions d JOIN reviewers r ON r.id = d.owner_reviewer_id
      WHERE d.kind = 'fold_self' AND d.owner_reviewer_id = $1 AND d.undone_at IS NULL AND d.notice_dismissed_at IS NULL
      ORDER BY d.id`, [ownerId]);
  if (!rows.length) return { ok: true, notice: null };
  const names = [...new Set(rows.map((x) => String(x.sub_name || '').trim()).filter(Boolean))];
  return { ok: true, notice: { ownerName: String(rows[0].owner_name || '').trim(), subNames: names } };
}

/** 다시 보지 않기 — 그 소유자의 열린 정리 안내를 모두 본 것으로. */
async function dismissNotice(ownerId, { db = pool } = {}) {
  const r = await db.query(
    `UPDATE reviewer_identity_decisions SET notice_dismissed_at = NOW()
      WHERE kind = 'fold_self' AND owner_reviewer_id = $1 AND undone_at IS NULL AND notice_dismissed_at IS NULL`, [ownerId]);
  return { ok: true, dismissed: r.rowCount };
}

module.exports = {
  IdentityFoldError, classifyOwner, preview, apply, undoFoldInTx, undoRun, parseMode, runFromSwitch,
  pendingNotice, dismissNotice, _test: { legacyKey, sigHash, groupKeyOf, SELF_HASH },
};
