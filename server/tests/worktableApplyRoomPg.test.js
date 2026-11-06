'use strict';
/* 결정 340 — 모집공고 신청 = 작업표 자리 관문. 진짜 SQL(pglite)로 고정한다.
 *  K1 키오스킨 재현(정원 N=50 · 직원이 넣은 줄 k=4가 자리 차지) — N−k 번째까지 받고 N−k+1 번째는 거절.
 *     ★ 그 4줄이 주문 기록 없이 찬 줄이면 기존 주문 원장 총량 관문(totalQuotaUsage)은 아직 「안 참」으로 본다 — 이 관문이 막는다.
 *     ★ 4줄이 외부모집 수동제출 주문이면 기존 관문(2026-09-08~)도 이미 「참」 — 두 관문 모두 막는다(사고 경로 재현).
 *  K2 진행 중 홀드 = 아직 줄 없는 신청으로 자리를 맡는다(만료 홀드·다른 작업표 홀드는 안 셈) · 본인 같은 공고 홀드는 빼고 센다.
 *  K3 줄 기다리는 주문(끝나지 않은 workboard_apply · 줄 미연결 · 살아 있는 주문)도 자리를 맡는다 · 빈 줄 없음 보류 주문 포함.
 *  K4 빈 줄 판정 = 실제 줄 고르기와 같은 범위(다른 작업보드 줄 제외 · 작업보드가 빈 줄 포함 · 보류/지운 줄 제외).
 *  K5 시트 작업 · 활성 작업보드 없음 · 작업표 연결 없음 = 관문 대상 아님(종전).
 *  K6 fail-open — 조회 실패·값 이상은 막지 않는다 · 끄는 스위치.
 *  W  배선 — 잠금 안 · 다른 관문 뒤 · 홀드 INSERT 앞 · SAVEPOINT · 블로그/Q&A 제외 · 리뷰어 문구는 기존 soft_full 문구.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE workboards(id uuid PRIMARY KEY, state text);
    CREATE TABLE tab_configs(id serial, sheet_id text, tab_name text, sheetless boolean DEFAULT true, workboard_id uuid, UNIQUE(sheet_id, tab_name));
    CREATE TABLE campaign_participants(id serial, sheet_id text, tab_name text, seq int, deleted_at timestamptz,
      active boolean DEFAULT true, order_submission_id uuid, reviewer_name text, recipient_name text, phone8 text, workboard_id uuid);
    CREATE TABLE recruit_campaigns(id text PRIMARY KEY, linked_sheet_id text, linked_tab_name text);
    CREATE TABLE campaign_applications(id serial, campaign_id text, phone8 text, status text, expires_at timestamptz);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz, mirror_status text, source text);
    CREATE TABLE sync_queue(id serial PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, status text DEFAULT 'pending', error_msg text);
  `);
  const q = async (sql, params) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; };
  const pool = { query: q };
  const svc = require('../src/services/worktableApplyRoom.service');
  const { totalQuotaUsage } = require('../src/services/campaignState.service');
  const { NO_SLOT_QUEUE_ERROR } = require('../src/utils/workboardNoSlot');

  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
  const WB = '00000000-0000-4000-8000-0000000000aa';
  const WB2 = '00000000-0000-4000-8000-0000000000bb';
  await q(`INSERT INTO workboards VALUES ($1,'active'), ($2,'active')`, [WB, WB2]);
  let tabNo = 0;
  const mkTable = async ({ rows, sheetless = true, wb = WB, campaignId } = {}) => {
    tabNo++;
    const tab = { sheetId: 'wt_' + tabNo, tabName: `82번행_키오스킨 마스크팩 1차 ${tabNo}`, campaignId: campaignId || ('camp_k' + tabNo) };
    await q(`INSERT INTO tab_configs(sheet_id, tab_name, sheetless, workboard_id) VALUES ($1,$2,$3,$4)`, [tab.sheetId, tab.tabName, sheetless, wb]);
    await q(`INSERT INTO recruit_campaigns VALUES ($1,$2,$3)`, [tab.campaignId, tab.sheetId, tab.tabName]);
    for (let s = 1; s <= rows; s++) {
      await q(`INSERT INTO campaign_participants(sheet_id, tab_name, seq, workboard_id) VALUES ($1,$2,$3,$4)`, [tab.sheetId, tab.tabName, s, wb]);
    }
    return tab;
  };
  // 맨 앞 빈 줄 하나를 채운다 — withOrder=true 면 주문 기록이 붙은 줄(외부모집 수동제출·리뷰어 구매), false 면 이름만 적은 줄
  const fillOne = async (tab, { withOrder = true, source = 'order_submit', name = '채움', phone8 = '11112222' } = {}) => {
    let osId = null;
    if (withOrder) osId = (await q(`INSERT INTO order_submissions(mirror_status, source) VALUES ('written',$1) RETURNING id`, [source])).rows[0].id;
    const r = await q(`UPDATE campaign_participants SET order_submission_id=$3, reviewer_name=$4, phone8=$5
                        WHERE id = (SELECT id FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND order_submission_id IS NULL
                                      AND reviewer_name IS NULL AND phone8 IS NULL AND deleted_at IS NULL AND active ORDER BY seq LIMIT 1)`,
      [tab.sheetId, tab.tabName, osId, name, phone8]);
    assert.equal(r.rowCount, 1, '채울 빈 줄이 있어야 한다');
  };
  const room = (tab, phone8 = '99990000', campaignId = tab.campaignId) =>
    svc.worktableRoomForApply(pool, { sheetId: tab.sheetId, tabName: tab.tabName, campaignId, phone8 });
  const hold = (campaignId, phone8, mins = 15) =>
    q(`INSERT INTO campaign_applications(campaign_id, phone8, status, expires_at) VALUES ($1,$2,'applied', NOW() + make_interval(mins => $3::int))`, [campaignId, phone8, mins]);
  const waitOrder = async (tab, { status = 'pending', errorMsg = null, mirror = 'queued', deleted = false } = {}) => {
    const id = (await q(`INSERT INTO order_submissions(mirror_status, deleted_at, source) VALUES ($1, ${deleted ? 'NOW()' : 'NULL'}, 'order_submit') RETURNING id`, [mirror])).rows[0].id;
    await q(`INSERT INTO sync_queue(type, payload, status, error_msg) VALUES ('workboard_apply', $1, $2, $3)`,
      [JSON.stringify({ sheetId: tab.sheetId, tabName: tab.tabName, orderSubmissionId: id }), status, errorMsg]);
    return id;
  };

  console.log('\n[결정 340 · 모집공고 신청 = 작업표 자리 관문 · 실 SQL]');

  await t('K1 키오스킨 재현 — 정원 50 · 직원이 넣은 줄 4개 → 46명까지 받고 47번째(N−k+1) 신청은 거절', async () => {
    const N = 50, k = 4;
    const tab = await mkTable({ rows: N });
    for (let i = 0; i < k; i++) await fillOne(tab, { withOrder: false, name: '외부모집 직원 입력' });   // 주문 기록 없이 찬 줄
    let accepted = 0;
    for (let i = 1; i <= N; i++) {
      const v = await room(tab, String(30000000 + i));
      if (svc.isFull(v)) {
        assert.equal(i, N - k + 1, `거절은 정확히 ${N - k + 1}번째 신청에서`);
        assert.deepEqual([v.applies, v.known, v.openSlots, v.holds, v.waitingOrders, v.room], [true, true, 0, 0, 0, 0]);
        break;
      }
      accepted++;
      await fillOne(tab, { name: '리뷰어' + i });   // 그 리뷰어가 사서 구매양식 → 줄에 들어감
    }
    assert.equal(accepted, N - k, '받은 신청 = 남은 자리 수');
    // ★ 기존(종전) 주문 원장 총량 관문은 이 순간을 「안 참」으로 본다 — 주문 기록 없이 찬 4줄을 못 센다(이 관문이 필요한 이유)
    const counts = { submittedAll: N - k, activeHolds: 0, linked: { ok: true, orders: N - k, sharedTab: false } };
    const old = totalQuotaUsage({ recruit_total: N, linked_sheet_id: tab.sheetId, linked_tab_name: tab.tabName }, counts);
    assert.equal(old.full, false, '종전 관문만으로는 47번째 신청을 받는다');
  });

  await t('K1b 사고 그 경로(직원 4줄 = 외부모집 수동제출 주문) — 두 관문 모두 47번째에서 막는다', async () => {
    const N = 50, k = 4;
    const tab = await mkTable({ rows: N });
    for (let i = 0; i < k; i++) await fillOne(tab, { withOrder: true, source: 'admin_external', name: '외부모집' });
    for (let i = 1; i <= N - k; i++) await fillOne(tab, { name: '리뷰어' + i });
    assert.equal(svc.isFull(await room(tab)), true, '작업표 자리 관문');
    const counts = { submittedAll: N - k, activeHolds: 0, linked: { ok: true, orders: N, sharedTab: false } };
    assert.equal(totalQuotaUsage({ recruit_total: N, linked_sheet_id: tab.sheetId, linked_tab_name: tab.tabName }, counts).full, true,
      '주문 원장 관문(2026-09-08~)도 이미 막는다 — 사고 당시(8/28~9/2)는 관측만이었다');
  });

  await t('K2 진행 중 홀드가 자리를 맡는다 · 만료 홀드는 안 셈 · 본인 같은 공고 홀드는 빼고 센다', async () => {
    const tab = await mkTable({ rows: 3 });
    await hold(tab.campaignId, '20000001');
    await hold(tab.campaignId, '20000002');
    await q(`INSERT INTO campaign_applications(campaign_id, phone8, status, expires_at) VALUES ($1,'20000009','applied', NOW() - interval '1 minute')`, [tab.campaignId]);
    await q(`INSERT INTO campaign_applications(campaign_id, phone8, status, expires_at) VALUES ($1,'20000008','submitted', NOW() + interval '1 hour')`, [tab.campaignId]);
    let v = await room(tab);
    assert.deepEqual([v.openSlots, v.holds, v.room, svc.isFull(v)], [3, 2, 1, false], '빈 줄 3 − 홀드 2 = 1 → 받는다');
    await hold(tab.campaignId, '20000003');
    v = await room(tab);
    assert.deepEqual([v.holds, v.room, svc.isFull(v)], [3, 0, true], '홀드 3개 = 남은 자리 0 → 거절');
    v = await room(tab, '20000003');
    assert.deepEqual([v.holds, v.room, svc.isFull(v)], [2, 1, false], '이미 자리를 잡은 본인은 막지 않는다(「이미 참여 중」 이어 열기)');
    // 같은 작업표를 쓰는 다른 공고의 홀드도 센다 · 다른 작업표 공고의 홀드는 안 센다
    const other = await mkTable({ rows: 1 });
    await hold(other.campaignId, '20000004');
    assert.equal((await room(tab, '20000003')).holds, 2, '다른 작업표 홀드 미포함');
    await q(`INSERT INTO recruit_campaigns VALUES ('camp_shared', $1, $2)`, [tab.sheetId, tab.tabName]);
    await hold('camp_shared', '20000005');
    assert.equal((await room(tab, '20000003')).holds, 3, '같은 작업표를 쓰는 다른 공고 홀드 포함');
    assert.equal((await room(tab, '20000003', 'camp_other')).holds, 4, '본인 제외는 같은 공고일 때만');
  });

  await t('K3 줄을 기다리는 주문이 자리를 맡는다 — 빈 줄 없음 보류 포함 · 끝난·줄 붙은·취소된 주문은 안 셈', async () => {
    const tab = await mkTable({ rows: 4 });
    await waitOrder(tab);                                                      // 방금 낸 구매양식(대기)
    await waitOrder(tab, { status: 'failed', errorMsg: NO_SLOT_QUEUE_ERROR, mirror: 'failed' });   // 빈 줄 없음 보류(결정 324)
    await waitOrder(tab, { status: 'done', mirror: 'written' });               // 끝남
    await waitOrder(tab, { deleted: true });                                   // 취소된 주문
    await waitOrder(tab, { mirror: 'canceled' });
    const linked = await waitOrder(tab, { status: 'processing' });             // 이미 줄에 붙음(완료 직전)
    await q(`UPDATE campaign_participants SET order_submission_id=$3, reviewer_name='붙음' WHERE sheet_id=$1 AND tab_name=$2 AND seq=4`, [tab.sheetId, tab.tabName, linked]);
    const v = await room(tab);
    assert.deepEqual([v.openSlots, v.waitingOrders, v.room, svc.isFull(v)], [3, 2, 1, false]);
    await hold(tab.campaignId, '21000001');
    assert.equal(svc.isFull(await room(tab)), true, '빈 줄 3 − 기다리는 주문 2 − 홀드 1 = 0 → 거절');
  });

  await t('K4 빈 줄 = 실제 줄 고르기와 같은 범위(다른 작업보드·보류·지운 줄 제외 · 작업보드 빈 줄 포함 · 연락처만 적힌 줄 제외)', async () => {
    const tab = await mkTable({ rows: 0 });
    const ins = (extra) => q(`INSERT INTO campaign_participants(sheet_id, tab_name, seq, workboard_id, active, deleted_at, phone8)
                              VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tab.sheetId, tab.tabName, extra.seq, extra.wb === undefined ? WB : extra.wb,
      extra.active !== false, extra.deleted ? new Date().toISOString() : null, extra.phone8 || null]);
    await ins({ seq: 1 });                        // 셈
    await ins({ seq: 2, wb: null });              // 작업보드가 빈 줄 — writer 가 고르기 전에 붙인다 → 셈
    await ins({ seq: 3, wb: WB2 });               // 다른 작업보드 줄 → 안 셈
    await ins({ seq: 4, active: false });         // 보류한 줄 → 안 셈
    await ins({ seq: 5, deleted: true });         // 지운 줄 → 안 셈
    await ins({ seq: 6, phone8: '12345678' });    // 연락처만 적힌 줄 → 안 셈
    assert.equal((await room(tab)).openSlots, 2);
  });

  await t('K5 시트 작업 · 활성 작업보드 없음 · 작업표 연결 없음 = 관문 대상 아님(종전)', async () => {
    const sheet = await mkTable({ rows: 0, sheetless: false });
    assert.deepEqual(await room(sheet), { applies: false, known: false, room: null });
    assert.equal(svc.isFull(await room(sheet)), false);
    const WB3 = '00000000-0000-4000-8000-0000000000cc';
    await q(`INSERT INTO workboards VALUES ($1,'archived')`, [WB3]);
    const archived = await mkTable({ rows: 0, wb: WB3 });
    assert.equal((await room(archived)).applies, false);
    assert.deepEqual(await svc.worktableRoomForApply(pool, { sheetId: '', tabName: '' }), { applies: false, known: false, room: null });
  });

  await t('K6 fail-open — 조회 실패는 던지고(호출부 SAVEPOINT 가 접음) 값 이상은 「모름」 · 끄는 스위치 = 조회 0', async () => {
    const boom = { query: async () => { throw new Error('relation does not exist'); } };
    await assert.rejects(() => svc.worktableRoomForApply(boom, { sheetId: 's', tabName: 't' }));
    const weird = { query: async () => ({ rows: [{ open_slots: null, holds: 'x', waiting_orders: undefined }] }) };
    const v = await svc.worktableRoomForApply(weird, { sheetId: 's', tabName: 't' });
    assert.deepEqual([v.applies, v.known, svc.isFull(v)], [true, false, false], '모르면 0 으로 꾸며 막지 않는다');
    assert.equal(svc.isFull(null), false);
    assert.equal(svc.isFull({ applies: true, known: true, room: 1 }), false);
    const prev = process.env.CAMPAIGN_WORKTABLE_ROOM_GATE;
    process.env.CAMPAIGN_WORKTABLE_ROOM_GATE = '0';
    let calls = 0;
    const counting = { query: async () => { calls++; return { rows: [] }; } };
    assert.deepEqual(await svc.worktableRoomForApply(counting, { sheetId: 's', tabName: 't' }), { applies: false, known: false, room: null });
    assert.equal(calls, 0);
    if (prev === undefined) delete process.env.CAMPAIGN_WORKTABLE_ROOM_GATE; else process.env.CAMPAIGN_WORKTABLE_ROOM_GATE = prev;
  });

  await t('W 배선 — 작업표 잠금 안 · 다른 관문 뒤 · 홀드 INSERT 앞 · SAVEPOINT fail-open · 블로그/Q&A 제외 · 기존 soft_full 문구', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
    const apply = src.slice(src.indexOf('async function _applyParticipation('), src.indexOf("router.post('/:id/apply'"));
    const at = apply.indexOf('worktableRoomForApply(client');
    assert.ok(at > 0, '신청 경로가 작업표 자리 관문을 부른다');
    assert.ok(apply.indexOf('camp_tab_daily:') < at, '작업표 잠금 뒤(마지막 한 자리 동시 신청 직렬화)');
    assert.ok(apply.indexOf("reason: 'popular_locked'") < at && apply.indexOf("reason: 'hold_cap'") < at, '다른 관문을 다 지난 뒤');
    assert.ok(at < apply.indexOf('INSERT INTO campaign_applications'), '홀드 INSERT 앞');
    const gate = apply.slice(apply.lastIndexOf('결정 340', at), apply.indexOf('// 홀드 생성:', at));
    assert.match(gate, /if \(!blogApply && !qnaApply && camp\.linked_sheet_id && camp\.linked_tab_name\)/);
    assert.match(gate, /SAVEPOINT wt_room/);
    assert.match(gate, /catch \(e\) \{\s*room = null;\s*try \{ await client\.query\('ROLLBACK TO SAVEPOINT wt_room'\)/, '조회 실패 = 모름 = 종전대로 받음(fail-open)');
    assert.ok(!/catch[\s\S]*ROLLBACK'\);[\s\S]*worktable_full/.test(gate.slice(0, gate.indexOf('roomSvc.isFull'))), '실패 갈래에서 거절하지 않는다');
    assert.match(gate, /phone8: holdP8/, '본인 홀드 제외는 명의 번호로');
    assert.match(gate, /roomSvc\.isFull\(room\)/);
    assert.match(gate, /reason: 'soft_full'/);
    assert.match(gate, /error: '지금은 신청할 수 없습니다\.'/, '상태 관문과 같은 문구');
    const page = fs.readFileSync(path.join(__dirname, '../../frontend/campaign.html'), 'utf8');
    assert.match(page, /soft_full:'잔여 대기 중이에요 — 자리가 나면 열려요'/, '리뷰어 화면은 기존 총원 충족 문구를 그대로 쓴다');
    const util = fs.readFileSync(path.join(__dirname, '../src/services/worktableApplyRoom.service.js'), 'utf8');
    assert.match(util, /openSlotCountSql\('tc\.sheet_id', 'tc\.tab_name'\)/, '빈 줄 판정은 단일 출처');
    assert.ok(!/order_submission_id IS NULL\s*AND NULLIF\(btrim/.test(util), '한 줄 판정 사본 없음');
  });

  console.log(`\nworktableApplyRoomPg: ${passed}/8 통과`);
  process.exit(passed === 8 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
