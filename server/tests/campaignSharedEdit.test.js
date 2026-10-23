/**
 * 양방향 4단계-2(결정 274) — 공고 편집 창의 공유 글 칸 → 작업오더 값(campaignSharedEdit, 순수).
 *   ① 손대지 않은 칸은 기준(창을 연 시점) 공고 모습과 같으면 아무것도 보내지 않는다(지금 값과 비교하지 않는다)
 *   ② 칸마다 되돌리기 + 왕복 검사(다시 투영하면 보낸 값이 그대로)
 *   ③ 되돌릴 수 없는 칸 = unmappable(썸네일 지우기·가이드에 주소가 있는 랜딩·글자와 다른 시간창)
 *   ④ 리뷰가이드 구간만 바꾸고 다른 구간·메타 줄은 그대로
 *   ⑤ 옛 화면 판정(drift) · 가이드유입 공고의 랜딩은 공유 칸이 아니다
 */
const assert = require('assert');
const E = require('../src/utils/campaignSharedEdit');

const base = {
  review_guide: '[리뷰등록 가이드]\n사진 3장 올려주세요\n쿠팡상품번호: 123\n\n[유입가이드 첨부 이미지]\nhttps://x/api/order/guide-image/a',
  special_notes: '주의 사항 없음', guide_images: JSON.stringify({ inflow: ['https://x/api/order/guide-image/inflow_img_0000000000001'] }),
  inflow_type: 'link', inflow_guide: '', thumbnail_url: 'https://x/thumb.jpg', purchase_time: '13:00 ~ 18:00',
  product_url: 'https://www.coupang.com/vp/products/1', purchase_channel: '쿠팡', purchase_channel_custom: false,
};
const v0 = E.campaignViewOf(base, {});
const camp = {
  participation_mode: true, window_start: '13:00:00', window_end: '18:00:00',
  work_detail: { reviewGuide: v0.reviewGuide, specialNotes: v0.specialNotes, reviewGuideImages: v0.reviewGuideImages, specialNotesImages: v0.specialNotesImages, inflowType: v0.inflowType, productLines: '상품 줄' },
  thumbnail_url: v0.thumbnail_url, time_range: v0.time_range, landing_url: v0.landing_url, channel: '쿠팡', channel_custom: '',
};
assert.equal(v0.reviewGuide, '사진 3장 올려주세요', '투영 = 가이드 구간만, 메타 줄 제거');
const bodyOf = (over = {}, wd = {}) => ({
  title: '공고', thumbnail_url: camp.thumbnail_url, time_range: camp.time_range, landing_url: camp.landing_url, channel: camp.channel, channel_custom: '',
  window_start: '13:00', window_end: '18:00',
  work_detail: { ...camp.work_detail, ...wd }, ...over,
});

