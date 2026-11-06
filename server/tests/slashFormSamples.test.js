/**
 * slashFormSamples.test.js — 외부모집 수동제출 슬래시양식 파서 표본 50개 회귀가드
 * 실행: node --test tests/slashFormSamples.test.js   (DB·네트워크·AI 불필요 — 순수함수)
 *
 * 무엇을 고정하는가 (결정 143 「보강(2026-11-06)」)
 *  ① 조용히 틀림 0 — 값이 엉뚱한 칸에 들어간 채 ok:true 가 되는 줄이 하나도 없어야 한다.
 *     (두 사람이 한 줄에 붙음 · 끝에 주문번호 · 은행↔계좌 뒤바뀜 · 금액 오독 · 아이디 잘림 · 이름 머리표)
 *  ② 지금 정상이던 17개는 **필드·경고까지 그대로**(결과 불변).
 *  ③ 새로 읽게 된 변형(전각 ／·탭·+82·은행 별칭·한글 금액 등)은 반드시 경고(repairs)로 드러난다.
 */
const test = require('node:test');
const assert = require('node:assert');
const SF = require('../src/utils/slashForm');
const { parseSlashForm, parseSlashLine } = SF;

const B = '이시현/이시현/kirei223/010-7701-1701/부산시 수영구 광안동 119-3번지, 109호/신한은행/496-04-007701/이시현/15800';
const EXP = {
  reviewerName: '이시현', recipient: '이시현', userId: 'kirei223', phone: '010-7701-1701',
  address: '부산시 수영구 광안동 119-3번지, 109호', bank: '신한은행', account: '496-04-007701', depositor: '이시현', price: 15800,
};
const W_ADDR = '주소에 슬래시(/)가 있어 주소로 합쳤습니다 — 값을 확인하세요';
const W_DP = '예금주와 결제금액 사이 슬래시(/) 누락을 보정했습니다 — 값이 맞는지 확인하세요';
const W_BA = '은행과 계좌번호 사이 슬래시(/) 누락을 보정했습니다 — 값이 맞는지 확인하세요';
const W_10 = '전화번호가 10자리라 리뷰어 자동등록은 생략됩니다 (제출은 진행)';
const ADDR2 = '부산시 수영구 광안동 월드컵로 12/3, 302호';
const P2 = B.replace(/이시현/g, '박민지').replace('010-7701-1701', '010-2222-3333');

/*
 * 기대값 형식
 *   { ok: { 필드 덮어쓰기 }, warnings: [...정확히] }   — 수정 전부터 정상 → 경고까지 불변
 *   { ok: { 필드 덮어쓰기 }, warn: /정규식/ }          — 새로 읽게 됨 → 반드시 드러낸다(repairs ≥ 1)
 *   { err: /정규식/ }                                   — 오류가 맞다(첫 줄의 errors 중 하나가 일치)
 *   n: 사람 수(기본 1)
 */
