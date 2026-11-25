/**
 * receiptPoolContract.test.js — 영수증리뷰 2단계 회귀가드: 오더 입력 계약 · 영수증 묶음(한 장 = 한 자리) · 작업표 칸(결정 420)
 * 실행: node tests/receiptPoolContract.test.js
 *
 * 위험:
 *  ① AE 가 붙인 영수증 장수와 다른 수의 자리가 깔린다(모집 인원 ≠ 장수 · 같은 영수증 두 번 · 틀린 파일 번호).
 *  ② 리뷰비만 받는 작업에 결제금액이 실려 온다(입금 단계가 물건값을 보낸다).
 *  ③ 영수증리뷰 작업표에 구매·배송 칸(주문번호·아이디·연락처·주소·결제금액·옵션·택배)이 남거나 **날짜를 지어낸다**
 *     (영수증리뷰는 리뷰어가 기간 안에 아무 날이나 방문 — 참여일자는 참여할 때 채워진다).
 *  ④ 이 변경으로 **리뷰·블로그·Q&A·예약리뷰 작업표 계획이 한 글자라도 바뀐다** — 결정 420 이전 지문과 대조.
 *  ⑤ 현금영수증(상품 리뷰 작업의 다른 기능 · 결정 418)과 섞인다 · 이름 충돌로 실제 모듈이 안 읽힌다(418 에서 밟음).
 * ★ 순수 함수는 실제로 실행해 본다 · 고친 서버 모듈은 실제로 불러 본다.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

const R = require('../src/utils/receiptPool');
const W = require('../src/utils/worktablePlan');
const { planToSheetValues } = require('../src/services/worktableCreate.service');

console.log('\n▶ 영수증리뷰 2단계 — 오더 계약 · 영수증 묶음 · 작업표 칸\n');

const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'], channels: {}, workTypes: [] };
const FID = n => `fake_receipt_${String(n).padStart(4, '0')}_abcdefghijk`;
const RECEIPTS = n => Array.from({ length: n }, (_, i) => ({ file_id: FID(i + 1) }));
const SPEC = (o = {}) => ({ review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1', receipts: RECEIPTS(4), ...o });
const place = (receipt, extra = {}) => ({ name: '가짜카페 역삼점', url: 'https://map.naver.com/p/entry/place/0000000', option_schema_version: 2, product_mode: 'none',
  base: { pay: 0, count: 4, daily: 0, review_type_mix: [] }, options: [], receipt, ...extra });
const woOf = (products, extra = {}) => ({ id: 'wo_rc', work_kind: 'receipt', workboard_schema_version: 2, recruit_count: 4, review_fee: 5000,
  pay_amount: 0, skip_weekends: true, start_date: '', product_options_json: JSON.stringify(products), ...extra });
const codes = r => (r.blockers || []).map(b => b.code);

/* ── 1) 오더 입력 계약 ───────────────────────────────────────────── */
console.log('1) 오더 입력 계약(정규화 · 잠금)');
const ok = R.receiptReviewSpecFromWorkOrder(woOf([place(SPEC())]));
t('정상 오더는 잠금 없음', ok.blockers.length === 0);
t('★ 매장 = 상품 하나(이름·네이버 플레이스 주소) · 주소는 receipt.place_address', ok.spec.placeName === '가짜카페 역삼점'
  && ok.spec.placeUrl === 'https://map.naver.com/p/entry/place/0000000' && ok.spec.placeAddress === '서울 가짜구 가짜로 1');
t('★ 영수증 = 받은 순서 그대로 1..N(장수 = 자리 수)', ok.spec.total === 4
  && ok.spec.receipts.map(r => `${r.poolSeq}:${r.fileId}`).join(',') === [1, 2, 3, 4].map(n => `${n}:${FID(n)}`).join(','));
t('리뷰 마감 = 오더 값(참여한 날 + N일)', ok.spec.reviewDeadlineDays === 3);
t('리뷰 마감을 안 보내면 기본 3일', R.receiptReviewSpecFromWorkOrder(woOf([place(SPEC({ review_deadline_days: undefined }))])).spec.reviewDeadlineDays === 3
  && R.RECEIPT_REVIEW_DEFAULT_DEADLINE_DAYS === 3);
