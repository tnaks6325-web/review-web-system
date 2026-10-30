'use strict';
const assert=require('assert');
const svc=require('../src/services/workTabDelete.service');
const queries=[];
const pool={connect:async()=>({query:async(sql)=>{
 queries.push(sql);
 if(/historical-fee:%/.test(sql))return{rows:[{id:'historical'}],rowCount:1};
 if(/^BEGIN|^ROLLBACK|pg_advisory/.test(sql))return{rows:[]};
 return{rows:[],rowCount:0};
},release(){}})};
(async()=>{
 const result=await svc.deleteTask({sheetId:'synthetic',tabName:'작업',confirm:true,forcePayment:true,pool,notifyIntranet:false});
 assert.equal(result.code,'history_only');
 assert.equal(queries.some(s=>/^\s*(DELETE|UPDATE|INSERT)/.test(s)),false,'even force payment deletion cannot erase historical proof or unlock it');
 assert(queries.includes('ROLLBACK'));
 console.log('historical fee forced work deletion blocked: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
