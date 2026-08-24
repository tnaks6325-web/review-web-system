/**
 * 결제금액 편차 경고칠 회귀 가드 (사용자 확정 2026-08-23).
 *
 * 무엇을 지키나:
 *   §1 판정(resolvePriceDeviation) — 파서 단일 출처 · 임계 10% 경계 · 양방향 · 근거 없으면 안 칠함
 *   §2 배선(_attachPriceDeviation) — 옵션금액 우선 · 칠할 칸 = 입금관리가 읽는 그 칸 · 주문 없는 줄 제외
 *   §3 무인 자동적용 하드 제외 — 입금 대상(bank/account/depositor)이 어떤 env 설정으로도 안 새는가
 *   §4 화면 배선(workdesk.html) — 서버가 지정한 칸만 칠하는가(화면에 판정 사본 금지)
 *
 * 실행: node tests/workdeskPriceDeviation.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { resolvePriceDeviation, PRICE_DEV_THRESHOLD } = require('../src/utils/paymentAmount');

// ══════════════════════════════════════════════════════════════
// §1 판정 — 순수함수 직접 실행
// ══════════════════════════════════════════════════════════════
function section1() {
  // (1a) 공고 미설정이면 비교 기준이 없다 → 칠하지 않는다(0 을 기준으로 삼으면 전 줄이 경고가 된다).
  for (const expected of [0, null, undefined, '', -1, NaN]) {
    assert.strictEqual(resolvePriceDeviation({ submittedText: '99000', expected }), null,
      `1a: 공고 미설정(${String(expected)}) → 판정 안 함`);
  }

  // (1b) ★★ 못 읽는 제출값은 추측하지 않는다 — 느슨한 파서였다면 "9,900원 0" 이 99,000 으로
  //      이어붙어 **경고를 띄워야 할 값이 오히려 정상으로** 보인다(파서 사본 금지의 이유).
  for (const bad of ['9,900원 0', '9900.5', '1,23,456', '', '-', null]) {
    assert.strictEqual(resolvePriceDeviation({ submittedText: bad, expected: 9900 }), null,
      `1b: 판정불가 원문(${JSON.stringify(bad)}) → 칠하지 않음`);
  }

  // (1c) 임계 경계 — 정확히 10% 는 **포함**한다(">=").
  const at10 = resolvePriceDeviation({ submittedText: '11000', expected: 10000 });
  assert.ok(at10, '1c: +10% 정확히 → 칠함');
  assert.strictEqual(at10.submitted, 11000);
  assert.strictEqual(at10.expected, 10000);
  assert.ok(Math.abs(at10.pct - 0.1) < 1e-9, '1c: pct=0.1');

  // (1d) 임계 미만은 칠하지 않는다 — 근거 약한 경고가 쌓이면 진짜 사고가 같이 묻힌다.
  assert.strictEqual(resolvePriceDeviation({ submittedText: '10999', expected: 10000 }), null,
    '1d: +9.99% → 칠하지 않음');
  assert.strictEqual(resolvePriceDeviation({ submittedText: '10000', expected: 10000 }), null,
    '1d: 동일 → 칠하지 않음');

  // (1e) ★★ 나재형 케이스 — 작업보드 셀은 9,900 으로 정상이었고 **구매양식 제출값만** 99,000
  //      (0 이 하나 더 붙음). 이 판정이 잡아야 하는 바로 그 모양이다.
  const najh = resolvePriceDeviation({ submittedText: '99000', expected: 9900 });
  assert.ok(najh, '1e: 나재형 케이스(0 하나 더) → 칠함');
  assert.strictEqual(najh.submitted, 99000);
  assert.strictEqual(najh.expected, 9900);
  assert.strictEqual(najh.diff, 89100);
  assert.ok(Math.abs(najh.pct - 9) < 1e-9, '1e: +900%');

  // (1f) 양방향 — 덜 적힌 경우도 확인 대상이다(과소지급도 사고다).
  const under = resolvePriceDeviation({ submittedText: '5400', expected: 18200 });
  assert.ok(under, '1f: 과소도 칠함');
  assert.ok(under.pct < 0, '1f: pct 음수');
  assert.strictEqual(under.diff, 5400 - 18200);

  // (1g) 임계값은 주입 가능하되 기본은 10% 다(상수 사본 금지).
  assert.strictEqual(PRICE_DEV_THRESHOLD, 0.10, '1g: 기본 임계 10%');
  assert.ok(resolvePriceDeviation({ submittedText: '10500', expected: 10000, threshold: 0.05 }),
    '1g: threshold 주입 시 5% 로 판정');
  assert.strictEqual(resolvePriceDeviation({ submittedText: '10500', expected: 10000 }), null,
    '1g: 같은 값이 기본 임계에서는 미달');

  // (1h) 콤마·통화 표기가 섞인 정상 값은 읽는다(엄격 파서의 정상 경로).
  const won = resolvePriceDeviation({ submittedText: '99,000원', expected: 9900 });
  assert.ok(won && won.submitted === 99000, '1h: "99,000원" 정상 판독');

  console.log('  §1 판정(파서 단일 출처·경계·양방향) 통과');
}

// ══════════════════════════════════════════════════════════════
// §2 배선 — _attachPriceDeviation 직접 실행
// ══════════════════════════════════════════════════════════════
function section2() {
  const { _attachPriceDeviation } = require('../src/services/trackB.service');
  const row = (over) => Object.assign({
    id: 'r1', rowJson: { 번호: '1', 결제금액: '9,900', 옵션금액: '3,000' }, cellEdits: {},
    order: { price: '99000', selectedOptKey: null },
  }, over || {});

  // (2a) 기본 — 작업오더 1건당 금액 대비 편차 → 결제금액 칸에 칠한다.
  let rows = [row()];
  let n = _attachPriceDeviation(rows, { payAmount: 9900, options: [] });
  assert.strictEqual(n, 1, '2a: 1건 칠함');
  assert.strictEqual(rows[0].priceDev.col, '결제금액', '2a: ★ 옵션금액이 아니라 결제금액 칸');
  assert.strictEqual(rows[0].priceDev.submitted, 99000);
  assert.strictEqual(rows[0].priceDev.expected, 9900);

  // (2b) ★ 옵션별 결제금액이 작업오더 값을 이긴다 — 그 줄이 고른 옵션이 기준이다.
  rows = [row({ order: { price: '99000', selectedOptKey: '대용량' } })];
  n = _attachPriceDeviation(rows, { payAmount: 9900, options: [{ label: '대용량', pay: 99000 }] });
  assert.strictEqual(n, 0, '2b: 옵션 금액과 같으면 칠하지 않음(작업오더 값으로 오판정 금지)');

  // (2b2) 옵션 금액이 0(미설정)이면 작업오더 값으로 떨어진다.
  rows = [row({ order: { price: '99000', selectedOptKey: '기본' } })];
  n = _attachPriceDeviation(rows, { payAmount: 9900, options: [{ label: '기본', pay: 0 }] });
  assert.strictEqual(n, 1, '2b2: 옵션 pay=0 → 작업오더 금액 기준');

  // (2c) 주문이 없는 줄(빈 슬롯·수기 입력)은 제출값 자체가 없다 → 건드리지 않는다.
  rows = [row({ order: null })];
  assert.strictEqual(_attachPriceDeviation(rows, { payAmount: 9900, options: [] }), 0, '2c: 주문 없는 줄 제외');
  assert.ok(!('priceDev' in rows[0]), '2c: priceDev 미부착');

  // (2d) 조건 조회 실패(null)면 칠하지 않는다 — 근거 없는 경고 금지(fail-soft).
  rows = [row()];
  assert.strictEqual(_attachPriceDeviation(rows, null), 0, '2d: condition null → 0건');
  assert.ok(!('priceDev' in rows[0]), '2d: priceDev 미부착');

  // (2e) ★★ 셀 편집이 덮인 값 위에서 칸을 고른다 — 그리드가 그리는 값과 같은 기준.
  //      (편집으로 결제금액 칸을 비워도 **칸 자체**는 남으므로 칠할 자리는 찾아야 한다.)
  rows = [row({ cellEdits: { 결제금액: '' } })];
  n = _attachPriceDeviation(rows, { payAmount: 9900, options: [] });
  assert.strictEqual(n, 1, '2e: 금액 칸이 비어도 칠할 자리를 찾음');
  assert.strictEqual(rows[0].priceDev.col, '결제금액', '2e: ★ 빈 칸 폴백도 옵션금액을 고르면 안 된다');

  // (2f) 금액 칸이 아예 없는 표 → 칠할 자리가 없으니 조용히 넘어간다(엉뚱한 칸 칠하기 금지).
  rows = [row({ rowJson: { 번호: '1', 수취인: '홍길동' } })];
  assert.strictEqual(_attachPriceDeviation(rows, { payAmount: 9900, options: [] }), 0, '2f: 금액 칸 없음 → 0건');

  // (2g) 여러 줄 중 편차 있는 줄만 칠한다.
  rows = [row({ id: 'a' }), row({ id: 'b', order: { price: '9900', selectedOptKey: null } })];
  n = _attachPriceDeviation(rows, { payAmount: 9900, options: [] });
  assert.strictEqual(n, 1, '2g: 편차 있는 1줄만');
  assert.ok(rows[0].priceDev && !rows[1].priceDev, '2g: 정상 줄은 미부착');

  console.log('  §2 배선(옵션 우선·칸 선택 단일 출처·주문 없는 줄) 통과');
}

// ══════════════════════════════════════════════════════════════
// §3 무인 자동적용 하드 제외 — 입금 대상은 어떤 env 로도 새면 안 된다
// ══════════════════════════════════════════════════════════════
function section3() {
  const ledger = require('../src/services/orderLedger.service');
  const saved = process.env.REVERSE_SYNC_AUTO_FIELDS;
  try {
    // (3a) 기본값에는 돈·신원·입금대상이 애초에 없다.
    delete process.env.REVERSE_SYNC_AUTO_FIELDS;
    const def = ledger._autoSafeFields();
    assert.deepStrictEqual([...def].sort(), ['date_str', 'memo', 'orderer', 'user_id'], '3a: 기본 안전필드 4종');

    // (3b) ★★ env 로 밀어넣어도 하드 제외된다 — 이게 이 가드의 핵심이다.
    //      본섭 실측(2026-08-23): 계좌 칸에 전화번호, 예금주 칸에 은행명, 은행 칸에 주소가 들어 있었다.
    //      그 값이 무인으로 원장에 들어가면 돈이 엉뚱한 곳으로 나가고 되돌릴 수 없다.
    process.env.REVERSE_SYNC_AUTO_FIELDS =
      'orderer,user_id,memo,date_str,price,order_num,phone,recipient,address,bank,account,depositor';
    const forced = ledger._autoSafeFields();
    for (const banned of ['price', 'order_num', 'phone', 'recipient', 'address', 'bank', 'account', 'depositor']) {
      assert.ok(!forced.includes(banned), `3b: ${banned} 는 env 로도 자동적용 불가`);
    }
    assert.deepStrictEqual([...forced].sort(), ['date_str', 'memo', 'orderer', 'user_id'],
      '3b: 남는 건 소프트 필드 4종뿐');

    // (3c) 입금 대상만 넣어도 결과는 빈 배열 — "설정했으니 동작한다"는 오해가 생기지 않게.
    process.env.REVERSE_SYNC_AUTO_FIELDS = 'bank,account,depositor';
    assert.deepStrictEqual(ledger._autoSafeFields(), [], '3c: 입금 대상만 지정 → 자동적용 대상 0');
  } finally {
    if (saved === undefined) delete process.env.REVERSE_SYNC_AUTO_FIELDS;
    else process.env.REVERSE_SYNC_AUTO_FIELDS = saved;
  }

  // (3d) 소스 가드 — 하드 제외 목록이 통째로 사라지는 리팩터를 막는다.
  const src = fs.readFileSync(path.join(__dirname, '../src/services/orderLedger.service.js'), 'utf8');
  const m = src.match(/for \(const f of \[([^\]]*)\]\) set\.delete\(f\)/);
  assert.ok(m, '3d: 하드 제외 루프가 존재');
  for (const banned of ['price', 'order_num', 'phone', 'recipient', 'address', 'bank', 'account', 'depositor']) {
    assert.ok(m[1].includes(`'${banned}'`), `3d: 하드 제외 목록에 ${banned} 명시`);
  }

  console.log('  §3 하드 제외(입금 대상 bank/account/depositor 포함) 통과');
}

// ══════════════════════════════════════════════════════════════
// §4 화면 배선 — 서버가 지정한 칸만 칠한다(화면에 판정 사본 금지)
// ══════════════════════════════════════════════════════════════
function section4() {
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');

  // (4a) 연주황 배경 규칙이 존재하고, 편집 hover 규칙에 지지 않는다(더 높은 특이성).
  assert.ok(/table\.sheetgrid td\.gcell\.gpdev\{[^}]*background:rgba\(255,146,42/.test(html),
    '4a: .gpdev 연주황 배경 규칙');
  assert.ok(/table\.sheetgrid td\.gedit\.gpdev:hover\{/.test(html),
    '4a: hover 에서도 경고칠이 유지되는 규칙(gedit:hover 에 덮이지 않게)');

  // (4b) ★★ 칠할 칸은 **서버가 보낸 col** 로만 정한다 — 화면이 헤더 키워드로 다시 고르면
  //      입금관리가 금액으로 읽는 칸과 갈릴 수 있다(판정 사본 금지).
  assert.ok(/r\.priceDev&&r\.priceDev\.col===h/.test(html), '4b: 서버 지정 칸과 일치할 때만 칠함');
  assert.ok(!/priceDev[\s\S]{0,200}?(결제\s*금액|EXACT_KEYS)/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')),
    '4b: 화면에 금액 칸 판정 사본 없음(주석 제외)');

  // (4c) 툴팁이 제출값·공고값을 나란히 말한다(조용한 경고 금지).
  assert.ok(/function _pdevTip\(/.test(html), '4c: _pdevTip 정의');
  assert.ok(/구매양식 제출[\s\S]{0,80}공고 설정/.test(html), '4c: 두 값을 나란히 표기');

  // (4d) ★ 확인/승인 UI 를 만들지 않는다(사용자 확정) — 경고칠에 확인 버튼·팝업이 붙으면 안 된다.
  assert.ok(!/gpdev[\s\S]{0,400}?(confirm\(|승인|확인했|checked)/.test(html),
    '4d: 경고칠에 승인/확인 절차 없음');

  // (4e) eCell 이 tip 인자를 받아 title 에 싣는다(경고 사유가 셀에서 바로 읽혀야 한다).
  assert.ok(/const eCell=\(field, disp, edited, extraCls, styleI, editv, tip\)=>/.test(html),
    '4e: eCell 이 tip 인자를 받음');
  assert.ok(/const ttl = tip \?/.test(html), '4e: tip 이 title 로 합성됨');

  console.log('  §4 화면 배선(서버 지정 칸·툴팁·승인 UI 없음) 통과');
}

function run() {
  section1();
  section2();
  section3();
  section4();
}

run();
console.log('workdeskPriceDeviation tests passed');
