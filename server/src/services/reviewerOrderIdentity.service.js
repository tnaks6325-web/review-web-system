const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { addressSame, addressHeuristic, normAddress } = require('./identity.service');
const { logger } = require('../utils/logger');

const MASK_RE = /[*＊●○◯◉•·xX]/;
const MASK_RUN_RE = /[*＊●○◯◉•·xX]+/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSE_EXTRACT = 'reviewer_capture_extract';
const PURPOSE_MATCH_REVIEW = 'reviewer_identity_review';
const PURPOSE_APPROVAL = 'reviewer_identity_approval';

class ReviewerOrderIdentityError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

function isEnabled() {
  return process.env.REVIEWER_CAPTURE_IDENTITY_ENABLED === 'true';
}

function digits(value) { return String(value || '').replace(/\D/g, ''); }
function phone8(value) { const d = digits(value); return d.length >= 8 ? d.slice(-8) : d; }
function cleanName(value) { return String(value || '').replace(/\s+/g, '').trim(); }
function cleanShoppingId(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}
function asSubs(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return asSubs(JSON.parse(value)); } catch (_) { return []; } }
  return [];
}
function stableHash(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}
function fieldsObject(value = {}) {
  return {
    recipient: String(value.recipient || '').trim(),
    phone: String(value.phone || '').trim(),
    address: String(value.address || '').trim(),
    orderNumber: String(value.orderNumber || value.orderNum || '').trim(),
    price: String(value.price || '').trim(),
    orderer: String(value.orderer || '').trim(),
    store: String(value.store || '').trim(),
  };
}
function fieldsHash(value) { return stableHash(JSON.stringify(fieldsObject(value))); }
function submissionIdentityHash(value = {}) {
  return stableHash(JSON.stringify({
    recipient: String(value.recipient || '').trim(),
    phone: String(value.phone || '').trim(),
    address: String(value.address || '').trim(),
  }));
}
function profileHash(identity) {
  return stableHash(JSON.stringify({
    identityKey: identity.identityKey,
    name: cleanName(identity.name),
    phone8: phone8(identity.phone),
    address: normAddress(identity.address),
  }));
}
function hashImageBase64(base64) {
  const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  return stableHash(clean);
}

function signScoped(payload, expiresIn) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    issuer: 'review-web-system', audience: 'reviewer-order-identity', expiresIn,
  });
}
function verifyScoped(token, purpose) {
  let payload;
  try {
    payload = jwt.verify(String(token || ''), process.env.JWT_SECRET, {
      issuer: 'review-web-system', audience: 'reviewer-order-identity',
    });
  } catch (err) {
    throw new ReviewerOrderIdentityError('IDENTITY_TOKEN_INVALID', err.name === 'TokenExpiredError'
      ? '명의 확인 시간이 만료되었습니다. 캡처를 다시 확인해주세요.'
      : '유효하지 않은 명의 확인 정보입니다.', 401);
  }
  if (!payload || payload.purpose !== purpose) {
    throw new ReviewerOrderIdentityError('IDENTITY_TOKEN_INVALID', '명의 확인 단계가 올바르지 않습니다.', 401);
  }
  return payload;
}

function issueExtractionProof({ imageHash, extracted, ok, errorCode = '' }) {
  const normalized = fieldsObject(extracted);
  const token = signScoped({
    purpose: PURPOSE_EXTRACT,
    imageHash: String(imageHash || ''),
    fieldsHash: fieldsHash(normalized),
    extractOk: !!ok,
    errorCode: String(errorCode || '').slice(0, 80),
  }, '15m');
  return { extractToken: token, imageHash: String(imageHash || ''), extractedFieldsHash: fieldsHash(normalized) };
}
function verifyExtractionProof(token, extracted) {
  const p = verifyScoped(token, PURPOSE_EXTRACT);
  if (p.fieldsHash !== fieldsHash(extracted)) {
    throw new ReviewerOrderIdentityError('EXTRACT_FIELDS_TAMPERED', 'AI 추출 결과가 변경되었습니다. 캡처를 다시 분석해주세요.', 409);
  }
  return p;
}

function legacyIdentityKey(name, phone, index) {
  return `sub:${stableHash(`${cleanName(name)}|${phone8(phone)}|${Number(index)}`).slice(0, 24)}`;
}

async function loadOwnerProfile(ownerReviewerId, db = pool) {
  if (!UUID_RE.test(String(ownerReviewerId || ''))) throw new ReviewerOrderIdentityError('REVIEWER_AUTH_INVALID', '리뷰어 소유자 정보가 올바르지 않습니다.', 401);
  const { rows } = await db.query(
    `SELECT id, name, phone, phone8, address, bank_name, bank_account, account_holder,
            sub_accounts, shopping_id, reviewer_no
       FROM reviewers WHERE id = $1 LIMIT 1`, [ownerReviewerId]
  );
  if (rows.length !== 1) throw new ReviewerOrderIdentityError('REVIEWER_NOT_FOUND', '등록된 리뷰어 정보를 찾을 수 없습니다.', 404);
  const owner = rows[0];
  owner.sub_accounts = asSubs(owner.sub_accounts);
  let coded = [];
  try {
    coded = (await db.query(
      `SELECT id, member_no, current_name, current_phone, current_phone8, shopping_id
         FROM reviewer_identities
        WHERE owner_reviewer_id = $1 AND status = 'active'
        ORDER BY member_no`, [owner.id]
    )).rows;
  } catch (err) {
    if (!err || !['42P01', '42703'].includes(err.code)) throw err;
  }
  const byMember = new Map(coded.map((row) => [Number(row.member_no), row]));
  const identities = [];
  const selfCode = byMember.get(0);
  identities.push({
    identityKey: selfCode ? `identity:${selfCode.id}` : 'self',
    participantIdentityId: selfCode && selfCode.id || null,
    memberNo: 0,
    type: 'self',
    name: selfCode && selfCode.current_name || owner.name || '',
    phone: selfCode && selfCode.current_phone || owner.phone || '',
    phone8: selfCode && selfCode.current_phone8 || owner.phone8 || phone8(owner.phone),
    address: owner.address || '',
    shoppingId: selfCode && selfCode.shopping_id || owner.shopping_id || '',
    bankName: owner.bank_name || '',
    bankAccount: owner.bank_account || '',
    accountHolder: owner.account_holder || '',
  });
  owner.sub_accounts.forEach((sub, index) => {
    const memberNo = index + 1;
    const code = byMember.get(memberNo);
    identities.push({
      identityKey: code ? `identity:${code.id}` : legacyIdentityKey(sub.name, sub.phone, index),
      participantIdentityId: code && code.id || null,
      memberNo,
      subIndex: index,
      type: 'sub',
      name: code && code.current_name || sub.name || '',
      phone: code && code.current_phone || sub.phone || '',
      phone8: code && code.current_phone8 || phone8(sub.phone),
      address: sub.address || '',
      shoppingId: code && code.shopping_id || sub.shoppingId || sub.shopping_id || '',
      bankName: sub.bankName || sub.bank_name || '',
      bankAccount: sub.bankAccount || sub.bank_account || '',
      accountHolder: sub.accountHolder || sub.account_holder || '',
    });
  });
  return { owner, identities };
}

