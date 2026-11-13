'use strict';
const express=require('express');
const {reviewerSessionMiddleware}=require('../services/reviewerSession.service');
const {authMiddleware,internalOnlyMiddleware}=require('../middleware/auth.middleware');
const {imageUploadLimiter}=require('../middleware/rateLimit.middleware');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function inputError(text='요청 내용을 다시 확인해 주세요.') {return Object.assign(new Error(text),{status:400,code:'capture_request_invalid'});}
function bodyFields(body,keys){
  if(!body||typeof body!=='object'||Array.isArray(body))throw inputError();
  return Object.fromEntries(keys.filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
}
function identifier(value){if(typeof value!=='string'||!UUID.test(value))throw inputError();return value;}
function sendError(res,error){
  const raw=error&&(error.status||error.statusCode);
  const status=Number.isInteger(raw)&&raw>=400&&raw<600?raw:500;
  const expected=status<500;
  const code=expected&&/^[a-zA-Z0-9_]{1,80}$/.test(error&&error.code||'')?error.code:'capture_request_failed';
  if(!expected){
    require('../utils/logger').logger.error('[purchase-capture] 요청 처리 실패',{code:String(error&&error.code||'unknown').slice(0,80)});
  }
  return res.status(status).json({ok:false,code,error:expected?String(error.message||'요청을 다시 확인해 주세요.').slice(0,500):'구매사진을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'});
}
function createPurchaseCaptureRouters({core,checks,uploadLimiter=imageUploadLimiter}={}){
  const reviewerRouter=express.Router(),staffRouter=express.Router();
  const photos=()=>core||require('../services/purchaseCaptureSelfService.service');
  const requests=()=>checks||require('../services/purchaseCaptureCheck.service');
  const noStore=(_req,res,next)=>{res.set('Cache-Control','no-store');next();};
  const reviewer=[noStore,reviewerSessionMiddleware];
  const staff=[noStore,authMiddleware,internalOnlyMiddleware];
  reviewerRouter.get('/purchase-captures',...reviewer,async(req,res)=>{
    try{
      if(req.query.limit!=null&&!/^[1-9][0-9]{0,2}$/.test(String(req.query.limit)))throw inputError();
      const result=await photos().listForReviewer({session:req.reviewer,limit:req.query.limit});
      if(!result||!Array.isArray(result.items))throw new Error('invalid list response');
      return res.json({ok:true,items:result.items,hasMore:result.hasMore===true});
    }catch(error){return sendError(res,error);}
  });
  reviewerRouter.get('/purchase-captures/:orderId',...reviewer,async(req,res)=>{
    try{
      const result=await photos().getForReviewer({session:req.reviewer,orderSubmissionId:identifier(req.params.orderId)});
      const item=result&&result.item||result;
      if(!item||typeof item!=='object')throw new Error('invalid item response');
      return res.json({ok:true,item});
    }catch(error){return sendError(res,error);}
  });
  reviewerRouter.post('/purchase-captures/:orderId/supplements',...reviewer,uploadLimiter,async(req,res)=>{
    try{
      const fields=bodyFields(req.body,['channel','imageBase64','mimeType','requestKey','expectedEvidenceHash','requestCheck']);
      const result=await photos().addSupplement({...fields,session:req.reviewer,orderSubmissionId:identifier(req.params.orderId)});
      if(!result||!result.item)throw new Error('invalid supplement response');
      return res.json({ok:true,item:result.item,request:result.request||null});
    }catch(error){return sendError(res,error);}
  });
  reviewerRouter.post('/purchase-captures/:orderId/check-requests',...reviewer,async(req,res)=>{
    try{
      const fields=bodyFields(req.body,['channel','expectedEvidenceHash','note']);
      const result=await requests().requestCheck({...fields,session:req.reviewer,orderSubmissionId:identifier(req.params.orderId)});
      if(!result||!result.request||!result.item)throw new Error('invalid check request response');
      return res.json({ok:true,request:result.request,item:result.item,created:result.created===true});
    }catch(error){return sendError(res,error);}
  });
  staffRouter.get('/purchase-capture-checks/:requestId',...staff,async(req,res)=>{
    try{
      const result=await requests().getForStaff({actor:req.admin,requestId:identifier(req.params.requestId)});
      if(!result||!result.request||!result.item)throw new Error('invalid staff request response');
      return res.json({ok:true,request:result.request,item:result.item});
    }catch(error){return sendError(res,error);}
  });
  staffRouter.post('/purchase-capture-checks/:requestId/decision',...staff,async(req,res)=>{
    try{
      const fields=bodyFields(req.body,['decision','note','expectedEvidenceHash']);
      const result=await requests().decideForStaff({...fields,actor:req.admin,requestId:identifier(req.params.requestId)});
      if(!result||!result.request||!result.item)throw new Error('invalid staff decision response');
      return res.json({ok:true,request:result.request,item:result.item});
    }catch(error){return sendError(res,error);}
  });
  return {reviewerRouter,staffRouter};
}
module.exports={createPurchaseCaptureRouters};
