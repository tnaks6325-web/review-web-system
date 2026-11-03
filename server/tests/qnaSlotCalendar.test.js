/**
 * qnaSlotCalendar.test.js — Q&A체험단 2단계 회귀가드: 날짜별 자리표 생성(결정 321)
 * 실행: node tests/qnaSlotCalendar.test.js
 *
 * 위험:
 *  ① 자리표가 사용자 확정 규칙(상품별 동시 진행 · 하루 건수 · 공개글 하루 1건·간격 · 문구 순서)과 다르다.
 *  ② 날짜 건너뛰기를 뽑아내면서 **리뷰 작업의 구매일자 배분**이 한 글자라도 바뀐다(운영 작업 전부).
 *  ③ Q&A 작업표에 리뷰·구매 칸(리뷰옵션·주문번호·주소·결제금액)이 남거나, 리뷰 작업 칸 구성이 바뀐다.
 * ★ 순수 함수는 실제로 실행해 본다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

const C = require('../src/utils/qnaCalendar');
const W = require('../src/utils/worktablePlan');
const { planToSheetValues } = require('../src/services/worktableCreate.service');

console.log('\n▶ Q&A체험단 2단계 — 날짜별 자리표\n');

const P = (name, count, daily, qna) => ({ name, url: 'https://smartstore.naver.com/x/products/1', option_schema_version: 2, product_mode: 'none',
  base: { pay: 0, count, daily, review_type_mix: [], ...(qna ? { qna } : {}) }, options: [] });
const TEXTS = ['지금 구매했어요 .낼 국내배송 출발하시나요 ?', '국내배송 제품인가요 ?', '지금 구매했어요 .낼 바로 출발하시나요 ?',
  '톡톡 확인부탁드려요  금방 주문 넣었어요', '토프색상 재고 있나요?'];
// 첫 실제 오더(2026-11-03 일사공미디어) 모양 — 6상품 비공개 하루 1건 + 1상품 20건 하루 2건 · 공개 5건 하루 건너
const REAL = [P('A', 6, 1), P('B', 5, 1), P('C', 6, 1), P('D', 5, 1), P('E', 4, 1), P('F', 4, 1),
  P('G', 20, 2, { public_count: 5, public_texts: TEXTS, public_gap_days: 2 })];
const woOf = (products, extra = {}) => ({ id: 'wo_t', work_kind: 'qna', workboard_schema_version: 2, recruit_count: products.reduce((a, p) => a + p.base.count, 0),
  start_date: '2026-11-04', skip_weekends: true, product_options_json: JSON.stringify(products), ...extra });
// 운영 작업표 표준 열과 같은 모양(2026-11-03 운영 설정 읽기)
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'], channels: {}, workTypes: [] };

/* ── 1) 생성기 ───────────────────────────────────────────────── */
console.log('1) 생성기 — 실제 오더');
const plan = W.buildWorktablePlan({ workOrder: woOf(REAL), template: TEMPLATE });
t('만들 수 있다(잠금 없음)', plan.canCreate === true && plan.blockers.length === 0);
const slots = plan.qnaCalendar.slots;
t('★ 총 50자리 = 상품별 건수 합', slots.length === 50 && plan.rows.length === 50);
const by = k => slots.filter(s => s.unitKey === k);
t('★★ 상품 6개는 시작일부터 동시에 하루 1건(A 6일: 11/4~11/11 주말 제외)',
  JSON.stringify(by('A').map(s => s.date)) === JSON.stringify(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11'])
  && ['B', 'C', 'D', 'E', 'F'].every(k => by(k)[0].date === '2026-11-04'));
t('★ A~F 는 전부 비공개', ['A', 'B', 'C', 'D', 'E', 'F'].every(k => by(k).every(s => s.visibility === 'private' && s.text === '')));
const g = by('G');
const gDays = [...new Set(g.map(s => s.date))];
t('★ G 20건 = 10 진행일 × 하루 2건', gDays.length === 10 && gDays.every(d => g.filter(s => s.date === d).length === 2));
const gPub = g.filter(s => s.visibility === 'public');
t('★★ G 공개 5건 = 1·3·5·7·9번째 진행일, 하루 1건', JSON.stringify(gPub.map(s => s.date)) === JSON.stringify([gDays[0], gDays[2], gDays[4], gDays[6], gDays[8]]));
t('★★ 공개 문구는 입력 순서 그대로', JSON.stringify(gPub.map(s => s.text)) === JSON.stringify(TEXTS));
t('공개 자리는 그날의 첫 자리', gPub.every(p => g.find(s => s.date === p.date) === p));
t('★ 줄 순서 = 날짜 → 상품 순서 → 상품 안 순번, seq 1..50', slots.every((s, i) => s.seq === i + 1)
  && slots.every((s, i) => i === 0 || slots[i - 1].date < s.date || (slots[i - 1].date === s.date && (slots[i - 1].unitIdx < s.unitIdx || (slots[i - 1].unitIdx === s.unitIdx && slots[i - 1].unitSeq < s.unitSeq)))));
t('★ 같은 입력이면 같은 자리표(재접수·복구가 같은 표)',
  JSON.stringify(W.buildWorktablePlan({ workOrder: woOf(REAL), template: TEMPLATE }).qnaCalendar.slots) === JSON.stringify(slots));

console.log('\n2) 생성기 — 가장자리');
const cal = (units, days) => C.buildQnaCalendar({ units, days });
const days = n => W.businessDays({ count: n, startDate: '2026-11-02' });
const U = (o) => ({ unitKey: 'U', unitIdx: 0, productName: 'U', option1Value: '', option2Value: '', total: 6, daily: 1, publicCount: 0, publicTexts: [], publicGapDays: 1, ...o });
t('간격 1 = 매일 공개', cal([U({ publicCount: 3, publicTexts: ['a', 'b', 'c'] })], days(6)).slots.filter(s => s.visibility === 'public').map(s => s.dayIdx).join() === '0,1,2');
const comp = cal([U({ total: 4, publicCount: 3, publicTexts: ['a', 'b', 'c'], publicGapDays: 3 })], days(4));
t('간격대로 못 넣으면 앞당기고 알린다', comp.slots.filter(s => s.visibility === 'public').map(s => s.dayIdx).join() === '0,1,3'
  && comp.warnings.some(w => w.code === 'qna_public_compressed'));
const same = cal([U({ total: 4, daily: 2, publicCount: 3, publicTexts: ['a', 'b', 'c'] })], days(2));
t('공개가 진행일보다 많으면 같은 날 2건 + 알림', same.slots.filter(s => s.visibility === 'public').length === 3 && same.warnings.some(w => w.code === 'qna_public_same_day'));
t('★ 문구가 모자라면 잠근다', cal([U({ publicCount: 2, publicTexts: ['a'] })], days(6)).blockers.some(b => b.code === 'qna_public_text_missing'));
t('★ 빈 문구도 잠근다', cal([U({ publicCount: 2, publicTexts: ['a', ' '.trim()] })], days(6)).blockers.some(b => b.code === 'qna_public_text_missing'));
t('남는 문구는 알린다', cal([U({ publicCount: 1, publicTexts: ['a', 'b'] })], days(6)).warnings.some(w => w.code === 'qna_public_text_unused'));
t('공개 > 총 건수 잠금', cal([U({ total: 2, publicCount: 3, publicTexts: ['a', 'b', 'c'] })], days(6)).blockers.some(b => b.code === 'qna_public_exceeds_total'));
t('하루 건수 0 잠금', cal([U({ daily: 0 })], days(6)).blockers.some(b => b.code === 'qna_daily_zero'));
t('진행일이 모자라면 잠금', cal([U()], days(3)).blockers.some(b => b.code === 'qna_no_dates'));
t('★ 주말·공휴일·제외일을 건너뛴다(리뷰 구매일자와 같은 규칙)',
  W.businessDays({ count: 3, startDate: '2026-12-24', holidays: ['2026-12-28'] }).map(d => d.date).join() === '2026-12-24,2026-12-29,2026-12-30');

console.log('\n3) 오더 읽기');
const opt = [{ name: '양말', url: 'u', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0 },
  options: [{ option_1: { name: '색상', value: '검정' }, label: '검정', count: 3, daily: 1, qna: { public_count: 1, public_texts: ['검정 재고 있나요?'], public_gap_days: 1 } },
    { option_1: { name: '색상', value: '흰색' }, label: '흰색', count: 2, daily: 1, closed: true }] }];
