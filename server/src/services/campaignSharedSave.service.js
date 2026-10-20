// ═══════════════════════════════════════════════════════════════════════════
// 양방향 4단계-2 — 모집공고 편집 창 저장의 공유 글 칸 (결정 263)
//
// 연결된(작업오더 `bidir_state='on'` · 살아 있는 공고) 공고를 관리자 창에서 저장하면:
//   ① 공유 글 칸(리뷰가이드·특이사항·두 사진 묶음·유입방식·썸네일·구매시간·랜딩(링크유입)·구매채널)은
//      작업오더 값으로 되돌려(`campaignSharedEdit`) **공유 저장**(`applySharedPatch`, origin 'campaign')으로 보낸다
//      → 오더가 바뀌고, 공고는 같은 트랜잭션에서 투영되고, 인트라넷으로 보낼 줄이 쌓인다.
//   ② 이어지는 기존 저장(PUT 본문)은 그 칸들을 **쓰지 않는다**(`strip`) — 안 그러면 창을 연 뒤 인트라넷이 고친 칸을
//      옛 화면 값으로 되돌린다. work_detail 은 통째 저장이라 SQL 에서 공유 하위 칸만 지금 DB 값으로 되살린다.
// ★★ 기준 버전(`bidir_base_sync_version` — 창을 열 때 받은 값)이 없는 옛 화면: 공유 칸이 지금 공고와 다르면 409(새로고침 안내),
//    같으면 그 칸만 빼고 저장(종전과 같은 결과).
// ★★ 겹친 칸 = 나중에 저장한 값(사용자 확정 2026-10-20) — 덮인 인트라넷 값은 응답 `shared.overwritten` 으로 화면이 보여준다.
// ★ 되돌릴 수 없는 칸(왕복 검사 실패) = 409 `campaign_field_unmappable`(쓰기 0).
// ★ 스위치 `bidir_sync.campaign_edit='on'` 일 때만. 꺼져 있으면 종전 저장 그대로(연결돼 있어도).
// ★ 옵션표(옵션 URL·옵션별 유입가이드)는 공유 저장 대상이 아니다(5·7단계). 다만 창을 연 뒤 리뷰오더 쪽에서 바뀐
//   옵션 칸을 손대지 않은 화면 값으로 되돌리지 않게 `protectOptionLeaves` 가 지금 DB 값을 남긴다.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const getPool = () => require('../db/pool');
const { logger } = require('../utils/logger');
const { readBidirSwitch } = require('../utils/bidirSwitch');
const { planCampaignSharedEdit, driftFromCampaign, landingIsShared, campaignRowView } = require('../utils/campaignSharedEdit');

// inflowGuideHtml = 옛 공고 공통 유입가이드(공유 저장의 유입 투영이 쓴다) — 편집 저장이 미리 읽은 옛 값으로 되돌리지 않게 함께 지킨다(검토 2026-10-20).
const WD_SHARED_KEYS = Object.freeze(['reviewGuide', 'specialNotes', 'reviewGuideImages', 'specialNotesImages', 'inflowType', 'inflowGuideHtml']);

function _wd(camp) {
  let wd = camp && camp.work_detail;
  if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
  return wd && typeof wd === 'object' && !Array.isArray(wd) ? wd : {};
}

/** 이 공고가 양방향 연결 공고인가 → { camp, wo } | null. 살아 있는(보관 아님) 공고이고, 그 오더의 살아 있는 공고가 바로 이 공고일 때만. */
async function findBidirLink(db, campaignId) {
  const { rows: cr } = await db.query('SELECT * FROM recruit_campaigns WHERE id = $1', [campaignId]);
  const camp = cr[0];
  if (!camp || camp.archived_at) return null;
  const { rows: wr } = await db.query(
    `SELECT * FROM work_orders WHERE deleted_at IS NULL AND bidir_state = 'on'
       AND (linked_campaign_id = $1 OR id = $2) LIMIT 2`, [campaignId, String(camp.source_work_order_id || '')]);
  if (wr.length !== 1) {
    if (wr.length > 1) logger.warn(`[bidir/campaign] ${campaignId} 에 연결 오더가 둘 이상 — 공유 저장을 하지 않는다`);
    return null;
  }
  const live = await require('./linkedRecruitQuota.service').liveCampaignForWorkOrders(db, [wr[0].id]);
  if (!live || live.id !== campaignId) return null;
  return { camp: { ...camp, work_detail: _wd(camp) }, wo: wr[0] };
}

