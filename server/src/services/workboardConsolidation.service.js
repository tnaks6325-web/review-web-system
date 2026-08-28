/**
 * 작업표/작업보드 통폐합의 전환 안전장치.
 *
 * 새 경로는 이 서비스가 반환하는 mode가 pilot/enabled일 때만 열 수 있다. 현재는
 * legacy가 기본값이며, 스냅샷 생성과 롤백 모드 복귀 외에는 기존 업무 데이터를 바꾸지 않는다.
 */
'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(next) { _pool = next || null; }

const MAX_TARGETS = 120;
const APPROVED_LEGACY_TARGET_COUNT = 120;
const EXCLUDED_LEGACY_TAB_NAMES = new Set(['4/27(메이커스)좋은상황_상황버섯진액 98건']);
const SNAPSHOT_TABLES = [
  { name: 'tab_configs', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'campaigns', predicate: 't.sheet_id = x.sheet_id' },
  { name: 'work_orders', predicate: 't.linked_tab_sheet_id = x.sheet_id AND t.linked_tab_name = x.tab_name' },
  { name: 'recruit_campaigns', predicate: 't.linked_sheet_id = x.sheet_id AND t.linked_tab_name = x.tab_name' },
  { name: 'campaign_participants', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'order_submissions', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'review_index', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'review_submissions', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'review_edit_requests', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'participant_edits', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'participation_links', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'payment_batch_items', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
  { name: 'raw_sheet_tabs', predicate: 't.sheet_id = x.sheet_id AND t.tab_name = x.tab_name' },
];

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) {
    const err = new Error('백업 대상 작업보드가 없습니다.'); err.code = 'targets_required'; throw err;
  }
  if (targets.length > MAX_TARGETS) {
    const err = new Error(`한 번에 백업할 수 있는 작업은 ${MAX_TARGETS}건까지입니다.`); err.code = 'too_many_targets'; throw err;
  }
  const seen = new Set();
  const out = [];
  for (const raw of targets) {
    const sheetId = String(raw && raw.sheetId || '').trim();
    const tabName = String(raw && raw.tabName || '').trim();
    if (!sheetId || !tabName) {
      const err = new Error('각 백업 대상에는 sheetId와 tabName이 필요합니다.'); err.code = 'bad_target'; throw err;
    }
    const key = `${sheetId}\u0000${tabName}`;
    if (!seen.has(key)) { seen.add(key); out.push({ sheetId, tabName }); }
  }
  return out;
}

function targetKey(x) { return `${x.sheetId}\u0000${x.tabName}`; }

