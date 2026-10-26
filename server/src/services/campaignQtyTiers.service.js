'use strict';

/**
 * ★★ 인당 구매수량 단계 — 모집공고 쪽 (구매수량 ③-가, 결정 289 · 2026-10-15)
 *
 * 작업오더 상품 구성의 `qty_tiers`(결정 250)를 공고 발행 때 `campaign_qty_tiers` 로 복사하고,
 * 리뷰어 참여·옵션 바꾸기에서 「고른 개수 단계에 자리가 남았나」를 판정한다.
 *
 * 범위(scope) — 리뷰어가 고른 선택지에 어느 단계 표가 걸리나:
 *   ① 그 옵션 전용 단계(opt_key = 고른 옵션)       → 범위 키 `opt:<opt_key>`
 *   ② 그 상품의 공통 단계(opt_key NULL, 상품명 같음) → 범위 키 `prod:<상품명>` (상품 안 모든 옵션이 함께 센다)
 *   ③ 옵션 없는 공고 — 공통 단계가 한 상품 것뿐이면 그것
 *   어디에도 없으면 null = 단계 없음(종전 동작, purchase_qty NULL).
 *
 * ★ 마감은 **사람 수**로 센다(옵션·공고 정원과 같은 축). 판매 개수는 qty × 사람 수(표시용).
 * ★ 셈 = 단계를 고른 참여 기록(유효 홀드 + 제출 완료). 공고 밖 주문(바로 구매·수동 입력)은 단계를 모른다 →
 *   여기서 세지 않는다(옵션·공고의 사람 수 정원에는 종전대로 들어간다). 금액으로 단계를 추정하는 셈은 ④단계.
 * ★ 스위치 CAMPAIGN_QTY_TIERS=0 → 복사·판정 모두 끔(종전 동작으로 즉시 복귀). 기본 켬 —
 *   단계 표가 비어 있는 공고(지금 전부)는 조회 1번 외에 아무 변화가 없다.
 * ★ 블로그 체험단은 대상이 아니다(승인 대기는 자리를 잡지 않아 단계 셈과 맞지 않는다) — 호출부가 거른다.
 */

const enabled = () => String(process.env.CAMPAIGN_QTY_TIERS || '1') !== '0';
const clean = s => String(s == null ? '' : s).replace(/\|/g, '').trim();
const int = v => Math.max(0, Math.floor(Number(v) || 0));

class QtyTierError extends Error {
  constructor(message, code = 'qty_tier_option_mismatch') {
    super(message);
    this.name = 'QtyTierError';
    this.code = code;
  }
}

/**
 * 발행 때 복사할 줄을 만든다(순수 함수 — DB 없음).
 * @param productOptionsJson 작업오더 상품 구성(정규화된 원본)
 * @param options 공고 옵션 입력(_normalizeOptionsInput 결과: [{optKey, productName}]) — 없거나 빈 배열 = 옵션 없는 공고
 * @returns 줄 배열. 짝지을 수 없으면 QtyTierError(조용히 떨어뜨리면 단계가 리뷰어에게 안 보여 모두 1개씩 산다).
 */
function planTierCopy(productOptionsJson, options) {
  let list;
  try { list = typeof productOptionsJson === 'string' ? JSON.parse(productOptionsJson || '[]') : productOptionsJson; } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  const opts = Array.isArray(options) ? options : [];
  const rows = [];
  for (const product of list) {
    const tiers = product && product.qty_tiers;
    if (!tiers || !Array.isArray(tiers.rows) || !tiers.rows.length) continue;
    const pname = clean(product.name);
    const buy = tiers.buy_method === 'option' ? 'option' : 'qty';
    if (tiers.mode === 'by_option') {
      for (const r of tiers.rows) {
        const label = clean(r.option);
        // 발행 프리필은 다른 상품과 옵션명이 겹치면 상품명을 앞에 붙인다(work-order-detail _woOptionRows) — 둘 다 받는다.
        const hits = opts.filter(o => o && clean(o.productName) === pname
          && (o.optKey === label || o.optKey === clean(`${pname} ${label}`)));
        if (hits.length !== 1) {
          throw new QtyTierError(`「${pname} · ${label}」의 구매수량 단계를 공고 옵션과 짝지을 수 없습니다. 오더의 옵션 이름을 바꾸지 말고 발행해 주세요.`);
        }
        rows.push({ product_name: pname, opt_key: hits[0].optKey, qty: int(r.qty), people: int(r.people), pay_amount: int(r.amount), buy_method: buy });
      }
    } else {
      // 공통 단계는 상품명으로 범위를 잡는다 — 옵션 있는 공고인데 그 상품이 없으면 단계가 어디에도 안 걸린다.
      if (opts.length && !opts.some(o => o && (clean(o.productName) === pname || o.optKey === pname))) {
        throw new QtyTierError(`「${pname}」 상품을 공고 옵션에서 찾지 못해 구매수량 단계를 걸 수 없습니다.`);
      }
      for (const r of tiers.rows) {
        rows.push({ product_name: pname, opt_key: null, qty: int(r.qty), people: int(r.people), pay_amount: int(r.amount), buy_method: buy });
      }
    }
  }
  return rows.map((r, i) => ({ ...r, sort_order: i }));
}

