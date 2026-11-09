'use strict';
// Shared with the existing purchaseCaptureReplace/purchaseSubmissionSession key.
// Advisory-only: do not invert review→order row locks used by tab renaming.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function lockPurchaseCaptureOrdersInTx(client,orderIds){
 if(!Array.isArray(orderIds)||orderIds.some(id=>typeof id!=='string'||!UUID.test(id)))throw new TypeError('Server-discovered purchase order UUIDs are required');
 const ids=[...new Set(orderIds.map(id=>id.toLowerCase()))].sort();
 for(const id of ids)await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['purchase_capture:'+id]);
}
module.exports={lockPurchaseCaptureOrdersInTx};