function publicIdentity(identity, { includeBank = false } = {}) {
  const result = {
    identityKey: identity.identityKey,
    type: identity.type,
    name: identity.name,
    phone: identity.phone,
    address: identity.address,
    shoppingId: identity.shoppingId || '',
  };
  if (includeBank) {
    result.bankName = identity.bankName || '';
    result.bankAccount = identity.bankAccount || '';
    result.accountHolder = identity.accountHolder || '';
  }
  return result;
}

function orderInfoSuggestionId({ recipient, phone, address }) {
  return stableHash(JSON.stringify({
    recipient: cleanName(recipient).toLowerCase(),
    phone: digits(phone),
    address: normAddress(address),
  }));
}

/**
 * 현재 참여 명의가 과거에 실제 제출한 수취인·연락처·주소 조합을 최대 3개 반환한다.
 *
 * 명의 검증을 통과하며 원장에 고정된 소유자 UUID+참여 명의 해시를 우선 사용한다.
 * 그 값이 없는 과거 주문은 소유자/참여자 UUID가 신청행에 모두 고정된 경우만 허용한다.
 * 전화번호만 남은 레거시 주문은 번호 재할당 시 타인의 주소가 노출될 수 있어 제외한다.
 */
async function loadOrderInfoSuggestions(context, db = pool) {
  const selectedIdentityHash = context?.selected?.identityKey
    ? stableHash(context.selected.identityKey)
    : '';
  const participantIdentityId = UUID_RE.test(String(context?.selected?.participantIdentityId || ''))
    ? context.selected.participantIdentityId
    : null;
  if (!UUID_RE.test(String(context?.owner?.id || '')) || !selectedIdentityHash) return [];

  const { rows } = await db.query(
    `WITH eligible_orders AS (
       SELECT os.id
         FROM order_submissions os
        WHERE os.owner_reviewer_id = $1::uuid
          AND os.participant_identity_key_hash = $2
       UNION
       SELECT os.id
         FROM campaign_applications ca
         JOIN order_submissions os ON os.campaign_application_id = ca.id
        WHERE $3::uuid IS NOT NULL
          AND ca.owner_reviewer_id = $1::uuid
          AND ca.participant_identity_id = $3::uuid
     ), scoped AS (
       SELECT os.recipient, os.phone, os.address, os.submitted_at,
              LOWER(REGEXP_REPLACE(BTRIM(os.recipient), '\\s+', '', 'g')) AS recipient_key,
              REGEXP_REPLACE(os.phone, '\\D', '', 'g') AS phone_key,
              LOWER(BTRIM(REGEXP_REPLACE(
                TRANSLATE(BTRIM(os.address), '()[],./·', '        '), '\\s+', ' ', 'g'
              ))) AS address_key
         FROM eligible_orders eo
         JOIN order_submissions os ON os.id = eo.id
        WHERE os.deleted_at IS NULL
          AND os.source = 'order_submit'
          AND os.submitted_at >= NOW() - INTERVAL '365 days'
          AND NULLIF(BTRIM(os.recipient), '') IS NOT NULL
          AND LENGTH(REGEXP_REPLACE(COALESCE(os.phone, ''), '\\D', '', 'g')) BETWEEN 10 AND 11
          AND NULLIF(BTRIM(os.address), '') IS NOT NULL
          AND os.recipient !~ '[*＊●○◯◉•·xX]'
          AND os.address !~ '[*＊●○◯◉•·xX]'
     ), grouped AS (
       SELECT recipient_key, phone_key, address_key,
              COUNT(*)::int AS use_count,
              MAX(submitted_at) AS last_used_at,
              (ARRAY_AGG(recipient ORDER BY submitted_at DESC))[1] AS recipient,
              (ARRAY_AGG(phone ORDER BY submitted_at DESC))[1] AS phone,
              (ARRAY_AGG(address ORDER BY submitted_at DESC))[1] AS address
         FROM scoped
        GROUP BY recipient_key, phone_key, address_key
     )
     SELECT recipient, phone, address, use_count, last_used_at
       FROM grouped
      ORDER BY use_count DESC, last_used_at DESC
      LIMIT 3`,
    [context.owner.id, selectedIdentityHash, participantIdentityId]
  );
  return rows.map((row) => ({
    id: orderInfoSuggestionId(row),
    recipient: String(row.recipient || '').trim(),
    phone: String(row.phone || '').trim(),
    address: String(row.address || '').trim(),
    useCount: Number(row.use_count) || 1,
    lastUsedAt: row.last_used_at || null,
  }));
}

