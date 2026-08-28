/**
 * worktablePlan.test.js — 작업표 생성 M2a(계획 산출 + 미리보기) 회귀가드.
 *
 * 지키는 것 4가지:
 *  ① **미리보기와 실제 생성이 같은 함수**를 쓴다(순수함수 단일 출처) — 사본을 두면
 *     "미리보기 ≠ 실제 표" 가 되고, 그건 이 기능의 존재 이유를 무너뜨린다.
 *  ② **막을 것과 알릴 것의 경계**(blockers vs warnings). 오탐으로 정상 생성을 막지 않는다.
 *  ③ **날짜·옵션 분배가 시트 계약과 맞는다** — 구매일자 표기(`M / D (요일)`)를 063 시트 일정
 *     인식이 읽어 그날 모집 정원을 정하므로, 형식이 어긋나면 정원이 조용히 발행폼 값으로 되돌아간다.
 *  ④ **라우트는 읽기 전용** — 미리보기가 DB·시트에 아무것도 쓰지 않는다.
 *
 * 실행: node tests/worktablePlan.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const readS = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const P = require('../src/utils/worktablePlan');
const planSrc = readS('utils/worktablePlan.js');
const routes = readS('routes/trackB.routes.js');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const TPL = {
  core: ['번호', '구매일자', '옵션', '주문자', '수취인', '연락처', '주소', '결제금액', '리뷰제출', '입금', '비고'],
  channels: { coupang: ['쿠팡ID'], naver: ['네이버아이디'], oliveyoung: [], kakao: [] },
};
const WO = {
  id: 'wo_1', title: '테스트 100건', recruit_count: 100, daily_count: 20, start_date: '2026-08-10',
  product_url: 'https://www.coupang.com/vp/products/123?src=naver_ad',
  product_options_json: JSON.stringify([{ name: '힙스', options: [{ label: '골라담기' }, { label: '콰이어트' }, { label: '어나더' }] }]),
};

/* ══════════════════════════════════════════════════════════
   A. 채널 판정 — 호스트만 본다
   ══════════════════════════════════════════════════════════ */
console.log('\nA. 채널 판정');
ok('★ 광고 링크(coupang.com/...?src=naver_ad)를 네이버로 오판하지 않는다',
  P.channelFromUrl('https://www.coupang.com/vp/products/1?src=naver_ad') === 'coupang');
ok('★ 유사 도메인(coupang.com.evil.kr)에 속지 않는다',
  P.channelFromUrl('https://coupang.com.evil.kr/x') === 'unknown');
ok('네이버·올리브영 판정', P.channelFromUrl('https://smartstore.naver.com/a') === 'naver'
  && P.channelFromUrl('https://www.oliveyoung.co.kr/a') === 'oliveyoung');
ok('★ 카카오는 makers 만 — 톡스토어·선물하기는 진행 방식이 달라 오판 비용이 크다',
  P.channelFromUrl('https://makers.kakao.com/a') === 'kakao'
  && P.channelFromUrl('https://store.kakao.com/a') === 'unknown');
ok('판정 실패는 unknown — 틀린 채널로 분류하지 않는다',
  P.channelFromUrl('') === 'unknown' && P.channelFromUrl('그냥텍스트') === 'unknown');
ok('★ 채널 목록은 cashReceiptChannels 한 벌에서 온다(사본 금지)',
  /require\('\.\/cashReceiptChannels'\)/.test(planSrc)
  && /for \(const c of CASH_RECEIPT_CHANNELS\)/.test(planSrc));

/* ══════════════════════════════════════════════════════════
   B. 열 구성 — 공통 + 채널, 중복 없음
   ══════════════════════════════════════════════════════════ */
console.log('\nB. 열 구성');
const plan = P.buildWorktablePlan({ workOrder: WO, template: TPL });
ok('열 = 공통 + 그 채널 행', plan.columns.length === TPL.core.length + 1
  && plan.columns[plan.columns.length - 1].name === '쿠팡ID');
ok('열마다 출처(공통/채널)가 표시된다',
  plan.columns.filter(c => c.origin === 'channel').length === 1
  && plan.columns.filter(c => c.origin === 'common').length === TPL.core.length);
ok('★ 공통에 있는 이름은 채널에서 건너뛴다(같은 열 2번 생성 차단)',
  (() => {
    const t = { core: ['수취인', '쿠팡ID'], channels: { coupang: ['쿠팡ID'] } };
    const p = P.buildWorktablePlan({ workOrder: WO, template: t });
    /* ★ 2026-08-20: 옵션이 2종 이상이면 시스템이 옵션 칸을 자동으로 덧붙인다(송장 열과 같은 규율).
       이 검사의 대상은 **템플릿에서 온 열의 중복**이므로 시스템 열은 세지 않는다(검사 의미 불변). */
    const fromTpl = p.columns.filter(c => c.origin !== 'system');
    return fromTpl.length === 2 && p.columns.filter(c => c.name === '쿠팡ID').length === 1;
  })());
ok('★ 열 분류는 매퍼 파생 단일 출처(classifyHeaders) — 여기서 키워드 표를 만들지 않는다',
  /require\('\.\/worktableTemplate'\)/.test(planSrc)
  && /classifyHeaders\(names, tabOpts\)/.test(planSrc)
  && !/includes\('수취인'\)|includes\('예금주'\)/.test(planSrc));
ok('채널 미상이면 채널 열이 안 붙는다(+경고)',
  (() => {
    const p = P.buildWorktablePlan({ workOrder: { ...WO, product_url: '' }, template: TPL });
    return p.columns.length === TPL.core.length
      && p.warnings.some(w => w.code === 'unknown_channel');
  })());

/* ══════════════════════════════════════════════════════════
   C. 날짜 분배 — 시트 계약과 같은 표기
   ══════════════════════════════════════════════════════════ */
console.log('\nC. 날짜 분배');
ok('일건수만큼 나눈다(100건·일20 → 5일)', plan.totals.days === 5
  && plan.dates.every(d => d.count === 20));
ok('★★ 구매일자 표기가 시트 형식과 같다 — `M / D (요일)`',
  plan.rows[0].dateLabel === '8 / 10 (월)' && P.sheetDateStr({ y: 2026, m: 8, d: 10 }) === '8 / 10 (월)');
ok('★ 주말 제외가 기본(금요일 시작 → 토·일 건너뜀)',
  (() => {
    const p = P.buildWorktablePlan({ workOrder: { ...WO, recruit_count: 10, daily_count: 3, start_date: '2026-08-14' }, template: TPL });
    return p.dates.map(d => d.date).join(',') === '2026-08-14,2026-08-17,2026-08-18,2026-08-19';
  })());
ok('주말 포함으로 바꿀 수 있다',
  (() => {
    const p = P.buildWorktablePlan({ workOrder: { ...WO, recruit_count: 10, daily_count: 3, start_date: '2026-08-14' }, template: TPL, options: { skipWeekends: false } });
    return p.dates.map(d => d.date).join(',') === '2026-08-14,2026-08-15,2026-08-16,2026-08-17';
  })());
