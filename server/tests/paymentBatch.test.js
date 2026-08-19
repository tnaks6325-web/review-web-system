'use strict';
/**
 * 회귀가드 — 리뷰비 입금 자동화 M1 (086)
 *
 * 실행: node tests/paymentBatch.test.js
 *      PGTEST_URL=postgres://... node tests/paymentBatch.test.js   (진짜 PG 검증까지)
 *
 * ★ 이 가드가 지키는 것(완화 금지):
 *   ① 이중입금 방지 — 다운로드 이력 잠금 + DB 부분유니크
 *   ② 은행 판정은 정확일치만(부분일치 금지: '하나' → '하나증권' 오매칭 = 남의 계좌로 송금)
 *   ③ 이체 설정은 화이트리스트 2값만(오타값이 조용히 저장되면 그 탭이 입금에서 통째로 빠진다)
 *   ④ 리뷰어앱 스코프 토큰은 이체 설정을 못 바꾼다
 *   ⑤ 쓰기 표면은 payment_* 두 테이블뿐(시트·주문원장 무접촉)
 */

// ★ pool 은 require 시점에 DATABASE_URL 을 읽는다 — 아래 어떤 require 보다 먼저 세팅해야 한다
//   (payment.service 가 [2]절에서 pool 을 끌어오므로 뒤늦게 설정하면 연결이 안 잡힌다)
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const R = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const RF = p => fs.readFileSync(path.join(ROOT, '..', 'frontend', p), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

/* ═══ 1. 은행 코드 판정(순수함수 실행) ═══════════════════════ */
console.log('\n[1] 은행 코드 판정 — utils/bankCodes');
const bc = require('../src/utils/bankCodes');

t('실측 리뷰어 표기가 전부 해석된다', () => {
  const expect = {
    '신한': '088', '우리': '020', '국민': '004', '기업': '003', 'KEB하나': '081',
    '농협': '011', '케이뱅크': '089', '카카오뱅크': '090', '토스뱅크': '092',
    '카카오': '090', '토스': '092', '새마을금고': '045', '우체국': '071',
  };
  for (const [k, v] of Object.entries(expect)) {
    const r = bc.resolveBank(k);
    assert.ok(r, `${k} 판정 실패`);
    assert.strictEqual(r.code, v, `${k} → ${r.code} (기대 ${v})`);
  }
});

t('★ 부분일치 금지 — 하나/하나증권, 신한/신한투자증권이 갈린다', () => {
  assert.strictEqual(bc.resolveBank('하나').code, '081');
  assert.strictEqual(bc.resolveBank('하나증권').code, '270');
  assert.strictEqual(bc.resolveBank('신한').code, '088');
  assert.strictEqual(bc.resolveBank('신한투자증권').code, '278');
  assert.strictEqual(bc.resolveBank('토스').code, '092');
  assert.strictEqual(bc.resolveBank('토스증권').code, '271');
});

t('★ 모르는 은행은 추측하지 않고 null (계좌미비로 드러남)', () => {
  for (const v of ['없는은행', '', null, undefined, '   ', '@@@']) {
    assert.strictEqual(bc.resolveBank(v), null, `${JSON.stringify(v)} 가 판정됐다`);
  }
});

t('숫자 코드 입력도 받는다(앞 0 없는 45 → 045)', () => {
  assert.strictEqual(bc.resolveBank('088').code, '088');
  assert.strictEqual(bc.resolveBank('45').code, '045');
  assert.strictEqual(bc.resolveBank('999'), null);
});

t('계좌번호는 숫자만 남긴다', () => {
  assert.strictEqual(bc.normalizeAccount('1002-839-010303'), '1002839010303');
  assert.strictEqual(bc.normalizeAccount(null), '');
});

t('통장표시 — 한글 8자(16byte) 상한 + 허용문자 필터', () => {
  assert.strictEqual(bc.normalizeMemo('파우더망고'), '파우더망고');
  assert.strictEqual(bc.normalizeMemo('아주긴통장표시이름입니다').length, 8);
  assert.ok(!bc.normalizeMemo('a<b>&c 만두').includes('<'), '꺾쇠가 남았다');
});

t('bankNameByCode 는 공식 명칭을 돌려준다(원문 표기 아님)', () => {
  assert.strictEqual(bc.bankNameByCode('088'), '신한은행');
  assert.strictEqual(bc.bankNameByCode('90'), '카카오뱅크');
  assert.strictEqual(bc.bankNameByCode('999'), '');
});

t('코드표는 케이뱅크 공식 양식 72개 그대로', () => {
  assert.strictEqual(bc.BANKS.length, 72, '은행 수가 바뀌었다(양식 원본과 대조 필요)');
  const codes = bc.BANKS.map(b => b[0]);
  assert.strictEqual(new Set(codes).size, codes.length, '중복 코드');
  assert.ok(codes.every(c => /^[0-9]{3}$/.test(c)), '3자리 아닌 코드');
});

/* ═══ 2. 물건비 수취방식 → 은행 자동분류 ═════════════════════ */
console.log('\n[2] 이체은행 자동분류 — payment.service.bankFromGoodsCostType');
const paySvc = require('../src/services/payment.service');

t('★ 현금이체 → 하나은행 / 수수료(계산서) → 케이뱅크 (사용자 확정)', () => {
  assert.strictEqual(paySvc.bankFromGoodsCostType('현금'), 'hana');
  assert.strictEqual(paySvc.bankFromGoodsCostType('현금이체'), 'hana');
  assert.strictEqual(paySvc.bankFromGoodsCostType('계산서'), 'kbank');
  assert.strictEqual(paySvc.bankFromGoodsCostType('세금계산서'), 'kbank');
  assert.strictEqual(paySvc.bankFromGoodsCostType('수수료'), 'kbank');
});

t('알 수 없는 값·빈 값은 null (은행 미지정으로 드러남)', () => {
  for (const v of ['', null, undefined, '기타', '미정']) {
    assert.strictEqual(paySvc.bankFromGoodsCostType(v), null, `${JSON.stringify(v)} 가 은행으로 판정됐다`);
  }
});

t('프론트 힌트 판정이 서버 규칙과 같은 문자열을 본다', () => {
  const js = RF('js/index-recruit.js');
  const m = js.match(/function _rfTransferHint[\s\S]{0,1400}?\n}/);
  assert.ok(m, '_rfTransferHint 가 없다');
  assert.ok(/\/현금\//.test(m[0]), '현금 판정이 없다');
  assert.ok(/계산서\|세금\|수수료/.test(m[0]), '계산서/세금/수수료 판정이 서버와 다르다');
});

/* ═══ 3. 마이그레이션 086 구조 ═══════════════════════════════ */
console.log('\n[3] 마이그레이션 086 — 구조·타입');
const mig = R('migrations/086_payment_batches.sql');

t('★ campaign_id 는 TEXT — recruit_campaigns.id(TEXT)와 타입 일치(082 사고 재발 방지)', () => {
  assert.ok(/campaign_id\s+TEXT\s+REFERENCES\s+recruit_campaigns\(id\)/.test(mig),
    'campaign_id 가 TEXT REFERENCES 가 아니다');
  assert.ok(!/campaign_id\s+UUID/.test(mig), 'campaign_id 가 UUID 로 선언됐다(42804 로 파일 전체 롤백)');
  const c018 = R('migrations/018_campaigns.sql');
  assert.ok(/id\s+TEXT\s+PRIMARY KEY/.test(c018), '018 의 id 타입이 바뀌었다 — 086 도 함께 고칠 것');
});

t('★ 이중입금 방지 부분유니크가 존재하고 pending/paid 를 덮는다', () => {
  const m = mig.match(/CREATE UNIQUE INDEX[^;]*uq_payment_items_active[^;]*;/);
  assert.ok(m, 'uq_payment_items_active 가 없다');
  assert.ok(/\(sheet_id,\s*tab_name,\s*row_index\)/.test(m[0]), '행 키가 (sheet_id,tab_name,row_index) 가 아니다');
  assert.ok(/WHERE status IN \('pending',\s*'paid'\)/.test(m[0]),
    "부분조건이 pending/paid 가 아니다 — cancelled·failed 는 재대상이어야 한다");
});

t('공고 이체 설정 컬럼 2종이 추가된다', () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS transfer_bank TEXT/.test(mig));
  assert.ok(/ADD COLUMN IF NOT EXISTS transfer_memo TEXT/.test(mig));
});

