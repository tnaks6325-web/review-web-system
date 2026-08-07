/**
 * sheetlessApplicant.test.js — 이관된 작업의 레거시 공고 참여 행 추가 (W5 전제)
 *
 * 무엇을 고정하는가
 *  A. 열 판정 단일 출처(`utils/applicantColumns`) — 시트 append 경로와 작업표 경로가 같은 표를 쓴다
 *  B. 무시트 탭이면 작업표에 넣고 `handled:true`, 시트 기반이면 `handled:false`(호출부가 종전 경로)
 *  C. ★★ 무시트인데 실패하면 **throw** — 조용히 false 를 돌려주면 호출부가 시트에 쓰고
 *     그 줄은 아무도 읽지 않는 곳에 남는다(= 참여자 실종)
 *  D. 작업표 INSERT 는 `participants.createSlotsFromSheetRows` 한 곳(쓰기 소유자 규율)
 *  E. campaign.routes 배선 — 시트 쓰기 **앞**에서 분기하고, 키워드·별칭 사본이 없다
 *
 * 실행: node tests/sheetlessApplicant.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

const cols = require('../src/utils/applicantColumns');
const svc = require('../src/services/sheetlessApplicant.service');

/* 스텁 pool — 쿼리 내용으로 분기 + 실행 로그 */
function makeStub(opts = {}) {
  const o = Object.assign({
    sheetless: true, tcRows: [{ tab_gid: '77', campaign_name: '캠페인' }],
    headers: ['번호', '수취인', '연락처', '인애드명'], detected: true,
    maxSeq: 12, tcThrows: false,
  }, opts);
  const log = [];
  const db = {
    query: async (sql, params) => {
      log.push({ sql: String(sql), params });
      const s = String(sql);
      if (/FROM tab_configs/.test(s)) {
        if (o.tcThrows) throw new Error('tc down');
        return { rows: o.tcRows };
      }
      if (/FROM raw_sheet_tabs/.test(s)) {
        return { rows: o.headers === null ? [] : [{ detected_headers: o.detected ? o.headers : null, headers: o.detected ? null : o.headers }] };
      }
      if (/FROM campaign_participants/.test(s)) return { rows: [{ m: o.maxSeq }] };
      return { rows: [] };
    },
  };
  return { db, log, o };
}

function stubDeps({ sheetless = true, scopeThrows = false, slotThrows = false, ledgerThrows = false } = {}) {
  const scope = require('../src/utils/sheetlessScope');
  const _is = scope.isSheetless;
  scope.isSheetless = async () => { if (scopeThrows) throw new Error('scope down'); return sheetless; };
  const parts = require('../src/services/participants.service');
  const _cs = parts.createSlotsFromSheetRows;
  const slotCalls = [];
  parts.createSlotsFromSheetRows = async (a) => {
    slotCalls.push(a);
    if (slotThrows) throw new Error('slot fail');
    return { inserted: (a.rows || []).length };
  };
  const led = require('../src/services/sheetlessLedger.service');
  const _rb = led.rebuildLedgers;
  const ledCalls = [];
  led.rebuildLedgers = async (a) => {
    ledCalls.push(a);
    if (ledgerThrows) throw new Error('ledger fail');
    return { indexRows: 1 };
  };
  return {
    slotCalls, ledCalls,
    restore: () => { scope.isSheetless = _is; parts.createSlotsFromSheetRows = _cs; led.rebuildLedgers = _rb; },
  };
}