const S = [
  ['S01', '기본형', B, { ok: {}, warnings: [] }],
  ['S02', '금액 15,800원', B.replace('15800', '15,800원'), { ok: {}, warnings: [] }],
  ['S03', '계좌 하이픈 없음', B.replace('496-04-007701', '49604007701'), { ok: { account: '49604007701' }, warnings: [] }],
  ['S04', '주소에 슬래시', B.replace('119-3번지, 109호', '월드컵로 12/3, 302호'), { ok: { address: ADDR2 }, warnings: [W_ADDR] }],
  ['S05', '구분자 주위 공백', B.split('/').join(' / '), { ok: {}, warnings: [] }],
  ['S06', '번호 머리표 "1. "', '1. ' + B, { ok: {}, warn: /머리/ }],
  ['S07', '이모지 머리표 "✅"', '✅' + B, { ok: {}, warn: /머리/ }],
  ['S08', '카톡PC 복사 머리말', '[이시현] [오후 3:12] ' + B, { ok: {}, warn: /머리/ }],
  ['S09', '라벨 붙은 한 줄 "이름:"', '리뷰어:이시현/수취인:이시현/아이디:kirei223/전화:010-7701-1701/주소:부산시 수영구 광안동 119-3번지, 109호/은행:신한은행/계좌:496-04-007701/예금주:이시현/금액:15800', { ok: {}, warn: /라벨/ }],
  ['S10', '라벨 여러 줄(한 사람)', '리뷰어: 이시현\n수취인: 이시현\n아이디: kirei223\n전화번호: 010-7701-1701\n주소: 부산시 수영구 광안동 119-3번지, 109호\n은행: 신한은행\n계좌번호: 496-04-007701\n예금주: 이시현\n결제금액: 15800', { err: /한 사람은 한 줄로/ }],
  ['S11', '줄바꿈 섞인 한 사람(주소 뒤 개행)', '이시현/이시현/kirei223/010-7701-1701/부산시 수영구 광안동 119-3번지, 109호/\n신한은행/496-04-007701/이시현/15800', { err: /한 사람은 한 줄로/ }],
  ['S12', '콤마 구분', B.split('/').join(','), { err: /칸이 1개뿐/ }],
  ['S13', '전각 슬래시 ／', B.split('/').join('／'), { ok: {}, warn: /전각/ }],
  ['S14', '공백만 구분', B.replace('부산시 수영구 광안동 119-3번지, 109호', '부산시수영구광안동119-3번지').split('/').join(' '), { err: /칸이 1개뿐/ }],
  ['S15', '역슬래시', B.split('/').join('\\'), { err: /칸이 1개뿐/ }],
  ['S16', '전화 +82', B.replace('010-7701-1701', '+82 10-7701-1701'), { ok: {}, warn: /\+82/ }],
  ['S17', '전화 +82 010', B.replace('010-7701-1701', '+82-010-7701-1701'), { ok: {}, warn: /\+82/ }],
  ['S18', '전화 점 구분', B.replace('010-7701-1701', '010.7701.1701'), { ok: {}, warnings: [] }],
  ['S19', '은행 별칭 카뱅', B.replace('신한은행', '카뱅'), { ok: { bank: '카뱅' }, warnings: [] }],
  ['S20', '은행 별칭+슬래시 누락 토스', B.replace('신한은행/496-04-007701', '토스496-04-007701'), { ok: { bank: '토스' }, warn: /은행과 계좌번호/ }],
  ['S21', '은행·계좌 순서 바뀜', B.replace('신한은행/496-04-007701', '496-04-007701/신한은행'), { err: /은행과 계좌번호 자리가 바뀐/ }],
  ['S22', '계좌·예금주 순서 바뀜', B.replace('496-04-007701/이시현/15800', '이시현/496-04-007701/15800'), { err: /계좌번호와 예금주 자리가 바뀐/ }],
  ['S23', '아이디·전화 순서 바뀜', B.replace('kirei223/010-7701-1701', '010-7701-1701/kirei223'), { err: /아이디와 전화번호 자리가 바뀐/ }],
  ['S24', '금액이 맨 앞(순서 다름)', '15800/' + B.replace('/15800', ''), { err: /전화번호|결제금액/ }],
  ['S25', '아이디 칸 빠짐(8칸)', B.replace('kirei223/', ''), { err: /아이디 칸이 빠진/ }],
  ['S26', '아이디 빈칸(//)', B.replace('kirei223', ''), { ok: { userId: '' }, warnings: [] }],
  ['S27', '수취인 칸 빠짐(8칸, 본인)', B.replace('이시현/이시현/', '이시현/'), { err: /칸이 8개뿐/ }],
  ['S28', '끝에 주문번호 한 칸 더(10칸)', B + '/20261106123456', { err: /끝에 칸이 더/ }],
  ['S29', '끝에 옵션 한 칸 더', B + '/블랙 L', { err: /끝에 칸이 더/ }],
  ['S30', '끝 슬래시', B + '/', { ok: {}, warn: /끝의 빈 칸/ }],
  ['S31', '주소 슬래시 + 예금주·금액 붙음', B.replace('119-3번지, 109호', '월드컵로 12/3, 302호').replace('이시현/15800', '이시현15800'), { ok: { address: ADDR2 }, warn: /예금주와 결제금액/ }],
  ['S32', '주소 슬래시 + 끝에 주문번호', B.replace('119-3번지, 109호', '월드컵로 12/3, 302호') + '/20261106123456', { err: /끝에 칸이 더/ }],
  ['S33', '두 사람이 한 줄로 붙음(공백)', B + ' ' + B.replace(/이시현/g, '박민지').replace('010-7701-1701', '010-2222-3333').replace('496-04-007701', '110-222-333444').replace('15800', '21000'), { err: /두 사람/ }],
  ['S34', '금액 "1만5천8백원"', B.replace('15800', '1만5천8백원'), { ok: {}, warn: /한글 단위/ }],
  ['S35', '금액 소수점 15,800.00', B.replace('15800', '15,800.00'), { ok: {}, warn: /소수점/ }],
  ['S36', '금액 메모 섞임', B.replace('15800', '15800(배송비 3000 포함)'), { ok: {}, warn: /괄호/ }],
  ['S37', '금액 "₩15,800"', B.replace('15800', '₩15,800'), { ok: {}, warnings: [] }],
  ['S38', '예금주+금액 붙음(규칙 보정)', B.replace('이시현/15800', '이시현15800'), { ok: {}, warnings: [W_DP] }],
  ['S39', '은행+계좌 붙음', B.replace('신한은행/496', '신한은행496'), { ok: {}, warnings: [W_BA] }],
  ['S40', '슬래시 2개 누락', B.replace('신한은행/496', '신한은행496').replace('이시현/15800', '이시현15800'), { ok: {}, warnings: [W_BA, W_DP] }],
  ['S41', '여러 사람 빈 줄 구분', B + '\n\n' + P2, { ok: {}, warnings: [], n: 2 }],
  ['S42', '타계정(리뷰어≠수취인)', B.replace('이시현/이시현', '이시현/김하나').replace('/이시현/15800', '/김하나/15800'), { ok: { recipient: '김하나', depositor: '김하나' }, warnings: [] }],
  ['S43', '리뷰어·수취인 붙음', B.replace('이시현/이시현', '이시현이시현'), { err: /칸이 8개뿐/ }],
  ['S44', '계좌에 공백', B.replace('496-04-007701', '496 04 007701'), { ok: { account: '496 04 007701' }, warnings: [] }],
  ['S45', '은행 "KB국민"+계좌 붙음', B.replace('신한은행/496', 'KB국민496'), { ok: { bank: 'KB국민' }, warn: /은행과 계좌번호/ }],
  ['S46', '맨 앞 "-" 머리표', '- ' + B, { ok: {}, warn: /머리/ }],
  ['S47', '탭 구분(엑셀 복사)', B.split('/').join('\t'), { ok: {}, warn: /탭/ }],
  ['S48', '전화 10자리 지역번호', B.replace('010-7701-1701', '051-770-1701'), { ok: { phone: '051-770-1701' }, warnings: [W_10] }],
  ['S49', '"원" 띄어쓰기 "15,800 원"', B.replace('15800', '15,800 원'), { ok: {}, warnings: [] }],
  ['S50', '괄호 라벨 "(리뷰어)"', B.replace('이시현/이시현', '이시현(리뷰어)/이시현(수취인)'), { ok: {}, warn: /괄호/ }],
];