const qu = C.qnaUnitsFromWorkOrder({ product_options_json: JSON.stringify(opt) });
t('옵션 단위 키 = 작업표 v2 선택 키(상품 · 옵션)', qu.units.length === 1 && qu.units[0].unitKey === '양말 · 검정' && qu.units[0].publicCount === 1);
t('마감 옵션은 자리를 만들지 않는다', !qu.units.some(u => u.option1Value === '흰색'));
t('camelCase 키도 받는다', C.qnaUnitsFromWorkOrder({ product_options_json: JSON.stringify([P('Z', 2, 1, { publicCount: 1, publicTexts: ['x'], publicGapDays: 2 })]) }).units[0].publicGapDays === 2);
t('깨진 JSON 은 잠근다', C.qnaUnitsFromWorkOrder({ product_options_json: '{' }).blockers.some(b => b.code === 'qna_no_products'));
t('★ 총모집 ≠ 상품별 합이면 잠근다', W.buildWorktablePlan({ workOrder: woOf(REAL, { recruit_count: 48 }), template: TEMPLATE }).blockers.some(b => b.code === 'qna_total_mismatch'));
t('시작일이 없으면 잠근다', W.buildWorktablePlan({ workOrder: woOf(REAL, { start_date: '' }), template: TEMPLATE }).blockers.some(b => b.code === 'qna_no_start_date'));
t('옛 형식(v1) 오더는 잠근다', W.buildWorktablePlan({ workOrder: woOf(REAL, { workboard_schema_version: 1 }), template: TEMPLATE }).blockers.some(b => b.code === 'qna_requires_v2'));

