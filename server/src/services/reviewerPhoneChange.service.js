/**
 * reviewerPhoneChange.service.js — 등록리뷰어DB "로그인 번호 변경" 단일 출처 (migration 126)
 *
 * ══ 왜 이 기능이 특별한가 ══
 * `reviewers.phone` 을 바꾸면 파생 컬럼 `phone8`(GENERATED, 001:99)이 통째로 바뀐다. 그런데 이
 * 시스템의 참여·주문·문의·정산·차단은 전부 phone8 을 신원키로 쓴다. 그래서 번호 변경은 "칸 하나
 * 수정"이 아니라 **신원키 교체**이고, 잘못하면 그 사람의 참여 내역이 화면에서 통째로 사라진다.
 *
 * ══ 채택한 방식: 덮어쓰기가 아니라 "승격 + 옛 번호를 타계정으로 남기기" ══
 *   새 번호 → `reviewers.phone`(본계정) / 옛 번호 → `sub_accounts` 항목(같은 이름)
 * 이렇게 하면 아래 세 경로가 **기존 코드 그대로** 과거 이력을 계속 본다(사본·분기 0):
 *   · 리뷰 내역·검색   `search.service._getReviewerPhoneList` → 본인+타계정 phone8 전부로 review_index 조회
 *   · 받을예정/누적금액 `/api/reviewer/review-earnings` (같은 phoneList)
 *   · 리뷰비 입금 계좌  `payment.service._loadAccounts` (타계정 phone8 매핑 + 빈 계좌는 소유자 계좌 COALESCE)
 * ★ 그래서 `review_index` · `participation_links` · `order_submissions` · `campaign_applications` ·
 *   `payment_batch_items` 는 **일부러 건드리지 않는다**. review_index.phone8 은 시트 연락처 원문이고
 *   시트가 진실원본이며(stale-pl 보안 게이트가 그 전제 위에 서 있다), 회차 스냅샷은 박제값이다.
 *
 * ══ 반대로 "옛 번호를 본계정으로 남기면" 안 되는 이유(비대칭 함정) ══
 *   `_getReviewerPhoneList(p8)` 는 `reviewers WHERE phone8 = $1` 로 소유자 행을 찾는다. 타계정 번호로
 *   로그인하면(verifyReviewer 의 sub 매칭) 세션 phone8 이 타계정 값이라 소유자 행을 못 찾아 **자기
 *   번호 하나만** 반환한다 → 반대로 넣으면 새 번호로 한 참여가 안 보인다. 방향이 계약이다.
 *
 * ══ 이관하는 키(옛 phone8 로만 매달려 있어 승격으로는 안 따라오는 것) ══
 *   cs_threads.reviewer_phone8 · campaign_reviewer_gates.phone8 · reviewer_campaign_editors.phone8
 *   + blacklist(전체 번호 키)는 **새 번호 행을 추가**한다(옛 행은 남긴다 = 번호를 갈아 차단을 회피하는 길 차단).
 *   ★ 셋 다 유니크 제약이 있으므로 **대상에 이미 행이 있으면 옮기지 않고 건수를 보고**한다(조용한 실패 금지).
 *   ★ 각 이관은 SAVEPOINT 로 격리 — 테이블 부재(42P01) 하나가 트랜잭션 전체를 abort(25P02) 시키지 않는다.
 *
 * ══ fail-closed 차단(완화 금지) ══
 *   ① 새 번호가 다른 reviewers 행 = UNIQUE(phone) 충돌(계정 병합 사고)
 *   ② 새 번호의 **뒤 8자리**가 다른 리뷰어와 겹침 — phone8 은 비유니크라 검색·계좌·로그인이 타인과 섞인다
 *   ③ 새 번호가 **다른 사람의 타계정**으로 등록됨(사칭·계좌 혼선)
 *   ④ 그 리뷰어에게 **유효한 홀드**가 있음 — 홀드는 phone8+hold_token 이중 열쇠라 번호가 바뀌면
 *      제출 확정이 막혀 참여가 소각된다(홀드는 10~15분이므로 끝난 뒤에 하면 된다)
 *   ⑤ 대상 지목은 언제나 **reviewers.id** — `WHERE phone8 =` 은 비유니크라 타인 행까지 함께 바꾼다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PhoneChangeError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
}

/** 숫자만 남긴다(registerReviewer 와 같은 정규화) */
function normPhone(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }
/** 뒤 8자리(= reviewers.phone8 파생식과 동일) */
function phone8of(v) { const d = normPhone(v); return d.length >= 8 ? d.slice(-8) : ''; }

