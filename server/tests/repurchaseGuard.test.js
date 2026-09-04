/**
 * repurchaseGuard.test.js — 재참여(재구매) 기간 제한(사용자 확정 2026-08-24) 회귀가드.
 *
 * 배경: 8/20에 참여·구매완료한 리뷰어가 8/24에 같은 작업(탭)을 관리자 [외부모집 수동제출]
 *   화면으로 다시 등록해도 통과됐다. 원인 = 캠페인 단위(recruit_campaigns.id + phone8) 영구
 *   차단이 이 화면에서는 "모집공고를 지정했을 때만" 작동해, 공고 미지정으로 등록하면 24시간
 *   중복 체크(그나마도 24시간뿐)만 남았다.
 *
 * ★★ 완화 금지 불변식
 *   ① 판정 단일 출처 = utils/repurchaseGuard — 리뷰어 셀프 참여(campaign.routes)와
 *      관리자 외부모집 수동제출(manualOrder.service)이 같은 함수를 쓴다.
 *   ② 기준 = "같은 작업 전체"(sheet_id + tab_configs.campaign_name) + phone8 — 구매일별 탭이
 *      달라도 같은 작업명으로 묶이며, 작업명 없는 레거시 탭만 (sheet_id, tab_name)으로 폴백한다.
 *   ③ 취소된 주문(deleted_at 有)은 세지 않는다.
 *   ④ 모르면 막지 않는다(fail-open) — 탭·번호 판정 불가는 통과.
 *   ⑤ 예외(강제 통과)는 관리자 외부모집 수동제출에만 있다 — 리뷰어 셀프 참여는 예외 없음.
 *
 * 실행: node tests/repurchaseGuard.test.js
 */
