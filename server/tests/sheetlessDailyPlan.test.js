/**
 * sheetlessDailyPlan.test.js — 탈 구글시트 W2-b 회귀가드
 * 실행: node tests/sheetlessDailyPlan.test.js
 *
 * 고정하는 것:
 *  A. 무시트 탭은 **시트 일정 파생 대상이 아니다**(D3-a) — 달력이 진실원본이라야 조절 모달이 열린다
 *  B. 작업표 날짜 → 달력 프리필 — 파서 사본 0 · 기존 조절값 보존 · 지난 날짜 제외
 *  C. 공고 발행 배선 — 참여형 + 무시트 연결 탭일 때만 · fail-soft
 *  D. 진행 일정 신호(097) — "안 보냄(NULL)"과 "끔(false)"을 구분한다
 *  E. 계획 계산 우선순위 — 미리보기 조정값 > 작업오더 신호 > 기본값
 *  F. 마이그레이션·프리플라이트 등록(없으면 인트라넷 오더 접수 전면 42703)
 */
// ★ 모집 정원 기준의 기본값은 **시스템표**(2026-08-07 사용자 확정)라 시트 일정 엔진 자체를
//   검증하는 이 파일은 그 엔진을 켜고 돌린다(env 는 require 시점에 읽힌다 — 위에 둘 것).
process.env.CAMPAIGN_SHEET_SCHEDULE = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const srv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const noLineComments = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const dailyPlan = require('../src/services/sheetlessDailyPlan.service');
const { buildWorktablePlan } = require('../src/utils/worktablePlan');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

