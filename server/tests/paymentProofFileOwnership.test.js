'use strict';
const assert=require('assert'),crypto=require('crypto'),XLSX=require('@e965/xlsx'),{PGlite}=require('@electric-sql/pglite');
const {KBANK_AOA}=require('./fixtures/paymentResultFixtures');
const {loadSheetAoa}=require('../src/utils/spreadsheetLoad');
const {parseResultAoa}=require('../src/utils/paymentResultParse');
const proof=require('../src/services/paymentProof.service');
function fixture(account,count=1) {
 const header=KBANK_AOA[0],i=header.findIndex(h=>/입금계좌/.test(h));
 const aoa=[header,...Array.from({length:count},(_,n)=>{const row=KBANK_AOA[1].slice();row[i]='신한 '+account+String(n+1).padStart(3,'0');return row;})];
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(aoa),'결과');
 const bytes=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const row=parseResultAoa(loadSheetAoa(bytes,'result.xlsx').aoa,{expectBank:'kbank'}).rows[0];
 return {bytes,sha,row};
}
(async()=>{
 const db=new PGlite();
 try {
  await db.exec(`CREATE TABLE payment_batches(id text,historical_key text);
   CREATE TABLE payment_result_uploads(id text,batch_id text,file_format text,file_sha256 text,file_blob bytea,applied boolean);
   CREATE TABLE payment_batch_items(batch_id text,status text,result_seq integer,bank_account text,amount integer,paid_at timestamptz);
   CREATE TABLE unconfirmed_transfer_reviews(upload_id text,result_seq integer);
   CREATE TABLE payment_account_mismatch_reconciliations(upload_id text,result_seq integer);
   CREATE TABLE payment_amount_mismatch_reconciliations(upload_id text,result_seq integer);
   CREATE TABLE payment_records(source_key text);
   INSERT INTO payment_batches VALUES('batch',NULL);`);
  const a=fixture('123001'),b=fixture('123002');assert.equal(a.row.seq,b.row.seq);
  for(const [id,x] of [['A',a],['B',b]])await db.query("INSERT INTO payment_result_uploads VALUES($1,'batch','xlsx',$2,$3,true)",[id,x.sha,x.bytes]);
  await db.query("INSERT INTO payment_batch_items VALUES('batch','paid',$1,$2,$3,$4)",[a.row.seq,a.row.accountDigits,a.row.amount,a.row.transferredAtIso]);
  await proof.assertProofUnused(db,{sha:b.sha,uploadId:'B',resultSeq:b.row.seq});
  await assert.rejects(proof.assertProofUnused(db,{sha:a.sha,uploadId:'A',resultSeq:a.row.seq}),e=>e.code==='proof_already_used');
  await db.query('UPDATE payment_batch_items SET bank_account=$1,amount=$2,paid_at=$3',[b.row.accountDigits,b.row.amount,b.row.transferredAtIso]);
  await assert.rejects(proof.assertProofUnused(db,{sha:b.sha,uploadId:'B',resultSeq:b.row.seq}),e=>e.code==='proof_already_used');
  await db.query('UPDATE payment_batch_items SET paid_at=paid_at - INTERVAL \'1 second\'');
  await assert.rejects(proof.assertProofUnused(db,{sha:b.sha,uploadId:'B',resultSeq:b.row.seq}),e=>e.code==='invalid_evidence','timestamp drift is ambiguous, not proof that identical account/amount is unused');
  await db.exec('DELETE FROM payment_batch_items');
  assert.equal(typeof proof.assertProofRowsUnused,'function','batch proof validation must load archives once');
  const many=fixture('200000',500);
  const manyRows=parseResultAoa(loadSheetAoa(many.bytes,'result.xlsx').aoa).rows;assert.equal(manyRows.length,500);
  await db.query("INSERT INTO payment_result_uploads VALUES('many','batch','xlsx',$1,$2,true)",[many.sha,many.bytes]);
  let queries=0,blobReads=0;
  const counted={query:(sql,args)=>{queries++;if(/SELECT id, batch_id, file_format/.test(sql))blobReads++;return db.query(sql,args);}};
  await proof.assertProofRowsUnused(counted,{sha:many.sha,uploadId:'many',resultSeqs:manyRows.map(r=>r.seq)});
  assert(queries<=6,`500 proof rows must use bounded queries, got ${queries}`);assert.equal(blobReads,1);
  console.log('paymentProofFileOwnership: actual file account/amount/time association and 500 rows bounded-query PASS');
 } finally {await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
