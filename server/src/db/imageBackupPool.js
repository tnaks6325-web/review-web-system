'use strict';
// Lazy independent pool: importing this module opens no socket or business pool.
let pool;
function getPool() {
 if (!pool) {
  const {Pool}=require('pg');
  const connectionString=process.env.DATABASE_URL;
  const production=process.env.NODE_ENV==='production';
  const selfSigned=process.env.DATABASE_SSL_REJECT_UNAUTHORIZED==='false';
  const ssl=(production||/sslmode=require/.test(connectionString||'')||selfSigned)&&connectionString?
   {rejectUnauthorized:production?false:!selfSigned}:undefined;
  pool=new Pool({connectionString,ssl,max:2,connectionTimeoutMillis:500,
   idleTimeoutMillis:10000,statement_timeout:1000,query_timeout:1500,lock_timeout:100,
   idle_in_transaction_session_timeout:2000,application_name:'image-backup'});
  pool.on('error',()=>console.warn('[image-backup] DB_UNAVAILABLE'));
 }
 return pool;
}
async function close(){if(pool){const p=pool;pool=null;await p.end();}}
module.exports={getPool,close};
