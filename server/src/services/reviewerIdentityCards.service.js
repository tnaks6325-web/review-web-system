/*
 * 명의 카드 — 2단계 조각 1 (migration 166 · 결정 기록 175).
 *
 * reviewers(본인) + reviewers.sub_accounts(타계정 목록)를 읽어 명의마다 카드 한 장을 만든다.
 * ★ 이 조각에서는 아무도 카드를 읽지 않는다. sub_accounts 는 한 글자도 바꾸지 않는다.
 * ★ 카드 구분은 고유 번호(UUID)다. 칸 순번·전화번호로 사람을 구분하지 않는다
 *   (가족이 같은 번호를 쓰는 명의 허용 — 사용자 확정 2026-09-24 결정 1가).
 * ★ 이름·번호가 완전히 같은 칸만 한 장으로 합친다. 이름만 같고 번호가 다른 칸은 따로 만들고
 *   "같은 사람일 수 있음"으로 보고한다 — 합치기는 담당자가 한다(결정 2가).
 * ★ 주민번호는 옮기지 않는다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const CARD_FIELDS = ['address', 'bank_name', 'bank_account', 'account_holder', 'shopping_id', 'income_name'];

function nameKey(value) { return String(value || '').replace(/\s+/g, ''); }
function phone8Of(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}
function str(v) { return v == null ? '' : String(v).trim(); }
function asSubs(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return asSubs(JSON.parse(value)); } catch (_) { return []; } }
  return [];
}
function sigOf(card) { return `${card.nameKey}|${card.phone8}`; }

/** 한 소유자의 카드 목록과 사람 확인이 필요한 사항을 만든다(순수 함수 · DB 미접근). */
function buildCardsFromReviewer(reviewer) {
  const cards = [];
  const issues = [];
  const bySig = new Map();
  const add = (card) => {
    const sig = sigOf(card);
    const existing = bySig.get(sig);
    if (existing) {
      // 완전 중복 = 같은 명의. 빈 칸만 채우고, 값이 서로 다르면 사람이 보도록 남긴다.
      const conflicts = [];
      for (const f of CARD_FIELDS) {
        if (!existing[f] && card[f]) existing[f] = card[f];
        else if (existing[f] && card[f] && existing[f] !== card[f]) conflicts.push(f);
      }
      issues.push({ code: 'exact_duplicate', sourceIndex: card.sourceIndex, keptIndex: existing.sourceIndex, conflicts });
      return;
    }
    bySig.set(sig, card);
    cards.push(card);
  };
  const selfName = str(reviewer && reviewer.name);
  if (selfName) {
    add({
      kind: 'self', name: selfName, nameKey: nameKey(selfName),
      phone: str(reviewer.phone), phone8: phone8Of(reviewer.phone),
      address: str(reviewer.address), bank_name: str(reviewer.bank_name), bank_account: str(reviewer.bank_account),
      account_holder: str(reviewer.account_holder), shopping_id: str(reviewer.shopping_id), income_name: str(reviewer.income_type),
      sourceIndex: null,
    });
  } else {
    issues.push({ code: 'self_missing_name' });
  }
  asSubs(reviewer && reviewer.sub_accounts).forEach((sub, index) => {
    const name = str(sub && sub.name);
    const p8 = phone8Of(sub && sub.phone);
    if (!name || !p8) { issues.push({ code: !name ? 'missing_name' : 'missing_phone', sourceIndex: index }); return; }
    add({
      kind: 'sub', name, nameKey: nameKey(name), phone: str(sub.phone), phone8: p8,
      address: str(sub.address), bank_name: str(sub.bankName || sub.bank_name), bank_account: str(sub.bankAccount || sub.bank_account),
      account_holder: str(sub.accountHolder || sub.account_holder), shopping_id: str(sub.shoppingId || sub.shopping_id),
      income_name: str(sub.incomeName || sub.income_name), sourceIndex: index,
    });
  });
  // 이름만 같고 번호가 다른 카드 = 같은 사람일 수 있음(조각 4 합치기 후보). 자동으로 합치지 않는다.
  const byName = new Map();
  for (const c of cards) {
    if (!byName.has(c.nameKey)) byName.set(c.nameKey, []);
    byName.get(c.nameKey).push(c);
  }
  for (const group of byName.values()) {
    if (group.length > 1) issues.push({ code: 'same_name_diff_phone', sourceIndexes: group.map((c) => c.sourceIndex) });
  }
  return { cards, issues };
}

