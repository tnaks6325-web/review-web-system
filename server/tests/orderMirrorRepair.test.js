/**
 * orderMirrorRepair.test.js — 무시트 주문 완결 표시 정정 + 자동 인계 회귀가드
 * 실행: node tests/orderMirrorRepair.test.js
 *
 * 고정하는 것:
 *  A. 정정 대상 판정 — `campaign:*` 좌표 · 상태 화이트리스트 · 작업보드 링크가 유일한 근거
 *  B. dryRun 기본 · 쓰기 표면 = `markOrderWritten` 단일 출처 · 로그 자동해결 호출
 *  C. 라우트 게이트 — adminOrMaster · dryRun 은 `!== false` 일 때만 실제 정정
 *  D. 자동 인계 cron — 킬스위치 · 창(sinceHours) · 상한 · job lock · 실패 고지
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const srv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const noLineComments = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const slOrder = require('../src/services/sheetlessOrder.service');
const ledger = require('../src/services/orderLedger.service');
const revLog = require('../src/services/reviewerEventLog.service');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

/** 스텁 pool — 쿼리문·파라미터를 기록하고 준 답을 돌려준다(SQL 은 해석하지 않는다). */
function stubPool(answer) {
  const calls = [];
  const q = async (sql, params) => { calls.push({ sql, params }); return answer(sql, params) || { rows: [] }; };
  return { calls, pool: { query: q, connect: async () => ({ query: q, release() {} }) } };
}

