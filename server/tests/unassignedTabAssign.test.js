/**
 * 업체 미지정 작업 → 기존 업체 지정 회귀가드 (2026-08-19 「8/19)유일기획_쿠팡_암막커튼 20건」 건).
 *
 *   사고: 미지정 그룹의 작업을 **이미 등록된 업체**에 소속시킬 창구가 없었다 — 업체관리의 미지정
 *   목록은 **시트 단위**였고 행동은 [거래처 등록] 하나뿐이라, 이름이 겹치면 '이미 존재하는
 *   거래처명입니다'로 막혀 막다른 길이었다.
 *
 *   1. 목록 — 판정은 작업바 '미지정' 그룹과 같은 `advertiserId` 없음(탭 단위) · 재료는 mapTabs 하나.
 *   2. 팝업 — 이관과 **한 벌**(사본 금지) · 지정은 POST /api/trackb/ownership(신규 엔드포인트 0).
 *   3. 실행 — 지정이 transfer 로 새지 않는다 · 부분 실패 고지 · 지정 후 목록 재조회.
 * 실행: node tests/unassignedTabAssign.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ` — ${extra}` : '')); console.log('  ✓ ' + name); pass++; };
function grab(name, src = HTML) {
  let i = src.indexOf(`function ${name}(`);
  assert.ok(i > 0, `블록 추출: function ${name} 존재`);
  if (src.slice(i - 6, i) === 'async ') i -= 6;
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error(`${name} 블록 추출 실패`);
}

/* ═══ 1. 미지정 목록 — 탭 단위 판정(vm 실행) ═══ */
console.log('\n1) _ovmUnmatchedHtml 실행(가짜 STATE)');
function renderUnm(STATE) {
  const sb = { console, JSON, Object, Array, String, Number, Set, Map, STATE,
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    sheetTitle: (sid) => (STATE.sheetMap[sid] || {}).title || sid };
  sb.window = sb; vm.createContext(sb);
  vm.runInContext(grab('_ovmLiveTabs') + '\n' + grab('_ovmUnassignedTabs') + '\n' + grab('_ovmTabGid') + '\n' + grab('_isNoSheet') + '\n' + grab('_ovmUnmatchedHtml') + '\nvar _ovmUnmList=[];', sb);
  return { html: sb._ovmUnmatchedHtml(), sb };
}
const SHEETMAP = { S1: { title: '(신규)유일기획 업무시트', tabs: [{ tabGid: '10', tabName: '유일기획_로켓_2차' }] },
                   S2: { title: '8/19)유일기획_쿠팡_암막커튼 20건', tabs: [{ tabGid: '0', tabName: '8/19)유일기획_쿠팡_암막커튼 20건' }] } };
const BASE = {
  sheetMap: SHEETMAP, ownedSheetIds: new Set(['S1']),
  mapTabs: [
    { sheetId: 'S1', tabGid: '10', tabName: '유일기획_로켓_2차', advertiserId: 'adv_y', advertiserName: '주식회사 유일기획' },
    { sheetId: 'S1', tabGid: '11', tabName: '유일기획_2026(로켓)' },              // ★ 시트는 owned 인데 이 탭만 미지정
    { sheetId: 'S2', tabGid: '0', tabName: '8/19)유일기획_쿠팡_암막커튼 20건' },   // 무시트 작업(가상 시트)
    { sheetId: 'S2', tabGid: '', tabName: 'gid 없는 탭' },
  ],
};
let out = renderUnm(JSON.parse(JSON.stringify(BASE, (k, v) => v)) && Object.assign({}, BASE));
t('미지정 작업만 나온다(지정된 탭 제외)', !/유일기획_로켓_2차/.test(out.html), out.html.slice(0, 200));
t('★ 시트는 owned 인데 탭만 미지정인 건도 나온다(시트 단위 판정이면 통째로 누락)',
  /유일기획_2026\(로켓\)/.test(out.html));
