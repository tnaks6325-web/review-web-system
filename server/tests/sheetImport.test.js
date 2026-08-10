/**
 * sheetImport.test.js — 회귀가드: 구글시트 주소로 작업 가져오기
 * 실행: node tests/sheetImport.test.js
 *
 * 배경(실측 2026-08-10 · 0720수진코리아 고양이캔 4종): 시트에는 108명이 적혀 있고 맨 윗줄에
 *   "리뷰웹시스템으로 이관되었습니다"가 붙어 있는데 시스템에는 그 작업이 없었다. 이 기능은
 *   그런 시트를 **주소 한 줄로** 흡수한다(등록 + 업체 소유 + 표 + 장부 + 무시트 표식).
 *
 * 고정하는 것:
 *  A. 주소 해석 — gid 위치가 어디든 읽고, 알아볼 수 없으면 null(추측 금지)
 *  B. 줄 판정 — 번호 없는 줄도 가져오고, 연습 줄은 **체크만 해제**(버리지 않는다)
 *  C. 판정 사본 0 — 헤더·역할·명단 수를 이 파일이 새로 구현하지 않았다
 *  D. 미리보기 — DB **쓰기 0** · 연락처 칸 없으면 fail-closed · 이미 등록된 탭 차단(D5)
 *  E. 실행 — 업체 필수(D3) · sheetless 즉시 ON(D1) · 되돌리지 않는 OR 업서트 · blank-only
 *  F. 실행 — 줄 생성은 participants 위임(seq=시트 행번호·source=worktable) · 장부는 rebuildLedgers
 *  G. 되돌리기(D6) — 주문이 들어왔으면 거부 · 등록까지 함께 내린다
 *  H. 라우트 — 3경로 adminOrMaster · 화면 배선
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readFront = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const stripBlock = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

/* ── 스텁 pool ─────────────────────────────────────────────── */
function makePool(shapes) {
  const calls = [];
  const client = {
    query: async (sql, params) => { calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return _match(shapes, sql, params); },
    release: () => {},
  };
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return _match(shapes, sql, params); },
    connect: async () => client,
  };
}
function _match(shapes, sql, params) {
  for (const [re, res] of shapes) if (re.test(sql)) return typeof res === 'function' ? res(params) : res;
  return { rows: [], rowCount: 0 };
}
const writeRe = /\b(INSERT INTO|UPDATE|DELETE FROM)\b/i;
const writes = pool => pool.calls.filter(c => writeRe.test(c.sql));

const S = require('../src/services/sheetImport.service');

/* ── 실측 시트 표본(개인정보는 가명) ────────────────────────────
   상단 안내 8줄 → 9번째 줄이 열 이름 → 데이터. 번호 없는 줄과 연습 줄을 함께 담았다. */
const HEADERS = ['번호','담당자','구매일자','차수','옵션','인애드명단','주문자제출','수취인','쿠팡id',
                 '연락처','주소','은행','계좌번호','예금주','결제금액','리뷰제출','입금','주문번호','비고(닉네임 등 자유)'];
const TOP = [
  ['캠페인명','0720수진코리아 맛있는 고양이캔 4종'],
  ['구매시간대','자유','https://www.coupang.com/vp/products/9624495419'],
  ['배송유형'], ['마감자료URL'], ['상품링크1'],
  ['미지정(자유입력하세요)'], ['미지정(자유입력하세요)'], ['미지정(자유입력하세요)'],
];
const row = (n, name, phone, extra) => {
  const r = new Array(HEADERS.length).fill('');
  r[0] = n; r[2] = '7 / 20 (월)'; r[3] = '1차'; r[7] = name; r[9] = phone; r[14] = '15,740';
  if (extra) Object.assign(r, extra);
  return r;
};
const VALUES = TOP.concat([HEADERS,
  row('1', '김설', '010-8745-1958', { 15: '7/23 17:30', 16: '7/27' }),
  row('2', '박순희', '010-6405-9006', { 15: '7/25 15:20', 16: '7/27' }),
  row('',  '노대송', '010-2356-2884', { 15: '7/30 11:34', 16: '8/7' }),   // ★ 번호 없는 실제 진행 건
  row('',  'ㅇ', '010-5134-5326', { 14: '4' }),                            // ★ 연습으로 보이는 줄
  new Array(HEADERS.length).fill(''),                                       // 빈 줄
]);
const HEADER_ROW = 9;   // 1-based

