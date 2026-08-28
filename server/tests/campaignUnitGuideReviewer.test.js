/**
 * campaignUnitGuideReviewer.test.js — 복합 작업(선택 단위별 유입가이드) **리뷰어 화면** 회귀가드
 * 실행: node tests/campaignUnitGuideReviewer.test.js
 *
 * 고정하는 것(migration 134 · 3단계):
 *  A. 서버 페이로드 — work-detail·관리자 미리보기의 `options` 목록에서 **선택지별 유입가이드를 덜어낸다**
 *     (리뷰어가 고르지도 않은 선택지의 안내를 통째로 실어 보내지 않는다) ·
 *     ★ `selectedOption` 은 **먼저 골라 두므로** 그 사람의 가이드는 그대로 남는다(순서 계약)
 *  B. 공개 응답(`_publicOptionView`)에는 여전히 가이드가 한 조각도 없다(홀드 게이트 앞)
 *  C. 렌더러 — 선택지 전용 가이드가 있으면 **그것만** 보여주고 그 사실을 문장으로 말한다 ·
 *     비어 있으면 **공고 공통 가이드로 접힌다**(가이드 0개 = 종전 동작 100%)
 *  D. 렌더러 — [상품 페이지 열기] 판정은 **지금 화면에 보이는 가이드**를 본다
 *     (공통 문구의 "링크유입" 이 선택지 전용 가이드를 무력화하지 못한다)
 *  E. 렌더러 — 옵션 없는 상품 단위는 "내가 참여한 **상품**" 으로 말한다(상품 접두 중복 없음)
 *  F. 목록 묶음(campaign.html `_optListItems`) — 옵션 단위만 상품명 머리를 달고,
 *     상품 단위·상품명 없는 옛 공고는 머리 없이 종전 그대로 · 순서 불변
 *  G. 위생 — 소스·이 가드 파일에 리터럴 NUL 없음
 *
 * ★ 정적 grep 이 아니라 **함수를 vm 으로 꺼내 실제 실행**한다 — "가이드가 목록에서 빠지는가"·
 *   "선택지 전용으로 치환되는가"는 문자열 검사로는 못 본다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
// ★ campaign.routes.js 에는 **의도된 NUL**(복합키 구분자)이 있어 grep 가드를 못 건다 → 읽을 때 걷어낸다
const NUL = String.fromCharCode(0);
const routeSrc = read('server/src/routes/campaign.routes.js').split(NUL).join('');
const pageSrc = read('frontend/campaign.html');
const rendererSrc = read('frontend/js/campaign-workdetail.js');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

/** 소스에서 함수 하나를 통째로 꺼낸다(중괄호 균형) */
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert(i >= 0, '함수 없음: ' + name);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('중괄호 불균형: ' + name);
}
function runFns(src, names) {
  const sandbox = { console };
  vm.createContext(sandbox);
  names.forEach(n => vm.runInContext(grab(src, n), sandbox));
  return sandbox;
}

/* ══════════════ A. 서버 페이로드 — 목록에서 가이드를 덜어낸다 ══════════════ */
console.log('\n[A] 서버 — 리뷰어 목록에서 선택지 가이드 제거');
{
  const s = runFns(routeSrc, ['_optionListForReviewer']);
  const src = [
    { optKey: '옵션A', productName: '상품A', unitKind: 'option', payAmount: 12000, remaining: 3,
      inflowGuideHtml: '<b>A 가이드</b>', inflowGuideImages: ['https://x/api/order/guide-image/aaaaaaaaaaaaaaaaaaaaaa'] },
    { optKey: '상품B', productName: '상품B', unitKind: 'product', payAmount: 9000, remaining: null,
      inflowGuideHtml: '<b>B 가이드</b>', inflowGuideImages: [] },
  ];
  const picked = src.find(o => o.optKey === '옵션A');           // ← 라우트와 같은 순서(먼저 고르고)
  const out = s._optionListForReviewer(src);

  ok('목록의 모든 선택지에서 inflowGuideHtml 제거', out.every(o => !('inflowGuideHtml' in o)));
  ok('목록의 모든 선택지에서 inflowGuideImages 제거', out.every(o => !('inflowGuideImages' in o)));
  ok('나머지 필드는 그대로 흐른다(가산적 rest 문법)',
    out[0].optKey === '옵션A' && out[0].productName === '상품A' && out[0].unitKind === 'option'
    && out[0].payAmount === 12000 && out[0].remaining === 3);
  ok('★ 원본을 파괴하지 않는다 — 먼저 고른 selectedOption 의 가이드는 살아 있다',
    picked.inflowGuideHtml === '<b>A 가이드</b>' && picked.inflowGuideImages.length === 1);
  ok('선택지 수는 그대로(줄이 사라지지 않는다)', out.length === 2);
  ok('빈 목록·null 도 안전', s._optionListForReviewer([]).length === 0 && s._optionListForReviewer(null).length === 0);
  ok('null 원소도 죽지 않는다', s._optionListForReviewer([null]).length === 1);
}

