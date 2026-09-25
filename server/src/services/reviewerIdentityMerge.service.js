/*
 * 명의 합치기 — 2단계 조각 4 (migration 167 · 결정 기록 179 · 사용자 확정 2026-09-25 모두 가).
 *
 * 등록리뷰어DB 에서 담당자가
 *   ① 한 리뷰어 밑의 "이름 같고 번호 다른 명의"를 합치거나(merge) 다른 사람으로 두고(keep_separate)
 *   ② 두 리뷰어에게 겹친 번호를 확인함으로 표시한다(shared_phone_ok — 메모만, 번호는 건드리지 않는다).
 *
 * ★ 합치기는 **카드만 merged 로 표시**하고 타계정 목록(sub_accounts)의 칸은 지우지 않는다(결정 2가) —
 *   옛 번호로도 로그인되고, 옛 번호로 참여한 내역도 그대로 보인다. 10분 거울은 merged 카드를 되살리지 않는다(176).
 * ★ 값은 남길 명의 우선, 빈 칸만 다른 명의 값으로 채운다(결정 1가) — 목록(진실원본)에 써야 거울이 덮지 않는다.
 * ★ 본인 명의는 합쳐 없앨 수 없다(로그인 계정). 본인이 낀 묶음은 항상 본인이 남는다.
 * ★ 합치는 사이 명의 구성이 바뀌었으면(stale) 쓰지 않는다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const cards = require('./reviewerIdentityCards.service');

class IdentityMergeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// 합칠 때 빈 칸을 채우는 항목 — 카드 칸 → (타계정 목록 키, 리뷰어 칸)
const FILL_FIELDS = [
  { card: 'address', sub: 'address', owner: 'address' },
  { card: 'bank_name', sub: 'bankName', owner: 'bank_name' },
  { card: 'bank_account', sub: 'bankAccount', owner: 'bank_account' },
  { card: 'account_holder', sub: 'accountHolder', owner: 'account_holder' },
  { card: 'shopping_id', sub: 'shoppingId', owner: 'shopping_id' },
];
const blank = (v) => String(v == null ? '' : v).trim() === '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 묶음 키 — 그 순간의 명의 구성(번호 정렬). 구성이 바뀌면 키가 달라져 다시 목록에 뜬다. */
function dupGroupKey(ownerId, nameKey, phone8s) {
  return `dup|${ownerId}|${nameKey}|${[...new Set(phone8s)].sort().join(',')}`;
}
function sharedGroupKey(phone8, ownerIds) {
  return `shared|${phone8}|${[...new Set(ownerIds.map(String))].sort().join(',')}`;
}

async function _openDecisionKeys(db, kinds) {
  const { rows } = await db.query(
    `SELECT group_key FROM reviewer_identity_decisions WHERE undone_at IS NULL AND kind = ANY($1::text[])`, [kinds]);
  return new Set(rows.map((r) => r.group_key));
}

