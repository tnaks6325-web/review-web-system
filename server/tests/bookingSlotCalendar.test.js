/**
 * bookingSlotCalendar.test.js — 네이버예약리뷰 2단계 회귀가드: 오더 입력 계약 · 날짜별 자리표 · 작업표 칸(결정 407)
 * 실행: node tests/bookingSlotCalendar.test.js
 *
 * 위험:
 *  ① 업체가 정한 날짜·날짜별 인원과 다른 자리가 깔린다(날짜를 옮기거나 · 주말을 건너뛰거나 · 인원이 어긋남).
 *  ② 잘못된 오더(날짜 중복·순서·0명·총원 불일치·환급형인데 결제금액 없음·무료체험형인데 결제금액 있음)를 받아 깐다.
 *  ③ 예약리뷰 작업표에 구매·배송 칸(주문번호·아이디·연락처·주소·리뷰옵션·상품옵션·택배)이 남거나,
 *     무료체험형에 결제금액 칸이 남는다.
 *  ④ 이 변경으로 **리뷰·블로그·Q&A 작업표 계획이 한 글자라도 바뀐다**(운영 작업 전부) — 결정 407 이전 지문과 대조.
 * ★ 순수 함수는 실제로 실행해 본다.
 */
const assert = require('assert');
const crypto = require('crypto');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

const B = require('../src/utils/bookingCalendar');
const W = require('../src/utils/worktablePlan');
const { planToSheetValues } = require('../src/services/worktableCreate.service');

console.log('\n▶ 네이버예약리뷰 2단계 — 오더 계약 · 날짜별 자리표 · 작업표 칸\n');

const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'], channels: {}, workTypes: [] };
const DATES = [{ date: '2026-12-04', count: 2 }, { date: '2026-12-05', count: 1 }, { date: '2026-12-07', count: 3 }];   // 금·토·월 — 주말도 업체가 정하면 깐다
const place = (booking, extra = {}) => ({ name: '가짜식당 강남점', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
  base: { pay: booking && booking.pay_mode === 'free' ? 0 : 25000, count: 6, daily: 0, review_type_mix: [] }, options: [], booking, ...extra });
