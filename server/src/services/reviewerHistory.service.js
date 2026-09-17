'use strict';

const pool = require('../db/pool');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badCursor() { const e = new Error('목록이 변경되었습니다. 처음부터 다시 불러와 주세요.'); e.code='HISTORY_CURSOR_INVALID'; e.status=409; return e; }
function decodeCursor(cursor, owner, scope, status) {
  if (!cursor) return null;
  try {
    if (String(cursor).length>1200) throw badCursor();
    const c=JSON.parse(Buffer.from(cursor,'base64url').toString());
    if(c.owner!==owner || c.scope!==scope || c.status!==status || !UUID.test(c.id) || !Number.isFinite(Date.parse(c.at))) throw badCursor();
    return c;
  } catch (_) { throw badCursor(); }
}
const visible = `p.ownership_status='confirmed' AND p.lifecycle_status='active'
  AND tc.sheet_id IS NOT NULL AND NOT COALESCE(tc.is_closed,FALSE)
  AND NOT EXISTS (SELECT 1 FROM index_master_archive a WHERE a.sheet_id=p.sheet_id AND a.tab_name=p.tab_name)
  AND (NULLIF(p.index_snapshot->>'round','') IS NULL OR NOT ((p.index_snapshot->>'round')=ANY(regexp_split_to_array(btrim(COALESCE(tc.archived_rounds,'')),'[[:space:]]*,[[:space:]]*'))))`;

async function availability(owner, db=pool) {
  const {rows}=await db.query(`SELECT r.enabled
    AND NOT EXISTS(SELECT 1 FROM order_submissions os WHERE os.owner_reviewer_id=r.owner_reviewer_id
      AND os.deleted_at IS NULL AND os.mirror_status IN ('pending','queued','pending_no_row','written','failed','stuck_manual')
      AND os.submitted_at>now()-interval '14 days'
      AND (os.mirror_status<>'written' OR os.sheet_written_at>now()-interval '2 hours')
      AND NOT EXISTS(SELECT 1 FROM tab_configs tc WHERE tc.sheet_id=os.sheet_id AND tc.tab_name=os.tab_name AND tc.is_closed)
      AND NOT EXISTS(SELECT 1 FROM index_master_archive a WHERE a.sheet_id=os.sheet_id AND a.tab_name=os.tab_name)
      AND NOT EXISTS(SELECT 1 FROM review_closed_targets closed WHERE closed.order_submission_id=os.id)
      AND NOT EXISTS(SELECT 1 FROM reviewer_participations p WHERE p.order_submission_id=os.id)) AS ready
    FROM reviewer_history_rollouts r CROSS JOIN reviewer_history_control c
    JOIN reviewers v ON v.id=r.owner_reviewer_id WHERE r.owner_reviewer_id=$1 AND c.id=TRUE`,[owner]);
  return !!(rows[0]&&rows[0].ready);
}

