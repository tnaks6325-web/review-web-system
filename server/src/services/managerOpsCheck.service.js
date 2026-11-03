'use strict';
// Home manager questions. No AI.
// Decision 311: intranet-linked work (an order with source_review_order_id) is written ONLY through sharedPatch.
// Decision 323: owned, active work with no intranet-linked order is written ONLY to the empty tab_configs.manager
//   cell (tab branch below) — never for a tab that has any order with an intranet source.
const { resolveWorkManager, mapWorkManager, UNDECIDED, normalizeManagerForStore } = require('../utils/workManager');
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
  // Tab-branch questions (decision 323) are refreshed by refreshTabs — never as work order ids.
  const open=(await db.query(`SELECT facts->>'workOrderId' AS id FROM ops_checks WHERE kind=$1 AND status='open'
    AND COALESCE(facts->>'target','order') <> 'tab'`,[KIND])).rows.map(r=>r.id);
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
  await refreshTabs(db);
}

/* ── Tab branch (decision 323) ───────────────────────────────────────────────
   Target = advertiser-owned + active on the home list (same scopedActiveTabs source, no copy) + not home-finished
   + empty tab_configs.manager + (no linked order, or the latest linked order has no intranet source and is undecided)
   + NO order with an intranet source linked to the tab at all (direct linked_tab_* or manual trackb_work_order_links).
   Those intranet-linked orders stay on the order branch / sharedPatch only (decision 306·311) — never the tab cell. */
const TAB_TEXT = '작업담당이 미지정입니다. 만두·망고 중 누가 맡을까요? (인트라넷 오더가 없는 작업이라 리뷰웹에만 저장됩니다)';
function _tabSuffix(sheetId, tabName, tabGid) {
  const g = String(tabGid == null ? '' : tabGid).trim();
  return `tab:${sheetId}:${g ? g : 'name:' + tabName}`;   // gid is rename-stable; name only when the tab has no gid
}
function tabRefKey(sheetId, tabName, tabGid) { return `${KIND}:${_tabSuffix(sheetId, tabName, tabGid)}`; }
const tabStateSql = `WITH t AS (SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS t(sheet_id, tab_name, tab_gid))
 SELECT t.sheet_id, t.tab_name, t.tab_gid, (tc.sheet_id IS NOT NULL) AS has_config,
   COALESCE(tc.manager, '') AS tab_manager, COALESCE(tc.display_name, '') AS display_name,
   w.id AS wo_id, COALESCE(w.source_review_order_id, '') AS wo_source, COALESCE(w.work_manager, '') AS wo_manager,
   EXISTS (SELECT 1 FROM work_orders z WHERE z.deleted_at IS NULL AND BTRIM(COALESCE(z.source_review_order_id, '')) <> ''
     AND ((z.linked_tab_sheet_id = t.sheet_id AND z.linked_tab_name = t.tab_name)
       OR z.id IN (SELECT l.work_order_id FROM trackb_work_order_links l
                    WHERE l.deleted_at IS NULL AND l.sheet_id = t.sheet_id AND l.tab_name = t.tab_name))) AS has_source_order
 FROM t
 LEFT JOIN tab_configs tc ON tc.sheet_id = t.sheet_id AND tc.tab_name = t.tab_name
 LEFT JOIN LATERAL (SELECT * FROM work_orders x WHERE x.deleted_at IS NULL
   AND x.linked_tab_sheet_id = t.sheet_id AND x.linked_tab_name = t.tab_name
   ORDER BY x.created_at DESC LIMIT 1) w ON TRUE`;
