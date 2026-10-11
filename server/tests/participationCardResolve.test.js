'use strict';
// 결정 221 — 신원 기준 재정립 2단계: 구매양식은 참여 때 새긴 명의 카드 번호를 먼저 쓰고,
// 카드 번호가 없는 예전 참여는 명의 카드와 같은 규칙(본인과 같은 타계정 = 본인 · 합친 명의 제외)으로 찾는다.
const assert = require('assert');

process.env.JWT_SECRET = 'participation-card-resolve-test-secret-32b';
delete process.env.IDENTITY_CARDS_READ;

const pool = require('../src/db/pool');
const identity = require('../src/services/reviewerOrderIdentity.service');

const OWNER = '11111111-1111-4111-8111-111111111111';
let state;
function reset(over = {}) {
  state = {
    self: { name: '인소민', phone: '010-4149-4334' },
    subs: [
      { name: '인소민', phone: '010-4149-4334', address: '다른 배송지 1' },   // 본인과 똑같은 타계정 칸(인소민 건)
      { name: '인소윤', phone: '010-9778-4335', address: '통영' },
    ],
    cards: [
      { id: 'card-self', kind: 'self', name_key: '인소민', phone8: '41494334', status: 'active', merged_into: null },
      { id: 'card-sub', kind: 'sub', name_key: '인소윤', phone8: '97784335', status: 'active', merged_into: null },
    ],
    app: { applicant_name: '인소민', applicant_phone: '010-4149-4334', phone8: '41494334', participant_card_id: null },
    ...over,
  };
}
pool.query = async (sql, params) => {
  if (/FROM reviewers WHERE id = \$1/.test(sql)) {
    return { rows: [{ id: OWNER, name: state.self.name, phone: state.self.phone, phone8: state.self.phone.replace(/\D/g, '').slice(-8),
      address: '울산', bank_name: '국민', bank_account: '1', account_holder: '인소민', shopping_id: '', reviewer_no: null, sub_accounts: state.subs }] };
  }
  if (/FROM reviewer_identities/.test(sql)) return { rows: [] };
  if (/FROM reviewer_identity_cards/.test(sql)) return { rows: state.cards };
  if (/FROM campaign_applications ca/.test(sql)) {
    return { rows: [{ id: 15219, campaign_id: 'camp', owner_phone8: '41494334', owner_reviewer_id: null, participant_identity_id: null,
      status: 'applied', expires_at: new Date(Date.now() + 600000).toISOString(), multi_account_mode: false, ...state.app }] };
  }
  throw new Error('unexpected query: ' + sql);
};
const ctx = { ownerReviewerId: OWNER, applicationId: 15219, campaignId: 'camp', holdToken: 'h' };

