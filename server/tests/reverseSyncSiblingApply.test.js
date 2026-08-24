/**
 * 형제 제안 연속 적용 — 라우트를 **실제로 실행**해서 확인한다 (2026-08-23).
 *
 * 코드리뷰 지적(P1): detect 는 한 주문에서 어긋난 칸마다 제안을 만들되 **같은**
 *   detected_edit_seq·detected_sig 를 박는다(_replaceOpenProposalEdits). 그런데 apply 가
 *   order_submissions.last_edit_seq 를 올리므로, 두 번째 형제부터는 G6 stale 검사에 걸려
 *   **조용히 기각**됐다(status='dismissed'). 은행·계좌·예금주가 함께 깨진 행은 실측으로
 *   존재하는데(펫스토리로얄 45행 — 세 칸 모두), 담당자가 첫 칸밖에 못 고치고 나머지 두 건은
 *   목록에서 사라진다. 이 화면이 막으려던 바로 그 조용한 누락이다.
 *
 * 문자열 가드로는 "SQL 이 있다"까지만 말할 수 있어, 여기서는 스텁 pool 위에서 핸들러를
 * 연달아 호출해 **결과**를 본다.
 *
 * 실행: node tests/reverseSyncSiblingApply.test.js
 */
const assert = require('assert');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
function mock(id, exports) {
  const r = require.resolve(id);
  require.cache[r] = { id: r, filename: r, loaded: true, exports };
}

// ── 스텁 상태: 주문 1건 + 같은 회차 형제 제안 3건 + 다른 회차 제안 1건 ──────────
const order = { id: 'OS1', last_edit_seq: 100, deleted_at: null, mirror_status: 'synced' };
const P = (id, field, sig) => ({
  id, os_id: 'OS1', status: 'open', proposal_type: 'edit', field,
  old_value: 'old-' + field, new_value: 'new-' + field,
  detected_sig: sig, detected_edit_seq: 100,
});
const proposals = [
  P('P1', 'bank', 'SIG-A'), P('P2', 'account', 'SIG-A'), P('P3', 'depositor', 'SIG-A'),
  /* ★ 다른 감지 회차. 실제로는 detect 가 열린 제안을 통째 DELETE 후 재삽입하므로 한 주문에
     두 회차가 공존하지 않는다 — 그래도 넣는다. sig 조건이 빠져도 초록이면 가드가 아니다. */
  P('P9', 'memo', 'SIG-B'),
];
const find = id => proposals.find(x => x.id === id);
const enqueued = [];

mock(path.join(SRC, 'db/pool'), {
  query: async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM reverse_sync_proposals WHERE id = \$1 AND status = 'open'/.test(q)) {
      const p = find(params[0]);
      return { rows: p && p.status === 'open' ? [{ ...p }] : [] };
    }
    if (/^SELECT last_edit_seq, deleted_at FROM order_submissions/.test(q)) {
      return { rows: [{ last_edit_seq: order.last_edit_seq, deleted_at: order.deleted_at }] };
    }
    if (/^UPDATE order_submissions SET/.test(q)) {
      if (order.deleted_at) return { rows: [] };
      order.last_edit_seq = Math.max(Number(order.last_edit_seq) || 0, Number(params[2]));
      return { rows: [{ mirror_status: order.mirror_status }] };
    }
    if (/^UPDATE reverse_sync_proposals SET detected_edit_seq = \$3/.test(q)) {
      const [osId, selfId, newSeq, oldSeq, sig] = params;
      let n = 0;
      for (const p of proposals) {
        if (p.os_id !== osId || p.id === selfId) continue;
        if (p.status !== 'open' || p.proposal_type !== 'edit') continue;
        if (Number(p.detected_edit_seq) !== Number(oldSeq)) continue;
        if ((p.detected_sig == null ? null : p.detected_sig) !== (sig == null ? null : sig)) continue;
        p.detected_edit_seq = Number(newSeq); n++;
      }
      return { rowCount: n };
    }
    if (/^UPDATE reverse_sync_proposals SET status='(applied|dismissed)'/.test(q)) {
      const st = /applied/.test(q) ? 'applied' : 'dismissed';
      const p = find(params[0]); if (p) p.status = st;
      return { rowCount: p ? 1 : 0 };
    }
    throw new Error('스텁이 모르는 SQL: ' + q.slice(0, 90));
  },
  connect: async () => { throw new Error('이 경로는 connect 를 쓰지 않는다'); },
});
mock(path.join(SRC, 'utils/jobLock'), { withJobLock: async (_k, fn) => fn() });
mock(path.join(SRC, 'services/syncQueue.service'), {
  enqueue: async (kind, payload) => { enqueued.push({ kind, payload }); },
});
mock(path.join(SRC, 'jobs/queuePump'), { kickQueuePump: () => {} });