async function getSecureProfile(ownerReviewerId) {
  const { owner, identities } = await loadOwnerProfile(ownerReviewerId);
  return {
    ok: true,
    profile: {
      name: owner.name || '', phone: owner.phone || '', address: owner.address || '',
      bankName: owner.bank_name || '', bankAccount: owner.bank_account || '', accountHolder: owner.account_holder || '',
      identities: identities.map((identity) => publicIdentity(identity, { includeBank: true })),
    },
  };
}

async function saveShoppingId(ownerReviewerId, identityKey, shoppingId) {
  const value = cleanShoppingId(shoppingId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { owner, identities } = await loadOwnerProfile(ownerReviewerId, client);
    const matches = identities.filter((item) => item.identityKey === String(identityKey || ''));
    if (matches.length !== 1) throw new ReviewerOrderIdentityError('IDENTITY_NOT_FOUND', '저장할 명의를 찾을 수 없습니다.', 404);
    const selected = matches[0];
    if (selected.type === 'self') {
      await client.query('UPDATE reviewers SET shopping_id = $2 WHERE id = $1', [owner.id, value]);
    } else {
      const subs = asSubs(owner.sub_accounts);
      if (!subs[selected.subIndex]) throw new ReviewerOrderIdentityError('IDENTITY_CHANGED', '타계정 정보가 변경되었습니다. 화면을 새로고침해주세요.', 409);
      if (cleanName(subs[selected.subIndex].name) !== cleanName(selected.name)
          || phone8(subs[selected.subIndex].phone) !== phone8(selected.phone)) {
        throw new ReviewerOrderIdentityError('IDENTITY_CHANGED', '타계정 정보가 변경되었습니다. 화면을 새로고침해주세요.', 409);
      }
      subs[selected.subIndex] = { ...subs[selected.subIndex], shoppingId: value };
      await client.query('UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1', [owner.id, JSON.stringify(subs)]);
    }
    if (selected.participantIdentityId) {
      await client.query(
        'UPDATE reviewer_identities SET shopping_id = $2, updated_at = NOW() WHERE id = $1 AND owner_reviewer_id = $3',
        [selected.participantIdentityId, value, owner.id]
      );
    }
    await client.query('COMMIT');
    return { ok: true, identityKey: selected.identityKey, shoppingId: value };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

async function resolveApplicationIdentity({ ownerReviewerId, applicationId, campaignId, holdToken }, db = pool) {
  const { owner, identities } = await loadOwnerProfile(ownerReviewerId, db);
  const appId = Number(applicationId);
  if (!Number.isSafeInteger(appId) || appId < 1 || !campaignId || !holdToken) {
    throw new ReviewerOrderIdentityError('PARTICIPATION_CONTEXT_REQUIRED', '유효한 참여 정보를 찾을 수 없습니다.', 400);
  }
  const { rows } = await db.query(
    `SELECT ca.id, ca.campaign_id, ca.applicant_name, ca.applicant_phone, ca.phone8,
            ca.owner_phone8, ca.owner_reviewer_id, ca.participant_identity_id,
            ca.status, ca.expires_at, rc.multi_account_mode
       FROM campaign_applications ca
       JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
      WHERE ca.id = $1 AND ca.campaign_id = $2
        AND ca.hold_token = $3 AND ca.hold_token <> ''
      LIMIT 1`, [appId, String(campaignId), String(holdToken)]
  );
  if (rows.length !== 1) throw new ReviewerOrderIdentityError('PARTICIPATION_CONTEXT_INVALID', '참여 정보가 만료되었거나 일치하지 않습니다.', 403);
  const app = rows[0];
  if (app.owner_reviewer_id && String(app.owner_reviewer_id) !== String(owner.id)) {
    throw new ReviewerOrderIdentityError('PARTICIPATION_OWNER_MISMATCH', '다른 리뷰어의 참여 정보입니다.', 403);
  }
  if (app.owner_phone8 && phone8(app.owner_phone8) !== phone8(owner.phone8 || owner.phone)) {
    throw new ReviewerOrderIdentityError('PARTICIPATION_OWNER_MISMATCH', '참여 소유자 정보가 로그인과 일치하지 않습니다.', 403);
  }
  let candidates = [];
  if (app.participant_identity_id) {
    candidates = identities.filter((item) => String(item.participantIdentityId || '') === String(app.participant_identity_id));
  }
  if (!candidates.length) {
    const appName = cleanName(app.applicant_name);
    const appPhone = phone8(app.phone8 || app.applicant_phone);
    candidates = identities.filter((item) => cleanName(item.name) === appName && phone8(item.phone) === appPhone);
    // 과거 신청 건은 현재 등록 연락처와 다를 수 있다. 이름이 한 명으로 확정되면
    // 신청 연락처가 달라도 그 명의를 사용하고, 동명이인은 기존처럼 차단한다.
    if (!candidates.length && appName) candidates = identities.filter((item) => cleanName(item.name) === appName);
    if (!candidates.length && appPhone) candidates = identities.filter((item) => phone8(item.phone) === appPhone);
  }
  if (candidates.length !== 1) {
    throw new ReviewerOrderIdentityError('SELECTED_IDENTITY_AMBIGUOUS', '참여 시 선택한 명의를 하나로 확정할 수 없습니다. 내정보를 확인해주세요.', 409);
  }
  let selected = candidates[0];
  if (selected.type === 'sub' && !app.multi_account_mode) {
    throw new ReviewerOrderIdentityError(
      'SUB_ACCOUNT_NOT_ALLOWED',
      '이 공고는 타계정 참여가 허용되지 않습니다.',
      403
    );
  }
  if (selected.type === 'sub') {
    const applicationPhone = String(app.applicant_phone || '').trim();
    selected = {
      ...selected,
      phone: applicationPhone || selected.phone,
      phone8: phone8(app.phone8 || applicationPhone || selected.phone),
    };
  }
  return { owner, identities, application: app, selected };
}

function maskedCompatible(rawValue, storedValue, mode) {
  const raw = String(rawValue || '').trim();
  const stored = String(storedValue || '').trim();
  if (!raw || !stored || !MASK_RE.test(raw)) return false;
  const norm = (value) => {
    if (mode === 'phone') return String(value || '').replace(/[^0-9*＊●○◯◉•·xX]/g, '');
    if (mode === 'name') return String(value || '').replace(/\s+/g, '');
    return String(value || '').toLowerCase().replace(/[^0-9a-z가-힣*＊●○◯◉•·xX]/g, '');
  };
  const a = norm(raw), b = norm(stored);
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) if (!MASK_RE.test(a[i]) && a[i] !== b[i]) return false;
    return [...a].some((ch) => !MASK_RE.test(ch));
  }
  const visible = a.split(MASK_RE).filter(Boolean);
  return visible.length > 0 && visible.every((part) => b.includes(part));
}

