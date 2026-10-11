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
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: false, name: '인 소민', phone: '' }), 'c-self', '본인 참여 = 이름 같은 본인 카드');
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: false, name: '다른이름', phone: '' }), null, '본인 카드 이름이 다르면 모름(레드팀 3)');
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: true, name: '인 소윤', phone: '010-9778-4335' }), 'c-sub', '타계정 참여 = 이름(공백 무시)+번호 카드');
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: true, name: '인소윤', phone: '010-0000-4335' }), null, '번호가 다르면 모름');
  assert.strictEqual(await f(cardDb([SELF]), OWNER, { isSub: true, name: '인소민', phone: '010-4149-4334' }), null, '타계정 참여를 본인 카드로 접지 않는다(레드팀 9)');
  assert.strictEqual(await f(cardDb([SELF, SUB, { ...SUB, id: 'c-sub2' }]), OWNER, { isSub: true, name: '인소윤', phone: '01097784335' }), null, '같은 카드가 둘이면 모름(추측 금지)');
  assert.strictEqual(await f(cardDb([SUB]), OWNER, { isSub: false, name: '인소민' }), null, '본인 카드가 없으면 모름');
  assert.strictEqual(await f(cardDb([SELF, SUB]), '', { isSub: false, name: '인소민' }), null, '소유자 없으면 모름');
  assert.strictEqual(await f(cardDb([SELF, SUB]), OWNER, { isSub: true, name: '', phone: '010-9778-4335' }), null, '이름 없으면 모름');
  console.log('PASS 참여 명의 카드 고르기 — 정확히 하나일 때만 · 본인은 이름까지');
}

function wiring() {
  const apply = fs.readFileSync(path.resolve(__dirname, '../src/routes/campaign.routes.js')).toString('utf8').replace(/\u0000/g, '');
  const at = apply.indexOf("SAVEPOINT card_bind");
  assert(at > 0, 'apply 카드 기록은 SAVEPOINT 로 격리');
  const block = apply.slice(at, at + 3500);
  assert(/ROLLBACK TO SAVEPOINT card_bind/.test(block), '실패 시 SAVEPOINT 로 되돌리고 참여는 계속');
  assert(/verifyReviewerSession\(tok\)/.test(block) && /String\(sessionOwner\) === String\(reg\.rows\[0\]\.id\)/.test(block), '서명된 세션 소유자 = 참여 본계정일 때만(레드팀 1·3)');
  assert(/SET LOCAL lock_timeout = '1s'/.test(block), '잠금 대기 상한');
  const rb = block.indexOf("set_config('lock_timeout', $1, true)"), rl = block.indexOf("RELEASE SAVEPOINT card_bind"), sp0 = block.indexOf("current_setting('lock_timeout')");
  assert(sp0 > 0 && rb > sp0 && rl > rb, '잠금 상한은 SAVEPOINT 안에서 읽고 RELEASE 전에 되돌린다(Codex P1)');
  for (const re of [/o\.phone8 = \$2 AND o\.id <> \$1::uuid/, /sub->>'phone'.*= \$2/s, /reviewer_phone_changes c WHERE c\.old_phone8 = \$2/, /reviewer_identity_aliases a JOIN reviewer_identities i/]) {
    assert(re.test(block), '소유자 기록은 159 와 같은 유일 소유자 판정: ' + re);
  }
  assert(/CASE WHEN \$4 THEN COALESCE\(owner_reviewer_id, \$2::uuid\) ELSE owner_reviewer_id END/.test(block), '유일할 때만 · 이미 있으면 덮지 않는다');
  assert(/owner_reviewer_id IS NULL OR owner_reviewer_id = \$2::uuid/.test(block), '다른 소유자 행에는 카드도 쓰지 않는다');
  const commitAt = apply.indexOf("await client.query('COMMIT');", at);
  assert(commitAt > at && commitAt - at < 4000, '카드 기록은 같은 트랜잭션 COMMIT 직전');
  const insertAt = apply.lastIndexOf('INSERT INTO campaign_applications', at);
  assert(insertAt > 0 && at - insertAt < 3500, '홀드 INSERT 뒤에 기록');
  const idx = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  assert(/\['campaign_applications', 'participant_card_id'\]/.test(idx), 'REQUIRED_SCHEMA — 구매양식이 읽는 신청 칸');
  const mig = fs.readFileSync(path.resolve(__dirname, '../migrations/182_participation_card_binding.sql'), 'utf8');
  assert(/ON DELETE SET NULL NOT VALID/.test(mig) && /ADD COLUMN IF NOT EXISTS participant_card_id UUID NULL/.test(mig), '182 는 NULL 칸 + NOT VALID 외래키');
  console.log('PASS apply 배선 — SAVEPOINT 격리 · 세션 대조 · 159 유일 소유자 · 덮지 않음 · 스키마');
}

