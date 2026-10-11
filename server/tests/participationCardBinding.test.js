'use strict';
// 결정 221 — 신원 기준 재정립 1단계: 참여·주문에 "누구의 어느 명의 카드"를 새긴다(기록만, 막지 않는다).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'participation-card-binding-test-secret-32b';
const cards = require('../src/services/reviewerIdentityCards.service');
const ledger = require('../src/services/orderLedger.service');

const OWNER = '11111111-1111-4111-8111-111111111111';
function cardDb(rows) { return { query: async () => ({ rows }) }; }
const SELF = { id: 'c-self', kind: 'self', name_key: '인소민', phone8: '41494334' };
const SUB = { id: 'c-sub', kind: 'sub', name_key: '인소윤', phone8: '97784335' };

async function findCardCases() {
  const f = cards.findParticipationCard;
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: false, name: '아무이름', phone: '' }), 'c-self', '본인 참여 = 본인 카드');
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: true, name: '인 소윤', phone: '010-9778-4335' }), 'c-sub', '타계정 참여 = 이름(공백 무시)+번호 카드');
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: true, name: '인소윤', phone: '010-0000-4335' }), null, '번호가 다르면 모름');
  assert.strictEqual(await f(cardDb([SELF]), OWNER, { isSub: true, name: '인소민', phone: '010-4149-4334' }), 'c-self', '본인과 같은 타계정 칸 = 본인 카드(카드 규칙 same_as_self)');
  assert.strictEqual(await f(cardDb([SELF, SUB, { ...SUB, id: 'c-sub2' }]), OWNER, { isSub: true, name: '인소윤', phone: '01097784335' }), null, '같은 카드가 둘이면 모름(추측 금지)');
  assert.strictEqual(await f(cardDb([SUB]), OWNER, { isSub: false }), null, '본인 카드가 없으면 모름');
  assert.strictEqual(await f(cardDb([SELF, SUB]), '', { isSub: false }), null, '소유자 없으면 모름');
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: true, name: '', phone: '010-9778-4335' }), null, '이름 없으면 모름');
  console.log('PASS 참여 명의 카드 고르기 — 정확히 하나일 때만');
}

function wiring() {
  const apply = fs.readFileSync(path.resolve(__dirname, '../src/routes/campaign.routes.js')).toString('utf8').replace(/\u0000/g, '');
  const at = apply.indexOf("SAVEPOINT card_bind");
  assert(at > 0, 'apply 카드 기록은 SAVEPOINT 로 격리');
  const block = apply.slice(at, at + 2000);
  assert(/ROLLBACK TO SAVEPOINT card_bind/.test(block), '실패 시 SAVEPOINT 로 되돌리고 참여는 계속');
  assert(/COUNT\(\*\)::int AS n FROM reviewers WHERE phone8 = \$1/.test(block) && /\.n === 1/.test(block), '같은 phone8 리뷰어가 정확히 하나일 때만 소유자 기록');
  assert(/owner_reviewer_id = COALESCE\(owner_reviewer_id, \$2::uuid\)/.test(block), '이미 기록된 소유자는 덮지 않는다');
  assert(/owner_reviewer_id IS NULL OR owner_reviewer_id = \$2::uuid/.test(block), '다른 소유자 행에는 카드도 쓰지 않는다');
  const commitAt = apply.indexOf("await client.query('COMMIT');", at);
  assert(commitAt > at && commitAt - at < 2500, '카드 기록은 같은 트랜잭션 COMMIT 직전');
  const insertAt = apply.lastIndexOf('INSERT INTO campaign_applications', at);
  assert(insertAt > 0 && at - insertAt < 3000, '홀드 INSERT 뒤에 기록');
  const idx = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  assert(/\['campaign_applications', 'participant_card_id'\]/.test(idx) && /\['order_submissions', 'participant_card_id'\]/.test(idx), 'REQUIRED_SCHEMA 에 두 칸');
  const mig = fs.readFileSync(path.resolve(__dirname, '../migrations/182_participation_card_binding.sql'), 'utf8');
  assert(/ON DELETE SET NULL/.test(mig) && !/NOT NULL/.test(mig.replace(/UUID NULL/g, '')), '182 는 NULL 허용 칸 추가뿐');
  console.log('PASS apply 배선 — SAVEPOINT 격리 · 유일 소유자 · 덮지 않음 · 스키마 프리플라이트');
}

