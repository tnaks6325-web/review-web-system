'use strict';
const { rawHasDualChannels, keepDualChannelProducts } = require('../utils/dualChannel');
const { isDualChannelReady, assertDualChannelReady } = require('./dualChannelRuntime.service');
const { normalizeProductOptionsJson } = require('./productOptions.service');
function normalizeSettings(raw, state = {}, operation = 'settings') {
  const dual = rawHasDualChannels(raw);
  if (dual) assertDualChannelReady(operation);
  const result = normalizeProductOptionsJson(raw, { allowDualChannels: isDualChannelReady(operation) });
  if (dual) {
    const fail = message => { const e = new Error(message); e.code = 'invalid_dual_channel'; throw e; };
    if (state.work_kind !== undefined && !['', 'review', '리뷰'].includes(state.work_kind)) fail('동시진행은 일반 리뷰 작업만 지원합니다.');
    const base = result.value[0].base;
    if (state.recruit_count !== undefined && Number(state.recruit_count) !== base.count) fail('상품 인원과 총모집 인원이 다릅니다.');
    if (state.daily_count !== undefined && Number(state.daily_count) !== base.daily) fail('상품 일건수와 일 진행 건수가 다릅니다.');
  }
  return result;
}
function preserveSettings(current, raw, state = {}, operation = 'settings') {
  if (rawHasDualChannels(current) || rawHasDualChannels(raw)) assertDualChannelReady(operation);
  return normalizeSettings(keepDualChannelProducts(current, raw), state, operation);
}
function normalizeCampaignSettings(body, current = null) {
  // The dedicated key is required even when a channel label was supplied.
  let wd = body.work_detail;
  if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
  const old = current && (typeof current.work_detail === 'string' ? JSON.parse(current.work_detail) : current.work_detail);
  const raw = wd && Object.hasOwn(wd, 'dualChannelProduct') ? wd.dualChannelProduct : old && old.dualChannelProduct;
  if (!raw) { const e = new Error('구매처별 상품 조건이 필요합니다.'); e.code = 'invalid_dual_channel'; throw e; }
  const state = { ...current, ...body };
  const normalized = normalizeSettings([raw], { work_kind: state.work_kind, recruit_count: state.recruit_total, daily_count: state.daily_limit });
  const options = body.options;
  if (options != null && (!Array.isArray(options) || (options.length && !(options.length === 1
      && options[0].unitKind === 'product' && !options[0].optKey
      && options[0].productName === raw.name
      && Number(options[0].payAmount) === normalized.value[0].base.pay
      && Number(options[0].recruitTotal) === normalized.value[0].base.count
      && Number(options[0].dailyLimit || 0) === Number(normalized.value[0].base.daily || 0))))) {
    const e = new Error('동시진행 상품에는 별도 선택지를 넣을 수 없습니다.'); e.code = 'invalid_dual_channel'; throw e;
  }
  if (state.status === 'active') assertDualChannelReady('recruitment');
  return { ...body, channel: '네이버+쿠팡', channel_custom: '', work_detail: require('../utils/sanitizeGuideHtml').sanitizeWorkDetail({ ...old, ...wd, dualChannelProduct: normalized.value[0] }) };
}
function requireSuccess(out) {
  if (!out || out.status !== 200 || !out.body.ok) { const e = new Error(out?.body?.error || '공고를 연결하지 못했습니다.'); e.response = out; throw e; }
  return out;
}
// Reuse the existing reconciliation planner and the real shared SQL writer.
// No BEGIN/COMMIT/ROLLBACK or independent client is allowed here.
async function reconcileSharedOrderInTx(client, { workOrderId, campaignId, actor = '' }) {
  const shared = require('./sharedPatch.service');
  const { rows: wr } = await client.query('SELECT * FROM work_orders WHERE id = $1', [workOrderId]);
  const { rows: cr } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1', [campaignId]);
  const { rows: opts } = await client.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY sort_order, id', [campaignId]);
  const plan = require('./sharedReconcile.service').planReconcile(wr[0], cr[0], opts);
  if (plan.blocked) throw new Error(plan.blocked);
  const picks = Object.fromEntries(plan.fields.filter(f => !f.derived).map(f => [f.id, 'campaign']));
  return requireSuccess(await shared.applySharedPatchInTx(client, { workOrderId, origin: 'reconcile', actor, opId: `publish-${campaignId}`, mine: {}, baseVersion: 0,
    reconcile: { picks, fingerprint: plan.fingerprint } }));
}
async function finishCampaignCreateInTx(client, campaign, actor = '', lockedScope) {
  const shared = require('./sharedPatch.service');
  const id = campaign.source_work_order_id;
  if (!id) return null;
  const { rows: orders } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id]);
  const wo = orders[0];
  if (!wo || wo.deleted_at || !rawHasDualChannels(wo.product_options_json)) throw new Error('새 동시진행 작업오더로 연결해 주세요.');
  normalizeSettings(wo.product_options_json, wo, 'roundtrip');
  // The quota owner supplies this InTx core on integration. Never fall back to
  // its wrapper (new client / nested transaction / reversed lock order).
  const quota = await require('./linkedRecruitQuota.service').syncCampaignRecruitTotalInTx(client, {
    campaignId: campaign.id, recruitTotal: campaign.recruit_total, lockedScope });
  let out = requireSuccess(await shared.linkSharedOrderInTx(client, { workOrderId: id, actor }));
  if (out.body.state === 'diverged') out = await reconcileSharedOrderInTx(client, { workOrderId: id, campaignId: campaign.id, actor });
  // Linking identical values also needs an initial outgoing snapshot for roundtrip.
  await client.query(`INSERT INTO shared_sync_outbox(work_order_id,sync_version,view_scope)
    SELECT id,sync_version,'full' FROM work_orders WHERE id=$1
    ON CONFLICT(work_order_id,sync_version) DO NOTHING`, [id]);
  return { state: 'on', sync_version: out.body.sync_version, quota, ...(out.afterCommit ? { afterCommit: out.afterCommit } : {}) };
}
async function saveCampaignSettings({ db, campaignId, body, actor = '' }) {
  assertDualChannelReady('settings');
  const lifecycle = require('./dualChannelLifecycle.service');
  const out = await lifecycle.withDualLifecycleInTx({ db, targets: [{ campaignId }],
    run: (client, lockedScope) => saveCampaignSettingsInTx(client, { campaignId, body, actor, lockedScope }) });
  if (out.afterCommit) await require('./sharedPatch.service').finishSharedPatchAfterCommit(out.afterCommit);
  return out;
}
// Caller owns transaction + lifecycle. No peer wrapper may be called here.
async function saveCampaignSettingsInTx(client, { campaignId, body, actor = '', lockedScope }) {
  assertDualChannelReady('settings');
  await require('./dualChannelLifecycle.service').assertDualProvenanceUnchanged(client, lockedScope);
    const lrq = require('./linkedRecruitQuota.service');
    const ids = await lrq.workOrderIdsForCampaign(client, campaignId);
    await lrq.lockWorkOrderCampaigns(client, ids);
    const { rows } = await client.query('SELECT * FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [campaignId]);
    const current = rows[0];
    const b = normalizeCampaignSettings(body, current);
    // A settings edit cannot silently reassign provenance/workboard affinity.
    for (const key of ['source_work_order_id','linked_sheet_id','linked_tab_name','linked_tab_gid']) {
      if (body[key] != null && String(body[key]) !== String(current[key] || '')) throw new Error('작업 연결은 공고 조건 수정으로 바꿀 수 없습니다.');
    }
    if (body.linked_tab_mode === 'unlinked' && current.linked_sheet_id) throw new Error('동시진행 공고의 작업 연결을 해제할 수 없습니다.');
    const common = require('./campaignSharedSave.service');
    const shared = await common.applyCampaignSharedSave({ campaignId, body: b, actor, db: client, inTxClient: client });
    if (shared.response) { const e = new Error(shared.response.body.error); e.response = shared.response; throw e; }
    if (ids.length && !shared.active) throw new Error('연결된 공고의 공유 저장이 꺼져 있어 저장하지 않았습니다.');
    const { rows: fresh } = await client.query('SELECT * FROM recruit_campaigns WHERE id=$1', [campaignId]);
    const wd = { ...b.work_detail };
    if (shared.active) for (const key of common.WD_SHARED_KEYS) {
      if (Object.hasOwn(fresh[0].work_detail || {}, key)) wd[key] = fresh[0].work_detail[key]; else delete wd[key];
    }
    if (shared.active && shared.keepProductLines) wd.productLines = fresh[0].work_detail?.productLines;
    const columns = ['title','manager','notes','chat_url','status','sort_order','max_slots','deadline','description','participation_mode','thumbnail_url','landing_url','window_start','window_end','close_buffer_min','hold_ttl_min','start_date','multi_account_mode','multi_daily_limit','sub_hold_ttl_min','repurchase_days','reviewer_hidden','transfer_bank','transfer_memo','carry_mode','carry_strategy','cash_receipt_required','badges'];
    if (!shared.active) columns.push('channel','channel_custom','review_fee','time_range','delivery_type','work_kind','review_type','review_type_mix','skip_weekends','recruit_total','daily_limit','required_delivery_memo');
    const params = [campaignId, JSON.stringify(wd)];
    const sets = ['work_detail=$2::jsonb'];
    for (const key of columns) if (b[key] !== undefined && b[key] !== null) {
      if (shared.active && (key === 'thumbnail_url' || (key === 'landing_url' && shared.landingShared)
          || (['window_start','window_end'].includes(key) && shared.participation && !shared.windowsWritable))) continue;
      params.push(['badges','review_type_mix'].includes(key) ? JSON.stringify(b[key]) : b[key]);
      sets.push(`${key}=$${params.length}${['badges','review_type_mix'].includes(key) ? '::jsonb' : ''}`);
    }
    if (!shared.active && Number(b.recruit_total ?? current.recruit_total) !== Number(current.recruit_total)) {
      await lrq.assertTotalFloorInTx(client, campaignId, b.recruit_total);
      await lrq.syncWorktableSlotsInTx(client, current, b.recruit_total, actor);
    }
    const { rows: saved } = await client.query(`UPDATE recruit_campaigns SET ${sets.join(',')},updated_at=NOW() WHERE id=$1 RETURNING *`, params);
    return { status: 200, ...(shared.afterCommit ? { afterCommit: shared.afterCommit } : {}), body: { ok: true, data: saved[0], shared: shared.shared || null } };
}
module.exports = { normalizeSettings, preserveSettings, normalizeCampaignSettings, finishCampaignCreateInTx, reconcileSharedOrderInTx, saveCampaignSettings, saveCampaignSettingsInTx };