(async () => {
  /* ══════════════ A. 정정 대상 판정 ══════════════ */
  console.log('\n[A] 정정 대상 — campaign:* · 상태 화이트리스트 · 작업보드 링크');
  {
    ok('상태 화이트리스트는 3종뿐(취소·인플라이트·수동입력 대상 미포함)',
      JSON.stringify(slOrder.REPAIRABLE_MIRROR_STATUSES) === JSON.stringify(['failed', 'pending', 'pending_no_row']));
    for (const bad of ['canceled', 'queued', 'stuck_manual', 'conflict', 'written']) {
      ok(`'${bad}' 은 정정 대상이 아니다`, !slOrder.REPAIRABLE_MIRROR_STATUSES.includes(bad));
    }
    // 실행 — 조회 쿼리가 그 세 조건을 실제로 걸고 있는지(스텁은 SQL 을 해석하지 않으므로 쿼리문으로 고정)
    const s = stubPool(() => ({ rows: [] }));
    slOrder.__setPoolForTest(s.pool);
    const out = await slOrder.repairWrittenMarkForBoardRows({ dryRun: true });
    const sql = s.calls[0].sql;
    ok('무시트 참여형 좌표와 작업보드 연결 주문만 본다',
      /os\.sheet_id LIKE 'campaign:%'/.test(sql) && /os\.workboard_id IS NOT NULL/.test(sql));
    ok('상태는 파라미터 배열로 제한한다', /os\.mirror_status = ANY\(\$1::text\[\]\)/.test(sql));
    ok('작업보드 링크가 있는 주문만(EXISTS)', /EXISTS \(SELECT 1 FROM campaign_participants cp/.test(sql));
    ok('★ 소프트삭제·비활성·다른 작업보드 줄은 근거가 아니다',
      /cp\.deleted_at IS NULL AND cp\.active = TRUE/.test(sql) &&
      /cp\.workboard_id = os\.workboard_id/.test(sql));
    ok('삭제된 주문은 건드리지 않는다', /os\.deleted_at IS NULL/.test(sql));
    ok('화이트리스트를 파라미터로 넘긴다', JSON.stringify(s.calls[0].params[0]) === JSON.stringify(slOrder.REPAIRABLE_MIRROR_STATUSES));
    ok('빈 결과는 0건 보고', out.scanned === 0 && out.repaired === 0);
    const targeted = await slOrder.repairWrittenMarkForBoardRows({
      dryRun: true,
      orderSubmissionIds: ['aaaaaaaa-0000-0000-0000-000000000001'],
    });
    const targetedSql = s.calls[1];
    ok('지정 주문만 복구 대상으로 제한할 수 있다',
      /os\.id = ANY\(\$3::uuid\[\]\)/.test(targetedSql.sql) &&
      targetedSql.params[2][0] === 'aaaaaaaa-0000-0000-0000-000000000001' && targeted.scanned === 0);
    await slOrder.repairWrittenMarkForBoardRows({ dryRun: true, orderSubmissionIds: [] });
    ok('명시적으로 빈 주문 목록은 전체 복구로 넓어지지 않는다',
      Array.isArray(s.calls[2].params[2]) && s.calls[2].params[2].length === 0);
  }

  /* ══════════════ B. dryRun · 쓰기 표면 ══════════════ */
  console.log('\n[B] dryRun 기본 · markOrderWritten 단일 출처');
  {
    const CAND = [
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', mirror_status: 'failed', tab_name: 'campaign:c1', seq: 7 },
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', mirror_status: 'pending', tab_name: 'campaign:c1', seq: 9 },
    ];
    // ── dryRun: 쓰기 0
    {
      const s = stubPool(() => ({ rows: CAND }));
      slOrder.__setPoolForTest(s.pool);
      const led = stubPool(() => ({ rows: [] })); ledger.__setPoolForTest(led.pool);
      const out = await slOrder.repairWrittenMarkForBoardRows({ dryRun: true });
      ok('dryRun 은 세기만 한다', out.scanned === 2 && out.repaired === 0 && out.dryRun === true);
      ok('dryRun 은 상태별 건수를 보고한다', out.byStatus.failed === 1 && out.byStatus.pending === 1);
      ok('★ dryRun 에서 UPDATE 가 한 줄도 나가지 않는다',
        led.calls.length === 0 && !s.calls.some(c => /UPDATE/i.test(c.sql)));
    }
    // ── 실제 정정: markOrderWritten 경유(그 함수의 UPDATE 가 나가야 한다)
    {
      const s = stubPool(() => ({ rows: CAND }));
      slOrder.__setPoolForTest(s.pool);
      const led = stubPool(() => ({ rows: [] })); ledger.__setPoolForTest(led.pool);
      const rl = stubPool(() => ({ rowCount: 0 })); revLog.__setPoolForTest(rl.pool);
      const out = await slOrder.repairWrittenMarkForBoardRows({ dryRun: false, by: 't' });
      ok('후보 전부 정정', out.repaired === 2 && out.dryRun === false);
      ok('★ 완결 표시는 markOrderWritten 한 곳이 한다(그 함수의 UPDATE 가 나갔다)',
        led.calls.length === 2 && led.calls.every(c => /UPDATE order_submissions/.test(c.sql) && /mirror_status = 'written'/.test(c.sql)));
      ok('★ 작업보드 줄 번호를 완결 표시에 실어 보낸다',
        led.calls[0].params[1] === 7 && led.calls[1].params[1] === 9);
      ok('★ 그 UPDATE 는 sheetlessOrder 안에 사본이 없다',
        !s.calls.some(c => /UPDATE order_submissions/.test(c.sql)));
      ok('원인 사라진 리뷰어 비정상로그를 자동 해결한다(사본 0 — 그 서비스가 한다)',
        rl.calls.some(c => /reviewer_event_logs/.test(c.sql) && /order_unmirrored/.test(c.sql)));
    }
    // ── 개별 실패가 나머지를 죽이지 않는다
    {
      const s = stubPool(() => ({ rows: CAND }));
      slOrder.__setPoolForTest(s.pool);
      let n = 0;
      ledger.__setPoolForTest({ query: async () => { if (++n === 1) throw new Error('boom'); return { rows: [] }; } });
      revLog.__setPoolForTest({ query: async () => ({ rowCount: 0 }) });
      const out = await slOrder.repairWrittenMarkForBoardRows({ dryRun: false });
      ok('건별 독립 — 한 건 실패해도 나머지는 정정된다', out.repaired === 1 && out.items.some(i => i.ok === false));
    }
    slOrder.__setPoolForTest(null); ledger.__setPoolForTest(null); revLog.__setPoolForTest(null);
  }

  /* ══════════════ C. 라우트 ══════════════ */
  console.log('\n[C] 라우트 게이트');
  {
    const router = require('../src/routes/diag.routes');
    const layer = router.stack.find(l => l.route && l.route.path === '/order-mirror-repair');
    ok('POST /api/diag/order-mirror-repair 존재', !!layer && !!layer.route.methods.post);
    const names = layer.route.stack.map(x => x.handle.name);
    ok('adminOrMaster 게이트 뒤', names.some(n => /adminOrMaster/i.test(n)));
    ok('authMiddleware 가 역할 미들웨어 앞',
      names.findIndex(n => /^auth/i.test(n)) < names.findIndex(n => /adminOrMaster/i.test(n)));
    const d = noLineComments(srv('src/routes/diag.routes.js'));
    ok('★ dryRun 은 명시적 false 일 때만 꺼진다(값 없는 요청이 곧바로 쓰지 않는다)',
      /const dryRun = b\.dryRun !== false;/.test(d));
    ok('라우트에 판정 사본 없음(서비스 호출뿐)',
      /repairWrittenMarkForBoardRows\(\{ limit, dryRun, by, orderSubmissionIds \}\)/.test(d) &&
      !/mirror_status = ANY/.test(d.split("router.post('/order-mirror-repair'")[1].split('router.')[0]));
    ok('지정 주문 목록은 배열일 때만 전달하고 최대 100건으로 제한한다',
      /!Array\.isArray\(b\.orderSubmissionIds\)/.test(d) &&
      /b\.orderSubmissionIds\.slice\(0, 100\)/.test(d));
  }

  /* ══════════════ D. 자동 인계 cron ══════════════ */
  console.log('\n[D] 자동 인계 cron — 창·상한·락·고지');
  {
    const c = noLineComments(srv('src/jobs/cron.js'));
    const blk = c.split("SHEETLESS_RECOVER_CRON !== '0'")[1] || '';
    ok('킬스위치 SHEETLESS_RECOVER_CRON', /SHEETLESS_RECOVER_CRON !== '0'/.test(c));
    ok('★ 창(sinceHours)을 넘긴다 — 옛 고아 주문을 무인으로 이어붙이지 않는다',
      /sinceHours = parseInt\(process\.env\.SHEETLESS_RECOVER_WINDOW_HOURS \|\| '48', 10\)/.test(blk) &&
      /recoverUnwrittenSheetlessOrders\(\{ limit, sinceHours, by: 'cron' \}\)/.test(blk));
    ok('★ 사이클 상한이 있다', /SHEETLESS_RECOVER_CRON_LIMIT \|\| '50'/.test(blk));
    ok('★ job lock 으로 수동 실행·타 인스턴스와 상호배제',
      /withJobLock\('sheetless_worktable_recover'/.test(blk));
    ok('중복 실행 가드(같은 인스턴스)', /if \(slrRunning\) return;/.test(blk));
    ok('★ 실패는 조용히 넘기지 않는다(warn 로그 + logAbnormal)',
      /logger\.warn\(`\[CRON-SheetlessRecover\]/.test(blk) &&
      /step: 'sheetless_worktable_recover', severity: 'warn'/.test(blk));

    // ── 창 파라미터가 쿼리에 실제로 바인딩되는지 실행으로 확인
    const s = stubPool(() => ({ rows: [] }));
    slOrder.__setPoolForTest(s.pool);
    await slOrder.recoverUnwrittenSheetlessOrders({ limit: 10, sinceHours: 48 });
    const scan = s.calls.find(x => /FROM order_submissions os/.test(x.sql));
    ok('창 절이 쿼리에 있다', /\(\$2::int IS NULL OR os\.submitted_at > NOW\(\) - \(\$2 \|\| ' hours'\)::interval\)/.test(scan.sql));
    ok('창 값이 파라미터로 실린다', scan.params[1] === 48);
    // ── 수동(창 미지정)은 전체 — null 이 실려야 그 절이 통째로 무효가 된다
    const s2 = stubPool(() => ({ rows: [] }));
    slOrder.__setPoolForTest(s2.pool);
    await slOrder.recoverUnwrittenSheetlessOrders({ limit: 10 });
    const scan2 = s2.calls.find(x => /FROM order_submissions os/.test(x.sql));
    ok('★ 창 미지정 = 전체(수동 복구 범위 불변)', scan2.params[1] === null);
    // ── 상한 클램프
    const s3 = stubPool(() => ({ rows: [] }));
    slOrder.__setPoolForTest(s3.pool);
    await slOrder.recoverUnwrittenSheetlessOrders({ limit: 99999, sinceHours: 99999 });
    const scan3 = s3.calls.find(x => /FROM order_submissions os/.test(x.sql));
    ok('limit·창 모두 상한으로 클램프', scan3.params[0] === 1000 && scan3.params[1] === 24 * 30);
    slOrder.__setPoolForTest(null);
  }

  console.log(`\n총 ${passed}개 통과\n`);
  process.exit(0);
})();
