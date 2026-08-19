'use strict';
// 2026-08-19 작업보드 중복 반영 재발 방지 가드.
//   무시트 경로는 시트 시절의 `sheet_row_claims`(=(sheet,tab,dedup_key) 유니크)를 건너뛰므로
//   ① 주문원장 단계(날짜 넘는 같은 구매 차단) ② 작업표 기록 단계(같은 구매면 새 줄 금지)
//   두 겹으로 "주문 1건 = 줄 1개" 를 지킨다. 둘 다 **실제로 실행**해서 확인한다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

const HEADERS = ['번호', '수취인', '연락처', '주소', '결제금액', '주문번호', '비고'];

// ── 스텁 pool: 중복 줄 조회에만 응답하고 나머지는 빈 결과 ──────────────
function makeStub({ dupRow = null, openSlot = { id: 'p9', seq: 42, row_json: {} } } = {}) {
  const log = { client: [], released: 0 };
  const client = {
    query: async (sql, params) => {
      const q = String(sql).trim();
      log.client.push({ sql: q, params });
      if (/JOIN order_submissions os2/.test(q)) return { rows: dupRow ? [dupRow] : [] };
      if (/order_submission_id = \$3::uuid/.test(q)) return { rows: [] };          // 내 링크 없음
      if (/order_submission_id IS NULL/.test(q)) return { rows: openSlot ? [openSlot] : [] };
      return { rows: [], rowCount: 1 };
    },
    release: () => { log.released++; },
  };
  return { db: { query: async () => ({ rows: [], rowCount: 1 }), connect: async () => client }, log };
}

