/**
 * qnaCalendar.js — Q&A체험단(결정 321) **날짜별 자리표** 생성 — 순수 함수(DB 없음).
 *
 * 한 자리 = 「이 날 · 이 상품(선택지) · 공개/비공개 · (공개면) 이 문구 그대로」.
 *
 * ★★ 상품(선택지)마다 **시작일부터 동시에** 진행한다 — 하루 `daily` 건씩, 총 `total` 건.
 *   순차진행(212·228)은 하루에 상품 하나뿐이라 쓰지 않는다(그 규율을 풀지 않는다).
 * ★★ 공개글은 **하루 1건까지**, 그 날의 첫 자리. 간격 `publicGapDays`(1=매일, 2=하루 건너)로
 *   0, g, 2g … 번째 진행일에 둔다. 진행일이 모자라면 남은 공개글은 공개가 없는 가장 이른 날로
 *   당기고(`qna_public_compressed` 경고), 그래도 모자라면 남은 자리 앞에서부터 채운다.
 * ★ 공개 문구는 **입력 순서대로** 붙는다. 문구가 공개 건수보다 적거나 빈 문구가 있으면 잠근다 —
 *   "이 문구 그대로"라고 안내할 글이 없는 자리를 만들지 않는다.
 * ★ 결과 순서 = (날짜, 상품 순서, 상품 안 순번) — 같은 입력이면 언제나 같은 seq(재접수·복구가 같은 표).
 *
 * 날짜(진행일 목록)는 호출부가 준다 — 주말·공휴일·휴무일 규칙은 `worktablePlan.businessDays`
 * 단일 출처(리뷰 작업의 구매일자와 같은 날을 건너뛴다).
 */
'use strict';

const { selectionKey } = require('../services/productOptions.service');

const MAX_PUBLIC_GAP = 30;

function _int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

/** 선택지 하나의 Q&A 설정(공개 건수·문구·간격). 키는 snake/camel 둘 다 받는다. 없으면 전부 비공개. */
function _qnaSpec(src) {
  const q = (src && typeof src === 'object' && (src.qna || src.qna_spec)) || {};
  const texts = Array.isArray(q.public_texts) ? q.public_texts : (Array.isArray(q.publicTexts) ? q.publicTexts : []);
  const gap = _int(q.public_gap_days != null ? q.public_gap_days : q.publicGapDays) || 1;
  return {
    publicCount: Math.max(0, _int(q.public_count != null ? q.public_count : q.publicCount)),
    publicTexts: texts.map(t => String(t == null ? '' : t).trim()),
    publicGapDays: Math.min(Math.max(1, gap), MAX_PUBLIC_GAP),
  };
}

/**
 * 작업오더(v2 `product_options_json`) → 자리를 만들 단위 목록.
 * 단위 키 = 작업표 v2 행 선택 키(`selectionKey`)와 같은 규칙 — 행의 상품·옵션 칸과 같은 값을 가리킨다.
 * @returns {{ units: Array, blockers: Array<{code,message}> }}
 */
function qnaUnitsFromWorkOrder(wo) {
  const blockers = [];
  const units = [];
  let arr;
  try { arr = JSON.parse((wo && wo.product_options_json) || '[]'); } catch (_) { arr = null; }
  if (!Array.isArray(arr) || !arr.length) {
    return { units, blockers: [{ code: 'qna_no_products', message: 'Q&A 작업의 상품 목록을 읽을 수 없습니다.' }] };
  }
  const fallbackDaily = _int(wo && wo.daily_count);
  const seen = new Set();
  const push = (productName, option1Value, option2Value, src) => {
    const key = selectionKey(productName, option1Value, option2Value);
    if (seen.has(key)) { blockers.push({ code: 'qna_duplicate_unit', message: `같은 상품·옵션이 두 번 있습니다: ${key}` }); return; }
    seen.add(key);
    const daily = _int(src && src.daily) || fallbackDaily;
    units.push({
      unitKey: key, unitIdx: units.length, productName,
      option1Value: option1Value || '', option2Value: option2Value || '',
      total: Math.max(0, _int(src && src.count)), daily: Math.max(0, daily),
      ..._qnaSpec(src),
    });
  };
  for (const product of arr) {
    const name = String((product && product.name) || '').trim();
    const mode = String((product && product.product_mode) || '').trim();
    if (!name) { blockers.push({ code: 'qna_product_name', message: '이름이 없는 상품이 있습니다.' }); continue; }
    if (mode === 'opt') {
      const opts = Array.isArray(product.options) ? product.options : [];
      for (const op of opts) {
        if (op && op.closed) continue;
        push(name, String((op && op.option_1 && op.option_1.value) || '').trim(),
          String((op && op.option_2 && op.option_2.value) || '').trim(), op);
      }
    } else {
      if (product.closed) continue;
      // 옵션 없는 상품의 Q&A 설정은 base 에 둔다(상품 칸과 같은 자리). 상품 자체에 둔 값도 받는다.
      const base = Object.assign({}, product.base || {});
      if (!base.qna && product.qna) base.qna = product.qna;
      push(name, '', '', base);
    }
  }
  return { units, blockers };
}

/** 이 단위가 며칠 진행되나 — ⌈total ÷ daily⌉. */
function unitDays(u) { return u.total > 0 && u.daily > 0 ? Math.ceil(u.total / u.daily) : 0; }