t('★ 부팅 프리플라이트에 등록 — 없으면 공고 발행·수정이 전면 42703', () => {
  const idx = R('index.js');
  assert.ok(/\['recruit_campaigns',\s*'transfer_bank'\]/.test(idx), 'transfer_bank 미등록');
  assert.ok(/\['recruit_campaigns',\s*'transfer_memo'\]/.test(idx), 'transfer_memo 미등록');
});

/* ═══ 4. 서비스 쓰기 표면 · 잠금 규칙 ════════════════════════ */
console.log('\n[4] payment.service — 쓰기 표면·잠금');
const svcSrc = R('src/services/payment.service.js');
const noComment = svcSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ★ 쓰기 표면 — 두 구역으로 나뉜다(계약이 다르다).
     ① 대상 추출·회차(M1 본체) = payment_* 에만 쓴다. review_index·order_submissions·시트는 읽기만.
     ② 보류 사유 보완(PaymentFixError 아래) = 사용자 확정으로 열린 구역이라
        **정확히 세 테이블**(공고 이체설정·탭 이체설정·리뷰어 계좌)에만 쓴다.
     구역을 합쳐서 검사하면 ①이 조용히 넓어져도 통과하므로 경계를 지켜 따로 센다. */
const _fixMark = 'class PaymentFixError';
const _m1Src = noComment.split(_fixMark)[0];
const _fixSrc = noComment.includes(_fixMark) ? noComment.slice(noComment.indexOf(_fixMark)) : '';
const _writesIn = s => [...s.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi)].map(m => m[2].toLowerCase());