process.env.PGTEST_SKIP_BOOT = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
const readS = (p) => normalizeEol(fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8'));
const readF = (p) => normalizeEol(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8'));

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };
const eq = (name, got, want) => ok(`${name} → ${JSON.stringify(got)}`, JSON.stringify(got) === JSON.stringify(want));

(async () => {
  const { checkRepurchaseWindow, checkRepurchaseWindowBatch, phone8Of, repurchaseDays,
    repurchaseWindowFromSubmittedAt } =
    require('../src/utils/repurchaseGuard');

  /* ═══ 1. fail-open — 판정 불가는 항상 통과 ═══ */
  console.log('\n[1] fail-open (모르면 막지 않는다)');
  eq('sheetId 없음 → 통과', (await checkRepurchaseWindow({ query: async () => { throw new Error('DB 호출 금지'); } },
    { sheetId: '', tabName: 't', phone8: '12345678' })).blocked, false);
  eq('tabName 없음 → 통과', (await checkRepurchaseWindow({ query: async () => { throw new Error('DB 호출 금지'); } },
    { sheetId: 's', tabName: '', phone8: '12345678' })).blocked, false);
  eq('phone8 7자리(불완전) → 통과', (await checkRepurchaseWindow({ query: async () => { throw new Error('DB 호출 금지'); } },
    { sheetId: 's', tabName: 't', phone8: '1234567' })).blocked, false);

  const origDays = process.env.CAMPAIGN_REPARTICIPATE_DAYS;
  process.env.CAMPAIGN_REPARTICIPATE_DAYS = '0';
  eq('킬스위치(=0) → DB 호출 없이 통과', (await checkRepurchaseWindow({ query: async () => { throw new Error('DB 호출 금지'); } },
    { sheetId: 's', tabName: 't', phone8: '12345678' })).blocked, false);
  delete process.env.CAMPAIGN_REPARTICIPATE_DAYS;
  eq('기본값 14일', repurchaseDays(), 14);
  eq('공고 설정 7일', repurchaseDays(7), 7);
  eq('공고 설정 21일', repurchaseDays(21), 21);
  eq('공고 설정 제한 없음(0일)', repurchaseDays(0), 0);
  eq('공고 설정 범위 밖이면 기본값', repurchaseDays(366), 14);
  eq('공고별 제한 없음(0일) → DB 호출 없이 통과',
    (await checkRepurchaseWindow({ query: async () => { throw new Error('DB 호출 금지'); } },
      { sheetId: 's', tabName: 't', phone8: '12345678', days: 0 })).blocked, false);
  process.env.CAMPAIGN_REPARTICIPATE_DAYS = '0';
  eq('운영 킬스위치 0은 공고별 21일보다 우선', repurchaseDays(21), 0);
  process.env.CAMPAIGN_REPARTICIPATE_DAYS = origDays;
  {
    const submittedAt = new Date('2026-09-04T00:00:00Z');
    eq('같은 공고 제출도 14일 안에는 차단',
      repurchaseWindowFromSubmittedAt(submittedAt, 14, new Date('2026-09-17T23:59:59Z').getTime()).blocked, true);
    eq('같은 공고 제출도 14일 경과 후 허용',
      repurchaseWindowFromSubmittedAt(submittedAt, 14, new Date('2026-09-18T00:00:01Z').getTime()).blocked, false);
    eq('같은 공고 제출도 제한 없음(0일)이면 즉시 허용',
      repurchaseWindowFromSubmittedAt(submittedAt, 0, submittedAt.getTime()).blocked, false);
  }

  /* ═══ 2. 정상 판정 — 스텁 DB ═══ */
  console.log('\n[2] 정상 판정(스텁 pool)');
  let lastSql = null, lastParams = null;
  const stubDb = (rows) => ({
    query: async (sql, params) => { lastSql = String(sql); lastParams = params; return { rows }; },
  });

  {
    const r = await checkRepurchaseWindow(stubDb([]), { sheetId: 's1', tabName: 't1', phone: '010-8636-5441' });
    eq('일치 없음 → 통과', r.blocked, false);
    ok('phone은 함수 안에서 phone8로 변환됨(문자열 8자리 파라미터)', lastParams[2] === '86365441');
  ok('쿼리에 기준 sheet_id 조건 포함', lastSql.includes('os.sheet_id = $1'));
  ok('★ 같은 작업명(campaign_name)으로 구매일별 탭을 묶음',
    lastSql.includes('scope.work_name') && lastSql.includes('submitted_tab.campaign_name'));
  ok('★ 작업명 없는 레거시 탭만 tab_name 단위 폴백', lastSql.includes('scope.work_name IS NULL AND os.tab_name = $2'));
    ok('★ 취소된 주문 제외 조건 포함', lastSql.includes('deleted_at IS NULL'));
    ok('★ 기간 창은 make_interval(days=>) 파라미터화 — 하드코딩 아님', lastSql.includes('make_interval(days => $4)'));
    ok('★ 같은 공고 submitted 폴백과 주문 원장 중 최신 시각을 사용',
      lastSql.includes('campaign_applications ca') && lastSql.includes('MAX(submitted_at) AS submitted_at'));
  }

  {
    const submittedAt = new Date(Date.now() - 86400000);
    const r = await checkRepurchaseWindow(stubDb([{ submitted_at: submittedAt }]),
      { sheetId: 's1', tabName: 't1', phone8: '86365441' });
    eq('최근 이력 있음 → 차단', r.blocked, true);
    eq('14일 뒤가 재참여 가능일', r.availableFrom.toISOString(),
      new Date(submittedAt.getTime() + 14 * 86400000).toISOString());
    eq('days 필드 = 14', r.days, 14);
  }
  {
    const submittedAt = new Date(Date.now() - 86400000);
    const r = await checkRepurchaseWindow(stubDb([{ submitted_at: submittedAt }]),
      { sheetId: 's1', tabName: 't1', phone8: '86365441', days: 7 });
    eq('공고별 7일 값이 SQL 기간 파라미터에 적용', lastParams[3], 7);
    eq('공고별 7일 뒤가 재참여 가능일', r.availableFrom.toISOString(),
      new Date(submittedAt.getTime() + 7 * 86400000).toISOString());
  }
  {
    const submittedAt = new Date(Date.now() - 2 * 86400000);
    const r = await checkRepurchaseWindow(stubDb([{ submitted_at: submittedAt }]),
      { campaignId: 'legacy-campaign', phone8: '86365441', days: 14 });
    eq('작업 탭 연결이 없어도 같은 공고 submitted 이력으로 차단', r.blocked, true);
    eq('공고 id가 SQL 폴백 파라미터에 전달', lastParams[4], 'legacy-campaign');
  }

  /* ═══ 3. 배치 판정 ═══ */
  console.log('\n[3] checkRepurchaseWindowBatch');
  {
    const rows = [{ p8: '86365441', last_at: new Date('2026-08-20T00:00:00Z') }];
    const r = await checkRepurchaseWindowBatch(stubDb(rows),
      { sheetId: 's1', tabName: 't1', phone8List: ['86365441', '86365441', '11112222'] });
    eq('막힌 번호만 맵에 담김(1건)', r.size, 1);
    ok('막힌 번호가 정확히 매칭됨', r.get('86365441') && r.get('86365441').blocked === true);
    ok('막히지 않은 번호는 맵에 없음', !r.has('11112222'));
    ok('배치도 같은 공고 submitted 폴백을 포함', lastSql.includes('campaign_applications ca'));
  }
  {
    const rows = [{ p8: '86365441', last_at: new Date(Date.now() - 2 * 86400000) }];
    const r = await checkRepurchaseWindowBatch(stubDb(rows),
      { campaignId: 'legacy-campaign', phone8List: ['86365441'], days: 14 });
    eq('작업 탭 연결 없는 수동제출 배치도 공고 이력으로 차단', r.get('86365441').blocked, true);
    eq('배치 공고 id가 SQL 폴백 파라미터에 전달', lastParams[4], 'legacy-campaign');
  }
  {
    const r = await checkRepurchaseWindowBatch({ query: async () => { throw new Error('호출 금지'); } },
      { sheetId: 's1', tabName: 't1', phone8List: [] });
    eq('빈 목록 → DB 호출 없이 빈 맵', r.size, 0);
  }

  eq('phone8Of: 하이픈·문자 제거 후 끝 8자리', phone8Of('010-8636-5441'), '86365441');

  /* ═══ 4. 배선 — 리뷰어 셀프 참여(campaign.routes.js) ═══ */
  console.log('\n[4] 배선: 리뷰어 셀프 참여');
  const campFull = readS('routes/campaign.routes.js');
  // ★ _applyParticipation 함수 본문만 본다 — 그 밖(예: /my-repurchase-status 라우트)에도
  //   같은 require 문자열이 등장해 파일 전체를 훑으면 엉뚱한 자리를 짚는다.
  const iApplyFnStart = campFull.indexOf('async function _applyParticipation');
  ok('_applyParticipation 함수를 찾음', iApplyFnStart > -1);
  const camp = campFull.slice(iApplyFnStart);
  ok('★ /my-repurchase-status 라우트도 등록되어 있다(카드 표시용 배치 조회)',
    campFull.includes(`router.get('/my-repurchase-status'`) && campFull.indexOf(`router.get('/my-repurchase-status'`) < iApplyFnStart);
  const iFallback = camp.indexOf('sameCampaignSubmittedAt = b0.submitted_at');
  const iGuard = camp.indexOf(`require('../utils/repurchaseGuard')`);
  const iExpireSweep = camp.indexOf('만료 스윕은 정리 작업이지만');
  ok('utils/repurchaseGuard 를 사용한다', iGuard > -1);
  ok('★ 순서: 같은 공고 제출시각 폴백 → 재구매 가드 → 만료 스윕',
    iFallback > -1 && iGuard > iFallback && iExpireSweep > iGuard);
  ok('★ 같은 공고 제출을 already_submitted로 영구 차단하지 않는다',
    !camp.includes(`reason: 'already_submitted'`));
  ok('★ 비연결/레거시 공고도 같은 공고 제출시각으로 기간을 계산',
    camp.includes('repurchaseWindowFromSubmittedAt(sameCampaignSubmittedAt, camp.repurchase_days, now.getTime())'));
  ok('reason: repurchase_window 반환', camp.includes(`reason: 'repurchase_window'`));
  ok('★ camp.linked_sheet_id/linked_tab_name를 시작점으로 같은 작업 전체를 판정',
    camp.includes('camp.linked_sheet_id') && camp.includes('camp.linked_tab_name'));
  ok('★ 셀프 참여 가드는 campaignId도 전달해 원장·공고 이력 중 최신값을 사용',
    camp.includes('campaignId: id, phone8: holdP8'));
  ok('★ holdP8(본계정/타계정 신원)로 판정 — 로그인 phone8만 보지 않는다', camp.includes('phone8: holdP8'));
  ok('★★ 셀프 참여는 예외(강제 통과) 없음 — allowRepurchase 미사용',
    !camp.slice(iGuard, iGuard + 1500).includes('allowRepurchase'));
  ok('조회 실패는 fail-open(catch에서 warn만, ROLLBACK 없음)',
    /catch \(e\) \{\s*logger\.warn\('\[campaign\/apply\] 재참여 기간 판정 실패/.test(camp));

  /* ═══ 4b. 배선 — 카드 표시용 배치 조회 라우트 ═══ */
  console.log('\n[4b] 배선: /my-repurchase-status 라우트(카드 배지 재료)');
  const iMyStatusRoute = campFull.indexOf(`router.get('/my-repurchase-status'`);
  const iIdRoute = campFull.indexOf(`router.get('/:id'`);
  ok('★ 라우트 등록 순서: /:id 보다 앞(뒤에 두면 /:id 가 이 경로를 id로 삼킨다)',
    iMyStatusRoute > -1 && iIdRoute > -1 && iMyStatusRoute < iIdRoute);
  ok('★ 카드 상태 조회는 서명된 리뷰어 세션 필수',
    campFull.slice(iMyStatusRoute, iIdRoute).includes('reviewerSessionMiddleware'));
  ok('★ 요청 phone8을 신원으로 쓰지 않고 세션 소유자 ID로 계정을 조회',
    campFull.slice(iMyStatusRoute, iIdRoute).includes('[req.reviewer.ownerReviewerId]') &&
    !campFull.slice(iMyStatusRoute, iIdRoute).includes('req.query.phone8'));
  ok('★ 자유 편집 타계정은 이력 조회 신원으로 사용하지 않음',
    campFull.slice(iMyStatusRoute, iIdRoute).includes("req.reviewer.loginKind !== 'self'") &&
    !campFull.slice(iMyStatusRoute, iIdRoute).includes('SELECT name, phone8, sub_accounts') &&
    !campFull.slice(iMyStatusRoute, iIdRoute).includes('for (const sub of subs)'));
  ok('계정별 상태 배치 계산 단일 출처 사용',
    campFull.slice(iMyStatusRoute, iIdRoute).includes('checkRepurchaseStatusForAccounts'));
  ok('ids 파라미터에 상한(무제한 배치 방지)', /\.slice\(0,\s*100\)/.test(campFull.slice(iMyStatusRoute, iIdRoute)));

  const { checkRepurchaseStatusForAccounts } = require('../src/utils/repurchaseGuard');
  {
    let statusSql = '';
    const rows = [
      { campaign_id: 'camp_locked', repurchase_days: 21, phone8: '86365441', last_submitted_at: new Date(Date.now() - 10 * 86400000) },
      { campaign_id: 'camp_ready', repurchase_days: 7, phone8: '86365441', last_submitted_at: new Date(Date.now() - 10 * 86400000) },
      { campaign_id: 'camp_unlimited', repurchase_days: 0, phone8: '86365441', last_submitted_at: new Date(Date.now() - 1 * 86400000) },
    ];
    const r = await checkRepurchaseStatusForAccounts({ query: async (sql) => { statusSql = String(sql); return { rows }; } },
      { campaignIds: ['camp_locked', 'camp_ready', 'camp_never'], phone8List: ['86365441'] });
    eq('10일 전 참여 + 공고별 21일 → locked', r.get('86365441').get('camp_locked').status, 'locked');
    ok('locked 건은 availableFrom 동봉(카드가 날짜를 그리는 재료)', r.get('86365441').get('camp_locked').availableFrom instanceof Date);
    eq('10일 전 참여 + 공고별 7일 → ready', r.get('86365441').get('camp_ready').status, 'ready');
    ok('공고별 제한 없음(0일)은 상태 맵에서도 제외', !r.get('86365441').has('camp_unlimited'));
    ok('★ 참여 이력이 아예 없는 공고는 맵에 없음(=평소 카드, 0/false로 꾸미지 않는다)', !r.get('86365441').has('camp_never'));
    ok('★ 주문 원장이 없는 같은 공고 submitted 이력도 상태 조회 폴백에 포함',
      statusSql.includes('campaign_applications ca') && statusSql.includes("ca.status = 'submitted'"));
    ok('★ 연결 주문이 취소된 신청 이력은 제외하고 원장 없는 레거시만 유지',
      statusSql.includes('ca.order_submission_id IS NULL OR EXISTS') &&
      statusSql.includes('linked_os.deleted_at IS NULL'));
    eq('★ 셀프·배치·카드의 신청 이력 폴백이 모두 취소 주문을 제외',
      (readS('utils/repurchaseGuard.js').match(/ca\.order_submission_id IS NULL OR EXISTS/g) || []).length, 3);
  }
  {
    const origDays = process.env.CAMPAIGN_REPARTICIPATE_DAYS;
    process.env.CAMPAIGN_REPARTICIPATE_DAYS = '0';
    const r = await checkRepurchaseStatusForAccounts({ query: async () => { throw new Error('호출 금지'); } },
      { campaignIds: ['x'], phone8List: ['86365441'] });
    eq('★ 킬스위치(=0) → 배지 기능도 함께 꺼짐(제한 없는데 "N일 후" 안내가 뜨는 모순 방지)', r.size, 0);
    process.env.CAMPAIGN_REPARTICIPATE_DAYS = origDays;
  }

  /* ═══ 5. 배선 — 관리자 외부모집 수동제출(manualOrder.service.js) ═══ */
  console.log('\n[5] 배선: 외부모집 수동제출 서비스');
  const svc = readS('services/manualOrder.service.js');
  ok('allowRepurchase 파라미터 존재', svc.includes('allowRepurchase = false'));
  const iDup24h = svc.indexOf('24시간 내에 이미 접수돼 있습니다');
  const iRepurchase = svc.indexOf(`require('../utils/repurchaseGuard')`);
  const iLedger = svc.indexOf('createOrderLedgerEntry({');
  ok('★ 순서: 24시간 중복확인 → 재참여 가드 → 주문 원장 기록',
    iDup24h > -1 && iRepurchase > iDup24h && iLedger > iRepurchase);
  ok('★ 수동제출에도 campaign_applications submitted 영구차단이 남아 있지 않음',
    !svc.includes("status = 'submitted' LIMIT 1"));
  // ★★ 핵심 회귀: 캠페인 지정 여부와 무관하게 항상 검사해야 한다(이번 사고의 원인이
  //   "campaignId 없으면 검사 자체가 스킵"이었으므로, if(campaignId) 안에 갇히면 안 된다).
  const block = svc.slice(iRepurchase - 400, iRepurchase + 900);
  ok('★★ campaignId 유무와 무관하게 항상 검사(if(campaignId) 블록 밖)',
    !/if \(campaignId\) \{[\s\S]{0,50}checkRepurchaseWindow/.test(block));
  ok('강제 통과 시 접수 결과에 경고를 남긴다(조용한 우회 금지)',
    svc.includes('재참여 기간 제한을 넘겨 접수했습니다(관리자 확인됨)'));
  ok('repurchaseBlocked 필드로 사유를 되돌린다', svc.includes('repurchaseBlocked: true'));
  ok('★ 건별 최종 가드도 campaignId를 전달해 공고 submitted 폴백을 적용',
    svc.includes('sheetId, tabName, campaignId, phone: f.phone'));

  /* ═══ 6. 배선 — 라우트(사전 배치 판정) ═══ */
  console.log('\n[6] 배선: 라우트 사전 판정');
  const rt = readS('routes/manualOrder.routes.js');
  ok('checkRepurchaseWindowBatch import', rt.includes('checkRepurchaseWindowBatch'));
  ok('★ 배치 사전 가드도 campaignId를 전달해 공고 submitted 폴백을 적용',
    rt.includes('sheetId, tabName, campaignId, phone8List: p8List'));
  ok(`needConfirm: 'repurchase_window' 를 쓰기 전에(배치 시작 전) 되돌린다`,
    rt.includes(`needConfirm: 'repurchase_window'`));
  ok('allowRepurchase 를 서비스 호출에 전달', /allowRepurchase,\s*\/\//.test(rt));
  const iPreCheck = rt.indexOf('checkRepurchaseWindowBatch(pool');
  const iDailyPre = rt.indexOf('일 정원(오늘 몫) 사전 판정');
  ok('★ 재참여 사전 판정이 일 정원 사전 판정보다 먼저(둘 다 "쓰기 전에 막는다" 원칙)',
    iPreCheck > -1 && iDailyPre > -1 && iPreCheck < iDailyPre);

  /* ═══ 7. 배선 — 프론트(관리자 확인창) ═══ */
  console.log('\n[7] 배선: 프론트 확인창');
  const fe = readF('js/manual-order.js');
  ok(`needConfirm === 'repurchase_window' 분기 존재`, fe.includes(`out.needConfirm === 'repurchase_window'`));
  ok('allowRepurchase 를 요청 본문에 싣는다', fe.includes('allowRepurchase: allowRepurchase === true'));
  ok('★★ over_daily 재확인 체인에서도 재참여 확인 상태(_repurchaseOk)를 잃지 않는다(연쇄 확인 시 우회 방지)',
    fe.includes('post(true, _repurchaseOk)'));
  ok('확인 취소 시 쓰기 0건(서버 재호출 없이 return)',
    /needConfirm === 'repurchase_window'[\s\S]{0,900}if \(!okGo\) \{[\s\S]{0,200}return;/.test(fe));

  /* ═══ 8. 배선 — 리뷰어 홈 썸네일 배지(시안 A, 사용자 확정) ═══ */
  console.log('\n[8] 배선: 리뷰어 홈 카드 배지');
  const cc = readF('js/campaign-cards.js');
  ok('pt-sash(하단 띠) CSS 존재 — A안', cc.includes('.pt-sash{position:absolute;left:0;right:0;bottom:0'));
  ok('lock/ready 두 상태 모두 스타일 존재', cc.includes('.pt-sash.lock{') && cc.includes('.pt-sash.ready{'));
  ok('★ 관리자 카드에는 렌더하지 않는다(!admin 게이트) — 집계 화면엔 "내 참여" 개념이 안 맞는다',
    cc.includes('const repurchaseLocked = !admin') && cc.includes('if (!admin && repReady.length)'));
  ok('c.repurchase 가 없으면 빈 문자열(=평소 카드, 조용히 무동작)', cc.includes(`let repurchaseSash = '';`));
  ok('썸네일 마크업에 삽입됨', cc.includes('${topleft}${repurchaseSash}${editChip}${moChip}'));
  ok('★ 잠긴 상태에서 [참여하기] 버튼도 함께 막는다(카드는 열려 보이는데 실제 참여만 막히는 상태 방지)',
    cc.includes(`if (c.state === 'open' && repurchaseLocked)`));

  const idx = readF('index.html');
  ok('/api/campaign/my-repurchase-status 조회 함수 존재', idx.includes('_rcLoadRepurchaseStatus'));
  ok('★ 카드 상태 조회에 리뷰어 세션 토큰을 전달',
    idx.includes('headers: { "X-Reviewer-Token": reviewerToken }'));
  ok('★ 같은 (번호+공고목록) 조합은 재조회하지 않는다(재렌더→재조회 순환 방지)',
    idx.includes('if (key === _rcRepurchaseFetchKey) return;'));
  ok('조회 실패해도 목록 렌더 자체는 살아있다(부가 정보 취급)',
    /catch \(_\) \{ \/\* 재참여 안내는 부가 정보/.test(idx));
  ok('카드 데이터에 계정별 상태를 병합 후 CampCards.cardHtml 호출', idx.includes('if (rs) c.repurchase = rs'));
  ok('★ 상태 응답 교체 전 요청 공고의 옛 캐시를 지워 0일 전환 즉시 잠금 해제',
    idx.includes('ids.forEach(id => { delete nextStatus[id]; });') &&
    !idx.includes('if (!Object.keys(status).length) return;'));

  console.log(`\n✅ repurchaseGuard: ${n}개 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e.message); console.error(e.stack); process.exit(1); });
