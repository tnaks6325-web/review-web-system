/**
 * ═══════════════════════════════════════════════════════════
 * Track B — 백그라운드 평행 트랙(DB-first 통합 작업대의 그림자).
 *
 * ★ 무영향 보장(선행조성 3원칙): 추가만 · 읽기만(라이브를 읽어 B를 만듦) · 격리(master/광고주 스코프).
 *   - 기존 participants.service(Phase1 shadow)를 재사용해 로스터를 채우고, 여기서 "정렬무관 내용키 +
 *     주문링크 + seen-set(활성/비활성) + 업체 소유 + 6차원 parity"를 얹는다.
 *   - 검색·my-status·대시보드·시트·주문 흐름을 일절 건드리지 않는다. 라이브 코드가 이 모듈을 참조 0.
 *   - 되돌리기 = 라우트 미마운트 + 047 컬럼/테이블 드롭.
 *
 * parity 확정 기준(사용자 확정): ①완료판정=현 감지값 그대로 ②작업세부=발주 정형필드 ③업체소유=1:N
 *   ④관측기간=2주. 의도된차이 카탈로그 BD-1~7.
 * ═══════════════════════════════════════════════════════════
 */
const { logger } = require('../utils/logger');
const participants = require('./participants.service');

let _pool;
function getPool() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

function _phone8(v) { const d = String(v == null ? '' : v).replace(/[^0-9]/g, ''); return d.length >= 8 ? d.slice(-8) : ''; }
function _norm(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ''); }
function _mask(p8) { const s = String(p8 || ''); return s.length >= 4 ? '••••' + s.slice(-4) : (s || ''); }
// 이름/수취인 부분 마스킹(광고주 외부 뷰): 첫 글자만 노출 + 나머지 ○(식별성 유지 + PII 보호). 1글자·공란은 그대로.
function _maskName(n) { const s = String(n == null ? '' : n).trim(); if (s.length <= 1) return s; return s[0] + '○'.repeat(Math.min(s.length - 1, 4)); }

/**
 * 정렬무관 내용키(computeDedupKey 규칙 재현): 주문번호 6자리↑ → num:, 아니면 rcp:(수취인+연락처+날짜+옵션),
 *   그래도 신원 근거 약하면 phone8:. 정렬·행이동에 불변인 안정 신원키.
 */
function identityKey({ orderNum, recipient, phone8, dateStr, optKey } = {}) {
  const num = String(orderNum == null ? '' : orderNum).replace(/[^0-9]/g, '');
  if (num.length >= 6) return `num:${num}`;
  const p8 = _phone8(phone8);
  const rcp = _norm(recipient);
  // 수취인 있으면 order dedup 규칙과 동형(rcp:), 없으면 phone8: 축약(둘 다 정렬 불변).
  //   ★ 주문에 링크된 행은 이 함수 대신 order_submissions.dedup_key 를 그대로 써 원장과 정확히 일치.
  if (rcp) return `rcp:${rcp}|${p8}|${_norm(dateStr)}|${_norm(optKey)}`;
  return p8 ? `phone8:${p8}` : '';
}

// ── 앵커 도출(order > manual > identity). seq(물리행) 앵커 금지 = 정렬 면역. 편집/합성/revert 공유. ──
//   _ikFromRow: _enrichTab(비주문행 identity_key 계산)과 동형 재료 — 편집시점 계산 ≡ 투영시점 값.
function _ikFromRow(row) {
  const rj = (row.row_json && typeof row.row_json === 'object') ? row.row_json : {};
  let orderNum = '';
  for (const k of Object.keys(rj)) { const kl = k.toLowerCase(); if (kl.includes('주문번호') || kl.includes('ordernum')) { orderNum = rj[k]; break; } }
  return { orderNum, recipient: row.recipient_name, phone8: row.phone8, dateStr: '', optKey: row.option_text };
}
function _deriveAnchor(row) {
  if (row.order_submission_id) return { type: 'order', value: String(row.order_submission_id) };
  if (row.source === 'manual') return { type: 'manual', value: String(row.id) };   // 재투영 면역 물리행
  const ik = row.identity_key || identityKey(_ikFromRow(row));
  return ik ? { type: 'identity', value: ik } : null;
}
// 편집 가능 필드 → 형태(bool/text). '_hidden'=제거 오버레이(import행). 화이트리스트(인젝션·형오류 차단).
const _EDIT_FIELD_KIND = {
  reviewer_name: 'text', recipient_name: 'text', round: 'text', option_text: 'text',
  product_name: 'text', phone8: 'text', is_submitted: 'bool', is_paid: 'bool', _hidden: 'bool',
};
// 시트 컬럼(헤더)이 제출/입금 "상태 토글"열이면 물리 토글로 연동 → 카운트(제출완료/입금완료)와 일치.
//   ★ 정확 화이트리스트 — '입금자명/입금계좌/입금일'·'리뷰제출일/리뷰미제출'·'주문자제출' 등 정보열 오탐 차단.
//   미매칭이면 null(연동 안 함, 안전). 새 상태열 명칭은 여기 추가.
const _SUBMIT_HEADERS = new Set(['리뷰제출', '리뷰제출여부', '리뷰제출완료', '제출']);
const _PAID_HEADERS = new Set(['입금', '입금여부', '입금완료']);
function _linkedToggle(header) {
  const h = String(header || '').trim();
  if (_SUBMIT_HEADERS.has(h)) return 'is_submitted';
  if (_PAID_HEADERS.has(h)) return 'is_paid';
  return null;
}

// ── 그림자 투영: 임포트(participants) + 신원키/주문링크 강화 + seen-set 재투영 ──
async function projectTab({ sheetId, tabName, by = 'trackB' } = {}) {
  if (!sheetId || !tabName) throw new Error('projectTab: sheetId, tabName 필수');
  const runStart = new Date().toISOString();
  // 1) 로스터 임포트(review_index→campaign_participants). 기존 검증된 경로 재사용(시트 재읽기 0).
  const imp = await participants.importTabFromIndex({ sheetId, tabName, by });
  // 2) 신원키 + 주문링크 강화(라이브 order_submissions를 읽어 B에만 씀).
  const enr = await _enrichTab({ sheetId, tabName });
  // 3) seen-set: 이번 임포트에 안 보인 import행 → 비활성(하드삭제 아님, 이력 보존).
  const rec = await _reconcileSeen({ sheetId, tabName, runStart });
  return { ...imp, ...enr, ...rec };
}

async function _enrichTab({ sheetId, tabName } = {}) {
  const db = getPool();
  // B 행(활성 import/manual) 로드
  const { rows: prows } = await db.query(
    `SELECT id, seq, phone8, recipient_name, round, option_text, row_json
       FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL`,
    [sheetId, tabName]);
  if (!prows.length) return { enriched: 0, orderLinked: 0 };
  // 이 탭의 라이브 주문원장(내용키·주문링크 재료)
  const { rows: orders } = await db.query(
    `SELECT id, dedup_key, order_num, recipient, phone, price, date_str, selected_opt_key, mirror_status
       FROM order_submissions
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL`,
    [sheetId, tabName]);
  // phone8 → 주문(있으면 written 우선). 단순 1차 매칭(정밀 매칭은 후속).
  const byPhone = new Map();
  for (const o of orders) {
    const p8 = _phone8(o.phone);
    if (!p8) continue;
    const prev = byPhone.get(p8);
    if (!prev || (o.mirror_status === 'written' && prev.mirror_status !== 'written')) byPhone.set(p8, o);
  }
  let enriched = 0, orderLinked = 0;
  for (const p of prows) {
    const rj = (p.row_json && typeof p.row_json === 'object') ? p.row_json : {};
    // row_json에서 주문번호 후보(헤더에 '주문번호'/'ordernum' 포함 칸)
    let orderNum = '';
    for (const k of Object.keys(rj)) {
      const kl = k.toLowerCase();
      if (kl.includes('주문번호') || kl.includes('ordernum')) { orderNum = rj[k]; break; }
    }
    const ord = p.phone8 ? byPhone.get(p.phone8) : null;
    let ik, orderId = null, price = null;
    if (ord) {
      ik = ord.dedup_key || identityKey({ orderNum: ord.order_num, recipient: ord.recipient, phone8: ord.phone, dateStr: ord.date_str, optKey: ord.selected_opt_key });
      orderId = ord.id; price = ord.price || null; orderLinked++;
    } else {
      ik = identityKey({ orderNum, recipient: p.recipient_name, phone8: p.phone8, dateStr: '', optKey: p.option_text });
    }
    await db.query(
      `UPDATE campaign_participants
          SET identity_key = $2, order_submission_id = COALESCE($3, order_submission_id),
              price = COALESCE($4, price),
              first_seen_at = COALESCE(first_seen_at, NOW()),
              active = TRUE, absent_since = NULL
        WHERE id = $1`,
      [p.id, ik || null, orderId, price]);
    enriched++;
  }
  return { enriched, orderLinked };
}

// seen-set: 이번 실행(runStart) 이후 imported_at 이 갱신된 import행만 활성. 나머지 import행 → 비활성.
//   manual 행은 seen-set 대상 아님(사람이 직접 넣은 것 — 임포트로 사라지지 않음).
async function _reconcileSeen({ sheetId, tabName, runStart } = {}) {
  const db = getPool();
  const { rowCount: deactivated } = await db.query(
    `UPDATE campaign_participants
        SET active = FALSE, absent_since = COALESCE(absent_since, NOW())
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
        AND source = 'import' AND active = TRUE
        AND (imported_at IS NULL OR imported_at < $3::timestamptz)`,
    [sheetId, tabName, runStart]);
  return { deactivated };
}

// 여러 활성 탭 일괄 투영(플래그 게이트 + best-effort). 라이브 무영향.
async function projectActive({ limit = 100, by = 'trackB-cron' } = {}) {
  if (process.env.TRACK_B_PROJECTION !== '1') return { skipped: true, reason: 'TRACK_B_PROJECTION!=1' };
  const tabs = await participants.listActiveTabs({ limit });
  let done = 0, errors = 0;
  for (const t of tabs) {
    try { await projectTab({ sheetId: t.sheetId, tabName: t.tabName, by }); done++; }
    catch (e) { errors++; logger.warn(`[trackB] project ${t.tabName} 실패: ${e.message}`); }
  }
  return { candidateTabs: tabs.length, done, errors };
}