// ① 손대지 않음 = 보낼 것 없음
{
  const p = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf() });
  assert.deepEqual(p.mine, {}); assert.deepEqual(p.unmappable, []); assert.deepEqual(p.changed, []);
  // 창을 연 뒤 인트라넷이 특이사항을 바꿨어도(지금 공고 ≠ 기준) 화면이 옛 값을 그대로 보내면 "손대지 않음"
  const campNow = { ...camp, work_detail: { ...camp.work_detail, specialNotes: '인트라넷이 바꾼 값' } };
  const p2 = E.planCampaignSharedEdit({ baseState: base, camp: campNow, body: bodyOf() });
  assert.deepEqual(p2.mine, {}, '지금 값과 비교했다면 옛 값으로 되돌렸을 것');
}
// ② 칸마다 되돌리기
{
  const p = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({}, { reviewGuide: '사진 5장 + 50자', specialNotes: '박스 사진 필수' }) });
  assert.deepEqual(p.unmappable, []);
  assert.equal(p.mine.special_notes, '박스 사진 필수');
  assert.equal(p.mine.review_guide, '[리뷰등록 가이드]\n사진 5장 + 50자\n쿠팡상품번호: 123\n\n[유입가이드 첨부 이미지]\nhttps://x/api/order/guide-image/a',
    '가이드 구간 글만 바뀌고 메타 줄·다른 구간은 그대로');
  assert.deepEqual(p.changed.sort(), ['리뷰가이드', '특이사항']);
  const img = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({}, { reviewGuideImages: ['https://x/api/order/guide-image/review_img_0000000000001'] }) });
  assert.deepEqual(JSON.parse(img.mine.guide_images), { inflow: ['https://x/api/order/guide-image/inflow_img_0000000000001'], review: ['https://x/api/order/guide-image/review_img_0000000000001'] }, '유입 사진은 그대로');
  const ch = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ channel: '직접입력', channel_custom: '자사몰' }) });
  assert.deepEqual(ch.mine, { purchase_channel: '자사몰', purchase_channel_custom: true }); assert.deepEqual(ch.unmappable, []);
  const nv = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ channel: '네이버' }) });
  assert.deepEqual(nv.mine, { purchase_channel: '네이버', purchase_channel_custom: false });
  const tm = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ time_range: '14:00 ~ 17:00', window_start: '14:00', window_end: '17:00' }) });
  assert.deepEqual(tm.mine, { purchase_time: '14:00 ~ 17:00' }); assert.deepEqual(tm.unmappable, []);
  const ld = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ landing_url: 'https://www.coupang.com/vp/products/2' }) });
  assert.deepEqual(ld.mine, { product_url: 'https://www.coupang.com/vp/products/2' }); assert.deepEqual(ld.unmappable, []);
  const th = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ thumbnail_url: 'https://x/t2.jpg' }) });
  assert.deepEqual(th.mine, { thumbnail_url: 'https://x/t2.jpg' });
  const it = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({}, { inflowType: 'guide' }) });
  assert.deepEqual(it.mine, { inflow_type: 'guide' });
}
// ③ 되돌릴 수 없는 칸
{
  const clear = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ thumbnail_url: '' }) });
  assert.deepEqual(clear.unmappable.map(u => u.key), ['thumbnail_url'], '썸네일 지우기는 투영이 안 지운다 → 말한다');
  const withGuideUrl = { ...base, inflow_guide: '검색 후 https://www.coupang.com/vp/products/9 로 들어가기' };
  const v1 = E.campaignViewOf(withGuideUrl, {});
  const camp1 = { ...camp, landing_url: v1.landing_url };
  const ld = E.planCampaignSharedEdit({ baseState: withGuideUrl, camp: camp1, body: { ...bodyOf(), landing_url: 'https://www.coupang.com/vp/products/2' } });
  assert.deepEqual(ld.unmappable.map(u => u.key), ['landing_url'], '랜딩이 가이드 주소에서 나오면 상품 주소를 바꿔도 안 바뀐다');
  const win = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ time_range: '14:00 ~ 17:00', window_start: '15:00', window_end: '17:00' }) });
  assert.deepEqual(win.unmappable.map(u => u.label), ['구매시간(시간창)']);
  const winOnly = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ window_start: '10:00', window_end: '12:00' }) });
  assert.deepEqual(winOnly.unmappable.map(u => u.label), ['구매시간(시간창)'], '글자는 그대로 두고 시각만 바꾸면 조용히 버리지 않고 말한다');
  const unparsed = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ time_range: '적당히 아무때나', window_start: '13:00', window_end: '18:00' }) });
  assert.ok(unparsed.unmappable.some(u => u.key === 'time_range'), '읽지 못하는 구매시간 글자');
  const meta = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({}, { reviewGuide: '쿠팡상품번호: 999' }) });
  assert.deepEqual(meta.unmappable.map(u => u.key), ['reviewGuide'], '투영이 걷어내는 줄만 쓰면 그대로 안 나온다');
}
// ④ 리뷰가이드 구간
{
  assert.equal(E.replaceReviewSection('그냥 글', '새 글'), '새 글', '구간 라벨이 없으면 통째');
  assert.equal(E.replaceReviewSection('[특이사항]\n주의', '새 가이드'), '[리뷰등록 가이드]\n새 가이드\n\n[특이사항]\n주의', '가이드 구간이 없으면 앞에 만든다');
  assert.equal(E.replaceReviewSection('[리뷰가이드] 한 줄 글\n둘째 줄\n[기타]\n남김', '바뀐 글'), '[리뷰가이드]\n바뀐 글\n\n[기타]\n남김');
  for (const raw of ['그냥 글', '[특이사항]\n주의', base.review_guide, '[리뷰가이드] 한 줄\n[리뷰 가이드]\n둘째 구간']) {
    const out = E.replaceReviewSection(raw, '왕복 확인 글');
    assert.equal(E.campaignViewOf({ ...base, review_guide: out }, {}).reviewGuide, '왕복 확인 글', raw);
  }
}
// ⑤ 옛 화면 · 랜딩 공유 여부
{
  assert.deepEqual(E.driftFromCampaign(camp, bodyOf()), []);
  assert.deepEqual(E.driftFromCampaign(camp, bodyOf({}, { specialNotes: '다름' })), ['특이사항']);
  assert.equal(E.landingIsShared({ inflow_type: 'link' }, {}), true);
  assert.equal(E.landingIsShared({ inflow_type: 'link' }, { work_detail: { inflowType: 'guide' } }), false, '화면이 가이드유입으로 바꾸면 랜딩은 공고 전용');
  const g = { ...base, inflow_type: 'guide' };
  const p = E.planCampaignSharedEdit({ baseState: g, camp: { ...camp, work_detail: { ...camp.work_detail, inflowType: 'guide' } },
    body: bodyOf({ landing_url: 'https://anything' }, { inflowType: 'guide' }) });
  assert.deepEqual(p.mine, {}, '가이드유입 공고의 랜딩 = 공유 칸 아님(종전 저장이 쓴다)');
  assert.deepEqual(p.unmappable, []);
}
// ⑥ 시간창 — 글자를 안 고쳤으면 화면 시각을 써도 되는가(windowsWritable)
{
  const p1 = E.planCampaignSharedEdit({ baseState: base, camp: { ...camp, window_start: null, window_end: null }, body: bodyOf() });
  assert.equal(p1.windowsWritable, true, '글자는 있는데 시각이 비어 있던 공고 — 저장으로 바로잡던 종전 동작 유지');
  assert.deepEqual(p1.unmappable, []);
  const raced = { ...camp, time_range: '14:00 ~ 17:00', window_start: '14:00:00', window_end: '17:00:00' };
  const p2 = E.planCampaignSharedEdit({ baseState: base, camp: raced, body: bodyOf() });
  assert.deepEqual(p2.unmappable, [], '창을 연 뒤 인트라넷이 구매시간을 바꿔도, 손대지 않은 관리자 저장은 막히지 않는다');
  assert.equal(p2.windowsWritable, false, '그때는 옛 시각을 쓰지 않는다(새 글자와 어긋남)');
  const p3 = E.planCampaignSharedEdit({ baseState: base, camp, body: bodyOf({ time_range: '14:00 ~ 17:00', window_start: '14:00', window_end: '17:00' }) });
  assert.equal(p3.windowsWritable, false, '글자를 고치면 시각은 공유 저장(투영)이 쓴다');
}
console.log('campaignSharedEdit: passed');