/** 형식 검증 — 순수함수(등록과 같은 11자리 규칙) */
function validateNewPhone(oldPhone, newPhone) {
  const np = normPhone(newPhone);
  if (np.length !== 11) return { ok: false, code: 'bad_phone', error: '전화번호는 숫자 11자리여야 합니다.' };
  if (np === normPhone(oldPhone)) return { ok: false, code: 'same_phone', error: '지금과 같은 번호입니다.' };
  return { ok: true, phone: np, phone8: np.slice(-8) };
}

function parseSubs(v) {
  let subs = v;
  if (typeof subs === 'string') { try { subs = JSON.parse(subs); } catch (_) { subs = []; } }
  return Array.isArray(subs) ? subs : [];
}

/**
 * 옛 번호를 타계정으로 남기고, 승격된 새 번호 항목은 걷어낸다.
 * ★ 순수함수 — 같은 뒤 8자리 항목이 이미 있으면 추가하지 않는다(중복 금지 규칙은 프로필 저장과 동일).
 */
function buildSubAccounts(subs, { name, oldPhone, newPhone8 }) {
  const list = parseSubs(subs).filter(s => phone8of(s && s.phone) !== newPhone8);   // 승격분 제거
  const old8 = phone8of(oldPhone);
  if (old8 && !list.some(s => phone8of(s && s.phone) === old8)) {
    list.push({ name: String(name || '').trim(), phone: normPhone(oldPhone) });
  }
  return list;
}

/**
 * 읽기 프로브 — **트랜잭션 안에서는 SAVEPOINT 로 격리**한다.
 * ★ 진짜 PG16 검증에서 실제로 밟은 함정: 프로브 하나가 42703 으로 실패하면 그 뒤의 모든 쿼리가
 *   25P02(current transaction is aborted)로 죽어, "fail-soft 로 세지 못했을 뿐"이어야 할 집계 실패가
 *   **점검 전체를 무력화**한다(082 apply SAVEPOINT 규율과 같은 자리).
 */
async function _probe(db, sql, params) {
  const inTx = typeof db.release === 'function';   // pool 이 아니라 잠금 client
  if (!inTx) return db.query(sql, params);
  await db.query('SAVEPOINT rpc_probe');
  try { const r = await db.query(sql, params); await db.query('RELEASE SAVEPOINT rpc_probe'); return r; }
  catch (e) { await db.query('ROLLBACK TO SAVEPOINT rpc_probe'); throw e; }
}

/** 영향 건수(경고 재료) — 하나가 실패해도 나머지는 센다. */
async function _counts(db, p8, phone) {
  const counts = { orders: 0, applications: 0, inquiries: 0, reviewRows: 0, gates: 0, editors: 0, blacklisted: 0 };
  let partial = false;
  // ★ order_submissions 에는 phone8 컬럼이 없다(전체 번호 `phone` 뿐) — payment.service 와 같은 파생식으로 센다.
  //   `WHERE phone8 =` 로 적으면 42703 으로 항상 실패해 "구매양식 제출 0건"으로 조용히 속인다.
  const probes = [
    ['orders', `SELECT COUNT(*)::int AS n FROM order_submissions
                 WHERE RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 8) = $1
                   AND deleted_at IS NULL`, [p8]],
    ['applications', 'SELECT COUNT(*)::int AS n FROM campaign_applications WHERE phone8 = $1 OR owner_phone8 = $1', [p8]],
    ['inquiries', 'SELECT COUNT(*)::int AS n FROM cs_threads WHERE reviewer_phone8 = $1', [p8]],
    ['reviewRows', 'SELECT COUNT(*)::int AS n FROM review_index WHERE phone8 = $1', [p8]],
    ['gates', 'SELECT COUNT(*)::int AS n FROM campaign_reviewer_gates WHERE phone8 = $1 AND released_at IS NULL', [p8]],
    ['editors', 'SELECT COUNT(*)::int AS n FROM reviewer_campaign_editors WHERE phone8 = $1', [p8]],
    ['blacklisted', 'SELECT COUNT(*)::int AS n FROM blacklist WHERE phone = $1', [phone]],
  ];
  for (const [key, sql, params] of probes) {
    try { const { rows } = await _probe(db, sql, params); counts[key] = rows[0].n | 0; }
    catch (e) { partial = true; logger.warn(`[phoneChange] ${key} 집계 실패: ${e.message}`); }
  }
  return { counts, countsPartial: partial };
}