// ── parity 리포트: B(campaign_participants) ↔ A(review_index), 6차원 × 3버킷 ──
//   확정 기준: 짝짓기=phone8(행번호 금지), 완료판정=review_index의 is_submitted/is_submitted2 그대로.
//   버킷: match / benign(카탈로그 BD-1~7) / real(진짜 불일치, 전환 전 0이어야).
//   _parityCore: readiness 제외 코어(A/B 로드+편집셋+classifyParity). parityReport·parityAll 공용.
async function _parityCore(sheetId, tabName) {
  const db = getPool();
  const { rows: aRows } = await db.query(
    `SELECT reviewer_name AS name, phone8, is_submitted AS submitted,
            (is_submitted2 = 'PAID') AS paid, round
       FROM review_index WHERE sheet_id=$1 AND tab_name=$2 AND row_index IS NOT NULL`,
    [sheetId, tabName]);
  const { rows: bRows } = await db.query(
    `SELECT id, reviewer_name AS name, phone8, is_submitted AS submitted, is_paid AS paid, round, source, active,
            order_submission_id, identity_key, recipient_name, option_text, row_json
       FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active = TRUE`,
    [sheetId, tabName]);
  // 편집된 앵커의 phone8 집합 → classifyParity가 그 행의 A↔B 차이를 real 아닌 benign(BD-8)로 분류.
  //   ★ parity가 실제 비교하는 필드(제출/입금/차수/이름)의 편집만 집계 — col:* 등 미비교 컬럼 편집이
  //     진짜 상태 불일치를 benign으로 가리지 못하게(전환 게이트 약화 방지).
  const { rows: edRows } = await db.query(
    `SELECT DISTINCT anchor_type, anchor_value FROM participant_edits
      WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL
        AND field IN ('reviewer_name','is_submitted','is_paid','round')`, [sheetId, tabName]).catch(() => ({ rows: [] }));
  const editedAnchors = new Set(edRows.map(e => e.anchor_type + ' ' + e.anchor_value));
  const editedKeys = new Set();
  if (editedAnchors.size) {
    for (const b of bRows) {
      const a = _deriveAnchor(b);
      if (a && editedAnchors.has(a.type + ' ' + a.value)) { const p8 = _phone8(b.phone8); if (p8) editedKeys.add(p8); }
    }
  }
  return classifyParity(aRows, bRows, editedKeys);
}

async function parityReport({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('parityReport: sheetId, tabName 필수');
  const base = await _parityCore(sheetId, tabName);
  // d4/d5/d6 는 A↔B "차이"가 아니라 전환 준비도(coverage/귀속) 관측 — data-parity pass 를 뒤집지 않음(별도).
  const readiness = await _readinessFor({ sheetId, tabName });
  return { ...base, readiness };
}

// ── 전체 정밀 계산: 투영된 전 탭의 정밀 parity(진짜 불일치)를 일괄 계산 + 스냅샷 저장(2주 추이 정량화). ──
//   읽기+관측기록만(라이브 무접촉). store=false면 계산만. source: 'manual'(버튼) | 'cron'(일일).
async function parityAll({ store = true, source = 'manual' } = {}) {
  const db = getPool();
  const { rows: tabs } = await db.query(
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName", MIN(tab_gid) AS "tabGid"
       FROM campaign_participants WHERE deleted_at IS NULL AND active
      GROUP BY sheet_id, tab_name`);
  const batchAt = new Date();
  const results = [];
  for (const t of tabs) {
    try {
      const p = await _parityCore(t.sheetId, t.tabName);
      const d3 = (p.dims && p.dims.d3_counts) || {};
      const rec = { sheetId: t.sheetId, tabName: t.tabName, tabGid: t.tabGid,
        aTotal: d3.aTotal || 0, bTotal: d3.bTotal || 0,
        match: p.buckets.match, benign: p.buckets.benign, real: p.buckets.real, pass: p.pass };
      results.push(rec);
      if (store) await db.query(
        `INSERT INTO parity_snapshots (sheet_id, tab_name, tab_gid, batch_at, a_total, b_total, match_cnt, benign_cnt, real_cnt, pass, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [t.sheetId, t.tabName, t.tabGid, batchAt, rec.aTotal, rec.bTotal, rec.match, rec.benign, rec.real, rec.pass, source]);
    } catch (e) { logger.warn(`[trackB] parityAll ${t.tabName} 실패: ${e.message}`); }
  }
  return { batchAt, tabs: results.length, realZero: results.filter(r => r.real === 0).length, results };
}

// ── parity 추이: 한 탭의 스냅샷 이력(오래된→최근, 스파크라인용). ──
async function parityTrend({ sheetId, tabName, limit = 30 } = {}) {
  if (!sheetId || !tabName) throw new Error('parityTrend: sheetId, tabName 필수');
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const { rows } = await db.query(
    `SELECT taken_at AS "takenAt", real_cnt AS "real", match_cnt AS "match", benign_cnt AS "benign", pass, source
       FROM parity_snapshots WHERE sheet_id=$1 AND tab_name=$2 ORDER BY taken_at DESC LIMIT $3`,
    [sheetId, tabName, lim]).catch(() => ({ rows: [] }));
  return rows.reverse();
}

/**
 * 전환 준비도(readiness): 정형 소스가 얼마나 채워졌나. data-parity(d1~d3) 게이트와 분리한 별도 신호.
 *   - workOrder(d4): 이 탭에 연결된 작업발주 정형필드(작업세부 원본, 사용자 확정 ②)가 있고 채워졌나.
 *   - ownership(d5): 이 탭이 업체 소유로 지정됐나(사용자 확정 ③, 1:N) — 소유자명 포함.
 *   - financial(d6): 주문원장은 공용이라 "귀속"만 관측 — 링크된 주문 수·written 금액합.
 */
async function _readinessFor({ sheetId, tabName } = {}) {
  const db = getPool();
  // 이름 변경에 안전한 gid 확보(있으면 시트단위/탭단위 소유 판정에 사용)
  const { rows: gidRows } = await db.query(
    `SELECT tab_gid AS "tabGid" FROM raw_sheet_tabs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`,
    [sheetId, tabName]).catch(() => ({ rows: [] }));
  const tabGid = (gidRows[0] && gidRows[0].tabGid) || null;

  // d4 작업발주 연결/충실도 — Track B 링크(수동) 우선 → work_orders.linked_tab(Track A 승인) 폴백.
  const { rows: wo } = await db.query(
    `SELECT title, product_option AS "productOption", daily_count AS "dailyCount",
            purchase_time AS "purchaseTime", delivery_type AS "deliveryType", recruit_count AS "recruitCount"
       FROM work_orders
      WHERE deleted_at IS NULL AND ($3::text IS NOT NULL AND id=$3 OR (linked_tab_sheet_id=$1 AND linked_tab_name=$2))
      ORDER BY ($3::text IS NOT NULL AND id=$3) DESC, created_at DESC LIMIT 1`,
    [sheetId, tabName, await _effectiveLinkedWorkOrderId(db, sheetId, tabName)]).catch(() => ({ rows: [] }));
  const w = wo[0] || null;
  const woFields = w ? ['productOption', 'purchaseTime', 'deliveryType', 'recruitCount'].filter(k => _norm(w[k])) : [];
  const workOrder = { linked: !!w, filled: woFields.length, of: 4, title: w ? w.title : null };

  // d5 소유 지정(시트전체 tab_gid NULL 소유가 이 탭을 덮거나, 이 tab_gid 직접 소유)
  const { rows: owners } = await db.query(
    `SELECT DISTINCT adv.id, adv.name, (ac.tab_gid IS NULL) AS "wholeSheet"
       FROM advertiser_campaigns ac JOIN advertisers adv ON adv.id = ac.advertiser_id
      WHERE ac.deleted_at IS NULL AND ac.sheet_id = $1
        AND (ac.tab_gid IS NULL OR ac.tab_gid = $2)`,
    [sheetId, tabGid]).catch(() => ({ rows: [] }));
  const ownership = { assigned: owners.length > 0, owners: owners.map(o => ({ name: o.name, wholeSheet: o.wholeSheet })) };

  // d6 금액 귀속(공용 주문원장 관측 전용): 링크된 B 참여자 수 + written 주문 금액합
  const { rows: fin } = await db.query(
    `SELECT
        (SELECT COUNT(*)::int FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active AND order_submission_id IS NOT NULL) AS "linkedOrders",
        (SELECT COUNT(*)::int FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active) AS "activeRows",
        (SELECT COALESCE(SUM(NULLIF(regexp_replace(COALESCE(price,''),'[^0-9]','','g'),'')::numeric),0)::bigint
           FROM order_submissions
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND mirror_status='written') AS "writtenAmount"`,
    [sheetId, tabName]).catch(() => ({ rows: [{}] }));
  const f = fin[0] || {};
  const financial = { linkedOrders: f.linkedOrders || 0, activeRows: f.activeRows || 0, writtenAmount: Number(f.writtenAmount || 0) };

  return { tabGid, workOrder, ownership, financial };
}

/**
 * 순수 함수(테스트용): A/B 행 배열을 phone8로 짝지어 3버킷 분류.
 *   - A에 중복 phone8(같은 사람 여러 행) → B가 1건이면 BD-3(benign dedup).
 *   - B-only(A에 없음) & source='manual' → benign(의도된 수동 추가). 그 외 B-only → real.
 *   - A-only(B에 없음) → real(그림자 누락). (A=review_index=현행 소스라 A에 있으면 있어야 함)
 *   - 짝된 쌍 상태(submitted/paid/round) 불일치 → real(시차 BD-5는 상위 관측기간에서 흡수).
 */
function classifyParity(aRows, bRows, editedKeys = new Set()) {
  const norm = r => ({ p8: _phone8(r.phone8), name: _norm(r.name), submitted: !!r.submitted, paid: !!r.paid, round: _norm(r.round), source: r.source });
  const A = aRows.map(norm).filter(r => r.p8);
  const B = bRows.map(norm).filter(r => r.p8);
  const aByP = new Map(), bByP = new Map();
  for (const a of A) { if (!aByP.has(a.p8)) aByP.set(a.p8, []); aByP.get(a.p8).push(a); }
  for (const b of B) { if (!bByP.has(b.p8)) bByP.set(b.p8, []); bByP.get(b.p8).push(b); }

  const buckets = { match: 0, benign: [], real: [] };
  // A 기준 순회
  for (const [p8, arr] of aByP) {
    const bl = bByP.get(p8);
    if (!bl || !bl.length) { buckets.real.push({ kind: 'A_only', phone8: _mask(p8), name: arr[0].name }); continue; }
    if (arr.length > 1 && bl.length === 1) buckets.benign.push({ bd: 'BD-3', kind: 'dup_collapsed', phone8: _mask(p8), aCount: arr.length });
    // 상태 대조(대표 1쌍)
    const a = arr[0], b = bl[0];
    if (a.submitted === b.submitted && a.paid === b.paid && a.round === b.round) buckets.match++;
    else if (editedKeys.has(p8)) buckets.benign.push({ bd: 'BD-8/edited', kind: 'state_edit', phone8: _mask(p8) });   // 의도된 편집 = benign
    else buckets.real.push({ kind: 'state_diff', phone8: _mask(p8), a: { s: a.submitted, p: a.paid, r: a.round }, b: { s: b.submitted, p: b.paid, r: b.round } });
  }
  // B-only
  for (const [p8, arr] of bByP) {
    if (aByP.has(p8)) continue;
    if (arr.some(x => x.source === 'manual')) buckets.benign.push({ bd: 'BD-6/manual', kind: 'b_only_manual', phone8: _mask(p8) });
    else if (editedKeys.has(p8)) buckets.benign.push({ bd: 'BD-8/edited', kind: 'b_only_edited', phone8: _mask(p8) });
    else buckets.real.push({ kind: 'B_only', phone8: _mask(p8), name: arr[0].name });
  }
  return {
    dims: {
      d1_membership: { aSet: aByP.size, bSet: bByP.size },
      d2_state: { compared: buckets.match + buckets.real.filter(r => r.kind === 'state_diff').length },
      d3_counts: {
        aTotal: A.length, bTotal: B.length,
        aSubmitted: A.filter(r => r.submitted).length, bSubmitted: B.filter(r => r.submitted).length,
        aPaid: A.filter(r => r.paid).length, bPaid: B.filter(r => r.paid).length,
      },
      d4_meta: { note: 'readiness.workOrder 참조(작업발주 정형필드 충실도)' },
      d5_ownership: { note: 'readiness.ownership 참조(업체 소유 지정 여부)' },
      d6_financial: { note: 'readiness.financial 참조(공용 원장 귀속 관측)' },
    },
    buckets: { match: buckets.match, benign: buckets.benign.length, real: buckets.real.length },
    benignSample: buckets.benign.slice(0, 20),
    realSample: buckets.real.slice(0, 40),
    // 게이트: 진짜 불일치 0 (의도된차이는 무관)
    realMismatch: buckets.real.length,
    pass: buckets.real.length === 0,
  };
}