async function _allReviewers(db) {
  const { rows } = await db.query(
    `SELECT id, name, phone, address, bank_name, bank_account, account_holder, shopping_id, income_type, sub_accounts
       FROM reviewers ORDER BY registered_at NULLS LAST, id`);
  return rows;
}

/** 미리보기 — 쓰기 0. 카드 몇 장이 생기고 사람 확인이 몇 건인지 센다. */
async function previewCards({ db = pool } = {}) {
  const reviewers = await _allReviewers(db);
  let carded = new Set();
  try {
    const { rows } = await db.query(`SELECT DISTINCT owner_reviewer_id FROM reviewer_identity_cards WHERE status = 'active'`);
    carded = new Set(rows.map((r) => String(r.owner_reviewer_id)));
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  const summary = {
    owners: reviewers.length, ownersAlreadyCarded: 0, cards: 0, selfCards: 0, subCards: 0,
    exactDuplicatesCollapsed: 0, exactDuplicatesWithDifferentValues: 0,
    sameNameDiffPhoneOwners: 0, sharedPhoneFamilyOwners: 0, crossOwnerPhones: 0, skippedEntries: 0,
  };
  const phoneOwners = new Map();
  for (const r of reviewers) {
    if (carded.has(String(r.id))) summary.ownersAlreadyCarded++;
    const { cards, issues } = buildCardsFromReviewer(r);
    summary.cards += cards.length;
    summary.selfCards += cards.filter((c) => c.kind === 'self').length;
    summary.subCards += cards.filter((c) => c.kind === 'sub').length;
    for (const i of issues) {
      if (i.code === 'exact_duplicate') {
        summary.exactDuplicatesCollapsed++;
        if (i.conflicts.length) summary.exactDuplicatesWithDifferentValues++;
      } else if (i.code === 'missing_name' || i.code === 'missing_phone' || i.code === 'self_missing_name') {
        summary.skippedEntries++;
      }
    }
    if (issues.some((i) => i.code === 'same_name_diff_phone')) summary.sameNameDiffPhoneOwners++;
    const p8s = cards.map((c) => c.phone8).filter(Boolean);
    if (new Set(p8s).size < p8s.length) summary.sharedPhoneFamilyOwners++;
    for (const p8 of new Set(p8s)) {
      if (!phoneOwners.has(p8)) phoneOwners.set(p8, new Set());
      phoneOwners.get(p8).add(String(r.id));
    }
  }
  for (const owners of phoneOwners.values()) if (owners.size > 1) summary.crossOwnerPhones++;
  return { ok: true, preview: true, summary };
}

// ── 조각 2-1: 카드 = sub_accounts(JSON)의 거울 ─────────────────────────────
// JSON 이 진실원본이다(아직 아무도 카드를 읽지 않는다). 카드는 JSON 을 따라간다 — 값이 바뀌면 덮고,
// 사라진 명의는 'removed', 돌아온 명의는 같은 카드를 되살린다(번호 유지).
// ★ 순서가 계약이다(유일 인덱스 23505 방지 — 레드팀 2026-09-24):
//   ① 본인 명의와 같아진 타계정 카드 제거 → ② 사라진 타계정 카드 제거 → ③ 본인 카드 제자리 갱신(또는 되살림·생성)
//   → ④ 남은 타계정 갱신 → ⑤ 되살림 → ⑥ 새로 만들기.
// ★ 본인 카드는 절대 제거하지 않는다(이름이 비면 그대로 둔다 — 제거 후 재생성하면 번호가 바뀐다).
// ★ 담당자가 합친('merged') 카드의 명의는 JSON 에 남아 있어도 다시 만들지 않는다(합치기가 밤새 무너지지 않게).
const MIRROR_FIELDS = ['name', 'phone', ...CARD_FIELDS];

function _cardSig(c) { return `${c.name_key != null ? c.name_key : c.nameKey}|${c.phone8}`; }
function _mostRecent(list) {
  // ★ pg 는 updated_at 을 Date 로 준다 — 문자열 비교는 요일부터 비교해 최신을 못 고른다(Codex P2). 시각 숫자로 비교.
  const t = (v) => { const n = v instanceof Date ? v.getTime() : Date.parse(v || ''); return Number.isFinite(n) ? n : 0; };
  return list.slice().sort((a, b) => t(b.updated_at) - t(a.updated_at))[0] || null;
}
function _diff(existing, want) {
  const set = {};
  for (const f of MIRROR_FIELDS) if (String(existing[f] == null ? '' : existing[f]) !== String(want[f] == null ? '' : want[f])) set[f] = want[f];
  return set;
}

/**
 * 한 소유자의 카드를 JSON 에 맞추는 계획(순수 함수 · DB 미접근).
 * @param reviewer reviewers 행
 * @param existing 그 소유자의 모든 카드(상태 무관): {id, kind, status, name, name_key, phone, phone8, ...fields, updated_at}
 * @returns ops 배열 — 적용 순서 그대로.
 */
function planOwnerSync(reviewer, existing) {
  const { cards: want } = buildCardsFromReviewer(reviewer);
  const ops = [];
  const active = existing.filter((c) => c.status === 'active');
  const removedIds = new Set();
  const wantSelf = want.find((c) => c.kind === 'self') || null;
  const wantSubs = want.filter((c) => c.kind === 'sub');
  const activeSelf = active.find((c) => c.kind === 'self') || null;
  const selfSig = wantSelf ? _cardSig(wantSelf) : (activeSelf ? _cardSig(activeSelf) : null);
  const wantSubSigs = new Set(wantSubs.map(_cardSig));
  const mergedSigs = new Set(existing.filter((c) => c.status === 'merged').map(_cardSig));
  const remove = (c, reason) => { if (!removedIds.has(c.id)) { removedIds.add(c.id); ops.push({ op: 'remove', id: c.id, reason }); } };

  // ① 본인 명의와 같아진 타계정 카드 → 제거(본인 카드가 그 명의를 가진다)
  if (selfSig) for (const c of active) if (c.kind === 'sub' && _cardSig(c) === selfSig) remove(c, 'became_self');
  // ② JSON 에서 사라진 타계정 카드 → 제거
  for (const c of active) if (c.kind === 'sub' && !wantSubSigs.has(_cardSig(c))) remove(c, 'gone');
  // ③ 본인 카드
  if (wantSelf) {
    const row = { name: wantSelf.name, name_key: wantSelf.nameKey, phone: wantSelf.phone, phone8: wantSelf.phone8 };
    for (const f of CARD_FIELDS) row[f] = wantSelf[f];
    if (activeSelf) {
      const set = _diff(activeSelf, row);
      if (activeSelf.name_key !== row.name_key) set.name_key = row.name_key;
      if (activeSelf.phone8 !== row.phone8) set.phone8 = row.phone8;
      if (Object.keys(set).length) ops.push({ op: 'update', id: activeSelf.id, set });
    } else {
      const back = _mostRecent(existing.filter((c) => c.kind === 'self' && c.status === 'removed'));
      if (back) ops.push({ op: 'reactivate', id: back.id, kind: 'self', set: row });
      else ops.push({ op: 'insert', card: wantSelf });
    }
  }
  // ④⑤⑥ 타계정
  for (const w of wantSubs) {
    const sig = _cardSig(w);
    if (sig === selfSig) continue;                      // 본인 명의와 같은 칸은 본인 카드가 가진다
    const row = { name: w.name, phone: w.phone };
    for (const f of CARD_FIELDS) row[f] = w[f];
    const cur = active.find((c) => c.kind === 'sub' && _cardSig(c) === sig && !removedIds.has(c.id));
    if (cur) {
      const set = _diff(cur, row);
      if (Object.keys(set).length) ops.push({ op: 'update', id: cur.id, set });
      continue;
    }
    if (mergedSigs.has(sig)) continue;                  // 합쳐진 명의 — 다시 만들지 않는다
    const back = _mostRecent(existing.filter((c) => c.status === 'removed' && _cardSig(c) === sig));
    if (back) ops.push({ op: 'reactivate', id: back.id, kind: 'sub', set: { ...row, name_key: w.nameKey, phone8: w.phone8 } });
    else ops.push({ op: 'insert', card: w });
  }
  // 순서 고정: 제거 → 본인 → 갱신 → 되살림 → 생성
  const rank = (o) => (o.op === 'remove' ? 0 : (o.kind === 'self' || (o.card && o.card.kind === 'self') || (activeSelf && o.id === activeSelf.id)) ? 1
    : o.op === 'update' ? 2 : o.op === 'reactivate' ? 3 : 4);
  return ops.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o);
}

