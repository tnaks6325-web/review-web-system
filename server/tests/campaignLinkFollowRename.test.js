/* 탭 리네임 시 모집공고의 연결 탭 이름도 따라간다 (2026-08-24 실측 사고)
   ───────────────────────────────────────────────────────────────────────────
   사고: 「맛고」 탭의 공고가 옛 양식 이름 `체험단시트양식1` 을 가리키고 있었다.
   탭 이름이 바뀔 때 review_index·index_master·tab_configs 는 따라가는데
   recruit_campaigns.linked_tab_name 만 빠져 있어, 공고↔작업표 연결을 **이름으로**
   찾는 경로가 통째로 죽었다([📅 인원] 빈 화면 · 정원 판정 · 날짜 정렬 정지).

   ★ 왜 판정 함수에 gid 폴백을 넣지 않았나: `isSheetless` 만 고치면 "연결됨"으로
     바뀌지만 뒤따르는 조회가 전부 tab_name 으로 작업표를 찾아 0줄이 나온다
     (연결됐다는데 화면이 텅 빈, 더 나쁜 상태). 이름 자체를 맞추는 것이 답이다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

const { renameCampaignLinkedTab } = require('../src/utils/campaignTabLateral');
const lat = S('src/utils/campaignTabLateral.js');
const ib = S('src/services/indexBuilder.service.js');
const isc = S('src/services/indexScan.service.js');
const tc = S('src/routes/tabconfig.routes.js');
const renameSvc = S('src/services/tabRename.service.js');
const { renameTabState } = require('../src/services/tabRename.service');

console.log('── A. 실행부 ──');
(async () => {
  // 스텁 db — 무엇이 어떤 파라미터로 나갔는지 본다
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 2 }; } };

  const n = await renameCampaignLinkedTab(db, { sheetId: 'S1', oldTabName: '체험단시트양식1', newTabName: '맛고', tabGid: '1405976532' });
  t('고친 공고 수를 돌려준다(차수 재발행으로 여러 건일 수 있다)', n === 2);
  t('★ 쓰기 대상은 recruit_campaigns 한 곳', calls.length === 1 && /UPDATE recruit_campaigns/.test(calls[0].sql));
  t('★ 조건 = 같은 시트의 옛 이름(다른 시트의 동명 탭을 건드리지 않는다)',
    /WHERE linked_sheet_id = \$3 AND linked_tab_name = \$4/.test(calls[0].sql));
  t('새 이름·gid 를 넘긴다', calls[0].params[0] === '맛고' && calls[0].params[1] === '1405976532'
    && calls[0].params[2] === 'S1' && calls[0].params[3] === '체험단시트양식1');
  t('★ 빈 gid 는 기존 값을 덮지 않는다(모르는 값으로 지우지 않는다)',
    /linked_tab_gid\s*=\s*COALESCE\(NULLIF\(\$2, ''\), linked_tab_gid\)/.test(calls[0].sql));
  t('★ 보관 여부를 조건에 넣지 않는다 — 보관을 풀면 정상이어야 한다',
    !/archived/i.test(calls[0].sql));
  t('★ 상태(status)로 좁히지 않는다 — draft·closed 공고도 연결은 맞아야 한다',
    !/status/i.test(calls[0].sql));

  calls.length = 0;
  t('이름이 그대로면 아무것도 하지 않는다',
    (await renameCampaignLinkedTab(db, { sheetId: 'S1', oldTabName: '같음', newTabName: '같음', tabGid: 'g' })) === 0 && calls.length === 0);
  t('재료가 빠지면 아무것도 하지 않는다',
    (await renameCampaignLinkedTab(db, { sheetId: '', oldTabName: 'a', newTabName: 'b' })) === 0
    && (await renameCampaignLinkedTab(null, { sheetId: 'S', oldTabName: 'a', newTabName: 'b' })) === 0
    && calls.length === 0);

  calls.length = 0;
  const moved = await renameTabState(db, {
    sheetId: 'S1', oldTabName: '체험단시트양식1', newTabName: '맛고', tabGid: '1405976532',
  });
  const orderMove = calls.find(c => /UPDATE order_submissions/.test(c.sql));
  const participantMove = calls.find(c => /UPDATE campaign_participants/.test(c.sql));
  t('★ 주문·참여 원장의 공고 provenance도 같은 탭 좌표로 이동',
    !!orderMove && !!participantMove
    && orderMove.params[0] === '맛고' && orderMove.params[1] === '1405976532'
    && participantMove.params[2] === 'S1' && participantMove.params[3] === '체험단시트양식1');
  t('이동 건수를 운영 로그용 결과에 돌려준다',
    moved.orderSubmissionsUpdated === 2 && moved.campaignParticipantsUpdated === 2);

  const boom = { query: async () => { throw Object.assign(new Error('boom'), { code: '42703' }); } };
  let threw = false, r0 = null;
  try { r0 = await renameCampaignLinkedTab(boom, { sheetId: 'S', oldTabName: 'a', newTabName: 'b', tabGid: 'g' }); }
  catch (_) { threw = true; }
  t('★★ 절대 throw 하지 않는다 — 실패해도 탭 이름 자가치유는 계속돼야 한다', !threw && r0 === 0);

  console.log('── B. 모든 보정 지점에 공용 탭 리네임 배선 ──');
  t('indexBuilder·indexScan이 공용 renameTabState를 호출한다',
    /renameTabState\(pool, \{/.test(ib) && /renameTabState\(client, \{/.test(isc));
  t('수동 sync-tab-names·fix-campaign-tab-swap도 같은 공용 함수를 호출한다',
    (tc.match(/renameTabState\(pool, \{/g) || []).length === 2);
  t('★ 규칙 사본 0 — UPDATE recruit_campaigns 는 공유 헬퍼에만 있다',
    !/UPDATE recruit_campaigns[\s\S]{0,120}linked_tab_name/.test(ib)
    && !/UPDATE recruit_campaigns[\s\S]{0,120}linked_tab_name/.test(isc));

  const seg = src => {
    const i = src.indexOf('renameTabState(');
    const j = src.indexOf('correctUrl', i);
    return i >= 0 && j > i;
  };
  t('★ 핵심·영수증 원장의 탭 좌표 변경은 공용 서비스 한 곳에만 있다',
    /UPDATE review_index/.test(renameSvc) && /UPDATE index_master/.test(renameSvc)
    && /UPDATE tab_configs/.test(renameSvc) && /UPDATE review_submissions/.test(renameSvc)
    && /UPDATE review_inspections/.test(renameSvc)
    && /UPDATE order_submissions/.test(renameSvc)
    && /UPDATE campaign_participants/.test(renameSvc));
  t('★ 미다운로드 pending 회차만 새 탭 좌표로 옮긴다',
    /UPDATE payment_batch_items i[\s\S]*i\.status = 'pending'[\s\S]*COALESCE\(b\.download_count, 0\) = 0/.test(renameSvc));
  t('보정은 URL 교정 앞에 들어간다(같은 묶음 안)', seg(ib) && seg(isc));

  console.log('── C. 판정 함수는 건드리지 않았다 ──');
  const scope = S('src/utils/sheetlessScope.js');
  const m = scope.match(/async function isSheetless\(([^)]*)\)/);
  t('★★ isSheetless 시그니처 불변 — gid 폴백을 넣으면 "연결됐다는데 0줄"이 된다',
    !!m && m[1].replace(/\s+/g, ' ').trim() === 'db, sheetId, tabName');

  console.log(`\n✅ campaignLinkFollowRename: ${pass} cases passed`);
  process.exit(0);
})();