/**
 * PUT /admin/:id 의 UPDATE 직전에 부른다.
 * @returns {Promise<{active:false} | {response:{status:number, body:object}} | {active:true, landingShared:boolean, participation:boolean, windowsWritable:boolean, shared:object|null, link:object}>}
 */
async function applyCampaignSharedSave({ campaignId, body, actor, db } = {}) {
  const pool = db || getPool();
  const sw = await readBidirSwitch(pool);
  if (sw.campaign_edit !== 'on') return { active: false };
  const link = await findBidirLink(pool, campaignId);
  if (!link) return { active: false };
  const { camp, wo } = link;
  const b = body || {};
  const base = Number(b.bidir_base_sync_version) || 0;
  const strip = (shared, windowsWritable = false) => ({
    active: true, link, shared, windowsWritable, windowsBaseText: String(camp.time_range || ''),
    participation: camp.participation_mode === true,
    landingShared: landingIsShared({ inflow_type: wo.inflow_type }, b),
  });

  if (!base) {
    // 옛 화면 — 기준이 없으니 공유 칸은 "지금 값 그대로" 일 때만 저장을 이어 간다.
    const drift = driftFromCampaign(camp, b);
    if (drift.length) {
      return { response: { status: 409, body: { ok: false, code: 'stale_editor', fields: drift,
        error: `리뷰오더와 맞춰지는 공고입니다. 이 창은 옛 화면이라 공통 칸(${drift.join(', ')})을 저장할 수 없습니다. 새로고침한 뒤 다시 열어 저장해 주세요.` } } };
    }
    return strip(null);
  }

  const { rows: snap } = await pool.query(
    'SELECT state FROM work_order_shared_snapshots WHERE work_order_id = $1 AND sync_version = $2', [wo.id, base]);
  if (!snap.length) {
    return { response: { status: 409, body: { ok: false, code: 'edit_base_missing',
      error: '공고 창을 연 뒤 기준 정보가 사라졌습니다. 창을 닫고 다시 열어 주세요.' } } };
  }
  const plan = planCampaignSharedEdit({ baseState: snap[0].state, camp, body: b });
  if (plan.unmappable.length) {
    const labels = [...new Set(plan.unmappable.map(u => u.label))];
    return { response: { status: 409, body: { ok: false, code: 'campaign_field_unmappable', fields: plan.unmappable,
      error: `이 칸은 공고에서 이 모양으로 바꿀 수 없어 저장하지 않았습니다: ${labels.join(', ')}. 리뷰오더(인트라넷)에서 고쳐 주세요.` } } };
  }
  if (!Object.keys(plan.mine).length) return strip(null, plan.windowsWritable);

  const { applySharedPatch } = require('./sharedPatch.service');
  const out = await applySharedPatch({
    workOrderId: wo.id, mine: plan.mine, baseVersion: base, origin: 'campaign', conflictPolicy: 'last_writer',
    actor: actor || '리뷰웹 공고', opId: b.bidir_op_id ? String(b.bidir_op_id).slice(0, 120) : '',
  });
  if (out.status !== 200) return { response: { status: out.status, body: out.body } };
  return strip({
    sync_version: out.body.sync_version, changed: plan.changed,
    overwritten: out.body.overwritten || [], applied: out.body.applied || [], idempotent: out.body.idempotent === true,
  }, plan.windowsWritable);
}

/**
 * 옵션표 보호 — 창을 연 뒤 리뷰오더 쪽(인트라넷 공유 저장의 투영)에서 바뀐 옵션 URL·옵션별 유입가이드를
 * 손대지 않은 화면 값으로 되돌리지 않는다. 화면 값 = 기준 투영 값이고 지금 DB 값 ≠ 기준 투영 값일 때만 지금 DB 값을 남긴다.
 * 관리자가 직접 고친 칸(화면 값 ≠ 기준 투영)은 종전대로 저장된다(공고 전용 — 5·7단계에서 공유로).
 * @returns {Promise<string[]>} 지금 값을 남긴 칸 이름
 */