async function listApprovedTargets() {
  const { rows } = await getPool().query(
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName", source,
            rollout_state AS "rolloutState", workboard_id AS "workboardId"
       FROM workboard_consolidation_targets
      ORDER BY source, approved_at, sheet_id, tab_name`
  );
  return rows;
}

async function assertApprovedTargets(client, targets) {
  const normalized = normalizeTargets(targets);
  const { rows } = await client.query(
    `SELECT sheet_id, tab_name FROM workboard_consolidation_targets
      WHERE (sheet_id, tab_name) IN (
        SELECT x.sheet_id, x.tab_name
          FROM jsonb_to_recordset($1::jsonb) AS x(sheet_id text, tab_name text)
      )`,
    [JSON.stringify(normalized.map(x => ({ sheet_id: x.sheetId, tab_name: x.tabName })))]
  );
  const approved = new Set(rows.map(r => `${r.sheet_id}\u0000${r.tab_name}`));
  const missing = normalized.filter(x => !approved.has(targetKey(x)));
  if (missing.length) {
    const err = new Error(`승인된 전환 목록에 없는 작업이 포함돼 있습니다: ${missing.map(x => x.tabName).join(', ')}`);
    err.code = 'target_not_approved'; throw err;
  }
  return normalized;
}

/** 기존 무시트 120건의 불변 승인 목록. 최초 확정 뒤에는 정확히 같은 목록만 멱등 허용한다. */
async function approveLegacyTargets({ targets, by = '' } = {}) {
  const normalized = normalizeTargets(targets);
  if (normalized.length !== APPROVED_LEGACY_TARGET_COUNT) {
    const err = new Error(`기존 작업 전환 목록은 정확히 ${APPROVED_LEGACY_TARGET_COUNT}건이어야 합니다.`);
    err.code = 'legacy_target_count_mismatch'; throw err;
  }
  const excluded = normalized.filter(x => EXCLUDED_LEGACY_TAB_NAMES.has(x.tabName));
  if (excluded.length) {
    const err = new Error(`전환 제외 작업이 포함돼 있습니다: ${excluded.map(x => x.tabName).join(', ')}`);
    err.code = 'excluded_target'; throw err;
  }
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('workboard_consolidation_legacy_targets'))`);
    const { rows: existing } = await client.query(
      `SELECT sheet_id, tab_name FROM workboard_consolidation_targets WHERE source = 'legacy_120' FOR UPDATE`
    );
    if (existing.length) {
      const before = new Set(existing.map(r => `${r.sheet_id}\u0000${r.tab_name}`));
      if (existing.length !== normalized.length || normalized.some(x => !before.has(targetKey(x)))) {
        const err = new Error('기존 120건 승인 목록은 이미 확정돼 변경할 수 없습니다.');
        err.code = 'legacy_targets_locked'; throw err;
      }
      await client.query('COMMIT');
      return { ok: true, approved: existing.length, idempotent: true };
    }
    const payload = normalized.map(x => ({ sheet_id: x.sheetId, tab_name: x.tabName }));
    const { rows: valid } = await client.query(
      `SELECT tc.sheet_id, tc.tab_name
         FROM tab_configs tc
         JOIN jsonb_to_recordset($1::jsonb) AS x(sheet_id text, tab_name text)
           ON x.sheet_id = tc.sheet_id AND x.tab_name = tc.tab_name
        WHERE COALESCE(tc.sheetless, FALSE) = TRUE`, [JSON.stringify(payload)]
    );
    if (valid.length !== normalized.length) {
      const err = new Error('목록 중 무시트 작업으로 확인되지 않는 항목이 있습니다.');
      err.code = 'legacy_target_not_sheetless'; throw err;
    }
    for (const target of normalized) {
      await client.query(
        `INSERT INTO workboard_consolidation_targets
           (sheet_id, tab_name, source, rollout_state, approved_by, updated_by)
         VALUES ($1, $2, 'legacy_120', 'approved', $3, $3)`,
        [target.sheetId, target.tabName, String(by || '').slice(0, 100)]
      );
    }
    await client.query('COMMIT');
    return { ok: true, approved: normalized.length, idempotent: false };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { client.release(); }
}

async function getControl() {
  const { rows } = await getPool().query(
    `SELECT mode, updated_at AS "updatedAt", updated_by AS "updatedBy", rollback_backup_id AS "rollbackBackupId"
       FROM workboard_consolidation_controls WHERE singleton = TRUE`
  );
  return rows[0] || { mode: 'legacy', updatedAt: null, updatedBy: '', rollbackBackupId: null };
}

