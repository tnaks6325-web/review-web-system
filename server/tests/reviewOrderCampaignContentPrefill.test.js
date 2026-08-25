/* 7번 — 작업오더의 안내성 값은 공고 저장값이 비어 있을 때만 제안한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(root, 'server/src/routes/campaign.routes.js'), 'utf8');
const front = fs.readFileSync(path.join(root, 'frontend/js/index-recruit.js'), 'utf8');
let pass = 0;
const t = (name, ok) => { assert.ok(ok, name); console.log('  ✓ ' + name); pass++; };

console.log('\n── 7. 작업오더 안내성 값 → 모집공고 blank-only 프리필 ──');
t('관리자 수정 모달 상세 경로가 인증된 기존 전체 상세 핸들러를 재사용한다',
  /router\.get\('\/admin\/:id', authMiddleware, adminOrMasterMiddleware, getCampaignDetail\)/.test(server)
  && /router\.get\('\/:id', getCampaignDetail\)/.test(server));
t('서버는 기존 연결 작업오더 조회 한 번에 필요한 값만 더 가져온다',
  /'product_url', 'review_guide', 'special_notes', 'inflow_guide', 'guide_images'/.test(server)
  && (server.match(/linkedWorkOrderForCampaign\(rows\[0\]/g) || []).length === 1);
t('공고 행이나 work_detail을 고쳐 내려보내지 않고 가산 필드만 보낸다',
  /orderCampaignContent, roundsLock/.test(server)
  && !/work_detail: \{ \.\.\.rows\[0\]\.work_detail/.test(server));
t('조회 실패는 기존처럼 수정 모달을 열어 둔다', /작업오더 프리필\(혼합 조합·유입방식·시작일·안내값\) 실패/.test(server));

const start = front.indexOf('function _rfApplyOrderContentPrefill(');
const end = front.indexOf('\nwindow.rfSetInflowType', start);
assert.ok(start >= 0 && end > start, '프리필 함수 범위를 찾지 못했습니다');
const fn = front.slice(start, end);
function run({ order, wd, saved = {} }) {
  const els = Object.fromEntries(['rf_landing_url', 'rf_product_url', 'rf_wd_review', 'rf_wd_notes', 'rf_wd_inflow']
    .map(id => [id, { value: saved[id] || '', dataset: {}, addEventListener() {} }]));
  const images = {};
  const ctx = {
    window: {},
    document: { getElementById: id => els[id] || null },
    _igSetList: (kind, values) => { images[kind] = values; },
    _igLoadInflowHtml: value => 'plain:' + value,
    _igRenderAll() {}, showToast() {},
  };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nresult = _rfApplyOrderContentPrefill(order, wd);', Object.assign(ctx, { order, wd }));
  return { result: ctx.result, els, images };
}

const order = { productUrl: 'https://product', reviewGuide: '새 리뷰', specialNotes: '새 특이', inflowGuide: '새 유입', inflowHtml: '<b>새 유입</b>', reviewGuideImages: ['r'], specialNotesImages: ['n'] };
{
  const out = run({ order, wd: {} });
  t('빈 공고는 네 안내성 값을 작업오더에서 불러온다', out.result.length === 4
    && out.els.rf_landing_url.value === 'https://product' && out.els.rf_wd_review.value === '새 리뷰'
    && out.els.rf_wd_notes.value === '새 특이' && out.els.rf_wd_inflow.value === 'plain:<b>새 유입</b>');
  t('리뷰·특이사항 첨부도 각 칸으로 함께 불러온다', out.images.review[0] === 'r' && out.images.notes[0] === 'n');
}
{
  const out = run({ order, wd: { reviewGuide: '공고 리뷰', specialNotes: '공고 특이', inflowGuideHtml: '<p>공고 유입</p>' }, saved: { rf_landing_url: 'https://saved' } });
  t('이미 저장한 공고 값은 어떤 작업오더 값으로도 덮지 않는다', out.result.length === 0
    && out.els.rf_landing_url.value === 'https://saved' && out.els.rf_wd_review.value === '' && out.els.rf_wd_notes.value === '');
}
console.log(`\n✅ reviewOrderCampaignContentPrefill: ${pass} cases passed`);
