/**
 * sharedPatchPlan — 양방향 동기화의 **3방향 병합 판정** 단일 출처(결정 263 · 심판 최종안 2단계).
 *
 *   base   = 수정 화면을 연 시점의 공유 상태(스냅숏)
 *   mine   = 지금 보내온 값(인트라넷 저장 또는 리뷰웹 공고 저장)
 *   theirs = 지금 서버에 있는 값
 *
 * 칸(경로)마다 판정한다:
 *   ① mine 이 그 칸을 안 보냈거나 base 와 같다      → 건너뜀(이번 수정이 손대지 않은 칸)
 *   ② 주인이 인트라넷인데 인트라넷발이 아니다         → readOnly(리뷰웹에서는 못 고친다)
 *   ③ theirs 가 이미 mine 과 같다                    → same(쓸 것 없음)
 *   ④ theirs 가 base 그대로다(그 사이 아무도 안 고침) → write
 *   ⑤ 그 외(양쪽이 같은 칸을 다르게 고침)             → conflict — 사람이 고른다(forceMine 에 넣으면 write)
 *
 * ★★ 판정은 **글자가 아니라 `sharedFields.canon` 정규화 값**으로 한다 — 거짓 vs 0 같은 표기 차이로
 *    가짜 충돌이 나지 않게(2026-10-20 운영 대조 실측).
 * ★★ 이 모듈은 **판정만** 한다 — 쓰기·잠금·버전은 적용 단계(3단계 `sharedPatch.service`)의 몫이다.
 *    "충돌·보기전용이 하나라도 있으면 전체 거부(부분 반영 금지)" 도 적용 단계가 이 결과로 정한다.
 * ★ 상품·옵션은 통째가 아니라 **상품·옵션 단위 경로**로 펼친다(`p:<상품명>` · `p:<상품명>|o:<옵션>`)
 *   — 한쪽은 A 옵션 금액, 다른 쪽은 B 옵션 인원을 고쳤으면 충돌이 아니다.
 *   이름을 바꾼 상품·옵션은 보내는 쪽이 `prev_name`/`prev_label`(전송 전용, 저장 안 함)을 실어
 *   base 의 경로에 맞춘다 — 이름 변경 자체는 그 경로의 `.name`/`.label` 칸 변경으로 판정된다.
 */
'use strict';

const { SHARED_FIELDS, ownerOf, canon, CANON, stableJson } = require('./sharedFields');

/** 그 상태에 경로가 없다(상품·옵션이 없어졌거나 아직 없다). 빈 값('')과 다르다. */
const ABSENT = '∅';
const PRODUCT_SKIP = new Set(['options', 'prev_name']);
const OPTION_SKIP = new Set(['prev_label']);

function _parseProducts(raw) {
  if (raw == null) return null;
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try { v = JSON.parse(s); } catch (_) { return { legacyText: s }; }
  }
  return Array.isArray(v) ? v : { legacyText: stableJson(v) };
}

function _optionKey(op) {
  const lab = String(op && op.label || '').trim();
  if (lab) return lab;
  const v1 = String(op && op.option_1 && op.option_1.value || '').trim();
  const v2 = String(op && op.option_2 && op.option_2.value || '').trim();
  return v2 ? `${v1} / ${v2}` : v1;
}

function _leaf(v) {
  if (v == null || v === '') return '';
  return typeof v === 'object' ? CANON.json(v) : String(v).trim();
}

/**
 * 공유 상태 → { 경로: 정규화 값 }.
 * @param {object} state 작업오더 행 또는 인트라넷 payload 모양(칸 이름 = sharedFields key)
 * @param {{useRenames?: boolean}} [opts] mine 을 펼칠 때만 true — prev_name/prev_label 로 base 경로에 맞춘다
 * @returns {{ paths: Map<string,string>, renames: Array<{kind:string,from:string,to:string,product?:string}>, hasProducts: boolean }}
 */
