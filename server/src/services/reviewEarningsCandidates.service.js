'use strict';

// Candidate supersets only. The route retains every ownership, recycled-phone,
// participant and duplicate check after these materialized sets are built.
function earningsCandidates(owner, phones) {
  if (!/^\$\d+$/.test(owner) || !/^\$\d+$/.test(phones)) throw Error('SQL parameter required');
  // ★ "계정ID 또는 전화번호" 를 한 조건(OR)으로 쓰면 인덱스를 못 타고 표 전체를 읽어 1.5초 제한에
  //   걸렸다(운영 실측 약 9% 503). 갈래별로 나눠 각자 인덱스를 탄다(migration 168) — 결과 집합은 OR 과 같다.
  //   조건은 한 글자도 좁히지 않았다(삭제된 주문의 작업표 줄도 종전처럼 좌표 후보가 된다).
  return `earnings_order_ids AS MATERIALIZED (
    SELECT o.id FROM order_submissions o WHERE o.owner_reviewer_id=${owner}
    UNION
    SELECT o.id FROM order_submissions o
     WHERE RIGHT(regexp_replace(COALESCE(o.phone,''),'[^0-9]','','g'),8)=ANY(${phones})
    UNION
    SELECT p.order_submission_id FROM campaign_participants p WHERE p.owner_reviewer_id=${owner}
    UNION
    SELECT p.order_submission_id FROM campaign_participants p WHERE p.phone8=ANY(${phones})
    UNION
    SELECT o.id FROM campaign_applications a JOIN order_submissions o ON a.id=o.campaign_application_id
     WHERE a.owner_reviewer_id=${owner}
    UNION
    SELECT o.id FROM campaign_applications a JOIN order_submissions o ON a.order_submission_id=o.id
     WHERE a.owner_reviewer_id=${owner}
    UNION
    SELECT o.id FROM campaign_applications a JOIN order_submissions o ON a.id=o.campaign_application_id
     WHERE a.owner_phone8=ANY(${phones})
    UNION
    SELECT o.id FROM campaign_applications a JOIN order_submissions o ON a.order_submission_id=o.id
     WHERE a.owner_phone8=ANY(${phones})
  ), earnings_orders AS MATERIALIZED (
    SELECT o.* FROM order_submissions o
     WHERE o.id IN (SELECT id FROM earnings_order_ids WHERE id IS NOT NULL) AND o.deleted_at IS NULL
  ), earnings_coordinates AS MATERIALIZED (
    SELECT p.sheet_id,p.tab_name,p.seq AS row_index FROM campaign_participants p WHERE p.owner_reviewer_id=${owner}
    UNION
    SELECT p.sheet_id,p.tab_name,p.seq FROM campaign_participants p WHERE p.phone8=ANY(${phones})
    UNION
    SELECT p.sheet_id,p.tab_name,p.seq FROM campaign_participants p
     WHERE p.order_submission_id IN (SELECT id FROM earnings_order_ids WHERE id IS NOT NULL)
    UNION
    SELECT l.sheet_id,l.tab_name,l.row_index FROM participation_links l WHERE l.owner_reviewer_id=${owner}
    UNION
    SELECT l.sheet_id,l.tab_name,l.row_index FROM participation_links l WHERE l.phone8=ANY(${phones})
    UNION
    SELECT i.sheet_id,i.tab_name,i.row_index FROM review_index i WHERE i.phone8=ANY(${phones})
  ), earnings_rows AS MATERIALIZED (
    SELECT ri.* FROM review_index ri JOIN earnings_coordinates c
      ON c.sheet_id=ri.sheet_id AND c.tab_name=ri.tab_name AND c.row_index=ri.row_index
  )`;
}
module.exports={earningsCandidates};
