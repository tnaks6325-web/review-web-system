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
    return p.columns.length === 2 && p.columns.filter(c => c.name === '쿠팡ID').length === 1;
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
    const k = P.optionKeysFromWorkOrder({ product_options_json: JSON.stringify([{ options: [{ label: '옵션 없음' }, { label: '해당없음' }, { label: '레드' }] }]) });
    return k.length === 1 && k[0] === '레드';
  })());
ok('깨진 옵션 JSON 은 옵션 없음으로 수렴(fail-soft)',
  P.optionKeysFromWorkOrder({ product_options_json: '{깨짐' }).length === 0);
ok('행마다 옵션이 배정된다', plan.rows[0].optionKey === '골라담기' && plan.rows[99].optionKey === '어나더');

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
ok('옵션은 나눴는데 옵션 열이 없으면 경고(조용한 누락 금지)',
  P.buildWorktablePlan({ workOrder: { recruit_count: 6 }, template: { core: ['수취인'], channels: {} }, options: { options: ['A', 'B'] } })
    .warnings.some(w => w.code === 'no_option_column'));
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
ok('작업오더 행에 [작업표] 버튼(접수·상태변경과 같은 편집 게이트)',
  // ★ id 는 `const id=esc(o.id)` 로 한 번만 escape 해 네 버튼이 나눠 쓴다(배선 형태 변경 — 검사 의미 불변)
  /openWtPlan\('\$\{id\}'\)/.test(wdesk)
  && /function _woEditActions\(o\)\{[\s\S]{0,900}openWtPlan/.test(wdesk));
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
ok('★ 생성 버튼은 아직 잠겨 있고 그 사실을 화면이 말한다(반쯤 되는 기능으로 오인 금지)',
  /이 구성으로 만들기<\/button>/.test(wdesk)
  && /확인용 미리보기<\/b>입니다/.test(wdesk));
ok('표준 열 미설정이면 어디서 정하는지 안내한다',
  /설정 › 작업표 표준 열<\/b>에서 먼저 정하세요/.test(wdesk));

console.log(`\n✅ worktablePlan: ${n}개 통과`);
process.exit(0);   // trackB.routes 가 DB 풀 핸들을 열어 프로세스가 안 끝난다(레포 관용구)