async function _applyOps(client, ownerId, ops, source) {
  const counts = { inserted: 0, updated: 0, removed: 0, reactivated: 0 };
  for (const o of ops) {
    if (o.op === 'remove') {
      await client.query(`UPDATE reviewer_identity_cards SET status = 'removed', updated_at = NOW(), record_version = record_version + 1
                           WHERE id = $1 AND status = 'active'`, [o.id]);
      counts.removed++;
    } else if (o.op === 'update' || o.op === 'reactivate') {
      const cols = Object.keys(o.set);
      const params = [o.id, ...cols.map((c) => o.set[c])];
      const sets = cols.map((c, i) => `${c} = $${i + 2}`);
      if (o.op === 'reactivate') { params.push(o.kind); sets.push(`status = 'active'`, `kind = $${params.length}`); }
      await client.query(`UPDATE reviewer_identity_cards SET ${sets.join(', ')}, updated_at = NOW(), record_version = record_version + 1
                           WHERE id = $1`, params);
      counts[o.op === 'update' ? 'updated' : 'reactivated']++;
    } else if (o.op === 'insert') {
      const c = o.card;
      await client.query(
        `INSERT INTO reviewer_identity_cards
           (owner_reviewer_id, kind, name, name_key, phone, phone8, ${CARD_FIELDS.join(', ')}, source, source_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [ownerId, c.kind, c.name, c.nameKey, c.phone, c.phone8, ...CARD_FIELDS.map((f) => c[f]), source, c.sourceIndex]);
      counts.inserted++;
    }
  }
  return counts;
}

const CARD_SELECT = `SELECT id, kind, status, name, name_key, phone, phone8, ${CARD_FIELDS.join(', ')}, updated_at FROM reviewer_identity_cards`;

/**
 * 한 소유자의 카드를 JSON 에 맞춘다(호출자가 연 트랜잭션 안 · 호출자가 reviewers 행을 먼저 잠근다).
 * ★ 잠금 순서 = reviewers 행 먼저, 카드 나중(순환 대기 방지).
 */
async function syncOwnerCards(client, reviewer, { source = 'sync' } = {}) {
  const { rows: existing } = await client.query(`${CARD_SELECT} WHERE owner_reviewer_id = $1 FOR UPDATE`, [reviewer.id]);
  const ops = planOwnerSync(reviewer, existing);
  if (!ops.length) return { inserted: 0, updated: 0, removed: 0, reactivated: 0 };
  return _applyOps(client, reviewer.id, ops, source);
}

const REVIEWER_SELECT = `SELECT id, name, phone, address, bank_name, bank_account, account_holder, shopping_id, income_type, sub_accounts FROM reviewers`;

/**
 * 전수 대조 — 카드가 JSON 과 다른 리뷰어만 골라 맞춘다(10분 주기 · 저장 경로 19곳은 건드리지 않는다).
 * dryRun 이면 쓰지 않고 수만 센다. 소유자마다 짧은 트랜잭션 + lock_timeout(제출·결제와 오래 부딪히지 않게).
 * ★ 잠금은 FOR NO KEY UPDATE — 같은 리뷰어의 주문·참여 기록 INSERT(외래키 FOR KEY SHARE)를 막지 않는다.
 */
async function reconcileCards({ db = pool, dryRun = true, by = '', lockTimeoutMs = 2000 } = {}) {
  const [{ rows: reviewers }, { rows: cards }] = await Promise.all([
    db.query(REVIEWER_SELECT),
    db.query(`${CARD_SELECT.replace('SELECT id,', 'SELECT owner_reviewer_id, id,')}`),
  ]);
  const byOwner = new Map();
  for (const c of cards) {
    const k = String(c.owner_reviewer_id);
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(c);
  }
  const drifted = reviewers.filter((r) => planOwnerSync(r, byOwner.get(String(r.id)) || []).length > 0);
  const out = { ok: true, dryRun: !!dryRun, reviewers: reviewers.length, drifted: drifted.length,
    fixed: 0, inserted: 0, updated: 0, removed: 0, reactivated: 0, busy: 0, failed: [] };
  if (dryRun || !drifted.length) return out;
  for (const r of drifted) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${Math.max(100, Number(lockTimeoutMs) || 2000)}ms`]);
      const { rows } = await client.query(`${REVIEWER_SELECT} WHERE id = $1 FOR NO KEY UPDATE`, [r.id]);
      if (rows.length) {
        const c = await syncOwnerCards(client, rows[0], { source: 'reconcile' });
        for (const k of ['inserted', 'updated', 'removed', 'reactivated']) out[k] += c[k];
      }
      await client.query('COMMIT');
      out.fixed++;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      if (err && err.code === '42P01') { client.release(); throw err; }
      if (err && err.code === '55P03') out.busy++;          // 잠금 대기 초과 = 다음 주기에 다시
      else out.failed.push({ ownerId: r.id, code: err.code || '', error: String(err.message || err).slice(0, 200) });
    }
    client.release();
  }
  if (out.failed.length) {
    logger.warn(`[identity-cards] reconcile 실패 ${out.failed.length}건: ${out.failed.slice(0, 5).map((f) => `${f.ownerId}:${f.code}`).join(', ')}`);
  }
  logger.info(`[identity-cards] reconcile by=${String(by).slice(0, 40)} drifted=${out.drifted} fixed=${out.fixed} ins=${out.inserted} upd=${out.updated} rm=${out.removed} re=${out.reactivated} busy=${out.busy} failed=${out.failed.length}`);
  return out;
}

