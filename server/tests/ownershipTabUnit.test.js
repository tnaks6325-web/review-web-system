/**
 * 업체 지정 = **작업(작업보드) 단위** 회귀가드 (사용자 확정 2026-08-23).
 *
 *   배경: 업체관리의 지정 축이 "구글시트 파일(sheet_id)"이었다 — [시트 전체 지정]으로 한 번 지정하면
 *   그 시트의 **모든 탭 + 앞으로 생길 탭까지** 자동으로 그 업체 소유가 됐다. 이제 지정·등록·이관이
 *   전부 작업 하나 단위이고, 남아 있는 시트 전체 소유는 [작업 단위로 펼치기]로 정리한다.
 *
 *   ★★ 무시트화(전환)로는 이 축이 안 없어진다 — sheetlessCutover 는 tab_configs.sheetless 플래그만
 *      켜고 sheet_id 를 그대로 두므로, tab_gid IS NULL 소유 행은 계속 그 시트의 모든 탭을 덮는다.
 *
 *   1. 창구 — 신규 지정·등록에 시트 전체 선택지가 없다(폐지).
 *   2. 펼치기 서비스 — 미리보기 쓰기 0 · fail-closed 3종 · 탭지정 우선 보존 · 시트당 한 트랜잭션.
 *   3. 라우트·화면 배선.
 * 실행: node tests/ownershipTabUnit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const svc = require('../src/services/trackB.service');
const participants = require('../src/services/participants.service');

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
function pool(routes) {
  const q = [];
  const api = { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [], rowCount: 0 };
  } };
  api.connect = async () => ({ query: api.query, release() {} });
  return api;
}
const writes = db => db.q.filter(x => /^(INSERT|UPDATE|DELETE)/i.test(x.s));

async function run() {
  /* ═══ 1. 창구 — 업체관리에 구글시트 흔적 0 ═══
     ★★ 사용자 확정(2026-08-23): 업체별 작업의 진실원천은 **인트라넷 리뷰오더 → 리뷰웹 작업오더 →
        작업보드** 하나다. 업체관리는 구글시트를 ① 찾아오지 않고(가져오기) ② 참조하지 않으며
        (시트 제목·시트 링크) ③ 시트 목록을 보여주지 않는다. */
  console.log('\n1) 업체관리 화면 — 구글시트 흔적 0');
  // 업체관리 뷰 = renderOwnershipView ~ 시트 가져오기 자리(제거됨) 사이 전 구간
  // ★ 주석은 지우고 본다 — "제거됨"이라 적어 둔 설명문이 검사에 걸리면(또는 통과시키면) 무의미해진다.
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const OWN = strip(HTML.slice(HTML.indexOf('function _ovmbSummaryHtml('), HTML.indexOf('async function refreshAdvCounts(')));
  t('★★ 시트 가져오기 창구가 없다', !/openSheetImport\(/.test(OWN) && !/>＋ 시트에서 가져오기</.test(OWN));
  // ★ 예외는 헬퍼 **정의** 한 줄뿐(작업보드 쪽이 계속 쓴다) — 업체관리에서 **부르는** 자리가 0 이어야 한다.
  const sheetTitleCalls = (OWN.match(/.*sheetTitle\(.*/g) || []).filter(l => !/function sheetTitle\(sid\)/.test(l));
  t('★★ 시트 제목을 그리지 않는다(업체관리에서 sheetTitle 호출 0)', sheetTitleCalls.length === 0,
    sheetTitleCalls.slice(0, 3).join(' | '));
  const CODE = strip(HTML);
  t('★★ 시트 전체 지정·펼치기 창구가 없다',
    !/ownAssignSheet/.test(CODE) && !/ownExpand/.test(CODE) && !/시트 전체 지정/.test(CODE));
  t('★ 미지정 판정 재료는 mapTabs 하나(/owned-sheets 미조회)',
    !/owned-sheets/.test(CODE) && !/ownedSheetIds/.test(CODE));
  const addOwn = grab('_ovmAddOwnHtml'), addAdv = grab('_ovmAddAdvHtml');
  t('★ 소유 추가·거래처 등록 후보는 작업 목록(optgroup 시트 묶음 없음)',
    !/optgroup/.test(addOwn) && !/optgroup/.test(addAdv)
    && /_ovmUnassignedTabs\(\)/.test(addOwn) && /_ovmUnassignedTabs\(\)/.test(addAdv));
  const trRender = grab('_trRender');
  t('★★ 지정·이관 팝업에 범위 라디오가 없다(작업만 고른다)',
    !/_trMode\(/.test(trRender) && !/시트 전체\(모든 탭\)/.test(trRender));
  // ★ 줄 주석을 지우고 본다 — 주석의 설명 문구가 대신 걸리면(또는 통과시키면) 검사가 무의미해진다.
  const go = grab('ownTransferGo').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  t('★★ tabGid:null(시트 전체) 로 보내는 분기가 없다', !/tabGid:\s*null/.test(go), go);
  t('★ onclick 은 인덱스만(시트발 문자열 보간 금지)', /onclick="ownAssign\(\$\{i\}\)"/.test(HTML));
  /* ★★ 마감(🏁)된 작업은 지정 후보·집계에서 뺀다 — 업체관리가 다루는 것은 진행 중인 작업이다.
     ★ `finished` 를 못 받으면(구버전 백엔드) 종전대로 포함(모르는 것을 숨기지 않는다). */
  {
    const sb = { STATE: { mapTabs: [
      { sheetId: 'S1', tabGid: '1', tabName: 'A' },                        // 미지정·진행 중
      { sheetId: 'S1', tabGid: '2', tabName: 'B', finished: true },        // 미지정이지만 마감
      { sheetId: 'S1', tabGid: '3', tabName: 'C', advertiserId: 'adv_a' }, // 지정됨
    ] } };
    vm.createContext(sb);
    vm.runInContext(grab('_ovmLiveTabs') + '\n' + grab('_ovmUnassignedTabs') + '\n' + grab('_ovmTabCounts'), sb);
    t('★★ 마감된 작업은 미지정 후보에 안 뜬다', sb._ovmUnassignedTabs().map(x => x.tabName).join(',') === 'A');
    const c = sb._ovmTabCounts();
    t('★ 분모도 같은 집합(진행 중 2건 · 미지정 1건)', c.total === 2 && c.un === 1, JSON.stringify(c));
  }
  t('★ 사이드바·표도 작업 단위로 말한다',
    /업체 미지정 작업/.test(OWN) && /소유 작업 /.test(OWN) && !/소유 시트/.test(OWN));

  /* ═══ 2. 펼치기 서비스 — 제거 (결정 186 29번 — 2026-09-28 expandSheetOwnerships·staffOwnsAdvertiser 제거, 옛 시트 전체 소유 0건) ═══ */

  /* ═══ 3. 라우트·화면 배선 ═══ */
  console.log('\n3) 라우트·배선');
  const router = require('../src/routes/trackB.routes');
  t('★ 펼치기 입구가 되살아나지 않았다 (결정 186 29번 — 2026-09-28 expandSheetOwnerships·staffOwnsAdvertiser 제거, 옛 시트 전체 소유 0건)',
    !router.stack.some(l => l.route && l.route.path === '/ownership/expand'));
  /* ★★ 반면 **업체 지정·해제는 담당 무관**이다(사용자 확정 2026-08-24) — 이관이 이미 담당 무관이라
     "옮기는 건 되는데 처음 지정은 막히는" 비대칭이었고, 화면이 전 업체를 보여줘 막다른 길이었다. */
  {
    const cut = (decl) => ROUTES.slice(ROUTES.indexOf(decl), ROUTES.indexOf('\nrouter.', ROUTES.indexOf(decl) + 10));
    t('★★ 지정에 담당·시트 게이트가 없다',
      !/_ownershipExpandAllowed|staffOwnsAdvertiser|sheetAssignableByStaff/.test(cut("router.post('/ownership',")));
    t('★★ 해제도 같은 범위(되돌릴 수 있어야 한다)',
      !/_ownershipExpandAllowed|staffOwnsAdvertiser/.test(cut("router.delete('/ownership',")));
  }

  // ★ 펼치기 화면은 제거됐다(시트 UI 전면 제거) — 서버는 남겨 레거시 소유를 화면 없이도 정리한다.
  t('★★ 펼치기 팝업·버튼이 화면에 없다', !/_expOpen|_expGo|ownExpandAll|ownExpandOne/.test(strip(HTML)));
  const owns = HTML.slice(HTML.indexOf('function _ovmOwnsHtml('), HTML.indexOf('function _ovmAddOwnHtml('));
  t('★ 레거시 전체 소유 줄은 [×] 해제만(이관 버튼 없음)', /isAdmin&&!whole\?`<button class="trb"/.test(owns.replace(/\s+/g, ' '))
    && /전체\(레거시\)/.test(owns));

  console.log(`\n✅ ownershipTabUnit: ${pass}개 통과`);
  process.exit(0);
}
run().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
