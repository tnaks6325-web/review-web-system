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
const { extractAmountNumber } = require('../utils/paymentAmount');
const participants = require('./participants.service');
const cm = require('../utils/contractMatch');   // 작업명↔계약 유사도 판정 단일 출처(순수함수)
const { hasCashReceiptSlot, cashReceiptNote } = require('../utils/captureSlots');   // 현영 판정 단일 규칙(재구현 금지)
const workdeskOrderDelete = require('./workdeskOrderDelete.service');
const { TRACKING_HEADER_RE, isTrackingHeader } = require('../utils/trackingColumn');   // 택배송장 열 판정 단일 출처(사본 금지)
const { isFilledRow: _isFilledRow, numberColumnKey: _numberColumnKey } = require('../utils/rowNumbering');   // "채워진 줄" 판정 · 표의 「번호」 칸 이름 — 단일 출처(SQL `filledSql` 과 한 벌)
const { formatDepositStamp } = require('../utils/depositStamp');   // 입금 칸 표기 단일 출처(자동 반영과 같은 'M/D')
const { resolveWorkManager } = require('../utils/workManager');   // 담당자 판정 단일 출처(065 + 회차 #18 — payment.service 와 한 벌)

// ── 공유 링크 토큰 생성 — 단일 출처(업체 접속 링크 · 브랜드 열람 링크 공용, 사본 금지) ──
//   ★ 12바이트 base64url = **16자**. 이 토큰은 URL 프래그먼트(#a=)로 카톡에 붙어 다니므로 길이가 곧
//     사용성이다(종전 24바이트 32자). 96비트 엔트로피 + 교환 라우트 레이트리밋(30/분)이라 추측 불가.
//   ★ 기존에 발급된 32자 토큰은 정확일치 조회라 **그대로 유효**하다 — 짧아지는 건 신규 발급분뿐.
//   ★ 길이를 다시 늘리려면 여기 한 곳만 고친다(네 곳에 흩어져 있던 randomBytes(24) 사본을 이관).
const LINK_TOKEN_BYTES = 12;
function _linkToken() { return require('crypto').randomBytes(LINK_TOKEN_BYTES).toString('base64url'); }

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
// 편집 가능 필드 → 형태(bool/text). 화이트리스트(인젝션·형오류 차단).
// ★★ '_hidden'(행 숨김 오버레이)은 **제거됐다**(사용자 확정 2026-08-23) — 되살리지 말 것.
//   행을 화면에서만 감추면 표의 줄 수와 진행 현황·마감자료가 서로 다른 사실을 말한다
//   (실사고: 참여자 85명인데 게이지가 82/100). 줄을 내리는 창구는 [행 삭제]·[🧹 줄 정리] 뿐이다.
const _EDIT_FIELD_KIND = {
  reviewer_name: 'text', recipient_name: 'text', round: 'text', option_text: 'text',
  product_name: 'text', phone8: 'text',
};
// 시트 컬럼(헤더)이 제출/입금 "상태 토글"열이면 물리 토글로 연동 → 카운트(제출완료/입금완료)와 일치.
//   ★ 정확 화이트리스트 — '입금자명/입금계좌/입금일'·'리뷰제출일/리뷰미제출'·'주문자제출' 등 정보열 오탐 차단.
//   미매칭이면 null(연동 안 함, 안전). 새 상태열 명칭은 여기 추가.
const _SUBMIT_HEADERS = new Set(['리뷰', '리뷰제출', '리뷰제출여부', '리뷰제출완료', '제출']);
const _PAID_HEADERS = new Set(['입금', '입금여부', '입금완료']);
function _linkedToggle(header) {
  const h = String(header || '').trim();
  if (_SUBMIT_HEADERS.has(h)) return 'is_submitted';
  if (_PAID_HEADERS.has(h)) return 'is_paid';
  return null;
}
/* ★★ 그 탭이 실제로 쓰는 상태 칸은 **행이 들고 있는 `submit_col`/`submit_col2`** 다 (2026-08-21 실측).
   `_SUBMIT_HEADERS` 는 정확일치 목록이라 헤더가 그냥 `리뷰` 인 탭(columnResolver 3단계가 정상 채택하는
   실재 형태)을 못 잡았다 — 시스템은 그 칸에 제출 시각을 쓰는데 화면·편집 게이트만 "평범한 칸"으로 봐서
   **관리자가 직접 타이핑할 수 있고 [📎 수동 리뷰제출] 메뉴는 안 뜨는** 상태가 됐다.
   → 판정은 `submit_col`(그 탭의 진짜 상태 칸) 우선, 이름 목록은 그 값이 없을 때의 폴백. */
function _statusToggleForRow(header, row) {
  const h = String(header || '').trim();
  if (!h) return null;
  if (row && String(row.submit_col || '').trim() === h) return 'is_submitted';
  if (row && String(row.submit_col2 || '').trim() === h) return 'is_paid';
  return _linkedToggle(h);
}

