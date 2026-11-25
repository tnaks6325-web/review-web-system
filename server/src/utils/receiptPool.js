/**
 * receiptPool.js — 영수증리뷰(결정 418·420) **오더 입력 계약** 정규화 + **영수증 묶음**(영수증 한 장 = 리뷰어 한 명 자리) 생성 — 순수 함수(DB 없음).
 *
 * 영수증리뷰 = 리뷰어가 매장에 가서(비용은 업체 부담) 참여할 때 받은 **영수증 사진 한 장**으로 네이버 영수증 리뷰를 남긴다.
 * 입금은 리뷰비만 · 방문 날짜는 고르지 않는다(기간 안 자유 방문 · 마감 = 참여한 날 + N일) · 영수증 금액은 보지 않는다.
 *
 * ★★ 오더 입력 계약(단일 출처 — 인트라넷 7단계가 이 모양으로 보낸다 · v2 상품 원본 안에 둔다):
 *   work_orders.work_kind = 'receipt' · workboard_schema_version = 2 · recruit_count = 영수증 장수 · pay_amount = 0 · review_fee = 리뷰비
 *   product_options_json = [{                       ← 매장 하나 = 상품 하나(오더 하나 = 매장 하나)
 *     name: '<매장 이름>', url: '<네이버 플레이스 주소>', option_schema_version: 2, product_mode: 'none', options: [],
 *     base: { pay: 0, count: <영수증 장수>, daily: 0, review_type_mix: [] },
 *     receipt: {
 *       review_deadline_days: 3,                      ← 리뷰 마감 = 참여한 날 + N일(달력 날 · 1~30 · 없으면 3)
 *       place_address: '<매장 주소>',                 ← 안내용(선택)
 *       receipts: [{ file_id: '<드라이브 파일 번호>' }, …]   ← AE 가 붙인 순서 = 영수증 번호(1..N) · 한 장 = 한 자리
 *     }
 *   }]
 *   - 매장 이름·주소 링크는 **상품 이름·상품 주소 칸을 그대로 쓴다**(따로 두면 두 값이 갈린다 · 작업표 「상품」 칸·공고 상품 주소가 같은 값).
 *   - 영수증 사진은 `POST /api/order/receipt-review-image` 로 **먼저 올려** 받은 파일 번호만 쓴다(비공개 — 공개 주소 없음 ·
 *     접수 때 비공개 목록 `receipt_review_files` 에 없는 번호가 섞이면 묶음을 깔지 않는다 · receiptPool.service).
 *   - 같은 키 이름 `receipt` 가 캡처 칸 키(현금영수증)에도 있지만 **다른 축**이다 — 이 키는 상품 원본 안의 영수증리뷰 설정이고,
 *     현금영수증 칸·안내(captureSlots·cashReceiptContext)는 이 값을 읽지 않는다(결정 418 「현금영수증과 섞지 않는다」).
 *
 * ★ 잠금(blocker)은 「그대로 깔면 반드시 틀린 묶음」만 — 고쳐서 다시 보내면 된다(조용히 고쳐 깔지 않는다).
 * ★ 영수증을 펼치기 **전에** 장수 상한을 본다(큰 오타로 서버가 멈추지 않게 — Q&A `qna_too_many` · 예약 `booking_too_many` 와 같은 규율).
 * ★ 작업표에는 파일 번호를 싣지 않는다 — 「영수증」 칸은 `N번` 표기만(작업표·장부는 업체 화면에도 나간다).
 */
'use strict';

const { selectionKey } = require('../services/productOptions.service');

const RECEIPT_REVIEW_DEFAULT_DEADLINE_DAYS = 3;
const RECEIPT_REVIEW_MAX_DEADLINE_DAYS = 30;
const MAX_RECEIPTS = 2000;   // worktablePlan.MAX_ROWS 와 같은 값(한 작업의 줄 상한)
// 드라이브 파일 번호 모양 — 결정 352 사진 통로(`/^[-\w]{20,}$/`)와 같은 모양 + 길이 상한.
const RECEIPT_FILE_ID_RE = /^[-\w]{20,200}$/;

function isReceiptFileId(v) { return typeof v === 'string' && RECEIPT_FILE_ID_RE.test(v); }

/** 정수 글자/숫자만 받는다(소수·빈 값·글자 = null). */
function _strictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const s = String(v == null ? '' : v).trim();
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
}

