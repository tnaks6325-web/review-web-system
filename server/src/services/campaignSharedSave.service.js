// ═══════════════════════════════════════════════════════════════════════════
// 양방향 4단계-2 — 모집공고 편집 창 저장의 공유 글 칸 (결정 274)
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
// ★ 5단계 — 리뷰비·결제금액(옵션표 금액 · 옵션 없는 공고의 상품 안내 금액)도 같은 공유 저장으로 보낸다(`planCampaignMoneyEdit`).
//   리뷰비 기간표는 연결 공고에서 직접 고치지 않는다(사용자 확정 2026-10-20) — 리뷰비 칸을 바꾸면 "오늘부터 새 금액" 구간이 저절로 생긴다.
//   화면이 보낸 기간표가 지금과 다르면 409(쓰기 0), 같으면 기존 저장이 기간표를 다시 쓰지 않는다(그 사이 생긴 구간을 지우지 않게).
// ★ 6단계 — 가이드유입 공고의 선택지 유입가이드도 공유 저장으로 보낸다({글, 사진} · `planCampaignMoneyEdit`).
//   옵션 URL·상품 메인 주소는 결정 276(2026-10-22)부터 공유(`planCampaignMoneyEdit` 의 주소 계획). 창을 연 뒤 리뷰오더 쪽에서 바뀐 옵션 칸은
//   `protectOptionLeaves` 가 지금 DB 값을 남긴다(금액·가이드·주소 포함).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const getPool = () => require('../db/pool');
const { logger } = require('../utils/logger');
const { readBidirSwitch } = require('../utils/bidirSwitch');
const { planCampaignSharedEdit, driftFromCampaign, landingIsShared, campaignRowView, planCampaignMoneyEdit, moneyDriftFromCampaign, structureChangesFromCampaign } = require('../utils/campaignSharedEdit');