/** 정책 확정 뒤 새로 생긴 무시트 작업에는 작업보드 ID를 자동으로 부여한다. */
async function ensureNewWorkTarget({ sheetId, tabName, by = '', client: suppliedClient = null } = {}) {
  const target = normalizeTargets([{ sheetId, tabName }])[0];
  const ownsTransaction = !suppliedClient;
  const client = suppliedClient || await getPool().connect();
  try {
    if (ownsTransaction) await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`workboard_consolidation_new:${target.sheetId}:${target.tabName}`]);
    const { rows: configs } = await client.query(
      `SELECT tc.workboard_id, COALESCE(tc.display_name, tc.tab_name) AS title,
              COALESCE(tc.sheetless, FALSE) AS sheetless, t.source, t.rollout_state
         FROM tab_configs tc
         LEFT JOIN workboard_consolidation_targets t
           ON t.sheet_id=tc.sheet_id AND t.tab_name=tc.tab_name
        WHERE tc.sheet_id=$1 AND tc.tab_name=$2 FOR UPDATE OF tc`,
      [target.sheetId, target.tabName]
    );
    const config = configs[0];
    if (!config || !config.sheetless) {
      const err = new Error('새 작업보드 자동 연결은 등록된 무시트 작업에만 허용됩니다.');
      err.code = 'new_target_not_sheetless'; throw err;
    }
    if (config.source === 'legacy_120') {
      if (ownsTransaction) await client.query('COMMIT');
      return { ok: true, source: config.source, rolloutState: config.rollout_state,
        workboardId: config.workboard_id, existing: true };
    }
    let workboardId = config.workboard_id;
    if (!workboardId) {
      const { rows: boards } = await client.query(
        `INSERT INTO workboards(title) VALUES ($1) RETURNING id`,
        [String(config.title || target.tabName).slice(0, 200)]
      );
      workboardId = boards[0].id;
      await client.query(
        `UPDATE tab_configs SET workboard_id=$3, updated_at=NOW()
          WHERE sheet_id=$1 AND tab_name=$2`, [target.sheetId, target.tabName, workboardId]
      );
    }
    const { rows: controls } = await client.query(
      `SELECT mode FROM workboard_consolidation_controls WHERE singleton=TRUE FOR UPDATE`
    );
    const rolloutState = controls[0] && controls[0].mode === 'enabled' ? 'enabled' : 'mapped';
    await client.query(
      `INSERT INTO workboard_consolidation_targets
         (sheet_id, tab_name, source, rollout_state, workboard_id, approved_by, updated_by)
       VALUES ($1,$2,'new_work',$3,$4,$5,$5)
       ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
         workboard_id=EXCLUDED.workboard_id,
         rollout_state=CASE
           WHEN workboard_consolidation_targets.source='new_work' THEN EXCLUDED.rollout_state
           ELSE workboard_consolidation_targets.rollout_state END,
         updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [target.sheetId, target.tabName, rolloutState, workboardId, String(by || '').slice(0, 100)]
    );
    const updates = [
      `UPDATE work_orders SET workboard_id=$3, updated_at=NOW()
        WHERE linked_tab_sheet_id=$1 AND linked_tab_name=$2 AND workboard_id IS NULL`,
      `UPDATE recruit_campaigns SET workboard_id=$3, updated_at=NOW()
        WHERE linked_sheet_id=$1 AND linked_tab_name=$2 AND workboard_id IS NULL`,
      `UPDATE order_submissions SET workboard_id=$3, updated_at=NOW()
        WHERE sheet_id=$1 AND tab_name=$2 AND workboard_id IS NULL`,
      `UPDATE campaign_participants SET workboard_id=$3, updated_at=NOW()
        WHERE sheet_id=$1 AND tab_name=$2 AND workboard_id IS NULL`,
    ];
    for (const sql of updates) await client.query(sql, [target.sheetId, target.tabName, workboardId]);
    if (ownsTransaction) await client.query('COMMIT');
    return { ok: true, source: 'new_work', rolloutState, workboardId, existing: !!config.workboard_id };
  } catch (err) {
    if (ownsTransaction) try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { if (ownsTransaction) client.release(); }
}

async function createPreCutoverBackup({ targets, reason = '', createdBy = '' } = {}) {
  const normalized = normalizeTargets(targets);
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('workboard_consolidation_backup'))`);
    await assertApprovedTargets(client, normalized);
    const { rows: header } = await client.query(
      `INSERT INTO workboard_consolidation_backups(targets, reason, created_by)
       VALUES ($1::jsonb, $2, $3) RETURNING id`,
      [JSON.stringify(normalized), String(reason || '').slice(0, 500), String(createdBy || '').slice(0, 100)]
    );
    const backupId = header[0].id;
    const counts = {};
    const digest = crypto.createHash('sha256');

    for (const table of SNAPSHOT_TABLES) {
      const exists = await client.query(`SELECT to_regclass($1) AS name`, [`public.${table.name}`]);
      if (!exists.rows[0].name) continue;
      const { rows } = await client.query(
        `SELECT to_jsonb(t) AS data
           FROM ${table.name} t
          WHERE EXISTS (
            SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x(sheet_id text, tab_name text)
             WHERE ${table.predicate}
          )
          ORDER BY t.id`,
        [JSON.stringify(normalized.map(x => ({ sheet_id: x.sheetId, tab_name: x.tabName })))]
      );
      counts[table.name] = rows.length;
      for (const row of rows) {
        const data = row.data;
        digest.update(table.name).update(JSON.stringify(data));
        await client.query(
          `INSERT INTO workboard_consolidation_backup_records(backup_id, table_name, row_data)
           VALUES ($1, $2, $3::jsonb)`, [backupId, table.name, JSON.stringify(data)]
        );
      }
    }

    const checksum = digest.digest('hex');
    await client.query(
      `UPDATE workboard_consolidation_backups
          SET record_counts = $2::jsonb, checksum = $3
        WHERE id = $1`, [backupId, JSON.stringify(counts), checksum]
    );
    await client.query('COMMIT');
    return { ok: true, backupId, targets: normalized, recordCounts: counts, checksum };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

function sameTargetSet(left, right) {
  const key = x => `${x.sheetId}\u0000${x.tabName}`;
  if (left.length !== right.length) return false;
  const a = new Set(left.map(key));
  return right.every(x => a.has(key(x)));
}

