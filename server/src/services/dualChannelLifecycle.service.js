'use strict';
const { campaignHasDualChannels } = require('../utils/dualChannel');
const scopes = new WeakSet();
function changed() { const e = new Error('작업 연결이 바뀌었습니다. 전체 작업을 다시 시도해 주세요.'); e.code = 'dual_scope_changed_retry'; return e; }
function provenance(rows) {
  return rows.map(c => [String(c.id), campaignHasDualChannels(c), c.source_work_order_id || '', c.linked_sheet_id || '', c.linked_tab_name || '', c.linked_tab_gid || '']).sort((a,b) => a[0].localeCompare(b[0]));
}
async function discoverDualScope(db, targets) {
  if (!Array.isArray(targets)) throw new TypeError('dual scope targets must be an array');
  const rows = new Map(), membership = [];
  const loadCampaign = async id => {
    const { rows: found } = await db.query('SELECT to_jsonb(c) AS campaign FROM recruit_campaigns c WHERE c.id = $1', [String(id)]);
    if (found.length !== 1) throw changed();
    rows.set(String(found[0].campaign.id), found[0].campaign);
    return found[0].campaign;
  };
  const loadSheet = async t => {
    const { rows: found } = await db.query(`SELECT to_jsonb(c) AS campaign FROM recruit_campaigns c
      WHERE c.linked_sheet_id = $1 AND (c.linked_tab_name = $2 OR ($3 <> '' AND c.linked_tab_gid = $3))`, [t.sheetId, t.tabName, t.tabGid || '']);
    for (const row of found) rows.set(String(row.campaign.id), row.campaign);
  };
  const loadApplication = async id => {
    const { rows: found } = await db.query('SELECT to_jsonb(a) AS application FROM campaign_applications a WHERE a.id::text = $1', [String(id)]);
    if (found.length !== 1) throw changed();
    const a = found[0].application;
    membership.push(['app', String(a.id), a.campaign_id, a.order_submission_id || '']);
    if (!a.campaign_id) throw changed();
    return loadCampaign(a.campaign_id);
  };
  const loadOrder = async id => {
    const { rows: found } = await db.query('SELECT to_jsonb(o) AS submission FROM order_submissions o WHERE o.id::text = $1', [String(id)]);
    if (found.length !== 1) throw changed();
    const o = found[0].submission;
    membership.push(['order', String(o.id), o.campaign_application_id || '', o.purchase_bundle_application_id || '', o.sheet_id || '', o.tab_name || '', o.gid || '']);
    const ids = [...new Set([o.campaign_application_id, o.purchase_bundle_application_id].filter(v => v != null))];
    const sources = [];
    for (const appId of ids) sources.push(await loadApplication(appId));
    // Reverse application links cover the existing hold-finalization boundary.
    const { rows: apps } = await db.query('SELECT id FROM campaign_applications WHERE order_submission_id::text = $1 ORDER BY id', [String(id)]);
    for (const app of apps) if (!ids.map(String).includes(String(app.id))) sources.push(await loadApplication(app.id));
    // A bundle cannot become ordinary merely because all original links broke.
    if ([o.purchase_bundle_version, o.purchase_bundle_hash, o.purchase_bundle_application_id].some(v => v != null)
        && (!sources.length || sources.some(c => !campaignHasDualChannels(c))
          || new Set(sources.map(c => String(c.id))).size !== 1)) throw changed();
    if (o.sheet_id && o.tab_name) await loadSheet({ sheetId: o.sheet_id, tabName: o.tab_name, tabGid: o.gid || '' });
  };
  const normalizedTargets = targets.map(target => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new TypeError('dual scope target required');
    const keys = Object.keys(target);
    const kinds = ['campaignId', 'workOrderId', 'applicationId', 'orderSubmissionId', 'batchId'];
    const kind = keys.length === 1 && kinds.includes(keys[0]) ? keys[0] : null;
    if (kind && String(target[kind] ?? '').trim()) return Object.freeze({ [kind]: String(target[kind]) });
    if (keys.every(k => ['sheetId','tabName','tabGid'].includes(k)) && typeof target.sheetId === 'string' && target.sheetId && typeof target.tabName === 'string' && target.tabName
        && (target.tabGid === undefined || typeof target.tabGid === 'string')) return Object.freeze({ sheetId: target.sheetId, tabName: target.tabName, tabGid: target.tabGid || '' });
    throw new TypeError('Unsupported dual scope target');
  });
  for (const target of normalizedTargets) {
    if (target.campaignId) await loadCampaign(target.campaignId);
    else if (target.applicationId) await loadApplication(target.applicationId);
    else if (target.orderSubmissionId) await loadOrder(target.orderSubmissionId);
    else if (target.sheetId) await loadSheet(target);
    else if (target.batchId) {
      const { rows: batches } = await db.query('SELECT id FROM payment_batches WHERE id::text = $1', [target.batchId]);
      if (batches.length !== 1) throw changed();
      const { rows: items } = await db.query('SELECT to_jsonb(i) AS item FROM payment_batch_items i WHERE i.batch_id::text = $1 ORDER BY i.id', [target.batchId]);
      membership.push(['batch', target.batchId, items.map(({item:i}) => [String(i.id), i.order_submission_id || '', i.sheet_id, i.tab_name])]);
      for (const { item } of items) {
        if (item.order_submission_id) await loadOrder(item.order_submission_id);
        else if (item.sheet_id && item.tab_name) await loadSheet({ sheetId: item.sheet_id, tabName: item.tab_name });
        else throw changed();
      }
    } else {
      const result = await db.query(`SELECT to_jsonb(c) AS campaign FROM recruit_campaigns c WHERE c.source_work_order_id = $1 OR c.id = (SELECT linked_campaign_id FROM work_orders WHERE id = $1)`, [target.workOrderId]);
      for (const row of result.rows) rows.set(String(row.campaign.id), row.campaign);
    }
  }
  const campaigns = [...rows.values()];
  const scope = Object.freeze({ targets: Object.freeze(normalizedTargets), campaignIds: Object.freeze(campaigns.filter(campaignHasDualChannels).map(c => String(c.id)).sort()), fingerprint: JSON.stringify([provenance(campaigns), membership]) });
  scopes.add(scope); return scope;
}
async function lockDualScopeInTx(client, scope) {
  if (!scopes.has(scope)) throw new TypeError('Server discovered dual scope required');
  for (const id of scope.campaignIds) await client.query(`SELECT pg_advisory_xact_lock(hashtext('dual_channel_lifecycle'), hashtext($1))`, [id]);
}
async function assertDualProvenanceUnchanged(client, scope) {
  if (!scopes.has(scope)) throw new TypeError('Server discovered dual scope required');
  const current = await discoverDualScope(client, scope.targets);
  if (current.fingerprint !== scope.fingerprint) throw changed();
}
async function withDualLifecycleInTx({ db, targets, run }) {
  const scope = await discoverDualScope(db, targets);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await lockDualScopeInTx(client, scope);
    await assertDualProvenanceUnchanged(client, scope);
    const result = await run(client, scope);
    await client.query('COMMIT');
    return result;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
module.exports = { discoverDualScope, lockDualScopeInTx, assertDualProvenanceUnchanged, withDualLifecycleInTx };