console.log('\n[A] 주소 해석 — 순수함수');
{
  const c = (u) => S.parseSheetUrl(u);
  ok('★ 탭 주소(gid 프래그먼트)에서 시트ID·gid 를 읽는다',
    c('https://docs.google.com/spreadsheets/d/1yhRDfnxc3xbL-QuhxF7vPOPzfXk9rGze2tdCuNU9h-M/edit?gid=1405976532#gid=1405976532')
      .sheetId === '1yhRDfnxc3xbL-QuhxF7vPOPzfXk9rGze2tdCuNU9h-M');
  ok('gid 는 #gid= / ?gid= 어디에 있어도 읽는다',
    c('https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=7').gid === '7' &&
    c('https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit?gid=9').gid === '9');
  ok('gid 가 없으면 null — 0 으로 접지 않는다(첫 탭을 임의로 고르면 엉뚱한 탭을 가져온다)',
    c('https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit').gid === null);
  ok('시트ID 단독 붙여넣기도 받는다', c('AAAAAAAAAAAAAAAAAAAAAA').sheetId === 'AAAAAAAAAAAAAAAAAAAAAA');
  ok('★ 알아볼 수 없으면 null — 추측하지 않는다', c('아무거나').sheetId === null && c('').sheetId === null);
}

console.log('\n[B] 줄 판정 — 이 파일이 새로 만드는 유일한 판정');
{
  const cls = S.classifyImportRows({ headers: HEADERS, values: VALUES, headerRow: HEADER_ROW, nameIdx: 7, phoneIdx: 9 });
  const bySeq = (n) => cls.rows.find(r => r.seq === n);
  ok('seq 는 **시트 실제 행 번호** (헤더 9줄 → 첫 데이터 10)', bySeq(10) && bySeq(10).name === '김설',
    JSON.stringify(cls.rows.map(r => r.seq)));
  ok('★★ 번호가 없어도 내용이 있으면 가져온다(실측 8줄이 이 경우)',
    bySeq(12) && bySeq(12).name === '노대송' && bySeq(12).include === true);
  ok('★★ 연습으로 보이는 줄은 **체크만 해제**하고 목록에는 남긴다(버리지 않는다)',
    bySeq(13) && bySeq(13).include === false && /한 글자/.test(bySeq(13).why || ''));
  ok('빈 줄은 자리만 만든다(blank)', (bySeq(14) || {}).blank === true);
  ok('row_json 은 헤더명 → 값 (그리드가 그대로 그린다)',
    bySeq(10).rowJson['수취인'] === '김설' && bySeq(10).rowJson['연락처'] === '010-8745-1958' &&
    bySeq(10).rowJson['리뷰제출'] === '7/23 17:30');
  ok('빈 칸은 row_json 에 넣지 않는다(빈 값으로 남의 값을 덮지 않기 위해)',
    !('담당자' in bySeq(10).rowJson));
  ok('phone8 = 연락처 뒤 8자리', bySeq(10).phone8 === '87451958');
  ok('counts 가 이름·연습·빈 줄을 따로 센다',
    cls.counts.named === 4 && cls.counts.suspect === 1 && cls.counts.blank === 1, JSON.stringify(cls.counts));

  /* ★ 판정을 넓히면 멀쩡한 참여자가 기본 제외된다 — 좁게 유지되는지 고정 */
  const wide = S.classifyImportRows({
    headers: HEADERS, values: TOP.concat([HEADERS, row('5', '이수진', '010-7737-9704')]),
    headerRow: HEADER_ROW, nameIdx: 7, phoneIdx: 9,
  });
  ok('★ 정상 줄은 반드시 include (연습 판정이 넓어지면 조용한 누락이 된다)',
    wide.rows.every(r => r.blank || r.include === true));
}

console.log('\n[B-2] 시트 위쪽 안내 읽기');
{
  const m = S.readTopMeta(VALUES, HEADER_ROW);
  ok('캠페인명을 읽는다', m.campaignName === '0720수진코리아 맛있는 고양이캔 4종');
  ok('상품 주소를 읽는다', /coupang\.com/.test(m.productUrl));
  ok('★ 헤더 줄 아래는 보지 않는다(데이터가 안내로 오인되지 않게)',
    S.readTopMeta([['캠페인명','X']].concat([HEADERS]).concat([row('1','김설','010-1111-2222')]), 2).campaignName === 'X');
  ok('★ 못 찾으면 빈 값 — 추측하지 않는다', S.readTopMeta([[], []], 3).campaignName === '');
}

