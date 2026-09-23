'use strict';
// Dry-run by default. No credentials are read from files; the operator must supply DATABASE_URL.
const migration=require('../src/services/reviewerHistoryMigration.service');
const pool=require('../src/db/pool');
const args=process.argv.slice(2);
const arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
async function main(){
  const by=arg('--by'),apply=args.includes('--apply');
  if(!process.env.DATABASE_URL) throw new Error('명시적으로 지정한 DATABASE_URL이 필요합니다.');
  if(apply&&!by) throw new Error('--apply에는 --by 담당자가 필요합니다.');
  if(arg('--repair-obligation')) return console.log(JSON.stringify(await migration.repairInvalidFulfillment({
    participationId:arg('--repair-obligation'),expectedVersion:arg('--version'),evidence:arg('--evidence'),by,confirm:apply})));
  if(arg('--disable-owner')) return console.log(JSON.stringify(await migration.disableOwner({ownerReviewerId:arg('--disable-owner'),by,confirm:apply})));
  if(arg('--assign-owner')) return console.log(JSON.stringify(await migration.assignReviewedOwner({
    rowId:arg('--row-id'),ownerReviewerId:arg('--assign-owner'),expectedRevision:arg('--revision'),evidence:arg('--evidence'),by,confirm:apply})));
  if(args.includes('--project')){
    if(!apply) return console.log(JSON.stringify({dryRun:true,action:'projection',message:'--apply를 지정해야 선택 배치를 적재합니다.'}));
    return console.log(JSON.stringify(await migration.projectBatch({after:arg('--after'),limit:arg('--limit')||100,confirm:true,by})));
  }
  if(arg('--certify-owner')){
    const owner=arg('--certify-owner');
    const identity=await require('../src/services/reviewerIdentity.service').getOwnerScopeByReviewerId(owner);
    if(!identity.ownerReviewerId||!identity.phone8s.length) throw new Error('등록 소유자를 확인하지 못했습니다.');
    const epoch=(await pool.query('SELECT coverage_epoch FROM reviewer_history_control WHERE id=TRUE')).rows[0].coverage_epoch;
    const search=require('../src/services/search.service').searchByName;
    const options={ownerReviewerId:owner,ownerPhone8s:identity.phone8s,strictPhoneScope:true,includeSubmitted:true};
    const legacy=await search('',identity.phone8s[0],options);
    if(legacy.error||!Array.isArray(legacy.results)) throw new Error('기존 내역 조회 실패');
    if(legacy.results.filter(r=>!r.isOrderPending).length>=400) throw new Error('기존 조회 상한에 닿았습니다. 전수 대조 전에는 전환하지 않습니다.');
    const projected=[];let cursor=null;
    do {
      const page=await search('',identity.phone8s[0],{...options,ownerHistory:true,historyLimit:100,historyCursor:cursor});
      projected.push(...page.results);cursor=page.nextCursor;
    }while(cursor);
    const comparison=migration.compare(legacy.results,projected);
    if(!apply) return console.log(JSON.stringify({dryRun:true,owner,comparison}));
    return console.log(JSON.stringify(await migration.certify({ownerReviewerId:owner,legacy:legacy.results,projected,confirm:true,by,coverageEpoch:epoch})));
  }
  if(apply){
    if(!arg('--row-id')||!arg('--revision')) throw new Error('--row-id와 사전조회 --revision이 필요합니다.');
    return console.log(JSON.stringify(await migration.applyVerified({rowId:arg('--row-id'),expectedRevision:arg('--revision'),confirm:true,by})));
  }
  console.log(JSON.stringify({dryRun:true,...await migration.preview({after:arg('--after'),limit:arg('--limit')||100})}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>pool.end());