function checkSample([id, desc, input, exp]) {
  const out = parseSlashForm(input);
  const n = exp.n || 1;
  if (exp.err) {
    assert.ok(out.length >= 1, `${id} 결과 없음`);
    // ★ 조용히 틀림 금지: 오류가 기대되는 표본은 어느 줄도 ok 로 통과하면 안 된다
    assert.strictEqual(out.filter(o => o.ok).length, 0, `${id} ${desc}: 오류여야 하는데 ok 줄이 있다 → ${JSON.stringify(out.map(o => o.fields))}`);
    const all = out.flatMap(o => o.errors);
    assert.ok(all.some(e => exp.err.test(e)), `${id} ${desc}: 오류 문구 ${exp.err} 불일치 → ${JSON.stringify(all)}`);
    return;
  }
  assert.strictEqual(out.length, n, `${id} 줄 수`);
  for (const o of out) assert.ok(o.ok, `${id} ${desc}: ok 여야 함 → ${JSON.stringify(o.errors)}`);
  const want = Object.assign({}, EXP, exp.ok);
  const f = out[0].fields;
  for (const k of Object.keys(want)) {
    assert.strictEqual(String(f[k] ?? ''), String(want[k] ?? ''), `${id} ${desc}: ${k}=「${f[k]}」 기대 「${want[k]}」`);
  }
  if (exp.warnings) {
    assert.deepStrictEqual(out[0].warnings, exp.warnings, `${id} ${desc}: 경고 불변`);
    if (!exp.warnings.length) assert.deepStrictEqual(out[0].repairs, [], `${id} 보정 없음`);
  }
  if (exp.warn) {
    // ★ 보정은 반드시 드러낸다 — 경고 + repairs(🔧 자동보정 배지·요약 카운트의 재료)
    assert.ok(out[0].warnings.some(w => exp.warn.test(w)), `${id} ${desc}: 경고 ${exp.warn} 없음 → ${JSON.stringify(out[0].warnings)}`);
    assert.ok((out[0].repairs || []).length >= 1, `${id} ${desc}: repairs 비어 있음(조용한 보정)`);
  }
}