(async () => {
  console.log('\n[A] 작업표 기록 — 같은 구매면 빈 슬롯을 새로 먹지 않는다');
  const slOrder = require('../src/services/sheetlessOrder.service');
  const ledgerSvc = require('../src/services/orderLedger.service');
  const ledgerMod = require('../src/services/sheetlessLedger.service');
  const partMod = require('../src/services/participation.service');
  const orig = {
    load: ledgerSvc.loadRawTabContext, written: ledgerSvc.markOrderWritten,
    ident: ledgerSvc.recordReviewIdentity, rebuild: ledgerMod.rebuildLedgers,
    link: partMod.recordParticipationLink,
  };
  const calls = { written: 0, rebuild: 0, ident: 0 };
  ledgerSvc.loadRawTabContext = async () => ({ headers: HEADERS, dataRows: [], headerRowIndex: 1, tabGid: '77' });
  ledgerSvc.markOrderWritten = async () => { calls.written++; };
  ledgerSvc.recordReviewIdentity = async () => { calls.ident++; };
  ledgerMod.rebuildLedgers = async () => { calls.rebuild++; return { mirrorRows: 1, indexRows: 1 }; };
  partMod.recordParticipationLink = async () => {};

  const ORDER = { recipient: '김수취', phone: '010-9041-1926', orderNum: '29102369417861', price: '78000' };

  try {
    { // 이미 같은 구매가 42번 줄에 있다 → 새 줄 금지
      const { db, log } = makeStub({ dupRow: { seq: 42, order_submission_id: 'os-first' } });
      slOrder.__setPoolForTest(db);
      const r = await slOrder.writeOrderToWorktable({
        sheetId: 'wt_x', tabName: 'T1', tabGid: '77',
        orderData: ORDER, orderSubmissionId: 'os-second', loginPhone8: '90411926',
      });
      const sqls = log.client.map(c => c.sql);
      ok('중복이면 ok:true 로 돌려준다(리뷰어에게 실패로 보이지 않게)', r.ok === true);
      ok('새 줄은 만들지 않는다(written:false)', r.written === false && r.reason === 'duplicate_row');
      ok('이미 반영된 줄 번호를 알려준다', r.seq === 42 && r.duplicateOf === 'os-first');
      ok('빈 슬롯 선점 쿼리를 아예 실행하지 않는다', !sqls.some(s => /order_submission_id IS NULL/.test(s)));
      ok('행을 갱신·삽입하지 않는다', !sqls.some(s => /UPDATE campaign_participants|INSERT INTO campaign_participants/.test(s)));
      ok('기존 줄의 링크를 빼앗지 않는다(원래 주문이 미반영으로 되살아나면 복구 잡이 또 만든다)',
        !sqls.some(s => /UPDATE campaign_participants[\s\S]*order_submission_id/.test(s)));
      ok('트랜잭션은 ROLLBACK 으로 닫는다', sqls.includes('ROLLBACK') && !sqls.includes('COMMIT'));
      ok('커넥션을 반납한다', log.released === 1);
      ok('장부 재생성·완결 표시를 하지 않는다', calls.rebuild === 0 && calls.written === 0);
    }
    { // 중복이 없으면 종전대로 빈 슬롯을 먹는다(무회귀)
      const { db, log } = makeStub({ dupRow: null });
      slOrder.__setPoolForTest(db);
      const r = await slOrder.writeOrderToWorktable({
        sheetId: 'wt_x', tabName: 'T1', tabGid: '77',
        orderData: ORDER, orderSubmissionId: 'os-new', loginPhone8: '90411926',
      });
      const sqls = log.client.map(c => c.sql);
      ok('중복이 없으면 정상 기록(무회귀)', r.ok === true && r.written === true && r.seq === 42);
      ok('빈 슬롯 선점을 실행한다', sqls.some(s => /order_submission_id IS NULL/.test(s)));
      ok('COMMIT 한다', sqls.includes('COMMIT'));
    }
    { // 주문번호가 짧으면(비번호 쿠팡 등) 판정하지 않는다 — 모르면 막지 않는다
      const { db, log } = makeStub({ dupRow: { seq: 7, order_submission_id: 'os-x' } });
      slOrder.__setPoolForTest(db);
      const r = await slOrder.writeOrderToWorktable({
        sheetId: 'wt_x', tabName: 'T1', tabGid: '77',
        orderData: { ...ORDER, orderNum: '123' }, orderSubmissionId: 'os-short',
      });
      const sqls = log.client.map(c => c.sql);
      ok('주문번호 6자리 미만이면 중복 조회를 하지 않는다(fail-open)',
        !sqls.some(s => /JOIN order_submissions os2/.test(s)) && r.written === true);
    }
    { // 행 번호를 명시한 레거시 복구 경로는 이 판정을 타지 않는다
      const { db, log } = makeStub({ dupRow: { seq: 42, order_submission_id: 'os-first' } });
      slOrder.__setPoolForTest(db);
      await slOrder.writeOrderToWorktable({
        sheetId: 'wt_x', tabName: 'T1', tabGid: '77', sheetRow: 5,
        orderData: ORDER, orderSubmissionId: 'os-legacy',
      });
      ok('sheetRow 를 명시한 경로는 종전 그대로(중복 조회 없음)',
        !log.client.some(c => /JOIN order_submissions os2/.test(c.sql)));
    }
  } finally {
    ledgerSvc.loadRawTabContext = orig.load; ledgerSvc.markOrderWritten = orig.written;
    ledgerSvc.recordReviewIdentity = orig.ident; ledgerMod.rebuildLedgers = orig.rebuild;
    partMod.recordParticipationLink = orig.link; slOrder.__setPoolForTest(null);
  }

  console.log('\n[B] 주문원장 — 날짜를 넘는 같은 구매(무시트 전용)');
  const dupSvc = require('../src/services/orderDuplicate.service');
  {
    const seen = [];
    const client = { query: async (sql, params) => { seen.push({ sql: String(sql), params }); return { rows: [{ id: 'os-old' }] }; } };
    const found = await dupSvc.findEquivalentOrderInTx(client, {
      sheetId: 'campaign:c1', tabName: 'campaign:c1', campaignId: 'c1',
      orderData: { orderNum: '2910-2369-417861', phone: '010-9041-1926', recipient: '김 수취', price: '78,000원' },
    });
    ok('같은 구매를 찾아낸다', found && found.id === 'os-old');
    const sql = seen[0].sql;
    ok('날짜 조건이 없다(어제 것도 잡는다)', !/submitted_at AT TIME ZONE/.test(sql));
    ok('취소된 주문은 제외한다', /os\.deleted_at IS NULL/.test(sql));
    ok('키는 주문번호·연락처·수취인·결제금액 4개', /order_num/.test(sql) && /os\.phone/.test(sql) && /os\.recipient/.test(sql) && /os\.price/.test(sql));
    ok('메모·옵션까지 요구하지 않는다(한 글자 차이로 뚫리지 않게)', !/os\.memo/.test(sql) && !/selected_opt_key/.test(sql));
    ok('캠페인 스코프를 건다', /campaign_applications/.test(sql));
    ok('숫자만 비교한다(표기 차이 흡수)', seen[0].params.includes('29102369417861') && seen[0].params.includes('78000'));
  }
  {
    const client = { query: async () => { throw new Error('조회하면 안 된다'); } };
    const r = await dupSvc.findEquivalentOrderInTx(client, {
      sheetId: 's', tabName: 't', orderData: { orderNum: '12345', phone: '01090411926' } });
    ok('주문번호 6자리 미만이면 조회조차 하지 않는다(fail-open)', r === null);
  }

  console.log('\n[C] 배선 — 무시트에서만 켜진다(시트 경로 무회귀)');
  const submitSrc = fs.readFileSync(path.join(__dirname, '../src/routes/submit.routes.js'), 'utf8');
  ok('crossDay 는 orderScope.sheetless 일 때만 true', /crossDay:\s*!!orderScope\.sheetless/.test(submitSrc));
  const ledgerSrc = fs.readFileSync(path.join(__dirname, '../src/services/orderLedger.service.js'), 'utf8');
  ok('crossDay 가 아니면 종전 판정에서 끝난다', /if \(!sameDayDuplicateGuard\.crossDay\) return null;/.test(ledgerSrc));
  ok('당일 판정이 먼저다(기존 동작 보존)',
    ledgerSrc.indexOf('findSameDayDuplicateInTx(client, sameDayDuplicateGuard)') < ledgerSrc.indexOf('findEquivalentOrderInTx(client, sameDayDuplicateGuard)'));
  const slSrc = fs.readFileSync(path.join(__dirname, '../src/services/sheetlessOrder.service.js'), 'utf8');
  ok('중복 판정은 빈 슬롯 선점 **앞**에 있다',
    slSrc.indexOf('JOIN order_submissions os2') < slSrc.indexOf('AND order_submission_id IS NULL'));
  ok('SQL 과 JS 의 숫자 정규화 규칙이 같다', /function _digits\(v\) \{ return String\(v == null \? '' : v\)\.replace\(\/\\D\/g, ''\); \}/.test(slSrc));

  console.log('\n[D] 중복 줄 정리 — 안전 규칙이 실제로 발동한다');
  const led = require('../src/services/sheetlessLedger.service');
  const rowsFixture = [
    // 정상 중복(3줄) — 630 남기고 642·655 정리
    { seq: 630, osid: 'os-a1', name: '김신혜', submitted: false, paid: false, ordnum: '29102369417861', roword: '29102369417861', ph: '01090411926', in_payment: false },
    { seq: 642, osid: 'os-a2', name: '김신혜', submitted: false, paid: false, ordnum: '29102369417861', roword: '29102369417861', ph: '01090411926', in_payment: false },
    { seq: 655, osid: 'os-a3', name: '김신혜', submitted: false, paid: false, ordnum: '29102369417861', roword: '29102369417861', ph: '01090411926', in_payment: false },
    // ★ 실사고(신다인): 같은 사람인데 **표에 보이는 주문번호가 서로 다르다** → 중복이 아니다.
    //   원장(os.order_num)만 보면 같은 값이라 지워질 뻔했다.
    { seq: 19,  osid: 'os-s1', name: '신다인', submitted: false, paid: false, ordnum: '23102041302915', roword: '23102041302915', ph: '01051475613', in_payment: false },
    { seq: 407, osid: 'os-s2', name: '신다인', submitted: false, paid: false, ordnum: '23102041302915', roword: '23102367337800', ph: '01051475613', in_payment: false },
    // ★ 표에 주문번호가 없는 줄은 판정 불가 → 대상 제외
    { seq: 900, osid: 'os-n1', name: '무번호', submitted: false, paid: false, ordnum: '99999999999', roword: '', ph: '01011112222', in_payment: false },
    { seq: 901, osid: 'os-n2', name: '무번호', submitted: false, paid: false, ordnum: '99999999999', roword: '', ph: '01011112222', in_payment: false },
    // 입금 회차에 담긴 줄이 섞인 그룹 — 손대지 않는다
    { seq: 461, osid: 'os-b1', name: '김태헌', submitted: false, paid: false, ordnum: '22102148311', roword: '22102148311', ph: '01050222120', in_payment: false },
    { seq: 468, osid: 'os-b2', name: '김태헌', submitted: false, paid: true,  ordnum: '22102148311', roword: '22102148311', ph: '01050222120', in_payment: true },
    // 실제로 쓰인 줄이 뒤에 있는 그룹 — 손대지 않는다
    { seq: 470, osid: 'os-c1', name: '심수영', submitted: false, paid: false, ordnum: '30102276911', roword: '30102276911', ph: '01054465123', in_payment: false },
    { seq: 477, osid: 'os-c2', name: '심수영', submitted: true,  paid: false, ordnum: '30102276911', roword: '30102276911', ph: '01054465123', in_payment: false },
    // 중복 아님(1줄)
    { seq: 500, osid: 'os-d1', name: '홀로', submitted: false, paid: false, ordnum: '11111111111', roword: '11111111111', ph: '01000000000', in_payment: false },
  ];
  const ledCalls = { retire: null, cancel: null, rebuild: 0 };
  const partMod2 = require('../src/services/participants.service');
  const ledgerSvc2 = require('../src/services/orderLedger.service');
  const origRetire = partMod2.retireRows;
  const origCancel = ledgerSvc2.softDeleteDuplicateOrders;
  partMod2.retireRows = async (a) => { ledCalls.retire = a; return { retired: (a.seqs || []).length }; };
  ledgerSvc2.softDeleteDuplicateOrders = async (ids) => { ledCalls.cancel = ids; return ids.length; };
  led.__setPoolForTest({
    query: async (sql) => {
      if (/FROM tab_configs/.test(sql)) return { rows: [{ sheetless: true }] };
      if (/JOIN order_submissions os ON os\.id = cp\.order_submission_id/.test(sql)) return { rows: rowsFixture };
      return { rows: [], rowCount: 0 };
    },
  });
  try {
    const prev = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T1' });
    ok('기본은 미리보기(dryRun)', prev.dryRun === true);
    ok('쓰기를 하지 않는다', ledCalls.retire === null && ledCalls.cancel === null);
    ok('정리 대상 그룹 1개 · 줄 2개', prev.groups === 1 && prev.removeRows === 2);
    ok('가장 이른 줄을 남긴다', prev.plan[0].keepSeq === 630 && prev.plan[0].removeSeqs.join() === '642,655');
    ok('보류 그룹 2개를 사유와 함께 보고한다', prev.skippedGroups === 2);
    ok('입금 회차에 담긴 그룹은 보류', prev.skipped.some(s => s.reason === 'in_payment_batch' && s.seqs.includes(468)));
    ok('쓰인 줄이 뒤에 있는 그룹은 보류', prev.skipped.some(s => s.reason === 'used_row_is_not_first' && s.seqs.includes(477)));
    ok('중복 아닌 줄은 대상이 아니다', !JSON.stringify(prev.plan).includes('500'));
    ok('★★ 표에 보이는 주문번호가 다르면 중복이 아니다(신다인 실사고)',
      !JSON.stringify(prev.plan).includes('407') && !JSON.stringify(prev.plan).includes('"keepSeq":19'));
    ok('★ 표에 주문번호가 없는 줄은 대상에서 제외한다(모르면 안 지운다)',
      !JSON.stringify(prev.plan).includes('901') && prev.skippedNoRowOrder === 2);
    ok('미리보기 주문번호는 표 기준값으로 보여준다',
      (prev.plan[0] || {}).orderNum === '29102369417861');

    const run = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T1', dryRun: false, by: '망고' });
    ok('실행하면 그 줄만 내린다', ledCalls.retire.seqs.join() === '642,655' && run.removed === 2);
    ok('작업표 쓰기는 participants.service 가 한다(쓰기 소유자)', ledCalls.retire.dryRun === false);
    ok('중복 주문만 소프트 취소', ledCalls.cancel.join() === 'os-a2,os-a3' && run.canceledOrders === 2);
    ok('입금 회차 줄의 주문은 취소하지 않는다', !ledCalls.cancel.includes('os-b2'));
    ok('누가 했는지 남긴다', /dedupe:망고/.test(ledCalls.retire.by));
  } finally {
    partMod2.retireRows = origRetire; ledgerSvc2.softDeleteDuplicateOrders = origCancel;
    led.__setPoolForTest(null);
  }
  {
    led.__setPoolForTest({ query: async (sql) => (/FROM tab_configs/.test(sql) ? { rows: [{ sheetless: false }] } : { rows: [] }) });
    let code = null;
    try { await led.dedupeRows({ sheetId: 's', tabName: 't' }); } catch (e) { code = e.code; }
    ok('시트 기반 탭은 거부(다음 시트 반영이 되살린다)', code === 'not_sheetless');
    led.__setPoolForTest(null);
  }
  /* ★★ 판정 키에 **주문번호**가 반드시 들어간다(사용자 확정 2026-08-19).
       스텁은 SQL 을 해석하지 않으므로 쿼리문 자체를 고정한다 — 이 조건이 빠지면 "같은 사람이 다른
       주문으로 여러 번 참여한 것"까지 중복으로 지워진다. */
  const ledSrc = fs.readFileSync(path.join(__dirname, '../src/services/sheetlessLedger.service.js'), 'utf8');
  const dedupeSrc = ledSrc.slice(ledSrc.indexOf('async function dedupeRows('),
                                ledSrc.indexOf('module.exports'));
  ok('중복 조회가 주문번호를 읽는다', /order_num[\s\S]{0,40}AS ordnum/.test(dedupeSrc));
  ok('★ 주문번호 6자리 미만은 조회에서 제외(주문번호 없는 줄은 절대 대상이 아니다)',
    /length\(regexp_replace\(COALESCE\(os\.order_num[\s\S]{0,60}\) >= 6/.test(dedupeSrc));
  ok('★★ 그룹 키 = 표 주문번호 + 원장 주문번호 + 연락처 셋 다',
    /const key = `\$\{r\.roword\}[\s\S]{0,30}\$\{r\.ordnum\}[\s\S]{0,30}\$\{r\.ph\}`/.test(dedupeSrc));
  ok('★ 표에 보이는 주문번호(row_json)를 조회한다', /jsonb_each_text\(COALESCE\(cp\.row_json[\s\S]{0,200}주문번호[\s\S]{0,120}AS roword/.test(dedupeSrc));
  ok('★ 표 주문번호가 6자리 미만이면 그룹에 넣지 않는다',
    /String\(r\.roword \|\| ''\)\.length < 6[\s\S]{0,60}continue/.test(dedupeSrc));
  ok('취소된 주문은 대상이 아니다', /os\.deleted_at IS NULL/.test(dedupeSrc));
  {
    // 같은 사람(같은 연락처)이 **다른 주문번호**로 두 번 참여 → 중복이 아니다(실행으로 확인)
    const led2 = require('../src/services/sheetlessLedger.service');
    led2.__setPoolForTest({
      query: async (sql) => {
        if (/FROM tab_configs/.test(sql)) return { rows: [{ sheetless: true }] };
        if (/JOIN order_submissions os ON os\.id = cp\.order_submission_id/.test(sql)) return { rows: [
          { seq: 1, osid: 'o1', name: '김신혜', submitted: false, paid: false, ordnum: '11111111111', ph: '01090411926', in_payment: false },
          { seq: 2, osid: 'o2', name: '김신혜', submitted: false, paid: false, ordnum: '22222222222', ph: '01090411926', in_payment: false },
        ] };
        return { rows: [] };
      },
    });
    const r = await led2.dedupeRows({ sheetId: 'wt_x', tabName: 'T1' });
    ok('★ 연락처만 같고 주문번호가 다르면 중복이 아니다', r.groups === 0 && r.removeRows === 0);
    led2.__setPoolForTest(null);
  }
  const tbSrc = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
  ok('정리 라우트는 adminOrMaster', /'\/worktable\/dedupe-rows', authMiddleware, adminOrMasterMiddleware/.test(tbSrc));
  ok('라우트도 dryRun 기본', /dedupe-rows[\s\S]{0,400}dryRun: b\.dryRun !== false/.test(tbSrc));

  console.log('\n[E] 화면 창구 — 미리보기 → 확인 → 실행');
  const wd = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
  ok('[⋯] 도구 메뉴에 중복 정리 버튼', /onclick="openDedupeModal\(\)"/.test(wd));
  /* ★★ 화면 게이트 = 서버 게이트(adminOrMaster). `_wrCanRetire()` 재사용 금지 —
     그쪽은 staff 까지 열려 있어 따라 넓히면 AE 에게 403 나는 죽은 버튼이 생긴다. */
  ok('★ 게이트는 무시트 + master/admin(서버 adminOrMaster 와 1:1)',
    /function _ddCan\(\)\{[\s\S]{0,240}sheetless === true[\s\S]{0,120}'master'[\s\S]{0,40}'admin'/.test(wd));
  ok('★ staff 까지 열린 _wrCanRetire 를 재사용하지 않는다',
    !/function _ddCan\(\)\{[^}]*_wrCanRetire\(\)/.test(wd));
  ok('미리보기는 dryRun:true', /ddPreview[\s\S]{0,400}dryRun: true/.test(wd));
  ok('실행은 확인창을 거친다', /async function ddRun[\s\S]{0,600}confirm\(/.test(wd));
  ok('미리보기 없이는 실행 버튼이 잠긴다', /go\.disabled = !\(p && p\.removeRows > 0\)/.test(wd));
  ok('보류 사유를 화면이 그대로 말한다(조용한 누락 금지)', /g\.detail \|\| g\.reason/.test(wd));
  ok('미리보기에 주문번호 열이 있다(사람이 판정 근거를 본다)',
    /<th>주문번호<\/th>/.test(wd) && /esc\(String\(g\.orderNum \|\| ''\)\)/.test(wd));
  ok('보류 목록에도 주문번호를 적는다', /주문번호 \$\{esc\(String\(g\.orderNum/.test(wd));
  ok('판정 규칙을 화면이 문장으로 말한다(표 주문번호 기준 · 다르면 다른 참여건)',
    /표에 보이는 주문번호가 같고/.test(wd) && /주문번호가 다르면 각기 다른 참여건/.test(wd)
    && /6자리 미만인 줄은/.test(wd));
  ok('표에 주문번호가 없어 제외된 줄 수를 고지한다', /skippedNoRowOrder/.test(wd));
  ok('오버레이는 body 직속', /appendChild\(ov\);\s*\/\/ ★ body 직속/.test(wd.slice(wd.indexOf('function openDedupeModal'))));
  ok('Esc 리스너는 최상위 1회', /window\._ddKeyBound/.test(wd));
  {
    const blk = wd.slice(wd.indexOf('function _ddRender'), wd.indexOf('async function ddPreview'));
    /* ★ 서버발 값(작업명·사유 등)은 전부 `esc()` 를 거쳐야 한다.
       중첩 템플릿이 있어 정규식 한 방으로는 오탐이 나므로, **중괄호 안쪽 조각**을 하나씩 꺼내
       그 안에 위험한 필드가 있으면 같은 조각에 `esc(` 도 있는지 본다. */
    const risky = /\b(tabName|label|detail|reason|\.name)\b/;
    const bad = (blk.match(/\$\{[^{}]*\}/g) || []).filter(x => risky.test(x) && !/esc\(/.test(x));
    ok('서버발 문자열은 전부 escape 한다', bad.length === 0, bad.join(' | '));
    // ★ onclick 에는 **배열 인덱스(`${i}`)만** 넣는다 — 작업명·주문번호 보간 금지.
    ok('onclick 에는 인덱스만 넣는다', !/onclick="[^"]*\$\{(?!i\})/.test(blk));
  }

  console.log('\n[G] 전체 작업 일괄 점검 — 판정 사본 0 · 읽기 전용');
  {
    const led3 = require('../src/services/sheetlessLedger.service');
    const seenDry = [];
    // ★ 스캔이 판정 함수를 **그대로** 부르는지(사본 금지) + 전부 dryRun 인지 실행으로 본다.
    //   모듈 내부 호출은 렉시컬이라 export 교체가 안 먹으므로 주입 인자를 쓴다(레포 선례와 동일).
    const fakeDedupe = async (a) => {
      seenDry.push(a);
      if (a.tabName === 'T_ERR') { const e = new Error('boom'); e.code = 'not_sheetless'; throw e; }
      return a.tabName === 'T_A'
        ? { boardRows: 587, groups: 7, removeRows: 112, skippedGroups: 2, skippedNoRowOrder: 1 }
        : { boardRows: 10, groups: 0, removeRows: 0, skippedGroups: 0, skippedNoRowOrder: 0 };
    };
    led3.__setPoolForTest({
      query: async (sql) => {
        if (/FROM tab_configs[\s\S]*sheetless/.test(sql)) return { rows: [
          { sheetId: 'wt_a', tabName: 'T_A', label: '8/3 위프 800건' },
          { sheetId: 'wt_b', tabName: 'T_B', label: '깨끗한 작업' },
          { sheetId: 'wt_c', tabName: 'T_ERR', label: '점검 실패 작업' },
        ] };
        return { rows: [] };
      },
    });
    const r = await led3.scanDuplicateRows({ by: '망고', dedupeFn: fakeDedupe });
    ok('무시트 탭 전체를 훑는다', r.scanned === 3);
    ok('★ 판정은 dedupeRows 를 그대로 재사용(사본 0)', seenDry.length === 3);
    ok('★ 전부 dryRun — 쓰기 0', seenDry.every(a => a.dryRun === true));
    ok('중복 있는 작업만 목록에 담는다', r.tabs.length === 1 && r.tabs[0].tabName === 'T_A');
    ok('합계를 낸다', r.totalRemoveRows === 112 && r.totalSkipped === 2);
    ok('★ 한 탭이 실패해도 나머지는 계속하고 사유를 보고한다',
      r.failed === 1 && r.errors[0].tabName === 'T_ERR' && r.errors[0].reason === 'not_sheetless');
    led3.__setPoolForTest(null);
  }
  {
    const ledSrc2 = fs.readFileSync(path.join(__dirname, '../src/services/sheetlessLedger.service.js'), 'utf8');
    const scanSrc = ledSrc2.slice(ledSrc2.indexOf('async function scanDuplicateRows('), ledSrc2.indexOf('module.exports'));
    ok('★ 스캔은 무시트 탭만 고른다', /COALESCE\(sheetless, FALSE\) = TRUE/.test(scanSrc));
    ok('★ 스캔 자체에 쓰기 쿼리가 없다', !/(INSERT INTO|UPDATE |DELETE FROM)/i.test(scanSrc));
    ok('★ 판정 조건 사본이 없다(주문번호·연락처 비교를 다시 쓰지 않는다)',
      !/order_num|row_json|주문번호/.test(scanSrc));
    ok('상한을 넘으면 잘렸다고 말한다', /truncated/.test(scanSrc));
    ok('★ 런타임 기본 판정은 dedupeRows(주입은 테스트용 기본값)', /dedupeFn = dedupeRows/.test(scanSrc));
    const tb2 = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
    ok('일괄 점검 라우트는 adminOrMaster',
      /'\/worktable\/dedupe-scan', authMiddleware, adminOrMasterMiddleware/.test(tb2));
    ok('화면에 [전체 작업 점검] 버튼', /onclick="ddScanAll\(\)"/.test(wd));
    ok('결과에서 작업으로 이동(onclick 은 인덱스만)', /ddOpenTab\(\$\{i\}\)/.test(wd));
    ok('목록에 없는 작업이면 사유를 말한다(막다른 길 금지)', /그 작업이 지금 목록에 없습니다/.test(wd));
  }

  /* ── [F] 진짜 PG (선택) — 스텁은 SQL 을 해석하지 않는다 ──────────────────────
     `PGTEST_URL=postgres://... node server/tests/worktableDuplicateGuard.test.js`
     표 주문번호(row_json) 추출과 숫자 정규화가 **실제로** 도는지 확인한다. */
  if (process.env.PGTEST_URL) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.PGTEST_URL });
    await c.connect();
    await c.query(`DROP TABLE IF EXISTS campaign_participants, order_submissions, payment_batch_items`);
    await c.query(`CREATE TABLE campaign_participants(seq int, sheet_id text, tab_name text,
      order_submission_id uuid, reviewer_name text, is_submitted bool, is_paid bool, row_json jsonb, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE order_submissions(id uuid primary key, order_num text, phone text, deleted_at timestamptz)`);
    await c.query(`CREATE TABLE payment_batch_items(sheet_id text, tab_name text, row_index int, status text)`);
    // ★ 실사고 재현: 원장 주문번호는 같은데 **표에 보이는 주문번호가 다르다**
    await c.query(`INSERT INTO order_submissions VALUES
      ('11111111-1111-1111-1111-111111111111','231020413029 15','010-5147-5613',NULL),
      ('22222222-2222-2222-2222-222222222222','231020413029 15','010-5147-5613',NULL)`);
    await c.query(`INSERT INTO campaign_participants VALUES
      (19 ,'wt_x','T1','11111111-1111-1111-1111-111111111111','신다인',false,false,
        '{"번호":"1","주문번호":"23102041302915"}',NULL),
      (407,'wt_x','T1','22222222-2222-2222-2222-222222222222','신다인',false,false,
        '{"번호":"389","주문번호":"23102367337800"}',NULL)`);
    const src = fs.readFileSync(path.join(__dirname, '../src/services/sheetlessLedger.service.js'), 'utf8');
    const tpl = src.match(/`SELECT cp\.seq, cp\.order_submission_id AS osid[\s\S]*?ORDER BY cp\.seq`/)[0];
    const { rows: r } = await c.query(eval(tpl), ['wt_x', 'T1']);   // eslint-disable-line no-eval
    ok('PG: 쿼리가 실제로 실행된다(문법·jsonb 추출)', r.length === 2);
    ok('PG: 숫자만 정규화된다', r[0].ordnum === '23102041302915' && r[0].ph === '01051475613');
    ok('PG: 표 주문번호를 row_json 에서 뽑는다', r[0].roword === '23102041302915' && r[1].roword === '23102367337800');
    ok('PG: 원장이 같아도 표가 다르면 다른 그룹', r[0].roword !== r[1].roword && r[0].ordnum === r[1].ordnum);
    await c.end();
  } else {
    console.log('\n[F] 진짜 PG 검증 건너뜀 (PGTEST_URL 미설정)');
  }

  console.log(`\n총 ${pass}개 통과`);
  process.exit(0);
})();
