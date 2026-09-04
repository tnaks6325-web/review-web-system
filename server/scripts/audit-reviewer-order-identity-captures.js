'use strict';

/**
 * 운영 저장 캡처를 이용한 리뷰어 참여명의 매칭 읽기 전용 감사.
 *
 * - DB 트랜잭션은 READ ONLY이며 INSERT/UPDATE/DELETE를 실행하지 않는다.
 * - Drive 파일과 추출된 개인정보를 디스크/표준출력에 기록하지 않는다.
 * - 출력 식별자는 주문 UUID의 단방향 해시 12자뿐이다.
 * - 현재 프로필과 과거 제출정보가 이미 충돌하는 건은 정확도 표본에서 제외한다.
 *
 * 실행 예:
 *   railway run --project <id> --environment production --service <service> -- \
 *     node scripts/audit-reviewer-order-identity-captures.js --limit 50
 */

const crypto = require('crypto');
// Railway 애플리케이션의 DATABASE_URL은 내부 DNS라 로컬 감사에서 접근할 수 없다.
// 동일 DB 서비스에서 주입된 공개 프록시가 있을 때만 이 읽기 전용 스크립트가 우선 사용한다.
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const pool = require('../src/db/pool');
const drive = require('../src/services/drive.service');
const { extractOrderFromImage } = require('../src/services/gemini.service');
const {
  evaluateSelectedIdentity,
  hashImageBase64,
} = require('../src/services/reviewerOrderIdentity.service');

const MAX_LIMIT = 50;
const MASK_RE = /[*＊●○◯◉•·xX]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
const limit = Math.max(1, Math.min(MAX_LIMIT, Number.parseInt(arg('--limit', '50'), 10) || 50));
const delayMs = Math.max(0, Math.min(15000, Number.parseInt(process.env.IDENTITY_AUDIT_DELAY_MS || '2500', 10) || 2500));
const candidateLimit = Math.max(limit, Math.min(500, limit * 8));

