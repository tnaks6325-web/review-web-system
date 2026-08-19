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

console.log('\n[C] 담당자 — blank-only · 값 없으면 미기입');
{
  const rows = [
    { id: 'a', seq: 2, iso: '2026-08-01', number: '1', manager: '만두' },
    { id: 'b', seq: 3, iso: '2026-08-02', number: '2', manager: '' },
  ];
  const p1 = U.computeRenumberPlan(rows, { hasNumberCol: true, hasManagerCol: true, manager: '망고' });
  ok('★ 사람이 적어 둔 담당자는 덮지 않는다', !p1.changes.some(c => c.id === 'a'), JSON.stringify(p1.changes));
  ok('빈 담당자만 채운다', p1.changes.length === 1 && p1.changes[0].managerTo === '망고');
  const p2 = U.computeRenumberPlan(rows, { hasNumberCol: true, hasManagerCol: true, manager: '' });
  ok('★ 채울 담당자가 없으면(랜덤·미매핑) 아무것도 하지 않는다', p2.changes.length === 0);
  const p3 = U.computeRenumberPlan(rows, { hasNumberCol: true, hasManagerCol: false, manager: '망고' });
  ok('담당자 칸이 없는 표는 담당자를 만들지 않는다', p3.changes.length === 0);
}

console.log('\n[D] 서비스 — 무시트 게이트 · 미리보기 쓰기 0 · seq 무접촉');
(async () => {
  const roster = [
    { id: '11111111-1111-1111-1111-111111111111', seq: 2, row_json: { '번호': '1', '구매일자': '8 / 18 (화)', '담당자': '망고', '수취인': '김분선' }, submitted_at: '2026-08-18T01:00:00Z' },
    { id: '22222222-2222-2222-2222-222222222222', seq: 3, row_json: { '번호': '', '구매일자': '8 / 5 (수)', '담당자': '', '수취인': '장혜은' }, submitted_at: '2026-08-05T05:00:00Z' },
  ];
  const shapes = [
    [/FROM tab_configs/i, { rows: [{ sheetless: true, manager: '망고' }] }],
    [/FROM campaign_participants p/i, { rows: roster }],
    [/UPDATE campaign_participants/i, { rows: [], rowCount: 2 }],
  ];

  // ── 무시트가 아니면 거부 + 쓰기 0
  {
    const pool = makePool([[/FROM tab_configs/i, { rows: [{ sheetless: false, manager: '망고' }] }]]);
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
    ok('★ 대상은 활성 줄만', /deleted_at IS NULL/.test(upd[0].sql) && /active = TRUE/.test(upd[0].sql));
    ok('번호 칸 이름은 표에서 찾은 값을 쓴다', upd[0].params[3] === '번호' && upd[0].params[4] === '담당자');
    ok('담당자는 빈 줄만 채운다(param 배열)', upd[0].params[2].filter(Boolean).length === 1);
  }
  // ── 담당자 값 정규화(실명 → 닉네임) · 랜덤은 미기입
  {
    const st = shapes.map(x => x[0].source === undefined ? x : x);
    const mk = (mgr) => makePool([
      [/FROM tab_configs/i, { rows: [{ sheetless: true, manager: mgr }] }],
      [/FROM campaign_participants p/i, { rows: [{ id: '33333333-3333-3333-3333-333333333333', seq: 2, row_json: { '번호': '1', '구매일자': '8 / 18 (화)', '담당자': '' }, submitted_at: null }] }],
      [/UPDATE campaign_participants/i, { rows: [], rowCount: 1 }],
    ]);
    S.__setPoolForTest(mk('박은비'));
    let r = await S.renumberTab({ sheetId: 's', tabName: 't', dryRun: true });
    ok('★★ 실명 담당자는 닉네임으로 정규화(박은비 → 망고 — 같은 열에 두 표기가 섞이지 않게)',
      r.manager === '망고', String(r.manager));
    S.__setPoolForTest(mk('랜덤'));
    r = await S.renumberTab({ sheetId: 's', tabName: 't', dryRun: true });
    ok('★ 랜덤·미정은 채우지 않는다(사람이 정한다)', !r.manager && r.changed === 0, JSON.stringify(r));
    S.__setPoolForTest(mk('이만수'));
    r = await S.renumberTab({ sheetId: 's', tabName: 't', dryRun: true });
    ok('★ 매핑에 없는 이름은 버리지 않고 그대로 쓴다(못 채우는 것보다 낫다)', r.manager === '이만수', String(r.manager));
  }
  // ── 번호·담당자 칸이 아예 없는 표
  {
    S.__setPoolForTest(makePool([
      [/FROM tab_configs/i, { rows: [{ sheetless: true, manager: '망고' }] }],
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

  console.log('\n[G] 라우트·화면 배선');
  {
    const rt = noLineComments(read('src/routes/trackB.routes.js'));
    const blk = rt.slice(rt.indexOf("router.post('/worktable/renumber'"), rt.indexOf("router.post('/worktable/renumber-all'"));
    ok('탭 단위 정리 = authMiddleware + internalMiddleware',
      /router\.post\('\/worktable\/renumber',\s*authMiddleware,\s*internalMiddleware/.test(rt));
    ok('★ confirm !== true 면 미리보기(쓰기 0)', /dryRun:\s*confirm\s*!==\s*true/.test(blk));
    ok('전체 소급 정리는 adminOrMaster',
      /router\.post\('\/worktable\/renumber-all',\s*authMiddleware,\s*adminOrMasterMiddleware/.test(rt));

    const fe = read('../frontend/workdesk.html');
    ok('★ 창구는 무시트 + 내부인일 때만',
      /function _rnCanRenumber\(\)\{[\s\S]{0,200}sheetless === true[\s\S]{0,80}_isInternalRole\(\)/.test(fe));
    ok('[⋯] 메뉴에 번호 정리 버튼', /openRenumberModal\(\)"[^>]*>🔢 번호 정리/.test(fe));
    ok('★ 오버레이는 body 직속', /rnOv[\s\S]{0,600}document\.body\.appendChild\(ov\)/.test(fe));
    ok('★ Esc 리스너는 최상위 1회', /_rnKeyBound/.test(fe));
    ok('★ 실행 전 confirm(번호가 바뀐다는 사실 고지)', /confirm\(`「\$\{_RN\.tabName\}」 표의 번호를/.test(fe));
    ok('★ 프론트에 정렬 재계산 사본 없음(서버 결과만 그린다)',
      !/orderRowsForNumbering|computeRenumberPlan/.test(fe));
  }

  console.log(`\n✅ rowNumbering 회귀가드 통과 (${passed}케이스)`);
  process.exit(0);
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
