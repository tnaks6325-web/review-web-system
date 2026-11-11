'use strict';
const assert=require('node:assert/strict'),fs=require('fs');
(async()=>{
 const source=fs.readFileSync(require.resolve('../src/services/paymentResultArchive.service'),'utf8');assert.equal((source.match(/backupSource: 'payment_result'/g)||[]).length,2,'both payment upload opts excluded');
 const cron=fs.readFileSync(require.resolve('../src/jobs/cron'),'utf8');assert.ok(cron.includes("'*/15 * * * * *'"),'15 sec drain');assert.ok(cron.includes("'30 3 * * *'"),'03:30 nightly');
 const runner=fs.readFileSync(require.resolve('../scripts/run-tests'),'utf8');for(const env of ['IMAGE_BACKUP_ENABLED','IMAGE_BACKUP_API_KEY','IMAGE_BACKUP_URL','IMAGE_BACKUP_ALLOWED_ROOT_IDS','IMAGE_BACKUP_EXCLUDED_ROOT_IDS','IMAGE_BACKUP_ROOT_READERS','IMG_SIGNING_KEY','IMG_ORIGIN_KEY'])assert.ok(runner.includes("'"+env+"'"),env+' removed from child env');
 console.log('PASS imageBackupWiring: both payment uploads, cron schedule, source/backup key isolation (3 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
