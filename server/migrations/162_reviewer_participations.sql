-- Additive schema only. Historical rows and account cutover require a separate dry-run.
CREATE TABLE IF NOT EXISTS reviewer_participations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_participant_id UUID NOT NULL,
  assignment_key TEXT NOT NULL,
  owner_reviewer_id UUID,
  participant_identity_id UUID,
  participant_phone8 TEXT,
  ownership_status TEXT NOT NULL CHECK (ownership_status IN ('confirmed','unresolved','conflict')),
  ownership_source TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  order_submission_id UUID,
  review_obligation_status TEXT NOT NULL CHECK (review_obligation_status IN ('pending','fulfilled','closed_no_review','unknown')),
  review_evidence JSONB NOT NULL DEFAULT '{}',
  index_snapshot JSONB NOT NULL DEFAULT '{}',
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active','archived','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_version BIGINT NOT NULL DEFAULT 1,
  UNIQUE(campaign_participant_id, assignment_key)
);
CREATE INDEX IF NOT EXISTS idx_reviewer_participations_owner_page
 ON reviewer_participations(owner_reviewer_id, created_at DESC, id DESC)
 WHERE ownership_status='confirmed' AND lifecycle_status='active';
CREATE INDEX IF NOT EXISTS idx_reviewer_participations_coordinate
 ON reviewer_participations(sheet_id,tab_name,row_index) WHERE lifecycle_status='active';