// inflowGuideHtml = 옛 공고 공통 유입가이드(공유 저장의 유입 투영이 쓴다) — 편집 저장이 미리 읽은 옛 값으로 되돌리지 않게 함께 지킨다(검토 2026-10-20).
// payAmount = 옵션 없는 공고의 상품 금액(5단계 — 공유 저장의 금액 투영이 쓴다 · 화면은 보내지 않는다).
// productLines(상품 안내 글)는 여기 없다 — 창을 연 뒤 리뷰오더에서 금액이 바뀐 경우에만 따로($54) 지금 값을 남긴다(평소엔 화면 글이 저장된다).
const WD_SHARED_KEYS = Object.freeze(['reviewGuide', 'specialNotes', 'reviewGuideImages', 'specialNotesImages', 'inflowType', 'inflowGuideHtml', 'payAmount']);

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
  let keepProductLines = false;
  const strip = (shared, windowsWritable = false) => ({
    active: true, link, shared, windowsWritable, windowsBaseText: String(camp.time_range || ''),
    participation: camp.participation_mode === true,
    landingShared: landingIsShared({ inflow_type: wo.inflow_type }, b),
    keepProductLines,
  });
  const { rows: campOptions } = await pool.query('SELECT * FROM campaign_options WHERE campaign_id = $1', [campaignId]);

  // 리뷰비 기간표 — 연결 공고에서는 직접 고치지 않는다(지금과 같으면 통과 · 기존 저장이 다시 쓰지 않는다).
  if (Array.isArray(b.fee_schedules)) {
    const { normalizeFeeSchedules } = require('../utils/campaignFee');
    const { rows: cur } = await pool.query(
      `SELECT to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom", review_fee AS "reviewFee"
         FROM campaign_fee_schedules WHERE campaign_id = $1 ORDER BY effective_from`, [campaignId]);
    const key = list => (list || []).map(r => `${r.effectiveFrom}~${Number(r.reviewFee)}`).join('|');
    if (key(normalizeFeeSchedules(b.fee_schedules)) !== key(cur)) {
      return { response: { status: 409, body: { ok: false, code: 'fee_schedule_linked',
        error: '리뷰오더와 맞춰지는 공고라 기간별 리뷰비를 직접 고칠 수 없습니다. 리뷰비 칸만 바꾸면 "오늘부터 새 금액" 이 저절로 들어갑니다. 창을 새로고침한 뒤 다시 저장해 주세요.' } } };
    }
  }

  if (!base) {
    // 옛 화면 — 기준이 없으니 공유 칸은 "지금 값 그대로" 일 때만 저장을 이어 간다.
    const drift = driftFromCampaign(camp, b);
    const money = moneyDriftFromCampaign(camp, b, campOptions);
    if (money.length && !drift.length) {
      return { response: { status: 409, body: { ok: false, code: 'stale_editor', fields: money,
        error: `리뷰오더와 맞춰지는 공고라 이 창에서는 다음 칸을 바꿀 수 없습니다: ${money.join('·')}. 모집공고 편집 창(전체 편집)을 새로 열어 바꾸거나 리뷰오더에서 바꿔 주세요.` } } };
    }
    if (drift.length) {
      const all = [...drift, ...money];
      return { response: { status: 409, body: { ok: false, code: 'stale_editor', fields: all,
        error: `리뷰오더와 맞춰지는 공고입니다. 이 창은 옛 화면이라 공통 칸(${all.join(', ')})을 저장할 수 없습니다. 새로고침한 뒤 다시 열어 저장해 주세요.` } } };
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
  const money = planCampaignMoneyEdit({ baseState: snap[0].state, camp, body: b, campOptions });
  plan.unmappable.push(...money.unmappable);
  Object.assign(plan.mine, money.mine);
  plan.changed.push(...money.changed);
  keepProductLines = money.keepProductLines;
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
  // ⑤-2 공유 저장이 상품 안내 글을 새 상품 구성으로 다시 썼으면, 화면이 손대지 않은 옛 글로 되덮지 않는다(사람이 이 저장에서 고친 글이면 그 글이 이긴다)
  const nl = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const wd0 = camp.work_detail && typeof camp.work_detail === 'object' ? camp.work_detail : {};
  if ((out.body.campaign_applied || []).includes('product_lines')
      && !(b.work_detail && typeof b.work_detail === 'object' && Object.prototype.hasOwnProperty.call(b.work_detail, 'productLines') && nl(b.work_detail.productLines) !== nl(wd0.productLines))) {
    keepProductLines = true;
  }
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
  const LEAVES = [['option_url', 'optionUrl', r => r.option_url || ''],
    ['pay_amount', 'payAmount', r => Math.max(0, Math.floor(Number(r.pay_amount) || 0))],   // 5단계 — 창을 연 뒤 리뷰오더에서 바뀐 금액
    // 7단계-② — 창을 연 뒤 리뷰오더에서 바뀐 인원·일건수·혼합 수량
    ['recruit_total', 'recruitTotal', r => Math.max(0, Math.floor(Number(r.recruit_total) || 0))],
    ['daily_limit', 'dailyLimit', r => Math.max(0, Math.floor(Number(r.daily_limit) || 0))],
    ['review_type_mix', 'reviewTypeMix', r => (Array.isArray(r.review_type_mix) ? r.review_type_mix : [])]];
  // ★ 6단계: 가이드는 글·사진 한 묶음으로 본다(비교 = {글, 사진 파일 id} · 지킬 때는 HTML·사진 목록을 함께 지금 DB 값으로) —
  //   한쪽만 되살리면 옛 HTML 끝의 <img> 와 새 사진 목록이 섞여 보인다.
  const gKey = x => JSON.stringify([x.inflow_guide_html, x.inflow_guide_images]);
  const kept = [];
  for (const o of normOpts) {
    const mine = shape({ productName: o.productName, optKey: o.optKey, unitKind: o.unitKind, optionUrl: o.optionUrl, productUrl: o.productUrl,
      inflowGuideHtml: o.inflowGuideHtml, inflowGuideImages: o.inflowGuideImages, payAmount: o.payAmount,
      recruitTotal: o.recruitTotal, dailyLimit: o.dailyLimit, reviewTypeMix: o.reviewTypeMix });
    const b = baseOpts.get(mine.key), c = curByKey.get(mine.key), raw = rawByKey.get(mine.key);
    if (!b || !c || !raw) continue;
    for (const [leaf, field, rawOf] of LEAVES) {
      if (mine[leaf] === b[leaf] && c[leaf] !== b[leaf]) { o[field] = rawOf(raw); kept.push(`${mine.name}·${leaf}`); }
    }
    // 결정 276 — 상품 메인 주소(보낸 줄만 · 안 보낸 줄(null)은 저장이 지금 값을 그대로 둔다)
    if (typeof o.productUrl === 'string' && mine.product_url === b.product_url && c.product_url && c.product_url !== b.product_url) {
      o.productUrl = raw.product_url || ''; kept.push(`${mine.name}·product_url`);
    }
    if (gKey(mine) === gKey(b) && gKey(c) !== gKey(b)) {
      o.inflowGuideHtml = raw.inflow_guide_html || '';
      o.inflowGuideImages = Array.isArray(raw.inflow_guide_images) ? raw.inflow_guide_images : [];
      kept.push(`${mine.name}·유입가이드`);
    }
  }
  if (kept.length) logger.info(`[bidir/campaign] ${link.camp.id} 창을 연 뒤 리뷰오더 쪽에서 바뀐 옵션 칸은 지금 값 유지: ${kept.join(', ')}`);
  return kept;
}

/** 리뷰어앱 스코프 편집 — 연결 공고면 공유 칸 변경을 막는다(그 화면은 기준 버전을 모른다). 같으면 통과. */
async function scopedEditSharedBlock({ campaignId, body, db } = {}) {
  const pool = db || getPool();
  const sw = await readBidirSwitch(pool);
  const link = await findBidirLink(pool, campaignId);
  if (!link) return null;
  const b0 = body || {};
  // 7단계-④: 리뷰어 앱(공고 창과 같은 화면) 총모집은 열린 줄만 — 마감 줄 인원을 더해 공고 총모집과 같은 기준으로 비교한다
  const closedRt = (b0.recruit_total !== undefined && b0.recruit_total !== null && b0.recruit_total !== '') ? await closedRecruitSum(pool, campaignId) : 0;
  const b = closedRt ? { ...b0, recruit_total: (Number(b0.recruit_total) || 0) + closedRt } : b0;
  // ★ 7단계-④: 배송 방식은 작업표 구조 — 스위치와 상관없이 이 화면(기준 버전을 모름)에서는 바꾸지 못한다(같은 값이면 통과).
  const struct = structureChangesFromCampaign({ camp: link.camp, store: { delivery_type: b.delivery_type } }).map(x => x.label);
  if (struct.length) {
    return { status: 409, body: { ok: false, code: 'shared_field_scoped', fields: struct,
      error: `리뷰오더와 연결된 공고라 ${struct.join(', ')}${_topic(struct[struct.length - 1])} 리뷰어 앱에서 바꿀 수 없습니다.` } };
  }
  // ★ 7단계-②(검토 2026-10-21): 스위치가 꺼져 있어도 연결 오더(bidir_state='on')의 인원은 공유 칸이다 — 여기서 바꾸면
  //   syncCampaignRecruitTotal 이 오더 총모집을 버전·전송 없이 써서 인트라넷이 영영 모른다. 인원 칸은 스위치와 상관없이 막는다.
  if (sw.campaign_edit !== 'on') {
    const cnt = _countFieldsChanged(link.camp, b);
    return cnt.length ? _countsPausedBlock(cnt) : null;
  }
  const now = campaignRowView(link.camp);
  const changed = [];
  const t = v => String(v == null ? '' : v).trim();
  if (b.thumbnail_url !== undefined && t(b.thumbnail_url) !== t(now.thumbnail_url)) changed.push('썸네일');
  if (b.time_range !== undefined && t(b.time_range) !== t(now.time_range)) changed.push('구매시간');
  if (b.review_fee !== undefined && b.review_fee !== null && b.review_fee !== ''
      && (Number(b.review_fee) || 0) !== (Number(link.camp.review_fee) || 0)) changed.push('리뷰비');
  // 7단계 — 총모집·일건수는 작업표 칸(연결 오더와 같이 맞춘다). 이 화면은 기준 버전을 몰라 연결 공고에서는 바꾸지 못한다.
  if (b.recruit_total !== undefined && b.recruit_total !== null && b.recruit_total !== ''
      && (Number(b.recruit_total) || 0) !== (Number(link.camp.recruit_total) || 0)) changed.push('총모집');
  if (b.daily_limit !== undefined && b.daily_limit !== null && b.daily_limit !== ''
      && (Number(b.daily_limit) || 0) !== (Number(link.camp.daily_limit) || 0)) changed.push('일 진행 건수');
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

/** 공고 총모집·일 진행 건수가 바뀌었나(보낸 칸만 · 빈 값 = 안 보냄). */
function _countFieldsChanged(camp, b) {
  const out = [];
  const sent = v => v !== undefined && v !== null && v !== '';
  if (sent(b.recruit_total) && (Number(b.recruit_total) || 0) !== (Number(camp.recruit_total) || 0)) out.push('총모집');
  if (sent(b.daily_limit) && (Number(b.daily_limit) || 0) !== (Number(camp.daily_limit) || 0)) out.push('일 진행 건수');
  if (typeof b.skip_weekends === 'boolean' && b.skip_weekends !== (camp.skip_weekends === true)) out.push('주말 제외');   // 7단계-③
  return out;
}

function _countsPausedBlock(fields) {
  return { status: 409, body: { ok: false, code: 'counts_link_paused', fields,
    error: `리뷰오더와 연결된 공고의 작업표 칸(${fields.join(', ')})은 지금 이 화면에서 바꿀 수 없습니다 — 연결 저장이 잠시 꺼져 있습니다. 인트라넷 리뷰오더에서 바꾸거나, 연결 저장이 다시 켜진 뒤 고쳐 주세요.` } };
}

/**
 * 7단계-②(검토 2026-10-21) — 스위치(campaign_edit)가 꺼진 공고 창 저장이 연결 오더의 인원을 바꾸려 하면 막는다.
 * 스위치가 켜져 있으면 null(공유 저장이 맡는다). 옵션 인원·일건수도 지금 공고 옵션 줄과 비교한다.
 */
async function countsBlockedWhileSwitchOff({ campaignId, body, db } = {}) {
  const pool = db || getPool();
  if ((await readBidirSwitch(pool)).campaign_edit === 'on') return null;
  const link = await findBidirLink(pool, campaignId);
  if (!link) return null;
  const b0 = body || {};
  const { rows } = await pool.query(`SELECT opt_key, recruit_total, daily_limit, status FROM campaign_options WHERE campaign_id = $1 AND status <> 'deleted'`, [campaignId]);
  // 7단계-④ 공고 창 총모집은 열린 줄만 — 마감 줄 인원을 더해 공고 총모집과 같은 기준으로 본다
  const closedRt = rows.filter(r => String(r.status) === 'closed').reduce((a, r) => a + (Number(r.recruit_total) || 0), 0);
  const b = (closedRt && b0.recruit_total !== undefined && b0.recruit_total !== null && b0.recruit_total !== '') ? { ...b0, recruit_total: (Number(b0.recruit_total) || 0) + closedRt } : b0;
  const cnt = _countFieldsChanged(link.camp, b);
  if (Array.isArray(b.options)) {
    const byKey = new Map(rows.map(r => [String(r.opt_key || ''), r]));
    const sent = v => v !== undefined && v !== null && v !== '';
    for (const o of b.options) {
      const r = o && byKey.get(String(o.optKey ?? o.opt_key ?? '').trim());
      if (!r) continue;
      const rt = o.recruitTotal ?? o.recruit_total, dl = o.dailyLimit ?? o.daily_limit;
      if ((sent(rt) && (Number(rt) || 0) !== (Number(r.recruit_total) || 0)) || (sent(dl) && (Number(dl) || 0) !== (Number(r.daily_limit) || 0))) { cnt.push('옵션 인원'); break; }
    }
  }
  return cnt.length ? _countsPausedBlock(cnt) : null;
}

/** 받침 있으면 '은', 없으면 '는'(한글이 아니면 '는'). */
function _topic(word) {
  const code = String(word || '').trim().slice(-1).charCodeAt(0) - 0xAC00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? '은' : '는';
}

/**
 * 7단계-④ — 연결 오더가 있는 공고(스위치와 상관없이)의 구조 변경을 막는다(쓰기 0).
 * 지금은 공고만 바뀌고 오더·인트라넷에는 안 가는 틈이다(옵션 더하기·지우기·이름, 배송 방식, 리뷰타입, 체험단 종류 — 사전 점검 2026-10-21).
 * ★ 접수 뒤 영구 금지(체험단 종류 전환·배송 혼합·회수)는 "새 리뷰오더로" 안내, 나머지는 함께 맞추는 기능이 열릴 때까지 같은 409.
 * ★ 연결 판정이 실패하면 예외(저장 실패 = 막힌 쪽) — 이 검사는 모든 쓰기보다 앞에 있다.
 * @param {{campaignId:string, store:object, normOpts:Array|null, db?:object}} a
 * @returns {Promise<null|{status:number, body:object}>}
 */
async function structureBlocked({ campaignId, store, normOpts, body, db } = {}) {
  const pool = db || getPool();
  const link = await findBidirLink(pool, campaignId);
  if (!link) return null;
  const { rows: campOptions } = await pool.query(
    'SELECT opt_key, product_name, unit_kind, status FROM campaign_options WHERE campaign_id = $1', [campaignId]);
  const ch = structureChangesFromCampaign({ camp: link.camp, campOptions, store, normOpts });
  if (!ch.length) return null;
  const perm = ch.filter(x => x.permanent).map(x => x.label);
  if (perm.length) {
    return { status: 409, body: { ok: false, code: 'structure_new_order', fields: perm,
      error: `접수된 리뷰오더와 연결된 공고라 ${perm.join('·')}${_topic(perm[perm.length - 1])} 바꿀 수 없습니다. 작업표 모양 자체가 달라지는 변경이라 새 리뷰오더로 만들어 주세요.` } };
  }
  // ② 상품·옵션 더하기·지우기·다시 열기는 공유 저장으로 간다(오더·작업표·인트라넷까지) — 연결 저장이 켜져 있고 기준 버전을 아는 창에서만.
  const rest = ch.filter(x => !STRUCTURE_SHARED_LABELS.has(x.label)).map(x => x.label);
  if (rest.length) {
    return { status: 409, body: { ok: false, code: 'structure_linked_pending', fields: rest,
      error: `리뷰오더와 연결된 공고라 ${rest.join('·')}${_topic(rest[rest.length - 1])} 아직 이 창에서 바꿀 수 없습니다. 인트라넷 리뷰오더와 함께 맞추는 기능을 준비하고 있습니다.` } };
  }
  const shared = ch.map(x => x.label);
  // 영구 금지 작업(배송 혼합·회수 · 블로그 · 구매수량 단계)은 더하기·지우기도 새 리뷰오더로(재검토 2026-10-21 — 종전엔 "구조 단계에서 엽니다" 로 거부됐다)
  //   배송 한 종류 바꾸기는 판정이 따로다(배송 혼합·회수·블로그만 막힘 — 구매수량 단계와는 무관 · 공유 저장 deliverySwapOpen 과 같은 판정)
  const sp = require('./sharedPatch.service');
  const st0 = sp.readSharedState(link.wo);
  if ((shared.some(l => l !== '배송 방식') && sp.structurePermanentlyLocked(st0)) || (shared.includes('배송 방식') && !sp.deliverySwapOpen(st0))) {
    return { status: 409, body: { ok: false, code: 'structure_new_order', fields: shared,
      error: `접수된 리뷰오더와 연결된 공고라 이 작업(배송 혼합·회수, 블로그, 구매수량 단계 중 하나)은 ${shared.join('·')}${_topic(shared[shared.length - 1])} 할 수 없습니다. 새 리뷰오더로 만들어 주세요.` } };
  }
  if ((await readBidirSwitch(pool)).campaign_edit !== 'on') return _countsPausedBlock(shared);
  if (!(Number(body && body.bidir_base_sync_version) > 0)) {
    return { status: 409, body: { ok: false, code: 'stale_editor', fields: shared,
      error: `리뷰오더와 맞춰지는 공고라 이 창에서는 ${shared.join('·')}${_topic(shared[shared.length - 1])} 할 수 없습니다. 모집공고 편집 창(전체 편집)을 새로 열어 주세요.` } };
  }
  return null;
}

/** 7단계-④ ② 공유 저장으로 보내는 구조 변경(나머지는 아직 막힘). */
const STRUCTURE_SHARED_LABELS = new Set(['옵션·상품 추가', '옵션·상품 삭제', '옵션 마감·다시 열기', '옵션·상품 이름', '상품 이름', '리뷰타입', '배송 방식']);   // ③ 이름 바꾸기 · ④ 리뷰타입 · ⑤ 배송 한 종류 포함

/** 공고 마감 줄(참여한 수로 굳은 옵션)의 인원 합 — 공고 창·리뷰어 앱 총모집(열린 줄만)을 공고 총모집과 같은 기준으로 맞출 때 더한다(7단계-④). */
async function closedRecruitSum(db, campaignId) {
  const { rows } = await (db || getPool()).query(
    `SELECT COALESCE(SUM(recruit_total), 0)::int AS n FROM campaign_options WHERE campaign_id = $1 AND status = 'closed'`, [campaignId]);
  return Number(rows[0] && rows[0].n) || 0;
}

/** 연결 오더가 있는가(스위치와 상관없이) — 차수처럼 인원을 바꾸는 옛 경로를 막는 데 쓴다. 판정 실패 = true(fail-closed). */
async function bidirOrderLinked(campaignId, db) {
  try { return !!(await findBidirLink(db || getPool(), campaignId)); }
  catch (e) {
    logger.warn(`[bidir/campaign] ${campaignId} 연결 판정 실패 — 연결 공고로 보고 인원 쓰기를 막는다: ${(e && e.message) || e}`);
    return true;
  }
}

/** 이 공고가 지금 양방향 연결(스위치 campaign_edit=on)인가 — 옛 경로가 리뷰비 같은 공유 칸을 쓰지 않게 고르는 데 쓴다.
 *  ★ 판정 실패 = true(연결로 본다 · fail-closed) — 돈을 쓰는 경로라, DB 가 잠깐 흔들린 사이 지난 참여 고정 없이 리뷰비가 써지면 안 된다(검토 2026-10-20). */
async function bidirLinkActive(campaignId, db) {
  try {
    const pool = db || getPool();
    if ((await readBidirSwitch(pool)).campaign_edit !== 'on') return false;
    return !!(await findBidirLink(pool, campaignId));
  } catch (e) {
    logger.warn(`[bidir/campaign] ${campaignId} 연결 판정 실패 — 연결 공고로 보고 리뷰비 쓰기를 막는다: ${(e && e.message) || e}`);
    return true;
  }
}

module.exports = { applyCampaignSharedSave, protectOptionLeaves, scopedEditSharedBlock, findBidirLink, bidirLinkActive, bidirOrderLinked, countsBlockedWhileSwitchOff, structureBlocked, closedRecruitSum, WD_SHARED_KEYS };