ok('★ 제외 날짜(공휴일·업체 휴무)만큼 뒤로 밀린다',
  (() => {
    const p2 = P.buildWorktablePlan({
      workOrder: { recruit_count: 9, daily_count: 3, start_date: '2026-08-13' },
      template: TPL, options: { holidays: ['2026-08-17'] } });
    return p2.dates.map(d => d.date).join(',') === '2026-08-13,2026-08-14,2026-08-18';
  })());
ok('★ 제외 날짜는 형식이 맞는 값만 — 잘못된 값은 무시(날짜 분배가 통째로 깨지는 것보다 낫다)',
  (() => {
    const p2 = P.buildWorktablePlan({
      workOrder: { recruit_count: 3, daily_count: 3, start_date: '2026-08-13' },
      template: TPL, options: { holidays: ['2026-08-17', '잘못된값', '2026-08-17', ''] } });
    return p2.holidays.join(',') === '2026-08-17';   // 중복 제거 + 정렬 + 형식 검증
  })());
ok('진행 기간 밖의 제외 날짜는 영향이 없다고 알려준다(오타·잘못 고른 날 노출)',
  (() => {
    const p2 = P.buildWorktablePlan({
      workOrder: { recruit_count: 3, daily_count: 3, start_date: '2026-08-13' },
      template: TPL, options: { holidays: ['2026-12-25'] } });
    return p2.warnings.some(w => w.code === 'holiday_outside') && p2.canCreate;
  })());
ok('제외 날짜가 없으면 경고도 없다(도배 방지)',
  !P.buildWorktablePlan({ workOrder: WO, template: TPL }).warnings.some(w => w.code === 'holiday_outside'));
ok('휴무일 지정도 건너뛴다',
  (() => {
    const r = P.distributeDates({ total: 4, daily: 2, startDate: '2026-08-10', holidays: ['2026-08-11'] });
    return r.days.map(d => d.date).join(',') === '2026-08-10,2026-08-12';
  })());
ok('마지막 날은 나머지만 담는다(10건·일3 → 3/3/3/1)',
  (() => {
    const r = P.distributeDates({ total: 10, daily: 3, startDate: '2026-08-10', skipWeekends: false });
    return r.days.map(d => d.count).join(',') === '3,3,3,1';
  })());
ok('★ 시작일이 없으면 날짜를 만들지 않는다(추측 금지) + 경고',
  (() => {
    const p = P.buildWorktablePlan({ workOrder: { recruit_count: 5, daily_count: 2 }, template: TPL });
    return p.rows.every(r => r.date === null) && p.warnings.some(w => w.code === 'no_start_date') && p.canCreate;
  })());
ok('★★ DB의 DATE 컬럼(Date 객체)도 받는다 — 프로덕션 실데이터로 잡은 버그',
  (() => {
    // node-pg 는 DATE 를 Date 객체로 준다. String(date).slice(0,10) 은 'Mon Aug 03' 이 되어 조용히 실패했다.
    const d = P.buildWorktablePlan({
      workOrder: { recruit_count: 10, daily_count: 5, start_date: new Date('2026-08-03T00:00:00.000Z') },
      template: { core: ['번호', '구매일자', '수취인'], channels: {} } });
    const str = P.buildWorktablePlan({
      workOrder: { recruit_count: 10, daily_count: 5, start_date: '2026-08-03' },
      template: { core: ['번호', '구매일자', '수취인'], channels: {} } });
    return d.startDate === '2026-08-03' && d.totals.days === 2 && d.rows[0].dateLabel === '8 / 3 (월)'
      && JSON.stringify(d.dates) === JSON.stringify(str.dates);   // 두 형태가 같은 결과
  })());
ok('★ Date 는 UTC 로 읽는다 — pg 가 DATE 를 UTC 자정으로 주므로 로컬로 읽으면 하루 밀린다',
  /getUTCFullYear\(\), m: v\.getUTCMonth\(\) \+ 1, d: v\.getUTCDate\(\)/.test(planSrc));
ok('★ 날짜를 나눴는데 구매일자 열이 없으면 경고(조용한 누락 + 정원 파생 실패 방지)',
  (() => {
    const p2 = P.buildWorktablePlan({
      workOrder: { recruit_count: 10, daily_count: 5, start_date: '2026-08-03' },
      template: { core: ['번호', '수취인'], channels: {} } });
    return p2.warnings.some(w => w.code === 'no_date_column');
  })());
ok('구매일자 열이 있으면 그 경고는 안 뜬다(도배 방지)',
  !P.buildWorktablePlan({
    workOrder: { recruit_count: 10, daily_count: 5, start_date: '2026-08-03' },
    template: { core: ['번호', '구매일자', '수취인'], channels: {} } }).warnings.some(w => w.code === 'no_date_column'));
ok('★ 타임존 무관 — Date 산술이 아니라 Y-M-D 문자열로 다룬다',
  !/getFullYear\(\)|getMonth\(\)|getDate\(\)|new Date\(\)/.test(planSrc)
  && /Date\.UTC/.test(planSrc));

/* ══════════════════════════════════════════════════════════
   D. 옵션 배분
   ══════════════════════════════════════════════════════════ */
console.log('\nD. 옵션 배분');
ok('작업오더 옵션으로 균등 배분(100·3종 → 34/33/33)',
  plan.optionBuckets.map(b => b.count).join(',') === '34,33,33'
  && plan.optionBuckets.reduce((a, b) => a + b.count, 0) === 100);
ok('지정 수량이 있으면 그대로 쓴다',
  (() => {
    const p = P.buildWorktablePlan({ workOrder: { recruit_count: 10 }, template: TPL, options: { options: [{ key: 'A', count: 7 }, { key: 'B', count: 3 }] } });
    return p.optionBuckets.map(b => b.key + ':' + b.count).join(',') === 'A:7,B:3' && p.canCreate;
  })());
ok('★ 옵션이 1개 이하면 배분하지 않는다(선택지가 하나면 기입 의미가 없다)',
  P.distributeOptions({ total: 6, options: ['단일'] }).buckets.length === 0);
ok('★ "옵션 없음·단일·해당없음" 은 옵션명이 아니라 서술 — 시트 옵션 칸을 오염시키지 않는다',
  (() => {
    // ★ 반환 모양은 {key, count} — 갭 A(옵션별 지정 수량) 반영으로 라벨과 수량을 함께 나른다.
    const k = P.optionKeysFromWorkOrder({ product_options_json: JSON.stringify([{ options: [{ label: '옵션 없음' }, { label: '해당없음' }, { label: '레드' }] }]) });
    return k.length === 1 && k[0].key === '레드' && k[0].count === null;
  })());
ok('깨진 옵션 JSON 은 옵션 없음으로 수렴(fail-soft)',
  P.optionKeysFromWorkOrder({ product_options_json: '{깨짐' }).length === 0);
