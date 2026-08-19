/**
 * ═══════════════════════════════════════════════════════════
 * Track B — 백그라운드 평행 트랙(DB-first 리뷰웹시스템[3버전]의 그림자).
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
const cm = require('../utils/contractMatch');   // 작업명↔계약 유사도 판정 단일 출처(순수함수)
const { hasCashReceiptSlot, cashReceiptNote } = require('../utils/captureSlots');   // 현영 판정 단일 규칙(재구현 금지)
const workdeskOrderDelete = require('./workdeskOrderDelete.service');
const { TRACKING_HEADER_RE, isTrackingHeader } = require('../utils/trackingColumn');   // 택배송장 열 판정 단일 출처(사본 금지)

let _pool;
let _rebuildLedgersForTest = null;
function getPool() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }
function __setLedgerRebuildForTest(fn) { _rebuildLedgersForTest = typeof fn === 'function' ? fn : null; }
async function _rebuildWorkdeskLedgers(args) {
  if (_rebuildLedgersForTest) return _rebuildLedgersForTest(args);
  return require('./sheetlessLedger.service').rebuildLedgers(args);
}

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
  if (ik) return { type: 'identity', value: ik };
  // ★★ 아직 아무도 배정되지 않은 **빈 준비 자리**(작업표 슬롯·시트 선기입 줄)는 이름·연락처가 없어
  //    identity 앵커를 만들 수 없다. 종전엔 앵커 없음 = 그 줄 전체 편집 잠금이라, 시트에서 늘 하던
  //    "빈 줄에 송장·비고를 미리 적어 두기"가 작업보드에서 **구조적으로 불가능**했다(사용자 신고).
  //    → 물리행 id 를 앵커로 쓴다. 투영 업서트가 (sheet_id, tab_name, seq) 기준이라 그 id 는
  //    재투영에도 보존되므로 manual 물리행과 **같은 수준으로 안정적**이다(정렬 면역 규율 유지).
  //  ⚠ 나중에 주문이 붙으면 앵커가 order 로 **승격**한다 — 그때 이 값이 화면에서 사라지지 않도록
  //    읽는 쪽(workdeskTab)이 물리행 앵커 오버레이를 밑에 깔아 함께 합성한다(아래 `_rowAnchorKey`).
  return _rowAnchorId(row) ? { type: 'manual', value: _rowAnchorId(row) } : null;
}
function _rowAnchorId(row) { return row && row.id != null ? String(row.id) : ''; }
// 편집 가능 필드 → 형태(bool/text). '_hidden'=제거 오버레이(import행). 화이트리스트(인젝션·형오류 차단).
const _EDIT_FIELD_KIND = {
  reviewer_name: 'text', recipient_name: 'text', round: 'text', option_text: 'text',
  product_name: 'text', phone8: 'text', _hidden: 'bool',
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
  /* ★★ 무시트 탭에서 `review_index` 는 `campaign_participants` 의 **파생물**(sheetlessLedger)이다.
     그래서 "명단에 없다"가 "원본에서 사라졌다"를 의미할 수 없다 — 제거 채널은 `deleted_at` 뿐이다.
     여기서 비활성으로 내리면 장부 재생성이 늦은 순간에 줄이 통째로 사라진다(132).
     ★ 판정 실패는 종전 경로(fail-open) — 시트 기반이 절대 다수다. */
  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(getPool(), sheetId, tabName); } catch (_) {}
  // 1) 로스터 임포트(review_index→campaign_participants). 기존 검증된 경로 재사용(시트 재읽기 0).
  const imp = await participants.importTabFromIndex({ sheetId, tabName, by });
  // 2) 신원키 + 주문링크 강화(라이브 order_submissions를 읽어 B에만 씀).
  const enr = await _enrichTab({ sheetId, tabName });
  // 3) seen-set: 이번 임포트에 안 보인 import행 → 비활성(하드삭제 아님, 이력 보존).
  const rec = sheetless ? { deactivated: 0, reconcileSkipped: 'sheetless' }
                        : await _reconcileSeen({ sheetId, tabName, runStart });
  return { ...imp, ...enr, ...rec, sheetless };
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
  /* ★★ 주문 **링크**는 phone8 만으로 정하지 않는다 (2026-08-19 실사고 — 장수산업).
     한 리뷰어가 같은 작업에 여러 번 참여하면 `byPhone` 은 그중 **한 건만** 남기므로, 링크가 비어
     있던 줄마다 **그 한 주문**이 붙는다 → 서로 다른 날의 별개 참여가 "한 주문이 여러 줄에 기록됨"
     으로 보이고, 중복 정리가 뒤 줄을 내린다(실측: 8/19 줄이 8/4 주문 링크를 들고 있었다).
     → 표에 적힌 주문번호와 원장 주문번호가 **같을 때만** 링크한다. 표 번호가 없을 때만 phone8 로
     떨어지고, 그마저도 **그 사람 주문이 그 탭에 유일할 때만**(모호하면 링크하지 않는다).
     ★ `identity_key` 계산은 종전 그대로 phone8 매칭을 쓴다 — 그 값은 편집 오버레이의 앵커라
       바꾸면 사람이 적어 둔 값이 조용히 끊긴다(좁히는 것은 링크뿐). */
  const byOrderNum = new Map();   // 주문번호(숫자만) → 주문 | '__AMBIG__'
  for (const o of orders) {
    const n = String(o.order_num || '').replace(/\D/g, '');
    if (n.length < 6) continue;
    byOrderNum.set(n, byOrderNum.has(n) ? '__AMBIG__' : o);
  }
  const phoneOrderCount = new Map();
  for (const o of orders) {
    const p8 = _phone8(o.phone);
    if (p8) phoneOrderCount.set(p8, (phoneOrderCount.get(p8) || 0) + 1);
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
    /* 링크 대상은 위 규율대로 따로 고른다(표 주문번호 일치 우선 · 없으면 그 사람 주문이 유일할 때만). */
    let linkOrd = null;
    const rowNum = String(orderNum || '').replace(/\D/g, '');
    if (rowNum.length >= 6) {
      const hit = byOrderNum.get(rowNum);
      if (hit && hit !== '__AMBIG__') linkOrd = hit;
    } else if (p.phone8 && phoneOrderCount.get(p.phone8) === 1) {
      linkOrd = ord || null;
    }
    let ik, orderId = null, price = null;
    if (ord) {
      ik = ord.dedup_key || identityKey({ orderNum: ord.order_num, recipient: ord.recipient, phone8: ord.phone, dateStr: ord.date_str, optKey: ord.selected_opt_key });
      if (linkOrd) { orderId = linkOrd.id; orderLinked++; }
      price = ord.price || null;
    } else {
      ik = identityKey({ orderNum, recipient: p.recipient_name, phone8: p.phone8, dateStr: '', optKey: p.option_text });
    }
    /* phone8 매칭이 없어도 표 주문번호가 원장과 정확히 맞으면 링크한다(그 반대는 하지 않는다). */
    if (!orderId && linkOrd) { orderId = linkOrd.id; price = price || linkOrd.price || null; orderLinked++; }
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
//   ★ 한 사이클에 훑는 탭 수 상한. 크론(cron.js)이 인자 없이 부르므로 이 값이 곧 "1회 투영 대상 수"다 —
//     활성 탭이 이보다 많으면 목록 뒤쪽(제목·탭명 정렬 기준)은 그 사이클에서 아예 대상이 안 된다.
//     projectionCoverage() 가 이 상수를 그대로 실어 보내 화면이 미투영 사유를 설명한다(사본 금지).
const PROJECT_ACTIVE_DEFAULT_LIMIT = 100;
async function projectActive({ limit = PROJECT_ACTIVE_DEFAULT_LIMIT, by = 'trackB-cron' } = {}) {
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
  /* ★ 줄 번호(`row_index` ↔ `seq`)를 함께 읽는다 — 짝짓기 키는 여전히 phone8 이고,
   *   줄 번호는 **한 번호에 여러 줄인 사람의 그룹 안에서만** 짝을 맞추는 데 쓴다(classifyParity 주석). */
  const { rows: aRows } = await db.query(
    `SELECT reviewer_name AS name, phone8, is_submitted AS submitted,
            (is_submitted2 = 'PAID') AS paid, round, row_index AS row
       FROM review_index WHERE sheet_id=$1 AND tab_name=$2 AND row_index IS NOT NULL`,
    [sheetId, tabName]);
  const { rows: bRows } = await db.query(
    `SELECT id, reviewer_name AS name, phone8, is_submitted AS submitted, is_paid AS paid, round, source, active,
            order_submission_id, identity_key, recipient_name, option_text, row_json, seq AS row
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
/**
 * ★★ 한 번호에 여러 줄인 사람은 **줄 번호로 짝을 맞춘다** (2026-08-07 운영 실측 오탐 수정).
 *
 * 종전에는 phone8 로 묶은 뒤 **각 목록의 첫 줄(`arr[0]` vs `bl[0]`)** 만 맞대 봤다. 그런데
 * 가족이 한 번호를 쓰거나 같은 사람이 차수를 나눠 여러 번 참여한 작업에서는 A(검색 명단)와
 * B(작업보드 표)의 **줄 순서가 달라 서로 다른 줄끼리** 비교돼 "설명되지 않는 차이"가 났다 —
 * 실측: 시트와 표를 줄 번호로 대조하면 2,300여 줄이 **한 칸도 다르지 않은데** 9개 작업이
 * 이관에서 잠겨 있었다(위프 800건·장수산업 900건 등).
 *
 * ★ 짝짓기 **키는 여전히 phone8**(행번호 금지 원칙 불변) — 줄 번호는 그 그룹 **안에서만** 쓴다.
 *   그래서 A_only/B_only(멤버십) 판정은 종전과 완전히 같다.
 * ★ 번호로 못 맞춘 줄은 **종전대로 순서대로** 맞댄다(폴백) — 못 맞췄다고 통과시키지 않는다.
 * ★ 그룹 안에서 한 쌍이라도 어긋나면 그 사람은 real (fail-closed 방향 불변).
 */
function _pairByRow(arr, bl) {
  const bByRow = new Map();
  for (const b of bl) { if (b.row != null) { const k = String(b.row); if (!bByRow.has(k)) bByRow.set(k, []); bByRow.get(k).push(b); } }
  const used = new Set(), pairs = [], aRest = [];
  for (const a of arr) {
    const cand = a.row != null ? (bByRow.get(String(a.row)) || []) : [];
    const b = cand.find(x => !used.has(x));
    if (b) { used.add(b); pairs.push([a, b]); } else aRest.push(a);
  }
  const bRest = bl.filter(x => !used.has(x));
  for (let i = 0; i < Math.min(aRest.length, bRest.length); i++) pairs.push([aRest[i], bRest[i]]);
  return pairs;
}
const _sameState = (a, b) => a.submitted === b.submitted && a.paid === b.paid && a.round === b.round;

function classifyParity(aRows, bRows, editedKeys = new Set()) {
  const norm = r => ({ p8: _phone8(r.phone8), name: _norm(r.name), submitted: !!r.submitted, paid: !!r.paid, round: _norm(r.round), source: r.source, row: (r.row == null ? null : r.row) });
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
    // 상태 대조 — 그 사람의 줄들을 **줄 번호로 짝지어** 전부 비교(한 쌍이라도 어긋나면 real).
    const pairs = _pairByRow(arr, bl);
    const bad = pairs.find(([a, b]) => !_sameState(a, b));
    if (!bad) buckets.match++;
    else if (editedKeys.has(p8)) buckets.benign.push({ bd: 'BD-8/edited', kind: 'state_edit', phone8: _mask(p8) });   // 의도된 편집 = benign
    else {
      const [a, b] = bad;
      // ★ 어느 줄이 다른지 함께 싣는다 — 화면·보고서가 "몇 행"인지 바로 말할 수 있어야 한다.
      buckets.real.push({ kind: 'state_diff', phone8: _mask(p8), row: a.row != null ? a.row : b.row,
        a: { s: a.submitted, p: a.paid, r: a.round }, b: { s: b.submitted, p: b.paid, r: b.round } });
    }
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
// ══ 작업(소유) 이관 — 시트 전체 또는 특정 탭의 소유를 다른 거래처로 옮긴다 (2026-08-10 위프코리아 건). ══
//   ★★ 한 트랜잭션(해제+지정) — 중간 실패로 "주인 없는 작업"이 남지 않는다.
//   ★ 탭 이관은 **시트전체 소유를 건드리지 않는다**(나머지 탭은 종전 업체 유지) — 판정은 기존 우선순위
//     "탭지정 > 시트전체"(advertiserForTab·scopedActiveTabs)가 정하고, 업체관리 표·개요도 같은 배제를 적용한다.
//   ★ 시트 전체 이관은 시트전체(tab_gid NULL) 행만 옮기고 **타 업체의 탭지정 세분 소유는 보존**해
//     `keptTabOverrides` 로 보고한다(조용한 삭제 금지 — 세분 소유는 사람이 명시한 더 강한 결정이다).
//   ★ 대상 검증 fail-closed: 업체 미존재·종료(ended) 거래처로는 이관하지 않는다.
async function transferOwnership({ sheetId, tabGid = null, toAdvertiserId, by = 'admin' } = {}) {
  const sid = String(sheetId || '').trim();
  const gid = String(tabGid == null ? '' : tabGid).trim() || null;
  const to = String(toAdvertiserId || '').trim();
  if (!sid || !to) return { ok: false, code: 400, error: 'sheetId, toAdvertiserId 필수' };
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: adv } = await client.query('SELECT id, name, status FROM advertisers WHERE id = $1', [to]);
    if (!adv.length) { await client.query('ROLLBACK'); return { ok: false, code: 404, error: '이관 대상 업체를 찾을 수 없습니다.' }; }
    if (String(adv[0].status || '') === 'ended') { await client.query('ROLLBACK'); return { ok: false, code: 400, error: '종료(삭제)된 거래처로는 이관할 수 없습니다.' }; }
    // ① 같은 범위(시트전체 또는 그 탭)의 타 업체 소유만 소프트 해제 — 다른 범위 행은 무접촉.
    const { rows: removed } = await client.query(
      `UPDATE advertiser_campaigns ac SET deleted_at = NOW()
         FROM advertisers a
        WHERE a.id = ac.advertiser_id AND ac.deleted_at IS NULL AND ac.sheet_id = $1
          AND COALESCE(ac.tab_gid, '') = COALESCE($2, '') AND ac.advertiser_id <> $3
        RETURNING ac.advertiser_id AS "advertiserId", a.name AS "advertiserName"`, [sid, gid, to]);
    // ② 새 소유 업서트(소프트 삭제됐던 행 재활성 포함) — setOwnership 과 같은 upsert 모양(사본 아님: 잠금 tx 안이라 client 로 실행).
    await client.query(
      `INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid, assigned_by)
         VALUES ($1,$2,$3,$4)
       ON CONFLICT (advertiser_id, sheet_id, COALESCE(tab_gid,'')) DO UPDATE
         SET deleted_at = NULL, assigned_by = EXCLUDED.assigned_by`, [to, sid, gid, String(by).slice(0, 100)]);
    // ③ 보고 재료 — 탭 이관이면 "나머지 탭을 계속 소유하는 시트전체 업체", 시트 이관이면 "보존된 탭지정 세분 소유".
    const { rows: kept } = await client.query(
      gid
        ? `SELECT a.name AS "advertiserName", NULL AS "tabGid" FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
            WHERE ac.deleted_at IS NULL AND ac.sheet_id = $1 AND ac.tab_gid IS NULL AND ac.advertiser_id <> $2`
        : `SELECT a.name AS "advertiserName", ac.tab_gid AS "tabGid" FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
            WHERE ac.deleted_at IS NULL AND ac.sheet_id = $1 AND ac.tab_gid IS NOT NULL AND ac.advertiser_id <> $2`,
      [sid, to]);
    await client.query('COMMIT');
    return {
      ok: true, toAdvertiserId: to, toAdvertiserName: adv[0].name,
      scope: gid ? 'tab' : 'sheet', tabGid: gid,
      removed: removed.map(r => r.advertiserName),
      ...(gid ? { keptSheetOwners: kept.map(r => r.advertiserName) } : { keptTabOverrides: kept.map(r => ({ advertiserName: r.advertiserName, tabGid: r.tabGid })) }),
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
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

// ══ 마감자료 검수 대기 판정 — ★★ 판정 단일 출처 ══════════════════════════════════════
//   "이제 마감해도 되는 작업" = 인원 충족 + 전건 제출 + 전건 입금(088 사용자 확정 ㉠의 마감 후보와 **같은 규칙**).
//   ★★ 재료는 홈 작업목록과 같은 tabStatsMap(index_master + review_index PAID) 하나다 —
//     업체관리가 campaign_participants(bTotal/bSub/bPaid)로 따로 세면 **같은 작업이 홈에서는 마감 후보,
//     업체관리에서는 아님**으로 갈린다(레포가 반복해 밟은 화면 간 불일치).
//   ★ 통계가 없으면 판정하지 않는다(false) — 모르면 제안하지 않는다. 제안 전용이라 자동 처리는 없다.
//   ★ 프론트는 이 불리언을 **그대로 소비**한다(화면 재계산 금지 — 홈 [공고] 버튼과 같은 규율).
function finishCandidate(stats) {
  if (!stats) return false;
  const total = Number(stats.total);
  if (!Number.isFinite(total) || total <= 0) return false;
  return (Number(stats.submitted) || 0) >= total && (Number(stats.paid) || 0) >= total;
}

// ══ 업체별 개요 집계 — 업체관리 첫 화면(업체 미선택)의 표 재료 ═══════════════════════════
//   ★★ 인트라넷 무접촉(로컬 DB만) — 그래서 항상 즉시 채워진다. 입금액은 인트라넷 sales 에만 있어
//     여기서 셀 수 없으므로 **개요에 미입금 열을 두지 않는다**(업체를 고르면 표에서 채워진다).
//     0 으로 꾸미거나 인트라넷을 17업체분 두들기는 쪽은 둘 다 택하지 않았다.
//   ★ 판정·집계는 연결탭 표와 **같은 재료**(tabStatsMap·finishedTabsMap·trackb_settlement_links)로
//     계산해 배지·칩·표 숫자가 갈리지 않게 한다.
//   ★ fail-soft 지만 **조용하지 않다** — 소스별 실패를 플래그로 올려 화면이 '?'로 고지한다(088 규율).
async function advertiserOverview() {
  const db = getPool();
  const out = { ok: true, byAdvertiser: {}, link: {}, statsUnavailable: false, finishedUnavailable: false, contractsUnavailable: false, linksUnavailable: false };
  // ① 업체 ↔ 소유 탭 (ownedTabsForAdvertiser 와 같은 소유 해석: 시트전체=그 시트 모든 탭 / 탭지정=그 탭만)
  let ownRows = [];
  try {
    const { rows } = await db.query(
      `WITH own AS (
         SELECT advertiser_id, sheet_id, tab_gid FROM advertiser_campaigns WHERE deleted_at IS NULL
       ), tabs AS (
         SELECT DISTINCT ON (rst.sheet_id, rst.tab_gid) rst.sheet_id, rst.tab_gid, rst.tab_name
           FROM raw_sheet_tabs rst
          WHERE rst.is_system_tab = FALSE
          ORDER BY rst.sheet_id, rst.tab_gid, rst.mirrored_at DESC
       )
       -- ★★ DISTINCT 필수(진짜 PG16 실측): 한 업체가 같은 시트의 **시트전체 + 탭지정을 동시에** 가지면
       --   그 탭이 두 own 행에 모두 매칭돼 작업 수가 이중 계수된다(이관을 탭→시트 순으로 두 번 하면 즉시 도달).
       --   연결탭 표(ownedTabsForAdvertiser)는 tabs CTE 의 DISTINCT ON 이 접어 주므로, 여기만 두면 두 화면이 갈린다.
       SELECT DISTINCT o.advertiser_id AS "advertiserId", t.sheet_id AS "sheetId",
              t.tab_gid AS "tabGid", t.tab_name AS "tabName"
         FROM tabs t JOIN own o ON o.sheet_id = t.sheet_id AND (
              o.tab_gid = t.tab_gid
              -- ★ 탭지정>시트전체 배제(ownedTabsForAdvertiser 와 같은 규칙) — 없으면 이관된 탭이
              --   두 업체의 작업 수에 **이중 계수**된다(개요 표 숫자 ≠ 연결탭 표 숫자).
              OR (o.tab_gid IS NULL AND NOT EXISTS (
                    SELECT 1 FROM advertiser_campaigns x
                     WHERE x.deleted_at IS NULL AND x.sheet_id = t.sheet_id
                       AND x.tab_gid = t.tab_gid AND x.advertiser_id <> o.advertiser_id)))`);
    ownRows = rows;
  } catch (err) {
    logger.warn(`[trackB] advertiserOverview 소유탭 조회 실패: ${err.message}`);
    return { ...out, ok: false };
  }
  // ② 계약 매칭된 (시트·탭) 집합
  const linked = new Set();
  try {
    const { rows } = await db.query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName" FROM trackb_settlement_links WHERE deleted_at IS NULL`);
    for (const r of rows) linked.add(_FIN_KEY(r.sheetId, r.tabName));
  } catch (err) {
    out.contractsUnavailable = true;
    logger.warn(`[trackB] advertiserOverview 계약 링크 조회 실패: ${err.message}`);
  }
  // ③ 통계·마감 (둘 다 캐시 — 홈이 이미 불러왔으면 왕복 0)
  const st = await tabStatsMap();
  const fin = await finishedTabsMap();
  out.statsUnavailable = !st.ok;
  out.finishedUnavailable = !fin.ok;
  // ④ 접속 링크 상태(업체별 1행) — 읽기만(없으면 미생성 = null, 여기서 만들지 않는다)
  try {
    const { rows } = await db.query(
      `SELECT advertiser_id AS "advertiserId", active, login_required AS "loginRequired",
              last_used_at AS "lastUsedAt", (token IS NOT NULL) AS "hasToken"
         FROM trackb_advertiser_links`);
    for (const r of rows) out.link[r.advertiserId] = { active: !!r.active, loginRequired: !!r.loginRequired, lastUsedAt: r.lastUsedAt, hasToken: !!r.hasToken };
  } catch (err) {
    out.linksUnavailable = true;
    logger.warn(`[trackB] advertiserOverview 접속링크 조회 실패: ${err.message}`);
  }
  for (const r of ownRows) {
    const k = _FIN_KEY(r.sheetId, r.tabName);
    const g = String(r.tabGid == null ? '' : r.tabGid).trim();
    const a = (out.byAdvertiser[r.advertiserId] ||= { works: 0, noMatch: 0, finishCand: 0 });
    a.works += 1;
    if (!out.contractsUnavailable && !linked.has(k)) a.noMatch += 1;
    // 마감 여부는 이름 우선 → gid 폴백(탭 리네임으로 마감이 조용히 풀리지 않게 — 088 과 같은 규칙)
    const finished = !!(fin.map[k] || (g && fin.map[_FIN_GKEY(r.sheetId, g)]));
    if (!finished && finishCandidate(st.map[k])) a.finishCand += 1;
  }
  return out;
}

// ── 이미 소유 지정된 시트 ID 집합 — 업체추가 폼의 시트 드롭다운에서 제외용(한 시트 중복 소유 방지). ──
//   활성 소유(deleted_at IS NULL)만. 시트전체(tab_gid NULL)·특정탭 소유 모두 그 시트를 '지정됨'으로 본다.
async function ownedSheetIds() {
  const { rows } = await getPool().query(
    `SELECT DISTINCT ac.sheet_id FROM advertiser_campaigns ac
       JOIN advertisers a ON a.id = ac.advertiser_id
      WHERE ac.deleted_at IS NULL AND a.status <> 'ended'`);
  return rows.map(r => r.sheet_id).filter(Boolean);
}

// ── 광고주 접속 링크(매직 링크) 관리 — master/admin(라우트 게이트). 업체당 1토큰(회전=교체)·폐기(active). ──
//   토큰은 추측불가 랜덤(base64url 24B). 실제 교환(로그인)은 auth.service.loginByLinkToken. Track A 무접촉.
async function getAdvertiserLink(advertiserId) {
  if (!advertiserId) return null;
  const { rows } = await getPool().query(
    `SELECT advertiser_id AS "advertiserId", token, active, login_required AS "loginRequired",
            last_used_at AS "lastUsedAt", created_at AS "createdAt"
       FROM trackb_advertiser_links WHERE advertiser_id = $1`, [advertiserId]);
  return rows[0] || null;
}
// 링크 자동 존재 보장 — 없으면 생성(있으면 유지). 업체 추가/조회 시 호출 → 모든 업체가 항상 고유 URL 보유.
async function ensureAdvertiserLink({ advertiserId, by = '' } = {}) {
  if (!advertiserId) return null;
  const token = require('crypto').randomBytes(24).toString('base64url');
  await getPool().query(
    `INSERT INTO trackb_advertiser_links (advertiser_id, token, active, created_by)
     VALUES ($1,$2,TRUE,$3) ON CONFLICT (advertiser_id) DO NOTHING`, [advertiserId, token, String(by).slice(0, 100)]);
  return await getAdvertiserLink(advertiserId);
}
async function generateAdvertiserLink({ advertiserId, by = '' } = {}) {
  if (!advertiserId) return { ok: false, code: 400, error: 'advertiserId 필수' };
  const exists = await getPool().query('SELECT 1 FROM advertisers WHERE id = $1', [advertiserId]);
  if (!exists.rows.length) return { ok: false, code: 404, error: '거래처를 찾을 수 없습니다.' };
  const token = require('crypto').randomBytes(24).toString('base64url');
  const { rows } = await getPool().query(
    `INSERT INTO trackb_advertiser_links (advertiser_id, token, active, created_by)
     VALUES ($1,$2,TRUE,$3)
     ON CONFLICT (advertiser_id) DO UPDATE
       SET token = EXCLUDED.token, active = TRUE, created_by = EXCLUDED.created_by, created_at = NOW(), last_used_at = NULL
     RETURNING token, active`, [advertiserId, token, String(by).slice(0, 100)]);
  logger.info(`[trackB] 광고주 접속링크 발급/회전: ${advertiserId} by ${by}`);
  return { ok: true, token: rows[0].token, active: rows[0].active };
}
async function setAdvertiserLinkActive({ advertiserId, active, by = '' } = {}) {
  if (!advertiserId) return { ok: false, code: 400, error: 'advertiserId 필수' };
  const { rows } = await getPool().query(
    `UPDATE trackb_advertiser_links SET active = $2 WHERE advertiser_id = $1 RETURNING token, active`,
    [advertiserId, active !== false]);
  if (!rows.length) return { ok: false, code: 404, error: '발급된 링크가 없습니다.' };
  logger.info(`[trackB] 광고주 접속링크 ${active !== false ? '활성' : '폐기'}: ${advertiserId} by ${by}`);
  return { ok: true, token: rows[0].token, active: rows[0].active };
}

