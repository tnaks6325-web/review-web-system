'use strict';
// Read-only dependency bridge for the parallel-owned implementations; no source copies.
const Module=require('node:module');const resolve=Module._resolveFilename;
const paths={
 './dualChannelRuntime.service':'/Users/sooman/dev/wt/rw-dualchannel-settings/server/src/services/dualChannelRuntime.service.js',
 './dualChannelLifecycle.service':'/Users/sooman/dev/wt/rw-dualchannel-settings/server/src/services/dualChannelLifecycle.service.js',
 './dualPurchaseProof.service':'/Users/sooman/dev/wt/rw-dualchannel-purchase/server/src/services/dualPurchaseProof.service.js',
};
Module._resolveFilename=function(name,parent,...rest){
 if(paths[name]&&parent?.filename.startsWith(require('node:path').resolve(__dirname,'../..')+'/')){
  const local=require('node:path').resolve(__dirname,'../../src/services',name+'.js');
  return require('node:fs').existsSync(local)?local:paths[name];
 }
 return resolve.call(this,name,parent,...rest);
};