/** Active (home list) + advertiser-owned tabs, keyed by sheetId\ttabName. Same source as the home work list. */
async function ownedActiveTabs() {
  const tabs = await require('./trackB.service').scopedActiveTabs({ role: 'master', allWorkdesk: true, includeParticipantTabs: true, limit: 2000 });
  const map = new Map();
  for (const t of tabs) if (t.advertiserId) map.set(`${t.sheetId}\t${t.tabName}`, t);
  return map;
}
async function tabStates(db, list, owned) {
  if (!list.length) return [];
  const fin = await require('./trackB.service').finishedTabsMap(db);
  if (!fin.ok) throw new Error('마감 여부를 확인하지 못했습니다. 새로고침해 주세요.');
  const { rows } = await db.query(tabStateSql, [list.map(x => x.sheetId), list.map(x => x.tabName), list.map(x => x.tabGid == null ? '' : String(x.tabGid))]);
  const tabs = require('./trackB.service');
  return rows.map(r => {
    // ★ gid = 지금 홈 목록이 아는 그 탭의 gid(질문 facts 에 박힌 옛 gid 가 아니다 · Codex P2 #1747).
    //   gid 없던 탭이 나중에 gid 를 얻으면 옛 이름 키 질문은 키가 달라져 닫히고(refresh)·답은 409(answer),
    //   마감 판정도 현재 gid 로 본다(gid 로만 남은 마감 기록을 놓치지 않는다).
    const o = owned.get(`${r.sheet_id}\t${r.tab_name}`);
    const tab_gid = o ? String(o.tabGid == null ? '' : o.tabGid).trim() : String(r.tab_gid == null ? '' : r.tab_gid).trim();
    return { ...r, tab_gid, owned_active: !!o,
      not_finished: !tabs.isTabFinishedIn(fin.map, r.sheet_id, r.tab_name, tab_gid) };
  });
}
function eligibleTab(r) {
  return !!r && r.owned_active && r.not_finished && !String(r.tab_manager || '').trim() && !r.has_source_order
    && (!r.wo_id || (!String(r.wo_source || '').trim() && isUnassigned({ work_manager: r.wo_manager, tab_manager: '' })));
}
function tabFactsOf(r) {
  const tabGid = String(r.tab_gid == null ? '' : r.tab_gid).trim();
  // workOrderId here is a display discriminator only (the deployed home renders a work title when it is truthy) —
  // it is NEVER a work_orders.id. Old servers that read it as an order id find no order and write nothing.
  return { target: 'tab', workOrderId: _tabSuffix(r.sheet_id, r.tab_name, tabGid), baseVersion: 0,
    sheetId: r.sheet_id, tabName: r.tab_name, tabGid, title: r.display_name || r.tab_name };
}
async function refreshTabs(db) {
  const owned = await ownedActiveTabs();
  const ownedList = [...owned.values()].map(t => ({ sheetId: t.sheetId, tabName: t.tabName, tabGid: t.tabGid }));
  const candidates = (await tabStates(db, ownedList, owned)).filter(eligibleTab);
  const open = (await db.query(`SELECT ref_key, facts FROM ops_checks WHERE kind=$1 AND status='open' AND facts->>'target'='tab'`, [KIND])).rows;
  const work = new Map();
  for (const r of candidates) work.set(tabRefKey(r.sheet_id, r.tab_name, r.tab_gid), { sheetId: r.sheet_id, tabName: r.tab_name, tabGid: r.tab_gid });
  for (const q of open) if (!work.has(q.ref_key)) work.set(q.ref_key, { sheetId: q.facts.sheetId, tabName: q.facts.tabName, tabGid: q.facts.tabGid, ref: q.ref_key });
  for (const [ref, tab] of work) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query("SET LOCAL statement_timeout = '10s'");
      // Same lock order as answerTab: tab_configs row → question row.
      await c.query('SELECT 1 FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 FOR UPDATE', [tab.sheetId, tab.tabName]);
      const row = (await tabStates(c, [tab], owned))[0];
      if (eligibleTab(row) && tabRefKey(row.sheet_id, row.tab_name, row.tab_gid) === ref) {
        const facts = tabFactsOf(row), hash = require('./opsCheck.service').factsHash(facts);
        await c.query(`INSERT INTO ops_checks(kind,ref_key,facts,facts_hash,lines)
          VALUES($1,$2,$3::jsonb,$4,$5::jsonb)
          ON CONFLICT(ref_key) DO UPDATE SET facts=EXCLUDED.facts,facts_hash=EXCLUDED.facts_hash,
            lines=EXCLUDED.lines, status='open', done_at=NULL,done_by='', answers='{}'::jsonb,updated_at=NOW()
          WHERE ops_checks.facts_hash <> EXCLUDED.facts_hash OR ops_checks.status <> 'open'`,
          [KIND, ref, JSON.stringify(facts), hash, JSON.stringify([{ key: 'manager', text: TAB_TEXT }])]);
      } else {
        // Assigned elsewhere, finished, no longer owned/active, or an intranet-linked order arrived (→ order branch).
        await c.query(`UPDATE ops_checks SET status='done',done_at=NOW(),done_by='다른 화면에서 변경 또는 대상 종료',updated_at=NOW()
          WHERE ref_key=$1 AND status='open'`, [ref]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
}
async function answerTab({ db, id, question, choice, baseVersion, by }) {
  const { OpsCheckError } = require('./opsCheck.service');
  const conflict = () => { const e = new OpsCheckError('stale', '이미 바뀐 질문입니다. 새로고침해 주세요.'); e.status = 409; return e; };
  const value = normalizeManagerForStore({ mandu: '박세희', mango: '박은비' }[choice]);   // → 만두 / 망고 (tab cell vocabulary)
  const f = question.facts || {};
  const tab = { sheetId: f.sheetId, tabName: f.tabName, tabGid: f.tabGid };
  if (!tab.sheetId || !tab.tabName) throw conflict();
  const owned = await ownedActiveTabs();   // non-locking scope read, same source as refresh
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '5s'");
    await c.query("SET LOCAL statement_timeout = '10s'");
    // POST /api/trackb/tab/config convention: a tab without a tab_configs row gets one (upsert). Rolled back on any refusal.
    await c.query('INSERT INTO tab_configs (sheet_id, tab_name, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (sheet_id, tab_name) DO NOTHING', [tab.sheetId, tab.tabName]);
    const cfg = (await c.query('SELECT manager FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 FOR UPDATE', [tab.sheetId, tab.tabName])).rows[0];
    const locked = (await c.query('SELECT * FROM ops_checks WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!locked || locked.kind !== KIND || (locked.facts || {}).target !== 'tab' || locked.ref_key !== question.ref_key
        || Number(locked.facts.baseVersion) !== baseVersion) throw conflict();
    if (locked.status === 'done') {
      const prev = (locked.answers || {}).manager;
      // Exact retry (e.g. lost response): same choice and the cell still holds exactly what that answer wrote.
      if (!prev || prev.choice !== choice || String(cfg && cfg.manager || '').trim() !== value) throw conflict();
      await c.query('ROLLBACK');
      return;
    }
    const row = (await tabStates(c, [tab], owned))[0];
    if (!eligibleTab(row) || tabRefKey(row.sheet_id, row.tab_name, row.tab_gid) !== locked.ref_key) throw conflict();
    const w = await c.query(`UPDATE tab_configs SET manager=$3, updated_at=NOW()
      WHERE sheet_id=$1 AND tab_name=$2 AND BTRIM(COALESCE(manager, ''))=''`, [tab.sheetId, tab.tabName, value]);
    if (w.rowCount !== 1) throw conflict();   // blank-only: never overwrite a manager someone else set
    const answers = { manager: { choice, by: String(by || ''), at: new Date().toISOString(), savedVersion: 0, target: 'tab' } };
    await c.query(`UPDATE ops_checks SET answers=$2::jsonb,status='done',done_at=NOW(),done_by=$3,updated_at=NOW() WHERE id=$1`,
      [id, JSON.stringify(answers), String(by || '')]);
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; } finally { c.release(); }
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
  if ((question.facts || {}).target === 'tab') {
    // Same emergency stop as the order branch (the list already shows canAnswer:false under it).
    if (String(process.env.BIDIR_HARD_OFF || '').trim() === '1') { const e=new OpsCheckError('bidir_off','양방향 동기화가 꺼져 있습니다.'); e.status=503; throw e; }
    await answerTab({db,id,question,choice,baseVersion,by});
    const saved = (await db.query('SELECT * FROM ops_checks WHERE id=$1',[id])).rows[0];
    return syncView(db, require('./opsCheck.service').viewCheck(saved));
  }
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
  // Decision 323: tab-branch answers live only in Review Web — there is no intranet order to deliver to.
  if ((item.facts || {}).target === 'tab') return {...item,localSaved:true,remoteSync:'not_linked'};
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
module.exports={KIND,isUnassigned,eligible,factsOf,refresh,answer,canAnswer,candidateSql,list,
  eligibleTab,tabFactsOf,tabRefKey,tabStateSql,refreshTabs};