function nameVerdict(raw, stored) {
  const a = cleanName(raw), b = cleanName(stored);
  if (!a || !b) return { verdict: 'uncertain', reason: '이름 정보 없음' };
  if (a === b || maskedCompatible(a, b, 'name')) return { verdict: 'match', reason: MASK_RE.test(a) ? '가림 이름 일치' : '이름 일치' };
  return { verdict: 'mismatch', reason: '이름 불일치' };
}

// 쿠팡처럼 가운데 글자를 가린 이름은 OCR이 노출된 한 글자만 잘못 읽을 수 있다.
// 이름 전체가 다른 경우와 구분하기 위해 길이와 위치를 유지한 채, 노출 글자 하나만
// 다르고 하나 이상은 실제 저장 명의와 같은 경우만 "가림 이름 OCR 근접오류"로 본다.
function maskedNameOcrNearMiss(raw, stored) {
  const a = cleanName(raw), b = cleanName(stored);
  if (!a || !b || a.length !== b.length || !MASK_RE.test(a)) return false;
  let visible = 0, matches = 0, mismatches = 0;
  for (let i = 0; i < a.length; i++) {
    if (MASK_RE.test(a[i])) continue;
    visible += 1;
    if (a[i] === b[i]) matches += 1;
    else mismatches += 1;
  }
  return visible >= 2 && matches >= 1 && mismatches === 1;
}

// 가림 없이 노출된 이름은 "한 글자" 오인식(바뀜·빠짐·더해짐 1개)까지만 재확인 후보로 둔다.
// ★ 사용자 확정 2026-09-24(결정 1가): 이름이 통째로 다르면(김수만→박철수) 막는다. 종전에는 차이 폭을
//   제한하지 않아, 남의 주문 캡처도 저장된 내 이름을 고르면 통과됐다(보고서 원인 3).
function nameEditDistance(a, b) {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}
function plainNameOcrCorrectionCandidate(raw, stored) {
  const a = cleanName(raw), b = cleanName(stored);
  return !!a && !!b && !MASK_RE.test(a) && a !== b && nameEditDistance(a, b) <= 1;
}

function canReviewMaskedNameOcrCorrection(selectedScore, selected, competingIdentity) {
  if (competingIdentity || !selectedScore || !selected) return false;
  const rawName = selectedScore.fields.recipient || selectedScore.fields.orderer;
  const rawAddress = String(selectedScore.fields.address || '').trim();
  const hardUnitConflict = selectedScore.parts.address.verdict === 'mismatch'
    && /호수|동 불일치/.test(String(selectedScore.parts.address.reason || ''));
  return selectedScore.parts.name.verdict === 'mismatch'
    && maskedNameOcrNearMiss(rawName, selected.name)
    // 쿠팡 연락처·주소는 가림이 정상이다. 주소 문자열 유사도는 건물명 생략 때문에
    // 낮을 수 있으므로 실제 동·호수 충돌만 하드 차단하고 저장정보 선택으로 재확인한다.
    && !!rawAddress && !hardUnitConflict;
}

function canReviewPlainNameOcrCorrection(selectedScore, selected, competingIdentity) {
  if (!selectedScore || !selected) return false;
  const rawName = selectedScore.fields.recipient || selectedScore.fields.orderer;
  // ★ 캡처 이름이 다른 저장 명의의 이름과 **정확히 맞으면** 오인식이 아니라 그 명의의 주문이다.
  //   빼면 한 글자 차이 이름(김민수/김민우)의 다른 명의 캡처가 확인 단계로 풀린다(PR #1485 리뷰 P1).
  //   ★ 경쟁 명의가 있다는 것만으로 막지 말 것 — 같은 번호·주소를 쓰는 가족 명의는 이름이 달라도
  //   두 칸이 맞아 경쟁자로 잡히므로, 본인 이름 한 글자 오인식의 정상 제출까지 막는다(PR #1486 리뷰 P1).
  if (competingIdentity && nameVerdict(rawName, competingIdentity.name).verdict === 'match') return false;
  return selectedScore.parts.name.verdict === 'mismatch'
    // 전체 이름 OCR 불일치는 주소나 다른 저장 명의와의 유사도만으로 즉시 막지 않는다.
    // 자동 승인은 금지하고, 아래 수동확인에서 현재 참여 명의 선택을 다시 검증한다.
    && plainNameOcrCorrectionCandidate(rawName, selected.name);
}
function phoneVerdict(raw, stored) {
  const a = String(raw || '').trim(), b = String(stored || '').trim();
  if (!a) return { verdict: 'contact', reason: '구매양식 연락처 정보 없음' };
  if (!b) return { verdict: 'contact', reason: '구매양식 연락처 사용' };
  if (digits(a) && phone8(a) === phone8(b)) return { verdict: 'match', reason: '연락처 일치' };
  if (maskedCompatible(a, b, 'phone')) return { verdict: 'match', reason: '가림 연락처 일치' };
  return { verdict: 'contact', reason: '구매양식 연락처 사용(등록 연락처와 달라도 허용)' };
}
function maskedAddressVerdict(raw, stored) {
  if (!raw || !stored) return { verdict: 'uncertain', score: 0, reason: '주소 정보 없음' };
  const rawNorm = normAddress(raw);
  const storedNorm = normAddress(stored);
  const visible = rawNorm.replace(MASK_RUN_RE, ' ').replace(/\s+/g, ' ').trim();
  const unitCheck = addressHeuristic(rawNorm.replace(MASK_RUN_RE, ' '), storedNorm);
  if (unitCheck.verdict === 'mismatch' && /호수|동 불일치/.test(unitCheck.reason)) return unitCheck;
  const tokens = visible.split(' ').filter((x) => x.length >= 2);
  const hits = tokens.filter((token) => storedNorm.includes(token));
  if (hits.length >= Math.min(2, tokens.length) && hits.length > 0) {
    return { verdict: 'match', score: tokens.length ? hits.length / tokens.length : 0, reason: '가림 주소의 노출 부분 일치' };
  }
  if (maskedCompatible(raw, stored, 'address')) return { verdict: 'match', score: 0.8, reason: '가림 주소 일치' };
  return { verdict: 'uncertain', score: 0, reason: '가림 주소의 노출 정보만으로 확정 어려움' };
}