async function checkPhoneChange(db, { id, newPhone }) {
  if (!UUID_RE.test(String(id || '').trim())) throw new PhoneChangeError('bad_id', 'id(UUID)가 필요합니다.');
  const { rows } = await db.query(
    'SELECT id, name, phone, phone8, sub_accounts FROM reviewers WHERE id = $1', [String(id).trim()]);
  if (!rows.length) throw new PhoneChangeError('not_found', '해당 리뷰어를 찾을 수 없습니다.');
  const r = rows[0];

  const v = validateNewPhone(r.phone, newPhone);
  if (!v.ok) throw new PhoneChangeError(v.code, v.error);

  const blockers = [];
  // ① UNIQUE(phone) 충돌 / ② 뒤 8자리 타인 중복 — 한 쿼리로 본다(자기 자신 제외).
  const { rows: dup } = await db.query(
    `SELECT id, name, phone, phone8 FROM reviewers
      WHERE id <> $1 AND (phone = $2 OR phone8 = $3) LIMIT 5`, [r.id, v.phone, v.phone8]);
  for (const d of dup) {
    if (normPhone(d.phone) === v.phone) {
      blockers.push({ code: 'phone_taken', message: `그 번호는 이미 「${d.name}」 리뷰어의 번호입니다.` });
    } else {
      blockers.push({ code: 'phone8_taken', message: `뒤 8자리가 「${d.name}」 리뷰어와 겹칩니다 — 로그인·검색·계좌 매칭이 섞입니다.` });
    }
  }
  // ③ 새 번호가 다른 사람의 타계정으로 등록됨
  try {
    const { rows: subOwner } = await _probe(db,
      `SELECT name FROM reviewers r, jsonb_array_elements(
                CASE WHEN jsonb_typeof(r.sub_accounts)='array' THEN r.sub_accounts ELSE '[]'::jsonb END) s
        WHERE r.id <> $1
          AND RIGHT(regexp_replace(COALESCE(s->>'phone',''), '[^0-9]', '', 'g'), 8) = $2 LIMIT 1`,
      [r.id, v.phone8]);
    if (subOwner.length) {
      blockers.push({ code: 'sub_of_other', message: `그 번호는 「${subOwner[0].name}」 리뷰어의 타계정으로 등록돼 있습니다.` });
    }
  } catch (e) { logger.warn('[phoneChange] 타계정 중복 조회 실패: ' + e.message); }
  // ④ 유효 홀드(진행 중 참여) — 번호가 바뀌면 제출 확정이 막힌다
  try {
    const { rows: hold } = await _probe(db,
      `SELECT COUNT(*)::int AS n FROM campaign_applications
        WHERE status = 'applied' AND expires_at > NOW()
          AND (phone8 = $1 OR owner_phone8 = $1)`, [r.phone8]);
    if ((hold[0].n | 0) > 0) {
      blockers.push({ code: 'active_hold', message: `진행 중인 참여(자리 확보) ${hold[0].n}건이 있습니다 — 구매·제출이 끝난 뒤에 변경하세요.` });
    }
  } catch (e) { logger.warn('[phoneChange] 유효 홀드 조회 실패: ' + e.message); }

  const { counts, countsPartial } = await _counts(db, r.phone8, normPhone(r.phone));
  return {
    reviewer: { id: r.id, name: r.name, phone: r.phone, phone8: r.phone8, subAccounts: parseSubs(r.sub_accounts) },
    newPhone: v.phone, newPhone8: v.phone8, blockers, counts, countsPartial,
  };
}

/** SAVEPOINT 격리 실행 — 테이블 부재·제약 위반이 트랜잭션 전체를 죽이지 않게 한다. */
async function _isolated(client, name, fn) {
  await client.query(`SAVEPOINT ${name}`);
  try { const out = await fn(); await client.query(`RELEASE SAVEPOINT ${name}`); return out; }
  catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    logger.warn(`[phoneChange] ${name} 이관 실패(격리): ${e.message}`);
    return { failed: true, error: e.message };
  }
}

/**
 * 실제 변경 — 한 트랜잭션. 대상 행 FOR UPDATE 후 **점검을 다시 돌린다**(TOCTOU).
 * blockers 가 하나라도 있으면 쓰기 0으로 거부한다(force 우회 없음 — 전부 "그대로 두면 데이터가 어긋나는" 조건).
 */
