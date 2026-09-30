-- Explicit manual closure/cancellation; never infer a terminal state from old free text.
-- No FK to participants: the existing cancellation workflow physically removes some rows.
-- A board row can be reused. This token identifies the assignment, not its coordinate.
ALTER TABLE campaign_participants ADD COLUMN IF NOT EXISTS review_participation_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION workdesk_review_participation_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE o JSONB; n JSONB; linked_order JSONB; same_assignment BOOLEAN; stable_identity BOOLEAN;
BEGIN
 IF TG_OP='INSERT' THEN NEW.review_participation_id:=gen_random_uuid(); RETURN NEW; END IF;
 o:=to_jsonb(OLD); n:=to_jsonb(NEW);
 stable_identity:=NULLIF(o->>'identity_key','') IS NOT NULL
   OR NULLIF(o->>'participant_identity_id','') IS NOT NULL
   OR (NULLIF(o->>'phone8','') IS NOT NULL AND NULLIF(o->>'reviewer_name','') IS NOT NULL)
   OR OLD.order_submission_id IS NOT NULL;
 same_assignment:=OLD.first_seen_at IS NOT DISTINCT FROM NEW.first_seen_at
   AND NOT (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
   AND (o->>'identity_key') IS NOT DISTINCT FROM (n->>'identity_key')
   AND (o->>'phone8') IS NOT DISTINCT FROM (n->>'phone8')
   AND (o->>'reviewer_name') IS NOT DISTINCT FROM (n->>'reviewer_name')
   AND ((o->>'owner_reviewer_id') IS NOT DISTINCT FROM (n->>'owner_reviewer_id')
     OR (o->>'owner_reviewer_id' IS NULL AND n->>'owner_reviewer_id' IS NOT NULL AND stable_identity))
   AND ((o->>'participant_identity_id') IS NOT DISTINCT FROM (n->>'participant_identity_id')
     OR (o->>'participant_identity_id' IS NULL AND n->>'participant_identity_id' IS NOT NULL AND stable_identity));
 IF OLD.order_submission_id IS DISTINCT FROM NEW.order_submission_id THEN
   SELECT to_jsonb(os) INTO linked_order FROM order_submissions os WHERE os.id=NEW.order_submission_id AND os.deleted_at IS NULL;
   same_assignment:=same_assignment AND stable_identity AND OLD.order_submission_id IS NULL
     AND NULLIF(n->>'owner_reviewer_id','') IS NOT NULL
     AND linked_order->>'owner_reviewer_id'=n->>'owner_reviewer_id'
     AND NULLIF(linked_order->>'participant_identity_key_hash','') IS NOT NULL
     AND (NULLIF(linked_order->>'participant_identity_id','') IS NULL
       OR linked_order->>'participant_identity_id'=n->>'participant_identity_id')
     AND (NULLIF(linked_order->>'phone','') IS NULL
       OR RIGHT(regexp_replace(linked_order->>'phone','[^0-9]','','g'),8)=n->>'phone8');
 END IF;
 -- Do not accept a caller-supplied old token, including A -> B -> A row reuse.
 NEW.review_participation_id:=CASE WHEN same_assignment IS TRUE THEN OLD.review_participation_id ELSE gen_random_uuid() END;
 RETURN NEW;
END $$;
-- Runs after reviewer_participation_owner (162), so verified owner enrichment is visible.
DROP TRIGGER IF EXISTS workdesk_review_participation_identity ON campaign_participants;
CREATE TRIGGER workdesk_review_participation_identity BEFORE INSERT OR UPDATE ON campaign_participants
 FOR EACH ROW EXECUTE FUNCTION workdesk_review_participation_identity();

CREATE TABLE IF NOT EXISTS workdesk_review_resolutions (
  participant_id UUID PRIMARY KEY,
  review_participation_id UUID,
  sheet_id TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  order_submission_id UUID,
  identity_key TEXT,
  participant_source TEXT,
  first_seen_at TIMESTAMPTZ,
  resolution TEXT NOT NULL CHECK (resolution IN ('closed_no_review', 'order_cancelled')),
  reason TEXT NOT NULL,
  resolved_by TEXT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  history JSONB NOT NULL DEFAULT '[]'::jsonb
);
-- NULL on an older record is deliberately not inferred from today's row assignment.
ALTER TABLE workdesk_review_resolutions ADD COLUMN IF NOT EXISTS review_participation_id UUID;

CREATE INDEX IF NOT EXISTS idx_workdesk_review_resolutions_scope
  ON workdesk_review_resolutions (sheet_id, tab_name, row_index);
CREATE INDEX IF NOT EXISTS idx_workdesk_review_resolutions_closed_order
  ON workdesk_review_resolutions (order_submission_id) WHERE resolution='closed_no_review';
CREATE INDEX IF NOT EXISTS idx_review_reminder_closed_scope
  ON review_reminder_states (sheet_id, tab_name, row_index) WHERE review_status='closed_no_review';

-- Resolve current coordinates, but bind manual closure to the immutable assignment token.
CREATE OR REPLACE VIEW review_closed_targets AS
SELECT s.order_submission_id AS resolution_id, s.order_submission_id,
       s.sheet_id, s.tab_name, s.row_index, s.review_status, s.closed_at, s.close_reason
  FROM review_reminder_states s
 WHERE s.review_status = 'closed_no_review'
   -- A manual decision uses its assignment binding below; the reminder mirror
   -- must not reintroduce that decision for a replacement participant.
   AND NOT EXISTS (SELECT 1 FROM workdesk_review_resolutions r
     WHERE r.order_submission_id=s.order_submission_id AND r.resolution='closed_no_review')
   AND NOT EXISTS (
     SELECT 1 FROM campaign_participants current_row
      WHERE current_row.sheet_id=s.sheet_id AND current_row.tab_name=s.tab_name
        AND current_row.seq=s.row_index AND current_row.active=TRUE AND current_row.deleted_at IS NULL
        AND current_row.order_submission_id IS DISTINCT FROM s.order_submission_id)
UNION ALL
SELECT r.participant_id AS resolution_id, cp.order_submission_id,
       cp.sheet_id, cp.tab_name, cp.seq AS row_index, r.resolution AS review_status,
       r.resolved_at AS closed_at, r.reason AS close_reason
  FROM workdesk_review_resolutions r
  JOIN campaign_participants cp ON cp.id = r.participant_id
 WHERE r.resolution = 'closed_no_review' AND cp.active = TRUE AND cp.deleted_at IS NULL
   AND r.review_participation_id = cp.review_participation_id;