t('★ M1 본체(대상 추출·회차)의 쓰기는 payment_* 테이블에만 한다', () => {
  const bad = _writesIn(_m1Src).filter(t2 => !t2.startsWith('payment_'));
  assert.deepStrictEqual(bad, [], '운영 테이블에 쓰고 있다: ' + bad.join(', '));
});

t('★ 보완 경로의 쓰기는 이체설정·리뷰어 계좌 3곳뿐(주문 원장·회차·검색인덱스 무접촉)', () => {
  assert.ok(_fixSrc, '보완 경로(PaymentFixError)를 찾지 못했다 — 경계 표식이 바뀌었다면 가드를 갱신할 것');
  const tables = [...new Set(_writesIn(_fixSrc))].sort();
  assert.deepStrictEqual(tables, ['recruit_campaigns', 'reviewers', 'tab_configs'],
    '보완 경로가 다른 테이블을 건드린다: ' + tables.join(', '));
});

t('★ 시트 API 무접촉 (M1 은 DB 전용)', () => {
  // exceljs 의 wb.worksheets 는 엑셀 생성이라 무관 — 구글 시트 API·큐 호출만 본다
  for (const pat of [/googleapis/, /google\.sheets/, /spreadsheets\./, /throttledCall/, /driveThrottledCall/, /enqueue\(/]) {
    assert.ok(!pat.test(noComment), `시트/큐 호출이 들어왔다(${pat}) — M1 은 시트 무접촉이어야 한다`);
  }
});

t('★ 대상 추출에 다운로드 이력 잠금 조건이 있다', () => {
  assert.ok(/NOT EXISTS[\s\S]{0,220}payment_batch_items[\s\S]{0,220}status IN \('pending',\s*'paid'\)/.test(noComment),
    '살아있는 회차 항목 제외 조건이 없다 = 이중입금');
});

t('★ 미입금 판정이 search.service 와 같은 출처(PAYMENT_COL_KEYWORDS)를 쓴다', () => {
  assert.ok(/PAYMENT_COL_KEYWORDS/.test(svcSrc), '입금 키워드 사본을 만들었다');
  assert.ok(/is_submitted2 = 'PAID'/.test(noComment), 'PAID 판정이 없다');
});

t('★ 리뷰비는 utils/campaignFee 단일 출처로 판정한다', () => {
  assert.ok(/resolveReviewFee/.test(svcSrc), '리뷰비 판정 사본을 만들었다(화면마다 금액이 갈라진다)');
});

t('createBatch 는 화면 값을 믿지 않고 대상을 서버에서 재계산한다', () => {
  const fn = svcSrc.match(/async function createBatch[\s\S]*?\n}/);
  assert.ok(fn, 'createBatch 없음');
  assert.ok(/listPaymentTargets\(\)/.test(fn[0]), '재계산 없이 요청 값을 그대로 담고 있다');
  assert.ok(/it\.bank !== bank/.test(fn[0]), '다른 은행 건이 섞여도 걸러내지 않는다');
  assert.ok(/23505/.test(fn[0]), '동시 담기(부분유니크 위반) 처리가 없다');
});

t('cancelBatch 는 이미 반영·입금된 회차를 막는다', () => {
  const fn = svcSrc.match(/async function cancelBatch[\s\S]*?\n}/);
  assert.ok(/status === 'applied'/.test(fn[0]), 'applied 회차 취소가 막히지 않는다');
  assert.ok(/status = 'paid'/.test(fn[0]), '입금완료 항목 포함 시 차단이 없다');
});

// buildWorkbook 안의 은행별 분기를 잘라 본다(직렬화 형식과 무관하게 값 규칙을 고정)
const _bwSrc = (() => {
  const a = svcSrc.indexOf('async function buildWorkbook(');
  const b = svcSrc.indexOf('function batchFileName(', a);
  return a >= 0 && b > a ? svcSrc.slice(a, b) : '';
})();
const _bwKbank = _bwSrc.slice(_bwSrc.indexOf("if (bank === 'kbank')"), _bwSrc.indexOf('} else {'));
const _bwHana = _bwSrc.slice(_bwSrc.indexOf('} else {'));

t('은행 서식 헤더가 공식 양식 그대로다', () => {
  assert.ok(svcSrc.includes("'* 입금은행(코드/은행명/증권사명)'"), '케이뱅크 헤더가 바뀌었다');
  assert.ok(/sheet: '대량이체등록정보'/.test(svcSrc), '케이뱅크 시트명이 바뀌었다');
  assert.ok(/sheet: '다건이체'/.test(svcSrc), '하나은행 시트명이 바뀌었다');
  assert.ok(svcSrc.includes("'입금은행코드'") && svcSrc.includes("'예상예금주'"), '하나은행 헤더가 바뀌었다');
});

t('★ 하나은행 은행코드는 문자열로 쓴다(앞 0 유실 방지)', () => {
  assert.ok(/String\(it\.bank_code \|\| it\.bankCode \|\| ''\)/.test(_bwHana),
    "bank_code 를 String() 없이 넣으면 '045'가 45 가 된다");
});