// ── 광고주 계정 사용/미사용 토글 = 이 링크가 로그인을 요구하는지(083). master/admin(라우트 게이트). ──
//   OFF(기본) = 링크만으로 입장 / ON = 링크를 열면 로그인 화면. **계정 존재 여부와 무관한 명시 플래그**라
//   계정을 발급해 두고도 링크는 열어 둘 수 있다(끄려고 계정을 지울 필요 없음).
//   ★ 켤 때만 활성 계정 1개 이상을 요구한다 — 계정 0개인 채로 켜면 링크도 막히고 로그인도 불가해
//     **아무도 못 들어가는 잠금 상태**가 된다(끌 때는 계정을 건드리지 않으므로 검사 없음).
//   이전 관리 API 호환용: 호출하더라도 login_required 는 FALSE로만 저장한다.
//   링크 행이 아직 없으면 ensure 로 만든 뒤 적용하고, 없는 거래처는 404로 끝낸다.
async function setAdvertiserLinkLoginRequired({ advertiserId, by = '' } = {}) {
  if (!advertiserId) return { ok: false, code: 400, error: 'advertiserId 필수' };
  // Dedicated vendor links always open without a second login step. Legacy
  // callers can still clear the setting, but can no longer turn it back on.
  const exists = await getPool().query('SELECT 1 FROM advertisers WHERE id = $1', [advertiserId]);
  if (!exists.rows.length) return { ok: false, code: 404, error: '거래처를 찾을 수 없습니다.' };
  await ensureAdvertiserLink({ advertiserId, by });
  const { rows } = await getPool().query(
    `UPDATE trackb_advertiser_links SET login_required = FALSE
      WHERE advertiser_id = $1
      RETURNING login_required AS "loginRequired"`,
    [advertiserId]);
  if (!rows.length) return { ok: false, code: 404, error: '발급된 링크가 없습니다.' };
  logger.info(`[trackB] 광고주 전용 링크 무로그인 유지: ${advertiserId} by ${by}`);
  return { ok: true, loginRequired: rows[0].loginRequired };
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
async function ownedTabsForAdvertiser({ advertiserId, annotate = false } = {}) {
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
         JOIN own o ON o.sheet_id = rst.sheet_id AND (
              o.tab_gid = rst.tab_gid
              -- ★ 시트전체 소유의 전개는 "타 업체가 탭지정으로 가져간 탭"을 제외한다(이관 정합) —
              --   판정 우선순위(탭지정>시트전체, advertiserForTab·scopedActiveTabs)와 같은 규칙.
              --   빼면 이관된 작업이 옛 업체 표에도 계속 남아 "이관했는데 그대로"로 보인다.
              OR (o.tab_gid IS NULL AND NOT EXISTS (
                    SELECT 1 FROM advertiser_campaigns x
                     WHERE x.deleted_at IS NULL AND x.sheet_id = rst.sheet_id
                       AND x.tab_gid = rst.tab_gid AND x.advertiser_id <> $1)))
        WHERE rst.is_system_tab = FALSE
        ORDER BY rst.sheet_id, rst.tab_gid, rst.mirrored_at DESC
     )
     SELECT t.sheet_id AS "sheetId", t.spreadsheet_title AS "spreadsheetTitle", t.tab_gid AS "tabGid",
            t.tab_name AS "tabName", t.row_count AS "rowCount", cnt.first_seen AS "firstSeenAt",
            cnt.total AS "bTotal", cnt.submitted AS "bSub", cnt.paid AS "bPaid",
            tc.manager, tc.folder_url AS "folderUrl", tc.capture_folder_url AS "captureFolderUrl",
            tc.capture_slots AS "captureSlots", tc.income_type AS "incomeType",
            COALESCE(tc.sheetless, FALSE) AS "sheetless",
            (tc.sheet_id IS NOT NULL) AS "hasTabConfig",
            wo.recruit_count AS "woRecruit", wo.start_date::text AS "woStartDate",
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
         SELECT w.recruit_count, w.start_date FROM trackb_work_order_links l JOIN work_orders w ON w.id = l.work_order_id
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
  // ── 자료 폴더 바로가기(시안 A) 재료 — ★ 쿼리 순증 0(tab_configs 를 이미 조인하고 있다).
  //   현영 대상 여부는 captureSlots.hasCashReceiptSlot 단일 규칙(홈 버튼·/tab-folders 와 같은 함수).
  //   ★ 판정 원재료(capture_slots JSONB·income_type)는 응답에서 **버린다** — 316행 × JSONB 는 그냥
  //     전송 낭비이고, 화면이 필요한 것은 불리언 하나다(프론트 재판정 금지 = 규칙이 갈라지지 않는다).
  for (const r of rows) {
    r.cashReceipt = hasCashReceiptSlot(r.captureSlots, r.incomeType);
    const note = cashReceiptNote(r.captureSlots, r.incomeType);
    if (note) r.cashReceiptNote = note;
    delete r.captureSlots; delete r.incomeType;
  }
  // ── 마감 여부·마감자료 검수 대기 주석 — ★ 판정은 finishCandidate 한 곳, 재료는 홈과 같은 tabStatsMap.
  //   화면(필터 칩·개요 배지)은 이 불리언을 그대로 소비한다(프론트 재계산 금지 = 숫자가 갈리지 않는다).
  //   ★ fail-soft: 통계·마감 조회가 죽어도 표는 뜬다(그 경우 판정만 false — 라우트가 플래그로 고지).
  // ★★ annotate 는 **opt-in** 이다 — tabStatsMap 은 review_index 전체 GROUP BY 라 CLAUDE.md 가
  //   "통계는 홈 전용, 작업바 로드엔 붙이지 않는다"로 못박은 비용이다. 이 함수의 소비처 중
  //   광고주 경로(advertiserWorkSummary → /my-work-summary, 무로그인 공개 링크로도 도달)와
  //   정산 요약·브랜드 배정은 주석을 쓰지 않으므로 켜지 않는다. 켜는 곳은 /ownership/tabs 하나.
  if (!annotate) return { rows, statsUnavailable: false, finishedUnavailable: false };
  // 브랜드 배정 동기화(094) — 광고주가 자기 화면에서 지정한 브랜드를 **내부 업체관리 표에도 그대로** 싣는다.
  //   내부 표의 기존 '브랜드' 열은 작업명에서 추정 파싱한 값이라 광고주 분류와 갈릴 수 있었다.
  //   지정값이 있으면 그것이 정답(brandName/brandColor), 없으면 종전 추정 파싱 폴백(프론트 _ownBrand 가 담당).
  //   ★ 조회 실패해도 표는 뜬다(fail-soft) — 브랜드 주석만 빠진다.
  let brandByTab = new Map();
  try {
    const { rows: bm } = await db.query(
      `SELECT m.sheet_id AS "sheetId", m.tab_name AS "tabName", b.id, b.name, b.color
         FROM trackb_brand_tab_map m
         JOIN trackb_brands b ON b.id = m.brand_id AND b.deleted_at IS NULL
        WHERE m.advertiser_id = $1`, [advertiserId]);
    brandByTab = new Map(bm.map(x => [x.sheetId + '\t' + x.tabName, x]));
  } catch (e) { logger.warn(`[trackB] 브랜드 배정 주석 생략: ${e.message}`); }
  const st = await tabStatsMap();
  const fin = await finishedTabsMap();
  for (const r of rows) {
    const k = _FIN_KEY(r.sheetId, r.tabName);
    const g = String(r.tabGid == null ? '' : r.tabGid).trim();
    r.finished = !!(fin.map[k] || (g && fin.map[_FIN_GKEY(r.sheetId, g)]));
    r.finishCand = !r.finished && finishCandidate(st.map[k]);
    const b = brandByTab.get(r.sheetId + '\t' + r.tabName);
    if (b) { r.brandId = b.id; r.brandName = b.name; r.brandColor = b.color; }
  }
  return { rows, statsUnavailable: !st.ok, finishedUnavailable: !fin.ok };
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
// ★★ 퇴사·비활성 직원은 후보에서 제외한다 — 판정 기준은 인트라넷 자신의 규칙 그대로
//   (`src/routes/api.ts`: `is_active === 0 || resigned_at`). 두 값 모두 범용 테이블 API 응답에 실려 온다
//   (`redactSensitive` 가 지우는 것은 password 뿐).
// ★ 필드가 아예 없으면(구버전 인트라넷 배포) **판정 불가 = 포함**(fail-open) — 모른다고 전 직원을 지우면
//   담당AE 지정이 통째로 막히는 막다른 길이 된다. 값이 있을 때만 판정한다.
const _RESIGNED_NAME_CAP = 200;
function _isResignedUser(r) {
  if (!r || typeof r !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(r, 'resigned_at')) {
    if (String(r.resigned_at == null ? '' : r.resigned_at).trim()) return true;   // 빈 문자열도 재직(인트라넷과 동일)
  }
  if (Object.prototype.hasOwnProperty.call(r, 'is_active')) {
    const v = r.is_active;
    if (v === 0 || v === '0' || v === false) return true;   // ★ null/undefined 는 "모름"이라 제외하지 않는다
  }
  return false;
}
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
        resigned: _isResignedUser(r),
      })).filter(r => r.name) };
    } catch (e) {
      logger.warn(`[trackB] 인트라넷 사용자(AE) 조회 실패: ${e.message}`);
      if (!_intraUserCache.rows) return { ok: false, error: 'intranet_unreachable', items: [] };
    }
  }
  const needle = String(q || '').trim().toLowerCase();
  const deptF = String(dept || '').trim().toLowerCase();   // 부서 정확일치 필터(예: 'AE') — 담당AE 후보를 해당 부서로 제한
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const scoped = (_intraUserCache.rows || [])
    .filter(r => !deptF || String(r.department || '').trim().toLowerCase() === deptF);
  const items = scoped
    .filter(r => !r.resigned)
    .filter(r => !needle || r.name.toLowerCase().includes(needle) || r.username.toLowerCase().includes(needle))
    .slice(0, lim)
    // ★ 응답 shape 은 종전 3필드 그대로 — `resigned` 는 내부 캐시 판정용이라 내보내지 않는다
    //   (items 는 어차피 재직자만이라 항상 false = 무의미한 필드, 데이터 최소화 계약도 유지).
    .map(r => ({ name: r.name, username: r.username, department: r.department }));
  // 퇴사자 이름은 "목록에 없음"과 "퇴사자"를 화면이 구분해 안내하기 위한 재료(이미 지정돼 있던 담당 AE 판정).
  //   빼기만 하고 침묵하면 퇴사자가 지정된 업체가 "직접 입력값"으로 보여 재지정 신호가 사라진다.
  const resignedNames = scoped.filter(r => r.resigned).map(r => r.name).slice(0, _RESIGNED_NAME_CAP);
  return { ok: true, items, resignedNames };
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
    // ── 계약 매칭(작업명 유사도) 재료 — 추가만. 기존 소비처(스텝퍼·정산 요약)는 이 필드를 안 본다.
    //    ★ 신형 계약등록 폼은 업체를 `business_name`(사업자명)에 넣는다(`advertiser_name`은 레거시라 대개 공란).
    businessName: String(r.business_name || '').trim(),
    brandProduct: String(r.brand_product || '').trim(),
    contractDetail: String(r.contract_detail || '').trim(),
    contractMonth: r.contract_month || null,
    registrationDate: r.registration_date || null,
    attributionMonth: r.attribution_month || null,
    contractAmount: Number(r.contract_amount) || 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 계약 매칭(계약 "연결" → "매칭") — 그 작업을 소유한 업체의 계약만 후보로 두고 작업명 유사도로 추천.
//   ★★ 종전 자유검색(intranetSalesSearch)은 전체 계약을 대상으로 해 **타 업체 계약을 남의 탭에 붙이는
//      오링크가 구조적으로 가능**했다. 후보를 업체로 좁히면 그 사고 자체가 안 생긴다.
//   ★ 인트라넷 D1 무접촉(HTTP GET 프록시만) — 이 경로도 읽기 전용.
// ══════════════════════════════════════════════════════════════════════════

// 탭 소유 업체(= Track B `advertisers`, 이름은 인트라넷 광고주DB `business_name` 과 정확일치가 강제됨).
//   탭지정 소유 > 시트전체 소유 우선(작업목록 그룹핑 주석과 같은 규칙). 조회 실패·미지정은 null.
async function advertiserForTab({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) return null;
  const db = getPool();
  const { rows } = await db.query(
    `SELECT a.id AS "advertiserId", a.name AS "advertiserName", ac.tab_gid AS "tabGid"
       FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
      WHERE ac.deleted_at IS NULL AND ac.sheet_id = $1
      ORDER BY a.name, ac.created_at`, [sheetId]).catch(() => ({ rows: [] }));
  if (!rows.length) return null;
  const scoped = rows.filter(r => r.tabGid != null);
  let hit = null;
  if (scoped.length) {
    const { rows: gids } = await db.query(
      `SELECT DISTINCT tab_gid FROM raw_sheet_tabs WHERE sheet_id=$1 AND tab_name=$2 AND tab_gid IS NOT NULL`,
      [sheetId, tabName]).catch(() => ({ rows: [] }));
    const gidSet = new Set(gids.map(g => String(g.tab_gid)));
    hit = scoped.find(r => gidSet.has(String(r.tabGid))) || null;
  }
  if (!hit) hit = rows.find(r => r.tabGid == null) || null;
  return hit ? { id: hit.advertiserId, name: hit.advertiserName } : null;
}

// 업체명으로 그 업체의 계약 목록. 30초 캐시(업체별).
//   ★★ 서버 응답을 **항상 이름으로 재필터**한다 — 인트라넷 `where` 파서는 값에 '=' 가 섞이거나 컬럼명이
//      없으면 절을 통째로 무시하고 **전체 계약**을 돌려준다(조용히 남의 계약이 후보로 섞임).
const _intraSalesByAdvCache = new Map();   // normalizedName → { at, items }
async function intranetSalesForAdvertiser(advertiserName) {
  const nm = String(advertiserName || '').trim();
  if (!nm) return { ok: true, items: [] };
  const key = cm.normalizeKey(nm);
  const now = Date.now();
  const cached = _intraSalesByAdvCache.get(key);
  if (cached && now - cached.at < 30 * 1000) return { ok: true, items: cached.items };

  const mine = (r) => cm.contractAdvertiserNames(r).some(n => cm.normalizeKey(n) === key);
  const out = new Map();
  let reached = false;
  const cols = nm.includes('=') ? [] : ['business_name', 'advertiser_name'];   // '=' 포함 이름은 where 파서가 못 씀
  for (const col of cols) {
    try {
      const j = await _intranetGet(`/api/tables/sales?where=${encodeURIComponent(`${col}=${nm}`)}&limit=200&sort=created_at&order=DESC`);
      reached = true;
      for (const raw of (j.data || [])) { const r = _mapSales(raw); if (mine(r)) out.set(r.salesId, r); }
    } catch (e) { logger.warn(`[trackB] 인트라넷 계약 조회 실패(${col}): ${e.message}`); }
  }
  // 폴백: 정확일치 조회로 0건이면 이름 검색 후 같은 기준으로 다시 거른다(표기·컬럼 차이 흡수).
  if (!out.size) {
    try {
      const j = await _intranetGet(`/api/tables/sales?search=${encodeURIComponent(nm)}&limit=200&sort=created_at&order=DESC`);
      reached = true;
      for (const raw of (j.data || [])) { const r = _mapSales(raw); if (mine(r)) out.set(r.salesId, r); }
    } catch (e) { logger.warn(`[trackB] 인트라넷 계약 검색 실패: ${e.message}`); }
  }
  if (!reached) return { ok: false, error: 'intranet_unreachable', items: [] };
  const items = [...out.values()];
  if (_intraSalesByAdvCache.size > 200) _intraSalesByAdvCache.clear();   // 업체 수만큼 무한정 쌓이지 않게(단순 상한)
  _intraSalesByAdvCache.set(key, { at: now, items });
  return { ok: true, items };
}

/**
 * 계약 매칭 후보 + 자동 추천.
 *   scope='advertiser'(기본) — 그 작업을 소유한 업체의 계약만. 업체 미지정·계약 0건이면 전체 검색으로 폴백하고
 *     `fallbackReason` 으로 그 사실을 화면에 **말한다**(조용히 전체를 보여주면 왜 남의 계약이 뜨는지 모른다).
 *   scope='all' — 담당자가 명시적으로 전체에서 찾을 때(계약이 다른 이름으로 등록된 경우의 탈출구).
 * 추천(recommendedSalesId)은 **업체 범위일 때만** 낸다 — 근거가 "그 업체 계약"일 때만 신뢰할 수 있다.
 */
async function contractCandidatesForTab({ sheetId, tabName, scope = 'advertiser', q = '' } = {}) {
  if (!sheetId || !tabName) return { ok: false, code: 400, error: 'sheetId, tabName 필수' };
  const adv = await advertiserForTab({ sheetId, tabName }).catch(() => null);
  const advKey = adv ? cm.normalizeKey(adv.name) : '';
  const decorate = (items) => items.map(it => Object.assign({}, it, {
    // 후보가 그 업체 계약인지(전체 검색에서 남의 계약을 고를 때 화면이 경고할 재료)
    advertiserMatch: advKey ? cm.contractAdvertiserNames(it).some(n => cm.normalizeKey(n) === advKey) : null,
  }));

  if (scope === 'all') {
    const r = await intranetSalesSearch({ q, limit: 50 });
    if (!r.ok) return { ok: false, error: r.error, scope: 'all', advertiser: adv, items: [] };
    const ranked = cm.rankContracts(tabName, r.items);
    return { ok: true, scope: 'all', advertiser: adv, items: decorate(ranked.items), recommendedSalesId: null, tie: false, parsed: ranked.parsed };
  }

  if (!adv) {
    return { ok: true, scope: 'all', advertiser: null, fallbackReason: 'no_advertiser', items: [], recommendedSalesId: null, tie: false };
  }
  const r = await intranetSalesForAdvertiser(adv.name);
  if (!r.ok) return { ok: false, error: r.error, scope: 'advertiser', advertiser: adv, items: [] };
  if (!r.items.length) {
    return { ok: true, scope: 'advertiser', advertiser: adv, fallbackReason: 'no_contracts', items: [], recommendedSalesId: null, tie: false };
  }
  const ranked = cm.rankContracts(tabName, r.items);
  return {
    ok: true, scope: 'advertiser', advertiser: adv,
    items: decorate(ranked.items), recommendedSalesId: ranked.recommendedSalesId, tie: ranked.tie, parsed: ranked.parsed,
  };
}

