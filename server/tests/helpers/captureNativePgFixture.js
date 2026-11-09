'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process');
async function startNativeCaptureDatabase(){
 // Opt-in caller owns a new cluster. Never connect to an inherited/existing database.
 for(const key of Object.keys(process.env))if(key.startsWith('PG')||['DATABASE_URL','DATABASE_PRIVATE_URL','DATABASE_PUBLIC_URL'].includes(key))delete process.env[key];
 const scratch=process.env.CAPTURE_TEST_SCRATCH||path.join(os.homedir(),'.hermes/cache/scratch');fs.mkdirSync(scratch,{recursive:true});
 const dir=fs.mkdtempSync(path.join(scratch,'capture-native-'));
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 const env={PATH:process.env.PATH,HOME:os.homedir(),LANG:'C',LC_ALL:'C',TMPDIR:scratch};
 const bin=name=>process.env.CAPTURE_PG_BIN_DIR?path.join(process.env.CAPTURE_PG_BIN_DIR,name):name;
 let running=false,pool;
 try{
  execFileSync(bin('initdb'),['-D',dir,'-A','trust','-U','capturetest','--locale=C'],{env,stdio:'pipe'});
  execFileSync(bin('pg_ctl'),['-D',dir,'-l',path.join(dir,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${dir}`,'-w','start'],{env,stdio:'pipe'});running=true;
  const {Pool}=require('pg');
  pool=new Pool({host:'127.0.0.1',port,user:'capturetest',password:'local-test-only',database:'postgres',max:8,connectionTimeoutMillis:5000,options:'-c statement_timeout=8000 -c lock_timeout=6000'});
  const version=(await pool.query('SELECT version() v')).rows[0].v;
  return {pool,dir,port,version,reset:async()=>{await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public');},close:async()=>{await pool.end();execFileSync(bin('pg_ctl'),['-D',dir,'-m','fast','-w','stop'],{env,stdio:'pipe'});running=false;}};
 }catch(error){if(pool)await pool.end().catch(()=>{});if(running)execFileSync(bin('pg_ctl'),['-D',dir,'-m','fast','-w','stop'],{env,stdio:'pipe'});throw error;}
}
async function addDeletionSchema(h){
 const svc=require('../../src/services/workTabDelete.service');
 const existing=new Set(['order_submissions','review_submissions','payment_batch_items','tab_configs']);
 for(const table of [...svc.DELETE_TABLES,...svc.MONEY_TABLES.map(x=>x.table)])if(!existing.has(table))await h.pg.exec(`CREATE TABLE IF NOT EXISTS ${table}(sheet_id text,tab_name text)`);
 await h.pg.exec(`DELETE FROM payment_batch_items;
 ALTER TABLE payment_batch_items ADD COLUMN batch_id uuid,ADD COLUMN sheet_id text,ADD COLUMN tab_name text;
 CREATE TABLE payment_batches(id uuid PRIMARY KEY,historical_key text);
 CREATE TABLE payment_account_mismatch_reconciliations(batch_item_id uuid);
 ALTER TABLE raw_sheet_tabs ADD COLUMN tab_gid text;
 ALTER TABLE tab_configs ADD COLUMN sheetless boolean DEFAULT false;
 ALTER TABLE recruit_campaigns ADD COLUMN status text DEFAULT 'published',ADD COLUMN published_at timestamptz DEFAULT now(),ADD COLUMN archived_at timestamptz;
 ALTER TABLE review_submissions ADD COLUMN sheet_id text,ADD COLUMN tab_name text,ADD COLUMN file_id text,ADD COLUMN file_name text,ADD COLUMN reviewer_name text,ADD COLUMN slot_key text;
 CREATE TABLE work_orders(id text,title text,status text,created_by text,deleted_at timestamptz,linked_tab_sheet_id text,linked_tab_name text,linked_tab_gid text,tab_deleted_at timestamptz,tab_deleted_by text,tab_deleted_tab text,updated_at timestamptz);
 CREATE TABLE advertiser_campaigns(sheet_id text,tab_gid text);
 CREATE TABLE campaigns(sheet_id text);
 CREATE TABLE orphan_capture_tombstones(file_id text UNIQUE,file_name text,sheet_id text,tab_name text,reviewer_name text,slot_key text,reason text,recorded_by text);`);
}
function gate(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function tracedPool(pool,{before=async()=>{},after=async()=>{},connected=()=>{}}={}){
 return {query:(...a)=>pool.query(...a),connect:async()=>{const c=await pool.connect();connected(c.processID);return {query:async(sql,args)=>{await before(sql,args,c);const out=await c.query(sql,args);await after(sql,args,c,out);return out;},release:()=>c.release()};}};
}
async function waitUntilBlocked(pool,pid,blocker){
 const end=Date.now()+3500;
 while(Date.now()<end){const r=(await pool.query('SELECT pg_blocking_pids($1) blockers',[pid])).rows[0];if(r.blockers.includes(blocker))return;await new Promise(r=>setTimeout(r,15));}
 throw new Error(`Expected database backend ${pid} to wait for ${blocker}, but no actual PostgreSQL lock wait occurred`);
}
module.exports={startNativeCaptureDatabase,addDeletionSchema,gate,tracedPool,waitUntilBlocked};