ok('행마다 옵션이 배정된다', plan.rows[0].optionKey === '골라담기' && plan.rows[99].optionKey === '어나더');
ok('★★ 갭 A — 오더의 옵션별 수량(count)이 배분에 그대로 쓰인다(종전엔 라벨만 뽑아 균등으로 갈라졌다)',
  (() => {
    const p = P.buildWorktablePlan({
      workOrder: { recruit_count: 30, product_options_json: JSON.stringify([{ options: [{ label: 'A', count: 10 }, { label: 'B', count: 20 }] }]) },
      template: TPL });
    return p.optionBuckets.map(b => b.key + ':' + b.count).join(',') === 'A:10,B:20' && p.canCreate
      && !p.warnings.some(w => w.code === 'option_count_mismatch');
  })());
ok('★ 같은 라벨이 두 상품에 걸치면 수량은 합산한다',
  (() => {
    const k = P.optionKeysFromWorkOrder({ product_options_json: JSON.stringify([
      { options: [{ label: '단품', count: 5 }] }, { options: [{ label: '단품', count: 7 }] }]) });
    return k.length === 1 && k[0].count === 12;
  })());
ok('★★ 오더 수량 합계 ≠ 총 건수(미리보기 조정)면 잠그지 않고 균등 폴백 + 경고 — 수량 조절 UI 가 없어 잠그면 막다른 길',
  (() => {
    const p = P.buildWorktablePlan({
      workOrder: { recruit_count: 30, product_options_json: JSON.stringify([{ options: [{ label: 'A', count: 10 }, { label: 'B', count: 20 }] }]) },
      template: TPL, options: { total: 20 } });
    return p.canCreate && p.optionBuckets.map(b => b.count).join(',') === '10,10'
      && p.warnings.some(w => w.code === 'option_count_mismatch')
      && !p.blockers.some(b => b.code === 'option_sum');
  })());
ok('★ 수량이 일부 옵션에만 있으면 수량을 버리고 균등(반쪽 지정을 절반만 적용하지 않는다)',
  (() => {
    const p = P.buildWorktablePlan({
      workOrder: { recruit_count: 30, product_options_json: JSON.stringify([{ options: [{ label: 'A', count: 10 }, { label: 'B' }] }]) },
      template: TPL });
    return p.optionBuckets.map(b => b.count).join(',') === '15,15'
      && p.warnings.some(w => w.code === 'option_count_mismatch');
  })());

/* ══════════════════════════════════════════════════════════
   E. 막을 것 vs 알릴 것
   ══════════════════════════════════════════════════════════ */
console.log('\nE. blockers / warnings 경계');
const B = (wo, tpl, o) => P.buildWorktablePlan({ workOrder: wo, template: tpl || TPL, options: o }).blockers.map(b => b.code);
ok('건수 0 → 잠금', B({ recruit_count: 0 }).includes('no_total'));
ok('표준 열 미설정 → 잠금(먼저 설정하라고 안내)',
  B({ recruit_count: 10 }, { core: [], channels: {} }).includes('no_columns'));
ok('★ 옵션 합계 ≠ 총 건수 → 잠금(그대로 만들면 반드시 어긋난 표가 된다)',
  B({ recruit_count: 10 }, TPL, { options: [{ key: 'A', count: 3 }, { key: 'B', count: 4 }] }).includes('option_sum'));
ok('상한 초과 → 잠금', B({ recruit_count: 5000 }).includes('too_many'));
ok('★ 시작일 없음·채널 미상·역할 중복은 **경고만**(정상 생성을 막지 않는다)',
  (() => {
    const p = P.buildWorktablePlan({
      workOrder: { recruit_count: 10 },
      template: { core: ['수취인', '받는분', '연락처'], channels: {} },
    });
    return p.canCreate === true
      && p.warnings.some(w => w.code === 'no_start_date')
      && p.warnings.some(w => w.code === 'unknown_channel')
      && p.warnings.some(w => w.code === 'duplicate_role');
  })());
/* ★★ 2026-08-20(사용자 확정): 옵션을 나눴는데 표준 열에 옵션 칸이 없으면 **경고에서 그치지 않고
   자동으로 덧붙인다**(리뷰옵션·택배송장번호와 같은 규율). 종전 경고(`no_option_column`)만으로는
   만들어진 표에 칸이 영영 없어 리뷰어가 고른 옵션이 조용히 사라졌다(「선물세트 3종 빈박스」).
   검사 의미는 그대로 "조용한 누락 금지" — 칸이 생기고, 그 사실을 말하는지 본다. */
ok('★ 옵션은 나눴는데 옵션 열이 없으면 자동으로 만들고 그 사실을 알린다(조용한 누락 금지)',
  (() => {
    const p = P.buildWorktablePlan({ workOrder: { recruit_count: 6 }, template: { core: ['수취인'], channels: {} }, options: { options: ['A', 'B'] } });
    return p.columns.some(c => c.role === 'option' && c.origin === 'system')
      && p.warnings.some(w => w.code === 'option_column_added')
      && !p.warnings.some(w => w.code === 'no_option_column');
  })());
ok('상태 칸 겹침도 경고로 노출된다',
  (() => {
    const p = P.buildWorktablePlan({ workOrder: { recruit_count: 3 }, template: { core: ['입금일자'], channels: {} } });
    return p.warnings.some(w => w.code === 'status_conflict') || p.columns.every(c => !c.conflict);
  })());

/* ══════════════════════════════════════════════════════════
   F. 순수성 — 미리보기와 생성이 같은 함수를 쓸 수 있어야 한다
   ══════════════════════════════════════════════════════════ */