// 탭 ↔ 계약/견적 링크(탭당 활성 1, 소프트삭제 교체). trackb_settlement_links 만 write(인트라넷 무접촉).
//   Nit4: UPDATE+INSERT 를 단일 tx 로(동시 링크 유니크충돌·중간실패 시 무링크 방지).
//   S1: 링크된 계약의 업체명을 로그로 남겨 오링크(타 업체 계약을 남의 탭에 연결) 사후추적 — advertiserName 반환.
async function linkSettlement({ sheetId, tabName, salesId, quoteId = null, by = '' } = {}) {
  if (!sheetId || !tabName || !salesId) return { ok: false, code: 400, error: 'sheetId, tabName, salesId 필수' };
  let contractNumber = '', advertiserName = '';
  try {
    const j = await _intranetGet(`/api/tables/sales/${encodeURIComponent(salesId)}`);
    contractNumber = String((j.data && j.data.contract_number) || '').trim();
    // ★ 신형 계약은 업체를 business_name 에 넣는다(advertiser_name 은 레거시) — 둘 다 본다.
    advertiserName = String((j.data && (j.data.business_name || j.data.advertiser_name)) || '').trim();
  } catch (_) {}
  // 오링크(타 업체 계약을 남의 탭에 매칭) 경고 — ★ 차단은 하지 않는다(계약이 다른 이름으로 등록된 정상 케이스가 있다).
  //   화면이 확인을 받고 보내며, 여기서는 신호와 로그만 남긴다. 판정 불가(업체 미지정·조회 실패)는 null.
  let mismatch = null;
  try {
    const owner = await advertiserForTab({ sheetId, tabName });
    if (owner && advertiserName) mismatch = cm.normalizeKey(owner.name) !== cm.normalizeKey(advertiserName);
    if (mismatch) logger.warn(`[trackB] 정산 매칭 업체 불일치: ${sheetId}/${tabName}(소유:${owner.name}) ← 계약 업체:${advertiserName}`);
  } catch (_) {}
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
  return { ok: true, contractNumber, advertiserName, mismatch };
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
async function settlementForTab({ sheetId, tabName, role = 'master', advertiserId = null, brandId = null } = {}) {
  if (!sheetId || !tabName) throw new Error('settlementForTab: sheetId, tabName 필수');
  const db = getPool();
  const { rows } = await db.query(
    `SELECT sales_id AS "salesId", quote_id AS "quoteId", contract_number AS "contractNumber", linked_by AS "linkedBy"
       FROM trackb_settlement_links WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL LIMIT 1`, [sheetId, tabName]);
  const link = rows[0] || null;
  const isAdv = role === 'advertiser';
  // 광고주 노출 게이트(Q4-c 안전장치): 토글 OFF 면 정산 자체 비공개. 브랜드 세션은 브랜드 토글도 AND(094).
  if (isAdv && (!(await _settlementVisibleFor(advertiserId)) || (brandId && !(await _brandSettlementVisible(brandId))))) {
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
    // 입금매칭 누계/최근 입금일(광고주 정산 카드 금액 4칸용 — 내부 스텝퍼에도 추가만, 기존 필드 불변)
    paidAmount: sales ? sales.paidAmount : null,
    paidDate: sales ? _normIntraDate(sales.paidDate || sales.paymentDate) : null,
    salesInfo: sales ? { advertiserName: sales.advertiserName, productName: sales.productName, manager: isAdv ? undefined : sales.manager } : null,
  };
}

// ═══ 견적서·계산서 문서 뷰어(광고주 전체 작업 표의 칸 클릭 → 팝업) ═══
//   견적서 = 인트라넷 quotes 상세(품목 포함)를 프록시 + trackb_quote_snapshots 버전 적재(093).
//   계산서 = 인트라넷 tax_invoices(sales_id 역링크, 인트라넷 0087)를 프록시 — 발행 요약만(원본은 홈택스).
//   게이트는 settlementForTab 과 동일: 탭에 링크된 계약만 도달 + 광고주 settlement_visible.
const crypto = require('crypto');
function _mapQuoteFull(q) {
  if (!q) return null;
  let items = [];
  try { items = JSON.parse(q.items || '[]'); } catch (_) { items = []; }
  if (!Array.isArray(items)) items = [];
  return {
    quoteNumber: String(q.quote_number || '').trim(),
    quoteType: q.quote_type || 'online_marketing',
    receiver: q.receiver || '', workName: q.work_name || '',
    quoteDate: q.quote_date || null, validPeriod: q.valid_period || '',
    managerName: q.manager_name || '', managerPhone: q.manager_phone || '',
    items: items.slice(0, 20).map(it => ({
      name: String((it && it.name) || ''), unitPrice: Number(it && it.unit_price) || 0,
      count: Number(it && it.count) || 0, amount: Number(it && it.amount) || 0,
      tax: Number(it && it.tax) || 0, note: String((it && it.note) || ''),
    })),
    supplyAmount: Number(q.supply_amount) || 0, vatAmount: Number(q.vat_amount) || 0,
    totalAmount: Number(q.total_amount) || 0,
    status: q.status || 'draft', sentAt: q.sent_at || null, acceptedAt: q.accepted_at || null,
  };
}
// 내용 해시 — 상태 포함(내용이 같아도 draft→accepted 전이가 새 버전 = "초안/최종" 자동 라벨 근거).
function _quoteHash(quote) {
  const basis = JSON.stringify([quote.quoteNumber, quote.quoteType, quote.receiver, quote.workName,
    quote.quoteDate, quote.items, quote.supplyAmount, quote.vatAmount, quote.totalAmount, quote.status]);
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}
// 스냅샷 적재(append-only) — 최신 버전과 해시가 같으면 write 0회. 경합의 UNIQUE 충돌은 무해(다음 조회로 수렴).
async function _snapshotQuote(salesId, quote) {
  if (!salesId || !quote) return;
  const db = getPool(); const hash = _quoteHash(quote);
  const { rows } = await db.query(
    'SELECT version, content_hash FROM trackb_quote_snapshots WHERE sales_id=$1 ORDER BY version DESC LIMIT 1', [salesId]);
  if (rows.length && rows[0].content_hash === hash) return;
  const next = rows.length ? rows[0].version + 1 : 1;
  try {
    await db.query(
      'INSERT INTO trackb_quote_snapshots (sales_id, version, content_hash, payload) VALUES ($1,$2,$3,$4)',
      [salesId, next, hash, JSON.stringify(quote)]);
  } catch (e) { logger.warn(`quote snapshot insert skipped: ${e.message}`); }
}
async function _settlementLinkForTab(sheetId, tabName) {
  const { rows } = await getPool().query(
    `SELECT sales_id AS "salesId", contract_number AS "contractNumber"
       FROM trackb_settlement_links WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL LIMIT 1`, [sheetId, tabName]);
  return rows[0] || null;
}
// 견적서 문서(버전 이력 포함). 광고주 게이트 통과 못 하면 hidden(내용 미포함).
async function quoteDocForTab({ sheetId, tabName, role = 'master', advertiserId = null, brandId = null } = {}) {
  if (!sheetId || !tabName) throw new Error('quoteDocForTab: sheetId, tabName 필수');
  if (role === 'advertiser' && (!(await _settlementVisibleFor(advertiserId)) || (brandId && !(await _brandSettlementVisible(brandId))))) return { linked: false, hidden: true };
  const link = await _settlementLinkForTab(sheetId, tabName);
  if (!link || !link.salesId) return { linked: false };
  let quote = null, proxyDown = false;
  try {
    const j = await _intranetGet(`/api/tables/quotes?where=sales_id=${encodeURIComponent(link.salesId)}&limit=1`);
    quote = _mapQuoteFull((j.data || [])[0]);
  } catch (_) { proxyDown = true; }
  if (quote) await _snapshotQuote(link.salesId, quote);
  const { rows } = await getPool().query(
    'SELECT version, payload, captured_at AS "capturedAt" FROM trackb_quote_snapshots WHERE sales_id=$1 ORDER BY version ASC LIMIT 30', [link.salesId]);
  const versions = rows.map(r => ({ version: r.version, capturedAt: r.capturedAt, payload: r.payload }));
  // 스냅샷이 아직 없는데 라이브 견적은 있는 경우(insert 실패 등) 라이브를 v1처럼 노출(fail-soft).
  if (!versions.length && quote) versions.push({ version: 1, capturedAt: null, payload: quote });
  return { linked: true, contractNumber: link.contractNumber || '', proxyDown, versions };
}
// 계산서(전자세금계산서) 발행 요약 — sales 상태 + tax_invoices 이력(sales_id 역링크).
async function invoiceDocForTab({ sheetId, tabName, role = 'master', advertiserId = null, brandId = null } = {}) {
  if (!sheetId || !tabName) throw new Error('invoiceDocForTab: sheetId, tabName 필수');
  if (role === 'advertiser' && (!(await _settlementVisibleFor(advertiserId)) || (brandId && !(await _brandSettlementVisible(brandId))))) return { linked: false, hidden: true };
  const link = await _settlementLinkForTab(sheetId, tabName);
  if (!link || !link.salesId) return { linked: false };
  const sales = await _salesById(link.salesId);
  let records = [], proxyDown = false;
  try {
    const j = await _intranetGet(`/api/tables/tax_invoices?where=sales_id=${encodeURIComponent(link.salesId)}&limit=20`);
    records = (j.data || []).map(t => ({
      invoiceType: t.invoice_type || '', issueDate: t.issue_date || null,
      supplierName: t.supplier_name || '', recipientName: t.recipient_name || '',
      itemName: t.item_name || '',
      supplyAmount: Number(t.supply_amount) || 0, taxAmount: Number(t.tax_amount) || 0,
      totalAmount: Number(t.total_amount) || 0, status: t.status || '',
      // 팝빌 UID 는 뒤 4자리만(문서 대조용) — 전체 식별자는 내부 정보라 미노출.
      popbillTail: t.popbill_uid ? String(t.popbill_uid).slice(-4) : '',
    }));
  } catch (_) { proxyDown = true; }
  return {
    linked: true, contractNumber: link.contractNumber || '', proxyDown: proxyDown || (link.salesId && !sales),
    invoice: sales ? { status: sales.invoiceStatus, date: sales.invoiceDate } : null,
    amount: sales ? sales.amount : null,
    records,
  };
}

// ── 소유지정 연결탭 정산 요약(관제실 컬럼: 견적서일·계산서일·입금액/총비용·입금일) — 내부 전용 배치. ──
//   링크된 탭만 인트라넷 프록시(정산 링크 없는 탭은 프록시 0회). 같은 sales 를 공유하는 탭은 1회만 조회
//   (_salesById/_quoteForSales 20초 캐시 공유). fail-soft: sales 조회 실패 = proxyDown 표기(스로우 금지).
//   ★ 광고주 렌즈 없음 — 이 함수의 소비 라우트는 internalMiddleware(master/admin/staff)로 제한할 것.
async function settlementSummaryForAdvertiser({ advertiserId } = {}) {
  if (!advertiserId) throw new Error('settlementSummaryForAdvertiser: advertiserId 필수');
  const tabs = (await ownedTabsForAdvertiser({ advertiserId })).rows;
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
      quoteStatus: quote ? quote.status : null,
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
// ── 업체용 뷰어 "내 작업 목록"(화면 A) — 광고주 렌즈 요약 배치. ──
//   ownedTabsForAdvertiser(카운트) + settlementSummaryForAdvertiser(정산 배치)를 광고주에게 내도 되는
//   필드만으로 재구성한다. ★ 내부 필드(비고 memo·담당 manager·인트라넷 salesId·amountMismatch)는
//   여기서 폐기 — 화면에서만 감추는 건 devtools 에 보이는 보안연극이다(csBridge meta 규율과 동일).
//   정산 노출 토글 OFF 업체는 settlement 를 아예 계산·동봉하지 않는다(settlementHidden 신호만).
//   브랜드 렌즈(094): brandId 가 오면(브랜드 링크 세션) ① 그 브랜드에 배정된 탭만 ② 정산은
//   업체 토글 AND 브랜드 settlement_visible ③ 폴더 URL 은 folders_visible 아니면 폐기(서버에서 미전송).
//   대행사 세션(brandId 없음)에는 items[].brandId 주석 + brands 목록(관리 화면 재료)을 동봉한다.
async function advertiserWorkSummary({ advertiserId, brandId = null } = {}) {
  if (!advertiserId) throw new Error('advertiserWorkSummary: advertiserId 필수');
  const db = getPool();
  const { rows: bmap } = await db.query(
    'SELECT brand_id AS "brandId", sheet_id AS "sheetId", tab_name AS "tabName" FROM trackb_brand_tab_map WHERE advertiser_id=$1', [advertiserId]);
  const brandByTab = new Map(bmap.map(m => [m.sheetId + '\t' + m.tabName, m.brandId]));
  let brand = null;
  if (brandId) {
    const { rows: br } = await db.query(
      `SELECT id, name, color, settlement_visible, folders_visible FROM trackb_brands
        WHERE id=$1 AND advertiser_id=$2 AND deleted_at IS NULL`, [brandId, advertiserId]);
    if (!br.length) return { settlementHidden: true, brand: null, items: [] };   // 삭제된 브랜드 링크 = 빈 화면(fail-closed)
    brand = br[0];
  }
  let tabs = (await ownedTabsForAdvertiser({ advertiserId })).rows;
  if (brand) tabs = tabs.filter(t => brandByTab.get(t.sheetId + '\t' + t.tabName) === brand.id);
  const visible = (await _settlementVisibleFor(advertiserId)) && (!brand || brand.settlement_visible === true);
  let setlByTab = new Map();
  if (visible) {
    const setl = await settlementSummaryForAdvertiser({ advertiserId }).catch(() => []);   // fail-soft: 정산만 빠지고 목록은 뜬다
    setlByTab = new Map(setl.map(s => [s.sheetId + '\t' + s.tabName, s]));
  }
  const foldersOn = !brand || brand.folders_visible === true;
  const brandsOut = brandId ? undefined : (await brandsForAdvertiser({ advertiserId }).catch(() => null));
  return {
    settlementHidden: !visible,
    brand: brand ? { id: brand.id, name: brand.name, color: brand.color } : null,
    brands: brandsOut && brandsOut.ok ? brandsOut.brands : undefined,
    items: tabs.map(t => {
      const s = setlByTab.get(t.sheetId + '\t' + t.tabName) || null;
      return {
        sheetId: t.sheetId, tabGid: t.tabGid, tabName: t.tabName, spreadsheetTitle: t.spreadsheetTitle,
        active: t.active !== false,
        total: t.bTotal || 0, submitted: t.bSub || 0, paid: t.bPaid || 0,
        target: t.woRecruit || null,
        startDate: t.woStartDate ? String(t.woStartDate).slice(0, 10) : null,
        brandId: brandByTab.get(t.sheetId + '\t' + t.tabName) || null,
        // A안: 자료 폴더 바로가기 — 브랜드 세션은 folders_visible 토글이 꺼져 있으면 서버에서 폐기.
        folderUrl: foldersOn ? (t.folderUrl || null) : null,
        captureFolderUrl: foldersOn ? (t.captureFolderUrl || null) : null,
        settlement: s ? {
          contractNumber: s.contractNumber || '', proxyDown: !!s.proxyDown,
          quoteStatus: s.quoteStatus || null, quoteDate: s.quoteDate || null,
          invoiceStatus: s.invoiceStatus || null, invoiceDate: s.invoiceDate || null,
          totalCost: s.totalCost != null ? s.totalCost : null,
          paidAmount: s.paidAmount != null ? s.paidAmount : null,
          paidDate: s.paidDate || null,
          paymentStatus: s.paymentStatus || null,
        } : null,
      };
    }),
  };
}

// ═══ 브랜드 분류·화면 공유(094) — 대행사(광고주) 셀프서비스 ═══
//   시안 §3(사용자 확정): 셀프 분류 · 브랜드별 고유 링크 · 정산/폴더 기본 숨김 + 브랜드별 토글 · A안 브랜딩.
//   ★ 모든 함수가 advertiser_id 스코프 안에서만 동작(자기 브랜드·자기 소유 탭만) — IDOR 차단은 쿼리 조건이 담당.
function _brandRow(b) {
  return { id: b.id, name: b.name, color: b.color, linkToken: b.link_token, linkActive: b.link_active === true,
    settlementVisible: b.settlement_visible === true, foldersVisible: b.folders_visible === true };
}
async function brandsForAdvertiser({ advertiserId } = {}) {
  if (!advertiserId) return { ok: false, code: 400, error: 'advertiserId 필수' };
  const db = getPool();
  const { rows } = await db.query(
    `SELECT b.*, COALESCE(m.cnt,0) AS cnt
       FROM trackb_brands b
       LEFT JOIN (SELECT brand_id, COUNT(*) AS cnt FROM trackb_brand_tab_map GROUP BY brand_id) m ON m.brand_id=b.id
      WHERE b.advertiser_id=$1 AND b.deleted_at IS NULL ORDER BY b.created_at ASC`, [advertiserId]);
  return { ok: true, brands: rows.map(b => ({ ..._brandRow(b), tabCount: Number(b.cnt) || 0 })) };
}
async function createBrand({ advertiserId, name, color } = {}) {
  const nm = String(name || '').trim().slice(0, 60);
  if (!advertiserId || !nm) return { ok: false, code: 400, error: '브랜드 이름을 입력하세요.' };
  // 같은 대행사 안 이름 중복 거부 — 브랜드사 화면·링크 배포에서 어느 쪽인지 구분이 안 되면 오배포로 이어진다.
  //   프론트도 먼저 막지만(왕복 절약) 판정은 서버가 한다(두 탭 동시 입력·새로고침 타이밍).
  const dup = await getPool().query(
    'SELECT 1 FROM trackb_brands WHERE advertiser_id=$1 AND deleted_at IS NULL AND LOWER(TRIM(name))=LOWER($2) LIMIT 1',
    [advertiserId, nm]);
  if (dup.rows.length) return { ok: false, code: 400, error: `이미 "${nm}" 브랜드가 있습니다` };
  const id = 'brd_' + require('crypto').randomBytes(6).toString('hex');
  const token = require('crypto').randomBytes(24).toString('base64url');
  const col = /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? color : '#2563eb';
  const { rows } = await getPool().query(
    `INSERT INTO trackb_brands (id, advertiser_id, name, color, link_token) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, advertiserId, nm, col, token]);
  return { ok: true, brand: { ..._brandRow(rows[0]), tabCount: 0 } };
}
async function updateBrand({ advertiserId, brandId, action, name, color, on } = {}) {
  if (!advertiserId || !brandId) return { ok: false, code: 400, error: 'brandId 필수' };
  const db = getPool();
  const own = await db.query('SELECT id FROM trackb_brands WHERE id=$1 AND advertiser_id=$2 AND deleted_at IS NULL', [brandId, advertiserId]);
  if (!own.rows.length) return { ok: false, code: 404, error: '브랜드를 찾을 수 없습니다.' };
  if (action === 'rename') {
    const nm = String(name || '').trim().slice(0, 60); if (!nm) return { ok: false, code: 400, error: '이름을 입력하세요.' };
    const col = /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? color : null;
    await db.query(`UPDATE trackb_brands SET name=$2${col ? ', color=$3' : ''} WHERE id=$1`, col ? [brandId, nm, col] : [brandId, nm]);
    return { ok: true };
  }
  if (action === 'delete') {   // soft delete — 링크 즉시 무효(loginByLinkToken 이 deleted_at 검사) + 배정 해제
    await db.query('UPDATE trackb_brands SET deleted_at=NOW(), link_active=FALSE WHERE id=$1', [brandId]);
    await db.query('DELETE FROM trackb_brand_tab_map WHERE brand_id=$1', [brandId]);
    return { ok: true };
  }
  if (action === 'link-active') { await db.query('UPDATE trackb_brands SET link_active=$2 WHERE id=$1', [brandId, on === true]); return { ok: true }; }
  if (action === 'link-rotate') {   // 유출 대응 — 새 토큰 발급(이전 링크 즉시 무효)
    const token = require('crypto').randomBytes(24).toString('base64url');
    await db.query('UPDATE trackb_brands SET link_token=$2, link_active=TRUE WHERE id=$1', [brandId, token]);
    return { ok: true, linkToken: token };
  }
  if (action === 'settlement-visible') { await db.query('UPDATE trackb_brands SET settlement_visible=$2 WHERE id=$1', [brandId, on === true]); return { ok: true }; }
  if (action === 'folders-visible') { await db.query('UPDATE trackb_brands SET folders_visible=$2 WHERE id=$1', [brandId, on === true]); return { ok: true }; }
  return { ok: false, code: 400, error: '알 수 없는 action: ' + action };
}
// 배정 전체 교체(배정 모달 저장) — tabs 에 있는 탭은 이 브랜드로, 이 브랜드에 배정돼 있었는데 빠진 탭은 해제.
//   ★ 소유 검증: ownedTabsForAdvertiser 목록에 없는 탭은 조용히 무시(다른 업체 탭 배정 불가).
async function assignBrandTabs({ advertiserId, brandId, tabs } = {}) {
  if (!advertiserId || !brandId) return { ok: false, code: 400, error: 'brandId 필수' };
  const db = getPool();
  const own = await db.query('SELECT id FROM trackb_brands WHERE id=$1 AND advertiser_id=$2 AND deleted_at IS NULL', [brandId, advertiserId]);
  if (!own.rows.length) return { ok: false, code: 404, error: '브랜드를 찾을 수 없습니다.' };
  const owned = new Set((await ownedTabsForAdvertiser({ advertiserId })).rows.map(t => t.sheetId + '\t' + t.tabName));
  const want = [];
  for (const t of (Array.isArray(tabs) ? tabs : []).slice(0, 2000)) {
    const sid = String((t && t.sheetId) || ''), tn = String((t && t.tabName) || '');
    if (sid && tn && owned.has(sid + '\t' + tn)) want.push([sid, tn]);
  }
  await db.query('DELETE FROM trackb_brand_tab_map WHERE brand_id=$1', [brandId]);   // 전체 교체(빠진 탭 = 해제)
  for (const [sid, tn] of want) {
    await db.query(
      `INSERT INTO trackb_brand_tab_map (brand_id, advertiser_id, sheet_id, tab_name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (advertiser_id, sheet_id, tab_name) DO UPDATE SET brand_id=$1`, [brandId, advertiserId, sid, tn]);
  }
  return { ok: true, assigned: want.length };
}
// 브랜드 세션의 탭 스코프(라우트 _ensureThreadScope 가 호출) — 브랜드에 배정된 탭만 접근.
async function brandTabAllowed({ brandId, advertiserId, sheetId, tabName } = {}) {
  if (!brandId || !advertiserId || !sheetId || !tabName) return false;
  const { rows } = await getPool().query(
    'SELECT 1 FROM trackb_brand_tab_map WHERE brand_id=$1 AND advertiser_id=$2 AND sheet_id=$3 AND tab_name=$4 LIMIT 1',
    [brandId, advertiserId, sheetId, tabName]);
  return rows.length > 0;
}
async function _brandSettlementVisible(brandId) {
  const { rows } = await getPool().query('SELECT settlement_visible FROM trackb_brands WHERE id=$1 AND deleted_at IS NULL', [brandId]);
  return rows.length ? rows[0].settlement_visible === true : false;   // 브랜드 못 찾으면 fail-closed(숨김)
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
//   ★ SF-3: 제거(_hidden) 오버레이 행은 제외(작업보드에서 안 보이는 행이 CSV에 재등장 방지),
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
  // ★ order 앵커도 센다 — `order_submission_id` 는 유니크가 아니다(작업보드 합성과 같은 규율).
  //   마감자료가 그리드와 다른 게이트를 쓰면 "화면엔 안 뜨는 입금일이 마감자료에는 남는" 상태가 된다.
  const anchorCount = new Map();
  for (const r of rows) {
    const a = _deriveAnchor(r);
    if (!a || a.type === 'manual') continue;
    const k = _akey(a.type, a.value);
    anchorCount.set(k, (anchorCount.get(k) || 0) + 1);
  }
  const out = [];
  for (const r of rows) {
    const anchor = _deriveAnchor(r);
    let ov = {};
    if (anchor && !(anchor.type !== 'manual' && (anchorCount.get(_akey(anchor.type, anchor.value)) || 0) > 1)) {
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

// ── 투영 커버리지: "투영 대상 활성 탭" 중 B 원장에 행이 아직 없는 탭(=미투영) 집계 · 읽기 전용 ──
//   ★★ 이 요약이 필요한 이유: overview() 는 **campaign_participants 에서 시작**하므로(위 b CTE)
//      **한 번도 투영되지 않은 탭은 관측 목록에 아예 안 뜬다**. 그래서 화면만 봐서는 "총 몇 개 중
//      몇 개가 투영됐는가"를 알 수 없고, 목록이 짧은 것이 "작업이 적어서"인지 "투영이 안 돼서"인지
//      구분되지 않는다. 여기서 분모(활성 탭 전체)를 따로 세어 그 눈속임을 없앤다.
//   ★★ 투영 대상 정의는 participants.listActiveTabs() **하나만** 쓴다 — projectActive(크론)가 대상으로
//      삼는 목록과 같아야 "미투영 = 크론이 아직 안 만든 것"이 성립한다. 여기서 SQL 을 복사하면 화면의
//      미투영 수와 실제 투영 동작이 조용히 갈라진다(사본 금지).
//   ★★ 투영 완료 판정은 **overview() 가 돌려준 목록을 그대로** 재료로 쓴다(projectedTabs). overview 의
//      b CTE 가 이미 `deleted_at IS NULL` 로 묶은 (시트,탭) 집합이라, 이걸 쓰면 "투영완료로 센 탭"과
//      "아래 목록에 뜨는 탭"이 **구조적으로** 같아진다 — 조건을 두 번 적으면 언젠가 갈라진다.
//      덤으로 같은 테이블을 한 번 더 훑는 비용도 없앤다(관측 화면 로드 = 쿼리 1개 절약).
//      단독 호출(테스트·후속 소비처)일 때만 직접 조회로 폴백한다.
//   ★ 활성 0행(유령)도 "투영은 된 것"이라 미투영이 아니다 — 그건 overview 의 ghost 신호가 다룬다.
//   ★ 읽기 전용(시트 API 무접촉). 실패는 라우트에서 fail-soft(관측 목록은 그대로 뜬다).
const _COVERAGE_TAB_CAP = 2000;   // participants.listActiveTabs 의 상한과 같은 값(넘으면 truncated 로 고지)
async function projectionCoverage({ projectedTabs = null, sample = 200 } = {}) {
  const tabs = await participants.listActiveTabs({ limit: _COVERAGE_TAB_CAP });
  let projected = projectedTabs;
  if (!Array.isArray(projected)) {
    const { rows } = await getPool().query(
      `SELECT DISTINCT sheet_id AS "sheetId", tab_name AS "tabName"
         FROM campaign_participants WHERE deleted_at IS NULL`);
    projected = rows;
  }
  const have = new Set(projected.map(r => String(r.sheetId) + '\u0000' + String(r.tabName)));
  const missing = tabs.filter(t => !have.has(String(t.sheetId) + '\u0000' + String(t.tabName)));
  return {
    total: tabs.length,
    projected: tabs.length - missing.length,
    missing: missing.length,
    // 활성 탭이 상한을 넘으면 분모 자체가 잘린 것 → 화면이 "이상"으로 고지(조용한 절단 금지).
    truncated: tabs.length >= _COVERAGE_TAB_CAP,
    // 자동 투영 스위치. OFF 면 크론이 아예 등록되지 않아(cron.js) 미투영이 줄지 않는다 — 사유 표시용.
    projectionOn: process.env.TRACK_B_PROJECTION === '1',
    // 크론 1사이클 대상 상한. total 이 이보다 크면 뒤쪽 탭은 그 사이클에서 대상이 안 된다 — 사유 표시용.
    cronBatchLimit: PROJECT_ACTIVE_DEFAULT_LIMIT,
    missingTabs: missing.slice(0, sample).map(t => ({
      sheetId: t.sheetId, tabName: t.tabName, spreadsheetTitle: t.spreadsheetTitle || t.sheetId,
    })),
  };
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

// ── 일괄 cutover: "전환 가능(candidate)" 탭 전부에 단건 플립을 순차 시도 — master 전용(라우트) ──
//   ★★ 게이트를 복제하지 않는다 — 판정은 setSourceOfTruth(단건과 같은 fail-closed: **지금 시점** 라이브
//      parity real=0 · 비어있지 않음)가 그대로 한다. 여기서는 overview() triage 로 시도 대상만 고른다
//      (화면의 `cutover 준비` 칩과 같은 신호 — 화면이 보여준 것과 다른 집합을 전환하면 안 된다).
//   ★★ force 없음(완화 금지) — 일괄에서 게이트를 우회하면 클릭 한 번이 검증 안 된 탭을 무더기로
//      전환한다. 게이트에 걸린 탭은 사유와 함께 보고만 하고, 예외는 단건 플립(+탭명 타이핑 마찰)으로.
//   ★ overviewFn/flipFn 주입은 테스트용(모듈 내부 호출은 렉시컬이라 export 스터빙이 안 먹는다 —
//     "밖에서 감싸기" 함정. 프로덕션 경로는 인자 없이 호출돼 실제 함수를 쓴다).
async function cutoverAll({ by = 'admin', overviewFn = overview, flipFn = setSourceOfTruth } = {}) {
  const items = await overviewFn();
  const results = [];
  for (const it of items) {
    const key = { sheetId: it.sheetId, tabName: it.tabName };
    if (it.sourceOfTruth === 'db') { results.push({ ...key, ok: false, skipped: 'already_db' }); continue; }
    if (it.ghost) { results.push({ ...key, ok: false, skipped: 'ghost' }); continue; }
    if (!it.cutoverCandidate) {
      const why = [];
      if (!it.countMatch) why.push('count_mismatch');
      if (!it.owned) why.push('unowned');
      if (!it.woLinked) why.push('no_work_order');
      results.push({ ...key, ok: false, skipped: 'not_candidate', reasons: why });
      continue;
    }
    try {
      const r = await flipFn({ ...key, value: 'db', by });   // force 절대 미전달
      results.push(r && r.ok ? { ...key, ok: true }
        : { ...key, ok: false, skipped: (r && r.error) || 'unknown', ...(r && r.real != null ? { real: r.real } : {}) });
    } catch (e) { results.push({ ...key, ok: false, skipped: 'error', detail: e.message }); }
  }
  const flipped = results.filter(r => r.ok).length;
  return { total: results.length, flipped, skipped: results.length - flipped, results };
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
//   advertiser는 소유 탭으로 서버 강제 제한한다. staff는 작업보드에서 allWorkdesk를 명시한 경우 전체를 쓴다.
async function unseenCounts({ role = 'master', name = '', advertiserId = null, tabs = null, allWorkdesk = false } = {}) {
  if (role === 'advertiser' || (role === 'staff' && !allWorkdesk)) {
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

// 역할 스코프 적용된 활성 탭 목록. `allWorkdesk`는 작업보드의 표 열람 전용 확장이다.
// 광고주도 전체 탭을 열 수 있으나, workdeskTab의 PII 마스킹·읽기 전용 렌즈는 그대로 적용된다.
// 스레드·정산·폴더 등의 별도 API는 이 플래그를 받지 않아 기존 소유/담당 스코프를 유지한다.
async function scopedActiveTabs({ role, staffName, advertiserId, limit, forMapping = false, allStaff = false, allWorkdesk = false } = {}) {
  const all = await participants.listActiveTabs({ limit });
  // allWorkdesk: 리뷰어를 제외하고 작업보드 표를 열 수 있는 역할에만 라우트가 명시한다.
  // forMapping/allStaff는 기존 staff 전용 초기매핑/작업보드 호출 계약을 유지한다.
  const scope = (allWorkdesk || ((forMapping || allStaff) && role === 'staff'))
    ? null : await _scopeFor({ role, staffName, advertiserId });
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

// 광고주(외부) 노출 화이트리스트 — 주문/배송/정산 컬럼만. 시트 헤더에서 개념별 키워드로 매칭(출력 순서=이 목록 순).
//   ★ 데이터 최소화: 여기 없는 컬럼(은행/계좌번호/예금주 등)은 rowJson에서도 제외해 전송 → 네트워크 페이로드에도 안 실림.
//   신원열(참여자 이름·phone8)은 프론트가 광고주 그리드에서 아예 렌더 안 함(별도). 값은 전체 노출(사용자 정책).
const _ADV_COL_RULES = [
  ['번호',      /^\s*(번호|no\.?|순번|연번)\s*$/i],
  ['구매일자',  /구매\s*일자|구매일|주문\s*일자|주문일|결제\s*일|일자|날짜|date/i],
  ['주문번호',  /주문\s*번호|order\s*num/i],
  ['수취인',    /수취인|수령인|받는\s*분|받는분|수령자/],
  ['ID',        /아이디|쿠팡\s*id|네이버\s*id|스토어\s*id|^\s*id\s*$/i],
  ['연락처',    /연락처|휴대폰|핸드폰|전화|폰\s*번호|^\s*hp\s*$|mobile/i],
  ['주소',      /주소|배송지/],
  // 택배송장 = 업체가 발송 현황을 확인하는 배송 대행 업무 데이터. 택배·송장 조합만 정확히 허용해
  // 비고성 배송 컬럼을 넓게 노출하지 않으며, 원본 헤더명은 그대로 보존한다.
  ['택배송장',  TRACKING_HEADER_RE],
  // 결제금액 = 결제/구매/상품/주문 금액 또는 단독 '금액'만(전체문자열). 바로 '금액' 부분일치 금지 →
  //   입금액·환급액·수수료금액 등 다른 금액 컬럼을 결제금액으로 오매칭해 노출하는 것 방지(요청 = 결제금액 하나).
  ['결제금액',  /결제\s*금액|구매\s*금액|상품\s*금액|주문\s*금액|결제액|결제가|^\s*금액\s*$/],
  ['리뷰제출일', /리뷰\s*제출|리뷰\s*링크|리뷰\s*url|리뷰\s*완료|리뷰\s*인증|제출일/i],
  // 입금일 = '입금'(단독=시트 관행상 입금일) 또는 입금+날짜/상태 접미만 허용(화이트리스트 접미). 전체문자열 앵커라
  //   입금자·입금명·입금정보·입금메모·입금주·입금계좌·입금은행·입금자명 등 이름/계좌/자유텍스트 컬럼은 매칭 안 됨(PII 유출 차단).
  ['입금일',    /^\s*입금\s*(완료|확인|처리)?\s*(일|일자|날짜|여부|상태)?\s*$/],
];
// opts.submitCol / submitCol2 = 그 탭의 "리뷰제출 / 입금" 상태 칸 헤더명(review_index → campaign_participants 복제값).
// ★★ 상태 칸이 키워드 판정을 이긴다(worktable 분류기와 같은 규율) — 먼저 **선점**해야 하는 이유 2가지:
//   ① 리뷰제출 열 헤더가 키워드에 안 걸리는 탭(예 '카페/블로그 발행')에서 그 열이 통째로 빠졌다(실제 신고).
//   ② 반대로 '입금일자' 같은 헤더는 위쪽 구매일자 규칙(/일자|날짜/)이 먼저 삼켜, 구매일자 칸에 입금일이
//      들어가고 입금 칸은 사라지는 오배치가 난다. 선점하면 두 사고가 동시에 막힌다.
function _advertiserColumns(rawHeaders, opts = {}) {
  const hs = (rawHeaders || []).map(h => String(h == null ? '' : h).trim()).filter(Boolean);
  const pin = {};
  const pinHeader = (concept, name) => {
    const v = String(name == null ? '' : name).trim(); if (!v) return;
    const hit = hs.find(h => h === v);                       // 실재하는 헤더만(정확 일치)
    if (hit && !Object.values(pin).includes(hit)) pin[concept] = hit;
  };
  pinHeader('리뷰제출일', opts.submitCol);
  pinHeader('입금일', opts.submitCol2);
  const used = new Set(Object.values(pin)), out = [];
  for (const [concept, re] of _ADV_COL_RULES) {
    if (pin[concept]) { out.push(pin[concept]); continue; }   // 선점된 상태 칸(출력 순서는 규칙 순서 그대로)
    const hit = hs.find(h => !used.has(h) && re.test(h));
    if (hit) { used.add(hit); out.push(hit); }   // 개념당 첫 매칭 헤더 1개, 요청 순서 유지
  }
  return out;
}

// raw_sheet_tabs.detected_headers 는 시트 동기화 시점의 스냅샷이라, 열이 추가된 직후에는 실제 행 데이터의
// 키보다 오래될 수 있다. 광고주 열은 아래 후보를 다시 화이트리스트에 통과시키므로, 이 보완만으로 민감열이
// 노출되지는 않는다. 원본 시트 순서는 먼저 온 detected_headers 를 그대로 유지한다.
function _advertiserHeaderCandidates(rawHeaders, roster, editedColumnHeaders = []) {
  const out = [], seen = new Set();
  const add = (name) => {
    const key = String(name == null ? '' : name).trim();
    if (!key || key === 'id' || seen.has(key)) return;
    seen.add(key); out.push(key);
  };
  for (const h of rawHeaders || []) add(h);
  for (const row of roster || []) {
    const rowJson = row && row.row_json;
    if (!rowJson || typeof rowJson !== 'object') continue;
    for (const key of Object.keys(rowJson)) add(key);
  }
  for (const header of editedColumnHeaders) add(header);
  return out;
}

function _advertiserColumnValue(rowJson, overlay, header) {
  const editKey = `col:${header}`;
  if (Object.prototype.hasOwnProperty.call(overlay || {}, editKey)) {
    return overlay[editKey] == null ? '' : overlay[editKey];
  }
  return rowJson && rowJson[header] != null ? rowJson[header] : '';
}

// ── 리뷰 이미지(행별) — 업체 뷰어 미리보기 패널용. 읽기 전용·Drive 무접촉(파일ID만 반환). ──
//   키 = review_index.row_index(= campaign_participants.seq/sheet_row). 원장(032 review_submissions)이 1순위,
//   그 이전에 저장된 대표 이미지(031 review_index.review_file_id)는 폴백으로 합류시킨다.
//   ★ 파일 자체는 기존 무인증 프록시 /api/drive/image/<id> 가 스트리밍(추측 불가 fileId) — 신규 저장소 0.
const _RV_MAX_PER_ROW = 12;
async function reviewImagesForTab({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('reviewImagesForTab: sheetId, tabName 필수');
  const db = getPool();
  const out = new Map();
  const push = (rowIndex, fileId, slot, at) => {
    if (rowIndex == null || !fileId) return;
    const k = String(rowIndex);
    if (!out.has(k)) out.set(k, []);
    const arr = out.get(k);
    const sl = slot || 'review';
    /* ★ 상한은 **묶음별**로 센다 — 전체 개수로 자르면 리뷰가 12장인 줄에서
       나중에 붙는 구매 캡처가 통째로 잘려 "구매 캡처 없음"으로 거짓 표시된다. */
    if (arr.filter(f => f.slot === sl).length >= _RV_MAX_PER_ROW || arr.some(f => f.fileId === fileId)) return;
    arr.push({ fileId, slot: sl, at: at || null });
  };
  const { rows: subs } = await db.query(
    `SELECT row_index, file_id, slot_key, COALESCE(uploaded_at, created_at) AS at
       FROM review_submissions
      WHERE sheet_id=$1 AND tab_name=$2 AND row_index IS NOT NULL AND file_id IS NOT NULL
      ORDER BY row_index, slot_key, COALESCE(uploaded_at, created_at) NULLS LAST`,
    [sheetId, tabName]).catch(() => ({ rows: [] }));   // fail-soft: 이미지가 없어도 표는 떠야 한다
  for (const r of subs) push(r.row_index, r.file_id, r.slot_key, r.at);
  const { rows: idx } = await db.query(
    `SELECT row_index, review_file_id, review_file_at
       FROM review_index
      WHERE sheet_id=$1 AND tab_name=$2 AND row_index IS NOT NULL AND review_file_id IS NOT NULL`,
    [sheetId, tabName]).catch(() => ({ rows: [] }));
  for (const r of idx) push(r.row_index, r.review_file_id, 'review', r.review_file_at);
  /* ── 구매 캡처(062 `order_submissions.capture_file_id`) ─────────────────────────
     ★★ 줄 짝짓기는 **`sheet_row`(그 주문이 실제로 기록된 줄)** 하나로 한다.
       `campaign_participants.order_submission_id` 링크는 오염 사례가 문서화돼 있어
       (2026-08-19 장수산업 건) 그것으로 붙이면 **남의 구매 캡처가 이 줄에 뜬다** —
       검수에서 잘못된 판단의 근거가 되므로, 근거가 확실한 값만 쓴다.
     ★ 아직 표에 반영되지 않은 주문(sheet_row NULL)은 안 보인다 — 정직한 상태다.
     ★ fail-soft: 실패해도 리뷰 이미지는 그대로 나간다. */
  const { rows: caps } = await db.query(
    `SELECT sheet_row, capture_file_id, capture_uploaded_at
       FROM order_submissions
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
        AND sheet_row IS NOT NULL AND capture_file_id IS NOT NULL
      ORDER BY sheet_row, capture_uploaded_at NULLS LAST`,
    [sheetId, tabName]).catch(() => ({ rows: [] }));
  for (const r of caps) push(r.sheet_row, r.capture_file_id, 'order_capture', r.capture_uploaded_at);
  return Object.fromEntries(out);
}

// Keeps relational tab_name stable; only the workboard-facing display name changes.
async function setWorkdeskTitle({ sheetId, tabName, displayName } = {}) {
  const sid = String(sheetId || '').trim();
  const tab = String(tabName || '').trim();
  const name = String(displayName == null ? '' : displayName).trim();
  if (!sid || !tab) throw new Error('sheetId, tabName 필수');
  if (!name) throw new Error('작업명을 입력해 주세요.');
  if (name.length > 120) throw new Error('작업명은 120자 이하로 입력해 주세요.');
  const { rows } = await getPool().query(
    `INSERT INTO tab_configs (sheet_id, tab_name, display_name, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       updated_at = NOW()
     RETURNING display_name AS "displayName"`,
    [sid, tab, name]
  );
  return { ok: true, displayName: (rows[0] && rows[0].displayName) || name };
}

// ── 리뷰웹시스템[3버전] 데이터(읽기): 세부 + 명단 + 상태 + 활성 오버레이 read-time 합성. 역할별 PII 마스킹. ──
//   ★ 물리행은 순수 투영(review_index 사본) 유지 — 편집은 participant_edits(오버레이)에만 살고 여기서 합성만.
//     정렬/재투영이 물리행을 덮어도 편집 무손실·무오염(교차노출 근본 차단).
/** roster 의 row_json 키 모음(첫 줄 순서 우선) — 번호 칸 찾기용. */
function _collectRowJsonKeys(rows) {
  const keys = [];
  for (const r of (rows || [])) {
    const rj = (r && r.row_json && typeof r.row_json === 'object') ? r.row_json : null;
    if (!rj) continue;
    for (const k of Object.keys(rj)) if (k && keys.indexOf(k) < 0) keys.push(k);
  }
  return keys;
}
/* ══ 작업 조건 10항목(작업보드 상단 ① 카드) ══════════════════════════════════════
   상품명 · 총건수 · 일건수 · 구매채널 · 유입방식 · 다계정 · 현금영수증 · 리뷰비 · 입금명 · 리뷰타입.

   ★★ 판정을 여기서 새로 만들지 않는다 — 전부 기존 단일 출처를 그대로 태운다:
      리뷰비 = `utils/campaignFee.resolveReviewFee` · 리뷰타입 = `utils/reviewType.resolveReviewType`
      현금영수증 = `utils/captureSlots.hasCashReceiptSlot`(폴더 바로가기·검수와 같은 함수).
      여기서 다시 세면 카드·모집공고 탭·입금관리와 숫자가 갈린다.
   ★★ **구매채널은 화면이 상품 URL 로 판정한다** — 호스트 판정 단일 출처가 프론트
      `work-order-detail.js._woChannelFromUrl` 이라 서버에 사본을 만들지 않는다.
      여기서는 공고에 **명시된** 채널만 실어 보내고, 없으면 null(추측 금지).
   ★ 공고가 여럿(차수 재발행)이면 **살아있는 최신 하나**를 쓰고 `campaignCount` 로 그 사실을 말한다.
   ★ 매칭은 이름 → gid 폴백(리네임으로 연결이 조용히 풀리지 않게). **빈 gid 는 절을 켜지 않는다.**
   ★ 어떤 실패에도 throw 하지 않는다 — 작업보드가 이것 때문에 죽으면 안 된다. */
async function tabConditionSummary(db, { sheetId, tabName, meta = {}, wo = null } = {}) {
  try {
    const gid = String(meta.tabGid || '').trim();
    const { rows: camps } = await db.query(
      `SELECT id, title, recruit_total AS "recruitTotal", daily_limit AS "dailyLimit",
              channel, channel_custom AS "channelCustom", review_type AS "reviewType",
              review_fee AS "reviewFee", transfer_memo AS "transferMemo",
              multi_account_mode AS "multiAccount", multi_daily_limit AS "multiDailyLimit",
              status, participation_mode AS "participationMode"
         FROM recruit_campaigns
        WHERE linked_sheet_id = $1
          AND (linked_tab_name = $2 OR ($3 <> '' AND linked_tab_gid = $3))
        ORDER BY (status = 'active') DESC, created_at DESC`,
      [sheetId, tabName, gid]).catch(() => ({ rows: [] }));
    const c = camps[0] || null;

    // 기간별 리뷰비 구간(082) — 실패해도 기존 review_fee 로 떨어진다(fail-soft)
    let schedules = [];
    if (c) {
      const { rows: fs } = await db.query(
        `SELECT to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom", review_fee AS "reviewFee"
           FROM campaign_fee_schedules WHERE campaign_id = $1 ORDER BY effective_from`,
        [c.id]).catch(() => ({ rows: [] }));
      schedules = fs;
    }
    /* ★ 0 을 null 로 접지 말 것 — "0원으로 정한 무상 작업"과 "값이 없는 공고"는 다르다.
       폴백 순서(공고 → 탭)는 입금관리(payment.service)와 **같아야** 한다. */
    const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    const campFee = num(c && c.reviewFee);
    const tabFee  = num(meta.tabReviewFee);
    const { resolveReviewFee } = require('../utils/campaignFee');
    const feeInfo = resolveReviewFee({ schedules, fallback: campFee != null ? campFee : (tabFee != null ? tabFee : 0) });
    const feeSource = feeInfo.source === 'schedule' ? 'schedule'
      : campFee != null ? 'campaign'
      : tabFee != null ? 'tab' : null;      // null = 근거를 못 찾음(0원이라서가 아니다)

    const { resolveReviewType, reviewTypeLabel } = require('../utils/reviewType');
    const { hasCashReceiptSlot } = require('../utils/captureSlots');

    let cashReceipt = null;
    try { cashReceipt = hasCashReceiptSlot(meta.captureSlots, meta.incomeType); } catch (_) { cashReceipt = null; }

    return {
      productName: (wo && wo.productOption) || meta.campaignName || '',
      recruitTotal: num(c && c.recruitTotal) != null ? num(c.recruitTotal) : num(wo && wo.recruitCount),
      dailyLimit:   num(c && c.dailyLimit)   != null ? num(c.dailyLimit)   : num(wo && wo.dailyCount),
      // 공고에 명시된 채널만(직접입력은 custom). 없으면 null → 화면이 상품 URL 로 판정한다.
      channel: (c && (String(c.channel || '').trim() === '직접입력' ? c.channelCustom : c.channel)) || null,
      productUrl: (wo && wo.productUrl) || null,
      inflowType: (wo && wo.inflowType) || null,
      inflowKeyword: (wo && wo.inflowKeyword) || null,
      multiAccount: c ? { enabled: !!c.multiAccount, dailyLimit: num(c.multiDailyLimit) } : null,
      cashReceipt,
      reviewFee: feeInfo.fee, feeSource,
      depositName: (meta.depositName || (c && c.transferMemo) || '') || null,
      reviewType: (() => { const k = resolveReviewType({ campaignType: c && c.reviewType, tabReviewType: meta.reviewType }); return k; })(),
      reviewTypeLabel: (() => {
        const k = resolveReviewType({ campaignType: c && c.reviewType, tabReviewType: meta.reviewType });
        return k ? (reviewTypeLabel(k) || k) : null;
      })(),
      campaignId: c ? c.id : null,
      campaignCount: camps.length,
    };
  } catch (e) {
    logger.warn(`[trackB] tabConditionSummary 실패(작업 조건 축약 표시): ${e.message}`);
    return null;   // ★ null = "못 불러옴" — 화면이 종전 4줄로 떨어지고 사유를 말한다
  }
}

async function workdeskTab({ sheetId, tabName, tabGid, role = 'master', advertiserId = null, staffName = null, allowAllStaff = false, allowAllWorkdesk = false } = {}) {
  if (!sheetId || !tabName) throw new Error('workdeskTab: sheetId, tabName 필수');
  const db = getPool();
  // 스코프 강제: 일반 호출은 advertiser=소유업체, staff=담당업체다. 작업보드 표 열람만
  // allowAllWorkdesk로 확장하며, advertiser 렌즈(PII 마스킹·읽기 전용)는 아래에서 유지한다.
  //   ★ 판정은 클라이언트가 보낸 tabGid를 신뢰하지 않고 (sheetId, tabName)으로 gid를 재해석(canAccessTab).
  //     명단·PII·주문원장은 전부 tabName으로 조회되므로, 스코프도 반드시 tabName 기준이어야 read/edit
  //     비대칭이 사라진다(과거: 소유 gid를 쿼리스트링에 실어 타 탭 tabName의 명단을 긁는 교차 열람이 뚫렸음).
  if (!allowAllWorkdesk && (role === 'advertiser' || (role === 'staff' && !allowAllStaff))) {
    const okc = await canAccessTab({ role, staffName, advertiserId, sheetId, tabName });
    if (!okc) return { scoped: true, denied: true };
  }
  const maskPII = role === 'advertiser';       // 광고주(외부)만 마스킹 · AE(내부)는 전체
  const showEdits = role !== 'advertiser';     // 편집 어포던스·orphan·hidden은 내부(master/admin/staff)
  const { rows: meta } = await db.query(
    `SELECT tc.campaign_name AS "campaignName", tc.display_name AS "displayName", tc.manager, tc.review_type AS "reviewType",
            tc.delivery_type AS "deliveryType", tc.income_type AS "incomeType",
            tc.source_of_truth AS "sourceOfTruth", COALESCE(tc.sheetless, FALSE) AS sheetless,
            tc.tab_gid AS "tabGid", tc.capture_slots AS "captureSlots",
            tc.deposit_name AS "depositName", tc.review_fee AS "tabReviewFee"
       FROM tab_configs tc WHERE tc.sheet_id=$1 AND tc.tab_name=$2 LIMIT 1`, [sheetId, tabName]);
  const { rows: wo } = await db.query(
    `SELECT id, title, product_option AS "productOption", product_options_json AS "productOptionsJson",
            pay_amount AS "payAmount", review_fee AS "reviewFee", daily_count AS "dailyCount", daily_count_text AS "dailyCountText",
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
            order_submission_id, identity_key, row_json, submit_col, submit_col2
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active = TRUE
        AND held_at IS NULL
      ORDER BY seq`, [sheetId, tabName]);
  /* ★★ 표에서 분리(보관)한 줄 — **화면에서만** 뺀다(129, 사용자 확정 2026-08-19).
     장부 재생성·리뷰어 검색·입금대상 추출은 `deleted_at` 만 보므로 그대로다(무접촉).
     ★ 조용히 빼지 않는다 — 건수를 실어 보내 화면이 "분리 N건" 을 말하고 되돌릴 수 있게 한다.
     ★ 조회 실패는 fail-soft(표는 떠야 한다) — 컬럼 미적용(구버전 DB)에서도 죽지 않는다. */
  let heldCount = 0, heldUnavailable = null;
  if (showEdits) {
    try {
      const { rows: hc } = await db.query(
        `SELECT COUNT(*)::int AS n FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND held_at IS NOT NULL`,
        [sheetId, tabName]);
      heldCount = (hc[0] && hc[0].n) || 0;
    } catch (e) { heldUnavailable = e.message; }
  }
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
  // 셀 편집(col:<헤더>)으로만 존재하는 열도 광고주 화이트리스트 판단 후보에 넣는다.
  // 실제 반환은 아래 행별 오버레이를 우선 적용하며, _advertiserColumns가 허용 열 외에는 계속 차단한다.
  const advEditedHeaders = role === 'advertiser'
    ? [...new Set([...editMap.values()].flatMap(overlay => Object.keys(overlay)
      .filter(field => field.indexOf('col:') === 0).map(field => field.slice(4))))]
    : [];
  // 커스텀 열(행별 자유메모) + 셀 배경색(migration 080) — 내부(master/admin/staff)만, 시트/write-back 무접촉.
  let customCols = [], customValMap = new Map(), cellColorMap = new Map();
  if (showEdits) {
    const { rows: cc } = await db.query(
      `SELECT id, col_name AS "colName", sort_order AS "sortOrder"
         FROM trackb_custom_columns WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
        ORDER BY sort_order, created_at`, [sheetId, tabName]).catch(() => ({ rows: [] }));
    customCols = cc;
    if (cc.length) {
      const { rows: cv } = await db.query(
        `SELECT column_id AS "columnId", anchor_type AS "anchorType", anchor_value AS "anchorValue", value_text AS "valueText"
           FROM trackb_custom_column_values WHERE column_id = ANY($1::uuid[])`,
        [cc.map(c => c.id)]).catch(() => ({ rows: [] }));
      for (const v of cv) {
        const k = _akey(v.anchorType, v.anchorValue);
        if (!customValMap.has(k)) customValMap.set(k, {});
        customValMap.get(k)[v.columnId] = v.valueText || '';
      }
    }
    const { rows: ccl } = await db.query(
      `SELECT anchor_type AS "anchorType", anchor_value AS "anchorValue", field, color
         FROM trackb_cell_colors WHERE sheet_id=$1 AND tab_name=$2`, [sheetId, tabName]).catch(() => ({ rows: [] }));
    for (const c of ccl) {
      const k = _akey(c.anchorType, c.anchorValue);
      if (!cellColorMap.has(k)) cellColorMap.set(k, {});
      cellColorMap.get(k)[c.field] = c.color;
    }
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
  let headers = null, advHeaders = null;
  if (showEdits || role === 'advertiser') {
    const { rows: hh } = await db.query(
      `SELECT detected_headers FROM raw_sheet_tabs
        WHERE sheet_id=$1 AND (($2::text IS NOT NULL AND tab_gid=$2) OR tab_name=$3)
        ORDER BY ($2::text IS NOT NULL AND tab_gid=$2) DESC LIMIT 1`,
      [sheetId, tabGid, tabName]).catch(() => ({ rows: [] }));
    const dh = hh[0] && hh[0].detected_headers;
    let raw = Array.isArray(dh) ? [...new Set(dh.map(h => String(h == null ? '' : h).trim()).filter(Boolean))] : [];
    if (!raw.length) {
      const rj = roster.find(r => r.row_json && typeof r.row_json === 'object' && Object.keys(r.row_json).length);
      raw = rj ? Object.keys(rj.row_json).filter(k => k !== 'id') : [];
    }
    if (showEdits) headers = raw;                                   // 내부: 시트 전체 헤더
    else {
      // 광고주: 화이트리스트만. 그 탭의 상태 칸(리뷰제출/입금)은 키워드보다 우선 선점 —
      //   헤더가 키워드에 안 걸리는 탭에서 리뷰제출 열이 통째로 빠지던 것을 막는다.
      const sc = roster.find(r => r.submit_col) || {}, sc2 = roster.find(r => r.submit_col2) || {};
      advHeaders = _advertiserColumns(_advertiserHeaderCandidates(raw, roster, advEditedHeaders), {
        submitCol: sc.submit_col,
        submitCol2: sc2.submit_col2,
      });
      headers = advHeaders;
    }
  }
  /* 앵커 중복 카운트(ambiguous 게이트, 윈도우 SQL 대신 JS Map)
     ★★ order 앵커도 센다 (2026-08-19 실사고) — `order_submission_id` 는 **유니크가 아니다**
        (`sheetlessOrder.service.js:154`). 8/18~19 무시트 사고로 같은 주문이 여러 줄로 복제된 탭에서
        종전엔 order 앵커에 게이트가 없어, 입금칸 수기 표기 1건(과 그에 연동된 `is_paid`)이
        **중복 줄 전부에 오버레이로 번져** 리뷰 미작성 줄에 입금일이 보이고 `counts.paid`(입금완료)가
        부풀었다. 어느 줄의 편집인지 모르면 **어느 줄에도 적용하지 않는다**(identity 와 같은 규율).
     ★ manual 앵커는 물리행 id 라 구조적으로 유일하다 — 셀 필요가 없다. */
  const anchorCount = new Map();
  for (const r of roster) {
    const a = _deriveAnchor(r);
    if (!a || a.type === 'manual') continue;
    const k = _akey(a.type, a.value);
    anchorCount.set(k, (anchorCount.get(k) || 0) + 1);
  }
  const consumed = new Set();
  /* ★★ 참여횟수(명의 기준) — 이 작업표에서 그 **계정 명의**가 몇 번째 참여인가 (사용자 확정 2026-08-19).
     단위는 리뷰어(소유자)가 아니라 **명의(phone8)** 다 — 한 사람이 본계정으로 1회, 타계정으로 1회면
     둘 다 1회이고, 같은 타계정으로 또 참여해야 2회다.
     ★ 마스킹 **전** 원본 phone8 로 센다 — 광고주 렌즈의 `_mask` 를 거친 뒤 세면 전 줄이 같은 값이 되어
       숫자가 통째로 무너진다.
     ★ 명의를 모르는 줄(빈 슬롯·연락처 없음)은 **세지 않는다**(null) — 화면이 배지를 그리지 않는다.
     ★ 제거 오버레이로 화면에서 빠지는 줄은 세지 않는다(카운트는 `continue` 뒤에서 한다). */
  const visitSeen = new Map();
  const out = [], hiddenList = [];
  let ambiguousCount = 0;
  for (const r of roster) {
    const anchor = _deriveAnchor(r);
    let ov = {}, editable = !!anchor, ambiguous = false;
    if (anchor) {
      const k = _akey(anchor.type, anchor.value);
      if (anchor.type !== 'manual' && (anchorCount.get(k) || 0) > 1) {
        ambiguous = true; editable = false; ambiguousCount++;
        if (editMap.has(k)) consumed.add(k);          // 소비 표시(orphan 오분류 방지), 단 미적용
      } else if (editMap.has(k)) { ov = editMap.get(k); consumed.add(k); }
      // ★ 앵커 승격 대비 — 빈 자리였을 때 **물리행 앵커**로 저장해 둔 값(예: 미리 적어 둔 송장)이
      //   주문이 붙어 order 앵커로 승격한 뒤에도 화면에서 사라지지 않게 밑에 깔아 합성한다.
      //   같은 필드는 **현재 앵커 값이 이긴다**(더 나중·더 구체적인 근거). `_hidden` 은 제외 —
      //   빈 자리를 치웠던 제거 표시가 실제 참여자가 배정된 줄을 숨기면 안 된다.
      const rowKey = _akey('manual', _rowAnchorId(r));
      if (!ambiguous && anchor.value !== _rowAnchorId(r) && editMap.has(rowKey)) {
        const base = { ...editMap.get(rowKey) }; delete base._hidden;
        ov = { ...base, ...ov }; consumed.add(rowKey);
      }
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
    const _vp8 = String(syn.phone8 == null ? '' : syn.phone8).trim();
    if (_vp8) { const n = (visitSeen.get(_vp8) || 0) + 1; visitSeen.set(_vp8, n); syn.visitNo = n; }
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
      // 커스텀 열 값 + 셀 배경색(migration 080) — 같은 앵커키로 합성. ★ ambiguous(중복 identity)면 미적용(ov와 동일 게이트) —
      //   그렇지 않으면 서로 다른 물리행 여러 개가 같은 identity 앵커를 공유해 한 사람의 메모/색이 남에게도 보인다.
      const ak = (anchor && !ambiguous) ? _akey(anchor.type, anchor.value) : null;
      syn.customValues = (ak && customValMap.get(ak)) || {};
      syn.cellColors = (ak && cellColorMap.get(ak)) || {};
    } else if (role === 'advertiser' && advHeaders) {
      // 광고주: 화이트리스트 컬럼만 · 전체값(마스킹 없음, 사용자 정책). 미포함 컬럼(은행/계좌 등)은 rowJson에 안 담음(데이터 최소화).
      const rj = (r.row_json && typeof r.row_json === 'object') ? r.row_json : {};
      const cur = {};
      for (const h of advHeaders) cur[h] = _advertiserColumnValue(rj, ov, h);
      syn.rowJson = cur;
      syn.editable = false;   // 읽기전용(다른 열은 종전대로)
      // ★ 택배송장 열만 업체가 직접 입력한다(사용자 확정 2026-08-19). 편집은 오버레이라 **앵커가 있어야**
      //   저장되고, 중복 앵커(ambiguous)면 어느 줄의 값인지 정할 수 없어 내부 화면과 같은 규율로 잠근다.
      //   ⚠ `editable` 을 true 로 바꾸지 말 것 — 그러면 화면이 전 열을 편집 가능으로 그린다.
      syn.trackingEditable = !!anchor && !ambiguous;
      // 그 열의 편집 오버레이만 실어 준다(↩ 되돌리기 표시용). 다른 열의 편집 이력은 업체에 노출하지 않는다.
      const tce = {};
      for (const k in ov) { if (k.indexOf('col:') === 0 && isTrackingHeader(k.slice(4))) tce[k.slice(4)] = ov[k]; }
      syn.cellEdits = tce;
    }
    out.push(syn);
  }
  /* ── 표시 순서 = 표의 `번호` 순(무시트 탭만) ─────────────────────────────────
     ★★ 번호를 구매일자 순으로 다시 매겨도(`rowNumbering.service`) 화면이 `seq` 순이면
        "8/5 건이 146 번인데 여전히 맨 아래" 가 된다. 그래서 **번호가 정한 순서**를 따른다.
     ★ 번호가 없는 줄은 맨 아래(그 안에서는 seq) — 순서를 지어내지 않는다.
     ★ **시트 기반 탭은 종전대로 `seq` 순** — 그쪽 번호는 시트가 정하고 우리는 재부여하지 않는다.
     ★ 판정은 `utils/rowNumbering` 단일 출처(정렬 규칙 사본 금지). */
  if (meta[0] && meta[0].sheetless) {
    const { numberColumnKey, displaySortKey } = require('../utils/rowNumbering');
    const nk = numberColumnKey(_collectRowJsonKeys(roster));
    if (nk) {
      const key = new Map();
      for (const r of roster) key.set(String(r.id), displaySortKey(r, nk));
      const k = r => key.get(String(r.id)) || { has: false, n: Number.MAX_SAFE_INTEGER, seq: r.seq || 0 };
      out.sort((a, b) => { const x = k(a), y = k(b); return (x.n - y.n) || (x.seq - y.seq); });
    }
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
    // 주문 원장이 살아 있는 행의 결제금액 합계. 주문 행 삭제 뒤에는 원장 soft-delete와 함께 즉시 빠진다.
    paymentAmount: showEdits ? out.reduce((sum, r) => sum + (Number(String(r.order && r.order.price || '').replace(/[^0-9]/g, '')) || 0), 0) : undefined,
    edited: showEdits ? out.filter(r => (r.editedFields || []).length).length : undefined,
    ambiguous: ambiguousCount, hidden: hiddenList.length,
    /* 표에서 분리한 줄(129) — 표에는 없지만 데이터는 그대로다. 숫자를 지우면 "사라진 줄" 이 된다. */
    held: heldCount, heldUnavailable: heldUnavailable || undefined,
  };
  const res = { role, maskPII, meta: meta[0] || {}, detail: wo[0] || null, counts, roster: out,
    sourceOfTruth: (meta[0] && meta[0].sourceOfTruth) || 'sheet' };   // 진실원천(cutover 상태) 표시용
  if (showEdits) {
    res.hiddenRows = hiddenList; res.orphanEdits = { count: orphanCount, byType: orphanByType };
    res.headers = headers || []; res.customColumns = customCols;
    /* ★ 작업 조건 10항목 — **내부 화면 전용**(리뷰비·입금명은 광고주에게 나갈 값이 아니다).
       fail-soft: 실패하면 필드를 싣지 않고, 화면이 종전 4줄로 떨어진다(0·빈값 위장 금지). */
    res.condition = await tabConditionSummary(db, { sheetId, tabName, meta: meta[0] || {}, wo: wo[0] || null });
    // 오늘 참여현황(표 툴바 표기) — fail-soft: 실패해도 작업보드는 그대로 뜨고,
    //   화면이 "불러오지 못함"이라고 말한다(0/0 위장 금지).
    res.todayProgress = await tabTodayProgress(db, { sheetId, tabName });
  }
  else if (role === 'advertiser') {
    res.headers = headers || [];   // 광고주: 화이트리스트 헤더(그리드 렌더용)
    // ★ 업체 뷰어에도 **같은 자리에 같은 표기**(사용자 확정 2026-08-10) — 단 **렌즈를 거친다**.
    //   업체가 볼 것 = 오늘 몇 명이 채워졌나 / 오늘 몇 명 예정인가. 그 외(공고를 거친 확정 수·
    //   결제 중 홀드·합산 공고 수)는 **내부 운영 수치라 응답에서 폐기**한다 — 광고주 렌즈 규율.
    res.todayProgress = _tpAdvertiserLens(await tabTodayProgress(db, { sheetId, tabName }));
  }
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

// ── 리뷰웹시스템[3버전] 편집(오버레이-only, 물리컬럼 무편집) ──
//   앵커: order_submission_id(불변 UUID) > manual(물리행 UUID, 재투영 면역) > identity_key(중복 아니면) > 거부.
//   단일 tx + 대상행 FOR UPDATE(동일행 직렬화) + revert(활성)→insert(신규, append-only 감사).
//   부분유니크 uq_participant_edits_active 가 cross-row 레이스 backstop(23505 → concurrent_edit_conflict).
//   field: 물리필드(_EDIT_FIELD_KIND) 또는 'col:<시트헤더>'(그 탭 실재 컬럼만, text 오버레이) — 물리컬럼 무접촉.
/* ★★ 한 건의 편집 = 한 트랜잭션. **커넥션은 호출자가 준다**(일괄 편집이 같은 커넥션을
 *  재사용해 붙여넣기 한 번에 풀을 고갈시키지 않도록). 로직은 여기 한 벌뿐 —
 *  단건(editWorkdeskRow)과 일괄(editWorkdeskRowsBatch)이 같은 함수를 탄다(사본 금지).
 *  decideCache: 같은 배치 안에서 (탭,열) 판정을 재사용(판정은 행과 무관하다). */
async function _editOneInTx(client, { sheetId, tabName, rowId, field, value, by = 'admin', decideCache = null } = {}) {
  if (!sheetId || !tabName || !rowId || !field) throw new Error('editWorkdeskRow: 필수 인자 누락');
  let kind = _EDIT_FIELD_KIND[field];
  const isCol = !kind && typeof field === 'string' && field.startsWith('col:');
  if (!kind && !isCol) return { ok: false, error: 'field_not_editable', field };
  try {
    await client.query('BEGIN');
    const { rows: pr } = await client.query(
      `SELECT id, seq, source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json, tab_gid
         FROM campaign_participants
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
    const row = pr[0];
    // col:<헤더> 는 잠근 행 문맥으로 실재 컬럼 검증(그리드 표시와 동일 소스). 미실재면 거부(표시=수락 정합).
    if (isCol) {
      // 상태값은 시스템 전용이다. 화면 잠금과 별개로 일반 셀 편집 API도 차단한다.
      if (_linkedToggle(field.slice(4))) {
        await client.query('ROLLBACK'); return { ok: false, error: 'status_column_locked', field };
      }
      if (!await _isTabColumn(client, sheetId, tabName, row.tab_gid, field.slice(4), row.row_json)) {
        await client.query('ROLLBACK'); return { ok: false, error: 'field_not_editable', field };
      }
      kind = 'text';
    }
    let anchorType, anchorValue;
    if (row.order_submission_id) {
      // ★ order 앵커도 유일성을 확인한다 — `order_submission_id` 는 유니크가 아니라,
      //   중복 줄이 있는 상태에서 편집을 받으면 그 값이 **여러 줄에 동시에 적용**된다(8/19 실사고).
      const { rows: odup } = await client.query(
        `SELECT COUNT(*)::int AS n FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
            AND order_submission_id=$3::uuid`,
        [sheetId, tabName, row.order_submission_id]);
      if ((odup[0] && odup[0].n || 0) > 1) { await client.query('ROLLBACK'); return { ok: false, error: 'ambiguous_order' }; }
      anchorType = 'order'; anchorValue = String(row.order_submission_id);
    }
    else if (row.source === 'manual') { anchorType = 'manual'; anchorValue = String(row.id); }
    else {
      let ik = row.identity_key;
      if (!ik) {
        ik = identityKey(_ikFromRow(row));
        if (ik) await client.query(`UPDATE campaign_participants SET identity_key=$2 WHERE id=$1 AND identity_key IS NULL`, [row.id, ik]);
      }
      if (!ik) {
        // 빈 준비 자리(이름·연락처 없음) — 읽는 쪽과 **같은 규칙**으로 물리행 앵커에 저장한다.
        //   여기서 거부하면 화면은 편집 가능으로 그리는데 저장만 실패하는 막다른 길이 된다.
        anchorType = 'manual'; anchorValue = String(row.id);
      } else {
      const { rows: dup } = await client.query(
        `SELECT COUNT(*)::int AS n FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
            AND order_submission_id IS NULL AND source<>'manual' AND identity_key=$3`,
        [sheetId, tabName, ik]);
      if ((dup[0].n || 0) > 1) { await client.query('ROLLBACK'); return { ok: false, error: 'ambiguous_identity' }; }
      anchorType = 'identity'; anchorValue = ik;
      }
    }
    let vBool = null, vText = null;
    if (kind === 'bool') vBool = (value === true || value === 'true' || value === 1 || value === '1');
    else vText = field === 'phone8' ? (_phone8(value) || '') : (value == null ? '' : String(value).slice(0, 2000));

    /* ★★ 무시트 쓰기-through(132) 판정 + 되돌리기용 이전값 스냅샷.
       판정 재료는 **잠근 행의 row_json** 이다(다른 스냅샷을 쓰면 prev 가 어긋난다).
       ★ `decide` 에 넘기는 것은 **이 tx 의 client** — pool 을 쓰면 붙여넣기(최대 500 동시)에서 풀 고갈 교착. */
    const _scw = require('../utils/sheetlessCellWrite');
    const _st  = require('./sheetlessStatus.service');
    let wt = { write: false, reason: 'not_applicable' };
    let prevText = null, hadPrev = null;
    if (isCol) {
      // 판정은 (탭, 열)만 보므로 배치 안에서 재사용한다 — 500칸 붙여넣기의 판정 쿼리 500회를 열 수만큼으로 줄인다.
      const ck = decideCache ? (sheetId + String.fromCharCode(0) + tabName + String.fromCharCode(0) + field) : null;
      if (ck && decideCache.has(ck)) wt = decideCache.get(ck);
      else {
        wt = await _scw.decide(client, { sheetId, tabName, field });
        if (ck) decideCache.set(ck, wt);
      }
      if (wt.write) {
        const rj = (row.row_json && typeof row.row_json === 'object') ? row.row_json : {};
        hadPrev  = Object.prototype.hasOwnProperty.call(rj, wt.header);
        prevText = hadPrev ? String(rj[wt.header] == null ? '' : rj[wt.header]) : null;
      }
    }

    await client.query(
      `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
        WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type=$4 AND anchor_value=$5 AND field=$6 AND reverted_at IS NULL`,
      [String(by).slice(0, 100), sheetId, tabName, anchorType, anchorValue, field]);
    const ins = await client.query(
      `INSERT INTO participant_edits
         (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_bool, value_text, created_by,
          prev_text, had_prev, wrote_row_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [sheetId, tabName, anchorType, anchorValue, field, kind, vBool, vText, String(by).slice(0, 100),
       prevText, hadPrev, !!wt.write]);
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
    /* ★★ 원본(row_json) 갱신은 **같은 tx** 안에서 — 별도 tx 로 빼면 순서 역전으로
       "장부엔 반영·이력엔 없음"(↩ 불가)이 생긴다. 실패는 ROLLBACK(부분 반영 금지). */
    let writeThrough = null;
    if (wt.write) {
      const n = await _st.writeRowJsonCell(client, {
        sheetId, tabName, rowIndex: row.seq, header: wt.header, value: vText });
      if (!n) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
      const marked = await _st.markLedgerDirty(client, { sheetId, tabName });
      // ★ 조용한 실패 금지 — dirty 를 못 찍었으면 화면이 그 사실을 말한다.
      writeThrough = { column: wt.header, queued: marked, reason: marked ? undefined : 'dirty_mark_failed' };
    }
    await client.query('COMMIT');
    return { ok: true, editId: ins.rows[0].id, anchorType, field, linkedField,
             value: kind === 'bool' ? vBool : vText,
             writeThrough,
             writeThroughSkipped: (isCol && !wt.write) ? wt.reason : undefined };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (e && e.code === '23505') return { ok: false, error: 'concurrent_edit_conflict' };
    throw e;
  }
}

// 단건 편집 — 커넥션 하나를 잡아 위 함수를 그대로 태운다(동작 불변).
async function editWorkdeskRow({ sheetId, tabName, rowId, field, value, by = 'admin' } = {}) {
  const client = await getPool().connect();
  try { return await _editOneInTx(client, { sheetId, tabName, rowId, field, value, by }); }
  finally { client.release(); }
}

/* ★★ 일괄 편집(붙여넣기) — **왕복 1회 · 커넥션 1개**.
 *  종전엔 칸마다 요청이 나가 500칸 붙여넣기가 ① 전역 리미터(분당 120)에 잘리고
 *  ② PG 풀(20)을 고갈시켜 실측 500건 중 419건이 커넥션 타임아웃으로 죽었다.
 *  ★ 건별 트랜잭션을 순차로 돌린다 — 한 tx 로 묶으면 500행을 동시에 FOR UPDATE 로 잡아
 *    그동안 주문 유입·투영이 그 행들에서 멈추고, 한 칸이 거부되면 전부 롤백된다.
 *    붙여넣기는 원래 **칸마다 성패가 갈리는** 조작이라 건별 독립이 의미상으로도 맞다.
 *  ★ 한 건이 던져도 배치를 죽이지 않는다(그 칸만 실패로 보고) — 화면이 그 칸만 되돌린다. */
const EDIT_BATCH_MAX = 500;
async function editWorkdeskRowsBatch({ sheetId, tabName, edits, by = 'admin' } = {}) {
  if (!sheetId || !tabName) throw new Error('editWorkdeskRowsBatch: 필수 인자 누락');
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: 'edits_required' };
  if (edits.length > EDIT_BATCH_MAX) {
    return { ok: false, error: 'too_many_edits', max: EDIT_BATCH_MAX, got: edits.length };
  }
  const client = await getPool().connect();
  const decideCache = new Map();
  const results = [];
  try {
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] || {};
      const rowId = e.rowId, field = e.field;
      if (!rowId || !field) { results.push({ index: i, rowId: rowId || null, field: field || null, ok: false, error: 'rowId, field 필수' }); continue; }
      let r;
      try {
        r = await _editOneInTx(client, { sheetId, tabName, rowId, field, value: e.value, by, decideCache });
      } catch (err) {
        // 그 건의 tx 는 _editOneInTx 안에서 이미 롤백됐다. 커넥션을 재사용하기 전에 한 번 더 확실히 푼다.
        try { await client.query('ROLLBACK'); } catch (_) {}
        logger.warn('[trackB] 일괄 편집 중 개별 실패', { sheetId, tabName, rowId, field, err: err && err.message });
        r = { ok: false, error: 'edit_failed' };
      }
      results.push({ index: i, rowId, field, ...r });
    }
  } finally { client.release(); }
  const succeeded = results.filter(r => r.ok).length;
  return { ok: true, total: results.length, succeeded, failed: results.length - succeeded,
           wroteRowJson: results.filter(r => r.ok && r.writeThrough).length, results };
}

// 편집 되돌리기(개별 행/필드) — 하드삭제 없이 reverted_at 마킹(감사 이력 보존).
async function revertWorkdeskEdit({ sheetId, tabName, rowId, field, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId || !field) throw new Error('revertWorkdeskEdit: 필수 인자 누락');
  if (field === 'is_submitted' || field === 'is_paid' ||
      (typeof field === 'string' && field.startsWith('col:') && _linkedToggle(field.slice(4)))) {
    return { ok: false, error: 'status_column_locked', field };
  }
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: pr } = await client.query(
      `SELECT id, seq, source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json
         FROM campaign_participants WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
    const a = _deriveAnchor(pr[0]);
    if (!a) { await client.query('ROLLBACK'); return { ok: false, error: 'no_stable_anchor' }; }
    let n = 0;
    const doRevert = async (f) => {
      const { rowCount, rows } = await client.query(
        `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
          WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type=$4 AND anchor_value=$5 AND field=$6 AND reverted_at IS NULL
          RETURNING field, value_text, prev_text, had_prev, wrote_row_json`,
        [String(by).slice(0, 100), sheetId, tabName, a.type, a.value, f]);
      return { rowCount, edit: rows[0] || null };
    };
    const r0 = await doRevert(field);
    let revertedPrimary = r0.rowCount; n += r0.rowCount;
    let primaryEdit = r0.edit;
    // 앵커 승격분: 빈 자리였을 때 물리행 앵커로 저장된 값은 읽을 때 합성되므로, 되돌리기도 그쪽을 함께 지운다
    //   (안 지우면 ↩ 를 눌러도 옛 값이 그대로 다시 보인다).
    if (a.value !== String(pr[0].id)) {
      const { rowCount, rows } = await client.query(
        `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
          WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type='manual' AND anchor_value=$4 AND field=$5 AND reverted_at IS NULL
          RETURNING field, value_text, prev_text, had_prev, wrote_row_json`,
        [String(by).slice(0, 100), sheetId, tabName, String(pr[0].id), field]);
      n += rowCount; revertedPrimary += rowCount;
      primaryEdit = primaryEdit || rows[0] || null;
    }
    // 연동 되돌리기: col:리뷰제출/입금 을 되돌리면 링크된 물리 토글도 함께 되돌림.
    //   ★ primary 가 실제로 되돌렸을 때만 연쇄(독립적으로 토글한 is_submitted 를 무관한 revert 로 지우지 않게).
    const linked = field.indexOf('col:') === 0 ? _linkedToggle(field.slice(4)) : null;
    if (linked && revertedPrimary > 0) n += (await doRevert(linked)).rowCount;

    /* ── 쓰기-through 편집이었으면 원본도 되돌린다(132) ──
       ★★ 그 사이 다른 경로(주문 유입 등)가 같은 칸을 바꿨으면 **덮지 않는다** —
          옛 값으로 되돌리는 것이 곧 데이터 손상이다. 화면이 사유를 말한다. */
    let rowJsonRestored = false, supersededReason = null;
    if (primaryEdit && primaryEdit.wrote_row_json) {
      const _st = require('./sheetlessStatus.service');
      const header = String(primaryEdit.field).slice(4);
      const rj = (pr[0].row_json && typeof pr[0].row_json === 'object') ? pr[0].row_json : {};
      const cur = String(rj[header] == null ? '' : rj[header]);
      if (cur !== String(primaryEdit.value_text == null ? '' : primaryEdit.value_text)) {
        supersededReason = 'superseded';
      } else {
        if (primaryEdit.had_prev) {
          await _st.writeRowJsonCell(client, { sheetId, tabName, rowIndex: pr[0].seq, header, value: primaryEdit.prev_text || '' });
        } else {
          await _st.removeRowJsonCell(client, { sheetId, tabName, rowIndex: pr[0].seq, header });
        }
        await _st.markLedgerDirty(client, { sheetId, tabName });
        rowJsonRestored = true;
      }
    }
    await client.query('COMMIT');
    return { ok: true, reverted: n, rowJsonRestored,
             reason: supersededReason || undefined,
             message: supersededReason ? '표시는 되돌렸지만 원본 값은 그 사이 다른 경로가 바꿔 유지했습니다.' : undefined };
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
}

// 제거: manual 물리행=soft-delete(재투영 부활 없음), import행=hidden 오버레이(앵커 불변).
// 관리자 수동 리뷰제출: 기존 리뷰 업로드 원장에 연결된 이미지로만 제출을 확정한다.
function _manualReviewFileIds(fileIds) {
  if (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 5) return null;
  const ids = [...new Set(fileIds.map(v => String(v || '').trim()))];
  if (ids.length !== fileIds.length || ids.some(v => !/^[A-Za-z0-9_-]{10,200}$/.test(v))) return null;
  return ids;
}

async function manualWorkdeskReviewSubmit({ sheetId, tabName, rowId, fileIds, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId) throw new Error('manualWorkdeskReviewSubmit: 필수 인자 누락');
  const ids = _manualReviewFileIds(fileIds);
  if (!ids) return { ok: false, error: 'invalid_review_files' };
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: pr } = await client.query(
      `SELECT id, seq, reviewer_name, submit_col, is_submitted,
              source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json
         FROM campaign_participants
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL AND active=TRUE FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
    const participant = pr[0];
    const submitCol = String(participant.submit_col || '').trim();
    if (!submitCol) { await client.query('ROLLBACK'); return { ok: false, error: 'submit_column_missing' }; }

    const { rows: ir } = await client.query(
      `SELECT is_submitted FROM review_index
        WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 FOR UPDATE`,
      [sheetId, tabName, participant.seq]);
    if (!ir.length) { await client.query('ROLLBACK'); return { ok: false, error: 'review_history_missing' }; }
    if (participant.is_submitted || ir[0].is_submitted) {
      await client.query('ROLLBACK'); return { ok: false, error: 'already_submitted' };
    }

    // 파일 ID를 조작해 다른 행의 첨부를 제출하지 못하도록 업로드 원장을 대조한다.
    const { rows: ownedFiles } = await client.query(
      `SELECT file_id FROM review_submissions
        WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3
          AND slot_key = 'review' AND file_id = ANY($4::text[])`,
      [sheetId, tabName, participant.seq, ids]);
    if (new Set(ownedFiles.map(r => String(r.file_id))).size !== ids.length) {
      await client.query('ROLLBACK'); return { ok: false, error: 'review_file_not_owned' };
    }

    // 잠금 도입 전의 직접 입력 오버레이가 새 시스템 값을 가리지 않도록, 대상 행 것만 감사 이력으로 되돌린다.
    let anchor = _deriveAnchor(participant);
    // identity 앵커는 같은 탭의 중복 참여자가 공유할 수 있다. 단일 행일 때만 정리한다.
    if (anchor && anchor.type === 'identity') {
      const { rows: dup } = await client.query(
        `SELECT COUNT(*)::int AS n FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
            AND order_submission_id IS NULL AND source<>'manual' AND identity_key=$3`,
        [sheetId, tabName, anchor.value]);
      if ((dup[0] && dup[0].n || 0) > 1) anchor = null;
    }
    if (anchor) {
      await client.query(
        `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
          WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type=$4 AND anchor_value=$5
            AND field = ANY($6::text[]) AND reverted_at IS NULL`,
        [String(by).slice(0, 100), sheetId, tabName, anchor.type, anchor.value, [`col:${submitCol}`, 'is_submitted']]);
    }

    // 제출시각을 실제 작업보드 리뷰제출 열에 쓰고, 두 원장의 제출 상태를 같은 트랜잭션에서 확정한다.
    const { rows: updated } = await client.query(
      `UPDATE campaign_participants
          SET is_submitted=TRUE,
              row_json=COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($4::text, to_char(NOW() AT TIME ZONE 'Asia/Seoul', 'FMMM/FMDD HH24:MI')),
              updated_at=NOW(), updated_by=$5
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3
        RETURNING to_char(NOW() AT TIME ZONE 'Asia/Seoul', 'FMMM/FMDD HH24:MI') AS submit_value`,
      [rowId, sheetId, tabName, submitCol, String(by).slice(0, 100)]);
    await client.query(
      `UPDATE review_index SET is_submitted = TRUE, built_at = NOW()
        WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3`,
      [sheetId, tabName, participant.seq]);
    await client.query(
      `UPDATE index_master SET submitted_count = submitted_count + 1
        WHERE sheet_id=$1 AND tab_name=$2 AND submitted_count < row_count`,
      [sheetId, tabName]).catch(() => null);
    await client.query('COMMIT');

    try {
      require('../utils/sse').emitReviewSubmit({
        sheetId, tabName, reviewer: participant.reviewer_name || '', rowIndex: participant.seq,
        dbUpdated: true, sheetsWritten: false,
      });
    } catch (_) { /* 실시간 알림 실패는 제출 상태를 되돌리지 않는다. */ }
    return { ok: true, rowId, rowIndex: participant.seq, submitColumn: submitCol, submitValue: updated[0] && updated[0].submit_value };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}


// 행 삭제 실패 사유. 트랜잭션 본문은 이 예외로만 중단한다.
class HideRowError extends Error {
  constructor(code) { super(code); this.name = 'HideRowError'; this.code = code; }
}

// 주문(구매양식) 취소와 같은 트랜잭션 안에서 돌 수 있도록 client 를 주입받는다.
// 실패는 반환이 아니라 throw 로 알린다 — 반환으로 접으면 바깥의 주문 취소가 그대로 커밋되어
// "주문은 취소됐는데 작업표 행은 그대로"인 단절이 생긴다.
async function _hideParticipantInTx(client, { sheetId, tabName, rowId, by }) {
    // 작업표 행과 리뷰어 참여내역은 같은 참여 단위다. 기존처럼 화면 오버레이만
    // 숨기면 review_index/order_submissions 쪽의 "내 참여내역"이 남아 서로 다른
    // 사실을 말하게 된다. 행을 잠근 뒤, 이 행에만 연결된 신원·참여 링크를 함께 해제한다.
    const { rows } = await client.query(
      `SELECT id, seq, phone8, row_json, order_submission_id
         FROM campaign_participants
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL
        FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!rows.length) throw new HideRowError('row_not_found');
    const row = rows[0];

    // ★ 무시트(sheetless) 작업만 지울 수 있다 — 시트 기반 작업은 다음 시트 반영이
    //   같은 행을 되살려 "지웠는데 돌아오는" 상태가 된다. 종전에는 이 게이트가 공고
    //   조회 SQL 안에 묻혀 있었는데, 공고 없이도 삭제할 수 있게 되면서 명시 검사로 뺐다.
    const { rows: tabCfg } = await client.query(
      `SELECT COALESCE(sheetless,FALSE) AS sheetless
         FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`, [sheetId, tabName]);
    if (!tabCfg.length || tabCfg[0].sheetless !== true) throw new HideRowError('not_sheetless');

    // 행 삭제가 곧 총 모집수 축소가 되면 안 된다. 지운 자리는 같은 트랜잭션 안에서
    // 작업표의 마지막 진행일에 "빈 자리"로 다시 만든다(총 건수 불변).
    // 내부 seq는 주문·리뷰 원장의 연결키이므로 재번호화하지 않는다. 화면의 #만
    // 표시 순번으로 계산해 1~총건수 범위를 유지한다.
    //
    // 연결된 모집공고가 있으면 그 공고의 날짜별 계획도 함께 옮긴다(삭제된 날 -1 /
    // 마지막 날 +1 — 총 계획량은 불변). 어느 공고인지는 아래 순서로 좁힌다.
    //   ① 그 주문에 연결된 공고(campaign_applications) — 한 작업표를 여러 공고가 쓸 때의 정답
    //   ② 게시 중/임시저장 공고   ③ 그 외(마감 등)
    // ★★ 공고를 하나로 좁히지 못해도 삭제를 막지 않는다 — 보충은 작업보드에 하면 되고,
    //   계획 이동만 건너뛴다(남의 공고 계획을 추측해 바꾸지 않는다). 종전에는 공고가
    //   없거나 둘 이상이면 거부해, 공고 없이 운영하는 작업표는 행을 지울 방법이 없었다.
    const { rows: scopeRows } = await client.query(
      `SELECT rc.id AS campaign_id,
              (rc.status IN ('draft','active')) AS is_open,
              EXISTS (
                SELECT 1 FROM campaign_applications ca
                 WHERE ca.campaign_id=rc.id AND ca.order_submission_id=$3::uuid
              ) AS is_linked
         FROM recruit_campaigns rc
        WHERE rc.linked_sheet_id=$1 AND rc.linked_tab_name=$2
        ORDER BY rc.updated_at DESC
        LIMIT 10
        FOR UPDATE`,
      [sheetId, tabName, row.order_submission_id || null]);
    // 주문이 없는 행($3=NULL)이면 is_linked 는 전부 거짓이라 자연히 ②로 내려간다.
    const linked = scopeRows.filter(r => r.is_linked);
    const open = scopeRows.filter(r => r.is_open);
    const tier = linked.length ? linked : (open.length ? open : scopeRows);
    const campaignId = tier.length === 1 ? tier[0].campaign_id : null;
    const campaignScope = tier.length === 1 ? 'linked' : (scopeRows.length ? 'ambiguous' : 'none');

    const { rows: tabRows } = await client.query(
      `SELECT seq, tab_gid, row_json
         FROM campaign_participants
        WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
        ORDER BY seq
        FOR UPDATE`, [sheetId, tabName]);
    const headers = [];
    for (const r of tabRows) for (const key of Object.keys(r.row_json || {})) {
      if (key && !headers.includes(key)) headers.push(key);
    }
    const { findDateColumnIndex } = require('./campaignSchedule.service');
    const { parseDateColumn } = require('../utils/koreanDate');
    const { kstTodayStr } = require('./campaignState.service');
    const dateIdx = findDateColumnIndex(headers);
    const dateHeader = dateIdx >= 0 ? headers[dateIdx] : null;

    // 연결 공고가 있을 때만 계획 이동에 쓸 "마지막 계획일"을 읽는다.
    let finalPlan = null;
    if (campaignId) {
      const { rows: plans } = await client.query(
        `SELECT to_char(plan_date,'YYYY-MM-DD') AS date, planned_count
           FROM campaign_daily_plans
          WHERE campaign_id=$1 AND planned_count > 0
          ORDER BY plan_date DESC
          LIMIT 1
          FOR UPDATE`, [campaignId]);
      finalPlan = plans.length ? plans[0] : null;
    }
    const todayAnchor = (() => {
      const m = String(kstTodayStr() || '').match(/^(\d{4})-(\d{2})/);
      return m ? { y: Number(m[1]), m: Number(m[2]) } : undefined;
    })();
    const finalYearMonth = finalPlan ? String(finalPlan.date).match(/^(\d{4})-(\d{2})/) : null;
    const anchor = finalYearMonth ? { y: Number(finalYearMonth[1]), m: Number(finalYearMonth[2]) } : todayAnchor;
    const rawDates = dateHeader ? tabRows.map(r => String((r.row_json || {})[dateHeader] || '')) : [];
    const parsedDates = dateHeader ? parseDateColumn(rawDates, { fallbackAnchor: anchor }) : [];
    const removedRaw = dateHeader ? String((row.row_json || {})[dateHeader] || '') : '';
    const [removedDate] = dateHeader ? parseDateColumn([removedRaw], { fallbackAnchor: anchor }) : [null];

    // 보충할 자리의 구매일자.
    //   ① 연결 공고의 마지막 계획일 → ② 작업표에서 가장 늦은 진행일(표기 그대로)
    //   → ③ 삭제한 행의 그 날짜 값(같은 자리에 그대로 보충)
    // ★ ②는 시트 표기를 그대로 옮겨 형식 드리프트를 만들지 않는다.
    const planLabel = (() => {
      const m = finalPlan ? String(finalPlan.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
      if (!m) return '';
      const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
      return `${Number(m[2])}/${Number(m[3])} (${['일','월','화','수','목','금','토'][day]})`;
    })();
    const lastSheetLabel = (() => {
      let best = null; let bestRaw = '';
      parsedDates.forEach((d, i) => { if (d && (!best || d > best)) { best = d; bestRaw = rawDates[i]; } });
      return bestRaw;
    })();
    const finalDateLabel = planLabel || lastSheetLabel || removedRaw;

    // 행 자체는 실제 삭제한다. 삭제 표식은 별도 최소 테이블에 두어, 작업표 행을
    // 논리삭제 레코드로 남기지 않으면서도 재투영에 의해 같은 seq가 되살지 않게 한다.
    await client.query(
      `INSERT INTO workdesk_participant_deletions
         (sheet_id, tab_name, seq, order_submission_id, deleted_by)
       VALUES ($1,$2,$3,$4::uuid,$5)
       ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING`,
      [sheetId, tabName, row.seq, row.order_submission_id || null, String(by).slice(0, 100)]);
    const removed = await client.query(
      `DELETE FROM campaign_participants
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3`,
      [rowId, sheetId, tabName]);
    if (removed.rowCount !== 1) throw new HideRowError('row_changed');

    // 시트 기반 보조 신원 링크도 정확히 이 행(seq)만 제거한다. 동명이인·다른
    // 작업의 링크는 전혀 건드리지 않는다.
    const links = await client.query(
      `DELETE FROM participation_links
        WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3`,
      [sheetId, tabName, row.seq]);

    // 구매양식으로 확정된 참여는 주문 UUID로만 찾아 취소한다. order_submission_id가
    // 없는 수동/이관 행은 여기서 다른 공고의 참여상태를 추측해 바꾸지 않는다.
    let applications = { rowCount: 0 };
    if (row.order_submission_id) {
      applications = await client.query(
        // ★ campaign_applications 에는 updated_at 컬럼이 없다(018 생성 · 045/078/082/101 증설분에도 없음).
        // 넣으면 42703 으로 이 트랜잭션 전체가 죽어 "구매기록이 붙은 행만 삭제 불가"가 된다.
        `UPDATE campaign_applications
            SET status='cancelled', submitted_at=NULL, order_submission_id=NULL,
                expires_at=NOW(), hold_token=NULL
          WHERE order_submission_id=$1::uuid AND status IN ('applied','submitted')`,
        [row.order_submission_id]);
    }

    // ★ 보충 슬롯은 무조건 만든다 — 이것이 "총 모집인원은 줄지 않는다"의 실체다.
    const blank = {};
    headers.forEach(h => { blank[h] = ''; });
    if (dateHeader) blank[dateHeader] = finalDateLabel;
    const maxSeq = tabRows.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0);
    const replacement = await client.query(
      `INSERT INTO campaign_participants
         (sheet_id, tab_gid, tab_name, seq, start_date, row_json, source, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'worktable',$7,NOW())
       RETURNING id, seq`,
      [sheetId, (tabRows[0] && tabRows[0].tab_gid) || null, tabName, maxSeq + 1,
        finalDateLabel || null, JSON.stringify(blank), String(by).slice(0, 100)]);

    // 삭제된 날 -1 / 마지막 진행일 +1 = 날짜별 배치만 이동한다. 총 계획량은 바뀌지 않는다.
    // 공고를 못 고른 경우(none/ambiguous)와 날짜를 못 읽은 경우엔 계획을 건드리지 않는다.
    let planMoved = false;
    if (campaignId && finalPlan && removedDate && removedDate !== finalPlan.date) {
      const dateCount = new Map();
      parsedDates.forEach(d => { if (d) dateCount.set(d, (dateCount.get(d) || 0) + 1); });
      const { rows: sourcePlans } = await client.query(
        `SELECT to_char(plan_date,'YYYY-MM-DD') AS date, planned_count
           FROM campaign_daily_plans
          WHERE campaign_id=$1 AND plan_date=$2::date
          FOR UPDATE`, [campaignId, removedDate]);
      const sourceCount = sourcePlans.length ? Number(sourcePlans[0].planned_count) : (dateCount.get(removedDate) || 0);
      if (sourceCount >= 1) {
        await client.query(
          `UPDATE campaign_daily_plans
              SET planned_count=planned_count+1, updated_by=$3, updated_at=NOW()
            WHERE campaign_id=$1 AND plan_date=$2::date`,
          [campaignId, finalPlan.date, `행삭제 보충:${by}`.slice(0, 100)]);
        await client.query(
          `INSERT INTO campaign_daily_plans (campaign_id, plan_date, planned_count, updated_by, updated_at)
           VALUES ($1,$2::date,$3,$4,NOW())
           ON CONFLICT (campaign_id,plan_date) DO UPDATE
             SET planned_count=EXCLUDED.planned_count, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
          [campaignId, removedDate, sourceCount - 1, `행삭제 이동:${by}`.slice(0, 100)]);
        planMoved = true;
      }
    }
    if (campaignId) {
      await client.query(
        `INSERT INTO campaign_plan_events (campaign_id, actor, action, detail)
         VALUES ($1,$2,'participant_delete_replenish',$3::jsonb)`,
        [campaignId, String(by).slice(0, 100),
          JSON.stringify({ removedSeq: row.seq, removedDate, finalDate: finalPlan && finalPlan.date, added: 1, planMoved })]);
    }
    return {
      removed: removed.rowCount,
      participationLinksRemoved: links.rowCount,
      applicationsCancelled: applications.rowCount,
      replenished: 1,
      campaignScope,
      planMoved,
      finalPlanDate: finalPlan ? finalPlan.date : null,
      replacementDate: finalDateLabel || null,
      replacementSeq: replacement.rows[0] && replacement.rows[0].seq,
    };
}

// 작업보드 행 삭제. 이 행이 "실제 리뷰어의 구매기록"이면 그 구매양식까지 함께 취소한다.
// ★ 총 모집인원은 줄이지 않는다 — 지운 자리는 마지막 진행일의 빈 자리로 보충되어
//   다시 모집할 수 있는 상태로 남는다(그 보충은 본문이 같은 트랜잭션에서 한다).
// ★ 주문 취소와 행 제거는 반드시 한 트랜잭션 — 한쪽만 반영되면 원장과 작업표가 갈린다.
async function hideWorkdeskRow({ sheetId, tabName, rowId, by = 'admin', actorRole = null } = {}) {
  const db = getPool();
  // 살아 있는 구매양식이 붙은 행인지 먼저 본다(짧은 조회 — 잠금 없음).
  let liveOrderId = null;
  try {
    const { rows } = await db.query(
      `SELECT cp.order_submission_id AS oid
         FROM campaign_participants cp
         JOIN order_submissions os ON os.id = cp.order_submission_id AND os.deleted_at IS NULL
        WHERE cp.id = $1 AND cp.sheet_id = $2 AND cp.tab_name = $3 AND cp.deleted_at IS NULL`,
      [rowId, sheetId, tabName]);
    liveOrderId = rows.length ? rows[0].oid : null;
  } catch (e) {
    // 조회 실패를 "주문 없음"으로 접으면 구매양식이 남은 채 행만 사라진다.
    logger.warn(`[trackB] 행 삭제 전 주문 조회 실패 tab=${tabName}: ${(e && e.message) || e}`);
    return { ok: false, error: 'order_lookup_failed' };
  }

  // 구매기록 취소는 금액·시트 주문값을 함께 바꾸므로 order-delete 와 같은 권한을 요구한다.
  // (actorRole 미전달 = 옛 호출부 → 종전대로 통과. 라우트가 항상 넘긴다.)
  if (liveOrderId && actorRole && !(actorRole === 'master' || actorRole === 'admin')) {
    return { ok: false, error: 'order_cancel_forbidden' };
  }

  const runInOwnTx = async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const out = await _hideParticipantInTx(client, { sheetId, tabName, rowId, by });
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e;
    } finally { client.release(); }
  };

  let result = null;
  let orderCanceled = false;
  let sheetCleared = false;
  try {
    if (liveOrderId) {
      const { cancelOrderSubmission } = require('./orderCancellation.service');
      const canceled = await cancelOrderSubmission({
        orderSubmissionId: liveOrderId,
        canceledBy: by,
        // 행 제거·총원 보충을 주문 취소와 같은 트랜잭션에 둔다. 여기서 throw 하면 취소도 롤백된다.
        beforeCancelCommit: async (client) => { result = await _hideParticipantInTx(client, { sheetId, tabName, rowId, by }); },
      });
      if (!canceled || !canceled.ok) return { ok: false, error: (canceled && canceled.code) || 'order_cancel_failed' };
      // 그 사이 다른 경로가 먼저 취소했다면 본문이 돌지 않았다 — 행 제거만 이어서 한다.
      if (!result) result = await runInOwnTx();
      else { orderCanceled = true; sheetCleared = !!canceled.cleared; }
    } else {
      result = await runInOwnTx();
    }
  } catch (e) {
    if (e instanceof HideRowError) return { ok: false, error: e.code };
    // 예상 밖 오류(SQL·제약·타임아웃 등)를 그대로 500 으로 올리면 errorHandler 가
    // "서버 오류가 발생했습니다."로 마스킹해 담당자가 원인을 알 길이 없다.
    // 이 라우트는 내부 관리자 전용이라 원인 코드를 그대로 돌려준다(관리자 도구 규율).
    logger.error(`[trackB] 행 삭제 실패 tab=${tabName} row=${rowId} order=${liveOrderId || '-'}: ${(e && e.code) || ''} ${(e && e.message) || e}`);
    return {
      ok: false,
      error: 'unexpected',
      pgCode: (e && e.code) || null,
      detail: String((e && e.message) || e).slice(0, 300),
    };
  }

  let ledgerError = null;
  try { await _rebuildWorkdeskLedgers({ sheetId, tabName, by: `participant-delete:${by}` }); }
  catch (e) { ledgerError = (e && (e.code || e.message)) || 'rebuild_failed'; logger.warn(`[trackB] 행 삭제 후 장부 재생성 실패 tab=${tabName}: ${ledgerError}`); }
  _tabStatsCache = { at: 0, map: null };
  return { ok: true, mode: 'hard_deleted', orderCanceled, sheetCleared, ...result, ledgerError };
}

// 주문이 연결된 한 행을 안전하게 취소한다. 시트 물리행은 유지하고 주문값만 큐로 비워 행 이동 오염을 막는다.
async function previewWorkdeskOrderDelete(args) { return workdeskOrderDelete.previewWorkdeskOrderDelete(args); }
async function deleteWorkdeskOrderRow(args) {
  const out = await workdeskOrderDelete.deleteWorkdeskOrderRow(args);
  if (out.ok) _tabStatsCache = { at: 0, map: null };
  return out;
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

// ══ 리뷰웹시스템[3버전] 커스텀 열(행별 자유메모) + 셀 배경색(드래그 범위, migration 080) ══
//   ★ 격리: participant_edits/write-back 무접촉 신규 테이블만 사용 — 시트에 절대 쓰지 않는다.
//   ★ 앵커는 편집 오버레이와 동일 철학(order > manual > identity) — 재투영에도 값이 같은 행을 따라간다.
async function listCustomColumns({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) throw new Error('listCustomColumns: sheetId, tabName 필수');
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, col_name AS "colName", sort_order AS "sortOrder"
       FROM trackb_custom_columns WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL
      ORDER BY sort_order, created_at`, [sheetId, tabName]);
  return rows;
}
async function addCustomColumn({ sheetId, tabName, colName, by = 'admin' } = {}) {
  const name = String(colName || '').trim().slice(0, 60);
  if (!sheetId || !tabName || !name) return { ok: false, error: 'sheetId, tabName, colName 필수' };
  const db = getPool();
  const { rows: mx } = await db.query(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM trackb_custom_columns
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`, [sheetId, tabName]);
  const { rows } = await db.query(
    `INSERT INTO trackb_custom_columns (sheet_id, tab_name, col_name, sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, col_name AS "colName", sort_order AS "sortOrder"`,
    [sheetId, tabName, name, mx[0].n, String(by).slice(0, 100)]);
  return { ok: true, column: rows[0] };
}
async function deleteCustomColumn({ sheetId, tabName, columnId } = {}) {
  if (!sheetId || !tabName || !columnId) return { ok: false, error: 'sheetId, tabName, columnId 필수' };
  const db = getPool();
  const { rowCount } = await db.query(
    `UPDATE trackb_custom_columns SET deleted_at=NOW()
      WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL`,
    [columnId, sheetId, tabName]);
  return { ok: rowCount > 0 };
}
// 쓰기용 앵커 도출(editWorkdeskRow과 동형) — identity 앵커는 중복 카운트까지 재검증해 ambiguous면 거부.
//   ★ 같은 검증을 안 하면 서로 다른 물리행(동명이인 등)이 같은 identity 키를 공유할 때 한 사람의 메모/색이
//     엉뚱한 다른 행에도 나타난다(workdeskTab 합성측 ambiguous 게이트와 대칭 — 쓰기측에도 반드시 필요).
async function _resolveAnchorForWrite(client, sheetId, tabName, row) {
  if (row.order_submission_id) return { type: 'order', value: String(row.order_submission_id) };
  if (row.source === 'manual') return { type: 'manual', value: String(row.id) };
  let ik = row.identity_key;
  if (!ik) {
    ik = identityKey(_ikFromRow(row));
    if (ik) await client.query(`UPDATE campaign_participants SET identity_key=$2 WHERE id=$1 AND identity_key IS NULL`, [row.id, ik]);
  }
  if (!ik) return null;
  const { rows: dup } = await client.query(
    `SELECT COUNT(*)::int AS n FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
        AND order_submission_id IS NULL AND source<>'manual' AND identity_key=$3`,
    [sheetId, tabName, ik]);
  if ((dup[0].n || 0) > 1) return { ambiguous: true };
  return { type: 'identity', value: ik };
}
async function setCustomColumnValue({ sheetId, tabName, rowId, columnId, value, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId || !columnId) return { ok: false, error: 'sheetId, tabName, rowId, columnId 필수' };
  const db = getPool();
  const { rows: cc } = await db.query(
    `SELECT id FROM trackb_custom_columns WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL`,
    [columnId, sheetId, tabName]);
  if (!cc.length) return { ok: false, error: 'column_not_found' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: pr } = await client.query(
      `SELECT id, source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json
         FROM campaign_participants WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
    const anchor = await _resolveAnchorForWrite(client, sheetId, tabName, pr[0]);
    if (!anchor) { await client.query('ROLLBACK'); return { ok: false, error: 'no_stable_anchor' }; }
    if (anchor.ambiguous) { await client.query('ROLLBACK'); return { ok: false, error: 'ambiguous_identity' }; }
    const text = value == null ? '' : String(value).slice(0, 2000);
    await client.query(
      `INSERT INTO trackb_custom_column_values (column_id, anchor_type, anchor_value, value_text, updated_by)
         VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (column_id, anchor_type, anchor_value)
         DO UPDATE SET value_text=$4, updated_by=$5, updated_at=NOW()`,
      [columnId, anchor.type, anchor.value, text, String(by).slice(0, 100)]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
}

// 셀 배경색 일괄 저장/해제 — 드래그로 잡은 (rowId, field) 목록에 한 색을 적용(color=''는 해제).
//   field: 'col:<시트헤더>' | 'ccol:<커스텀열id>' | 'idname' | 'idphone'(신원 3열 중 색 지정 가능한 2개, '#'은 대상 제외).
//   행별 FOR UPDATE 트랜잭션(editWorkdeskRow과 동형) — 같은 행의 여러 필드는 한 트랜잭션에 묶어 왕복을 줄인다.
async function setCellColors({ sheetId, tabName, cells, color, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !Array.isArray(cells) || !cells.length) return { ok: false, error: 'sheetId, tabName, cells 필수' };
  if (cells.length > 3000) return { ok: false, error: 'too_many_cells' };
  const db = getPool();
  const byRow = new Map();
  for (const c of cells) {
    const rid = String((c && c.rowId) || ''), field = String((c && c.field) || '').trim();
    if (!rid || !field) continue;
    if (!byRow.has(rid)) byRow.set(rid, []);
    byRow.get(rid).push(field);
  }
  if (!byRow.size) return { ok: false, error: 'cells 필수' };
  const col = String(color == null ? '' : color).trim();
  if (col && !/^#[0-9a-fA-F]{6}$/.test(col)) return { ok: false, error: 'invalid_color' };
  let applied = 0, skipped = 0;
  for (const [rowId, fields] of byRow) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: pr } = await client.query(
        `SELECT id, source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json
           FROM campaign_participants WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL FOR UPDATE`,
        [rowId, sheetId, tabName]);
      if (!pr.length) { await client.query('ROLLBACK'); skipped += fields.length; continue; }
      const anchor = await _resolveAnchorForWrite(client, sheetId, tabName, pr[0]);
      if (!anchor || anchor.ambiguous) { await client.query('ROLLBACK'); skipped += fields.length; continue; }
      for (const field of fields) {
        if (!col) {
          await client.query(
            `DELETE FROM trackb_cell_colors WHERE sheet_id=$1 AND tab_name=$2 AND anchor_type=$3 AND anchor_value=$4 AND field=$5`,
            [sheetId, tabName, anchor.type, anchor.value, field]);
        } else {
          await client.query(
            `INSERT INTO trackb_cell_colors (sheet_id, tab_name, anchor_type, anchor_value, field, color, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (sheet_id, tab_name, anchor_type, anchor_value, field)
               DO UPDATE SET color=$6, created_by=$7, created_at=NOW()`,
            [sheetId, tabName, anchor.type, anchor.value, field, col, String(by).slice(0, 100)]);
        }
        applied++;
      }
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} skipped += fields.length; }
    finally { client.release(); }
  }
  // Do not acknowledge a partial write: the client must refresh from the
  // persisted source of truth instead of retaining only an optimistic color.
  return skipped
    ? { ok: false, error: 'cell_color_save_incomplete', applied, skipped }
    : { ok: true, applied, skipped };
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
  const byOrder = new Map(), byManual = new Map(), byIdent = new Map(), identCount = new Map(), orderCount = new Map();
  for (const r of roster) {
    if (r.deleted_at || !r.active) continue;
    byManual.set(String(r.id), r);
    // ★ order 앵커도 중복을 센다 — 유니크가 아니라, 세지 않으면 `set` 이 마지막 행으로 조용히 덮어
    //   **어느 줄인지 모르는 채 한 줄을 골라** 시트에 쓰게 된다(identity 와 같은 규율).
    if (r.order_submission_id) {
      const ok = String(r.order_submission_id);
      orderCount.set(ok, (orderCount.get(ok) || 0) + 1);
      if (!byOrder.has(ok)) byOrder.set(ok, r);
    }
    if (r.source !== 'manual') { const ik = r.identity_key || identityKey(_ikFromRow(r)); if (ik) { identCount.set(ik, (identCount.get(ik) || 0) + 1); if (!byIdent.has(ik)) byIdent.set(ik, r); } }
  }
  let headers = [];
  const gid = (roster.find(r => r.tab_gid) || {}).tab_gid || null;
  try { const ctx = await ol.loadRawTabContext(sheetId, gid, tabName); headers = (ctx && ctx.headers) || []; } catch (_) {}
  const mask = headers.length ? _wbOrderMappedMask(headers) : [];

  const resolve = (e) => {
    if (e.anchor_type === 'order') return (orderCount.get(e.anchor_value) || 0) > 1 ? { __ambiguous: true } : (byOrder.get(e.anchor_value) || null);
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

  /* ★★ 무시트 탭은 **밀어넣을 시트가 없다**(탈 구글시트 W3).
     그대로 엔진에 넣으면 행마다 `readSheet` 가 404 로 떨어져 `deferred` 만 쌓이고
     **영원히 수렴하지 않는다**(조용한 무한 연기 — 화면엔 "반영 대기"로만 보인다).
     무시트에서 그 자리를 대신하는 것은 **작업표**이므로, 상태 토글은 작업표 칸에 기록한다
     (`sheetlessStatus.markStatusCell` = 리뷰 제출·입금 완료와 **같은 단일 경로**).
     ★ 토글 외 필드 편집은 `held`(수동 대상)로 남긴다 — 어느 칸에 쓸지는 사람이 정한다. */
  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(getPool(), sheetId, tabName); }
  catch (_) { sheetless = false; }   // 판정 실패 = 모른다 → 종전 엔진(시트 경로)
  if (sheetless) return _writebackSheetless({ sheetId, tabName });

  return _writebackEngine({ sheetId, tabName, tier: 'base' });
}

/**
 * 무시트 탭의 상태 토글 반영 — 시트 대신 작업표 칸에 기록한다.
 * ★ 판정·기록 사본 0: `sheetlessStatus.markStatusCell` 한 경로만 쓴다.
 * ★ 해제(false)는 지원하지 않는다 — blank-only 규율상 시트 경로도 값을 지우지 못하고,
 *   무시트에서만 지우기를 열면 두 경로의 의미가 갈린다(`held` 로 남겨 사람이 처리).
 */
async function _writebackSheetless({ sheetId, tabName }) {
  const db = getPool();
  const markStatus = async (id, st) => {
    try {
      await db.query(
        `UPDATE participant_edits SET writeback_status=$2, writeback_at=NOW() WHERE id=$1`, [id, st]);
    } catch (_) { /* 표시 실패는 다음 주기 재픽업 */ }
  };
  const { rows } = await db.query(
    `SELECT pe.id, pe.field, pe.value_bool, cp.seq AS row_index
       FROM participant_edits pe
       LEFT JOIN campaign_participants cp
              ON cp.sheet_id = pe.sheet_id AND cp.tab_name = pe.tab_name
             AND cp.deleted_at IS NULL
             AND ( (pe.anchor_type = 'order'    AND cp.order_submission_id::text = pe.anchor_value)
                OR (pe.anchor_type = 'manual'   AND cp.id::text                  = pe.anchor_value)
                OR (pe.anchor_type = 'identity' AND cp.identity_key              = pe.anchor_value) )
      WHERE pe.sheet_id=$1 AND pe.tab_name=$2 AND pe.reverted_at IS NULL
        AND pe.field IN ('is_submitted','is_paid')
        AND (pe.writeback_status IS NULL
             OR (pe.writeback_status='blocked' AND (pe.writeback_at IS NULL OR pe.writeback_at < NOW() - INTERVAL '30 minutes')))
      LIMIT 200`, [sheetId, tabName]);

  /* ★ identity 앵커는 한 편집이 여러 행에 걸릴 수 있다(동명이인). 상류 게이트가 모호한 identity 를
     거르지만 여기서도 fail-closed — **어느 줄인지 모르면 쓰지 않는다**(엉뚱한 줄에 입금 표시가 남는다). */
  const seen = new Map();
  for (const r of rows) {
    const cur = seen.get(r.id);
    if (!cur) seen.set(r.id, { ...r, _n: 1 });
    else { cur._n++; if (String(cur.row_index) !== String(r.row_index)) cur.row_index = null; }
  }

  let written = 0, held = 0, blocked = 0;
  const st = require('./sheetlessStatus.service');
  for (const e of seen.values()) {
    if (e.value_bool !== true) { await markStatus(e.id, 'held'); held++; continue; }   // 해제는 사람이
    if (!e.row_index) { await markStatus(e.id, 'blocked'); blocked++; continue; }      // 행 앵커 없음 = 자가치유 재시도
    let r = null;
    try {
      /* ★ 장부 재생성은 이 자리에서 하지 않는다(132) — `blocked` 항목이 30분마다 재픽업되면서
         그때마다 전량 재생성을 유발해 주문 유입과 락을 다툰다. dirty 만 찍고 스윕이 탭당 1회 흡수한다. */
      r = await st.markStatusCell({
        sheetId, tabName, rowIndex: e.row_index,
        kind: e.field === 'is_submitted' ? 'submit' : 'paid', by: 'writeback', deferRebuild: true,
      });
    } catch (_) { r = null; }
    if (r && r.handled && r.ok) {
      try { await st.markLedgerDirty(db, { sheetId, tabName }); } catch (_) {}
      await markStatus(e.id, 'written'); written++; }
    else { await markStatus(e.id, 'blocked'); blocked++; }
  }
  return { tabName, sheetless: true, written, held, blocked, deferred: 0 };
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

// ── 작업목록 즐겨찾기(로그인 계정별 개인화·영속) — Track B 리뷰웹시스템[3버전] 사이드바 ──
//   서버 원본(계정 귀속) → 개인화 + 기기 무관 유지. 계정당 1행 upsert(키 배열). 순수 개인 데이터·격리.
async function getWorkdeskFavorites(ownerKey) {
  const k = String(ownerKey || '').trim();
  if (!k) return [];
  const db = getPool();
  const { rows } = await db.query(
    `SELECT favorites FROM trackb_workdesk_favorites WHERE owner_key=$1 LIMIT 1`, [k]);
  const f = rows[0] && rows[0].favorites;
  return Array.isArray(f) ? f : [];
}
async function setWorkdeskFavorites(ownerKey, favorites) {
  const k = String(ownerKey || '').trim();
  if (!k) return { ok: false, error: 'no_owner' };
  // 방어: 문자열 키만·중복 제거·상한(계정당 1000개·키 300자)로 남용/오염 차단
  const seen = new Set();
  const arr = (Array.isArray(favorites) ? favorites : [])
    .filter(x => typeof x === 'string' && x.length > 0 && x.length <= 300 && !seen.has(x) && seen.add(x))
    .slice(0, 1000);
  const db = getPool();
  await db.query(
    `INSERT INTO trackb_workdesk_favorites (owner_key, favorites, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (owner_key) DO UPDATE SET favorites=EXCLUDED.favorites, updated_at=NOW()`,
    [k, JSON.stringify(arr)]);
  return { ok: true, count: arr.length };
}

// ══ 작업 "마감"(전사 공통) + 작업목록 통계 — 리뷰웹시스템[3버전] 작업보드/홈 ══════════════
//   PRD: frontend/docs/prd-workboard-worktabs.html (v1.2). migration 088.
//   ★★ 화면 분류 전용 — 시트·리뷰어 화면·검색·인덱스·주문 경로 무접촉. 쓰기 표면 = trackb_tab_finished 하나뿐.
//   ★ 마감 여부는 목록에 **주석으로만** 실린다(서버가 거르지 않는다) — 작업보드는 진행 중만 그리고
//     홈 "마감 보관함"은 같은 응답에서 마감분을 골라 그리므로, 서버가 걸러버리면 보관함이 영원히 빈다.
const _FIN_KEY = (sheetId, tabName) => `${sheetId}\t${tabName}`;

/** 활성 마감 → `{ ok, map }`. map 키는 `sheetId\ttabName`, gid 가 있으면 `sheetId\tgid:<gid>` 도 함께 싣는다.
 *  ★★ **성공/실패를 반드시 구분해 돌려준다**(빈 맵만 주면 안 된다): 조회가 실패했을 때 호출부가 그것을
 *    "아무것도 마감 안 됨"으로 읽으면 **마감된 작업 전부가 작업보드로 되살아나고 보관함이 비는데 화면엔
 *    아무 신호가 없다**(코드리뷰 지적). 프론트는 ok:false 면 기존 마감 주석을 덮지 않고 고지만 한다.
 *  ★ **gid 폴백**: 운영 중 탭 리네임이 실재하므로(sync-tab-names·fix-swap) 이름만으로 매칭하면 마감이
 *    조용히 풀린다. 레포 규율 = "gid 우선 재매칭". 빈 gid 는 키를 만들지 않는다(전부 매칭되는 사고 방지). */
const _FIN_GKEY = (sheetId, tabGid) => `${sheetId}\tgid:${tabGid}`;
async function finishedTabsMap() {
  try {
    const { rows } = await getPool().query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName", tab_gid AS "tabGid",
              finished_at AS "finishedAt", finished_by AS "finishedBy"
         FROM trackb_tab_finished WHERE deleted_at IS NULL`);
    const map = {};
    for (const r of rows) {
      const v = { finishedAt: r.finishedAt, finishedBy: r.finishedBy || '' };
      map[_FIN_KEY(r.sheetId, r.tabName)] = v;
      const g = String(r.tabGid == null ? '' : r.tabGid).trim();
      if (g) map[_FIN_GKEY(r.sheetId, g)] = v;
    }
    return { ok: true, map };
  } catch (err) {
    logger.warn(`[trackB] finishedTabsMap 실패(마감 주석 없이 계속 — 호출부가 고지한다): ${err.message}`);
    return { ok: false, map: {} };
  }
}

/** 마감/복귀. finish=true 는 **검수 확인(inspected)** 없이는 거부한다(사용자 확정 ㉠ — 서버가 최종 방어).
 *  멱등: 이미 마감된 탭 재마감·마감 아닌 탭 복귀 모두 no-op 성공. 활성 1건은 부분 유니크가 보장. */
async function setTabFinished({ sheetId, tabName, tabGid = null, finish = true, inspected = false, by = '' } = {}) {
  const s = String(sheetId || '').trim(), t = String(tabName || '').trim();
  if (!s || !t) return { ok: false, error: 'sheetId, tabName 필수' };
  const who = String(by || '').slice(0, 100);
  const db = getPool();
  try {
    if (finish) {
      // ★ 프론트 체크만 믿지 않는다 — 확인창을 우회한 요청은 여기서 막힌다(필수열람 게이트와 같은 규율).
      if (!inspected) return { ok: false, error: '리뷰폴더 마감자료 검수 확인이 필요합니다.', code: 'inspect_required' };
      const { rows } = await db.query(
        `INSERT INTO trackb_tab_finished (sheet_id, tab_name, tab_gid, finished_by, inspect_confirmed_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (sheet_id, tab_name) WHERE deleted_at IS NULL DO NOTHING
         RETURNING id, finished_at AS "finishedAt"`,
        [s, t, tabGid == null ? null : String(tabGid), who]);
      logger.info(`[trackB] 작업 마감: ${s}/${t} by ${who}${rows.length ? '' : ' (이미 마감 — no-op)'}`);
      return { ok: true, finished: true, created: rows.length > 0, finishedAt: rows[0] ? rows[0].finishedAt : null };
    }
    const { rowCount } = await db.query(
      `UPDATE trackb_tab_finished SET deleted_at=NOW(), reopened_by=$3
        WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL`, [s, t, who]);
    logger.info(`[trackB] 작업 진행중 복귀: ${s}/${t} by ${who}${rowCount ? '' : ' (마감 상태 아님 — no-op)'}`);
    return { ok: true, finished: false, reopened: rowCount };
  } catch (err) {
    // ★ 신규 테이블이라 REQUIRED_SCHEMA 프리플라이트(컬럼만 검사)가 못 잡는다. 그대로 next(err) 로 올리면
    //   /api/trackb/* 는 isAdminApi 목록 밖이라 프로덕션에서 "서버 오류가 발생했습니다."로 마스킹된 200 이
    //   나가 관리자가 원인을 알 길이 없다 → 여기서 진단 가능한 문구로 바꾼다(읽기는 fail-soft라 화면은
    //   정상으로 보이므로 이 경로가 유일한 신호다).
    if (err && err.code === '42P01') {
      logger.error(`[trackB] trackb_tab_finished 테이블 없음(migration 088 미적용): ${err.message}`);
      return { ok: false, code: 'not_ready', error: '마감 기능이 아직 준비되지 않았습니다(migration 088 미적용) — 관리자에게 알려주세요.' };
    }
    throw err;
  }
}

/** 작업목록 표의 재료(담당자·캠페인명·인원/제출/입금) 맵 — 홈 작업 목록 전용(`?stats=1`).
 *  ★ 관리자 대시보드(/api/tab/dashboard)를 프록시하지 않는다: 그 응답은 **스코프가 없어** staff 에게
 *    담당 밖 데이터가 새고, 폐기 예정 표면에 새 의존이 생긴다. 여기서 읽고 스코프는 호출부가 건다.
 *  ★ 읽기 전용 + fail-soft. **성공 여부를 함께 돌려준다**(빈 맵과 조회 실패를 화면이 구분해야 한다).
 *  ★★ 이 맵은 **전 탭 무스코프**다 — 절대 응답에 통째로 실지 말 것(누가 `res.json({..., stats})` 를
 *    추가하는 순간 전 업체 담당자·캠페인명이 staff 에게 샌다). 스코프는 호출부가 tabs 루프로 건다.
 *  30초 프로세스 캐시로 홈 왕복을 상각. */
let _tabStatsCache = { at: 0, map: null };
const _TAB_STATS_TTL_MS = 30 * 1000;
async function tabStatsMap({ force = false } = {}) {
  if (!force && _tabStatsCache.map && (Date.now() - _tabStatsCache.at) < _TAB_STATS_TTL_MS) return { ok: true, map: _tabStatsCache.map };
  try {
    const { rows } = await getPool().query(
      `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
              tc.manager, tc.campaign_name AS "campaignName", tc.display_name AS "displayName",
              tc.folder_url AS "folderUrl", tc.capture_folder_url AS "captureFolderUrl", tc.income_type AS "incomeType",
              tc.capture_slots AS "captureSlots",
              /* 무시트 작업표의 빈 슬롯은 review_index 에 들어가지 않는다(이름 없는 행은 검색 대상이 아님).
                 홈의 작업 인원은 검색 명단이 아니라 실제 작업표 원장으로 보여야 하므로, 무시트 탭만
                 campaign_participants 활성 행을 쓴다. 시트 탭은 기존 index_master 집계를 그대로 유지한다. */
              CASE WHEN COALESCE(tc.sheetless, FALSE) THEN COALESCE(cp.total_count, 0) ELSE im.row_count END AS "rowCount",
              CASE WHEN COALESCE(tc.sheetless, FALSE) THEN COALESCE(cp.submitted_count, 0) ELSE im.submitted_count END AS "submittedCount",
              COALESCE(paid.paid_count, 0)::int AS "paidCount",
              co.closed_date AS "closeoutDate", co.row_count AS "closeoutRows"
         FROM tab_configs tc
         LEFT JOIN index_master im ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE active AND deleted_at IS NULL)::int AS total_count,
                  COUNT(*) FILTER (WHERE active AND deleted_at IS NULL AND is_submitted)::int AS submitted_count
             FROM campaign_participants cp
            WHERE cp.sheet_id = tc.sheet_id AND cp.tab_name = tc.tab_name
         ) cp ON TRUE
         -- ★ WHERE 로 걸러 집계 대상을 줄인다(FILTER 만 쓰면 review_index 전 행을 훑는다). 결과는 동일 —
         --   입금 0건 탭은 조인이 안 붙고 아래 COALESCE 가 0 으로 받는다. 이 쿼리는 관리자 화면 하나가
         --   아니라 **모든 내부 사용자의 홈 진입 경로**에 붙으므로 비용 차이가 그대로 체감된다.
         LEFT JOIN (SELECT sheet_id, tab_name, COUNT(*) AS paid_count
                      FROM review_index WHERE is_submitted2 = 'PAID' GROUP BY sheet_id, tab_name) paid
           ON paid.sheet_id = tc.sheet_id AND paid.tab_name = tc.tab_name
         -- 마감 확인창의 "마감자료 생성됨/미생성" 표시 재료(기존 정산 원장 재사용 — 신규 엔드포인트 0).
         --   ★ LATERAL LIMIT 1 = 행 곱증식 없음(레포 관용구). 미생성이면 NULL → 화면이 경고만 띄운다(하드블록 아님).
         LEFT JOIN LATERAL (SELECT c.closed_date, c.row_count FROM trackb_tab_closeouts c
                             WHERE c.sheet_id = tc.sheet_id AND c.tab_name = tc.tab_name AND c.deleted_at IS NULL
                             ORDER BY c.created_at DESC LIMIT 1) co ON TRUE`);
    const map = {};
    for (const r of rows) {
      map[_FIN_KEY(r.sheetId, r.tabName)] = {
        manager: r.manager || '', campaignName: r.campaignName || '', displayName: r.displayName || '',
        total: Number.isFinite(+r.rowCount) ? +r.rowCount : null,
        submitted: Number.isFinite(+r.submittedCount) ? +r.submittedCount : null,
        paid: +r.paidCount || 0,
        // 홈 [저장폴더] 버튼 재료 — tab_configs 를 이미 읽는 이 쿼리에 얹어 쿼리 순증 0.
        //   ★ 현영 여부는 captureSlots.hasCashReceiptSlot 단일 규칙 — /tab-folders 가 폴더를 해석할 때
        //     쓰는 것과 **같은 함수**다(income_type '현영' + 관리자 명시 receipt 슬롯). 종전에는 여기만
        //     income_type 만 봐서, 수동 슬롯 탭은 "버튼은 비활성인데 서버는 허용"으로 갈라져 있었다.
        folderUrl: r.folderUrl || null, captureFolderUrl: r.captureFolderUrl || null,
        cashReceipt: hasCashReceiptSlot(r.captureSlots, r.incomeType),
        // 오설정(현영인데 슬롯에 현금영수증 칸 없음)일 때만 실린다 — '대상 아님'으로 뭉개지 않게.
        ...(cashReceiptNote(r.captureSlots, r.incomeType) ? { cashReceiptNote: cashReceiptNote(r.captureSlots, r.incomeType) } : {}),
        closeoutDate: r.closeoutDate || null, closeoutRows: r.closeoutRows == null ? null : +r.closeoutRows,
      };
    }
    _tabStatsCache = { at: Date.now(), map };
    return { ok: true, map };
  } catch (err) {
    logger.warn(`[trackB] tabStatsMap 실패(통계 없이 계속 — 호출부가 고지한다): ${err.message}`);
    return { ok: false, map: {} };
  }
}

/** 작업 ↔ 연결된 모집공고 주석 맵 — 홈 작업 목록의 [공고] 버튼 재료(`?stats=1` 전용).
 *
 *  ★★ **상태 판정은 카드·리뷰어 목록과 같은 계산을 쓴다**(`computeCampaignState` + 같은 재료).
 *    여기서 status 컬럼만 보고 "모집중"을 흉내 내면 **목록엔 모집중인데 참여는 거부**되는
 *    화면 간 불일치가 그대로 생긴다(레포가 반복해서 밟은 함정). 그래서 `/campaign/admin/list`
 *    핸들러와 **같은 3종 재료**(counts · 시트 일정 · now)를 그대로 모아 넘긴다.
 *  ★ 키는 마감 주석과 같은 규칙 — **이름 + gid 폴백**(운영 중 탭 리네임으로 공고 연결이 조용히
 *    풀리면 담당자가 "공고 없음"으로 읽고 **이미 있는 공고를 또 발행**한다).
 *  ★ 한 작업에 공고가 여럿일 수 있다(차수 재발행 등) → **배열**로 돌려주고 화면이 고르게 한다
 *    (사용자 확정: 생성일과 함께 보여주고 선택). 정렬은 최신 생성 순.
 *  ★★ 이 맵도 **전 탭 무스코프**다 — 응답에 통째로 싣지 말 것(호출부 tabs 루프가 유일한 스코프).
 *  ★ 읽기 전용 · fail-soft · `{ok, map}`(빈 맵과 조회 실패를 화면이 구분해야 한다 — 088 규율).
 *  30초 프로세스 캐시(홈 진입 왕복 상각, tabStatsMap 과 같은 값). */
let _tabCampCache = { at: 0, map: null };
const _TAB_CAMP_TTL_MS = 30 * 1000;
async function tabCampaignsMap({ force = false } = {}) {
  if (!force && _tabCampCache.map && (Date.now() - _tabCampCache.at) < _TAB_CAMP_TTL_MS) {
    return { ok: true, map: _tabCampCache.map };
  }
  try {
    const db = getPool();
    const now = new Date();
    // 연결 탭이 있는 공고만(전 공고를 훑지 않는다). 상태 계산에 여러 컬럼이 필요해 행 전체를 받는다.
    const { rows } = await db.query(
      `SELECT * FROM recruit_campaigns
        WHERE COALESCE(linked_sheet_id, '') <> '' AND COALESCE(linked_tab_name, '') <> ''
        ORDER BY created_at DESC`);
    const map = {};
    if (!rows.length) { _tabCampCache = { at: Date.now(), map }; return { ok: true, map }; }

    const { computeCampaignState, fetchCampaignCounts } = require('./campaignState.service');
    // ★★ 일정 대상 목록도 **공유 헬퍼**(tabsOfCampaigns)로 뽑는다 — 손으로 map 하면
    //   그쪽의 필터(참여형 + gid 보유)와 갈라져 카드와 다른 일정이 적용된다(사본 금지).
    const { deriveSchedules, scheduleFor, tabsOfCampaigns } = require('./campaignSchedule.service');
    const partIds = rows.filter(r => r.participation_mode).map(r => r.id);
    // ★ 상태 재료 조회 실패는 **주석 전체를 죽이지 않는다** — 공고 목록·생성일은 그대로 쓰고
    //   상태만 비운다(화면이 회색 점으로 그린다). admin/list 와 같은 판단.
    let countsMap = new Map(), schedMap = null;
    try {
      [countsMap, schedMap] = await Promise.all([
        fetchCampaignCounts(db, partIds, now),
        deriveSchedules(db, tabsOfCampaigns(rows), now),
      ]);
    } catch (e) {
      logger.warn(`[trackB] tabCampaignsMap 상태 재료 실패(공고 목록만 표시): ${e.message}`);
    }
    for (const r of rows) {
      let state = null, stateReason = null;
      try {
        const st = computeCampaignState(
          r, countsMap.get(r.id) || { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 },
          now, schedMap ? scheduleFor(schedMap, r) : null);
        state = st.state; stateReason = st.stateReason || null;
      } catch (_) { /* 판정 실패 = 상태 없음(공고 자체는 계속 보인다) */ }
      const item = {
        id: r.id, title: r.title || '', createdAt: r.created_at || null,
        status: r.status || '', participationMode: !!r.participation_mode,
        state, stateReason,
      };
      const push = (k) => { (map[k] || (map[k] = [])).push(item); };
      push(_FIN_KEY(r.linked_sheet_id, r.linked_tab_name));
      // gid 폴백 — **빈 gid 는 키를 만들지 않는다**(만들면 gid 없는 탭이 전부 한 키로 뭉친다).
      const g = String(r.linked_tab_gid == null ? '' : r.linked_tab_gid).trim();
      if (g) push(`${r.linked_sheet_id}\tgid:${g}`);
    }
    _tabCampCache = { at: Date.now(), map };
    return { ok: true, map };
  } catch (err) {
    logger.warn(`[trackB] tabCampaignsMap 실패(공고 주석 없이 계속 — 호출부가 고지한다): ${err.message}`);
    return { ok: false, map: {} };
  }
}

/** 오늘 참여현황 — 작업보드 표 툴바의 `8/10 (월) 참여현황 12/20명` 재료.
 *  시안 = frontend/docs/design-grid-today-progress.html (C안 도넛 + B안 파란 날짜).
 *
 *  ★★ **판정 사본 0** — 오늘 정원은 `computeCampaignState` 가 정한 값(`dailyQuota`)을 그대로 쓴다.
 *    여기서 "일건수 + 이월" 같은 식을 다시 세우면 066 이월 상한·095 날짜별 조절·098 이월 보류·
 *    총량 clamp 를 모르는 두 번째 기준이 생겨 **툴바는 20명인데 카드·[📅 인원] 은 25명**으로 갈린다
 *    (레포가 반복해서 밟은 함정 — `todayNaturalQuota` 를 서버가 실어 보내는 것과 같은 이유).
 *  ★ 재료 3종(counts · 시트 일정 · now)도 `tabCampaignsMap`/`/campaign/admin/list` 와 같은 것을 모은다.
 *  ★★ 분자 = **오늘 제출 확정(`todaySubmitted`)** — 진행 중(결제 중 홀드)은 `holds` 로 따로 싣는다.
 *    확정+홀드를 한 숫자로 합치면 홀드 만료 때 **숫자가 줄어들어** "12명이었는데 10명이 됐다"가 된다.
 *  ★ 키는 마감·공고 주석과 같은 규칙 — **이름 + gid 폴백**(리네임으로 연결이 조용히 풀리면
 *    멀쩡한 공고를 두고 "모집 기준 없음"이 뜬다). ★★ 그 gid 는 **서버가 `tab_configs` 에서 다시 구한다**
 *    — 클라이언트가 보낸 gid 를 믿으면 낡은 화면이 **같은 시트 다른 탭의 공고 정원**을 이 표에 띄운다
 *    (스코프 판정이 tabGid 를 안 믿는 것과 같은 규율).
 *  ★ 살아있는 공고가 여럿이면(차수 재발행 등) **합산하고 그 사실을 `campaignCount` 로 말한다**
 *    — 하나만 골라 쓰면 나머지 공고 물량이 조용히 빠진다.
 *  ★ 연결 공고 0개 = `reason:'no_campaign'`(정원을 정할 수 없음) — **0/0 으로 꾸미지 않는다**.
 *  ★ 읽기 전용 · 시트 무접촉 · 어떤 실패도 throw 하지 않는다(작업보드 로딩을 죽이지 않는다).
 *  @returns {{ok:boolean, dateStr:string, quota:number|null, done:number, holds:number,
 *             campaignCount:number, state:string|null, stateReason:string|null, reason:string|null}} */
/** 업체(광고주) 렌즈 — `tabTodayProgress` 결과에서 **내부 운영 수치를 폐기**하고 표시용만 남긴다.
 *  ★★ 화이트리스트 재구성(스프레드 금지) — `{...tp}` 로 두면 나중에 필드가 늘 때 조용히 새 나간다.
 *  ★ `done` 은 화면이 폴백에 쓰는 값이라 **형태는 유지하되 표 기준과 같은 값**으로 둔다 →
 *    "공고를 거쳐 확정된 건 N명 · 차이 M명" 같은 **내부 문구가 애초에 만들어지지 않는다**.
 *  ★ `holds`(결제 중) · `campaignCount`(합산 공고 수)는 0/1 로 눕힌다(운영 정보). */
function _tpAdvertiserLens(tp) {
  if (!tp || typeof tp !== 'object') return tp;
  const filled = (tp.sheetFilled == null) ? null : (Number(tp.sheetFilled) || 0);
  return {
    ok: tp.ok, dateStr: tp.dateStr, quota: tp.quota,
    sheetFilled: filled,
    done: filled == null ? (Number(tp.done) || 0) : filled,
    holds: 0, campaignCount: 1,
    state: tp.state, stateReason: tp.stateReason, reason: tp.reason,
  };
}

async function tabTodayProgress(db, { sheetId, tabName } = {}) {
  const now = new Date();
  const { computeCampaignState, fetchCampaignCounts, kstTodayStr } = require('./campaignState.service');
  const dateStr = kstTodayStr(now);
  const base = { ok: true, dateStr, quota: null, done: 0, holds: 0, sheetFilled: null, campaignCount: 0, state: null, stateReason: null, reason: null };
  try {
    const { rows: tc } = await db.query(
      `SELECT COALESCE(tab_gid, '') AS gid FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`,
      [sheetId, tabName]);
    const gid = String((tc[0] && tc[0].gid) || '').trim();
    // ★ 표 기준 참여현황(사용자 확정 B안)은 **공고 유무와 무관하게** 셀 수 있다 —
    //   공고를 못 찾는 경우(no_campaign)에도 "오늘 표에 몇 줄 찼는가"는 사실이므로 먼저 구한다.
    //   카드와 **같은 함수**를 쓴다(사본을 두면 또 갈린다).
    const { todayFilledForTab } = require('./tabFilled.service');
    base.sheetFilled = await todayFilledForTab(db, sheetId, tabName, now);
    const { rows } = await db.query(
      `SELECT * FROM recruit_campaigns
        WHERE linked_sheet_id = $1
          AND (linked_tab_name = $2 OR ($3 <> '' AND COALESCE(linked_tab_gid, '') = $3))
        ORDER BY created_at DESC`, [sheetId, tabName, gid]);
    // 참여형 + 게시(active) 공고만 = 오늘 사람을 받는 공고. 레거시(카톡 신청)는 정원 개념이 없다.
    const live = rows.filter(r => r.participation_mode && r.status === 'active');
    if (!live.length) return { ...base, reason: rows.length ? 'no_live_campaign' : 'no_campaign' };

    const { deriveSchedules, scheduleFor, tabsOfCampaigns } = require('./campaignSchedule.service');
    const [countsMap, schedMap] = await Promise.all([
      fetchCampaignCounts(db, live.map(r => r.id), now),
      deriveSchedules(db, tabsOfCampaigns(live), now).catch(() => null),
    ]);

    let quota = 0, done = 0, holds = 0, state = null, stateReason = null;
    for (const r of live) {
      const counts = countsMap.get(r.id) || { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 };
      const st = computeCampaignState(r, counts, now, schedMap ? scheduleFor(schedMap, r) : null);
      quota += Number(st.dailyQuota) || 0;
      done += Number(counts.todaySubmitted) || 0;
      holds += Number(counts.todayActiveHolds) || 0;
      // 여럿이면 "가장 열려 있는" 상태를 대표로 — 하나라도 열려 있으면 아직 받는 중이다.
      if (state === null || (state !== 'open' && st.state === 'open')) { state = st.state; stateReason = st.stateReason || null; }
    }
    // ★ `done`(공고를 거쳐 오늘 확정된 수)의 의미는 **그대로 둔다** — 화면은 `sheetFilled` 를
    //   우선 표시하되 툴팁에서 둘의 차이를 말한다(지각 미확정·수기 입력이 조용히 숨지 않게).
    return { ...base, quota, done, holds, campaignCount: live.length, state, stateReason };
  } catch (err) {
    // fail-soft: "모른다"로 돌려주고 화면이 그렇게 말한다(0/0 으로 위장하면 "오늘 할 일 없음"으로 읽힌다).
    logger.warn(`[trackB] tabTodayProgress 실패(참여현황 표기 없이 계속): ${err.message}`);
    return { ...base, ok: false };
  }
}

// ══ M2: 열린 작업 줄(개인별) + 오늘 완료(전사 공통) — migration 089 ═══════════════════════
//   PRD: frontend/docs/prd-workboard-worktabs.html §1(두 상태 비교). 마감(088)과 **다른 것**이다.

/** 열린 작업 줄 — 계정당 1행, **순서 있는 배열**(드래그로 정한 탭 배치가 곧 이 순서다).
 *  ★ 즐겨찾기(`setWorkdeskFavorites`)와 달리 Set 으로 접지 않는다 — 접는 순간 순서가 사라진다. */
const WORKTAB_CAP = 12;                     // 사용자 확정 ㉤ — 넘으면 화면이 안내(자동으로 닫지 않는다)
// ★★ **성공/실패를 구분해 돌려준다**(빈 배열만 주면 안 된다): 조회 실패를 "저장된 줄이 없음"으로 읽으면
//   프론트가 그것을 서버 원본으로 신뢰해 로컬 캐시까지 덮고, 다음 탭 하나를 여는 순간 **서버 행이
//   1건짜리로 영구 대체**된다(되돌릴 수단 없음 — 코드리뷰 blocker). finishedTabsMap 과 같은 계약.
async function getWorkdeskWorktabs(ownerKey) {
  const k = String(ownerKey || '').trim();
  if (!k) return { ok: true, tabs: [] };
  try {
    const { rows } = await getPool().query(
      `SELECT tabs FROM trackb_workdesk_worktabs WHERE owner_key=$1 LIMIT 1`, [k]);
    const v = rows[0] && rows[0].tabs;
    return { ok: true, tabs: Array.isArray(v) ? v.filter(x => typeof x === 'string') : [] };
  } catch (err) {
    logger.warn(`[trackB] getWorkdeskWorktabs 실패(호출부가 로컬을 유지하고 고지한다): ${err.message}`);
    return { ok: false, tabs: [] };
  }
}
async function setWorkdeskWorktabs(ownerKey, tabs) {
  const k = String(ownerKey || '').trim();
  if (!k) return { ok: false, error: 'no_owner' };
  // 중복 제거(첫 등장 순서 유지) + 키 길이·개수 상한. ★ slice 로 자를 뿐 저장을 거부하지 않는다 —
  //   상한 초과는 "안내하고 사용자가 정리"가 정책이라 서버가 요청을 튕기면 화면이 멈춘다.
  const seen = new Set();
  const clean = (Array.isArray(tabs) ? tabs : [])
    .filter(x => typeof x === 'string' && x.length > 0 && x.length <= 300 && !seen.has(x) && seen.add(x));
  // ★ 상한 초과는 **뒤에서 자른다**(가장 오래 안 본 앞쪽을 남기면 방금 연 탭이 저장되지 않아
  //   "새로고침하니 마지막에 연 것만 사라지는" 이해 불가한 동작이 된다 — 화면도 12개에서 열기를 막는다).
  const arr = clean.slice(0, WORKTAB_CAP);
  try {
    await getPool().query(
      `INSERT INTO trackb_workdesk_worktabs (owner_key, tabs, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (owner_key) DO UPDATE SET tabs=EXCLUDED.tabs, updated_at=NOW()`,
      [k, JSON.stringify(arr)]);
  } catch (err) {
    // ★ 마감·오늘 완료와 같은 규율 — 그냥 throw 하면 프론트의 catch 가 삼켜 **아무 신호 없이** 저장이
    //   안 되고, 사용자는 다음 부팅에 줄이 사라진 것을 보고서야 안다(원인 추적 불가).
    if (err && err.code === '42P01') {
      logger.error(`[trackB] trackb_workdesk_worktabs 테이블 없음(migration 089 미적용): ${err.message}`);
      return { ok: false, code: 'not_ready', error: '열린 작업 줄 저장이 아직 준비되지 않았습니다(migration 089 미적용).' };
    }
    throw err;
  }
  return { ok: true, count: arr.length, cap: WORKTAB_CAP, dropped: clean.length - arr.length };
}

/** 오늘(KST) 완료된 탭 → `{ ok, map }`. 키는 `sheetId\ttabName`.
 *  ★★ 날짜 비교만으로 판정하므로 **자정 리셋 크론이 없다** — 날짜가 바뀌면 어제 행이 저절로 빠진다.
 *  ★ KST 파생은 `campaignState.kstTodayStr` 재사용(사본 금지 — 날짜 규칙이 두 벌이 되면 갈린다). */
async function dailyDoneMap() {
  const today = require('./campaignState.service').kstTodayStr();
  try {
    const { rows } = await getPool().query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName", done_by AS "doneBy"
         FROM trackb_tab_daily_done WHERE done_date = $1::date`, [today]);
    const map = {};
    for (const r of rows) map[_FIN_KEY(r.sheetId, r.tabName)] = { doneBy: r.doneBy || '' };
    return { ok: true, map, date: today };
  } catch (err) {
    logger.warn(`[trackB] dailyDoneMap 실패(오늘 완료 표시 없이 계속 — 호출부가 고지한다): ${err.message}`);
    return { ok: false, map: {}, date: today };
  }
}

/** 오늘 완료 토글(전사 공통). 확인창 없는 가벼운 동작이라 검수 게이트 없음(마감과 다르다). */
async function setTabDailyDone({ sheetId, tabName, done = true, by = '' } = {}) {
  const s = String(sheetId || '').trim(), t = String(tabName || '').trim();
  if (!s || !t) return { ok: false, error: 'sheetId, tabName 필수' };
  const who = String(by || '').slice(0, 100);
  const today = require('./campaignState.service').kstTodayStr();
  try {
    if (done) {
      const { rows } = await getPool().query(
        `INSERT INTO trackb_tab_daily_done (sheet_id, tab_name, done_date, done_by)
         VALUES ($1,$2,$3::date,$4)
         ON CONFLICT (sheet_id, tab_name, done_date) DO NOTHING RETURNING id`, [s, t, today, who]);
      return { ok: true, done: true, created: rows.length > 0, date: today };
    }
    // 해제는 **오늘 행만** 지운다 — 어제 이력을 지우면 "언제 처리했나"가 사라진다.
    const { rowCount } = await getPool().query(
      `DELETE FROM trackb_tab_daily_done WHERE sheet_id=$1 AND tab_name=$2 AND done_date=$3::date`, [s, t, today]);
    return { ok: true, done: false, cleared: rowCount, date: today };
  } catch (err) {
    if (err && err.code === '42P01') {
      logger.error(`[trackB] trackb_tab_daily_done 테이블 없음(migration 089 미적용): ${err.message}`);
      return { ok: false, code: 'not_ready', error: '오늘 완료 기능이 아직 준비되지 않았습니다(migration 089 미적용) — 관리자에게 알려주세요.' };
    }
    throw err;
  }
}

// ══ /M2 ═══════════════════════════════════════════════════════════════════════════
//   ★ 이 줄 위까지가 M2(열린 작업 줄·오늘 완료) 구역이다. 회귀가드가 "M2 의 쓰기 표면은 신규 2테이블뿐"
//     을 이 마커로 잘라 검사하므로, 아래에 다른 기능을 붙여도 그 검사가 오염되지 않는다.
//     (2026-08-18 에 아래 함수가 들어오면서 마커가 없어 가드가 빨갛게 남아 있었다.)

// 번호가 비어 있는 주문행은 슬롯을 하나 더 만든 것이 아니라, 주문이 빈 슬롯에
// 연결되지 못한 채 별도 행으로 투영된 상태다. 기존 주문/리뷰/입금 상태는 보존하면서
// 목표 인원 안의 비어 있는 슬롯으로만 옮긴다.
function _displayNumber(rowJson) {
  const row = rowJson && typeof rowJson === 'object' ? rowJson : {};
  const key = Object.keys(row).find(k => /^(번호|no|#)$/i.test(String(k).trim()));
  return key ? String(row[key] == null ? '' : row[key]).trim() : '';
}

function _mergeUnslottedOrderRow(slotRowJson, orderRowJson, slotSeq) {
  const slot = slotRowJson && typeof slotRowJson === 'object' ? { ...slotRowJson } : {};
  const order = orderRowJson && typeof orderRowJson === 'object' ? orderRowJson : {};
  for (const [key, value] of Object.entries(order)) {
    if (value != null && String(value).trim() !== '') slot[key] = value;
  }
  const numberKey = Object.keys(slot).find(k => /^(번호|no|#)$/i.test(String(k).trim())) || '번호';
  slot[numberKey] = String(slotSeq);
  return slot;
}

/**
 * 번호 없는 주문행 1건을 작업오더 목표 인원 안의 빈 슬롯으로 옮긴다.
 * 이미 주문/신원/리뷰/입금이 붙은 행은 후보에서 제외하고, 동시 실행 시에도 FOR UPDATE
 * 잠금으로 같은 슬롯을 두 번 쓰지 않는다.
 */
async function assignUnslottedOrderToOpenSlot({ sheetId, tabName, rowId, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId) throw new Error('assignUnslottedOrderToOpenSlot: sheetId, tabName, rowId 필수');
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: sourceRows } = await client.query(
      `SELECT * FROM campaign_participants
        WHERE id=$3 AND sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
        FOR UPDATE`, [sheetId, tabName, rowId]);
    const source = sourceRows[0];
    if (!source) { await client.query('ROLLBACK'); return { ok: false, error: 'source_not_found' }; }
    if (!source.order_submission_id) { await client.query('ROLLBACK'); return { ok: false, error: 'not_an_order_row' }; }
    if (_displayNumber(source.row_json)) { await client.query('ROLLBACK'); return { ok: false, error: 'already_numbered' }; }

    const effectiveId = await _effectiveLinkedWorkOrderId(client, sheetId, tabName);
    const { rows: workOrders } = await client.query(
      `SELECT recruit_count FROM work_orders
        WHERE deleted_at IS NULL AND ($3::text IS NOT NULL AND id=$3 OR (linked_tab_sheet_id=$1 AND linked_tab_name=$2))
        ORDER BY ($3::text IS NOT NULL AND id=$3) DESC, created_at DESC LIMIT 1`, [sheetId, tabName, effectiveId]);
    const target = Number(workOrders[0] && workOrders[0].recruit_count) || 0;
    if (target < 1) { await client.query('ROLLBACK'); return { ok: false, error: 'work_order_target_missing' }; }

    const { rows: slots } = await client.query(
      `SELECT * FROM campaign_participants
        WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
          AND seq BETWEEN 1 AND $3 AND order_submission_id IS NULL
          AND NULLIF(btrim(COALESCE(reviewer_name,'')), '') IS NULL
          AND NULLIF(btrim(COALESCE(recipient_name,'')), '') IS NULL
          AND NULLIF(btrim(COALESCE(phone8,'')), '') IS NULL
        ORDER BY seq
        FOR UPDATE SKIP LOCKED
        LIMIT 1`, [sheetId, tabName, target]);
    const slot = slots[0];
    if (!slot) { await client.query('ROLLBACK'); return { ok: false, error: 'no_open_slot', target }; }

    const merged = _mergeUnslottedOrderRow(slot.row_json, source.row_json, slot.seq);
    await client.query(
      `UPDATE campaign_participants
          SET reviewer_name=$2, recipient_name=$3, phone8=$4, round=$5, option_text=$6,
              product_name=$7, product_url=$8, start_date=$9, end_date=$10,
              is_submitted=$11, submitted_at=$12, is_paid=$13, paid_at=$14,
              source=$15, sheet_row=COALESCE(sheet_row,$16), last_sheet_write_sig=$17,
              identity_key=$18, order_submission_id=$19, row_json=$20::jsonb,
              updated_by=$21, updated_at=NOW()
        WHERE id=$1`, [slot.id, source.reviewer_name, source.recipient_name, source.phone8, source.round,
        source.option_text, source.product_name, source.product_url, source.start_date, source.end_date,
        source.is_submitted, source.submitted_at, source.is_paid, source.paid_at, source.source,
        slot.seq, source.last_sheet_write_sig, source.identity_key, source.order_submission_id,
        JSON.stringify(merged), String(by).slice(0, 100)]);
    await client.query(
      `UPDATE campaign_participants SET deleted_at=NOW(), active=FALSE, updated_by=$2, updated_at=NOW()
        WHERE id=$1`, [source.id, String(by).slice(0, 100)]);
    await client.query(
      `UPDATE order_submissions SET sheet_row=COALESCE(sheet_row,$2), updated_at=NOW()
        WHERE id=$1::uuid AND deleted_at IS NULL`, [source.order_submission_id, slot.seq]);
    await client.query('COMMIT');
    return { ok: true, sourceRowId: source.id, slotRowId: slot.id, slotSeq: slot.seq, target };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

/* ── ⚠중복(앵커 겹침) 진단 — 읽기 전용 ────────────────────────────────────────
   왜 필요한가: 그리드 상단 `중복 줄 N` 배지(= 앵커가 겹쳐 **수정 오버레이를 적용하지 못한** 줄)와
   ♻ 중복 줄 정리(`sheetlessLedger.dedupeRows`)는 **보는 집합도 판정 키도 다르다**.
     · 배지  = 앵커(order_submission_id → identity_key) 겹침. **주문 링크 없는 줄도 포함**.
     · 정리  = `JOIN order_submissions`(링크된 줄만) + 표 주문번호·원장 주문번호·연락처 3개 일치.
   그래서 "중복 줄 116 · 정리 대상 0" 이 정상적으로 나올 수 있다(2026-08-19 장수산업 실측).
   담당자에게 그 116줄의 실체를 볼 창구가 없으면 원인을 엉뚱한 데서 찾는다.
   ★★ 판정 사본 0 — 겹침은 그리드가 쓰는 `_deriveAnchor` 로 **그대로** 다시 세고,
      "정리 도구가 이 그룹을 잡는가" 는 `dedupeRows({dryRun:true})` 를 **실제로 불러** 대조한다.
      여기서 조건을 다시 쓰면 "진단은 잡힌다는데 정리하면 0" 이 된다.
   ★ 쓰기 쿼리 0 · 시트/Drive 무접촉 · dedupe 대조 실패는 fail-soft(사유만 적는다).
   ★ `dedupeFn` 은 테스트 주입용(모듈 내부 호출은 렉시컬이라 export 교체가 안 먹는다 —
      `cutoverAll` 의 `overviewFn`/`flipFn`, `scanDuplicateRows` 의 `dedupeFn` 과 같은 선례). */
const _AMB_REASON = {
  dedupe_target:      '정리 도구가 이미 대상으로 잡는 그룹입니다 — [미리보기]에 나옵니다.',
  dedupe_skipped:     '정리 도구가 보류한 그룹입니다 — 미리보기의 보류 사유를 보세요.',
  no_order_link:      '주문 기록에 연결되지 않은 줄이 섞여 있습니다 — 정리 도구는 연결된 줄만 보므로 이 그룹은 조회 대상 밖입니다.',
  order_deleted:      '연결된 주문이 취소(삭제)된 줄이 섞여 있습니다 — 정리 도구는 살아 있는 주문만 보므로 이 그룹은 조회 대상 밖입니다.',
  row_order_num_missing: '표에 주문번호가 없거나 6자리 미만인 줄이 있습니다 — 정리 도구가 "모르면 안 지운다"로 제외합니다.',
  row_order_num_differs: '표에 보이는 주문번호가 줄마다 다릅니다 — 정리 도구는 다른 구매로 봅니다(줄↔주문 링크가 어긋난 상태일 수 있습니다).',
  ledger_order_num_differs: '주문 기록의 주문번호가 줄마다 다릅니다 — 정리 도구는 다른 구매로 봅니다.',
  phone_differs:      '연락처가 줄마다 다릅니다 — 정리 도구는 다른 사람으로 봅니다.',
  unknown:            '정리 도구의 대상에도 보류에도 잡히지 않았습니다 — 값을 직접 확인해 주세요.',
};
async function ambiguousRowReport({ sheetId, tabName, maxGroups = 200, dedupeFn } = {}) {
  if (!sheetId || !tabName) throw new Error('ambiguousRowReport: sheetId, tabName 필수');
  const db = getPool();

  // 명단(활성) — 그리드(workdeskTab)와 **같은 조건**. 다르면 배지 숫자와 진단 숫자가 갈린다.
  const { rows: roster } = await db.query(
    `SELECT id, seq, reviewer_name AS name, recipient_name AS recipient, phone8,
            option_text AS option, source, order_submission_id, identity_key, row_json,
            COALESCE(is_submitted, FALSE) AS submitted, COALESCE(is_paid, FALSE) AS paid
       FROM campaign_participants
      WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active = TRUE
      ORDER BY seq`, [sheetId, tabName]);

  const anchorCount = new Map();
  for (const r of roster) {
    const a = _deriveAnchor(r);
    if (!a || a.type === 'manual') continue;
    const k = _akey(a.type, a.value);
    anchorCount.set(k, (anchorCount.get(k) || 0) + 1);
  }

  // 원장(주문 기록) — 링크된 줄만. 표 주문번호와 대조할 값이다.
  const orderIds = [...new Set(roster.map(r => r.order_submission_id).filter(Boolean).map(String))];
  let ordMap = new Map();
  if (orderIds.length) {
    const { rows: ords } = await db.query(
      /* ★★ 취소(소프트삭제)된 주문도 함께 읽는다 — `dedupeRows` 는 `os.deleted_at IS NULL` 이라
         **취소된 주문에 매달린 줄을 통째로 못 본다**. 그 줄은 표에 그대로 남아 겹침을 만드는데
         진단까지 못 보면 "왜 중복인데 정리가 0인지" 를 영영 설명할 수 없다(2026-08-19 위드프렌즈). */
      `SELECT id, order_num, phone, submitted_at, deleted_at
         FROM order_submissions WHERE id = ANY($1::uuid[])`,
      [orderIds]).catch(() => ({ rows: [] }));
    ordMap = new Map(ords.map(o => [String(o.id), o]));
  }
  // 입금 회차에 담긴 줄 — 지우기 전에 반드시 확인해야 하는 사실(이체 근거).
  const payRows = new Set();
  await db.query(
    `SELECT row_index FROM payment_batch_items
      WHERE sheet_id=$1 AND tab_name=$2 AND status IN ('pending','paid')`, [sheetId, tabName])
    .then(({ rows }) => rows.forEach(r => payRows.add(Number(r.row_index))))
    .catch(() => { /* fail-soft — 아래 payUnavailable 로 고지 */ payRows.add(NaN); });
  const payUnavailable = payRows.has(NaN);

  // ★ 정리 도구 대조 — 실제로 불러서 어느 줄을 잡는지 본다(사본 0).
  let dedupePlanSeqs = null, dedupeSkipSeqs = null, dedupeError = '';
  try {
    const fn = dedupeFn || require('./sheetlessLedger.service').dedupeRows;
    const d = await fn({ sheetId, tabName, dryRun: true, by: 'ambiguous-report' });
    dedupePlanSeqs = new Set();
    for (const g of (d.plan || [])) { dedupePlanSeqs.add(Number(g.keepSeq)); (g.removeSeqs || []).forEach(s => dedupePlanSeqs.add(Number(s))); }
    dedupeSkipSeqs = new Set();
    for (const g of (d.skipped || [])) (g.seqs || []).forEach(s => dedupeSkipSeqs.add(Number(s)));
  } catch (e) {
    dedupeError = (e && (e.message || e.code)) ? String(e.message || e.code) : '대조 실패';
  }

  const _dig = v => String(v == null ? '' : v).replace(/\D/g, '');
  const groups = new Map();
  let ambiguousRows = 0;
  for (const r of roster) {
    const a = _deriveAnchor(r);
    if (!a || a.type === 'manual') continue;
    const k = _akey(a.type, a.value);
    if ((anchorCount.get(k) || 0) < 2) continue;
    ambiguousRows++;
    const os = r.order_submission_id ? ordMap.get(String(r.order_submission_id)) : null;
    if (!groups.has(k)) groups.set(k, { anchorType: a.type, anchorValue: a.value, rows: [] });
    groups.get(k).rows.push({
      seq: Number(r.seq),
      name: r.name || '',
      recipient: r.recipient || '',
      phone8: String(r.phone8 || '').slice(-8),
      hasOrder: !!r.order_submission_id,
      rowOrderNum: _dig(_ikFromRow(r).orderNum),        // 표(row_json)에 보이는 주문번호
      ledgerOrderNum: _dig(os && os.order_num),          // 주문 기록의 주문번호
      ledgerPhone: _dig(os && os.phone).slice(-8),
      orderDeleted: !!(os && os.deleted_at),
      submittedAt: (os && os.submitted_at) || null,
      submitted: !!r.submitted,
      paid: !!r.paid,
      inPayment: payUnavailable ? null : payRows.has(Number(r.seq)),
    });
  }

  const _same = (list, f) => new Set(list.map(f)).size <= 1;
  const out = [];
  for (const g of groups.values()) {
    g.rows.sort((a, b) => a.seq - b.seq);
    const seqs = g.rows.map(r => r.seq);
    let reason;
    if (dedupePlanSeqs && seqs.every(s => dedupePlanSeqs.has(s))) reason = 'dedupe_target';
    else if (dedupeSkipSeqs && seqs.every(s => dedupeSkipSeqs.has(s))) reason = 'dedupe_skipped';
    else if (g.rows.some(r => !r.hasOrder)) reason = 'no_order_link';
    /* ★ 취소된 주문은 `no_order_link` 로 뭉뚱그리지 않는다 — 조치가 다르다(줄 정리 vs 주문 복구). */
    else if (g.rows.some(r => r.orderDeleted)) reason = 'order_deleted';
    else if (g.rows.some(r => r.rowOrderNum.length < 6)) reason = 'row_order_num_missing';
    else if (!_same(g.rows, r => r.rowOrderNum)) reason = 'row_order_num_differs';
    else if (!_same(g.rows, r => r.ledgerOrderNum)) reason = 'ledger_order_num_differs';
    else if (!_same(g.rows, r => r.ledgerPhone)) reason = 'phone_differs';
    else reason = 'unknown';
    out.push({
      anchorType: g.anchorType,
      /* 앵커 종류 — 같은 주문 id 를 여러 줄이 쓰는지, 표 주문번호(num:)·수취인(rcp:)·연락처(phone8:)로
         묶인 무링크 줄인지. "왜 겹쳤나" 의 1차 단서다. */
      anchorKind: g.anchorType === 'order' ? 'order_link'
        : (String(g.anchorValue).startsWith('num:') ? 'row_order_num'
          : (String(g.anchorValue).startsWith('rcp:') ? 'recipient' : 'phone8')),
      rowCount: g.rows.length,
      seqs,
      reason,
      detail: _AMB_REASON[reason],
      inPaymentCount: payUnavailable ? null : g.rows.filter(r => r.inPayment).length,
      rows: g.rows,
    });
  }
  out.sort((a, b) => b.rowCount - a.rowCount || a.seqs[0] - b.seqs[0]);
  const byReason = {};
  for (const g of out) byReason[g.reason] = (byReason[g.reason] || 0) + 1;

  return {
    ok: true, sheetId, tabName,
    totalRows: roster.length,
    ambiguousRows,                       // ★ 그리드 배지(`중복 줄 N`)와 같은 값이어야 한다
    groupCount: out.length,
    byReason,
    payUnavailable,                      // 이체 담김 여부를 못 읽었다(0 으로 꾸미지 않는다)
    dedupeError,                         // 정리 도구 대조 실패 사유(시트 기반 탭 등)
    truncated: out.length > maxGroups,
    groups: out.slice(0, maxGroups),
  };
}

module.exports = {
  ambiguousRowReport,
  linkedToggleHeader: _linkedToggle,   // 132 — utils/sheetlessCellWrite 가 상태열 판정을 재사용(사본 금지)

  getWorkdeskFavorites,
  setWorkdeskFavorites,
  getWorkdeskWorktabs,
  setWorkdeskWorktabs,
  dailyDoneMap,
  setTabDailyDone,
  finishedTabsMap,
  setTabFinished,
  tabStatsMap,
  tabCampaignsMap,
  tabTodayProgress,
  _tpAdvertiserLens,   // 회귀가드가 렌즈를 직접 실행해 필드 누수를 확인한다
  identityKey,
  classifyParity,
  projectTab,
  _enrichTab,          // 회귀가드가 링크 규칙을 직접 실행해 확인한다(2026-08-19 링크 오염)
  projectActive,
  parityReport,
  parityAll,
  parityTrend,
  setOwnership,
  removeOwnership,
  transferOwnership,
  listOwnership,
  listAdvertisersWithOwnership,
  ownedTabsForAdvertiser,
  finishCandidate,
  advertiserOverview,
  createAdvertiserScoped,
  deleteAdvertiser,
  ownedSheetIds,
  getAdvertiserLink, ensureAdvertiserLink, generateAdvertiserLink, setAdvertiserLinkActive,
  setAdvertiserLinkLoginRequired,
  isRegisteredIntranetAdvertiser,
  staffOwnsAdvertiser,
  sheetAssignableByStaff,
  intranetAdvertisers, intranetStaffUsers, setAdvertiserInadPm,
  intranetSalesSearch,
  advertiserForTab,
  intranetSalesForAdvertiser,
  contractCandidatesForTab,
  linkSettlement,
  unlinkSettlement,
  setSettlementVisible,
  settlementForTab,
  quoteDocForTab,
  invoiceDocForTab,
  brandsForAdvertiser, createBrand, updateBrand, assignBrandTabs, brandTabAllowed,
  settlementSummaryForAdvertiser, advertiserWorkSummary, reviewImagesForTab, saveTabMemo,
  __advertiserColumnsForTest: _advertiserColumns,   // 광고주 컬럼 화이트리스트(회귀가드 전용 노출)
  __advertiserHeaderCandidatesForTest: _advertiserHeaderCandidates,
  __advertiserColumnValueForTest: _advertiserColumnValue,
  // 회귀가드 전용 — tabStatsMap 의 30초 프로세스 캐시를 비운다(시나리오마다 다른 스텁 응답을 태우기 위해).
  //   운영 코드에서 부르지 말 것: 캐시는 "모든 내부 사용자의 홈 진입 경로"에 붙은 비용 절감 장치다.
  __resetTabStatsCacheForTest() { _tabStatsCache = { at: 0, map: null }; },
  // 회귀가드 전용 — 인트라넷 사용자(AE) 60초 캐시를 비운다(시나리오마다 다른 스텁 응답을 태우기 위해).
  __resetIntraUserCacheForTest() { _intraUserCache = { at: 0, rows: null }; },
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
  _advertiserColumns,   // 광고주 노출 화이트리스트 매핑(테스트/회귀가드용)
  canAccessTab,
  overview,
  projectionCoverage,
  getSourceOfTruth,
  setSourceOfTruth,
  cutoverAll,
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
  setWorkdeskTitle,
  editWorkdeskRow,
  editWorkdeskRowsBatch,
  EDIT_BATCH_MAX,
  revertWorkdeskEdit,
  manualWorkdeskReviewSubmit,
  previewWorkdeskOrderDelete,
  deleteWorkdeskOrderRow,
  assignUnslottedOrderToOpenSlot,
  hideWorkdeskRow,
  addWorkdeskRow,
  listEdits,
  listCustomColumns,
  addCustomColumn,
  deleteCustomColumn,
  setCustomColumnValue,
  setCellColors,
  __displayNumberForTest: _displayNumber,
  __mergeUnslottedOrderRowForTest: _mergeUnslottedOrderRow,
  __setPoolForTest,
  __setLedgerRebuildForTest,
};
