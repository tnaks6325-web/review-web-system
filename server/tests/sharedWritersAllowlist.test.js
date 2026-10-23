/**
 * 양방향 4단계-3(결정 274) — 공유 칸 쓰기 경로 허용목록(정적 가드).
 *
 * 연결 오더의 공유 칸은 `applySharedPatch` 한 곳으로만 바뀌어야 한다(완화 금지 ①). 그런데 같은 칸을 쓰는 옛 경로가 남아 있다
 * (스위치가 꺼졌거나 연결 안 된 오더용 · 공유 저장의 투영 본체). 그래서 **어디서 그 칸을 쓰는지 전부 목록으로 고정**하고,
 * 새 쓰기 경로가 생기면 이 검사가 실패해 사람이 "공유 저장을 타야 하나" 를 판단하게 한다.
 *   ① 고정 SQL: `UPDATE work_orders|recruit_campaigns|campaign_options SET … <공유 칸> =` 를 파일·함수·칸으로 모아 허용목록과 대조
 *   ② 동적 SET(`UPDATE work_orders SET ${…}`) 위치 고정
 *   ③ 각 옛 경로가 연결 오더에서 막히거나 갈라지는 줄이 그대로 있는가
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const SHARED = {
  work_orders: ['review_guide', 'special_notes', 'guide_images', 'inflow_guide', 'inflow_type', 'thumbnail_url', 'purchase_time',
    'product_url', 'purchase_channel', 'purchase_channel_custom', 'required_delivery_memo', 'product_options_json',
    'review_fee', 'pay_amount', 'product_option'],   // 5단계 — 리뷰비 · 결제합계 · 상품 요약 문장
  recruit_campaigns: ['work_detail', 'thumbnail_url', 'time_range', 'window_start', 'window_end', 'landing_url', 'channel', 'channel_custom',
    'review_fee'],   // 5단계
  campaign_options: ['option_url', 'inflow_guide_html', 'inflow_guide_images', 'pay_amount'],   // 5단계 — 옵션 결제금액
};
/** 파일|함수(또는 라우트)|표 → 왜 괜찮은가. */
const ALLOW = {
  'routes/campaign.routes.js|_scopedCampaignEdit|recruit_campaigns': '연결 공고면 scopedEditSharedBlock 이 공유 칸 변경을 먼저 막는다(③) · 리뷰비는 같은 값도 다시 쓰지 않는다($17)',
  'routes/campaign.routes.js|/admin/:id|recruit_campaigns': '연결 공고면 applyCampaignSharedSave 뒤 공유 칸 매개변수를 비운다(_bx · $52 · 리뷰비 $8)',
  'services/campaignFeeChange.service.js|applyFeeChangeInTx|recruit_campaigns': '공유 저장 투영(리뷰비 — 지난 참여 금액 고정 · 구간과 함께 · 5단계)',
  'services/payment.service.js|saveTransferSetting|recruit_campaigns': '연결 공고면 바뀌는 리뷰비를 거부한다(bidirLinkActive · 5단계) — 이체은행·통장표시는 공유 칸 아님',
  'services/sharedPatch.service.js|_projectPayInTx|recruit_campaigns': '공유 저장 투영(옵션 없는 공고의 상품 금액 · 5단계)',
  'services/sharedPatch.service.js|_projectPayInTx|campaign_options': '공유 저장 투영(옵션 금액 · 금액 이력과 함께 · 5단계)',
  'services/sharedPatch.service.js|_projectGuideInTx|campaign_options': '공유 저장 투영(선택지 유입가이드 · 바뀐 줄만 · 6단계)',
  'services/sharedPatch.service.js|_projectStructureInTx|campaign_options': '공유 저장 투영(상품·옵션 더하기·지우기·마감·다시 열기 · 오더 상품 구성과 같은 트랜잭션 · 7단계-④)',
  'services/sharedPatch.service.js|_adoptSoleProductInTx|campaign_options': '공유 저장 투영 앞단(옵션 없는 상품 하나짜리 공고의 원래 상품 줄 만들기 · 같은 트랜잭션 · 7단계-④ ⑤-2)',
  'services/sharedPatch.service.js|_projectProductLinesInTx|recruit_campaigns': '공유 저장 투영(상품 안내 글 ← 발행 프리필 · 사람이 고친 글은 그대로 · 같은 트랜잭션 · 7단계-④ ⑤-2)',
  'services/campaignPayAmountSync.service.js|syncCampaignPayAmount|campaign_options': '옛 원본 수정 경로의 전파(금액) — 연결+apply 오더는 _intakeSourceBidir 로 갈라져 여기 오지 않는다',
  'routes/order.routes.js|_intakeSourceRevisionHandler|work_orders': '연결+apply 면 그 앞에서 _intakeSourceBidir 로 갈라진다(종전 경로 = 연결 안 됨·스위치 off)',
  'services/campaignPayAmountSync.service.js|syncCampaignPayAmount|recruit_campaigns': '옛 원본 수정 경로의 전파(금액 — 5단계)',
  // 결정 279: 가격 신고 [금액 고치기] — 연결 공고는 _editLinkedPrice 가 알림 트랜잭션 밖에서 먼저 공유 저장(applySharedPatch)을 탄다.
  //   여기 쓰기는 ① 연결 아닌 공고 ② 공유 저장 뒤 투영이 공고를 못 따라왔을 때 공고만 오더와 같은 금액으로 맞춤 — 오더와 갈라지지 않는다.
  'services/campaignPriceReport.service.js|_writePriceInTx|recruit_campaigns': '가격 신고 금액 고치기 — 연결 공고는 _editLinkedPrice(공유 저장) 먼저(결정 279)',
  'services/campaignPriceReport.service.js|_writePriceInTx|campaign_options': '가격 신고 금액 고치기 — 연결 공고는 _editLinkedPrice(공유 저장) 먼저(결정 279)',
  'services/campaignPayAmountSync.service.js|syncCampaignThumbnailInTx|recruit_campaigns': '공유 저장 투영 본체(트랜잭션 안) + 옛 래퍼',
  'services/campaignPayAmountSync.service.js|syncCampaignInflowInTx|recruit_campaigns': '공유 저장 투영 본체 + 옛 래퍼',
  'services/campaignPayAmountSync.service.js|syncCampaignInflowInTx|campaign_options': '공유 저장 투영 본체 + 옛 래퍼',
  'services/campaignPayAmountSync.service.js|syncCampaignPurchaseWindowInTx|recruit_campaigns': '공유 저장 투영 본체 + 옛 래퍼',
  'services/sharedPatch.service.js|projectToCampaignInTx|recruit_campaigns': '공유 저장 투영',
  'services/sharedPatch.service.js|projectToCampaignInTx|campaign_options': '공유 저장 투영',
};

