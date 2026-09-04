'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { checkRepurchaseWindow, checkRepurchaseStatusForAccounts } = require('../src/utils/repurchaseGuard');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const q = rows => ({ query: async () => ({ rows }) });
(async () => {
  const old = process.env.CAMPAIGN_REPARTICIPATE_DAYS;
  delete process.env.CAMPAIGN_REPARTICIPATE_DAYS;
  const now = new Date();
  const a = await checkRepurchaseWindow(q([{ submitted_at: new Date(now.getTime() - 4 * 86400000) }]),
    { sheetId: 'virtual-sheet', tabName: 'same-product', phone8: '11112222' });
  assert.equal(a.blocked, true, 'A: 4일 전 동일상품 참여는 차단');
  assert.equal(a.days, 14, '기본 기한은 14일');
  // DB 쿼리는 14일 창을 SQL에서 거른다. 16일 전 행은 결과에 없다는 가상 조건이다.
  const b = await checkRepurchaseWindow(q([]),
    { sheetId: 'virtual-sheet', tabName: 'same-product', phone8: '33334444' });
  assert.equal(b.blocked, false, 'B: 16일 전 참여는 허용');
  let statusSql = '';
  const multi = await checkRepurchaseStatusForAccounts({ query: async (sql) => {
    statusSql = String(sql);
    return { rows: [
    { campaign_id: 'c1', p8: '11112222', last_at: new Date(now.getTime() - 4 * 86400000) },
    { campaign_id: 'c1', p8: '33334444', last_at: new Date(now.getTime() - 16 * 86400000) },
    ] };
  } }, { campaignIds: ['c1'], phone8List: ['11112222', '33334444', '55556666'] });
  assert.equal(multi.get('11112222').get('c1').status, 'locked');
  assert.equal(multi.get('33334444').get('c1').status, 'ready');
  assert.equal(multi.has('55556666'), false, '이력 없는 계정은 서버 맵에 없음(화면에서는 가능 계정)');
  assert.ok(statusSql.includes('campaign_applications ca'), '상태 조회도 같은 공고 submitted 이력을 폴백으로 포함');
  assert.ok(statusSql.includes("ca.status = 'submitted'"), '완료된 공고 신청만 상태 폴백에 포함');
  const camp = read('src/routes/campaign.routes.js');
  assert.ok(camp.includes("router.get('/my-repurchase-status'"), '계정별 상태 API');
  assert.ok(camp.includes('checkRepurchaseStatusForAccounts'), '본계정+타계정 일괄 판정');
  assert.ok(camp.includes('phone8: holdP8'), '신청 최종 검사는 실제 선택 명의');
  const page = read('../frontend/campaign.html');
  assert.ok(page.includes("r.state === 'repurchase'"), '기간 중 계정은 선택 불가');
  console.log('PASS repurchase account virtual scenarios');
  if (old === undefined) delete process.env.CAMPAIGN_REPARTICIPATE_DAYS; else process.env.CAMPAIGN_REPARTICIPATE_DAYS = old;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