function cleanName(v) { return String(v || '').replace(/\s+/g, '').trim(); }
function phone8(v) { return String(v || '').replace(/\D/g, '').slice(-8); }
function subs(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return subs(JSON.parse(v)); } catch (_) { return []; } }
  return [];
}
function caseId(v) { return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12); }
function safeError(err) {
  const name = String(err && err.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 50) || 'Error';
  const status = Number(err && (err.status || err.statusCode));
  const code = String(err && err.code || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 30);
  return [name, Number.isFinite(status) ? status : '', code].filter((part) => part !== '').join(':');
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function ownerIdFor(row, client) {
  const fixed = row.order_owner_id || row.app_owner_id;
  if (UUID_RE.test(String(fixed || ''))) return String(fixed);
  const p8 = phone8(row.owner_phone8);
  if (!p8) return null;
  const found = await client.query('SELECT id FROM reviewers WHERE phone8 = $1 ORDER BY id LIMIT 2', [p8]);
  return found.rows.length === 1 ? String(found.rows[0].id) : null;
}

async function identityContext(row, client) {
  const ownerId = await ownerIdFor(row, client);
  if (!ownerId) return { skip: 'owner_unresolved' };
  const ownerResult = await client.query(
    `SELECT id, name, phone, phone8, address, sub_accounts
       FROM reviewers WHERE id = $1 LIMIT 1`,
    [ownerId]
  );
  if (ownerResult.rows.length !== 1) return { skip: 'owner_missing' };
  const owner = ownerResult.rows[0];
  const codes = (await client.query(
    `SELECT id, member_no, current_name, current_phone, current_phone8
       FROM reviewer_identities
      WHERE owner_reviewer_id = $1 AND status = 'active'
      ORDER BY member_no`,
    [ownerId]
  )).rows;
  const byMember = new Map(codes.map((code) => [Number(code.member_no), code]));
  const selfCode = byMember.get(0);
  const identities = [{
    identityKey: selfCode ? `identity:${selfCode.id}` : 'self',
    participantIdentityId: selfCode && String(selfCode.id),
    type: 'self', memberNo: 0,
    name: selfCode && selfCode.current_name || owner.name || '',
    phone: selfCode && selfCode.current_phone || owner.phone || '',
    address: owner.address || '',
  }];
  subs(owner.sub_accounts).forEach((sub, index) => {
    const code = byMember.get(index + 1);
    identities.push({
      identityKey: code ? `identity:${code.id}` : `legacy:${index}`,
      participantIdentityId: code && String(code.id),
      type: 'sub', memberNo: index + 1,
      name: code && code.current_name || sub.name || '',
      phone: code && code.current_phone || sub.phone || '',
      address: sub.address || '',
    });
  });

  const participantId = row.order_participant_id || row.app_participant_id;
  let matches = participantId
    ? identities.filter((identity) => String(identity.participantIdentityId || '') === String(participantId))
    : [];
  if (!matches.length) {
    const n = cleanName(row.applicant_name);
    const p8 = phone8(row.app_phone8 || row.applicant_phone);
    matches = identities.filter((identity) => cleanName(identity.name) === n && phone8(identity.phone) === p8);
    if (!matches.length && p8) matches = identities.filter((identity) => phone8(identity.phone) === p8);
  }
  if (matches.length !== 1) return { skip: 'participant_unresolved' };
  return { selected: matches[0], identities };
}

let auditStage = 'startup';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  if (!(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS)) throw new Error('GEMINI_KEY_REQUIRED');
  auditStage = 'db_connect';
  const client = await pool.connect();
  const report = {
    version: 1,
    startedAt: new Date().toISOString(),
    requestedLimit: limit,
    candidateRows: 0,
    attempted: 0,
    contextSkipped: {},
    outcome: { MATCH: 0, REVIEW: 0, MISMATCH: 0, AI_ERROR: 0, DRIVE_ERROR: 0 },
    reference: { MATCH: 0, REVIEW: 0, MISMATCH_SKIPPED: 0 },
    invariants: { completeCaptureAddressRetained: 0, maskedAddressCompleted: 0, maskedIdentityCompleted: 0 },
    reasonCodes: {},
    attentionCases: [],
  };
  try {
    auditStage = 'db_begin_read_only';
    await client.query('BEGIN TRANSACTION READ ONLY');
    auditStage = 'candidate_query';
    const candidates = (await client.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (os.capture_file_id)
                os.id, os.capture_file_id, os.recipient AS submitted_recipient,
                os.phone AS submitted_phone, os.address AS submitted_address,
                os.owner_reviewer_id AS order_owner_id,
                os.participant_identity_id AS order_participant_id,
                os.submitted_at,
                ca.applicant_name, ca.applicant_phone, ca.phone8 AS app_phone8,
                ca.owner_phone8, ca.owner_reviewer_id AS app_owner_id,
                ca.participant_identity_id AS app_participant_id
           FROM order_submissions os
           JOIN campaign_applications ca ON ca.id = os.campaign_application_id
          WHERE os.deleted_at IS NULL
            AND os.capture_file_id IS NOT NULL AND os.capture_file_id <> ''
            AND ca.status = 'submitted'
          ORDER BY os.capture_file_id, os.submitted_at DESC
       ) picked
       ORDER BY submitted_at DESC
       LIMIT $1`,
      [candidateLimit]
    )).rows;
    report.candidateRows = candidates.length;

    for (const row of candidates) {
      if (report.attempted >= limit) break;
      auditStage = 'identity_context';
      const ctx = await identityContext(row, client);
      if (ctx.skip) {
        report.contextSkipped[ctx.skip] = (report.contextSkipped[ctx.skip] || 0) + 1;
        continue;
      }
      auditStage = 'reference_match';
      const reference = await evaluateSelectedIdentity({
        recipient: row.submitted_recipient,
        phone: row.submitted_phone,
        address: row.submitted_address,
      }, ctx.selected, ctx.identities, { useGemini: false });
      if (reference.status === 'MISMATCH' || reference.competingIdentity) {
        report.reference.MISMATCH_SKIPPED++;
        continue;
      }
      report.reference[reference.status] = (report.reference[reference.status] || 0) + 1;
      report.attempted++;
      const id = caseId(row.id);
      let file;
      try {
        auditStage = 'drive_download';
        file = await drive.downloadFile(row.capture_file_id);
      } catch (err) {
        report.outcome.DRIVE_ERROR++;
        report.attentionCases.push({ caseId: id, outcome: 'DRIVE_ERROR', error: safeError(err) });
        console.log(`AUDIT_PROGRESS ${report.attempted}/${limit} DRIVE_ERROR case=${id}`);
        continue;
      }
      try {
        auditStage = 'gemini_extract';
        const base64 = file.buffer.toString('base64');
        const imageHash = hashImageBase64(base64);
        const extracted = await extractOrderFromImage(base64, file.mimeType || 'image/jpeg');
        auditStage = 'identity_match';
        const verdict = await evaluateSelectedIdentity(extracted, ctx.selected, ctx.identities, { useGemini: true });
        report.outcome[verdict.status] = (report.outcome[verdict.status] || 0) + 1;
        for (const reason of verdict.reasonCodes || []) report.reasonCodes[reason] = (report.reasonCodes[reason] || 0) + 1;
        if (MASK_RE.test(String(extracted.address || '')) && verdict.resolved.address === ctx.selected.address) {
          report.invariants.maskedAddressCompleted++;
        } else if (extracted.address && !MASK_RE.test(String(extracted.address)) && verdict.resolved.address === String(extracted.address).trim()) {
          report.invariants.completeCaptureAddressRetained++;
        }
        if ((MASK_RE.test(String(extracted.recipient || '')) && verdict.resolved.recipient === ctx.selected.name)
          || (MASK_RE.test(String(extracted.phone || '')) && verdict.resolved.phone === ctx.selected.phone)) {
          report.invariants.maskedIdentityCompleted++;
        }
        if (verdict.status !== 'MATCH') {
          report.attentionCases.push({
            caseId: id,
            imageHash: imageHash.slice(0, 12),
            outcome: verdict.status,
            reasonCodes: verdict.reasonCodes || [],
            fieldVerdicts: Object.fromEntries(Object.entries(verdict.selectedScore.parts).map(([k, v]) => [k, v.verdict])),
          });
        }
        console.log(`AUDIT_PROGRESS ${report.attempted}/${limit} ${verdict.status} case=${id}`);
      } catch (err) {
        report.outcome.AI_ERROR++;
        report.attentionCases.push({ caseId: id, outcome: 'AI_ERROR', error: safeError(err) });
        console.log(`AUDIT_PROGRESS ${report.attempted}/${limit} AI_ERROR case=${id}`);
      }
      if (report.attempted < limit && delayMs) await sleep(delayMs);
    }
    await client.query('ROLLBACK');
    report.finishedAt = new Date().toISOString();
    report.contextSkippedTotal = Object.values(report.contextSkipped).reduce((sum, n) => sum + n, 0);
    report.passForRollout = report.attempted > 0
      && report.outcome.MISMATCH === 0
      && report.outcome.DRIVE_ERROR === 0
      && report.outcome.AI_ERROR <= Math.max(2, Math.floor(report.attempted * 0.1));
    console.log('AUDIT_REPORT_JSON=' + JSON.stringify(report));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error(`AUDIT_FATAL_STAGE=${auditStage} ERROR=${safeError(err)}`);
  try { await pool.end(); } catch (_) { /* noop */ }
  process.exit(1);
});