/** 적용 — confirm:true 일 때만 쓴다. 소유자마다 한 트랜잭션. 여러 번 돌려도 결과가 같다. */
async function applyCards({ db = pool, confirm = false, limit = 500, afterId = null, by = '' } = {}) {
  if (confirm !== true) return { ok: false, code: 'confirm_required', error: '미리보기를 확인한 뒤 confirm:true 로 적용하세요.' };
  if (afterId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(afterId))) {
    return { ok: false, code: 'bad_after_id', error: 'afterId 형식이 올바르지 않습니다.' };
  }
  const cap = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const { rows: ids } = await db.query(
    `SELECT id FROM reviewers WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`, [afterId, cap]);
  const out = { ok: true, owners: 0, inserted: 0, filled: 0, failed: [], nextAfterId: null };
  for (const { id } of ids) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // 소유자 행을 잠가 그 사이 sub_accounts 가 바뀌지 않게 한다.
      const { rows } = await client.query(
        `SELECT id, name, phone, address, bank_name, bank_account, account_holder, shopping_id, income_type, sub_accounts
           FROM reviewers WHERE id = $1 FOR UPDATE`, [id]);
      if (rows.length) {
        const r = await syncOwnerCards(client, rows[0], { source: 'backfill' });
        out.inserted += r.inserted; out.filled += r.updated + r.reactivated;
      }
      await client.query('COMMIT');
      out.owners++;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      // 표가 없으면(migration 166 미적용) 모든 소유자가 같은 이유로 실패한다 — 건별 실패로 삼키면
      // ok:true + 다음 커서가 나가 백필 전체를 건너뛴 채 성공처럼 보인다(PR #1488 리뷰 P2). 멈추고 올린다.
      if (err && err.code === '42P01') { client.release(); throw err; }
      out.failed.push({ ownerId: id, code: err.code || '', error: String(err.message || err).slice(0, 200) });
    }
    client.release();
    out.nextAfterId = id;
  }
  if (ids.length < cap) out.nextAfterId = null;
  logger.info(`[identity-cards] apply by=${String(by).slice(0, 80)} owners=${out.owners} inserted=${out.inserted} filled=${out.filled} failed=${out.failed.length}`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 조각 2-2 — 타계정 목록 쓰기 창구 하나 (결정 기록 177)
// ★ 쓰는 곳 8곳이 각자 "읽기 → 고치기 → 통째로 저장"을 잠금 없이 해 왔다(동시 저장 한쪽 유실 ·
//   칸 순번으로 대상 지목). 여기 한 곳으로 모은다: 잠금 → 다시 읽기 → 고치기 → id 로 저장 → 카드 맞추기.
// ★ 잠금은 FOR NO KEY UPDATE — 같은 리뷰어의 주문·참여 INSERT(외래키 FOR KEY SHARE)를 막지 않는다.
// ★ 카드 맞추기 실패는 저장을 되돌리지 않는다(SAVEPOINT 격리 · 10분 거울이 따라잡는다).
// ─────────────────────────────────────────────────────────────────────────────

/** 이름(공백 무시)+번호 뒤8자리로 타계정 칸을 찾는다. 같은 이름·번호가 둘이면 -1(모름 = 쓰지 않음). */
function findSubIndex(subs, name, phone) {
  const nk = nameKey(name); const p8 = phone8Of(phone);
  if (!nk || !p8) return -1;
  const hits = [];
  asSubs(subs).forEach((s, i) => { if (nameKey(s && s.name) === nk && phone8Of(s && s.phone) === p8) hits.push(i); });
  return hits.length === 1 ? hits[0] : -1;
}

/**
 * 카드를 지금 리뷰어 행에 맞춘다(호출자 트랜잭션 안 · 호출자가 이미 그 행을 잠갔다고 가정).
 * 절대 throw 하지 않는다 — 실패하면 SAVEPOINT 로 되돌리고 { ok:false } 만 돌려준다.
 */
async function syncCardsAfterWrite(client, reviewerId, { source = 'write' } = {}) {
  const sp = 'ic_sync_' + Math.random().toString(36).slice(2, 8);
  try {
    await client.query(`SAVEPOINT ${sp}`);
    const { rows } = await client.query(`${REVIEWER_SELECT} WHERE id = $1`, [reviewerId]);
    const out = rows.length ? await syncOwnerCards(client, rows[0], { source }) : null;
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return { ok: true, ...(out || {}) };
  } catch (err) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); await client.query(`RELEASE SAVEPOINT ${sp}`); } catch (_) { /* noop */ }
    logger.warn(`[identity-cards] 저장 후 카드 맞추기 실패(저장은 유지 · 거울이 따라잡음): ${err.code || ''} ${err.message}`);
    return { ok: false, code: err.code || null };
  }
}

