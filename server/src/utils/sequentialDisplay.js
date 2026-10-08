'use strict';
/**
 * 순차진행 공고의 리뷰어 표시(제목·사진) — 지금 모집 중인 선택지로 바꾼다 (결정 213 · 사용자 확정 2026-10-08).
 *
 * 규칙(권장안 가):
 *  ① 공고 제목 안에 **선택지 이름이 그대로 들어 있으면 그 부분만** 지금 모집 중인 선택지 이름으로 바꾼다.
 *     관리자가 앞에 붙인 표시(예: "빈)))")는 그대로 둔다.
 *  ② 제목에 선택지 이름이 없으면 제목은 그대로 두고 `nowRecruiting`(지금 모집: ○○) 한 줄을 따로 준다.
 *  ③ 사진 = 지금 모집 중인 선택지의 사진, 없으면 공고 대표 사진.
 *  ④ 여러 선택지가 같이 쓰는 이름(같은 상품의 옵션들이 공유하는 상품명)은 단서로 쓰지 않는다 — 어느 선택지인지 모른다.
 * 순수 함수 — DB 없이 테스트한다.
 */

function _clean(s) { return String(s == null ? '' : s).trim(); }

/** 선택지 하나의 이름 후보(종류별). */
function _namesOf(v) {
  const out = [];
  const p = _clean(v && v.productName);
  const k = _clean(v && v.optKey);
  if (p) out.push({ kind: 'productName', n: p });
  if (k && k !== p) out.push({ kind: 'optKey', n: k });
  return out;
}

/** 표시용 이름 — 옵션 단위면 옵션명, 상품 단위면 상품명. */
function displayName(v) {
  if (!v) return '';
  return v.unitKind === 'option' ? (_clean(v.optKey) || _clean(v.productName)) : (_clean(v.productName) || _clean(v.optKey));
}

/**
 * 제목 안의 선택지 이름을 target 의 같은 종류 이름으로 바꾼다.
 * @returns {{ title:string, found:boolean }} found = 제목에서 어떤 선택지의 이름을 찾았는가
 */
function swapTitle(title, views, target) {
  const t = _clean(title);
  if (!t || !target) return { title: t, found: false };
  const list = Array.isArray(views) ? views : [];
  // 이름 → 그 이름을 쓰는 선택지 수(공유 이름은 단서가 아니다)
  const owners = new Map();
  for (const v of list) for (const { n } of _namesOf(v)) {
    if (!owners.has(n)) owners.set(n, new Set());
    owners.get(n).add(v);
  }
  const cands = [];
  for (const v of list) for (const c of _namesOf(v)) {
    if (owners.get(c.n).size === 1) cands.push({ ...c, v });
  }
  cands.sort((a, b) => b.n.length - a.n.length);   // 긴 이름 먼저("1. 은갈치 단품" 이 "은갈치" 보다 먼저)
  const hit = cands.find(c => t.includes(c.n));
  if (!hit) return { title: t, found: false };
  if (hit.v === target) return { title: t, found: true };
  const next = _clean(target[hit.kind]) || displayName(target);
  if (!next) return { title: t, found: false };
  return { title: t.replace(hit.n, next), found: true };
}

/**
 * 순차진행 공고의 참여 전 표시.
 * @param base  { title, thumbnailUrl } 공고에 저장된 값
 * @param views computeOptionViews 결과(sequential/sequenceCurrent/thumbnailUrl 포함)
 * @returns null(순차진행 아님 · 지금 모집 중 선택지 없음 = 종전 그대로) | { title, thumbnailUrl, nowRecruiting }
 */
function sequentialDisplay(base, views) {
  const list = Array.isArray(views) ? views : [];
  const cur = list.find(v => v && v.sequential && v.sequenceCurrent);
  if (!cur) return null;
  const b = base || {};
  const r = swapTitle(b.title, list, cur);
  return {
    title: r.title || _clean(b.title),
    thumbnailUrl: _clean(cur.thumbnailUrl) || _clean(b.thumbnailUrl),
    nowRecruiting: r.found ? '' : displayName(cur),
  };
}

/**
 * 참여한 사람의 표시(내 참여 내역) — 내가 고른 선택지로 고정한다(나중에 다른 상품이 모집 중이어도 바뀌지 않게).
 * @param joined 내가 고른 선택지(views 중 하나 또는 {optKey, productName, unitKind, thumbnailUrl})
 */
function joinedDisplay(base, views, joined) {
  const b = base || {};
  if (!joined) return { title: _clean(b.title), thumbnailUrl: _clean(b.thumbnailUrl) };
  const list = Array.isArray(views) && views.length ? views : [joined];
  const target = list.find(v => v && v.optKey === joined.optKey) || joined;
  const r = swapTitle(b.title, list, target);
  return { title: r.title || _clean(b.title), thumbnailUrl: _clean(target.thumbnailUrl) || _clean(b.thumbnailUrl) };
}

module.exports = { sequentialDisplay, joinedDisplay, swapTitle, displayName };