t('★ 케이뱅크 은행명은 코드에서 파생한 정식명(리뷰어 원문 아님)', () => {
  assert.ok(/bankNameByCode\(code\)/.test(_bwKbank),
    "리뷰어 원문('신한')을 그대로 넣으면 양식 형식 검증에서 거부될 수 있다");
});

/* ═══ 5. 라우트 — 권한·등록 ══════════════════════════════════ */
console.log('\n[5] 라우트 — /api/trackb/payment/*');
const trackB = require('../src/routes/trackB.routes');
const layers = trackB.stack.filter(l => l.route);
const findRoute = (method, p) => layers.find(l => l.route.path === p && l.route.methods[method]);

t('입금관리 라우트 6종이 등록돼 있다', () => {
  const want = [['get', '/payment/targets'], ['post', '/payment/batch'], ['get', '/payment/batches'],
    ['get', '/payment/batch/:id'], ['get', '/payment/batch/:id/file'], ['post', '/payment/batch/:id/cancel']];
  for (const [m, p] of want) assert.ok(findRoute(m, p), `${m.toUpperCase()} ${p} 미등록`);
});

t('★ 목록 라우트가 상세보다 먼저 등록됐다(라우트 삼킴 방지)', () => {
  const iList = layers.findIndex(l => l.route.path === '/payment/batches');
  const iOne = layers.findIndex(l => l.route.path === '/payment/batch/:id');
  assert.ok(iList >= 0 && iOne >= 0 && iList < iOne, '/payment/batches 가 /payment/batch/:id 뒤에 있다');
});

t('★ 회차 결과는 재업로드 미리보기보다 실제 반영된 결과를 우선 표시한다', () => {
  assert.ok(/ORDER BY \(applied = TRUE\) DESC,[\s\S]{0,120}uploaded_at DESC/.test(svcSrc),
    '최신 미리보기 파일이 실제 반영된 결과를 덮어 표시한다');
});

t('★ 전 라우트가 authMiddleware + adminOrMaster (AE·광고주 차단 — 계좌 PII)', () => {
  const src = R('src/routes/trackB.routes.js');
  const block = src.slice(src.indexOf('입금관리 — 리뷰비 입금 자동화'));
  const decls = [...block.matchAll(/router\.(get|post)\('\/payment[^']*',([^,]+),([^,]+),/g)];
  assert.ok(decls.length >= 6, '입금 라우트 선언을 못 찾았다');
  for (const d of decls) {
    assert.ok(/authMiddleware/.test(d[2]), `${d[0]} 에 authMiddleware 가 없다`);
    assert.ok(/adminOrMasterMiddleware/.test(d[3]), `${d[0]} 이 adminOrMaster 가 아니다`);
  }
  assert.ok(!/router\.(get|post)\('\/payment[^']*',\s*authMiddleware,\s*(internalMiddleware|editorOnly)/.test(block),
    '내부인 전체에 열려 있다 — 계좌번호가 AE 에게 노출된다');
});

/* ═══ 6. 공고 저장 — 이체 설정 ═══════════════════════════════ */
console.log('\n[6] 공고 저장 — transfer_bank / transfer_memo');
const campSrc = R('src/routes/campaign.routes.js');

t('★ 화이트리스트 2값만 저장된다(오타값은 자동으로 접지)', () => {
  const fn = campSrc.match(/function _normTransferBank[\s\S]*?\n}/);
  assert.ok(fn, '_normTransferBank 가 없다');
  assert.ok(/'kbank'\s*\|\|\s*s === 'hana'/.test(fn[0]) || /s === 'kbank' \|\| s === 'hana'/.test(fn[0]),
    'kbank/hana 두 값만 통과시키지 않는다');
  assert.ok(/: null/.test(fn[0]), '알 수 없는 값이 null 로 접지되지 않는다');
});

t('INSERT/UPDATE 자리표시자 수가 값 배열과 맞는다(bind 파라미터 500 방지)', () => {
  const ins = campSrc.match(/INSERT INTO recruit_campaigns\s*\n\s*\(([^)]+)\)\s*\n\s*VALUES \(([\s\S]*?)\)\s*\n\s*RETURNING/);
  assert.ok(ins, 'INSERT 문을 찾지 못했다');
  const cols = ins[1].split(',').map(x => x.trim()).filter(Boolean);
  const maxP = Math.max(...[...ins[2].matchAll(/\$(\d+)/g)].map(m => +m[1]));
  assert.strictEqual(cols.length, maxP, `INSERT 컬럼 ${cols.length} ≠ 자리표시자 ${maxP}`);
  assert.ok(cols.includes('transfer_bank') && cols.includes('transfer_memo'), 'INSERT 에 이체 설정이 없다');
});

t('UPDATE 는 CASE 센티널 — 미전달=유지 / 빈값=자동복귀', () => {
  assert.ok(/transfer_bank = CASE WHEN \$\d+::text IS NULL THEN transfer_bank[\s\S]{0,120}THEN NULL/.test(campSrc),
    'transfer_bank 가 CASE 센티널이 아니다(빈값과 미전달을 구분 못 함)');
  assert.ok(/transfer_memo = CASE WHEN \$\d+::text IS NULL THEN transfer_memo/.test(campSrc));
});