// ── 그림자 투영: 임포트(participants) + 신원키/주문링크 강화 + seen-set 재투영 ──
async function projectTab({ sheetId, tabName, by = 'trackB' } = {}) {
  if (!sheetId || !tabName) throw new Error('projectTab: sheetId, tabName 필수');
  const runStart = new Date().toISOString();
  // 1) 로스터 임포트(review_index→campaign_participants). 기존 검증된 경로 재사용(시트 재읽기 0).
  const imp = await participants.importTabFromIndex({ sheetId, tabName, by });
  // 2) 신원키 + 주문링크 강화(라이브 order_submissions를 읽어 B에만 씀).
  //    ★ 무시트 탭에서도 계속 돈다 — row_json 을 건드리지 않고 identity_key·주문링크만
  //      blank-only 로 채우므로(되돌림과 무관) 관제 대조·중복 판정의 재료가 유지된다.
  const enr = await _enrichTab({ sheetId, tabName });
  // 3) seen-set: 이번 임포트에 안 보인 import행 → 비활성(하드삭제 아님, 이력 보존).
  /* ★★★ 임포트를 건너뛴 탭(무시트)에서는 **절대 돌리면 안 된다** — 이번 실행에 아무것도
     임포트하지 않았으므로 `imported_at < runStart` 에 그 탭의 `source='import'` 활성 줄이
     **전부** 걸려 통째로 비활성화된다(이관된 무시트 탭에 그런 줄이 남아 있다).
     "시트에서 사라진 줄 정리" 라는 이 단계의 목적 자체가 무시트 탭에는 성립하지 않는다. */
  const rec = (imp && imp.skipped) ? { deactivated: 0, reconcileSkipped: true }
                                   : await _reconcileSeen({ sheetId, tabName, runStart });
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
// ══════════════════════════════════════════════════════════════════════════
// 시트 전체 소유 → 작업(탭) 단위로 펼치기 (사용자 확정 2026-08-23)
//   업체관리의 지정 창구가 **작업(탭) 단위 하나**로 바뀌었지만, 이미 저장된 `tab_gid IS NULL`
//   (시트 전체) 행은 그대로 살아 그 시트의 모든 탭을 계속 덮는다 — 새 탭이 생기면 자동 포함까지 된다.
//   ★★ 무시트화(전환)는 `tab_configs.sheetless` 플래그만 켜고 `sheet_id` 는 그대로 두므로
//      시트 축을 없애지 못한다(sheetlessCutover.service.js). 실제로 없애는 것은 이 펼치기다.
//   ★★ 완화 금지 4종:
//     ① 대상 탭은 **활성 작업 목록**(participants.listActiveTabs) — 화면의 미지정 판정과 같은 재료.
//     ② **gid 없는 탭이 하나라도 있으면 그 시트는 펼치지 않는다**(fail-closed) — 그 작업은 개별
//        소유를 만들 수 없어 시트 전체 행을 지우는 순간 **주인 없이 남는다**.
//     ③ **다른 업체가 탭 지정으로 가져간 탭은 건너뛴다**(탭 지정 우선 = 사람이 명시한 더 강한 결정,
//        transferOwnership 의 keptTabOverrides 와 같은 규율).
//     ④ **미리보기 기본**(confirm !== true 면 쓰기 0) · 시트 하나당 한 트랜잭션(전부 아니면 전무).
//   ★ 쓰기 표면 = advertiser_campaigns 한 곳(시트·장부·주문 무접촉).
async function expandSheetOwnerships({ advertiserId = null, sheetId = null, confirm = false, by = 'admin', staffName = null } = {}) {
  const db = getPool();
  const where = ['ac.deleted_at IS NULL', 'ac.tab_gid IS NULL', `COALESCE(a.status,'') <> 'ended'`];
  const vals = [];
  if (advertiserId) { vals.push(String(advertiserId)); where.push(`ac.advertiser_id = $${vals.length}`); }
  if (sheetId) { vals.push(String(sheetId)); where.push(`ac.sheet_id = $${vals.length}`); }
  // staff(AE)는 자기 담당(inad_pm) 업체만 — 라우트 게이트와 이중.
  if (staffName) { vals.push(String(staffName).trim()); where.push(`TRIM(COALESCE(a.inad_pm,'')) = TRIM($${vals.length})`); }
  const { rows: owns } = await db.query(
    `SELECT ac.advertiser_id AS "advertiserId", a.name AS "advertiserName", ac.sheet_id AS "sheetId"
       FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
      WHERE ${where.join(' AND ')} ORDER BY a.name, ac.sheet_id`, vals);
  if (!owns.length) return { ok: true, dryRun: !confirm, items: [], expanded: 0, assigned: 0, skipped: 0 };

  const tabs = await participants.listActiveTabs({ limit: 2000 });
  const bySheet = new Map();
  tabs.forEach(t => { const a = bySheet.get(t.sheetId) || []; a.push(t); bySheet.set(t.sheetId, a); });
  const sids = [...new Set(owns.map(o => o.sheetId))];
  const { rows: ovr } = await db.query(
    `SELECT ac.sheet_id AS "sheetId", ac.tab_gid AS "tabGid", ac.advertiser_id AS "advertiserId", a.name AS "advertiserName"
       FROM advertiser_campaigns ac JOIN advertisers a ON a.id = ac.advertiser_id
      WHERE ac.deleted_at IS NULL AND ac.tab_gid IS NOT NULL AND ac.sheet_id = ANY($1)`, [sids]);

  const items = [];
  let expanded = 0, assigned = 0, skipped = 0;
  for (const o of owns) {
    const list = bySheet.get(o.sheetId) || [];
    const title = (list[0] && list[0].spreadsheetTitle) || o.sheetId;
    const gidless = list.filter(t => !String(t.tabGid == null ? '' : t.tabGid).trim());
    const taken = new Map();   // gid → 그 탭을 탭지정으로 가진 타 업체
    ovr.forEach(x => { if (x.sheetId === o.sheetId && x.advertiserId !== o.advertiserId) taken.set(String(x.tabGid), x.advertiserName); });
    const targets = list.filter(t => {
      const g = String(t.tabGid == null ? '' : t.tabGid).trim();
      return g && !taken.has(g);
    });
    const kept = list.map(t => String(t.tabGid == null ? '' : t.tabGid).trim())
      .filter(g => g && taken.has(g)).map(g => ({ tabGid: g, advertiserName: taken.get(g) }));
    const row = {
      advertiserId: o.advertiserId, advertiserName: o.advertiserName, sheetId: o.sheetId, sheetTitle: title,
      tabs: targets.map(t => ({ tabGid: String(t.tabGid), tabName: t.tabName })),
      keptTabOverrides: kept, gidlessCount: gidless.length,
    };
    // fail-closed — 모르는 채로 소유를 지우지 않는다(주인 없는 작업 금지).
    if (!list.length) row.skipped = 'no_active_tabs';
    else if (gidless.length) row.skipped = 'gidless_tab';
    else if (!targets.length) row.skipped = 'all_tabs_taken';
    if (row.skipped) { skipped++; items.push(row); continue; }
    if (confirm) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        for (const t of row.tabs) {
          await client.query(
            `INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid, assigned_by)
               VALUES ($1,$2,$3,$4)
             ON CONFLICT (advertiser_id, sheet_id, COALESCE(tab_gid,'')) DO UPDATE
               SET deleted_at = NULL, assigned_by = EXCLUDED.assigned_by`,
            [o.advertiserId, o.sheetId, t.tabGid, String(by).slice(0, 100)]);
        }
        await client.query(
          `UPDATE advertiser_campaigns SET deleted_at = NOW()
            WHERE advertiser_id=$1 AND sheet_id=$2 AND tab_gid IS NULL AND deleted_at IS NULL`,
          [o.advertiserId, o.sheetId]);
        await client.query('COMMIT');
        row.applied = true; expanded++; assigned += row.tabs.length;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        row.skipped = 'error'; row.error = (e && e.message) || String(e); skipped++;
      } finally { client.release(); }
    } else { expanded++; assigned += row.tabs.length; }
    items.push(row);
  }
  return { ok: true, dryRun: !confirm, items, expanded, assigned, skipped };
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
//   토큰은 추측불가 랜덤(_linkToken — base64url 12B=16자). 실제 교환(로그인)은 auth.service.loginByLinkToken. Track A 무접촉.
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
  const token = _linkToken();
  await getPool().query(
    `INSERT INTO trackb_advertiser_links (advertiser_id, token, active, created_by)
     VALUES ($1,$2,TRUE,$3) ON CONFLICT (advertiser_id) DO NOTHING`, [advertiserId, token, String(by).slice(0, 100)]);
  return await getAdvertiserLink(advertiserId);
}
async function generateAdvertiserLink({ advertiserId, by = '' } = {}) {
  if (!advertiserId) return { ok: false, code: 400, error: 'advertiserId 필수' };
  const exists = await getPool().query('SELECT 1 FROM advertisers WHERE id = $1', [advertiserId]);
  if (!exists.rows.length) return { ok: false, code: 404, error: '거래처를 찾을 수 없습니다.' };
  const token = _linkToken();
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
//   소유 카운트 등에 잔재가 남지 않게 한다. (Track A·시트 무접촉 — Track B 내부만.)
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

/* ★★ staff 초기매핑 시트 게이트(`sheetAssignableByStaff`)는 **제거됐다**(사용자 확정 2026-08-24).
     "타 AE 업체가 이미 소유한 시트로의 자가 스코프 확장 차단"이 존재 이유였는데, 업체 지정 자체가
     담당 무관으로 열리면서 근거가 사라졌다. ★ 죽은 판정을 남겨 두면 다음 사람이 되살린다 —
     되살리려면 `POST /api/trackb/ownership` 의 담당 게이트와 **함께** 되살려야 한다(한쪽만 두면
     "담당 업체인데도 시트 때문에 막히는" 반쪽 규칙이 된다). */

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
            /* displayName = 화면이 그리는 작업명. 업체관리 연결작업 표와 광고주 화면은 이 응답을 쓰므로,
               여기 없으면 라벨 함수가 늘 탭 이름으로 접혀 통일이 조용히 무력화된다(코드리뷰 P2). */
            COALESCE(tc.display_name, '') AS "displayName",
            tc.capture_slots AS "captureSlots", tc.income_type AS "incomeType",
            COALESCE(tc.sheetless, FALSE) AS "sheetless",
            (tc.sheet_id IS NOT NULL) AS "hasTabConfig",
            wo.recruit_count AS "woRecruit", wo.start_date::text AS "woStartDate",
            rc.recruit_total AS "recruitTotal",
            sl.sales_id AS "salesId", sl.contract_number AS "contractNumber",
            co.closed_date AS "closeoutDate", co.row_count AS "closeoutRows", co.sub_count AS "closeoutSubs",
            tm.memo,
            EXISTS (SELECT 1 FROM index_master im WHERE im.status = 'active' AND im.sheet_id = t.sheet_id
                      AND (im.tab_gid = t.tab_gid OR im.tab_name = t.tab_name)) AS "active"
       /*
        * 업체 작업목록의 「제출」은 작업보드 진행 카드와 같은 진실원본을 쓴다.
        * campaign_participants.is_submitted는 검수/정산 상태 플래그라 재투영보다
        * 늦을 수 있어, 표에 리뷰제출 값이 있어도 목록이 예전 숫자에 남을 수 있다.
        * 행별로 파서가 잡은 submit_col을 우선하고, 수동·무시트 행처럼 그것이 비어
        * 있으면 해당 탭 review_index의 실제 리뷰제출 헤더를 쓴다.
        */
       FROM tabs t
       LEFT JOIN LATERAL (
         SELECT NULLIF(MAX(NULLIF(BTRIM(ri.submit_col), '')), '') AS submit_header
           FROM review_index ri
          WHERE ri.sheet_id = t.sheet_id AND ri.tab_name = t.tab_name
       ) submit_header ON TRUE
       LEFT JOIN LATERAL (
         /* workdeskTab과 같은 앵커 규율:
            - 현재 앵커의 셀 편집이 원본 셀보다 우선
            - 주문/identity 앵커가 중복이면 어떤 행에도 적용하지 않음
            - 앵커 승격 전 저장한 물리행(manual) 편집은 현재 앵커보다 낮은 우선순위
            이 규칙이 없으면 업체 목록과 실제 작업표가 다시 달라진다. */
         WITH active_rows AS (
           SELECT cp.*,
                  CASE WHEN cp.order_submission_id IS NOT NULL THEN 'order'
                       WHEN cp.source = 'manual' THEN 'manual'
                       WHEN NULLIF(BTRIM(cp.identity_key), '') IS NOT NULL THEN 'identity'
                       ELSE NULL END AS anchor_type,
                  CASE WHEN cp.order_submission_id IS NOT NULL THEN cp.order_submission_id::text
                       WHEN cp.source = 'manual' THEN cp.id::text
                       WHEN NULLIF(BTRIM(cp.identity_key), '') IS NOT NULL THEN cp.identity_key
                       ELSE NULL END AS anchor_value
             FROM campaign_participants cp
            WHERE cp.sheet_id = t.sheet_id AND (cp.tab_gid = t.tab_gid OR cp.tab_name = t.tab_name)
              AND cp.deleted_at IS NULL AND cp.active = TRUE
         ), anchored_rows AS (
           SELECT ar.*, COUNT(*) OVER (PARTITION BY ar.anchor_type, ar.anchor_value) AS anchor_count
             FROM active_rows ar
         )
         SELECT MIN(cp.first_seen_at) AS first_seen,
                COUNT(*) FILTER (WHERE cp.active AND cp.deleted_at IS NULL)::int AS total,
                COUNT(*) FILTER (WHERE cp.active AND cp.deleted_at IS NULL
                  AND NULLIF(BTRIM(COALESCE(
                    CASE WHEN cp.anchor_type IS NOT NULL
                              AND (cp.anchor_type = 'manual' OR cp.anchor_count = 1)
                         THEN CASE WHEN current_edit.kind = 'bool' THEN CASE WHEN current_edit.value_bool THEN 'O' ELSE '' END
                                   ELSE current_edit.value_text END END,
                    CASE WHEN cp.anchor_type IS NOT NULL AND cp.anchor_type <> 'manual' AND cp.anchor_count = 1
                         THEN CASE WHEN manual_edit.kind = 'bool' THEN CASE WHEN manual_edit.value_bool THEN 'O' ELSE '' END
                                   ELSE manual_edit.value_text END END,
                    cp.row_json ->> COALESCE(NULLIF(BTRIM(cp.submit_col), ''), submit_header.submit_header)
                  )), '') IS NOT NULL)::int AS submitted,
                COUNT(*) FILTER (WHERE cp.active AND cp.deleted_at IS NULL AND cp.is_paid)::int AS paid
           FROM anchored_rows cp
           LEFT JOIN LATERAL (
             SELECT e.kind, e.value_bool, e.value_text
               FROM participant_edits e
              WHERE e.sheet_id = t.sheet_id AND e.tab_name = t.tab_name AND e.reverted_at IS NULL
                AND e.anchor_type = cp.anchor_type AND e.anchor_value = cp.anchor_value
                AND e.field = 'col:' || COALESCE(NULLIF(BTRIM(cp.submit_col), ''), submit_header.submit_header)
              LIMIT 1
           ) current_edit ON TRUE
           LEFT JOIN LATERAL (
             SELECT e.kind, e.value_bool, e.value_text
               FROM participant_edits e
              WHERE e.sheet_id = t.sheet_id AND e.tab_name = t.tab_name AND e.reverted_at IS NULL
                AND e.anchor_type = 'manual' AND e.anchor_value = cp.id::text
                AND e.field = 'col:' || COALESCE(NULLIF(BTRIM(cp.submit_col), ''), submit_header.submit_header)
              LIMIT 1
           ) manual_edit ON TRUE
       ) cnt ON TRUE
       LEFT JOIN tab_configs tc ON tc.sheet_id = t.sheet_id AND tc.tab_name = t.tab_name
       LEFT JOIN LATERAL (
         SELECT w.recruit_count, w.start_date FROM trackb_work_order_links l JOIN work_orders w ON w.id = l.work_order_id
          WHERE l.sheet_id = t.sheet_id AND l.tab_name = t.tab_name AND l.deleted_at IS NULL
          ORDER BY l.created_at DESC LIMIT 1
       ) wo ON TRUE
       /* 업체 화면의 총건수도 작업 조건 카드와 같은 적용 정원(공고 우선, 없으면 발주)을 쓴다.
          활성 작업행 수는 내부 투영·정리용 값일 뿐 업체에게 "총 건수"로 보이면 안 된다. */
       LEFT JOIN LATERAL (
         SELECT recruit_total
           FROM recruit_campaigns rc
          WHERE rc.linked_sheet_id = t.sheet_id
            AND (rc.linked_tab_name = t.tab_name OR (t.tab_gid IS NOT NULL AND rc.linked_tab_gid = t.tab_gid))
          ORDER BY (rc.status = 'active') DESC, rc.created_at DESC
          LIMIT 1
       ) rc ON TRUE
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
  // 계약 품목은 신형 `contract_items` JSON 배열이다. 일부 구형 이관 건은 contract_detail 에
  // 배열을 남겼으므로 둘 다 읽되, 일반 텍스트 상세는 억지로 품목으로 만들지 않는다.
  let contractItems = [];
  const rawItems = r.contract_items != null ? r.contract_items : r.contract_detail;
  if (Array.isArray(rawItems)) contractItems = rawItems;
  else if (typeof rawItems === 'string' && rawItems.trim().startsWith('[')) {
    try { const parsed = JSON.parse(rawItems); if (Array.isArray(parsed)) contractItems = parsed; } catch (_) {}
  }
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
    contractItems,
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
  let failed = false;
  // 단일 limit 으로 자르면 오래된 계약이 조용히 빠진다. 인트라넷 테이블 API의 page 계약을 끝까지
  // 따라가되, `where` 가 무시돼 첫 페이지부터 다른 업체가 섞이면 즉시 중단한다. 비정상 프록시가
  // 같은 페이지를 되돌려도 무한 반복하지 않도록 새 id가 없으면 멈춘다.
  const fetchAll = async (query, { exactFirstPage = false } = {}) => {
    const rows = [];
    const seen = new Set();
    const pageSize = 500;
    for (let page = 1; page <= 100; page++) {
      const sep = query.includes('?') ? '&' : '?';
      const j = await _intranetGet(`${query}${sep}limit=${pageSize}&page=${page}&sort=created_at&order=DESC`);
      reached = true;
      const pageRows = Array.isArray(j.data) ? j.data : [];
      // 누락된 컬럼의 where 절은 API가 조용히 무시할 수 있다. 이 경우 전 계약을 끝까지 순회하지 않고
      // 이름 검색 폴백으로 넘긴다. 정상 정확일치 결과에 타 업체 계약을 허용하지 않는 보수적 판정이다.
      if (exactFirstPage && page === 1 && pageRows.some(raw => !mine(_mapSales(raw)))) {
        return { rows: [], ignoredFilter: true };
      }
      let added = 0;
      for (const raw of pageRows) {
        const id = String(raw && raw.id || '');
        const rowKey = id || JSON.stringify(raw);
        if (seen.has(rowKey)) continue;
        seen.add(rowKey); rows.push(raw); added++;
      }
      if (pageRows.length < pageSize || !added) break;
    }
    return { rows, ignoredFilter: false };
  };
  const cols = nm.includes('=') ? [] : ['business_name', 'advertiser_name'];   // '=' 포함 이름은 where 파서가 못 씀
  for (const col of cols) {
    try {
      const got = await fetchAll(`/api/tables/sales?where=${encodeURIComponent(`${col}=${nm}`)}`, { exactFirstPage: true });
      if (!got.ignoredFilter) for (const raw of got.rows) { const r = _mapSales(raw); if (mine(r)) out.set(r.salesId, r); }
    } catch (e) { failed = true; logger.warn(`[trackB] 인트라넷 계약 조회 실패(${col}): ${e.message}`); }
  }
  // 폴백: 정확일치 조회로 0건이면 이름 검색 후 같은 기준으로 다시 거른다(표기·컬럼 차이 흡수).
  if (!out.size) {
    try {
      const got = await fetchAll(`/api/tables/sales?search=${encodeURIComponent(nm)}`);
      for (const raw of got.rows) { const r = _mapSales(raw); if (mine(r)) out.set(r.salesId, r); }
    } catch (e) { failed = true; logger.warn(`[trackB] 인트라넷 계약 검색 실패: ${e.message}`); }
  }
  // 여러 페이지 중 하나라도 실패하면 일부만 캐시해 완전한 계약 목록처럼 보이지 않는다.
  if (failed) return { ok: false, error: 'intranet_unreachable', items: [] };
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
  // 136: 작업별 브랜드 담당자 — 배치 1쿼리(fail-soft 빈 맵). 브랜드 관리 화면의 작업 행이 현재 값을 그린다.
  const bmgr = await tabBrandManagersMap({ advertiserId });
  return {
    settlementHidden: !visible,
    brand: brand ? { id: brand.id, name: brand.name, color: brand.color } : null,
    brands: brandsOut && brandsOut.ok ? brandsOut.brands : undefined,
    items: tabs.map(t => {
      const s = setlByTab.get(t.sheetId + '\t' + t.tabName) || null;
      // 총건수는 작업보드와 같은 공고 우선·발주 폴백 정원이다. bTotal(활성 작업행)은
      // 광고주 응답에서 버린다. 작업행 준비 상태가 "총 건수"로 오해되는 것을 구조적으로 막는다.
      const { total: recruitTotal } = require('./linkedRecruitQuota.service')
        .displayRecruitTotal(t.recruitTotal, t.woRecruit);
      return {
        sheetId: t.sheetId, tabGid: t.tabGid, tabName: t.tabName, spreadsheetTitle: t.spreadsheetTitle,
        // 작업명 — 업체 화면도 목록·헤더가 같은 이름을 쓰게 한다(사용자 확정 2026-08-24).
        //   ★ 이 렌즈는 **화이트리스트 재구성**이라 명시로 실어야 한다(스프레드가 아니다).
        //   ★ 빈 값이면 화면이 종전대로 탭 이름으로 접는다(동작 불변). 작업 이름일 뿐 PII 가 아니다.
        displayName: t.displayName || '',
        // 무시트 여부 — 업체 화면이 시트 제목 라벨을 그릴지 정하는 표시용 불리언(민감정보 아님).
        // 없으면 화면이 종전대로 시트 제목을 그리므로, 이 한 칸이 빠지면 라벨 숨김이 조용히 무력화된다.
        sheetless: t.sheetless === true,
        active: t.active !== false,
        submitted: t.bSub || 0, paid: t.bPaid || 0,
        target: recruitTotal || null,
        startDate: t.woStartDate ? String(t.woStartDate).slice(0, 10) : null,
        brandId: brandByTab.get(t.sheetId + '\t' + t.tabName) || null,
        brandManagers: bmgr.get(t.sheetId + '\t' + t.tabName) || [],
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
  const token = _linkToken();
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
    const token = _linkToken();
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
/* ═══ 작업(탭)별 브랜드 담당자 (136) — 대행사가 브랜드사에게 보여줄 자기 쪽 담당자 ═══
   사용자 확정 2026-08-24: 저장 단위 = 작업 하나 · 최대 2명 · 라벨 없는 자유입력.
   ★ 판정·정규화는 여기 한 곳(`_normBrandManagers`) — 라우트·화면이 각자 자르면 규칙이 갈린다.
   ★ 빈 값은 저장하지 않고 행을 지운다: "미입력" 상태를 **행 없음** 하나로만 표현한다
     (빈 배열 행이 남으면 "값이 있는데 비어 있음" 과 "미입력" 이 구분되지 않는다). */
const BRAND_MANAGER_MAX = 2;
const BRAND_MANAGER_NAME_MAX = 20;
function _normBrandManagers(names) {
  return (Array.isArray(names) ? names : [])
    .map((v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, BRAND_MANAGER_NAME_MAX))
    .filter(Boolean)
    .slice(0, BRAND_MANAGER_MAX);
}
/* 배치 조회 — 브랜드 관리 화면(작업 목록)·요약 응답이 쓴다. 신규 표라 **미적용이면 빈 맵**(fail-soft):
   담당자 표기가 없을 뿐 화면은 그대로 뜬다(0·빈값 위장이 아니라 "아직 아무도 안 적었다"와 같은 상태). */
async function tabBrandManagersMap({ advertiserId } = {}) {
  if (!advertiserId) return new Map();
  try {
    const { rows } = await getPool().query(
      'SELECT sheet_id AS "sheetId", tab_name AS "tabName", managers FROM trackb_tab_brand_managers WHERE advertiser_id=$1',
      [advertiserId]);
    return new Map(rows.map((r) => [r.sheetId + '\t' + r.tabName, _normBrandManagers(r.managers)]));
  } catch (err) {
    logger.warn('[trackB] 브랜드 담당자 조회 실패(표시 생략): ' + err.message);
    return new Map();
  }
}
async function tabBrandManagersFor({ advertiserId, sheetId, tabName } = {}) {
  if (!advertiserId || !sheetId || !tabName) return [];
  try {
    const { rows } = await getPool().query(
      'SELECT managers FROM trackb_tab_brand_managers WHERE advertiser_id=$1 AND sheet_id=$2 AND tab_name=$3',
      [advertiserId, sheetId, tabName]);
    return rows.length ? _normBrandManagers(rows[0].managers) : [];
  } catch (err) {
    logger.warn('[trackB] 브랜드 담당자 조회 실패(표시 생략): ' + err.message);
    return [];
  }
}
/* 저장 — ★ 대상은 **그 대행사가 소유한 탭만**(남의 작업에 담당자를 심을 수 없다).
   판정은 `ownedTabsForAdvertiser` 단일 출처(브랜드 귀속 화면·요약이 쓰는 그 목록). */
async function setTabBrandManagers({ advertiserId, sheetId, tabName, names, actor = null } = {}) {
  if (!advertiserId || !sheetId || !tabName) return { ok: false, code: 400, error: 'sheetId, tabName 필수' };
  const owned = (await ownedTabsForAdvertiser({ advertiserId })).rows
    .some((t) => t.sheetId === sheetId && t.tabName === tabName);
  if (!owned) return { ok: false, code: 404, error: '이 업체의 작업이 아닙니다.' };
  const list = _normBrandManagers(names);
  const db = getPool();
  try {
    if (!list.length) {
      await db.query('DELETE FROM trackb_tab_brand_managers WHERE advertiser_id=$1 AND sheet_id=$2 AND tab_name=$3',
        [advertiserId, sheetId, tabName]);
      return { ok: true, managers: [] };
    }
    await db.query(
      `INSERT INTO trackb_tab_brand_managers (advertiser_id, sheet_id, tab_name, managers, updated_by)
            VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (advertiser_id, sheet_id, tab_name)
       DO UPDATE SET managers=EXCLUDED.managers, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
      [advertiserId, sheetId, tabName, JSON.stringify(list), actor ? String(actor).slice(0, 60) : null]);
    return { ok: true, managers: list };
  } catch (err) {
    if (err && err.code === '42P01') return { ok: false, code: 503, error: 'not_ready', detail: 'migration 136 미적용' };
    throw err;
  }
}
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
/* 작업 조건 카드의 옵션별 결제금액 표시 재료 — 인트라넷 구조화 신호(product_options_json 의
   [{name,url,base:{pay,count},options:[{label,pay,count}]}])에서 **금액이 있는 옵션만** 뽑는다.
   ★ 문자열·이름만 있는 레거시 배열은 제외 — 금액 없는 옵션을 "블랙 —원" 으로 그리느니
     옵션 없는 표기(1건당 결제금액)로 떨어지는 쪽이 정직하다. `_parseWoOptions`(이름 전용)와
     계약이 달라 별도 함수로 둔다(합치면 작업표 생성 쪽 소비처가 흔들린다). */
function _condWoOptions(json) {
  if (!json) return [];
  let v; try { v = typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return []; }
  if (!Array.isArray(v)) return [];
  const num = x => (x == null || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
  const out = [];
  for (const p of v) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.options)) continue;
    for (const o of p.options) {
      if (!o || typeof o !== 'object') continue;
      const label = String(o.label || o.name || '').trim();
      if (!label) continue;
      out.push({ label, pay: num(o.pay), count: num(o.count) });
    }
  }
  return out;
}

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

// 광고주(외부) 노출 차단 목록 — 요청한 신원·정산정보 다섯 종류만 제외하고 원본 시트 컬럼을 모두 연다.
//   ★ 데이터 최소화: 제외한 컬럼은 rowJson에서도 빼서 화면만이 아니라 네트워크 페이로드에도 싣지 않는다.
//   신원열(참여자 이름·DB 연락처)은 프론트가 광고주 그리드에서 별도로 렌더하지 않으며, 동명 시트 열도 여기서 차단한다.
function _isAdvertiserRestrictedHeader(header) {
  const key = String(header == null ? '' : header).replace(/\s+/g, '').toLowerCase();
  return /참여자/.test(key)
    || /연락처|전화|핸드폰|휴대폰|전번|phone/.test(key)
    || /은행|bank/.test(key)
    || /계좌|account/.test(key)
    || /예금주/.test(key);
}

function _advertiserColumns(rawHeaders) {
  const seen = new Set();
  return (rawHeaders || []).filter(header => {
    const value = String(header == null ? '' : header).trim();
    if (!value || value === 'id' || seen.has(value) || _isAdvertiserRestrictedHeader(value)) return false;
    seen.add(value);
    return true;
  });
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
  /* ── 구매 캡처 ② **공고(참여형) 좌표 주문** ────────────────────────────────────
     ★★ 실사고(2026-08-23 「0807(올리브영)블랑카우 바디로션 100건」): 8/19 이후 제출한 9명의
       구매 캡처가 전부 "미제출"로 보였다. 파일은 Drive 에 있고 주문에도 연결돼 있었다 —
       **공고를 거쳐 제출한 주문은 원장 좌표가 `campaign:<공고ID>`**(submit.routes
       `_resolveCampaignOrderScope`)라 위 탭 좌표 조회에 **한 건도 안 걸렸을 뿐**이다.
       그 탭에 공고가 붙은 순간부터 모든 신규 제출이 이 갈래로 들어오므로, 이 조회가 없으면
       화면이 "제출 안 했다"고 거짓말을 계속한다.
     ★ 짝짓기는 위와 **같은 `sheet_row`** 하나 — `campaign_participants.order_submission_id`
       링크는 오염 사례가 문서화돼 있어 쓰지 않는다(2026-08-19 장수산업 건과 같은 규율).
     ★ 공고 매칭은 이름 → gid 폴백이고 **빈 gid 는 절을 켜지 않는다**. gid 는 **서버가
       tab_configs 에서 다시 구한다** — 화면이 보낸 값을 믿으면 낡은 화면이 남의 공고를 끌어온다.
     ★ 차수 재발행으로 공고가 여럿이면 전부 합류한다(같은 작업표 줄에 기록된 주문들이다).
     ★ fail-soft: 실패해도 위에서 모은 것은 그대로 나간다. */
  let _gid = '';
  try {
    const { rows: tg } = await db.query(
      `SELECT COALESCE(tab_gid, '') AS gid FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`,
      [sheetId, tabName]);
    _gid = (tg[0] && tg[0].gid) || '';
  } catch (_) { _gid = ''; }
  const { rows: campCaps } = await db.query(
    `SELECT os.sheet_row, os.capture_file_id, os.capture_uploaded_at
       FROM order_submissions os
       JOIN recruit_campaigns rc
         ON os.sheet_id = 'campaign:' || rc.id AND os.tab_name = 'campaign:' || rc.id
      WHERE rc.linked_sheet_id = $1
        AND (rc.linked_tab_name = $2 OR ($3 <> '' AND rc.linked_tab_gid = $3))
        AND os.deleted_at IS NULL
        AND os.sheet_row IS NOT NULL AND os.capture_file_id IS NOT NULL
      ORDER BY os.sheet_row, os.capture_uploaded_at NULLS LAST`,
    [sheetId, tabName, _gid]).catch(() => ({ rows: [] }));
  for (const r of campCaps) push(r.sheet_row, r.capture_file_id, 'order_capture', r.capture_uploaded_at);
  return Object.fromEntries(out);
}

/**
 * 작업명 정리 — 저장 시점 단일 출처 (2026-08-24 실사고).
 *
 * 무엇이 있었나: 시트에서 칸을 복사해 붙인 값이 그대로 저장돼 이름 안에 **탭(TAB) 문자**가
 * 박혔다(실측: "0_쟈니베어_…_500건\t—"). 화면에서는 공백처럼 보여 눈으로는 못 찾고,
 * 붙어 온 옆 칸 값까지 이름에 남는다.
 *
 * ★★ 지우는 것은 **보이지 않는 문자와 공백뿐** — 글자·기호(대시 등)는 건드리지 않는다.
 *   무엇이 군더더기인지는 내용 판단이라 사람 몫이다(조용한 자동수정 금지 규율).
 * ★ 제어문자는 **삭제가 아니라 공백으로** 바꾼다 — 지워 버리면 "A\tB" 가 "AB" 로 붙어
 *   원래 없던 단어가 만들어진다.
 * ★ 정리 결과가 비면 저장을 **거부**한다(보이지 않는 문자만 친 입력 = 이름이 아니다).
 * ★ 길이 검사는 **정리한 값** 기준(정리 전 길이로 막으면 지워질 문자 때문에 거부된다).
 */
function normalizeDisplayName(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')                                  // 제어문자(탭·개행 포함)
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')         // 유니코드 공백류(NBSP·전각공백…)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')                                   // 폭 없는 문자(붙여넣기 잔재)
    .replace(/\s+/g, ' ')
    .trim();
}

// Keeps relational tab_name stable; only the workboard-facing display name changes.
async function setWorkdeskTitle({ sheetId, tabName, displayName } = {}) {
  const sid = String(sheetId || '').trim();
  const tab = String(tabName || '').trim();
  const raw = String(displayName == null ? '' : displayName);
  const name = normalizeDisplayName(raw);
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
  // ★ 값이 실제로 달라졌으면 화면이 그 사실을 말한다(조용한 자동수정 금지).
  return { ok: true, displayName: (rows[0] && rows[0].displayName) || name, cleaned: name !== raw };
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
/* 「일정」 = 작업보드 표에 적힌 구매일자의 **가장 이른 날 ~ 가장 늦은 날**(사용자 확정 2026-08-23).
   ★★ 모집인원조절(095)이 작업표 줄의 구매일자를 다시 깔면 표가 곧 바뀌므로 **연동 코드가 없다** —
      표를 읽는 것 자체가 연동이다(여기서 계획표를 따로 읽으면 화면과 표가 갈린다).
   ★ 판정 사본 0 — 날짜 칸은 `campaignSchedule.findDateColumnIndex`, 해석은
     `utils/koreanDate.parseDateColumn`. **`fallbackAnchor` 필수**(작업표 표기 `8 / 15 (토)` 는
     연도가 한 칸도 없어 앵커가 없으면 전 행 null 로 조용히 무너진다 — W2-b F-2 와 같은 자리).
   ★ 날짜 칸이 없거나 한 줄도 못 읽으면 **null** — 화면이 「—」로 말한다(오늘로 지어내지 않는다).
   ★ 읽기 전용·fail-soft: 어떤 실패에도 throw 하지 않는다. */
function _condSchedule(rows, headers) {
  try {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    let keys = Array.isArray(headers) ? headers.filter(h => h != null && String(h).trim() !== '') : [];
    if (!keys.length) {
      const seen = new Set(); keys = [];
      for (const r of list) {
        const rj = (r && r.rowJson && typeof r.rowJson === 'object') ? r.rowJson : null;
        if (!rj) continue;
        for (const k of Object.keys(rj)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
      }
    }
    if (!keys.length) return null;
    const { findDateColumnIndex } = require('./campaignSchedule.service');
    const di = findDateColumnIndex(keys);
    if (di < 0) return null;
    const key = keys[di];
    const raw = list.map(r => {
      const rj = (r && r.rowJson && typeof r.rowJson === 'object') ? r.rowJson : {};
      return rj[key] == null ? '' : String(rj[key]);
    });
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const { parseDateColumn } = require('../utils/koreanDate');
    const iso = parseDateColumn(raw, { fallbackAnchor: { y: kst.getUTCFullYear(), m: kst.getUTCMonth() + 1 } })
      .filter(Boolean).sort();
    if (!iso.length) return null;
    return { start: iso[0], end: iso[iso.length - 1] };
  } catch (_) { return null; }
}

/* 모집일 경고의 보정 근거: 이미 사람/주문이 채워진 작업표 행을 표에 표시되는 구매일자로
   묶은 수다. 과거 무시트 전환 작업은 `campaign_daily_plans`에 조절한
   일부 날짜만 남고, 완료된 행의 날짜는 작업표에만 남아 있을 수 있다. 그 경우 계획 합계만
   비교하면 완료 작업을 미설정으로 오인한다.
   ★ `out`은 마스킹 전 내부 렌즈에서 만들며 `filled`도 같은 시점에 확정된다. 날짜 셀 편집
   오버레이가 있으면 화면에서 보이는 값이 우선한다. 날짜 열을 못 찾거나 파싱할 수 없으면
   null로 실패 닫기 — 빈/비표준 날짜를 "배정됨"으로 세어 경고를 숨기지 않는다.
   ★ 읽기 전용 순수 계산이다. 모집계획 저장·작업표 재구성·번호 재정렬 경로를 호출하지 않는다. */
function _filledScheduledRowsByDate(rows, headers) {
  try {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    let keys = Array.isArray(headers) ? headers.filter(h => h != null && String(h).trim() !== '') : [];
    if (!keys.length) {
      const seen = new Set(); keys = [];
      for (const r of list) {
        const rj = (r && r.rowJson && typeof r.rowJson === 'object') ? r.rowJson : null;
        if (!rj) continue;
        for (const k of Object.keys(rj)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
      }
    }
    const { findDateColumnIndex } = require('./campaignSchedule.service');
    const di = findDateColumnIndex(keys);
    if (di < 0) return null;
    const key = keys[di];
    const raw = list.map(r => {
      const rj = (r && r.rowJson && typeof r.rowJson === 'object') ? r.rowJson : {};
      const edits = (r && r.cellEdits && typeof r.cellEdits === 'object') ? r.cellEdits : {};
      const v = Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : rj[key];
      return v == null ? '' : String(v);
    });
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const { parseDateColumn } = require('../utils/koreanDate');
    const parsed = parseDateColumn(raw, { fallbackAnchor: { y: kst.getUTCFullYear(), m: kst.getUTCMonth() + 1 } });
    const byDate = new Map();
    for (let i = 0; i < list.length; i++) {
      if (!list[i] || list[i].filled !== true || !parsed[i]) continue;
      byDate.set(parsed[i], (byDate.get(parsed[i]) || 0) + 1);
    }
    return byDate;
  } catch (_) { return null; }
}

async function tabConditionSummary(db, { sheetId, tabName, meta = {}, wo = null } = {}) {
  try {
    const gid = String(meta.tabGid || '').trim();
    const { rows: camps } = await db.query(
      `SELECT id, title, recruit_total AS "recruitTotal", daily_limit AS "dailyLimit",
              channel, channel_custom AS "channelCustom", review_type AS "reviewType",
              review_type_mix AS "reviewTypeMix",
              review_fee AS "reviewFee", transfer_memo AS "transferMemo",
              transfer_bank AS "transferBank",
              multi_account_mode AS "multiAccount", multi_daily_limit AS "multiDailyLimit",
              to_char(window_start,'HH24:MI') AS "windowStart",
              to_char(window_end,'HH24:MI')   AS "windowEnd",
              status, participation_mode AS "participationMode"
         FROM recruit_campaigns
        WHERE linked_sheet_id = $1
          AND (linked_tab_name = $2 OR ($3 <> '' AND linked_tab_gid = $3))
        ORDER BY (status = 'active') DESC, created_at DESC`,
      [sheetId, tabName, gid]).catch(() => ({ rows: [] }));
    const c = camps[0] || null;
    /* ★★ **값이 있는 최신 공고**(utils/campaignTabLateral 규율) — 차수 재발행으로 한 탭에 공고가
       여럿일 때 기준 공고 하나만 보면 **최신 공고의 빈 칸이 옛 공고의 값을 가린다**. 리뷰타입에서
       한 번 밟은 사고와 같은 자리다(그때는 구매확정 설정이 조용히 풀렸다). '미지정'은 관리자가
       정하지 않은 것이라 가리지 않는다 — 최신이 명시돼 있으면 최신이 그대로 이긴다.
       ★ **0 은 값이다**(무상 작업) — 빈 문자열·NULL 만 건너뛴다.
       ★ 정원(총건수·일건수·다계정)에는 쓰지 않는다 — 그건 카드·apply 게이트가 보는 **그 공고**의
         값이라, 다른 공고에서 주워 오면 화면과 게이트가 갈린다. */
    const pick = (key) => {
      for (const x of camps) { const v = x[key]; if (v != null && String(v).trim() !== '') return x; }
      return null;
    };
    const feeCamp = pick('reviewFee');
    const typeCamp = pick('reviewType');
    const memoCamp = pick('transferMemo');

    /* 기간별 리뷰비 구간(082) — **리뷰비를 준 그 공고** 기준이어야 금액과 구간이 갈리지 않는다.
       실패해도 기존 review_fee 로 떨어진다(fail-soft). */
    let schedules = [];
    const schedCamp = feeCamp || c;
    if (schedCamp) {
      const { rows: fs } = await db.query(
        `SELECT to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom", review_fee AS "reviewFee"
           FROM campaign_fee_schedules WHERE campaign_id = $1 ORDER BY effective_from`,
        [schedCamp.id]).catch(() => ({ rows: [] }));
      schedules = fs;
    }
    /* ★ 0 을 null 로 접지 말 것 — "0원으로 정한 무상 작업"과 "값이 없는 공고"는 다르다.
       폴백 순서(공고 → 탭)는 입금관리(payment.service)와 **같아야** 한다. */
    const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    const campFee = num(feeCamp && feeCamp.reviewFee);
    const tabFee  = num(meta.tabReviewFee);
    const { resolveReviewFee } = require('../utils/campaignFee');
    const feeInfo = resolveReviewFee({ schedules, fallback: campFee != null ? campFee : (tabFee != null ? tabFee : 0) });
    const feeSource = feeInfo.source === 'schedule' ? 'schedule'
      : campFee != null ? 'campaign'
      : tabFee != null ? 'tab' : null;      // null = 근거를 못 찾음(0원이라서가 아니다)

    /* ── 이체은행 — 입금관리(payment.service)와 **같은 공고 · 같은 판정**을 태운다(사본 금지) ──
       ★★★ (코드리뷰 P1) 이 탭에 공고가 여럿(차수 재발행)이면 `camps`(GID 재매칭 + 활성 우선 +
       값 있는 공고까지 훑기)로 고른 공고와, 실제 이체 계산이 쓰는 `_loadCampaigns`(이름만 일치 +
       created_at 최신 하나)가 **다른 공고**를 고를 수 있다 — 그러면 "화면은 하나은행인데 이체
       파일은 케이뱅크"가 된다. 그래서 은행만은 `camps` 를 안 쓰고 **이체 계산이 실제로 쓰는 그
       공고를 그대로**(`payment.service.campaignForTab`) 가져와 같은 판정 함수로 고른다.
       순서 = 공고(사람이 정한 값) → 탭 설정 → 작업오더 물건비 자동판정(현금→하나 · 계산서/수수료→케이뱅크).
       ★ `auto` 는 **사람이 정하지 않았다**는 뜻이라 화면이 그 사실을 말한다(조용한 추정 금지). */
    const { normalizeBankChoice, bankFromGoodsCostType, BANK_LABEL, campaignForTab } = require('./payment.service');
    const txCamp = await campaignForTab(sheetId, tabName).catch(() => null);
    const campBank = normalizeBankChoice(txCamp && txCamp.transferBank);
    const tabBank  = normalizeBankChoice(meta.tabTransferBank);
    const autoBank = bankFromGoodsCostType((wo && wo.goodsCostType) || '');
    const transferBank = campBank || tabBank || autoBank || null;
    const bankSource = campBank ? 'campaign' : tabBank ? 'tab' : transferBank ? 'auto' : null;

    const { resolveReviewType, reviewTypeLabel, normalizeReviewType, parseWorkOrderReviewType,
            isFreeChoiceReviewType, FREE_CHOICE_REVIEW_LABEL } = require('../utils/reviewType');
    const { normalizeReviewTypeMix } = require('../utils/reviewTypeMix');
    const { hasCashReceiptSlot } = require('../utils/captureSlots');

    /* ── 리뷰타입: 판정(행)과 표기(작업)를 분리한다 ─────────────────────────────
       ★★ `resolveReviewType` 은 **혼합이면 null** 을 돌려준다(완화 금지) — 어느 행이 포토이고
         어느 행이 텍스트인지는 시트 작업옵션 칸만 답할 수 있어서다. 그런데 작업 조건 카드는
         **행이 아니라 작업**을 설명하는 자리라, 그 null 을 그대로 그리면 공고에 `혼합(포토 200 ·
         텍스트 100)` 을 저장해 둔 작업이 `[미설정]` 로 보인다(2026-08-23 신고).
       ★ 그래서 **판정값(`reviewType`)은 그대로 null 로 두고** 표기용 라벨·조합만 따로 싣는다
         — 검수·캡처 슬롯이 보는 값은 한 글자도 바뀌지 않는다.
       ★ 조합 우선순위 = **공고 저장값(106) → 연결 작업오더 문자열**(혼합 조합 프리필과 같은 순서).
         작업오더 조합은 `parseWorkOrderReviewType` 단일 출처로 읽는다(사본 0).
       ★ 혼합인데 조합을 모르면 **0 으로 꾸미지 않고** 빈 배열로 둔다 — 화면이 "유형별 인원
         미입력"이라고 말한다. */
    const rtKey = resolveReviewType({ campaignType: typeCamp && typeCamp.reviewType, tabReviewType: meta.reviewType });
    const rtMixed = !rtKey && (normalizeReviewType(typeCamp && typeCamp.reviewType) === 'mixed'
                            || normalizeReviewType(meta.reviewType) === 'mixed');
    /* ★ `자율리뷰`도 "미설정"이 아니다 — 사람이 적어 둔 값이다(2026-08-23 사용자 확정).
       판정(rtKey)은 여전히 null 이고 라벨만 적힌 그대로 말한다. ★ 혼합과 **배타**. */
    const rtFree = !rtKey && !rtMixed
      && (isFreeChoiceReviewType(typeCamp && typeCamp.reviewType) || isFreeChoiceReviewType(meta.reviewType));
    let rtMix = [];
    if (rtMixed) {
      rtMix = (normalizeReviewTypeMix(typeCamp && typeCamp.reviewTypeMix).mix || []);
      if (!rtMix.length && wo) {
        const p = parseWorkOrderReviewType(wo.reviewType);
        if (p.mixed) rtMix = Object.keys(p.counts).filter(k => p.counts[k] > 0)
                                    .map(k => ({ type: k, quantity: p.counts[k] }));
      }
    }

    let cashReceipt = null;
    try { cashReceipt = hasCashReceiptSlot(meta.captureSlots, meta.incomeType); } catch (_) { cashReceipt = null; }

    /* 옵션별 결제금액(사용자 확정 2026-08-20 시안 v2) — "옵션이 있는 작업" 판정은
       worktableOptionColumn 규율과 같은 축: **살아있는(닫히지 않은) 공고 옵션**이 먼저고,
       공고 옵션이 2종 미만이면 작업오더의 구조화 옵션으로 폴백한다. 2종 미만이면 빈 배열
       = 옵션 없는 작업(1건당 결제금액 한 줄 표기). 표시 전용 — 정원·홀드 판정 무접촉. */
    let options = [];
    if (c) {
      const { rows: opts } = await db.query(
        `SELECT opt_key AS label, pay_amount AS pay, recruit_total AS count
           FROM campaign_options WHERE campaign_id = $1 AND status <> 'closed' ORDER BY id`,
        [c.id]).catch(() => ({ rows: [] }));
      options = opts.map(o => ({ label: String(o.label || '').trim(), pay: num(o.pay), count: num(o.count) }))
                    .filter(o => o.label);
    }
    if (options.length < 2 && wo) options = _condWoOptions(wo.productOptionsJson);
    if (options.length < 2) options = [];

    /* 적용 정원(공고 우선 · 0이면 발주) — 상태엔진과 **같은 함수**를 태운다(사본 0). */
    const { displayRecruitTotal } = require('./linkedRecruitQuota.service');
    const _rt = displayRecruitTotal(c && c.recruitTotal, wo && wo.recruitCount);
    const _dl = displayRecruitTotal(c && c.dailyLimit, wo && wo.dailyCount);
    const campQuota = {
      recruitTotal: _rt.total, dailyLimit: _dl.total,
      totalSource: _rt.source, dailySource: _dl.source,
    };

    return {
      workboardDisplayName: String(meta.workboardDisplayName || '').trim() || null,
      productName: (wo && wo.productOption) || meta.campaignName || '',
      /* ★★ 총건수·일건수 = **정원 판정과 같은 값**(사용자 확정 2026-08-21) — 공고 값이 있으면
         그 값, 0(미설정)이면 발주서 값이 **실제 정원으로 적용**된다(campaignState.effectiveQuota).
         종전에는 `num(0) != null` 이 참이라 공고 0 을 그대로 실어 `총건수 0 건`으로 그렸고,
         같은 화면의 참여자 게이지는 발주 총건수(/100)를 봐 **한 화면에 두 숫자**가 있었다.
         ★ 규칙 사본을 만들지 않는다 — `displayRecruitTotal`(공고>0 이면 공고, 아니면 발주) 하나. */
      recruitTotal: campQuota.recruitTotal || null,
      dailyLimit:   campQuota.dailyLimit   || null,
      /* 출처·발주 원값 — 화면이 "발주 기준"이라고 말하고, 일건수 칸이 발주값과 공고 오늘값을
         나란히 적을 수 있게 한다(조용한 대체 금지). */
      recruitTotalSource: campQuota.totalSource,
      dailyLimitSource:   campQuota.dailySource,
      orderRecruitCount: num(wo && wo.recruitCount),
      orderDailyCount:   num(wo && wo.dailyCount),
      // 공고에 명시된 채널만(직접입력은 custom). 없으면 null → 화면이 상품 URL 로 판정한다.
      channel: (c && (String(c.channel || '').trim() === '직접입력' ? c.channelCustom : c.channel)) || null,
      productUrl: (wo && wo.productUrl) || null,
      inflowType: (wo && wo.inflowType) || null,
      /* 담당 2인(사용자 확정 2026-08-24) — 「담당  AE팀 황운하 / 관리자 만두」.
         ★ 앞 = 그 업체를 맡은 **AE**(`created_by` = 인트라넷에서 오더를 낸 사람).
           뒤 = 이 작업의 모집·공고를 맡은 **리뷰웹 관리자**(`manager_name`).
           ⚠ `manager_name` 은 코드 라벨이 "담당AE" 지만 **실제 값은 리뷰웹 관리자**다
             (본섭 116건 실측: 박세희·박은비·랜덤). 라벨이 틀린 것이지 값이 틀린 게 아니다.
         ★★ 관리자는 **닉네임**으로 적는다 — 치환은 `adminNickname.service` **단일 출처**
           (1:1문의가 쓰는 그 맵. 사본을 만들면 두 화면의 이름이 갈린다).
           `adminNick` = 닉네임(없으면 null) · `adminRaw` = 실명(**내부 전용** — 광고주 렌즈가 폐기).
           화면은 `adminNick || adminRaw` 한 줄이면 되고, 그러면 **내부는 닉네임||실명 /
           업체는 닉네임||'관리자'** 두 규율이 카드 한 벌에서 동시에 성립한다.
         ★ 조회 실패는 빈 맵(fail-soft) — 업체 화면은 `관리자` 로 떨어지고 실명은 여전히 안 나간다. */
      manager: await (async () => {
        const ae = String((wo && wo.createdBy) || '').trim() || null;
        const raw = String((wo && wo.managerName) || '').trim() || null;
        let nick = null;
        if (raw) {
          try {
            const { getNicknameMap } = require('./adminNickname.service');
            const map = await getNicknameMap();
            nick = (map && map[raw]) || null;
          } catch (_) { nick = null; }
        }
        return { ae, adminNick: nick, adminRaw: raw };
      })(),
      /* 구매시간(사용자 확정 2026-08-23) — **실제로 참여를 여닫는 값은 공고 시간창**이다
         (`computeCampaignState` 가 그것을 본다). 작업오더 `purchase_time` 은 그 발행 프리필
         원본일 뿐이라, 오더 텍스트만 그리면 "카드는 0~15시인데 실제로는 다른 시간에 열리는"
         상태가 된다 → 총건수·일건수와 **같은 규율**로 공고 우선·발주 폴백을 화면에 넘긴다.
         ★ 시간창 개념은 **참여형 공고에만** 있다(레거시는 없음) — 그래서 참여형일 때만 싣는다.
         ★ 참여형인데 양쪽이 비면 그것이 곧 **자율주문**(종일 open)이다 — 빈 값이 아니라 상태다. */
      purchaseWindow: (c && c.participationMode && c.windowStart && c.windowEnd)
        ? { start: c.windowStart, end: c.windowEnd } : null,
      purchaseAllDay: !!(c && c.participationMode && !c.windowStart && !c.windowEnd),
      orderPurchaseTime: (wo && String(wo.purchaseTime || '').trim()) || null,
      inflowKeyword: (wo && wo.inflowKeyword) || null,
      multiAccount: c ? { enabled: !!c.multiAccount, dailyLimit: num(c.multiDailyLimit) } : null,
      cashReceipt,
      /* [현금영수증] 설정 팝업 재료 — **판정은 서버 단일 출처가 이미 했다**(cashReceipt).
         여기 둘은 "무엇을 고치는지" 화면이 설명하기 위한 것:
         · incomeType  = 지금 진행방식 원문(팝업 프리필)
         · slotsPinned = 캡처 칸이 직접 설정된 탭인가 — 그러면 진행방식을 바꿔도 판정이 안 바뀐다
           (capture_slots 명시가 최우선). 화면이 그 사실을 말해야 "고쳤는데 그대로"가 안 된다. */
      incomeType: meta.incomeType || '',
      slotsPinned: Array.isArray(meta.captureSlots) && meta.captureSlots.filter(x => x && x.key).length > 0,
      /* 1건당 상품 결제금액(사용자 확정 2026-08-20) — 진행 현황의 '결제금액'은 활성 주문 행의
         **합계**라 성질이 다르다(중복 표기가 아니다). 출처는 작업오더 한 곳. */
      payAmount: num(wo && wo.payAmount),
      /* 옵션 2종 이상일 때만 채워진다 — 총결제금액은 싣지 않는다(자동계산은 화면 표시일 뿐
         저장값이 아니고, 여기 실으면 "편집할 수 있는 값"처럼 보인다). */
      options,
      reviewFee: feeInfo.fee, feeSource,
      /* ★ 입금명 순서 = **공고 → 탭** — 입금관리(payment.service `campMemo || tabMemo`)와 같은
         순서라야 한다. 탭을 앞세우면 "공고를 만들었는데 카드가 옛 탭 값을 계속 보여주는" 상태가
         되고, 정작 이체 서식에는 공고 값이 찍혀 화면과 파일이 갈린다(사용자 확정 2026-08-20:
         공고를 나중에 만들면 공고 설정값이 우선한다). */
      depositName: ((memoCamp && memoCamp.transferMemo) || meta.depositName || '') || null,
      /* 이체은행 — 값·라벨·출처를 함께 싣는다(화면이 판정을 다시 하지 않게).
         null = 정할 근거가 없음 = [미설정](작업오더 물건비도 비어 자동판정이 안 된 경우). */
      transferBank, bankSource,
      transferBankLabel: transferBank ? (BANK_LABEL[transferBank] || transferBank) : null,
      /* 판정값 — 혼합은 행 단위로 정할 수 없어 null(검수·슬롯이 보는 값, 규율 불변). */
      reviewType: rtKey,
      /* 표기값 — 혼합이면 '혼합' + 조합(아래 reviewTypeMix). 둘 다 없으면 null = [미설정]. */
      reviewTypeLabel: rtKey ? (reviewTypeLabel(rtKey) || rtKey)
        : rtMixed ? (reviewTypeLabel('mixed') || '혼합')
        : rtFree ? FREE_CHOICE_REVIEW_LABEL : null,
      reviewTypeMixed: rtMixed,
      reviewTypeMix: rtMixed ? rtMix.map(m => ({ type: m.type, label: reviewTypeLabel(m.type) || m.type, quantity: m.quantity })) : null,
      campaignId: c ? c.id : null,
      campaignCount: camps.length,
      workOrderId: (wo && wo.id) || null,   // [미설정] → 작업오더 수정 창구를 열 때만 쓴다
    };
  } catch (e) {
    logger.warn(`[trackB] tabConditionSummary 실패(작업 조건 축약 표시): ${e.message}`);
    return null;   // ★ null = "못 불러옴" — 화면이 종전 4줄로 떨어지고 사유를 말한다
  }
}

async function workdeskTab({ sheetId, tabName, tabGid, role = 'master', advertiserId = null, brandId = null, staffName = null, allowAllStaff = false, allowAllWorkdesk = false } = {}) {
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
    `SELECT tc.campaign_name AS "campaignName", tc.display_name AS "displayName", tc.workboard_display_name AS "workboardDisplayName", tc.manager, tc.review_type AS "reviewType",
            tc.delivery_type AS "deliveryType", tc.income_type AS "incomeType",
            tc.source_of_truth AS "sourceOfTruth", COALESCE(tc.sheetless, FALSE) AS sheetless,
            tc.tab_gid AS "tabGid", tc.capture_slots AS "captureSlots",
            tc.deposit_name AS "depositName", tc.review_fee AS "tabReviewFee",
            tc.transfer_bank AS "tabTransferBank"
       FROM tab_configs tc WHERE tc.sheet_id=$1 AND tc.tab_name=$2 LIMIT 1`, [sheetId, tabName]);
  const { rows: wo } = await db.query(
    `SELECT id, title, product_option AS "productOption", product_options_json AS "productOptionsJson",
            pay_amount AS "payAmount", review_fee AS "reviewFee", daily_count AS "dailyCount", daily_count_text AS "dailyCountText",
            purchase_time AS "purchaseTime", inflow_keyword AS "inflowKeyword", inflow_type AS "inflowType",
            inflow_guide AS "inflowGuide", delivery_type AS "deliveryType", courier_proxy AS "courierProxy",
            review_type AS "reviewType", recruit_count AS "recruitCount", review_guide AS "reviewGuide",
            special_notes AS "specialNotes", product_url AS "productUrl", start_date AS "startDate",
            manager_name AS "managerName", created_by AS "createdBy", status,
            goods_cost_type AS "goodsCostType"
       FROM work_orders
      WHERE deleted_at IS NULL AND ($3::text IS NOT NULL AND id=$3 OR (linked_tab_sheet_id=$1 AND linked_tab_name=$2))
      ORDER BY ($3::text IS NOT NULL AND id=$3) DESC, created_at DESC LIMIT 1`,
    [sheetId, tabName, await _effectiveLinkedWorkOrderId(db, sheetId, tabName)]).catch(() => ({ rows: [] }));
  if (wo[0]) wo[0].options = _parseWoOptions(wo[0].productOptionsJson);
  // 명단(활성) — 앵커 도출에 필요한 컬럼 포함
  const { rows: roster } = await db.query(
    `WITH normal_submissions AS (
        SELECT ca.id, ca.phone8, ca.submitted_at,
               ROW_NUMBER() OVER (PARTITION BY ca.phone8 ORDER BY ca.submitted_at, ca.id) AS credit_no
          FROM campaign_applications ca JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
         WHERE rc.participation_mode IS TRUE
           AND COALESCE(ca.is_popular_snapshot, rc.is_popular) IS NOT TRUE
           AND ca.status = 'submitted'
      ), popular_uses AS (
        SELECT ca.id, ca.phone8, ca.applied_at,
               ROW_NUMBER() OVER (PARTITION BY ca.phone8 ORDER BY ca.applied_at, ca.id) AS credit_no
          FROM campaign_applications ca JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
         WHERE rc.participation_mode IS TRUE
           AND COALESCE(ca.is_popular_snapshot, rc.is_popular) IS TRUE
           AND (ca.status = 'submitted' OR (ca.status = 'applied' AND ca.expires_at > NOW()))
      )
     SELECT cp.id, cp.seq, cp.reviewer_name AS name, cp.recipient_name AS recipient, cp.phone8,
            cp.round, cp.option_text AS option, cp.product_name AS product,
            cp.is_submitted AS submitted, cp.is_paid AS paid, cp.source,
            cp.order_submission_id, cp.identity_key, cp.row_json, cp.submit_col, cp.submit_col2,
            EXISTS (SELECT 1 FROM order_submissions os
                      JOIN normal_submissions ns ON ns.id = os.campaign_application_id
                      JOIN popular_uses pu ON pu.phone8 = ns.phone8 AND pu.credit_no = ns.credit_no
                                           AND ns.submitted_at <= pu.applied_at
                     WHERE os.id = cp.order_submission_id AND os.deleted_at IS NULL) AS "popularPurpose"
       FROM campaign_participants cp
      WHERE cp.sheet_id=$1 AND cp.tab_name=$2 AND cp.deleted_at IS NULL AND cp.active = TRUE
        AND cp.held_at IS NULL
      ORDER BY cp.seq`, [sheetId, tabName]);
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
  // 업체 화면에는 주문별 원본 대신 집행 합계 계산에 필요한 결제금액만 읽는다. 이 합계는 작업 조건에
  // 이미 노출된 총 결제금액과 같은 작업 단위 정보이며, 주문자·수령인 등 PII는 절대 조회하지 않는다.
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
  } else if (role === 'advertiser') {
    const orderIds = [...new Set(roster.map(r => r.order_submission_id).filter(Boolean).map(String))];
    if (orderIds.length) {
      const { rows: ords } = await db.query(
        `SELECT id, price FROM order_submissions WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [orderIds]).catch(() => ({ rows: [] }));
      ordMap = new Map(ords.map(o => [String(o.id), { price: o.price }]));
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
      // 광고주: 차단 목록의 다섯 신원·정산 정보만 제외하고 원본 컬럼을 유지한다.
      advHeaders = _advertiserColumns(_advertiserHeaderCandidates(raw, roster, advEditedHeaders));
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
  const out = [];
  let ambiguousCount = 0;
  /* ★★ 채워진 줄 수 — [진행 현황] 참여자 게이지의 분자(사용자 확정 2026-08-20).
     종전 게이지는 `out.length`(= 줄 수)를 세어, 작업표 생성 때 미리 깔아 둔 **빈 슬롯**까지
     사람으로 계산했다 → 6명만 들어온 200줄 작업이 `참여자 200/200 · 100%` 로 보였다.
     ★ 판정은 `utils/rowNumbering.isFilledRow` 단일 출처 — 번호 재부여·짝 빈 줄 정리가 쓰는
       SQL(`filledSql`)과 같은 기준이라 "게이지와 정리가 다른 줄을 빈 줄로 본다" 가 불가능하다.
     ★ **마스킹 전**에 센다(광고주 렌즈를 거친 뒤 세면 빈 칸도 마스킹 문자열이 되어 전 줄이 뒤집힌다).
     ★ 카운트는 마스킹 앞에서 한다(참여횟수 배지와 같은 자리). */
  let filledCount = 0;
  // 무시트 작업표에서 수동으로 만든 참여 줄은 submit_col을 들고 있지 않는다. 그 경우에도
  // 실제 표가 쓰는 탭 단위 상태 헤더를 읽어야 "셀에는 O가 있는데 카드 0건"이 되지 않는다.
  let tabSubmitHeader = String((roster.find(r => String(r.submit_col || '').trim()) || {}).submit_col || '').trim();
  if (!tabSubmitHeader) {
    try {
      tabSubmitHeader = String(await require('./sheetlessStatus.service')
        .statusHeaderForTab(db, { sheetId, tabName, kind: 'submit' }) || '').trim();
    } catch (_) { /* 헤더를 모르면 값 없는 것으로 처리한다 — 플래그로 추측하지 않는다. */ }
  }
  /*
   * 진행 현황의 "제출완료"는 제출 상태 플래그가 아니라, 사용자가 작업표에서 실제로
   * 확인하는 리뷰제출 칸의 값으로 센다. 플래그/인덱스는 재투영 전에는 뒤처질 수 있어
   * 표에 707건이 보여도 카드가 535건에 머무는 식의 불일치가 난다.
   *
   * `pick`을 통해 셀 편집 오버레이도 함께 반영한다. 따라서 카드와 현재 표의 보이는
   * 리뷰제출 열은 같은 원본을 보며, 제출 상태 플래그는 기존 검수·정산 흐름에만 남긴다.
   */
  let reviewSubmitCellCount = 0;
  // 진행 현황의 금액도 "제출완료"와 정확히 같은 작업표 리뷰제출 칸을 기준으로 한다.
  // is_submitted 플래그만 보면 재투영 전 카드 건수와 표의 제출 칸이 다시 갈릴 수 있다.
  let executionAmount = 0;
  const executionOrderIds = new Set();
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
      //   같은 필드는 **현재 앵커 값이 이긴다**(더 나중·더 구체적인 근거).
      const rowKey = _akey('manual', _rowAnchorId(r));
      if (!ambiguous && anchor.value !== _rowAnchorId(r) && editMap.has(rowKey)) {
        ov = { ...editMap.get(rowKey), ...ov }; consumed.add(rowKey);
      }
    }
    const pick = (f, phys) => (Object.prototype.hasOwnProperty.call(ov, f) ? ov[f] : phys);
    const order = r.order_submission_id ? (ordMap.get(String(r.order_submission_id)) || null) : null;
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
      // 운영 목적 분류는 내부 작업보드 로그에서만 보인다. 광고주 렌즈에는 노출하지 않는다.
      popularPurpose: showEdits && r.popularPurpose === true,
    };
    /* ★ 행마다 같은 판정을 실어 보낸다 — 제출물 미리보기 목록이 "채워진 줄"을 화면에서 다시
       세지 않게(사본 0). 게이지 분자(`filledCount`)와 **같은 호출**이라 갈릴 수가 없다. */
    syn.filled = _isFilledRow(syn);
    if (syn.filled) filledCount++;
    const submitHeader = String(r.submit_col || tabSubmitHeader || '').trim();
    const submitCellValue = submitHeader
      ? pick('col:' + submitHeader, (r.row_json && r.row_json[submitHeader]))
      : '';
    const reviewSubmitted = !!String(submitCellValue == null ? '' : submitCellValue).trim();
    if (reviewSubmitted) {
      reviewSubmitCellCount++;
      /* 주문이 제출된 행만 집행으로 본다. 원장 금액이 비어 있는 레거시 행은 실제 작업표의
         결제금액 칸(오버레이 포함)을 같은 공용 판정으로 읽는다. 같은 주문이 중복 행에 연결된
         과거 작업표는 한 번만 더한다 — 실제 구매가 복제돼 누적집행이 부풀면 안 된다. */
      const orderId = r.order_submission_id ? String(r.order_submission_id) : '';
      if (!orderId || !executionOrderIds.has(orderId)) {
        if (orderId) executionOrderIds.add(orderId);
        const amountRow = { ...((r.row_json && typeof r.row_json === 'object') ? r.row_json : {}) };
        for (const [field, value] of Object.entries(ov)) {
          if (field.indexOf('col:') === 0) amountRow[field.slice(4)] = value;
        }
        const orderPrice = Number(String(order && order.price || '').replace(/[^0-9]/g, '')) || 0;
        executionAmount += orderPrice || extractAmountNumber(amountRow);
      }
    }
    /* ★ 작업보드 표의 「번호」 칸 값 — 미리보기 팝업 목록이 쓴다. `seq`(시트 실제 행 번호)와는
       다른 값이라(원래 1 차이) 화면이 둘을 헷갈리면 안 된다. 칸 이름 판정은 `numberColumnKey`
       단일 출처이고, 담당자가 셀을 고쳤으면 그 값이 이긴다(표와 같게). 칸이 없으면 빈 값. */
    const _nk = _numberColumnKey(r.row_json);
    syn.boardNo = _nk ? String(pick('col:' + _nk, (r.row_json || {})[_nk]) ?? '').trim() : '';
    const _vp8 = String(syn.phone8 == null ? '' : syn.phone8).trim();
    if (_vp8) { const n = (visitSeen.get(_vp8) || 0) + 1; visitSeen.set(_vp8, n); syn.visitNo = n; }
    // 광고주(외부)는 phone8 + 이름·수취인(PII)까지 마스킹. AE/관리자(내부)는 전체.
    if (maskPII) { syn.phone8 = _mask(syn.phone8); syn.name = _maskName(syn.name); syn.recipient = _maskName(syn.recipient); }
    if (showEdits) {
      syn.anchorType = anchor ? anchor.type : null;
      syn.editable = editable; syn.ambiguous = ambiguous;
      // 옛 '_hidden' 레코드(폐기된 필드)가 남아 있어도 편집 배지로 세지 않는다.
      syn.editedFields = Object.keys(ov).filter(f => f !== '_hidden');
      // 실 데이터 전량 투영: 시트 행 전체(row_json) + 제출 구매양식 원본(order). 상세 펼침용.
      syn.rowJson = (r.row_json && typeof r.row_json === 'object') ? r.row_json : null;
      syn.order = order;
      // 시트 컬럼 편집(col:<헤더>) 오버레이 → 그리드 셀 합성용 {헤더: 값}. 앵커 게이트(ambiguous면 ov={}이라 자동 미적용).
      const ce = {}; for (const k in ov) { if (k.indexOf('col:') === 0) ce[k.slice(4)] = ov[k]; }
      syn.cellEdits = ce;
      // 커스텀 열 값 + 셀 배경색(migration 080) — 같은 앵커키로 합성. ★ ambiguous(중복 identity)면 미적용(ov와 동일 게이트) —
      //   그렇지 않으면 서로 다른 물리행 여러 개가 같은 identity 앵커를 공유해 한 사람의 메모/색이 남에게도 보인다.
      const ak = (anchor && !ambiguous) ? _akey(anchor.type, anchor.value) : null;
      syn.customValues = (ak && customValMap.get(ak)) || {};
      syn.cellColors = (ak && cellColorMap.get(ak)) || {};
    } else if (role === 'advertiser' && advHeaders) {
      // 광고주: 허용된 원본 컬럼 전체값. 차단 컬럼(참여자·연락처·은행·계좌번호·예금주)은 rowJson에 안 담음.
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
  /* ── 총건수 초과 표시 ────────────────────────────────────────────────────────
     ★★ 정원(총건수)보다 많은 사람이 실제로 들어온 경우(외부모집 수동제출·지각 확정 등)
        **줄을 강제로 정원에 맞추지 않고** 초과된 줄을 식별해 화면이 말하게 한다(사용자 확정 2026-08-24).
        줄을 잘라 맞추면 이미 구매한 사람이 표에서 사라진다 — 사실을 감추는 쪽이 더 나쁘다.
     ★★ cap 판정은 작업 조건 카드와 **같은 값**(`tabConditionSummary.recruitTotal`
        = `linkedRecruitQuota.displayRecruitTotal` 단일 출처). 여기서 다시 세면 "카드는 500인데
        표는 다른 기준"으로 갈린다. 게이지 분모도 이 값을 쓴다(`counts.cap`).
     ★ **무시트 작업표만** — 시트 기반 탭의 행 수는 시트가 정하고 그 총건수는 공고 값과 정상적으로
       다를 수 있어(과거 데이터) 빨갛게 칠하면 오탐이 된다(홈 「인원/제출」 ⚠ 와 같은 규율).
     ★ **채워진 줄만** 센다(빈 슬롯은 사람이 아니다) · 화면과 **같은 정렬**(번호 순) 뒤에 센다.
     ★ cap 을 모르면(공고 미연결·조회 실패) 아무 표시도 하지 않는다(0 위장 금지).
     ★ 광고주에게도 보인다(사용자 확정) — 다만 `condition` 자체는 종전대로 내부 전용이다. */
  const _cond = await tabConditionSummary(db, { sheetId, tabName, meta: meta[0] || {}, wo: wo[0] || null });
  /* 총 모집완료 표기는 시트/무시트 모두 작업 조건의 총건수를 쓴다. 반면 초과행 칠하기는
     시트 기반 과거 표에 오탐을 내지 않도록 종전처럼 무시트에만 한정한다. */
  const _recruitCap = (_cond && Number(_cond.recruitTotal) > 0) ? Number(_cond.recruitTotal) : null;
  const _cap = (meta[0] && meta[0].sheetless) ? _recruitCap : null;
  /* 모집일 미설정 수 = 작업 조건의 총 모집건수 - 유효한 날짜 배정량.
     무시트 작업표는 달력(campaign_daily_plans)이 날짜별 정원의 진실원본이므로 합계를 그대로
     비교할 수 있다. 단, 과거에 완료된 무시트 작업은 조절한 날만 계획 테이블에 남고 실제
     날짜 배정은 작업표 행에만 남아 있을 수 있다. 이때는 날짜별로 작업표의 실제 배정과 저장
     계획 중 큰 값을 합산한다. 같은 날은 이중 계산하지 않고, 과거 완료분과 미래 계획분이 서로
     다른 날이면 모두 반영한다. 시트 기반은 이 테이블이 "조절한 날"만 보관하고 나머지는 시트 일정이
     정하므로, 합산하면 정상 일정까지 미설정으로 오인한다 — 그 경우에는 표시하지 않는다.
     저장 시 총량 초과는 막혀 있으므로 화면에는 부족분만 낸다. 계획 테이블이 아직 없는 구버전
     DB/조회 실패는 0으로 위장하지 않고 필드를 생략해 경고 오탐을 막는다. */
  let scheduleUnassigned;
  if (showEdits && meta[0] && meta[0].sheetless && _cond && _cond.campaignId && _recruitCap) {
    try {
      const { rows: plans } = await db.query(
        `SELECT to_char(plan_date,'YYYY-MM-DD') AS date, planned_count AS count
           FROM campaign_daily_plans WHERE campaign_id=$1`, [_cond.campaignId]);
      const plannedByDate = new Map();
      for (const plan of plans) {
        const date = String(plan && plan.date || '').slice(0, 10);
        const count = Number(plan && plan.count);
        if (date && Number.isFinite(count)) plannedByDate.set(date, Math.max(0, count));
      }
      const actualByDate = _filledScheduledRowsByDate(out, headers);
      let scheduled = 0;
      if (actualByDate == null) {
        for (const count of plannedByDate.values()) scheduled += count;
      } else {
        const dates = new Set([...plannedByDate.keys(), ...actualByDate.keys()]);
        for (const date of dates) scheduled += Math.max(plannedByDate.get(date) || 0, actualByDate.get(date) || 0);
      }
      scheduleUnassigned = Math.max(0, _recruitCap - scheduled);
    } catch (e) {
      logger.warn(`[trackB] 모집일 계획 합계 조회 실패: ${e.message}`);
    }
  }
  let overCount = 0;
  if (_cap) {
    let seen = 0;
    for (const r of out) { if (!r.filled) continue; seen++; if (seen > _cap) { r.over = true; overCount++; } }
  }
  // orphan: 활성 오버레이 중 어떤 활성 행에도 안 붙은 것(카운트/타입만 — PII·원장ID 비노출)
  let orphanCount = 0; const orphanByType = {};
  for (const [k] of editMap) {
    if (consumed.has(k)) continue;
    orphanCount++; const t = k.split('\t')[0]; orphanByType[t] = (orphanByType[t] || 0) + 1;
  }
  const counts = {
    total: out.length,
    /* 채워진 줄(사람이 들어온 줄) — 참여자 게이지의 분자. `total`(줄 수)과의 차이 = 빈 슬롯. */
    filled: filledCount,
    /* 실제 작업표의 리뷰제출 칸에 값이 있는 행 수. `is_submitted`는 이 카드 기준이 아니다. */
    submitted: reviewSubmitCellCount,
    paid: out.filter(r => r.paid).length,
    // 하위 호환: 주문 행 전체의 결제금액 합계(주문 삭제 미리보기 등 기존 소비처가 사용).
    paymentAmount: showEdits ? out.reduce((sum, r) => sum + (Number(String(r.order && r.order.price || '').replace(/[^0-9]/g, '')) || 0), 0) : undefined,
    // 누적집행 = 실제 작업표의 리뷰제출 칸이 채워진 주문의 결제금액 합계.
    // 업체에는 주문 원본이 아니라 이 작업 단위 합계만 보낸다.
    executionAmount,
    // 잔여집행의 기준은 작업오더에 저장된 총 결제금액이다. 총액이 없으면 화면도 금액을 지어내지 않는다.
    executionTotalAmount: _cond && _cond.payAmount != null ? Number(_cond.payAmount) : undefined,
    remainingExecutionAmount: _cond && _cond.payAmount != null
      ? Math.max(0, Number(_cond.payAmount) - executionAmount) : undefined,
    edited: showEdits ? out.filter(r => (r.editedFields || []).length).length : undefined,
    ambiguous: ambiguousCount,
    /* 표에서 분리한 줄(129) — 표에는 없지만 데이터는 그대로다. 숫자를 지우면 "사라진 줄" 이 된다. */
    held: heldCount, heldUnavailable: heldUnavailable || undefined,
    /* 총건수(정원) — 게이지 분모의 단일 출처. 모르면 싣지 않는다(화면이 종전 폴백으로 접는다). */
    cap: _cap || undefined,
    /* 총 모집완료 표기용 기준. 시트 기반은 초과행 색칠과 달리 이 값을 사용해야 한다. */
    completionCap: _recruitCap || undefined,
    /* 총건수 대비 저장된 모집일 계획 부족분. 0이면 화면에 경고를 만들지 않는다. */
    scheduleUnassigned: scheduleUnassigned > 0 ? scheduleUnassigned : undefined,
    /* 정원을 넘겨 채워진 줄 수. cap 을 모르면 undefined(0 과 구분). */
    over: _cap ? overCount : undefined,
  };
  const res = { role, maskPII, meta: meta[0] || {}, detail: wo[0] || null, counts, roster: out,
    sourceOfTruth: (meta[0] && meta[0].sourceOfTruth) || 'sheet' };   // 진실원천(cutover 상태) 표시용
  if (showEdits) {
    res.orphanEdits = { count: orphanCount, byType: orphanByType };
    res.headers = headers || []; res.customColumns = customCols;
    /* ★ 그 탭의 상태 칸(리뷰제출·입금) 헤더명 — 화면 잠금·[📎 수동 리뷰제출] 판정의 **단일 출처**.
       화면이 이름 목록 사본으로 판정하면 헤더가 그냥 `리뷰` 인 탭에서 서버(제출 시각을 그 칸에 쓴다)와
       갈려 "직접 타이핑은 되는데 수동 제출 메뉴는 없는" 상태가 된다(2026-08-21 실측).
       ★ 값이 없으면(구버전 데이터·미감지) 싣지 않는다 — 화면은 종전 이름 목록으로 폴백한다. */
    const _scS = roster.find(r => r.submit_col) || {}, _scP = roster.find(r => r.submit_col2) || {};
    if (_scS.submit_col || _scP.submit_col2) {
      res.statusCols = { submit: _scS.submit_col || null, paid: _scP.submit_col2 || null };
    }
    /* ★ 그 탭의 '주문자'·'수취인' 칸 헤더명 — [이 셀 편집]이 실제 반영(원장·리뷰내역까지)으로
       가는 판정의 단일 출처(2026-08-24). 판정은 관리자 주문 편집이 이미 쓰는
       `orderLedger._fieldToCol`(사본 금지) — 여기서 새 규칙을 만들면 "주문 편집은 이 칸에 쓰는데
       리뷰내역 반영은 저 칸을 찾는" 드리프트가 생긴다. 값이 없으면(구버전·미감지) 싣지 않는다. */
    try {
      const { _fieldToCol } = require('./orderLedger.service');
      const ordererIdx = _fieldToCol(headers || [], 'orderer');
      const recipientIdx = _fieldToCol(headers || [], 'recipient');
      if (ordererIdx >= 0 || recipientIdx >= 0) {
        res.identityCols = {
          orderer: ordererIdx >= 0 ? headers[ordererIdx] : null,
          recipient: recipientIdx >= 0 ? headers[recipientIdx] : null,
        };
      }
    } catch (_) { /* fail-soft — 못 구해도 화면은 종전 오버레이 편집으로 접는다 */ }
    /* ★ 작업 조건 10항목 — **내부 화면 전용**(리뷰비·입금명은 광고주에게 나갈 값이 아니다).
       fail-soft: 실패하면 필드를 싣지 않고, 화면이 종전 4줄로 떨어진다(0·빈값 위장 금지). */
    res.condition = _cond;   // ★ 위에서 이미 한 번 구했다(호출 2회 금지 — cap 과 값이 갈릴 수 없다)
    /* 「일정」 — 표(정렬된 `out`)의 구매일자에서 파생. 못 읽으면 null 로 두고 화면이 「—」로 말한다. */
    if (res.condition) res.condition.schedule = _condSchedule(out, headers);
    /* 136: 업체가 정한 브랜드 담당자 — 내부 화면에도 **함께** 보여 "브랜드사에게 무엇이 나가는지"
       를 확인시킨다(사용자 확정 D안). 소유 업체는 그 탭의 소유 판정 단일 출처에서 구한다. */
    if (res.condition) res.condition.manager = await _condBrandManagers(res.condition.manager, { sheetId, tabName });
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
    /* 작업 조건 카드 — 내부와 **같은 자리·같은 모양**(사용자 확정 2026-08-23). 단 렌즈를 거친다:
       리뷰비·입금명·다계정·현금영수증·내부 식별자는 응답에서 폐기한다(위 `_condAdvertiserLens`). */
    /* 136: 업체가 정한 브랜드 담당자를 먼저 붙이고 렌즈를 태운다 — 렌즈가 세션 종류로 갈린다:
       브랜드 링크 세션 = 내부 담당을 **대체**(값 없으면 담당 행 자체가 사라진다) /
       대행사 본세션 = 내부 담당과 **함께**(무엇이 나가는지 확인). */
    _cond.manager = await _condBrandManagers(_cond.manager, { sheetId, tabName, advertiserId });
    res.condition = _condAdvertiserLens(_cond, { brandSession: !!brandId });   // ★ 위에서 이미 구한 값(호출 2회 금지 — cap 과 갈릴 수 없다)
    if (res.condition) res.condition.schedule = _condSchedule(out, headers);
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
      `SELECT id, source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json, tab_gid,
              submit_col, submit_col2
         FROM campaign_participants
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
    const row = pr[0];
    // col:<헤더> 는 잠근 행 문맥으로 실재 컬럼 검증(그리드 표시와 동일 소스). 미실재면 거부(표시=수락 정합).
    if (isCol) {
      // 상태값은 시스템 전용이다. 화면 잠금과 별개로 일반 셀 편집 API도 차단한다.
      if (_statusToggleForRow(field.slice(4), row)) {
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
    // through-write(주문 원장 동기화) 재료 — 라우트가 커밋 뒤 별도로 사용한다(같은 tx 안에서 부르면
    // 데드락 위험이 있어 route.js 에서 분리했다). row_json 은 이 함수가 건드리지 않으므로 편집 전 값 그대로.
    const priorValue = (isCol && anchorType === 'order' && row.row_json && typeof row.row_json === 'object')
      ? row.row_json[field.slice(4)] : undefined;
    return {
      ok: true, editId: ins.rows[0].id, anchorType, field, linkedField, value: kind === 'bool' ? vBool : vText,
      orderSubmissionId: anchorType === 'order' ? anchorValue : null,
      priorValue,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (e && e.code === '23505') return { ok: false, error: 'concurrent_edit_conflict' };
    throw e;
  } finally { client.release(); }
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
    let revertedPrimary = await doRevert(field); n += revertedPrimary;
    // 앵커 승격분: 빈 자리였을 때 물리행 앵커로 저장된 값은 읽을 때 합성되므로, 되돌리기도 그쪽을 함께 지운다
    //   (안 지우면 ↩ 를 눌러도 옛 값이 그대로 다시 보인다).
    if (a.value !== String(pr[0].id)) {
      const { rowCount } = await client.query(
        `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
          WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type='manual' AND anchor_value=$4 AND field=$5 AND reverted_at IS NULL`,
        [String(by).slice(0, 100), sheetId, tabName, String(pr[0].id), field]);
      n += rowCount; revertedPrimary += rowCount;
    }
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
// 관리자 수동 리뷰제출: 기존 리뷰 업로드 원장에 연결된 이미지로만 제출을 확정한다.
function _manualReviewFileIds(fileIds) {
  if (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 5) return null;
  const ids = [...new Set(fileIds.map(v => String(v || '').trim()))];
  if (ids.length !== fileIds.length || ids.some(v => !/^[A-Za-z0-9_-]{10,200}$/.test(v))) return null;
  return ids;
}

/**
 * 관리자 수동 리뷰제출.
 *
 * ★★ `preflight:true` = **쓰기 0 사전 확인**(2026-08-21 실사고): 종전에는 화면이 캡처를 먼저
 *   업로드한 뒤 이 함수를 불렀는데, 여기서 거부되면 **드라이브에는 파일이 남고 제출만 실패**했다
 *   (신고 건: 재시도할 때마다 같은 줄에 캡처가 쌓였다). 이제 화면이 **붙여넣기 전에** 이 경로로
 *   물어보고, 통과했을 때만 업로드한다. 게이트는 실제 제출과 **같은 코드**를 지난다(사본 0) —
 *   따로 만들면 "확인은 통과인데 제출은 거부"가 된다.
 */
async function manualWorkdeskReviewSubmit({ sheetId, tabName, rowId, fileIds, by = 'admin', preflight = false } = {}) {
  if (!sheetId || !tabName || !rowId) throw new Error('manualWorkdeskReviewSubmit: 필수 인자 누락');
  const ids = preflight ? [] : _manualReviewFileIds(fileIds);
  if (!preflight && !ids) return { ok: false, error: 'invalid_review_files' };
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
    /* ★★ 수동·작업표로 추가한 줄은 `submit_col` 이 비어 있다 (2026-08-21 실측 `submit_column_missing`).
       그 칸은 **`review_index` 복제 경로(importTabFromIndex)에서만** 채워지고, `addParticipant`·
       `prepareRosterSlots`·`appendSlot` 등 사람이 만든 줄은 NULL 로 남는다 — 그런데 상태 칸은
       **줄이 아니라 탭 단위 속성**이라 그 줄만 제출을 못 하는 것은 사실과 다르다.
       → 그 탭의 감지값으로 보완한다. 해석기는 무시트 상태 기록과 **같은 것**(사본 0) — 각자 SQL 을
       쓰면 "장부는 A 칸에 쓰는데 수동 제출은 B 칸에 쓰는" 상태가 된다.
       ★ 잠근 tx 안이므로 pool 이 아니라 `client` 로 조회한다.
       ★ 그래도 못 찾으면 **거부**(fail-closed) — 그 작업표에 리뷰제출 열이 정말 없다는 뜻이고,
         추측해서 아무 칸에나 시각을 박으면 담당자가 적어 둔 값을 덮는다. */
    let submitCol = String(participant.submit_col || '').trim();
    if (!submitCol) {
      try {
        submitCol = String(await require('./sheetlessStatus.service')
          .statusHeaderForTab(client, { sheetId, tabName, kind: 'submit' }) || '').trim();
      } catch (_) { submitCol = ''; }
    }
    if (!submitCol) { await client.query('ROLLBACK'); return { ok: false, error: 'submit_column_missing' }; }

    const { rows: ir } = await client.query(
      `SELECT is_submitted FROM review_index
        WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 FOR UPDATE`,
      [sheetId, tabName, participant.seq]);
    if (!ir.length) { await client.query('ROLLBACK'); return { ok: false, error: 'review_history_missing' }; }
    if (participant.is_submitted || ir[0].is_submitted) {
      await client.query('ROLLBACK'); return { ok: false, error: 'already_submitted' };
    }

    // 사전 확인은 여기까지 — **쓰기 없이** 되돌리고 그 줄의 제출 칸 이름을 돌려준다.
    if (preflight) {
      await client.query('ROLLBACK');
      return { ok: true, preflight: true, rowIndex: participant.seq, submitColumn: submitCol };
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
    // ★★ 다음 번호는 **표 전체**(소프트삭제·비활성 줄 포함)에서 골라야 한다 — `uq_participants_seq`
    //   는 부분 인덱스가 아니라 지워진 줄의 번호도 영구히 점유한다. 살아있는 줄(`tabRows`)만 보고
    //   고르면, 예전에 [♻ 중복 정리]·[🧹 줄 정리] 등으로 소프트삭제된 줄이 그 위 번호를 쥐고 있을 때
    //   그 번호와 충돌해 23505 로 행 삭제 전체가 롤백된다(2026-08-24 실사고 — 8/3 위프_블랙 탈취제
    //   800건 탭, 예전 중복 줄 정리 잔재와 충돌).
    // ★ `appendSlot`(주문 이어붙이기)과 **같은 계산**(`participants.MANUAL_SEQ_BASE` 미만 대역만) +
    //   `ON CONFLICT DO NOTHING` 재시도로 맞춘다 — 이 INSERT 는 어떤 동시성 상황에서도 예외를
    //   던지지 않으므로(충돌 시 그냥 0행 반환) SAVEPOINT 가 필요 없다. 그래도 계속 0행이면(극단적
    //   동시경합) 조용히 넘어가지 않고 명시적으로 실패시켜 트랜잭션을 롤백한다 — 보충 없이 삭제만
    //   반영되는 상태(총 모집인원 축소)를 만들지 않는다.
    let replacement = null;
    for (let attempt = 0; attempt < 5 && !replacement; attempt++) {
      const tryInsert = await client.query(
        `INSERT INTO campaign_participants
           (sheet_id, tab_gid, tab_name, seq, start_date, row_json, source, updated_by, updated_at)
         SELECT $1, $2, $3,
                COALESCE(MAX(seq) FILTER (WHERE seq < ${participants.MANUAL_SEQ_BASE}), 0) + 1,
                $4, $5::jsonb, 'worktable', $6, NOW()
           FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $3
         ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING
         RETURNING id, seq`,
        [sheetId, (tabRows[0] && tabRows[0].tab_gid) || null, tabName,
          finalDateLabel || null, JSON.stringify(blank), String(by).slice(0, 100)]);
      if (tryInsert.rows.length) replacement = tryInsert;
    }
    if (!replacement) throw new HideRowError('replacement_slot_failed');

    // ★★ 표시 번호를 그 자리에서 다시 매긴다 (2026-08-23 신고: "1번 행을 지웠는데 2번이 시작번호").
    //   위 주석대로 seq 는 그대로 두고 화면 `#` 만 순번으로 계산하는데, **row_json 의 `번호` 칸**은
    //   아무도 손대지 않아 `2,3,4…` 로 남았다. 보충 슬롯의 번호가 비어 주기 스윕이 결국 잡기는
    //   하지만, 그 사이 담당자는 어긋난 번호를 본다(그리고 대상이 많으면 사이클 상한에 밀린다).
    // ★ SAVEPOINT 격리 + 절대 throw 없음 — 번호 때문에 **행 삭제·주문 취소가 롤백되면 안 된다**.
    //   실패해도 5분 스윕이 백스톱이다(구매일자 달력 편집과 같은 규율).
    const renumbered = await require('./rowNumbering.service')
      .renumberTabInTx(client, { sheetId, tabName, by: `row-delete:${by}`.slice(0, 100) });

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
      renumbered: (renumbered && renumbered.changed) || 0,
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

  // 구매기록 취소는 금액·시트 주문값을 함께 바꾸므로 내부 담당자만 허용한다.
  // (actorRole 미전달 = 옛 호출부 → 종전대로 통과. 라우트가 항상 넘긴다.)
  if (liveOrderId && actorRole && !['master', 'admin', 'staff'].includes(actorRole)) {
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

/**
 * 작업보드 구매일자 달력 편집 (무시트 전용 · 2026-08-21).
 *
 * ★★ 무시트 탭의 구매일자는 row_json 이 진실이라 그리드 오버레이(표시 전용)로는 재번호·장부에
 *   인식되지 않는다 → 여기서 진짜로 쓴다. 시트 기반 탭은 거부(시트가 진실원본 — 화면은 종전
 *   오버레이 경로를 그대로 쓴다).
 * ★★ 주문이 연결된 줄은 **원장(date_str)을 먼저 고치고 order-edit 무시트 경로와 같은 실행부**
 *   (`writeOrderToWorktable`)로 재기록한다 — row_json 만 고치면 다음 주문 재기록이 옛 날짜를
 *   도로 덮는다(원장·작업표 드리프트). 주문 없는 줄만 `markSheetlessPurchaseDate` 직접 기록.
 * ★ 재번호는 fail-soft — 날짜는 이미 박혔고 5분 스윕이 백스톱이다.
 */
async function setWorkdeskPurchaseDate({ sheetId, tabName, rowId, date, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId) return { ok: false, error: 'bad_request' };
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  if (!dm) return { ok: false, error: 'bad_date' };
  const db = getPool();

  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName); }
  catch (_) { sheetless = false; }
  if (!sheetless) return { ok: false, error: 'not_sheetless' };

  const { rows: pr } = await db.query(
    `SELECT id, seq, tab_gid, order_submission_id FROM campaign_participants
      WHERE id = $1 AND sheet_id = $2 AND tab_name = $3 AND deleted_at IS NULL LIMIT 1`,
    [rowId, sheetId, tabName]);
  if (!pr.length) return { ok: false, error: 'row_not_found' };
  const row = pr[0];
  const fmt = require('../utils/worktablePlan').sheetDateStr({ y: +dm[1], m: +dm[2], d: +dm[3] });

  if (row.order_submission_id) {
    // 원장 먼저(진실원본) — last_edit_seq 단조증가로 역동기·stale 편집 보호(order-edit 와 동일).
    const { rowCount } = await db.query(
      `UPDATE order_submissions SET date_str = $2, updated_at = NOW(),
              last_edit_seq = GREATEST(COALESCE(last_edit_seq, 0), $3)
        WHERE id = $1 AND deleted_at IS NULL`,
      [row.order_submission_id, fmt, Date.now()]);
    if (!rowCount) return { ok: false, error: 'order_not_found' };
    const { rows: full } = await db.query(`SELECT * FROM order_submissions WHERE id = $1`, [row.order_submission_id]);
    const { _osRowToOrderData } = require('./orderLedger.service');
    const w = await require('./sheetlessOrder.service').writeOrderToWorktable({
      sheetId, tabName, tabGid: row.tab_gid || '', sheetRow: row.seq,
      orderData: _osRowToOrderData(full[0]), orderSubmissionId: row.order_submission_id,
    });
    return w && w.ok ? { ok: true, seq: row.seq, value: fmt, via: 'order' }
                     : { ok: false, error: (w && w.reason) || 'write_failed', via: 'order' };
  }

  const r = await require('./sheetlessStatus.service').markSheetlessPurchaseDate({
    sheetId, tabName, rowIndex: row.seq, dateYmd: String(date).trim(), by });
  if (!r || r.handled === false || !r.ok) {
    return { ok: false, error: (r && r.reason) || 'write_failed', via: 'cell' };
  }
  try { await require('./rowNumbering.service').renumberTab({ sheetId, tabName, by }); } catch (_) { /* 5분 스윕 백스톱 */ }
  return { ok: true, seq: row.seq, value: fmt, via: 'cell' };
}

/**
 * 작업표 주문자·수취인 칸 편집 — "리뷰 내역에도 실제 반영" 창구 (2026-08-24).
 *
 * ★★ 리뷰어 홈의 이름은 `campaign_participants.row_json`(작업표)이 아니라 `review_index`에서
 *   온다. 오버레이(`editWorkdeskRow`)는 작업보드 화면만 바꿀 뿐 `review_index`는 건드리지 않아
 *   그리드에서 이름을 고쳐도 리뷰어 화면은 그대로였다(2026-08-24 실사고 — 타계정 오타 정정 요청).
 * ★ 구매일자(`setWorkdeskPurchaseDate`)와 완전히 같은 패턴: 주문이 연결된 줄은 **원장을 먼저**
 *   고치고 `writeOrderToWorktable`(무시트 order-edit 실행부)로 재기록 — 그래야 다음 주문
 *   재기록이 옛 이름을 도로 덮지 않는다. 원장이 없는 준비 슬롯은 작업표 칸에 직접 기록.
 * ★ `field='orderer'` = 리뷰 내역 카드가 실제로 보여주는 이름의 원천(대개 '주문자제출' 칸).
 *   `field='recipient'` = 작업표 '수취인' 칸(review_index.recipient_name — 현재 리뷰어 화면
 *   어디에도 안 뜨지만, 참고용으로 함께 진짜 반영시킨다). 어느 칸이 어디에 대응하는지는
 *   `identityCols`(workdeskTab 응답)로 화면에 실어 준다.
 * ★ 시트 기반 탭은 거부(409) — 시트가 진실원본, 화면은 종전 오버레이 그대로.
 */
async function setWorkdeskIdentityField({ sheetId, tabName, rowId, field, value, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId) return { ok: false, error: 'bad_request' };
  if (field !== 'orderer' && field !== 'recipient') return { ok: false, error: 'bad_field' };
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, error: 'empty_value' };
  const db = getPool();

  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName); }
  catch (_) { sheetless = false; }
  if (!sheetless) return { ok: false, error: 'not_sheetless' };

  const { rows: pr } = await db.query(
    `SELECT id, seq, tab_gid, order_submission_id FROM campaign_participants
      WHERE id = $1 AND sheet_id = $2 AND tab_name = $3 AND deleted_at IS NULL LIMIT 1`,
    [rowId, sheetId, tabName]);
  if (!pr.length) return { ok: false, error: 'row_not_found' };
  const row = pr[0];

  if (row.order_submission_id) {
    // 원장 먼저(진실원본) — last_edit_seq 단조증가로 역동기·stale 편집 보호(order-edit 와 동일).
    const sql = field === 'orderer'
      ? `UPDATE order_submissions SET orderer = $2, updated_at = NOW(),
                last_edit_seq = GREATEST(COALESCE(last_edit_seq, 0), $3)
          WHERE id = $1 AND deleted_at IS NULL`
      : `UPDATE order_submissions SET recipient = $2, updated_at = NOW(),
                last_edit_seq = GREATEST(COALESCE(last_edit_seq, 0), $3)
          WHERE id = $1 AND deleted_at IS NULL`;
    const { rowCount } = await db.query(sql, [row.order_submission_id, text, Date.now()]);
    if (!rowCount) return { ok: false, error: 'order_not_found' };
    const { rows: full } = await db.query(`SELECT * FROM order_submissions WHERE id = $1`, [row.order_submission_id]);
    const { _osRowToOrderData } = require('./orderLedger.service');
    const w = await require('./sheetlessOrder.service').writeOrderToWorktable({
      sheetId, tabName, tabGid: row.tab_gid || '', sheetRow: row.seq,
      orderData: _osRowToOrderData(full[0]), orderSubmissionId: row.order_submission_id,
    });
    return w && w.ok ? { ok: true, seq: row.seq, value: text, via: 'order' }
                     : { ok: false, error: (w && w.reason) || 'write_failed', via: 'order' };
  }

  const r = await require('./sheetlessStatus.service').markSheetlessIdentityName({
    sheetId, tabName, rowIndex: row.seq, field, name: text, by });
  if (!r || r.handled === false || !r.ok) {
    return { ok: false, error: (r && r.reason) || 'write_failed', via: 'cell' };
  }
  return { ok: true, seq: row.seq, value: text, via: 'cell' };
}

/**
 * 리뷰제출일 백필 (무시트 전용 · adminOrMaster · 2026-08-21).
 *
 * ★ 외부모집 사후 등록 건은 리뷰가 시스템 밖(카톡 수집)에서 제출돼 캡처 원장이 없다 —
 *   증빙 게이트가 있는 [수동 리뷰제출](manualWorkdeskReviewSubmit)로는 기록할 수 없어서,
 *   입금일 기록(deposit-date-backfill)과 같은 성격의 관리자 백필 창구를 둔다.
 * ★ 값은 날짜로 해석 가능해야 한다(parseDateToken — '완료' 같은 임의 문구 차단).
 * ★ 기록 실행부 = `sheetlessStatus.markStatusCell` 한 벌(리뷰어 제출과 같은 경로 · 사본 0).
 */
async function backfillWorkdeskReviewSubmitDate({ sheetId, tabName, rowId, value, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId) return { ok: false, error: 'bad_request' };
  const text = String(value == null ? '' : value).trim().slice(0, 40);
  if (!text) return { ok: false, error: 'empty_value' };
  const { parseDateToken } = require('../utils/koreanDate');
  let parsed = null;
  try { parsed = parseDateToken(text, { fallbackAnchor: new Date() }); } catch (_) { parsed = null; }
  if (!parsed) return { ok: false, error: 'bad_date', hint: '날짜로 읽히는 값만 기록할 수 있습니다(예: 8/1)' };

  const db = getPool();
  const { rows: pr } = await db.query(
    `SELECT id, seq FROM campaign_participants
      WHERE id = $1 AND sheet_id = $2 AND tab_name = $3 AND deleted_at IS NULL LIMIT 1`,
    [rowId, sheetId, tabName]);
  if (!pr.length) return { ok: false, error: 'row_not_found' };
  const seq = pr[0].seq;

  const r = await require('./sheetlessStatus.service').markStatusCell({
    sheetId, tabName, rowIndex: seq, kind: 'submit', value: text, by });
  if (!r || r.handled === false) return { ok: false, error: 'not_sheetless' };
  if (!r.ok) return { ok: false, error: r.reason || 'write_failed' };
  // 화면 즉시 일치용 물리 토글 — source 는 건드리지 않는다('manual' 로 두면 투영 상태 CASE 가 얼린다).
  await db.query(
    `UPDATE campaign_participants SET is_submitted = TRUE, updated_by = $4, updated_at = NOW()
      WHERE id = $1 AND sheet_id = $2 AND tab_name = $3`,
    [rowId, sheetId, tabName, String(by).slice(0, 100)]);
  return { ok: true, seq, value: text, column: r.column || null };
}


/* ══ 관리자 수동 입금처리 (작업보드 입금 칸 · 2026-08-24 사용자 확정) ═══════════════════════
 *
 * ★★ 왜 별도 창구인가 — 입금 칸은 **직접 편집이 잠긴 상태 칸**이다(`_statusToggleForRow`).
 *    그런데 이체결과 자동반영(M2)이 닿지 못한 건(외부 이체·통장 직접 송금·오기입 정정)은
 *    사람이 고쳐야 하고, 지금까지 그 창구가 없어 "값이 틀렸는데 고칠 데가 없는" 칸이었다.
 *    → 우클릭 [💰 입금수정] = 날짜를 **달력에서 고르거나 비우는** 단 하나의 경로.
 *
 * ★★ 기록은 **작업표 칸 하나**(`campaign_participants.row_json[입금열]`)에만 한다 — 그 값이
 *    장부 재생성(`sheetlessLedger.rebuildLedgers`)을 거쳐 `review_index.is_submitted2` 로 파생되고,
 *    그 파생값 하나가 ① 입금관리 대상 제외(`payment.service.listPaymentTargets` 의 미입금 조건)
 *    ② 리뷰어 화면의 입금완료·페이백 날짜(`reviewer.routes` review-earnings / reviewEdit brief)
 *    를 동시에 결정한다. 여기서 `review_index` 를 직접 UPDATE 하면 다음 재생성에 증발한다.
 *
 * ★★ **병합이 아니라 치환**이다 — 자동 반영(`markStatusCell` → `mergeDepositStamps`)은 이체 이력을
 *    덧붙이는 것이 목적이라 지난 날짜를 지우지 않는다. 이 창구는 반대로 **고치고 비우는** 것이
 *    목적이라(사용자 요청) 칸 값을 그대로 갈아끼운다. 지워진 값은 아래 감사 로그에 남는다.
 *
 * ★ 중복 앵커(같은 주문·신원이 여러 줄)는 거부 — 어느 줄의 입금인지 모르면 어느 줄에도 쓰지 않는다
 *   (2026-08-19 실사고: 입금일 1건이 중복 줄 전부에 번져 입금완료가 부풀었다).
 * ★ 감사 로그는 셀 편집과 **같은 표**(`participant_edits`)에 남긴다 — 셀 편집기록 팝업이 모든 칸을
 *   한 곳에서 읽게 하기 위해서다(저장소를 나누면 "이 칸만 기록이 비어 보이는" 상태가 된다).
 */
async function setWorkdeskDepositDate({ sheetId, tabName, rowId, date, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId) return { ok: false, error: 'bad_request' };
  const raw = String(date == null ? '' : date).trim();
  const clearing = raw === '';
  let stamp = '';
  if (!clearing) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (!m) return { ok: false, error: 'bad_date', hint: '입금일은 달력에서 골라 주세요.' };
    const mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false, error: 'bad_date' };
    // 표기는 입금 칸 단일 출처(`utils/depositStamp`) — 자동 반영과 같은 'M/D' 로 적는다.
    stamp = formatDepositStamp(`${mo}/${d}`);
  }

  const db = getPool();
  let sheetless = false;
  try { sheetless = await require('../utils/sheetlessScope').isSheetless(db, sheetId, tabName); }
  catch (_) { sheetless = false; }
  if (!sheetless) return { ok: false, error: 'not_sheetless' };

  const client = await db.connect();
  let ctx = null;
  try {
    await client.query('BEGIN');
    const { rows: pr } = await client.query(
      `SELECT id, seq, source, order_submission_id, identity_key, phone8, recipient_name,
              option_text, row_json, submit_col, submit_col2
         FROM campaign_participants
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL FOR UPDATE`,
      [rowId, sheetId, tabName]);
    if (!pr.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found' }; }
    const row = pr[0];

    const anchor = _deriveAnchor(row);
    if (!anchor) { await client.query('ROLLBACK'); return { ok: false, error: 'no_stable_anchor' }; }
    if (anchor.type === 'order') {
      const { rows: dup } = await client.query(
        `SELECT COUNT(*)::int AS n FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
            AND order_submission_id=$3::uuid`, [sheetId, tabName, anchor.value]);
      if ((dup[0] && dup[0].n) > 1) { await client.query('ROLLBACK'); return { ok: false, error: 'ambiguous_order' }; }
    } else if (anchor.type === 'identity') {
      const { rows: dup } = await client.query(
        `SELECT COUNT(*)::int AS n FROM campaign_participants
          WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active=TRUE
            AND order_submission_id IS NULL AND source<>'manual' AND identity_key=$3`,
        [sheetId, tabName, anchor.value]);
      if ((dup[0] && dup[0].n) > 1) { await client.query('ROLLBACK'); return { ok: false, error: 'ambiguous_identity' }; }
    }

    // 어느 칸이 입금 열인가 = 파서가 그 탭에서 실제로 고른 헤더(사본 0 · 잠근 tx 안에서 조회).
    let header = '';
    try {
      header = await require('./sheetlessStatus.service').statusHeaderForTab(client, { sheetId, tabName, kind: 'paid' });
    } catch (e) { await client.query('ROLLBACK'); return { ok: false, error: 'lookup_failed', message: e.message }; }
    if (!header) { await client.query('ROLLBACK'); return { ok: false, error: 'no_status_column' }; }

    const rj = (row.row_json && typeof row.row_json === 'object') ? row.row_json : {};
    const prev = String(rj[header] == null ? '' : rj[header]).trim();
    if (prev === stamp) {
      await client.query('ROLLBACK');
      return { ok: true, unchanged: true, seq: row.seq, column: header, value: stamp, prev, cleared: clearing };
    }

    await client.query(
      `UPDATE campaign_participants
          SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($4::text, $5::text),
              is_paid = $6, updated_by = $7, updated_at = NOW()
        WHERE id=$1 AND sheet_id=$2 AND tab_name=$3`,
      [rowId, sheetId, tabName, header, stamp, !clearing, String(by).slice(0, 100)]);

    /* ★★ 칸을 비운다 = 관리자가 "이 건은 실제로 입금되지 않았다"고 판정한 것이다(사용자 확정
       2026-08-24) — 그런데 그 사람이 과거에 이체파일로 한 번이라도 다운로드된 적 있으면
       `payment_batch_items` 가 pending/paid 로 남아 입금대상 추출을 계속 잠근다("다운로드 이력
       잠금"). 그 잠금을 푸는 종전 창구는 [회차 취소] 뿐인데, 그건 **그 회차에 같이 담긴 다른
       사람들 몫까지** 건드린다(범위 과도 — 사용자 지적). 여기서는 **이 사람의 항목 하나만** 푼다.
       ★ 상태값은 새로 만들지 않는다 — `failed`(이체 실패)가 이미 이 테이블에서 "결국 입금되지
       않았다"는 뜻으로 쓰이고(M2 결과 반영과 동일 의미), `uq_payment_items_active` 부분유니크가
       pending/paid 만 잠그므로 failed 로 바꾸면 다음 회차에 즉시 다시 담길 수 있다.
       ★ 이 항목만(sheet_id·tab_name·row_index) 건드린다 — 같은 batch_id 의 다른 사람 항목·배치
       자체 상태는 무접촉(그 사람들의 이체는 그대로 유효하게 남는다). */
    let releasedBatchItems = 0;
    if (clearing) {
      const rel = await client.query(
        `UPDATE payment_batch_items
            SET status='failed', fail_reason=$4, paid_at=NULL
          WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND status IN ('pending','paid')`,
        [sheetId, tabName, row.seq, `관리자(${String(by).slice(0, 100)})가 작업표 입금 기록을 비워 미입금으로 정정함`]);
      releasedBatchItems = rel.rowCount;
    }

    // 감사 로그(= 이 셀의 편집기록). 종전 활성 기록을 접고 새 기록을 남긴다(append-only).
    const logField = 'col:' + header;
    for (const f of [logField, 'is_paid']) {
      await client.query(
        `UPDATE participant_edits SET reverted_at=NOW(), reverted_by=$1
          WHERE sheet_id=$2 AND tab_name=$3 AND anchor_type=$4 AND anchor_value=$5 AND field=$6 AND reverted_at IS NULL`,
        [String(by).slice(0, 100), sheetId, tabName, anchor.type, anchor.value, f]);
    }
    await client.query(
      `INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_bool, value_text, created_by)
       VALUES ($1,$2,$3,$4,$5,'text',NULL,$6,$7)`,
      [sheetId, tabName, anchor.type, anchor.value, logField, stamp, String(by).slice(0, 100)]);
    await client.query(
      `INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_bool, value_text, created_by)
       VALUES ($1,$2,$3,$4,'is_paid','bool',$5,NULL,$6)`,
      [sheetId, tabName, anchor.type, anchor.value, !clearing, String(by).slice(0, 100)]);

    await client.query('COMMIT');
    ctx = { seq: row.seq, header, prev, releasedBatchItems };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 이미 끝난 tx */ }
    if (e && e.code === '23505') return { ok: false, error: 'concurrent_edit_conflict' };
    throw e;
  } finally { client.release(); }

  /* 장부 재생성 — 입금관리 대상 제외·리뷰어 입금표시가 전부 이 파생을 읽는다.
     ★ 실패해도 값은 작업표에 남아 다음 재생성(주문 유입 등)에 반영된다 → fail-soft 로 사실만 말한다. */
  let ledger = 'ok';
  try {
    await _rebuildWorkdeskLedgers({ sheetId, tabName, by });
  } catch (e) {
    ledger = 'deferred';
    logger.warn(`[workdeskDeposit] 장부 재생성 실패(값은 작업표에 기록됨) tab=${tabName} row=${ctx.seq}: ${e.message}`);
  }

  /* ★ 비웠는데도 입금관리 목록에 안 돌아오는 경우를 **미리 말한다** — 이체 회차(payment_batch_items)에
     살아있는 항목이 있으면 대상 추출이 그 줄을 계속 제외한다(다운로드 이력 잠금). 조용히 두면
     "비웠는데 왜 목록에 없지" 가 된다. 조회 실패는 무시(표시용). */
  let batchLocked = false;
  if (clearing) {
    try {
      const { rows: bi } = await db.query(
        `SELECT 1 FROM payment_batch_items
          WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND status IN ('pending','paid') LIMIT 1`,
        [sheetId, tabName, ctx.seq]);
      batchLocked = bi.length > 0;
    } catch (_) { batchLocked = false; }
  }

  return { ok: true, seq: ctx.seq, column: ctx.header, value: stamp, prev: ctx.prev, cleared: clearing, ledger, batchLocked,
    releasedBatchItems: ctx.releasedBatchItems };
}

/* ══ 이 셀의 편집기록 (구글시트 셀 편집기록과 같은 성격 · 읽기 전용) ═══════════════════════
 * ★ 저장소는 셀 편집과 같은 `participant_edits` 하나 — 되돌린 기록(`reverted_at`)도 **지우지 않고**
 *   그대로 보여 준다(무엇이 언제 왜 바뀌었는지가 곧 이력이다).
 * ★ 앵커는 읽는 쪽(workdeskTab 합성)과 **같은 규칙**으로 고른다: 현재 앵커 + 물리행 앵커(승격 전에
 *   빈 자리로 적어 둔 값). 다르게 고르면 "화면에는 보이는데 기록은 비어 있는" 칸이 생긴다.
 */
async function listCellEdits({ sheetId, tabName, rowId, field, limit = 20 } = {}) {
  if (!sheetId || !tabName || !rowId || !field) return { ok: false, error: 'bad_request' };
  const db = getPool();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const { rows: pr } = await db.query(
    `SELECT id, source, order_submission_id, identity_key, phone8, recipient_name, option_text, row_json
       FROM campaign_participants
      WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL LIMIT 1`,
    [rowId, sheetId, tabName]);
  if (!pr.length) return { ok: false, error: 'row_not_found' };
  const anchor = _deriveAnchor(pr[0]);
  const pairs = [];
  if (anchor) pairs.push(anchor);
  const rowAnchorId = _rowAnchorId(pr[0]);
  if (rowAnchorId && !(anchor && anchor.type === 'manual' && anchor.value === rowAnchorId)) {
    pairs.push({ type: 'manual', value: rowAnchorId });
  }
  if (!pairs.length) return { ok: true, items: [] };

  const { rows } = await db.query(
    `SELECT pe.id, pe.field, pe.kind, pe.value_bool AS "valueBool", pe.value_text AS "valueText",
            pe.created_by AS "createdBy", pe.created_at AS "createdAt",
            pe.reverted_by AS "revertedBy", pe.reverted_at AS "revertedAt"
       FROM participant_edits pe
      WHERE pe.sheet_id=$1 AND pe.tab_name=$2 AND pe.field=$3
        AND (pe.anchor_type, pe.anchor_value) IN (SELECT * FROM UNNEST($4::text[], $5::text[]))
      ORDER BY pe.created_at DESC, pe.id DESC
      LIMIT $6`,
    [sheetId, tabName, field, pairs.map(p => p.type), pairs.map(p => p.value), lim]);

  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id,
      // 값이 비어 있으면 "지움" 이다 — 빈 칸을 그냥 빈 칸으로 그리면 무슨 일이 있었는지 안 보인다.
      value: r.kind === 'bool' ? (r.valueBool ? '완료' : '해제') : String(r.valueText == null ? '' : r.valueText),
      cleared: r.kind !== 'bool' && !String(r.valueText || '').trim(),
      by: r.createdBy || '', at: r.createdAt,
      reverted: !!r.revertedAt, revertedBy: r.revertedBy || null, revertedAt: r.revertedAt,
    })),
  };
}

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
      r = await st.markStatusCell({
        sheetId, tabName, rowIndex: e.row_index,
        kind: e.field === 'is_submitted' ? 'submit' : 'paid', by: 'writeback',
      });
    } catch (_) { r = null; }
    if (r && r.handled && r.ok) { await markStatus(e.id, 'written'); written++; }
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

