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

/**
 * 한 소유자의 카드를 맞춘다(같은 트랜잭션 안에서). 이미 있는 카드는 빈 칸만 채우고,
 * 없는 명의는 새로 만든다. ★ 카드를 지우거나 값이 있는 칸을 덮지 않는다.
 */
async function syncOwnerCards(client, reviewer) {
  const { cards } = buildCardsFromReviewer(reviewer);
  const { rows: existing } = await client.query(
    `SELECT id, kind, name_key, phone8, ${CARD_FIELDS.join(', ')}
       FROM reviewer_identity_cards WHERE owner_reviewer_id = $1 AND status = 'active'`, [reviewer.id]);
  const bySig = new Map(existing.map((c) => [`${c.name_key}|${c.phone8}`, c]));
  let inserted = 0, filled = 0;
  for (const card of cards) {
    const found = bySig.get(sigOf(card));
    if (found) {
      const sets = [], params = [found.id];
      for (const f of CARD_FIELDS) {
        if (!found[f] && card[f]) { params.push(card[f]); sets.push(`${f} = $${params.length}`); }
      }
      if (sets.length) {
        await client.query(
          `UPDATE reviewer_identity_cards SET ${sets.join(', ')}, updated_at = NOW(), record_version = record_version + 1
            WHERE id = $1`, params);
        filled++;
      }
      continue;
    }
    // 본인 카드는 하나뿐 — 이름·번호가 바뀐 본인은 새 카드를 만들지 않고 건너뛴다(조각 2 에서 다룬다).
    if (card.kind === 'self' && existing.some((c) => c.kind === 'self')) continue;
    await client.query(
      `INSERT INTO reviewer_identity_cards
         (owner_reviewer_id, kind, name, name_key, phone, phone8, ${CARD_FIELDS.join(', ')}, source, source_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'backfill',$13)`,
      [reviewer.id, card.kind, card.name, card.nameKey, card.phone, card.phone8,
        ...CARD_FIELDS.map((f) => card[f]), card.sourceIndex]);
    inserted++;
  }
  return { inserted, filled };
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
        const r = await syncOwnerCards(client, rows[0]);
        out.inserted += r.inserted; out.filled += r.filled;
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

module.exports = { buildCardsFromReviewer, previewCards, applyCards, syncOwnerCards, _test: { nameKey, phone8Of } };