// ── 업체(광고주) ↔ 캠페인(시트/탭) 소유 매핑 (단순 1:N) ──
async function setOwnership({ advertiserId, sheetId, tabGid = null, by = 'admin' } = {}) {
  if (!advertiserId || !sheetId) throw new Error('setOwnership: advertiserId, sheetId 필수');
  const db = getPool();
  await db.query(
    `INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid, assigned_by)
       VALUES ($1,$2,$3,$4)
     ON CONFLICT (advertiser_id, sheet_id, COALESCE(tab_gid,'')) DO UPDATE
       SET deleted_at = NULL, assigned_by = EXCLUDED.assigned_by`,
    [advertiserId, sheetId, tabGid, String(by).slice(0, 100)]);
  return { ok: true };
}
async function removeOwnership({ advertiserId, sheetId, tabGid = null } = {}) {
  const db = getPool();
  const { rowCount } = await db.query(
    `UPDATE advertiser_campaigns SET deleted_at = NOW()
      WHERE advertiser_id=$1 AND sheet_id=$2 AND COALESCE(tab_gid,'')=COALESCE($3,'') AND deleted_at IS NULL`,
    [advertiserId, sheetId, tabGid]);
  return { removed: rowCount };
}
async function listOwnership({ advertiserId, sheetId } = {}) {
  const db = getPool();
  const where = ['deleted_at IS NULL']; const vals = [];
  if (advertiserId) { vals.push(advertiserId); where.push(`advertiser_id = $${vals.length}`); }
  if (sheetId) { vals.push(sheetId); where.push(`sheet_id = $${vals.length}`); }
  const { rows } = await db.query(
    `SELECT id, advertiser_id AS "advertiserId", sheet_id AS "sheetId", tab_gid AS "tabGid", assigned_by AS "assignedBy", created_at AS "createdAt"
       FROM advertiser_campaigns WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, vals);
  return rows;
}
// 소유 지정 UI 좌측: 업체 목록 + 소유 캠페인 수(종료 거래처 제외).
async function listAdvertisersWithOwnership() {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.status,
            (SELECT COUNT(*) FROM advertiser_campaigns ac
              WHERE ac.advertiser_id = a.id AND ac.deleted_at IS NULL)::int AS owned
       FROM advertisers a
      WHERE a.status <> 'ended'
      ORDER BY a.sort_order ASC, a.name ASC`);
  return rows;
}

// ══ 작업오더(발주) 연동 — 수동 링크 + 작업세부 노출 + 명단 골격 준비. B 내부·격리(라이브 무접촉). ══
//   ★★ Track A 무접촉: work_orders.linked_tab_* 는 order.routes 승인(accept) 흐름이 **읽어 동작을 분기**한다
//      (비적격 상태+linked_tab 설정 시 승인 멱등 skip, idempotent 판정). 그래서 Track B는 그 컬럼을 절대 안 쓰고
//      **Track B 전용 링크 테이블(trackb_work_order_links, migration 051)** 에 발주↔탭 연결을 저장한다.
//      작업세부 표시는 [Track B 링크] 우선 → 없으면 [work_orders.linked_tab](Track A 승인 링크) 폴백으로 읽기만.
function _parseWoOptions(json) {
  if (!json) return [];
  let v; try { v = typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return []; }
  if (!Array.isArray(v)) return [];
  return v.map(o => {
    if (o == null) return '';
    if (typeof o === 'string') return o.trim();
    if (typeof o === 'object') return String(o.name || o.option || o.optionName || o.label || o.title || o.value || '').trim() || '';
    return String(o).trim();
  }).filter(Boolean);
}

// 이 탭의 유효 링크 발주 id: Track B 링크(수동) 우선 → 없으면 work_orders.linked_tab(Track A 승인) 폴백.
async function _effectiveLinkedWorkOrderId(db, sheetId, tabName) {
  const { rows } = await db.query(
    `SELECT work_order_id FROM trackb_work_order_links WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL LIMIT 1`,
    [sheetId, tabName]).catch(() => ({ rows: [] }));
  return (rows[0] && rows[0].work_order_id) || null;
}

// 링크 후보 발주 목록(드롭다운용): Track B 링크 상태 표기 + 최근순.
async function listWorkOrders({ sheetId, tabName, limit = 100 } = {}) {
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300);
  const { rows } = await db.query(
    `SELECT w.id, w.title, w.recruit_count AS "recruitCount", w.status, w.created_at AS "createdAt",
            l.sheet_id AS "linkSheetId", l.tab_name AS "linkTabName"
       FROM work_orders w
       LEFT JOIN LATERAL (SELECT sheet_id, tab_name FROM trackb_work_order_links
                           WHERE work_order_id = w.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) l ON TRUE
      WHERE w.deleted_at IS NULL
      ORDER BY w.created_at DESC LIMIT $1`, [lim]);
  return rows.map(r => {
    const here = !!(sheetId && r.linkSheetId === sheetId && r.linkTabName === tabName);
    return { id: r.id, title: r.title, recruitCount: r.recruitCount, status: r.status, createdAt: r.createdAt,
      linkedHere: here, linkedElsewhere: !!(r.linkSheetId && !here), linkedTabName: r.linkTabName || null };
  }).sort((a, b) => (b.linkedHere ? 1 : 0) - (a.linkedHere ? 1 : 0));
}

