/**
 * campaignQuotaBasis.test.js — 모집 정원 기준 = **시스템표**(사용자 확정 2026-08-07).
 *
 * "기준을 구글시트에서 시스템표로 변경했어" → 시트 구매일자 컬럼(063)은 더 이상 그날 정원·
 * 마감일을 정하지 않는다. 정원 = 일 모집인원 + 날짜별 조절(095) + 이월(066), 총량 = 차수 합계.
 * 시트는 계속 읽지만(주문·검색·행배정) **정원은 안 정한다**.
 *
 * 여기서 고정하는 것:
 *   ① 기본값이 꺼짐 — `CAMPAIGN_SHEET_SCHEDULE=1` 일 때만 시트 일정 엔진이 돈다(되돌리기 수단)
 *   ② 꺼져 있으면 `deriveSchedules` 는 **빈 맵**(= 전 공고가 시스템표 기준)
 *   ③ 관제 진단은 "적용 중"이라고 말하지 않는다 — 날짜는 보여주되 사유는 `system_basis`
 *      (엔진은 무시하는데 화면만 "시트 일정 적용 중"인 상태가 가장 나쁜 거짓 표시)
 *   ④ 화면은 그 사유를 문장으로 말하고, **경고 색으로 칠하지 않는다**(정상 기준이므로)
 * ★ env 는 require 시점에 읽히므로 켬/끔 두 경우를 **자식 프로세스로 각각 실행**해 대조한다.
 * 실행: node tests/campaignQuotaBasis.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src', 'services', 'campaignSchedule.service.js');
const src = fs.readFileSync(SRC, 'utf8');
const rec = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-recruit.js'), 'utf8');

let n = 0;
const ok = (name, cond, extra) => {
  assert(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  n++; console.log('  ✓ ' + name);
};

/* ── ① 기본값 = 꺼짐(시스템표 기준) ── */
ok('★ 기본값이 꺼짐 — `=== \'1\'` 일 때만 시트 일정 엔진이 돈다',
  /const SHEET_SCHEDULE_ENABLED = process\.env\.CAMPAIGN_SHEET_SCHEDULE === '1';/.test(src));
ok('★ 되돌리는 방법이 코드에 적혀 있다(다음 사람이 헤매지 않게)',
  /CAMPAIGN_SHEET_SCHEDULE=1/.test(src) && /시스템표/.test(src));
ok('꺼져 있으면 빈 맵을 돌려준다(전 공고 미적용)',
  /if \(!SHEET_SCHEDULE_ENABLED\) return out;/.test(src));

/* ── ②③ 실제 실행 — 켬/끔 두 경우를 자식 프로세스로 대조 ── */
const HDR = ['번호', '구매일자', '수취인'];
const probe = `
  const SCH = require(${JSON.stringify(SRC)});
  const rows = [
    { row_index: 1, cells: ${JSON.stringify(HDR)} },
    { row_index: 2, cells: ['1', '7 / 30 (목)', 'A'] },
    { row_index: 3, cells: ['2', '7 / 31 (금)', 'B'] },
    { row_index: 4, cells: ['3', '7 / 31 (금)', 'C'] },
  ];
  const db = { query: async (sql, p) => {
    if (/FROM tab_configs/.test(sql)) return { rows: [] };                 // 무시트 아님
    if (/row_index <= /.test(sql)) return { rows };                        // 헤더 스캔
    if (/cells->>/.test(sql)) return { rows: rows.slice(1).map(r => ({ v: r.cells[1] })) };
    return { rows: rows.slice(1).map(r => ({ row_index: r.row_index, cells: r.cells })) };
  } };
  (async () => {
    const m = await SCH.deriveSchedules(db, [{ sheetId: 'S1', tabGid: '123' }]);
    const d = await SCH.describeTabDates(db, 'S1', '123', new Date('2026-07-31T01:00:00Z'));
    process.stdout.write(JSON.stringify({
      mapSize: m.size, sched: m.get('S1::123') ? true : m.get('S1::123'),
      applied: d.applied, reason: d.reason, distinct: d.distinctDates,
    }));
  })();
`;
const run = (env) => JSON.parse(execFileSync(process.execPath, ['-e', probe], {
  env: Object.assign({}, process.env, env), encoding: 'utf8',
}));

const off = run({ CAMPAIGN_SHEET_SCHEDULE: '' });
ok('★★ 기본(시스템표) — deriveSchedules 가 빈 맵', off.mapSize === 0, off);
ok('★★ 기본(시스템표) — 관제는 "적용 중"이라고 말하지 않는다', off.applied === false, off);
ok('★ 사유가 "system_basis"(시트에 날짜는 있으나 기준이 시스템표)', off.reason === 'system_basis', off);
ok('★ 날짜 진단은 그대로 남는다(시트 현황 대조용)', off.distinct === 2, off);

const on = run({ CAMPAIGN_SHEET_SCHEDULE: '1' });
// ★ 여기서 보는 것은 **스위치**다(엔진이 후보를 조회하는가) — 파생 결과의 정확도는
//   campaignSchedule.test.js 가 실제 픽스처로 따로 고정한다.
ok('되돌리면(=1) 시트 일정 엔진이 다시 후보를 조회한다', on.mapSize === 1 && off.mapSize === 0, [off.mapSize, on.mapSize]);
ok('되돌리면 관제도 "적용 중"으로 돌아간다', on.applied === true && on.reason === 'applied', on);

/* ── ④ 화면 — 사유를 말하고, 경고 색으로 칠하지 않는다 ── */
ok('★ 관제 화면이 system_basis 를 문장으로 말한다',
  /system_basis:/.test(rec) && /모집 인원 기준이 시스템표/.test(rec));
ok('★★ system_basis 는 경고(노란 박스)로 몰지 않는다 — 상시 경고면 진짜 신호가 묻힌다',
  /s\.reason !== "system_basis"/.test(rec));
ok('★ 모집 기준 줄을 따로 그린다(미적용 경고 문구로 흘리지 않는다)',
  /s\.reason === "system_basis"/.test(rec) && /<b>모집 기준<\/b> 시스템표/.test(rec));

/* ── 모달·카드는 이미 scheduleDriven 분기를 갖고 있다(사본 금지 — 재확인만) ── */
const cdp = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-daily-plan.js'), 'utf8');
ok('모달의 총량 기준 표기가 분기로 되어 있다(시트 행 수 ↔ 차수 합계)',
  /j\.scheduleDriven === true \? '시트 행 수' : '차수 합계'/.test(cdp));
ok('모달의 기본 표기가 분기로 되어 있다(시트 구매일자 ↔ 일건수)',
  /j\.scheduleDriven === true \? '기본 <b>시트 구매일자 기준<\/b>'/.test(cdp));

console.log(`\n✅ campaignQuotaBasis: ${n}개 통과`);
