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
    `SELECT reviewer_name AS name, phone8, is_submitted AS submitted, is_paid AS paid, round, source, active
       FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active = TRUE`,
    [sheetId, tabName]);
  const base = classifyParity(aRows, bRows);
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
function classifyParity(aRows, bRows) {
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
    else buckets.real.push({ kind: 'state_diff', phone8: _mask(p8), a: { s: a.submitted, p: a.paid, r: a.round }, b: { s: b.submitted, p: b.paid, r: b.round } });
  }
  // B-only
  for (const [p8, arr] of bByP) {
    if (aByP.has(p8)) continue;
    if (arr.some(x => x.source === 'manual')) buckets.benign.push({ bd: 'BD-6/manual', kind: 'b_only_manual', phone8: _mask(p8) });
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

// ── 통합 작업대 데이터(읽기): 세부 + 명단 + 상태 + (소통 placeholder). 역할별 PII 마스킹. ──
async function workdeskTab({ sheetId, tabName, tabGid, role = 'master', advertiserId = null } = {}) {
  if (!sheetId || !tabName) throw new Error('workdeskTab: sheetId, tabName 필수');
  const db = getPool();
  // 광고주는 소유 스코프 강제
  if (role === 'advertiser') {
    const scope = await scopedTabsForAdvertiser(advertiserId);
    const owns = scope.allTabSheetIds.includes(sheetId) ||
      (tabGid && scope.tabGids.includes(`${sheetId}::${tabGid}`));
    if (!owns) return { scoped: true, denied: true };
  }
  const maskPII = role === 'advertiser';   // 광고주 뷰는 리뷰어 개인정보 마스킹
  // 세부(작업발주 정형필드 우선 → 없으면 tab_configs/campaign)
  const { rows: meta } = await db.query(
    `SELECT tc.campaign_name AS "campaignName", tc.manager, tc.review_type AS "reviewType",
            tc.delivery_type AS "deliveryType", tc.income_type AS "incomeType"
       FROM tab_configs tc WHERE tc.sheet_id=$1 AND tc.tab_name=$2 LIMIT 1`, [sheetId, tabName]);
  const { rows: wo } = await db.query(
    `SELECT title, product_option AS "productOption", daily_count AS "dailyCount",
            purchase_time AS "purchaseTime", delivery_type AS "deliveryType", recruit_count AS "recruitCount"
       FROM work_orders WHERE linked_tab_sheet_id=$1 AND linked_tab_name=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, [sheetId, tabName]).catch(() => ({ rows: [] }));
  // 명단(활성)
  const { rows: roster } = await db.query(
    `SELECT id, seq, reviewer_name AS "name", recipient_name AS "recipient", phone8,
            round, option_text AS "option", product_name AS "product",
            is_submitted AS "submitted", is_paid AS "paid", source, order_submission_id AS "orderId"
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active = TRUE
      ORDER BY seq`, [sheetId, tabName]);
  const counts = {
    total: roster.length,
    submitted: roster.filter(r => r.submitted).length,
    paid: roster.filter(r => r.paid).length,
  };
  return {
    role, maskPII,
    meta: meta[0] || {}, detail: wo[0] || null,
    counts,
    roster: roster.map(r => ({
      id: r.id, seq: r.seq,
      name: r.name, recipient: r.recipient,
      phone8: maskPII ? _mask(r.phone8) : r.phone8,
      round: r.round, option: r.option, product: r.product,
      submitted: r.submitted, paid: r.paid, source: r.source, hasOrder: !!r.orderId,
    })),
  };
}

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
  workdeskTab,
  __setPoolForTest,
};