async function protectOptionLeaves({ normOpts, link, baseVersion, db } = {}) {
  if (!Array.isArray(normOpts) || !normOpts.length || !link || !baseVersion) return [];
  const pool = db || getPool();
  const { projectOrderToCampaign, readCampaignShared } = require('../utils/orderToCampaignProjection');
  const { rows: snap } = await pool.query(
    'SELECT state FROM work_order_shared_snapshots WHERE work_order_id = $1 AND sync_version = $2', [link.wo.id, Number(baseVersion)]);
  if (!snap.length) return [];
  const { rows: optRows } = await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1', [link.camp.id]);
  const baseOpts = new Map(projectOrderToCampaign(snap[0].state).options.map(o => [o.key, o]));
  const curShaped = readCampaignShared(link.camp, optRows).options;
  const curByKey = new Map(curShaped.map(o => [o.key, o]));
  const rawByKey = new Map(optRows.filter(r => String(r.status || '') !== 'deleted').map(r => {
    const unit = String(r.unit_kind || '') === 'product' ? 'product' : 'option';
    return [`${String(r.product_name || '').trim()}|${unit === 'product' ? '' : String(r.opt_key || '').trim()}`, r];
  }));
  const { optionShape: shape } = require('../utils/orderToCampaignProjection');
  const LEAVES = [['option_url', 'optionUrl', r => r.option_url || ''], ['inflow_guide_html', 'inflowGuideHtml', r => r.inflow_guide_html || ''],
    ['inflow_guide_images', 'inflowGuideImages', r => (Array.isArray(r.inflow_guide_images) ? r.inflow_guide_images : [])]];
  const kept = [];
  for (const o of normOpts) {
    const mine = shape({ productName: o.productName, optKey: o.optKey, unitKind: o.unitKind, optionUrl: o.optionUrl,
      inflowGuideHtml: o.inflowGuideHtml, inflowGuideImages: o.inflowGuideImages });
    const b = baseOpts.get(mine.key), c = curByKey.get(mine.key), raw = rawByKey.get(mine.key);
    if (!b || !c || !raw) continue;
    for (const [leaf, field, rawOf] of LEAVES) {
      if (mine[leaf] === b[leaf] && c[leaf] !== b[leaf]) { o[field] = rawOf(raw); kept.push(`${mine.name}·${leaf}`); }
    }
  }
  if (kept.length) logger.info(`[bidir/campaign] ${link.camp.id} 창을 연 뒤 리뷰오더 쪽에서 바뀐 옵션 칸은 지금 값 유지: ${kept.join(', ')}`);
  return kept;
}

/** 리뷰어앱 스코프 편집 — 연결 공고면 공유 칸 변경을 막는다(그 화면은 기준 버전을 모른다). 같으면 통과. */
async function scopedEditSharedBlock({ campaignId, body, db } = {}) {
  const pool = db || getPool();
  const sw = await readBidirSwitch(pool);
  if (sw.campaign_edit !== 'on') return null;
  const link = await findBidirLink(pool, campaignId);
  if (!link) return null;
  const b = body || {};
  const now = campaignRowView(link.camp);
  const changed = [];
  const t = v => String(v == null ? '' : v).trim();
  if (b.thumbnail_url !== undefined && t(b.thumbnail_url) !== t(now.thumbnail_url)) changed.push('썸네일');
  if (b.time_range !== undefined && t(b.time_range) !== t(now.time_range)) changed.push('구매시간');
  if (b.auto_order === true || (b.window_start !== undefined && b.window_start !== '' && b.window_start !== null)
      || (b.window_end !== undefined && b.window_end !== '' && b.window_end !== null)) {
    const hh = v => { const m = /^(\d{1,2}):(\d{2})/.exec(t(v)); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
    const ws = b.auto_order === true ? '' : hh(b.window_start ?? link.camp.window_start);
    const we = b.auto_order === true ? '' : hh(b.window_end ?? link.camp.window_end);
    if (ws !== hh(link.camp.window_start) || we !== hh(link.camp.window_end)) changed.push('구매시간(시간창)');
  }
  if (landingIsShared({ inflow_type: link.wo.inflow_type }, { work_detail: { inflowType: now.inflowType } })
      && b.landing_url !== undefined && t(b.landing_url) !== t(now.landing_url)) changed.push('상품 페이지 주소');
  if (!changed.length) return null;
  return { status: 409, body: { ok: false, code: 'shared_field_scoped', fields: changed,
    error: `리뷰오더와 맞춰지는 칸(${[...new Set(changed)].join(', ')})은 리뷰어 앱에서 바꿀 수 없습니다. 관리자 화면이나 리뷰오더에서 고쳐 주세요.` } };
}

module.exports = { applyCampaignSharedSave, protectOptionLeaves, scopedEditSharedBlock, findBidirLink, WD_SHARED_KEYS };
