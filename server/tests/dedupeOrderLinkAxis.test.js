/**
 * 중복 줄 정리 — ㉯ 축(같은 주문 기록을 여러 줄이 씀) 회귀가드 · 2026-08-19
 *
 * 왜 이 축이 생겼나(실측 · 0729)위드프렌즈_면마스크 200건):
 *   한 주문이 **7줄**에 기록됐다(제출시각이 7줄 모두 동일). 부팅 복구 잡이 배포마다 빈 자리를
 *   하나씩 더 먹은 자국이다. 그런데 뒤쪽 줄들은 **표 주문번호가 서로 달라** 종전 ㉮ 축
 *   (표+원장 주문번호+연락처 3키)으로는 영원히 안 잡혔고, 그 원장의 주문번호가 비어 있어
 *   (비번호 주문) **조회 대상에서조차 빠졌다**.
 *
 * 이 가드가 고정하는 것
 *   1. 같은 `order_submission_id` 를 쓰는 줄은 원장 주문번호가 없어도 한 그룹이다.
 *   2. ★★ **남길 줄이 쓰는 주문은 취소하지 않는다** — ㉯ 에서는 지울 줄과 남길 줄이 같은 주문
 *      기록을 공유하므로, 그대로 넘기면 살아남은 줄의 주문까지 사라진다(주문 소실).
 *   3. 보류 규칙(이체 회차·표시가 뒤쪽 줄에만)은 ㉯ 에도 그대로 적용된다.
 *   4. 두 축이 겹치면 한 덩어리로 합쳐 결정을 한 번만 내린다(같은 줄을 두 번 지우지 않는다).
 *   5. ㉯ 대상이 없으면 결과는 종전과 완전히 같다(무회귀).
 *
 * 실행: node tests/dedupeOrderLinkAxis.test.js
 */
'use strict';
const assert = require('assert');
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };

const led = require('../src/services/sheetlessLedger.service');
const partMod = require('../src/services/participants.service');
const ledgerSvc = require('../src/services/orderLedger.service');

const R = (o) => Object.assign({
  name: '박세희', ph: '01075860135', at: '2026-08-05T05:00:00Z',
  submitted: false, paid: false, in_payment: false, ordnum: '', roword: '', osid: null,
}, o);

function stub(rows, { pay = [] } = {}) {
  return {
    query: async (sql) => {
      const q = String(sql);
      if (/FROM tab_configs/.test(q)) return { rows: [{ sheetless: true }] };
      if (/JOIN order_submissions os ON os\.id = cp\.order_submission_id/.test(q)) return { rows };
      if (/FROM payment_batch_items/.test(q)) return { rows: pay };
      return { rows: [] };
    },
  };
}

