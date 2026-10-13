'use strict';

/**
 * ★★ 결정 239 — "이미 쓴 자리" 하한(정원 줄이기·회차 빼기·오늘 계획 줄이기·상품 삭제·공고 삭제·블로그 승인 자리 확인)의 단일 출처.
 *
 * 종전 하한들은 공고 참여(campaign_applications)만 셌다 → 바로 구매(공고 참여 없이 구매양식 링크·수동제출로 낸 주문)가
 * 많은 공고는 실제로 산 사람보다 정원을 낮게 줄이거나, 바로 구매만 있는 상품·공고를 지울 수 있었다
 * (사용자 확정 2026-10-13 "실제 숫자가 중요 — 나중에 실제가 더 커서 생기는 문제는 수습이 어렵다").
 *
 * 셈은 정원 엔진과 같다(새 셈법을 만들지 않는다):
 *   - 공고 단위 = fetchCampaignCounts.linked — 공고 시작일 이후 · 구매 키 중복 제거 · 공유 작업표는 귀속 안 함.
 *     max(제출 확정, 연결 주문) + 유효 홀드 (공고 경유 주문은 연결 주문에도 있으므로 더하지 않고 max).
 *   - 상품 단위 = fetchOptionCounts.externalOrders — matchOrderOption 으로 한 상품에 확정된 바로 구매만.
 * known=false = 연결 작업표가 있는데 주문 조회가 실패함 → 호출부는 줄이기·삭제를 막는다(fail-closed, 되돌리기 어려운 쪽).
 */

/* 잠금 트랜잭션(client) 안에서 부를 때 조회 하나의 실패가 트랜잭션 전체를 죽이지 않게(25P02) SAVEPOINT 로 격리한다.
   실패는 그대로 던진다 — 접는 방향(fail-open/closed)은 호출부가 정한다. */
async function _isolated(db, name, fn) {
  const inClient = typeof db.release === 'function';
  let sp = false;
  if (inClient) { try { await db.query(`SAVEPOINT ${name}`); sp = true; } catch (_) { /* tx 밖 클라이언트 */ } }
  try {
    const out = await fn();
    if (sp) await db.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    return out;
  } catch (e) {
    if (sp) await db.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    throw e;
  }
}

function _n(v) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/**
 * 확정 수(홀드 제외)에 바로 구매를 넣은 값 — 정원 엔진 counts 하나로 계산하는 순수 함수(결정 240 화면 숫자 · 결정 239 하한 공용).
 *   total = max(제출 확정, 연결 주문) · today = max(오늘 확정, 오늘 연결 주문)(구매양식 제출 시각 KST).
 *   attributable=false(공유 작업표·연결 없음·조회 실패·원장 셈 꺼짐) 면 공고 참여만 — 화면은 그 사실을 말한다.
 */
function confirmedWithDirect(counts) {
  const cnt = counts || {};
  const L = cnt.linked;
  const linkedOk = !!(L && L.ok && !L.noTab);
  const attributable = linkedOk && !L.sharedTab;
  const submitted = _n(cnt.submittedAll);
  const todaySubmitted = _n(cnt.todaySubmitted);
  const orders = attributable ? _n(L.orders) : null;
  const ordersToday = attributable ? _n(L.ordersToday) : 0;
  return {
    total: Math.max(submitted, orders || 0),
    today: Math.max(todaySubmitted, ordersToday),
    applications: submitted,
    todayApplications: todaySubmitted,
    orders,
    attributable,
    sharedTab: !!(linkedOk && L.sharedTab),
    linkedOk,
  };
}

/**
 * @returns {Promise<{total:number, today:number, applications:number, todayApplications:number,
 *   orders:number|null, sharedTab:boolean, known:boolean}>}
 */
async function campaignUsedFloor(db, campaignId, now = new Date()) {
  return _isolated(db, 'qf_campaign', () => _campaignUsedFloor(db, campaignId, now));
}

async function _campaignUsedFloor(db, campaignId, now) {
  const st = require('./campaignState.service');
  const { rows } = await db.query(
    'SELECT id, participation_mode, linked_sheet_id, linked_tab_name, recruit_total FROM recruit_campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) {
    return { total: 0, today: 0, applications: 0, todayApplications: 0, orders: null, sharedTab: false, known: true };
  }
  const counts = (await st.fetchCampaignCounts(db, [campaignId], now)).get(campaignId) || {};
  const c = confirmedWithDirect(counts);
  const holds = _n(counts.activeHolds);
  const todayHolds = _n(counts.todayActiveHolds);
  // ★ known 은 "주문 기록을 실제로 받았나"로 정한다(Codex PR #1625) — 게이트 모드(observe 등)가 known 을 true 로 꾸미지 않게.
  //   연결 작업표가 없거나 참여형이 아닌(레거시) 공고는 셀 주문이 없다 = known.
  //   운영 킬스위치 CAMPAIGN_TABLE_QUOTA=off 는 주문 원장 셈 자체를 끈 상태 — 하한도 공고 참여만(줄이기를 영구히 막지 않는다).
  const expectsLinked = rows[0].participation_mode === true && !!(rows[0].linked_sheet_id && rows[0].linked_tab_name);
  const known = !expectsLinked || st.TABLE_QUOTA_MODE === 'off' || c.linkedOk;
  return {
    total: c.total + holds,
    today: c.today + todayHolds,
    applications: c.applications + holds,
    todayApplications: c.todayApplications + todayHolds,
    orders: c.orders,
    sharedTab: c.sharedTab,
    known,
  };
}

/** 상품별 바로 구매 수(Map optKey → n) — 정원 엔진의 상품 귀속(externalOrders) 그대로. 조회 실패는 빈 Map(종전 하한). */
async function optionDirectOrders(db, campaignId, now = new Date()) {
  return _isolated(db, 'qf_option', () => _optionDirectOrders(db, campaignId, now));
}

async function _optionDirectOrders(db, campaignId, now) {
  const out = new Map();
  for (const [key, v] of await _optionDirectOrderStats(db, campaignId, now)) if (v.n > 0) out.set(key, v.n);
  return out;
}

/** 상품별 바로 구매 {n, today}(Map optKey → …) — 관리자 상품별 현황표용. 하한과 같은 셈(공고 참여 주문의 수동 중복 제외). */
async function optionDirectOrderStats(db, campaignId, now = new Date()) {
  return _isolated(db, 'qf_option_stats', () => _optionDirectOrderStats(db, campaignId, now));
}

async function _optionDirectOrderStats(db, campaignId, now) {
  const st = require('./campaignState.service');
  const out = new Map();
  // 공고 참여 주문과 같은 구매를 수동으로 또 넣은 줄은 빼고 센다 — 공고 참여 수에 이미 들어 있다(Codex PR #1625).
  const counts = await st.fetchOptionCounts(db, campaignId, now, { excludeApplicationDuplicates: true });
  for (const [key, c] of counts) {
    const n = _n(c && c.externalOrders);
    if (n > 0) out.set(key, { n, today: _n(c && c.todayExternalOrders) });
  }
  return out;
}

module.exports = { confirmedWithDirect, campaignUsedFloor, optionDirectOrders, optionDirectOrderStats };