function _parseProducts(wo) {
  const raw = wo && wo.product_options_json;
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : null; } catch (_) { return null; }
}

function _hasQtyTiers(p) {
  const t = p && p.qty_tiers;
  if (!t) return false;
  if (typeof t !== 'object') return true;
  return Array.isArray(t.rows) ? t.rows.length > 0 : Object.keys(t).length > 0;
}

/** 작업표 「영수증」 칸 표기 — 영수증 번호만(파일 번호는 싣지 않는다). */
function receiptPoolLabel(poolSeq) { return `${Number(poolSeq)}번`; }

/**
 * 작업오더 → 영수증리뷰 계약(정규화) + 잠금.
 * @returns {{ spec: object|null, blockers: Array<{code,message}> }}
 *   spec = { placeName, placeUrl, placeAddress, unitKey, receipts:[{poolSeq,fileId}], total, reviewDeadlineDays }
 */
function receiptReviewSpecFromWorkOrder(wo = {}) {
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  if (Number(wo && wo.workboard_schema_version) !== 2) block('receipt_requires_v2', '영수증리뷰는 새 리뷰오더 형식(상품·옵션 단계형)으로만 만들 수 있습니다.');

  const products = _parseProducts(wo);
  const live = Array.isArray(products) ? products.filter(p => p && typeof p === 'object' && !p.closed) : [];
  const p = live.length === 1 ? live[0] : null;
  if (!p || String(p.product_mode || '').trim() === 'opt' || (Array.isArray(p.options) && p.options.length)) {
    block('receipt_one_place', '영수증리뷰 오더는 매장 하나(옵션 없는 상품 하나)여야 합니다.');
    return { spec: null, blockers };
  }
  const placeName = String(p.name || '').trim();
  if (!placeName) block('receipt_place_name', '매장 이름이 비어 있습니다.');
  if (_hasQtyTiers(p)) block('receipt_no_qty_tiers', '영수증리뷰는 구매수량 단계를 쓰지 않습니다.');

  const r = p.receipt && typeof p.receipt === 'object' && !Array.isArray(p.receipt) ? p.receipt : null;
  if (!r) {
    block('receipt_no_spec', '영수증리뷰 설정(영수증 사진 · 리뷰 마감)이 없습니다.');
    return { spec: null, blockers };
  }

  const raw = Array.isArray(r.receipts) ? r.receipts : [];
  if (!raw.length) {
    block('receipt_no_files', '붙인 영수증 사진이 없습니다 — 영수증 한 장이 리뷰어 한 명 자리입니다.');
    return { spec: null, blockers };
  }
  if (raw.length > MAX_RECEIPTS) {
    block('receipt_too_many', `영수증이 ${raw.length}장으로 한 작업의 상한(${MAX_RECEIPTS}장)을 넘습니다.`);
    return { spec: null, blockers };
  }
  const receipts = [];
  const seen = new Set();
  let invalid = 0, dup = 0;
  for (const item of raw) {
    const fileId = item && typeof item === 'object' && !Array.isArray(item) && typeof item.file_id === 'string' ? item.file_id.trim() : '';
    if (!isReceiptFileId(fileId)) { invalid++; continue; }
    if (seen.has(fileId)) { dup++; continue; }
    seen.add(fileId);
    receipts.push({ poolSeq: receipts.length + 1, fileId });
  }
  if (invalid) block('receipt_file_invalid', `영수증 ${invalid}장의 파일 번호가 올바르지 않습니다 — 영수증 사진을 다시 올려 주세요.`);
  if (dup) block('receipt_file_duplicate', `같은 영수증 사진이 ${dup}번 더 붙어 있습니다 — 영수증 한 장은 리뷰어 한 명에게만 갑니다.`);
  const total = raw.length;

  const woTotal = _strictInt(wo && wo.recruit_count);
  const baseCount = p.base && p.base.count != null && String(p.base.count).trim() !== '' ? _strictInt(p.base.count) : null;
  if ((woTotal || 0) !== total || (baseCount != null && baseCount !== total)) {
    block('receipt_total_mismatch', `모집 인원 ${woTotal || 0}명(상품 인원 ${baseCount == null ? '-' : baseCount}명)과 영수증 ${total}장이 다릅니다 — 영수증 장수만큼만 모집합니다.`);
  }

  const pay = _strictInt(p.base && p.base.pay) || 0;
  const payTotal = _strictInt(wo && wo.pay_amount) || 0;
  if (pay > 0 || payTotal > 0) block('receipt_has_pay', '영수증리뷰는 결제금액이 0이어야 합니다(매장 비용은 업체 부담 · 리뷰비만 입금).');

  let reviewDeadlineDays = RECEIPT_REVIEW_DEFAULT_DEADLINE_DAYS;
  if (r.review_deadline_days != null && String(r.review_deadline_days).trim() !== '') {
    const n = _strictInt(r.review_deadline_days);
    if (n == null || n < 1 || n > RECEIPT_REVIEW_MAX_DEADLINE_DAYS) block('receipt_deadline_days', `리뷰 마감은 참여한 날부터 1~${RECEIPT_REVIEW_MAX_DEADLINE_DAYS}일이어야 합니다.`);
    else reviewDeadlineDays = n;
  }

  return {
    spec: {
      placeName,
      placeUrl: String(p.url || (wo && wo.product_url) || '').trim(),
      placeAddress: String(r.place_address == null ? '' : r.place_address).trim(),
      unitKey: selectionKey(placeName, '', ''),
      receipts, total, reviewDeadlineDays,
    },
    blockers,
  };
}