async function insertTiers(client, campaignId, rows) {
  for (const r of rows) {
    await client.query(
      `INSERT INTO campaign_qty_tiers (campaign_id, product_name, opt_key, qty, people, pay_amount, buy_method, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [campaignId, r.product_name, r.opt_key, r.qty, r.people, r.pay_amount, r.buy_method, r.sort_order]);
  }
}

/** 공고의 단계 표 + 옵션별 상품명(범위 판정 재료). 단계가 없으면 tiers=[] — 호출부는 거기서 끝낸다. */
async function loadContext(db, campaignId) {
  const { rows: tiers } = await db.query(
    `SELECT product_name, opt_key, qty, people, pay_amount, buy_method, sort_order
       FROM campaign_qty_tiers WHERE campaign_id = $1 ORDER BY sort_order, id`, [campaignId]);
  if (!tiers.length) return { tiers: [], optProduct: new Map() };
  const { rows: opts } = await db.query(
    `SELECT opt_key, product_name FROM campaign_options WHERE campaign_id = $1`, [campaignId]);
  return { tiers, optProduct: new Map(opts.map(o => [o.opt_key, clean(o.product_name)])) };
}

/** 단계는 있는데 범위를 못 정한 상태인가(scopeFor 가 null 일 때만 의미) — 고른 옵션 줄이 공고에 없거나, 옵션 없이 왔는데 단계가 한 상품 공통이 아니다. */
function unresolved(ctx, optKey) {
  if (!ctx || !ctx.tiers || !ctx.tiers.length) return false;
  return optKey ? !ctx.optProduct.has(optKey) : true;
}

/** 고른 옵션(없으면 null)에 걸리는 단계 범위 → { key, tiers } | null */
function scopeFor(ctx, optKey) {
  if (!ctx || !ctx.tiers || !ctx.tiers.length) return null;
  if (optKey) {
    const own = ctx.tiers.filter(t => t.opt_key === optKey);
    if (own.length) return { key: `opt:${optKey}`, tiers: own };
    const product = ctx.optProduct.get(optKey) || '';
    // ★ 코드리뷰 P1: 상품을 알면 그 상품의 공통 단계만 — 옵션 이름이 다른 상품 이름과 같아도 섞지 않는다(섞이면 남의 금액·자리로 잡힌다).
    //   옵션 이름 = 상품 이름 짝은 상품을 모를 때만(옵션 없는 상품 줄 · 옛 자료).
    const common = ctx.tiers.filter(t => t.opt_key == null && (product ? t.product_name === product : t.product_name === optKey));
    if (common.length) return { key: `prod:${common[0].product_name}`, tiers: common };
    return null;
  }
  const common = ctx.tiers.filter(t => t.opt_key == null);
  const names = new Set(common.map(t => t.product_name));
  return names.size === 1 ? { key: `prod:${common[0].product_name}`, tiers: common } : null;
}

/** 범위별 단계 사용 수(사람 수) → Map(`범위키|qty` → n). excludeAppId = 옵션 바꾸기에서 내 기록은 빼고 본다. */
async function fetchUsage(db, campaignId, ctx, { excludeAppId = null } = {}) {
  const { rows } = await db.query(
    `SELECT option_key, purchase_qty, COUNT(*)::int AS n
       FROM campaign_applications
      WHERE campaign_id = $1 AND purchase_qty IS NOT NULL
        AND ((status = 'applied' AND expires_at > NOW()) OR status = 'submitted')
        AND ($2::int IS NULL OR id <> $2::int)
      GROUP BY option_key, purchase_qty`, [campaignId, excludeAppId]);
  const usage = new Map();
  for (const r of rows) {
    const scope = scopeFor(ctx, r.option_key || null);
    if (!scope) continue;
    const k = `${scope.key}|${int(r.purchase_qty)}`;
    usage.set(k, (usage.get(k) || 0) + int(r.n));
  }
  return usage;
}

/** 범위의 단계 보기 — [{qty, people, used, remaining, status:'open'|'soldout', payAmount, buyMethod}] (개수 많은 순) */
function tierViews(scope, usage) {
  if (!scope) return [];
  return scope.tiers
    .map(t => {
      const used = usage.get(`${scope.key}|${int(t.qty)}`) || 0;
      const remaining = Math.max(0, int(t.people) - used);
      return { qty: int(t.qty), people: int(t.people), used, remaining, status: remaining > 0 ? 'open' : 'soldout',
        payAmount: int(t.pay_amount), buyMethod: t.buy_method === 'option' ? 'option' : 'qty' };
    })
    .sort((a, b) => b.qty - a.qty);
}

/**
 * 참여·옵션 바꾸기 공용 판정 — 캠페인 행 FOR UPDATE 안에서 부른다(같은 잠금이 단계 셈도 직렬화한다).
 * @returns {null} 단계 없음 | {ok:true, qty, amount, buyMethod, views} | {ok:false, status, reason, error, views}
 */
async function judge(db, campaignId, optKey, wantQty, { excludeAppId = null } = {}) {
  if (!enabled()) return null;
  const ctx = await loadContext(db, campaignId);
  const scope = scopeFor(ctx, optKey);
  if (!scope) {
    /* ★ 코드리뷰 P2: 단계가 있는 공고인데 어느 단계인지 정할 수 없으면 통과(null)로 접지 않는다(fail-closed) —
       공고 발행 직후 옵션이 아직 저장되지 않은 찰나·옵션 저장 실패·고른 옵션 줄이 없는 상태에서 개수 선택 없이 참여되던 빈틈.
       옵션 줄이 있고 그 옵션에 단계가 없는 것(단계 없는 상품)만 종전대로 통과. */
    if (unresolved(ctx, optKey)) {
      return { ok: false, status: 409, reason: 'tier_unavailable', views: [],
        error: '이 공고는 지금 참여를 받을 수 없어요(구매수량 준비 중). 잠시 후 다시 시도해주세요.' };
    }
    return null;
  }
  const views = tierViews(scope, await fetchUsage(db, campaignId, ctx, { excludeAppId }));
  const want = int(wantQty);
  if (!want) {
    return { ok: false, status: 400, reason: 'tier_required', error: '몇 개 구매할지 선택해주세요.', views };
  }
  const v = views.find(x => x.qty === want);
  if (!v) {
    return { ok: false, status: 400, reason: 'tier_invalid', error: '선택한 구매수량을 찾을 수 없어요. 새로고침 후 다시 선택해주세요.', views };
  }
  if (v.status !== 'open') {
    const anyOpen = views.some(x => x.status === 'open');
    return { ok: false, status: 409, reason: anyOpen ? 'tier_soldout' : 'option_soldout', views,
      error: anyOpen ? `${want}개 구매는 마감되었어요. 다른 구매수량을 선택해주세요.` : '선택한 상품은 마감되었어요. 다른 상품을 선택해주세요.' };
  }
  return { ok: true, qty: v.qty, amount: v.payAmount, buyMethod: v.buyMethod, views };
}

/**
 * ③-나 화면용 — 옵션별(byOpt) · 옵션 없는 공고(campaign)의 단계 보기. 단계 없는 공고 = null(종전 화면).
 * excludeAppId = 참여 후 「개수 바꾸기」에서 내 참여는 빼고 본다(바꾸기 판정과 같은 셈).
 * ★ 보기 전용 — 참여·바꾸기의 판정은 언제나 judge(같은 잠금 안)가 다시 한다.
 */
async function viewsForCampaign(db, campaignId, optKeys, { excludeAppId = null } = {}) {
  if (!enabled()) return null;
  const ctx = await loadContext(db, campaignId);
  if (!ctx.tiers.length) return null;
  const usage = await fetchUsage(db, campaignId, ctx, { excludeAppId });
  const byOpt = {};
  for (const k of optKeys || []) {
    const s = k ? scopeFor(ctx, k) : null;
    if (s) byOpt[k] = tierViews(s, usage);
  }
  const none = scopeFor(ctx, null);
  return { byOpt, campaign: none ? tierViews(none, usage) : null };
}

module.exports = {
  enabled, planTierCopy, insertTiers, loadContext, scopeFor, unresolved, fetchUsage, tierViews, judge, viewsForCampaign, QtyTierError,
};
