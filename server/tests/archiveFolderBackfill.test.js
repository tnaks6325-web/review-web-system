'use strict';
/**
 * 예전 ⬛ 보관 작업 폴더 백필의 판정(locate) — 결정 294 · migration 204.
 *   ★ 남의 작업 폴더를 붙이지 않는다(fail-closed): 후보가 여럿이면 캠페인명으로만 좁히고, 확인 실패·잘린 목록은 건너뛴다.
 */
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const m = require('../scripts/backfill-archive-folder-urls');
let pass = 0;
const t = (n, c, x) => { assert.ok(c, n + (x ? ' — ' + x : '')); console.log('  ✓ ' + n); pass++; };
const ROOT = 'ROOT';
function stub({ hits, parents, kids, failParent }) {
  return {
    async searchFolders() { return hits; },
    async getFileParents(id) { if (failParent && failParent.includes(id)) throw new Error('일시 장애'); return parents[id]; },
    async listFolderContents(id) { return kids[id] || []; },
  };
}
const row = { tab_name: 'T', campaign_name: '8/14 캠페인A' };
const base = {
  hits: [{ id: 'tA', name: 'T', parents: ['cA'] }, { id: 'tB', name: 'T', parents: ['cB'] }],
  parents: { cA: { name: '8 14 캠페인A', parents: [ROOT] }, cB: { name: '캠페인B', parents: [ROOT] } },
  kids: { tA: [{ id: 'rA', name: '[리뷰]' }, { id: 'pA', name: '[구매캡처]' }], tB: [{ id: 'rB', name: '[리뷰]' }, { id: 'pB', name: '[구매캡처]' }] },
};
(async () => {
  m.__setForTest(stub(base), ROOT);
  let r = await m.locate(row);
  t('같은 탭명이 두 캠페인에 있으면 캠페인명(공백·슬래시 무시)이 같은 쪽만', r.status === 'found' && r.review === 'rA' && r.capture === 'pA', JSON.stringify(r));
  m.__setForTest(stub({ ...base, failParent: ['cA'] }), ROOT);
  r = await m.locate(row);
  t('★★ 후보 하나의 부모 확인이 실패하면 건너뛴다(남은 다른 캠페인 폴더를 유일 후보로 오인 금지 — Codex P2)', r.status === 'error' && !r.review, JSON.stringify(r));
  m.__setForTest(stub({ ...base, parents: { ...base.parents, cA: { name: '다른이름', parents: [ROOT] } } }), ROOT);
  r = await m.locate(row);
  t('여럿인데 캠페인명이 하나도 안 맞으면 건너뛴다', r.status === 'ambiguous', JSON.stringify(r));
  m.__setForTest(stub({ ...base, hits: Array.from({ length: 100 }, (_, i) => ({ id: 'x' + i, name: 'T', parents: ['cA'] })) }), ROOT);
  r = await m.locate(row);
  t('검색 목록이 상한에 닿으면(잘림) 건너뛴다', r.status === 'error', JSON.stringify(r));
  m.__setForTest(stub({ ...base, hits: [{ id: 'tA', name: 'T', parents: ['cA'] }, { id: 'tZ', name: 'T', parents: ['cZ'] }], parents: { ...base.parents, cZ: { name: 'x', parents: ['ELSEWHERE'] } } }), ROOT);
  r = await m.locate(row);
  t('루트 2단계 밖의 같은 이름 폴더는 후보가 아니다', r.status === 'found' && r.review === 'rA', JSON.stringify(r));
  m.__setForTest(stub({ ...base, hits: [{ id: 'tA', name: 'T', parents: ['cA'] }], kids: { tA: [{ id: 'r1', name: '[리뷰]' }, { id: 'r2', name: '[리뷰]' }, { id: 'pA', name: '[구매캡처]' }] } }), ROOT);
  r = await m.locate(row);
  t('[리뷰] 가 둘이면 그 칸은 비운다(구매캡처만)', r.status === 'found' && r.review === null && r.capture === 'pA', JSON.stringify(r));
  m.__setForTest(stub({ ...base, hits: [{ id: 'tA2', name: 'T 2', parents: ['cA'] }] }), ROOT);
  r = await m.locate(row);
  t('이름이 비슷하기만 한 폴더(부분일치)는 쓰지 않는다', r.status === 'none', JSON.stringify(r));
  console.log(`\n✅ ${pass} 케이스 통과`);
})().catch(e => { console.error(e); process.exit(1); });
