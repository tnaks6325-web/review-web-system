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
  const editedAnchors = new Set(edRows.map(e => e.anchor_type + '\u0000' + e.anchor_value));
  const editedKeys = new Set();
  if (editedAnchors.size) {
    for (const b of bRows) {
      const a = _deriveAnchor(b);
      if (a && editedAnchors.has(a.type + '\u0000' + a.value)) { const p8 = _phone8(b.phone8); if (p8) editedKeys.add(p8); }
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
    `SELECT a.id, a.name, a.status, a.inad_pm AS "inadPm",
            (SELECT COUNT(*) FROM advertiser_campaigns ac
              WHERE ac.advertiser_id = a.id AND ac.deleted_at IS NULL)::int AS owned,
            COALESCE(p.settlement_visible, TRUE) AS "settlementVisible"
       FROM advertisers a
       LEFT JOIN trackb_advertiser_prefs p ON p.advertiser_id = a.id
      WHERE a.status <> 'ended'
      ORDER BY a.sort_order ASC, a.name ASC`);
  return rows;
}

// ── 담당 AE(inad_pm) 매칭 — master/admin 전용(라우트 게이트). 빈 값 = 담당 해제. ──
//   inad_pm 은 staff 스코프 키(TRIM 매칭)라 앞뒤 공백을 제거해 저장(표기차 footgun 방지).
async function setAdvertiserInadPm({ advertiserId, inadPm = '', by = '' } = {}) {
  if (!advertiserId) return { ok: false, code: 400, error: 'advertiserId 필수' };
  const pm = ((typeof inadPm === 'string' ? inadPm : '')).trim().slice(0, 100);
  const { rows } = await getPool().query(
    'UPDATE advertisers SET inad_pm = $2 WHERE id = $1 RETURNING id, name, inad_pm AS "inadPm"', [advertiserId, pm]);
  if (!rows.length) return { ok: false, code: 404, error: '거래처를 찾을 수 없습니다.' };
  logger.info(`[trackB] 담당AE 매칭: ${rows[0].name}(${advertiserId}) → '${pm || '(해제)'}' by ${by}`);
  return { ok: true, advertiser: rows[0] };
}

// ── 업체(거래처) 삭제 = 소프트 삭제(status='ended') + Track B 소유 매핑 소프트 해제. master/admin 전용(라우트 게이트).
//   advertisers 는 포털과 공유하는 거래처 원장이라 하드삭제 금지 — 'ended'는 목록 필터(status<>'ended')가
//   이미 숨김으로 취급하는 설계된 상태(가역: DB에서 status='active' 로 복구 가능). 소유 매핑도 함께 해제해
//   sheetAssignableByStaff/카운트 등에 잔재가 남지 않게 한다. (Track A·시트 무접촉 — Track B 내부만.)
async function deleteAdvertiser({ advertiserId, by = '' } = {}) {
  if (!advertiserId) return { ok: false, code: 400, error: 'advertiserId 필수' };
  const db = getPool();
  const { rows } = await db.query(
    `UPDATE advertisers SET status = 'ended' WHERE id = $1 AND status <> 'ended' RETURNING id, name`, [advertiserId]);
  if (!rows.length) return { ok: false, code: 404, error: '거래처를 찾을 수 없습니다(이미 삭제되었을 수 있음).' };
  const own = await db.query(
    `UPDATE advertiser_campaigns SET deleted_at = NOW() WHERE advertiser_id = $1 AND deleted_at IS NULL`, [advertiserId]);
  logger.info(`[trackB] 업체 삭제(soft): ${rows[0].name}(${advertiserId}) 소유해제 ${own.rowCount || 0}건 by ${by}`);
  return { ok: true, data: { id: rows[0].id, name: rows[0].name, ownershipsReleased: own.rowCount || 0 } };
}

// ── Track B 스코프 업체(거래처) 생성 — workdesk 업체추가 전용(포털 라우트와 동일 시맨틱·테이블).
//    staff(AE)는 inad_pm 을 자기 로그인명으로 강제(타 AE 명의 생성 차단) — 생성 즉시 자기 스코프에 들어옴.
async function createAdvertiserScoped({ name, inadPm = '', role = 'admin', byName = '', _verify = isRegisteredIntranetAdvertiser } = {}) {
  const nm = String(name || '').trim();
  if (!nm) return { ok: false, code: 400, error: '거래처명을 입력하세요.' };
  const pm = role === 'staff' ? String(byName || '').trim() : String(inadPm || '').trim();
  if (role === 'staff' && !pm) return { ok: false, code: 400, error: '로그인 정보에 담당자명이 없습니다.' };
  // ★ 거래처정보(인트라넷 광고주DB) 등록 검증 — 미등록/오타 광고주 유입 차단.
  //   인트라넷 도달 불가(unreachable)면 fail-closed(503) — 검증 못 한 채 유입시키지 않음(등록은 저빈도 작업이라 감내 가능).
  const chk = await _verify(nm);
  if (!chk || !chk.ok) return { ok: false, code: 503, error: '인트라넷 광고주DB를 확인할 수 없어 등록할 수 없습니다. 잠시 후 다시 시도하세요.' };
  if (!chk.registered) return { ok: false, code: 422, error: '거래처정보(인트라넷 광고주DB)에 등록되지 않은 광고주입니다. 인트라넷 거래처 관리에 먼저 등록 후 이용하세요.' };
  const db = getPool();
  const dup = await db.query('SELECT 1 FROM advertisers WHERE name = $1', [nm]);
  if (dup.rows.length > 0) return { ok: false, code: 409, error: '이미 존재하는 거래처명입니다.' };
  const id = 'adv_' + require('crypto').randomBytes(6).toString('hex');
  try {
    const { rows } = await db.query(
      `INSERT INTO advertisers (id, name, status, inad_pm, contact, memo, sort_order)
       VALUES ($1,$2,'active',$3,'','',0) RETURNING *`, [id, nm, pm]);
    return { ok: true, data: rows[0] };
  } catch (e) {
    if (e && e.code === '23505') return { ok: false, code: 409, error: '이미 존재하는 거래처명입니다.' };   // 동시 생성 레이스(UNIQUE 백스톱)
    throw e;
  }
}

// ── staff(AE) 소유권 게이트: 해당 업체의 담당(inad_pm)이 본인인 경우만 소유 지정/해제 허용. ──
async function staffOwnsAdvertiser({ advertiserId, staffName } = {}) {
  if (!advertiserId || !String(staffName || '').trim()) return false;
  const { rows } = await getPool().query('SELECT inad_pm FROM advertisers WHERE id = $1', [advertiserId]);
  return rows.length > 0 && String(rows[0].inad_pm || '').trim() === String(staffName).trim();
}

