/*
 * 리뷰어 소유자/실참여자 코드 — Phase 1의 유일한 쓰기 출처.
 *
 * 이 서비스는 기존 phone8 신원 판정의 대체가 아니다. 코드가 없는 레코드는 기존 흐름 그대로이고,
 * bootstrap은 환경변수로 명시적으로 열었을 때에도 한 소유자씩만 처리한다. 그 덕분에 전역 전화번호
 * 충돌이나 비정상 sub_accounts를 발견했을 때 자동으로 잘못된 소유관계를 만들지 않는다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ReviewerIdentityError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function normalizePhone(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function toPhone8(value) {
  const digits = normalizePhone(value);
  return digits.length >= 8 ? digits.slice(-8) : '';
}

function formatOwnerCode(no) {
  const n = Number(no);
  if (!Number.isSafeInteger(n) || n < 1) return '';
  return String(n).padStart(4, '0');
}

function formatIdentityCode(ownerNo, memberNo) {
  const owner = formatOwnerCode(ownerNo);
  const member = Number(memberNo);
  return owner && Number.isSafeInteger(member) && member >= 0 ? `${owner}-${member}` : '';
}

function asSubAccounts(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return asSubAccounts(JSON.parse(value)); } catch (_) { return []; }
  }
  return [];
}

function buildIdentitySeeds(reviewer) {
  const raw = [{ name: reviewer && reviewer.name, phone: reviewer && reviewer.phone, memberNo: 0, source: 'primary' }];
  asSubAccounts(reviewer && reviewer.sub_accounts).forEach((sub, index) => {
    raw.push({ name: sub && sub.name, phone: sub && sub.phone, memberNo: index + 1, source: 'sub' });
  });

  const issues = [];
  const seen = new Set();
  const seeds = raw.map((entry) => {
    const name = String(entry.name || '').trim();
    const phone = String(entry.phone || '').trim();
    const phone8 = toPhone8(phone);
    if (!name) issues.push({ code: 'missing_name', memberNo: entry.memberNo });
    if (!phone8) issues.push({ code: 'invalid_phone', memberNo: entry.memberNo });
    if (phone8 && seen.has(phone8)) issues.push({ code: 'duplicate_phone_in_owner', memberNo: entry.memberNo, phone8 });
    if (phone8) seen.add(phone8);
    return { ...entry, name, phone, phone8 };
  });
  return { seeds, issues };
}

function isBootstrapEnabled() {
  return process.env.REVIEWER_IDENTITY_BOOTSTRAP_ENABLED === 'true';
}

// 새 쓰기에서 코드 FK를 채우는 스위치. 기본값 false라 migration/코드만 배포해도
// 기존 phone8 기반 주문·참여 흐름은 바뀌지 않는다. 전체 dry-run과 충돌정리 후에만 켠다.
function isWriteEnabled() {
  return process.env.REVIEWER_IDENTITY_WRITE_ENABLED === 'true';
}

function isChangeEnabled() {
  return process.env.REVIEWER_IDENTITY_CHANGE_ENABLED === 'true';
}

function _globalPhoneConflicts(rows) {
  const ownersByPhone8 = new Map();
  for (const reviewer of rows) {
    const { seeds } = buildIdentitySeeds(reviewer);
    for (const seed of seeds) {
      if (!seed.phone8) continue;
      const owners = ownersByPhone8.get(seed.phone8) || new Set();
      owners.add(String(reviewer.id));
      ownersByPhone8.set(seed.phone8, owners);
    }
  }
  return [...ownersByPhone8.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([phone8, owners]) => ({ code: 'phone8_assigned_to_multiple_owners', phone8, ownerIds: [...owners] }));
}

async function previewBootstrap({ reviewerId } = {}) {
  if (reviewerId && !UUID_RE.test(String(reviewerId))) {
    throw new ReviewerIdentityError('bad_id', '리뷰어 id(UUID)가 올바르지 않습니다.');
  }
  const { rows } = await pool.query(
    `SELECT id, name, phone, phone8, sub_accounts, reviewer_no, registered_at
       FROM reviewers
      ${reviewerId ? 'WHERE id = $1' : ''}
      ORDER BY registered_at ASC NULLS LAST, id ASC`, reviewerId ? [reviewerId] : []
  );
  if (reviewerId && !rows.length) throw new ReviewerIdentityError('not_found', '등록 리뷰어를 찾을 수 없습니다.');

  // 단일 소유자 미리보기여도, 충돌 판정은 전체 등록DB를 기준으로 해야 한다.
  const allRows = reviewerId
    ? (await pool.query('SELECT id, name, phone, phone8, sub_accounts, reviewer_no FROM reviewers')).rows
    : rows;
  const globalConflicts = _globalPhoneConflicts(allRows);
  const conflictPhones = new Set(globalConflicts.map((item) => item.phone8));
  const existingCodes = new Map();
  for (const row of allRows) {
    if (row.reviewer_no == null) continue;
    const key = String(row.reviewer_no);
    const list = existingCodes.get(key) || [];
    list.push(String(row.id));
    existingCodes.set(key, list);
  }

  const details = rows.map((reviewer) => {
    const { seeds, issues } = buildIdentitySeeds(reviewer);
    for (const seed of seeds) {
      if (seed.phone8 && conflictPhones.has(seed.phone8)) issues.push({ code: 'phone8_conflicts_with_other_owner', memberNo: seed.memberNo, phone8: seed.phone8 });
    }
    const duplicatedCode = reviewer.reviewer_no != null && (existingCodes.get(String(reviewer.reviewer_no)) || []).length > 1;
    if (duplicatedCode) issues.push({ code: 'duplicate_owner_code', reviewerNo: reviewer.reviewer_no });
    return {
      reviewerId: reviewer.id,
      reviewerNo: reviewer.reviewer_no,
      ownerCode: formatOwnerCode(reviewer.reviewer_no),
      identityCandidates: seeds.map((seed) => ({
        memberNo: seed.memberNo, code: formatIdentityCode(reviewer.reviewer_no, seed.memberNo), name: seed.name,
        phone8: seed.phone8, source: seed.source,
      })),
      ready: issues.length === 0,
      issues,
    };
  });
  const summary = {
    reviewers: details.length,
    readyOwners: details.filter((x) => x.ready).length,
    blockedOwners: details.filter((x) => !x.ready).length,
    missingOwnerCodes: details.filter((x) => x.reviewerNo == null).length,
    identityCandidates: details.reduce((n, x) => n + x.identityCandidates.length, 0),
    globalPhoneConflicts: globalConflicts.length,
  };
  return { preview: true, bootstrapEnabled: isBootstrapEnabled(), summary, globalConflicts, reviewers: details };
}

async function _assertNoExternalPhoneConflict(client, reviewerId, seeds) {
  const phones = seeds.map((seed) => seed.phone8).filter(Boolean);
  const { rows } = await client.query(
    `SELECT id, name, phone, phone8, sub_accounts FROM reviewers WHERE id <> $1`, [reviewerId]
  );
  const conflicts = [];
  for (const other of rows) {
    const { seeds: otherSeeds } = buildIdentitySeeds(other);
    for (const seed of otherSeeds) {
      if (phones.includes(seed.phone8)) conflicts.push({ phone8: seed.phone8, reviewerId: other.id });
    }
  }
  if (conflicts.length) {
    throw new ReviewerIdentityError('phone8_conflict', '다른 소유자와 번호가 겹쳐 코드 등록을 중단했습니다.', { conflicts });
  }
}

async function bootstrapOne({ reviewerId, by = 'admin' }) {
  if (!isBootstrapEnabled()) {
    throw new ReviewerIdentityError('bootstrap_disabled', '코드 등록은 아직 비활성화 상태입니다. REVIEWER_IDENTITY_BOOTSTRAP_ENABLED=true 승인 후에만 실행할 수 있습니다.');
  }
  if (!UUID_RE.test(String(reviewerId || ''))) throw new ReviewerIdentityError('bad_id', '리뷰어 id(UUID)가 올바르지 않습니다.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, name, phone, phone8, sub_accounts, reviewer_no FROM reviewers WHERE id = $1 FOR UPDATE`, [reviewerId]
    );
    if (!rows.length) throw new ReviewerIdentityError('not_found', '등록 리뷰어를 찾을 수 없습니다.');
    const reviewer = rows[0];
    const { seeds, issues } = buildIdentitySeeds(reviewer);
    if (issues.length) throw new ReviewerIdentityError('invalid_identity_seed', '이름 또는 번호가 비어 있거나 중복되어 코드 등록을 중단했습니다.', { issues });
    await _assertNoExternalPhoneConflict(client, reviewer.id, seeds);

    let reviewerNo = reviewer.reviewer_no;
    if (reviewerNo == null) {
      // 수동/복구 과정에서 기존 번호가 sequence보다 큰 경우에도 충돌하지 않게, 코드 배정만은
      // 전역 advisory lock으로 직렬화한다. reviewer 행 락만으로는 두 다른 소유자가 동시 배정할 수 있다.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('reviewer_identity_code_assignment'))`);
      const max = await client.query('SELECT COALESCE(MAX(reviewer_no), 0)::bigint AS n FROM reviewers');
      const next = await client.query(`SELECT nextval('reviewer_code_seq')::bigint AS reviewer_no`);
      reviewerNo = Math.max(Number(max.rows[0].n) + 1, Number(next.rows[0].reviewer_no));
      if (reviewerNo !== Number(next.rows[0].reviewer_no)) {
        await client.query(`SELECT setval('reviewer_code_seq', $1::bigint, true)`, [reviewerNo]);
      }
      await client.query('UPDATE reviewers SET reviewer_no = $2 WHERE id = $1 AND reviewer_no IS NULL', [reviewer.id, reviewerNo]);
    }

    const { rows: existing } = await client.query(
      `SELECT member_no, current_name, current_phone8 FROM reviewer_identities WHERE owner_reviewer_id = $1 FOR UPDATE`, [reviewer.id]
    );
    if (existing.length) {
      const byMember = new Map(existing.map((identity) => [Number(identity.member_no), identity]));
      const mismatch = seeds.find((seed) => {
        const identity = byMember.get(seed.memberNo);
        return !identity || identity.current_name !== seed.name || identity.current_phone8 !== seed.phone8;
      }) || (existing.length !== seeds.length);
      if (mismatch) throw new ReviewerIdentityError('identity_seed_mismatch', '이미 등록된 코드 신원과 현재 등록정보가 달라 자동 덮어쓰기를 중단했습니다. 이름 및 번호변경 절차로 처리해주세요.');
    } else {
      for (const seed of seeds) {
        const { rows: inserted } = await client.query(
          `INSERT INTO reviewer_identities
             (owner_reviewer_id, member_no, current_name, current_phone, current_phone8, source)
           VALUES ($1, $2, $3, $4, $5, 'bootstrap') RETURNING id`,
          [reviewer.id, seed.memberNo, seed.name, seed.phone, seed.phone8]
        );
        await client.query(
          `INSERT INTO reviewer_identity_aliases (identity_id, name, phone, phone8, reason)
           VALUES ($1, $2, $3, $4, 'initial')`, [inserted[0].id, seed.name, seed.phone, seed.phone8]
        );
      }
    }
    const { rows: identities } = await client.query(
      `SELECT id, member_no AS "memberNo", current_name AS name, current_phone8 AS "phone8", status
         FROM reviewer_identities WHERE owner_reviewer_id = $1 ORDER BY member_no`, [reviewer.id]
    );
    await client.query('COMMIT');
    const out = {
      reviewerId: reviewer.id, reviewerNo, ownerCode: formatOwnerCode(reviewerNo),
      identities: identities.map((identity) => ({ ...identity, code: formatIdentityCode(reviewerNo, identity.memberNo) })),
    };
    logger.info(`[reviewer-identity] bootstrap ${String(by).slice(0, 100)} owner=${reviewer.id} code=${out.ownerCode}`);
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally {
    client.release();
  }
}

async function listForOwner(reviewerId) {
  if (!UUID_RE.test(String(reviewerId || ''))) throw new ReviewerIdentityError('bad_id', '리뷰어 id(UUID)가 올바르지 않습니다.');
  const { rows } = await pool.query(
    `SELECT r.reviewer_no AS "reviewerNo", i.id, i.member_no AS "memberNo", i.current_name AS name,
            i.current_phone8 AS "phone8", i.status
       FROM reviewers r LEFT JOIN reviewer_identities i ON i.owner_reviewer_id = r.id
      WHERE r.id = $1 ORDER BY i.member_no`, [reviewerId]
  );
  if (!rows.length) throw new ReviewerIdentityError('not_found', '등록 리뷰어를 찾을 수 없습니다.');
  const reviewerNo = rows[0].reviewerNo;
  return {
    reviewerNo, ownerCode: formatOwnerCode(reviewerNo),
    identities: rows.filter((row) => row.id).map((row) => ({ ...row, code: formatIdentityCode(reviewerNo, row.memberNo) })),
  };
}

function _validateChangeInput({ memberNo, name, phone }) {
  const no = Number(memberNo);
  const cleanName = String(name || '').trim();
  const cleanPhone = String(phone || '').trim();
  if (!Number.isSafeInteger(no) || no < 0) throw new ReviewerIdentityError('bad_member_no', '참여자 번호가 올바르지 않습니다.');
  if (!cleanName || cleanName.length > 100) throw new ReviewerIdentityError('bad_name', '이름을 1~100자로 입력해주세요.');
  if (!toPhone8(cleanPhone)) throw new ReviewerIdentityError('bad_phone', '연락처를 정확히 입력해주세요.');
  return { memberNo: no, name: cleanName, phone: cleanPhone, phone8: toPhone8(cleanPhone) };
}

async function previewIdentityChange({ reviewerId, memberNo, name, phone }) {
  if (!UUID_RE.test(String(reviewerId || ''))) throw new ReviewerIdentityError('bad_id', '리뷰어 id(UUID)가 올바르지 않습니다.');
  const wanted = _validateChangeInput({ memberNo, name, phone });
  const { rows } = await pool.query(
    `SELECT r.id, r.reviewer_no, i.id AS identity_id, i.current_name, i.current_phone, i.current_phone8, i.status
       FROM reviewers r JOIN reviewer_identities i ON i.owner_reviewer_id = r.id
      WHERE r.id = $1 AND i.member_no = $2`, [reviewerId, wanted.memberNo]
  );
  if (!rows.length) throw new ReviewerIdentityError('identity_not_found', '코드가 부여된 실제 참여자를 찾을 수 없습니다.');
  const row = rows[0];
  return {
    preview: true,
    changeEnabled: isChangeEnabled(),
    reviewerNo: row.reviewer_no,
    code: formatIdentityCode(row.reviewer_no, wanted.memberNo),
    current: { name: row.current_name, phone: row.current_phone, phone8: row.current_phone8 },
    requested: { name: wanted.name, phone: wanted.phone, phone8: wanted.phone8 },
    changes: { name: row.current_name !== wanted.name, phone: row.current_phone8 !== wanted.phone8 },
  };
}

async function applyIdentityChange({ reviewerId, memberNo, name, phone, by = 'admin' }) {
  if (!isChangeEnabled()) throw new ReviewerIdentityError('change_disabled', '이름 및 번호 변경은 아직 비활성화 상태입니다. REVIEWER_IDENTITY_CHANGE_ENABLED=true 승인 후에만 실행할 수 있습니다.');
  if (!UUID_RE.test(String(reviewerId || ''))) throw new ReviewerIdentityError('bad_id', '리뷰어 id(UUID)가 올바르지 않습니다.');
  const wanted = _validateChangeInput({ memberNo, name, phone });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, name, phone, phone8, sub_accounts, reviewer_no FROM reviewers WHERE id = $1 FOR UPDATE`, [reviewerId]
    );
    if (!rows.length) throw new ReviewerIdentityError('not_found', '등록 리뷰어를 찾을 수 없습니다.');
    const reviewer = rows[0];
    const identities = await client.query(
      `SELECT id, member_no, current_name, current_phone8, status
         FROM reviewer_identities WHERE owner_reviewer_id = $1 AND member_no = $2 FOR UPDATE`, [reviewerId, wanted.memberNo]
    );
    if (!identities.rows.length) throw new ReviewerIdentityError('identity_not_found', '코드가 부여된 실제 참여자를 찾을 수 없습니다.');
    const identity = identities.rows[0];
    if (identity.status !== 'active') throw new ReviewerIdentityError('identity_inactive', '활성 상태가 아닌 참여자는 이름 및 번호를 변경할 수 없습니다.');
    if (identity.current_name === wanted.name && identity.current_phone8 === wanted.phone8) {
      throw new ReviewerIdentityError('no_change', '변경된 이름이나 번호가 없습니다.');
    }

    const draft = { ...reviewer };
    if (wanted.memberNo === 0) {
      draft.name = wanted.name; draft.phone = wanted.phone;
    } else {
      const subs = asSubAccounts(reviewer.sub_accounts);
      const index = wanted.memberNo - 1;
      if (!subs[index]) throw new ReviewerIdentityError('identity_seed_mismatch', '기존 타계정 순서가 코드 신원과 달라 변경을 중단했습니다.');
      // member_no는 bootstrap 당시 배열 위치가 아니라 **그 위치의 당시 신원과 함께** 유효하다.
      // 기존 프로필 화면에서 앞 행을 삭제/재정렬하면 위치만으로는 다른 사람을 덮어쓸 수 있으므로,
      // 잠근 identity의 현재 name+phone8과 일치하지 않으면 자동 변경을 중단한다.
      if (String(subs[index].name || '').trim() !== String(identity.current_name || '').trim()
          || toPhone8(subs[index].phone) !== toPhone8(identity.current_phone8)) {
        throw new ReviewerIdentityError('identity_seed_mismatch', '타계정 목록이 코드 신원과 달라 변경을 중단했습니다. 타계정 코드를 다시 점검해주세요.');
      }
      subs[index] = { ...subs[index], name: wanted.name, phone: wanted.phone };
      draft.sub_accounts = subs;
    }
    const { issues } = buildIdentitySeeds(draft);
    if (issues.length) throw new ReviewerIdentityError('invalid_identity_seed', '변경 후 신원 구성이 유효하지 않아 중단했습니다.', { issues });
    await _assertNoExternalPhoneConflict(client, reviewerId, buildIdentitySeeds(draft).seeds);
    const aliases = await client.query(
      `SELECT 1 FROM reviewer_identity_aliases a JOIN reviewer_identities i ON i.id = a.identity_id
        WHERE a.phone8 = $1 AND a.valid_to IS NULL AND i.owner_reviewer_id <> $2 LIMIT 1`, [wanted.phone8, reviewerId]
    );
    if (aliases.rows.length) throw new ReviewerIdentityError('phone8_conflict', '다른 소유자의 현재 또는 보존 번호와 겹쳐 변경을 중단했습니다.');

    // 열린 별칭을 닫고 새 값을 하나 더한다. 기존 행을 덮어쓰지 않아 과거 phone8/name 링크의
    // 의미가 사라지지 않는다. 같은 번호로 이름만 바꿔도 스냅샷이 남는다.
    await client.query(`UPDATE reviewer_identity_aliases SET valid_to = NOW() WHERE identity_id = $1 AND valid_to IS NULL`, [identity.id]);
    await client.query(
      `INSERT INTO reviewer_identity_aliases (identity_id, name, phone, phone8, reason)
       VALUES ($1,$2,$3,$4,'admin_change')`, [identity.id, wanted.name, wanted.phone, wanted.phone8]
    );
    await client.query(
      `UPDATE reviewer_identities
          SET current_name=$2, current_phone=$3, current_phone8=$4, updated_at=NOW()
        WHERE id=$1`, [identity.id, wanted.name, wanted.phone, wanted.phone8]
    );
    if (wanted.memberNo === 0) {
      await client.query(`UPDATE reviewers SET name=$2, phone=$3 WHERE id=$1`, [reviewerId, wanted.name, wanted.phone]);
    } else {
      await client.query(`UPDATE reviewers SET sub_accounts=$2::jsonb WHERE id=$1`, [reviewerId, JSON.stringify(draft.sub_accounts)]);
    }
    await client.query('COMMIT');
    const out = { reviewerNo: reviewer.reviewer_no, code: formatIdentityCode(reviewer.reviewer_no, wanted.memberNo), previous: {
      name: identity.current_name, phone8: identity.current_phone8,
    }, current: { name: wanted.name, phone: wanted.phone, phone8: wanted.phone8 } };
    logger.info(`[reviewer-identity] change ${String(by).slice(0, 100)} owner=${reviewerId} code=${out.code}`);
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally {
    client.release();
  }
}

// 참여 당시 실제 명의(phone8)에서 코드 신원을 찾는다. 소유자 id를 함께 주면 타소유자와
// 같은 번호가 생긴 비정상 데이터도 절대 다른 소유자로 귀속하지 않는다.
async function resolveParticipantIdentity({ client = pool, ownerReviewerId, participantPhone8 } = {}) {
  const phone8 = toPhone8(participantPhone8);
  if (!phone8 || !ownerReviewerId) return null;
  const { rows } = await client.query(
    `SELECT i.id, i.owner_reviewer_id AS "ownerReviewerId", i.member_no AS "memberNo"
       FROM reviewer_identities i
      WHERE i.owner_reviewer_id = $1 AND i.current_phone8 = $2 AND i.status = 'active'
      LIMIT 2`, [ownerReviewerId, phone8]
  );
  if (rows.length !== 1) return null;
  return rows[0];
}

// 소유자 로그인(본계정)에서 보여줄 전체 명의 범위. 코드 활성 전에도 기존 sub_accounts로
// 동일한 조회 범위를 유지한다. 닫힌 별칭은 "예전 번호"일 뿐 다른 소유자에게 재등록될 수 있으므로
// phone8 단독 조회 범위에 절대 넣지 않는다. 코드가 켜진 뒤의 과거 행은 owner/participant FK로만
// 합산해야 한다(번호 재사용 시 남의 주문/참여 이력이 섞이는 정보노출 방지).
async function getOwnerScopeByLoginPhone8(loginPhone8) {
  const phone8 = toPhone8(loginPhone8);
  if (!phone8) return { phone8s: [] };
  const { rows } = await pool.query(
    `SELECT id, reviewer_no, phone8, sub_accounts FROM reviewers WHERE phone8 = $1 LIMIT 2`, [phone8]
  );
  if (rows.length !== 1) return { phone8s: [phone8], legacy: true };
  const owner = rows[0];
  const phones = new Set([phone8]);
  for (const sub of asSubAccounts(owner.sub_accounts)) {
    const p8 = toPhone8(sub && sub.phone);
    if (p8) phones.add(p8);
  }
  try {
    const identityRows = await pool.query(
      `SELECT i.id, i.current_phone8
         FROM reviewer_identities i
        WHERE i.owner_reviewer_id = $1 AND i.status <> 'separated'`, [owner.id]
    );
    for (const row of identityRows.rows) {
      const current = toPhone8(row.current_phone8);
      if (current) phones.add(current);
    }
  } catch (err) {
    // rollout 중 테이블이 아직 없다면 기존 범위로만 계속 응답한다.
    if (err && err.code !== '42P01') throw err;
  }
  return { ownerReviewerId: owner.id, reviewerNo: owner.reviewer_no, phone8s: [...phones], legacy: owner.reviewer_no == null };
}

module.exports = {
  ReviewerIdentityError, normalizePhone, toPhone8, formatOwnerCode, formatIdentityCode,
  buildIdentitySeeds, isBootstrapEnabled, isWriteEnabled, isChangeEnabled, previewBootstrap, bootstrapOne, listForOwner,
  previewIdentityChange, applyIdentityChange,
  resolveParticipantIdentity, getOwnerScopeByLoginPhone8,
};
