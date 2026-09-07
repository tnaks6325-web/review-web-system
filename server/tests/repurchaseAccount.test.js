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
  const multi = await checkRepurchaseStatusForAccounts({ query: async (sql, params) => {
    statusSql = String(sql);
    return { rows: [
    { campaign_id: 'c1', p8: '11112222', last_at: new Date(now.getTime() - 4 * 86400000), ownership_verified: true },
    ] };
  } }, {
    campaignIds: ['c1'], phone8List: ['11112222', '33334444', '55556666'],
    ownerPhone8: '11112222', ownerReviewerId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(multi.get('11112222').get('c1').status, 'locked');
  assert.equal(multi.has('33334444'), false, '소유관계가 없는 타명의 이력은 SQL에서 반환하지 않음');
  assert.ok(statusSql.includes('campaign_applications ca'), '상태 조회도 같은 공고 submitted 이력을 폴백으로 포함');
  assert.ok(statusSql.includes("ca.status = 'submitted'"), '완료된 공고 신청만 상태 폴백에 포함');
  assert.ok(statusSql.includes('os.owner_reviewer_id = $4::uuid'), '주문 원장의 소유자 UUID를 확인');
  assert.ok(statusSql.includes('owned_ca.owner_phone8 = $3 OR owned_ca.owner_reviewer_id = $4::uuid'), '전화/UUID 소유관계를 모두 확인');
  const camp = read('src/routes/campaign.routes.js');
  assert.ok(camp.includes("router.get('/my-repurchase-status'"), '계정별 상태 API');
  assert.ok(camp.includes('checkRepurchaseStatusForAccounts'), '본계정+타계정 일괄 판정');
  assert.ok(camp.includes('SELECT name, phone8, sub_accounts'), '서명된 소유자의 등록 명의를 상태 대상으로 읽음');
  assert.ok(camp.includes('ownerPhone8: p8'), '타계정 이력은 소유자 범위와 함께 판정');
  assert.ok(camp.includes('ownerReviewerId: req.reviewer.ownerReviewerId'), '서명 세션의 소유자 UUID도 판정에 전달');
  assert.ok(camp.includes("status: a.type === 'self' ? 'ready' : 'unknown'"), '미확인 타명의를 참여 가능으로 단정하지 않음');
  assert.ok(camp.includes("'SELECT id, multi_account_mode FROM recruit_campaigns"), '공고별 다중명의 허용 여부를 읽음');
  assert.ok(camp.includes("accounts.filter(a => a.phone8 === loginP8)"), '단일명의 공고는 실제 로그인 명의만 응답');
  assert.ok(camp.includes('phone8: holdP8'), '신청 최종 검사는 실제 선택 명의');
  const page = read('../frontend/campaign.html');
  assert.ok(page.includes("r.state === 'repurchase'"), '기간 중 계정은 선택 불가');
  assert.ok(page.includes("r.state === 'ok' || r.state === 'verify'"), '미확인 타명의는 안내 후 최종 서버 판정을 받을 수 있음');
  console.log('PASS repurchase account virtual scenarios');
  if (old === undefined) delete process.env.CAMPAIGN_REPARTICIPATE_DAYS; else process.env.CAMPAIGN_REPARTICIPATE_DAYS = old;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
