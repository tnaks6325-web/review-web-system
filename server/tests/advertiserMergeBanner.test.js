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
  finish();
})();
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
