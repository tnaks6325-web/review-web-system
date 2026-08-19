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
  ok('C1 라우트가 등록돼 있다(미배선 PII 표면 없음 — reviewer-search 는 제거)',
    layers.length === 2 && !!find('/preview') && !!find('/submit') && !find('/reviewer-search'));
  ok('C2 ★ 전부 authMiddleware + adminOrMasterMiddleware 뒤에 있다',
    layers.every(l => l.names.includes('authMiddleware') && l.names.includes('adminOrMasterMiddleware')));
  ok('C3 제출은 POST 전용', find('/submit').methods.join() === 'post');

  const src = nc(R('src/routes/manualOrder.routes.js'));
  ok('C4 한 번에 처리할 건수에 상한이 있다(오붙여넣기 사고 방지)', /MAX_LINES\s*=\s*\d+/.test(src));
  ok('C5 ★ 서버가 자릿수까지 재검증 — phone8 8자리 미만이 원장·정원 키가 되는 것 차단',
    /pd\.length !== 11 && pd\.length !== 10/.test(src));
  ok('C5b 필수 항목을 서버가 다시 본다(프론트 우회 직접 호출 방어)',
    /const missing = \['recipient', 'phone', 'address', 'bank', 'account', 'depositor'\]/.test(src));
  ok('C6 건별 독립 처리 — 한 건 실패가 전체를 되돌리지 않는다',
    /for \(let i = 0; i < items\.length; i\+\+\)/.test(src) && src.includes('try {') && src.includes('results.push'));
  ok('C7 미리보기는 DB에 손대지 않는다', !/pool\.query/.test(src.slice(src.indexOf("'/preview'"), src.indexOf("'/submit'"))));
  ok('C9 파싱을 두 번 하지 않는다', (src.match(/parseSlashForm\(/g) || []).length === 1);
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
    /_moBtn\.onclick = \(\) =>/.test(ir) && ir.includes('CampCards.openManualOrder(campId)'));
  ok('D17b 모듈이 없는 화면(admin-siand)에서는 버튼을 숨긴다 — 눌러도 안 되는 버튼 금지',
    /_moBtn\.style\.display = _moReady \? "" : "none"/.test(ir));
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

/* ══════════════════════════════════════════════════════════
   E. 코드리뷰 반영분 — 되돌리면 데이터가 상하는 것들
   ══════════════════════════════════════════════════════════ */
