// ═══════════════════════════════════════════════════════════════════════════
// 양방향 공유 저장 — 연결된 작업오더의 공유 칸을 한 트랜잭션에서 고치고 공고까지 맞춘다 (결정 263 · 3단계)
//
// ★★ 쓰기 단일 출처 — 연결(`bidir_state='on'`)된 오더의 공유 칸은 이 함수로만 바뀐다.
//    판정은 `utils/sharedPatchPlan`(3방향), 공고 반영은 기존 전파 본체(`*InTx`)를 같은 트랜잭션에서 부른다.
// ★★ 부분 반영 금지 — 보기전용·아직 못 고치는 칸(그리고 정책이 block 일 때 충돌)이 하나라도 있으면 아무것도 쓰지 않고 409.
//    인트라넷발(`conflictPolicy:'last_writer'`)은 겹친 칸을 나중 저장 값으로 쓰고 덮인 값을 `overwritten` 으로 돌려준다(사용자 확정 2026-10-20).
//    공고 반영이 거부되면(가이드 없는 가이드유입·읽지 못한 구매시간) 오더 쓰기까지 통째로 되돌린다.
// ★★ 잠금 순서(완화 금지 · 결정 262) — L1(`recruit_campaign_wo:<오더>`) → 오더 행 → 공고 행.
//    3단계 칸은 작업표와 무관해 탭 잠금(L2)을 잡지 않는다. 작업표에 닿는 칸(7단계)이 들어오면
//    L2 를 오더 행 잠금 **앞**에 넣는다(결정 182 「탭 잠금은 첫 잠금」).
// ★ 버전 = HLC `GREATEST(이전+1, 현재 µs)` — DB 복원으로 버전이 되돌아가도 새 쓰기가 옛 버전과 겹치지 않는다.
// ★ 3단계에서 고칠 수 있는 칸(`PHASE3_*`) 밖의 변경은 `field_not_editable` 로 막는다 — 다음 단계가 열 때까지.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const getPool = () => require('../db/pool');
const { logger } = require('../utils/logger');
const { SHARED_FIELDS, FIELD_BY_KEY } = require('../utils/sharedFields');
const { planSharedPatch, ABSENT } = require('../utils/sharedPatchPlan');
const { projectOrderToCampaign } = require('../utils/orderToCampaignProjection');

const NEXT_VERSION_SQL = `GREATEST(sync_version + 1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint)`;

/** 3단계에 양방향으로 여는 공유 칸 — 글 칸 묶음(설계 3단계). */
const PHASE3_SHARED_FIELDS = Object.freeze([
  'review_guide', 'special_notes', 'guide_images', 'inflow_guide', 'inflow_type', 'thumbnail_url',
  'purchase_time', 'product_url', 'purchase_channel', 'purchase_channel_custom', 'required_delivery_memo',
]);
/** 인트라넷 고유 칸 중 접수 뒤에도 고칠 수 있는 것 — 종전 원본 수정 허용 목록·계약 후속 매칭과 같은 범위. */
const INTRANET_EDITABLE_AFTER_ACCEPT = Object.freeze([
  'title', 'manager_name', 'inflow_keyword', 'sales_id', 'quote_id', 'contract_number', 'intranet_advertiser_id',
]);
/** 리뷰웹발 수정(관리자 오더 수정)이 쓸 수 있는 칸 — 인트라넷 고유는 제외. */
const WRITABLE_BY_ORIGIN = {
  intranet: new Set([...PHASE3_SHARED_FIELDS, ...INTRANET_EDITABLE_AFTER_ACCEPT]),
  reconcile: new Set([...PHASE3_SHARED_FIELDS, ...INTRANET_EDITABLE_AFTER_ACCEPT]),
  rw_admin: new Set(PHASE3_SHARED_FIELDS),
};
const KNOWN_CHANNELS = new Set(['쿠팡', '네이버', '올리브영', '카카오메이커스']);
const SNAPSHOT_KEYS = Object.freeze([...SHARED_FIELDS.map(f => f.key), 'product_options_json', 'product_option']);

/** 작업오더 행 → 공유 상태(스냅숏·비교용). 날짜는 'YYYY-MM-DD', 나머지는 저장 형태 그대로. */
function readSharedState(wo) {
  const out = {};
  for (const k of SNAPSHOT_KEYS) {
    if (!wo || !Object.prototype.hasOwnProperty.call(wo, k)) continue;
    let v = wo[k];
    if (v instanceof Date) v = Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    out[k] = v === undefined ? null : v;
  }
  return JSON.parse(JSON.stringify(out));
}