/** 참여 수·마지막 참여 — 구매 원장(order_submissions) 기준. 소유자가 비어 있는 옛 기록도 번호로 센다. */
async function _participation(db, pairs) {
  if (!pairs.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.owner, p.p8, COUNT(os.id)::int AS n, MAX(os.submitted_at) AS last_at
       FROM unnest($1::uuid[], $2::text[]) AS p(owner, p8)
       LEFT JOIN order_submissions os
         ON os.deleted_at IS NULL
        AND RIGHT(REGEXP_REPLACE(COALESCE(os.phone, ''), '\\D', '', 'g'), 8) = p.p8
        AND (os.owner_reviewer_id = p.owner OR os.owner_reviewer_id IS NULL)
      GROUP BY p.owner, p.p8`,
    [pairs.map((x) => x.owner), pairs.map((x) => x.p8)]);
  return new Map(rows.map((r) => [`${r.owner}|${r.p8}`, { count: r.n, lastAt: r.last_at }]));
}

const _cardView = (c, part) => ({
  cardId: String(c.id), kind: c.kind, name: c.name, phone: c.phone, phone8: c.phone8,
  hasAddress: !blank(c.address), hasBank: !blank(c.bank_account),
  participation: part ? part.count : 0, lastParticipatedAt: part ? part.lastAt : null,
});

/** ① 중복 의심 명의 — 한 리뷰어 밑의 이름 같고 번호 다른 활성 카드 묶음(판단한 묶음 제외). */
async function listDuplicateGroups({ db = pool, limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT c.owner_reviewer_id AS owner, r.name AS owner_name, c.name_key,
            json_agg(json_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'phone', c.phone, 'phone8', c.phone8,
                     'address', c.address, 'bank_account', c.bank_account) ORDER BY c.kind DESC, c.created_at) AS cards
       FROM reviewer_identity_cards c JOIN reviewers r ON r.id = c.owner_reviewer_id
      WHERE c.status = 'active'
      GROUP BY c.owner_reviewer_id, r.name, c.name_key
     HAVING COUNT(DISTINCT c.phone8) > 1`);
  const decided = await _openDecisionKeys(db, ['merge', 'keep_separate']);
  const groups = rows
    .map((g) => ({ ...g, groupKey: dupGroupKey(g.owner, g.name_key, g.cards.map((c) => c.phone8)) }))
    .filter((g) => !decided.has(g.groupKey));
  const pairs = [];
  for (const g of groups) for (const c of g.cards) pairs.push({ owner: g.owner, p8: c.phone8 });
  const part = await _participation(db, pairs);
  const out = groups.map((g) => {
    const list = g.cards.map((c) => _cardView(c, part.get(`${g.owner}|${c.phone8}`)));
    return { ownerId: String(g.owner), ownerName: g.owner_name, nameKey: g.name_key, groupKey: g.groupKey,
      hasSelf: list.some((c) => c.kind === 'self'), total: list.reduce((a, c) => a + c.participation, 0), cards: list };
  }).sort((a, b) => b.total - a.total || a.ownerName.localeCompare(b.ownerName));
  return { ok: true, total: out.length, groups: out.slice(Number(offset) || 0, (Number(offset) || 0) + Math.min(200, Number(limit) || 50)) };
}

