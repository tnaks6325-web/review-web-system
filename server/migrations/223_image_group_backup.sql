-- Independent, append-retained backup records. No business foreign keys or purge.
BEGIN;
CREATE TABLE IF NOT EXISTS image_backup_outbox (
 id bigserial PRIMARY KEY, job_key text NOT NULL UNIQUE, file_id text NOT NULL,
 observation jsonb NOT NULL, status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','running','retry','done','blocked','superseded')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, receipt jsonb, last_error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS image_backup_due ON image_backup_outbox(next_attempt_at,id) WHERE status IN ('pending','retry');
CREATE INDEX IF NOT EXISTS image_backup_expired ON image_backup_outbox(lease_until) WHERE status='running';
CREATE TABLE IF NOT EXISTS image_backup_scans (
 id bigserial PRIMARY KEY, state text NOT NULL DEFAULT 'running'
 CHECK(state IN ('running','incomplete','publishing','failed','complete')),
 root_set_hash text NOT NULL, roots jsonb NOT NULL, lease_token uuid, lease_until timestamptz,
 base_generation text, base_etag text, counts jsonb NOT NULL DEFAULT '{}',
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS image_backup_singleton ON image_backup_scans((1)) WHERE state IN ('running','incomplete','publishing');
CREATE TABLE IF NOT EXISTS image_backup_scan_entries (
 scan_id bigint NOT NULL, entry_key text NOT NULL, kind text NOT NULL CHECK(kind IN ('folder','file')),
 data jsonb NOT NULL, job_key text, state text NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','done','excluded','unresolved')), PRIMARY KEY(scan_id,entry_key)
);
CREATE INDEX IF NOT EXISTS image_backup_scan_jobs ON image_backup_scan_entries(job_key,scan_id);
CREATE INDEX IF NOT EXISTS image_backup_scan_pending ON image_backup_scan_entries(scan_id,state,entry_key);
COMMIT;