// ── staff 초기매핑 시트 게이트: 시트가 무소유(전 업체)거나 기존 소유가 전부 자기 담당 업체일 때만
//    staff가 새 소유를 지정할 수 있다 — 타 AE/업체가 이미 소유한 시트로의 자가 스코프 확장 차단.
//    (초기매핑=주인 없는 시트에 첫 매핑. 이미 매핑된 시트의 재배치는 admin/master 소관.) ──
async function sheetAssignableByStaff({ sheetId, staffName } = {}) {
  if (!sheetId || !String(staffName || '').trim()) return false;
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS others
       FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
      WHERE ac.sheet_id = $1 AND ac.deleted_at IS NULL
        AND TRIM(COALESCE(a.inad_pm, '')) <> TRIM($2)`, [sheetId, String(staffName).trim()]);
  return rows.length > 0 && Number(rows[0].others) === 0;
}

// ── 업체 소유 시트의 전체 탭 나열(소유지정 상세 패널): 시트전체 소유=그 시트 모든 탭, 탭지정 소유=그 탭만.
//    정렬 = "생성 최신순" 근사: 시스템에 탭 생성시각 원천이 없어 MIN(campaign_participants.first_seen_at)
//    (재투영에도 보존되는 최초 관측시각) 우선, 미투영 탭은 raw_sheet_tabs.mirrored_at 폴백.
async function ownedTabsForAdvertiser({ advertiserId } = {}) {
  if (!advertiserId) throw new Error('ownedTabsForAdvertiser: advertiserId 필수');
  const db = getPool();
  const { rows } = await db.query(
    `WITH own AS (
       SELECT sheet_id, tab_gid FROM advertiser_campaigns
        WHERE advertiser_id = $1 AND deleted_at IS NULL
     ), tabs AS (
       SELECT DISTINCT ON (rst.sheet_id, rst.tab_gid)
              rst.sheet_id, rst.spreadsheet_title, rst.tab_gid, rst.tab_name, rst.row_count, rst.mirrored_at
         FROM raw_sheet_tabs rst
         JOIN own o ON o.sheet_id = rst.sheet_id AND (o.tab_gid IS NULL OR o.tab_gid = rst.tab_gid)
        WHERE rst.is_system_tab = FALSE
        ORDER BY rst.sheet_id, rst.tab_gid, rst.mirrored_at DESC
     )
     SELECT t.sheet_id AS "sheetId", t.spreadsheet_title AS "spreadsheetTitle", t.tab_gid AS "tabGid",
            t.tab_name AS "tabName", t.row_count AS "rowCount", cnt.first_seen AS "firstSeenAt",
            cnt.total AS "bTotal", cnt.submitted AS "bSub", cnt.paid AS "bPaid",
            tc.manager, wo.recruit_count AS "woRecruit",
            sl.sales_id AS "salesId", sl.contract_number AS "contractNumber",
            co.closed_date AS "closeoutDate", co.row_count AS "closeoutRows", co.sub_count AS "closeoutSubs",
            tm.memo,
            EXISTS (SELECT 1 FROM index_master im WHERE im.status = 'active' AND im.sheet_id = t.sheet_id
                      AND (im.tab_gid = t.tab_gid OR im.tab_name = t.tab_name)) AS "active"
       FROM tabs t
       LEFT JOIN LATERAL (
         SELECT MIN(cp.first_seen_at) AS first_seen,
                COUNT(*) FILTER (WHERE cp.active AND cp.deleted_at IS NULL)::int AS total,
                COUNT(*) FILTER (WHERE cp.active AND cp.deleted_at IS NULL AND cp.is_submitted)::int AS submitted,
                COUNT(*) FILTER (WHERE cp.active AND cp.deleted_at IS NULL AND cp.is_paid)::int AS paid
           FROM campaign_participants cp
          WHERE cp.sheet_id = t.sheet_id AND (cp.tab_gid = t.tab_gid OR cp.tab_name = t.tab_name)
       ) cnt ON TRUE
       LEFT JOIN tab_configs tc ON tc.sheet_id = t.sheet_id AND tc.tab_name = t.tab_name
       LEFT JOIN LATERAL (
         SELECT w.recruit_count FROM trackb_work_order_links l JOIN work_orders w ON w.id = l.work_order_id
          WHERE l.sheet_id = t.sheet_id AND l.tab_name = t.tab_name AND l.deleted_at IS NULL
          ORDER BY l.created_at DESC LIMIT 1
       ) wo ON TRUE
       LEFT JOIN LATERAL (
         SELECT s.sales_id, s.contract_number FROM trackb_settlement_links s
          WHERE s.sheet_id = t.sheet_id AND s.tab_name = t.tab_name AND s.deleted_at IS NULL
          ORDER BY s.created_at DESC LIMIT 1
       ) sl ON TRUE
       LEFT JOIN LATERAL (
         SELECT c.closed_date::text AS closed_date, c.row_count, c.sub_count FROM trackb_tab_closeouts c
          WHERE c.sheet_id = t.sheet_id AND c.tab_name = t.tab_name AND c.deleted_at IS NULL
          ORDER BY c.created_at DESC, c.id DESC LIMIT 1
       ) co ON TRUE
       LEFT JOIN trackb_tab_memos tm ON tm.sheet_id = t.sheet_id AND tm.tab_name = t.tab_name
      ORDER BY COALESCE(cnt.first_seen, t.mirrored_at) DESC NULLS LAST, t.tab_name DESC`, [advertiserId]);
  return rows;
}

// ══ 인트라넷(inadd-webapp, Cloudflare D1) 광고주DB 자동완성 프록시 ══
//   workdesk 업체(거래처) 추가 폼의 거래처명 자동완성용. 브라우저는 인트라넷을 직접 안 보고
//   이 서버 프록시(adminOrMaster 게이트)만 호출 — 응답은 이름·담당자만 추려 반환(급여·근태 등
//   인트라넷 타 테이블·민감 필드 미노출). 60초 캐시로 인트라넷 부하 최소화. 실패=빈 목록(fail-soft).
//   env: INTRANET_API_BASE (기본 https://inadd-system.pages.dev)
let _intraAdvCache = { at: 0, rows: null };
async function intranetAdvertisers({ q = '', limit = 20 } = {}) {
  const base = (process.env.INTRANET_API_BASE || 'https://inadd-system.pages.dev').trim().replace(/\/$/, '');
  const now = Date.now();
  if (!_intraAdvCache.rows || now - _intraAdvCache.at > 60 * 1000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(`${base}/api/tables/advertisers?limit=2000&sort=business_name&order=ASC`, { signal: ctrl.signal, headers: _intranetHeaders() });
      if (!resp.ok) throw new Error(`intranet HTTP ${resp.status}`);
      const j = await resp.json();
      // 실데이터 확인: 거래처명은 business_name(사업자명, 인트라넷 UI 필수 필드) — company_name 은 레거시(전량 공란).
      //   자동완성 표시용으로 대표자명(ceo_name)·사업자등록번호(business_number)도 함께 추림(민감 아님 = 사업자 공개정보).
      _intraAdvCache = { at: now, rows: (j.data || []).map(r => ({
        intranetId: r.id, name: String(r.business_name || r.company_name || '').trim(), manager: String(r.manager || '').trim() || null,
        ceo: String(r.ceo_name || '').trim() || null, bizNo: String(r.business_number || '').trim() || null,
      })).filter(r => r.name) };
    } catch (e) {
      logger.warn(`[trackB] 인트라넷 광고주DB 조회 실패: ${e.message}`);
      if (!_intraAdvCache.rows) return { ok: false, error: 'intranet_unreachable', items: [] };
      // stale 캐시라도 있으면 그걸로 응답(자동완성 연속성)
    } finally { clearTimeout(timer); }
  }
  const needle = String(q || '').trim().toLowerCase();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const items = (_intraAdvCache.rows || [])
    .filter(r => !needle || r.name.toLowerCase().includes(needle))
    .slice(0, lim);
  return { ok: true, items };
}

// ── 거래처 등록 검증: 인트라넷 광고주DB(business_name)에 "정확히" 존재하는 이름만 Track B 업체로 등록 허용.
//   부분일치 유입 방지 위해 정확일치(공백제거·대소문 무시). 인트라넷 도달 불가면 unreachable=true(상위 fail-closed).
async function isRegisteredIntranetAdvertiser(name) {
  const nm = String(name || '').trim().toLowerCase();
  if (!nm) return { ok: true, registered: false };
  const r = await intranetAdvertisers({ q: name, limit: 50 });
  if (!r || !r.ok) return { ok: false, unreachable: true };
  const registered = (r.items || []).some(it => String(it.name || '').trim().toLowerCase() === nm);
  return { ok: true, registered };
}

// ══ 인트라넷 사용자(AE) 자동완성 프록시 ══ 담당AE(inad_pm) 매칭용. 스코프 키인 display_name +
//   username·부서만 추려 반환 — 인트라넷 users 의 비밀번호·생일 등 민감필드는 매핑에서 즉시 폐기(미노출).
//   60초 캐시·5초 타임아웃·fail-soft(stale 캐시 유지). 소비 라우트는 adminOrMaster 로 제한할 것.
let _intraUserCache = { at: 0, rows: null };
async function intranetStaffUsers({ q = '', limit = 20, dept = '' } = {}) {
  const now = Date.now();
  if (!_intraUserCache.rows || now - _intraUserCache.at > 60 * 1000) {
    try {
      const j = await _intranetGet('/api/tables/users?limit=500&sort=display_name&order=ASC');
      _intraUserCache = { at: now, rows: (j.data || []).map(r => ({
        name: String(r.display_name || '').trim(),
        username: String(r.username || '').trim(),
        department: String(r.department || '').trim() || null,
      })).filter(r => r.name) };
    } catch (e) {
      logger.warn(`[trackB] 인트라넷 사용자(AE) 조회 실패: ${e.message}`);
      if (!_intraUserCache.rows) return { ok: false, error: 'intranet_unreachable', items: [] };
    }
  }
  const needle = String(q || '').trim().toLowerCase();
  const deptF = String(dept || '').trim().toLowerCase();   // 부서 정확일치 필터(예: 'AE') — 담당AE 후보를 해당 부서로 제한
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const items = (_intraUserCache.rows || [])
    .filter(r => !deptF || String(r.department || '').trim().toLowerCase() === deptF)
    .filter(r => !needle || r.name.toLowerCase().includes(needle) || r.username.toLowerCase().includes(needle))
    .slice(0, lim);
  return { ok: true, items };
}

// ══════════════════════════════════════════════════════════════════════════
// P2 — 정산 파이프라인(탭 ↔ 인트라넷 계약/견적 링크 + 프록시 스텝퍼, migration 054)
//   ★ 격리: 인트라넷 D1 무접촉(HTTP GET 프록시만). 링크는 리뷰 PG(trackb_settlement_links)에만 write.
//   ★ Q4-c(금액 광고주 노출): settlementForTab 역할 렌즈 — 광고주는 trackb_advertiser_prefs.settlement_visible
//     TRUE(기본)일 때만, 그리고 "그 탭에 링크된 sales" 단건만 프록시(타 업체 계약 도달 불가).
// ══════════════════════════════════════════════════════════════════════════
function _intranetBase() { return (process.env.INTRANET_API_BASE || 'https://inadd-system.pages.dev').trim().replace(/\/$/, ''); }
// 서버간 인증 헤더: 인트라넷 API 가드(INADD_SESSION_SECRET 활성 시) 통과용 X-Api-Key.
//   INTRANET_API_KEY 미설정이면 헤더 미전송(가드 활성 전까지 기존 동작 그대로 — 단계적 롤아웃).
function _intranetHeaders() {
  const k = (process.env.INTRANET_API_KEY || '').trim();
  return k ? { 'X-Api-Key': k } : {};
}
async function _intranetGet(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(`${_intranetBase()}${path}`, { signal: ctrl.signal, headers: _intranetHeaders() });
    if (!resp.ok) throw new Error(`intranet HTTP ${resp.status}`);
    return await resp.json();
  } finally { clearTimeout(timer); }
}

// 계약 검색(링크 UI). C-번호/업체명/작업명 — 인트라넷 범용 테이블 검색 프록시. 이름·상태·금액만 추림.
let _intraSalesCache = { at: 0, q: null, rows: null };
async function intranetSalesSearch({ q = '', limit = 30 } = {}) {
  const needle = String(q || '').trim();
  const now = Date.now();
  if (_intraSalesCache.q !== needle || !_intraSalesCache.rows || now - _intraSalesCache.at > 30 * 1000) {
    try {
      const j = await _intranetGet(`/api/tables/sales?search=${encodeURIComponent(needle)}&limit=50&sort=created_at&order=DESC`);
      _intraSalesCache = { at: now, q: needle, rows: (j.data || []).map(_mapSales) };
    } catch (e) {
      logger.warn(`[trackB] 인트라넷 계약(sales) 조회 실패: ${e.message}`);
      return { ok: false, error: 'intranet_unreachable', items: [] };
    }
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 50);
  return { ok: true, items: (_intraSalesCache.rows || []).slice(0, lim) };
}
function _mapSales(r) {
  return {
    salesId: r.id, contractNumber: String(r.contract_number || '').trim(),
    advertiserName: String(r.advertiser_name || '').trim(), productName: String(r.product_name || '').trim(),
    manager: String(r.manager || '').trim() || null, amount: Number(r.amount) || 0,
    paymentStatus: r.payment_status || 'unpaid', invoiceStatus: r.invoice_status || 'not_issued',
    paymentDate: r.payment_date || null, invoiceDate: r.invoice_date || null,
    // 입금매칭(인트라넷 계약관리 sales_bank_matches 의 집계 파생값): 누적 입금액 + 최근 입금일
    paidAmount: Number(r.matched_bank_amount) || 0, paidDate: r.matched_bank_date || null,
  };
}

// 탭 ↔ 계약/견적 링크(탭당 활성 1, 소프트삭제 교체). trackb_settlement_links 만 write(인트라넷 무접촉).
//   Nit4: UPDATE+INSERT 를 단일 tx 로(동시 링크 유니크충돌·중간실패 시 무링크 방지).
//   S1: 링크된 계약의 업체명을 로그로 남겨 오링크(타 업체 계약을 남의 탭에 연결) 사후추적 — advertiserName 반환.
async function linkSettlement({ sheetId, tabName, salesId, quoteId = null, by = '' } = {}) {
  if (!sheetId || !tabName || !salesId) return { ok: false, code: 400, error: 'sheetId, tabName, salesId 필수' };
  let contractNumber = '', advertiserName = '';
  try { const j = await _intranetGet(`/api/tables/sales/${encodeURIComponent(salesId)}`); contractNumber = String((j.data && j.data.contract_number) || '').trim(); advertiserName = String((j.data && j.data.advertiser_name) || '').trim(); } catch (_) {}
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE trackb_settlement_links SET deleted_at=NOW() WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL', [sheetId, tabName]);
    await client.query(
      `INSERT INTO trackb_settlement_links (sheet_id, tab_name, sales_id, quote_id, contract_number, linked_by)
       VALUES ($1,$2,$3,$4,$5,$6)`, [sheetId, tabName, salesId, quoteId || null, contractNumber, String(by || '').slice(0, 100)]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
  logger.info(`[trackB] 정산 링크: ${sheetId}/${tabName} → 계약 ${contractNumber || salesId}(업체:${advertiserName || '?'}) by ${by}`);
  return { ok: true, contractNumber, advertiserName };
}
async function unlinkSettlement({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) return { ok: false, code: 400, error: 'sheetId, tabName 필수' };
  const { rowCount } = await getPool().query(
    'UPDATE trackb_settlement_links SET deleted_at=NOW() WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL', [sheetId, tabName]);
  return { ok: true, removed: rowCount };
}

// 광고주 정산 노출 토글(master/admin). 기본 TRUE.
async function setSettlementVisible({ advertiserId, visible, by = '' } = {}) {
  if (!advertiserId) return { ok: false, code: 400, error: 'advertiserId 필수' };
  await getPool().query(
    `INSERT INTO trackb_advertiser_prefs (advertiser_id, settlement_visible, updated_by, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (advertiser_id) DO UPDATE SET settlement_visible=$2, updated_by=$3, updated_at=NOW()`,
    [advertiserId, !!visible, String(by || '').slice(0, 100)]);
  return { ok: true, visible: !!visible };
}
async function _settlementVisibleFor(advertiserId) {
  if (!advertiserId) return true;
  const { rows } = await getPool().query('SELECT settlement_visible FROM trackb_advertiser_prefs WHERE advertiser_id=$1', [advertiserId]);
  return rows.length ? rows[0].settlement_visible !== false : true;   // 행 없음 = 기본 노출
}
function settlementVisibleFor(advertiserId) { return _settlementVisibleFor(advertiserId); }   // 라우트용 경량 게이트(N-2)

// Nit6: sales 단건 프록시 20초 캐시(salesId별) — 광고주 페이지 렌더마다 인트라넷 왕복 방지.
const _salesByIdCache = new Map();   // salesId → { at, sales }
async function _salesById(salesId) {
  const now = Date.now(); const c = _salesByIdCache.get(salesId);
  if (c && now - c.at < 20 * 1000) return c.sales;
  try {
    const j = await _intranetGet(`/api/tables/sales/${encodeURIComponent(salesId)}`);
    const sales = j.data ? _mapSales(j.data) : null;
    _salesByIdCache.set(salesId, { at: now, sales });
    return sales;
  } catch (_) { return c ? c.sales : null; }   // stale 있으면 유지, 없으면 null
}
// S2: 견적서는 sales_id 로 quotes 를 역파생(quotes.sales_id, 화이트리스트 테이블) — 별도 quote 링크 불필요.
//   20초 캐시(salesId별) — 정산 요약 배치·스텝퍼 연속 렌더의 인트라넷 왕복 방지(_salesById 와 동일 시맨틱).
const _quoteCache = new Map();   // salesId → { at, quote }
async function _quoteForSales(salesId) {
  const now = Date.now(); const c = _quoteCache.get(salesId);
  if (c && now - c.at < 20 * 1000) return c.quote;
  try {
    const j = await _intranetGet(`/api/tables/quotes?where=sales_id=${encodeURIComponent(salesId)}&limit=1`);
    const q = (j.data || [])[0];
    const quote = q ? { quoteNumber: String(q.quote_number || '').trim(), status: q.status || 'draft', quoteDate: q.quote_date || null, totalAmount: Number(q.total_amount) || 0 } : null;
    _quoteCache.set(salesId, { at: now, quote });
    return quote;
  } catch (_) { return c ? c.quote : null; }   // stale 있으면 유지, 없으면 null
}

// 탭 정산 스텝퍼(마감자료→견적서→계산서→선금/잔금). 링크 조회 → 인트라넷 프록시 병합 → 역할 렌즈.
//   광고주(Q4-c): settlement_visible=FALSE 면 {hidden:true}(금액·상태 미포함). TRUE 면 금액 포함 전체.
async function settlementForTab({ sheetId, tabName, role = 'master', advertiserId = null } = {}) {
  if (!sheetId || !tabName) throw new Error('settlementForTab: sheetId, tabName 필수');
  const db = getPool();
  const { rows } = await db.query(
    `SELECT sales_id AS "salesId", quote_id AS "quoteId", contract_number AS "contractNumber", linked_by AS "linkedBy"
       FROM trackb_settlement_links WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL LIMIT 1`, [sheetId, tabName]);
  const link = rows[0] || null;
  const isAdv = role === 'advertiser';
  // 광고주 노출 게이트(Q4-c 안전장치): 토글 OFF 면 정산 자체 비공개.
  if (isAdv && !(await _settlementVisibleFor(advertiserId))) {
    return { linked: !!link, hidden: true };
  }
  // S3: 마감자료(①)는 P3(migration 055) 도착 전까지 데이터 원천 없음 — 준비중으로 표기(오해 방지).
  const closeoutAvailable = typeof latestCloseout === 'function';
  const closeout = closeoutAvailable ? await latestCloseout({ sheetId, tabName }) : null;
  if (!link) return { linked: false, closeout, closeoutAvailable };
  // 링크된 sales 단건만 프록시(그 탭에 링크된 계약만 — 타 업체 계약 도달 불가). 견적은 sales_id 로 역파생.
  const sales = link.salesId ? await _salesById(link.salesId) : null;
  const quote = link.salesId ? await _quoteForSales(link.salesId) : null;
  const contractNumber = (sales && sales.contractNumber) || link.contractNumber || '';
  return {
    linked: true, contractNumber, salesId: link.salesId,
    // Nit5: 광고주에겐 내부 정보(linkedBy·담당자) 미노출.
    linkedBy: isAdv ? undefined : link.linkedBy,
    proxyDown: link.salesId && !sales,   // 프록시 실패(라벨만) 신호
    closeout, closeoutAvailable,
    quote: quote || null,
    invoice: sales ? { status: sales.invoiceStatus, date: sales.invoiceDate } : null,
    payment: sales ? { status: sales.paymentStatus, date: sales.paymentDate } : null,
    amount: sales ? sales.amount : null,
    salesInfo: sales ? { advertiserName: sales.advertiserName, productName: sales.productName, manager: isAdv ? undefined : sales.manager } : null,
  };
}

// ── 소유지정 연결탭 정산 요약(관제실 컬럼: 견적서일·계산서일·입금액/총비용·입금일) — 내부 전용 배치. ──
//   링크된 탭만 인트라넷 프록시(정산 링크 없는 탭은 프록시 0회). 같은 sales 를 공유하는 탭은 1회만 조회
//   (_salesById/_quoteForSales 20초 캐시 공유). fail-soft: sales 조회 실패 = proxyDown 표기(스로우 금지).
//   ★ 광고주 렌즈 없음 — 이 함수의 소비 라우트는 internalMiddleware(master/admin/staff)로 제한할 것.
async function settlementSummaryForAdvertiser({ advertiserId } = {}) {
  if (!advertiserId) throw new Error('settlementSummaryForAdvertiser: advertiserId 필수');
  const tabs = await ownedTabsForAdvertiser({ advertiserId });
  const linked = tabs.filter(t => t.salesId);
  const bySales = new Map();
  for (const t of linked) if (!bySales.has(t.salesId)) bySales.set(t.salesId, null);
  await Promise.all([...bySales.keys()].map(async (sid) => {
    const [sales, quote] = await Promise.all([_salesById(sid), _quoteForSales(sid)]);
    bySales.set(sid, { sales, quote });
  }));
  return linked.map(t => {
    const { sales = null, quote = null } = bySales.get(t.salesId) || {};
    const quoteAmount = quote && quote.totalAmount > 0 ? quote.totalAmount : null;
    const contractAmount = sales && sales.amount > 0 ? sales.amount : null;
    return {
      sheetId: t.sheetId, tabName: t.tabName, salesId: t.salesId,
      contractNumber: t.contractNumber || (sales && sales.contractNumber) || '',
      proxyDown: !sales,
      quoteDate: quote ? _normIntraDate(quote.quoteDate) : null,
      invoiceDate: sales ? _normIntraDate(sales.invoiceDate) : null,
      invoiceStatus: sales ? sales.invoiceStatus : null,
      paidAmount: sales ? sales.paidAmount : null,                            // 현재까지 매칭된 입금 누계
      paidDate: sales ? _normIntraDate(sales.paidDate || sales.paymentDate) : null,   // 최근 입금매칭일
      paymentStatus: sales ? sales.paymentStatus : null,
      // 총비용 = 견적서상 금액(원칙). 견적 없으면 계약금액 폴백. 견적↔계약 금액 불일치는 ⚠ 신호만(자동 판정 안 함).
      totalCost: quoteAmount != null ? quoteAmount : contractAmount,
      amountMismatch: !!(quoteAmount && contractAmount && quoteAmount !== contractAmount),
    };
  });
}
// 인트라넷 날짜 정규화: 'YYYYMMDD'(팝빌 trade_date) → 'YYYY-MM-DD', 그 외는 앞 10자.
function _normIntraDate(s) {
  const v = String(s || '').trim(); if (!v) return null;
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return v.slice(0, 10);
}

// ── 연결탭 비고(자유 텍스트, migration 056) — 탭당 1행 upsert. 관제실 '비고(인애드)' 대응. ──
async function saveTabMemo({ sheetId, tabName, memo = '', by = '' } = {}) {
  if (!sheetId || !tabName) return { ok: false, code: 400, error: 'sheetId, tabName 필수' };
  const text = ((typeof memo === 'string' || typeof memo === 'number') ? String(memo) : '').slice(0, 2000);
  await getPool().query(
    `INSERT INTO trackb_tab_memos (sheet_id, tab_name, memo, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (sheet_id, tab_name) DO UPDATE SET memo=$3, updated_by=$4, updated_at=NOW()`,
    [sheetId, tabName, text, String(by || '').slice(0, 100)]);
  return { ok: true, memo: text };
}

// ══════════════════════════════════════════════════════════════════════════
// P3 — 마감자료 자동 생성(리뷰완료 증빙 스냅샷, migration 055)
//   제출률 100%(또는 부분마감) 시 Track B 명단으로 마감자료 CSV 생성 + 마감일 자동 기록.
//   ★ 격리: campaign_participants(투영 명단) 읽기 + trackb_tab_closeouts write 만. Track A/시트 무접촉.
//   ★ latestCloseout 정의 = settlementForTab 의 스텝퍼 ①(마감자료)이 이 시점부터 라이브(closeoutAvailable).
// ══════════════════════════════════════════════════════════════════════════
// 활성 명단(투영 물리행 + participant_edits 오버레이 합성) — 마감자료 CSV·건수의 단일 소스.
//   ★ SF-3: 제거(_hidden) 오버레이 행은 제외(작업대에서 안 보이는 행이 CSV에 재등장 방지),
//     이름/수취인/차수/옵션/제출/입금 편집 보정도 반영 — workdeskTab 합성과 동일 규칙.
async function _closeoutRoster(sheetId, tabName) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, seq, reviewer_name AS name, recipient_name AS recipient, phone8, round, option_text AS option,
            product_name AS product, is_submitted AS submitted, is_paid AS paid, submitted_at AS "submittedAt",
            source, order_submission_id, identity_key
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND active=TRUE AND deleted_at IS NULL
      ORDER BY seq ASC`, [sheetId, tabName]);
  const { rows: edits } = await db.query(
    `SELECT anchor_type, anchor_value, field, kind, value_bool, value_text
       FROM participant_edits WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL`, [sheetId, tabName])
    .catch(() => ({ rows: [] }));
  const editMap = new Map();
  for (const e of edits) {
    const k = _akey(e.anchor_type, e.anchor_value);
    if (!editMap.has(k)) editMap.set(k, {});
    editMap.get(k)[e.field] = e.kind === 'bool' ? !!e.value_bool : (e.value_text == null ? '' : e.value_text);
  }
  const identCount = new Map();
  for (const r of rows) {
    if (r.order_submission_id || r.source === 'manual') continue;
    const ik = r.identity_key || identityKey(_ikFromRow(r));
    if (ik) identCount.set(ik, (identCount.get(ik) || 0) + 1);
  }
  const out = [];
  for (const r of rows) {
    const anchor = _deriveAnchor(r);
    let ov = {};
    if (anchor && !(anchor.type === 'identity' && (identCount.get(anchor.value) || 0) > 1)) {
      const k = _akey(anchor.type, anchor.value); if (editMap.has(k)) ov = editMap.get(k);
    }
    if (ov._hidden === true) continue;   // 제거 오버레이 → 마감자료에서 제외
    const pick = (f, phys) => (Object.prototype.hasOwnProperty.call(ov, f) ? ov[f] : phys);
    out.push({
      seq: r.seq, name: pick('reviewer_name', r.name), recipient: pick('recipient_name', r.recipient),
      phone8: pick('phone8', r.phone8), round: pick('round', r.round), option: pick('option_text', r.option),
      product: pick('product_name', r.product), submitted: !!pick('is_submitted', r.submitted),
      paid: !!pick('is_paid', r.paid), submittedAt: r.submittedAt,
    });
  }
  return out;
}
// 마감자료 생성(이력 보존 — 재생성 시 새 행). 마감일=오늘 KST. 건수=활성/제출.
async function generateCloseout({ sheetId, tabName, by = '' } = {}) {
  if (!sheetId || !tabName) return { ok: false, code: 400, error: 'sheetId, tabName 필수' };
  const roster = await _closeoutRoster(sheetId, tabName);
  if (!roster.length) return { ok: false, code: 400, error: '활성 명단이 없습니다(그림자 투영 후 생성).' };
  const subCount = roster.filter(r => r.submitted).length;
  const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);   // KST 날짜
  const { rows } = await getPool().query(
    `INSERT INTO trackb_tab_closeouts (sheet_id, tab_name, closed_date, row_count, sub_count, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, closed_date AS "date", row_count AS "rowCount", sub_count AS "subCount", created_by AS "createdBy", created_at AS "createdAt"`,
    [sheetId, tabName, kstDate, roster.length, subCount, String(by || '').slice(0, 100)]);
  return { ok: true, closeout: rows[0] };
}
// 최신 마감(스텝퍼 ① 소스). settlementForTab 이 병합. N-1: 동시각 tie 는 id DESC 로 결정적.
async function latestCloseout({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) return null;
  const { rows } = await getPool().query(
    `SELECT id, closed_date AS "date", row_count AS "rowCount", sub_count AS "subCount", created_by AS "createdBy", created_at AS "createdAt"
       FROM trackb_tab_closeouts WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`, [sheetId, tabName]);
  return rows[0] || null;
}
// CSV 셀 이스케이프 + 수식 인젝션 무력화(SF-2/N-4): =+-@ 또는 탭/CR 로 시작하면 앞에 ' 를 붙이고,
//   ",\r,\n 포함 시 따옴표로 감싼다(Excel/LibreOffice 수식 실행 CWE-1236 차단).
function _csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// 마감자료 CSV(UTF-8 BOM). PII라 내부(master/admin/staff) + 소유 광고주만 — reviewer 차단은 라우트 스코프.
//   광고주 렌즈면 연락처·이름·수취인 마스킹(workdeskTab 정책 일치) — 노출 토글 OFF 여부는 라우트가 사전 게이트.
async function closeoutCsv({ sheetId, tabName, role = 'master' } = {}) {
  const roster = await _closeoutRoster(sheetId, tabName);
  const isAdv = role === 'advertiser';
  const header = ['번호', '참여자', '연락처', '수취인', '차수', '옵션', '상품', '제출', '입금', '제출일'];
  const lines = [header.join(',')];
  for (const r of roster) {
    const phone = isAdv ? (r.phone8 ? '****' + String(r.phone8).slice(-4) : '') : (r.phone8 || '');
    lines.push([
      r.seq, isAdv ? _maskName(r.name) : r.name, phone, isAdv ? _maskName(r.recipient) : r.recipient,
      r.round, r.option, r.product,
      r.submitted ? 'O' : '', r.paid ? 'O' : '', r.submittedAt ? String(r.submittedAt).slice(0, 10) : '',
    ].map(_csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n');
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
//   ★ fail-closed 신호 계약(레드-블루-심판): "모름/미검증/비었음"은 준비·정상으로 새지 않는다.
//     · cutoverCandidate = 경량 triage(시트원본·카운트일치·소유·발주·비유령) — 정밀검증 "대상"일 뿐(자동화 소비 금지가 이름에 내장).
//     · cutoverReady    = candidate + **신선한 정밀 스냅샷 real=0**(parity_snapshots 최신, TRACK_B_PARITY_FRESH_HOURS 기본 24h)
//       — 카운트 레벨 "동수 다른사람" 함정을 이 필드 단독 소비자도 못 밟게 real 게이트 내장.
//     · ghost = A·B 모두 활성 0행(아카이브/리네임 잔재) — 0==0 카운트일치로 준비 오판 금지.
//     · write-back 건강 = 토글(is_submitted/is_paid, 자동 반영 대상)만 집계 + pending(미시도 NULL)·engineOn 노출
//       — gate_off/스윕 양보(deferred)로 status NULL인 편집이 "정상"으로 새는 허위 건강 차단.
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
     SELECT b.sheet_id AS "sheetId", b.tab_name AS "tabName",
            COALESCE(b.tab_gid, rst.tab_gid) AS "tabGid",
            b.b_total AS "bTotal", b.b_sub AS "bSub", b.b_paid AS "bPaid", b.b_linked AS "bLinked",
            b.last_proj AS "lastProjectedAt",
            rst.spreadsheet_title AS "spreadsheetTitle",
            (SELECT COUNT(*) FROM review_index ri WHERE ri.sheet_id=b.sheet_id AND ri.tab_name=b.tab_name AND ri.row_index IS NOT NULL) AS "aTotal",
            (SELECT COUNT(*) FROM review_index ri WHERE ri.sheet_id=b.sheet_id AND ri.tab_name=b.tab_name AND ri.is_submitted) AS "aSub",
            (SELECT COUNT(*) FROM review_index ri WHERE ri.sheet_id=b.sheet_id AND ri.tab_name=b.tab_name AND ri.is_submitted2='PAID') AS "aPaid",
            -- 수동 슬롯만 있어 participants gid가 전부 NULL인 탭도 raw_sheet_tabs gid로 탭단위 소유 판정(오탐 축소).
            EXISTS(SELECT 1 FROM advertiser_campaigns ac WHERE ac.deleted_at IS NULL AND ac.sheet_id=b.sheet_id
                     AND (ac.tab_gid IS NULL OR ac.tab_gid=COALESCE(b.tab_gid, rst.tab_gid))) AS "owned",
            (EXISTS(SELECT 1 FROM work_orders wo WHERE wo.deleted_at IS NULL
                      AND wo.linked_tab_sheet_id=b.sheet_id AND wo.linked_tab_name=b.tab_name)
             OR EXISTS(SELECT 1 FROM trackb_work_order_links l WHERE l.deleted_at IS NULL
                      AND l.sheet_id=b.sheet_id AND l.tab_name=b.tab_name)) AS "woLinked",
            tc.source_of_truth AS "sourceOfTruth",
            pec.edit_count AS "editCount", pec.edit_toggle AS "editToggle",
            pec.wb_pending AS "wbPending", pec.wb_held AS "wbHeld", pec.wb_blocked AS "wbBlocked",
            ps.real_cnt AS "snapReal", ps.taken_at AS "snapAt"
       FROM b LEFT JOIN LATERAL (
                -- 동명탭(같은 sheet_id·tab_name·다른 gid) 곱증식 차단: raw_sheet_tabs 는 (sheet_id,tab_gid)
                --   유니크뿐이라 평조인 시 overview 행·헤더 카운터가 배가 — 최신 미러 1행만(탭당 정확히 1행).
                SELECT r2.spreadsheet_title, r2.tab_gid FROM raw_sheet_tabs r2
                 WHERE r2.sheet_id=b.sheet_id AND r2.tab_name=b.tab_name
                 ORDER BY r2.mirrored_at DESC NULLS LAST LIMIT 1) rst ON TRUE
              LEFT JOIN tab_configs tc ON tc.sheet_id=b.sheet_id AND tc.tab_name=b.tab_name
              -- write-back 건강(P2): 탭당 1스캔(048 부분인덱스 idx_participant_edits_tab). 토글만 상태 스코프
              --   (writeback_status 는 executeWriteback(토글 전용)만 기록 — 비토글 상태는 현재 writer 없음).
              LEFT JOIN LATERAL (
                SELECT COUNT(*) AS edit_count,
                       COUNT(*) FILTER (WHERE pe.field IN ('is_submitted','is_paid')) AS edit_toggle,
                       COUNT(*) FILTER (WHERE pe.field IN ('is_submitted','is_paid') AND pe.writeback_status IS NULL) AS wb_pending,
                       COUNT(*) FILTER (WHERE pe.field IN ('is_submitted','is_paid') AND pe.writeback_status='held') AS wb_held,
                       COUNT(*) FILTER (WHERE pe.field IN ('is_submitted','is_paid') AND pe.writeback_status='blocked') AS wb_blocked
                  FROM participant_edits pe
                 WHERE pe.sheet_id=b.sheet_id AND pe.tab_name=b.tab_name AND pe.reverted_at IS NULL) pec ON TRUE
              -- 최신 정밀 스냅샷(049 idx_parity_snap_tab 정확 매치 top-1) — cutoverReady 의 real=0 근거.
              LEFT JOIN LATERAL (
                SELECT p0.real_cnt, p0.taken_at FROM parity_snapshots p0
                 WHERE p0.sheet_id=b.sheet_id AND p0.tab_name=b.tab_name
                 ORDER BY p0.taken_at DESC LIMIT 1) ps ON TRUE
      ORDER BY rst.spreadsheet_title NULLS LAST, b.tab_name`);
  const wbEngineOn = process.env.TRACK_B_WRITEBACK === '1';   // 글로벌 게이트 상태를 관측에 동봉(허위 '정상' 차단)
  const fhRaw = parseInt(process.env.TRACK_B_PARITY_FRESH_HOURS || '24', 10);
  const freshMs = (Number.isFinite(fhRaw) && fhRaw > 0 ? fhRaw : 24) * 3600 * 1000;
  const now = Date.now();
  return rows.map(r => {
    const aTotal = Number(r.aTotal), aSub = Number(r.aSub), aPaid = Number(r.aPaid);
    const bTotal = Number(r.bTotal), bSub = Number(r.bSub), bPaid = Number(r.bPaid);
    const countMatch = (aTotal === bTotal && aSub === bSub && aPaid === bPaid);
    const sot = r.sourceOfTruth || 'sheet';
    const owned = !!r.owned, woLinked = !!r.woLinked;
    const ghost = aTotal === 0 && bTotal === 0;   // 아카이브/리네임 잔재 — 후보 제외
    const snapReal = r.snapReal == null ? null : Number(r.snapReal);
    const parityFresh = !!r.snapAt && (now - new Date(r.snapAt).getTime()) < freshMs;
    const cutoverCandidate = sot === 'sheet' && countMatch && owned && woLinked && !ghost;
    const cutoverReady = cutoverCandidate && parityFresh && snapReal === 0;
    return {
      sheetId: r.sheetId, tabName: r.tabName, tabGid: r.tabGid, spreadsheetTitle: r.spreadsheetTitle || r.sheetId,
      a: { total: aTotal, submitted: aSub, paid: aPaid },
      b: { total: bTotal, submitted: bSub, paid: bPaid, linked: Number(r.bLinked) },
      countMatch, owned, woLinked, ghost, lastProjectedAt: r.lastProjectedAt,
      sourceOfTruth: sot,   // 진실원천(옵션 A cutover 스위치): 'sheet'(레거시) | 'db'(Track B)
      lastParity: { real: snapReal, takenAt: r.snapAt || null, fresh: parityFresh },
      editCount: Number(r.editCount), editToggle: Number(r.editToggle),
      writeback: { engineOn: wbEngineOn, pending: Number(r.wbPending), held: Number(r.wbHeld), blocked: Number(r.wbBlocked) },
      cutoverCandidate, cutoverReady,
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

// 플립(master 전용, 라우트 게이트). 'db' 전환 게이트(fail-closed · 레드-블루-심판):
//   ① parity 검증 실패/미상(real=null)은 "통과"가 아니라 거부(parity_check_failed) — 구 .catch(()=>null) fail-open 봉합.
//   ② 진짜 불일치 real>0 → parity_not_clean. ③ A·B(phone8 기준) 모두 0행(유령/빈 탭) → empty_tab(cutover 무의미).
//   force 만 ①~③ 우회(로그에 forced/UNVERIFIED 명시). 되돌리기 = value 'sheet'(게이트 없음).
async function setSourceOfTruth({ sheetId, tabName, value, by = 'admin', force = false } = {}) {
  if (!sheetId || !tabName) throw new Error('setSourceOfTruth: sheetId, tabName 필수');
  if (!_SOT_VALUES.has(value)) return { ok: false, error: 'invalid_value', allowed: [..._SOT_VALUES] };
  let parity = null, parityErr = null;
  if (value === 'db') {
    try { parity = await parityReport({ sheetId, tabName }); }   // data-parity 게이트(readiness 별도)
    catch (e) { parityErr = e.message; }
    const real = parity && parity.buckets ? parity.buckets.real : null;
    if (!force && real == null) return { ok: false, error: 'parity_check_failed', detail: parityErr || 'real=null' };
    if (!force && real > 0) return { ok: false, error: 'parity_not_clean', real, parity };
    const d3 = (parity && parity.dims && parity.dims.d3_counts) || {};
    if (!force && !(Number(d3.aTotal) > 0 && Number(d3.bTotal) > 0)) {
      return { ok: false, error: 'empty_tab', aTotal: Number(d3.aTotal) || 0, bTotal: Number(d3.bTotal) || 0 };
    }
  }
  const db = getPool();
  const { rowCount } = await db.query(
    `UPDATE tab_configs SET source_of_truth=$3 WHERE sheet_id=$1 AND tab_name=$2`,
    [sheetId, tabName, value]);
  if (!rowCount) return { ok: false, error: 'tab_not_found' };
  logger.info(`[trackB] source_of_truth ${sheetId}/${tabName} → ${value} (by ${by}${force ? ', forced' : ''}${parityErr ? ', parity UNVERIFIED: ' + parityErr : ''})`);
  return { ok: true, sheetId, tabName, sourceOfTruth: value, parity, parityVerified: value === 'db' ? !parityErr : null };
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

// ══════════════════════════════════════════════════════════════════════════
// P1 — 탭 스레드(협업 코멘트 + 확인요청 + 내부 메모 통합, migration 053)
//   ★ 격리: 리뷰 PG 신규 테이블만. Track A/인트라넷 무접촉. 광고주 노출은 internal_only 서버 필터로 게이트.
// ══════════════════════════════════════════════════════════════════════════
function _threadUserKey({ role, name, advertiserId } = {}) {
  return role === 'advertiser' ? `adv:${advertiserId || ''}` : `${role || ''}:${name || ''}`;
}

// 탭 스레드 조회(시간순). 광고주는 internal_only=FALSE 만(서버 필터 — 클라이언트 신뢰 안 함).
async function listThread({ sheetId, tabName, role = 'master' } = {}) {
  if (!sheetId || !tabName) throw new Error('listThread: sheetId, tabName 필수');
  const where = ['sheet_id=$1', 'tab_name=$2', 'deleted_at IS NULL'];
  if (role === 'advertiser') where.push('internal_only = FALSE');
  const { rows } = await getPool().query(
    `SELECT id, kind, body, internal_only AS "internalOnly", status,
            author_role AS "authorRole", author_name AS "authorName",
            created_at AS "createdAt", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"
       FROM trackb_tab_threads WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC`,
    [sheetId, tabName]);
  return rows;
}

// 글 작성. 광고주는 internal_only 강제 FALSE(외부인이 내부 전용 글 못 만듦). request 는 status='open' 시작.
async function addThread({ sheetId, tabName, body, internalOnly = false, asRequest = false, role = 'master', name = '' } = {}) {
  if (!sheetId || !tabName) return { ok: false, code: 400, error: 'sheetId, tabName 필수' };
  const text = String(body || '').trim();
  if (!text) return { ok: false, code: 400, error: '내용을 입력하세요.' };
  if (text.length > 5000) return { ok: false, code: 400, error: '내용이 너무 깁니다(최대 5000자).' };   // 저장 폭주 방지(nit)
  const kind = asRequest ? 'request' : 'comment';
  const status = asRequest ? 'open' : null;
  const internal = role === 'advertiser' ? false : !!internalOnly;
  const { rows } = await getPool().query(
    `INSERT INTO trackb_tab_threads (sheet_id, tab_name, kind, body, internal_only, status, author_role, author_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, kind, body, internal_only AS "internalOnly", status,
               author_role AS "authorRole", author_name AS "authorName", created_at AS "createdAt"`,
    [sheetId, tabName, kind, text, internal, status, role, String(name || '').slice(0, 100)]);
  return { ok: true, item: rows[0] };
}

// 확인요청 상태 전이(confirming/done). done 시 resolved 기록. comment/없는 글은 400.
//   ★ B1(IDOR) 방어: 스코프 통과한 (sheetId,tabName)에 UPDATE를 결속 — id만으로 타 테넌트 요청 변조 차단.
async function setRequestStatus({ id, sheetId, tabName, status, role = 'master', name = '' } = {}) {
  if (!id || !sheetId || !tabName || !['confirming', 'done'].includes(status)) return { ok: false, code: 400, error: '잘못된 요청' };
  const resolved = status === 'done';
  const { rows } = await getPool().query(
    `UPDATE trackb_tab_threads
        SET status=$2, resolved_at=CASE WHEN $3 THEN NOW() ELSE NULL END,
            resolved_by=CASE WHEN $3 THEN $4 ELSE NULL END
      WHERE id=$1 AND sheet_id=$5 AND tab_name=$6 AND kind='request' AND deleted_at IS NULL
      RETURNING id, status, resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"`,
    [id, status, resolved, String(name || '').slice(0, 100), sheetId, tabName]);
  if (!rows.length) return { ok: false, code: 404, error: '확인요청을 찾을 수 없습니다.' };
  return { ok: true, item: rows[0] };
}

// 글 삭제(soft). 작성자 본인 또는 master/admin 만.
//   ★ S1 방어: 스코프 통과한 (sheetId,tabName)에 SELECT·UPDATE 결속(교차 탭 삭제 차단, 동명 로그인 콜리전 방어).
async function deleteThread({ id, sheetId, tabName, role = 'master', name = '' } = {}) {
  if (!id || !sheetId || !tabName) return { ok: false, code: 400, error: '잘못된 요청' };
  const db = getPool();
  const { rows } = await db.query(
    'SELECT author_role, author_name FROM trackb_tab_threads WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL',
    [id, sheetId, tabName]);
  if (!rows.length) return { ok: false, code: 404, error: '글을 찾을 수 없습니다.' };
  const isAdmin = role === 'master' || role === 'admin';
  const isAuthor = rows[0].author_role === role && String(rows[0].author_name || '') === String(name || '');
  if (!isAdmin && !isAuthor) return { ok: false, code: 403, error: '삭제 권한이 없습니다.' };
  await db.query('UPDATE trackb_tab_threads SET deleted_at=NOW() WHERE id=$1 AND sheet_id=$2 AND tab_name=$3', [id, sheetId, tabName]);
  return { ok: true };
}

// 열람 마킹(미확인 배지 기준점). 탭 열 때 호출.
async function markThreadSeen({ sheetId, tabName, role = 'master', name = '', advertiserId = null } = {}) {
  if (!sheetId || !tabName) return { ok: false };
  await getPool().query(
    `INSERT INTO trackb_thread_seen (user_key, sheet_id, tab_name, last_seen_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_key, sheet_id, tab_name) DO UPDATE SET last_seen_at=NOW()`,
    [_threadUserKey({ role, name, advertiserId }), sheetId, tabName]);
  return { ok: true };
}

// 미확인 수 집계(1쿼리): 내 last_seen 이후 생성 + 내가 볼 수 있는(광고주=internal_only FALSE) 글.
//   tabs 지정 시 그 탭들만(작업목록 배지), 미지정 시 전체. 반환 = { 'sheetId\ttabName': count } 맵 + total.
//   ★ B2(교차 테넌트 메타 유출) 방어: staff/advertiser는 소유/담당 탭으로 서버 강제 제한 —
//     클라 tabs는 소유와 교집합만, tabs 미지정도 전역 쿼리 금지(소유 탭으로 대체). master/admin만 전체.
async function unseenCounts({ role = 'master', name = '', advertiserId = null, tabs = null } = {}) {
  if (role === 'staff' || role === 'advertiser') {
    const scoped = await scopedActiveTabs({ role, staffName: name, advertiserId });
    const ownedSet = new Set(scoped.map(t => `${t.sheetId}\t${t.tabName}`));
    if (!ownedSet.size) return { map: {}, total: 0 };
    const base = (Array.isArray(tabs) && tabs.length) ? tabs : scoped.map(t => ({ sheetId: t.sheetId, tabName: t.tabName }));
    tabs = base.filter(t => t && ownedSet.has(`${t.sheetId}\t${t.tabName}`));
    if (!tabs.length) return { map: {}, total: 0 };
  }
  const userKey = _threadUserKey({ role, name, advertiserId });
  const advGate = role === 'advertiser' ? 'AND t.internal_only = FALSE' : '';
  const params = [userKey];
  let scopeFilter = '';
  if (Array.isArray(tabs) && tabs.length) {
    const pairs = tabs.map((t, i) => `(t.sheet_id=$${i * 2 + 2} AND t.tab_name=$${i * 2 + 3})`).join(' OR ');
    tabs.forEach(t => { params.push(t.sheetId, t.tabName); });
    scopeFilter = `AND (${pairs})`;
  }
  const { rows } = await getPool().query(
    `SELECT t.sheet_id AS "sheetId", t.tab_name AS "tabName", COUNT(*)::int AS n
       FROM trackb_tab_threads t
       LEFT JOIN trackb_thread_seen s
         ON s.user_key=$1 AND s.sheet_id=t.sheet_id AND s.tab_name=t.tab_name
      WHERE t.deleted_at IS NULL ${advGate} ${scopeFilter}
        AND t.created_at > COALESCE(s.last_seen_at, 'epoch'::timestamptz)
      GROUP BY t.sheet_id, t.tab_name`, params);
  const map = {}; let total = 0;
  for (const r of rows) { map[`${r.sheetId}\t${r.tabName}`] = r.n; total += r.n; }
  return { map, total };
}

// 탭별 미완료(open/confirming) 확인요청 수 — 정산/카드 상단 고정 배지.
//   role='advertiser'면 internal_only 요청 제외(광고주 뷰에 노출 대비 — 노출 전 게이트 내장).
async function openRequestCounts({ sheetId, tabName, role = 'master' } = {}) {
  const advGate = role === 'advertiser' ? 'AND internal_only = FALSE' : '';
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM trackb_tab_threads
      WHERE sheet_id=$1 AND tab_name=$2 AND kind='request' AND deleted_at IS NULL
        AND status IN ('open','confirming') ${advGate}`, [sheetId, tabName]);
  return (rows[0] && rows[0].n) || 0;
}

// 역할 스코프 적용된 활성 탭 목록: staff/advertiser 는 담당/소유 탭만, master/admin 은 전체.
async function scopedActiveTabs({ role, staffName, advertiserId, limit, forMapping = false } = {}) {
  const all = await participants.listActiveTabs({ limit });
  // forMapping(소유지정 초기매핑용): staff(AE)에 한해 전체 탭명 목록 개방 — 아직 소유가 없는 시트를
  //   매핑하려면 전체가 보여야 함(스코프만 적용하면 catch-22). 명단 PII 없는 탭명·행수만이라 내부인에 안전.
  //   advertiser(외부)는 forMapping 무시(항상 소유 스코프) — 교차 열람 차단 유지.
  const scope = (forMapping && role === 'staff') ? null : await _scopeFor({ role, staffName, advertiserId });
  const tabs = scope ? all.filter(t => _scopeOwns(scope, t.sheetId, t.tabGid)) : all;
  // 소유 업체 주석(작업목록 업체별 그룹핑용, 읽기 전용 추가 필드): 탭지정 소유 > 시트전체 소유 우선.
  //   advertiser_campaigns 미적용/빈 환경은 주석 없이 통과(graceful) — 기존 응답 필드 불변.
  try {
    const { rows: own } = await getPool().query(
      `SELECT ac.sheet_id AS "sheetId", ac.tab_gid AS "tabGid", a.id AS "advId", a.name AS "advName"
         FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
        WHERE ac.deleted_at IS NULL ORDER BY a.name, ac.created_at`);
    if (own.length) {
      for (const t of tabs) {
        const hit = own.find(o => o.sheetId === t.sheetId && o.tabGid != null && String(o.tabGid) === String(t.tabGid))
                 || own.find(o => o.sheetId === t.sheetId && o.tabGid == null);
        if (hit) { t.advertiserId = hit.advId; t.advertiserName = hit.advName; }
      }
    }
  } catch (_) {}
  return tabs;
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
// P2/P2-2 write-back 경로 정합(red-blue-judge 확정): 플랜(_computeWritebackPlan)이 **유일 op 산출원**,
//   _writebackEngine 이 tier 실행기 — base(cron·TRACK_B_WRITEBACK=1)=상태 토글만 /
//   full(수동 apply-full·TRACK_B_WRITEBACK_FULL=1)=base+안전군 필드편집 / simulate=전체 플랜(시트 무접촉).
//
// ★★ 불변식(위반=Blocker):
//   1) 격리: source_of_truth·양 env 판정은 이 파일에서만. Track A 파일·cron.js·routes 변경 0줄.
//   2) 컬럼 disjoint: _wbOrderMappedMask = mapOrderToSheetRow(headers,{}) 의 non-null 칸(주문매핑칸).
//      빈 orderData 에도 매핑칸은 ''(non-null)·비매핑칸은 null 을 반환(실코드 검증) — 옵션/계좌/금액/
//      일자/비고/이름류까지 자동 위험군(risky_order_mapped). ★토글도 대상칸이 매핑칸이면 실적용 금지
//      (예: submit_col2='입금일자' 는 일자칸 → order_append 와 충돌 가능 — 기존 P2 의 잠복 구멍 봉합).
//   3) blank-only · un-write 불가 · 사람셀 클로버 금지: 충돌=held(비재시도). own-provenance(sig 로
//      "내가 쓴 O" 지우기)는 기각 — 입금칸은 사람 입금표기와 공유라 sig 로도 현재 'O' 의 배타 소유 증명 불가.
//   4) 신원 fail-closed: _wbIdentityOk(전화=digits 끝8자리 · 수취인=trim, AND, 비교불가=불일치).
//      ★ ol.rowIdentityMatches 사용 금지 — normalizeGuardValue 가 digits '전체' equality 라
//        시트 01012345678 vs DB phone8(12345678)이 상시 불일치 → 전건 blocked 잠복버그(이번에 수정).
//   5) 저우선 throttle({priority:'low'}) + BUSY 양보 + 행당 저우선 읽기 1콜(신원칸∪대상칸 사각형)
//      + TRACK_B_WRITEBACK_MAX_ROWS 상한 — 주문 예약 8슬롯(SHEETS_ORDER_RESERVE) 무굶김.
//   6) 멱등·핑퐁0: no-op 수렴마킹(written) + written 재픽업 안 함 + 쓰기실패=무마킹 defer(재시도 멱등)
//      + no_meta=무마킹 skip(마킹은 헤더 확보 후에만 — 오마킹 방지).
//   7) status 어휘 고정 {NULL,'written','held','blocked'}(migration 052 CHECK 백스톱) — 구버전 픽업
//      (IS NULL OR ='blocked')과 롤백 호환. markStatus 화이트리스트 + editId 없는 op(add/clear) 미호출.
//   8) 두 env 미설정 = 완전 inert(gate_off/trigger_off 즉시 반환, DB·시트 무접촉).
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

// ── 주문매핑칸 마스크(disjoint 자동 유도): mapOrderToSheetRow 는 빈 orderData 에도
//    주문칸에 ''(non-null)·비주문칸에 null 을 반환 → non-null = order_append 가 쓰는 칸. ──
function _wbOrderMappedMask(headers) {
  const ol = require('./orderLedger.service');
  return ol.mapOrderToSheetRow(headers || [], {}).map(v => v !== null);
}

// ── 신원 재검증(fail-closed): rowIdentityMatches 의 의미(존재 칸 AND 일치·비교불가=거부) 승계 +
//    전화는 digits 끝8자리 비교(DB phone8 과 정합 — 전체 equality 잠복버그 수정). ──
function _wbIdentityOk({ cells, minC, phoneCol, recipCol, phone8, recipient }) {
  const checks = [];
  if (phoneCol >= 0 && String(phone8 || '').trim()) {
    const cur = String(cells[phoneCol - minC] == null ? '' : cells[phoneCol - minC]).replace(/[^0-9]/g, '');
    checks.push(cur.length >= 8 && cur.slice(-8) === String(phone8).trim());
  }
  if (recipCol >= 0 && String(recipient || '').trim()) {
    const cur = String(cells[recipCol - minC] == null ? '' : cells[recipCol - minC]).trim();
    checks.push(!!cur && cur === String(recipient).trim());
  }
  return checks.length > 0 && checks.every(Boolean);
}

function _wbEditFieldCol(ol, headers, field) {
  if (field.indexOf('col:') === 0) return headers.indexOf(field.slice(4));
  const m = { recipient_name: 'recipient', phone8: 'phone', option_text: 'selected_opt_key' };
  if (m[field]) return ol._fieldToCol(headers, m[field]);
  const kw = { round: /차수|회차|round/i, reviewer_name: /참여자|리뷰어|닉네임|이름/ };
  if (kw[field]) { for (let i = 0; i < headers.length; i++) if (kw[field].test(String(headers[i] || ''))) return i; }
  return -1;
}
// 위험군(필드명 기준): 소유권키(phone8/recipient) + 연락처/주소/수취인/주문번호 헤더 — 실적용 제외.
//   (주문매핑칸 일반은 _wbOrderMappedMask 가 헤더 기준으로 추가 차단 — 이중 안전망.)
function _wbIsRiskyField(field, header) {
  if (field === 'phone8' || field === 'recipient_name') return true;
  const h = field.indexOf('col:') === 0 ? field.slice(4) : (header || '');
  return /연락처|전화|핸드폰|휴대폰|phone|주소|address|수취인|받는분|주문번호|ordernum/i.test(h);
}

const _WB_BLOCKED = ['no_anchor', 'ambiguous', 'no_column', 'no_sheet_row', 'no_tab_gid'];
const _WB_RISKY = ['risky_ownership_key', 'risky_order_mapped', 'risky_coords', 'risky_append', 'manual_row'];
const _WB_STATUSES = new Set(['written', 'held', 'blocked']);   // R3: 어휘 고정(052 CHECK 와 동형)

// ── 유일 op 산출원(시트 무접촉·순수 읽기): scope='all'(시뮬 전체) | 'base'(토글 미반영) | 'full'(비토글 포함 미반영).
//    픽업 술어(R2/R9): '_hidden' 은 base(IN 토글)·full(<>'_hidden') 양쪽 SQL 에서 제외 — 영구 재픽업 원천 차단.
//    full 은 소유권키 필드(phone8/recipient_name)도 SQL 제외(실행·오마킹 자체가 없음, 시뮬엔 노출). ──
async function _computeWritebackPlan(db, sheetId, tabName, { scope = 'all' } = {}) {
  const ol = require('./orderLedger.service');
  let editSql = `SELECT id, anchor_type, anchor_value, field, kind, value_bool, value_text
       FROM participant_edits WHERE sheet_id=$1 AND tab_name=$2 AND reverted_at IS NULL`;
  if (scope === 'base') {
    editSql += ` AND field IN ('is_submitted','is_paid') AND (writeback_status IS NULL OR writeback_status='blocked')`;
  } else if (scope === 'full') {
    editSql += ` AND field <> '_hidden' AND field NOT IN ('phone8','recipient_name')
        AND (writeback_status IS NULL OR writeback_status='blocked')`;
  }
  const { rows: edits } = await db.query(editSql, [sheetId, tabName]);
  if (scope !== 'all' && !edits.length) return { noPending: true, edits: [], ops: [], roster: [], headers: [] };

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
  const mask = headers.length ? _wbOrderMappedMask(headers) : [];

  const resolve = (e) => {
    if (e.anchor_type === 'order') return byOrder.get(e.anchor_value) || null;
    if (e.anchor_type === 'manual') return byManual.get(e.anchor_value) || null;
    if (e.anchor_type === 'identity') return (identCount.get(e.anchor_value) || 0) > 1 ? { __ambiguous: true } : (byIdent.get(e.anchor_value) || null);
    return null;
  };
  const tierOf = (type, guard) => {
    if (type === 'add' || type === 'clear' || _WB_RISKY.includes(guard)) return 'manual';
    if (_WB_BLOCKED.includes(guard)) return 'blocked';
    return type === 'toggle' ? 'base' : 'full';
  };
  const ops = []; const hiddenManual = new Set();
  for (const e of edits) {
    const row = resolve(e);
    if (e.field === '_hidden') { if (row && !row.__ambiguous && row.source === 'manual') hiddenManual.add(String(row.id)); continue; }
    const nv = e.kind === 'bool' ? (e.value_bool ? 'O' : '') : (e.value_text == null ? '' : e.value_text);
    if (!row) { ops.push({ editId: e.id, type: 'edit', field: e.field, newValue: nv, guard: 'no_anchor', tier: 'blocked' }); continue; }
    if (row.__ambiguous) { ops.push({ editId: e.id, type: 'edit', field: e.field, newValue: nv, guard: 'ambiguous', tier: 'blocked' }); continue; }
    const base = { editId: e.id, participantId: row.id, seq: row.seq, name: row.reviewer_name, sheetRow: row.sheet_row, field: e.field, newValue: nv };
    const isToggle = (e.field === 'is_submitted' || e.field === 'is_paid');
    let ci = -1, header = null;
    if (isToggle) {
      const col = e.field === 'is_submitted' ? row.submit_col : row.submit_col2;
      ci = col ? headers.indexOf(col) : -1; header = col || null;
    } else {
      ci = _wbEditFieldCol(ol, headers, e.field); header = ci >= 0 ? headers[ci] : null;
    }
    let guard = 'ok';
    if (!row.sheet_row) guard = 'no_sheet_row';
    else if (!row.tab_gid) guard = 'no_tab_gid';
    else if (ci < 0) guard = 'no_column';
    else if (!isToggle && _wbIsRiskyField(e.field, header)) guard = 'risky_ownership_key';
    else if (mask[ci]) guard = 'risky_order_mapped';            // ★ disjoint: 주문매핑칸은 토글도 실적용 금지
    else if (row.source === 'manual') guard = 'manual_row';     // B 전용 물리행 — 시트 좌표 신뢰 불가(수동 검토)
    const type = isToggle ? 'toggle' : 'edit';
    ops.push({ ...base, type, header, colIndex: ci >= 0 ? ci : null,
      column: ci >= 0 ? ol.getColLetter(ci) : null, valueBool: e.kind === 'bool' ? !!e.value_bool : null,
      guard, tier: tierOf(type, guard) });
  }
  if (scope === 'all') {   // manual add/clear 는 시뮬 전용(editId 없음 → 엔진 실행·마킹 대상 아님, R11)
    for (const r of roster) {
      if (r.source !== 'manual') continue;
      if (r.deleted_at || hiddenManual.has(String(r.id))) {
        if (r.sheet_row) ops.push({ participantId: r.id, seq: r.seq, name: r.reviewer_name, sheetRow: r.sheet_row, type: 'clear', guard: 'risky_coords', tier: 'manual' });
      } else if (r.active) {
        ops.push({ participantId: r.id, seq: r.seq, name: r.reviewer_name, sheetRow: r.sheet_row || null, type: 'add', guard: 'risky_append', tier: 'manual',
          newValue: { reviewer: r.reviewer_name, recipient: r.recipient_name, option: r.option_text } });
      }
    }
  }
  return { edits, ops, roster, headers };
}

// ── tier 실행기(단일 엔진): base=토글만 / full=토글+안전군 필드편집. 게이트는 공개 래퍼가 통과시킨 뒤 호출. ──
async function _writebackEngine({ sheetId, tabName, tier }) {
  const db = getPool();
  const ol = require('./orderLedger.service');
  const { readSheet, batchUpdateSheet, invalidateSheetMeta } = require('./sheets.service');
  const { throttledCall, getThrottleStatus } = require('../utils/sheetsThrottle');

  const plan = await _computeWritebackPlan(db, sheetId, tabName, { scope: tier });
  if (plan.noPending) return { skipped: true, reason: 'no_pending', tabName };
  const headers = plan.headers;
  if (!headers.length) return { skipped: true, reason: 'no_meta', tabName };   // R6: 메타 없으면 무마킹 skip(자가치유)

  const markStatus = async (editId, st, sig) => {
    if (!editId || !_WB_STATUSES.has(st)) return;   // R3(어휘 고정) · R11(editId 없는 op 마킹 금지)
    await db.query(
      `UPDATE participant_edits SET writeback_status=$2, writeback_at=NOW(), writeback_sig=COALESCE($3,writeback_sig) WHERE id=$1`,
      [editId, st, sig || null]);
  };
  const rmap = new Map(plan.roster.map(r => [String(r.id), r]));
  const phoneCol = ol._fieldToCol(headers, 'phone');
  const recipCol = ol._fieldToCol(headers, 'recipient');
  let written = 0, held = 0, blocked = 0, deferred = 0, remaining = 0;

  // per-row 그룹핑(R5): 같은 행의 토글·필드편집을 1회 읽기 + 1회 쓰기로(신원칸∪대상칸 사각형).
  const perRow = new Map();
  for (const op of plan.ops) {
    if ((op.type !== 'toggle' && op.type !== 'edit') || !op.editId) continue;
    if (_WB_BLOCKED.includes(op.guard)) { await markStatus(op.editId, 'blocked'); blocked++; continue; }   // 자가치유 재시도(30분)
    if (_WB_RISKY.includes(op.guard)) { await markStatus(op.editId, 'held'); held++; continue; }           // 수동 대상(비재시도)
    const row = rmap.get(String(op.participantId));
    if (!row) { await markStatus(op.editId, 'blocked'); blocked++; continue; }
    const key = String(row.id);
    if (!perRow.has(key)) perRow.set(key, { row, wantSubmitted: null, wantPaid: null, toggleIds: [], fields: [] });
    const g = perRow.get(key);
    if (op.type === 'toggle') {
      if (op.field === 'is_submitted') g.wantSubmitted = !!op.valueBool; else g.wantPaid = !!op.valueBool;
      g.toggleIds.push(op.editId);
    } else g.fields.push(op);
  }
  if (!perRow.size) return { tabName, written, held, blocked, deferred };

  const BUSY = parseInt(process.env.TRACK_B_WRITEBACK_BUSY || '20', 10);
  const MAX_ROWS = parseInt(process.env.TRACK_B_WRITEBACK_MAX_ROWS || '40', 10);   // R8: 첫 활성화 폭주 상한
  invalidateSheetMeta(sheetId);   // 런당 1회(행당 재무효화는 그리드 메타 재조회 낭비 — R5)
  let processed = 0;

  for (const g of perRow.values()) {
    const { row } = g;
    const pend = g.toggleIds.length + g.fields.length;
    const markAll = async (st) => { for (const id of g.toggleIds) await markStatus(id, st); for (const f of g.fields) await markStatus(f.editId, st); };
    if (processed >= MAX_ROWS) { remaining += pend; continue; }                              // 다음 주기 재픽업(무마킹)
    if (getThrottleStatus().requestsInLastMinute > BUSY) { deferred += pend; continue; }     // 저우선 양보(무마킹·멱등)
    if (!row.phone8 || !row.recipient_name) { await markAll('blocked'); blocked += pend; continue; }
    const idCols = [phoneCol, recipCol].filter(c => c >= 0);
    if (!idCols.length) { await markAll('blocked'); blocked += pend; continue; }             // 신원 비교불가 = fail-closed
    processed++;
    const tCols = [];
    if (g.toggleIds.length) {
      const c1 = row.submit_col ? headers.indexOf(row.submit_col) : -1;
      const c2 = row.submit_col2 ? headers.indexOf(row.submit_col2) : -1;
      if (c1 >= 0) tCols.push(c1);
      if (c2 >= 0) tCols.push(c2);
    }
    for (const f of g.fields) tCols.push(f.colIndex);
    const allCols = idCols.concat(tCols);
    const minC = Math.min(...allCols), maxC = Math.max(...allCols);
    const rng = `'${tabName}'!${_wbColLetter(minC)}${row.sheet_row}:${_wbColLetter(maxC)}${row.sheet_row}`;
    let cells;
    try { const rd = await throttledCall(() => readSheet(sheetId, rng, { gid: row.tab_gid }), 2, { priority: 'low' }); cells = (rd && rd[0]) || null; }
    catch (_) { deferred += pend; continue; }
    if (!cells || !_wbIdentityOk({ cells, minC, phoneCol, recipCol, phone8: row.phone8, recipient: row.recipient_name })) {
      await markAll('blocked'); blocked += pend; continue;   // 행이동/재사용/그리드밖 → 재투영 후 자가치유
    }
    const writeData = [];
    let toggleStatus = null, toggleSig = null;
    if (g.toggleIds.length) {
      const { writeData: wd, conflict } = _buildToggleWrite({ tabName, headers, submitCol: row.submit_col, submitCol2: row.submit_col2,
        wantSubmitted: g.wantSubmitted, wantPaid: g.wantPaid, cells, minC, sheetRow: row.sheet_row });
      writeData.push(...wd);
      toggleStatus = conflict ? 'held' : 'written';   // 수렴마킹: 이미 원하는 상태(no-op)도 written(R1 재편집 수렴)
      toggleSig = `s=${g.wantSubmitted == null ? '-' : (g.wantSubmitted ? 'O' : '')}|p=${g.wantPaid == null ? '-' : (g.wantPaid ? 'O' : '')}`;
    }
    const fieldMarks = [];
    for (const f of g.fields) {
      const cur = String(cells[f.colIndex - minC] == null ? '' : cells[f.colIndex - minC]).trim();
      const want = String(f.newValue == null ? '' : f.newValue).trim();
      if (cur === want) { fieldMarks.push([f.editId, 'written', `f=${f.field}`]); continue; }   // 수렴(no-op)·멱등·핑퐁0
      if (cur !== '') { fieldMarks.push([f.editId, 'held', null]); continue; }                   // blank-only(사람셀·un-write 보호)
      writeData.push({ range: `'${tabName}'!${_wbColLetter(f.colIndex)}${row.sheet_row}`, values: [[want]] });   // want!=='' 보장(cur===''≠want)
      fieldMarks.push([f.editId, 'written', `f=${f.field}`]);
    }
    if (writeData.length) {
      try { await throttledCall(() => batchUpdateSheet(sheetId, writeData, 'RAW', { gid: row.tab_gid }), 2, { priority: 'low' }); }
      catch (_) { deferred += pend; continue; }   // 실패=무마킹 defer(blank-only 재시도 멱등, 부분성공은 다음 런 no-op 수렴)
    }
    if (toggleStatus) {
      for (const id of g.toggleIds) await markStatus(id, toggleStatus, toggleSig);
      if (toggleStatus === 'held') held += g.toggleIds.length; else written += g.toggleIds.length;
    }
    for (const [id, st, sg] of fieldMarks) { await markStatus(id, st, sg); if (st === 'held') held++; else written++; }
  }
  const out = { tabName, written, held, blocked, deferred };
  if (remaining) out.remaining = remaining;
  return out;
}

// cutover 탭 1개의 미반영 상태 토글을 시트에 반영(base tier). 큐 없이 cron/수동이 직접 호출(멱등·재시도 안전).
async function executeWriteback({ sheetId, tabName } = {}) {
  if (process.env.TRACK_B_WRITEBACK !== '1') return { skipped: true, reason: 'gate_off' };
  if (!sheetId || !tabName) return { skipped: true, reason: 'missing_args' };
  if (await getSourceOfTruth({ sheetId, tabName }) !== 'db') return { skipped: true, reason: 'not_cutover' };
  return _writebackEngine({ sheetId, tabName, tier: 'base' });
}

// cron/수동 진입점: cutover(source_of_truth='db') 탭 중 미반영 토글이 있는 탭만 순회(050 부분인덱스).
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
  let done = 0, written = 0, held = 0, blocked = 0, errors = 0;
  for (const t of tabs) {
    try {
      const r = await executeWriteback({ sheetId: t.sheetId, tabName: t.tabName });
      done++; written += r.written || 0; held += r.held || 0; blocked += r.blocked || 0;
    }
    catch (e) { errors++; logger.warn(`[trackB] writeback ${t.tabName} 실패: ${e.message}`); }
  }
  return { candidateTabs: tabs.length, done, written, held, blocked, errors };
}

// 관측: 토글 3필드(기존 계약 불변) + 필드편집 하위객체 + staleWritten(되돌려진 written — 시트에 stale 'O' 잔존 신호).
async function writebackStatus() {
  const { rows } = await getPool().query(
    `SELECT COUNT(*) FILTER (WHERE reverted_at IS NULL AND field IN ('is_submitted','is_paid') AND writeback_status='held')::int AS held,
            COUNT(*) FILTER (WHERE reverted_at IS NULL AND field IN ('is_submitted','is_paid') AND writeback_status='blocked')::int AS blocked,
            COUNT(*) FILTER (WHERE reverted_at IS NULL AND field IN ('is_submitted','is_paid') AND writeback_status='written')::int AS written,
            COUNT(*) FILTER (WHERE reverted_at IS NULL AND field NOT IN ('is_submitted','is_paid','_hidden') AND writeback_status='written')::int AS "feWritten",
            COUNT(*) FILTER (WHERE reverted_at IS NULL AND field NOT IN ('is_submitted','is_paid','_hidden') AND writeback_status='held')::int AS "feHeld",
            COUNT(*) FILTER (WHERE reverted_at IS NULL AND field NOT IN ('is_submitted','is_paid','_hidden') AND writeback_status='blocked')::int AS "feBlocked",
            COUNT(*) FILTER (WHERE reverted_at IS NOT NULL AND writeback_status='written')::int AS "staleWritten"
       FROM participant_edits`);
  const r = rows[0] || {};
  return {
    held: r.held || 0, blocked: r.blocked || 0, written: r.written || 0,
    fieldEdits: { written: r.feWritten || 0, held: r.feHeld || 0, blocked: r.feBlocked || 0 },
    staleWritten: r.staleWritten || 0,
  };
}

// 시뮬레이션(시트 무접촉): 전체 플랜(scope='all') + tier 라벨(base=토글cron/full=수동적용/manual=시뮬만/blocked).
async function simulateWriteback({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('simulateWriteback: sheetId, tabName 필수');
  const db = getPool();
  const sot = await getSourceOfTruth({ sheetId, tabName });
  const { ops, headers } = await _computeWritebackPlan(db, sheetId, tabName, { scope: 'all' });
  const byType = {}; const byTier = {};
  for (const o of ops) { byType[o.type] = (byType[o.type] || 0) + 1; byTier[o.tier] = (byTier[o.tier] || 0) + 1; }
  const summary = {
    total: ops.length,
    ok: ops.filter(o => o.guard === 'ok').length,
    risky: ops.filter(o => _WB_RISKY.includes(o.guard)).length,
    blocked: ops.filter(o => _WB_BLOCKED.includes(o.guard)).length,
    byType, byTier,
  };
  return { tabName, cutover: sot === 'db', triggerOn: process.env.TRACK_B_WRITEBACK_FULL === '1',
    mode: 'simulate', noMeta: !headers.length, ops, summary };
}

// 실제 적용(full tier) — 기본 완전 inert. TRACK_B_WRITEBACK_FULL=1 + cutover 이중게이트(수동·크론 미연결).
//   base 와 동일 엔진(단일 경로) — 안전군 필드편집까지, 위험군(소유권키/주문매핑칸/manual)은 held/시뮬만.
async function applyWritebackFull({ sheetId, tabName } = {}) {
  if (process.env.TRACK_B_WRITEBACK_FULL !== '1') return { skipped: true, reason: 'trigger_off' };   // ★ 시뮬레이션만
  if (!sheetId || !tabName) return { skipped: true, reason: 'missing_args' };
  if (await getSourceOfTruth({ sheetId, tabName }) !== 'db') return { skipped: true, reason: 'not_cutover' };
  const r = await _writebackEngine({ sheetId, tabName, tier: 'full' });
  return r.skipped ? r : { applied: true, ...r };
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
  ownedTabsForAdvertiser,
  createAdvertiserScoped,
  deleteAdvertiser,
  isRegisteredIntranetAdvertiser,
  staffOwnsAdvertiser,
  sheetAssignableByStaff,
  intranetAdvertisers, intranetStaffUsers, setAdvertiserInadPm,
  intranetSalesSearch,
  linkSettlement,
  unlinkSettlement,
  setSettlementVisible,
  settlementForTab,
  settlementSummaryForAdvertiser, saveTabMemo,
  settlementVisibleFor,
  generateCloseout,
  latestCloseout,
  closeoutCsv,
  listThread,
  addThread,
  setRequestStatus,
  deleteThread,
  markThreadSeen,
  unseenCounts,
  openRequestCounts,
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
  _wbOrderMappedMask,
  _wbIdentityOk,
  _computeWritebackPlan,
  _writebackEngine,
  workdeskTab,
  editWorkdeskRow,
  revertWorkdeskEdit,
  hideWorkdeskRow,
  addWorkdeskRow,
  listEdits,
  __setPoolForTest,
};
