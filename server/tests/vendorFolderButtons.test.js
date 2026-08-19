/**
 * vendorFolderButtons.test.js — 업체관리 [자료] 열 + 작업보드 상단 폴더 바로가기 회귀가드
 *   시안·결정 = frontend/docs/design-vendor-folder-buttons.html
 *   (사용자 확정 2026-08-06: A안 · [자료] 열 기본 켬 · 3버튼 · 작업보드 상단도 같이 · 폭은 넓힌다)
 *
 * 이 변경에서 깨지면 아픈 것 다섯.
 *  ① **렌더러·열기 동작이 한 벌** — 홈/업체관리/작업보드에 사본을 두면 한쪽만 _folUrlOk 검증이 풀리거나
 *     현영 판정이 갈라진다. 세 소비처가 모두 _folBtnsHtml/_folBtnsInner 를 태우는지 실행으로 본다.
 *  ② **현영 판정 단일 규칙** — 버튼 활성(_folMat.cr ← 서버 cashReceipt)과 /tab-folders 의 허용 판정이
 *     같은 함수(captureSlots.hasCashReceiptSlot)여야 "눌리는데 서버가 거부"가 안 생긴다.
 *  ③ **"모른다"와 "없다"의 구분** — 조회 실패·필드 부재를 '대상 아님'/'폴더 없음'으로 단정하면
 *     조용한 거짓 안내가 된다(레포의 무신호 금지 규율).
 *  ④ **열 수 계약** — 헤더 칸 ≡ 행 칸 ≡ grid 열. 열을 끼워 넣을 때 가장 흔히 깨지는 자리.
 *  ⑤ **광고주 격리** — /tab-folders 는 internalMiddleware 라 광고주에게 버튼을 그리면 막다른 길이다.
 * 실행: node tests/vendorFolderButtons.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
const SVC = fs.readFileSync(path.join(__dirname, '../src/services/trackB.service.js'), 'utf8');
const DOC = fs.readFileSync(path.join(__dirname, '../../frontend/docs/design-vendor-folder-buttons.html'), 'utf8');
// ★ "그 호출이 코드에 없다" 류 판정은 **주석을 제외**하고 봐야 한다(설명문에 옛 호출을 적어 두므로).
//   ★★ 단 **줄 주석만** 지운다 — 블록 주석 정규식(`/\*…\*/`)은 이 파일의 정규식 리터럴을 물어
//     41KB(코드 3분의 1)를 통째로 삼켰다(실측). 지우려는 것보다 큰 것을 지우는 도구는 쓰지 않는다.
const noComments = src => src.replace(/^[ \t]*\/\/.*$/gm, '');
const ROUTES_CODE = noComments(ROUTES);

let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ` — ${extra}` : '')); console.log('  ✓ ' + name); pass++; };

/** workdesk.html 에서 함수 블록을 중괄호 균형으로 뽑아온다(vm 실행용). */
function grab(name, src = HTML) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i > 0, `블록 추출: function ${name} 존재`);
  for (let k = src.indexOf('{', i), d = 0; k < src.length; k++) {
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

async function run() {
  /* ═══ 1. 현영 판정 단일 규칙 ═══ */
  console.log('\n1) 현영 판정 단일 규칙(captureSlots.hasCashReceiptSlot)');
  const cs = require('../src/utils/captureSlots');
  t('income_type 에 현영 = 대상', cs.hasCashReceiptSlot(null, '사업자현영') === true);
  t('일반 진행방식 = 아님', cs.hasCashReceiptSlot(null, '계산서') === false);
  t('관리자 명시 capture_slots 의 receipt 도 대상(라우트의 옛 compound 규칙 흡수)',
    cs.hasCashReceiptSlot([{ key: 'review' }, { key: 'receipt' }], '계산서') === true);
  // ★★ 코드리뷰가 잡은 회귀 고정: capture_slots 의 **유일한 writer**(tabconfig.routes)는 key 를 위치로
  //   부여해 `receipt` 를 절대 저장하지 않는다(0번=review, 그 외 slot2…). 그래서 key 만 보면 관리자가
  //   [리뷰, 현금영수증] 으로 설정한 현영 탭의 버튼이 죽는다 — **라벨로도 찾아야** 한다.
  t('★★ 수동 슬롯(key=slot2, label=현금영수증)도 대상 — 실제 writer 가 만드는 모양',
    cs.hasCashReceiptSlot([{ key: 'review', label: '리뷰' }, { key: 'slot2', label: '현금영수증' }], '사업자현영') === true);
  t('★ 라벨 변형(지출증빙)도 인정', cs.hasCashReceiptSlot([{ key: 'review', label: '리뷰' }, { key: 'slot2', label: '지출증빙' }], '사업자현영') === true);
  t('비현영 탭이라도 현금영수증 슬롯을 설정했으면 대상(업로드가 그 폴더를 만든다)',
    cs.hasCashReceiptSlot([{ key: 'review', label: '리뷰' }, { key: 'slot2', label: '현금영수증' }], '계산서') === true);
  t('현영인데 슬롯에 현금영수증 칸이 전혀 없으면 슬롯 없음(오설정)',
    cs.hasCashReceiptSlot([{ key: 'review', label: '리뷰' }, { key: 'slot2', label: '추가컷' }], '사업자현영') === false);
  // ★ 그 오설정을 '대상 아님'으로 뭉개지 않는다 — 무엇을 고쳐야 하는지 말하는 문구가 따로 있다.
  t('★ 오설정은 안내 문구를 돌려준다(대상 아님과 구분)',
    cs.cashReceiptNote([{ key: 'review', label: '리뷰' }, { key: 'slot2', label: '추가컷' }], '사업자현영') === cs.CR_MISCONFIG_NOTE
    && cs.cashReceiptNote(null, '계산서') === null && cs.cashReceiptNote(null, '사업자현영') === null);
  // ★ 폴더 이름은 그 슬롯의 실제 라벨 — slotLabel(...,'receipt') 로 찾으면 'receipt' 폴더를 뒤진다.
  t('★ 폴더 이름 재료 = 슬롯 label',
    cs.cashReceiptSlotInfo([{ key: 'review', label: '리뷰' }, { key: 'slot2', label: '현금영수증' }], '사업자현영').slot.label === '현금영수증'
    && cs.cashReceiptSlotInfo(null, '사업자현영').slot.label === '현금영수증');
  t('빈 값·null 은 아님(추측 금지)', cs.hasCashReceiptSlot(null, null) === false && cs.hasCashReceiptSlot([], '') === false);
  t('★ 규칙은 effectiveCaptureSlots 파생(사본 금지)',
    /function cashReceiptSlotInfo[\s\S]{0,260}effectiveCaptureSlots\(/.test(fs.readFileSync(path.join(__dirname, '../src/utils/captureSlots.js'), 'utf8')));
  t('★ hasCashReceiptSlot 은 cashReceiptSlotInfo 위임(판정 사본 0)',
    /function hasCashReceiptSlot\(captureSlots, incomeType\) \{\s*return !!cashReceiptSlotInfo\(/.test(fs.readFileSync(path.join(__dirname, '../src/utils/captureSlots.js'), 'utf8')));

  const CSSRC = fs.readFileSync(path.join(__dirname, '../src/utils/captureSlots.js'), 'utf8');
  t('export 되어 세 소비처가 같은 함수를 쓴다', /module\.exports = \{[\s\S]{0,400}hasCashReceiptSlot/.test(CSSRC));
  t('★ tabStatsMap(홈) 도 같은 함수', /cashReceipt: hasCashReceiptSlot\(r\.captureSlots, r\.incomeType\)/.test(SVC));
  t('★ /tab-folders 허용 판정도 같은 함수(눌리는데 거부 금지)',
    /const cr = cashReceiptSlotInfo\(tc\.capture_slots, tc\.income_type\);/.test(ROUTES) && /if \(!cr\.slot\)/.test(ROUTES));
  t('★★ Drive 폴더 이름은 슬롯 실제 label(슬롯 key 가 receipt 가 아닐 수 있다)',
    /const label = \(cr\.slot && cr\.slot\.label\) \|\| '현금영수증';/.test(ROUTES) && !/slotLabel\([^)]*'receipt'/.test(ROUTES_CODE));
  t("★ 오설정은 '대상 아님' 이 아니라 고칠 곳을 말한다", /cr\.incomeSaysCashReceipt \? CR_MISCONFIG_NOTE/.test(ROUTES));
  t('현영 판정 사본 없음 — isCashReceiptIncome 직접 호출이 trackB 서비스·라우트에 남지 않았다',
    !/isCashReceiptIncome\(/.test(SVC) && !/isCashReceiptIncome\(/.test(ROUTES));

  /* ═══ 2. 서버 — 연결탭 응답의 폴더 재료 ═══ */
  console.log('\n2) 연결탭 응답 폴더 재료(ownedTabsForAdvertiser)');
  t('SELECT 에 capture_slots·income_type 합류(tab_configs 를 이미 조인 — 쿼리 순증 0)',
    /tc\.capture_slots AS "captureSlots", tc\.income_type AS "incomeType"/.test(SVC));
  t('folder_url·capture_folder_url 은 종전대로 함께 온다',
    /tc\.folder_url AS "folderUrl", tc\.capture_folder_url AS "captureFolderUrl"/.test(SVC));
  const svc = require('../src/services/trackB.service');
  {
    svc.__resetTabStatsCacheForTest && svc.__resetTabStatsCacheForTest();
    svc.__setPoolForTest(pool([
      [/FROM tabs t/, () => ({ rows: [
        { sheetId: 'S1', tabName: 'T현영', tabGid: '11', folderUrl: 'https://drive.google.com/drive/folders/a', captureFolderUrl: null, captureSlots: null, incomeType: '사업자현영' },
        { sheetId: 'S1', tabName: 'T일반', tabGid: '12', folderUrl: null, captureFolderUrl: null, captureSlots: null, incomeType: '계산서' },
      ] })],
    ]));
    const out = await svc.ownedTabsForAdvertiser({ advertiserId: 'a1' });
    t('행마다 cashReceipt 불리언을 파생해 싣는다',
      out.rows[0].cashReceipt === true && out.rows[1].cashReceipt === false, JSON.stringify(out.rows.map(r => r.cashReceipt)));
    t('★ 판정 원재료(capture_slots·income_type)는 응답에서 버린다(전송 낭비·프론트 재판정 방지)',
      !('captureSlots' in out.rows[0]) && !('incomeType' in out.rows[0]));
    t('annotate 미지정이어도 폴더 재료는 온다(통계 주석만 opt-in)',
      out.statsUnavailable === false && out.rows[0].folderUrl);
  }

  /* ═══ 2b. /ownership/tabs — staff 는 담당 업체가 아니면 폴더 URL 미수신 ═══ */
  console.log('\n2b) 업체관리 목록의 staff 폴더 스코프');
  t('담당 여부는 기존 헬퍼 한 쿼리(inad_pm)로 판정', /svc\.staffOwnsAdvertiser\(\{ advertiserId: req\.query\.advertiserId/.test(ROUTES_CODE));
  t('★ 담당 밖이면 폴더 URL·현영 판정을 비운다', /folderUrl: null, captureFolderUrl: null, cashReceipt: false/.test(ROUTES_CODE));
  t('★ 조용히 비우지 않고 folderScoped:false 로 고지', /folderScoped: false/.test(ROUTES_CODE));
  t('★ admin/master 응답은 종전 그대로(플래그 미동봉)', /\.\.\.\(folderScoped \? \{\} : \{ folderScoped: false \}\)/.test(ROUTES_CODE));
  {
    // ★ 정규식이 아니라 **핸들러를 실제로 호출**해 확인한다(스코프 판정은 실행으로만 증명된다).
    const express = require('express');
    const orig = express.Router;
    let cap = null;
    express.Router = function (...a) { const r = orig.apply(this, a); cap = cap || r; return r; };
    delete require.cache[require.resolve('../src/routes/trackB.routes')];
    const routes = require('../src/routes/trackB.routes');   // eslint-disable-line no-unused-vars
    express.Router = orig;
    const layer = cap.stack.find(l => l.route && l.route.path === '/ownership/tabs');
    assert.ok(layer, '/ownership/tabs 라우트 존재');
    const h = layer.route.stack[layer.route.stack.length - 1].handle;
    const svc2 = require('../src/services/trackB.service');
    const realOwned = svc2.ownedTabsForAdvertiser, realMine = svc2.staffOwnsAdvertiser;
    svc2.ownedTabsForAdvertiser = async () => ({ rows: [{ sheetId: 'S1', tabName: 'T1',
      folderUrl: 'https://drive.google.com/drive/folders/RV', captureFolderUrl: 'https://drive.google.com/drive/folders/CAP',
      cashReceipt: true, hasTabConfig: true }], statsUnavailable: false, finishedUnavailable: false });
    const callOwn = (role, mine) => new Promise(res => {
      svc2.staffOwnsAdvertiser = async () => mine;
      h({ query: { advertiserId: 'a1' }, admin: { role, name: 'AE1' } },
        { json: b => res(b), status: () => ({ json: b => res(b) }) }, e => res({ err: String(e) }));
    });
    const asAdmin = await callOwn('admin', false);
    t('admin 은 종전 그대로 폴더 URL 을 받는다(플래그 미동봉)',
      asAdmin.items[0].folderUrl && asAdmin.items[0].captureFolderUrl && asAdmin.folderScoped === undefined, JSON.stringify(asAdmin).slice(0, 130));
    const staffMine = await callOwn('staff', true);
    t('담당 업체면 staff 도 종전 그대로', staffMine.items[0].folderUrl && staffMine.folderScoped === undefined);
    const staffOther = await callOwn('staff', false);
    t('★★ 담당 밖 업체 = 폴더 URL 두 개와 현영 판정이 비워져 나간다(버튼이 우회 수단이 되지 않는다)',
      staffOther.items[0].folderUrl === null && staffOther.items[0].captureFolderUrl === null
      && staffOther.items[0].cashReceipt === false, JSON.stringify(staffOther.items[0]));
    t('★ 그리고 그 사실을 folderScoped:false 로 말한다(조용히 비우지 않는다)', staffOther.folderScoped === false);
    t('다른 값(작업명·통계 플래그)은 그대로 나간다', staffOther.items[0].tabName === 'T1' && staffOther.statsUnavailable === false);
    svc2.ownedTabsForAdvertiser = realOwned; svc2.staffOwnsAdvertiser = realMine;
  }
  t('프론트가 그 플래그를 소비 — 버튼은 사유를 말하고 표 상단에 안내',
    /\(STATE\.ownTabMeta\|\|\{\}\)\.folderScoped===false/.test(HTML) && /담당하지 않은 업체라 <b>\[자료\]<\/b>/.test(HTML));
  t('meta 에 folderScoped 를 실어 둔다(구버전 응답은 true 로 수렴 = 동작 불변)',
    /folderScoped: rt\.folderScoped===false \? false : true/.test(HTML));

  /* ═══ 3. 서버 — /tab-folders?kind=info 가산 분기 ═══ */
  console.log('\n3) /tab-folders?kind=info(작업보드 상단 재료)');
  t('신규 엔드포인트 0 — 같은 라우트에 kind=info 분기', /const wantInfo = String\(req\.query\.kind \|\| ''\) === 'info'/.test(ROUTES));
  t('★ 같은 스코프 게이트를 지난다(authMiddleware + internalMiddleware)',
    /router\.get\('\/tab-folders', authMiddleware, internalMiddleware/.test(ROUTES));
  {
    // 라우터 스택 실검사 + 핸들러 실행
    const express = require('express');
    const orig = express.Router;
    let captured = null;
    express.Router = function (...a) { const r = orig.apply(this, a); captured = captured || r; return r; };
    delete require.cache[require.resolve('../src/routes/trackB.routes')];
    delete require.cache[require.resolve('../src/db/pool')];
    const poolMod = require('../src/db/pool');
    const calls = [];
    poolMod.query = async (sql, params) => {
      calls.push(String(sql).replace(/\s+/g, ' ').trim());
      return { rows: [{ folder_url: 'https://drive.google.com/drive/folders/rev', capture_folder_url: 'https://drive.google.com/drive/folders/cap', capture_slots: null, income_type: '사업자현영' }] };
    };
    require('../src/routes/trackB.routes');
    express.Router = orig;
    // ★ 라우터 require 는 다른 모듈의 부팅 시 컬럼 보정(ALTER/INSERT)을 함께 태운다 — 그 소음을 비우고
    //   **핸들러 실행 중에 나간 쿼리만** 센다(안 비우면 DDL 이 섞여 '쿼리 순증 0' 단언이 무의미해진다).
    await new Promise(r => setTimeout(r, 120));
    calls.length = 0;
    const layer = captured.stack.find(l => l.route && l.route.path === '/tab-folders');
    t('라우터에 /tab-folders 가 등록되어 있다(스택 실검사)', !!layer);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const run1 = (query, role) => new Promise(res => {
      const req = { query, admin: { role, name: '김수만' } };
      handler(req, { json: b => res({ b }), status: c => ({ json: b => res({ b, code: c }) }) }, e => res({ err: e }));
    });
    const info = await run1({ kind: 'info', sheetId: 'S1', tabName: 'T1' }, 'admin');
    t('kind=info = 세 재료를 한 번에(folderUrl·captureFolderUrl·cashReceipt)',
      info.b.ok === true && info.b.folderUrl && info.b.captureFolderUrl && info.b.cashReceipt === true, JSON.stringify(info.b));
    t("★★ 신규 응답에 kind:'info' 표식(배포 스큐 판별의 유일한 근거)", info.b.kind === 'info', JSON.stringify(info.b));
    t('★ Drive 무접촉 — tab_configs 한 줄 조회뿐',
      calls.length === 1 && /FROM tab_configs/.test(calls[0]), calls.join(' | '));
    t('★ 무거운 stats=1(review_index 전체 GROUP BY) 경로를 타지 않는다',
      !calls.some(c => /review_index/.test(c)));
    const cached = await run1({ kind: 'info', sheetId: 'S1', tabName: 'T1' }, 'admin');
    t('재조회는 캐시(같은 탭을 다시 열어도 쿼리 순증 0)', cached.b.ok === true && calls.length === 1, 'queries=' + calls.length);
    t("★★ **캐시 응답에도** kind 표식(한 경로만 붙이면 스큐 판별이 샌다)", cached.b.kind === 'info', JSON.stringify(cached.b));
    // ★★ AE(staff) 범위 — **사용자 확정 2026-08-19: 담당이 아니어도 전부 연다.**
    //   이 자리는 원래 "담당 밖 staff = 403(캐시가 스코프를 우회하지 않는다)" 를 고정했다. 그러나
    //   그때 이미 `/workdesk`(작업보드 본문)·`/tabs`(작업 목록)가 `allowAllStaff` 로 전체를 열어 주고
    //   있어 **폴더 버튼만 막는 반쪽 규칙**이었고, 지금 라우트는 그 사실을 주석으로 못박고 있다
    //   (“staff는 작업보드 전체 운영 권한이므로 담당 여부와 무관하게 폴더를 연다”).
    //   ★ 되돌린다면 `/workdesk`·`/tabs`·공유 링크(`/share-link/:code`)와 **함께** 좁혀야 한다.
    const staffCached = await run1({ kind: 'info', sheetId: 'S1', tabName: 'T1' }, 'staff');
    t('★★ AE 는 담당이 아니어도 연다 — 캐시된 탭에서도(작업보드와 같은 규칙)',
      staffCached.b.ok === true && !!staffCached.b.folderUrl, JSON.stringify(staffCached));
    const staffCached2 = await run1({ sheetId: 'S1', tabName: 'T1' }, 'staff');   // 현영(receipt) 분기도 같은 규율
    // 현영(receipt) 분기도 같은 규칙 — 권한으로 막히지 않고 **실제 폴더 해석 로직까지 도달**한다
    //   (이 픽스처는 리뷰 폴더가 없어 그 사유를 돌려주는 것이 정상 결과다).
    t('★★ 현영 분기도 같은 규칙 — 권한으로 막히지 않는다(분기마다 기준이 갈리지 않는다)',
      staffCached2.code !== 403 && !/권한|담당 범위/.test(staffCached2.b.error || ''), JSON.stringify(staffCached2));
    t('★ 담당 스코프 판정을 이 라우트가 따로 만들지 않는다(작업보드와 갈리는 두 번째 기준 금지)',
      !/tab-folders'[\s\S]{0,2600}canAccessTab/.test(ROUTES_CODE));
    // ★ 남은 경계는 **광고주 차단**이고, 그것은 핸들러가 아니라 라우터 단계가 맡는다 —
    //   미들웨어가 핸들러보다 앞이면 캐시 히트가 그 앞을 우회할 수 없다.
    t('★ 광고주 차단은 라우터 단계(internalMiddleware 가 핸들러보다 앞)', (() => {
      const layer = require('../src/routes/trackB.routes').stack.find(l => l.route && l.route.path === '/tab-folders');
      const ns = layer.route.stack.map(x => x.name);
      const k = ns.indexOf('internalMiddleware');
      return k > -1 && k < ns.length - 1;
    })());
    // 미등록 탭은 사유를 말한다(빈 값으로 위장하지 않는다)
    poolMod.query = async () => ({ rows: [] });
    const none = await run1({ kind: 'info', sheetId: 'S9', tabName: 'T9' }, 'admin');
    t('★ 미등록 탭 = ok:false + 사유(프론트가 그 문구를 툴팁으로 보여준다)',
      none.b.ok === false && /등록되지 않은 탭/.test(none.b.error) && none.b.kind === 'info', JSON.stringify(none.b));
  }

  /* ═══ 4. 프론트 — 렌더러 한 벌 · 재료 정규화 실행 ═══ */
  console.log('\n4) 폴더 버튼 렌더러(vm 실행)');
  t('★ 렌더러는 한 벌 — _folBtnsInner 정의는 1개', (HTML.match(/function _folBtnsInner\(/g) || []).length === 1);
  t('★ 재료 정규화도 한 벌 — _folMat 정의는 1개', (HTML.match(/function _folMat\(/g) || []).length === 1);
  t('★ URL 검증은 한 벌 — _folUrlOk 정의는 1개', (HTML.match(/function _folUrlOk\(/g) || []).length === 1);
  t('★ Drive 호스트만 연다(시트/DB 를 거쳐 온 문자열을 새창에 넣지 않는다)',
    /function _folUrlOk\(u\)\{ return \/\^https:\\\/\\\/drive\\\.google\\\.com\\\/\/\.test/.test(HTML));

  const src = [grab('_folUrlOk'), grab('_folRow'), grab('_folMat'), grab('_folBtnsInner'), grab('_folBtnsHtml'), grab('_folBarHtml')].join('\n');
  const mk = (extra = {}) => {
    const sb = Object.assign({
      STATE: { tabs: [], ownTabs: [], cur: null, role: 'admin' },
      esc: v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    }, extra);
    vm.createContext(sb); vm.runInContext(src, sb);
    return sb;
  };
  const D = id => 'https://drive.google.com/drive/folders/' + id;
  const btns = html => {
    const out = [];
    const re = /<button class="wbl-b( dis)?"([^>]*)>([^<]*)<\/button>/g;
    let m; while ((m = re.exec(html))) out.push({ dis: !!m[1], attrs: m[2], label: m[3].trim() });
    return out;
  };
  {
    const sb = mk({});
    sb.STATE.ownTabs = [{ sheetId: 'S1', tabName: 'T1', folderUrl: D('r'), captureFolderUrl: D('c'), cashReceipt: true }];
    const b = btns(vm.runInContext("_folBtnsHtml(STATE.ownTabs[0],0,'own')", sb));
    t('업체관리(own) = 재료가 행 자체에 있다 → 3버튼 전부 활성', b.length === 3 && b.every(x => !x.dis), JSON.stringify(b.map(x => x.label + (x.dis ? '(x)' : ''))));
    t('압축 라벨 구매/리뷰/현영(열 폭 유지)', b.map(x => x.label).join('/') === '구매/리뷰/현영');
    t('★ onclick 은 인덱스만 — 탭명·URL 문자열 주입 없음',
      b.every(x => /openTabFolder\(0,'(capture|review|receipt)','own'\)/.test(x.attrs)) && !/T1|drive\.google/.test(JSON.stringify(b)));
    t('★ 행 클릭(작업보드 열기)으로 튀지 않게 stopPropagation', b.every(x => /event\.stopPropagation\(\)/.test(x.attrs)));
  }
  {
    const sb = mk({});
    sb.STATE.ownTabs = [{ sheetId: 'S1', tabName: 'T2', folderUrl: null, captureFolderUrl: null, cashReceipt: false }];
    const b = btns(vm.runInContext("_folBtnsHtml(STATE.ownTabs[0],0,'own')", sb));
    t('★ 폴더 없음 = 숨기지 않고 비활성(줄마다 버튼 수가 같아야 눈이 열을 다시 찾지 않는다)',
      b.length === 3 && b.every(x => x.dis));
    t('폴더 미생성 사유를 툴팁으로 말한다', /자동 생성됩니다/.test(b[0].attrs));
    t('현영 비대상 사유를 툴팁으로 말한다', /발행 대상 작업이 아닙니다/.test(b[2].attrs));
  }
  {
    // ★ cashReceipt 필드 부재(구버전 백엔드) = '대상 아님'으로 단정 금지
    const sb = mk({});
    sb.STATE.ownTabs = [{ sheetId: 'S1', tabName: 'T3', folderUrl: D('r'), captureFolderUrl: D('c') }];
    const b = btns(vm.runInContext("_folBtnsHtml(STATE.ownTabs[0],0,'own')", sb));
    t('★ cashReceipt 미상 = 비활성 + "알 수 없습니다"(false 로 꾸미지 않는다)',
      b[2].dis && /알 수 없습니다/.test(b[2].attrs), b[2].attrs);
  }
  {
    // ★ own 의 두 가지 '모른다' — 담당 밖 업체 / tab_configs 행 없음
    const sb = mk({});
    sb.STATE.ownTabMeta = { folderScoped: false };
    sb.STATE.ownTabs = [{ sheetId: 'S1', tabName: 'T5', folderUrl: D('r'), captureFolderUrl: D('c'), cashReceipt: true }];
    let b = btns(vm.runInContext("_folBtnsHtml(STATE.ownTabs[0],0,'own')", sb));
    t('★ 담당 밖 업체 = 비활성 + 문의 안내(폴더 미생성으로 위장하지 않는다)',
      b.every(x => x.dis) && /담당하지 않은 업체/.test(b[0].attrs), b[0].attrs);
    sb.STATE.ownTabMeta = {};
    sb.STATE.ownTabs = [{ sheetId: 'S1', tabName: 'T6', hasTabConfig: false }];
    b = btns(vm.runInContext("_folBtnsHtml(STATE.ownTabs[0],0,'own')", sb));
    t('★ 탭 설정 미등록 = "등록 정보가 없습니다"(폴더 없음과 다른 사실)',
      b.every(x => x.dis) && /등록 정보가 없습니다/.test(b[0].attrs), b[0].attrs);
    sb.STATE.ownTabs = [{ sheetId: 'S1', tabName: 'T7', folderUrl: D('r'), captureFolderUrl: D('c'), cashReceipt: false,
      cashReceiptNote: '진행방식은 현영인데 캡처 슬롯 설정에 현금영수증 칸이 없습니다 — 탭 설정을 확인해 주세요.' }];
    b = btns(vm.runInContext("_folBtnsHtml(STATE.ownTabs[0],0,'own')", sb));
    t("★ 오설정은 서버 문구 그대로('대상 아님' 으로 뭉개지 않는다)",
      b[2].dis && /슬롯 설정에 현금영수증 칸이 없습니다/.test(b[2].attrs) && !b[0].dis, b[2].attrs);
  }
  {
    // 홈(home) — stats 병합 객체에서 읽고, stats 자체가 없으면 그 사실을 말한다
    const sb = mk({});
    sb.STATE.tabs = [{ sheetId: 'S1', tabName: 'H1', stats: { folderUrl: D('r'), captureFolderUrl: D('c'), cashReceipt: false } }, { sheetId: 'S1', tabName: 'H2' }];
    const b1 = btns(vm.runInContext('_folBtnsHtml(STATE.tabs[0],0)', sb));
    t('홈(기본 src) = stats 에서 읽는다(무회귀)', !b1[0].dis && !b1[1].dis && b1[2].dis);
    t('홈 onclick 은 src 인자 없이 종전 형태', /openTabFolder\(0,'capture'\)/.test(b1[0].attrs), b1[0].attrs);
    const b2 = btns(vm.runInContext('_folBtnsHtml(STATE.tabs[1],1)', sb));
    t('★ 통계 미도착 = 전부 비활성 + "수치를 불러오지 못해…"(폴더가 없다고 말하지 않는다)',
      b2.every(x => x.dis) && /수치를 불러오지 못해/.test(b2[0].attrs), b2[0].attrs);
  }
  {
    // 작업보드(cur) — _fol 지연조회 / 실패 사유 / stats 재사용
    const sb = mk({});
    sb.STATE.cur = { sheetId: 'S1', tabName: 'C1' };
    let b = btns(vm.runInContext('_folBarHtml()', sb));
    t('★ 재료 도착 전 = 비활성 + "불러오는 중"(빈 폴더로 위장하지 않는다)',
      b.every(x => x.dis) && /불러오는 중/.test(b[0].attrs), b[0].attrs);
    sb.STATE.cur._fol = { err: '등록되지 않은 탭입니다.' };
    b = btns(vm.runInContext('_folBarHtml()', sb));
    t('★ 조회 실패 = 비활성 + 서버가 준 사유 그대로', b.every(x => x.dis) && /등록되지 않은 탭/.test(b[0].attrs), b[0].attrs);
    sb.STATE.cur._fol = { folderUrl: D('r'), captureFolderUrl: D('c'), cashReceipt: true };
    const html = vm.runInContext('_folBarHtml()', sb);
    b = btns(html);
    t('재료 도착 = 3버튼 활성', b.length === 3 && b.every(x => !x.dis));
    t('큰 버튼 = 라벨 전체 + ↗(작업이 하나로 특정된 자리)',
      /🛒 구매캡처 ↗/.test(b[0].label) && /📸 리뷰캡처 ↗/.test(b[1].label) && /🧾 현금영수증 ↗/.test(b[2].label), JSON.stringify(b.map(x => x.label)));
    t('★ 갱신 대상 id(folBar) + folbig 클래스', /id="folBar"/.test(html) && /wbl-fol folbig/.test(html));
    // 홈에서 온 stats 가 있으면 그것을 쓴다(요청 0)
    const sb2 = mk({});
    sb2.STATE.cur = { sheetId: 'S1', tabName: 'C2', stats: { folderUrl: D('r'), captureFolderUrl: null, cashReceipt: false } };
    b = btns(vm.runInContext('_folBarHtml()', sb2));
    t('홈 stats 가 있으면 그 재료를 재사용(추가 조회 없음)', b[0].dis && !b[1].dis && b[2].dis);
    // ★ 광고주 격리
    const sb3 = mk({});
    sb3.STATE.role = 'advertiser';
    sb3.STATE.cur = { sheetId: 'S1', tabName: 'C3', _fol: { folderUrl: D('r'), captureFolderUrl: D('c'), cashReceipt: true } };
    t('★ 광고주에게는 상단 버튼을 그리지 않는다(/tab-folders 는 내부인 전용 = 막다른 길 방지)',
      vm.runInContext('_folBarHtml()', sb3) === '');
  }
  {
    // _folRow — src 별 행 해석(엉뚱한 배열에서 집으면 남의 폴더가 열린다)
    const sb = mk({});
    sb.STATE.tabs = [{ tabName: 'HOME' }]; sb.STATE.ownTabs = [{ tabName: 'OWN' }]; sb.STATE.cur = { tabName: 'CUR' };
    t("_folRow 가 src 별로 올바른 원본을 집는다",
      vm.runInContext("[_folRow('home',0).tabName,_folRow('own',0).tabName,_folRow('cur',0).tabName].join('/')", sb) === 'HOME/OWN/CUR');
  }

  /* ═══ 5. 프론트 배선 — 열·토글·지연조회·폭 ═══ */
  console.log('\n5) 프론트 배선');
  t('★ [자료] 열 기본 켬(끈 선택만 기억 — 사용자 확정)', /mat:!\(v&&v\.mat===false\)/.test(HTML));
  t('열 묶음 토글에 [자료] 버튼', /data-c="mat"[^>]*onclick="_ovmToggleCol\('mat',this\)">자료</.test(HTML));
  t('grid 에 자료 열 폭(136px — .wbl-fol 126px 이 칸을 뚫지 않는 최소치 + 여유)', /if\(c\.mat\)\s+F\(136\);/.test(HTML));
  t('헤더에 <span>자료</span>', /if\(c\.mat\)\s+h\.push\('<span>자료<\/span>'\)/.test(HTML));
  t('★ 행 셀은 공용 렌더러 호출(사본 금지)', /if\(c\.mat\) cells\.push\(`<span class="ocol omat">\$\{_folBtnsHtml\(t,i,'own'\)\}<\/span>`\)/.test(HTML));
  t('★ 배치 = 진척 다음 · 계약 앞(시안 A)',
    HTML.indexOf("if(c.mat) cells.push(`<span class=\"ocol omat\">") < HTML.indexOf('cells.push(`<span class="ocol octr">'));
  t('작업보드 상단 툴바(.gridbar)에 폴더 버튼 묶음', /\$\{_folBarHtml\(\)\}\s*\n\s*<output id="gselstat"/.test(HTML));
  // ★ .catch() 필수 — finally 가 DOM 을 건드리므로 거기서 throw 하면 처리되지 않은 rejection 이 된다.
  t('★ 탭을 열 때 지연조회 1회 + .catch()', /_folEnsureCur\(\)\.catch\(\(\)=>\{\}\);/.test(HTML));
  t('★ 지연조회는 kind=info 경로(무거운 stats=1 금지)',
    /tab-folders\?kind=info/.test(HTML) && !/_folEnsureCur[\s\S]{0,600}stats=1/.test(HTML));
  // ★ 성공한 재료가 있으면 재요청 없음 — 단 **실패는 다시 시도**한다(일시 장애로 버튼이 세션 내내
  //   죽어 있으면 사용자에게 되살릴 방법이 없다). 그래서 조기 반환 조건은 `_fol && !_fol.err`.
  t('★ 성공 재료 보유 시 조기 반환 · 실패는 재시도 허용',
    /if\(!t\|\|STATE\.role==='advertiser'\|\|t\.stats\|\|t\._folLoad\|\|\(t\._fol&&!t\._fol\.err\)\) return;/.test(HTML));
  t('★★ 실패한 _fol 이 나중에 도착한 stats 를 덮지 않는다(세션 내내 버튼이 죽던 경로)',
    /const f=\(t\._fol&&!t\._fol\.err\)\?t\._fol:\(t\.stats\|\|t\._fol\);/.test(HTML));
  t('★★ 배포 스큐 — kind 표식이 없는 응답은 info 로 믿지 않는다',
    /if\(r&&r\.kind!=='info'\) t\._fol=\{err:'서버 업데이트 대기/.test(HTML) && /kind: 'info'/.test(ROUTES));
  t('★ 도착 후에는 버튼 묶음만 갈아치운다(그리드 전체 재렌더 금지 — 편집 셀·검색 하이라이트 보존)',
    /const el=\$\('#folBar'\); if\(el&&STATE\.cur===t\) el\.innerHTML=_folBtnsInner/.test(HTML));
  t('★ 다른 작업으로 옮긴 뒤 도착한 응답은 반영하지 않는다(STATE.cur===t 확인)', /STATE\.cur===t/.test(HTML));
  // 폭 — 헤더·도구줄·표 섹션 세 곳이 같은 값(버튼이 데이터 오른쪽 끝에 붙는다는 레포 규칙)
  const caps = (HTML.match(/max-width:1560px/g) || []).length;
  t('★ 폭 상한 1560px 을 헤더·도구줄·표 섹션 세 곳에 같이(자료 열이 늘어난 만큼 넓힘)', caps === 3, 'count=' + caps);
  t('종전 1400px 상한은 남아 있지 않다(한 곳만 넓히면 버튼이 데이터 끝에서 어긋난다)',
    !/\.ovm-hd\{max-width:1400px\}/.test(HTML) && !/id="owntabsSect" style="max-width:1400px"/.test(HTML));
  t('큰 버튼 변형 CSS(.wbl-fol.folbig)', /\.wbl-fol\.folbig\{display:inline-flex/.test(HTML));
  t('자료 칸 CSS(.owntab .omat)', /\.owntab \.omat\{overflow:visible/.test(HTML));

  t('★ 광고주 렌즈 렌더러(_awFolderBtns)도 같은 URL 검증(_folUrlOk)을 태운다',
    /const b=\(url,cls,ic,label\)=> _folUrlOk\(url\)/.test(HTML));

  /* ═══ 6. 시안 문서와의 일치(문서↔제품 드리프트 가드) ═══ */
  console.log('\n6) 시안 문서 일치');
  t('시안 문서에 확정 기록(A안 · 기본 켬 · 3버튼 · 작업보드 상단 같이)', /2026-08-06[\s\S]{0,400}확정/.test(DOC));
  t('문서가 가르치는 라벨이 제품에 실제로 있다(구매·리뷰·현영)', /구매/.test(DOC) && /현영/.test(DOC));

  console.log(`\n✅ ${pass} 케이스 통과`);
}

run().then(() => process.exit(0)).catch(e => { console.error('\n❌', e.message); process.exit(1); });