/**
 * 타계정 목록을 안전하게 고친다(호출자 트랜잭션 안).
 * mutate(subs, reviewer) — 고친 배열을 돌려주면 저장, null/undefined 면 바꾸지 않음, throw 하면 그대로 올린다.
 * @returns { changed, reviewer, subs, cards }
 */
async function mutateSubAccountsInTx(client, reviewerId, mutate, { source = 'write' } = {}) {
  const { rows } = await client.query(`${REVIEWER_SELECT} WHERE id = $1 FOR NO KEY UPDATE`, [reviewerId]);
  if (!rows.length) { const e = new Error('리뷰어를 찾을 수 없습니다.'); e.code = 'reviewer_not_found'; throw e; }
  const reviewer = rows[0];
  const current = asSubs(reviewer.sub_accounts).map((s) => (s && typeof s === 'object' ? { ...s } : s));
  const next = await mutate(current, reviewer);
  if (!Array.isArray(next)) return { changed: false, reviewer, subs: asSubs(reviewer.sub_accounts), cards: null };
  const same = JSON.stringify(next) === JSON.stringify(asSubs(reviewer.sub_accounts));
  if (same) return { changed: false, reviewer, subs: next, cards: null };
  await client.query('UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1', [reviewerId, JSON.stringify(next)]);
  const cards = await syncCardsAfterWrite(client, reviewerId, { source });
  return { changed: true, reviewer, subs: next, cards };
}

/** 자기 트랜잭션을 여는 판. */
async function mutateSubAccounts(reviewerId, mutate, opts = {}) {
  const client = await (opts.db || pool).connect();
  try {
    await client.query('BEGIN');
    const out = await mutateSubAccountsInTx(client, reviewerId, mutate, opts);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

module.exports = { buildCardsFromReviewer, previewCards, applyCards, syncOwnerCards, planOwnerSync, reconcileCards,
  findSubIndex, syncCardsAfterWrite, mutateSubAccountsInTx, mutateSubAccounts, _test: { nameKey, phone8Of } };