async function scoreIdentity(extracted, identity, { useGemini = true } = {}) {
  const fields = fieldsObject(extracted);
  const name = nameVerdict(fields.recipient || fields.orderer, identity.name);
  const phone = phoneVerdict(fields.phone, identity.phone);
  let address;
  if (MASK_RE.test(fields.address)) address = maskedAddressVerdict(fields.address, identity.address);
  else address = await addressSame(fields.address, identity.address, { name: identity.name, phone: identity.phone, useGemini });
  const parts = { name, phone, address };
  // 연락처는 주문/배송 연락처이므로 같을 때만 보조 증거로 쓰고, 다르다는 이유로
  // 참여 명의를 거절하지 않는다. 이름·주소의 결정적 충돌은 계속 차단한다.
  const matches = Object.values(parts).filter((p) => p.verdict === 'match').length;
  const conflicts = Object.entries({ name, address })
    .filter(([, p]) => p.verdict === 'mismatch').map(([key, p]) => `${key}:${p.reason}`);
  const score = matches * 10 - conflicts.length * 20 + (address.score || 0);
  return { fields, parts, matches, conflicts, score };
}

function resolvedValue(raw, stored, mode, verdict) {
  const value = String(raw || '').trim();
  if (value && MASK_RE.test(value) && verdict === 'match'
      && (mode === 'address' || maskedCompatible(value, stored, mode))) return String(stored || '').trim();
  return value;
}

async function evaluateSelectedIdentity(extracted, selected, allIdentities, options = {}) {
  const selectedScore = await scoreIdentity(extracted, selected, options);
  let status = 'REVIEW';
  const reasonCodes = [];
  if (selectedScore.conflicts.length) {
    const addressConflict = selectedScore.parts.address.verdict === 'mismatch';
    // 배송지는 명의 자체가 아니다. 선택한 참여 명의의 이름이 맞으면 다른 동·호수도
    // 자동 승인 대신 주문 배송지를 직접 확인하게 한다. 다른 명의 경쟁검사는 유지한다.
    const deliveryAddressChanged = addressConflict
      && selectedScore.parts.name.verdict === 'match';
    status = deliveryAddressChanged || (!addressConflict && selectedScore.matches >= 2) ? 'REVIEW' : 'MISMATCH';
    reasonCodes.push(deliveryAddressChanged ? 'delivery_address_changed'
      : status === 'MISMATCH' ? 'selected_identity_conflict' : 'selected_identity_partial_conflict');
  } else if (selectedScore.matches >= 2) {
    status = 'MATCH';
  } else {
    reasonCodes.push('insufficient_independent_matches');
  }
  if (selectedScore.parts.phone.verdict === 'contact') {
    reasonCodes.push('delivery_contact_changed');
  }

  let competingIdentity = null;
  for (const identity of allIdentities) {
    if (identity.identityKey === selected.identityKey) continue;
    const other = await scoreIdentity(extracted, identity, { useGemini: false });
    // 같은 소유자 안에서 이름이 같은 명의 = 같은 사람의 중복 등록(실사고 2026-09-24: 번호만 다른
    // 두 칸 중 주소 빈 칸으로 참여 → 주소 있는 칸이 "다른 명의"로 잡혀 차단). 차단하지 않고
    // 사유만 남긴다 — 참여 명의 확인은 선택 명의 자체의 판정(REVIEW/수동확인)이 맡는다.
    if (cleanName(identity.name) && cleanName(identity.name) === cleanName(selected.name)) {
      if (other.matches >= 2 && !reasonCodes.includes('duplicate_name_identity')) reasonCodes.push('duplicate_name_identity');
      continue;
    }
    if (other.matches >= 2 && other.score >= selectedScore.score) {
      competingIdentity = identity;
      // 선택 명의 자체도 독립 필드 2개 이상 명확히 맞으면 중복 저장정보 때문에 생긴
      // 애매 판정이다. 사용자가 허용한 수동확인 경로로 보낸다. 선택 명의가 부족하거나
      // 충돌하는데 다른 명의가 맞는 경우만 결정적 오명의로 차단한다.
      if ((!selectedScore.conflicts.length && selectedScore.matches >= 2)
          || reasonCodes.includes('delivery_address_changed')) {
        status = 'REVIEW';
        reasonCodes.push('multiple_identity_candidates');
      } else {
        status = 'MISMATCH';
        reasonCodes.push('other_owner_identity_matches');
      }
      break;
    }
  }
  const nameOcrCorrectionCode = canReviewMaskedNameOcrCorrection(selectedScore, selected, competingIdentity)
    ? 'masked_name_ocr_correction'
    : (options.allowPlainNameCorrection
      && canReviewPlainNameOcrCorrection(selectedScore, selected, competingIdentity)
      ? 'plain_name_ocr_correction' : '');
  if (nameOcrCorrectionCode) {
    status = 'REVIEW';
    for (const code of ['selected_identity_conflict', 'selected_identity_partial_conflict']) {
      const conflictIndex = reasonCodes.indexOf(code);
      if (conflictIndex >= 0) reasonCodes.splice(conflictIndex, 1);
    }
    reasonCodes.push(nameOcrCorrectionCode);
    selectedScore.parts.name = {
      ...selectedScore.parts.name,
      reason: nameOcrCorrectionCode === 'masked_name_ocr_correction'
        ? '가림 이름의 노출 글자 1개가 다르게 인식됨'
        : '이름 1글자가 다르게 인식됨',
    };
  }
  const resolved = {
    recipient: resolvedValue(selectedScore.fields.recipient || selectedScore.fields.orderer, selected.name, 'name', selectedScore.parts.name.verdict),
    phone: resolvedValue(selectedScore.fields.phone, selected.phone, 'phone', selectedScore.parts.phone.verdict),
    address: resolvedValue(selectedScore.fields.address, selected.address, 'address', selectedScore.parts.address.verdict),
  };
  return { status, reasonCodes, selectedScore, competingIdentity, resolved };
}

