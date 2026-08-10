/**
 * 작업(소유) 이관 회귀가드 — 위프 작업을 (주)위드프렌즈 → 주식회사 위프코리아로 옮긴 건(2026-08-10).
 *
 *   1. transferOwnership — 한 트랜잭션(BEGIN/COMMIT) · 같은 범위만 해제 · 업서트 · 대상 검증 fail-closed.
 *   2. 우선순위 정합 — 시트전체 전개에서 "타 업체 탭지정" 배제(ownedTabsForAdvertiser · advertiserOverview).
 *   3. 라우터 — POST /ownership/transfer 가 adminOrMaster 게이트(staff 재배치 금지).
 *   4. 프론트 배선 — [이관] 버튼 admin 한정 · onclick 인덱스만 · 팝업 body 직속 · Esc 닫힘 · 부분실패 고지.
 * 실행: node tests/ownershipTransfer.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/trackB.service');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
const SVC = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ` — ${extra}` : '')); console.log('  ✓ ' + name); pass++; };

/** 스텁 pool — SQL 패턴별 응답. connect() 도 같은 query 를 쓴다(tx 경로 그대로 실행). */
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
const ADV_OK = [/SELECT id, name, status FROM advertisers WHERE id/, (s, p) =>
  ({ rows: p[0] === 'adv_none' ? [] : [{ id: p[0], name: p[0] === 'adv_end' ? '종료업체' : '주식회사 위프코리아', status: p[0] === 'adv_end' ? 'ended' : 'active' }] })];