(async () => {
  /* ══════════════ A. 열 판정 단일 출처 ══════════════ */
  console.log('\n[A] 열 판정 — 두 경로가 같은 표를 쓴다');
  {
    const h = ['번호', '주문자', '연락처', '인애드명', '주소'];
    const r = cols.resolveApplicantColumns(h);
    ok('이름 열 = 주문자(별칭 우선순위 그대로)', r.name === 1);
    ok('연락처·인애드·번호 열도 함께 찾는다', r.phone === 2 && r.inad === 3 && r.num === 0);
    ok('부분일치(includes) 매칭 유지', cols.findCol(['참여자 성함'], cols.NAME_ALIASES) === 0);
    ok('없는 열은 -1(추측하지 않는다)', cols.resolveApplicantColumns(['비고']).name === -1);
    ok('헤더 후보 판정 = 키워드 2개 이상', cols.isApplicantHeaderRow(['번호', '수취인']) === true
      && cols.isApplicantHeaderRow(['번호']) === false);
    ok('빈 배열·null 도 안전', cols.isApplicantHeaderRow(null) === false
      && cols.resolveApplicantColumns(null).name === -1);
  }

  /* ══════════════ B. 분기 ══════════════ */
  console.log('\n[B] 무시트면 작업표 · 시트 기반이면 종전 경로');
  {
    const { db } = makeStub();
    svc.__setPoolForTest(db);
    const d = stubDeps({ sheetless: false });
    const r = await svc.addApplicantRow({ sheetId: 'S1', tabName: 'T1', applicant: { name: '홍길동' } });
    ok('★ 시트 기반 탭이면 handled=false — 호출부가 자기 기존 경로(appendSheet)를 그대로 탄다',
      r.handled === false && r.reason === 'not_sheetless');
    ok('★ 그때는 작업표에 한 줄도 안 넣는다', d.slotCalls.length === 0 && d.ledCalls.length === 0);
    d.restore(); svc.__setPoolForTest(null);
  }
  {
    const { db } = makeStub();
    svc.__setPoolForTest(db);
    const d = stubDeps({ scopeThrows: true });
    const r = await svc.addApplicantRow({ sheetId: 'S1', tabName: 'T1', applicant: { name: '홍길동' } });
    ok('★★ 무시트 판정 실패는 fail-open(종전 경로) — 시트 기반이 절대 다수다',
      r.handled === false && d.slotCalls.length === 0);
    d.restore(); svc.__setPoolForTest(null);
  }
  {
    const { db, log } = makeStub();
    svc.__setPoolForTest(db);
    const d = stubDeps({});
    const r = await svc.addApplicantRow({ sheetId: 'S1', tabName: 'T1',
      applicant: { name: '홍길동', phone: '01012345678', inad: '길동이' } });
    ok('무시트 탭이면 handled=true', r.handled === true);
    ok('★ 다음 자리 = 표의 마지막 seq + 1(삭제된 줄도 세어 재사용 금지)', r.seq === 13);

    const call = d.slotCalls[0];
    ok('★ 작업표 INSERT 는 createSlotsFromSheetRows 한 곳(쓰기 소유자)', d.slotCalls.length === 1);
    ok('그 탭·그 자리로 넣는다', call.sheetId === 'S1' && call.tabName === 'T1'
      && call.rows.length === 1 && call.rows[0].seq === 13);
    const rj = call.rows[0].rowJson;
    ok('★ row_json 은 헤더명 → 값(시트 경로와 같은 모양)',
      rj['수취인'] === '홍길동' && rj['연락처'] === '01012345678' && rj['인애드명'] === '길동이');
    ok('번호 칸도 채운다', rj['번호'] === '12');
    ok('★ 장부 재생성까지 해야 검색·행배정에 나타난다', d.ledCalls.length === 1
      && d.ledCalls[0].sheetId === 'S1' && d.ledCalls[0].tabName === 'T1');
    ok('★ gid 는 서버가 tab_configs 에서 구한다(클라 값 불신)', call.tabGid === '77');
    ok('열 이름은 detected_headers 우선(시트 A1 행 아님)',
      log.some(q => /detected_headers, headers FROM raw_sheet_tabs/.test(q.sql)));
    d.restore(); svc.__setPoolForTest(null);
  }
  {
    // detected_headers 가 비면 headers 폴백
    const { db } = makeStub({ detected: false });
    svc.__setPoolForTest(db);
    const d = stubDeps({});
    const r = await svc.addApplicantRow({ sheetId: 'S1', tabName: 'T1', applicant: { name: '김철수' } });
    ok('detected_headers 없으면 headers 폴백', r.handled === true
      && d.slotCalls[0].rows[0].rowJson['수취인'] === '김철수');
    d.restore(); svc.__setPoolForTest(null);
  }

  /* ══════════════ C. 실패는 드러난다 (완화 금지) ══════════════ */
  console.log('\n[C] ★★ 무시트인데 실패하면 throw — 조용한 시트 폴백 금지');
  {
    const cases = [
      ['열 구성을 모르면', { headers: null }, {}],
      ['이름 열이 없으면', { headers: ['비고', '메모'] }, {}],
      ['탭 등록 정보가 없으면', { tcRows: [] }, {}],
      ['작업표 기록이 실패하면', {}, { slotThrows: true }],
      ['장부 재생성이 실패하면', {}, { ledgerThrows: true }],
    ];
    for (const [label, stubOpt, depOpt] of cases) {
      const { db } = makeStub(stubOpt);
      svc.__setPoolForTest(db);
      const d = stubDeps(depOpt);
      let threw = false;
      try {
        await svc.addApplicantRow({ sheetId: 'S1', tabName: 'T1', applicant: { name: '홍길동' } });
      } catch (_) { threw = true; }
      ok(`★★ ${label} throw 한다(handled:false 로 시트에 새지 않는다)`, threw === true);
      d.restore(); svc.__setPoolForTest(null);
    }
  }
  {
    const { db } = makeStub();
    svc.__setPoolForTest(db);
    const d = stubDeps({});
    const r = await svc.addApplicantRow({ sheetId: 'S1', tabName: '', applicant: { name: '홍' } });
    ok('재료가 모자라면 판정조차 하지 않는다(bad_request)', r.handled === false && r.reason === 'bad_request');
    ok('그때 DB 도 안 건드린다', d.slotCalls.length === 0);
    d.restore(); svc.__setPoolForTest(null);
  }

  /* ══════════════ D. 소스 위생 ══════════════ */
  console.log('\n[D] 서비스 — 시트 API 무접촉 · 쓰기 표면');
  {
    const src = read('src/services/sheetlessApplicant.service.js');
    ok('★ 시트 API 를 부르지 않는다(무시트 경로다)',
      !/(appendSheet|writeSheet|readSheet)\s*\(/.test(src) && !/sheets\.service/.test(src));
    ok('★ 열 판정 사본 없음 — utils/applicantColumns 만 쓴다',
      /require\('\.\.\/utils\/applicantColumns'\)/.test(src)
      && !/NAME_ALIASES\s*=/.test(src));
    ok('★ campaign_participants 직접 INSERT 없음(쓰기 소유자에게 위임)',
      !/INSERT\s+INTO\s+campaign_participants/i.test(src));
    ok('리터럴 NUL 없음(git 바이너리 취급 방지)', Buffer.from(src).indexOf(0) === -1);
  }

  /* ══════════════ E. 배선 ══════════════ */
  console.log('\n[E] campaign.routes 배선 — 시트 쓰기 앞에서 분기');
  {
    // ⚠ 이 파일에는 의도된 NUL(복합키 구분자)이 있어 grep 가드를 못 건다 → 읽을 때 제거하고 본다.
    const src = read('src/routes/campaign.routes.js').split('\u0000').join('');
    const i = src.indexOf('async function _addApplicationToSheet');
    ok('_addApplicationToSheet 를 찾았다', i > 0);
    const body = src.slice(i, i + 4000);
    const iBranch = body.indexOf('sheetlessApplicant.service');
    const iAppend = body.indexOf('appendSheet(');
    ok('★★ 무시트 분기가 시트 쓰기보다 먼저 온다', iBranch > 0 && iAppend > iBranch);
    ok('★ handled 면 즉시 반환(시트에 이중 기록 없음)', /_sl\.handled\)\s*return;/.test(body));
    ok('★ 열 판정은 공유 표 — 별칭 사본이 이 파일에 없다',
      /require\('\.\.\/utils\/applicantColumns'\)/.test(body)
      && !/const\s+NAME_ALIASES/.test(src));
    ok('★ 헤더 키워드 표도 공유(사본 0)',
      /isApplicantHeaderRow/.test(body) && !/const\s+HEADER_KEYWORDS\s*=/.test(src));
  }

  console.log(`\n✅ sheetlessApplicant: ${passed} cases passed`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
