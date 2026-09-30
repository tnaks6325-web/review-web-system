(function(root){
  'use strict';
  function createCoordinator(){
    let key='',epoch=0,generation=0,running=null;
    return {
      reset(){key='';epoch++;generation++;running=null;},
      load(nextKey,fetcher,{force=false}={}){
        if(key!==nextKey){key=nextKey;epoch++;generation++;running=null;}
        if(force) epoch++;
        if(running) return running;
        const requestKey=key,requestGeneration=generation;
        const work=(async()=>{
          for(;;){
            const started=epoch;
            try {
              const value=await fetcher();
              if(key!==requestKey||generation!==requestGeneration) return {stale:true};
              if(started!==epoch) continue;
              return {value,stale:false};
            }catch(error){
              if(key!==requestKey||generation!==requestGeneration) return {stale:true};
              if(started!==epoch) continue;
              throw error;
            }
          }
        })();
        running=work;
        work.finally(()=>{if(running===work) running=null;}).catch(()=>{});
        return work;
      }
    };
  }
  async function fetchPage(base,token,status,cursor){
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),15000);
    try {
      const response=await fetch(base+'/api/reviewer/participations?status='+encodeURIComponent(status)+'&limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{
        headers:{'X-Reviewer-Token':token},signal:ctrl.signal});
      if(response.status===404) return {ok:true,mode:'legacy'};
      const data=await response.json();
      if(!response.ok||!data.ok){const e=new Error(data.error||'리뷰 내역을 불러오지 못했습니다.');e.code=data.code;throw e;}
      return data;
    }finally{clearTimeout(timer);}
  }
  root.ReviewerHistoryLoader={createCoordinator,fetchPage};
  if(typeof module!=='undefined') module.exports=root.ReviewerHistoryLoader;
})(typeof window==='undefined'?globalThis:window);
