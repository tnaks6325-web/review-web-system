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
    });
  });
  return { owner, identities };
}

function publicIdentity(identity) {
  return {
    identityKey: identity.identityKey,
    type: identity.type,
    name: identity.name,
    phone: identity.phone,
    address: identity.address,
    shoppingId: identity.shoppingId || '',
  };
}

async function getSecureProfile(ownerReviewerId) {
  const { owner, identities } = await loadOwnerProfile(ownerReviewerId);
  return {
    ok: true,
    profile: {
      name: owner.name || '', phone: owner.phone || '', address: owner.address || '',
      bankName: owner.bank_name || '', bankAccount: owner.bank_account || '', accountHolder: owner.account_holder || '',
      identities: identities.map(publicIdentity),
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
    if (!candidates.length && appPhone) candidates = identities.filter((item) => phone8(item.phone) === appPhone);
  }
  if (candidates.length !== 1) {
    throw new ReviewerOrderIdentityError('SELECTED_IDENTITY_AMBIGUOUS', '참여 시 선택한 명의를 하나로 확정할 수 없습니다. 내정보를 확인해주세요.', 409);
  }
  const selected = candidates[0];
  if (selected.type === 'sub' && !app.multi_account_mode) {
    throw new ReviewerOrderIdentityError(
      'SUB_ACCOUNT_NOT_ALLOWED',
      '이 공고는 타계정 참여가 허용되지 않습니다.',
      403
    );
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
function phoneVerdict(raw, stored) {
  const a = String(raw || '').trim(), b = String(stored || '').trim();
  if (!a || !b) return { verdict: 'uncertain', reason: '연락처 정보 없음' };
  if (digits(a) && phone8(a) === phone8(b)) return { verdict: 'match', reason: '연락처 일치' };
  if (maskedCompatible(a, b, 'phone')) return { verdict: 'match', reason: '가림 연락처 일치' };
  return { verdict: 'mismatch', reason: '연락처 불일치' };
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
  const matches = Object.values(parts).filter((p) => p.verdict === 'match').length;
  const conflicts = Object.entries(parts).filter(([, p]) => p.verdict === 'mismatch').map(([key, p]) => `${key}:${p.reason}`);
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
    // 동·호수/장소가 다른 주소 또는 일치 독립신호가 2개 미만이면 결정적 불일치다.
    // 반대로 이름+주소처럼 독립신호 2개가 맞고 전화 하나만 다른 경우는 가족 연락처,
    // 저장번호 변경, OCR 오인식 가능성이 있어 사용자가 허용한 수동확인 대상으로 둔다.
    status = addressConflict || selectedScore.matches < 2 ? 'MISMATCH' : 'REVIEW';
    reasonCodes.push(status === 'MISMATCH' ? 'selected_identity_conflict' : 'selected_identity_partial_conflict');
  } else if (selectedScore.matches >= 2) {
    status = 'MATCH';
  } else {
    reasonCodes.push('insufficient_independent_matches');
  }

  let competingIdentity = null;
  for (const identity of allIdentities) {
    if (identity.identityKey === selected.identityKey) continue;
    const other = await scoreIdentity(extracted, identity, { useGemini: false });
    if (other.matches >= 2 && other.score >= selectedScore.score) {
      competingIdentity = identity;
      // 선택 명의 자체도 독립 필드 2개 이상 명확히 맞으면 중복 저장정보 때문에 생긴
      // 애매 판정이다. 사용자가 허용한 수동확인 경로로 보낸다. 선택 명의가 부족하거나
      // 충돌하는데 다른 명의가 맞는 경우만 결정적 오명의로 차단한다.
      if (!selectedScore.conflicts.length && selectedScore.matches >= 2) {
        status = 'REVIEW';
        reasonCodes.push('multiple_identity_candidates');
      } else {
        status = 'MISMATCH';
        reasonCodes.push('other_owner_identity_matches');
      }
      break;
    }
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
  return {
    ok: true, enabled: isEnabled(), multiAccountMode: !!context.application.multi_account_mode,
    selectedIdentity: publicIdentity(context.selected),
  };
}

async function matchCapture(body, reviewer) {
  const context = await resolveApplicationIdentity(contextArgs(body, reviewer));
  const extract = verifyExtractionProof(body.extractToken, body.extracted || {});
  if (!extract.extractOk) throw new ReviewerOrderIdentityError('AI_EXTRACT_FAILED', 'AI 분석에 실패했습니다. 수동 확인을 선택할 수 있습니다.', 409);
  const verdict = await evaluateSelectedIdentity(body.extracted || {}, context.selected, context.identities, { useGemini: true });
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
    reviewToken = signScoped({
      purpose: PURPOSE_MATCH_REVIEW, ownerReviewerId: context.owner.id,
      applicationId: context.application.id, campaignId: context.application.campaign_id,
      selectedIdentityHash: stableHash(context.selected.identityKey), profileHash: profileHash(context.selected),
      imageHash: extract.imageHash, extractedFieldsHash: extract.fieldsHash,
      submissionIdentityHash: submissionIdentityHash(verdict.resolved),
      reasonCodes: verdict.reasonCodes,
    }, '15m');
  }
  await audit({ context, status: verdict.status, approvalMode: verdict.status === 'MATCH' ? 'matched' : 'pending',
    reasonCodes: verdict.reasonCodes.concat(verdict.selectedScore.conflicts), imageHash: extract.imageHash, extractedHash: extract.fieldsHash });
  return {
    ok: true, status: verdict.status, reasonCodes: verdict.reasonCodes,
    reasons: Object.values(verdict.selectedScore.parts).map((p) => p.reason),
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
    const check = await evaluateSelectedIdentity(body.formFields || {}, context.selected, context.identities, { useGemini: false });
    if (check.status === 'MISMATCH') {
      throw new ReviewerOrderIdentityError('IDENTITY_MISMATCH', '입력 정보가 선택 명의와 명확히 다르므로 수동 확인으로 제출할 수 없습니다.', 409);
    }
    boundHash = submissionIdentityHash(body.formFields || {});
    reasonCodes = Array.isArray(review.reasonCodes) ? review.reasonCodes : [];
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
  } else if (mode === 'no_capture') {
    reasonCodes = ['no_capture_exception'];
  } else {
    throw new ReviewerOrderIdentityError('MANUAL_MODE_INVALID', '지원하지 않는 수동 확인 방식입니다.', 400);
  }

  if (mode !== 'review') {
    const check = await evaluateSelectedIdentity(body.formFields || {}, context.selected, context.identities, { useGemini: false });
    if (check.status === 'MISMATCH') {
      throw new ReviewerOrderIdentityError('IDENTITY_MISMATCH', '입력 정보가 선택 명의와 명확히 다르므로 수동 확인으로 제출할 수 없습니다.', 409);
    }
    boundHash = submissionIdentityHash(body.formFields || {});
  }
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
  evaluateSelectedIdentity,
  getParticipationIdentityContext,
  matchCapture,
  manualConfirm,
  verifyApprovalForSubmission,
};