CREATE INDEX IF NOT EXISTS idx_reviewer_participations_order ON reviewer_participations(order_submission_id);
CREATE TABLE IF NOT EXISTS reviewer_participation_events (
 id BIGSERIAL PRIMARY KEY, participation_id UUID NOT NULL,
 before_state JSONB, after_state JSONB NOT NULL, actor TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reviewer_history_control (
 id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), coverage_epoch BIGINT NOT NULL DEFAULT 1
);
INSERT INTO reviewer_history_control(id) VALUES(TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS reviewer_history_rollouts (
 owner_reviewer_id UUID PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE,
 coverage_epoch BIGINT NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 checked_by TEXT NOT NULL, comparison JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS reviewer_owner_mapping_reviews (
 id BIGSERIAL PRIMARY KEY, participant_id UUID NOT NULL, owner_reviewer_id UUID NOT NULL,
 evidence TEXT NOT NULL, reviewed_by TEXT NOT NULL, reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 previous_revision TEXT NOT NULL
);

-- ECMAScript String.trim whitespace, including NBSP/BOM and Unicode separators.
CREATE OR REPLACE FUNCTION review_cell_text(value TEXT) RETURNS TEXT
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT btrim(COALESCE(value,''), E' \t\n\r\f' || chr(11) || chr(160) || chr(5760) ||
   chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||
   chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
$$;

CREATE OR REPLACE FUNCTION refresh_reviewer_participation(target UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
 p campaign_participants%ROWTYPE; old_row reviewer_participations%ROWTYPE;
 snap JSONB; header TEXT; val TEXT; anchor_kind TEXT; v_anchor_value TEXT;
 obligation TEXT; ownership TEXT; assignment TEXT; life TEXT; dup BOOLEAN; edit RECORD;
 owner_id UUID; order_owner UUID; order_identity UUID; order_phone TEXT; participated_at TIMESTAMPTZ; same_participation BOOLEAN;
BEGIN
 -- Serialize with the workboard write/reassignment before reading the prior ledger state.
 SELECT * INTO p FROM campaign_participants WHERE id=target FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT os.owner_reviewer_id,os.submitted_at,os.participant_identity_id,
   RIGHT(regexp_replace(COALESCE(to_jsonb(os)->>'phone',''),'[^0-9]','','g'),8)
   INTO order_owner,participated_at,order_identity,order_phone FROM order_submissions os WHERE os.id=p.order_submission_id AND os.deleted_at IS NULL;
 assignment := CASE WHEN p.order_submission_id IS NOT NULL THEN 'order:'||p.order_submission_id::text
   ELSE 'row:'||COALESCE(p.first_seen_at::text,p.id::text) END;
 SELECT * INTO old_row FROM reviewer_participations WHERE campaign_participant_id=p.id
   ORDER BY (lifecycle_status='active') DESC,updated_at DESC,id DESC LIMIT 1;
 -- Completion and closure use the same assignment boundary, set by the BEFORE trigger.
 same_participation := old_row.id IS NOT NULL
   AND old_row.index_snapshot->>'_review_participation_id'=p.review_participation_id::text
   AND (old_row.lifecycle_status<>'cancelled' OR p.deleted_at IS NOT NULL
     OR EXISTS(SELECT 1 FROM order_submissions os WHERE os.id=p.order_submission_id AND os.deleted_at IS NOT NULL));
 IF same_participation THEN assignment:=old_row.assignment_key;
 ELSIF old_row.id IS NOT NULL THEN assignment:=assignment||':'||gen_random_uuid()::text;
 END IF;
 SELECT to_jsonb(ri) INTO snap FROM review_index ri WHERE ri.sheet_id=p.sheet_id AND ri.tab_name=p.tab_name AND ri.row_index=p.seq LIMIT 1;
 snap := COALESCE(snap,old_row.index_snapshot,'{}'::jsonb) || jsonb_build_object(
   'reviewer_name',p.reviewer_name,'recipient_name',p.recipient_name,'phone8',p.phone8,
   'sheet_id',p.sheet_id,'tab_name',p.tab_name,'tab_gid',p.tab_gid,'row_index',p.seq,
   'row_json',COALESCE(p.row_json,'{}'::jsonb),'product_name',p.product_name,'round',p.round,'_identity_key',p.identity_key,
   '_review_participation_id',p.review_participation_id);
 SELECT COALESCE(NULLIF(btrim(p.submit_col),''),NULLIF(btrim(snap->>'submit_col'),''),
   (SELECT NULLIF(btrim(ri.submit_col),'') FROM review_index ri
     WHERE ri.sheet_id=p.sheet_id AND ri.tab_name=p.tab_name AND NULLIF(btrim(ri.submit_col),'') IS NOT NULL LIMIT 1)) INTO header;
 val := review_cell_text(p.row_json->>header);
 anchor_kind := CASE WHEN p.order_submission_id IS NOT NULL THEN 'order' WHEN p.source='manual' THEN 'manual' ELSE 'identity' END;
 v_anchor_value := CASE anchor_kind WHEN 'order' THEN p.order_submission_id::text WHEN 'manual' THEN p.id::text ELSE p.identity_key END;
 dup:=FALSE;
 IF anchor_kind<>'manual' THEN
 SELECT EXISTS(SELECT 1 FROM campaign_participants q WHERE q.sheet_id=p.sheet_id AND q.tab_name=p.tab_name
   AND q.active=TRUE AND q.deleted_at IS NULL AND q.id<>p.id
   AND ((anchor_kind='order' AND q.order_submission_id=p.order_submission_id)
     OR (anchor_kind='identity' AND q.identity_key=p.identity_key))) INTO dup;
 END IF;
 IF NOT dup THEN
   FOR edit IN SELECT e.* FROM participant_edits e WHERE e.sheet_id=p.sheet_id AND e.tab_name=p.tab_name
     AND e.reverted_at IS NULL AND e.field='col:'||header
     AND ((e.anchor_type=anchor_kind AND e.anchor_value=v_anchor_value) OR (e.anchor_type='manual' AND e.anchor_value=p.id::text))
     ORDER BY (e.anchor_type=anchor_kind AND e.anchor_value=v_anchor_value) ASC
   LOOP val:=review_cell_text(CASE WHEN edit.kind='bool' THEN edit.value_bool::text ELSE edit.value_text END); END LOOP;
 END IF;
 obligation := CASE WHEN header IS NULL THEN 'unknown'
   WHEN lower(val) IN ('','false','미제출') THEN 'pending'
   WHEN val IN ('취소건','미작성 종결') THEN 'unknown' ELSE 'fulfilled' END;
 IF EXISTS(SELECT 1 FROM review_closed_targets c WHERE c.sheet_id=p.sheet_id AND c.tab_name=p.tab_name AND c.row_index=p.seq)
   THEN obligation:='closed_no_review'; END IF;
 -- A mirror rebuild or a blank edit cannot silently reopen a fulfilled obligation.
 IF same_participation AND old_row.review_obligation_status='fulfilled' AND obligation IN ('pending','unknown') THEN
   obligation:='fulfilled';
   val:=COALESCE(old_row.review_evidence->>'value',val);
   header:=COALESCE(header,old_row.review_evidence->>'header');
 END IF;
 owner_id:=p.owner_reviewer_id;
 ownership:=CASE WHEN owner_id IS NULL THEN 'unresolved'
   WHEN (order_owner IS NOT NULL AND order_owner<>owner_id) OR (dup AND p.order_submission_id IS NOT NULL) THEN 'conflict' ELSE 'confirmed' END;
 life:=CASE WHEN p.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM order_submissions os WHERE os.id=p.order_submission_id AND os.deleted_at IS NOT NULL) THEN 'cancelled'
   WHEN NOT p.active OR (p.order_submission_id IS NULL AND review_cell_text(p.reviewer_name)='' AND review_cell_text(p.phone8)='')
     OR EXISTS(SELECT 1 FROM tab_configs tc WHERE tc.sheet_id=p.sheet_id AND tc.tab_name=p.tab_name
     AND (tc.is_closed OR (NULLIF(p.round,'') IS NOT NULL AND p.round=ANY(regexp_split_to_array(btrim(COALESCE(tc.archived_rounds,'')),'[[:space:]]*,[[:space:]]*')))))
     OR EXISTS(SELECT 1 FROM index_master_archive a WHERE a.sheet_id=p.sheet_id AND a.tab_name=p.tab_name) THEN 'archived' ELSE 'active' END;
 UPDATE reviewer_participations SET lifecycle_status='cancelled',record_version=record_version+1,updated_at=now()
   WHERE campaign_participant_id=p.id AND assignment_key<>assignment AND lifecycle_status<>'cancelled';
 INSERT INTO reviewer_participations(campaign_participant_id,assignment_key,owner_reviewer_id,participant_identity_id,participant_phone8,
   ownership_status,ownership_source,sheet_id,tab_name,row_index,order_submission_id,review_obligation_status,review_evidence,index_snapshot,lifecycle_status,created_at)
 VALUES(p.id,assignment,owner_id,p.participant_identity_id,p.phone8,ownership,'participant',p.sheet_id,p.tab_name,p.seq,p.order_submission_id,
   obligation,jsonb_build_object('header',header,'value',val,'ambiguous',dup)
     || CASE WHEN same_participation AND old_row.review_evidence->>'web_submission'=p.review_participation_id::text
       THEN jsonb_build_object('web_submission',p.review_participation_id) ELSE '{}'::jsonb END,
   snap,life,COALESCE(participated_at,p.first_seen_at,now()))
 ON CONFLICT(campaign_participant_id,assignment_key) DO UPDATE SET
   owner_reviewer_id=EXCLUDED.owner_reviewer_id,participant_identity_id=EXCLUDED.participant_identity_id,participant_phone8=EXCLUDED.participant_phone8,
   ownership_status=EXCLUDED.ownership_status,sheet_id=EXCLUDED.sheet_id,tab_name=EXCLUDED.tab_name,row_index=EXCLUDED.row_index,
   order_submission_id=EXCLUDED.order_submission_id,review_obligation_status=EXCLUDED.review_obligation_status,review_evidence=EXCLUDED.review_evidence,
   index_snapshot=EXCLUDED.index_snapshot,lifecycle_status=EXCLUDED.lifecycle_status,record_version=reviewer_participations.record_version+1,updated_at=now()
 WHERE (reviewer_participations.owner_reviewer_id,reviewer_participations.participant_identity_id,reviewer_participations.participant_phone8,
   reviewer_participations.ownership_status,reviewer_participations.sheet_id,reviewer_participations.tab_name,reviewer_participations.row_index,
   reviewer_participations.order_submission_id,reviewer_participations.review_obligation_status,reviewer_participations.review_evidence,reviewer_participations.index_snapshot-ARRAY['id','built_at'],reviewer_participations.lifecycle_status)
 IS DISTINCT FROM (EXCLUDED.owner_reviewer_id,EXCLUDED.participant_identity_id,EXCLUDED.participant_phone8,EXCLUDED.ownership_status,
   EXCLUDED.sheet_id,EXCLUDED.tab_name,EXCLUDED.row_index,EXCLUDED.order_submission_id,EXCLUDED.review_obligation_status,EXCLUDED.review_evidence,EXCLUDED.index_snapshot-ARRAY['id','built_at'],EXCLUDED.lifecycle_status);
 -- Keep current index IDs available to attachment consumers without expiring pages.
 IF NOT FOUND THEN
   UPDATE reviewer_participations SET index_snapshot=snap WHERE campaign_participant_id=p.id AND assignment_key=assignment
     AND index_snapshot IS DISTINCT FROM snap;
 END IF;
 -- Invalidate only possibly affected accounts, persistently until operator recheck.
 -- Contact overlap is ONLY a reason to withhold cutover, never ownership evidence.
 IF life='active' AND ownership<>'confirmed' AND (old_row.id IS NULL OR old_row.ownership_status='confirmed'
   OR old_row.participant_phone8 IS DISTINCT FROM p.phone8
   OR COALESCE(old_row.index_snapshot->>'reviewer_name','') IS DISTINCT FROM COALESCE(p.reviewer_name,''))
   AND (p.order_submission_id IS NOT NULL OR NULLIF(p.reviewer_name,'') IS NOT NULL OR NULLIF(p.phone8,'') IS NOT NULL) THEN
   -- Epoch protects an in-flight comparison from races; serving already certified
   -- unrelated accounts does not depend on this global counter.
   UPDATE reviewer_history_control SET coverage_epoch=coverage_epoch+1 WHERE id=TRUE;
   UPDATE reviewer_history_rollouts r SET enabled=FALSE WHERE r.enabled AND (
     r.owner_reviewer_id IN (p.owner_reviewer_id,order_owner,old_row.owner_reviewer_id)
     OR EXISTS(SELECT 1 FROM reviewer_participations related WHERE related.owner_reviewer_id=r.owner_reviewer_id
       AND NULLIF(review_cell_text(p.phone8),'') IS NOT NULL AND related.participant_phone8=p.phone8)
     OR EXISTS(SELECT 1 FROM reviewers v WHERE v.id=r.owner_reviewer_id AND NULLIF(review_cell_text(p.phone8),'') IS NOT NULL
       AND (p.phone8=RIGHT(regexp_replace(COALESCE(to_jsonb(v)->>'phone8',to_jsonb(v)->>'phone',''),'[^0-9]','','g'),8)
         OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(to_jsonb(v)->'sub_accounts')='array'
           THEN to_jsonb(v)->'sub_accounts' ELSE '[]'::jsonb END) sub
           WHERE p.phone8=RIGHT(regexp_replace(COALESCE(sub->>'phone',''),'[^0-9]','','g'),8))))
   );
 END IF;
END $$;

CREATE OR REPLACE FUNCTION reviewer_participation_cp_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE peer RECORD; before_json JSONB; after_json JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN before_json:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN after_json:=to_jsonb(NEW); END IF;
 IF TG_OP='DELETE' THEN
   UPDATE reviewer_participations SET lifecycle_status=CASE WHEN EXISTS(SELECT 1 FROM review_index_archive a
     WHERE a.sheet_id=OLD.sheet_id AND a.tab_name=OLD.tab_name AND a.row_index=OLD.seq) THEN 'archived' ELSE 'cancelled' END,
     record_version=record_version+1,updated_at=now() WHERE campaign_participant_id=OLD.id AND lifecycle_status='active';
 ELSE PERFORM refresh_reviewer_participation(NEW.id); END IF;
 -- Both sides of a duplicate must enter/leave conflict together. Do not touch
 -- unrelated rows on ordinary cell edits.
 IF ((before_json->>'order_submission_id') IS NOT NULL OR (after_json->>'order_submission_id') IS NOT NULL
   OR COALESCE(before_json->>'source','manual')<>'manual' OR COALESCE(after_json->>'source','manual')<>'manual')
   AND (TG_OP<>'UPDATE' OR (before_json->>'order_submission_id',before_json->>'identity_key',before_json->>'active',before_json->>'deleted_at',before_json->>'sheet_id',before_json->>'tab_name')
   IS DISTINCT FROM (after_json->>'order_submission_id',after_json->>'identity_key',after_json->>'active',after_json->>'deleted_at',after_json->>'sheet_id',after_json->>'tab_name')) THEN
   FOR peer IN SELECT q.id FROM campaign_participants q WHERE q.id<>COALESCE(NEW.id,OLD.id)
     AND q.active AND q.deleted_at IS NULL AND EXISTS(SELECT 1 FROM (VALUES(before_json),(after_json)) j(v)
       WHERE q.sheet_id=j.v->>'sheet_id' AND q.tab_name=j.v->>'tab_name'
         AND ((q.order_submission_id::text=j.v->>'order_submission_id')
           OR (q.source<>'manual' AND q.identity_key=j.v->>'identity_key')))
     ORDER BY q.id
   LOOP PERFORM refresh_reviewer_participation(peer.id); END LOOP;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reviewer_participation_cp ON campaign_participants;
CREATE TRIGGER reviewer_participation_cp AFTER INSERT OR UPDATE OR DELETE ON campaign_participants
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_cp_trigger();

CREATE OR REPLACE FUNCTION reviewer_participation_owner_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE linked_order order_submissions%ROWTYPE;
BEGIN
 IF NEW.owner_reviewer_id IS NOT NULL OR NEW.order_submission_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.order_submission_id IS NOT DISTINCT FROM OLD.order_submission_id THEN RETURN NEW; END IF;
 SELECT * INTO linked_order FROM order_submissions WHERE id=NEW.order_submission_id AND deleted_at IS NULL;
 IF linked_order.owner_reviewer_id IS NOT NULL
   AND EXISTS(SELECT 1 FROM reviewers WHERE id=linked_order.owner_reviewer_id)
   AND (NULLIF(linked_order.participant_identity_key_hash,'') IS NOT NULL OR EXISTS(SELECT 1 FROM campaign_applications ca
     WHERE ca.id=linked_order.campaign_application_id AND ca.owner_reviewer_id=linked_order.owner_reviewer_id))
   AND NOT EXISTS(SELECT 1 FROM campaign_applications ca WHERE ca.id=linked_order.campaign_application_id
     AND ca.owner_reviewer_id IS NOT NULL AND ca.owner_reviewer_id<>linked_order.owner_reviewer_id)
   AND NOT EXISTS(SELECT 1 FROM participation_links pl WHERE pl.sheet_id=NEW.sheet_id AND pl.tab_name=NEW.tab_name AND pl.row_index=NEW.seq
     AND pl.owner_reviewer_id IS NOT NULL AND pl.owner_reviewer_id<>linked_order.owner_reviewer_id)
   AND NOT EXISTS(SELECT 1 FROM campaign_participants cp WHERE cp.sheet_id=NEW.sheet_id AND cp.tab_name=NEW.tab_name
     AND cp.id<>NEW.id AND cp.order_submission_id=NEW.order_submission_id AND cp.active=TRUE AND cp.deleted_at IS NULL) THEN
   NEW.owner_reviewer_id:=linked_order.owner_reviewer_id;
   NEW.participant_identity_id:=COALESCE(NEW.participant_identity_id,linked_order.participant_identity_id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reviewer_participation_owner ON campaign_participants;
CREATE TRIGGER reviewer_participation_owner BEFORE INSERT OR UPDATE ON campaign_participants
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_owner_trigger();

CREATE OR REPLACE FUNCTION reviewer_participation_index_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
 -- Rebuilds replace index IDs. Refresh display metadata without restoring an old assignment/owner/state.
 -- Identity and the workboard cell stay CP-authoritative even if this index write used an old snapshot.
 IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['id','built_at'])=(to_jsonb(NEW)-ARRAY['id','built_at']) THEN
   UPDATE reviewer_participations SET index_snapshot=index_snapshot||jsonb_build_object('id',NEW.id,'built_at',NEW.built_at)
     WHERE sheet_id=NEW.sheet_id AND tab_name=NEW.tab_name AND row_index=NEW.row_index AND lifecycle_status='active';
   RETURN NULL;
 END IF;
 FOR r IN SELECT id FROM campaign_participants WHERE sheet_id=NEW.sheet_id AND tab_name=NEW.tab_name AND seq=NEW.row_index
 LOOP PERFORM refresh_reviewer_participation(r.id); END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reviewer_participation_index ON review_index;
CREATE TRIGGER reviewer_participation_index AFTER INSERT OR UPDATE ON review_index
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_index_trigger();

CREATE OR REPLACE FUNCTION reviewer_participation_order_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
 IF NEW.owner_reviewer_id IS NOT NULL AND NEW.deleted_at IS NULL AND NULLIF(NEW.participant_identity_key_hash,'') IS NOT NULL
   AND EXISTS(SELECT 1 FROM reviewers WHERE id=NEW.owner_reviewer_id)
   AND NOT EXISTS(SELECT 1 FROM campaign_applications ca WHERE ca.id=NEW.campaign_application_id
     AND ca.owner_reviewer_id IS NOT NULL AND ca.owner_reviewer_id<>NEW.owner_reviewer_id) THEN
   UPDATE campaign_participants cp SET owner_reviewer_id=NEW.owner_reviewer_id,
     participant_identity_id=COALESCE(cp.participant_identity_id,NEW.participant_identity_id),updated_at=now()
    WHERE cp.order_submission_id=NEW.id AND cp.owner_reviewer_id IS NULL AND cp.active=TRUE AND cp.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM campaign_participants other WHERE other.id<>cp.id AND other.sheet_id=cp.sheet_id AND other.tab_name=cp.tab_name
        AND other.order_submission_id=NEW.id AND other.active=TRUE AND other.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM participation_links pl WHERE pl.sheet_id=cp.sheet_id AND pl.tab_name=cp.tab_name AND pl.row_index=cp.seq
        AND pl.owner_reviewer_id IS NOT NULL AND pl.owner_reviewer_id<>NEW.owner_reviewer_id);
 END IF;
 FOR r IN SELECT id FROM campaign_participants WHERE order_submission_id=NEW.id
 LOOP PERFORM refresh_reviewer_participation(r.id); END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reviewer_participation_order ON order_submissions;