/** 단위 하나의 날짜별 자리 — [{dayIdx, n}] + 공개 자리 위치. */
function _layUnit(u, warnings) {
  const nDays = unitDays(u);
  const perDay = [];
  let left = u.total;
  for (let d = 0; d < nDays; d++) { const take = Math.min(u.daily, left); perDay.push(take); left -= take; }

  // 공개 자리 = 그 날의 첫 자리. 간격대로 두고, 모자라면 당긴다.
  const publicDays = [];
  const used = new Set();
  for (let d = 0; d < nDays && publicDays.length < u.publicCount; d += u.publicGapDays) { publicDays.push(d); used.add(d); }
  if (publicDays.length < u.publicCount) {
    for (let d = 0; d < nDays && publicDays.length < u.publicCount; d++) {
      if (!used.has(d)) { publicDays.push(d); used.add(d); }
    }
    warnings.push({ code: 'qna_public_compressed', message: `「${u.unitKey}」 공개글 ${u.publicCount}건을 ${u.publicGapDays}일 간격으로 다 넣을 날이 없어 앞당겼습니다.` });
  }
  publicDays.sort((a, b) => a - b);
  const slots = [];   // {dayIdx, visibility}
  const publicSet = new Set(publicDays);
  for (let d = 0; d < nDays; d++) {
    for (let k = 0; k < perDay[d]; k++) slots.push({ dayIdx: d, visibility: (k === 0 && publicSet.has(d)) ? 'public' : 'private' });
  }
  // 하루 1건 규칙으로도 다 못 넣은 공개글(공개 건수 > 진행일 수) — 남은 비공개 자리 앞에서부터.
  let missing = u.publicCount - slots.filter(s => s.visibility === 'public').length;
  if (missing > 0) {
    for (const s of slots) { if (missing <= 0) break; if (s.visibility === 'private') { s.visibility = 'public'; missing--; } }
    warnings.push({ code: 'qna_public_same_day', message: `「${u.unitKey}」 공개글이 진행일 수보다 많아 같은 날 공개글이 2건 이상인 날이 있습니다.` });
  }
  return slots;
}

/**
 * 자리표 생성.
 * @param {object} p
 * @param {Array}  p.units       qnaUnitsFromWorkOrder().units
 * @param {Array<{date:string,label:string,dow?:string}>} p.days  진행일 목록(0번째 = 시작일). 가장 긴 단위만큼 필요.
 * @param {number} [p.startSeq=1] 첫 행 seq
 * @returns {{ slots: Array, total: number, blockers: Array, warnings: Array }}
 */
function buildQnaCalendar({ units = [], days = [], startSeq = 1 } = {}) {
  const blockers = [];
  const warnings = [];
  if (!units.length) blockers.push({ code: 'qna_no_units', message: 'Q&A 자리를 만들 상품이 없습니다.' });
  for (const u of units) {
    if (!u.total) blockers.push({ code: 'qna_total_zero', message: `「${u.unitKey}」 총 건수가 0입니다.` });
    else if (!u.daily) blockers.push({ code: 'qna_daily_zero', message: `「${u.unitKey}」 하루 건수가 0입니다.` });
    if (u.publicCount > u.total) blockers.push({ code: 'qna_public_exceeds_total', message: `「${u.unitKey}」 공개 ${u.publicCount}건이 총 ${u.total}건보다 많습니다.` });
    const texts = u.publicTexts.slice(0, u.publicCount);
    if (texts.length < u.publicCount || texts.some(t => !t)) {
      blockers.push({ code: 'qna_public_text_missing', message: `「${u.unitKey}」 공개 ${u.publicCount}건에 넣을 문구가 ${texts.filter(Boolean).length}개뿐입니다.` });
    }
    if (u.publicTexts.length > u.publicCount && u.publicTexts.slice(u.publicCount).some(Boolean)) {
      warnings.push({ code: 'qna_public_text_unused', message: `「${u.unitKey}」 공개 문구 중 ${u.publicTexts.length - u.publicCount}개는 공개 건수를 넘어 쓰지 않습니다.` });
    }
  }
  const needDays = units.reduce((m, u) => Math.max(m, unitDays(u)), 0);
  if (needDays > days.length) blockers.push({ code: 'qna_no_dates', message: '진행일을 정할 수 없습니다 — 시작일을 확인하세요.' });
  if (blockers.length) return { slots: [], total: 0, blockers, warnings };

  const all = [];
  for (const u of units) {
    let pubIdx = 0;
    _layUnit(u, warnings).forEach((s, i) => {
      const day = days[s.dayIdx];
      all.push({
        unitKey: u.unitKey, unitIdx: u.unitIdx, unitSeq: i + 1,
        productName: u.productName, option1Value: u.option1Value, option2Value: u.option2Value,
        dayIdx: s.dayIdx, date: day.date, dateLabel: day.label, dow: day.dow || '',
        visibility: s.visibility,
        text: s.visibility === 'public' ? u.publicTexts[pubIdx++] : '',
      });
    });
  }
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.unitIdx - b.unitIdx || a.unitSeq - b.unitSeq);
  all.forEach((s, i) => { s.seq = startSeq + i; });
  return { slots: all, total: all.length, blockers, warnings };
}

/** 화면·작업표 칸에 쓰는 표기. */
const QNA_VISIBILITY_LABEL = { public: '공개', private: '비공개' };
const QNA_PRIVATE_GUIDE = '배송 문의 자유 (비공개)';

module.exports = { qnaUnitsFromWorkOrder, buildQnaCalendar, unitDays, QNA_VISIBILITY_LABEL, QNA_PRIVATE_GUIDE };
