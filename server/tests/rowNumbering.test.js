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
      { sheetId: 'S1', tabName: 'T1', displayName: '0729)위드프렌즈', total: 187, blankNumber: 42 },
      { sheetId: 'S2', tabName: 'T2', displayName: '정상', total: 100, blankNumber: 0 },
    ] }]]);
    S.__setPoolForTest(pool);
    const r = await S.scanNumbering({});
    ok('스캔은 쿼리 한 번', pool.calls.length === 1, String(pool.calls.length));
    ok('★ 읽기 전용(쓰기 쿼리 0)', !pool.calls.some(c => /^(UPDATE|INSERT|DELETE)\b/i.test(c.sql)));
    ok('★ 무시트 탭만 센다', /COALESCE\(tc.sheetless, FALSE\) = TRUE/.test(pool.calls[0].sql));
    ok('★ 활성 줄만 센다', /p.deleted_at IS NULL AND p.active = TRUE/.test(pool.calls[0].sql));
    ok('정리 대상 작업 수·빈 줄 수 집계', r.needTabs === 1 && r.blankNumberRows === 42, JSON.stringify(r));
    /* ★★ 칸 이름은 SQL 에 적지 않고 utils 목록을 파라미터로 넘긴다(판정 두 벌 금지) */
    const U2 = require('../src/utils/rowNumbering');
    ok('★★ 칸 이름 후보를 파라미터로 넘긴다', Array.isArray(pool.calls[0].params[0]) &&
      pool.calls[0].params[0].join(',') === U2.NUMBER_KEYS.map(k => k.toLowerCase()).join(','));
    ok('★ SQL 에 칸 이름 리터럴이 없다', !/'번호'|'담당자'/.test(pool.calls[0].sql));
    ok('★★ 정규식은 그 목록에서 만든다(사본 0)', U2.NUMBER_KEYS.every(k => U2.NUMBER_KEY_RE.test(k)));
    ok('★★ 스캔도 담당자를 세지 않는다', !/manager|담당자/i.test(pool.calls[0].sql));
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
    ok('★★ 필터·검색 중에도 실행은 원본 인덱스로(보이는 순번으로 넘기면 남의 작업을 정리한다)',
      /const i = all\.indexOf\(r\);/.test(fe));
    ok('★ 빈 목록도 사유를 말한다', /검색 결과가 없습니다/.test(fe) && /정리할 작업이 없습니다/.test(fe));

    /* ★★ 헤더 칸 수 ≡ 행 칸 수 ≡ colspan — 열을 끼워 넣을 때 가장 흔히 깨지는 자리.
         담당자 열이 되살아나면 여기서 걸린다(사용자 확정: 담당자는 번호 정리 대상 아님). */
    const allBlk = fe.slice(fe.indexOf('function _rnRenderAll('), fe.indexOf('function _rnNeed('));
    const rowsBlk = fe.slice(fe.indexOf('function _rnRows('), fe.indexOf('/* 서버가 준 사유를'));
    const th = (allBlk.match(/<th>/g) || []).length;
    const td = (rowsBlk.match(/<td[ >]/g) || []).length - (rowsBlk.match(/<td colspan/g) || []).length;  // 빈 목록 줄 제외
    ok('★★ 전체 목록 표는 4칸(작업·표 줄·번호 빈칸·버튼)', th === 4, '헤더 ' + th);
    ok('★★ 행 칸 수 = 헤더 칸 수', td === th, `헤더 ${th} · 행 ${td}`);
    ok('★ 빈 목록 colspan 도 같은 칸 수', new RegExp('colspan="' + th + '"').test(rowsBlk));
    const thead = allBlk.slice(allBlk.indexOf('<thead>'), allBlk.indexOf('</thead>'));
    ok('★★ 표에 담당자 열이 없다', !/담당자/.test(thead) && !/담당자|blankManager/.test(rowsBlk), thead.slice(0, 120));
    ok('★ "순서만 어긋난 작업은 숫자로 안 드러난다" 한계를 화면이 말한다', /순서만 어긋난 작업은 여기 숫자로는 드러나지 않습니다/.test(fe));
  }

  console.log(`\n✅ rowNumbering 회귀가드 통과 (${passed}케이스)`);
  process.exit(0);
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
