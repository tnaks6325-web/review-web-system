/**
 * dedupeLinkCorruption.test.js — 회귀가드: 링크 오염과 중복 정리 (2026-08-19 장수산업 사고)
 * 실행: node tests/dedupeLinkCorruption.test.js
 *
 * 사고: 「0721)장수돌침대…」 8/19 참여 다섯 줄이 작업보드에서 사라졌다. 구매양식 제출은 전부
 *   정상 접수(written)됐는데 **줄만** 내려갔다. 원인 두 겹 —
 *   ㉮ 투영(`_enrichTab`)이 주문 링크를 **phone8 하나로만** 정해, 같은 작업에 여러 번 참여한
 *      리뷰어의 모든 줄에 **그중 한 주문**이 붙었다(8/19 줄이 8/4 주문 링크를 들고 있었다).
 *   ㉯ 중복 정리의 "같은 주문 기록을 여러 줄이 씀" 축이 그 링크만 믿고 뒤 줄을 내렸다.
 *
 * 고정하는 것:
 *  A. 링크는 **표 주문번호 일치**로 정한다 · 표 번호가 없을 때만 phone8, 그마저 유일할 때만
 *  B. `identity_key` 는 종전 그대로(편집 오버레이 앵커 — 좁히면 사람이 적어 둔 값이 끊긴다)
 *  C. 중복 정리는 표 주문번호가 다르면 묶지 않는다(사고 재현 방지)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

/* ── 스텁 pool ─────────────────────────────────────────────── */
function makePool(handler) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return handler(sql, params) || { rows: [], rowCount: 0 }; } };
}