/* ── 4) 작업표 칸 ─────────────────────────────────────────────── */
console.log('\n4) 작업표 칸');
const names = plan.columns.map(c => c.name);
t('★ 진행일자(날짜 역할) · 상품 · 공개여부 · 문의문구', names.includes('진행일자') && plan.columns.find(c => c.name === '진행일자').role === 'dateStr'
  && names.indexOf('상품') < names.indexOf('공개여부') && names.indexOf('공개여부') + 1 === names.indexOf('문의문구'));
t('★★ 구매일자·리뷰옵션·주문번호·아이디·연락처·주소·결제금액 칸 없음', ['구매일자', '리뷰옵션', '주문번호', 'id', '연락처', '주소', '결제금액'].every(h => !names.includes(h)));
t('★ 이름·입금 계좌 칸은 둔다(누가 했는지 · 참여비)', ['수취인', '은행', '계좌번호', '예금주'].every(h => names.includes(h)));
t('★ 리뷰 제출·입금 상태 칸은 그대로', names.includes('리뷰') && names.includes('입금일'));
const { classifyHeaders } = require('../src/utils/worktableTemplate');
t('★ 공개여부·문의문구는 역할 없음(리뷰어 제출이 덮어쓰지 않는다)', classifyHeaders(['공개여부', '문의문구'], {}).every(c => !c.role));
const { findDateColumnIndex } = require('../src/services/campaignSchedule.service');
t('진행일자를 날짜 칸으로 읽는다(번호 정렬·그날 정원)', findDateColumnIndex(names) === names.indexOf('진행일자'));
const v = planToSheetValues(plan);
const col = h => v.header.indexOf(h);
const row7 = v.body[6];
t('★★ 7번 줄 = 11/4 G 공개 · 첫 문구', row7[col('진행일자')] === '11 / 4 (수)' && row7[col('상품')] === 'G'
  && row7[col('공개여부')] === '공개' && row7[col('문의문구')] === TEXTS[0]);