async function run() {
  /* ═══ 1. transferOwnership — tx · 범위 · 검증 ═══ */
  console.log('\n1) transferOwnership(서비스 실행)');
  let db = pool([ADV_OK,
    [/UPDATE advertiser_campaigns ac SET deleted_at/, () => ({ rows: [{ advertiserId: 'adv_wf', advertiserName: '(주)위드프렌즈' }] })],
    [/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: [{ advertiserName: '(주)위드프렌즈', tabGid: null }] })],
  ]);
  svc.__setPoolForTest(db);
  let r = await svc.transferOwnership({ sheetId: 'sheet1', tabGid: '777', toAdvertiserId: 'adv_wc', by: '홍길동' });
  t('탭 이관 성공', r.ok === true && r.scope === 'tab' && r.tabGid === '777');
  t('★ 한 트랜잭션(BEGIN…COMMIT)', db.q.some(x => x.s === 'BEGIN') && db.q.some(x => x.s === 'COMMIT'));
  t('기존 소유 업체를 보고한다', Array.isArray(r.removed) && r.removed[0] === '(주)위드프렌즈');
  t('★ 나머지 탭을 계속 소유하는 시트전체 업체를 고지', Array.isArray(r.keptSheetOwners) && r.keptSheetOwners[0] === '(주)위드프렌즈');
  const del = db.q.find(x => /UPDATE advertiser_campaigns ac SET deleted_at/.test(x.s));
  t('★ 같은 범위만 해제(tab_gid 일치 조건)', /COALESCE\(ac\.tab_gid, ''\) = COALESCE\(\$2, ''\)/.test(del.s), del.s);
  t('★ 대상 업체 자신은 해제하지 않는다', /ac\.advertiser_id <> \$3/.test(del.s));
  const ins = db.q.find(x => /INSERT INTO advertiser_campaigns/.test(x.s));
  t('업서트로 지정(소프트삭제 행 재활성)', /ON CONFLICT .* DO UPDATE/.test(ins.s) && /deleted_at = NULL/.test(ins.s));
  t('이관 실행자 기록(assigned_by)', ins.params[3] === '홍길동');

  db = pool([ADV_OK, [/UPDATE advertiser_campaigns ac SET deleted_at/, () => ({ rows: [] })],
    [/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: [{ advertiserName: '(주)위드프렌즈', tabGid: '777' }] })]]);
  svc.__setPoolForTest(db);
  r = await svc.transferOwnership({ sheetId: 'sheet1', tabGid: null, toAdvertiserId: 'adv_wc' });
  t('시트 전체 이관 성공', r.ok === true && r.scope === 'sheet' && r.tabGid === null);
  t('★ 타 업체 탭지정 세분 소유는 보존·보고(조용한 삭제 금지)',
    Array.isArray(r.keptTabOverrides) && r.keptTabOverrides[0] && r.keptTabOverrides[0].tabGid === '777');

  // fail-closed 검증 3종
  svc.__setPoolForTest(pool([ADV_OK]));
  t('★ 없는 업체로 이관 거부(404)', (await svc.transferOwnership({ sheetId: 's', toAdvertiserId: 'adv_none' })).code === 404);
  svc.__setPoolForTest(pool([ADV_OK]));
  t('★ 종료(ended) 거래처로 이관 거부', (await svc.transferOwnership({ sheetId: 's', toAdvertiserId: 'adv_end' })).ok === false);
  db = pool([ADV_OK]);
  svc.__setPoolForTest(db);
  const bad = await svc.transferOwnership({ sheetId: '', toAdvertiserId: 'adv_wc' });
  t('필수값 없으면 400 + 쓰기 0', bad.code === 400 && !db.q.some(x => /INSERT|UPDATE/.test(x.s)));
  // 검증 실패는 ROLLBACK 으로 끝난다(트랜잭션이 열린 채 남지 않는다)
  db = pool([ADV_OK]);
  svc.__setPoolForTest(db);
  await svc.transferOwnership({ sheetId: 's', toAdvertiserId: 'adv_none' });
  t('★ 대상 검증 실패 = ROLLBACK', db.q.some(x => x.s === 'ROLLBACK') && !db.q.some(x => x.s === 'COMMIT'));

  /* ═══ 2. 우선순위 정합 — 탭지정 > 시트전체 ═══ */
  console.log('\n2) 소유 전개 정합(탭지정이 시트전체를 이긴다)');
  const ownedSql = SVC.slice(SVC.indexOf('async function ownedTabsForAdvertiser'), SVC.indexOf('async function ownedTabsForAdvertiser') + 4000);
  t('★ ownedTabsForAdvertiser: 시트전체 전개에서 타 업체 탭지정 배제',
    /o\.tab_gid IS NULL AND NOT EXISTS/.test(ownedSql) && /x\.advertiser_id <> \$1/.test(ownedSql));
  const ovSql = SVC.slice(SVC.indexOf('async function advertiserOverview'), SVC.indexOf('async function advertiserOverview') + 3000);
  t('★ advertiserOverview: 같은 배제(작업 수 이중 계수 금지)',
    /o\.tab_gid IS NULL AND NOT EXISTS/.test(ovSql) && /x\.advertiser_id <> o\.advertiser_id/.test(ovSql));

  // 실행 대조 — 시트전체 소유 업체의 표에서 "남이 탭지정으로 가져간 탭"이 빠지는지(스텁이 SQL 을 해석하지
  // 않으므로 여기서는 쿼리 형태를 고정하고, 실제 배제 동작은 위 정적 단언 + 운영 PG 가 담당한다).
  db = pool([[/WITH own AS/, () => ({ rows: [] })]]);
  svc.__setPoolForTest(db);
  const got = await svc.ownedTabsForAdvertiser({ advertiserId: 'adv_wf' });
  t('반환 계약 유지({rows, *Unavailable})', got && Array.isArray(got.rows) && 'statsUnavailable' in got);

  /* ═══ 3. 라우터 게이트 ═══ */
  console.log('\n3) 라우트 권한');
  const line = ROUTES.split('\n').find(l => l.includes("router.post('/ownership/transfer'"));
  t('POST /ownership/transfer 존재', !!line);
  t('★ adminOrMaster 게이트(staff 재배치 금지)', /authMiddleware, adminOrMasterMiddleware/.test(line || ''), line);
  const router = require('../src/routes/trackB.routes');
  const hit = router.stack.filter(l => l.route && l.route.path === '/ownership/transfer' && l.route.methods.post);
  t('라우터 스택에 실제 등록(1건)', hit.length === 1);

  /* ═══ 4. 프론트 배선 ═══ */
  console.log('\n4) 화면 배선');
  const ownsBlock = HTML.slice(HTML.indexOf('function _ovmOwnsHtml('), HTML.indexOf('function _ovmAddOwnHtml('));
  t('소유 캠페인 줄에 [이관] 버튼', /ownTransfer\(/.test(ownsBlock));
  t('★ 이관 버튼은 admin/master 에만(서버 게이트와 1:1)', /isAdmin\?`<button class="trb"/.test(ownsBlock.replace(/\s+/g, ' ')));
  t('★ onclick 은 인덱스만(문자열 보간 금지)', /onclick="ownTransfer\(\$\{i\}\)"/.test(ownsBlock));
  t('팝업은 body 직속', /document\.body\.appendChild\(ov\)/.test(HTML));
  t('Esc 로 닫힌다(리스너 최상위 1회)',
    (HTML.match(/document\.addEventListener\('keydown',function\(e\)\{ if\(e\.key==='Escape'&&_trS\)/g) || []).length === 1);
  t('★ 이관 팝업 Esc 가 드로어보다 먼저(중복 닫힘 방지)',
    HTML.indexOf("&&_trS){ e.stopImmediatePropagation()") < HTML.indexOf('&&_ovmDrawer) _ovmCloseDrawer()'));
  t('실행 전 confirm(되돌리기 마찰)', /if\(!confirm\(scopeTxt/.test(HTML));
  t('★ 부분 실패를 완료로 꾸미지 않는다', /일부만 이관됨/.test(HTML));
  t('새 거래처 등록 경로도 인트라넷 등록 검증(등록 게이트 동일)', /_trChk\(\)/.test(HTML) && /S\.newOk/.test(HTML));
  t('이관 후 목록·배지 갱신', /await refreshAdvCounts\(\);/.test(HTML.slice(HTML.indexOf('async function ownTransferGo'))));

  svc.__setPoolForTest(null);
  console.log(`\n✅ ownershipTransfer: ${pass}개 통과`);
  process.exit(0);   // trackB.routes require 로 DB 풀 핸들이 열려 프로세스가 안 끝난다(레포 관용구)
}
run().catch(e => { console.error('❌', e.message); process.exit(1); });