async function audit({ context, status, approvalMode, reasonCodes, imageHash = '', extractedHash = '' }) {
  try {
    await pool.query(
      `INSERT INTO reviewer_identity_match_audits
         (campaign_application_id, owner_reviewer_id, participant_identity_id,
          selected_identity_hash, image_hash, extracted_fields_hash, status, approval_mode, reason_codes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [context.application.id, context.owner.id, context.selected.participantIdentityId,
       stableHash(context.selected.identityKey), imageHash, extractedHash,
       status, approvalMode, JSON.stringify(reasonCodes || [])]
    );
  } catch (err) {
    logger.warn(`[reviewer-order-identity] 감사기록 실패: ${err.message}`);
  }
}

function contextArgs(body, reviewer) {
  return {
    ownerReviewerId: reviewer.ownerReviewerId,
    applicationId: body.campaignApplicationId || body.applicationId,
    campaignId: body.campaignId,
    holdToken: body.holdToken,
  };
}

async function getParticipationIdentityContext(body, reviewer) {
  const context = await resolveApplicationIdentity(contextArgs(body, reviewer));
  const savedIdentities = context.selected.type === 'sub'
    ? [context.selected]
    : context.identities;
  let orderInfoSuggestions = [];
  try {
    orderInfoSuggestions = await loadOrderInfoSuggestions(context);
  } catch (err) {
    // 추천은 입력 편의 기능이다. 조회 장애로 구매양식 자체를 막지 않는다.
    logger.warn(`[reviewer-order-identity] 주문정보 추천 조회 실패(숨김): ${err.message}`);
  }
  return {
    ok: true, enabled: isEnabled(), multiAccountMode: !!context.application.multi_account_mode,
    selectedIdentity: publicIdentity(context.selected, { includeBank: true }),
    savedIdentities: savedIdentities.map((identity) => publicIdentity(identity, { includeBank: true })),
    orderInfoSuggestions,
  };
}

async function matchCapture(body, reviewer) {
  const context = await resolveApplicationIdentity(contextArgs(body, reviewer));
  const extract = verifyExtractionProof(body.extractToken, body.extracted || {});
  if (!extract.extractOk) throw new ReviewerOrderIdentityError('AI_EXTRACT_FAILED', 'AI 분석에 실패했습니다. 수동 확인을 선택할 수 있습니다.', 409);
  const verdict = await evaluateSelectedIdentity(body.extracted || {}, context.selected, context.identities, {
    useGemini: true, allowPlainNameCorrection: true,
  });
  let approvalToken = '';
  let reviewToken = '';
  if (verdict.status === 'MATCH') {
    approvalToken = signScoped({
      purpose: PURPOSE_APPROVAL, mode: 'matched', ownerReviewerId: context.owner.id,
      applicationId: context.application.id, campaignId: context.application.campaign_id,
      selectedIdentityHash: stableHash(context.selected.identityKey), profileHash: profileHash(context.selected),
      imageHash: extract.imageHash, extractedFieldsHash: extract.fieldsHash,
      submissionIdentityHash: submissionIdentityHash(verdict.resolved),
    }, '20m');
  } else if (verdict.status === 'REVIEW') {
    const requiredSavedFields = verdict.reasonCodes.some((code) =>
      ['masked_name_ocr_correction', 'plain_name_ocr_correction'].includes(code))
      ? ['recipient', 'phone', 'address'].filter((field) =>
        field === 'recipient' || MASK_RE.test(String(verdict.selectedScore.fields[field] || '')))
      : [];
    reviewToken = signScoped({
      purpose: PURPOSE_MATCH_REVIEW, ownerReviewerId: context.owner.id,
      applicationId: context.application.id, campaignId: context.application.campaign_id,
      selectedIdentityHash: stableHash(context.selected.identityKey), profileHash: profileHash(context.selected),
      imageHash: extract.imageHash, extractedFieldsHash: extract.fieldsHash,
      submissionIdentityHash: submissionIdentityHash(verdict.resolved),
      reasonCodes: verdict.reasonCodes,
      requiredSavedFields,
    }, '15m');
  }
  await audit({ context, status: verdict.status, approvalMode: verdict.status === 'MATCH' ? 'matched' : 'pending',
    reasonCodes: verdict.reasonCodes.concat(verdict.selectedScore.conflicts), imageHash: extract.imageHash, extractedHash: extract.fieldsHash });
  return {
    ok: true, status: verdict.status, reasonCodes: verdict.reasonCodes,
    reasons: Object.values(verdict.selectedScore.parts).map((p) => p.reason),
    checks: Object.entries(verdict.selectedScore.parts).map(([key, part]) => ({
      field: key === 'name' ? 'recipient' : key,
      // 연락처 차이는 안내/수정 요구 대상이 아니다. 제출값 자체는 승인토큰에 계속 결속한다.
      status: key === 'phone' && part.verdict === 'contact' ? 'match' : part.verdict,
      reason: part.reason,
    })),
    selectedIdentity: publicIdentity(context.selected), resolved: verdict.resolved,
    approvalToken, reviewToken,
  };
}

async function manualConfirm(body, reviewer) {
  if (body.manualConfirmed !== true) throw new ReviewerOrderIdentityError('MANUAL_CONFIRM_REQUIRED', '수동 확인에 동의해야 합니다.', 400);
  const context = await resolveApplicationIdentity(contextArgs(body, reviewer));
  const mode = String(body.mode || 'review');
  let imageHash = '', extractedHash = '', boundHash = submissionIdentityHash(body.formFields || {});
  let reasonCodes = [];
  if (mode === 'review') {
    const review = verifyScoped(body.reviewToken, PURPOSE_MATCH_REVIEW);
    if (String(review.ownerReviewerId) !== String(context.owner.id)
        || Number(review.applicationId) !== Number(context.application.id)
        || review.selectedIdentityHash !== stableHash(context.selected.identityKey)
        || review.profileHash !== profileHash(context.selected)) {
      throw new ReviewerOrderIdentityError('IDENTITY_CONTEXT_CHANGED', '선택 명의나 저장 정보가 변경되었습니다. 다시 분석해주세요.', 409);
    }
    imageHash = review.imageHash; extractedHash = review.extractedFieldsHash;
    boundHash = submissionIdentityHash(body.formFields || {});
    reasonCodes = Array.isArray(review.reasonCodes) ? review.reasonCodes : [];
    if (reasonCodes.some((code) =>
      ['masked_name_ocr_correction', 'plain_name_ocr_correction'].includes(code))) {
      const fieldRules = {
        recipient: { selected: context.selected.name, normalize: cleanName },
        phone: { selected: context.selected.phone, normalize: phone8 },
        address: { selected: context.selected.address, normalize: normAddress },
      };
      const requiredSavedFields = Array.isArray(review.requiredSavedFields)
        ? review.requiredSavedFields.filter((field) => fieldRules[field]) : ['recipient'];
      const invalidSavedField = requiredSavedFields.find((field) => {
        const rule = fieldRules[field];
        return String(body.savedIdentitySelections?.[field] || '') !== String(context.selected.identityKey)
          || rule.normalize(body.formFields?.[field]) !== rule.normalize(rule.selected);
      });
      if (invalidSavedField) {
        throw new ReviewerOrderIdentityError(
          'SAVED_IDENTITY_SELECTION_REQUIRED',
          '수취인 아래 내 저장정보에서 현재 참여 명의를 선택해 가림 정보를 보완해주세요.',
          409
        );
      }
      reasonCodes.push('saved_identity_selected');
    }
  } else if (mode === 'form_edit') {
    // 필드 수정은 기존 승인토큰을 제출에 그대로 재사용하지 않는다. 다만 그 토큰으로
    // 같은 캡처·같은 참여 명의가 이미 서버 확인을 통과했음을 증명한 뒤 수정값을 재검사한다.
    const extract = verifyExtractionProof(body.extractToken, body.extracted || {});
    const prior = verifyScoped(body.priorApprovalToken, PURPOSE_APPROVAL);
    const invalidPrior = String(prior.ownerReviewerId) !== String(context.owner.id)
      || Number(prior.applicationId) !== Number(context.application.id)
      || String(prior.campaignId) !== String(context.application.campaign_id)
      || prior.selectedIdentityHash !== stableHash(context.selected.identityKey)
      || prior.profileHash !== profileHash(context.selected)
      || prior.mode === 'no_capture'
      || prior.imageHash !== extract.imageHash
      || prior.extractedFieldsHash !== extract.fieldsHash;
    if (invalidPrior) {
      throw new ReviewerOrderIdentityError('IDENTITY_CONTEXT_CHANGED', '캡처 또는 선택 명의가 변경되었습니다. 다시 분석해주세요.', 409);
    }
    imageHash = extract.imageHash; extractedHash = extract.fieldsHash;
    reasonCodes = ['identity_fields_edited_after_approval'];
  } else if (mode === 'ai_error') {
    const extract = verifyExtractionProof(body.extractToken, body.extracted || {});
    if (extract.extractOk) throw new ReviewerOrderIdentityError('MANUAL_MODE_INVALID', 'AI 분석 성공 건은 명의 매칭 결과를 먼저 확인해주세요.', 409);
    imageHash = extract.imageHash; extractedHash = extract.fieldsHash; reasonCodes = ['ai_extract_failed'];
  } else if (mode === 'match_error') {
    // 캡처 추출은 끝났지만 주소 의미비교 등 명의 매칭 단계의 AI가 장애난 경우.
    // 클라이언트가 임의 필드를 만들어 우회하지 못하게 성공 추출증명을 다시 검증하고,
    // 아래 공통 결정적 불일치 검사(useGemini:false)를 통과한 건만 수동 확인시킨다.
    const extract = verifyExtractionProof(body.extractToken, body.extracted || {});
    if (!extract.extractOk) throw new ReviewerOrderIdentityError('MANUAL_MODE_INVALID', '캡처 추출에 실패한 건은 AI 분석 장애 확인 절차를 이용해주세요.', 409);
    imageHash = extract.imageHash; extractedHash = extract.fieldsHash; reasonCodes = ['identity_match_unavailable'];
    // ★ 캡처 자체도 결정적으로 재검사한다. 아래 공통 검사는 사용자가 보낸 입력칸(formFields)만 보므로,
    //   입력칸을 내 정보로 채우면 남의 주문 캡처도 통과했다(2026-09-24 실측 우회). 네트워크 오류로도
    //   이 경로에 들어오므로 악용이 아니어도 캡처 확인이 통째로 빠질 수 있었다.
    const captureCheck = await evaluateSelectedIdentity(body.extracted || {}, context.selected, context.identities, {
      useGemini: false, allowPlainNameCorrection: true,
    });
    if (captureCheck.status === 'MISMATCH') {
      await audit({ context, status: 'MISMATCH', approvalMode: mode,
        reasonCodes: ['identity_match_unavailable', ...captureCheck.reasonCodes], imageHash, extractedHash });
      throw new ReviewerOrderIdentityError('IDENTITY_MISMATCH',
        '캡처의 주문자가 참여한 명의와 다릅니다. 참여한 명의로 구매한 주문의 캡처를 올려주세요.', 409);
    }
  } else if (mode === 'no_capture') {
    reasonCodes = ['no_capture_exception'];
  } else {
    throw new ReviewerOrderIdentityError('MANUAL_MODE_INVALID', '지원하지 않는 수동 확인 방식입니다.', 400);
  }

  const check = await evaluateSelectedIdentity(body.formFields || {}, context.selected, context.identities, { useGemini: false });
  const explicitlyConfirmedPlainName = reasonCodes.includes('plain_name_ocr_correction')
    && String(body.savedIdentitySelections?.recipient || '') === String(context.selected.identityKey)
    && cleanName(body.formFields?.recipient) === cleanName(context.selected.name);
  if (explicitlyConfirmedPlainName) {
    const missingOrMasked = ['recipient', 'phone', 'address'].find((field) => {
      const value = String(body.formFields?.[field] || '').trim();
      return !value || MASK_RE.test(value);
    });
    if (missingOrMasked) {
      throw new ReviewerOrderIdentityError('IDENTITY_FIELDS_REQUIRED', '수취인·연락처·배송주소를 실제 정보로 입력해주세요.', 409);
    }
  }
  if (check.status === 'MISMATCH' && !explicitlyConfirmedPlainName) {
    const details = Object.values(check.selectedScore.parts).filter((p) => p.verdict === 'mismatch').map((p) => p.reason);
    if (check.competingIdentity) details.push('다른 저장 명의와 일치');
    throw new ReviewerOrderIdentityError('IDENTITY_MISMATCH',
      `선택 명의의 주문인지 확인할 수 없습니다: ${details.join(' · ')}. 수취인과 연락처를 확인해주세요.`, 409);
  }
  if (check.reasonCodes.includes('delivery_address_changed')
      && [check.selectedScore.fields.recipient, check.selectedScore.fields.phone].some((v) => MASK_RE.test(v))) {
    throw new ReviewerOrderIdentityError('IDENTITY_FIELDS_REQUIRED', '다른 배송지를 사용하려면 수취인과 연락처의 가림문자를 실제 정보로 수정해주세요.', 409);
  }
  reasonCodes = [...new Set(reasonCodes.concat(check.reasonCodes))];
  boundHash = submissionIdentityHash(body.formFields || {});
  const approvalToken = signScoped({
    purpose: PURPOSE_APPROVAL, mode, ownerReviewerId: context.owner.id,
    applicationId: context.application.id, campaignId: context.application.campaign_id,
    selectedIdentityHash: stableHash(context.selected.identityKey), profileHash: profileHash(context.selected),
    imageHash, extractedFieldsHash: extractedHash, submissionIdentityHash: boundHash,
  }, '20m');
  await audit({ context, status: 'MANUAL_CONFIRMED', approvalMode: mode, reasonCodes, imageHash, extractedHash });
  return { ok: true, status: 'MANUAL_CONFIRMED', mode, approvalToken };
}

async function verifyApprovalForSubmission(body, reviewer) {
  const context = await resolveApplicationIdentity(contextArgs(body, reviewer));
  const approval = verifyScoped(body.identityApprovalToken, PURPOSE_APPROVAL);
  const mismatch = String(approval.ownerReviewerId) !== String(context.owner.id)
    || Number(approval.applicationId) !== Number(context.application.id)
    || String(approval.campaignId) !== String(context.application.campaign_id)
    || approval.selectedIdentityHash !== stableHash(context.selected.identityKey)
    || approval.profileHash !== profileHash(context.selected)
    || approval.submissionIdentityHash !== submissionIdentityHash(body);
  if (mismatch) throw new ReviewerOrderIdentityError('IDENTITY_APPROVAL_STALE', '명의 확인 후 입력값 또는 저장 정보가 변경되었습니다. 다시 확인해주세요.', 409);
  return { context, approval };
}

module.exports = {
  ReviewerOrderIdentityError,
  isEnabled,
  fieldsObject,
  fieldsHash,
  submissionIdentityHash,
  hashImageBase64,
  issueExtractionProof,
  verifyExtractionProof,
  loadOwnerProfile,
  getSecureProfile,
  saveShoppingId,
  resolveApplicationIdentity,
  maskedCompatible,
  maskedNameOcrNearMiss,
  plainNameOcrCorrectionCandidate,
  canReviewMaskedNameOcrCorrection,
  canReviewPlainNameOcrCorrection,
  evaluateSelectedIdentity,
  loadOrderInfoSuggestions,
  getParticipationIdentityContext,
  matchCapture,
  manualConfirm,
  verifyApprovalForSubmission,
};