/**
 * 영수증 묶음 생성 — 받은 순서 그대로 한 장 = 한 자리. 같은 계약이면 언제나 같은 seq(재접수·복구가 같은 표).
 * ★ 날짜를 만들지 않는다 — 참여일자·리뷰마감일은 리뷰어가 참여할 때(3단계) 채워진다.
 * @param {object} spec  receiptReviewSpecFromWorkOrder().spec
 * @returns {{ slots: Array<{seq,poolSeq,fileId,unitKey,placeName,label}>, total: number, blockers: Array }}
 */
function buildReceiptPool(spec, { startSeq = 1 } = {}) {
  if (!spec || !Array.isArray(spec.receipts) || !spec.receipts.length) {
    return { slots: [], total: 0, blockers: [{ code: 'receipt_no_files', message: '붙인 영수증 사진이 없습니다.' }] };
  }
  if (spec.receipts.length > MAX_RECEIPTS) {
    return { slots: [], total: 0, blockers: [{ code: 'receipt_too_many', message: `영수증이 상한(${MAX_RECEIPTS}장)을 넘습니다.` }] };
  }
  const slots = spec.receipts.map((rc, i) => ({
    seq: startSeq + i,
    poolSeq: rc.poolSeq,
    fileId: rc.fileId,
    unitKey: spec.unitKey, placeName: spec.placeName,
    label: receiptPoolLabel(rc.poolSeq),
  }));
  return { slots, total: slots.length, blockers: [] };
}

/**
 * 화면 응답용 — 상품 원본 글(product_options_json)에서 영수증 파일 번호를 지운다(장수·순서는 남긴다: `{ no: N }`).
 * ★ 작업보드 응답(workdeskTab `detail`)은 업체(광고주) 화면에도 나간다 — 파일 번호가 실리면 비공개 사진의 열쇠가 퍼진다.
 * ★ 영수증 목록이 없는 글은 **받은 값 그대로** 돌려준다(리뷰·블로그·Q&A·예약 오더 응답 바이트 불변).
 */
function redactReceiptFileIds(raw) {
  if (raw == null) return raw;
  const text = typeof raw === 'string' ? raw : null;
  if (text != null && !text.includes('"receipts"')) return raw;
  let list;
  try { list = text != null ? JSON.parse(text) : raw; } catch (_) { return raw; }
  if (!Array.isArray(list)) return raw;
  let changed = false;
  const out = list.map(p => {
    if (!p || typeof p !== 'object' || !p.receipt || typeof p.receipt !== 'object' || !Array.isArray(p.receipt.receipts)) return p;
    changed = true;
    return { ...p, receipt: { ...p.receipt, receipts: p.receipt.receipts.map((_, i) => ({ no: i + 1 })) } };
  });
  if (!changed) return raw;
  return text != null ? JSON.stringify(out) : out;
}

module.exports = {
  redactReceiptFileIds,
  receiptReviewSpecFromWorkOrder, buildReceiptPool, receiptPoolLabel, isReceiptFileId,
  RECEIPT_REVIEW_DEFAULT_DEADLINE_DAYS, RECEIPT_REVIEW_MAX_DEADLINE_DAYS, MAX_RECEIPTS, RECEIPT_FILE_ID_RE,
};
