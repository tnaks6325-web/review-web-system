/**
 * 회귀가드: 업체관리 「같은 업체로 보이는 업체」 알림 배너 + 합치기 (시안 B · 사용자 확정 2026-10-01).
 *
 * 고정하는 것:
 *   1. 재료는 서버 점검(intranet-sync)의 분류 그대로 — duplicate·rename_blocked 를 짝으로(판정 사본 0)
 *   2. AE 에게는 배너를 그리지 않는다(API 가 adminOrMaster — 눌러도 403 인 막다른 길 금지)
 *   3. 점검 실패는 "문제없음"으로 꾸미지 않는다
 *   4. 합치기는 미리보기(confirm 없음) → 확인 체크 → confirm:true 순서
 *   5. onclick 에는 인덱스만(업체명 보간 금지) · 팝업은 body 직속 · Esc 리스너 1회
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

let failed = 0;
function ok(msg, cond) { if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } }

const start = html.indexOf('/* ══ 같은 업체로 보이는 업체 알림 배너');
const end = html.indexOf("document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&_ovmmPop)");
const block = html.slice(start, end);
ok('배너 블록이 있다', start > 0 && end > start);

function sandbox(role) {
  const sb = {
    STATE: { role, advs: [{ id: 'a1', name: '주식회사 올곧은무역', works: 6 }, { id: 'a2', name: '(주)올곧은무역', works: 1 }] },
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    document: { getElementById: () => null }, Date,
  };
  vm.createContext(sb);
  vm.runInContext(block.replace(/^let _OVMM=/m, 'var _OVMM=') + '\nthis._OVMM_=()=>_OVMM;', sb);
  return sb;
}

console.log('advertiserMergeBanner');
const items = [
  { kind: 'duplicate', id: 'a1', name: '주식회사 올곧은무역', intranetName: '(주)올곧은무역', mergeWith: { id: 'a2', name: '(주)올곧은무역' } },
  { kind: 'rename_blocked', id: 'b2', name: '옛표기', to: '새표기', blockedBy: { id: 'b1', name: '새표기' } },
  { kind: 'duplicate', id: 'a2', name: '(주)올곧은무역', mergeWith: { id: 'a1', name: '주식회사 올곧은무역' } },   // 같은 쌍 뒤집힘
  { kind: 'link', id: 'x', name: '자동처리' }, { kind: 'suggest', id: 'y', name: '사람확인' },
];
{
  const sb = sandbox('master');
  const pairs = sb._ovmmPairsFrom(items);
  ok('합칠 쌍은 duplicate·rename_blocked 만, 같은 쌍은 한 번만', pairs.length === 2);
  ok('duplicate: 원본 미연결 업체 → 원본 연결 업체', pairs[0].a.id === 'a1' && pairs[0].b.id === 'a2');
  ok('rename_blocked: 이름을 쥔 미연결 업체 → 원본 연결 업체', pairs[1].a.id === 'b1' && pairs[1].b.id === 'b2');

  const S = sb._OVMM_();
  S.state = 'fail'; S.error = '인트라넷 도달 불가';
  const fail = sb._ovmmBoxHtml();
  ok('점검 실패는 "없음"으로 꾸미지 않고 사유 + 다시 시도', /하지 못했습니다/.test(fail) && /중복이 없다는 뜻은 아닙니다/.test(fail) && /_ovmmLoad\(true\)/.test(fail) && !/없습니다<\/b>/.test(fail));
  S.state = 'ok'; S.pairs = [];
  ok('중복이 없으면 초록 한 줄', /ovm-mg-bn ok/.test(sb._ovmmBoxHtml()));
  S.pairs = sb._ovmmPairsFrom(items.slice(0, 1)); S.open = true;
  const open = sb._ovmmBoxHtml();
  ok('중복이 있으면 쌍 수를 말하고 카드와 [합치기]를 그린다', /1쌍 있습니다/.test(open) && /ovm-mg-pair/.test(open) && /_ovmmOpen\(0\)/.test(open));
  ok('기본으로 남길 쪽은 인트라넷에 연결된 업체', /ovm-mg-side keep[^>]*>\s*<div class="nm">\(주\)올곧은무역/.test(open));
  ok('onclick 에는 인덱스만(업체명 보간 없음)', !/onclick="[^"]*(올곧은|'[^']*무역)/.test(open));
  S.state = 'idle';
  ok('불러오기 전에는 아무것도 그리지 않는다', sb._ovmmBoxHtml() === '');
}
{
  const sb = sandbox('staff');
  const S = sb._OVMM_(); S.state = 'ok'; S.pairs = sb._ovmmPairsFrom(items);
  ok('AE 에게는 배너를 그리지 않는다(API 가 관리자 전용)', sb._ovmmBoxHtml() === '');
}
// 불러오기(_ovmmLoad) 실제 실행 — 기본으로 남길 쪽 = 원본 연결 업체, 실패는 fail 상태
(async () => {
  const sb = sandbox('master');
  sb.api = async () => ({ ok: true, items: items.slice(0, 1) });
  await sb._ovmmLoad(true);
  const S = sb._OVMM_();
  ok('불러오면 쌍을 담고 기본으로 남길 쪽은 인트라넷에 연결된 업체', S.state === 'ok' && S.pairs.length === 1 && S.keep['a1|a2'] === 'a2');
  const sb2 = sandbox('master');
  sb2.api = async () => { throw new Error('network'); };
  await sb2._ovmmLoad(true);
  ok('불러오기 오류는 fail 상태(문제없음 아님)', sb2._OVMM_().state === 'fail');
  const sb3 = sandbox('staff'); let called = false;
  sb3.api = async () => { called = true; return { ok: true, items } };
  await sb3._ovmmLoad(true);
  ok('AE 는 점검 API 를 부르지도 않는다', !called);
  await reviewFixes();
  finish();
})();

// 코드리뷰 지적 5종(2026-10-01) — 실제 실행으로 고정
async function reviewFixes() {
  const mkDoc = (hasBox) => {
    const els = {}; if (hasBox) els.ovmmBox = { innerHTML: '' };
    return { els, getElementById: id => els[id] || null,
      createElement: () => { const e = { style: {}, innerHTML: '' }; return e; },
      body: { appendChild(e) { els[e.id] = e; } } };
  };
  const sb = sandbox('master'); sb.document = mkDoc(true);
  // ② 다른 원본에 연결된 업체는 짝이 아니다
  ok('이름을 쥔 쪽이 인트라넷에 이미 연결돼 있으면 합칠 짝으로 보이지 않는다',
    sb._ovmmPairsFrom([{ kind: 'rename_blocked', id: 'x2', name: '옛', to: '새', blockedBy: { id: 'x1', name: '새', intranetLinked: true } }]).length === 0);
  // ① 늦게 온 미리보기 응답은 버린다
  const S = sb._OVMM_(); S.state = 'ok'; S.pairs = sb._ovmmPairsFrom([
    { kind: 'duplicate', id: 'a1', name: 'A옛', mergeWith: { id: 'a2', name: 'A' } },
    { kind: 'duplicate', id: 'b1', name: 'B옛', mergeWith: { id: 'b2', name: 'B' } }]);
  let release; const slow = new Promise(r => { release = r; });
  sb.api = async (u, o) => JSON.parse(o.body).sourceId === 'a1'
    ? slow : { ok: true, preview: { source: { name: 'B옛', campaigns: 1, link: 1, linkActive: 1 }, target: { name: 'B', campaigns: 2 } } };
  const first = sb._ovmmOpen(0);
  sb._ovmmClose();
  await sb._ovmmOpen(1);
  release({ ok: true, preview: { source: { name: 'A옛', campaigns: 9, link: 1, linkActive: 1 }, target: { name: 'A', campaigns: 9 } } });
  await first;
  ok('팝업을 닫고 다른 쌍을 연 뒤 늦게 온 앞 쌍 미리보기는 새 팝업에 섞이지 않는다',
    /B옛/.test(sb.document.els.ovmmPop.innerHTML) && !/A옛/.test(sb.document.els.ovmmPop.innerHTML));
  // ④ 폐기된 옛 링크는 "계속 열림"이라 말하지 않는다
  sb.api = async () => ({ ok: true, preview: { source: { name: 'B옛', campaigns: 1, link: 1, linkActive: 0 }, target: { name: 'B', campaigns: 2 } } });
  await sb._ovmmOpen(1);
  const txt = sb.document.els.ovmmPop.innerHTML;
  ok('옛 링크가 폐기돼 있으면 "열리지 않습니다"라고 말한다', /이미 폐기된 상태/.test(txt) && !/계속 열리고/.test(txt));
  // ③ 실행 중에는 닫히지 않는다
  let done; sb.api = () => new Promise(r => { done = r; });
  const P = sb.vm_pop = null;
  vm.runInContext('_ovmmPop.ok=true;', sb);
  const run = sb._ovmmRun();
  sb._ovmmClose();
  ok('합치기 실행 중에는 [취소]·Esc 로 팝업이 닫히지 않는다', vm.runInContext('!!_ovmmPop && _ovmmPop.busy', sb)
    && /취소<\/button>/.test(sb.document.els.ovmmPop.innerHTML) && /onclick="_ovmmClose\(\)" disabled/.test(sb.document.els.ovmmPop.innerHTML));
  // ⑤ 세션이 끝나 화면이 바뀌면 팝업을 걷는다
  delete sb.document.els.ovmmBox;
  done({ ok: false, error: '세션 만료' }); await run;
  ok('세션이 끝나 업체관리 화면이 사라지면 팝업도 걷힌다', vm.runInContext('_ovmmPop===null', sb) && sb.document.els.ovmmPop.style.display === 'none');
}
// 배선
ok('점검은 intranet-sync, 실행은 merge API', /api\('\/api\/trackb\/advertisers\/intranet-sync'\)/.test(block)
  && /body:JSON\.stringify\(\{sourceId:src\.id,targetId:dst\.id\}\)/.test(block)
  && /body:JSON\.stringify\(\{sourceId:P\.src\.id,targetId:P\.dst\.id,confirm:true\}\)/.test(block));
ok('확인 체크 전에는 [합치기]가 잠긴다', /P\.prev&&P\.ok&&!P\.busy\?'':'disabled'/.test(block) && /if\(!P\|\|!P\.ok\|\|P\.busy\) return;/.test(block));
ok('팝업은 body 직속이고 바깥 클릭으로 닫지 않는다', /document\.body\.appendChild\(ov\)/.test(block) && !/ovmmPop[^;]*onclick/.test(block));
ok('Esc 리스너는 최상위 1회', (html.match(/e\.key==='Escape'&&_ovmmPop/g) || []).length === 1);
ok('업체관리 개요가 배너 자리를 그리고 불러온다', /<div id="ovmmBox">\$\{_ovmmBoxHtml\(\)\}<\/div>/.test(html) && /  _ovmmLoad\(\);\n\}/.test(html));
ok('관리자 판정은 서버 게이트와 같다(master·admin)', /function _ovmmAllowed\(\)\{ return STATE\.role==='master'\|\|STATE\.role==='admin'; \}/.test(block));

function finish() {
  console.log(failed ? `advertiserMergeBanner: FAILED (${failed})` : 'advertiserMergeBanner: passed');
  process.exit(failed ? 1 : 0);
}