t('req.body 구조분해에 두 필드가 있다(#361 재발 방지)', () => {
  const n = (campSrc.match(/transfer_bank,\s*transfer_memo,/g) || []).length;
  assert.ok(n >= 2, `create/update 양쪽 구조분해에 있어야 한다 (발견 ${n})`);
});

t('★ 리뷰어앱 스코프 토큰은 이체 설정을 못 바꾼다', () => {
  const i = campSrc.indexOf('async function _scopedCampaignEdit');
  assert.ok(i > 0, '_scopedCampaignEdit 없음');
  // ★ 고정 길이(i+3000)로 자르면 함수가 자라는 순간 UPDATE 뒷부분이 잘려 나가 가드가 조용히 빨개진다
  //   (실제로 그랬다) — **함수 끝까지** 본다: 다음 최상위 선언 직전.
  const rest = campSrc.slice(i + 1);
  const nx = rest.search(/\n(?:async function |function |router\.|const |module\.exports)/);
  const body = campSrc.slice(i, nx > 0 ? i + 1 + nx : campSrc.length);
  const set = body.match(/UPDATE recruit_campaigns SET([\s\S]*?)WHERE id=\$1/);
  assert.ok(set, 'scoped UPDATE 를 찾지 못했다');
  assert.ok(!/transfer_bank|transfer_memo/.test(set[1]),
    '스코프 토큰이 이체 설정을 바꿀 수 있다(권한 상승)');
});

/* ═══ 7. 프론트 배선 ═════════════════════════════════════════ */
console.log('\n[7] 프론트 — 모달·입금관리 화면');
const modalJs = RF('js/recruit-modal.js');
const recruitJs = RF('js/index-recruit.js');
const wd = RF('workdesk.html');

