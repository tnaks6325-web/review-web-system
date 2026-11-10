'use strict';
// Detached real work-detail renderer with fictional data; no API, login or writes.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const renderer=path.resolve(__dirname,'../../../frontend/js/campaign-workdetail.js');
const image='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="260"><rect width="600" height="260" fill="#eef4ff"/><text x="40" y="110" font-size="30" fill="#234">TEST GUIDE</text><text x="40" y="165" font-size="22" fill="#234">1. Search  2. Choose  3. Buy</text></svg>';
function fixture(base,kind){return {workDetail:{productLines:'시험 상품 1개, 80ml\n결제금액 15,900원',specialNotes:'구매 전 안내를 확인해 주세요.',reviewGuide:'[리뷰등록 가이드]\n사용 후 리뷰를 작성해 주세요.',inflowGuideHtml:kind==='link'?'링크유입': '<p>검색 안내를 따라 시험 상품을 선택해 주세요.</p><img src="/guide.svg" alt="시험용 유입 안내">'},inflowType:kind==='link'?'link':'guide',landingUrl:base+'/product',...(kind==='unit'?{selectedOption:{optKey:'선택 상품',unitKind:'product',inflowType:'guide',inflowGuideHtml:'<p>선택 상품 전용 안내를 따라 구매해 주세요.</p><img src="/guide.svg" alt="시험용 선택 상품 안내">'}}:{})};}
async function start({port=0,baselineSource}={}){
 const server=http.createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405);return res.end('Read-only preview');}
  const u=new URL(req.url,'http://127.0.0.1');
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; frame-src 'self'; form-action 'none'; worker-src 'none'");
  if(u.pathname==='/guide.svg'){res.setHeader('Content-Type','image/svg+xml');return res.end(image);}
  if(u.pathname==='/renderer.js'){res.setHeader('Content-Type','application/javascript');if(u.searchParams.get('version')==='before'){if(!baselineSource){res.statusCode=404;return res.end('Baseline unavailable');}return res.end(baselineSource);}return res.end(fs.readFileSync(renderer));}
  if(u.pathname==='/bootstrap.js'){
   const kind=u.searchParams.get('case')||'guide',base='http://127.0.0.1:'+server.address().port;
   res.setHeader('Content-Type','application/javascript');return res.end('window.previewData='+JSON.stringify(fixture(base,kind))+';window.previewOptions='+JSON.stringify({showOption:false,layout:kind==='admin'?undefined:'v18',showInflow:kind!=='qna',showProduct:kind!=='qna'})+';CampWorkDetail.renderInto(document.getElementById("work"),previewData,previewOptions);');
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(u.pathname==='/')return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>유입 안내 기본 펼침 비교</title><style>body{font:15px system-ui;margin:24px;color:#222}p{color:#666}.row{display:flex;gap:20px;overflow:auto}.col{flex:1;min-width:330px}iframe{width:100%;height:850px;border:1px solid #ddd}a{color:#007aff}</style><h1>유입 안내 기본 펼침</h1><p>실제 작업내용 렌더러 + 가상 안내입니다. 공고 로그인·구매양식·운영 자료는 사용하지 않습니다.</p><div class="row"><section class="col"><h2>수정 전</h2><iframe src="/before" title="수정 전"></iframe></section><section class="col"><h2>수정 후</h2><iframe src="/after" title="수정 후"></iframe></section></div>');
  if(!['/before','/after'].includes(u.pathname)){res.statusCode=404;return res.end('Not found');}
  const version=u.pathname==='/before'?'before':'after',kind=u.searchParams.get('case')||'guide';
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>가상 공고 작업내용</title><style>body{margin:0 auto;padding:16px;max-width:440px;font-family:system-ui;background:white;color:#222;box-sizing:border-box}*{box-sizing:border-box}#work{min-width:0}small{display:block;color:#666;margin-bottom:12px}</style><small>가상 공고 · 작업 내용 영역</small><div id="work"></div><script src="/renderer.js?version='+version+'"></script><script src="/bootstrap.js?case='+encodeURIComponent(kind)+'"></script>');
 });
 await new Promise(r=>server.listen(port,'127.0.0.1',r));return {base:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};
}
module.exports={start,fixture};
if(require.main===module){const file=process.env.CAMPAIGN_GUIDE_BASELINE;if(!file)throw new Error('CAMPAIGN_GUIDE_BASELINE must point to the preserved original renderer');start({port:Number(process.env.CAMPAIGN_GUIDE_PREVIEW_PORT||8859),baselineSource:fs.readFileSync(file,'utf8')}).then(h=>console.log('LOCAL_RENDERER_PREVIEW='+h.base));}
