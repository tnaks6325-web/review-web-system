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
 *  E. 이관 시 `active=FALSE` 인 **import 줄만** 은퇴(준비 자리·수기 추가 보존) · fail-soft
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

  const cut = noLineComments(read('src/services/sheetlessCutover.service.js'));
  /* ★★ 쓰기 표면은 두 구역으로 나눠 본다(2026-08-19 정리).
       ㉮ 이관 본체 = 여전히 `tab_configs` 한 곳(표식 켜기/끄기).
       ㉯ `_provisionUnlinkedCampaign` = 연결 없는 활성 공고에 서버 작업표를 만들어 주는 경로라
          등록·연결 4테이블을 쓴다. 그 함수 **안에서만** 허용하고, 목록을 넘어서면 실패한다.
       합쳐서 검사하면 이 구역이 조용히 넓어져도 통과한다(8/18~19 실제로 빨간 채 방치됐다). */
  const provIdx = cut.indexOf('async function _provisionUnlinkedCampaign(');
  ok('★ 작업표 프로비저닝 구역이 있다(경계를 지우지 말 것)', provIdx > 0);
  const provEnd = cut.indexOf('\nasync function ', provIdx + 10);
  const prov = cut.slice(provIdx, provEnd > 0 ? provEnd : undefined);
  const body = cut.slice(0, provIdx) + (provEnd > 0 ? cut.slice(provEnd) : '');
  // `ON CONFLICT … DO UPDATE SET` 은 같은 문장의 upsert 절이라 대상 테이블이 아니다 → 제외 후 판정
  const writesOf = src =>
    ((src.replace(/DO UPDATE SET/gi, '')).match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi) || []);
  const wBody = writesOf(body);
  ok('★ 이관 본체의 쓰기 표면은 여전히 tab_configs 한 곳',
    wBody.every(x => /tab_configs/i.test(x)), wBody.join(','));
  const PROV_ALLOW = /(campaigns|tab_configs|recruit_campaigns|work_orders)$/i;
  const wProv = writesOf(prov);
  ok('★ 프로비저닝 구역의 쓰기도 등록·연결 4테이블을 넘지 않는다',
    wProv.length > 0 && wProv.every(x => PROV_ALLOW.test(x.trim())), wProv.join(','));
  ok('★ 작업표 생성은 접수 경로와 같은 서비스에 위임(사본 금지)',
    /require\('\.\/sheetlessAccept\.service'\)[\s\S]{0,80}createSheetlessWorktable/.test(prov));
  ok('★ 프로비저닝도 campaign_participants 에 직접 쓰지 않는다',
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+campaign_participants/i.test(prov));
  ok('★ 사라진 줄 은퇴도 participants.service 위임',
    /retireInactiveImportRows\(/.test(cut));
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

  console.log('\n[E] 이관 시 사라진 줄 은퇴 — import 줄만 · fail-soft');
  {
    const pp = makePool([[/^\s*UPDATE campaign_participants/, { rowCount: 166 }]]);
    P.__setPoolForTest(pp);
    const r = await P.retireInactiveImportRows({ sheetId: 's', tabName: 't', by: 'cutover:김수만' });
    ok('은퇴 건수를 돌려준다', r.ok === true && r.rows === 166);
    const sql = pp.calls[0].sql;
    ok("★★ source='import' 만 — 준비 자리(worktable)·수기(manual)는 건드리지 않는다", /source = 'import'/.test(sql));
    ok('★ active = FALSE 인 줄만(시트에 더는 없는 줄)', /active = FALSE/.test(sql));
    ok('★ 소프트 삭제(deleted_at)', /SET deleted_at = NOW\(\)/.test(sql));
    ok('★ 이미 내려간 줄은 다시 안 건드린다(멱등)', /deleted_at IS NULL/.test(sql));

    const cut = noLineComments(read('src/services/sheetlessCutover.service.js'));
    const i1 = cut.indexOf('retireInactiveImportRows(');
    const i2 = cut.indexOf('rebuildLedgers({', i1);
    ok('★★ 이관에서도 은퇴가 장부 재생성보다 앞(그래야 되살아나지 않는다)', i1 > 0 && i2 > i1);
    /* ★ 순서만 보면  같은 죽은 호출도 통과한다 — 결과를 받아 쓰는 형태를 고정한다. */
    ok('★ 은퇴 결과를 실제로 받아 응답에 싣는다(죽은 호출 금지)',
      /retired = await require\('\.\/participants\.service'\)\s*\n?\s*\.retireInactiveImportRows\(/.test(cut));
    ok('★ 실패해도 이관은 유지하고 사유를 응답에 싣는다(retired)',
      /retired = \{ ok: false/.test(cut) && /reflect, handoff, retired, ledger, notice/.test(cut));
    ok('★ 표식을 켠 뒤에 은퇴한다(무시트 게이트 통과 순서)',
      cut.indexOf('SET sheetless = TRUE') < i1);
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

    /* 아래 두 건은 탈시트 전환 화면(줄 정리와 무관) — 그대로 유지한다. */
    ok('★ 전환 화면이 연도 미상 건수를 말한다(조용한 누락 금지)',
      /m\.yearUnknown\?[\s\S]{0,200}과거 자료로 보고 목록에서 제외/.test(wd));
    ok('★ [보기] 로 그 목록을 열 수 있다(막다른 길 금지)',
      /function _coToggleUnknown\(\)/.test(wd) && /includeUnknown=1/.test(wd));
  }

  console.log(`\n✅ sheetlessRetireRows: ${passed} cases passed`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
