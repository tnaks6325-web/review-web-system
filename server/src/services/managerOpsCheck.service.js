'use strict';
// Home manager questions. No AI, no separate assignment SQL: sharedPatch owns every manager write.
const { resolveWorkManager, mapWorkManager, UNDECIDED } = require('../utils/workManager');
const KIND = 'manager_assignment';
function isUnassigned(r) {
  const raw = String(r.work_manager || '').trim();
  const resolved = resolveWorkManager({orderWorkManager: raw, tabManager: r.tab_manager}).manager;
  // Reuse the canonical unresolved vocabulary, but require an exact value: e.g. 이미정 is a person, not 미정.
  const undecided = value => !String(value || '').trim() || UNDECIDED.includes(String(value).replace(/\s+/g,''));
  return undecided(raw) && undecided(resolved); // Unknown original or fallback names are never permission to overwrite.
}
const candidateSql = `SELECT w.*, tc.manager AS tab_manager, tc.display_name AS task_label,
  tc.sheet_id AS question_sheet_id, tc.tab_name AS question_tab_name, tc.tab_gid AS question_tab_gid,
  NOT EXISTS (SELECT 1 FROM recruit_campaigns c WHERE c.archived_at IS NOT NULL
    AND (c.id = NULLIF(w.linked_campaign_id, '') OR NULLIF(c.source_work_order_id, '') = w.id)) AS not_archived
 FROM tab_configs tc JOIN LATERAL (
  SELECT * FROM work_orders x WHERE x.deleted_at IS NULL
    AND x.linked_tab_sheet_id = tc.sheet_id AND x.linked_tab_name = tc.tab_name
  ORDER BY x.created_at DESC LIMIT 1
 ) w ON TRUE`;
