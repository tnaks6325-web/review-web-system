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
async function parityReport({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('parityReport: sheetId, tabName 필수');
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
  const base = classifyParity(aRows, bRows, editedKeys);
  // d4/d5/d6 는 A↔B "차이"가 아니라 전환 준비도(coverage/귀속) 관측 — data-parity pass 를 뒤집지 않음(별도).
  const readiness = await _readinessFor({ sheetId, tabName });
  return { ...base, readiness };
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

  // d4 작업발주 연결/충실도
  const { rows: wo } = await db.query(
    `SELECT title, product_option AS "productOption", daily_count AS "dailyCount",
            purchase_time AS "purchaseTime", delivery_type AS "deliveryType", recruit_count AS "recruitCount"
       FROM work_orders WHERE linked_tab_sheet_id=$1 AND linked_tab_name=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, [sheetId, tabName]).catch(() => ({ rows: [] }));
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
            EXISTS(SELECT 1 FROM work_orders wo WHERE wo.deleted_at IS NULL
                     AND wo.linked_tab_sheet_id=b.sheet_id AND wo.linked_tab_name=b.tab_name) AS "woLinked"
       FROM b LEFT JOIN raw_sheet_tabs rst ON rst.sheet_id=b.sheet_id AND rst.tab_name=b.tab_name
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
    };
  });
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

function _akey(type, value) { return type + '\t' + value; }   // 앵커 조합키(정렬무관, 값에 탭 없음)

// ── 통합 작업대 데이터(읽기): 세부 + 명단 + 상태 + 활성 오버레이 read-time 합성. 역할별 PII 마스킹. ──
//   ★ 물리행은 순수 투영(review_index 사본) 유지 — 편집은 participant_edits(오버레이)에만 살고 여기서 합성만.
//     정렬/재투영이 물리행을 덮어도 편집 무손실·무오염(교차노출 근본 차단). staff는 라우트가 이미 차단.
async function workdeskTab({ sheetId, tabName, tabGid, role = 'master', advertiserId = null } = {}) {
  if (!sheetId || !tabName) throw new Error('workdeskTab: sheetId, tabName 필수');
  const db = getPool();
  if (role === 'advertiser') {
    const scope = await scopedTabsForAdvertiser(advertiserId);
    const owns = scope.allTabSheetIds.includes(sheetId) ||
      (tabGid && scope.tabGids.includes(`${sheetId}::${tabGid}`));
    if (!owns) return { scoped: true, denied: true };
  }
  const maskPII = role === 'advertiser';       // 광고주 뷰는 리뷰어 개인정보 마스킹
  const showEdits = role !== 'advertiser';     // 편집 어포던스·orphan·hidden은 내부(master/admin)만
  const { rows: meta } = await db.query(
    `SELECT tc.campaign_name AS "campaignName", tc.manager, tc.review_type AS "reviewType",
            tc.delivery_type AS "deliveryType", tc.income_type AS "incomeType"
       FROM tab_configs tc WHERE tc.sheet_id=$1 AND tc.tab_name=$2 LIMIT 1`, [sheetId, tabName]);
  const { rows: wo } = await db.query(
    `SELECT title, product_option AS "productOption", daily_count AS "dailyCount",
            purchase_time AS "purchaseTime", delivery_type AS "deliveryType", recruit_count AS "recruitCount"
       FROM work_orders WHERE linked_tab_sheet_id=$1 AND linked_tab_name=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, [sheetId, tabName]).catch(() => ({ rows: [] }));
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
    syn.phone8 = maskPII ? _mask(syn.phone8) : syn.phone8;
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
  const res = { role, maskPII, meta: meta[0] || {}, detail: wo[0] || null, counts, roster: out };
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
    await client.query('COMMIT');
    return { ok: true, editId: ins.rows[0].id, anchorType, field, value: kind === 'bool' ? vBool : vText };
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
    const { rowCount } = await client.query(
      `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
        WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type=$4 AND anchor_value=$5 AND field=$6 AND reverted_at IS NULL`,
      [String(by).slice(0, 100), sheetId, tabName, a.type, a.value, field]);
    await client.query('COMMIT');
    return { ok: true, reverted: rowCount };
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

module.exports = {
  identityKey,
  classifyParity,
  projectTab,
  projectActive,
  parityReport,
  setOwnership,
  removeOwnership,
  listOwnership,
  listAdvertisersWithOwnership,
  scopedTabsForAdvertiser,
  overview,
  workdeskTab,
  editWorkdeskRow,
  revertWorkdeskEdit,
  hideWorkdeskRow,
  addWorkdeskRow,
  __setPoolForTest,
};
