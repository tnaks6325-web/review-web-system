'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const tool=require('../scripts/restore-historical-fees');
const {digest}=require('../src/services/historicalFeeRestore.service');
const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || process.cwd(),'nuru-backup-test-'));
fs.chmodSync(dir,0o700);
try {
 const filename=path.join(dir,'before.json'),state={upload:{file_blob:Buffer.from('synthetic immutable bank evidence')},time:new Date('2026-10-27T03:42:02Z')};
 tool.writePrivate(filename,{state,beforeHash:digest(state)});
 const reread=tool.readPrivateBackup(filename);
 assert.equal(digest(reread.state),reread.beforeHash,'real fsynced backup must decode archived bytes and preserve hash');
 assert.equal(fs.statSync(filename).mode&0o777,0o600);
 assert.throws(()=>tool.writePrivate(filename,{}),'backup is create-only');
 console.log('historical fee backup real filesystem roundtrip: PASS');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
