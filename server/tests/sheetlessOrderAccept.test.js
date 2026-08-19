/**
 * sheetlessOrderAccept.test.js — 탈 구글시트 W2-a 회귀가드
 * 실행: node tests/sheetlessOrderAccept.test.js
 *
 * 고정하는 것:
 *  A. 작업표 기록 매핑 — `mapOrderToSheetRow` **파생**(사본 금지) · 옵션 칸 blank-only
 *  B. 시트 없는 접수(F1) — 가상 ID 형식 · row_json · seq 자리 · 구글 무접촉
 *  C. 즉시 완결 — 작업표 UPDATE/INSERT 분기 · 장부 재생성 후에만 완결 표시
 *  D. 시트 쓰기 차단 4중 — 제출 · 수동제출 · 복구(reconcile) · 큐 실행부(fail-closed 백스톱)
 *  E. 시트 대조 경로 제외 — 사후검증 · 배치 스케줄러
 *  F. 폴더 1단 이름(D2-a) — 무시트만 업체명, 시트 기반은 **null**(기존 동작 바이트 불변)
 *  G. 접수 라우트 — 두 경로가 등록·상태전이 코드를 **공유**(사본 0) · 이관은 되돌리지 않는다
 *  H. 소스 위생 — 리터럴 제어문자 0(git 바이너리 취급 → grep 가드 무력화 방지)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const srv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** ★ 줄 주석만 걷어낸다 — 블록 주석 정규식은 이 레포의 정규식 리터럴을 물어 코드를 통째로 지운다(실측). */
const noLineComments = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const slOrder = require('../src/services/sheetlessOrder.service');
const slAccept = require('../src/services/sheetlessAccept.service');
const folderTitle = require('../src/services/folderTitle.service');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

