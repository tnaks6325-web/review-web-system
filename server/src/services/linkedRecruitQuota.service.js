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
    `SELECT id, source_work_order_id
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

async function syncCampaignRecruitTotal({ campaignId, recruitTotal }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, source_work_order_id FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [campaignId]);
    if (!rows.length) { await client.query('ROLLBACK'); return { linked: false }; }
    const order = await linkedWorkOrder(client, rows[0]);
    if (!order) { await client.query('ROLLBACK'); return { linked: false }; }
    const total = quota(recruitTotal);
    await client.query(
      `UPDATE work_orders SET linked_campaign_id=$2, recruit_count=$3, updated_at=NOW() WHERE id=$1`,
      [order.id, campaignId, total]
    );
    await client.query('COMMIT');
    return { linked: true, workOrderId: order.id, recruitTotal: total };
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
    await client.query('UPDATE recruit_campaigns SET recruit_total=$2, updated_at=NOW() WHERE id=$1', [campaign.id, total]);
    await client.query('COMMIT');
    return { linked: true, campaignId: campaign.id, recruitTotal: total, optionCount: nextOptions.size };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

module.exports = {
  quota,
  firstRoundQuota,
  allocateOptionQuotas,
  assertWorkOrderQuota,
  syncCampaignRecruitTotal,
  syncWorkOrderRecruitTotal,
};