test('표본 50개 — 기대 판정과 일치', () => {
  assert.strictEqual(S.length, 50);
  const fails = [];
  for (const s of S) {
    try { checkSample(s); } catch (e) { fails.push(e.message); }
  }
  assert.deepStrictEqual(fails, [], `실패 ${fails.length}건:\n` + fails.join('\n'));
});

for (const s of S) test(`${s[0]} ${s[1]}`, () => checkSample(s));

/* ── 표본 밖 경계 ─────────────────────────────────────────── */
test('금액 — 상한 경고·과대값 오류·애매한 소수점 오류·한글 단위', () => {
  const r1 = parseSlashLine(B.replace('15800', '1,500,000'));
  assert.ok(r1.ok && r1.fields.price === 1500000 && r1.warnings.some(w => /100만원/.test(w)), '100만원 초과는 경고');
  const r2 = parseSlashLine(B.replace('15800', '20261106123456'));
  assert.ok(!r2.ok && r2.errors.some(e => /너무 큽니다/.test(e)), '주문번호 같은 과대값은 오류');
  const r3 = parseSlashLine(B.replace('15800', '15800.5'));
  assert.ok(!r3.ok && r3.errors.some(e => /결제금액/.test(e)), '.00 아닌 소수점은 오류');
  const r4 = parseSlashLine(B.replace('15800', '2만원'));
  assert.ok(r4.ok && r4.fields.price === 20000 && r4.repairs.length, '2만원 → 20000 + 경고');
  const r5 = parseSlashLine(B.replace('15800', '1만 5800원'));
  assert.ok(r5.ok && r5.fields.price === 15800, '1만 5800원');
  const r6 = parseSlashLine(B.replace('15800', '만오천원'));
  assert.ok(!r6.ok, '한글 숫자는 읽지 않는다(오류)');
  assert.strictEqual(SF.parsePrice('15,800원'), 15800);
  assert.strictEqual(SF.parsePrice('무료'), null);
});

test('아이디 안의 숫자를 자르는 보정 금지(kirei223 류)', () => {
  // 수취인 칸이 빠진 8칸 — 예전엔 kirei/223 으로 잘라 수취인=kirei 로 ok 였다
  const r = parseSlashLine('이시현/abc1234/010-7701-1701/부산시 수영구 광안동 119-3번지/신한은행/496-04-007701/이시현/15800');
  assert.strictEqual(r.ok, false);
  // 정상 위치(예금주+금액)의 보정은 그대로
  const r2 = parseSlashLine('이시현/이시현/abc1234/010-7701-1701/부산시 수영구 광안동 119-3번지/신한은행/496-04-007701/이시현15800');
  assert.ok(r2.ok && r2.fields.userId === 'abc1234' && r2.fields.price === 15800);
});

test('라벨이 다른 칸 자리에 있으면 오류(순서 뒤섞임을 조용히 받지 않는다)', () => {
  const r = parseSlashLine('리뷰어:이시현/수취인:이시현/아이디:kirei223/전화:010-7701-1701/주소:부산시 수영구 광안동 119-3번지/계좌:496-04-007701/은행:신한은행/예금주:이시현/금액:15800');
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /라벨/.test(e)), JSON.stringify(r.errors));
});

test('두 사람 붙음 — 가운데(주소 자리)에 전화번호가 또 있으면 오류', () => {
  const r = parseSlashLine(B + '/' + P2);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /두 사람/.test(e)));
});

test('탭이 칸 구분이 아니면(9칸 미만) 공백으로만 본다', () => {
  const r = parseSlashLine(B.replace('/부산시', '/\t부산시'));
  assert.ok(r.ok && r.fields.address === EXP.address, JSON.stringify(r.errors));
});

test('AI 폴백 재조립 경로 — 9칸 재조립 문자열이 같은 parseSlashLine 으로 통과', () => {
  const f = { ...EXP, bank: '카카오뱅크', account: '3333-01-1234567', price: 15800 };
  const rebuilt = [f.reviewerName, f.recipient, f.userId, f.phone, f.address, f.bank, f.account, f.depositor, f.price]
    .map(v => String(v || '').replace(/\//g, ' ')).join('/');
  const r = parseSlashLine(rebuilt);
  assert.ok(r.ok && r.fields.bank === '카카오뱅크' && r.fields.price === 15800 && r.repairs.length === 0);
  // AI 가 은행·계좌를 뒤바꿔 돌려줘도 같은 파서가 막는다
  const bad = [f.reviewerName, f.recipient, f.userId, f.phone, f.address, f.account, f.bank, f.depositor, f.price].join('/');
  assert.strictEqual(parseSlashLine(bad).ok, false);
});
