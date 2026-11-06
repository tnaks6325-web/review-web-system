'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const identity = require('./reviewerOrderIdentity.service');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])]));
  return value;
}
const hash = value => sha(JSON.stringify(canonical(value)));
function fail(code = 'DUAL_PROOF_INVALID', message = '구매 증빙 결속이 일치하지 않습니다.', status = 409) { const e = new Error(message); e.code = code; e.status = status; throw e; }
function bytes(imageBase64) {
  const clean = String(imageBase64 || '').replace(/^data:image\/[\w.+-]+;base64,/, '').replace(/\s/g,'');
  if (!clean || clean.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) fail('DUAL_IMAGE_INVALID');
  const b = Buffer.from(clean,'base64');
  if (!b.length || b.toString('base64').replace(/=+$/,'') !== clean.replace(/=+$/,'')) fail('DUAL_IMAGE_INVALID');
  return b;
}
function scope({context,channel,role,revision}) {
  if (!['naver','coupang'].includes(channel) || !['primary','supplement'].includes(role) || !Number.isInteger(revision) || revision < 1) fail();
  return {owner:context.owner.id,app:context.application.id,campaign:context.application.campaign_id,
    card:context.selected.cardId || null,identityKey:context.selected.identityKey,channel,role,revision};
}
function sign(purpose, payload) {
  return jwt.sign({purpose,...payload},process.env.JWT_SECRET,{issuer:'review-web-system',audience:'dual-purchase',expiresIn:'20m',algorithm:'HS256'});
}
function verify(token,purpose) {
  let p; try { p=jwt.verify(String(token||''),process.env.JWT_SECRET,{issuer:'review-web-system',audience:'dual-purchase',algorithms:['HS256']}); } catch (_) { fail(); }
  if(p.purpose!==purpose) fail(); return p;
}
function issueChannelExtraction(args) {
  const byteSha256=sha(bytes(args.imageBase64));
  const old=identity.issueExtractionProof({imageHash:identity.hashImageBase64(args.imageBase64),extracted:args.extracted,ok:args.ok});
  return {...old,extractionToken:sign('extract',{scope:scope(args),byteSha256,extracted:args.extracted,ok:args.ok===true,extractToken:old.extractToken}),byteSha256};
}
function verifyChannelExtraction(args) {
  const p=verify(args.extractionToken,'extract');
  if(hash(p.scope)!==hash(scope(args)) || p.byteSha256!==sha(bytes(args.imageBase64)) || hash(p.extracted)!==hash(args.extracted)) fail();
  identity.verifyExtractionProof(p.extractToken,args.extracted); return p;
}
module.exports={sha,hash,bytes,fail,scope,sign,verify,issueChannelExtraction,verifyChannelExtraction,
 issueBundleApproval:args=>require('./dualPurchaseSubmission.service').issueBundleApproval(args),
 verifyBundleApprovalForSubmission:args=>require('./dualPurchaseSubmission.service').prepareBundle(args)};