t('비공개 줄은 안내 문구', v.body[0][col('공개여부')] === '비공개' && v.body[0][col('문의문구')] === C.QNA_PRIVATE_GUIDE);
t('행 삭제 보충 줄이 공개여부·문의문구를 잇는다(결정 227)', ['공개여부', '문의문구'].every(h => W.planCellHeaders(names).includes(h)));

/* ── 5) 리뷰 작업 불변 ─────────────────────────────────────────── */
console.log('\n5) 리뷰 작업 불변');
// ★ 뽑아내기 전 distributeDates 원본(2026-11-03) 그대로 — 결과가 한 글자도 같아야 한다.
const { isHoliday } = require('../src/utils/krHolidays');
function legacyDistributeDates({ total, daily, startDate, skipWeekends = true, holidays = [] } = {}) {
  const parse = s => { const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
  const utc = o => Date.UTC(o.y, o.m - 1, o.d), back = x => { const dt = new Date(x); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; };
  const str = o => `${o.y}-${String(o.m).padStart(2, '0')}-${String(o.d).padStart(2, '0')}`;
  const DOW = ['일', '월', '화', '수', '목', '금', '토'], dow = o => new Date(utc(o)).getUTCDay();
  const label = o => `${o.m} / ${o.d} (${DOW[dow(o)]})`;
  const n = Math.max(0, parseInt(total, 10) || 0), per = Math.max(0, parseInt(daily, 10) || 0), start = parse(startDate);
  if (!n || !per || !start) return { days: [], rowDates: new Array(n).fill(null) };
  const skip = new Set((holidays || []).map(h => String(h || '').trim()).filter(Boolean));
  const ds = [], rowDates = []; let cur = start, guard = 0;
  while (rowDates.length < n && guard++ < 400) {
    if ((skipWeekends && ([0, 6].includes(dow(cur)) || isHoliday(str(cur)))) || skip.has(str(cur))) { cur = back(utc(cur) + 86400000); continue; }
    const take = Math.min(per, n - rowDates.length);
    ds.push({ date: str(cur), label: label(cur), dow: DOW[dow(cur)], count: take });
    for (let i = 0; i < take; i++) rowDates.push({ date: str(cur), label: label(cur) });
    cur = back(utc(cur) + 86400000);
  }
  while (rowDates.length < n) rowDates.push(null);
  return { days: ds, rowDates };
}
let same2 = true;
for (const total of [0, 1, 7, 50, 333, 2000]) for (const daily of [0, 1, 3, 30, 999]) for (const startDate of ['', '2026-11-04', '2026-12-24', '2027-01-29', '2026-02-13'])
  for (const skipWeekends of [true, false]) for (const holidays of [[], ['2026-12-28', '2027-02-01']]) {
    const a = JSON.stringify(W.distributeDates({ total, daily, startDate, skipWeekends, holidays }));
    const b = JSON.stringify(legacyDistributeDates({ total, daily, startDate, skipWeekends, holidays }));
    if (a !== b) { same2 = false; console.log('  diff', { total, daily, startDate, skipWeekends, holidays }); }
  }
t('★★ 리뷰 작업 구매일자 배분 = 뽑아내기 전과 바이트 동일(600 조합)', same2);
const rv = W.buildWorktablePlan({ workOrder: { ...woOf(REAL), work_kind: 'review', review_type: '자율리뷰' }, template: TEMPLATE });
t('★ 리뷰 작업은 구매일자·주문번호·주소 칸 그대로, Q&A 칸 없음', ['구매일자', '주문번호', '주소', '결제금액'].every(h => rv.columns.some(c => c.name === h))
  && !rv.columns.some(c => ['진행일자', '공개여부', '문의문구'].includes(c.name)) && !rv.qnaCalendar);
t('블로그 작업도 Q&A 칸 없음', !W.buildWorktablePlan({ workOrder: { ...woOf(REAL), work_kind: 'blog' }, template: TEMPLATE }).columns.some(c => c.name === '공개여부'));

/* ── 6) 접수 저장 ─────────────────────────────────────────────── */
console.log('\n6) 접수 저장');
const acc = fs.readFileSync(path.join(__dirname, '..', 'src/services/sheetlessAccept.service.js'), 'utf8');
t('★ 자리 i 의 줄 번호 = 작업표 줄 번호(headerRow + 1 + i)', /plan\.qnaCalendar\.slots\.map\(\(s, i\) => \(\{ \.\.\.s, rowSeq: headerRow \+ 1 \+ i \}\)\)/.test(acc));
t('★ 작업표 줄과 같은 흐름에서 저장 · 실패는 던진다', /createSlotsFromSheetRows[\s\S]{0,900}qs\.insertCalendar/.test(acc));
t('★ 줄이 계획과 같을 때만 붙인다(실패 잔재 재시도 — 다르면 던진다)', /verifyRowsMatchPlan\(\{ sheetId, tabName, planRows: rows \}\)[\s\S]{0,80}if \(!v\.ok\) throw[\s\S]{0,300}qs\.insertCalendar/.test(acc));
const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations/210_qna_slots.sql'), 'utf8');
t('migration 210: 가산 전용·멱등', /CREATE TABLE IF NOT EXISTS qna_slots/.test(mig) && !/DROP |ALTER TABLE .* DROP|CHECK \(/.test(mig.replace(/^--.*$/mg, '')));
t('같은 자리 중복 저장 차단(재접수 안전)', /uq_qna_slots_unit ON qna_slots \(sheet_id, tab_name, unit_key, unit_seq\)/.test(mig));

{
  const { qnaUnitsFromWorkOrder: U, buildQnaCalendar: C } = require('../src/utils/qnaCalendar');
  const mk = (daily) => ({ daily_count: 3, product_options_json: JSON.stringify([
    { name: 'P1', product_mode: 'single', base: { count: 3, ...(daily === undefined ? {} : { daily }) } },
    { name: 'P2', product_mode: 'single', base: { count: 3, daily: 3 } }]) });
  const z = U(mk(0)).units;
  t('★ 선택지에 하루 0건을 적으면 0 그대로 → 잠금(오더 하루 건수로 바꾸지 않는다)', z[0].daily === 0 && C({ units: z, days: [{ date: '2026-11-04', label: 'x' }] }).blockers.some(b => b.code === 'qna_daily_zero'));
  t('하루 건수를 안 적었을 때만 오더 하루 건수', U(mk(undefined)).units[0].daily === 3 && U(mk('')).units[0].daily === 3);
  const { buildWorktablePlan: BP } = require('../src/utils/worktablePlan');
  const big = { workboard_schema_version: 2, work_kind: 'qna', start_date: '2026-11-04', recruit_count: 100000, daily_count: 100000,
    product_options_json: JSON.stringify([{ name: 'P', product_mode: 'single', base: { count: 100000, daily: 100000 } }]) };
  const t0 = Date.now();
  const bp = BP({ workOrder: big, template: TEMPLATE });
  t('★ 상한을 넘는 건수는 자리를 펼치기 전에 막는다(서버가 멈추지 않게)', !bp.canCreate && bp.blockers.some(b => b.code === 'qna_too_many') && Date.now() - t0 < 2000);
}
console.log(`\n✅ ${pass}개 통과\n`);
