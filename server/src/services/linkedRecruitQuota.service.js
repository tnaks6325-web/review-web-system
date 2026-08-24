/**
 * 연결 작업오더 ↔ 모집공고 정원 동기화.
 *
 * 두 테이블의 총모집은 화면상 같은 업무 값을 뜻한다. 과거에는 공고 생성 시에만
 * work_orders.recruit_count를 프리필해서, 어느 한쪽을 나중에 고치면 반대쪽이
 * 조용히 남는 드리프트가 생겼다. 이 모듈만 두 방향 쓰기를 담당한다.
 */
const pool = require('../db/pool');

function quota(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function quotaError(message, code = 'recruit_quota_invalid') {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 화면에 보여줄 총정원만 결정한다. 레거시 공고의 recruit_total=0은 기존에는
 * "무제한"이라는 뜻이기도 했으므로 DB 값을 쓰거나 참여 판정을 바꾸지 않는다.
 * 연결 작업오더에 양수 모집인원이 있을 때에만 표시용 대체값으로 사용한다.
 */
function displayRecruitTotal(campaignTotal, workOrderTotal) {
  const campaign = quota(campaignTotal);
  if (campaign > 0) return { total: campaign, source: 'campaign' };
  const workOrder = quota(workOrderTotal);
  return workOrder > 0
    ? { total: workOrder, source: 'work_order' }
    : { total: 0, source: 'none' };
}

/** 작업보드 슬롯 증감량. 참여/주문 정보가 있는 행은 어떤 경우에도 제거 대상이 아니다. */
function worktableSlotDelta({ current = 0, protectedCount = 0, target = 0 } = {}) {
  const live = quota(current);
  const fixed = quota(protectedCount);
  const next = quota(target);
  if (next < fixed) {
    throw quotaError('이미 참여자 또는 구매양식이 있는 작업보드 인원보다 낮게 목표 인원을 설정할 수 없습니다.', 'recruit_quota_worktable_below_used');
  }
  return { target: next, add: Math.max(0, next - live), retire: Math.max(0, live - next) };
}

function _worktableSlotEmpty(row) {
  return !String(row.reviewer_name || '').trim()
    && !String(row.recipient_name || '').trim()
    && !String(row.phone8 || '').trim()
    && !row.order_submission_id;
}

/**
 * 연결된 무시트 작업표의 활성 슬롯 수를 목표 인원과 일치시킨다.
 * 호출자는 동일 트랜잭션에서 작업오더/공고 정원을 갱신하므로, 슬롯 축소 실패 시
 * 두 저장값도 함께 롤백된다. 투영 장부 재생성은 커밋 후 별도 수행한다.
 */
async function syncWorktableSlotsInTx(client, campaign, target, by = 'quota-sync') {
  if (!campaign || !campaign.linked_sheet_id || !campaign.linked_tab_name) return { synced: false, reason: 'no_worktable_link' };
  const { isSheetless } = require('../utils/sheetlessScope');
  if (!await isSheetless(client, campaign.linked_sheet_id, campaign.linked_tab_name)) return { synced: false, reason: 'not_sheetless' };
  const { rows } = await client.query(
    `SELECT id, seq, tab_gid, reviewer_name, recipient_name, phone8, order_submission_id
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
      ORDER BY seq FOR UPDATE`, [campaign.linked_sheet_id, campaign.linked_tab_name]
  );
  const fixed = rows.filter(r => !_worktableSlotEmpty(r));
  const delta = worktableSlotDelta({ current: rows.length, protectedCount: fixed.length, target });
  if (delta.retire) {
    const ids = rows.filter(_worktableSlotEmpty).sort((a, b) => Number(b.seq) - Number(a.seq)).slice(0, delta.retire).map(r => r.id);
    if (ids.length !== delta.retire) throw quotaError('줄일 수 있는 빈 작업보드 슬롯이 부족합니다.', 'recruit_quota_worktable_below_used');
    await client.query(
      `UPDATE campaign_participants
          SET deleted_at=NOW(), active=FALSE, updated_by=$2, updated_at=NOW()
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids, String(by).slice(0, 100)]
    );
  }
  if (delta.add) {
    // 은퇴한 행도 (sheet_id, tab_name, seq) 유니크키를 차지한다. 활성 행만 기준으로
    // 다시 1번부터 만들면 재증원 때 충돌하므로 탭 전체의 최댓값 뒤에만 추가한다.
    const { rows: seqRows } = await client.query(
      `SELECT COALESCE(MAX(seq), 0)::int AS max_seq FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2`,
      [campaign.linked_sheet_id, campaign.linked_tab_name]
    );
    const maxSeq = Number(seqRows[0] && seqRows[0].max_seq) || 0;
    const tabGid = rows.find(r => r.tab_gid != null)?.tab_gid || null;
    for (let i = 0; i < delta.add; i++) {
      await client.query(
        `INSERT INTO campaign_participants
           (sheet_id, tab_gid, tab_name, seq, row_json, source, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,'{}'::jsonb,'worktable',$5,NOW())`,
        [campaign.linked_sheet_id, tabGid, campaign.linked_tab_name, maxSeq + i + 1, String(by).slice(0, 100)]
      );
    }
  }
  return { synced: true, ...delta, sheetId: campaign.linked_sheet_id, tabName: campaign.linked_tab_name };
}

/** 작업오더 저장 전의 fail-fast 검사. 실제 증감은 동기화 트랜잭션에서 한 번만 한다. */
async function assertWorktableSlotsInTx(client, campaign, target) {
  if (!campaign || !campaign.linked_sheet_id || !campaign.linked_tab_name) return { checked: false, reason: 'no_worktable_link' };
  const { isSheetless } = require('../utils/sheetlessScope');
  if (!await isSheetless(client, campaign.linked_sheet_id, campaign.linked_tab_name)) return { checked: false, reason: 'not_sheetless' };
  const { rows } = await client.query(
    `SELECT reviewer_name, recipient_name, phone8, order_submission_id
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL FOR UPDATE`,
    [campaign.linked_sheet_id, campaign.linked_tab_name]
  );
  return { checked: true, ...worktableSlotDelta({ current: rows.length, protectedCount: rows.filter(r => !_worktableSlotEmpty(r)).length, target }) };
}

async function rebuildWorktableProjection(worktable, by) {
  if (!worktable || !worktable.synced || (!worktable.add && !worktable.retire)) return worktable;
  const { rebuildLedgers } = require('./sheetlessLedger.service');
  const rebuilt = await rebuildLedgers({ sheetId: worktable.sheetId, tabName: worktable.tabName, by: String(by).slice(0, 100) });
  return { ...worktable, projection: { mirrorRows: rebuilt.mirrorRows, indexRows: rebuilt.indexRows } };
}

/**
 * 그 공고에 연결된 작업오더 1건(읽기 전용).
 *
 * ★★ **짝짓기 규칙 단일 출처** — 역방향 링크(`work_orders.linked_campaign_id`) 우선 →
 *   정방향(`recruit_campaigns.source_work_order_id`), 같으면 최근 수정 오더. 067 백필·정원
 *   폴백·혼합 조합 프리필이 **같은 오더**를 봐야 "정원은 A 오더, 조합은 B 오더"가 안 생긴다.
 * ★ 소프트삭제된 오더는 근거가 아니다.
 * ★ 컬럼 이름은 화이트리스트 정규식으로 검증한다(문자열 조립 — 주입 차단).
 */
/* ★★ 짝짓기 SQL 조각 — 소비처가 늘어도 **규칙은 여기 한 곳**이다.
   역방향 링크(`work_orders.linked_campaign_id`) 우선 → 정방향(`recruit_campaigns.source_work_order_id`),
   같으면 최근 수정 오더. 067 백필·정원 폴백·혼합 조합·유입방식이 전부 이 조각을 태운다. */
const LINKED_WO_ON = `((NULLIF(w.linked_campaign_id, '') = c.id) OR (NULLIF(c.source_work_order_id, '') = w.id))`;
const LINKED_WO_ORDER = `(NULLIF(w.linked_campaign_id, '') = c.id) DESC, w.updated_at DESC`;

/**
 * 공고들에 연결된 작업오더 일괄 조회 → Map(campaignId → 그 오더의 요청 컬럼).
 *
 * ★ 소프트삭제된 오더는 근거가 아니다.
 * ★ 컬럼 이름은 화이트리스트 정규식으로 검증한다(문자열 조립 — 주입 차단).
 * ★ `db` 를 받는다 — 잠금 트랜잭션의 client 로도 부를 수 있어야 한다(SAVEPOINT 격리는 호출부 몫).
 */
async function linkedWorkOrdersForCampaigns(db, ids, columns = ['recruit_count']) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean).map(String);
  const safe = (Array.isArray(columns) ? columns : []).filter(c => /^[a-z_][a-z0-9_]*$/.test(String(c)));
  if (!list.length || !safe.length || !db || typeof db.query !== 'function') return new Map();
  const cols = safe.map(c => `w.${c}`).join(', ');
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id) c.id AS campaign_id, ${cols}
       FROM recruit_campaigns c
       JOIN work_orders w ON ${LINKED_WO_ON}
      WHERE c.id = ANY($1) AND w.deleted_at IS NULL
      ORDER BY c.id, ${LINKED_WO_ORDER}`,
    [list]
  );
  const out = new Map();
  for (const r of rows) {
    const { campaign_id: cid, ...rest } = r;
    out.set(cid, rest);
  }
  return out;
}

/** 단건 — 배치와 **같은 규칙**을 태운다(사본 0). */
async function linkedWorkOrderForCampaign(campaign, columns = ['recruit_count']) {
  if (!campaign || !campaign.id) return null;
  const m = await linkedWorkOrdersForCampaigns(pool, [campaign.id], columns);
  return m.get(String(campaign.id)) || null;
}

/** 연결 작업오더의 모집인원으로 레거시 공고의 표시 총정원을 보완한다(읽기 전용). */
async function displayRecruitTotalForCampaign(campaign) {
  const primary = quota(campaign && campaign.recruit_total);
  if (primary > 0) return { total: primary, source: 'campaign' };
  if (!campaign || !campaign.id) return { total: 0, source: 'none' };
  const wo = await linkedWorkOrderForCampaign(campaign, ['recruit_count']);
  return displayRecruitTotal(primary, wo && wo.recruit_count);
}

/** 차수 공고에서는 뒤 차수를 보존하고 1차만 조절해 합계를 목표 정원과 일치시킨다. */
function firstRoundQuota(rounds, target) {
  const sorted = (Array.isArray(rounds) ? rounds : []).slice().sort((a, b) => Number(a.round_no) - Number(b.round_no));
  if (!sorted.length) return null;
  const later = sorted.slice(1).reduce((sum, row) => sum + quota(row.slot_count), 0);
  const first = quota(target) - later;
  if (first <= 0) throw quotaError('추가 차수 물량보다 낮게 목표 인원을 설정할 수 없습니다.', 'recruit_quota_round_conflict');
  return { roundNo: sorted[0].round_no, slotCount: first };
}

/** 테스트 가능하도록 DB 밖의 옵션 배분 규칙을 분리한다.
 * 닫힌 옵션은 기존 정원을 보존하고, 남은 정원을 활성 옵션의 기존 비율대로 배분한다.
 * 기존 비율이 모두 0이면 활성 옵션에 균등 배분한다. */
function allocateOptionQuotas(options, target, usedByKey = new Map()) {
  const rows = Array.isArray(options) ? options.slice() : [];
  const fixed = rows.filter(r => r.status === 'closed');
  const active = rows.filter(r => r.status !== 'closed');
  const fixedTotal = fixed.reduce((sum, r) => sum + quota(r.recruit_total), 0);
  const activeUsed = active.reduce((sum, r) => sum + quota(usedByKey.get(r.opt_key)), 0);
  const available = quota(target) - fixedTotal;
  if (available < activeUsed) {
    throw quotaError('이미 참여 또는 진행 중인 옵션 인원보다 낮게 정원을 설정할 수 없습니다.', 'recruit_quota_below_used');
  }
  if (!active.length) {
    if (quota(target) !== fixedTotal) throw quotaError('조절 가능한 활성 옵션이 없어 총모집을 변경할 수 없습니다.', 'recruit_quota_no_active_option');
    return new Map();
  }
  const min = active.map(r => quota(usedByKey.get(r.opt_key)));
  const remain = available - activeUsed;
  const weights = active.map(r => quota(r.recruit_total));
  const weightTotal = weights.reduce((sum, v) => sum + v, 0);
  const raw = weights.map((weight, index) => weightTotal > 0 ? remain * weight / weightTotal : remain / active.length);
  const add = raw.map(v => Math.floor(v));
  let leftover = remain - add.reduce((sum, v) => sum + v, 0);
  raw.map((v, index) => ({ index, fraction: v - Math.floor(v) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    .forEach(({ index }) => { if (leftover > 0) { add[index] += 1; leftover -= 1; } });
  return new Map(active.map((r, index) => [r.opt_key, min[index] + add[index]]));
}

async function linkedWorkOrder(client, campaign) {
  const sourceId = String(campaign.source_work_order_id || '').trim();
  const { rows } = await client.query(
    `SELECT id, linked_campaign_id
       FROM work_orders
      WHERE deleted_at IS NULL
        AND ((linked_campaign_id = $1 AND $1 <> '') OR (id = $2 AND $2 <> ''))
      ORDER BY (linked_campaign_id = $1) DESC, updated_at DESC
      FOR UPDATE`,
    [campaign.id, sourceId]
  );
  const unique = [...new Map(rows.map(row => [row.id, row])).values()];
  if (unique.length > 1) {
    throw quotaError('연결된 작업오더가 둘 이상입니다. 연결을 정리한 뒤 다시 저장해주세요.', 'recruit_quota_link_conflict');
  }
  return unique[0] || null;
}

async function linkedCampaign(client, order) {
  const { rows } = await client.query(
    `SELECT id, source_work_order_id, linked_sheet_id, linked_tab_name
       FROM recruit_campaigns
      WHERE (id = $1 AND $1 <> '') OR source_work_order_id = $2
      ORDER BY (id = $1) DESC, updated_at DESC
      FOR UPDATE`,
    [String(order.linked_campaign_id || '').trim(), order.id]
  );
  const unique = [...new Map(rows.map(row => [row.id, row])).values()];
  if (unique.length > 1) {
    throw quotaError('연결된 모집공고가 둘 이상입니다. 연결을 정리한 뒤 다시 저장해주세요.', 'recruit_quota_link_conflict');
  }
  return unique[0] || null;
}

async function usedByOption(client, campaignId) {
  const { rows } = await client.query(
    `SELECT option_key, COUNT(*)::int AS used
       FROM campaign_applications
      WHERE campaign_id = $1 AND status IN ('applied', 'submitted') AND option_key IS NOT NULL
      GROUP BY option_key`,
    [campaignId]
  );
  return new Map(rows.map(row => [row.option_key, quota(row.used)]));
}

async function assertWorkOrderQuota({ workOrderId, recruitTotal }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, linked_campaign_id FROM work_orders WHERE id=$1 FOR UPDATE', [workOrderId]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const campaign = await linkedCampaign(client, rows[0]);
    if (!campaign) { await client.query('ROLLBACK'); return null; }
    const { rows: used } = await client.query(
      `SELECT COUNT(*)::int AS used FROM campaign_applications WHERE campaign_id=$1 AND status IN ('applied','submitted')`, [campaign.id]
    );
    if (quota(recruitTotal) < quota(used[0]?.used)) throw quotaError('이미 참여 또는 진행 중인 인원보다 낮게 정원을 설정할 수 없습니다.', 'recruit_quota_below_used');
    await assertWorktableSlotsInTx(client, campaign, quota(recruitTotal));
    const { rows: options } = await client.query(
      `SELECT opt_key, recruit_total, status, sort_order FROM campaign_options WHERE campaign_id=$1 ORDER BY sort_order, id FOR UPDATE`, [campaign.id]
    );
    // 활성/마감 옵션의 하한도 미리 검사한다. 검사는 통과했는데 실제 작업오더만
    // 저장되고 옵션 동기화가 실패하는 반쪽 저장을 막는다.
    allocateOptionQuotas(options, quota(recruitTotal), await usedByOption(client, campaign.id));
    await client.query('SAVEPOINT linked_recruit_assert_rounds');
    try {
      const { rows: rounds } = await client.query(
        'SELECT round_no, slot_count FROM campaign_rounds WHERE campaign_id=$1 ORDER BY round_no FOR UPDATE', [campaign.id]
      );
      firstRoundQuota(rounds, quota(recruitTotal));
      await client.query('RELEASE SAVEPOINT linked_recruit_assert_rounds');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT linked_recruit_assert_rounds');
      if (err.code !== '42P01') throw err;
    }
    await client.query('ROLLBACK');
    return { campaignId: campaign.id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

/** 공고 수정 화면도 UPDATE 전에 같은 작업보드 하한을 확인한다(반쪽 저장 방지). */
async function assertCampaignRecruitTotal({ campaignId, recruitTotal }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, source_work_order_id, linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [campaignId]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const campaign = rows[0];
    const { rows: used } = await client.query(
      `SELECT COUNT(*)::int AS used FROM campaign_applications WHERE campaign_id=$1 AND status IN ('applied','submitted')`, [campaign.id]
    );
    if (quota(recruitTotal) < quota(used[0]?.used)) throw quotaError('이미 참여 또는 진행 중인 인원보다 낮게 정원을 설정할 수 없습니다.', 'recruit_quota_below_used');
    await assertWorktableSlotsInTx(client, campaign, quota(recruitTotal));
    await client.query('ROLLBACK');
    return { campaignId: campaign.id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

/**
 * ★★ `skipWorktable` = "이번 저장에서 총정원이 한 명도 안 바뀌었다"는 호출자의 확언.
 *   그때는 작업보드 슬롯 맞추기를 건너뛴다 — 초과 상태(채워진 줄 > 정원)인 작업은
 *   목표가 그대로여도 delta.retire 가 잡혀 `worktableSlotDelta`/빈 슬롯 부족 두 겹에서
 *   throw 하고, 그 throw 가 공고 저장 맨 끝에 있어 **저장은 이미 커밋됐는데 화면엔 실패**로
 *   보였다(2026-08-24 실측 13개 작업). ★ 줄이려는 조작은 종전대로 막는다(호출자가 값이
 *   달라졌을 때만 이 플래그를 끄므로 게이트는 그대로 산다). ★ 역방향 링크 백필
 *   (`work_orders.linked_campaign_id`)은 **건너뛰지 않는다** — 그것까지 빠지면 연결이
 *   조용히 비는 별개 사고가 된다.
 */
async function syncCampaignRecruitTotal({ campaignId, recruitTotal, skipWorktable = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, source_work_order_id, linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [campaignId]);
    if (!rows.length) { await client.query('ROLLBACK'); return { linked: false }; }
    const order = await linkedWorkOrder(client, rows[0]);
    if (!order) { await client.query('ROLLBACK'); return { linked: false }; }
    const total = quota(recruitTotal);
    await client.query(
      `UPDATE work_orders SET linked_campaign_id=$2, recruit_count=$3, updated_at=NOW() WHERE id=$1`,
      [order.id, campaignId, total]
    );
    const worktable = skipWorktable
      ? { synced: false, reason: 'quota_unchanged' }
      : await syncWorktableSlotsInTx(client, rows[0], total, 'campaign-quota-sync');
    await client.query('COMMIT');
    return { linked: true, workOrderId: order.id, recruitTotal: total, worktable: await rebuildWorktableProjection(worktable, 'campaign-quota-sync') };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

async function syncWorkOrderRecruitTotal({ workOrderId, recruitTotal }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, linked_campaign_id FROM work_orders WHERE id=$1 FOR UPDATE', [workOrderId]);
    if (!rows.length) { await client.query('ROLLBACK'); return { linked: false }; }
    const campaign = await linkedCampaign(client, rows[0]);
    if (!campaign) { await client.query('ROLLBACK'); return { linked: false }; }
    const total = quota(recruitTotal);
    const { rows: used } = await client.query(
      `SELECT COUNT(*)::int AS used FROM campaign_applications WHERE campaign_id=$1 AND status IN ('applied','submitted')`, [campaign.id]
    );
    if (total < quota(used[0]?.used)) throw quotaError('이미 참여 또는 진행 중인 인원보다 낮게 정원을 설정할 수 없습니다.', 'recruit_quota_below_used');
    // 차수 원장이 있는 공고는 recruit_total만 쓰면 다음 공고 수정에서 차수 합계가 다시
    // 덮어쓴다. 1차를 목표-후속차수 합계로 갱신해 세 저장값을 같은 값으로 유지한다.
    let rounds = [];
    await client.query('SAVEPOINT linked_recruit_rounds');
    try {
      ({ rows: rounds } = await client.query(
        'SELECT round_no, slot_count FROM campaign_rounds WHERE campaign_id=$1 ORDER BY round_no FOR UPDATE', [campaign.id]
      ));
      await client.query('RELEASE SAVEPOINT linked_recruit_rounds');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT linked_recruit_rounds');
      if (err.code !== '42P01') throw err; // 아직 095 마이그레이션 전인 환경은 기존 동작 유지
    }
    const firstRound = firstRoundQuota(rounds, total);
    if (firstRound) {
      await client.query(
        'UPDATE campaign_rounds SET slot_count=$3 WHERE campaign_id=$1 AND round_no=$2',
        [campaign.id, firstRound.roundNo, firstRound.slotCount]
      );
    }
    const { rows: options } = await client.query(
      `SELECT opt_key, recruit_total, status, sort_order FROM campaign_options WHERE campaign_id=$1 ORDER BY sort_order, id FOR UPDATE`, [campaign.id]
    );
    const nextOptions = allocateOptionQuotas(options, total, await usedByOption(client, campaign.id));
    for (const [optKey, optionTotal] of nextOptions) {
      await client.query('UPDATE campaign_options SET recruit_total=$3, updated_at=NOW() WHERE campaign_id=$1 AND opt_key=$2', [campaign.id, optKey, optionTotal]);
    }
    const worktable = await syncWorktableSlotsInTx(client, campaign, total, 'workorder-quota-sync');
    await client.query('UPDATE recruit_campaigns SET recruit_total=$2, updated_at=NOW() WHERE id=$1', [campaign.id, total]);
    await client.query('COMMIT');
    return { linked: true, campaignId: campaign.id, recruitTotal: total, optionCount: nextOptions.size, worktable: await rebuildWorktableProjection(worktable, 'workorder-quota-sync') };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

module.exports = {
  quota,
  displayRecruitTotal,
  displayRecruitTotalForCampaign,
  linkedWorkOrderForCampaign,
  linkedWorkOrdersForCampaigns,
  worktableSlotDelta,
  firstRoundQuota,
  allocateOptionQuotas,
  assertWorkOrderQuota,
  assertCampaignRecruitTotal,
  syncCampaignRecruitTotal,
  syncWorkOrderRecruitTotal,
};
