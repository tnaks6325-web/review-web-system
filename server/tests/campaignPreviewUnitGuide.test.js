/**
 * campaignPreviewUnitGuide.test.js — 관리자 미리보기에서 **고른 선택지의 유입가이드**가 살아 있는지
 * 실행: node tests/campaignPreviewUnitGuide.test.js
 *
 * 왜 있나(2026-08-25 실측 신고 — 「업소용 간장」 선택지 3종):
 *   서버가 주는 `options` 는 실제 리뷰어 응답과 같은 모양이라 선택지별 유입가이드가 **덜어져 있다**
 *   (고르지도 않은 선택지의 안내를 리뷰어에게 통째로 보내지 않는 규칙 — campaignUnitGuideReviewer 가 고정).
 *   그런데 미리보기 화면이 옵션을 고를 때 그 목록에서 선택지를 **다시 찾아** selectedOption 으로 삼아,
 *   고르는 순간 가이드 없는 껍데기가 되어 "등록된 유입가이드가 없어요" 가 떴다.
 *   미리보기는 항상 옵션을 고르고 들어가는 흐름이라 **선택지 전 건**이 그렇게 보였다.
 *   ★ 실제 리뷰어 경로는 참여·옵션변경 뒤 서버(work-detail)를 다시 물어보므로 무관했다.
 *
 * 고정하는 것:
 *  A. 서버 — 미리보기 응답에만 `optionGuides` 재료를 싣는다(가산 필드) ·
 *     목록(`options`)의 모양은 **불변**(리뷰어 응답과 같은 모양) · 리뷰어 work-detail 에는 안 싣는다
 *  B. 프론트 — 재료 확보는 `_detail = j` **앞**(시뮬레이션이 selectedOption 을 덮기 전)
 *  C. 프론트 — 가상 참여·가상 옵션변경이 **한 함수**(`_pvPickOption`)를 쓴다(사본 금지) ·
 *     그 함수는 **서버를 부르지 않는다**(미리보기 = 서버 상태 무변경)
 *  D. `_pvPickOption` **실제 실행** — 고른 선택지의 가이드가 붙는다 · 재료가 없으면 "모른다"로 돌려준다
 *     (없는 것으로 꾸미지 않는다) · 옵션 미지정·미발견도 죽지 않는다
 *  E. 모달 오른쪽 미리보기 — 첫 **살아있는** 선택지의 가이드를 넘긴다(사용자 확정 2026-08-25) ·
 *     저장과 **같은 조립 함수**(`_ugCompose`) · 가이드가 비면 null(= 공통 가이드 = 종전 동작)
 *  F. 위생 — 소스·이 가드 파일에 리터럴 NUL 없음
 *
 * ★ 정적 grep 이 아니라 **함수를 vm 으로 꺼내 실제 실행**한다 — "고른 선택지에 가이드가 붙는가" 는
 *   문자열 검사로 볼 수 없다(이번 사고가 정확히 그 자리였다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const NUL = String.fromCharCode(0);
const routeSrc = read('server/src/routes/campaign.routes.js').split(NUL).join('');
const pageSrc = read('frontend/campaign.html');
const recruitSrc = read('frontend/js/index-recruit.js');

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

/* ══════════════ A. 서버 — 미리보기 전용 재료 ══════════════ */
console.log('\n[A] 서버 — 미리보기 응답에만 선택지 가이드 재료');
{
  const i = routeSrc.indexOf("const optionsRaw = await _loadOptionViews(pool, id, st, now);");
  ok('미리보기 블록을 찾는다', i > 0);
  const pv = routeSrc.slice(i, i + 4000);

  ok('★ optionGuides 를 만든다', /const optionGuides = \{\}/.test(pv));
  ok('★★ 재료는 **가이드가 살아 있는** optionsRaw 에서 만든다(덜어낸 options 아님)',
    /for \(const o of optionsRaw\)[\s\S]{0,240}optionGuides\[o\.optKey\]/.test(pv));
  ok('가이드 두 칸을 모두 싣는다',
    /inflowGuideHtml: o\.inflowGuideHtml \|\| ''/.test(pv) && /inflowGuideImages: Array\.isArray\(o\.inflowGuideImages\)/.test(pv));
  ok('★ 응답에 실린다(가산 필드)', /selectedOption: sample,\s*\n\s*optionGuides,/.test(pv));
  ok('★★ 목록의 모양은 불변 — 여전히 _optionListForReviewer 를 거친다',
    /const options = _optionListForReviewer\(optionsRaw\)/.test(pv));

  // ★ 리뷰어 work-detail 에는 싣지 않는다 — 그 경로는 서버가 고른 selectedOption 이 원본이라 필요 없고,
  //   고르지도 않은 선택지의 안내를 리뷰어에게 보내지 않는다는 규칙(134)을 깨면 안 된다.
  const wdI = routeSrc.indexOf('options,               // [{ optKey, payAmount');
  ok('work-detail 응답 블록을 찾는다', wdI > 0);
  const wd = routeSrc.slice(wdI - 1200, wdI + 1200);
  ok('★★ 리뷰어 work-detail 응답에는 optionGuides 가 없다(데이터 최소화 유지)',
    !/optionGuides/.test(wd));
  ok('★ optionGuides 는 소스 전체에서 미리보기 한 곳에서만 만들어진다',
    (routeSrc.match(/const optionGuides = \{\}/g) || []).length === 1);
}

