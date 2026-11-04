/**
 * 선택지(상품)마다 유입방식 — 결정 333 (사용자 확정 2026-11-04 「가」).
 *
 * 한 작업에 상품이 둘 이상이고 상품마다 유입이 다르면(예: 21호 가이드유입 · 23호 링크유입) 종전엔 오더·공고를 둘로 쪼개야 했다.
 * ★ 오더 쪽 = `product_options_json[*].inflow_type`(상품 단위 · 옵션은 상품을 따른다) — 상품마다 다를 때만 실린다(인트라넷 규칙).
 *   공고 쪽 = `campaign_options.inflow_type`(줄 단위 · migration 213).
 * ★ 빈 값('' · NULL · 키 없음) = 공고 전체 값(`work_detail.inflowType` / `work_orders.inflow_type`)을 따른다 = 종전 동작 그대로.
 * ★ 'mixed' 같은 새 값은 만들지 않는다 — 공고 전체 값은 종전처럼 'guide' | 'link' 하나다(섞이면 인트라넷이 'guide' 를 보낸다).
 *   새 값을 쓰면 `=== 'guide' ? 'guide' : 'link'` 분기들이 섞인 공고를 링크유입으로 읽는다.
 */
'use strict';

/** 유입방식으로 인정하는 값 — 그 외(빈 값·오타)는 '' = 따름. */
function unitInflowType(v) {
  const s = String(v == null ? '' : v).trim();
  return (s === 'guide' || s === 'link') ? s : '';
}

/** 그 선택지가 실제로 쓰는 유입방식 — 줄 값이 있으면 그것, 없으면 공고 전체 값. 둘 다 없으면 ''(모름). */
function effectiveInflow(unitType, campaignType) {
  return unitInflowType(unitType) || unitInflowType(campaignType);
}

/** 이 줄에 유입가이드가 있나(글 또는 사진). 줄 모양은 DB 행(snake) · 화면 옵션(camel) 둘 다 받는다. */
function _hasGuide(row) {
  const html = row.inflow_guide_html !== undefined ? row.inflow_guide_html : row.inflowGuideHtml;
  const imgs = row.inflow_guide_images !== undefined ? row.inflow_guide_images : row.inflowGuideImages;
  return !!String(html || '').trim() || (Array.isArray(imgs) && imgs.length > 0);
}

/**
 * 가이드유입인데 유입가이드가 없는 줄의 이름들 — ★ 판정은 **그 줄이 실제로 쓰는 유입방식**으로 한다.
 * 링크유입 줄은 상품 주소가 곧 유입이라 가이드가 필요 없다(공고 전체가 가이드유입이어도).
 * ★ 마감·삭제 줄을 거르는 것은 호출부 몫(호출부마다 기존 거름 조건이 다르다 — 그대로 둔다).
 */
function guideMissingUnits(rows, campaignType) {
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r && effectiveInflow(r.inflow_type !== undefined ? r.inflow_type : r.inflowType, campaignType) === 'guide')
    .filter(r => !_hasGuide(r))
    .map(r => r.opt_key || r.optKey || r.product_name || r.productName || '이름 없는 선택지');
}

function _parse(json) {
  if (Array.isArray(json)) return json;
  if (typeof json !== 'string' || !json.trim()) return null;
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : null; } catch (_) { return null; }
}

/**
 * ★★ 상품별 유입방식을 모르는 옛 인트라넷 창(본문에 `bidir.inflow` 표시 없음)의 저장 — 저장된 상품별 값을 그대로 둔다.
 * 옛 창은 상품 객체를 화면 값으로 새로 만들어 보내 `inflow_type` 키가 빠진다. 그대로 받으면 "지웠다"로 읽혀
 * 링크 상품이 공고 전체 값(가이드)으로 바뀌고 [상품 페이지 열기]가 사라진다(가이드가 없으면 저장 자체가 막힌다).
 * → 보낸 상품에 키가 없고 저장본의 같은 상품(이름 · 원래 이름 prev_name)에 값이 있으면 그 값을 옮겨 붙인다.
 * ★ 옮길 것이 없으면 **받은 글자 그대로** 돌려준다(바이트 동일 — 잠금 비교·멱등 재전송 무영향).
 */
function keepUnitInflowTypes(currentJson, nextJson) {
  const cur = _parse(currentJson);
  const next = _parse(nextJson);
  if (!cur || !next) return nextJson;
  const saved = new Map();
  for (const p of cur) {
    const t = p && typeof p === 'object' ? unitInflowType(p.inflow_type) : '';
    if (t) saved.set(String(p.name || '').trim(), t);
  }
  if (!saved.size) return nextJson;
  let moved = 0;
  const out = next.map(p => {
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.prototype.hasOwnProperty.call(p, 'inflow_type')) return p;
    const t = saved.get(String(p.prev_name || '').trim()) || saved.get(String(p.name || '').trim());
    if (!t) return p;
    moved += 1;
    return { ...p, inflow_type: t };
  });
  return moved ? JSON.stringify(out) : nextJson;
}

/** 본문이 상품별 유입방식을 아는 인트라넷 창에서 왔나(`bidir.inflow` — 다른 능력 표시와 같은 모양). */
function inflowCapable(body) {
  const bid = body && body.bidir && typeof body.bidir === 'object' && !Array.isArray(body.bidir) ? body.bidir : null;
  return !!(bid && (bid.inflow === 1 || bid.inflow === true || bid.inflow === '1'));
}

module.exports = { unitInflowType, effectiveInflow, guideMissingUnits, keepUnitInflowTypes, inflowCapable };