/** ② 다른 리뷰어와 겹치는 번호 — 서로 다른 리뷰어의 활성 카드가 같은 번호(확인한 번호 제외). */
async function listSharedPhones({ db = pool, limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT c.phone8,
            json_agg(json_build_object('owner', c.owner_reviewer_id, 'ownerName', r.name, 'id', c.id, 'kind', c.kind,
                     'name', c.name, 'phone', c.phone, 'phone8', c.phone8, 'address', c.address, 'bank_account', c.bank_account)
                     ORDER BY r.registered_at NULLS LAST, c.created_at) AS cards
       FROM reviewer_identity_cards c JOIN reviewers r ON r.id = c.owner_reviewer_id
      WHERE c.status = 'active' AND c.phone8 <> ''
      GROUP BY c.phone8
     HAVING COUNT(DISTINCT c.owner_reviewer_id) > 1`);
  const decided = await _openDecisionKeys(db, ['shared_phone_ok']);
  const items = rows
    .map((x) => ({ ...x, groupKey: sharedGroupKey(x.phone8, x.cards.map((c) => c.owner)) }))
    .filter((x) => !decided.has(x.groupKey));
  const pairs = [];
  for (const x of items) for (const c of x.cards) pairs.push({ owner: c.owner, p8: c.phone8 });
  const part = await _participation(db, pairs);
  const out = items.map((x) => ({
    phone8: x.phone8, groupKey: x.groupKey,
    entries: x.cards.map((c) => ({ ownerId: String(c.owner), ownerName: c.ownerName, ..._cardView(c, part.get(`${c.owner}|${c.phone8}`)) })),
  }));
  return { ok: true, total: out.length, items: out.slice(Number(offset) || 0, (Number(offset) || 0) + Math.min(200, Number(limit) || 50)) };
}

async function _tx(fn, db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (err && err.code === '23505') throw new IdentityMergeError('already_decided', '다른 담당자가 방금 이 묶음을 처리했습니다. 화면을 새로고침해 주세요.', 409);
    throw err;
  } finally { client.release(); }
}

async function _lockGroup(client, ownerId, nameKey) {
  if (!UUID_RE.test(String(ownerId || ''))) throw new IdentityMergeError('bad_owner', '리뷰어를 지목할 수 없습니다.');
  const own = await client.query('SELECT id FROM reviewers WHERE id = $1 FOR NO KEY UPDATE', [ownerId]);
  if (!own.rows.length) throw new IdentityMergeError('reviewer_not_found', '리뷰어를 찾을 수 없습니다.', 404);
  const { rows } = await client.query(
    `SELECT id, kind, name, name_key, phone, phone8, address, bank_name, bank_account, account_holder, shopping_id
       FROM reviewer_identity_cards
      WHERE owner_reviewer_id = $1 AND name_key = $2 AND status = 'active'
      ORDER BY created_at FOR UPDATE`, [ownerId, nameKey]);
  return rows;
}

function _assertSameGroup(active, ownerId, nameKey, groupKey) {
  const now = dupGroupKey(ownerId, nameKey, active.map((c) => c.phone8));
  if (!groupKey || now !== groupKey || active.length < 2) {
    throw new IdentityMergeError('stale', '그 사이 명의 구성이 바뀌었습니다. 화면을 새로고침한 뒤 다시 판단해 주세요.', 409);
  }
}

/**
 * 합치기 — keepCardId 로 나머지 같은-이름 명의를 모두 합친다.
 * @returns { ok, decisionId, keptCardId, mergedCardIds, filled }
 */
async function mergeGroup({ ownerId, nameKey, groupKey, keepCardId, by = '', db = pool } = {}) {
  return _tx(async (client) => {
    const active = await _lockGroup(client, ownerId, nameKey);
    _assertSameGroup(active, ownerId, nameKey, groupKey);
    const keep = active.find((c) => String(c.id) === String(keepCardId));
    if (!keep) throw new IdentityMergeError('bad_keep', '남길 명의를 다시 골라 주세요.');
    const merged = active.filter((c) => c.id !== keep.id);
    if (merged.some((c) => c.kind === 'self')) {
      throw new IdentityMergeError('self_cannot_merge', '본인 명의는 합쳐 없앨 수 없습니다. 본인 명의를 남길 명의로 골라 주세요.');
    }
    // 빈 칸만 채움 — 합쳐지는 명의 중 참여가 앞선(먼저 만든) 것부터 값이 있는 첫 칸
    const filled = {};
    for (const f of FILL_FIELDS) {
      if (!blank(keep[f.card])) continue;
      const src = merged.find((c) => !blank(c[f.card]));
      if (src) filled[f.card] = String(src[f.card]).trim();
    }
    if (Object.keys(filled).length) {
      if (keep.kind === 'self') {
        const cols = FILL_FIELDS.filter((f) => filled[f.card] != null);
        const sets = cols.map((f, i) => `${f.owner} = CASE WHEN COALESCE(BTRIM(${f.owner}), '') = '' THEN $${i + 2} ELSE ${f.owner} END`);
        await client.query(`UPDATE reviewers SET ${sets.join(', ')} WHERE id = $1`, [ownerId, ...cols.map((f) => filled[f.card])]);
      } else {
        const r = await cards.mutateSubAccountsInTx(client, ownerId, (subs) => {
          const i = cards.findSubIndex(subs, keep.name, keep.phone);
          if (i < 0) throw new IdentityMergeError('stale', '남길 명의를 목록에서 찾지 못했습니다. 화면을 새로고침해 주세요.', 409);
          for (const f of FILL_FIELDS) if (filled[f.card] != null && blank(subs[i][f.sub])) subs[i][f.sub] = filled[f.card];
          return subs;
        }, { source: 'merge' });
        void r;
      }
    }
    await client.query(
      `UPDATE reviewer_identity_cards SET status = 'merged', merged_into = $2, updated_at = NOW(), record_version = record_version + 1
        WHERE id = ANY($1::uuid[]) AND status = 'active'`, [merged.map((c) => c.id), keep.id]);
    await cards.syncCardsAfterWrite(client, ownerId, { source: 'merge' });
    const ins = await client.query(
      `INSERT INTO reviewer_identity_decisions (kind, owner_reviewer_id, group_key, kept_card_id, merged_card_ids, filled, decided_by)
       VALUES ('merge', $1, $2, $3, $4::uuid[], $5::jsonb, $6) RETURNING id`,
      [ownerId, groupKey, keep.id, merged.map((c) => c.id), JSON.stringify(filled), String(by).slice(0, 80)]);
    logger.info(`[identity-merge] merge by=${String(by).slice(0, 40)} owner=${ownerId} keep=${keep.id} merged=${merged.length} filled=${Object.keys(filled).join(',')}`);
    return { ok: true, decisionId: String(ins.rows[0].id), keptCardId: String(keep.id), mergedCardIds: merged.map((c) => String(c.id)), filled };
  }, db);
}

/** 다른 사람 — 그대로 두기. 그 구성의 묶음은 다시 목록에 뜨지 않는다. */
async function keepSeparate({ ownerId, nameKey, groupKey, memo = '', by = '', db = pool } = {}) {
  return _tx(async (client) => {
    const active = await _lockGroup(client, ownerId, nameKey);
    _assertSameGroup(active, ownerId, nameKey, groupKey);
    const ins = await client.query(
      `INSERT INTO reviewer_identity_decisions (kind, owner_reviewer_id, group_key, memo, decided_by)
       VALUES ('keep_separate', $1, $2, $3, $4) RETURNING id`,
      [ownerId, groupKey, String(memo || '').slice(0, 500), String(by).slice(0, 80)]);
    return { ok: true, decisionId: String(ins.rows[0].id) };
  }, db);
}

/** 겹치는 번호 — 확인함 + 메모. 번호는 옮기거나 지우지 않는다(결정 3가). */
async function confirmSharedPhone({ phone8, groupKey, memo = '', by = '', db = pool } = {}) {
  const p8 = String(phone8 || '').replace(/\D/g, '');
  if (p8.length !== 8) throw new IdentityMergeError('bad_phone', '번호를 지목할 수 없습니다.');
  return _tx(async (client) => {
    const { rows } = await client.query(
      `SELECT DISTINCT owner_reviewer_id AS owner FROM reviewer_identity_cards WHERE phone8 = $1 AND status = 'active'`, [p8]);
    const now = sharedGroupKey(p8, rows.map((r) => r.owner));
    if (rows.length < 2 || now !== groupKey) throw new IdentityMergeError('stale', '그 사이 이 번호의 등록 상태가 바뀌었습니다. 화면을 새로고침해 주세요.', 409);
    const ins = await client.query(
      `INSERT INTO reviewer_identity_decisions (kind, group_key, memo, decided_by)
       VALUES ('shared_phone_ok', $1, $2, $3) RETURNING id`,
      [groupKey, String(memo || '').slice(0, 500), String(by).slice(0, 80)]);
    return { ok: true, decisionId: String(ins.rows[0].id) };
  }, db);
}

/**
 * 되돌리기 — 판단을 지우지 않고 undone_at 을 찍는다.
 * 합치기였으면 합친 명의를 다시 살리고, 채운 빈 칸은 **지금도 채운 값 그대로일 때만** 비운다(그 뒤 사람이 고친 값은 둔다).
 */
async function undoDecision({ decisionId, by = '', db = pool } = {}) {
  const id = Number(decisionId);
  if (!Number.isSafeInteger(id) || id < 1) throw new IdentityMergeError('bad_decision', '되돌릴 판단을 찾을 수 없습니다.');
  return _tx(async (client) => {
    const { rows } = await client.query(`SELECT * FROM reviewer_identity_decisions WHERE id = $1 FOR UPDATE`, [id]);
    const d = rows[0];
    if (!d) throw new IdentityMergeError('bad_decision', '되돌릴 판단을 찾을 수 없습니다.', 404);
    if (d.undone_at) throw new IdentityMergeError('already_undone', '이미 되돌린 판단입니다.', 409);
    const restored = { cards: 0, cleared: [] };
    if (d.kind === 'merge') {
      await client.query('SELECT id FROM reviewers WHERE id = $1 FOR NO KEY UPDATE', [d.owner_reviewer_id]);
      const { rows: keepRows } = await client.query(
        `SELECT id, kind, name, phone, status FROM reviewer_identity_cards WHERE id = $1 FOR UPDATE`, [d.kept_card_id]);
      const keep = keepRows[0];
      const filled = d.filled || {};
      if (keep && Object.keys(filled).length) {
        if (keep.kind === 'self') {
          const cols = FILL_FIELDS.filter((f) => filled[f.card] != null);
          const sets = cols.map((f, i) => `${f.owner} = CASE WHEN ${f.owner} = $${i + 2} THEN '' ELSE ${f.owner} END`);
          await client.query(`UPDATE reviewers SET ${sets.join(', ')} WHERE id = $1`, [d.owner_reviewer_id, ...cols.map((f) => filled[f.card])]);
          restored.cleared = cols.map((f) => f.card);
        } else {
          await cards.mutateSubAccountsInTx(client, d.owner_reviewer_id, (subs) => {
            const i = cards.findSubIndex(subs, keep.name, keep.phone);
            if (i < 0) return null;
            let changed = false;
            for (const f of FILL_FIELDS) {
              if (filled[f.card] != null && String(subs[i][f.sub] || '').trim() === filled[f.card]) { subs[i][f.sub] = ''; changed = true; restored.cleared.push(f.card); }
            }
            return changed ? subs : null;
          }, { source: 'merge_undo' });
        }
      }
      const r = await client.query(
        `UPDATE reviewer_identity_cards SET status = 'active', merged_into = NULL, updated_at = NOW(), record_version = record_version + 1
          WHERE id = ANY($1::uuid[]) AND status = 'merged'`, [d.merged_card_ids]);
      restored.cards = r.rowCount;
      await cards.syncCardsAfterWrite(client, d.owner_reviewer_id, { source: 'merge_undo' });
    }
    await client.query(`UPDATE reviewer_identity_decisions SET undone_at = NOW(), undone_by = $2 WHERE id = $1`, [id, String(by).slice(0, 80)]);
    logger.info(`[identity-merge] undo by=${String(by).slice(0, 40)} decision=${id} kind=${d.kind} cards=${restored.cards}`);
    return { ok: true, decisionId: String(id), kind: d.kind, restored };
  }, db);
}

/** 최근 판단 — 되돌리기 창구(되돌린 것 포함 · 최근 순). */
async function listDecisions({ db = pool, limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT d.id, d.kind, d.owner_reviewer_id, r.name AS owner_name, d.group_key, d.memo, d.filled,
            d.decided_by, d.decided_at, d.undone_by, d.undone_at,
            k.name AS kept_name, k.phone AS kept_phone,
            (SELECT COALESCE(json_agg(json_build_object('name', m.name, 'phone', m.phone)), '[]'::json)
               FROM reviewer_identity_cards m WHERE m.id = ANY(d.merged_card_ids)) AS merged
       FROM reviewer_identity_decisions d
       LEFT JOIN reviewers r ON r.id = d.owner_reviewer_id
       LEFT JOIN reviewer_identity_cards k ON k.id = d.kept_card_id
      ORDER BY d.decided_at DESC LIMIT $1`, [Math.min(200, Number(limit) || 50)]);
  return { ok: true, decisions: rows.map((d) => ({
    decisionId: String(d.id), kind: d.kind, ownerId: d.owner_reviewer_id ? String(d.owner_reviewer_id) : null, ownerName: d.owner_name || '',
    phone8: d.kind === 'shared_phone_ok' ? String(d.group_key).split('|')[1] || '' : '',
    kept: d.kept_name ? { name: d.kept_name, phone: d.kept_phone } : null, merged: d.merged || [],
    memo: d.memo, filled: Object.keys(d.filled || {}), decidedBy: d.decided_by, decidedAt: d.decided_at,
    undone: !!d.undone_at, undoneBy: d.undone_by || '', undoneAt: d.undone_at,
  })) };
}

/** 등록리뷰어DB 칩의 숫자. */
async function counts({ db = pool } = {}) {
  const [a, b] = await Promise.all([listDuplicateGroups({ db, limit: 1 }), listSharedPhones({ db, limit: 1 })]);
  return { ok: true, duplicates: a.total, sharedPhones: b.total };
}

module.exports = {
  IdentityMergeError, dupGroupKey, sharedGroupKey,
  listDuplicateGroups, listSharedPhones, mergeGroup, keepSeparate, confirmSharedPhone, undoDecision, listDecisions, counts,
};
