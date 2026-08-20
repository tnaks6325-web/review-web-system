/**
 * campaignUnitGuideWorkOrder.test.js — 복합 작업(선택 단위별 유입가이드) **작업오더 → 발행 프리필** 회귀가드
 * 실행: node tests/campaignUnitGuideWorkOrder.test.js
 *
 * 고정하는 것(migration 134 · 4단계):
 *  A. `_woUnitGuide` — 인트라넷이 보낸 평문 `guide` 를 **공통 유입가이드와 같은 방식**으로 HTML 화하고,
 *     첨부는 **우리 프록시 주소(https)만** · 중복 제거 · **칸당 4장 상한**(서버 정화와 같은 값)
 *  B. `_woOptionRows` — 옵션 줄은 `unitKind:'option'` + 그 옵션 가이드,
 *     옵션 없는 상품 줄은 `unitKind:'product'` + 상품(base) 가이드를 **선택지 하나로** 싣는다 ·
 *     ★ 옵션 링크가 비면 **그 상품의 메인 URL 로 접는다**(공고 공통 랜딩 = 남의 상품 페이지)
 *  C. `_woUnitGuideBlock` — 상세 펼침이 선택지별 가이드를 보여주고 **몇 개 중 몇 개**인지 말한다 ·
 *     ★ 가이드가 하나도 없는 오더(지금까지의 전부)는 **빈 문자열** = 화면 종전 그대로
 *  D. 배선 — 상세 본문에 그 블록이 실제로 꽂혀 있고, 발행 프리필(`applyProductRowsFromOrder`)이
 *     `unitKind`·가이드 3필드를 **떨어뜨리지 않고 통과**시킨다
 *  E. 위생 — 소스·이 가드 파일에 리터럴 NUL 없음
 *
 * ★ 정적 grep 이 아니라 **함수를 vm 으로 꺼내 실제 실행**한다 — "가이드가 따라오는가"·
 *   "링크가 상품으로 접히는가"는 문자열 검사로는 못 본다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const NUL = String.fromCharCode(0);
const wodSrc = read('frontend/js/work-order-detail.js');
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
/** `const NAME = …;` 한 줄을 꺼낸다 */
function grabConst(src, name) {
  const m = new RegExp('^\\s*const\\s+' + name + '\\s*=[^\\n]*$', 'm').exec(src);
  assert(m, '상수 없음: ' + name);
  return m[0];
}
/** 작업오더 모듈에서 필요한 조각만 sandbox 로 꺼내 실행 준비 */
function woSandbox() {
  const sb = { console, escHtml: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(grabConst(wodSrc, '_WO_UNIT_GUIDE_IMG_MAX'), sb);
  ['_woCleanGuide', '_driveId', '_woPlainGuideToHtml', '_woUnitGuide', '_woOptionRows', '_woUnitGuideBlock']
    .forEach(n => vm.runInContext(grab(wodSrc, n), sb));
  return sb;
}
const PROXY = 'https://api.example.com/api/order/guide-image/';
const img = (id) => PROXY + id;

/* ══════════════ A. _woUnitGuide — 정규화 ══════════════ */
console.log('\n[A] _woUnitGuide — 평문→HTML · 첨부 정화');
{
  const s = woSandbox();
  const g = (src) => s._woUnitGuide(src);

  const plain = g({ guide: '쿠팡 검색창에\n"물티슈" 입력' });
  ok('평문 가이드는 HTML 로 변환된다(줄바꿈 보존)', /물티슈/.test(plain.html) && /<br|<p|<div/i.test(plain.html));
  ok('★ 글자만 있는 가이드도 보존된다 — escape 후 줄바꿈만(안내문이 사라지면 안 된다)',
    plain.html === '쿠팡 검색창에<br>&quot;물티슈&quot; 입력');

  // ★★ 사진이 섞인 평문은 **공통 유입가이드와 같은 함수**를 태워야 <img> 로 살아난다(사본 금지)
  const withImgRaw = '아래 이미지대로 검색\n' + img('m'.repeat(24));
  const withImg = g({ guide: withImgRaw });
  ok('★ 첨부가 섞인 평문 변환은 공통 유입가이드와 같은 함수를 쓴다(사본 금지)',
    withImg.html === s._woPlainGuideToHtml(withImgRaw) && /<img /.test(withImg.html));

  const htmlIn = g({ guide: '<p>이미 <b>HTML</b></p>' });
  ok('이미 HTML 이면 그대로 둔다', htmlIn.html === '<p>이미 <b>HTML</b></p>');

  ok('값이 없으면 빈 값 = 공통 가이드로 접힘',
    g({}).html === '' && g({}).images.length === 0 && g(null).html === '');
  ok('공백만 있는 가이드는 빈 값', g({ guide: '   \n ' }).html === '');

  const imgs = g({ guide_images: [img('a'.repeat(24)), img('a'.repeat(24)), img('b'.repeat(24))] });
  ok('첨부 중복은 접힌다', imgs.images.length === 2);

  const bad = g({
    guide_images: [
      'http://api.example.com/api/order/guide-image/' + 'c'.repeat(24),   // https 아님
      'https://evil.example.com/steal.png',                               // 우리 경로 아님
      'javascript:alert(1)',
      img('d'.repeat(24)),
    ],
  });
  ok('★ 우리 프록시(https) 주소만 인정한다 — 임의 호스트는 버린다',
    bad.images.length === 1 && bad.images[0] === img('d'.repeat(24)));

  const many = g({ guide_images: ['e', 'f', 'g', 'h', 'i', 'j'].map(c => img(c.repeat(24))) });
  ok('★ 칸당 4장 상한(서버 정화·모달과 같은 값)', many.images.length === 4);
  // ⚠ `const` 는 컨텍스트 객체의 프로퍼티가 되지 않는다 — 식으로 평가해 읽는다(레포 실측 함정)
  ok('상한 상수가 4로 고정돼 있다', vm.runInContext('_WO_UNIT_GUIDE_IMG_MAX', s) === 4);

  ok('별칭 키(guideImages·inflow_guide_images)도 받는다',
    g({ guideImages: [img('k'.repeat(24))] }).images.length === 1
    && g({ inflow_guide_images: [img('l'.repeat(24))] }).images.length === 1);
  ok('배열이 아닌 첨부는 조용히 무시(빈 배열)', g({ guide_images: 'oops' }).images.length === 0);
}

/* ══════════════ B. _woOptionRows — 선택 단위 + 가이드 + 링크 ══════════════ */
console.log('\n[B] _woOptionRows — 선택 단위/가이드/링크 통과');
const COMPOSITE = {
  product_options_json: JSON.stringify([
    {
      name: '상품A', url: 'https://coupang.com/A',
      base: { pay: 10000 },
      options: [
        { label: '옵션1', pay: 12000, count: 30, daily_limit: 5, guide: '옵션1 유입', guide_images: [img('1'.repeat(24))] },
        { label: '옵션2', pay: 13000, count: 20, url: 'https://coupang.com/A?opt=2', guide: '옵션2 유입' },
      ],
    },
    {
      name: '상품B', url: 'https://coupang.com/B',
      base: { pay: 9000, daily_limit: 3, guide: '상품B 유입', guide_images: [img('2'.repeat(24))] },
      options: [],
    },
  ]),
};
{
  const s = woSandbox();
  const rows = s._woOptionRows(COMPOSITE);
  ok('복합 작업의 선택지 3개가 모두 행이 된다', rows.length === 3);

  const o1 = rows[0], o2 = rows[1], pb = rows[2];
  ok('옵션 줄은 unitKind:"option"', o1.unitKind === 'option' && o2.unitKind === 'option');
  ok('★ 옵션 없는 상품 줄은 unitKind:"product" — 그 상품 자체가 선택지 하나',
    pb.unitKind === 'product' && pb.optKey === '' && pb.productName === '상품B');

  ok('옵션 가이드가 그 줄로 따라온다', /옵션1 유입/.test(o1.inflowGuideHtml) && o1.inflowGuideImages.length === 1);
  ok('★ 상품 단위 줄은 상품(base) 가이드를 쓴다',
    /상품B 유입/.test(pb.inflowGuideHtml) && pb.inflowGuideImages[0] === img('2'.repeat(24)));
  ok('가이드가 없는 옵션은 빈 값(공통 가이드로 접힘)', o2.inflowGuideImages.length === 0);

  ok('★ 옵션 링크가 비면 그 상품의 메인 URL 로 접는다(남의 상품 페이지 방지)',
    o1.optionUrl === 'https://coupang.com/A');
  ok('옵션에 링크가 있으면 그것이 이긴다', o2.optionUrl === 'https://coupang.com/A?opt=2');
  ok('상품 단위 줄의 링크 = 그 상품 메인 URL', pb.optionUrl === 'https://coupang.com/B');

  // 무회귀 — 종전 필드
  ok('종전 필드(옵션명·결제금액·정원·일건수)는 그대로',
    o1.optKey === '옵션1' && o1.payAmount === 12000 && o1.recruitTotal === 30 && o1.dailyLimit === 5);

  // 옵션 없음 서술 → 상품 단위로 떨어지고 상품 가이드를 쓴다
  // ★ 옵션 줄이 1개뿐인 오더는 `product_mode:'opt'` 명시가 있어야 옵션 작업으로 인정된다(종전 규칙)
  const noneish = s._woOptionRows({
    product_options_json: JSON.stringify([{
      name: '상품C', url: 'https://coupang.com/C', product_mode: 'opt',
      base: { pay: 8000, guide: '상품C 유입' },
      options: [{ label: '옵션 없음', pay: 8000, count: 10 }],
    }]),
  });
  ok('★ "옵션 없음"류는 상품 단위로 떨어지고 상품 가이드를 쓴다',
    noneish.length === 1 && noneish[0].unitKind === 'product' && noneish[0].optKey === ''
    && /상품C 유입/.test(noneish[0].inflowGuideHtml));

  // 종전 오더(가이드 없음) 무회귀
  const legacy = s._woOptionRows({
    product_options_json: JSON.stringify([{ name: '단일상품', base: { pay: 5000 }, options: [{ label: '레드', pay: 5000, count: 7 }, { label: '블루', pay: 5000, count: 3 }] }]),
  });
  ok('가이드 없는 종전 오더는 빈 가이드 + 종전 행 구성 유지',
    legacy.length === 2 && legacy.every(r => r.inflowGuideHtml === '' && r.inflowGuideImages.length === 0)
    && legacy[0].optKey === '레드' && legacy[1].optKey === '블루');
  ok('깨진 JSON·빈 값은 종전대로 빈 배열',
    s._woOptionRows({ product_options_json: '{oops' }).length === 0
    && s._woOptionRows({}).length === 0);
}

/* ══════════════ C. _woUnitGuideBlock — 상세 표시 ══════════════ */
console.log('\n[C] _woUnitGuideBlock — 접수 전 눈으로 확인');
{
  const s = woSandbox();
  const html = s._woUnitGuideBlock(COMPOSITE);
  ok('선택지 전용 가이드가 상세에 표시된다',
    /옵션1 유입/.test(html) && /옵션2 유입/.test(html) && /상품B 유입/.test(html));
  ok('선택지 이름이 상품·옵션으로 함께 보인다',
    html.includes('상품A · 옵션1') && html.includes('상품B'));
  ok('★ 몇 개 중 몇 개인지 말한다(일부만 온 것을 조용히 넘기지 않는다)',
    /선택지\s*3개 중 3개/.test(html));
  ok('첨부 이미지가 그려진다', (html.match(/<img /g) || []).length === 2);

  ok('★★ 가이드가 하나도 없는 오더는 빈 문자열 = 화면 종전 그대로',
    s._woUnitGuideBlock({ product_options_json: JSON.stringify([{ name: 'X', base: { pay: 1 }, options: [{ label: 'a', pay: 1 }] }]) }) === ''
    && s._woUnitGuideBlock({}) === ''
    && s._woUnitGuideBlock({ product_options_json: '{oops' }) === '');

  // 일부만 실려 온 경우 — 분모는 전체 선택지 수
  const partial = s._woUnitGuideBlock({
    product_options_json: JSON.stringify([{
      name: '상품D', base: { pay: 1 },
      options: [{ label: 'a', pay: 1, guide: '있음' }, { label: 'b', pay: 1 }],
    }]),
  });
  ok('일부만 실려 오면 그 사실이 숫자로 드러난다', /선택지\s*2개 중 1개/.test(partial));

  // 외부 문자열 escape
  const xss = s._woUnitGuideBlock({
    product_options_json: JSON.stringify([{
      name: '<img src=x onerror=alert(1)>', base: { pay: 1 },
      options: [{ label: 'a', pay: 1, guide: '유입' }],
    }]),
  });
  ok('★ 선택지 이름(외부 문자열)은 escape 된다', !/<img src=x/.test(xss) && /&lt;img src=x/.test(xss));
}

/* ══════════════ D. 배선 ══════════════ */
console.log('\n[D] 배선 — 상세 본문 · 발행 프리필');
{
  const detail = grab(wodSrc, '_woDetailHtml');
  ok('상세 본문에 선택지별 유입가이드 블록이 꽂혀 있다', /_woUnitGuideBlock\(o\)/.test(detail));

  const exportsBlock = wodSrc.slice(wodSrc.lastIndexOf('_woUnitGuide:') - 400);
  ok('모듈이 두 함수를 내보낸다(호스트 3화면 공용)',
    /_woUnitGuide:\s*_woUnitGuide/.test(exportsBlock) && /_woUnitGuideBlock:\s*_woUnitGuideBlock/.test(exportsBlock));

  // 발행 프리필이 세 필드를 떨어뜨리지 않는지 **실행**으로 확인
  const apply = grab(recruitSrc, 'applyProductRowsFromOrder');
  const mapStart = apply.indexOf('const sourceOptions');
  assert(mapStart >= 0, 'sourceOptions 매핑 없음');
  const mapEnd = apply.indexOf('}));', mapStart);
  assert(mapEnd > mapStart, 'sourceOptions 매핑 경계 없음');
  const mapExpr = apply.slice(apply.indexOf('(Array.isArray', mapStart), mapEnd + 3);
  const sb = { console, p: { options: null } };
  vm.createContext(sb);
  sb.p.options = [
    { productName: '상품A', optKey: '옵션1', unitKind: 'option', inflowGuideHtml: '<p>옵션1</p>', inflowGuideImages: [img('1'.repeat(24))], optionUrl: 'https://coupang.com/A', payAmount: 12000, recruitTotal: 30, dailyLimit: 5 },
    { productName: '상품B', optKey: '', unit_kind: 'product', inflow_guide_html: '<p>상품B</p>', inflow_guide_images: [img('2'.repeat(24))], optionUrl: 'https://coupang.com/B', payAmount: 9000 },
  ];
  const mapped = vm.runInContext('(' + mapExpr + ')', sb);
  ok('★★ 발행 프리필이 unitKind 를 통과시킨다(상품 단위가 이름 없는 옵션 줄로 무너지지 않는다)',
    mapped[0].unitKind === 'option' && mapped[1].unitKind === 'product');
  ok('★★ 발행 프리필이 선택지별 가이드를 통과시킨다(발행 단계에서 사라지지 않는다)',
    /옵션1/.test(mapped[0].inflowGuideHtml) && mapped[0].inflowGuideImages.length === 1
    && /상품B/.test(mapped[1].inflowGuideHtml) && mapped[1].inflowGuideImages.length === 1);
  ok('snake_case 별칭도 받는다(서버·인트라넷 표기 차 흡수)', mapped[1].unitKind === 'product');
  ok('모르는 unitKind 는 option 으로 접는다(종전 동작)',
    (sb.p.options = [{ optKey: 'x', unitKind: 'weird' }], vm.runInContext('(' + mapExpr + ')', sb)[0].unitKind === 'option'));
}

/* ══════════════ E. 위생 ══════════════ */
console.log('\n[E] 위생');
{
  ok('작업오더 모듈에 리터럴 NUL 없음', wodSrc.indexOf(NUL) < 0);
  ok('발행 모듈에 리터럴 NUL 없음', recruitSrc.indexOf(NUL) < 0);
  ok('이 가드 파일에도 리터럴 NUL 없음', fs.readFileSync(__filename, 'utf8').indexOf(NUL) < 0);
}

console.log('\n✅ campaignUnitGuideWorkOrder: ' + passed + '개 통과');
