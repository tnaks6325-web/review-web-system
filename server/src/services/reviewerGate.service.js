/**
 * reviewerGate.service.js — 모집공고별 참여가능 리뷰어 게이트 (migration 091)
 *
 * 판정 규칙은 utils/reviewerGate.js 가 **단일 출처**(여기서는 조회·저장만).
 * 쓰기 표면 = campaign_reviewer_gates + app_settings('reviewer_gate_criteria') 두 곳뿐 —
 * 홀드·정원·시트·주문원장 무접촉(차단은 apply 게이트의 403 하나로만 작동한다).
 *
 * ★ 검색은 2000여명 전체 로드 금지(사용자 확정): 이름/전화 뒤4자리/계좌번호로 좁혀
 *   LIMIT 50 만 반환. 응답의 연락처·계좌는 뒤4자리만(데이터 최소화 — 화면공유 유출 차단).
 * ★ 이전 리뷰 상태(미작성/기한 경과)는 review_index + order_submissions 파생 — 집계 실패는
 *   fail-soft('조회 실패' 표기, 0으로 꾸미지 않음)이고 차단 판정에는 일절 미참조(표시 보조).
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const {
  decideReviewerGate, globalGateEnabled, normalizeMessageType, normalizeCriteria, summarizeHistory,
} = require('../utils/reviewerGate');

const CRITERIA_KEY = 'reviewer_gate_criteria';
const SEARCH_LIMIT = 50;
const MAX_CHANGES = 200;

/* ── apply 게이트 (campaign.routes apply 가 SAVEPOINT 안에서 호출 — 실패는 호출측 fail-open) ── */
async function checkApplyGate(client, campaignId, phone8) {
  const g = await client.query(
    `SELECT mode, message_type FROM campaign_reviewer_gates
      WHERE campaign_id = $1 AND phone8 = $2 AND released_at IS NULL LIMIT 1`,
    [campaignId, phone8]);
  let inGlobal = false;
  if (globalGateEnabled() && !(g.rows[0] && g.rows[0].mode === 'allow')) {
    // 전역 조회는 옵트인일 때만(평상시 왕복 순증 0). phone8 비교는 reviewers 와 같은 숫자 정규화.
    const b = await client.query(
      `SELECT 1 FROM blacklist WHERE RIGHT(REGEXP_REPLACE(phone,'[^0-9]','','g'), 8) = $1 LIMIT 1`,
      [phone8]);
    inGlobal = !!b.rows.length;
  }
  return decideReviewerGate({ gateRow: g.rows[0] || null, inGlobalBlacklist: inGlobal });
}