t('숫자 글자도 받는다(기한·인원)', R.receiptReviewSpecFromWorkOrder(woOf([place(SPEC({ review_deadline_days: '5' }), { base: { pay: '0', count: '4', daily: 0 } })], { recruit_count: '4' })).blockers.length === 0);
t('영수증 항목의 모르는 키는 무시한다(파일 번호만 읽는다)', R.receiptReviewSpecFromWorkOrder(woOf([place(SPEC({ receipts: RECEIPTS(4).map(r => ({ ...r, memo: '점심', amount: 12000 })) }))])).blockers.length === 0);

const bad = (o, products) => codes(R.receiptReviewSpecFromWorkOrder(woOf(products || [place(SPEC())], o)));
const badSpec = (s, extra, o) => codes(R.receiptReviewSpecFromWorkOrder(woOf([place(SPEC(s), extra)], o)));
t('★ 옛 형식(v1) 잠금', bad({ workboard_schema_version: 1 }).includes('receipt_requires_v2'));
t('★ 매장이 둘이면 잠금(오더 하나 = 매장 하나)', bad({}, [place(SPEC()), { ...place(SPEC()), name: '가짜카페 선릉점' }]).includes('receipt_one_place'));
t('★ 옵션 있는 상품은 잠금', codes(R.receiptReviewSpecFromWorkOrder(woOf([{ ...place(SPEC()), product_mode: 'opt',
  options: [{ option_1: { name: '메뉴', value: 'A' }, label: 'A' }] }]))).includes('receipt_one_place'));
t('매장 이름이 비면 잠금', codes(R.receiptReviewSpecFromWorkOrder(woOf([{ ...place(SPEC()), name: ' ' }]))).includes('receipt_place_name'));
t('상품 목록을 못 읽으면 잠금', codes(R.receiptReviewSpecFromWorkOrder(woOf([], { product_options_json: '{' }))).includes('receipt_one_place'));
t('★ 영수증 설정(receipt)이 없으면 잠금', codes(R.receiptReviewSpecFromWorkOrder(woOf([place(undefined)]))).includes('receipt_no_spec')
  && codes(R.receiptReviewSpecFromWorkOrder(woOf([place([1, 2])]))).includes('receipt_no_spec'));
t('★★ 영수증이 한 장도 없으면 잠금', badSpec({ receipts: [] }).includes('receipt_no_files') && badSpec({ receipts: undefined }).includes('receipt_no_files')
  && badSpec({ receipts: 'x' }).includes('receipt_no_files'));
{
  const huge = RECEIPTS(R.MAX_RECEIPTS + 1);
  const r = R.receiptReviewSpecFromWorkOrder(woOf([place(SPEC({ receipts: huge }), { base: { pay: 0, count: huge.length } })], { recruit_count: huge.length }));
  t(`★ 상한(${R.MAX_RECEIPTS}장)을 넘으면 펼치기 전에 잠금`, codes(r).includes('receipt_too_many') && R.MAX_RECEIPTS === 2000 && r.spec === null);
}
t('★★ 파일 번호 형식이 틀리면 잠금(드라이브 번호 모양만 · 주소째·빈 값·짧은 값·객체 아님)',
  ['https://x/api/order/guide-image/abc', '', 'short', 'a b c d e f g h i j k l m n'].every(v => badSpec({ receipts: [{ file_id: v }, ...RECEIPTS(3)] }).includes('receipt_file_invalid'))
  && badSpec({ receipts: ['fake_receipt_0001_abcdefghijk', ...RECEIPTS(3)] }).includes('receipt_file_invalid'));
t('★★ 같은 영수증이 두 번이면 잠금(한 장 = 한 사람)', badSpec({ receipts: [...RECEIPTS(3), { file_id: FID(1) }] }).includes('receipt_file_duplicate'));
t('★★ 모집 인원 ≠ 영수증 장수면 잠금(장수만큼만 받는다)', bad({ recruit_count: 5 }).includes('receipt_total_mismatch')
  && badSpec({}, { base: { pay: 0, count: 3, daily: 0 } }).includes('receipt_total_mismatch')
  && bad({ recruit_count: 0 }).includes('receipt_total_mismatch'));
