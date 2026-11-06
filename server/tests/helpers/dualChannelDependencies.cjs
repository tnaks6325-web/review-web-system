'use strict';
// Resolves the dual-channel services to THIS checkout only (the parallel-worktree bridge is retired).
const Module=require('node:module');const path=require('node:path');const resolve=Module._resolveFilename;
const names=new Set(['./dualChannelRuntime.service','./dualChannelLifecycle.service','./dualPurchaseProof.service']);
Module._resolveFilename=function(name,parent,...rest){
 if(names.has(name)&&parent?.filename.startsWith(path.resolve(__dirname,'../..')+'/'))return path.resolve(__dirname,'../../src/services',name+'.js');
 return resolve.call(this,name,parent,...rest);
};
