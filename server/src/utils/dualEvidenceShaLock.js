'use strict';
/* Shared byte-hash guard for dual-channel purchase captures and review photos.
   Both writers must take the same transaction lock before checking reuse, otherwise
   a purchase capture and a review photo with the same bytes can commit concurrently. */
const SHA_RE = /^[0-9a-f]{64}$/;

function _sha(sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    const e = new Error('dual_evidence_sha_invalid'); e.code = 'dual_evidence_sha_invalid'; e.status = 400; throw e;
  }
  return sha;
}

async function lockEvidenceShaInTx(client, sha) {
  const v = _sha(sha);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('dual_evidence_sha'),hashtext($1))", [v]);
}

async function evidenceShaUsesInTx(client, sha) {
  const v = _sha(sha);
  const { rows } = await client.query(
    `SELECT 'review' AS kind, file_id, order_submission_id::text AS order_submission_id, NULL::text AS application_id, purchase_channel AS channel, evidence_role AS role
       FROM review_submissions WHERE byte_sha256=$1
     UNION ALL
     SELECT 'purchase' AS kind, file_id, order_submission_id::text, application_id::text, channel, role
       FROM purchase_capture_artifacts WHERE byte_sha256=$1`, [v]);
  return rows;
}

module.exports = { lockEvidenceShaInTx, evidenceShaUsesInTx };