console.log('\n[A] 투영 링크 — 표 주문번호가 정한다(phone8 단독 금지)');
{
  const T = require('../src/services/trackB.service');
  /* 김소라: 같은 탭에 8/4·8/19 두 주문. 줄 320(표 8/4) · 863(표 8/19). */
  const ORD8_4 = { id: 'o-0804', dedup_key: 'dk', order_num: '16102062667987', recipient: '김소라', phone: '010-2141-5967', price: '78000', date_str: '8 / 4 (화)', selected_opt_key: '', mirror_status: 'written' };
  const ORD8_19 = { id: 'o-0819', dedup_key: 'dk2', order_num: '16102387707847', recipient: '김소라', phone: '010-2141-5967', price: '78000', date_str: '8 / 19 (수)', selected_opt_key: '', mirror_status: 'written' };
  const ROWS = [
    { id: 'r320', seq: 320, phone8: '21415967', recipient_name: '김소라', round: null, option_text: null, row_json: { 주문번호: '16102062667987' } },
    { id: 'r863', seq: 863, phone8: '21415967', recipient_name: '김소라', round: null, option_text: null, row_json: { 주문번호: '16102387707847' } },
    { id: 'r900', seq: 900, phone8: '99999999', recipient_name: '홍길동', round: null, option_text: null, row_json: {} },
  ];
  const writes = [];
  const pool = makePool((sql, params) => {
    if (/FROM campaign_participants/.test(sql) && /SELECT id, seq, phone8/.test(sql)) return { rows: ROWS };
    if (/FROM order_submissions/.test(sql)) return { rows: [ORD8_4, ORD8_19] };
    if (/UPDATE campaign_participants/.test(sql)) { writes.push(params); return { rowCount: 1 }; }
    return { rows: [] };
  });
  T.__setPoolForTest ? T.__setPoolForTest(pool) : null;
  // getPool 주입 경로가 없으면 db/pool 모듈 캐시를 갈아끼운다(레포 관용구).
  const poolPath = require.resolve('../src/db/pool');
  const realPool = require.cache[poolPath] && require.cache[poolPath].exports;
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };

  (async () => {
    await T._enrichTab({ sheetId: 's', tabName: 't' });
    const byId = new Map(writes.map(w => [w[0], w]));
    ok('★ 320번 줄은 표 주문번호와 같은 8/4 주문에 링크', byId.get('r320')[2] === 'o-0804', String(byId.get('r320')[2]));
    ok('★ 863번 줄은 표 주문번호와 같은 8/19 주문에 링크(사고 재현 차단)',
      byId.get('r863')[2] === 'o-0819', String(byId.get('r863')[2]));
    ok('★ 두 줄이 같은 주문을 가리키지 않는다', byId.get('r320')[2] !== byId.get('r863')[2]);
    ok('★ 표 주문번호도 없고 그 사람 주문도 없으면 링크하지 않는다', byId.get('r900')[2] == null);
    ok('★ identity_key 는 계속 계산한다(앵커 보존)', typeof byId.get('r320')[1] === 'string' && byId.get('r320')[1].length > 0);
    if (realPool) require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: realPool };

    console.log('\n[B] 소스 계약 — phone8 단독 링크로 되돌리지 않는다');
    const src = read('src/services/trackB.service.js');
    const blk = src.slice(src.indexOf('async function _enrichTab('), src.indexOf('// seen-set:'));
    ok('★ 표 주문번호 색인(byOrderNum)을 만든다', /byOrderNum/.test(blk));
    ok('★ 같은 주문번호가 둘이면 모호로 두고 링크하지 않는다', /__AMBIG__/.test(blk));
    ok('★ phone8 폴백은 그 사람 주문이 유일할 때만', /phoneOrderCount\.get\([^)]*\)\s*===\s*1/.test(blk));
    ok('★ 링크는 여전히 blank-only(기존 링크를 빼앗지 않는다)',
      /order_submission_id = COALESCE\(\$3, order_submission_id\)/.test(blk));

    console.log('\n[C] 중복 정리 — 표 주문번호가 다르면 묶지 않는다');
    const led = read('src/services/sheetlessLedger.service.js');
    const dd = led.slice(led.indexOf('async function dedupeRows('), led.indexOf('async function dedupeManual('));
    const m = dd.match(/const k = 'os:' \+ String\(r\.osid\)([^\n]*)/);
    ok('★ ㉯ 축 키에 표 주문번호가 합류했다', !!m && /roword/.test(m[1]), m ? m[1] : '(없음)');
    ok('★ 6자리 미만은 판정하지 않고 빈 값으로 분리', !!m && /length >= 6/.test(m[1]));
    ok('★ 리터럴 NUL 금지(이스케이프 표기)', fs.readFileSync(path.join(__dirname, '..', 'src/services/sheetlessLedger.service.js')).indexOf(0) === -1);

    /* 실행 대조 — 링크는 같지만 표 주문번호가 다른 두 줄은 한 그룹이 되지 않는다. */
    const L = require('../src/services/sheetlessLedger.service');
    const DDROWS = [
      { seq: 320, osid: 'o-0804', name: '김소라', submitted: true, paid: false, ordnum: '16102062667987', ph: '01021415967', at: null, roword: '16102062667987', in_payment: false },
      { seq: 863, osid: 'o-0804', name: '김소라', submitted: false, paid: false, ordnum: '16102062667987', ph: '01021415967', at: null, roword: '16102387707847', in_payment: false },
    ];
    const p2 = makePool((sql) => {
      if (/COALESCE\(sheetless/.test(sql)) return { rows: [{ sheetless: true }] };
      if (/JOIN order_submissions os ON os.id = cp.order_submission_id/.test(sql)) return { rows: DDROWS };
      return { rows: [] };
    });
    L.__setPoolForTest(p2);
    const out = await L.dedupeRows({ sheetId: 's', tabName: 't', dryRun: true });
    ok('★ 표 주문번호가 다르면 정리 대상이 되지 않는다(사고 재현 차단)',
      out.groups === 0 && out.removeRows === 0, JSON.stringify({ groups: out.groups, removeRows: out.removeRows }));

    DDROWS[1].roword = '16102062667987';   // 표 번호까지 같으면 진짜 중복
    const out2 = await L.dedupeRows({ sheetId: 's', tabName: 't', dryRun: true });
    ok('★ 표 번호까지 같으면 종전대로 정리 대상(무회귀)', out2.removeRows === 1, JSON.stringify({ removeRows: out2.removeRows }));

    console.log(`\n✅ dedupeLinkCorruption — ${passed} 케이스 통과`);
    process.exit(0);
  })().catch(e => { console.error('실패:', e.message); process.exit(1); });
}