function scan() {
  const out = new Set();
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(SRC);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const [t, cols] of Object.entries(SHARED)) {
      const re = new RegExp(`UPDATE\\s+${t}\\b`, 'g');
      let m;
      while ((m = re.exec(s))) {
        const seg = s.slice(m.index, m.index + 4000);
        const w = seg.search(/\bWHERE\b/);
        const set = seg.slice(0, w > 0 ? w : 800);
        if (!cols.some(c => new RegExp(`\\b${c}\\s*=`).test(set))) continue;
        const before = s.slice(0, m.index);
        const fm = [...before.matchAll(/(?:async\s+)?function\s+(\w+)|router\.(?:get|put|post|patch|delete)\('([^']+)'/g)].pop();
        out.add(`${path.relative(SRC, f)}|${fm ? (fm[1] || fm[2]) : '?'}|${t}`);
      }
    }
  }
  return out;
}

// ① 고정 SQL 쓰기 = 허용목록과 정확히 같다(늘어도·줄어도 실패 — 줄면 목록을 같이 줄인다)
{
  const found = scan();
  const extra = [...found].filter(k => !ALLOW[k]);
  const gone = Object.keys(ALLOW).filter(k => !found.has(k));
  assert.deepEqual(extra, [], `공유 칸을 쓰는 새 경로 — 연결 오더면 applySharedPatch 를 타야 하는지 판단하고 허용목록에 사유와 함께 넣어라: ${extra.join(' / ')}`);
  assert.deepEqual(gone, [], `허용목록에 있는데 사라진 경로(목록을 줄여라): ${gone.join(' / ')}`);
}

