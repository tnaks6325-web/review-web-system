/**
 * 양방향 4단계-3(결정 263) — 공유 칸 쓰기 경로 허용목록(정적 가드).
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
    'product_url', 'purchase_channel', 'purchase_channel_custom', 'required_delivery_memo', 'product_options_json'],
  recruit_campaigns: ['work_detail', 'thumbnail_url', 'time_range', 'window_start', 'window_end', 'landing_url', 'channel', 'channel_custom'],
  campaign_options: ['option_url', 'inflow_guide_html', 'inflow_guide_images'],
};
/** 파일|함수(또는 라우트)|표 → 왜 괜찮은가. */
const ALLOW = {
  'routes/campaign.routes.js|_scopedCampaignEdit|recruit_campaigns': '연결 공고면 scopedEditSharedBlock 이 공유 칸 변경을 먼저 막는다(③)',
  'routes/campaign.routes.js|/admin/:id|recruit_campaigns': '연결 공고면 applyCampaignSharedSave 뒤 공유 칸 매개변수를 비운다(_bx · $52)',
  'routes/order.routes.js|_intakeSourceRevisionHandler|work_orders': '연결+apply 면 그 앞에서 _intakeSourceBidir 로 갈라진다(종전 경로 = 연결 안 됨·스위치 off)',
  'services/campaignPayAmountSync.service.js|syncCampaignPayAmount|recruit_campaigns': '옛 원본 수정 경로의 전파(금액 — 5단계)',
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
    const fm = [...ord.slice(0, m.index).matchAll(/(?:async\s+)?function\s+(\w+)|router\.(?:get|put|post|patch|delete)\('([^']+)'/g)].pop();
    return fm ? (fm[1] || fm[2]) : '?';
  });
  assert.deepEqual(dyn, ['_intakeUpdateHandler', '/admin/edit'], '동적 SET 으로 작업오더를 쓰는 곳: ' + dyn.join(','));
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
  assert.match(upd, /SELECT id, status, deleted_at, delivery_type, courier_proxy, linked_campaign_id, bidir_state FROM work_orders/);
  assert.match(ord, /o\.bidir_state === 'on' && \(await readBidirSwitch\(pool\)\)\.in2rw === 'apply'/, '관리자 수정 갈림');
  const camp = fs.readFileSync(path.join(SRC, 'routes/campaign.routes.js'), 'utf8');
  assert.match(camp, /scopedEditSharedBlock\(\{ campaignId: id, body: b \}\)/);
  assert.match(camp, /\.applyCampaignSharedSave\(\{ campaignId: id, body: req\.body/);
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