console.log('\n[C] 판정 사본 0 — 남의 판정을 여기서 다시 만들지 않았다');
{
  const src = stripBlock(noLineComments(read('src/services/sheetImport.service.js')));
  ok('★ 헤더 탐지는 utils/sheetHeader 재사용', /require\('\.\.\/utils\/sheetHeader'\)/.test(read('src/services/sheetImport.service.js')));
  ok('★ 열 역할은 worktableTemplate.classifyHeaders 재사용', /classifyHeaders\(/.test(src));
  ok('★★ 헤더 키워드 표 사본 없음(그 표가 갈리면 이 경로만 다른 열을 고른다)',
    !/HEADER_DETECT_KEYWORDS\s*=/.test(src) && !/NAME_KEYWORDS\s*=/.test(src));
  ok('★★ 명단 수는 파서(indexBuilder.parseTabRows)에게 묻는다 — 여기서 세지 않는다',
    /parseTabRows\(/.test(src));
  ok('★ 날짜 파서 사본 없음(구매일자 해석은 이 기능의 일이 아니다)',
    !/parseDateColumn|parseDateToken/.test(src));
  ok('★★ 쓰기 소유자 — 이 파일은 campaign_participants 에 직접 쓰지 않는다(생성도 삭제도 participants 위임)',
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+campaign_participants/i.test(src));
  ok('★ 장부는 rebuildLedgers 위임 — review_index 에 직접 INSERT 하지 않는다',
    !/INSERT INTO review_index/i.test(src));
}

console.log('\n[C-2] 되돌리기 삭제는 주문 붙은 줄을 남긴다 — 실제 함수 실행');
{
  /* ★★ 이 검사는 **실제 participants 함수**를 돌린다. 호출부 테스트는 스텁이 대신 응답하므로
     "SQL 에서 조건이 사라진" 회귀를 통과시킨다(변이시험이 실제로 잡았다). */
  const P = require('../src/services/participants.service');
  const seen = [];
  const client = { query: async (sql, params) => { seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return { rowCount: 7 }; } };
  (async () => {
    const n = await P.purgeImportedRows(client, { sheetId: 'S', tabName: 'T' });
    ok('삭제한 줄 수를 그대로 돌려준다', n === 7);
    ok('★★ 주문이 붙은 줄(order_submission_id)은 절대 지우지 않는다 — 마지막 방어',
      /order_submission_id IS NULL/i.test(seen[0].sql), seen[0].sql);
    ok('★ 그 탭에만 건다(시트·탭 조건)', /sheet_id = \$1 AND tab_name = \$2/i.test(seen[0].sql));
    let bad = null;
    try { await P.purgeImportedRows(null, { sheetId: 'S', tabName: 'T' }); } catch (e) { bad = e; }
    ok('★ client 없이 부르면 거부(별도 트랜잭션으로 새 나가지 않게)', !!bad);
  })().catch(e => { console.error(e); process.exit(1); });
}

console.log('\n[D] 미리보기 — 쓰기 0 · fail-closed');
{
  const stubRead = (values, tabName) => ({
    sheetTitle: '수진코리아 진행시트', tabName, gid: '1405976532', values,
    availableTabs: [{ gid: '1405976532', tabName, hidden: false }],
  });
  const origReq = require;

  // 시트 읽기·파서를 갈아끼우기 위해 모듈 캐시를 건드리지 않고 서비스의 내부 require 를 그대로 두되,
  // sheets.service / indexBuilder 를 스텁으로 대체한다.
  const sheetsPath = require.resolve('../src/services/sheets.service');
  const ibPath = require.resolve('../src/services/indexBuilder.service');
  const cmPath = require.resolve('../src/services/columnMapping.service');
  const thrPath = require.resolve('../src/utils/sheetsThrottle');
  const save = { s: require.cache[sheetsPath], i: require.cache[ibPath], c: require.cache[cmPath], t: require.cache[thrPath] };

  const install = (values, tabName) => {
    require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: {
      getSpreadsheetMeta: async () => {
        const arr = [{ properties: { sheetId: 1405976532, title: tabName, hidden: false } }];
        arr._spreadsheetTitle = '수진코리아 진행시트';
        return arr;
      },
      batchReadSheet: async () => [{ values }],
    } };
    require.cache[thrPath] = { id: thrPath, filename: thrPath, loaded: true, exports: {
      throttledCall: (fn) => fn(), driveThrottledCall: (fn) => fn(),
    } };
    require.cache[ibPath] = { id: ibPath, filename: ibPath, loaded: true, exports: {
      loadKeywordsFromDB: async () => {},
      parseTabRows: () => ([
        { name: '김설', isSubmitted: true, submitCol: '리뷰제출', submitCol2: '입금' },
        { name: '박순희', isSubmitted: true, submitCol: '리뷰제출', submitCol2: '입금' },
        { name: '노대송', isSubmitted: false, submitCol: '리뷰제출', submitCol2: '입금' },
        { name: 'ㅇ', isSubmitted: false, submitCol: '리뷰제출', submitCol2: '입금' },
      ]),
    } };
    require.cache[cmPath] = { id: cmPath, filename: cmPath, loaded: true, exports: {
      getTabColumnIndexMap: async () => null,
    } };
  };
  const restore = () => {
    if (save.s) require.cache[sheetsPath] = save.s; else delete require.cache[sheetsPath];
    if (save.i) require.cache[ibPath] = save.i; else delete require.cache[ibPath];
    if (save.c) require.cache[cmPath] = save.c; else delete require.cache[cmPath];
    if (save.t) require.cache[thrPath] = save.t; else delete require.cache[thrPath];
  };

  (async () => {
    install(VALUES, '0720고양이캔4종');
    const pool = makePool([[/FROM tab_configs/i, { rows: [] }]]);
    S.__setPoolForTest(pool);
    const pv = await S.previewSheetImport({ url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1405976532' });

    ok('★★ 미리보기는 DB 쓰기 0', writes(pool).length === 0, JSON.stringify(writes(pool).map(w => w.sql.slice(0, 40))));
    ok('머리글 줄을 찾는다(9번째 줄)', pv.headerRow === HEADER_ROW, String(pv.headerRow));
    ok('막는 것이 없으면 ok', pv.ok === true && (pv.blockers || []).length === 0, JSON.stringify(pv.blockers));
    ok('연락처·이름 칸을 표시한다', pv.columns.some(c => c.isPhone && c.header === '연락처') &&
      pv.columns.some(c => c.isName && c.header === '수취인'));
    ok('★ 상태 칸은 파서가 고른 열 이름으로 표시된다(탭 설정이 아직 없으므로)',
      pv.columns.some(c => c.header === '리뷰제출' && c.role === 'submit') &&
      pv.columns.some(c => c.header === '입금' && c.role === 'paid'));
    ok('★★ 검색 명단 수는 파서 결과를 그대로 싣는다(우리가 센 수와 따로 보여준다)',
      pv.counts.index === 4 && pv.counts.submitted === 2, JSON.stringify(pv.counts));
    ok('연습 줄은 표본에 포함되어 사람이 판단할 수 있다',
      (pv.rows || []).some(r => r.include === false && /한 글자/.test(r.why || '')));
    /* ★★ 표에 보여줄 값은 서버가 **역할 인덱스로** 골라 싣는다 — 화면이 열 이름으로 꺼내면
       이름이 다른 탭에서 그 열이 통째로 빈 칸이 된다. */
    const r10 = (pv.rows || []).find(r => r.seq === 10) || {};
    ok('★★ 구매일자·금액·제출·입금을 서버가 골라 싣는다(화면이 열 이름을 찍지 않게)',
      r10.date === '7 / 20 (월)' && r10.price === '15,740' && r10.submit === '7/23 17:30' && r10.paid === '7/27',
      JSON.stringify(r10));
    ok('시트 위쪽 안내에서 작업 이름을 채운다', pv.meta.campaignName === '0720수진코리아 맛있는 고양이캔 4종');

    // 연락처 칸 없음 → fail-closed
    const noPhoneHeaders = HEADERS.map(h => (h === '연락처' ? '비고2' : h));
    const noPhoneValues = TOP.concat([noPhoneHeaders, row('1', '김설', '010-1111-2222')]);
    install(noPhoneValues, 'X');
    S.__setPoolForTest(makePool([[/FROM tab_configs/i, { rows: [] }]]));
    const pv2 = await S.previewSheetImport({ url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1405976532' });
    ok('★★ 연락처 칸이 없으면 막는다(리뷰어가 영영 못 찾는 명단이 된다)',
      pv2.ok === false && (pv2.blockers || []).some(b => b.code === 'no_phone_column'));

    // 이미 등록된 탭 → D5 차단
    install(VALUES, '0720고양이캔4종');
    S.__setPoolForTest(makePool([[/FROM tab_configs/i, { rows: [{ tab_name: '0720고양이캔4종', tab_gid: '1405976532', sheetless: true, advertiser_name: '수진코리아' }] }]]));
    const pv3 = await S.previewSheetImport({ url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1405976532' });
    ok('★★ D5 — 이미 등록된 탭은 막고 그 작업을 알려준다(덮어쓰면 주문·수정 내역이 지워진다)',
      pv3.ok === false && (pv3.blockers || []).some(b => b.code === 'already_registered'));

    /* ── [E][F] 실행 ── */
    install(VALUES, '0720고양이캔4종');
    const partPath = require.resolve('../src/services/participants.service');
    const ledPath = require.resolve('../src/services/sheetlessLedger.service');
    const tbPath = require.resolve('../src/services/trackB.service');
    const notePath = require.resolve('../src/services/sheetNotice.service');
    const cutPath = require.resolve('../src/services/sheetlessCutover.service');
    const savedP = require.cache[partPath], savedL = require.cache[ledPath], savedT = require.cache[tbPath],
          savedN = require.cache[notePath], savedC = require.cache[cutPath];
    const seen = { slots: null, ledger: null, own: null, notice: null };
    require.cache[partPath] = { id: partPath, filename: partPath, loaded: true, exports: {
      createSlotsFromSheetRows: async (a) => { seen.slots = a; return { created: (a.rows || []).length, requested: (a.rows || []).length }; },
      /* 되돌리기의 표 줄 삭제도 participants 소유 — 스텁은 실제 시그니처(client 를 받는다)를 따른다.
         ★ client 로 실행해야 등록·장부 삭제와 같은 트랜잭션에 들어간다(가드가 그 호출을 확인). */
      purgeImportedRows: async (client, a) => {
        const r = await client.query(
          'DELETE FROM campaign_participants WHERE sheet_id = $1 AND tab_name = $2 AND order_submission_id IS NULL',
          [a.sheetId, a.tabName]);
        return r.rowCount;
      },
    } };
    require.cache[ledPath] = { id: ledPath, filename: ledPath, loaded: true, exports: {
      rebuildLedgers: async (a) => { seen.ledger = a; return { ok: true, indexRows: 4, submittedCount: 2 }; },
    } };
    require.cache[tbPath] = { id: tbPath, filename: tbPath, loaded: true, exports: {
      setOwnership: async (a) => { seen.own = a; return { ok: true }; },
    } };
    require.cache[notePath] = { id: notePath, filename: notePath, loaded: true, exports: {
      applySheetNotice: async (sid, o) => { seen.notice = { sid, ...o }; return { ok: true }; },
    } };
    require.cache[cutPath] = { id: cutPath, filename: cutPath, loaded: true, exports: { CUTOVER_NOTICE: '⛔ 이관되었습니다' } };

    const advOk = [[/FROM advertisers/i, { rows: [{ id: 'adv_1', name: '수진코리아', status: 'active' }] }],
                   [/FROM tab_configs/i, { rows: [] }]];

    // D3 — 업체 미지정 거부
    S.__setPoolForTest(makePool(advOk));
    let threw = null;
    try { await S.importSheet({ url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1405976532' }); }
    catch (e) { threw = e; }
    ok('★★ D3 — 업체를 안 고르면 거부(업체 없이 가져오면 표에 안 보여 지금 문제가 반복된다)',
      threw && threw.code === 'advertiser_required');

    // 정상 실행
    const pool2 = makePool(advOk);
    S.__setPoolForTest(pool2);
    const out = await S.importSheet({
      url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1405976532',
      advertiserId: 'adv_1', displayName: '0720 고양이캔 4종', skipSeqs: [13], by: '만두',
    });
    ok('가져오기 성공', out.ok === true && out.advertiserName === '수진코리아');

    const tcIns = pool2.calls.find(c => /INSERT INTO tab_configs/i.test(c.sql));
    ok('★★ D1 — tab_configs 에 sheetless 를 **즉시 TRUE** 로 넣는다(장부 생성기가 무시트 탭에서만 동작)',
      tcIns && /VALUES[^)]*TRUE/i.test(tcIns.sql));
    ok('★★ 이관은 되돌리지 않는다 — 업서트가 sheetless 를 **OR** 로 유지',
      tcIns && /sheetless\s*=\s*COALESCE\(tab_configs\.sheetless,\s*FALSE\)\s*OR\s*EXCLUDED\.sheetless/i.test(tcIns.sql));
    ok('★ 메타는 blank-only(COALESCE-fill) — 이미 채워 둔 값을 덮지 않는다',
      tcIns && /campaign_name\s*=\s*COALESCE\(NULLIF\(tab_configs\.campaign_name/i.test(tcIns.sql) &&
      /display_name\s*=\s*COALESCE\(NULLIF\(tab_configs\.display_name/i.test(tcIns.sql));
    ok('campaigns 도 등록한다(작업 목록의 상위 단위)',
      pool2.calls.some(c => /INSERT INTO campaigns/i.test(c.sql)));

    ok('★★ F — 줄 생성은 participants 에 위임하고 **seq = 시트 실제 행 번호**를 그대로 넘긴다',
      seen.slots && seen.slots.rows.every(r => r.seq >= 10) && seen.slots.rows.some(r => r.seq === 10));
    ok('★ 고른 제외 줄(13)은 넘기지 않는다', seen.slots && !seen.slots.rows.some(r => r.seq === 13));
    ok('★ 번호 없는 줄(12)은 그대로 가져간다', seen.slots && seen.slots.rows.some(r => r.seq === 12));
    ok('★ 업체 소유는 **탭 지정**으로 건다(같은 시트의 다른 탭을 건드리지 않는다)',
      seen.own && seen.own.advertiserId === 'adv_1' && seen.own.tabGid === '1405976532');
    ok('★ 장부는 rebuildLedgers 가 만든다 — 열 구성을 함께 넘긴다',
      seen.ledger && Array.isArray(seen.ledger.columns) && seen.ledger.columns[9] === '연락처');
    ok('★ 시트에 쓰는 것은 안내문 한 줄뿐', seen.notice && /이관/.test(seen.notice.text) && seen.notice.force === true);
    ok('★ 결과에 명단 수·제출 수를 실어 화면이 사실대로 말한다',
      out.indexRows === 4 && out.submittedCount === 2);

    // 안내문 끄기
    S.__setPoolForTest(makePool(advOk)); seen.notice = null;
    await S.importSheet({ url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1405976532',
      advertiserId: 'adv_1', notice: false });
    ok('★ 안내문을 끄면 시트에 **아무것도 쓰지 않는다**', seen.notice === null);

    /* ★★ D5 는 **실행 단계에도** 걸려 있어야 한다 — 낡은 화면이 미리보기를 건너뛰고 run 을
       바로 호출할 수 있으므로, 미리보기의 blocker 만으로는 방어가 되지 않는다(변이시험이 잡았다). */
    S.__setPoolForTest(makePool([
      [/FROM advertisers/i, { rows: [{ id: 'adv_1', name: '수진코리아', status: 'active' }] }],
      [/FROM tab_configs/i, { rows: [{ tab_name: '0720고양이캔4종', tab_gid: '1405976532', sheetless: true, advertiser_name: '수진코리아' }] }],
    ]));
    threw = null;
    try {
      await S.importSheet({ url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1405976532',
        advertiserId: 'adv_1' });
    } catch (e) { threw = e; }
    ok('★★ D5 — 실행 단계도 이미 등록된 탭을 거부한다(덮어쓰면 주문·수정 내역이 지워진다)',
      threw && threw.code === 'already_registered');

    // 종료된 거래처 거부
    S.__setPoolForTest(makePool([[/FROM advertisers/i, { rows: [{ id: 'adv_2', name: '끝난곳', status: 'ended' }] }],
                                 [/FROM tab_configs/i, { rows: [] }]]));
    threw = null;
    try { await S.importSheet({ url: 'https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAA/edit#gid=1405976532', advertiserId: 'adv_2' }); }
    catch (e) { threw = e; }
    ok('★ 종료된 거래처에는 등록하지 않는다', threw && threw.code === 'advertiser_ended');

    /* ── [G] 되돌리기 ── */
    console.log('\n[G] 되돌리기(D6)');
    const guardBusy = [[/FROM tab_configs/i, { rows: [{ tab_gid: '1405976532', sheetless: true }] }],
                       [/FILTER \(WHERE order_submission_id/i, { rows: [{ with_order: '3', other_source: '0', total: '10' }] }]];
    const poolBusy = makePool(guardBusy);
    S.__setPoolForTest(poolBusy);
    const rv1 = await S.revertImport({ sheetId: 'S', tabName: 'T' });
    ok('★★ 주문이 들어왔으면 되돌리지 않는다(등록을 지우면 그 주문이 갈 곳을 잃는다)',
      rv1.ok === false && rv1.code === 'has_activity');
    ok('★★ 거부하면 **쓰기 0**', writes(poolBusy).length === 0);
    ok('★ 다음 행동을 말한다(줄 정리)', /줄 정리/.test(rv1.message || ''));

    const guardClean = [[/FROM tab_configs/i, { rows: [{ tab_gid: '1405976532', sheetless: true }] }],
                        [/FILTER \(WHERE order_submission_id/i, { rows: [{ with_order: '0', other_source: '0', total: '10' }] }],
                        [/DELETE FROM campaign_participants/i, { rowCount: 10 }]];
    const poolClean = makePool(guardClean);
    S.__setPoolForTest(poolClean);
    const rv2 = await S.revertImport({ sheetId: 'S', tabName: 'T' });
    ok('깨끗하면 되돌린다', rv2.ok === true && rv2.changed === true && rv2.removed === 10);
    const sqls = poolClean.calls.map(c => c.sql).join(' | ');
    ok('★★ 등록(tab_configs)까지 함께 내린다 — 남기면 크론이 시트를 다시 읽어 "되돌렸는데 또 나타난다"',
      /DELETE FROM tab_configs/i.test(sqls));
    ok('★ 장부 3권도 함께 지운다', /DELETE FROM review_index/i.test(sqls) &&
      /DELETE FROM index_master/i.test(sqls) && /DELETE FROM raw_sheet_rows/i.test(sqls));
    ok('★ 업체 소유는 소프트 해제(이력 보존)', /UPDATE advertiser_campaigns SET deleted_at/i.test(sqls));
    ok('★★ campaigns 는 남긴다(같은 시트의 다른 탭이 공유한다)', !/DELETE FROM campaigns/i.test(sqls));
    ok('★ 장부 재생성과 같은 탭 락을 잡는다(반쯤 만들어진 장부가 남지 않게)',
      /pg_advisory_xact_lock/i.test(sqls));

    restore();
    if (savedP) require.cache[partPath] = savedP; else delete require.cache[partPath];
    if (savedL) require.cache[ledPath] = savedL; else delete require.cache[ledPath];
    if (savedT) require.cache[tbPath] = savedT; else delete require.cache[tbPath];
    if (savedN) require.cache[notePath] = savedN; else delete require.cache[notePath];
    if (savedC) require.cache[cutPath] = savedC; else delete require.cache[cutPath];

    /* ── [H] 라우트·화면 ── */
    console.log('\n[H] 라우트 · 화면 배선');
    const router = require('../src/routes/trackB.routes');
    const stack = (router.stack || []).filter(l => l.route).map(l => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods),
      mw: (l.route.stack || []).map(s => s.handle.name),
    }));
    const find = (p) => stack.find(r => r.path === p);
    ['/sheet-import/preview', '/sheet-import/run', '/sheet-import/revert'].forEach(p => {
      const r = find(p);
      ok(`라우트 존재 — ${p}`, !!r && r.methods.includes('post'));
      ok(`★★ ${p} 는 adminOrMaster (두 번째 등록 창구라 AE 에게 열지 않는다)`,
        !!r && r.mw.some(n => /authMiddleware/.test(n)) && r.mw.some(n => /adminOrMaster/.test(n)),
        r ? r.mw.join(',') : 'none');
    });

    const rt = read('src/routes/trackB.routes.js');
    ok('★ 안내문은 명시적으로 false 일 때만 끈다(값 누락은 기본 동작)', /notice:\s*notice\s*!==\s*false/.test(rt));
    ok('★ ImportError 는 400대로 매핑(500 마스킹이면 무엇을 고칠지 모른다)',
      /ImportError[\s\S]{0,200}res\.status\(400\)/.test(rt));

    const fh = readFront('workdesk.html');
    ok('업체 패널에 진입점(관리자 전용)', /isAdmin\?`<button[^`]*openSheetImport\('\$\{esc\(a\.id\)\}'\)/.test(fh));
    ok('사이드바에도 진입점 — 업체를 모를 때 주소부터 넣는 경로', /openSheetImport\(''\)/.test(fh));
    ok('★ 4단계 함수가 모두 있다',
      ['openSheetImport', '_siPreview', '_siRun', '_siRevert', '_siClose'].every(f => fh.indexOf('function ' + f) >= 0));
    ok('★ 팝업은 body 직속', /id='siPop'[\s\S]{0,200}document\.body\.appendChild/.test(fh) ||
      /ov\.id\s*=\s*'siPop'[\s\S]{0,220}document\.body\.appendChild\(ov\)/.test(fh));
    ok('★★ 바깥 클릭으로 닫지 않는다(붙여넣은 주소·고른 줄 보호) — Esc·[취소]만',
      !/si-ov[^\n]*onclick=/.test(fh) && /Escape'&&_siS/.test(fh));
    ok('★★ onclick 은 인덱스만 — 탭명·업체명 문자열을 보간하지 않는다',
      !/_siPickTab\('/.test(fh) && !/_siToggle\('/.test(fh) &&
      /_siPickTab\(\$\{i\}\)/.test(fh) && /_siToggle\(\$\{i\}\)/.test(fh));
    ok('★ 실행은 confirm 을 거친다(되돌리기 있어도 파괴적 조작)', /_siRun\(\)[\s\S]{0,900}confirm\(/.test(fh));
    ok('★ 주소 입력 중 재렌더하지 않는다(IME 조합 보호) — 값은 상태로만 받는다',
      /oninput="_siS\.url=this\.value"/.test(fh));
    /* ★★ 화면은 **서버가 준 blockers 를 그리기만** 한다 — 여기서 사유 코드를 보고 다시 판정하면
       "화면은 초록인데 서버가 거부"가 구조적으로 가능해진다. 사유 코드 문자열이 화면에 없어야 한다.
       (탭 고르기로 이어지는 gid_* 두 코드만 예외 — 그건 판정이 아니라 다음 행동 분기다.) */
    ok('★★ 판정 사본 0 — 화면에 서버 사유 코드가 없다(gid 분기 제외)',
      /p\.blockers\s*\|\|\s*\[\]/.test(fh) &&
      !/'no_phone_column'|'already_registered'|'header_unrecognizable'|'no_rows'/.test(fh));
    ok('★ 서버가 준 blockers 로 [다음] 을 잠근다',
      /blocked\?'disabled':''/.test(fh));
    ok('CSS 는 si- 접두로 스코프', /\.si-ov\{/.test(fh) && /\.si-mo\{/.test(fh));

    /* ★★ 헤더 칸 수 ≡ 행 칸 수 — 열을 끼워 넣을 때 가장 흔히 깨지는 자리(업체관리 표와 같은 계약). */
    const s3 = fh.slice(fh.indexOf('function _siStep3('), fh.indexOf('function _siAdv('));
    const headCells = (s3.match(/<th[ >]/g) || []).length;
    const bodyCells = (s3.match(/<td[ >]/g) || []).length;
    ok('★★ 가져올 줄 표 — 헤더 칸 수 ≡ 행 칸 수', headCells === bodyCells && headCells === 9,
      `th=${headCells} td=${bodyCells}`);

    console.log(`\n✅ sheetImport 회귀가드 통과 (${passed}케이스)\n`);
    process.exit(0);
  })().catch(e => { console.error('\n❌ 실패:', e && e.message); console.error(e); process.exit(1); });
}