/* 순서 계약 — 고르기(find) 가 덜어내기(_optionListForReviewer) 보다 **앞**이어야 한다.
   뒤집히면 목록에서 지운 사본을 selectedOption 으로 골라 그 사람의 가이드까지 사라진다. */
{
  const wd = routeSrc.slice(routeSrc.indexOf("options = await _loadOptionViews(pool, id, st, now);"));
  const iFind = wd.indexOf('options.find(o => o.optKey === app.option_key)');
  const iTrim = wd.indexOf('_optionListForReviewer(options)');
  ok('work-detail — options.find 가 _optionListForReviewer 보다 앞', iFind >= 0 && iTrim > iFind);

  const pv = routeSrc.slice(routeSrc.indexOf('const optionsRaw = await _loadOptionViews(pool, id, st, now);'));
  const pFind = pv.indexOf('optionsRaw.find(o => o.selectable)');
  const pTrim = pv.indexOf('_optionListForReviewer(optionsRaw)');
  ok('관리자 미리보기 — 대표 옵션을 먼저 고른 뒤 덜어낸다', pFind >= 0 && pTrim > pFind);
  ok('★ 미리보기도 실제 리뷰어 응답과 같은 모양(미리보기 ≠ 실화면 금지)',
    /const options = _optionListForReviewer\(optionsRaw\)/.test(pv));
  ok('관리자 관제(admin/:id/applications)는 종전 그대로(가이드 포함 · 이 함수 미사용)',
    (routeSrc.match(/_optionListForReviewer\(/g) || []).length === 3);   // 선언 1 + 소비처 2
}

/* ══════════════ B. 공개 응답(홀드 게이트 앞)에는 가이드가 없다 ══════════════ */
console.log('\n[B] 공개 응답 — 참여 전에는 가이드 미노출');
{
  const s = runFns(routeSrc, ['_publicOptionView']);
  const v = s._publicOptionView({
    optKey: '옵션A', productName: '상품A', unitKind: 'option', remaining: 1, todayRemaining: null,
    status: 'open', selectable: true, payAmount: 12000,
    inflowGuideHtml: '<b>비밀</b>', inflowGuideImages: ['https://x/api/order/guide-image/aaaaaaaaaaaaaaaaaaaaaa'],
  });
  ok('공개 뷰에 inflowGuideHtml 없음', !('inflowGuideHtml' in v));
  ok('공개 뷰에 inflowGuideImages 없음', !('inflowGuideImages' in v));
  ok('공개 뷰에 payAmount 없음(금액은 참여 후 공개 원칙 불변)', !('payAmount' in v));
  ok('묶음 머리 재료(productName·unitKind)는 공개', v.productName === '상품A' && v.unitKind === 'option');
}

/* ══════════════ C~E. 렌더러(campaign-workdetail.js) ══════════════ */
console.log('\n[C~E] 작업내용 렌더러 — 선택지 전용 가이드');
const M = (() => {
  const store = {};
  const sandbox = {
    console,
    window: { API_BASE_URL: 'https://api.example.com' },
    document: {
      getElementById: id => store[id] || null,
      createElement: () => ({ set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
      head: { appendChild() {} },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(rendererSrc, sandbox);
  return sandbox.window.CampWorkDetail;
})();
const IMG = 'https://api.example.com/api/order/guide-image/bbbbbbbbbbbbbbbbbbbbbb';

{
  const common = { inflowGuideHtml: '<b>공통 가이드</b>' };

  const withUnit = M.cardsHtml({
    workDetail: common, inflowType: 'guide',
    selectedOption: { optKey: '옵션A', productName: '상품A', unitKind: 'option', inflowGuideHtml: '<b>옵션A 전용</b>' },
  }, { apiBase: 'https://api.example.com' });
  ok('선택지 전용 가이드가 있으면 그 가이드를 보여준다', withUnit.includes('옵션A 전용'));
  ok('★ 그때 공고 공통 가이드는 보여주지 않는다(치환)', !withUnit.includes('공통 가이드'));
  ok('★ 선택지명 반복 안내문은 붙이지 않는다',
    !withUnit.includes('cwd-note') && !withUnit.includes('선택지 전용 안내'));
  ok('선택지 카드의 이름은 그대로 보인다', withUnit.includes('옵션A'));

  const noUnit = M.cardsHtml({
    workDetail: common, inflowType: 'guide',
    selectedOption: { optKey: '옵션A', productName: '상품A', unitKind: 'option' },
  }, { apiBase: 'https://api.example.com' });
  ok('★ 선택지 가이드가 없으면 공통 가이드로 접힌다(무회귀)', noUnit.includes('공통 가이드'));
  ok('그때는 전용 안내 문장을 그리지 않는다', !noUnit.includes('선택지 전용 안내'));

  const imgOnly = M.cardsHtml({
    workDetail: common,
    selectedOption: { optKey: '상품B', unitKind: 'product', inflowGuideImages: [IMG] },
  }, { apiBase: 'https://api.example.com' });
  ok('★ 글 없이 사진만 있어도 선택지 전용으로 인정(사진이 통째로 사라지지 않는다)',
    imgOnly.includes(IMG) && !imgOnly.includes('공통 가이드') && !imgOnly.includes('선택지 전용 안내'));

  const noOpt = M.cardsHtml({ workDetail: common }, { apiBase: 'https://api.example.com' });
  ok('선택지 자체가 없는 공고는 종전 그대로', noOpt.includes('공통 가이드') && !noOpt.includes('선택지 전용 안내'));

  ok('선택지 이름은 escape 된다(XSS)',
    M.cardsHtml({
      workDetail: common,
      selectedOption: { optKey: '<img src=x onerror=alert(1)>', inflowGuideHtml: '<b>전용</b>' },
    }, {}).indexOf('<img src=x onerror=alert(1)>') < 0);
}
{
  /* D. 링크 버튼 = 지금 보이는 가이드로 판정 */
  const legacyCommon = { inflowGuideHtml: '링크유입 — 상품 페이지로 바로 들어가세요' };
  const withUnit = M.cardsHtml({
    workDetail: legacyCommon, landingUrl: 'https://c.kr/p/1',
    selectedOption: { optKey: '옵션A', inflowGuideHtml: '<b>검색어로 들어오세요</b>' },
  }, { apiBase: 'https://api.example.com' });
  ok('★ 공통 문구의 "링크유입" 이 선택지 전용 가이드를 무력화하지 못한다(버튼 숨김)',
    !withUnit.includes('data-cwd-landing'));

  const noUnit = M.cardsHtml({ workDetail: legacyCommon, landingUrl: 'https://c.kr/p/1' }, {});
  ok('선택지 가이드가 없으면 종전 레거시 판정 그대로(버튼 노출)', noUnit.includes('data-cwd-landing'));

  const linkType = M.cardsHtml({
    workDetail: {}, inflowType: 'link', landingUrl: 'https://c.kr/p/1',
    selectedOption: { optKey: '옵션A', optionUrl: 'https://c.kr/p/opt' },
  }, {});
  ok('링크유입 명시 + 선택지 링크가 있으면 그 링크로 연다',
    linkType.includes('data-cwd-landing="https://c.kr/p/opt"') && linkType.includes('선택 옵션 링크 열기'));
}
{
  /* E. 상품 단위 라벨 */
  const prod = M.cardsHtml({
    workDetail: {}, selectedOption: { optKey: '상품B', productName: '상품B', unitKind: 'product', payAmount: 9000 },
  }, {});
  ok('옵션 없는 상품 단위는 "내가 참여한 상품"', prod.includes('내가 참여한 상품'));
  ok('★ 그때 "상품 상품B" 같은 중복 접두를 붙이지 않는다', !prod.includes('상품 상품B'));
  ok('결제금액은 그대로 표기', prod.includes('9,000원'));

  const opt = M.cardsHtml({
    workDetail: {}, selectedOption: { optKey: '옵션A', productName: '상품A', unitKind: 'option', payAmount: 12000 },
  }, {});
  ok('옵션 단위는 "내가 참여한 옵션" + 어느 상품인지 함께 말한다',
    opt.includes('내가 참여한 옵션') && opt.includes('상품 상품A'));
}

/* ══════════════ F. 목록 묶음(campaign.html) ══════════════ */
console.log('\n[F] 선택지 목록 — 상품별 묶음 머리');
{
  const s = runFns(pageSrc, ['_optListItems']);
  const items = s._optListItems([
    { optKey: '옵션1', productName: '상품A', unitKind: 'option' },
    { optKey: '옵션2', productName: '상품A', unitKind: 'option' },
    { optKey: '상품B', productName: '상품B', unitKind: 'product' },
  ]);
  const shape = items.map(it => (it.header ? 'H:' + it.header : 'O:' + it.opt.optKey));
  ok('상품A 묶음 머리 1개 + 옵션 2줄, 상품B 는 머리 없이 한 줄',
    JSON.stringify(shape) === JSON.stringify(['H:상품A', 'O:옵션1', 'O:옵션2', 'O:상품B']));
  ok('★ 선택지는 하나도 빠지지 않는다', items.filter(i => i.opt).length === 3);

  const legacy = s._optListItems([{ optKey: '옵션1' }, { optKey: '옵션2' }]);
  ok('상품명 없는 옛 공고는 머리 없이 종전 화면 그대로(무회귀)',
    legacy.length === 2 && legacy.every(i => i.opt));

  const back = s._optListItems([
    { optKey: '옵션1', productName: '상품A', unitKind: 'option' },
    { optKey: '상품B', productName: '상품B', unitKind: 'product' },
    { optKey: '옵션3', productName: '상품A', unitKind: 'option' },
  ]);
  ok('★ 머리 없는 줄 뒤에는 묶음이 끊긴다(같은 상품이 다시 나오면 머리를 다시 단다)',
    back.filter(i => i.header).length === 2);

  const same = s._optListItems([
    { optKey: '옵션1', productName: '상품A', unitKind: 'option' },
    { optKey: '옵션2', productName: '상품A', unitKind: 'option' },
  ]);
  ok('연속된 같은 상품에는 머리를 두 번 달지 않는다', same.filter(i => i.header).length === 1);
}
{
  const gel = grab(pageSrc, '_optGroupEl');
  ok('★ 묶음 머리는 textContent 로만 넣는다(상품명 = 관리자 입력값)',
    /textContent\s*=/.test(gel) && !/innerHTML/.test(gel));
  const pre = grab(pageSrc, 'renderPreOptions');
  const sheet = grab(pageSrc, '_renderOptSheetList');
  ok('참여 전 목록이 묶음 규칙을 쓴다', /_optListItems\(/.test(pre) && /_optGroupEl\(/.test(pre));
  ok('선택·변경 시트도 같은 묶음 규칙을 쓴다(사본 0)', /_optListItems\(/.test(sheet) && /_optGroupEl\(/.test(sheet));
  ok('묶음 판정 함수는 한 벌뿐', (pageSrc.match(/function _optListItems\(/g) || []).length === 1);
  ok('묶음 머리 CSS(.optgrp) 존재', /\.optgrp\{/.test(pageSrc));
}

/* ══════════════ H. 같은 사진을 두 번 그리지 않는다 (2026-08-25 실사고) ══════════════ */
console.log('\n[H] 렌더러 — 안내글 HTML 과 배열에 같이 담긴 사진은 한 번만');
{
  /* 왜 있나: 선택지 유입가이드 편집 위젯(_ugCompose)은 같은 사진을 **안내글 HTML 안의 <img> 와
     배열 양쪽에** 저장한다(가산적 — 어느 한쪽이 정화에 걸려도 유실되지 않는 구조).
     그리는 쪽이 접지 않아 **1장을 넣었는데 화면에 2장**이 나왔다(사용자 신고 + 브라우저 재현).
     ★ 저장 형태는 그대로 두고 그리는 쪽이 접는다 — 이미 두 벌로 저장된 공고까지 그 자리에서 정상화된다. */
  const TOK_A = 'cccccccccccccccccccccc', TOK_B = 'dddddddddddddddddddddd';
  const U = t => 'https://api.example.com/api/order/guide-image/' + t;
  const imgs = h => (String(h).match(/<img/g) || []).length;
  const guideOf = (html) => {
    const i = html.indexOf('🧭 유입가이드');
    assert(i > 0, '유입가이드 카드 없음');
    const j = html.indexOf('<div class="cwd-box"', i);
    return html.slice(i, j > 0 ? j : html.length);
  };

  // ① 같은 사진이 양쪽에 — 한 번만 그린다(이번 사고)
  const dup = M.cardsHtml({
    workDetail: { inflowGuideHtml: '' },
    selectedOption: { optKey: '상품A', unitKind: 'product',
      inflowGuideHtml: '<p>검색어</p><img src="' + U(TOK_A) + '">', inflowGuideImages: [U(TOK_A)] },
  }, { apiBase: 'https://api.example.com' });
  ok('★★ 안내글과 배열에 같이 담긴 사진은 **한 번만** 그린다', imgs(guideOf(dup)) === 1);
  ok('★ 안내글의 글자는 그대로 남는다', /검색어/.test(dup));

  // ② 서로 다른 사진은 둘 다 그린다(접기가 과하지 않다)
  const two = M.cardsHtml({
    workDetail: { inflowGuideHtml: '' },
    selectedOption: { optKey: '상품A', unitKind: 'product',
      inflowGuideHtml: '<img src="' + U(TOK_A) + '">', inflowGuideImages: [U(TOK_B)] },
  }, { apiBase: 'https://api.example.com' });
  ok('★★ 서로 다른 사진은 둘 다 그린다(사진이 사라지지 않는다)', imgs(guideOf(two)) === 2);

  // ③ 배열에만 있는 사진(안내글에 <img> 없음) — 종전대로 그린다
  const arrOnly = M.cardsHtml({
    workDetail: { inflowGuideHtml: '' },
    selectedOption: { optKey: '상품A', unitKind: 'product',
      inflowGuideHtml: '<p>글만</p>', inflowGuideImages: [U(TOK_A)] },
  }, { apiBase: 'https://api.example.com' });
  ok('★ 배열에만 있는 사진은 그대로 그린다(무회귀)', imgs(guideOf(arrOnly)) === 1);

  // ④ 사진이 전부 접혀도 "선택지 전용 가이드" 판정은 유지된다(공통으로 되돌아가지 않는다)
  const foldAll = M.cardsHtml({
    workDetail: { inflowGuideHtml: '<b>공통 가이드</b>' },
    selectedOption: { optKey: '상품A', unitKind: 'product',
      inflowGuideHtml: '<img src="' + U(TOK_A) + '">', inflowGuideImages: [U(TOK_A)] },
  }, { apiBase: 'https://api.example.com' });
  ok('★★ 사진이 전부 접혀도 공통 가이드로 되돌아가지 않는다', !/공통 가이드/.test(guideOf(foldAll)));
  ok('★ 사진이 전부 접혀도 선택지명 반복 안내문을 만들지 않는다', !/선택지 전용 안내예요/.test(foldAll));

  // ⑤ 리뷰가이드·특이사항은 짝이 되는 HTML 이 없다 — 접기 인자 없이 종전 동작
  const plainFields = M.cardsHtml({
    workDetail: { inflowGuideHtml: '', reviewGuide: '리뷰 안내', specialNotes: '특이사항',
                  reviewGuideImages: [U(TOK_A)], specialNotesImages: [U(TOK_B)] },
  }, { apiBase: 'https://api.example.com' });
  ok('★ 리뷰가이드 사진은 종전대로 그려진다(무회귀)',
    imgs(plainFields.slice(plainFields.indexOf('📝 리뷰 가이드'))) >= 1);
  ok('★ 특이사항 사진도 종전대로', imgs(plainFields.slice(plainFields.indexOf('📌 특이사항'))) >= 1);

  // ⑥ 배선·계약
  ok('★ imageListHtml 이 접기 인자를 받는다',
    /function imageListHtml\(list, apiBase, alt, seenHtml\)/.test(rendererSrc));
  ok('★★ 선택지 가이드 호출만 그 인자를 넘긴다(짝이 되는 HTML 이 있는 자리)',
    /imageListHtml\(so && so\.inflowGuideImages, o\.apiBase, '유입가이드 이미지', unitGuideHtml\)/.test(rendererSrc));
  ok('★ 리뷰가이드·특이사항 호출은 종전 그대로(인자 없음)',
    /imageListHtml\(wd\.reviewGuideImages, o\.apiBase, '리뷰 가이드 이미지'\)/.test(rendererSrc)
    && /imageListHtml\(wd\.specialNotesImages, o\.apiBase, '특이사항 이미지'\)/.test(rendererSrc));
  ok('★★ 접는 판정은 extractGuideImages 와 같은 방식(토큰이 그 HTML 에 있는가)',
    /seen && seen\.indexOf\(m\[1\]\) >= 0/.test(rendererSrc));
  ok('★★ 접어도 토큰은 기록한다 — 아래 중복 판정 재료가 사라지지 않게',
    /tokens\.push\(m\[1\]\);\s*\n\s*if \(seen && seen\.indexOf/.test(rendererSrc));
}

/* ══════════════ G. 위생 ══════════════ */
console.log('\n[G] 소스 위생');
{
  ok('프론트 소스에 리터럴 NUL 없음', pageSrc.indexOf(NUL) < 0 && rendererSrc.indexOf(NUL) < 0);
  ok('이 가드 파일에도 리터럴 NUL 없음', fs.readFileSync(__filename, 'utf8').indexOf(NUL) < 0);
}

console.log('\n✅ 통과 ' + passed + '건');