/* ══════════════ A. 작업표 기록 매핑 ══════════════ */
console.log('\n[A] 주문 → 작업표 row_json (매퍼 파생 · 옵션 blank-only)');
{
  const HEADERS = ['번호', '구매일자', '수취인', '연락처', '주소', '은행', '계좌번호',
                   '예금주', '결제금액', '주문번호', '리뷰옵션', '옵션금액', '비고'];
  const ORDER = {
    orderer: '김주문', recipient: '김수취', phone: '010-1111-2222', address: '서울시 A로 1',
    bank: '국민', account: '123-456', depositor: '김주문', price: '22000',
    dateStr: '8 / 7 (금)', orderNum: 'ORD123', memo: '', selectedOptKey: '레드',
  };

  const { patch } = slOrder.buildRowPatch(HEADERS, ORDER, {});
  ok('수취인·연락처·주소 등 매퍼가 정한 칸에 들어간다',
    patch['수취인'] === '김수취' && patch['연락처'] === '010-1111-2222' && patch['주소'] === '서울시 A로 1');
  ok('구매일자는 제출값 그대로(063 시트 일정 인식이 읽는 형식)', patch['구매일자'] === '8 / 7 (금)');
  // ★★ 매퍼가 null 을 준 칸(번호=관리자 보호열)은 patch 에 들어가지 않는다 — 들어가면 번호가 지워진다
  ok('매퍼가 "쓰지 않음"이라 한 칸(번호)은 patch 에 없다', !('번호' in patch));
  // ★★ `옵션금액` 은 매퍼에서 **금액 규칙이 먼저 이겨** 결제금액 칸이다 — 옵션으로 오분류하면
  //   blank-only 필터가 금액 쓰기를 조용히 삭제한다(막으려던 것보다 큰 손실)
  ok('옵션금액 칸은 결제금액이다(옵션 오분류 금지)', patch['옵션금액'] === '22000');
  ok('빈 칸으로 지우는 쓰기를 만들지 않는다(비고는 빈 값이어도 매퍼 계약대로 실림)',
    typeof patch['비고'] === 'string');

  // 옵션 blank-only — 기존 작업지시('포토리뷰')를 덮지 않는다
  const cur = { 리뷰옵션: '포토리뷰' };
  const r2 = slOrder.buildRowPatch(HEADERS, ORDER, cur);
  ok('옵션 칸에 값이 있으면 덮지 않는다(blank-only)', !('리뷰옵션' in r2.patch));
  ok('보존한 사실을 돌려준다(조용한 누락 금지)',
    r2.optionSuppressed.length === 1 && r2.optionSuppressed[0].cur === '포토리뷰');
  const r3 = slOrder.buildRowPatch(HEADERS, ORDER, { 리뷰옵션: '   ' });
  ok('공백만 있는 옵션 칸은 빈 칸으로 본다(리뷰어 선택이 들어간다)', r3.patch['리뷰옵션'] === '레드');

  const src = noLineComments(srv('src/services/sheetlessOrder.service.js'));
  ok('매핑 규칙 사본 0 — orderLedger 의 매퍼를 그대로 쓴다',
    /mapOrderToSheetRow/.test(src) && /optionWriteColumns/.test(src));
  // ★ "호출"이 없어야 한다 — 설명 주석에는 이름이 나오므로 여는 괄호까지 본다
  ok('옵션 칸 판정에 optionColIndexes 를 호출하지 않는다(금액·비고 오분류 차단)',
    !/optionColIndexes\s*\(/.test(src));
  ok('구글 API 무접촉', !/sheets\.service|batchUpdateSheet|writeSheet|appendSheet|getSpreadsheetMeta/.test(src));
  ok('역동기화 서명을 남기지 않는다(시트 탐지가 이 주문을 건드리지 않게)',
    !/last_sheet_write_sig/.test(src));
}

/* ══════════════ F. 폴더 1단 이름(D2-a) ══════════════ */
console.log('\n[F] Drive 폴더 1단 = 무시트만 업체명 (시트 기반은 기존 동작 불변)');
(async () => {
  const stub = (row) => ({ query: async () => ({ rows: row ? [row] : [] }) });

  folderTitle.__setPoolForTest(stub({ sheetless: false, campaign_name: '시트제목', advertiser_name: '파미고' }));
  ok('시트 기반 탭은 null — 호출부가 기존 로직을 그대로 탄다(무회귀)',
    (await folderTitle.resolveSheetlessFolderTitle('S1', 'T1')) === null);

  folderTitle.__setPoolForTest(stub({ sheetless: true, campaign_name: '작업오더제목', advertiser_name: '파미고' }));
  ok('무시트 탭은 업체명 우선', (await folderTitle.resolveSheetlessFolderTitle('S1', 'T1')) === '파미고');

  folderTitle.__setPoolForTest(stub({ sheetless: true, campaign_name: '작업오더제목', advertiser_name: '' }));
  ok('업체 미지정이면 캠페인 이름', (await folderTitle.resolveSheetlessFolderTitle('S1', 'T1')) === '작업오더제목');

  folderTitle.__setPoolForTest(stub({ sheetless: true, campaign_name: '', advertiser_name: '' }));
  ok('둘 다 없으면 작업 이름', (await folderTitle.resolveSheetlessFolderTitle('S1', '7/21 파미고') ) === '7/21 파미고'.replace(/[\\/]/g, ' '));

  folderTitle.__setPoolForTest({ query: async () => { throw new Error('db down'); } });
  ok('조회 실패는 null(이름을 지어내지 않는다 — 엉뚱한 폴더 생성 차단)',
    (await folderTitle.resolveSheetlessFolderTitle('S1', 'T1')) === null);

  ok('폴더 이름에서 경로 구분자를 뺀다', folderTitle.sanitizeFolderName('a/b\\c') === 'a b c');

  const ft = noLineComments(srv('src/services/folderTitle.service.js'));
  ok('폴더 이름 해석에 구글 호출 0(무시트 탭은 404 다)',
    !/getSpreadsheetMeta\s*\(/.test(ft) && !/require\(['"][^'"]*sheets\.service/.test(ft));

  // 소비처 3곳이 같은 해석기를 쓴다 — 갈리면 같은 탭 캡처가 폴더 두 곳에 생긴다
  const rf = srv('src/services/reviewFolders.service.js');
  const dg = srv('src/routes/diag.routes.js');
  const re = srv('src/routes/reviewEdit.routes.js');
  ok('소비처 ① 폴더 사전생성(스마트빌드)', /resolveSheetlessFolderTitle/.test(rf));
  ok('소비처 ② 리뷰 캡처 업로드', /resolveSheetlessFolderTitle/.test(dg));
  ok('소비처 ③ 이미지 교체요청', /resolveSheetlessFolderTitle/.test(re));
  ok('업로드 경로는 무시트면 구글 메타 조회를 건너뛴다', /if \(sheetId && !_slTitle\)/.test(dg));

  /* ══════════════ B. 시트 없는 접수(F1) ══════════════ */
  console.log('\n[B] 시트 없는 접수 — 가상 탭 + 작업표');
  {
    /* ★★ 검사 의미 갱신(2026-08-19 실사고 — 작업바 11줄 중복): 가상 시트ID 는 **랜덤이 아니라
       작업오더 id 파생(결정적)** 이다. 랜덤이면 링크 기록(8단계) 전에 실패해 재시도할 때마다
       `ON CONFLICT (sheet_id, tab_name)` 이 안 걸려 탭이 하나씩 늘어난다. 랜덤 발급을 되살리면
       아래 두 단언이 깨진다. */
    const id = slAccept.virtualSheetIdForOrder('11111111-2222-3333-4444-555555555555');
    ok('가상 시트 ID 는 wt_ 접두 + 구글 ID 형식 길이(20자 이상)',
      /^wt_[0-9a-f]{20}$/.test(id) && /^[A-Za-z0-9_-]{20,}$/.test(id));
    ok('가상 gid 는 숫자 문자열(여러 곳이 /^\\d+$/ 를 요구)',
      /^\d+$/.test(slAccept.virtualGidForOrder('11111111-2222-3333-4444-555555555555')));
    ok('가상 ID 판별', slAccept.isVirtualSheetId(id) && !slAccept.isVirtualSheetId('1AbCdEfGhIjKlMnOpQrStUvWxYz'));
    ok('★ 같은 오더는 항상 같은 시트ID·gid (재시도 중복 차단)',
      slAccept.virtualSheetIdForOrder('11111111-2222-3333-4444-555555555555') === id
      && slAccept.virtualGidForOrder('11111111-2222-3333-4444-555555555555')
         === slAccept.virtualGidForOrder('11111111-2222-3333-4444-555555555555'));
    ok('★ 다른 오더는 다른 시트ID (오더끼리 섞이지 않는다)',
      slAccept.virtualSheetIdForOrder('99999999-2222-3333-4444-555555555555') !== id);
    ok('★ 오더 id 없이 발급하지 않는다(랜덤 폴백 금지)', (() => {
      try { slAccept.virtualSheetIdForOrder(''); return false; } catch (_) { return true; }
    })());
    ok('★ 랜덤 발급 함수는 남아 있지 않다',
      typeof slAccept.newVirtualSheetId === 'undefined' && typeof slAccept.newVirtualGid === 'undefined');

    const sa = noLineComments(srv('src/services/sheetlessAccept.service.js'));
    ok('접수 작업표 생성에 구글 API 호출 0',
      !/sheets\.service|copySpreadsheet|addSheet|writeSheet|renameSheet|getSpreadsheetMeta/.test(sa));
    ok('계획은 서버가 다시 계산한다(화면이 보낸 행 목록 불신)', /buildWorktablePlan\(/.test(sa));
    ok('막힌 계획은 만들지 않는다(미리보기 잠금과 같은 판정)', /plan\.canCreate/.test(sa));
    ok('값 생성은 시트 경로와 같은 함수(planToSheetValues) — 미리보기 ≠ 실제 표 방지',
      /planToSheetValues/.test(sa));
    ok('작업표 행 생성은 기존 함수 재사용(사본 금지)', /createSlotsFromSheetRows/.test(sa));
    ok('장부는 W1 생성기로(사본 금지)', /rebuildLedgers/.test(sa));
    ok('헤더 행 = 1 (덮을 템플릿 메타·공지문이 없다)', /const headerRow = 1;/.test(sa));
  }

  /* ══════════════ C. 즉시 완결 ══════════════ */
  console.log('\n[C] 무시트 주문 즉시 완결 (스텁 pool 실행)');
  {
    const HEADERS = ['번호', '구매일자', '수취인', '연락처', '리뷰옵션'];
    function makeStub({ exists = true, curRowJson = {} } = {}) {
      const log = { client: [], released: 0 };
      const client = {
        query: async (sql, params) => {
          log.client.push({ sql: String(sql).trim(), params });
          // ⚠ 컬럼 목록은 구현이 늘릴 수 있다(seq 추가 등) — 열 이름을 고정하면 가드가 조용히 빨개진다.
          if (/SELECT id,[\s\S]*?row_json FROM campaign_participants/.test(sql)) {
            return { rows: exists ? [{ id: 'p1', row_json: curRowJson }] : [] };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => { log.released++; },
      };
      const db = { query: async () => ({ rows: [], rowCount: 1 }), connect: async () => client };
      return { db, log };
    }

    // loadRawTabContext / markOrderWritten / recordReviewIdentity 는 orderLedger 의 pool 을 탄다
    const ledgerSvc = require('../src/services/orderLedger.service');
    const origLoad = ledgerSvc.loadRawTabContext;
    const origWritten = ledgerSvc.markOrderWritten;
    const origIdent = ledgerSvc.recordReviewIdentity;
    const calls = { written: 0, rebuild: 0, ident: 0 };
    ledgerSvc.loadRawTabContext = async () => ({ headers: HEADERS, dataRows: [], headerRowIndex: 1, tabGid: '77' });
    ledgerSvc.markOrderWritten = async () => { calls.written++; };
    ledgerSvc.recordReviewIdentity = async () => { calls.ident++; };

    const ledgerMod = require('../src/services/sheetlessLedger.service');
    const origRebuild = ledgerMod.rebuildLedgers;
    ledgerMod.rebuildLedgers = async () => { calls.rebuild++; return { mirrorRows: 3, indexRows: 1 }; };
    const partMod = require('../src/services/participation.service');
    const origLink = partMod.recordParticipationLink;
    partMod.recordParticipationLink = async () => {};

    {
      const { db, log } = makeStub({ exists: true, curRowJson: { 번호: '1', 리뷰옵션: '포토리뷰' } });
      slOrder.__setPoolForTest(db);
      const r = await slOrder.writeOrderToWorktable({
        sheetId: 'wt_x', tabName: 'T1', tabGid: '77', sheetRow: 2,
        orderData: { recipient: '김수취', phone: '010-1234-5678', selectedOptKey: '레드' },
        orderSubmissionId: 'os-1', loginPhone8: '12345678', loginName: '김로그인',
      });
      const sqls = log.client.map(c => c.sql);
      ok('완결 반환(ok/written)', r.ok === true && r.written === true);
      ok('행 잠금 후 갱신(FOR UPDATE → UPDATE)',
        sqls.some(s => /FOR UPDATE/.test(s)) && sqls.some(s => /UPDATE campaign_participants/.test(s)));
      ok('트랜잭션으로 감싼다', sqls[0] === 'BEGIN' && sqls.includes('COMMIT'));
      ok('커넥션 반납', log.released === 1);
      ok('장부를 다시 만든다(검색·리뷰내역이 즉시 따라오게)', calls.rebuild === 1);
      ok('완결 표시는 장부 재생성 뒤', calls.written === 1);
      ok('신원 링크는 기록 성공 후에만(낙관적 선기입 금지)', calls.ident === 1);
      ok('기존 옵션 값은 보존됐다고 보고한다', r.optionSuppressed.length === 1);
      const upd = log.client.find(c => /UPDATE campaign_participants/.test(c.sql));
      ok('작업보드 표에 뜨도록 이름·연락처도 채운다(표가 비지 않게)',
        upd.params.includes('김로그인') && upd.params.includes('12345678'));
      ok('빈 값으로 기존 이름을 덮지 않는다(COALESCE(NULLIF))', /COALESCE\(NULLIF\(\$5,''\)/.test(upd.sql));
    }
    {
      const { db, log } = makeStub({ exists: false });
      slOrder.__setPoolForTest(db);
      const r = await slOrder.writeOrderToWorktable({
        sheetId: 'wt_x', tabName: 'T1', tabGid: '77', sheetRow: 99,
        orderData: { recipient: '나중', phone: '010-0000-1111' }, orderSubmissionId: 'os-2',
      });
      const ins = log.client.find(c => /INSERT INTO campaign_participants/.test(c.sql));
      ok('표 끝을 넘어 배정되면 그 자리에 줄을 만든다', r.ok === true && !!ins);
      ok("새 줄 source='worktable' (상태 칸이 켜지는 값 — 'manual' 금지)", /'worktable'/.test(ins.sql));
      ok('이미 있으면 덮지 않는다(ON CONFLICT DO NOTHING)', /ON CONFLICT .*DO NOTHING/.test(ins.sql));
    }
    {
      // 장부 재생성 실패 = 완결로 찍지 않는다(표엔 있는데 검색은 안 되는 상태 차단)
      ledgerMod.rebuildLedgers = async () => { throw new Error('boom'); };
      const before = calls.written, beforeIdent = calls.ident;
      const { db } = makeStub({ exists: true });
      slOrder.__setPoolForTest(db);
      const r = await slOrder.writeOrderToWorktable({
        sheetId: 'wt_x', tabName: 'T1', sheetRow: 2, orderData: {}, orderSubmissionId: 'os-3',
      });
      ok('장부 재생성 실패 = 미완결 반환', r.ok === false && r.reason === 'ledger_failed');
      ok('장부 재생성 실패 시 완결 표시하지 않는다', calls.written === before);
      // ★★ 신원 링크(시트행↔phone8)는 **끝까지 성공했을 때만** — 중간 실패에 남기면 재배정 후
      //   그 행이 옛 주인에게도 열리는 교차노출이 된다(레포가 이미 겪은 사고).
      ok('장부 재생성 실패 시 신원 링크도 남기지 않는다', calls.ident === beforeIdent);
    }
    {
      // 열 구성을 모르면 아무 칸에도 못 쓴다 — 조용히 완결시키지 않는다
      ledgerSvc.loadRawTabContext = async () => ({ headers: [], dataRows: [], tabGid: '' });
      const { db, log } = makeStub({});
      slOrder.__setPoolForTest(db);
      const r = await slOrder.writeOrderToWorktable({
        sheetId: 'wt_x', tabName: 'T1', sheetRow: 2, orderData: {}, orderSubmissionId: 'os-4' });
      ok('열 구성 불명 = 미완결(no_headers)', r.ok === false && r.reason === 'no_headers');
      ok('열 구성 불명이면 쓰기 트랜잭션도 열지 않는다', log.client.length === 0);
    }

    ledgerSvc.loadRawTabContext = origLoad;
    ledgerSvc.markOrderWritten = origWritten;
    ledgerSvc.recordReviewIdentity = origIdent;
    ledgerMod.rebuildLedgers = origRebuild;
    partMod.recordParticipationLink = origLink;
  }

  /* ══════════════ D. 시트 쓰기 차단 4중 ══════════════ */
  console.log('\n[D] 무시트 탭에 구글 쓰기가 가지 않는다 (4중 방어)');
  {
    const sub = noLineComments(srv('src/routes/submit.routes.js'));
    const man = noLineComments(srv('src/services/manualOrder.service.js'));
    const sq = noLineComments(srv('src/services/syncQueue.service.js'));
    const ol = noLineComments(srv('src/services/orderLedger.service.js'));

    ok('① 리뷰어 제출: 무시트면 큐 미경유', /isSheetless\(/.test(sub) && /writeOrderToWorktable\(/.test(sub));
    ok('① 제출은 sheetlessDone 이면 enqueue 하지 않는다', /if \(ledger\.sheetRow && !sheetlessDone\)/.test(sub));
    ok('② 외부모집 수동제출도 같은 분기', /isSheetless\(/.test(man) && /writeOrderToWorktable\(/.test(man));
    ok('② 수동제출도 sheetlessDone 이면 enqueue 하지 않는다', /if \(ledger\.sheetRow && !sheetlessDone\)/.test(man));
    // ★★ 백스톱이 핵심 — 이관 전에 쌓여 있던 큐·새 호출부·판정 실패분이 여기서 막힌다
    ok('③ 큐 실행부 백스톱: 쓰기 직전 다시 판정', /isSheetless\(pool, sheetId, tabName\)/.test(sq));
    // ★ 위치가 곧 방어다 — 시트를 **읽기 전에** 막아야 한다. 함수 본문 안에서 순서를 본다
    //   (파일 전체 indexOf 는 `_readGuardWindow` 의 *정의*를 먼저 집어 항상 통과한다).
    const exec = sq.slice(sq.indexOf('async function _executeBatch'));
    ok('③ 백스톱은 배치 시작 직후 = 가드 읽기·시트 쓰기 **앞**',
      exec.indexOf('무시트 탭 시트쓰기 차단') >= 0 &&
      exec.indexOf('무시트 탭 시트쓰기 차단') < exec.indexOf('await _readGuardWindow(') &&
      exec.indexOf('무시트 탭 시트쓰기 차단') < exec.indexOf('batchUpdateSheet('));
    ok('③ 큐 항목은 버리지 않고 done + 사유(무신호 금지)', /sheetless tab — 시트 쓰기 생략/.test(sq));
    ok('④ 복구(reconcile)도 큐 대신 작업표 재기록', /isSheetlessTab\(_slKeys/.test(ol) && /writeOrderToWorktable\(/.test(ol));
    // ★ 목록에서 통째로 빼면 그 주문은 영영 복구되지 않는다 → 대체 경로가 있어야 한다
    ok('④ 복구 결과를 요약에 싣는다(sheetlessWritten)', /sheetlessWritten/.test(ol));

    /* ★★ ⑤ 리뷰제출 표시(POST /api/submit/review)의 백그라운드 시트 쓰기.
       프로덕션 E2E 로 실측한 구멍 — 큐 백스톱(③)이 시트 쓰기 자체는 막지만, 그 **앞의**
       `getCachedHeaders` 가 가상 시트로 구글을 불러 404 + warn 오류로그 + 무의미한 큐 항목이
       제출 1건마다 쌓였다. 게이트는 `setImmediate` 본문 **맨 앞**이라야 한다(읽기 전에 막는다).
       ★ 부분 제출(complete=false)은 markStatusCell 을 안 타므로 `st.handled` 재활용은 불가 —
         별도 판정이어야 그 갈래도 막힌다. */
    const bg = sub.slice(sub.indexOf("[submit/review:bg]") - 3000);
    const gateAt = bg.indexOf('무시트 탭 — 시트 쓰기 생략');
    ok('⑤ 리뷰제출 표시 백그라운드도 무시트면 시트 쓰기 생략', gateAt >= 0);
    ok('⑤ 그 게이트는 헤더 읽기·writeSheet **앞**(구글 호출 0)',
      gateAt >= 0 && gateAt < bg.indexOf('getCachedHeaders(') && gateAt < bg.indexOf('writeSheet('));
    ok('⑤ 판정 실패는 fail-open(시트 기반 탭이 절대 다수)',
      /isSheetless\(pool, sheetId, tabName\)[\s\S]{0,400}catch \(_\) \{ \/\* fail-open \*\/ \}/.test(sub));
  }

  /* ══════════════ E. 시트 대조 경로 제외 ══════════════ */
  console.log('\n[E] 시트를 읽어 대조하는 경로에서 제외');
  {
    const wv = noLineComments(srv('src/services/writtenVerify.service.js'));
    const bs = noLineComments(srv('src/jobs/orderBatchScheduler.js'));
    const slSql = /COALESCE\(tc\.sheetless, FALSE\) = TRUE/;
    ok('사후검증 대상에서 무시트 탭 제외(정상 주문 오판 → 구글 쓰기 전이 차단)',
      slSql.test(wv) && /NOT EXISTS \(\s*SELECT 1 FROM tab_configs tc/.test(wv));
    ok('시트 반영 배치 스케줄러도 무시트 탭 제외', slSql.test(bs));
    // ★★ 새 종결 상태를 만들지 않았다 — 'written' 이 이미 종결이고 소비처가 여럿이다
    const so = noLineComments(srv('src/services/sheetlessOrder.service.js'));
    ok("종결 상태는 기존 'written' 그대로(새 상태 미도입 — 소비처 스윕 불필요)",
      /markOrderWritten/.test(so) && !/mirror_status\s*=\s*'sheetless'/.test(so));
  }

  /* ══════════════ G. 접수 라우트 ══════════════ */
  console.log('\n[G] 접수 — 두 경로가 등록 코드를 공유');
  {
    const or = srv('src/routes/order.routes.js');
    const orN = noLineComments(or);
    // ★★ 판정은 서비스 단일 출처(`resolveAcceptMode`) — 라우트에 인라인 판정식 사본이 없어야 한다.
    //   (사본을 두면 "화면·서버가 서로 다른 경로로 접수"가 조용히 생긴다)
    ok('라우트는 판정 단일 출처를 호출한다(인라인 판정 사본 0)',
      /const acceptMode = resolveAcceptMode\(\{ workOrder: o, body: req\.body \}\);/.test(orN) &&
      /const wantSheetless = acceptMode\.sheetless;/.test(orN) &&
      !/\(req\.body \|\| \{\}\)\.sheetless === true/.test(orN));
    // ★★ 판정 실행 — 3버전은 URL 유무·요청 플래그와 무관하게 무시트 전용이다.
    {
      const m = (wo, body) => slAccept.resolveAcceptMode({ workOrder: wo, body });
      ok('시트URL 없음 = 무시트 접수',
        m({}, {}).sheetless === true && m({}, {}).reason === 'v3_sheetless_only');
      ok('시트URL이 있어도 무시트 접수',
        m({ work_sheet_url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1' }, {}).sheetless === true);
      ok('body.sheetless=false로도 시트 원본을 요청할 수 없다',
        m({ work_sheet_url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1' }, { sheetless: false }).sheetless === true);
      ok('이미 무시트인 오더는 그대로 유지한다',
        m({ linked_tab_sheet_id: slAccept.VIRTUAL_SHEET_PREFIX + 'deadbeef' }, {}).reason === 'already_sheetless');
    }
    ok('무시트 경로는 구글 메타를 조회하지 않는다',
      orN.indexOf('createSheetlessWorktable') < orN.indexOf('await getSpreadsheetMeta') &&
      /if \(wantSheetless\) \{/.test(orN));
    // ★★ 사본 0 — campaigns/tab_configs 업서트와 상태 전이는 한 번만 존재해야 한다
    ok('campaigns 업서트는 한 곳뿐', (orN.match(/INSERT INTO campaigns \(sheet_id, campaign_name, sheet_url\)/g) || []).length === 1);
    ok('tab_configs 업서트도 한 곳뿐', (orN.match(/INSERT INTO tab_configs/g) || []).length === 1);
    ok('접수의 상태 전이·탭 링크 기록도 한 곳뿐',
      (orN.match(/UPDATE work_orders SET\s*\n\s*status = \$2,\s*\n\s*linked_tab_sheet_id = \$3/g) || []).length === 1);
    // ⚠ 099(체험단 종류)에서 업서트 컬럼 목록에 work_kind($14)가 합류해 패턴이 드리프트했다 —
    //   검사 의미는 불변(무시트 표식이 컬럼·자리표시자·파라미터에 맞물려 실린다).
    ok('무시트 표식을 등록 컬럼에 싣는다(열·자리·파라미터가 맞물린다)',
      /taekhap, sheetless, work_kind, updated_at\)/.test(orN) &&
      /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$13,\$14, NOW\(\)\)/.test(orN) &&
      /wantSheetless,/.test(orN));
    // ★★ 이관은 되돌리지 않는다 — 시트 URL 재접수로 조용히 시트 기반이 되면 크론이 장부를 덮는다
    ok('이관 되돌림 금지(OR 병합)', /sheetless\s*=\s*COALESCE\(tab_configs\.sheetless, FALSE\) OR EXCLUDED\.sheetless/.test(orN));
    ok('무시트 탭의 sheet_url 은 빈 값(죽은 구글 링크 금지)', /wantSheetless \? '' :/.test(orN));
    ok('무시트는 시트 빌드·RAW 미러 대신 장부 생성기', /sheetlessPlan\.persist\(\)/.test(orN));
    ok('장부 생성 실패를 응답으로 알린다(조용한 누락 금지)', /worktable: wantSheetless \?/.test(orN));
    ok('재접수는 새 작업표를 또 만들지 않는다', /isVirtualSheetId\(priorSheetId\)/.test(orN));
    ok('★ 링크 기록 전 실패 잔재도 흡수한다(오더 파생 시트ID lookup)',
      /virtualSheetIdForOrder\(o\.id\)/.test(orN)
      && /FROM tab_configs WHERE sheet_id = \$1/.test(orN)
      && /priorOwn && priorOwn\.tab_name/.test(orN)
      // ⚠ 변이시험이 잡은 구멍: SQL·조건문 문자열만 보면 `priorOwn = null` 로 무력화해도 통과한다
      //   → **조회 결과를 실제로 대입하는 형태**까지 고정한다.
      && /priorOwn = pr\[0\] \|\| null;/.test(orN));
    ok('★ 잔재 흡수 시에도 그 탭 이름으로 작업표를 채운다(명단 0 방치 금지)',
      /tabName: \(priorOwn && priorOwn\.tab_name\) \|\|/.test(orN));
    ok('★ 접수 경로에 랜덤 시트ID 발급이 없다', !/newVirtualSheetId|newVirtualGid/.test(orN));

    // 라우터 스택 실검사 — 게이트가 실제로 걸려 있는지
    const router = require('../src/routes/order.routes');
    const layer = router.stack.find(l => l.route && l.route.path === '/admin/accept');
    ok('POST /admin/accept 존재', !!layer && !!layer.route.methods.post);
    const names = layer.route.stack.map(s => s.handle.name);
    ok('접수는 여전히 adminOrMaster 게이트 뒤', names.some(n => /adminOrMaster/i.test(n)));
    ok('authMiddleware 가 역할 미들웨어 앞', names.findIndex(n => /^auth/i.test(n)) < names.findIndex(n => /adminOrMaster/i.test(n)));
  }

  /* ══════════════ H. 소스 위생 ══════════════ */
  console.log('\n[H] 소스 위생');
  {
    for (const p of ['src/services/sheetlessOrder.service.js',
                     'src/services/sheetlessAccept.service.js',
                     'src/services/folderTitle.service.js']) {
      const buf = fs.readFileSync(path.join(__dirname, '..', p));
      const ctl = [...buf].filter(c => c < 32 && c !== 9 && c !== 10 && c !== 13).length;
      ok(`리터럴 제어문자 0 — ${p.split('/').pop()}`, ctl === 0);
    }
    const led = noLineComments(srv('src/services/sheetlessLedger.service.js'));
    ok('장부 재생성은 탭 단위로 직렬화(검색 명단이 잠깐 비는 창 차단)',
      /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(led));
  }

  console.log(`\n총 ${passed}개 통과\n`);
  process.exit(0);
})();