console.log('\nE. 데이터 보전 가드');
{
  // ★★ 블로커였던 것: 빈 dateStr/옵션은 `mapOrderToSheetRow`가 ''로 매핑하고
  //    `buildBatchUpdateData`는 null만 걸러내므로 **그 칸을 지우는 쓰기**가 된다.
  //    로스터의 구매일자가 지워지면 063이 그 날짜 칸 개수로 정원을 세므로 그날 물량이 함께 줄어든다.
  const ol = require('../src/services/orderLedger.service');
  const headers = ['번호', '구매일자', '수취인', '연락처', '주소', '옵션', '은행'];
  const blank = ol.mapOrderToSheetRow(headers, { recipient: 'A' });
  ok('E1 (전제) 매퍼는 빈 날짜·옵션을 null이 아니라 ""로 반환 — 그래서 빈 값은 삭제 쓰기가 된다',
    blank[1] === '' && blank[5] === '' && blank[0] === null);

  const d = svc.todayKstDateStr(new Date('2026-07-30T01:00:00Z'));  // KST 10:00 목
  ok('E2 ★ 구매일자를 리뷰어 제출과 같은 형식으로 채운다(빈 값 금지)', d === '7 / 30 (목)');
  ok('E3 KST 경계 — UTC 전날 늦은 시각도 KST 날짜로', svc.todayKstDateStr(new Date('2026-07-30T15:30:00Z')) === '7 / 31 (금)');

  const src = nc(R('src/services/manualOrder.service.js'));
  ok('E4 ★ orderData.dateStr 에 빈 문자열을 넣지 않는다', /dateStr: todayKstDateStr\(\)/.test(src) && !/dateStr: ''/.test(src));

  // 옵션 칸 읽기(관측용 순수함수) — 값을 돌려주기만 하고, 어디에도 역주입하지 않는다.
  const ctx = { headers, dataRows: [{ rowIndex: 12, cells: ['1', '7 / 30', 'A', '', '', '콰이어트', ''] }] };
  ok('E5 배정 행의 기존 옵션값을 그대로 읽는다(관측용)',
    svc.existingOptionKeyAt(ctx, 12) === '콰이어트');
  ok('E6 옵션 칸이 비어 있으면 빈 값', svc.existingOptionKeyAt(
    { headers, dataRows: [{ rowIndex: 12, cells: ['1', '', 'A', '', '', '', ''] }] }, 12) === '');
  ok('E7 옵션 칸이 없는 탭은 무영향', svc.existingOptionKeyAt({ headers: ['수취인'], dataRows: [{ rowIndex: 1, cells: ['A'] }] }, 1) === '');
  ok('E8 배정 행을 못 찾으면 빈 값', svc.existingOptionKeyAt(ctx, 99) === '');
  // ★ C′(2026-08) 의미 반전: 수동제출도 시트값을 원장·신청에 역주입하지 않는다.
  //   역주입하면 관리자 작업지시('포토리뷰')가 "리뷰어가 고른 옵션"으로 굳어 정원·CS·정산이 오독하고,
  //   리뷰어 제출 경로와 결과가 갈린다(경로 드리프트). 옵션 칸 보호는 쓰기 시점 blank-only 필터 담당.
  ok('E9 ★★ 수동제출이 시트 옵션값을 원장에 역주입하지 않는다(경로 드리프트·오독 차단)',
    !/existingOptionKeyAt\(ledger\.tabContext, ledger\.sheetRow\)/.test(src)
    && !/UPDATE order_submissions SET selected_opt_key = \$2 WHERE id = \$1/.test(src));

  ok('E10 ★ 공유 매퍼는 건드리지 않았다 — order_cancel의 칸 비우기·TrackB 컬럼 disjoint 마스크가 ""에 의존',
    /return orderData\.dateStr \|\| '';/.test(R('src/services/orderLedger.service.js')));
}
{
  const src = nc(R('src/services/manualOrder.service.js'));
  ok('E11 ★ 공고↔탭 결속을 확인한 뒤에만 정원을 깎는다', src.includes('tabMatchesCampaign(cRows[0]'));
  ok('E12 결속 확인은 캠페인 행을 잠근 뒤(추가 왕복 없음)',
    src.indexOf('FOR UPDATE') < src.indexOf('tabMatchesCampaign(cRows[0]'));
  ok('E13 ★ 24시간 내 같은 연락처 재접수는 막는다(재붙여넣기 = 예상되는 복구 동작)',
    /submitted_at > NOW\(\) - interval '24 hours'/.test(src) && /duplicate: true/.test(src));
  ok('E14 중복 확인은 force 로만 우회', /if \(!force\) \{/.test(src));
  ok('E15 ★ 확정 불가한 참여형 건은 원장 기록 **전에** 걸러낸다(시트만 쓰이고 정원은 안 깎이는 상태 방지)',
    src.indexOf("status = 'submitted' LIMIT 1") < src.indexOf('createOrderLedgerEntry('));
  ok('E16 ★ 등록된 리뷰어 번호를 남의 타계정으로 붙이지 않는다(063과 같은 정책 스위치)',
    src.includes('CAMPAIGN_SUB_REGISTERED_POLICY') && src.includes('sub_accounts'));
  ok('E17 큐 등록 후 kick — cron까지 시트에 안 뜨던 문제', /kickOrderBatch\(sheetId, tabName\)/.test(src));
}
{
  const em = R('src/middleware/error.middleware.js');
  ok('E18 관리자 전용 도구라 오류 메시지를 마스킹하지 않는다', em.includes("startsWith('/api/manual-order/')"));
}
{
  const mo = F('js/manual-order.js');
  ok('E19 캡처는 업로드 전에 줄인다(본문 10MB 상한 — 전체화면 캡처 413 방지)',
    /toDataURL\('image\/jpeg', 0\.75\)/.test(mo));
  ok('E20 ★ 업로드 응답을 확인한 뒤에만 "첨부됨"으로 보고', /res\.captureAttached = !!\(up && up\.ok\)/.test(mo));
  ok('E21 분해 요청도 오류를 잡는다(프록시 HTML 응답에 버튼이 죽던 문제)',
    /try \{\s*r = await api\('\/api\/manual-order\/preview'/.test(mo));
  ok('E22 결과↔제출건 매칭은 서버가 준 index 로', /res\.index === 'number'\) \? targets\[res\.index\]/.test(mo));
  ok('E23 셀을 고치면 옛 오류 문구도 지운다', /querySelectorAll\('\.mo-msg'\)\.forEach\(el => el\.remove\(\)\)/.test(mo));
}

/* ══════════════════════════════════════════════════════════
   F. 오늘 마감 카드 — 아래로 정렬 + 회색 썸네일 + 재오픈 카운트다운
   ══════════════════════════════════════════════════════════ */
console.log('\nF. 마감 카드 표시');
{
  const st = require('../src/services/campaignState.service');
  const base = {
    participation_mode: true, status: 'active',
    window_start: null, window_end: null, daily_limit: 20, recruit_total: 0,
  };
  const now = new Date('2026-07-30T05:00:00Z');   // KST 14:00
  const full = st.computeCampaignState(base, { todaySubmitted: 20, todayActiveHolds: 0 }, now);
  ok('F1 자율주문이 오늘 다 차면 daily_done', full.state === 'daily_done');
  ok('F2 ★ 재오픈 시각을 준다 — 자율주문은 내일 KST 자정',
    full.reopensAt === new Date(Date.parse('2026-07-31T00:00:00+09:00')).toISOString());
  ok('F3 ★ reopensAt 은 미래다(기존 opensAt 은 오늘 시각이라 카운트다운이 0에 붙었다)',
    Date.parse(full.reopensAt) > now.getTime());

  const timed = st.computeCampaignState(
    { ...base, window_start: '09:00', window_end: '12:00' },
    { todaySubmitted: 0, todayActiveHolds: 0 }, now);   // 14:00 = 시간창 종료 후
  ok('F4 시간창 종료 후에도 daily_done + 내일 오픈 시각', timed.state === 'daily_done'
    && timed.reopensAt === new Date(Date.parse('2026-07-31T09:00:00+09:00')).toISOString());

  const open = st.computeCampaignState(base, { todaySubmitted: 1, todayActiveHolds: 0 }, now);
  ok('F5 진행 중인 공고엔 reopensAt 이 없다(오버레이 미표시)', open.state === 'open' && !open.reopensAt);

  const routes = R('src/routes/campaign.routes.js');
  ok('F6 공개 목록·상세 응답에 reopensAt 이 실린다', /reopensAt: st\.reopensAt \|\| null/.test(routes));
  ok('F7 관리자 목록에도 같은 값', (routes.match(/reopensAt: st\.reopensAt \|\| null/g) || []).length === 2);
}
{
  const cc = F('js/campaign-cards.js');
  ok('F8 ★ 마감 카드는 썸네일을 회색으로 덮고 가운데에 흰 카운트다운',
    /isDaily && c\.reopensAt/.test(cc) && cc.includes('data-camp-countdown="${_esc(c.reopensAt)}"'));
  ok('F9 카운트다운 기준은 reopensAt(오늘의 opensAt 아님)',
    !/data-camp-countdown="\$\{_esc\(c\.opensAt\)\}">--:--:--<\/span><span class="ol">\$\{_esc\(_fmtOpenLabel\(c\.reopensAt/.test(cc));
  ok('F10 오버레이가 뜨면 같은 말을 하는 리본은 겹치지 않는다', /const dailyOverlay = isDaily && !!c\.reopensAt;/.test(cc));
  ok('F11 ★ 참여 가능한 공고가 위로 오는 공용 정렬', /function sortByAvailability\(list\)/.test(cc)
    && /_AVAIL_RANK = \{ open: 0/.test(cc));
  ok('F12 안정 정렬 — 같은 등급이면 서버 순서(별표 우선노출) 유지', /\(a\.r - b\.r\) \|\| \(a\.i - b\.i\)/.test(cc));
  ok('F13 CampCards 가 정렬을 노출', /sortByAvailability,/.test(cc));
  const idx = F('index.html');
  ok('F14 리뷰어 홈이 그 정렬을 쓴다', idx.includes('CampCards.sortByAvailability('));
  const rc = F('recruit.html');
  ok('F15 모집공고 목록 화면도 같은 정렬', rc.includes('CampCards.sortByAvailability('));
}

/* ══════════════════════════════════════════════════════════
   G. 홈 화면 관리자 로그인 — 🧾·⭐ 를 홈에서 바로 쓰게 하는 경로
      (서버 권한은 그대로. 스코프 토큰을 넓히지 않고 진짜 토큰을 받게 한다)
   ══════════════════════════════════════════════════════════ */
console.log('\nG. 홈 관리자 로그인');
{
  const idx = F('index.html');
  ok('G1 배너에 [관리자 로그인] 진입점', idx.includes('id="adminModeLoginBtn"') && idx.includes('openHomeAdminLogin()'));
  ok('G2 비밀번호는 인라인 모달로 받는다(prompt 평문 노출 금지)',
    idx.includes('id="halPw"') && idx.includes('type="password"') && !/prompt\(\s*['"]비밀번호/.test(idx));
  ok('G3 ★ 기존 관리자 로그인 API 재사용 — 서버 변경 0', idx.includes("'/api/admin/login'") || idx.includes('"/api/admin/login"'));
  ok('G4 성공 시 진짜 관리자 토큰으로 저장', /sessionStorage\.setItem\("admin_token", j\.token\)/.test(idx));
  ok('G5 ★ 로그인 후 목록을 다시 그려 ⭐·🧾 가 즉시 나타난다', /closeHomeAdminLogin\(\);[\s\S]{0,200}loadRecruitPreview\(\)/.test(idx));
  ok('G6 이미 토큰이 있으면 버튼을 숨긴다', /btn\.style\.display = has \? "none" : ""/.test(idx));
  ok('G7 판정은 진짜 admin_token 만(스코프 토큰 제외 — 카드 게이트와 같은 규칙)',
    /function _homeRealAdminTok\(\)/.test(idx) && !/_homeRealAdminTok[\s\S]{0,200}rapp_camp_edit_token/.test(idx));
  ok('G8 ★ 로그아웃하면 관리자 토큰도 지운다(공용 PC에 권한 잔류 금지)',
    /function doLogout\(\)[\s\S]{0,400}sessionStorage\.removeItem\("admin_token"\)/.test(idx));
  ok('G9 로그인 실패가 리뷰어 세션을 건드리지 않는다',
    !/function doHomeAdminLogin[\s\S]{0,1600}removeItem\("rapp_reviewer_auth"\)/.test(idx));

  // 서버 표면이 늘지 않았는지 — 스코프 토큰을 manual-order 로 넓히지 않았다
  const auth = nc(R('src/middleware/auth.middleware.js'));
  ok('G10 ★ 스코프 토큰(via:reviewer_campaign)은 여전히 manual-order 에 도달 불가',
    !/reviewer_campaign[\s\S]{0,600}manual-order/.test(auth));
}

/* ══════════════════════════════════════════════════════════
   H. 슬래시 누락 자동 보정 (규칙 → AI 폴백)
   ══════════════════════════════════════════════════════════ */
console.log('\nH. 슬래시 누락 자동 보정');
{
  const SF = require('../src/utils/slashForm');
  const P = SF.parseSlashLine;
  const ADDR = '부산시 수영구 광안동 119-3번지, 109호';

  // ★ 사용자가 든 실제 사례 — 예금주와 결제금액 사이 슬래시 누락
  {
    const r = P(`이시현/이시현/kirei223/010-7701-1701/${ADDR}/신한은행/496-04-007701/이시현15800`);
    ok('H1 ★ 예금주+결제금액이 붙어도 보정해 통과', r.ok === true);
    ok('H2 보정 결과가 제자리에 들어간다', r.fields.depositor === '이시현' && r.fields.price === 15800
      && r.fields.userId === 'kirei223' && r.fields.account === '496-04-007701');
    ok('H3 ★ 보정 사실을 경고로 알린다(조용한 자동수정 금지)',
      (r.repairs || []).length === 1 && r.warnings.some(w => w.includes('예금주와 결제금액')));
  }
  ok('H4 은행+계좌번호 붙음', (() => {
    const r = P(`김하나/김하나/hana1/010-1111-2222/${ADDR}/국민은행123-456-789/김하나/28900`);
    return r.ok && r.fields.bank === '국민은행' && r.fields.account === '123-456-789';
  })());
  ok('H5 아이디+전화번호 붙음', (() => {
    const r = P(`박서준/박서준/psj010-3333-4444/${ADDR}/신한은행/110-222-333/박서준/12000`);
    return r.ok && r.fields.userId === 'psj' && r.fields.phone === '010-3333-4444';
  })());
  ok('H6 전화번호+주소 붙음', (() => {
    const r = P(`한지민/한지민/hjm/010-9999-8888${ADDR}/농협/111-222-333/한지민/9000`);
    return r.ok && r.fields.phone === '010-9999-8888' && r.fields.address === ADDR;
  })());
  ok('H7 계좌번호+예금주 붙음', (() => {
    const r = P(`최유리/최유리/cyr/010-4444-5555/${ADDR}/우리은행/1002-333-444최유리/33000`);
    return r.ok && r.fields.account === '1002-333-444' && r.fields.depositor === '최유리';
  })());
  ok('H8 슬래시 2개가 빠져도 보정', (() => {
    const r = P(`이시현/이시현/kirei223/010-7701-1701/${ADDR}/신한은행496-04-007701/이시현15800`);
    return r.ok && r.fields.bank === '신한은행' && r.fields.account === '496-04-007701'
      && r.fields.depositor === '이시현' && r.fields.price === 15800;
  })());

  // ★★ 탐욕적 매칭 회귀 방지 — 왼쪽부터 먼저 걸리는 자리를 자르면 `kirei223` 이 kirei/223 으로 갈린다.
  //    모든 조합을 점수화해 고르는 구조가 아니면 이 케이스가 깨진다(실측 버그).
  {
    const r = P(`이시현/이시현/kirei223/010-7701-1701/${ADDR}/신한은행/496-04-007701/이시현15800`);
    ok('H9 ★★ 아이디 안의 숫자를 잘못 가르지 않는다(탐욕적 매칭 회귀 방지)', r.fields.userId === 'kirei223');
  }

  ok('H10 정상 9칸은 보정하지 않는다', (() => {
    const r = P(`이시현/이시현/kirei223/010-7701-1701/${ADDR}/신한은행/496-04-007701/이시현/15800`);
    return r.ok && (r.repairs || []).length === 0;
  })());
  ok('H11 주소 슬래시(칸 초과)는 기존 병합 규칙 그대로 — 보정 아님', (() => {
    const r = P('김하나/김하나/hana1/010-1111-2222/서울 월드컵로 12/3, 302호/국민은행/123-456-789/김하나/28900');
    return r.ok && (r.repairs || []).length === 0 && r.fields.address === '서울 월드컵로 12/3, 302호';
  })());

  // ★ 항목이 통째로 없으면 지어내지 않고 "무엇이 없는지" 짚어 준다
  {
    const r = P('한지민/한지민/hjm/010-9999-8888/부산시 해운대구 1로 2/111-222-333/한지민/9000');
    ok('H12 ★ 은행이 통째로 없으면 보정하지 않고 오류', r.ok === false);
    ok('H13 어떤 항목이 없는지 알려 준다', (r.missing || []).includes('은행') && /은행/.test(r.errors[0]));
  }
  ok('H14 ★ 리뷰어+수취인이 붙은 경우는 자르지 않는다(경계를 알 수 없어 남의 명의 위험)', (() => {
    const r = P(`김하나이서연/hana1/010-1111-2222/${ADDR}/국민은행/123-456-789/김하나/28900`);
    return r.ok === false;   // 지어내지 않고 오류로 돌려보낸다
  })());

  // 앵커가 안 맞으면 보정을 버린다(틀린 값으로 접수 금지)
  ok('H15 ★ 보정 결과가 말이 안 되면 채택하지 않는다',
    SF.repairLooksSane(['A', 'A', 'id', '없음', '주소', '은행', '1', 'A', '1000']) === false);
  ok('H16 형태 판정기 — 전화/금액/계좌/은행/주소',
    SF.looksPhone('010-1111-2222') && SF.looksPrice('15,800원') && SF.looksAccount('496-04-007701')
    && !SF.looksAccount('010-1111-2222') && SF.looksBank('카카오뱅크') && SF.looksAddress('서울시 강남구 테헤란로 1'));

  const rt = nc(R('src/routes/manualOrder.routes.js'));
  ok('H17 AI 폴백은 칸 부족으로 실패한 줄에만 시도(정상 줄은 AI로 안 보냄)',
    rt.includes('items.filter(i => !i.ok') && rt.includes('칸이 \\d+개뿐'));
  ok('H18 ★ AI 결과도 같은 파서로 재검증한다(파서 우회 금지)',
    rt.includes('parseSlashLine(rebuilt)') && rt.includes("re.ok"));
  ok('H19 ★ AI 호출에 상한이 있다(오붙여넣기가 통째로 AI로 가지 않게)', /AI_REPAIR_MAX/.test(rt));
  ok('H20 킬스위치', rt.includes('SLASHFORM_AI_REPAIR'));
  ok('H21 AI 보정 줄은 원문을 보존해 사람이 대조할 수 있다', rt.includes('raw: it.raw'));

  const gs = nc(R('src/services/gemini.service.js'));
  ok('H22 ★ AI에게 값을 지어내지 말라고 못박는다', /지어내지 마라/.test(gs));
  ok('H23 이름·전화가 없으면 AI 결과를 버린다(fail-open)',
    gs.includes("if (!s('phone')) return null;"));

  const mo = F('js/manual-order.js');
  ok('H24 ★ 보정된 줄은 표에 배지로 드러난다(조용한 수정 금지)',
    mo.includes('🔧 자동보정') && mo.includes('🤖 AI 보정'));
  ok('H25 보정 건수를 헤더에 요약', /자동보정 \$\{fixN\}건/.test(mo));
}

/* ══════════════════════════════════════════════════════════
   I. 1단계 구매캡쳐 첨부(보관함) + 명칭
   ══════════════════════════════════════════════════════════ */
console.log('\nI. 1단계 캡처 첨부');
{
  const mo = F('js/manual-order.js');

  ok('I1 명칭이 "외부모집 수동제출" 로 통일', mo.includes('외부모집 수동제출') && !mo.includes('외부참여 수동제출'));
  ['js/campaign-cards.js', 'js/index-app.js', 'js/index-recruit.js', 'index.html'].forEach(f => {
    ok(`I1-${f} 옛 명칭 잔여 없음`, !F(f).includes('외부참여 수동제출'));
  });

  ok('I2 1단계에 캡처 보관함이 있다', mo.includes('id="moDrop"') && mo.includes('id="moStage"'));
  ok('I3 텍스트 칸에 이미지를 붙여도 캡처로 받는다(관리자는 그냥 Ctrl+V)',
    mo.includes('onpaste="ManualOrder.onTextPaste(event)"') && /function onTextPaste\(ev\)/.test(mo));
  ok('I4 붙여넣기·드래그·파일선택 3경로 — 하나만 두면 브라우저에 따라 막힌다',
    /function onStagePaste/.test(mo) && /function onDrop/.test(mo) && /function onStageFiles/.test(mo));
  ok('I5 여러 장을 한 번에 받는다', /_imagesFrom\(ev\.clipboardData\)/.test(mo) && /\.forEach\(stageImage\)/.test(mo));
  ok('I6 잘못 넣은 캡처는 뺄 수 있다', /function unstage\(i\)/.test(mo) && mo.includes('ManualOrder.unstage('));
  ok('I7 보관 캡처도 업로드 전에 줄인다(413 방지 — 줄별 첨부와 같은 경로)', /await shrink\(file\)/.test(mo));
  ok('I8 계약에 1단계 핸들러가 노출된다',
    ['onTextPaste', 'onStagePaste', 'onDrop', 'onStageFiles', 'unstage']
      .every(k => new RegExp('window\\.ManualOrder[\\s\\S]{0,400}\\b' + k + '\\b').test(mo)));
  ok('I9 파싱 직후 보관 캡처를 각 줄에 배정한다', /distributeStaged\(\);/.test(mo)
    && mo.indexOf('ROWS = (r.items') < mo.indexOf('distributeStaged();'));
  ok('I10 2단계 줄별 첨부도 그대로 남아 있다(보완 경로)',
    mo.includes('ManualOrder.onPaste(event,') && mo.includes('ManualOrder.onFile(event,'));
  ok('I11 모달을 새로 열면 보관함이 비워진다(다른 탭 캡처 혼입 금지)', /ROWS = \[\]; STAGED = \[\];/.test(mo));

  // ★ 배정 규칙을 실제로 실행 — 이름 → 전화 → 순서
  const src = mo.slice(mo.indexOf('function distributeStaged()'));
  let d = 0, k = src.indexOf('{');
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } }
  const body = src.slice(0, k + 1);
  let ROWS = [], STAGED = [];
  eval(body);   // eslint-disable-line no-eval — 가드 전용(브라우저 코드를 그대로 실행해 규칙 고정)

  ROWS = [
    { fields: { recipient: '이시현', phone: '010-7701-1701' }, capture: null, extract: null },
    { fields: { recipient: '김하나', phone: '010-1111-2222' }, capture: null, extract: null },
    { fields: { recipient: '박서준', phone: '010-3333-4444' }, capture: null, extract: null },
  ];
  STAGED = [
    { base64: 'B', mime: 'i', extract: { recipient: '김 하나', orderNumber: 'ORD-B' } },
    { base64: 'C', mime: 'i', extract: { recipient: '', phone: '010-3333-4444' } },
    { base64: 'A', mime: 'i', extract: null },
  ];
  distributeStaged();
  ok('I12 ★ 수취인 이름으로 붙는다(공백 차이 무시)', ROWS[1].capture.base64 === 'B');
  ok('I13 이름을 못 읽으면 연락처 뒤 4자리로', ROWS[2].capture.base64 === 'C');
  ok('I14 그래도 못 맞추면 붙인 순서대로(첨부를 버리지 않는다)', ROWS[0].capture.base64 === 'A');
  ok('I15 캡처에서 읽은 주문번호가 빈 칸에 채워진다', ROWS[1].fields.orderNum === 'ORD-B');

  ROWS = [{ fields: { recipient: 'A' }, capture: null }, { fields: { recipient: 'B' }, capture: null }];
  STAGED = [{ base64: 'X', mime: 'i', extract: null }];
  distributeStaged();
  ok('I16 캡처가 줄보다 적으면 남는 줄은 빈 채로', !!ROWS[0].capture && !ROWS[1].capture);

  ROWS = [{ fields: { recipient: 'A' }, capture: null }];
  STAGED = [];
  distributeStaged();
  ok('I17 캡처가 없으면 무동작(기존 동작 불변)', ROWS[0].capture === null);

  ROWS = [{ fields: { recipient: 'A' }, capture: { base64: 'KEEP' } }];
  STAGED = [{ base64: 'NEW', mime: 'i', extract: { recipient: 'A' } }];
  distributeStaged();
  ok('I18 이미 붙은 캡처를 덮어쓰지 않는다', ROWS[0].capture.base64 === 'KEEP');
}

/* ══════════════════════════════════════════════════════════
   J. 일 정원(오늘 몫) 확인 게이트 — 2026-08-19 사용자 확정 "나"안
   ──────────────────────────────────────────────────────────
   사고: 외부모집 수동제출이 **총 정원(recruit_total)만** 보고 일 정원은 아예 안 봐서,
   정원 15인 공고 두 개에 각 +2 가 아무 신호 없이 들어갔다(운영 실측: 확정 17).
   ★★ 막지 않는다 — 숫자를 보여주고 확인을 받는다. 확인하면 그대로 접수된다.
   ══════════════════════════════════════════════════════════ */
console.log('\nJ. 일 정원 확인 게이트');
{
  const stateSvc = require('../src/services/campaignState.service');
  const schedSvc = require('../src/services/campaignSchedule.service');
  const realCounts = stateSvc.fetchCampaignCounts;
  const realDerive = schedSvc.deriveSchedules;

  // 정원 판정은 computeCampaignState 를 그대로 태운다 — 여기서는 그 입력만 스텁한다.
  schedSvc.deriveSchedules = async () => new Map();
  const setCounts = (todaySubmitted, todayActiveHolds) => {
    stateSvc.fetchCampaignCounts = async (_db, ids) => new Map(ids.map(id => [id, {
      activeHolds: todayActiveHolds, todayActiveHolds, submittedAll: todaySubmitted,
      todaySubmitted, submittedBeforeToday: 0, carry: null, hold: null, plans: null,
    }]));
  };
  const campRow = (over) => ({
    id: 'c1', participation_mode: true, status: 'active', daily_limit: 15,
    recruit_total: 0, window_start: null, window_end: null, start_date: null, ...over,
  });
  const dbWith = (row) => stubDb([[/FROM recruit_campaigns WHERE id/i, row ? [row] : []]]);

  setCounts(10, 0);
  const r1 = await svc.dailyRemainingForCampaign(dbWith(campRow()), 'c1');
  ok('J1 남은 자리를 정원 판정(computeCampaignState)에서 그대로 읽는다',
    r1 && r1.quota === 15 && r1.todayCount === 10 && r1.remaining === 5);

  setCounts(12, 3);
  const r2 = await svc.dailyRemainingForCampaign(dbWith(campRow()), 'c1');
  ok('J2 ★ 진행 중 홀드도 자리를 차지한 것으로 센다', r2 && r2.remaining === 0);

  setCounts(20, 0);
  const r3 = await svc.dailyRemainingForCampaign(dbWith(campRow()), 'c1');
  ok('J3 이미 초과면 남은 자리 0(음수로 새지 않는다)', r3 && r3.remaining === 0);

  setCounts(0, 0);
  ok('J4 참여형이 아니면 판정하지 않는다(레거시 무회귀)',
    await svc.dailyRemainingForCampaign(dbWith(campRow({ participation_mode: false })), 'c1') === null);
  ok('J5 공고를 못 찾으면 판정하지 않는다',
    await svc.dailyRemainingForCampaign(dbWith(null), 'c1') === null);
  ok('J6 campaignId 가 없으면 판정하지 않는다',
    await svc.dailyRemainingForCampaign(dbWith(campRow()), '') === null);
  ok('J7 ★ 일건수 0(무제한)은 판정하지 않는다',
    await svc.dailyRemainingForCampaign(dbWith(campRow({ daily_limit: 0 })), 'c1') === null);

  // ★ fail-soft — 조회가 터져도 null(통과). 외부모집은 약속된 구매라 우리 오류로 막지 않는다.
  const boom = { query: async () => { throw new Error('DB down'); } };
  ok('J8 ★ 조회 실패는 null = 통과(모르면 막지 않는다)',
    await svc.dailyRemainingForCampaign(boom, 'c1') === null);

  stateSvc.fetchCampaignCounts = realCounts;
  schedSvc.deriveSchedules = realDerive;
}
{
  // 게이트가 **원장 기록 전**에 걸리는지 = 주문만 접수되고 정원은 미반영인 어긋난 상태 금지.
  // ★ 서비스가 모듈 스코프의 pool 을 직접 쓰므로 **pool 자체를 갈아끼운다** — 밖에서 export 를
  //   감싸는 방식은 렉시컬 참조라 먹지 않는다(CS 뱃지 훅에서 겪은 그 함정).
  const poolMod = require('../src/db/pool');
  const stateSvc = require('../src/services/campaignState.service');
  const schedSvc = require('../src/services/campaignSchedule.service');
  const realQuery = poolMod.query, realCounts = stateSvc.fetchCampaignCounts;
  const realDerive = schedSvc.deriveSchedules;

  poolMod.query = async (sql) => (/FROM recruit_campaigns WHERE id/i.test(String(sql))
    ? { rows: [{ id: 'c1', participation_mode: true, status: 'active', daily_limit: 15, recruit_total: 0,
                 window_start: null, window_end: null, start_date: null }] }
    : { rows: [] });
  schedSvc.deriveSchedules = async () => new Map();
  stateSvc.fetchCampaignCounts = async (_db, ids) => new Map(ids.map(id => [id, {
    activeHolds: 0, todayActiveHolds: 0, submittedAll: 15, todaySubmitted: 15,
    submittedBeforeToday: 0, carry: null, hold: null, plans: null,
  }]));
  const fields = { recipient: '가나', phone: '010-1111-2222', address: 'a', bank: 'b', account: 'c', depositor: 'd' };
  const args = { sheetId: 'S', tabName: 'T', gid: '', fields, campaignId: 'c1', adminName: 'A', force: true };

  /* ★★ 원장 호출은 **스텁할 수 없다** — 서비스가 require 시점에 구조분해로 캡처하기 때문
     (`const { createOrderLedgerEntry } = require(...)`). export 를 갈아끼워도 렉시컬 참조는
     그대로다. 그래서 "스텁이 몇 번 불렸나" 대신 **실제로 거기까지 갔는지**로 고정한다:
     이 테스트 환경엔 DB 가 없어 원장에 도달하면 반드시 그 안에서 예외가 난다. */
  const run = async (over) => {
    try { return { res: await svc.submitExternalOrder({ ...args, allowOverDaily: over }), atLedger: false }; }
    catch (e) { return { res: null, atLedger: /orderLedger|createOrderLedgerEntry/.test(e.stack || '') }; }
  };

  const a = await run(false);
  ok('J9 ★ 오늘 정원이 찼으면 확인 없이는 접수하지 않는다',
    a.res && a.res.ok === false && a.res.overDaily === true);
  ok('J10 ★★ 거절은 원장에 닿기 전에 일어난다(부분 처리 0)', a.atLedger === false);
  ok('J11 거절 문구가 숫자를 말한다(무엇을 확인하는지)',
    /15/.test(a.res.error) && !!a.res.quota && a.res.quota.quota === 15);

  // 확인을 받으면 게이트를 지나 원장까지 간다 — 막는 기능이 아니다(사용자 확정).
  const b = await run(true);
  ok('J12 ★★ 확인하면 초과여도 원장까지 진행된다(외부모집 흐름을 죽이지 않는다)', b.atLedger === true);

  poolMod.query = realQuery; stateSvc.fetchCampaignCounts = realCounts;
  schedSvc.deriveSchedules = realDerive;
}
{
  /* ★★ 정적 검사만으로는 "조건이 살아 있나"를 못 본다(변이시험이 `if (false)` 로 뚫었다).
     → 라우트 핸들러를 **실제로 호출**해 쓰기 0건으로 되돌아오는지 확인한다. */
  const poolMod = require('../src/db/pool');
  const stateSvc = require('../src/services/campaignState.service');
  const schedSvc = require('../src/services/campaignSchedule.service');
  const realQuery = poolMod.query, realCounts = stateSvc.fetchCampaignCounts, realDerive = schedSvc.deriveSchedules;
  let writes = 0;
  poolMod.query = async (sql) => {
    const q = String(sql);
    if (!/^\s*SELECT/i.test(q)) writes++;
    return /FROM recruit_campaigns WHERE id/i.test(q)
      ? { rows: [{ id: 'c1', participation_mode: true, status: 'active', daily_limit: 15, recruit_total: 0,
                   window_start: null, window_end: null, start_date: null }] }
      : { rows: [] };
  };
  schedSvc.deriveSchedules = async () => new Map();
  let todaySub = 14;   // 정원 15 → 남은 자리 1
  stateSvc.fetchCampaignCounts = async (_db, ids) => new Map(ids.map(id => [id, {
    activeHolds: 0, todayActiveHolds: 0, submittedAll: todaySub, todaySubmitted: todaySub,
    submittedBeforeToday: 0, carry: null, hold: null, plans: null,
  }]));

  const router = require('../src/routes/manualOrder.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/submit');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const f = { recipient: '가', phone: '010-1111-2222', address: 'a', bank: 'b', account: 'c', depositor: 'd' };
  const call = async (body) => {
    let out = null;
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { out = v; return this; } };
    await handler({ body, admin: { name: 'A' } }, res, (e) => { if (e) throw e; });
    return out;
  };

  // 남은 자리 1(15-14)인데 3건 제출 → 확인 요구 + 쓰기 0건
  const r = await call({ sheetId: 'S', tabName: 'T', campaignId: 'c1', items: [{ fields: f }, { fields: f }, { fields: f }] });
  ok('J13 ★★ 남은 자리보다 많이 제출하면 확인을 요구한다', r && r.ok === false && r.needConfirm === 'over_daily');
  ok('J14 ★★ 그때 쓰기는 0건이다(부분 처리 금지)', writes === 0);
  ok('J15 초과 숫자를 그대로 알려준다', r.quota && r.quota.remaining === 1 && r.quota.want === 3 && r.quota.over === 2);

  /* ★★ 확인한 뒤에는 **끝까지 통과해야 한다** — 라우트가 서비스에 확인값을 안 넘기면
     건별 게이트가 다시 거절해 "확인했는데 계속 막히는" 막다른 길이 된다(변이시험이 잡은 구멍). */
  //   ★ 자리가 **완전히 찬** 상태로 본다 — 남은 자리가 남아 있으면 건별 게이트가 애초에
  //     발동하지 않아, 확인값이 서비스까지 갔는지 확인할 수 없다(변이시험으로 확인).
  todaySub = 15;
  const r3 = await call({ sheetId: 'S', tabName: 'T', campaignId: 'c1', allowOverDaily: true,
                          items: [{ fields: f }, { fields: f }, { fields: f }] });
  todaySub = 14;
  ok('J16 ★★ 확인하면 건별 게이트도 통과한다(막다른 길 금지)',
    r3 && r3.needConfirm !== 'over_daily'
    && !(r3.results || []).some(x => /확인이 필요/.test(String(x.error || ''))));

  // 남은 자리 안이면 확인 없이 종전대로 진행한다(무회귀)
  const r2 = await call({ sheetId: 'S', tabName: 'T', campaignId: 'c1', items: [{ fields: f }] });
  ok('J17 ★ 남은 자리 안이면 확인을 묻지 않는다(무회귀)', !r2 || r2.needConfirm !== 'over_daily');

  poolMod.query = realQuery; stateSvc.fetchCampaignCounts = realCounts; schedSvc.deriveSchedules = realDerive;
}
{
  const src = nc(R('src/routes/manualOrder.routes.js'));
  ok('J18 라우트가 배치 시작 전에 1회 판정한다(부분 처리 방지)',
    /dailyRemainingForCampaign\(pool, campaignId\)/.test(src) && /needConfirm: 'over_daily'/.test(src));
  ok('J19 ★ 확인값은 프론트가 보낸 것만 인정(기본 false)',
    /allowOverDaily = b\.allowOverDaily === true/.test(src));
  ok('J20 ★ 확인 후 접수는 결과에 남는다(조용한 초과 금지)',
    /초과해 접수했습니다/.test(src));
  const svcSrc = nc(R('src/services/manualOrder.service.js'));
  ok('J21 ★ 건별 게이트가 서버 최종 방어로 남는다(낡은 화면 우회 차단)',
    /if \(campaignId && !allowOverDaily\)/.test(svcSrc));
  ok('J22 ★★ 정원 판정 사본 금지 — daily_limit 을 직접 세지 않는다',
    /computeCampaignState/.test(svcSrc) && !/daily_limit\s*-\s*/.test(svcSrc));
  const fe = nc(F('js/manual-order.js'));
  ok('J23 프론트가 확인창을 띄우고 allowOverDaily 로 재전송한다',
    /needConfirm === 'over_daily'/.test(fe) && /post\(true\)/.test(fe));
  ok('J24 ★ 취소하면 아무것도 보내지 않는다', /if \(!okGo\)/.test(fe));
}

console.log(`\n✅ manualOrderExternal 회귀가드 통과 — ${passed}건\n`);
}

main().catch(err => { console.error('\n❌ ' + err.message + '\n'); process.exit(1); });