/**
 * sealed 백업과 정확히 같은 대상에만 새 작업보드 ID를 가산적으로 연결한다.
 * 기존 키는 절대 지우지 않고, 이미 다른 workboard_id가 있으면 충돌로 중단한다.
 */
async function createAdditiveMappings({ backupId, targets, by = '' } = {}) {
  if (!backupId) { const err = new Error('sealed 백업 ID가 필요합니다.'); err.code = 'backup_required'; throw err; }
  const normalized = normalizeTargets(targets);
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('workboard_consolidation_mapping'))`);
    await assertApprovedTargets(client, normalized);
    const { rows: backups } = await client.query(
      `SELECT targets FROM workboard_consolidation_backups WHERE id = $1 AND state = 'sealed' FOR UPDATE`, [backupId]
    );
    if (!backups.length) { const err = new Error('sealed 백업을 찾지 못했습니다.'); err.code = 'backup_not_found'; throw err; }
    const backupTargets = normalizeTargets(backups[0].targets || []);
    if (!sameTargetSet(backupTargets, normalized)) {
      const err = new Error('백업 대상과 연결 대상이 일치하지 않습니다. 새 백업을 만든 뒤 진행하세요.'); err.code = 'backup_target_mismatch'; throw err;
    }

    const made = [];
    for (const target of normalized) {
      const { rows: configs } = await client.query(
        `SELECT workboard_id, COALESCE(display_name, tab_name) AS title
           FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 FOR UPDATE`,
        [target.sheetId, target.tabName]
      );
      if (!configs.length) { const err = new Error(`작업 설정을 찾지 못했습니다: ${target.tabName}`); err.code = 'tab_not_found'; throw err; }
      if (configs[0].workboard_id) {
        const err = new Error(`이미 작업보드가 연결된 작업입니다: ${target.tabName}`); err.code = 'already_mapped'; throw err;
      }
      const { rows: boards } = await client.query(
        `INSERT INTO workboards(title) VALUES ($1) RETURNING id`, [String(configs[0].title || target.tabName).slice(0, 200)]
      );
      const workboardId = boards[0].id;
      const updates = [
        [`UPDATE tab_configs SET workboard_id = $3, updated_at = NOW() WHERE sheet_id = $1 AND tab_name = $2`, [target.sheetId, target.tabName, workboardId]],
        [`UPDATE work_orders SET workboard_id = $3, updated_at = NOW() WHERE linked_tab_sheet_id = $1 AND linked_tab_name = $2 AND workboard_id IS NULL`, [target.sheetId, target.tabName, workboardId]],
        [`UPDATE recruit_campaigns SET workboard_id = $3, updated_at = NOW() WHERE linked_sheet_id = $1 AND linked_tab_name = $2 AND workboard_id IS NULL`, [target.sheetId, target.tabName, workboardId]],
        [`UPDATE order_submissions SET workboard_id = $3, updated_at = NOW() WHERE sheet_id = $1 AND tab_name = $2 AND workboard_id IS NULL`, [target.sheetId, target.tabName, workboardId]],
        [`UPDATE campaign_participants SET workboard_id = $3, updated_at = NOW() WHERE sheet_id = $1 AND tab_name = $2 AND workboard_id IS NULL`, [target.sheetId, target.tabName, workboardId]],
      ];
      for (const [sql, params] of updates) await client.query(sql, params);
      await client.query(
        `INSERT INTO workboard_consolidation_link_events(backup_id, sheet_id, tab_name, workboard_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`, [backupId, target.sheetId, target.tabName, workboardId, String(by || '').slice(0, 100)]
      );
      await client.query(
        `UPDATE workboard_consolidation_targets
            SET rollout_state = 'mapped', workboard_id = $3, updated_by = $4, updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2`,
        [target.sheetId, target.tabName, workboardId, String(by || '').slice(0, 100)]
      );
      made.push({ ...target, workboardId });
    }
    await client.query('COMMIT');
    return { ok: true, backupId, mappings: made };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { client.release(); }
}

/**
 * 현재 단계의 즉시 롤백: 모든 신규 경로를 차단하고 기존 호환 경로만 사용한다.
 * 데이터 복원은 이후 전환 단계에서 작성되는 변경 저널과 sealed snapshot을 근거로 별도 확인 후 수행한다.
 */
async function setControlMode({ mode, targets = [], by = '' } = {}) {
  if (mode !== 'pilot' && mode !== 'enabled') {
    const err = new Error('전환 모드는 pilot 또는 enabled만 허용됩니다.'); err.code = 'bad_mode'; throw err;
  }
  const normalized = mode === 'pilot' ? normalizeTargets(targets) : [];
  if (mode === 'pilot' && normalized.length !== 1) {
    const err = new Error('pilot은 정확히 작업 1건만 선택해야 합니다.'); err.code = 'pilot_one_target_required'; throw err;
  }
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('workboard_consolidation_control'))`);
    if (mode === 'pilot') {
      await assertApprovedTargets(client, normalized);
      // pilot은 시스템 전체에서 정확히 1건이다. 다른 작업으로 시험 대상을 바꾸면 이전
      // pilot을 먼저 mapped로 내리지 않을 경우 두 작업이 동시에 새 경로를 타게 된다.
      await client.query(
        `UPDATE workboard_consolidation_targets SET rollout_state = 'mapped', updated_by = $1, updated_at = NOW()
          WHERE rollout_state = 'pilot'`, [String(by || '').slice(0, 100)]
      );
      const { rows } = await client.query(
        `SELECT workboard_id FROM workboard_consolidation_targets
          WHERE sheet_id = $1 AND tab_name = $2 AND rollout_state = 'mapped' FOR UPDATE`,
        [normalized[0].sheetId, normalized[0].tabName]
      );
      if (!rows.length || !rows[0].workboard_id) {
        const err = new Error('작업보드 연결을 마친 승인 작업만 pilot으로 시작할 수 있습니다.');
        err.code = 'pilot_target_not_mapped'; throw err;
      }
      await client.query(
        `UPDATE workboard_consolidation_targets SET rollout_state = 'pilot', updated_by = $3, updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2`,
        [normalized[0].sheetId, normalized[0].tabName, String(by || '').slice(0, 100)]
      );
    } else {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE rollout_state IN ('mapped','pilot','enabled') AND workboard_id IS NOT NULL)::int AS ready
           FROM workboard_consolidation_targets WHERE source = 'legacy_120'`
      );
      const counts = rows[0] || { total: 0, ready: 0 };
      if (counts.total !== APPROVED_LEGACY_TARGET_COUNT || counts.ready !== APPROVED_LEGACY_TARGET_COUNT) {
        const err = new Error('승인된 기존 작업 120건이 모두 연결된 뒤에만 전체 전환할 수 있습니다.');
        err.code = 'all_targets_not_ready'; throw err;
      }
      await client.query(
        `UPDATE workboard_consolidation_targets SET rollout_state = 'enabled', updated_by = $1, updated_at = NOW()
          WHERE source = 'legacy_120'`, [String(by || '').slice(0, 100)]
      );
      await client.query(
        `UPDATE workboard_consolidation_targets SET rollout_state = 'enabled', updated_by = $1, updated_at = NOW()
          WHERE source = 'new_work' AND workboard_id IS NOT NULL`, [String(by || '').slice(0, 100)]
      );
    }
    await client.query(
      `UPDATE workboard_consolidation_controls
          SET mode = $1, updated_at = NOW(), updated_by = $2, rollback_backup_id = NULL
        WHERE singleton = TRUE`, [mode, String(by || '').slice(0, 100)]
    );
    await client.query('COMMIT');
    return getControl();
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { client.release(); }
}

async function rollbackToLegacy({ backupId = null, by = '' } = {}) {
  const db = getPool();
  const client = await db.connect();
  let recoveredQueue = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('workboard_consolidation_control'))`);
    if (backupId) {
      const { rows } = await client.query(
        `SELECT id FROM workboard_consolidation_backups WHERE id = $1 AND state = 'sealed'`, [backupId]
      );
      if (!rows.length) { const err = new Error('유효한 sealed 백업을 찾지 못했습니다.'); err.code = 'backup_not_found'; throw err; }
    }
    await client.query(
      `INSERT INTO workboard_consolidation_controls(singleton, mode, updated_at, updated_by, rollback_backup_id)
       VALUES (TRUE, 'legacy', NOW(), $1, $2)
       ON CONFLICT (singleton) DO UPDATE SET
         mode = 'legacy', updated_at = NOW(), updated_by = EXCLUDED.updated_by,
         rollback_backup_id = EXCLUDED.rollback_backup_id`,
      [String(by || '').slice(0, 100), backupId]
    );
    const converted = await client.query(
      `UPDATE sync_queue q
          SET type = 'workboard_legacy_apply', status = 'pending', attempts = 0,
              error_msg = 'legacy rollback recovery', processed_at = NOW()
        WHERE q.type = 'workboard_apply' AND q.status <> 'done'
          AND EXISTS (
            SELECT 1 FROM workboard_consolidation_targets t
             WHERE t.sheet_id = q.payload->>'sheetId' AND t.tab_name = q.payload->>'tabName'
          )`
    );
    recoveredQueue = converted.rowCount || 0;
    await client.query(
      `UPDATE workboard_consolidation_targets SET rollout_state = 'mapped', updated_by = $1, updated_at = NOW()
        WHERE rollout_state IN ('pilot','enabled')`, [String(by || '').slice(0, 100)]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { client.release(); }
  return { ...(await getControl()), recoveredQueue };
}