/* ── 예외 목록 + 이력 + 요약 (모달 기본 화면 = 저장된 예외만, 전체 리뷰어 미로드) ── */
async function listGates(campaignId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, phone8, reviewer_name, mode, message_type, created_by, created_at, released_at, released_by
       FROM campaign_reviewer_gates
      WHERE campaign_id = $1
      ORDER BY created_at DESC
      LIMIT 500`, [campaignId]);
  const active = rows.filter(r => !r.released_at);
  return {
    blocks: active.filter(r => r.mode === 'block'),
    allows: active.filter(r => r.mode === 'allow'),
    history: rows,
    counts: { block: active.filter(r => r.mode === 'block').length, allow: active.filter(r => r.mode === 'allow').length },
  };
}

/* ── 리뷰어 검색 — 이름 부분일치 ∪ 숫자(전화 뒤자리·계좌번호) 부분일치 ──
   ★ 동적 WHERE 의 자리표시자↔파라미터 개수 정합이 유일한 함정(부품4g 실측 500)
     — 안 쓸 $n 을 push 하지 않는다. */
async function searchReviewers(campaignId, q, db = pool) {
  const term = String(q || '').trim();
  if (!term) return { items: [], hasMore: false, total: 0 };
  const digits = term.replace(/[^0-9]/g, '');
  const conds = [];
  const params = [];
  if (term.replace(/[0-9\s-]/g, '')) {                 // 문자 포함 → 이름 검색
    params.push(`%${term}%`);
    conds.push(`name ILIKE $${params.length}`);
  }
  if (digits.length >= 2) {                            // 숫자 → 전화 뒤자리 ∪ 계좌번호 부분일치
    params.push(`%${digits}`);
    conds.push(`REGEXP_REPLACE(phone,'[^0-9]','','g') LIKE $${params.length}`);
    params.push(`%${digits}%`);
    conds.push(`REGEXP_REPLACE(COALESCE(bank_account,''),'[^0-9]','','g') LIKE $${params.length}`);
  }
  if (!conds.length) return { items: [], hasMore: false, total: 0 };
  params.push(SEARCH_LIMIT + 1);
  const { rows } = await db.query(
    `SELECT name, phone8, phone, bank_account, status, registered_at
       FROM reviewers
      WHERE (${conds.join(' OR ')})
      ORDER BY registered_at DESC
      LIMIT $${params.length}`, params);
  const hasMore = rows.length > SEARCH_LIMIT;
  const slice = rows.slice(0, SEARCH_LIMIT);
  const p8s = [...new Set(slice.map(r => r.phone8).filter(Boolean))];

  // 이 공고 예외 행 + 전역 블랙리스트 소속 + 이전 리뷰 집계(전부 후속 주석 — 실패해도 목록은 나간다)
  let gateMap = new Map(), globalSet = new Set(), histMap = null;
  try {
    if (p8s.length) {
      const g = await db.query(
        `SELECT phone8, mode, message_type FROM campaign_reviewer_gates
          WHERE campaign_id = $1 AND phone8 = ANY($2) AND released_at IS NULL`, [campaignId, p8s]);
      g.rows.forEach(r => gateMap.set(r.phone8, r));
      const b = await db.query(
        `SELECT RIGHT(REGEXP_REPLACE(phone,'[^0-9]','','g'), 8) AS p8 FROM blacklist
          WHERE RIGHT(REGEXP_REPLACE(phone,'[^0-9]','','g'), 8) = ANY($1)`, [p8s]);
      b.rows.forEach(r => globalSet.add(r.p8));
      histMap = await _reviewHistory(p8s, db);
    } else { histMap = new Map(); }
  } catch (e) {
    logger.warn('[reviewerGate] 검색 주석 조회 실패(fail-soft): ' + e.message);
    histMap = null; // null = '조회 실패' 표기(0으로 꾸미지 않음)
  }

  const items = slice.map(r => {
    const digitsPhone = String(r.phone || '').replace(/[^0-9]/g, '');
    const acctDigits = String(r.bank_account || '').replace(/[^0-9]/g, '');
    const gate = gateMap.get(r.phone8) || null;
    return {
      name: r.name,
      phone8: r.phone8,
      phoneMasked: digitsPhone ? ('***-' + digitsPhone.slice(-4)) : '',
      accountTail: acctDigits ? ('…' + acctDigits.slice(-4)) : '',
      inGlobalBlacklist: globalSet.has(r.phone8),
      gate: gate ? { mode: gate.mode, messageType: gate.message_type } : null,
      history: histMap ? summarizeHistory(histMap.get(r.phone8) || { joined: 0 }) : summarizeHistory(null),
    };
  });
  return { items, hasMore, total: slice.length };
}

/** 이전 리뷰 집계 — 미작성/기한경과 판정 일수는 설정탭 "블랙리스트 관리기준"(Q4) */
async function _reviewHistory(p8s, db = pool) {
  const c = await getCriteria(db);
  const { rows } = await db.query(
    `SELECT ri.phone8,
            COUNT(*)::int AS joined,
            COUNT(*) FILTER (WHERE ri.is_submitted = TRUE OR ri.review_file_id IS NOT NULL)::int AS done,
            COUNT(*) FILTER (WHERE NOT (ri.is_submitted = TRUE OR ri.review_file_id IS NOT NULL)
                               AND os.submitted_at IS NOT NULL
                               AND os.submitted_at < NOW() - ($2 || ' days')::interval)::int AS nowrite,
            COUNT(*) FILTER (WHERE (ri.is_submitted = TRUE OR ri.review_file_id IS NOT NULL)
                               AND os.submitted_at IS NOT NULL AND ri.review_file_at IS NOT NULL
                               AND ri.review_file_at > os.submitted_at + ($3 || ' days')::interval)::int AS overdue
       FROM review_index ri
       LEFT JOIN order_submissions os
              ON os.sheet_id = ri.sheet_id AND os.tab_name = ri.tab_name
             AND os.sheet_row = ri.row_index AND os.deleted_at IS NULL
      WHERE ri.phone8 = ANY($1)
      GROUP BY ri.phone8`,
    [p8s, String(c.nowriteDays), String(c.overdueDays)]);
  const m = new Map();
  rows.forEach(r => m.set(r.phone8, r));
  return m;
}

/* ── 일괄 적용 — 기존 활성 행 release 후 INSERT(append-only = 관리 이력 보존) ── */
async function applyGateChanges(campaignId, changes, adminName, db = pool) {
  const list = Array.isArray(changes) ? changes.slice(0, MAX_CHANGES) : [];
  const applied = [];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const ch of list) {
      const p8 = String(ch && ch.phone8 || '').replace(/[^0-9]/g, '');
      const mode = ch && ch.mode;
      if (p8.length !== 8 || !['block', 'allow', 'clear'].includes(mode)) continue;
      await client.query(
        `UPDATE campaign_reviewer_gates SET released_at = NOW(), released_by = $3
          WHERE campaign_id = $1 AND phone8 = $2 AND released_at IS NULL`,
        [campaignId, p8, adminName || '']);
      if (mode === 'block' || mode === 'allow') {
        await client.query(
          `INSERT INTO campaign_reviewer_gates (campaign_id, phone8, reviewer_name, mode, message_type, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [campaignId, p8, String(ch.name || '').slice(0, 40), mode,
           mode === 'block' ? normalizeMessageType(ch.messageType) : null, adminName || '']);
      }
      applied.push({ phone8: p8, mode });
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
  return { applied };
}

/* ── 블랙리스트 관리기준 (app_settings 1키 — 신규 테이블 0) ── */
async function getCriteria(db = pool) {
  try {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [CRITERIA_KEY]);
    return normalizeCriteria(rows.length ? JSON.parse(rows[0].value || '{}') : null);
  } catch (e) {
    logger.warn('[reviewerGate] 기준 조회 실패(기본값 폴백): ' + e.message);
    return normalizeCriteria(null);
  }
}

async function saveCriteria(raw, db = pool) {
  const c = normalizeCriteria(raw);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [CRITERIA_KEY, JSON.stringify(c)]);
  return c;
}

module.exports = {
  checkApplyGate, listGates, searchReviewers, applyGateChanges,
  getCriteria, saveCriteria,
  CRITERIA_KEY, SEARCH_LIMIT, MAX_CHANGES,
};