// 주문 원장: 카드 기록 UPDATE 가 실패해도 주문은 COMMIT 된다 + 게이트 카드 > 신청행 카드.
async function ledgerCases() {
  async function run({ failCardCopy, binding }) {
    const log = [];
    const client = {
      query: async (sql, params) => {
        log.push({ sql: String(sql), params });
        if (/SAVEPOINT card_copy/.test(sql) && !/RELEASE|ROLLBACK/.test(sql)) return { rows: [] };
        if (/participant_card_id = ca\.participant_card_id/.test(sql) && failCardCopy) { const e = new Error('boom'); e.code = '42703'; throw e; }
        if (/INSERT INTO order_submissions/.test(sql)) return { rows: [{ id: 'os-1' }] };
        if (/current_setting\('lock_timeout'\)/.test(sql)) return { rows: [{ v: '7s' }] };
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
    // Codex P1 — 1초 잠금 상한은 카드 기록에만. 홀드 확정 전에 원래 값으로 되돌린다.
    const log = await run({ failCardCopy: false, binding: null });
    const sqls = log.map((x) => x.sql);
    const sp = sqls.findIndex((s) => /^SAVEPOINT card_copy/.test(s.trim()));
    const read = sqls.findIndex((s) => /current_setting\('lock_timeout'\)/.test(s));
    const restore = log.findIndex((x) => /set_config\('lock_timeout', \$1, true\)/.test(x.sql) && x.params && x.params[0] === '7s');
    const rel = sqls.findIndex((s) => /RELEASE SAVEPOINT card_copy/.test(s));
    const hc = sqls.findIndex((s) => /SAVEPOINT hold_confirm/.test(s));
    assert(sp >= 0 && read > sp, '원래 값 읽기는 SAVEPOINT 안에서');
    assert(restore > read && restore < rel && rel < hc, '원래 잠금 상한을 RELEASE 전에 되돌리고 그 뒤에 홀드 확정');
  }
  {
    // Codex P1 — 구버전 게이트 결과(카드 칸 자체가 없음)는 결과 없음과 같게 → 신청행 카드(두 소유자 같을 때)
    const log = await run({ failCardCopy: false, binding: { ownerReviewerId: OWNER, participantIdentityKeyHash: 'h' } });
    assert(log.some((x) => /participant_card_id = ca\.participant_card_id/.test(x.sql)), '카드 칸 없는 게이트 결과는 신청행 카드로');
  }
  {
    const log = await run({ failCardCopy: false, binding: { ownerReviewerId: OWNER, participantIdentityKeyHash: 'h', participantCardId: 'card-gate' } });
    const upd = log.find((x) => /SET participant_card_id = \$2::uuid/.test(x.sql));
    assert(upd && upd.params[1] === 'card-gate', '게이트가 검증한 카드를 쓴다');
    assert(!log.some((x) => /FROM campaign_applications ca/.test(x.sql) && /participant_card_id = ca\.participant_card_id/.test(x.sql)), '게이트 결과가 있으면 신청행 카드로 대신하지 않는다(레드팀 5)');
  }
  {
    const log = await run({ failCardCopy: false, binding: { ownerReviewerId: OWNER, participantIdentityKeyHash: 'h', participantCardId: null } });
    assert(!log.some((x) => /SET participant_card_id/.test(x.sql)), '게이트가 카드를 못 골랐으면 비워 둔다');
  }
  {
    const log = await run({ failCardCopy: false, binding: null });
    const upd = log.find((x) => /participant_card_id = ca\.participant_card_id/.test(x.sql));
    assert(upd && /os\.owner_reviewer_id IS NOT NULL AND os\.owner_reviewer_id = ca\.owner_reviewer_id/.test(upd.sql), '신청행 카드는 두 소유자가 다 있고 같을 때만');
    assert(/os\.participant_card_id IS NULL/.test(upd.sql), '이미 새긴 카드는 덮지 않는다');
  }
  console.log('PASS 주문 원장 — 카드 기록 실패해도 주문 보존 · 게이트 카드 우선 · 덮지 않음');
}

function noApplicationOwnerDeferred() {
  // 신청 없는 주문의 소유자 기록은 4단계(그 칸을 읽는 내역·입금을 함께 손볼 때)로 미뤘다 — 지금 쓰면 읽는 쪽 판단이 바뀐다(레드팀 1·2).
  const ledgerSrc = fs.readFileSync(path.resolve(__dirname, '../src/services/orderLedger.service.js'), 'utf8');
  assert(!/sessionOwnerReviewerId/.test(ledgerSrc), '신청 없는 주문 세션 소유자 기록 없음(4단계)');
  console.log('PASS 신청 없는 주문 소유자 기록은 4단계로 미룸');
}

(async () => {
  await findCardCases();
  wiring();
  await ledgerCases();
  noApplicationOwnerDeferred();
})().catch((e) => { console.error(e); process.exit(1); });
