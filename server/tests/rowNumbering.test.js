/**
 * rowNumbering.test.js — 회귀가드: 작업표 `번호`·`담당자` 자동 채움 + 구매일자 기준 재번호
 * 실행: node tests/rowNumbering.test.js
 *
 * 배경(2026-08-19 「0729)위드프렌즈_면마스크」 실측): 준비된 줄을 다 쓰면 주문이 들어올 때
 *   줄이 이어붙는데(`appendSlot`, row_json = {}) 매퍼가 `번호`·`담당자` 칸을 쓰지 않아
 *   그 줄은 영구히 빈칸이었다. 게다가 뒤늦게 도착한 지난 날짜 주문이 맨 아래에 남았다.
 *
 * 고정하는 것:
 *  A. 정렬 규칙(사용자 확정) — 구매일자 → 주문 제출 시각 → seq / 날짜 없는 줄은 맨 아래
 *  B. 번호는 표시 칸만 — DB `seq` 를 바꾸는 쓰기가 없다(주문·리뷰·입금·투영 앵커 보호)
 *  C. 담당자는 blank-only · 담당자 값이 없으면 안 채운다
 *  D. 무시트 탭만(fail-closed) · 미리보기는 쓰기 0
 *  E. 자동 경로는 SAVEPOINT 격리 + 절대 throw 없음(주문 기록을 죽이지 않는다)
 *  F. 판정 사본 0(날짜 칸·파서·순서 규칙) · fallbackAnchor 필수
 *  G. 라우트·화면 배선
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const U = require('../src/utils/rowNumbering');
const S = require('../src/services/rowNumbering.service');

function makePool(shapes) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      for (const [re, res] of shapes) if (re.test(sql)) return typeof res === 'function' ? res(params) : res;
      return { rows: [], rowCount: 0 };
    },
  };
}

console.log('\n[A] 정렬 규칙 — 구매일자 → 주문 제출 시각 → seq / 날짜 없는 줄 맨 아래');
{
  const rows = [
    { id: 'a', seq: 145, iso: '2026-08-18', submittedAt: '2026-08-18T01:00:00Z' },
    { id: 'b', seq: 300, iso: '2026-08-05', submittedAt: '2026-08-05T05:00:00Z' },  // 뒤늦게 이어붙은 8/5 건
    { id: 'c', seq: 146, iso: '2026-08-19', submittedAt: '2026-08-19T02:00:00Z' },
    { id: 'd', seq: 147, iso: '2026-08-19', submittedAt: '2026-08-19T01:00:00Z' },  // 같은 날 · 더 이른 제출
    { id: 'e', seq: 148, iso: '2026-08-19', submittedAt: null },                    // 같은 날 · 빈 슬롯
    { id: 'f', seq: 200, iso: null, submittedAt: null },                            // 날짜 판독 불가
  ];
  const order = U.orderRowsForNumbering(rows).map(r => r.id).join('');
  ok('★ 8/5 건이 8/18(145번) 앞으로 온다', order.indexOf('b') < order.indexOf('a'), order);
  ok('★ 같은 날짜는 제출 시각 순(d → c)', order.indexOf('d') < order.indexOf('c'), order);
  ok('★ 같은 날짜의 빈 슬롯은 주문 있는 줄 뒤', order.indexOf('e') > order.indexOf('c'), order);
  ok('★ 날짜를 읽을 수 없는 줄은 맨 아래', order[order.length - 1] === 'f', order);
  ok('전체 순서 = b,a,d,c,e,f', order === 'badcef', order);

  // 안정 정렬(다시 돌려도 같은 결과 = 번호가 흔들리지 않는다)
  const again = U.orderRowsForNumbering(U.orderRowsForNumbering(rows)).map(r => r.id).join('');
  ok('★ 다시 돌려도 순서가 같다(안정 정렬)', again === order);

  const plan = U.computeRenumberPlan(rows, { hasNumberCol: true });
  const byId = Object.fromEntries(plan.ordered.map((r, i) => [r.id, i + 1]));
  ok('★ 145번(8/18)이 146번으로 밀린다', byId.a === 2 && byId.b === 1, JSON.stringify(byId));
}

console.log('\n[A2] 지나간 날짜의 빈 줄은 표 맨 아래(사용자 확정 2026-08-19 — 든든푸드 쭈꾸미)');
{
  const rows = [
    { id: 'p1', seq: 10, iso: '2026-06-08', submittedAt: '2026-06-08T01:00:00Z', filled: true },
    { id: 'pb', seq: 11, iso: '2026-06-08', submittedAt: null, filled: false },   // 지나간 날짜의 빈 줄
    { id: 'p2', seq: 12, iso: '2026-06-09', submittedAt: '2026-06-09T01:00:00Z', filled: true },
    { id: 'fb', seq: 13, iso: '2026-08-25', submittedAt: null, filled: false },   // 미래의 빈 자리(모집 계획)
    { id: 'nd', seq: 14, iso: null, submittedAt: null, filled: false },           // 날짜 판독 불가
  ];
  const today = '2026-08-19';
  const order = U.orderRowsForNumbering(rows, { today }).map(r => r.id).join(',');
  ok('★ 지나간 날짜의 빈 줄이 채워진 줄 뒤로 밀린다',
     order.indexOf('pb') > order.indexOf('p2'), order);
  ok('★ 미래의 빈 자리는 제자리(밀리지 않는다)',
     order.indexOf('fb') < order.indexOf('pb'), order);
  ok('★ 날짜 없는 줄은 여전히 맨 끝(④ 불변)',
     order.split(',').pop() === 'nd', order);
  ok('전체 순서 = p1,p2,fb,pb,nd', order === 'p1,p2,fb,pb,nd', order);

  // ★★ `today` 를 안 주면 종전 동작 그대로(무회귀) — 이 파일은 시계를 보지 않는다
  const legacy = U.orderRowsForNumbering(rows).map(r => r.id).join(',');
  ok('★ today 미전달 = 종전 규칙(지난 빈 줄이 제자리)', legacy === 'p1,pb,p2,fb,nd', legacy);

  // ★ 오늘 날짜의 빈 줄은 밀지 않는다(아직 지나가지 않았다)
  const t2 = U.orderRowsForNumbering(
    [{ id: 'x', seq: 1, iso: '2026-08-19', filled: false }, { id: 'y', seq: 2, iso: '2026-08-19', filled: true, submittedAt: '2026-08-19T01:00:00Z' }],
    { today }).map(r => r.id).join(',');
  ok('★ 오늘 날짜의 빈 줄은 밀지 않는다', t2 === 'y,x', t2);

  // ★ 지나간 날짜라도 **채워진 줄**은 절대 밀지 않는다(주문·참여가 붙은 줄)
  const t3 = U.orderRowsForNumbering(
    [{ id: 'old', seq: 1, iso: '2026-06-01', filled: true }, { id: 'new', seq: 2, iso: '2026-08-18', filled: true }],
    { today }).map(r => r.id).join(',');
  ok('★ 지나간 날짜라도 채워진 줄은 제자리', t3 === 'old,new', t3);

  // 계획으로도 반영된다(번호가 실제로 뒤로 간다)
  const plan = U.computeRenumberPlan(rows, { hasNumberCol: true, today });
  const byId = Object.fromEntries(plan.ordered.map((r, i) => [r.id, i + 1]));
  ok('★ 지난 빈 줄의 번호가 마지막 직전으로 간다', byId.pb === 4 && byId.nd === 5, JSON.stringify(byId));
}

console.log('\n[B] 바뀌는 줄만 · 같은 값 재기록 없음');
{
  const rows = [
    { id: 'a', seq: 2, iso: '2026-08-01', number: '1' },
    { id: 'b', seq: 3, iso: '2026-08-02', number: '' },
  ];
  const plan = U.computeRenumberPlan(rows, { hasNumberCol: true });
  ok('이미 맞는 번호는 계획에 없다', !plan.changes.some(c => c.id === 'a'), JSON.stringify(plan.changes));
  ok('빈 번호는 채운다', plan.changes.some(c => c.id === 'b' && c.numberTo === '2'));
  ok('번호 칸이 없으면 번호를 바꾸지 않는다',
    U.computeRenumberPlan(rows, { hasNumberCol: false }).changes.length === 0);
}

console.log('\n[C] 담당자 — 번호 정리는 담당자 칸을 건드리지 않는다(사용자 확정 2026-08-19)');
{
  /* 담당자는 작업보드 좌측 상단 [작업 조건]에 이미 있으므로 줄마다 반복할 이유가 없다.
     ★ 이미 적혀 있는 값도 그대로 둔다 — 여기서 담당자를 쓰기 시작하면 그 규칙이 두 곳이 된다. */
  const rows = [
    { id: 'a', seq: 2, iso: '2026-08-01', number: '1', manager: '만두' },
    { id: 'b', seq: 3, iso: '2026-08-02', number: '2', manager: '' },
  ];
  const plan = U.computeRenumberPlan(rows, { hasNumberCol: true, hasManagerCol: true, manager: '망고' });
  ok('★★ 담당자만 비어 있는 줄은 변경 대상이 아니다', plan.changes.length === 0, JSON.stringify(plan.changes));
  /* ★ 변경이 0건이면 "담당자 필드가 없다"는 공허하게 참이다(변이시험 실측) →
       **번호가 실제로 바뀌는 계획**을 만들어 그 change 객체를 본다. */
  const moved = U.computeRenumberPlan([
    { id: 'x', seq: 9, iso: '2026-08-01', number: '', manager: '' },
  ], { hasNumberCol: true, hasManagerCol: true, manager: '망고' });
  ok('번호가 바뀌는 계획이 만들어진다(단언 전제)', moved.changes.length === 1, JSON.stringify(moved.changes));
  ok('★★ 그 계획에도 담당자 필드가 없다',
    !JSON.stringify(moved.changes).includes('manager') && Object.keys(moved.changes[0]).join(',') === 'id,seq,numberFrom,numberTo',
    Object.keys(moved.changes[0]).join(','));
  const src = noLineComments(read('src/utils/rowNumbering.js'));
  ok('★ 담당자 칸 판정 자체를 두지 않는다(죽은 규칙 금지)', !/MANAGER_KEY|managerColumnKey/.test(src));
}