CREATE TRIGGER reviewer_participation_order AFTER UPDATE OF owner_reviewer_id,participant_identity_key_hash,deleted_at ON order_submissions
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_order_trigger();

CREATE OR REPLACE FUNCTION reviewer_participation_tab_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
 IF (OLD.is_closed,OLD.archived_rounds) IS NOT DISTINCT FROM (NEW.is_closed,NEW.archived_rounds) THEN RETURN NULL; END IF;
 FOR r IN SELECT id FROM campaign_participants WHERE sheet_id=NEW.sheet_id AND tab_name=NEW.tab_name
 LOOP PERFORM refresh_reviewer_participation(r.id); END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reviewer_participation_tab ON tab_configs;
CREATE TRIGGER reviewer_participation_tab AFTER UPDATE OF is_closed,archived_rounds ON tab_configs
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_tab_trigger();

CREATE OR REPLACE FUNCTION reviewer_participation_scope_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD; before_json JSONB; after_json JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN before_json:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN after_json:=to_jsonb(NEW); END IF;
 IF TG_TABLE_NAME='participant_edits' AND COALESCE(after_json->>'field',before_json->>'field','') NOT LIKE 'col:%' THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='review_reminder_states' AND COALESCE(after_json->>'review_status','')<> 'closed_no_review'
   AND COALESCE(before_json->>'review_status','')<>'closed_no_review' THEN RETURN NULL; END IF;
 FOR r IN SELECT p.id FROM campaign_participants p WHERE EXISTS (
   SELECT 1 FROM (VALUES(before_json),(after_json)) j(v)
   WHERE p.sheet_id=j.v->>'sheet_id' AND p.tab_name=j.v->>'tab_name'
   AND ((TG_TABLE_NAME<>'participant_edits' AND p.seq=(j.v->>'row_index')::integer)
     OR (TG_TABLE_NAME='participant_edits' AND (
       (j.v->>'anchor_type'='manual' AND p.id::text=j.v->>'anchor_value') OR
       (j.v->>'anchor_type'='order' AND p.order_submission_id::text=j.v->>'anchor_value') OR
       (j.v->>'anchor_type'='identity' AND p.identity_key=j.v->>'anchor_value')))))
 LOOP PERFORM refresh_reviewer_participation(r.id); END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reviewer_participation_edits ON participant_edits;