// ② 동적 SET 위치 고정
{
  const ord = fs.readFileSync(path.join(SRC, 'routes/order.routes.js'), 'utf8');
  const dyn = [...ord.matchAll(/UPDATE work_orders SET \$\{sets\.join/g)].map(m => {
    // main 결정 270: 관리자 수정은 공개 경로(router.put('/admin/edit')) 대신 이름 붙은 핸들러(_handlers.orderAdminEdit — Track B 가 이름으로 부른다)
    const fm = [...ord.slice(0, m.index).matchAll(/^(?:async\s+)?function\s+(\w+)|^router\.(?:get|put|post|patch|delete)\('([^']+)'|^_handlers\.(\w+) = /gm)].pop();
    return fm ? (fm[1] || fm[2] || fm[3]) : '?';
  });
  assert.deepEqual(dyn, ['_intakeUpdateHandler', 'orderAdminEdit'], '동적 SET 으로 작업오더를 쓰는 곳: ' + dyn.join(','));
  // 다른 파일에 동적 SET 작업오더 쓰기가 생기면 실패(공유 저장 본체 제외)
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(SRC);
  const others = files.filter(f => !/routes\/order\.routes\.js$|services\/sharedPatch\.service\.js$/.test(f))
    .filter(f => /UPDATE work_orders SET \$\{/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(others.map(f => path.relative(SRC, f)), []);

  // ③ 옛 경로의 갈림·막힘 줄
  const upd = ord.slice(ord.indexOf('async function _intakeUpdateHandler('), ord.indexOf("router.route('/intake/:id')"));
  const gate = upd.indexOf("if (cur[0].bidir_state === 'on' && (await readBidirSwitch(pool)).in2rw === 'apply')");
  assert.ok(gate > 0 && gate < upd.indexOf('UPDATE work_orders SET ${sets.join'), '옛 ID 직접 수정: 연결 오더 공유 칸은 쓰기 전에 막는다');
  assert.match(upd, /code: 'bidir_use_source'/);
  // ★ 7단계 🔴5: 접수 뒤 잠금 판정 재료(광고주·작업표 칸)를 같이 읽는다 — 검사 의미 불변 + 잠금 줄 추가(강화)
  assert.match(upd, /SELECT id, status, deleted_at, delivery_type, courier_proxy, linked_campaign_id, bidir_state, advertiser_id,/);
  const lockAt = upd.indexOf('if (isSourceEditLocked(cur[0])) {');
  assert.ok(lockAt > 0 && lockAt < upd.indexOf('UPDATE work_orders SET ${sets.join'), '옛 ID 직접 수정: 접수된 오더의 작업표 칸은 쓰기 전에 막는다');
  assert.match(upd, /code: 'accepted_worktable_locked'/);
  assert.match(ord, /o\.bidir_state === 'on' && \(await readBidirSwitch\(pool\)\)\.in2rw === 'apply'/, '관리자 수정 갈림');
  const camp = fs.readFileSync(path.join(SRC, 'routes/campaign.routes.js'), 'utf8');
  assert.match(camp, /scopedEditSharedBlock\(\{ campaignId: id, body: b \}\)/);
  assert.match(camp, /\.applyCampaignSharedSave\(\{ campaignId: id, body: req\.body/);
  // 5단계 — 리뷰비를 쓰는 옛 경로들
  assert.match(camp, /review_fee=CASE WHEN \$17::boolean THEN review_fee ELSE \$5 END/, '리뷰어앱 스코프 편집: 연결 공고면 리뷰비를 다시 쓰지 않는다');
  const pay = fs.readFileSync(path.join(SRC, 'services/payment.service.js'), 'utf8');
  const sts = pay.slice(pay.indexOf('async function saveTransferSetting('), pay.indexOf('async function saveTransferSetting(') + 6000);
  assert.ok(sts.indexOf("'bidir_linked_fee'") > 0 && sts.indexOf("'bidir_linked_fee'") < sts.indexOf('UPDATE recruit_campaigns'), '입금관리 공고 리뷰비: 연결 공고면 쓰기 전에 거부');
}

// ④ 새 오더의 연결 판정(공고 발행 뒤) — 스위치 off 면 안 함 · 실패해도 발행 성공
{
  const camp = fs.readFileSync(path.join(SRC, 'routes/campaign.routes.js'), 'utf8');
  const create = camp.slice(camp.indexOf("router.post('/admin/create'"), camp.indexOf("router.put('/admin/:id', authMiddleware"));
  const at = create.indexOf("linkSharedOrder({ workOrderId: _srcWoId");
  assert.ok(at > create.indexOf('_saveCampaignOptions(rows[0].id, normOpts)'), '옵션 저장 뒤에 판정(옵션까지 같아야 같은 공고)');
  assert.match(create, /\.in2rw !== 'off'\) \{\s*const lk = await require\('\.\.\/services\/sharedPatch\.service'\)\.linkSharedOrder/);
  assert.match(create, /catch \(e\) \{ logger\.warn\(`\[campaign\/create\] 양방향 연결 판정 실패\(공고는 발행됨\)/);
}
console.log('sharedWritersAllowlist: passed');
