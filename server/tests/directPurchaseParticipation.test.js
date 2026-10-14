/**
 * 바로 구매를 공고 참여 규칙에 세기 (결정 238) — 서비스 계약 + apply 게이트 배선 회귀가드.
 * 실제 HTTP 비교(옛 코드 vs 새 코드)는 PR 본문에 기록. 여기서는 다시 어긋나면 바로 빨개질 계약만 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../src/services/directPurchaseParticipation.service');

const OWNER_ID = '11111111-2222-3333-4444-555555555555';

function stubDb(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      return { rows: [] };
    },
  };
}

(async () => {
  // ① 소유 증명된 명의 = 본계정 + 활성 코드 신원만(편집 가능한 sub_accounts 는 읽지 않는다)
  {
    const db = stubDb([[/FROM reviewer_identities/, [{ current_phone8: '33334444' }, { current_phone8: '11112222' }, { current_phone8: '' }]]]);
    const phones = await svc.loadVerifiedOwnerPhones(db, { ownerPhone8: '010-1111-2222', ownerReviewerId: OWNER_ID });
    assert.deepEqual(phones.sort(), ['11112222', '33334444'], 'owner phone plus active identities, deduplicated');
    assert.ok(/status = 'active'/.test(db.calls[0].sql), 'only active identities are trusted');
    assert.ok(!db.calls.some(c => /sub_accounts/.test(c.sql)), 'editable sub_accounts are never trusted');
    const noId = stubDb([]);
    assert.deepEqual(await svc.loadVerifiedOwnerPhones(noId, { ownerPhone8: '11112222', ownerReviewerId: 'x' }), ['11112222']);
    assert.equal(noId.calls.length, 0, 'invalid owner id skips the identity lookup');
  }

  // ② 하루 상한 — 이 명의의 바로 구매만(공고 참여에 연결된 주문·취소 주문 제외, 참여형 공고 작업표만)
  {
    const db = stubDb([[/FROM order_submissions os/, [{ n: '3' }]]]);
    assert.equal(await svc.countDirectPurchasesSince(db, { phone8: '01055556666', sinceIso: '2026-10-12T15:00:00Z' }), 3);
    const { sql, params } = db.calls[0];
    assert.ok(/os\.campaign_application_id IS NULL AND os\.deleted_at IS NULL/.test(sql), 'direct purchases only, cancelled excluded');
    assert.ok(/rc\.participation_mode IS TRUE/.test(sql), 'only worktables linked to a participation campaign count');
    assert.deepEqual(params, ['55556666', '2026-10-12T15:00:00Z']);
    assert.equal(await svc.countDirectPurchasesSince(stubDb([]), { phone8: '123', sinceIso: 'x' }), 0, 'bad phone counts nothing');
  }

  // ③ 타계정 하루 한도 — 본계정 제외 · 소유 증명된 다른 명의만 · 그 공고 작업표만
  {
    const db = stubDb([
      [/FROM reviewer_identities/, [{ current_phone8: '33334444' }, { current_phone8: '77778888' }]],
      [/FROM recruit_campaigns rc\s+JOIN order_submissions os/, [{ n: 2 }]],
    ]);
    const n = await svc.countCampaignSubDirectPurchasesSince(db, {
      campaignId: 'camp_x', ownerPhone8: '11112222', ownerReviewerId: OWNER_ID, sinceIso: '2026-10-12T15:00:00Z' });
    assert.equal(n, 2);
    const q = db.calls.find(c => /JOIN order_submissions os/.test(c.sql));
    assert.deepEqual(q.params[2].sort(), ['33334444', '77778888'], 'owner phone is not a sub name');
    assert.ok(/os\.tab_name = rc\.linked_tab_name/.test(q.sql), 'scoped to this campaign worktable');
    const none = stubDb([]);
    assert.equal(await svc.countCampaignSubDirectPurchasesSince(none, {
      campaignId: 'camp_x', ownerPhone8: '11112222', ownerReviewerId: OWNER_ID, sinceIso: 'x' }), 0);
    assert.ok(!none.calls.some(c => /JOIN order_submissions/.test(c.sql)), 'no verified sub names → no order lookup');
  }

  // ④ 인기 참여권 이벤트 — 'os:' id, 공고의 인기 여부로 일반/인기 구분
  {
    const db = stubDb([[/FROM order_submissions os/, [{ id: 'os:abc', phone8: '99990000', status: 'submitted', event_type: 'normal', event_at: new Date() }]]]);
    const rows = await svc.loadDirectPurchaseCreditEvents(db, { phones: ['010-9999-0000'], from: new Date(0), to: new Date() });
    assert.equal(rows.length, 1);
    assert.ok(/'os:' \|\| os\.id/.test(db.calls[0].sql), 'event ids never collide with application ids');
    assert.ok(/CASE WHEN camp\.is_popular IS TRUE THEN 'popular' ELSE 'normal' END/.test(db.calls[0].sql));
    assert.deepEqual(db.calls[0].params[2], ['99990000']);
    assert.deepEqual(await svc.loadDirectPurchaseCreditEvents(stubDb([]), { phones: [], from: 0, to: 0 }), [], 'empty scope reads nothing');
  }

  // ⑤ apply 게이트 배선 — 네 규칙 모두 바로 구매를 세고, 그 조회 실패는 fail-open(종전 판정 유지)
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'utf8');
    const apply = src.slice(src.indexOf('async function _applyParticipation('), src.indexOf("router.post('/:id/apply'"));
    assert.ok(/SAVEPOINT one_per_person_direct/.test(apply) && /ROLLBACK TO SAVEPOINT one_per_person_direct/.test(apply),
      '1인 1회 바로 구매 판정은 안쪽 SAVEPOINT 로 따로 접는다(종전 판정은 살린다)');
    assert.ok(/checkRepurchaseStatusForAccounts\(client, \{\s*campaignIds: \[id\]/.test(apply),
      '1인 1회 바로 구매 판정 = 리뷰어 카드와 같은 단일 출처');
    assert.ok(/today_submitted\) \+ todayDirect >=/.test(apply) && /ROLLBACK TO SAVEPOINT direct_daily/.test(apply),
      '하루 상한은 오늘 바로 구매를 더하고 실패 시 fail-open');
    assert.ok(/used \+= await countCampaignSubDirectPurchasesSince/.test(apply) && /ROLLBACK TO SAVEPOINT direct_sub_daily/.test(apply),
      '타계정 하루 한도는 바로 구매를 더하고 실패 시 fail-open');
    assert.ok(/ROLLBACK TO SAVEPOINT popular_direct/.test(apply)
      && /loadPopularCreditState\(client, holdP8, \{ includeDirectPurchases: false \}\)/.test(apply),
      '인기 참여권은 바로 구매 포함 계산 실패 시 종전 계산으로 접는다');
    const pc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'popularCredit.service.js'), 'utf8');
    assert.ok(/includeDirectPurchases = false/.test(pc), '관리자 집계(loadPopularCreditMatches 기본값)는 종전 그대로');
    assert.ok(/\{ includeDirectPurchases: true, \.\.\.options \}/.test(pc), '리뷰어 판정(loadPopularCreditState)은 바로 구매 포함');
  }

  // ⑥ 공고 판정 — 구매 시점에 이미 있던 공고 우선(나중 공고의 인기 여부 소급 금지) · phone8 인덱스 표현식 일치
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'directPurchaseParticipation.service.js'), 'utf8');
    // 결정 246: 순서는 단일 출처 함수(검사 의미 불변 — 순서 그대로 · 두 곳이 같은 함수를 쓰는지 고정)
    assert.ok(/ORDER BY \$\{campaignAtPurchaseOrderSql\('os\.submitted_at'\)\}/.test(src), 'campaign existing at purchase time wins');
    const { campaignAtPurchaseOrderSql } = require('../src/services/directPurchaseParticipation.service');
    assert.equal(campaignAtPurchaseOrderSql('X'),
      "(rc.created_at <= X) DESC NULLS LAST, rc.created_at DESC NULLS LAST, rc.id DESC",
      'existing-at-purchase first, then newest — no mutable status/published_at keys (decision 246)');
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '168_reviewer_home_lookup_indexes.sql'), 'utf8');
    const expr = "RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 8)";
    assert.ok(mig.includes(expr), 'idx_os_phone8_all expression');
    assert.ok(src.includes(expr.replace('COALESCE(phone', 'COALESCE(os.phone')), 'service phone8 literal matches idx_os_phone8_all');
  }

  console.log('directPurchaseParticipation: passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
