'use strict';
/**
 * 회귀가드 — 접수 뒤 **유입방식·구매시간대** 수정 + 모집공고 전파 (사용자 확정 2026-09-22)
 *
 * 실행: node tests/inflowSourceEdit.test.js
 *
 * ★ 이 가드가 지키는 것:
 *   ① 두 칸은 **작업표와 무관**하다 — 작업표를 만드는 코드에 유입·구매시간 참조가 0건이어야 한다
 *      (하나라도 생기면 "접수 뒤에도 고칠 수 있다" 는 전제가 무너진다)
 *   ② 화면 쪽 규칙과 **서버 사본이 갈리지 않는다** — 같은 입력으로 실제 실행해 출력을 대조한다
 *      (유입가이드 조립 · 구매시간 해석 둘 다)
 *   ③ **가이드가 빈 채로 가이드유입이 되지 않는다** — 전파 뒤 상태로 검사하고 걸리면 되돌린다
 *   ④ 구매시간은 **해석 못 하면 아무것도 바꾸지 않는다** · 참여형 공고만
 *   ⑤ 쓰기 표면 = 공고 선택지 가이드 칸 · 공고 work_detail · 시간창 두 칸뿐
 *   ⑥ 실패해도 throw 하지 않는다(원본 수정 저장을 되돌리면 안 된다)
 *   ⑦ 용어 — 보이는 말은 "가이드유입", **저장값과 약속 문구는 그대로**
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'));
const compose = require(path.join(ROOT, 'src/utils/inflowGuideCompose.js'));
const { parsePurchaseTime } = require(path.join(ROOT, 'src/utils/purchaseTimeWindow.js'));
const SVC = fs.readFileSync(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'), 'utf8');
const ROUTE = fs.readFileSync(path.join(ROOT, 'src/routes/order.routes.js'), 'utf8');
const PLAN = fs.readFileSync(path.join(ROOT, 'src/utils/worktablePlan.js'), 'utf8');
const WOD = fs.readFileSync(path.join(ROOT, '../frontend/js/work-order-detail.js'), 'utf8');
const RECRUIT = fs.readFileSync(path.join(ROOT, '../frontend/js/index-recruit.js'), 'utf8');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

/** 프론트 함수 하나를 vm 으로 꺼내 실행 가능한 형태로 돌려준다(의존 함수까지 함께 넣는다). */
function frontFns(source, names, extra = '') {
  const sandbox = { console };
  vm.createContext(sandbox);
  const picked = names.map(n => {
    const i = source.indexOf('function ' + n + '(');
    assert.ok(i >= 0, '프론트에서 ' + n + ' 를 못 찾았다');
    // 함수 본문 끝(들여쓰기 없는 닫는 중괄호)까지
    const end = source.indexOf('\n}', i);
    assert.ok(end > i, n + ' 본문 경계를 못 찾았다');
    return source.slice(i, end + 2);
  }).join('\n');
  vm.runInContext(extra + '\n' + picked + '\n', sandbox);
  return sandbox;
}

