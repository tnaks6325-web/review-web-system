'use strict';

// Candidate supersets only. The route retains every ownership, recycled-phone,
// participant and duplicate check after these materialized sets are built.
function earningsCandidates(owner, phones) {
  if (!/^\$\d+$/.test(owner) || !/^\$\d+$/.test(phones)) throw Error('SQL parameter required');
  return `earnings_order_ids AS MATERIALIZED (
    SELECT o.id FROM order_submissions o
     WHERE o.owner_reviewer_id=${owner}
        OR RIGHT(regexp_replace(COALESCE(o.phone,''),'[^0-9]','','g'),8)=ANY(${phones})
    UNION
    SELECT p.order_submission_id FROM campaign_participants p
     WHERE p.owner_reviewer_id=${owner} OR p.phone8=ANY(${phones})
    UNION
    SELECT o.id FROM order_submissions o JOIN campaign_applications a
      ON a.id=o.campaign_application_id OR a.order_submission_id=o.id
     WHERE a.owner_reviewer_id=${owner} OR a.owner_phone8=ANY(${phones})
  ), earnings_orders AS MATERIALIZED (
    SELECT o.* FROM order_submissions o JOIN earnings_order_ids c ON c.id=o.id
     WHERE o.deleted_at IS NULL
  ), earnings_coordinates AS MATERIALIZED (
    SELECT p.sheet_id,p.tab_name,p.seq AS row_index FROM campaign_participants p
     WHERE p.owner_reviewer_id=${owner} OR p.phone8=ANY(${phones})
        OR p.order_submission_id IN (SELECT id FROM earnings_order_ids)
    UNION
    SELECT l.sheet_id,l.tab_name,l.row_index FROM participation_links l
     WHERE l.owner_reviewer_id=${owner} OR l.phone8=ANY(${phones})
    UNION
    SELECT i.sheet_id,i.tab_name,i.row_index FROM review_index i WHERE i.phone8=ANY(${phones})
  ), earnings_rows AS MATERIALIZED (
    SELECT ri.* FROM review_index ri JOIN earnings_coordinates c
      ON c.sheet_id=ri.sheet_id AND c.tab_name=ri.tab_name AND c.row_index=ri.row_index
  )`;
}
module.exports={earningsCandidates};
