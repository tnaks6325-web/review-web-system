/**
 * jsonbCellsIndex.test.js — RAW 미러 셀 인덱싱 SQL 회귀가드.
 *
 * ★★ 실측 사고: `SELECT cells->>$3` 에 정수 캐스트가 없으면 PostgreSQL이
 *   `jsonb ->> text`(객체 키 조회)로 해석한다. `raw_sheet_rows.cells` 는 **JSONB 배열**이라
 *   객체 키 조회는 에러가 아니라 **모든 행 NULL** 을 돌려준다.
 *   → 시트 일정 자동 인식(063)이 "날짜를 해석하지 못함"으로 보이며 **무음으로 꺼져 있었다.**
 *
 * ★ 이 결함은 **스텁 DB 테스트로는 절대 잡히지 않는다**(스텁은 SQL을 해석하지 않는다).
 *   그래서 PostgreSQL이 있으면 진짜로 실행해 검증하고, 없으면 SQL 문자열의 캐스트 존재를
 *   최소한으로 고정한다.
 *
 * 실행: node tests/jsonbCellsIndex.test.js
 *   (선택) PG 실행 검증: PGTEST_URL=postgres://... node tests/jsonbCellsIndex.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'campaignSchedule.service.js'), 'utf8');
// 주석에도 이 패턴을 설명으로 적어두므로, 검사는 **실제 SQL만** 대상으로 한다(주석 줄 제거).
const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/* ═══ 정적 가드 — 캐스트가 빠지면 즉시 실패 ═══ */
const uses = code.match(/cells->>\$\d+(::int)?/g) || [];
ok('cells 인덱싱 SQL이 존재한다', uses.length >= 2);
ok('★★ 모든 cells 인덱싱에 ::int 캐스트가 있다(빠지면 전 행 NULL)',
  uses.every(u => u.endsWith('::int')));
ok('왜 필요한지 코드에 남아 있다(다음 사람이 지우지 않도록)',
  /jsonb ->> text.*객체 키 조회|객체 키 조회\)로 해석/.test(src) && /모든 행이 NULL|전 행 NULL/.test(src));
// ⚠ 2026-08-07 사용자 확정으로 **기본값이 뒤집혔다** — 모집 정원 기준은 시스템표이고,
//   시트 일정 엔진은 `CAMPAIGN_SHEET_SCHEDULE=1` 일 때만 켜진다(스위치 자체는 그대로 존재).
ok('스위치(CAMPAIGN_SHEET_SCHEDULE=1) — 시트 일정 엔진을 되살릴 수단',
  /process\.env\.CAMPAIGN_SHEET_SCHEDULE === '1'/.test(src)
  && /if \(!SHEET_SCHEDULE_ENABLED\) return out;/.test(src));

/* ═══ 파서는 실제 시트 표기를 처리한다(사고 당시 형식) ═══ */
const { parseDateColumn } = require('../src/utils/koreanDate');
{
  const parsed = parseDateColumn(Array(5).fill('7 / 31 (금)'), { fallbackAnchor: { y: 2026, m: 7 } });
  ok('시트 실제 표기 "7 / 31 (금)" 는 원래 파싱된다 — 문제는 파서가 아니라 SQL이었다',
    parsed.every(d => d === '2026-07-31'));
}

/* ═══ 진짜 PostgreSQL 실행 검증(가능할 때만) ═══ */
(async () => {
  const url = process.env.PGTEST_URL;
  if (!url) {
    console.log('  · PGTEST_URL 미설정 — PG 실행 검증은 건너뜀(정적 가드만 수행)');
    console.log(`\n✅ jsonbCellsIndex: ${n}개 통과`);
    return;
  }
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE TEMP TABLE _t (row_index int, cells jsonb)`);
    await c.query(`INSERT INTO _t VALUES (1,'["번호","구매일자","수취인"]'::jsonb),(2,'["1","7 / 31 (금)","김서준"]'::jsonb)`);

    const bad = await c.query(`SELECT cells->>$1 AS v FROM _t ORDER BY row_index`, ['1']);
    ok('★★ (재현) 캐스트 없으면 배열이 전부 NULL 로 읽힌다', bad.rows.every(r => r.v === null));

    const good = await c.query(`SELECT cells->>$1::int AS v FROM _t ORDER BY row_index`, ['1']);
    ok('★★ ::int 캐스트면 배열 원소가 제대로 읽힌다',
      good.rows[0].v === '구매일자' && good.rows[1].v === '7 / 31 (금)');
  } finally {
    await c.end();
  }
  console.log(`\n✅ jsonbCellsIndex: ${n}개 통과`);
})();