t('★★ 결제금액이 있으면 잠금(매장 비용은 업체 부담 · 리뷰비만)', badSpec({}, { base: { pay: 9000, count: 4, daily: 0 } }).includes('receipt_has_pay')
  && bad({ pay_amount: 36000 }).includes('receipt_has_pay'));
t('★ 리뷰 마감은 1~30일', badSpec({ review_deadline_days: 0 }).includes('receipt_deadline_days') && badSpec({ review_deadline_days: 31 }).includes('receipt_deadline_days')
  && badSpec({ review_deadline_days: '3.5' }).includes('receipt_deadline_days') && badSpec({ review_deadline_days: 30 }).length === 0
  && R.RECEIPT_REVIEW_MAX_DEADLINE_DAYS === 30);
t('구매수량 단계가 붙어 오면 잠금', badSpec({}, { qty_tiers: { rows: [{ qty: 2 }] } }).includes('receipt_no_qty_tiers'));
t('★ 잠금은 「그대로 깔면 틀린 표」만 — 리뷰비 0원·매장 주소 없음은 막지 않는다(입금·안내 단계가 본다)',
  bad({ review_fee: 0 }).length === 0 && badSpec({ place_address: '' }).length === 0);
t('파일 번호 판정 = 결정 352 사진 통로와 같은 모양(20자 이상 [-\\w])', R.isReceiptFileId(FID(1)) && !R.isReceiptFileId('x'.repeat(19)) && !R.isReceiptFileId('../etc/passwd_aaaaaaaaaaaa'));

/* ── 2) 영수증 묶음 생성 ─────────────────────────────────────────── */
console.log('\n2) 영수증 묶음 생성(한 장 = 한 자리)');
const pool = R.buildReceiptPool(ok.spec, { startSeq: 1 });
t('★ 자리 수 = 영수증 장수 · 받은 순서 그대로', pool.slots.length === 4 && pool.blockers.length === 0
  && pool.slots.map(s => `${s.seq}:${s.poolSeq}:${s.fileId}`).join(',') === [1, 2, 3, 4].map(n => `${n}:${n}:${FID(n)}`).join(','));
t('★ 작업표 「영수증」 칸 표기 = N번(파일 번호는 작업표에 싣지 않는다 — 비공개)', pool.slots.map(s => s.label).join(',') === '1번,2번,3번,4번'
  && R.receiptPoolLabel(12) === '12번' && pool.slots.every(s => !s.label.includes(s.fileId)));
t('같은 계약이면 같은 묶음(재접수·복구가 같은 표)', JSON.stringify(R.buildReceiptPool(ok.spec, { startSeq: 1 })) === JSON.stringify(pool));
t('startSeq 를 따른다', R.buildReceiptPool(ok.spec, { startSeq: 5 }).slots[0].seq === 5);
t('잠긴 계약으로는 자리를 만들지 않는다', R.buildReceiptPool(null).slots.length === 0 && R.buildReceiptPool(null).blockers.length > 0);

/* ── 3) 작업표 계획 · 칸 ─────────────────────────────────────────── */
console.log('\n3) 작업표 계획 · 칸');
const plan = W.buildWorktablePlan({ workOrder: woOf([place(SPEC())]), template: TEMPLATE });
const names = plan.columns.map(c => c.name);
t('만들 수 있다', plan.canCreate === true && plan.blockers.length === 0);
t('★★ 칸 = 번호 · 참여일자 · 상품 · 영수증 · 리뷰마감일 · 수취인 · 은행 · 계좌번호 · 예금주 · 리뷰 · 입금일 · 비고',
  names.join(' · ') === '번호 · 참여일자 · 상품 · 영수증 · 리뷰마감일 · 수취인 · 은행 · 계좌번호 · 예금주 · 리뷰 · 입금일 · 비고');
t('★ 「구매일자」 자리가 「참여일자」(이름에 「일자」 · 같은 날짜 역할)', plan.columns.find(c => c.name === '참여일자').role === 'dateStr'
  && W.RECEIPT_DATE_HEADER === '참여일자' && /일자$/.test(W.RECEIPT_DATE_HEADER));