(async () => {
  const calls = { retire: null, cancel: null, rebuild: 0 };
  const orig = { retire: partMod.retireRows, cancel: ledgerSvc.softDeleteDuplicateOrders };
  partMod.retireRows = async (a) => { calls.retire = a; return { retired: (a.seqs || []).length }; };
  ledgerSvc.softDeleteDuplicateOrders = async (ids) => { calls.cancel = ids; return (ids || []).length; };

  try {
    console.log('\n[A] 같은 주문 기록을 여러 줄이 씀 — 원장 주문번호가 없어도 잡는다');
    {
      // 실측 그대로: 한 주문(os-1)이 7줄, 원장 주문번호 빈 값, 표 주문번호는 줄마다 다름
      const rows = [
        R({ seq: 117, osid: 'os-1', roword: '2026080552706861', submitted: true, paid: true }),
        ...[161, 173, 183, 193, 203, 213].map(s => R({ seq: s, osid: 'os-1', roword: '2026081822051841' })),
      ];
      led.__setPoolForTest(stub(rows));
      const p = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T', dryRun: true });
      ok('한 덩어리로 잡는다(7줄 → 6줄 정리 대상)',
        p.groups === 1 && p.removeRows === 6 && p.plan[0].keepSeq === 117);
      ok('★ 원장 주문번호가 비어도 대상이다(종전 6자리 필터로는 조회조차 안 됐다)',
        rows.every(r => !r.ordnum));
      ok('★ 가장 이른 줄(실제 리뷰제출·입금된 줄)을 남긴다',
        p.plan[0].removeSeqs.join() === '161,173,183,193,203,213');
      ok('어느 규칙으로 묶였는지 말한다', (p.byAxis || {}).order === 1 && !(p.byAxis || {}).keys);
      led.__setPoolForTest(null);
    }

    console.log('\n[B] ★★ 남길 줄이 쓰는 주문은 취소하지 않는다 (주문 소실 차단)');
    {
      const rows = [
        R({ seq: 10, osid: 'os-1', roword: 'AAAAAA111111', submitted: true }),
        R({ seq: 20, osid: 'os-1', roword: 'BBBBBB222222' }),
      ];
      led.__setPoolForTest(stub(rows));
      calls.retire = null; calls.cancel = null;
      const run = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T', dryRun: false, by: '망고' });
      ok('줄은 내린다', calls.retire && calls.retire.seqs.join() === '20' && run.removed === 1);
      ok('★★ 같은 주문을 남길 줄이 쓰므로 취소 대상 0 (넘기면 살아남은 줄의 주문이 사라진다)',
        Array.isArray(calls.cancel) && calls.cancel.length === 0 && run.cancelOrders === 0);
      led.__setPoolForTest(null);
    }
    {
      // ㉮ 축(재제출 = 주문이 서로 다름)에서는 종전대로 취소한다 — 무회귀
      const rows = [
        R({ seq: 10, osid: 'os-a', ordnum: '111111111', roword: '111111111', submitted: true }),
        R({ seq: 20, osid: 'os-b', ordnum: '111111111', roword: '111111111' }),
      ];
      led.__setPoolForTest(stub(rows));
      calls.cancel = null;
      const run = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T', dryRun: false, by: '망고' });
      ok('★ 재제출 중복은 종전대로 그 주문만 취소', calls.cancel.join() === 'os-b' && run.cancelOrders === 1);
      led.__setPoolForTest(null);
    }

    console.log('\n[C] 보류 규칙은 ㉯ 에도 그대로');
    {
      const rows = [
        R({ seq: 45, osid: 'os-1', roword: 'AAAAAA111111', submitted: true, paid: true, in_payment: true }),
        R({ seq: 123, osid: 'os-1', roword: 'BBBBBB222222', submitted: true, paid: true, in_payment: true }),
      ];
      led.__setPoolForTest(stub(rows, { pay: [{ seq: 123, status: 'paid', amount: 9900, batchSeq: 3 }] }));
      const p = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T', dryRun: true });
      ok('★ 지울 줄이 이체 회차에 담겼으면 손대지 않고 사유로 보고',
        p.removeRows === 0 && p.skippedGroups === 1 && p.skipped[0].reason === 'in_payment_batch');
      led.__setPoolForTest(null);
    }
    {
      const rows = [
        R({ seq: 5, osid: 'os-1', roword: 'AAAAAA111111' }),
        R({ seq: 9, osid: 'os-1', roword: 'BBBBBB222222', submitted: true }),
      ];
      led.__setPoolForTest(stub(rows));
      const p = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T', dryRun: true });
      ok('★ 실제로 쓰인 줄이 뒤에 있으면 사람이 고르게 한다',
        p.removeRows === 0 && p.skipped[0].reason === 'used_row_is_not_first');
      led.__setPoolForTest(null);
    }

    console.log('\n[D] 두 축이 겹치면 한 덩어리 — 같은 줄을 두 번 지우지 않는다');
    {
      const rows = [
        R({ seq: 1, osid: 'os-a', ordnum: '999999999', roword: '999999999', submitted: true }),
        R({ seq: 2, osid: 'os-a', ordnum: '999999999', roword: '999999999' }),   // 두 축 모두 해당
        R({ seq: 3, osid: 'os-b', ordnum: '999999999', roword: '999999999' }),   // ㉮ 로만
      ];
      led.__setPoolForTest(stub(rows));
      const p = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T', dryRun: true });
      ok('한 그룹으로 합쳐 결정을 한 번만 내린다', p.groups === 1 && p.plan[0].keepSeq === 1);
      ok('지울 줄이 중복 없이 한 번씩', p.plan[0].removeSeqs.join() === '2,3' && p.removeRows === 2);
      ok('두 규칙 모두 표기', (p.byAxis || {}).keys === 1 && (p.byAxis || {}).order === 1);
      led.__setPoolForTest(null);
    }

    console.log('\n[E] 무회귀 — ㉯ 대상이 없으면 종전과 같다');
    {
      const rows = [
        R({ seq: 1, osid: 'os-a', ordnum: '111111111', roword: '111111111' }),
        R({ seq: 2, osid: 'os-b', ordnum: '222222222', roword: '222222222' }),
        R({ seq: 3, osid: 'os-c', ordnum: '333333333', roword: '' }),   // 표 주문번호 없음 → 제외
      ];
      led.__setPoolForTest(stub(rows));
      const p = await led.dedupeRows({ sheetId: 'wt_x', tabName: 'T', dryRun: true });
      ok('서로 다른 구매는 건드리지 않는다', p.groups === 0 && p.removeRows === 0);
      ok('★ 표에 주문번호가 없는 줄은 종전대로 대상에서 제외하고 건수를 고지',
        p.skippedNoRowOrder === 1);
      led.__setPoolForTest(null);
    }
  } finally {
    partMod.retireRows = orig.retire; ledgerSvc.softDeleteDuplicateOrders = orig.cancel;
    led.__setPoolForTest(null);
  }

  console.log('\n[F] 화면 — 규칙을 말한다(조용한 의미 변경 금지)');
  {
    const fs = require('fs'), path = require('path');
    const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
    ok('★ 안내 문구가 두 규칙을 모두 말한다',
      /같은 주문 기록을 여러 줄이 씀/.test(HTML) && /셋 다 같음/.test(HTML));
    ok('★ 확인창도 두 규칙을 말한다', /㉯ 같은 주문 기록을 여러 줄이 쓰는 경우/.test(HTML));
    ok('★ 규칙 표기는 서버 matchedBy 를 라벨로만 바꾼다(프론트 재판정 0)',
      /const _DD_AXIS = \{ keys: '주문번호 3키', order: '같은 주문 기록' \}/.test(HTML)
      && /_ddAxis\(g\.matchedBy\)/.test(HTML));
    /* 창 정돈(사용자 신고 2026-08-19 "세로가 너무 길어서 조작이 어려움") — 되돌리면 다시 못 쓴다. */
    ok('★ 폭·높이 확대는 이 모달에만(다른 wbl 모달 기본값 불변)',
      /#ddOv \.wbl-dlg\{width:min\(\d{3,4}px,100%\);max-height:86vh/.test(HTML)
      && /\.wbl-dlg\{width:min\(460px,100%\)/.test(HTML));
    ok('★★ 본문만 스크롤 — flex 자식 min-height:0(없으면 창이 끝없이 길어진다)',
      /#ddOv \.wbl-db\{flex:1;min-height:0;overflow:auto\}/.test(HTML));
    ok('★ 작업명은 한 줄로 자르고 전체는 title 로 남긴다(줄 높이 폭발 방지)',
      /#ddOv table\.wbl-t td:first-child\{max-width:\d+px;overflow:hidden;text-overflow:ellipsis\}/.test(HTML)
      && /<td title="\$\{esc\(t\.label \|\| t\.tabName\)\}"/.test(HTML));
    ok('★ 판정 규칙은 접어 두되 문장은 그대로 남긴다(조용한 의미 변경 금지)',
      /<details class="wbl-facts" id="ddRuleBox">/.test(HTML) && /같은 주문 기록을 여러 줄이 씀/.test(HTML));
    /* 열을 끼워 넣을 때 가장 흔히 깨지는 자리 — 헤더 칸 수 ≡ 행 칸 수 */
    const head = (HTML.match(/<th>참여자<\/th>[\s\S]{0,220}?<\/tr>/) || [''])[0];
    const body = (HTML.match(/\(p\.plan \|\| \[\]\)\.map\(g =>[\s\S]{0,600}?\)\.join\(''\)/) || [''])[0];
    ok('헤더 칸 수 ≡ 행 칸 수',
      (head.match(/<th>/g) || []).length === (body.match(/<td/g) || []).length);
  }

  console.log(`\n✅ dedupeOrderLinkAxis ${pass} 케이스 통과`);
  process.exit(0);
})().catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });
