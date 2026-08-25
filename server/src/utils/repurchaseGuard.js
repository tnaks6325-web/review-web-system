'use strict';

/**
 * Same work-tab repurchase guard.  A participation identity is its phone8;
 * the owner account is deliberately not substituted for a sub account.
 */
function repurchaseDays() {
  const n = parseInt(process.env.CAMPAIGN_REPARTICIPATE_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 14;
}

function phone8Of(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-8);
}

async function checkRepurchaseWindow(dbOrClient, { sheetId, tabName, phone, phone8 } = {}) {
  const days = repurchaseDays();
  const p8 = phone8 || phone8Of(phone);
  if (days <= 0 || !sheetId || !tabName || p8.length !== 8) {
    return { blocked: false, days, lastSubmittedAt: null, availableFrom: null };
  }
  const { rows } = await dbOrClient.query(
    `SELECT submitted_at
       FROM order_submissions
      WHERE sheet_id = $1 AND tab_name = $2
        AND deleted_at IS NULL
        AND RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 8) = $3
        AND submitted_at >= NOW() - make_interval(days => $4)
      ORDER BY submitted_at DESC
      LIMIT 1`,
    [sheetId, tabName, p8, days]
  );
  if (!rows.length) return { blocked: false, days, lastSubmittedAt: null, availableFrom: null };
  const lastSubmittedAt = rows[0].submitted_at;
  return { blocked: true, days, lastSubmittedAt,
    availableFrom: new Date(new Date(lastSubmittedAt).getTime() + days * 86400000) };
}

async function checkRepurchaseWindowBatch(dbOrClient, { sheetId, tabName, phone8List } = {}) {
  const days = repurchaseDays();
  const map = new Map();
  const list = Array.from(new Set((phone8List || []).map(String).filter(p => p.length === 8)));
  if (days <= 0 || !sheetId || !tabName || !list.length) return map;
  const { rows } = await dbOrClient.query(
    `SELECT RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 8) AS p8,
            MAX(submitted_at) AS last_at
       FROM order_submissions
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
        AND submitted_at >= NOW() - make_interval(days => $3)
        AND RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 8) = ANY($4::text[])
      GROUP BY 1`,
    [sheetId, tabName, days, list]
  );
  for (const r of rows) map.set(r.p8, { blocked: true, lastSubmittedAt: r.last_at,
    availableFrom: new Date(new Date(r.last_at).getTime() + days * 86400000) });
  return map;
}

async function checkRepurchaseStatusForCampaigns(dbOrClient, { campaignIds, phone8 } = {}) {
  const days = repurchaseDays();
  const map = new Map();
  const ids = Array.from(new Set((campaignIds || []).map(String).filter(Boolean)));
  const p8 = String(phone8 || '');
  if (days <= 0 || !ids.length || p8.length !== 8) return map;
  const { rows } = await dbOrClient.query(
    `SELECT rc.id AS campaign_id, MAX(os.submitted_at) AS last_at
       FROM recruit_campaigns rc JOIN order_submissions os
         ON os.sheet_id = rc.linked_sheet_id AND os.tab_name = rc.linked_tab_name
        AND os.deleted_at IS NULL
        AND RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) = $2
      WHERE rc.id = ANY($1::text[])
        AND COALESCE(rc.linked_sheet_id,'') <> '' AND COALESCE(rc.linked_tab_name,'') <> ''
      GROUP BY rc.id`, [ids, p8]);
  const now = Date.now();
  for (const r of rows) {
    const availableFrom = new Date(new Date(r.last_at).getTime() + days * 86400000);
    map.set(String(r.campaign_id), availableFrom.getTime() > now
      ? { status: 'locked', lastSubmittedAt: r.last_at, availableFrom }
      : { status: 'ready', lastSubmittedAt: r.last_at });
  }
  return map;
}

async function checkRepurchaseStatusForAccounts(dbOrClient, { campaignIds, phone8List } = {}) {
  const days = repurchaseDays();
  const out = new Map();
  const ids = Array.from(new Set((campaignIds || []).map(String).filter(Boolean)));
  const p8s = Array.from(new Set((phone8List || []).map(String).filter(x => x.length === 8)));
  if (days <= 0 || !ids.length || !p8s.length) return out;
  const { rows } = await dbOrClient.query(
    `SELECT rc.id AS campaign_id,
            RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) AS p8,
            MAX(os.submitted_at) AS last_at
       FROM recruit_campaigns rc JOIN order_submissions os
         ON os.sheet_id = rc.linked_sheet_id AND os.tab_name = rc.linked_tab_name
        AND os.deleted_at IS NULL
      WHERE rc.id = ANY($1::text[])
        AND RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) = ANY($2::text[])
        AND COALESCE(rc.linked_sheet_id,'') <> '' AND COALESCE(rc.linked_tab_name,'') <> ''
      GROUP BY rc.id, 2`, [ids, p8s]);
  const now = Date.now();
  for (const r of rows) {
    const availableFrom = new Date(new Date(r.last_at).getTime() + days * 86400000);
    if (!out.has(r.p8)) out.set(r.p8, new Map());
    out.get(r.p8).set(String(r.campaign_id), availableFrom.getTime() > now
      ? { status: 'locked', lastSubmittedAt: r.last_at, availableFrom }
      : { status: 'ready', lastSubmittedAt: r.last_at });
  }
  return out;
}

module.exports = { repurchaseDays, phone8Of, checkRepurchaseWindow, checkRepurchaseWindowBatch,
  checkRepurchaseStatusForCampaigns, checkRepurchaseStatusForAccounts };