t('★ 영수증·리뷰마감일 칸 = 역할 없는 시스템 칸(리뷰어 구매양식 매퍼가 덮지 않는다)',
  ['영수증', '리뷰마감일'].every(h => plan.columns.find(c => c.name === h).role == null) && W.RECEIPT_POOL_HEADER === '영수증'
  && W.RECEIPT_DEADLINE_HEADER === W.BOOKING_DEADLINE_HEADER);
t('★★ 구매·배송·돈 칸 없음(주문번호·아이디·연락처·주소·결제금액·옵션·리뷰옵션·택배)',
  !plan.columns.some(c => ['orderNum', 'userId', 'phone', 'address', 'price', 'option', 'option_1', 'option_2', 'tracking_number', 'review_option_instruction'].includes(c.role)));
t('★ 택배발송대행이 켜진 오더라도 송장 칸을 붙이지 않는다', !W.buildWorktablePlan({ workOrder: woOf([place(SPEC())], { courier_proxy: true, delivery_type: '실배송' }), template: TEMPLATE })
  .columns.some(c => c.role === 'tracking_number'));
t('★ 참여일자 칸이 없는 표준 열이어도 시스템이 만든다(3단계 참여일 기록 자리)', (() => {
  const p = W.buildWorktablePlan({ workOrder: woOf([place(SPEC())]), template: { core: ['번호', '수취인', '연락처', '은행', '계좌번호', '예금주', '리뷰', '입금일'] } });
  const n = p.columns.map(c => c.name);
  return n.includes('참여일자') && p.columns.find(c => c.name === '참여일자').role === 'dateStr' && n.indexOf('참여일자') === n.indexOf('번호') + 1;
})());
t('★ 줄 수 = 영수증 장수', plan.rows.length === 4 && plan.receiptPool && plan.receiptPool.slots.length === 4);
t('★★ 날짜를 지어내지 않는다 — 줄마다 날짜 없음 · 날짜 요약 없음', plan.rows.every(r => r.date == null && r.dateLabel == null) && plan.dates.length === 0);
t('★ 미리보기 날짜·건수 조정을 받지 않는다(영수증 장수 = 줄 수 · 날짜 없음)', (() => {
  const p = W.buildWorktablePlan({ workOrder: woOf([place(SPEC())], { start_date: '2026-12-01', daily_count: 2 }), template: TEMPLATE, options: { total: 2, startDate: '2026-12-20', daily: 1, skipWeekends: false } });
  return p.rows.length === 4 && p.rows.every(r => r.date == null) && p.dates.length === 0;
})());
t('★ 리뷰타입을 행마다 정하지 않는다', plan.rows.every(r => !r.reviewOptionLabel && !r.reviewOption));
t('★ 계약 잠금은 계획 잠금으로 올라온다', codes(W.buildWorktablePlan({ workOrder: woOf([place(SPEC())], { recruit_count: 9 }), template: TEMPLATE })).includes('receipt_total_mismatch')
  && W.buildWorktablePlan({ workOrder: woOf([place(SPEC({ receipts: [] }))]), template: TEMPLATE }).canCreate === false);
t('영수증리뷰 안내 경고 하나(리뷰 날짜 경고·구매채널 모름·상품 칸 추가 안내 대신)', plan.warnings.some(w => w.code === 'receipt_pool')
  && !plan.warnings.some(w => ['no_start_date', 'no_daily', 'date_short', 'unknown_channel', 'product_column_added', 'no_date_column', 'blog_no_dates'].includes(w.code)));
t('★ 계획에 계약(정규화)을 싣는다(접수 저장 · 3단계 안내용)', plan.receiptSpec && plan.receiptSpec.total === 4 && plan.receiptSpec.reviewDeadlineDays === 3);