async function applyPhoneChange({ id, newPhone, by }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lock } = await client.query('SELECT id FROM reviewers WHERE id = $1 FOR UPDATE', [String(id || '').trim()]);
    if (!lock.length) throw new PhoneChangeError('not_found', '해당 리뷰어를 찾을 수 없습니다.');

    const pre = await checkPhoneChange(client, { id, newPhone });
    if (pre.blockers.length) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'blocked', blockers: pre.blockers, counts: pre.counts, reviewer: pre.reviewer };
    }

    const r = pre.reviewer;
    const old8 = r.phone8, new8 = pre.newPhone8;
    const subs = buildSubAccounts(r.subAccounts, { name: r.name, oldPhone: r.phone, newPhone8: new8 });

    // 본계정 승격 + 옛 번호를 타계정으로 (대상은 언제나 id)
    const { rowCount } = await client.query(
      'UPDATE reviewers SET phone = $2, sub_accounts = $3::jsonb WHERE id = $1',
      [r.id, pre.newPhone, JSON.stringify(subs)]);
    if (!rowCount) throw new PhoneChangeError('not_found', '해당 리뷰어를 찾을 수 없습니다.');

    // ── 키 이관(전부 SAVEPOINT 격리 · 대상에 이미 행이 있으면 남기고 보고) ──
    const moved = {};
    moved.inquiries = await _isolated(client, 'mv_cs', async () => {
      const a = await client.query(
        `UPDATE cs_threads t SET reviewer_phone8 = $2
          WHERE t.reviewer_phone8 = $1
            AND NOT EXISTS (SELECT 1 FROM cs_threads x
                             WHERE x.reviewer_phone8 = $2 AND x.campaign_key = t.campaign_key)`, [old8, new8]);
      const b = await client.query('SELECT COUNT(*)::int AS n FROM cs_threads WHERE reviewer_phone8 = $1', [old8]);
      return { moved: a.rowCount, kept: b.rows[0].n | 0 };
    });
    moved.gates = await _isolated(client, 'mv_gate', async () => {
      const a = await client.query(
        `UPDATE campaign_reviewer_gates g SET phone8 = $2
          WHERE g.phone8 = $1 AND g.released_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM campaign_reviewer_gates x
                             WHERE x.phone8 = $2 AND x.campaign_id = g.campaign_id AND x.released_at IS NULL)`,
        [old8, new8]);
      const b = await client.query(
        'SELECT COUNT(*)::int AS n FROM campaign_reviewer_gates WHERE phone8 = $1 AND released_at IS NULL', [old8]);
      return { moved: a.rowCount, kept: b.rows[0].n | 0 };
    });
    moved.editors = await _isolated(client, 'mv_ed', async () => {
      const a = await client.query(
        `UPDATE reviewer_campaign_editors e SET phone8 = $2, updated_at = NOW()
          WHERE e.phone8 = $1
            AND NOT EXISTS (SELECT 1 FROM reviewer_campaign_editors x WHERE x.phone8 = $2)`, [old8, new8]);
      return { moved: a.rowCount };
    });
    // 블랙리스트는 **옮기지 않고 새 번호를 추가**한다 — 번호를 갈아 차단을 회피하는 길을 열지 않는다.
    moved.blacklist = await _isolated(client, 'mv_bl', async () => {
      const a = await client.query(
        `INSERT INTO blacklist (phone, name, reason, added_by)
         SELECT $2, name, COALESCE(NULLIF(reason,''), '') || ' (번호변경 승계: ' || $1 || ')', $3
           FROM blacklist WHERE phone = $1
         ON CONFLICT (phone) DO NOTHING`, [normPhone(r.phone), pre.newPhone, String(by || '')]);
      return { added: a.rowCount };
    });

    await _isolated(client, 'mv_log', async () => client.query(
      `INSERT INTO reviewer_phone_changes
         (reviewer_id, reviewer_name, old_phone, new_phone, old_phone8, new_phone8, moved, counts, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [r.id, r.name || '', normPhone(r.phone), pre.newPhone, old8, new8,
       JSON.stringify(moved), JSON.stringify(pre.counts), String(by || '')]));

    await client.query('COMMIT');
    logger.warn(`[phoneChange] ${by} 가 리뷰어 번호 변경 — ${r.name} ${r.phone} → ${pre.newPhone} (이관 ${JSON.stringify(moved)})`);
    return { ok: true, reviewer: { id: r.id, name: r.name }, oldPhone: normPhone(r.phone), newPhone: pre.newPhone,
             subAccounts: subs, moved, counts: pre.counts };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

/** 미리보기(쓰기 0) — 라우트가 confirm 없이 부를 때. */
async function previewPhoneChange({ id, newPhone }) {
  return { ...(await checkPhoneChange(pool, { id, newPhone })), preview: true };
}

module.exports = {
  PhoneChangeError, normPhone, phone8of, validateNewPhone, buildSubAccounts,
  checkPhoneChange, previewPhoneChange, applyPhoneChange,
};
