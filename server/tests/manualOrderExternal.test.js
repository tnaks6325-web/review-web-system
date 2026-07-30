/**
 * manualOrderExternal.test.js — 외부모집 구매양식 관리자 수동제출 회귀가드
 * 실행: node tests/manualOrderExternal.test.js   (DB·서버 기동 불필요)
 *
 * 무엇을 고정하는가
 *  A. 슬래시양식 파서 — 특히 **주소 슬래시 병합**(칸 밀림 사고의 원인)을 순수함수 실행으로 검증
 *  B. 서비스 — 스텁 db/client 로 **실제 함수를 호출**해 분기·SQL을 확인
 *     (문자열 grep 만으로는 "선언 누락·스코프"를 못 본다 — 063 #361 실사고의 교훈)
 *  C. 라우트 — 3개 전부 admin/master 게이트 뒤인지 실제 라우터 스택에서 확인
 *  D. 프론트 — 진입점 3곳 배선 + **스코프 토큰에게 버튼을 보여주지 않는지**(403 막다른 길 금지)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
/** 주석을 걷어낸 소스 — "주석에만 있는 문자열"이 가드를 통과시키는 위양성 차단 */
const nc = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

async function main() {
console.log('\n▶ manualOrderExternal 회귀가드\n');

/* ══════════════════════════════════════════════════════════
   A. 슬래시양식 파서 (순수함수 실행)
   ══════════════════════════════════════════════════════════ */
console.log('A. 슬래시양식 파서');
const { parseSlashLine, parseSlashForm, formatPhone, parsePrice } = require('../src/utils/slashForm');

const BASE = '이시현/이시현/kirei223/010-7701-1701/부산시 수영구 광안동 119-3번지, 109호/신한은행/496-04-007701/이시현/15800';
{
  const r = parseSlashLine(BASE);
  ok('A1 기본 9칸이 정상 파싱된다', r.ok === true && r.errors.length === 0);
  ok('A2 각 칸이 제자리에 들어간다', r.fields.reviewerName === '이시현' && r.fields.userId === 'kirei223'
    && r.fields.bank === '신한은행' && r.fields.account === '496-04-007701'
    && r.fields.depositor === '이시현' && r.fields.price === 15800);
  ok('A3 본인 건은 isSubAccount=false', r.fields.isSubAccount === false);
}
{
  // ★★ 핵심 불변식: 주소에 슬래시가 있어도 뒤 4칸(은행·계좌·예금주·금액)이 밀리지 않는다.
  //    단순 split('/') 였다면 은행 칸에 "302호"가, 금액 칸에 예금주가 들어간다.
  const line = '김하나/김하나/hana1/010-1111-2222/서울시 마포구 월드컵로 12/3, 302호/국민은행/123-456-789/김하나/28,900원';
  const r = parseSlashLine(line);
  ok('A4 주소 슬래시 1개 — 주소로 합쳐진다', r.fields.address === '서울시 마포구 월드컵로 12/3, 302호');
  ok('A5 주소 슬래시가 있어도 뒤 4칸이 안 밀린다', r.fields.bank === '국민은행'
    && r.fields.account === '123-456-789' && r.fields.depositor === '김하나' && r.fields.price === 28900);
  ok('A6 주소 병합은 경고로 알린다(사람 확인 유도)', r.warnings.some(w => w.includes('슬래시')));
  ok('A7 주소 병합만으로는 오류가 아니다', r.ok === true);
}
{
  const line = 'A/A/id/010-1111-2222/가/나/다/라/마/국민은행/1/A/1000';   // 주소에 슬래시 5개
  const r = parseSlashLine(line);
  ok('A8 주소 슬래시 여러 개도 전부 주소로', r.fields.address === '가/나/다/라/마' && r.fields.bank === '국민은행');
}
{
  const r = parseSlashLine('이름/이름/id/010-1111-2222/주소');
  ok('A9 칸이 부족하면 실패 + 사유 안내', r.ok === false && /칸이 5개뿐/.test(r.errors[0]));
}
{
  const r = parseSlashLine('박서준/이서연/psj/010-3333-4444/서울시 강남구 1/신한/1-2-3/이서연/10000');
  ok('A10 리뷰어≠수취인이면 타계정으로 판정', r.fields.isSubAccount === true);
  const r2 = parseSlashLine('박 서준/박서준/psj/010-3333-4444/서울시 강남구 1/신한/1-2-3/박서준/10000');
  ok('A11 공백 차이는 타계정이 아니다', r2.fields.isSubAccount === false);
}
{
  const r = parseSlashLine('A/A/id/01011112222/주소/신한/1/A/1000');
  ok('A12 전화 11자리는 하이픈 표기로 통일', r.fields.phone === '010-1111-2222');
  const r10 = parseSlashLine('A/A/id/0101112222/주소/신한/1/A/1000');
  ok('A13 10자리는 오류가 아니라 경고 — 제출은 하되 자동등록만 생략',
    r10.ok === true && r10.warnings.some(w => w.includes('자동등록')));
  const rBad = parseSlashLine('A/A/id/12345/주소/신한/1/A/1000');
  ok('A14 자릿수가 아예 이상하면 오류', rBad.ok === false && rBad.errors.some(e => e.includes('자릿수')));
}
{
  ok('A15 금액 콤마·원 표기를 숫자로', parsePrice('15,800원') === 15800 && parsePrice('28900') === 28900);
  ok('A16 금액을 못 읽으면 null', parsePrice('무료') === null);
  const r = parseSlashLine('A/A/id/010-1111-2222/주소/신한/1/A/없음');
  ok('A17 금액 파싱 실패는 오류', r.ok === false && r.errors.some(e => e.includes('결제금액')));
}
{
  const r = parseSlashLine('A/A/id/010-1111-2222//신한/1/A/1000');
  ok('A18 필수칸(주소)이 비면 오류', r.ok === false && r.errors.some(e => e.includes('주소')));
}
{
  const items = parseSlashForm(`${BASE}\n\n${BASE}\n`);
  ok('A19 빈 줄은 건너뛴다', items.length === 2);
  ok('A20 줄 번호는 원문 기준을 유지', items[0].lineNo === 1 && items[1].lineNo === 3);
}
ok('A21 formatPhone은 형식 불명이면 원본 유지', formatPhone('없음') === '없음');

/* ══════════════════════════════════════════════════════════
   B. 서비스 (스텁 db/client 로 실제 호출)
   ══════════════════════════════════════════════════════════ */
console.log('\nB. manualOrder.service (런타임 실행)');

// registerReviewer 는 실제 DB를 쓰므로 **manualOrder.service 를 require 하기 전에** 갈아끼운다
const reviewerSvc = require('../src/services/reviewer.service');
let regCalls = [];
let regResult = { ok: true };
reviewerSvc.registerReviewer = async (a) => { regCalls.push(a); return regResult; };
const holdSvc = require('../src/services/campaignHold.service');
let persistCalls = 0;
holdSvc.maybePersistClosed = async () => { persistCalls++; };

const svc = require('../src/services/manualOrder.service');

/** 질의 로그를 남기는 스텁 — 응답은 (정규식|문자열) → rows 매핑 */
function stubDb(routes) {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      for (const [m, rows] of routes) {
        if (typeof m === 'string' ? String(sql).includes(m) : m.test(String(sql))) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
  };
}

ok('B1 출처 표시가 Track B의 manual 과 겹치지 않는다(오분류 방지)',
  svc.SOURCE_EXTERNAL === 'admin_external' && svc.SOURCE_EXTERNAL !== 'manual');

// ── 타계정: 소유자 1명 → 연결 + sub_accounts 등록 ──
{
  regCalls = [];
  const db = stubDb([
    [/FROM reviewers\s+WHERE REPLACE/i, [{ id: 7, name: '박서준', phone: '01033334444', phone8: '33334444', sub_accounts: [] }]],
  ]);
  const r = await svc.ensureExternalReviewer({
    reviewerName: '박서준', recipient: '이서연', phone: '010-5555-6666',
    address: '서울', bank: '신한', account: '1-2-3', depositor: '이서연', isSubAccount: true,
  }, { db });
  ok('B2 타계정 — 소유자를 찾으면 연결한다', r.registered === true && r.linkedOwner === '박서준');
  ok('B3 타계정 — 수취인을 소유자의 sub_accounts 에 추가', db.log.some(q => /UPDATE reviewers SET sub_accounts/.test(q.sql)));
  ok('B4 타계정 — registerReviewer 로 새 리뷰어를 만들지 않는다', regCalls.length === 0);
  const upd = db.log.find(q => /sub_accounts/.test(q.sql) && /UPDATE/.test(q.sql));
  ok('B5 타계정 — 등록되는 명의는 수취인', JSON.parse(upd.params[0])[0].name === '이서연');
}
// ── 타계정: 동명이인 2명 → 연결 안 함(잘못된 사람에게 붙이느니 경고) ──
{
  regCalls = [];
  const db = stubDb([
    [/FROM reviewers\s+WHERE REPLACE/i, [{ id: 1, name: '김철수', sub_accounts: [] }, { id: 2, name: '김철수', sub_accounts: [] }]],
  ]);
  const r = await svc.ensureExternalReviewer({
    reviewerName: '김철수', recipient: '김영희', phone: '010-5555-6666', isSubAccount: true,
  }, { db });
  ok('B6 동명이인이면 소유자 연결을 건너뛰고 경고', r.linkedOwner === null && r.warnings.some(w => w.includes('여러 명')));
  ok('B7 동명이인이어도 명의 등록 자체는 진행(주문 유실 방지)', regCalls.length === 1);
}
// ── 본인 건: 등록 + 빈 칸만 백필 ──
{
  regCalls = [];
  const db = stubDb([]);
  const r = await svc.ensureExternalReviewer({
    reviewerName: '한지민', recipient: '한지민', phone: '010-7777-8888',
    address: '부산', bank: '국민', account: '9-9-9', depositor: '한지민', isSubAccount: false,
  }, { db });
  ok('B8 본인 건은 registerReviewer 단일 경로로 등록', r.registered === true && regCalls.length === 1);
  ok('B9 등록 전화는 숫자 11자리로 정규화', regCalls[0].phone === '01077778888');
  const back = db.log.find(q => /UPDATE reviewers SET/.test(q.sql) && /account_holder/.test(q.sql));
  ok('B10 주소·계좌 백필이 실행된다', !!back);
  ok('B11 ★ 백필은 비어 있을 때만(기존 계좌 덮어쓰기 금지)',
    /CASE WHEN COALESCE\(bank_account,''\) = '' THEN/.test(back.sql.replace(/\s+/g, ' ')));
  ok('B12 ★ 백필 대상은 phone(UNIQUE) — phone8(비유니크)로 남의 행을 건드리지 않는다',
    / WHERE phone = \$1/.test(back.sql) && !/WHERE phone8/.test(back.sql));
}
// ── 10자리 전화: 등록 생략 ──
{
  regCalls = [];
  const db = stubDb([]);
  const r = await svc.ensureExternalReviewer({
    reviewerName: 'A', recipient: 'A', phone: '02-1234-5678', isSubAccount: false,
  }, { db });
  ok('B13 11자리가 아니면 자동등록을 건너뛴다', r.registered === false && regCalls.length === 0);
  ok('B14 건너뛴 사실을 경고로 남긴다', r.warnings.some(w => w.includes('11자리')));
}

console.log('\nB2. 정원 차감(confirmExternalApplication)');
function stubClient(routes) { const d = stubDb(routes); return d; }
{
  const c = stubClient([[/FROM recruit_campaigns/i, [{ id: 'x', participation_mode: false, recruit_total: 0 }]]]);
  const r = await svc.confirmExternalApplication(c, { campaignId: 'x', phone8: '11112222' });
  ok('B15 레거시 공고는 정원 차감을 건너뛴다(오류 아님)', r.ok === false && r.skipped === 'not_participation');
}
{
  const c = stubClient([
    [/FROM recruit_campaigns/i, [{ id: 'x', participation_mode: true, recruit_total: 0 }]],
    [/status = 'submitted' LIMIT 1/i, [{ id: 55 }]],
  ]);
  const r = await svc.confirmExternalApplication(c, { campaignId: 'x', phone8: '11112222' });
  ok('B16 같은 명의의 확정 참여가 이미 있으면 차단(이중 차감 금지)', r.ok === false && /이미 확정된 참여/.test(r.error));
}
{
  const c = stubClient([
    [/FROM recruit_campaigns/i, [{ id: 'x', participation_mode: true, recruit_total: 10 }]],
    [/COUNT\(\*\)::int AS n/i, [{ n: 10 }]],
  ]);
  const strict = await svc.confirmExternalApplication(c, { campaignId: 'x', phone8: '1', allowOverCapacity: false });
  ok('B17 정원이 찼고 초과 미허용이면 거부', strict.ok === false && /정원/.test(strict.error));
}
{
  persistCalls = 0;
  const c = stubClient([
    [/FROM recruit_campaigns/i, [{ id: 'x', participation_mode: true, recruit_total: 10 }]],
    [/COUNT\(\*\)::int AS n/i, [{ n: 10 }]],
    [/INSERT INTO campaign_applications/i, [{ id: 91 }]],
  ]);
  const r = await svc.confirmExternalApplication(c, { campaignId: 'x', phone8: '1', allowOverCapacity: true });
  ok('B18 초과 허용이면 확정하되 사실을 알린다', r.ok === true && r.overCapacity === true);
  ok('B19 확정 후 마감 영속 판정을 호출', persistCalls === 1);
}
{
  const c = stubClient([
    [/FROM recruit_campaigns/i, [{ id: 'x', participation_mode: true, recruit_total: 0 }]],
    [/status = 'applied'/i, [{ id: 42 }]],
  ]);
  const r = await svc.confirmExternalApplication(c, { campaignId: 'x', phone8: '1', orderSubmissionId: 'os-1' });
  ok('B20 살아있는 신청이 있으면 새로 만들지 않고 그것을 확정', r.ok === true && r.applicationId === 42);
  ok('B21 그 경우 INSERT 는 실행되지 않는다', !c.log.some(q => /INSERT INTO campaign_applications/.test(q.sql)));
}
{
  const c = stubClient([
    [/FROM recruit_campaigns/i, [{ id: 'x', participation_mode: true, recruit_total: 0 }]],
    [/INSERT INTO campaign_applications/i, [{ id: 77 }]],
  ]);
  const r = await svc.confirmExternalApplication(c, { campaignId: 'x', phone8: '1' });
  ok('B22 신청 이력이 없으면 submitted 로 새 행 생성', r.ok === true && r.applicationId === 77);
  ok('B23 ★ 잠금 계층 — 캠페인 행을 FOR UPDATE 로 먼저 잠근다',
    /FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/.test(c.log[0].sql));
}

console.log('\nB3. 서비스 구조(원장 단일 진입점)');
{
  const src = nc(R('src/services/manualOrder.service.js'));
  ok('B24 원장은 createOrderLedgerEntry 재사용(행배정 인라인 복제 금지)',
    src.includes('createOrderLedgerEntry(') && !src.includes('claimRow('));
  ok('B25 시트 반영은 기존 큐(order_append) 경유', src.includes("enqueue('order_append'"));
  ok('B26 큐 등록 성공은 markOrderQueued 로 상태 반영', src.includes('markOrderQueued('));
  ok('B27 ★ 계좌 덮어쓰기 경로(saveBankInfo/saveAddress)를 쓰지 않는다',
    !src.includes('saveBankInfo') && !src.includes('saveAddress'));
  ok('B28 리뷰어 등록은 registerReviewer 단일 경로', src.includes('registerReviewer(')
    && !/INSERT INTO reviewers/i.test(src));
  ok('B29 홀드 문맥을 넘기지 않는다(이중 확정 방지)', !src.includes('campaignHold:'));
}

/* ══════════════════════════════════════════════════════════
   C. 라우트 — 권한 게이트
   ══════════════════════════════════════════════════════════ */
console.log('\nC. 라우트 권한');
{
  const router = require('../src/routes/manualOrder.routes');
  const layers = router.stack.filter(l => l.route).map(l => ({
    path: l.route.path,
    methods: Object.keys(l.route.methods),
    names: l.route.stack.map(s => s.name),
  }));
  const find = p => layers.find(l => l.path === p);
  ok('C1 세 라우트가 등록돼 있다', layers.length === 3
    && !!find('/preview') && !!find('/reviewer-search') && !!find('/submit'));
  ok('C2 ★ 전부 authMiddleware + adminOrMasterMiddleware 뒤에 있다',
    layers.every(l => l.names.includes('authMiddleware') && l.names.includes('adminOrMasterMiddleware')));
  ok('C3 제출은 POST 전용', find('/submit').methods.join() === 'post');

  const src = nc(R('src/routes/manualOrder.routes.js'));
  ok('C4 한 번에 처리할 건수에 상한이 있다(오붙여넣기 사고 방지)', /MAX_LINES\s*=\s*\d+/.test(src));
  ok('C5 ★ 리뷰어 검색은 전화번호를 통째로 반환하지 않는다(뒤 4자리만)',
    src.includes('tail4:') && !/items:\s*rows\.map\(r => \(\{[^}]*phone:/.test(src));
  ok('C6 건별 독립 처리 — 한 건 실패가 전체를 되돌리지 않는다',
    /for \(let i = 0; i < items\.length; i\+\+\)/.test(src) && src.includes('try {') && src.includes('results.push'));
  ok('C7 미리보기는 DB에 손대지 않는다', !/pool\.query/.test(src.slice(src.indexOf("'/preview'"), src.indexOf("'/reviewer-search'"))));
}
{
  const app = nc(R('src/app.js'));
  ok('C8 app.js 에 /api/manual-order 로 마운트', /app\.use\('\/api\/manual-order',\s*manualOrderRoutes\)/.test(app));
}

/* ══════════════════════════════════════════════════════════
   D. 프론트 — 진입점 3곳 + 토큰 게이트
   ══════════════════════════════════════════════════════════ */
console.log('\nD. 프론트 배선');
{
  const mo = F('js/manual-order.js');
  ok('D1 공용 모달이 window.ManualOrder 로 노출', /window\.ManualOrder\s*=\s*\{/.test(mo));
  ok('D2 open/close/parse/submit 이 계약에 포함',
    ['open', 'close', 'parse', 'back', 'edit', 'onPaste', 'submit'].every(k =>
      new RegExp('window\\.ManualOrder\\s*=\\s*\\{[^}]*\\b' + k + '\\b').test(mo)));
  ok('D2b 붙여넣기가 안 먹는 브라우저용 파일 선택 폴백이 있다(첨부 경로 단일화 금지)',
    mo.includes('onFile') && mo.includes('type="file"'));
  ok('D2c ★ 셀 수정 시 오류 재판정이 양방향 — 지운 칸이 정상으로 남지 않는다',
    /it\.ok = !bad;/.test(mo) && /const missing = REQUIRED\.filter/.test(mo));
  ok('D3 파싱은 서버 파서에 맡긴다(프론트 사본 금지)',
    mo.includes('/api/manual-order/preview') && !/split\('\/'\)/.test(mo));
  ok('D4 제출은 인증 라우트로만', mo.includes('/api/manual-order/submit'));
  ok('D5 캡처는 기존 업로드 경로 재사용 + 주문에 연결',
    mo.includes('/api/image/image-upload') && mo.includes('orderSubmissionId: res.orderSubmissionId'));
  ok('D6 캡처 붙여넣기(Ctrl+V)를 지원', mo.includes('clipboardData') && mo.includes('getAsFile'));
  ok('D7 오리진은 api.js 판정값을 재사용(사본 드리프트 금지)', /typeof API_BASE_URL !== 'undefined'/.test(mo));
}
{
  const cc = F('js/campaign-cards.js');
  ok('D8 CampCards 가 openManualOrder 를 노출', /openManualOrder,/.test(cc));
  ok('D9 ★ 리뷰어 홈 칩은 진짜 admin_token + 참여형일 때만 — 스코프 토큰에겐 미노출(403 막다른 길 금지)',
    /const moChip = \(!admin && c\.participation_mode && _realAdminTok\(\)\)/.test(cc));
  ok('D10 칩이 실제로 카드에 삽입된다', cc.includes('${editChip}${moChip}'));
  ok('D11 연결 탭 문맥은 단일 렌더러가 캐시한다', cc.includes('_cacheMoCtx(c);'));
  ok('D12 캐시가 비면 관리자 조회로 보충(공개 목록엔 연결 탭이 없다)',
    /'\/api\/campaign\/' \+ encodeURIComponent\(id\)/.test(cc));
  ok('D13 ★ 정원 차감은 참여형에만 — 레거시엔 campaignId 를 넘기지 않는다',
    /campaignId: ctx\.participation \? id : null/.test(cc));
  ok('D14 연결 탭이 없으면 열지 않고 안내', cc.includes('연결된 작업 탭이 없어'));
  ok('D15 문맥 필드명이 스키마와 일치(linked_sheet_id — work_orders 의 linked_tab_sheet_id 아님)',
    cc.includes('c.linked_sheet_id') && !cc.includes('c.linked_tab_sheet_id'));
}
{
  const ir = F('js/index-recruit.js');
  ok('D16 관제 패널에 외부제출 버튼', ir.includes('id="ccMoBtn"'));
  ok('D17 관제 버튼은 열 때마다 현재 공고로 다시 배선(오버레이 재사용 함정)',
    /_moBtn\.onclick = \(\) => \{/.test(ir) && ir.includes('CampCards.openManualOrder(campId)'));
  ok('D18 문맥 해석 사본을 index-recruit 에 두지 않는다', !ir.includes('ManualOrder.open('));
}
{
  const ia = F('js/index-app.js');
  ok('D19 작업 탭 관리 상세에 수동제출 진입', /function openManualOrderForTab\(idx\)/.test(ia));
  ok('D20 ★ 탭명·시트명을 onclick 문자열에 심지 않는다(주입 벡터 차단)',
    ia.includes('openManualOrderForTab(${idx})') && !/openManualOrderForTab\('\$\{/.test(ia));
  ok('D21 탭 단위 진입은 참여형 정원을 건드리지 않는다',
    /campaignId: null,\s*\/\/ 탭 단위 진입/.test(ia));
}
{
  const pages = [['admin.html', F('admin.html')], ['index.html', F('index.html')], ['admin-siand.html', F('admin-siand.html')]];
  pages.forEach(([name, html]) => {
    ok(`D22 ${name} 이 manual-order.js 를 로드`, html.includes('js/manual-order.js'));
  });
  const idx = F('index.html');
  ok('D23 index.html 은 api.js → manual-order.js 순서(오리진 판정 선행)',
    idx.indexOf('src="api.js"') < idx.indexOf('js/manual-order.js'));
}

console.log(`\n✅ manualOrderExternal 회귀가드 통과 — ${passed}건\n`);
}

main().catch(err => { console.error('\n❌ ' + err.message + '\n'); process.exit(1); });
