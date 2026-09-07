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
  assert.ok(statusSql.includes('WITH verified_phones AS'), '행 필터 전에 서버 원장으로 소유 명의 범위를 확정');
  assert.ok(statusSql.includes('reviewer_identities ri'), '관리자 충돌검사를 거친 코드 신원만 타명의 소유 근거로 인정');
  assert.ok(!statusSql.includes('owned_ca.') && !statusSql.includes('owned_os.'), '사용자가 만들 수 있는 신청/주문 소유 링크는 명의 증명으로 쓰지 않음');
  assert.equal((statusSql.match(/IN \(SELECT phone8 FROM verified_phones\)/g) || []).length, 2,
    '검증된 명의는 주문/신청의 전체 이력을 포함해 최신 누락 행도 놓치지 않음');
  const camp = read('src/routes/campaign.routes.js');
  assert.ok(camp.includes("router.get('/my-repurchase-status'"), '계정별 상태 API');
  assert.ok(camp.includes('checkRepurchaseStatusForAccounts'), '본계정+타계정 일괄 판정');
  assert.ok(camp.includes('SELECT name, phone8, sub_accounts'), '서명된 소유자의 등록 명의를 상태 대상으로 읽음');
  assert.ok(camp.includes('ownerPhone8: p8'), '타계정 이력은 소유자 범위와 함께 판정');
  assert.ok(camp.includes('ownerReviewerId: req.reviewer.ownerReviewerId'), '서명 세션의 소유자 UUID도 판정에 전달');
  assert.ok(camp.includes('const loginAccount = allAccounts.find(a => a.phone8 === loginP8)'), '같은 번호 타계정 로그인도 실제 phone8 대표 상태를 사용');
  assert.ok(camp.includes("{ status: 'login_only' }"), '타계정 로그인에서는 형제 명의를 참여 가능으로 오인하지 않음');
  assert.ok(camp.includes('other.id <> $2::uuid'), '타계정 신청 전 다른 소유자와의 전화번호 충돌을 차단');
  const conflictBlock = camp.slice(camp.indexOf('FROM reviewers other'), camp.indexOf('LIMIT 1`, [subP8'));
  assert.ok(!conflictBlock.includes('jsonb_array_elements'), '검증되지 않은 타인의 타계정 목록으로 정상 명의를 막지 않음');
  assert.ok(camp.includes("status: a.type === 'self' ? 'ready' : 'unknown'"), '미확인 타명의를 참여 가능으로 단정하지 않음');
  assert.ok(camp.includes("'SELECT id, multi_account_mode, repurchase_days FROM recruit_campaigns"), '공고별 다중명의 허용 여부와 제한일을 읽음');
  assert.ok(camp.includes("{ status: 'login_only' }"), '타계정 로그인에서 형제 명의는 선택 불가 상태로 응답');
  assert.ok(camp.includes('if (!setting || setting.repurchaseDays <= 0) continue'), '제한 없음 공고는 합성 상태도 응답하지 않음');
  assert.ok(camp.includes('phone8: holdP8'), '신청 최종 검사는 실제 선택 명의');
  const page = read('../frontend/campaign.html');
  assert.ok(page.includes("r.state === 'repurchase'"), '기간 중 계정은 선택 불가');
  assert.ok(page.includes("r.state === 'ok' || r.state === 'verify'"), '미확인 타명의는 안내 후 최종 서버 판정을 받을 수 있음');
  const cards = read('../frontend/js/campaign-cards.js');
  assert.ok(cards.includes(".sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]"), '모든 명의 잠금 시 가장 이른 해제일을 안내');
  assert.ok(cards.includes("a.status !== 'login_only'"), '카드 잠금 계산도 실제 로그인으로 사용 가능한 명의만 봄');
  console.log('PASS repurchase account virtual scenarios');
  if (old === undefined) delete process.env.CAMPAIGN_REPARTICIPATE_DAYS; else process.env.CAMPAIGN_REPARTICIPATE_DAYS = old;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