/** 스텁 pool — 실행된 쿼리를 전부 기록한다. */
function stub({ campaign = { id: 'camp_1' }, liveOptions = [], workDetail = null,
  participation = true, windowRows = 1 } = {}) {
  const q = [];
  const client = {
    query: async (sql, params) => {
      const s = String(sql);
      q.push({ sql: s, params });
      if (/FROM work_orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: 'wo_1', linked_campaign_id: 'camp_1' }] };
      if (/FROM recruit_campaigns\s+WHERE \(id = \$1/.test(s)) return { rows: campaign ? [campaign] : [] };
      if (/SELECT participation_mode FROM recruit_campaigns/.test(s)) return { rows: [{ participation_mode: participation }] };
      if (/SELECT work_detail FROM recruit_campaigns/.test(s)) return { rows: [{ work_detail: workDetail }] };
      if (/FROM campaign_options/.test(s)) return { rows: liveOptions };
      if (/UPDATE recruit_campaigns SET window_start/.test(s)) return { rowCount: windowRows, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release: () => {},
  };
  svc.__setPoolForTest({ connect: async () => client });
  return q;
}
const writes = q => q.filter(x => /^\s*UPDATE|INSERT|DELETE/i.test(x.sql));
const IMG = 'https://x.dev/api/order/guide-image/' + 'a'.repeat(22);

async function run() {
  console.log('\n접수 뒤 유입방식·구매시간대 수정');

  /* ── ① 작업표 무관 ───────────────────────────────────────────────────────── */
  await t('① 작업표를 만드는 코드에 유입·구매시간 참조가 0건', () => {
    const body = PLAN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/inflow/i.test(body), '작업표 계산이 유입방식을 본다 — 접수 뒤 수정 허용 전제가 깨진다');
    assert.ok(!/purchase_time|purchaseTime/.test(body), '작업표 계산이 구매시간대를 본다');
  });

  await t('① 허용 목록에 두 칸이 있다', () => {
    const m = ROUTE.match(/const SOURCE_EDIT_AFTER_ACCEPT = \[([\s\S]*?)\];/);
    assert.ok(m, '허용 목록을 못 찾았다');
    assert.ok(/'inflow_type'/.test(m[1]), 'inflow_type 이 빠졌다');
    assert.ok(/'purchase_time'/.test(m[1]), 'purchase_time 이 빠졌다');
  });

  /* ── ② 사본 대조 ─────────────────────────────────────────────────────────── */
  await t('② 유입가이드 조립 — 서버 ≡ 화면(_woUnitGuide) 출력이 같다', () => {
    const f = frontFns(WOD, ['_driveId', '_woCleanGuide', '_woPlainGuideToHtml', '_woUnitGuide'],
      'const _WO_UNIT_GUIDE_IMG_MAX = 4;');
    const cases = [
      { guide: { text: '네이버에서 검색', images: [IMG] } },
      { guide: { text: '<p>이미 HTML</p>', images: [] } },
      { guide: { text: '꺾쇠 <옵션> 과 "따옴표"\n둘째 줄', images: [] } },
      { guide: { text: '사진 주소가 글 안에 ' + IMG + ' 섞임', images: [] } },
      { guide: { text: '드라이브 https://drive.google.com/file/d/' + 'b'.repeat(25) + '/view', images: [] } },
      { guide: { text: '', images: [IMG, IMG, 'http://bad/api/order/guide-image/' + 'c'.repeat(22)] } },
      { inflow_guide: '옛 초안 평문', guide_images: [IMG] },
      { guide: '문자열로 온 옛 초안' },
      {},
    ];
    cases.forEach((c, i) => {
      // ★ vm 안 객체는 **다른 realm** 이라 deepStrictEqual 이 프로토타입에서 갈린다 → 값으로 비교
      assert.strictEqual(JSON.stringify(compose.composeUnitGuide(c)), JSON.stringify(f._woUnitGuide(c)),
        i + '번째 입력에서 서버·화면 조립 결과가 갈렸다 — 한쪽만 고치면 "발행할 땐 사진이 뜨는데 인트라넷에서 고치면 주소 글자만" 이 된다');
    });
  });

  await t('② 구매시간 해석 — 서버 ≡ 화면(_parsePurchaseTime) 출력이 같다', () => {
    const f = frontFns(RECRUIT, ['_parsePurchaseTime']);
    ['오후 2시~5시', '14:00~17:00', '오전 10시 ~ 오후 1시', '2시-5시', '23시~24시',
      '9시~9시', '아무때나', '', '25시~26시', '10:70~11:00', '자율'].forEach(s => {
      assert.strictEqual(JSON.stringify(parsePurchaseTime(s)), JSON.stringify(f._parsePurchaseTime(s)),
        '"' + s + '" 에서 서버·화면 해석이 갈렸다 — "발행할 땐 2시인데 고치면 3시" 가 된다');
    });
  });

  /* ── ③ 가이드유입 fail-closed ────────────────────────────────────────────── */
  await t('③ 가이드유입인데 빈 선택지가 있으면 되돌린다(쓰기 반영 0)', async () => {
    const q = stub({ liveOptions: [{ opt_key: '레드', product_name: '핫팩', inflow_guide_html: '', inflow_guide_images: [] }],
      workDetail: { inflowType: 'link' } });
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'guide' });
    assert.strictEqual(out.applied, false, JSON.stringify(out));
    assert.strictEqual(out.reason, 'guide_missing');
    assert.deepStrictEqual(out.detail.missing, ['레드']);
    assert.ok(q.some(x => /ROLLBACK/.test(x.sql)), '되돌리지 않았다');
    assert.ok(!q.some(x => /COMMIT/.test(x.sql)), '커밋됐다 — 가이드 없는 가이드유입 공고가 만들어진다');
  });

  await t('③ 선택지 가이드가 함께 오면 적용된다', async () => {
    const opts = JSON.stringify([{
      name: '핫팩', product_mode: 'opt', base: { pay: 0 },
      options: [{ label: '레드', pay: 9190, guide: { text: '레드 안내', images: [IMG] } }],
    }]);
    const q = stub({ liveOptions: [{ opt_key: '레드', product_name: '핫팩', inflow_guide_html: '', inflow_guide_images: [] }],
      workDetail: { inflowType: 'link' } });
    // 선택지 가이드 UPDATE 뒤의 재조회가 "채워진 상태"를 보게 한다
    let filled = false;
    const orig = svc.__setPoolForTest;
    stubDynamic(q, () => filled, () => { filled = true; });
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'guide', productOptionsJson: opts });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    assert.strictEqual(out.inflowType, 'guide');
    assert.ok(orig, '스텁 주입 함수가 사라졌다');
  });

  await t('③ 링크유입으로 바꿀 때는 가이드 검사를 하지 않는다', async () => {
    const q = stub({ liveOptions: [{ opt_key: '레드', product_name: '핫팩', inflow_guide_html: '', inflow_guide_images: [] }],
      workDetail: { inflowType: 'guide' } });
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'link' });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    assert.ok(q.some(x => /COMMIT/.test(x.sql)));
  });

  await t('③ 옵션 없는 공고 — 공통 가이드도 비면 거부(화면 규칙보다 좁다)', async () => {
    const q = stub({ liveOptions: [], workDetail: { inflowType: 'link' } });
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'guide' });
    assert.strictEqual(out.applied, false, JSON.stringify(out));
    assert.strictEqual(out.reason, 'guide_missing');
    assert.ok(!q.some(x => /COMMIT/.test(x.sql)));
  });

  await t('③ 공통 가이드가 함께 오면 옵션 없는 공고도 적용된다', async () => {
    const q = stub({ liveOptions: [], workDetail: { inflowType: 'link' } });
    const out = await svc.syncCampaignInflow({
      workOrderId: 'wo_1', inflowType: 'guide', commonGuide: { text: '검색해서 들어오세요', images: '[]' } });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    const w = writes(q);
    assert.strictEqual(w.length, 1, '쓰기 횟수: ' + w.length);
    assert.ok(/UPDATE recruit_campaigns SET work_detail/.test(w[0].sql), w[0].sql);
    const wd = JSON.parse(w[0].params[1]);
    assert.strictEqual(wd.inflowType, 'guide');
    assert.ok(/검색해서 들어오세요/.test(wd.inflowGuideHtml), '가이드 글이 안 담겼다');
  });

  await t('③ 바뀐 것이 없으면 쓰기 0', async () => {
    const q = stub({ liveOptions: [], workDetail: { inflowType: 'link' } });
    const out = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'link' });
    assert.strictEqual(out.reason, 'already_same', JSON.stringify(out));
    assert.strictEqual(writes(q).length, 0, '안 바뀌었는데 썼다');
  });

  /* ── ④ 구매시간대 ────────────────────────────────────────────────────────── */
  await t('④ 해석 못 하는 문장이면 DB 를 열지도 않는다', async () => {
    let opened = false;
    svc.__setPoolForTest({ connect: async () => { opened = true; throw new Error('열면 안 된다'); } });
    const out = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '아무때나' });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'unparsed');
    assert.strictEqual(opened, false, '해석도 못 했는데 DB 를 열었다');
  });

  await t('④ 참여형이 아니면 바꾸지 않는다', async () => {
    const q = stub({ participation: false });
    const out = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '오후 2시~5시' });
    assert.strictEqual(out.reason, 'not_participation', JSON.stringify(out));
    assert.strictEqual(writes(q).length, 0);
  });

  await t('④ 참여형이면 시간창 두 칸만 바꾼다', async () => {
    const q = stub({});
    const out = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '오후 2시~5시' });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    assert.deepStrictEqual(out.window, { start: '14:00', end: '17:00' });
    const w = writes(q);
    assert.strictEqual(w.length, 1, '쓰기 횟수: ' + w.length);
    assert.ok(/SET window_start = \$2, window_end = \$3/.test(w[0].sql), w[0].sql);
    assert.deepStrictEqual(w[0].params.slice(1), ['14:00:00', '17:00:00']);
  });

  /* ── ⑤ 쓰기 표면 ─────────────────────────────────────────────────────────── */
  await t('⑤ 쓰기 표면은 세 곳뿐(정원·옵션 구성·작업표·주문·시트 무접촉)', () => {
    const body = SVC.slice(SVC.indexOf('async function syncCampaignInflow'));
    const tables = [...body.matchAll(/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)\s+WHERE/gi)]
      .map(m => m[1] + ': ' + m[2].replace(/\s+/g, ' ').trim());
    tables.forEach(x => {
      assert.ok(
        /^campaign_options: inflow_guide_html = \$3, inflow_guide_images = \$4::jsonb, updated_at = NOW\(\)$/.test(x)
        || /^recruit_campaigns: work_detail = \$2::jsonb, updated_at = NOW\(\)$/.test(x)
        || /^recruit_campaigns: window_start = \$2, window_end = \$3, updated_at = NOW\(\)$/.test(x),
        '허용되지 않은 쓰기가 늘었다: ' + x);
    });
    assert.ok(tables.length >= 3, '쓰기 문장을 못 읽었다(정규식 드리프트): ' + tables.length);
  });

  await t('⑥ 어떤 실패에도 throw 하지 않는다', async () => {
    svc.__setPoolForTest({ connect: async () => { throw new Error('DB 죽음'); } });
    const a = await svc.syncCampaignInflow({ workOrderId: 'wo_1', inflowType: 'guide' });
    const b = await svc.syncCampaignPurchaseWindow({ workOrderId: 'wo_1', purchaseTime: '2시~5시' });
    assert.strictEqual(a.reason, 'db_unavailable', JSON.stringify(a));
    assert.strictEqual(b.reason, 'db_unavailable', JSON.stringify(b));
  });

  /* ── ⑦ 라우트 배선 ───────────────────────────────────────────────────────── */
  await t('⑦ 유입·시간 전파를 실제로 부르고 결과를 응답에 싣는다', () => {
    assert.ok(/syncCampaignInflow\(\{/.test(ROUTE), '유입 전파를 부르지 않는다');
    assert.ok(/syncCampaignPurchaseWindow\(\{/.test(ROUTE), '시간창 전파를 부르지 않는다');
    assert.ok(/campaign_inflow_sync: campaignInflowSync/.test(ROUTE), '유입 전파 결과를 안 싣는다');
    assert.ok(/campaign_time_sync: campaignTimeSync/.test(ROUTE), '시간창 전파 결과를 안 싣는다');
    // 가이드만 바꿔도 전파가 돌아야 한다(방식만 보면 글 수정이 공고에 안 간다)
    const m = ROUTE.match(/const _inflowTouched = \[([^\]]*)\]/);
    assert.ok(m, '유입 전파 조건을 못 찾았다');
    ['inflow_type', 'inflow_guide', 'guide_images'].forEach(f =>
      assert.ok(m[1].includes("'" + f + "'"), f + ' 가 전파 조건에서 빠졌다'));
  });

  /* ── ⑧ 용어 ──────────────────────────────────────────────────────────────── */
  await t('⑧ 보이는 말은 "가이드유입" — 저장값·약속 문구는 그대로', () => {
    assert.ok(/_INFLOW_LABEL = \{ guide: "가이드유입"/.test(WOD), '유입방식 라벨이 옛 말이다');
    // 사진을 주고받는 약속 문구는 바뀌면 안 된다(이미 저장된 오더 본문 안에 그 글자로 들어 있다)
    assert.ok(/유입가이드.{0,4}첨부.{0,4}이미지/.test(
      fs.readFileSync(path.join(ROOT, 'src/utils/inflowGuideCompose.js'), 'utf8')),
      '첨부 이미지 약속 문구가 바뀌었다 — 예전 오더의 사진이 사라진다');
  });

  console.log(`\n  통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
}

/** 선택지 가이드를 쓴 **뒤**의 재조회가 채워진 상태를 보게 하는 스텁(전파 뒤 검사 경로 확인용). */
function stubDynamic(q, isFilled, markFilled) {
  const client = {
    query: async (sql, params) => {
      const s = String(sql);
      q.push({ sql: s, params });
      if (/FROM work_orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: 'wo_1', linked_campaign_id: 'camp_1' }] };
      if (/FROM recruit_campaigns\s+WHERE \(id = \$1/.test(s)) return { rows: [{ id: 'camp_1' }] };
      if (/SELECT work_detail FROM recruit_campaigns/.test(s)) return { rows: [{ work_detail: { inflowType: 'link' } }] };
      if (/UPDATE campaign_options/.test(s)) { markFilled(); return { rowCount: 1, rows: [] }; }
      if (/FROM campaign_options/.test(s)) {
        return { rows: [{ opt_key: '레드', product_name: '핫팩',
          inflow_guide_html: isFilled() ? '레드 안내' : '', inflow_guide_images: isFilled() ? [IMG] : [] }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => {},
  };
  svc.__setPoolForTest({ connect: async () => client });
}

run();