/** 판정 행(경로 + 경로 종류)이 이 출처에서 쓸 수 있는가. 상품 쪽은 3단계에서 주소(url) 칸만. */
function writablePath(row, origin) {
  const set = WRITABLE_BY_ORIGIN[origin];
  if (!set) return false;
  const m = row.meta || {};
  if (m.kind === 'field') return set.has(m.key);
  return m.kind === 'leaf' && m.key === 'url';
}

/** 사람이 읽는 칸 이름 — 내부 경로(`p:상품|o:옵션.key`)를 그대로 보이지 않는다. 상품·옵션은 이름까지만. */
function _label(rowOrPath) {
  const row = typeof rowOrPath === 'string' ? { path: rowOrPath } : rowOrPath;
  const path = row.path;
  if (path.startsWith('f:')) { const f = FIELD_BY_KEY.get(path.slice(2)); return f ? f.label : path.slice(2); }
  if (path.startsWith('p:')) {
    const owner = (row.meta && row.meta.parent) || path;
    const [prod, opt] = owner.slice(2).split('|o:');
    const name = String(prod || '').trim();
    return `상품·옵션(${name && name !== '-' ? name : '상품'}${opt ? ' / ' + opt : ''})`;
  }
  if (path.startsWith('products:')) return '상품·옵션';
  return path;
}