t('모달에 이체은행 버튼 3종 + 통장표시 입력이 있다', () => {
  assert.ok(/id="rf_transfer_bank_btns"/.test(modalJs));
  assert.ok(/data-val="hana"/.test(modalJs) && /data-val="kbank"/.test(modalJs));
  assert.ok(/data-val=""[^>]*onclick="selectRfBtn\('transfer_bank'/.test(modalJs), '[자동] 버튼이 없다');
  assert.ok(/id="rf_transfer_memo"/.test(modalJs));
  assert.ok(/id="rf_transfer_bank"/.test(modalJs), 'hidden 값 필드가 없다');
});

t('통장표시 입력은 8자 상한(케이뱅크 양식 제약)', () => {
  assert.ok(/id="rf_transfer_memo"[^>]*maxlength="8"/.test(modalJs), 'maxlength=8 이 없다');
});

t('selectRfBtn 이 transfer_bank 그룹을 처리한다', () => {
  assert.ok(/#rf_transfer_bank_btns/.test(recruitJs), '컨테이너 셀렉터에 없다(다른 그룹까지 해제됨)');
  assert.ok(/group === 'transfer_bank'/.test(recruitJs), '그룹 분기가 없다');
});

t('★ 저장은 이 UI 있는 화면에서만 전송(축약 화면이 설정을 지우지 않게)', () => {
  assert.ok(/if \(document\.getElementById\("rf_transfer_bank_btns"\)\)[\s\S]{0,240}payload\.transfer_bank/.test(recruitJs),
    '가드 없이 전송하면 옵션표·work_detail 과 같은 소실 사고가 난다');
  assert.ok(/payload\.transfer_memo/.test(recruitJs));
});

t('편집 프리필·모달 초기화가 이체 설정을 복원/초기화한다', () => {
  assert.ok(/_rfPickTransferBank\(c\.transfer_bank/.test(recruitJs), '편집 프리필이 없다');
  assert.ok(/_rfPickTransferBank\(""\)/.test(recruitJs), '신규 공고 초기화가 없다');
});

t('리뷰웹시스템[3버전]에 입금관리 탭이 있다', () => {
  assert.ok(/data-v="payment"[\s\S]{0,60}입금관리/.test(wd), 'nav 버튼이 없다');
  assert.ok(/v==='payment'\) renderPaymentView\(\)/.test(wd), 'switchView 라우팅이 없다');
  assert.ok(/async function renderPaymentView/.test(wd));
});

t('★ 다운로드 전 확인 + 잠금 안내가 있다(되돌리기 어려운 동작)', () => {
  const fn = wd.match(/async function _pmDownload[\s\S]*?\n}/);
  assert.ok(fn, '_pmDownload 없음');
  assert.ok(/confirm\(/.test(fn[0]), '확인 없이 회차가 만들어진다');
  assert.ok(/잠겨/.test(fn[0]), '잠금 사실을 안내하지 않는다');
});

t('★ 보류·통장표시 미설정 건을 화면에 드러낸다(조용한 누락 금지)', () => {
  assert.ok(/보류/.test(wd) && /PAY_ISSUE_LABEL/.test(wd), '보류 사유 표기가 없다');
  assert.ok(/통장표시가 없는 건/.test(wd), '통장표시 미설정 경고가 없다');
});

t('회차 취소는 확인 + 이중입금 경고를 띄운다', () => {
  const fn = wd.match(/async function _pmCancel[\s\S]*?\n}/);
  assert.ok(/confirm\(/.test(fn[0]) && /이중입금/.test(fn[0]), '취소 경고가 부족하다');
});

/* ═══ 8. 은행 서식 파일 — 계좌 앞 0 보존 · 하이픈 제거 (DB 불필요) ═
   ★ 종전 가드는 "버퍼가 비지 않았고 PK 로 시작한다"만 봐서, 계좌를 숫자 셀로
     바꿔 앞 0 이 날아가도 그대로 통과했다. 실제로 파일을 만들어 **되읽어**
     값·타입·서식을 확인한다(담당자가 `'0123` 을 손으로 붙이던 사고 지점). */
(async () => {
  console.log('\n[8] 은행 서식 파일 — 계좌 앞 0 보존 · 하이픈 제거');
  const ExcelJS = require('exceljs');
  const XLSX = require('@e965/xlsx');
  const ACCT_COL = { kbank: 2, hana: 2 };      // 두 양식 모두 2열이 계좌
  const AMT_COL  = { kbank: 3, hana: 3 };

  /* ★★ 되읽기도 은행별 형식을 그대로 따라간다 —
        하나는 **.xls(BIFF8)** 라 exceljs 로는 열리지 않는다. 형식이 되돌아가면
        (하나가 다시 xlsx 로 나가면) 이 되읽기가 그 자리에서 터진다. */
  const readBack = async (bank, buf) => {
    const fmt = paySvc.batchFileFormat(bank);
    if (fmt.kind === 'xls') {
      const wb = XLSX.read(buf, { type: 'buffer', cellNF: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return {
        getRow: r => ({ getCell: c => {
          const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })] || {};
          return { value: cell.v === undefined ? null : cell.v, numFmt: cell.z || 'General' };
        } }),
      };
    }
    const w = new ExcelJS.Workbook();
    await w.xlsx.load(buf);
    return w.worksheets[0];
  };

  await ta('★ 계좌 앞자리 0 이 그대로 살아 있다(문자열 셀 + 텍스트 서식)', async () => {
    const items = [{ bank_code: '004', bank_account: '0123456789012', amount: 26900,
      transfer_memo: '파우더망고', account_holder: '김리뷰' }];
    for (const bank of ['kbank', 'hana']) {
      const ws = await readBack(bank, await paySvc.buildWorkbook(bank, items));
      const cell = ws.getRow(2).getCell(ACCT_COL[bank]);
      assert.strictEqual(typeof cell.value, 'string', `${bank}: 계좌가 문자열 셀이 아니다(숫자면 앞 0 소실)`);
      assert.strictEqual(cell.value, '0123456789012', `${bank}: 계좌 값이 바뀌었다 — ${cell.value}`);
      assert.strictEqual(cell.numFmt, '@', `${bank}: 계좌 셀에 텍스트 서식(@)이 없다`);
    }
  });

  await ta('★ 하이픈이 섞인 계좌도 서식에는 숫자만 나간다', async () => {
    const items = [{ bank_code: '088', bank_account: '110-123-456789', amount: 1000,
      transfer_memo: '망고', account_holder: '김리뷰' }];
    for (const bank of ['kbank', 'hana']) {
      const ws = await readBack(bank, await paySvc.buildWorkbook(bank, items));
      assert.strictEqual(ws.getRow(2).getCell(ACCT_COL[bank]).value, '110123456789',
        `${bank}: 계좌에 '-' 가 그대로 나갔다(은행 업로드 거부)`);
    }
  });

  await ta('하나 서식의 은행코드도 앞 0 을 지킨다(045 ≠ 45)', async () => {
    const ws = await readBack('hana', await paySvc.buildWorkbook('hana',
      [{ bank_code: '045', bank_account: '9002176640741', amount: 500, account_holder: '김리뷰' }]));
    const cell = ws.getRow(2).getCell(1);
    assert.strictEqual(cell.value, '045', `은행코드가 ${cell.value} 로 나갔다`);
    assert.strictEqual(cell.numFmt, '@', '은행코드 셀에 텍스트 서식이 없다');
  });

  await ta('금액은 숫자 셀로 나간다(은행 양식이 수치를 요구)', async () => {
    for (const bank of ['kbank', 'hana']) {
      const ws = await readBack(bank, await paySvc.buildWorkbook(bank,
        [{ bank_code: '004', bank_account: '0123', amount: 26900, account_holder: '김리뷰' }]));
      assert.strictEqual(ws.getRow(2).getCell(AMT_COL[bank]).value, 26900, `${bank}: 금액이 숫자가 아니다`);
    }
  });

  await ta('계좌 정규화는 사본 없이 bankCodes 단일 출처를 쓴다', async () => {
    const start = svcSrc.indexOf('async function buildWorkbook(');
    const end = svcSrc.indexOf('function batchFileName(', start);
    const fn = start >= 0 && end > start ? [svcSrc.slice(start, end)] : null;
    assert.ok(fn, 'buildWorkbook 을 못 찾았다');
    const n = (fn[0].match(/normalizeAccount\(/g) || []).length;
    assert.strictEqual(n, 2, `buildWorkbook 이 normalizeAccount 를 ${n}회 쓴다(두 양식 = 2회)`);
    assert.ok(!/replace\(\s*\/\[\^0-9\]/.test(fn[0]), 'buildWorkbook 안에 정규화 사본이 생겼다');
  });

  /* ═══ 8B. ★★ 은행별 파일 형식 — 하나은행은 구형 .xls(BIFF8) ═══
     2026-08-19 실측: 하나 기업뱅킹 다건이체 업로드가 xlsx 를
     `해당 파일은 엑셀파일이 아닙니다. 다시 올려주십시오.` 로 거부했다
     (엑셀로 다시 저장한 정상 xlsx 도 같은 거부 = 그쪽이 구형 형식만 읽는다).
     되돌아가면 담당자가 파일을 아예 못 올린다. */
  await ta('★★ 하나은행 파일은 OLE2(.xls · BIFF8) 로 나간다', async () => {
    const buf = await paySvc.buildWorkbook('hana',
      [{ bank_code: '045', bank_account: '9002176640741', amount: 500, account_holder: '김리뷰' }]);
    assert.strictEqual(buf.slice(0, 8).toString('hex'), 'd0cf11e0a1b11ae1',
      '하나 파일이 OLE2 가 아니다 — 은행이 "엑셀파일이 아닙니다" 로 거부한다');
    assert.notStrictEqual(buf.slice(0, 2).toString(), 'PK', '하나 파일이 여전히 xlsx(zip) 다');
  });

  await ta('케이뱅크 파일은 종전대로 xlsx(zip) 다(무회귀)', async () => {
    const buf = await paySvc.buildWorkbook('kbank',
      [{ bank_code: '045', bank_account: '9002176640741', amount: 500, account_holder: '김리뷰' }]);
    assert.strictEqual(buf.slice(0, 2).toString(), 'PK', '케이뱅크 파일 형식이 바뀌었다');
  });

  await ta('★ 확장자·MIME 는 단일 출처이고 파일명과 갈리지 않는다', async () => {
    const hana = paySvc.batchFileFormat('hana');
    const kbank = paySvc.batchFileFormat('kbank');
    assert.strictEqual(hana.ext, 'xls', '하나 확장자가 .xls 가 아니다(내용은 xls 인데 이름이 xlsx 면 은행이 거부)');
    assert.strictEqual(hana.mime, 'application/vnd.ms-excel', '하나 MIME 가 구형 엑셀이 아니다');
    assert.strictEqual(kbank.ext, 'xlsx', '케이뱅크 확장자가 바뀌었다');
    for (const bank of ['hana', 'kbank']) {
      const name = paySvc.batchFileName({ bank, createdAt: '2026-08-19T00:00:00Z', seq: 7 });
      assert.ok(name.endsWith('.' + paySvc.batchFileFormat(bank).ext),
        `${bank}: 파일명 확장자(${name})가 형식과 다르다`);
    }
  });

  await ta('★ 다운로드 라우트가 확장자·MIME 를 하드코딩하지 않는다', async () => {
    const rt = R('src/routes/trackB.routes.js');
    const i = rt.indexOf("router.get('/payment/batch/:id/file'");
    const fn = rt.slice(i, rt.indexOf('\nrouter.', i + 10));
    assert.ok(/batchFileFormat\(/.test(fn), '라우트가 형식 단일 출처를 안 쓴다');
    assert.ok(/Content-Type', fmt\.mime/.test(fn), 'MIME 가 하드코딩돼 있다(하나 파일이 xlsx MIME 로 나간다)');
    assert.ok(!/payment_\$\{out\.batch\.seq\}\.xlsx/.test(fn), 'ASCII 폴백 파일명에 .xlsx 가 하드코딩돼 있다');
  });

  await ta('킬스위치 PAYMENT_HANA_XLS=0 이면 하나도 종전 xlsx 로 되돌아간다', async () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['-e', `
      const svc = require('./src/services/payment.service');
      svc.buildWorkbook('hana', [{ bank_code: '045', bank_account: '1', amount: 1 }])
        .then(b => console.log(b.slice(0, 2).toString() + '|' + svc.batchFileFormat('hana').ext));
    `], { cwd: ROOT, env: { ...process.env, PAYMENT_HANA_XLS: '0', DATABASE_URL: '' }, encoding: 'utf8' });
    assert.ok(out.includes('PK|xlsx'), `킬스위치가 안 먹는다 — ${out.trim()}`);
  });

  /* ═══ 9. 진짜 PG 검증 (PGTEST_URL 있을 때만) ═════════════════ */
  if (!process.env.PGTEST_URL) {
    console.log('\n[9] PG 검증 — PGTEST_URL 미설정으로 건너뜀 (권장: 로컬 PG16 으로 실행)');
  } else {
    console.log('\n[9] 진짜 PG 검증 — 잠금·취소·서식');
    const pool = require('../src/db/pool');
    const svc = require('../src/services/payment.service');

    await ta('마이그레이션 086 이 idempotent 하다', async () => {
      const sql = mig;
      await pool.query(sql); await pool.query(sql);   // 두 번 돌려도 실패하지 않아야 한다
    });

    await ta('★ 같은 행을 살아있는 상태로 두 번 담을 수 없다(부분유니크)', async () => {
      const { rows: [b] } = await pool.query(
        `INSERT INTO payment_batches (bank, created_by) VALUES ('kbank','t') RETURNING id`);
      const ins = () => pool.query(
        `INSERT INTO payment_batch_items (batch_id, sheet_id, tab_name, row_index, amount)
         VALUES ($1,'GUARD','T',1,1000)`, [b.id]);
      await ins();
      let blocked = false;
      try { await ins(); } catch (e) { blocked = (e.code === '23505'); }
      assert.ok(blocked, '중복 담기가 통과했다 = 이중입금');
      // cancelled 로 내리면 다시 담을 수 있어야 한다
      await pool.query(`UPDATE payment_batch_items SET status='cancelled' WHERE sheet_id='GUARD'`);
      await ins();
      await pool.query(`DELETE FROM payment_batches WHERE id=$1`, [b.id]);
    });

    await ta('★ CHECK 제약이 알 수 없는 은행·상태를 막는다', async () => {
      let bad = false;
      try { await pool.query(`INSERT INTO payment_batches (bank) VALUES ('woori')`); }
      catch (e) { bad = (e.code === '23514'); }
      assert.ok(bad, '알 수 없는 은행이 저장됐다');
    });

    // ★★ 이 검사가 없어서 42703(order_submissions.created_at 오타)이 배포까지 갔다.
    //   빈 DB 로 호출하면 rows.length===0 조기 반환이라 **후속 조인 쿼리가 한 줄도 안 돈다**.
    //   반드시 대상 행을 하나 만들어 _loadCampaigns/_loadOrderPrices/_loadAccounts/_loadTabLabels
    //   네 쿼리를 전부 실행시켜야 컬럼명 오타가 잡힌다.
    await ta('★ 입금대상 추출이 후속 조인까지 실제로 실행된다(컬럼명 오타 차단)', async () => {
      const SID = '__GUARD_SHEET__', TAB = '__GUARD_TAB__';
      await pool.query(`DELETE FROM review_index WHERE sheet_id=$1`, [SID]);
      await pool.query(`DELETE FROM order_submissions WHERE sheet_id=$1`, [SID]);
      await pool.query(
        `INSERT INTO review_index (reviewer_name, sheet_id, tab_name, row_index, is_submitted, is_submitted2, row_json, start_date, phone8)
         VALUES ('가드','${SID}','${TAB}', 1, TRUE, 'NONE', '{}'::jsonb, '8 / 1 (토)', '99999999')`);
      await pool.query(
        `INSERT INTO order_submissions (sheet_id, tab_name, sheet_row, price) VALUES ($1,$2,1,'10000')`, [SID, TAB]);
      try {
        const out = await svc.listPaymentTargets({ sheetId: SID });
        assert.ok(out.items.length === 1, `대상이 ${out.items.length}건 — 조인 경로를 못 탔다`);
        assert.strictEqual(out.items[0].productPrice, 10000, '주문 결제금액이 붙지 않았다(조인 실패)');
      } finally {
        await pool.query(`DELETE FROM review_index WHERE sheet_id=$1`, [SID]);
        await pool.query(`DELETE FROM order_submissions WHERE sheet_id=$1`, [SID]);
      }
    });

    await ta('★ 조회하는 컬럼이 실제 스키마에 있다(order_submissions 는 submitted_at)', async () => {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='order_submissions' AND column_name IN ('created_at','submitted_at')`);
      const have = new Set(rows.map(r => r.column_name));
      assert.ok(have.has('submitted_at'), 'order_submissions.submitted_at 이 없다');
      // 서비스와 리뷰어 라우트가 없는 컬럼을 참조하지 않는지(같은 실수 재발 방지)
      for (const f of ['src/services/payment.service.js', 'src/routes/reviewer.routes.js']) {
        const src = R(f);
        const q = src.match(/SELECT[^`]*FROM order_submissions/g) || [];
        for (const one of q) {
          assert.ok(!/\bcreated_at\b/.test(one),
            `${f} 가 order_submissions 에서 created_at 을 읽는다(42703)`);
        }
      }
    });

    await ta('은행 서식 파일이 실제로 만들어진다(두 은행)', async () => {
      const items = [{ bank_code: '045', bank_account: '9002176640741', amount: 26900,
        transfer_memo: '파우더망고', account_holder: '김리뷰' }];
      const SIG = { kbank: '504b', hana: 'd0cf' };   // 케이뱅크=zip(xlsx) · 하나=OLE2(xls)
      for (const bank of ['kbank', 'hana']) {
        const buf = await svc.buildWorkbook(bank, items);
        assert.ok(Buffer.isBuffer(buf) && buf.length > 3000, `${bank} 파일이 비었다`);
        assert.strictEqual(buf.slice(0, 2).toString('hex'), SIG[bank], `${bank} 파일 형식이 바뀌었다`);
      }
    });

    await pool.end();
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
