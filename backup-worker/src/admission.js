import {fail} from './storage.js';
// Kept out of index.js: workerd only accepts handler exports from the main module.
// Isolate-local admission budget only; no cross-isolate concurrency claim (결정 368 보강 2026-11-13).
// Every request reserves BASE_RESERVE; a body route then grows by 2×declared size (whole body + R2
// read-back are buffered; readBounded allocates exactly descriptor.size, validated ≤ MAX_BYTES).
// Overlap is allowed up to MAX_ACTIVE requests and BUDGET bytes, so a 25MiB body runs alone while
// typical sub-MB photos run several at a time. Anything over budget is BUSY (retryable), never queued.
export const MAX_ACTIVE=4,BUDGET=56*1024*1024,BASE_RESERVE=2*1024*1024;
let reserved=0,activeCount=0;
export function admit(n){
 if(activeCount>=MAX_ACTIVE||reserved+n>BUDGET)fail('BUSY');
 reserved+=n;activeCount++;let amount=n,done=false;
 return {grow(extra){if(done)return;if(reserved+extra>BUDGET)fail('BUSY');reserved+=extra;amount+=extra;},
  release(){if(!done){done=true;reserved-=amount;activeCount--;}}};
}