/** 알림에 보일 값 — 정규화 값을 사람이 읽는 글로. 사진 목록은 장수, 없음·빈칸은 말로, 길면 자른다. */
function _display(path, v) {
  if (v === ABSENT || v === undefined) return '(없음)';
  if (v === null || v === '') return '(빈칸)';
  if (path === 'f:guide_images') { const l = _parseList(v); if (l) return l.length ? `사진 ${l.length}장` : '(사진 없음)'; }
  const s = String(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

function _parseList(v) {
  if (Array.isArray(v)) return JSON.parse(JSON.stringify(v));
  try { const p = JSON.parse(String(v || '')); return Array.isArray(p) ? p : null; } catch (_) { return null; }
}

/** theirs 에 쓰기 목록을 적용한 다음 상태. 상품 주소는 같은 이름의 상품·옵션에만. */
function applyWrites(theirs, mine, writes) {
  const next = JSON.parse(JSON.stringify(theirs || {}));
  let productsTouched = false;
  const nextProducts = _parseList(next.product_options_json);
  const mineProducts = _parseList(mine && mine.product_options_json) || [];
  for (const w of writes) {
    if (w.path.startsWith('f:')) { next[w.path.slice(2)] = mine[w.path.slice(2)]; continue; }
    const m = /^p:(.+?)(?:\|o:(.+))?\.url$/.exec(w.path);
    if (!m || !nextProducts) continue;
    const [, pName, oLabel] = m;
    const findP = list => list.find(p => p && String(p.name || '').trim() === pName);
    const findO = p => (Array.isArray(p && p.options) ? p.options : []).find(o => String(o && o.label || '').trim() === oLabel);
    const tp = findP(nextProducts); const mp = findP(mineProducts);
    if (!tp || !mp) continue;
    if (oLabel) { const to = findO(tp); const mo = findO(mp); if (!to || !mo) continue; to.url = mo.url; }
    else tp.url = mp.url;
    productsTouched = true;
  }
  if (productsTouched) {
    next.product_options_json = JSON.stringify(nextProducts);
    if (mine && mine.product_option !== undefined) next.product_option = mine.product_option;
  }
  return { next, productsTouched };
}

const ORDER_COLUMNS = new Set([...SNAPSHOT_KEYS]);
const EXTRA_COLUMNS = new Set(['source_revision', 'intake_idempotency_key', 'intranet_advertiser_name',
  'intranet_advertiser_contact', 'intranet_advertiser_business_number']);

/** 공고 반영 — 쓴 칸만. 거부 사유가 있으면 {reject} 를 돌려 호출부가 통째로 되돌린다. */
async function projectToCampaignInTx(client, camp, next, writtenKeys, productsTouched) {
  const sync = require('./campaignPayAmountSync.service');
  const applied = [];
  const has = k => writtenKeys.has(k);
  const proj = projectOrderToCampaign(next);
  const prefill = require('../utils/woCampaignPrefill.generated')._woCampaignPrefill(JSON.parse(JSON.stringify(next)));

  if (has('thumbnail_url') && String(next.thumbnail_url || '').trim()) {
    const r = await sync.syncCampaignThumbnailInTx(client, camp, String(next.thumbnail_url).trim());
    if (r.applied) applied.push('thumbnail');
  }
  if (has('inflow_type') || has('inflow_guide') || has('guide_images')) {
    const guideEdit = has('inflow_guide') || has('guide_images');
    const r = await sync.syncCampaignInflowInTx(client, camp, {
      nextType: has('inflow_type') ? sync.normalizeInflowType(next.inflow_type) : '',
      commonGuide: guideEdit ? { text: next.inflow_guide, images: next.guide_images } : undefined,
      productOptionsJson: undefined, hasGuideEdit: guideEdit, hasUnitEdit: false,
    });
    if (!r.applied && r.reason === 'guide_missing') return { reject: { kind: 'inflow', out: r } };
    if (r.applied) applied.push('inflow');
  }
  if (has('purchase_time')) {
    const r = await sync.syncCampaignPurchaseWindowInTx(client, camp, next.purchase_time, { textOnlyWhenLegacy: true });
    if (!r.applied && r.reason === 'unparsed') return { reject: { kind: 'time', out: r } };
    if (r.applied) applied.push('time');
  }
  if (has('review_guide') || has('special_notes') || has('guide_images')) {
    const { rows } = await client.query('SELECT work_detail FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [camp.id]);
    let wd = rows[0] && rows[0].work_detail;
    if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
    if (!wd || typeof wd !== 'object' || Array.isArray(wd)) wd = {};
    const want = {
      reviewGuide: String(prefill.wd_review || ''), reviewGuideImages: prefill.wd_review_images || [],
      specialNotes: String(prefill.wd_notes || ''), specialNotesImages: prefill.wd_notes_images || [],
    };
    const nextWd = Object.assign({}, wd);
    let changed = false;
    for (const [k, v] of Object.entries(want)) {
      if (JSON.stringify(wd[k] === undefined ? (Array.isArray(v) ? [] : '') : wd[k]) !== JSON.stringify(v)) { nextWd[k] = v; changed = true; }
    }
    if (changed) {
      await client.query('UPDATE recruit_campaigns SET work_detail = $2::jsonb, updated_at = NOW() WHERE id = $1', [camp.id, JSON.stringify(nextWd)]);
      applied.push('guides');
    }
  }
  if (has('product_url') || productsTouched || has('inflow_type') || has('inflow_guide')) {
    if (proj.landing_url) {
      const { rowCount } = await client.query(
        `UPDATE recruit_campaigns SET landing_url = $2, updated_at = NOW() WHERE id = $1 AND COALESCE(landing_url,'') <> $2`,
        [camp.id, proj.landing_url]);
      if (rowCount) applied.push('landing');
    }
    if (productsTouched || has('product_url')) {
      for (const o of proj.options) {
        const [pName, optKey] = o.key.split('|');
        const { rowCount } = await client.query(
          `UPDATE campaign_options SET option_url = $4, updated_at = NOW()
            WHERE campaign_id = $1 AND status <> 'closed'
              AND ((unit_kind = 'product' AND $3 = '' AND (opt_key = $2 OR product_name = $2))
                OR (COALESCE(unit_kind,'option') <> 'product' AND opt_key = $3 AND $3 <> ''))
              AND COALESCE(option_url,'') <> $4`,
          [camp.id, pName, optKey, o.option_url]);
        if (rowCount) applied.push('option_url');
      }
    }
  }
  if (has('purchase_channel') || has('purchase_channel_custom') || has('product_url')) {
    const ch = String(proj.channel || '').trim();
    if (ch) {
      const [channel, custom] = KNOWN_CHANNELS.has(ch) ? [ch, ''] : ['직접입력', ch];
      const { rowCount } = await client.query(
        `UPDATE recruit_campaigns SET channel = $2, channel_custom = $3, updated_at = NOW()
          WHERE id = $1 AND (COALESCE(channel,'') <> $2 OR COALESCE(channel_custom,'') <> $3)`,
        [camp.id, channel, custom]);
      if (rowCount) applied.push('channel');
    }
  }
  return { applied };
}

async function _abort(client, status, body) {
  try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
  return { status, body };
}

/**
 * @param {object} p
 * @param {string} p.workOrderId
 * @param {object} p.mine        보낸 공유 상태(저장 형태 · 칸 이름 = 작업오더 칸)
 * @param {number} p.baseVersion 수정 화면을 연 시점의 버전
 * @param {'intranet'|'rw_admin'|'reconcile'} p.origin
 * @param {string} [p.opId] 같은 저장 재전송 판별
 * @param {string} [p.actor]
 * @param {string[]} [p.forceMine] 사람이 "내 값" 을 고른 경로
 * @param {'block'|'last_writer'} [p.conflictPolicy] 겹친 칸 처리 — block(기본, 409 쓰기 0) · last_writer(이번 저장 값으로 쓰고 overwritten 으로 알림)
 * @param {(client, wo) => Promise<null|{status,body}>} [p.preHook] 같은 트랜잭션에서 먼저 검사(원본 번호 등)
 * @param {object} [p.extraSets] 공유 칸이 아닌 같이 쓸 칸(원본 번호·키 등 — EXTRA_COLUMNS 만)
 * @param {object} [p.db] 시험용 pool
 */
async function applySharedPatch(p) {
  if (String(process.env.BIDIR_HARD_OFF || '').trim() === '1') return { status: 503, body: { ok: false, code: 'bidir_off', error: '양방향 동기화가 꺼져 있습니다.' } };
  const lrq = require('./linkedRecruitQuota.service');
  const client = await (p.db || getPool()).connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '10s'`);
    await lrq.lockWorkOrderCampaigns(client, [p.workOrderId]);                                  // L1
    const { rows: woRows } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [p.workOrderId]);
    const wo = woRows[0];
    if (!wo || wo.deleted_at) return await _abort(client, 404, { ok: false, code: 'order_not_found', error: '작업오더를 찾을 수 없습니다.' });
    const peek = await lrq.liveCampaignForWorkOrders(client, [wo.id]);                          // 보관(마감) 공고 제외
    let camp = null;
    if (peek) {
      const { rows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [peek.id]);
      camp = rows[0] || null;
      if (!camp) return await _abort(client, 409, { ok: false, code: 'link_changed_retry', error: '연결 공고가 방금 바뀌었습니다. 다시 시도해 주세요.' });
    }
    if (p.preHook) { const r = await p.preHook(client, wo); if (r) return await _abort(client, r.status, r.body); }
    if (wo.bidir_state !== 'on' && p.origin !== 'reconcile') {
      return await _abort(client, 409, { ok: false, code: 'bidir_not_on', state: wo.bidir_state, error: '이 오더는 양방향 동기화가 연결돼 있지 않습니다.' });
    }
    const curVersion = Number(wo.sync_version || 0);
    if (p.opId) {
      const { rows } = await client.query('SELECT sync_version FROM work_order_shared_snapshots WHERE op_id = $1 LIMIT 1', [String(p.opId)]);
      if (rows.length) return await _abort(client, 200, { ok: true, idempotent: true, sync_version: Number(rows[0].sync_version) });
    }
    const theirs = readSharedState(wo);
    const { rows: baseRows } = await client.query(
      'SELECT state FROM work_order_shared_snapshots WHERE work_order_id = $1 AND sync_version = $2', [wo.id, Number(p.baseVersion)]);
    if (!baseRows.length) {
      return await _abort(client, 409, { ok: false, code: 'edit_base_missing', sync_version: curVersion,
        error: '수정 화면을 연 뒤 기준 정보가 사라졌습니다. 창을 닫고 다시 열어 주세요.' });
    }
    const base = baseRows[0].state;
    const plan = planSharedPatch({ base, mine: p.mine, theirs, origin: p.origin, forceMine: p.forceMine || [] });

    const blocked = [...plan.writes, ...plan.conflicts].filter(w => !writablePath(w, p.origin));
    if (blocked.length) {
      return await _abort(client, 409, { ok: false, code: 'field_not_editable', sync_version: curVersion,
        fields: blocked.map(w => ({ path: w.path, label: _label(w) })),
        error: `이 칸은 아직 여기서 바꿀 수 없습니다: ${[...new Set(blocked.map(w => _label(w)))].join(', ')}` });
    }
    // ★ 겹친 칸 = 나중에 저장한 값(사용자 확정 2026-10-20 · 인트라넷발만) — 덮인 리뷰웹 값은 응답 `overwritten` 으로
    //   돌려줘 저장한 사람이 확인하게 하고, 스냅숏 이력에 남는다. 보기전용(readOnly)은 정책과 무관하게 막는다.
    const lastWriter = p.conflictPolicy === 'last_writer';
    if ((plan.conflicts.length && !lastWriter) || plan.readOnly.length) {
      return await _abort(client, 409, { ok: false, code: 'field_conflict', sync_version: curVersion,
        conflicts: plan.conflicts.map(c => ({ ...c, label: _label(c) })),
        readOnly: plan.readOnly.map(c => ({ ...c, label: _label(c) })),
        error: '다른 곳에서 같은 칸이 먼저 바뀌었습니다. 어느 값을 남길지 골라 주세요.' });
    }

    const overwritten = lastWriter ? plan.conflicts.map(c => ({ path: c.path, label: _label(c), before: _display(c.path, c.theirs), after: _display(c.path, c.mine) })) : [];
    if (lastWriter && plan.conflicts.length) plan.writes = [...plan.writes, ...plan.conflicts];
    const extra = Object.entries(p.extraSets || {}).filter(([k]) => EXTRA_COLUMNS.has(k));
    if (!plan.writes.length && !extra.length) {
      await client.query('COMMIT');
      return { status: 200, body: { ok: true, noop: true, sync_version: curVersion } };
    }
    const { next, productsTouched } = applyWrites(theirs, p.mine, plan.writes);
    const writtenKeys = new Set(plan.writes.filter(w => w.path.startsWith('f:')).map(w => w.path.slice(2)));

    // ── 오더 쓰기(쓴 칸 + 함께 쓰는 칸) ──
    const sets = []; const params = [wo.id];
    const add = v => { params.push(v); return `$${params.length}`; };
    for (const k of writtenKeys) if (ORDER_COLUMNS.has(k) && /^[a-z_]+$/.test(k)) sets.push(`${k} = ${add(next[k])}`);
    if (productsTouched) {
      sets.push(`product_options_json = ${add(next.product_options_json)}`);
      if (next.product_option !== undefined) sets.push(`product_option = ${add(next.product_option)}`);
    }
    for (const [k, v] of extra) sets.push(`${k} = ${add(v)}`);
    if (plan.writes.length) {
      // 새 버전은 한 번만 계산해 두 칸에 같은 값을 쓴다(시각이 들어가 두 번 계산하면 값이 갈린다).
      const { rows: nv } = await client.query(
        `SELECT GREATEST($1::bigint + 1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint) AS v`, [curVersion]);
      const v = add(String(nv[0].v));
      sets.push(`sync_version = ${v}::bigint`);
      if (p.origin === 'intranet') sets.push(`intranet_acked_version = ${v}::bigint`);
    }
    const { rows: upd } = await client.query(
      `UPDATE work_orders SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND sync_version = ${add(curVersion)} RETURNING *`, params);
    if (!upd.length) return await _abort(client, 409, { ok: false, code: 'version_race', error: '같은 오더의 다른 저장이 먼저 처리됐습니다. 다시 시도해 주세요.' });
    const saved = upd[0];
    const newVersion = Number(saved.sync_version);

    // ── 공고 반영(같은 트랜잭션) ──
    let campaign = { applied: [] };
    if (camp && plan.writes.length) {
      campaign = await projectToCampaignInTx(client, camp, next, writtenKeys, productsTouched);
      if (campaign.reject) {
        const { campaignSyncNotice } = require('./campaignPayAmountSync.service');
        return await _abort(client, 409, { ok: false, code: 'campaign_rejected', sync_version: curVersion,
          reason: campaign.reject.out.reason, detail: campaign.reject.out.detail || null,
          error: campaignSyncNotice(campaign.reject.kind, campaign.reject.out) || '모집공고에 반영할 수 없어 저장하지 않았습니다.' });
      }
    }
    if (plan.writes.length) {
      await client.query(
        `INSERT INTO work_order_shared_snapshots (work_order_id, sync_version, origin, op_id, state, actor)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [wo.id, newVersion, p.origin, String(p.opId || ''), JSON.stringify(readSharedState(saved)), String(p.actor || '')]);
      if (p.origin !== 'intranet') {
        await client.query(`INSERT INTO shared_sync_outbox (work_order_id, sync_version) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [wo.id, newVersion]);
      }
    }
    await client.query('COMMIT');
    if (overwritten.length) logger.info(`[bidir/apply] ${wo.id} 겹친 칸을 나중 저장 값으로(${p.origin}·${p.actor || ''}): ${overwritten.map(o => o.label).join(', ')}`);
    return { status: 200, body: { ok: true, data: saved, sync_version: newVersion, applied: plan.writes.map(w => w.path), campaign_applied: campaign.applied, overwritten } };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (['40P01', '55P03', '57014'].includes(e && e.code)) {
      logger.warn(`[bidir/apply] ${p.workOrderId} 잠금 대기 초과(${e.code}) — 다시 시도 안내`);
      return { status: 503, body: { ok: false, code: 'busy_retry', error: '같은 작업이 다른 저장으로 바쁩니다. 잠시 뒤 다시 저장해 주세요.' } };
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 오더를 양방향으로 연결한다 — 사용자 확정 D1: **값이 같은 오더만** 바로 연결(on), 다르면 `diverged`(직원이 고를 때까지 대기).
 * ★ 마감(보관) 공고는 대상이 아니다(사용자 확정 2026-10-20) · 공고 없는 오더도 대상 아님.
 * @returns {{ status:number, body:object }}
 */
async function linkSharedOrder({ workOrderId, actor = '', dryRun = false, db } = {}) {
  const { compareOrderCampaign } = require('../utils/orderToCampaignProjection');
  const lrq = require('./linkedRecruitQuota.service');
  const client = await (db || getPool()).connect();
  try {
    await client.query('BEGIN');
    await lrq.lockWorkOrderCampaigns(client, [workOrderId]);
    const { rows: woRows } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [workOrderId]);
    const wo = woRows[0];
    if (!wo || wo.deleted_at) return await _abort(client, 404, { ok: false, code: 'order_not_found' });
    if (!String(wo.source_review_order_id || '').trim()) return await _abort(client, 409, { ok: false, code: 'not_intranet_order', error: '인트라넷 리뷰오더로 들어온 오더가 아닙니다.' });
    if (wo.bidir_state === 'on') return await _abort(client, 200, { ok: true, state: 'on', already: true, sync_version: Number(wo.sync_version) });
    const peek = await lrq.liveCampaignForWorkOrders(client, [wo.id]);
    if (!peek) {
      const { rows: arch } = await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 AND archived_at IS NOT NULL', [String(wo.linked_campaign_id || '')]);
      return await _abort(client, 409, arch.length
        ? { ok: false, code: 'campaign_archived', error: '마감(보관)된 공고의 오더는 연결하지 않습니다.' }
        : { ok: false, code: 'no_campaign', error: '연결된 모집공고가 없습니다.' });
    }
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [peek.id]);
    const { rows: opts } = await client.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY sort_order, id', [peek.id]);
    const diffs = compareOrderCampaign(wo, cRows[0], opts).filter(d => d.kind === 'diff');
    if (dryRun) return await _abort(client, 200, { ok: true, dryRun: true, state: diffs.length ? 'diverged' : 'on', diffs });
    if (diffs.length) {
      await client.query(`UPDATE work_orders SET bidir_state = 'diverged', updated_at = NOW() WHERE id = $1`, [wo.id]);
      await client.query('COMMIT');
      return { status: 200, body: { ok: true, state: 'diverged', diffs } };
    }
    const { rows: v } = await client.query(
      `UPDATE work_orders SET bidir_state = 'on', sync_version = ${NEXT_VERSION_SQL}, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [wo.id]);
    const saved = v[0];
    await client.query(
      `INSERT INTO work_order_shared_snapshots (work_order_id, sync_version, origin, op_id, state, actor)
       VALUES ($1, $2, 'link', '', $3::jsonb, $4)`,
      [wo.id, Number(saved.sync_version), JSON.stringify(readSharedState(saved)), String(actor || '')]);
    await client.query('COMMIT');
    return { status: 200, body: { ok: true, state: 'on', sync_version: Number(saved.sync_version) } };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  applySharedPatch, linkSharedOrder, readSharedState, applyWrites, writablePath, projectToCampaignInTx,
  PHASE3_SHARED_FIELDS, INTRANET_EDITABLE_AFTER_ACCEPT, NEXT_VERSION_SQL,
};
