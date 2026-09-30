/**
 * sheetlessRetireRows.test.js — 회귀가드: 무시트 탭 줄 정리(은퇴) + 이관 시 사라진 줄 은퇴
 * 실행: node tests/sheetlessRetireRows.test.js
 *
 * 배경(운영 실측 2026-08-07 · 쿠팡(26년)): 이관 전 검색 명단이 5·6차 50명이었는데 이관 후 216명이 됐다.
 *   시트 시절 투영이 `active = FALSE` 로 내려 둔 옛 차수 166줄을 장부 재생성이 `deleted_at` 만 보고
 *   그대로 되살렸기 때문이다. 그리고 그 줄을 **다시 내릴 창구가 어디에도 없었다**.
 *
 * 고정하는 것:
 *  A. 쓰기 소유자 — campaign_participants 쓰기는 participants.service 안에서만
 *  B. 정리 게이트 — 무시트 탭만 · dryRun 기본 · 대상 미선택 거부
 *  C. 순서 계약 — soft-delete → 장부 재생성 (반대면 투영이 `deleted_at=NULL` 로 되살린다)
 *  D. 미리보기는 쓰기 0 / 실행은 같은 조건으로 지운다
 *  (E. 이관 시 은퇴 — 탈시트 전환 화면 제거로 2026-09-28 삭제, 결정 186 2번)
 *  F. 라우트·화면 배선
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

/* ── 스텁 pool ─────────────────────────────────────────────── */
function makePool(rowsByShape) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      for (const [re, res] of rowsByShape) if (re.test(sql)) return typeof res === 'function' ? res(params) : res;
      return { rows: [], rowCount: 0 };
    },
  };
}
const P = require('../src/services/participants.service');
const L = require('../src/services/sheetlessLedger.service');

/* 표본: 1차 2줄(제출·입금) · 2차 1줄(미제출) — 정리 대상은 1차 */
const HIT = [
  { seq: 10, name: '김영숙', round: '1차', submitted: true, paid: true, hasOrder: false },
  { seq: 11, name: '박세희', round: '1차', submitted: true, paid: false, hasOrder: true },
];