t('신고된 무시트 작업이 나온다', /8\/19\)유일기획_쿠팡_암막커튼 20건/.test(out.html));
t('★ onclick 은 인덱스만(탭명·시트명 문자열 보간 금지)',
  /onclick="ownAssign\(\d+\)"/.test(out.html) && !/onclick="ownAssign\('/.test(out.html));
t('★ gid 없는 작업은 지정 불가를 사유와 함께 비활성', /disabled title="이 작업은 식별자\(gid\)가 없어/.test(out.html));
// ★★ 사용자 확정(2026-08-23): 업체 지정 단위는 **작업(작업보드)** 하나 — 시트 전체 지정 창구는 폐지.
//    되살리면 "시트에 새 작업이 생기면 자동으로 그 업체 소유"가 되어 미지정 목록이 다시 시트 단위로 접힌다.
t('★★ [시트 전체 지정] 창구가 없다(폐지)', !/ownAssignSheet/.test(out.html) && !/시트 전체 지정/.test(out.html));
t('★ 시트 단위 [거래처 등록] 버튼도 없다(등록은 지정 팝업의 ＋새 거래처)',
  !/_ovmAddForSheetIdx/.test(out.html));
t('작업마다 [업체 지정]이 하나씩', (out.html.match(/ownAssign\(\d+\)/g) || []).length === 2);

out = renderUnm(Object.assign({}, BASE, { mapTabs: BASE.mapTabs.map(x => Object.assign({}, x, { advertiserId: 'adv_y' })) }));
t('전부 지정되면 "모든 작업이 지정됐습니다"', /모든 작업이 업체에 지정됐습니다/.test(out.html));
out = renderUnm(Object.assign({}, BASE, { mapTabs: [] }));
t('★★ 목록을 못 받으면 0 건으로 위장하지 않고 사유를 말한다', /불러오지 못했습니다/.test(out.html));

/* ═══ 2. 배선 — 사본 금지 · 신규 엔드포인트 0 ═══ */
console.log('\n2) 배선');
t('지정 팝업은 이관과 같은 한 벌(_trOpen)', /function _trOpen\(o\)\{/.test(HTML)
  && /_trOpen\(\{kind:'assign'/.test(HTML) && /_trOpen\(\{kind:'transfer'/.test(HTML));
t('★ 지정은 기존 POST /api/trackb/ownership 사용(신규 엔드포인트 0)',
  /api\('\/api\/trackb\/ownership',\{method:'POST',body:JSON\.stringify\(\{advertiserId:targetId, sheetId:S\.own\.sheetId, tabGid:p\.tabGid\}\)\}\)/.test(HTML));
t('서버 라우트 그대로(POST /ownership internal 게이트)',
  /router\.post\('\/ownership', authMiddleware, internalMiddleware/.test(ROUTES));
t('사이드바·개요가 "미지정 작업" 단위로 말한다',
  /업체 미지정 작업<span class="n">\$\{unTabs\}/.test(HTML) && /미지정 작업 보기 · 업체 지정/.test(HTML));
// ★★ 사용자 확정(2026-08-23): 시트 기준 폴백 표기 자체를 없앴다 — 재료를 못 받으면 사유를 말한다.
t('★★ 사이드바에 시트 기준 표기가 없다', !/업체 미지정 시트/.test(HTML) && !/모든 시트가 지정됨/.test(HTML));
t('드로어 제목도 작업 단위', /unm:'업체 미지정 작업'/.test(HTML));
const foot = HTML.match(/function _ovmRenderFoot\(\)\{[\s\S]*?\n\}/)[0];
// ★★ 사용자 확정(2026-08-23): 시트 기준 폴백은 폐지 — 못 받으면 "불러오지 못함 ?" 으로 사유를 말한다.
t('★ 재료(mapTabs)를 못 받으면 0 으로 위장하지 않고 사유를 말한다',
  /tabsKnown/.test(foot) && /불러오지 못함/.test(foot) && !/시트/.test(foot));

async function run(){
  /* ═══ 3. ownTransferGo — assign 실행 ═══ */
  console.log('\n3) ownTransferGo(assign) 실행');
  async function runGo(over) {
    const posts = [], toasts = []; let reloaded = 0;
    const sb = {
      console, JSON, Object, Array, String, Number, setTimeout, clearTimeout,
      confirm: (m) => { toasts.push('CONFIRM:' + m); return over.deny ? false : true; },
      toast: (m) => toasts.push(String(m)),
      api: async (url, opt) => {
        const body = opt && opt.body ? JSON.parse(opt.body) : null;
        if (/\/ownership$/.test(url) && opt && opt.method === 'POST') { posts.push({ url, body }); return (over.results || (() => ({ ok: true })))(body); }
        if (/\/ownership\/transfer/.test(url)) { posts.push({ url, body }); return { ok: true }; }
        if (/\/advertisers$/.test(url) && opt && opt.method === 'POST') return { ok: true, data: { id: 'adv_new' } };
        return { ok: true };
      },
      document: { getElementById: () => null },
      STATE: { advs: [{ id: 'adv_y', name: '주식회사 유일기획' }], advCur: null },
      refreshAdvCounts: async () => {}, selAdv: () => {}, _ovmRenderOverview: () => {}, _ovmOpenDrawer: () => {},
      _ovmDrawer: 'unm', buildTabIndex: () => {},
      _trS: Object.assign({ kind: 'assign', own: { sheetId: 'S2', tabGid: '0' }, from: null, srcLabel: '암막커튼',
        tabs: [{ tabGid: '0', tabName: 'A' }, { tabGid: '1', tabName: 'B' }], gidless: 0,
        mode: 'tab', picks: {}, target: 'adv_y', newName: '', newOk: false, newPm: '' }, over.S || {}),
      _trItems: [], _trClose() { this._trS = null; },
    };
    sb._ovmReloadMapTabs = async () => { reloaded++; };
    sb.window = sb; vm.createContext(sb);
    vm.runInContext(grab('ownTransferGo') + '\n_trClose=function(){_trS=null};', sb);
    await sb.ownTransferGo();
    return { posts, toasts, reloaded };
  }
  let go = await runGo({});
  t('★ 지정은 /ownership 으로 나간다(transfer 로 새지 않는다)',
    go.posts.length === 1 && /\/ownership$/.test(go.posts[0].url), JSON.stringify(go.posts));
  t('업체·시트·탭을 그대로 전송', go.posts[0].body.advertiserId === 'adv_y'
    && go.posts[0].body.sheetId === 'S2' && go.posts[0].body.tabGid === '0');
  t('확인창이 "지정"이라고 말한다(이관과 혼동 금지)',
    /CONFIRM:[\s\S]*소유로 지정할까요/.test(go.toasts.join('|')) && !/이관할까요/.test(go.toasts.join('|')));
  t('성공 토스트에 대상 업체명', /지정 완료 → 주식회사 유일기획/.test(go.toasts.join('|')), go.toasts.join('|'));
  t('★ 지정 후 미지정 목록을 다시 받는다(방금 지정한 작업이 남지 않게)', go.reloaded === 1);

  go = await runGo({ deny: true });
  t('확인창에서 취소하면 전송 0', go.posts.length === 0);
  go = await runGo({ S: { target: '' } });
  t('대상 미선택이면 전송 0 + 안내', go.posts.length === 0 && /지정할 거래처를 선택/.test(go.toasts.join('|')));
  go = await runGo({ S: { own: { sheetId: 'S1', tabGid: null }, mode: 'tab', picks: {} } });
  t('작업 미선택이면 전송 0 + 안내', go.posts.length === 0 && /지정할 작업을 선택/.test(go.toasts.join('|')));
  // ★★ 사용자 확정(2026-08-23): tabGid:null(시트 전체) 로는 더 이상 지정·이관하지 않는다 —
  //    되살리면 그 시트의 새 작업까지 자동으로 그 업체 소유가 되어 작업 단위 지정이 무의미해진다.
  go = await runGo({ S: { own: { sheetId: 'S1', tabGid: null }, mode: 'all', picks: {} } });
  t('★★ 시트 전체(tabGid null) 전송 0 — 작업을 골라야 한다',
    go.posts.length === 0 && /선택/.test(go.toasts.join('|')));
  let n = 0;
  go = await runGo({ S: { own: { sheetId: 'S1', tabGid: null }, mode: 'tab', picks: { 0: true, 1: true } },
    results: () => (++n === 1 ? { ok: true } : { ok: false, error: '담당(inad_pm)이 아닌 업체' }) });
  t('★★ 부분 실패를 "완료"로 꾸미지 않는다', /일부만 지정됨 \(1\/2\)/.test(go.toasts.join('|'))
    && /담당\(inad_pm\)/.test(go.toasts.join('|')) && !/지정 완료/.test(go.toasts.join('|')), go.toasts.join('|'));
  go = await runGo({ results: () => ({ ok: false, error: '이미 다른 업체/담당이 소유한 시트입니다.' }) });
  t('★ 전부 실패는 실패로 말한다(서버 사유 그대로)',
    /지정 실패: 이미 다른 업체/.test(go.toasts.join('|')), go.toasts.join('|'));
  console.log(`\n✅ unassignedTabAssign: ${pass}개 통과`);
}
run().catch(e=>{ console.error('❌', e.message); process.exit(1); });
