/**
 * 초과 상태 공고의 저장 잠금 해제 (2026-08-24 사용자 확정)
 *
 * 신고: 채워진 줄이 정원보다 많은 공고(41/40)는 제목·리뷰비만 고쳐도 "실패"가 떴다.
 *   실제로는 저장이 다 커밋된 뒤 맨 끝의 정원 동기화에서만 터진 것이라, 담당자는
 *   실패한 줄 알고 같은 저장을 반복했다(본섭 실측 13개 작업).
 *
 * ★★ 확정 규칙(완화 금지)
 *   ① 공고 변동사항 저장 자체는 허용한다 — **총정원이 실제로 달라졌을 때만** 게이트를 태운다.
 *   ② 정원을 **줄이려는** 조작은 종전대로 막는다(판정 함수 두 겹 무접촉).
 *   ③ 이미 초과된 인원은 초과 상태로 유지한다 — 줄을 잘라 맞추지 않는다.
 *   ④ 외부모집 수동제출로 초과가 더 늘어나는 것도 허용한다(경고만).
 *   ⑤ 정원이 찬 공고가 리뷰어에게 모집중으로 보이지 않는 것은 정상이다(상태엔진 soft_full).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/* 스텁 pool — 서비스를 **실제로 실행**한다. 정적 검사만으로는 `skipWorktable` 를 받아만 두고
   쓰지 않는 변이를 통과시킨다. */
const _poolPath = require.resolve('../src/db/pool');
let _calls = [];
const _client = {
  query: async (sql, params) => {
    _calls.push(String(sql));
    if (/FROM recruit_campaigns WHERE id=\$1 FOR UPDATE/.test(sql)) {
      return { rows: [{ id: 'camp1', source_work_order_id: 'wo1', linked_sheet_id: 'wt_x', linked_tab_name: '탭' }] };
    }
    if (/FROM work_orders/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [{ id: 'wo1', linked_campaign_id: 'camp1' }] };
    if (/FROM tab_configs/.test(sql)) return { rows: [{ s: true }] };   // 무시트 탭
    if (/FROM campaign_participants/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
  release: () => {},
};
require.cache[_poolPath] = {
  id: _poolPath, filename: _poolPath, loaded: true,
  exports: { query: async () => ({ rows: [] }), connect: async () => _client },
};

const svc = require('../src/services/linkedRecruitQuota.service');
const routes = read('src/routes/campaign.routes.js');
const service = read('src/services/linkedRecruitQuota.service.js');
const manual = read('src/services/manualOrder.service.js');

let passed = 0;
function ok(name, cond, extra) {
  assert(cond, name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  passed++; console.log('  ✓ ' + name);
}
/** 라우트 본문만 자른다 — 파일 전체로 보면 다른 라우트의 같은 표현이 대신 통과시킨다. */
function routeBody(src, decl) {
  const i = src.indexOf(decl);
  assert(i > -1, '라우트를 찾지 못함: ' + decl);
  const j = src.indexOf('\nrouter.', i + 10);
  return src.slice(i, j > i ? j : src.length);
}
const put = routeBody(routes, "router.put('/admin/:id', authMiddleware");

// ── A. 서비스 실행 ─────────────────────────────────────────
console.log('\n[A] skipWorktable — 슬롯 맞추기만 건너뛴다');
(async () => {
  _calls = [];
  const r1 = await svc.syncCampaignRecruitTotal({ campaignId: 'camp1', recruitTotal: 40, skipWorktable: true });
  ok('정원 미변경 저장은 작업보드 슬롯을 조회조차 하지 않는다',
    !_calls.some(s => /FROM campaign_participants/.test(s)), _calls.length);
  ok('★ 역방향 링크 백필은 건너뛰지 않는다(연결이 조용히 비면 별개 사고)',
    _calls.some(s => /UPDATE work_orders SET linked_campaign_id/.test(s)));
  ok('사유를 말한다(조용한 스킵 금지)', r1 && r1.worktable && r1.worktable.reason === 'quota_unchanged', r1 && r1.worktable);
  ok('커밋된다', _calls.includes('COMMIT'));

  _calls = [];
  // 장부 재생성까지는 스텁이 못 가므로(그 뒤에서 던진다) 슬롯 조회 여부만 본다.
  try { await svc.syncCampaignRecruitTotal({ campaignId: 'camp1', recruitTotal: 40 }); } catch (_) { /* 재생성 단계 */ }
  ok('기본값(미지정)은 종전 동작 — 슬롯을 조회한다',
    _calls.some(s => /FROM campaign_participants/.test(s)));

  // ── B. 판정 함수 무접촉 ────────────────────────────────────
  console.log('\n[B] 줄이려는 조작은 종전대로 막는다');
  ok('빈 슬롯이 있으면 줄인다', JSON.stringify(svc.worktableSlotDelta({ current: 900, protectedCount: 93, target: 600 }))
    === JSON.stringify({ target: 600, add: 0, retire: 300 }));
  ok('★ 채워진 줄 아래로 줄이는 조작은 여전히 거부(1차)',
    (() => { try { svc.worktableSlotDelta({ current: 41, protectedCount: 41, target: 40 }); return false; } catch (e) { return e.code === 'recruit_quota_worktable_below_used'; } })());
  ok('★ 빈 슬롯 부족 2차 게이트도 그대로 있다',
    /ids\.length !== delta\.retire/.test(service) && /줄일 수 있는 빈 작업보드 슬롯이 부족합니다/.test(service));

  // ── C. 라우트 배선 ────────────────────────────────────────
  console.log('\n[C] 공고 수정 — 값이 달라졌을 때만 게이트');
  ok('UPDATE 앞에서 이전 총정원을 읽는다',
    /SELECT recruit_total FROM recruit_campaigns WHERE id = \$1/.test(put));
  ok('★ assert 는 _rtChanged 일 때만 탄다(전송 여부가 아니라 변경 여부)',
    /if \(_rtChanged\) \{\s*\n\s*await assertCampaignRecruitTotal\(/.test(put));
  ok('★ 이전 값을 못 읽으면 검사하는 쪽으로 접는다(fail-closed)',
    /_rtChanged = _rtSent && \(_rtPrev === null \|\|/.test(put));
  ok('★ 동기화도 같은 판정으로 슬롯만 건너뛴다',
    /skipWorktable: _rtSkipWorktable/.test(put) && /_rtSkipWorktable = _rtPrev !== null &&/.test(put));
  ok('최종값(차수 보정 뒤)으로 비교한다',
    /_rtSkipWorktable = _rtPrev !== null && \(Number\(rows\[0\]\.recruit_total\)/.test(put));
  ok('발행(create)은 이전 값이 없으므로 종전 그대로 — skipWorktable 를 넘기지 않는다',
    /syncCampaignRecruitTotal\(\{ campaignId: rows\[0\]\.id, recruitTotal: rows\[0\]\.recruit_total \}\)/.test(routes));

  // ── D. 초과는 감추지 않는다 ────────────────────────────────
  console.log('\n[D] 초과 상태 유지');
  const trackB = read('src/services/trackB.service.js');
  ok('★ 채워진 줄이 정원을 넘으면 표시할 뿐 자르지 않는다(over 표시)',
    /r\.over = true/.test(trackB) && !/slice\(0, *_cap\)/.test(trackB));
  ok('★ 외부모집 수동제출은 총정원 초과를 허용하고 경고만 남긴다',
    /모집 정원을 초과해 확정했습니다/.test(manual));

  console.log(`\ncampaignQuotaSaveUnchanged: ${passed} passed`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