function flattenState(state, { useRenames = false } = {}) {
  const s = state || {};
  const paths = new Map();
  const renames = [];
  for (const f of SHARED_FIELDS) {
    if (f.owner === 'derived') continue;
    if (!Object.prototype.hasOwnProperty.call(s, f.key)) continue;
    paths.set('f:' + f.key, canon(f.key, s[f.key]));
  }
  const products = Object.prototype.hasOwnProperty.call(s, 'product_options_json') ? _parseProducts(s.product_options_json) : null;
  if (products && !Array.isArray(products)) {
    paths.set('products:legacy', products.legacyText);
  } else if (products) {
    for (const p of products) {
      if (!p || typeof p !== 'object') continue;
      const name = String(p.name || '').trim();
      const prev = useRenames ? String(p.prev_name || '').trim() : '';
      const pk = prev || name;
      if (!pk) continue;
      if (prev && prev !== name) renames.push({ kind: 'product', from: prev, to: name });
      const pBase = 'p:' + pk;
      paths.set(pBase, '1');
      for (const [k, v] of Object.entries(p)) {
        if (PRODUCT_SKIP.has(k)) continue;
        paths.set(`${pBase}.${k}`, k === 'qty_tiers' ? CANON.json(v) : _leaf(v));
      }
      for (const op of (Array.isArray(p.options) ? p.options : [])) {
        const label = _optionKey(op);
        const prevLabel = useRenames ? String(op && op.prev_label || '').trim() : '';
        const ok = prevLabel || label;
        if (!ok) continue;
        if (prevLabel && prevLabel !== label) renames.push({ kind: 'option', product: name, from: prevLabel, to: label });
        const oBase = `${pBase}|o:${ok}`;
        paths.set(oBase, '1');
        for (const [k, v] of Object.entries(op || {})) {
          if (OPTION_SKIP.has(k)) continue;
          paths.set(`${oBase}.${k}`, _leaf(v));
        }
      }
    }
  }
  return { paths, renames, hasProducts: !!products };
}

/** 경로의 주인 — 칸이면 표의 주인, 상품·옵션은 공유. */
function pathOwner(path) {
  if (path.startsWith('f:')) return ownerOf(path.slice(2));
  return 'shared';
}

/**
 * @param {{ base: object, mine: object, theirs: object, origin: 'intranet'|'campaign'|'workboard'|'reconcile', forceMine?: string[] }} p
 * @returns {{ writes: object[], conflicts: object[], readOnly: object[], same: object[], renames: object[] }}
 */
function planSharedPatch({ base, mine, theirs, origin, forceMine = [] }) {
  if (!origin) throw new Error('origin 이 필요하다');
  const B = flattenState(base);
  const M = flattenState(mine, { useRenames: true });
  const T = flattenState(theirs);
  const force = new Set(forceMine);
  const intranetMayWrite = origin === 'intranet' || origin === 'reconcile';

  // 세 상태의 경로 전부를 본다. mine 이 안 보낸 칸은 ① 에서 건너뛴다.
  // ★ mine 이 상품 목록을 보냈으면 그 목록이 "전체" 다 — base 에 있는데 mine 에 없는 상품·옵션 = 지운 것(ABSENT).
  const all = new Set([...B.paths.keys(), ...M.paths.keys(), ...T.paths.keys()]);
  const get = (st, k, productLike) => (st.paths.has(k) ? st.paths.get(k) : (productLike && st.hasProducts ? ABSENT : undefined));

  const out = { writes: [], conflicts: [], readOnly: [], same: [], renames: M.renames };
  for (const path of [...all].sort()) {
    const productLike = !path.startsWith('f:');
    const m = get(M, path, productLike);
    if (m === undefined) continue;                     // ① 안 보낸 칸
    const b = get(B, path, productLike);
    if (m === b) continue;                             // ① 손대지 않은 칸
    const t = get(T, path, productLike);
    const row = { path, base: b, mine: m, theirs: t };
    if (pathOwner(path) === 'intranet' && !intranetMayWrite) { out.readOnly.push(row); continue; }   // ②
    if (t === m) { out.same.push(row); continue; }                                                   // ③
    if (t === b || force.has(path)) { out.writes.push(row); continue; }                              // ④
    out.conflicts.push(row);                                                                         // ⑤
  }
  return out;
}

module.exports = { flattenState, planSharedPatch, pathOwner, ABSENT };