(async () => {
  // ① 인소민 건: 카드 번호 없는 예전 참여 + 본인과 똑같은 타계정 칸 → 종전 "하나로 확정할 수 없습니다" → 이제 본인
  reset();
  let r = await identity.resolveApplicationIdentity(ctx);
  assert.strictEqual(r.selected.type, 'self', '본인과 같은 타계정 칸은 본인으로 접는다');
  assert.strictEqual(r.selected.identityKey, 'self', 'identityKey 는 그대로(승인 토큰 결속 불변)');
  assert.strictEqual(r.selected.cardId, 'card-self', '본인도 카드 번호를 가진다');
  console.log('PASS 인소민 건 — 본인과 똑같은 타계정 칸 때문에 막히지 않는다');

  // ② 카드 번호가 새겨진 참여는 그 카드만 본다(타계정)
  reset({ app: { applicant_name: '인소윤', applicant_phone: '010-9778-4335', phone8: '97784335', participant_card_id: 'card-sub' } });
  r = await identity.resolveApplicationIdentity(ctx);
  assert.strictEqual(r.selected.type, 'sub');
  assert.strictEqual(r.selected.name, '인소윤');
  assert.strictEqual(r.selected.cardId, 'card-sub');
  // 신청행 이름이 어긋나 있어도 카드 번호가 이긴다(이름으로 다시 추측하지 않는다)
  reset({ app: { applicant_name: '엉뚱한이름', applicant_phone: '010-9778-4335', phone8: '97784335', participant_card_id: 'card-sub' } });
  r = await identity.resolveApplicationIdentity(ctx);
  assert.strictEqual(r.selected.name, '인소윤', '카드 번호가 있으면 이름으로 다시 찾지 않는다');
  // 신청 당시 번호가 지금 카드와 달라도 카드가 이긴다 — 카드는 고정 번호다(Codex P1). 연락처는 신청 당시 값
  reset({ app: { applicant_name: '인소윤', applicant_phone: '010-0000-0000', phone8: '00000000', participant_card_id: 'card-sub' } });
  r = await identity.resolveApplicationIdentity(ctx);
  assert.strictEqual(r.selected.cardId, 'card-sub', '번호가 달라도 카드를 버리고 다시 추측하지 않는다');
  assert.strictEqual(r.selected.phone, '010-0000-0000', '타계정 연락처는 신청 당시 값(종전 규칙)');
  console.log('PASS 카드 번호가 있으면 그 카드만 따라간다');

  // ③ 카드가 지금 목록에 없으면(이름 변경 등) 종전 방식으로 폴백 — 막지 않는다
  reset({ app: { applicant_name: '인소윤', applicant_phone: '010-9778-4335', phone8: '97784335', participant_card_id: 'card-gone' } });
  r = await identity.resolveApplicationIdentity(ctx);
  assert.strictEqual(r.selected.name, '인소윤', '모르는 카드면 종전 방식');
  console.log('PASS 카드가 사라졌으면 종전 방식으로 찾는다');

  // ④ 방어 유지: 이름이 다른 명의는 접지 않는다 — 같은 번호 가족 둘(이름 다름) + 이름 없는 신청 → 여전히 막힘
  reset({
    subs: [{ name: '가족하나', phone: '010-5555-0001' }, { name: '가족둘', phone: '010-5555-0001' }],
    cards: [{ id: 'card-self', kind: 'self', name_key: '인소민', phone8: '41494334', status: 'active', merged_into: null }],
    app: { applicant_name: '', applicant_phone: '010-5555-0001', phone8: '55550001', participant_card_id: null },
  });
  await assert.rejects(identity.resolveApplicationIdentity(ctx), (e) => e.code === 'SELECTED_IDENTITY_AMBIGUOUS', '이름 다른 두 명의는 여전히 확정 못 함');
  console.log('PASS 이름이 다른 명의는 접지 않는다(결정 174 ③ 유지)');

  // ⑤ 본인이 후보에 없으면 접지 않는다 — 같은 이름·번호 타계정 둘(본인 아님)은 목록 중복이라 카드도 한 장 → 여전히 막힘
  reset({
    subs: [{ name: '김중복', phone: '010-7000-0001' }, { name: '김중복', phone: '010-7000-0001' }],
    app: { applicant_name: '김중복', applicant_phone: '010-7000-0001', phone8: '70000001', participant_card_id: null },
  });
  await assert.rejects(identity.resolveApplicationIdentity(ctx), (e) => e.code === 'SELECTED_IDENTITY_AMBIGUOUS');
  console.log('PASS 본인 아닌 중복 칸은 종전처럼 막는다');

  // ⑥ 합친 명의: 그 명의가 합쳐 들어간 카드가 후보에 있을 때만 뺀다(레드팀 4)
  reset({
    subs: [{ name: '박가족', phone: '010-6000-0001' }, { name: '김가족', phone: '010-6000-0001' }],
    cards: [
      { id: 'card-self', kind: 'self', name_key: '인소민', phone8: '41494334', status: 'active', merged_into: null },
      { id: 'card-park', kind: 'sub', name_key: '박가족', phone8: '60000001', status: 'active', merged_into: null },
      { id: 'card-kim', kind: 'sub', name_key: '김가족', phone8: '60000001', status: 'merged', merged_into: 'card-other' },
    ],
    app: { applicant_name: '', applicant_phone: '010-6000-0001', phone8: '60000001', participant_card_id: null },
  });
  await assert.rejects(identity.resolveApplicationIdentity(ctx), (e) => e.code === 'SELECTED_IDENTITY_AMBIGUOUS', '다른 카드로 합쳐진 이름 다른 명의는 빼지 않는다');
  reset({
    subs: [{ name: '박가족', phone: '010-6000-0001' }, { name: '박 가족', phone: '010-6000-0001 ' }],
    cards: [
      { id: 'card-self', kind: 'self', name_key: '인소민', phone8: '41494334', status: 'active', merged_into: null },
      { id: 'card-park', kind: 'sub', name_key: '박가족', phone8: '60000001', status: 'active', merged_into: null },
    ],
    app: { applicant_name: '박가족', applicant_phone: '010-6000-0001', phone8: '60000001', participant_card_id: null },
  });
  // 같은 이름·번호 두 칸은 목록 중복(카드 1장) — 합침이 아니므로 종전처럼 막힌다
  await assert.rejects(identity.resolveApplicationIdentity(ctx), (e) => e.code === 'SELECTED_IDENTITY_AMBIGUOUS');
  // 담당자가 박가족(옛 번호)을 박가족(새 번호) 카드로 합쳤다 → 이름으로만 찾을 때 둘 다 걸려도 합쳐 들어간 카드로 확정
  reset({
    subs: [{ name: '박가족', phone: '010-6000-0001' }, { name: '박가족', phone: '010-6000-0009' }],
    cards: [
      { id: 'card-self', kind: 'self', name_key: '인소민', phone8: '41494334', status: 'active', merged_into: null },
      { id: 'card-park', kind: 'sub', name_key: '박가족', phone8: '60000001', status: 'active', merged_into: null },
      { id: 'card-old', kind: 'sub', name_key: '박가족', phone8: '60000009', status: 'merged', merged_into: 'card-park' },
    ],
    app: { applicant_name: '박가족', applicant_phone: '010-1111-1111', phone8: '11111111', participant_card_id: null },
  });
  r = await identity.resolveApplicationIdentity(ctx);
  assert.strictEqual(r.selected.cardId, 'card-park', '합쳐 들어간 카드가 후보에 있으면 합쳐진 칸을 뺀다');
  console.log('PASS 합친 명의는 합쳐 들어간 카드가 후보에 있을 때만 뺀다');

  // 제출 게이트: 카드를 못 골랐으면 participantCardId 칸을 싣지 않는다(Codex P2 — null 이면 원장이 신청행 카드를 버린다)
  const submitSrc = require('fs').readFileSync(require('path').resolve(__dirname, '../src/routes/submit.routes.js'), 'utf8');
  assert(/\.\.\.\(verifiedIdentity\.context\.selected\.cardId \? \{ participantCardId: verifiedIdentity\.context\.selected\.cardId \} : \{\}\)/.test(submitSrc), '못 고른 카드는 칸째 생략');
  console.log('PASS 제출 게이트 — 못 고른 카드는 싣지 않는다');
})().catch((e) => { console.error(e); process.exit(1); });