CREATE TRIGGER reviewer_participation_edits AFTER INSERT OR UPDATE OR DELETE ON participant_edits
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_scope_trigger();
DROP TRIGGER IF EXISTS reviewer_participation_resolution ON workdesk_review_resolutions;
CREATE TRIGGER reviewer_participation_resolution AFTER INSERT OR UPDATE ON workdesk_review_resolutions
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_scope_trigger();
DROP TRIGGER IF EXISTS reviewer_participation_reminder ON review_reminder_states;
CREATE TRIGGER reviewer_participation_reminder AFTER INSERT OR UPDATE ON review_reminder_states
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_scope_trigger();

CREATE OR REPLACE FUNCTION reviewer_participation_audit_trigger() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (OLD.owner_reviewer_id,OLD.ownership_status,OLD.review_obligation_status,OLD.lifecycle_status)
   IS DISTINCT FROM (NEW.owner_reviewer_id,NEW.ownership_status,NEW.review_obligation_status,NEW.lifecycle_status) THEN
   INSERT INTO reviewer_participation_events(participation_id,before_state,after_state,actor)
   VALUES(NEW.id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE jsonb_build_object('owner',OLD.owner_reviewer_id,'review',OLD.review_obligation_status,'lifecycle',OLD.lifecycle_status) END,
     jsonb_build_object('owner',NEW.owner_reviewer_id,'review',NEW.review_obligation_status,'lifecycle',NEW.lifecycle_status),
     COALESCE(NULLIF(current_setting('app.review_actor',TRUE),''),
       (SELECT NULLIF(updated_by,'') FROM campaign_participants WHERE id=NEW.campaign_participant_id),'database_projection'));
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reviewer_participation_audit ON reviewer_participations;
CREATE TRIGGER reviewer_participation_audit AFTER INSERT OR UPDATE ON reviewer_participations
 FOR EACH ROW EXECUTE FUNCTION reviewer_participation_audit_trigger();