/* ══════════════ A. 무시트는 시트 일정 파생 제외 ══════════════ */
console.log('\n[A] 무시트 탭은 시트 일정 파생에서 빠진다 (달력이 진실원본)');
(async () => {
  const sched = require('../src/services/campaignSchedule.service');
  sched._clearCache();
  {
    // tab_configs 조회에서 무시트로 나오면 → 그 키는 null(미적용)이고 raw 조회로 내려가지 않는다
    // ★★ 스텁은 SQL 을 해석하지 않으므로 "행이 돌아왔다"만 보면 조건이 반전돼도(= FALSE) 통과한다
    //    → 실제로 나간 SQL 의 술어까지 붙잡는다(변이시험 M1 이 잡은 약한 단언).
    let rawQueries = 0;
    let tcSql = '';
    const db = {
      query: async (sql) => {
        if (/FROM tab_configs/.test(sql)) { tcSql = String(sql); return { rows: [{ sheet_id: 'wt_a', tab_gid: '11' }] }; }
        rawQueries++;
        return { rows: [] };
      },
    };
    const m = await sched.deriveSchedules(db, [{ sheetId: 'wt_a', tabGid: '11' }]);
    ok('무시트 탭은 일정 null(= 미적용 → 조절 모달이 잠기지 않는다)', m.get('wt_a::11') === null);
    ok('무시트 탭은 raw 미러를 읽지도 않는다(불필요한 조회 0)', rawQueries === 0);
    ok('제외 대상은 sheetless=TRUE 인 탭이다(조건 반전 차단)',
      /COALESCE\(sheetless,\s*FALSE\)\s*=\s*TRUE/.test(tcSql));
  }
  sched._clearCache();
  {
    // 시트 기반 탭은 종전대로 raw 를 읽는다(무회귀)
    let rawQueries = 0;
    const db = {
      query: async (sql) => {
        if (/FROM tab_configs/.test(sql)) return { rows: [] };       // 무시트 아님
        rawQueries++;
        return { rows: [] };
      },
    };
    await sched.deriveSchedules(db, [{ sheetId: 'SHEET1', tabGid: '22' }]);
    ok('시트 기반 탭은 종전대로 raw 미러를 읽는다(무회귀)', rawQueries >= 1);
  }
  sched._clearCache();
  {
    // 판정 실패는 fail-open — 게이트가 죽었다고 시트 기반 일정까지 멈추면 안 된다
    let rawQueries = 0;
    const db = {
      query: async (sql) => {
        if (/FROM tab_configs/.test(sql)) throw new Error('db down');
        rawQueries++;
        return { rows: [] };
      },
    };
    await sched.deriveSchedules(db, [{ sheetId: 'SHEET1', tabGid: '22' }]);
    ok('무시트 판정 실패는 fail-open(종전 경로로 진행)', rawQueries >= 1);
  }
  sched._clearCache();

  /* ══════════════ B. 작업표 날짜 → 달력 ══════════════ */
  console.log('\n[B] 작업표 날짜 분배 → 달력 프리필');
  {
    const PARTS = [
      { row_json: { '번호': '1', '구매일자': '2026-08-07', '수취인': '' } },
      { row_json: { '번호': '2', '구매일자': '2026-08-07', '수취인': '' } },
      { row_json: { '번호': '3', '구매일자': '2026-08-10', '수취인': '' } },
    ];
    dailyPlan.__setPoolForTest({ query: async () => ({ rows: PARTS }) });
    const r = await dailyPlan.readWorktableDates({ sheetId: 'wt_a', tabName: 'T1' });
    ok('날짜 컬럼을 찾아 날짜별 행 수를 센다', r.ok && r.byDate['2026-08-07'] === 2 && r.byDate['2026-08-10'] === 1);
    ok('어느 칸을 읽었는지 돌려준다(진단 가능)', r.dateHeader === '구매일자');

    /* ★★★ 실제 작업표가 쓰는 표기로 검증한다 — 위 픽스처(`2026-08-07`)는 **제품이 쓰지 않는 모양**이라
       이 버그를 통과시켰다(프로덕션 E2E 로 실측: 무시트 공고 달력 프리필이 늘 `unparsable`).
       `planToSheetValues` 는 구매일자를 **전부 `M / D (요일)`** 로 쓰므로 열 안에 연도가 하나도 없고,
       `parseDateColumn` 은 앵커가 없으면 전 행 null 을 돌려준다 → `fallbackAnchor` 가 필수다.
       ★ 픽스처를 다시 ISO 로 되돌리면 이 회귀가 그대로 살아난다. */
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const M = kst.getUTCMonth() + 1, D = kst.getUTCDate(), Y = kst.getUTCFullYear();
    const pad = n => String(n).padStart(2, '0');
    dailyPlan.__setPoolForTest({ query: async () => ({ rows: [
      { row_json: { '번호': '1', '구매일자': `${M} / ${D} (월)` } },
      { row_json: { '번호': '2', '구매일자': `${M} / ${D} (월)` } },
    ] }) });
    const rk = await dailyPlan.readWorktableDates({ sheetId: 'wt_a', tabName: 'T1' });
    ok('★★ 연도 없는 "M / D (요일)" 만 있는 열도 오늘을 앵커로 해석한다(작업표 실제 표기)',
      rk.ok === true && rk.byDate[`${Y}-${pad(M)}-${pad(D)}`] === 2,
      JSON.stringify({ ok: rk.ok, reason: rk.reason, byDate: rk.byDate }));

    dailyPlan.__setPoolForTest({ query: async () => ({ rows: [{ row_json: { '이름': '김' } }] }) });
    ok('날짜 칸이 없으면 사유를 말한다', (await dailyPlan.readWorktableDates({ sheetId: 'x', tabName: 'y' })).reason === 'no_date_column');

    dailyPlan.__setPoolForTest({ query: async () => ({ rows: [] }) });
    ok('작업표가 비면 사유를 말한다', (await dailyPlan.readWorktableDates({ sheetId: 'x', tabName: 'y' })).reason === 'no_rows');

    dailyPlan.__setPoolForTest({ query: async () => { throw new Error('boom'); } });
    ok('조회 실패도 사유를 말한다(조용한 성공 위장 금지)',
      (await dailyPlan.readWorktableDates({ sheetId: 'x', tabName: 'y' })).reason === 'query_failed');
  }
  {
    // 프리필 — 지난 날짜 제외 + 이미 있는 날 보존
    const inserts = [];
    let conflictDate = '2026-08-10';
    dailyPlan.__setPoolForTest({
      query: async (sql, params) => {
        if (/FROM campaign_participants/.test(sql)) {
          return { rows: [
            { row_json: { '구매일자': '2026-08-01' } },   // 과거
            { row_json: { '구매일자': '2026-08-07' } },
            { row_json: { '구매일자': '2026-08-10' } },
            { row_json: { '구매일자': '2026-08-10' } },
          ] };
        }
        inserts.push(params);
        return { rowCount: params[1] === conflictDate ? 0 : 1 };   // 이미 조절해 둔 날 = 0행
      },
    });
    const r = await dailyPlan.prefillFromWorktable({
      campaignId: 'c1', sheetId: 'wt_a', tabName: 'T1', today: '2026-08-05', by: '관리자' });
    ok('프리필 성공', r.ok === true);
    ok('지난 날짜는 넣지 않는다(화면에서 지울 수도 없는 행 방지)',
      !inserts.some(p => p[1] === '2026-08-01'));
    ok('앞으로의 날짜만 신규 등록(1일)', r.inserted === 1);
    // ★★ 이미 사람이 조절해 둔 날은 보존 — 공고 수정 한 번에 되돌리면 안 된다
    ok('이미 계획이 있는 날은 유지(ON CONFLICT DO NOTHING → 0행)', r.skipped >= 1);
    const sqlUsed = inserts.length ? true : false;
    ok('그날 행 수를 인원으로 넣는다', sqlUsed && inserts.some(p => p[1] === '2026-08-10' && p[2] === 2));

    const src = noLineComments(srv('src/services/sheetlessDailyPlan.service.js'));
    ok('덮어쓰기 금지(ON CONFLICT DO NOTHING)', /ON CONFLICT \(campaign_id, plan_date\) DO NOTHING/.test(src));
    ok('날짜 컬럼 찾기·파싱은 기존 단일 출처(사본 금지)',
      /findDateColumnIndex/.test(src) && /parseDateColumn/.test(src));
    ok('KST 오늘도 기존 함수 재사용(날짜 규칙 사본 금지)', /kstTodayStr/.test(src));
    ok('구글 API 무접촉', !/sheets\.service|getSpreadsheetMeta/.test(src));
  }
  {
    // 저장 실패는 조용히 넘기지 않는다
    dailyPlan.__setPoolForTest({
      query: async (sql) => {
        if (/FROM campaign_participants/.test(sql)) return { rows: [{ row_json: { '구매일자': '2026-08-07' } }] };
        const e = new Error('relation "campaign_daily_plans" does not exist'); e.code = '42P01'; throw e;
      },
    });
    const r = await dailyPlan.prefillFromWorktable({ campaignId: 'c1', sheetId: 'a', tabName: 'b', today: '2026-08-05' });
    ok('달력 저장 실패는 사유를 올린다(095 미적용 등)', r.ok === false && r.reason === 'insert_failed');
  }
  {
    // ★ 상한 — 비정상 데이터(수년치 날짜)로 달력이 폭발하지 않는다.
    //   MAX_PLAN_DAYS 를 무력화하면 여기서 잡힌다(변이시험 M6).
    // ★ 상한 값을 구현에서 읽어 오면 상한을 무력화해도 기대값이 함께 움직여 통과한다
    //   (동어반복 단언 — 변이시험 M6 이 실제로 통과시켰다) → 값을 여기에 못 박는다.
    const CAP = 400;
    ok('상한 값은 400일로 고정', dailyPlan.MAX_PLAN_DAYS === CAP);
    const many = [];
    const d0 = Date.UTC(2026, 7, 10);                       // 전부 미래 날짜
    for (let i = 0; i < CAP + 25; i++) {
      const d = new Date(d0 + i * 86400000).toISOString().slice(0, 10);
      many.push({ row_json: { '구매일자': d } });
    }
    let insertCount = 0;
    dailyPlan.__setPoolForTest({
      query: async (sql) => {
        if (/FROM campaign_participants/.test(sql)) return { rows: many };
        insertCount++;
        return { rowCount: 1 };
      },
    });
    const r = await dailyPlan.prefillFromWorktable({
      campaignId: 'c1', sheetId: 'wt_a', tabName: 'T1', today: '2026-08-01' });
    ok('상한을 넘는 날짜는 INSERT 하지 않는다', insertCount === CAP);
    ok('상한 초과분은 조용히 사라지지 않고 skipped 에 잡힌다', r.ok === true && r.skipped >= 25);
  }
  {
    // 달력 → 작업표 역동기화: 주말 기본 0명도 수동 증원하면 빈 준비 행이 실제로 그 날짜로 이동한다.
    const updates = [];
    const client = { query: async (sql, params) => {
      if (/FROM campaign_participants/.test(sql)) return { rows: [
        { id: 'a', seq: 1, reviewer_name: null, recipient_name: null, phone8: null, order_submission_id: null, row_json: { '구매일자': '8/18 (화)' } },
        { id: 'b', seq: 2, reviewer_name: null, recipient_name: null, phone8: null, order_submission_id: null, row_json: { '구매일자': '8/18 (화)' } },
        { id: 'fixed', seq: 3, reviewer_name: '기존참여자', recipient_name: '기존참여자', phone8: '12345678', order_submission_id: 'order', row_json: { '구매일자': '8/18 (화)' } },
      ] };
      if (/UPDATE campaign_participants/.test(sql)) { updates.push(params); return { rowCount: 1 }; }
      throw new Error('unexpected sql');
    }};
    const r = await dailyPlan.syncAdjustedPlansToWorktable({
      client, sheetId: 'wt_a', tabName: 'T1', today: '2026-08-15', set: [{ date: '2026-08-15', count: 2 }], by: 'tester' });
    ok('주말 0→2 조절 시 미래의 빈 준비 행 2개를 작업표 날짜로 이동', r.ok && r.moved === 2 && updates.length === 2);
    ok('작업표 날짜는 사람이 읽는 8/15 (토) 표기로 쓴다', updates.every(p => p[2] === '8/15 (토)'));
    ok('참여자·주문이 있는 행은 절대 이동하지 않는다', !updates.some(p => p[0] === 'fixed'));
    const src = noLineComments(srv('src/services/sheetlessDailyPlan.service.js'));
    ok('역동기화는 빈 준비 행만 대상으로 한다', /reviewer_name.*recipient_name.*phone8.*order_submission_id/.test(src));
  }
  {
    // 빈 준비 행이 없는 경우에도 새 행을 만들어 0명 날짜 증원을 실제 작업표에 반영한다.
    const inserts = [];
    const client = { query: async (sql, params) => {
      if (/FROM campaign_participants/.test(sql)) return { rows: [
        { id: 'fixed', seq: 7, tab_gid: 'g1', reviewer_name: '참여자', recipient_name: '참여자', phone8: '12345678', order_submission_id: 'order', row_json: { '번호': '7', '구매일자': '8/18 (화)' } },
      ] };
      if (/INSERT INTO campaign_participants/.test(sql)) { inserts.push(params); return { rowCount: 1 }; }
      if (/UPDATE campaign_participants/.test(sql)) throw new Error('filled row must not be updated');
      throw new Error('unexpected sql');
    }};
    const r = await dailyPlan.syncAdjustedPlansToWorktable({
      client, sheetId: 'wt_a', tabName: 'T1', today: '2026-08-15', set: [{ date: '2026-08-15', count: 2 }], by: 'tester' });
    ok('빈 행이 없어도 0→2 증원은 새 작업표 행 2개를 만든다', r.ok && r.created === 2 && inserts.length === 2);
    ok('새 행은 이어지는 seq와 목표 날짜를 갖는다', inserts[0][3] === 8 && inserts[1][3] === 9 && inserts.every(p => p[4] === '8/15 (토)'));
  }
  {
    // [기본으로]는 조절 후 남은 행 수가 아니라, 처음 조절하기 직전 작업표의 날짜별 행 수로 돌아간다.
    // 그래야 0명 주말을 10명으로 열었다가 해제했을 때 0명으로, 기존 40명을 조절했다가 해제하면 40명으로 복귀한다.
    const written = [];
    const client = { query: async (sql, params) => {
      if (/SELECT row_json FROM campaign_participants/.test(sql)) return { rows: [
        { row_json: { '구매일자': '8/18 (화)' } },
        { row_json: { '구매일자': '8/18 (화)' } },
      ] };
      if (/INSERT INTO campaign_worktable_defaults/.test(sql)) { written.push(params); return { rowCount: 1 }; }
      if (/FROM campaign_worktable_defaults/.test(sql)) return { rows: [
        { date: '2026-08-15', default_count: 0 }, { date: '2026-08-18', default_count: 40 },
      ] };
      throw new Error('unexpected sql');
    }};
    await dailyPlan.captureWorktableDefaults({ client, campaignId: 'c1', sheetId: 'wt_a', tabName: 'T1',
      today: '2026-08-15', dates: ['2026-08-15', '2026-08-18'] });
    ok('기본 복귀 기준은 첫 조절 전 작업표 날짜별 인원으로 기록',
      written.some(p => p[1] === '2026-08-15' && p[2] === 0) && written.some(p => p[1] === '2026-08-18' && p[2] === 2));
    const defaults = await dailyPlan.loadWorktableDefaults({ client, campaignId: 'c1', dates: ['2026-08-15', '2026-08-18'] });
    ok('기본 복귀는 보존된 기준값을 날짜별로 다시 읽는다', defaults.get('2026-08-15') === 0 && defaults.get('2026-08-18') === 40);
  }

  /* ══════════════ C. 공고 발행 배선 ══════════════ */
  console.log('\n[C] 공고 발행 시 프리필 배선');
  {
    const cr = noLineComments(srv('src/routes/campaign.routes.js'));
    ok('참여형 + 연결 탭이 있을 때만 시도', /participation_mode === true && lSheet && lTab/.test(cr));
    ok('무시트 판정은 단일 출처', /sheetlessScope['"]\)\.isSheetless\(pool, lSheet, lTab\)/.test(cr));
    ok('프리필 호출', /prefillFromWorktable\(\{/.test(cr));
    // ★ fail-soft — 달력이 안 채워졌다고 공고 발행을 막으면 안 된다(모달에서 채울 수 있다)
    ok('실패해도 공고 발행은 성공(fail-soft)', /planPrefill = \{ ok: false, reason: 'exception'/.test(cr));
    ok('결과를 응답에 실어 화면이 안다(조용한 누락 금지)', /planPrefill \? \{ planPrefill \}/.test(cr));
  }

  /* ══════════════ D·E. 진행 일정 신호(097) ══════════════ */
  console.log('\n[D] 주말 제외·휴무일 신호 — 안 보냄 vs 끔');
  {
    const WO = { id: 'w1', title: 'T', recruit_count: 6, daily_count: 3, start_date: '2026-08-07' };  // 금요일
    const TPL = { core: ['번호', '구매일자', '수취인'], channels: {}, workTypes: [] };

    const base = buildWorktablePlan({ workOrder: WO, template: TPL, options: {} });
    ok('신호 없음(구버전 인트라넷) = 기본 주말 제외 유지', base.skipWeekends === true);

    const off = buildWorktablePlan({ workOrder: { ...WO, skip_weekends: false }, template: TPL, options: {} });
    ok('작업오더가 "주말 포함"이라고 하면 따른다', off.skipWeekends === false);

    const onFromWo = buildWorktablePlan({ workOrder: { ...WO, skip_weekends: true }, template: TPL, options: {} });
    ok('작업오더가 "주말 제외"라고 해도 따른다', onFromWo.skipWeekends === true);

    // ★ 우선순위 — 미리보기에서 담당자가 고른 값이 작업오더 신호를 이긴다
    const override = buildWorktablePlan({
      workOrder: { ...WO, skip_weekends: false }, template: TPL, options: { skipWeekends: true } });
    ok('미리보기 조정값이 작업오더 신호보다 우선', override.skipWeekends === true);

    // 휴무일 — 작업오더가 준 JSON 문자열도 읽는다
    const hol = buildWorktablePlan({
      workOrder: { ...WO, holidays: JSON.stringify(['2026-08-10']) }, template: TPL, options: {} });
    ok('작업오더 휴무일(JSON 문자열)을 읽는다', hol.holidays.includes('2026-08-10'));
    ok('휴무일에는 구매일이 잡히지 않는다', !hol.rows.some(r => r.dateISO === '2026-08-10'));

    const holOverride = buildWorktablePlan({
      workOrder: { ...WO, holidays: JSON.stringify(['2026-08-10']) }, template: TPL, options: { holidays: [] } });
    ok('미리보기에서 비우면 작업오더 휴무일을 쓰지 않는다(담당자 판단 우선)', holOverride.holidays.length === 0);

    const broken = buildWorktablePlan({ workOrder: { ...WO, holidays: '{{깨짐' }, template: TPL, options: {} });
    ok('깨진 휴무일 값은 조용히 무시(날짜 분배가 통째로 깨지는 것보다 낫다)', broken.holidays.length === 0);
  }
  {
    const or = noLineComments(srv('src/routes/order.routes.js'));
    ok('인트라넷 수신 필드에 합류', /'skip_weekends', 'holidays'/.test(or));
    // ★★ "안 보냄"과 "끔"을 구분 — false 로 접으면 주말 제외가 조용히 꺼진다
    ok('안 보냄(NULL) vs 끔(false) 구분 함수', /function _boolOrNull\(v\) \{/.test(or) && /return null;/.test(or));
    ok('휴무일은 형식 맞는 값만(YYYY-MM-DD)', /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(or));
    ok('수정(PATCH) 경로도 같은 정규화', /f === 'skip_weekends'\) vals\.push\(_boolOrNull/.test(or) &&
      /f === 'holidays'\) vals\.push\(_holidaysJson/.test(or));
    // ★★ INSERT 컬럼 수 ≡ VALUES 자리 수 ≡ 파라미터 수 (컬럼 추가 때 가장 흔히 깨지는 자리)
    const m = or.match(/INSERT INTO work_orders\s*\n\s*\(([\s\S]*?)\)\s*\n\s*VALUES \(([^)]*)\)/);
    ok('INSERT 문을 찾았다', !!m);
    const cols = m[1].split(',').map(s => s.trim()).filter(Boolean).length;
    const vals = m[2].split(',').map(s => s.trim()).filter(Boolean).length;
    ok(`INSERT 컬럼 수 ≡ VALUES 자리 수 (${cols})`, cols === vals);
    const maxPh = Math.max(...m[2].match(/\$(\d+)/g).map(s => parseInt(s.slice(1), 10)));
    ok(`자리표시자 번호가 빠짐없이 이어진다($1..$${maxPh})`,
      new Set(m[2].match(/\$(\d+)/g)).size === maxPh);
  }
  {
    const wc = srv('src/services/worktableCreate.service.js');
    ok('작업오더 로드에 신호 컬럼 포함(안 실으면 계획이 못 본다)', /skip_weekends, holidays/.test(wc));
  }

  /* ══════════════ F. 마이그레이션·프리플라이트 ══════════════ */
  console.log('\n[F] 마이그레이션 · 부팅 프리플라이트');
  {
    const mig = srv('migrations/097_work_order_schedule_signals.sql');
    ok('097 은 컬럼 추가만(백필 0)', /ADD COLUMN IF NOT EXISTS skip_weekends BOOLEAN/.test(mig) &&
      /ADD COLUMN IF NOT EXISTS holidays\s+TEXT/.test(mig));
    // ★ 주석(설명·되돌리기 안내)은 걷어내고 **실행되는 SQL** 만 본다
    const migSql = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    ok('097 에 UPDATE·DELETE·DROP 없음(비파괴)', !/\bUPDATE\b|\bDELETE\b|\bDROP\b/i.test(migSql));
    const idx = srv('index.js');
    // ★ INSERT 목록에 들어가는 컬럼은 없으면 **인트라넷 오더 접수 전면 42703** — 부팅 거부로 막는다
    ok("프리플라이트에 work_orders.skip_weekends 등록", /\['work_orders', 'skip_weekends'\]/.test(idx));
    ok("프리플라이트에 work_orders.holidays 등록", /\['work_orders', 'holidays'\]/.test(idx));
    ok("프리플라이트에 tab_configs.sheetless 등록(096 — 무시트 경로 전면 42703 방지)",
      /\['tab_configs', 'sheetless'\]/.test(idx));
  }

  console.log(`\n총 ${passed}개 통과\n`);
  process.exit(0);
})();
