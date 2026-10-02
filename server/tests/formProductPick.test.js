/**
 * formProductPick.test.js — 구매양식 링크 화면 「구매한 상품」 선택 (2026-10-02 사용자 확정 B안)
 *
 * 사고: 구매양식 링크로 들어온 리뷰어는 상품을 고를 곳이 없어, 상품이 여럿인 작업에서 표에 미리 적힌
 *   상품이 그대로 남았다(고양이사료 51건 중 37건이 실제 산 상품과 달랐다).
 * 고정:
 *   [1] 선택지 = 공고 상품 2종↑이면 그것만, 아니면 공고 ∪ 작업표 · 무시트만 · 2종 미만이면 []
 *   [2] 제출: 홀드가 이긴다 · 화면 값은 선택지에 있는 것만 · 캡처와 다르면 로그(막지 않음)
 *   [3] 화면: 1번 자동 선택 없음 · 참여형/배치/네이버+쿠팡 제외 · onclick 은 인덱스만 · 고르기 전 제출 막힘
 * 실행: node tests/formProductPick.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../src/services/sheetlessOrder.service');

let failed = 0, n = 0;
const ok = (msg, cond) => { n++; if (cond) console.log('  ✓ ' + msg); else { failed++; console.log('  ✗ ' + msg); } };

function stubDb({ sheetless = true, camp = [], wt = [], fail = false } = {}) {
  return {
    async query(sql) {
      const q = String(sql).replace(/\s+/g, ' ');
      if (fail) throw new Error('boom');
      if (/FROM tab_configs WHERE sheet_id = \$1 AND tab_name = \$2 LIMIT 1/.test(q)) return { rows: [{ s: sheetless }] };
      if (/FROM recruit_campaigns rc/.test(q)) return { rows: camp.map(l => ({ l })) };
      if (/FROM campaign_participants/.test(q)) return { rows: wt.map(l => ({ l })) };
      return { rows: [] };
    },
  };
}

(async () => {
  console.log('[1] 선택지');
  ok('시트 기반 작업은 []', (await S.listProductChoices(stubDb({ sheetless: false, camp: ['A', 'B'] }), 's', 't')).length === 0);
  ok('★ 공고 상품 2종↑이면 공고 것만(마감한 옛 모델을 안 내민다)',
    JSON.stringify(await S.listProductChoices(stubDb({ camp: ['신1', '신2'], wt: ['옛1', '신1'] }), 's', 't')) === '["신1","신2"]');
  ok('공고 1종이면 작업표 값으로 채운다(공백 차이는 한 번만)',
    JSON.stringify(await S.listProductChoices(stubDb({ camp: ['A 1'], wt: ['A1', 'B', 'C'] }), 's', 't')) === '["A 1","B","C"]');
  ok('2종 미만이면 []', (await S.listProductChoices(stubDb({ camp: [], wt: ['A'] }), 's', 't')).length === 0);
  ok('조회 실패는 [] (fail-open)', (await S.listProductChoices(stubDb({ fail: true }), 's', 't')).length === 0);
  ok('좌표가 없으면 []', (await S.listProductChoices(stubDb({ camp: ['A', 'B'] }), '', 't')).length === 0);

  console.log('[2] 서버 배선');
  const sub = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'submit.routes.js'), 'utf8');
  ok('★ 홀드 값이 이긴다 — 화면 값은 홀드 상품이 없을 때만',
    /if \(!\(holdCtx && holdCtx\.productName\) && \(b\.selectedProduct \|\| b\.productCaptureName\)\)/.test(sub)
    && /selectedProduct: \(holdCtx && holdCtx\.productName\) \|\| formPickedProduct \|\| ''/.test(sub));
  ok('★ 화면 값은 선택지로 짝지은 값만(지어낸 값 차단)',
    /formPickedProduct = so\.resolveProductLabel\(String\(b\.selectedProduct/.test(sub) && /so\.listProductChoices\(pool, orderScope\.sheetId, orderScope\.tabName\)/.test(sub));
  ok('캡처와 다르면 막지 않고 로그만(warn)',
    /formPickedProduct && formCaptureProduct && formPickedProduct !== formCaptureProduct/.test(sub)
    && /eventType: 'product_capture_mismatch', severity: 'warn'/.test(sub) && /\.catch\(e => logger\.warn/.test(sub));
  const ev = require('../src/services/reviewerEventLog.service');
  const d = ev.describeEvent({ eventType: 'product_capture_mismatch', context: { picked: 'A', capture: 'B' } });
  ok('로그 문구가 고른 것·캡처 것을 말한다', /A/.test(d.problem) && /B/.test(d.problem) && /작업보드/.test(d.action));
  const dg = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'diag.routes.js'), 'utf8');
  ok('캡처 판독이 그 작업 상품으로 짝지은 productLabel 을 돌려준다(fail-open)',
    /res\.json\(\{ \.\.\.result, \.\.\.proof, productLabel \}\)/.test(dg) && /catch \(_\) \{ productLabel = ''; \}/.test(dg));
  const tc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'tabconfig.routes.js'), 'utf8');
  ok('선택지 창구는 같은 함수를 쓴다', /router\.get\('\/product-choices'[\s\S]{0,700}listProductChoices\(pool, sheetId, tabName\)/.test(tc));

  console.log('[3] 화면');
  const fe = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'search-app.js'), 'utf8');
  const blk = fe.slice(fe.indexOf('const _OFP = {'), fe.indexOf('function addOrderCard() {'));
  ok('참여형·배치·네이버+쿠팡·미리보기 제외', /return _OFP\.products\.length >= 2 && !_EMBED_CTX && !_BATCH && !window\._ncMode && !_PREVIEW_MODE;/.test(blk));
  ok('고르기 전엔 제출이 막힌다', /if \(_ofpActive\(\)\) \{\s*const _ofpMiss = _orderCardIds\.filter\(c => !_OFP\.pick\[c\]\)/.test(fe));
  ok('판독 요청에 작업 좌표를 싣는다', /action: "extractOrderImage", imageBase64: base64, mimeType,\s*sheetId: _ofpCtx\.sheetId/.test(fe));
  ok('주문에 고른 상품·캡처 상품명을 싣는다', /selectedProduct:    o\.selectedProduct/.test(fe) && /productCaptureName: o\.productCaptureName/.test(fe));
  ok('★ onclick 에 상품명을 넣지 않는다(인덱스·위임)', !/onclick=/.test(blk) && /data-ofp-i="' \+ i \+ '"/.test(blk));

  // vm 실행 — 1번 자동 선택 없음 · 판독 결과로 미리 고름 · 사람이 고른 값을 판독이 덮지 않음
  const dom = {};
  const el = (id) => dom[id] || (dom[id] = { id, hidden: true, innerHTML: '', scrollIntoView() {} });
  const sb = {
    console, URLSearchParams, String, Number, Array, JSON,
    _EMBED_CTX: null, _BATCH: null, _PREVIEW_MODE: false, window: { _ncMode: false },
    _orderCardIds: ['c1'], API_BASE_URL: '',
    _safeText: (t) => String(t).replace(/[&<>]/g, ''),
    document: { getElementById: el, addEventListener() {} },
  };
  vm.createContext(sb);
  vm.runInContext(blk + '; this._OFP = _OFP; this.R = _ofpRender; this.X = _ofpOnExtracted; this.C = _ofpOnCaptureCleared;', sb);
  sb._OFP.products = ['시니어', '어덜트', '키튼'];
  sb.R('c1');
  ok('★ 처음엔 아무것도 골라져 있지 않다', !sb._OFP.pick.c1 && !/aria-checked="true"/.test(el('c1_prodPick').innerHTML) && el('c1_prodPick').hidden === false);
  sb.X('c1', '키튼', '베타그로 키튼 1kg');
  ok('판독이 짝지은 상품을 미리 골라 두고 접어 보인다', sb._OFP.pick.c1 === '키튼' && /캡처와 일치/.test(el('c1_prodPick').innerHTML) && /다른 상품을 샀어요/.test(el('c1_prodPick').innerHTML));
  sb._OFP.pick.c1 = '시니어'; sb.R('c1');
  ok('캡처와 다르게 고르면 안내가 뜬다', /담당자에게 표시/.test(el('c1_prodPick').innerHTML));
  sb.X('c1', '키튼', 'x');
  ok('★ 사람이 고른 값을 판독이 덮지 않는다', sb._OFP.pick.c1 === '시니어');
  sb.C('c1');
  ok('캡처를 지워도 사람이 고른 값은 남는다', sb._OFP.pick.c1 === '시니어');
  sb._OFP.pick = {}; sb.X('c1', '', 'x');
  ok('못 찾으면 고르라는 안내 + 아무것도 안 고름', !sb._OFP.pick.c1 && /찾지 못했어요/.test(el('c1_prodPick').innerHTML));
  sb._OFP.products = ['A']; sb.R('c1');
  ok('상품 1종이면 칸을 숨긴다', el('c1_prodPick').hidden === true);

  console.log(`\n${failed ? '❌' : '✅'} formProductPick: ${n - failed}/${n}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