console.log('\nF. 순수함수');
ok('★★ DB·시트·현재시각에 접근하지 않는다(미리보기 ≡ 실제 생성의 전제)',
  !/require\('\.\.\/db|getPool|pool\.query|sheets\.|throttledCall/.test(planSrc)
  && !/Date\.now\(\)/.test(planSrc));
ok('같은 입력이면 같은 결과(결정적)',
  JSON.stringify(P.buildWorktablePlan({ workOrder: WO, template: TPL }))
  === JSON.stringify(P.buildWorktablePlan({ workOrder: WO, template: TPL })));
ok('상한이 prepareRosterSlots 와 같은 값(2000)', P.MAX_ROWS === 2000);

/* ══════════════════════════════════════════════════════════
   G. 미리보기 라우트 — 읽기 전용·권한
   ══════════════════════════════════════════════════════════ */
console.log('\nG. 미리보기 라우트');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const router = require('../src/routes/trackB.routes');
const layers = (router.stack || []).filter(l => l.route);
const planLayer = layers.find(l => l.route.path === '/worktable/plan');
ok('GET /worktable/plan 등록', !!planLayer && !!planLayer.route.methods.get);
ok('★ 권한 = 내부인 + 작업오더 편집 명단(표를 만들 사람이 미리보기를 본다)',
  (() => {
    const names = planLayer.route.stack.map(s => s.handle.name);
    return names[0] === 'authMiddleware' && names.includes('internalMiddleware') && names.includes('editorOnlyMiddleware');
  })());
ok('★ 미리보기는 읽기 전용 — 쓰기 메서드로 등록되지 않는다',
  !layers.some(l => l.route.path === '/worktable/plan'
    && (l.route.methods.post || l.route.methods.put || l.route.methods.delete)));
ok('★★ 라우트가 실제로 도는 이름을 쓴다(pool) — getPool 은 이 파일에 없다(런타임 500 재발 방지)',
  (() => {
    const i = routes.indexOf("router.get('/worktable/plan'");
    const j = routes.indexOf("router.post('/worktable/template'", i);
    const body = routes.slice(i, j > i ? j : i + 3000);
    return /await pool\.query\(/.test(body) && !/getPool\(\)/.test(body);
  })());
ok('작업오더 조회는 삭제되지 않은 행만',
  /FROM work_orders WHERE id = \$1 AND deleted_at IS NULL/.test(routes));
ok('미전송 조정값은 작업오더 값을 유지한다(부분 덮어쓰기)',
  (() => {
    const i = routes.indexOf("router.get('/worktable/plan'");
    const body = routes.slice(i, i + 3000);
    return /if \(q\.total != null && q\.total !== ''\) opt\.total/.test(body)
      && /if \(q\.startDate != null/.test(body);
  })());
ok('깨진 options 쿼리는 작업오더 파생으로 폴백(fail-soft)',
  /catch \(_\) \{ \/\* 깨진 값은 작업오더 파생으로 \*\/ \}/.test(routes));

/* ══════════════════════════════════════════════════════════
   H. 프론트 배선 — 미리보기는 서버 계산을 그대로 그린다
   ══════════════════════════════════════════════════════════ */
console.log('\nH. 프론트 배선');
const wdesk = readF('workdesk.html');
/* ★★ 사용자 확정 2026-08-21 — 흐름은 **접수하기 → 모집공고** 두 단계다.
   작업오더 행의 [📋 작업표] 미리보기 버튼은 없앴다(같은 일이 세 군데로 갈라져 번잡했다):
   접수는 오더 값을 그대로 믿고 만들고, 총건수·일건수·시작일·주말은 모집공고에서 고친다.
   ★ 모달·서버 계획 산출은 그대로 남겨 두었다(되살리기 쉽게) — 아래 검사들이 그것을 고정한다. */
ok('★ 행에는 [작업표] 버튼이 없다 — 접수하기 → 모집공고 두 단계(사용자 확정)',
  !/function _woEditActions\(o\)\{[\s\S]{0,1600}openWtPlan/.test(wdesk));
ok('★ 접수 뒤에는 실제 작업보드로, 공고가 없으면 [⚙ 작업 시작 설정] 로 보낸다',
  /function _woEditActions\(o\)\{[\s\S]{0,1600}_woOpenBoard\('\$\{id\}'\)/.test(wdesk)
  && /⚙ 작업 시작 설정/.test(wdesk));
ok('★★ 프론트가 날짜·옵션을 다시 계산하지 않는다(서버 계획을 그대로 렌더 — 미리보기 ≡ 실제 표)',
  (() => {
    const i = wdesk.indexOf('function _wtpRender()');
    const body = wdesk.slice(i, i + 6000);
    return i > -1
      && /p\.dates\.map/.test(body) && /p\.optionBuckets\.map/.test(body) && /p\.columns\.map/.test(body)
      // 재계산의 흔적(날짜 산술·분배 루프)이 없어야 한다.
      //   `p.skipWeekends?'checked':''` 는 서버 값을 체크박스에 비추는 것뿐이라 금지 대상이 아니다.
      && !/addDays|getUTCDay|Date\.UTC|setDate\(|86400000/.test(body);
  })());
ok('조정하면 서버에 다시 물어본다(로컬 재계산 금지)',
  /function _wtpOnEdit\(\)[\s\S]{0,200}_wtpLoad\(\)/.test(wdesk)
  && /worktable\/plan\?/.test(wdesk));
ok('★ 제외 날짜 UI 가 붙어 있고 판정 사본이 없다(서버가 형식·중복·정렬 최종 판정)',
  /function wtpHolAdd/.test(wdesk) && /function wtpHolDel/.test(wdesk)
  && /q\.set\('holidays',f\.holidays\.join\(','\)\)/.test(wdesk)
  && /p\.holidays\|\|\[\]/.test(wdesk));
ok('★ 제외 날짜는 다른 칸을 고쳐도 유지된다 — 값 읽기는 _wtpSyncForm 한 벌(사본 금지)',
  /function _wtpSyncForm/.test(wdesk)
  && /if\(f\.holidays==null\) f\.holidays/.test(wdesk)
  && /function _wtpOnEdit\(\)\{ _wtpSyncForm\(\); _wtpLoad\(\); \}/.test(wdesk));
ok('라우트가 holidays 쿼리를 받는다',
  /if \(q\.holidays\) opt\.holidays = String\(q\.holidays\)\.split\(','\)/.test(routes));
ok('열 이름·옵션명은 esc() 통과(시트·사용자 자유 문자열)',
  /esc\(c\.name\)/.test(wdesk) && /esc\(b\.key\)/.test(wdesk) && /esc\(d\.label\)/.test(wdesk));
ok('★ 접수 버튼은 잠긴 계획·이미 접수된 오더에서 비활성 + 사유를 화면이 말한다',
  /id="wtpCreateBtn"[\s\S]{0,160}\(p\.canCreate&&_wtpAcceptable\(\)\)\?''\:'disabled/.test(wdesk)
  && /지금 구성으로는 만들 수 없습니다\(위 빨간 사유\)/.test(wdesk)
  && /이미 접수된 작업오더입니다/.test(wdesk));
ok('표준 열 미설정이면 어디서 정하는지 안내한다',
  /설정 › 작업표 표준 열<\/b>에서 먼저 정하세요/.test(wdesk));

/* ══════════════════════════════════════════════════════════
   I. 생성(M2b-1) — 시트 쓰기·권한·라이브 무접촉
   ══════════════════════════════════════════════════════════ */
console.log('\nI. 작업표 생성');
const createSrc = readS('services/worktableCreate.service.js');
const C = require('../src/services/worktableCreate.service');

ok('POST /worktable/create 등록 + 권한(내부인 + 편집 명단)',
  (() => {
    const l = layers.find(x => x.route.path === '/worktable/create' && x.route.methods.post);
    if (!l) return false;
    const names = l.route.stack.map(s => s.handle.name);
    return names[0] === 'authMiddleware' && names.includes('internalMiddleware') && names.includes('editorOnlyMiddleware');
  })());
ok('★★ 계획은 서버가 다시 계산한다 — 화면이 보낸 행 목록을 믿지 않는다',
  /buildWorktablePlan\(\{ workOrder: wo, template, options: planOptions/.test(createSrc)
  && !/req\.body[\s\S]{0,80}\.rows/.test(readS('routes/trackB.routes.js')));
ok('★ 잠긴 계획은 생성하지 않는다(미리보기 잠금 = 서버 게이트, 같은 판정)',
  /if \(!plan\.canCreate\)[\s\S]{0,120}return \{ ok: false/.test(createSrc));
ok('★★ clearSheetValues 를 쓰지 않는다 — gid 를 안 받아 **다른 탭을 지울 수 있다**(런타임 확인으로 잡은 위험)',
  !/clearSheetValues\(/.test(createSrc));
ok('시트 쓰기는 전부 gid 를 지정한다(탭 오지정 차단)',
  (() => {
    const calls = createSrc.match(/writeSheet\([\s\S]*?\);/g) || [];
    return calls.length >= 2 && calls.every(c => /\{ gid: newGid \}/.test(c));
  })());
ok('★ 시스템이 값을 넣는 칸은 번호·구매일자·옵션 셋뿐(나머지는 제출이 채운다)',
  (() => {
    const plan2 = P.buildWorktablePlan({
      workOrder: { recruit_count: 2, daily_count: 1, start_date: '2026-08-10',
        product_url: 'https://www.coupang.com/a',
        product_options_json: JSON.stringify([{ options: [{ label: 'A' }, { label: 'B' }] }]) },
      template: { core: ['번호', '구매일자', '옵션', '수취인', '연락처'], channels: { coupang: ['쿠팡ID'] } } });
    const v = C.planToSheetValues(plan2);
    // ★ 템플릿에 제출 칸이 없으면 시스템이 '리뷰'를 붙인다(2026-08-21) — **값은 안 넣는다**(빈 칸).
    return v.header.join(',') === '번호,구매일자,옵션,수취인,연락처,리뷰,쿠팡ID'
      && v.body[0].join('|') === '1|8 / 10 (월)|A||||'
      && v.body[1].join('|') === '2|8 / 11 (화)|B||||';
  })());
ok('★★ 구매일자는 시트 형식 그대로 쓰인다(063 시트 일정 인식이 읽는 값)',
  (() => {
    const plan2 = P.buildWorktablePlan({
      workOrder: { recruit_count: 1, daily_count: 1, start_date: '2026-08-10' },
      template: { core: ['구매일자'], channels: {} } });
    return C.planToSheetValues(plan2).body[0][0] === '8 / 10 (월)';
  })());
ok('열 문자 변환(A·Z·AA·AZ)',
  C.colLetter(0) === 'A' && C.colLetter(25) === 'Z' && C.colLetter(26) === 'AA' && C.colLetter(51) === 'AZ');
ok('★★ 생성 경로는 라이브 무접촉 — 주문원장·투영·큐·행배정을 건드리지 않는다',
  (() => {
    // ★ 범위는 createWorktable 함수 본문 — 삭제 경로는 "사용 중인가"를 **읽어야** 하므로 별도 판정.
    const i = createSrc.indexOf('async function createWorktable');
    const j = createSrc.indexOf('async function deleteWorktableTab');
    const code = createSrc.slice(i, j > i ? j : createSrc.length)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    return !/order_submissions|campaign_participants|sheet_row_claims|enqueue\(|reconcileStuckOrders|review_index/.test(code);
  })());
ok('★ 삭제 경로가 원장을 보는 것은 **읽기뿐**(SELECT) — 지우거나 고치지 않는다',
  (() => {
    const i = createSrc.indexOf('async function deleteWorktableTab');
    const body = createSrc.slice(i);
    return /SELECT COUNT\(\*\) FROM campaign_participants/.test(body)
      && /SELECT COUNT\(\*\) FROM order_submissions/.test(body)
      && !/(INSERT INTO|UPDATE|DELETE FROM)\s+(order_submissions|review_index)/i.test(body);
  })());
ok('★ 쓰기 표면은 시트 + work_orders.work_sheet_url 뿐(탭 등록은 여전히 접수가 관문)',
  (() => {
    // ★ 주석의 '언급'이 아니라 **쓰기 구문**만 센다(tab_configs 는 주석에서 설명된다).
    const writes = createSrc.match(/\b(?:INSERT INTO|UPDATE)\s+(?!SET\b)\w+/gi) || [];
    return writes.length === 1 && /work_orders/i.test(writes[0]) && !/DELETE FROM/i.test(createSrc);
  })());
ok('★ 생성 경로는 아무것도 지우지 않는다(파일 삭제·행 삭제 없음)',
  (() => {
    const i = createSrc.indexOf('async function createWorktable');
    const j = createSrc.indexOf('async function deleteWorktableTab');
    const body = createSrc.slice(i, j > i ? j : createSrc.length);
    return !/deleteSheet|deleteRows|drive\.files\.delete/.test(body);
  })());
ok('★★ 파일(스프레드시트) 자체는 어디서도 지우지 않는다 — 탭 삭제만 연다',
  !/drive\.files\.delete|deleteSpreadsheet/.test(createSrc));
ok('헤더 줄 위치는 가정하지 않고 탐지한다(템플릿이 바뀌어도 따라감)',
  /require\('\.\.\/utils\/sheetHeader'\)/.test(createSrc)
  && /detectSheetHeader\(values \|\| \[\]/.test(createSrc));
ok('탭 이름 공란은 명확히 거부', /탭 이름이 비어 있습니다/.test(createSrc));
ok('★★ 템플릿 시트는 **선택** — 없으면 빈 탭으로 만든다(설정 안 된 조직에서 기능이 통째로 막히지 않게)',
  /빈 스프레드시트\(열·행은 동일, 서식만 없다\)/.test(createSrc)
  && /addSheet: \{ properties: \{ title \} \}/.test(createSrc)
  && !/return \{ ok: false, error: 'TEMPLATE_SHEET_ID/.test(createSrc));
ok('★ 템플릿 해석 순서 = 요청값 → 전사 설정(app_settings) → env',
  /tplSheetId \|\| template\.templateSheetId \|\| process\.env\.TEMPLATE_SHEET_ID/.test(createSrc));
ok('★ 빈 탭이면 헤더는 1행(덮을 메타·공지문이 없다) · 템플릿 복사본만 탐지',
  /usedTemplate\s*\?\s*await _resolveHeaderRow[\s\S]{0,80}\{ row: 1, width: 0 \}/.test(createSrc));
ok('전사 설정으로 저장·조회된다(브라우저 localStorage 에만 있던 값을 서버로)',
  (() => {
    const svc = readS('services/worktable.service.js');
    return /function normalizeSheetId/.test(svc)
      && /templateSheetId: ''/.test(svc)
      // ★ 저장은 `_mergeTemplate` 이 만든다(부분 저장 도입으로 이관 — 검사 의미 불변).
      && /next\.templateSheetId = [\s\S]{0,120}normalizeSheetId\(body\.templateSheetId\)/.test(svc);
  })());
ok('시트 주소를 붙여넣어도 ID 로 정규화(잘못된 값은 빈 값 — 추측 금지)',
  (() => {
    const { normalizeSheetId } = require('../src/services/worktable.service');
    const id = '1AbC_dEfGh-IjKlMnOpQrStUvWxYz012345';
    return normalizeSheetId('https://docs.google.com/spreadsheets/d/' + id + '/edit#gid=0') === id
      && normalizeSheetId(id) === id && normalizeSheetId('짧은값') === '' && normalizeSheetId('') === '';
  })());
ok('설정 화면에 템플릿 시트 입력칸이 있고 저장에 실린다',
  (() => {
    const set = readF('js/admin-settings.js');
    return /id="wtTplSheet"/.test(set) && /templateSheetId: tplEl \? tplEl\.value/.test(set);
  })());
// ⚠ 이 문구가 있던 화면 창구(시트 생성)는 제거됐다 — 서버는 여전히 서식 유무를 응답으로 알린다.
ok('★ 템플릿 없이 만들면 서버가 그 사실을 응답으로 알린다(조용한 서식 누락 금지)',
  /usedTemplate = false;/.test(createSrc) && /usedTemplate, mirrored/.test(createSrc));
// ★★ 탈 구글시트(사용자 확정 2026-08-10): 미리보기에 **구글시트 생성·삭제 창구가 없다**.
//   남겨 두면 그 오더에 work_sheet_url 이 붙어 다시 시트 기반으로 접수되는 역행이 된다.
ok('★★ 프론트에 시트 생성·삭제 창구가 없다(창구 하나 = 접수)',
  !/wtpCreate\(\)/.test(wdesk) && !/wtpDelete\(\)/.test(wdesk) && !/wtpDeleteTab\(\)/.test(wdesk)
  && !/id="wtpSheet"/.test(wdesk) && !/id="wtpMode"/.test(wdesk));
ok('★ 미리보기의 유일한 실행 버튼 = 접수(같은 `_woAccept` 로 수렴 — 사본 0)',
  /onclick="wtpAccept\(\)"/.test(wdesk) && /id="wtpTabName"/.test(wdesk)
  && /await _woAccept\(_WTP\.id, null, \{ tabName, planOptions:\{/.test(wdesk));
ok('★ 조정한 구성이 그대로 접수에 실린다(서버가 같은 계획으로 작업표를 만든다)',
  /if\(opts&&opts\.tabName\) body\.tabName=opts\.tabName;/.test(wdesk)
  && /if\(opts&&opts\.planOptions\) body\.planOptions=opts\.planOptions;/.test(wdesk));
ok('★ 시트탭URL 이 있는 오더는 그 구성이 미적용임을 화면이 말한다(조용한 불일치 금지)',
  /접수 시 그 시트 탭이 등록됩니다\(아래 구성은 미적용\)/.test(wdesk));
// ⚠ '대상 시트 드롭다운'은 시트 생성 창구와 함께 제거됐다(탈 구글시트) — 목록 키 계약만 서버 쪽에 남긴다.
ok('★★ /tabs 응답의 목록 키는 `tabs` (다른 소비처가 그대로 읽는다)',
  /const out = \{ ok: true, count: tabs\.length, tabs[,\s}]/.test(readS('routes/trackB.routes.js')));

/* ══════════════════════════════════════════════════════════
   J. 작업대 표 스켈레톤(M2b-2) — 줄 번호 정합·상태 추종·되돌리기
   ══════════════════════════════════════════════════════════ */
console.log('\nJ. 작업대 표 스켈레톤');
const partSrc = readS('services/participants.service.js');

ok('★★ 열 구성이 헤더로 인식 안 되면 **잠금** — 그 탭은 통째로 파싱되지 않는다(검색·제출 전면 중단)',
  (() => {
    const bad = P.buildWorktablePlan({ workOrder: { recruit_count: 10 }, template: { core: ['번호', '메모A', '메모B'], channels: {} } });
    const good = P.buildWorktablePlan({ workOrder: { recruit_count: 10 }, template: { core: ['번호', '수취인', '연락처'], channels: {} } });
    return !bad.canCreate && bad.blockers.some(b => b.code === 'header_unrecognizable') && good.canCreate;
  })());
ok('★ 헤더 인식 판정은 인덱스 빌더와 같은 함수(isSheetHeaderRow) — 사본 금지',
  /require\('\.\/sheetHeader'\)/.test(planSrc) && /isSheetHeaderRow\(columns\.map/.test(planSrc));

ok('★★ 스켈레톤 seq = 시트 실제 행 번호(헤더 바로 아래부터) — 어긋나면 표가 두 겹이 된다',
  /const seq = hr \+ i \+ 1;/.test(partSrc)
  && /createWorktableSlots: headerRow 필수/.test(partSrc));
ok('★ 900000+ 대역(prepareRosterSlots)을 쓰지 않는다 — 그건 시트 행을 모를 때용',
  (() => {
    const i = partSrc.indexOf('async function createWorktableSlots');
    const j = partSrc.indexOf('async function deleteWorktableRows');
    // ★ 대역을 **배정에** 쓰는 것을 막는 가드다 — appendSlot 의 `FILTER (WHERE seq < ${_MANUAL_SEQ_BASE})` 는
    //   반대로 그 대역을 **제외**하는 방어(2026-08-21 [＋ 줄 추가] 결함 수정)라 허용한다(검사 의미 불변).
    const region = partSrc.slice(i, j)
      .replace(/MAX\(seq\) FILTER \(WHERE seq < \$\{_MANUAL_SEQ_BASE\}\)/g, '')
      .replace(/900000 대역[^\n]*/g, '');
    return !/_MANUAL_SEQ_BASE/.test(region);
  })());
ok('★ 멱등·비파괴 — ON CONFLICT DO NOTHING(이미 주문이 들어온 줄을 덮지 않는다)',
  /VALUES \$\{ph\.join\(','\)\}\s*\n\s*ON CONFLICT \(sheet_id, tab_name, seq\) DO NOTHING/.test(partSrc));
ok("★★ source='worktable' 은 import 처럼 상태를 따라간다 — 'manual' 이면 리뷰제출·입금이 영영 안 켜진다",
  /is_submitted = CASE WHEN campaign_participants\.source IN \('import','worktable'\)/.test(partSrc)
  && /is_paid\s+= CASE WHEN campaign_participants\.source IN \('import','worktable'\)/.test(partSrc));
ok("★ _reconcileSeen 은 그대로 'import' 만 비활성화 — 빈 줄이 투영에 살아남는다",
  /AND source = 'import' AND active = TRUE/.test(readS('services/trackB.service.js')));
ok('★ parity 는 phone8 없는 행을 걸러내므로 빈 줄이 진짜불일치로 잡히지 않는다',
  /const A = aRows\.map\(norm\)\.filter\(r => r\.p8\)/.test(readS('services/trackB.service.js')));

ok('되돌리기: 주문 있는 줄은 목록을 돌려주고 확인 뒤에만 삭제(사용자 확정)',
  /needsConfirm: true, filledCount/.test(partSrc)
  && /confirmed = false/.test(partSrc));
ok('★ 삭제는 소프트(deleted_at) — 이력이 남는다',
  /SET deleted_at = NOW\(\), active = FALSE/.test(partSrc));
ok('★★ 삭제가 주문 원장·시트를 건드리지 않는다',
  (() => {
    const i = partSrc.indexOf('async function deleteWorktableRows');
    const body = partSrc.slice(i, i + 2200);
    return !/order_submissions|sheets\.|deleteSheet/.test(body);
  })());
ok('POST /worktable/delete 권한(내부인 + 편집 명단)',
  (() => {
    const l = layers.find(x => x.route.path === '/worktable/delete' && x.route.methods.post);
    if (!l) return false;
    const names = l.route.stack.map(s => s.handle.name);
    return names[0] === 'authMiddleware' && names.includes('internalMiddleware') && names.includes('editorOnlyMiddleware');
  })());
ok('★ 스켈레톤 생성 실패가 시트 생성을 되돌리지 않는다(시트가 1순위 산출물)',
  /작업대 표 행 생성 실패\(시트는 만들어짐\)/.test(createSrc)
  && /slots = \{ error: e\.message \}/.test(createSrc));
ok('★★ 만든 직후 그 시트를 즉시 미러한다 — 안 하면 주문이 준비된 빈 줄을 못 보고 아래에 붙는다',
  /mirrorOneSheet\(targetSheetId, \{ force: true \}\)/.test(createSrc)
  && /생성 직후 미러 실패\(다음 주기가 메운다\)/.test(createSrc));
ok('★ 미러 실패가 생성을 되돌리지 않는다(시트·표는 이미 만들어졌다)',
  /mirrored = \{ error: e\.message \}/.test(createSrc));
ok('킬스위치 WORKTABLE_DB_ROWS=0 이면 시트만 만든다',
  /process\.env\.WORKTABLE_DB_ROWS !== '0'/.test(createSrc));
// ⚠ 되돌리기·시트 탭 삭제의 **화면 창구는 제거**(위 참조) — 서버 라우트는 되살리기 쉽게 남겨 둔다.
ok('서버 되돌리기 라우트는 남아 있다(화면만 제거)',
  !!layers.find(x => x.route.path === '/worktable/delete' && x.route.methods.post));

/* ══════════════════════════════════════════════════════════
   K. 시트 탭 삭제 — 아무도 안 쓴 탭만
   ══════════════════════════════════════════════════════════ */
console.log('\nK. 시트 탭 삭제');
ok('POST /worktable/delete-tab 권한(내부인 + 편집 명단)',
  (() => {
    const l = layers.find(x => x.route.path === '/worktable/delete-tab' && x.route.methods.post);
    if (!l) return false;
    const nm = l.route.stack.map(s => s.handle.name);
    return nm[0] === 'authMiddleware' && nm.includes('internalMiddleware') && nm.includes('editorOnlyMiddleware');
  })());
ok('★★ 주문·참여자가 1건이라도 있으면 거부(되돌릴 수 없는 파괴 차단)',
  /이 탭에는 이미 주문·참여자 \$\{n\}건이 있어/.test(createSrc)
  && /FROM campaign_participants[\s\S]{0,200}FROM order_submissions/.test(createSrc));
ok('★ 확인 실패는 삭제하지 않는다(fail-closed — 모르면 파괴하지 않는다)',
  /사용 여부 확인 실패 — 삭제 중단/.test(createSrc)
  && /확인하지 못해 중단했습니다/.test(createSrc));
ok('★★ gid 는 서버가 이름으로 재조회 — 클라이언트 gid 를 믿고 지우면 엉뚱한 탭이 사라진다',
  /getSpreadsheetMeta\(sheetId\)[\s\S]{0,300}find\(x => String\(x\.properties\.title\) === String\(tabName\)\)/.test(createSrc)
  && !/deleteSheet: \{ sheetId: (b|req)\./.test(createSrc));
ok('마지막 남은 탭은 미리 막는다(구글이 거부하는 동작)',
  /sheetCount <= 1/.test(createSrc));
ok('탭 삭제 후 표의 줄도 함께 내린다',
  /deleteWorktableRows\(\{ sheetId, tabName, confirmed: true/.test(createSrc));
ok('서버 탭 삭제 라우트는 남아 있다(화면 창구는 제거)',
  !!layers.find(x => x.route.path === '/worktable/delete-tab' && x.route.methods.post));

/* ══════════════════════════════════════════════════════════
   L. 리뷰 종류(포토/텍스트/구매확정/별점) 배분 — 사용자 확정(2026-08-19)
      날짜별 비율 유지 · 기입 칸 = 리뷰옵션 · 어휘는 utils/reviewType 단일 출처
   ══════════════════════════════════════════════════════════ */
console.log('\nL. 리뷰 종류 배분(리뷰옵션 칸)');
const RT = require('../src/utils/reviewType');
const MIX_WO = {
  recruit_count: 30, daily_count: 10, start_date: '2026-08-24',
  product_url: 'https://www.coupang.com/vp/1',
  review_type: '혼합(포토 10건, 텍스트 20건)',
  review_type_mix: JSON.stringify([{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 20 }]),
};
const mixPlan = P.buildWorktablePlan({ workOrder: MIX_WO, template: TPL });
ok('★★ 혼합 수량이 행에 배분된다(포토 10 + 텍스트 20 = 30행 전부)',
  (() => {
    const c = {};
    mixPlan.rows.forEach(r => { c[r.reviewOption] = (c[r.reviewOption] || 0) + 1; });
    return c['포토리뷰'] === 10 && c['텍스트'] === 20 && !c[null] && !c[undefined];
  })());
ok('★★ 날짜별 비율 유지 — 앞 행부터 몰아 적으면(포토 10행→텍스트 20행) 앞 날짜가 전부 포토가 된다',
  (() => {
    const byDay = {};
    mixPlan.rows.forEach(r => { byDay[r.date] = byDay[r.date] || {}; byDay[r.date][r.reviewOption] = (byDay[r.date][r.reviewOption] || 0) + 1; });
    // 매일 10행 = 포토 3~4 · 텍스트 6~7 (largest remainder — 하루가 한 유형으로 쏠리지 않는다)
    return Object.values(byDay).every(d => (d['포토리뷰'] || 0) >= 3 && (d['포토리뷰'] || 0) <= 4
      && (d['텍스트'] || 0) >= 6 && (d['텍스트'] || 0) <= 7);
  })());
ok('★★ 리뷰옵션 칸이 없으면 자동으로 덧붙는다 — 자리는 자동 열(번호·구매일자) 바로 뒤(작업지시 앞쪽 규칙)',
  (() => {
    const names = mixPlan.columns.map(c => c.name);
    const at = names.indexOf('리뷰옵션');
    return at === 2 && names[0] === '번호' && names[1] === '구매일자'
      && mixPlan.columns[at].origin === 'system';
  })());
ok('★ 템플릿에 리뷰옵션 칸이 이미 있으면 새로 만들지 않는다(같은 열 2번 금지)',
  (() => {
    const t = { core: ['번호', '구매일자', '리뷰옵션', '수취인', '연락처'], channels: {} };
    const p = P.buildWorktablePlan({ workOrder: MIX_WO, template: t });
    return p.columns.filter(c => /리뷰\s*옵션/.test(c.name)).length === 1;
  })());
ok('★ 혼합이 아니면(유형 2가지 미만·수량 없음) 행에 적지 않고 열도 안 붙는다 — 단일 유형은 공고·탭 리뷰타입이 담당(opt-in)',
  (() => {
    const p1 = P.buildWorktablePlan({ workOrder: WO, template: TPL });   // mix 없음
    const p2 = P.buildWorktablePlan({ workOrder: { ...MIX_WO, review_type_mix: JSON.stringify([{ type: 'photo', quantity: 30 }]) }, template: TPL });
    return p1.rows.every(r => !r.reviewOption) && !p1.columns.some(c => c.name === '리뷰옵션')
      && p2.rows.every(r => !r.reviewOption) && !p2.columns.some(c => c.name === '리뷰옵션');
  })());
ok('★ 수량 합계 ≠ 총 건수면 비율 유지 스케일 + 경고(review_mix_scaled)',
  (() => {
    const p = P.buildWorktablePlan({ workOrder: MIX_WO, template: TPL, options: { total: 15 } });
    const c = {};
    p.rows.forEach(r => { c[r.reviewOption] = (c[r.reviewOption] || 0) + 1; });
    return c['포토리뷰'] === 5 && c['텍스트'] === 10 && p.warnings.some(w => w.code === 'review_mix_scaled');
  })());
ok('★ 옵션별 mix(109) — 모든 옵션에 수량이 실려 오면 옵션 묶음 안에서 배분한다',
  (() => {
    const wo = { recruit_count: 30, daily_count: 10, start_date: '2026-08-24',
      product_options_json: JSON.stringify([{ options: [
        { label: 'A', count: 10, review_type_mix: [{ type: 'photo', quantity: 10 }] },
        { label: 'B', count: 20, review_type_mix: [{ type: 'confirm', quantity: 20 }] }] }]) };
    const p = P.buildWorktablePlan({ workOrder: wo, template: TPL });
    return p.rows.filter(r => r.optionKey === 'A').every(r => r.reviewOption === '포토리뷰')
      && p.rows.filter(r => r.optionKey === 'B').every(r => r.reviewOption === '구매확정');
  })());
ok('★★ 시트 표기 왕복 — 리뷰옵션 칸에 적는 표기를 normalizeReviewType 이 정확히 되읽는다(검수 ① 행 우선의 전제)',
  Object.entries(RT.REVIEW_TYPE_SHEET_LABELS).every(([k, label]) => RT.normalizeReviewType(label) === k));
ok('★★ planToSheetValues — 상품옵션과 리뷰옵션이 서로의 칸에 섞이지 않는다',
  (() => {
    const { planToSheetValues } = require('../src/services/worktableCreate.service');
    const wo = { recruit_count: 4, product_options_json: JSON.stringify([{ options: [
      { label: 'A', count: 2, review_type_mix: [{ type: 'photo', quantity: 2 }] },
      { label: 'B', count: 2, review_type_mix: [{ type: 'confirm', quantity: 2 }] }] }]) };
    const p = P.buildWorktablePlan({ workOrder: wo, template: TPL });
    const { header, body, filled } = planToSheetValues(p);
    const iOpt = header.indexOf('옵션'), iRt = header.indexOf('리뷰옵션');
    return filled.reviewOption === true && iOpt >= 0 && iRt >= 0
      && body[0][iOpt] === 'A' && body[0][iRt] === '포토리뷰'
      && body[3][iOpt] === 'B' && body[3][iRt] === '구매확정';
  })());
ok('★ 리뷰옵션 칸은 상품옵션 기입처로 세지 않는다 — no_option_column 경고·duplicate_role 판정에서 제외',
  (() => {
    const t = { core: ['번호', '구매일자', '리뷰옵션', '수취인', '연락처'], channels: {} };   // 상품옵션 칸 없음
    const wo = { recruit_count: 10, review_type_mix: JSON.stringify([{ type: 'photo', quantity: 5 }, { type: 'text', quantity: 5 }]),
      product_options_json: JSON.stringify([{ options: [{ label: 'A' }, { label: 'B' }] }]) };
    const p = P.buildWorktablePlan({ workOrder: wo, template: t });
    /* ★ 2026-08-20: 리뷰옵션 칸만 있으면 상품옵션 칸을 **따로 만든다**(리뷰옵션은 기입처가 아니다).
       종전 기대값(`no_option_column` 경고)은 자동 추가로 대체됐고, 검사의 요지
       "리뷰옵션을 상품옵션으로 세지 않는다"는 그대로다. */
    return p.columns.filter(c => /^(옵션|리뷰옵션)$/.test(c.name)).length === 2 // 역할은 분리하되 두 열은 함께 존재
      && p.columns.some(c => c.name === '옵션' && c.origin === 'system')
      && p.warnings.some(w => w.code === 'option_column_added')
      && !p.warnings.some(w => w.code === 'duplicate_role' && /option/.test(w.message));
  })());
ok('★★ 행배정 매칭은 리뷰옵션 칸을 대조하지 않는다 — 포함하면 상품옵션 매칭이 구조적으로 전패한다',
  (() => {
    const L = require('../src/services/orderLedger.service');
    const headers = ['번호', '구매일자', '리뷰옵션', '옵션', '수취인', '연락처', '주소'];
    const mk = (row, rt, opt) => ({ rowIndex: row, cells: ['', '', rt, opt, '', '', ''] });
    const rows = [mk(2, '포토리뷰', 'A'), mk(3, '텍스트', 'B'), mk(4, '포토리뷰', 'B')];
    const cand = L.buildCandidateRows({ headers, dataRows: rows, headerRowIndex: 1, orderData: { selectedOptKey: 'B' } });
    // B 행(3·4행)이 리뷰옵션 값('텍스트'·'포토리뷰')과 무관하게 먼저 온다
    return cand[0] === 3 && cand[1] === 4;
  })());
ok('★ 미리보기가 리뷰 배분을 그린다(reviewBuckets + 리뷰옵션 칸 — 서버 계획 재계산 금지)',
  (() => {
    const w = readF('workdesk.html');
    return /p\.reviewBuckets/.test(w) && /리뷰 종류 배분/.test(w)
      && /r\.reviewOption\|\|'—'/.test(w);
  })());
ok('★ plan 라우트 SELECT 에 리뷰 배분 재료가 실린다(빠지면 미리보기 ≠ 실제 표)',
  /skip_weekends, holidays, workboard_schema_version,[\s\S]{0,120}work_series_id, work_round, delivery_type, courier_proxy,[\s\S]{0,120}review_type, review_type_mix/.test(routes));
ok('★ 접수 확인창의 휴무일 — 화면에서 안 건드렸으면 계획 값 그대로(빈 배열 = 오더 휴무일 삭제 사고)',
  /Array\.isArray\(f\.holidays\)\?f\.holidays:\(\(_WTP\.plan&&_WTP\.plan\.holidays\)\|\|\[\]\)/.test(readF('workdesk.html')));

console.log(`\n✅ worktablePlan: ${n}개 통과`);
process.exit(0);   // trackB.routes 가 DB 풀 핸들을 열어 프로세스가 안 끝난다(레포 관용구)