// SELECT_FIELDS and output enrichment are shared with the existing search formatter.
async function loadPage(selectFields, options, db=pool) {
  const {ownerReviewerId:owner, restrictParticipant:sub, participantIdentityId:identity, ownerPhone8s:phones}=options;
  const status=options.historyStatus||'all';
  if(!UUID.test(String(owner||'')) || !['pending','fulfilled','all'].includes(status)) throw badCursor();
  const scope=sub ? `sub:${identity||''}:${(phones||[])[0]||''}` : 'self';
  if(sub && (!Array.isArray(phones)||phones.length!==1||!/^\d{8}$/.test(phones[0]))) throw badCursor();
  const c=decodeCursor(options.historyCursor,owner,scope,status);
  const limit=Math.min(100,Math.max(1,Math.trunc(Number(options.historyLimit)||50)));
  const params=[owner,!!sub,identity||null,phones||[],status];
  const scoped=`p.owner_reviewer_id=$1 AND ${visible}
    AND (NOT $2::boolean OR (p.participant_identity_id=$3::uuid
      OR (p.participant_identity_id IS NULL AND p.participant_phone8=ANY($4::text[]))))`;
  const filter=`($5='all' AND p.review_obligation_status IN ('pending','fulfilled','unknown')
    OR $5='pending' AND p.review_obligation_status IN ('pending','unknown') OR $5='fulfilled' AND p.review_obligation_status='fulfilled')`;
  // Count and page run in one statement/snapshot; no global review_index COUNT/MAX.
  const {rows}=await db.query(`WITH counts AS (
      SELECT count(*) FILTER(WHERE p.review_obligation_status IN ('pending','unknown'))::int AS pending,
             count(*) FILTER(WHERE p.review_obligation_status='fulfilled')::int AS done,
             md5(COALESCE(string_agg(p.id::text||':'||p.record_version::text,',' ORDER BY p.id),'')) AS version
      FROM reviewer_participations p LEFT JOIN tab_configs tc ON tc.sheet_id=p.sheet_id AND tc.tab_name=p.tab_name WHERE ${scoped}
    ), page AS (
      SELECT ${selectFields},p.id AS "participationId",p.created_at::text AS "historyCreatedAt",
        p.review_obligation_status AS "reviewObligationStatus",p.record_version::text AS "recordVersion",1.0 AS score
      FROM reviewer_participations p
      CROSS JOIN LATERAL jsonb_populate_record(NULL::review_index,p.index_snapshot) ri
      LEFT JOIN campaign_participants cp ON cp.id=p.campaign_participant_id
      LEFT JOIN tab_configs tc ON tc.sheet_id=p.sheet_id AND tc.tab_name=p.tab_name
      WHERE ${scoped} AND ${filter}
        AND ($6::timestamptz IS NULL OR (p.created_at,p.id)<($6::timestamptz,$7::uuid))
      ORDER BY p.created_at DESC,p.id DESC LIMIT $8
    ) SELECT (SELECT row_to_json(counts) FROM counts) AS counts,
       COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'::jsonb) AS items`,
  [...params,c&&c.at,c&&c.id,limit+1]);
  const all=rows[0]&&rows[0].items||[];
  const counts=rows[0]&&rows[0].counts||{pending:0,done:0,version:''};
  if(c&&c.version!==counts.version) throw badCursor();
  const items=all.slice(0,limit),last=items[items.length-1],hasMore=all.length>limit;
  return {rows:items,counts:{pending:counts.pending,done:counts.done},scopeVersion:counts.version,hasMore,
    nextCursor:hasMore ? Buffer.from(JSON.stringify({owner,scope,status,version:counts.version,at:last.historyCreatedAt,id:last.participationId})).toString('base64url') : null};
}

// Coordinate APIs must not recover somebody else's ownership from a matching phone.
async function ownsProjectedTarget({session,sheetId,tabName,rowIndex,client=pool}) {
  const {rows}=await client.query(`SELECT p.owner_reviewer_id,p.participant_phone8,p.participant_identity_id,p.ownership_status
    FROM reviewer_participations p WHERE p.sheet_id=$1 AND p.tab_name=$2 AND p.row_index=$3 AND p.lifecycle_status='active'`,[sheetId,tabName,rowIndex]);
  if(!rows.length) return null; // not migrated: retain existing authenticated legacy checks
  if(rows.some(r=>r.ownership_status==='conflict')) return false;
  const confirmed=rows.filter(r=>r.ownership_status==='confirmed');
  if(!confirmed.length) return null;
  let identity=null;
  if(session.loginKind==='sub') identity=await require('./reviewerIdentity.service').resolveParticipantIdentity({
    client,ownerReviewerId:session.ownerReviewerId,participantPhone8:session.loginPhone8});
  return confirmed.every(r=>String(r.owner_reviewer_id)===String(session.ownerReviewerId)
    && (session.loginKind!=='sub'||(r.participant_identity_id
      ? !!identity&&String(identity.id)===String(r.participant_identity_id)
      : r.participant_phone8===String(session.loginPhone8||'').replace(/\D/g,'').slice(-8))));
}
module.exports={availability,loadPage,ownsProjectedTarget,decodeCursor};