async function withFinished(db, rows) {
  const tabs=require('./trackB.service');
  const fin=await tabs.finishedTabsMap(db);
  if(!fin.ok) throw new Error('마감 여부를 확인하지 못했습니다. 새로고침해 주세요.');
  return rows.map(row=>({...row,not_finished:!tabs.isTabFinishedIn(fin.map,row.question_sheet_id,row.question_tab_name,row.question_tab_gid)}));
}
async function current(db, id) {
  return (await withFinished(db,(await db.query(candidateSql + ' WHERE w.id = $1', [id])).rows))[0];
}
function eligible(r) {
  return !!r && !r.deleted_at && r.status !== 'done' && r.not_archived && r.not_finished
    && !!String(r.source_review_order_id || '').trim() && isUnassigned(r);
}
function factsOf(r) {
  return {workOrderId:r.id, baseVersion:Number(r.sync_version || 0),
    sheetId:r.question_sheet_id, tabName:r.question_tab_name,
    title:r.task_label || r.title || r.question_tab_name};
}
async function refresh(db) {
  if (String(process.env.BIDIR_HARD_OFF || '').trim() === '1') return;
  // Include existing questions so assignments made in the workboard also close them.
  const candidates=(await withFinished(db,(await db.query(candidateSql)).rows)).filter(eligible).map(r=>r.id);
  const open=(await db.query(`SELECT facts->>'workOrderId' AS id FROM ops_checks WHERE kind=$1 AND status='open'`,[KIND])).rows.map(r=>r.id);
  const ids=[...new Set([...candidates,...open])].filter(Boolean);
  for (const id of ids) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query("SET LOCAL statement_timeout = '10s'");
      await require('./linkedRecruitQuota.service').lockWorkOrderCampaigns(c, [id]);
      await c.query('SELECT id FROM work_orders WHERE id=$1 FOR UPDATE', [id]);
      const row = await current(c,id);
      const ref = `${KIND}:${id}`;
      if (eligible(row)) {
        const facts = factsOf(row), hash = require('./opsCheck.service').factsHash(facts);
        await c.query(`INSERT INTO ops_checks(kind,ref_key,facts,facts_hash,lines)
          VALUES($1,$2,$3::jsonb,$4,$5::jsonb)
          ON CONFLICT(ref_key) DO UPDATE SET facts=EXCLUDED.facts,facts_hash=EXCLUDED.facts_hash,
            lines=EXCLUDED.lines, status='open', done_at=NULL,done_by='', answers='{}'::jsonb,updated_at=NOW()
          WHERE ops_checks.facts_hash <> EXCLUDED.facts_hash OR ops_checks.status <> 'open'`,
          [KIND,ref,JSON.stringify(facts),hash,JSON.stringify([{key:'manager',text:'작업담당이 미지정입니다. 만두·망고 중 누가 맡을까요?'}])]);
      } else {
        await c.query(`UPDATE ops_checks SET status='done',done_at=NOW(),done_by='다른 화면에서 변경 또는 대상 종료',updated_at=NOW()
          WHERE ref_key=$1 AND status='open'`,[ref]);
      }
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
}
function canAnswer(item, allowed) {
  return {...item, canAnswer: !!allowed && item.status==='open' && String(process.env.BIDIR_HARD_OFF || '').trim() !== '1'};
}
async function answer({db,id,choice,baseVersion,admin,by}) {
  const {OpsCheckError} = require('./opsCheck.service');
  if (!['master','admin'].includes(admin && admin.role) || !await require('../utils/workdeskEditors').canEdit(admin)) {
    throw new OpsCheckError('forbidden','이 화면에서는 담당자를 배정할 권한이 없습니다.');
  }
  const target = {mandu:'박세희',mango:'박은비'}[choice];
  if (!target) throw new OpsCheckError('bad_choice','만두 또는 망고를 골라 주세요.');
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new OpsCheckError('stale','화면을 새로고침한 뒤 다시 선택해 주세요.');
  // Do NOT lock the question before acquiring the official L1/order locks, or open a second transaction inside them.
  const question = (await db.query('SELECT * FROM ops_checks WHERE id=$1',[id])).rows[0];
  if (!question || question.kind !== KIND) throw new OpsCheckError('not_found','확인할 것을 찾을 수 없습니다.');
  let locked;
  const result = await require('./sharedPatch.service').applySharedPatch({db,
    workOrderId:question.facts.workOrderId, mine:{work_manager:target}, baseVersion,
    origin:'rw_manager',managerOnly:true,actor:by,
    preHook:async(c,wo)=>{
      locked = (await c.query('SELECT * FROM ops_checks WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const conflict = ()=>({status:409,body:{ok:false,code:'stale',error:'이미 바뀐 질문입니다. 새로고침해 주세요.'}});
      // Serialize tab fallback changes with validation; never infer assignment from a stale tab value.
      await c.query('SELECT sheet_id FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 FOR UPDATE',
        [wo.linked_tab_sheet_id,wo.linked_tab_name]);
      if (!locked || locked.kind!==KIND || locked.facts.workOrderId!==wo.id
          || locked.facts.baseVersion!==baseVersion) return conflict();
      if (locked.status==='done') {
        const previous = locked.answers.manager;
        if (!previous || previous.choice!==choice || mapWorkManager(wo.work_manager)!==mapWorkManager(target)
            || Number(previous.savedVersion)!==Number(wo.sync_version)) return conflict();
        return null; // exact retry, including a lost successful response
      }
      if (Number(wo.sync_version)!==baseVersion || !eligible(await current(c,wo.id))) return conflict();
      return null;
    },
    managerCommitHook:async(c,saved)=>{
      if (locked.status==='done') return;
      const answers={manager:{choice,by:String(by||''),at:new Date().toISOString(),savedVersion:Number(saved.sync_version)}};
      await c.query(`UPDATE ops_checks SET answers=$2::jsonb,status='done',done_at=NOW(),done_by=$3,updated_at=NOW() WHERE id=$1`,
        [id,JSON.stringify(answers),String(by||'')]);
    },
  });
  if (!result.body.ok) {
    const e = new OpsCheckError(result.body.code || 'stale',result.body.error); e.status=result.status; throw e;
  }
  const item = (await db.query('SELECT * FROM ops_checks WHERE id=$1',[id])).rows[0];
  return syncView(db, require('./opsCheck.service').viewCheck(item));
}
async function syncView(db,item) {
  const answer = item.answers.manager;
  if (!answer) return item;
  const row=(await db.query(`SELECT status FROM shared_sync_outbox WHERE work_order_id=$1 AND sync_version=$2`,
    [item.facts.workOrderId,answer.savedVersion])).rows[0];
  return {...item,localSaved:true,remoteSync:row ? row.status : 'unknown'};
}
// A separate open-only cursor means bank LIMIT 50 and recent completed rows cannot starve assignments.
async function list({db,allowed=false,after=0}) {
  if (!Number.isSafeInteger(after) || after<0) throw new (require('./opsCheck.service').OpsCheckError)('bad_cursor','목록을 새로고침해 주세요.');
  const rows=(await db.query(`SELECT * FROM ops_checks WHERE kind=$1 AND status='open' AND id>$2 ORDER BY id LIMIT 51`,[KIND,after])).rows;
  const page=rows.slice(0,50);
  return {items:page.map(r=>canAnswer(require('./opsCheck.service').viewCheck(r),allowed)),
    hasMore:rows.length>50,nextAfter:page.length?Number(page[page.length-1].id):after};
}
module.exports={KIND,isUnassigned,eligible,factsOf,refresh,answer,canAnswer,candidateSql,list};