/* ══════════════ B·C. 프론트 배선 ══════════════ */
console.log('\n[B·C] 프론트 — 재료 확보 시점과 단일 출처');
{
  const iSeed = pageSrc.indexOf('if(!j.optionGuides && j.selectedOption && j.selectedOption.optKey)');
  const iAssign = pageSrc.indexOf('    _detail = j;\n    if(j.serverNow) CampCards.setServerNow(j.serverNow);');
  ok('구버전 백엔드 폴백 시드가 있다', iSeed > 0);
  ok('★★ 시드는 `_detail = j` **앞** — 시뮬레이션이 selectedOption 을 덮기 전에 떠 둔다',
    iAssign > 0 && iSeed < iAssign);

  ok('★ 재료 해석 함수 _pvPickOption 이 있다', /function _pvPickOption\(optionKey\)\{/.test(pageSrc));
  ok('★★ 사본 금지 — 가상 참여가 그 함수를 쓴다',
    /function _pvSimulateApply\(optionKey\)\{[\s\S]{0,500}?const picked = _pvPickOption\(optionKey\);/.test(pageSrc));
  ok('★★ 사본 금지 — 가상 옵션변경도 같은 함수를 쓴다',
    /function _pvSimulateChangeOption\(newKey\)\{[\s\S]{0,400}?const picked = _pvPickOption\(newKey\);/.test(pageSrc));
  ok('★ 목록에서 직접 고르는 옛 경로가 남아 있지 않다(그 자리가 이번 사고였다)',
    !/const selectedOption = optionKey \? \(options\.find/.test(pageSrc)
    && !/const selectedOption = \(_detail\.options \|\| \[\]\)\.find/.test(pageSrc));

  const body = grab(pageSrc, '_pvPickOption');
  ok('★★ _pvPickOption 은 서버를 부르지 않는다(미리보기 = 서버 상태 무변경)',
    !/\bfetch\(|\bapi\(|_pvGet\(|\/apply|\/change-option/.test(body));

  ok('★ 재료가 없을 때 화면이 사실대로 말한다(조용히 "없음" 으로 꾸미지 않는다)',
    /_PV_GUIDE_UNKNOWN/.test(pageSrc) && /불러오지 못했어요/.test(pageSrc));
  ok('★ 두 시뮬 함수 모두 그 고지를 쓴다',
    (pageSrc.match(/picked\.guideKnown\s*\n?\s*\?/g) || []).length === 2);
}

/* ══════════════ D. _pvPickOption 실제 실행 ══════════════ */
console.log('\n[D] _pvPickOption 실행 — 고른 선택지에 가이드가 붙는가');
{
  const GA = '<p>A 전용 가이드</p>', GB = '<p>B 전용 가이드</p>';
  const IMG = 'https://x.test/api/order/guide-image/aaaaaaaaaaaaaaaaaaaaaa';
  // 서버가 실제로 주는 모양: 목록은 가이드 제거본, selectedOption 은 원본, optionGuides 는 재료
  const options = [
    { optKey: 'A', productName: 'A', unitKind: 'product', payAmount: 18000, status: 'open', selectable: true },
    { optKey: 'B', productName: 'B', unitKind: 'product', payAmount: 17400, status: 'open', selectable: true },
  ];
  const mk = (guides) => {
    const sandbox = {
      console,
      _detail: { options, selectedOption: Object.assign({}, options[0], { inflowGuideHtml: GA, inflowGuideImages: [IMG] }),
                 optionGuides: guides },
      _camp: null,
    };
    vm.createContext(sandbox);
    vm.runInContext(grab(pageSrc, '_pvPickOption'), sandbox);
    return sandbox;
  };
  const guides = { A: { inflowGuideHtml: GA, inflowGuideImages: [IMG] }, B: { inflowGuideHtml: GB, inflowGuideImages: [] } };

  const s = mk(guides);
  const b = s._pvPickOption('B');
  ok('★★ 다른 선택지를 골라도 **그 선택지의** 가이드가 붙는다(이번 사고의 핵심)',
    b.guideKnown === true && b.opt.inflowGuideHtml === GB);
  ok('고른 선택지의 다른 값(금액 등)은 목록 값 그대로', b.opt.payAmount === 17400 && b.opt.optKey === 'B');

  const a = s._pvPickOption('A');
  ok('첫 선택지도 사진 배열까지 함께 붙는다',
    a.opt.inflowGuideHtml === GA && a.opt.inflowGuideImages.length === 1);

  ok('★ 옵션 미지정이면 서버가 고른 선택지를 그대로 쓴다', s._pvPickOption(null).opt.optKey === 'A');
  ok('★ 목록에 없는 키는 죽지 않고 null(호출부가 마감 판정으로 접는다)',
    s._pvPickOption('없는키').opt === null);

  // ★ 재료를 못 받은 경우(구버전 백엔드) — 조용히 "가이드 없음" 으로 만들지 않는다
  const s2 = mk(undefined);
  const r2 = s2._pvPickOption('B');
  ok('★★ 재료가 없으면 guideKnown:false 로 **모른다**고 돌려준다', r2.guideKnown === false);
  ok('★★ 그때 가이드 칸을 빈 값으로 덮어쓰지 않는다(없는 것으로 꾸미지 않는다)',
    !('inflowGuideHtml' in r2.opt));

  // ★ 목록이 비어도(옵션 없는 공고) 죽지 않는다 = 종전 동작
  const s3 = (() => {
    const sb = { console, _detail: { options: [], selectedOption: null, optionGuides: {} }, _camp: null };
    vm.createContext(sb); vm.runInContext(grab(pageSrc, '_pvPickOption'), sb); return sb;
  })();
  ok('★ 옵션 없는 공고 — null 을 돌려주고 예외 없음(공통 가이드 경로 유지)',
    s3._pvPickOption(null).opt === null && s3._pvPickOption('x').opt === null);
}

/* ══════════════ E. 모달 오른쪽 미리보기 ══════════════ */
console.log('\n[E] 모달 미리보기 — 첫 살아있는 선택지의 가이드');
{
  ok('★ _renderPreview 가 selectedOption 으로 넘긴다',
    /selectedOption: _rfFirstUnitGuide\(\),/.test(recruitSrc));
  ok('★★ 저장과 **같은 조립 함수**(_ugCompose)를 쓴다 — 미리보기와 저장본이 갈라질 수 없다',
    /function _rfFirstUnitGuide\(\)[\s\S]{0,900}?_ugCompose\(r, key\)/.test(recruitSrc));

  const sandbox = {
    console,
    document: {
      querySelectorAll: () => sandbox.__rows,
    },
    _prodMode: () => 'opt',
    _rfGroupUnit: (r) => r.__unit,
    _rfRowProductName: (r) => r.__prod,
    _ugCompose: (r) => r.__guide,
    __rows: [],
  };
  vm.createContext(sandbox);
  vm.runInContext(grab(recruitSrc, '_rfFirstUnitGuide'), sandbox);

  const row = (o) => ({
    dataset: { ig: o.key || 'u0', status: o.status || 'active' },
    __unit: o.unit || 'product', __prod: o.prod || '',
    __guide: { html: o.html || '', images: o.images || [] },
    querySelector: () => ({ value: o.optName || '' }),
  });

  sandbox.__rows = [row({ prod: '상품A', html: '<p>A</p>' }), row({ prod: '상품B', html: '<p>B</p>' })];
  let out = sandbox._rfFirstUnitGuide();
  ok('★ 첫 선택지의 가이드를 돌려준다', out && out.optKey === '상품A' && out.inflowGuideHtml === '<p>A</p>');

  sandbox.__rows = [row({ prod: '상품A', html: '' }), row({ prod: '상품B', html: '<p>B</p>' })];
  out = sandbox._rfFirstUnitGuide();
  ok('★ 가이드가 빈 선택지는 건너뛴다(첫 줄이 비었다고 포기하지 않는다)', out && out.optKey === '상품B');

  sandbox.__rows = [row({ prod: '상품A', html: '<p>A</p>', status: 'closed' }), row({ prod: '상품B', html: '<p>B</p>' })];
  out = sandbox._rfFirstUnitGuide();
  ok('★★ 마감 선택지는 대표로 쓰지 않는다(리뷰어가 고를 수 없다)', out && out.optKey === '상품B');

  sandbox.__rows = [row({ prod: '상품A', images: ['https://x/api/order/guide-image/aaaaaaaaaaaaaaaaaaaaaa'] })];
  out = sandbox._rfFirstUnitGuide();
  ok('★ 글 없이 사진만 있어도 선택지 가이드로 인정', out && out.inflowGuideImages.length === 1);

  sandbox.__rows = [row({ prod: '상품A', html: '' })];
  ok('★★ 선택지 가이드가 하나도 없으면 null — 공고 공통 가이드가 그려진다(무회귀)',
    sandbox._rfFirstUnitGuide() === null);

  sandbox.__rows = [row({ unit: 'option', optName: '옵션1', prod: '상품A', html: '<p>O</p>' })];
  out = sandbox._rfFirstUnitGuide();
  ok('★ 옵션 단위는 옵션명이 키(상품명이 아니다)', out && out.optKey === '옵션1' && out.productName === '상품A');

  sandbox.__rows = [row({ prod: '', html: '<p>A</p>' })];
  ok('★ 이름을 못 정하면 대표로 쓰지 않는다(키 없는 선택지 금지)', sandbox._rfFirstUnitGuide() === null);

  sandbox._prodMode = () => 'none';
  sandbox.__rows = [row({ prod: '상품A', html: '<p>A</p>' })];
  ok("★★ '옵션 없는 작업' 모드에서는 선택지 가이드를 쓰지 않는다(숨은 칸 잔여값 차단)",
    sandbox._rfFirstUnitGuide() === null);
}

/* ══════════════ F. 위생 ══════════════ */
console.log('\n[F] 위생');
{
  ok('campaign.html 에 리터럴 NUL 없음', !pageSrc.includes(NUL));
  ok('index-recruit.js 에 리터럴 NUL 없음', !recruitSrc.includes(NUL));
  ok('이 가드 파일에 리터럴 NUL 없음', !fs.readFileSync(__filename, 'utf8').includes(NUL));
}

console.log('\n✅ campaignPreviewUnitGuide — ' + passed + ' 케이스 통과');