console.log('\n[A] 쓰기 소유자 — campaign_participants 쓰기는 participants.service 안에서만');
{
  const led = noLineComments(read('src/services/sheetlessLedger.service.js'));
  const retireBlk = led.slice(led.indexOf('async function retireRows('));
  ok('★ 장부 모듈의 정리 함수는 campaign_participants 에 직접 쓰지 않는다',
    !/(UPDATE|DELETE FROM|INSERT INTO)\s+campaign_participants/i.test(retireBlk.slice(0, 2000)));
  ok('★ 쓰기는 participants.service.retireRows 에 위임',
    /participants\.service'\)[\s\S]{0,60}\.retireRows\(/.test(retireBlk.slice(0, 2000)));

}

console.log('\n[B] 정리 게이트 — 무시트 탭만 · dryRun 기본 · 대상 미선택 거부');
{
  ok('retireRows 를 내보낸다', typeof L.retireRows === 'function' && typeof P.retireRows === 'function');
  /* ★★ 수동 라우트는 제거됐다(사용자 확정 2026-08-23) — 실행부는 중복 정리가 계속 쓴다.
     그래서 여기서 보는 것은 "창구가 없다 + 서비스는 살아 있다" 두 가지다. */
  const _rt = read('src/routes/trackB.routes.js');
  ok('★★ 수동 라우트가 없다(POST /worktable/retire-rows)',
    !/router\.post\('\/worktable\/retire-rows'/.test(_rt));
  ok('★★ 실행부는 그대로 — 중복 정리가 쓴다(지우면 그쪽이 죽는다)',
    /retireRows\(\{[^}]*by: `dedupe:/.test(read('src/services/sheetlessLedger.service.js')));
}

(async () => {
  {
    L.__setPoolForTest(makePool([[/FROM tab_configs/, { rows: [{ sheetless: false }] }]]));
    let code = null;
    try { await L.retireRows({ sheetId: 's', tabName: 't', rounds: ['1차'], dryRun: true }); }
    catch (e) { code = e.code; }
    ok('★ 시트 기반 탭은 거부(not_sheetless) — 표에서만 내려도 다음 빌드가 되살린다', code === 'not_sheetless');

    L.__setPoolForTest(makePool([[/FROM tab_configs/, { rows: [] }]]));
    code = null;
    try { await L.retireRows({ sheetId: 's', tabName: 't', rounds: ['1차'], dryRun: true }); }
    catch (e) { code = e.code; }
    ok('미등록 탭 거부(tab_not_registered)', code === 'tab_not_registered');

    L.__setPoolForTest(makePool([[/FROM tab_configs/, { rows: [{ sheetless: true }] }]]));
    P.__setPoolForTest(makePool([]));
    code = null;
    try { await L.retireRows({ sheetId: 's', tabName: 't', rounds: [], seqs: [], dryRun: true }); }
    catch (e) { code = e.code; }
    ok('★ 대상을 안 고르면 거부(empty) — 조용히 아무것도 안 하지 않는다', code === 'empty');
  }

  console.log('\n[C] 미리보기는 쓰기 0 · 실행은 같은 조건');
  {
    const pp = makePool([
      [/SELECT seq, reviewer_name AS name/, { rows: HIT }],
      [/COUNT\(\*\)::int AS n/, { rows: [{ n: 216 }] }],
    ]);
    P.__setPoolForTest(pp);
    const dry = await P.retireRows({ sheetId: 's', tabName: 't', rounds: ['1차'], dryRun: true });
    ok('★ 미리보기는 UPDATE 를 실행하지 않는다', !pp.calls.some(c => /^UPDATE/i.test(c.sql)));
    ok('대상 집계를 사실대로 돌려준다(제출·입금·주문 연결)',
      dry.matched === 2 && dry.submitted === 2 && dry.paid === 1 && dry.withOrder === 1 && dry.named === 2);
    ok('★ 표가 몇 줄이 되는지 말한다', dry.boardRows === 216 && dry.boardAfter === 214);

    const pp2 = makePool([
      [/SELECT seq, reviewer_name AS name/, { rows: HIT }],
      [/COUNT\(\*\)::int AS n/, { rows: [{ n: 216 }] }],
      [/^\s*UPDATE campaign_participants/, { rowCount: 2 }],
    ]);
    P.__setPoolForTest(pp2);
    const run = await P.retireRows({ sheetId: 's', tabName: 't', rounds: ['1차'], dryRun: false, by: '김수만' });
    ok('실행하면 그 줄만 내린다', run.retired === 2);
    const upd = pp2.calls.find(c => /^UPDATE campaign_participants/i.test(c.sql));
    ok('★ 하드삭제가 아니라 소프트(deleted_at) + 비활성', /deleted_at = NOW\(\)/.test(upd.sql) && /active = FALSE/.test(upd.sql));
    ok('★ 조회와 삭제가 같은 조건(미리보기 ≠ 결과 방지)',
      /COALESCE\(NULLIF\(btrim\(round\)/.test(upd.sql) && /seq = ANY\(\$4::int\[\]\)/.test(upd.sql));
    ok('★ 차수 빈 값도 고를 수 있다(정규화 비교)', upd.params[2].length === 1 && upd.params[2][0] === '1차');
  }
  {
    /* 빈 문자열 차수를 고르면 (빈값) 줄이 대상이 된다 */
    const pp = makePool([[/SELECT seq, reviewer_name AS name/, { rows: [] }], [/COUNT\(\*\)::int AS n/, { rows: [{ n: 5 }] }]]);
    P.__setPoolForTest(pp);
    const r = await P.retireRows({ sheetId: 's', tabName: 't', rounds: [''], dryRun: true });
    ok("★ '(빈값)' 차수도 대상 배열에 실린다", pp.calls[0].params[2].includes(''));
    ok('대상 0건이어도 예외 없이 숫자로 답한다', r.matched === 0 && r.boardAfter === 5);
  }

  console.log('\n[D] 순서 계약 — soft-delete → 장부 재생성');
  {
    const order = [];
    P.__setPoolForTest(makePool([
      [/SELECT seq, reviewer_name AS name/, () => { order.push('select'); return { rows: HIT }; }],
      [/COUNT\(\*\)::int AS n/, { rows: [{ n: 216 }] }],
      [/^\s*UPDATE campaign_participants/, () => { order.push('soft-delete'); return { rowCount: 2 }; }],
    ]));
    L.__setPoolForTest(makePool([[/FROM tab_configs/, { rows: [{ sheetless: true }] }]]));
    const realRebuild = L.rebuildLedgers;
    // rebuildLedgers 는 이 모듈 안에서 렉시컬로 불리므로 스텁 대신 **소스로 순서를 고정**한다.
    const led = noLineComments(read('src/services/sheetlessLedger.service.js'));
    const blk = led.slice(led.indexOf('async function retireRows('));
    const iDel = blk.indexOf('.retireRows(');
    const iReb = blk.indexOf('rebuildLedgers({');
    ok('★★ 순서가 계약: 작업표 정리(위임)가 장부 재생성보다 **앞** — 반대면 투영이 되살린다',
      iDel > 0 && iReb > iDel);
    ok('★ 장부 재생성 실패는 조용히 넘기지 않는다(ledgerError 로 고지)', /ledgerError/.test(blk.slice(0, 1600)));
    ok('★ dryRun 이면 장부를 다시 만들지 않는다', /if \(dryRun\) return \{ \.\.\.r/.test(blk.slice(0, 1600)));
    assert(typeof realRebuild === 'function');
    // 실제 실행 경로: 정리 0건이면 장부 재생성도 안 한다
    ok('★ 정리 0건이면 장부 재생성 없음(불필요한 재기록 금지)',
      /if \(!r\.retired\) return/.test(blk.slice(0, 1600)));
  }

  console.log('\n[F] 수동 창구 제거 — 줄을 내리는 길은 [행 삭제]·[♻ 중복 정리] 둘');
  {
    const routes = read('src/routes/trackB.routes.js');
    const wd = read('../frontend/workdesk.html');
    /* ★★ 사용자 확정 2026-08-23 — 원인이던 탈시트 이관이 끝나 수동 창구를 없앴다.
       되살리면 "화면에서만 줄을 빼는" 계열 창구가 다시 늘어난다. */
    ok('★★ 수동 라우트가 없다', !/router\.post\('\/worktable\/retire-rows'/.test(routes));
    ok('★★ 화면에 줄 정리 창구가 없다',
      !/openRetireModal|_wrCanRetire|_wrRender|wrToggle/.test(wd));
    ok('★ 전용 CSS 도 남기지 않는다(.wbl-wrt)', !/\.wbl-wrt\{/.test(wd));
    /* ★★ 권한 ≠ 노출 (사용자 확정 2026-08-24 — 08-23 의 1:1 을 되돌림):
         서버 = adminOrMaster · 화면 버튼 = **master 전용**. 화면이 서버보다 **일부러 좁다**.
       ★★★ 고정하는 것은 **방향**이다 — 화면이 서버보다 넓어지는 것만 금지(좁은 것은 의도).
         `_isInternalRole()`(staff) 로 넓히면 AE 에게 "눌러도 403" 인 죽은 버튼이 생긴다. */
    ok('★★ 남은 정리 창구는 [♻ 중복 정리] 하나 — 서버는 adminOrMaster',
      /router\.post\('\/worktable\/dedupe-rows',\s*authMiddleware,\s*adminOrMasterMiddleware/.test(routes));
    const ddCan = wd.slice(wd.indexOf('function _ddCan()'), wd.indexOf('function closeDedupeModal'));
    ok('★★ 화면 버튼은 master 전용(admin 에게 내밀지 않는다)',
      /STATE\.role === 'master'/.test(ddCan) && !/'admin'/.test(ddCan));
    ok('★★★ 화면이 서버보다 넓지 않다(staff·internalRole 금지)',
      !/_isInternalRole|'staff'/.test(ddCan));

  }

  console.log(`\n✅ sheetlessRetireRows: ${passed} cases passed`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
