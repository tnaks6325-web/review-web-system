'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
test('server financialContext reuses actual form/account-edit/fee/mode resolver on the caller db',async()=>{
 const queries=[];
 const db={query:async(sql,args)=>{queries.push(sql);
 if(/FROM review_index ri/.test(sql))return {rows:[{sheetId:'s',tabName:'t',rowIndex:2,phone8:'12345678',reviewerName:'가',amountCells:{'결제금액':'19000'}}]};
 if(/FROM order_submissions/.test(sql)&&!/FROM unnest/.test(sql))return {rows:[{sheetId:'s',tabName:'t',sheetRow:2,price:'19000',feeSnapshot:1000,orderedAt:'2026-01-01',bank:'하나은행',account:'001234567',depositor:'가'}]};
 if(/FROM tab_configs tc/.test(sql))return {rows:[{sheetId:'s',tabName:'t',transferBank:'케이뱅크',depositName:'입금',sheetless:true}]};
 if(/FROM raw_sheet_tabs/.test(sql))return {rows:[{sheetId:'s',tabName:'t',headers:['은행','계좌번호','예금주']}]};
 if(/JOIN participant_edits pe/.test(sql))return {rows:[{sheetId:'s',tabName:'t',rowIndex:2,field:'col:계좌번호',value:'009876543',at:'2026-02-01',ambiguous:false}]};
 return {rows:[]};}};
 const svc=require('../src/services/payment.service');
 const result=await svc.resolveDualFinancialContext(db,{sheetId:'s',tabName:'t',rowIndex:2});
 assert.equal(result.bankAccount,'009876543');assert.equal(result.bankName,'하나은행');assert.equal(result.accountHolder,'가');
 assert.equal(result.reviewFee,1000);assert.equal(result.payoutMode,'ours');assert.equal(result.productPrice,19000);
 assert.ok(queries.some(q=>q.includes('JOIN participant_edits pe')));
});