const sheet = planToSheetValues(plan);
const col = h => sheet.header.indexOf(h);
t('★ 영수증 칸 = 1번..4번', sheet.body.map(r => r[col('영수증')]).join(',') === '1번,2번,3번,4번');
t('★★ 참여일자·리뷰마감일 칸은 비워 둔다(참여할 때 채워진다 — 3단계)', sheet.body.every(r => r[col('참여일자')] === '' && r[col('리뷰마감일')] === ''));
t('상품 칸 = 매장 이름(선택 키)', sheet.body.every(r => r[col('상품')] === '가짜카페 역삼점'));
t('★★ 작업표 어느 칸에도 영수증 파일 번호가 없다(작업표·장부는 업체 화면에도 나간다)', !JSON.stringify(sheet).includes('fake_receipt_'));
t('★ 리뷰마감일은 보충 줄이 잇는 계획 칸에 들어가지 않는다 · 영수증 칸도(영수증 탭 줄 삭제가 따로 잇는다)',
  !W.planCellHeaders(['번호', '리뷰마감일', '영수증']).includes('리뷰마감일') && !W.planCellHeaders(['번호', '리뷰마감일', '영수증']).includes('영수증'));

/* ── 3-b) 화면 응답에서 파일 번호 지우기 ─────────────────────────── */
console.log('\n3-b) 화면 응답(작업보드 detail)에서 영수증 파일 번호 지우기');
{
  const raw = woOf([place(SPEC())]).product_options_json;
  const red = R.redactReceiptFileIds(raw);
  const back = JSON.parse(red);
  t('★★ 영수증 파일 번호가 사라지고 장수·순서만 남는다(업체 화면에도 나가는 응답)', !red.includes('fake_receipt_')
    && JSON.stringify(back[0].receipt.receipts) === JSON.stringify([{ no: 1 }, { no: 2 }, { no: 3 }, { no: 4 }])
    && back[0].name === '가짜카페 역삼점' && back[0].receipt.review_deadline_days === 3);
  const other = JSON.stringify([{ name: '가짜상품', base: { pay: 9000 }, booking: { dates: [] } }]);
  t('★ 영수증 목록이 없는 글은 받은 값 그대로(같은 문자열 — 다른 오더 응답 바이트 불변)', R.redactReceiptFileIds(other) === other
    && R.redactReceiptFileIds('') === '' && R.redactReceiptFileIds(null) === null && R.redactReceiptFileIds('{깨진"receipts"') === '{깨진"receipts"');
  const objIn = [place(SPEC())];
  t('배열로 와도 지운다(원본 배열은 고치지 않는다)', !JSON.stringify(R.redactReceiptFileIds(objIn)).includes('fake_receipt_') && JSON.stringify(objIn).includes('fake_receipt_'));
  const tbs = fs.readFileSync(path.join(__dirname, '..', 'src/services/trackB.service.js'), 'utf8');
  t('★ 작업보드 응답(workdeskTab) detail 은 영수증 파일 번호를 지운 오더 글만 싣는다(응답 바로 앞 · 다른 자리에서 원문을 내보내지 않음)',
    /const _detail = wo\[0\] \? \{ \.\.\.wo\[0\], productOptionsJson: redactReceiptFileIds\(wo\[0\]\.productOptionsJson\) \} : null;\n  const res = \{ role, maskPII, archived: !!archived, meta: _resMeta, detail: _detail,/.test(tbs)
    && /^const \{ redactReceiptFileIds \} = require\('\.\.\/utils\/receiptPool'\);/m.test(tbs)
    && !/detail: wo\[0\] \|\| null/.test(tbs.slice(tbs.indexOf('async function workdeskTab'), tbs.indexOf('async function workdeskTab') + 60000)));
}

/* ── 4) 리뷰·블로그·Q&A·예약리뷰 계획 불변(결정 420 이전 지문) ─────── */
console.log('\n4) 리뷰·블로그·Q&A·예약리뷰 계획 불변');
const TEMPLATES = [
  TEMPLATE,
  { core: ['번호', '구매일자', '수취인', '연락처', '주소', '결제금액', '리뷰마감일', '예약번호', '리뷰', '입금일'], channels: { naver: ['네이버아이디'] }, workTypes: [] },
  // 영수증리뷰 칸 이름(참여일자·영수증)이 리뷰 작업 표준 열에 있어도 리뷰 계획은 그대로여야 한다
  { core: ['번호', '참여일자', '구매일자', '상품', '영수증', '수취인', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금일', '비고'], channels: {}, workTypes: [] },
];
const P = (name, count, daily, extra = {}) => ({ name, url: 'https://smartstore.naver.com/x/products/1', option_schema_version: 2, product_mode: 'none',
  base: { pay: 12000, count, daily, review_type_mix: [] }, options: [], ...extra });
const OPT = { name: '양말', url: 'https://smartstore.naver.com/x/products/2', option_schema_version: 2, product_mode: 'opt', base: { pay: 9000, count: 0, daily: 0 },
  options: [{ option_1: { name: '색상', value: '검정' }, label: '검정', count: 3, daily: 1, pay: 9000 }, { option_1: { name: '색상', value: '흰색' }, label: '흰색', count: 2, daily: 1, pay: 9000 }] };
const BK = (mode) => ({ name: '가짜식당 강남점', url: 'https://booking.naver.com/booking/6/bizes/000000', option_schema_version: 2, product_mode: 'none',
  base: { pay: mode === 'free' ? 0 : 25000, count: 6, daily: 0, review_type_mix: [] }, options: [],
  booking: { pay_mode: mode, dates: [{ date: '2026-12-04', count: 2 }, { date: '2026-12-05', count: 1 }, { date: '2026-12-07', count: 3 }], review_deadline_days: 3, place_address: '서울 가짜구' } });
const orders = [];
for (const start of ['2026-12-01', '2026-12-24', '']) for (const skip of [true, false]) {
  orders.push({ id: 'wo_a', work_kind: '', workboard_schema_version: 2, recruit_count: 5, daily_count: 2, start_date: start, skip_weekends: skip, review_type: '포토', product_options_json: JSON.stringify([P('가짜상품', 5, 2)]) });
  orders.push({ id: 'wo_b', work_kind: 'review', workboard_schema_version: 2, recruit_count: 5, daily_count: 1, start_date: start, skip_weekends: skip, review_type: '텍스트', product_options_json: JSON.stringify([OPT]) });
  orders.push({ id: 'wo_c', work_kind: 'blog', workboard_schema_version: 2, recruit_count: 4, daily_count: 0, start_date: start, skip_weekends: skip, product_options_json: JSON.stringify([P('블로그상품', 4, 0)]) });
  orders.push({ id: 'wo_d', work_kind: 'qna', workboard_schema_version: 2, recruit_count: 7, daily_count: 2, start_date: start, skip_weekends: skip,
    product_options_json: JSON.stringify([P('Q1', 4, 2, { base: { pay: 0, count: 4, daily: 2, qna: { public_count: 1, public_texts: ['재고 있나요?'], public_gap_days: 2 } } }), P('Q2', 3, 1)]) });
  orders.push({ id: 'wo_e', work_kind: '', recruit_count: 6, daily_count: 2, start_date: start, skip_weekends: skip, review_type: '포토', product_options_json: '', product_option: '빨강, 파랑' });
  orders.push({ id: 'wo_f', work_kind: '사전예약 리뷰체험단', workboard_schema_version: 2, recruit_count: 3, daily_count: 1, start_date: start, skip_weekends: skip, review_type: '포토', product_options_json: JSON.stringify([P('사전예약상품', 3, 1)]) });
  orders.push({ id: 'wo_g', work_kind: 'booking', workboard_schema_version: 2, recruit_count: 6, review_fee: 5000, pay_amount: 150000, start_date: start, skip_weekends: skip, product_options_json: JSON.stringify([BK('refund')]) });
  orders.push({ id: 'wo_h', work_kind: 'booking', workboard_schema_version: 2, recruit_count: 6, review_fee: 5000, pay_amount: 0, start_date: start, skip_weekends: skip, product_options_json: JSON.stringify([BK('free')]) });
  // 현금영수증 상품 리뷰(결정 418 — 영수증리뷰 아님) · 상품에 receipt 키가 실려 온 리뷰 오더(종류가 receipt 가 아니면 읽지 않는다)
  orders.push({ id: 'wo_i', work_kind: '현금영수증 리뷰', income_type: '현영', workboard_schema_version: 2, recruit_count: 4, daily_count: 2, start_date: start, skip_weekends: skip, review_type: '포토', product_options_json: JSON.stringify([P('현영상품', 4, 2)]) });
  orders.push({ id: 'wo_j', work_kind: 'review', workboard_schema_version: 2, recruit_count: 3, daily_count: 1, start_date: start, skip_weekends: skip, review_type: '포토', product_options_json: JSON.stringify([P('영수증상품', 3, 1, { receipt: { receipts: [{ file_id: 'x'.repeat(25) }] } })]) });
}
const prints = [];
for (const tpl of TEMPLATES) for (const wo of orders) {
  const p = W.buildWorktablePlan({ workOrder: wo, template: tpl });
  prints.push(crypto.createHash('sha256').update(JSON.stringify({ plan: p, sheet: planToSheetValues(p) })).digest('hex').slice(0, 16));
}
t(`★★ 리뷰·블로그·Q&A·예약리뷰·현금영수증 리뷰 계획 ${prints.length}조합이 결정 420 이전과 바이트 동일`, prints.length === 180
  && crypto.createHash('sha256').update(prints.join(',')).digest('hex') === '12ba0f7582f5985e7a8652a2f7bd509072307c7b457af54151d926190c1fe859');

/* ── 5) 현금영수증 격리 · 이름 충돌 ──────────────────────────────── */
console.log('\n5) 현금영수증 격리 · 이름 충돌');
{
  const cs = require('../src/utils/captureSlots');
  t('★ 영수증리뷰 계획에는 현금영수증 칸이 없다(칸 이름 「영수증」은 현금영수증 라벨 규칙에 안 걸린다)',
    !names.some(n => /현금영수증|현영|지출증빙/.test(n)) && !/현금영수증|현영|지출증빙/.test(W.RECEIPT_POOL_HEADER));
  t('★ 현금영수증 칸 판정은 여전히 체험단 종류를 보지 않는다(같은 입력 = 같은 답)',
    JSON.stringify(cs.effectiveCaptureSlots(null, '현영')) === JSON.stringify(cs.effectiveCaptureSlots(null, '현영'))
    && !/work_?kind|isReceiptKind|receiptPool/i.test(String(cs.effectiveCaptureSlots)));
  const src = ['src/utils/receiptPool.js', 'src/services/receiptPool.service.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  t('★ 새 이름은 현금영수증 축 이름과 겹치지 않는다(_isReceiptUpload · receipt_validation · isCashReceipt* 를 새로 만들지 않음)',
    !/\b_isReceiptUpload\b|\breceipt_validation\b|function isCashReceipt/.test(src));
  // 418 에서 밟은 사고 — 같은 이름 두 번 선언으로 모듈이 읽히지도 않았다. 이번에 고친 모듈을 전부 실제로 불러 본다.
  const mods = ['src/routes/order.routes', 'src/routes/trackB.routes', 'src/routes/diag.routes', 'src/routes/campaign.routes',
    'src/services/trackB.service', 'src/services/sheetlessAccept.service', 'src/services/sheetlessLedger.service', 'src/services/sheetlessOrder.service',
    'src/services/sheetlessDailyPlan.service', 'src/services/sheetlessApplicant.service', 'src/services/linkedRecruitQuota.service',
    'src/services/rowNumbering.service', 'src/services/workdeskOrderDelete.service', 'src/services/worktableOptionSlots.service',
    'src/services/tabRename.service', 'src/services/workTabDelete.service', 'src/services/campaignWorktable.service',
    'src/services/sharedPatch.service', 'src/services/imageAllowlist.service', 'src/services/receiptPool.service', 'src/utils/receiptPool'];
  const failed = mods.filter(m => { try { require(path.join(__dirname, '..', m)); return false; } catch (e) { console.log('    읽기 실패', m, e.message); return true; } });
  t(`★★ 고친 서버 모듈 ${mods.length}개가 실제로 읽힌다(문법·이름 충돌 0)`, failed.length === 0);
}

console.log(`\n✅ ${pass}개 통과\n`);
process.exit(0);   // 불러 본 라우트 모듈의 타이머·풀이 끝을 붙잡지 않게
