/**
 * acceptReviewTypeRepair.test.js — 접수 업서트가 "리뷰타입 칸의 배송유형"을 제자리로 옮기는지.
 *
 * 실사고(2026-08-06): 구매확정 작업인데 리뷰검수가 정상 제출을 전건 불량 처리했다.
 * 원인은 `tab_configs.review_type` 에 **배송유형 '실배송'** 이 남아 있어 리뷰타입 판정이
 * null(= 리뷰형 기본)이 된 것. 접수 업서트가 `COALESCE(NULLIF(기존,''), 새값)` 으로
 * **기존 값을 무조건 보존**했기 때문에, 뒤에 들어온 작업오더의 '구매확정'이 그 자리를
 * 영영 덮지 못했다.
 *
 * 고정하는 불변식:
 *   A. 어휘 목록은 utils/reviewType.LEGACY_DELIVERY_VALUES 단일 출처(SQL 에 사본 금지)
 *   B. 배송유형 값이 들어 있던 review_type 만 교체 — **유효한 리뷰타입은 종전대로 보존**
 *   C. 옮겨 담는 delivery_type 은 **blank-only**(접수·관리자가 채운 값을 덮지 않는다)
 *   D. PGTEST_URL 있으면 진짜 PG 로 네 경우 + 멱등을 실행 확인
 *
 * 실행: node tests/acceptReviewTypeRepair.test.js
 *      PGTEST_URL=postgres://... node tests/acceptReviewTypeRepair.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

const { LEGACY_DELIVERY_VALUES, resolveReviewType } = require('../src/utils/reviewType');
const SRC = read('src/routes/order.routes.js');

(async () => {
  /* ═══ A. 단일 출처 ═══ */
  console.log('\nA) 어휘 단일 출처');
  {
    assert.deepStrictEqual(LEGACY_DELIVERY_VALUES, ['실배송', '빈박스', '택배발송대행']);
    assert.ok(/const \{[^}]*\bLEGACY_DELIVERY_VALUES\b[^}]*\} = require\('\.\.\/utils\/reviewType'\)/.test(SRC),
      '접수 라우트가 목록을 utils 에서 가져온다');
    assert.ok(/= ANY\(\$12::text\[\]\)/.test(SRC), '파라미터로 넘긴다');
    // ★ SQL 안에 값을 박아 두면 목록이 늘 때 한쪽만 바뀐다
    const upsert = SRC.slice(SRC.indexOf('INSERT INTO tab_configs'), SRC.indexOf('// 7) 인덱스 빌드'))
      .replace(/--[^\n]*/g, '');   // 주석의 예시 표기는 대상이 아니다(실행되는 SQL 만 본다)
    assert.ok(!/'실배송'|'빈박스'/.test(upsert), '★ 실행되는 SQL 에 어휘 사본 금지');
    assert.ok(/LEGACY_DELIVERY_VALUES,\s*\/\/ \$12/.test(SRC), '$12 로 실제 전달');
    ok('A1: ★ 배송유형 어휘 = utils/reviewType 단일 출처(SQL 사본 0)');

    // 판정 규칙 자체는 그대로 — 이 값들은 리뷰타입이 아니다
    for (const v of LEGACY_DELIVERY_VALUES)
      assert.strictEqual(resolveReviewType({ tabReviewType: v }), null, `${v} = 리뷰타입 아님`);
    ok('A2: 판정 규칙 무변경(배송유형은 여전히 리뷰타입 아님)');
  }

  /* ═══ B·C. SQL 형태 ═══ */
  console.log('\nB) 업서트 형태 — 교체는 배송유형 값에만, 이관은 blank-only');
  {
    const upsert = SRC.slice(SRC.indexOf('ON CONFLICT (sheet_id, tab_name) DO UPDATE SET'),
      SRC.indexOf('updated_at    = NOW()`'));
    assert.ok(/review_type\s*=\s*CASE WHEN tab_configs\.review_type = ANY\(\$12::text\[\]\)[\s\S]{0,120}THEN EXCLUDED\.review_type/.test(upsert),
      '★ 배송유형 값이면 작업오더 값으로 교체');
    assert.ok(/ELSE COALESCE\(NULLIF\(tab_configs\.review_type,''\), EXCLUDED\.review_type\) END/.test(upsert),
      '★★ 그 밖에는 종전 그대로 — 유효한 리뷰타입·관리자 설정을 덮지 않는다');
    assert.ok(/delivery_type = COALESCE\(NULLIF\(tab_configs\.delivery_type,''\),/.test(upsert),
      '★ 이관은 blank-only — 기존 delivery_type 이 최우선');
    assert.ok(/NULLIF\(CASE WHEN tab_configs\.review_type = ANY\(\$12::text\[\]\)[\s\S]{0,120}ELSE '' END, ''\),[\s\S]{0,60}EXCLUDED\.delivery_type\)/.test(upsert),
      '옮겨 담을 값이 없으면 작업오더 값으로 폴백');
    // 다른 메타는 손대지 않았다(범위 확산 금지)
    for (const c of ['tab_gid', 'sheet_url', 'campaign_name', 'display_name', 'manager', 'time_range'])
      assert.ok(new RegExp(`${c}\\s*=\\s*COALESCE\\(NULLIF\\(tab_configs\\.${c},''\\)`).test(upsert),
        `${c} 는 종전 보존 규칙 그대로`);
    ok('B1: ★★ 교체는 배송유형 값에만 · 이관 blank-only · 다른 메타 무변경');
  }

  /* ═══ D. 진짜 PG ═══ */
  if (!process.env.PGTEST_URL) {
    console.log('\n(PGTEST_URL 없음 — 진짜 PG 실행 검증 생략)');
  } else {
    console.log('\nD) 진짜 PG — 네 경우 + 멱등');
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.PGTEST_URL });
    await c.connect();
    const T = 'tc_' + Math.abs(Date.now() % 100000);
    await c.query(`CREATE TEMP TABLE ${T}(
      sheet_id TEXT, tab_name TEXT, tab_gid TEXT, sheet_url TEXT, campaign_name TEXT, display_name TEXT,
      manager TEXT, time_range TEXT, review_type TEXT DEFAULT '', delivery_type TEXT DEFAULT '',
      taekhap BOOLEAN, updated_at TIMESTAMPTZ, PRIMARY KEY (sheet_id, tab_name))`);
    // 구현의 SET 절을 **소스에서 그대로 떼어** 쓴다(사본을 만들면 검증 의미가 없다)
    const setClause = SRC
      .slice(SRC.indexOf('ON CONFLICT (sheet_id, tab_name) DO UPDATE SET'), SRC.indexOf('updated_at    = NOW()`'))
      .replace('ON CONFLICT (sheet_id, tab_name) DO UPDATE SET', '')
      .replace(/tab_configs\./g, `${T}.`)
      .replace(/--[^\n]*/g, '')
      .replace(/\$12::text\[\]/g, '$5::text[]');   // 이 테스트 쿼리의 자리표시자 번호로만 치환
    const upsert = (rows, ord) => c.query(
      `INSERT INTO ${T}(sheet_id,tab_name,tab_gid,sheet_url,campaign_name,display_name,
                        manager,time_range,review_type,delivery_type,taekhap,updated_at)
       VALUES ($1,$2,'g','u','c','d','m','t',$3,$4,false,NOW())
       ON CONFLICT (sheet_id,tab_name) DO UPDATE SET ${setClause} updated_at = NOW()`,
      [rows[0], rows[1], ord[0], ord[1], LEGACY_DELIVERY_VALUES]);

    const seed = async (tab, rt, dt) =>
      c.query(`INSERT INTO ${T}(sheet_id,tab_name,review_type,delivery_type) VALUES ('S',$1,$2,$3)`, [tab, rt, dt]);
    const get = async (tab) =>
      (await c.query(`SELECT review_type rt, delivery_type dt FROM ${T} WHERE tab_name=$1`, [tab])).rows[0];

    await seed('A', '실배송', '');          // 사고 케이스
    await seed('B', '실배송', '빈박스');    // delivery_type 이미 있음
    await seed('C', '포토', '');            // 유효한 리뷰타입
    await seed('D', '', '');                // 빈 값
    for (const t of ['A', 'B', 'C', 'D']) await upsert(['S', t], ['구매확정', '실배송']);

    assert.deepStrictEqual(await get('A'), { rt: '구매확정', dt: '실배송' },
      '★★ 사고 케이스 — 리뷰타입이 구매확정으로 교체되고 실배송은 배송유형으로 이관');
    assert.deepStrictEqual(await get('B'), { rt: '구매확정', dt: '빈박스' },
      '★ 기존 delivery_type 은 절대 덮지 않는다(blank-only)');
    assert.deepStrictEqual(await get('C'), { rt: '포토', dt: '실배송' },
      '★★ 유효한 리뷰타입은 보존(관리자 설정을 2차 접수가 덮지 않는다는 기존 계약)');
    assert.deepStrictEqual(await get('D'), { rt: '구매확정', dt: '실배송' }, '빈 값은 종전대로 채움');
    ok('D1: ★★ 네 경우 전부 의도대로(진짜 PG16 실행)');

    // 작업오더에 리뷰타입이 없으면 → 리뷰타입은 비고, 배송유형만 제자리로
    await seed('E', '실배송', '');
    await upsert(['S', 'E'], ['', '']);
    assert.deepStrictEqual(await get('E'), { rt: '', dt: '실배송' },
      '★ 값이 없으면 지어내지 않는다 — 리뷰타입은 미지정, 잘못 든 값만 제자리로');
    ok('D2: ★ 작업오더 리뷰타입 미기재 = 미지정(추측 금지)');

    // 멱등 — 두 번 더 돌려도 같은 결과
    for (let i = 0; i < 2; i++) await upsert(['S', 'A'], ['구매확정', '실배송']);
    assert.deepStrictEqual(await get('A'), { rt: '구매확정', dt: '실배송' }, '재접수 반복에도 불변');
    ok('D3: 멱등(차수 추가 재접수 반복 안전)');

    // 판정까지 이어지는지 — 이 값이면 검수가 구매확정으로 본다
    const a = await get('A');
    assert.strictEqual(resolveReviewType({ tabReviewType: a.rt }), 'confirm',
      '★★ 결과값이 실제로 confirm 으로 판정된다(= 구매확정 화면이 통과한다)');
    ok('D4: ★★ 교체 결과가 검수 판정까지 이어진다');

    await c.end();
  }

  console.log(`\n✅ acceptReviewTypeRepair 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