// 링크: work_orders 무접촉 — Track B 링크 테이블에 upsert(탭당 활성 1개, 교체 시 대체). tabGid는 미사용(안정성).
async function linkWorkOrder({ workOrderId, sheetId, tabName, tabGid = null, by = 'admin' } = {}) {
  if (!workOrderId || !sheetId || !tabName) throw new Error('linkWorkOrder: workOrderId, sheetId, tabName 필수');
  const db = getPool();
  const { rows: exist } = await db.query(`SELECT id FROM work_orders WHERE id=$1 AND deleted_at IS NULL LIMIT 1`, [workOrderId]);
  if (!exist.length) return { ok: false, error: 'work_order_not_found' };
  await db.query(
    `INSERT INTO trackb_work_order_links (sheet_id, tab_name, work_order_id, linked_by)
       VALUES ($1,$2,$3,$4)
     ON CONFLICT (sheet_id, tab_name) WHERE deleted_at IS NULL
     DO UPDATE SET work_order_id = EXCLUDED.work_order_id, linked_by = EXCLUDED.linked_by, created_at = NOW()`,
    [sheetId, tabName, workOrderId, String(by).slice(0, 100)]);
  return { ok: true };
}
async function unlinkWorkOrder({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('unlinkWorkOrder: sheetId, tabName 필수');
  const db = getPool();
  const { rowCount } = await db.query(
    `UPDATE trackb_work_order_links SET deleted_at = NOW()
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`, [sheetId, tabName]);
  return { ok: true, unlinked: rowCount };
}

// 발주 기준 명단 골격 준비: 유효 링크 발주의 모집인원·옵션으로 빈 슬롯을 부족분만 생성(gap-fill·멱등).
async function prepareRosterFromWorkOrder({ sheetId, tabName, tabGid = null, by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new Error('prepareRosterFromWorkOrder: sheetId, tabName 필수');
  const db = getPool();
  const linkedId = await _effectiveLinkedWorkOrderId(db, sheetId, tabName);
  const { rows } = await db.query(
    `SELECT recruit_count AS "recruitCount", product_options_json AS "optionsJson", product_option AS "productOption", title
       FROM work_orders
      WHERE deleted_at IS NULL AND ($3::text IS NOT NULL AND id=$3 OR (linked_tab_sheet_id=$1 AND linked_tab_name=$2))
      ORDER BY ($3::text IS NOT NULL AND id=$3) DESC, created_at DESC LIMIT 1`, [sheetId, tabName, linkedId]);
  const w = rows[0];
  if (!w) return { ok: false, error: 'no_linked_work_order' };
  const target = parseInt(w.recruitCount, 10) || 0;
  if (target <= 0) return { ok: false, error: 'recruit_count_zero' };
  let options = _parseWoOptions(w.optionsJson);
  if (!options.length && w.productOption && String(w.productOption).trim()) options = [String(w.productOption).trim()];
  const r = await participants.prepareRosterSlots({ sheetId, tabName, target, options, productName: w.title || null, by });
  return { ok: true, ...r };
}

// ── 관측 대시보드: 투영된 전 탭의 롤업(카운트 대조 + 준비도) 한 번에. 정밀 parity(진짜불일치)는 탭별 온디맨드. ──
//   경량 집계(탭당 상관 서브쿼리, 인덱스 사용) — 카운트 레벨 대조라 "동수 다른사람" 은 못 잡으니 게이트가 아닌 트리아지.
async function overview() {
  const db = getPool();
  const { rows } = await db.query(
    `WITH b AS (
       SELECT sheet_id, tab_name, MIN(tab_gid) AS tab_gid,
              COUNT(*) FILTER (WHERE active) AS b_total,
              COUNT(*) FILTER (WHERE active AND is_submitted) AS b_sub,
              COUNT(*) FILTER (WHERE active AND is_paid) AS b_paid,
              COUNT(*) FILTER (WHERE active AND order_submission_id IS NOT NULL) AS b_linked,
              MAX(imported_at) AS last_proj
         FROM campaign_participants WHERE deleted_at IS NULL
         GROUP BY sheet_id, tab_name
     )
     SELECT b.sheet_id AS "sheetId", b.tab_name AS "tabName", b.tab_gid AS "tabGid",
            b.b_total AS "bTotal", b.b_sub AS "bSub", b.b_paid AS "bPaid", b.b_linked AS "bLinked",
            b.last_proj AS "lastProjectedAt",
            rst.spreadsheet_title AS "spreadsheetTitle",
            (SELECT COUNT(*) FROM review_index ri WHERE ri.sheet_id=b.sheet_id AND ri.tab_name=b.tab_name AND ri.row_index IS NOT NULL) AS "aTotal",
            (SELECT COUNT(*) FROM review_index ri WHERE ri.sheet_id=b.sheet_id AND ri.tab_name=b.tab_name AND ri.is_submitted) AS "aSub",
            (SELECT COUNT(*) FROM review_index ri WHERE ri.sheet_id=b.sheet_id AND ri.tab_name=b.tab_name AND ri.is_submitted2='PAID') AS "aPaid",
            EXISTS(SELECT 1 FROM advertiser_campaigns ac WHERE ac.deleted_at IS NULL AND ac.sheet_id=b.sheet_id
                     AND (ac.tab_gid IS NULL OR ac.tab_gid=b.tab_gid)) AS "owned",
            (EXISTS(SELECT 1 FROM work_orders wo WHERE wo.deleted_at IS NULL
                      AND wo.linked_tab_sheet_id=b.sheet_id AND wo.linked_tab_name=b.tab_name)
             OR EXISTS(SELECT 1 FROM trackb_work_order_links l WHERE l.deleted_at IS NULL
                      AND l.sheet_id=b.sheet_id AND l.tab_name=b.tab_name)) AS "woLinked",
            tc.source_of_truth AS "sourceOfTruth"
       FROM b LEFT JOIN raw_sheet_tabs rst ON rst.sheet_id=b.sheet_id AND rst.tab_name=b.tab_name
              LEFT JOIN tab_configs tc ON tc.sheet_id=b.sheet_id AND tc.tab_name=b.tab_name
      ORDER BY rst.spreadsheet_title NULLS LAST, b.tab_name`);
  return rows.map(r => {
    const aTotal = Number(r.aTotal), aSub = Number(r.aSub), aPaid = Number(r.aPaid);
    const bTotal = Number(r.bTotal), bSub = Number(r.bSub), bPaid = Number(r.bPaid);
    const countMatch = (aTotal === bTotal && aSub === bSub && aPaid === bPaid);
    return {
      sheetId: r.sheetId, tabName: r.tabName, tabGid: r.tabGid, spreadsheetTitle: r.spreadsheetTitle || r.sheetId,
      a: { total: aTotal, submitted: aSub, paid: aPaid },
      b: { total: bTotal, submitted: bSub, paid: bPaid, linked: Number(r.bLinked) },
      countMatch, owned: !!r.owned, woLinked: !!r.woLinked, lastProjectedAt: r.lastProjectedAt,
      sourceOfTruth: r.sourceOfTruth || 'sheet',   // 진실원천(옵션 A cutover 스위치): 'sheet'(레거시) | 'db'(Track B)
    };
  });
}

// ══ 진실원천(source_of_truth) 컨트롤 — 옵션 A cutover 스위치 (P1: 기반·관측, 동작은 P2 write-back 엔진) ══
//   ★★ 격리 불변식(Track A 무접촉): 이 플래그를 읽는 곳은 **Track B write-back 엔진(P2, 미착수)뿐**이다.
//      Track A 라이브 핫패스(검색 search.service · 주문원장 orderLedger · 리뷰인덱스빌드 smartBuild ·
//      행배정 claimRow · 큐워커 syncQueue · RAW미러 rawMirror)는 source_of_truth 를 절대 참조하지 않으므로,
//      여기서 값을 'db'로 바꿔도 **라이브 동작은 완전 불변**(write-back 엔진이 생기기 전까지 플립은 inert).
//      이 불변식은 회귀가드 tests/trackBSourceOfTruth.test.js 가 Track A 파일에서 'source_of_truth' 미참조로 고정.
const _SOT_VALUES = new Set(['sheet', 'db']);   // 'sheet'=레거시 기본 · 'db'=Track B 원본(cutover)

async function getSourceOfTruth({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('getSourceOfTruth: sheetId, tabName 필수');
  const db = getPool();
  const { rows } = await db.query(
    `SELECT source_of_truth AS "sourceOfTruth" FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`,
    [sheetId, tabName]);
  return (rows[0] && rows[0].sourceOfTruth) || 'sheet';
}

// 플립(master 전용, 라우트 게이트). 'db' 전환은 **진짜 불일치(real) 0 게이트**(force 시 우회) — 준비 안 된 탭의
//   조기 cutover 방지. 반환에 parity 요약 동봉(UI가 게이트 결과 노출). 되돌리기 = value 'sheet'.
async function setSourceOfTruth({ sheetId, tabName, value, by = 'admin', force = false } = {}) {
  if (!sheetId || !tabName) throw new Error('setSourceOfTruth: sheetId, tabName 필수');
  if (!_SOT_VALUES.has(value)) return { ok: false, error: 'invalid_value', allowed: [..._SOT_VALUES] };
  let parity = null;
  if (value === 'db') {
    parity = await parityReport({ sheetId, tabName }).catch(() => null);   // data-parity 게이트(readiness 별도)
    const real = parity && parity.buckets ? parity.buckets.real : null;
    if (!force && real != null && real > 0) return { ok: false, error: 'parity_not_clean', real, parity };
  }
  const db = getPool();
  const { rowCount } = await db.query(
    `UPDATE tab_configs SET source_of_truth=$3 WHERE sheet_id=$1 AND tab_name=$2`,
    [sheetId, tabName, value]);
  if (!rowCount) return { ok: false, error: 'tab_not_found' };
  logger.info(`[trackB] source_of_truth ${sheetId}/${tabName} → ${value} (by ${by}${force ? ', forced' : ''})`);
  return { ok: true, sheetId, tabName, sourceOfTruth: value, parity };
}

// 광고주 스코프: 이 업체가 소유한 (sheet_id, tab_gid) 집합. tab_gid NULL 소유 = 그 시트 전체.
async function scopedTabsForAdvertiser(advertiserId) {
  if (!advertiserId) return { sheetIds: [], tabGids: [], allTabSheetIds: [] };
  const db = getPool();
  const { rows } = await db.query(
    `SELECT sheet_id AS "sheetId", tab_gid AS "tabGid" FROM advertiser_campaigns
      WHERE advertiser_id = $1 AND deleted_at IS NULL`, [advertiserId]);
  const allTabSheetIds = rows.filter(r => !r.tabGid).map(r => r.sheetId);
  const tabGids = rows.filter(r => r.tabGid).map(r => `${r.sheetId}::${r.tabGid}`);
  return { sheetIds: [...new Set(rows.map(r => r.sheetId))], tabGids, allTabSheetIds };
}

// AE(staff) 스코프: 그 AE가 담당(advertisers.inad_pm=로그인명)하는 업체가 소유한 (sheet_id, tab_gid) 집합.
//   담당 매핑 = 기존 inad_pm 재사용. tab_gid NULL 소유 = 그 시트 전체.
async function scopedTabsForStaff(staffName) {
  const nm = String(staffName || '').trim();
  if (!nm) return { sheetIds: [], tabGids: [], allTabSheetIds: [] };
  const db = getPool();
  // ★ 담당 매칭 정규화: inad_pm(자유입력)의 앞뒤 공백·표기차로 스코프가 조용히 비는 것을 방지(양쪽 TRIM).
  //   한계: 이름 문자열 매칭이라 동명 AE는 스코프를 공유한다(admin 신뢰경계 내). 안정 식별자(staff_id) 연결은
  //   별도 후속 — 운영상 inad_pm 은 staff 로그인명과 정확히 일치하는 유일값으로 관리할 것.
  const { rows } = await db.query(
    `SELECT ac.sheet_id AS "sheetId", ac.tab_gid AS "tabGid"
       FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
      WHERE TRIM(a.inad_pm) = $1 AND ac.deleted_at IS NULL`, [nm]);
  const allTabSheetIds = rows.filter(r => !r.tabGid).map(r => r.sheetId);
  const tabGids = rows.filter(r => r.tabGid).map(r => `${r.sheetId}::${r.tabGid}`);
  return { sheetIds: [...new Set(rows.map(r => r.sheetId))], tabGids, allTabSheetIds };
}

// 역할별 스코프 해석: advertiser→소유업체, staff→담당업체(inad_pm), 그 외→null(전체).
async function _scopeFor({ role, staffName, advertiserId } = {}) {
  if (role === 'advertiser') return await scopedTabsForAdvertiser(advertiserId);
  if (role === 'staff') return await scopedTabsForStaff(staffName);
  return null;   // master/admin = 전체
}
function _scopeOwns(scope, sheetId, tabGid) {
  if (!scope) return true;   // 전체 스코프(master/admin)
  return scope.allTabSheetIds.includes(sheetId) || (!!tabGid && scope.tabGids.includes(`${sheetId}::${tabGid}`));
}

// 탭 접근 권한(스코프): 편집 라우트(gid 미전달)용 — raw_sheet_tabs 로 gid 해석 후 스코프 판정.
async function canAccessTab({ role, staffName, advertiserId, sheetId, tabName } = {}) {
  const scope = await _scopeFor({ role, staffName, advertiserId });
  if (!scope) return true;                          // master/admin
  if (scope.allTabSheetIds.includes(sheetId)) return true;   // 시트 전체 소유
  if (!scope.tabGids.length) return false;
  const db = getPool();
  // 동명탭(같은 tab_name 여러 gid)이 있어도 결정적으로 판정 — LIMIT 1(비결정) 대신 그 tab_name을 가진
  //   모든 gid를 모아, 소유 gid와 교집합이 있으면 허용(명단은 tab_name으로 병합 조회되므로 이 기준이 일관).
  const { rows } = await db.query(
    `SELECT DISTINCT tab_gid FROM raw_sheet_tabs WHERE sheet_id=$1 AND tab_name=$2 AND tab_gid IS NOT NULL`,
    [sheetId, tabName]).catch(() => ({ rows: [] }));
  return rows.some(r => scope.tabGids.includes(`${sheetId}::${r.tab_gid}`));
}

// 역할 스코프 적용된 활성 탭 목록: staff/advertiser 는 담당/소유 탭만, master/admin 은 전체.
async function scopedActiveTabs({ role, staffName, advertiserId, limit } = {}) {
  const all = await participants.listActiveTabs({ limit });
  const scope = await _scopeFor({ role, staffName, advertiserId });
  if (!scope) return all;
  return all.filter(t => _scopeOwns(scope, t.sheetId, t.tabGid));
}

function _akey(type, value) { return type + '\t' + value; }   // 앵커 조합키(정렬무관, 값에 탭 없음)

// ── 통합 작업대 데이터(읽기): 세부 + 명단 + 상태 + 활성 오버레이 read-time 합성. 역할별 PII 마스킹. ──
//   ★ 물리행은 순수 투영(review_index 사본) 유지 — 편집은 participant_edits(오버레이)에만 살고 여기서 합성만.
//     정렬/재투영이 물리행을 덮어도 편집 무손실·무오염(교차노출 근본 차단). staff는 라우트가 이미 차단.
async function workdeskTab({ sheetId, tabName, tabGid, role = 'master', advertiserId = null, staffName = null } = {}) {
  if (!sheetId || !tabName) throw new Error('workdeskTab: sheetId, tabName 필수');
  const db = getPool();
  // 스코프 강제: advertiser=소유업체, staff(AE)=담당업체(inad_pm). 스코프 밖 탭은 거부(교차 접근 차단).
  //   ★ 판정은 클라이언트가 보낸 tabGid를 신뢰하지 않고 (sheetId, tabName)으로 gid를 재해석(canAccessTab).
  //     명단·PII·주문원장은 전부 tabName으로 조회되므로, 스코프도 반드시 tabName 기준이어야 read/edit
  //     비대칭이 사라진다(과거: 소유 gid를 쿼리스트링에 실어 타 탭 tabName의 명단을 긁는 교차 열람이 뚫렸음).
  if (role === 'advertiser' || role === 'staff') {
    const okc = await canAccessTab({ role, staffName, advertiserId, sheetId, tabName });
    if (!okc) return { scoped: true, denied: true };
  }
  const maskPII = role === 'advertiser';       // 광고주(외부)만 마스킹 · AE(내부)는 전체
  const showEdits = role !== 'advertiser';     // 편집 어포던스·orphan·hidden은 내부(master/admin/staff)
  const { rows: meta } = await db.query(
    `SELECT tc.campaign_name AS "campaignName", tc.manager, tc.review_type AS "reviewType",
            tc.delivery_type AS "deliveryType", tc.income_type AS "incomeType",
            tc.source_of_truth AS "sourceOfTruth"
       FROM tab_configs tc WHERE tc.sheet_id=$1 AND tc.tab_name=$2 LIMIT 1`, [sheetId, tabName]);
  const { rows: wo } = await db.query(
    `SELECT id, title, product_option AS "productOption", product_options_json AS "productOptionsJson",
            pay_amount AS "payAmount", daily_count AS "dailyCount", daily_count_text AS "dailyCountText",
            purchase_time AS "purchaseTime", inflow_keyword AS "inflowKeyword", inflow_type AS "inflowType",
            inflow_guide AS "inflowGuide", delivery_type AS "deliveryType", courier_proxy AS "courierProxy",
            review_type AS "reviewType", recruit_count AS "recruitCount", review_guide AS "reviewGuide",
            special_notes AS "specialNotes", product_url AS "productUrl", start_date AS "startDate",
            manager_name AS "managerName", status
       FROM work_orders
      WHERE deleted_at IS NULL AND ($3::text IS NOT NULL AND id=$3 OR (linked_tab_sheet_id=$1 AND linked_tab_name=$2))
      ORDER BY ($3::text IS NOT NULL AND id=$3) DESC, created_at DESC LIMIT 1`,
    [sheetId, tabName, await _effectiveLinkedWorkOrderId(db, sheetId, tabName)]).catch(() => ({ rows: [] }));
  if (wo[0]) wo[0].options = _parseWoOptions(wo[0].productOptionsJson);
  // 명단(활성) — 앵커 도출에 필요한 컬럼 포함
  const { rows: roster } = await db.query(
    `SELECT id, seq, reviewer_name AS name, recipient_name AS recipient, phone8,
            round, option_text AS option, product_name AS product,
            is_submitted AS submitted, is_paid AS paid, source,
            order_submission_id, identity_key, row_json
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active = TRUE
      ORDER BY seq`, [sheetId, tabName]);
  // 활성 오버레이(합성 + orphan 판정 공용 — 추가 쿼리 없음)
  const { rows: edits } = await db.query(
    `SELECT anchor_type, anchor_value, field, kind, value_bool, value_text
       FROM participant_edits
      WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL`, [sheetId, tabName]).catch(() => ({ rows: [] }));
  const editMap = new Map();   // 앵커키 -> { field: value }
  for (const e of edits) {
    const k = _akey(e.anchor_type, e.anchor_value);
    if (!editMap.has(k)) editMap.set(k, {});
    editMap.get(k)[e.field] = e.kind === 'bool' ? !!e.value_bool : (e.value_text == null ? '' : e.value_text);
  }
  // 제출한 구매양식 원본(order_submissions) — 링크된 주문의 실제 제출 내용. 내부(master/admin)만 PII 상세 노출.
  let ordMap = new Map();
  if (showEdits) {
    const orderIds = [...new Set(roster.map(r => r.order_submission_id).filter(Boolean).map(String))];
    if (orderIds.length) {
      const { rows: ords } = await db.query(
        `SELECT id, orderer, recipient, phone, address, order_num, date_str,
                selected_opt_key AS "selectedOptKey", price, submitted_at AS "submittedAt",
                mirror_status AS "mirrorStatus", sheet_row AS "sheetRow"
           FROM order_submissions WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [orderIds]).catch(() => ({ rows: [] }));
      ordMap = new Map(ords.map(o => [String(o.id), o]));
    }
  }
  // 시트형 그리드용: 시트 실제 헤더 순서(raw_sheet_tabs.detected_headers = 주문원장이 쓰는 열 순서 원본).
  //   내부(master/admin)만. 없으면 폴백(row_json 키 — 길이순이라 시트순 아님, 최후수단).
  let headers = null;
  if (showEdits) {
    const { rows: hh } = await db.query(
      `SELECT detected_headers FROM raw_sheet_tabs
        WHERE sheet_id=$1 AND (($2::text IS NOT NULL AND tab_gid=$2) OR tab_name=$3)
        ORDER BY ($2::text IS NOT NULL AND tab_gid=$2) DESC LIMIT 1`,
      [sheetId, tabGid, tabName]).catch(() => ({ rows: [] }));
    const dh = hh[0] && hh[0].detected_headers;
    if (Array.isArray(dh)) headers = [...new Set(dh.map(h => String(h == null ? '' : h).trim()).filter(Boolean))];
    if ((!headers || !headers.length)) {
      const rj = roster.find(r => r.row_json && typeof r.row_json === 'object' && Object.keys(r.row_json).length);
      headers = rj ? Object.keys(rj.row_json).filter(k => k !== 'id') : [];
    }
  }
  // identity 중복 카운트(ambiguous 게이트, 윈도우 SQL 대신 JS Map)
  const identCount = new Map();
  for (const r of roster) {
    if (r.order_submission_id || r.source === 'manual') continue;
    const ik = r.identity_key || identityKey(_ikFromRow(r));
    if (ik) identCount.set(ik, (identCount.get(ik) || 0) + 1);
  }
  const consumed = new Set();
  const out = [], hiddenList = [];
  let ambiguousCount = 0;
  for (const r of roster) {
    const anchor = _deriveAnchor(r);
    let ov = {}, editable = !!anchor, ambiguous = false;
    if (anchor) {
      const k = _akey(anchor.type, anchor.value);
      if (anchor.type === 'identity' && (identCount.get(anchor.value) || 0) > 1) {
        ambiguous = true; editable = false; ambiguousCount++;
        if (editMap.has(k)) consumed.add(k);          // 소비 표시(orphan 오분류 방지), 단 미적용
      } else if (editMap.has(k)) { ov = editMap.get(k); consumed.add(k); }
    }
    const pick = (f, phys) => (Object.prototype.hasOwnProperty.call(ov, f) ? ov[f] : phys);
    const syn = {
      id: r.id, seq: r.seq,
      name: pick('reviewer_name', r.name),
      recipient: pick('recipient_name', r.recipient),
      phone8: pick('phone8', r.phone8),
      round: pick('round', r.round),
      option: pick('option_text', r.option),
      product: pick('product_name', r.product),
      submitted: !!pick('is_submitted', r.submitted),
      paid: !!pick('is_paid', r.paid),
      source: r.source, hasOrder: !!r.order_submission_id,
    };
    if (ov._hidden === true) {                          // 제거 오버레이 → 본 목록서 제외
      if (showEdits) hiddenList.push({ id: r.id, seq: r.seq, name: syn.name });
      continue;
    }
    // 광고주(외부)는 phone8 + 이름·수취인(PII)까지 마스킹. AE/관리자(내부)는 전체.
    if (maskPII) { syn.phone8 = _mask(syn.phone8); syn.name = _maskName(syn.name); syn.recipient = _maskName(syn.recipient); }
    if (showEdits) {
      syn.anchorType = anchor ? anchor.type : null;
      syn.editable = editable; syn.ambiguous = ambiguous;
      syn.editedFields = Object.keys(ov).filter(f => f !== '_hidden');
      // 실 데이터 전량 투영: 시트 행 전체(row_json) + 제출 구매양식 원본(order). 상세 펼침용.
      syn.rowJson = (r.row_json && typeof r.row_json === 'object') ? r.row_json : null;
      syn.order = r.order_submission_id ? (ordMap.get(String(r.order_submission_id)) || null) : null;
      // 시트 컬럼 편집(col:<헤더>) 오버레이 → 그리드 셀 합성용 {헤더: 값}. 앵커 게이트(ambiguous면 ov={}이라 자동 미적용).
      const ce = {}; for (const k in ov) { if (k.indexOf('col:') === 0) ce[k.slice(4)] = ov[k]; }
      syn.cellEdits = ce;
    }
    out.push(syn);
  }
  // orphan: 활성 오버레이 중 어떤 활성 행에도 안 붙은 것(카운트/타입만 — PII·원장ID 비노출)
  let orphanCount = 0; const orphanByType = {};
  for (const [k] of editMap) {
    if (consumed.has(k)) continue;
    orphanCount++; const t = k.split('\t')[0]; orphanByType[t] = (orphanByType[t] || 0) + 1;
  }
  const counts = {
    total: out.length,
    submitted: out.filter(r => r.submitted).length,
    paid: out.filter(r => r.paid).length,
    edited: showEdits ? out.filter(r => (r.editedFields || []).length).length : undefined,
    ambiguous: ambiguousCount, hidden: hiddenList.length,
  };
  const res = { role, maskPII, meta: meta[0] || {}, detail: wo[0] || null, counts, roster: out,
    sourceOfTruth: (meta[0] && meta[0].sourceOfTruth) || 'sheet' };   // 진실원천(cutover 상태) 표시용
  if (showEdits) { res.hiddenRows = hiddenList; res.orphanEdits = { count: orphanCount, byType: orphanByType }; res.headers = headers || []; }
  return res;
}

// 시트 컬럼(col:<헤더>) 편집 허용 검증 — 그리드 표시와 동일 소스로 "실재 컬럼"만 허용(임의 컬럼·인젝션 차단).
//   ★ 그리드 헤더와 정합: gid-우선 detected_headers → NULL이면 그 행 row_json 키 폴백(workdeskTab 헤더 산출과 동형).
//   client(in-tx)로 조회해 잠근 행 문맥과 일관. tabGid 없거나 동명탭이면 gid 우선, 그다음 tab_name.
async function _isTabColumn(client, sheetId, tabName, tabGid, colName, rowJson) {
  if (!colName) return false;
  const { rows } = await client.query(
    `SELECT detected_headers FROM raw_sheet_tabs
      WHERE sheet_id=$1 AND (($2::text IS NOT NULL AND tab_gid=$2) OR tab_name=$3)
      ORDER BY ($2::text IS NOT NULL AND tab_gid=$2) DESC LIMIT 1`,
    [sheetId, tabGid, tabName]).catch(() => ({ rows: [] }));
  const dh = rows[0] && rows[0].detected_headers;
  if (Array.isArray(dh) && dh.some(h => String(h == null ? '' : h).trim() === colName)) return true;
  return !!(rowJson && typeof rowJson === 'object' && Object.prototype.hasOwnProperty.call(rowJson, colName));
}

// ── 통합 작업대 편집(오버레이-only, 물리컬럼 무편집) ──
//   앵커: order_submission_id(불변 UUID) > manual(물리행 UUID, 재투영 면역) > identity_key(중복 아니면) > 거부.
//   단일 tx + 대상행 FOR UPDATE(동일행 직렬화) + revert(활성)→insert(신규, append-only 감사).
//   부분유니크 uq_participant_edits_active 가 cross-row 레이스 backstop(23505 → concurrent_edit_conflict).
//   field: 물리필드(_EDIT_FIELD_KIND) 또는 'col:<시트헤더>'(그 탭 실재 컬럼만, text 오버레이) — 물리컬럼 무접촉.
async function editWorkdeskRow({ sheetId, tabName, rowId, field, value, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId || !field) throw new Error('editWorkdeskRow: 필수 인자 누락');
  let kind = _EDIT_FIELD_KIND[field];
  const isCol = !kind && typeof field === 'string' && field.startsWith('col:');
  if (!kind && !isCol) return { ok: false, error: 'field_not_editable', field };
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: pr } = await client.query(
      `SELECT id, source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json, tab_gid
         FROM campaign_participants
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
    const row = pr[0];
    // col:<헤더> 는 잠근 행 문맥으로 실재 컬럼 검증(그리드 표시와 동일 소스). 미실재면 거부(표시=수락 정합).
    if (isCol) {
      if (!await _isTabColumn(client, sheetId, tabName, row.tab_gid, field.slice(4), row.row_json)) {
        await client.query('ROLLBACK'); return { ok: false, error: 'field_not_editable', field };
      }
      kind = 'text';
    }
    let anchorType, anchorValue;
    if (row.order_submission_id) { anchorType = 'order'; anchorValue = String(row.order_submission_id); }
    else if (row.source === 'manual') { anchorType = 'manual'; anchorValue = String(row.id); }
    else {
      let ik = row.identity_key;
      if (!ik) {
        ik = identityKey(_ikFromRow(row));
        if (ik) await client.query(`UPDATE campaign_participants SET identity_key=$2 WHERE id=$1 AND identity_key IS NULL`, [row.id, ik]);
      }
      if (!ik) { await client.query('ROLLBACK'); return { ok: false, error: 'no_stable_anchor' }; }
      const { rows: dup } = await client.query(
        `SELECT COUNT(*)::int AS n FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
            AND order_submission_id IS NULL AND source<>'manual' AND identity_key=$3`,
        [sheetId, tabName, ik]);
      if ((dup[0].n || 0) > 1) { await client.query('ROLLBACK'); return { ok: false, error: 'ambiguous_identity' }; }
      anchorType = 'identity'; anchorValue = ik;
    }
    let vBool = null, vText = null;
    if (kind === 'bool') vBool = (value === true || value === 'true' || value === 1 || value === '1');
    else vText = field === 'phone8' ? (_phone8(value) || '') : (value == null ? '' : String(value).slice(0, 2000));
    await client.query(
      `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
        WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type=$4 AND anchor_value=$5 AND field=$6 AND reverted_at IS NULL`,
      [String(by).slice(0, 100), sheetId, tabName, anchorType, anchorValue, field]);
    const ins = await client.query(
      `INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_bool, value_text, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [sheetId, tabName, anchorType, anchorValue, field, kind, vBool, vText, String(by).slice(0, 100)]);
    // 카운트 연동: col:리뷰제출/입금 편집 시 물리 토글(is_submitted/is_paid)도 같은 tx로 갱신(값 유무=완료여부).
    let linkedField = null;
    if (isCol) {
      linkedField = _linkedToggle(field.slice(4));
      if (linkedField) {
        const lb = (vText || '').trim() !== '';
        await client.query(
          `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
            WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type=$4 AND anchor_value=$5 AND field=$6 AND reverted_at IS NULL`,
          [String(by).slice(0, 100), sheetId, tabName, anchorType, anchorValue, linkedField]);
        await client.query(
          `INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_bool, value_text, created_by)
           VALUES ($1,$2,$3,$4,$5,'bool',$6,NULL,$7)`,
          [sheetId, tabName, anchorType, anchorValue, linkedField, lb, String(by).slice(0, 100)]);
      }
    }
    await client.query('COMMIT');
    return { ok: true, editId: ins.rows[0].id, anchorType, field, linkedField, value: kind === 'bool' ? vBool : vText };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (e && e.code === '23505') return { ok: false, error: 'concurrent_edit_conflict' };
    throw e;
  } finally { client.release(); }
}

// 편집 되돌리기(개별 행/필드) — 하드삭제 없이 reverted_at 마킹(감사 이력 보존).
async function revertWorkdeskEdit({ sheetId, tabName, rowId, field, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId || !field) throw new Error('revertWorkdeskEdit: 필수 인자 누락');
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: pr } = await client.query(
      `SELECT id, source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json
         FROM campaign_participants WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
    const a = _deriveAnchor(pr[0]);
    if (!a) { await client.query('ROLLBACK'); return { ok: false, error: 'no_stable_anchor' }; }
    let n = 0;
    const doRevert = async (f) => {
      const { rowCount } = await client.query(
        `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
          WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type=$4 AND anchor_value=$5 AND field=$6 AND reverted_at IS NULL`,
        [String(by).slice(0, 100), sheetId, tabName, a.type, a.value, f]);
      return rowCount;
    };
    const revertedPrimary = await doRevert(field); n += revertedPrimary;
    // 연동 되돌리기: col:리뷰제출/입금 을 되돌리면 링크된 물리 토글도 함께 되돌림.
    //   ★ primary 가 실제로 되돌렸을 때만 연쇄(독립적으로 토글한 is_submitted 를 무관한 revert 로 지우지 않게).
    const linked = field.indexOf('col:') === 0 ? _linkedToggle(field.slice(4)) : null;
    if (linked && revertedPrimary > 0) n += await doRevert(linked);
    await client.query('COMMIT');
    return { ok: true, reverted: n };
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
}

// 제거: manual 물리행=soft-delete(재투영 부활 없음), import행=hidden 오버레이(앵커 불변).
async function hideWorkdeskRow({ sheetId, tabName, rowId, by = 'admin' } = {}) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, source FROM campaign_participants WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL`,
    [rowId, sheetId, tabName]);
  if (!rows.length) return { ok: false, error: 'row_not_found' };
  if (rows[0].source === 'manual') {
    const { rowCount } = await db.query(
      `UPDATE campaign_participants SET deleted_at=NOW(), updated_at=NOW(), updated_by=$2 WHERE id=$1 AND deleted_at IS NULL`,
      [rowId, String(by).slice(0, 100)]);
    return { ok: true, mode: 'soft_delete', removed: rowCount };
  }
  const r = await editWorkdeskRow({ sheetId, tabName, rowId, field: '_hidden', value: true, by });
  return r.ok ? { ok: true, mode: 'overlay_hidden', editId: r.editId } : r;
}

// 추가: 앵커 대상 없음(신규 참여자) → source='manual' 물리행(오버레이 아님). participants가 seq 원자화.
async function addWorkdeskRow(args) { return participants.addParticipant(args); }

// ── 편집 이력(감사): 이 탭의 최근 편집(활성+되돌림)을 시각·편집자·필드·값·상태로. 앵커→참여자명 best-effort. ──
async function listEdits({ sheetId, tabName, limit = 200 } = {}) {
  if (!sheetId || !tabName) throw new Error('listEdits: sheetId, tabName 필수');
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const { rows } = await db.query(
    `SELECT pe.id, pe.field, pe.kind, pe.value_bool AS "valueBool", pe.value_text AS "valueText",
            pe.created_by AS "createdBy", pe.created_at AS "createdAt",
            pe.reverted_by AS "revertedBy", pe.reverted_at AS "revertedAt",
            (SELECT cp.reviewer_name FROM campaign_participants cp
               WHERE cp.sheet_id=pe.sheet_id AND cp.tab_name=pe.tab_name AND cp.deleted_at IS NULL AND cp.active=TRUE
                 AND ((pe.anchor_type='order' AND cp.order_submission_id::text=pe.anchor_value)
                   OR (pe.anchor_type='manual' AND cp.id::text=pe.anchor_value)
                   OR (pe.anchor_type='identity' AND cp.identity_key=pe.anchor_value)) LIMIT 1) AS name
       FROM participant_edits pe
      WHERE pe.sheet_id=$1 AND pe.tab_name=$2
      ORDER BY pe.created_at DESC LIMIT $3`,
    [sheetId, tabName, lim]);
  return rows.map(r => ({
    id: r.id, name: r.name || null,
    field: r.field === '_hidden' ? '(행 숨김)' : (r.field.indexOf('col:') === 0 ? r.field.slice(4) : r.field),
    value: r.kind === 'bool' ? (r.valueBool ? '완료/있음' : '해제/없음') : (r.valueText || ''),
    by: r.createdBy || '', at: r.createdAt,
    reverted: !!r.revertedAt, revertedBy: r.revertedBy || null, revertedAt: r.revertedAt,
  }));
}

// ══════════════════════════════════════════════════════════════════════════
// P2 (최소 출시 · 심판 확정): 상태 토글 write-back — cutover 탭의 is_submitted/is_paid 오버레이
//   편집만 시트의 리뷰제출/입금 상태칸에 반영. 그 외(이름/수취인/phone8/round/옵션/col:*·manual
//   추가/삭제)는 범위 밖(B 내부 유지) — 다음 red-blue-judge 단계.
//
// ★★ Track A 리스크 = 0 (구조로 보장, 리스트 방어 아님):
//   1) 격리: source_of_truth 재확인은 이 파일(회귀가드 ALLOWED)에서만. Track A 파일(syncQueue/
//      orderLedger/smartBuild/claimRow/rawMirror) 0줄 수정 — cron 스윕이 유일 구동자.
//   2) 컬럼 disjoint: order_append(mapOrderToSheetRow)는 상태칸(리뷰제출/입금)을 **절대 안 씀**.
//      write-back은 submit_col/submit_col2 **두 열에만** 쓴다(_buildToggleWrite가 물리적으로 강제)
//      → 같은 행 충돌·연락처/수취인/주소 오염·review_index.phone8(소유권키) 변조가 **불가능**.
//   3) blank-only: 사람/라이브가 채운 셀은 절대 클로버 안 함(비면 held). un-write 안 함.
//   4) 신원 재검증(rowIdentityMatches): 행 이동/재사용 시 mismatch=blocked(자가치유 재시도).
//   5) 저우선 throttle({priority:'low'}) + BUSY 양보: 주문 예약 8슬롯·라이브 시트작업 무굶김.
//   6) 멱등: _normSubmitCell no-op + status='written'(재픽업 안 함) → 핑퐁 0.
//   7) 이중 게이트: TRACK_B_WRITEBACK=1(글로벌) AND source_of_truth='db'(탭별). 기본 OFF=완전 inert.
// ══════════════════════════════════════════════════════════════════════════
function _wbColLetter(idx) { let s = '', i = idx; while (i >= 0) { s = String.fromCharCode((i % 26) + 65) + s; i = Math.floor(i / 26) - 1; } return s; }

// 상태 토글 쓰기 산출(순수·단위테스트 대상). ★ c1/c2(submit_col/submit_col2) 두 열 외 range 생성 불가.
//   want=false(해제)는 blank-only상 못 쓴다(현재 'O'면 conflict). cells는 minC..maxC 슬라이스.
function _buildToggleWrite({ tabName, headers, submitCol, submitCol2, wantSubmitted, wantPaid, cells, minC, sheetRow }) {
  const { _normSubmitCell, _wantMark } = require('./participantMirror.service');
  const c1 = submitCol ? headers.indexOf(submitCol) : -1;
  const c2 = submitCol2 ? headers.indexOf(submitCol2) : -1;
  const writeData = []; let conflict = false;
  for (const [col, want] of [[c1, wantSubmitted], [c2, wantPaid]]) {
    if (col < 0 || want == null) continue;
    const wantMark = _normSubmitCell(_wantMark(want));
    const cur = _normSubmitCell(cells[col - minC]);
    if (cur === wantMark) continue;                    // 멱등 no-op(이미 원하는 상태)
    if (cur === '') writeData.push({ range: `'${tabName}'!${_wbColLetter(col)}${sheetRow}`, values: [[_wantMark(want)]] });
    else conflict = true;                              // 사람/라이브가 채운 셀 → 클로버 금지(held)
  }
  return { writeData, conflict, c1, c2 };
}

// cutover 탭 1개의 미반영 상태 토글을 시트에 반영. 큐 없이 cron/수동이 직접 호출(멱등·재시도 안전).
async function executeWriteback({ sheetId, tabName } = {}) {
  if (process.env.TRACK_B_WRITEBACK !== '1') return { skipped: true, reason: 'gate_off' };
  if (!sheetId || !tabName) return { skipped: true, reason: 'missing_args' };
  if (await getSourceOfTruth({ sheetId, tabName }) !== 'db') return { skipped: true, reason: 'not_cutover' };
  const db = getPool();
  const { loadRawTabContext, rowIdentityMatches } = require('./orderLedger.service');
  const { readSheet, batchUpdateSheet, invalidateSheetMeta } = require('./sheets.service');
  const { throttledCall, getThrottleStatus } = require('../utils/sheetsThrottle');

  const { rows: edits } = await db.query(
    `SELECT id, anchor_type, anchor_value, field, value_bool FROM participant_edits
      WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL AND field IN ('is_submitted','is_paid')
        AND (writeback_status IS NULL OR writeback_status='blocked')`, [sheetId, tabName]);
  if (!edits.length) return { skipped: true, reason: 'no_pending', tabName };

  // import행만(manual 추가행은 범위 밖 = append 필요). 상태칸·신원 있는 행.
  const { rows: roster } = await db.query(
    `SELECT id, order_submission_id, identity_key, sheet_row, tab_gid, phone8, recipient_name,
            reviewer_name, round, option_text, submit_col, submit_col2
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
        AND source='import' AND sheet_row IS NOT NULL AND tab_gid IS NOT NULL`, [sheetId, tabName]);
  const byOrder = new Map(), byIdent = new Map(), identCount = new Map();
  for (const r of roster) {
    if (r.order_submission_id) byOrder.set(String(r.order_submission_id), r);
    const ik = r.identity_key || identityKey(_ikFromRow(r));
    if (ik) { identCount.set(ik, (identCount.get(ik) || 0) + 1); if (!byIdent.has(ik)) byIdent.set(ik, r); }
  }
  const markStatus = (id, st, sig) => db.query(
    `UPDATE participant_edits SET writeback_status=$2, writeback_at=NOW(), writeback_sig=COALESCE($3,writeback_sig) WHERE id=$1`,
    [id, st, sig || null]);

  const perRow = new Map();   // participant.id → { row, wantSubmitted, wantPaid, editIds }
  let blocked = 0;
  for (const e of edits) {
    let row = null;
    if (e.anchor_type === 'order') row = byOrder.get(e.anchor_value) || null;
    else if (e.anchor_type === 'identity' && (identCount.get(e.anchor_value) || 0) === 1) row = byIdent.get(e.anchor_value) || null;
    if (!row) { await markStatus(e.id, 'blocked'); blocked++; continue; }   // manual앵커/모호/미부착 → 자가치유
    if (!perRow.has(row.id)) perRow.set(row.id, { row, wantSubmitted: null, wantPaid: null, editIds: [] });
    const s = perRow.get(row.id);
    if (e.field === 'is_submitted') s.wantSubmitted = !!e.value_bool; else s.wantPaid = !!e.value_bool;
    s.editIds.push(e.id);
  }
  if (!perRow.size) return { tabName, written: 0, held: 0, blocked, deferred: 0 };

  const ctx = await loadRawTabContext(sheetId, roster[0].tab_gid, tabName);
  if (!ctx || !ctx.headers || !ctx.headers.length) return { skipped: true, reason: 'no_meta', tabName };
  const headers = ctx.headers;
  const BUSY = parseInt(process.env.TRACK_B_WRITEBACK_BUSY || '20', 10);
  let written = 0, held = 0, deferred = 0;

  for (const { row, wantSubmitted, wantPaid, editIds } of perRow.values()) {
    if (getThrottleStatus().requestsInLastMinute > BUSY) { deferred += editIds.length; continue; }   // 라이브 양보(멱등 재시도)
    const c1 = row.submit_col ? headers.indexOf(row.submit_col) : -1;
    const c2 = row.submit_col2 ? headers.indexOf(row.submit_col2) : -1;
    if (c1 < 0 && c2 < 0) { for (const id of editIds) await markStatus(id, 'blocked'); blocked += editIds.length; continue; }   // 헤더 드리프트
    if (!row.phone8 || !row.recipient_name) { for (const id of editIds) await markStatus(id, 'blocked'); blocked += editIds.length; continue; }
    let idy;
    try { idy = await rowIdentityMatches({ sheet_id: sheetId, sheet_row: row.sheet_row, tab_gid: row.tab_gid, tab_name: tabName, phone: row.phone8, recipient: row.recipient_name, address: null }, ctx); }
    catch (_) { deferred += editIds.length; continue; }
    if (!idy.match) { for (const id of editIds) await markStatus(id, 'blocked'); blocked += editIds.length; continue; }   // 행이동/재사용 차단
    const cols = [c1, c2].filter(c => c >= 0);
    const minC = Math.min(...cols), maxC = Math.max(...cols);
    invalidateSheetMeta(sheetId);
    const rng = `'${tabName}'!${_wbColLetter(minC)}${row.sheet_row}:${_wbColLetter(maxC)}${row.sheet_row}`;
    let cells;
    try { const rd = await throttledCall(() => readSheet(sheetId, rng, { gid: row.tab_gid }), 2, { priority: 'low' }); cells = (rd && rd[0]) || []; }
    catch (_) { deferred += editIds.length; continue; }
    const { writeData, conflict } = _buildToggleWrite({ tabName, headers, submitCol: row.submit_col, submitCol2: row.submit_col2, wantSubmitted, wantPaid, cells, minC, sheetRow: row.sheet_row });
    if (writeData.length) {
      try { await throttledCall(() => batchUpdateSheet(sheetId, writeData, 'RAW', { gid: row.tab_gid }), 2, { priority: 'low' }); }
      catch (_) { deferred += editIds.length; continue; }   // blank-only라 재시도 멱등
    }
    const sig = `s=${wantSubmitted == null ? '-' : (wantSubmitted ? 'O' : '')}|p=${wantPaid == null ? '-' : (wantPaid ? 'O' : '')}`;
    const st = conflict ? 'held' : 'written';
    for (const id of editIds) await markStatus(id, st, sig);
    if (conflict) held += editIds.length; else written += editIds.length;
  }
  return { tabName, written, held, blocked, deferred };
}

// cron/수동 진입점: cutover(source_of_truth='db') 탭 중 미반영 토글이 있는 탭만 순회.
//   락(trackb_writeback)은 호출측(cron/route)에서 감싼다 — 멀티인스턴스 이중 스윕 직렬화.
async function writebackSweep({ limit = 100 } = {}) {
  if (process.env.TRACK_B_WRITEBACK !== '1') return { skipped: true, reason: 'gate_off' };
  const db = getPool();
  const { rows: tabs } = await db.query(
    `SELECT DISTINCT pe.sheet_id AS "sheetId", pe.tab_name AS "tabName"
       FROM participant_edits pe JOIN tab_configs tc ON tc.sheet_id=pe.sheet_id AND tc.tab_name=pe.tab_name
      WHERE pe.reverted_at IS NULL AND pe.field IN ('is_submitted','is_paid')
        AND (pe.writeback_status IS NULL
             OR (pe.writeback_status='blocked' AND (pe.writeback_at IS NULL OR pe.writeback_at < NOW() - INTERVAL '30 minutes')))
        AND tc.source_of_truth='db'
      LIMIT $1`, [limit]);
  let done = 0, written = 0, held = 0, errors = 0;
  for (const t of tabs) {
    try { const r = await executeWriteback({ sheetId: t.sheetId, tabName: t.tabName }); done++; written += r.written || 0; held += r.held || 0; }
    catch (e) { errors++; logger.warn(`[trackB] writeback ${t.tabName} 실패: ${e.message}`); }
  }
  return { candidateTabs: tabs.length, done, written, held, errors };
}

async function writebackStatus() {
  const { rows } = await getPool().query(
    `SELECT COUNT(*) FILTER (WHERE writeback_status='held')::int AS held,
            COUNT(*) FILTER (WHERE writeback_status='blocked')::int AS blocked,
            COUNT(*) FILTER (WHERE writeback_status='written')::int AS written
       FROM participant_edits WHERE reverted_at IS NULL AND field IN ('is_submitted','is_paid')`);
  return rows[0] || { held: 0, blocked: 0, written: 0 };
}

// ══════════════════════════════════════════════════════════════════════════
// P2-2 (시뮬레이터 · 확장 write-back): 상태 토글 외 **필드편집(이름/수취인/전화/차수/옵션/col:*) +
//   manual 추가/삭제행**까지 "시트에 무엇을 쓸지" 플랜으로 산출. ★ 기본은 SIMULATE(시트 무접촉).
//   실제 적용은 **트리거** `TRACK_B_WRITEBACK_FULL=1` + cutover 이중게이트 뒤에서만(수동, 크론 미연결).
//   ★★ 격리: source_of_truth 판정은 이 파일에서만. 트리거 OFF면 applyWritebackFull은 즉시 반환(무접촉).
//   ⚠️ 소유권키/주문매핑 컬럼(연락처·수취인·주소·주문번호)·manual append/clear는 **위험군**으로 분류 —
//      시뮬레이션엔 뜨지만 실제 적용에서 제외(red-blue-judge 후 별도 단계). 안전군(차수/옵션/이름/토글/
//      col:비매핑)만 트리거 ON 시 blank-only + 신원 재검증으로 적용.
// ══════════════════════════════════════════════════════════════════════════
function _wbEditFieldCol(ol, headers, field) {
  if (field.indexOf('col:') === 0) return headers.indexOf(field.slice(4));
  const m = { recipient_name: 'recipient', phone8: 'phone', option_text: 'selected_opt_key' };
  if (m[field]) return ol._fieldToCol(headers, m[field]);
  const kw = { round: /차수|회차|round/i, reviewer_name: /참여자|리뷰어|닉네임|이름/ };
  if (kw[field]) { for (let i = 0; i < headers.length; i++) if (kw[field].test(String(headers[i] || ''))) return i; }
  return -1;
}
// 위험군: 소유권키(phone8/recipient) 또는 주문매핑 컬럼(연락처/수취인/주소/주문번호) — 실제 적용 제외.
function _wbIsRiskyField(field, header) {
  if (field === 'phone8' || field === 'recipient_name') return true;
  const h = field.indexOf('col:') === 0 ? field.slice(4) : (header || '');
  return /연락처|전화|핸드폰|휴대폰|phone|주소|address|수취인|받는분|주문번호|ordernum/i.test(h);
}

// 이 탭의 write-back 플랜 산출(순수 읽기·시트 무접촉): 활성 편집 + manual 행 → 시트 반영 계획.
async function _computeWritebackPlan(db, sheetId, tabName) {
  const ol = require('./orderLedger.service');
  const { rows: edits } = await db.query(
    `SELECT id, anchor_type, anchor_value, field, kind, value_bool, value_text
       FROM participant_edits WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL`, [sheetId, tabName]);
  const { rows: roster } = await db.query(
    `SELECT id, seq, reviewer_name, recipient_name, phone8, round, option_text, product_name,
            sheet_row, tab_gid, submit_col, submit_col2, source, order_submission_id, identity_key, deleted_at, active
       FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2`, [sheetId, tabName]);
  const byOrder = new Map(), byManual = new Map(), byIdent = new Map(), identCount = new Map();
  for (const r of roster) {
    if (r.deleted_at || !r.active) continue;
    byManual.set(String(r.id), r);
    if (r.order_submission_id) byOrder.set(String(r.order_submission_id), r);
    if (r.source !== 'manual') { const ik = r.identity_key || identityKey(_ikFromRow(r)); if (ik) { identCount.set(ik, (identCount.get(ik) || 0) + 1); if (!byIdent.has(ik)) byIdent.set(ik, r); } }
  }
  let headers = [];
  const gid = (roster.find(r => r.tab_gid) || {}).tab_gid || null;
  try { const ctx = await ol.loadRawTabContext(sheetId, gid, tabName); headers = (ctx && ctx.headers) || []; } catch (_) {}
  const resolve = (e) => {
    if (e.anchor_type === 'order') return byOrder.get(e.anchor_value) || null;
    if (e.anchor_type === 'manual') return byManual.get(e.anchor_value) || null;
    if (e.anchor_type === 'identity') return (identCount.get(e.anchor_value) || 0) > 1 ? { __ambiguous: true } : (byIdent.get(e.anchor_value) || null);
    return null;
  };
  const ops = []; const hiddenManual = new Set();
  for (const e of edits) {
    const row = resolve(e);
    if (e.field === '_hidden') { if (row && !row.__ambiguous && row.source === 'manual') hiddenManual.add(String(row.id)); continue; }
    const nv = e.kind === 'bool' ? (e.value_bool ? 'O' : '') : (e.value_text == null ? '' : e.value_text);
    if (!row) { ops.push({ editId: e.id, type: 'edit', field: e.field, newValue: nv, guard: 'no_anchor' }); continue; }
    if (row.__ambiguous) { ops.push({ editId: e.id, type: 'edit', field: e.field, newValue: nv, guard: 'ambiguous' }); continue; }
    const base = { editId: e.id, participantId: row.id, seq: row.seq, name: row.reviewer_name, sheetRow: row.sheet_row, field: e.field, newValue: nv };
    if (e.field === 'is_submitted' || e.field === 'is_paid') {
      const col = e.field === 'is_submitted' ? row.submit_col : row.submit_col2;
      const ci = col ? headers.indexOf(col) : -1;
      ops.push({ ...base, type: 'toggle', header: col || null, column: ci >= 0 ? ol.getColLetter(ci) : null, guard: !row.sheet_row ? 'no_sheet_row' : (ci < 0 ? 'no_column' : 'ok') });
    } else {
      const ci = _wbEditFieldCol(ol, headers, e.field);
      const header = ci >= 0 ? headers[ci] : null;
      let guard = 'ok';
      if (!row.sheet_row) guard = 'no_sheet_row'; else if (ci < 0) guard = 'no_column'; else if (_wbIsRiskyField(e.field, header)) guard = 'risky_ownership_key';
      ops.push({ ...base, type: 'edit', header, column: ci >= 0 ? ol.getColLetter(ci) : null, guard });
    }
  }
  for (const r of roster) {
    if (r.source !== 'manual') continue;
    if (r.deleted_at || hiddenManual.has(String(r.id))) {
      if (r.sheet_row) ops.push({ participantId: r.id, seq: r.seq, name: r.reviewer_name, sheetRow: r.sheet_row, type: 'clear', guard: 'risky_coords' });
    } else if (r.active) {
      ops.push({ participantId: r.id, seq: r.seq, name: r.reviewer_name, sheetRow: r.sheet_row || null, type: 'add', guard: 'risky_append',
        newValue: { reviewer: r.reviewer_name, recipient: r.recipient_name, option: r.option_text } });
    }
  }
  return { headers, ops, roster };
}

const _WB_BLOCKED = ['no_anchor', 'ambiguous', 'no_column', 'no_sheet_row'];
const _WB_RISKY = ['risky_ownership_key', 'risky_coords', 'risky_append'];

// 시뮬레이션(시트 무접촉): 무엇이 시트에 반영될지 플랜 + 요약. cutover/트리거 상태 동봉.
async function simulateWriteback({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('simulateWriteback: sheetId, tabName 필수');
  const db = getPool();
  const sot = await getSourceOfTruth({ sheetId, tabName });
  const { ops } = await _computeWritebackPlan(db, sheetId, tabName);
  const byType = {}; for (const o of ops) byType[o.type] = (byType[o.type] || 0) + 1;
  const summary = {
    total: ops.length,
    ok: ops.filter(o => o.guard === 'ok').length,
    risky: ops.filter(o => _WB_RISKY.includes(o.guard)).length,
    blocked: ops.filter(o => _WB_BLOCKED.includes(o.guard)).length,
    byType,
  };
  return { tabName, cutover: sot === 'db', triggerOn: process.env.TRACK_B_WRITEBACK_FULL === '1', mode: 'simulate', ops, summary };
}

// 실제 적용(트리거) — 기본 완전 inert. TRACK_B_WRITEBACK_FULL=1 + cutover 에서만 안전군(토글·비위험 필드편집)을
//   blank-only + 신원 재검증으로 반영. 위험군(소유권키/주문컬럼)·manual append/clear 는 제외(deferred).
//   ⚠️ 프로덕션 활성 전 red-blue-judge 로 apply 경로 검증 권장. 크론 미연결(수동 트리거만).
async function applyWritebackFull({ sheetId, tabName } = {}) {
  if (process.env.TRACK_B_WRITEBACK_FULL !== '1') return { skipped: true, reason: 'trigger_off' };   // ★ 시뮬레이션만
  if (!sheetId || !tabName) return { skipped: true, reason: 'missing_args' };
  if (await getSourceOfTruth({ sheetId, tabName }) !== 'db') return { skipped: true, reason: 'not_cutover' };
  const db = getPool();
  const ol = require('./orderLedger.service');
  const { readSheet, batchUpdateSheet, invalidateSheetMeta } = require('./sheets.service');
  const { throttledCall, getThrottleStatus } = require('../utils/sheetsThrottle');
  const { ops, roster } = await _computeWritebackPlan(db, sheetId, tabName);
  const rmap = new Map(roster.map(r => [String(r.id), r]));
  const ctx = await ol.loadRawTabContext(sheetId, (roster.find(r => r.tab_gid) || {}).tab_gid || null, tabName);
  if (!ctx || !ctx.headers || !ctx.headers.length) return { skipped: true, reason: 'no_meta' };
  const BUSY = parseInt(process.env.TRACK_B_WRITEBACK_BUSY || '20', 10);
  let written = 0, held = 0, blocked = 0, deferred = 0;
  for (const op of ops) {
    if (op.guard !== 'ok' || (op.type !== 'toggle' && op.type !== 'edit')) { deferred += 1; continue; }   // 위험군·manual = 시뮬만
    if (getThrottleStatus().requestsInLastMinute > BUSY) { deferred += 1; continue; }
    const row = rmap.get(String(op.participantId)); if (!row || !op.column) { blocked += 1; continue; }
    if (!row.phone8 || !row.recipient_name) { blocked += 1; continue; }
    let idy; try { idy = await ol.rowIdentityMatches({ sheet_id: sheetId, sheet_row: op.sheetRow, tab_gid: row.tab_gid, tab_name: tabName, phone: row.phone8, recipient: row.recipient_name, address: null }, ctx); }
    catch (_) { deferred += 1; continue; }
    if (!idy.match) { blocked += 1; continue; }
    const rng = `'${tabName}'!${op.column}${op.sheetRow}:${op.column}${op.sheetRow}`;
    invalidateSheetMeta(sheetId);
    let cur; try { const rd = await throttledCall(() => readSheet(sheetId, rng, { gid: row.tab_gid }), 2, { priority: 'low' }); cur = String((rd && rd[0] && rd[0][0]) || '').trim(); }
    catch (_) { deferred += 1; continue; }
    const want = String(op.newValue == null ? '' : op.newValue).trim();
    if (cur === want) { written += 0; continue; }                 // 멱등
    if (cur !== '') { held += 1; continue; }                       // blank-only: 사람/기존값 보호
    if (want === '') continue;                                     // 빈값 쓰기 없음
    try { await throttledCall(() => batchUpdateSheet(sheetId, [{ range: rng, values: [[want]] }], 'RAW', { gid: row.tab_gid }), 2, { priority: 'low' }); written += 1; }
    catch (_) { deferred += 1; }
  }
  return { applied: true, written, held, blocked, deferred };
}

module.exports = {
  identityKey,
  classifyParity,
  projectTab,
  projectActive,
  parityReport,
  parityAll,
  parityTrend,
  setOwnership,
  removeOwnership,
  listOwnership,
  listAdvertisersWithOwnership,
  listWorkOrders,
  linkWorkOrder,
  unlinkWorkOrder,
  prepareRosterFromWorkOrder,
  scopedTabsForAdvertiser,
  scopedTabsForStaff,
  scopedActiveTabs,
  canAccessTab,
  overview,
  getSourceOfTruth,
  setSourceOfTruth,
  executeWriteback,
  writebackSweep,
  writebackStatus,
  _buildToggleWrite,
  simulateWriteback,
  applyWritebackFull,
  workdeskTab,
  editWorkdeskRow,
  revertWorkdeskEdit,
  hideWorkdeskRow,
  addWorkdeskRow,
  listEdits,
  __setPoolForTest,
};