process.env.SHEET_REVERSE_SYNC = '1';
process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';

const router = require(path.join(SRC, 'routes/diag.routes'));
const layer = router.stack.find(l => l.route && l.route.path === '/reverse-sync-apply');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

/** 핸들러 1회 호출 → { code, body } */
async function apply(proposalId) {
  let code = 200, body = null;
  const res = { json: b => { body = b; }, status: c => { code = c; return res; } };
  await handler({ body: { proposalId }, admin: { name: 'tester' } }, res, e => { throw e; });
  return { code, body };
}

let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

(async () => {
  console.log('\n▶ 형제 제안 연속 적용 (라우트 실행)\n');

  console.log('1) 한 주문의 세 칸을 차례로 고칠 수 있다');
  const r1 = await apply('P1');
  t('첫 칸(은행) 적용됨', r1.code === 200 && r1.body && r1.body.ok === true, JSON.stringify(r1.body));

  const r2 = await apply('P2');
  t('★★ 둘째 칸(계좌) 적용됨 — 종전에는 여기서 stale 로 조용히 기각됐다',
    r2.code === 200 && r2.body && r2.body.ok === true, JSON.stringify(r2.body));

  const r3 = await apply('P3');
  t('★★ 셋째 칸(예금주)도 적용됨', r3.code === 200 && r3.body && r3.body.ok === true, JSON.stringify(r3.body));

  t('★ 세 건 모두 applied 로 남는다(사라지지 않는다)',
    ['P1', 'P2', 'P3'].every(id => find(id).status === 'applied'),
    ['P1', 'P2', 'P3'].map(id => id + '=' + find(id).status).join(','));
  t('★ 세 건 모두 시트 되쓰기 큐에 실린다', enqueued.length === 3 && enqueued.every(e => e.kind === 'order_update'),
    JSON.stringify(enqueued.map(e => e.kind)));

  console.log('\n2) 이월은 형제에 한정된다 — G6 를 없애는 게 아니다');
  const r9 = await apply('P9');
  t('★★ 다른 감지 회차(sig 불일치) 제안은 여전히 stale 로 거부된다',
    r9.code === 409 && r9.body && /stale/.test(String(r9.body.error)), JSON.stringify(r9.body));
  t('★ 그 건은 기각으로 정리된다(종전 동작 그대로)', find('P9').status === 'dismissed');

  console.log('\n3) 감지 뒤 바깥 편집이 끼어들면 여전히 막는다');
  proposals.push({ ...P('PX', 'price', 'SIG-C'), detected_edit_seq: 100 });
  order.last_edit_seq = 999999999999999;   // 담당자가 주문원장에서 직접 고친 상황
  const rx = await apply('PX');
  t('★★ 최신 편집을 옛 시트값으로 덮지 않는다',
    rx.code === 409 && rx.body && /stale/.test(String(rx.body.error)), JSON.stringify(rx.body));

  console.log(`\n▶ ${pass}건 통과`);
  console.log('reverseSyncSiblingApply tests passed');
  /* diag.routes 는 적재만으로 SSE·지연 쿼리 같은 열린 핸들을 남긴다 — 명시 종료하지 않으면
     스위트 러너가 이 파일에서 멈춘 채 기다린다(실제로 밟았다). */
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
