const { normName, normPhone8 } = require('./identity.service');

function parseSubAccounts(value) {
  let rows = value;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (_) { return []; }
  }
  return Array.isArray(rows) ? rows : [];
}

function sessionIdentityScope(owner, session) {
  if (!owner || !session) return null;
  const ownerPhone8 = normPhone8(owner.phone8 || owner.phone);
  const loginPhone8 = normPhone8(session.loginPhone8);
  const loginName = normName(session.loginName);
  if (ownerPhone8.length !== 8 || loginPhone8.length !== 8 || !loginName) return null;

  const identities = [];
  const seen = new Set();
  const add = (phone8, name, type) => {
    const p8 = normPhone8(phone8);
    const normalizedName = normName(name);
    const key = `${p8}\0${normalizedName}`;
    if (p8.length !== 8 || !normalizedName || seen.has(key)) return;
    seen.add(key);
    identities.push({ phone8: p8, name: normalizedName, displayName: String(name || '').trim(), type });
  };
  add(ownerPhone8, owner.name, 'self');
  for (const sub of parseSubAccounts(owner.sub_accounts)) add(sub && sub.phone, sub && sub.name, 'sub');

  if (session.loginKind === 'sub') {
    const sub = identities.find(item => item.type === 'sub' && item.phone8 === loginPhone8 && item.name === loginName);
    return sub ? { ownerPhone8, identities: [sub] } : null;
  }

  const self = identities.find(item => item.type === 'self' && item.phone8 === loginPhone8 && item.name === loginName);
  return self ? { ownerPhone8, identities } : null;
}

async function recoverActiveHolds(db, { campaignId, session }) {
  if (!db || !campaignId || !session || !session.ownerReviewerId) return { authorized: false, holds: [] };
  const { rows: owners } = await db.query(
    'SELECT id, name, phone, phone8, sub_accounts FROM reviewers WHERE id = $1 LIMIT 1',
    [session.ownerReviewerId]
  );
  if (owners.length !== 1) return { authorized: false, holds: [] };

  const scope = sessionIdentityScope(owners[0], session);
  if (!scope) return { authorized: false, holds: [] };
  const byPhone = new Map();
  for (const identity of scope.identities) {
    const list = byPhone.get(identity.phone8) || [];
    list.push(identity);
    byPhone.set(identity.phone8, list);
  }
  const phone8s = [...byPhone.keys()];
  const { rows } = await db.query(
    `SELECT id, status, expires_at, applied_at, option_key, hold_token, phone8,
            owner_phone8, applicant_name
       FROM campaign_applications
      WHERE campaign_id = $1
        AND phone8 = ANY($4::text[])
        AND hold_token IS NOT NULL AND hold_token <> ''
        AND (status = 'blog_pending' OR (status = 'applied' AND expires_at > NOW()))
        AND (
          owner_reviewer_id = $2::uuid
          OR (owner_reviewer_id IS NULL AND owner_phone8 = $3)
        )
      ORDER BY CASE WHEN status = 'applied' THEN 0 ELSE 1 END, applied_at DESC`,
    [campaignId, session.ownerReviewerId, scope.ownerPhone8, phone8s]
  );

  const used = new Set();
  const holds = [];
  for (const row of rows) {
    const active = row.status === 'blog_pending'
      || (row.status === 'applied' && Number.isFinite(new Date(row.expires_at).getTime())
        && new Date(row.expires_at).getTime() > Date.now());
    if (!active) continue;
    const phone8 = normPhone8(row.phone8);
    const applicantName = normName(row.applicant_name);
    const identity = (byPhone.get(phone8) || []).find(item => item.name === applicantName);
    if (!identity || used.has(phone8) || normName(row.applicant_name) !== identity.name) continue;
    const token = String(row.hold_token || '').trim();
    if (!token) continue;
    used.add(phone8);
    holds.push({
      applicationId: row.id,
      holdToken: token,
      phone8,
      ownerPhone8: scope.ownerPhone8,
      expiresAt: row.expires_at || null,
      optionKey: row.option_key || '',
      name: identity.displayName,
      isSub: identity.type === 'sub',
      status: row.status,
    });
  }
  return { authorized: true, holds };
}

module.exports = { parseSubAccounts, sessionIdentityScope, recoverActiveHolds };