// 주문 원장: 카드 기록 UPDATE 가 실패해도 주문은 COMMIT 된다 + 게이트 카드 > 신청행 카드.
async function ledgerCases() {
  async function run({ failCardCopy, binding }) {
    const log = [];
    const client = {
      query: async (sql, params) => {
        log.push({ sql: String(sql), params });
        if (/SAVEPOINT card_copy/.test(sql) && !/RELEASE|ROLLBACK/.test(sql)) return { rows: [] };
        if (/SET participant_card_id = COALESCE/.test(sql) && failCardCopy) { const e = new Error('boom'); e.code = '42703'; throw e; }
        if (/INSERT INTO order_submissions/.test(sql)) return { rows: [{ id: 'os-1' }] };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool = { connect: async () => client, query: client.query };
    ledger.__setPoolForTest(pool);
    try {
      await ledger.createOrderLedgerEntry({
        sheetId: 's', tabName: 't', gid: '1', orderData: { recipient: '인소민', phone: '010-4149-4334' },
        skipSheetMirror: true,
        campaignHold: { applicationId: 77, campaignId: 'camp', phone8: '41494334', holdToken: 'h', identityBinding: binding },
      }).catch((e) => { log.push({ sql: 'THROW ' + e.message }); });
    } finally { ledger.__setPoolForTest(null); }
    return log;
  }
  {
    const log = await run({ failCardCopy: true, binding: null });
    const sqls = log.map((x) => x.sql);
    assert(sqls.some((s) => /ROLLBACK TO SAVEPOINT card_copy/.test(s)), '카드 기록 실패는 SAVEPOINT 로 되돌린다');
    assert(sqls.some((s) => /^COMMIT/.test(s.trim())), '★ 카드 기록 실패해도 주문은 COMMIT');
    assert(!sqls.some((s) => /^THROW/.test(s)), '예외가 밖으로 새지 않는다');
    const cp = sqls.findIndex((s) => /SAVEPOINT card_copy/.test(s));
    const hc = sqls.findIndex((s) => /SAVEPOINT hold_confirm/.test(s));
    assert(cp > 0 && hc > cp, '카드 기록은 홀드 확정 전');
  }
  {
    const log = await run({ failCardCopy: false, binding: { ownerReviewerId: OWNER, participantIdentityKeyHash: 'h', participantCardId: 'card-gate' } });
    const upd = log.find((x) => /SET participant_card_id = COALESCE/.test(x.sql));
    assert(upd && upd.params[2] === 'card-gate', '게이트가 검증한 카드가 신청행 카드보다 먼저');
    assert(/os\.participant_card_id IS NULL/.test(upd.sql), '이미 새긴 카드는 덮지 않는다');
    assert(/os\.owner_reviewer_id = ca\.owner_reviewer_id/.test(upd.sql), '신청행·주문 소유자가 다르면 옮기지 않는다');
  }
  console.log('PASS 주문 원장 — 카드 기록 실패해도 주문 보존 · 게이트 카드 우선 · 덮지 않음');
}

async function noApplicationOwner() {
  const log = [];
  const pool = {
    query: async (sql, params) => { log.push({ sql: String(sql), params }); if (/INSERT INTO order_submissions/.test(sql)) return { rows: [{ id: 'os-9' }] }; return { rows: [], rowCount: 0 }; },
    connect: async () => { throw new Error('비참여 경로는 connect 없음'); },
  };
  ledger.__setPoolForTest(pool);
  try {
    await ledger.createOrderLedgerEntry({ sheetId: 's', tabName: 't', gid: '1', orderData: {}, skipSheetMirror: true, sessionOwnerReviewerId: OWNER }).catch(() => {});
    const upd = log.find((x) => /SET owner_reviewer_id = \$2::uuid/.test(x.sql));
    assert(upd && upd.params[0] === 'os-9' && upd.params[1] === OWNER, '신청 없는 주문에 세션 소유자 기록');
    assert(/owner_reviewer_id IS NULL/.test(upd.sql), '이미 소유자가 있으면 덮지 않는다');
    log.length = 0;
    await ledger.createOrderLedgerEntry({ sheetId: 's', tabName: 't', gid: '1', orderData: {}, skipSheetMirror: true }).catch(() => {});
    assert(!log.some((x) => /SET owner_reviewer_id = \$2::uuid/.test(x.sql)), '세션 없으면 기록하지 않는다(종전 그대로)');
  } finally { ledger.__setPoolForTest(null); }
  const submit = fs.readFileSync(path.resolve(__dirname, '../src/routes/submit.routes.js'), 'utf8');
  assert(/if \(!holdCtx && req\.headers\['x-reviewer-token'\]\) \{\s*try \{ _sessionOwnerReviewerId = verifyReviewerSession\(/.test(submit), '서명 검증된 세션만 · 무효 토큰은 막지 않고 무시');
  console.log('PASS 신청 없는 주문 — 서명된 세션 소유자만 기록 · 없으면 종전');
}

(async () => {
  await findCardCases();
  wiring();
  await ledgerCases();
  await noApplicationOwner();
})().catch((e) => { console.error(e); process.exit(1); });