/** 백업의 변경 저널에 있는 가산적 연결만 제거한다. 기존 연결은 대상이 아니다. */
async function revertAdditiveMappings({ backupId, by = '' } = {}) {
  if (!backupId) { const err = new Error('되돌릴 백업 ID가 필요합니다.'); err.code = 'backup_required'; throw err; }
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('workboard_consolidation_mapping'))`);
    const { rows: events } = await client.query(
      `SELECT sheet_id, tab_name, workboard_id FROM workboard_consolidation_link_events
        WHERE backup_id = $1 AND reverted_at IS NULL FOR UPDATE`, [backupId]
    );
    if (!events.length) { const err = new Error('되돌릴 활성 연결 변경이 없습니다.'); err.code = 'no_active_mapping'; throw err; }
    for (const event of events) {
      const updates = [
        `UPDATE campaign_participants SET workboard_id = NULL, updated_at = NOW() WHERE sheet_id = $1 AND tab_name = $2 AND workboard_id = $3`,
        `UPDATE order_submissions SET workboard_id = NULL, updated_at = NOW() WHERE sheet_id = $1 AND tab_name = $2 AND workboard_id = $3`,
        `UPDATE recruit_campaigns SET workboard_id = NULL, updated_at = NOW() WHERE linked_sheet_id = $1 AND linked_tab_name = $2 AND workboard_id = $3`,
        `UPDATE work_orders SET workboard_id = NULL, updated_at = NOW() WHERE linked_tab_sheet_id = $1 AND linked_tab_name = $2 AND workboard_id = $3`,
        `UPDATE tab_configs SET workboard_id = NULL, updated_at = NOW() WHERE sheet_id = $1 AND tab_name = $2 AND workboard_id = $3`,
      ];
      for (const sql of updates) await client.query(sql, [event.sheet_id, event.tab_name, event.workboard_id]);
      await client.query(
        `UPDATE workboard_consolidation_link_events SET reverted_at = NOW(), reverted_by = $2 WHERE backup_id = $1 AND sheet_id = $3 AND tab_name = $4`,
        [backupId, String(by || '').slice(0, 100), event.sheet_id, event.tab_name]
      );
      await client.query(
        `UPDATE workboard_consolidation_targets
            SET rollout_state = 'rolled_back', workboard_id = NULL, updated_by = $3, updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2`,
        [event.sheet_id, event.tab_name, String(by || '').slice(0, 100)]
      );
      // 변경 저널은 workboard_id를 감사 목적으로 계속 참조한다. 따라서 참조가 모두
      // 해제됐을 때도 물리 삭제하지 않고 archived로 보관해야 FK와 롤백 증적이 함께 남는다.
      await client.query(`UPDATE workboards SET state = 'archived', updated_at = NOW() WHERE id = $1
        AND NOT EXISTS (SELECT 1 FROM tab_configs WHERE workboard_id = $1)
        AND NOT EXISTS (SELECT 1 FROM work_orders WHERE workboard_id = $1)
        AND NOT EXISTS (SELECT 1 FROM recruit_campaigns WHERE workboard_id = $1)
        AND NOT EXISTS (SELECT 1 FROM order_submissions WHERE workboard_id = $1)
        AND NOT EXISTS (SELECT 1 FROM campaign_participants WHERE workboard_id = $1)`, [event.workboard_id]);
    }
    await client.query('COMMIT');
    return { ok: true, backupId, reverted: events.length };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { client.release(); }
}

module.exports = { MAX_TARGETS, APPROVED_LEGACY_TARGET_COUNT, normalizeTargets, listApprovedTargets,
  approveLegacyTargets, ensureNewWorkTarget, getControl, setControlMode, createPreCutoverBackup, createAdditiveMappings,
  rollbackToLegacy, revertAdditiveMappings, __setPoolForTest };