/** 업체목록 드래그 배치 — 계정별 순서 있는 배열. 업체명은 화면용 문자열이므로 엄격히 길이·중복만 제한한다. */
async function getWorkdeskAdvertiserOrder(ownerKey) {
  const k = String(ownerKey || '').trim();
  if (!k) return { ok: true, advertiserKeys: [] };
  try {
    const { rows } = await getPool().query(
      `SELECT advertiser_keys AS "advertiserKeys" FROM trackb_workdesk_advertiser_order WHERE owner_key=$1 LIMIT 1`, [k]);
    const v = rows[0] && rows[0].advertiserKeys;
    return { ok: true, advertiserKeys: Array.isArray(v) ? v.filter(x => typeof x === 'string') : [] };
  } catch (err) {
    logger.warn(`[trackB] getWorkdeskAdvertiserOrder 실패(기존 자동정렬 유지): ${err.message}`);
    return { ok: false, advertiserKeys: [], advertiserOrderUnavailable: true };
  }
}
async function setWorkdeskAdvertiserOrder(ownerKey, advertiserKeys) {
  const k = String(ownerKey || '').trim();
  if (!k) return { ok: false, error: 'no_owner' };
  const seen = new Set();
  const arr = (Array.isArray(advertiserKeys) ? advertiserKeys : [])
    .filter(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 300 && !seen.has(x) && seen.add(x))
    .slice(0, 1000);
  try {
    await getPool().query(
      `INSERT INTO trackb_workdesk_advertiser_order (owner_key, advertiser_keys, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (owner_key) DO UPDATE SET advertiser_keys=EXCLUDED.advertiser_keys, updated_at=NOW()`,
      [k, JSON.stringify(arr)]);
  } catch (err) {
    if (err && err.code === '42P01') {
      logger.error(`[trackB] trackb_workdesk_advertiser_order 테이블 없음(migration 143 미적용): ${err.message}`);
      return { ok: false, code: 'not_ready', error: '업체목록 배치 저장이 아직 준비되지 않았습니다(migration 143 미적용).' };
    }
    throw err;
  }
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
              -- ★ 담당자 판정 원천(회차 #18) — 작업담당(065) 이 tab_configs.manager 보다 우선한다.
              --   tc.manager 는 접수 시점에 한 번만 채워지는 blank-only 칸이라 오더에서 담당자가
              --   바뀌어도 안 따라온다(payment.service 와 같은 함정 — resolveWorkManager 로 통일).
              wo.work_manager AS "orderWorkManager",
              /* 무시트 작업표의 빈 슬롯은 review_index 에 들어가지 않는다(이름 없는 행은 검색 대상이 아님).
                 홈의 작업 인원은 검색 명단이 아니라 실제 작업표 원장으로 보여야 하므로, 무시트 탭만
                 campaign_participants 활성 행을 쓴다. 시트 탭은 기존 index_master 집계를 그대로 유지한다. */
              CASE WHEN COALESCE(tc.sheetless, FALSE) THEN COALESCE(cp.total_count, 0) ELSE im.row_count END AS "rowCount",
              /* ★★ 채워진 줄 = 작업보드 상단 참여자 게이지의 분자와 **같은 판정**(rowNumbering.filledSql).
                 홈이 여기서 따로 세면 "게이지는 208명인데 홈은 다른 숫자"로 갈린다(단일 출처 규율).
                 시트 기반 탭의 index_master.row_count 는 이미 **이름 있는 행만** 세므로 그대로 채움 수다. */
              CASE WHEN COALESCE(tc.sheetless, FALSE) THEN COALESCE(cp.filled_count, 0) ELSE im.row_count END AS "filledCount",
              CASE WHEN COALESCE(tc.sheetless, FALSE) THEN COALESCE(cp.submitted_count, 0) ELSE im.submitted_count END AS "submittedCount",
              COALESCE(paid.paid_count, 0)::int AS "paidCount",
              co.closed_date AS "closeoutDate", co.row_count AS "closeoutRows"
         FROM tab_configs tc
         LEFT JOIN LATERAL (SELECT w.work_manager FROM work_orders w
                              WHERE w.deleted_at IS NULL
                                AND w.linked_tab_sheet_id = tc.sheet_id
                                AND w.linked_tab_name = tc.tab_name
                              ORDER BY w.created_at DESC LIMIT 1) wo ON TRUE
         LEFT JOIN index_master im ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE active AND deleted_at IS NULL)::int AS total_count,
                  COUNT(*) FILTER (WHERE active AND deleted_at IS NULL AND is_submitted)::int AS submitted_count,
                  COUNT(*) FILTER (WHERE active AND deleted_at IS NULL AND ${require('../utils/rowNumbering').filledSql('cp')})::int AS filled_count
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
        manager: resolveWorkManager({ orderWorkManager: r.orderWorkManager, tabManager: r.manager }).manager,
        campaignName: r.campaignName || '', displayName: r.displayName || '',
        total: Number.isFinite(+r.rowCount) ? +r.rowCount : null,
        // 준비된 줄(total) 과 채워진 줄(filled) 은 다른 값이다 — 홈 게이지 분자는 filled 를 쓴다.
        filled: Number.isFinite(+r.filledCount) ? +r.filledCount : null,
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
    /* ── 총건수(정원) 재료 ─────────────────────────────────────────────────────
       홈 목록의 「인원/제출」 분모를 **작업표 줄 수가 아니라 총건수**로 그리기 위한 값이다.
       ★★ 판정 사본을 만들지 않는다 — `displayRecruitTotal`(공고>0 이면 공고, 아니면 발주)은
         작업 조건 카드·상태엔진이 쓰는 그 함수다. 여기서 `recruit_total` 을 그대로 실으면
         "공고 0(미설정) + 발주 500" 인 작업이 홈에서만 0 건으로 보인다.
       ★ 연결 작업오더 조회는 **배치 1회**(N+1 금지, linkedRecruitQuota 공유 조각).
       ★ fail-soft — 실패하면 발주 폴백만 빠지고 공고 값으로 떨어진다(주석 자체는 살린다). */
    const { displayRecruitTotal, linkedWorkOrdersForCampaigns } = require('./linkedRecruitQuota.service');
    let woMap = new Map();
    try { woMap = await linkedWorkOrdersForCampaigns(db, rows.map(r => r.id), ['recruit_count']); }
    catch (e) { logger.warn(`[trackB] tabCampaignsMap 발주 정원 조회 실패(공고 값만 사용): ${e.message}`); }
    for (const r of rows) {
      let state = null, stateReason = null;
      try {
        const st = computeCampaignState(
          r, countsMap.get(r.id) || { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 },
          now, schedMap ? scheduleFor(schedMap, r) : null);
        state = st.state; stateReason = st.stateReason || null;
      } catch (_) { /* 판정 실패 = 상태 없음(공고 자체는 계속 보인다) */ }
      const _wo = woMap && typeof woMap.get === 'function' ? woMap.get(r.id) : null;
      const _rt = displayRecruitTotal(r.recruit_total, _wo && _wo.recruit_count);
      const item = {
        id: r.id, title: r.title || '', createdAt: r.created_at || null,
        status: r.status || '', participationMode: !!r.participation_mode,
        state, stateReason,
        // 총건수(적용 정원)와 그 출처 — 0/'none' 이면 화면이 분모를 지어내지 않고 줄 수로 접는다.
        recruitTotal: _rt.total || null, recruitTotalSource: _rt.source,
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
/* 작업 조건 — **광고주 렌즈**(사용자 확정 2026-08-23: 업체 뷰어에도 같은 카드를 그린다).
   ★★ **화이트리스트 재구성**(`{...cd}` 스프레드 금지) — 나중에 `tabConditionSummary` 에 필드가
      늘어나면 스프레드는 그것을 **조용히 광고주에게 흘린다**(`_tpAdvertiserLens` 와 같은 규율).
   ★ 내보내는 것 = 사용자가 지정한 10행의 재료뿐.
   ★ **폐기**: `reviewFee`·`feeSource`·`depositName`(리뷰비·입금명 = 내부 정산 값) ·
      `multiAccount`·`cashReceipt`·`incomeType`·`slotsPinned`(운영 설정) ·
      `campaignId`·`workOrderId`·`campaignCount`(내부 식별자 — 화면 창구를 여는 열쇠이기도 하다).
   ★ null 이면 null 그대로(카드가 종전 4줄로 떨어진다). */
/* 작업 조건의 담당 재료에 업체가 정한 브랜드 담당자를 붙인다(136).
   ★ 소유 업체 판정은 `advertiserForTab` 단일 출처(작업목록 그룹핑·업체관리가 쓰는 그 규칙) —
     광고주 세션은 자기 advertiserId 를 이미 알고 있으므로 조회하지 않는다.
   ★ 어떤 실패도 담당 행을 죽이지 않는다(fail-soft: 브랜드 담당만 빠지고 내부 담당은 그대로). */
async function _condBrandManagers(manager, { sheetId, tabName, advertiserId = null } = {}) {
  const m = manager || {};
  try {
    let advId = advertiserId;
    if (!advId) { const a = await advertiserForTab({ sheetId, tabName }); advId = (a && a.id) || null; }
    if (!advId) return { ...m, brand: [] };
    return { ...m, brand: await tabBrandManagersFor({ advertiserId: advId, sheetId, tabName }) };
  } catch (err) {
    logger.warn('[trackB] 브랜드 담당자 표기 실패(내부 담당만 표시): ' + err.message);
    return { ...m, brand: [] };
  }
}
function _condAdvertiserLens(cd, { brandSession = false } = {}) {
  if (!cd || typeof cd !== 'object') return cd || null;
  return {
    workboardDisplayName: cd.workboardDisplayName || null,
    productName: cd.productName || '',
    productUrl: cd.productUrl || null,
    schedule: cd.schedule || null,
    purchaseWindow: cd.purchaseWindow || null,
    purchaseAllDay: !!cd.purchaseAllDay,
    orderPurchaseTime: cd.orderPurchaseTime || null,
    recruitTotal: cd.recruitTotal, recruitTotalSource: cd.recruitTotalSource,
    orderRecruitCount: cd.orderRecruitCount,
    dailyLimit: cd.dailyLimit, dailyLimitSource: cd.dailyLimitSource,
    orderDailyCount: cd.orderDailyCount,
    payAmount: cd.payAmount, options: Array.isArray(cd.options) ? cd.options : [],
    channel: cd.channel || null,
    inflowType: cd.inflowType || null,
    /* 담당 2인 — ★ **실명(`adminRaw`)은 폐기**하고 여기서 fail-closed 를 완결한다:
       닉네임이 있으면 닉네임, 없는데 **관리자는 있으면** `관리자`(리뷰어 화면과 같은 규율),
       관리자 자체가 없으면 null → 화면이 그 조각을 아예 안 적는다(사용자 확정 2026-08-24).
       ★ "실명은 있는데 닉네임이 없음" 과 "담당자가 없음" 은 다르다 — 전자를 null 로 접으면
         담당자가 없는 작업처럼 보인다. */
    manager: (() => {
      const m = cd.manager || {};
      const raw = String(m.adminRaw || '').trim();
      const brand = Array.isArray(m.brand) ? m.brand.filter(Boolean) : [];
      /* ★★ 브랜드 링크 세션(브랜드사가 보는 화면)은 **업체가 정한 담당으로 대체**한다
         (사용자 확정 2026-08-24 A안) — 내부 담당(AE·관리자)은 이름도 존재 여부도 내보내지 않는다.
         업체가 아무도 적지 않았으면 셋 다 비어 화면이 **담당 행 자체를 그리지 않는다**(Q2 행숨김). */
      if (brandSession) return { ae: null, adminNick: null, adminRaw: null, brand };
      /* ★ 센티널 셋을 구분한다: 닉네임 문자열 = 그 이름 / **빈 문자열 = "관리자는 있는데 이름을
         밝히지 않는다"**(화면이 라벨만 적는다 — `관리자 관리자` 중복을 피한다) / null = 담당자 없음. */
      return { ae: m.ae || null, adminNick: m.adminNick || (raw ? '' : null), adminRaw: null, brand };
    })(),
    reviewTypeLabel: cd.reviewTypeLabel || null,
    reviewTypeMixed: !!cd.reviewTypeMixed,
    reviewTypeMix: cd.reviewTypeMix || null,
  };
}

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
    // 재발행 공고가 같은 탭을 공유하면 표의 채움 수는 탭 전체 값이다. 개별 공고에 그대로
    // 적용하지 않고, 각 공고의 일일 정원을 합친 공유 정원과 전체 신청·홀드로 판정한다.
    const rawByCampaign = new Map();
    let sharedQuota = 0, sharedSubmitted = 0, sharedHolds = 0;
    for (const r of live) {
      const raw = countsMap.get(r.id) || { activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0 };
      rawByCampaign.set(r.id, raw);
      const rawState = computeCampaignState(r, raw, now, schedMap ? scheduleFor(schedMap, r) : null);
      sharedQuota += Number(rawState.dailyQuota) || 0;
      sharedSubmitted += Math.max(0, Number(raw.todaySubmitted) || 0);
      sharedHolds += Math.max(0, Number(raw.todayActiveHolds) || 0);
    }
    for (const r of live) {
      const rawCounts = rawByCampaign.get(r.id);
      // 카드의 분자(sheetFilled)와 상태 게이트가 갈라지지 않게, 같은 작업표 수를 상태엔진에도 준다.
      const counts = base.sheetFilled == null ? rawCounts
        : {
          ...rawCounts,
          tableTodayFilled: Math.max(0, Number(base.sheetFilled) || 0),
          tableTodayQuota: sharedQuota,
          tableTodaySubmitted: sharedSubmitted,
          tableTodayActiveHolds: sharedHolds,
        };
      const st = computeCampaignState(r, counts, now, schedMap ? scheduleFor(schedMap, r) : null);
      quota = base.sheetFilled == null
        ? quota + (Number(st.dailyQuota) || 0)
        : Math.max(quota, Number(st.dailyQuota) || 0);
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
  getWorkdeskFavorites,
  setWorkdeskFavorites,
  getWorkdeskAdvertiserOrder,
  setWorkdeskAdvertiserOrder,
  getWorkdeskWorktabs,
  setWorkdeskWorktabs,
  dailyDoneMap,
  setTabDailyDone,
  finishedTabsMap,
  setTabFinished,
  tabStatsMap,
  tabCampaignsMap,
  tabTodayProgress,
  tabConditionSummary,   // ★ 회귀가드가 스텁 pool 로 직접 실행(코드리뷰 P1 divergence 재현)
  _tpAdvertiserLens,   // 회귀가드가 렌즈를 직접 실행해 필드 누수를 확인한다
  __condAdvertiserLensForTest: (...a) => _condAdvertiserLens(...a),   // 담당 렌즈(브랜드 세션 분기) 실행 검증용
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
  expandSheetOwnerships,
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
  tabBrandManagersMap, tabBrandManagersFor, setTabBrandManagers, _normBrandManagers,
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
  normalizeDisplayName,   // 작업명 정리 — 회귀가드가 실제로 돌려 본다
  setWorkdeskPurchaseDate,
  backfillWorkdeskReviewSubmitDate,
  setWorkdeskDepositDate,
  setWorkdeskIdentityField,
  listCellEdits,
  editWorkdeskRow,
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