console.log('\n[D] 서비스 — 무시트 게이트 · 미리보기 쓰기 0 · seq 무접촉');
(async () => {
  const roster = [
    { id: '11111111-1111-1111-1111-111111111111', seq: 2, row_json: { '번호': '1', '구매일자': '8 / 18 (화)', '담당자': '망고', '수취인': '김분선' }, submitted_at: '2026-08-18T01:00:00Z' },
    { id: '22222222-2222-2222-2222-222222222222', seq: 3, row_json: { '번호': '', '구매일자': '8 / 5 (수)', '담당자': '', '수취인': '장혜은' }, submitted_at: '2026-08-05T05:00:00Z' },
  ];
  const shapes = [
    [/FROM tab_configs/i, { rows: [{ sheetless: true }] }],
    [/FROM campaign_participants p/i, { rows: roster }],
    [/UPDATE campaign_participants/i, { rows: [], rowCount: 2 }],
  ];

  // ── 무시트가 아니면 거부 + 쓰기 0
  {
    const pool = makePool([[/FROM tab_configs/i, { rows: [{ sheetless: false }] }]]);
    S.__setPoolForTest(pool);
    const r = await S.renumberTab({ sheetId: 's', tabName: 't' });
    ok('★ 시트 기반 탭은 not_sheetless 로 거부', r.ok === false && r.reason === 'not_sheetless');
    ok('★ 거부 시 쓰기 쿼리 0', !pool.calls.some(c => /^(UPDATE|INSERT|DELETE)\b/i.test(c.sql)));
  }
  // ── 미등록 탭
  {
    S.__setPoolForTest(makePool([[/FROM tab_configs/i, { rows: [] }]]));
    const r = await S.renumberTab({ sheetId: 's', tabName: 't' });
    ok('미등록 탭은 tab_not_registered', r.ok === false && r.reason === 'tab_not_registered');
  }
  // ── 미리보기(dryRun) = 쓰기 0
  {
    const pool = makePool(shapes); S.__setPoolForTest(pool);
    const r = await S.renumberTab({ sheetId: 's', tabName: 't', dryRun: true });
    ok('미리보기 ok + 바뀌는 줄 수 보고', r.ok === true && r.dryRun === true && r.changed === 2, JSON.stringify(r));
    ok('★ 미리보기는 쓰기 쿼리 0', !pool.calls.some(c => /^(UPDATE|INSERT|DELETE)\b/i.test(c.sql)));
    ok('★ 8/5 줄이 1번이 된다(구매일자 순)',
      r.sample.some(x => x.seq === 3 && x.to === '1') && r.sample.some(x => x.seq === 2 && x.to === '2'),
      JSON.stringify(r.sample));
  }
  // ── 실행
  {
    const pool = makePool(shapes); S.__setPoolForTest(pool);
    const r = await S.renumberTab({ sheetId: 's', tabName: 't', by: 'tester' });
    ok('실행하면 바뀐 줄 수를 돌려준다', r.ok === true && r.changed === 2, JSON.stringify(r));
    const upd = pool.calls.filter(c => /UPDATE/i.test(c.sql));
    ok('★ UPDATE 는 한 문장(줄 수만큼 왕복하지 않는다)', upd.length === 1, String(upd.length));
    ok('★★ seq 를 바꾸는 쓰기가 없다(주문·리뷰·입금·투영 앵커 보호)',
      !/SET[\s\S]*\bseq\s*=/i.test(upd[0].sql), upd[0].sql.slice(0, 200));
    ok('★ 쓰는 것은 row_json(+updated_*) 뿐',
      /SET\s+row_json\s*=/.test(upd[0].sql) && !/(reviewer_name|phone8|order_submission_id|is_paid|is_submitted)\s*=/i.test(upd[0].sql));
    ok('★★ 담당자 칸을 쓰지 않는다(UPDATE 는 번호 칸 하나만 세팅)',
      (upd[0].sql.match(/jsonb_set/g) || []).length === 1, upd[0].sql.slice(0, 200));
    ok('★ 대상은 활성 줄만', /deleted_at IS NULL/.test(upd[0].sql) && /active = TRUE/.test(upd[0].sql));
    ok('번호 칸 이름은 표에서 찾은 값을 쓴다', upd[0].params[2] === '번호');
  }
  // ── ⑤ 지나간 날짜의 빈 줄은 맨 아래(서비스 배선: filled + today 를 실제로 넘기는가)
  {
    const past = [
      { id: 'aaaaaaaa-1111-1111-1111-111111111111', seq: 1, filled: true,  submitted_at: '2026-06-08T01:00:00Z',
        row_json: { '번호': '1', '구매일자': '6 / 8 (월)', '수취인': '니징' } },
      { id: 'bbbbbbbb-2222-2222-2222-222222222222', seq: 2, filled: false, submitted_at: null,
        row_json: { '번호': '2', '구매일자': '6 / 8 (월)', '수취인': '' } },   // 지나간 날짜의 빈 줄
      { id: 'cccccccc-3333-3333-3333-333333333333', seq: 3, filled: true,  submitted_at: '2026-06-09T01:00:00Z',
        row_json: { '번호': '3', '구매일자': '6 / 9 (화)', '수취인': '박' } },
    ];
    const pool = makePool([
      [/FROM tab_configs/i, { rows: [{ sheetless: true }] }],
      [/FROM campaign_participants p/i, { rows: past }],
    ]);
    S.__setPoolForTest(pool);
    const r = await S.renumberTab({ sheetId: 's', tabName: 't', dryRun: true });
    const to = Object.fromEntries(r.sample.map(x => [x.seq, x.to]));
    ok('★★ 서비스도 지난 빈 줄을 맨 아래로 민다(seq2 → 3번)', to[2] === '3', JSON.stringify(r.sample));
    const sel = pool.calls.find(c => /FROM campaign_participants p/i.test(c.sql));
    ok('★★ 빈 줄 판정은 SQL 단일 출처(FILLED_SQL)를 그대로 읽는다',
      /AS filled/i.test(sel.sql) && /order_submission_id IS NOT NULL/i.test(sel.sql), sel.sql.slice(0, 300));
  }
  // ── 번호·담당자 칸이 아예 없는 표
  {
    S.__setPoolForTest(makePool([
      [/FROM tab_configs/i, { rows: [{ sheetless: true }] }],
      [/FROM campaign_participants p/i, { rows: [{ id: 'x', seq: 2, row_json: { '수취인': 'A' }, submitted_at: null }] }],
    ]));
    const r = await S.renumberTab({ sheetId: 's', tabName: 't' });
    ok('★ 없는 칸을 새로 만들지 않는다', r.ok === true && r.reason === 'no_target_column');
  }
  // ── 킬스위치
  {
    process.env.WORKTABLE_AUTO_NUMBER = '0';
    const r = await S.renumberTab({ sheetId: 's', tabName: 't' });
    ok('킬스위치 WORKTABLE_AUTO_NUMBER=0 이면 즉시 중단', r.ok === false && r.reason === 'disabled');
    delete process.env.WORKTABLE_AUTO_NUMBER;
  }

  console.log('\n[E] 자동 경로 — SAVEPOINT 격리 · 절대 throw 없음');
  {
    const seen = [];
    const client = { query: async (sql) => { seen.push(String(sql)); if (/FROM tab_configs/i.test(sql)) throw Object.assign(new Error('boom'), { code: '42703' }); return { rows: [], rowCount: 0 }; } };
    let threw = false;
    let out;
    try { out = await S.renumberTabInTx(client, { sheetId: 's', tabName: 't' }); } catch (e) { threw = true; }
    ok('★★ 실패해도 throw 하지 않는다(주문 기록을 죽이지 않는다)', !threw && out && out.ok === false);
    /* ★ "SAVEPOINT 문자열이 있나" 로 보면 ROLLBACK TO SAVEPOINT 가 대신 통과시킨다(변이시험 실측)
         → **첫 쿼리가 SAVEPOINT 선언 자체**인지 본다. */
    ok('★★ SAVEPOINT 로 격리한다(첫 쿼리가 SAVEPOINT 선언)', /^\s*SAVEPOINT rn_renumber\s*$/.test(seen[0] || ''), seen[0]);
    ok('★★ 실패하면 그 SAVEPOINT 로만 롤백한다', seen.some(s => /ROLLBACK TO SAVEPOINT rn_renumber/.test(s)));
    ok('★ 트랜잭션 전체를 ROLLBACK 하지 않는다', !seen.some(s => /^\s*ROLLBACK\s*$/.test(s)));
  }

  console.log('\n[F] 판정 사본 0 · fallbackAnchor 필수');
  {
    const svc = read('src/services/rowNumbering.service.js');
    ok('★★ 서비스는 오늘 날짜만 넘기고 판정은 util 이 한다(사본 0)',
      /today:\s*todayIso/.test(svc) && !/iso\s*<\s*today/.test(svc), 'service 에 지난날짜 판정 사본 금지');
    /* ★ 함수 **본문**으로 본다 — 머리말 주석에 'Date.now()' 라는 글자가 있어 파일 전체 검사는 못 쓴다. */
    const bodies = String(U.orderRowsForNumbering) + String(U.computeRenumberPlan);
    ok('★ util 은 여전히 시계를 보지 않는다(결정적)', !/Date\.now\(|new Date\(\)/.test(bodies));
  }
  {
    const src = noLineComments(read('src/services/rowNumbering.service.js'));
    ok('★ 날짜 칸 찾기는 campaignSchedule.findDateColumnIndex 재사용',
      /findDateColumnIndex/.test(src) && !/DATE_HEADER_KEYWORDS\s*=/.test(src));
    ok('★ 날짜 파싱은 utils/koreanDate.parseDateColumn 재사용',
      /require\('\.\.\/utils\/koreanDate'\)/.test(src) && /parseDateColumn\(/.test(src));
    ok('★★ fallbackAnchor 를 넘긴다(작업표 구매일자에는 연도가 없다)', /fallbackAnchor:\s*\{\s*y:/.test(src));
    ok('★ 순서·칸 이름 규칙은 utils/rowNumbering 단일 출처',
      /require\('\.\.\/utils\/rowNumbering'\)/.test(src) && !/[/]\^\(번호/.test(src));
    ok('★ 쓰기 표면은 campaign_participants 한 곳(시트·원장·장부 무접촉)',
      !/(INSERT INTO|UPDATE|DELETE FROM)\s+(?!campaign_participants)[a-z_]+/i.test(src.replace(/'[^']*'/g, "''")) ||
      !/(INSERT INTO|UPDATE|DELETE FROM)\s+(order_submissions|review_index|tab_configs|raw_sheet_rows)/i.test(src));

    const so = noLineComments(read('src/services/sheetlessOrder.service.js'));
    const idxCall = so.indexOf('renumberTabInTx'), idxCommit = so.indexOf("client.query('COMMIT')");
    ok('★ 주문 기록 경로에 자동 배선', idxCall > 0);
    ok('★★ COMMIT 전에 부른다(같은 트랜잭션 안)', idxCall > 0 && idxCall < idxCommit);

    const tb = noLineComments(read('src/services/trackB.service.js'));
    ok('★ 표시 순서도 같은 판정(utils/rowNumbering) 을 쓴다', /displaySortKey/.test(tb) && /numberColumnKey/.test(tb));
    ok('★ 무시트 탭에서만 번호 순 정렬(시트 기반은 종전 seq 순)', /meta\[0\]\s*&&\s*meta\[0\]\.sheetless/.test(tb));
    ok('★ 화면 정렬 재료로 sheetless 를 싣는다', /COALESCE\(tc\.sheetless, FALSE\) AS sheetless/.test(tb));
  }

  console.log('\n[H] 전체 작업 스캔 — 한 쿼리 집계 · 읽기 전용 · 키 목록 단일 출처');
  {
    const pool = makePool([[/FROM tab_configs/i, { rows: [
      { sheetId: 'S1', tabName: 'T1', displayName: '0729)위드프렌즈', total: 187, blankNumber: 42, dupNumber: 0, pairedBlank: 0, hasNumberCol: true },
      { sheetId: 'S2', tabName: 'T2', displayName: '정상', total: 100, blankNumber: 0, dupNumber: 0, pairedBlank: 0,
        numericNumber: 100, minNumber: 1, maxNumber: 100, hasNumberCol: true },
      { sheetId: 'S3', tabName: 'T3', displayName: '위프(중복줄 정리 뒤)', total: 800, blankNumber: 0, dupNumber: 233, pairedBlank: 233, hasNumberCol: true },
    ] }]]);
    S.__setPoolForTest(pool);
    const r = await S.scanNumbering({});
    ok('스캔은 쿼리 한 번', pool.calls.length === 1, String(pool.calls.length));
    ok('★ 읽기 전용(쓰기 쿼리 0)', !pool.calls.some(c => /^(UPDATE|INSERT|DELETE)\b/i.test(c.sql)));
    ok('★ 무시트 탭만 센다', /COALESCE\(tc.sheetless, FALSE\) = TRUE/.test(pool.calls[0].sql));
    ok('★ 활성 줄만 센다', /p.deleted_at IS NULL AND p.active = TRUE/.test(pool.calls[0].sql));
    ok('★★ 중복 번호만 있는 작업도 정리 대상(빈칸 0 이라 종전엔 통째로 빠졌다)',
      r.needTabs === 2 && r.blankNumberRows === 42 && r.dupNumberRows === 233, JSON.stringify(r));
    ok('★ 스캔 SQL 이 중복을 센다(DISTINCT 차)',
      /COUNT\(DISTINCT num\)/.test(pool.calls[0].sql));
    /* ★★ 칸 이름은 SQL 에 적지 않고 utils 목록을 파라미터로 넘긴다(판정 두 벌 금지) */
    const U2 = require('../src/utils/rowNumbering');
    ok('★★ 칸 이름 후보를 파라미터로 넘긴다', Array.isArray(pool.calls[0].params[0]) &&
      pool.calls[0].params[0].join(',') === U2.NUMBER_KEYS.map(k => k.toLowerCase()).join(','));
    ok('★ SQL 에 칸 이름 리터럴이 없다', !/'번호'|'담당자'/.test(pool.calls[0].sql));
    ok('★★ 정규식은 그 목록에서 만든다(사본 0)', U2.NUMBER_KEYS.every(k => U2.NUMBER_KEY_RE.test(k)));
    ok('★★ 스캔도 담당자를 세지 않는다', !/manager|담당자/i.test(pool.calls[0].sql));
  }

  console.log('\n[J] 짝 빈 줄 정리 — 채워진 줄과 번호가 겹치는 빈 줄만(사용자 확정 2026-08-19)');
  {
    const RN = require('../src/utils/rowNumbering');
    const svcSrc = noLineComments(read('src/services/rowNumbering.service.js'));
    const blk = svcSrc.slice(svcSrc.indexOf('async function cleanupPairedBlanks('), svcSrc.indexOf('async function sweepNumbering('));
    ok('★★ 대상은 비어 있는 줄만(채워진 줄은 조건에서 제외)', /WHERE NOT filled AND num <> '' AND grp_filled/.test(blk));
    // ⚠ 조각은 `utils/rowNumbering.filledSql` 로 이관됐다(작업보드 참여자 게이지가 같은 판정을 JS 로
    //   써야 해서다 — `workboardFilledGauge.test.js`). 검사 의미는 그대로: **네 칸을 본다**.
    ok('★★ "채워짐" 판정은 주문·이름·수취인·연락처(조각 단일 출처)',
      /FILLED_SQL/.test(blk)
      && /const FILLED_SQL = filledSql\('p'\);/.test(svcSrc)
      && /order_submission_id IS NOT NULL[\s\S]{0,200}reviewer_name[\s\S]{0,120}recipient_name[\s\S]{0,120}phone8/.test(RN.filledSql('p')));
    ok('★ 활성 줄만 본다', /p\.deleted_at IS NULL AND p\.active = TRUE/.test(blk));
    ok('★★ 지우지 않고 내린다 — 실행은 sheetlessLedger.retireRows 위임(무시트 게이트·장부 순서 상속)',
      /sheetlessLedger\.service/.test(blk) && /\.retireRows\(/.test(blk) && !/DELETE FROM/i.test(blk));
    ok('★ 번호가 빈 줄끼리는 짝으로 묶지 않는다', /FILTER \(WHERE b\.num <> ''\) OVER \(PARTITION BY b\.num\)/.test(blk));

    /* 스텁 pool 로 실제 실행 — 대상 선정·위임·미리보기 쓰기 0 */
    const calls = [];
    const pool = makePool([[/WITH base AS/i, { rows: [{ seq: 11, num: '566' }, { seq: 13, num: '567' }] }]]);
    S.__setPoolForTest(pool);
    const led = require('../src/services/sheetlessLedger.service');
    const origRetire = led.retireRows;
    led.retireRows = async (a) => { calls.push(a); return { retired: a.dryRun ? 0 : (a.seqs || []).length, indexRows: 7 }; };
    const pre = await S.cleanupPairedBlanks({ sheetId: 's', tabName: 't', dryRun: true });
    ok('미리보기: 대상 수를 세고 내리지는 않는다', pre.ok && pre.matched === 2 && pre.retired === 0, JSON.stringify(pre));
    ok('★ 미리보기도 같은 조건으로 위임(dryRun 전달)', calls[0] && calls[0].dryRun === true && calls[0].seqs.join(',') === '11,13');
    const run = await S.cleanupPairedBlanks({ sheetId: 's', tabName: 't', dryRun: false, by: 'tester' });
    ok('실행: 고른 줄만 내린다', run.ok && run.retired === 2 && calls[1].seqs.join(',') === '11,13', JSON.stringify(run));
    ok('★ 게이트 거부(무시트 아님 등)는 사유를 올린다(조용한 성공 금지)', await (async () => {
      led.retireRows = async () => { const e = new Error('시트 기반 탭입니다'); e.code = 'not_sheetless'; throw e; };
      const r = await S.cleanupPairedBlanks({ sheetId: 's', tabName: 't', dryRun: false });
      return r.ok === false && r.reason === 'not_sheetless';
    })());
    led.retireRows = origRetire;
    ok('★ 킬스위치 적용', await (async () => {
      process.env.WORKTABLE_AUTO_NUMBER = '0';
      const r = await S.cleanupPairedBlanks({ sheetId: 's', tabName: 't' });
      delete process.env.WORKTABLE_AUTO_NUMBER;
      return r.ok === false && r.reason === 'disabled';
    })());
    ok('★ 스캔이 짝 빈 줄도 센다(윈도우 판정)', /pairedBlank/.test(svcSrc) && /bool_or\(b\.filled\)/.test(svcSrc));
    ok('★ 칸 이름 후보는 여기서도 utils 목록', RN.NUMBER_KEYS.length > 0 && /NUMBER_KEYS/.test(blk));
  }

  console.log('\n[I] 자동 스윕(크론) — 대상만 · 상한 · 건별 독립 · throw 없음');
  {
    /* 스캔이 추린 대상만 연다(정리 끝난 작업을 매번 열지 않는다) */
    const opened = [];
    const pool = makePool([
      [/FROM tab_configs tc/i, { rows: [
        { sheetId: 'S1', tabName: 'T1', displayName: 'A', total: 100, blankNumber: 5, dupNumber: 0, pairedBlank: 0, hasNumberCol: true },
        { sheetId: 'S2', tabName: 'T2', displayName: 'B', total: 100, blankNumber: 0, dupNumber: 0, pairedBlank: 0,
          numericNumber: 100, minNumber: 1, maxNumber: 100, hasNumberCol: true },   // 이미 정리됨
        { sheetId: 'S3', tabName: 'T3', displayName: 'C', total: 100, blankNumber: 0, dupNumber: 7, pairedBlank: 7, hasNumberCol: true },
      ] }],
      [/FROM tab_configs\s+WHERE sheet_id/i, (p) => { opened.push(p[1]); return { rows: [{ sheetless: true }] }; }],
      [/FROM campaign_participants p/i, { rows: [] }],
    ]);
    S.__setPoolForTest(pool);
    const r = await S.sweepNumbering({ cap: 10 });
    ok('★★ 빈칸 또는 중복이 있는 작업만 연다(정리 끝난 작업은 열지 않는다)',
      opened.join(',') === 'T1,T3', opened.join(','));
    /* ★★★ 순서 계약 — 정리가 재번호보다 먼저여야 한다. 재번호가 번호를 1..N 로 유일하게 만들면
         "채워진 줄과 번호가 겹친다"는 짝 신호가 사라져 그 뒤로는 영영 정리되지 않는다. */
    const sweepBlk = noLineComments(read('src/services/rowNumbering.service.js'));
    const swp = sweepBlk.slice(sweepBlk.indexOf('async function sweepNumbering('));
    ok('★★★ 스윕은 짝 빈 줄 정리를 재번호보다 먼저 한다',
      swp.indexOf('cleanupPairedBlanks(') > 0 && swp.indexOf('cleanupPairedBlanks(') < swp.indexOf('renumberTab('),
      `clean=${swp.indexOf('cleanupPairedBlanks(')} renum=${swp.indexOf('renumberTab(')}`);
    ok('★ 정리 실패가 재번호를 막지 않는다(둘은 독립)', /catch \(e\) \{ logger\.warn\(`\[rowNumbering\] 짝 빈 줄 정리 실패/.test(swp));

    /* ★★ 정적 순서 검사만으로는 "정리를 아예 안 부르게" 만든 변이를 놓친다(변이시험 실측) →
         스윕을 **실제로 실행**해 짝 빈 줄이 있는 탭에서 정리가 재번호보다 먼저 불렸는지 본다. */
    {
      const order = [];
      const pool2 = makePool([
        [/WITH base AS[\s\S]*pairedBlank/i, { rows: [
          { sheetId: 'S9', tabName: 'T9', displayName: 'X', total: 10, blankNumber: 0, dupNumber: 0, pairedBlank: 3, hasNumberCol: true }] }],
        [/WITH base AS/i, () => { order.push('clean-select'); return { rows: [{ seq: 2, num: '5' }] }; }],
        [/FROM tab_configs\s+WHERE sheet_id/i, () => { order.push('renumber'); return { rows: [{ sheetless: true }] }; }],
        [/FROM campaign_participants p/i, { rows: [] }],
      ]);
      S.__setPoolForTest(pool2);
      const led2 = require('../src/services/sheetlessLedger.service');
      const keep = led2.retireRows;
      led2.retireRows = async (a) => { order.push('retire'); return { retired: (a.seqs || []).length }; };
      const sw = await S.sweepNumbering({ cap: 5 });
      led2.retireRows = keep;
      ok('★★★ 스윕이 짝 빈 줄 정리를 실제로 부른다', order.includes('retire'), order.join('>'));
      ok('★★★ 그리고 재번호보다 먼저 부른다',
        order.indexOf('retire') < order.indexOf('renumber'), order.join('>'));
      ok('정리한 줄 수를 보고한다', sw.blankRows === 1, JSON.stringify(sw));
    }
    const allBlk2 = sweepBlk.slice(sweepBlk.indexOf('async function renumberAllSheetless('), sweepBlk.indexOf('async function scanNumbering('));
    ok('★★ 전체 정리도 같은 순서', allBlk2.indexOf('cleanupPairedBlanks(') > 0 && allBlk2.indexOf('cleanupPairedBlanks(') < allBlk2.indexOf('renumberTab('));
    ok('스캔 결과를 보고한다', r.need === 2 && r.tabs === 2, JSON.stringify(r));

    /* 사이클 상한 — 남은 것은 다음 사이클(업무 시간에 DB 를 흔들지 않는다) */
    S.__setPoolForTest(makePool([
      [/FROM tab_configs tc/i, { rows: [1, 2, 3, 4].map(i => ({ sheetId: 'S' + i, tabName: 'T' + i, displayName: 'x', total: 9, blankNumber: 1, dupNumber: 0, pairedBlank: 0, hasNumberCol: true })) }],
      [/FROM tab_configs\s+WHERE sheet_id/i, { rows: [{ sheetless: true }] }],
      [/FROM campaign_participants p/i, { rows: [] }],
    ]));
    const r2 = await S.sweepNumbering({ cap: 2 });
    ok('★ 사이클 상한을 지킨다', r2.tabs === 2 && r2.remaining === 2, JSON.stringify(r2));

    /* 한 작업의 실패가 나머지를 죽이지 않고, 크론으로 예외가 새지 않는다 */
    let calls = 0;
    S.__setPoolForTest({ query: async (sql) => {
      if (/FROM tab_configs tc/i.test(sql)) return { rows: [
        { sheetId: 'S1', tabName: 'T1', displayName: 'A', total: 9, blankNumber: 1, dupNumber: 0, pairedBlank: 0, hasNumberCol: true },
        { sheetId: 'S2', tabName: 'T2', displayName: 'B', total: 9, blankNumber: 1, dupNumber: 0, pairedBlank: 0, hasNumberCol: true }] };
      if (/FROM tab_configs\s+WHERE sheet_id/i.test(sql)) { calls++; if (calls === 1) throw new Error('boom'); return { rows: [{ sheetless: true }] }; }
      return { rows: [] };
    } });
    let threw = false, r3;
    try { r3 = await S.sweepNumbering({ cap: 10 }); } catch (_) { threw = true; }
    ok('★★ 실패해도 throw 하지 않는다(크론 보호)', !threw && r3 && r3.failed === 1, JSON.stringify(r3));
    ok('★ 실패한 작업이 나머지를 죽이지 않는다', calls === 2, String(calls));

    /* 스캔 자체가 실패하면 아무것도 열지 않는다(모르는 채로 쓰지 않는다) */
    S.__setPoolForTest({ query: async () => { throw new Error('down'); } });
    const r4 = await S.sweepNumbering({});
    ok('★ 스캔 실패는 skip(쓰기 0)', r4.skipped === true && r4.reason === 'scan_failed');

    /* 킬스위치 */
    process.env.WORKTABLE_AUTO_NUMBER = '0';
    const r5 = await S.sweepNumbering({});
    ok('킬스위치면 스캔조차 하지 않는다', r5.skipped === true && r5.reason === 'disabled');
    delete process.env.WORKTABLE_AUTO_NUMBER;
  }
  {
    const cronSrc = noLineComments(read('src/jobs/cron.js'));
    ok('★ 크론에 스윕 등록', /sweepNumbering/.test(cronSrc) && /cron\.schedule\(rnSchedule/.test(cronSrc));
    ok('★★ 인스턴스 직렬화(락) — 멀티 인스턴스가 같은 탭을 두 번 매기지 않는다',
      /withJobLock\('worktable_renumber_sweep'/.test(cronSrc));
    ok('★ 중복 실행 방지(rnRunning)', /if \(rnRunning\) return;[\s\S]{0,40}rnRunning = true/.test(cronSrc));
    ok('★ 킬스위치 두 겹(기능 전체·스윕만)',
      /WORKTABLE_AUTO_NUMBER !== '0' && process\.env\.WORKTABLE_RENUMBER_SWEEP !== '0'/.test(cronSrc));
    ok('★ 다른 크론과 분이 겹치지 않는다(기본 스케줄)', /'3-59\/5 \* \* \* \*'/.test(cronSrc));
  }

  console.log('\n[G] 라우트·화면 배선');
  {
    const rt = noLineComments(read('src/routes/trackB.routes.js'));
    const blk = rt.slice(rt.indexOf("router.post('/worktable/renumber'"), rt.indexOf("router.post('/worktable/renumber-all'"));
    ok('탭 단위 정리 = authMiddleware + internalMiddleware',
      /router\.post\('\/worktable\/renumber',\s*authMiddleware,\s*internalMiddleware/.test(rt));
    ok('★ confirm !== true 면 미리보기(쓰기 0)', /dryRun:\s*confirm\s*!==\s*true/.test(blk));
    ok('★★ 줄 내리기는 명시 요청일 때만(기본 계약 = 번호만)', /if \(cleanBlanks === true\)/.test(blk));
    ok('★★ 라우트도 정리 → 재번호 순서', blk.indexOf('cleanupPairedBlanks(') < blk.indexOf('renumberTab('));
    ok('전체 소급 정리는 adminOrMaster',
      /router\.post\('\/worktable\/renumber-all',\s*authMiddleware,\s*adminOrMasterMiddleware/.test(rt));

    const fe = read('../frontend/workdesk.html');
    ok('★ 창구는 무시트 + 내부인일 때만',
      /function _rnCanRenumber\(\)\{[\s\S]{0,200}sheetless === true[\s\S]{0,80}_isInternalRole\(\)/.test(fe));
    ok('[⋯] 메뉴에 번호 정리 버튼', /openRenumberModal\(\)"[^>]*>🔢 번호 정리/.test(fe));
    ok('★ 오버레이는 body 직속', /rnOv[\s\S]{0,600}document\.body\.appendChild\(ov\)/.test(fe));
    ok('★ Esc 리스너는 최상위 1회', /_rnKeyBound/.test(fe));
    /* ★ 문자열 존재만 보면 `if (false && !confirm(...))` 을 통과시킨다(변이시험 실측)
         → **게이트 형태(`if (!confirm(`)** 자체를 고정한다. */
    ok('★ 실행 전 confirm(번호가 바뀐다는 사실 고지)', /if \(!confirm\(`「\$\{_RN\.tabName\}」 표의 번호를/.test(fe));
    ok('★ 프론트에 정렬 재계산 사본 없음(서버 결과만 그린다)',
      !/orderRowsForNumbering|computeRenumberPlan/.test(fe));

    ok('전체 조회 라우트 = adminOrMaster(읽기 전용)',
      /router\.get\('\/worktable\/renumber-scan',\s*authMiddleware,\s*adminOrMasterMiddleware/.test(rt));
    ok('★ 전체 작업 진입점(탈시트 전환 헤더)', /openRenumberModal\(\{all:true\}\)"[^>]*>🔢 번호 정리/.test(fe));
    ok('★ 모달은 한 벌 — 모드만 바뀐다(사본 금지)',
      (fe.match(/function openRenumberModal\(/g) || []).length === 1 &&
      /_RN\.mode === 'all'/.test(fe));
    ok('★ 전체 모드는 작업을 안 골라도 열린다', /if \(!all && !_rnCanRenumber\(\)\) return;/.test(fe));
    ok('★ 목록 행 실행은 인덱스만 넘긴다(작업명 보간 금지)',
      /onclick="rnRunOne\(\$\{i\}\)"/.test(fe) && !/rnRunOne\('\$\{esc/.test(fe));
    ok('★ 전체 실행 전 confirm(번호가 바뀐다는 사실 고지)', /if \(!confirm\(`무시트 작업 \$\{s\.needTabs\}개의 번호를/.test(fe));
    ok('★ 실패한 작업을 조용히 넘기지 않는다', /정리하지 못한 작업/.test(fe));
    ok('★ 목록이 잘리면 고지', /목록이 잘렸습니다/.test(fe));

    /* ── 팝업 조작성(실측 신고 2026-08-19: 121개 목록이 세로로 무한히 길어 조작 불가) ── */
    ok('★★ 모달 높이 상한(뷰포트를 넘지 않는다)', /#rnOv \.wbl-dlg\{[^}]*max-height:86vh/.test(fe));
    ok('★★ 본문이 스크롤 컨테이너(min-height:0 없으면 flex 자식이 내용만큼 늘어나 스크롤이 안 생긴다)',
      /#rnOv \.wbl-db\{[^}]*flex:1;min-height:0;overflow:auto/.test(fe));
    ok('★★ 전역 table{overflow:hidden} 상쇄(없으면 sticky 표머리가 조용히 죽는다)',
      /#rnOv \.wbl-wrt\{[^}]*overflow:visible/.test(fe));
    ok('★ sticky 표머리 + border-collapse:separate(collapse 에서는 sticky 가 안 먹는다)',
      /#rnOv \.wbl-wrt\{[^}]*border-collapse:separate/.test(fe) && /#rnOv \.wbl-wrt th\{position:sticky/.test(fe));
    ok('★ 표를 감싸는 래퍼에 overflow 를 두지 않는다(sticky 기준을 가로챈다)',
      !/#rnOv \.rn-tw\{[^}]*overflow/.test(fe));
    ok('★★ 검색은 행만 갈아끼운다(입력칸 재생성 = 한글 IME 파괴)',
      /oninput="_RN\.q=this\.value;_rnRows\(\)"/.test(fe) &&
      /function _rnRows\(\)\{[\s\S]{0,400}getElementById\('rnRows'\)/.test(fe));
    ok('★ 기본은 정리 대상만 보기(121개를 다 늘어놓지 않는다)', /_RN\.onlyNeed !== false/.test(fe));
    ok('★★ 화면 판정도 중복·짝 빈 줄을 포함한다(서버 대상과 갈리면 "목록엔 없는데 자동으로 바뀐다")',
      /r\.blankNumber > 0 \|\| r\.dupNumber > 0 \|\| r\.pairedBlank > 0/.test(fe));
    ok('★★ 실행 요청에 cleanBlanks 를 실어 보낸다', (fe.match(/cleanBlanks: true/g) || []).length === 2);
    ok('★ 확인창이 "줄이 내려간다"를 말한다(되돌릴 수 있음 포함)', /짝 빈 줄 \$\{r\.pairedBlank\}줄은 표에서 내려갑니다\(되돌릴 수 있습니다\)/.test(fe));
    ok('★ 짝 없는 빈 자리는 그대로 둔다고 화면이 말한다', /짝이 없는 빈 자리\(아직 안 팔린 미래 자리\)는 그대로 둡니다/.test(fe));
    ok('★ 빈 줄 자체를 내리는 창구를 안내한다(번호 정리가 줄을 지우지 않는다)', /🧹 줄 정리\]를 쓰세요/.test(fe));
    ok('★★ 필터·검색 중에도 실행은 원본 인덱스로(보이는 순번으로 넘기면 남의 작업을 정리한다)',
      /const i = all\.indexOf\(r\);/.test(fe));
    ok('★ 빈 목록도 사유를 말한다', /검색 결과가 없습니다/.test(fe) && /정리할 작업이 없습니다/.test(fe));

    /* ★★ 헤더 칸 수 ≡ 행 칸 수 ≡ colspan — 열을 끼워 넣을 때 가장 흔히 깨지는 자리.
         담당자 열이 되살아나면 여기서 걸린다(사용자 확정: 담당자는 번호 정리 대상 아님). */
    const allBlk = fe.slice(fe.indexOf('function _rnRenderAll('), fe.indexOf('function _rnNeed('));
    const rowsBlk = fe.slice(fe.indexOf('function _rnRows('), fe.indexOf('/* 서버가 준 사유를'));
    const th = (allBlk.match(/<th>/g) || []).length;
    const td = (rowsBlk.match(/<td[ >]/g) || []).length - (rowsBlk.match(/<td colspan/g) || []).length;  // 빈 목록 줄 제외
    ok('★★ 전체 목록 표는 7칸(작업·표 줄·번호 빈칸·번호 중복·짝 빈 줄·번호 어긋남·버튼)', th === 7, '헤더 ' + th);
    ok('★★ 행 칸 수 = 헤더 칸 수', td === th, `헤더 ${th} · 행 ${td}`);
    ok('★ 빈 목록 colspan 도 같은 칸 수', new RegExp('colspan="' + th + '"').test(rowsBlk));
    const thead = allBlk.slice(allBlk.indexOf('<thead>'), allBlk.indexOf('</thead>'));
    ok('★★ 표에 담당자 열이 없다', !/담당자/.test(thead) && !/담당자|blankManager/.test(rowsBlk), thead.slice(0, 120));
    ok('★ "순서만 어긋난 작업은 숫자로 안 드러난다" 한계를 화면이 말한다', /순서만<\/b> 어긋난 작업은 여기 숫자로 드러나지 않습니다/.test(fe));
    ok('★ 자동으로 돈다는 사실을 화면이 말한다(수동 버튼은 즉시 실행용)',
      /5분마다 자동으로 정리됩니다/.test(fe) && /5분 주기로 자동<\/b> 정리되므로/.test(fe));
  }


  /* ══════════════════════════════════════════════════════════════════════════
     [K] 번호 어긋남 자동 정리 (2026-08-23 신고: "1번 행을 지웠는데 2번이 시작번호")

     고정하는 것:
       ① 판정은 순수함수 hasNumberGap **한 곳** — 스캔 SQL 은 원재료(개수·최솟·최댓값)만 센다
       ② 상한(MAX_RENUMBER_ROWS) 초과 표는 대상이 아니다 — 매 주기 다시 쓰는 무한 루프 방지
       ③ 번호 칸이 없는 탭은 대상이 아니다 — 재번호가 no-op 인데 사이클 상한을 영구히 먹는다
       ④ 줄을 지우는 경로가 **그 자리에서** 다시 매긴다(스윕은 백스톱)
       ⑤ 화면은 서버가 실은 need 를 그대로 쓴다(판정 사본 0)
     ══════════════════════════════════════════════════════════════════════════ */
  console.log('\n[K] 번호 어긋남(1..N 아님) 자동 정리');
  {
    const g = (o) => U.hasNumberGap(o);
    const base = { total: 5, blankNumber: 0, dupNumber: 0, numericNumber: 5, minNumber: 1, maxNumber: 5 };
    ok('★★ 1번 줄을 지운 뒤(2..6) = 정리 대상', g({ ...base, minNumber: 2, maxNumber: 6 }) === true);
    ok('★ 이미 1..N 이면 대상 아님', g(base) === false);
    ok('★ 중간 결번(1..7 에 5줄)도 대상', g({ ...base, minNumber: 1, maxNumber: 7 }) === true);
    ok('★ 숫자가 아닌 번호가 섞이면 대상(재번호가 반드시 바꾼다)', g({ ...base, numericNumber: 4 }) === true);
    ok('★ 빈칸·중복은 다른 신호가 잡는다(같은 사실을 두 번 세지 않는다)',
      g({ ...base, blankNumber: 1, minNumber: 2 }) === false && g({ ...base, dupNumber: 1, minNumber: 2 }) === false);
    ok('★ 빈 표는 대상 아님', g({ ...base, total: 0 }) === false);
    ok('★★ 재번호 상한을 넘는 표는 대상 아님(매 주기 다시 쓰는 무한 루프 차단)',
      g({ total: U.MAX_RENUMBER_ROWS + 1, blankNumber: 0, dupNumber: 0,
          numericNumber: U.MAX_RENUMBER_ROWS + 1, minNumber: 2, maxNumber: U.MAX_RENUMBER_ROWS + 2 }) === false);
    ok('★ 최솟·최댓값을 모르면(전부 비숫자) 대상', g({ ...base, numericNumber: 5, minNumber: null, maxNumber: null }) === true);

    /* 상한은 재번호 쿼리의 LIMIT 과 **같은 값**이어야 한다 — 다르면 상한 사이의 표가 영구 루프. */
    const svc = noLineComments(read('src/services/rowNumbering.service.js'));
    ok('★★ 상한은 utils 단일 출처(서비스가 그 값을 LIMIT 으로 쓴다)',
      /const MAX_ROWS = MAX_RENUMBER_ROWS;/.test(svc) && /LIMIT \$\{MAX_ROWS\}/.test(svc));

    /* ★★ 판정 사본 0 — SQL 은 세기만, 조건은 순수함수가. */
    ok('★★ 스캔 SQL 에 판정 조건이 없다(원재료만 센다)',
      /AS "numericNumber"/.test(svc) && /AS "minNumber"/.test(svc) && /AS "maxNumber"/.test(svc)
      && !/minNumber\s*(<>|!=|=)\s*1/.test(svc.slice(svc.indexOf('WITH base AS'), svc.indexOf('LIMIT ${cap'))));
    ok('★ 판정은 utils 의 hasNumberGap 을 부른다', /hasNumberGap\(/.test(svc));

    /* 스캔이 대상 판정(need)을 항목마다 싣는다 — 스윕·화면이 같은 값을 본다. */
    const pool = makePool([[/FROM tab_configs tc/i, { rows: [
      { sheetId: 'S1', tabName: 'T1', displayName: '1번 지운 작업', total: 15, blankNumber: 0, dupNumber: 0,
        pairedBlank: 0, numericNumber: 15, minNumber: 2, maxNumber: 16, hasNumberCol: true },
      { sheetId: 'S2', tabName: 'T2', displayName: '정상', total: 15, blankNumber: 0, dupNumber: 0,
        pairedBlank: 0, numericNumber: 15, minNumber: 1, maxNumber: 15, hasNumberCol: true },
      { sheetId: 'S3', tabName: 'T3', displayName: '번호 칸 없음', total: 300, blankNumber: 300, dupNumber: 0,
        pairedBlank: 0, numericNumber: 0, minNumber: null, maxNumber: null, hasNumberCol: false },
    ] }]]);
    S.__setPoolForTest(pool);
    const sc = await S.scanNumbering({});
    ok('★★ 1번을 지운 작업이 대상으로 잡힌다(종전 세 신호로는 전부 0 이었다)',
      sc.items[0].seqGap === true && sc.items[0].need === true, JSON.stringify(sc.items[0]));
    ok('★ 정상 작업은 대상 아님', sc.items[1].seqGap === false && sc.items[1].need === false);
    ok('★★★ 번호 칸이 없는 탭은 대상이 아니다 — 재번호가 no_target_column 으로 아무것도 못 하는데 ' +
       '빈칸 수가 커서 정렬 맨 앞을 차지해 **진짜 대상을 사이클 상한 밖으로 영구히 밀어냈다**',
      sc.items[2].need === false, JSON.stringify(sc.items[2]));
    ok('★ 대상 수도 같은 판정으로 센다', sc.needTabs === 1 && sc.seqGapTabs === 1, JSON.stringify(sc));

    /* 스윕이 그 탭을 **실제로** 연다(정적 검사만으로는 조건 제거를 놓친다). */
    const opened = [];
    S.__setPoolForTest(makePool([
      [/FROM tab_configs tc/i, { rows: [
        { sheetId: 'S1', tabName: 'T1', displayName: '1번 지운 작업', total: 15, blankNumber: 0, dupNumber: 0,
          pairedBlank: 0, numericNumber: 15, minNumber: 2, maxNumber: 16, hasNumberCol: true },
        { sheetId: 'S2', tabName: 'T2', displayName: '정상', total: 15, blankNumber: 0, dupNumber: 0,
          pairedBlank: 0, numericNumber: 15, minNumber: 1, maxNumber: 15, hasNumberCol: true },
        { sheetId: 'S3', tabName: 'T3', displayName: '번호 칸 없음', total: 300, blankNumber: 300, dupNumber: 0,
          pairedBlank: 0, numericNumber: 0, minNumber: null, maxNumber: null, hasNumberCol: false },
      ] }],
      [/FROM tab_configs\s+WHERE sheet_id/i, (p) => { opened.push(p[1]); return { rows: [{ sheetless: true }] }; }],
      [/FROM campaign_participants p/i, { rows: [] }],
    ]));
    const sw = await S.sweepNumbering({ cap: 10 });
    ok('★★ 스윕이 번호 어긋난 작업만 연다(정상·번호 칸 없는 탭은 열지 않는다)',
      opened.join(',') === 'T1', opened.join(',') + ' / ' + JSON.stringify(sw));
    ok('★ 스윕은 스캔이 실은 need 를 그대로 쓴다(조건 사본 0)',
      /filter\(r => r\.need\)/.test(svc.slice(svc.indexOf('async function sweepNumbering'))));

    /* ④ 줄을 지우는 경로가 그 자리에서 다시 매긴다 — 스윕은 백스톱이지 유일한 길이 아니다. */
    const tbs = noLineComments(read('src/services/trackB.service.js'));
    const hideBlk = tbs.slice(tbs.indexOf('async function _hideParticipantInTx('),
                              tbs.indexOf('async function hideWorkdeskRow('));
    ok('★★ 행 삭제(하드 삭제 + 빈 자리 보충)가 재번호를 부른다', /renumberTabInTx\(client,/.test(hideBlk));
    ok('★★ SAVEPOINT 격리 경로로 부른다(번호 때문에 행 삭제·주문 취소가 롤백되면 안 된다)',
      /renumberTabInTx/.test(hideBlk) && !/\brenumberTab\(/.test(hideBlk));
    ok('★★ 보충 슬롯을 만든 **뒤** 다시 매긴다(그 줄까지 번호에 든다)',
      hideBlk.indexOf('INSERT INTO campaign_participants') < hideBlk.indexOf('renumberTabInTx'));
    ok('★★ 장부 재생성보다 먼저 매긴다(재생성이 row_json 을 읽는다)',
      tbs.indexOf('renumberTabInTx(client,') < tbs.indexOf('_rebuildWorkdeskLedgers({ sheetId, tabName, by: `participant-delete'));

    const led = noLineComments(read('src/services/sheetlessLedger.service.js'));
    ok('★ 줄 정리·중복 정리 3경로도 같은 훅을 쓴다(사본 0)',
      (led.match(/_renumberAfterRetire\(/g) || []).length === 4, String((led.match(/_renumberAfterRetire\(/g) || []).length));
    const retBlk = led.slice(led.indexOf('async function retireRows('), led.indexOf('async function dedupeRows('));
    ok('★★ 줄 정리도 장부 재생성보다 먼저 매긴다',
      retBlk.indexOf('_renumberAfterRetire(') < retBlk.indexOf('rebuildLedgers('));
    const hookBlk = led.slice(led.indexOf('async function _renumberAfterRetire('), led.indexOf('async function retireRows('));
    ok('★★ 훅은 절대 throw 하지 않는다(정리는 이미 끝났다 — 번호로 되돌리면 안 된다)',
      /try \{/.test(hookBlk) && /catch \(e\) \{/.test(hookBlk) && !/throw/.test(hookBlk));

    /* ⑤ 화면은 서버 판정을 그대로 쓴다 + 구버전 백엔드 폴백 */
    const fe2 = read('../frontend/workdesk.html');
    ok('★★ 화면은 서버가 실은 need 를 그대로 쓴다(판정 사본 0)', /r\.need != null\)\s*\?\s*r\.need/.test(fe2.replace(/\s+/g, ' ')));
    ok('★ need 가 없는 응답(구버전 백엔드)은 종전 세 신호로 접는다(목록이 비지 않게)',
      /r\.blankNumber > 0 \|\| r\.dupNumber > 0 \|\| r\.pairedBlank > 0/.test(fe2));
    ok('★ "모른다"(구버전)와 "없다"를 구분해 그린다', /r\.seqGap === false \? '-' : '\?'/.test(fe2));
  }

  console.log(`\n✅ rowNumbering 회귀가드 통과 (${passed}케이스)`);
  process.exit(0);
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
