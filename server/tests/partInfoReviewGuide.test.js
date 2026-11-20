/**
 * 리뷰 내역 → 「참여상품 정보」 리뷰 가이드 (결정 384 · 결정 282 의 빠진 사본)
 *
 *   결정 282 는 리뷰가이드 [머리말] 고르기를 「인트라넷 자동 머리말만 버리고 사람이 쓴 제목·첫 머리말 앞 글은 남긴다」로
 *   바꿨는데, 참여상품 정보 팝업(participation-brief)의 서버 사본 `_pickReviewGuide` 만 옛 규칙으로 남았다.
 *   그래서 「[키워드] 적절하게 사용해서 작성 …」「아래 [키워드] 참고하여 작성 …」처럼 대괄호가 하나라도 있는
 *   가이드는 팝업에서 통째로 사라졌다(운영 진행 중 공고 20건 중 3건 · 2026-11-19 실측).
 *   또 팝업은 리뷰가이드 첨부 사진(work_detail.reviewGuideImages)을 아예 그리지 않았다.
 *
 *   확인:
 *     ① 사람이 쓴 [키워드] 머리말·첫 머리말 앞 글이 팝업 응답에 그대로 남는다(공고 화면과 같은 글)
 *     ② 인트라넷 옛 묶음은 종전대로 리뷰등록 가이드 내용만
 *     ③ 첨부 사진 = 우리 사진 통로 형식만 · 중복 제거 · 없으면 빈 배열
 *     ④ 단일 출처 — 서버 사본 함수가 없고, 발행 프리필과 같은 `_woPickSections` 를 쓴다
 *     ⑤ 화면 — 글·사진을 공고 화면과 같은 사진 렌더러로 그린다 · 사진만 있어도 가이드 칸이 나온다
 *
 *   ★ 실제 라우트 핸들러를 PGlite 에서 돌린다(행 소유권 게이트 포함).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('@electric-sql/pglite');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';

let passed = 0;
const ok = (n, c, x) => { assert(c, n + (x ? '  ← ' + x : '')); passed++; console.log('  ✓ ' + n); };

const OWNER = '00000000-0000-4000-8000-00000000000a';
const P8 = '29979075';
const IMG1 = 'AbCdEfGhIjKlMnOpQrStUv01';
const IMG2 = 'AbCdEfGhIjKlMnOpQrStUv02';
const GUIDES = {
  // 운영 신고 2건과 같은 모양(키워드는 가상)
  '탭키워드': { rg: '[키워드] 적절하게 사용해서 작성\n가상세럼, 가상보습세럼, 가상탄력세럼',
    imgs: ['https://old-host.example/api/order/guide-image/' + IMG1, 'https://x.example/api/order/guide-image/' + IMG1,
      'javascript:alert(1)', 'https://evil.example/a.png', '/api/order/guide-image/short', 'https://h/api/order/guide-image/' + IMG2] },
  '탭아래': { rg: '아래 [키워드] 참고하여 작성\n가상속눈썹세럼, 가상래쉬세럼', imgs: [] },
  '탭묶음': { rg: '[유입방식] 가이드유입\n[리뷰등록 가이드]\n사진 3장 이상\n[유입가이드]\n검색 경로 안내', imgs: null },
  '탭사진만': { rg: '', imgs: ['https://h/api/order/guide-image/' + IMG2] },
};

async function makeDb() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE reviewers(id uuid PRIMARY KEY, phone8 text, sub_accounts jsonb DEFAULT '[]');
    CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,folder_url text,capture_slots jsonb,income_type text,display_name text,campaign_name text,is_closed boolean DEFAULT false);
    CREATE TABLE recruit_campaigns(id text PRIMARY KEY,title text,chat_url text,landing_url text,source_work_order_id text,work_detail jsonb,linked_sheet_id text,linked_tab_name text,linked_tab_gid text,created_at timestamptz DEFAULT now());
    CREATE TABLE campaign_applications(id integer PRIMARY KEY, campaign_id text, order_submission_id uuid);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY, phone text, recipient text, orderer text, price text,
      sheet_id text, tab_name text, sheet_row integer, gid text, submitted_at timestamptz DEFAULT now() - interval '1 hour',
      deleted_at timestamptz, capture_file_id text, capture_file_id_2 text, capture_uploaded_at timestamptz,
      campaign_application_id integer, mirror_status text, owner_reviewer_id uuid);
    CREATE TABLE campaign_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_submission_id uuid,sheet_id text,tab_name text,seq integer,
      deleted_at timestamptz,row_json jsonb,owner_reviewer_id uuid,phone8 text,is_submitted boolean DEFAULT false);
    CREATE TABLE review_index(id uuid DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,phone8 text,row_json jsonb,submit_col2 text);
    CREATE TABLE participation_links(sheet_id text,tab_name text,row_index integer,phone8 text);
    CREATE TABLE work_orders(id text PRIMARY KEY,linked_campaign_id text,product_url text,updated_at timestamptz DEFAULT now());
    CREATE TABLE review_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,slot_key text,file_id text,uploaded_at timestamptz DEFAULT now());
    CREATE TABLE payment_batch_items(id uuid DEFAULT gen_random_uuid(),status text DEFAULT 'pending',sheet_id text,tab_name text,row_index integer,amount integer,paid_at timestamptz,transfer_memo text,created_at timestamptz DEFAULT now());
  `);
  await pg.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/215_dual_channel_purchase_bundles.sql'), 'utf8'));
  await pg.query(`INSERT INTO reviewers VALUES ($1,$2,'[]')`, [OWNER, P8]);
  let i = 0;
  for (const [tab, g] of Object.entries(GUIDES)) {
    i++;
    const wd = { productLines: '가상 상품', reviewGuide: g.rg };
    if (g.imgs) wd.reviewGuideImages = g.imgs;
    await pg.query(`INSERT INTO recruit_campaigns(id,title,linked_sheet_id,linked_tab_name,work_detail) VALUES ($1,'가상 공고','wt_s',$2,$3)`,
      ['camp_' + i, tab, JSON.stringify(wd)]);
    await pg.query(`INSERT INTO review_index(sheet_id,tab_name,row_index,phone8,row_json) VALUES ('wt_s',$1,2,$2,'{}')`, [tab, P8]);
  }
  return { query: (s, p) => pg.query(s, p), pg };
}

function routeHandler(router, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods.get);
  assert(layer, '라우트 없음 ' + p);
  const st = layer.route.stack; return st[st.length - 1].handle;
}
const callGet = (h, req) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  Promise.resolve(h(req, res, e => resolve({ err: e }))).catch(e => resolve({ err: e }));
});
const reqFor = tab => ({
  query: { phone8: P8, sheetId: 'wt_s', tabName: tab, rowIndex: '2' },
  reviewer: { ownerReviewerId: OWNER, loginKind: 'self', loginPhone8: P8 },
});

(async () => {
  const db = await makeDb();
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: db };
  const router = require('../src/routes/reviewEdit.routes');
  const brief = routeHandler(router, '/participation-brief');
  const get = async tab => {
    const r = await callGet(brief, reqFor(tab));
    assert(!r.err, String(r.err && r.err.stack));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.brief;
  };

  console.log('\n[① 사람이 쓴 [키워드] 머리말이 남는다]');
  const kw = await get('탭키워드');
  ok('「[키워드] …」로 시작하는 가이드가 통째로 남는다',
    kw.reviewGuide === GUIDES['탭키워드'].rg, JSON.stringify(kw.reviewGuide));
  const below = await get('탭아래');
  ok('「아래 [키워드] 참고하여 작성 …」(문장 중간 대괄호)도 통째로 남는다',
    below.reviewGuide === GUIDES['탭아래'].rg, JSON.stringify(below.reviewGuide));

  console.log('\n[② 인트라넷 옛 묶음은 종전대로]');
  const blob = await get('탭묶음');
  ok('자동 머리말은 버리고 리뷰등록 가이드 내용만', blob.reviewGuide === '사진 3장 이상', JSON.stringify(blob.reviewGuide));

  console.log('\n[③ 첨부 사진]');
  ok('우리 사진 통로 형식만 · 같은 사진은 한 번 · 순서 유지',
    JSON.stringify(kw.reviewGuideImages) === JSON.stringify([GUIDES['탭키워드'].imgs[0], GUIDES['탭키워드'].imgs[5]]),
    JSON.stringify(kw.reviewGuideImages));
  ok('사진이 없으면 빈 배열', Array.isArray(below.reviewGuideImages) && below.reviewGuideImages.length === 0
    && Array.isArray(blob.reviewGuideImages) && blob.reviewGuideImages.length === 0, JSON.stringify([below.reviewGuideImages, blob.reviewGuideImages]));
  const photoOnly = await get('탭사진만');
  ok('글 없이 사진만 있는 가이드도 사진은 내려온다', photoOnly.reviewGuide === '' && photoOnly.reviewGuideImages.length === 1,
    JSON.stringify(photoOnly));

  console.log('\n[④ 단일 출처]');
  const route = fs.readFileSync(path.resolve(__dirname, '../src/routes/reviewEdit.routes.js'), 'utf8');
  ok('옛 서버 사본(_pickReviewGuide)이 없다', !/function _pickReviewGuide/.test(route));
  ok('발행 프리필과 같은 _woPickSections 를 리뷰등록 가이드 라벨로 쓴다',
    /require\(['"]\.\.\/utils\/woCampaignPrefill\.generated['"]\)/.test(route)
      && /_woPickSections\(String\(\(wd && wd\.reviewGuide\) \|\| ''\),\s*\[\s*'리뷰등록 가이드',\s*'리뷰가이드',\s*'리뷰 가이드'\s*\]\)/.test(route));

  console.log('\n[⑤ 화면 — 참여상품 정보 팝업]');
  const home = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');
  const head = 'function _partInfoGuideHtml(brief)';
  const s = home.indexOf(head);
  ok('가이드 그리기 함수가 있다', s >= 0);
  const fn = home.slice(s, home.indexOf('\nfunction ', s + head.length));
  // 공고 화면과 같은 실제 사진 렌더러(campaign-workdetail.js)를 싣는다
  const win = { API_BASE_URL: 'https://api.example' };
  const cwd = { window: win, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } } };
  vm.createContext(cwd);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../frontend/js/campaign-workdetail.js'), 'utf8'), cwd);
  const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ctx = { escHtml: esc, API_BASE_URL: 'https://api.example', window: { CampWorkDetail: win.CampWorkDetail } };
  ctx.CampWorkDetail = win.CampWorkDetail;
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  const h1 = ctx._partInfoGuideHtml(kw);
  ok('글이 그대로 보이고([키워드] 포함) 사진 2장이 우리 주소로 그려진다',
    h1.includes('📝 리뷰 가이드') && h1.includes('[키워드] 적절하게 사용해서 작성')
      && (h1.match(/<img /g) || []).length === 2
      && h1.includes('src="https://api.example/api/order/guide-image/' + IMG1 + '"')
      && !h1.includes('old-host.example') && !h1.includes('evil.example') && !h1.includes('javascript:'), h1);
  ok('글 속 꺾쇠는 글자로 보인다(태그로 바뀌지 않는다)',
    ctx._partInfoGuideHtml({ reviewGuide: '<b>굵게</b>', reviewGuideImages: [] }).includes('&lt;b&gt;굵게'));
  const h2 = ctx._partInfoGuideHtml(photoOnly);
  ok('사진만 있어도 가이드 칸이 나온다', h2.includes('📝 리뷰 가이드') && (h2.match(/<img /g) || []).length === 1, h2);
  ok('글·사진 둘 다 없으면 칸을 그리지 않는다', ctx._partInfoGuideHtml({ reviewGuide: '', reviewGuideImages: [] }) === ''
    && ctx._partInfoGuideHtml({}) === '');
  ok('옛 서버(사진 칸 없음)여도 글만 그린다',
    (ctx._partInfoGuideHtml({ reviewGuide: '사진 3장 이상' }).match(/<img /g) || []).length === 0
      && ctx._partInfoGuideHtml({ reviewGuide: '사진 3장 이상' }).includes('사진 3장 이상'));
  ok('팝업이 이 함수로 가이드를 그린다', /rows\.push\(\s*_partInfoGuideHtml\(brief\)\s*\)|_partInfoGuideHtml\(brief\)/.test(
    home.slice(home.indexOf('async function _partInfoLoadBrief'), home.indexOf('function _partInfoPaidAt'))));

  await db.pg.close();
  console.log(`\n✅ partInfoReviewGuide: ${passed}개 통과`);
})().catch(e => { console.error(e); process.exit(1); });