const SPEC = (o = {}) => ({ pay_mode: 'refund', dates: DATES, review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1', ...o });
const woOf = (products, extra = {}) => ({ id: 'wo_bk', work_kind: 'booking', workboard_schema_version: 2, recruit_count: 6, review_fee: 5000,
  pay_amount: 0, skip_weekends: true, start_date: '', product_options_json: JSON.stringify(products), ...extra });
const codes = r => (r.blockers || []).map(b => b.code);

/* ── 1) 오더 입력 계약 ───────────────────────────────────────────── */
console.log('1) 오더 입력 계약(정규화 · 잠금)');
const ok = B.bookingSpecFromWorkOrder(woOf([place(SPEC())]));
t('정상 오더는 잠금 없음', ok.blockers.length === 0);
t('★ 매장 = 상품 하나(이름·예약 주소) · 주소는 booking.place_address', ok.spec.placeName === '가짜식당 강남점'
  && ok.spec.bookingUrl === 'https://booking.naver.com/booking/6/bizes/000000' && ok.spec.placeAddress === '서울 가짜구 가짜로 1');
t('환급형 = 1건 결제금액(base.pay) 그대로', ok.spec.payMode === 'refund' && ok.spec.pay === 25000);
t('날짜·인원은 받은 그대로 · 총원 = 합', JSON.stringify(ok.spec.dates) === JSON.stringify(DATES) && ok.spec.total === 6);
t('리뷰 기한 = 오더 값', ok.spec.reviewDeadlineDays === 3);
t('리뷰 기한을 안 보내면 기본 3일', B.bookingSpecFromWorkOrder(woOf([place(SPEC({ review_deadline_days: undefined }))])).spec.reviewDeadlineDays === 3
  && B.DEFAULT_REVIEW_DEADLINE_DAYS === 3);
t('숫자 글자도 받는다(인원·기한)', B.bookingSpecFromWorkOrder(woOf([place(SPEC({ review_deadline_days: '5', dates: DATES.map(d => ({ ...d, count: String(d.count) })) }))])).blockers.length === 0);
const free = B.bookingSpecFromWorkOrder(woOf([place(SPEC({ pay_mode: 'free' }))]));
t('무료체험형 = 결제금액 0', free.blockers.length === 0 && free.spec.payMode === 'free' && free.spec.pay === 0);

const bad = (o, products) => codes(B.bookingSpecFromWorkOrder(woOf(products || [place(SPEC())], o)));
const badSpec = (s, extra) => codes(B.bookingSpecFromWorkOrder(woOf([place(SPEC(s), extra)])));
t('★ 옛 형식(v1) 잠금', bad({ workboard_schema_version: 1 }).includes('booking_requires_v2'));
t('★ 매장이 둘이면 잠금(오더 하나 = 매장 하나)', bad({}, [place(SPEC()), { ...place(SPEC()), name: '가짜식당 역삼점' }]).includes('booking_one_place'));
t('★ 옵션 있는 상품은 잠금(상품 옵션 없음)', codes(B.bookingSpecFromWorkOrder(woOf([{ ...place(SPEC()), product_mode: 'opt',
  options: [{ option_1: { name: '코스', value: 'A' }, label: 'A' }] }]))).includes('booking_one_place'));
t('매장 이름이 비면 잠금', codes(B.bookingSpecFromWorkOrder(woOf([{ ...place(SPEC()), name: ' ' }]))).includes('booking_place_name'));
t('상품 목록을 못 읽으면 잠금', codes(B.bookingSpecFromWorkOrder(woOf([], { product_options_json: '{' }))).includes('booking_one_place'));
t('★ 예약 설정(booking)이 없으면 잠금', codes(B.bookingSpecFromWorkOrder(woOf([place(undefined)]))).includes('booking_no_spec'));
t('★ 돈 방식은 환급형·무료체험형 둘뿐', badSpec({ pay_mode: 'half' }).includes('booking_pay_mode') && badSpec({ pay_mode: '' }).includes('booking_pay_mode'));
t('★ 날짜가 없으면 잠금', badSpec({ dates: [] }).includes('booking_no_dates') && badSpec({ dates: undefined }).includes('booking_no_dates'));
t('★ 없는 날짜·형식 틀린 날짜 잠금', badSpec({ dates: [{ date: '2026-02-30', count: 1 }] }).includes('booking_date_invalid')
  && badSpec({ dates: [{ date: '2026-12-4', count: 1 }] }).includes('booking_date_invalid')
  && badSpec({ dates: [{ date: '12/04', count: 1 }] }).includes('booking_date_invalid'));
t('★ 같은 날짜 두 번 잠금', badSpec({ dates: [{ date: '2026-12-04', count: 1 }, { date: '2026-12-04', count: 2 }] }).includes('booking_date_duplicate'));
t('★ 날짜 순서가 뒤섞이면 잠금(받은 순서 = 자리 순서)', badSpec({ dates: [{ date: '2026-12-05', count: 1 }, { date: '2026-12-04', count: 2 }] }).includes('booking_dates_unsorted'));
t('★ 날짜별 인원 0·음수·소수·빈 값 잠금', ['0', -1, 1.5, '', null, 'x'].every(c => badSpec({ dates: [{ date: '2026-12-04', count: c }] }).includes('booking_date_count')));
t('★ 총모집 ≠ 날짜별 인원 합 잠금', bad({ recruit_count: 7 }).includes('booking_total_mismatch'));
t('★ 상품 인원(base.count) ≠ 날짜별 인원 합 잠금', codes(B.bookingSpecFromWorkOrder(woOf([{ ...place(SPEC()), base: { pay: 25000, count: 5, daily: 0 } }]))).includes('booking_total_mismatch'));
t('★ 자리 합계가 상한을 넘으면 펼치기 전에 잠금(booking_too_many)', (() => {
  const big = [{ date: '2026-12-04', count: 100000 }];
  const r = B.bookingSpecFromWorkOrder(woOf([{ ...place(SPEC({ dates: big })), base: { pay: 25000, count: 100000, daily: 0 } }], { recruit_count: 100000 }));
  return codes(r).includes('booking_too_many');
})());
t('날짜 수 상한', badSpec({ dates: Array.from({ length: B.MAX_BOOKING_DATES + 1 }, (_, i) => ({ date: W.businessDays({ count: i + 1, startDate: '2026-01-01', skipWeekends: false })[i].date, count: 1 })) }).includes('booking_too_many_dates'));
t('★ 환급형인데 결제금액 없음 잠금', codes(B.bookingSpecFromWorkOrder(woOf([{ ...place(SPEC()), base: { pay: 0, count: 6, daily: 0 } }]))).includes('booking_refund_no_pay'));
t('★ 무료체험형인데 결제금액 있음 잠금(1건 금액)', codes(B.bookingSpecFromWorkOrder(woOf([{ ...place(SPEC({ pay_mode: 'free' })), base: { pay: 1000, count: 6, daily: 0 } }]))).includes('booking_free_has_pay'));
t('★ 무료체험형인데 결제합계(pay_amount) 있음 잠금', bad({ pay_amount: 30000 }, [place(SPEC({ pay_mode: 'free' }))]).includes('booking_free_has_pay'));
t('리뷰 기한 0·31·소수 잠금', [0, 31, 2.5, 'x'].every(d => badSpec({ review_deadline_days: d }).includes('booking_deadline_days')));
t('구매수량 단계는 받지 않는다', badSpec({}, { qty_tiers: { mode: 'qty', rows: [{ qty: 2, people: 1 }] } }).includes('booking_no_qty_tiers'));

/* ── 2) 자리표 생성 ──────────────────────────────────────────────── */
console.log('\n2) 자리표 생성(순수 함수)');
const cal = B.buildBookingCalendar(ok.spec);
t('잠금 없음 · 6자리', cal.blockers.length === 0 && cal.total === 6 && cal.slots.length === 6);
t('★★ 줄 = 날짜 순 · 그날 인원만큼(주말인 토요일도 업체가 정했으면 깐다)',
  JSON.stringify(cal.slots.map(s => s.date)) === JSON.stringify(['2026-12-04', '2026-12-04', '2026-12-05', '2026-12-07', '2026-12-07', '2026-12-07']));
t('그날 안 순번 1..n', JSON.stringify(cal.slots.map(s => s.dateSeq)) === JSON.stringify([1, 2, 1, 1, 2, 3]));
t('seq 1..6', cal.slots.every((s, i) => s.seq === i + 1));
t('★ 이용일자 표기 = 작업표 날짜 칸 표기(구매일자와 같은 형식)', cal.slots[0].dateLabel === '12 / 4 (금)' && cal.slots[2].dateLabel === '12 / 5 (토)');
t('★★ 리뷰마감일 = 이용일 + N일(달력 날 · 주말 포함)', cal.slots[0].reviewDeadline === '2026-12-07' && cal.slots[2].reviewDeadline === '2026-12-08'
  && cal.slots[3].reviewDeadline === '2026-12-10' && cal.slots[0].reviewDeadlineLabel === '12 / 7 (월)');
t('리뷰마감일 계산은 연·월을 넘는다', B.reviewDeadlineOf('2026-12-30', 3).date === '2027-01-02');
t('날짜 요약 = 날짜별 인원', JSON.stringify(cal.days.map(d => [d.date, d.count])) === JSON.stringify([['2026-12-04', 2], ['2026-12-05', 1], ['2026-12-07', 3]]));
t('자리의 선택 키 = 작업표 v2 선택 키(매장 = 상품 하나)', cal.slots.every(s => s.unitKey === '가짜식당 강남점'));
t('★ 같은 입력이면 같은 자리표(재접수·복구가 같은 표)', JSON.stringify(B.buildBookingCalendar(ok.spec).slots) === JSON.stringify(cal.slots));
t('startSeq 를 따른다', B.buildBookingCalendar(ok.spec, { startSeq: 5 }).slots[0].seq === 5);
t('잠긴 계약으로는 자리를 만들지 않는다', B.buildBookingCalendar(null).slots.length === 0 && B.buildBookingCalendar(null).blockers.length > 0);

/* ── 3) 작업표 계획 · 칸 ─────────────────────────────────────────── */
console.log('\n3) 작업표 계획 · 칸');
const plan = W.buildWorktablePlan({ workOrder: woOf([place(SPEC())]), template: TEMPLATE });
const names = plan.columns.map(c => c.name);
t('만들 수 있다', plan.canCreate === true && plan.blockers.length === 0);
t('★ 줄 수 = 자리 수 · 줄 날짜 = 자리 날짜', plan.rows.length === 6 && plan.rows.map(r => r.date).join() === cal.slots.map(s => s.date).join());
t('계획에 자리표를 싣는다(접수 저장용)', plan.bookingCalendar && plan.bookingCalendar.slots.length === 6);
t('★ 「구매일자」 자리가 「이용일자」(같은 날짜 역할)', names.includes('이용일자') && !names.includes('구매일자')
  && plan.columns.find(c => c.name === '이용일자').role === 'dateStr' && W.BOOKING_DATE_HEADER === '이용일자');
t('★ 예약번호·리뷰마감일 칸 추가(역할 없음 — 리뷰어 구매양식 매퍼가 덮지 않는다)',
  ['예약번호', '리뷰마감일'].every(h => names.includes(h) && plan.columns.find(c => c.name === h).role == null));
t('★★ 구매·배송 칸 없음(주문번호·아이디·연락처·주소·리뷰옵션)', !['주문번호', 'id', '연락처', '주소', '리뷰옵션'].some(h => names.includes(h))
  && !plan.columns.some(c => ['orderNum', 'userId', 'phone', 'address', 'option', 'option_1', 'option_2', 'tracking_number', 'review_option_instruction'].includes(c.role)));
t('★ 이름·입금 계좌·리뷰·입금일 칸은 둔다', ['수취인', '은행', '계좌번호', '예금주', '리뷰', '입금일'].every(h => names.includes(h)));
t('★ 환급형은 결제금액 칸을 둔다', names.includes('결제금액'));
const freePlan = W.buildWorktablePlan({ workOrder: woOf([place(SPEC({ pay_mode: 'free' }))]), template: TEMPLATE });
t('★★ 무료체험형은 결제금액 칸이 없다', freePlan.canCreate && !freePlan.columns.some(c => c.role === 'price'));
t('★ 택배발송대행이 켜진 오더라도 송장 칸을 붙이지 않는다', !W.buildWorktablePlan({ workOrder: woOf([place(SPEC())], { courier_proxy: true }), template: TEMPLATE })
  .columns.some(c => c.role === 'tracking_number'));
t('★ 리뷰타입을 행마다 정하지 않는다(리뷰타입 없음 — 잠그지 않음)', plan.rows.every(r => !r.reviewOptionLabel && !r.reviewOption));
t('★ 미리보기 날짜·건수 조정을 받지 않는다(자리표 = 오더 값만)', (() => {
  const p = W.buildWorktablePlan({ workOrder: woOf([place(SPEC())]), template: TEMPLATE, options: { total: 2, startDate: '2026-12-20', daily: 1, skipWeekends: false } });
  return p.rows.length === 6 && p.rows[0].date === '2026-12-04';
})());
t('★ 계약 잠금은 계획 잠금으로 올라온다', codes(W.buildWorktablePlan({ workOrder: woOf([place(SPEC())], { recruit_count: 9 }), template: TEMPLATE })).includes('booking_total_mismatch'));
t('예약리뷰 안내 경고(리뷰 날짜 경고 대신)', plan.warnings.some(w => w.code === 'booking_calendar') && !plan.warnings.some(w => ['no_start_date', 'no_daily', 'date_short'].includes(w.code)));

const sheet = planToSheetValues(plan);
const col = h => sheet.header.indexOf(h);
t('★ 이용일자 칸 = 자리 날짜 표기', sheet.body.map(r => r[col('이용일자')]).join('|') === cal.slots.map(s => s.dateLabel).join('|'));
t('★ 리뷰마감일 칸 = 이용일 + N일 표기', sheet.body[0][col('리뷰마감일')] === '12 / 7 (월)' && sheet.body[5][col('리뷰마감일')] === '12 / 10 (목)');
t('예약번호 칸은 비워 둔다(리뷰어가 예약 뒤 낸다 — 3단계)', sheet.body.every(r => r[col('예약번호')] === ''));
t('상품 칸 = 매장 이름(선택 키)', sheet.body.every(r => r[col('상품')] === '가짜식당 강남점'));
t('★ 리뷰마감일은 보충 줄이 잇는 계획 칸에 들어가지 않는다(리뷰 탭의 같은 이름 칸 동작 불변 — 예약 탭은 줄 삭제가 따로 잇는다)',
  !W.planCellHeaders(['번호', '리뷰마감일', '예약번호']).includes('리뷰마감일'));

/* ── 4) 리뷰·블로그·Q&A 계획 불변(결정 407 이전 지문) ─────────────── */
console.log('\n4) 리뷰·블로그·Q&A 계획 불변');
const TEMPLATES = [
  TEMPLATE,
  { core: ['번호', '구매일자', '수취인', '연락처', '주소', '결제금액', '리뷰마감일', '예약번호', '리뷰', '입금일'], channels: { naver: ['네이버아이디'] }, workTypes: [] },
];
const P = (name, count, daily, extra = {}) => ({ name, url: 'https://smartstore.naver.com/x/products/1', option_schema_version: 2, product_mode: 'none',
  base: { pay: 12000, count, daily, review_type_mix: [] }, options: [], ...extra });
const OPT = { name: '양말', url: 'https://smartstore.naver.com/x/products/2', option_schema_version: 2, product_mode: 'opt', base: { pay: 9000, count: 0, daily: 0 },
  options: [{ option_1: { name: '색상', value: '검정' }, label: '검정', count: 3, daily: 1, pay: 9000 }, { option_1: { name: '색상', value: '흰색' }, label: '흰색', count: 2, daily: 1, pay: 9000 }] };
const orders = [];
for (const start of ['2026-12-01', '2026-12-24', '']) for (const skip of [true, false]) {
  orders.push({ id: 'wo_a', work_kind: '', workboard_schema_version: 2, recruit_count: 5, daily_count: 2, start_date: start, skip_weekends: skip, review_type: '포토', product_options_json: JSON.stringify([P('가짜상품', 5, 2)]) });
  orders.push({ id: 'wo_b', work_kind: 'review', workboard_schema_version: 2, recruit_count: 5, daily_count: 1, start_date: start, skip_weekends: skip, review_type: '텍스트', product_options_json: JSON.stringify([OPT]) });
  orders.push({ id: 'wo_c', work_kind: 'blog', workboard_schema_version: 2, recruit_count: 4, daily_count: 0, start_date: start, skip_weekends: skip, product_options_json: JSON.stringify([P('블로그상품', 4, 0)]) });
  orders.push({ id: 'wo_d', work_kind: 'qna', workboard_schema_version: 2, recruit_count: 7, daily_count: 2, start_date: start, skip_weekends: skip,
    product_options_json: JSON.stringify([P('Q1', 4, 2, { base: { pay: 0, count: 4, daily: 2, qna: { public_count: 1, public_texts: ['재고 있나요?'], public_gap_days: 2 } } }), P('Q2', 3, 1)]) });
  orders.push({ id: 'wo_e', work_kind: '', recruit_count: 6, daily_count: 2, start_date: start, skip_weekends: skip, review_type: '포토', product_options_json: '', product_option: '빨강, 파랑' });
  orders.push({ id: 'wo_f', work_kind: '사전예약 리뷰체험단', workboard_schema_version: 2, recruit_count: 3, daily_count: 1, start_date: start, skip_weekends: skip, review_type: '포토', product_options_json: JSON.stringify([P('사전예약상품', 3, 1)]) });
}
const prints = [];
for (const tpl of TEMPLATES) for (const wo of orders) {
  const p = W.buildWorktablePlan({ workOrder: wo, template: tpl });
  prints.push(crypto.createHash('sha256').update(JSON.stringify({ plan: p, sheet: planToSheetValues(p) })).digest('hex').slice(0, 16));
}
t(`★★ 리뷰·블로그·Q&A 계획 ${prints.length}조합이 결정 407 이전과 바이트 동일`,
  crypto.createHash('sha256').update(prints.join(',')).digest('hex') === '6c65bacbda2fe2844360ade210efad3972a366b702c53e506b2e9cd5957000e5');

console.log(`\n✅ ${pass}개 통과\n`);
