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
  /* ═══ 1. 창구 — 시트 전체 선택지 폐지 ═══ */
  console.log('\n1) 창구(화면) — 시트 전체 선택지 없음');
  t('★★ 미지정 목록에 [시트 전체 지정]이 없다', !/ownAssignSheet/.test(HTML) && !/>시트 전체 지정</.test(HTML));
  const addOwn = grab('_ovmAddOwnHtml');
  t('★★ 소유 추가 폼에 "시트 전체(모든 탭)" 라디오가 없다',
    !/시트 전체\(모든 탭\)/.test(addOwn) && !/setAddMode/.test(HTML));
  t('소유 추가는 미지정 작업에서 고른다', /_ovmUnassignedTabs\(\)/.test(addOwn) && /addTabSel/.test(addOwn));
  const addAdv = grab('_ovmAddAdvHtml');
  t('★ 거래처 등록도 작업 선택(시트 드롭다운 폐지)',
    /advTabSel/.test(addAdv) && !/id="advSheet"/.test(HTML));
  const trRender = grab('_trRender');
  t('★★ 지정·이관 팝업에 범위 라디오가 없다(작업만 고른다)',
    !/_trMode\(/.test(trRender) && !/시트 전체\(모든 탭\)/.test(trRender));
  // ★ 줄 주석을 지우고 본다 — 주석의 설명 문구가 대신 걸리면(또는 통과시키면) 검사가 무의미해진다.
  const go = grab('ownTransferGo').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  t('★★ tabGid:null(시트 전체) 로 보내는 분기가 없다', !/tabGid:\s*null/.test(go), go);
  t('★ onclick 은 인덱스만(시트발 문자열 보간 금지)',
    /onclick="ownAssign\(\$\{i\}\)"/.test(HTML) && /onclick="ownExpandOne\(\$\{i\}\)"/.test(HTML));

  /* ═══ 2. 펼치기 서비스 ═══ */
  console.log('\n2) expandSheetOwnerships(서비스 실행)');
  const OWNS = [/FROM advertiser_campaigns ac JOIN advertisers a ON a\.id = ac\.advertiser_id WHERE ac\.deleted_at IS NULL AND ac\.tab_gid IS NULL/,
    () => ({ rows: [{ advertiserId: 'adv_a', advertiserName: '가업체', sheetId: 'S1' }] })];
  const realList = participants.listActiveTabs;
  const stubTabs = (rows) => { participants.listActiveTabs = async () => rows; };
  const TABS_OK = [
    { sheetId: 'S1', tabGid: '10', tabName: '작업A', spreadsheetTitle: '가업체 시트' },
    { sheetId: 'S1', tabGid: '20', tabName: '작업B', spreadsheetTitle: '가업체 시트' },
    { sheetId: 'S9', tabGid: '30', tabName: '남의 작업', spreadsheetTitle: '다른 시트' },
  ];

  // 미리보기 = 쓰기 0
  stubTabs(TABS_OK);
  let db = pool([OWNS]);
  svc.__setPoolForTest(db);
  let r = await svc.expandSheetOwnerships({});
  t('★★ 미리보기는 쓰기 0건', writes(db).length === 0, JSON.stringify(writes(db).map(x => x.s)));
  t('미리보기가 펼칠 작업을 말한다', r.ok && r.dryRun === true && r.expanded === 1 && r.assigned === 2
    && r.items[0].tabs.map(x => x.tabGid).join(',') === '10,20', JSON.stringify(r));
  t('다른 시트의 작업은 섞이지 않는다', !JSON.stringify(r.items[0].tabs).includes('30'));

  // 실행 = 탭별 INSERT + 시트 전체 행 소프트 해제
  db = pool([OWNS]);
  svc.__setPoolForTest(db);
  r = await svc.expandSheetOwnerships({ confirm: true, by: '홍길동' });
  const ins = db.q.filter(x => /INSERT INTO advertiser_campaigns/.test(x.s));
  t('작업마다 소유 INSERT', ins.length === 2 && ins[0].params[2] === '10' && ins[1].params[2] === '20');
  t('실행자 기록(assigned_by)', ins[0].params[3] === '홍길동');
  const del = db.q.find(x => /UPDATE advertiser_campaigns SET deleted_at/.test(x.s));
  t('★ 시트 전체 행만 소프트 해제(하드 삭제 금지)', !!del && /tab_gid IS NULL/.test(del.s) && !/DELETE FROM/i.test(del.s));
  t('★ 한 트랜잭션(BEGIN…COMMIT)', db.q.some(x => x.s === 'BEGIN') && db.q.some(x => x.s === 'COMMIT'));
  t('★ 쓰기 표면 = advertiser_campaigns 한 곳(시트·장부·주문 무접촉)',
    writes(db).every(x => /advertiser_campaigns/.test(x.s)));

  // fail-closed ① gid 없는 작업이 있으면 그 시트는 펼치지 않는다
  stubTabs([{ sheetId: 'S1', tabGid: '10', tabName: '작업A' }, { sheetId: 'S1', tabGid: '', tabName: 'gid 없음' }]);
  db = pool([OWNS]); svc.__setPoolForTest(db);
  r = await svc.expandSheetOwnerships({ confirm: true });
  t('★★ gid 없는 작업이 있으면 쓰기 0 + 사유(주인 없는 작업 금지)',
    writes(db).length === 0 && r.items[0].skipped === 'gidless_tab' && r.expanded === 0 && r.skipped === 1);

  // fail-closed ② 활성 작업이 없으면 소유를 지우지 않는다
  stubTabs([]);
  db = pool([OWNS]); svc.__setPoolForTest(db);
  r = await svc.expandSheetOwnerships({ confirm: true });
  t('★★ 활성 작업 0건이면 쓰기 0 + 사유', writes(db).length === 0 && r.items[0].skipped === 'no_active_tabs');

  // ③ 다른 업체가 탭 지정으로 가진 작업은 건너뛴다(조용한 탈취 금지)
  stubTabs(TABS_OK);
  db = pool([OWNS, [/ac\.tab_gid IS NOT NULL AND ac\.sheet_id = ANY/, () => ({ rows: [{ sheetId: 'S1', tabGid: '20', advertiserId: 'adv_b', advertiserName: '나업체' }] })]]);
  svc.__setPoolForTest(db);
  r = await svc.expandSheetOwnerships({ confirm: true });
  const ins2 = db.q.filter(x => /INSERT INTO advertiser_campaigns/.test(x.s));
  t('★★ 남이 작업 단위로 가진 건 건드리지 않는다', ins2.length === 1 && ins2[0].params[2] === '10'
    && r.items[0].keptTabOverrides[0].advertiserName === '나업체');

  // ④ 전부 남의 것이면 소유를 지우지 않는다
  db = pool([OWNS, [/ac\.tab_gid IS NOT NULL AND ac\.sheet_id = ANY/, () =>
    ({ rows: [{ sheetId: 'S1', tabGid: '10', advertiserId: 'adv_b', advertiserName: '나업체' },
              { sheetId: 'S1', tabGid: '20', advertiserId: 'adv_b', advertiserName: '나업체' }] })]]);
  svc.__setPoolForTest(db);
  r = await svc.expandSheetOwnerships({ confirm: true });
  t('★ 전부 남의 것이면 쓰기 0 + 사유', writes(db).length === 0 && r.items[0].skipped === 'all_tabs_taken');

  // staff 스코프 — 자기 담당 업체만
  db = pool([OWNS]); svc.__setPoolForTest(db);
  await svc.expandSheetOwnerships({ staffName: '만두' });
  const sel = db.q.find(x => /FROM advertiser_campaigns ac JOIN advertisers a/.test(x.s));
  t('★ staff 는 담당(inad_pm) 업체만', /TRIM\(COALESCE\(a\.inad_pm/.test(sel.s) && sel.params.includes('만두'));
  t('★ 종료(ended) 거래처는 대상 아님', /status,''\) <> 'ended'/.test(sel.s));
  participants.listActiveTabs = realList;

  /* ═══ 3. 라우트·화면 배선 ═══ */
  console.log('\n3) 라우트·배선');
  const router = require('../src/routes/trackB.routes');
  const hit = router.stack.filter(l => l.route && l.route.path === '/ownership/expand' && l.route.methods.post);
  t('라우터 스택에 실제 등록(1건)', hit.length === 1);
  const line = ROUTES.split('\n').find(l => l.includes("router.post('/ownership/expand'"));
  t('★ internal 게이트(광고주·리뷰어 차단)', /authMiddleware, internalMiddleware/.test(line || ''), line);
  t('★ 담당 아닌 업체는 거부(_ownershipWriteAllowed)',
    /\/ownership\/expand'[\s\S]{0,700}_ownershipWriteAllowed/.test(ROUTES));
  t('★ confirm === true 일 때만 실행(미리보기 기본)', /confirm: confirm === true/.test(ROUTES));

  const expGo = grab('_expGo');
  t('★ 실행 전 confirm(되돌리기 마찰)', /if\(!confirm\(/.test(expGo));
  t('★★ 부분 실패를 "완료"로 꾸미지 않는다', /일부만 펼침/.test(expGo));
  t('펼친 뒤 미지정 목록·화면 재조회', /_ovmReloadMapTabs\(\)/.test(expGo) && /renderOwnershipView\(\)/.test(expGo));
  t('팝업은 body 직속', /ov\.id='ownExpPop'[\s\S]{0,160}document\.body\.appendChild\(ov\)/.test(HTML));
  t('Esc 리스너는 최상위 1회',
    (HTML.match(/document\.addEventListener\('keydown',function\(e\)\{ if\(e\.key==='Escape'&&_expS\)/g) || []).length === 1);
  const owns = HTML.slice(HTML.indexOf('function _ovmOwnsHtml('), HTML.indexOf('function _ovmAddOwnHtml('));
  t('★ [작업 단위로 펼치기]는 시트 전체(▦) 줄에만', /whole&&isAdmin\?`<button class="trb"/.test(owns.replace(/\s+/g, ' ')));
  t('개요 헤더에 일괄 정리 버튼(내부 담당자)', /_isInternalRole\(\)\?`<button class="btn"[^`]*ownExpandAll\(\)/.test(HTML.replace(/\s+/g, ' ')));

  console.log(`\n✅ ownershipTabUnit: ${pass}개 통과`);
  process.exit(0);
}
run().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
