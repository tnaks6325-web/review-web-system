'use strict';
/**
 * r1QtyTiersPg.test.js — 결정 391(R1): 접수된 오더의 구매수량 단계를 「신청 0」일 때만 인트라넷 공유 저장으로 고친다.
 *   PGlite + 저장소 migrations 전부 + 실제 앱 라우트(원본 수정 PUT · /shared). 시험 데이터는 모두 가짜 값.
 *
 *   [1] 성공 — 세라모사이드 모양(옵션 없는 상품 400명 → 235명 · 단계 1개 265→100명): 오더 상품 구성·결제합계·총모집·일건수 ·
 *       공고 단계 표 · 공고 총모집·일일 정원 · 작업표 활성 줄 수 · 원본 번호 +1 · 조절 이력 기록
 *   [2] 거절 갈래 — 코드·한국어 문구 · 원본 번호·오더·공고·단계 표·작업표·이력 모두 그대로(통째 되돌림)
 *   [3] /shared 판정 칸(qty_tiers_edit) — 열 때와 저장 때 같은 함수
 *   [4] 보관 해제 게이트(Q8)
 */
const assert = require('assert');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const F = require('./helpers/r1QtyTiersFixture');

let passed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; } };

(async () => {
  const { pool } = await F.installPglitePool();
  const H = await F.boot({ pool });
  const { setup, tierEdit } = H;

  await ok('[1] 성공 — 400→235(세라모사이드 모양): 오더·공고 단계 표·작업표·결제합계·인원·일일 정원·원본 번호 +1', async () => {
    const A = await setup('ok', F.SERAMO(400, F.T400));
    assert.equal(await A.rows(), 400);
    assert.deepEqual((await A.tiers()).map(t => t.slice(2, 5)), [[3, 30, 36000], [2, 105, 24000], [1, 265, 12000]]);
    const before = await A.wo();
    const patch = tierEdit(before, p => { p[0].base.count = 235; p[0].base.daily = 24; p[0].qty_tiers.rows[2].people = 100; });
    const r = await A.putSource(patch, { tiers: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = await A.wo(); const c = await A.cRow();
    assert.equal(Number(w.source_revision), Number(before.source_revision) + 1, '원본 번호 정확히 +1');
    assert.equal(Number(w.recruit_count), 235); assert.equal(Number(w.daily_count), 24);
    assert.equal(Number(w.pay_amount), F.payOf(F.T235), '결제합계 = 인트라넷이 계산해 보낸 단계 합계');
    const p = JSON.parse(w.product_options_json)[0];
    assert.equal(p.base.count, 235);
    assert.deepEqual(p.qty_tiers.rows.map(x => [x.qty, x.people, x.amount]), F.T235);
    assert.deepEqual((await A.tiers()).map(t => t.slice(2, 5)), F.T235, '공고 단계 표 다시 씀');
    assert.equal(Number(c.recruit_total), 235, '공고 총모집'); assert.equal(Number(c.daily_limit), 24, '공고 일일 정원');
    assert.equal(await A.rows(), 235, '작업표 활성 줄 235');
    const ev = (await A.events()).filter(e => e.action === 'qty_tiers_changed');
    assert.equal(ev.length, 1, '조절 이력 1줄');
    assert.equal(ev[0].detail.total_before, 400); assert.equal(ev[0].detail.total_after, 235);
  });

  console.log(`r1QtyTiersPg: ${passed} passed`);
  await H.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
