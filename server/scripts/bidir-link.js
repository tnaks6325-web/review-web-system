#!/usr/bin/env node
/**
 * 양방향 연결(결정 274) — 값이 같은 오더만 연결한다(사용자 확정 D1). 다르면 `diverged` 로 표시만 한다.
 *   DATABASE_URL=... node scripts/bidir-link.js <작업오더ID> [--dry]
 *   DATABASE_URL=... node scripts/bidir-link.js --all-same [--dry]   (진행 중 공고·인트라넷 오더 전부를 같은 규칙으로)
 * ★ 마감(보관) 공고 오더는 대상이 아니다(사용자 확정 2026-10-20). --dry = 쓰기 0(판정만).
 * ★ 켜는 순서(설계): 같은 오더 1건 → 10건 → 전체. 스위치(app_settings.bidir_sync.in2rw)는 따로 켠다.
 */
'use strict';
const { Pool } = require('pg');
const { linkSharedOrder } = require('../src/services/sharedPatch.service');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL 이 필요합니다.'); process.exit(2); }
  const dryRun = process.argv.includes('--dry');
  const db = new Pool({ connectionString: url, max: 2 });
  try {
    let ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
    if (process.argv.includes('--all-same')) {
      const { rows } = await db.query(
        `SELECT w.id FROM work_orders w JOIN recruit_campaigns c ON c.id = w.linked_campaign_id
          WHERE w.deleted_at IS NULL AND COALESCE(w.source_review_order_id,'') <> '' AND c.archived_at IS NULL
            AND w.bidir_state <> 'on' ORDER BY w.created_at`);
      ids = rows.map(r => r.id);
    }
    if (!ids.length) { console.error('작업오더 ID 또는 --all-same 이 필요합니다.'); process.exit(2); }
    for (const id of ids) {
      const out = await linkSharedOrder({ workOrderId: id, actor: 'bidir-link', dryRun, db });
      const b = out.body;
      console.log(id, out.status, b.state || b.code, b.diffs ? b.diffs.map(d => d.field).join(',') : '', b.error || '');
    }
  } finally {
    await db.end();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
