/**
 * 양방향 1단계(2026-10-20) — 원본 수정의 조용한 유실·교착 막기.
 *   A. 정적 — 409 code 3종, 두 UPDATE 의 번호 조건(CAS), 0행 처리, 잠금 순서(L1 → 행) 6곳
 *   B. PGTEST_URL(전체 마이그레이션 DB) 있으면 진짜 PG + 실제 라우트:
 *      같은 번호·같은 키 = 멱등 · 같은 번호·다른 키 = 409 revision_already_applied(저장 안 함) · 옛 번호 = revision_stale ·
 *      건너뛴 번호 = revision_gap · 같은 번호 동시 2건 = 한 건만 반영 · 첫 수신(POST) 재전송도 같은 규칙
 *   C. PGTEST_URL 있으면 진짜 PG 교착 시험 — 오더 쪽·공고 쪽 인원 동기화와 보관 해제를 두 연결에서 엇갈려 반복 → 교착(40P01) 0
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

// ── A. 정적 ──
{
  const ord = read('routes/order.routes.js');
  assert.ok(/code: source\.sourceRevision === currentRevision \? 'revision_already_applied' : 'revision_stale'/.test(ord), 'PUT: 같은 번호 다른 키 = revision_already_applied');
  assert.ok(/code: 'revision_gap'/.test(ord));
  assert.ok(/Number\(existing\.source_revision \|\| 0\) === sourceContract\.sourceRevision\s*\? 'revision_already_applied' : 'source_exists'/.test(ord), 'POST 재전송도 같은 code');
  assert.ok(/AND COALESCE\(source_revision, 0\) = \$\{add\(currentRevision\)\}/.test(ord), '부분 수정 UPDATE 번호 조건');
  assert.ok(/WHERE id = \$1 AND source_review_order_id = \$40 AND COALESCE\(source_revision, 0\) = \$46/.test(ord), '전체 수정 UPDATE 번호 조건');
  assert.ok(/if \(!linked\) return _sourceRevisionRaceResponse\(res, sourceReviewOrderId, source\);/.test(ord), '부분 수정 0행 = 성공으로 접지 않음');
  assert.ok(/if \(!updated\) return _sourceRevisionRaceResponse\(res, sourceReviewOrderId, source\);/.test(ord), '전체 수정 0행 = 성공으로 접지 않음');
  const fullAt = ord.indexOf('if (!updated) return _sourceRevisionRaceResponse');
  assert.ok(fullAt > 0 && fullAt < ord.indexOf('await syncWorkOrderRecruitTotal({ workOrderId: updated.id', fullAt), '0행이면 인원 동기화 전에 끝낸다');

  const L1 = /lockWorkOrderCampaigns\(/;
  const order = (src, fnName, rowLockRe) => {
    const s = src.indexOf(`async function ${fnName}(`); assert.ok(s >= 0, fnName);
    const body = src.slice(s, src.indexOf('\n}\n', s));
    const iL1 = body.search(L1), iRow = body.search(rowLockRe);
    assert.ok(iL1 > -1 && iRow > -1 && iL1 < iRow, `${fnName}: L1 이 행 잠금보다 먼저`);
  };
  const lrq = read('services/linkedRecruitQuota.service.js');
  order(lrq, 'assertWorkOrderQuota', /FROM work_orders WHERE id=\$1 FOR UPDATE/);
  order(lrq, 'syncWorkOrderRecruitTotal', /FROM work_orders WHERE id=\$1 FOR UPDATE/);
  order(lrq, 'syncCampaignRecruitTotal', /FROM recruit_campaigns WHERE id=\$1 FOR UPDATE/);
  order(lrq, 'guardWorkOrderLinkChange', /FROM work_orders WHERE id = \$1 FOR UPDATE/);
  assert.ok(/if \(!preWoIds\.includes\(order\.id\)\)/.test(lrq), '공고 쪽 동기화: 잠근 뒤 짝이 바뀌면 재시도');
  order(read('services/campaignArchive.service.js'), 'unarchiveCampaign', /FROM recruit_campaigns WHERE id = \$1 FOR UPDATE/);
  const pay = read('services/campaignPayAmountSync.service.js');
  for (const fn of ['syncCampaignPayAmount', 'syncCampaignThumbnail', 'syncCampaignInflow', 'syncCampaignPurchaseWindow']) {
    order(pay, fn, /FROM work_orders WHERE id = \$1 FOR UPDATE/);
  }
}

async function pgRoutes() {
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const srv = app.listen(0);
  const port = srv.address().port;
  const sid = 'ro_rev_' + Date.now();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const base = (rev, key, extra = {}) => ({
    source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: rev, idempotency_key: key,
    title: '가짜 오더', recruit_count: 0, ...extra });
  try {
    const c1 = await call('POST', '/api/order/intake', base(1, `${sid}:1:aaaa`));
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    const re1 = await call('POST', '/api/order/intake', base(1, `${sid}:1:aaaa`));
    assert.equal(re1.body.idempotent, true, 'POST 같은 시도 = 멱등');
    const re2 = await call('POST', '/api/order/intake', base(1, `${sid}:1:bbbb`, { title: '고친 내용' }));
    assert.equal(re2.status, 409); assert.equal(re2.body.code, 'revision_already_applied', 'POST 같은 번호 다른 내용 = 이미 반영됨(멱등 성공 아님)');

    const put = (rev, key, extra) => call('PUT', `/api/order/intake/source/${sid}`, base(rev, key, extra));
    const p2 = await put(2, `${sid}:2:cccc`, { title: '두번째' });
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.equal((await put(2, `${sid}:2:cccc`, { title: '두번째' })).body.idempotent, true, 'PUT 같은 시도 = 멱등');
    const lost = await put(2, `${sid}:2:dddd`, { title: '응답 놓친 뒤 고친 내용' });
    assert.equal(lost.status, 409); assert.equal(lost.body.code, 'revision_already_applied');
    const t = (await pool.query('SELECT title, source_revision FROM work_orders WHERE source_review_order_id=$1', [sid])).rows[0];
    assert.deepEqual([t.title, Number(t.source_revision)], ['두번째', 2], '다른 내용은 그 번호로 쓰지 않는다');
    assert.equal((await put(1, `${sid}:1:eeee`)).body.code, 'revision_stale');
    assert.equal((await put(5, `${sid}:5:ffff`)).body.code, 'revision_gap');
    // 같은 번호 동시 2건(내용 다름) — 한 건만 반영, 다른 하나는 409(성공으로 접지 않음)
    const [a, b] = await Promise.all([put(3, `${sid}:3:g1`, { title: 'A' }), put(3, `${sid}:3:g2`, { title: 'B' })]);
    const oks = [a, b].filter(x => x.status === 200 && !x.body.idempotent);
    assert.equal(oks.length, 1, `동시 2건 중 한 건만 반영: ${JSON.stringify([a.body, b.body])}`);
    const other = [a, b].find(x => x !== oks[0]);
    assert.equal(other.status, 409, '나머지는 409');
    assert.ok(['revision_already_applied', 'revision_race'].includes(other.body.code));
    const fin = (await pool.query('SELECT title, source_revision FROM work_orders WHERE source_review_order_id=$1', [sid])).rows[0];
    assert.equal(Number(fin.source_revision), 3);
    assert.equal(fin.title, oks[0] === a ? 'A' : 'B', '반영된 쪽 내용이 남는다');
    console.log('sourceRevisionSafety: PG routes passed');
  } finally {
    srv.close();
    await pool.query('DELETE FROM work_orders WHERE source_review_order_id=$1', [sid]).catch(() => {});
  }
}

async function pgDeadlock() {
  const pool = require('../src/db/pool');
  const lrq = require('../src/services/linkedRecruitQuota.service');
  const arch = require('../src/services/campaignArchive.service');
  const wo = 'wo_dl_' + Date.now(), camp = 'camp_dl_' + Date.now();
  await pool.query(`INSERT INTO work_orders (id, title, recruit_count) VALUES ($1, '가짜 교착 시험', 10)`, [wo]);
  await pool.query(`INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total) VALUES ($1, '가짜 공고', $2, 10)`, [camp, wo]);
  await pool.query(`UPDATE work_orders SET linked_campaign_id=$2 WHERE id=$1`, [wo, camp]);
  await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, recruit_total, status) VALUES ($1, '가짜옵션', 10, 'active')`, [camp]);
  let deadlocks = 0, ok = 0;
  try {
    for (let i = 0; i < 40; i++) {
      const n = 10 + (i % 5);
      const rs = await Promise.allSettled([
        lrq.syncWorkOrderRecruitTotal({ workOrderId: wo, recruitTotal: n }),
        lrq.syncCampaignRecruitTotal({ campaignId: camp, recruitTotal: n, skipWorktable: true }),
        arch.unarchiveCampaign(pool, camp),
      ]);
      for (const r of rs) {
        if (r.status === 'rejected') { if (r.reason && r.reason.code === '40P01') deadlocks++; else throw r.reason; } else ok++;
      }
    }
    assert.equal(deadlocks, 0, '교착 0');
    console.log(`sourceRevisionSafety: PG deadlock test passed (${ok} ok, 0 deadlocks)`);
  } finally {
    await pool.query('DELETE FROM campaign_options WHERE campaign_id=$1', [camp]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id=$1', [camp]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE id=$1', [wo]).catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) {
    await pgRoutes();
    await pgDeadlock();
    await require('../src/db/pool').end().catch(() => {});
  }
  console.log('sourceRevisionSafety: passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
